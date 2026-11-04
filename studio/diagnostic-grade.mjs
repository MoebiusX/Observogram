// Pure diagnostic-grade scoring for the Diagnose view.
//
// Keep this module DOM-free so the clinical verdict can be unit-tested
// directly (and computed headlessly by the CLI journey runner).
// compare-view.mjs is responsible for rendering only.
//
// ZERO-DEPENDENCY on purpose: downstream studios vendor this file verbatim
// (docs/VENDORING.md), so it must import nothing.

// The spec's fixed L4 sub-taxonomy. Inlined copy of L4_SUBGROUPS in
// constants.mjs (the studio's display copy) — a stable 3-item vocabulary;
// keep the two in sync.
const L4_SUBGROUPS = [
  { key: 'policy',   label: 'Policy' },
  { key: 'alerting', label: 'Alerting' },
  { key: 'healing',  label: 'Self-healing' },
];

// Flatten a layered pack's artefacts for one layer (L4's policy/alerting/
// healing subgroups are merged, tagged with _sub). Shared by the posture
// matrix below and several compare-view consumers.
export function layerItemsFor(pack, L) {
  if (!pack?.layers) return [];
  if (L === 'L4') {
    const L4 = pack.layers.L4 || {};
    const out = [];
    for (const sg of L4_SUBGROUPS) for (const it of (L4[sg.key] || [])) out.push({ ...it, _sub: sg.key });
    return out;
  }
  return pack.layers[L] || [];
}

export const POSTURE_LAYERS = [
  { key: 'infra',    label: 'Infrastructure', hint: 'nodes · pods · disk · network' },
  { key: 'platform', label: 'Platform',       hint: 'db · cache · queue · gateway' },
  { key: 'app',      label: 'Application',    hint: 'service · API · job · business logic' },
  { key: 'ux',       label: 'User Experience',hint: 'frontend · journey · business outcome' },
];

export const POSTURE_MECHANISMS_PER_LAYER = [
  { key: 'sli',        label: 'SLI defined',       hint: 'what we measure' },
  { key: 'slo',        label: 'SLO declared',      hint: 'target reliability' },
  { key: 'alert',      label: 'Alert wired',       hint: 'fires on threshold or burn-rate' },
  { key: 'dashboard',  label: 'Dashboard',         hint: 'human-readable view' },
  { key: 'metric',     label: 'Metrics flowing',   hint: 'scrape job, recording rule, or evidence' },
  { key: 'log',        label: 'Logs flowing',      hint: 'log scrape / shipper' },
  { key: 'trace',      label: 'Traces flowing',    hint: 'span emission attested' },
  { key: 'runbook',    label: 'Runbook linked',    hint: 'oncall response declared' },
  { key: 'chaos',      label: 'Chaos validated',   hint: 'fault injection tested' },
  { key: 'synthetic',  label: 'Synthetic check',   hint: 'active uptime probe' },
];

export const DELTA_BADNESS = {
  declaredNotLive: 1.0,
  driftedDefault: 0.5,
  driftedDecisionBearing: 1.0,
  driftedCosmetic: 0.1,
  liveNotDeclared: 0.15,
};

// Trust threshold derived from decision cost, not a round-number vote:
// badness/aligned <= 0.176 means roughly one high-cost false reassurance
// per six confirmed controls. Fidelity = aligned / (aligned + badness).
export const DRIFT_BADNESS_PER_ALIGNED_TRUST_CEILING = 0.176;
export const DRIFT_FIDELITY_TRUST_THRESHOLD = 1 / (1 + DRIFT_BADNESS_PER_ALIGNED_TRUST_CEILING);
export const DRIFT_HEALTH_PASS_PCT = Math.round(DRIFT_FIDELITY_TRUST_THRESHOLD * 100);
export const DIAGNOSTIC_PASS_SCORE_THRESHOLD = 85;

const DECISION_BEARING_DELTA_RE = /(objective|target|threshold|window|duration|severity|burn|budget|expr|query|promql|expression|condition|sli|slo|metric|record|route|receiver|channel|contact|notification|pager|trigger|pipeline|exporter|backend|signal|good|total|mttd|mttr)/i;
const COSMETIC_DELTA_RE = /(title|label|labels|legend|display|layout|grid|position|folder|tag|tags|description|desc|summary|annotation|annotations|unit|color|schema|uid|source|provider)/i;
const CONTRACT_PACK_IDS = new Set(['target-advanced']);
const FRESH_WINDOW_MS = 24 * 60 * 60 * 1000;
const DRIFT_FAIL_TOLERANCE = 0.30;

export function compareModeFor(packB, compareBId) {
  const bId = String(compareBId || packB?.id || '').toLowerCase();
  const src = inferPackSource(packB);
  const isLiveLike = /(^|[-_])(live|deployed|prod|runtime)([-_]|$)/.test(bId) || src === 'Live';
  if (isLiveLike) return 'drift';
  return 'gap';
}

export function isScaffoldArtefact(artefact) {
  return artefact?.source === 'Scaffold';
}

export function isScaffoldDiffEntry(entry) {
  return isScaffoldArtefact(entry?.artefact) || isScaffoldArtefact(entry?.a) || isScaffoldArtefact(entry?.b);
}

export function driftedEntryBadness(entry) {
  const fields = (entry?.deltas || []).map((d) => String(d.field || '')).filter(Boolean);
  if (fields.some((field) => DECISION_BEARING_DELTA_RE.test(field))) {
    return { weight: DELTA_BADNESS.driftedDecisionBearing, className: 'decision' };
  }
  if (fields.length > 0 && fields.every((field) => COSMETIC_DELTA_RE.test(field))) {
    return { weight: DELTA_BADNESS.driftedCosmetic, className: 'cosmetic' };
  }
  return { weight: DELTA_BADNESS.driftedDefault, className: 'default' };
}

