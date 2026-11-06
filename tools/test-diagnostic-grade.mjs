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
  assert(result.gradeSchema === 3, 'grade schema 3 (schema 2 made Actionable informational operability)', result.gradeSchema);
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

  // Additive keys: unsupported families, per-family errors, vantage.
  assert(clean.vantage === 'full' && clean.unsupported.length === 0 && Object.keys(clean.errors).length === 0,
         'a clean live draft has vantage full, no unsupported families, no errors', clean);
  assert(partial.vantage === 'partial', 'failed probes give vantage partial', partial.vantage);
  assert(emptyOnly.vantage === 'full', 'empty probes do not degrade the vantage', emptyOnly.vantage);
  assert(filePack.vantage === 'none', 'non-live packs have vantage none', filePack.vantage);
  assert(partialLiveEvidence(null).vantage === 'none', 'null pack has vantage none');

  const restricted = partialLiveEvidence(liveDraft({ 'mcp.probesUnsupported': 'metrics,routes' }));
  assert(restricted.vantage === 'restricted' && restricted.partial === false,
         'unsupported families without failures give vantage restricted and do NOT mark the evidence partial', restricted);
  assert(restricted.unsupported.join(',') === 'metrics,routes', 'unsupported families parse from mcp.probesUnsupported', restricted.unsupported);

  const mixed = partialLiveEvidence(liveDraft({
    'mcp.probesFailed': 'metrics',
    'mcp.probesUnsupported': 'routes',
    'mcp.probeErrors.metrics': 'HTTP 503 Service Unavailable',
  }));
  assert(mixed.vantage === 'partial' && mixed.partial === true,
         'a failure outranks an unsupported family: vantage partial', mixed);
  assert(mixed.errors.metrics === 'HTTP 503 Service Unavailable' && Object.keys(mixed.errors).length === 1,
         'per-family errors are read from mcp.probeErrors.<family>', mixed.errors);

  const lost = partialLiveEvidence(liveDraft({
    'mcp.probesAttempted': 'metrics,routes,dashboards',
    'mcp.probesFailed': 'metrics,routes',
    'mcp.probesUnsupported': 'dashboards',
  }));
  assert(lost.vantage === 'lost' && lost.partial === true,
         'every attempted family failed or unsupported gives vantage lost', lost);

  const allUnsupported = partialLiveEvidence(liveDraft({
    'mcp.probesAttempted': 'metrics,routes',
    'mcp.probesUnsupported': 'metrics,routes',
  }));
  assert(allUnsupported.vantage === 'lost' && allUnsupported.partial === false,
         'an MCP that exposes none of the probed families is lost, yet not partial (nothing failed)', allUnsupported);

  const nothingAttempted = partialLiveEvidence({ meta: { annotations: { 'mcp.url': 'https://example.test/mcp' } } });
  assert(nothingAttempted.vantage === 'full', 'a live draft without probe annotations (older pack) reads full, not lost', nothingAttempted);
}

// Fresh names the vantage: a refresh whose every probe family failed is
// still a refresh (pass stays a staleness test), but the detail must not
// read as a fresh look at production.
{
  const lost = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.url': 'https://example.test/mcp',
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'recording_rules,alert_rules,dashboards',
      'mcp.probesFailed': 'recording_rules,alert_rules',
      'mcp.probesUnsupported': 'dashboards',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );
  const freshLost = criterion(lost, 'fresh');
  assert(freshLost.pass === true, 'fresh pass/fail stays a staleness test (scoring unchanged)', freshLost);
  assert(/vantage lost/.test(freshLost.detail) && /failed: recording_rules, alert_rules/.test(freshLost.detail)
         && /not exposed: dashboards/.test(freshLost.detail),
         'fresh detail says the vantage was lost and names the failed / not-exposed families', freshLost.detail);

  const partial = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({
      'mcp.url': 'https://example.test/mcp',
      'mcp.refreshedAt': '2026-06-09T11:00:00Z',
      'mcp.probesAttempted': 'recording_rules,alert_rules,dashboards',
      'mcp.probesSucceeded': 'recording_rules,alert_rules',
      'mcp.probesFailed': 'dashboards',
    }),
    fullPosture(),
    'production-live',
    null,
    { nowMs },
  );
  const freshPartial = criterion(partial, 'fresh');
  assert(freshPartial.pass === true && /vantage partial: failed dashboards/.test(freshPartial.detail),
         'fresh detail names a partial vantage and its failed families', freshPartial.detail);

  const full = computeDiagnosticGrade(
    baseRepoPack(),
    livePack({ 'mcp.url': 'https://example.test/mcp', 'mcp.refreshedAt': '2026-06-09T11:00:00Z', 'mcp.probesAttempted': 'a', 'mcp.probesSucceeded': 'a' }),
    fullPosture(), 'production-live', null, { nowMs },
  );
  assert(!/vantage/.test(criterion(full, 'fresh').detail), 'a full vantage adds nothing to the fresh detail', criterion(full, 'fresh').detail);
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

