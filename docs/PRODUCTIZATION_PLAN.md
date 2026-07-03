# Productization Plan — Identity, Tenancy, Hosted Posture

*Commissioned 2026-06-12. This activates the work stream that
[RELEASE_READINESS.md](RELEASE_READINESS.md) deliberately parked as a
v1 non-goal ("multi-tenant persistence") and that
[VALUE_BACKLOG.md](VALUE_BACKLOG.md) item 10B explicitly deferred
("deliberately not building users/roles/sessions; the token is the seam
where SSO could attach later"). The target in one sentence: **a user
signs in, lands in their organisation, and sees only their services —
packs, journeys, deploys, audit, all scoped to that org.** This is a
plan, not a spec: it names the stages, the seams they attach to, the
one constraint that must be consciously renegotiated, and the decisions
only the maintainer can make.*

## 0 · Status quo — the seams were built for this

The v1 "product, not a session" work (backlog item 10, shipped) was
designed so this stream attaches without re-architecture:

| Seam | What exists today | Where | Role in this plan |
|---|---|---|---|
| **Actor** | `requireAuth` middleware enforces `Authorization: Bearer` on mutating routes when `OBSERVOGRAM_API_TOKEN` is set, and stamps `req.observogramActor` (today: a token *label*) into every audit record | `server/index.mjs` ~392–418 | identity replaces the label with a real subject — **one assignment changes** |
| **Fail-closed exposure** | binding beyond loopback without a token refuses to start | `server/index.mjs` `start()` ~2317 | becomes the hosted front-door invariant: no identity configured → no network exposure |
| **Tenancy root** | ALL state is file-rooted under one function: `workspaceRoot()` → packs registry, `deploys.jsonl`, `snapshots/`, `journeys/`, `runs/` | `server/workspace.mjs:32`, `tools/lib/journey.mjs:50` | tenancy = making this function answer *per request* instead of per process |
| **Service scoping** | packs carry `bindings.service`; the studio's SERVICE selector and diff scope-modes already partition by service | studio header, adapter | the unit a role grant will reference |
| **Secrets posture** | MCP write tokens are per-request pass-through, never stored; audit records ownership label only | deploy routes | the rule this plan keeps, extended per-org |
| **Audit** | append-only `deploys.jsonl` with deployId, actor, outcomes, verify write-back | `server/workspace.mjs` | gains real identities for free at Stage 1 |

Nothing in this plan touches the engines, and the studio stays a thin
vanilla-JS client.

## 1 · Product definition

Three postures, strictly additive — each earlier one keeps working:

1. **Local (today, unchanged):** loopback, no login, identity =
   `local`. The CLI/dev experience must never grow friction.
2. **Team:** one deployment behind SSO; members sign in, share one
   org's services; roles distinguish who may deploy.
3. **Hosted multi-org:** several organisations on one deployment, each
   seeing only its own workspace, services, MCP endpoints, and audit.

"Your services" concretely means: the pack catalog, journeys, run
history, deploy audit, snapshots, and configured MCP endpoints visible
to a signed-in user are exactly those of the orgs they belong to —
enforced server-side, not hidden client-side.

## 2 · Stages (dependency order; each independently shippable)

> **Stage 1 status — DELIVERED**, with one maintainer-requested
> addition: a **stand-alone posture with locally-defined users** — no
> IdP, no network dependency. Users live scrypt-hashed in a plain file
> (`OBSERVOGRAM_USERS_FILE`, default `<workspace>/users.json` — plain
> file chosen over sqlite: file-first like everything else, zero new
> deps, and `node:sqlite` would raise the engine floor to Node 22),
> managed by `npm run users -- add|passwd|remove|list`. The file
> existing arms a password login page at `/auth/login`; the session
> secret auto-persists into the workspace so stand-alone setup is one
> command + restart. Both postures share the same HMAC cookie session,
> CSRF gate, `/auth/me`, logout, and the bearer-token service-account
> path; the fail-closed network rule now accepts identity as auth.
> Login throttling: 5 failures per user+address → 30 s lockout; unknown
> users burn a hash so there is no username oracle. Suites:
> `server/test-auth-local.mjs` (21 assertions) and
> `server/test-auth-oidc.mjs` (15 — full code+PKCE against an
> in-process mock IdP with real RS256/JWKS validation through
> openid-client), both in `npm test`. Studio: 401 → login redirect,
> CSRF header on every request, signed-in chip + sign-out in the
> header. Local no-auth mode is regression-asserted by every other
> suite. Remaining stage-1 nicety: dex-in-docker interop leg on the
> backend-live job.

### Stage 1 — Identity (OIDC login)

- **Flow:** Authorization Code + PKCE against any OIDC provider
  (Entra ID, Google, Okta, Keycloak/dex). Express gains
  `/auth/login`, `/auth/callback`, `/auth/logout`; the session is a
  signed, HttpOnly, `SameSite=Lax` cookie (HMAC via `node:crypto` —
  no session-store dependency; payload = subject, org memberships,
  expiry).
- **Attachment:** `requireAuth` accepts EITHER a valid session cookie
  OR the existing bearer token (the token becomes the **service
  account / CI path** — headless CLIs keep working). `observogramActor`
  becomes `sub` / email.
- **Local mode unchanged:** no `OBSERVOGRAM_OIDC_ISSUER` configured →
  exactly today's behaviour.
- **Immediate value even without tenancy:** real names in the deploy
  audit, and safe network exposure for a single team.

### Stage 2 — Tenancy (workspace-per-org)

> **Stage 2 status — DELIVERED** exactly as designed below.
> `server/tenancy.mjs` owns the org registry (`orgs.json` at the
> workspace root — the file existing arms tenancy, mirroring
> `users.json`), the per-request org context (AsyncLocalStorage — no
> orgId threading through call sites), and the idempotent flat →
> `orgs/default/` boot migration. `workspaceRoot()` in the registry and
> the journeys/runs engine answers `<workspace>/orgs/<orgId>/` inside a
> request; the in-memory upload registry and the workspace index cache
> are keyed per org (the two places a process-wide cache would have
> leaked across tenants). The org comes from `X-Observogram-Org`
> (defaulting to the user's first membership); membership is enforced
> at the middleware seam Stage 3 roles will extend; the bearer token
> remains the deployment-level service account. Managed by
> `npm run orgs -- create|remove|add-member|remove-member|list`;
> member-mutation HTTP endpoints deliberately wait for Stage 3 roles
> (any-member-can-edit-members would be an escalation hole, not a
> feature). Tenancy without identity refuses to boot, fail-closed.
> Studio: active org resolved before the first catalog fetch, an ORG
> chip (switcher when multi-org) beside the brand — same
> never-a-mystery rule as the SERVICE chip. Gate suite:
> `server/test-tenancy.mjs` (29 assertions) proves org B reads/writes
> NOTHING of org A at the API level AND by filesystem-path assertion,
> plus migration, per-org reset, and the fail-closed posture; flat
> (no-orgs.json) regression is asserted by every other suite.

- `workspaceRoot()` becomes context-aware:
  `<OBSERVOGRAM_WORKSPACE>/orgs/<orgId>/` per request, threaded through
  the few entry points that call it (registry, deploys, snapshots,
  journeys, runs). The file-first machinery underneath is **unchanged**
  — this is precisely why v1 chose files over a database.
- Org membership lives in `orgs.json` at the workspace root
  (`{ orgId: { name, members: { sub: role } } }`) — file-first,
  admin-edited or managed via two small endpoints. Honest ceiling:
  fine to ~50 orgs / hundreds of members; beyond that the registry
  module (one file) is the swap-point for a database. We do not build
  the database now.
- Migration: a deployment with an existing flat workspace gets it
  moved to `orgs/default/` by a one-shot, idempotent boot migration.

### Stage 3 — Authorization (roles + org-scoped MCP endpoints)

- **Roles per org:** `viewer` (read everything), `operator` (+ crawl /
  draft / register / deploy / retrofeed), `admin` (+ org settings,
  members, MCP endpoint config). Enforcement is a per-route check in
  the same middleware seam — the route table is small and explicit.
- **Service grants deferred:** v1 of this stream treats the org as the
  service boundary (an org sees all its services). Per-service ACLs
  inside an org are a later refinement with a clear seam (the role
  check already receives the pack's `bindings.service`).
- **MCP endpoints per org:** admins register named endpoints (URL +
  optional read-token env indirection, mirroring the existing
  `mcpAuthEnv` pattern). **Write tokens stay per-request pass-through**
  — the v1 secrets rule survives because it is the correct rule:
  Observogram never persists a credential that can mutate production.

### Stage 4 — Hosted posture (ops hardening)

- TLS via reverse proxy (documented, not built); CSRF defence on
  mutating routes (SameSite=Lax + custom-header check); security
  headers; rate limit on `/auth/*`; secrets only via env; documented
  backup story = the workspace directory (it already IS the state);
  upgrade/rollback notes. The fail-closed rule extends: non-loopback +
  no OIDC + no token → refuse to start, same as today.

## 3 · The one constraint to renegotiate: zero runtime dependencies

Everything above is dependency-free **except OIDC token verification**
(JWKS fetching/caching, `id_token` signature + nonce + audience +
clock-skew validation). Hand-rolling it is possible (~400 LOC of
`fetch` + `node:crypto`) but this is exactly the category of
security-sensitive code where subtle bugs become auth bypasses.

**Recommendation: one scoped exception — `openid-client` (the
certified, actively maintained reference client), confined to a single
`server/auth.mjs` module.** Everything else in the plan (sessions,
cookies, roles, tenancy) stays hand-rolled on `node:` builtins. The
engine, studio, and CLIs remain zero-dep. If the exception is refused,
the fallback is the pure-`fetch` implementation at roughly +3 days and
a standing review burden — workable, not recommended.

## 4 · Quality gates for this stream (same discipline as the compiler)

Mirroring TEST_PLAN_COMPILER_VALIDITY.md — every claim CI-enforced:

| Gate | Mechanism |
|---|---|
| AuthN conformance | docker job logs in against a disposable **dex** IdP (same pattern as the Grafana T2/T4 containers) — full code+PKCE flow, bad-nonce/expired-token rejection |
| AuthZ matrix | table-driven suite: every mutating route × {anonymous, viewer, operator, admin, bearer-token} → expected status; CI-strict |
| Tenancy isolation | two orgs in one test workspace; prove org B can read/write **nothing** of org A (API level + filesystem-path assertion) |
| Session security | cookie flags, tamper rejection (HMAC), CSRF header enforcement, logout invalidation |
| Local-mode regression | the entire existing suite runs with no OIDC configured — zero behaviour change is an assertion, not a hope |

## 5 · Effort & sequencing

| Stage | Effort | Ships alone? |
|---|---|---|
| 1 · Identity | 3–4 days (incl. dex CI harness) | yes — real audit actors + safe team exposure |
| 2 · Tenancy | 2–3 days | yes — team → multi-org |
| 3 · Authorization | 2–3 days | yes — roles + org MCP endpoints |
| 4 · Hosted posture | ~2 days | docs + hardening |

≈ two focused weeks end-to-end, one PR per stage, each stage leaving
`develop` shippable.

## 6 · Decisions needed from the maintainer

1. **The dependency exception** — `openid-client`, confined to
   `server/auth.mjs`. *(Recommended: yes.)*
2. **IdP target for CI** — generic OIDC, conformance-tested against
   dex in docker; first real-world IdP wired when you name it.
   *(Recommended: generic-first.)*
3. **File-first org registry** until scale demands otherwise.
   *(Recommended: yes — consistent with everything that made v1 work.)*

## 7 · Risks

- **Scope creep into "platform".** Billing, invitations, email flows,
  audit UIs — all out of scope here; this plan ends at "log in, see
  your services, act within your role".
- **Studio session handling.** The client must handle 401 → redirect
  to login gracefully; small, but it touches the api.mjs error path.
- **Workspace concurrency.** Multi-user writes to one org's file
  registry raise the stakes on the existing debounced index flush —
  Stage 2 includes making registry writes atomic (write-temp + rename),
  a known weak point already observed once in the wild.
- **CLI ergonomics.** CLIs authenticate with the bearer token (service
  account); per-user CLI login (device-code flow) is a later nicety,
  not Stage 1.
