# Live-fetch UX (rebadge batch 3)

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §15, keeping its section numbers.*

Four changes to how a live pack is fetched and compared, each its own
CHANGELOG entry (`## Unreleased`, "Rebadge batch 3, C0 … C3"): a
caller-supplied MCP URL is a privilege (15.1), a live pack is built as a job
whose progress is a polled gate log and can be a true snapshot (15.2), a
connection is tested before anything is fetched (15.3), and Compare can pair
by name or id as well as by behaviour (15.4). The engines are vendorable:
`tools/lib/live-fetch.mjs` and `tools/lib/identity-modes.mjs` are new listed
modules, and `diff.mjs`, `mcp-capabilities.mjs`, `service-keys.mjs`,
`crawler.mjs`, `pack-conformance.mjs`, `journey.mjs` and `mcp-client.mjs`
changed (docs/VENDORING.md has the rows).

## 15.1 A caller-supplied MCP URL is a privilege

**The rule.** Supplying the URL a server-side request goes to is the
privilege, not which endpoint uses it. A typed `mcpUrl` in `POST
/api/mcp/ping`, `POST /api/mcp/jobs`, `POST /api/draft-from-mcp`, `POST
/api/refresh-live`, the deploy routes (`POST /api/packs/:id/deploy/:target`,
`…/deploy-bulk`, `POST /api/deploys/:deployId/rollback`) and a journey's raw
Pack B URL needs the **admin** role in the org (an owner included) — one
constant, `TYPED_MCP_URL_ROLE` in `server/mcp-target-policy.mjs`, against
which sessions and the bearer token are judged by rank. The open postures'
anonymous caller is refused by kind, even on loopback. Operators, the bearer
and every caller without sign-in fetch from the org's **registered endpoints**
only (`mcpEndpointId`, listed by `GET /api/mcp-endpoints`, whose `policy`
says what the reader may do); the studio's pickers are list-only for them.
Every refusal names the way that works for its reader in its posture.

**The origin allowlist** applies to every target whatever the caller's role —
a typed URL, a registered endpoint at each use, and an endpoint when it is
registered or its `url` / `readTokenEnv` changes. `OBSERVOGRAM_MCP_ORIGINS`
(every org) ∪ `OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS` (one org, read only by the
org that owns the name): comma-separated origins, no path, query, fragment,
credentials or `*` in a host (a rejected entry is named once on stderr and
ignored); a lone `*` allows every origin; loopback always passes. With a list
set, every other origin must be in it. **With none set, no credential leaves
for an origin other than loopback** — not an endpoint's server-held token, not
the caller's `mcpAuth` (every deploy sends one), not a credential in a typed
URL, and nothing while a transport hook is loaded (it may attach its own). A
server-held token rides only to its own endpoint's registered URL. Without
sign-in, only a loopback MCP or a listed origin may be registered at all.

**The client** (`tools/lib/mcp-client.mjs`, every caller: the server, `npm
run fetch-live`, the scheduled workflow, journeys) never follows a redirect,
redacts every MCP answer text by value (the bearer, URL userinfo and
credential-named query values), caps one answer at 32 MiB and honours a
caller's `AbortSignal`.

**The token posture.** Nobody can register an endpoint there (registration
is an admin's; the bearer is an operator), so no server-side MCP fetch works
until sign-in is armed (`npm run users -- add <login>`, no restart) and a
signed-in admin registers the endpoint; the bearer then uses it by id.

**Migration, in this order:**

1. List every remote MCP origin that receives a credential — an endpoint with
   `readTokenEnv`, every deploy target, a transport hook's targets — in
   `OBSERVOGRAM_MCP_ORIGINS` (or the org's own variable) **before upgrading**.
   A token-less MCP and a loopback one need nothing.
2. Register, as an admin (Settings → MCP endpoints, or `POST
   /api/mcp-endpoints`), every endpoint a CI script or an operator typed.
3. Send `mcpEndpointId` in place of `mcpUrl` from every caller below admin —
   the write token of a deploy stays the request's `mcpAuth`. A script that
   drafts or refreshes against a server without sign-in sends
   `X-Observogram-CSRF: 1` and reaches it on loopback.
4. Stop relying on redirects: configure the MCP's final URL (http → https and
   a trailing slash included). A journey captured with a raw URL is
   re-captured by an admin so its Pack B names a registered endpoint.

## 15.2 Live jobs, the snapshot and the gate log

A live pack is built as a **job** (RULINGS R1): `POST /api/mcp/jobs` answers
202 at once and the client polls the job's gate log. Two kinds: `draft` (the
scaffold `POST /api/draft-from-mcp` builds, byte for byte) and `snapshot` (an
inventory of what is deployed). The routes (the live MCP API's posture:
`direct` without sign-in, CSRF on the POSTs, closed when exposed):