// ---------- every adapter family has a kind, or says it has none ----------
// Before 2026-11-04 the classifier knew ten families: a declared metric, a
// scrape job, an alert rule or a dashboard panel had no kind and was left
// off the posture matrix without a word, so the Overview board's layers
// counted 91 of a pack's 600 artefacts.
{
  const { MECHANISM_BY_ID_PREFIX, classifyArtefactMechanism, computePostureMatrix, layerItemsFor } = await import('../studio/diagnostic-grade.mjs');
  const { ID_RULES } = await import('../tools/lib/artefact-classify.mjs');
  // The engine is zero-import, so it keeps its own table: the same families as the adapter's.
  const ours = MECHANISM_BY_ID_PREFIX.map(([p]) => p);
  const theirs = ID_RULES.map(([p]) => p);
  assert(JSON.stringify([...ours].sort()) === JSON.stringify([...theirs].sort()), 'MECHANISM_BY_ID_PREFIX names exactly the families of artefact-classify ID_RULES', { onlyOurs: ours.filter((p) => !theirs.includes(p)), onlyTheirs: theirs.filter((p) => !ours.includes(p)) });
  for (let i = 0; i < ours.length; i++) for (let j = i + 1; j < ours.length; j++) {
    assert(!ours[j].startsWith(ours[i]), `${ours[i]} comes after ${ours[j]}, which it contains — the longer prefix first`);
  }
  const kinds = new Set(POSTURE_MECHANISMS_PER_LAYER.map((m) => m.key));
  for (const [p, mech] of MECHANISM_BY_ID_PREFIX) assert(mech === null || mech === 'by-signal' || mech === 'scrape' || kinds.has(mech), `${p} maps to a kind the matrix draws`, mech);
  const cases = [
    [{ id: 'SLI-01' }, 'sli'], [{ id: 'SLO-01' }, 'slo'],
    [{ id: 'METRIC-SRC-01', title: 'http_requests_total' }, 'metric'], [{ id: 'METRIC-FAM-01' }, 'metric'], [{ id: 'METRIC-01' }, 'metric'],
    [{ id: 'SCRAPE-SRC-01', title: 'node-exporter' }, 'metric'], [{ id: 'SCRAPE-01', title: 'scrape: promtail' }, 'log'],
    [{ id: 'PIP-EXP-MET' }, 'metric'], [{ id: 'PIP-EXP-LOG' }, 'log'], [{ id: 'PIP-EXP-TRC' }, 'trace'], [{ id: 'PIP-RCV-01', title: 'receiver: otlp' }, null],
    [{ id: 'STO-TRC-01' }, 'trace'], [{ id: 'QRY-01' }, 'metric'], [{ id: 'VIEW-01' }, 'metric'],
    [{ id: 'DASH-01' }, 'dashboard'], [{ id: 'PANEL-01', title: 'rca_failure_ratio' }, 'dashboard'],
    [{ id: 'POL-01' }, 'alert'], [{ id: 'FCST-01' }, 'alert'], [{ id: 'RULE-01', title: 'HighErrorRate' }, 'alert'], [{ id: 'ALR-01', title: 'SEV2 routes' }, null],
    [{ id: 'HEAL-01' }, 'runbook'], [{ id: 'CHAOS-01' }, 'chaos'], [{ id: 'SYN-01' }, 'synthetic'],
    [{ id: 'BAK-01', spec: { signal: 'metrics' } }, 'metric'], [{ id: 'BAK-02', signal: 'logs' }, 'log'], [{ id: 'BAK-03', spec: { signal: 'alerting' } }, null],
    [{ id: 'OTEL-01' }, null], [{ id: 'BASE-01' }, null], [{ id: 'MESH-01' }, null], [{ id: 'IMP-01' }, null], [{ id: 'X-01' }, null], [{}, null], [null, null],
  ];
  for (const [art, want] of cases) {
    const got = classifyArtefactMechanism(art);
    assert(got === want, `classifyArtefactMechanism(${JSON.stringify(art)}) is ${want}`, got);
  }
  // The matrix places every artefact it walks exactly once — in one cell, or in `unkinded` — and a
  // backend it repeats on the application layer as its signal is marked, so a count takes it once.
  const pack = {
    meta: { annotations: { 'mcp.discovered.scrape_jobs': 'node-exporter' } },
    layers: {
      L1: [{ id: 'SLI-01', title: 'kx_wallet_availability' }],
      L2: [{ id: 'BAK-01', title: 'metrics-prometheus node-exporter', spec: { signal: 'metrics' } }, { id: 'BAK-02', title: 'alerting-alertmanager', spec: { signal: 'alerting' } }, { id: 'METRIC-01', title: 'node_cpu_seconds_total' }, { id: 'METRIC-02', title: 'widgets' }, { id: 'SCRAPE-01', title: 'scrape: promtail' }, { id: 'OTEL-01' }],
      L3: [{ id: 'DASH-01', title: 'k8s cluster' }, { id: 'PANEL-01', title: 'pod_restarts' }],
      L4: { alerting: [{ id: 'RULE-01', title: 'api_error_ratio_high' }, { id: 'RULE-02', title: 'HighErrorRate' }, { id: 'ALR-01', title: 'SEV2 routes' }] },
      L5: [{ id: 'BASE-01', title: 'MTTD / MTTR baselines' }],
    },
  };
  const { cells, unkinded } = computePostureMatrix(pack, null);
  const walked = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'].flatMap((L) => layerItemsFor(pack, L)).map((a) => a.id);
  const counted = Object.values(cells).flat().filter((a) => !a._evidence && !a._propagated).map((a) => a.id);
  const listed = unkinded.map((a) => a.id);
  assert(JSON.stringify([...counted, ...listed].sort()) === JSON.stringify([...walked].sort()), 'every walked artefact is counted once: in a cell or in unkinded', { counted, listed, walked });
  assert(JSON.stringify(listed.sort()) === JSON.stringify(['ALR-01', 'BAK-02', 'BASE-01', 'OTEL-01']), 'unkinded: the alert route, the alerting backend, baselines, the SDK', listed);
  assert(cells['infra:metric'].some((a) => a.id === 'BAK-01' && !a._propagated) && cells['app:metric'].some((a) => a.id === 'BAK-01' && a._propagated), 'the backend in its own cell, and on app as its signal, marked');
  assert(cells['app:alert']?.some((a) => a.id === 'RULE-01') && cells['unknown:alert']?.some((a) => a.id === 'RULE-02'), 'an alert rule is an alert: on the layer its name says (api_error_ratio_high: app), else unplaced (HighErrorRate)', cells);
  assert(cells['infra:dashboard']?.some((a) => a.id === 'PANEL-01'), 'a panel is a dashboard view, on its own layer', cells);
  assert(cells['unknown:metric']?.some((a) => a.id === 'METRIC-02'), 'a metric whose name says no layer is unplaced, not dropped', cells);
}

