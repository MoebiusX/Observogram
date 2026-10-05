# Adapter — canonical → layered

The adapter (`tools/lib/adapter.mjs`) projects a canonical ObservabilityPack v1.4 manifest into the studio's layered display object. Pure ESM, no Node APIs — the Express server, the `npm run adapt` CLI, and (potentially) browser-side consumers all import the same module.

## Public API

```js
import { adapt, listEnvironments, applyEnvironmentOverlay, overlaidCanonical } from './tools/lib/adapter.mjs';

const layered = adapt(canonical, { environment: 'staging' });
// layered = { id, name, badge, description, meta, layers: { L1, L2, L2X, L3, L4: {policy,alerting,healing}, L5, GOV }, traceability }

const envs = listEnvironments(canonical);
// e.g. ['prod', 'staging']

const { spec, effective } = applyEnvironmentOverlay(canonical.spec, 'staging');
// spec = deep-cloned spec with dotted-path overrides applied
// effective = { target, criticality, backendWiring }

const { canonical: overlaid } = overlaidCanonical(canonical, 'staging');
// the same overlay applied to a copy of the whole manifest, with the effective
// criticality / default_target propagated up to metadata.bindings — what the
// conformance scorer, the compilers and the export read for one environment
// (the server, the static bundle and the CLIs share this one helper)
```

## Layered output shape

```
{
  id: string,
  name: string,
  badge: string | undefined,            // e.g. "TIER-1"
  description: string,
  meta: {
    apiVersion, kind, binding, version,
    owners: string[],
    criticality, target,
    environment, environments,          // current + all
    backendWiring,                      // { signal-class: backend-id } from env
  },
  layers: {
    L1: artefact[],
    L2: artefact[],
    L2X: artefact[],                     // canonical §5.12.4 extended surfaces
    L3: artefact[],
    L4: { policy: artefact[], alerting: artefact[], healing: artefact[] },
    L5: artefact[],
    GOV: artefact[],
  },
  traceability: {
    summary: object,
    chains: requirementTrace[],
  },
}
```

Each `artefact` is:

```
{
  id: string,                            // family + index, e.g. "SLI-01"
  title: string,
  desc: string,                          // one-line summary
  subtitle?: string,                     // a threshold / distribution SLI's bound with its direction (spec 1.3 good_when): '≤ 0.5 seconds', '≥ 2 consumers'
  tool: string,                          // implementation tool/family
  tags: string[],
  source: 'Declared' | 'Verified' | 'Scaffold',
                                          // 'Missing' added by Phase 3b conformance pass
  type?: string,                         // the declared type, only when metadata.annotations["observogram.artefact.type.<symbol>"] names one (see "Id families and the classifier")
  defines?: string,                      // symbol it defines, e.g. "slis.api_availability"
  refs?: string[],                       // symbols it references (for cross-ref checker)
  spec: object,                          // raw canonical section/item (drawer detail)
  mcp?: string,                          // verification timestamp from metadata.annotations.mcp.verified.<id>
}
```

## Mapping table

The adapter walks each top-level spec section into a deterministic family of layered artefacts:

