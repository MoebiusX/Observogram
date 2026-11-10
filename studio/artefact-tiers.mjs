// studio/artefact-tiers.mjs — what people know and care about, and what they don't.
//
// A service is observed through one chain people know by name: the
// exporters that are scraped, the alerts that fire, the dashboards they
// open, and how fast an incident is detected and fixed (MTTD / MTTR). The
// engine counts far more than that — every panel of every dashboard, every
// recording rule, every pipeline part — and a count that mixes the two
// reads as noise ("741 things declared"). So every artefact family has a
// tier:
//
//   1  the chain      exporters · alerts · dashboards · MTTD / MTTR
//   2  the detail     what is of value under the chain: indicators,
//                     objectives, metrics, backends, alert routes, chaos
//                     tests, synthetic checks, …
//   3  the machinery  what makes it work and nobody asks about: panels,
//                     recording rules, pipeline parts, collection agents, …
//
// Overview shows tier 1 alone; Expert shows tiers 1 and 2, with tier 3
// folded until asked for. Nothing here changes what is graded or compared:
// the tiers sort what is shown and counted on screen.
//
// Zero imports: the board's copyable closure (docs/VENDORING.md) and
// tools/lib/journey.mjs both read it. A family is the artefact model's
// (tools/lib/artefact-classify.mjs FAMILIES); the studio never imports
// tools/lib, so FAMILY_BY_ID_PREFIX mirrors its ID_RULES and
// tools/test-artefact-tiers.mjs holds the two equal.

export const TIERS = Object.freeze([
  Object.freeze({ tier: 1, key: 'chain', name: 'The chain', words: 'exporters, alerts, dashboards and MTTD / MTTR' }),
  Object.freeze({ tier: 2, key: 'detail', name: 'The detail', words: 'indicators, objectives, metrics, backends, alert routes, chaos tests' }),
  Object.freeze({ tier: 3, key: 'machinery', name: 'The machinery', words: 'panels, recording rules, pipeline parts, collection agents' }),
]);

// The chain's links that are counted, in the order a signal travels; MTTD /
// MTTR is the fourth tile, and has no count of its own (a pack declares its
// targets once).
export const CHAIN_LINKS = Object.freeze([
  Object.freeze({ key: 'exporters', name: 'Exporters', families: Object.freeze(['scrape_job']), many: 'exporters', one: 'exporter', hint: 'what is scraped' }),
  Object.freeze({ key: 'alerts', name: 'Alerts', families: Object.freeze(['alert_rule', 'burn_rate']), many: 'alerts', one: 'alert', hint: 'what fires' }),
  Object.freeze({ key: 'dashboards', name: 'Dashboards', families: Object.freeze(['dashboard']), many: 'dashboards', one: 'dashboard', hint: 'what people open' }),
]);
export const MTTX_FAMILIES = Object.freeze(['baselines']);

// Every family of the artefact model, with its tier and its plain words
// (many, one). A family the table does not know is detail: shown, never
// folded away unasked — and so is `unknown`, what the classifier could not
// place (Discover's "Other"): nothing unexplained hides with the machinery.
export const FAMILY_TIERS = Object.freeze({
  scrape_job: 1, alert_rule: 1, burn_rate: 1, dashboard: 1, baselines: 1,
  sli: 2, slo: 2, metric: 2, backend: 2, alert_route: 2, chaos: 2, synthetic: 2, remediation: 2, forecast: 2,
  profiling: 2, storage_metrics: 2, storage_logs: 2, storage_traces: 2,
  panel: 3, recording_rule: 3, derived_view: 3, pipeline_receiver: 3, pipeline_processor: 3,
  pipeline_exporter_metrics: 3, pipeline_exporter_logs: 3, pipeline_exporter_traces: 3,
  otel: 3, collection: 3, network: 3, mesh: 3, policy_engine: 3, imports: 3, unknown: 2,
});
export const FAMILY_WORDS = Object.freeze({
  scrape_job: ['exporters', 'exporter'], alert_rule: ['alert rules', 'alert rule'], burn_rate: ['burn-rate alerts', 'burn-rate alert'],
  dashboard: ['dashboards', 'dashboard'], baselines: ['MTTD / MTTR targets', 'MTTD / MTTR target'],
  sli: ['indicators', 'indicator'], slo: ['objectives', 'objective'], metric: ['metrics', 'metric'], backend: ['backends', 'backend'],
  alert_route: ['alert routes', 'alert route'], chaos: ['chaos tests', 'chaos test'], synthetic: ['synthetic checks', 'synthetic check'],
  remediation: ['remediations', 'remediation'], forecast: ['forecasts', 'forecast'], profiling: ['profilers', 'profiler'],
  storage_metrics: ['metric stores', 'metric store'], storage_logs: ['log stores', 'log store'], storage_traces: ['trace stores', 'trace store'],
  panel: ['panels', 'panel'], recording_rule: ['recording rules', 'recording rule'], derived_view: ['derived views', 'derived view'],
  pipeline_receiver: ['pipeline receivers', 'pipeline receiver'], pipeline_processor: ['pipeline processors', 'pipeline processor'],
  pipeline_exporter_metrics: ['pipeline exporters', 'pipeline exporter'], pipeline_exporter_logs: ['pipeline exporters', 'pipeline exporter'],
  pipeline_exporter_traces: ['pipeline exporters', 'pipeline exporter'], otel: ['telemetry SDK settings', 'telemetry SDK setting'],
  collection: ['collection agents', 'collection agent'], network: ['network settings', 'network setting'], mesh: ['service meshes', 'service mesh'],
  policy_engine: ['policy engines', 'policy engine'], imports: ['imports', 'import'], unknown: ['other things', 'other thing'],
});
// The order a tier's families are listed in (the most known first).
const FAMILY_ORDER = Object.keys(FAMILY_TIERS);

