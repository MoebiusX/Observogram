// studio/compare-view.mjs
//
// The Compare / Diagnose machinery — pack-vs-pack diff (loadDiff/refreshDiff),
// the Diagnose sub-views (benchmark, drift drill, posture matrix, diagnostic
// grade, traceability), and the side-by-side Compare view. The largest single
// cluster; its many functions cross-call each other, so they live together.
// Re-render / loader / modal entrypoints come through the studio host seam
// (host.mjs); a couple of pack helpers are still imported back from app.mjs
// and the card opener from drawer.mjs (safe call-time cycles).

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from './constants.mjs';
import { openDrawer } from './drawer.mjs';
import { defaultEnvFor, refresh } from './app.mjs';
import { host as appHost } from './host.mjs';
import { cardKey } from './layers-view.mjs';
import { diffEntryLabel, deploySelectionFromEntries, deploySurfaceForArtefact, prettyDiffKey } from './artifact-model.mjs';
import {
  POSTURE_LAYERS,
  POSTURE_MECHANISMS_PER_LAYER,
  compareModeFor,
  computeDiagnosticGrade,
  computeWeightedDeltaRisk,
  computePostureMatrix,
  layerItemsFor,
  criterionScore,
  diagnosticAuditStatus,
  INSTRUMENT_GRADE_SCALE,
  instrumentGradeFor,
  isScaffoldDiffEntry,
  partialLiveEvidence,
} from './diagnostic-grade.mjs';
import { catalogEntryFor, LAYERS_FOR_DIFF } from './compare-catalog.mjs';
// Diagnose (Assessment + Compare) screen grammar. Namespaced so the
// traceability section's own ux-kit imports can never collide with these.
import * as diagUx from './ux-kit.mjs';
import { driftedEntryBadness as diagDriftCost } from './diagnostic-grade.mjs';

// Requirements traceability (the TRACEABILITY VIEW section below).
import { decisionHeaderHtml, disclosureHtml, emptyStateHtml, LAYER_PURPOSE, layerTitle, plural, wireUxActions } from './ux-kit.mjs';
import { LINK_STATES, readTraceability, traceIssue } from './trace-chain.mjs';

// Re-exported: these two lived here before moving to compare-catalog.mjs
// (kept importable from the view for compile-view.mjs and proto-shared.mjs).
export { catalogEntryFor, LAYERS_FOR_DIFF };

// ---------- compare view ----------

const COMPARE_LAYERS = [
  { id: 'L1',  name: 'Contract'    },
  { id: 'L2',  name: 'Telemetry'   },
  { id: 'L2X', name: 'Extended'    },
  { id: 'L3',  name: 'Insight'     },
  { id: 'L4',  name: 'Action'      },
  { id: 'L5',  name: 'Validation'  },
  { id: 'GOV', name: 'Governance'  },
];

function defaultCompareB() {
  // First catalog pack that loaded OK and isn't the current A.
  return state.catalog.find(p => p.ok && p.id !== state.selectedPackId)?.id || null;
}

// The selection tuple a diff is computed for. loadDiff stamps it on the
// result as `__for`, and diffMatchesSelection() re-checks it at read time.
// This guard is load-bearing: many flows swap Pack A / env A without
// touching state.diff (header pickers, service fallback, uploads), and
// adapter ids are positional (SLI-01, DASH-02…), so a stale diff would
// confidently mislabel the new pack's cards instead of failing closed.
function diffSelection() {
  return {
    a: state.selectedPackId || null,
    b: state.compareBId || null,
    aEnv: state.selectedEnv || null,
    bEnv: state.compareBEnv || null,
    scopeMode: activeDiffScopeMode(),
    service: state.selectedService || null,
  };
}

export function diffMatchesSelection(diff) {
  const f = diff?.__for;
  if (!f) return false;
  const sel = diffSelection();
  return f.a === sel.a && f.b === sel.b && f.aEnv === sel.aEnv &&
    f.bEnv === sel.bEnv && f.scopeMode === sel.scopeMode && f.service === sel.service;
}

// One in-flight fetch per selection tuple — concurrent renders while a
// diff loads share the request instead of stampeding the server.
let diffInFlight = null;

export async function loadDiff() {
  if (!state.selectedPackId || !state.compareBId) { state.diff = null; return; }
  const requested = diffSelection();
  const key = JSON.stringify(requested);
  if (diffInFlight?.key === key) return diffInFlight.promise;
  const params = new URLSearchParams({ a: requested.a, b: requested.b });
  if (requested.aEnv) params.set('aEnv', requested.aEnv);
  if (requested.bEnv) params.set('bEnv', requested.bEnv);
  params.set('scopeMode', requested.scopeMode);
  if (requested.service) params.set('service', requested.service);
  const promise = (async () => {
    let next;
    try {
      const result = await api(`/api/diff?${params}`);
      // Sanity-check the shape so a stale server returning some other JSON
      // doesn't crash later renderers.
      if (!result || !result.summary || !result.layers) {
        throw new Error('server returned an unexpected shape — restart `npm run dev`?');
      }
      next = result;
    } catch (e) {
      next = { error: e.message };
    }
    next.__for = requested;
    // A slow response for a superseded selection must not clobber the
    // current one — drop it and let the current selection's own fetch win.
    if (JSON.stringify(diffSelection()) === key) state.diff = next;
    if (diffInFlight?.key === key) diffInFlight = null;
  })();
  diffInFlight = { key, promise };
  return promise;
}

export function activeDiffScopeMode() {
  return normalizeDiffScopeMode(state.diffScopeMode || state.pack?.meta?.diffScopeMode);
}

function normalizeDiffScopeMode(value) {
  const raw = String(value || 'service').trim().toLowerCase();
  if (raw === 'family' || raw === 'legacy' || raw === 'off') return 'family';
  if (raw === 'all' || raw === 'none' || raw === 'strict') return 'all';
  return 'service';
}

export async function refreshDiff() {
  await loadDiff();
  // Don't nullify state.packB here — earlier code paths set it and rely
  // on the diff being decoupled from the pack itself. The previous
  // "invalidate B so the atlas refetches" comment was wrong: the atlas
  // dispatches on state.packB directly, so nulling it here just forced
  // a redundant network round-trip AND silently broke the view nav's
  // "Compare/Atlas appear when B is loaded" rule on every diff refresh.
  appHost.renderTabs();
  appHost.renderMainView();
}

// ============================================================
// TRACEABILITY VIEW — repo vs live, but actionable
// ============================================================
//
// Compare shows raw deltas per layer. Useful for engineers reading the
// diff first-hand, but it leaves the harder question — "what should I do
// about this?" — to the reader. Traceability answers that by re-binning
// the server diff's buckets (behavioural identity matching + contract
// agreement — the same engine behind the Diagnose verdict) into four
// actionable piles:
//
//   Aligned                    shared identity AND the behavioural contract agrees
//   Declared, not seen live    only in pack A (the manifest)
//   Live only, not declared    only in pack B (live)
//   Declared differently       shared identity but the deployed contract
//                              diverges (a stale declaration)
//
// Since the 2026-09 UX review these findings sit UNDER the requirement
// list (renderRequirementTraceabilityBlock): the screen leads with which
// SLOs/SLIs have a broken proof chain, and the repo-vs-live piles follow
// as details.
//
// Live artefacts the diff parks as out-of-scope (families or services
// Pack A never declares) are excluded here, and scaffold placeholders are
// parked the same way the drift drill parks them — so these buckets
// reconcile with the drill's UNLENSED totals. The drill additionally
// applies the active product lens; this view deliberately does not.
//
// Convention: Pack A is treated as the manifest ("declared"), Pack B as
// the live signal ("verified"). The unlock means either pack can be in
// either slot, but most repo-vs-live flows put the repo pack in A and
// the MCP-fetched pack in B (that's where the home screen + the cron
// fetcher both put them).
//
// Severity:
//   - Declared-not-verified on a tier-1 SLI/SLO  → red  (the spec
//     contractually promised an outcome and we can't see it in live)
//   - Stale declaration                           → amber
//   - Everything else                             → neutral
//
// Per-finding actions:
//   - Open      jumps to the layers view + opens the drawer
//   - Suppress  hides the row from this bucket (persisted via tracePrefs)
//   - Resolve   marks the row resolved (persisted via tracePrefs)

const TRACE_LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Re-bin the server diff's buckets into the four traceability piles.
// Identity pairing and aligned-vs-drifted both come from the behavioural
// engine (identityKeyOf + deltasOf, server-side) — never re-derived here
// with id or shape equality, which mis-binned renamed backends and
// volatile-field differences. `key` is the entry's behavioural identity
// key; findingKey namespaces it per layer for the suppress/resolve prefs.
function categorizeTrace(diff) {
  const buckets = { aligned: [], declaredNotVerified: [], verifiedNotDeclared: [], stale: [], scaffoldParked: 0 };
  const tier = state.pack?.meta?.criticality || state.packB?.meta?.criticality || 'tier-3';
  // Suppress/resolve prefs persist on findingKey. Collision entries carry
  // order-dependent #NN ordinals (the diff's pairing order can reshuffle
  // them between live redrafts), so those keys get the embedded artefact's
  // own symbol appended — best-effort stability, not a guarantee.
  const findingKeyFor = (L, e, art) =>
    /#\d+$/.test(e.key) ? `${L}::${e.key}::${art?.defines || art?.id || ''}` : `${L}::${e.key}`;
  for (const L of TRACE_LAYERS) {
    const bucket = diff?.layers?.[L];
    if (!bucket) continue;
    for (const e of bucket.inBoth || []) {
      if (isScaffoldDiffEntry(e)) { buckets.scaffoldParked++; continue; }
      const row = { layer: L, key: e.key, findingKey: findingKeyFor(L, e, e.a), a: e.a, b: e.b, deltas: e.deltas || [], tier };
      if (e.match === 'drifted') buckets.stale.push(row);
      else buckets.aligned.push(row);
    }
    for (const e of bucket.onlyInA || []) {
      if (isScaffoldDiffEntry(e)) { buckets.scaffoldParked++; continue; }
      buckets.declaredNotVerified.push({ layer: L, key: e.key, findingKey: findingKeyFor(L, e, e.artefact), a: e.artefact, tier });
    }
    for (const e of bucket.onlyInB || []) {
      if (isScaffoldDiffEntry(e)) { buckets.scaffoldParked++; continue; }
      buckets.verifiedNotDeclared.push({ layer: L, key: e.key, findingKey: findingKeyFor(L, e, e.artefact), b: e.artefact, tier });
    }
  }
  return buckets;
}

// Severity hint for a finding. Tier-1 SLIs/SLOs that are declared but
// not verified are the red flags. Stale is always amber. Everything
// else is neutral.
function traceFindingSeverity(bucket, finding) {
  if (bucket === 'declaredNotVerified') {
    if (finding.tier === 'tier-1' && finding.layer === 'L1') return 'red';
    return 'neutral';
  }
  if (bucket === 'stale') return 'amber';
  return 'neutral';
}

const BUCKET_META = {
  aligned:             { label: 'Aligned',                  blurb: 'Declared and live agree: same behaviour, same contract. Nothing to do.', empty: 'Nothing is aligned yet.' },
  declaredNotVerified: { label: 'Declared, not seen live',  blurb: 'In the repository but not found live: a stale declaration, or live collection is broken.', empty: 'Everything declared was found live.' },
  verifiedNotDeclared: { label: 'Live only, not declared',  blurb: 'Found live with no entry in the repository: drift or out-of-band telemetry. Additional, not a defect by itself.', empty: 'Nothing found live is missing from the repository.' },
  stale:               { label: 'Declared differently',     blurb: 'Same behaviour, but the live contract differs from the declared one (a stale declaration). Reconcile.', empty: 'No declaration differs from live.' },
};

function ensureTracePrefs() {
  if (!state.tracePrefs || typeof state.tracePrefs !== 'object') state.tracePrefs = { suppressed: [], resolved: [] };
  if (!Array.isArray(state.tracePrefs.suppressed)) state.tracePrefs.suppressed = [];
  if (!Array.isArray(state.tracePrefs.resolved))   state.tracePrefs.resolved = [];
}

function isTraceSuppressed(findingKey) {
  ensureTracePrefs();
  return state.tracePrefs.suppressed.includes(findingKey);
}
function isTraceResolved(findingKey) {
  ensureTracePrefs();
  return state.tracePrefs.resolved.includes(findingKey);
}
function toggleTraceSuppressed(findingKey) {
  ensureTracePrefs();
  const i = state.tracePrefs.suppressed.indexOf(findingKey);
  if (i >= 0) state.tracePrefs.suppressed.splice(i, 1);
  else state.tracePrefs.suppressed.push(findingKey);
}
function toggleTraceResolved(findingKey) {
  ensureTracePrefs();
  const i = state.tracePrefs.resolved.indexOf(findingKey);
  if (i >= 0) state.tracePrefs.resolved.splice(i, 1);
  else state.tracePrefs.resolved.push(findingKey);
}

export function renderTraceabilityView(host) {
  ensureTracePrefs();
  const section = document.createElement('section');
  section.className = 'section trace-view';
  section.dataset.layer = 'TRACE';

  if (!state.pack) {
    section.innerHTML = '<div class="placeholder">Load a pack first.</div>';
    host.appendChild(section);
    return;
  }

  // The requirement list leads (review §3 "Requirements traceability"); the
  // repo-vs-live findings follow it as details.
  const requirementBlock = renderRequirementTraceabilityBlock(state.pack);
  if (requirementBlock) section.appendChild(requirementBlock);

  if (!state.packB && !state.compareBId) {
    if (!requirementBlock) {
      section.innerHTML = emptyStateHtml({
        title: 'No SLI or SLO requirements in this pack.',
        checked: `the SLOs and SLIs declared by ${state.pack?.meta?.name || 'this pack'}`,
        body: 'Traceability follows each objective to the metrics, rules, scrape jobs, dashboards and alerts that prove it. Declare an SLO, or pick a live pack as Pack B to compare the repository with live.',
      });
    }
    host.appendChild(section);
    return;
  }

  // The buckets come from the server diff (behavioural matching). A Pack B
  // pick normally loads it already, but guard the races: diff still in
  // flight, stale for the current selection, or failed — never fall back
  // to a client-side re-derivation.
  const diffCurrent = !!state.diff && diffMatchesSelection(state.diff);
  const haveDiff = diffCurrent && !state.diff.error && !!state.diff.layers;
  if (!state.packB || !haveDiff) {
    const notice = document.createElement('div');
    if (diffCurrent && state.diff?.error) {
      notice.className = 'error';
      notice.textContent = `Diff failed: ${state.diff.error}`;
      section.appendChild(notice);
      host.appendChild(section);
      return;
    }
    if (!state.selectedPackId) {
      // Pack A never registered with the server (edge upload path) — the
      // diff endpoint can't compare it, so fail honestly rather than
      // re-entering this branch on every render.
      notice.className = 'error';
      notice.textContent = 'Traceability needs Pack A registered on the server — re-upload or rescan it, then retry.';
      section.appendChild(notice);
      host.appendChild(section);
      return;
    }
    notice.className = 'placeholder loading-compare';
    notice.innerHTML = `
      <span class="compare-spinner" aria-hidden="true"></span>
      <span>Comparing <strong>${escapeHtml(state.pack?.name || 'pack A')}</strong> against <strong>${escapeHtml(String(state.compareBId))}</strong>…</span>
      <span class="loading-compare-sub">matching artefacts by behavioural identity — large packs take a few seconds</span>
    `;
    section.appendChild(notice);
    host.appendChild(section);
    Promise.all([
      state.packB ? Promise.resolve() : appHost.loadPackB(),
      haveDiff ? Promise.resolve() : loadDiff(),
    ]).then(() => {
      // Re-render only when the load actually progressed; re-entering this
      // branch with nothing changed would spin a synchronous render loop.
      if (state.packB && state.diff) { appHost.renderTabs(); appHost.renderMainView(); return; }
      notice.classList.remove('loading-compare');
      notice.textContent = 'Comparison failed to load — pick Pack B again or reload.';
    }).catch((e) => {
        notice.classList.remove('loading-compare');
        notice.textContent = `Comparison failed to load: ${e?.message || 'unknown error'}`;
      });
    return;
  }

  const buckets = categorizeTrace(state.diff);
  const suppressedSet = new Set(state.tracePrefs.suppressed);
  const resolvedSet   = new Set(state.tracePrefs.resolved);

  // Totals for the disclosure's summary line and the section head.
  const totalAligned = buckets.aligned.length;
  const totalDnV     = buckets.declaredNotVerified.length;
  const totalVnD     = buckets.verifiedNotDeclared.length;
  const totalStale   = buckets.stale.length;
  const total        = totalAligned + totalDnV + totalVnD + totalStale;

  // Repo compared with live: kept whole, but as details under the
  // requirement list (open by default only when it is all there is).
  const repoLive = document.createElement('details');
  repoLive.className = 'ux-disclosure trace-repo-live';
  repoLive.id = 'trace-repo-live';
  repoLive.open = requirementBlock ? !!state.traceRepoLiveOpen : true;
  repoLive.addEventListener('toggle', () => { state.traceRepoLiveOpen = repoLive.open; });
  const repoSummary = document.createElement('summary');
  repoSummary.textContent = `Repository compared with live: ${plural(total, 'artefact')} — ${totalAligned} aligned, ${totalDnV} declared but not seen live, ${totalStale} declared differently, ${totalVnD} only live`;
  repoLive.appendChild(repoSummary);
  const repoBody = document.createElement('div');
  repoBody.className = 'ux-disclosure-body';
  repoLive.appendChild(repoBody);

  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">TRC</span>
    <span class="section-name">Repository (Pack A, declared) compared with live (Pack B)</span>
    <span class="section-count">${plural(total, 'artefact')}</span>
  `;
  repoBody.appendChild(head);

  const lede = document.createElement('div');
  lede.className = 'trace-lede';
  const outOfScopeTotal = TRACE_LAYERS.reduce((n, L) => n + (state.diff.layers[L]?.outOfScope?.length || 0), 0);
  lede.innerHTML = `
    Pack A is treated as the repository’s declaration and Pack B as what the live platform shows.
    Artefacts are paired by <em>behavioural identity</em> (what they do, not what they’re named) and land in
    one of four groups; per-row actions persist locally so suppressions and resolutions survive a refresh.
    Dashboard panels are compared at dashboard granularity, not listed individually.
    ${outOfScopeTotal ? `${plural(outOfScopeTotal, 'live artefact')} outside this pack's scope ${outOfScopeTotal === 1 ? 'is' : 'are'} parked by the live-scope setting below.` : ''}
    ${buckets.scaffoldParked ? `${plural(buckets.scaffoldParked, 'template placeholder')} (crawler stubs, not deployed contract) ${buckets.scaffoldParked === 1 ? 'is' : 'are'} parked, matching the drift drill.` : ''}
  `;
  repoBody.appendChild(lede);
  repoBody.appendChild(renderLiveScopeControl({ standalone: true }));

  // Headline cards — one per bucket. Click to show or hide its findings.
  const headlineGrid = document.createElement('div');
  headlineGrid.className = 'trace-headline-grid';
  const order = ['aligned', 'declaredNotVerified', 'verifiedNotDeclared', 'stale'];
  for (const key of order) {
    const items = buckets[key];
    const meta  = BUCKET_META[key];
    const count = items.length;
    const open  = state.traceOpen?.[key];
    const card  = document.createElement('button');
    card.type = 'button';
    card.className = 'trace-headline trace-headline-' + key;
    card.dataset.open = String(!!open);
    card.setAttribute('aria-expanded', String(!!open));
    card.setAttribute('aria-controls', `trace-block-${key}`);
    card.innerHTML = `
      <div class="trace-headline-key">${escapeHtml(meta.label)}</div>
      <div class="trace-headline-count">${count}</div>
      <div class="trace-headline-blurb">${escapeHtml(meta.blurb)}</div>
    `;
    card.onclick = () => {
      if (!state.traceOpen) state.traceOpen = {};
      state.traceOpen[key] = !state.traceOpen[key];
      state.traceRepoLiveOpen = true;
      appHost.renderMainView();
    };
    headlineGrid.appendChild(card);
  }
  repoBody.appendChild(headlineGrid);

  // Per-bucket details. Each finding row carries Open / Suppress / Resolve.
  for (const key of order) {
    const items = buckets[key];
    const meta  = BUCKET_META[key];
    const open  = !!state.traceOpen?.[key];
    const block = document.createElement('div');
    block.className = 'trace-block trace-block-' + key;
    block.id = `trace-block-${key}`;
    block.hidden = !open;

    const blockHead = document.createElement('div');
    blockHead.className = 'trace-block-head';
    blockHead.innerHTML = `
      <span class="trace-block-label">${escapeHtml(meta.label)}</span>
      <span class="trace-block-count">${items.length}</span>
    `;
    block.appendChild(blockHead);

    if (!items.length) {
      const empty = document.createElement('div');
      empty.className = 'trace-empty';
      empty.textContent = meta.empty;
      block.appendChild(empty);
      repoBody.appendChild(block);
      continue;
    }

    // Hide suppressed rows by default; reveal under a "show suppressed" toggle.
    const visible    = items.filter(f => !suppressedSet.has(f.findingKey));
    const suppressed = items.filter(f =>  suppressedSet.has(f.findingKey));

    const list = document.createElement('div');
    list.className = 'trace-list';
    for (const f of visible) list.appendChild(renderTraceRow(key, f, resolvedSet));
    block.appendChild(list);

    if (suppressed.length) {
      const sup = document.createElement('details');
      sup.className = 'trace-suppressed';
      const sum = document.createElement('summary');
      sum.textContent = `${plural(suppressed.length, 'suppressed finding')}`;
      sup.appendChild(sum);
      const supList = document.createElement('div');
      supList.className = 'trace-list trace-list-suppressed';
      for (const f of suppressed) supList.appendChild(renderTraceRow(key, f, resolvedSet));
      sup.appendChild(supList);
      block.appendChild(sup);
    }
    repoBody.appendChild(block);
  }

  section.appendChild(repoLive);
  host.appendChild(section);
}

// ---------- requirement traceability: one list, one chain at a time ----------
//
// The 2026-09 UX review (§3 "Requirements traceability"): all 18
// requirements used to be expanded into repeated six-lane matrices, a
// bare "20 jobs observed" read as scrape proof, and the summary counted
// what exists anywhere as if it were linked. Now the screen leads with a
// decision, a table separating "exists somewhere" from "linked" and
// "proven for its requirement", and a list sorted worst first — name,
// chain state, first broken link, next action — where one requirement at
// a time expands into its proof chain. The reading itself (link states,
// plain-language issue labels, issue groups) is studio/trace-chain.mjs.

// Open a Discover layer, with an artefact's card active and its drawer
// open when one is given. Shared by the requirement list and the repo-vs-
// live rows.
function openArtefactInLayers(layer, art) {
  state.view = 'layers';
  state.layerFilter = layer;
  state.activeLayer = layer;
  state.activeCardKey = art ? cardKey(layer, art._sub || null, art.id) : null;
  appHost.renderTabs();
  appHost.renderMainView();
  if (art) {
    const layerDef = LAYER_DEFS.find(d => d.id === layer) || { id: layer };
    try { openDrawer(art, layerDef, art._sub || null); } catch { /* the drawer is best-effort; Discover already shows the card */ }
  }
}

// A requirement-chain target ({ layer, id? }) is always Pack A's: the
// chains are read from state.pack, so Discover must show Pack A.
function openTraceTarget(target) {
  if (!target?.layer) return;
  const art = target.id ? layerItemsFor(state.pack, target.layer).find(it => it.id === target.id) || null : null;
  state.viewFocus = 'a';
  openArtefactInLayers(target.layer, art);
}

function rtLinkChipHtml(stateKey) {
  const s = LINK_STATES[stateKey] || LINK_STATES.missing;
  return `<span class="ux-chip ux-chip-${s.tone} ux-chip-evidence rt-link-chip" title="${escapeHtml(`Link — ${s.tip}`)}">${escapeHtml(s.label)}</span>`;
}

function rtChainChipHtml(row) {
  return `<span class="ux-chip ux-chip-${row.tone} ux-chip-assessment rt-chain-chip" title="${escapeHtml(chainStateTip(row.stateKey))}">${escapeHtml(row.label)}</span>`;
}

function chainStateTip(stateKey) {
  return ({
    broken: 'The engine records at least one gap in this chain.',
    unverified: 'Every link is present, but at least one is declared only, job-level only or unhealthy.',
    inferred: 'Every link is present; at least one is matched by name rather than an explicit reference.',
    proven: 'Every link that carries the proof is explicit and confirmed live; recording rules and the exporter only support it.',
  })[stateKey] || '';
}

const RT_FILTERS = [
  { id: 'all',        label: 'All' },
  { id: 'broken',     label: 'Broken chain' },
  { id: 'unverified', label: 'Not confirmed live' },
  { id: 'inferred',   label: 'Linked by inference' },
];

function renderRequirementTraceabilityBlock(pack) {
  const model = readTraceability(pack);
  if (!model) return null;
  const block = document.createElement('div');
  block.className = 'rt-block';
  block.id = 'rt-requirements';
  paintRequirementBlock(block, pack, model);
  return block;
}

function paintRequirementBlock(block, pack, model) {
  const { total, counts, rows } = model;
  const gapGroups = model.issueGroups.filter(g => g.kind === 'gap');
  const top = gapGroups[0] || null;
  const knownFilter = RT_FILTERS.some(f => f.id === state.rtFilter) || model.issueGroups.some(g => g.code === state.rtFilter);
  const filter = knownFilter ? state.rtFilter : 'all';

  let tone = 'ok';
  let decision = `All ${total} requirements are proven end to end.`;
  if (counts.broken) {
    tone = 'fail';
    decision = `${counts.broken} of ${plural(total, 'requirement')} ${counts.broken === 1 ? 'has' : 'have'} a broken proof chain${top ? `; the most common gap is “${top.label.toLowerCase()}” (${top.ids.length})` : ''}.`;
  } else if (counts.unverified) {
    tone = 'warn';
    decision = `Every requirement is linked, but ${counts.unverified} of ${total} ${counts.unverified === 1 ? 'is' : 'are'} not confirmed on the live platform.`;
  } else if (counts.inferred) {
    tone = 'info';
    decision = `Every requirement is linked; ${counts.inferred} of ${total} rely on name matching rather than an explicit reference.`;
  }
  const first = rows[0];
  const meta = pack?.meta || {};
  const headerHtml = decisionHeaderHtml({
    id: 'rt-decision',
    eyebrow: 'Requirements traceability',
    context: [
      { key: 'Service', value: meta.service || '' },
      { key: 'Environment', value: meta.environment || state.selectedEnv || '' },
      { key: 'Pack', value: [meta.name || pack?.name, meta.version ? `v${meta.version}` : ''].filter(Boolean).join(' ') },
      { key: 'Evidence', value: model.live ? 'Live draft' : 'Declared in the pack', title: model.live ? 'Everything in this pack was read from the live platform.' : 'Links are read from the pack’s declarations; a link counts as proven only where a verification stamp confirms it live.' },
    ],
    tone,
    decision,
    note: !model.live && counts.proven === 0
      ? 'This pack declares its links but carries no live evidence, so a link here can be inferred or unverified, not proven.'
      : '',
    primary: first && first.stateKey !== 'proven' ? { label: `Review ${first.title}`, action: 'rt-open-first' } : null,
    secondary: top && top.ids.length > 1 && filter !== top.code
      ? [{ label: `Show all ${top.ids.length} with ${top.label.toLowerCase()}`, action: `rt-filter:${top.code}` }]
      : [],
    measures: [
      { label: 'Requirements', value: String(total), note: `${counts.proven} proven end to end` },
      { label: 'Broken chain', value: String(counts.broken), tone: counts.broken ? 'fail' : 'neutral', note: 'a gap the engine records' },
      { label: 'Not confirmed live', value: String(counts.unverified), tone: counts.unverified ? 'warn' : 'neutral', note: 'declared, job-level or unhealthy' },
      { label: 'Linked by inference', value: String(counts.inferred), tone: 'neutral', note: 'matched by name only' },
    ],
  });

  const ex = model.exists;
  const of = (n) => `${n} of ${total}`;
  const bl = model.byLink;
  const evidenceRows = [
    ['Metric',
      [ex.metrics.live ? `${ex.metrics.live} seen live` : 'none seen live', ex.metrics.declared ? `${ex.metrics.declared} declared` : ''].filter(Boolean).join(' · '),
      of(bl.metric.linked), of(bl.metric.proven), 'named in the SLI’s query'],
    ['Scrape job',
      ex.scrape.observed ? `${plural(ex.scrape.observed, 'job')} (${ex.scrape.live} observed live, ${ex.scrape.declared} declared)` : 'none',
      of(bl.scrape.linked), of(bl.scrape.proven), 'by job name, or proven when the live inventory reports the metric; a job merely existing is not counted'],
    ['Dashboard',
      plural(ex.dashboards, 'dashboard'),
      of(bl.dashboard.linked), of(bl.dashboard.proven), 'a panel bound to the SLO or SLI'],
    ['Alert',
      `${plural(ex.alerts.burnRate, 'burn-rate alert')} · ${plural(ex.alerts.liveRules, 'live rule')}`,
      of(bl.alert.linked), of(bl.alert.proven), 'declared for the SLO, or a matching healthy live rule'],
  ];
  const evidenceHtml = `
    <table class="rt-evidence">
      <caption>What exists somewhere, and what is tied to a requirement</caption>
      <thead><tr>
        <th scope="col">Link</th>
        <th scope="col">Exists somewhere</th>
        <th scope="col">Linked to its requirement</th>
        <th scope="col">Proven for its requirement</th>
      </tr></thead>
      <tbody>
        ${evidenceRows.map(([name, exists, linked, proven, how]) => `
          <tr>
            <th scope="row">${escapeHtml(name)}</th>
            <td>${escapeHtml(exists)}</td>
            <td>${escapeHtml(linked)}<span class="rt-evidence-how">${escapeHtml(how)}</span></td>
            <td>${escapeHtml(proven)}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;

  const countFor = (id) => (id === 'all' ? total : counts[id] ?? 0);
  const filterBtns = [
    ...RT_FILTERS.filter(f => f.id === 'all' || countFor(f.id) > 0).map(f => ({ id: f.id, label: f.label, count: countFor(f.id) })),
    ...model.issueGroups.map(g => ({ id: g.code, label: g.label, count: g.ids.length, code: g.code })),
  ];
  const filtersHtml = `
    <div class="ux-segmented rt-filters" role="group" aria-label="Show requirements">
      ${filterBtns.map(b => `<button type="button" data-rt-filter="${escapeHtml(b.id)}" aria-pressed="${b.id === filter ? 'true' : 'false'}"${b.code ? ` title="${escapeHtml(b.code)}"` : ''}>${escapeHtml(b.label)}<span class="ux-seg-count">${b.count}</span></button>`).join('')}
    </div>`;

  const group = model.issueGroups.find(g => g.code === filter) || null;
  const fixOnceHtml = group ? `
    <div class="rt-fix-once ux-tone-${group.kind === 'gap' ? 'fail' : 'warn'}" role="note">
      <p class="rt-fix-once-title">${escapeHtml(`${plural(group.ids.length, 'requirement')} share${group.ids.length === 1 ? 's' : ''} this ${group.kind === 'gap' ? 'gap' : 'caveat'}: ${group.label}`)} <code class="rt-code">${escapeHtml(group.code)}</code></p>
      ${group.why ? `<p class="rt-fix-once-why">${escapeHtml(group.why)}</p>` : ''}
      ${group.fix ? `<p class="rt-fix-once-fix"><span class="rt-fix-once-key">Fix once:</span> ${escapeHtml(group.fix)}</p>` : ''}
      <div class="rt-fix-once-actions">
        ${group.layer ? `<button type="button" class="ux-secondary-btn" data-rt-layer="${escapeHtml(group.layer)}" title="${escapeHtml(layerTitle(group.layer))}">Open ${escapeHtml(`${group.layer} ${LAYER_PURPOSE[group.layer]?.name || ''}`.trim())} in Discover</button>` : ''}
        <button type="button" class="ux-link-btn" data-rt-filter="all">Show all requirements</button>
      </div>
    </div>` : '';

  const visible = rows.filter(r => filter === 'all'
    || (RT_FILTERS.some(f => f.id === filter) ? r.stateKey === filter : r.issues.some(i => i.code === filter)));

  const legendHtml = disclosureHtml('How link states are decided', `
    <dl class="rt-legend">
      ${Object.entries(LINK_STATES).map(([k, s]) => `<div><dt>${rtLinkChipHtml(k)}</dt><dd>${escapeHtml(s.tip)}</dd></div>`).join('')}
    </dl>
    <p>A scrape job being observed is job-level evidence: it shows the job exists, not that it scrapes this requirement’s metric. A job counts as linked only when its name matches the requirement’s metrics, and even then its targets were not checked, so it stays inferred. Collection is proven only when the live metric inventory reports the metric itself.</p>
    <p>Recording rules and the metrics exporter support the chain without being specific to one requirement, so their links are inferred by nature and never hold a requirement back from proven; a gap there still breaks it.</p>
    <p>A link is <strong>missing</strong> exactly when the traceability engine records a gap; the other states are this screen’s reading of what the engine found. Machine codes appear beside their plain-language labels.</p>
  `, { cls: 'rt-legend-disclosure' });

  block.innerHTML = `
    ${headerHtml}
    ${evidenceHtml}
    <h3 class="rt-list-title" id="rt-list-title">Requirements, worst first</h3>
    ${filtersHtml}
    ${fixOnceHtml}
    <div class="rt-req-head" aria-hidden="true">
      <span>Requirement</span><span>Chain state</span><span>First broken link</span><span>Next action</span>
    </div>
    <ol class="rt-req-list" aria-labelledby="rt-list-title"></ol>
    ${legendHtml}
  `;

  const list = block.querySelector('.rt-req-list');
  if (!visible.length) {
    list.insertAdjacentHTML('beforebegin', emptyStateHtml({
      title: 'No requirement matches this filter.',
      checked: `${plural(total, 'requirement')} in ${meta.name || 'this pack'}`,
      actions: [{ label: 'Show all requirements', action: 'rt-filter:all' }],
    }));
  }
  const groupSize = new Map(model.issueGroups.map(g => [g.code, g.ids.length]));
  visible.forEach((row, i) => list.appendChild(renderRequirementRow(row, i, groupSize, repaint)));

  function repaint(nextFilter) {
    if (nextFilter !== undefined) state.rtFilter = nextFilter;
    paintRequirementBlock(block, pack, model);
    block.querySelector(`[data-rt-filter="${CSS.escape(state.rtFilter || 'all')}"]`)?.focus();
  }

  for (const btn of block.querySelectorAll('[data-rt-filter]')) {
    btn.addEventListener('click', () => repaint(btn.dataset.rtFilter));
  }
  for (const btn of block.querySelectorAll('[data-rt-layer]')) {
    btn.addEventListener('click', () => openTraceTarget({ layer: btn.dataset.rtLayer }));
  }
  const handlers = {
    'rt-open-first': () => {
      if (!first) return;
      if (!visible.includes(first)) { state.rtExpanded = first.id; repaint('all'); }
      const toggle = block.querySelector(`.rt-req[data-id="${CSS.escape(first.id)}"] .rt-req-toggle`);
      if (toggle && toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
      toggle?.closest('.rt-req')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      toggle?.focus({ preventScroll: true });
    },
    'rt-filter:all': () => repaint('all'),
  };
  for (const g of model.issueGroups) handlers[`rt-filter:${g.code}`] = () => repaint(g.code);
  wireUxActions(block, handlers);
}

// One requirement: a summary row (name, chain state, first broken link,
// next action) whose toggle reveals its proof chain. One chain is open at a
// time (state.rtExpanded).
function renderRequirementRow(row, i, groupSize, repaint) {
  const li = document.createElement('li');
  li.className = 'rt-req';
  li.dataset.id = row.id;
  li.dataset.state = row.stateKey;
  const bodyId = `rt-req-body-${i}`;
  const expanded = state.rtExpanded === row.id;
  const focus = row.firstBroken || row.weakest;
  const focusIssue = focus?.gap ? traceIssue(focus.gap) : null;
  // The issue label already names its link ("Alert evidence missing").
  const breakText = row.firstBroken
    ? (focusIssue ? focusIssue.label : `${row.firstBroken.label}: ${LINK_STATES[row.firstBroken.state].label.toLowerCase()}`)
    : row.weakest ? `None · weakest: ${row.weakest.label.toLowerCase()} (${LINK_STATES[row.weakest.state].label.toLowerCase()})` : 'None';
  li.innerHTML = `
    <div class="rt-req-row">
      <button type="button" class="rt-req-toggle" aria-expanded="${expanded ? 'true' : 'false'}" aria-controls="${bodyId}">
        <span class="rt-req-caret" aria-hidden="true"></span>
        <span class="rt-req-name">${escapeHtml(row.title)}</span>
        <span class="rt-req-sub">${escapeHtml([row.objective, row.sliId && row.sliId !== row.title ? `SLI ${row.sliId}` : '', row.kind === 'sli' ? 'no SLO' : ''].filter(Boolean).join(' · '))}</span>
      </button>
      <span class="rt-req-state">${rtChainChipHtml(row)}</span>
      <span class="rt-req-break${row.firstBroken ? ' is-broken' : ''}">${escapeHtml(breakText)}${focusIssue ? ` <code class="rt-code">${escapeHtml(focusIssue.code)}</code>` : ''}</span>
      <span class="rt-req-next">${row.next ? `<button type="button" class="ux-link-btn" data-rt-next>${escapeHtml(row.next.label)} →</button>` : '<span class="rt-req-none">Nothing to do</span>'}</span>
    </div>
    <div class="rt-req-body" id="${bodyId}"${expanded ? '' : ' hidden'}></div>
  `;
  const toggle = li.querySelector('.rt-req-toggle');
  const body = li.querySelector('.rt-req-body');
  const fill = () => { if (!body.childElementCount) body.appendChild(renderRequirementChain(row, groupSize, repaint)); };
  if (expanded) fill();
  toggle.addEventListener('click', () => {
    const open = toggle.getAttribute('aria-expanded') !== 'true';
    // One chain at a time: close whichever other row is open.
    for (const other of li.parentElement?.querySelectorAll('.rt-req-toggle[aria-expanded="true"]') || []) {
      if (other === toggle) continue;
      other.setAttribute('aria-expanded', 'false');
      const ob = document.getElementById(other.getAttribute('aria-controls'));
      if (ob) ob.hidden = true;
    }
    toggle.setAttribute('aria-expanded', String(open));
    if (open) fill();
    body.hidden = !open;
    state.rtExpanded = open ? row.id : null;
  });
  li.querySelector('[data-rt-next]')?.addEventListener('click', () => runNextAction(row));
  return li;
}

function runNextAction(row) {
  const n = row.next;
  if (!n) return;
  if (n.openSli && row.sliTarget) { openTraceTarget(row.sliTarget); return; }
  openTraceTarget(n.target || { layer: n.layer });
}

// The expanded proof chain: each link with its state, a sentence saying
// why, the items behind it (each opens its artefact), and — for a broken
// link — the fix and every other requirement that shares the gap.
function renderRequirementChain(row, groupSize, repaint) {
  const wrap = document.createElement('div');
  wrap.className = 'rt-chain-detail';
  const ol = document.createElement('ol');
  ol.className = 'rt-links';
  for (const l of row.links) {
    const li = document.createElement('li');
    li.className = 'rt-link';
    li.dataset.state = l.state;
    if (l.broken) li.dataset.broken = 'true';
    const issue = l.gap ? traceIssue(l.gap) : null;
    const shared = issue ? groupSize.get(issue.code) || 0 : 0;
    li.innerHTML = `
      <div class="rt-link-head">
        <span class="rt-link-name">${escapeHtml(l.label)}</span>
        ${rtLinkChipHtml(l.state)}
        ${issue ? `<span class="rt-link-issue">${escapeHtml(issue.label)} <code class="rt-code">${escapeHtml(issue.code)}</code></span>` : ''}
      </div>
      <p class="rt-link-detail">${escapeHtml(l.detail)}</p>
      <div class="rt-link-items"></div>
      ${(l.broken || l === row.weakest) && row.next && row.next.link === l.key ? `
        <div class="rt-link-actions">
          <button type="button" class="ux-link-btn" data-rt-fix>${escapeHtml(row.next.label)} →</button>
          ${shared > 1 ? `<button type="button" class="ux-link-btn" data-rt-group="${escapeHtml(issue.code)}">Show all ${shared} requirements with this gap</button>` : ''}
        </div>` : ''}
    `;
    const items = li.querySelector('.rt-link-items');
    for (const it of l.items || []) {
      const el = document.createElement(it.target ? 'button' : 'span');
      el.className = 'rt-link-item';
      if (it.target) {
        el.type = 'button';
        el.title = `Open in Discover (${it.target.layer})`;
        el.addEventListener('click', () => openTraceTarget(it.target));
      }
      el.textContent = it.text;
      if (it.evidence) {
        const ev = document.createElement('span');
        ev.className = `rt-ev rt-ev-${it.evidence}`;
        ev.textContent = it.evidence === 'live' ? 'live' : 'declared';
        el.appendChild(ev);
      }
      items.appendChild(el);
    }
    if (!items.childElementCount) items.remove();
    li.querySelector('[data-rt-fix]')?.addEventListener('click', () => runNextAction(row));
    li.querySelector('[data-rt-group]')?.addEventListener('click', (ev) => repaint(ev.currentTarget.dataset.rtGroup));
    ol.appendChild(li);
  }
  wrap.appendChild(ol);

  const notes = row.issues.filter(i => i.kind === 'note');
  if (notes.length) {
    const ul = document.createElement('ul');
    ul.className = 'rt-issues';
    ul.setAttribute('aria-label', 'Caveats');
    for (const n of notes) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="rt-issue-label">${escapeHtml(n.label)}</span> <code class="rt-code">${escapeHtml(n.code)}</code>${n.why ? `<span class="rt-issue-why">${escapeHtml(n.why)}</span>` : ''}`;
      ul.appendChild(li);
    }
    wrap.appendChild(ul);
  }

  const opens = [
    row.sloTarget ? { label: 'Open the SLO in Discover', target: row.sloTarget } : null,
    row.sliTarget ? { label: 'Open the SLI in Discover', target: row.sliTarget } : null,
  ].filter(Boolean);
  if (opens.length) {
    const bar = document.createElement('div');
    bar.className = 'rt-chain-opens';
    for (const o of opens) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ux-secondary-btn';
      b.textContent = o.label;
      b.addEventListener('click', () => openTraceTarget(o.target));
      bar.appendChild(b);
    }
    wrap.appendChild(bar);
  }
  return wrap;
}

