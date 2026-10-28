// tools/lib/pack-update.mjs — the UPDATE journey's engine (docs/UPDATE_JOURNEY.md).
//
// Build is a generator: a pack is a function of its inputs and every change
// regenerates the whole pack. This module is what lets a pack that already
// exists be opened on Build's screen and saved as the next version of itself:
//
//   - recoverBuildInputs  — the inputs Build made the pack from, read back from the
//                           `library.*` annotations the generator writes;
//   - additions           — the artefacts a user added by hand on top of Build's
//                           output (a second SLO on an SLI with its burn-rate alert,
//                           a route, a plain alert rule), recorded in the pack itself
//                           under `library.additions` and re-applied after every
//                           regenerate, so a regenerate can never drop them;
//   - comparePacks        — two packs artefact by artefact, in one normal form, so
//                           the studio can say "Build rebuilt it and got the same
//                           pack" or name exactly what differs;
//   - rebuildPack         — the three together: the Open stage's answer;
//   - foreignAsAdditions  — the things a pack holds that Build did not write, read
//                           in as additions where the kind allows it;
//   - nextVersion / stampUpdate — the next version of the same pack and the
//                           lineage annotation the registry keeps versions by.
//
// Pure and DOM-free. Nothing here stamps a time; the input packs are never mutated.
import { instantiatePack, BURN_PROFILES, DEFAULT_BURN_PROFILE, SLO_WINDOWS, SECTION_TOGGLES, TIERS, sloIdFor } from './library.mjs';
import { livePackKind } from './service-keys.mjs';

export const ADDITIONS_KEY = 'library.additions';
export const UPDATE_PREVIOUS_KEY = 'library.update.previous';
export const UPDATE_PREVIOUS_VERSION_KEY = 'library.update.previousVersion';
export const ADDITION_KINDS = Object.freeze(['slo', 'route', 'alert_rule']);
export const SEVERITIES = Object.freeze(['SEV1', 'SEV2', 'SEV3', 'SEV4']);
export const CHANNEL_KINDS = Object.freeze(['msteams', 'voice', 'whatsapp', 'email', 'webhook']);
export const ALERT_ENGINES = Object.freeze(['prometheus', 'mimir', 'thanos', 'victoriametrics', 'loki', 'grafana', 'alertmanager']);
/** The schema's Slug (an SLO id), Duration and SemVer. */
export const SLUG_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;
const DURATION_RE = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/;
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
export const MAX_ADDITIONS = 200;

const clone = (v) => v === undefined ? undefined : JSON.parse(JSON.stringify(v));
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const text = (v) => typeof v === 'string' ? v.trim() : '';
const ann = (canonical) => (isObj(canonical?.metadata?.annotations) ? canonical.metadata.annotations : {});

// ---------------------------------------------------------------------------
// 1. Origin — what kind of pack this is, from the pack alone
// ---------------------------------------------------------------------------

/**
 * 'build' (made in Build: carries `library.source`), 'scan' (a reading of a repository:
 * `crawler.discoveredAt`), 'live' (drafted from the live system), 'hand' (uploaded or written
 * by hand: none of the above). The studio adds 'example' for a pack that ships with it — the
 * pack cannot tell that about itself, so the caller passes `{ shipped: true }`.
 */
export function packOrigin(canonical, { shipped = false } = {}) {
  if (shipped) return 'example';
  const a = ann(canonical);
  if (livePackKind(canonical)) return 'live';
  if (text(a['crawler.discoveredAt'])) return 'scan';
  if (text(a['library.source'])) return 'build';
  return 'hand';
}

// ---------------------------------------------------------------------------
// 2. The reader — a pack → Build's inputs
// ---------------------------------------------------------------------------

const parseJsonObject = (s) => { try { const v = JSON.parse(s); return isObj(v) ? v : null; } catch { return null; } };
const splitList = (s) => text(s) ? s.split(',').map(x => x.trim()).filter(Boolean) : [];

/**
 * The inputs Build made a pack from, read back from the `library.*` annotations: the entries
 * (`id@version`), name, owners, environment, tier, the section toggles and the SLI selection,
 * the provided params, the overrides and the custom SLIs (their definitions rebuilt from the
 * pack's own SLI and SLO, since the annotation holds their ids only). `null` for a pack Build did
 * not make. `notes` names what the pack could not say (a custom SLI's objective when SLOs are
 * off), each with the value assumed.
 */
