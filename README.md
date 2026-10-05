# Observogram

*(formerly **Tomograph** — pre-rebrand env vars, headers, workspaces, and pack annotations keep working; see docs/CHANGELOG.md.)*

**Observogram is the observability compiler and diagnostic workspace for
ObservabilityPack spec v1.4.**

It answers one operational question:

> Is this service's observability diagnostic-grade?

Observogram checks that in two parts:

1. **Coverage** - are we observing the right signals for the service's
   observability goals and OLA?
2. **Trust** - do the declared signals, rules, dashboards, alerts, and response
   paths match what is active in production?

The workflow is intentionally simple:

```text
Discover -> Diagnose -> Remediate
```

Use a repo scan, a live MCP scan, or an uploaded pack to create an
ObservabilityPack. Compare the declared repo posture with the live production
posture. Then compile and deploy the delta through the platform tools.

In Observogram, the OLA is represented as an observability contract inside the
pack: criticality, SLOs, SLIs, telemetry bindings, rules, dashboards, alerts,
runbooks, and validation expectations. A repo-derived pack captures what the
service declares. A live MCP-derived pack captures what production verifies.
The gap between those two packs is the diagnostic finding.

The canonical specification lives at
[MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack).
A checksummed copy is vendored under
[`vendor/observability-pack-spec/v1.4/`](vendor/observability-pack-spec/v1.4/).

## Why It Exists

Most observability failures are not caused by a missing chart. They come from
drift:

- the repo declares an SLO, but the recording rule is not in production
- Grafana has dashboards that no pack owns
- alerts still exist, but their thresholds no longer match the SLO
- live telemetry exists, but no OLA or runbook says why it matters
- the team cannot explain whether the service is truly diagnosable

Observogram treats observability as a compiled contract. The pack is the source
of truth. Native artifacts are generated from it. Live systems are scanned back
into pack shape. The diff between declared and live is the operational truth.

## Main Journey

The first decision is about the pack, because a service may already exist without
one. Both landings open with **"What would you like to do?"** — *check an existing
service or pack* (select a service, or import one: upload, repo scan, live MCP draft)
or *build a new pack* (Define · Compile · Verify). The two paths join at *Pack
available in Discover*: a compiled pack enters the same audit journey as an imported
one, with its unresolved placeholders still visible.

### No pack yet? Build one

