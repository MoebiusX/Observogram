// tools/lib/pack-conformance.mjs
//
// The placeholders a canonical pack still carries, as rows an operator can
// act on: { path, symbol, field, needs, source, hint, state, marker, writer,
// rule }. "Conformance" here is the second half of the word the maturity
// rubric (tools/lib/conformance.mjs) owns: the rubric grades what is DECLARED,
// placeholders included; this module lists what still has to become REAL.
// Zero-import, no Node APIs, browser-safe, vendorable (a listed module).
//
// THE DETECTION RULE (no new marker). A placeholder is an artefact whose
// adapter symbol carries a scaffold marker — an annotation key
// `crawler.scaffold.<symbol>`, `mcp.scaffold.<symbol>` or `library.todo.<symbol>`
// with a non-empty string value — exactly the prefixes and the truthiness test
// tools/lib/adapter.mjs `sourceOf` applies, so "what this module reports" is
// "what the studio parks as Scaffold". SCAFFOLD_PREFIXES is a text-pinned copy
// of adapter.mjs's `scaffoldPrefixes` (tools/test-pack-conformance.mjs reads
// the adapter's source and asserts equality), NOT an import: adapter.mjs is in
// the static studio bundle's module graph (tools/build-studio-bundle.mjs
// ENTRIES → studio/static-backend.mjs → adapter), so an import there would add
// a data: module to the bundle's import map and change its bytes.
//
// The KEY is the contract; the VALUE is advisory. A library-style value
// (`<field>: <what> · <field>: <what>`, tools/lib/library.mjs) names the fields
// and the placeholder literal; any other value (the crawler's, the fetcher's,
// the upconverter's free text) falls back to the per-family field table below.
//
// SYMBOLS. An ARTEFACT symbol is exactly an id adapter.mjs passes to sourceOf
// (`slis.<id>`, `slos.<id>`, `otel`, `telemetry.backends.<id>`, `pipelines.*`,
// `queries.recording_rules[i]`, `dashboards.<id>`, `dashboards.<id>.panels.<panel>`,
// `policy.burn_rate_alerts[i]`, `alerting.routes[i]`, `alerting.rules[i]`,
// `remediation[i]`, `baselines`, `validation.synthetic_checks.<id>`, …) and
// parks that artefact. A FIELD symbol is an artefact symbol plus `.<field>` or
// an index path (`otel.semconv`, `telemetry.backends.<id>.endpoints`,
// `alerting.routes[0].channels[1]`, `metadata.owners`): it parks nothing in
// the studio or in Compare and exists for this report. parseSymbol returns
// the field path as `rest`.
//
// STATES. `placeholder`: marker present and the value still matches an
// upstream stub literal (or the field has no stub test — the marker decides).
// `marker-only`: marker present, the value no longer matches a stub — if it
// is real, delete the marker. `unmarked`: no marker, but the value IS an
// upstream stub literal (an importer's fingerprint). `dangling`: a marker
// whose symbol names nothing in the pack. --strict in the CLI fails on ANY
// row: a marker-only artefact is still parked Scaffold by the adapter, and a
// dangling marker is a broken contract.
//
// SOURCES (where the real value normally comes from):
//   crawl     — the value exists in the service repository (rule files,
//               dashboards, collector and Alertmanager config, runbooks):
//               `npm run crawl` reads it, or copy it from the file.
//   telemetry — a fact of the running backends (products, versions, semconv,
//               endpoints, incident history): the live fetcher
//               (`npm run fetch-live`) or the backend's own API.
//   operator  — a decision only the owning team can make (objectives,
//               windows, severities, guardrails, cadence, owners, criticality).
//
// Every family, field and stub literal below is upstream's own (legacy.mjs,
// crawler.mjs, fetch-live-pack.mjs, library.mjs). `opts` is reserved (waivers
// land there, not in the CLI); unknown keys are ignored.

export const SCAFFOLD_PREFIXES = Object.freeze(['crawler.scaffold.', 'mcp.scaffold.', 'library.todo.']);
export const SOURCES = Object.freeze(['crawl', 'operator', 'telemetry']);
export const STATES = Object.freeze(['placeholder', 'marker-only', 'unmarked', 'dangling']);

const WRITER_BY_PREFIX = { 'crawler.scaffold.': 'crawler', 'mcp.scaffold.': 'fetcher', 'library.todo.': 'library' };

// ---------- helpers ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const asList = (v) => (Array.isArray(v) ? v : []);
const pathSegs = (rest) => String(rest || '').replace(/\[(\d+)\]/g, '.$1').split('.').filter(Boolean);
const normField = (rest) => pathSegs(rest).join('.');
const walk = (node, segs) => { let cur = node; for (const s of segs) { if (cur === null || cur === undefined) return undefined; cur = cur[s]; } return cur; };
const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const keyPos = (obj, key) => Math.max(0, Object.keys(obj || {}).indexOf(key));
const ID = '([a-z0-9_-]+)';
const REST = '(?:\\.(.+))?';

