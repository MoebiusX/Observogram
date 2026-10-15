// ============================================================
// exporter-metrics.mjs — what a prebuilt exporter exposes, read three ways.
//
// A service that runs a prebuilt exporter (IBM's mq-metric-samples, a
// node_exporter, a vendor's sidecar) has no client-library call or PromQL
// that names the exporter's metrics: its repository is a Dockerfile and a
// config file. The crawler (tools/lib/crawler.mjs) reads the metric names
// from, strongest first:
//
//   1. a metrics manifest  — `metrics-manifest.json` / `*.metrics-manifest.json`,
//      { exporter, version?, source?, generatedAt?, metrics: [{ name, type,
//      help?, labels? }] }; `packc emit --exporter <url>` writes one from a
//      live /metrics endpoint (originKind 'exporter-manifest', declared);
//   2. an exposition snapshot — a saved /metrics response (`.prom`,
//      `.metrics`), its # HELP / # TYPE lines and the label names of its
//      samples (originKind 'exporter-snapshot', declared);
//   3. the exporter's own config file, matched against a family catalogue
//      (tools/lib/exporter-catalogue.mjs, or a downstream's JSON file of the
//      same shape): the families the config switches on, as candidates
//      (originKind 'exporter-config', confidence 'inferred').
//
// Pure: no fs, no network — the crawler, the CLI (tools/emit-manifest.mjs)
// and the browser share it. Label VALUES are never kept (a channel's
// connname is an address); only label names, types and help text.
// ============================================================

import { EXPORTER_CATALOGUE as BUILTIN_CATALOGUE } from './exporter-catalogue.mjs';

/** The exposition types a manifest entry or a # TYPE line may state (text format 0.0.4 and OpenMetrics). */
export const EXPOSITION_TYPES = Object.freeze(['counter', 'gauge', 'histogram', 'summary', 'untyped', 'unknown', 'gaugehistogram', 'info', 'stateset']);
const TYPE_SET = new Set(EXPOSITION_TYPES);
const NAME_RE = /^[A-Za-z_:][A-Za-z0-9_:]*$/;
const LABEL_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
const LABEL_CAP = 32;

// A sample of a family is named the family plus one of these suffixes.
const FAMILY_SUFFIXES = {
  counter: ['_total', '_created'],
  histogram: ['_bucket', '_sum', '_count', '_created'],
  summary: ['_sum', '_count', '_created'],
  gaugehistogram: ['_bucket', '_gsum', '_gcount'],
  info: ['_info'],
};
// Labels the exposition adds to a family's samples, not the family's own.
const SAMPLE_ONLY_LABELS = { histogram: ['le'], gaugehistogram: ['le'], summary: ['quantile'] };

/** `metrics-manifest.json` or `<anything>.metrics-manifest.json`, any folder. */
export function isMetricsManifestPath(relPath) {
  return /(^|[/\\.])metrics-manifest\.json$/i.test(String(relPath ?? ''));
}

/**
 * A path a saved exposition is never read from: a test, spec, fixture, mock
 * or test-data folder in any of the usual spellings (`test/`, `__tests__/`,
 * `fixtures/`, `__fixtures__/`, `__mocks__/`, `testdata/`, `test-data/`,
 * `test_fixtures/`, …) or a `*.test.*` / `*.spec.*` / `*_test.*` file — there
 * an exposition is sample input, not what a deployed exporter serves.
 */
export function isTestOrFixturePath(relPath) {
  const p = String(relPath ?? '').replace(/\\/g, '/').toLowerCase();
  return /(^|\/)(?:__)?(?:tests?|specs?|fixtures?|mocks?|testdata|test[-_]?(?:data|fixtures?))(?:__)?(\/|$)/.test(p)
    || /\.(?:test|spec)\.[a-z]+$|_test\.[a-z]+$/.test(p);
}