function renderTraceRow(bucketKey, finding, resolvedSet) {
  const sev = traceFindingSeverity(bucketKey, finding);
  const resolved = resolvedSet.has(finding.findingKey);
  const row = document.createElement('div');
  row.className = 'trace-row';
  row.dataset.sev = sev;
  row.dataset.resolved = String(resolved);

  // Side primary — for declaredNotVerified use A, for verifiedNotDeclared use B,
  // for stale + aligned use A (it's the manifest).
  const primary = (bucketKey === 'verifiedNotDeclared') ? finding.b : finding.a;
  const title = primary?.title || primary?.id || primary?.defines || prettyDiffKey(finding.key);
  // For stale rows the engine already names the diverging contract fields —
  // surface them so "reconcile" starts from the actual deltas.
  const driftFields = (finding.deltas || []).map(d => d.field).filter(Boolean);
  const sub = [primary?.desc || primary?.tool || '', driftFields.length ? `differs in: ${driftFields.join(', ')}` : '']
    .filter(Boolean).join(' · ');
  const sevLabel = sev === 'red' ? 'Promised outcome not seen live' : sev === 'amber' ? 'Needs reconciling' : '';

  row.innerHTML = `
    <div class="trace-row-pill">
      <span class="trace-row-layer" title="${escapeHtml(layerTitle(finding.layer))}">${escapeHtml(finding.layer)}</span>
      <span class="trace-row-sev" data-sev="${sev}"${sevLabel ? ` title="${escapeHtml(sevLabel)}" aria-label="${escapeHtml(sevLabel)}"` : ' aria-hidden="true"'}>${sev === 'red' ? '✕' : sev === 'amber' ? '⚠' : '·'}</span>
    </div>
    <div class="trace-row-body">
      <div class="trace-row-title">${escapeHtml(String(title || finding.key))}</div>
      <div class="trace-row-sub">${escapeHtml(sub)}</div>
      <div class="trace-row-key"><code>${escapeHtml(`${finding.layer} · ${prettyDiffKey(finding.key)}`)}</code></div>
    </div>
    <div class="trace-row-actions">
      <button type="button" class="trace-action" data-act="open" title="Open the artefact in Discover">Open</button>
      <button type="button" class="trace-action" data-act="resolve" aria-pressed="${resolved ? 'true' : 'false'}" title="Toggle resolved (persists locally)">${resolved ? '✓ Resolved' : 'Mark resolved'}</button>
      <button type="button" class="trace-action" data-act="suppress" title="Hide this finding from its group (persists locally)">Suppress</button>
    </div>
  `;

  row.querySelector('[data-act="open"]').onclick = () => {
    // The diff entry embeds the artefact it paired — locate the loaded
    // pack's copy by id (falling back to the embedded copy) so the drawer
    // opens regardless of which keyspace the diff entry's key lives in.
    const embedded = (bucketKey === 'verifiedNotDeclared') ? finding.b : finding.a;
    const pack = (bucketKey === 'verifiedNotDeclared') ? state.packB : state.pack;
    const items = layerItemsFor(pack, finding.layer);
    const art = items.find(it => it.id === embedded?.id) || embedded;
    openArtefactInLayers(finding.layer, art || null);
  };
  row.querySelector('[data-act="resolve"]').onclick = () => { toggleTraceResolved(finding.findingKey); state.traceRepoLiveOpen = true; appHost.renderMainView(); };
  row.querySelector('[data-act="suppress"]').onclick = () => { toggleTraceSuppressed(finding.findingKey); state.traceRepoLiveOpen = true; appHost.renderMainView(); };
  return row;
}

// ============================================================
// Benchmark view (Phase 4)
//
// A focused destination — answers "how does PACK A's posture for
// <product> compare to PACK B as the reference?" Built on the same
// machinery as Compare (productSurface lens + the server diff's
// behavioural buckets) but framed as a scorecard rather than a
// free-form side-by-side.
//
//   ┌─────────────────────────────────────────────────────────────┐
//   │  BENCHMARK: krystaline-live  vs  grafana-reference          │
//   │  Lens: [Grafana ▼]                                          │
//   │                                                             │
//   │   Coverage      Per-layer       Verified by MCP             │
//   │     14%         L1 0/16         29 backends                 │
//   │                 L2 1/1          live versions: Grafana 12.4 │
//   │                 L3 6/31                                     │
//   │                 L4 0/17                                     │
//   │                 L5 0/8                                      │
//   ├─────────────────────────────────────────────────────────────┤
//   │  Missing from your live pack (top 10)                       │
//   │   • http_request_success_ratio (SLI)                        │
//   │   • datasource_proxy_success_ratio (SLI)                    │
//   │   • burn-rate alert: http_request_success_99_9 (POL)        │
//   │   • …                                                       │
//   ├─────────────────────────────────────────────────────────────┤
//   │  In your live pack but not in the reference (top 5)         │
//   │   • adz2hpb (custom DASH)                                   │
//   │   • …                                                       │
//   ├─────────────────────────────────────────────────────────────┤
//   │  Side-by-side                                               │
//   │  [the same lens-scoped compare grid as Compare view]        │
//   └─────────────────────────────────────────────────────────────┘
// ============================================================
// DIAGNOSE sub-tab nav. The three MAIN journey tabs (Discover · Diagnose ·
// Remediate) are unchanged; this split lives entirely INSIDE Diagnose:
//   · Assessment — the diagnostic-grade verdict + coverage/trust/evidence
//                  report (formerly "Diagnostic Grade"; the formal term
//                  lives on in the report's details)
//   · Compare    — the artefact-level live-pack-vs-baseline diff
// Switching is local (state.diagnoseSub, ids unchanged) and persisted.
function renderDiagnoseSubnav(active) {
  const nav = document.createElement('div');
  nav.className = 'diag-subnav';
  nav.setAttribute('role', 'group');
  nav.setAttribute('aria-label', 'Diagnose views');
  const tabs = [
    { id: 'grade',   label: 'Assessment', sub: 'is it good enough?', title: 'The diagnostic grade: coverage, trust and evidence, with what keeps the pack below grade A.' },
    { id: 'compare', label: 'Compare',    sub: 'what differs from the baseline?', title: 'Artefact by artefact: the pack (A) compared with the selected baseline (B).' },
  ];
  for (const t of tabs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'diag-subtab' + (t.id === active ? ' is-active' : '');
    btn.dataset.sub = t.id;
    btn.title = t.title;
    btn.setAttribute('aria-pressed', t.id === active ? 'true' : 'false');
    btn.innerHTML = `
      <span class="diag-subtab-label">${escapeHtml(t.label)}</span>
      <span class="diag-subtab-sub">${escapeHtml(t.sub)}</span>
    `;
    btn.addEventListener('click', () => {
      if (state.diagnoseSub === t.id) return;
      state.diagnoseSub = t.id;
      appHost.renderMainView();
    });
    nav.appendChild(btn);
  }
  return nav;
}

export function renderBenchmarkView(view) {
  // Sub-tabs under DIAGNOSE: Assessment (the diagnostic-grade report) and
  // Compare (the artefact-level live-pack-vs-baseline side-by-side).
  const sub = state.diagnoseSub === 'compare' ? 'compare' : 'grade';
  view.appendChild(renderDiagnoseSubnav(sub));
  if (sub === 'compare') { renderCompareView(view); return; }

  const scaffold = document.createElement('section');
  scaffold.className = 'section benchmark-view';
  scaffold.dataset.layer = 'BENCHMARK';
  view.appendChild(scaffold);

  // Pack A is guaranteed by the dispatcher. Pack B is OPTIONAL: with A
  // alone we answer the killer question (diagnostic-grade YES/NO) from
  // coverage + drift evidence carried in Pack A itself. Loading a Pack B
  // (via the header picker — we never duplicate it here) unlocks the
  // A-vs-B comparison for drift-vs-deployed or gap-vs-target analysis.
  const haveB = !!state.packB;

  // If the user picked a Pack B but it (or the diff) hasn't loaded yet,
  // fetch them and re-render so the comparison enriches the verdict.
  // The diff over big packs takes real seconds — show motion so it reads
  // as "working", not "hung". And NEVER hang on failure: a rejected fetch
  // renders an honest error with a retry instead of an eternal spinner.
  // A diff computed for a different selection (pack A swapped, env
  // flipped, scope changed) must count as missing, not render — see
  // diffMatchesSelection. When Pack A has no server id the diff can never
  // load, so skip the fetch branch and render the Pack-A-only verdict.
  const diffCurrent = !!state.diff && diffMatchesSelection(state.diff);
  if (state.compareBId && state.selectedPackId && (!haveB || !diffCurrent)) {
    const loading = document.createElement('div');
    loading.className = 'placeholder loading-compare';
    loading.setAttribute('role', 'status');
    const bLabel = catalogEntryFor(state.compareBId)?.label || String(state.compareBId);
    loading.innerHTML = `
      <span class="compare-spinner" aria-hidden="true"></span>
      <span>Comparing <strong>${escapeHtml(state.pack?.name || 'this pack')}</strong> with the baseline <strong>${escapeHtml(bLabel)}</strong>…</span>
      <span class="loading-compare-sub">matching artefacts by behavioural identity — large packs take a few seconds</span>
    `;
    scaffold.appendChild(loading);
    diagUx.announce(`Comparing with ${bLabel}…`);
    Promise.all([
      haveB ? Promise.resolve() : appHost.loadPackB(),
      diffCurrent ? Promise.resolve() : loadDiff(),
    ]).then(() => {
      // Only re-render on progress — re-entering this branch unchanged
      // would spin a synchronous render loop.
      if (state.packB && state.diff) { appHost.renderTabs(); appHost.renderMainView(); return; }
      loading.classList.remove('loading-compare');
      loading.innerHTML = `
        <span>The comparison with the baseline failed to load.</span>
        <button type="button" class="ctrl-btn loading-compare-retry">retry</button>
      `;
      diagUx.announce('The comparison failed to load.');
      loading.querySelector('.loading-compare-retry')?.addEventListener('click', () => appHost.renderMainView());
    })
      .catch((e) => {
        loading.classList.remove('loading-compare');
        loading.innerHTML = `
          <span>The comparison with the baseline failed to load: ${escapeHtml(e?.message || 'unknown error')}</span>
          <button type="button" class="ctrl-btn loading-compare-retry">retry</button>
        `;
        diagUx.announce('The comparison failed to load.');
        loading.querySelector('.loading-compare-retry')?.addEventListener('click', () => appHost.renderMainView());
      });
    return;
  }
  // Past the gate: the diff is either current or unavailable for this
  // selection — never hand a stale one to the grade or the drill.
  const diffSafe = diffCurrent ? state.diff : null;

  // Auto-apply the lens when Pack B is a *-reference catalogue pack.
  // Picking grafana-reference IS choosing the Grafana benchmark; no
  // reason to make the user explicitly set the Lens dropdown afterward.
  if (haveB) {
    const bId = String(state.compareBId || state.packB?.id || '').toLowerCase();
    const refMatch = /^([a-z][a-z0-9_-]*?)-reference$/.exec(bId);
    if (refMatch && (state.compareLens === 'all' || !state.compareLens)) {
      const inferredLens = refMatch[1];
      if (LENS_PRODUCTS.some(lp => lp.slug === inferredLens)) {
        state.compareLens = inferredLens;
      }
    }
  }
  const lens = state.compareLens || 'all';

  // Posture matrix — the coverage substrate (Pack-A-derived). Feeds both
  // the verdict's "comprehensive" criterion and the layer scores below.
  const posture = computePostureMatrix(state.pack, state.packB);

  // THE verdict — diagnostic grade from coverage (2A) + trust / drift (2B).
  const diagnostic = computeDiagnosticGrade(state.pack, state.packB, posture, state.compareBId, diffSafe);

  // The screen grammar (docs/UX_SCREEN_GRAMMAR.md): context · decision ·
  // next action · explanation first, then the report's sections behind a
  // sticky index. The decision is DERIVED from the same diagnostic (and the
  // same lensed comparison digest the drill renders) — nothing re-scores.
  const ctx = diagnoseContext();
  const digest = haveB ? diffDigest(diffSafe, state.packB, lens) : null;
  // Whichever side is the live draft carries the probe record.
  const liveEvidence = partialLiveEvidence(liveSidePack(ctx.roles.mode));
  const decision = buildAssessmentDecision({ diagnostic, digest, roles: ctx.roles, liveEvidence, haveB, baselineName: ctx.b?.name || '' });
  const parts = renderDiagnosticGradeVerdict(diagnostic);

  const report = document.createElement('div');
  report.className = 'diag-report diag-assess';
  scaffold.appendChild(report);

  // 1–4. Context · decision · next action · top causes, then the measures
  // grouped by meaning and the (collapsed) scoring reference.
  report.insertAdjacentHTML('beforeend', renderAssessmentHeaderHtml(decision, ctx));
  const summary = report.querySelector('#diag-summary');
  if (summary) {
    summary.classList.add('ux-section-target');
    summary.tabIndex = -1;
    summary.insertAdjacentHTML('beforeend', assessmentMeasuresHtml(diagnostic, decision)
      + diagUx.disclosureHtml('How the grade is calculated', assessmentCalcHtml(diagnostic, parts.ladderHtml), { cls: 'diag-calc-disclosure' }));
  }

  // 5. Details — one sticky index over the long report, issue count per section.
  const rollup = diagnostic.traceabilityGraph?.rollup;
  const thinLayers = POSTURE_LAYERS.filter(l => POSTURE_MECHANISMS_PER_LAYER
    .filter(m => (posture.cells[`${l.key}:${m.key}`] || []).length > 0).length <= 3).length;
  const countTone = (n, bad = 'fail') => (n > 0 ? bad : 'ok');
  const navSections = [
    { id: 'diag-summary', label: 'Summary' },
    { id: 'diag-gaps', label: 'Gaps', count: decision.gapCount, tone: countTone(decision.gapCount) },
    { id: 'diag-compare', label: 'Comparison', count: digest ? decision.qualityGaps : null, tone: countTone(decision.qualityGaps, 'warn') },
    { id: 'diag-evidence', label: 'Evidence', count: parts.failingChecks, tone: countTone(parts.failingChecks, 'warn') },
    parts.requirementsHtml ? { id: 'diag-requirements', label: 'Requirements', count: (rollup?.broken || 0) + (rollup?.partial || 0), tone: countTone((rollup?.broken || 0) + (rollup?.partial || 0), 'warn') } : null,
    { id: 'diag-layers', label: 'Layer scores', count: thinLayers, tone: countTone(thinLayers, 'warn') },
  ];
  report.insertAdjacentHTML('beforeend', assessmentStickyHtml(decision, ctx, navSections));

  // Gaps — the blockers in priority order: what failed → why → fix.
  report.insertAdjacentHTML('beforeend', assessmentGapsHtml(decision));

  // Comparison with the selected baseline (or the invitation to choose one).
  const cmp = diagBlockEl('diag-compare', haveB ? ctx.roles.title : 'Comparison with a baseline',
    haveB && ctx.b
      ? `<strong>${escapeHtml(packLine(ctx.a))}</strong> compared with <strong>${escapeHtml(packLine(ctx.b))}</strong>. Structural differences (additional artefacts) and quality gaps (missing or changed artefacts) are weighted differently.`
      : '');
  if (!haveB && state.compareBId && !state.selectedPackId) {
    // A baseline is picked, but this pack has no server id, so no diff can
    // be computed — say that, rather than "no baseline selected".
    cmp.insertAdjacentHTML('beforeend', diagUx.emptyStateHtml({
      title: 'This pack cannot be compared yet.',
      checked: 'Whether the pack is registered on the server — a comparison is computed there.',
      body: 'Re-upload or rescan the pack, then open Diagnose again.',
      tone: 'warn',
    }));
  } else if (!haveB) {
    cmp.appendChild(renderComparePrompt());
  } else {
    const drill = renderDriftDrill(diffSafe, state.packB, state.compareBId, lens);
    if (drill) cmp.appendChild(drill);
    else if (diffSafe?.error) cmp.insertAdjacentHTML('beforeend', diagUx.emptyStateHtml({ title: 'The comparison could not be computed.', body: String(diffSafe.error), tone: 'warn' }));
    else cmp.insertAdjacentHTML('beforeend', diagUx.emptyStateHtml({
      title: 'Nothing to compare in this scope.',
      checked: `Every artefact of both packs${lens !== 'all' ? ` inside the ${LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens} lens` : ''}, within the current live scope.`,
      body: 'Widen the live scope or clear the product lens to include more artefacts.',
    }));
    cmp.appendChild(renderLiveScopeControl({ standalone: true }));
  }
  report.appendChild(cmp);

  // Evidence (the scored checks + the evidence ledger), then requirement chains.
  report.insertAdjacentHTML('beforeend', parts.evidenceHtml);
  if (parts.requirementsHtml) report.insertAdjacentHTML('beforeend', parts.requirementsHtml);

  // Layer scores — per-layer × per-mechanism coverage. Pack-A-derived, so
  // it's the "why" behind the coverage checks whether or not a Pack B exists.
  const layers = diagBlockEl('diag-layers', 'Layer scores — where coverage is thin',
    'How many of the expected mechanisms each layer observes, declared in the pack or seen as evidence.');
  layers.appendChild(renderBenchmarkHeadline(posture, lens));
  layers.appendChild(renderPosturePieRow(posture));
  layers.appendChild(renderPostureMatrix(posture));
  layers.appendChild(renderPostureNarrative(posture));
  report.appendChild(layers);

  wireDiagActions(report);
  diagUx.wireSectionNav(report);
}

