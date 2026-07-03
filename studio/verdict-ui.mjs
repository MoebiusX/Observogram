// studio/verdict-ui.mjs
//
// Shared substrate for the Diagnose grade page and the Remediate triage
// queue (the 2026-06 redesign — docs/UX_DIAGNOSE_REMEDIATE.md). Pure
// view-layer: every number comes from the ratified engines
// (diagnostic-grade, /api/diff, /api/journeys); nothing here re-scores.
//
// Three responsibilities:
//   1. buildVerdictModel()  — one normalized read of the drift universe:
//      per-layer buckets, per-item badness (the engine's own weights),
//      biggest-gap attribution, honesty flags. Accepts the state slice
//      ({ pack, packB, diff, compareBId, catalogEntry }) plus the active
//      product-lens predicate so counts match the lensed drill.
//   2. projectGrade()       — "fixing these N takes you from B to A",
//      computed by RE-RUNNING computeDiagnosticGrade on a hypothetical
//      post-fix diff. Conservative: requirement-chain integrity is held
//      constant, freshness/chaos are never projected; when the drift
//      criterion is anchored on chain integrity, chainAnchored lets the
//      caller say so instead of faking a delta.
//   3. Widgets + honesty blocks — KPI tiles, sparklines, chips, donuts,
//      and the partial-evidence / scaffold / out-of-scope /
//      verification≠validation blocks every surface must carry.
//
// NO GLOBAL STATE: callers pass the state slice in and loadRunHistory's
// fetcher is injectable, so downstream studios can vendor this file and
// feed it their own store (docs/VENDORING.md). Only pure-module imports
// below (api.mjs supplies just the default fetcher).

import { api } from './api.mjs';
import { escapeHtml } from './util.mjs';
import { diffEntryLabel, deploySurfaceForArtefact } from './artifact-model.mjs';
import {
  computeDiagnosticGrade,
  computePostureMatrix,
  computeWeightedDeltaRisk,
  compareModeFor,
  driftedEntryBadness,
  isScaffoldDiffEntry,
  partialLiveEvidence,
  criterionScore,
  DELTA_BADNESS,
} from './diagnostic-grade.mjs';
import { LAYERS_FOR_DIFF } from './compare-catalog.mjs';

export const VERDICT_LAYER_NAMES = {
  L1: 'Contract', L2: 'Telemetry', L2X: 'Extended', L3: 'Insight',
  L4: 'Action', L5: 'Validation', GOV: 'Governance',
};

// ---------- the normalized model ----------

// Stable identity for a diff entry inside the view layer — used to match
// basket selections back to entries when building the hypothetical
// post-fix diff. diff entries carry a server `key`; fall back to label.
function entryUid(L, kind, entry) {
  return `${L}::${kind}::${entry.key || diffEntryLabel(entry)}`;
}

