// studio/proto-shared.mjs
//
// Shared substrate for the three UX-redesign prototypes (?proto=a|b|c —
// see docs/UX_REDESIGN_BRIEF.md). Everything here CONSUMES the ratified
// engines (diagnostic-grade, /api/diff, journeys) — no engine logic is
// duplicated, no numbers are invented. The prototypes are view-layer
// only and live behind the query param; none of this executes in the
// production tabs.
//
// Three responsibilities:
//   1. buildProtoModel()  — one normalized read of the verdict + drift
//      universe (per-item badness, biggest-gap attribution, honesty flags).
//   2. projectGrade()     — the "fixing these N takes you from B to A"
//      sentence, computed by RE-RUNNING the real grade engine on a
//      hypothetical post-fix diff. Conservative: requirement-chain
//      integrity is held constant, freshness/chaos are never projected.
//   3. Widgets            — KPI tiles, sparklines, chips, donuts, the
//      instrument ladder, and the honesty blocks (partial-evidence,
//      scaffold, out-of-scope, verification≠validation) every variant
//      must carry verbatim in spirit.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml } from './util.mjs';
import { diffEntryLabel, deploySelectionFromEntries, deploySurfaceForArtefact } from './artifact-model.mjs';
import {
  computeDiagnosticGrade,
  computePostureMatrix,
  computeWeightedDeltaRisk,
  compareModeFor,
  driftedEntryBadness,
  isScaffoldDiffEntry,
  partialLiveEvidence,
  criterionScore,
  INSTRUMENT_GRADE_SCALE,
  DELTA_BADNESS,
} from './diagnostic-grade.mjs';
import { catalogEntryFor, loadDiff, LAYERS_FOR_DIFF } from './compare-view.mjs';
import { host as appHost } from './host.mjs';

export const PROTO_LAYER_NAMES = {
  L1: 'Contract', L2: 'Telemetry', L2X: 'Extended', L3: 'Insight',
  L4: 'Action', L5: 'Validation', GOV: 'Governance',
};

// ---------- comparison loading gate ----------
//
// Mirrors the production Diagnose behaviour (don't regress the spinner /
// retry): when a Pack B is selected but the pack or diff hasn't arrived,
// render motion + a retry path and return true so the caller bails.
export function protoEnsureComparison(host) {
  const haveB = !!state.packB;
  if (!state.compareBId || (haveB && (state.diff || state.diff?.error))) return false;
  const loading = document.createElement('div');
  loading.className = 'placeholder loading-compare';
  loading.innerHTML = `
    <span class="compare-spinner" aria-hidden="true"></span>
    <span>Comparing <strong>${escapeHtml(state.pack?.name || 'pack A')}</strong> against <strong>${escapeHtml(String(state.compareBId))}</strong>…</span>
    <span class="loading-compare-sub">matching artefacts by behavioural identity — large packs take a few seconds</span>
  `;
  host.appendChild(loading);
  Promise.all([
    haveB ? Promise.resolve() : appHost.loadPackB(),
    (state.diff && !state.diff.error) ? Promise.resolve() : loadDiff(),
  ]).then(() => { appHost.renderTabs(); appHost.renderMainView(); })
    .catch((e) => {
      loading.classList.remove('loading-compare');
      loading.innerHTML = `
        <span>Comparison failed to load: ${escapeHtml(e?.message || 'unknown error')}</span>
        <button type="button" class="ctrl-btn loading-compare-retry">retry</button>
      `;
      loading.querySelector('.loading-compare-retry')?.addEventListener('click', () => appHost.renderMainView());
    });
  return true;
}

// ---------- the normalized model ----------

// Stable identity for a diff entry inside the prototype layer — used to
// match basket selections back to entries when building the hypothetical
// post-fix diff. diff entries carry a server `key`; fall back to the label.
function entryUid(L, kind, entry) {
  return `${L}::${kind}::${entry.key || diffEntryLabel(entry)}`;
}