// Affordance shown in Diagnose when only Pack A is loaded. Points the
// user at the EXISTING header Pack B picker (no duplicate control) and
// names the two comparison use cases. Selecting nothing here is fine —
// the assessment above already stands on Pack A alone.
function renderComparePrompt() {
  const el = document.createElement('div');
  el.className = 'diag-compare-prompt';
  el.innerHTML = diagUx.emptyStateHtml({
    title: 'No baseline selected: this assessment reads the pack on its own.',
    checked: 'What the pack itself declares — its coverage, its trust evidence and its requirement chains.',
    body: 'Choose a baseline in the header’s Pack B picker to compare: a live draft shows drift (declared versus deployed); a curated or reference pack shows the gap to a target.',
  });
  return el;
}

// The lensed, scaffold-parked bucket arithmetic over a server diff — ONE
// place, so the Assessment headline, the drift drill and the Compare view
// count the same things. inBoth splits into aligned vs drifted (identity
// matched, contract diverges); schema-forced placeholders (scaffold) and
// live inventory outside the declared scope (outOfScope) are parked, never
// counted as differences. Returns null when no usable diff exists.
function diffDigest(diff, packB, lens) {
  if (!diff || diff.error || !diff.layers) return null;
  const useLens = !!lens && lens !== 'all';

  // Project a bucket entry's artefact (shape varies: onlyIn* carry
  // `.artefact`, inBoth carries `.a`/`.b`). For lens scoping we test
  // the A-side projection (or B-side for onlyInB) against the surface.
  const passesLens = (entry, side) => {
    if (!useLens) return true;
    const art = side === 'b' ? (entry.artefact || entry.b) : (entry.artefact || entry.a);
    const pack = side === 'b' ? packB : state.pack;
    return productSurface(art, lens, pack);
  };

  const totals = { aligned: 0, drifted: 0, onlyInA: 0, onlyInB: 0, outOfScope: 0, scaffold: 0 };
  const rows = [];
  for (const L of LAYERS_FOR_DIFF) {
    const bucket = diff.layers[L] || { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };
    // inBoth = shared identity. Split it: structurally-equal pairs are
    // aligned; same-identity-but-divergent pairs are drifted. Matching is
    // an object comparison, not a name check.
    const matched = (bucket.inBoth || []).filter(e => passesLens(e, 'a') && !isScaffoldDiffEntry(e));
    const aligned = matched.filter(e => e.match !== 'drifted');
    const drifted = matched.filter(e => e.match === 'drifted');
    const rawOnlyInA = (bucket.onlyInA || []).filter(e => passesLens(e, 'a'));
    const rawOnlyInB = (bucket.onlyInB || []).filter(e => passesLens(e, 'b'));
    const onlyInA = rawOnlyInA.filter(e => !isScaffoldDiffEntry(e));
    const onlyInB = rawOnlyInB.filter(e => !isScaffoldDiffEntry(e));
    const scaffold = [
      ...rawOnlyInA.filter(e => isScaffoldDiffEntry(e)),
      ...rawOnlyInB.filter(e => isScaffoldDiffEntry(e)),
      ...(bucket.inBoth || []).filter(e => passesLens(e, 'a') && isScaffoldDiffEntry(e)),
      // The engine parks placeholders before pairing (diffPacks `scaffold`).
      ...(bucket.scaffold || []).filter(e => passesLens(e, e.side || 'b')),
    ];
    // Live members of a family this pack declares nothing of — the rest of the
    // platform inventory. Shown muted, never counted as drift.
    const outOfScope = (bucket.outOfScope || []).filter(e => passesLens(e, 'b'));
    if (aligned.length === 0 && drifted.length === 0 && onlyInA.length === 0
        && onlyInB.length === 0 && outOfScope.length === 0 && scaffold.length === 0) continue;
    totals.aligned += aligned.length;
    totals.drifted += drifted.length;
    totals.onlyInA += onlyInA.length;
    totals.onlyInB += onlyInB.length;
    totals.outOfScope += outOfScope.length;
    totals.scaffold += scaffold.length;
    rows.push({ L, name: COMPARE_LAYERS.find(x => x.id === L)?.name || L, aligned, drifted, onlyInA, onlyInB, outOfScope, scaffold });
  }
  totals.shared = totals.aligned + totals.drifted;
  totals.universe = totals.shared + totals.onlyInA + totals.onlyInB;
  return { rows, totals, useLens };
}