// ---------- 1.1 the symbol grammar ----------

const listFamily = (family, re, section, identity) => ({
  family, kind: 'list', re, section,
  resolve(canonical, m) {
    const list = asList(walk(canonical, section));
    const index = Number(m[1]);
    return { index, item: list[index], exists: index < list.length, position: index, path: `$.${section.join('.')}[${index}]`, rest: m[2] };
  },
  identity,
});
const idFamily = (family, re, section, groups = { id: 1, rest: 2 }) => ({
  family, kind: 'id', re, section,
  resolve(canonical, m) {
    const list = asList(walk(canonical, section));
    const id = m[groups.id];
    const index = list.findIndex(x => x && x.id === id);
    return { id, index: index >= 0 ? index : undefined, item: index >= 0 ? list[index] : undefined, exists: index >= 0, position: index >= 0 ? index : 1e9, path: `$.${section.join('.')}[${index >= 0 ? index : '?'}]`, rest: m[groups.rest] };
  },
  identity: (item) => (item && item.id != null ? String(item.id) : null),
});
const keyFamily = (family, re, section) => ({
  family, kind: 'key', re, section,
  resolve(canonical, m) {
    const obj = walk(canonical, section);
    const key = m[1];
    const exists = isObj(obj) && Object.prototype.hasOwnProperty.call(obj, key);
    return { key, item: exists ? obj[key] : undefined, exists, position: keyPos(obj, key), path: `$.${section.join('.')}.${key}`, rest: m[2] };
  },
  identity: (_item, _i, _list, key) => key,
});
const bareFamily = (family, re, section) => ({
  family, kind: 'bare', re, section,
  resolve(canonical, m) {
    const item = walk(canonical, section);
    return { item, exists: item !== undefined, position: 0, path: `$.${section.join('.')}`, rest: m[1] };
  },
  identity: () => null,
});

