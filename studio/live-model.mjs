// studio/live-model.mjs
//
// The pure models of the live MCP connection (rebadge batch 3, C2): what
// the MCP panel draws from a POST /api/mcp/ping answer, and the duration
// sentences a long fetch states. No DOM, no state, no fetch
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