export function recoverBuildInputs(canonical) {
  const a = ann(canonical);
  const source = text(a['library.source']);
  if (!source) return null;
  const notes = [];
  const entries = splitList(source).map(s => { const [id, version] = s.split('@'); return { id: id.trim(), version: (version || '').trim() || null }; }).filter(e => e.id);
  const tier = TIERS.includes(a['library.tier']) ? a['library.tier'] : (canonical?.metadata?.bindings?.criticality || null);
  if (!TIERS.includes(tier)) notes.push({ field: 'tier', note: `the pack names no tier; ${TIERS[0]} assumed` });
  const toggleList = splitList(a['library.toggles']);
  const toggles = Object.fromEntries(SECTION_TOGGLES.map(k => [k, a['library.toggles'] === undefined ? true : toggleList.includes(k)]));
  const slis = splitList(a['library.slis']);
  const params = a['library.params'] === undefined ? {} : (parseJsonObject(a['library.params']) || (notes.push({ field: 'params', note: 'library.params is not a JSON object; no params assumed' }), {}));
  const overrides = a['library.overrides'] === undefined ? undefined : (parseJsonObject(a['library.overrides']) || (notes.push({ field: 'overrides', note: 'library.overrides is not a JSON object; no overrides assumed' }), undefined));
  const customIds = splitList(a['library.custom']);
  const spec = isObj(canonical?.spec) ? canonical.spec : {};
  const custom = customIds.map(id => {
    const sli = (spec.slis || []).find(s => s?.id === id);
    if (!sli) { notes.push({ field: `custom.${id}`, note: `the pack no longer holds the custom SLI ${id}; it is left out` }); return null; }
    const def = { id, type: sli.type };
    for (const f of ['description', 'unit', 'semconv_metric', 'good', 'total', 'query', 'threshold', 'good_when']) if (sli[f] !== undefined) def[f] = sli[f];
    const slo = (spec.slos || []).find(s => s?.sli === id);
    if (slo) { def.objective = slo.objective; def.window = slo.window; } else {
      def.objective = 0.99; def.window = '30d';
      notes.push({ field: `custom.${id}.objective`, note: `the pack holds no SLO for the custom SLI ${id}, so its objective is stored nowhere; 99% over 30d assumed` });
    }
    return def;
  }).filter(Boolean);
  const inputs = {
    entries,
    name: canonical?.metadata?.name || '',
    owners: Array.isArray(canonical?.metadata?.owners) ? canonical.metadata.owners.map(String) : [],
    environment: text(a['library.environment']) || canonical?.metadata?.bindings?.environments?.[0] || 'prod',
    tier: TIERS.includes(tier) ? tier : TIERS[0],
    toggles: { ...toggles, slis },
    params,
    ...(overrides ? { overrides } : {}),
    ...(custom.length ? { custom } : {}),
  };
  return { inputs, notes };
}

// ---------------------------------------------------------------------------
// 3. Additions — recorded in the pack, re-applied after every regenerate
// ---------------------------------------------------------------------------

/** The additions a pack records (`library.additions`), or [] — a malformed annotation reads as none. */
export function readAdditions(canonical) {
  const raw = ann(canonical)[ADDITIONS_KEY];
  if (typeof raw !== 'string' || !raw.trim()) return [];
  try {
    const list = JSON.parse(raw);
    return Array.isArray(list) ? list.filter(isObj) : [];
  } catch { return []; }
}

/** The default burn-rate windows of an added SLO: the SLI type's profile, severities demoted one step at tier-3. */
export function defaultBurnWindows(sliType, tier) {
  const profile = BURN_PROFILES[DEFAULT_BURN_PROFILE[sliType] || 'availability'];
  const demote = { SEV1: 'SEV2', SEV2: 'SEV3', SEV3: 'SEV3', SEV4: 'SEV4' };
  return profile.map(w => ({ ...w, severity: tier === 'tier-3' ? demote[w.severity] : w.severity }));
}

/** `sloIdFor` for an addition: the SLO id Build would give that SLI at that objective. */
export const additionSloId = (sliId, objective) => sloIdFor(sliId, objective);

