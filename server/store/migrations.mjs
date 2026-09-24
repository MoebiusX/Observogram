// server/store/migrations.mjs — ordered schema steps keyed by PRAGMA
// user_version (docs/STORE_PLAN.md §1 "Migrations", §2 "Schema v1").
//
// Step N takes the store from user_version N-1 to N. For each pending step
// the runner:
//   1. runs PRAGMA foreign_keys=OFF outside any transaction (inside one it
//      is a silent no-op), so a table rebuild can drop a parent;
//   2. enters tx() and re-reads user_version, skipping the step if another
//      opener applied it while this one waited on BEGIN IMMEDIATE;
//   3. runs the step;
//   4. runs PRAGMA foreign_key_check and throws (rolling back) on any row;
//   5. sets user_version, and the tx() commits;
//   6. in a finally, turns foreign_keys back ON — also after a failure.
//
// A table rebuild creates X_new, copies, drops X, then renames X_new. It
// never renames the old table away first: that rewrites the children's
// foreign keys to the old name.

import { randomUUID } from 'node:crypto';
import { execScript, pragma, prepare, tx } from './db.mjs';

// ---------- schema v1 ----------
//
// STRICT tables: a column declared INTEGER refuses 'true', so the 0/1
// boolean rule holds in the file as well as in the binder. JSON columns
// are TEXT. The audit table has no foreign key on purpose: a cascade or
// SET NULL from a parent would be an UPDATE/DELETE the append-only
// triggers refuse, and the audit outlives what it names.

const SCHEMA_V1 = `
CREATE TABLE schema_meta (
  key   TEXT PRIMARY KEY NOT NULL,
  value TEXT
) STRICT;

CREATE TABLE users (
  id             INTEGER PRIMARY KEY,
  kind           TEXT    NOT NULL CHECK (kind IN ('local', 'oidc')),
  login          TEXT    NOT NULL UNIQUE,
  issuer         TEXT,
  sub            TEXT,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0 CHECK (email_verified IN (0, 1)),
  name           TEXT,
  password       TEXT,
  must_change    INTEGER NOT NULL DEFAULT 0 CHECK (must_change IN (0, 1)),
  seeded_default INTEGER NOT NULL DEFAULT 0 CHECK (seeded_default IN (0, 1)),
  is_owner       INTEGER NOT NULL DEFAULT 0 CHECK (is_owner IN (0, 1)),
  disabled       INTEGER NOT NULL DEFAULT 0 CHECK (disabled IN (0, 1)),
  session_epoch  INTEGER NOT NULL DEFAULT 1 CHECK (session_epoch >= 0),
  created_at     TEXT    NOT NULL,
  last_login_at  TEXT,
  CHECK (kind = 'local' OR (issuer IS NOT NULL AND sub IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX users_issuer_sub ON users (issuer, sub) WHERE issuer IS NOT NULL;

CREATE TABLE orgs (
  id         TEXT PRIMARY KEY NOT NULL,
  name       TEXT NOT NULL,
  root       TEXT NOT NULL UNIQUE CHECK (root = '.' OR root = 'orgs/' || id),
  removed_at TEXT,
  created_at TEXT NOT NULL
) STRICT;

CREATE TABLE memberships (
  org_id     TEXT    NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role       TEXT    NOT NULL CHECK (role IN ('viewer', 'operator', 'admin')),
  created_at TEXT    NOT NULL,
  PRIMARY KEY (org_id, user_id)
) STRICT;
CREATE INDEX memberships_user ON memberships (user_id);

CREATE TABLE services (
  id          INTEGER PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  slug        TEXT NOT NULL,
  name        TEXT NOT NULL,
  owners      TEXT NOT NULL DEFAULT '[]',
  tier        TEXT,
  description TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  UNIQUE (org_id, slug),
  UNIQUE (id, org_id)
) STRICT;

CREATE TABLE mcp_endpoints (
  id             INTEGER PRIMARY KEY,
  org_id         TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  url            TEXT NOT NULL,
  read_token_env TEXT,
  created_at     TEXT NOT NULL,
  UNIQUE (org_id, name)
) STRICT;

CREATE TABLE environments (
  id              INTEGER PRIMARY KEY,
  service_id      INTEGER NOT NULL REFERENCES services (id) ON DELETE CASCADE,
  name            TEXT    NOT NULL,
  tier            TEXT,
  bindings        TEXT    NOT NULL DEFAULT '{}',
  endpoints       TEXT    NOT NULL DEFAULT '{}',
  mcp_endpoint_id INTEGER REFERENCES mcp_endpoints (id) ON DELETE SET NULL,
  created_at      TEXT    NOT NULL,
  updated_at      TEXT    NOT NULL,
  UNIQUE (service_id, name)
) STRICT;
CREATE INDEX environments_mcp_endpoint ON environments (mcp_endpoint_id);

CREATE TABLE packs (
  org_id       TEXT NOT NULL REFERENCES orgs (id) ON DELETE CASCADE,
  id           TEXT NOT NULL,
  label        TEXT,
  source       TEXT,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  PRIMARY KEY (org_id, id)
) STRICT;

CREATE TABLE pack_services (
  org_id     TEXT    NOT NULL,
  pack_id    TEXT    NOT NULL,
  service_id INTEGER NOT NULL,
  role       TEXT    NOT NULL CHECK (role IN ('primary', 'member')),
  PRIMARY KEY (org_id, pack_id, service_id),
  FOREIGN KEY (org_id, pack_id) REFERENCES packs (org_id, id) ON DELETE CASCADE,
  FOREIGN KEY (service_id, org_id) REFERENCES services (id, org_id) ON DELETE CASCADE
) STRICT;
CREATE INDEX pack_services_service ON pack_services (service_id, org_id);
CREATE UNIQUE INDEX pack_services_one_primary ON pack_services (org_id, pack_id) WHERE role = 'primary';

CREATE TABLE audit (
  seq         INTEGER PRIMARY KEY AUTOINCREMENT CHECK (seq > 0),
  at          TEXT NOT NULL,
  org_id      TEXT,
  actor       TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_kind TEXT,
  target_id   TEXT,
  detail      TEXT
) STRICT;
CREATE INDEX audit_org_seq ON audit (org_id, seq);

-- Append-only. The third trigger refuses any explicit seq that is not
-- above the newest one: that covers an existing seq, so REPLACE and
-- INSERT OR REPLACE cannot rewrite a row on any connection, with or
-- without recursive_triggers, and a backdated seq (0, negative, a gap
-- below the newest) cannot slip in as older history. An auto-assigned
-- seq reads as -1 in a BEFORE INSERT trigger, so plain inserts pass; the
-- trigger cannot tell an explicit -1 from that, so CHECK (seq > 0)
-- refuses it (and any seq <= 0).
CREATE TRIGGER audit_no_update BEFORE UPDATE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_delete BEFORE DELETE ON audit
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
CREATE TRIGGER audit_no_overwrite BEFORE INSERT ON audit
WHEN NEW.seq <> -1 AND NEW.seq <= (SELECT coalesce(max(seq), 0) FROM audit)
BEGIN SELECT RAISE(ABORT, 'audit is append-only'); END;
`;