| Canonical location | Layer | ID family | Notes |
|---|---|---|---|
| `spec.slis[]` | L1 | `SLI-{NN}` | `defines` = `slis.<id>` |
| `spec.slos[]` | L1 | `SLO-{NN}` | `refs` includes the SLI's symbol |
| `spec.otel` | L2 | `OTEL-01` | Single artefact summarising the OTel contract |
| `spec.telemetry.backends[]` | L2 | `BAK-{NN}` | `tags` include `signal`, `gating-{off\|warn\|enforce}`, `default` from `VersionSpec` |
| `spec.pipelines.receivers[]` | L2 | `PIP-RCV-{NN}` | |
| `spec.pipelines.processors[]` | L2 | `PIP-PRC-{NN}` | |
| `spec.pipelines.exporters.{metrics\|logs\|traces}` | L2 | `PIP-EXP-{MET\|LOG\|TRC}` | |
| `spec.storage.{metrics\|logs\|traces}` | L2 | `STO-{MET\|LOG\|TRC}-01` | |
| `spec.profiling` | **L2X** | `PROF-01` | Extended surface from spec §5.12.4 |
| `metadata.annotations.mcp.discovered.scrape_jobs` | L2 | `SCRAPE-{NN}` | Expand-level live scrape evidence |
| `metadata.annotations.mcp.discovered.metric_names_sample` | L2 | `METRIC-{NN}` | Expand-level live metric inventory |
| `spec.network` | **L2X** | `NET-01` | |
| `spec.policy_engine` | **L2X** | `POE-01` | |
| `spec.mesh[]` | **L2X** | `MESH-{NN}` | |
| `spec.collection[]` | **L2X** | `COL-{NN}` | |
| `spec.queries.recording_rules[]` | L3 | `QRY-{NN}` | `refs` extracted from `expr` via `ref:slis.X` regex |
| `spec.queries.derived_views[]` | L3 | `VIEW-{NN}` | |
| `spec.dashboards[]` | L3 | `DASH-{NN}` | `refs` from `panel_bindings.binds_to` (clickable in drawer) |
| `spec.policy.burn_rate_alerts[]` | L4 . policy | `POL-{NN}` | `refs` includes the bound SLO |
| `spec.policy.forecasts[]` | L4 . policy | `FCST-{NN}` | |
| `spec.alerting.routes[]` | L4 . alerting | `ALR-{NN}` | One per severity route |
| `spec.alerting.rules[]` | L4 . alerting | `RULE-{NN}` | One per operational alert rule (spec 1.4), titled by the rule's exact name; `tool` by engine (`PrometheusRule`, `Grafana alerting`, `Loki ruler`); the artefact model keys it on the name, so a repository's rule and a live listing's rule pair |
| `spec.remediation[]` | L4 . healing | `HEAL-{NN}` | `refs` includes the trigger alert |
| `spec.baselines` | L5 | `BASE-01` | |
| `spec.validation.chaos_experiments[]` | L5 | `CHAOS-{NN}` | `refs` = steady-state SLO + each `expected_alerts` entry |
| `spec.validation.synthetic_checks[]` | L5 | `SYN-{NN}` | |
| `metadata.imports[]` | GOV | `IMP-{NN}` | |

## Id families and the classifier

The id families above are the adapter's output vocabulary; the one place
that reads them back is `tools/lib/artefact-classify.mjs` — `ID_RULES`
(every prefix of the table, the longer first; the ids the adapter numbers
once — `OTEL-01`, `PIP-EXP-MET`, `STO-MET-01`, `PROF-01`, `NET-01`,
`POE-01`, `BASE-01` — are prefix rules, so a second id in such a family
classifies like the first) and `DEFINES_RULES` (the `defines` symbol, read
before any id). `artefact-model.classify()` delegates to it, so the diff's
identity keys, the traceability graph's node kinds and the blast-radius
weights share the Discover board's grouping (`FAMILY_HOME`: family → layer,
group, label, role). Add an id family here and in `ID_RULES` together — the
coverage test in `tools/test-artefact-classify.mjs` fails on a template
`ID_RULES` does not match, and `npm run test:golden:board` pins every
family of the catalogue packs.

The classifier reads an explicit `type` before anything else. **`adapt()`
emits no `type` on its own** — it carries one through only when the
canonical manifest declares it:

```
metadata.annotations["observogram.artefact.type.<symbol>"] = "<TypeName>"
```

where `<symbol>` is the canonical symbol the artefact's `source` is read for
(`slis.<id>`, `slos.<id>`, `telemetry.backends.<id>`, `storage.<family>`,
`dashboards.<id>`, `queries.recording_rules[i]`, `policy.burn_rate_alerts[i]`,
`alerting.routes[i]`, `remediation[i]`, `validation.synthetic_checks.<id>`,
`imports[i]` …; `DECLARED_TYPE_PREFIX` in `adapter.mjs`). The legacy
upconvert writes that annotation for a layered item that carried a `type`,
so a typed pack from another toolchain uploaded in the layered shape keeps
its types through the one canonical pipeline (`tools/test-declared-type.mjs`).
Nothing the crawler, the live fetcher or the library produces declares one,
so every pack of the catalogue adapts without a `type` key — the guard the
classifier's inert-by-default argument rests on. A family name in `type`
(`sli`, `alert_rule` …) classifies by itself; a foreign name (`PackSLI`)
needs the operator override (`OBSERVOGRAM_TAXONOMY` on a server, `--taxonomy`
for the static bundle; README "Classify Typed Packs"), which can also place
foreign ids by pattern — but never an
artefact that carries `defines`.