export function computeWeightedDeltaRisk({ mode, aligned, driftedEntries = [], drifted, onlyInA, onlyInB }) {
  const aWeight = mode === 'drift'
    ? DELTA_BADNESS.declaredNotLive
    : DELTA_BADNESS.liveNotDeclared;
  const bWeight = mode === 'drift'
    ? DELTA_BADNESS.liveNotDeclared
    : DELTA_BADNESS.declaredNotLive;
  const driftEntries = driftedEntries.length
    ? driftedEntries
    : Array.from({ length: drifted || 0 }, () => null);
  const driftedBreakdown = { decision: 0, default: 0, cosmetic: 0 };
  let driftedUnits = 0;
  for (const entry of driftEntries) {
    if (isScaffoldDiffEntry(entry)) continue;
    const cost = driftedEntryBadness(entry);
    driftedBreakdown[cost.className] += 1;
    driftedUnits += cost.weight;
  }
  const onlyInAUnits = onlyInA * aWeight;
  const onlyInBUnits = onlyInB * bWeight;
  const totalBadness = driftedUnits + onlyInAUnits + onlyInBUnits;
  const denominator = aligned + totalBadness;
  const health = denominator === 0 ? 1 : aligned / denominator;
  const healthPct = Math.round(health * 100);
  return {
    aWeight,
    bWeight,
    driftedUnits,
    driftedBreakdown,
    onlyInAUnits,
    onlyInBUnits,
    totalBadness,
    health,
    healthPct,
  };
}

export function criterionScore(c) {
  return typeof c?.score === 'number' ? Math.max(0, Math.min(1, c.score)) : (c?.pass ? 1 : 0);
}

export function diagnosticScorePercent(passed, total) {
  return total === 0 ? 0 : (passed / total) * 100;
}

export function diagnosticAuditStatus(passed, total) {
  const scorePctExact = diagnosticScorePercent(passed, total);
  const passes = scorePctExact > DIAGNOSTIC_PASS_SCORE_THRESHOLD;
  return {
    passes,
    status: passes ? 'PASS' : 'FAIL',
    scorePctExact,
    threshold: DIAGNOSTIC_PASS_SCORE_THRESHOLD,
  };
}

// ---------- instrument grade scale ----------
//
// The metrology-style rating users actually read — a raw percentage with a
// PASS/FAIL stamp doesn't land. The anchor is fixed by contract: A
// (Diagnostic / Clinical) begins strictly above the audit bar (>85%), so
// the letter and the PASS verdict can never disagree. Bands below reuse
// the verdict-word fractions (62.5 / 37.5); B+ marks the upper half of the
// almost-band; A+ is reserved for near-perfect scores.
//
// HONESTY FENCE: A++ is rendered on the ladder but is NOT score-reachable
// (minPct: null). "Calibrates other instruments" is a claim about external
// reference evidence — benchmarking against other instruments — that the
// seven verification criteria cannot attest. It stays visible (dimmed,
// requirement stated) because curated reference packs play exactly that
// role in-context. The metrology scale's S / Primary Standard rung was
// deliberately dropped (maintainer call, 2026-06-10): national-standards-
// lab framing has no pragmatic meaning for an observability instrument.
// Ordered top (best) → bottom.
export const INSTRUMENT_GRADE_SCALE = [
  { letter: 'A++', tier: 'ref', label: 'Calibration / Reference Grade', minPct: null, range: '—',
    blurb: 'Used to verify, calibrate, or benchmark other instruments. Very low uncertainty and strong traceability requirements.',
    requires: 'external reference benchmarking — beyond this instrument’s evidence' },
  { letter: 'A+',  tier: 'a',   label: 'Laboratory / Research Grade',   minPct: 95,   range: '≥ 95%',
    blurb: 'Higher precision, stability, sensitivity, and documentation than clinical-grade tools; suited to controlled lab or research environments.' },
  { letter: 'A',   tier: 'a',   label: 'Diagnostic / Clinical Grade',   minPct: DIAGNOSTIC_PASS_SCORE_THRESHOLD, exclusiveMin: true, range: '> 85%',
    blurb: 'Fit for professional diagnostic, clinical, or decision-critical use.' },
  { letter: 'B+',  tier: 'b',   label: 'Inspection Grade',              minPct: 75,   range: '≥ 75%',
    blurb: 'Suitable for QA/QC, accept-reject decisions, and formal inspection workflows.' },
  { letter: 'B',   tier: 'b',   label: 'Industrial Grade',              minPct: 62.5, range: '≥ 62.5%',
    blurb: 'Suitable for production, maintenance, process control, and routine professional use.' },
  { letter: 'C',   tier: 'c',   label: 'Field Grade',                   minPct: 37.5, range: '≥ 37.5%',
    blurb: 'Portable, rugged, and practical for on-site measurement, but not the highest accuracy.' },
  { letter: 'D',   tier: 'd',   label: 'Consumer Grade',                minPct: 0,    range: '< 37.5%',
    blurb: 'Everyday use; useful for rough readings, trends, or casual decisions.' },
];

export function instrumentGradeFor(scorePctExact) {
  const pct = Number.isFinite(scorePctExact) ? scorePctExact : 0;
  for (const g of INSTRUMENT_GRADE_SCALE) {
    if (g.minPct === null) continue;   // not score-reachable — see honesty fence above
    if (g.exclusiveMin ? pct > g.minPct : pct >= g.minPct) return g;
  }
  return INSTRUMENT_GRADE_SCALE[INSTRUMENT_GRADE_SCALE.length - 1];
}

// Partial-live-evidence detector. A live MCP draft can be built even when
// some probes fail outright (e.g. the endpoint 503s mid-fetch during a
// deploy) — the fetcher records that honestly in mcp.probesFailed, but a
// thin Pack B silently inflates "declared, not live" into garbage drift.
// Pure so it's unit-testable; the drift drill renders a loud banner from it.
//
// Additive keys (vendored downstream — never remove or rename, see
// docs/VENDORING.md):
//   unsupported — probe families the MCP does not expose at all
//                 (mcp.probesUnsupported): a restricted tier, not an outage.
//   errors      — { family: last error message } from mcp.probeErrors.<family>.
//   vantage     — how much of the live surface this draft could see:
//                 'full' (nothing failed, nothing unsupported),
//                 'partial' (some probes failed — a hole of unknown size),
//                 'restricted' (nothing failed, but some families are not
//                 exposed by this MCP tier), 'lost' (every attempted family
//                 failed or is unsupported), 'none' (not a live draft).
// `partial` keeps its meaning: outright failures only.
export function partialLiveEvidence(packB) {
  const ann = packB?.meta?.annotations || packB?.metadata?.annotations || {};
  const list = (k) => String(ann[k] || '').split(',').map(s => s.trim()).filter(Boolean);
  const failed = list('mcp.probesFailed');
  const empty = list('mcp.probesEmpty');
  const attempted = list('mcp.probesAttempted');
  const unsupported = list('mcp.probesUnsupported');
  const errors = {};
  for (const [k, v] of Object.entries(ann)) {
    if (k.startsWith('mcp.probeErrors.') && v != null && String(v) !== '') {
      errors[k.slice('mcp.probeErrors.'.length)] = String(v);
    }
  }
  const isLiveDraft = !!ann['mcp.url'];
  const noAnswer = new Set([...failed, ...unsupported]);
  let vantage = 'none';
  if (isLiveDraft) {
    if (attempted.length > 0 && attempted.every(p => noAnswer.has(p))) vantage = 'lost';
    else if (failed.length > 0) vantage = 'partial';
    else if (unsupported.length > 0) vantage = 'restricted';
    else vantage = 'full';
  }
  return {
    isLiveDraft,
    failed,
    empty,
    attempted,
    unsupported,
    errors,
    vantage,
    // Only outright failures make the evidence PARTIAL — an empty probe is
    // an honest zero, a failed probe is a hole of unknown size.
    partial: isLiveDraft && failed.length > 0,
  };
}

