// tools/lib/traceability.mjs
//
// Requirement traceability for diagnostic-grade observability.
//
// Builds an inferred chain for each SLO/SLI:
//   SLO -> SLI -> metrics / recording rules -> exporter / scrape evidence
//       -> dashboards -> alerts.
//
// Pure ESM, browser-safe. The adapter attaches the resulting object to the
// layered pack so both Node-side tests and the studio can read the same model.

import { PROMQL_KEYWORDS, extractPromqlMetricNames } from './promql.mjs';

const TRACE_STOP_WORDS = new Set([
  ...PROMQL_KEYWORDS,
  // Common label names that appear in grouping clauses.
  'app', 'code', 'cluster', 'container', 'endpoint', 'env', 'instance', 'job',
  'le', 'method', 'namespace', 'pod', 'route', 'service', 'status',
]);

const EXPR_KEYS = new Set(['expr', 'query', 'promql', 'expression']);

export function buildRequirementTraceability({ spec = {}, annotations = {}, layers = {} } = {}) {
  const flat = flattenLayers(layers);
  const byDefines = new Map();
  for (const art of flat) {
    if (art?.defines) byDefines.set(art.defines, art);
  }

  const slis = Array.isArray(spec.slis) ? spec.slis : [];
  const slos = Array.isArray(spec.slos) ? spec.slos : [];
  const sliById = new Map(slis.map(sli => [sli.id, sli]));
  const sloSliIds = new Set(slos.map(slo => stripSymbol(slo.sli || '', 'slis')).filter(Boolean));

  const recordingRules = Array.isArray(spec.queries?.recording_rules)
    ? spec.queries.recording_rules
    : [];
  const dashboards = Array.isArray(spec.dashboards) ? spec.dashboards : [];
  const burnRateAlerts = Array.isArray(spec.policy?.burn_rate_alerts)
    ? spec.policy.burn_rate_alerts
    : [];
  const liveAlertNames = annotationList(annotations['mcp.discovered.alert_rule_names']);
  // Alerting rules the ruler reports as failing to evaluate: they exist,
  // but a rule that cannot evaluate is not alert evidence.
  const unhealthyAlertNames = new Set(annotationList(annotations['mcp.discovered.alert_rules_unhealthy']));
  const declaredMetricOrigins = parseAnnotationObject(annotations['crawler.discovered.metric_origins']);
  const declaredMetricNames = new Set([
    ...annotationList(
      annotations['crawler.discovered.metric_names'],
      annotations['crawler.discovered.metric_names_count'],
      annotations['crawler.discovered.metric_names_sample'],
    ),
    ...flat
      .filter(a => (a?.id || '').startsWith('METRIC-SRC-') && a.spec?.name)
      .map(a => a.spec.name),
  ]);
  const liveMetricNames = new Set([
    ...annotationList(
      annotations['mcp.discovered.metric_names'],
      annotations['mcp.discovered.metric_names_count'],
      annotations['mcp.discovered.metric_names_sample'],
    ),
    ...flat
      .filter(a => (a?.id || '').startsWith('METRIC-') && a.source === 'Verified' && a.spec?.name)
      .map(a => a.spec.name),
  ]);
  const scrapeJobs = [
    ...annotationList(annotations['crawler.discovered.scrape_jobs'], annotations['crawler.discovered.scrape_jobs_count']),
    ...annotationList(annotations['mcp.discovered.scrape_jobs']),
  ];

  const chains = [];
  for (const slo of slos) {
    const sliId = stripSymbol(slo.sli || '', 'slis');
    const sli = sliById.get(sliId) || null;
    chains.push(buildChain({
      slo,
      sli,
      kind: 'slo',
      spec,
      recordingRules,
      dashboards,
      burnRateAlerts,
      liveAlertNames,
      unhealthyAlertNames,
      liveMetricNames,
      declaredMetricNames,
      declaredMetricOrigins,
      scrapeJobs,
      flat,
      byDefines,
    }));
  }

  for (const sli of slis) {
    if (sloSliIds.has(sli.id)) continue;
    chains.push(buildChain({
      slo: null,
      sli,
      kind: 'sli',
      spec,
      recordingRules,
      dashboards,
      burnRateAlerts,
      liveAlertNames,
      unhealthyAlertNames,
      liveMetricNames,
      declaredMetricNames,
      declaredMetricOrigins,
      scrapeJobs,
      flat,
      byDefines,
    }));
  }

  const summary = {
    requirements: chains.length,
    withMetrics: chains.filter(c => c.metrics.length > 0).length,
    withRecordingRules: chains.filter(c => c.recordingRules.length > 0).length,
    withExporters: chains.filter(c => c.exporters.length > 0).length,
    withScrapeEvidence: chains.filter(c => c.scrapeJobs.observedCount > 0).length,
    withMatchedScrapeJobs: chains.filter(c => c.scrapeJobs.items.length > 0).length,
    withDashboards: chains.filter(c => c.dashboards.length > 0).length,
    withAlerts: chains.filter(c => c.alerts.some(alertIsEvidence)).length,
    complete: chains.filter(c => c.gaps.length === 0).length,
  };

  return { summary, chains };
}