/** A saved exposition: `.prom` or `.metrics`. */
export function isExpositionSnapshotPath(relPath) {
  return /\.(prom|metrics)$/i.test(String(relPath ?? ''));
}

/**
 * A URL as it may be recorded: never the userinfo, query or fragment, where a
 * credential rides. Textual, never a URL parse: a password may hold `/`, `?`
 * or `@`, which end a parsed authority early and leave the rest of the secret
 * in the "host" or "path". So everything before the LAST `@` goes (a value
 * whose path or query holds an `@` keeps only what follows it, which loses
 * the host rather than risk a credential), then everything from the first
 * `?` or `#`. A leading `scheme://` or `//` is kept; a value that is not a
 * URL at all (`prometheus:9090`, `${env:ENDPOINT}`) passes through the same
 * rule.
 */
export function safeSourceUrl(raw) {
  const s = String(raw ?? '').trim();
  if (!s) return '';
  const prefix = /^(?:[A-Za-z][A-Za-z0-9+.-]*:)?\/\//.exec(s)?.[0] ?? '';
  let rest = s.slice(prefix.length);
  const at = rest.lastIndexOf('@');
  if (at >= 0) rest = rest.slice(at + 1);
  return prefix + rest.replace(/[?#].*$/, '');
}

function parseSampleLine(line) {
  const m = /^[A-Za-z_:][A-Za-z0-9_:]*/.exec(line);
  if (!m) return null;
  const name = m[0];
  const labels = [];
  let i = name.length;
  // A sample ends in its value: a number, NaN or ±Inf (then an optional
  // timestamp). A line that does not is not a sample.
  const valued = (at) => (/^[ \t]+[-+]?(?:\d|\.\d|Inf|NaN)/i.test(line.slice(at)) ? { name, labels } : null);
  while (line[i] === ' ' || line[i] === '\t') i++;
  if (line[i] !== '{') return valued(name.length);
  i++;
  for (;;) {
    while (line[i] === ' ' || line[i] === '\t' || line[i] === ',') i++;
    if (i >= line.length) return null;
    if (line[i] === '}') return valued(i + 1);
    const lm = /^[A-Za-z_][A-Za-z0-9_]*/.exec(line.slice(i));
    if (!lm) return null;
    labels.push(lm[0]);
    i += lm[0].length;
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] !== '=') return null;
    i++;
    while (line[i] === ' ' || line[i] === '\t') i++;
    if (line[i] !== '"') return null;
    i++;
    while (i < line.length && line[i] !== '"') i += line[i] === '\\' ? 2 : 1;
    if (i >= line.length) return null;
    i++;
  }
}

function unescapeHelp(s) {
  return s.replace(/\\(\\|n)/g, (_, c) => (c === 'n' ? '\n' : '\\'));
}

/**
 * Parse a Prometheus / OpenMetrics text exposition into its metric families:
 * `{ families: [{ name, type, help, labels }], samples }`, families sorted by
 * name, labels in first-seen order. A family's name is the one Prometheus
 * stores: an OpenMetrics counter `jobs` is `jobs_total`, an info `build` is
 * `build_info`. A sample with no # TYPE for it (or for
 * the family its suffix names) is its own `untyped` family.
 */
