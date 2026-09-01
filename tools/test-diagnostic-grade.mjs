import {
  POSTURE_LAYERS,
  POSTURE_MECHANISMS_PER_LAYER,
  computeDiagnosticGrade,
  computeWeightedDeltaRisk,
  diagnosticAuditStatus,
  INSTRUMENT_GRADE_SCALE,
  instrumentGradeFor,
  partialLiveEvidence,
} from '../studio/diagnostic-grade.mjs';

function assert(condition, message, details) {
  if (!condition) {
    const suffix = details === undefined ? '' : `\n${JSON.stringify(details, null, 2)}`;
    throw new Error(`${message}${suffix}`);
  }
}

function closeTo(actual, expected, epsilon = 1e-9) {
  return Math.abs(actual - expected) <= epsilon;
}

function criterion(result, key) {
  return [...result.coverage.criteria, ...result.trust.criteria, ...result.operability.criteria]
    .find((item) => item.key === key);
}

function baseRepoPack() {
  return {
    id: 'krystaline',
    meta: {
      name: 'krystaline',
      annotations: {},
    },
    layers: {
      L1: [
        { id: 'SLI-latency', title: 'Latency SLI' },
        { id: 'SLO-latency', title: 'Latency SLO', spec: { objective: 0.99 } },
      ],
      L2: [
        {
          id: 'OTEL-node',
          title: 'OpenTelemetry SDK',
          spec: {
            signal: 'traces',
            sdk: { propagators: ['tracecontext'] },
            log_correlation: true,
          },
        },
        { id: 'MET-prometheus', title: 'Prometheus metrics', spec: { signal: 'metrics' } },
        { id: 'LOG-loki', title: 'Structured logs', spec: { signal: 'logs' } },
      ],
      L4: {
        healing: [{ id: 'HEAL-latency', title: 'Latency runbook' }],
      },
      L5: [
        { id: 'BASE-latency', title: 'MTTD/MTTR baseline' },
        { id: 'CHAOS-latency', title: 'Latency fault injection' },
      ],
    },
  };
}

function livePack(annotations = {}) {
  return {
    id: 'production-live',
    meta: {
      name: 'production-live',
      annotations,
    },
    layers: {
      L1: [{ id: 'LIVE-latency', source: 'Verified' }],
    },
  };
}

function fullPosture() {
  const cells = {};
  for (const layer of POSTURE_LAYERS) {
    for (const mechanism of POSTURE_MECHANISMS_PER_LAYER) {
      cells[`${layer.key}:${mechanism.key}`] = [
        { id: `${layer.key}-${mechanism.key}`, title: `${layer.label} ${mechanism.label}` },
      ];
    }
  }
  return { cells };
}

function traceabilityDiff(integrityMean) {
  const integrityPct = Math.round(integrityMean * 100);
  return {
    layers: {},
    traceabilityGraph: {
      rollup: {
        declaredTotal: 10,
        integrityMean,
        integrityPct,
        intact: Math.round(integrityMean * 10),
        partial: 10 - Math.round(integrityMean * 10),
        broken: 0,
        undeclared: 0,
      },
      branches: [{ confidence: 'derived' }],
    },
  };
}

const nowMs = Date.parse('2026-06-09T12:00:00Z');

{
  const exactlyEightyFive = diagnosticAuditStatus(6.8, 8);
  assert(exactlyEightyFive.status === 'FAIL', 'exactly 85% must fail because the gate is strictly >85%', exactlyEightyFive);
  assert(closeTo(exactlyEightyFive.scorePctExact, 85), '85% boundary score should be exact', exactlyEightyFive);

  const overEightyFive = diagnosticAuditStatus(6.81, 8);
  assert(overEightyFive.status === 'PASS', 'scores above 85% should pass', overEightyFive);
}