// THE A-vs-B drill — the real side-by-side evidence behind the verdict.
// Consumes state.diff (server-computed set arithmetic on the two packs'
// artefact keys) through diffDigest (lens + scaffold parking), then frames
// the three buckets (inBoth / onlyInA / onlyInB) in either drift or gap
// language. The weights (and the weighted-health / badness donuts) are
// reference material: they sit in a collapsed "How differences are
// weighted" so the counts and their meaning lead. Returns null when no
// usable diff exists so the caller can simply skip the section.
function renderDriftDrill(diff, packB, compareBId, lens) {
  const digest = diffDigest(diff, packB, lens);
  if (!digest || digest.totals.universe === 0) return null;

  const mode = compareModeFor(packB, compareBId);
  const roles = compareRoles(mode, isLivePack(state.pack, state.selectedPackId));
  const useLens = digest.useLens;
  const rows = digest.rows;
  const { aligned: totAligned, drifted: totDrifted, onlyInA: totA, onlyInB: totB, outOfScope: totOOS, scaffold: totScaffold } = digest.totals;

  // Mode-specific framing for the two delta columns. The column that is a
  // QUALITY gap (declared-not-live in drift mode, missing-vs-baseline in gap
  // mode) carries the fail tone; the STRUCTURAL one (live-only shadow
  // signals, additional artefacts) is informational.
  const bName = catalogEntryFor(compareBId)?.label || packB?.meta?.name || packB?.metadata?.name || packB?.id || 'the baseline';
  const frame = mode === 'drift'
    ? {
        eyebrow: 'Drift · declared vs live',
        lede: totA > 0
          ? `<strong>${totA}</strong> declared artefact${totA === 1 ? '' : 's'} not confirmed in <strong>${escapeHtml(bName)}</strong> — possible drift.`
          : `Every declared artefact is confirmed live in <strong>${escapeHtml(bName)}</strong>.`,
        aLabel: roles.aDelta,
        aHint: 'in your pack · not seen in the live system → drift risk',
        aWeightClass: 'anchor',
        aWeightText: '1.0',
        aClass: 'is-drift',
        aTone: 'fail',
        bLabel: roles.bDelta,
        bHint: 'seen live · missing from your pack → shadow signal',
        bWeightClass: 'low',
        bWeightText: '0.15',
        bClass: 'is-shadow',
        bTone: 'info',
        riskNote: 'Weighted badness: declared-not-live = 1.0; drifted = 0.5 by default, 1.0 for decision-bearing fields, 0.1 for cosmetic fields; live-not-declared = 0.15. Out-of-scope live inventory is excluded.',
      }
    : {
        eyebrow: 'Gap to baseline',
        lede: totB > 0
          ? `<strong>${totB}</strong> artefact${totB === 1 ? '' : 's'} in <strong>${escapeHtml(bName)}</strong> ${totB === 1 ? 'is' : 'are'} missing from the ${escapeHtml(roles.aNoun)} — the gap to close.${totA > 0 ? ` The ${totA} additional artefact${totA === 1 ? '' : 's'} in the ${escapeHtml(roles.aNoun)} ${totA === 1 ? 'is' : 'are'} extra coverage, not defects.` : ''}`
          : `Nothing from <strong>${escapeHtml(bName)}</strong> is missing: the ${escapeHtml(roles.aNoun)} matches or exceeds it on every artefact.${totA > 0 ? ` The ${totA} additional artefact${totA === 1 ? '' : 's'} ${totA === 1 ? 'is' : 'are'} extra coverage, not defects.` : ''}`,
        aLabel: roles.aDelta,
        aHint: `in the ${roles.aNoun} · not in the baseline → extra coverage, not a defect`,
        aWeightClass: 'low',
        aWeightText: '0.15',
        aClass: 'is-extra',
        aTone: 'info',
        bLabel: roles.bDelta,
        bHint: `in the baseline · not in the ${roles.aNoun} → gap to close`,
        bWeightClass: 'anchor',
        bWeightText: '1.0',
        bClass: 'is-gap',
        bTone: 'fail',
        riskNote: 'Weighted badness: artefacts missing from the baseline = 1.0; drifted = 0.5 by default, 1.0 for decision-bearing fields, 0.1 for cosmetic fields; additional artefacts = 0.15.',
      };

  const wrap = document.createElement('div');
  wrap.className = `benchmark-block drift-drill-block drift-mode-${mode}`;

  // Sample keys for a bucket, using the human artefact title when the
  // server key is a structural projection like sli:{"id":"..."}.
  const sampleKeys = (entries, max = 4) => {
    const names = entries.slice(0, max).map(e => escapeHtml(diffEntryLabel(e)));
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  // Sample drifted pairs as `name(field,field)` so the reader sees not just
  // WHICH artefacts drifted but WHICH FIELDS diverged.
  const sampleDeltas = (entries, max = 3) => {
    const names = entries.slice(0, max).map(e => {
      const fields = (e.deltas || []).map(d => d.field).slice(0, 3).join(',');
      return escapeHtml(diffEntryLabel(e)) + (fields ? `<span class="drift-delta-fields">(${escapeHtml(fields)})</span>` : '');
    });
    const more = entries.length > max ? ` +${entries.length - max}` : '';
    return names.length ? names.join(' · ') + more : '—';
  };

  // Drift makeup as two donuts: how much aligns (donut 1), then what the
  // non-aligned remainder is made of (donut 2). A legend carries the counts
  // so labels never crowd the rings. Each segment is a dash on a full
  // circle, accumulating clockwise from 12 o'clock.
  const donut = (segs, centerText) => {
    const r = 40, cx = 52, cy = 52, sw = 18, C = 2 * Math.PI * r;
    const total = segs.reduce((s, x) => s + x.value, 0) || 1;
    let acc = 0;
    const arcs = segs.filter(s => s.value > 0).map(s => {
      const len = (s.value / total) * C;
      const a = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${s.color}" stroke-width="${sw}" stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}" stroke-dashoffset="${(-acc).toFixed(2)}" transform="rotate(-90 ${cx} ${cy})"/>`;
      acc += len;
      return a;
    }).join('');
    const center = centerText ? `<text x="${cx}" y="${cy}" class="drift-donut-pct" text-anchor="middle" dominant-baseline="central">${centerText}</text>` : '';
    return `<svg viewBox="0 0 104 104" class="drift-donut-svg" aria-hidden="true"><circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="var(--line)" stroke-width="${sw}"/>${arcs}${center}</svg>`;
  };

  const C_ALIGNED = 'var(--ok, #16a34a)';
  const C_DRIFTED = 'rgb(150, 90, 200)';
  const C_DECL    = 'rgb(200, 70, 40)';
  const C_SHADOW  = 'rgb(180, 120, 0)';
  const allDriftedEntries = rows.flatMap(r => r.drifted);
  const weighted = computeWeightedDeltaRisk({
    mode,
    aligned: totAligned,
    driftedEntries: allDriftedEntries,
    onlyInA: totA,
    onlyInB: totB,
  });
  const fmtUnits = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  const legendHtml = [
    { n: totAligned, units: 0, color: C_ALIGNED, label: 'Aligned', hint: 'shape matches', weightClass: 'good', weightText: '0' },
    { n: totDrifted, units: weighted.driftedUnits, color: C_DRIFTED, label: 'Drifted', hint: 'field values diverge', weightClass: 'weighted', weightText: 'field' },
    { n: totA, units: weighted.onlyInAUnits, color: C_DECL, label: frame.aLabel, hint: frame.aHint, weightClass: frame.aWeightClass, weightText: frame.aWeightText },
    { n: totB, units: weighted.onlyInBUnits, color: C_SHADOW, label: frame.bLabel, hint: frame.bHint, weightClass: frame.bWeightClass, weightText: frame.bWeightText },
  ].map(l => `<li class="drift-legend-item">
      <span class="drift-legend-sw" style="background:${l.color}"></span>
      <span class="drift-legend-n">${l.n}</span>
      <span class="drift-legend-label">${escapeHtml(l.label)}</span>
      <span class="drift-weight drift-weight-${escapeHtml(l.weightClass)}">w ${escapeHtml(l.weightText)}</span>
      <span class="drift-legend-risk">${escapeHtml(fmtUnits(l.units))} risk units</span>
      <span class="drift-legend-hint">${escapeHtml(l.hint)}</span>
    </li>`).join('');

  const layerRowsHtml = rows.map(r => `
    <tr class="drift-row">
      <th class="drift-row-layer" title="${escapeHtml(diagUx.layerTitle(r.L))}"><span class="drift-row-num">${r.L}</span> ${escapeHtml(r.name)}</th>
      <td class="drift-cell is-aligned">
        <span class="drift-cell-n">${r.aligned.length}</span>
        <span class="drift-cell-keys">${r.aligned.length ? sampleKeys(r.aligned) : ''}</span>
      </td>
      <td class="drift-cell is-drifted">
        <span class="drift-cell-n">${r.drifted.length}</span>
        <span class="drift-cell-keys">${r.drifted.length ? sampleDeltas(r.drifted) : ''}</span>
      </td>
      <td class="drift-cell ${frame.aClass}">
        <span class="drift-cell-n">${r.onlyInA.length}</span>
        <span class="drift-cell-keys">${r.onlyInA.length ? sampleKeys(r.onlyInA) : ''}</span>
      </td>
      <td class="drift-cell ${frame.bClass}">
        <span class="drift-cell-n">${r.onlyInB.length}</span>
        <span class="drift-cell-keys">${r.onlyInB.length ? sampleKeys(r.onlyInB) : ''}</span>
        ${r.outOfScope.length ? `<span class="drift-cell-oos" title="Live members of families this pack declares nothing of — platform inventory, not drift.">+${r.outOfScope.length} out of scope</span>` : ''}
      </td>
    </tr>`).join('');

  const lensNote = useLens
    ? ` <span class="drift-lens-note">· lens: ${escapeHtml(LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens)}</span>`
    : '';

  // A thin live draft (some probes 503'd) silently inflates declared-not-
  // live into garbage. Say so LOUDLY before anyone reads the numbers. The
  // live draft is Pack B in drift mode, and may be Pack A in gap mode.
  const liveEvidence = partialLiveEvidence(mode === 'drift' ? packB : liveSidePack(mode));
  const overstated = mode === 'drift' ? frame.aLabel : frame.bLabel;
  const partialBanner = liveEvidence.partial ? `
    <div class="drift-partial-banner" role="note">
      <span class="drift-partial-key">⚠ PARTIAL LIVE EVIDENCE</span>
      ${liveEvidence.failed.length} of ${liveEvidence.attempted.length} probe${liveEvidence.attempted.length === 1 ? '' : 's'} failed during the live draft
      (<code>${escapeHtml(liveEvidence.failed.join(', '))}</code>) — the live endpoint was likely mid-deploy or overloaded.
      The live pack may be missing whole surfaces, so <strong>"${escapeHtml(overstated)}" is probably overstated</strong>.
      Redraft from MCP before acting on this drift.${(liveEvidence.unsupported || []).length ? ` restricted MCP tier — not exposed: ${escapeHtml(liveEvidence.unsupported.join(', '))}` : ''}
    </div>` : '';

  const weightsBody = `
    <div class="drift-charts">
      <figure class="drift-chart">
        ${donut([{ value: totAligned, color: C_ALIGNED }, { value: weighted.totalBadness, color: 'var(--ink-4)' }], weighted.healthPct + '%')}
        <figcaption>weighted health</figcaption>
      </figure>
      <span class="drift-charts-arrow" aria-hidden="true">→</span>
      <figure class="drift-chart">
        ${donut([
          { value: weighted.driftedUnits, color: C_DRIFTED },
          { value: weighted.onlyInAUnits, color: C_DECL },
          { value: weighted.onlyInBUnits, color: C_SHADOW },
        ], fmtUnits(weighted.totalBadness))}
        <figcaption>weighted badness</figcaption>
      </figure>
      <ul class="drift-legend">${legendHtml}</ul>
    </div>
    <p class="drift-risk-note">${escapeHtml(frame.riskNote)} Health = aligned / (aligned + weighted badness): ${weighted.healthPct}% here, ${escapeHtml(fmtUnits(weighted.totalBadness))} badness units. A structural difference (an additional artefact) costs a fraction of a quality gap (a missing or changed one).</p>`;

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">${escapeHtml(frame.eyebrow)}</span>
      ${frame.lede}${lensNote}
    </div>
    ${partialBanner}
    <table class="drift-table">
      <caption class="diag-visually-hidden">${escapeHtml(frame.eyebrow)}, by layer</caption>
      <thead>
        <tr>
          <th class="drift-th-layer" scope="col">Layer</th>
          <th class="drift-th is-aligned" scope="col" title="Shared, and the behaviour matches">Aligned</th>
          <th class="drift-th is-drifted" scope="col" title="Shared, but field values diverge — a quality gap to review">Drifted</th>
          <th class="drift-th ${frame.aClass} ux-tone-${frame.aTone}" scope="col" title="${escapeHtml(frame.aHint)}">${escapeHtml(frame.aLabel)}</th>
          <th class="drift-th ${frame.bClass} ux-tone-${frame.bTone}" scope="col" title="${escapeHtml(frame.bHint)}">${escapeHtml(frame.bLabel)}</th>
        </tr>
      </thead>
      <tbody>${layerRowsHtml}</tbody>
      <tfoot>
        <tr class="drift-row drift-row-total">
          <th class="drift-row-layer" scope="row">Total</th>
          <td class="drift-cell is-aligned"><span class="drift-cell-n">${totAligned}</span></td>
          <td class="drift-cell is-drifted"><span class="drift-cell-n">${totDrifted}</span></td>
          <td class="drift-cell ${frame.aClass}"><span class="drift-cell-n">${totA}</span></td>
          <td class="drift-cell ${frame.bClass}"><span class="drift-cell-n">${totB}</span></td>
        </tr>
      </tfoot>
    </table>
    ${totScaffold ? `<p class="drift-oos-note">${totScaffold} template placeholder${totScaffold === 1 ? '' : 's'} (scaffold) had no source evidence in the selected environment. Shown in the pack, not counted as differences.</p>` : ''}
    ${totOOS ? `<p class="drift-oos-note">${totOOS} live artefact${totOOS === 1 ? '' : 's'} out of declared scope — members of families <strong>${escapeHtml(bName)}</strong> runs but your pack doesn't declare (the rest of the platform inventory). Shown for context, not counted as drift.
      <button type="button" class="ctrl-link drift-oos-widen" title="Switch the live scope to 'All live' so the parked inventory is classified instead of parked">show them — widen scope</button></p>` : ''}
    ${diagUx.disclosureHtml('How differences are weighted', weightsBody, { cls: 'diag-weights-disclosure' })}
  `;
  // Parked ≠ ignored: one click reclassifies the out-of-scope inventory.
  wrap.querySelector('.drift-oos-widen')?.addEventListener('click', () => {
    state.diffScopeMode = 'all';
    state.diff = null;
    refreshDiff();
  });

  // ---------- bidirectional remediation actions (item 4) ----------
  // The two arrows, right where the gaps are diagnosed. Forward (drift mode
  // only): compile + deploy the declared-not-live set — preset → deploy
  // modal. Reverse (both modes): adopt the onlyInB entries back into the
  // declared pack — live shadow signals in drift mode, the baseline's
  // declarations in gap mode. In gap mode onlyInA means "additional in the
  // live pack", so there is nothing to push. Named by EFFECT (review §4),
  // with the technical term as supporting text.
  if (totA > 0 || totB > 0) {
    const actions = document.createElement('div');
    actions.className = 'drift-actions';
    const onlyInAArts = rows.flatMap(r => r.onlyInA.map(e => e.artefact).filter(Boolean));
    const deployable = mode === 'drift'
      ? deploySelectionFromEntries(onlyInAArts.map(a => deploySurfaceForArtefact(a)))
      : { identities: new Set(), rows: 0 };
    const rfLabel = mode === 'drift' ? 'Update repository from live' : `Adopt ${totB} artefact${totB === 1 ? '' : 's'} from the baseline`;
    const rfSub = mode === 'drift'
      ? `retrofeed · ${totB} live signal${totB === 1 ? '' : 's'} not yet declared`
      : `retrofeed · copies ${escapeHtml(bName)}’s declarations into this pack`;
    actions.innerHTML = `
      ${mode === 'drift' && totA > 0 && deployable.identities.size ? `
        <button type="button" class="ctrl-btn diag-act-btn" id="drift-deploy-missing"
          title="Open the deploy modal preselected with the deployable declared-not-live artefacts (${deployable.rows} rule/dashboard row${deployable.rows === 1 ? '' : 's'})">
          <span class="diag-act-label">⇪ Deploy repository changes to live</span>
          <span class="diag-act-sub">deploy · ${deployable.identities.size} declared, not live</span></button>` : ''}
      ${totB > 0 ? `
        <button type="button" class="ctrl-btn diag-act-btn" id="drift-retrofeed"
          title="Adopt the ${mode === 'drift' ? 'live-not-declared shadow signals' : 'baseline pack’s missing declarations'} into your pack — download the additions and the updated pack for a repository PR">
          <span class="diag-act-label">⤵ ${rfLabel}</span>
          <span class="diag-act-sub">${rfSub}</span></button>` : ''}
      <div class="drift-retrofeed-result" hidden></div>
    `;
    wrap.appendChild(actions);
    actions.querySelector('#drift-deploy-missing')?.addEventListener('click', () => {
      appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: deployable.identities });
    });
    actions.querySelector('#drift-retrofeed')?.addEventListener('click', (ev) =>
      runRetrofeed(ev.currentTarget, actions.querySelector('.drift-retrofeed-result')));
  }
  return wrap;
}

// Call the retrofeed endpoint for the current A/B pair and render the
// outcome: what was adopted, what was skipped (with reasons), and the two
// downloads — the additions fragment and the full updated pack — ready to
// commit back to the service repo.
export async function runRetrofeed(btn, host, { keys, scopeMode } = {}) {
  btn.disabled = true;
  try {
    const r = await api(`/api/packs/${encodeURIComponent(state.selectedPackId)}/retrofeed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({
        packBId: state.compareBId,
        aEnv: state.selectedEnv || undefined,
        bEnv: state.compareBEnv || undefined,
        // Branch-scoped calls pass explicit keys — the keys ARE the scope,
        // so the diff runs unscoped lest scope-mode park them out of reach.
        scopeMode: scopeMode || activeDiffScopeMode(),
        service: state.selectedService || undefined,
        keys: Array.isArray(keys) && keys.length ? keys : undefined,
      }),
    });
    const dl = (label, text, filename) => {
      const url = URL.createObjectURL(new Blob([text], { type: 'application/x-yaml' }));
      return `<a class="ctrl-btn ctrl-link" href="${url}" download="${escapeHtml(filename)}">${escapeHtml(label)}</a>`;
    };
    const slug = (state.pack?.meta?.name || state.selectedPackId || 'pack').replace(/[^a-z0-9-]+/gi, '-');
    host.innerHTML = `
      <p class="drift-retrofeed-head">Adopted <strong>${r.summary.adopted}</strong> of ${r.summary.candidates} shadow signal${r.summary.candidates === 1 ? '' : 's'}${r.summary.skipped ? ` · ${r.summary.skipped} skipped` : ''}</p>
      ${r.adopted.length ? `<ul class="drift-retrofeed-list">${r.adopted.map(a => `<li>＋ <code>${escapeHtml(a.kind)}</code> ${escapeHtml(String(a.id ?? ''))}</li>`).join('')}</ul>` : ''}
      ${r.skipped.length ? `<details class="drift-retrofeed-skips"><summary>${r.skipped.length} skipped — why</summary><ul>${r.skipped.map(s => `<li><code>${escapeHtml(s.kind || '?')}</code> — ${escapeHtml(s.reason)}</li>`).join('')}</ul></details>` : ''}
      ${r.adopted.length ? `<p class="drift-retrofeed-dl">
          ${dl('⬇ additions fragment', r.fragmentYaml, `${slug}.retrofeed-fragment.yaml`)}
          ${dl('⬇ updated pack', r.updatedPackYaml, `${slug}.pack.yaml`)}
          <span class="drift-retrofeed-note">commit the updated pack to the service repo (it carries observogram.retrofeed.* provenance), then re-scan to confirm the gap closed</span>
        </p>` : ''}
    `;
    host.hidden = false;
    toast(r.summary.adopted ? `Repository update ready (retrofeed): ${r.summary.adopted} signal(s) adopted` : 'Nothing adoptable — see the skip reasons', r.summary.adopted ? '' : 'error');
    diagUx.announce(r.summary.adopted
      ? `Repository update ready: ${r.summary.adopted} of ${r.summary.candidates} adopted. Download the updated pack to commit it.`
      : 'Nothing could be adopted from live. See the skip reasons.');
  } catch (e) {
    host.innerHTML = `<p class="drift-retrofeed-head is-error">Updating the repository from live (retrofeed) failed: ${escapeHtml(e.message)}</p>`;
    diagUx.announce('Updating the repository from live failed.');
    host.hidden = false;
  } finally {
    btn.disabled = false;
  }
}

// ============================================================
// Posture matrix — outcome-based observability assessment.
//
// The question this answers: "are we monitoring the right things at
// the right levels with the right mechanisms?" Four layers (Infra /
// Platform / Application / UX) × eleven mechanisms (instrumentation,
// metrics, logs, traces, profiles, SLI, SLO, alert, dashboard,
// runbook, chaos, synthetic). Heuristic classifier on artefact ids,
// titles, dashboard folders, alert names — overridable via
// `metadata.annotations.layer.<artefact-id>: infra|platform|app|ux`.
// ============================================================
// Platform-wide mechanisms — single status, doesn't depend on layer.
const POSTURE_MECHANISMS_GLOBAL = [
  { key: 'instrumentation', label: 'OTel SDK',     hint: 'instrumentation contract' },
  { key: 'baselines',       label: 'Baselines',    hint: 'MTTD/MTTR targets' },
];

// Classifier — returns the layer for an artefact, or null if it's
// not layer-attributable (e.g., OTel SDK config applies platform-wide).
// Falls back through: explicit annotation override → pattern match
// on id/title/folder/refs → unknown (counted but uncategorised).
//
// NB: `\b` word-boundaries do NOT match between two word-chars, and
// `_` is a word-char in JS regex. So `\bavailability\b` would FAIL
// against `kx_wallet_availability_99`. Patterns below avoid `\b` and
// rely on substring presence, since these tokens are distinctive
// enough that false positives are rare.
// classifyArtefactLayer / classifyArtefactMechanism / computePostureMatrix
// now live in studio/diagnostic-grade.mjs (imported above).

export function renderPostureMatrix(posture) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-matrix-block';
  const cellVal = (layer, mech) => {
    const arr = posture.cells[`${layer}:${mech}`];
    return arr && arr.length ? arr : null;
  };
  const cellHtml = (layer, mech) => {
    const arr = cellVal(layer, mech);
    if (!arr) return `<td class="posture-cell is-absent" title="No ${mech} attested for ${layer}">✗</td>`;
    const evidenceOnly = arr.every(a => a._evidence);
    const cls = evidenceOnly ? 'is-evidence' : 'is-present';
    const sample = arr.slice(0, 3).map(a => escapeHtml(a.title || a.id)).join(' · ');
    const more = arr.length > 3 ? ` · +${arr.length - 3} more` : '';
    return `<td class="posture-cell ${cls}" title="${escapeHtml(sample + more)}">
      <span class="posture-pip">${evidenceOnly ? '○' : '✓'}</span>
      <span class="posture-count">${arr.length}</span>
    </td>`;
  };

  const headRow = `<tr>
    <th class="posture-mech-col">Mechanism</th>
    ${POSTURE_LAYERS.map(l => `<th class="posture-layer-col">
      <div class="posture-layer-label">${escapeHtml(l.label)}</div>
      <div class="posture-layer-hint">${escapeHtml(l.hint)}</div>
    </th>`).join('')}
  </tr>`;
  const bodyRows = POSTURE_MECHANISMS_PER_LAYER.map(m => `<tr>
    <th class="posture-mech-cell">
      <span class="posture-mech-label">${escapeHtml(m.label)}</span>
      <span class="posture-mech-hint">${escapeHtml(m.hint)}</span>
    </th>
    ${POSTURE_LAYERS.map(l => cellHtml(l.key, m.key)).join('')}
  </tr>`).join('');
  const platformRows = POSTURE_MECHANISMS_GLOBAL.map(m => {
    const pass = !!posture.platformWide[m.key];
    return `<tr class="is-platform-wide">
      <th class="posture-mech-cell">
        <span class="posture-mech-label">${escapeHtml(m.label)}</span>
        <span class="posture-mech-hint">${escapeHtml(m.hint)}</span>
      </th>
      <td class="posture-cell-span" colspan="${POSTURE_LAYERS.length}">
        <span class="posture-pip">${pass ? '✓' : '✗'}</span>
        <span class="posture-platform-msg">${pass ? 'declared at the pack level (applies to all layers)' : 'not declared'}</span>
      </td>
    </tr>`;
  }).join('');

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">POSTURE</span>
      Are we monitoring the right things at the right levels?
    </div>
    <table class="posture-matrix">
      <thead>${headRow}</thead>
      <tbody>${bodyRows}${platformRows}</tbody>
    </table>
    <div class="posture-matrix-legend">
      ✓ artefact declared in the pack · ○ evidence-only (firing alert, scrape job, recording rule output — declaration missing) · ✗ absent
    </div>
  `;
  return wrap;
}

export function renderPostureNarrative(posture) {
  // Template-driven (no LLM). For each layer, count how many of the
  // 10 layer-specific mechanisms are present (declared OR evidence),
  // then map to a sentence.
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-narrative-block';

  const layerScore = (layer) => {
    let present = 0;
    let evidenceOnly = 0;
    let missing = [];
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${layer}:${m.key}`];
      if (arr && arr.length) {
        present++;
        if (arr.every(a => a._evidence)) evidenceOnly++;
      } else {
        missing.push(m.label);
      }
    }
    return { present, evidenceOnly, missing, total: POSTURE_MECHANISMS_PER_LAYER.length };
  };

  const sentences = POSTURE_LAYERS.map(l => {
    const s = layerScore(l.key);
    let verdict, body;
    const pct = Math.round((s.present / s.total) * 100);
    if (s.present === 0) {
      verdict = 'is-dark';
      body = `<strong>${escapeHtml(l.label)}</strong> is dark — no coverage detected across any mechanism.`;
    } else if (s.present <= 3) {
      verdict = 'is-thin';
      body = `<strong>${escapeHtml(l.label)}</strong> is thinly covered (${s.present}/${s.total} mechanisms) — missing ${s.missing.slice(0, 4).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}${s.missing.length > 4 ? ', and more' : ''}.`;
    } else if (s.present <= 6) {
      verdict = 'is-partial';
      body = `<strong>${escapeHtml(l.label)}</strong> is partially covered (${s.present}/${s.total}, ${pct}%) — gaps in ${s.missing.slice(0, 3).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}.`;
    } else if (s.present <= 8) {
      verdict = 'is-strong';
      body = `<strong>${escapeHtml(l.label)}</strong> is well-covered (${s.present}/${s.total}, ${pct}%)${s.missing.length ? ` — still missing ${s.missing.slice(0, 2).map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}` : ''}.`;
    } else {
      verdict = 'is-complete';
      body = `<strong>${escapeHtml(l.label)}</strong> is comprehensively covered (${s.present}/${s.total}, ${pct}%)${s.missing.length ? `, only missing ${s.missing.map(x => `<em>${escapeHtml(x.toLowerCase())}</em>`).join(', ')}` : ''}.`;
    }
    if (s.evidenceOnly > 0 && s.evidenceOnly === s.present) {
      body += ` <span class="posture-narr-caveat">All evidence is observational, not declared in the pack — consider authoring explicit SLI/SLO/alert/dashboard artefacts.</span>`;
    } else if (s.evidenceOnly > 0) {
      body += ` <span class="posture-narr-caveat">${s.evidenceOnly} of the ${s.present} mechanisms are evidence-only (firing alert, scrape job, recording-rule output) — declaration in the pack is still missing.</span>`;
    }
    return `<li class="${verdict}">${body}</li>`;
  }).join('');

  // Cross-layer findings — runbook coverage, chaos coverage, sli/slo balance.
  const allRunbookCells = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:runbook`]?.length || 0);
  const totalRunbooks = allRunbookCells.reduce((a, b) => a + b, 0);
  const allChaosCells = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:chaos`]?.length || 0);
  const totalChaos = allChaosCells.reduce((a, b) => a + b, 0);
  const sliCount = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:sli`]?.length || 0).reduce((a, b) => a + b, 0);
  const sloCount = POSTURE_LAYERS.map(l => posture.cells[`${l.key}:slo`]?.length || 0).reduce((a, b) => a + b, 0);

  const crossFindings = [];
  if (totalRunbooks === 0) crossFindings.push(`<li>⚠ <strong>Zero runbooks linked</strong> across any layer — your biggest operational risk. When an alert fires, oncall has no scripted response path.</li>`);
  if (totalChaos === 0) crossFindings.push(`<li>⚠ <strong>No chaos experiments declared</strong> — recovery procedures haven't been validated against actual fault injection.</li>`);
  if (sliCount > 0 && sloCount === 0) crossFindings.push(`<li>⚠ ${sliCount} SLI${sliCount === 1 ? '' : 's'} defined but <strong>no matching SLO</strong> — measurement without a target.</li>`);
  if (sliCount > sloCount && sloCount > 0) crossFindings.push(`<li>${sliCount} SLIs vs ${sloCount} SLOs — ${sliCount - sloCount} SLI${sliCount - sloCount === 1 ? '' : 's'} unbound to a target.</li>`);
  if (!posture.platformWide.baselines) crossFindings.push(`<li>No <strong>MTTD/MTTR baselines</strong> declared — without targets, incident response can't be benchmarked.</li>`);

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">BRIEFING</span>
      Per-layer narrative — what's covered, what's missing
    </div>
    <ul class="posture-narrative">${sentences}</ul>
    ${crossFindings.length ? `
      <div class="posture-cross">
        <div class="posture-cross-head">Cross-layer findings</div>
        <ul class="posture-cross-list">${crossFindings.join('')}</ul>
      </div>` : ''}
  `;
  return wrap;
}

// ============================================================
// The Benchmark headline — frames the WHOLE view as a question
// the audience can answer. Leads the view; everything beneath
// answers it.
// ============================================================
// ============================================================
// Diagnostic-grade verdict — the CEO question, made answerable.
//
// "Is our observability diagnostic-grade?" answered as seven scored
// pass/fail criteria (grade schema 2) plus one informational row:
//
//   2A — COVERAGE (vs Observability Contract)
//        "Are we observing the right signals?"
//        Four criteria evaluated on Pack A against Pack B (the
//        contract / "what good looks like"):
//          1. Multi-modal    — metrics + logs + traces flowing
//          2. Correlated     — tracecontext + log_correlation
//          3. Calibrated     — baselines + SLOs w/ numeric objectives
//          4. Comprehensive  — posture matrix ≥ 50% across layers
//
//   2B — TRUST (signal integrity)
//        "Can we trust what the signals show?"
//        Three criteria evaluated on Pack A's live evidence:
//          5. Chaos-validated — chaos experiments declared
//          6. Drift-free      — declared artefacts match live state
//                               (MCP probe success / total ratio)
//          7. Fresh           — mcp.refreshedAt within staleness window
//
//   2C — OPERABILITY (informational, never scored)
//        Actionable — remediation runbooks declared. Response readiness
//        of the overall solution, not diagnostic capability; reclassified
//        out of the scored grade 2026-06-10 (maintainer-ratified).
//
// Overall score (out of 7) → verdict word. Most criteria are binary;
// drift-free contributes fractional credit equal to weighted fidelity.
// Verdict bands are percentages so they survive schema changes:
//   >85%   → Diagnostic-grade (same bar as the audit PASS stamp)
//   >=62.5% → Almost diagnostic-grade
//   >=37.5% → Not yet diagnostic-grade
//   below  → Far from diagnostic-grade
// ============================================================

// Diagnose view — the compliance report's DETAIL sections. Density and
// evidence are the design language; every row encodes observed vs
// expected. Since the 2026-09 UX review the report no longer leads: the
// decision header (renderAssessmentHeaderHtml) states the result, top
// causes and next action first, and this function supplies the evidence
// behind it as parts the view places under its section index:
//   evidenceHtml      #diag-evidence — the scored checks (2A/2B, 2C info)
//                     plus the expected-vs-observed ledger
//   requirementsHtml  #diag-requirements — requirement-chain integrity
//   ladderHtml        the instrument-grade ladder, for "How the grade is
//                     calculated"
//   failingChecks     scored checks not passing (the section's issue count)
function renderDiagnosticGradeVerdict(diagnostic) {
  const cov = diagnostic.coverage;
  const trust = diagnostic.trust;
  const operability = diagnostic.operability || { criteria: [], informational: true, note: '' };
  const overall = diagnostic.overall;

  const pct = (passed, total) => total === 0 ? 0 : Math.round((passed / total) * 100);
  const fmtScore = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  const criterionState = (c) => c.pass ? 'is-pass' : (criterionScore(c) > 0 ? 'is-partial' : 'is-fail');
  // One status vocabulary (review §2): the result column answers the
  // ASSESSMENT question only — pass, partial credit, fail — with the chip's
  // own shape, so colour is never the only cue.
  const criterionChip = (c) => c.pass
    ? diagUx.statusChipHtml('assessment', 'pass')
    : criterionScore(c) > 0
      ? diagUx.statusChipHtml('assessment', 'warning', { label: 'Partial', extraTip: `Partial credit: ${Math.round(criterionScore(c) * 100)}% of this check.` })
      : diagUx.statusChipHtml('assessment', 'fail');
  const infoChip = (c) => `<span class="ux-chip ux-chip-neutral ux-chip-assessment" title="Shown for context; never scored.">Not scored · ${c.pass ? 'yes' : 'no'}</span>`;
  const overallPct = pct(overall.passed, overall.total);
  const covPct   = pct(cov.passed, cov.total);
  const trustPct = pct(trust.passed, trust.total);
  const chainBlock = renderDiagnosticTraceabilityGraph(diagnostic.traceabilityGraph);

  // The audit (PASS when score >85%) stays the machine contract — journey
  // gates and run records key off it. What USERS see is the instrument
  // grade: the metrology-style letter the score lands on. The two can
  // never disagree: A begins strictly above the audit bar.
  const audit = overall.audit || diagnosticAuditStatus(overall.passed, overall.total);
  const ig = overall.instrumentGrade || instrumentGradeFor(audit.scorePctExact);

  // ---------- Criterion table (2A, 2B or 2C) ----------
  // One row per criterion. Tight. Result · name · observed · expected.
  const critTable = (criteria, { informational = false } = {}) => `
    <table class="diag-crit-table">
      <thead>
        <tr>
          <th class="c-pip" scope="col">Result</th>
          <th class="c-name" scope="col">Check</th>
          <th class="c-obs" scope="col">Observed</th>
          <th class="c-exp" scope="col">Expected</th>
        </tr>
      </thead>
      <tbody>
        ${criteria.map(c => `
          <tr class="diag-crit ${criterionState(c)}" data-key="${escapeHtml(c.key)}">
            <td class="c-pip">${informational ? infoChip(c) : criterionChip(c)}</td>
            <td class="c-name">${escapeHtml(c.label)}</td>
            <td class="c-obs">${escapeHtml(c.detail)}</td>
            <td class="c-exp">${escapeHtml(c.sub)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // ---------- Evidence ledger — the "where the data came from" audit trail ----------
  // Every claim above is backed by a specific pack field; this table
  // names the field, what we expected, what we observed, and the verdict.
  // For an audit tool this is the most important section, not the least.
  const evidenceRows = [];
  // Collect from criteria themselves — each criterion encodes an evidence assertion.
  const C = (key) => cov.criteria.find(c => c.key === key)
    || trust.criteria.find(c => c.key === key)
    || operability.criteria.find(c => c.key === key);
  const rowFor = (key, field, exp, extra = {}) => ({
    key, field, exp,
    obs: C(key)?.detail || '—',
    pass: C(key)?.pass,
    score: C(key)?.score,
    ...extra,
  });
  evidenceRows.push(rowFor('multi-modal', 'spec.telemetry.backends[].signal', 'metrics + logs + traces (≥ 3 of 4)'));
  evidenceRows.push(rowFor('correlated', 'spec.otel.sdk.propagators', 'includes tracecontext'));
  evidenceRows.push(rowFor('calibrated', 'spec.slos[].objective + spec.baselines', '≥ 1 SLO with numeric objective · MTTD/MTTR baselines declared'));
  evidenceRows.push(rowFor('comprehensive', 'posture matrix · 4 layers × 10 mechanisms', 'average ≥ 50% observed'));
  evidenceRows.push(rowFor('actionable', 'spec.remediation[]', '≥ 1 remediation runbook declared (informational — not scored)', { informational: true }));
  evidenceRows.push(rowFor('chaos-validated', 'spec.validation.chaos_experiments[]', '≥ 1 chaos experiment declared'));
  evidenceRows.push(rowFor('drift-free', 'requirement derivation graph · fallback repo-vs-live diff / mcp probes', 'declared SLO/SLI chains active in live; fallback ≥70% probes when no live pack is loaded'));
  evidenceRows.push(rowFor('fresh', 'metadata.annotations.mcp.refreshedAt', 'within last 24h'));
  const scoredRows = evidenceRows.filter(r => !r.informational);

  const evidenceTable = `
    <table class="diag-evidence-table">
      <thead>
        <tr>
          <th class="e-field" scope="col">Field</th>
          <th class="e-exp" scope="col">Expected</th>
          <th class="e-obs" scope="col">Observed</th>
          <th class="e-status" scope="col">Result</th>
        </tr>
      </thead>
      <tbody>
        ${evidenceRows.map(r => `
          <tr class="${r.informational ? 'is-info' : criterionState(r)}" data-key="${escapeHtml(r.key)}">
            <td class="e-field">${escapeHtml(r.field)}</td>
            <td class="e-exp">${escapeHtml(r.exp)}</td>
            <td class="e-obs">${escapeHtml(r.obs)}</td>
            <td class="e-status">${r.informational ? infoChip(r) : criterionChip(r)}</td>
          </tr>
        `).join('')}
      </tbody>
    </table>
  `;

  // The instrument-grade ladder: every rung rendered top (best) → bottom,
  // the rung the score lands on highlighted. The grade is NEVER shown
  // naked — the decision header carries letter + class + blurb, the rung
  // labels carry the metrology vocabulary, and the ladder note explains
  // what the scale derives from. (These narrative pieces are maintainer-
  // ratified — 2026-06-11: "grades cannot be put into context without some
  // narrative". Do not strip them to de-duplicate.) Since the 2026-09 UX
  // review the ladder is reference material under "How the grade is
  // calculated" rather than an equal-weight panel beside the result.
  const ladderHtml = `
    <ul class="grade-ladder">
      ${INSTRUMENT_GRADE_SCALE.map(g => {
        const current = g.letter === ig.letter;
        const unreachable = g.minPct === null;
        const tip = g.blurb + (unreachable ? ` Requires ${g.requires}.` : '') + (current ? ` ← this pack: ${overallPct}%.` : '');
        return `
        <li class="grade-rung tier-${g.tier} ${current ? 'is-current' : ''} ${unreachable ? 'is-unreachable' : ''}" title="${escapeHtml(tip)}"${current ? ' aria-current="true"' : ''}>
          <span class="grade-rung-letter">${escapeHtml(g.letter)}</span>
          <span class="grade-rung-label">${escapeHtml(g.label)}</span>
          <span class="grade-rung-range">${escapeHtml(g.range)}</span>
        </li>`;
      }).join('')}
    </ul>
    <p class="grade-ladder-note">Grades derive from the verification score — A starts strictly above the ${audit.threshold}% audit bar, so the letter and the machine PASS/FAIL always agree. Verification evidence, not incident-validation. A++ needs external reference evidence this instrument cannot produce alone.</p>
  `;

  const failingChecks = [...cov.criteria, ...trust.criteria].filter(c => !c.pass).length;

  const evidenceHtml = `
    <section class="diag-block ux-section-target" id="diag-evidence" tabindex="-1" aria-labelledby="diag-evidence-title">
      <header class="diag-block-head">
        <h2 class="diag-block-title" id="diag-evidence-title">Evidence — the checks behind the grade</h2>
        <p class="diag-block-lede">Seven scored checks make up the ${escapeHtml(ig.letter)} grade: four for ${diagUx.termHtml('coverage')} and three for ${diagUx.termHtml('trust')}. Operability is shown for context and never scored.</p>
      </header>

      <section class="diag-section">
        <header class="diag-section-head">
          <span class="diag-section-num">2A</span>
          <span class="diag-section-title">Coverage — are we observing the right signals?</span>
          <span class="diag-section-meta">${fmtScore(cov.passed)} of ${cov.total} checks · ${covPct}%</span>
        </header>
        ${critTable(cov.criteria)}
      </section>

      <section class="diag-section">
        <header class="diag-section-head">
          <span class="diag-section-num">2B</span>
          <span class="diag-section-title">Trust — can we trust what the signals show?</span>
          <span class="diag-section-meta">${fmtScore(trust.passed)} of ${trust.total} checks · ${trustPct}%</span>
        </header>
        ${!trust.hasMcpSource ? `
          <div class="diag-banner" role="note">
            <span class="diag-banner-key">WARN</span>
            Nothing live backs this pack. “Drift-free” and “Fresh” need a live draft (MCP) or a live refresh to verify.
          </div>
        ` : ''}
        ${critTable(trust.criteria)}
      </section>

      <section class="diag-section diag-section-info">
        <header class="diag-section-head">
          <span class="diag-section-num">2C</span>
          <span class="diag-section-title">Operability — can oncall act on what it sees?</span>
          <span class="diag-section-meta">informational · not scored</span>
        </header>
        <div class="diag-banner" role="note">
          <span class="diag-banner-key">INFO</span>
          ${escapeHtml(operability.note || 'response readiness, not diagnostic capability — observed, displayed, never scored')}
        </div>
        ${critTable(operability.criteria, { informational: true })}
      </section>

      <section class="diag-section">
        <header class="diag-section-head">
          <span class="diag-section-num">⊜</span>
          <span class="diag-section-title">Evidence ledger — expected vs observed, field by field</span>
          <span class="diag-section-meta">${fmtScore(scoredRows.reduce((n, r) => n + criterionScore(r), 0))} of ${scoredRows.length} evidence score · +${evidenceRows.length - scoredRows.length} informational</span>
        </header>
        ${evidenceTable}
      </section>
    </section>
  `;

  const requirementsHtml = chainBlock ? `
    <div class="diag-block ux-section-target" id="diag-requirements" tabindex="-1">
      ${chainBlock}
    </div>` : '';

  return { evidenceHtml, requirementsHtml, ladderHtml, failingChecks };
}

// ---------- requirement-branch reconciliation (item 6) ----------

// Branches rendered in the current chain block, keyed by a per-render ref.
// The block is a static HTML string inside the grade view, so its buttons
// resolve their branch through this index via one delegated listener.
const chainBranchIndex = new Map();
let chainActionsWired = false;

// Families the retrofeed engine can re-declare (mirrors
// tools/lib/retrofeed.mjs FAMILIES). Branch adopt buttons only count these
// — offering panels/metrics would honestly skip, but offering nothing
// adoptable at all is just noise.
const ADOPTABLE_KINDS = new Set(['sli', 'slo', 'backend', 'recording_rule', 'derived_view', 'dashboard', 'alert_route', 'burn_rate']);
const adoptableLiveOnly = (branch) =>
  (branch.nodes || []).filter(n => n.status === 'live_only' && !n.virtual && ADOPTABLE_KINDS.has(n.kind));

// Find a layered artefact by its positional id (SLO-03, QRY-07, DASH-01 …)
// across every layer, including L4's keyed subgroups.
function layeredArtefactById(pack, id) {
  if (!id || !pack?.layers) return null;
  for (const v of Object.values(pack.layers)) {
    const arr = Array.isArray(v) ? v : Object.values(v || {}).flat();
    const hit = arr.find(a => a?.id === id);
    if (hit) return hit;
  }
  return null;
}

function wireChainActions() {
  if (chainActionsWired) return;
  chainActionsWired = true;
  document.addEventListener('click', (ev) => {
    const deployBtn = ev.target.closest?.('.diag-chain-deploy');
    const adoptBtn = ev.target.closest?.('.diag-chain-adopt');
    if (!deployBtn && !adoptBtn) return;
    const btn = deployBtn || adoptBtn;
    const branch = chainBranchIndex.get(btn.dataset.branch);
    if (!branch) return;
    if (deployBtn) {
      const declaredOnly = (branch.nodes || []).filter(n => n.status === 'declared_only' && !n.virtual);
      const deployable = deploySelectionFromEntries(
        declaredOnly.map(n => deploySurfaceForArtefact(layeredArtefactById(state.pack, n.aId))));
      appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: deployable.identities });
    } else {
      const keys = adoptableLiveOnly(branch).map(n => n.key);
      const host = btn.closest('.diag-chain-card')?.querySelector('.diag-chain-result');
      if (host) runRetrofeed(btn, host, { keys, scopeMode: 'off' });
    }
  });
}

export function renderDiagnosticTraceabilityGraph(graph) {
  const branches = Array.isArray(graph?.branches) ? graph.branches : [];
  const rollup = graph?.rollup;
  if (!rollup || !branches.length) return '';
  const fmtPct = (n) => `${Math.round((Number(n) || 0) * 100)}%`;
  const fmtStatus = (status) => ({
    intact: 'Intact',
    partial: 'Partial',
    broken: 'Broken',
    undeclared: 'Live-only',
  }[status] || status || 'Unknown');
  // Ladder statuses (additive, unscored): on the wire but not doing its
  // job, or a vantage that could not look. Never rendered as "missing".
  const ladderLabelFor = (node) => ({
    present_unhealthy: 'present but unhealthy',
    present_stale: 'present but stale',
    unobserved: `unobserved — ${node.ladder?.detail || 'the vantage could not look'}`,
  }[node.ladder?.status] || null);
  // What to show first when a card can only fit five: the readings that
  // move the verdicts. branch.nodes arrive sorted by scored status alone,
  // which would push an aligned-but-unhealthy node behind every live-only
  // one and out of the cap.
  const LOAD_BEARING_KINDS = new Set(['slo', 'sli', 'recording_rule', 'metric', 'burn_rate']);
  const evidenceRank = (node) => {
    const ladderStatus = node.ladder?.status || null;
    // An unobserved node is declared_only by scored status, but the vantage
    // could not look: it ranks as unobserved, not as missing.
    if (ladderStatus === 'unobserved') return 6;
    if (node.status === 'declared_only' && LOAD_BEARING_KINDS.has(node.kind)) return 0;
    if (ladderStatus === 'present_unhealthy') return 1;
    if (ladderStatus === 'present_stale') return 2;
    if (node.status === 'drifted') return 3;
    if (node.status === 'declared_only') return 4;
    if (node.status === 'unverifiable') return 5;
    if (node.status === 'live_only') return 7;
    return 8;
  };
  const evidenceFor = (branch) => {
    const interesting = (branch.nodes || [])
      .filter((node) => ['declared_only', 'drifted', 'unverifiable', 'live_only'].includes(node.status) || ladderLabelFor(node))
      .map((node, index) => ({ node, index }))
      .sort((a, b) => (evidenceRank(a.node) - evidenceRank(b.node)) || (a.index - b.index))
      .map(({ node }) => node);
    if (!interesting.length && branch.missingRoles?.length) {
      return branch.missingRoles.map((role) => `${role.role}: ${role.detail}`).join(' · ');
    }
    if (!interesting.length) return 'all load-bearing nodes aligned';
    return interesting.slice(0, 5).map((node) => {
      const base = {
        declared_only: 'missing live',
        drifted: 'drifted',
        unverifiable: 'unverifiable',
        live_only: 'live-only',
      }[node.status] || node.status;
      // The ladder reading replaces "missing live" / "aligned" (it is the
      // more honest word for that node) and rides beside the other labels.
      const ladderLabel = ladderLabelFor(node);
      const status = !ladderLabel
        ? base
        : ['aligned', 'declared_only'].includes(node.status) ? ladderLabel : `${base} · ${ladderLabel}`;
      const fields = node.deltas?.length ? ` (${node.deltas.map(d => d.field).slice(0, 3).join(', ')})` : '';
      // Structural exposure: what WOULD go blind if this declared node is
      // really gone or wrong live — never a claim that it is blind now.
      const slos = ['declared_only', 'drifted'].includes(node.status) ? Number(node.blastRadius?.slos) || 0 : 0;
      const blinds = slos > 0 ? ` · blinds ${slos} SLO${slos === 1 ? '' : 's'}` : '';
      return `${node.kind}: ${node.label} · ${status}${fields}${blinds}`;
    }).join(' · ') + (interesting.length > 5 ? ` · +${interesting.length - 5}` : '');
  };
  // Requirement-branch reconciliation (item 6): each chain card carries the
  // two remediation arrows scoped to ITS OWN nodes — deploy the branch's
  // declared-not-live artefacts, adopt its live-only ones. Buttons are
  // data-driven (the chain block is a static HTML string) and resolved
  // through chainBranchIndex by a delegated listener.
  chainBranchIndex.clear();
  const cards = branches.map((branch, bi) => {
    const ref = `b${bi}`;
    chainBranchIndex.set(ref, branch);
    const liveOnly = adoptableLiveOnly(branch);
    const declaredOnly = (branch.nodes || []).filter(n => n.status === 'declared_only' && !n.virtual);
    const deployable = deploySelectionFromEntries(
      declaredOnly.map(n => deploySurfaceForArtefact(layeredArtefactById(state.pack, n.aId))));
    const actions = (deployable.identities.size || liveOnly.length) ? `
      <div class="diag-chain-actions">
        ${deployable.identities.size ? `<button type="button" class="ctrl-btn diag-chain-deploy" data-branch="${ref}"
            title="Deploy this requirement's declared-not-live artefacts (${deployable.rows} row${deployable.rows === 1 ? '' : 's'})">⇪ deploy missing (${deployable.identities.size})</button>` : ''}
        ${liveOnly.length ? `<button type="button" class="ctrl-btn diag-chain-adopt" data-branch="${ref}"
            title="Adopt this requirement's live-only artefacts back into the declared pack">⤵ adopt live-only (${liveOnly.length})</button>` : ''}
      </div>
      <div class="drift-retrofeed-result diag-chain-result" hidden></div>` : '';
    return `
    <article class="diag-chain-card diag-chain-${escapeHtml(branch.verdict)}">
      <div class="diag-chain-head">
        <span class="diag-chain-title">${escapeHtml(branch.title || branch.rootKey || 'requirement')}</span>
        <span class="diag-chain-status">${escapeHtml(fmtStatus(branch.verdict))}</span>
      </div>
      <div class="diag-chain-meta">
        <span>${escapeHtml(String(branch.integrityPct ?? Math.round((branch.integrity || 0) * 100)))}% integrity</span>
        <span>${escapeHtml(branch.confidence === 'inferred' ? 'inferred edges' : 'declared edges')}</span>
        <span>${escapeHtml(`${branch.counts?.aligned || 0} aligned`)}</span>
        ${branch.ladderVerdict ? `<span>${escapeHtml(`ladder: ${branch.ladderVerdict}`)}</span>` : ''}
      </div>
      <div class="diag-chain-evidence">${escapeHtml(evidenceFor(branch))}</div>
      ${actions}
    </article>
  `;
  }).join('');
  wireChainActions();
  return `
    <section class="diag-section diag-chain-section">
      <header class="diag-section-head">
        <span class="diag-section-num">2B.G</span>
        <span class="diag-section-title">Requirement Chains — SLO/SLI derivation integrity</span>
        <span class="diag-section-meta">${rollup.intact}/${rollup.declaredTotal} intact · ${escapeHtml(fmtPct(rollup.integrityMean))}${rollup.ladder ? escapeHtml(` · ladder ${fmtPct(rollup.ladder.integrityMean)}`) : ''}</span>
      </header>
      <div class="diag-chain-rollup">
        <span class="diag-chain-rollup-cell is-intact"><strong>${rollup.intact}</strong> intact</span>
        <span class="diag-chain-rollup-cell is-partial"><strong>${rollup.partial}</strong> partial</span>
        <span class="diag-chain-rollup-cell is-broken"><strong>${rollup.broken}</strong> broken</span>
        <span class="diag-chain-rollup-cell is-undeclared"><strong>${rollup.undeclared}</strong> live-only</span>
      </div>
      <div class="diag-chain-grid">${cards}</div>
    </section>
  `;
}

export function renderBenchmarkHeadline(posture, lens) {
  const head = document.createElement('div');
  head.className = 'benchmark-head';

  // Drill-down summary — sits BENEATH the main diagnostic-grade
  // verdict. It frames the matrix below as "the why behind the
  // verdict": coverage / observation breakdown that answers, at the
  // mechanism level, where the diagnostic-grade gaps live.
  let present = 0, evidence = 0, absent = 0;
  for (const l of POSTURE_LAYERS) {
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${l.key}:${m.key}`];
      if (!arr || arr.length === 0) absent++;
      else if (arr.every(a => a._evidence)) evidence++;
      else present++;
    }
  }
  const total = POSTURE_LAYERS.length * POSTURE_MECHANISMS_PER_LAYER.length;
  const observedPct = Math.round(((present + evidence) / total) * 100);

  const verdictWord = observedPct >= 70 ? 'Strong' : observedPct >= 40 ? 'Partial' : observedPct >= 20 ? 'Thin' : 'Critical gap';
  const verdictClass = observedPct >= 70 ? 'is-strong' : observedPct >= 40 ? 'is-partial' : observedPct >= 20 ? 'is-thin' : 'is-critical';

  // When the user has a product lens selected, the drill becomes
  // about that product specifically. Otherwise it's pack-wide.
  const lensLabel = lens === 'all' ? null : (LENS_PRODUCTS.find(lp => lp.slug === lens)?.label || lens);
  const drillFraming = lensLabel
    ? `<strong>Drill</strong> · ${escapeHtml(lensLabel)} surface — where the diagnostic-grade gaps live in ${escapeHtml(lensLabel)}'s area`
    : `<strong>Drill</strong> · per-layer × per-mechanism — where the diagnostic-grade gaps live`;

  head.innerHTML = `
    <div class="benchmark-headline-eyebrow">${drillFraming}</div>
    <div class="benchmark-headline-meta">
      <div class="benchmark-headline-verdict ${verdictClass}">
        <div class="benchmark-headline-verdict-word">${verdictWord}</div>
        <div class="benchmark-headline-verdict-sub">${present}/${total} declared · ${present + evidence}/${total} observed</div>
      </div>
      <div class="benchmark-headline-tally">
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-present">✓</span> ${present} declared</div>
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-evidence">○</span> ${evidence} evidence-only</div>
        <div class="benchmark-headline-tally-row"><span class="benchmark-headline-tally-pip is-absent">✗</span> ${absent} absent</div>
      </div>
    </div>
  `;
  return head;
}

