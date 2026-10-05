// tools/lib/legacy.mjs
//
// Upconverts the PREVIOUS Observogram (né Tomograph) pack format — the layered "studio-shape"
// JSON that predates the canonical v1.2 manifest (Phase 5, commit 7c79975) —
// into a valid canonical ObservabilityPack. Browser-friendly pure ESM (no
// Node APIs), same contract as adapter.mjs / crawler.mjs, so the server,
// the CLI and the studio all share this one converter.
//
// LEGACY SHAPE (examples/legacy/*.json):
//   {
//     id, name, badge, description, liveness?,
//     layers: {
//       L1: item[], L2: item[], L3: item[],
//       L4: { policy: item[], alerting: item[], healing: item[] },
//       L5: item[], GOV: item[],
//     },
//   }
//   item: { id, source: 'BAU'|'GAP', title, desc, tool, tags }
//
// PUBLIC API
//   isLegacyLayeredPack(obj)            -> boolean
//   upconvertLegacyPack(obj, opts?)     -> { canonical, report, provenance }
//   mergeUpconvert({ canonical, provenance }, existing, opts?)
//                                       -> { canonical, report }
//
// A CANONICAL PACK IS NEVER CONVERTED: isLegacyLayeredPack() is false on
// anything that carries apiVersion/kind, so the server gate, the CLI and the
// studio pass a canonical upload through untouched (f(f(x)) = f(x)).
//
// MERGE RULE (mergeUpconvert): re-running the upconvert over a legacy source
// whose output file already exists must never regress a real value to a
// scaffold. One rule: the existing pack wins for every artefact it has; the
// upconvert only ADDS artefacts whose legacy source item the existing pack
// has never seen (by the `legacy.artefact.<LAYER>.<ID>` record), and skips
// the schema-required stubs (the existing pack already validates). The whole
// `legacy.*` block (records, format, upconvertedAt) is the designed
// exception: it is refreshed to the current legacy source on every merge.
//
// PRINCIPLES (mirror the crawler, the other partial-knowledge importer):
//   - One pipeline: emit a canonical manifest so validation, conformance,
//     compile, deploy and diff all work on the import — no legacy side path.
//   - Honesty over polish: the legacy format declared WHAT existed, never
//     the machine detail (exprs, windows, channels). Wherever a schema-
//     required machine field has to be filled with a placeholder, the
//     artefact is marked `crawler.scaffold.<symbol>` so it projects as
//     Scaffold, not Declared. Legacy GAP items are always scaffolds.
//   - Losslessness: every legacy item is preserved verbatim in
//     `metadata.annotations['legacy.artefact.<LAYER>.<ID>']`, so nothing
//     the old pack said is thrown away even when the canonical projection
//     is lossy (tags, tool strings, exact titles).

import { SYMBOL_FAMILIES } from './pack-conformance.mjs';

const PLACEHOLDER_NOTE = 'legacy import: schema-required field has no machine detail in the layered format — REPLACE WITH REAL VALUE';

export function isLegacyLayeredPack(obj) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  if (obj.apiVersion || obj.kind) return false;        // canonical (or claims to be)
  const layers = obj.layers;
  if (!layers || typeof layers !== 'object' || Array.isArray(layers)) return false;
  const known = ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV'];
  if (!known.some(k => k in layers)) return false;
  return typeof obj.id === 'string' || typeof obj.name === 'string';
}

// ---------- helpers ----------

// Spec Slug: ^[a-z][a-z0-9_-]*[a-z0-9]$ (2..64)
function slug(s, fallback = 'item') {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z]+/, '')
    .replace(/[^a-z0-9]+$/, '')
    .slice(0, 64);
  return out.length >= 2 ? out : fallback;
}

// Recording-rule metric segment: [a-z][a-z0-9_]*
function metricSeg(s, fallback = 'rule') {
  const out = String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '');
  return out.length >= 1 ? out : fallback;
}

function items(x) { return Array.isArray(x) ? x : []; }

