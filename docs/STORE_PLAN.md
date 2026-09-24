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

*Status: the seven decisions in §9 were ratified in chat on 2026-09-24.
§9b lists the refinements made afterwards, while two adversarial review
passes checked this plan against the code. Each one closes a hole those
passes found. Merging this plan confirms them. This is a plan, not a spec:
it names the shape, the seams, the boot order, the slices, the gates and
the risks. The detail below exists because every item was a real failure
mode in the current code.*

## 0 · Status quo — what exists and what is missing

| Concern | Today | Where | Gap |
|---|---|---|---|
| Users | `users.json`, scrypt-hashed. Its *existence* arms stand-alone sign-in, even when it is empty. `admin`/`admin` is seeded on first boot | `server/auth.mjs` (`readUsers`, `writeUsers`, `maybeSeedDefaultAdmin`), `tools/user-admin.mjs` | no roles. No revocation: the session is a stateless HMAC cookie, and `/auth/*` routes read it without any check against a record. OIDC users are recorded nowhere; the callback signs `claims.sub` straight into the cookie and never reads `claims.iss` |
| Orgs | `orgs.json` `{ id: { name, members: { sub: role } } }`. Its existence arms tenancy. Members are keyed by username (stand-alone) or bare IdP sub (OIDC) | `server/tenancy.mjs`, `tools/org-admin.mjs` | roles are recorded but **not enforced**: Stage 3 never shipped. `--role` accepts any string, and `member` is its default. The readers swallow parse errors |
| Tenancy | `orgWorkspaceRoot()` answers `join(base, 'orgs', id)` inside an AsyncLocalStorage org context, gated on `tenancyEnabled()` (`orgs.json` exists). The context exists only for `/api` requests. Boot rehydrate runs outside it and writes `<base>/packs`, which the next armed boot migrates into an empty `default` org | `server/tenancy.mjs`, the org middleware in `server/index.mjs` | the AsyncLocalStorage seam stays. The answer changes (§1) |
| Services | not a record. Derived from registered packs: `serviceMetadata()` on the server, `serviceCatalogue()` / `isLiveAggregatePack()` / `normalizeServiceKey()` in the studio | `server/index.mjs`, `studio/app.mjs` | no owners, tier or environments of their own. A service without a pack does not exist |
| Environments | not a record. A pack's environment list (`listEnvironments`) or a gen-site partition | `tools/lib/adapter.mjs` | no endpoint and no MCP binding, so nothing to check a service *through* |
| MCP endpoints | a URL typed per session. Write tokens pass through per request | studio, `server/routes/deploy.mjs` | nothing at org level to pick from |
| Live pack | `POST /api/refresh-live` writes `examples/production-live.pack.yaml` inside the install, built from the raw MCP URL; `GET /api/live-status` reads it | `server/index.mjs` | one file for the whole deployment, which can carry URL credentials |
| Pack registry | `packs/<id>.pack.yaml` (ids `uploaded-<slug>-<hash8>`) plus an advisory `packs/index.json` | `server/workspace.mjs` | the index is a hand-rolled table with a merge-on-flush and an incident behind it (2026-06-11) |
| Deploy audit | append-only `deploys.jsonl`: deploy, bulk, rollback and verify lines. The actor is `session.email \|\| session.sub`, an unverified claim under OIDC | `server/workspace.mjs`, `server/routes/deploy.mjs`; **also read by** `tools/lib/journey.mjs` `readDeployLog()` | only deploys are audited. User, org and settings changes leave no trace |
| Identity seams | the auth gate (the first `app.use` in `server/index.mjs`; the plans call it `requireAuth`) stamps `req.observogramActor` and `req.observogramSub`. The bearer token is the service account. `/auth/*` bypasses the gate | `server/index.mjs` | stays |

Every new record type today costs another file format, another atomic-write
routine and another ad-hoc loader. The store removes that cost for
*records*. It deliberately does not touch *artefacts* (§3).

## 1 · The shape

- **Engine.** Node's built-in `node:sqlite` (`DatabaseSync`). No new
  dependencies: the `openid-client` exception in `server/auth.mjs` stays
  the only one.
- **One database per deployment.**
  - It lives at `<base workspace>/observogram.db`, and `OBSERVOGRAM_DB`
    relocates it. On k8s it sits on the base's own RWO volume (§3).
  - Every org-scoped row carries `org_id`. Users span orgs, so one file is
    the honest model.
  - `OBSERVOGRAM_DB=:memory:` is for in-process tests and for throwaway
    demos over a fresh temp workspace only. It is private to one
    connection, never runs WAL, and forgets everything at restart. A
    restart imports again and seeds `admin`/`admin` again. The server
    warns when it starts on `:memory:`, and the CLIs refuse it.
- **One module, `server/store/`.**
  - `db.mjs`: open, pragmas, `tx()`, the version check, the warning filter.
  - `migrations.mjs`: ordered steps keyed by `PRAGMA user_version`.
  - `import.mjs`: the legacy import (§4).
  - One repository per table.

  Repositories are the only code that writes SQL; routes and `auth.mjs`
  call them. The module lives under `server/`, so the rule that `tools/lib`
  stays free of `node:*` (it is served to the browser) is untouched.
- **Two classes of repository.**
  - **Context-scoped:** `services`, `environments` (through
    `service_id`), `mcp_endpoints`, `packs`, `pack_services`. These read
    `currentOrg()` and throw outside a context.
  - **Deployment-level:** `users`, `orgs`, `memberships`, `audit`. These
    take an explicit org id where they need one and never read the
    context. The org middleware's own membership lookup, `/auth/*`,
    just-in-time joins, the bootstrap grant and org creation are
    cross-org by nature and live here.
- **The file root is looked up, never derived.**
  - `orgWorkspaceRoot()` returns `join(base, orgs.root)` for
    `currentOrg()`. The root is fixed at creation, so it is cached per id.
  - In the server it **throws** outside an org context, the same
    fail-closed rule as the repositories. A missed caller can no longer
    write a flat root that nobody reads.
  - `tenancyEnabled()` and its `orgs.json` check retire from
    `orgWorkspaceRoot()`, `uploadsMap()` (whose scope key becomes
    `currentOrg()`), the org middleware, `GET /api/orgs`, `/auth/me` and
    `maybeSeedDefaultAdmin()`. Only the legacy path of the boot order
    (§4) still reads `orgs.json`, until `import_done`.
  - Code outside a request (boot rehydrate, the debounced index flush,
    the backfill) enters `runWithOrg(id)` per org, with the id captured
    when the timer was scheduled.
  - The journey engine's own resolver in `tools/lib/journey.mjs`, which
    uses env or base when no resolver is injected (CLI, CronJob), is
    unaffected.
- **Handles.** A handle is cached per resolved path, and env is re-read on
  each call, as `server/workspace.mjs` does, so a suite can re-point
  `OBSERVOGRAM_WORKSPACE` between boots. `closeStore()` is exported. The
  server closes the database on `SIGTERM` and `SIGINT`. It has no handler
  today and runs as PID 1 in the image.