// ============================================================
// Pie chart row — one SVG donut per layer, sized by mechanism
// coverage. Three concentric slices: declared / evidence / absent.
// Glanceable summary the audience reads in 2 seconds.
// ============================================================
export function renderPosturePieRow(posture) {
  const wrap = document.createElement('div');
  wrap.className = 'benchmark-block posture-pie-row-block';

  const pies = POSTURE_LAYERS.map(layer => {
    let present = 0, evidence = 0, absent = 0;
    const declaredMechs = [];
    const evidenceMechs = [];
    const missingMechs = [];
    for (const m of POSTURE_MECHANISMS_PER_LAYER) {
      const arr = posture.cells[`${layer.key}:${m.key}`];
      if (!arr || arr.length === 0) { absent++; missingMechs.push(m.label); }
      else if (arr.every(a => a._evidence)) { evidence++; evidenceMechs.push(m.label); }
      else { present++; declaredMechs.push(m.label); }
    }
    const total = POSTURE_MECHANISMS_PER_LAYER.length;
    const declaredPct = Math.round((present / total) * 100);
    const obsPct = Math.round(((present + evidence) / total) * 100);
    const verdict = obsPct >= 70 ? 'strong' : obsPct >= 40 ? 'partial' : obsPct >= 20 ? 'thin' : 'dark';

    // Build a stacked donut: each slice's arc-length proportional to count.
    // r=42 inside a 110×110 viewBox; circumference C = 2πr ≈ 263.9.
    const R = 42, C = 2 * Math.PI * R;
    const seg = (count) => (count / total) * C;
    const sPres = seg(present), sEvi = seg(evidence), sAbs = seg(absent);
    // Start at top (-90deg), stroke segments end-to-end.
    return `
      <div class="posture-pie" data-verdict="${verdict}" title="${escapeHtml(`Declared: ${declaredMechs.join(', ') || 'none'}\nEvidence-only: ${evidenceMechs.join(', ') || 'none'}\nMissing: ${missingMechs.join(', ') || 'none'}`)}">
        <svg viewBox="0 0 110 110" class="posture-pie-svg" role="img" aria-label="${escapeHtml(layer.label + ' coverage ' + obsPct + '%')}">
          <circle cx="55" cy="55" r="${R}" fill="none" stroke="rgba(178,34,34,0.2)" stroke-width="14"/>
          ${present > 0 ? `<circle cx="55" cy="55" r="${R}" fill="none" stroke="rgb(46,110,50)"  stroke-width="14"
            stroke-dasharray="${sPres} ${C - sPres}" stroke-dashoffset="${C / 4}" transform="rotate(-90 55 55)"/>` : ''}
          ${evidence > 0 ? `<circle cx="55" cy="55" r="${R}" fill="none" stroke="rgb(217,119,6)" stroke-width="14"
            stroke-dasharray="${sEvi} ${C - sEvi}" stroke-dashoffset="${C / 4 - sPres}" transform="rotate(-90 55 55)"/>` : ''}
          <text x="55" y="58" text-anchor="middle" class="posture-pie-pct">${obsPct}%</text>
          <text x="55" y="74" text-anchor="middle" class="posture-pie-sub">${present + evidence}/${total}</text>
        </svg>
        <div class="posture-pie-label">${escapeHtml(layer.label)}</div>
        <div class="posture-pie-verdict">${verdict}</div>
      </div>
    `;
  }).join('');

  wrap.innerHTML = `
    <div class="benchmark-block-head">
      <span class="benchmark-block-eyebrow">AT A GLANCE</span>
      Coverage per layer — observed (declared + evidence) over total mechanisms
    </div>
    <div class="posture-pie-row">${pies}</div>
    <div class="posture-pie-legend">
      <span class="posture-pie-legend-pip" style="background:rgb(46,110,50)"></span> declared in pack
      <span class="posture-pie-legend-pip" style="background:rgb(217,119,6)"></span> evidence-only
      <span class="posture-pie-legend-pip" style="background:rgba(178,34,34,0.4)"></span> missing
    </div>
  `;
  return wrap;
}

function renderCompareView(view) {
  if (!state.compareBId) state.compareBId = defaultCompareB();
  if (!state.compareBEnv) state.compareBEnv = defaultEnvFor(state.compareBId);

  if (!state.compareBId) {
    // Append (never replace view.innerHTML): the Diagnose sub-nav above
    // must survive the empty state.
    const empty = document.createElement('div');
    empty.className = 'compare-digest';
    empty.innerHTML = diagUx.emptyStateHtml({
      title: 'There is no baseline to compare with yet.',
      checked: 'The pack catalog — a comparison needs at least two packs.',
      body: 'Load or scan another pack (for example a live draft, or a curated repository pack) from Discover, then come back to compare.',
    });
    view.appendChild(empty);
    return;
  }

  const scaffold = document.createElement('section');
  scaffold.className = 'section compare-view';
  scaffold.dataset.layer = 'COMPARE';
  view.appendChild(scaffold);

  const haveA = !!state.pack;
  const haveB = !!state.packB;
  // Stale diffs (computed for a different pack/env/scope selection) count
  // as missing so this view can never classify against the wrong packs.
  const diffCurrent = !!state.diff && diffMatchesSelection(state.diff);
  const haveDiff = diffCurrent && !state.diff.error;
  if (!haveA || !haveB || !haveDiff) {
    if (diffCurrent && state.diff?.error) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = `The comparison failed: ${state.diff.error}`;
      scaffold.appendChild(err);
      return;
    }
    if (!state.selectedPackId) {
      const err = document.createElement('div');
      err.className = 'error';
      err.textContent = 'Compare needs this pack registered on the server — re-upload or rescan it, then retry.';
      scaffold.appendChild(err);
      return;
    }
    const loading = document.createElement('div');
    loading.className = 'placeholder';
    loading.setAttribute('role', 'status');
    loading.textContent = 'Loading both packs…';
    scaffold.appendChild(loading);
    Promise.all([
      haveB    ? Promise.resolve() : appHost.loadPackB(),
      haveDiff ? Promise.resolve() : loadDiff(),
    ]).then(() => {
      // Only re-render on progress — see the twin guards in the grade and
      // traceability views; an unchanged re-entry would loop.
      if (state.packB && state.diff) { appHost.renderTabs(); appHost.renderMainView(); return; }
      loading.className = 'error';
      loading.textContent = 'The comparison failed to load — pick the baseline (Pack B) again or reload.';
    })
      .catch((e) => {
        loading.className = 'error';
        loading.textContent = `Failed to load packs: ${e.message}`;
      });
    return;
  }

  // The screen grammar: context (both packs named) · decision · next
  // action first; then ONE switch — Summary (default) · Changes needing
  // review · All differences — over the same lensed digest.
  const lens = state.compareLens || 'all';
  const ctx = diagnoseContext();
  const digest = diffDigest(state.diff, state.packB, lens);
  const cmp = buildCompareDecision(digest, ctx);
  const focus = ['summary', 'review', 'all'].includes(state.compareFocus) ? state.compareFocus : 'summary';

  // Build per-layer key-set lookups once (the roles ride along so every
  // card and column names its side the same way).
  const sets = buildCompareKeySets();
  sets.roles = ctx.roles;

  const lead = document.createElement('div');
  lead.className = 'compare-digest';
  lead.innerHTML = renderCompareDecisionHtml(cmp, ctx) + compareFocusSwitchHtml(focus, cmp);
  scaffold.appendChild(lead);

  if (focus === 'summary') {
    const body = document.createElement('div');
    body.className = 'compare-digest compare-digest-body';
    body.innerHTML = compareSummaryHtml(digest, cmp, ctx);
    scaffold.appendChild(body);
    // What is being compared, and the controls to change it — after the answer.
    const packsHead = document.createElement('div');
    packsHead.className = 'compare-digest compare-packs-head';
    packsHead.innerHTML = `<h2 class="diag-block-title">Packs being compared</h2><p class="diag-block-lede">Change either side, or swap them. The ${escapeHtml(ctx.roles.aNoun)} is Pack A; the ${escapeHtml(ctx.roles.bNoun)} is Pack B.</p>`;
    scaffold.appendChild(packsHead);
    scaffold.appendChild(renderComparePackHeaders());
  } else if (focus === 'review') {
    scaffold.appendChild(renderCompareReview(digest, cmp, ctx));
  } else {
    // All differences — the expert side-by-side: identity cards, the set
    // arithmetic, slice filters + lens + scope + search, then the per-layer
    // rows (layer head spanning both columns, A grid left, B grid right).
    scaffold.appendChild(renderComparePackHeaders());
    scaffold.appendChild(renderCompareSummary(digest, ctx));
    scaffold.appendChild(renderCompareFilters());
    for (const L of LAYERS_FOR_DIFF) {
      const row = renderCompareLayerRow(L, sets);
      if (row) scaffold.appendChild(row);
    }
  }
  wireDiagActions(scaffold);
}

function buildCompareKeySets() {
  // Diff entry keys are behavioural identity keys (identityKeyOf, server-side)
  // — a keyspace the client can't rebuild from `defines`/id. Every entry
  // embeds the artefact object(s) it paired though, and artefact ids are
  // unique within a pack side, so cards classify by id per side instead.
  // Out-of-scope live artefacts stay unclassified on purpose — the summary
  // arithmetic excludes them too.
  const aStatus = {}, bStatus = {};
  for (const L of LAYERS_FOR_DIFF) {
    const bucket = state.diff.layers[L] || {};
    const a = new Map(), b = new Map();
    for (const e of bucket.inBoth || []) {
      if (e.a?.id) a.set(e.a.id, 'both');
      if (e.b?.id) b.set(e.b.id, 'both');
    }
    for (const e of bucket.onlyInA || []) if (e.artefact?.id) a.set(e.artefact.id, 'only');
    for (const e of bucket.onlyInB || []) if (e.artefact?.id) b.set(e.artefact.id, 'only');
    aStatus[L] = a;
    bStatus[L] = b;
  }
  return { aStatus, bStatus };
}

// 'both' | 'only' | null for one card. null = not part of the comparison
// (panels are excluded from the diff; out-of-scope live artefacts are parked).
function compareStatusFor(side, L, art, sets) {
  const byId = side === 'a' ? sets.aStatus[L] : sets.bStatus[L];
  return (art?.id && byId?.get(art.id)) || null;
}

// New: stacked PACK A + PACK B header band, side-by-side.
function renderComparePackHeaders() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-pack-headers';
  wrap.appendChild(renderComparePackHeader('a', state.pack,  state.diff?.a));

  // Swap button BETWEEN the two cards — visually anchors the
  // "A vs B" relationship and removes the need for a separate
  // picker band. Disabled when there's nothing to swap to.
  const swapWrap = document.createElement('div');
  swapWrap.className = 'compare-swap-wrap';
  swapWrap.innerHTML = `
    <button class="compare-swap-btn" type="button" id="compare-swap-btn" title="Swap PACK A and PACK B (and their envs)" aria-label="Swap packs">
      <span class="csb-arrow">⇄</span>
      <span class="csb-label">swap</span>
    </button>
  `;
  swapWrap.querySelector('#compare-swap-btn').onclick = () => {
    const aId  = state.selectedPackId;
    const aEnv = state.selectedEnv;
    if (!state.compareBId) return;
    state.selectedPackId = state.compareBId;
    state.selectedEnv    = state.compareBEnv;
    state.compareBId  = aId;
    state.compareBEnv = aEnv;
    state.diff = null; state.packB = null;
    refresh();
    refreshDiff();
  };
  wrap.appendChild(swapWrap);

  wrap.appendChild(renderComparePackHeader('b', state.packB, state.diff?.b));
  return wrap;
}

function uploadedSourceHint(p) {
  if (p?.source !== 'uploaded') return '';
  const m = String(p.description || '').match(/^Uploaded pack\s+—\s+(.+)$/);
  const source = (m?.[1] || '').trim();
  if (!source || source === p.label || source === p.name) return '';
  return source;
}

function packOptionLabel(p) {
  const version = p.version || '?';
  const source = uploadedSourceHint(p);
  return `${p.label || p.id} · v${version}${source ? ` · from ${source}` : ''}`;
}

function renderComparePackHeader(side, pack, diffMeta) {
  const card = document.createElement('div');
  card.className = `compare-pack-card compare-pack-card-${side}`;
  const tier = pack?.meta?.criticality || '?';
  const sourcePill = inferPackSource(pack);   // 'Repo' | 'Live' | 'Target' | 'Pack'
  // Artefact count: sum across all layers (L4 has sub-buckets).
  let count = 0;
  for (const L of LAYERS_FOR_DIFF) {
    if (L === 'L4') {
      const L4 = pack?.layers?.L4 || {};
      count += (L4.policy?.length || 0) + (L4.alerting?.length || 0) + (L4.healing?.length || 0);
    } else {
      count += (pack?.layers?.[L] || []).length;
    }
  }
  // Resolve the active id + env per side, plus the catalog entry so we
  // use the catalog label (what the user PICKED) rather than the YAML's
  // metadata.name (which can differ — bug surfaced by user feedback).
  const activeId  = (side === 'a') ? state.selectedPackId : state.compareBId;
  const activeEnv = (side === 'a') ? state.selectedEnv   : state.compareBEnv;
  const catalogEntry = catalogEntryFor(activeId);
  const displayLabel = catalogEntry?.label || pack?.name || activeId || '?';
  const envOptions   = catalogEntry?.environments || [];
  const tierResolved = catalogEntry?.criticality || tier;
  const versionResolved = catalogEntry?.version || pack?.meta?.version || '?';

  // Build the pack + env picker options from the live catalog.
  const packOptionsHtml = (state.catalog || [])
    .filter(p => p.ok)
    .map(p => `<option value="${escapeHtml(p.id)}" ${p.id === activeId ? 'selected' : ''}>${escapeHtml(packOptionLabel(p))}</option>`)
    .join('');
  const envOptionsHtml = (envOptions.length ? envOptions : (activeEnv ? [activeEnv] : []))
    .map(e => `<option value="${escapeHtml(e)}" ${e === activeEnv ? 'selected' : ''}>${escapeHtml(e)}</option>`)
    .join('');

  // Name the side by its role (live pack / declared pack / baseline); the
  // A/B letter stays as the expert cross-reference.
  const roles = diagnoseContext().roles;
  const roleNoun = side === 'a' ? roles.aNoun : roles.bNoun;
  card.innerHTML = `
    <div class="cpc-eyebrow" title="Pack ${side.toUpperCase()}">${escapeHtml(capitalize(roleNoun))} · Pack ${side.toUpperCase()}</div>
    <div class="cpc-pickers">
      <label class="cpc-pickfield">
        <span class="cpc-pickfield-key">pack</span>
        <select class="cpc-pack-select" data-side="${side}">${packOptionsHtml}</select>
      </label>
      <label class="cpc-pickfield cpc-pickfield-env">
        <span class="cpc-pickfield-key">env</span>
        <select class="cpc-env-select" data-side="${side}" ${envOptions.length ? '' : 'disabled'}>${envOptionsHtml || '<option>—</option>'}</select>
      </label>
    </div>
    <div class="cpc-row">
      <span class="cpc-source-pill" data-source="${escapeHtml(sourcePill)}">${escapeHtml(sourcePill)}</span>
      <span class="cpc-name" title="catalog label">${escapeHtml(displayLabel)}</span>
    </div>
    <div class="cpc-meta">
      <span class="cpc-meta-pill" data-tier="${escapeHtml(tierResolved)}">${escapeHtml(tierResolved)}</span>
      <span class="cpc-meta-pill">v${escapeHtml(versionResolved)}</span>
      <span class="cpc-meta-pill cpc-count">${count} artefact${count === 1 ? '' : 's'}</span>
    </div>
    <div class="cpc-actions">
      <button class="cpc-action-btn" data-action="evaluate" title="Show maturity score: per-tier conformance breakdown">
        <span class="cpc-action-icon">✓</span> evaluate
      </button>
      <button class="cpc-action-btn" data-action="coverage" title="Show coverage breakdown by layer + sub-bucket">
        <span class="cpc-action-icon">∑</span> coverage
      </button>
      <button class="cpc-action-btn cpc-action-deploy" data-action="deploy" title="Open the deploy modal scoped to this pack">
        <span class="cpc-action-icon">↑</span> deploy
      </button>
    </div>
  `;

  // Wire the pickers — changes trigger a reload of the affected side
  // and re-fetch the diff.
  const packSel = card.querySelector('.cpc-pack-select');
  if (packSel) packSel.onchange = () => {
    const newId = packSel.value;
    if (side === 'a') {
      state.selectedPackId = newId;
      state.selectedEnv    = defaultEnvFor(newId);
      state.diff = null;
      refresh();
      refreshDiff();
    } else {
      state.compareBId = newId;
      state.compareBEnv = defaultEnvFor(newId);
      state.diff = null; state.packB = null;
      refreshDiff();
      appHost.renderTabs(); appHost.renderMainView();
    }
  };
  const envSel = card.querySelector('.cpc-env-select');
  if (envSel) envSel.onchange = () => {
    if (side === 'a') { state.selectedEnv = envSel.value || null; refresh(); }
    else { state.compareBEnv = envSel.value || null; state.packB = null; state.diff = null; refreshDiff(); appHost.renderTabs(); appHost.renderMainView(); }
  };
  // Wire the action buttons. Evaluate opens the maturity popover;
  // coverage opens a layer-by-layer count breakdown.
  const evalBtn = card.querySelector('[data-action="evaluate"]');
  if (evalBtn) evalBtn.onclick = (e) => { e.stopPropagation(); openMaturityPopover(side, pack, card); };
  const covBtn = card.querySelector('[data-action="coverage"]');
  if (covBtn) covBtn.onclick = (e) => { e.stopPropagation(); openCoveragePopover(side, pack, card); };
  const depBtn = card.querySelector('[data-action="deploy"]');
  if (depBtn) depBtn.onclick = (e) => {
    e.stopPropagation();
    const packId = (side === 'a') ? state.selectedPackId : state.compareBId;
    appHost.openDeployModal({ packId });
  };
  return card;
}

// ------------------------------------------------------------
// Maturity score popover — score with per-clause pass/fail
// grouped by tier. Drives off /api/packs/:id/conformance which
// returns the rubric evaluation the studio already uses on the
// SCHEMA tab.
// ------------------------------------------------------------

async function openMaturityPopover(side, pack, anchor) {
  // Resolve which pack id to fetch conformance for.
  const packId = (side === 'a') ? state.selectedPackId : state.compareBId;
  const env    = (side === 'a') ? state.selectedEnv   : state.compareBEnv;
  // Tear down any open popover first.
  document.querySelectorAll('.maturity-popover, .coverage-popover').forEach(n => n.remove());

  const pop = document.createElement('div');
  pop.className = 'maturity-popover';
  pop.dataset.side = side;
  pop.innerHTML = `
    <div class="mp-head">
      <div class="mp-eyebrow">MATURITY SCORE</div>
      <button class="mp-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="mp-body"><div class="placeholder">Evaluating…</div></div>
  `;
  anchor.appendChild(pop);
  pop.querySelector('.mp-close').onclick = () => pop.remove();

  // Outside-click dismiss.
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && !anchor.querySelector('[data-action="evaluate"]')?.contains(e.target)) {
        pop.remove();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 50);

  try {
    const qs = env ? `?env=${encodeURIComponent(env)}` : '';
    const conf = await api(`/api/packs/${encodeURIComponent(packId)}/conformance${qs}`);
    pop.querySelector('.mp-body').innerHTML = renderMaturityPopoverBody(conf, pack?.name);
  } catch (e) {
    pop.querySelector('.mp-body').innerHTML = `<div class="error">Could not evaluate: ${escapeHtml(e.message)}</div>`;
  }
}

function renderMaturityPopoverBody(conf, packName) {
  // Conformance shape:
  //   declaredTier, conformant, scorePercent, mustPercent, must {passed,total}, should{...},
  //   clauses: [{ id, dimension, severity, minTier, description, applies, passed }]
  const score = Math.round(conf.scorePercent || 0);
  const verdict = conf.conformant ? 'conformant' : 'non-conformant';
  const verdictClass = conf.conformant ? 'mp-verdict-ok' : 'mp-verdict-err';
  // Group clauses by minTier. Display order: tier-3 first (the floor), then tier-2, then tier-1.
  // The conformance lib's clause shape is { id, dimension, severity, minTier,
  // description, applies, pass } — `pass` is null when applies=false.
  const tiers = ['tier-3', 'tier-2', 'tier-1'];
  const tierLabels = {
    'tier-3': 'TIER 3 — MINIMUM CONFORMANCE',
    'tier-2': 'TIER 2 — INTERNAL CRITICAL',
    'tier-1': 'TIER 1 — CUSTOMER-FACING',
  };
  const sections = tiers.map(t => {
    const items = (conf.clauses || []).filter(c => c.minTier === t);
    if (!items.length) return '';
    const applicable = items.filter(c => c.applies);
    const passed     = items.filter(c => c.pass === true).length;
    const countLabel = applicable.length === items.length
      ? `${passed}/${items.length}`
      : `${passed}/${applicable.length}<span class="mp-tier-na"> (${items.length - applicable.length} N/A)</span>`;
    return `
      <div class="mp-tier">
        <div class="mp-tier-head">
          <span class="mp-tier-label">${tierLabels[t]}</span>
          <span class="mp-tier-count">${countLabel}</span>
        </div>
        <ul class="mp-clauses">
          ${items.map(c => {
            const cls = !c.applies ? 'is-na' : (c.pass ? 'is-passed' : 'is-failed');
            return `
              <li class="mp-clause ${cls}" title="${escapeHtml(c.description || '')}">
                <span class="mp-clause-num">${escapeHtml(c.id)}</span>
                <span class="mp-clause-desc">${escapeHtml(c.dimension || c.description || c.id)}</span>
                <span class="mp-clause-sev">${escapeHtml(c.severity || '')}</span>
              </li>`;
          }).join('')}
        </ul>
      </div>`;
  }).join('');
  return `
    <div class="mp-score-row">
      <div class="mp-score-big">${score}<span class="mp-score-denom">/100</span></div>
      <div class="mp-score-side">
        <div class="mp-pack-name">${escapeHtml(packName || '')}</div>
        <div class="mp-verdict ${verdictClass}">${escapeHtml(verdict)}</div>
        <div class="mp-score-mini">MUST ${conf.must?.passed || 0}/${conf.must?.total || 0} · SHOULD ${conf.should?.passed || 0}/${conf.should?.total || 0}</div>
      </div>
    </div>
    ${sections}
  `;
}

// ------------------------------------------------------------
// Coverage popover — per-layer breakdown with sub-buckets so the
// SRE can see "26 L3 = 19 dashboards + 7 recording rules", etc.
// ------------------------------------------------------------

function openCoveragePopover(side, pack, anchor) {
  document.querySelectorAll('.maturity-popover, .coverage-popover').forEach(n => n.remove());
  const pop = document.createElement('div');
  pop.className = 'coverage-popover';
  pop.dataset.side = side;
  pop.innerHTML = `
    <div class="mp-head">
      <div class="mp-eyebrow">COVERAGE BREAKDOWN</div>
      <button class="mp-close" type="button" aria-label="Close">×</button>
    </div>
    <div class="mp-body">${renderCoveragePopoverBody(pack)}</div>
  `;
  anchor.appendChild(pop);
  pop.querySelector('.mp-close').onclick = () => pop.remove();
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && !anchor.querySelector('[data-action="coverage"]')?.contains(e.target)) {
        pop.remove();
        document.removeEventListener('click', onDoc);
      }
    };
    document.addEventListener('click', onDoc);
  }, 50);
}

