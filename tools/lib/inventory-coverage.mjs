// tools/lib/inventory-coverage.mjs
//
// Inventory coverage: is the right number of things being monitored? A rendered site's
// `expected` block (tools/lib/site/expected.mjs, published in site.json) says what the inventory
// declares per kind — queue managers, brokers, hosts by name; queues per queue manager by
// count. A journey observes the live side through the MCP (tools/fetch-live-pack.mjs
// observeInventory: the `up` series per label, the counted kinds' queries) and this module does
// the arithmetic, the gate, the summary the listing shows and the series the Neuron draws.
// Pure and browser-safe (the studio imports it from /lib; node:test imports it directly).
//
// Vocabulary, kept honest:
//   - `silent`     inventoried, no `up` series at all — nothing targets it (the site's own
//                  Silent alert asks the same question in Prometheus).
//   - `down`       inventoried, targeted, every target down (`up == 0`).
//   - `up`         inventoried and answering.
//   - `unexpected` answering on the live side but not in the inventory: undeclared drift, or a
//                  stale inventory — a fact to look at, never a verdict here.
//   - status `checked` (every kind observed), `partial` (a kind's query failed), `not-attempted`
//     (file-sourced Pack B, or the MCP does not expose the metrics query tool), `failed`
//     (the site could not be read). Coverage never touches the grade or the alignment.

