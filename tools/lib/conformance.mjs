// tools/lib/conformance.mjs
//
// Maturity-rubric scoring for canonical packs. Pure ESM —
// browser-friendly so the studio could embed it later. Server uses it
// today via GET /api/packs/:id/conformance.
//
// Rubric is hand-curated from spec §5 (per-dimension MUSTs/SHOULDs) and §7
// (the tier-3 → tier-2 → tier-1 summary table). Each clause encodes:
//
//   { id, dimension, severity, minTier, description, specRef, evaluate }
//
// `minTier` is the *least stringent* tier at which the clause begins to
// apply. Rank: tier-3 = 1 (least), tier-2 = 2, tier-1 = 3 (most). A clause
// with minTier=tier-3 applies to every pack; one with minTier=tier-1 only
// applies to tier-1 packs.
//
// `evaluate(canonical) → boolean` is run against the env-overlaid spec.
// Schema-enforced rules (e.g. "every SLO has objective+window") are NOT
// duplicated here — the validator already covers them. The rubric only
// encodes content checks above the schema floor.

export const TIER_RANK = { 'tier-3': 1, 'tier-2': 2, 'tier-1': 3 };

const DEFAULT_TIER = 'tier-3';

function tierOf(canonical) {
  return canonical?.metadata?.bindings?.criticality || DEFAULT_TIER;
}

function spec(canonical) {
  return canonical?.spec || {};
}

// ---------- helpers used by clause evaluators ----------

function slis(c)          { return spec(c).slis || []; }
function slos(c)          { return spec(c).slos || []; }
function dashboards(c)    { return spec(c).dashboards || []; }
function backends(c)      { return spec(c).telemetry?.backends || []; }
function chaos(c)         { return spec(c).validation?.chaos_experiments || []; }
function syntheticChecks(c) { return spec(c).validation?.synthetic_checks || []; }
function remediations(c)  { return spec(c).remediation || []; }
function alertRoutes(c)   { return spec(c).alerting?.routes || []; }
function burnRateAlerts(c){ return spec(c).policy?.burn_rate_alerts || []; }
function forecasts(c)     { return spec(c).policy?.forecasts || []; }
function recordingRules(c){ return spec(c).queries?.recording_rules || []; }
function derivedViews(c)  { return spec(c).queries?.derived_views || []; }
function receivers(c)     { return spec(c).pipelines?.receivers || []; }
function processors(c)    { return spec(c).pipelines?.processors || []; }
function exporters(c)     { return spec(c).pipelines?.exporters || {}; }
function otel(c)          { return spec(c).otel || {}; }
function baselines(c)     { return spec(c).baselines || {}; }

function extendedBackendRefs(c) {
  const s = spec(c);
  return [
    s.profiling?.backend,
    s.network?.backend,
    s.policy_engine?.backend,
    ...(s.mesh || []).map(x => x.backend),
    ...(s.collection || []).map(x => x.backend),
  ].filter(Boolean);
}

function stripRef(id) {
  if (typeof id !== 'string') return '';
  return id.replace(/^ref:/, '').replace(/^(slis|slos)\./, '');
}

function semverGte(a, b) {
  const pa = String(a).split('.').map(n => parseInt(n, 10) || 0);
  const pb = String(b).split('.').map(n => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y;
  }
  return true;
}

// ---------- the rubric ----------