| Route | Answer |
|---|---|
| `GET /api/mcp/jobs` | `{ ok, scope: { defaults, from, errors }, running, lastTook: { snapshot, draft } }` |
| `POST /api/mcp/jobs` `{ kind, mcpEndpointId \| mcpUrl, mcpAuth?, scope?, packName?, label? }` | 202 `{ ok, job: JobView, poll }`, `Location: <poll>` |
| `GET /api/mcp/jobs/:jobId?since=<seq>` | `{ ok, job: JobView, stages: [StageRecord], next, result?, error? }` |
| `POST /api/mcp/jobs/:jobId/cancel` | `{ ok, job }` (its starter: the JobView; an admin of the org: `{ id, state }`, never the log); 409 once ended |

`JobView` = `{ id, kind, state: running | done | failed | cancelled,
cancelRequested, startedAt, finishedAt, elapsedMs, label, target: {
mcpEndpoint, origin }, scope }`. `StageRecord` = `{ seq, stage, label, state:
pending | running | done | failed | skipped, counts, startedAt, finishedAt,
message, gap: { capability, reason } | null }` — every message redacted with
the resolved target and cut at 300 characters; send `next` back as `since`.
`Result` = `{ registered: { id, label } | null, validation, counts, gaps,
tookMs, draft? }` (`draft`: the draft's summary, conformance and endpoint). A
job is its starter's: another member's, another org's, one that expired (15
minutes after it ended) or that a restart lost is the same 404 `{ ok: false,
gone: true, error }`. Bounded: one running job per org, four per server, eight
finished per org, a 10-minute watchdog, 500 records. **Jobs live in the
server's memory**: a restart loses running and finished jobs (a pack
registered before stays). Every end writes one `live.fetch` audit row.

**The stage ids** are a contract (`LIVE_STAGES`, `tools/lib/live-fetch.mjs`):
a downstream maps its own progress names onto them, an id never changes
meaning, and a new stage is a new id.

| Stage id | Label | Kinds | Capabilities it reads |
|---|---|---|---|
| `connect` | Connect (initialize, tools/list) | snapshot, draft | — |
| `services` | Services (health, topology) | snapshot, draft | `system_health`, `system_topology`, `anomalies_active`, `anomalies_baselines` |
| `backends` | Backends and versions | snapshot, draft | `backend_capabilities`, `grafana_version`, `build_info_versions`, `traces_alive` |
| `metric_names` | Metric names | snapshot, draft | `metric_names` |
| `recording_rules` | Recording rules | snapshot, draft | `recording_rules` |
| `alert_rules` | Alert rules | snapshot, draft | `alert_rules` |
| `dashboards` | Dashboards | snapshot, draft | `dashboards`, `dashboard_detail` |
| `scrape_targets` | Scrape targets | snapshot, draft | `scrape_configs` |
| `alerting_routes` | Alerting routes | snapshot, draft | `alerting_routes` |
| `signals` | Stack signals (self-metrics, Alertmanager, Grafana, rule evidence) | draft | — |
| `build` | Build and validate the pack | snapshot, draft | — |
| `register` | Register the pack | snapshot, draft | — |

```js
import { stagesFor, fetchPlan, normalizeScope } from './vendor/observogram/live-fetch.mjs';
import { capabilityInventory } from './vendor/observogram/contracts/mcp-capabilities.mjs';
const plan = fetchPlan(capabilityInventory(advertisedToolNames).capabilities, { kind: 'snapshot', complete: true });
// plan: [{ stage, will: 'run' | 'gap' | 'unknown', reason }] — unknown when tools/list was not read whole, never a claimed gap
```