export const INVENTORY_STATUSES = Object.freeze(['checked', 'partial', 'not-attempted', 'failed']);
export const INVENTORY_GATE_KEYS = Object.freeze(['requireChecked', 'maxSilent', 'maxDown', 'maxUnexpected', 'minCoveragePct', 'kinds']);
export const INVENTORY_BLOCK_KEYS = Object.freeze(['site', 'kinds']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const list = (v) => (Array.isArray(v) ? v : []);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
const startedMs = (r) => { const t = Date.parse(r?.startedAt || ''); return Number.isFinite(t) ? t : null; };

// ---------- journey definition ----------

/** `inventory: { site, kinds? }` on a journey: the site.json of a partition (relative to the journey file) and an optional subset of kinds. Throws on a malformed block. */
export function validateInventoryBlock(value, journeyName = '?') {
  const where = `journey ${journeyName}: inventory`;
  if (!isRecord(value)) throw new Error(`${where} must be a mapping { site, kinds? }`);
  for (const k of Object.keys(value)) if (!INVENTORY_BLOCK_KEYS.includes(k)) throw new Error(`${where}.${k} is not a known key (known: ${INVENTORY_BLOCK_KEYS.join(', ')})`);
  if (typeof value.site !== 'string' || !value.site.trim()) throw new Error(`${where}.site must name a gen-site partition's site.json`);
  if (value.kinds !== undefined) {
    if (!Array.isArray(value.kinds) || !value.kinds.length || !value.kinds.every(k => typeof k === 'string' && IDENT.test(k))) throw new Error(`${where}.kinds must be a non-empty list of kind names`);
  }
}

/** `gate.inventory: { requireChecked?, maxSilent?, maxDown?, maxUnexpected?, minCoveragePct?, kinds? }`. Throws on a malformed block. */
export function validateGateInventory(value, journeyName = '?') {
  const where = `journey ${journeyName}: gate.inventory`;
  if (!isRecord(value)) throw new Error(`${where} must be a mapping`);
  for (const k of Object.keys(value)) if (!INVENTORY_GATE_KEYS.includes(k)) throw new Error(`${where}.${k} is not a known key (known: ${INVENTORY_GATE_KEYS.join(', ')})`);
  if (value.requireChecked !== undefined && typeof value.requireChecked !== 'boolean') throw new Error(`${where}.requireChecked must be true or false`);
  for (const k of ['maxSilent', 'maxDown', 'maxUnexpected']) {
    if (value[k] !== undefined && !(Number.isInteger(value[k]) && value[k] >= 0)) throw new Error(`${where}.${k} must be a non-negative integer`);
  }
  if (value.minCoveragePct !== undefined && !(typeof value.minCoveragePct === 'number' && value.minCoveragePct >= 0 && value.minCoveragePct <= 100)) throw new Error(`${where}.minCoveragePct must be a number between 0 and 100`);
  if (value.kinds !== undefined && (!Array.isArray(value.kinds) || !value.kinds.length || !value.kinds.every(k => typeof k === 'string' && IDENT.test(k)))) throw new Error(`${where}.kinds must be a non-empty list of kind names`);
}

// ---------- the expected sets ----------

/** The `expected` block of a site.json, normalised; null when the manifest carries none. */
export function expectedFromSite(site) {
  const e = isRecord(site) ? site.expected : null;
  if (!isRecord(e) || !isRecord(e.kinds)) return null;
  const kinds = {};
  for (const [k, spec] of Object.entries(e.kinds)) {
    if (!IDENT.test(k) || !isRecord(spec)) continue;
    kinds[k] = {
      title: typeof spec.title === 'string' && spec.title ? spec.title : k,
      label: typeof spec.label === 'string' && IDENT.test(spec.label) ? spec.label : k,
      series: typeof spec.series === 'string' ? spec.series : null,
      jobs: list(spec.jobs).filter(j => typeof j === 'string' && j),
      names: list(spec.names).filter(n => typeof n === 'string' && n),
      by: isRecord(spec.by) ? spec.by : {},
      query: typeof spec.query === 'string' && spec.query ? spec.query : null,
      per: typeof spec.per === 'string' && IDENT.test(spec.per) ? spec.per : null,
      min: isRecord(spec.min) ? Object.fromEntries(Object.entries(spec.min).filter(([, v]) => Number.isInteger(v) && v >= 0)) : {},
    };
  }
  return { environment: typeof e.environment === 'string' ? e.environment : (typeof site.environment === 'string' ? site.environment : null), series_prefix: typeof e.series_prefix === 'string' ? e.series_prefix : null, kinds };
}

const isCounted = (spec) => !!spec.query;

/**
 * The PromQL a kind is observed with. An enumerated kind reads `max by (<label>) (up[{job=~…}])`:
 * one series per label value, 1 when any target answers, 0 when every target is down, absent
 * when nothing targets it. A counted kind reads its own query as the site wrote it.
 */
export function promqlForKind(spec) {
  if (isCounted(spec)) return { mode: 'counted', query: spec.query, by: spec.per };
  const sel = spec.jobs.length ? `up{job=~${JSON.stringify(spec.jobs.map(escapeRe).join('|'))}}` : 'up';
  return { mode: 'enumerated', query: `max by (${spec.label}) (${sel})`, by: spec.label };
}
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Coverage of one kind from its observation `{ values: { [labelValue]: number }, error }`
 * (values = the instant vector reduced by the `by` label). Returns the record block for the kind.
 */
export function coverageOfKind(spec, observation) {
  const values = isRecord(observation?.values) ? observation.values : {};
  const error = observation?.error ? String(observation.error) : null;
  if (isCounted(spec)) {
    const counts = Object.fromEntries(Object.entries(values).filter(([, v]) => Number.isFinite(v)).map(([k, v]) => [k, v]));
    const floors = spec.min || {};
    const below = Object.entries(floors).filter(([p, m]) => Number.isFinite(counts[p]) && counts[p] < m).map(([p, m]) => ({ parent: p, count: counts[p], min: m }));
    const missing = Object.keys(floors).filter(p => !Number.isFinite(counts[p]));
    return {
      mode: 'counted', title: spec.title, label: spec.label, per: spec.per, query: spec.query,
      status: error ? 'failed' : 'checked', error,
      total: Object.values(counts).reduce((s, v) => s + v, 0), counts, min: floors, below, missing,
    };
  }
  const names = spec.names;
  const set = new Set(names);
  const up = names.filter(n => values[n] !== undefined && values[n] > 0);
  const down = names.filter(n => values[n] !== undefined && !(values[n] > 0));
  const silent = names.filter(n => values[n] === undefined);
  const unexpected = Object.keys(values).filter(n => !set.has(n)).sort();
  return {
    mode: 'enumerated', title: spec.title, label: spec.label, series: spec.series, jobs: spec.jobs,
    status: error ? 'failed' : 'checked', error,
    expected: names.length, observed: names.length - silent.length,
    up: up.length, upNames: up, down, silent, unexpected,
    coveragePct: names.length ? Math.round((up.length / names.length) * 1000) / 10 : null,
  };
}

/**
 * The `inventory` block of a run record.
 *   { site, expected, observations, kinds?, status?, reason?, checkedAt }
 * `observations` = { [kind]: { values, error } } from observeInventory; a kind without one is
 * `not-attempted`. `status` / `reason` override (file-sourced B, no metrics tool, unreadable site).
 */
export function buildInventoryRecord({ site = null, expected, observations = {}, kinds = null, status = null, reason = null, checkedAt = null } = {}) {
  const wanted = expected ? Object.keys(expected.kinds).filter(k => !kinds || kinds.includes(k)) : [];
  const out = {};
  for (const k of wanted) {
    const spec = expected.kinds[k];
    const obs = observations?.[k];
    out[k] = obs ? coverageOfKind(spec, obs) : { mode: isCounted(spec) ? 'counted' : 'enumerated', title: spec.title, label: spec.label, status: 'not-attempted', error: null, ...(isCounted(spec) ? { total: null, counts: {}, min: spec.min || {}, below: [], missing: Object.keys(spec.min || {}) } : { expected: spec.names.length, observed: null, up: null, upNames: [], down: [], silent: [], unexpected: [], coveragePct: null }) };
  }
  let derived = status;
  if (!derived) {
    const statuses = Object.values(out).map(k => k.status);
    derived = !statuses.length ? 'not-attempted' : statuses.every(s => s === 'checked') ? 'checked' : statuses.every(s => s === 'not-attempted') ? 'not-attempted' : 'partial';
  }
  return {
    status: INVENTORY_STATUSES.includes(derived) ? derived : 'failed',
    reason: reason ?? (derived === 'partial' ? `${Object.entries(out).filter(([, k]) => k.status !== 'checked').map(([n, k]) => `${n}: ${k.error || k.status}`).join('; ')}` : null),
    site, environment: expected?.environment ?? null, checkedAt,
    kinds: out,
  };
}

// ---------- gate ----------

/** Breaches of `gate.inventory` against a record's inventory block; `add(criterion, detail)`. */
export function evaluateInventoryGate(gate, inventory, add) {
  if (!isRecord(gate)) return;
  const requireChecked = gate.requireChecked !== false;
  if (!isRecord(inventory)) {
    if (requireChecked) add('inventory', 'no inventory coverage on this run (the journey declares gate.inventory but no inventory: block) — coverage unknown');
    return;
  }
  if (inventory.status !== 'checked' && requireChecked) {
    add('inventory', `inventory coverage ${inventory.status}${inventory.reason ? ` (${inventory.reason})` : ''} — the right number of monitored things cannot be confirmed`);
  }
  const kinds = Object.entries(inventory.kinds || {}).filter(([k]) => !Array.isArray(gate.kinds) || gate.kinds.includes(k));
  for (const [k, c] of kinds) {
    if (c.status !== 'checked') continue;
    if (c.mode === 'enumerated') {
      if (Number.isInteger(gate.maxSilent) && c.silent.length > gate.maxSilent) add(`inventory.${k}.silent`, `${c.silent.length} inventoried ${c.title}${c.silent.length === 1 ? '' : 's'} with no up series (max ${gate.maxSilent}): ${few(c.silent)}`);
      if (Number.isInteger(gate.maxDown) && c.down.length > gate.maxDown) add(`inventory.${k}.down`, `${c.down.length} inventoried ${c.title}${c.down.length === 1 ? '' : 's'} targeted but down (max ${gate.maxDown}): ${few(c.down)}`);
      if (Number.isInteger(gate.maxUnexpected) && c.unexpected.length > gate.maxUnexpected) add(`inventory.${k}.unexpected`, `${c.unexpected.length} ${c.title}${c.unexpected.length === 1 ? '' : 's'} answering but not in the inventory (max ${gate.maxUnexpected}): ${few(c.unexpected)}`);
      if (typeof gate.minCoveragePct === 'number' && c.coveragePct !== null && c.coveragePct < gate.minCoveragePct) add(`inventory.${k}.coverage`, `${c.up}/${c.expected} ${c.title}${c.expected === 1 ? '' : 's'} up = ${c.coveragePct}% (min ${gate.minCoveragePct}%)`);
    } else {
      // a floor is a declared expectation: below it breaches whatever else the gate says
      for (const b of c.below) add(`inventory.${k}.min`, `${b.count} ${c.title}${b.count === 1 ? '' : 's'} on ${b.parent} (min ${b.min})`);
      for (const p of c.missing) add(`inventory.${k}.min`, `no ${c.title} count for ${p} (min ${c.min[p]}) — the query returned nothing for it`);
    }
  }
}
const few = (arr, n = 6) => (arr.length <= n ? arr.join(', ') : `${arr.slice(0, n).join(', ')} +${arr.length - n}`);

// ---------- surfaces ----------

/** The listing's summary of a record's inventory block; null without one. */
export function inventorySummary(record) {
  const inv = isRecord(record?.inventory) ? record.inventory : null;
  if (!inv) return null;
  const kinds = {};
  for (const [k, c] of Object.entries(inv.kinds || {})) {
    kinds[k] = c.mode === 'counted'
      ? { mode: 'counted', title: c.title, status: c.status, total: c.total, below: c.below.length, missing: c.missing.length }
      : { mode: 'enumerated', title: c.title, status: c.status, expected: c.expected, up: c.up, down: c.down.length, silent: c.silent.length, unexpected: c.unexpected.length, coveragePct: c.coveragePct };
  }
  return { status: inv.status, reason: inv.reason ?? null, environment: inv.environment ?? null, kinds };
}

/** One line for `journey list` and the markdown table: 'inventory 11/12 qmgr · 3/3 host · 40 queues' / 'inventory not attempted (…)'; null without a block. */
export function inventoryStatusLine(record) {
  const inv = isRecord(record?.inventory) ? record.inventory : null;
  if (!inv) return null;
  if (inv.status === 'not-attempted' || inv.status === 'failed') return `inventory ${inv.status}${inv.reason ? ` (${inv.reason})` : ''}`;
  const bits = Object.entries(inv.kinds || {}).map(([k, c]) => {
    if (c.status !== 'checked') return `${k} ${c.status}`;
    if (c.mode === 'counted') return `${c.total} ${c.title}${c.total === 1 ? '' : 's'}${c.below.length ? ` (${c.below.length} below floor)` : ''}`;
    const extra = [c.down.length ? `${c.down.length} down` : null, c.silent.length ? `${c.silent.length} silent` : null, c.unexpected.length ? `${c.unexpected.length} unexpected` : null].filter(Boolean);
    return `${c.up}/${c.expected} ${k}${extra.length ? ` (${extra.join(', ')})` : ''}`;
  });
  return `inventory ${bits.join(' · ')}${inv.status === 'partial' ? ' · partial' : ''}`;
}

/** Coverage of one enumerated kind across runs, oldest first: [{ t, expected, up, silent, down, unexpected, coveragePct }]; runs without the kind are skipped. */
export function inventorySeries(runs, kind) {
  return list(runs).filter(isRecord)
    .map((r, i) => ({ r, i, t: startedMs(r) }))
    .sort((a, b) => ((a.t ?? -Infinity) - (b.t ?? -Infinity)) || a.i - b.i)
    .filter(({ r }) => isRecord(r.inventory?.kinds?.[kind]) && r.inventory.kinds[kind].status === 'checked' && r.inventory.kinds[kind].mode === 'enumerated')
    .map(({ r, t }) => { const c = r.inventory.kinds[kind]; return { t, expected: c.expected, up: c.up, silent: c.silent.length, down: c.down.length, unexpected: c.unexpected.length, coveragePct: c.coveragePct }; });
}