// The lossless record's key — one helper for keep() and the merge provenance.
function recordKey(layer, item) { return `legacy.artefact.${layer}.${item.id || 'item'}`; }

function text(item) {
  return [item.title, item.desc].filter(Boolean).join(' — ') || item.id || '(untitled)';
}

function matches(item, re) {
  return re.test(`${item.id || ''} ${item.title || ''} ${item.desc || ''} ${item.tool || ''} ${(item.tags || []).join(' ')}`);
}

const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];

function severityOf(item, index) {
  const m = `${item.id} ${item.title} ${item.desc}`.match(/SEV[\s-]?([1-4])/i);
  if (m) return `SEV${m[1]}`;
  return SEVERITIES[Math.min(index, 3)];
}

function channelOf(item, service) {
  const hay = `${item.title} ${item.desc} ${item.tool} ${(item.tags || []).join(' ')}`.toLowerCase();
  if (/mail/.test(hay)) return { email: `oncall@${service}.example.com` };
  if (/webhook|pagerduty|opsgenie|http/.test(hay)) return { webhook: `https://hooks.example.com/${slug(item.id, 'alert')}` };
  if (/voice|call|phone/.test(hay)) return { voice: `+0-000-${slug(item.id, 'alert').slice(0, 7)}` };
  if (/whatsapp/.test(hay)) return { whatsapp: `+0-000-${slug(item.id, 'alert').slice(0, 7)}` };
  return { msteams: `#${service}-oncall` };
}

// ---------- the upconverter ----------