const checkWindow = (w, at) => {
  if (!isObj(w)) return `${at}: expected { short, long, factor, severity }`;
  if (!DURATION_RE.test(String(w.short))) return `${at}.short: not a duration (${JSON.stringify(w.short)})`;
  if (!DURATION_RE.test(String(w.long))) return `${at}.long: not a duration (${JSON.stringify(w.long)})`;
  if (typeof w.factor !== 'number' || !(w.factor > 1)) return `${at}.factor: a number above 1 is required`;
  if (!SEVERITIES.includes(w.severity)) return `${at}.severity: expected ${SEVERITIES.join(' | ')}`;
  return null;
};

const checkChannel = (c, at) => {
  if (!isObj(c)) return `${at}: expected { <kind>: <address> }`;
  const keys = Object.keys(c);
  if (keys.length !== 1) return `${at}: one kind per channel`;
  if (!CHANNEL_KINDS.includes(keys[0])) return `${at}: kind ${JSON.stringify(keys[0])} — expected ${CHANNEL_KINDS.join(' | ')}`;
  if (!text(c[keys[0]])) return `${at}.${keys[0]}: an address is required`;
  if (keys[0] === 'webhook' && !/^https?:\/\/\S+$/i.test(c.webhook.trim())) return `${at}.webhook: an http(s) URL is required`;
  return null;
};

const stringMap = (m, at) => {
  if (m === undefined) return null;
  if (!isObj(m) || Object.values(m).some(v => typeof v !== 'string')) return `${at}: expected a map of strings`;
  return null;
};

/** The name the compiler gives a burn-rate alert (tools/lib/compile.mjs): `<slo>_burn_<factor>x_<short>_<long>`. */
const burnAlertNames = (spec) => new Set((spec.policy?.burn_rate_alerts || []).flatMap(b => (b.windows || []).map(w => `${b.slo}_burn_${w.factor}x_${w.short}_${w.long}`)));

/**
 * One addition checked against the pack it lands in. Returns the normalised addition or
 * `{ error }`. The checks are the schema's and the generator's own (an SLO id is a slug, its
 * SLI exists, a route has a severity and channels, an alert rule's name is unique and is not a
 * burn-rate alert's) — a refused addition is named, never dropped silently.
 */