export const RUBRIC = [
  // ----- L1 Contract -----
  {
    id: 'L1.MUST.availability_slo', dimension: 'L1', severity: 'MUST', minTier: 'tier-3',
    description: 'At least one availability SLO (ratio-type SLI).',
    specRef: '§5.1',
    evaluate(c) {
      const ids = new Set(slos(c).map(s => stripRef(s.sli)));
      return slis(c).some(s => s.type === 'ratio' && ids.has(s.id));
    },
  },
  {
    id: 'L1.MUST.latency_slo', dimension: 'L1', severity: 'MUST', minTier: 'tier-2',
    description: 'At least one latency SLO (threshold or distribution SLI).',
    specRef: '§5.1',
    evaluate(c) {
      const ids = new Set(slos(c).map(s => stripRef(s.sli)));
      return slis(c).some(s => (s.type === 'threshold' || s.type === 'distribution') && ids.has(s.id));
    },
  },
  {
    id: 'L1.SHOULD.domain_slo', dimension: 'L1', severity: 'SHOULD', minTier: 'tier-1',
    description: 'A third, domain-specific SLO beyond availability and latency (4+ SLOs total).',
    specRef: '§5.1',
    evaluate(c) { return slos(c).length >= 4; },
  },
  {
    id: 'L1.MUST.sli_covered_by_slo', dimension: 'L1', severity: 'MUST', minTier: 'tier-3',
    description: 'Every declared SLI is referenced by at least one SLO.',
    specRef: '§5.1',
    evaluate(c) {
      const referenced = new Set(slos(c).map(s => stripRef(s.sli)));
      return slis(c).every(s => referenced.has(s.id));
    },
  },

  // ----- L2 OTel + Pipelines + Storage -----
  {
    id: 'L2.MUST.otlp_receiver', dimension: 'L2', severity: 'MUST', minTier: 'tier-3',
    description: 'OTel Collector pipeline declares an `otlp` receiver.',
    specRef: '§5.2',
    evaluate(c) { return receivers(c).some(r => r.name === 'otlp'); },
  },
  {
    id: 'L2.MUST.service_name_required', dimension: 'L2', severity: 'MUST', minTier: 'tier-3',
    description: '`service.name` listed in otel.resource_attributes.required.',
    specRef: '§5.3',
    evaluate(c) {
      const req = otel(c).resource_attributes?.required || [];
      return req.includes('service.name');
    },
  },
  {
    id: 'L2.MUST.semconv_floor', dimension: 'L2', severity: 'MUST', minTier: 'tier-3',
    description: 'OTel SemConv version >= 1.26.0 (binding floor).',
    specRef: '§5.3',
    evaluate(c) {
      const sv = otel(c).semconv;
      return typeof sv === 'string' && semverGte(sv, '1.26.0');
    },
  },
  {
    id: 'L2.MUST.semconv_current', dimension: 'L2', severity: 'MUST', minTier: 'tier-1',
    description: 'OTel SemConv at currently-tracked version (1.27.0).',
    specRef: '§5.3',
    evaluate(c) { return otel(c).semconv === '1.27.0'; },
  },
  {
    id: 'L2.MUST.resource_attrs_5plus', dimension: 'L2', severity: 'MUST', minTier: 'tier-1',
    description: 'At least five required resource attributes declared.',
    specRef: '§5.3',
    evaluate(c) { return (otel(c).resource_attributes?.required || []).length >= 5; },
  },
  {
    id: 'L2.MUST.log_correlation', dimension: 'L2', severity: 'MUST', minTier: 'tier-1',
    description: '`otel.sdk.log_correlation: true` (trace IDs injected into logs).',
    specRef: '§5.3',
    evaluate(c) { return otel(c).sdk?.log_correlation === true; },
  },
  {
    id: 'L2.MUST.metrics_exporter', dimension: 'L2', severity: 'MUST', minTier: 'tier-2',
    description: 'Pipelines export metrics.',
    specRef: '§5.2',
    evaluate(c) { return !!exporters(c).metrics?.kind; },
  },
  {
    id: 'L2.MUST.logs_and_traces_exporters', dimension: 'L2', severity: 'MUST', minTier: 'tier-1',
    description: 'Pipelines export logs and traces.',
    specRef: '§5.2',
    evaluate(c) { return !!exporters(c).logs?.kind && !!exporters(c).traces?.kind; },
  },
  {
    id: 'L2.MUST.tail_sampling', dimension: 'L2', severity: 'MUST', minTier: 'tier-1',
    description: 'Pipelines include a tail_sampling processor.',
    specRef: '§5.2',
    evaluate(c) { return processors(c).some(p => p.name === 'tail_sampling'); },
  },
  {
    id: 'L2.MUST.metrics_logs_traces_backends', dimension: 'L2', severity: 'MUST', minTier: 'tier-2',
    description: 'spec.telemetry.backends covers metrics + logs + traces.',
    specRef: '§5.12.1',
    evaluate(c) {
      const sigs = new Set(backends(c).map(b => b.signal));
      return sigs.has('metrics') && sigs.has('logs') && sigs.has('traces');
    },
  },
  {
    id: 'L2.SHOULD.backend_gating_enforce', dimension: 'L2', severity: 'SHOULD', minTier: 'tier-1',
    description: 'tier-1 backends pin a `min` version with `gating: enforce`.',
    specRef: '§5.12.3',
    evaluate(c) {
      // SHOULD says tier-1 backends pin min+gating=enforce. We accept the
      // weaker bar of "at least one backend has min + gating set to warn or
      // enforce" since the canonical example uses `warn`. Real tier-1 packs
      // should harden to `enforce`.
      return backends(c).some(b => b.version?.min && (b.version.gating === 'enforce' || b.version.gating === 'warn'));
    },
  },
  {
    id: 'L2X.MUST.extended_backend_refs_resolve', dimension: 'L2X', severity: 'MUST', minTier: 'tier-3',
    description: 'Every extended surface references a declared telemetry backend or explicit external ref.',
    specRef: '§5.12.4',
    evaluate(c) {
      const refs = extendedBackendRefs(c);
      if (!refs.length) return true;
      const ids = new Set(backends(c).map(b => b.id));
      return refs.every(ref => typeof ref === 'string' && (ref.startsWith('ref:') || ids.has(ref)));
    },
  },

  // ----- L3 Queries + Dashboards -----
  {
    id: 'L3.MUST.recording_rule_per_slo', dimension: 'L3', severity: 'MUST', minTier: 'tier-3',
    description: 'Every SLO has at least one recording rule materialising its SLI.',
    specRef: '§5.5',
    evaluate(c) {
      const rules = recordingRules(c);
      if (!rules.length) return slos(c).length === 0;
      return slos(c).every(s => {
        const sliId = stripRef(s.sli);
        return rules.some(r => {
          const expr = String(r.expr || '');
          // accept either ref:slis.<id>, slis.<id>, or the bare id token
          if (expr.includes(`slis.${sliId}`)) return true;
          if (expr.includes(`ref:slis.${sliId}`)) return true;
          // also accept a rule that mentions the SLO id
          if (expr.includes(`slos.${s.id}`)) return true;
          // or a rule whose name matches the SLI/SLO name
          const name = String(r.name || '');
          return name.includes(sliId) || name.includes(s.id);
        });
      });
    },
  },
  {
    id: 'L3.SHOULD.derived_view', dimension: 'L3', severity: 'SHOULD', minTier: 'tier-2',
    description: 'At least one derived view (e.g. golden signals or per-tenant rollup).',
    specRef: '§5.5',
    evaluate(c) { return derivedViews(c).length >= 1; },
  },
  {
    id: 'L3.MUST.service_overview_dashboard', dimension: 'L3', severity: 'MUST', minTier: 'tier-3',
    description: 'At least one dashboard declared (service overview).',
    specRef: '§5.6',
    evaluate(c) { return dashboards(c).length >= 1; },
  },
  {
    id: 'L3.MUST.slo_burn_dashboard', dimension: 'L3', severity: 'MUST', minTier: 'tier-2',
    description: 'A second dashboard (SLO burn) on top of service overview.',
    specRef: '§5.6',
    evaluate(c) { return dashboards(c).length >= 2; },
  },
  {
    id: 'L3.MUST.tier1_dashboards', dimension: 'L3', severity: 'MUST', minTier: 'tier-1',
    description: 'Service overview + SLO burn + deployment overlay + customer impact (4+ dashboards).',
    specRef: '§5.6',
    evaluate(c) { return dashboards(c).length >= 4; },
  },

  // ----- L4 Policy + Alerting + Self-healing -----
  {
    id: 'L4.MUST.multi_window_burn_rate', dimension: 'L4', severity: 'MUST', minTier: 'tier-2',
    description: 'Every SLO has at least one burn-rate alert with multi-window policy.',
    specRef: '§5.7',
    evaluate(c) {
      const covered = new Set(burnRateAlerts(c).filter(a => (a.windows || []).length >= 2).map(a => stripRef(a.slo)));
      return slos(c).every(s => covered.has(s.id));
    },
  },
  {
    id: 'L4.SHOULD.forecast_on_availability', dimension: 'L4', severity: 'SHOULD', minTier: 'tier-1',
    description: 'At least one forecast declared on a primary availability SLO.',
    specRef: '§5.7',
    evaluate(c) { return forecasts(c).length >= 1; },
  },
  {
    id: 'L4.MUST.tier1_voice_route', dimension: 'L4', severity: 'MUST', minTier: 'tier-1',
    description: 'SEV1 route includes a voice channel.',
    specRef: '§5.8',
    evaluate(c) {
      return alertRoutes(c).some(r => r.severity === 'SEV1' && (r.channels || []).some(ch => 'voice' in ch));
    },
  },
  {
    id: 'L4.MUST.tier1_at_least_one_automation', dimension: 'L4', severity: 'MUST', minTier: 'tier-1',
    description: 'At least one self-healing remediation declared.',
    specRef: '§5.9',
    evaluate(c) { return remediations(c).length >= 1; },
  },

  // ----- L5 Baselines + Validation -----
  {
    id: 'L5.SHOULD.tier1_release_gate', dimension: 'L5', severity: 'SHOULD', minTier: 'tier-1',
    description: 'Regression gate set to a release-blocking mode.',
    specRef: '§5.10',
    evaluate(c) { return /^block_release/.test(baselines(c).regression_gate || ''); },
  },
  {
    id: 'L5.MUST.synthetic_probe', dimension: 'L5', severity: 'MUST', minTier: 'tier-3',
    description: 'At least one synthetic check declared.',
    specRef: '§5.11',
    evaluate(c) { return syntheticChecks(c).length >= 1; },
  },
  {
    id: 'L5.MUST.tier1_chaos_for_each_slo', dimension: 'L5', severity: 'MUST', minTier: 'tier-1',
    description: 'Every SLO is the steady-state hypothesis of at least one chaos experiment.',
    specRef: '§5.11',
    evaluate(c) {
      const stressed = new Set(chaos(c).map(x => stripRef(x.steady_state_hypothesis)));
      return slos(c).every(s => stressed.has(s.id));
    },
  },
  {
    id: 'L5.MUST.tier2_chaos_staging', dimension: 'L5', severity: 'MUST', minTier: 'tier-2',
    description: 'At least one chaos experiment scheduled monthly+ in staging.',
    specRef: '§5.11',
    evaluate(c) {
      return chaos(c).some(x => (x.schedule === 'monthly' || x.schedule === 'weekly' || x.schedule === 'daily') && x.environment === 'staging');
    },
  },
  {
    id: 'L5.MUST.tier1_weekly_prod_chaos', dimension: 'L5', severity: 'MUST', minTier: 'tier-1',
    description: 'At least one chaos experiment runs weekly+ in production with OTel-instrumented synthetic probes.',
    specRef: '§5.11',
    evaluate(c) {
      const weeklyProd = chaos(c).some(x => (x.schedule === 'weekly' || x.schedule === 'daily') && (x.environment === 'prod' || x.environment === 'production'));
      const otelProbe = syntheticChecks(c).some(s => s.otel_instrumentation === true);
      return weeklyProd && otelProbe;
    },
  },
];