/** The adapter's artefact families, in report order. `section` is the pack path of the family's container; `identity(item, i, list, key)` is what mergeUpconvert pairs items by. */
export const SYMBOL_FAMILIES = Object.freeze([
  {
    family: 'metadata', kind: 'metadata', re: /^metadata\.([A-Za-z0-9_-]+)$/,
    resolve(canonical, m) {
      const md = canonical?.metadata;
      const key = m[1];
      const exists = isObj(md) && Object.prototype.hasOwnProperty.call(md, key);
      return { key, item: exists ? md[key] : undefined, exists, position: ['name', 'version', 'binding', 'owners'].indexOf(key) + 1 || 99, path: `$.metadata.${key}`, rest: undefined, metadataField: key };
    },
    identity: (_item, _i, _list, key) => key,
  },
  listFamily('imports', new RegExp(`^imports\\[(\\d+)\\]${REST}$`), ['metadata', 'imports'], (item) => item?.ref ?? null),
  bareFamily('otel', new RegExp(`^otel${REST}$`), ['spec', 'otel']),
  idFamily('slis', new RegExp(`^slis\\.${ID}${REST}$`), ['spec', 'slis']),
  idFamily('slos', new RegExp(`^slos\\.${ID}${REST}$`), ['spec', 'slos']),
  idFamily('telemetry.backends', new RegExp(`^telemetry\\.backends\\.${ID}${REST}$`), ['spec', 'telemetry', 'backends']),
  keyFamily('storage', new RegExp(`^storage\\.([a-z_]+)${REST}$`), ['spec', 'storage']),
  listFamily('pipelines.receivers', new RegExp(`^pipelines\\.receivers\\[(\\d+)\\]${REST}$`), ['spec', 'pipelines', 'receivers'], (item) => item?.name ?? null),
  listFamily('pipelines.processors', new RegExp(`^pipelines\\.processors\\[(\\d+)\\]${REST}$`), ['spec', 'pipelines', 'processors'], (item) => item?.name ?? null),
  keyFamily('pipelines.exporters', new RegExp(`^pipelines\\.exporters\\.(metrics|logs|traces)${REST}$`), ['spec', 'pipelines', 'exporters']),
  bareFamily('profiling', new RegExp(`^profiling${REST}$`), ['spec', 'profiling']),
  bareFamily('network', new RegExp(`^network${REST}$`), ['spec', 'network']),
  bareFamily('policy_engine', new RegExp(`^policy_engine${REST}$`), ['spec', 'policy_engine']),
  listFamily('mesh', new RegExp(`^mesh\\[(\\d+)\\]${REST}$`), ['spec', 'mesh'], (item, i, list) => `${item?.product ?? ''}#${asList(list).slice(0, i).filter(x => x?.product === item?.product).length}`),
  listFamily('collection', new RegExp(`^collection\\[(\\d+)\\]${REST}$`), ['spec', 'collection'], (item, i, list) => `${item?.product ?? ''}#${asList(list).slice(0, i).filter(x => x?.product === item?.product).length}`),
  listFamily('queries.recording_rules', new RegExp(`^queries\\.recording_rules\\[(\\d+)\\]${REST}$`), ['spec', 'queries', 'recording_rules'], (item) => item?.name ?? null),
  idFamily('queries.derived_views', new RegExp(`^queries\\.derived_views\\.${ID}${REST}$`), ['spec', 'queries', 'derived_views']),
  {
    family: 'dashboards.panels', kind: 'panels', re: new RegExp(`^dashboards\\.${ID}\\.panels\\.(.+)$`),
    resolve(canonical, m) {
      const dashboards = asList(canonical?.spec?.dashboards);
      const di = dashboards.findIndex(d => d && d.id === m[1]);
      const bindings = di >= 0 ? asList(dashboards[di].panel_bindings) : [];
      const bi = bindings.findIndex(b => b && String(b.panel) === m[2]);
      return { id: m[1], panel: m[2], index: bi >= 0 ? bi : undefined, item: bi >= 0 ? bindings[bi] : undefined, exists: bi >= 0, position: (di >= 0 ? di : 1e6) * 1000 + (bi >= 0 ? bi : 999), path: `$.spec.dashboards[${di >= 0 ? di : '?'}].panel_bindings[${bi >= 0 ? bi : '?'}]`, rest: undefined };
    },
    identity: () => null,
  },
  idFamily('dashboards', new RegExp(`^dashboards\\.${ID}${REST}$`), ['spec', 'dashboards']),
  listFamily('policy.burn_rate_alerts', new RegExp(`^policy\\.burn_rate_alerts\\[(\\d+)\\]${REST}$`), ['spec', 'policy', 'burn_rate_alerts'], (item) => item?.slo ?? null),
  listFamily('policy.forecasts', new RegExp(`^policy\\.forecasts\\[(\\d+)\\]${REST}$`), ['spec', 'policy', 'forecasts'], (item, i, list) => `${item?.slo ?? ''}#${asList(list).slice(0, i).filter(x => x?.slo === item?.slo).length}`),
  listFamily('alerting.routes', new RegExp(`^alerting\\.routes\\[(\\d+)\\]${REST}$`), ['spec', 'alerting', 'routes'], (item, i, list) => `${item?.severity ?? ''}#${asList(list).slice(0, i).filter(x => x?.severity === item?.severity).length}`),
  listFamily('alerting.rules', new RegExp(`^alerting\\.rules\\[(\\d+)\\]${REST}$`), ['spec', 'alerting', 'rules'], (item) => item?.name ?? null),
  listFamily('remediation', new RegExp(`^remediation\\[(\\d+)\\]${REST}$`), ['spec', 'remediation'], (item) => item?.trigger ?? null),
  bareFamily('baselines', new RegExp(`^baselines${REST}$`), ['spec', 'baselines']),
  idFamily('validation.chaos_experiments', new RegExp(`^validation\\.chaos_experiments\\.${ID}${REST}$`), ['spec', 'validation', 'chaos_experiments']),
  idFamily('validation.synthetic_checks', new RegExp(`^validation\\.synthetic_checks\\.${ID}${REST}$`), ['spec', 'validation', 'synthetic_checks']),
]);

const familyIndex = (family) => SYMBOL_FAMILIES.findIndex(f => f.family === family);

/** { family, id?, index?, key?, panel?, rest? } for an adapter symbol, or null when no family matches. */
export function parseSymbol(symbol) {
  const s = String(symbol ?? '');
  for (const fam of SYMBOL_FAMILIES) {
    const m = fam.re.exec(s);
    if (!m) continue;
    const out = { family: fam.family };
    switch (fam.kind) {
      case 'metadata': out.key = m[1]; break;
      case 'panels': out.id = m[1]; out.panel = m[2]; break;
      case 'list': out.index = Number(m[1]); if (m[2]) out.rest = normField(m[2]); break;
      case 'id': out.id = m[1]; if (m[2]) out.rest = normField(m[2]); break;
      case 'key': out.key = m[1]; if (m[2]) out.rest = normField(m[2]); break;
      default: if (m[1]) out.rest = normField(m[1]);
    }
    return out;
  }
  return null;
}

/** Where a symbol points in the pack: { symbol, family, path, item, exists, index?, id?, key?, rest?, position }. `exists: false` when the section, index or id is absent. */
export function resolveSymbol(canonical, symbol) {
  const s = String(symbol ?? '');
  for (const fam of SYMBOL_FAMILIES) {
    const m = fam.re.exec(s);
    if (!m) continue;
    const r = fam.resolve(canonical, m);
    const rest = r.rest ? normField(r.rest) : undefined;
    const out = { symbol: s, family: fam.family, path: r.path, item: r.item, exists: !!r.exists, position: r.position };
    if (r.index !== undefined) out.index = r.index;
    if (r.id !== undefined) out.id = r.id;
    if (r.key !== undefined) out.key = r.key;
    if (r.panel !== undefined) out.panel = r.panel;
    if (rest) {
      out.rest = rest;
      out.fieldValue = r.exists ? walk(r.item, pathSegs(rest)) : undefined;
      out.fieldExists = r.exists && out.fieldValue !== undefined;
    }
    return out;
  }
  return { symbol: s, family: null, path: null, item: undefined, exists: false, position: 1e9 };
}