export function checkAddition(addition, spec) {
  if (!isObj(addition)) return { error: 'an addition is an object { kind, … }' };
  const kind = addition.kind;
  if (!ADDITION_KINDS.includes(kind)) return { error: `kind ${JSON.stringify(kind)} — expected ${ADDITION_KINDS.join(' | ')}` };
  if (kind === 'slo') {
    const slo = isObj(addition.slo) ? addition.slo : null;
    if (!slo) return { error: 'slo: expected { id, sli, objective, window, error_budget_policy? }' };
    const sli = (spec.slis || []).find(s => s?.id === slo.sli);
    if (!sli) return { error: `slo.sli: the pack has no SLI ${JSON.stringify(slo.sli)}` };
    if (typeof slo.objective !== 'number' || !(slo.objective > 0 && slo.objective < 1)) return { error: 'slo.objective: a number between 0 and 1 (0.9995 for 99.95%)' };
    if (!SLO_WINDOWS.includes(slo.window)) return { error: `slo.window: expected ${SLO_WINDOWS.join(' | ')}` };
    const id = text(slo.id) || sloIdFor(slo.sli, slo.objective);
    if (!SLUG_RE.test(id) || id.length < 2 || id.length > 64) return { error: `slo.id: not a slug (${JSON.stringify(id)})` };
    if ((spec.slos || []).some(s => s?.id === id)) return { error: `slo.id: the pack already has an SLO ${id}` };
    const policy = text(slo.error_budget_policy) || (spec.slos || []).find(s => text(s?.error_budget_policy))?.error_budget_policy || 'ref:platform/std-budget-policy';
    const windows = Array.isArray(addition.burn_rate?.windows) ? addition.burn_rate.windows : null;
    if (!windows || windows.length < 2) return { error: 'burn_rate.windows: at least two windows { short, long, factor, severity }' };
    for (let i = 0; i < windows.length; i++) { const e = checkWindow(windows[i], `burn_rate.windows[${i}]`); if (e) return { error: e }; }
    return {
      kind, slo: { id, sli: slo.sli, objective: slo.objective, window: slo.window, error_budget_policy: policy, ...(isObj(slo.labels) ? { labels: clone(slo.labels) } : {}) },
      burn_rate: { slo: id, windows: windows.map(w => ({ short: String(w.short), long: String(w.long), factor: w.factor, severity: w.severity })) },
    };
  }
  if (kind === 'route') {
    const route = isObj(addition.route) ? addition.route : null;
    if (!route) return { error: 'route: expected { severity, channels, match? }' };
    if (!SEVERITIES.includes(route.severity)) return { error: `route.severity: expected ${SEVERITIES.join(' | ')}` };
    if (!Array.isArray(route.channels) || !route.channels.length) return { error: 'route.channels: at least one channel { <kind>: <address> }' };
    for (let i = 0; i < route.channels.length; i++) { const e = checkChannel(route.channels[i], `route.channels[${i}]`); if (e) return { error: e }; }
    const m = stringMap(route.match, 'route.match'); if (m) return { error: m };
    const out = { severity: route.severity, channels: route.channels.map(c => { const k = Object.keys(c)[0]; return { [k]: c[k].trim() }; }) };
    if (route.match && Object.keys(route.match).length) out.match = clone(route.match);
    const same = (spec.alerting?.routes || []).some(r => JSON.stringify(normalize(r)) === JSON.stringify(normalize(out)));
    if (same) return { error: `route: the pack already routes ${out.severity} to exactly these channels` };
    return { kind, route: out };
  }
  // alert_rule
  const rule = isObj(addition.rule) ? addition.rule : null;
  if (!rule) return { error: 'rule: expected { name, expr, severity?, for?, labels?, annotations?, engine? }' };
  const name = text(rule.name);
  if (!name || name.length > 190) return { error: 'rule.name: 1 to 190 characters' };
  if ((spec.alerting?.rules || []).some(r => r?.name === name)) return { error: `rule.name: the pack already has an alert rule named ${name}` };
  if (burnAlertNames(spec).has(name)) return { error: `rule.name: ${name} is a burn-rate alert of this pack; a rule may not appear in both` };
  const expr = typeof rule.expr === 'string' ? rule.expr.trim() : '';
  if (!expr) return { error: 'rule.expr: the condition in the engine\'s own language is required' };
  if (rule.severity !== undefined && !SEVERITIES.includes(rule.severity)) return { error: `rule.severity: expected ${SEVERITIES.join(' | ')}` };
  if (rule.for !== undefined && !DURATION_RE.test(String(rule.for))) return { error: `rule.for: not a duration (${JSON.stringify(rule.for)})` };
  if (rule.engine !== undefined && !ALERT_ENGINES.includes(rule.engine)) return { error: `rule.engine: expected ${ALERT_ENGINES.join(' | ')}` };
  for (const f of ['labels', 'annotations']) { const e = stringMap(rule[f], `rule.${f}`); if (e) return { error: e }; }
  const out = { name, expr };
  if (rule.severity !== undefined) out.severity = rule.severity;
  if (rule.for !== undefined) out.for = String(rule.for);
  if (rule.engine !== undefined) out.engine = rule.engine;
  if (isObj(rule.labels) && Object.keys(rule.labels).length) out.labels = clone(rule.labels);
  if (isObj(rule.annotations) && Object.keys(rule.annotations).length) out.annotations = clone(rule.annotations);
  if (text(rule.source)) out.source = rule.source.trim();
  return { kind, rule: out };
}

const ensureList = (root, path) => {
  let node = root;
  for (const seg of path.slice(0, -1)) { if (!isObj(node[seg])) node[seg] = {}; node = node[seg]; }
  const leaf = path[path.length - 1];
  if (!Array.isArray(node[leaf])) node[leaf] = [];
  return node[leaf];
};

/**
 * The pack with its additions applied, in order, and recorded under `library.additions` (the
 * applied ones, normalised). An addition the pack cannot take is returned under `refused` with
 * its reason and its index; the rest still apply. The input is not mutated.
 */