// The drift-free check's hint when nothing live backs the pack — where a live
// signal comes from. opts.noLiveHint replaces it (the static posture's text:
// studio/compare-view.mjs passes studio/static-remedies.mjs's); every other
// caller, tools/lib/journey.mjs included, reads this one.
const NO_LIVE_HINT = 'connect MCP or scan live';

// opts: { nowMs, noLiveHint } — the clock (Date.now() by default) and the hint above.
export function computeDiagnosticGrade(packA, packB, posture, catalogBId, diff, opts = {}) {
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();
  const noLiveHint = typeof opts.noLiveHint === 'string' && opts.noLiveHint ? opts.noLiveHint : NO_LIVE_HINT;
  const ann = packA?.meta?.annotations || packA?.metadata?.annotations || {};
  const L1 = packA?.layers?.L1 || [];
  const L2 = packA?.layers?.L2 || [];
  const L4 = packA?.layers?.L4 || {};
  const L5 = packA?.layers?.L5 || [];

  const signalsPresent = new Set();
  for (const b of L2) {
    const sig = String(b.spec?.signal || b.signal || '').toLowerCase();
    if (['metrics','logs','traces','profiles'].includes(sig)) signalsPresent.add(sig);
  }
  const allSignals = ['metrics','logs','traces','profiles'];
  const signalsCount = signalsPresent.size;
  const multiModal = signalsCount >= 3;

  const otel = L2.find(a => /^OTEL-/.test(a.id || ''));
  const propagators = otel?.spec?.sdk?.propagators || otel?.sdk?.propagators || [];
  const hasTraceContext = (Array.isArray(propagators) ? propagators : [])
    .some(p => /tracecontext/i.test(String(p)));
  const logCorrelationDeclared = !!(otel?.spec?.log_correlation === true || otel?.log_correlation === true);
  const correlated = hasTraceContext && (logCorrelationDeclared || signalsPresent.has('logs'));

  const hasBaselines = L5.some(a => /baseline/i.test(a.id || '') || /baseline/i.test(a.title || ''));
  const slos = L1.filter(a => /^SLO-/.test(a.id || ''));
  const slosWithObjective = slos.filter(a => {
    const obj = a.spec?.objective ?? a.objective;
    return typeof obj === 'number' && obj > 0 && obj <= 1;
  });
  const calibrated = hasBaselines && slosWithObjective.length > 0;

  let totalObserved = 0;
  for (const l of POSTURE_LAYERS) {
    let present = 0, evidence = 0;
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture?.cells?.[`${l.key}:${m.key}`];
      if (arr && arr.length) {
        if (arr.every(a => a._evidence)) evidence++;
        else present++;
      }
    }
    totalObserved += (present + evidence) / POSTURE_MECHANISMS_PER_LAYER.length;
  }
  const avgObservedPct = Math.round((totalObserved / POSTURE_LAYERS.length) * 100);
  const comprehensive = avgObservedPct >= 50;

  const healings = (L4.healing || []).concat(
    Array.isArray(L4) ? L4.filter(a => /^HEAL-/.test(a.id || '')) : []
  );
  const actionableCount = healings.length;
  const actionable = actionableCount > 0;

  const coverageCriteria = [
    { key: 'multi-modal',   label: 'Multi-modal',   sub: 'metrics + logs + traces + profiles',
      pass: multiModal,
      detail: `${signalsCount} of ${allSignals.length} signals declared as backends` +
              (signalsCount > 0 ? ' (' + [...signalsPresent].join(', ') + ')' : ''),
    },
    { key: 'correlated',    label: 'Correlated',    sub: 'signals linked at evidence-level',
      pass: correlated,
      detail: hasTraceContext
        ? (logCorrelationDeclared ? 'tracecontext propagator + log_correlation: true' : 'tracecontext propagator declared')
        : 'tracecontext propagator missing - logs/traces cannot be joined',
    },
    { key: 'calibrated',    label: 'Calibrated',    sub: 'normal defined with numbers',
      pass: calibrated,
      detail: hasBaselines
        ? (slosWithObjective.length
            ? `MTTD/MTTR baselines + ${slosWithObjective.length} SLO${slosWithObjective.length === 1 ? '' : 's'} with explicit objective`
            : 'baselines declared but no SLOs have explicit objectives')
        : 'no MTTD/MTTR baselines declared',
    },
    { key: 'comprehensive', label: 'Comprehensive', sub: 'coverage spans all layers',
      pass: comprehensive,
      detail: `${avgObservedPct}% average observed across infra · platform · app · ux`,
    },
  ];

  // Operability is observed and displayed but NOT scored (grade schema 2,
  // maintainer-ratified 2026-06-10). Runbooks measure response readiness of
  // the overall observability solution; the diagnostic grade answers only
  // "can the instrument detect, localise, and explain?" — a perfectly
  // diagnostic system tells you what is wrong even when nobody wrote the
  // treatment protocol. The signal keeps a scored home in the posture
  // matrix (runbook mechanism column).
  const operabilityCriteria = [
    { key: 'actionable',    label: 'Actionable',    sub: 'alerts lead to a response path',
      pass: actionable,
      informational: true,
      detail: actionableCount > 0
        ? `${actionableCount} remediation runbook${actionableCount === 1 ? '' : 's'} declared`
        : 'no runbooks linked - when an alert fires, oncall has no scripted response',
    },
  ];

  const annB = packB?.meta?.annotations || packB?.metadata?.annotations || {};
  const hasMcpAnnotations = (a) => !!a && Object.keys(a).some(k => k.startsWith('mcp.'));
  const liveAnn = hasMcpAnnotations(annB) ? annB : ann;

  const chaosCount = L5.filter(a => /^CHAOS-/.test(a.id || '')).length;
  const chaosValidated = chaosCount > 0;

  const probesAttempted = (liveAnn['mcp.probesAttempted']  || '').split(',').filter(Boolean);
  const probesSucceeded = (liveAnn['mcp.probesSucceeded']  || '').split(',').filter(Boolean);
  const probesEmpty     = (liveAnn['mcp.probesEmpty']      || '').split(',').filter(Boolean);
  const probesFailed    = (liveAnn['mcp.probesFailed']     || '').split(',').filter(Boolean);
  const hasMcpSource = probesAttempted.length > 0 || !!liveAnn['mcp.refreshedAt'];
  let driftFree, driftDetail, driftScore;
  const hasLiveDiff = !!diff?.layers && compareModeFor(packB, catalogBId) === 'drift';
  if (hasLiveDiff) {
    const declaredAhead = Object.values(diff.layers || {}).reduce((n, bucket) => n + (bucket.declaredAhead || []).length, 0);
    const aheadNote = declaredAhead ? `; ${declaredAhead} declared ahead of this environment` : '';
    const branchRollup = diff.traceabilityGraph?.rollup;
    if (branchRollup && branchRollup.declaredTotal > 0) {
      driftScore = Math.max(0, Math.min(1, branchRollup.integrityMean ?? 0));
      driftFree = driftScore >= DRIFT_FIDELITY_TRUST_THRESHOLD;
      const confidence = (diff.traceabilityGraph?.branches || []).some(b => b.confidence === 'inferred')
        ? 'some inferred edges'
        : 'declared edges';
      driftDetail = (driftFree
        ? `requirement-chain integrity ${branchRollup.integrityPct}% - ${branchRollup.intact}/${branchRollup.declaredTotal} declared commitment${branchRollup.declaredTotal === 1 ? '' : 's'} intact; ${branchRollup.partial} partial, ${branchRollup.broken} broken, ${branchRollup.undeclared} live-only; ${confidence}`
        : `requirement-chain integrity ${branchRollup.integrityPct}% (<${DRIFT_HEALTH_PASS_PCT}% trust threshold) - ${branchRollup.intact}/${branchRollup.declaredTotal} declared commitment${branchRollup.declaredTotal === 1 ? '' : 's'} intact; ${branchRollup.partial} partial, ${branchRollup.broken} broken, ${branchRollup.undeclared} live-only; ${confidence}`) + aheadNote;
    } else {
      let alignedLive = 0;
      let declaredMissing = 0;
      let behaviorDrifted = 0;
      let liveShadow = 0;
      let scaffoldExcluded = 0;
      let notObserved = 0;
      const driftedEntries = [];
      for (const bucket of Object.values(diff.layers || {})) {
        const concreteOnlyInA = (bucket.onlyInA || []).filter(e => !isScaffoldDiffEntry(e));
        const concreteOnlyInB = (bucket.onlyInB || []).filter(e => !isScaffoldDiffEntry(e));
        const concreteInBoth = (bucket.inBoth || []).filter(e => !isScaffoldDiffEntry(e));
        scaffoldExcluded += (bucket.onlyInA || []).filter(e => isScaffoldDiffEntry(e)).length
          + (bucket.onlyInB || []).filter(e => isScaffoldDiffEntry(e)).length
          + (bucket.inBoth || []).filter(e => isScaffoldDiffEntry(e)).length
          // diffPacks parks placeholders in their own bucket (never paired);
          // older diffs without it still fall through the filters above.
          + (bucket.scaffold || []).length;
        // Declared artefacts in a family the live side could not observe
        // (diffPacks `notObserved`) are unchecked: they are not live
        // evidence and not missing, so they move no weight.
        notObserved += (bucket.notObserved || []).length;
        declaredMissing += concreteOnlyInA.length;
        const bucketDrifted = concreteInBoth.filter(e => e.match === 'drifted');
        behaviorDrifted += bucketDrifted.length;
        driftedEntries.push(...bucketDrifted);
        alignedLive += concreteInBoth.filter(e => e.match !== 'drifted').length;
        liveShadow += concreteOnlyInB.length;
      }
      const weighted = computeWeightedDeltaRisk({
        mode: 'drift',
        aligned: alignedLive,
        driftedEntries,
        drifted: behaviorDrifted,
        onlyInA: declaredMissing,
        onlyInB: liveShadow,
      });
      driftScore = Math.max(0, Math.min(1, weighted.health));
      driftFree = weighted.health >= DRIFT_FIDELITY_TRUST_THRESHOLD;
      const fmtUnits = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
      const driftBreakdown = `${weighted.driftedBreakdown.decision} decision-bearing, ${weighted.driftedBreakdown.default} default, ${weighted.driftedBreakdown.cosmetic} cosmetic`;
      const scaffoldNote = (scaffoldExcluded ? `; ${scaffoldExcluded} scaffold excluded` : '')
        + (notObserved ? `; ${notObserved} not checked (the live side could not observe them)` : '')
        + aheadNote;
      driftDetail = driftFree
        ? `weighted live-fidelity ${weighted.healthPct}% - declared-not-live ${declaredMissing}x1.0, drifted ${behaviorDrifted} (${driftBreakdown}), live-not-declared ${liveShadow}x0.15; ${fmtUnits(weighted.totalBadness)} badness units${scaffoldNote}`
        : `weighted live-fidelity ${weighted.healthPct}% (<${DRIFT_HEALTH_PASS_PCT}% trust threshold); declared-not-live ${declaredMissing}x1.0, drifted ${behaviorDrifted} (${driftBreakdown}), live-not-declared ${liveShadow}x0.15; ${fmtUnits(weighted.totalBadness)} badness units${scaffoldNote}`;
    }
  } else if (!hasMcpSource) {
    driftFree = false;
    driftScore = 0;
    driftDetail = `declared-only - no live signal to verify against (${noLiveHint})`;
  } else if (probesAttempted.length === 0) {
    driftFree = true;
    driftScore = 1;
    driftDetail = 'live source connected - probe table not recorded';
  } else {
    const driftCount = probesEmpty.length + probesFailed.length;
    const driftRatio = driftCount / probesAttempted.length;
    driftFree = driftRatio <= DRIFT_FAIL_TOLERANCE;
    driftScore = Math.max(0, Math.min(1, 1 - driftRatio));
    const pct = Math.round(driftRatio * 100);
    driftDetail = driftFree
      ? `${probesSucceeded.length}/${probesAttempted.length} probes confirmed (${pct}% empty or failed, within ${Math.round(DRIFT_FAIL_TOLERANCE * 100)}% tolerance)`
      : `${driftCount}/${probesAttempted.length} probes empty or failed (${pct}%) - declared surface exceeds what live attests`;
  }

  const refreshedAtStr = liveAnn['mcp.refreshedAt'];
  let fresh, freshDetail;
  if (!refreshedAtStr) {
    fresh = false;
    freshDetail = 'no mcp.refreshedAt annotation - pack has never been verified against live state';
  } else {
    const refreshedAtMs = Date.parse(refreshedAtStr);
    if (!Number.isFinite(refreshedAtMs)) {
      fresh = false;
      freshDetail = `mcp.refreshedAt is unparseable (${refreshedAtStr})`;
    } else {
      const ageMs = nowMs - refreshedAtMs;
      const ageHrs = Math.round(ageMs / 3600000);
      fresh = ageMs <= FRESH_WINDOW_MS;
      freshDetail = fresh
        ? `last refreshed ${ageHrs}h ago - within 24h staleness window`
        : `last refreshed ${ageHrs}h ago - exceeds 24h staleness window, signals may have drifted`;
      // A refresh that saw nothing is not a fresh look at production. The
      // pass/fail stays a staleness test (scoring is out of scope); the
      // detail says what the vantage actually delivered.
      const vantage = partialLiveEvidence({ meta: { annotations: liveAnn } });
      if (vantage.vantage === 'lost') {
        const failed = vantage.failed.length ? `failed: ${vantage.failed.join(', ')}` : '';
        const unsupported = vantage.unsupported.length ? `not exposed: ${vantage.unsupported.join(', ')}` : '';
        freshDetail += ` - but vantage lost: no probe family answered (${[failed, unsupported].filter(Boolean).join('; ')})`;
      } else if (vantage.vantage === 'partial') {
        freshDetail += ` - vantage partial: failed ${vantage.failed.join(', ')}`;
      }
    }
  }

  const trustCriteria = [
    { key: 'chaos-validated', label: 'Chaos-validated', sub: 'recovery proven by fault injection',
      pass: chaosValidated,
      detail: chaosCount > 0
        ? `${chaosCount} chaos experiment${chaosCount === 1 ? '' : 's'} declared`
        : 'no chaos experiments - recovery procedures are theoretical',
    },
    { key: 'drift-free',      label: 'Drift-free',      sub: 'declarations match live state',
      pass: driftFree,
      score: driftScore,
      detail: driftDetail,
    },
    { key: 'fresh',           label: 'Fresh',           sub: 'recently verified against live',
      pass: fresh,
      detail: freshDetail,
    },
  ];

  const sumScore = (items) => items.reduce((n, c) => n + criterionScore(c), 0);
  const coveragePassed = sumScore(coverageCriteria);
  const trustPassed = sumScore(trustCriteria);
  const overallPassed = coveragePassed + trustPassed;
  const overallTotal = coverageCriteria.length + trustCriteria.length;
  // Verdict words band on percentage, not raw counts, so they keep their
  // meaning across grade schemas (schema 1 had 8 scored criteria, schema 2
  // has 7). The bands preserve schema 1's fractions: grade was 7/8 = 87.5%
  // — now aligned with the audit PASS threshold (>85%) so the word and the
  // PASS stamp can never disagree; almost was 5/8 = 62.5%; not-yet 3/8 = 37.5%.
  const overallPctExact = diagnosticScorePercent(overallPassed, overallTotal);
  const verdict =
    overallPctExact > DIAGNOSTIC_PASS_SCORE_THRESHOLD ? { word: 'Diagnostic-grade',          level: 'is-grade' } :
    overallPctExact >= 62.5                           ? { word: 'Almost diagnostic-grade',   level: 'is-almost' } :
    overallPctExact >= 37.5                           ? { word: 'Not yet diagnostic-grade',  level: 'is-not-yet' } :
                                                        { word: 'Far from diagnostic-grade', level: 'is-far' };
  const audit = diagnosticAuditStatus(overallPassed, overallTotal);

  return {
    // Bump when the set of scored criteria or the scoring rule changes, so
    // persisted run records can explain score discontinuities honestly.
    // Schema 2 (2026-06-10): Actionable reclassified from scored coverage
    // criterion to informational operability — 7 scored criteria (4+3).
    gradeSchema: 2,
    coverage: {
      criteria: coverageCriteria,
      passed:   coveragePassed,
      total:    coverageCriteria.length,
      contractLabel: contractLabelFor(packB, catalogBId),
      contractMode:  isObservabilityContractPack(packB, catalogBId),
    },
    trust: {
      criteria: trustCriteria,
      passed:   trustPassed,
      total:    trustCriteria.length,
      hasMcpSource,
    },
    operability: {
      criteria: operabilityCriteria,
      informational: true,
      note: 'response readiness, not diagnostic capability — observed, displayed, never scored',
    },
    overall: {
      passed: overallPassed,
      total:  overallTotal,
      verdict,
      audit,
      instrumentGrade: instrumentGradeFor(overallPctExact),
      liveDriftFree: driftFree,
    },
    traceabilityGraph: diff?.traceabilityGraph || null,
  };
}