A second, parallel journey for a service that has no pack: **Build** — three
steps in the same visual language as the three below, reached from the home
hero, the service gate or the upload popover ("Build from the library…"), and
ending where Discover begins ([`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md)).
**The pack is the axis** of the screen on every step: a sticky **definition
column** on the left — the service, the tier as a segmented control (each
segment with its MUST · SHOULD counts), the library entries as chips, the
conformance summary (pass · on a placeholder · fail, the failing clauses,
todos and placeholders left) — and, as the main surface, **the layer stack of
the pack being compiled** — L1 SLI/SLO · L2 Metrics/Logs/Traces · L3 Dashboards/Recording
Rules · L4 Alerts/Policy/Self-healing (policy · alerting · self-healing) · L5 Self-check · GOV — drawn through the
same adapter and the same artefact cards Discover uses, so what you build is
exactly what Discover shows afterwards. Each slab's edge carries the rubric's
verdict for that layer (green pass, amber pass on a placeholder, red fail —
naming the clause), a placeholder artefact is *Scaffold*, and a clause the tier
still needs is a ghost card on its slab. **Click a layer and its sheet opens**
over the stack with the layer's question, its clauses at the tier and what you
can add on that layer: the SLI rolodex and the SLOs switch on L1 (*What should
we measure?*), the scrape jobs, backends and endpoints on L2 (*Where does the
telemetry flow?*), the Dashboards switch and the boards on L3 (*How do we see
it?*), the burn policy, the routes with their channels and the remediation on
L4 (*What happens when it breaks?*), the probes and chaos experiments on L5
(*How do we prove it?*), the owners and imports on GOV (*Who owns it?*):

1. **Define - What Are We Building For?** — four short substeps: **Service**
   (name, owners, environment), **Criticality** (each tier a card that says what
   it requires — *Tier 2: availability and latency objectives; metrics, logs
   and traces; burn-rate alerts; …*), **Technology** (library entries: products
   it runs on — Kafka, Prometheus, Grafana, IBM MQ, Alertmanager, Loki, Tempo,
   the OTel Collector — or an archetype for a service built from scratch; each
   card says *Adds N suggested SLIs* and previews them) and **Review
   suggestions** (the SLIs grouped by technology, *Select recommended*, one
   checkbox each, *Edit* opening the SLI editor). **The tier is a seed, not a
   constraint**: it decides which SLIs the pack starts with and which rubric
   grades it, never which SLIs you may add. The rubric clauses and the layer
   mechanics sit in *Why these suggestions?* and *Advanced review*; the left
   column is a sticky progress summary with the conformance summary beneath it.
   **Seed the pack →** confirms the definition once; on the next steps the
   column becomes a read-only seed card with *Change seed →*.
2. **Compile - What Did the Pack Produce?** — leads with the result (*Pack
   compiled. Two warnings need review; 19 values remain placeholders.*), three
   separate states (generated · complete for this tier · ready to deploy) and a
   *Needs review* queue (warning → impacted artefact → suggested correction →
   *Review*). A layer overview counts the artefacts by type and purpose; select
   a layer to draw its slab of the **live stack** and open its sheet, where
   composition happens: on L1 the **SLI rolodex** (any SLI of the selected
   entries is addable with *Include in this pack*; one above the tier says which
   profile it starts from), section switches on L3, L4 and L5 that say which
   clauses they drop, the params on the layer they shape. **The library's values
   are copies, not links**: the **SLI editor** opens on a sentence in real units
   (*Queue depth headroom is healthy when its ratio is at or below 0.8; target
   99.9% of the time over 30 days.*), groups Behavior · Objective · Data source ·
   Generated outputs, folds the PromQL under *Advanced*, checks direction, bound,
   unit, objective and window as you type, and ends on **Save SLI**; an edited
   expression drops the library's evidence to *custom*, honestly. *Changes since
   Define* says which selection produced which artefacts.
3. **Verify - What Is Ready, and What Remains?** — four readiness states shown
   apart — **schema valid**, **meets tier rubric**, **implementation**,
   **deployment ready** — under one verdict (*Ready for team completion; not
   ready for deployment.*): meeting the rubric never masks placeholders, and
   deployment is ready only when nothing fails, no value or runbook is left, no
   clause rests on a placeholder and every warning is reviewed. The smallest
   list of what remains follows — warnings, clauses whose requirement is
   represented but still needs a real value, values to fill by layer, work
   outside the studio — each with *Fix now* and, for a non-blocking warning,
   *Accept with reason* (this session only, never written into the pack); the
   stack again with the **todos pinned to the slab of the artefact each names**
   and the parameter that fills each one editable inline; the compiled
   artefacts previewed and downloadable. One primary action: fix what blocks,
   complete required values, or **Open pack in Discover** (*with visible gaps*
   when some remain), which registers the pack the way an upload is registered
   and hands it to the journey below as the same kind of pack you inspect there.

### 1. Discover - What Do We Have?

Create or load a pack:

- scan a service repository
- generate a live pack from an OpenTelemetry MCP server
- upload a canonical YAML or JSON ObservabilityPack

The Discover view renders the observability Observogram across the layered model:

- L1 SLI/SLO (the spec's *Contract*): SLIs and SLOs
- L2 Metrics/Logs/Traces (*Telemetry*): OTel, backends, collectors, pipelines
- L3 Dashboards/Recording Rules (*Insight*): recording rules, dashboards, derived views
- L4 Alerts/Policy/Self-healing (*Action*): alerts, routes, remediations
- L5 Self-check (*Validation*): baselines, synthetics, chaos, release checks
- GOV Governance: ownership and governance metadata

The studio names each layer by what sits on it; the spec's own layer names stay
in a tooltip on the layer overview.

An open layer lists its artefacts in one of four views: **List** (the name and a
status mark), **Tiles** (the name with its kind, bound and status), **Cards** (the
earlier card grid: ID, source, name, bound, summary, type and tags) or **Details**
(the full row, the default). Selecting an artefact opens its full record in any of them.

![Observogram Discover view showing the layered observability inventory](docs/img/xray-discover.png)

### 2. Diagnose - How reliable is this pack?

Load the declared repo pack as **Pack A** and the live production pack as
**Pack B**. Observogram computes the Assessment (the diagnostic grade):

- **Score**: total criteria passed out of 7
- **Coverage**: four checks for "are we observing the right things?"
- **Trust**: three checks for "can we trust what the signals show?"
- **Operability**: one informational check (Actionable — runbooks linked),
  displayed but never scored
- **Verified**: whether a live MCP signal is present

The score maps onto a metrology-style **instrument grade** — the rating users
actually read; the full ladder renders on the grade card with the current rung
highlighted:

| Grade | Class | Score band |
|---|---|---|
| A++ | Calibration / Reference Grade | — (needs external reference benchmarking) |
| A+ | Laboratory / Research Grade | ≥ 95% |
| A | Diagnostic / Clinical Grade | > 85% (the audit bar) |
| B+ | Inspection Grade | ≥ 75% |
| B | Industrial Grade | ≥ 62.5% |
| C | Field Grade | ≥ 37.5% |
| D | Consumer Grade | < 37.5% |

The machine contract is unchanged: the audit **passes when the score is
greater than 85%** — i.e. exactly when the grade is A or better; the letter
and PASS/FAIL can never disagree. Failed criteria remain visible as evidence.
A pack can therefore pass the grade while still showing drift that belongs in
Remediate.

The checks are (grade schema 2):

| Area | Criteria | Scored |
|---|---|---|
| Coverage | Multi-modal, Correlated, Calibrated, Comprehensive | yes |
| Trust | Chaos-validated, Drift-free, Fresh | yes |
| Operability | Actionable | no — informational |

Runbooks measure response readiness of the overall solution, not diagnostic
capability — a perfectly diagnostic system tells you what is wrong even when
nobody wrote the response script. The runbook gap stays visible on the grade
card and in the posture matrix; it just no longer costs diagnostic credit.

The drift drill shows:

- aligned artifacts
- matched artifacts whose behavior drifted
- declared artifacts not confirmed live
- live-only shadow signals
- out-of-scope live inventory that belongs to the wider platform

Traceability shows requirement chains from SLO to SLI, metrics, recording
rules, exporters, scrape evidence, dashboards, alerts, and runbooks.

![Observogram Diagnose view showing Diagnostic Grade and live drift buckets](docs/img/xray-diagnose-drift.png)

### 3. Remediate - Resolve gaps

Observogram compiles the pack delta into native backend artifacts:

- Prometheus recording and alerting rules
- Grafana-managed rules
- Grafana dashboards
- OTel Collector pipelines
- Alertmanager routes

Deployable artifacts can be pushed through an MCP write target. Non-deployable
or inferred artifacts remain visible as manual follow-up, not silent production
changes.

![Observogram Remediate view showing the Pack A minus Pack B deploy delta](docs/img/xray-remediate.png)

## Quickstart

Requires **Node 22.16 or later** (`engines` in `package.json`). The studio
keeps users and orgs in an embedded store on Node's built-in `node:sqlite`
(services and environments follow), which is unflagged from 22.13; 22.16 is
the floor because it fixes a `StatementSync` use-after-free and the `run()`
statement reset that a store hits. CI runs the suites on 22.16.0 and on the
latest 22. See [docs/STORE_PLAN.md](docs/STORE_PLAN.md).

### Platforms

Linux is the reference platform: CI runs `npm test` on Ubuntu on Node 22.16.0
(the floor) and the latest 22. Windows (Node ≥ 22.16, PowerShell or cmd) is
intended to run the CLI, the server, the studio and the static bundle, and
`npm test` is expected to be green there except the explicit skips — every
one printed by `node --test` as `# SKIP win32: <reason>` (or `- SKIP win32:
<reason>` in a harness suite), never a silent pass — for facts Windows cannot
express: POSIX mode bits (`0600`/`0644`, `chmod 0000`), signal delivery
(`process.kill` ends a Windows process outright, so the store's SIGTERM/SIGINT
self-close cannot be exercised) and symlink creation (a privilege). *Expected,
not verified*: the skip set is predicted from code reading, no Windows run
exists yet, and the downstream's first `npm test` on Windows is the
acceptance. There are 15 win32-skip sites — `server/test-store.mjs` (8),
`server/test-store-ops.mjs` (4), `server/test-store-import.mjs` (2),
`tools/test-journey.mjs` (1) — 19 skipped tests once the loops unroll, so a
Windows run prints 19 `SKIP win32:` lines (18 `# SKIP win32:` from node:test,
one `- SKIP win32:` from `tools/test-journey.mjs`), plus the PID 1 namespace
test's `# SKIP unshare --pid is unavailable here` and the browser suites'
Playwright skips when `OBSERVOGRAM_PLAYWRIGHT` is unset. An elevated runner
(GitHub's `windows-latest`) can create symlinks, so it sees the 4 symlink
skips as tests it could run — fewer `SKIP win32:` lines there is the next
step, not a bug. `tools/test-platform.mjs` (`npm run test:platform`) keeps
this count and the reasons honest and proves the module-relative path
resolvers (`fileURLToPath`, never `URL.pathname`) on every platform. Every
suite names the platform only through `server/fixtures/platform.mjs`
(`isWin32`, `isLinux`, `PLATFORM`, `win32Skip(reason)`, `skipOnWin32(t,
reason)`). The checkout is LF everywhere (`.gitattributes`), so goldens and
`VENDOR-MANIFEST.json`'s hashes verify under any `core.autocrlf`. macOS is
not in CI; the POSIX suites run there.

```bash
git clone https://github.com/MoebiusX/Observogram.git
cd Observogram
npm install
npm run dev
```

Open `http://127.0.0.1:8000` and sign in with **admin / admin** — first
boot seeds this default user and asks for a password change at sign-in
(skippable for now; it asks again each sign-in until a real password
lands — or change it any time from the account menu, top right on every
screen, which also has **sign out my other sessions**). From
there it's a signed-in app: your packs, deploy audit and run history
belong to you. (`OBSERVOGRAM_AUTH=off` skips login entirely
for a throwaway open sandbox.)

### Security Posture

1. **Local (default).** The server binds to `127.0.0.1` and ships like
   Grafana: first boot seeds a default `admin` user (password `admin`,
   change asked at every sign-in until it lands — skippable per
   session). The default credential is
   loopback-only — the server refuses to bind beyond loopback until it
   is changed; container/network first boots seed a real secret with
   `OBSERVOGRAM_ADMIN_PASSWORD` instead. `OBSERVOGRAM_AUTH=off` restores
   the pre-0.5 open mode: no login, a zero-friction local workspace.
2. **Exposed with a token.** Set `OBSERVOGRAM_API_TOKEN=<secret>` and bind
   wherever you need (`HOST=0.0.0.0`). Mutating `/api/*` routes (crawl,
   draft, validate-register, deploy, verify, reset) then require
   `Authorization: Bearer <secret>`; read routes stay open. Set
   `OBSERVOGRAM_API_TOKEN_LABEL=<team-or-owner>` to stamp `deploys.jsonl`
   and the audit ([The Audit](#the-audit)) with the token's ownership — the
   secret itself never lands in any log. The label must not be a user's
   login: the audit names the bearer by it (default `token`), and the
   identity API refuses a new user by that name. A token configured on a fresh workspace suppresses the
   default-admin seed: the token is the expressed auth intent.
3. **Exposed without any auth.** The server **refuses to start** with a
   clear message. `OBSERVOGRAM_INSECURE_NO_AUTH=1` overrides knowingly (it
   logs a loud warning) for trusted-network demos only.

Real users and SSO: `npm run users` manages locally-defined accounts,
`OBSERVOGRAM_OIDC_*` wires any OIDC provider, and `npm run orgs` manages
orgs; owners and org admins do the same over HTTP through
[the identity API](#the-identity-api) — see
[docs/PRODUCTIZATION_PLAN.md](docs/PRODUCTIZATION_PLAN.md) and
[docs/STORE_PLAN.md](docs/STORE_PLAN.md).

**Users, orgs and sessions live in the store.** Users, orgs, memberships
and the owner are rows in the embedded store (`observogram.db`, see
[Back Up And Restore The Store](#back-up-and-restore-the-store)); the
server opens it at every start.

- **The import.** The first start of a store build imports `users.json`
  and `orgs.json` once, prints a report on the boot log (`[store] …`
  lines) and leaves both files in place. They are hashed and never read
  again: from then on `npm run users` and `npm run orgs` write the store,
  and `remove` disables a user instead of deleting it (the audit
  references it); `npm run users -- enable <login>` undoes it, with the
  user's memberships, owner flag and password as they were. A user still
  holding the seeded default password (`admin` / `admin`) is not enabled
  until `npm run users -- passwd <login>` sets a real one, and such a
  disabled row still refuses a start beyond loopback (the refusal names
  `npm run users -- passwd <login>`, run with the server stopped, as the way out). Names and fields the store cannot hold are dropped and
  listed in the report; they never refuse the start.
- **Edited legacy files refuse the start.** A store build refuses to start
  when `users.json` or `orgs.json` changed after the import (a pre-store
  build during a rollback, config management). The refusal prints the
  imported SHA-256 and names the ways out: put the file back exactly as it
  was imported, move it aside and make the change with `npm run users` /
  `npm run orgs`, or run `packc store import --replace` so the next start
  re-imports the files as they stand. Roll the image back only after
  `packc store export` in place, with the server stopped — see
  [Upgrade And Roll Back](#upgrade-and-roll-back) and
  [Stale Import](#stale-import).
- **Tenancy is always on, and roles are enforced per route** (see
  [Roles](#roles)). Every `/api` request runs in an org and the
  response echoes it in `X-Observogram-Org`. A flat workspace is the
  default org, at the workspace root; an org created with `npm run orgs --
  create <id>` gets `orgs/<id>/`, fixed at creation. The header ORG chip
  shows for a user in more than one org, or whose only org is not the
  default one.
- **Sessions are revocable.** A password change or a disable signs the
  user out everywhere (a per-user epoch in the store), and so does an
  owner's `POST /api/admin/users/<id>/signout`; a user's **sign out my
  other sessions** ends every session but the one they click it in.
  Cookies issued before the upgrade stay valid.
- **Stand-alone sign-in stays armed once armed.** The first local user
  arms it; removing users never reopens a server. Only
  `OBSERVOGRAM_AUTH=off` does.
- **`npm run users` follows the server's sign-in mode**: the one this
  shell's `OBSERVOGRAM_OIDC_ISSUER` names, else the one the server's last
  start recorded. After an OIDC start, a local user added from a plain shell
  (a `docker exec`, a `sudo` shell) is not made owner, and `users -- remove`
  keeps the last owner who signs in through that issuer; once the server
  has started without OIDC, local owners count instead.
- **OIDC users** are recorded as `<issuerKey>#<sub>`. Name the first owner
  with `OBSERVOGRAM_BOOTSTRAP_ADMIN` (the `<issuer>#<sub>` form, or an email
  that counts only when the ID token says `email_verified: true`) or with
  `npm run users -- owner <login>`. An OIDC deployment without `orgs.json`
  keeps every IdP user's access (`oidc_join_role = operator`: each new
  user joins the default org as an operator); set
  `OBSERVOGRAM_OIDC_JOIN_ROLE=none` before the first start to keep it
  closed. A start whose `OBSERVOGRAM_OIDC_ISSUER` names another issuer key
  than the recorded one refuses; see
  [Move The OIDC Issuer](#move-the-oidc-issuer).
- **One org without identity.** A one-org `orgs.json` with only a bearer
  (`OBSERVOGRAM_API_TOKEN`) boots token-only; with neither a bearer nor
  identity it boots like a fresh install (on loopback it seeds
  `admin`/`admin`). More than one org needs identity.
- **Journeys run from the studio** load by name only, and a journey's
  `crawl:` roots, `file:` packs and inventory site are read only from the
  org's own part of the workspace (or outside it); a path inside another
  org's part is refused.

#### Behind a reverse proxy (trusted headers)

An enterprise deployment that terminates SSO at a reverse proxy can have the
server trust the identity the proxy forwards, instead of running OIDC or
local users itself ([`server/auth-proxy.mjs`](server/auth-proxy.mjs); the
auth seam of [docs/DOWNSTREAM.md](docs/DOWNSTREAM.md)). Opt-in, and off
unless `OBSERVOGRAM_TRUST_PROXY_AUTH=1`: without it no header is read, in
any posture.

```bash
OBSERVOGRAM_TRUST_PROXY_AUTH=1
OBSERVOGRAM_TRUST_PROXY_AUTH_ACK=only-the-proxy-reaches-this-port
OBSERVOGRAM_PROXY_AUTH_USER_HEADER=X-Forwarded-User        # default; required on every request
OBSERVOGRAM_PROXY_AUTH_EMAIL_HEADER=X-Forwarded-Email      # default
OBSERVOGRAM_PROXY_AUTH_NAME_HEADER=                        # unset by default
OBSERVOGRAM_PROXY_AUTH_GROUPS_HEADER=X-Forwarded-Groups    # unset by default; a comma list
OBSERVOGRAM_PROXY_AUTH_GROUP_ROLES='sre=admin,dev=operator,*=viewer'
OBSERVOGRAM_PROXY_AUTH_ORG=                                # the org the groups rule; default the default org
OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE=none                      # first-sight role when no groups header is configured (refused beside one)
OBSERVOGRAM_PROXY_AUTH_OWNERS=root                         # comma list of user values granted owner
OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET=<32+ chars>           # required beyond loopback
OBSERVOGRAM_PROXY_AUTH_SECRET_HEADER=X-Proxy-Auth-Secret   # default
OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL=https://sso.example.com/logout
OBSERVOGRAM_PROXY_AUTH_REALM=proxy                         # default; [a-z0-9._-]{1,64}
```

- **The rule.** The proxy MUST be the only route to this port, and MUST
  strip the user, email, name, groups and secret headers from every client
  request before adding its own — a client that can set `X-Forwarded-User`
  is anyone. The server cannot verify that, so it refuses to start until
  the operator says so in words: `OBSERVOGRAM_TRUST_PROXY_AUTH_ACK` must be
  the sentence `only-the-proxy-reaches-this-port` (not `1`). The refusal:
  `OBSERVOGRAM_TRUST_PROXY_AUTH=1 trusts identity headers from a reverse
  proxy, which is safe only when clients cannot reach this port — set
  OBSERVOGRAM_TRUST_PROXY_AUTH_ACK=only-the-proxy-reaches-this-port once the
  proxy strips X-Forwarded-User, X-Forwarded-Email[, <groups header>] from
  every client request, or unset OBSERVOGRAM_TRUST_PROXY_AUTH`.
- **Loopback, or a shared secret.** Bind to loopback next to the proxy, or
  set `OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET` (32 characters or more) and have
  the proxy send it in `X-Proxy-Auth-Secret`: a request without the right
  secret is anonymous. A bind beyond loopback without it refuses to start
  (`refusing to bind to <host> with OBSERVOGRAM_TRUST_PROXY_AUTH=1 and no
  OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: beyond loopback any client could set
  X-Forwarded-User. Set the shared secret (the proxy sends it in
  X-Proxy-Auth-Secret), or bind to loopback (HOST=127.0.0.1) next to the
  proxy`); on loopback without it the boot warns once that every process
  reaching the port is trusted as the proxy. The secret is compared in
  constant time and never printed or recorded.
- **One sign-in mode per server.** `OBSERVOGRAM_OIDC_ISSUER` set beside the
  flag refuses to start (`… are both set: one sign-in mode per server —
  unset one`); `OBSERVOGRAM_AUTH=off` wins over the flag (one warn line,
  headers not read). Local users are not consulted while the mode is on.
- **No cookie, no login page.** The headers are the session: every request
  resolves them against the store, once, in one transaction. `GET
  /auth/login` answers 401 and says so; the studio's **sign out** goes to
  `OBSERVOGRAM_PROXY_AUTH_LOGOUT_URL` when set (the proxy's session outlives
  this app's) and otherwise says it signed out of this app only; **sign out
  my other sessions** is not offered. The headers are ambient like a
  cookie, so a session mutation still needs `X-Observogram-CSRF: 1`.
- **Rows and roles.** Users are recorded as `proxy://<realm>#<user>`, kind
  `oidc`, under the key `proxy://<realm>` — `npm run users -- owner
  proxy://proxy#alice`, `remove`, `enable` and the identity API name them
  that way, whatever OIDC issuer the store recorded (a store that recorded
  one keeps refusing bare logins from a plain shell, as before). The email
  the proxy sends is recorded as verified. With a groups header configured,
  the groups are **authoritative in `OBSERVOGRAM_PROXY_AUTH_ORG`** (default
  the default org) and nowhere else: on every request that carries the
  header the membership there is added, raised, lowered or removed to match
  (`membership.jit` / `membership.role` / `membership.remove` rows, actor
  `system`, `via: proxy-groups`; an admin's manual edit in that org is
  overwritten by the next request); a request without the header leaves
  memberships alone; `*` is every user the header names. Without a groups
  header, `OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE` applies at the first sight
  only; beside a groups header it refuses the start (`… are both set: with
  a groups header the groups rule every membership …`), since it would
  otherwise apply whenever the proxy omits the header. A user in `OBSERVOGRAM_PROXY_AUTH_OWNERS`, or in a group mapped to
  `owner`, is granted owner once (`owner.grant`, `via: proxy`) and **never
  revoked here** — revoke with `PUT /api/admin/users/:id/owner`. A disabled
  row is refused and never re-enabled by a request; a local row holding the
  login is refused.
- **Refused requests are anonymous (401), and write nothing**: a duplicated
  identity header line, a value over 2000 characters or holding a control
  character, an empty user header, a missing or wrong secret.
- **`packc store rekey-issuer --clear` disables `proxy://` rows too**: they
  are kind `oidc`, and `--clear` disables every enabled OIDC row. `--to`
  rewrites one issuer's prefix and leaves them alone.

#### Roles

Who may call what is decided per route, by one table:
[`server/route-table.mjs`](server/route-table.mjs) classifies every route
the server registers, and each route's first handler is its guard.

| Role | May |
|---|---|
| `viewer` | every read (`GET`) in the org |
| `operator` | every existing write in the org as well: scan, draft, register, instantiate and compile, deploy, verify and roll back, retrofeed, journeys, the live refresh, RESET, and the org's services and environments ([Services, Environments And MCP Endpoints](#services-environments-and-mcp-endpoints)) |
| `admin` | the org's name, members and MCP endpoints as well ([the identity API](#the-identity-api), [Services, Environments And MCP Endpoints](#services-environments-and-mcp-endpoints)), and the org's audit (`GET /api/audit`, [The Audit](#the-audit)) |
| owner | a deployment-level flag, not an org role: an owner acts as `admin` in every org, plus users, orgs and the join role ([the identity API](#the-identity-api)) and the deployment's audit (`GET /api/audit?scope=all`) |

The role is the membership **of the request's org** (`X-Observogram-Org`,
`?org=`). `orgs.json` roles are mapped on import: `admin` / `owner` →
`admin`, `viewer` / `read` / `readonly` / `read-only` → `viewer`,
anything else (`member`, empty) → `operator`. Per posture:

- **Signed in** (local users, OIDC or a reverse proxy): the user's role in the org; an owner
  is an admin everywhere. The bearer (`OBSERVOGRAM_API_TOKEN`) acts as an
  `operator` of its `X-Observogram-Org` (else the default org), never as an
  admin or owner.
- **Token-only** (a token, no sign-in): anonymous callers are viewers
  (their writes answer 401); the bearer is an operator.
- **Open** (`OBSERVOGRAM_AUTH=off`, or `OBSERVOGRAM_INSECURE_NO_AUTH=1`
  beyond loopback): the caller is `local`, an owner — every route, as
  before, but the identity API: on a loopback server it answers only a
  request sent straight to it, and beyond loopback it is closed (see
  [The Identity API](#the-identity-api)).

Every authorization refusal carries `denied` — `auth` (401: sign in),
`csrf`, `org` (not a member of that org), `role` or `posture` — and a
sentence that names the way out, e.g. `requires the operator role in org
'acme' (you are viewer) — ask an admin of acme`; the studio shows it as
is. `GET /api/orgs` and `/auth/me`'s `orgs` give each org's `role` (the
membership's) and `effectiveRole` (the one the guard applies). A form
post to `/auth/login` or `/auth/change-password` that the browser marks as
coming from another site, or a sibling subdomain
(`Sec-Fetch-Site: cross-site | same-site`), is refused. An identity
change — every identity-API request but a `GET`, and
`POST /auth/signout-others` — needs `X-Observogram-CSRF: 1` in every
posture, the open ones included, so a cross-site form cannot make one (the
bearer, which a cross-site page cannot send, never reaches one); so does
every change to the org's MCP endpoint records (`/api/mcp-endpoints`), where
the server will send a read token of the org.
Authorization is decided when a request reaches its route: a request
already running when its user is disabled or demoted finishes; the user's
next one is refused.

**What a viewer can no longer do in the studio** (each answers with the
server's text): Scan (a repo or GitHub), Draft from MCP and the MCP
panel's live refresh, dropping or uploading a pack file (even only to view
it: the upload registers it), Build (its preview computes on the server,
and Save registers), Compare's retrofeed, journey Capture and Run, Deploy /
Verify / Rollback, and RESET. Give such a member `operator` with
`npm run orgs -- add-member <org> <login> --role operator`, or, as an
admin of the org, `PATCH /api/org/members/<id>` with `{"role": "operator"}`.

MCP write tokens are unrelated to the API token: they pass through per
request and are never stored server-side. Userinfo, the fragment and query
parameters named like credentials (`token`, `api_key`, `X-Amz-Signature`, …)
are never kept in the live pack or a draft; put a token in the auth field —
never in the URL's path. Registered packs (one `packs/<id>.pack.yaml`
each) and the deploy audit live in the `.observogram/` workspace
(`OBSERVOGRAM_WORKSPACE` relocates it); a pack's label, source, times and
the services it names are rows in the store (the `packs` and
`pack_services` tables). A `packs/index.json` left by a build before the
pack registry moved (0.5.0 and earlier) is read once, at the first start
of this build, then frozen in place: the server never writes it again and
only compares it at every start (see [Stale Import](#stale-import));
`packc store export` rewrites it from the rows for an older build (see
[Upgrade And Roll Back](#upgrade-and-roll-back)).

Two read routes answer without a session in every posture: `/healthz`
(probes) and `GET /api/version` — version, build, commit, branch, dirty,
date, shallow, source — which the studio footer reads before anyone signs
in. Neither carries a secret, but the second does tell an anonymous client
which branch a hosted studio runs and whether its tree was dirty; see
[Which Build Am I Running?](#which-build-am-i-running).

Useful local checks:

```bash
npm run lint:server
npm run lint:studio
npm run lint:crawler
npm run lint:fetcher
npm run test
```

### The Identity API

Owners and org admins manage users, orgs and memberships over HTTP with
the rules `npm run users` and `npm run orgs` apply
([`server/identity-admin.mjs`](server/identity-admin.mjs)); every change
writes its audit rows with the caller's login as the actor (`local` on a
server without sign-in), except the owner grant the first local user gets
(`owner.first-local-user`), which keeps `system`, the store's automatic
actor. The owner routes (`/api/admin/…`) act on the
deployment, whatever org the request is in. The admin routes
(`/api/org…`) act on the request's org (`X-Observogram-Org`, `?org=`): no
path names an org, so an org admin never reaches another one; an owner is
an admin of every org it names. Paths name a user by its numeric `id`
(from `GET /api/admin/users`, or `userId` in a member list); logins and
emails go in the JSON body.

| Method | Path | Who | Body | What it does |
|---|---|---|---|---|
| `GET` | `/api/admin/users` | owner | — | every user, disabled ones too: `id`, `login`, `kind`, `name`, `email`, `emailVerified`, `owner`, `disabled`, `mustChange`, `seededDefault`, `createdAt`, `lastLoginAt`, `memberships` — never a password |
| `POST` | `/api/admin/users` | owner | `{ login, password, name?, email?, role?, orgId? }` | a local user (201) with that password (at least 8 characters), a member of `orgId` (needed when the deployment has more than one org) at `role` (default `operator`); the first local user while no enabled local owner exists becomes an owner, where local users can sign in |
| `POST` | `/api/admin/users/:id/disable` | owner | — | every session of the user ends; `you: true` when it was the caller |
| `POST` | `/api/admin/users/:id/enable` | owner | — | undoes a disable: memberships, owner flag and password as they were |
| `POST` | `/api/admin/users/:id/password` | owner | `{ password }` | a temporary password for a local user: every session ends, and the next sign-in must set a new one |
| `POST` | `/api/admin/users/:id/signout` | owner | — | sign out everywhere: every cookie of the user is refused from its next request; `you: true` when it was the caller |
| `PUT` | `/api/admin/users/:id/owner` | owner | `{ "owner": true \| false }` | grants or revokes owner |
| `GET` | `/api/admin/orgs` | owner | — | `defaultOrg` and every org, removed ones too, with its `members` count |
| `POST` | `/api/admin/orgs` | owner | `{ id, name?, adopt? }` | a new org at `orgs/<id>/` (201), the caller its first admin; `"adopt": true` takes over a non-empty directory; a slug is never reused |
| `DELETE` | `/api/admin/orgs/:id` | owner | — | a soft removal, never of the default org: the org is refused from its members' next request; its files stay (`packc store purge-org <id>`, with the server stopped) |
| `GET` | `/api/admin/join-role` | owner | — | the recorded join role (`viewer`, `operator`, `admin` or `null`), `oidc`, `issuerKey`, `mode` (`local`, `oidc` or `proxy`; behind a reverse proxy a `proxy` object says what rules first-sight roles there instead) |
| `PUT` | `/api/admin/join-role` | owner | `{ role, confirm? }` | the default-org role of every IdP user created from now on; `null` or `"none"`: no automatic join |
| `PATCH` | `/api/org` | admin | `{ name }` | renames the org (1–200 characters) |
| `GET` | `/api/org/members` | admin | — | the org and its members: `userId`, `login`, `kind`, `name`, `email`, `role`, `disabled`, `since` |
| `POST` | `/api/org/members` | admin | `{ login }` or `{ email }`, `role?` | adds an existing user (201) at `role` (default `operator`); a member already gets that role (200, `changed`) |
| `PATCH` | `/api/org/members/:userId` | admin | `{ role }` | changes a member's role |
| `DELETE` | `/api/org/members/:userId` | admin | — | removes a member |
| `POST` | `/auth/signout-others` | self | — | sign out my other sessions (below) |

Call it with a session cookie and `X-Observogram-CSRF: 1` on every change:

```bash
# Sign in as a local owner; the jar keeps the session cookie.
curl -s -c jar -H 'Accept: application/json' \
  --data-urlencode username=olive --data-urlencode 'password=<password>' \
  http://127.0.0.1:8000/auth/login
# Create a local user, an admin of acme (201).
curl -s -b jar -H 'X-Observogram-CSRF: 1' -H 'Content-Type: application/json' \
  -d '{"login":"ada","password":"<at least 8 characters>","orgId":"acme","role":"admin"}' \
  http://127.0.0.1:8000/api/admin/users
# Add an existing user to acme by the email their sign-in verified.
curl -s -b jar -H 'X-Observogram-CSRF: 1' -H 'X-Observogram-Org: acme' \
  -H 'Content-Type: application/json' -d '{"email":"bob@example.com","role":"viewer"}' \
  http://127.0.0.1:8000/api/org/members
```

A change without the header answers 403 `csrf`. The bearer
(`OBSERVOGRAM_API_TOKEN`) is an operator, so the identity API refuses it
(403 `role`). A 403 is always an authorization denial, with `denied`; a
rule's refusal is 400 (bad input), 404 (no such user, org or member) or
409 (the state forbids it), and names the way out. Each route's audit rows
are listed in [`server/route-table.mjs`](server/route-table.mjs); a refused
request writes none.

- **Adding a member.** `POST /api/org/members` adds an existing user — by
  exact `login`, or by `email`: the one enabled user whose sign-in
  verified that address (compared without case; only an IdP sign-in
  verifies one, so a local user is added by login). It never creates a
  user: an owner creates local users, and an IdP user can be added after
  their first sign-in. An IdP re-syncs the email at every sign-in, so an address
  names whoever holds it at the IdP now: confirm the match by the
  `member.login` the answer returns. To an org admin, no such user, a
  disabled one and several matches are one 404 (an admin cannot list the
  deployment's users); an owner gets the detail.
- **Sign out everywhere, and keeping someone out.** After
  `POST /api/admin/users/<id>/signout` an IdP user can sign in again at
  the IdP, perhaps without a prompt; to keep them out, disable them.
- **The temporary password.** `POST /api/admin/users/<id>/password` sets a
  password (at least 8 characters) the user must replace at their next
  sign-in — there is no skip — for a local user only (an IdP user has no
  password here: sign them out everywhere or disable them) and never on the
  caller's own account (change yours at `/auth/change-password`).
- **The last owner and the last admin.** The last enabled owner, and the
  last owner who can sign in under the server's sign-in mode (a local
  password, or its OIDC issuer), can be neither disabled nor demoted: 409,
  naming `PUT /api/admin/users/<id>/owner` with `{"owner": true}` for
  another user first. An org's last enabled admin can be demoted or
  removed only by an owner — through `PATCH` or `DELETE
  /api/org/members/<userId>`, or the role change of `POST
  /api/org/members`; from a shell, `npm run orgs -- add-member` and
  `remove-member` still can.
- **Revoking owner keeps the admin membership.** A grant makes the user an
  admin of the default org too (its `owner.grant` audit row records the
  role before, `from`); `{"owner": false}` touches no membership, and the
  answer's `memberships` and `note` say when the user is still that org's
  admin — change it with `PATCH /api/org/members/<id>` in the default org.
- **The join role.** `PUT /api/admin/join-role` with `{"role": "admin"}`
  answers 409 unless it carries `"confirm": true`: every user the IdP lets
  in would become an admin of the default org — to add admins one by one,
  use `POST /api/org/members` with `{"role": "admin"}`. The join role
  applies to IdP users created after the change and backfills nobody;
  `OBSERVOGRAM_OIDC_JOIN_ROLE` is still read at the first start only.
- **Reserved logins.** `system`, `cli`, `local` and `token` — the actors
  the audit log writes for the store, a shell, a server without sign-in
  and the bearer — are refused as a new local login, from the API and from
  `npm run users -- add`; the API also refuses the configured
  `OBSERVOGRAM_API_TOKEN_LABEL`.
- **Without sign-in** (the open postures, where the caller is `local`, an
  owner): on a loopback server the identity API answers only a request
  sent straight to it — `Host` `localhost`, `127.x.x.x` or `[::1]`, no
  `Forwarded`, `Via`, `X-Forwarded-*` or `X-Real-IP` header nor a
  client-IP header a CDN or a tunnel adds (`CF-Connecting-IP`,
  `True-Client-IP`, `X-Client-IP`, …), and an
  `Origin`, if any, naming that host — else 403 `posture`, naming the
  CLIs; a DNS-rebinding page or a proxy cannot plant an owner that outlives
  the posture. Beyond loopback (`OBSERVOGRAM_INSECURE_NO_AUTH=1`) it is
  closed (403 `posture`). A direct request to `POST /api/admin/orgs`
  answers 409 in both: a second org needs identity. With a token and no
  sign-in nobody is an owner or an admin, so the identity API refuses
  every caller; its 403 `role` names `npm run users -- add <login>`.

**Sign out my other sessions** — `POST /auth/signout-others`, the account
menu's item, in local and OIDC sign-in. It takes the caller's own session
cookie only (never the cookie of a pending forced password change, never
the bearer: 401) and `X-Observogram-CSRF: 1` (else 403 `csrf`). Every other
cookie of the user — another browser's, a script's — is refused from its
next request; this browser's is re-issued at the new session epoch and
keeps its expiry (signing out elsewhere never extends a session). It
answers `{ ok, sessionEpoch }` and writes one `user.signout` row, the user
its actor.

### Services, Environments And MCP Endpoints

A **service record** is the org's own entry for one service, in the store
since slice 4a: a `slug` (the key the catalogue files services under —
lowercase letters, digits and `-`, derived from the name; fixed once
created, because packs link to a service by slug), a `name`, `owners`, a
`tier` (`tier-1`, `tier-2`, `tier-3`, or `null`: graded by the pack) and a
`description`. A service has **environments** (`production`, `staging`, …),
each with its own optional `tier`, free-form string `bindings` (a cluster,
a namespace, a region), named `endpoints` (http(s) links — a dashboard, a
runbook) and, optionally, the **MCP endpoint** it is checked through. An
MCP endpoint record is the org's named MCP server — `name`, `url` and
`readTokenEnv`, the name of the environment variable the server reads the
read token from ([Fetch Live From MCP](#fetch-live-from-mcp)); the
record holds no secret. Packs link to services: registering a pack (a scan,
a draft, an upload, a library register) creates the service rows it names —
its primary service and its members; a live aggregate pack, a snapshot of a
whole MCP backend, has no primary and names every service it discovered —
with an environment per name the pack declares, and links the pack to each
(`role` `primary` or `member`). The rows the register creates carry no tier
(`null`): a person sets one. A service deleted over the API stays deleted
across restarts and rehydrates (its environments and pack links go with it;
the packs stay registered); registering a pack that names it re-creates it,
by that caller (`service.create { via: 'register', pack }`). The rules live
once in [`server/service-admin.mjs`](server/service-admin.mjs), a sibling
of `identity-admin.mjs`, and every change writes its audit rows with the
caller as the actor.

Operators manage services and environments; admins manage the MCP endpoint
records; every member reads all three. The org is the request's
(`X-Observogram-Org`, `?org=`): no path names an org, and an id of another
org is never found (404, or 400 for `mcpEndpointId`).

| Method | Path | Who | Body | What it does |
|---|---|---|---|---|
| `GET` | `/api/services` | viewer | — | `services`, by slug, each with `environments` (their `mcpEndpoint` as `{ id, name, origin }` or `null`) and `packs` (`id`, `label`, `source`, `role`) |
| `POST` | `/api/services` | operator | `{ name, slug?, owners?, tier?, description? }` | a service record (201); `slug` defaults to the name's key; `owners` at most 50 names; a slug in use is 409 naming its id |
| `GET` | `/api/services/:id` | viewer | — | one service record with its environments and packs; 404 `no service <id>` |
| `PATCH` | `/api/services/:id` | operator | any of `name`, `owners`, `tier`, `description` | `changed` lists the fields that differed (none: no audit row); `slug` in the body is 400 — the slug is fixed, create a new service instead |
| `DELETE` | `/api/services/:id` | operator | — | `deleted`, with the counts of `environments` and `packLinks` removed with it |
| `GET` | `/api/services/:id/environments` | viewer | — | `service` (`id`, `slug`, `name`, `tier`) and its `environments` |
| `POST` | `/api/services/:id/environments` | operator | `{ name, tier?, bindings?, endpoints?, mcpEndpointId? }` | an environment (201); `bindings` at most 32 string values of 1–256 characters, `endpoints` at most 20 http(s) URLs by name, `mcpEndpointId` one of the org's MCP endpoints; a name in use is 409 |
| `GET` | `/api/environments/:id` | viewer | — | `environment` and its `service` (`id`, `slug`, `name`, `tier`); `effectiveTier` is the environment's tier, else the service's |
| `PATCH` | `/api/environments/:id` | operator | any of `name`, `tier`, `bindings`, `endpoints`, `mcpEndpointId` | `changed`; `"mcpEndpointId": null` unbinds |
| `DELETE` | `/api/environments/:id` | operator | — | `deleted` |
| `GET` | `/api/mcp-endpoints` | viewer | — | `endpoints`, by name: `id`, `name`, `origin`, `environments` (how many are checked through it), `createdAt`; `url` and `readTokenEnv` to an operator and above, `null` to a viewer |
| `POST` | `/api/mcp-endpoints` | admin | `{ name, url, readTokenEnv? }` | an MCP endpoint record (201), the admin's own view with `url` and `readTokenEnv`; a name in use is 409 |
| `PATCH` | `/api/mcp-endpoints/:id` | admin | any of `name`, `url`, `readTokenEnv` | `changed`; `"readTokenEnv": null` clears it; 404 `no MCP endpoint <id>` |
| `DELETE` | `/api/mcp-endpoints/:id` | admin | — | `deleted` and `unbound`: the ids of the environments that were checked through it (they stay, with no MCP endpoint) |

Call them with a session cookie, the org header when the org is not your
default one, and `X-Observogram-CSRF: 1` on every change:

```bash
# Sign in; the jar keeps the session cookie.
curl -s -c jar -H 'Accept: application/json' \
  --data-urlencode username=ada --data-urlencode 'password=<password>' \
  http://127.0.0.1:8000/auth/login
# A tier-1 service in acme (201); the slug defaults to "checkout".
curl -s -b jar -H 'X-Observogram-CSRF: 1' -H 'X-Observogram-Org: acme' \
  -H 'Content-Type: application/json' \
  -d '{"name":"Checkout","owners":["payments"],"tier":"tier-1"}' \
  http://127.0.0.1:8000/api/services
# As an admin of acme: the org's MCP endpoint, its read token read from
# OBSERVOGRAM_ORG_ACME_MCP_TOKEN on the server (201).
curl -s -b jar -H 'X-Observogram-CSRF: 1' -H 'X-Observogram-Org: acme' \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod-otel","url":"https://otel-mcp.example.com/mcp","readTokenEnv":"OBSERVOGRAM_ORG_ACME_MCP_TOKEN"}' \
  http://127.0.0.1:8000/api/mcp-endpoints
# The service's production environment, checked through that endpoint (201).
curl -s -b jar -H 'X-Observogram-CSRF: 1' -H 'X-Observogram-Org: acme' \
  -H 'Content-Type: application/json' \
  -d '{"name":"production","bindings":{"cluster":"eu-1"},"endpoints":{"dashboard":"https://grafana.example.com/d/checkout"},"mcpEndpointId":1}' \
  http://127.0.0.1:8000/api/services/1/environments
```

A rule's refusal is 400 (bad input), 404 (no such service, environment or
endpoint) or 409 (a slug or name in use), and names the way out — `service
"checkout" exists (id 1) — PATCH /api/services/1 changes it`; a 403 is an
authorization denial, with `denied`. The three MCP endpoint changes take
the identity API's defences, because a record is where the server will
send the org's read token: `X-Observogram-CSRF: 1` in every posture (403
`csrf` — `missing X-Observogram-CSRF: 1 — changes to the MCP endpoint API need
it in every posture, so a cross-site form cannot make them (the studio
sends it; with curl add -H 'X-Observogram-CSRF: 1')`), only a request sent
straight to a loopback server without sign-in, and closed on an exposed
server without sign-in (403 `posture`, as [the identity
API](#the-identity-api) is). The bearer (`OBSERVOGRAM_API_TOKEN`) is an
operator: it manages services and environments and reads the endpoints
with their URLs, and never changes an endpoint.

- **The tier rule.** `GET /api/packs/:id/conformance` grades a registered
  pack at its service record's tier when one is set — the environment's for
  `?env=<name>` when that environment has one, else the service's; the
  pack's primary service is the record. `declaredTier` in the report is the
  tier it was graded at, so `scorePercent`, `mustPercent` and each clause's
  `applies` follow it; the report's `tier` object says where it came from:
  `{ graded, pack, from: 'environment' | 'service' | 'pack', service: { id,
  slug } | null, environment: { id, name } | null, mismatch }`. `tier.pack`
  is the pack's own `metadata.bindings.criticality` (`tier-3` when it
  declares none) and `tier.mismatch` says the record and the pack differ —
  shown, never blocked: fix the record or the pack. A pack with no record
  (a catalogue or example pack, a service whose rows carry no tier) is
  graded at its own tier, `from: 'pack'`.
- **An endpoint picked by id.** `POST /api/refresh-live` and
  `POST /api/draft-from-mcp` take `mcpEndpointId` in place of `mcpUrl`;
  the server uses the record's URL and, when the request sends no
  `mcpAuth`, reads the read token from the record's `readTokenEnv` at
  request time. The deploy and rollback routes take `mcpEndpointId` for the
  URL only: a write token stays the request's `mcpAuth`, never a record's.
  Sending both `mcpUrl` and `mcpEndpointId` is 400 (`send mcpUrl or
  mcpEndpointId, not both`); see [Fetch Live From MCP](#fetch-live-from-mcp).
- **The read-token variable.** `readTokenEnv` must be
  `OBSERVOGRAM_ORG_<ORG>_<NAME>` — `ORG` the org id in upper case with `-`
  as `_` (`acme` → `OBSERVOGRAM_ORG_ACME_`, `pay-eu` →
  `OBSERVOGRAM_ORG_PAY_EU_`), `NAME` of `[A-Z0-9_]+` — and must be **this
  org's**: the owning org of a name is the one whose prefix is the longest
  match among every org, so `OBSERVOGRAM_ORG_ACME_EU_TOKEN` is `acme-eu`'s,
  not `acme`'s. Why: without it an org admin — not an owner — could point
  an endpoint at a URL they control and have the server send any variable
  of its process there (`OBSERVOGRAM_SESSION_SECRET`,
  `OBSERVOGRAM_API_TOKEN`, a cloud credential). The rule runs at the write
  and again at each request that reads the variable (an org created later
  can become the owner of a stored name; the request is then refused naming
  `PATCH /api/mcp-endpoints/<id>`). Pick a `NAME` that is not another
  org's id followed by `_`. The variable is set on the server — the k8s
  studio Deployment's `env`, from a Secret; never on the journey CronJob
  ([`deploy/k8s/README.md`](deploy/k8s/README.md)) — and its value is never
  logged, returned or stored.
- **The MCP URL carries no credential.** `url` is refused with userinfo, a
  fragment, or a query parameter whose *name* looks like a credential
  (`token`, `api_key`, `sig`, …; `signal`, `design`, `author` pass — the
  word rule of `tools/lib/mcp-url-safety.mjs`): `observogram store: an MCP
  endpoint URL may not carry credentials in its query — the parameter(s)
  "token" look like credentials; remove them and name an env var in
  readTokenEnv`, naming the parameters and never the URL. An environment's
  `endpoints` follow the same rule (a token goes in no link).
- **What a viewer sees.** Every member reads the services, the environments
  with their `bindings` and `endpoints` in full (they are links a viewer
  opens — never put a token in one), and each environment's MCP endpoint as
  `{ id, name, origin }`. The MCP URL itself and the variable's name go to
  operators and above (`GET /api/mcp-endpoints`); the token's value to
  nobody.

### The Audit

Every change a principal makes through the server is one row in the store's
`audit` table ([docs/STORE_PLAN.md](docs/STORE_PLAN.md) §5): an action
`<kind>.<verb>` — who (`actor`), when (`at`), in which org (`orgId`; `null`
for a deployment-level change: a user, an org, an owner grant, a store
import), on what (`targetKind`, `targetId`) and a small, bounded `detail`
(it must serialize to at most 8192 characters; every free-text field is cut
to 200). The table is append-only — a trigger refuses every `UPDATE` and
`DELETE` (`audit is append-only`) — and no row carries a secret, an email,
or, in the deploy, journey and live rows, a URL beyond its origin. The route
table ([`server/route-table.mjs`](server/route-table.mjs)) says per route
which actions a successful call writes; nothing is implied, and a refused
request writes no row.

**The actor** is the principal's stable identifier: a user's `login` (a
local username, or `<issuerKey>#<sub>` for an OIDC user — never the email,
an unverified claim the IdP re-syncs), the bearer's label
(`OBSERVOGRAM_API_TOKEN_LABEL`, default `token`), `local` on a server
without sign-in; `system` for a join made outside a route (`user.jit`,
`membership.jit`, `owner.bootstrap`, `owner.first-local-user`) and `cli`
for `npm run users` / `npm run orgs`. **The same actor is stamped in
`deploys.jsonl`**: a new line names the login where it named the email (an
OIDC deployer who was `ada@acme.test` is `https://idp.example/realms/acme#9a3e0f`;
a local user with an email on her row is `ada`), so every viewer of
`GET /api/deploys` and of the Neuron evidence string sees logins. Old lines
keep their actor; the bearer's label and `local` are unchanged. Where a
display name is wanted, the `users` row has `email` and `name` by `login`
(`GET /api/admin/users` for owners, the member list for admins).

**What an org admin sees** (`GET /api/audit`): every row of their org,
whoever the actor — including an owner who acted in the org without being
a member, the bearer, `system`. An admin cannot list the deployment's
users; the audit does show them the login of every owner who ever changed
their org, because who changed your org is yours to know. A deployment row
(`orgId: null`) is an owner's only.

**The verdict rows** (GAP batch 2; [Record Verdicts](#record-verdicts))
are table rows like the services': written in the transaction of the
change, by the repository. `verdict.set` on target `artefact`
`<pack>/<artefact>` with `{ pack, artefact, family, from, to, reason }`
(`from` null for a first record; the reason cut to 200); `verdict.clear`
with `{ pack, artefact, from }`; `verdict.carry` on target `pack` (the new
pack id) with `{ from, kept, dropped, droppedCount }` when a re-upload under
the same label replaced a pack that held verdicts — written by the register
routes (`POST /api/validate`, `/api/crawl`, `/api/crawl-github`,
`/api/draft-from-mcp`, `/api/library/register`) between `pack.register` and
the link rows, and only then. A verdict cascades with its pack (an eviction,
`DELETE /api/uploads`, the rehydrate's prune) without a row of its own.

**The file-first rows.** The deploy routes, the journey capture and run,
and the live refresh change a file of the org's, not a table, so their row
is written after the file ([`server/audit-after.mjs`](server/audit-after.mjs)),
in a transaction of its own. `deploys.jsonl` stays the deploy file of
record, keyed by the `deployId` the row names: the row carries counts and
the MCP **origin**, never the URL, an item's error or a tool name.

| Route | Action | `targetId` | `detail` |
|---|---|---|---|
| `POST /api/packs/:id/deploy/:target` | `deploy.run` | the new `deployId` | `{ pack: { id, version }, env, target: { product, version, folder }, mode, dryRun, origin, mcpEndpoint: { id, name } \| null, items, ok, failed, tookMs }` — on a 502 too (`ok: 0, failed: 1`), as the file records it |
| `POST /api/packs/:id/deploy-bulk` | `deploy.bulk` | the `deployId` | the same, plus `snapshot` (the pre-deploy snapshot's status) |
| `POST /api/deploys/:deployId/rollback` | `deploy.rollback` | the rollback's own `deployId` | `{ rollbackOf, pack, env, dryRun, origin, mcpEndpoint, items, ok, failed, manual, tookMs }` |
| `POST /api/deploys/:deployId/verify` | `deploy.verify` | the verified `deployId` | `{ outcome, alignment, attempts }` (`outcome` cut to 100 characters; the summary and transitions stay in the line) |
| `POST /api/journeys/capture` | `journey.capture` | the journey name | `{ packA, packB, live, env, service, scopeMode }` — the two pack ids and whether Pack B was saved as a live `mcp:` source, never the paths or the MCP URL the file holds |
| `POST /api/journeys/:name/run` | `journey.run` | the journey name | `{ startedAt, outcome, alignmentPct, gradeScore, gradePass, breaches, tookMs }` — **one row per attempt past the 404**: a run that fails from the studio leaves a row with `outcome: "error"`, or `"vantage-lost"` when a live source lost its vantage (the engine wrote a run record and may have notified), the four record fields `null`; never the error's message |
| `POST /api/refresh-live` | `live.refresh` | the MCP origin | `{ mcpEndpoint, refreshedAt, servicesDiscovered, toolsFailed }` (counts) |

When one of the two writes fails: the operation stands. A row the store
refused (a blocked insert, a `detail` over 8192 characters) puts
`auditError` with the store's message on the response and one line on
stderr (`[deploy-bulk]   audit row failed: … (the operation stands;
deploy.bulk dep_… is not on the record)`); a line that could not be appended (disk
full, `deploys.jsonl` a directory) still gets its row, flagged
`detail.fileError: true`, so the record of a deploy never vanishes with the
file — the verify's 500 carries its flagged row the same way. A request
refused before the MCP was contacted (400, 404, 409, 412) writes neither;
a capture, run or refresh whose file write threw writes no row (nothing of
the org's changed), the run's `vantage-lost` path excepted. CLI runs
(`packc journey run`, the CronJob) are not audited: that CLI never opens the
database (`packc store audit`, below, opens it to read and is not a run).

**Reading it — `GET /api/audit`** (`admin`). An org admin reads the rows of
the request's org (`X-Observogram-Org`, `?org=`): `scope=org`, the only
scope an admin may ask for. An owner reads the deployment's: `scope=all`
(the default for an owner: every org's and the deployment's rows in one
sequence), `scope=org` (the request's org — the org selector picks it, as
everywhere; `?org=` is never a filter) or `scope=deployment` (the rows with
no org). An admin asking `scope=all` or `scope=deployment` is refused, 400:
`the deployment's audit (scope=deployment, scope=all) is an owner's: as an
admin of org 'acme' you read its rows (scope=org, the default) — drop scope,
or ask an owner`. The filters, each optional, ANDed: `actor` (exact — a
login, the bearer's label, `local`, `system`), `action` (`<kind>.<verb>`),
`kind` (every action of a kind: `deploy`, `pack`, `mcp_endpoint`, …),
`targetKind`, `targetId` (a `deployId`, a journey name, a pack id, a
login), `since` / `until` (`2026-10-04` or `2026-10-04T09:00:00Z`;
`at >= since`, `at < until`), `limit` (1–500, default 100). Rows come
newest first; `next` is the `seq` of the page's last row when another page
exists, else `null` — no more, never "try again"; send it back as
`before=` for the next page, with the same filters. Every refusal is a 400
whose text names the way out (`limit must be an integer from 1 to 500`,
`since must be a date or a UTC time: 2026-10-04 or 2026-10-04T09:00:00Z`,
`scope is org, deployment or all`); an empty value is "not given"; unknown
parameters are ignored. The response is `{ ok, scope, org, limit, rows,
next }` — `org` the request's org for `scope=org`, `null` otherwise — and
each row `{ seq, at, orgId, actor, action, targetKind, targetId, detail }`.

```bash
# an admin of acme: the org's deploy rows since a date, 50 a page
curl -sS -b cookies.txt -H 'X-Observogram-Org: acme' \
  'http://127.0.0.1:8000/api/audit?kind=deploy&since=2026-09-28&limit=50'
# the next page: the previous answer's next as before=
curl -sS -b cookies.txt -H 'X-Observogram-Org: acme' \
  'http://127.0.0.1:8000/api/audit?kind=deploy&since=2026-09-28&limit=50&before=318'
# an owner: the deployment-level rows only (users, orgs, owners, imports)
curl -sS -b cookies.txt 'http://127.0.0.1:8000/api/audit?scope=deployment'
```

The listing holds every login and every MCP origin of the deployment, so
the route is closed where the member and user lists are: on an exposed
server without sign-in (403 `posture`, `the audit API is closed on a server
bound to …`) and, on a loopback server without sign-in, answered only to a
request sent straight to a loopback address (`on a server without sign-in
the audit API answers only requests sent straight to a loopback address …`),
as [the identity API](#the-identity-api) is. Below `admin` it is the
guard's 403 `role`; the bearer is an operator and cannot read it. The read
writes no row.

**From a shell — `packc store audit`.** The bearer is an operator and
cannot read `GET /api/audit`, so a shell on the pod or a CI job lists the
audit from the database file instead: `packc store audit` (the store is
`OBSERVOGRAM_DB`, else `<workspace>/observogram.db`; WAL makes the read
safe while the server runs). It is read-only — it writes no row — and it
is an owner's view: every org's and the deployment's rows by default,
`--org <id>` one org's, `--deployment` the rows with no org (`--all` says
the default). The filters are the route's as flags — `--actor`, `--action`,
`--kind`, `--target-kind`, `--target`, `--since`, `--until`, `--limit`
(1–500, default 100), `--before` — with the same rule and the same refusal
texts spelled with the flags (`--limit must be an integer from 1 to 500`).
One JSON row per line on stdout, newest first, the row the API serves;
the `store: <path>` line and, when more rows exist, `next: <seq>` go to
stderr, so stdout pipes into `jq` as it is:

```bash
# acme's deploy rows since a date, 50 a page; the next page by the stderr line
packc store audit --org acme --kind deploy --since 2026-09-28 --limit 50
packc store audit --org acme --kind deploy --since 2026-09-28 --limit 50 --before 318
# the deployment-level rows (users, orgs, owners, imports), as JSON lines
packc store audit --deployment | jq -c '[.seq, .action, .actor, .targetId]'
```

Like its siblings it refuses `OBSERVOGRAM_DB=:memory:` and a workspace
whose `users.json` / `orgs.json` the server has not imported yet, and it
never creates a database (`no database at … — nothing to list`). On a
loopback server without sign-in, the refusal of an indirect `GET /api/audit`
names it as the way out from this machine (`…, or list it from this machine
with packc store audit`).

### Run In Docker Or Kubernetes

The whole app is one Express process, so the container story is one image:

```bash
npm run build:stamp                    # build.json: the commit the image is built from (the image has no .git)
docker build -t observogram:0.5.0 .
docker run --rm -p 8000:8000 -e OBSERVOGRAM_ADMIN_PASSWORD=<secret> observogram:0.5.0
```

The image binds `0.0.0.0`, so it needs a seeded sign-in (or
`OBSERVOGRAM_API_TOKEN`) to start — see Security Posture above. Its workspace
is `/app/.observogram` (owned by the `node` user the container runs as);
mount a volume there, or point `OBSERVOGRAM_WORKSPACE` at one, to keep users
and packs across containers.

Kubernetes manifests (Deployment + Service + Ingress + the `store` PVC,
applied with Kustomize) live in [`deploy/k8s/`](deploy/k8s/README.md). The
studio keeps its workspace and its database on that ReadWriteOnce volume
and rolls out with `strategy: Recreate`, so `kubectl apply -k deploy/k8s`
needs a default StorageClass (or a `storageClassName`):

```bash
kubectl apply -k deploy/k8s            # the studio and its store volume
kubectl apply -k deploy/k8s-journeys   # + the opt-in journeys CronJob and its workspace PVC (deploy/k8s/README.md)
```

### Which Build Am I Running?

There is no build step — the studio is served from the checkout — so the
identity of a running Observogram is the commit it was started from, and
one reader (`server/build-info.mjs`) answers everywhere:

- the studio footer: `v0.4.0 · build 975 · 9c4f827 · develop` (hover for
  the commit date and the source), the same label on Advanced → About;
- `packc --version` prints that label (`--version --json` the fields);
- `GET /api/version` returns `{ version, build, commit, branch, dirty, date,
  shallow, source, label }` — readable without a session (Security
  Posture), `Cache-Control: no-store`, so a proxy never pins an old build
  to a new process; `/healthz` keeps its composite `build: "975.9c4f827"`.

The **build number is the commit count on the branch** (`git rev-list
--count HEAD`): it climbs with every commit, so two studios can be compared
at a glance; the **sha** is what makes it unique (two branches can share a
count); **dirty** means git listed uncommitted or untracked files
(`git status --porcelain`) when the process started — the code running is
not exactly that commit. For a copy without
`.git` (a tarball, a container image) run `npm run build:stamp` in the
checkout first: it writes a git-ignored `build.json` that the reader falls
back to (`source: file`; run again inside such a copy it keeps that file —
it is the copy's only identity); with neither, the answer is package.json's
version and `build unknown` (`source: package`) — never a guess.

A **shallow clone** (`git clone --depth 1`; `actions/checkout` fetches one
commit by default) has no history to count, so it reads `build unknown ·
<sha> · <branch> · shallow` (`shallow: true`) rather than the clone depth,
and `npm run build:stamp` refuses it (exit 2) until the history is there —
`fetch-depth: 0` in the workflow, `git fetch --unshallow` locally.

## Common Operations

### Scan A Repo

```bash
npm run crawl -- path/to/service-repo --name payments-api --env prod > repo.pack.yaml
npm run validate-pack -- repo.pack.yaml
```

The crawler reads source files such as:

- Prometheus rule files (recording rules, burn-rate and operational alerts)
- Grafana unified-alerting provisioning YAML and Loki rule files
- Grafana dashboard JSON
- Alertmanager config
- OTel Collector config
- Helm and Kubernetes manifests
- Docker Compose files

It emits a canonical v1.4 pack plus crawler annotations describing what was
scanned and what was inferred. A fresh crawl validates (exit 0) and needs no
upconversion; `npm run pack-conformance -- repo.pack.yaml` lists what it had to
stub. Names (`--name`, `--env`, `--owners`) must be spec Slugs — 2-64 lowercase
letters, digits, `_` or `-`, starting with a letter — and `--criticality` /
`--binding` must be spec values: a flag the spec cannot hold is refused before
the crawl with exit 2, the rule in the message and nothing on stdout. Without
`--name` the folder's name is normalized to a Slug and the original kept in
`crawler.nameNormalizedFrom`. Exit 3 means the pack failed its own schema — a
crawler bug, report it. Recording rules not named `<service>:<metric>:<op>`
cannot be declared in `spec.queries.recording_rules`; they are recorded in
`crawler.omitted.recording_rules` (their expressions still feed the metric
inventory). Every value the crawler invents — the stub SLI/SLO, an assumed
port, an Alertmanager address the config does not state, the default owner,
the OTel SDK defaults — carries a `crawler.scaffold.<symbol>` annotation with
the reason; the conformance tool turns those into rows
([`docs/DOWNSTREAM.md`](docs/DOWNSTREAM.md) §12). Every alert rule is kept: a rule whose
expression references a recorded SLO series is a burn-rate alert
(`spec.policy.burn_rate_alerts`); every other rule — a pod restarting, a pool
saturated, a certificate expiring — is an operational alert and is declared in
`spec.alerting.rules` (spec 1.4) under its exact name, with its expression,
wait, severity, labels, engine (`prometheus`, `grafana`, `loki`) and the file
and group it was read from. The same name is what a live Grafana or ruler
listing is reconciled on, so the repository's rule and the running rule pair
in Compare.

### Fetch Live From MCP

```bash
MCP_URL=https://otel-mcp.example.com/mcp \
MCP_AUTH=$MCP_CLIENT_KEY \
npm run fetch-live
```

The default output is the ignored local file `examples/production-live.pack.yaml`,
which `npm run detect-drift` and the dry run read. The studio's LIVE badge
reads each org's own live pack, `<org root>/live/production-live.pack.yaml`
(the default org at `.` → `<workspace>/live/…`), written by the MCP panel's
refresh; `OUTPUT=<org root>/live/production-live.pack.yaml npm run fetch-live`
feeds it from the CLI. Both keep the same safe URL: no userinfo, fragment or
credential query parameter (`MCP_AUTH` is the place for a token).
Behind a gateway with its own auth, extra headers, a proxy or a private CA,
`OBSERVOGRAM_TRANSPORT_HOOK=<path.mjs>` names a module whose
`prepareRequest({ url, headers })` (sync or async) is applied to every MCP
request the CLI, the recorder, the live probes, a journey and the studio
server make, and whose optional `fetchImpl` replaces the fetcher; the URL it
returns passes the same http(s)/local-address policy as the caller's. A hook
that fails to load or breaks its contract is a hard failure — exit 1, no pack
written; the server refuses to start on a load failure — while network
failures through it stay ordinary probe failures. Unset, nothing changes
(`docs/MCP_INTEGRATION.md`, "Transport hook").

The studio's `POST /api/refresh-live` and `POST /api/draft-from-mcp` take
either `mcpUrl` (with an optional `mcpAuth`, as before) or `mcpEndpointId`:
one of the org's named MCP endpoints (`GET /api/mcp-endpoints`; an admin
registers them with `POST /api/mcp-endpoints`). With an id the server uses the
record's URL, and when the request sends no `mcpAuth` it reads the endpoint's
read token from the variable the record names, `OBSERVOGRAM_ORG_<ORG>_<NAME>`
(`ORG` = the org id in upper case, `-` → `_`; for example
`OBSERVOGRAM_ORG_DEFAULT_MCP_TOKEN`), set in the server's own environment (the
k8s Deployment's `env`, from a Secret). An admin may name only their org's
variables; the owning org is the one whose prefix is the longest match, so
`OBSERVOGRAM_ORG_ACME_EU_X` is `acme-eu`'s, not `acme`'s, and the check runs
again at each request. A variable that is not set is a 400 naming it, before
anything is fetched. The response says which record was used (`mcpEndpoint:
{ id, name }`, or `null` for a URL); the live pack and the draft keep the safe
URL and never the token. The deploy and rollback routes take `mcpEndpointId`
for the URL only — a write token stays the request's `mcpAuth`.
When the MCP exposes `metrics_query`, the fetch also samples the observability
stack's own self-metrics (scrape, ruler, notify, tsdb, collector, dashboards,
synthetic, logs, traces) as point-in-time signals — never verdicts, stamps or
grade inputs; on a restricted tier the pack says `not-attempted` and why.
`npm run record-fixtures` verifies the alias table behind that sample against
your endpoint (report only; `-- --write` records fixtures), and
`npm run test:stack:live` re-verifies every alias against the real products at
pinned versions in Docker (`docker/stack.compose.yaml`; skips without Docker).

See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for the live fetch and
write-back contract.

### Validate Or Upload A Pack

```bash
npm run validate-pack -- path/to/pack.yaml
```

The studio also accepts drag-and-drop or file picker upload. Uploaded, crawled,
and MCP-drafted packs are registered in memory and become addressable through
the same `/api/packs/:id/*` endpoints as catalog packs.

### Record Verdicts

A verdict is a reviewer's record on one artefact of a registered pack —
`trusted`, `suspect` or `failed`, with a reason, who and when — kept in the
store beside the pack's row ([docs/ADAPTER.md](docs/ADAPTER.md), "Verdicts —
a reviewer's record per artefact"). It is a trust record, not a scorer
input: nothing sums verdicts into the conformance score or the diagnostic
grade, and `unreviewed` is the absence of a record. The artefact is named by
the adapter's positional id (`SLI-01`, `ALR-02`; `GET /api/packs/:id` lists
them), which is frozen within a pack id because the id is a content hash; a
re-upload of the same content keeps the verdicts, and a re-upload under the
same label with changed content carries each verdict onto the new pack's
artefact when the artefact's behavioural identity is unchanged (`carriedFrom`
names the old pack; the rest are dropped and the `verdict.carry` audit row
counts them). A catalogue or example pack holds no verdicts — register it
first (`POST /api/validate`) and record on the registered id.

```bash
# record (operator): the body is { status, reason? }
curl -sS -X PUT -b cookies.txt -H 'X-Observogram-CSRF: 1' -H 'Content-Type: application/json' \
  -d '{"status":"suspect","reason":"the window is shorter than the SLO period"}' \
  http://127.0.0.1:8000/api/packs/uploaded-payment-service-1a2b3c4d/verdicts/SLO-01
# read (viewer): the document, every artefact counted in summary
curl -sS -b cookies.txt http://127.0.0.1:8000/api/packs/uploaded-payment-service-1a2b3c4d/verdicts
# clear (operator)
curl -sS -X DELETE -b cookies.txt -H 'X-Observogram-CSRF: 1' \
  http://127.0.0.1:8000/api/packs/uploaded-payment-service-1a2b3c4d/verdicts/SLO-01
```

In the studio, Discover shows a verdict as a badge on the board and a chip
on the row, the Refine control filters a layer by verdict, and the drawer's
Verdict section records one (operators and admins; everyone in the open
postures). The `actor` is the audit actor — a login or the token label,
never an email. `GET /api/packs/:id/export.zip` adds `verdicts.json` (the
GET document) after the compiled artefacts — only while the pack has a
verdict, so a pack without one exports exactly what it did before.

### Report Placeholders (pack conformance)

```bash
npm run pack-conformance -- path/to/pack.yaml [more.pack.json ...] [--json] [--strict] [--quiet]
packc conformance path/to/pack.yaml
```

A valid pack can still be full of placeholders — the values an importer (the
upconvert, the crawler, the live fetcher, Build) had to invent to satisfy the
schema. This tool lists them as rows: the pack path (`$.spec.slis[0]`), the
field, what it needs, and where the value normally comes from — **crawl** (it
exists in the service repository: `npm run crawl` reads it), **telemetry** (a
fact of the running backends: the live fetcher or the backend's API) or
**operator** (a decision only the owning team can make). The detection rule is
the studio's: an artefact whose symbol carries a `crawler.scaffold.*`,
`mcp.scaffold.*` or `library.todo.*` annotation is a placeholder, so the rows
are what Discover parks as Scaffold. Each row's state is `placeholder` (marker
present, value still a stub), `marker-only` (value changed — if real, delete the
marker), `unmarked` (no marker, but the value is an importer's stub literal) or
`dangling` (a marker naming nothing). Exit 0 when every pack is readable,
canonical and valid (rows are informational); 1 for an unreadable, layered
(upconvert it first) or invalid pack, or with `--strict` when any pack still
has rows; 2 for usage. `--json` prints `{ tool, specVersion, strict, packs:
[{ path, valid, errors, rubric, rows, counts, … }], totals, exitCode }`. The
maturity rubric (Diagnose) grades what is declared, placeholders included; the
rows are what still has to become real. The workflow, the marker contract and
the merge-safe `upconvert-legacy` (`-o` onto an existing canonical file merges;
`--merge`, `--overwrite`) are in [`docs/DOWNSTREAM.md`](docs/DOWNSTREAM.md) §11.

### Classify Typed Packs

Observogram groups a pack's artefacts into families — SLI, SLO, recording
rule, dashboard, alert route … — and the Discover board, the drawer, the
diff and the graphs all read that one classification
(`tools/lib/artefact-classify.mjs`: an explicit `type` first, then the
canonical `defines` symbol the adapter attaches, then the id prefix). A pack
produced by another toolchain carries typed artefacts (`type: PackSLI |
PrometheusRule | …`) with its own id scheme and would otherwise render as a
flat wall of "Other". Point the server at a JSON file that maps those names
and id patterns onto Observogram's families:

```json
{
  "version": 1,
  "types": { "PackSLI": "sli", "PackSLO": "slo",
             "PrometheusRule": { "family": "alert_rule", "label": "Prometheus rule" } },
  "ids":   [ { "pattern": "^promrule-", "family": "alert_rule", "flags": "i" } ]
}
```

```bash
OBSERVOGRAM_TAXONOMY=./taxonomy.json npm run dev
```

The server reads the file once at start (`[taxonomy] loaded <path>: N types,
M id rules`), installs it process-wide and serves it to the studio at
`GET /api/taxonomy` (`{ ok, taxonomy, configured }` — never the path). An
unreadable or invalid file **refuses the start** with
`OBSERVOGRAM_TAXONOMY: <path>: <reason>`. A value is a family name or
`{ family, label?, role? }`; the family decides the board group
(`FAMILY_HOME` in the classifier) and the label/role replace the row's
plain-words kind. Type names match exactly (case-sensitive); a pattern must
start with `^`, be at most 200 characters, use flags `""` or `"i"` and hold
no quantified group, and is matched against the first 256 characters of the
id. The file is operator-trusted configuration: regexes run server-side
against the ids of uploaded packs. Observogram's own adapted artefacts are
never re-homed by it — their canonical `defines` symbol wins over any id
rule. In identity mode an anonymous studio boots on the default families
until sign-in (`/api/taxonomy` is a viewer route, like `/api/examples`).
Unset, nothing changes: the families are Observogram's own and the board
goldens (`npm run test:golden:board`) are byte-identical.

A typed pack reaches the pipeline either as a layered JSON upload whose items
carry a `type` (kept through the upconvert as
`metadata.annotations["observogram.artefact.type.<symbol>"]` and emitted by
the adapter as the artefact's `type`, see [docs/ADAPTER.md](docs/ADAPTER.md),
"Id families and the classifier") or as a layered pack a downstream server
or bundle serves directly. `tools/fixtures/taxonomy/` holds a worked example
of both the pack and the override. The static bundle bakes the same file with
`npm run build:studio -- --taxonomy <file>` (or `OBSERVOGRAM_TAXONOMY` when
the flag is absent) and groups as the server does ("Serve The Studio Without
The Server", *Bake the seams*).

### Rebadge The Studio (brand config)

Everything the studio says about the *product* — its name, wordmark,
tagline, logo, page title and description, footer text and links, the About
card, the Discover scanner title and hero, the sign-in pages — comes from
one brand object (`tools/lib/brand.mjs`, zero-import, vendorable). With no
brand configured the server serves `studio/index.html` byte for byte and
every chrome string is today's Observogram (`DEFAULT_BRAND`). A downstream
rebadges with a JSON file, or with a few environment scalars; **one `name` is
enough** — every other string derives from it unless the file names it:

```json
{
  "name": "Acme Watch",
  "shortName": "Acme",
  "wordmark": { "lead": "Acme", "tail": "Watch" },
  "tagline": "reliability, watched",
  "titleSuffix": "the Reliability Console",
  "description": "Acme Watch — …",
  "logo": { "url": "/assets/acme-mark.svg" },
  "favicon": "/assets/acme.ico",
  "docsUrl": "https://docs.example.com/acme-watch",
  "footer": { "text": "Acme Watch · a product of Acme Corp",
              "links": [{ "label": "docs", "href": "https://docs.example.com/acme-watch" }] },
  "about": { "changelogUrl": "https://docs.example.com/acme-watch/releases" },
  "hero": { "src": "/assets/acme-hero.png", "alt": "Acme Watch posture scan" },
  "tokens": { "light": { "accent": "#b3261e" }, "dark": { "accent": "#f28b82" } }
}
```

```bash
OBSERVOGRAM_BRAND_FILE=./brand.json npm run dev
# or, without a file (a file's values first, these on top):
OBSERVOGRAM_BRAND_NAME="Acme Watch" OBSERVOGRAM_BRAND_ACCENT="#b3261e" npm run dev
```

The scalars are `OBSERVOGRAM_BRAND_NAME`, `_SHORT_NAME`, `_TAGLINE`,
`_LOGO_URL`, `_DOCS_URL` (→ the footer's `docs` link and the About card's
changelog link), `_FOOTER` (→ `footer.text`), `_ACCENT` and `_ACCENT_DARK`
(→ `tokens.light.accent` / `tokens.dark.accent`); the legacy `TOMOGRAPH_*`
spelling is honoured. The defaults, and what derives from `name` when a
brand names one: `shortName` ← `name`; the wordmark ← `name` in one piece
(the default's `Observo`/`gram` split is upstream's); the scanner title
`<SHORTNAME> SCAN`; the atlas compass mark `<SHORTNAME>` (default `OBSERVO`);
the footer text `<name> · <titleSuffix>`; the hero alt `<name> scan` — and a
named brand shows the CSS fallback instead of upstream's hero art until it
sets `hero.src`; the description `<name> — write one ObservabilityPack
manifest, …`; the footer links keep the spec link and drop the upstream repo
link (a `docsUrl` adds a `docs` link); the About changelog link ← `docsUrl`
(none ⇒ no link). `tokens.light` / `tokens.dark` override design-token values
by name (`accent`, `accent-solid`, `bg`, … — the names in
`studio/design-tokens.css` without the `--og-` prefix); a light override
applies to both themes unless the dark map restates it.

What the server does with it: `GET /`, `GET /index.html` and every
non-`/api` path answer the shell with the title, meta description, legacy
header, footer text (the `#build-label` version span kept) and links
replaced, plus — after the design-tokens link — a `<style id="brand-tokens">`
when tokens are set, the normalized brand as `<script type="application/json"
id="brand-config">` (the studio reads it back; never the file's path), and a
`<link rel="icon">` when a favicon is set. The studio (`studio/brand.mjs`,
`state.brand.chrome`) paints the header, About, scanner, origin tip, compass
mark, reset confirm, API-unreachable screen and version tooltip from it;
`server/auth.mjs` renders the sign-in, change-password and reverse-proxy
explainer pages from it. The start log says `[studio] brand: <name> (<path> |
OBSERVOGRAM_BRAND_* env)` once. An unreadable or invalid file **refuses the
start** with `brand file <path>: not found | is a directory | unreadable | not
valid JSON | not a JSON object` — the message never carries the contents;
`brand: tokens.<theme>.<name> is not a design token name`, `brand: token
value for <name> contains ;{}<>` and `brand: logo.svg is not inline SVG`
refuse a malformed brand.

Trust: every brand string is escaped where it lands (text and attributes).
The one raw field is `logo.svg` — inline SVG markup, injected only into the
JS header through `innerHTML` (never into the server-rendered shell or the
auth pages); it must start with `<svg` and must not contain `<script`, which
is a tripwire for a pasted page, not a sanitizer — the brand file is
operator config like any other server file. `studio/reskin.css` re-strokes
the header SVG with `--og-accent`, so a custom mark inherits the accent.

What is **never** rebranded, because it is protocol or storage, not chrome:
the `X-Observogram-CSRF` / `X-Observogram-Org` headers, the `observogram_*`
cookies, the `observogram.*` annotation keys in packs, the `.observogram/`
workspace directory, `/api/*` JSON (`/healthz`, `/api/version`), compiled
artefacts and the gen-site output (golden-gated, brand-free), the CLI's
banner, and the `/assets/observogram-hero.png` path the default hero reads.
`tools/test-brand.mjs` keeps the product's name out of every studio and
auth-page source outside `tools/lib/brand.mjs` (a comment-stripping source
guard), and proves the inert case: the unconfigured shell is the same string,
the default chrome is the literal it replaced, `loadBrand({ env: {} })` is
the default.

The design tokens as JSON follow the same rule: `node
tools/gen-design-tokens.mjs --brand brand.json --out dist/design-tokens.json`
writes the rebadged document (a `brand` key names it); the generator never
reads `OBSERVOGRAM_BRAND_FILE`, and `--brand` with `--write` refuses, so
`studio/design-tokens.json` stays the vendorable default. The static bundle
(`npm run build:studio`) bakes the same file with `--brand` — the server's
loader and the server's shell renderer, so the chrome is the same — and
honours `OBSERVOGRAM_BRAND_FILE` / the scalars when the flag is absent ("Serve
The Studio Without The Server", *Bake the seams*).

### Compile Artifacts

```bash
# Enumerate the compile tree
curl http://127.0.0.1:8000/api/packs/<pack-id>/compile-catalog

# Compile one artifact
curl "http://127.0.0.1:8000/api/packs/<pack-id>/compile-artifact?group=rules&flavor=grafana-managed&artifact=slo:slo_settlement_latency_99"
```

The UI exposes the same path through **Remediate -> Compile & Deploy**.

**Assurance rules.** Every compiled rules file (Prometheus and Grafana-managed)
ends with a `<svc>_assurance` group that monitors the monitors: an always-firing
`Watchdog` (route it to a heartbeat receiver and page when the heartbeat stops),
`<svc>_scrape_target_down` over the pack's declared scrape jobs, and instrument
liveness / degradation alerts (`<svc>_ruler_silent_prometheus`,
`_notify_silent_prometheus`, `_ruler_stale_`, `_ruler_errors_`,
`_notify_errors_`; `vmalert_*` rows under VictoriaMetrics, Alertmanager and
Grafana rows only when the pack declares them) built from the stack self-metric
alias table. Opt out per pack with the annotation
`observogram.assurance: watchdog-only | off` (default `on`). The catalog lists it
as the `assurance` item with its own file. See
[`docs/ASSURANCE_RULES.md`](docs/ASSURANCE_RULES.md) for the rules and a sample
heartbeat route.

### Serve The Studio Without The Server (static bundle)

A downstream that serves the studio behind its own static host — a CDN, an
S3 bucket, a reverse proxy's `root` — builds it as one HTML file:

```bash
# One file: every module, every stylesheet, the packs it names.
npm run build:studio -- \
  --pack vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml --label "Payment service" \
  --pack my-service.pack.yaml --id my-service --description "Checkout, orders and the ledger" \
  --out dist/studio/index.html

# A pack the page fetches at its first catalogue read (the host must answer CORS):
npm run build:studio -- --pack-url https://packs.example.com/orders.pack.yaml --label Orders

# The two seams a server reads from its environment, baked in: the taxonomy
# override ("Classify Typed Packs") and the brand ("Rebadge The Studio").
npm run build:studio -- --pack my-service.pack.yaml \
  --taxonomy tools/fixtures/taxonomy/taxonomy.json --brand brand.json

# Check the build without writing (also --json): the graph, the stylesheets, the packs.
npm run build:studio -- --check --pack my-service.pack.yaml
```

Each `--pack` / `--pack-url` takes its own `--id` (default: the file name),
`--label` (default: the pack's `metadata.name`, else the id) and
`--description` — the catalogue row the bundled studio shows, field for field
what a server-side pack row carries. `--no-remote-fonts` drops the Google Fonts
links for an offline host.

**Bake the seams.** `--taxonomy <file.json>` bakes the artefact-taxonomy
override (the file a server reads from `OBSERVOGRAM_TAXONOMY`, "Classify
Typed Packs"): validated at build time with the server's `validateTaxonomy` —
a bad file fails the build with `--taxonomy: <path>: <reason>`, the server's
own texts — and served by the bundle's `GET /api/taxonomy` as
`{ ok, taxonomy, configured: true }`, so Discover groups a typed pack exactly
as a server started with that file does (`tools/test-studio-bundle.mjs` T8
proves it byte for byte against the board goldens). `--brand <file.json>`
bakes the brand ("Rebadge The Studio"): the server's loader
(`tools/lib/brand-env.mjs`, so the `OBSERVOGRAM_BRAND_*` scalars apply on top
of the file, as on a server) and the server's shell renderer
(`brandShellHtml`: title, description, header, footer, `#brand-config`,
`#brand-tokens`, favicon), which the studio chrome, the notice and the `501`
texts all read — a `--brand` bundle names its own product and never the
upstream one. When a flag is absent the server's variables are honoured —
`OBSERVOGRAM_TAXONOMY`, `OBSERVOGRAM_BRAND_FILE`, the `OBSERVOGRAM_BRAND_*`
scalars (the one-field rebadge is `OBSERVOGRAM_BRAND_NAME=Acme npm run
build:studio`, POSIX shell syntax) — so a build machine configured for a
server bakes what that server shows; build unbranded there by unsetting or
emptying the variable, since an empty value counts as unset:
`env -u OBSERVOGRAM_BRAND_FILE …` or `OBSERVOGRAM_BRAND_FILE= …` in a POSIX
shell, `set OBSERVOGRAM_BRAND_FILE=` in cmd, `$env:OBSERVOGRAM_BRAND_FILE=''`
in PowerShell (there is no `--no-brand`). The summary line and `--json` always
say what was baked (`taxonomy: { source, file, types, ids } | null`, `brand:
{ source, file, name } | null` — the paths, never the contents, and neither
path lands in the bundle). Brand URLs must not be server paths: `favicon`,
`logo.url` and `hero.src` are an absolute URL, a `data:` URL or a path
relative to the bundle's own directory (resolved against the page's URL by
the static host) — `/assets/x.ico` fails the build naming the field and the
fix. A configured brand that gives no `name` keeps the upstream strings, as on
a server; and the unbranded bundle's Discover hero is the server asset
`/assets/observogram-hero.png` (the default brand's `hero.src`), so a static
host serves that asset or the brand names its own `hero.src`.

What the file is (`tools/build-studio-bundle.mjs`): `studio/index.html` with
every stylesheet inlined in place, an inline **import map** whose keys are the
studio and `tools/lib` modules and whose addresses are `data:` URLs of each
module (only the import-specifier strings are rewritten — no transform of the
code), the packs' canonical manifests and the spec schema inlined as JSON, and
`studio/static-backend.mjs` installed before the app boots. That module answers
the read-only pack routes in the browser from the same `tools/lib` engines the
server runs — the catalogue, Discover, Diagnose (conformance), the canonical
manifest, Compile (the catalogue, every artefact, every target) and **Export**
(the ZIP, downloaded as a Blob) — so the verdicts are the server's
(`tools/test-studio-bundle.mjs` compares every ported route against a running
server; `GET /api/packs/:id/verdicts` answers the empty document — a
bundled pack is never registered, so that IS the server's answer). Everything
the server alone can do — Scan a repo, Draft from MCP, uploads, Compare,
Deploy, Journeys, Build, recording a Verdict, sign-in — answers
`501 { denied: 'no-backend', error: '<Feature> needs the Observogram server;
this studio is a static bundle built without one.' }`, which the studio shows
as the sentence, and a dismissable notice at the bottom of the window says so
once ("Static studio — no Observogram server behind this page …"). Compare is
out by design: the server's diff carries the traceability graph, whose PromQL
parser is a bare node dependency the bundle cannot inline, and a diff without
it would grade differently from the server.

Notes: `--pack` is validated against the spec schema at build time (a failing
pack fails the build with the validator's text); `--pack-url` refuses a URL
with userinfo or a credential query parameter — the URL is baked into a file
you distribute — and `--json` prints URLs stripped; the Google Fonts links stay
unless `--no-remote-fonts` (offline, the fallback stacks apply); a
Content-Security-Policy that forbids `data:` in `script-src` cannot run the
single-file form (a `--split` directory mode is the follow-up); import maps
need Chrome 89, Firefox 108 or Safari 16.4. Without `--pack` the studio boots
with an empty catalogue and the notice. The live server is untouched: it
serves `studio/static-backend.mjs` and `.css` publicly like every studio file,
and nothing in the live studio imports them. `docs/DOWNSTREAM.md` §10 is the
downstream view (build from the vendored snapshot, swap packs, upgrade by
rebuilding).

### Build A Pack From The Library

For a service that has no pack yet: pick the products it runs on (or an archetype
for a service built from scratch), a criticality tier and a name, and `packc init`
instantiates the library entries into a canonical v1.4 pack that validates,
compiles through every target and passes every MUST clause of the tier — with the
values only the team can fill (pager service, chaos target, endpoints) reported as
todos, never hidden. The same engine drives the studio's Build journey (Define ·
Compile · Verify, see "Main Journey" above) through `/api/library/*`; the
contract is [`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md) and the entries and
their evidence bar are in [`library/README.md`](library/README.md).

```bash
$ node tools/cli.mjs init --list
entry           kind       version  evidence       SLIs t3/t2/t1  title
alertmanager    product    1.0.0    recorded-live  2/3/4          Alertmanager
grafana         product    1.0.0    recorded-live  2/6/8          Grafana
ibm-mq          product    1.0.0    recorded-live  2/6/8          IBM MQ
kafka           product    1.0.0    recorded-live  2/5/6          Apache Kafka
loki            product    1.0.0    recorded-live  1/2/4          Grafana Loki
otel-collector  product    1.0.0    recorded-live  1/4/6          OpenTelemetry Collector
prometheus      product    1.0.0    recorded-live  2/6/8          Prometheus
tempo           product    1.0.0    recorded-live  1/2/4          Grafana Tempo
http-service    archetype  1.0.0    semconv        1/2/4          HTTP service (OTel semconv)
queue-consumer  archetype  1.0.0    semconv        1/2/4          Queue consumer (OTel semconv)

$ node tools/cli.mjs init --show alertmanager      # params, SLIs per tier, objectives, evidence
alertmanager@1.0.0 — Alertmanager (product, product alertmanager)
  Availability, notification delivery success and failure rate, and silence count of a Prometheus Alertmanager.

evidence: recorded-live (verified 2026-09-07)
  - tools/lib/contracts/stack-self-metrics.mjs — rows notification_errors, notifications_sent, active_silences (…)
  …

$ node tools/cli.mjs init --entry kafka --tier tier-2 --name orders-kafka --owner team-orders \
    --param pager_service=pagerduty://orders --out orders-kafka.pack.yaml
packc init: orders-kafka@tier-2 from kafka@1.0.0 — 5 SLI(s), sections slos:on policy:on routes:on dashboards:on validation:on → orders-kafka.pack.yaml
conformance @ tier-2: MUST 15/15, SHOULD 1/1 (4 clause(s) pass on a placeholder)
todos (20) — placeholders only the team can fill:
  - alerting.routes[0]: channels.0.msteams: Chat channel for SEV1/SEV2: placeholder '#orders-kafka-oncall' (param oncall_channel) — …
  - baselines: mttd_target_p50: MTTD / MTTR targets are the tier-2 defaults, not measured: set them from the service's incident history
  - remediation[0]: runbook: write the runbook file://<runbook_dir>/broker-down.md
  - telemetry.backends.metrics-prom: version.declared: Prometheus version you run: placeholder '3.14' (param prometheus_version) — … · endpoints.0: Prometheus query endpoint: placeholder 'http://prometheus:9090' (param metrics_endpoint) — …  [L2.MUST.metrics_logs_traces_backends]
  - validation.synthetic_checks.produce-consume-canary: target: Bootstrap servers: placeholder 'kafka.kafka:9092' (param bootstrap) — …  [L5.MUST.synthetic_probe]
  …
schema: valid (spec v1.4)
```

The pack goes to stdout or `--out`; the todo list and the conformance line go to
stderr. `--slis a,b` (or `--sli <id>`, repeatable) picks the SLIs — any SLI of the
entries, above the tier too: the tier is a seed, an SLI above it starts from its own
tier's profile; `--override <sli>.<id|objective|window|threshold|good_when|semconv_metric>=<value>` (repeatable)
edits a selected SLI's copy of the library's value (the SLO id follows the objective; a
query is edited in the studio or the pack file; an override for an SLI not in the pack
is a `warning [override]`). A threshold SLI's bound has a direction since spec 1.3 —
`good_when: below` (a ceiling, the default) or `above` (a floor: connected consumers,
in-sync replicas) — declared in a library entry, in an override (`--override
<sli>.good_when=above`, or the editor's *good when* control) or in a custom SLI, and the
compiled burn alert then counts the samples under the bound; `--no-dashboards`,
`--no-policy`, `--no-routes`, `--no-validation`, `--no-slos` leave that section out
(the schema and the rubric then both say what is missing, exit `1`); `--entry
kafka,http-service` composes several entries into one pack; `--json` returns
`{ canonical, todos, provenance, warnings, schemaErrors, summary }`. Exit codes: `0` ok,
`1` the pack does not validate (the schema, a MUST clause of its tier — `MUST 14/15` is
never exit 0 — or an SLI that no longer parses once the `--param` values are in), `2`
usage error (an unknown `--param` key, a value carrying a quote). Every produced pack carries
`metadata.annotations["library.source"] = "<entry>@<version>"` and one
`library.todo.<artefact>` per placeholder, which the studio parks as *Scaffold* the
way it parks a crawler stub. `npm run test:library` proves every entry at every
tier (schema, four compile targets, dashboard bindings, conformance, goldens).

### Saved Journeys — Repeatable Drift Checks

Freeze a comparison as a journey file and run it on demand or on a schedule:

```yaml
# .observogram/journeys/repo-vs-live.journey.yaml
name: repo-vs-live
packA:
  crawl: { path: ../my-service, name: my-service, env: prod }
packB:
  mcp: { url: https://otel-mcp.example.com/mcp, authEnv: MY_MCP_TOKEN }
gate:
  minAlignmentPct: 85
  requireGradePass: true
  maxLiveAgeHours: 24
  failOnPartialEvidence: true   # a probe family FAILED → the verdict is not trustworthy
  maxUnhealthy: 0               # scrape jobs down + rules failing to evaluate, as seen on the wire
  stack:                        # thresholds on the stack's own self-metric samples (early warning)
    requireSampled: true        # breach unless the MCP tier let the run sample them
    rows:
      scrape_targets_down: { max: 0 }   # row ids come from the stack self-metrics table
keepLivePack: transitions       # snapshot Pack B beside the run: transitions (default) · always · never
schedule: "*/15 * * * *"        # the cadence it is MEANT to run at — declared, never fired from here
                                #   also { cron, timezone } or { every: 15m }
stackBudget: { objective: 0.99, window: 30d }   # posture budget the Journeys view prints per gated stack row (signal, not verdict)
notify:                         # early-warning delivery: one bounded POST per run
  urlEnv: MY_JOURNEY_WEBHOOK_URL     # env var NAME holding the URL (a literal url: is refused)
  authEnv: MY_JOURNEY_WEBHOOK_TOKEN  # optional → Authorization: Bearer <value>
  on: transitions                    # transitions (default) · breach · always
  format: json                       # json · text (one line + markdown body, ntfy-style)
inventory:                      # is the right number of things being monitored? (gen-site partition)
  site: ../sites/prod/site.json      # its `expected` block: names per kind, counted kinds with floors
  kinds: [qmgr, host]                # optional subset
# and under gate:  inventory: { maxSilent: 0, maxDown: 0, maxUnexpected: 0, minCoveragePct: 100 }
```

```bash
node tools/cli.mjs journey run repo-vs-live          # markdown report
node tools/cli.mjs journey run repo-vs-live --json   # automation output
node tools/cli.mjs journey run --all                 # every saved journey in sequence (exit = the worst)
node tools/cli.mjs journey schedule repo-vs-live     # cron · schtasks · GitHub Actions · CronJob snippets from schedule:
node tools/cli.mjs journey list                      # journeys + last outcome (+ notify status)
```

Exit codes follow the gate contract: `0` verdict passes, `1` gate failed,
`2` tooling/config error — so the same command is a cron job, a Windows
scheduled task, or a CI gate. Every run appends a JSON record under
`.observogram/runs/<journey>/` (the drift-over-time series), including the
vantage of the live source itself (`probes`, `vantage`, `toolsExposedCount`,
`scrapeJobsDown`, `unhealthyRules`). When the live MCP does not answer at
all, the run still writes an `outcome: vantage-lost` record before exiting
`2` — the loss is a point in the history, not a gap. The CLI grades on the
same construct as the studio (requirement-chain integrity rides on the
diff), so both report one score for one comparison. Secrets never live in
journey files — MCP auth is referenced by env-var name.

Run history is bounded so a journey on a cron cadence never fills the disk:
after every run the journey's `runs/` directory is pruned to the newest
`OBSERVOGRAM_JOURNEY_RUN_RETENTION` records (default `1000`; `0` = unlimited).
A record that cannot be deleted is noted on the run as `historyError` — the
verdict still stands. Scheduling itself stays external (cron, CI, a Windows
scheduled task, a Kubernetes CronJob) by design — `packc journey schedule
<name>` prints the ready-made snippet for each from the journey's `schedule:`
(`--format cron|schtasks|actions|k8s`), with secrets only ever as env-var
names, and the opt-in [`deploy/k8s-journeys`](deploy/k8s/README.md) overlay
runs `journey run --all` as a CronJob against the studio's workspace PVC.
`notify:` posts a run to a webhook only when it says something new
(`transitions`: outcome changed, a chain got worse, a new candidate cause, the
vantage changed; `breach`; `always`) — the outcome lands on the record as
`notify` and never changes the exit code. Each record of a live run also keeps the stack
self-metric samples it saw (`stackEvidence`: the rows, plus the Alertmanager
and Grafana status the MCP answered) — point-in-time signals kept per run so
the history is the time series, never a verdict.

The `stack:` gate block turns those samples into an early warning: `rows`
declares a `min` / `max` band per row id (validated against the table when
the journey loads — an unknown id is refused with the known ids listed), and
`requireSampled: true` breaches when the tier could not sample at all, or
sampled with no row answering data. A threshold can only be checked against
a row that answered data; a row that was empty, failed, not in the
inventory or absent breaches as *no sample* rather than passing by absence
(on a restricted tier the breach carries the tier reason), and a threshold
that is not a finite band breaches as *threshold invalid* instead of
passing silently. A stack breach reads
`scrape_targets_down = 2 count outside [-∞ … 0] — point-in-time sample, not
an SLO verdict`: it is a signal to look, not an SLO verdict, and it never
touches the grade. The report prints the samples in a *Stack self-metrics*
table and `journey list` shows `stack sampled N` / `stack not attempted` /
`stack none` per journey (a definition that fails to load prints why instead
of looking never-run). In the studio (Advanced → Neuron, the journey cards) each card
carries a "stack self-metrics — point-in-time samples" line: one chip per
family with the last run's value — the row with a `nonzero` signal first,
then lower-is-comfortable rows, so a healthy-looking ratio never hides a
target that is down — a muted `nonzero` marker where a
lower-is-comfortable row is above zero, `nonzero in N of last M runs` over
the fetched history, and a single muted chip with the reason when the tier
could not sample — chips never carry an ok/error colour, because a sample
is a signal, not a verdict.

**Inventory coverage.** A journey that names a gen-site partition (`inventory: { site:
<partition>/site.json }`, relative to the journey file) compares the site's `expected` sets
(`docs/gen-site.md`: per kind the inventoried names — queue managers, brokers, and hosts where
the module says `up` carries a `host` label — and counted kinds such as queues per queue manager with floors) against the live `up` series read
through the MCP's metrics query tool, once per kind. The record carries
`inventory: { status, reason, kinds }`: per enumerated kind *up*, *down* (targeted, every
target down), *silent* (no `up` series at all — the site's own Silent alert asks the same
question in Prometheus), *unexpected* (answering but not inventoried) and a coverage
percentage; per counted kind the live count per parent against the floors. A file-sourced
Pack B is `not-attempted` (no live series), an MCP without the tool `not-attempted` with the
tier reason, an unreadable site `failed` with the reason, a `kinds` entry the site does not
declare `failed` naming it, and a kind whose query failed `failed` with no numbers (a failed
query is not an outage of every name). `gate.inventory` turns it into a
verdict: `requireChecked` (default `true`) breaches when coverage could not be checked,
`maxSilent` / `maxDown` / `maxUnexpected` / `minCoveragePct` per enumerated kind, and a
counted kind's floors breach whenever undercut; `kinds` narrows the gate. The report prints an
*Inventory coverage* line and a per-kind table, `journey list` an `inventory 11/12 qmgr …`
segment, `GET /api/journeys` the summary as `lastRun.inventory`, and Advanced → Neuron a
fleet tile, per-kind coverage over time for the journey in focus and the newest record's
table. Coverage never touches the grade or the alignment.

Each run also records its requirement chains: per chain the scored verdict
beside the on-wire *ladder* verdict (is the artefact merely present, doing
its job, or could the vantage not look — `unobserved` means the tier could
not look, never "absent"; nothing scored changes), the degraded nodes with
their *blast radius* (how many SLOs would go blind if that node really died
— structural exposure, not a claim that they are blind), the product
versions seen, and what moved since the previous run with the candidate
causes the evidence can offer — Observogram's own deploys inside the window,
decision-bearing drift, a backend version change, a stack self-metric signal
— ranked by evidence, never a root-cause verdict; a change of the vantage
itself is reported beside them, never as one. `keepLivePack` decides when
Pack B is snapshotted under `runs/<journey>/live/` (by default on the first
run, whenever a chain's verdict moved, on a gate failure, or after a vantage
loss; snapshots are pruned with their records). `journey list`
appends `chains 8/10 intact · ladder 7 healthy · 2 degraded` per journey,
only when a chain got worse `top cause: [observogram-deploy] deploy
dep_x by … touched …`, and whenever the vantage itself moved `vantage
changed: vantage full → partial · …` — named beside the cause, never as
one. In the studio the Diagnose chain cards show the
ladder verdict, name present-but-unhealthy / stale / unobserved nodes and
say `blinds N SLOs` beside a missing or drifted one, and each journey card
under Advanced → Neuron carries a plain-text chains line and a
candidate-cause line — counts and muted markers, no colours.

### Neuron — the monitor of the monitors, as one page

**Advanced → Neuron** reads every saved journey as one instrument. A toolbar
picks the window (the newest 20 / 50 / 100 / 200 runs per journey), the trend
metric (alignment or grade), the journey in focus, and offers **run all**
(every journey in sequence, the studio form of `packc journey run --all`).
Fleet tiles give the last word: journeys (scheduled · notify · stack-gated ·
broken definitions), last outcomes with a pass / gate-failed / vantage-lost
bar, fleet alignment and grade (the mean of each journey's last value, with a
*paired* delta against the run before), requirement chains intact / declared
with the four ladder buckets, journeys whose chains got worse, the widest
exposure across the fleet, delivery sent / failed / skipped, and the journeys
whose last run carried a nonzero lower-is-comfortable stack sample. Six
fleet panels follow — alignment or grade over time per journey (a time axis
when the records carry times; a vantage-lost run is a gap, never a 0), an
outcome heatmap newest-right, breached criteria and candidate-cause kinds over
every run in the window, blind-spot exposure over time (the SLOs the widest
degraded artefact would blind, per journey) and the widest exposures across
the fleet's newest records as stacked bars (SLOs · alerts · other consumers
that would go blind — structural exposure on the requirement graph, never a
claim that they are blind). Then the journey in focus (chosen, or the one that
most needs eyes: a chain getting worse, then gate-failed, then vantage-lost,
then the lowest alignment): alignment and grade per run, the ladder buckets
per run as stacked bars in a neutral ramp, scored vs ladder integrity, run
duration, the blast radius of the newest record (every degraded node of a
declared chain once, with the chains it degrades, as a stacked bar) with the
widest node's exposure per run, one small step chart per stack self-metric row in a single ink
colour (a ring on `nonzero` samples, a hollow marker where the probe did not
answer, the posture-budget note under gated rows), and the newest record
opened up — requirement chains with their degraded nodes and blast radius,
the ranked candidate causes with the vantage beside them, the transition
since the run before, the gate, drift / grade / conformance / freshness, the
stack evidence table with the Alertmanager and Grafana status, the vantage,
backend versions, delivery, and the schedule with its cron / schtasks /
GitHub Actions / CronJob snippets (`GET /api/journeys/:name/schedule`, loaded
on demand). The saved-journey cards close the page. The charts are
zero-dependency inline SVG (`tools/lib/svg-charts.mjs`); the numbers come
from one pure model (`tools/lib/neuron-model.mjs`), so what the page says can
be tested without a browser. The view needs no pack loaded.

### Back Up And Restore The Store

The embedded store (`observogram.db` in the workspace, or wherever
`OBSERVOGRAM_DB` points; [docs/STORE_PLAN.md](docs/STORE_PLAN.md) §3) runs
in WAL mode. **A file-by-file copy (`cp -r`, rsync, tar) taken while any
process has it open is not a backup**, even with `-wal` and `-shm`
included: a checkpoint between two file copies tears it. Safe options:

1. a copy with nothing holding the database — the server stopped, and no
   `npm run users`, `npm run orgs` or `packc store` running;
2. an atomic volume snapshot;
3. with the server running, `packc store backup`:

```bash
packc store backup /backups/observogram-2026-09-24.db
# backup written: /backups/observogram-2026-09-24.db
# store_id: 3f0c… (schema v2, from /app/.observogram/observogram.db)
```

It runs `VACUUM INTO` outside any transaction into `<path>.tmp` and renames
that into place: every committed row, as one rollback-journal file, while
writers stay active. It refuses an existing `<path>`, `:memory:`, and a
path with no database (it never creates one). The backup, like the
database itself, is created `0600`: both hold the users' password records.

The other workspace files (packs, snapshots, journeys, runs,
`deploys.jsonl`, `session-secret`) can be copied live as before. Where the
database lives outside the workspace, a workspace copy alone holds no
users, orgs, memberships or audit.

**Restore** with the server stopped:

```bash
packc store restore /backups/observogram-2026-09-24.db
# restored … -> /app/.observogram/observogram.db
# store_id: 3f0c… (schema v2); previous store_id: 3f0c…
# moved aside: /app/.observogram/observogram.db.pre-restore-20260924T101500123Z
```

It refuses while anything holds the database (switching it out of WAL
needs exclusive access, so even an idle server is caught), checks the
backup is an Observogram store, moves `observogram.db`, `-wal` and `-shm`
aside together under one timestamp, and copies the backup in with the
replaced database's mode and owner, never the backup's (a read-only backup
restores writable; with no previous database it is 0600), switched to
WAL first, so it goes in like a cleanly stopped store and the check also
sees whatever opens it before the next start. The in-use check also
folds a `-wal` left by an unclean stop into the old database and removes
the `-wal` and `-shm`, so the moved-aside copy keeps the crashed
server's last writes; a `-wal` or
`-shm` is moved aside itself (and listed) only when there is no database
file beside it. Never copy a backup over the `.db` alone: a `-wal` left
by an unclean stop would be replayed onto it. To move a
database, move the file with nothing holding it: it carries its
`store_id`. The server opens the store at every start, and its first start
imports `users.json` / `orgs.json`: set `OBSERVOGRAM_DB` before that first
start, so it finds the file where it will stay.

When the workspace's `.store-imported` marker names another store than the
one restored, `restore` still succeeds (exit 0) and prints a warning on
stderr — `the restored store is <id>; <base>/.store-imported names <other>
— the next start refuses until they agree` — see
[Stale Import](#stale-import).

### Upgrade And Roll Back

**Upgrade** to a store build ([docs/STORE_PLAN.md](docs/STORE_PLAN.md) §3):

1. Set `OBSERVOGRAM_DB` first, where the database will stay (on local
   disk; in Kubernetes the `store` claim, see
   [deploy/k8s/README.md](deploy/k8s/README.md)).
2. Start the store build. Its first start imports `users.json` /
   `orgs.json` once, prints the `[store]` report and records what it read
   (the files' SHA-256 in the store, and the `.store-imported` marker in
   the workspace). From this build on it also imports each org root's
   `packs/index.json` once — the pack registry: every pack's label, source
   and times, and the services it names — prints `[store] imported the
   pack registry of N org(s) into <database> (store <id>): …` and records
   the file's canonical SHA-256 (its entries without `lastUsedAt`) under a
   key of its own; the file stays where it is, frozen (an upgrade from
   0.5.0 does only this half). Take a `packc store backup` once it runs.
3. **Schema v2** (GAP batch 2): a store build from this version on migrates a
   v1 database to v2 at its first start — two tables, `verdicts` (a
   reviewer's record per artefact of a registered pack) and `waivers` (a
   service record's time-boxed waivers of conformance findings); every row
   a v1 store held is kept. The door is one-way: a v1 build refuses a v2
   database (`the database is at schema v2, but this build knows up to v1`)
   and `packc store restore` refuses a v2 backup on a v1 build, so take a
   `packc store backup` before the upgrade. `packc store export` writes no
   verdict or waiver (a pre-store build has nowhere to hold them).

**Roll back** to a pre-store build (the image before the store) only this
way. A pre-store build reads `users.json` / `orgs.json`, not the store, so
without the export it runs on the pre-upgrade files: passwords changed
since the upgrade revert, and removed users come back.

```bash
# 1. Take a backup, then stop the server (the export refuses while anything holds the database).
packc store backup /backups/observogram-before-rollback.db
# 2. Export in place: <dir> = the workspace itself (an absolute path, the same as OBSERVOGRAM_WORKSPACE).
packc store export /app/.observogram
# store: /app/.observogram/observogram.db
# export: in place in /app/.observogram (store 3f0c…)
# users.json: /app/.observogram/users.json (3 enabled local users; OIDC users are never written)
# orgs.json: not written (one org at the workspace root, and the deployment never had one)
# index.json: 1 org root — /app/.observogram/packs/index.json (3 packs)
# recorded what it wrote in the store and /app/.observogram/.store-imported: a store build starts on these files without refusing
# note: users revoked in the store stay signed in on a pre-store build until their cookies expire; rotating OBSERVOGRAM_SESSION_SECRET signs everyone out
# 3. Start the pre-store image on the same workspace.
```

To back out before step 3, start the store build again: the export
changed nothing it needs, and it starts on the exported files. Do not
restore the step-1 backup for that: it predates the export (and any move
into `orgs/default`), so its start refuses, saying the files are the
export's. If you did, `packc store restore` the
`<database>.pre-restore-…` copy the restore moved aside (the store
the export wrote); moving the files aside instead starts without the
default org's moved data, while `packc store import --replace` re-imports
the exported files and follows the move.

What the export writes:

- `users.json` — the **enabled local** users, with their password records
  (only once stand-alone sign-in is armed; OIDC users are never written),
  to the recorded `OBSERVOGRAM_USERS_FILE` path or `<workspace>/users.json`.
- `orgs.json` — when the deployment had one, has more than one live org,
  or keeps the default org anywhere but the workspace root: the live orgs,
  their enabled members (an OIDC member by its `sub`, under the recorded
  issuer only) and their roles (`operator` is written as `member`).
- `packs/index.json` — one per live org root (`<root>/packs/index.json`),
  in the shape every earlier build wrote (`{ "<id>": { label, source,
  createdAt, lastUsedAt } }`, times in ms, mode 0644), from the store's
  rows — after reconciling them with the pack files: a `*.pack.yaml` with
  no row is adopted (no label, source `workspace`, the file's mtime; its
  services get rows, actor `cli`), a row whose file is gone is removed on
  positive evidence. So the older build finds every pack with its label
  and has nothing to adopt or prune at its first start. The report's line
  names each path with its pack count and what it adopted or pruned
  (`index.json: 1 org root — <path> (3 packs; adopted a1; pruned b2)`), or
  says `index.json: none (no org holds a pack)`. The export records the
  canonical SHA-256 of each file it wrote (its entries without
  `lastUsedAt`), so the store build starts on it. It refuses, changing
  nothing, an `index.json` whose entries differ from what the store last
  imported or exported (an older build registered, relabelled or removed
  a pack during a rollback — `packc store import --replace` takes them in,
  see Re-upgrade below); one that differs in `lastUsedAt` only is
  overwritten. A `packs/` it cannot list or an index it cannot read
  refuses before any write. A directory export writes no index.
- It is the same membership, not the same access: a pre-store build
  enforces no roles, so every viewer and operator regains full write there
  (the report lists them). It has no owners either: an owner enters only
  the orgs it is a member of there (the report lists each org an owner
  loses; add the owner as a member before exporting to keep it). Disabled
  users are left out; the cookie note above applies to them.
- When it writes `orgs.json` while the default org is at the workspace
  root, a pre-store build would move that org's data into
  `orgs/default/` at its next start, so the export makes the move itself:
  every check first (an `orgs/default/<entry>` that already exists refuses,
  naming each one), then the rename, the default org's journey `file:`
  paths rewritten to the new place, the files written, and the store's
  default-org root set to `orgs/default` in one transaction. It prints
  `the default org's root is now orgs/default — point its CronJobs at
  OBSERVOGRAM_WORKSPACE=<workspace>/orgs/default`. A failure part-way puts
  every step back and says so.
- An in-place export refuses while anything holds the database, on a store
  the server never started (export to a directory instead), and on
  `:memory:`. It also refuses, changing nothing, when the `users.json` /
  `orgs.json` it would overwrite was edited since the store last imported
  or exported it (a second rollback after a pre-store build's changes):
  run `packc store import --replace` and start the server once so the
  store takes the edits in, then export again.
- An in-place export also proceeds only into a workspace that is provably
  this store's: its `.store-imported` marker names this store, or there is
  no marker, this store's database lives inside the workspace and no other
  store's database is in it (every `*.db` directly in the workspace or its
  `db/`, `observogram.db` among them, is opened read-only). With no marker
  and the database outside the workspace (the k8s layout), it refuses: start
  the server once on that workspace, which rewrites the marker, then export.
  A workspace that does not exist is refused. A marker naming another store, or such a database holding
  another store, is refused naming both stores and the command that
  exports that workspace's own store; a `*.db` that cannot be read is
  refused naming it (move it out, then export again). A corrupt marker is
  refused naming it: with the server stopped, move it aside
  (`mv <workspace>/.store-imported <workspace>/.store-imported.corrupt`),
  then run the export again.
- `packc store export <dir>` to any other directory only reads the
  database (safe while the server runs) and writes only into a directory
  that does not exist or is empty (a symlink is followed, and what it
  names must be absent or empty). Anything else is refused, changing
  nothing: choose an empty or new directory — or, if it is this store's
  workspace, stop the server and run
  `OBSERVOGRAM_WORKSPACE=<workspace> packc store export <workspace>` to
  export in place. A directory inside the workspace, or one holding it,
  is refused naming the in-place export. With `OBSERVOGRAM_DB` outside
  the workspace (as on k8s), export to a new directory beside it, such as
  `/data/db/export-$(date +%Y%m%d%H%M%S)`.

**Roll back to 0.5.0** (the first store build: it holds the same database
but keeps the pack registry in `packs/index.json`) the same way: stop the
server, `packc store export <workspace>` in place as above — it writes
each org root's `index.json` from the store's rows, so 0.5.0 finds every
pack with its label and has nothing to adopt (while this build has never
completed a start on the store, the registry is still only in the file
and the export refuses naming it: start the server once first, or roll
back without the export) — then start the 0.5.0 image
on the same `OBSERVOGRAM_DB` and workspace. It needs no `users.json` /
`orgs.json` (it reads the store; the export's files are harmless to it)
and restarts as often as needed: it reads and rewrites `index.json` as it
always did, and the hash this build keeps for the index lives under a key
of its own (`pack_index_hashes`) that 0.5.0's stale-import check never
reads, so its own rewrites never make it refuse. Without the export,
0.5.0 starts on the `index.json` frozen at the upgrade: a pack registered
since has no entry there, so 0.5.0 adopts its file unlabelled (listing it
by name) and writes that adoption into the file — an entry with no label
and source `workspace` records nothing the store does not know, so the way
back starts with the bookkeeping line below and the store's label stands.
On the way back (stop 0.5.0, start this
build): a rollback that only **read** packs (0.5.0 rewrites `lastUsedAt`
on every read) or restarted starts, with one log line — `[store] <path>
was rewritten by a build before slice 4 (lastUsedAt only — bookkeeping,
not a change); the store's registry stands` — no row or file written,
only the file's new byte hash recorded under `pack_index_hashes` so the
line is said once, not at every start; one
that only **adopted** files the same, with its own parenthesis — `(it
says exactly what the store holds — bookkeeping, not a change)`; one
that **registered, relabelled, removed or RESET** packs refuses (see
[Stale Import](#stale-import)): `packc store import --replace` takes the
file's entries into the store, or put the file back, or move it aside.

**Re-upgrade** after a rollback: stop the pre-store build and start the
store build again.

- **Nothing changed** on the pre-store build: the store build starts on the
  exported files without refusing.
- **Users or orgs changed** on the pre-store build (its `npm run users` /
  `npm run orgs`), or **packs changed** on it or on 0.5.0 (a pack
  registered, relabelled, removed or RESET): the start refuses (see
  [Stale Import](#stale-import)). With the server stopped, request a
  replace, then start:

```bash
packc store import --replace
# store: /app/.observogram/observogram.db
# replace requested: the next server start re-imports users.json/orgs.json and each org's packs/index.json with the unit's environment
```

The next start re-imports the files as they stand, with the unit's own
environment (its OIDC issuer and users file, which the shell that asked
may not have), prints a `[store] replaced from …` report and writes one
`store.replace` audit row. It keeps the audit, and:

- **Users**, when a users file is present: a local user absent from it is
  disabled; one in it is updated (password, flags, name, email) and
  re-enabled if disabled; a new one is created. Without a users file the
  local users are kept. An OIDC user is never disabled for being absent.
  The owner flag is never re-derived. Every changed or disabled user is
  signed out (their old cookies are refused).
- **Orgs**, when an `orgs.json` is present: orgs are created or renamed to
  match, memberships follow the file exactly, and a store org absent from
  it is removed (never the default org). A removed org that reappears is
  a conflict, skipped and reported. Without an `orgs.json` the orgs and
  memberships are kept.
- **The default org's root.** On a flat deployment (exported without an
  `orgs.json`), `npm run orgs -- create <id>` and a restart on the
  pre-store build move the default org's data into `orgs/default/`; the
  replace follows it: the store's default root becomes `orgs/default`
  (journey `file:` paths rewritten, empty leftovers of the pre-store build
  removed, the CronJob line printed as for the export; a store start with
  no replace also removes an empty flat directory a pre-store restart left
  beside `orgs/default/`, and logs it; one it cannot remove is a warn
  line, never a failed start). Its memberships follow the file too: the `default`
  entry a pre-store migration writes has no members, so the replace
  removes the default org's memberships (the report lists them) and only
  owners reach it; the others get `no org membership — ask an admin to add
  you` until `npm run orgs -- add-member default <login>`.
- **Packs**, from each live org root's `packs/index.json` as it stands —
  the rolled-back build's record: a pack file with no row is added with
  the entry's label and source (without an entry: adopted, no label), a
  row whose entry carries another label or source takes the file's (a
  `pack.update` row), a row whose file is gone is removed on positive
  evidence (the listing succeeded and the file is absent); a corrupt index
  keeps the store's labels, and files without a row are still adopted.
  The report line: `[store]   packs: <org>: added a1 · relabelled b2 ·
  removed c3 (file gone)` (`· index.json corrupt (<reason>; labels kept
  from the store)` when it is). An index or a `packs/` it cannot read
  refuses before any write, and the request stays pending. Services,
  environments and their links are kept (a new pack may add rows). The
  recorded index hashes are rewritten to the files as they stand.
- It refuses, and moves nothing, when a flat entry with data sits beside
  its `orgs/default/` twin, when a rewritten journey would no longer
  parse, or when it would leave no enabled owner who can sign in under the
  unit's mode (put an owner back into the users file, or make a kept user
  owner with `npm run users -- owner <login>` — a user only the files
  hold needs `npm run users -- add <login> --org <org>` first). The
  request stays pending through every refusal.
- `packc store import` without `--replace` is a usage error: the first
  start of the server is what imports.

**Without an export** (the image was already rolled back): the pre-store
build ran on the pre-upgrade files, and the store still holds everything
the store build wrote. Re-upgrading starts on the store as it was if those
files are unchanged, and refuses if they changed, with the same ways out.

### Stale Import

A store build checks, at every start and before it moves, seeds or
imports anything, that the store and the workspace's legacy files still
belong together. Each refusal says `Nothing was …` and names its ways out:

- **The marker names another store** (a deleted database,
  `OBSERVOGRAM_DB` pointed at a new path, a restore of another
  deployment's backup): point `OBSERVOGRAM_DB` at that store or a copy of
  its backup; `packc store restore <backup>` with the server stopped; or
  move `.store-imported` aside, which accepts the files as they stand (the
  next start imports them, or with no files left starts a new store). On
  a store that was imported already, the next start imports nothing: it
  compares the files with that store's record, as below.
- **The OIDC issuer changed:** set `OBSERVOGRAM_OIDC_ISSUER` back to a
  spelling of the recorded key, or `packc store rekey-issuer` (below).
- **A replace requested for another store**, or with the marker missing:
  point `OBSERVOGRAM_DB` at the right store, restore, then run
  `packc store import --replace` again (or put the marker back).
- **`users.json` / `orgs.json` edited after the import or the export:**
  put the file back exactly as it was (the refusal prints the SHA-256),
  move it aside and make the change with `npm run users` /
  `npm run orgs`, or `packc store import --replace`. The request needs
  the marker: with it missing, move the files aside, start once (the
  start rewrites the marker), stop, put them back, then request it.
  After a restore of a backup taken before an in-place export, the
  refusal says the files are the export's and names the database the
  export wrote (see [Upgrade And Roll Back](#upgrade-and-roll-back)).
- **`packs/index.json` changed after the import or the export** — compared
  per org root, **without `lastUsedAt`**: an older build rewrites that
  field on every pack read, and a read is not an edit, so that rewrite
  is logged — `[store] <path> was rewritten by a build before slice 4
  (lastUsedAt only — bookkeeping, not a change); the store's registry
  stands` — and never refused. A file that says exactly what the store
  holds (an entry the older build only adopted, no label and source
  `workspace`, for a pack the store holds counts as the store's row) is
  logged the same way with its own parenthesis — `(it says exactly what
  the store holds — bookkeeping, not a change)` — and never refused. An
  entry added, dropped or relabelled is: `<path> changed since
  store <id> last imported or exported it: a build before slice 4
  registered, relabelled or removed a pack during a rollback (the registry
  it wrote: 4 entries, the store's: 3)`. Its ways out, with the server
  stopped: `packc store import --replace` (the next start takes the file's
  entries into the store — labels and sources from the file; packs it no
  longer lists are removed on positive evidence); put the file back as it
  was (the refusal prints the canonical SHA-256: its entries without
  `lastUsedAt` — or, for a file that was corrupt when recorded, the
  SHA-256 of its bytes); or move it aside (the store's registry stands; the
  rollback's registrations are then adopted from their pack files with no
  label). An index that appeared in a root the store had recorded as
  having none is refused too, with its own first line — `<path> appeared
  since store <id> imported the pack registry (that root had no index.json
  then): a build before slice 4 registered, relabelled or removed a pack
  during a rollback (the registry it wrote: 1 entry, the store's: 0)` —
  and two ways out: `packc store import --replace`, or move it aside
  (there was no file to put back). One that says exactly what the store
  holds passes, logged as `[store] <path> was rewritten by a build before
  slice 4 (it says exactly what the store holds — bookkeeping, not a
  change); the store's registry stands`. Only roots whose
  hash is recorded are compared; a root that never had an index gets its
  key at the next export. An
  `index.json` the server cannot read (anything but absent) aborts the
  start naming the path, before any write — on a store's first start,
  after the identity import committed; the next start imports only the
  packs.

A marker or legacy file that disappeared is repaired and logged, not
refused. `packc store restore` warns (above) when the marker names another
store than the one it restored.

### Move The OIDC Issuer

OIDC users are recorded as `<issuerKey>#<sub>`, so a start whose
`OBSERVOGRAM_OIDC_ISSUER` canonicalises to another key refuses. With the
server stopped:

```bash
packc store rekey-issuer --to https://login.example.com/realms/new   # the same IdP (same subs) at a new URL
packc store rekey-issuer --clear                                     # a different IdP
```

- `--to` rewrites every OIDC login to the new key, keeping each user's
  row, roles, memberships and owner flag (it refuses when a rewritten
  login already exists). Store sessions signed in under the old key end;
  a fresh sign-in finds the same row. Set `OBSERVOGRAM_OIDC_ISSUER` to a
  spelling of the new key before the next start.
- `--clear` disables every OIDC user (they keep their owner flag, disabled)
  and forgets the issuer; the next start records the new one. Set
  `OBSERVOGRAM_BOOTSTRAP_ADMIN` before that start to name the new owner.
- Both write one `issuer.rekey` audit row; earlier audit rows and
  `deploys.jsonl` keep the old logins. A pending `import --replace` stays
  pending and runs under the new key.

### Purge A Removed Org

`npm run orgs -- remove <id>` soft-removes an org: its files under
`orgs/<id>/` stay, and the command prints the way to delete them. With the
server stopped:

```bash
packc store purge-org acme
```

It deletes `orgs/<id>/` and drops that root's entries from the store's
legacy hashes and its pack index hashes (`dropped from pack_index_hashes:
orgs/<id>/packs/index.json`), writes one `org.purge` audit row and
rewrites the marker.
It runs only on a removed, non-default org whose root is `orgs/<id>`, and
refuses a root that is a symlink or resolves outside `<workspace>/orgs`,
and a workspace whose marker names another store. The org row stays, so
its id is never reused.

**The purge cannot be undone and asks for no confirmation.** It deletes
everything under `orgs/<id>/` at once: the org's packs, its
`deploys.jsonl` (that org's deploy audit), its rollback `snapshots/`, its
`runs/` and its `journeys/`. A `packc store backup` holds only the
database, not these files, so copy `<workspace>/orgs/<id>/` first if any
of it may be needed again.

## API Surface

Every route's class — public, self, viewer, operator, admin, owner — is in
[`server/route-table.mjs`](server/route-table.mjs) (see [Roles](#roles)).
Below, `/healthz`, `/api/version`, `/` and `/index.html` are `public` and
`/auth/signout-others` is `self`; `/api/org` and every `/api/org/…` route are `admin`, every
`/api/admin/…` route `owner` (see [The Identity API](#the-identity-api)),
and every `/api/mcp-endpoints` route but its `GET` is `admin` (an endpoint
record is where the server will send the org's read token: its changes take
the identity API's defences — the `X-Observogram-CSRF: 1` header in every
posture, closed on an exposed server without sign-in); `GET /api/audit` is
`admin` (the org's rows; an owner reads the deployment's; closed in the
open, exposed posture — see [The Audit](#the-audit)); every other `GET` is
`viewer` and every other route `operator`.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health and vendored spec version |
| `GET` | `/api/version` | Which build is this: version, build (commit count), commit, branch, dirty, date, shallow, source, label — public, no-store |
| `GET` | `/` | The studio shell (`studio/index.html`) — the file as shipped, or its branded rendering when `OBSERVOGRAM_BRAND_FILE` / `OBSERVOGRAM_BRAND_*` is set (see Rebadging); every non-`/api` path the router does not know answers the same |
| `GET` | `/index.html` | The same shell by name |
| `GET` | `/api/packs` | In-memory and catalog pack registry |
| `GET` | `/api/examples` | Bundled example packs |
| `GET` | `/api/taxonomy` | The artefact taxonomy override the server was started with (`OBSERVOGRAM_TAXONOMY`): `{ ok, taxonomy, configured }` — the document or `null`, never its path; no-store |
| `GET` | `/api/references` | Curated catalogue reference packs |
| `GET` | `/api/packs/:id` | Adapted layered pack |
| `GET` | `/api/packs/:id/canonical` | Canonical pack with env overlay |
| `GET` | `/api/packs/:id/verdicts` | A reviewer's verdicts on the pack's artefacts (GAP batch 2): `{ ok, pack, verdicts[], summary }` — each `{ artefact, key, family, title, status, reason, actor, setAt, carriedFrom }`, `status` one of `trusted`, `suspect`, `failed`; `unreviewed` is the absence of a record; a catalogue pack answers the empty document (`?env=` is ignored: verdicts are per pack) — see [Record Verdicts](#record-verdicts) |
| `GET` | `/api/packs/:id/conformance` | Maturity-rubric scoring (the rubric grades what is declared, placeholders included; `npm run pack-conformance` lists the placeholders) (`onPlaceholder` when the pack carries `library.todo.*` annotations), graded at the service record's tier when one is set (the environment's for `?env=`, else the service's): `declaredTier` is the graded tier, `tier.pack` the pack's own, `tier.mismatch` says they differ; a pack with no record (a catalogue pack, a service without a tier) is graded at its own tier, `tier.from: 'pack'` |
| `GET` | `/api/diff?a=&b=` | Repo/live or pack/pack structural diff |
| `GET` | `/api/packs/:id/compile-catalog` | Per-artifact compile tree |
| `GET` | `/api/packs/:id/compile-artifact` | Compile one artifact or group |
| `POST` | `/api/validate` | Validate and register uploaded YAML/JSON (`summary.onPlaceholder` when the pack carries `library.todo.*` annotations) |
| `GET` | `/api/library` | The pack library index (`entries`, `scaffoldParams`, `errors`: the files that did not load) — the BUILD journey's DEFINE step |
| `GET` | `/api/library/requirements/:tier` | The conformance clauses that apply at a tier (the rubric filtered by `minTier`; 400 names the known tiers) |
| `GET` | `/api/library/:id` | One library entry: its index row plus the full SLI templates and params (404 names the known entries) |
| `POST` | `/api/library/instantiate` | `{ entries, name, tier, environment, owners, params, toggles }` → `canonical`, `canonicalYaml`, `todos`, `provenance`, `warnings`, `schemaErrors`, `summary`, `conformance`, `adapted` (the adapter's layered projection, as `/api/validate` returns it — what Build's stack draws; an engine usage error is 400, never 500) |
| `POST` | `/api/library/compile` | `{ canonical, target }` → one compiled artefact (`label`, `contentType`, `artifact { filename, content, warnings, profile }`), nothing registered |
| `POST` | `/api/library/register` | `{ canonical, source? }` → the upload registry as `/api/validate` registers (`registered { id, source }`, `adapted`, `conformance`, `summary`; the source defaults to `library:<entries>@<tier>` for a library-built pack, `metadata.name` otherwise) — VERIFY's "Open pack in Discover" |
| `POST` | `/api/crawl` | Draft a pack from uploaded repo files |
| `POST` | `/api/crawl-github` | Draft a pack from a GitHub URL |
| `POST` | `/api/draft-from-mcp` | Draft a live pack from an MCP endpoint: `mcpUrl` (and `mcpAuth`), or `mcpEndpointId` — one of the org's MCP endpoint records, its read token from the variable the record names when the request sends none; the answer's `mcpEndpoint` says which |
| `POST` | `/api/packs/:id/deploy-bulk` | Deploy selected compiled artifacts (`mcpUrl` or `mcpEndpointId` for the URL; the write token is the request's `mcpAuth`); an audit row: `deploy.bulk` |
| `POST` | `/api/packs/:id/deploy/:target` | Deploy one compiled target (`mcpUrl` or `mcpEndpointId` for the URL; the write token is the request's `mcpAuth`); an audit row: `deploy.run` |
| `GET` | `/api/deploys?pack=&limit=` | The org's deploy records from `deploys.jsonl`, newest first, the latest verify merged in; `actor` is the deployer's login (an OIDC deployer as `<issuerKey>#<sub>`), the bearer's label or `local` |
| `POST` | `/api/deploys/:deployId/verify` | Record a post-deploy verification (`outcome`, `alignment`, `attempts`, `summary`, …) against a deploy; an audit row: `deploy.verify` |
| `POST` | `/api/deploys/:deployId/rollback` | Roll a deploy back from its snapshot (`mcpUrl` or `mcpEndpointId` for the URL; the write token is the request's `mcpAuth`); an audit row: `deploy.rollback` |
| `DELETE` | `/api/uploads` | Clear uploaded/crawled/drafted packs |
| `GET` | `/api/journeys` | Saved journeys with their `schedule` (parsed: `cron`, `timezone`, `every`, `cadenceMs`, `cadenceNote`), `stackBudget`, `notify` (env-var names + policy, never a URL) and the last run (outcome, alignment, grade, breaches, `stack` summary, `chains` summary, `transition` counts, `topCause`, `vantageChanged`, `notify` `{ status, httpStatus, reason }`, `inventory` `{ status, reason, environment, kinds }`) |
| `GET` | `/api/journeys/:name/runs?limit=` | Run history, newest first (the drift-over-time series) |
| `GET` | `/api/journeys/:name/schedule` | The parsed `schedule:` and the cron / schtasks / GitHub Actions / CronJob snippets (env var names only; `placeholder: true` without a schedule) |
| `POST` | `/api/journeys/:name/run` | Run a saved journey now; an audit row: `journey.run`, on a failed run too |
| `POST` | `/api/journeys/capture` | Freeze the current A/B session as a journey file; an audit row: `journey.capture` |
| `POST` | `/api/refresh-live` | Fetch the org's live pack from an MCP endpoint (`mcpUrl` or `mcpEndpointId`); an audit row: `live.refresh` |
| `GET` | `/api/services` | The org's service records, by slug, each with its environments (their MCP endpoint as `{ id, name, origin }`) and the packs linked to it (`id`, `label`, `source`, `role`) |
| `POST` | `/api/services` | A service record (201): `{ name, slug?, owners?, tier?, description? }`; the slug defaults to the name's key and is fixed; `tier` is `tier-1`, `tier-2`, `tier-3` or `null` (graded by the pack) |
| `GET` | `/api/services/:id` | One service record with its environments and packs |
| `PATCH` | `/api/services/:id` | Changes `name`, `owners`, `tier`, `description` (`changed` lists what differed; nothing → no audit row) |
| `DELETE` | `/api/services/:id` | Removes the service with its environments and pack links (the packs stay registered; registering a pack that names the service re-creates it) |
| `GET` | `/api/services/:id/environments` | The service's environments |
| `POST` | `/api/services/:id/environments` | An environment (201): `{ name, tier?, bindings?, endpoints?, mcpEndpointId? }`; `endpoints` are links every member may open — never put a token in one |
| `GET` | `/api/environments/:id` | One environment with its service |
| `PATCH` | `/api/environments/:id` | Changes `name`, `tier`, `bindings`, `endpoints`, `mcpEndpointId` (`null` unbinds) |
| `DELETE` | `/api/environments/:id` | Removes an environment |
| `PUT` | `/api/packs/:id/verdicts/:artefact` | Records a reviewer's verdict on one artefact of a registered pack: `{ status, reason? }` → `{ ok, verdict, changed }` (`changed` lists what differed; the same status and reason again writes no row); a catalogue pack is 409, an unknown artefact 404; an audit row: `verdict.set` |
| `DELETE` | `/api/packs/:id/verdicts/:artefact` | Clears it (the artefact is unreviewed again) → `{ ok, cleared }`; an audit row: `verdict.clear` |
| `GET` | `/api/mcp-endpoints` | The org's MCP endpoint records, by name: `id`, `name`, `origin`, how many environments are checked through each; `url` and `readTokenEnv` to operators and above, `null` to a viewer |
| `POST` | `/api/mcp-endpoints` | An MCP endpoint record (201): `{ name, url, readTokenEnv? }` — the URL carries no credential (a query parameter named like one is refused by name), `readTokenEnv` names a variable of this org, `OBSERVOGRAM_ORG_<ORG>_<NAME>` |
| `PATCH` | `/api/mcp-endpoints/:id` | Changes `name`, `url`, `readTokenEnv` (`null` clears it; `changed` lists what differed) |
| `DELETE` | `/api/mcp-endpoints/:id` | Removes an MCP endpoint record; the environments checked through it stay, unbound (`unbound` lists their ids) |
| `GET` | `/api/admin/users` | Every user, disabled ones too, with their memberships — never a password |
| `POST` | `/api/admin/users` | Create a local user (201) |
| `POST` | `/api/admin/users/:id/disable` | Disable a user: every session ends |
| `POST` | `/api/admin/users/:id/enable` | Undo a disable |
| `POST` | `/api/admin/users/:id/password` | Set a temporary password: changed at the next sign-in, every session ends |
| `POST` | `/api/admin/users/:id/signout` | Sign a user out everywhere |
| `PUT` | `/api/admin/users/:id/owner` | Grant or revoke owner (`{"owner": true \| false}`) |
| `GET` | `/api/admin/orgs` | Every org, removed ones too, with its member count |
| `POST` | `/api/admin/orgs` | Create an org (201); the caller is its first admin |
| `DELETE` | `/api/admin/orgs/:id` | Remove an org (soft: its files stay) |
| `GET` | `/api/admin/join-role` | The default-org role of a new IdP user |
| `PUT` | `/api/admin/join-role` | Set it (`admin` needs `"confirm": true`) |
| `PATCH` | `/api/org` | Rename the request's org |
| `GET` | `/api/org/members` | The request's org and its members |
| `POST` | `/api/org/members` | Add an existing user by login or verified email (201), or change a member's role |
| `PATCH` | `/api/org/members/:userId` | Change a member's role |
| `DELETE` | `/api/org/members/:userId` | Remove a member |
| `GET` | `/api/audit?scope=&actor=&action=&kind=&targetKind=&targetId=&since=&until=&limit=&before=` | The org's audit rows, newest first (admins; an owner reads every org's and the deployment's with `scope=all` or `scope=deployment`); `next` pages. Closed in the open, exposed posture ([The Audit](#the-audit)). |
| `POST` | `/auth/signout-others` | Sign out my other sessions: this browser's cookie is re-issued, every other one refused |

## Repository Map

```text
server/
  index.mjs                Express API, upload registry, compile/deploy routes
  library.mjs              Loads library/**/*.library.yaml from disk (the Node side of the BUILD engine)
  boot.mjs                 The boot order: opens the store, imports users.json / orgs.json once, the seed and the fail-closed checks
  identity-admin.mjs       The user and org rules behind npm run users / npm run orgs
  service-admin.mjs        The service, environment and MCP endpoint rules behind /api/services, /api/environments and /api/mcp-endpoints; the tier rule; an MCP target picked by id
  verdict-admin.mjs        The verdict rules behind /api/packs/:id/verdicts (GAP batch 2): the artefact index, the views, the carry on a label re-registration
  routes/                  The identity API (identity.mjs), the services API (services.mjs), the verdicts API (verdicts.mjs), the deploy routes, and the handler helpers they share (util.mjs)
  store/                   The embedded store (docs/STORE_PLAN.md): db.mjs (the one node:sqlite door), migrations, repositories, the legacy import and import --replace, backup/restore, ops.mjs (export, the replace request, rekey-issuer, purge-org)
  fixtures/                What the suites share: serve-child.mjs (a hermetic child server, the STRIP list), platform.mjs (isWin32, the reasoned win32 skips), pre-store-build.mjs, route-inventory.mjs, store-050-guard.mjs
  test-smoke.mjs           End-to-end route smoke tests

studio/
  app.mjs                  Browser app shell and three-step workflow
  compare-view.mjs         Assessment (diagnostic grade), Compare, drift, traceability
  compile-view.mjs         Remediate, compile catalog, deploy surfaces
  layers-view.mjs          Discover Observogram and artifact cards
  brand.mjs                The studio's brand: reads the shell's #brand-config, loads /lib/brand.mjs the house way, hands state.brand its chrome strings
  neuron-view.mjs          Advanced → Neuron: fleet tiles, trend / heatmap / bar panels, the journey in focus, the newest record opened up
  journeys-view.mjs        Saved journeys: capture, run-now, history, stack chips, chains + cause lines (the cards Neuron composes)
  static-backend.mjs       The static bundle's backend in the browser: the read-only pack routes from tools/lib, 501 no-backend for the rest, the Export download, the notice (bundle-only; the live studio never imports it)
  build-model.mjs          The BUILD journey's pure models (define / compile / verify, the stack, the definition column, the layer sheet, the clause checklist's three states, step reachability)
  build-api.mjs            The BUILD journey's loaders over /api/library/* (fetchFn injectable)
  build-definition-view.mjs  BUILD — the definition column on every step (service, the tier as a segmented control, the entries as chips, the conformance summary)
  build-sheet-view.mjs     BUILD — the per-layer sheet (the layer's question and clauses, the L1 SLI rolodex, the section switches, the params, the lists; preview · edit · verify)
  build-stack-view.mjs     BUILD — the layer stack of the pack being compiled (Discover's cards; a slab head opens its sheet)
  build-define-view.mjs    BUILD step 1 — Define (the silhouette) + the step head and error note the three steps share
  build-compile-view.mjs  BUILD step 2 — Compile (the live stack, the warnings, the pack YAML)
  build-verify-view.mjs  BUILD step 3 — Verify (readiness states, what remains, the stack with its todos, artefacts, Open pack in Discover)

tools/
  cli.mjs                  packc CLI (journey run / list, compile, init, store backup / restore, …)
  crawl-repo.mjs           CLI repo crawler
  fetch-live-pack.mjs      MCP live-pack fetcher
  build-studio-bundle.mjs  The studio as one static HTML file: an import map of data: modules, inlined stylesheets, the packs (npm run build:studio)
  pack-init.mjs            packc init: build a pack from the library (list / show / instantiate)
  test-build-model.mjs     The BUILD journey's studio models over captured API responses (tools/fixtures/build/)
  test-platform.mjs        The Windows support statement's Linux-runnable proofs: fileURLToPath over URL.pathname, the T1 separator idiom, the platform fixture, and the guards (no URL.pathname as a path, 'win32' only in the fixture, every skip reasoned and counted in README "Platforms")
  test-doc-test-totals.mjs The `Tests: a → b` totals in docs/UPDATE_JOURNEY.md chain within a section and agree with docs/CHANGELOG.md's Unreleased pairs and with the batch delivery report (docs/DELIVERY-*.md)
  validate-pack.mjs        Canonical pack validator
  pack-conformance.mjs     The placeholders a pack still carries: path, field, what it needs, where it comes from (--json, --strict)
  upconvert-legacy.mjs     Layered JSON -> canonical; idempotent, merges into an existing output (--merge, --overwrite)
  lib/
    adapter.mjs            Canonical pack -> layered UI model
    blast-radius.mjs       Blind-spot blast radius over the requirement graph (zero-import, vendorable)
    brand.mjs              The one brand config: DEFAULT_BRAND (today's Observogram), normalizeBrand, the chrome / shell / token renderers (zero-import, vendorable)
    brand-env.mjs          OBSERVOGRAM_* / TOMOGRAPH_* env names, the workspace root, loadBrand() (node-only)
    chain-history.mjs      Requirement-chain records per run, transitions, candidate causes (zero-import, vendorable)
    compile.mjs            packc compiler
    conformance.mjs        Maturity rubric
    diff.mjs               Structural pack diff
    journey.mjs            Journey definitions, runner, gate, run history (node-only)
    legacy.mjs             Layered-JSON upconvert and the merge-safe re-run (mergeUpconvert); imports pack-conformance.mjs
    library.mjs            The BUILD journey engine: entries, tier scaffold, instantiation, todos, provenance (browser-safe)
    pack-conformance.mjs   Scaffold markers -> {path, field, needs, source, hint} rows; the adapter's symbol grammar (zero-import, vendorable)
    stack-evidence.mjs     Stack self-metric history helpers (browser-safe, vendorable)
    traceability.mjs       Requirement chains

examples/
  production-curated.pack.yaml
  target-advanced.pack.yaml
  demo-skeleton.pack.yaml

vendor/observability-pack-spec/v1.4/examples/
  payment-service.pack.yaml

reference-packs/
  kafka.pack.yaml
  prometheus.pack.yaml
  grafana.pack.yaml

library/                   The pack library packc init builds from (docs/BUILD_JOURNEY.md, library/README.md)
  products/                kafka · prometheus · grafana · ibm-mq · alertmanager · loki · tempo · otel-collector (.library.yaml)
  archetypes/              http-service · queue-consumer (OTel semconv v1.27.0)

deploy/k8s/
  kustomization.yaml       Kustomize entry point (see deploy/k8s/README.md)
  pvc-store.yaml           The studio's RWO store volume: database and workspace (docs/STORE_PLAN.md §3)
```

## Key Docs

- [`docs/HANDOVER.md`](docs/HANDOVER.md) - hand-over note for the next session: where the three repos stand, the maintainer's working rules, the backlog and the known debts (2026-09-24)
- [`docs/STORE_PLAN.md`](docs/STORE_PLAN.md) - the embedded `node:sqlite` store for users, orgs, services, environments and the audit: schema, import from today's files, roles, slices and gates (decisions ratified 2026-09-24)
- [`docs/NEURON_FLEET_PLAN.md`](docs/NEURON_FLEET_PLAN.md) - the fleet in Neuron: one service registry per org (Kubernetes Services, Backstage or Consul), live SLO state through the MCP, the SLO ledger and the fleet map (proposed, for ratification)
- [`docs/USER_JOURNEY.md`](docs/USER_JOURNEY.md) - product journey and design invariants
- [`docs/DRY_RUN.md`](docs/DRY_RUN.md) - dry-run script and readiness checklist
- [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) - V1 release gate
- [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) - live fetch, verification, deploy writes
- [`docs/MODEL.md`](docs/MODEL.md) - the layered observability model (L1–L5, L2X, GOV)
- [`docs/DIFF.md`](docs/DIFF.md) - structural alignment and drift model
- [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) - maturity rubric scoring
- [`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md) - the BUILD journey (Define · Compile · Verify): the pack library, the tier scaffold, placeholders and provenance, the engine API and `packc init`
- [`docs/DIAGNOSTIC_GRADE_FRAMEWORK.md`](docs/DIAGNOSTIC_GRADE_FRAMEWORK.md) - the eight coverage/trust criteria behind the Diagnose grade
- [`docs/PHASE_1_VERDICT_TRUST_RESEARCH.md`](docs/PHASE_1_VERDICT_TRUST_RESEARCH.md) - draft research/spec for the verdict-trust phase
- [`docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md`](docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md) - requirement-chain comparison semantics
- [`docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md`](docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md) - proposal (not applied) for Drift-free to read the per-node ladder integrity
- [`docs/USER_STORY_CRAWLER_PROVENANCE.md`](docs/USER_STORY_CRAWLER_PROVENANCE.md) - provenance requirements for deployable artifacts
- [`docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md`](docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md) - backlog story for required crawl environment selection
- [`docs/ADVANCED_FEATURE_AUDIT.md`](docs/ADVANCED_FEATURE_AUDIT.md) - per-view audit of the Advanced tools (References · Conformance · Schema · OTLP · Traceability · Atlas)
- [`docs/VALUE_BACKLOG.md`](docs/VALUE_BACKLOG.md) - prioritized product backlog for the next iterations
- [`docs/gen-site.md`](docs/gen-site.md) - gen-site: inventory v1, the module contract, the timing model and the CLI that renders one partition per environment
- [`docs/REFACTORING_PLAN.md`](docs/REFACTORING_PLAN.md) - maintainability refactor backlog from the 2026-06 audit
- [`docs/BRANCHING.md`](docs/BRANCHING.md) - the branching model: lanes, per-commit bar, multi-writer rules, promotion cadence
- [`docs/VENDORING.md`](docs/VENDORING.md) - vendoring the verdict/diff engines into a downstream studio, and how to stay current
- [`docs/DOWNSTREAM.md`](docs/DOWNSTREAM.md) - vendoring the pure libraries by manifest (`VENDOR-MANIFEST.json`): snapshot → verify hashes → smoke → bump
- [`docs/UI_CONVENTIONS.md`](docs/UI_CONVENTIONS.md) - studio view-module conventions: the host seam, loader/renderer split, render signatures, CSS zones
- [`docs/DELIVERY-REBADGE-BATCH2.md`](docs/DELIVERY-REBADGE-BATCH2.md) - delivery report for rebadge batch 2, PR 1 (B1, B2, B4): what shipped per item, the measured test totals, what is deferred and why

Superseded planning docs live in [`docs/archive/`](docs/archive/README.md).

## License

MIT - see [LICENSE](LICENSE).