export function parseExposition(text) {
  const families = new Map();
  const family = (name) => {
    if (!families.has(name)) families.set(name, { name, type: 'untyped', help: '', labels: [], typed: false, stored: '' });
    return families.get(name);
  };
  let samples = 0;
  for (const raw of String(text ?? '').replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) {
      const meta = /^#\s*(HELP|TYPE)\s+([A-Za-z_:][A-Za-z0-9_:]*)(?:\s+(.*))?$/.exec(line);
      if (!meta) continue;
      const f = family(meta[2]);
      if (meta[1] === 'HELP') f.help = unescapeHelp(meta[3] ?? '');
      else {
        const t = String(meta[3] ?? '').trim().toLowerCase();
        f.type = TYPE_SET.has(t) ? t : 'untyped';
        f.typed = true;
      }
      continue;
    }
    const sample = parseSampleLine(line);
    if (!sample) continue;
    samples++;
    let f = families.get(sample.name);
    if (!f || (!f.typed && !f.help)) {
      for (const [type, suffixes] of Object.entries(FAMILY_SUFFIXES)) {
        const suffix = suffixes.find(s => sample.name.endsWith(s) && sample.name.length > s.length);
        const base = suffix ? families.get(sample.name.slice(0, -suffix.length)) : null;
        if (base && base.type === type) {
          f = base;
          // An OpenMetrics counter or info family is stored (and queried)
          // under its sample's name: `jobs` → jobs_total, `build` → build_info.
          if ((suffix === '_total' || suffix === '_info') && !f.stored) f.stored = sample.name;
          break;
        }
      }
    }
    if (!f) f = family(sample.name);
    const skip = SAMPLE_ONLY_LABELS[f.type] || [];
    for (const l of sample.labels) {
      if (!skip.includes(l) && !f.labels.includes(l) && f.labels.length < LABEL_CAP) f.labels.push(l);
    }
  }
  // OpenMetrics (`# EOF`) names a counter family without `_total` and an
  // info family without `_info`; with no sample to say so, the stored name
  // is the family's plus that suffix.
  const openMetrics = /^#\s*EOF\s*$/m.test(String(text ?? ''));
  const storedName = (f) => f.stored
    || (openMetrics && f.type === 'counter' && !f.name.endsWith('_total') ? `${f.name}_total`
      : openMetrics && f.type === 'info' && !f.name.endsWith('_info') ? `${f.name}_info` : f.name);
  const out = [...families.values()]
    .map((f) => ({ name: storedName(f), type: f.type, help: f.help, labels: f.labels }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return { families: out, samples };
}

/**
 * A metrics manifest built from an exposition (what `packc emit --exporter`
 * writes): `{ exporter, version?, source?, generatedAt?, metrics }`, the
 * metrics sorted by name, `source` reduced by safeSourceUrl.
 */
export function manifestFromExposition(text, { exporter, version, source, generatedAt } = {}) {
  const { families } = parseExposition(text);
  const manifest = { exporter: String(exporter ?? '').trim() };
  if (version) manifest.version = String(version);
  const src = safeSourceUrl(source);
  if (src) manifest.source = src;
  if (generatedAt) manifest.generatedAt = String(generatedAt);
  manifest.metrics = families.map(f => ({
    name: f.name,
    type: f.type,
    ...(f.help ? { help: f.help } : {}),
    ...(f.labels.length ? { labels: f.labels } : {}),
  }));
  return manifest;
}

/**
 * Read a metrics manifest's text. `{ ok: true, manifest, skipped }` with the
 * entries that are not `{ name: <metric name>, type: <exposition type> }`
 * counted in `skipped` (a repeated name keeps its first entry), or
 * `{ ok: false, error }` when the text is not a manifest at all.
 */
export function readMetricsManifest(text) {
  let obj;
  // Never the parser's message: it quotes the start of the text, which in a
  // file that is not a manifest may be a key.
  try { obj = JSON.parse(stripBom(text)); } catch { return { ok: false, error: 'not JSON' }; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false, error: 'not a JSON object' };
  const exporter = typeof obj.exporter === 'string' ? obj.exporter.trim() : '';
  if (!exporter) return { ok: false, error: 'no `exporter` name' };
  if (!Array.isArray(obj.metrics)) return { ok: false, error: 'no `metrics` array' };
  const metrics = [];
  const seen = new Set();
  let skipped = 0;
  for (const m of obj.metrics) {
    const name = typeof m?.name === 'string' ? m.name.trim() : '';
    const type = typeof m?.type === 'string' ? m.type.trim().toLowerCase() : '';
    if (!NAME_RE.test(name) || !TYPE_SET.has(type) || seen.has(name)) { skipped++; continue; }
    seen.add(name);
    metrics.push({
      name,
      type,
      help: typeof m.help === 'string' ? m.help : '',
      labels: Array.isArray(m.labels) ? [...new Set(m.labels.filter(l => typeof l === 'string' && LABEL_RE.test(l)))].slice(0, LABEL_CAP) : [],
    });
  }
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : '');
  return {
    ok: true,
    skipped,
    manifest: {
      exporter,
      version: str(obj.version) || (typeof obj.version === 'number' ? String(obj.version) : ''),
      source: safeSourceUrl(str(obj.source)),
      generatedAt: str(obj.generatedAt),
      metrics,
    },
  };
}