export function isObservabilityContractPack(pack, catalogId) {
  if (!pack) return false;
  const role = pack.meta?.annotations?.['studio.role'] || pack.metadata?.annotations?.['studio.role'];
  if (String(role || '').toLowerCase() === 'contract') return true;
  const slot = String(catalogId || '').toLowerCase();
  if (slot && CONTRACT_PACK_IDS.has(slot)) return true;
  if (slot && /(^|-)contract($|-)/i.test(slot)) return true;
  if (slot && /(^|-)ola($|-)/i.test(slot)) return true;
  const id = String(pack.id || pack.meta?.id || pack.metadata?.name || '').toLowerCase();
  if (CONTRACT_PACK_IDS.has(id)) return true;
  if (/(^|-)contract($|-)/i.test(id)) return true;
  if (/(^|-)ola($|-)/i.test(id)) return true;
  return false;
}

export function contractLabelFor(packB, catalogId) {
  if (!packB) return null;
  if (isObservabilityContractPack(packB, catalogId)) return 'Observability Contract';
  return packB?.meta?.name || packB?.metadata?.name || packB?.id || 'reference pack';
}

function inferPackSource(pack) {
  if (!pack) return 'Pack';
  const id = (pack.id || '').toLowerCase();
  if (id.includes('live')) return 'Live';
  if (id.includes('target')) return 'Target';
  if (id.includes('curated')) return 'Repo';
  if (id.includes('skeleton')) return 'Demo';
  const first = (pack?.layers?.L1 || [])[0];
  if (first?.source === 'Verified') return 'Live';
  return 'Repo';
}