export function upconvertLegacyPack(legacy, opts = {}) {
  if (!isLegacyLayeredPack(legacy)) {
    throw new Error('upconvertLegacyPack: input is not a legacy layered pack');
  }
  const L = legacy.layers || {};
  const service = slug(legacy.id || legacy.name, 'legacy-service');
  const scaffoldSymbols = [];
  const notes = [];
  const annotations = {};
  // symbol -> the `legacy.artefact.<LAYER>.<ID>` record key of the legacy item
  // it maps to, or null for a schema-required stub that has no legacy source
  // (mergeUpconvert reads this to tell "seen before" from "new").
  const provenance = {};
  let mapped = 0;

  const scaffold = (symbol) => { scaffoldSymbols.push(symbol); if (!(symbol in provenance)) provenance[symbol] = null; };
  const keep = (layer, item) => {
    annotations[recordKey(layer, item)] = JSON.stringify(item);
    mapped++;
  };
  // A layered item that carries a `type` (a typed pack from another
  // toolchain) keeps it as the declared type of the canonical symbol it maps
  // to — `observogram.artefact.type.<symbol>` — which adapt() carries through
  // as the artefact's top-level `type` for the taxonomy
  // (tools/lib/artefact-classify.mjs). An item without one writes nothing.
  const declareType = (symbol, item) => {
    if (typeof item.type === 'string' && item.type.trim()) annotations[`observogram.artefact.type.${symbol}`] = item.type.trim();
  };
  // Every mapped item places its symbol: the declared type and the provenance record.
  const place = (symbol, layer, item) => { declareType(symbol, item); provenance[symbol] = recordKey(layer, item); };

  // ----- L1: SLIs / SLOs / error-budget policies -----
  const slis = [];
  const slos = [];
  let ebpRef = 'ref:platform/default-budget';
  const l1 = items(L.L1);
  const ebpItems = l1.filter(i => /^EBP/i.test(i.id || '') || matches(i, /error.?budget/i));
  const sloItems = l1.filter(i => !ebpItems.includes(i) && (/^SLO/i.test(i.id || '') || matches(i, /\bSLO\b|objective/i)));
  const sliItems = l1.filter(i => !ebpItems.includes(i) && !sloItems.includes(i));

  if (ebpItems.length) {
    ebpRef = `ref:legacy/${slug(ebpItems[0].id, 'error-budget')}`;
    for (const item of ebpItems) {
      keep('L1', item);
      notes.push(`L1 ${item.id}: error-budget policy folded into slos[].error_budget_policy (${ebpRef}).`);
    }
  }
  for (const item of sliItems) {
    const id = slug(item.title || item.id, 'service-sli');
    if (slis.some(s => s.id === id)) continue;
    slis.push({
      id,
      type: 'ratio',
      description: text(item),
      good: `sum(rate(http_requests_total{status_code!~"5..",service="${service}"}[5m]))`,
      total: `sum(rate(http_requests_total{service="${service}"}[5m]))`,
    });
    scaffold(`slis.${id}`);   // good/total are placeholders — never Declared
    place(`slis.${id}`, 'L1', item);
    keep('L1', item);
  }
  if (!slis.length) {
    slis.push({
      id: 'service_availability',
      type: 'ratio',
      description: 'Stub SLI — the legacy pack declared no L1 SLI. REPLACE WITH REAL QUERY.',
      good: `sum(rate(http_requests_total{status_code!~"5..",service="${service}"}[5m]))`,
      total: `sum(rate(http_requests_total{service="${service}"}[5m]))`,
    });
    scaffold('slis.service_availability');
    notes.push('No L1 SLI declared — emitted schema-required stub.');
  }
  sloItems.forEach((item, i) => {
    const id = slug(item.title || item.id, 'service-slo');
    if (slos.some(s => s.id === id)) return;
    const sli = slis[Math.min(i, slis.length - 1)].id;
    slos.push({ id, sli, objective: 0.99, window: '30d', error_budget_policy: ebpRef });
    scaffold(`slos.${id}`);   // objective/window are placeholders
    place(`slos.${id}`, 'L1', item);
    keep('L1', item);
  });
  if (!slos.length) {
    slos.push({
      id: `${slis[0].id}_99`.slice(0, 64),
      sli: slis[0].id,
      objective: 0.99,
      window: '30d',
      error_budget_policy: ebpRef,
    });
    scaffold(`slos.${slos[0].id}`);
    notes.push('No L1 SLO declared — emitted schema-required stub.');
  }

  // ----- L2: storage families + telemetry backends -----
  const storage = {};
  const backends = [];
  const FAMILY_BY_TOOL = [
    [/prometheus|mimir|thanos|victoria|influx/i, 'metrics'],
    [/loki|elastic|opensearch|graylog|clickhouse/i, 'logs'],
    [/jaeger|tempo|zipkin|skywalking/i, 'traces'],
  ];
  const signalOf = (item) => {
    const hay = `${item.tool} ${item.title} ${(item.tags || []).join(' ')}`;
    if (/trace|jaeger|tempo|zipkin/i.test(hay)) return 'traces';
    if (/log|loki|elastic|promtail|fluent/i.test(hay)) return 'logs';
    if (/profil/i.test(hay)) return 'profiles';
    return 'metrics';
  };
  for (const item of items(L.L2)) {
    keep('L2', item);
    const isStorage = /^STO/i.test(item.id || '') || matches(item, /storage|retention|archive/i);
    if (isStorage) {
      const family = (FAMILY_BY_TOOL.find(([re]) => re.test(item.tool || '')) || [])[1];
      if (family && !storage[family]) {
        storage[family] = { backend: slug(item.tool, 'storage'), backend_ref: undefined };
        delete storage[family].backend_ref;
        if (item.source === 'GAP') scaffold(`storage.${family}`);
        place(`storage.${family}`, 'L2', item);
        continue;
      }
    }
    const id = slug(item.title || item.id, 'backend');
    if (backends.some(b => b.id === id)) continue;
    backends.push({ id, signal: signalOf(item), product: slug(item.tool, 'backend') });
    if (item.source === 'GAP') scaffold(`telemetry.backends.${id}`);
    place(`telemetry.backends.${id}`, 'L2', item);
  }

  // ----- L3: recording rules + dashboards -----
  const recordingRules = [];
  const dashboards = [];
  for (const item of items(L.L3)) {
    keep('L3', item);
    const isDash = /^DASH/i.test(item.id || '') || matches(item, /dashboard|grafana|kibana/i);
    if (isDash) {
      const id = slug(item.title || item.id, 'dashboard');
      if (dashboards.some(d => d.id === id)) continue;
      // The schema demands source XOR template; the legacy format never
      // carried either, so the file:// pointer is invented → Scaffold.
      dashboards.push({
        id,
        provider: { kind: /kibana/i.test(item.tool || '') ? 'kibana' : 'grafana' },
        folder: service,
        source: `file://dashboards/${id}.json`,
      });
      scaffold(`dashboards.${id}`);
      place(`dashboards.${id}`, 'L3', item);
    } else {
      const name = `${metricSeg(service, 'svc')}:${metricSeg(item.title || item.id)}:legacy`;
      if (recordingRules.some(r => r.name === name)) continue;
      recordingRules.push({ name, expr: 'vector(1)' });
      scaffold(`queries.recording_rules[${recordingRules.length - 1}]`);   // expr is a placeholder
      place(`queries.recording_rules[${recordingRules.length - 1}]`, 'L3', item);
    }
  }
  if (!dashboards.length) {
    const id = `${service}-overview`.slice(0, 64);
    dashboards.push({ id, provider: { kind: 'grafana' }, folder: service, source: `file://dashboards/${id}.json` });
    scaffold(`dashboards.${id}`);
    notes.push('No L3 dashboard declared — emitted schema-required stub.');
  }

  // ----- L4: burn-rate policies, alerting routes, remediation -----
  const burnRateAlerts = [];
  items(L.L4?.policy).forEach((item, i) => {
    keep('L4', item);
    const slo = slos[Math.min(i, slos.length - 1)].id;
    if (burnRateAlerts.some(b => b.slo === slo)) return;
    burnRateAlerts.push({
      slo,
      windows: [
        { short: '5m', long: '1h', factor: 14, severity: 'SEV1' },
        { short: '30m', long: '6h', factor: 6, severity: 'SEV2' },
      ],
    });
    scaffold(`policy.burn_rate_alerts[${burnRateAlerts.length - 1}]`);   // windows are placeholders
    place(`policy.burn_rate_alerts[${burnRateAlerts.length - 1}]`, 'L4', item);
  });
  if (!burnRateAlerts.length) {
    burnRateAlerts.push({
      slo: slos[0].id,
      windows: [
        { short: '5m', long: '1h', factor: 14, severity: 'SEV1' },
        { short: '30m', long: '6h', factor: 6, severity: 'SEV2' },
      ],
    });
    scaffold('policy.burn_rate_alerts[0]');
    notes.push('No L4 policy declared — emitted schema-required two-window stub.');
  }

  const routes = [];
  items(L.L4?.alerting).forEach((item, i) => {
    keep('L4', item);
    routes.push({ severity: severityOf(item, i), channels: [channelOf(item, service)] });
    scaffold(`alerting.routes[${routes.length - 1}]`);   // channel values are placeholders
    place(`alerting.routes[${routes.length - 1}]`, 'L4', item);
  });
  if (!routes.length) {
    routes.push({ severity: 'SEV1', channels: [{ msteams: `#${service}-oncall` }] });
    scaffold('alerting.routes[0]');
    notes.push('No L4 alerting declared — emitted schema-required stub route.');
  }

  const remediation = [];
  items(L.L4?.healing).forEach((item) => {
    keep('L4', item);
    remediation.push({
      trigger: `alert:${slug(item.title || item.id, 'legacy-heal').replace(/-+$/, '') || 'legacy-heal'}`,
      runbook: `runbooks/${slug(item.title || item.id, 'legacy-heal')}.md`,
      automation: text(item),
      guardrails: { max_invocations_per_hour: 1, requires_human_above: 'SEV2', rollback_on_failure: true },
    });
    scaffold(`remediation[${remediation.length - 1}]`);   // guardrails are placeholders
    place(`remediation[${remediation.length - 1}]`, 'L4', item);
  });

  // ----- L5: synthetic checks (+ baselines stub, like the crawler) -----
  const syntheticChecks = [];
  for (const item of items(L.L5)) {
    keep('L5', item);
    const id = slug(item.title || item.id, 'legacy-check');
    if (syntheticChecks.some(s => s.id === id)) continue;
    syntheticChecks.push({
      id,
      kind: 'blackbox-exporter',
      target: `https://${service}.example.com/health`,
      interval: '1m',
      on_fail_severity: 'SEV3',
    });
    scaffold(`validation.synthetic_checks.${id}`);   // target/interval are placeholders
    place(`validation.synthetic_checks.${id}`, 'L5', item);
  }
  const baselines = { mttd_target_p50: '15m', mttr_target_p50: '1d', review_cadence: 'monthly' };
  scaffold('baselines');

  // ----- GOV: governance items become imports (the `with` map is free-form,
  // so the original item rides along losslessly) -----
  const imports = items(L.GOV).map((item, i) => {
    keep('GOV', item);
    place(`imports[${i}]`, 'GOV', item);
    return {
      ref: `legacy/${slug(item.id, 'gov')}`,
      with: { title: item.title || '', desc: item.desc || '', tool: item.tool || '', source: item.source || '' },
    };
  });

  // ----- assembly -----
  for (const symbol of scaffoldSymbols) {
    annotations[`crawler.scaffold.${symbol}`] = PLACEHOLDER_NOTE;
  }
  if (legacy.description) annotations['legacy.description'] = String(legacy.description);
  if (legacy.badge) annotations['legacy.badge'] = String(legacy.badge);
  if (legacy.liveness?.mcpUrl) annotations['legacy.liveness.mcpUrl'] = String(legacy.liveness.mcpUrl);
  if (legacy.liveness?.refreshedAt) annotations['legacy.liveness.refreshedAt'] = String(legacy.liveness.refreshedAt);
  annotations['legacy.format'] = 'layered-json';
  annotations['legacy.scaffoldCount'] = String(scaffoldSymbols.length);
  if (opts.now) annotations['legacy.upconvertedAt'] = String(opts.now);

  const canonical = {
    apiVersion: 'observability.platform/v1',
    kind: 'ObservabilityPack',
    metadata: {
      name: service,
      version: '0.1.0-legacy',
      binding: 'legacy',
      owners: ['legacy-import'],
      imports: imports.length ? imports : undefined,
      bindings: { service, environments: ['prod'], criticality: 'tier-3' },
      labels: { source: 'legacy-import', ...(legacy.name ? { legacy_name: slug(legacy.name, service) } : {}) },
      annotations,
    },
    spec: {
      otel: {
        semconv: '1.26.0',
        resource_attributes: { required: ['service.name'] },
        sdk: { languages: ['go'], sampling: { policy: 'parentbased_traceidratio', ratio: 0.1 }, propagators: ['tracecontext'] },
      },
      slis,
      slos,
      ...(backends.length ? { telemetry: { backends } } : {}),
      ...(Object.keys(storage).length ? { storage } : {}),
      pipelines: {
        receivers: [{ name: 'otlp' }],
        processors: [{ name: 'batch' }],
        exporters: { metrics: { kind: 'prometheusremotewrite' }, logs: { kind: 'elasticsearch' }, traces: { kind: 'otlp' } },
      },
      queries: { recording_rules: recordingRules },
      dashboards,
      policy: { burn_rate_alerts: burnRateAlerts },
      alerting: { routes },
      ...(remediation.length ? { remediation } : {}),
      baselines,
      validation: { synthetic_checks: syntheticChecks },
    },
  };
  // The shared OTel/pipelines sections are always placeholders for a
  // legacy import — the old format never described them.
  annotations['crawler.scaffold.otel'] = PLACEHOLDER_NOTE;
  annotations['crawler.scaffold.pipelines.receivers[0]'] = PLACEHOLDER_NOTE;
  annotations['crawler.scaffold.pipelines.processors[0]'] = PLACEHOLDER_NOTE;
  annotations['crawler.scaffold.pipelines.exporters.metrics'] = PLACEHOLDER_NOTE;
  annotations['crawler.scaffold.pipelines.exporters.logs'] = PLACEHOLDER_NOTE;
  annotations['crawler.scaffold.pipelines.exporters.traces'] = PLACEHOLDER_NOTE;
  // The six ride in the count too (report.scaffolded, legacy.scaffoldCount):
  // pushed AFTER the direct writes so the annotation keys keep their order
  // (re-assigning an existing key keeps its position in JS key order) — the
  // one byte run that changes in the output is the count's value.
  for (const symbol of ['otel', 'pipelines.receivers[0]', 'pipelines.processors[0]',
    'pipelines.exporters.metrics', 'pipelines.exporters.logs', 'pipelines.exporters.traces']) scaffold(symbol);
  annotations['legacy.scaffoldCount'] = String(scaffoldSymbols.length);
  if (!canonical.metadata.imports) delete canonical.metadata.imports;

  const report = {
    format: 'layered-json',
    service,
    mapped,
    scaffolded: scaffoldSymbols.length,
    notes,
  };
  return { canonical, report, provenance };
}