// Instrument-grade scale: the letter the score lands on. A is anchored
// strictly above the audit bar so the letter and PASS/FAIL never disagree.
{
  assert(instrumentGradeFor(0).letter === 'D', '0% is Consumer Grade');
  assert(instrumentGradeFor(37.4).letter === 'D', 'just under 37.5% stays Consumer Grade');
  assert(instrumentGradeFor(37.5).letter === 'C', '37.5% reaches Field Grade');
  assert(instrumentGradeFor(62.5).letter === 'B', '62.5% reaches Industrial Grade');
  assert(instrumentGradeFor(75).letter === 'B+', '75% reaches Inspection Grade');
  assert(instrumentGradeFor(85).letter === 'B+', 'exactly 85% is still Inspection Grade — A requires strictly more than the audit bar');
  assert(instrumentGradeFor(85.01).letter === 'A', 'above the audit bar is Diagnostic / Clinical Grade');
  assert(instrumentGradeFor(95).letter === 'A+', '95% reaches Laboratory / Research Grade');
  assert(instrumentGradeFor(100).letter === 'A+', 'a perfect verification score caps at A+ — A++ needs external reference evidence');
  const unreachable = INSTRUMENT_GRADE_SCALE.filter((g) => g.minPct === null).map((g) => g.letter);
  assert(unreachable.length === 1 && unreachable[0] === 'A++',
         'exactly A++ is not score-reachable (the metrology S rung was dropped as unpragmatic)', unreachable);
  assert(!INSTRUMENT_GRADE_SCALE.some((g) => g.letter === 'S'), 'no Primary Standard rung — absurd for an observability instrument');
  // The letter can never contradict the audit verdict.
  for (const pct of [0, 37.5, 62.5, 75, 84.9, 85, 85.01, 92, 95, 100]) {
    const passes = pct > 85;
    const letter = instrumentGradeFor(pct).letter;
    const aOrBetter = ['A', 'A+'].includes(letter);
    assert(passes === aOrBetter, `at ${pct}%: audit ${passes ? 'PASS' : 'FAIL'} must match grade ${letter}`, { pct, letter });
  }
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({ 'mcp.refreshedAt': '2026-06-09T11:00:00Z' }),
    fullPosture(),
    'production-live',
    traceabilityDiff(0.9),
    { nowMs },
  );

  assert(result.overall.audit.status === 'PASS', 'high traceability integrity plus fresh live evidence should pass', result.overall);
  assert(result.overall.verdict.word === 'Diagnostic-grade', 'passing verdict should be diagnostic-grade', result.overall.verdict);
  assert(result.gradeSchema === 2, 'grade schema 2: Actionable is informational operability', result.gradeSchema);
  assert(result.coverage.passed === 4 && result.coverage.total === 4, 'all four coverage clauses should pass (schema 2)', result.coverage);
  assert(result.overall.total === 7, 'overall total is 7 scored criteria (4 coverage + 3 trust)', result.overall);
  assert(closeTo(result.trust.passed, 2.9), 'trust score should include fractional drift fidelity', result.trust);
  assert(criterion(result, 'drift-free').pass === true, '0.90 traceability integrity should satisfy drift-free');
  assert(closeTo(criterion(result, 'drift-free').score, 0.9), 'drift-free score should equal integrity mean');
  assert(result.overall.instrumentGrade.letter === 'A+', '6.9/7 = 98.6% lands on Laboratory / Research Grade', result.overall.instrumentGrade);
  assert(result.operability.informational === true, 'operability section is marked informational', result.operability);
  assert(criterion(result, 'actionable')?.informational === true, 'actionable criterion carries the informational flag');
  assert(!result.coverage.criteria.some((c) => c.key === 'actionable'), 'actionable must not appear among scored coverage criteria');
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack(),
    fullPosture(),
    'production-live',
    traceabilityDiff(0.8),
    { nowMs },
  );

  assert(closeTo(result.overall.passed, 5.8), 'sub-threshold setup should score 5.8/7 (4 coverage + chaos 1 + drift 0.8, fresh fails)', result.overall);
  assert(result.overall.audit.scorePctExact < 85, 'sub-threshold score should land below the 85% gate', result.overall.audit);
  assert(result.overall.audit.status === 'FAIL', 'below 85% should not pass the diagnostic-grade audit', result.overall.audit);
  assert(result.overall.verdict.word === 'Almost diagnostic-grade', 'sub-threshold score in the 62.5–85% band reads almost diagnostic-grade', result.overall.verdict);
  assert(result.overall.instrumentGrade.letter === 'B+', '5.8/7 = 82.9% lands on Inspection Grade', result.overall.instrumentGrade);
  assert(criterion(result, 'fresh').pass === false, 'missing refreshedAt should fail freshness');
}