/** Every scaffold marker of a pack: [{ key, prefix, writer, symbol, note, fields }] — fields parsed from a library-style note (`<field>: <what> · …`), else null. Only a non-empty string value counts (the adapter's truthiness test). */
export function scaffoldMarkers(canonical) {
  const annotations = canonical?.metadata?.annotations;
  const out = [];
  if (!isObj(annotations)) return out;
  for (const [key, value] of Object.entries(annotations)) {
    if (typeof value !== 'string' || value === '') continue;
    const prefix = SCAFFOLD_PREFIXES.find(p => key.startsWith(p));
    if (!prefix) continue;
    out.push({ key, prefix, writer: WRITER_BY_PREFIX[prefix], symbol: key.slice(prefix.length), note: value, fields: parseLibraryNote(value) });
  }
  return out;
}

// library.mjs todosFromAnnotations: one segment per ' · ', `^([a-zA-Z0-9_.[\]-]+): ` names the field.
function parseLibraryNote(note) {
  const fields = [];
  for (const part of String(note).split(' · ')) {
    const m = /^([a-zA-Z0-9_.[\]-]+): (.*)$/s.exec(part);
    if (!m) continue;
    const lit = /placeholder '([^']*)'/.exec(m[2]);
    fields.push({ field: normField(m[1]), needs: m[2].trim(), literal: lit ? lit[1] : null });
  }
  return fields.length ? fields : null;
}

// ---------- 1.2 the field table ----------

const PROMQL_HINT = 'the service\'s recording rules or dashboard queries (npm run crawl reads them), or the backend\'s rule listing';
// The upconvert's `http_requests_total{…service="<svc>"}` pair, the fetcher's platform stub
// `http_requests_total{status_code!~"5.."}` / `http_requests_total` and its per-service
// `http_server_request_duration_seconds_count{service_name="<svc>"…}` pair.
const STUB_PROMQL_RE = /^sum\(rate\((http_requests_total(\{(status_code!~"5\.\.",)?service="[^"]*"\}|\{status_code!~"5\.\."\})?|http_server_request_duration_seconds_count\{service_name="[^"]*"(,http_response_status_code!~"5\.\.")?\})\[5m\]\)\)$/;
// Every importer's baseline defaults: the upconvert's tier-3 trio and the fetcher's per-tier pairs.
const STUB_MTTD = ['15m', '5m', '2m'];
const STUB_MTTR = ['1d', '2h', '30m'];
// The upconvert's channel stubs (`oncall@<svc>.example.com`, `https://hooks.example.com/<slug>`, `+0-000-…`,
// `#<svc>-oncall`), the library's (`#<svc>-oncall`, `pagerduty://<svc>`) and the crawler's invented addresses
// (`#<receiver>`, `oncall@<receiver>.com`, `pagerduty:<receiver>`, `https://hooks.slack.example.com/<channel>`).
const STUB_CHANNEL_RE = /^oncall@[a-z0-9-]+\.com$|@[a-z0-9-]+\.example\.com$|^https:\/\/hooks\.example\.com\/|^https:\/\/hooks\.slack\.example\.com\/|^\+0-000-|^#[a-z0-9_-]+$|^pagerduty:\/\/|^pagerduty:/;
const STUB_BURN_WINDOWS = [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }];
const STUB_GUARDRAILS = { max_invocations_per_hour: 1, requires_human_above: 'SEV2', rollback_on_failure: true };
const channelValues = (v) => (Array.isArray(v) ? v.flatMap(c => (isObj(c) ? Object.values(c) : [c])) : isObj(v) ? Object.values(v) : [v]);
const F = (field, needs, source, hint, stub = null, when = null) => ({ field, needs, source, hint, stub, when });

/**
 * family → [{ field, needs, source, hint, stub(value, item, ctx) → boolean | null, when(item) → boolean | null }].
 * `stub` is the upstream literal test that splits `placeholder` from `marker-only`; null means "no test" (the marker decides).
 * `when` narrows a field to an item shape (an SLI's type). ctx = { writers, id, key, canonical }.
 */