**What a snapshot writes.** `mcp.url` is the MCP's origin only;
`observogram.live.mode: snapshot`, `observogram.live.source`,
`observogram.live.scope`, `observogram.live.gaps`; `observogram.scope.<kind>`
for each family the scope narrowed; and `observogram.unobserved.<kind>` for
every family of a gapped stage, with the stage's reason. The diff reads both
families of keys: an artefact the snapshot did not look at — outside its scope
or in a gapped family — is *not checked*, never *declared, not live*
(docs/DIFF.md). The catalogue labels the pack (`live: 'snapshot'`, a draft
`live: 'scaffold'`) and a snapshot's conformance report says `liveKind:
'snapshot'` (docs/ADAPTER.md). These are provenance claims like any
annotation: a hand-uploaded pack can make them.

**The scope.** `OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES`,
`OBSERVOGRAM_SNAPSHOT_FOLDER_UIDS`, `OBSERVOGRAM_SNAPSHOT_DATASOURCE_UID`,
`OBSERVOGRAM_SNAPSHOT_METRIC_EXCLUDE`, `OBSERVOGRAM_SNAPSHOT_RULE_GROUPS` for the deployment and
`OBSERVOGRAM_ORG_<KEY>_SNAPSHOT_*` for one org — the org's overriding the
deployment's field by field; a request's `scope` replaces the configured one
whole. Inert when unset; the draft and the refresh never read them. Metric
prefixes filter the name list, then the exclude patterns drop names from what
the prefixes kept (anchored, bounded regexes, white-space-separated in the
variable — a backend's names that no declaration will ever match, an
exporter's malformed mints; the count is in the gate log, the patterns ride in
`observogram.scope.metric` as `exclude`, and the diff parks a repository
metric they match as *not checked*), then a 20 000-name cap, named; folder
uids filter dashboards before the detail reads and alert rules when every
rule names its folder (an alert-rule tool that takes a folder uid — Grafana's,
through its registry row's `runtimeArgs` slot — is asked once per folder and the
gate log says the scope was pushed down; it is read whole instead, and said,
when a folder gets no answer, when the tool ignores the argument, or when
another engine names no folder, so the pack never holds half an engine; folders
that hold no rule still record the scope); rule
groups filter alert and recording rules when every rule the engines list names
its group (Grafana's `ruleGroup`, a `groups[].name`), compared exactly, and the
gate log says when a listing names none; the groups ride in
`observogram.scope.<rule family>` (`{ by: "group", values }`, or `groups` on
the folder entry) and the diff parks a repository rule of another group — the
group its `source` names — as *not checked*; a datasource uid is named in the
gate log as not applied, because no advertised tool takes one. The exclusion is a scope
field, not a setting: the regex that names one product's junk belongs in the
deployment's or the org's variable, never in the engine.

**Adding a capability with a scope argument.** Record the tool's real answer
first (`npm run record-fixtures -- --write`, against the product at a pinned
version), then add the candidate to `tools/lib/contracts/mcp-capabilities.mjs`
with a `runtimeArgs` slot (`{ argName: slotName }`) the fetcher fills from the
scope — the data layer never reads the environment — and its response shape
(the first such slot is `grafana_alert_rules`'s `folder_uid`, whose per-folder
answer is the recorded provisioning shape, folder by folder)
to `contracts/response-shapes.mjs`; `tools/test-contract-shapes.mjs` and the
contract guard then pin both. No tool name is typed anywhere else.

**Retiring a plugin bridge, step by step.** (1) Run a snapshot against the
same MCP and compare it with the pack the bridge produces (Compare, or
`diffPacks` directly); (2) map the bridge's progress names onto the stage ids
above and read the gate log in place of the bridge's own; (3) move the
bridge's filters into the scope variables; (4) check each family the bridge
fills against the snapshot's `observogram.live.gaps` — a gap the bridge fills
is a reason to keep it; (5) switch the consumers to the snapshot, keep the
bridge one release for comparison, then remove it. **What this batch cannot
replace:** a datasource-uid push-down (no capability declares the slot), and
parallel dashboard detail reads (the snapshot reads them one at a time).
Grafana-managed alert rules are read from the provisioning shape recorded
from Grafana itself (the MCP's envelope around it is not yet evidenced).

## 15.3 The ping

`POST /api/mcp/ping` `{ mcpEndpointId | mcpUrl, mcpAuth? }` runs `initialize`,
the whole `tools/list` (up to ten pages) and **one** cheap read, within 10 s,
and answers `{ ok, verdict, origin, mcpEndpoint, reachable, auth: { outcome,
sent }, tools: { count, capabilities, unmatched, complete }, read, timings,
sentence, checked, notChecked }`. `verdict` is `connected`, `auth-refused`,
`unreachable`, `timeout` or `not-mcp`, read from where a failure surfaced. Tool
names appear only through `capabilityInventory` (the capabilities a fetch
reads; every other tool is a count). It does not check the backends behind
every other tool, whether a fetch would finish within its limits, or — when
the read is the Grafana health check — whether the MCP's backend credentials
work (`read.credentialFree`, and `notChecked` says so). It writes no pack and
no live file; an admin's typed-URL ping writes one `live.ping` row.

## 15.4 Identity modes

What pairs an artefact of pack A with one of pack B is a mode of
`tools/lib/identity-modes.mjs` (RULINGS R3): `behaviour` (the default —
`identityKeyOf`, what the artefact does), `name` (the name or title) or `id`
(a stable id or uid; a family whose name is its id uses the name). Behaviour
still decides aligned vs drifted in every mode. A downstream's own diff
verification calls the same functions the studio does:

```js
import { diffPacks } from './vendor/observogram/diff.mjs';
import { identityMode, pairingOf } from './vendor/observogram/identity-modes.mjs';
const byName = diffPacks(a, b, { identity: 'name' });          // byName.identity → { mode: 'name' }
const key = identityMode('id').keyOf(artefact, { side: 'a' });   // 'dashboard::{"id":"ord-1"}'
const why = pairingOf(artefact, 'id');                           // 'dashboard uid "ord-1"'
```

`identity` may also be a function `(artefact, { side }) → '<kind>::…'`; a key
without the `<kind>::` prefix is a TypeError. Omitted, `'behaviour'` or
`identityKeyOf` itself, the answer is byte-identical to today's and carries no
`identity` key. An artefact without a name (or a stable id) is keyed with its
side and its own artefact id, so it never pairs. The material per family is
the table in docs/ADAPTER.md. `GET /api/diff` takes no identity parameter:
the studio re-keys in the browser over the two packs on screen.

## 15.5 Follow-ups, by name

- *`snapshot-dashboard-concurrency`* — bounded parallel detail reads (it
  changes the load on the MCP).
- *`snapshot-scope-pushdown`* — capability rows with recorded scope arguments
  (the datasource uid).
- *`artefact-uid-annotation`* — id mode for Grafana-managed rules (spec 1.4's
  `AlertRule` has no uid field, so a rule's id is its name).
- *`diff-identity-query`* (`/api/diff?identity=`), *`compare-modes-chains`*
  (the traceability graph re-keyed by mode). *`compare-modes-bundle`* is
  closed by the follow-up `compare-in-bundle` ([`DOWNSTREAM.md`](DOWNSTREAM.md) §10): with Compare answered in
  the static bundle, Pair by re-keys its diff in the browser as on a server.
- *`live-jobs-durable`* — jobs in the store, so they survive a restart.
- *`journey-snapshot-source`* — re-snapshot on a journey run, with the
  captured scope.
- *`refresh-live-as-job`* — the rebuild of production-live is still a held
  request.
- *`draft-alert-rule-unobserved`*, *`draft-dashboard-ids`*,
  *`draft-tools-list-pages`* — the draft's own alert-rule gap, dashboard id
  rule and single-page listing, kept byte-identical.
- *`draft-mcp-url-origin`* — a draft keeps the safe URL with its path in
  `mcp.url` (a snapshot keeps the origin).
- *`journey-notify-env-ownership`* (security, pre-existing) — **closed by
  [`NOTIFY_HOOKS.md`](NOTIFY_HOOKS.md)**: a server-run journey's notification reads only its org's own
  notify hook, `OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL` and that hook's
  `_TOKEN`; [`NOTIFY_HOOKS.md`](NOTIFY_HOOKS.md) §17.2 is the migration.