function renderCoveragePopoverBody(pack) {
  // Sub-bucket each layer the same way the spec breaks them down.
  const breakdown = [];
  let total = 0;
  const layers = pack?.layers || {};

  function countAndAdd(layerLabel, layerKey, items, subBuckets) {
    const n = items.length;
    total += n;
    const subRows = subBuckets ? Object.entries(subBuckets).map(([k, v]) => `
      <tr class="cv-sub">
        <td class="cv-key">${escapeHtml(k)}</td>
        <td class="cv-val">${v}</td>
      </tr>`).join('') : '';
    breakdown.push(`
      <tr class="cv-row" data-layer="${escapeHtml(layerKey)}">
        <td class="cv-key"><span class="cv-pill" data-layer="${escapeHtml(layerKey)}">${escapeHtml(layerKey)}</span> ${escapeHtml(layerLabel)}</td>
        <td class="cv-val">${n}</td>
      </tr>${subRows}`);
  }

  // L1: SLIs + SLOs
  const l1 = layers.L1 || [];
  const l1Sub = {
    'SLIs':  l1.filter(x => /^SLI-/.test(x.id)).length,
    'SLOs':  l1.filter(x => /^SLO-/.test(x.id)).length,
  };
  countAndAdd('SLI/SLO', 'L1', l1, Object.values(l1Sub).reduce((a,b)=>a+b,0) > 0 ? l1Sub : null);

  // L2: Backends + Pipelines + Storage + Otel
  const l2 = layers.L2 || [];
  const l2Sub = {
    'Backends':     l2.filter(x => /^BAK-/.test(x.id)).length,
    'Pipelines':    l2.filter(x => /^PIP-/.test(x.id)).length,
    'Storage':      l2.filter(x => /^STO-/.test(x.id)).length,
    'OTel':         l2.filter(x => /^OTEL-/.test(x.id)).length,
  };
  countAndAdd('Metrics/Logs/Traces', 'L2', l2, l2Sub);

  // L2X: extended
  if ((layers.L2X || []).length) countAndAdd('Extended surfaces', 'L2X', layers.L2X);

  // L3: Queries + Views + Dashboards
  const l3 = layers.L3 || [];
  const l3Sub = {
    'Dashboards':       l3.filter(x => /^DASH-/.test(x.id)).length,
    'Recording rules':  l3.filter(x => /^QRY-/.test(x.id)).length,
    'Derived views':    l3.filter(x => /^VIEW-/.test(x.id)).length,
  };
  countAndAdd('Dashboards/Queries', 'L3', l3, l3Sub);

  // L4: policy + alerting + healing
  const l4 = layers.L4 || {};
  const l4Items = [...(l4.policy || []), ...(l4.alerting || []), ...(l4.healing || [])];
  const l4Sub = {
    'Burn-rate alerts': (l4.policy || []).filter(x => /^POL-/.test(x.id)).length,
    'Forecast alerts':  (l4.policy || []).filter(x => /^FCST-/.test(x.id)).length,
    'Alert routes':     (l4.alerting || []).length,
    'Remediation':      (l4.healing || []).length,
  };
  countAndAdd('Alerts + remediation', 'L4', l4Items, l4Sub);

  // L5: baselines + chaos + synthetic
  const l5 = layers.L5 || [];
  const l5Sub = {
    'Baselines':       l5.filter(x => /^BASE-/.test(x.id)).length,
    'Chaos':           l5.filter(x => /^CHAOS-/.test(x.id)).length,
    'Synthetic':       l5.filter(x => /^SYN-/.test(x.id)).length,
  };
  countAndAdd('Self-check', 'L5', l5, l5Sub);

  // GOV
  if ((layers.GOV || []).length) countAndAdd('Governance', 'GOV', layers.GOV);

  return `
    <table class="cv-table">
      ${breakdown.join('')}
      <tr class="cv-total">
        <td class="cv-key"><strong>Total</strong></td>
        <td class="cv-val"><strong>${total}</strong></td>
      </tr>
    </table>
    <div class="cv-foot">Sub-buckets count by id prefix (SLI-, BAK-, DASH-, etc.). Pack generated from canonical v1.3 manifest.</div>
  `;
}

function inferPackSource(pack) {
  // The studio's source taxonomy is per-artefact, not per-pack. We
  // infer the pack-level label from id + dominant artefact source.
  if (!pack) return 'Pack';
  const id = (pack.id || '').toLowerCase();
  if (id.includes('live'))     return 'Live';
  if (id.includes('target'))   return 'Target';
  if (id.includes('curated'))  return 'Repo';
  if (id.includes('skeleton')) return 'Demo';
  // Fallback: look at the artefact sources
  const first = (pack?.layers?.L1 || [])[0];
  if (first?.source === 'Verified') return 'Live';
  return 'Repo';
}

// Slice filter pills + search input.
function renderCompareFilters() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-filters';
  // Plain side names first; the A/B set operations stay as expert slices.
  const roles = diagnoseContext().roles;
  const slices = [
    { id: 'all',   label: 'All',          hint: 'Every artefact from both packs, side by side.' },
    { id: 'onlyA', label: roles.aOnly,    hint: `Pack A only: artefacts in the ${roles.aNoun} with no counterpart in the ${roles.bNoun}. The right column is empty.` },
    { id: 'onlyB', label: roles.bOnly,    hint: `Pack B only: artefacts in the ${roles.bNoun} with no counterpart in the ${roles.aNoun}. The left column is empty.` },
    { id: 'both',  label: 'Shared',       hint: 'In both packs (matched by behavioural identity — the same deployed control, whatever it is named).' },
    { id: 'a-b',   label: 'A − B',        hint: `Expert · set difference: every artefact in A (the ${roles.aNoun}), minus anything also in B.` },
    { id: 'a+b',   label: 'A + B',        hint: 'Expert · union: combined view of both packs without duplication.' },
  ];
  const active = state.compareSlice || 'all';
  for (const s of slices) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'compare-slice-pill' + (s.id === active ? ' is-active' : '');
    b.dataset.slice = s.id;
    b.textContent = s.label;
    b.title = s.hint;
    b.onclick = () => { state.compareSlice = s.id; appHost.renderMainView(); };
    wrap.appendChild(b);
  }
  // Lens — scopes the comparison to one product's surface. When the user
  // picks "Grafana", both packs are filtered to just their Grafana-surface
  // artefacts (backends, dashboards, refs, source-tool evidence). Lets a
  // multi-backend live pack be benchmarked against a single-product
  // reference without the noise of every other backend.
  const lensWrap = document.createElement('div');
  lensWrap.className = 'compare-lens-wrap';
  const lensLabel = document.createElement('span');
  lensLabel.className = 'compare-lens-label';
  lensLabel.textContent = 'Lens';
  lensWrap.appendChild(lensLabel);
  const lensSel = document.createElement('select');
  lensSel.className = 'compare-lens-select';
  lensSel.title = "Scope to one product's surface — for benchmarking against a reference pack.";
  const optAll = document.createElement('option');
  optAll.value = 'all'; optAll.textContent = 'All artefacts';
  lensSel.appendChild(optAll);
  for (const lp of LENS_PRODUCTS) {
    const o = document.createElement('option');
    o.value = lp.slug;
    o.textContent = lp.label;
    lensSel.appendChild(o);
  }
  lensSel.value = state.compareLens || 'all';
  lensSel.dataset.lens = lensSel.value;
  lensSel.onchange = () => {
    state.compareLens = lensSel.value;
    lensSel.dataset.lens = lensSel.value;
    appHost.renderMainView();
  };
  lensWrap.appendChild(lensSel);
  wrap.appendChild(lensWrap);
  wrap.appendChild(renderLiveScopeControl());

  const search = document.createElement('input');
  search.type = 'search';
  search.className = 'compare-search-input';
  search.placeholder = 'search id or title…';
  search.value = state.compareSearch || '';
  // Use input event for live filter; debounce via requestAnimationFrame.
  let pending = null;
  search.addEventListener('input', () => {
    if (pending) cancelAnimationFrame(pending);
    pending = requestAnimationFrame(() => {
      state.compareSearch = search.value;
      appHost.renderMainView();
      // After re-render, restore focus + cursor (renderMainView wipes the DOM).
      const fresh = document.querySelector('.compare-search-input');
      if (fresh) { fresh.focus(); fresh.setSelectionRange(search.value.length, search.value.length); }
    });
  });
  wrap.appendChild(search);
  return wrap;
}

export function renderLiveScopeControl({ standalone = false } = {}) {
  const modes = [
    {
      id: 'service',
      label: 'Service scope',
      hint: 'Multitenant mode: live-only artefacts outside Pack A service are out of scope.',
    },
    {
      id: 'family',
      label: 'Family only',
      hint: 'Single-tenant mode: all live-only artefacts in families Pack A declares are counted.',
    },
    {
      id: 'all',
      label: 'All live',
      hint: 'Strict inventory mode: every unmatched live artefact is counted.',
    },
  ];
  const active = activeDiffScopeMode();
  const wrap = document.createElement('div');
  wrap.className = 'compare-scope-wrap' + (standalone ? ' compare-scope-standalone' : '');
  const label = document.createElement('span');
  label.className = 'compare-scope-label';
  label.textContent = 'Live scope';
  wrap.appendChild(label);
  const sel = document.createElement('select');
  sel.className = 'compare-scope-select';
  sel.title = 'Choose how live-only artefacts are classified.';
  for (const mode of modes) {
    const opt = document.createElement('option');
    opt.value = mode.id;
    opt.textContent = mode.label;
    opt.title = mode.hint;
    sel.appendChild(opt);
  }
  sel.value = active;
  sel.dataset.scopeMode = active;
  sel.onchange = () => {
    const next = normalizeDiffScopeMode(sel.value);
    if (activeDiffScopeMode() === next) return;
    state.diffScopeMode = next;
    state.diff = null;
    sel.dataset.scopeMode = next;
    refreshDiff();
  };
  wrap.appendChild(sel);
  const meta = state.diff?.scope;
  if (standalone && meta?.mode) {
    const note = document.createElement('span');
    note.className = 'compare-scope-note';
    const tokenCount = Array.isArray(meta.serviceTokens) ? meta.serviceTokens.length : 0;
    const prefixCount = Array.isArray(meta.metricPrefixes) ? meta.metricPrefixes.length : 0;
    const service = meta.service ? `${meta.service} · ` : '';
    note.textContent = `${service}${meta.mode} · ${tokenCount} service token${tokenCount === 1 ? '' : 's'} · ${prefixCount} metric prefix${prefixCount === 1 ? '' : 'es'}`;
    wrap.appendChild(note);
  }
  return wrap;
}

// Per-layer ROW: layer head spans both columns, then two aligned grids.
function renderCompareLayerRow(L, sets) {
  const aItems = layerItemsFor(state.pack, L);
  const bItems = layerItemsFor(state.packB, L);
  if (aItems.length === 0 && bItems.length === 0) return null;

  const layerNames = {L1:'Contract',L2:'Telemetry',L2X:'Extended',L3:'Insight',L4:'Action',L5:'Validation',GOV:'Governance'};
  const row = document.createElement('section');
  row.className = 'compare-layer-row';
  row.dataset.layer = L;
  // Counts after slice + search filtering.
  const filteredA = filterCompareItems(aItems, L, 'a', sets);
  const filteredB = filterCompareItems(bItems, L, 'b', sets);
  if (filteredA.length === 0 && filteredB.length === 0) return null;

  const head = document.createElement('div');
  head.className = 'compare-layer-head';
  // "36 vs 6" said in words: how many artefacts each side holds in this
  // layer after the current filter, lens and search — not a defect count.
  const roles = sets.roles || compareRoles('gap');
  const countTip = `${filteredA.length} artefact${filteredA.length === 1 ? '' : 's'} in the ${roles.aNoun} (Pack A) and ${filteredB.length} in the ${roles.bNoun} (Pack B) in this layer, after the current filter, lens and search.`;
  head.innerHTML = `
    <span class="section-num">${L}</span>
    <span class="section-name" title="${escapeHtml(diagUx.layerTitle(L))}">${escapeHtml(layerNames[L] || L)}</span>
    <span class="section-count" title="${escapeHtml(countTip)}">
      <span class="cli-pill cli-a">${filteredA.length}</span>
      <span class="cli-side">in ${escapeHtml(roles.aNoun)}</span>
      <span class="cli-vs">vs</span>
      <span class="cli-pill cli-b">${filteredB.length}</span>
      <span class="cli-side">in ${escapeHtml(roles.bNoun)}</span>
    </span>
  `;
  row.appendChild(head);

  const grid = document.createElement('div');
  grid.className = 'compare-layer-grid';
  grid.appendChild(renderCompareLayerColumn('a', L, filteredA, sets));
  grid.appendChild(renderCompareLayerColumn('b', L, filteredB, sets));
  row.appendChild(grid);
  return row;
}

// layerItemsFor moved to studio/diagnostic-grade.mjs (pure, CLI-shared);
// re-exported here so compile-view's existing import keeps working.
export { layerItemsFor } from './diagnostic-grade.mjs';

// Product-surface lens — answers "does this artefact belong to <product>'s
// surface?" Used by the Compare view's lens dropdown and by the
// Benchmark view to scope a comparison to one product (e.g. just Grafana).
//
// An artefact is in <product>'s surface if ANY of these hold:
//
//   1. STRUCTURAL — the artefact IS a backend whose `product` slug matches,
//      or IS a dashboard whose `provider.kind` matches.
//   2. REFERENTIAL — the artefact `refs` a backend that's in the surface
//      (e.g. an SLI that queries metrics from `dashboards-grafana`).
//   3. SOURCE — the pack carries an `mcp.source.<artefact-id>` annotation
//      whose value starts with `<product>_` (Phase 2 fetcher stamp).
//   4. REFERENCE-PACK SHORTCUT — when the pack's metadata.name matches
//      `<product>-reference`, every artefact in it is in scope by design.
//
// Returns true/false. Falls through to true when the lens is 'all'
// or when no product is specified.
export function productSurface(art, product, pack) {
  if (!product || product === 'all') return true;
  if (!art) return false;
  const p = product.toLowerCase();
  const idLower = typeof art.id === 'string' ? art.id.toLowerCase() : '';

  // 0. Cross-cutting infrastructure (OTel SDK, pipelines, storage,
  //    governance imports) is NEVER in a single product's surface unless
  //    it explicitly refs a backend in the surface (handled in rule 4).
  //    These artefacts have ids like OTEL-01, PIP-RCV-01, PIP-PRC-01,
  //    PIP-EXP-MET, STO-MET-01, IMP-01.
  const isInfra = /^(otel|pip|sto|imp)[-_]/i.test(art.id || '');

  if (!isInfra) {
    // 1. Structural — backend with matching product slug
    if (art.spec?.product === p) return true;
    if (art.product === p) return true;

    // 1b. Structural — dashboard whose provider.kind matches
    if (art.spec?.provider?.kind === p) return true;
    if (art.provider?.kind === p) return true;

    // 1c. Backend id pattern — `<signal>-<product>` (e.g. dashboards-grafana,
    //     metrics-victoriametrics). The fetcher mints ids in this shape.
    if (idLower.endsWith(`-${p}`) || idLower === p) return true;

    // 2. Backend artefact for a DIFFERENT product — exclude.
    //    Reference packs declare monitoring backends (e.g. grafana-reference
    //    pulls in metrics-prom + metrics-mimir to monitor Grafana). Those
    //    are instrumentation, not Grafana — the Grafana lens shouldn't
    //    surface them. This rule lives BEFORE the reference-pack shortcut
    //    so the shortcut can't override it.
    const otherBackendProduct = (art.spec?.product || art.product || '').toLowerCase();
    if (otherBackendProduct && otherBackendProduct !== p) return false;
    // Same logic for dashboards: a non-matching provider.kind is excluded.
    const otherDashKind = (art.spec?.provider?.kind || art.provider?.kind || '').toLowerCase();
    if (otherDashKind && otherDashKind !== p) return false;

    // 3. Reference-pack shortcut — when this pack IS the product reference,
    //    the remaining artefacts (SLIs, SLOs, dashboards without a kind,
    //    alerts, chaos, governance imports) are by construction about
    //    that product. The backend exclusion above guards against
    //    instrumentation backends leaking in. Excludes infra artefacts
    //    via the isInfra branch wrapping this block.
    const packName = (pack?.meta?.name || pack?.id || '').toLowerCase();
    if (packName === `${p}-reference` || packName === `${p}`) return true;
  }

  // 4. Referential — refs a backend in the product surface.
  //    Applies to BOTH infra and non-infra artefacts: a STO-MET-01 that
  //    refs `backend: ref:metrics-victoriametrics` IS in the VM surface.
  const refs = Array.isArray(art.refs) ? art.refs : [];
  const surfaceBackendIds = collectSurfaceBackendIds(pack, p);
  for (const r of refs) {
    if (typeof r !== 'string') continue;
    const last = r.split('.').pop().replace(/^ref:/, '').toLowerCase();
    if (surfaceBackendIds.has(last)) return true;
  }

  // 5. Source — annotation says the artefact came from a <product>_* tool.
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const idForAnn = art.id || art.title;
  if (idForAnn) {
    const src = ann[`mcp.source.${idForAnn}`];
    if (typeof src === 'string' && src.toLowerCase().startsWith(`${p}_`)) return true;
  }

  return false;
}

// Build (and cache per-render) the set of backend ids whose `product`
// matches the lens — used by productSurface() to follow `refs` back to
// the originating backend.
const _surfaceCache = new WeakMap();
function collectSurfaceBackendIds(pack, product) {
  if (!pack || !product) return new Set();
  let perPack = _surfaceCache.get(pack);
  if (!perPack) { perPack = new Map(); _surfaceCache.set(pack, perPack); }
  if (perPack.has(product)) return perPack.get(product);
  const ids = new Set();
  const L2 = (pack.layers?.L2 || []);
  for (const b of L2) {
    const bProd = (b.spec?.product || b.product || '').toLowerCase();
    if (bProd === product && typeof b.id === 'string') {
      ids.add(b.id.toLowerCase());
      ids.add(b.id.toLowerCase().split('-').pop());  // last segment (e.g. "grafana")
    }
  }
  perPack.set(product, ids);
  return ids;
}

// Catalogue of products that have a matching reference pack. Drives the
// Lens dropdown, the per-backend "Benchmark vs <product>-reference" CTA,
// and the Advanced → References view. Keep in sync with REFERENCE_PACKS in
// server/index.mjs (each entry maps a product slug to its reference pack).
export const LENS_PRODUCTS = [
  { slug: 'grafana',    label: 'Grafana',    refPackId: 'grafana-reference' },
  { slug: 'prometheus', label: 'Prometheus', refPackId: 'prometheus-reference' },
  { slug: 'kafka',      label: 'Kafka',      refPackId: 'kafka-reference' },
];

// Apply slice + text search + lens to a side's items.
function filterCompareItems(items, L, side, sets) {
  const slice = state.compareSlice || 'all';
  const search = (state.compareSearch || '').trim().toLowerCase();
  const lens = state.compareLens || 'all';
  const sidePack = side === 'a' ? state.pack : state.packB;
  return items.filter(art => {
    if (lens !== 'all' && !productSurface(art, lens, sidePack)) return false;
    const status = compareStatusFor(side, L, art, sets);
    const inBoth = status === 'both';
    const onlySide = status === 'only';
    let sliceOk = true;
    switch (slice) {
      case 'onlyA': sliceOk = side === 'a' && onlySide; break;
      case 'onlyB': sliceOk = side === 'b' && onlySide; break;
      case 'both':  sliceOk = inBoth; break;
      case 'a-b':   sliceOk = side === 'a' && (onlySide || !inBoth); break;   // items in A not in B
      case 'a+b':   sliceOk = true; break;                                     // union
      default:      sliceOk = true;
    }
    if (!sliceOk) return false;
    if (!search) return true;
    const hay = `${art.id || ''} ${art.title || ''}`.toLowerCase();
    return hay.includes(search);
  });
}

function renderCompareLayerColumn(side, L, items, sets) {
  const col = document.createElement('div');
  col.className = `compare-layer-col compare-layer-col-${side}`;
  if (items.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'compare-layer-empty';
    const noun = side === 'a' ? (sets.roles?.aNoun || 'Pack A') : (sets.roles?.bNoun || 'Pack B');
    empty.textContent = `Nothing in the ${noun} for this layer matches the current filter.`;
    col.appendChild(empty);
    return col;
  }
  for (const art of items) {
    const def = { id: L, num: L, name: L };
    col.appendChild(renderCompareCard(art, def, art._sub || null, side, sets));
  }
  return col;
}

// Raw symbolic key — referenced ONLY by the benchmark footprint's
// deliberately naive "reference IDs matched" scorecard, which is currently
// unwired (its callers were stripped in 59e366c; kept pending cleanup).
// Everything that claims comparison semantics goes through the server
// diff's behavioural buckets instead (see buildCompareKeySets).
function compareKeyOf(art) {
  return art?.defines || art?.id || '';
}

function renderComparePackSide(side, pack, sets) {
  const col = document.createElement('div');
  col.className = 'compare-side compare-side-' + side;

  const head = document.createElement('div');
  head.className = 'compare-side-head';
  const tier = pack?.meta?.criticality || '?';
  const env  = pack?.meta?.environment || '—';
  head.innerHTML = `
    <div class="compare-side-eyebrow">${side === 'a' ? 'PACK A' : 'PACK B'}</div>
    <div class="compare-side-name">${escapeHtml(pack?.name || '?')}</div>
    <div class="compare-side-meta">
      <span class="meta-pill" data-tier="${escapeHtml(tier)}">${escapeHtml(tier)}</span>
      <span class="meta-pill">env: ${escapeHtml(env)}</span>
      <span class="meta-pill">v${escapeHtml(pack?.meta?.version || '?')}</span>
    </div>
  `;
  col.appendChild(head);

  // Render each layer as a stacked section.
  for (const L of LAYERS_FOR_DIFF) {
    if (L === 'L4') {
      const L4 = pack?.layers?.L4 || { policy: [], alerting: [], healing: [] };
      const total = (L4.policy?.length || 0) + (L4.alerting?.length || 0) + (L4.healing?.length || 0);
      if (total === 0) continue;
      const sec = renderCompareSideLayer({ id: 'L4', num: 'L4', name: 'Action' }, [], side, sets, true);
      col.appendChild(sec);
      // Sub-groups
      const grid = sec.querySelector('.compare-side-grid');
      for (const sg of L4_SUBGROUPS) {
        const items = L4[sg.key] || [];
        if (!items.length) continue;
        const h = document.createElement('div');
        h.className = 'compare-side-subhead';
        h.textContent = `L4.${sg.key} · ${sg.label}`;
        grid.appendChild(h);
        for (const a of items) grid.appendChild(renderCompareCard(a, { id: 'L4' }, sg.key, side, sets));
      }
      continue;
    }
    const items = pack?.layers?.[L] || [];
    if (!items.length) continue;
    const def = { id: L, num: L, name: ({L1:'Contract',L2:'Telemetry',L2X:'Extended',L3:'Insight',L5:'Validation',GOV:'Governance'})[L] || L };
    const sec = renderCompareSideLayer(def, items, side, sets, false);
    col.appendChild(sec);
  }

  return col;
}

function renderCompareSideLayer(def, items, side, sets, isL4) {
  const sec = document.createElement('section');
  sec.className = 'compare-side-layer section';
  sec.dataset.layer = def.id;
  const head = document.createElement('div');
  head.className = 'compare-side-layer-head';
  head.innerHTML = `
    <span class="section-num">${def.num}</span>
    <span class="section-name">${escapeHtml(def.name)}</span>
    <span class="section-count">${isL4 ? '' : items.length}</span>
  `;
  sec.appendChild(head);
  const grid = document.createElement('div');
  grid.className = 'compare-side-grid';
  if (!isL4) for (const a of items) grid.appendChild(renderCompareCard(a, def, null, side, sets));
  sec.appendChild(grid);
  return sec;
}

function renderCompareCard(artefact, def, sublayerKey, side, sets) {
  const status = compareStatusFor(side, def.id, artefact, sets);
  const inBoth = status === 'both';
  const isOnlySide = status === 'only';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'card compare-side-card';
  if (inBoth) btn.classList.add('is-both');
  if (isOnlySide) btn.classList.add('is-only', `is-only-${side}`);
  const ckey = cardKey(def.id, sublayerKey, artefact.id);
  btn.dataset.key = ckey;
  if ((side === 'a' && ckey === state.activeCardKeyA) ||
      (side === 'b' && ckey === state.activeCardKeyB)) {
    btn.classList.add('is-active');
  }

  // Comparison status pill — what this card means in the diff.
  let statusPill = '';
  const noun = side === 'a' ? sets?.roles?.aNoun : sets?.roles?.bNoun;
  if (inBoth) statusPill = '<span class="diff-chip chip-both" title="In both packs, matched by behaviour">shared</span>';
  else if (isOnlySide) statusPill = `<span class="diff-chip chip-only-${side}" title="Pack ${side.toUpperCase()} only">only in ${escapeHtml(noun || side.toUpperCase())}</span>`;

  // Source pill — Declared/Verified/Missing (what the studio's
  // per-artefact taxonomy already says about this card's status in
  // its own pack, independent of the comparison).
  const src = artefact.source || 'Declared';
  const sourcePill = `<span class="source-chip" data-source="${escapeHtml(src)}">${escapeHtml(src)}</span>`;

  // Gating chip for backend cards
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  btn.innerHTML = `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${statusPill}
      ${gatingChip}
    </div>
    <div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot card-foot-compare">
      ${sourcePill}
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
    </div>
  `;
  btn.onclick = () => openDrawer(artefact, def, sublayerKey, side);
  return btn;
}