export function buildProtoModel() {
  const haveB = !!state.packB;
  const posture = computePostureMatrix(state.pack, state.packB);
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  const diagnostic = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diff);
  const mode = compareModeFor(state.packB, state.compareBId);
  const bName = catalogEntryFor(state.compareBId)?.label
    || state.packB?.meta?.name || state.packB?.metadata?.name || state.packB?.id || 'Pack B';

  const totals = { aligned: 0, drifted: 0, onlyInA: 0, onlyInB: 0, scaffold: 0, outOfScope: 0 };
  const layers = [];
  const items = [];
  const driftedEntries = [];

  if (diff) {
    for (const L of LAYERS_FOR_DIFF) {
      const bucket = diff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };
      const matched = (bucket.inBoth || []).filter(e => !isScaffoldDiffEntry(e));
      const aligned = matched.filter(e => e.match !== 'drifted');
      const drifted = matched.filter(e => e.match === 'drifted');
      const onlyInA = (bucket.onlyInA || []).filter(e => !isScaffoldDiffEntry(e));
      const onlyInB = (bucket.onlyInB || []).filter(e => !isScaffoldDiffEntry(e));
      const scaffold = [
        ...(bucket.onlyInA || []), ...(bucket.onlyInB || []), ...(bucket.inBoth || []),
      ].filter(e => isScaffoldDiffEntry(e));
      const outOfScope = bucket.outOfScope || [];

      totals.aligned += aligned.length;
      totals.drifted += drifted.length;
      totals.onlyInA += onlyInA.length;
      totals.onlyInB += onlyInB.length;
      totals.scaffold += scaffold.length;
      totals.outOfScope += outOfScope.length;
      driftedEntries.push(...drifted);

      if (aligned.length || drifted.length || onlyInA.length || onlyInB.length || outOfScope.length) {
        layers.push({ L, name: PROTO_LAYER_NAMES[L] || L, aligned, drifted, onlyInA, onlyInB, outOfScope });
      }

      // Per-item triage entries with their REAL badness weight — same
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

  // Deployable selection across the whole declared-not-live set (the
  // "deploy the missing set" action — same arithmetic as production).
  const onlyInAArts = layers.flatMap(r => r.onlyInA.map(e => e.artefact).filter(Boolean));
  const deployableSet = mode === 'drift'
    ? deploySelectionFromEntries(onlyInAArts.map(a => deploySurfaceForArtefact(a)))
    : { identities: new Set(), rows: 0 };

  return {
    haveB, posture, diff, diagnostic, mode, bName,
    totals, layers, items, weighted, biggestGap, deployableSet,
    liveEvidence: partialLiveEvidence(state.packB),
    overallPct: diagnostic.overall.total === 0 ? 0
      : Math.round((diagnostic.overall.passed / diagnostic.overall.total) * 100),
  };
}

// ---------- grade projection ----------
//
// "Fixing these N takes you from B (65%) to A (87%)" — computed by the
// REAL engine on a hypothetical diff where the given items are resolved:
// declared-not-live entries verify live, drifted entries re-align,
// live-not-declared entries get adopted. HONESTY FENCE: the requirement-
// chain graph is held constant (deploying may repair chains — we do not
// claim it), and freshness / chaos-validated are never projected. When
// the drift criterion is anchored on chain integrity the projection can
// legitimately be flat — `chainAnchored` lets the view say so.
export function projectGrade(uids /* Set<string> | null = fix everything */) {
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  if (!diff) return null;
  const fixAll = !uids;
  const isFixed = (L, kind, e) => fixAll || uids.has(entryUid(L, kind, e));

  const hypoLayers = {};
  for (const L of Object.keys(diff.layers)) {
    const bucket = diff.layers[L] || {};
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
  const hypo = { ...diff, layers: hypoLayers };

  const posture = computePostureMatrix(state.pack, state.packB);
  const before = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diff);
  const after = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, hypo);
  return {
    before, after,
    beforePct: Math.round(before.overall.audit.scorePctExact),
    afterPct: Math.round(after.overall.audit.scorePctExact),
    chainAnchored: (diff.traceabilityGraph?.rollup?.declaredTotal || 0) > 0,
  };
}

// One sentence the demo hinges on. Returns '' when there is nothing to fix.
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
let _runs = null;   // { journey: string|null, runs: [{gradeScore, alignmentPct, at, outcome}] } | null

export function runHistory() { return _runs; }