// ---------- the layer an artefact's name does not say ----------
// Before 2026-11-04 an artefact whose own name carries no layer word was
// unplaced: on the demo pack 215 of 600, panels titled rca_failure_ratio,
// alert rules named HighErrorRate, metrics named ALERTS. Each step only
// fills what the steps before left, so nothing placed by name moves.
{
  const { resolveArtefactLayers, computePostureMatrix } = await import('../studio/diagnostic-grade.mjs');
  const pack = {
    meta: { annotations: { 'layer.PANEL-E': 'ux' } },
    layers: {
      L1: [{ id: 'SLO-01', title: 'kx_wallet_availability', defines: 'slos.wallet' }],
      L2: [
        { id: 'METRIC-SRC-01', title: 'widgets_total', spec: { name: 'widgets_total', used_by: ['dashboard:d1/widgets'] } },
        { id: 'METRIC-01', title: 'gizmos_total', spec: { name: 'gizmos_total' } },
        { id: 'METRIC-02', title: 'thingies_total', spec: { name: 'thingies_total' } },
        { id: 'SCRAPE-SRC-01', title: 'gizmo-svc', spec: { job: 'gizmo-svc', exports: ['gizmos_total'] } },
        { id: 'SCRAPE-01', title: 'scrape: gizmo-svc', spec: { job: 'gizmo-svc' } },
      ],
      L3: [
        { id: 'DASH-01', title: 'k8s cluster', defines: 'dashboards.d1' },
        { id: 'PANEL-A', title: 'rca', parent: 'dashboards.d1' },
        { id: 'PANEL-B', title: 'traffic', parent: 'dashboards.d1', spec: { expr: 'sum(rate(http_requests_total{pod_name="x", job="node-exporter"}[5m])) by (pod_name, container_id)' } },
        { id: 'PANEL-C', title: 'node_load', parent: 'dashboards.d2' },
        { id: 'PANEL-D', title: 'mixed', parent: 'dashboards.d1', spec: { expr: 'node_cpu_seconds_total + http_requests_total' } },
        { id: 'PANEL-E', title: 'pod_restarts', parent: 'dashboards.d1' },
        { id: 'PANEL-F', title: 'orphan' },
      ],
      L4: {
        policy: [{ id: 'POL-01', title: 'burn-rate alert: wallet', refs: ['slos.wallet'] }],
        alerting: [
          { id: 'RULE-01', title: 'GizmoStorm', spec: { expr: 'rate(gizmos_total[5m]) > 1 and on(instance) http_requests_total > 0' } },
          { id: 'RULE-02', title: 'ThingiesApp', spec: { expr: 'http_requests_total > 0 unless thingies_total' } },
          { id: 'RULE-03', title: 'ThingiesNode', spec: { expr: 'node_cpu_seconds_total > 0 unless thingies_total' } },
        ],
      },
    },
  };
  const r = resolveArtefactLayers(pack);
  const got = (id) => { const v = r.get(id); return v ? `${v.layer}/${v.how}` : 'missing'; };
  for (const [id, want, why] of [
    ['DASH-01', 'infra/name', 'placed by its own name, as before'],
    ['PANEL-C', 'infra/name', 'its own name wins over anything inherited'],
    ['PANEL-E', 'ux/name', 'the annotation override wins over its name and its dashboard'],
    ['PANEL-B', 'app/query', 'its own query (label matchers, strings and by-labels dropped) before its dashboard'],
    ['PANEL-D', 'infra/parent', 'a query that names two layers once each is a tie: its dashboard decides'],
    ['PANEL-A', 'infra/parent', 'a panel takes its dashboard’s layer'],
    ['POL-01', 'app/parent', 'a burn-rate alert takes its objective’s layer'],
    ['METRIC-SRC-01', 'infra/parent', 'a declared metric takes its dashboards’ layer (spec.used_by)'],
    ['RULE-01', 'app/query', 'an alert rule by the metrics it reads'],
    ['METRIC-01', 'app/readers', 'a metric takes the layer of what reads it'],
    ['METRIC-02', 'null/null', 'read on two layers once each: a tie, unplaced'],
    ['SCRAPE-SRC-01', 'app/exports', 'a scrape job by the metrics it exports'],
    ['SCRAPE-01', 'app/exports', 'a live job by the declared job of its name'],
    ['PANEL-F', 'null/null', 'nothing to go by: unplaced'],
  ]) assert(got(id) === want, `${id}: ${why}`, { got: got(id), want });
  const { cells } = computePostureMatrix(pack, null);
  assert(cells['infra:dashboard']?.some((a) => a.id === 'PANEL-A') && cells['app:alert']?.some((a) => a.id === 'POL-01') && cells['unknown:metric']?.some((a) => a.id === 'METRIC-02'), 'the matrix places by the resolved layer', cells);
}

