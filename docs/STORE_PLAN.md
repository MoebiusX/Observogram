# Store Plan — an embedded SQL store for users, orgs, services and environments

*Backlog item 0 of [HANDOVER.md](HANDOVER.md). The maintainer's steer of
2026-09-24, verbatim: "making it feel like a product is the most important.
Maybe it's time to deploy our own in-mem SQL DB for user, services and
environment management." This plan puts that store under the studio and
moves [VALUE_BACKLOG.md](VALUE_BACKLOG.md) items 10 and 12 to the front. It
reverses three earlier calls on purpose: item 10's "stay file-first … not a
database + user accounts",
[PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md) Stage 1's "plain file
chosen over sqlite … `node:sqlite` would raise the engine floor to Node
22", and that plan's §6 decision 3, "file-first org registry". All three
were right for a single-user scanner, and none of them survives "sign in,
land in your org, see your services".*

*Status: the seven decisions in §9 were ratified on 2026-09-24. §9b lists
the refinements made while checking this plan against the code. Each one
closes a hole that review found, and they await confirmation on this PR.
This is a plan, not a spec: it names the shape, the seams, the slices, the
gates and the risks.*

## 0 · Status quo — what exists and what is missing

| Concern | Today | Where | Gap |
|---|---|---|---|
| Users | `users.json`, scrypt-hashed. Its existence arms stand-alone sign-in. `admin`/`admin` is seeded on first boot | `server/auth.mjs` (`readUsers`, `writeUsers`, `maybeSeedDefaultAdmin`), `tools/user-admin.mjs` | no roles. No revocation: the session is a stateless HMAC cookie, so a removed user stays signed in until it expires (8 h default). OIDC users are recorded nowhere; the callback signs `claims.sub` straight into the cookie |
| Orgs | `orgs.json` `{ id: { name, members: { sub: role } } }`. Its existence arms tenancy. Members are keyed by username (stand-alone) or bare IdP sub (OIDC) | `server/tenancy.mjs`, `tools/org-admin.mjs` | roles are recorded but **not enforced**: Stage 3 never shipped. `--role` accepts any string, and `member` is its default |
| Tenancy | `orgWorkspaceRoot()` answers `<workspace>/orgs/<id>/` inside an AsyncLocalStorage org context. That context exists only for `/api` requests, and only while `orgs.json` exists | `server/tenancy.mjs`, the org middleware in `server/index.mjs` | the seam is right and stays. The context has to exist in every posture (§1) |
| Services | not a record. Derived from registered packs: `serviceMetadata()` (primary = `bindings.service` or `metadata.name`, plus namespace and service annotations) on the server, and `serviceCatalogue()` / `isLiveAggregatePack()` in the studio | `server/index.mjs`, `studio/app.mjs` | no owners, tier or environments of their own. A service without a pack does not exist |
| Environments | not a record. A pack's environment list (`listEnvironments`) or a gen-site partition | `tools/lib/adapter.mjs` | no endpoint and no MCP binding, so nothing to check a service *through* |
| MCP endpoints | a URL typed per session. Write tokens pass through per request | studio, `server/routes/deploy.mjs` | nothing at org level to pick from |
| Pack registry | `packs/<id>.pack.yaml` (ids `uploaded-<slug>-<hash8>`) plus an advisory `packs/index.json` | `server/workspace.mjs` | the index is a hand-rolled table with a merge-on-flush and an incident behind it (2026-06-11) |
| Deploy audit | append-only `deploys.jsonl` (deploy and verify lines) | `server/workspace.mjs`; **also read by** `tools/lib/journey.mjs` `readDeployLog()` | only deploys are audited. User, org and settings changes leave no trace |
| Identity seams | the auth gate (the first `app.use` in `server/index.mjs`; the plans call it `requireAuth`) stamps `req.observogramActor` and `req.observogramSub`. The bearer token is the service account | `server/index.mjs` | stays |

Every new record type today costs another file format, another atomic-write
routine and another ad-hoc loader. The store removes that cost for
*records*. It deliberately does not touch *artefacts* (§3).

## 1 · The shape

- **Engine.** Node's built-in `node:sqlite` (`DatabaseSync`). No new
  dependencies: the `openid-client` exception in `server/auth.mjs` stays
  the only one.
- **One database per deployment.** It lives at `<base workspace>/observogram.db`;
  `OBSERVOGRAM_DB` relocates it, and on k8s it gets its own volume (§3).
  Every org-scoped row carries `org_id`. Users span orgs, so one file is
  the honest model.