export function applyAdditions(canonical, additions = []) {
  const out = clone(canonical) || {};
  if (!isObj(out.spec)) out.spec = {};
  if (!isObj(out.metadata)) out.metadata = {};
  if (!isObj(out.metadata.annotations)) out.metadata.annotations = {};
  const applied = [];
  const refused = [];
  const list = Array.isArray(additions) ? additions.slice(0, MAX_ADDITIONS) : [];
  if (Array.isArray(additions) && additions.length > MAX_ADDITIONS) refused.push({ index: MAX_ADDITIONS, addition: null, reason: `at most ${MAX_ADDITIONS} additions` });
  list.forEach((addition, index) => {
    const checked = checkAddition(addition, out.spec);
    if (checked.error) { refused.push({ index, addition, reason: checked.error }); return; }
    if (checked.kind === 'slo') {
      ensureList(out.spec, ['slos']).push(checked.slo);
      ensureList(out.spec, ['policy', 'burn_rate_alerts']).push(checked.burn_rate);
    } else if (checked.kind === 'route') {
      ensureList(out.spec, ['alerting', 'routes']).push(checked.route);
    } else {
      ensureList(out.spec, ['alerting', 'rules']).push(checked.rule);
    }
    applied.push(checked);
  });
  if (applied.length) out.metadata.annotations[ADDITIONS_KEY] = JSON.stringify(applied);
  else delete out.metadata.annotations[ADDITIONS_KEY];
  return { canonical: out, applied, refused };
}

/** One line for an addition, in the user's terms. */
export function additionLabel(addition) {
  if (!isObj(addition)) return 'an addition';
  if (addition.kind === 'slo') {
    const pct = addition.slo?.objective != null ? `${Number((addition.slo.objective * 100).toFixed(4))}%` : '';
    return `SLO ${addition.slo?.id || ''} ${pct} on ${addition.slo?.sli || '?'}, with its burn-rate alert`.replace(/\s+/g, ' ').trim();
  }
  if (addition.kind === 'route') {
    const ch = (addition.route?.channels || []).map(c => { const k = Object.keys(c)[0]; return `${k} ${c[k]}`; }).join(', ');
    return `route ${addition.route?.severity || '?'} → ${ch || '?'}`;
  }
  if (addition.kind === 'alert_rule') return `alert rule ${addition.rule?.name || '?'}${addition.rule?.severity ? ` (${addition.rule.severity})` : ''}`;
  return `an addition (${addition.kind})`;
}

// ---------------------------------------------------------------------------
// 4. The comparison — two packs artefact by artefact, in one normal form
// ---------------------------------------------------------------------------

/**
 * The normal form: keys sorted, trailing newlines on strings dropped (a multi-line expression
 * gains one on its way through YAML), `undefined` members gone.
 */
export function normalize(value) {
  if (Array.isArray(value)) return value.map(normalize);
  if (isObj(value)) {
    const out = {};
    for (const k of Object.keys(value).sort()) { const v = normalize(value[k]); if (v !== undefined) out[k] = v; }
    return out;
  }
  if (typeof value === 'string') return value.replace(/\n+$/, '');
  return value;
}
const same = (a, b) => JSON.stringify(normalize(a)) === JSON.stringify(normalize(b));

// The artefact families, in the order the studio lists them: where each lives and how it is keyed.
// Routes carry no id: the n-th route of a severity is `route:<severity>` then `route:<severity>#2`…
const FAMILIES = [
  { kind: 'sli', path: ['slis'], key: (x) => x?.id },
  { kind: 'slo', path: ['slos'], key: (x) => x?.id },
  { kind: 'burn_rate', path: ['policy', 'burn_rate_alerts'], key: (x) => x?.slo },
  { kind: 'forecast', path: ['policy', 'forecasts'], key: (x) => x?.slo ?? x?.id },
  { kind: 'alert_rule', path: ['alerting', 'rules'], key: (x) => x?.name },
  { kind: 'route', path: ['alerting', 'routes'], key: (x) => x?.severity, repeat: true },
  { kind: 'recording_rule', path: ['queries', 'recording_rules'], key: (x) => x?.name },
  { kind: 'derived_view', path: ['queries', 'derived_views'], key: (x) => x?.id },
  { kind: 'dashboard', path: ['dashboards'], key: (x) => x?.id },
  { kind: 'synthetic', path: ['validation', 'synthetic_checks'], key: (x) => x?.id },
  { kind: 'chaos', path: ['validation', 'chaos_experiments'], key: (x) => x?.id },
  { kind: 'remediation', path: ['remediation'], key: (x) => x?.id ?? x?.trigger },
  { kind: 'backend', path: ['telemetry', 'backends'], key: (x) => `${x?.product}/${x?.signal}` },
];
const FAMILY_KINDS = new Set(FAMILIES.map(f => f.kind));
const listAt = (spec, path) => { let n = spec; for (const seg of path) { if (!isObj(n)) return []; n = n[seg]; } return Array.isArray(n) ? n : []; };