// ---------- posture matrix (moved from compare-view.mjs) ----------
//
// Pure (no DOM, no studio state) so the CLI journey runner can compute the
// same posture the Diagnose view renders. The view imports these back.

// The layer words, tried in this order: UX first (most specific, least
// likely to overlap), application last (a broad catch-all for service-level
// names).
const LAYER_PATTERNS = [
  ['ux',       /(rum|page_load|page-load|conversion|journey|frontend|apdex|lcp|fid|cls|business_outcome|web_vitals|user_satisfaction|customer_)/],
  ['infra',    /(host_|node_|disk_|cpu_|memory_|pod_|container_|kube_|k8s|cluster_|kubelet|cadvisor|node-exporter|kube-state|kubernetes|oom_|networkinterface|tcp_|conn_track|cert_expiry|containeroom|diskexhaustion)/],
  ['platform', /(db_|database_|postgres|mysql|mongo|redis|cache_|queue_|kafka|rabbit|consumer_lag|broker_|bucket_|mq_|elasticsearch_|opensearch_|alertmanager|kong|envoy|traefik|gateway_|graylog)/],
  ['app',      /(availability|success_ratio|error_ratio|latency|p95|p99|p99\.9|request_|http_|api_|service_|endpoint_|error_budget|latency_budget|burn_rate|errorbudget|latencybudget|burnrate|finops|krystalinex)/],
];
function layerOfText(hay) {
  for (const [layer, re] of LAYER_PATTERNS) if (re.test(hay)) return layer;
  return null;
}