// passesLens(entry, side) — optional predicate threading the Diagnose
// product lens into the model so the lattice matches the lensed counts.
// pack/packB/diff/compareBId are the caller's state slice; catalogEntry
// is the (optional) catalog row for compareBId — only its label is read.
export function buildVerdictModel({ pack, packB, diff, compareBId, catalogEntry = null, passesLens = null } = {}) {
  const haveB = !!packB;
  const posture = computePostureMatrix(pack, packB);
  const resolvedDiff = (diff && !diff.error && diff.layers) ? diff : null;
  const diagnostic = computeDiagnosticGrade(pack, packB, posture, compareBId, resolvedDiff);
  const mode = compareModeFor(packB, compareBId);
  const bName = catalogEntry?.label
    || packB?.meta?.name || packB?.metadata?.name || packB?.id || 'Pack B';
  const lensed = (entry, side) => !passesLens || passesLens(entry, side);

  const totals = { aligned: 0, drifted: 0, onlyInA: 0, onlyInB: 0, scaffold: 0, outOfScope: 0 };
  const layers = [];
  const items = [];
  const driftedEntries = [];

  if (resolvedDiff) {
    for (const L of LAYERS_FOR_DIFF) {
      const bucket = resolvedDiff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };
      const matched = (bucket.inBoth || []).filter(e => lensed(e, 'a') && !isScaffoldDiffEntry(e));
      const aligned = matched.filter(e => e.match !== 'drifted');
      const drifted = matched.filter(e => e.match === 'drifted');
      const onlyInA = (bucket.onlyInA || []).filter(e => lensed(e, 'a') && !isScaffoldDiffEntry(e));
      const onlyInB = (bucket.onlyInB || []).filter(e => lensed(e, 'b') && !isScaffoldDiffEntry(e));
      const scaffold = [
        ...(bucket.onlyInA || []), ...(bucket.onlyInB || []), ...(bucket.inBoth || []),
      ].filter(e => isScaffoldDiffEntry(e));
      const outOfScope = (bucket.outOfScope || []).filter(e => lensed(e, 'b'));

      totals.aligned += aligned.length;
      totals.drifted += drifted.length;
      totals.onlyInA += onlyInA.length;
      totals.onlyInB += onlyInB.length;
      totals.scaffold += scaffold.length;
      totals.outOfScope += outOfScope.length;
      driftedEntries.push(...drifted);

      if (aligned.length || drifted.length || onlyInA.length || onlyInB.length || outOfScope.length) {
        layers.push({ L, name: VERDICT_LAYER_NAMES[L] || L, aligned, drifted, onlyInA, onlyInB, outOfScope });
      }

      // Per-item triage entries with their REAL badness weight — the same
      // weights the engine scores with (DELTA_BADNESS / driftedEntryBadness).
      const aW = mode === 'drift' ? DELTA_BADNESS.declaredNotLive : DELTA_BADNESS.liveNotDeclared;
      const bW = mode === 'drift' ? DELTA_BADNESS.liveNotDeclared : DELTA_BADNESS.declaredNotLive;
      for (const e of onlyInA) {
        const art = e.artefact || e.a;
        const surface = art ? deploySurfaceForArtefact(art) : { deployable: false };
        items.push({
          uid: entryUid(L, 'onlyInA', e), layer: L, kind: 'onlyInA',
          label: diffEntryLabel(e), badness: aW, badnessClass: aW >= 1 ? 'anchor' : 'low',
          art, identity: e.key, deployable: mode === 'drift' && !!surface.deployable,
          deployIdentity: surface.identity || null, deployRows: surface.deployRows || 1,
          fix: mode === 'drift' ? (surface.deployable ? 'deploy' : 'manual') : 'beyond-target',
        });
      }
      for (const e of drifted) {
        const cost = driftedEntryBadness(e);
        items.push({
          uid: entryUid(L, 'drifted', e), layer: L, kind: 'drifted',
          label: diffEntryLabel(e), badness: cost.weight, badnessClass: cost.className,
          fields: (e.deltas || []).map(d => d.field).filter(Boolean),
          art: e.a, identity: e.key, deployable: false, fix: 'reconcile',
        });
      }
      for (const e of onlyInB) {
        items.push({
          uid: entryUid(L, 'onlyInB', e), layer: L, kind: 'onlyInB',
          label: diffEntryLabel(e), badness: bW, badnessClass: bW >= 1 ? 'anchor' : 'low',
          art: e.artefact || e.b, identity: e.key, deployable: false,
          fix: mode === 'drift' ? 'retrofeed' : 'adopt',
        });
      }
    }
  }
  items.sort((x, y) => y.badness - x.badness);

  const weighted = computeWeightedDeltaRisk({
    mode, aligned: totals.aligned, driftedEntries,
    onlyInA: totals.onlyInA, onlyInB: totals.onlyInB,
  });

  // Biggest-gap attribution: which badness bucket costs the most units.
  const buckets = [
    { kind: 'onlyInA', units: weighted.onlyInAUnits, n: totals.onlyInA,
      label: mode === 'drift' ? 'declared, not live' : 'beyond target' },
    { kind: 'drifted', units: weighted.driftedUnits, n: totals.drifted, label: 'drifted' },
    { kind: 'onlyInB', units: weighted.onlyInBUnits, n: totals.onlyInB,
      label: mode === 'drift' ? 'live, not declared' : 'missing vs target' },
  ].sort((x, y) => y.units - x.units);
  const biggestGap = buckets[0].units > 0 ? buckets[0] : null;

  const deployableSet = deploySelectionFromItems(items);

  return {
    haveB, posture, diff: resolvedDiff, diagnostic, mode, bName,
    totals, layers, items, weighted, biggestGap, deployableSet,
    liveEvidence: partialLiveEvidence(packB),
    overallPct: diagnostic.overall.total === 0 ? 0
      : Math.round((diagnostic.overall.passed / diagnostic.overall.total) * 100),
  };
}

