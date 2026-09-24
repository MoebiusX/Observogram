# Store Plan — an embedded SQL store for users, orgs, services and environments

*Ratified 2026-09-24. Backlog item 0 of [HANDOVER.md](HANDOVER.md): the
maintainer's steer, verbatim — "making it feel like a product is the most
important. Maybe it's time to deploy our own in-mem SQL DB for user,
services and environment management." This plan puts that store under the
studio, moves [VALUE_BACKLOG.md](VALUE_BACKLOG.md) items 10 and 12 to the
front, and reverses two earlier calls on purpose: item 10's "file-first,
not a database + user accounts" and
[PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md) Stage 1's "plain file
chosen over sqlite … `node:sqlite` would raise the engine floor to Node
22". Both were right for a single-user scanner; neither survives "sign in,
land in your org, see your services". This is a plan, not a spec: it
names the shape, the seams, the slices and the risks. §9 records the
decisions as ratified.*

## 0 · Status quo — what exists, and what is missing

| Concern | Today | Where | Gap |
|---|---|---|---|
| Users | `users.json`, scrypt-hashed; the file existing arms stand-alone sign-in; seeded `admin`/`admin` on first boot | `server/auth.mjs` (`readUsers`, `writeUsers`, `maybeSeedDefaultAdmin`), `tools/user-admin.mjs` | no roles on the record; no revocation — a removed user keeps a valid HMAC cookie until it expires (8 h default) |
| Orgs | `orgs.json` `{ id: { name, members: { sub: role } } }`; the file existing arms tenancy | `server/tenancy.mjs`, `tools/org-admin.mjs` | roles recorded, **not enforced** (Stage 3 never shipped); members are file-edited only |
| Tenancy | `workspaceRoot()` answers `<workspace>/orgs/<id>/` inside an AsyncLocalStorage org context | `server/tenancy.mjs` `orgWorkspaceRoot()`, the org middleware in `server/index.mjs` | — the seam is right and stays |
| Services | not a record: derived client-side from registered packs' `bindings.service` / `services` | `studio/app.mjs` `serviceCatalogue()` | no owners, tier, environments or history of their own; a service without a pack does not exist |
| Environments | not a record: a pack's environment list (`listEnvironments(c)`) or a gen-site partition | `server/index.mjs` | no endpoint, no MCP binding, nothing to check a service *through* |
| MCP endpoints | a URL typed per session; write tokens pass through per request | studio, `server/routes/deploy.mjs` | nothing org-level to pick from |
| Pack registry | `packs/<id>.pack.yaml` + advisory `packs/index.json` | `server/workspace.mjs` | the index is a hand-rolled table with a merge-on-flush and an incident behind it (2026-06-11) |
| Deploy audit | append-only `deploys.jsonl` (deploy + verify lines) | `server/workspace.mjs`; **also read by** `tools/lib/journey.mjs` `readDeployLog()` | only deploys are audited; user, org and settings changes leave no trace |
| Identity seams | `requireAuth` middleware stamps `req.observogramActor` / `req.observogramSub`; bearer token = service account | `server/index.mjs` | — stays |

Every new record type today costs another file format, another atomic-write
dance and another ad-hoc loader. The store removes that tax for *records*;
it deliberately does not touch *artefacts* (§3).

## 1 · The shape

- **Engine:** Node's built-in `node:sqlite` (`DatabaseSync`). Zero new
  dependencies — the `openid-client` exception in `server/auth.mjs` stays
  the only one.
- **One database per deployment** at `<base workspace>/observogram.db`
  (`OBSERVOGRAM_DB` relocates it; `OBSERVOGRAM_DB=:memory:` for tests and
  demos). Every org-scoped row carries `org_id`; users span orgs, so one
  file is the honest model.
- **Pragmas at open:** `journal_mode=WAL`, `synchronous=NORMAL`,
  `foreign_keys=ON`, `busy_timeout=5000`. Every write is a short
  `BEGIN IMMEDIATE` transaction — the CLI admin commands and the server can
  write concurrently without a lock dance of our own.