// Fire-and-forget loader: views call this; when it resolves with data the
// view re-renders once and runHistory() is populated. Cached per session.
export function loadRunHistory(onReady) {
  if (_runs) { return; }
  if (_runsPromise) { _runsPromise.then(onReady); return; }
  _runsPromise = (async () => {
    try {
      const { journeys = [] } = await api('/api/journeys');
      const j = journeys.find(x => x.lastRun) || journeys[0];
      if (!j) { _runs = { journey: null, runs: [] }; return; }
      const { runs = [] } = await api(`/api/journeys/${encodeURIComponent(j.name)}/runs?limit=20`);
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
    <svg class="proto-spark" viewBox="0 0 ${w} ${h}" aria-hidden="true" preserveAspectRatio="none">
      <polyline points="${pts.join(' ')}" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
      <circle cx="${last[0]}" cy="${last[1]}" r="2.2" fill="currentColor"/>
    </svg>`;
}

// A mission-control stat tile. series/delta are optional; when run history
// is absent the tile says so instead of faking a trend.
export function kpiTile({ accent = 'cmp', label, value, unit = '', series = null, deltaText = '', note = '', warn = false }) {
  const spark = series ? sparklineSvg(series) : '';
  return `
    <div class="proto-tile is-${accent}${warn ? ' is-warn' : ''}">
      <div class="proto-tile-label">${escapeHtml(label)}</div>
      <div class="proto-tile-value">${value}<span class="proto-tile-unit">${escapeHtml(unit)}</span></div>
      <div class="proto-tile-trend">${spark}${deltaText ? `<span class="proto-tile-delta">${escapeHtml(deltaText)}</span>` : ''}</div>
      ${note ? `<div class="proto-tile-note">${escapeHtml(note)}</div>` : ''}
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
  return `<span class="proto-chip is-${escapeHtml(status)}">${escapeHtml(text)}</span>`;
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
    ? `<text x="${cx}" y="${cy}" class="proto-donut-center" text-anchor="middle" dominant-baseline="central">${escapeHtml(String(centerText))}</text>` : '';
  return `<svg viewBox="0 0 ${size} ${size}" class="proto-donut" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>${arcs}${center}</svg>`;
}

export function fmtUnits(n) {
  return Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
}

// The instrument-grade ladder — same scale, prototype skin.
export function ladderHtml(ig, overallPct, { compact = false } = {}) {
  return `
    <ul class="proto-ladder${compact ? ' is-compact' : ''}">
      ${INSTRUMENT_GRADE_SCALE.map(g => {
        const current = g.letter === ig.letter;
        const unreachable = g.minPct === null;
        const tip = g.blurb + (unreachable ? ` Requires ${g.requires}.` : '') + (current ? ` ← this pack: ${overallPct}%.` : '');
        return `
        <li class="proto-rung tier-${g.tier}${current ? ' is-current' : ''}${unreachable ? ' is-unreachable' : ''}" title="${escapeHtml(tip)}">
          <span class="proto-rung-letter">${escapeHtml(g.letter)}</span>
          ${compact ? '' : `<span class="proto-rung-label">${escapeHtml(g.label)}</span>`}
          <span class="proto-rung-range">${escapeHtml(g.range)}</span>
        </li>`;
      }).join('')}
    </ul>`;
}

// ---------- honesty blocks (non-negotiable, shared across variants) ----------

export function partialEvidenceBanner(model) {
  const ev = model.liveEvidence;
  if (!ev?.partial) return '';
  const aLabel = model.mode === 'drift' ? 'Declared, not live' : 'Beyond target';
  return `
    <div class="drift-partial-banner">
      <span class="drift-partial-key">⚠ PARTIAL LIVE EVIDENCE</span>
      ${ev.failed.length} of ${ev.attempted.length} probe${ev.failed.length === 1 ? '' : 's'} failed during the live draft
      (<code>${escapeHtml(ev.failed.join(', '))}</code>) — the live endpoint was likely mid-deploy or overloaded.
      Pack B may be missing whole surfaces, so <strong>"${escapeHtml(aLabel)}" is probably overstated</strong>.
      Redraft from MCP before acting on this drift.
    </div>`;
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
    <p class="proto-verification-note">Verification, not validation: this grade attests that declared artefacts
    are <em>verified against live state</em> — it does not claim the observability design itself is right.</p>`;
}

export function operabilityNote(model) {
  const op = model.diagnostic.operability || {};
  return escapeHtml(op.note || 'response readiness, not diagnostic capability — observed, displayed, never scored');
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

// Deploy selection over triage items (optionally restricted to a basket of
// item uids) — same identity/rows arithmetic as the production deploy modal.
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
  return `<span class="proto-fix is-${cls}">${text}</span>`;
}

export function badnessClassChip(item) {
  if (item.kind === 'drifted') {
    const label = { decision: 'DECISION-BEARING', default: 'DEFAULT', cosmetic: 'COSMETIC' }[item.badnessClass] || 'DEFAULT';
    return chip(item.badnessClass === 'decision' ? 'fail' : item.badnessClass === 'cosmetic' ? 'info' : 'partial', label);
  }
  if (item.kind === 'onlyInA') return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING LIVE' : 'EXTRA');
  return chip(item.badness >= 1 ? 'fail' : 'info', item.badness >= 1 ? 'MISSING' : 'SHADOW');
}
