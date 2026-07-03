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
//   upconvertLegacyPack(obj, opts?)     -> { canonical, report }
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
  let mapped = 0;

  const scaffold = (symbol) => { scaffoldSymbols.push(symbol); };
  const keep = (layer, item) => {
    annotations[`legacy.artefact.${layer}.${item.id || 'item'}`] = JSON.stringify(item);
    mapped++;
  };

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
        continue;
      }
    }
    const id = slug(item.title || item.id, 'backend');
    if (backends.some(b => b.id === id)) continue;
    backends.push({ id, signal: signalOf(item), product: slug(item.tool, 'backend') });
    if (item.source === 'GAP') scaffold(`telemetry.backends.${id}`);
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
    } else {
      const name = `${metricSeg(service, 'svc')}:${metricSeg(item.title || item.id)}:legacy`;
      if (recordingRules.some(r => r.name === name)) continue;
      recordingRules.push({ name, expr: 'vector(1)' });
      scaffold(`queries.recording_rules[${recordingRules.length - 1}]`);   // expr is a placeholder
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
  }
  const baselines = { mttd_target_p50: '15m', mttr_target_p50: '1d', review_cadence: 'monthly' };
  scaffold('baselines');

  // ----- GOV: governance items become imports (the `with` map is free-form,
  // so the original item rides along losslessly) -----
  const imports = items(L.GOV).map((item) => {
    keep('GOV', item);
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
  if (!canonical.metadata.imports) delete canonical.metadata.imports;

  const report = {
    format: 'layered-json',
    service,
    mapped,
    scaffolded: scaffoldSymbols.length,
    notes,
  };
  return { canonical, report };
}