export const PLACEHOLDER_FIELDS = Object.freeze({
  metadata: [
    F('owners', 'the owning team(s)', 'operator', 'name the team that answers for the service', (v, _i, ctx) => Array.isArray(v) && (v.includes('legacy-import') || (ctx.writers.crawler && v.length === 1 && v[0] === 'team-platform') || (v.length > 0 && v.every(o => /-owners$/.test(String(o)))))),
    F('version', 'the pack\'s own semver', 'operator', '0.1.0-legacy and 0.1.0-crawled are the importers\' stubs', (v, _i, ctx) => v === '0.1.0-legacy' || (ctx.writers.crawler && v === '0.1.0-crawled')),
    F('binding', 'the binding profile name (e.g. otel-elastic-prometheus-grafana)', 'operator', 'the profile the pack is bound to; `legacy` is the upconvert\'s stub', (v) => v === 'legacy'),
  ],
  imports: [
    F('ref', 'a real pack reference to import', 'operator', 'the upconvert kept the governance item as legacy/<slug> — point it at the pack it stands for, or drop it', (v) => /^legacy\//.test(String(v ?? ''))),
  ],
  otel: [
    F('semconv', 'the semconv version the SDKs actually emit', 'telemetry', 'the resource attributes of the service\'s spans and metrics name it', (v) => v === '1.26.0' || v === '1.27.0'),
    F('resource_attributes', 'the resource attributes the SDK or the collector\'s resource processor sets', 'crawl', 'OTEL_RESOURCE_ATTRIBUTES in the deployment, or the collector\'s resource processor', (v) => deepEqual(v, { required: ['service.name'] })),
    F('sdk.languages', 'the service\'s implementation languages', 'crawl', 'the repository\'s source files', (v) => deepEqual(v, ['go'])),
    F('sdk.sampling', 'the SDK/collector sampling policy and ratio', 'crawl', 'OTEL_TRACES_SAMPLER in the deployment, or the collector\'s sampling processor', (v) => deepEqual(v, { policy: 'parentbased_traceidratio', ratio: 0.1 })),
    F('sdk.propagators', 'the context propagators configured', 'crawl', 'OTEL_PROPAGATORS in the deployment', (v) => deepEqual(v, ['tracecontext'])),
  ],
  slis: [
    F('good', 'PromQL: the rate of good events — the ratio numerator', 'crawl', PROMQL_HINT, (v) => STUB_PROMQL_RE.test(String(v ?? '')), (it) => it?.type === 'ratio'),
    F('total', 'PromQL: the rate of all events — the denominator', 'crawl', PROMQL_HINT, (v) => STUB_PROMQL_RE.test(String(v ?? '')) || v === '1', (it) => it?.type === 'ratio'),
    F('query', 'PromQL: the measured value', 'crawl', PROMQL_HINT, null, (it) => it?.type === 'threshold' || it?.type === 'distribution'),
    F('threshold', 'the bound the team commits to', 'operator', 'the SLO objective\'s unit (ms, ratio, count)', (v, it) => v === 1 && it?.unit === 'ratio', (it) => it?.type === 'threshold' || it?.type === 'distribution'),
    F('percentile', 'the percentile the bound applies to', 'operator', 'p95 / p99 as the SLO states it', null, (it) => it?.type === 'distribution'),
    F('expression', 'PromQL: the custom SLI expression', 'crawl', PROMQL_HINT, null, (it) => it?.type === 'custom'),
  ],
  slos: [
    F('objective', 'the target ratio the team commits to', 'operator', '0.99 is every importer\'s default', (v) => v === 0.99),
    F('window', 'the compliance window', 'operator', '30d is every importer\'s default', (v) => v === '30d'),
    F('error_budget_policy', 'a ref to the error-budget policy document', 'operator', 'ref:platform/default-budget and ref:legacy/… are the importers\' stubs', (v) => /^ref:(platform\/default-budget|legacy\/)/.test(String(v ?? ''))),
  ],
  'telemetry.backends': [
    F('product', 'the backend product actually deployed', 'telemetry', 'the live fetcher attests it; or the image in the deployment', null),
    F('version', 'the version it runs', 'telemetry', 'the backend\'s build-info endpoint, or the image tag', null),
    F('endpoints', 'where the backend answers', 'telemetry', 'the port the deployment publishes; http://<product>:80 is the crawler\'s assumption', (v) => channelValues(v).some(e => /^http:\/\/[a-z0-9._-]+:80$/.test(String(e))), (it) => it?.endpoints !== undefined),
  ],
  storage: [
    F('backend', 'the storage backend product', 'telemetry', 'the live fetcher attests it; or the image in the deployment', null),
    F('version', 'the version it runs', 'telemetry', 'the backend\'s build-info endpoint, or the image tag', null),
  ],
  'pipelines.receivers': [F('name', 'confirmation from the collector config that this receiver exists (the stub assumes otlp)', 'crawl', 'the collector config\'s receivers: block', (v) => v === 'otlp')],
  'pipelines.processors': [F('name', 'confirmation from the collector config that this processor exists (the stub assumes batch / memory_limiter)', 'crawl', 'the collector config\'s processors: block', (v) => v === 'batch' || v === 'memory_limiter')],
  'pipelines.exporters': [
    F('kind', 'the exporter the collector config declares for this signal', 'crawl', 'the collector config\'s exporters: block and the pipeline that uses it', (v, _it, ctx) => (ctx.key === 'metrics' && v === 'prometheusremotewrite') || (ctx.key === 'logs' && v === 'elasticsearch') || (ctx.key === 'traces' && (v === 'otlp' || v === 'jaeger'))),
  ],
  'queries.recording_rules': [
    F('expr', 'the PromQL the rule records', 'crawl', 'the rule file; vector(1) is the upconvert\'s stub', (v) => v === 'vector(1)'),
    F('name', 'the rule\'s recorded metric name', 'crawl', '<service>:<metric>:<op>; a name ending in :legacy is the upconvert\'s stub', (v) => /:legacy$/.test(String(v ?? ''))),
  ],
  'queries.derived_views': [F('bind', 'the query the view derives from', 'crawl', 'the dashboard or rule it reads', null)],
  dashboards: [
    F('source', 'the dashboard JSON in the repository (file://…) or the provider URL — or a `template` instead', 'crawl', 'the dashboards/ folder of the repository (npm run crawl reads it)', (v, _it, ctx) => v === `file://dashboards/${ctx.id}.json`),
  ],
  'dashboards.panels': [F('binds_to', 'the SLI or SLO the panel shows', 'crawl', 'the panel\'s query', null)],
  'policy.burn_rate_alerts': [
    F('windows', 'the multi-window burn-rate policy (short/long/factor/severity) the team runs', 'operator', 'the two-window 5m/1h×14 SEV1 + 30m/6h×6 SEV2 default is every importer\'s stub', (v) => deepEqual(v, STUB_BURN_WINDOWS)),
  ],
  'policy.forecasts': [F('method', 'the forecasting method', 'operator', null), F('horizon', 'the forecast horizon', 'operator', null)],
  'alerting.routes': [
    F('channels', 'the real receivers (chat channel, pager, webhook, email)', 'crawl', 'alertmanager.yml receivers', (v) => channelValues(v).some(x => STUB_CHANNEL_RE.test(String(x)))),
    F('severity', 'the severity this route serves', 'operator', 'SEV1..SEV4 as the team pages', null),
  ],
  'alerting.rules': [F('expr', 'the PromQL the rule evaluates', 'crawl', 'the rule file', null), F('name', 'the rule\'s exact name', 'crawl', 'the rule file', null)],
  remediation: [
    F('runbook', 'the runbook\'s path or URL', 'crawl', 'the runbooks/ folder of the repository', (v) => /^runbooks\/.*\.md$/.test(String(v ?? ''))),
    F('automation', 'what the automation does, as it is wired', 'operator', 'manual-only, or the job it triggers', null),
    F('guardrails', 'rate limit, human threshold and rollback policy the team accepts', 'operator', '{1, SEV2, true} is the upconvert\'s stub', (v) => deepEqual(v, STUB_GUARDRAILS)),
    F('trigger', 'the alert that triggers it', 'crawl', 'alert:<rule name>', null),
  ],
  baselines: [
    F('mttd_target_p50', 'measured from the service\'s incident history', 'telemetry', '15m / 5m / 2m are the importers\' per-tier stubs', (v) => STUB_MTTD.includes(v)),
    F('mttr_target_p50', 'measured from the service\'s incident history', 'telemetry', '1d / 2h / 30m are the importers\' per-tier stubs', (v) => STUB_MTTR.includes(v)),
    F('review_cadence', 'how often the team reviews the baselines', 'operator', 'monthly and weekly are the importers\' stubs', (v) => v === 'monthly' || v === 'weekly'),
  ],
  'validation.synthetic_checks': [
    F('target', 'the URL the probe calls', 'crawl', 'the service\'s health endpoint; https://<svc>.example.com/health is the importers\' stub', (v) => /^https:\/\/[a-z0-9_-]+\.example\.com\/health$/.test(String(v ?? ''))),
    F('interval', 'how often the probe runs', 'operator', '1m is the importers\' stub', (v) => v === '1m'),
    F('on_fail_severity', 'the severity a failed probe pages at', 'operator', 'SEV3 is the importers\' stub', (v) => v === 'SEV3'),
  ],
  'validation.chaos_experiments': [
    F('target', 'the workload the experiment injects faults into', 'operator', null), F('fault', 'the fault that degrades the SLI', 'operator', null),
    F('schedule', 'when the experiment runs', 'operator', null), F('environment', 'where the experiment runs', 'operator', null),
  ],
  profiling: [F('backend', 'the profiling backend deployed', 'telemetry', null)],
  network: [F('backend', 'the network observability backend deployed', 'telemetry', null)],
  policy_engine: [F('backend', 'the policy engine deployed', 'telemetry', null)],
  mesh: [F('product', 'the mesh product deployed', 'telemetry', null)],
  collection: [F('product', 'the collection product deployed', 'telemetry', null)],
});

const UNKNOWN_ROW = { field: '*', needs: 'a real value (unknown artefact family — extend PLACEHOLDER_FIELDS)', source: 'operator', hint: null, stub: null, when: null };
const DANGLING = { needs: 'a marker that names an artefact of this pack — delete it, or fix the symbol', hint: 'the artefact was renamed or removed after the marker was written' };

/** The source of a library-noted field the table does not know (library.mjs writes the field, not the source). */
function librarySource(family, field) {
  const spec = (PLACEHOLDER_FIELDS[family] || []).find(f => f.field === field || field.startsWith(`${f.field}.`));
  if (spec) return spec.source;
  if (/version|endpoint|url|targets/.test(field)) return 'telemetry';
  if (/channels/.test(field)) return 'operator';
  if (/runbook/.test(field)) return 'crawl';
  return 'operator';
}

const tableFor = (family) => PLACEHOLDER_FIELDS[family] || null;
const ruleOf = (family, field) => `placeholder.${family || 'unknown'}.${field}`;
const applies = (spec, item) => (spec.when ? !!spec.when(item) : true);

// ---------- 1.3 the report ----------

function detectWriters(canonical, markers) {
  const ann = canonical?.metadata?.annotations || {};
  return {
    legacy: typeof ann['legacy.format'] === 'string' && ann['legacy.format'] !== '',
    crawler: canonical?.metadata?.labels?.source === 'crawler' || typeof ann['crawler.discoveredAt'] === 'string',
    fetcher: markers.some(m => m.prefix === 'mcp.scaffold.') || typeof ann['mcp.refreshedAt'] === 'string',
    library: typeof ann['library.format'] === 'string' || markers.some(m => m.prefix === 'library.todo.'),
  };
}

/**
 * The placeholder report of a canonical pack: { name, writers, markers, rows, counts, conformant }.
 * Pure — never mutates its input. `opts` is reserved (waivers), unknown keys are ignored.
 */
export function packConformance(canonical, _opts = {}) {
  const markers = scaffoldMarkers(canonical);
  const writers = detectWriters(canonical, markers);
  const rows = [];
  const push = (order, row) => { rows.push({ ...row, _order: order }); };

  // (1) marked symbols
  for (const marker of markers) {
    const writer = marker.prefix === 'crawler.scaffold.' && writers.legacy ? 'legacy' : marker.writer;
    const r = resolveSymbol(canonical, marker.symbol);
    const fi = r.family ? familyIndex(r.family) : SYMBOL_FAMILIES.length;
    const base = { symbol: marker.symbol, marker: marker.key, writer };
    const dangling = () => push([SYMBOL_FAMILIES.length + 1, r.position, 0], { ...base, path: `$.metadata.annotations[${JSON.stringify(marker.key)}]`, field: null, needs: DANGLING.needs, source: 'operator', hint: DANGLING.hint, state: 'dangling', rule: 'marker.dangling' });
    if (!r.family) { push([fi, 0, 0], { ...base, path: `$.metadata.annotations[${JSON.stringify(marker.key)}]`, ...UNKNOWN_ROW, state: 'placeholder', rule: ruleOf(null, '*') }); continue; }
    if (!r.exists || (r.rest && !r.fieldExists)) { dangling(); continue; }
    const ctx = { writers, id: r.id, key: r.key, canonical };
    const table = tableFor(r.family);
    const metadataField = r.family === 'metadata' ? r.key : null;
    if (marker.fields) {
      // A library-style note: one row per named field; the literal decides the state.
      marker.fields.forEach((f, k) => {
        const spec = (table || []).find(s => s.field === f.field || f.field.startsWith(`${s.field}.`));
        const value = metadataField ? r.item : walk(r.item, pathSegs(f.field));
        // The literal is the param's value; the field may embed it (`mq(1414)/APP.CANARY`, `http://alertmanager:9093/-/ready`).
        const hit = f.literal === null ? true : String(value).includes(f.literal);
        push([fi, r.position, k], { ...base, path: r.path, field: f.field, needs: f.needs, source: librarySource(r.family, f.field), hint: spec?.hint ?? null, state: hit ? 'placeholder' : 'marker-only', rule: ruleOf(r.family, spec?.field ?? f.field) });
      });
      continue;
    }
    if (metadataField) {
      const spec = (table || []).find(s => s.field === metadataField) || { ...UNKNOWN_ROW, field: metadataField, needs: 'a real value for this field' };
      const hit = spec.stub ? spec.stub(r.item, canonical.metadata, ctx) : null;
      push([fi, r.position, 0], { ...base, path: r.path, field: metadataField, needs: spec.needs, source: spec.source, hint: spec.hint, state: hit === false ? 'marker-only' : 'placeholder', rule: ruleOf(r.family, metadataField) });
      continue;
    }
    if (r.rest) {
      // A FIELD symbol: one row for that field, the table's spec when it has one.
      const spec = (table || []).find(s => s.field === r.rest || r.rest.startsWith(`${s.field}.`));
      const hit = spec?.stub ? spec.stub(r.fieldValue, r.item, ctx) : null;
      push([fi, r.position, spec ? table.indexOf(spec) : 99], { ...base, path: r.path, field: r.rest, needs: spec?.needs ?? 'a real value for this field', source: spec?.source ?? librarySource(r.family, r.rest), hint: spec?.hint ?? marker.note, state: hit === false ? 'marker-only' : 'placeholder', rule: ruleOf(r.family, spec?.field ?? r.rest) });
      continue;
    }
    if (!table) { push([fi, r.position, 0], { ...base, path: r.path, ...UNKNOWN_ROW, state: 'placeholder', rule: ruleOf(r.family, '*') }); continue; }
    const specs = table.filter(s => applies(s, r.item));
    if (!specs.length) { push([fi, r.position, 0], { ...base, path: r.path, ...UNKNOWN_ROW, state: 'placeholder', rule: ruleOf(r.family, '*') }); continue; }
    specs.forEach((spec) => {
      const value = walk(r.item, pathSegs(spec.field));
      const hit = spec.stub ? spec.stub(value, r.item, ctx) : null;
      push([fi, r.position, table.indexOf(spec)], { ...base, path: r.path, field: spec.field, needs: spec.needs, source: spec.source, hint: spec.hint, state: hit === false ? 'marker-only' : 'placeholder', rule: ruleOf(r.family, spec.field) });
    });
  }

  // (2) unmarked fingerprints — an importer's stub literal with no marker on its symbol.
  const marked = new Set(markers.map(m => m.symbol));
  const unmarked = (family, position, symbol, path, spec, writer, k = 0) => {
    if (marked.has(symbol)) return;
    push([familyIndex(family), position, k], { symbol, marker: null, writer, path, field: spec.field, needs: spec.needs, source: spec.source, hint: spec.hint, state: 'unmarked', rule: ruleOf(family, spec.field) });
  };
  const md = canonical?.metadata || {};
  const ctx0 = { writers, canonical };
  for (const spec of PLACEHOLDER_FIELDS.metadata) {
    if (spec.stub && spec.stub(md[spec.field], md, ctx0)) unmarked('metadata', ['name', 'version', 'binding', 'owners'].indexOf(spec.field) + 1, `metadata.${spec.field}`, `$.metadata.${spec.field}`, spec, writers.legacy ? 'legacy' : writers.crawler ? 'crawler' : 'operator');
  }
  asList(md.imports).forEach((imp, i) => {
    const spec = PLACEHOLDER_FIELDS.imports[0];
    if (spec.stub(imp?.ref)) unmarked('imports', i, `imports[${i}]`, `$.metadata.imports[${i}]`, spec, 'legacy');
  });
  const stubWriter = writers.legacy ? 'legacy' : 'crawler';
  asList(canonical?.spec?.slis).forEach((sli, i) => {
    if (!/REPLACE WITH REAL QUERY/.test(String(sli?.description ?? ''))) return;
    PLACEHOLDER_FIELDS.slis.filter(s => applies(s, sli)).forEach((spec, k) => unmarked('slis', i, `slis.${sli.id}`, `$.spec.slis[${i}]`, spec, stubWriter, k));
  });
  asList(canonical?.spec?.queries?.recording_rules).forEach((rule, i) => {
    if (rule?.expr === 'vector(1)') unmarked('queries.recording_rules', i, `queries.recording_rules[${i}]`, `$.spec.queries.recording_rules[${i}]`, PLACEHOLDER_FIELDS['queries.recording_rules'][0], 'legacy');
  });
  asList(canonical?.spec?.alerting?.routes).forEach((route, i) => {
    if (channelValues(route?.channels).some(v => /^\+0-000-/.test(String(v)))) unmarked('alerting.routes', i, `alerting.routes[${i}]`, `$.spec.alerting.routes[${i}]`, PLACEHOLDER_FIELDS['alerting.routes'][0], 'legacy');
  });

  rows.sort((a, b) => a._order[0] - b._order[0] || a._order[1] - b._order[1] || a._order[2] - b._order[2] || a.symbol.localeCompare(b.symbol) || String(a.field).localeCompare(String(b.field)));
  const clean = rows.map(({ _order, ...row }) => row);

  const byState = Object.fromEntries(STATES.map(s => [s, 0]));
  const bySource = Object.fromEntries(SOURCES.map(s => [s, 0]));
  const bySection = {};
  for (const row of clean) {
    byState[row.state]++;
    bySource[row.source]++;
    const fam = resolveSymbol(canonical, row.symbol).family || 'unknown';
    bySection[fam] = (bySection[fam] || 0) + 1;
  }
  return {
    name: typeof md.name === 'string' ? md.name : null,
    writers,
    markers: markers.length,
    rows: clean,
    counts: { rows: clean.length, symbols: new Set(clean.map(r => r.symbol)).size, byState, bySource, bySection },
    conformant: clean.length === 0,
  };
}