/**
 * Every artefact of a pack by key: `<kind>:<id>` for the families above, `section:<name>` for
 * what remains of each spec section once its listed families are taken out (otel, pipelines,
 * storage, baselines, the rest of policy and alerting…), and `metadata` for the identity without
 * version and annotations. A Map in a stable order.
 */
export function artefactIndex(canonical) {
  const spec = isObj(canonical?.spec) ? canonical.spec : {};
  const out = new Map();
  const meta = isObj(canonical?.metadata) ? { ...canonical.metadata } : {};
  delete meta.version; delete meta.annotations;
  out.set('metadata', meta);
  for (const f of FAMILIES) {
    const seen = new Map();
    for (const item of listAt(spec, f.path)) {
      const id = f.key(item);
      const base = `${f.kind}:${id ?? '?'}`;
      const n = (seen.get(base) || 0) + 1;
      seen.set(base, n);
      out.set(n === 1 ? base : `${base}#${n}`, item);
    }
  }
  const taken = new Map();
  for (const f of FAMILIES) { if (!taken.has(f.path[0])) taken.set(f.path[0], []); taken.get(f.path[0]).push(f.path.slice(1)); }
  for (const name of Object.keys(spec).sort()) {
    const subs = taken.get(name);
    if (!subs) { out.set(`section:${name}`, spec[name]); continue; }
    if (subs.some(s => s.length === 0)) continue;   // the section IS a family list (slis, slos, dashboards, remediation)
    const rest = isObj(spec[name]) ? { ...spec[name] } : spec[name];
    if (isObj(rest)) for (const s of subs) delete rest[s[0]];
    if (isObj(rest) && Object.keys(rest).length) out.set(`section:${name}`, rest);
  }
  return out;
}