function renderCompareHead() {
  const a = state.diff?.a;
  const b = state.diff?.b;
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">CMP</span>
    <span class="section-name">${escapeHtml(a?.name || '?')} <em>vs</em> ${escapeHtml(b?.name || '?')}</span>
    <span class="section-count">${state.diff ? `union ${state.diff.summary.union}` : '—'}</span>
  `;
  return head;
}

export function renderComparePicker() {
  const wrap = document.createElement('div');
  wrap.className = 'compare-picker';
  wrap.innerHTML = `
    <label class="ctrl">
      <span class="ctrl-key">PACK B</span>
      <select id="compare-b-pack"></select>
    </label>
    <label class="ctrl">
      <span class="ctrl-key">ENV B</span>
      <select id="compare-b-env"></select>
    </label>
    <button class="ctrl-btn" id="compare-swap" type="button" title="Swap A and B">⇄ swap</button>
  `;

  const bSel = wrap.querySelector('#compare-b-pack');
  for (const p of state.catalog) {
    if (!p.ok) continue;
    const opt = document.createElement('option');
    opt.value = p.id;
    opt.textContent = `${p.label} · v${p.version || '?'}`;
    bSel.appendChild(opt);
  }
  bSel.value = state.compareBId;
  bSel.onchange = () => {
    state.compareBId = bSel.value;
    state.compareBEnv = defaultEnvFor(bSel.value);
    state.diff = null;
    refreshDiff();
  };

  const envSel = wrap.querySelector('#compare-b-env');
  const envs = state.catalog.find(p => p.id === state.compareBId)?.environments || [];
  if (!envs.length) {
    const opt = document.createElement('option');
    opt.value = ''; opt.textContent = '— none —'; envSel.appendChild(opt);
    envSel.disabled = true;
  } else {
    for (const e of envs) {
      const opt = document.createElement('option');
      opt.value = e; opt.textContent = e; envSel.appendChild(opt);
    }
    envSel.value = state.compareBEnv || envs[0];
    envSel.onchange = () => { state.compareBEnv = envSel.value || null; state.diff = null; refreshDiff(); };
  }

  wrap.querySelector('#compare-swap').onclick = () => {
    if (!state.compareBId) return;
    const aId = state.selectedPackId;
    const aEnv = state.selectedEnv;
    state.selectedPackId = state.compareBId;
    state.selectedEnv = state.compareBEnv;
    state.compareBId = aId;
    state.compareBEnv = aEnv;
    state.diff = null;
    // Reload everything for the now-A pack.
    refresh();
    refreshDiff();
  };

  return wrap;
}

// The set arithmetic (All differences). Counts come from the same lensed
// digest as the summary so every number on the screen agrees; the sides
// are named, A/B stays in the tooltips, and the Jaccard similarity is shown
// as "overlap" with its formal definition on hover.
function renderCompareSummary(digest, ctx) {
  const t = digest?.totals || { onlyInA: 0, onlyInB: 0, shared: 0, universe: 0 };
  const r = ctx.roles;
  const overlap = t.universe ? Math.round((t.shared / t.universe) * 100) : 100;
  const wrap = document.createElement('div');
  wrap.className = 'compare-summary';
  wrap.innerHTML = `
    <div class="compare-cell c-a" title="Pack A only"><div class="c-key">${escapeHtml(r.aOnly)}</div><div class="c-val">${t.onlyInA}</div></div>
    <div class="compare-cell c-both" title="In both A and B, matched by behaviour"><div class="c-key">shared</div><div class="c-val">${t.shared}</div></div>
    <div class="compare-cell c-b" title="Pack B only"><div class="c-key">${escapeHtml(r.bOnly)}</div><div class="c-val">${t.onlyInB}</div></div>
    <div class="compare-cell c-union" title="Union: A + B without duplicates"><div class="c-key">in either</div><div class="c-val">${t.universe}</div></div>
    <div class="compare-cell c-jacc"><div class="c-key">${diagUx.termHtml('jaccard', 'overlap')}</div><div class="c-val">${overlap}%</div></div>
  `;
  return wrap;
}

// (The 3-column "only-in-A / both / only-in-B" layer renderer was
// replaced by the side-by-side renderComparePackSide above. The diff
// summary cells at the top of the view still surface the set arithmetic.)
function renderCompareLayer_DEPRECATED(def, bucket) {
  const section = document.createElement('section');
  section.className = 'compare-layer';
  section.dataset.layer = def.id;
  section.innerHTML = `
    <div class="compare-layer-head">
      <span class="section-num">${def.id}</span>
      <span class="section-name">${def.name}</span>
      <span class="section-count">${bucket.onlyInA.length} / ${bucket.inBoth.length} / ${bucket.onlyInB.length}</span>
    </div>
  `;
  const grid = document.createElement('div');
  grid.className = 'compare-grid';

  grid.appendChild(renderCompareColumn('only in A', 'c-a',    bucket.onlyInA.map(x => x.artefact), def));
  grid.appendChild(renderCompareColumn('in both',   'c-both', bucket.inBoth.map(x => x.a), def, bucket.inBoth));
  grid.appendChild(renderCompareColumn('only in B', 'c-b',    bucket.onlyInB.map(x => x.artefact), def));

  section.appendChild(grid);
  return section;
}

function renderCompareColumn(label, cls, items, def, inBothPairs = null) {
  const col = document.createElement('div');
  col.className = 'compare-col ' + cls;
  col.innerHTML = `<div class="compare-col-head">${label} <span class="muted">${items.length}</span></div>`;
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'compare-empty';
    empty.textContent = '—';
    col.appendChild(empty);
    return col;
  }
  for (let i = 0; i < items.length; i++) {
    const artefact = items[i];
    const row = document.createElement('button');
    row.type = 'button';
    row.className = 'compare-row';
    const bPair = inBothPairs ? inBothPairs[i].b : null;
    const annotation = bPair && bPair.source && bPair.source !== artefact.source
      ? ` <span class="compare-tag">${escapeHtml(artefact.source)}/${escapeHtml(bPair.source)}</span>`
      : '';
    row.innerHTML = `
      <span class="compare-row-id">${escapeHtml(artefact.id || '')}</span>
      <span class="compare-row-title">${escapeHtml(artefact.title || '')}</span>${annotation}
    `;
    row.onclick = () => openDrawer(artefact, def, null);
    col.appendChild(row);
  }
  return col;
}

// ============================================================
// DIAGNOSE — the screen grammar (2026-09 UX review,
// docs/UX_SCREEN_GRAMMAR.md). Assessment and Compare both lead with
// context (both packs named) · one decision sentence · one next action ·
// the causes and measures behind it, then the detail. The decision
// builders below are pure over explicit inputs (no state reads) so they
// run headlessly; the renderers around them own the state reads.
// ============================================================

// Which side is which, in words. The compare mode decides the frame: in
// DRIFT mode (Pack B is live) A is the declared repository pack; in GAP
// mode B is the selected baseline and A is the pack being assessed — "the
// live pack" when it carries live-draft provenance. A/B survive only in
// tooltips and the expert set filters.
export function compareRoles(mode, aLive = false) {
  if (mode === 'drift') {
    return {
      mode, aNoun: 'declared pack', bNoun: 'live pack',
      aKey: 'Declared', bKey: 'Live',
      aOnly: 'Only in declared pack', bOnly: 'Only in live pack',
      aDelta: 'Declared, not live', bDelta: 'Live, not declared',
      qualitySide: 'a',
      title: 'Declared pack compared with live',
    };
  }
  // Nouns read after "the": "the live pack", "the current pack".
  const aNoun = aLive ? 'live pack' : 'current pack';
  return {
    mode, aNoun, bNoun: 'selected baseline',
    aKey: aLive ? 'Live pack' : 'Current pack', bKey: 'Baseline',
    aOnly: `Only in ${aNoun}`, bOnly: 'Only in baseline',
    aDelta: `Additional in ${aNoun}`, bDelta: 'Missing vs baseline',
    qualitySide: 'b',
    title: `${aLive ? 'Live pack' : 'Current pack'} compared with selected baseline`,
  };
}

// A live draft carries MCP provenance (mcp.url); older live packs are only
// recognisable by their id. The artefact-source fallback inferPackSource
// uses is deliberately NOT consulted — a verified repository pack is not
// "the live pack".
function isLivePack(pack, id) {
  if (!pack) return false;
  if (partialLiveEvidence(pack).isLiveDraft) return true;
  return /(^|[-_])(live|deployed|runtime)([-_]|$)/i.test(String(id || pack.id || ''));
}

// The pack whose probe record describes the live vantage: Pack B in drift
// mode, Pack A when A is the live draft (gap mode), otherwise Pack B.
function liveSidePack(mode) {
  if (mode !== 'drift' && isLivePack(state.pack, state.selectedPackId)) return state.pack;
  return state.packB;
}

// "Production curated v0.4.0 (prod)"
function packLine(p) {
  if (!p) return '';
  const v = p.version ? ` v${String(p.version).replace(/^v/i, '')}` : '';
  return `${p.name}${v}${p.env ? ` (${p.env})` : ''}`;
}

// The working context both Diagnose views lead with: service, the pack
// being assessed and the baseline, each by catalog label + version + env
// (what the user PICKED), plus the roles that name each side.
function diagnoseContext() {
  const pack = state.pack;
  const packB = state.packB;
  const aEntry = catalogEntryFor(state.selectedPackId);
  const bEntry = state.compareBId ? catalogEntryFor(state.compareBId) : null;
  const mode = compareModeFor(packB, state.compareBId);
  const a = {
    name: aEntry?.label || pack?.name || pack?.meta?.name || state.selectedPackId || 'this pack',
    version: aEntry?.version || pack?.meta?.version || '',
    env: state.selectedEnv || pack?.meta?.environment || '',
  };
  const b = (packB || state.compareBId) ? {
    name: bEntry?.label || packB?.name || packB?.meta?.name || String(state.compareBId || 'baseline'),
    version: bEntry?.version || packB?.meta?.version || '',
    env: state.compareBEnv || packB?.meta?.environment || '',
  } : null;
  return {
    service: state.selectedService || pack?.meta?.service || '',
    mode, a, b,
    roles: compareRoles(mode, isLivePack(pack, state.selectedPackId)),
  };
}

const capitalize = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
// "Diagnostic / Clinical Grade" → "Diagnostic / clinical grade"
const sentenceCase = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1).toLowerCase() : s);
const GRADE_TONE = { a: 'ok', b: 'warn', c: 'warn', d: 'fail', ref: 'info' };

// Plain-language copy for each scored check: what failed → why it matters
// → what to do. The engine's own `detail` string rides along as the
// observed evidence; nothing here re-scores.
const CRITERION_COPY = {
  'multi-modal': {
    title: 'Not every signal type is declared',
    why: 'Metrics, logs and traces together let you detect an incident and explain it; with fewer you can see that something is wrong, not why.',
    fix: 'Declare backends for the missing signal types in L2 Telemetry.',
  },
  correlated: {
    title: 'Signals cannot be joined',
    why: 'Without trace context the logs and traces of one request cannot be linked, so finding the cause takes longer.',
    fix: 'Declare the tracecontext propagator (and log correlation) in the OpenTelemetry SDK settings.',
  },
  calibrated: {
    title: 'Normal is not defined with numbers',
    why: 'Without numeric SLO objectives and MTTD/MTTR baselines nobody can tell whether a reading is bad.',
    fix: 'Give each SLO a numeric objective and declare MTTD/MTTR baselines in L5 Validation.',
  },
  comprehensive: {
    title: 'Whole layers are unobserved',
    why: 'Fewer than half of the expected mechanisms are observed across infrastructure, platform, application and user experience, so failures there go unseen.',
    fix: 'Start with the darkest layers in Layer scores.',
  },
  'chaos-validated': {
    title: 'Recovery has never been tested',
    why: 'No chaos experiment shows that alerts fire and recovery works under a real fault; the response path is theoretical.',
    fix: 'Declare at least one chaos experiment in L5 Validation.',
  },
  'drift-free': {
    title: 'The declaration does not match live',
    why: 'When the pack says one thing and production runs another, dashboards and alerts may be watching the wrong thing.',
    fix: 'Review the differences, then deploy what is missing live or update the repository from live.',
  },
  fresh: {
    title: 'The live check is out of date',
    why: 'Production may have changed since the last verification; readings older than 24 hours are not trusted.',
    fix: 'Refresh the live draft: scan live or fetch again from MCP.',
  },
};
// Tie-break for checks that lose the same points: evidence first (a stale
// or mismatched live read undermines every other reading), then coverage.
const CRITERION_PRIORITY = ['drift-free', 'fresh', 'multi-modal', 'correlated', 'calibrated', 'comprehensive', 'chaos-validated'];

function criterionBlocker(c, lost, { hasLive, haveB, digest, roles, pointsPerCheck }) {
  const copy = CRITERION_COPY[c.key] || { title: `${c.label} is not met`, why: c.sub || '', fix: '' };
  const b = {
    key: c.key, scored: true,
    title: copy.title, observed: c.detail || '', why: copy.why, fix: copy.fix,
    tone: lost >= 1 ? 'fail' : 'warn',
    cost: lost >= 1
      ? `Costs ${Math.round(lost * pointsPerCheck)} points of the score`
      : `Partial credit — costs ${Math.round(lost * pointsPerCheck)} points of the score`,
    actionLabel: 'View the check', actionId: `diag-crit:${c.key}`,
    evidenceId: `diag-crit:${c.key}`,
  };
  if (c.key === 'drift-free') {
    if (!hasLive) {
      b.title = 'Nothing live has been checked';
      b.why = 'Every claim rests on what the pack declares; nothing confirms the signals exist in production.';
      b.fix = 'Connect MCP or scan live, then choose the live draft as the baseline (Pack B) to compare.';
      b.actionLabel = haveB ? 'Review the comparison' : 'How to compare with live';
      b.actionId = 'diag-goto:diag-compare';
    } else if (haveB) {
      b.actionLabel = 'Review differences';
      b.actionId = 'diag-goto:diag-compare';
      if (digest && roles.mode === 'drift') {
        const t = digest.totals;
        b.observed += ` — ${t.onlyInA} declared, not live · ${t.drifted} changed`;
      }
    } else {
      b.fix = 'Choose the live draft as the baseline (Pack B) to see which artefacts differ.';
    }
  } else if (c.key === 'fresh') {
    if (/never been verified|no mcp\.refreshedAt/i.test(c.detail || '')) b.title = 'Never verified against live';
    else if (/vantage lost/i.test(c.detail || '')) {
      b.title = 'The last live check saw nothing';
      b.why = 'A live refresh ran but no probe family answered, so it is not a fresh look at production.';
    }
  } else if (c.key === 'comprehensive') {
    b.actionLabel = 'View layer scores';
    b.actionId = 'diag-goto:diag-layers';
  }
  return b;
}

// THE Assessment decision, derived from the diagnostic (and, with a
// baseline, the same lensed digest the drill renders). Pure: every input
// explicit. Returns the one sentence, its tone, the inline explanation of
// apparent contradictions, the next action, and the blockers in priority
// order (what failed → why it matters → fix), the top three of which are
// the header's causes.
export function buildAssessmentDecision({ diagnostic, digest = null, roles = compareRoles('gap'), liveEvidence = null, haveB = false, baselineName = '' } = {}) {
  const overall = diagnostic.overall;
  const audit = overall.audit || diagnosticAuditStatus(overall.passed, overall.total);
  const ig = overall.instrumentGrade || instrumentGradeFor(audit.scorePctExact);
  const passes = !!audit.passes;
  const hasLive = !!diagnostic.trust?.hasMcpSource;
  const vantage = liveEvidence?.vantage || 'none';
  const scorePct = Math.round(audit.scorePctExact);
  const gradeName = sentenceCase(ig.label);
  const pointsPerCheck = overall.total ? 100 / overall.total : 0;

  const blockers = [];
  // 0. An evidence caution (not scored) leads: it changes how every other
  //    reading — above all the comparison — should be read.
  if (liveEvidence && (liveEvidence.partial || vantage === 'lost')) {
    const silent = [...(liveEvidence.failed || []), ...(liveEvidence.unsupported || [])];
    blockers.push({
      key: 'live-evidence', scored: false, tone: 'warn',
      title: vantage === 'lost' ? 'The live check could not observe anything' : 'Live evidence is partial',
      observed: vantage === 'lost'
        ? `no probe family answered${silent.length ? ` (${silent.join(', ')})` : ''}`
        : `${liveEvidence.failed.length} of ${liveEvidence.attempted.length} live probes failed (${liveEvidence.failed.join(', ')})`,
      why: 'Surfaces the live draft could not see look like drift, so differences may be overstated.',
      fix: 'Draft the live pack again from MCP once the endpoint is healthy, then re-check.',
      cost: 'Does not change the grade by itself',
      actionLabel: haveB ? 'View the comparison' : 'View the evidence',
      actionId: haveB ? 'diag-goto:diag-compare' : 'diag-goto:diag-evidence',
    });
  }
  // 1. Scored checks that fail, most points lost first.
  const prio = (k) => { const i = CRITERION_PRIORITY.indexOf(k); return i < 0 ? 99 : i; };
  const scored = [...(diagnostic.coverage?.criteria || []), ...(diagnostic.trust?.criteria || [])];
  const failing = scored
    .filter(c => !c.pass)
    .map(c => ({ c, lost: 1 - criterionScore(c) }))
    .sort((x, y) => (y.lost - x.lost) || (prio(x.c.key) - prio(y.c.key)));
  // With nothing live at all, "drift-free" and "fresh" fail for the SAME
  // reason and have the same fix: one gap, both checks' points.
  const noLiveFresh = !hasLive && failing.some(f => f.c.key === 'drift-free') ? failing.find(f => f.c.key === 'fresh') : null;
  for (const { c, lost } of failing) {
    if (noLiveFresh && c.key === 'fresh') continue;
    const b = criterionBlocker(c, lost, { hasLive, haveB, digest, roles, pointsPerCheck });
    if (noLiveFresh && c.key === 'drift-free') {
      const both = lost + noLiveFresh.lost;
      b.observed = `${c.detail || ''} · ${noLiveFresh.c.detail || ''}`.replace(/^ · | · $/g, '');
      b.cost = `Costs ${Math.round(both * pointsPerCheck)} points of the score (two checks: drift-free and fresh)`;
      b.tone = 'fail';
    }
    blockers.push(b);
  }
  // 2. Quality gaps against the selected baseline. In drift mode they are
  //    what the scored "drift-free" check measures (listed there); in gap
  //    mode the grade reads the pack itself, so they are listed on their
  //    own — required by the baseline, not by the grade.
  let qualityGaps = 0;
  if (digest) {
    const t = digest.totals;
    const missing = roles.qualitySide === 'a' ? t.onlyInA : t.onlyInB;
    qualityGaps = missing + t.drifted;
    if (roles.mode !== 'drift') {
      const bn = baselineName || 'the baseline';
      if (missing > 0) blockers.push({
        key: 'baseline-missing', scored: false, tone: 'fail',
        title: `${missing} ${missing === 1 ? 'artefact' : 'artefacts'} from the baseline ${missing === 1 ? 'is' : 'are'} missing`,
        observed: `${bn} declares ${missing === 1 ? 'it' : 'them'}; the ${roles.aNoun} has no counterpart`,
        why: 'The selected baseline expects these; without them the pack observes less than the baseline promises.',
        fix: 'Review them, then adopt them from the baseline or author them.',
        cost: 'Required by the baseline; does not change the grade',
        actionLabel: 'Review differences', actionId: 'diag-goto:diag-compare',
      });
      if (t.drifted > 0) blockers.push({
        key: 'baseline-drifted', scored: false, tone: 'warn',
        title: `${t.drifted} shared ${t.drifted === 1 ? 'artefact differs' : 'artefacts differ'} from the baseline`,
        observed: 'same control, different field values',
        why: 'Thresholds, queries or windows that differ from the baseline may not detect what the baseline expects.',
        fix: 'Compare the changed fields side by side and decide which side is right.',
        cost: 'Required by the baseline; does not change the grade',
        actionLabel: 'See the changed fields', actionId: 'diag-compare-tab:review',
      });
    }
  }
  const gapCount = blockers.filter(b => b.key !== 'live-evidence').length;

  // The one sentence. Plain words first; the formal "diagnostic grade"
  // stays in the details ("How the grade is calculated").
  const sentence = passes
    ? `${gradeName}: the pack meets the audit requirement${hasLive ? ' and live evidence backs it' : ''}.`
    : hasLive
      ? `${gradeName}: live telemetry exists, but the pack does not meet the audit requirement.`
      : `${gradeName}: the pack does not meet the audit requirement, and nothing live has been checked.`;

  // Explain apparent contradictions inline, then the distance to the bar.
  const notes = [];
  if (vantage === 'lost') notes.push('A live check ran but could not observe anything, so live results are unknown rather than failed.');
  else if (!passes && hasLive) notes.push('Live signals detected; required evidence is still incomplete.');
  else if (!hasLive) notes.push('No live evidence has been checked; every result rests on what the pack declares.');
  if (vantage === 'partial') notes.push('Some live probes failed, so live evidence is partial and differences may be overstated.');
  notes.push(passes
    ? `Grade A begins above ${audit.threshold}%; this pack scores ${scorePct}%.`
    : `Grade A begins above ${audit.threshold}%; this pack scores ${scorePct}%, ${(audit.threshold - audit.scorePctExact).toFixed(1)} points below.`);

  const primary = gapCount > 0
    ? { label: `Review ${gapCount} required ${gapCount === 1 ? 'gap' : 'gaps'}`, action: 'diag-goto:diag-gaps' }
    : blockers.length
      ? { label: 'Review the live evidence', action: 'diag-goto:diag-gaps' }
      : { label: 'Review the evidence', action: 'diag-goto:diag-evidence' };
  const secondary = [];
  if (haveB) secondary.push({ label: roles.mode === 'drift' ? 'Compare with live' : 'Compare with baseline', action: 'diag-compare-tab' });
  if (haveB && qualityGaps > 0) secondary.push({ label: 'Resolve gaps in Remediate', action: 'diag-remediate' });

  return {
    tone: passes ? 'ok' : (ig.tier === 'd' ? 'fail' : 'warn'),
    verdict: ig.letter,
    verdictTitle: `${ig.letter} · ${ig.label} — ${ig.blurb || ''}`,
    sentence,
    note: notes.join(' '),
    primary, secondary,
    causes: blockers.slice(0, 3).map(b => ({ title: b.title, why: b.why, actionLabel: b.actionLabel, actionId: b.actionId, tone: b.tone })),
    blockers, gapCount, qualityGaps,
    passes, hasLive, vantage, ig, audit, scorePct, gradeName,
  };
}

function renderAssessmentHeaderHtml(d, ctx) {
  const context = [
    ctx.service ? { key: 'Service', value: ctx.service } : null,
    { key: ctx.roles.aKey, value: packLine(ctx.a), title: 'Pack A — the pack being assessed' },
    ctx.b
      ? { key: ctx.roles.bKey, value: packLine(ctx.b), title: `Pack B — the ${ctx.roles.bNoun} it is compared with` }
      : { key: 'Baseline', value: 'none selected', title: 'Choose a Pack B in the header to compare with live or a baseline' },
  ];
  return diagUx.decisionHeaderHtml({
    id: 'diag-summary', eyebrow: 'Assessment', context,
    tone: d.tone, verdict: d.verdict, verdictTitle: d.verdictTitle,
    decision: d.sentence, note: d.note,
    primary: d.primary, secondary: d.secondary, causes: d.causes,
  });
}

// The measures, grouped by meaning (review §3 Diagnose): the overall
// assessment, WHY (coverage · trust · audit gate) and the EVIDENCE behind
// it (live signals, individual checks, requirement chains).
function assessmentMeasuresHtml(diagnostic, d) {
  const cov = diagnostic.coverage;
  const trust = diagnostic.trust;
  const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(1).replace(/\.0$/, '');
  const pct = (p, t) => (t ? Math.round((p / t) * 100) : 0);
  const toneFor = (p, t) => (p >= t ? 'ok' : p > 0 ? 'warn' : 'fail');
  const scored = [...cov.criteria, ...trust.criteria];
  const nPass = scored.filter(c => c.pass).length;
  const nPartial = scored.filter(c => !c.pass && criterionScore(c) > 0).length;
  const nFail = scored.length - nPass - nPartial;
  const rollup = diagnostic.traceabilityGraph?.rollup;
  const live = !d.hasLive ? { v: 'Not checked', note: 'connect MCP or scan live to verify', tone: 'warn' }
    : d.vantage === 'lost' ? { v: 'Could not observe', note: 'a live check ran, but no probe family answered', tone: 'warn' }
      : d.vantage === 'partial' ? { v: 'Partial', note: 'some live probes failed', tone: 'warn' }
        : { v: 'Detected', note: 'a live draft or live refresh backs this read', tone: 'ok' };
  const m = (labelHtml, value, note, tone, title = '') => `
        <div class="ux-measure ux-tone-${tone}"${title ? ` title="${escapeHtml(title)}"` : ''}>
          <dt>${labelHtml}</dt>
          <dd><span class="ux-measure-val">${escapeHtml(value)}</span>${note ? `<span class="ux-measure-note">${escapeHtml(note)}</span>` : ''}</dd>
        </div>`;
  const group = (title, body) => `
      <section class="diag-measure-group" aria-label="${escapeHtml(title)}">
        <h3 class="diag-measure-group-title">${escapeHtml(title)}</h3>
        <dl class="ux-measures">${body}</dl>
      </section>`;
  return `
    <div class="diag-measure-groups">
      ${group('Overall assessment',
        m('Grade', `${d.ig.letter} · ${d.gradeName}`, d.ig.blurb || '', GRADE_TONE[d.ig.tier] || 'info', 'The instrument grade: where the score lands on the diagnostic-grade scale')
        + m('Meets the target?', d.passes ? 'Yes' : 'No', `target: grade A, above ${d.audit.threshold}% · this pack ${d.scorePct}%`, d.passes ? 'ok' : 'fail'))}
      ${group('Why',
        m(diagUx.termHtml('coverage'), `${pct(cov.passed, cov.total)}%`, `${fmt(cov.passed)} of ${cov.total} checks: signal types, correlation, calibration, breadth`, toneFor(cov.passed, cov.total))
        + m(diagUx.termHtml('trust'), `${pct(trust.passed, trust.total)}%`, `${fmt(trust.passed)} of ${trust.total} checks: recovery tested, matches live, recently verified`, toneFor(trust.passed, trust.total))
        + m(diagUx.termHtml('audit-gate'), d.passes ? 'Met' : 'Not met', `passes above ${d.audit.threshold}%, where grade A begins`, d.passes ? 'ok' : 'fail'))}
      ${group('Evidence',
        m('Live signals', live.v, live.note, live.tone)
        + m('Checks passed', `${nPass} of ${scored.length}`, [nPartial ? `${nPartial} partial` : '', nFail ? `${nFail} failed` : ''].filter(Boolean).join(' · ') || 'every scored check passes', nFail ? 'fail' : nPartial ? 'warn' : 'ok')
        + (rollup?.declaredTotal
          ? m('Requirement chains', `${rollup.intact} of ${rollup.declaredTotal} intact`, `${rollup.broken} broken · ${rollup.partial} partial`, rollup.broken ? 'fail' : rollup.partial ? 'warn' : 'ok')
          : ''))}
    </div>`;
}

// "How the grade is calculated" — the ladder and the scoring rules as
// reference material, collapsed by default (review §3: useful, but not of
// equal visual weight with the result). Keeps the formal "diagnostic
// grade" vocabulary.
function assessmentCalcHtml(diagnostic, ladderHtml) {
  const overall = diagnostic.overall;
  const audit = overall.audit || diagnosticAuditStatus(overall.passed, overall.total);
  const ig = overall.instrumentGrade || instrumentGradeFor(audit.scorePctExact);
  const fmt = (n) => Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return `
    <div class="diag-calc">
      <div class="diag-calc-ladder">${ladderHtml}</div>
      <div class="diag-calc-rules">
        <p>The <strong>diagnostic grade</strong> is a verification score: the share of ${overall.total} scored checks the pack passes — ${diagnostic.coverage.total} for coverage (signal types, correlation, calibration, breadth across layers) and ${diagnostic.trust.total} for trust (recovery tested by chaos, declarations matching live, verified within 24 hours).</p>
        <p>Most checks pass or fail. “Drift-free” earns partial credit — the requirement chains’ integrity or, without chains, the weighted share of declared artefacts confirmed live (or of live probes that answered) — so it can contribute a fraction of a check.</p>
        <p>Operability (runbooks) is displayed but never scored: it measures response readiness, not diagnostic capability.</p>
        <p>The audit requirement passes above ${audit.threshold}%, exactly where grade A begins, so the letter and the machine PASS/FAIL always agree.</p>
        <p class="diag-calc-this">This pack: ${fmt(overall.passed)} of ${overall.total} checks = ${Math.round(audit.scorePctExact)}% → grade ${escapeHtml(ig.letter)} (${escapeHtml(ig.label)}); audit ${escapeHtml(audit.status)}${overall.verdict?.word ? `; formal verdict “${escapeHtml(overall.verdict.word)}”` : ''}.</p>
      </div>
    </div>`;
}

// The persistent strip: grade + both packs named, and the section index
// with an issue count per section.
function assessmentStickyHtml(d, ctx, navSections) {
  const vs = ctx.b ? ` compared with <strong>${escapeHtml(packLine(ctx.b))}</strong>` : '';
  return `
    <div class="diag-sticky">
      <p class="diag-sticky-ctx"><span class="diag-sticky-grade ux-tone-${escapeHtml(d.tone)}" title="${escapeHtml(d.verdictTitle)}">${escapeHtml(d.ig.letter)}</span> ${escapeHtml(d.gradeName)} · <strong>${escapeHtml(packLine(ctx.a))}</strong>${vs}</p>
      ${diagUx.sectionNavHtml(navSections, { label: 'Assessment sections' })}
    </div>`;
}

// Blockers in priority order: what failed → why it matters → fix / evidence.
function assessmentGapsHtml(d) {
  const items = d.blockers.map((b, i) => `
      <li class="diag-blocker ux-tone-${escapeHtml(b.tone)}">
        <div class="diag-blocker-col diag-blocker-what">
          <span class="diag-blocker-key">What failed</span>
          <span class="diag-blocker-title"><span class="diag-blocker-num">${i + 1}.</span> ${escapeHtml(b.title)}</span>
          ${b.observed ? `<span class="diag-blocker-observed">${escapeHtml(b.observed)}</span>` : ''}
          <span class="diag-blocker-cost">${escapeHtml(b.cost || '')}</span>
        </div>
        <div class="diag-blocker-col diag-blocker-why">
          <span class="diag-blocker-key">Why it matters</span>
          <p>${escapeHtml(b.why)}</p>
        </div>
        <div class="diag-blocker-col diag-blocker-fix">
          <span class="diag-blocker-key">Fix</span>
          <p>${escapeHtml(b.fix)}</p>
          <div class="diag-blocker-actions">
            ${b.actionId ? `<button type="button" class="ux-secondary-btn" data-ux-action="${escapeHtml(b.actionId)}">${escapeHtml(b.actionLabel)}</button>` : ''}
            ${b.evidenceId && b.evidenceId !== b.actionId ? `<button type="button" class="ux-link-btn" data-ux-action="${escapeHtml(b.evidenceId)}">View evidence →</button>` : ''}
          </div>
        </div>
      </li>`).join('');
  const body = d.blockers.length
    ? `<ol class="diag-blockers">${items}</ol>`
    : diagUx.emptyStateHtml({
      title: 'No gaps: every scored check passes.',
      checked: 'The seven scored checks (four for coverage, three for trust) and, with a baseline selected, the artefacts it expects.',
      tone: 'ok',
    });
  return `
    <section class="diag-block ux-section-target" id="diag-gaps" tabindex="-1" aria-labelledby="diag-gaps-title">
      <header class="diag-block-head">
        <h2 class="diag-block-title" id="diag-gaps-title">Gaps — what keeps this pack ${d.passes ? 'from a perfect score' : 'below grade A'}</h2>
        <p class="diag-block-lede">In priority order: the checks that cost the most points come first. Each gap says what failed, why it matters and what to do next.</p>
      </header>
      ${body}
    </section>`;
}

function diagBlockEl(id, title, ledeHtml = '') {
  const sec = document.createElement('section');
  sec.className = 'diag-block ux-section-target';
  sec.id = id;
  sec.tabIndex = -1;
  sec.setAttribute('aria-labelledby', `${id}-title`);
  sec.innerHTML = `
    <header class="diag-block-head">
      <h2 class="diag-block-title" id="${escapeHtml(id)}-title">${escapeHtml(title)}</h2>
      ${ledeHtml ? `<p class="diag-block-lede">${ledeHtml}</p>` : ''}
    </header>`;
  return sec;
}

// ---------- actions ----------
// Every Diagnose action is a [data-ux-action] routed through ux-kit's
// wireUxActions: "verb" or "verb:argument".
function wireDiagActions(root) {
  const handlers = {};
  for (const el of root.querySelectorAll('[data-ux-action]')) {
    const id = el.dataset.uxAction;
    if (/^(diag|cmp)-/.test(id)) handlers[id] = () => runDiagAction(id);
  }
  diagUx.wireUxActions(root, handlers);
}

function runDiagAction(id) {
  const i = id.indexOf(':');
  const verb = i < 0 ? id : id.slice(0, i);
  const arg = i < 0 ? '' : id.slice(i + 1);
  switch (verb) {
    case 'diag-goto':
      scrollToDiag(document.getElementById(arg));
      break;
    case 'diag-crit': {
      const key = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(arg) : arg;
      const row = document.querySelector(`#diag-evidence tr.diag-crit[data-key="${key}"]`);
      scrollToDiag(row || document.getElementById('diag-evidence'), { block: row ? 'center' : 'start' });
      break;
    }
    case 'diag-remediate':
      openRemediate();
      break;
    case 'diag-compare-tab':
      state.diagnoseSub = 'compare';
      if (arg) state.compareFocus = arg;
      appHost.renderMainView();
      window.scrollTo?.({ top: 0 });
      break;
    case 'cmp-focus':
      state.compareFocus = arg;
      appHost.renderMainView();
      document.querySelector(`.compare-focus [data-ux-action="cmp-focus:${arg}"]`)?.focus();
      diagUx.announce(`Showing ${({ summary: 'the comparison summary', review: 'changes needing review', all: 'all differences' })[arg] || arg}.`);
      break;
    case 'cmp-slice':
      state.compareFocus = 'all';
      state.compareSlice = arg;
      appHost.renderMainView();
      document.querySelector(`.compare-slice-pill[data-slice="${arg}"]`)?.focus();
      break;
    default:
      break;
  }
}

