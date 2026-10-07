# Delivery report — rebadge batch 3 (live-fetch UX)

The short report the batch's acceptance asks for, per work item: what
shipped, the test counts, what is deferred and why. Rebadge batch 3
(`codex/rebadge-batch3`, stacked on STORE_PLAN slice 6b-i) delivers four
items — C0 a caller-supplied MCP URL is a privilege, C2 test the connection
then fetch, C1 a true-snapshot live pack, C3 comparison identity modes — in
that build order, each behind a documented seam and free of downstream
vocabulary. It is a reading aid over the documents that carry the detail —
`docs/CHANGELOG.md` (`## Unreleased`, the four `Rebadge batch 3, Cn`
entries), `docs/UPDATE_JOURNEY.md` ("Rebadge batch 3"), `docs/DOWNSTREAM.md`
§15 (the contracts and the migration), `docs/DIFF.md`, `docs/ADAPTER.md`,
`docs/MCP_INTEGRATION.md` and `docs/VENDORING.md` — and quotes nothing those
documents do not state. The totals below are the chain
`tools/test-doc-test-totals.mjs` guards: `npm test` on Linux, measured at
each item's last commit, from 1102 at the head of slice 6b-i to 1246 at the
end of C3, and 1247 at the head of this branch with the review fixes.

## What the scout and the critique found

- **A draft pairs zero only on a restricted tier.** Against a fake answering
  the recorded fixtures, the draft holds the real inventory and pairs 55 with
  the repository pack; with only the four core tools it pairs 0, because a
  tier that hides families leaves them parked as not observed.
- **Two identity defects.** The fetcher and the crawler slugged the same
  Grafana dashboard uid differently, so a live dashboard never paired with
  its crawled twin; and an alert-rule gap was not parked, so it read as
  drift. The snapshot uses the crawler's rule (`dashboardSpecId`) and parks
  every gapped family; the draft keeps both defects byte-identical, by name
  below.
- **A credential could follow a typed or redirected URL anywhere.** Nothing
  bounded which origin received an endpoint's server-held token or a deploy's
  write token, and `fetch` followed redirects. C0 closes both.

## C0 — a caller-supplied MCP URL is a privilege

**Shipped.** A typed MCP URL in the ping, the live jobs, draft-from-mcp,
refresh-live, deploy, deploy-bulk, rollback and a journey's raw Pack B URL is
the admin role's (`TYPED_MCP_URL_ROLE`, one constant); the open postures'
anonymous caller is refused by kind; operators, the bearer and every caller
without sign-in use registered endpoints, and the studio's pickers are
list-only for them. The MCP origin allowlist (`OBSERVOGRAM_MCP_ORIGINS` ∪
`OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS`) applies to every target at registration
and at use; with none set no credential — a server-held token, `mcpAuth`, a
credential in the URL or a loaded transport hook — leaves for an origin other
than loopback. Without sign-in only a loopback or listed origin may be
registered. The MCP client never follows a redirect and redacts every answer
text by value; the routes redact the resolved credential again. Declared
default changes, with the migration in `docs/DOWNSTREAM.md` §15.1. In the
token posture no server-side MCP fetch works until sign-in is armed and an
admin registers the endpoint (D11).

**Tests.** Tests: 1102 → 1134.

**Deferred.** None of C0's own; `journey-notify-env-ownership` (below) is a
pre-existing security item the batch found and leaves open.

## C2 — test the connection, then fetch

**Shipped.** `capabilityInventory` (an MCP's advertised tools mapped to the
capabilities Observogram reads), `pingMcp` (initialize, the whole tools list,
one cheap read, within 10 s; the verdict read from where a failure surfaced)
and `POST /api/mcp/ping`, the live MCP API's first route (direct without
sign-in, CSRF always, closed when exposed; it writes nothing but an admin's
typed-URL audit row). Draft-from-mcp and refresh-live joined that posture
(D7). The MCP panel's refresh button tests the connection; rebuilding
production-live is its own action.

**Tests.** Tests: 1134 → 1169.

**Deferred.** Nothing by name; the ping checks one read, never the backends
behind every other tool, and says so.

## C1 — a true-snapshot live pack