// The heart of grade schema 2: runbooks (Actionable) are observed and
// reported, but can NEVER move the diagnostic score in either direction.
{
  const withRunbook = baseRepoPack();
  const withoutRunbook = baseRepoPack();
  withoutRunbook.layers.L4 = {};

  const args = (packA) => [
    packA,
    livePack({ 'mcp.refreshedAt': '2026-06-09T11:00:00Z' }),
    fullPosture(),
    'production-live',
    traceabilityDiff(0.9),
    { nowMs },
  ];
  const a = computeDiagnosticGrade(...args(withRunbook));
  const b = computeDiagnosticGrade(...args(withoutRunbook));

  assert(criterion(a, 'actionable').pass === true, 'runbook declared should observe actionable = yes');
  assert(criterion(b, 'actionable').pass === false, 'no runbook should observe actionable = no');
  assert(closeTo(a.overall.passed, b.overall.passed), 'removing every runbook must not change the diagnostic score', { with: a.overall, without: b.overall });
  assert(a.overall.total === b.overall.total, 'scored criterion count is independent of runbooks');
  assert(a.overall.audit.status === b.overall.audit.status, 'PASS/FAIL must be independent of runbooks');
}

{
  const weighted = computeWeightedDeltaRisk({
    mode: 'drift',
    aligned: 10,
    driftedEntries: [
      { deltas: [{ field: 'expr' }] },
      { deltas: [{ field: 'title' }] },
      { deltas: [{ field: 'unknown_field' }] },
      { a: { source: 'Scaffold' }, deltas: [{ field: 'expr' }] },
    ],
    onlyInA: 2,
    onlyInB: 4,
  });

  assert(weighted.driftedBreakdown.decision === 1, 'decision-bearing drift should be counted separately', weighted);
  assert(weighted.driftedBreakdown.cosmetic === 1, 'cosmetic drift should be counted separately', weighted);
  assert(weighted.driftedBreakdown.default === 1, 'default drift should be counted separately', weighted);
  assert(closeTo(weighted.driftedUnits, 1.6), 'drifted badness should apply 1.0 + 0.1 + 0.5 weights', weighted);
  assert(closeTo(weighted.onlyInAUnits, 2), 'declared-not-live should carry 1.0 weight in drift mode', weighted);
  assert(closeTo(weighted.onlyInBUnits, 0.6), 'live-not-declared should carry 0.15 weight in drift mode', weighted);
  assert(closeTo(weighted.totalBadness, 4.2), 'total weighted badness should exclude scaffold entries', weighted);
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'a,b,c,d,e,f,g,h,i,j',
      'mcp.probesSucceeded': 'a,b,c,d,e,f,g',
      'mcp.probesEmpty': 'h,i',
      'mcp.probesFailed': 'j',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );

  assert(criterion(result, 'drift-free').pass === true, '30% empty/failed probes should still pass fallback drift tolerance');
  assert(closeTo(criterion(result, 'drift-free').score, 0.7), 'probe fallback should award 1 - drift ratio');
}

{
  const result = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'a,b,c,d,e,f,g,h,i,j',
      'mcp.probesSucceeded': 'a,b,c,d,e,f',
      'mcp.probesEmpty': 'g,h',
      'mcp.probesFailed': 'i,j',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );

  assert(criterion(result, 'drift-free').pass === false, '40% empty/failed probes should fail fallback drift tolerance');
  assert(closeTo(criterion(result, 'drift-free').score, 0.6), 'failed probe fallback should still award fractional evidence credit');
}