// tools/lib/artefact-classify.mjs ID_RULES, the same order (the first prefix
// that matches wins).
export const FAMILY_BY_ID_PREFIX = Object.freeze([
  ['SLI-', 'sli'], ['SLO-', 'slo'], ['OTEL-', 'otel'], ['BAK-', 'backend'],
  ['PIP-RCV-', 'pipeline_receiver'], ['PIP-PRC-', 'pipeline_processor'],
  ['PIP-EXP-MET', 'pipeline_exporter_metrics'], ['PIP-EXP-LOG', 'pipeline_exporter_logs'], ['PIP-EXP-TRC', 'pipeline_exporter_traces'],
  ['STO-MET-', 'storage_metrics'], ['STO-LOG-', 'storage_logs'], ['STO-TRC-', 'storage_traces'],
  ['SCRAPE-SRC-', 'scrape_job'], ['SCRAPE-', 'scrape_job'], ['METRIC-SRC-', 'metric'], ['METRIC-', 'metric'],
  ['PROF-', 'profiling'], ['NET-', 'network'], ['POE-', 'policy_engine'], ['MESH-', 'mesh'], ['COL-', 'collection'],
  ['QRY-', 'recording_rule'], ['VIEW-', 'derived_view'], ['DASH-', 'dashboard'], ['PANEL-', 'panel'],
  ['POL-', 'burn_rate'], ['FCST-', 'forecast'], ['ALR-', 'alert_route'], ['RULE-', 'alert_rule'],
  ['HEAL-', 'remediation'], ['BASE-', 'baselines'], ['CHAOS-', 'chaos'], ['SYN-', 'synthetic'], ['IMP-', 'imports'],
].map((r) => Object.freeze(r)));

const LINK_OF_FAMILY = Object.freeze(Object.fromEntries(CHAIN_LINKS.flatMap((l) => l.families.map((f) => [f, l.key]))));

/** The tier of a family: 1, 2 or 3 (a family the table does not know is 2). */
export function tierOfFamily(family) {
  return FAMILY_TIERS[family] ?? 2;
}

/** Whether a family is the machinery (tier 3): folded in Expert until asked for. */
export function isMachinery(family) {
  return tierOfFamily(family) === 3;
}

/** The chain link a family counts under ('exporters' | 'alerts' | 'dashboards'), else null. */
export function chainLinkOf(family) {
  return LINK_OF_FAMILY[family] ?? null;
}

/** An artefact's family by its id, as the artefact model reads ids; '' when no prefix matches. */
export function familyOfArtefact(artefact) {
  const id = String(artefact?.id || '');
  const hit = FAMILY_BY_ID_PREFIX.find(([prefix]) => id.startsWith(prefix));
  return hit ? hit[1] : '';
}

/** The family of a comparison key (`<family>::identity`, tools/lib/diff.mjs). */
export function familyOfKey(key) {
  const k = String(key ?? '');
  const at = k.indexOf('::');
  return at > 0 ? k.slice(0, at) : '';
}

const isScaffold = (a) => a?.source === 'Scaffold';
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