**Shipped.** The stored diff goldens (written before the engine changed);
`tools/lib/live-fetch.mjs` (the stage ids, the plan, the scope and its
annotations); `dashboardSpecId`; the MCP client's abort signal and 32 MiB
cap; the diff's parking of a snapshot's out-of-scope artefacts as *not
checked*; `fetchMcp` snapshot mode and `buildSnapshotPack` (no core abort,
every gap parked, the crawler's dashboard ids, the recording-rule inventory
kept, every alert-rule engine unioned); Grafana-managed alert rules read from
the provisioning shape (D9); `livePackKind` and `liveKind`; live MCP jobs
(202 and an id, the gate log by cursor, cancel, the configured scope,
bounded, authority re-checked before register, a `live.fetch` row at every
end); the studio's live panel (test, choose Draft or Snapshot, scope, the gate
log, resume after a reload) and the pickers' scaffold / snapshot suffix.

**Jobs live in the server's memory.** A restart loses every running and
finished job; a pack a job registered before the restart stays in the
catalogue. Polling a lost job answers 404 `{ gone: true }`, and the studio
says the job is gone and the pack, if any, is in the catalogue.

**D9's recording.** `tools/fixtures/mcp/grafana_alert_rules.json` was recorded
from Grafana 12.4.4's own provisioning API on the local Docker stack, not
through otel-mcp-server 1.8.0, which was not available to the build: the
rule shape is evidenced, the MCP's envelope around it is not.

**Tests.** Tests: 1169 → 1222.

**Deferred.** `snapshot-dashboard-concurrency`, `snapshot-scope-pushdown`
(the datasource uid), `live-jobs-durable`, `journey-snapshot-source`,
`refresh-live-as-job`, `draft-alert-rule-unobserved`, `draft-dashboard-ids`,
`draft-tools-list-pages`, `draft-mcp-url-origin` — each named in
`docs/DOWNSTREAM.md` §15.5. **D8:** the home card's **Connect**, the quick
start and the live panel all test the connection first and let the reader
choose Draft or Snapshot; the home's Connect drafts nothing itself.

## C3 — comparison identity modes

**Shipped.** `tools/lib/identity-modes.mjs` (listed: behaviour =
`identityKeyOf`, name and id keys, one material row per family, an artefact
without a name or stable id never paired, `pairingOf`); `diffPacks(a, b, {
identity })` with behaviour the byte-identical default — the stored diff
goldens run with `identity: 'behaviour'` and `identity: identityKeyOf` too;
the compare-modes fixture whose three modes give three distinct count sets
(behaviour 15 in both, 5 only in A, 5 only in B; name 16 / 4 / 4; id 17 / 3 /
3); Compare's **Pair by** switch, re-keyed in the browser over the two packs
on screen with no refetch, the stat bar's **paired by** cell, the pill and
the drawer naming the key.

**Tests.** Tests: 1222 → 1246.

**Deferred.** `diff-identity-query` (`/api/diff?identity=`),
`compare-modes-chains` (the traceability graph re-keyed by mode),
`compare-modes-bundle` (blocked with Compare in the static bundle),
`artefact-uid-annotation` (id mode for alert rules: spec 1.4's `AlertRule`
has no uid field, so a rule's id is its name).

## Review fixes

- **A successful MCP answer is redacted by value** (`tools/lib/mcp-client.mjs`):
  an MCP that repeated the endpoint's read token in a result (a version
  string) carried it into an operator's ping (`read.detail`) and into a
  snapshot, draft or refresh pack; every string of a result is now redacted
  as an error's text is. Tests: 1246 → 1247.
- **A short secret leaves a successful answer intact** (`tools/lib/mcp-client.mjs`):
  only a secret of 12 characters or more is redacted from a result, and a
  tool's JSON text is parsed first, so a credential-named `sortkey=title` or
  `partitionkey=1`, or a placeholder bearer, no longer renames keys, cuts
  ids or leaves a pack's JSON unparsed. Assertions in
  `tools/test-mcp-transport.mjs`; the test count is unchanged.

## What a plugin bridge still does that this batch does not

- **A datasource-uid push-down.** No capability row declares a datasource
  argument slot; the snapshot names the scope field in its gate log as not
  applied (`snapshot-scope-pushdown`).
- **Parallel dashboard detail reads.** The snapshot reads dashboard details
  one at a time (`snapshot-dashboard-concurrency`).
- **An MCP-evidenced Grafana-managed rule listing.** The provisioning shape
  is read, but its MCP envelope is not yet recorded (D9 above).

## Open security item

- **`journey-notify-env-ownership`** (pre-existing): a journey's capture
  accepts `notify` from an operator's body, and its `authEnv` / `urlEnv` may
  name any process variable — another org's `OBSERVOGRAM_ORG_<KEY>_*` value or
  a deployment secret could be sent as a bearer to a webhook. It is not an MCP
  target, so outside R4; the fix (which variable names a server-run journey
  may read, and the migration of bare names) needs its own design.