// Deploy selection over triage items (optionally restricted to a basket
// of item uids) — same identity/rows arithmetic as the deploy modal.
export function deploySelectionFromItems(items, selectedUids = null) {
  const identities = new Set();
  let rows = 0;
  for (const it of items) {
    if (!it.deployable || !it.deployIdentity) continue;
    if (selectedUids && !selectedUids.has(it.uid)) continue;
    if (identities.has(it.deployIdentity)) continue;
    identities.add(it.deployIdentity);
    rows += it.deployRows || 1;
  }
  return { identities, rows };
}

// ---------- grade projection ----------

// "Fixing these N takes you from B (65%) to A (87%)" — computed by the
// REAL engine on a hypothetical diff where the given items are resolved:
// declared-not-live entries verify live, drifted entries re-align,
// live-not-declared entries get adopted. HONESTY FENCE: the requirement-
// chain graph is held constant (deploying may repair chains — we do not
// claim it), and freshness / chaos-validated are never projected. When
// the drift criterion is anchored on chain integrity the projection can
// legitimately be flat — `chainAnchored` lets the view say so.
export function projectGrade(uids /* Set<string> | null = fix everything */,
                             { pack, packB, diff, compareBId } = {}) {
  const resolvedDiff = (diff && !diff.error && diff.layers) ? diff : null;
  if (!resolvedDiff) return null;
  const fixAll = !uids;
  const isFixed = (L, kind, e) => fixAll || uids.has(entryUid(L, kind, e));

  const hypoLayers = {};
  for (const L of Object.keys(resolvedDiff.layers)) {
    const bucket = resolvedDiff.layers[L] || {};
    const inBoth = [];
    const onlyInA = [];
    const onlyInB = [];
    for (const e of bucket.inBoth || []) {
      if (e.match === 'drifted' && !isScaffoldDiffEntry(e) && isFixed(L, 'drifted', e)) {
        inBoth.push({ ...e, match: 'aligned', deltas: [] });
      } else inBoth.push(e);
    }
    for (const e of bucket.onlyInA || []) {
      if (!isScaffoldDiffEntry(e) && isFixed(L, 'onlyInA', e)) {
        inBoth.push({ key: e.key, a: e.artefact, b: e.artefact, match: 'aligned' });
      } else onlyInA.push(e);
    }
    for (const e of bucket.onlyInB || []) {
      if (!isScaffoldDiffEntry(e) && isFixed(L, 'onlyInB', e)) {
        inBoth.push({ key: e.key, a: e.artefact, b: e.artefact, match: 'aligned' });
      } else onlyInB.push(e);
    }
    hypoLayers[L] = { ...bucket, inBoth, onlyInA, onlyInB };
  }
  const hypo = { ...resolvedDiff, layers: hypoLayers };

  const posture = computePostureMatrix(pack, packB);
  const before = computeDiagnosticGrade(pack, packB, posture, compareBId, resolvedDiff);
  const after = computeDiagnosticGrade(pack, packB, posture, compareBId, hypo);
  return {
    before, after,
    beforePct: Math.round(before.overall.audit.scorePctExact),
    afterPct: Math.round(after.overall.audit.scorePctExact),
    chainAnchored: (resolvedDiff.traceabilityGraph?.rollup?.declaredTotal || 0) > 0,
  };
}