// Every artefact of a layered pack (adapter.mjs's shape: a layer is a list,
// or an object of lists), once each.
export function packArtefacts(layered) {
  const out = [];
  for (const v of Object.values(layered?.layers || {})) {
    if (Array.isArray(v)) out.push(...v);
    else if (isObj(v)) for (const x of Object.values(v)) if (Array.isArray(x)) out.push(...x);
  }
  const seen = new Set();
  return out.filter((a) => {
    if (!isObj(a)) return false;
    const key = a.id ? `id:${a.id}` : a;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// declaredByTier(layered) → { links, mttx, objectives, detail, machinery }
//   links       { exporters, alerts, dashboards }: each { count, scaffold, families: { family: n } }
//               — what the repository declares, placeholders counted apart
//   mttx        { declared, mttd, mttr, mttd95, mttr95, scaffold, measured } — the pack's MTTD / MTTR
//               targets; `declared` only when they are the repository's own, not the scan's
//               placeholder. `measured`: the newest chaos run recorded in the repository with an
//               observed MTTD ({ mttd, at, experiment, outcome }), else null — nothing measures MTTR
//   objectives  { total, withoutAlert } — objectives, and those no burn-rate alert names
//   detail, machinery  { count, families: [{ family, count, words }] } — most first
export function declaredByTier(layered) {
  const families = {};
  const scaffolds = {};
  let baselines = null;
  let measured = null;
  const slos = [];
  const alerted = new Set();
  for (const a of packArtefacts(layered)) {
    if (a._evidence || a._propagated) continue;
    const family = familyOfArtefact(a);
    if (!family) continue;
    if (isScaffold(a)) { scaffolds[family] = (scaffolds[family] || 0) + 1; if (family === 'baselines' && !baselines) baselines = a; continue; }
    families[family] = (families[family] || 0) + 1;
    if (family === 'baselines') baselines = a;
    if (family === 'slo') slos.push(a);
    if (family === 'burn_rate') for (const r of Array.isArray(a.refs) ? a.refs : []) alerted.add(String(r));
    const run = family === 'chaos' ? a.spec?.last_result : null;
    if (isObj(run) && typeof run.observed_mttd === 'string' && typeof run.at === 'string' && Number.isFinite(Date.parse(run.at))
      && (!measured || Date.parse(run.at) > Date.parse(measured.at))) {
      measured = { mttd: run.observed_mttd, at: run.at, experiment: String(a.spec?.id || a.title || ''), outcome: String(run.outcome || '') };
    }
  }
  const links = Object.fromEntries(CHAIN_LINKS.map((l) => {
    const by = Object.fromEntries(l.families.filter((f) => families[f]).map((f) => [f, families[f]]));
    return [l.key, { count: l.families.reduce((n, f) => n + (families[f] || 0), 0), scaffold: l.families.reduce((n, f) => n + (scaffolds[f] || 0), 0), families: by }];
  }));
  const b = baselines?.spec || {};
  const mttx = {
    declared: !!baselines && !isScaffold(baselines),
    scaffold: !!baselines && isScaffold(baselines),
    mttd: typeof b.mttd_target_p50 === 'string' ? b.mttd_target_p50 : null,
    mttr: typeof b.mttr_target_p50 === 'string' ? b.mttr_target_p50 : null,
    mttd95: typeof b.mttd_target_p95 === 'string' ? b.mttd_target_p95 : null,
    mttr95: typeof b.mttr_target_p95 === 'string' ? b.mttr_target_p95 : null,
    measured,
  };
  const withoutAlert = slos.filter((s) => {
    const name = String(s.defines || '');
    return !(name && alerted.has(name)) && !(s.spec?.id && alerted.has(`slos.${s.spec.id}`));
  }).length;
  // Families that share their words (the three pipeline exporters) make one line.
  const tierList = (tier) => {
    const merged = new Map();
    for (const f of FAMILY_ORDER.filter((x) => tierOfFamily(x) === tier && families[x])
      .concat(Object.keys(families).filter((x) => !(x in FAMILY_TIERS) && tier === 2))) {
      const word = (FAMILY_WORDS[f] || [f])[0];
      const was = merged.get(word);
      if (was) was.count += families[f]; else merged.set(word, { family: f, count: families[f] });
    }
    const list = [...merged.values()].map((x) => ({ ...x, words: familyWords(x.family, x.count) }));
    return { count: list.reduce((n, x) => n + x.count, 0), families: list };
  };
  return { links, mttx, objectives: { total: slos.length, withoutAlert }, detail: tierList(2), machinery: tierList(3) };
}

/**
 * Counts by family ({ panel: 276, recording_rule: 39 }) in words, the
 * families that share their words (the three pipeline exporters) as one,
 * in the table's order: ['39 recording rules', '276 panels'].
 */
export function countsInWords(counts) {
  const merged = new Map();
  const known = FAMILY_ORDER.filter((f) => Number(counts?.[f]) > 0);
  const others = Object.keys(counts || {}).filter((f) => !(f in FAMILY_TIERS) && Number(counts[f]) > 0);
  for (const f of [...known, ...others]) {
    const word = (FAMILY_WORDS[f] || [f])[0];
    const was = merged.get(word);
    if (was) was.count += Number(counts[f]); else merged.set(word, { family: f, count: Number(counts[f]) });
  }
  return [...merged.values()].map((x) => familyWords(x.family, x.count));
}

/** "18 objectives", "1 objective" — a family's count in its words. */
export function familyWords(family, count) {
  const [many, one] = FAMILY_WORDS[family] || [String(family).replace(/_/g, ' '), String(family).replace(/_/g, ' ')];
  return `${count} ${count === 1 ? one : many}`;
}

// ---------- a comparison, counted by tier ----------

const EMPTY = () => ({ aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0, notRead: 0, setAside: 0 });

// comparisonByTier(diff) → { exporters, alerts, dashboards, mttx, detail, machinery }
//   each { aligned, drifted, declaredNotLive, liveNotDeclared, notRead, setAside }, and
//   mttx the MTTD / MTTR targets (the chain's fourth tile, never a count of its own), and
//   detail / machinery also `families`: { family: differences } — what differs from
//   what the repository declares (drifted, declared not live; live-only things are
//   counted in the slot, not here, as everywhere a screen says "differ"), most first.
//   notRead  declared, in a family the live side could not read (diff notObserved, side a)
//   The comparison is tools/lib/diff.mjs's, set-asides applied or not
//   (studio/set-asides.mjs puts those in a `setAside` bucket). Out-of-scope,
//   placeholders and declared-ahead things are counted nowhere, as in the summary:
//   the six slots add up to the summary's own counts.
export function comparisonByTier(diff) {
  const out = { exporters: EMPTY(), alerts: EMPTY(), dashboards: EMPTY(), mttx: EMPTY(), detail: { ...EMPTY(), families: {} }, machinery: { ...EMPTY(), families: {} } };
  const slotOf = (key) => {
    const family = familyOfKey(key);
    const link = chainLinkOf(family);
    if (link) return { slot: out[link], family };
    if (MTTX_FAMILIES.includes(family)) return { slot: out.mttx, family };
    return { slot: tierOfFamily(family) === 3 ? out.machinery : out.detail, family };
  };
  const add = (key, field) => {
    const hit = slotOf(key);
    hit.slot[field] += 1;
    if (hit.slot.families && (field === 'drifted' || field === 'declaredNotLive')) hit.slot.families[hit.family] = (hit.slot.families[hit.family] || 0) + 1;
  };
  for (const bucket of Object.values(diff?.layers || {})) {
    if (!isObj(bucket)) continue;
    for (const e of bucket.inBoth || []) add(e.key, e.match === 'drifted' ? 'drifted' : 'aligned');
    for (const e of bucket.onlyInA || []) add(e.key, 'declaredNotLive');
    for (const e of bucket.onlyInB || []) add(e.key, 'liveNotDeclared');
    for (const e of bucket.notObserved || []) if (e.side === 'a') add(e.key, 'notRead');
    for (const e of bucket.setAside || []) add(e.key, 'setAside');
  }
  for (const t of [out.detail, out.machinery]) {
    t.families = Object.fromEntries(Object.entries(t.families).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en')));
  }
  return out;
}

/**
 * What a tier's counts differ from what the repository declares: what runs
 * differently and what is declared and not live. Live-only things are not a
 * difference from the declaration (the board's differenceCount): they are
 * counted apart, in `liveNotDeclared`.
 */
export function differencesOf(counts) {
  if (!isObj(counts)) return 0;
  return (Number(counts.drifted) || 0) + (Number(counts.declaredNotLive) || 0);
}

// A chain link's counts in a few words: "21 of 21 live", "5 of 7 live (1 not
// as declared) · 2 live, not declared", "7 not read live", "none declared".
export function linkLine(counts) {
  const n = (k) => Number(counts?.[k]) || 0;
  const compared = n('aligned') + n('drifted') + n('declaredNotLive');
  const parts = [];
  if (compared) parts.push(`${n('aligned') + n('drifted')} of ${compared} live${n('drifted') ? ` (${n('drifted')} not as declared)` : ''}`);
  if (n('notRead')) parts.push(`${n('notRead')} not read live`);
  if (n('liveNotDeclared')) parts.push(`${n('liveNotDeclared')} live, not declared`);
  if (n('setAside')) parts.push(`${n('setAside')} set aside`);
  return parts.length ? parts.join(' · ') : 'none declared';
}

/** The chain of a run record (drift.tiers) in one line, or '' when the record has none. */
export function chainLine(tiers) {
  if (!isObj(tiers)) return '';
  return CHAIN_LINKS.filter((l) => isObj(tiers[l.key])).map((l) => `${l.name}: ${linkLine(tiers[l.key])}`).join(' · ');
}