- **One module, `server/store/`.**
  - `db.mjs`: open, pragmas, the `tx()` helper, the warning filter below.
  - `migrations.mjs`: ordered steps keyed by `PRAGMA user_version`.
  - One repository per table (`users.mjs`, `orgs.mjs`, `services.mjs`, …).

  Repositories are the only code that writes SQL; routes and `auth.mjs`
  call them. The module lives under `server/`, so the rule that `tools/lib`
  stays free of `node:*` (it is served to the browser) is untouched.
- **Handles.** A handle is cached per resolved path, and env is re-read on
  each call, as `server/workspace.mjs` does, so a suite can re-point
  `OBSERVOGRAM_WORKSPACE` between boots. `closeStore()` is exported for
  tests.
- **Pragmas.**
  - Set on every open: `busy_timeout=5000` first, then `foreign_keys=ON`
    (already node:sqlite's default), `recursive_triggers=ON` (§2 audit)
    and `synchronous=NORMAL`.
  - `journal_mode=WAL` is persistent, so it is set once, when the file is
    created. `db.mjs` asserts it only for file databases: `:memory:`
    answers `memory`.
- **Writes.** Every write goes through `tx(fn)`, which opens
  `BEGIN IMMEDIATE`. A deferred `BEGIN` that reads and then writes gets
  `SQLITE_BUSY_SNAPSHOT` at once, whatever the timeout. A guard test fails
  on a `BEGIN` anywhere outside `db.mjs`. Statements with `RETURNING` are
  read with `.get()` / `.all()`, never `run().changes`.
- **Org scoping belongs to the repository, not the caller.** Org-scoped
  repositories read `currentOrg()` from the existing AsyncLocalStorage
  context and put `org_id = ?` into every statement. A call outside a
  context throws. To make that safe:
  - **every** `/api` request now runs in an org context, in every posture
    (§5);
  - code that runs outside a request (boot rehydrate `loadWorkspacePacks()`,
    the debounced index flush, the import and backfill) enters
    `runWithOrg(id)` explicitly for each org, with the id captured when the
    timer was scheduled.

  No route grows an `orgId` parameter.
- **Node floor ≥ 22.16.** `node:sqlite` is unflagged from 22.13, but 22.16
  fixes a use-after-free in `StatementSync` (#56840) and the `run()`
  statement reset (#57350), and adds the `timeout` option and
  `isTransaction`. The following move to it:
  - `package.json` `engines`, from `>=18`;
  - the three CI jobs (two in `ci.yml`, one in `refresh-live-pack.yml`),
    from 20;
  - the regenerated `package-lock.json` root `engines`;
  - `.github/copilot-instructions.md`'s "Node 18+".

  CI runs `npm test` twice: once pinned to the floor (`22.16.0`), once on
  the latest 22. `node-version: '22'` alone would never exercise the
  floor. The Dockerfile's floating `node:22-alpine` is fine. The README
  gains a Node line and says why.
- **The experimental warning.** `node:sqlite` prints an
  `ExperimentalWarning` on 22.x through
  `process.emitWarning(msg, 'ExperimentalWarning')`, once per process.
  - `db.mjs` loads the built-in once, through a cached dynamic `import()`,
    with `process.emitWarning` wrapped to drop exactly that warning. The
    original is restored in a `finally` that runs after the import
    settles.
  - This works for the `packc` shebang, where no CLI flag can be passed
    (verified on 22.22).
  - It fails if anything else imports `node:sqlite` statically: the
    built-in then loads before any module body runs. So `db.mjs` is the
    only file that names `node:sqlite`. A guard test in the style of
    `tools/test-contract-guard.mjs` fails the build on any other file that
    does, tests included. Tests get their handles from `db.mjs`.

## 2 · Schema v1

```text
schema_meta     key PK, value      -- default_org, identity_armed, import_done, import_report
users           id PK, kind (local|oidc), login UNIQUE,     -- username, or <issuer>#<sub>
                issuer NULL, sub NULL, email, email_verified,
                name, password JSON NULL, must_change, seeded_default,
                is_owner, disabled, session_epoch DEFAULT 0, created_at, last_login_at
orgs            id PK (slug), name, root,                   -- '.' or 'orgs/<id>', fixed at creation
                default_member_role NULL, created_at
memberships     org_id FK, user_id FK, role (viewer|operator|admin), created_at;  PK(org_id, user_id)
services        id PK, org_id FK, slug, name, owners JSON, tier NULL, description,
                created_at, updated_at;  UNIQUE(org_id, slug)
environments    id PK, service_id FK, name, tier NULL, bindings JSON, endpoints JSON,
                mcp_endpoint_id FK NULL, created_at, updated_at;  UNIQUE(service_id, name)
mcp_endpoints   id PK, org_id FK, name, url, read_token_env NULL, created_at;  UNIQUE(org_id, name)
packs           org_id, id, label, source, created_at, last_used_at;  PK(org_id, id)
pack_services   org_id, pack_id, service_id, role (primary|member);  PK(org_id, pack_id, service_id)
audit           seq PK AUTOINCREMENT, at, org_id NULL, actor, action, target_kind, target_id, detail JSON
```

- **`password`** keeps today's record verbatim (`{ algo: 'scrypt', N, r, p,
  salt, hash }`), so `verifyPassword` does not change.
- **`is_owner`** is the deployment-level role. It is separate from the org
  roles (§5), because users, orgs and the deployment audit are not owned by
  any one org.
- **`session_epoch`** is the first thing the database buys.
  - Every signed cookie carries the epoch it was issued under. That
    includes the `observogram_pwflow` cookie of the forced password change.
  - The session middleware compares the cookie's epoch to the row (one
    indexed read) and refuses a disabled row.
  - Disabling a user, changing a password or "sign out everywhere" bumps
    the epoch.
  - A cookie without an epoch (issued before the upgrade) reads as 0, the
    column default. For an OIDC cookie with no row yet, the middleware
    creates the row at epoch 0 under the membership rules of §4.
  - Result: the upgrade signs nobody out.
  - Removing a user disables the row instead of deleting it: the audit
    references it, and a disabled row is what revokes.
- **`orgs.root`** is where the org's files live, relative to the base
  workspace. It is fixed when the org is created, so data never moves at
  runtime (§4).
- **`orgs.default_member_role`** is the role a just-in-time user joins with.
  It is `NULL` (no auto-join) unless set. §4 says when the import sets it.
- **`mcp_endpoints.read_token_env`** is the *name* of an env var, mirroring
  the journeys' `packB.mcp.authEnv`. **No secret is ever stored**: write
  tokens stay per-request pass-through.
- **`pack_services`** exists because a pack is not always one service. The
  live aggregate packs carry many.
- **Tier is criticality, not `minTier`.** `minTier` belongs to library SLIs
  and conformance clauses; the pack itself has none.
  - A pack's criticality is `metadata.bindings.criticality`, and each
    environment may override it through `spec.environments.<env>.criticality`.
  - `services.tier` and `environments.tier` mirror those two levels. An
    environment's effective tier picks the default rubric.
  - When the pack disagrees with the record, the mismatch is shown, never
    blocked (decision 6).
- **`audit` is append-only in the schema.**
  - `BEFORE UPDATE` and `BEFORE DELETE` triggers `RAISE(ABORT)`.
  - `recursive_triggers=ON` makes `REPLACE` / `INSERT OR REPLACE` fire the
    delete trigger. Without it, both overwrite rows (verified on
    22.22 / SQLite 3.51.2).
  - These triggers guard against application bugs, not against someone
    who holds the file.
  - v1 has no retention. Growth is bounded by the rate of human and CI
    actions. A later retention policy is an explicit migration that
    archives with `VACUUM INTO` and then prunes.

## 3 · What stays a file

Records move. Artefacts stay where `cat`, `git diff` and a volume backup can
see them (decision 3):

| Stays a file | Why |
|---|---|
| `packs/<id>.pack.yaml` | the artefact itself; the pack id *is* the filename. Only `packs/index.json` becomes the `packs` table |
| `snapshots/<deployId>/` | rollback payloads: opaque JSON per captured artefact |
| `journeys/*.journey.yaml` | designed to be committable into a service repo (VALUE_BACKLOG item 11) |
| `runs/<journey>/*.json` | written by `packc journey run`, which runs as a k8s CronJob on the shared workspace PVC. The journey runner never opens the database |
| `deploys.jsonl` | **stays the file of record for deploys.** `tools/lib/journey.mjs` `readDeployLog()` reads it to place deploys in a run's chain history: the server-agnostic engine, on the same CronJob. The server also writes one audit row per deploy and verify (§5) |
| `session-secret` | a secret, `0600`, kept outside anything a support dump of the database would carry |

**Backups.** A copy of the workspace directory taken while the server runs
is not a safe backup of a WAL database: it can capture `observogram.db`
without its `-wal`. The hot backup is `packc store backup <path>`, which runs
`VACUUM INTO`.
- It captures committed rows while writers are active.
- It refuses an existing target.
- It writes a rollback-journal file. Restoring is copying that file into
  place with the server stopped; the first open switches it back to WAL.

This supersedes PRODUCTIZATION_PLAN Stage 4's "the workspace directory (it
already IS the state)". A directory copy is still right with the server
stopped.

**Where the database file may live.** On local disk or a `ReadWriteOnce`
volume. Never on NFS, SMB or a `ReadWriteMany` class: WAL needs shared
memory between the processes on one host.

The journeys component's workspace PVC may keep its current advice
("switch to ReadWriteMany where the storage class offers it"), because the
database does not live there.
- **A dedicated volume.** Slice 1 adds a small `ReadWriteOnce` PVC to the
  **base** kustomization and mounts it on the studio. `OBSERVOGRAM_DB`
  points into it.
- **Why the base.** The base Deployment has no volume today. Its workspace
  is the container's ephemeral `/app/.observogram`, so every rollout would
  wipe users, roles and the audit, and would reset `session_epoch`, which
  revives revoked cookies.
- **`strategy: Recreate`.** The studio Deployment stays `replicas: 1` and
  gains `strategy: Recreate`. The default RollingUpdate briefly runs two
  studio processes against one database, and stalls on attach when an RWO
  volume sits on another node.
- **Scope.** A multi-instance studio is out of scope. The repository layer
  is where a server database would attach if one is ever needed.

## 4 · Getting there from today's files

**The import runs once, in the server's `start()`.** It runs with the
server's env: after `migrateFlatWorkspace()` (which still keys on
`orgs.json` one last time, so a not-yet-moved flat workspace lands in
`orgs/default/` before its index is read) and before `loadWorkspacePacks()`.
After `import_done` that migration never runs again, although `orgs.json`
stays on disk.
It is one transaction, and it records `import_done` plus an
`import_report` in `schema_meta` and one audit row.

The CLIs never import. `npm run users`, `npm run orgs` and `packc store`
refuse while legacy files exist at the resolved workspace and
`import_done` is absent, with "start the server once with its
environment". Otherwise they could import with a shell's env (no
`OBSERVOGRAM_USERS_FILE`, no `OBSERVOGRAM_OIDC_ISSUER`) and record the
import as done. On a workspace with nothing to import they initialise the
store, so "`npm run users -- add` on a fresh install" keeps working. They
print the database path they opened and refuse `:memory:`.

1. **Users.** `users.json` becomes `users` rows with kind `local`. The
   password record, `mustChange` and `seededDefault` carry over verbatim.
   `OBSERVOGRAM_USERS_FILE` is honoured as the import source.
2. **Orgs.** `orgs.json` becomes `orgs` (`root = orgs/<id>`, which is where
   their data already is) plus `memberships`.
   - **Member keys map by the identity mode in effect.**
     - With `OBSERVOGRAM_OIDC_ISSUER` set, every key becomes a kind `oidc`
       user with login `<issuer>#<sub>`. The issuer is normalised the same
       way the callback normalises `claims.iss`. This holds even if a
       `users.json` name is equal: `users.json` is ignored under OIDC today.
     - Stand-alone, keys map to local users. A key with no user is dropped
       and listed in the report. It never fails the foreign key.
   - **Roles map, never abort.**
     - `admin` / `owner` (case-insensitive) → `admin`.
     - `viewer` / `read` / `readonly` / `read-only` → `viewer`.
     - Anything else → `operator`: `member` (the default `npm run orgs --
       add-member` writes), `operator`, `editor`, typos.
     - Every inexact mapping is listed. So is every recorded `viewer`: that
       member does lose write power when slice 3 starts enforcing roles,
       and the CHANGELOG says so.
   - **The default org** is `default` if present, otherwise the first
     `orgs.json` org. This mirrors today's bearer fallback. No empty
     `default` is manufactured next to `acme`.
   - **Owners** are the `admin` members of the default org.
3. **No `orgs.json`.** One org, `default`, with `root = '.'`: the flat
   workspace stays exactly where it is. Every imported local user becomes
   an owner and its `admin`, which is what every signed-in user
   effectively is today.
   - On an **OIDC** deployment nobody is in a file. So the import sets
     `default_member_role = operator` on `default`, and every IdP user
     keeps today's access on their next request: pre-upgrade cookies
     included, because the middleware creates the row. Admin powers still
     need a named owner (below).
   - The setting changes only when an owner turns it off. A fresh OIDC
     deployment starts with it `NULL`.
4. **Pack index.** `packs/index.json` (per org root) becomes `packs` rows.
   Today's reconcile rule carries over unchanged: a row without a pack file
   is dropped only on positive evidence the file is gone, and an orphan
   file is adopted.
5. **Backfill.** Services and environments are created from the registered
   packs by **one pure helper** in `tools/lib`: today's `serviceMetadata()`
   and `isLiveAggregatePack()`, moved together. The server imports it
   statically, and the studio imports it at call time from `/lib`, so the
   backfilled set is exactly today's home.
   - The primary service is linked `primary`. An aggregate's services and
     the extra entries of `services` are linked `member`.
   - The pack's `listEnvironments` entries become `environments` rows.
   - Catalogue packs (`examples/`, `reference-packs/`) belong to the
     deployment, not to an org. They get no service rows and stay listed
     apart.

The original files are left on disk untouched (decision 4). After the
import the database is authoritative, and `users.json`, `orgs.json` and
`index.json` are no longer read.

**`packc store export <dir>`** is the exit and the downgrade path. It writes
files a pre-store build boots on with the same effective access. It is not
a byte-level round trip: the import is lossy by design (role mapping, a
dropped row).
- `users.json` holds the local users.
- `index.json` is written per org root.
- `orgs.json` is written **only** if the deployment had one or has more
  than one org. Exporting never manufactures tenancy: a pre-store build
  would treat a new `orgs.json` as arming and move the flat workspace.

**Arming changes meaning.**

- **Stand-alone sign-in** is armed once a local user has ever existed. This
  is `schema_meta.identity_armed`, and it is sticky. Removing the last user
  never disarms an exposed server: only `OBSERVOGRAM_AUTH=off` does, and
  the last owner cannot be disabled or deleted anyway.
- **`maybeSeedDefaultAdmin()`** seeds into the table, as owner plus `admin`
  of the default org. Its back-off rules carry over:
  - OIDC;
  - a bearer token;
  - `OBSERVOGRAM_AUTH=off`;
  - identity already armed;
  - an imported multi-org deployment with no identity, which is refused at
    boot anyway.

  So does the `OBSERVOGRAM_ADMIN_PASSWORD` rescue of a still-seeded
  default row. The loopback-only rule for the default credential does not
  change.
- **New local users** (`npm run users -- add`, or Settings) join the
  default org with `--role` (default `operator`) while the deployment has
  one org. With more orgs, `--org` is required. A user with no membership
  therefore never appears by accident.
- **Tenancy is always on.** There is always a default org, and every `/api`
  request resolves one (§5). The org switcher appears for a user who
  belongs to more than one org.
  - Creating an org needs an owner, and identity: the boot check "`orgs.json`
    found but no identity" becomes "more than one org and no identity".
  - The new org gets `root = orgs/<id>`, and its creator becomes its first
    `admin`.
  - **No data ever moves at runtime.** The default org stays at `.`. The
    journeys CronJob keeps its root. Nothing races a rename.
  - The only nesting is the default org's root containing `orgs/`. No
    default-org code path walks its root recursively, and the isolation
    gate asserts it.

**OIDC users** are created on first sign-in (or on first sight of a
pre-upgrade cookie): kind `oidc`, login `<issuer>#<sub>`, with the email
and `email_verified` claims recorded. They join the default org at
`default_member_role` when that is set. Otherwise they land on an "ask an
admin to add you" page: today's 403 message, turned into a page.

The first owner of an OIDC deployment is named explicitly, with
`OBSERVOGRAM_BOOTSTRAP_ADMIN=<issuer>#<sub>` or with an email that counts
only while `email_verified` is true. That user is granted owner plus
`admin` of the default org at **any** sign-in while the deployment has no
owner. `npm run orgs -- add-member` and `npm run users -- owner <login>`
do the same from the CLI. Two rules are rejected deliberately:
- **First to sign in wins.** On an exposed deployment it hands the org to
  whoever in the IdP arrives first.
- **Unverified email matching.** This is the known "nOAuth" takeover.

## 5 · Postures, roles and the audit — enforced before any settings UI

A members or environments API without roles is the privilege-escalation
hole that `server/tenancy.mjs`'s own header warns about. So PRODUCTIZATION_PLAN
Stage 3 ships **before** the settings surface.

| Posture | Org context | Who may do what |
|---|---|---|
| Open (`OBSERVOGRAM_AUTH=off`, or `OBSERVOGRAM_INSECURE_NO_AUTH=1`) | the default org | actor `local`, an owner, every route. Loopback dev, unchanged |
| Token only (`OBSERVOGRAM_API_TOKEN`, no users, no OIDC) | the default org, or the bearer's `X-Observogram-Org` | anonymous: `viewer` (reads stay open, as today); bearer: `operator`. No owner exists, so Settings is read-only with a banner naming the way in (add a user or OIDC) |
| Identity (local users or OIDC) | the requested org, else the user's first membership | per membership, as below; the bearer stays `operator` on the org it targets |

| Role | May |
|---|---|
| `viewer` | every `GET` in the org |
| `operator` | plus crawl, draft, register, instantiate, compile, deploy, retrofeed, journeys, and CRUD on services and environments. `POST /api/refresh-live` writes the deployment-global `examples/production-live.pack.yaml`, so it needs `operator` on the **default** org |
| `admin` | plus memberships in **its own org** (add an existing user by exact login or verified email, change a role, remove), MCP endpoints and org settings. An admin cannot list the deployment's users, and the org's last admin can be removed only by an owner |
| owner (`users.is_owner`) | plus users (create, disable, reset another user's password, sign them out everywhere), orgs (create and remove), the deployment audit (rows with `org_id NULL`), `default_member_role`. The last owner cannot be disabled or demoted |

- **Self-service routes.** `/auth/change-password`, its `/skip` sibling and
  "sign out my other sessions" act on the caller's own row only. In the
  route table they are classified as `self`.
- **The route table.** One middleware after the org middleware reads an
  explicit table: method plus path pattern → minimum role, and the audit
  actions the route writes. A route missing from the table fails the
  suite, so a new route cannot ship unclassified.
- **What the audit records.** The table says it per route; nothing is
  implied:
  - `POST /api/validate` and the other register paths write one
    `pack.register` row, plus one `pack.evict` or `pack.replace` row per
    pack the registry removes.
  - `DELETE /api/uploads` writes one `pack.clear` row.
  - Journey capture and run from the studio write `journey.capture` /
    `journey.run` rows. CLI runs are not audited, because the CLI never
    opens the database.
  - Updates to `last_used_at` are bookkeeping. They go through an
    audit-free `touch()`.
  - Deploy and verify write their audit row **after** the `deploys.jsonl`
    append, in their own transaction. If that insert fails, the deploy
    result stands (production was already written): the response carries
    `auditError`, and the server logs it loudly.

## 6 · The studio — what "feels like a product" means here

1. **Sign in, land in your org, see Services.** The home is the `services`
   table: one card per service with its tier, owners, environments, and
   the latest verdict per environment. *Check an existing service* picks
   from it. *Build a new pack* ends by writing or linking the service row.
   The header's SERVICE selector reads the same table. Catalogue packs stay
   listed apart.
2. **A service page is the axis.** Its environments are tabs, each with the
   MCP endpoint it is checked through. Discover · Diagnose · Remediate ·
   Build open from here, bound to the service and environment instead of
   to a pack file.
3. **Settings.**
   - Admin: members, environments, MCP endpoints, the org's audit.
   - Owner: users, orgs, the deployment audit.
   - Everyone else: read-only.

   Every editor is a pop-up over one record, in the idiom of the Build SLI
   editor, with a status line that names what changed.
4. **The org switcher** appears only for a user who belongs to a second
   org.

Views follow [UI_CONVENTIONS.md](UI_CONVENTIONS.md):
- they import `studio/host.mjs`;
- loaders, pure models and renderers are separate exports;
- journey actions ride a namespaced render argument (as `host.build` does),
  and `host.mjs` stays the four stable hooks;
- each functional zone gets one class prefix;
- models are tested under `node:test`.

The WCAG AA scan in `tools/test-build-model.mjs` covers only `studio/app.css`
from its `==== The axis` marker onwards. Slice 6a therefore places the new
rules after the marker or extends the scan.

## 7 · Slices — each its own PR against `develop`, each green alone

| # | Slice | Ships | Suites ported · docs updated |
|---|---|---|---|
| 1 | **Store foundation** | `server/store/` (open, pragmas, `tx()`, the warning filter, migrations, schema v1, repositories with no callers yet); the `node:sqlite` and `BEGIN` guard tests; `packc store backup`; the Node ≥ 22.16 floor with the CI floor leg; the k8s store PVC and `strategy: Recreate`. No behaviour change. **First commit:** `tools/cli.mjs` stops calling `process.exit()` straight after a large `process.stdout.write`. On 22.22 under `node --test`, `packc journey run --all --json` loses its tail to the pipe: 146 KB are written, and `JSON.parse` fails at `tools/test-journey.mjs:1469` on clean `develop`. CI on 20 is green, and the move to 22 must not land on that failure | README (Node line, backup), `.github/copilot-instructions.md`, `.env.example` (`OBSERVOGRAM_DB`), `deploy/k8s/README.md` (the store volume; database never on RWX), `tools/cli.mjs` usage |
| 2 | **Identity on the store** | users, orgs, memberships and owners; the import (§4 steps 1–3) and its report; `auth.mjs`, `tenancy.mjs`, `user-admin` and `org-admin` over repositories; `session_epoch` (pwflow included); OIDC just-in-time users, `default_member_role` and `OBSERVOGRAM_BOOTSTRAP_ADMIN`; the org context in every posture; `packc store export` | ports `server/test-auth-local.mjs`, `test-tenancy.mjs` and `test-auth-oidc.mjs`: fixtures are written before the first open or through repositories, and file-absence checks become row checks. README security posture, `.env.example` (users file as import source, tenancy no longer armed by `orgs.json`, `OBSERVOGRAM_BOOTSTRAP_ADMIN`), `deploy/k8s/README.md` (PVC contents, the CronJob org-root rule keyed on `orgs.root`), the PRODUCTIZATION_PLAN status lines |
| 3 | **Roles enforced** | the route table (role plus audit actions) and its middleware; the authz matrix | README (roles), CHANGELOG (recorded `viewer`s lose write power) |
| 4 | **Services, environments, MCP endpoints** | tables, role-gated CRUD API, the shared service helper and the backfill (§4 step 5); `packs` replaces `packs/index.json` (§4 step 4); `pack_services` links on register | ports `server/test-workspace.mjs` and the `index.json` assertions in `test-smoke.mjs`; the API in README |
| 5 | **Audit** | the audit rows per the route table, including deploy and verify; `GET /api/audit` (filter by actor, kind, target, time; org-scoped for admins, deployment-wide for owners) | README (audit) |
| 6a | **Studio: services as the axis** | the Services home, the service page, Check and Build wired to the table, the org switcher | `docs/USER_JOURNEY.md`, `docs/BUILD_JOURNEY.md` (Build writes the service) |
| 6b | **Studio: settings** | members, environments, MCP endpoints, users, orgs, audit | `docs/USER_JOURNEY.md` |

Each slice goes through the same pass:
1. an implementer;
2. two reviewers in parallel: one drives it as a user and tries to break
   it; the other checks conventions, accessibility, tests, commit hygiene,
   and docs against code;
3. a fixer that reproduces each finding first.

Each slice is driven live, in a browser or through the API with the exact
labels and numbers, before it is reported. Roughly two weeks end to end.

## 8 · Quality gates

| Gate | Mechanism |
|---|---|
| Migrations | every migration applied from `user_version` 0 and from each prior version on a temp-file fixture; re-running is a no-op. A migration that rebuilds a referenced table follows SQLite's documented procedure: `foreign_keys=OFF` **before** `BEGIN` (it is a no-op inside a transaction), `PRAGMA foreign_key_check` before `COMMIT`, back `ON` after |
| Import | fixture workspaces, imported and asserted row by row, each import report included: flat stand-alone; `orgs.json`-armed with a not-yet-moved flat workspace; OIDC with `orgs.json`; OIDC without it; legacy `.tomograph/`; a corrupt `index.json`; unknown role strings; an `orgs.json` without `default` |
| Import refusal | a CLI run with a shell env refuses on a workspace with legacy files, and imports nothing |
| Export | a pre-store build boots on an exported workspace; the same users sign in and see the same packs; a flat deployment's export contains no `orgs.json` |
| OIDC upgrade | a pre-upgrade OIDC cookie still reads `/api` on a workspace without `orgs.json` (`server/test-auth-oidc.mjs` "API reads work with the OIDC session" stays green); an `orgs.json` OIDC member keeps their recorded role with a pre-upgrade cookie and after a fresh sign-in; a local username equal to an IdP sub does not capture the membership; an unverified email never matches `OBSERVOGRAM_BOOTSTRAP_ADMIN` |
| Tenancy isolation | two orgs on one temp-file store: every repository and every `/api` route proves org B reads and writes nothing of org A's; a repository call outside an org context throws; the default org's code paths never read inside `orgs/`. `POST /api/refresh-live` and the catalogue are listed as deployment-global, with the reason |
| AuthZ matrix | table-driven: every route × {anonymous, viewer, operator, admin, owner, bearer} × {open, token-only, identity} → the expected status; an unclassified route fails the suite; an org admin cannot act on a user or an org outside their own |
| Revocation | a disabled user's old cookie and a changed password's old cookie are refused on the next request, and so is a pwflow cookie from before the change; pre-upgrade cookies stay valid |
| Audit | UPDATE, DELETE, `REPLACE` and `INSERT OR REPLACE` on `audit` abort; each successful route writes exactly the rows its table entry names, with the request's actor; refused routes write none |
| Concurrency | on a temp-file database (`:memory:` is private per connection and never runs WAL), the CLI writes while the server holds the database; no `SQLITE_BUSY` surfaces |
| Local-mode behaviour | `OBSERVOGRAM_AUTH=off` and a fresh first boot (`admin`/`admin`) keep today's externally visible behaviour: HTTP statuses, the login and forced-change flow, the open posture, a flat workspace with one org. The ported suites assert it |
| Journey engine | `packc journey run` and the Neuron open no database; the CronJob path runs with the database file absent; a default-org CronJob keeps its root across org creation |

## 9 · Decisions (ratified 2026-09-24)

1. **Node floor raised to 22** everywhere, CI included; Node 18 and 20 are
   dropped. (Ratified as ≥ 22.13; see 9b.1.)
2. **One database per deployment**, with `org_id` on every org-scoped row,
   not one file per org.
3. **Artefacts stay files** (pack YAML, snapshots, journeys, runs); records
   move to the store (§3).
4. **The imported JSON files are left in place.** The database is
   authoritative after the import; `packc store export` is the exit.
5. **Tenancy:** there is always a default org, and the org switcher appears
   with a second org. (Ratified with a one-time layout flip; see 9b.2.)
6. **Service tier vs pack tier:** the service's criticality sets the
   default rubric, and a mismatch with the pack is shown, not blocked.
   (See 9b.6 for which pack field that is.)
7. **Branches:** `codex/<topic>` from `origin/develop`, per
   [BRANCHING.md](BRANCHING.md).

## 9b · Refinements from checking the plan against the code (awaiting confirmation)

1. **The floor is ≥ 22.16, not 22.13**, and CI gains a leg pinned to the
   floor. The known `node:sqlite` defects fixed in 22.16 are exactly the
   ones a store would hit, and CI's `'22'` would never exercise the floor
   otherwise.
2. **No runtime layout flip.**
   - *As ratified:* the flat workspace moved to `orgs/default/` when the
     second org was created, behind a write barrier.
   - *Why not:* the move silently strands the journeys CronJob (pinned
     to the flat root, `run --all` then exits 0 with "no journeys
     saved"). Runs that straddle the rename recreate the flat root, and
     `GET`s and debounced flushes write to it too.
   - *Instead:* each org's `root` is fixed at creation. The default org
     stays at `.` and new orgs go to `orgs/<id>`. No data moves after the
     import.
3. **A deployment-level owner, separate from org admin.** Without it, an
   admin of org A could disable or re-password a user who also belongs to
   org B, create orgs and read deployment events.
4. **`deploys.jsonl` stays the deploy file of record.** The journey engine
   reads it. The database gets an audit row per deploy instead of a
   `deploys` table.
5. **OIDC keeps today's access, and the first owner is named.**
   - Upgraded OIDC deployments with no `orgs.json` keep every IdP user's
     access through `default_member_role = operator`.
   - `orgs.json` OIDC members are imported by `<issuer>#<sub>`.
   - The first owner is named through `OBSERVOGRAM_BOOTSTRAP_ADMIN`
     (verified email only) or the CLI, never "the first to sign in".
6. **Tier means `bindings.criticality`**, with the per-environment
   override mirrored on `environments.tier`. Packs have no `minTier`; that
   is a library and clause field.
7. **The database gets its own RWO volume on k8s**, the studio Deployment
   gets `strategy: Recreate`, and `packc store backup` (`VACUUM INTO`)
   replaces "copy the workspace" as the live backup.

## 10 · Risks

- **`node:sqlite` is experimental on 22.x.**
  - Its surface has changed within 22.x: `run()` resets the statement
    (22.16), and `?NNN` parameters are handled as positional (22.20).
  - The floor leg and the latest-22 leg in CI catch that class of change.
  - The repository layer is the only caller, so an API change is one
    module's problem.
  - Node 24 is untested here. It gets its own CI leg before anyone relies
    on it.
- **Behaviour change for armed deployments.** Roles recorded in `orgs.json`
  start to be enforced in slice 3. `member` and unknown roles map to
  `operator`, so nobody loses today's powers except members recorded as
  `viewer`. The import report and the CHANGELOG name them.
- **The default org's root contains `orgs/`.** This is the cost of never
  moving data. The isolation gate asserts that no default-org path reads
  inside it.
- **Scope creep.** Out of scope:
  - invitations and email flows;
  - billing;
  - per-service ACLs inside an org;
  - a multi-instance studio.

  The plan ends at "sign in, land in your org, see your services and their
  environments, act within your role, and every change is on the record".