- **One module:** `server/store/` — `db.mjs` (open, pragmas, the scoped
  warning filter below), `migrations.mjs` (ordered steps keyed by
  `PRAGMA user_version`, each idempotent, each in one transaction),
  and one repository per table (`users.mjs`, `orgs.mjs`, `services.mjs`,
  …). Repositories are the only code that writes SQL; routes and `auth.mjs`
  call repositories. It lives under `server/`, not `tools/lib/`, so the
  "tools/lib stays free of `node:*`, served to the browser" rule is
  untouched.
- **Org scoping is the repository's job, not the caller's.** Org-scoped
  repositories read `currentOrg()` from the existing AsyncLocalStorage
  context and put `org_id = ?` into every statement; a call outside an org
  context throws. No route grows an `orgId` parameter.
- **Node floor ≥ 22.13** (`node:sqlite` unflagged). `package.json`
  `engines`, both jobs in `.github/workflows/ci.yml` and
  `refresh-live-pack.yml` move from 20 to 22 (the last one does not touch
  the store; it moves so CI runs one Node); the Dockerfile is already on
  `node:22-alpine`. The README says so, and says why.
- **The experimental warning:** `node:sqlite` still prints an
  `ExperimentalWarning` on 22.x. `db.mjs` filters exactly that warning
  (type `ExperimentalWarning`, message mentioning SQLite) around its
  dynamic `import('node:sqlite')` and restores `process.emitWarning`
  immediately after — scoped, so every other warning still prints, and it
  works for the `packc` shebang, where a CLI flag cannot be passed.
  Verified on 22.22.

## 2 · Schema v1

```text
schema_meta     key PK, value                      -- workspace_layout, imports done, created_at
users           id PK, kind (local|oidc), login UNIQUE,   -- login: username, or <issuer>#<sub>
                email, name, password JSON NULL, must_change, seeded_default,
                disabled, session_epoch, created_at, last_login_at
orgs            id PK (slug), name, created_at
memberships     org_id FK, user_id FK, role (viewer|operator|admin), created_at;  PK(org_id, user_id)
services        id PK, org_id FK, slug, name, owners JSON, tier, description,
                created_at, updated_at;  UNIQUE(org_id, slug)
environments    id PK, service_id FK, name, bindings JSON, endpoints JSON,
                mcp_endpoint_id FK NULL, created_at, updated_at;  UNIQUE(service_id, name)
mcp_endpoints   id PK, org_id FK, name, url, read_token_env NULL, created_at;  UNIQUE(org_id, name)
packs           org_id, id (content hash), label, source, created_at, last_used_at;  PK(org_id, id)
pack_services   org_id, pack_id, service_id, role (primary|member);  PK(org_id, pack_id, service_id)
audit           seq PK AUTOINCREMENT, at, org_id NULL, actor, action, target_kind, target_id, detail JSON
```