function scrollToDiag(el, { block = 'start' } = {}) {
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block });
  if (el.tabIndex < 0 || el.hasAttribute('tabindex')) el.focus?.({ preventScroll: true });
  el.classList.remove('diag-flash');
  void el.offsetWidth;   // restart the highlight animation
  el.classList.add('diag-flash');
  setTimeout(() => el.classList.remove('diag-flash'), 1800);
}

// Remediate is the header's "compile" tab. Clicking the real tab keeps the
// chrome's routing (active tab, mode) in one place; the direct fallback
// covers a header that is not on screen.
function openRemediate() {
  const tab = document.querySelector('.observa-tab[data-view="compile"]');
  if (tab) { tab.click(); return; }
  state.view = 'compile';
  appHost.renderTabs();
  appHost.renderMainView();
}

// ============================================================
// COMPARE — the task summary, the review list and the counts' meaning.
// ============================================================

// The Compare decision (pure): one task sentence that separates the
// STRUCTURAL difference (additional artefacts — extra coverage) from the
// QUALITY gaps (missing artefacts, changed fields), so "133 additional"
// never reads as "133 defects".
export function buildCompareDecision(digest, ctx) {
  const r = ctx.roles;
  const t = digest?.totals || { aligned: 0, drifted: 0, onlyInA: 0, onlyInB: 0, outOfScope: 0, scaffold: 0, shared: 0, universe: 0 };
  const drift = r.mode === 'drift';
  const missing = drift ? t.onlyInA : t.onlyInB;   // quality gap
  const extras = drift ? t.onlyInB : t.onlyInA;    // structural difference
  const changed = t.drifted;                       // quality gap
  const review = missing + changed;
  const are = (n) => (n === 1 ? 'is' : 'are');
  const clauses = drift
    ? [
        missing ? `${diagUx.plural(missing, 'declared artefact')} ${are(missing)} not seen live` : 'every declared artefact is seen live',
        changed ? `${diagUx.plural(changed, 'shared artefact')} ${changed === 1 ? 'differs' : 'differ'}` : 'no shared artefact differs',
        extras ? `${diagUx.plural(extras, 'live artefact')} ${are(extras)} not declared` : 'nothing live is undeclared',
      ]
    : [
        extras ? `${diagUx.plural(extras, 'additional artefact')} in the ${r.aNoun}` : `nothing additional in the ${r.aNoun}`,
        changed ? `${diagUx.plural(changed, 'shared artefact')} ${changed === 1 ? 'differs' : 'differ'}` : 'no shared artefact differs',
        missing ? `${diagUx.plural(missing, 'artefact')} from the ${r.bNoun} ${are(missing)} missing` : `none are missing from the ${r.bNoun}`,
      ];
  const notes = [];
  if (extras) notes.push(drift
    ? 'Undeclared live artefacts are structural differences: candidates to adopt into the repository, not failures.'
    : 'The additional artefacts are structural differences — extra coverage, not defects.');
  if (review) notes.push(`${review === 1 ? 'One change needs' : `${review} changes need`} review: ${diagUx.listSentence([
    missing ? (drift ? `${missing} not seen live` : `${missing} missing`) : '',
    changed ? `${changed} with changed fields` : '',
  ])}.`);
  if (!digest || t.universe === 0) notes.push('Nothing in either pack was comparable in this scope.');
  if (digest?.useLens) notes.push('Counts are scoped to the product lens.');
  return {
    sentence: `${capitalize(clauses.join('; '))}.`,
    tone: missing ? 'fail' : changed ? 'warn' : 'ok',
    note: notes.join(' '),
    primary: review
      ? { label: `Review ${diagUx.plural(review, 'change')}`, action: 'cmp-focus:review' }
      : { label: 'Show all differences', action: 'cmp-focus:all' },
    secondary: review ? [{ label: 'Resolve in Remediate', action: 'diag-remediate' }] : [],
    missing, extras, changed, review,
    diffs: t.onlyInA + t.onlyInB + t.drifted,
    totals: t,
  };
}

function renderCompareDecisionHtml(cmp, ctx) {
  const context = [
    ctx.service ? { key: 'Service', value: ctx.service } : null,
    { key: ctx.roles.aKey, value: packLine(ctx.a), title: `Pack A — the ${ctx.roles.aNoun}` },
    ctx.b ? { key: ctx.roles.bKey, value: packLine(ctx.b), title: `Pack B — the ${ctx.roles.bNoun}` } : null,
  ];
  return diagUx.decisionHeaderHtml({
    id: 'compare-decision', eyebrow: ctx.roles.title, context,
    tone: cmp.tone, decision: cmp.sentence, note: cmp.note,
    primary: cmp.primary, secondary: cmp.secondary,
  });
}

function compareFocusSwitchHtml(focus, cmp) {
  const opts = [
    { id: 'summary', label: 'Summary', title: 'The answer, and what each number means' },
    { id: 'review', label: 'Changes needing review', count: cmp.review, title: 'Quality gaps only: missing artefacts, and shared artefacts whose fields changed — side by side' },
    { id: 'all', label: 'All differences', count: cmp.diffs, title: 'Every artefact of both packs side by side, with the set filters (expert)' },
  ];
  return `
    <div class="ux-segmented compare-focus" role="group" aria-label="How much of the comparison to show">
      ${opts.map(o => `<button type="button" aria-pressed="${o.id === focus}" data-ux-action="cmp-focus:${o.id}" title="${escapeHtml(o.title)}">${escapeHtml(o.label)}${o.count != null ? `<span class="ux-seg-count">${o.count}</span>` : ''}</button>`).join('')}
    </div>`;
}

// Summary: the three sides (explicit labels, a positive explanation when a
// side is empty), quality gaps vs structural differences in separate
// panels with separate tones, and the per-layer counts with their meaning.
function compareSummaryHtml(digest, cmp, ctx) {
  const r = ctx.roles;
  const t = cmp.totals;
  const drift = r.mode === 'drift';
  const aQuality = r.qualitySide === 'a';
  const s = (n) => (n === 1 ? '' : 's');
  const tile = ({ label, name, n, tone, zeroTone = 'ok', means, zero, action, actionLabel, title }) => `
      <div class="compare-tile ux-tone-${n ? tone : zeroTone}" title="${escapeHtml(title)}">
        <div class="compare-tile-label">${escapeHtml(label)}</div>
        ${name ? `<div class="compare-tile-name">${escapeHtml(name)}</div>` : ''}
        <div class="compare-tile-n">${n}</div>
        <p class="compare-tile-means">${escapeHtml(n ? means : zero)}</p>
        ${n && action ? `<button type="button" class="ux-link-btn" data-ux-action="${escapeHtml(action)}">${escapeHtml(actionLabel)} →</button>` : ''}
      </div>`;
  const tiles = [
    tile({
      label: r.aOnly, name: packLine(ctx.a), n: t.onlyInA,
      tone: aQuality ? 'fail' : 'info',
      means: aQuality
        ? 'Quality gap: declared, but not seen live — the pack promises signals production may not have.'
        : `Structural difference: extra coverage the ${r.bNoun} does not declare. Not a defect.`,
      zero: aQuality
        ? 'Nothing missing: every declared artefact is seen live.'
        : `Nothing additional: the ${r.aNoun} holds nothing the ${r.bNoun} lacks.`,
      action: 'cmp-slice:onlyA', actionLabel: `Show ${t.onlyInA}`,
      title: 'Pack A only — in A, with no behavioural counterpart in B',
    }),
    tile({
      label: 'Shared', name: 'in both packs, matched by behaviour', n: t.shared,
      tone: t.drifted ? 'warn' : 'ok', zeroTone: 'neutral',
      means: t.drifted ? `${t.aligned} match · ${t.drifted} differ in at least one field.` : `All ${t.shared} match field for field.`,
      zero: 'No artefact appears in both packs: they describe different things.',
      action: t.drifted ? 'cmp-focus:review' : 'cmp-slice:both',
      actionLabel: t.drifted ? `Review ${diagUx.plural(t.drifted, 'change')}` : `Show ${t.shared}`,
      title: 'In both A and B, paired by behavioural identity — the same deployed control, whatever it is named',
    }),
    tile({
      label: r.bOnly, name: ctx.b ? packLine(ctx.b) : '', n: t.onlyInB,
      tone: aQuality ? 'info' : 'fail',
      means: aQuality
        ? 'Structural difference: running live but not declared — candidates to adopt into the repository.'
        : `Quality gap: the ${r.bNoun} expects these and the ${r.aNoun} does not have them.`,
      zero: aQuality
        ? 'Nothing undeclared: everything live in scope is declared.'
        : `Nothing missing: every ${r.bNoun} artefact has a counterpart in the ${r.aNoun}.`,
      action: 'cmp-slice:onlyB', actionLabel: `Show ${t.onlyInB}`,
      title: 'Pack B only — in B, with no behavioural counterpart in A',
    }),
  ].join('');

  const driftedEntries = (digest?.rows || []).flatMap(row => row.drifted);
  const decisionCount = driftedEntries.filter(e => diagDriftCost(e).className === 'decision').length;
  const cosmeticCount = driftedEntries.filter(e => diagDriftCost(e).className === 'cosmetic').length;
  const qItems = [];
  if (cmp.missing) qItems.push(`<li class="ux-tone-fail"><strong>${cmp.missing}</strong> ${drift ? `declared artefact${s(cmp.missing)} not seen live` : `artefact${s(cmp.missing)} from the ${escapeHtml(r.bNoun)} missing from the ${escapeHtml(r.aNoun)}`}</li>`);
  if (cmp.changed) qItems.push(`<li class="ux-tone-warn"><strong>${cmp.changed}</strong> shared artefact${s(cmp.changed)} with changed fields${decisionCount ? ` — ${decisionCount} affect${decisionCount === 1 ? 's' : ''} decisions (objectives, thresholds, queries, routing)` : ''}${cosmeticCount ? `${decisionCount ? ',' : ' —'} ${cosmeticCount} cosmetic` : ''}</li>`);
  const qualityPanel = `
      <section class="compare-panel ux-tone-${cmp.missing ? 'fail' : cmp.changed ? 'warn' : 'ok'}" aria-labelledby="compare-quality-title">
        <h3 class="compare-panel-title" id="compare-quality-title">Quality gaps <span class="compare-panel-sub">need review</span></h3>
        ${qItems.length
          ? `<ul class="compare-panel-list">${qItems.join('')}</ul>
             <button type="button" class="ux-secondary-btn" data-ux-action="cmp-focus:review">Review ${diagUx.plural(cmp.review, 'change')}</button>`
          : `<p class="compare-panel-ok">No quality gaps: nothing ${drift ? 'declared is missing live' : `from the ${escapeHtml(r.bNoun)} is missing`}, and every shared artefact matches.</p>`}
      </section>`;

  const sItems = [];
  if (cmp.extras) sItems.push(`<li class="ux-tone-info"><strong>${cmp.extras}</strong> ${drift ? `live artefact${s(cmp.extras)} not declared (shadow signals)` : `additional artefact${s(cmp.extras)} in the ${escapeHtml(r.aNoun)}`}</li>`);
  if (t.outOfScope) sItems.push(`<li class="ux-tone-muted"><strong>${t.outOfScope}</strong> live artefact${s(t.outOfScope)} outside the declared scope — platform inventory, not counted</li>`);
  if (t.scaffold) sItems.push(`<li class="ux-tone-muted"><strong>${t.scaffold}</strong> template placeholder${s(t.scaffold)} (scaffold) — not counted</li>`);
  const overlap = t.universe ? Math.round((t.shared / t.universe) * 100) : 100;
  const structuralPanel = `
      <section class="compare-panel ux-tone-info" aria-labelledby="compare-structural-title">
        <h3 class="compare-panel-title" id="compare-structural-title">Structural differences <span class="compare-panel-sub">informational</span></h3>
        ${sItems.length
          ? `<ul class="compare-panel-list">${sItems.join('')}</ul>`
          : '<p class="compare-panel-ok">No structural differences: both packs hold the same artefacts.</p>'}
        <p class="compare-panel-overlap">${diagUx.termHtml('jaccard', 'Overlap')}: ${overlap}% of all compared artefacts appear in both packs.${overlap < 50 && cmp.extras > cmp.missing ? ' It is low because of the additional artefacts, not because anything is missing.' : ''}</p>
      </section>`;

  // Per-layer counts: what "36 vs 6" means. The first two columns are every
  // artefact each pack holds in the layer (after the product lens) — the
  // pair shown on each layer in All differences; the last three count only
  // what the comparison pairs.
  const lens = state.compareLens || 'all';
  const lensed = (items, pack) => (lens === 'all' ? items : items.filter(a => productSurface(a, lens, pack)));
  let example = null;
  const layerRows = COMPARE_LAYERS.map(({ id: L, name }) => {
    const aN = lensed(layerItemsFor(state.pack, L), state.pack).length;
    const bN = lensed(layerItemsFor(state.packB, L), state.packB).length;
    const row = (digest?.rows || []).find(x => x.L === L);
    if (!aN && !bN && !row) return '';
    if (!example && (aN || bN)) example = { L, aN, bN };
    const shared = row ? row.aligned.length + row.drifted.length : 0;
    return `
          <tr>
            <th scope="row" title="${escapeHtml(diagUx.layerTitle(L))}"><span class="drift-row-num">${L}</span> ${escapeHtml(name)}</th>
            <td>${aN}</td>
            <td>${bN}</td>
            <td>${shared}${row?.drifted.length ? ` <span class="compare-counts-differ">(${row.drifted.length} differ)</span>` : ''}</td>
            <td>${row?.onlyInA.length || 0}</td>
            <td>${row?.onlyInB.length || 0}</td>
          </tr>`;
  }).join('');
  const layerTable = layerRows ? `
      <section class="compare-layer-counts" aria-labelledby="compare-counts-title">
        <h3 class="compare-panel-title" id="compare-counts-title">By layer</h3>
        <p class="compare-counts-lede">“In ${escapeHtml(r.aNoun)}” and “In ${escapeHtml(r.bNoun)}” count every artefact each pack holds in the layer${example ? ` — the “${example.aN} vs ${example.bN}” shown on ${example.L} in All differences means ${example.aN} in the ${escapeHtml(r.aNoun)} and ${example.bN} in the ${escapeHtml(r.bNoun)}` : ''}. The last three columns count only what the comparison pairs by behaviour; template placeholders, out-of-scope live inventory and dashboard panels are not paired, so the columns need not add up.</p>
        <div class="compare-counts-scroll">
          <table class="compare-counts-table">
            <thead><tr>
              <th scope="col">Layer</th>
              <th scope="col">In ${escapeHtml(r.aNoun)}</th>
              <th scope="col">In ${escapeHtml(r.bNoun)}</th>
              <th scope="col">Shared</th>
              <th scope="col">${escapeHtml(r.aOnly)}</th>
              <th scope="col">${escapeHtml(r.bOnly)}</th>
            </tr></thead>
            <tbody>${layerRows}</tbody>
          </table>
        </div>
      </section>` : '';

  return `
    <div class="compare-tiles">${tiles}</div>
    <div class="compare-panels">${qualityPanel}${structuralPanel}</div>
    ${layerTable}`;
}

// What a changed field means, in one line. First match wins, so the
// decision-bearing families come before the cosmetic ones.
const FIELD_MEANINGS = [
  [/mttd|mttr/i, 'The detection or recovery target differs — incident response is measured against a different time.'],
  [/objective|target|budget/i, 'The objective differs — the SLO promises a different level.'],
  [/burn/i, 'The burn-rate setting differs — the alert reacts at a different speed.'],
  [/window|duration|period|interval|(^|[._])for$/i, 'The time window differs — measured or waited over a different period.'],
  [/threshold|bound|(^|[._])op$|comparator|direction/i, 'The threshold differs — it trips at a different level or in a different direction.'],
  [/expr|query|promql|expression|good|total|record|metric|selector|matcher/i, 'The query differs — a different signal is measured.'],
  [/severity|priority/i, 'The severity differs — it pages differently.'],
  [/route|receiver|channel|contact|notification|pager/i, 'The routing differs — a different team or channel is notified.'],
  [/pipeline|exporter|backend|signal|endpoint|url/i, 'The telemetry path differs — signals travel a different way.'],
  [/retention|ilm|lifecycle/i, 'Retention differs — data is kept for a different time.'],
  [/sampl/i, 'Sampling differs — a different share of telemetry is kept.'],
  [/index|data_stream|stream|bucket|storage/i, 'The storage destination differs — data lands in a different place.'],
  [/protocol|port/i, 'The accepted protocols differ — some senders may not connect.'],
  [/sdk|propagat|resource_attributes|semconv|instrument/i, 'Instrumentation settings differ — signals carry different context.'],
  [/title|label|legend|display|description|desc|summary|name|folder|tag|layout|panel|unit|color|uid/i, 'A display detail differs — cosmetic.'],
];
function fieldMeaning(field) {
  for (const [re, text] of FIELD_MEANINGS) if (re.test(String(field || ''))) return text;
  return 'The value differs.';
}
function fmtDeltaValue(v) {
  if (v == null || v === '') return '—';
  const text = typeof v === 'string' ? v : JSON.stringify(v);
  return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

// Changes needing review: the quality gaps only — artefacts missing from
// one side, and shared artefacts whose fields changed, the changed fields
// side by side with a short human description. Structural differences are
// named, not listed.
function renderCompareReview(digest, cmp, ctx) {
  const r = ctx.roles;
  const drift = r.mode === 'drift';
  const wrap = document.createElement('div');
  wrap.className = 'compare-digest compare-review';
  const targets = [];
  const openBtn = (art, L, side, label) => {
    if (!art) return '';
    const i = targets.push([art, { id: L, num: L, name: L }, art._sub || null, side]) - 1;
    return `<button type="button" class="ux-link-btn compare-open" data-cmp-open="${i}">${escapeHtml(label)}</button>`;
  };
  const MAX_MISSING = 60;
  const MAX_CHANGED = 40;
  const MAX_FIELDS = 8;

  const missingSide = drift ? 'a' : 'b';
  const missing = (digest?.rows || []).flatMap(row => (drift ? row.onlyInA : row.onlyInB).map(e => ({ L: row.L, e })));
  const changed = (digest?.rows || []).flatMap(row => row.drifted.map(e => ({ L: row.L, e, cost: diagDriftCost(e) })))
    .sort((x, y) => y.cost.weight - x.cost.weight);

  const missingHtml = missing.length ? `
    <section class="compare-review-group" aria-labelledby="compare-missing-title">
      <h3 class="compare-panel-title" id="compare-missing-title">${drift ? 'Declared, not seen live' : `Missing from the ${escapeHtml(r.aNoun)}`} <span class="compare-panel-sub">${missing.length}</span></h3>
      <p class="compare-counts-lede">${drift
        ? 'The declared pack promises these; the live pack shows no behavioural counterpart.'
        : `The ${escapeHtml(r.bNoun)} declares these; the ${escapeHtml(r.aNoun)} has no behavioural counterpart.`}</p>
      <ul class="compare-missing-list">
        ${missing.slice(0, MAX_MISSING).map(({ L, e }) => {
          const art = e.artefact || (missingSide === 'a' ? e.a : e.b);
          return `
          <li class="compare-missing-item ux-tone-fail">
            <span class="drift-row-num" title="${escapeHtml(diagUx.layerTitle(L))}">${escapeHtml(L)}</span>
            <span class="compare-missing-label">${escapeHtml(diffEntryLabel(e))}</span>
            ${art?.id ? `<code class="compare-missing-id">${escapeHtml(art.id)}</code>` : ''}
            ${openBtn(art, L, missingSide, 'Open')}
          </li>`;
        }).join('')}
      </ul>
      ${missing.length > MAX_MISSING ? `<p class="compare-review-foot">+${missing.length - MAX_MISSING} more — <button type="button" class="ux-link-btn" data-ux-action="cmp-slice:${missingSide === 'a' ? 'onlyA' : 'onlyB'}">show all in All differences →</button></p>` : ''}
    </section>` : '';

  const costChip = (cost) => cost.className === 'decision'
    ? diagUx.statusChipHtml('assessment', 'warning', { label: 'Affects decisions', extraTip: 'A decision-bearing field changed: objective, threshold, window, query or routing.' })
    : cost.className === 'cosmetic'
      ? '<span class="ux-chip ux-chip-muted" title="Only display details differ.">Cosmetic</span>'
      : diagUx.statusChipHtml('assessment', 'warning', { label: 'Worth a look', extraTip: 'A behavioural field changed.' });
  const changedHtml = changed.length ? `
    <section class="compare-review-group" aria-labelledby="compare-changed-title">
      <h3 class="compare-panel-title" id="compare-changed-title">Shared, but changed <span class="compare-panel-sub">${changed.length}</span></h3>
      <p class="compare-counts-lede">The same control on both sides, with different field values. Decision-bearing changes first.</p>
      ${changed.slice(0, MAX_CHANGED).map(({ L, e, cost }) => {
        const deltas = e.deltas || [];
        const lead = deltas.find(d => !/title|label|legend|display|desc|summary|name|folder|tag/i.test(String(d.field))) || deltas[0];
        return `
        <article class="compare-change ux-tone-${cost.className === 'decision' ? 'warn' : cost.className === 'cosmetic' ? 'muted' : 'info'}">
          <header class="compare-change-head">
            <span class="drift-row-num" title="${escapeHtml(diagUx.layerTitle(L))}">${escapeHtml(L)}</span>
            <span class="compare-change-title">${escapeHtml(diffEntryLabel(e))}</span>
            ${costChip(cost)}
            <span class="compare-change-open">
              ${openBtn(e.a, L, 'a', `Open in ${r.aNoun}`)}
              ${openBtn(e.b, L, 'b', `Open in ${r.bNoun}`)}
            </span>
          </header>
          <p class="compare-change-desc">${escapeHtml(lead ? fieldMeaning(lead.field) : 'The behaviour differs; no field detail was recorded.')}${deltas.length > 1 ? ` ${deltas.length} fields differ in all.` : ''}</p>
          ${deltas.length ? `
          <div class="compare-counts-scroll">
            <table class="compare-fields">
              <thead><tr>
                <th scope="col">Field</th>
                <th scope="col">${escapeHtml(capitalize(r.aNoun))} <span class="compare-fields-side">(A)</span></th>
                <th scope="col">${escapeHtml(capitalize(r.bNoun))} <span class="compare-fields-side">(B)</span></th>
                <th scope="col">What it means</th>
              </tr></thead>
              <tbody>
                ${deltas.slice(0, MAX_FIELDS).map(d => `
                <tr>
                  <th scope="row"><code>${escapeHtml(String(d.field ?? ''))}</code></th>
                  <td><code>${escapeHtml(fmtDeltaValue(d.a))}</code></td>
                  <td><code>${escapeHtml(fmtDeltaValue(d.b))}</code></td>
                  <td>${escapeHtml(fieldMeaning(d.field))}</td>
                </tr>`).join('')}
              </tbody>
            </table>
          </div>
          ${deltas.length > MAX_FIELDS ? `<p class="compare-review-foot">+${deltas.length - MAX_FIELDS} more field${deltas.length - MAX_FIELDS === 1 ? '' : 's'} — open either side for the full artefact.</p>` : ''}` : ''}
        </article>`;
      }).join('')}
      ${changed.length > MAX_CHANGED ? `<p class="compare-review-foot">+${changed.length - MAX_CHANGED} more changed artefacts — <button type="button" class="ux-link-btn" data-ux-action="cmp-slice:both">show all shared in All differences →</button></p>` : ''}
    </section>` : '';

  const structuralFoot = cmp.extras ? `
    <p class="compare-review-foot">Not listed: ${drift
      ? `${diagUx.plural(cmp.extras, 'live artefact')} not declared`
      : `${diagUx.plural(cmp.extras, 'additional artefact')} in the ${escapeHtml(r.aNoun)}`} — structural differences, not quality gaps.
      <button type="button" class="ux-link-btn" data-ux-action="cmp-slice:${drift ? 'onlyB' : 'onlyA'}">Show them →</button></p>` : '';

  wrap.innerHTML = `
    <header class="diag-block-head">
      <h2 class="diag-block-title">Changes needing review</h2>
      <p class="diag-block-lede">Quality gaps only: artefacts one side expects and the other lacks, and shared artefacts whose fields changed.</p>
    </header>
    ${missingHtml || changedHtml ? `${missingHtml}${changedHtml}` : diagUx.emptyStateHtml({
      title: 'Nothing needs review.',
      checked: `${diagUx.plural(cmp.totals.shared, 'shared artefact')} compared field by field, and every ${drift ? 'declared' : r.bNoun} artefact looked for in the ${drift ? 'live pack' : r.aNoun}.`,
      body: cmp.extras ? `${drift ? 'Undeclared live artefacts' : 'The additional artefacts'} (${cmp.extras}) are structural differences and are not listed here.` : '',
      actions: [{ action: 'cmp-focus:all', label: 'Show all differences' }],
      tone: 'ok',
    })}
    ${structuralFoot}
  `;
  wrap.addEventListener('click', (ev) => {
    const btn = ev.target.closest?.('[data-cmp-open]');
    if (!btn || !wrap.contains(btn)) return;
    const target = targets[Number(btn.dataset.cmpOpen)];
    if (target) openDrawer(...target);
  });
  return wrap;
}