// ---------- the merge ----------

const MERGE_FAMILIES = [
  'imports', 'slis', 'slos', 'telemetry.backends', 'storage', 'pipelines.receivers', 'pipelines.processors',
  'pipelines.exporters', 'queries.recording_rules', 'dashboards', 'policy.burn_rate_alerts', 'alerting.routes',
  'remediation', 'validation.synthetic_checks',
];
const clone = (x) => JSON.parse(JSON.stringify(x));
const getPath = (root, segs) => segs.reduce((cur, s) => (cur == null ? undefined : cur[s]), root);
const ensurePath = (root, segs, leaf) => {
  let cur = root;
  for (const s of segs.slice(0, -1)) { if (cur[s] == null || typeof cur[s] !== 'object') cur[s] = {}; cur = cur[s]; }
  const last = segs[segs.length - 1];
  if (cur[last] == null) cur[last] = leaf;
  return cur[last];
};
const symbolOf = (fam, item, i, key) => (fam.kind === 'id' ? `${fam.family}.${item.id}` : fam.kind === 'key' ? `${fam.family}.${key}` : `${fam.family}[${i}]`);

/**
 * Merge a fresh upconvert into an existing canonical pack without regressing a real value.
 *
 *   mergeUpconvert(upconvertLegacyPack(legacy, { now }), existing) -> { canonical, report }
 *   report: { kept, added, skipped, scaffoldCount, danglingRefs }
 *
 * Rules (per family in SYMBOL_FAMILIES order, list and keyed sections only):
 *   (a) an existing item with the same identity   -> KEPT   (existing value, marker state and type annotation)
 *   (b) else the fresh item's legacy record is already in the existing annotations
 *                                                 -> SKIPPED (seen before; the operator removed or renamed it)
 *   (c) else the fresh item has no legacy source   -> SKIPPED (a schema-required stub; existing already validates)
 *   (d) else                                       -> ADDED  (appended; its marker, type annotation and record
 *                                                             written under the symbol RE-INDEXED to its final position)
 * Metadata scalars and the unlisted sections (otel, baselines, environments) are the existing pack's, untouched.
 * Annotations: existing keys keep their order and values; every fresh `legacy.*` key is refreshed; the markers
 * and types of added items are appended; `legacy.scaffoldCount` is recounted. Pure and idempotent.
 */