function buildChain({
  slo,
  sli,
  kind,
  recordingRules,
  dashboards,
  burnRateAlerts,
  liveAlertNames,
  unhealthyAlertNames = new Set(),
  liveMetricNames,
  declaredMetricNames,
  declaredMetricOrigins,
  scrapeJobs,
  flat,
  byDefines,
}) {
  const sloId = slo?.id || null;
  const sliId = sli?.id || null;
  const sloSymbol = sloId ? `slos.${sloId}` : null;
  const sliSymbol = sliId ? `slis.${sliId}` : null;
  const baseNeedles = requirementNeedles(slo, sli);

  const metricMap = new Map();
  for (const m of metricsFromRequirement(slo, sli)) addMetric(metricMap, m, 'sli');

  const relatedRules = [];
  for (const rule of recordingRules) {
    const text = `${rule.name || ''} ${rule.expr || ''}`;
    const ruleMetrics = extractMetricNames([rule.name, rule.expr]);
    if (matchesAnyNeedle(text, baseNeedles) || intersects(ruleMetrics, metricMap.keys())) {
      relatedRules.push(rule);
      for (const m of ruleMetrics) addMetric(metricMap, m, 'recording_rule');
    }
  }

  if (metricMap.size === 0 && liveMetricNames.size) {
    for (const live of liveMetricNames) {
      if (matchesAnyNeedle(live, baseNeedles)) addMetric(metricMap, live, 'live_inventory');
    }
  }

  const metrics = [...metricMap.values()].map(m => ({
    ...m,
    declared: declaredMetricNames.has(m.name),
    verified: liveMetricNames.has(m.name),
    origin: declaredMetricOrigins[m.name] || null,
  }));

  const ruleNames = relatedRules.map(r => r.name).filter(Boolean);
  const matchingArtifacts = {
    sli: sliSymbol ? byDefines.get(sliSymbol) || null : null,
    slo: sloSymbol ? byDefines.get(sloSymbol) || null : null,
  };

  const exporters = findMetricExporters(flat, metrics, relatedRules);
  const scrape = matchScrapeJobs(scrapeJobs, baseNeedles, metrics);
  const dashboardEvidence = dashboards
    .map((dashboard) => dashboardTrace(dashboard, baseNeedles, metrics, ruleNames, [sloSymbol, sliSymbol].filter(Boolean)))
    .filter(Boolean);
  const alerts = alertTrace({
    slo,
    burnRateAlerts,
    liveAlertNames,
    unhealthyAlertNames,
    needles: baseNeedles,
    flat,
  });

  const gaps = [];
  if (!sli) gaps.push('missing_sli');
  if (metrics.length === 0) gaps.push('missing_metric_mapping');
  if (exporters.length === 0) gaps.push('missing_metrics_exporter');
  if (scrape.observedCount === 0) gaps.push('missing_scrape_evidence');
  if (dashboardEvidence.length === 0) gaps.push('missing_dashboard_evidence');
  // An unhealthy live rule is listed (it exists) but is not evidence.
  if (!alerts.some(alertIsEvidence)) gaps.push('missing_alert_evidence');

  const notes = [];
  if (scrape.observedCount > 0 && scrape.items.length === 0) {
    notes.push('scrape_jobs_observed_but_not_metric_specific');
  }
  if (metrics.some(m => !m.verified) && liveMetricNames.size > 0) {
    notes.push('some_metrics_not_in_live_inventory_sample');
  }

  return {
    id: sloId || sliId || 'requirement',
    kind,
    slo: slo ? {
      id: slo.id,
      symbol: sloSymbol,
      objective: slo.objective,
      window: slo.window,
      artefactId: matchingArtifacts.slo?.id || null,
    } : null,
    sli: sli ? {
      id: sli.id,
      symbol: sliSymbol,
      type: sli.type,
      artefactId: matchingArtifacts.sli?.id || null,
    } : null,
    metrics,
    recordingRules: relatedRules.map(rule => ({
      name: rule.name,
      interval: rule.interval || null,
      metrics: extractMetricNames(rule.expr || ''),
    })),
    exporters,
    scrapeJobs: scrape,
    dashboards: dashboardEvidence,
    alerts,
    gaps,
    notes,
  };
}