// One sentence the demo hinges on. Returns '' when nothing would move.
export function projectionSentence(projection, n) {
  if (!projection) return '';
  const b = projection.before.overall.instrumentGrade;
  const a = projection.after.overall.instrumentGrade;
  if (projection.afterPct <= projection.beforePct) {
    return projection.chainAnchored
      ? `The grade is currently anchored on requirement-chain integrity — deploying these ${n} repairs chains on the next live verification (not projected here).`
      : '';
  }
  return `Fixing these ${n} takes you from ${b.letter} (${projection.beforePct}%) to ${a.letter} (${projection.afterPct}%) — projected by re-running the grade on the post-fix diff. Assumes the set verifies live on the next refresh; chain integrity, freshness and chaos are not projected.`;
}

// ---------- journey run history (sparklines + deltas) ----------

let _runsPromise = null;
let _runs = null;   // { journey, runs: [{gradeScore, alignmentPct, at, outcome}] } | null

export function runHistory() { return _runs; }

// Fire-and-forget loader: views call this; when it resolves with data
// the onReady callback fires once and runHistory() is populated.
// fetchFn(path) → parsed JSON — defaults to the studio's api(); a host
// studio vendoring this file passes its own transport instead.
export function loadRunHistory(onReady, { fetchFn = api } = {}) {
  if (_runs) { return; }
  if (_runsPromise) { _runsPromise.then(onReady); return; }
  _runsPromise = (async () => {
    try {
      const { journeys = [] } = await fetchFn('/api/journeys');
      const j = journeys.find(x => x.lastRun) || journeys[0];
      if (!j) { _runs = { journey: null, runs: [] }; return; }
      const { runs = [] } = await fetchFn(`/api/journeys/${encodeURIComponent(j.name)}/runs?limit=20`);
      // Newest-first from the API → oldest-first for sparklines.
      _runs = {
        journey: j.name,
        runs: runs.slice().reverse().map(r => {
          // Raw run records carry grade.score; some summaries flatten it
          // to gradeScore — accept both shapes.
          const gradeScore = typeof r.gradeScore === 'number' ? r.gradeScore
            : typeof r.grade?.score === 'number' ? r.grade.score : null;
          return {
            gradeScore,
            alignmentPct: typeof r.drift?.alignmentPct === 'number' ? r.drift.alignmentPct : null,
            at: r.at || r.startedAt || null,
            outcome: r.outcome || null,
          };
        }),
      };
    } catch (_) {
      _runs = { journey: null, runs: [] };
    }
  })();
  _runsPromise.then(onReady);
}

export function runSeries(field) {
  const vals = (_runs?.runs || []).map(r => r[field]).filter(v => typeof v === 'number');
  return vals.length >= 2 ? vals : null;
}

// ---------- widgets ----------

export function sparklineSvg(values, { w = 96, h = 28 } = {}) {
  if (!values || values.length < 2) return '';
  const min = Math.min(...values), max = Math.max(...values);
  const span = (max - min) || 1;
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * (w - 4) + 2;
    const y = h - 3 - ((v - min) / span) * (h - 8);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const last = pts[pts.length - 1].split(',');
  return `
    <svg class="mc-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
      <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="currentColor"/>
    </svg>`;
}

// A mission-control stat tile. series/delta are optional; when run
// history is absent the tile says so instead of faking a trend.
export function kpiTile({ accent = 'cmp', label, value, unit = '', series = null, deltaText = '', note = '', warn = false }) {
  const spark = series ? sparklineSvg(series) : '';
  return `
    <div class="mc-tile is-${accent}${warn ? ' is-warn' : ''}">
      <div class="mc-tile-label">${escapeHtml(label)}</div>
      <div class="mc-tile-value">${value}<span class="mc-tile-unit">${escapeHtml(unit)}</span></div>
      <div class="mc-tile-trend">${spark}${deltaText ? `<span class="mc-tile-delta">${escapeHtml(deltaText)}</span>` : ''}</div>
      ${note ? `<div class="mc-tile-note">${escapeHtml(note)}</div>` : ''}
    </div>`;
}