// Partial live evidence — a live draft that lost probes to 503s must be
// flagged so a thin Pack B can't masquerade as massive drift.
{
  const liveDraft = (extra) => ({ meta: { annotations: {
    'mcp.url': 'https://example.test/mcp',
    'mcp.probesAttempted': 'metrics,recording_rules,alert_rules,dashboards,routes',
    'mcp.probesSucceeded': 'dashboards,routes',
    ...extra,
  } } });

  const partial = partialLiveEvidence(liveDraft({ 'mcp.probesFailed': 'metrics,recording_rules,alert_rules' }));
  assert(partial.partial === true, 'failed probes on a live draft mark the evidence PARTIAL', partial);
  assert(partial.failed.length === 3 && partial.attempted.length === 5, 'failed/attempted probe lists parse from annotations', partial);

  const emptyOnly = partialLiveEvidence(liveDraft({ 'mcp.probesEmpty': 'metrics' }));
  assert(emptyOnly.partial === false, 'empty probes are honest zeros, NOT partial evidence', emptyOnly);

  const clean = partialLiveEvidence(liveDraft({}));
  assert(clean.partial === false, 'a clean live draft is not partial', clean);

  const filePack = partialLiveEvidence({ meta: { annotations: { 'mcp.probesFailed': 'x' } } });
  assert(filePack.partial === false, 'non-live packs (no mcp.url) never claim partial live evidence', filePack);

  assert(partialLiveEvidence(null).partial === false, 'null pack is handled');
}

// ---------- prettyDiffKey (studio/artifact-model.mjs) ----------
// The studio's display renderer for behavioural identity keys. One case
// per identity shape in tools/lib/artefact-model.mjs's IDENTITY table,
// plus ordinals, singletons, and the legacy `family:<name>` keyspace.
{
  const { prettyDiffKey } = await import('../studio/artifact-model.mjs');
  const cases = [
    ['sli::{"id":"checkout_availability"}', 'checkout_availability'],
    ['recording_rule::{"record":"slo:checkout:ratio"}', 'slo:checkout:ratio'],
    ['burn_rate::{"slo":"api_99"}', 'burn-rate alert: api_99'],
    ['forecast::{"slo":"api_99"}', 'forecast alert: api_99'],
    ['alert_route::{"severity":"sev1"}', 'SEV1 route'],
    ['alert_route::{"severity":"sev1"}#02', 'SEV1 route#02'],
    ['backend::{"product":"prometheus","signal":"metrics"}', 'prometheus · metrics'],
    ['storage_metrics::{"backend":"prometheus","signal":"metrics"}', 'metrics storage: prometheus'],
    ['mesh::{"product":"envoy","role":"proxy"}', 'envoy · proxy'],
    ['profiling::{"product":"pyroscope"}', 'pyroscope'],
    ['pipeline_exporter_metrics::{"signal":"metrics","target":"prometheusremotewrite"}', 'metrics: prometheusremotewrite'],
    ['scrape_job::{"job":"node"}', 'node'],
    ['metric::{"name":"http_requests_total"}', 'http_requests_total'],
    ['imports::{"ref":"stdlib/base"}', 'stdlib/base'],
    ['remediation::{"trigger":"disk_pressure"}', 'on disk_pressure'],
    ['otel::{}', 'otel::{}'],                    // singleton — whole key beats bare braces
    ['recording_rule:legacy_name', 'legacy_name'], // pre-behavioural keyspace still readable
    ['', ''],
  ];
  for (const [key, want] of cases) {
    const got = prettyDiffKey(key);
    assert(got === want, `prettyDiffKey(${JSON.stringify(key)}) renders ${JSON.stringify(want)}`, got);
  }
}

// ---------- the vendoring seam (docs/VENDORING.md) ----------
// Downstream studios vendor these files verbatim; an import creeping in
// breaks their build, not ours — so CI holds the line here.
{
  const { readFileSync } = await import('node:fs');
  for (const f of ['studio/diagnostic-grade.mjs', 'studio/artifact-model.mjs']) {
    const src = readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
    if (/^\s*import\s/m.test(src)) {
      throw new Error(`${f} must stay zero-import — it is vendored verbatim by downstream studios (docs/VENDORING.md)`);
    }
  }
}

console.log('all diagnostic-grade assertions pass.');