function metricsFromRequirement(slo, sli) {
  const out = new Set();
  if (sli) {
    for (const key of ['good', 'total', 'query', 'expression']) {
      for (const m of extractMetricNames(sli[key])) out.add(m);
    }
    if (metricish(sli.semconv_metric)) out.add(sli.semconv_metric);
  }
  if (slo) {
    for (const key of ['query', 'expression']) {
      for (const m of extractMetricNames(slo[key])) out.add(m);
    }
  }
  return out;
}

function addMetric(map, name, source) {
  if (!metricish(name)) return;
  if (!map.has(name)) map.set(name, { name, sources: [] });
  const item = map.get(name);
  if (!item.sources.includes(source)) item.sources.push(source);
}

function findMetricExporters(flat, metrics, rules) {
  if (!metrics.length && !rules.length) return [];
  return flat
    .filter(a => a?.id === 'PIP-EXP-MET' || (a?.tags || []).includes('exporter') && (a?.tags || []).includes('metrics'))
    .map(a => ({
      id: a.id,
      title: a.title,
      kind: a.spec?.kind || a.tool || null,
      source: a.source || null,
    }));
}

function matchScrapeJobs(scrapeJobs, needles, metrics) {
  const items = scrapeJobs
    .filter(job => matchesAnyNeedle(job, needles) || metrics.some(m => matchesMetricPrefix(job, m.name)))
    .map(job => ({ name: job, confidence: 'matched' }));
  return {
    observedCount: scrapeJobs.length,
    items,
    source: scrapeJobs.length ? 'mcp.discovered.scrape_jobs' : null,
    exact: items.length > 0,
  };
}