export function classifyArtefactLayer(art, pack) {
  if (!art) return null;
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const id = String(art.id || '').toLowerCase();
  const title = String(art.title || '').toLowerCase();
  const folder = String(art.spec?.folder || art.folder || '').toLowerCase();
  const refsStr = (Array.isArray(art.refs) ? art.refs : []).join(' ').toLowerCase();
  // Source URL (dashboards): grafana:///grafana/d/adz2hpb/k8s-dashboard
  // → adds "k8s-dashboard" to the haystack so dashboards whose title
  // got dropped at adapter time can still classify.
  const source = String(art.spec?.source || art.source || '').toLowerCase();
  const sourceSlug = source.split(/[/\\]/).filter(Boolean).pop() || '';
  // Spec-side hints we sometimes have on dashboards / backends.
  const tags = (Array.isArray(art.spec?.tags) ? art.spec.tags : []).join(' ').toLowerCase();
  const product = String(art.spec?.product || art.product || '').toLowerCase();
  const signal = String(art.spec?.signal || art.signal || '').toLowerCase();

  // Explicit override: annotations.layer.<artefact-id>
  const override = ann[`layer.${art.id}`];
  if (override && ['infra','platform','app','ux'].includes(override)) return override;

  const hay = `${id} ${title} ${folder} ${refsStr} ${sourceSlug} ${tags}`;
  const named = layerOfText(hay);
  if (named) return named;

  // Backends with a telemetry signal but no layer-specific tokens
  // (e.g. dashboards-grafana, traces-jaeger) default to APP, since the
  // OTel SDK they enable primarily instruments application services.
  // The spec models telemetry backends as cross-cutting infrastructure;
  // for the posture matrix we attribute them to App by convention so
  // their mechanism shows up somewhere instead of "unknown".
  if (/^BAK-/.test(art.id || '') && signal) return 'app';
  if (id === 'otel-01' || /^OTEL-/.test(art.id || '')) return 'app';

  // SLI/SLO with a service-name pattern in id (e.g. kx_wallet_availability)
  if (/^sli-|^slo-/.test(id) && /^[a-z][a-z0-9_-]*_/.test(art.title || '')) return 'app';

  return null;  // genuinely uncategorised
}