export function deltaVsPrevious(series, unit = 'pp') {
  if (!series || series.length < 2) return '';
  const d = series[series.length - 1] - series[series.length - 2];
  if (!Number.isFinite(d)) return '';
  const arrow = d > 0 ? '▲' : d < 0 ? '▼' : '▶';
  return `${arrow} ${Math.abs(d).toFixed(d % 1 ? 1 : 0)} ${unit} vs previous run`;
}

export function chip(status, text) {
  return `<span class="mc-chip is-${escapeHtml(status)}">${escapeHtml(text)}</span>`;
}

export function criterionChip(c) {
  const s = criterionScore(c);
  if (c.pass) return chip('pass', 'PASS');
  if (s > 0) return chip('partial', 'PARTIAL');
  return chip('fail', 'FAIL');
}

export function donutSvg(segs, centerText, { size = 104 } = {}) {
  const r = 40, cx = size / 2, cy = size / 2, sw = 16, C = 2 * Math.PI * r;
  const total = segs.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const arcs = segs.filter(s => s.value > 0).map(s => {
    const len = (s.value / total) * C;
    const a = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    acc += len;
    return a;
  }).join('');
  const center = centerText
    ? `<text x="${cx}" y="${cy}" class="mc-donut-center" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(centerText))}</text>` : '';
  return `<svg viewBox="0 0 ${size} ${size}" class="mc-donut" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>${arcs}${center}</svg>`;
}