// ---------- the exporter config catalogue ----------

const isMapping = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// One leading U+FEFF, as mini-yaml strips it (Windows editors write one).
const stripBom = (text) => String(text ?? '').replace(/^\uFEFF/, '');

function pathValue(obj, path) {
  let cur = obj;
  for (const key of String(path ?? '').split('.').filter(Boolean)) {
    if (!isMapping(cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

function normalizeEntry(e, i) {
  const where = `exporter catalogue entry ${i + 1}${typeof e?.id === 'string' && e.id ? ` ('${e.id}')` : ''}`;
  if (!isMapping(e)) return { error: `${where} is not an object` };
  if (typeof e.id !== 'string' || !/^[a-z][a-z0-9_.-]{0,62}$/.test(e.id)) return { error: `${where}: \`id\` must be a lowercase name (letters, digits, \`_\`, \`.\`, \`-\`)` };
  const keys = Array.isArray(e.match?.keys) ? e.match.keys.filter(k => typeof k === 'string' && /^[A-Za-z_][A-Za-z0-9_-]*$/.test(k)) : [];
  if (!keys.length || keys.length !== e.match.keys.length) return { error: `${where}: \`match.keys\` must list the top-level keys a config carries` };
  const switches = (o, kind) => {
    if (o === undefined) return {};
    if (!isMapping(o) || Object.values(o).some(v => !isMapping(v) || typeof v.path !== 'string')) throw new Error(`${where}: every ${kind} needs a \`path\``);
    return Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { path: v.path, default: v.default !== false }]));
  };
  let gates, scopes;
  try { gates = switches(e.gates, 'gate'); scopes = switches(e.scopes, 'scope'); }
  catch (err) { return { error: err.message }; }
  const ns = isMapping(e.namespace) ? e.namespace : {};
  if (ns.default !== undefined && ns.default !== '' && !(typeof ns.default === 'string' && NAME_RE.test(ns.default))) {
    return { error: `${where}: \`namespace.default\` must be a metric name prefix` };
  }
  if (!Array.isArray(e.families) || !e.families.length) return { error: `${where}: \`families\` must list at least one family` };
  const families = [];
  for (const f of e.families) {
    const bad = !isMapping(f) || typeof f.name !== 'string' || !/^[A-Za-z0-9_:]+$/.test(f.name)
      || !TYPE_SET.has(String(f.type ?? '').toLowerCase())
      || (f.gate !== undefined && !gates[f.gate]) || (f.scope !== undefined && !scopes[f.scope]);
    if (bad) return { error: `${where}: family ${JSON.stringify(f?.name ?? f)} needs a name, an exposition type, and only the gates and scopes the entry defines` };
    families.push({
      name: f.name,
      type: String(f.type).toLowerCase(),
      help: typeof f.help === 'string' ? f.help : '',
      labels: Array.isArray(f.labels) ? f.labels.filter(l => typeof l === 'string' && LABEL_RE.test(l)).slice(0, LABEL_CAP) : [],
      ...(f.gate !== undefined ? { gate: f.gate } : {}),
      ...(f.scope !== undefined ? { scope: f.scope } : {}),
    });
  }
  return {
    entry: {
      id: e.id,
      title: typeof e.title === 'string' ? e.title : e.id,
      match: { keys },
      namespace: { path: typeof ns.path === 'string' ? ns.path : '', default: typeof ns.default === 'string' ? ns.default : '' },
      gates,
      scopes,
      families,
    },
  };
}

/**
 * The catalogue a crawl reads: the built-in entries, then a caller's (an
 * object `{ exporters: [...] }` or the array itself) — an entry replaces the
 * built-in one with the same id, the rest are added. An entry that is not
 * well-formed is dropped with a warning naming what it lacks; a catalogue
 * that is not an object or array is ignored with a warning.
 * → `{ exporters, warnings }`.
 */
export function resolveExporterCatalogue(custom) {
  const warnings = [];
  const byId = new Map();
  for (const [i, e] of BUILTIN_CATALOGUE.exporters.entries()) {
    const { entry } = normalizeEntry(e, i);
    if (entry) byId.set(entry.id, entry);
  }
  if (custom !== undefined && custom !== null) {
    const list = Array.isArray(custom) ? custom : (isMapping(custom) && Array.isArray(custom.exporters) ? custom.exporters : null);
    if (!list) warnings.push('the exporter catalogue is neither `{ exporters: [...] }` nor an array; the built-in catalogue is used.');
    else {
      list.forEach((e, i) => {
        const { entry, error } = normalizeEntry(e, i);
        if (error) warnings.push(`${error}; dropped.`);
        else byId.set(entry.id, entry);
      });
    }
  }
  return { exporters: [...byId.values()], warnings };
}

/**
 * Whether a YAML text can be an exporter config of the catalogue — every
 * key of some entry's `match.keys` starts a line — before the text is
 * parsed. Cheap; `matchExporterConfig` decides.
 */
export function mayBeExporterConfig(content, catalogue) {
  const text = stripBom(content);
  return catalogue.exporters.some(e => e.match.keys.every(k => new RegExp(`^${k}\\s*:`, 'm').test(text)));
}

/** The first catalogue entry whose `match.keys` the parsed config all carries, or null. */
export function matchExporterConfig(obj, catalogue) {
  if (!isMapping(obj)) return null;
  return catalogue.exporters.find(e => e.match.keys.every(k => Object.prototype.hasOwnProperty.call(obj, k))) || null;
}

function switchOn(value, dflt) {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === 'no' || v === 'off') return false;
  }
  return dflt;
}

