// studio/live-model.mjs
//
// The pure models of the live MCP connection (rebadge batch 3, C2): what
// the MCP panel draws from a POST /api/mcp/ping answer, and the duration
// sentences a long fetch states — and of the live panel (C1): when step 2
// may be drawn, the plan, the scope fields, the gate log, a job's result,
// and the pickers' scaffold / snapshot suffix. No DOM, no state, no fetch
// (docs/UI_CONVENTIONS.md §2): every input explicit, so the same functions
// run headlessly under node:test (tools/test-live-model.mjs).
//
// The answer's strings are the server's — the sentence, checked and
// notChecked are composed there and name only an origin, mapped tool names
// and counts — and the renderer (studio/live-view.mjs) puts every one of
// them into the DOM as text, never as markup.

// The inventory families a fetch reads, by capability id, as a person says
// them. The order is the order a fetch reads them in.
export const INVENTORY_FAMILIES = Object.freeze([
  ['metric_names', 'metric names'],
  ['recording_rules', 'recording rules'],
  ['alert_rules', 'alert rules'],
  ['dashboards', 'dashboards'],
  ['scrape_configs', 'scrape targets'],
  ['alerting_routes', 'alerting routes'],
]);
const FAMILY_LABEL = Object.freeze(Object.fromEntries(INVENTORY_FAMILIES));

// A capability id as a person reads it: the family's name, else the id with
// spaces for underscores.
export function capabilityLabel(id) {
  return FAMILY_LABEL[id] ?? String(id).replace(/_/g, ' ');
}

const STATUS = Object.freeze({
  connected: 'connected',
  'auth-refused': 'refused',
  unreachable: 'unreachable',
  timeout: 'timed out',
  'not-mcp': 'not an MCP server',
});

const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : null);

// The timings line: the steps that ran, in order.
function timingsText(t = {}) {
  return [
    ['initialize', t.initializeMs], ['tools/list', t.toolsListMs], ['read', t.readMs], ['total', t.totalMs],
  ].filter(([, v]) => Number.isFinite(v)).map(([k, v]) => `${k} ${ms(v)}`).join(' · ') || null;
}

// The families a fetch reads that the listing did not offer: a gap when the
// listing was complete, "not among the tools listed" when pages remained (a
// family may be on a page the ping did not read — never called absent).
function notOfferedText(tools) {
  if (!tools) return null;
  const missing = INVENTORY_FAMILIES.filter(([id]) => !tools.capabilities?.[id]).map(([, label]) => label);
  if (!missing.length) return null;
  return tools.complete === false
    ? `Not among the tools listed (more pages remained, so these may still be offered): ${missing.join(', ')}`
    : `Not offered by this MCP: ${missing.join(', ')}`;
}

// POST /api/mcp/ping's answer → what the panel draws: { ok, verdict, tone,
// status, sentence, timings, toolsLine, readLine (the read's bounded
// outcome), reads: [{ id, label, tools }],
// notOffered, checked, notChecked }. A non-answer (null) → null.
export function pingResultModel(answer) {
  if (!answer || typeof answer !== 'object' || typeof answer.verdict !== 'string') return null;
  const tools = answer.tools ?? null;
  const reading = tools ? tools.count - tools.unmatched : 0;
  const total = ms(answer.timings?.totalMs);
  const status = answer.verdict === 'connected'
    ? `connected${total ? ` · ${total}` : ''}${answer.read?.backendAuthRefused ? ' · its backend refused the MCP' : ''}`
    : (STATUS[answer.verdict] ?? answer.verdict);
  const tone = answer.verdict !== 'connected' ? 'error'
    : (answer.read?.backendAuthRefused || answer.read?.outcome === 'failed' || answer.read?.outcome === 'timeout') ? 'warn' : 'ok';
  return {
    ok: answer.ok === true,
    verdict: answer.verdict,
    tone,
    status,
    sentence: typeof answer.sentence === 'string' ? answer.sentence : '',
    timings: timingsText(answer.timings),
    toolsLine: tools
      ? `${tools.count} ${tools.count === 1 ? 'tool' : 'tools'} listed${tools.complete === false ? ' (more pages remained)' : ''}, ${reading} that a fetch reads`
      : null,
    readLine: answer.read?.outcome === 'ok' && answer.read.detail ? `${answer.read.tool}: ${answer.read.detail}` : null,
    reads: tools ? Object.entries(tools.capabilities ?? {}).map(([id, names]) => ({ id, label: capabilityLabel(id), tools: [...names] })) : [],
    notOffered: notOfferedText(tools),
    checked: Array.isArray(answer.checked) ? [...answer.checked] : [],
    notChecked: Array.isArray(answer.notChecked) ? [...answer.notChecked] : [],
  };
}

