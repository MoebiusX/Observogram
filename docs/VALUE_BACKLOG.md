# Value Backlog

Prioritized product backlog for Observogram's next iterations, distilled from
the 2026-06 audits ([ADVANCED_FEATURE_AUDIT.md](ADVANCED_FEATURE_AUDIT.md),
[REFACTORING_PLAN.md](REFACTORING_PLAN.md)), the live-drift remediation
work, and the 2026-06-10 deep-analysis pass (post-deploy re-verify and
product-hardening designs folded in below). Ordered by user value per unit
of risk: items near the top make the core promise ("is this service's
observability diagnostic-grade?") more true; items lower down widen the
audience.

**Resequencing note (2026-06-10):** execution starts with *Close the loop*
(P1) and *Make it a product* (P2). The verdict-trust work (now P3) is under
active research by the maintainer and will re-enter the queue when that
research lands. Item numbers are stable identifiers — they do not imply
order.

Engineering-health work lives in REFACTORING_PLAN.md, not here.

---

## P1 — Close the remediation loop (active)

### 4. Bidirectional remediation
Remediate currently compiles repo→production. Build the reverse arrows:
- **Repo retrofeed**: when live has verified artefacts the repo never
  declared (shadow signals worth keeping), generate the pack fragment + a
  PR-ready diff back into the service repo.
- **Deploy missing declared artefacts**: from the declared-not-verified
  bucket, one action to compile and push exactly the missing set through
  the existing MCP write path.
Together with item 9, these make the pack genuinely round-trip:
declared ⇄ live ⇄ confirmed.

### 9. Post-deploy re-verify — close the Möbius loop *(designed 2026-06-10)*
Both deploy paths (`doDeployBulk`, compile-view `doDeploy`) currently end at
the result table; confirming a fix landed takes five manual steps. Every
building block for closure already exists: `POST /api/draft-from-mcp`,
`validateUploaded` (idempotent content-hash ids), `adoptValidatedPack`,
`refreshDiff()`, and — the keystone — `remediationDeployIdentity()`, which
maps each deployed item to its behavioural identity.

**Design: targeted transition verification, not a generic re-diff.**
- After deploy, keep the ok items and compute each one's *expected
  transition*: `declared-not-live → aligned` (new artefact) or
  `drifted → aligned` (redeploy over stale live state).
- Auto-run a verify phase in the deploy modal: re-draft from the same MCP
  (URL+auth already in the modal), register, swap `compareBId`,
  `refreshDiff()`, then look up each expected identity in the new buckets.
- Render a per-item transition table — ✅ verified · ⏳ pending · ✗ still
  missing — plus the headline delta ("alignment 58% → 71%, grade
  63% FAIL → 87% PASS"). The fresh `mcp.refreshedAt` feeds the *Fresh*
  criterion for free.
- **Propagation lag is a first-class state, not a failure.** A
  just-created rule is acknowledged by the write tool immediately, but the
  read-path evidence (vmalert sync, first recording-rule evaluation,
  metric inventory) lags ~30s+. Poll with backoff (≈15s/30s/60s, ~3
  tries), then settle on an honest "deployed, not yet visible live" with a
  manual re-check. A write acknowledgement is not live verification; only
  the read path confirms.
- Verify only ok items; failed deploys keep their error and are excluded
  from expected transitions. Reuse the pre-deploy diff's
  `scopeMode`/`service` params so buckets don't shift for unrelated
  reasons.
- **Build client-side first** (zero new server surface, composes three
  proven endpoints); extract a server `/api/verify-deploy` later when the
  CLI needs parity (`packc deploy --verify`).
- Effort: ~200–300 lines (modal verify phase + polling + table) + ~30 in
  the single-deploy panel. The transition computation is a pure function —
  unit-testable without an MCP.

### 5. Service-scoped reconciliation controls
The reconciliation engine supports service scoping; the UI exposes little
of it. Give the user explicit scope control in Diagnose/Remediate: which
service(s) of a multi-service live pack to reconcile against, with the
out-of-scope inventory clearly parked rather than silently ignored.

### 6. Requirement-branch reconciliation UI
Traceability shows requirement chains and the comparison spec
(TRACEABILITY_GRAPH_COMPARISON_SPEC.md) defines branch-level divergence.
Build the acting surface: per requirement branch, show declared vs live
side by side and offer the targeted fix (deploy the missing rule, adopt the
live threshold, retire the stale alert) — remediation at requirement
granularity instead of artefact granularity.

## P2 — Make it a product, not a session (active)

### 10. Workspace persistence + auth + audit + rollback *(designed 2026-06-10)*
Closes four of the eight rows in RELEASE_READINESS's Production Hardening
Gate. Design constraint: stay **file-first, zero new runtime deps,
local-first** — a workspace directory + append-only JSONL + one optional
bearer token, not a database + user accounts.

**A. Workspace persistence** — `.observogram/` (gitignored;
`OBSERVOGRAM_WORKSPACE` to relocate): `packs/<id>.pack.yaml` (id = the
existing deterministic content hash, so **zero client changes**),
`packs/index.json` (label/source/createdAt/lastUsedAt),
`deploys.jsonl`, `snapshots/<deployId>/`. `registerUploadedPack` writes
through; boot rehydrates. The in-memory LRU-20 becomes a disk retention
policy (keep ~200, prune by lastUsedAt) and eviction stops being silent.
Fixes the restart-loses-everything and silent-eviction gaps. Effort: S.

**B. Auth — one token, three postures.** (1) Local default: loopback bind,
no auth, zero friction. (2) Exposed: if `HOST` ≠ loopback and no
`OBSERVOGRAM_API_TOKEN` set → **fail closed** on write routes with a clear
message; with the token set, require `Authorization: Bearer` on mutating
routes only (validate-register, crawl, draft, deploy, deploy-bulk,
DELETE /uploads). (3) Never store MCP write tokens server-side — keep the
per-request pass-through; audit records token *ownership label*, never the
secret. Deliberately not building users/roles/sessions; the token is the
seam where SSO could attach later. Effort: S.

**C. Audit — append-only JSONL + deploy ids.** Every deploy (single, bulk,
and dry runs) appends one record: deployId, actor, pack id@version +
content hash, env, target product/version/folder, sanitized MCP URL,
per-item outcomes, and a `verify` field that the post-deploy re-verify
(item 9) writes back into — the audit then answers not just "what was
pushed" but "was it confirmed live". Surface: `GET /api/deploys` + a
history panel in the deploy modal ("last deployed 2h ago → grafana@12,
13 items ✓"). Effort: S–M. *Items 9 and 10C want to ship adjacent.*

**D. Rollback — honest decomposition.**
- *Updates (upsert over existing)*: snapshot current live state **before
  the first write** via the existing read path (`grafana_dashboard_get`,
  alert-rules probe) into `snapshots/<deployId>/`; rollback = redeploy the
  snapshot through the same write tools. Snapshot failure → warn and
  require explicit "proceed without rollback point" (or block under a
  strict flag). On partial bulk failure the snapshot is the mixed-state
  escape hatch — exactly the scenario rollback exists for.
- *Creates*: the inverse is delete, and otel-mcp-server exposes **no
  delete tools today**. v1: audit records created UIDs and the UI labels
  them "manual rollback" with exact identities; light the button up when
  `tools/list` advertises `grafana_delete_*`. **File the upstream request
  now.** Effort: M; the MCP delete tool is the one external blocker.

**Sequencing within the item: A → C → B → D** (persistence first —
everything else writes into the workspace; audit second — cheap and item 9
wants it; auth third; rollback last). Week-scale total, no new deps.

### 11. Saved journeys — repeatable, schedulable drift checks *(new 2026-06-10)*
Today every check is a hand-driven session. Let the user **save a journey**
— a parameterized, named run — and repeat it on demand or on a schedule.
Canonical example: *"repo vs live drift check"* — crawl
`github.com/org/svc@main` as Pack A, draft Pack B from
`https://…/mcp/public`, env `prod`, service scope `svc`, pass criteria
(alignment ≥ 85%, grade PASS, declared-not-live = 0).

- **Definition is a file** (shareable, committable):
  `.observogram/journeys/<name>.journey.yaml` in the workspace, or a
  `observogram.journey.yaml` committed in the service repo. Secrets never
  inline — reference an env var name (`mcpAuthEnv: KRYSTALINE_MCP_TOKEN`).
- **Runner is the CLI**, headless: `packc journey run <name>` — composes
  the engines that already run headless today (crawler, fetch-live-pack,
  diffPacks via detect-drift, conformance, diagnostic grade). Exit code
  reflects pass criteria → **this subsumes the CI-gate idea**: the same
  command is the GitHub Actions check.
- **Scheduling is delegated, not built.** No scheduler in the server: from
  a journey definition, emit ready-made snippets — a cron line, a Windows
  Task Scheduler command, a GitHub Actions workflow (the existing
  refresh-live-pack.yml is already half of this journey). Keeps the
  zero-dep, local-first posture.
- **Every run appends history**: `.observogram/runs/<journey>/<ts>.json`
  with the summary (alignment %, grade score, bucket counts, breached
  criteria). History unlocks the real prize: **drift over time** — a
  sparkline/chart of alignment per journey turns Observogram from a
  point-in-time scanner into a monitoring instrument for observability
  posture itself, and makes drift *velocity* visible ("alignment dropped
  6 points since Tuesday's deploy").
- **Notify on breach**: optional webhook per journey (ntfy / Teams /
  generic POST — the Krystaline stack already runs ntfy + GoAlert, so the
  reference deployment exercises this immediately).
- **Studio surface**: a journeys panel (last run, status, trend sparkline,
  run-now) and — the key capture UX — **"save this comparison as a
  journey"** from a live A/B session: the user does the flow once by hand
  and freezes it as the repeatable definition.
- Depends on item 10A (the workspace is where journeys + run history
  live); pairs naturally with item 9 (a journey run is the same
  draft→diff→grade pipeline the verify phase uses).
- Effort: M (CLI command + run-record writer ~200 lines reusing existing
  engines; studio panel ~150; schedule-snippet emitters trivial).

### 12. Identity · tenancy · hosted posture *(plan ratification pending — 2026-06-12)*
The v1 non-goal ("multi-tenant persistence") activates as its own
stream: **sign in → land in your org → see only your services** —
packs, journeys, deploys, audit, MCP endpoints all org-scoped,
enforced server-side. Four stages, each shippable alone: OIDC identity
(attaches at the existing `requireAuth` / `observogramActor` seam; the
bearer token becomes the service-account path), workspace-per-org
tenancy (the `workspaceRoot()` seam — file-first machinery unchanged),
roles (viewer / operator / admin) + org-scoped MCP endpoints (write
tokens stay pass-through, never stored), hosted hardening. Carries its
own CI gate set (dex IdP container, authz matrix, tenancy-isolation
proofs, local-mode zero-change regression). One scoped dependency
exception proposed: `openid-client` confined to `server/auth.mjs` —
everything else stays `node:` builtins. Full design, efforts (~2
weeks), and the three maintainer decisions:
[PRODUCTIZATION_PLAN.md](PRODUCTIZATION_PLAN.md). Effort: L.

## P3 — Make the verdict more trustworthy *(under research — re-enters the queue when the maintainer's research lands)*

### 1. Diagnostic-grade validation against incident ground truth
The grade claims "diagnostic-grade" on seven scored structural criteria
(grade schema 2; Actionable is observed but informational). Close the
loop with reality: for services with incident history, check whether the
signals the pack declares would have detected/explained real incidents
(MTTD vs `mttd_target`, alert fired vs incident start, runbook referenced).
Even a manual back-test template against 3–5 historical incidents would
turn the grade from a posture score into a validated claim — and tell us
which criteria actually predict diagnosability — including whether the
informational Actionable check earns its way back into the score on evidence.

### 2. Runtime attestation / freshness evidence
Today "Verified" means the live MCP scan saw the artefact at fetch time.
Strengthen the evidence: per-artefact freshness (rule last evaluated,
dashboard last rendered, alert route last exercised), carried in pack
annotations and surfaced in Traceability buckets and the Fresh criterion.
Turns "it exists in production" into "it is alive in production".

### 3. Richer semantic parsing: PromQL, dashboards, scrape, Alertmanager
Drift matching is structural-plus-PromQL today. Deepen the semantic layer:
- PromQL: normalise label-matcher order, vector-matching clauses, and
  constant folding so cosmetic rewrites stop reading as drift.
- Dashboards: compare panel *queries and thresholds*, not raw JSON shape.
- Scrape configs: relabel rules and target discovery semantics.
- Alertmanager: route-tree equivalence (group_by/matchers/receivers) rather
  than node-by-node identity.
Each reduces false drift, which is the main credibility tax on Diagnose.

## P4 — Widen what the crawler can see

### 7. Exporter metric extraction from source (TypeScript / Go / Java)
The crawler reads config artefacts (rules, dashboards, collector, Helm).
The biggest blind spot is the code itself: extract metric/span/log
declarations from instrumentation source (prom-client / OTel SDK calls in
TS, Go, Java) so the L2 inventory includes what the service *emits*, not
just what the platform *collects*. Start with one language (TS) and the
two dominant patterns (prom-client counters/histograms, OTel meters).

### 8. Multi-service operating model
Today the unit of work is one pack. Define the model for a team operating
many services: a workspace listing every service's grade/drift at a glance,
shared reference targets, roll-up reporting (how many tier-1 services are
diagnostic-grade?), and bulk refresh. The service selector exists; the
operating layer above it doesn't. Note: items 10A (workspace) and 11
(journeys — one per service) lay most of this item's foundation.

---

## Sequencing note

The active execution order is P1 → P2: close the loop (9 before 4 — the
verify arrow makes bidirectional remediation safe to trust), then make the
session durable (10A → 10C → 10B → 10D, with 11 building directly on 10A).
Within the research track (P3) the original compounding logic still holds:
better parsing (3) reduces false drift, which makes freshness evidence (2)
cleaner to interpret, which makes incident back-testing (1) meaningful.
P4 widens input after the loop is closed; note 8's foundation arrives
early via 10A/11.