// ---------- the layer an artefact's name does not say ----------
//
// classifyArtefactLayer reads an artefact's own name. Many have none a layer
// word is in — a panel titled rca_failure_ratio, an alert rule named
// HighErrorRate, a metric named ALERTS — and before 2026-11-04 those were
// unplaced, a third of a pack and more. resolveArtefactLayers gives each the
// layer what it is part of, or what it reads, says. In this order, each step
// only for the artefacts the steps before left without a layer, so nothing
// classifyArtefactLayer places moves:
//   'name'     classifyArtefactLayer: the id, title, folder, refs, source,
//              tags, and an `annotations.layer.<id>` override
//   'query'    its own queries (expr, query, good, total…): the metric names
//              in them, by vote (label matchers, by-clauses, strings dropped)
//   'parent'   what it belongs to or refers to, placed by name or query: a
//              panel's dashboard (`parent`), a burn-rate alert's objective
//              (`refs`), a metric's dashboards (`spec.used_by`), by vote
//   'readers'  a metric: the placed artefacts whose queries read it, by vote
//   'exports'  a scrape job: the metrics it exports (or, for a live job, the
//              declared job of the same name), by vote
// A vote takes the layer most of the voices name; a tie leaves none.
const QUERY_KEY_RE = /^(expr|query|good|total|numerator|denominator|metrics|origin_query)$/i;
function queryTextsOf(art) {
  const out = [];
  const walk = (o, depth) => {
    if (!o || typeof o !== 'object' || Array.isArray(o) || depth > 2) return;
    for (const [k, v] of Object.entries(o)) {
      if (QUERY_KEY_RE.test(k)) {
        if (typeof v === 'string') out.push(v);
        else if (Array.isArray(v)) for (const x of v) if (typeof x === 'string') out.push(x);
      } else walk(v, depth + 1);
    }
  };
  walk(art?.spec, 0);
  return out;
}
// The metric names a query reads: what is left once the strings, the label
// matchers and the label lists of by / without / on / ignoring / group_* go.
function metricNamesIn(texts) {
  const names = new Set();
  for (const t of texts) {
    const bare = String(t)
      .replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`[^`]*`/g, ' ')
      .replace(/\{[^}]*\}/g, ' ')
      .replace(/\b(?:by|without|on|ignoring|group_left|group_right)\s*\([^)]*\)/gi, ' ');
    for (const m of bare.match(/[a-zA-Z_:][a-zA-Z0-9_:]*/g) || []) names.add(m.toLowerCase());
  }
  return [...names];
}
function vote(layers) {
  const n = new Map();
  for (const l of layers) if (l) n.set(l, (n.get(l) || 0) + 1);
  const ranked = [...n].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  return ranked[0][0];
}
const queryLayer = (art) => vote(metricNamesIn(queryTextsOf(art)).map(layerOfText));
const METRIC_ID_RE = /^METRIC-/;
const SCRAPE_ID_RE = /^SCRAPE-/;

// resolveArtefactLayers(pack) → Map(id → { layer, how }) over every artefact
// of the seven layers that carries an id; `how` is one of the steps above,
// or null with the layer.
export function resolveArtefactLayers(pack) {
  const all = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'].flatMap((L) => layerItemsFor(pack, L)).filter((a) => a && a.id);
  const out = new Map();
  const set = (a, layer, how) => out.set(a.id, { layer, how: layer ? how : null });
  const layerOf = (id) => out.get(id)?.layer || null;
  const open = () => all.filter((a) => !layerOf(a.id));
  for (const a of all) {
    const named = classifyArtefactLayer(a, pack);
    set(a, named || queryLayer(a), named ? 'name' : 'query');
  }
  // What it belongs to or refers to, placed by its own words.
  const byDefines = new Map(all.filter((a) => a.defines).map((a) => [a.defines, a.id]));
  const owners = (a) => {
    const keys = [a.parent, ...(Array.isArray(a.refs) ? a.refs : [])];
    for (const u of (Array.isArray(a.spec?.used_by) ? a.spec.used_by : [])) {
      const m = /^dashboard:([^/]+)/.exec(String(u));
      if (m) keys.push(`dashboards.${m[1]}`);
    }
    return keys.map((k) => byDefines.get(k)).filter((id) => id && id !== a.id);
  };
  const placedOwn = new Map([...out].map(([id, v]) => [id, v.layer]));
  for (const a of open()) set(a, vote(owners(a).map((id) => placedOwn.get(id))), 'parent');
  // A metric: what reads it.
  const readers = new Map();
  for (const a of all) {
    const layer = layerOf(a.id);
    if (!layer || METRIC_ID_RE.test(a.id) || SCRAPE_ID_RE.test(a.id)) continue;
    for (const name of metricNamesIn(queryTextsOf(a))) {
      if (!readers.has(name)) readers.set(name, []);
      readers.get(name).push(layer);
    }
  }
  for (const a of open()) {
    if (!METRIC_ID_RE.test(a.id)) continue;
    set(a, vote(readers.get(String(a.spec?.name || a.title || '').toLowerCase()) || []), 'readers');
  }
  // A scrape job: the metrics it exports; a live job, the declared job of its name.
  const byMetric = new Map();
  for (const a of all) if (METRIC_ID_RE.test(a.id)) {
    const name = String(a.spec?.name || a.title || '').toLowerCase();
    if (name && layerOf(a.id) && !byMetric.has(name)) byMetric.set(name, layerOf(a.id));
  }
  const declaredJobs = new Map();
  for (const a of open()) {
    if (!SCRAPE_ID_RE.test(a.id) || !Array.isArray(a.spec?.exports)) continue;
    set(a, vote(a.spec.exports.map((m) => byMetric.get(String(m).toLowerCase()))), 'exports');
  }
  for (const a of all) if (SCRAPE_ID_RE.test(a.id) && a.spec?.job && layerOf(a.id)) declaredJobs.set(String(a.spec.job), layerOf(a.id));
  for (const a of open()) {
    if (!SCRAPE_ID_RE.test(a.id) || !a.spec?.job) continue;
    set(a, declaredJobs.get(String(a.spec.job)) || null, 'exports');
  }
  return out;
}

// The adapter's id families (tools/lib/adapter.mjs; the same prefixes as
// tools/lib/artefact-classify.mjs ID_RULES, which tools/test-diagnostic-
// grade.mjs holds this table to), each with the kind of signal it is. The
// longer prefix first where one contains another. A family whose kind is
// null has none of its own: a part of another artefact (an alert's route),
// pipeline plumbing (a receiver, a processor, a collection agent), or
// configuration that holds platform-wide (the OTel SDK, profiling, network
// and policy engines, a mesh, baselines, an import).
//   'by-signal'  a backend: its signal (metrics, logs, traces) is its kind
//   'scrape'     a scrape job: metrics, or logs for a log shipper — the
//                rule the scrape-job evidence below follows
export const MECHANISM_BY_ID_PREFIX = Object.freeze([
  ['SLI-',        'sli'],
  ['SLO-',        'slo'],
  ['OTEL-',       null],
  ['BAK-',        'by-signal'],
  ['PIP-RCV-',    null],
  ['PIP-PRC-',    null],
  ['PIP-EXP-MET', 'metric'],
  ['PIP-EXP-LOG', 'log'],
  ['PIP-EXP-TRC', 'trace'],
  ['STO-MET-',    'metric'],
  ['STO-LOG-',    'log'],
  ['STO-TRC-',    'trace'],
  ['SCRAPE-SRC-', 'scrape'],
  ['SCRAPE-',     'scrape'],
  ['METRIC-SRC-', 'metric'],
  ['METRIC-',     'metric'],
  ['PROF-',       null],
  ['NET-',        null],
  ['POE-',        null],
  ['MESH-',       null],
  ['COL-',        null],
  ['QRY-',        'metric'],
  ['VIEW-',       'metric'],
  ['DASH-',       'dashboard'],
  ['PANEL-',      'dashboard'],
  ['POL-',        'alert'],
  ['FCST-',       'alert'],
  ['ALR-',        null],
  ['RULE-',       'alert'],
  ['HEAL-',       'runbook'],
  ['BASE-',       null],
  ['CHAOS-',      'chaos'],
  ['SYN-',        'synthetic'],
  ['IMP-',        null],
].map((r) => Object.freeze(r)));

const LOG_SHIPPER_RE = /promtail|fluent|loki|log/i;
const SIGNAL_MECHANISM = { metrics: 'metric', logs: 'log', traces: 'trace' };

// Classifier — returns the mechanism for an artefact (only one most-
// likely mechanism per artefact), by its id family above. Returns null
// when the artefact has no kind of its own (the families marked null,
// a backend whose signal is none of the three, an id of no family).
// Before 2026-11-04 it knew ten families only, so a declared metric,
// a scrape job, an alert rule or a dashboard panel had no kind and
// was left off the matrix without a word.
export function classifyArtefactMechanism(art) {
  if (!art) return null;
  const id = String(art.id || '');
  const rule = MECHANISM_BY_ID_PREFIX.find(([prefix]) => id.startsWith(prefix));
  if (!rule) return null;
  const mech = rule[1];
  if (mech === 'by-signal') return SIGNAL_MECHANISM[String(art.spec?.signal || art.signal || '').toLowerCase()] || null;
  if (mech === 'scrape') return LOG_SHIPPER_RE.test(`${art.title || ''} ${art.spec?.job || art.job || ''}`) ? 'log' : 'metric';
  return mech;
}

export function computePostureMatrix(packA, packB) {
  // Walk every layer (L1..L5 + GOV) and bucket each artefact into
  // (layer × mechanism). Build per-cell artefact lists.
  const cells = {};   // key: `${layer}:${mech}` → [artefacts]
  const platformWide = { instrumentation: false, baselines: false };
  const ann = packA?.meta?.annotations || packA?.metadata?.annotations || {};

  // OTel SDK declared anywhere?
  // Try several heuristics: (a) an OTEL- artefact in L2, (b) a backend
  // with signal=traces (instrumented), (c) explicit annotation.
  const L2 = packA?.layers?.L2 || [];
  if (L2.some(a => /^OTEL-/.test(a.id || '')) ||
      L2.some(a => /^BAK-/.test(a.id || '') && /traces/.test(String(a.spec?.signal||'').toLowerCase()))) {
    platformWide.instrumentation = true;
  }

  // Baselines declared?
  const L5 = packA?.layers?.L5 || [];
  if (L5.some(a => /baseline/i.test(a.id || '') || /baseline/i.test(a.title || ''))) {
    platformWide.baselines = true;
  }

  // The artefacts the walk finds with no kind of their own (see
  // MECHANISM_BY_ID_PREFIX): on no cell, listed so a reader can count them.
  const unkinded = [];
  // Each artefact's layer by its name, else by what it is part of or reads.
  const resolved = resolveArtefactLayers(packA);
  const allLayers = ['L1','L2','L2X','L3','L4','L5','GOV'];
  for (const L of allLayers) {
    const items = layerItemsFor(packA, L);
    for (const art of items) {
      const mech = classifyArtefactMechanism(art);
      if (!mech) { unkinded.push(art); continue; }
      const layer = art.id && resolved.has(art.id) ? resolved.get(art.id).layer : classifyArtefactLayer(art, packA);
      // When layer is null, bucket under 'unknown' so the matrix can
      // still surface the artefact's existence without claiming a
      // layer. UI shows these in a tiny "unclassified" footer.
      const key = `${layer || 'unknown'}:${mech}`;
      if (!cells[key]) cells[key] = [];
      cells[key].push(art);
    }
  }

  // Telemetry mechanism propagation: when the pack declares a backend
  // with signal=metrics/logs/traces/profiles, that telemetry pipeline
  // is enabled platform-wide. It primarily instruments the App layer
  // (services emitting telemetry). Light up App's row for each signal
  // we have a backend for. Other layers stay evidence-driven (scrape
  // jobs, recording rules, firing alerts) so we don't overclaim.
  // The backend already sits in its own cell from the walk above: here it
  // is the signal it carries, marked `_propagated`, so a cell it lights is
  // present while a count of the repository's artefacts takes it once.
  const signalToMech = { metrics: 'metric', logs: 'log', traces: 'trace', profiles: 'profile' };
  for (const a of L2) {
    if (!/^BAK-/.test(a.id || '')) continue;
    const sig = String(a.spec?.signal || a.signal || '').toLowerCase();
    const mech = signalToMech[sig];
    if (!mech) continue;
    const key = `app:${mech}`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ ...a, _propagated: true });
  }

  // Also consider the firing-alerts evidence — these are layer-bearing
  // even though they aren't artefacts in the layered shape. The fetcher
  // stamps them as annotations; we re-derive layer from alertname.
  const firingNames = (ann['mcp.discovered.alerts_firing.names'] || '').split(',').filter(Boolean);
  for (const n of firingNames) {
    const fakeArt = { id: `ALERT-${n}`, title: n };
    const layer = classifyArtefactLayer(fakeArt, packA);
    const key = `${layer || 'unknown'}:alert`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `firing/${n}`, title: n, _evidence: true });
  }

  // Recording-rule outputs from the inventory grep are evidence of
  // metric mechanism per layer.
  const recRuleNames = (ann['mcp.discovered.recording_rules_via_inventory.names'] || '').split(',').filter(Boolean);
  for (const n of recRuleNames) {
    const fakeArt = { id: `REC-${n}`, title: n };
    const layer = classifyArtefactLayer(fakeArt, packA);
    const key = `${layer || 'unknown'}:metric`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `recrule/${n}`, title: n, _evidence: true });
  }

  // Scrape jobs surfaced via annotations — strong evidence of log/metric
  // flow at the inferred layer (node-exporter → infra, postgres → platform, etc.)
  const scrapeJobs = (ann['mcp.discovered.scrape_jobs'] || '').split(',').filter(Boolean);
  for (const job of scrapeJobs) {
    const fakeArt = { id: `JOB-${job}`, title: job };
    const layer = classifyArtefactLayer(fakeArt, packA);
    // Most scrape jobs evidence metrics; some specifically evidence logs
    // (promtail, fluentbit). Default to metric.
    const mech = LOG_SHIPPER_RE.test(job) ? 'log' : 'metric';
    const key = `${layer || 'unknown'}:${mech}`;
    if (!cells[key]) cells[key] = [];
    cells[key].push({ id: `scrape/${job}`, title: job, _evidence: true });
  }

  return { cells, platformWide, unkinded };
}