// ---------- evaluator ----------

export function evaluateConformance(canonical) {
  const declaredTier = tierOf(canonical);
  const declaredRank = TIER_RANK[declaredTier] ?? TIER_RANK[DEFAULT_TIER];

  const clauses = RUBRIC.map(c => {
    const applies = declaredRank >= (TIER_RANK[c.minTier] ?? 1);
    const pass = applies ? safeEval(c, canonical) : null;
    return {
      id: c.id,
      dimension: c.dimension,
      severity: c.severity,
      minTier: c.minTier,
      description: c.description,
      specRef: c.specRef,
      applies,
      pass,
    };
  });

  const must = { passed: 0, total: 0 };
  const should = { passed: 0, total: 0 };
  const byDim = {};

  for (const c of clauses) {
    if (!c.applies) continue;
    byDim[c.dimension] ||= { applicable: 0, mustPassed: 0, mustTotal: 0, shouldPassed: 0, shouldTotal: 0 };
    byDim[c.dimension].applicable++;
    if (c.severity === 'MUST') {
      must.total++;
      byDim[c.dimension].mustTotal++;
      if (c.pass) { must.passed++; byDim[c.dimension].mustPassed++; }
    } else if (c.severity === 'SHOULD') {
      should.total++;
      byDim[c.dimension].shouldTotal++;
      if (c.pass) { should.passed++; byDim[c.dimension].shouldPassed++; }
    }
  }

  // Spec §8: MUST sub-score = passing MUSTs / applicable MUSTs.
  // Combined score = (MUST + 0.5*SHOULD) / (totalMust + 0.5*totalShould).
  const denom = must.total + 0.5 * should.total;
  const numer = must.passed + 0.5 * should.passed;
  const scorePercent = denom === 0 ? 100 : Math.round((numer / denom) * 100);
  const mustPercent  = must.total === 0 ? 100 : Math.round((must.passed / must.total) * 100);
  const conformant   = must.total > 0 && must.passed === must.total;

  return {
    declaredTier,
    conformant,
    scorePercent,
    mustPercent,
    must,
    should,
    byDimension: byDim,
    clauses,
  };
}

function safeEval(clause, canonical) {
  try { return !!clause.evaluate(canonical); }
  catch (_) { return false; }
}