// The range measured on a full MCP tier, for a fetch that reads every family.
export const MEASURED_RANGE = '1–1.5 minutes';

const durationOf = (msTaken) => {
  const s = Math.max(1, Math.round(msTaken / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
};
const NOUN = Object.freeze({ snapshot: 'snapshot', draft: 'draft', rebuild: 'rebuild of production-live' });

// How long a fetch takes, from evidence: this org's last finished one of
// that kind when known, else the measured range — the same sentence for
// every kind (none is said to be faster).
export function durationText(kind, lastTookMs = null) {
  if (Number.isFinite(lastTookMs) && lastTookMs > 0) return `This org's last ${NOUN[kind] ?? kind} took ${durationOf(lastTookMs)}.`;
  return `Usually about ${MEASURED_RANGE} on a full MCP tier (measured); dashboards are read one by one.`;
}

// The rebuild's note under its button: what it does, how long, what it writes.
export function rebuildNoteText() {
  return `Rebuilds the live pack the LIVE badge reads — every inventory family is read again (usually about ${MEASURED_RANGE}); it writes an audit row.`;
}

// ---------- the live panel (rebadge batch 3, C1): test, choose, follow ----------

// What a picker would send, as one string — the key a ping is held under, so
// a ping never stands for another target (in memory only: it may hold the
// typed auth key, and is never stored).
export function liveTargetKey(body) {
  if (!body || typeof body !== 'object') return null;
  const id = body.mcpEndpointId ?? null;
  return JSON.stringify([id, id === null ? (body.mcpUrl ?? null) : null, body.mcpAuth ?? null]);
}

// Step 2 is drawn only after a connected ping for the target on screen: a
// change of the picker or of the auth field makes it stale.
//   pingFor: { key, ok } | null — the last ping; target: the picker's body
export function stepTwoVisible(pingFor, target) {
  return !!pingFor && pingFor.ok === true && pingFor.key !== null && pingFor.key === liveTargetKey(target);
}

// The kind the choice opens on: Draft (the default the SPEC keeps), Snapshot
// when the org configured a snapshot scope (GET /api/mcp/jobs scope.from).
export function preselectedKind(scopeFrom) {
  return scopeFrom === 'org' || scopeFrom === 'deployment' ? 'snapshot' : 'draft';
}

const splitList = (text) => String(text ?? '').split(',').map((s) => s.trim()).filter(Boolean);

// The scope fields, prefilled from the configured scope ({ defaults, from }).
export function scopeFormModel(scope) {
  const d = scope?.defaults ?? {};
  const from = scope?.from ?? null;
  return {
    prefixes: (d.metricPrefixes ?? []).join(', '),
    folders: (d.folderUids ?? []).join(', '),
    note: from === 'org' ? 'Prefilled from this org\'s configured snapshot scope.'
      : from === 'deployment' ? 'Prefilled from the server\'s configured snapshot scope.'
        : 'No snapshot scope is configured: empty fields read every metric name, dashboard and rule.',
    errors: Array.isArray(scope?.errors) ? [...scope.errors] : [],
  };
}

// The request's scope from the two fields (what the person sees is what is sent).
export function scopeFromForm({ prefixes = '', folders = '' } = {}) {
  return { metricPrefixes: splitList(prefixes), folderUids: splitList(folders) };
}

// The plan before a snapshot (fetchPlan's rows, the stages' labels) → the
// sentences: what this MCP does not offer, and what cannot be told.
//   plan: [{ stage, will, reason }]; stages: [{ id, label }]
export function planModel(plan, stages = []) {
  const label = new Map(stages.map((s) => [s.id, String(s.label).replace(/\s*\(.*\)\s*$/, '').toLowerCase()]));
  const rows = Array.isArray(plan) ? plan : [];
  const gaps = rows.filter((r) => r.will === 'gap').map((r) => label.get(r.stage) ?? r.stage);
  const unknown = rows.filter((r) => r.will === 'unknown').map((r) => label.get(r.stage) ?? r.stage);
  return {
    gaps,
    unknown,
    gapText: gaps.length ? `Not offered by this MCP: ${gaps.join(', ')} — the snapshot will name ${gaps.length === 1 ? 'it' : 'them'}` : null,
    unknownText: unknown.length ? `Not known before the fetch (tools/list was not read whole): ${unknown.join(', ')}` : null,
  };
}

// A gate-log state as a word and an icon — never colour alone.
export const STAGE_WORDS = Object.freeze({ pending: 'waiting', running: 'reading…', done: 'done', failed: 'failed', skipped: 'skipped' });
export const STAGE_ICONS = Object.freeze({ pending: '○', running: '◐', done: '✓', failed: '✗', skipped: '–' });

const countsText = (counts) => (counts && typeof counts === 'object'
  ? Object.entries(counts).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => `${k} ${v}`).join(' · ') || null
  : null);

// The job's records (any order, any repetition) → one row per stage of the
// kind, in fetch order: the last record of a stage wins; a stage without
// one is waiting.
//   stages: stagesFor(kind) — [{ id, label }]
export function gateLogModel(records, stages) {
  const last = new Map();
  for (const r of Array.isArray(records) ? records : []) {
    if (r && typeof r.stage === 'string') last.set(r.stage, r);
  }
  return (Array.isArray(stages) ? stages : []).map((s) => {
    const r = last.get(s.id);
    const state = r && Object.hasOwn(STAGE_WORDS, r.state) ? r.state : 'pending';
    return {
      id: s.id,
      label: s.label,
      state,
      word: STAGE_WORDS[state],
      icon: STAGE_ICONS[state],
      counts: countsText(r?.counts),
      message: r?.gap?.reason ?? r?.message ?? null,
    };
  });
}

// "1 min 12 s" / "8 s".
export function elapsedText(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
}

// The sentence for a job the server no longer has.
export const LIVE_JOB_GONE_TEXT = 'The server no longer has this job — it restarted, or the result expired 15 minutes after it finished. If it had finished, its pack is in the catalogue; otherwise start it again.';

// A finished job's poll answer → what the result block says: { state, tone,
// sentence, registered: { id, label } | null }. Running → null.
export function liveResultModel(answer) {
  const job = answer?.job;
  if (!job || job.state === 'running') return null;
  const result = answer.result ?? null;
  if (job.state === 'done' && result?.registered) {
    const n = Object.values(result.counts ?? {}).reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
    const gaps = (result.gaps ?? []).map((g) => g.stage.replace(/_/g, ' '));
    return {
      state: 'done',
      tone: 'ok',
      sentence: `Registered ${result.registered.label} — ${n} artefact${n === 1 ? '' : 's'}; gaps: ${gaps.length ? gaps.join(', ') : 'none'}`,
      registered: { ...result.registered },
    };
  }
  if (job.state === 'cancelled') return { state: 'cancelled', tone: 'error', sentence: 'Cancelled — nothing was registered.', registered: null };
  return { state: job.state, tone: 'error', sentence: answer.error ? `Failed: ${answer.error}` : 'Failed — nothing was registered.', registered: null };
}

// The pickers' suffix for a live pack (GET /api/packs `live`): a scaffold is
// never presented as a snapshot.
export function liveKindSuffix(entry) {
  if (entry?.live === 'scaffold') return ' · scaffold';
  if (entry?.live === 'snapshot') return ' · snapshot';
  return '';
}

// Compare's chip for a live pack: what the pack is, in one sentence.
//   { origin, at } from the snapshot's own annotations
export function liveChipText(live, { origin = null, at = null } = {}) {
  if (live === 'scaffold') return 'Scaffold — drafted from MCP discovery; sections marked scaffold are not compared';
  if (live === 'snapshot') return `Snapshot — inventory read from ${origin || 'a live MCP server'}${at ? ` at ${at}` : ''}`;
  return null;
}