export function fmtUnits(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// ---------- honesty blocks (non-negotiable, shared by both tabs) ----------

// The incomplete-snapshot warning. The MCP fetcher records which of its
// probes (scrape_configs, dashboards, recording_rules, alert_rules,
// metric_names) failed while drafting Pack B — a failed probe is a hole
// of unknown size in the live picture, and without this banner a flaky
// endpoint silently manufactures "drift". Wording answers three things
// in order: what happened, what it does to the numbers, what to do.
export function partialEvidenceBanner(model) {
  const ev = model.liveEvidence;
  if (!ev?.partial) return '';
  const aLabel = model.mode === 'drift' ? 'declared, not live' : 'beyond target';
  const ok = ev.attempted.filter(p => !ev.failed.includes(p));
  return `
    <div class="drift-partial-banner" title="Probe results recorded by the MCP fetcher in the pack's mcp.probesFailed annotation.${ok.length ? ` Answered: ${escapeHtml(ok.join(', '))}.` : ''}">
      <span class="drift-partial-key">⚠ PARTIAL LIVE EVIDENCE</span>
      <strong>The live snapshot is incomplete.</strong> While drafting <strong>${escapeHtml(model.bName)}</strong> from MCP,
      the <code>${escapeHtml(ev.failed.join(', '))}</code> probe${ev.failed.length === 1 ? ' got no answer' : 's got no answer'}
      (${ev.attempted.length - ev.failed.length} of ${ev.attempted.length} surfaces responded) — the endpoint was likely mid-deploy or overloaded.
      Anything that lives on the failed surface is invisible to this comparison, so
      <strong>"${escapeHtml(aLabel)}" is an upper bound, not a count</strong>.
      Redraft from MCP before acting on this drift.
    </div>`;
}

// Evidence ledger rows (field / expected / observed / status) — the same
// eight assertions the production report shows, derived from criteria.
export function buildEvidenceRows(diagnostic) {
  const all = [
    ...diagnostic.coverage.criteria,
    ...diagnostic.trust.criteria,
    ...(diagnostic.operability?.criteria || []),
  ];
  const C = (key) => all.find(c => c.key === key);
  const row = (field, exp, key, informational = false) => {
    const c = C(key);
    return { field, exp, obs: c?.detail || '—', pass: !!c?.pass, score: c?.score, informational };
  };
  return [
    row('spec.telemetry.backends[].signal', 'metrics + logs + traces (≥ 3 of 4)', 'multi-modal'),
    row('spec.otel.sdk.propagators', 'includes tracecontext', 'correlated'),
    row('spec.slos[].objective + spec.baselines', '≥ 1 SLO with numeric objective · MTTD/MTTR baselines declared', 'calibrated'),
    row('posture matrix · 4 layers × 10 mechanisms', 'average ≥ 50% observed', 'comprehensive'),
    row('spec.remediation[]', '≥ 1 remediation runbook declared (informational — not scored)', 'actionable', true),
    row('spec.validation.chaos_experiments[]', '≥ 1 chaos experiment declared', 'chaos-validated'),
    row('requirement derivation graph · fallback repo-vs-live diff / mcp probes',
      'declared SLO/SLI chains active in live; fallback ≥70% probes when no live pack is loaded', 'drift-free'),
    row('metadata.annotations.mcp.refreshedAt', 'within last 24h', 'fresh'),
  ];
}

export function scaffoldOosNotes(model) {
  const bits = [];
  if (model.totals.scaffold) {
    bits.push(`<p class="drift-oos-note">${model.totals.scaffold} schema-required scaffold artefact${model.totals.scaffold === 1 ? '' : 's'} had no source evidence in the selected environment. Shown in the pack, excluded from drift badness.</p>`);
  }
  if (model.totals.outOfScope) {
    bits.push(`<p class="drift-oos-note">${model.totals.outOfScope} live artefact${model.totals.outOfScope === 1 ? '' : 's'} out of declared scope — members of families <strong>${escapeHtml(model.bName)}</strong> runs but your pack doesn't declare (the rest of the platform inventory). Shown for context, not counted as drift.</p>`);
  }
  return bits.join('');
}

export function verificationNote(model) {
  const t = model.diagnostic.trust;
  const warn = !t.hasMcpSource
    ? `<div class="diag-banner"><span class="diag-banner-key">WARN</span>
        Pack A carries no live signal. Drift &amp; freshness require an MCP-drafted or live-refreshed pack to verify.</div>`
    : '';
  return `${warn}
    <p class="mc-verification-note">Verification, not validation: this grade attests that declared artefacts
    are <em>verified against live state</em> — it does not claim the observability design itself is right.</p>`;
}

export function operabilityNote(model) {
  const op = model.diagnostic.operability || {};
  return escapeHtml(op.note || 'response readiness, not diagnostic capability — observed, displayed, never scored');
}

// Fix-kind chip vocabulary shared by the triage surfaces.
export function fixChip(fix) {
  const map = {
    deploy: ['deploy', 'DEPLOY'],
    retrofeed: ['retrofeed', 'RETROFEED'],
    adopt: ['retrofeed', 'ADOPT'],
    reconcile: ['reconcile', 'FIELD DECISION'],
    manual: ['manual', 'MANUAL'],
    'beyond-target': ['manual', 'BEYOND TARGET'],
  };
  const [cls, text] = map[fix] || ['manual', String(fix).toUpperCase()];
  return `<span class="mc-fix is-${cls}">${text}</span>`;
}

export function badnessClassChip(item) {
  if (item.kind === 'drifted') {
    const label = { decision: 'DECISION-BEARING', default: 'DEFAULT', cosmetic: 'COSMETIC' }[item.badnessClass] || 'DEFAULT';
    return chip(item.badnessClass === 'decision' ? 'fail' : item.badnessClass === 'cosmetic' ? 'info' : 'partial', label);
  }
  if (item.kind === 'onlyInA') return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING LIVE' : 'EXTRA');
  return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING' : 'SHADOW');
}