- **Opening a file database**, in order:
  1. Refuse on a network or shared filesystem (`fs.statfsSync`: NFS, CIFS,
     SMB, SMB2, CephFS) and warn on FUSE. WAL needs shared memory between
     the processes on one host.
  2. Set `busy_timeout=5000`, then `foreign_keys=ON` (already
     node:sqlite's default), `recursive_triggers=ON` and
     `synchronous=NORMAL`.
  3. If `journal_mode` is not `wal` (a fresh file or a restored backup),
     set it, then assert that it reads `wal`.
- **Writes.**
  - Every write goes through `tx(fn)`: migrations, the import and every
    repository write. `tx` opens `BEGIN IMMEDIATE`, runs `fn`
    **synchronously**, then commits, or rolls back and rethrows.
  - If `fn` returns a thenable, `tx` rolls back and throws. On the one
    shared connection, an `await` inside a transaction lets other
    requests' statements run inside it.
  - A guard test fails on a `BEGIN` or an outermost `SAVEPOINT` anywhere
    outside `db.mjs`. Both are deferred transactions, which fail with
    `SQLITE_BUSY_SNAPSHOT` at once whatever the timeout.
  - Repositories bind only numbers, strings, `null` and buffers:
    booleans become 0/1, because 22.x throws on a JS boolean and 24 does
    not.
  - Parameters are `?` or `:name`, never `?NNN`, which is positional only
    from 22.20.
  - `RETURNING` statements are read with `.get()` / `.all()`, never
    `run().changes`.
- **Migrations.** For each pending step the runner:
  1. runs `PRAGMA foreign_keys=OFF` outside any transaction (inside one it
     is a no-op);
  2. enters `tx()` and re-reads `user_version`, skipping the step if
     another opener already applied it;
  3. runs the step;
  4. runs `PRAGMA foreign_key_check`, and rolls back and throws if it
     returns rows;
  5. sets `user_version` and commits;
  6. in a `finally`, runs `PRAGMA foreign_keys=ON`.

  A table rebuild creates `X_new`, copies, drops `X`, then renames `X_new`.
  It never renames the old table away first, because that rewrites the
  children's foreign keys to the old name.
- **Node floor ≥ 22.16.** `node:sqlite` is unflagged from 22.13, but 22.16
  fixes a use-after-free in `StatementSync` (#56840) and the `run()`
  statement reset (#57350), and adds the `timeout` option and
  `isTransaction`.
  - `db.mjs` checks the running version numerically before loading
    `node:sqlite`. It fails with one line naming the floor and the
    running version, and maps `ERR_UNKNOWN_BUILTIN_MODULE` to the same
    line.
  - These move to 22.16: `package.json` `engines` (from `>=18`), the
    regenerated `package-lock.json` root `engines`, the three CI jobs
    (from 20), and `.github/copilot-instructions.md`'s "Node 18+".
  - So do the GitHub Actions journey workflow that
    `tools/lib/schedule-snippets.mjs` generates (`node-version: '20'`,
    now asserted in its test) and the "Requires Node 18+" header comments
    of five tools.
  - CI runs `npm test` twice: once pinned to the floor (`22.16.0`), once
    on the latest 22.
  - The README gains a Node line and says why.
- **The experimental warning.** `node:sqlite` prints an
  `ExperimentalWarning` on 22.x through `process.emitWarning`, once per
  process.
  - `db.mjs` loads the built-in once, through a cached dynamic `import()`,
    with `process.emitWarning` wrapped to drop exactly that warning. The
    original is restored in a `finally` after the import settles. This
    works for the `packc` shebang (verified on 22.22).
  - A static import anywhere would load the built-in before any module
    body runs. So `db.mjs` is the only file that names `node:sqlite`, and
    a guard test fails the build on any other.

## 2 · Schema v1

```text
schema_meta     key PK, value      -- store_id, default_org, identity_armed, oidc_issuer,
                                   -- oidc_join_role, import_done, import_report, users_file,
                                   -- legacy_hashes, replace_requested, packs_imported
users           id PK, kind (local|oidc), login UNIQUE NOT NULL,   -- username, or <issuerKey>#<sub>
                issuer NULL, sub NULL, email, email_verified,
                name, password JSON NULL, must_change, seeded_default,
                is_owner, disabled, session_epoch NOT NULL, created_at, last_login_at
orgs            id PK (slug), name, root NOT NULL,          -- '.' or 'orgs/<id>', fixed at creation
                removed_at NULL, created_at
memberships     org_id FK NOT NULL, user_id FK NOT NULL,
                role NOT NULL CHECK (role IN ('viewer','operator','admin')), created_at;
                PK(org_id, user_id)
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
  roles (§5), because users, orgs and the deployment audit belong to no
  one org.
- **`session_epoch`** is the first thing the database buys.
  - One helper, `resolveSession(req)` in `server/auth.mjs`, replaces bare
    `readSession()`. It verifies the HMAC, loads the row, refuses a
    disabled row, an epoch mismatch or a local cookie with no row, and
    creates an OIDC row on first sight (§4).
  - **Every** session reader uses it: the auth gate, `/auth/me`, the
    signed-in change-password routes and "sign out my other sessions".
    The pwflow reader in `GET`/`POST /auth/change-password` and `/skip` applies
    the same epoch and disabled check, and also requires `must_change` to
    still be set.
  - Every sign-in path refuses a disabled row and issues no cookie: login,
    both change-password paths, `/skip` and the OIDC callback.
  - Disabling a user, changing a password or "sign out everywhere" bumps
    the epoch.
  - A cookie without an epoch (issued before the upgrade) reads as 0.
    Imported rows, and OIDC rows created on first sight of such a cookie,
    start at 0. Every other new row starts at 1. The upgrade therefore
    signs nobody out, and a pre-upgrade cookie can never match a
    post-upgrade user.
  - Removing a user disables the row instead of deleting it: the audit
    references it, and a disabled row is what revokes.
- **`orgs.root`** is where the org's files live, relative to the base
  workspace. It is fixed at creation, so data never moves at runtime (§4).
  The exceptions are offline: an in-place `packc store export` that
  writes `orgs.json`, and an `import --replace` that finds the data already
  moved, set a default org at `.` to `orgs/default`, because a pre-store
  build moves it anyway.
  **`removed_at`** makes org removal a soft delete. Slug and root are never
  reused.
- **`schema_meta.oidc_join_role`** is the role an OIDC just-in-time user
  joins the default org with; absent means no auto-join. It is a
  deployment-level identity policy (who in the IdP gets in), so it lives
  in `schema_meta` and only an owner changes it.
- **`mcp_endpoints.read_token_env`** is the *name* of an env var, mirroring
  the journeys' `packB.mcp.authEnv`. **No secret is ever stored**: write
  tokens stay per-request pass-through.
- **`pack_services`** exists because a pack is not always one service. The
  live aggregate packs carry many.
- **Tier is criticality, not `minTier`.** `minTier` belongs to library SLIs
  and conformance clauses; the pack itself has none.
  - A pack's criticality is `metadata.bindings.criticality`, and each
    environment may override it through `spec.environments.<env>.criticality`.
    That is what `conformance.mjs` `tierOf` grades the overlaid pack at
    today.
  - Per environment, the record's effective tier (`environments.tier`,
    else `services.tier`) is compared with the pack's effective
    criticality for that environment. A mismatch is shown, never blocked
    (decision 6).
  - Where a service row exists, its effective tier becomes the grading
    tier. The conformance route passes it in, in slice 4. A pack with no
    service row is graded as today.
- **`audit` is append-only in the schema.**
  - `BEFORE UPDATE`, `BEFORE DELETE` and `BEFORE INSERT … WHEN EXISTS
    (SELECT 1 FROM audit WHERE seq = NEW.seq)` triggers all
    `RAISE(ABORT, 'audit is append-only')`.
  - The third refuses an existing `seq`, so `REPLACE` / `INSERT OR REPLACE`
    cannot rewrite a row on **any** connection. Without it, both overwrite
    rows (verified on 22.22 / SQLite 3.51.2). An auto-assigned `seq` reads
    as -1 in the trigger, so plain inserts pass.
  - `recursive_triggers=ON` is a second layer only: it is per-connection
    and not stored in the file.
  - These triggers guard against application bugs, not against someone
    who holds the file.
  - v1 has no retention. Growth is bounded by the rate of human and CI
    actions. A later retention policy is an explicit migration that
    archives with `VACUUM INTO` and then prunes.

## 3 · What stays a file, where the database lives, and operations

Records move. Artefacts stay where `cat`, `git diff` and a volume backup can
see them (decision 3):

| Stays a file | Why |
|---|---|
| `packs/<id>.pack.yaml` | the artefact itself; the pack id *is* the filename. Only `packs/index.json` becomes the `packs` table |
| `snapshots/<deployId>/` | rollback payloads: opaque JSON per captured artefact |
| `journeys/*.journey.yaml` | designed to be committable into a service repo (VALUE_BACKLOG item 11) |
| `runs/<journey>/*.json` | written by `packc journey run`, which runs as a k8s CronJob on the shared workspace PVC. The journey runner never opens the database |
| `deploys.jsonl` | **stays the file of record for deploys.** `tools/lib/journey.mjs` `readDeployLog()` reads it to place deploys in a run's chain history: the server-agnostic engine, on the same CronJob. The server also writes one audit row per append (§5) |
| `live/production-live.pack.yaml` | the live pack moves from `examples/` into each org root (§5) |
| `session-secret` | a secret, `0600`, kept outside anything a support dump of the database would carry |

**k8s.** The base Deployment has no volume today. Its workspace is the
image's ephemeral `/app/.observogram`, so every rollout would wipe users,
roles and the audit, and would reset `session_epoch`, which revives
revoked cookies. Slice 1 therefore changes the base:
- **One RWO PVC, named `store`**, holds the database and the workspace as
  two subPaths:
  - `db` at `/data/db`, with `OBSERVOGRAM_DB=/data/db/observogram.db`;
  - `workspace` at `/data/workspace`, with `OBSERVOGRAM_WORKSPACE` set to
    it.

  Pack files, snapshots, `deploys.jsonl` and `session-secret` then persist
  with the rows that point at them. The distinct volume name matters,
  because `patch-studio-workspace.yaml` strategic-merges volumes by name.
- **Pod settings:** `securityContext.fsGroup: 1000` with
  `fsGroupChangePolicy: OnRootMismatch` (a fresh PVC is root:root 0755, so
  uid 1000 could not create the file), and `strategy: Recreate`.
- **Why `Recreate`.** RollingUpdate briefly runs two studio processes
  against one database. It stalls on attach when the RWO volume sits on
  another node. And on the slice-2 upgrade it would run the new pod's
  import while the old pod still writes the legacy files. Only
  `Recreate` waits for the old pod to finish terminating; `maxSurge: 0`
  does not. The cost is a short outage per rollout.
- **The journeys overlay** takes the workspace over (`/workspace` on its
  own PVC). The database stays on `store`. That PVC may be RWX **only while
  `OBSERVOGRAM_DB` points at the RWO store volume**. Slice 1 rewrites the
  advice in `pvc-workspace.yaml`, `cronjob-journeys.yaml` and
  `deploy/k8s/README.md` to say so. Switching the base to the overlay
  moves the workspace, and the default org's root `.` with it. With the
  studio scaled to 0, the whole `workspace` subPath is copied onto the
  overlay PVC with modes preserved (`cp -a /data/workspace/. /workspace/`
  from a one-off pod that mounts both claims): packs, snapshots,
  `deploys.jsonl`, journeys, runs, `live/`, `session-secret`, every
  `orgs/<id>/` root, and any legacy files and `.store-imported`. The
  database stays on `store` and needs no copy.
- **Zones.** With the overlay, the pod mounts two RWO claims. On a
  multi-zone cluster both need a `WaitForFirstConsumer` class, or an
  Immediate class pinned to the zone of the workspace PV. The README says
  how to check.
- **Tests.** `tools/test-deploy-manifests.mjs` is re-pinned:
  - the file list and the base resources gain the store PVC;
  - the base Deployment's env and mounts become exactly `OBSERVOGRAM_DB`,
    `OBSERVOGRAM_WORKSPACE` and the store volume;
  - the base pod carries `fsGroup` and `strategy.type === 'Recreate'`,
    also on the rendered overlay;
  - the store PVC is `ReadWriteOnce`, and the CronJob never mounts it.
- **Scope.** The studio stays `replicas: 1`; a multi-instance studio is out
  of scope. On a non-k8s host the database lives on local disk.

**Backups.** The database is WAL, so a file-by-file copy (`cp -r`, rsync,
tar) taken while *any* process has it open is not a backup, even with
`-wal` and `-shm` included: a checkpoint between two file copies tears it.
Safe options:
1. A copy with nothing holding the database: the server stopped, and no
   `npm run users`, `npm run orgs` or `packc store` running.
2. An atomic volume snapshot.
3. With the server running, `packc store backup <path>`. It runs `VACUUM
   INTO ?` outside any transaction into `<path>.tmp` and renames that to
   `<path>`, refusing an existing `<path>`. It captures committed rows
   while writers are active, as one rollback-journal file.

The workspace files (packs, snapshots, journeys, runs, `deploys.jsonl`,
`session-secret`) can be copied live as before. A workspace copy alone is
not a backup wherever the database lives outside it: on k8s it is at
`/data/db`, beside `/data/workspace`. Such a copy holds no users, orgs,
memberships or audit. This supersedes PRODUCTIZATION_PLAN Stage 4's
"the workspace directory (it already IS the state)".

**Restore** is `packc store restore <backup>`, with the server stopped. It
refuses while the database is in use. It moves `observogram.db`, `-wal` and
`-shm` aside together, then copies the backup in. Copying a backup over the
`.db` alone is never safe: a `-wal` left by an unclean stop is replayed onto
it.

**Upgrade and rollback** (README and `deploy/k8s/README.md`, slices 1–2):
- Set `OBSERVOGRAM_DB` before the first boot of a store build. To move an
  existing database, move the file: it carries its `store_id`.
- Never roll the image back without first running `packc store export`
  in place, with the server stopped. A `kubectl rollout undo` without it
  runs the old build on the pre-upgrade files: passwords changed since
  revert, and removed users come back.
- After a downgrade, re-upgrading needs `packc store import --replace`.
  The boot rule in §4 enforces it.

## 4 · Getting there from today's files

### The boot order in `start()`

The import runs in the server, with the server's env. It is pinned relative
to today's checks, which all run before `migrateFlatWorkspace()` and would
otherwise read an empty store:

1. **Open the store.** This covers the version check, the filesystem check
   and the migrations.
2. **Guard against a stale re-import.** When the database is created, it
   gets a random `store_id`. After the import commits, the server writes
   `<base>/.store-imported`, holding the `store_id` and a SHA-256 of
   `users.json` and `orgs.json`, as they are on disk at commit. The
   `users.json` entry is keyed by the recorded `users_file` when there is
   one, otherwise by the base-relative name, so a move of the base (§3)
   needs no store change. The same hashes go into
   `schema_meta.legacy_hashes`. At boot:
   - Legacy files present, a marker present, and the database empty or
     carrying a different `store_id` (a lost PVC, or `OBSERVOGRAM_DB`
     changed after the upgrade): refuse, import nothing, and name the
     store the files were imported into. There are three ways out: point
     `OBSERVOGRAM_DB` at that store or at a copy of its backup; `packc store
     restore <backup>` with the server stopped; or, to accept the legacy
     files as they stand, move `.store-imported` aside, so the next boot
     imports them and logs that it did.
   - Ids match, but a hashed file differs from the last import or export:
     the files were edited outside the store, for instance during a
     downgrade. Refuse and name `packc store import --replace`.
   - A pending `replace_requested` is accepted instead of that refusal only
     when the request, the marker and the database all carry the same
     `store_id`; step 3 then carries it out. Otherwise the first bullet's
     refusal applies and the request stays pending.
   - A file that was absent at import or export is recorded as absent, and
     one that has since appeared counts as changed. A hashed file that has
     *disappeared* is not a downgrade edit (no pre-store build deletes these
     files): when nothing appeared and no content differs, the boot records
     it as absent, logs it and goes on.
   - **`oidc_issuer`.** With OIDC configured and a recorded `oidc_issuer`
     that differs from today's issuer key, refuse, name both values and
     name `packc store rekey-issuer`. Nothing is moved, seeded, imported or
     replaced, and a pending replace stays pending: after `rekey-issuer
     --to`, the next boot carries it out under the new key.
   - `import_done` is set but the marker is missing (a crash between commit
     and marker): rewrite the marker.
3. **While `import_done` is absent, or a replace is pending:**
   - **Strict-read `users.json` and `orgs.json`.** The readers throw on a
     read error, a parse error or the wrong shape. A throw aborts
     `start()`, names the path and imports nothing. Today's lenient
     readers are never used here. This first read only validates, so
     nothing moves when a file is corrupt.
   - **Apply today's refusals, with no writes, as today's `start()` sees
     them after its seed.** `maybeSeedDefaultAdmin()` is split into a pure
     decision (`seed`, `rescue` or `none`, with today's back-offs) and its
     write. Step 3 evaluates the decision against the legacy files, and
     step 4 applies it. On a boot where step 3 does not run, step 4
     evaluates the same decision against the store before applying it:
     `seed` when `identity_armed` is unset, no back-off applies (OIDC, a
     token, `OBSERVOGRAM_AUTH=off`) and, off loopback,
     `OBSERVOGRAM_ADMIN_PASSWORD` is set; `rescue` when
     `OBSERVOGRAM_ADMIN_PASSWORD` is set, no back-off applies and the
     `admin` row still has `seeded_default` and `must_change`; otherwise
     `none`.
     - **Off loopback with no auth.** Auth means an API token or, unless
       `OBSERVOGRAM_AUTH=off`: OIDC env, a users file, `identity_armed`
       already set in the store by a CLI, or a `seed` decision carrying
       `OBSERVOGRAM_ADMIN_PASSWORD`. `OBSERVOGRAM_INSECURE_NO_AUTH=1` still
       overrides. The documented `docker run -e
       OBSERVOGRAM_ADMIN_PASSWORD=…` boot on a fresh workspace therefore
       passes, as it does today.
     - **A still-seeded default admin off loopback.** Refuse, unless the
       decision is `rescue`: `OBSERVOGRAM_ADMIN_PASSWORD` set and no token.
     - **No identity, and the import would produce more than one org.**
       Count the `orgs.json` orgs, minus the empty `default` artefact,
       plus `default` when `migrateFlatWorkspace()` would move flat data
       into it. A bearer token is not identity. A one-org `orgs.json` with
       only a bearer passes, imports and boots token-only (§10).

     A refused boot moves, seeds and imports nothing. Step 4 applies the
     same rules to the store, so it never refuses a boot that step 3
     passed.
   - **Run `migrateFlatWorkspace()` one last time.** It is fixed in slice 2
     so that it never moves an empty directory or a zero-byte
     `deploys.jsonl`, and writes `default` into `orgs.json` only when it
     actually moved data. Where a flat entry and its `orgs/default/<entry>`
     both exist, neither is moved or merged: the report lists the flat one
     as left behind, and every boot logs it until an operator resolves it.
   - **Run the import**, in one `tx()`, from a second strict read taken
     after the migration, since `orgs.json` may now hold `default`. The
     transaction records `import_done`, `users_file`, the report and one
     audit row, and clears `replace_requested`. The marker is written after
     the commit.
4. **Seed and check against the store.**
   - Apply the seed decision: `seed` writes the owner `admin`, and `rescue`
     replaces a still-seeded row's password and clears `seeded_default`
     and `must_change`. The seed stops on `identity_armed`; the rescue does
     not, since it keeps the same back-offs as today.
   - Run the fail-closed bind checks against the store: no auth off
     loopback, a still-seeded default credential, and more than one org
     without identity.
   - **`oidc_issuer`.** With OIDC configured and no recorded value (a first
     OIDC boot, or a switch from stand-alone), record today's issuer key,
     after every other check has passed. A mismatch was already refused at
     step 2. With OIDC unset, keep the record.
   - Zero owners in the current identity mode logs a warning naming the
     way in. The same banner shows in Settings.
5. **From slice 4: the one-shot pack import**, while
   `schema_meta.packs_imported` is absent (import items 4–5 below).
6. `setWorkspaceRootResolver()`, then `loadWorkspacePacks()` per org.

The import never overwrites a row. If a CLI initialised the store first
(below), an existing login is kept and listed as a conflict in the report.

**The CLIs never import, and never write `import_done`.** Otherwise they
could import with a shell's env, without the unit's `OBSERVOGRAM_USERS_FILE`
or `OBSERVOGRAM_OIDC_ISSUER`.
- `npm run users`, `npm run orgs` and `packc store` refuse while legacy
  files exist at the resolved workspace and `import_done` is absent ("start
  the server once with its environment").
- `packc store restore` is exempt. It never imports, and with the server
  stopped it replaces the database file whatever `import_done` says. It
  warns when the backup's `store_id` differs from the marker.
- `packc store import --replace` needs `import_done` and a marker, and
  refuses unless the database's `store_id` equals the marker's: an empty or
  foreign store takes the first-bullet ways out. It only *requests* a
  replacement: with the server stopped, it writes `replace_requested` with
  the marker's `store_id`, and the next boot carries it out with the unit's
  env (step 3).
- On a workspace with nothing to import, the CLIs create the schema and
  their own rows, and print "store initialised from this shell's
  environment", so `npm run users -- add` on a fresh install keeps working.
- They print the database path they opened, and they refuse `:memory:`.
- `npm run users -- owner` and `npm run orgs -- add-member` build OIDC
  logins from the shell's issuer, and refuse when it differs from the
  recorded `oidc_issuer`.

### What the import maps

Slice 2 imports items 1–3. Items 4–5 are slice 4's one-shot step 5: the
server keeps writing `packs/index.json` until slice 4, so it is neither
hashed nor imported before then.

1. **Users.** `users.json` becomes `users` rows with kind `local`, session
   epoch 0. When `OBSERVOGRAM_USERS_FILE` is set, it is read there and its
   resolved path is recorded as `schema_meta.users_file`; otherwise
   `<base>/users.json` is resolved each time against the current base.
   - The password record carries over verbatim. `mustChange` and
     `seededDefault` carry over as 0/1.
   - **A users file that exists arms identity** (`identity_armed`), even
     an empty one. Today its existence arms, so an empty file still keeps
     the seed off and the server closed.
   - Under OIDC, users-file rows are imported as disabled and never become
     owners. A leftover file from before an OIDC switch would otherwise
     create a local owner nobody can sign in as.
2. **Orgs.** `orgs.json` becomes `orgs` rows (`root = orgs/<id>`, which is
   where their data already is) plus `memberships`.
   - **Member keys map by the identity mode in effect.** With
     `OBSERVOGRAM_OIDC_ISSUER` set, every key becomes a kind `oidc` user
     with login `<issuerKey>#<sub>` (below), even where a `users.json`
     name is equal: `users.json` is ignored under OIDC today. Stand-alone,
     keys map to local users. A key with no user is dropped and listed in
     the report; it never fails the foreign key.
   - **Roles map, never abort.** Values are trimmed and compared
     case-insensitively. A missing, empty or non-string value counts as
     `member`.
     - `admin` / `owner` → `admin`.
     - `viewer` / `read` / `readonly` / `read-only` → `viewer`.
     - Anything else → `operator`, including `member` (the default of
       `npm run orgs -- add-member` today), `operator`, `editor` and
       typos.

     Every inexact mapping is listed. So is every member mapped to
     `viewer`: they lose write power when slice 3 enforces roles, and the
     CHANGELOG says so.
   - **The empty `default` artefact.** A `default` entry with no members
     and no data under `orgs/default/` is a leftover of today's rehydrate
     bug (§0). It is dropped and listed.
   - **The default org** is `default` if a real one remains, otherwise the
     first `orgs.json` org. This mirrors today's bearer fallback.
   - **Owners** are the `admin` members of the default org. If there are
     none, the report and every boot say "no owner — run `npm run users --
     owner <login>`". The admins of *every* org are deliberately not made
     owners: an owner can act on other orgs' users.
3. **No `orgs.json`.** One org, `default`, with `root = '.'`: the flat
   workspace stays exactly where it is.
   - Stand-alone: every imported local user becomes an owner and the
     org's `admin`. That is what every signed-in user effectively is
     today.
   - OIDC: nobody is in a file. So the server's import sets `oidc_join_role
     = operator`, and every IdP user keeps today's access on their next
     request, pre-upgrade cookies included.
   - There is no freshness test here. An upgraded OIDC deployment with an
     ephemeral workspace cannot be told apart from a fresh install. A
     fresh install that should start closed sets
     `OBSERVOGRAM_OIDC_JOIN_ROLE=none` before its first boot.
4. **Pack index** (slice 4, step 5). It runs inside `runWithOrg(id)` for
   every non-removed org row, so orgs created during slices 2–3 are
   covered.
   - Each root's `packs/index.json` is read with a reader that throws on a
     read error other than ENOENT. A transient EPERM or EBUSY must not
     become an empty index in a one-shot import: that was the 2026-06-11
     incident. A throw aborts `start()` and names the path.
   - A missing, unparseable or wrong-shaped index is not an error. That
     root's rows are rebuilt from the pack files, with orphans adopted at
     their mtime as today, and the report lists the path and says the
     labels were lost.
   - Otherwise today's reconcile rule carries over unchanged: a row
     without a pack file is dropped only on positive evidence that the
     file is gone, and an orphan file is adopted.
   - The step commits the `packs` rows, the backfill, `packs_imported`,
     its report and one audit row in one `tx()`. Only then do the index
     hashes join `legacy_hashes` and the marker. From then on no server
     path writes `index.json`.
   - A store created at slice 4 or later runs both imports in its first
     boot.
5. **Backfill** (slice 4, step 5). Services and environments are created
   from the registered packs by one pure, browser-safe helper,
   `tools/lib/service-keys.mjs`.
   - It holds `normalizeServiceKey`, `serviceMetadata` (moved from
     `server/index.mjs`), `isLiveAggregatePack`, and `servicesForPack(entry)
     → [{ name, key, role }]`. The last one is today's per-pack rule from
     `serviceCatalogue()`: primary is service, else namespace, else name,
     else label; an aggregate gets no primary; a `services` entry equal to
     the aggregate's primary key is skipped.
   - `entry` is the shape `catalogEntryForUpload()` returns, because the
     aggregate regex reads its fields. `services.slug` is
     `normalizeServiceKey(name)`.
   - The server imports the helper statically. The studio loads it from
     `/lib` before its first render, so `serviceCatalogue()` stays
     synchronous. Register-time linking (slice 4) calls the same helper.
   - The pack's `listEnvironments` entries become `environments` rows.
   - Catalogue packs (`examples/`, `reference-packs/`) belong to the
     deployment, not to an org: they get no service rows and stay listed
     apart.

The original files are left on disk untouched (decision 4). After the
import the database is authoritative, and the legacy files are only hashed
(the boot guard above), never read.

### OIDC identities

- **One issuer key.** `issuerKey = canonIssuer(OBSERVOGRAM_OIDC_ISSUER)`
  strips a trailing `/.well-known/openid-configuration` and returns
  `new URL(x).href`. It is built from the configured value, **never from
  `claims.iss`**: openid-client has already validated the claim against
  that one issuer. The textual forms differ between env, metadata and
  token (a trailing slash, a bare origin), and would otherwise yield two
  rows per person.
- **Where it applies.** The import, the first-sight row for a pre-upgrade
  cookie, the callback (login = `issuerKey + '#' + claims.sub`), the
  parsing of `OBSERVOGRAM_BOOTSTRAP_ADMIN` and `add-member` all use it.
  The raw `claims.iss` is kept only in `users.issuer`, for display.
- **When the issuer changes.** With the server stopped, `packc store
  rekey-issuer` offers two ways through:
  - `--to <issuer>`, for the same IdP at a new URL (a host move, or
    Keycloak 17+ dropping `/auth`), where the subs are unchanged. In one
    `tx()` it rewrites `oidc_issuer` and the `<issuerKey>#` prefix of every
    kind `oidc` login, refuses if a rewritten login already exists, and
    writes one `issuer.rekey` row mapping old to new. Earlier audit rows
    and `deploys.jsonl` keep the old logins, since both are append-only.
  - `--clear`, for a different IdP. It disables every kind `oidc` row and
    clears the record. The next boot records the new key, and the
    bootstrap names an owner.
- **Just-in-time users** are created at the callback, or on first sight of
  a pre-upgrade cookie, as kind `oidc`, with `email` and `email_verified`
  recorded.
  - They join the default org at `oidc_join_role` **only when the row is
    created**, so an admin's removal sticks.
  - Turning the setting on later backfills nobody. The owner's editor
    lists users with no membership and offers an explicit "add them at
    this role".
  - Without a join they land on an "ask an admin to add you" page. Today
    only a tenancy-armed deployment returns that 403.
- **The first owner is named explicitly.**
  - `OBSERVOGRAM_BOOTSTRAP_ADMIN=<issuerKey>#<sub>`, or an email that
    counts only when the ID token carries `email_verified: true`
    (compared case-insensitively). A missing claim counts as false; Entra
    omits it, so use the sub form there.
  - The named user becomes owner plus `admin` of the default org at
    **any** sign-in while the deployment has no enabled owner who can sign
    in under the current identity mode. That covers a user who signed in
    before the variable was set, and a switch from stand-alone to OIDC.
  - `npm run users -- owner <login>` does the same from a shell.
  - Two rules are rejected deliberately: "first to sign in wins", which
    hands the org to whoever in the IdP arrives first, and unverified
    email matching, which is the "nOAuth" takeover.

### Arming, local users and orgs after the import

- **Stand-alone sign-in** is armed while `identity_armed` is set. It is set
  by the import, the seed or the first local user, and it is sticky.
  `localUsersEnabled()` reads the flag, not a row count. Removing the last
  user never disarms an exposed server: only `OBSERVOGRAM_AUTH=off`
  does, and the last owner cannot be disabled or demoted anyway.
- **`maybeSeedDefaultAdmin()`** seeds into the table, as owner plus `admin`
  of the default org. It backs off on OIDC, a bearer token,
  `OBSERVOGRAM_AUTH=off` and `identity_armed`. The loopback-only rule for
  the default credential does not change.
- **New local users** (`npm run users -- add`, or Settings):
  - The first local user created while no owner exists becomes owner plus
    `admin` of the default org, whatever `--role` says, as the seed would
    have. The CLI prints this. It is safe because Settings cannot create a
    user without an owner, so only shell access triggers it.
  - Otherwise the user joins the default org at `--role` while the
    deployment has one org; with more orgs, `--org` is required.
  - `--role` on `users -- add` and `orgs -- add-member` accepts only
    `viewer`, `operator` or `admin`, and defaults to `operator`. `member`
    is no longer written.
- **Tenancy is always on.** Every `/api` request resolves an org (§5). The
  org switcher appears for a user who belongs to more than one org.
- **Creating an org** needs an owner, and needs identity: without
  identity the API answers 409, and the CLI refuses the same way.
  - The new org gets `root = orgs/<id>`, and its creator becomes its first
    `admin`.
  - Creation refuses when `orgs/<id>/` already exists and is not empty,
    and names the path. `--adopt` / `adopt: true` overrides it and writes
    an `org.adopt` row. This covers leftovers from an earlier `orgs.json`
    era.
- **Removing an org** sets `removed_at` and writes `org.remove`; it deletes
  nothing.
  - A removed org is absent to the org middleware, the bearer fallback and
    the switcher.
  - The default org cannot be removed.
  - Deleting a removed org's files is an explicit offline step, `packc
    store purge-org <id>`, which also drops that root's entries from
    `legacy_hashes` and the marker.
- **No data ever moves at runtime.** The default org stays at its root, and
  the journeys CronJob keeps its root.
  - `GET /api/journeys/:name/schedule` emits snippets for the requesting
    org's root: cron and schtasks get the absolute org root. The k8s
    snippet keeps the `/workspace` mount and gets a relative `orgRoot`
    (new `schedule-snippets.mjs` input, validated as `.` or
    `orgs/<slug>`), from which it sets `OBSERVOGRAM_WORKSPACE`.
  - The server loads journeys only from `<org root>/journeys/<name>`. The
    path fallback of `loadJourneyDef` is kept for the CLI alone.
  - `crawl:` walks skip the base workspace.
  - The only nesting left is a default org at `.` containing `orgs/`. The
    isolation gate asserts that no default-org path reads inside it.

### `packc store export <dir>` — the exit and the downgrade path

It writes files a pre-store build boots on **with the same membership**,
not the same access: a pre-store build enforces no roles, so every exported
member regains full write, and the report lists every viewer and operator
affected. It is not a byte-level round trip.
- **`users.json`** is written only when `identity_armed` is set. It holds
  the enabled local users only; OIDC rows never go in it. In place, it is
  written to the recorded `users_file`, because a pre-store build reads
  `OBSERVOGRAM_USERS_FILE` when it is set. With no path recorded (no
  `OBSERVOGRAM_USERS_FILE` at import, or a store a CLI initialised) it goes
  to `<base>/users.json` for the base it runs against. The export prints
  the path either way.
- **`index.json`** is written per org root from slice 4 on. Before that
  the server still maintains it, and the export leaves it alone.
- **`orgs.json`** is written only if the deployment had one or has more
  than one org.
  - Member keys are the pre-store session sub: the username, or the bare
    IdP sub for OIDC. Roles are written as `admin`, `member` (from
    `operator`) and `viewer`. Disabled users are left out.
  - When it writes `orgs.json` while the default org's root is `.`, a
    pre-store build would move that org's data into `orgs/default/`. So
    the in-place export makes the move itself, with the server stopped.
    It renames the flat entries into `orgs/default/`, refusing if any
    `orgs/default/<entry>` already exists, and sets that org's `root` to
    `orgs/default` in the same step. It also rewrites the default org's
    journey `file:` paths and prints the CronJob change
    (`OBSERVOGRAM_WORKSPACE=<base>/orgs/default`). Both builds then agree
    on where the data is. This offline step, and the matching one in
    `import --replace`, are the only ways a `root` ever changes.
- **Cookies.** A pre-store build checks a cookie only by HMAC and expiry,
  so users revoked in the store stay signed in until their cookies expire.
  The export says so. Rotating `OBSERVOGRAM_SESSION_SECRET` signs everyone
  out.
- **In place, with the server stopped**, it records the hashes of what it
  wrote in `legacy_hashes` and the marker, so a later store boot does not
  refuse its own export.

**`packc store import --replace`** re-imports users, orgs and memberships
from files edited during a downgrade. It is carried out by the server's next
boot, with the unit's env (§4 step 3).
- It keeps the audit, services, environments and endpoints. From slice 4 on
  it also re-imports each root's `index.json`, with the same reconcile rule.
- A local user missing from `users.json` is disabled. When the files hold
  no `users.json` at all, the store's local users are kept. An OIDC row is
  never disabled for being absent from a file, because the export never
  writes OIDC users.
- `is_owner` is never re-derived from the files, and enabled users keep
  their flag. Without an `orgs.json` in the files, the store's memberships
  and `oidc_join_role` are kept, and the no-`orgs.json` mapping (import
  item 3) is not applied.
- It refuses to commit a result with no enabled owner.
- When the store's default org has root `.`, the files' `orgs.json` holds
  `default`, and that org's flat entries now sit under `orgs/default/`
  (moved by a pre-store boot, or by step 3's `migrateFlatWorkspace()`), the
  replace sets that org's `root` to `orgs/default` in the same `tx()`,
  rewrites its journey `file:` paths and prints the CronJob change, exactly
  as the in-place export does. An empty flat directory or a zero-byte
  `deploys.jsonl` beside its `orgs/default/` twin is a leftover of today's
  rehydrate bug (every pre-store restart leaves an empty `<base>/packs`):
  it is removed and reported. A non-empty twin refuses, naming the paths,
  and that refusal is evaluated in step 3's no-write checks, before
  `migrateFlatWorkspace()` runs, so a refused replace moves nothing. This is
  the second, and last, offline way a `root` changes.
- In the same `tx()` it bumps every changed or disabled user's epoch
  (which also kills cookies minted during the downgrade window), rewrites
  `legacy_hashes`, clears `replace_requested` and writes one audit row.
  The marker is rewritten after the commit.

## 5 · Postures, roles and the audit — enforced before any settings UI

A members or environments API without roles is the privilege-escalation
hole that `server/tenancy.mjs`'s own header warns about. So PRODUCTIZATION_PLAN
Stage 3 ships **before** the settings surface.

| Posture | When | Org context | Who may do what |
|---|---|---|---|
| Open, loopback | `OBSERVOGRAM_AUTH=off`, no `OBSERVOGRAM_API_TOKEN`, bound to loopback | the default org | actor `local`, an owner, every route except creating an org, which answers 409 (§4): a second org without identity would make the next boot refuse. Owner routes that create identity (a user, an owner, `oidc_join_role`) also need the `X-Observogram-CSRF: 1` header, so a cross-site form cannot arm identity |
| Open, exposed | bound beyond loopback with no token and no identity, which boots only with `OBSERVOGRAM_INSECURE_NO_AUTH=1`, with or without `OBSERVOGRAM_AUTH=off` | the default org | actor `local` keeps every route that exists today. Owner routes that create or change identity answer 403: "add the first user with `npm run users -- add`, or configure OIDC". Creating an org answers 409, as in §4 |
| Token only | `OBSERVOGRAM_API_TOKEN` set, identity not armed, no OIDC; `OBSERVOGRAM_AUTH=off` plus a token included | the default org, or the bearer's `X-Observogram-Org` | anonymous: `viewer`, so reads stay open as today; an anonymous mutation keeps today's 401 with `WWW-Authenticate: Bearer`. The bearer is `operator`. Settings is read-only, with a banner naming the way in |
| Identity | local users armed, or OIDC | the requested org, else the user's first membership (by `created_at`, then rowid, which is `orgs.json` key order for imported rows). An **owner** may request any org, and with none requested lands in their first membership or the default org | anonymous: 401 on every `/api` route, reads included, as today. Sessions act per membership. The bearer is `operator` on its `X-Observogram-Org`, else on the default org |

| Role | May |
|---|---|
| `viewer` | every `GET` in the org, except `GET /api/audit` |
| `operator` | plus crawl, draft, register, instantiate, compile, deploy, retrofeed, journeys, refresh-live, and CRUD on services and environments |
| `admin` | plus the org's name, MCP endpoints, the org's audit (`GET /api/audit`, rows with its `org_id`) and memberships in **its own org**: add an existing user by exact login or verified email, change a role, remove. An admin cannot list the deployment's users. The org's last admin can be removed only by an owner |
| owner (`users.is_owner`) | plus users (create, disable, reset another user's password, sign them out everywhere), orgs (create, remove, adopt), `oidc_join_role`, and the deployment audit (rows with `org_id NULL`). The last owner cannot be disabled or demoted |

- **The live pack is per org.** `POST /api/refresh-live` and `GET
  /api/live-status` resolve `<org root>/live/production-live.pack.yaml`
  instead of `examples/` under the install. `buildCanonicalPack` gets
  `safeMcpUrl`, never the raw URL, so credentials in a URL are never
  persisted or served. This ships in slice 3.
- **The route table.** One middleware after the org middleware reads an
  explicit table: method plus path pattern → a class, plus the audit
  actions the route writes. The classes:
  - `public`, in every posture: `GET /healthz` (the k8s probes),
    `GET /api/version` (registered before the gate), `/auth/login`
    (GET/POST, local and OIDC), `GET /auth/callback`, `POST /auth/logout`,
    `GET /auth/me`, the `/lib` and studio static mounts, and the SPA
    fallback;
  - `self`: the change-password routes and "sign out my other sessions",
    acting on the caller's own row. The caller is a resolved session. For
    `GET`/`POST /auth/change-password` and `POST /auth/change-password/skip`
    it may instead be a pwflow cookie that passes the epoch, disabled and
    `must_change` checks (§2). The pwflow cookie takes precedence, as it does
    today, which keeps the forced change of the first `admin`/`admin` boot
    working. A caller with neither is redirected to `/auth/login` (or gets
    401 JSON);
  - `viewer`, `operator`, `admin`;
  - `owner`: these check `is_owner`, whatever org the context holds.

  The completeness test walks every registered route and the static
  mounts. An unclassified route fails the suite, so a new route cannot
  ship unclassified.
- **What the audit records.** The table says it per route; nothing is
  implied.
  - **The actor** is the user row's stable `login`: the username, or
    `<issuerKey>#<sub>`. That replaces today's `session.email ||
    session.sub`, an unverified claim under OIDC, in the audit and in
    `deploys.jsonl`. The bearer keeps its label and the open posture keeps
    `local`. Email goes in `detail`, for display only.
  - **A store change and its audit rows commit in the same `tx()`.** For
    example, `packs.register()` writes the `packs` rows together with
    their `pack.register`, `pack.evict` and `pack.replace` rows.
    `DELETE /api/uploads` writes one `pack.clear` row.
  - **The `deploys.jsonl` routes** (deploy, `deploy-bulk`, rollback,
    verify) write their row **after** the append, in a transaction of their
    own. If that insert fails, the result stands (production was already
    written): the response carries `auditError`, and the server logs it
    loudly.
  - **Journey capture and run** from the studio write `journey.capture` /
    `journey.run`. CLI runs are not audited, because the CLI never opens
    the database.
  - **Joins made outside a route** write their rows with actor `system`:
    `user.jit` (`org_id NULL`), `membership.jit`, `owner.bootstrap`, and
    the first-local-user owner grant.
  - **Updates to `last_used_at`** are bookkeeping. They go through an
    audit-free `touch()`.

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
   - Operator: environments.
   - Admin: also members, MCP endpoints, the org's audit.
   - Owner: users, orgs, the join role, the deployment audit.
   - Viewer: read-only.
   - With no owner: the banner naming the way in.

   Services are written through Build and the service page (§6.1), not
   Settings.

   Every editor is a pop-up over one record, in the idiom of the Build SLI
   editor, with a status line that names what changed.
4. **The org switcher** appears only for a user who belongs to a second
   org.

Views follow [UI_CONVENTIONS.md](UI_CONVENTIONS.md):
- they import `studio/host.mjs`, never `app.mjs` (§1);
- loaders, pure `build*Model()` functions and renderers are separate
  exports, and models are tested under `node:test` (§2);
- renderers take `render(container, model, host)`. Services and Settings
  actions ride that argument as `host.services` / `host.settings`, built by
  the `app.mjs` controller, and `host.mjs` stays the four stable hooks
  (§3);
- the Services home extends the existing `.svc-*` zone, and Settings takes
  its own prefix (§4).

WCAG AA in both themes is a rule ([HANDOVER.md](HANDOVER.md) §2). The scan
in `tools/test-build-model.mjs` reads only `studio/app.css` after `==== The
axis`, and only rules whose `color:` uses its text tokens. The `.svc-*`
rules sit before that marker today. Slices 6a and 6b therefore extend the
scan to the zones they add or touch.

## 7 · Slices — each its own PR against `develop`, each green alone

| # | Slice | Ships | Suites ported · docs updated |
|---|---|---|---|
| 1 | **Store foundation** | `server/store/` (open, the version and filesystem checks, pragmas, `tx()`, the warning filter, migrations, schema v1, repositories with no callers yet); the `node:sqlite`, `BEGIN` and `SAVEPOINT` guard tests; `packc store backup` / `restore`; the SIGTERM close; the Node ≥ 22.16 floor with the CI floor leg and the generated journey workflow; the k8s store PVC, `fsGroup` and `strategy: Recreate`. No behaviour change. **First commit:** `tools/cli.mjs` stops calling `process.exit()` straight after a large `process.stdout.write`. On 22.22 under `node --test`, `packc journey run --all --json` loses its tail to the pipe: 146 KB are written, and `JSON.parse` fails at `tools/test-journey.mjs:1469` on clean `develop`. CI on 20 is green, and the move to 22 must not land on that failure | re-pins `tools/test-deploy-manifests.mjs` (§3); `tools/test-schedule-snippets.mjs` asserts the Node version. README (Node line, backup, restore, upgrade and rollback), `.github/copilot-instructions.md`, `.env.example` (`OBSERVOGRAM_DB`; `observogram.db` in the workspace list), `deploy/k8s/README.md`, `pvc-workspace.yaml` and `cronjob-journeys.yaml` comments (store volume; RWX only while the database is on RWO; zones), `tools/cli.mjs` usage |
| 2 | **Identity on the store** | the boot order (§4), with the split seed decision, its strict readers, stale-import guard and marker; the import of `users.json` and `orgs.json` (items 1–3) and its report; the `migrateFlatWorkspace()` fixes; users, orgs, memberships, owners; `auth.mjs`, `tenancy.mjs`, `user-admin` and `org-admin` over repositories, with validated `--role`; `resolveSession()` and `session_epoch` (pwflow included); the issuer key, OIDC just-in-time users, `oidc_join_role`, `OBSERVOGRAM_BOOTSTRAP_ADMIN`, `npm run users -- owner`; the org context in every posture; `orgWorkspaceRoot()` over `orgs.root`; `tenancyEnabled()` retired; per-org schedule snippets; journeys loaded only from the org root; `packc store export`, `restore`, `import --replace` (the request and the server-side replace), `rekey-issuer`, `purge-org`; the audit rows of everything this slice changes (the import, `import --replace`, `issuer.rekey`, `org.adopt`, `org.remove`, `user.jit`, `membership.jit`, `owner.bootstrap`, the first-local-user owner grant) | ports `server/test-auth-local.mjs`: fixtures are written before the first open or through repositories, and file-absence checks become row checks. Ports `test-tenancy.mjs`: the `:182` assert becomes a row check, and WS3 (a one-org `orgs.json` with only a bearer) now imports and boots token-only (§4 step 3), so it is rewritten to two orgs, which still refuse, and the CHANGELOG says so. Ports `test-auth-oidc.mjs`: on its empty workspace the import sets `oidc_join_role = operator`, so "API reads work with the OIDC session" holds; it adds a `OBSERVOGRAM_OIDC_JOIN_ROLE=none` user who gets the "ask an admin" 403, and the bootstrap cases. `test-smoke.mjs` keeps `AUTH=off` plus a token as token-only. Docs: README security posture, store export/import, `.env.example` (users file as import source only, tenancy no longer armed by `orgs.json`, `OBSERVOGRAM_BOOTSTRAP_ADMIN`, `OBSERVOGRAM_OIDC_JOIN_ROLE`), `deploy/k8s/README.md` and the `cronjob-journeys.yaml` tenancy comment with its `test-deploy-manifests.mjs` pin (one CronJob per org at `/workspace/<orgs.root>`), the PRODUCTIZATION_PLAN status lines |
| 3 | **Roles enforced** | the route table (class plus audit actions) and its middleware; the identity API it guards: owner routes for users (create, disable, reset password, sign out everywhere), orgs (create, remove, adopt) and `oidc_join_role`, admin routes for the org's name and memberships, and the `self` routes, with the CSRF and open-exposed rules of §5 and their audit rows; the authz matrix; the live pack per org, with `safeMcpUrl` | README (roles, the identity API); CHANGELOG (members mapped to `viewer` lose write power; the live pack moves); the PRODUCTIZATION_PLAN Stage 3 status |
| 4 | **Services, environments, MCP endpoints** | tables, role-gated CRUD API with their audit rows, `tools/lib/service-keys.mjs`; the one-shot pack import and backfill (boot step 5, import items 4–5), after which `packs` replaces `packs/index.json`; `import --replace` and export cover `index.json`; `pack_services` links on register; the conformance tier comes from the service record when one exists | ports `server/test-workspace.mjs` and the `index.json` assertions in `test-smoke.mjs`; the Import gate's pack fixtures; the API in README |
| 5 | **Audit** | every remaining audit row the route table names (the `deploys.jsonl` routes, journey capture and run, and any other existing route); the actor in `deploys.jsonl` becomes the `login`; `GET /api/audit` (filter by actor, kind, target, time; org-scoped for admins, deployment-wide for owners) | README (audit) |
| 6a | **Studio: services as the axis** | the Services home, the service page, Check and Build wired to the table, the org switcher | `docs/USER_JOURNEY.md`, `docs/BUILD_JOURNEY.md` (Build writes the service); the AA scan covers the `.svc-*` zone |
| 6b | **Studio: settings** | members, environments, MCP endpoints, users, orgs, the join role, audit | `docs/USER_JOURNEY.md`; the AA scan covers the Settings zone |

Each slice goes through the same pass:
1. an implementer;
2. two reviewers in parallel: one drives it as a user and tries to break
   it; the other checks conventions, accessibility, tests, commit hygiene,
   and docs against code;
3. a fixer that reproduces each finding first.

Each slice is driven live, in a browser or through the API with the exact
labels and numbers, before it is reported. Roughly two to three weeks end
to end: the boot order and the import (slice 2) are the heavy part.

## 8 · Quality gates

| Gate | Mechanism |
|---|---|
| Migrations | every migration applied from `user_version` 0 and from each prior version, on temp-file fixtures that hold child rows. A v2 step that rebuilds `users` under `memberships` keeps every child row. A failing step leaves `foreign_keys` back `ON`. Two openers racing the same step apply it once |
| Boot order | through `start()`, not only through the import function: a users.json `admin` with a real password, with and without `OBSERVOGRAM_ADMIN_PASSWORD`, on loopback and on 0.0.0.0, boots with exactly the imported users and no second `admin`; a still-seeded users.json plus a token on 0.0.0.0 refuses; a corrupt `users.json` or `orgs.json` aborts, names the path, and leaves `orgs.json` intact; a fresh workspace on 0.0.0.0 with only `OBSERVOGRAM_ADMIN_PASSWORD` boots with that `admin` as owner and `import_done` set; a still-seeded users.json on 0.0.0.0 with `OBSERVOGRAM_ADMIN_PASSWORD` and no token boots with the replaced password and `must_change` cleared, and the same with a token refuses with nothing moved; a store initialised by `npm run users -- add` boots on 0.0.0.0 with no token; after `import_done`, a store seeded `admin`/`admin` on loopback and rebooted on 0.0.0.0 with `OBSERVOGRAM_ADMIN_PASSWORD` and no token boots with the replaced password, and a token-only store rebooted on 0.0.0.0 with only `OBSERVOGRAM_ADMIN_PASSWORD` seeds `admin` as owner; `OBSERVOGRAM_AUTH=off` with OIDC env, or on a CLI-armed store, on 0.0.0.0 with no token and no `OBSERVOGRAM_INSECURE_NO_AUTH` refuses with nothing moved; a two-org `orgs.json` with no identity refuses with nothing moved and no `import_done`, and so does a one-org one whose flat data would add `default`, while a one-org `orgs.json` with only a bearer imports and boots token-only; an `orgs.json`-armed workspace whose flat data the migration moved boots a second time without refusing; from slice 4, an unreadable (non-ENOENT) `packs/index.json` aborts and names the path |
| Import | fixture workspaces, each asserted row by row with its report: flat stand-alone; `orgs.json`-armed with a not-yet-moved flat workspace (labels kept, from slice 4); a flat entry plus its `orgs/default/` twin (reported, nothing merged); an acme-only `orgs.json` plus the empty `default` artefact (dropped); OIDC with `orgs.json`; OIDC without it; a leftover `users.json` under OIDC (disabled, no owner); legacy `.tomograph/`; a corrupt `index.json` (slice 4: rows rebuilt from the pack files, labels null, path in the report); an empty `users.json` (armed, nothing seeded); unknown and messy role strings (`owner`, `Admin`, ` Viewer `, `editor`, `admn`, null, missing) |
| Stale import | deleting the database, or pointing `OBSERVOGRAM_DB` at a new path, with legacy files and a marker present: the boot refuses and imports nothing; then `packc store restore` of a backup succeeds and the next boot passes. A database moved with its id boots. A crash after commit repairs the marker. Export in place, then a pre-store build removes a user and changes a password, then re-upgrade: the boot refuses; after `import --replace` and a boot, the removed user is disabled, their old cookie is refused, the new password works, and the boot after that passes the guard. A replace requested from a shell with no OIDC env, on an OIDC deployment, maps members under the unit's issuer and disables no OIDC user. A flat OIDC round trip keeps every IdP user and the owner enabled; a flat stand-alone round trip keeps a viewer a viewer. With `OBSERVOGRAM_USERS_FILE` outside the workspace, an in-place export reaches the file a pre-store build reads; after the §3 overlay copy the boot passes the guard. A flat single-org store exported in place, then `npm run orgs -- create acme` on a pre-store build and a restart: the re-upgrade boot refuses, and after `import --replace` the default org's packs, deploys and journeys are found and `acme` exists. A foreign imported store with a replace request refuses and changes no rows. `purge-org` after slice 4, deleting `users.json` after the upgrade, and removing the recorded `users_file` each boot without refusing and change no rows. A replace requested after the issuer changed refuses at step 2 with nothing replaced, and after `rekey-issuer --to` it runs with no duplicate rows |
| CLI | a CLI run with a shell env refuses on a workspace with legacy files and imports nothing; on a fresh workspace `users -- add` initialises the store without `import_done`, and the new user is an owner; the server's later import keeps that row and reports any conflict |
| Export | a pre-store build boots on an exported workspace, and the same enabled users sign in and see the same packs; a flat deployment's export contains no `orgs.json`; a flat default org plus a created org exports `orgs.json`, and after the pre-store boot the default org's packs and journeys are found |
| OIDC upgrade | a pre-upgrade OIDC cookie reads `/api` on a workspace without `orgs.json`, as `operator`, and two IdP users who have never signed in do too; an `orgs.json` OIDC member keeps their role with a pre-upgrade cookie and after a fresh sign-in, with an env issuer with and without a trailing slash; a local username equal to an IdP sub does not capture the membership; an unverified email never matches `OBSERVOGRAM_BOOTSTRAP_ADMIN`; a user who signed in before it was set becomes owner at their next sign-in; once an owner exists, a further match grants nothing; each grant leaves one `owner.bootstrap` row; a stand-alone store switched to OIDC boots and records the key; an OIDC store booted with OIDC unset boots stand-alone and keeps the record; a changed issuer refuses to boot and names `rekey-issuer`; after `rekey-issuer --to`, the same IdP users keep their rows, roles and owner flag; after `--clear`, the old rows are disabled and the bootstrap names a new owner |
| Tenancy isolation | two orgs on one temp-file store: every repository and every `/api` route proves org B reads and writes nothing of org A's, the live pack and the journeys API included (a URL-encoded path to org A's journey from org B is a 404 with no run written); a context-scoped repository call or `orgWorkspaceRoot()` outside a context throws; default-org paths never read inside `orgs/`; creating an org over a non-empty leftover directory refuses; a removed org's slug cannot be reused. Only the static catalogue is listed as deployment-global, read-only |
| AuthZ matrix | table-driven: every route × {anonymous, viewer, operator, admin, owner, bearer} × {open loopback, open exposed, token-only, identity} → the expected status; an unclassified route or static mount fails the suite; an org admin cannot act on a user or an org outside their own; an owner with no membership reaches owner routes and lands in the default org; public routes answer anonymously in the identity posture; `OBSERVOGRAM_AUTH=off` plus `OBSERVOGRAM_INSECURE_NO_AUTH=1` on 0.0.0.0 gets the open-exposed row; the forced change of the first `admin`/`admin` boot works through the pwflow cookie alone |
| Revocation | a disabled user's cookie and a changed password's old cookie are refused on the next request, on `/api` **and** on `/auth/me` and the change-password routes; a pwflow cookie from before a change or a disable is refused; a disabled user cannot sign in; pre-upgrade cookies stay valid |
| Arming | on an exposed, token-less server, removing the last local user through the API and through the CLI leaves the next `/api` request at 401 or 409, never 200 |
| Audit | UPDATE, DELETE, UPSERT, `REPLACE` and `INSERT OR REPLACE` on `audit` abort and leave the rows unchanged, including on a connection opened without `recursive_triggers`; a plain insert passes; each successful route writes exactly the rows its table entry names, with the row's `login` as the actor; refused routes write none |
| Concurrency | on a temp-file database, a child process holds `BEGIN IMMEDIATE` for less than `busy_timeout` while a repository write and a migration run: both succeed. A `tx(fn)` whose `fn` returns a promise throws and rolls back |
| Local-mode behaviour | `OBSERVOGRAM_AUTH=off` and a fresh first boot (`admin`/`admin`) keep today's externally visible behaviour: HTTP statuses, the login and forced-change flow, the open posture, a flat workspace with one org. Token-only, including `AUTH=off` plus a token, keeps anonymous GET 200 and anonymous mutation 401 with `WWW-Authenticate: Bearer` |
| Journey engine | `packc journey run` and the Neuron open no database; the CronJob path runs with the database file absent; a default-org CronJob keeps its root across org creation; a schedule snippet generated in a non-default org targets that org's root |
| Runtime | `db.mjs` refuses Node 20 and 22.13 with its one line; refuses a database on NFS; switches a restored rollback-journal file back to WAL; binding a boolean or `?NNN` in a repository fails a guard test |

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
   with a second org. (Ratified with a one-time layout flip; see 9b.2 and
   9b.8.)
6. **Service tier vs pack tier:** the service's criticality sets the
   default rubric, and a mismatch with the pack is shown, not blocked.
   (See 9b.6 for which pack field that is.)
7. **Branches:** `codex/<topic>` from `origin/develop`, per
   [BRANCHING.md](BRANCHING.md).

## 9b · Refinements from checking the plan against the code

1. **The floor is ≥ 22.16, not 22.13**, enforced in `db.mjs` as well, and
   CI gains a leg pinned to the floor. The known `node:sqlite` defects
   fixed in 22.16 are exactly the ones a store would hit, and CI's `'22'`
   would never exercise the floor otherwise.
2. **No runtime layout flip.**
   - *As ratified:* the flat workspace moved to `orgs/default/` when the
     second org was created, behind a write barrier.
   - *Why not:* the move silently strands the journeys CronJob (pinned
     to the flat root, `run --all` then exits 0 with "no journeys
     saved"). Runs that straddle the rename recreate the flat root, and
     `GET`s and debounced flushes write to it too.
   - *Instead:* each org's `root` is fixed at creation. The default org
     stays at `.` and new orgs go to `orgs/<id>`. No data moves at runtime
     after the import; the only moves are the offline ones an in-place
     export or an `import --replace` makes around a downgrade.
3. **A deployment-level owner, separate from org admin.** Without it, an
   admin of org A could disable or re-password a user who also belongs to
   org B, create orgs and read deployment events.
4. **`deploys.jsonl` stays the deploy file of record.** The journey engine
   reads it. The database gets an audit row per append instead of a
   `deploys` table.
5. **OIDC keeps today's access, and the first owner is named.**
   - No file holds OIDC users today. So an upgraded OIDC deployment with no
     `orgs.json` keeps every IdP user's access through `oidc_join_role =
     operator`, with no freshness test.
   - `orgs.json` OIDC members are imported under one canonical issuer key
     built from the configured issuer.
   - The first owner is named through `OBSERVOGRAM_BOOTSTRAP_ADMIN`
     (verified email or sub) or the CLI, never "the first to sign in".
6. **Tier means `bindings.criticality`**, with the per-environment
   override mirrored on `environments.tier`, and it becomes the grading
   tier where a service row exists. Packs have no `minTier`; that is a
   library and clause field.
7. **Storage and operations.**
   - On k8s, the base gets one RWO volume holding the database and the
     workspace, plus `fsGroup` and `strategy: Recreate`.
   - Live backups are `packc store backup` (`VACUUM INTO`); a directory
     copy is safe only with nothing holding the database.
   - A stale-import guard and `import --replace` make the upgrade and the
     rollback explicit.
8. **The default org is not always `default`.** An imported `orgs.json`
   without a real one keeps its first org as the default (today's bearer
   fallback). The switcher appears for a user in more than one org, not
   when the deployment has a second org.
9. **The live pack moves per org.** It was one deployment-wide file that
   any operator could overwrite for every org, built from an unsanitised
   URL.

## 10 · Risks

- **`node:sqlite` is experimental on 22.x.**
  - Its surface has changed within 22.x: `run()` resets the statement
    (22.16), and `?NNN` parameters are handled as positional (22.20).
  - The floor leg, the latest-22 leg and the binding rules in §1 cover
    that class of change.
  - The repository layer is the only caller, so an API change is one
    module's problem.
  - Node 24 is untested here. It gets its own CI leg before anyone relies
    on it.
- **Behaviour changes for existing deployments,** named in the CHANGELOG:
  - Roles recorded in `orgs.json` are enforced from slice 3. `member` and
    unknown roles map to `operator`, so nobody loses today's powers
    except members whose role maps to `viewer`.
  - OIDC deployments without `orgs.json` get `oidc_join_role = operator`,
    and the CHANGELOG says how an owner turns it off.
  - A one-org `orgs.json` with only a bearer token now imports and boots
    token-only instead of refusing. Two or more orgs without identity
    still refuse.
  - The live pack becomes per org.
- **The upgrade boot is the one irreversible step.** The boot order, the
  strict readers, the stale-import guard and the boot-level gates exist
  because every one of them was a way to lose users or lock them out.
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