/** `slo:availability_99_5` → { kind: 'slo', id: 'availability_99_5', n: 1 }. */
export function parseArtefactKey(key) {
  const m = /^([a-z_]+):(.*?)(?:#(\d+))?$/.exec(String(key || ''));
  if (!m) return { kind: key === 'metadata' ? 'metadata' : null, id: null, n: 1 };
  return { kind: m[1], id: m[2], n: m[3] ? Number(m[3]) : 1 };
}

const KIND_WORDS = {
  sli: 'SLI', slo: 'SLO', burn_rate: 'burn-rate alert on', forecast: 'forecast on', alert_rule: 'alert rule', route: 'route',
  recording_rule: 'recording rule', derived_view: 'derived view', dashboard: 'dashboard', synthetic: 'synthetic check', chaos: 'chaos experiment',
  remediation: 'remediation', backend: 'backend', section: 'section', metadata: 'identity',
};

/** One line for an artefact key, in the user's terms: `SLO availability_99_5`, `route SEV2 (2nd)`. */
export function artefactLabel(key, value = null) {
  const { kind, id, n } = parseArtefactKey(key);
  if (kind === 'metadata') return 'the pack\'s identity (name, owners, bindings)';
  const word = KIND_WORDS[kind] || kind || 'artefact';
  if (kind === 'route' && isObj(value)) {
    const ch = (value.channels || []).map(c => { const k = Object.keys(c)[0]; return `${k} ${c[k]}`; }).join(', ');
    return `route ${id} → ${ch}`;
  }
  if (kind === 'section') return `the ${id} section`;
  return `${word} ${id}${n > 1 ? ` (${n}${n === 2 ? 'nd' : n === 3 ? 'rd' : 'th'})` : ''}`;
}

/**
 * Two packs artefact by artefact: `onlyInA`, `onlyInB` (each `{ key, value }`), `changed`
 * (`{ key, a, b }`) and `same` (the keys). Pure; the order is the index's.
 */
export function comparePacks(a, b) {
  const ia = artefactIndex(a);
  const ib = artefactIndex(b);
  const onlyInA = [];
  const onlyInB = [];
  const changed = [];
  const sameKeys = [];
  for (const [key, va] of ia) {
    if (!ib.has(key)) { onlyInA.push({ key, value: va }); continue; }
    if (same(va, ib.get(key))) sameKeys.push(key); else changed.push({ key, a: va, b: ib.get(key) });
  }
  for (const [key, vb] of ib) if (!ia.has(key)) onlyInB.push({ key, value: vb });
  return { onlyInA, onlyInB, changed, same: sameKeys };
}

/** The fields of an artefact that differ between two versions: `[{ field, a, b }]` (one level deep; nested values as JSON). */
export function fieldDiff(a, b) {
  const out = [];
  if (!isObj(a) || !isObj(b)) return same(a, b) ? [] : [{ field: '', a, b }];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    if (!same(a[k], b[k])) out.push({ field: k, a: a[k], b: b[k] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. Rebuild — the Open stage's answer
// ---------------------------------------------------------------------------

/**
 * Open a pack as Build would: recover the inputs, regenerate from the library (`resolveEntry(id)`
 * gives a library entry or null), re-apply the recorded additions, and compare the result with the
 * stored pack. Returns
 *   { origin, inputs, notes, additions, refused, rebuilt, exact, differences, foreign, missing, errors }
 * — `differences` are artefacts Build would write differently today (`{ key, stored, rebuilt, fields }`),
 * `foreign` the artefacts the stored pack holds that Build (with the additions) did not write,
 * `missing` the ones Build would write that the pack no longer holds. A pack Build did not make
 * comes back with `inputs: null` and `rebuilt: null`; an entry the library no longer has is an error.
 */
export function rebuildPack(canonical, { resolveEntry, promql = null, shipped = false } = {}) {
  const origin = packOrigin(canonical, { shipped });
  const additions = readAdditions(canonical);
  const base = { origin, additions, inputs: null, notes: [], refused: [], rebuilt: null, exact: false, differences: [], foreign: [], missing: [], errors: [] };
  const rec = recoverBuildInputs(canonical);
  if (!rec) return base;
  base.inputs = rec.inputs;
  base.notes = rec.notes;
  if (typeof resolveEntry !== 'function') { base.errors.push('no library to rebuild from'); return base; }
  const entries = [];
  for (const e of rec.inputs.entries) {
    const entry = resolveEntry(e.id);
    if (!entry) { base.errors.push(`the library has no entry ${e.id} (the pack was built from ${e.id}@${e.version || '?'})`); continue; }
    if (e.version && entry.version && String(entry.version) !== String(e.version)) base.notes.push({ field: `entries.${e.id}`, note: `the library's ${e.id} is ${entry.version}; the pack was built from ${e.version}` });
    entries.push(entry);
  }
  if (base.errors.length) return base;
  let made;
  try {
    const { entries: _ignored, ...opts } = rec.inputs;
    made = instantiatePack(entries, { ...opts, ...(promql ? { promql } : {}) });
  } catch (e) {
    base.errors.push(`Build cannot rebuild this pack from its definition: ${e.message}`);
    return base;
  }
  const applied = applyAdditions(made.canonical, additions);
  base.refused = applied.refused;
  base.rebuilt = applied.canonical;
  base.generated = made.canonical;
  base.todos = made.todos;
  base.warnings = made.warnings;
  const cmp = comparePacks(canonical, applied.canonical);
  base.differences = cmp.changed.map(c => ({ key: c.key, stored: c.a, rebuilt: c.b, fields: fieldDiff(c.a, c.b) }));
  base.foreign = cmp.onlyInA;
  base.missing = cmp.onlyInB;
  base.exact = !base.differences.length && !base.foreign.length && !base.missing.length && !base.refused.length;
  return base;
}

/**
 * The things a pack holds that Build did not write, read in as additions where the kind allows it
 * (slice 2): an SLO with the burn-rate alert the pack holds for it, a route, an alert rule. The rest
 * is `leftover` — artefacts that cannot be opened before slice 3 (a dashboard, a recording rule, a
 * burn-rate alert without its SLO…). `foreign` is rebuildPack's.
 */
export function foreignAsAdditions(foreign = []) {
  const byKey = new Map(foreign.map(f => [f.key, f.value]));
  const used = new Set();
  const additions = [];
  const leftover = [];
  for (const f of foreign) {
    const { kind, id } = parseArtefactKey(f.key);
    if (kind === 'slo') {
      const burnKey = `burn_rate:${id}`;
      const burn = byKey.get(burnKey);
      if (!burn) { leftover.push({ ...f, reason: 'an SLO without its burn-rate alert — Build writes one per SLO' }); continue; }
      used.add(f.key); used.add(burnKey);
      additions.push({ kind: 'slo', slo: clone(f.value), burn_rate: clone(burn) });
    } else if (kind === 'route') {
      used.add(f.key);
      additions.push({ kind: 'route', route: clone(f.value) });
    } else if (kind === 'alert_rule') {
      used.add(f.key);
      additions.push({ kind: 'alert_rule', rule: clone(f.value) });
    }
  }
  for (const f of foreign) {
    if (used.has(f.key)) continue;
    if (parseArtefactKey(f.key).kind === 'slo') continue;   // already under leftover with its reason
    leftover.push({ ...f, reason: `a ${KIND_WORDS[parseArtefactKey(f.key).kind] || 'thing'} Build did not write cannot be opened here yet (by file until slice 3)` });
  }
  return { additions, leftover };
}

// ---------------------------------------------------------------------------
// 6. Versions
// ---------------------------------------------------------------------------

/** `0.1.0` → `0.2.0` (the minor, as the journey reads it); a version that is not a SemVer starts again at 0.2.0. */
export function nextVersion(version) {
  const m = SEMVER_RE.exec(String(version || '').trim());
  if (!m) return '0.2.0';
  return `${m[1]}.${Number(m[2]) + 1}.0`;
}

/** The id of the version a pack replaced (its lineage), or null. */
export function previousOf(canonical) {
  return text(ann(canonical)[UPDATE_PREVIOUS_KEY]) || null;
}

/**
 * The pack as the next version of `previous`: its version bumped (or set to `version`) and the
 * lineage recorded (`library.update.previous` = the id it replaces, `…previousVersion` = that
 * version). The content hash the registry derives changes with the version, so the two versions
 * get distinct ids. Pure.
 */
export function stampUpdate(canonical, { previousId, previousVersion = null, version = null } = {}) {
  const out = clone(canonical) || {};
  if (!isObj(out.metadata)) out.metadata = {};
  if (!isObj(out.metadata.annotations)) out.metadata.annotations = {};
  const from = previousVersion ?? out.metadata.version ?? '0.1.0';
  out.metadata.version = version || nextVersion(from);
  if (previousId) out.metadata.annotations[UPDATE_PREVIOUS_KEY] = String(previousId);
  else delete out.metadata.annotations[UPDATE_PREVIOUS_KEY];
  if (previousVersion) out.metadata.annotations[UPDATE_PREVIOUS_VERSION_KEY] = String(previousVersion);
  else delete out.metadata.annotations[UPDATE_PREVIOUS_VERSION_KEY];
  return out;
}

/**
 * The version chains of a catalogue: `heads` (packs no other pack replaces) with their `earlier`
 * versions newest first, and `superseded` (every id some other pack replaces). `packs` is
 * `[{ id, canonical }]`. Pure; a pack whose previous is not in the list is a head of its own.
 */
export function versionChains(packs = []) {
  const byId = new Map(packs.map(p => [p.id, p]));
  const replacedBy = new Map();
  for (const p of packs) { const prev = previousOf(p.canonical); if (prev && byId.has(prev) && !replacedBy.has(prev)) replacedBy.set(prev, p.id); }
  const heads = [];
  for (const p of packs) {
    if (replacedBy.has(p.id)) continue;
    const earlier = [];
    const seen = new Set([p.id]);
    let cur = previousOf(p.canonical);
    while (cur && byId.has(cur) && !seen.has(cur)) { seen.add(cur); earlier.push(cur); cur = previousOf(byId.get(cur).canonical); }
    heads.push({ id: p.id, earlier });
  }
  return { heads, superseded: new Set(replacedBy.keys()), replacedBy };
}

export { FAMILY_KINDS };