function selectionNonEmpty(value) {
  if (Array.isArray(value)) return value.some(v => String(v ?? '').trim() !== '');
  if (typeof value === 'string') return value.trim() !== '';
  if (isMapping(value)) return Object.keys(value).length > 0;
  return false;
}

/**
 * The families an exporter config switches on: `{ namespace, gates, scopes,
 * families: [{ name, type, help, labels }] }` — each family's name joined to
 * the namespace the config sets (else the entry's default), a family kept
 * only when its gate is on and its scope selects something.
 */
export function inferExporterFamilies(obj, entry) {
  const nsRaw = entry.namespace.path ? pathValue(obj, entry.namespace.path) : undefined;
  const namespace = typeof nsRaw === 'string' && NAME_RE.test(nsRaw.trim()) ? nsRaw.trim() : entry.namespace.default;
  const gates = Object.fromEntries(Object.entries(entry.gates).map(([k, g]) => [k, switchOn(pathValue(obj, g.path), g.default)]));
  const scopes = Object.fromEntries(Object.entries(entry.scopes).map(([k, s]) => [k, selectionNonEmpty(pathValue(obj, s.path))]));
  const families = entry.families
    .filter(f => (f.gate === undefined || gates[f.gate]) && (f.scope === undefined || scopes[f.scope]))
    .map(f => ({ name: namespace ? `${namespace}_${f.name}` : f.name, type: f.type, help: f.help, labels: f.labels }))
    .filter(f => NAME_RE.test(f.name));
  return { namespace, gates, scopes, families };
}