The symbol an artefact is addressed by elsewhere — `slos.<id>` (the
adapter's `defines`), `remediation[<i>]`, `alerting.rules[<j>]`,
`policy.burn_rate_alerts[<j>]` — is the canonical address; the positional id
(`SLO-01`, `HEAL-01`, frozen within a content-hash pack id) is the studio's
card and a verdict's key. The response path below prints both.

## Response path: `observogram.remediates.remediation[<i>]`

The **response path** (GAP batch 2, B3.3; `tools/lib/remediation-flow.mjs`,
a listed module) links each remediation the pack declares (`spec.remediation`,
adapted as `L4.healing` `HEAL-NN`, addressed `remediation[<i>]`) to the alert
artefacts its trigger means — the L4 `policy` burn alerts (`burn_rate`,
`policy.burn_rate_alerts[<j>]`) and `alerting` rules (`alert_rule`,
`alerting.rules[<j>]`) — and says what stands between the declaration and a
working path. The spec names a trigger as an alert id (`trigger:
alert:<slug>`) and nothing else binds the two, so the linking rule is this
module's and is normative:

| tier | rule | example |
|---|---|---|
| T0 `annotation` | `metadata.annotations["observogram.remediates.remediation[<i>]"] = "<symbol>[, <symbol>…]"` — `alerting.rules[<j>]`, `policy.burn_rate_alerts[<j>]`, `slos.<id>` (every burn alert of that SLO), `alert:<slug>` (T1 then T2 over the slug); a symbol naming nothing is a `warnings[]` entry, never a link | `"policy.burn_rate_alerts[0], alerting.rules[2]"` |
| T1 `rule-name` | `slugKey(rule.name) === triggerSlug(trigger)` — lowercase, every non-alphanumeric stripped; `ref:` then `alert:` dropped from the trigger | `alert:High-Error-Rate` ↔ `HighErrorRate` |
| T2 `burn-name` | a compiled burn-rule name of a burn alert equals the slug: `<slo>_burn_<factor>x_<short>_<long>`, runs outside `[A-Za-z0-9_]` → `_` (the compiler's own formula, `14.4` → `14_4x`) | `alert:api_availability_99_9_burn_14x_5m_1h` |
| T3 `slo` | `slugKey(burn.spec.slo) === triggerSlug(trigger)` | `alert:api-availability-99-9` |

The first tier with at least one hit wins and every hit of that tier links;
a containment is never a match. No hit → `unresolved`, with `suggestions`
scored on shared name tokens (the service and pack name tokens dropped; two
shared, or a unique single; at most three) that never link, never count as
covered and never carry a deploy action — the panel quotes the annotation to
write. The symbol index is the artefact's position among its family in the
layer walk: the adapter's own symbol for a canonical pack, the same rule for a
typed one.

**The model** — `buildRemediationFlowModel({ pack, diff = null, liveAnnotations
= null, otherSide = 'live' })` over the adapted pack (the comparison is
`/api/diff`'s body or `diffPacks`' result; `liveAnnotations` the live side's
`metadata.annotations`; `otherSide` `live | baseline` for the copy):

```json
{
  "configured": true, "compared": true, "otherSide": "live",
  "counts": { "remediations": 3, "alerts": 8, "linked": 3, "unresolved": 0, "uncovered": 5, "blocked": 1, "suggestions": 0, "placeholder": 0 },
  "links": [{
    "remediation": { "id": "HEAL-01", "symbol": "remediation[0]", "identityKey": "remediation::{…}", "family": "remediation", "title": "alert:…", "layer": "L4", "sub": "healing", "source": "Declared",
                     "trigger": "alert:…", "runbook": "file://…", "automation": "argo-workflow://…", "guardrails": { … }, "placeholder": false },
    "trigger": "alert:api_availability_99_9_burn_14x_5m_1h", "tier": "burn-name",
    "alerts": [{ "ref": { "id": "POL-01", "symbol": "policy.burn_rate_alerts[0]", "identityKey": "burn_rate::{…}", "family": "burn_rate", "title": "…", "layer": "L4", "sub": "policy", "source": "Declared", "names": ["…_burn_14x_5m_1h", "…"], "severities": ["SEV1", "SEV2"], "slo": "api_availability_99_9" },
                 "state": "missing", "deltas": [] }],
    "routes": [{ "id": "ALR-01", "symbol": "alerting.routes[0]", "severity": "SEV1", "channels": ["msteams", "voice"], … }],
    "state": "missing", "blocked": true, "placeholder": false,
    "steps": [
      { "kind": "deploy-alert", "tone": "fail", "alert": "policy.burn_rate_alerts[0]", "text": "Deploy the burn-rate rules of api_availability_99_9: declared, not live.",
        "action": { "type": "deploy", "identity": "api_availability_99_9", "artefactId": "SLO-01", "symbol": "slos.api_availability_99_9", "rows": 2 } },
      { "kind": "route", "tone": "ok", "severity": "SEV1", "text": "SEV1 reaches ALR-01 (msteams, voice)." },
      { "kind": "register-automation", "tone": "info", "text": "Register argo-workflow://… to run when the alert fires." },
      { "kind": "human", "tone": "info", "text": "SEV1 and above need a human before the automation runs (requires_human_above)." },
      { "kind": "runbook", "tone": "info", "text": "Runbook: file://runbooks/api-oom.md.", "href": null },
      { "kind": "guardrails", "tone": "info", "text": "Guardrails: at most 3/hour · cooldown 15m · rolls back on failure · circuit breaker 2 failures in 1h." }
    ]
  }],
  "unresolved": [{ "remediation": { … }, "trigger": "alert:payment-api-cert-expiring", "placeholder": false,
                   "suggestions": [{ "ref": { "id": "RULE-03", … }, "score": 2, "shared": ["cert~", "expiring"] }],
                   "steps": [{ "kind": "annotate", "tone": "warn", "text": "No alert of this pack answers to …", "annotation": "observogram.remediates.remediation[2]", "example": "alerting.rules[2]" }, …] }],
  "uncovered": [{ "ref": { "id": "POL-02", … }, "state": "live" }],
  "families": [{ "family": "burn_rate", "alerts": 5, "covered": 1, "uncovered": 4, "remediations": ["remediation[0]"], "blocked": 1 }, { "family": "alert_rule", … }],
  "warnings": []
}
```

`configured` is false — and everything else empty — for a pack without a
remediation. States: `declared` (no comparison), `live` (aligned on both
sides; "in the baseline" when `otherSide` is `baseline`), `drifted` (with the
`deltas` fields), `missing` (declared, not on the other side), `unverified`
(the other side did not observe the family, or the comparison did not cover
the artefact), `placeholder` (a Scaffold on the declared side), `unhealthy`
(live, and listed in the live side's `mcp.discovered.alert_rules_unhealthy`);
a path's `state` is its worst alert, `uncompared` without a comparison,
`placeholder` when the remediation itself is a Scaffold (the legacy upconvert
marks every one it invents — its automation, guardrails and runbook are
template values); `blocked` for `missing | unhealthy | drifted | placeholder`.
Steps, in the order a responder walks them: `deploy-alert` (a missing burn
alert carries the SLO's deploy action — the studio opens the deploy modal
preselected with it; a missing alert rule carries none, it is not a compiled
artefact), `reconcile-alert`, `fix-alert`, `complete-alert`, `route` (per
severity: the routes that carry it, or a warning that none does),
`register-automation` for a URI automation or `human` for a manual one
(`manual-only`), `human` for `requires_human_above`, `runbook` (`href` only
for `https?://`), `guardrails`, and `annotate` for an unresolved trigger. The
model is pure and deterministic (pack order), reads no clock, never throws
and never mutates its inputs; states are indexed by each diff entry's
artefact through `identityKeyOf`, never by parsing a key.

## Verdicts — a reviewer's record per artefact

A **verdict** (GAP batch 2, B3.1; `server/verdict-admin.mjs`,
`server/store/verdicts.mjs`) is a reviewer's record on ONE artefact of ONE
registered pack: `trusted | suspect | failed`, with a reason, the actor and
the time. `unreviewed` is the absence of a record. It is a trust record,
never a scorer input: nothing sums verdicts into the conformance score or
the diagnostic grade (Diagnose's "verdict", `studio/verdict-ui.mjs`, is the
engine's grade — a different thing with the same word).

**Keying.** The artefact is the adapter's positional id (`SLI-01`,
`ALR-02`), which is frozen within a pack id because the id is a content
hash (`server/pack-registry.mjs`). The row also carries the artefact's
behavioural identity key (`identityKeyOf`, `#01..#0n`-suffixed within a
colliding group in the board's walk order — L1, L2, L2X, L3, L4 policy →
alerting → healing, L5, GOV — `tools/lib/diff.mjs`'s rule) and a 16-hex
hash of its behavioural contract (`behaviorOf`). A re-upload of the same
content is the same pack id and keeps the verdicts. A re-upload under the
same label with changed content (the quick-start dedup, `pack.replace`)
carries each verdict onto the new pack's artefact with the same identity
key (`carriedFrom` names the old pack); the rest are dropped and the
`verdict.carry` audit row counts them. The identity key follows the
classifier, so a taxonomy change between two registrations can drop
verdicts (the typed burn alert of `tools/fixtures/taxonomy/` is the
suite's example). An eviction, `DELETE /api/uploads` and the rehydrate's
prune cascade the rows silently.

**VerdictView** — the shape every route serves:

```json
{
  "artefact": "SLO-01",
  "key": "L1/SLO-01",
  "family": "slo",
  "title": "API latency p99 < 500ms",
  "status": "suspect",
  "reason": "the window is shorter than the SLO period",
  "actor": "ada",
  "setAt": "2026-10-05T09:12:44.120Z",
  "carriedFrom": null
}
```

`key` is the studio's card key (`<layer>/<id>`, `L4/<subgroup>/<id>`),
`family` the LIVE classifier's family (the server's bound taxonomy — the
stored family is audit detail only), `title` the artefact's. A row whose
artefact the pack no longer has (an orphan — only possible across an
adapter upgrade) is served with `key: null`, `title: null`, the stored
family and `orphaned: true`, and counted in `summary.orphaned`.

**The document** — `GET /api/packs/:id/verdicts` (viewer; a catalogue pack
answers it with no rows; `?env=` is ignored):

```json
{ "ok": true, "pack": "uploaded-payment-service-1a2b3c4d",
  "verdicts": [ VerdictView, … ],
  "summary": { "artefacts": 84, "trusted": 1, "suspect": 0, "failed": 1, "unreviewed": 82, "orphaned": 0 } }
```

**Export** — `GET /api/packs/:id/export.zip` carries the document as
`verdicts.json` (pretty-printed, newline-terminated) after the compiled
artefacts, only while the pack has at least one verdict; `X-Bundle-Files`
counts it. Nothing else changes in the ZIP.

**Record** — `PUT /api/packs/:id/verdicts/:artefact` (operator) with
`{ "status": "trusted" | "suspect" | "failed", "reason"?: "≤ 2000 chars" }` →
`{ "ok": true, "verdict": VerdictView, "changed": ["status", "reason"] }`.
`changed` lists what differed from the record as it was (`[]`: nothing — no
row written, no audit row). An omitted or empty reason clears the reason.
Refusals, each `{ ok: false, error }` naming a way out: 400 a status outside
the three, a reason over 2000 characters, an id that is not a positional id;
404 an unknown pack (`unknown pack: <id>`), an artefact the pack does not
have; 409 a catalogue or example pack (register it first). **Clear** —
`DELETE /api/packs/:id/verdicts/:artefact` (operator) → `{ "ok": true,
"cleared": VerdictView }`; 404 when there is no verdict. Audit rows:
`verdict.set` on target `artefact` `<pack>/<artefact>` with `{ pack,
artefact, family, from, to, reason }`, `verdict.clear` with `{ pack,
artefact, from }`, `verdict.carry` on the new pack with `{ from, kept,
dropped, droppedCount }`.

## Waivers — a service record's suppression of a finding

A **waiver** (GAP batch 2, B3.2; `tools/lib/waivers.mjs`,
`server/waiver-admin.mjs`, `server/store/waivers.mjs`) is a time-boxed,
reasoned suppression of ONE conformance finding: a rubric clause
(`ruleId`, `tools/lib/conformance.mjs` RUBRIC) and, for the four per-item
clauses (`SUBJECT_CLAUSES`), optionally ONE canonical symbol of it
(`artefactId`: `slos.<id>` / `slis.<id>` — the adapter's `defines`
vocabulary, the address every conformance subject, placeholder row and
declared type uses; a verdict, by contrast, is keyed by the positional id).
The server keeps waivers on the **service record** a pack is primarily
linked to (`serviceTierFor`); the CLI reads the same object from a sidecar
file (`packc conformance --waivers <file>`).

**The waiver object** — what `GET /api/services/:id/waivers` serves per row
and what a sidecar file holds per entry (`id`, `serviceId`, `state` and
`expiresInDays` are the server's; a file needs `ruleId`, `reason`,
`expiresAt`, `author`, optionally `artefactId`, `createdAt`, `id`):

```json
{
  "id": 7,
  "serviceId": 12,
  "ruleId": "L5.MUST.tier1_chaos_for_each_slo",
  "artefactId": "slos.consumer_success_99_95",
  "reason": "chaos day is scheduled for Q1",
  "expiresAt": "2027-03-31T00:00:00.000Z",
  "author": "oscar",
  "createdAt": "2026-10-05T09:12:44.120Z",
  "state": "active",
  "expiresInDays": 176,
  "revokedAt": null,
  "revokedBy": null,
  "revokeReason": null
}
```

`state` is computed, never stored: `revoked` when `revokedAt` is set (the
row stays as history and matches nothing), `expired` once `expiresAt` has
passed (the finding fails again and the report surfaces the lapsed waiver),
else `active`. `author` / `revokedBy` are the audit actor (a login or the
token label, never an email).

**The overlay** — `GET /api/packs/:id/conformance` while the pack's service
holds an open waiver: every engine field as it was, plus

```json
{ "waivers": {
    "service": { "id": 12, "slug": "payment-service" },
    "counts": { "failing": 1, "waived": 3, "expired": 0, "unused": 0 },
    "clauses": { "L5.MUST.tier1_chaos_for_each_slo": {
        "status": "waived",
        "waivers": [ WaiverView, … ],
        "subjects": { "failing": ["slos.a", "slos.b", "slos.c"], "waived": ["slos.a", "slos.b", "slos.c"], "remaining": [] } } },
    "effective": { "conformant": false, "scorePercent": 89, "mustPercent": 88, "must": { "passed": 22, "total": 25 }, "should": { "passed": 5, "total": 5 }, "byDimension": { "L1": { "applicable": 4, "mustPassed": 3, "mustTotal": 3, "shouldPassed": 1, "shouldTotal": 1 }, "…": {} } },
    "unused": [ WaiverView, … ] } }
```

A clause is `waived` when every failing subject is covered (a pack-level
waiver covers them all; a scoped one its own and beats the pack-level),
`partial` when some are, `expired` when none is and a lapsed waiver would
have been; `subjects` is `null` for a whole-pack clause. `effective` is the
evaluator's arithmetic with the waived clauses read as met — the same shape
as the engine's, so a per-layer grid can show both. With no open waiver the
body carries no `waivers` key and is the same object as before.

**Record** — `POST /api/services/:id/waivers` (operator) with `{ "ruleId",
"artefactId"?, "reason": "one line ≤ 2000", "expiresAt": "ISO, after now, ≤
366 days ahead" }` → 201 `{ "ok": true, "waiver": WaiverView }`; the body's
`author` and `createdAt` are ignored (the principal and the server's clock
sign it). Refusals, each `{ ok: false, error }` naming a way out: 400 a
`ruleId` outside the rubric, an `artefactId` that is not `slis.<id>` /
`slos.<id>` or that names a whole-pack clause, a reason that is not one line
of 1–2000 characters, an expiry in the past, too far or unreadable, a
malformed service id; 404 `no service <id>`; 409 an active waiver of the same
`(ruleId, artefactId)` on the service (its id and expiry quoted; revoke it or
wait). **Revoke** — `POST /api/waivers/:id/revoke` (operator) with `{
"reason"? }` → `{ "ok": true, "waiver": WaiverView }` (state `revoked`); 404
`no waiver <id>`, 409 revoked already. Audit rows: `waiver.create` on target
`waiver` `<id>` with `{ service, ruleId, artefactId, expiresAt, reason }`,
`waiver.revoke` with `{ service, ruleId, artefactId, reason }`; a service's
deletion cascades its waivers (counted in `service.delete`).

## Cross-references and the symbol table

The client builds a symbol table from every artefact's `defines`. Each artefact's `refs` is classified:

- **Internal** (`slis.X`, `slos.Y`, `telemetry.backends.Z`, `dashboards.W`, …) — must resolve against the symbol table. Unresolved → red outline on the card + drawer warning + ⚠ marker.
- **External imports** (`ref:platform/...`, `ref:something/...@version`) — accepted without resolving.
- **Alert references** (`alert:<name>`) — accepted. Alerts aren't first-class symbols in the spec (alerting routes don't `defines:` anything); a future spec rev could change this.

`ref-link`s in drawer panels are clickable — clicking jumps to the defining artefact's drawer (switches active layer tab, opens it, scrolls into view).

## Requirement traceability

The adapter also attaches `traceability` to the layered pack. Each chain starts
from an SLO, follows its SLI, extracts metric names from PromQL expressions,
links related recording rules, metrics exporters, live scrape evidence,
dashboard panels, and burn-rate/live alert names. The chain intentionally keeps
scrape evidence honest: when the MCP confirms scrape jobs but the pack cannot
map a specific metric back to a job, the chain records the observed job count
and a `scrape_jobs_observed_but_not_metric_specific` note instead of inventing
a dependency.

This powers the studio Traceability tab and the SLI/SLO drawer panel.

## Environment overlay

When `spec.environments` is non-empty, `applyEnvironmentOverlay(spec, envName)`:

1. Deep-clones the spec (adapter is pure — no shared mutable state across env switches).
2. Applies `env.overrides` as **dotted-path writes** — `storage.metrics.retention: 13mo` rewrites `spec.storage.metrics.retention`.
3. Surfaces the env's `target`, `criticality`, and `backends` wiring as `effective`.

Downstream consumers (adapter + conformance scorer) read the env-overlaid spec, so `metadata.bindings.criticality` reflects the env's declared tier. A tier-1 service on its staging overlay is scored against tier-2 clauses.

## CLI form

```bash
node tools/adapt-spec-pack.mjs <pack.yaml> [--env <name>] [--pretty]
```

Outputs the layered JSON to stdout. Same module that the server and the studio use.

## Regression suite

`tools/test-adapt.mjs` exercises the vendored canonical example plus a focused
requirements-traceability fixture — layer counts, `defines`/`refs` shape,
gating tags, env overlay, adapter purity (no mutation across calls), and the
SLO -> SLI -> metrics -> exporter/scrape -> dashboard -> alert chain.

`tools/test-packs.mjs` runs the adapter against every `packs/*.pack.yaml`, validates schema + asserts pack-specific conformance bands.

## Previous format — layered JSON (upconvert)

The inverse-direction sibling lives in `tools/lib/legacy.mjs`: it detects the
pre-v1.2 layered "studio-shape" JSON (the original pack format — working
examples in `examples/legacy/`) and upconverts it into a canonical v1.4
manifest, so the one canonical pipeline serves old packs too.

```js
import { isLegacyLayeredPack, upconvertLegacyPack } from './tools/lib/legacy.mjs';

if (isLegacyLayeredPack(parsed)) {
  const { canonical, report, provenance } = upconvertLegacyPack(parsed);
  // report = { format, service, mapped, scaffolded, notes }
  // provenance = { '<symbol>': 'legacy.artefact.<LAYER>.<ID>' | null }  (null: a schema-required stub)
}
```

Wired in at the ingestion gate (`POST /api/validate` — uploads convert
transparently; the response carries the `legacy` report) and as a CLI
(`npm run upconvert-legacy <file> [-o out.pack.json] [--merge <existing>] [--overwrite]`).
A canonical input is never converted: `isLegacyLayeredPack` is false on
anything with `apiVersion`/`kind`, the gate passes it through and the CLI
echoes it (exit 0). A legacy input whose `-o` target already holds a canonical
pack merges into it (`mergeUpconvert({ canonical, provenance }, existing)`):
the existing pack wins for every artefact it has, the upconvert only adds
artefacts whose legacy record the existing pack has never seen, added items
get their marker re-indexed to their final position, and the `legacy.*` block
is refreshed — so a real value never regresses to a scaffold; `--overwrite`
restores the plain write. `report.scaffolded` and `legacy.scaffoldCount` count
every `crawler.scaffold.*` key, the six shared-section markers (`otel`,
`pipelines.*`) included. `npm run pack-conformance -- <pack>` lists the
placeholders that remain ([`DOWNSTREAM.md`](DOWNSTREAM.md) §11).

Conversion contract:

- **Lossless** — every legacy artefact is kept verbatim in
  `metadata.annotations["legacy.artefact.<LAYER>.<ID>"]`; an item's `type`,
  when it has one, is also kept as the declared type of the symbol it maps to
  (`observogram.artefact.type.<symbol>`, see "Id families and the
  classifier"), so the adapter emits it again.
- **Honest** — the layered format never carried machine detail (exprs,
  windows, channels); every placeholder a schema-required field forces is
  marked `crawler.scaffold.<symbol>` so it projects as Scaffold, never
  Declared. Legacy `GAP` items are always scaffolds. (`sourceOf` honours a
  second prefix, `mcp.scaffold.<symbol>`, for the placeholders the live
  fetcher is forced to invent — see `MCP_INTEGRATION.md`.)
- **Two kinds of symbol.** An *artefact symbol* is exactly an id `sourceOf`
  is asked for (`slis.<id>`, `slos.<id>`, `otel`, `telemetry.backends.<id>`,
  `pipelines.receivers[i]`, `pipelines.exporters.<signal>`,
  `queries.recording_rules[i]`, `dashboards.<id>`,
  `dashboards.<id>.panels.<panel>`, `policy.burn_rate_alerts[i]`,
  `alerting.routes[i]`, `alerting.rules[i]`, `remediation[i]`, `baselines`,
  `validation.synthetic_checks.<id>`, …); a marker on it parks the artefact as
  Scaffold. Any other dotted or indexed path under one — a *field symbol*
  such as `otel.semconv`, `telemetry.backends.<id>.endpoints`,
  `alerting.routes[0].channels[1]`, `metadata.owners` — matches nothing in
  `sourceOf` and is conformance evidence only: the crawler writes those for
  the values it invents without moving the artefact in Discover or Compare
  (`tools/lib/pack-conformance.mjs` reads both; `DOWNSTREAM.md` §11.1).
- **Deterministic** — same input, same manifest (timestamps only via
  `opts.now`).

`tools/test-legacy-pack.mjs` gates the four restored examples on every
`npm test`; `tools/test-upconvert-merge.mjs` gates the merge. The lossless
record key does not say which L4 sublist (policy / alerting / healing) an item
came from, so two L4 items sharing an id across sublists collide in the record
and in the merge provenance — left as is, because changing the key would break
the record of packs already upconverted downstream.