- **`password`** keeps today's record verbatim (`{ algo: 'scrypt', N, r, p,
  salt, hash }`) — `verifyPassword` does not change.
- **`session_epoch`** is new and is what the database buys first:
  the signed cookie carries the epoch it was issued under, the session
  middleware compares it to the row (one indexed read), and disabling a
  user, a password change or "sign out everywhere" bumps it. A cookie
  without an epoch (issued before the upgrade) reads as epoch 0, which is
  the column's default — the upgrade signs nobody out.
- **`mcp_endpoints.read_token_env`** is the *name* of an env var, mirroring
  the journeys' `mcpAuthEnv`. **No secret is ever stored** — write tokens
  stay per-request pass-through, the v1 rule PRODUCTIZATION_PLAN Stage 3
  already kept.
- **`pack_services`** exists because a pack is not always one service: the
  live aggregate packs the studio already special-cases
  (`isLiveAggregatePack`) carry many.
- **`tier`** on a service is its criticality. It sets the default rubric a
  service's packs are graded against; a pack's own `minTier` stays the
  Build seed. A mismatch is shown, never blocked (decision 6).
- **`audit` is append-only in the schema:** `BEFORE UPDATE` and
  `BEFORE DELETE` triggers `RAISE(ABORT)`. Every mutating repository call
  writes its audit row in the same transaction as the change.

## 3 · What stays a file

Records move; artefacts stay where `cat`, `git diff` and a volume backup can
see them (decision 3):

| Stays a file | Why |
|---|---|
| `packs/<id>.pack.yaml` | the artefact itself; content-addressed; the pack id *is* the filename. Only `packs/index.json` becomes the `packs` table |
| `snapshots/<deployId>/` | rollback payloads, opaque JSON per captured artefact |
| `journeys/*.journey.yaml` | designed to be committable into a service repo (VALUE_BACKLOG item 11) |
| `runs/<journey>/*.json` | written by `packc journey run`, which runs as a k8s CronJob on the shared workspace PVC — possibly `ReadWriteMany`, where SQLite's WAL is not safe. The runner must never need the database |
| `deploys.jsonl` | **the file of record for deploys stays.** `tools/lib/journey.mjs` `readDeployLog()` reads it to window deploys into a run's chain history — the server-agnostic engine, on the same CronJob. The server additionally writes one `audit` row per deploy and per verify (`action: 'deploy'`, `target_id: deployId`), so `GET /api/audit` answers "who did what" across every record type without a second source of truth for deploy detail |
| `session-secret` | a secret, `0600`, outside anything a support dump of the database would carry |

Backups stay "the workspace directory". A hot copy of the database is
`VACUUM INTO` (`packc store backup <path>`), which is safe while the server
runs.

**Where the database file may live:** local disk, or a `ReadWriteOnce`
volume. Not NFS / SMB / a `ReadWriteMany` class — WAL needs shared memory
between processes on one host. `deploy/k8s/README.md` says so next to the
existing PVC note, and the studio `Deployment` stays `replicas: 1` (it is
today). Multi-instance studio is out of scope; the repository layer is the
seam a server database would attach to if it ever becomes a requirement.

## 4 · Getting there from today's files

**Import, once, on first open** (a migration step, recorded in
`schema_meta`):

1. `users.json` → `users` (kind `local`; the password record, `mustChange`
   and `seededDefault` carried verbatim).
2. `orgs.json` → `orgs` + `memberships`. Roles are imported as written;
   `member` (the implicit role `orgsForUser` returns today) maps to
   `operator`, so nobody loses the powers they have now when roles start to
   be enforced.
3. No `orgs.json` → one org, `default`, and every imported user becomes its
   `admin` — which is what every signed-in user effectively is today.
4. `packs/index.json` (per org root) → `packs`; the existing reconcile
   rule carries over unchanged: a row without a pack file is dropped only on
   positive evidence the file is gone, an orphan file is adopted.
5. Services and environments are **backfilled** from the registered packs:
   each pack's primary `bindings.service` (and the aggregate's `services`)
   becomes a `services` row + `pack_services` link; its `listEnvironments`
   entries become `environments` rows. Nobody lands on an empty home.

The original files are left on disk untouched (decision 4). After the import
the database is authoritative; `users.json` and `orgs.json` are no longer
read. `packc store export <dir>` writes `users.json`, `orgs.json` and
`packs/index.json` back in their current formats — the exit, and the
downgrade path.

**Arming changes meaning.** Today a *file existing* arms stand-alone
sign-in (`users.json`) and tenancy (`orgs.json`). After:

- **Stand-alone sign-in** is armed when the `users` table has a local user.
  `maybeSeedDefaultAdmin()` seeds into the table under the same back-off
  rules (OIDC, a bearer token, `OBSERVOGRAM_AUTH=off`, an existing user);
  the loopback-only rule for the default credential is unchanged.
  `OBSERVOGRAM_USERS_FILE` keeps working as an *import source* only.
- **Tenancy** (decision 5): the store always has at least the `default`
  org. `schema_meta.workspace_layout` is `flat` or `per-org`. It is
  `per-org` from the start for a deployment that imported an `orgs.json`
  (its data already lives under `orgs/<id>/`), and flips `flat → per-org`
  — once, never back — when an admin creates the second org. The flip runs
  the existing idempotent `migrateFlatWorkspace()` behind a write barrier:
  new mutating `/api` requests get `503` + `Retry-After` while in-flight
  ones drain, then the per-entry renames run, then the layout is recorded.
  With one org the studio hides the org switcher and the
  `X-Observogram-Org` header stays optional, as it is today.

**OIDC users** are created on first sign-in (`kind: oidc`,
`login: <issuer>#<sub>`) with **no membership**; they land on "ask an admin
to add you" — today's 403 message, as a page. The first admin of an OIDC
deployment is named explicitly: `OBSERVOGRAM_BOOTSTRAP_ADMIN=<email|sub>`
grants `admin` on `default` at that user's first sign-in, or
`npm run orgs -- add-member`. First-to-sign-in-wins is deliberately *not*
a rule: on an exposed deployment it hands the org to whoever in the IdP
arrives first.

## 5 · Roles — enforced, and before any settings UI

A members or environments API without roles is the privilege-escalation hole
`server/tenancy.mjs`'s own header warns about. So PRODUCTIZATION_PLAN
Stage 3 ships **before** the settings surface:

| Role | May |
|---|---|
| `viewer` | every `GET` in the org |
| `operator` | + crawl, draft, register, instantiate, compile, deploy, retrofeed, journeys, services and environments CRUD |
| `admin` | + members, roles, MCP endpoints, org settings, second-org creation |

- The check is one middleware after the org middleware, driven by an
  explicit route table (method + path pattern → minimum role). A route
  missing from the table is refused in tests, so a new route cannot ship
  unclassified.
- **Bearer token** (the service account): `operator` on the org it targets
  — exactly what it can do today. Admin routes need an admin session; the
  CLI (`npm run users`, `npm run orgs`, which write the database directly)
  is the break-glass admin path.
- **Open posture** (`OBSERVOGRAM_AUTH=off`): actor `local`, every route
  allowed — loopback dev, unchanged.

## 6 · The studio — what "feels like a product" means here

1. **Sign in → your org → Services.** The home is the `services` table:
   one card per service with its tier, owners, environments and the latest
   verdict per environment. *Check an existing service* picks from it;
   *Build a new pack* ends by writing (or linking) the service row. The
   header's SERVICE selector reads the same table.
2. **A service page** is the axis: its environments as tabs, each with the
   MCP endpoint it is checked through; Discover · Diagnose · Remediate ·
   Build open from here, pre-bound to the service and environment instead of
   to a pack file.
3. **Settings** (admin; read-only for others): Users & roles, Environments,
   MCP endpoints, Audit. Every editor is a pop-up over one record — the
   idiom of the Build SLI editor — with a status line naming what changed.
4. The org switcher appears only when there is a second org.

Views follow [UI_CONVENTIONS.md](UI_CONVENTIONS.md): they import
`studio/host.mjs`, loaders / pure models / renderers are separate exports,
models are tested under `node:test`, and the AA scan covers the new
stylesheet rules.

## 7 · Slices — each its own PR against `develop`, each green alone

| # | Slice | Ships |
|---|---|---|
| 1 | **Store foundation** | `server/store/` (open, pragmas, warning filter, migrations, schema v1, repositories with no callers yet), Node floor ≥ 22.13 in `engines` + CI + README, `packc store backup`. No behaviour change. First commit: `tools/cli.mjs` stops calling `process.exit()` straight after a large `process.stdout.write` — on 22.22 under `node --test`, `packc journey run --all --json` loses its tail to the pipe (146 KB in, `JSON.parse` fails in `tools/test-journey.mjs` on clean `develop`); the CI move to 22 must not land on that. |
| 2 | **Identity on the store** | users, orgs, memberships; the import (§4 steps 1–3); `auth.mjs`, `tenancy.mjs`, `user-admin`, `org-admin` over repositories; `session_epoch` revocation; OIDC just-in-time users + `OBSERVOGRAM_BOOTSTRAP_ADMIN`; `packc store export`. |
| 3 | **Roles enforced** | the route table + middleware; the authz matrix suite. |
| 4 | **Services, environments, MCP endpoints** | tables, role-gated CRUD API, the backfill (§4 step 5), `packs` replaces `packs/index.json` (§4 step 4), `pack_services` links on register. |
| 5 | **Audit** | an audit row on every mutation, deploy and verify rows alongside `deploys.jsonl`, `GET /api/audit` (filter by actor, kind, target, time). |
| 6a | **Studio: services as the axis** | the Services home, the service page, Check / Build wired to the table, the org switcher. |
| 6b | **Studio: settings** | Users & roles, Environments, MCP endpoints, Audit. |

Each slice goes through the implementer → two parallel reviewers (one drives
it as a user and tries to break it; one checks conventions, accessibility,
tests, commit hygiene, docs against code) → a fixer that reproduces each
finding first, and is driven live — a browser or the API, with the exact
labels and numbers — before it is reported. Roughly two weeks end to end.

## 8 · Quality gates

| Gate | Mechanism |
|---|---|
| Migrations | every migration applied from `user_version` 0 and from each prior version on a fixture database; re-running is a no-op |
| Import | fixture workspaces (flat; `orgs.json`-armed; `.tomograph/` legacy; a corrupt `index.json`) imported and asserted row by row; `store export` round-trips byte-compatible JSON |
| Tenancy isolation | two orgs in one `:memory:` store: every repository and every `/api` route proves org B reads and writes nothing of org A's; a repository call outside an org context throws |
| AuthZ matrix | table-driven: every mutating route × {anonymous, viewer, operator, admin, bearer} → expected status; an unclassified route fails the suite |
| Revocation | a disabled user's and a changed password's old cookies are refused on the next request; pre-upgrade cookies stay valid |
| Audit | UPDATE / DELETE on `audit` abort; every mutating route leaves exactly one row with the right actor |
| Concurrency | the CLI writes while the server holds the database; no `SQLITE_BUSY` surfaces |
| Layout flip | creating the second org under concurrent mutations loses no write and leaves nothing in the flat root |
| Local-mode regression | `OBSERVOGRAM_AUTH=off` and a fresh first boot (`admin`/`admin`) behave exactly as today — asserted by the existing suites, unchanged |
| Journey engine | `packc journey run` and the Neuron read no database; the CronJob path runs with the database file absent |

## 9 · Decisions (ratified 2026-09-24)

1. **Node floor ≥ 22.13** everywhere, CI included; Node 18 and 20 are
   dropped.
2. **One database per deployment**, `org_id` on every org-scoped row — not
   one file per org.
3. **Artefacts stay files** (pack YAML, snapshots, journeys, runs,
   `deploys.jsonl`); records move to the store (§3).
4. **The imported JSON files are left in place**; the database is
   authoritative after import; `packc store export` is the exit.
5. **Tenancy arming:** always a `default` org; the switcher appears with the
   second org; the workspace layout flips to per-org, once, when the second
   org is created.
6. **Service tier vs pack tier:** the service's criticality sets the default
   rubric; the pack's `minTier` stays the seed; a mismatch is shown, not
   blocked.
7. **Branches:** `codex/<topic>` from `origin/develop`, per
   [BRANCHING.md](BRANCHING.md).

Refined while writing this plan, against the chat version the decisions were
ratified on:

- `deploys.jsonl` stays the deploy file of record (the journey engine reads
  it); the database gets an audit row per deploy instead of a `deploys`
  table.
- The first OIDC admin is named (`OBSERVOGRAM_BOOTSTRAP_ADMIN` or the CLI),
  not "the first user to sign in".

## 10 · Risks

- **`node:sqlite` is experimental on 22.x.** The API surface used is small
  (`DatabaseSync`, `prepare`, `exec`, `run` / `get` / `all`) and stable
  across 22–24; the repository layer is the only caller, so an API change is
  one module's problem.
- **The layout flip** is the one live data move. It reuses the boot
  migration's per-entry, idempotent renames; the write barrier is the new
  part and has its own gate (§8).
- **Behaviour change for armed deployments:** roles recorded in `orgs.json`
  start to be enforced in slice 3. `member` maps to `operator`, so no one
  loses today's powers; the CHANGELOG says so.
- **Scope creep.** Invitations, email flows, billing, per-service ACLs inside
  an org and a multi-instance studio are out of scope. The plan ends at
  "sign in, land in your org, see your services and their environments, act
  within your role — and every change is on the record".