// ---------- grade schema 3: scaffolds earn nothing (2026-11-06) ----------
// An audit of krystaline · prod (B at 69.8%) found two passes nobody earned:
// Calibrated on the MTTD/MTTR baselines the repository scan always writes
// (crawler.scaffold.baselines), and Chaos-validated on a library experiment
// still on its generic fault. Each scaffold now earns nothing, and the
// chaos sentences say what each side could see, never that recovery is
// unproven or proven.
{
  const { computePostureMatrix } = await import('../studio/diagnostic-grade.mjs');
  const grade = (packA, packB = livePack({ 'mcp.refreshedAt': '2026-06-09T11:00:00Z' })) =>
    computeDiagnosticGrade(packA, packB, fullPosture(), 'production-live', traceabilityDiff(0.9), { nowMs });
  const withL5 = (L5, annotations = {}) => { const p = baseRepoPack(); p.layers.L5 = L5; p.meta.annotations = annotations; return p; };
  const REAL_BASE = { id: 'BASE-latency', title: 'MTTD/MTTR baseline' };
  const SCAFFOLD_BASE = { id: 'BASE-01', title: 'MTTD / MTTR baselines', source: 'Scaffold' };
  const REAL_CHAOS = { id: 'CHAOS-01', title: 'pod-kill', spec: { target: 'deployment/orders' } };
  const SCAFFOLD_CHAOS = { id: 'CHAOS-02', title: 'generic-latency', source: 'Scaffold', spec: { target: 'orders' } };

  // 1. Calibrated: a scaffold baseline is no baseline.
  const scaffoldOnly = grade(withL5([SCAFFOLD_BASE, REAL_CHAOS]));
  const cal = criterion(scaffoldOnly, 'calibrated');
  assert(scaffoldOnly.gradeSchema === 3, 'grade schema 3: scaffolds earn nothing', scaffoldOnly.gradeSchema);
  assert(cal.pass === false, 'the scan\'s default baselines (a scaffold) do not make a pack Calibrated', cal);
  assert(cal.detail === 'no MTTD/MTTR baselines declared - the one present is a scaffold (defaults, never measured)', 'Calibrated says the baselines present are a scaffold', cal.detail);
  assert(JSON.stringify(cal.baselines) === JSON.stringify({ declared: 0, scaffolds: 1 }), 'Calibrated counts the scaffold apart', cal.baselines);
  const realBase = criterion(grade(withL5([REAL_BASE, SCAFFOLD_BASE, REAL_CHAOS])), 'calibrated');
  assert(realBase.pass === true && /^MTTD\/MTTR baselines \+ 1 SLO with explicit objective$/.test(realBase.detail), 'a declared baseline still passes beside a scaffold', realBase);
  assert(criterion(grade(withL5([REAL_CHAOS])), 'calibrated').detail === 'no MTTD/MTTR baselines declared', 'no baseline at all: the detail is as before');
  // The score moves by exactly one criterion: 6.9 → 5.9 of 7, A+ → B+.
  const before = grade(withL5([REAL_BASE, REAL_CHAOS]));
  assert(closeTo(before.overall.passed - scaffoldOnly.overall.passed, 1), 'scaffold baselines cost exactly the Calibrated point', [before.overall.passed, scaffoldOnly.overall.passed]);
  assert(computePostureMatrix(withL5([SCAFFOLD_BASE]), null).platformWide.baselines === false && computePostureMatrix(withL5([REAL_BASE]), null).platformWide.baselines === true,
    'the posture\'s pack-level baselines row ignores the scaffold too');

  // 2. Chaos-validated: a scaffold experiment is no experiment.
  const scaffoldChaos = criterion(grade(withL5([REAL_BASE, SCAFFOLD_CHAOS])), 'chaos-validated');
  assert(scaffoldChaos.pass === false && scaffoldChaos.declared === 0 && scaffoldChaos.scaffolds === 1, 'a library.todo chaos experiment does not make a pack Chaos-validated', scaffoldChaos);
  assert(scaffoldChaos.detail === 'no chaos experiment declared in this pack; 1 scaffold excluded', 'the scaffold is named as excluded', scaffoldChaos.detail);
  assert(scaffoldChaos.sub === 'fault-injection experiments declared', 'the criterion says what it reads: a declaration, not a proof', scaffoldChaos.sub);
  const oneChaos = criterion(grade(withL5([REAL_BASE, REAL_CHAOS, SCAFFOLD_CHAOS])), 'chaos-validated');
  assert(oneChaos.pass === true && oneChaos.detail === '1 chaos experiment declared; none has a recorded result; 1 scaffold excluded', 'a pass says declared, and that no result is recorded (the spec has no results field)', oneChaos.detail);
  const twoChaos = criterion(grade(withL5([REAL_BASE, REAL_CHAOS, { ...REAL_CHAOS, id: 'CHAOS-03' }])), 'chaos-validated');
  assert(twoChaos.detail === '2 chaos experiments declared; none has a recorded result', 'the plural, no scaffold note', twoChaos.detail);

  // 3. The failure says what each side could see, from the two stamps.
  const fromScan = { 'crawler.discoveredAt': '2026-11-06T00:00:00Z', 'crawler.unobserved.chaos': 'the repository scan has no chaos-experiment detector' };
  const liveBlind = livePack({ 'mcp.refreshedAt': '2026-06-09T11:00:00Z', 'mcp.url': 'https://mcp.example/mcp', 'observogram.unobserved.chaos': 'no MCP tool exposes chaos experiments' });
  const both = criterion(grade(withL5([REAL_BASE], fromScan), liveBlind), 'chaos-validated');
  assert(both.detail === 'no chaos experiment declared - the repository scan cannot detect chaos tooling and the live side cannot observe it', 'both stamps: both sides named', both.detail);
  assert(both.unobserved.repository === 'the repository scan has no chaos-experiment detector' && both.unobserved.live === 'no MCP tool exposes chaos experiments' && both.fromScan === true, 'the reasons ride on the criterion', both);
  assert(criterion(grade(withL5([REAL_BASE], fromScan)), 'chaos-validated').detail === 'no chaos experiment declared - the repository scan cannot detect chaos tooling', 'repository stamp only');
  const liveOnly = criterion(grade(withL5([REAL_BASE]), liveBlind), 'chaos-validated');
  assert(liveOnly.detail === 'no chaos experiment declared - the live side cannot observe it' && liveOnly.fromScan === false, 'live stamp only; a pack the scan did not write', liveOnly);
  const livePackAlone = criterion(grade(withL5([REAL_BASE], { 'observogram.unobserved.chaos': 'no MCP tool exposes chaos experiments' }), null), 'chaos-validated');
  assert(livePackAlone.detail === 'no chaos experiment declared - the live side cannot observe it', 'a live pack graded alone carries the live stamp on its own meta', livePackAlone.detail);
  for (const c of [both, liveOnly, scaffoldChaos, oneChaos]) {
    assert(!/proven|theoretical|never been/i.test(`${c.sub} ${c.detail}`), 'no chaos sentence claims recovery was, or was not, proven', c);
  }
}