function dashboardTrace(dashboard, needles, metrics, ruleNames, symbols) {
  const panels = dashboardPanels(dashboard);
  const bindings = new Map((dashboard.panel_bindings || []).map(b => [norm(b.panel), b.binds_to]));
  const panelEvidence = [];
  const matchers = [
    ...needles,
    ...metrics.map(m => m.name),
    ...ruleNames,
    ...symbols,
  ].filter(Boolean);

  for (const p of panels) {
    const title = p.title || p.panel || p.id || 'panel';
    const binding = p.binds_to || bindings.get(norm(title)) || null;
    const queryText = collectExpressionStrings(p).join(' ');
    const hay = `${title} ${p.description || ''} ${binding || ''} ${queryText}`;
    const matched = matchers.filter(m => matchesNeedle(hay, m)).slice(0, 8);
    if (!matched.length) continue;
    panelEvidence.push({
      title: String(title),
      bindsTo: binding,
      matches: matched,
      metrics: extractMetricNames(queryText).filter(m => metrics.some(mm => mm.name === m)),
    });
  }

  if (!panelEvidence.length) {
    const bindingMatch = (dashboard.panel_bindings || []).filter(b =>
      symbols.includes(b.binds_to) || matchers.some(m => matchesNeedle(`${b.panel || ''} ${b.binds_to || ''}`, m))
    );
    for (const b of bindingMatch) {
      panelEvidence.push({
        title: b.panel || 'panel',
        bindsTo: b.binds_to || null,
        matches: [b.binds_to].filter(Boolean),
        metrics: [],
      });
    }
  }

  if (!panelEvidence.length) return null;
  return {
    id: dashboard.id,
    title: dashboard.params?.title || dashboard.id,
    source: dashboard.source || null,
    panels: panelEvidence,
  };
}

// An alert entry counts as evidence unless it says otherwise: a live rule
// the ruler reports unhealthy carries `verified: false`.
function alertIsEvidence(alert) {
  return alert?.verified !== false;
}

function alertTrace({ slo, burnRateAlerts, liveAlertNames, unhealthyAlertNames = new Set(), needles, flat = [] }) {
  const out = [];
  const sloId = slo?.id || null;
  burnRateAlerts.forEach((alert, i) => {
    if (!sloId) return;
    if (stripSymbol(alert.slo || '', 'slos') !== sloId) return;
    // The adapter projects each entry as POL-<i+1>; a Scaffold projection
    // is the fetcher's schema-forced placeholder (mcp.scaffold.policy.
    // burn_rate_alerts[<i>]) — no alerting rule exists, so it is not alert
    // evidence and must not suppress the missing_alert_evidence gap.
    const artefact = flat.find(a => a?.spec === alert)
      || flat.find(a => a?.id === `POL-${String(i + 1).padStart(2, '0')}`);
    if (artefact?.source === 'Scaffold') return;
    out.push({
      name: `burn-rate alert: ${sloId}`,
      type: 'burn_rate',
      source: 'spec.policy.burn_rate_alerts',
      windows: Array.isArray(alert.windows) ? alert.windows.length : 0,
      ...(artefact?.id ? { artefactId: artefact.id } : {}),
    });
  });
  for (const name of liveAlertNames) {
    if (!matchesAnyNeedle(name, needles)) continue;
    const unhealthy = unhealthyAlertNames.has(name);
    out.push({
      name,
      type: 'live_alert_rule',
      source: 'mcp.discovered.alert_rule_names',
      verified: !unhealthy,
      ...(unhealthy ? { health: 'err' } : {}),
    });
  }
  return dedupeBy(out, a => `${a.type}:${a.name}`);
}

export function extractMetricNames(value) {
  return extractPromqlMetricNames(value);
}

function dashboardPanels(dashboard) {
  const out = [];
  for (const p of dashboard.params?.panels || []) if (p && typeof p === 'object') out.push(p);
  flattenPanels(dashboard.params?.raw?.panels, out);
  for (const b of dashboard.panel_bindings || []) out.push({ ...b, title: b.panel });
  return dedupeBy(out, p => `${p.title || p.panel || p.id || ''}:${p.binds_to || ''}:${JSON.stringify(p.targets || [])}`);
}

function flattenPanels(panels, out) {
  if (!Array.isArray(panels)) return;
  for (const panel of panels) {
    if (!panel || typeof panel !== 'object') continue;
    out.push(panel);
    if (Array.isArray(panel.panels)) flattenPanels(panel.panels, out);
  }
}

function collectExpressionStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') return out;
  if (Array.isArray(value)) {
    for (const v of value) collectExpressionStrings(v, out);
    return out;
  }
  if (typeof value !== 'object') return out;
  for (const [k, v] of Object.entries(value)) {
    if (typeof v === 'string' && (EXPR_KEYS.has(k) || k === 'legendFormat')) out.push(v);
    else if (v && typeof v === 'object') collectExpressionStrings(v, out);
  }
  return out;
}

function requirementNeedles(slo, sli) {
  const raw = [slo?.id, sli?.id, `slos.${slo?.id || ''}`, `slis.${sli?.id || ''}`].filter(Boolean);
  const out = new Set();
  for (const value of raw) {
    const s = String(value);
    out.add(s);
    out.add(s.replace(/^slo_/, 'slo:'));
    out.add(s.replace(/^slis?\./, '').replace(/^slos?\./, ''));
    out.add(s.replace(/_/g, ':'));
    out.add(s.replace(/^slo_/, '').replace(/^sli_/, ''));
  }
  return [...out].filter(Boolean);
}

function matchesAnyNeedle(text, needles) {
  return needles.some(n => matchesNeedle(text, n));
}

function matchesNeedle(text, needle) {
  if (!text || !needle) return false;
  const hay = String(text).toLowerCase();
  const n = String(needle).toLowerCase();
  if (hay.includes(n)) return true;
  const hc = compact(hay);
  const nc = compact(n);
  if (nc && hc.includes(nc)) return true;
  const ws = words(n).filter(w => w.length >= 5 && !TRACE_STOP_WORDS.has(w));
  return ws.length >= 2 && ws.every(w => hay.includes(w) || hc.includes(compact(w)));
}

function metricish(name) {
  return typeof name === 'string' && /^[A-Za-z_:][A-Za-z0-9_:]*$/.test(name);
}

function matchesMetricPrefix(job, metric) {
  const j = compact(job);
  const parts = String(metric || '').toLowerCase().split(/[_:]+/).filter(p => p.length >= 5);
  return parts.some(p => j.includes(compact(p)) || compact(p).includes(j));
}

function intersects(values, otherIterable) {
  const other = new Set(otherIterable);
  for (const v of values) if (other.has(v)) return true;
  return false;
}

function flattenLayers(layers) {
  const out = [];
  for (const key of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    if (Array.isArray(layers[key])) out.push(...layers[key]);
  }
  const l4 = layers.L4 || {};
  for (const key of ['policy', 'alerting', 'healing']) {
    if (Array.isArray(l4[key])) out.push(...l4[key]);
  }
  return out;
}

function stripSymbol(ref, defaultPrefix) {
  if (typeof ref !== 'string') return '';
  let s = ref.replace(/^ref:/, '');
  if (s.startsWith(`${defaultPrefix}.`)) s = s.slice(defaultPrefix.length + 1);
  if (s.startsWith('slis.')) s = s.slice(5);
  if (s.startsWith('slos.')) s = s.slice(5);
  return s;
}

export function annotationList(value, countValue = null, fallbackValue = null) {
  const count = Number.parseInt(String(countValue ?? ''), 10);
  const primary = listFromValue(value);
  const primaryIsLegacyCount =
    primary.length === 1 &&
    /^\d+$/.test(primary[0]) &&
    Number.isFinite(count) &&
    Number(primary[0]) === count;
  const chosen = primary.length && !primaryIsLegacyCount
    ? primary
    : listFromValue(fallbackValue);
  return dedupeStrings(chosen);
}

function parseAnnotationObject(value) {
  if (!value || typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function listFromValue(value) {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) {
    return value.map(v => String(v).trim()).filter(Boolean);
  }
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.map(v => String(v).trim()).filter(Boolean);
      }
    } catch {
      // Fall through to delimiter parsing.
    }
  }
  return raw
    .split(/[,\r\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

function dedupeStrings(items) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function words(value) {
  return String(value || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function norm(value) {
  return compact(value);
}

function dedupeBy(items, keyFn) {
  const out = [];
  const seen = new Set();
  for (const item of items) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}