export function mergeUpconvert({ canonical: fresh, provenance = {} }, existing, _opts = {}) {
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)
    || existing.apiVersion !== 'observability.platform/v1' || existing.kind !== 'ObservabilityPack') {
    throw new Error('mergeUpconvert: the existing pack is not a canonical ObservabilityPack (apiVersion/kind)');
  }
  const result = clone(existing);
  const existingAnn = existing.metadata?.annotations || {};
  const freshAnn = fresh.metadata?.annotations || {};
  const report = { kept: 0, added: 0, skipped: 0, scaffoldCount: 0, danglingRefs: 0 };
  const addedMarkers = {};
  const addedSlos = [];
  const addedBurn = [];

  for (const family of MERGE_FAMILIES) {
    const fam = SYMBOL_FAMILIES.find(f => f.family === family);
    const freshContainer = getPath(fresh, fam.section);
    if (freshContainer == null) continue;
    if (fam.kind === 'key') {
      // The container is created on the first ADD only: a section the existing pack removed stays removed
      // when every fresh item is kept or skipped (an invented empty container fails the schema's minItems).
      let target = getPath(result, fam.section);
      for (const [key, item] of Object.entries(freshContainer)) {
        const symbol = symbolOf(fam, item, 0, key);
        if (target != null && Object.prototype.hasOwnProperty.call(target, key)) { report.kept++; continue; }
        const rec = provenance[symbol];
        if (rec == null || rec in existingAnn) { report.skipped++; continue; }
        if (target == null) target = ensurePath(result, fam.section, {});
        target[key] = clone(item);
        report.added++;
        if (freshAnn[`crawler.scaffold.${symbol}`]) addedMarkers[`crawler.scaffold.${symbol}`] = freshAnn[`crawler.scaffold.${symbol}`];
        if (freshAnn[`observogram.artefact.type.${symbol}`]) addedMarkers[`observogram.artefact.type.${symbol}`] = freshAnn[`observogram.artefact.type.${symbol}`];
      }
      continue;
    }
    const freshList = Array.isArray(freshContainer) ? freshContainer : [];
    if (!freshList.length) continue;
    let target = getPath(result, fam.section);
    const existingIds = new Set(target == null ? [] : target.map((it, i) => fam.identity(it, i, target)));
    freshList.forEach((item, i) => {
      const symbol = symbolOf(fam, item, i);
      const identity = fam.identity(item, i, freshList);
      if (identity != null && existingIds.has(identity)) { report.kept++; return; }
      const rec = provenance[symbol];
      if (rec == null || rec in existingAnn) { report.skipped++; return; }
      if (target == null) target = ensurePath(result, fam.section, []);
      const at = target.length;
      target.push(clone(item));
      existingIds.add(fam.identity(target[at], at, target));
      report.added++;
      const newSymbol = symbolOf(fam, item, at);
      if (freshAnn[`crawler.scaffold.${symbol}`]) addedMarkers[`crawler.scaffold.${newSymbol}`] = freshAnn[`crawler.scaffold.${symbol}`];
      if (freshAnn[`observogram.artefact.type.${symbol}`]) addedMarkers[`observogram.artefact.type.${newSymbol}`] = freshAnn[`observogram.artefact.type.${symbol}`];
      if (family === 'slos') addedSlos.push(item);
      if (family === 'policy.burn_rate_alerts') addedBurn.push(item);
    });
  }

  const legacyKeys = Object.fromEntries(Object.entries(freshAnn).filter(([k]) => k.startsWith('legacy.')));
  const annotations = { ...existingAnn, ...legacyKeys, ...addedMarkers };
  annotations['legacy.scaffoldCount'] = String(Object.keys(annotations).filter(k => k.startsWith('crawler.scaffold.')).length);
  if (!result.metadata) result.metadata = {};
  result.metadata.annotations = annotations;
  if (Array.isArray(result.metadata.imports) && !result.metadata.imports.length) delete result.metadata.imports;

  const sliIds = new Set((result.spec?.slis || []).map(s => s.id));
  const sloIds = new Set((result.spec?.slos || []).map(s => s.id));
  report.danglingRefs = addedSlos.filter(s => !sliIds.has(s.sli)).length + addedBurn.filter(b => !sloIds.has(b.slo)).length;
  report.scaffoldCount = Number(annotations['legacy.scaffoldCount']);
  return { canonical: result, report };
}