export const STEPS = [
  {
    version: 1,
    name: 'schema v1',
    up(db) {
      execScript(db, SCHEMA_V1);
      prepare(db, 'INSERT INTO schema_meta (key, value) VALUES (?, ?)').run('store_id', randomUUID());
    },
  },
];

export const SCHEMA_VERSION = STEPS.length;

export function userVersion(db) {
  return Number(pragma(db, 'user_version')[0]?.user_version ?? 0);
}

// Applies every pending step in `steps` (injectable for tests). Refuses a
// store written by a newer build rather than running on a schema it does
// not know.
export function runMigrations(db, steps = STEPS) {
  steps.forEach((s, i) => {
    if (s.version !== i + 1) throw new Error(`observogram store: migration steps must be numbered 1..n in order (step ${i} has version ${s.version})`);
  });
  const known = steps.length;
  const found = userVersion(db);
  if (found > known) {
    throw new Error(`observogram store: the database is at schema v${found}, but this build knows up to v${known} — run the build that wrote it, or restore a backup`);
  }
  const applied = [];
  for (const step of steps) {
    if (userVersion(db) >= step.version) continue;
    pragma(db, 'foreign_keys=OFF');
    try {
      const ran = tx(db, () => {
        if (userVersion(db) >= step.version) return false;
        step.up(db);
        const broken = pragma(db, 'foreign_key_check');
        if (broken.length) {
          throw new Error(`observogram store: migration v${step.version} (${step.name}) leaves ${broken.length} foreign-key violation(s), first in ${broken[0].table}; rolled back`);
        }
        pragma(db, `user_version=${step.version}`);
        return true;
      });
      if (ran) applied.push(step.version);
    } finally {
      pragma(db, 'foreign_keys=ON');
    }
  }
  return { from: found, to: userVersion(db), applied };
}