// ---------- Comprehensive: a chaos experiment's layer is its target's ----------
// The chaos row of the posture matrix took its layer from the experiment's
// id and title, so four experiments named after the four layers lit chaos
// on every layer, whatever they injected into: Comprehensive (and with it
// the letter) moved on names alone. The layer is now the target's, else the
// steady-state hypothesis' SLO's, else none.
{
  const { computePostureMatrix, resolveArtefactLayers, classifyArtefactLayer } = await import('../studio/diagnostic-grade.mjs');
  const chaos = (id, title, spec) => ({ id, title, spec });
  const pack = {
    meta: { annotations: { 'layer.CHAOS-06': 'ux' } },
    layers: {
      L1: [{ id: 'SLO-01', title: 'kx_wallet_availability', defines: 'slos.wallet' }],
      L5: [
        // Named after the four layers, all faulting one application deployment.
        chaos('CHAOS-01', 'k8s-node-disk-pressure', { target: 'deployment/orders-api', steady_state_hypothesis: 'slos.wallet' }),
        chaos('CHAOS-02', 'kafka-broker-loss', { target: 'deployment/orders-api', steady_state_hypothesis: 'slos.wallet' }),
        chaos('CHAOS-03', 'http-latency', { target: 'deployment/orders-api', steady_state_hypothesis: 'slos.wallet' }),
        chaos('CHAOS-04', 'journey-checkout-fault', { target: 'deployment/orders-api', steady_state_hypothesis: 'slos.wallet' }),
        // The target names the layer.
        chaos('CHAOS-05', 'broker-kill', { target: 'statefulset/kafka', steady_state_hypothesis: 'slos.wallet' }),
        // The annotation override still wins.
        chaos('CHAOS-06', 'node-drain', { target: 'deployment/orders-api' }),
        // Neither a target word nor a resolvable SLO: unplaced, never guessed from the name.
        chaos('CHAOS-07', 'k8s-node-reboot', { target: 'orders', steady_state_hypothesis: 'nope' }),
        // A bare hypothesis id names an SLO too.
        chaos('CHAOS-08', 'redis-flush', { target: 'orders', steady_state_hypothesis: 'wallet' }),
      ],
    },
  };
  const r = resolveArtefactLayers(pack);
  const got = (id) => `${r.get(id)?.layer ?? null}/${r.get(id)?.how ?? null}`;
  for (const [id, want, why] of [
    ['CHAOS-01', 'app/parent', 'named node-…, faults an app deployment: its SLO\'s layer (no target word)'],
    ['CHAOS-02', 'app/parent', 'named kafka-…: not platform'],
    ['CHAOS-03', 'app/parent', 'named http-…'],
    ['CHAOS-04', 'app/parent', 'named journey-…: not ux'],
    ['CHAOS-05', 'platform/name', 'its target names the layer (kafka)'],
    ['CHAOS-06', 'ux/name', 'the annotation override wins'],
    ['CHAOS-07', 'null/null', 'no target word, no SLO: unplaced, whatever its name says'],
    ['CHAOS-08', 'app/parent', 'a bare hypothesis id resolves to slos.<id>'],
  ]) assert(got(id) === want, `${id}: ${why}`, { got: got(id), want });
  assert(classifyArtefactLayer({ id: 'CHAOS-09', title: 'node kafka http journey' }, pack) === null, 'the classifier never reads a chaos experiment\'s name');
  const { cells } = computePostureMatrix(pack, null);
  const chaosLayers = ['infra', 'platform', 'app', 'ux'].filter((l) => cells[`${l}:chaos`]?.length);
  assert(JSON.stringify(chaosLayers) === JSON.stringify(['platform', 'app', 'ux']), 'four experiments named after the layers light one row, not four', { chaosLayers, cells: Object.keys(cells) });
  assert(!cells['infra:chaos'], 'no experiment faults infrastructure, so infra has no chaos', cells['infra:chaos']);
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
