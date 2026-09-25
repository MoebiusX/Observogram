// studio/compile-view.mjs
//
// The Compile / Remediate / Deploy workflow — Remediate's decision header and
// strategy chooser (named by effect: update the repository from live, deploy
// repository changes to live, review differences, sync both ways), the
// focused artefact compiler (select → format → preview → download or deploy)
// and the deploy modal's pre-deploy review panel.
// Re-render + deploy-modal entrypoints come through the studio host seam
// (host.mjs); compare-cluster helpers are imported from compare-view.mjs.
// Screen grammar: docs/UX_SCREEN_GRAMMAR.md, studio/ux-kit.mjs.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import {
  effectiveFocus, focusedPack, focusedPackId, focusedEnv,
  focusedCompileCatalog, setFocusedCompileCatalog,
  focusedCompileContent, setFocusedCompileContent,
  focusedCompileGroup, setFocusedCompileGroup,
  focusedCompileFlavor, setFocusedCompileFlavor,
  focusedCompileArtifact, setFocusedCompileArtifact,
} from './focus.mjs';
import { host as appHost } from './host.mjs';
import {
  catalogEntryFor, layerItemsFor, loadDiff, refreshDiff, runRetrofeed, activeDiffScopeMode,
  LAYERS_FOR_DIFF, renderLiveScopeControl,
} from './compare-view.mjs';
import { compareModeFor } from './diagnostic-grade.mjs';
import { artefactLabel, deploySelectionFromEntries, deploySurfaceForArtefact } from './artifact-model.mjs';
import {
  decisionHeaderHtml, wireUxActions, emptyStateHtml, statusChipHtml, GLOSSARY, announce, plural, listSentence,
} from './ux-kit.mjs';
import {
  deployReviewModel, hiddenSelectionNote, recommendRemediation, remediationDeployPhrase,
  remediationDeployActionLabel, remediationSideOnlyMeasure,
} from './verify-deploy.mjs';

// ---------- COMPILE view ----------
//
// Pack -> real, ingestible platform artefacts. The pack is the contract;
// this is the program. Spec §9's reference-implementation table made real.

async function loadCompileTargets() {
  if (state.compileTargets) return state.compileTargets;
  try {
    const r = await api('/api/compile/targets');
    state.compileTargets = r.targets || [];
  } catch (_) {
    state.compileTargets = [];
  }
  return state.compileTargets;
}

export async function loadDeployMatrix() {
  if (state.deployMatrix) return state.deployMatrix;
  try { state.deployMatrix = await api('/api/deploy/matrix'); }
  catch (_) { state.deployMatrix = { products: [], versions: {}, scopes: [], targets: {} }; }
  return state.deployMatrix;
}

function isDeployable(target) {
  return !!state.deployMatrix?.targets?.[target]?.deployable;
}
function targetScopable(target) {
  return !!state.deployMatrix?.targets?.[target]?.scopable;
}

async function loadCompileCatalog() {
  const packId = focusedPackId();
  const env = focusedEnv();
  // No pack id available — fall through to the error sentinel so
  // renderCompileView shows a message instead of looping. Uploaded /
  // crawled / drafted packs now register server-side and get a real id;
  // hitting this branch means something else went wrong (e.g. the user
  // is on home with no pack, or an upload failed validation).
  if (!packId) {
    setFocusedCompileCatalog({ error: 'No pack selected.', groups: [] });
    return focusedCompileCatalog();
  }
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  try {
    const r = await fetch(`/api/packs/${encodeURIComponent(packId)}/compile-catalog?${params}`);
    if (!r.ok) {
      // CRITICAL: must NOT leave catalog null on failure. renderCompileView
      // re-fires loadCompileCatalog every time the catalog is null, so a
      // persistent 4xx/5xx (e.g. uploaded packs the server doesn't know
      // about under their __uploaded__ id) would loop a fetch-and-render
      // chain forever — that was the cause of the krystalinex-pack hang.
      // Store an error sentinel so the next render shows an explanation.
      let msg = `HTTP ${r.status}`;
      try {
        const ct = r.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await r.json();
          if (j?.error) msg = j.error;
        }
      } catch (_) {}
      setFocusedCompileCatalog({ error: msg, groups: [] });
      return focusedCompileCatalog();
    }
    const cat = await r.json();
    setFocusedCompileCatalog(cat);
    // Reconcile current selection with what's available (the pack may
    // have changed since last view).
    const groups = cat.groups || [];
    const g = groups.find(x => x.id === focusedCompileGroup()) || groups[0];
    if (!g) return cat;
    setFocusedCompileGroup(g.id);
    if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
      setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
    }
    if (!g.items?.some(it => it.id === focusedCompileArtifact())) {
      setFocusedCompileArtifact(g.items?.[0]?.id || 'all');
    }
  } catch (e) {
    // Network error / parse error — same loop-prevention as above.
    setFocusedCompileCatalog({ error: e.message || 'network error', groups: [] });
  }
  return focusedCompileCatalog();
}

// Map (group, flavor) → legacy deploy target id used by isDeployable() and the
// deploy panel. Until per-artifact deploy lands, deploys are still
// per-target (whole-file) so we resolve the active selection to the
// closest legacy target name.
function legacyDeployTargetFor(group) {
  if (group === 'rules')        return 'prometheus-rules';
  if (group === 'dashboards')   return 'grafana-dashboard';
  if (group === 'pipelines')    return 'otel-collector';
  if (group === 'alertmanager') return 'alertmanager';
  return null;
}

async function loadCompiled() {
  const packId = focusedPackId();
  const env = focusedEnv();
  if (!packId) { setFocusedCompileContent(null); return; }
  // Reset cached content so a switch between artifacts/flavors re-fetches.
  const params = new URLSearchParams();
  if (env) params.set('env', env);
  params.set('group', focusedCompileGroup());
  if (focusedCompileFlavor())   params.set('flavor', focusedCompileFlavor());
  if (focusedCompileArtifact()) params.set('artifact', focusedCompileArtifact());
  const url = `/api/packs/${encodeURIComponent(packId)}/compile-artifact?${params}`;
  try {
    const r = await fetch(url);
    const ct = r.headers.get('content-type') || '';
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      if (ct.includes('application/json')) {
        const j = await r.json().catch(() => null);
        if (j?.error) msg = j.error;
      }
      setFocusedCompileContent({ error: msg });
      return;
    }
    const text = await r.text();
    setFocusedCompileContent({
      filename: parseCdFilename(r.headers.get('content-disposition'))
        || `${packId}.${focusedCompileGroup()}.${focusedCompileArtifact()}`,
      contentType: ct.split(';')[0].trim(),
      text,
      source: r.headers.get('x-pack-source'),
      group: r.headers.get('x-compile-group'),
      flavor: r.headers.get('x-compile-flavor'),
      artifact: r.headers.get('x-compile-artifact'),
    });
  } catch (e) {
    setFocusedCompileContent({ error: e.message });
  }
}

function parseCdFilename(cd) {
  if (!cd) return null;
  const m = /filename="([^"]+)"/.exec(cd);
  return m ? m[1] : null;
}

// ============================================================
// Schema view — distinct from Conformance.
//
// Conformance answers "how MATURE is this pack?" against the maturity
// rubric (MUST/SHOULD per tier). The Schema view answers "how does
// this pack STAND UP against the v1.3 canonical schema?" — the
// structural question. Three sections:
//
//   1. Identity block — apiVersion / kind / metadata fields, the
//      canonical "what is this pack" header. Reads the same fields
//      a packlint would key on.
//   2. Validation status — pulled from the catalog (only validating
//      packs land in the catalog) plus a link to the schema source.
//   3. Canonical YAML — the manifest verbatim. Read-only, scrollable,
//      monospaced. The single source of truth for the pack.
//
// Caches the YAML per (pack-id, env) under state._schemaYaml so
// switching tabs back doesn't re-fetch.
// renderSchemaView now lives in studio/schema-view.mjs (imported above).
// ============================================================

// ============================================================
// OTLP coverage view (spec §3) — answers the question every fintech
// auditor will ask: "what OTLP-shaped wire does this pack run on?"
//
//   ┌────────────────────────────────────────────────────────────┐
//   │ OTLP · WIRE PROTOCOL COVERAGE                              │
//   │ grafana-reference · tier-2 · prod                          │
//   ├────────────────────────────────────────────────────────────┤
//   │ Receiver                                                    │
//   │ ✓ otlp receiver declared (spec MUST)                       │
//   │ Protocols: ● gRPC ● HTTP                                    │
//   │ Endpoint:  0.0.0.0:4317                                     │
//   ├────────────────────────────────────────────────────────────┤
//   │ Per-signal coverage                                         │
//   │   Signal      Receiver (in)         Exporter (out)         │
//   │   traces      ● OTLP                ● OTLP → tempo:4317   │
//   │   metrics     ● OTLP                ○ prometheusremotewrite│
//   │   logs        ● OTLP                ○ loki native          │
//   │   profiles    ○ not configured      — (pyroscope native)   │
//   ├────────────────────────────────────────────────────────────┤
//   │ SDK contract                                                │
//   │ Semconv 1.27.0 · propagators: tracecontext, baggage        │
//   │ Languages: java, node · Sampling: parentbased 0.1          │
//   │ Resource: service.name, service.namespace, service.version │
//   ├────────────────────────────────────────────────────────────┤
//   │ Summary: 3 of 4 signals wired · 1 end-to-end OTLP          │
//   └────────────────────────────────────────────────────────────┘
//
// Reads from the canonical pack (fetched once, cached). The layered
// display shape doesn't carry pipelines/otel under stable paths.
// renderOtlpView / renderOtlpBody now live in studio/otlp-view.mjs.
// ============================================================

// ============================================================
// RECONCILIATION PLAN — leads Remediate.
//
// "Resolve gaps" starts by deciding which direction each gap flows:
//
//   repo → live   — Pack A declares it, live does not; deploy or delete intent
//   live → repo   — live has it, Pack A does not; retrofeed or mark out of scope
//   drifted       — both sides have it but behaviour differs; choose source of truth
//
// The screen follows the shared grammar (docs/UX_SCREEN_GRAMMAR.md): a
// decision header names the repository and live packs, states the gap in
// one sentence and recommends ONE strategy derived from it; the strategies
// below are named by effect, each saying source → destination, how many
// changes it proposes, its next action (preview · generate patch · deploy)
// and whether it changes the repository, live systems or nothing.
// ============================================================

// The active set operation. An explicit choice wins; otherwise the strategy
// recommended from the diagnosed gap, then the fallback (bidirectional
// against live; importing against a baseline, whose extras are not gaps).
// The Pack-B strategies need Pack B; without it we clamp to deploy.
function effectiveRemediateOp(recommended = null, fallback = 'all') {
  const legacy = { A: 'deploy', B: 'retrofeed', AUB: 'all', 'A-B': 'deploy' };
  const chosen = legacy[state.remediateOp] || state.remediateOp;
  if (!state.packB) return 'deploy';
  if (chosen && REMEDIATE_OPS.some(o => o.id === chosen)) return chosen;
  return recommended || fallback;
}

// Resolve a set operation to a per-layer artefact list. Uses the
// server-computed diff (state.diff) for B / ∪ / − so the membership
// matches the Diagnose drill exactly; falls back to whole-pack walks
// when the diff isn't present (op 'A', or B-ops before the diff loads).
function resolveRemediationSet(op) {
  const haveB = !!state.packB;
  const diff = (state.diff && !state.diff.error && state.diff.layers) ? state.diff : null;
  const out = { byLayer: {}, total: 0, deployable: 0, author: 0, retrofeed: 0, drift: 0, needsDiff: false };

  for (const L of LAYERS_FOR_DIFF) {
    let entries = [];
    if (op === 'deploy' || !haveB) {
      if (!diff) { out.needsDiff = true; entries = layerItemsFor(state.pack, L).map(a => ({ art: a })); }
      else entries = (diff.layers[L]?.onlyInA || []).map(e => ({ art: e.artefact, direction: 'deploy', identity: e.key }));
    } else if (op === 'retrofeed') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = (diff.layers[L]?.onlyInB || []).map(e => ({ art: e.artefact, direction: 'retrofeed', identity: e.key }));
    } else if (op === 'drift') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = (diff.layers[L]?.inBoth || [])
        .filter(e => e.match === 'drifted')
        .map(e => ({ art: e.a, artB: e.b, deltas: e.deltas || [], direction: 'drift', identity: e.key }));
    } else if (op === 'all') {
      if (!diff) { out.needsDiff = true; entries = []; }
      else entries = [
        ...(diff.layers[L]?.onlyInA || []).map(e => ({ art: e.artefact, direction: 'deploy', identity: e.key })),
        ...(diff.layers[L]?.onlyInB || []).map(e => ({ art: e.artefact, direction: 'retrofeed', identity: e.key })),
        ...(diff.layers[L]?.inBoth || [])
          .filter(e => e.match === 'drifted')
          .map(e => ({ art: e.a, artB: e.b, deltas: e.deltas || [], direction: 'drift', identity: e.key })),
      ];
    }
    const enriched = entries
      .filter(e => e.art)
      .map(e => {
        const deploySurface = deploySurfaceForArtefact(e.art);
        const deployable = e.direction === 'deploy' ? deploySurface.deployable : false;
        return { ...e, ...deploySurface, deployable };
      });
    if (enriched.length) {
      out.byLayer[L] = enriched;
      out.total += enriched.length;
      out.deployable += enriched.filter(e => e.deployable).length;
      out.retrofeed += enriched.filter(e => e.direction === 'retrofeed').length;
      out.drift += enriched.filter(e => e.direction === 'drift').length;
      out.author += enriched.filter(e => !e.deployable).length;
    }
  }
  return out;
}

// Selected deployable identities = all deployable in the set minus the
// ones the user unchecked. `rows` is the count the deploy modal will show
// after expanding SLOs into recording + alerting rows.
function remediationSelectedDeployment(resolved, deselected = state.remediateDeselected || new Set()) {
  const entries = [];
  for (const L of LAYERS_FOR_DIFF) {
    entries.push(...(resolved.byLayer[L] || []));
  }
  return deploySelectionFromEntries(entries, deselected);
}

// The strategies, named by effect with the technical term as supporting
// text (GLOSSARY carries its definition). Internal ids are unchanged —
// state.remediateOp and the protos still speak all · deploy · retrofeed · drift.
//   effect  repo     changes the repository (a patch you review and commit)
//           live     changes live systems (after the deploy review)
//           preview  changes nothing
//           both     repository and live, each confirmed separately
const REMEDIATE_OPS = [
  { id: 'retrofeed', term: 'retrofeed',     next: 'Generate patch',              effect: 'repo',    needsB: true  },
  { id: 'deploy',    term: 'deploy',        next: 'Deploy, after a review',      effect: 'live',    needsB: false },
  { id: 'drift',     term: 'reconcile',     next: 'Preview',                     effect: 'preview', needsB: true  },
  { id: 'all',       term: 'bidirectional', next: 'Generate patch, then deploy', effect: 'both',    needsB: true  },
];

const REMEDIATE_EFFECTS = {
  repo:    { label: 'Changes the repository', note: 'as files you review and commit; live systems are untouched' },
  live:    { label: 'Changes live systems',   note: 'only after you review the destination, environment and artefacts' },
  preview: { label: 'Preview only',           note: 'nothing changes until you decide which side is right' },
  both:    { label: 'Changes the repository and live systems', note: 'the patch and the deploy are confirmed separately' },
};

const REMEDIATE_LAYER_NAMES = { L1:'Contract', L2:'Telemetry', L2X:'Extended', L3:'Insight', L4:'Action', L5:'Validation', GOV:'Governance' };

const SCOPE_WORDS = { service: 'service scope', family: 'family scope', all: 'all live artefacts' };

// In gap mode Pack B is a baseline, not live: say so in every scope phrase.
function scopeWords(scopeMode, mode) {
  if (scopeMode === 'all' && mode === 'gap') return 'the whole baseline';
  return SCOPE_WORDS[scopeMode] || scopeMode || 'the selected scope';
}
function parkedWord(mode) { return mode === 'gap' ? 'baseline artefact' : 'live artefact'; }
function widenAction(mode) {
  return { label: mode === 'gap' ? 'Widen the scope to the whole baseline' : 'Widen the live scope', action: 'rm-widen-scope' };
}

// Plain name first. In gap mode Pack B is a baseline (a reference or target
// pack), not live, so the import strategy says where it really reads from.
function strategyLabel(id, mode) {
  if (id === 'retrofeed') return mode === 'gap' ? 'Update the repository from the baseline' : 'Update the repository from live';
  if (id === 'deploy')    return 'Deploy repository changes to live';
  if (id === 'drift')     return 'Review differences individually';
  return 'Sync in both directions';
}

// "name vX" for the context line and the source → destination text: the
// catalog label (what the user picked) wins over metadata.name.
function packIdentity(packId, pack) {
  const entry = packId ? catalogEntryFor(packId) : null;
  const name = entry?.label || pack?.meta?.name || pack?.name || packId || 'unnamed pack';
  const version = String(entry?.version || pack?.meta?.version || '').replace(/^v/i, '');
  return { name, version, text: version ? `${name} v${version}` : name };
}

// The recommendation itself (one strategy, or none) is recommendRemediation
// in verify-deploy.mjs, where tools/test-verify-deploy.mjs pins it.

// Everything the Remediate screen says, computed once per render.
function remediationModel() {
  const haveB = !!state.packB;
  const mode = haveB ? compareModeFor(state.packB, state.compareBId) : null;
  const sideB = mode === 'gap' ? 'Baseline' : 'Live';
  const a = packIdentity(state.selectedPackId, state.pack);
  const b = haveB ? packIdentity(state.compareBId, state.packB) : null;
  const sets = {};
  for (const o of REMEDIATE_OPS) sets[o.id] = (o.needsB && !haveB) ? null : resolveRemediationSet(o.id);
  const counts = {
    liveOnly: sets.retrofeed?.retrofeed || 0,
    repoOnly: sets.deploy?.total || 0,
    repoDeployable: sets.deploy?.deployable || 0,
    drift: sets.drift?.drift || 0,
    outOfScope: (haveB && state.diff?.summary?.outOfScope) || 0,
  };
  const rec = recommendRemediation({ haveB, mode, ...counts });
  const op = effectiveRemediateOp(rec?.op, mode === 'gap' ? 'retrofeed' : 'all');
  const resolved = sets[op] || resolveRemediationSet(op);
  return { haveB, mode, sideB, a, b, sets, counts, rec, op, resolved, selected: remediationSelectedDeployment(resolved) };
}

// Source → destination, spelled out (review §5: keep them explicit).
function strategyFlow(opId, m) {
  const repo = `Repository · ${m.a.text}`;
  const other = m.b ? `${m.sideB} · ${m.b.text}` : 'Live';
  if (opId === 'retrofeed') return { from: other, to: repo };
  if (opId === 'deploy') return { from: repo, to: `Live platform${state.selectedEnv ? ` · ${state.selectedEnv}` : ''}` };
  return { from: repo, to: other, both: true };
}

function flowHtml(f) {
  return f.both
    ? `Between <strong>${escapeHtml(f.from)}</strong> and <strong>${escapeHtml(f.to)}</strong>`
    : `From <strong>${escapeHtml(f.from)}</strong> to <strong>${escapeHtml(f.to)}</strong>`;
}

// "N to deploy (R deploy rows)" for a strategy's set: the live selection for
// the active strategy, everything deployable for the others.
function deployPhraseFor(opId, s, m) {
  const sel = opId === m.op ? m.selected : remediationSelectedDeployment(s, new Set());
  return remediationDeployPhrase({ selected: sel.identities.size, deployable: s.deployable, rows: sel.rows });
}

// How many changes a strategy proposes, and what they are.
function strategyCount(opId, m) {
  const s = m.sets[opId];
  if (!s) return null;
  if (opId === 'retrofeed') return { n: s.retrofeed, note: s.retrofeed ? 'to add to the repository' : '' };
  if (opId === 'drift') return { n: s.drift, note: s.drift ? 'shared artefacts to compare' : '' };
  if (opId === 'deploy') {
    if (!m.haveB) return { n: s.total, note: s.total ? 'not compared with live' : '' };
    const manual = s.total - s.deployable;
    return { n: s.total, note: s.total ? listSentence([deployPhraseFor(opId, s, m), manual ? `${manual} need${manual === 1 ? 's' : ''} a manual fix` : '']) : '' };
  }
  // Every part is an artefact count, so the parts add up to the headline.
  const manual = s.total - s.retrofeed - s.drift - s.deployable;
  return {
    n: s.total,
    note: listSentence([
      s.retrofeed ? `${s.retrofeed} to add to the repository` : '',
      deployPhraseFor(opId, s, m),
      manual > 0 ? `${manual} need${manual === 1 ? 's' : ''} a manual fix` : '',
      s.drift ? `${s.drift} to compare` : '',
    ]),
  };
}

// "Review and deploy N selected (R deploy rows) to live": artefacts, as in
// the counts beside it, with deploy rows only in brackets.
function deployActionLabel(sel) {
  return remediationDeployActionLabel({ selected: sel.identities.size, rows: sel.rows });
}

// The active strategy's next step — the ONE primary action of the screen.
function strategyNextAction(opId, m) {
  const s = m.sets[opId] || m.resolved;
  if (!s?.total) return null;
  const deploy = m.selected.rows
    ? { label: deployActionLabel(m.selected), action: 'rm-deploy' }
    : { label: 'See what needs a manual fix', action: 'rm-show-changes' };
  if (opId === 'retrofeed') return { label: 'Generate repository patch', action: 'rm-patch' };
  if (opId === 'deploy') return deploy;
  if (opId === 'drift') return { label: 'Compare the differences side by side', action: 'rm-compare' };
  if (s.retrofeed) return { label: 'Generate repository patch', action: 'rm-patch' };
  if (m.selected.rows) return deploy;
  if (s.drift) return { label: 'Compare the differences side by side', action: 'rm-compare' };
  return { label: 'See what needs a manual fix', action: 'rm-show-changes' };
}

function remediationContext(m) {
  return [
    { key: 'Service', value: state.selectedService || state.pack?.meta?.service || '' },
    { key: 'Environment', value: state.selectedEnv || '' },
    { key: 'Repository', value: m.a.text, title: 'Pack A — the declared pack in the repository' },
    m.b ? { key: m.sideB, value: `${m.b.text}${state.compareBEnv ? ` · ${state.compareBEnv}` : ''}`, title: m.mode === 'gap' ? 'Pack B — the selected baseline' : 'Pack B — the live pack' } : null,
  ];
}

// Context · decision · next action · explanation (the decision header).
function remediationHeaderHtml(m) {
  const { haveB, mode, counts, rec, op } = m;
  const activeLabel = strategyLabel(op, mode);
  const sideWord = m.sideB.toLowerCase();
  let decision, tone, note = '';
  let primary = null;
  const secondary = [];

  if (!haveB) {
    decision = 'No live pack is loaded, so there is no diagnosed gap to resolve yet.';
    tone = 'info';
    note = 'Compare with a live pack to get a recommendation, or deploy the repository’s artefacts directly.';
    primary = { label: 'Compare with live first', action: 'rm-diagnose' };
    if (m.sets.deploy?.total) secondary.push({ label: 'Deploy repository artefacts to live', action: 'rm-deploy-all' });
  } else {
    // Gap mode: baseline artefacts the scoped diff parked (families your pack
    // does not declare, or outside the service scope) were never compared,
    // so they are named here: "your pack has everything" needs them at 0.
    const parkedInGap = mode === 'gap' ? counts.outOfScope : 0;
    const parts = mode === 'gap'
      ? [
          counts.liveOnly ? `the baseline has ${plural(counts.liveOnly, 'artefact')} your pack lacks` : '',
          counts.drift ? `${plural(counts.drift, 'shared artefact')} ${counts.drift === 1 ? 'differs' : 'differ'}` : '',
          parkedInGap ? `the baseline has ${plural(parkedInGap, 'artefact')} outside the checked scope that ${parkedInGap === 1 ? 'was' : 'were'} not compared` : '',
        ]
      : [
          counts.liveOnly ? `live has ${plural(counts.liveOnly, 'artefact')} the repository lacks` : '',
          counts.repoOnly
            ? `the repository has ${plural(counts.repoOnly, 'artefact')} not yet live${counts.repoDeployable ? '' : ` that ${counts.repoOnly === 1 ? 'needs' : 'need'} a manual fix`}`
            : '',
          counts.drift ? `${plural(counts.drift, 'shared artefact')} ${counts.drift === 1 ? 'differs' : 'differ'}` : '',
        ];
    const said = listSentence(parts.filter(Boolean));
    if (said) {
      decision = `${said.charAt(0).toUpperCase()}${said.slice(1)}.`;
      tone = 'warn';
    } else {
      decision = mode === 'gap'
        ? 'Your pack already has everything the selected baseline declares — nothing to import.'
        : 'The repository and live agree in the selected scope — nothing to resolve.';
      tone = 'ok';
    }
    const activeHasChanges = !!m.resolved.total;
    if (activeHasChanges) primary = strategyNextAction(op, m);
    if (rec && rec.op === op) {
      note = `Recommended: ${strategyLabel(rec.op, mode).toLowerCase()}, because ${rec.why}.`;
    } else if (rec) {
      note = `Recommended: ${strategyLabel(rec.op, mode).toLowerCase()}, because ${rec.why}. You are viewing “${activeLabel}”.`;
      const switchTo = { label: `Switch to the recommended strategy`, action: `rm-op-${rec.op}` };
      if (primary) secondary.push(switchTo); else primary = switchTo;
    } else if (!said) {
      note = mode === 'gap'
        ? 'Additional artefacts in your pack are not gaps. Review the assessment in Diagnose for anything else.'
        : `Checked in ${scopeWords(activeDiffScopeMode(), mode)}. Widen the live scope, or review the assessment in Diagnose.`;
      secondary.push({ label: 'Review the assessment', action: 'rm-diagnose' });
    } else if (mode !== 'gap' && counts.repoOnly && !counts.repoDeployable && !counts.liveOnly && !counts.drift) {
      note = 'None of them can be deployed from here: fix them in the pack, the instrumentation or the platform.';
    }
    // Part of the baseline was not compared: the way to compare it is one
    // click away (and the primary action when nothing else is proposed).
    if (parkedInGap && activeDiffScopeMode() !== 'all') {
      if (!rec) note = `Checked in ${scopeWords(activeDiffScopeMode(), mode)}. Widen the scope to compare the rest of the baseline; your pack may lack some of it.`;
      if (primary) secondary.push(widenAction(mode)); else primary = widenAction(mode);
    }
    // Bidirectional carries both halves: the other one stays one click away.
    if (op === 'all' && primary?.action === 'rm-patch' && m.selected.rows) {
      secondary.push({ label: deployActionLabel(m.selected), action: 'rm-deploy' });
    }
  }

  const measures = haveB ? [
    { label: `Only in ${sideWord}`, value: String(counts.liveOnly), ...remediationSideOnlyMeasure({ mode, liveOnly: counts.liveOnly, outOfScope: counts.outOfScope }) },
    { label: 'Only in the repository', value: String(counts.repoOnly), note: mode === 'gap' ? 'additional in your pack — not a gap' : (counts.repoOnly ? (counts.repoDeployable ? 'not yet live' : 'not yet live; need a manual fix') : 'nothing to deploy'), tone: counts.repoOnly && mode !== 'gap' ? 'warn' : 'neutral' },
    { label: 'Shared, fields differ', value: String(counts.drift), note: counts.drift ? 'decide which side is right' : 'shared artefacts agree', tone: counts.drift ? 'warn' : 'neutral' },
    { label: 'Scope checked', value: scopeWords(state.diff?.scope?.mode || activeDiffScopeMode(), mode), note: counts.outOfScope ? `${plural(counts.outOfScope, parkedWord(mode))} parked out of scope, not compared` : 'nothing parked out of scope', tone: counts.outOfScope && mode === 'gap' ? 'warn' : 'neutral' },
  ] : [];

  return decisionHeaderHtml({
    id: 'rm-decision',
    eyebrow: 'Remediate · Resolve gaps',
    context: remediationContext(m),
    decision, tone, note, primary, secondary, measures,
  });
}

// One strategy card: effect, name, technical term, source → destination,
// proposed changes and the next action. Disabled strategies say why.
function strategyCardHtml(o, m) {
  const disabled = o.needsB && !m.haveB;
  const active = o.id === m.op;
  const recommended = m.rec?.op === o.id;
  const effect = REMEDIATE_EFFECTS[o.effect];
  const g = GLOSSARY[o.term];
  const count = disabled ? null : strategyCount(o.id, m);
  const countText = disabled
    ? 'Needs a live pack to compare with'
    : (count.n ? plural(count.n, m.haveB ? 'proposed change' : 'artefact') : 'No changes proposed');
  return `
    <button type="button" class="ux-rm-strategy${active ? ' is-active' : ''}${recommended ? ' is-recommended' : ''}"
      data-op="${o.id}" data-ux-action="rm-op-${o.id}" aria-pressed="${active ? 'true' : 'false'}"${disabled ? ' disabled' : ''}
      title="${escapeHtml(`${g.term}: ${g.def}`)}">
      <span class="ux-rm-strategy-top">
        <span class="ux-rm-effect is-${o.effect}">${escapeHtml(effect.label)}</span>
        ${recommended ? '<span class="ux-rm-rec">Recommended</span>' : ''}
      </span>
      <span class="ux-rm-strategy-title">${escapeHtml(strategyLabel(o.id, m.mode))}</span>
      <span class="ux-rm-strategy-term">${escapeHtml(g.term)}</span>
      <span class="ux-rm-strategy-flow">${disabled ? 'Load a live pack (Pack B) to enable' : flowHtml(strategyFlow(o.id, m))}</span>
      <span class="ux-rm-strategy-count"><strong>${escapeHtml(countText)}</strong>${count?.note ? ` <span>· ${escapeHtml(count.note)}</span>` : ''}</span>
      <span class="ux-rm-strategy-next">Next: ${escapeHtml(o.next)}</span>
    </button>`;
}

// What the active strategy covers, in a sentence.
function strategyMeaning(op, m) {
  const other = m.b ? m.b.name : 'live';
  if (op === 'deploy') {
    if (!m.haveB) return 'Every artefact in the repository pack. Without a live pack to compare, the studio cannot tell which ones are already live.';
    return m.mode === 'gap'
      ? `Artefacts your pack declares beyond ${other}. The baseline is not a live pack, so deploying them is optional, not a gap.`
      : `Artefacts the repository declares that ${other} does not have. Ticked rows go to the deploy review; the rest need a manual fix in the pack, instrumentation or platform.`;
  }
  if (op === 'retrofeed') return `Artefacts ${other} has that the repository lacks. Generating the patch gives you an additions fragment and the updated pack to commit.`;
  if (op === 'drift') return 'Shared artefacts whose decision-bearing fields differ. Decide per artefact whether the repository or live is right.';
  return 'One plan for both directions: deploy what only the repository declares, add to the repository what only live has, and compare the shared artefacts that differ.';
}

// The explaining empty state — what was checked and where to go next —
// instead of zero counters and "This set is empty".
function strategyEmptyHtml(op, m) {
  const scope = state.diff?.scope || {};
  const scopeMode = scope.mode || activeDiffScopeMode();
  const checked = m.haveB
    ? `${m.sideB} pack ${m.b.text} against repository ${m.a.text}, ${scopeWords(scopeMode, m.mode)}${scope.service ? ` for ${scope.service}` : ''}, across all ${LAYERS_FOR_DIFF.length} layers${m.counts.outOfScope ? `; ${plural(m.counts.outOfScope, parkedWord(m.mode))} parked out of scope, not compared` : ''}.`
    : `Repository ${m.a.text}, across all ${LAYERS_FOR_DIFF.length} layers.`;
  // Gap mode with parked baseline artefacts: nothing was found IN SCOPE, and
  // the rest of the baseline was not compared, never "nothing to import".
  const gapParked = m.haveB && m.mode === 'gap' && m.counts.outOfScope > 0;
  const titles = {
    retrofeed: m.mode === 'gap'
      ? (gapParked ? 'Nothing to import in the checked scope; the rest of the baseline was not compared.' : 'Nothing to import from the selected baseline.')
      : 'Nothing to import from the selected live scope.',
    deploy: !m.haveB ? 'This pack has no artefacts to deploy.'
      : (m.mode === 'gap' ? 'Your pack has nothing beyond the selected baseline.' : 'Nothing to deploy: live already has everything the repository declares here.'),
    drift: 'No shared artefacts differ in the selected scope.',
    all: m.mode === 'gap'
      ? (gapParked ? 'Nothing to reconcile in the checked scope; the rest of the baseline was not compared.' : 'Nothing to reconcile with the selected baseline.')
      : 'The repository and live agree in the selected scope.',
  };
  const actions = [];
  if (m.haveB) actions.push({ label: 'Review other gaps', action: 'rm-review-other' });
  if (m.haveB && scopeMode !== 'all' && m.counts.outOfScope) actions.push(widenAction(m.mode));
  if (!m.haveB) actions.push({ label: 'Compare with live', action: 'rm-diagnose' });
  const partial = gapParked && (op === 'retrofeed' || op === 'all');
  return emptyStateHtml({ title: titles[op] || titles.all, checked, actions, tone: partial ? 'warn' : 'ok' });
}

// The first other strategy that proposes something — "Review other gaps".
function otherStrategyWithChanges(m) {
  if (m.rec && m.rec.op !== m.op && m.sets[m.rec.op]?.total) return m.rec.op;
  return REMEDIATE_OPS.find(o => o.id !== m.op && m.sets[o.id]?.total)?.id || null;
}

function goToDiagnose(sub) {
  state.view = 'compare';
  if (sub) state.diagnoseSub = sub;
  appHost.renderTabs();
  appHost.renderMainView();
}

// Disclosure open-state survives re-renders (a checkbox toggle re-renders).
const remediateUi = { changesOpen: null, patchOpen: false, diffWait: null };

// The remediation plan — leads the Remediate view. Appends to root and
// returns the [data-ux-action] handlers for the whole screen.
function renderRemediationPlan(root) {
  const haveB = !!state.packB;
  const handlers = {
    'rm-diagnose': () => goToDiagnose('grade'),
    'rm-compare': () => goToDiagnose('compare'),
    'rm-retry': () => { state.diff = null; appHost.renderMainView(); },
  };

  // Pack B loaded but no diff yet: say what is happening, fetch, re-render.
  // One waiter per diff load — a re-render meanwhile must not stack renders.
  if (haveB && !state.diff) {
    const aText = packIdentity(state.selectedPackId, state.pack).text;
    const bText = packIdentity(state.compareBId, state.packB).text;
    const head = document.createElement('div');
    head.innerHTML = decisionHeaderHtml({
      id: 'rm-decision',
      eyebrow: 'Remediate · Resolve gaps',
      context: [
        { key: 'Service', value: state.selectedService || state.pack?.meta?.service || '' },
        { key: 'Environment', value: state.selectedEnv || '' },
        { key: 'Repository', value: aText },
        { key: 'Compared with', value: bText },
      ],
      decision: 'Comparing the repository with live to plan the remediation…',
      tone: 'info',
    });
    root.appendChild(head.firstElementChild);
    if (state.compareBId && !remediateUi.diffWait) {
      announce('Comparing the repository with live to plan the remediation…');
      remediateUi.diffWait = loadDiff().finally(() => {
        remediateUi.diffWait = null;
        announce(state.diff?.error ? `Comparison failed: ${state.diff.error}` : 'Remediation plan ready.');
        appHost.renderMainView();
      });
    }
    return handlers;
  }

  // The comparison failed: explain it and offer a retry — never re-fetch in
  // a render loop.
  if (haveB && state.diff?.error) {
    const box = document.createElement('div');
    box.innerHTML = decisionHeaderHtml({
      id: 'rm-decision',
      eyebrow: 'Remediate · Resolve gaps',
      context: [{ key: 'Repository', value: packIdentity(state.selectedPackId, state.pack).text }, { key: 'Compared with', value: packIdentity(state.compareBId, state.packB).text }],
      decision: 'The repository could not be compared with live, so there is no plan yet.',
      tone: 'fail',
      primary: { label: 'Try the comparison again', action: 'rm-retry' },
      secondary: [{ label: 'Go to Diagnose', action: 'rm-diagnose' }],
    }) + emptyStateHtml({ title: 'No remediation plan without a comparison.', checked: `The comparison returned: ${state.diff.error}`, tone: 'fail' });
    while (box.firstChild) root.appendChild(box.firstChild);
    return handlers;
  }

  const m = remediationModel();
  const op = m.op;
  const resolved = m.resolved;
  const selectedDeployment = m.selected;
  const opDef = REMEDIATE_OPS.find(o => o.id === op);
  const effect = REMEDIATE_EFFECTS[opDef.effect];

  // ---- 1–4: context · decision · next action · explanation ----
  const headWrap = document.createElement('div');
  headWrap.innerHTML = remediationHeaderHtml(m);
  root.appendChild(headWrap.firstElementChild);

  // ---- the strategies ----
  const wrap = document.createElement('div');
  wrap.className = 'remediate-plan ux-rm-plan';
  wrap.innerHTML = `
    <div class="ux-rm-plan-head">
      <div class="ux-rm-plan-headtext">
        <h3 class="ux-rm-plan-title">Choose how to resolve the gaps</h3>
        <p class="ux-rm-plan-sub">Each strategy says what it changes: the repository, live systems, or nothing at all.</p>
      </div>
    </div>
    <div class="ux-rm-strategies" role="group" aria-label="Remediation strategies">
      ${REMEDIATE_OPS.map(o => strategyCardHtml(o, m)).join('')}
    </div>
  `;
  // Scope control: the sets are carved from the same scoped diff as
  // Diagnose — what's parked out of scope is a visible choice here too.
  if (haveB) wrap.querySelector('.ux-rm-plan-head').appendChild(renderLiveScopeControl({ standalone: true }));
  root.appendChild(wrap);

  const setOp = (id) => {
    const def = REMEDIATE_OPS.find(o => o.id === id);
    if (!def || (def.needsB && !haveB)) return;
    if (id === op) { state.remediateOp = id; return; }
    state.remediateOp = id;
    state.remediateDeselected = new Set();   // reset curation on strategy change
    const next = m.sets[id];
    announce(`${strategyLabel(id, m.mode)}: ${plural(next?.total || 0, 'proposed change')}.`);
    appHost.renderMainView();
  };
  for (const o of REMEDIATE_OPS) handlers[`rm-op-${o.id}`] = () => setOp(o.id);
  handlers['rm-deploy'] = () => {
    if (!selectedDeployment.rows) return;
    appHost.openDeployModal({ packId: state.selectedPackId, presetIdentities: selectedDeployment.identities });
  };
  // No live pack to compare: the deploy review opens with every deployable
  // artefact, and the choice is made there.
  handlers['rm-deploy-all'] = () => appHost.openDeployModal({ packId: state.selectedPackId });
  handlers['rm-patch'] = (_ev, btn) => generateRepositoryPatch(root, btn);
  handlers['rm-show-changes'] = () => {
    const d = root.querySelector('#rm-changes');
    if (!d) return;
    d.open = true;
    remediateUi.changesOpen = true;
    d.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
    d.querySelector('summary')?.focus?.({ preventScroll: true });
  };
  handlers['rm-review-other'] = () => {
    const other = otherStrategyWithChanges(m);
    if (other) setOp(other); else goToDiagnose('grade');
  };
  handlers['rm-widen-scope'] = () => {
    state.diffScopeMode = 'all';
    state.diff = null;
    announce(m.mode === 'gap' ? 'Widening the scope to the whole baseline…' : 'Widening the live scope to all live artefacts…');
    refreshDiff();
  };

  // ---- the active strategy ----
  const active = document.createElement('section');
  active.className = 'ux-rm-active';
  active.id = 'rm-active';
  active.setAttribute('aria-labelledby', 'rm-active-title');
  const term = GLOSSARY[opDef.term]?.term || '';
  active.innerHTML = `
    <div class="ux-rm-active-head">
      <h3 class="ux-rm-active-title" id="rm-active-title">${escapeHtml(strategyLabel(op, m.mode))} <span class="ux-rm-strategy-term">${escapeHtml(term)}</span></h3>
      <p class="ux-rm-flowline">${flowHtml(strategyFlow(op, m))}</p>
      <p class="ux-rm-effectline"><span class="ux-rm-effect is-${opDef.effect}">${escapeHtml(effect.label)}</span> <span>${escapeHtml(effect.note)}.</span></p>
      <p class="ux-rm-meaning">${escapeHtml(strategyMeaning(op, m))}</p>
    </div>
  `;
  wrap.appendChild(active);

  if (resolved.total === 0) {
    active.insertAdjacentHTML('beforeend', strategyEmptyHtml(op, m));
    return handlers;
  }

  // Proposed changes, in one line — only the counts this strategy uses.
  // Artefact counts throughout, so the parts add up to the total; deploy
  // rows only qualify the deploy part.
  const manual = resolved.total - resolved.deployable - resolved.retrofeed - resolved.drift;
  const summaryParts = haveB ? [
    resolved.retrofeed ? `${resolved.retrofeed} to add to the repository` : '',
    remediationDeployPhrase({ selected: selectedDeployment.identities.size, deployable: resolved.deployable, rows: selectedDeployment.rows }),
    resolved.drift ? `${plural(resolved.drift, 'shared artefact')} to compare` : '',
    manual > 0 ? `${manual} need${manual === 1 ? 's' : ''} a manual fix` : '',
  ] : ['not compared with live, so the deploy review lists every deployable artefact'];
  active.insertAdjacentHTML('beforeend', `
    <p class="ux-rm-summary"><strong>${escapeHtml(haveB ? plural(resolved.total, 'proposed change') : plural(resolved.total, 'artefact'))}</strong>: ${escapeHtml(listSentence(summaryParts.filter(Boolean)))}.</p>`);

  const bName = m.b?.name || null;
  const patchText = buildRetrofeedPatchText(resolved, bName);
  if (patchText) {
    const patch = document.createElement('details');
    patch.className = 'remediate-patch ux-rm-patch-preview';
    patch.open = !!remediateUi.patchOpen;
    patch.innerHTML = `
      <summary>Preview the repository patch (${escapeHtml(plural(resolved.retrofeed, 'artefact'))}) · nothing is written yet</summary>
      <pre>${escapeHtml(patchText)}</pre>
    `;
    patch.addEventListener('toggle', () => { remediateUi.patchOpen = patch.open; });
    active.appendChild(patch);
  }

  // ---- Per-layer, per-item checklist (collapsed when long) ----
  const changes = document.createElement('details');
  changes.className = 'ux-disclosure ux-rm-changes';
  changes.id = 'rm-changes';
  changes.open = remediateUi.changesOpen ?? resolved.total <= 25;
  changes.addEventListener('toggle', () => { remediateUi.changesOpen = changes.open; });
  changes.innerHTML = `
    <summary>Proposed changes by layer (${resolved.total})</summary>
    <div class="ux-disclosure-body">
      ${resolved.deployable ? '<p class="ux-rm-changes-hint">Ticked rows go to the deploy review; untick a row to leave it out. Rows without a box need a repository patch, a decision or a manual fix.</p>' : ''}
    </div>
  `;
  const list = document.createElement('div');
  list.className = 'remediate-list';
  const deselected = state.remediateDeselected || (state.remediateDeselected = new Set());
  for (const L of LAYERS_FOR_DIFF) {
    const entries = resolved.byLayer[L];
    if (!entries || !entries.length) continue;
    const layerEl = document.createElement('div');
    layerEl.className = 'remediate-layer';
    const depCount = entries.reduce((sum, e) => sum + (e.deployable ? (e.deployRows || 1) : 0), 0);
    layerEl.innerHTML = `
      <div class="remediate-layer-head">
        <span class="remediate-layer-num">${L}</span>
        <span class="remediate-layer-name">${escapeHtml(REMEDIATE_LAYER_NAMES[L] || L)}</span>
        <span class="remediate-layer-count">${entries.length}${depCount ? ` · ${depCount} deploy row${depCount === 1 ? '' : 's'}` : ''}</span>
      </div>
    `;
    const ul = document.createElement('ul');
    ul.className = 'remediate-items';
    for (const e of entries) {
      const li = document.createElement('li');
      const checked = e.deployable && e.identity && !deselected.has(e.identity);
      li.className = `remediate-item is-${e.direction || 'deploy'}` + (e.deployable ? '' : ' is-author');
      const labelText = artefactLabel(e.art, e.identity || '—');
      if (e.deployable) {
        li.innerHTML = `
          <label class="remediate-item-row">
            <input type="checkbox" ${checked ? 'checked' : ''}>
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            <span class="remediate-item-tag is-deploy">deploy · ${escapeHtml(e.deployLabel || (e.kind === 'dashboard' ? 'dashboard' : 'rules'))}</span>
          </label>
        `;
        const cb = li.querySelector('input');
        cb.onchange = () => {
          if (cb.checked) deselected.delete(e.identity);
          else deselected.add(e.identity);
          appHost.renderMainView();
        };
      } else {
        const tag = e.direction === 'retrofeed' ? 'add to repository'
          : e.direction === 'drift' ? 'choose a side'
          : (haveB ? 'manual fix' : 'not compared');
        const driftText = e.direction === 'drift' && e.deltas?.length
          ? `<span class="remediate-item-delta">${escapeHtml(e.deltas.slice(0, 3).map(d => d.path || d.field || 'field').join(' · '))}</span>`
          : '';
        li.innerHTML = `
          <div class="remediate-item-row">
            <span class="remediate-item-name">${escapeHtml(labelText)}</span>
            ${driftText}
            <span class="remediate-item-tag is-author">${escapeHtml(tag)}</span>
          </div>
        `;
      }
      ul.appendChild(li);
    }
    layerEl.appendChild(ul);
    list.appendChild(layerEl);
  }
  changes.querySelector('.ux-disclosure-body').appendChild(list);
  active.appendChild(changes);

  // ---- the actions, each saying what it changes ----
  const n = selectedDeployment.rows;
  const offersPatch = resolved.retrofeed > 0;
  const offersDeploy = haveB && (resolved.deployable > 0 || (op === 'deploy' && resolved.total > 0));
  const action = document.createElement('div');
  action.className = 'remediate-action ux-rm-actions';
  action.innerHTML = `
    ${!haveB ? `
      <div class="ux-rm-action">
        <button type="button" class="remediate-deploy-btn" data-ux-action="rm-deploy-all">Review and deploy repository artefacts to live ↗</button>
        <span class="remediate-action-hint"><span class="ux-rm-effect is-live">Changes live systems</span> Opens the deploy review with every deployable artefact; nothing is written until you confirm there.</span>
      </div>` : ''}
    ${offersPatch ? `
      <div class="ux-rm-action">
        <button type="button" class="ux-secondary-btn ux-rm-patch-btn" data-ux-action="rm-patch">Generate repository patch</button>
        <span class="remediate-action-hint"><span class="ux-rm-effect is-repo">Changes the repository</span> Downloads an additions fragment and the updated pack to commit. Live systems are untouched.</span>
        <div class="drift-retrofeed-result ux-rm-patch-result" hidden></div>
      </div>` : ''}
    ${offersDeploy ? `
      <div class="ux-rm-action">
        <button type="button" class="remediate-deploy-btn" data-ux-action="rm-deploy" ${n === 0 ? 'disabled' : ''}>
          ${escapeHtml(deployActionLabel(selectedDeployment))} ↗
        </button>
        <span class="remediate-action-hint"><span class="ux-rm-effect is-live">Changes live systems</span> ${n === 0
          ? 'Tick at least one deployable row, or handle the manual fixes in the pack.'
          : 'Opens a review of destination, environment and artefacts; nothing is written until you confirm there.'}</span>
      </div>` : ''}
    ${op === 'drift' || (op === 'all' && resolved.drift) ? `
      <div class="ux-rm-action">
        <button type="button" class="ux-secondary-btn" data-ux-action="rm-compare">Compare the differences side by side</button>
        <span class="remediate-action-hint"><span class="ux-rm-effect is-preview">Preview only</span> Opens Diagnose → Compare on the shared artefacts; nothing changes.</span>
      </div>` : ''}
  `;
  active.appendChild(action);
  return handlers;
}

// "Generate patch": the real retrofeed POST (compare-view's runRetrofeed)
// renders what was adopted and the two downloads; the progress and the
// outcome are announced once each.
async function generateRepositoryPatch(root, btn) {
  const out = root.querySelector('.ux-rm-patch-result');
  if (!out || !btn) return;
  announce('Generating the repository patch…');
  await runRetrofeed(btn, out);
  out.hidden = false;
  const head = out.querySelector('.drift-retrofeed-head')?.textContent?.replace(/\s+/g, ' ').trim();
  announce(head || 'Repository patch ready.');
  out.scrollIntoView?.({ behavior: 'smooth', block: 'nearest' });
}

export function buildRetrofeedPatchText(resolved, bName) {
  const changes = [];
  for (const L of LAYERS_FOR_DIFF) {
    for (const e of resolved.byLayer[L] || []) {
      if (e.direction !== 'retrofeed') continue;
      changes.push({ layer: L, identity: e.identity || '', artefact: e.art });
    }
  }
  if (!changes.length) return '';
  const lines = [
    'apiVersion: observogram.dev/v1alpha1',
    'kind: ReconcilePatch',
    'metadata:',
    `  service: ${yamlScalar(state.pack?.meta?.service || state.pack?.meta?.name || 'unknown')}`,
    `  source: ${yamlScalar(bName || 'Pack B')}`,
    'spec:',
    '  direction: live_to_repo',
    '  changes:',
  ];
  for (const change of changes) {
    const label = artefactLabel(change.artefact, change.identity);
    lines.push(`    - layer: ${yamlScalar(change.layer)}`);
    lines.push('      action: add_to_pack');
    lines.push(`      identity: ${yamlScalar(change.identity)}`);
    lines.push(`      title: ${yamlScalar(label)}`);
    lines.push('      artifact_json: |');
    for (const line of JSON.stringify(cleanPatchArtefact(change.artefact), null, 2).split('\n')) {
      lines.push(`        ${line}`);
    }
  }
  return lines.join('\n');
}

function cleanPatchArtefact(artefact) {
  if (!artefact || typeof artefact !== 'object') return artefact;
  const rest = { ...artefact };
  delete rest.domId;
  delete rest._sub;
  return rest;
}

function yamlScalar(value) {
  const s = String(value ?? '');
  if (!s) return "''";
  if (/^[A-Za-z0-9_.:/@-]+$/.test(s)) return s;
  return JSON.stringify(s);
}

export function renderCompileView(host) {
  // The decision header and the strategies lead the view; the artefact
  // compiler below is a focused, collapsed subview — the drill-down to
  // inspect or emit one artefact.
  const root = document.createElement('div');
  root.className = 'ux-rm-view';
  host.appendChild(root);
  const planHandlers = renderRemediationPlan(root);
  renderCompiler(root);
  wireUxActions(root, {
    ...planHandlers,
    'rm-compiler-open': () => { compilerUi.open = true; appHost.renderMainView(); focusCompiler(); },
    'rm-compiler-close': () => { compilerUi.open = false; appHost.renderMainView(); focusCompiler(); },
  });
}

// ---------- the artefact compiler: a focused subview ----------
//
// Select an artefact → choose the target format → preview → download or
// deploy, as four visible steps. Collapsed until the user opens it (the
// strategies above handle whole gaps; this is for one file), so nothing
// compiles behind a screen nobody asked for. Session-only: it stays open
// across re-renders once opened.
const compilerUi = { open: false, catalogWait: null, compileKey: null };

const COMPILER_STEPS = ['Select an artefact', 'Choose the target format', 'Preview the output', 'Download or deploy'];

function compilerStepsHtml(reached) {
  return `
    <ol class="ux-rm-steps" aria-label="Compiler steps">
      ${COMPILER_STEPS.map((s, i) => `
        <li class="ux-rm-step${reached >= 0 && i < reached ? ' is-done' : ''}${i === reached ? ' is-current' : ''}"${i === reached ? ' aria-current="step"' : ''}>
          <span class="ux-rm-step-n" aria-hidden="true">${i + 1}</span><span class="ux-rm-step-label">${escapeHtml(s)}</span>
        </li>`).join('')}
    </ol>`;
}

function stepHeadHtml(n, text) {
  return `<h4 class="ux-rm-step-head"><span class="ux-rm-step-n" aria-hidden="true">${n}</span><span class="sr-text">Step ${n}: </span>${escapeHtml(text)}</h4>`;
}

function focusCompiler() {
  setTimeout(() => {
    const el = document.querySelector('#rm-compiler .ux-rm-compiler-close, #rm-compiler [data-ux-action="rm-compiler-open"]');
    el?.focus?.();
  }, 0);
}

// The deploy review preselects the artefact being compiled (the manifest
// row id for its kind); a bundle ('all') opens with every deployable row.
function presetForCompileItem(item) {
  if (!item) return null;
  if (item.kind === 'rules-slo' && item.sloId) return new Set([item.sloId]);
  if (item.kind === 'rules-declared') return new Set([item.ruleName || item.id]);
  if (item.kind === 'rules-assurance') return new Set(['assurance']);
  if (item.kind === 'dashboard' && item.dashboardId) return new Set([item.dashboardId]);
  return null;
}

function renderCompiler(root) {
  const section = document.createElement('section');
  section.className = 'section compile-view ux-rm-compiler' + (compilerUi.open ? ' is-open' : '');
  section.id = 'rm-compiler';
  section.dataset.layer = 'COMPILE';
  section.dataset.focus = effectiveFocus();
  section.setAttribute('aria-labelledby', 'rm-compiler-title');

  const focusedPk = focusedPack();
  const head = document.createElement('div');
  head.className = 'section-head';
  const focusBadge = state.packB ? ` · pack ${effectiveFocus().toUpperCase()}` : '';
  head.innerHTML = `
    <span class="section-num">BLD</span>
    <h3 class="section-name ux-rm-compiler-title" id="rm-compiler-title">Artefact compiler${escapeHtml(focusBadge)}</h3>
    <span class="section-count">${escapeHtml(focusedPk?.id || '')}</span>
    ${compilerUi.open ? '<button type="button" class="ux-link-btn ux-rm-compiler-close" data-ux-action="rm-compiler-close" aria-expanded="true" aria-controls="rm-compiler-body">Close the compiler</button>' : ''}
  `;
  section.appendChild(head);
  root.appendChild(section);

  if (!compilerUi.open) {
    const intro = document.createElement('div');
    intro.className = 'ux-rm-compiler-intro';
    intro.innerHTML = `
      <p class="ux-rm-compiler-lede">Turn one artefact from the pack into a platform file — a rule file, a dashboard, a collector config — check it, then keep a copy or deploy it. Use it for a single file; the strategies above resolve whole gaps.</p>
      ${compilerStepsHtml(-1)}
      <button type="button" class="ux-secondary-btn" data-ux-action="rm-compiler-open" aria-expanded="false">Open the artefact compiler</button>
    `;
    section.appendChild(intro);
    return;
  }

  const body = document.createElement('div');
  body.className = 'ux-rm-compiler-body';
  body.id = 'rm-compiler-body';
  section.appendChild(body);
  const steps = document.createElement('div');
  steps.className = 'ux-rm-compiler-steps';
  body.appendChild(steps);

  // ---- Grid: left nav (step 1, the artefact tree) + right stage (2–4) ----
  const grid = document.createElement('div');
  grid.className = 'compile-grid';
  body.appendChild(grid);

  const nav = document.createElement('aside');
  nav.className = 'compile-nav';
  nav.setAttribute('aria-label', 'Artefacts to compile');
  grid.appendChild(nav);
  const stage = document.createElement('div');
  stage.className = 'compile-stage';
  grid.appendChild(stage);

  // Fetch catalog if missing for the focused pack (one waiter per load).
  if (!focusedCompileCatalog()) {
    steps.innerHTML = compilerStepsHtml(0);
    nav.innerHTML = `${stepHeadHtml(1, 'Select an artefact')}<div class="compile-loading">Loading artefacts…</div>`;
    stage.innerHTML = '<div class="placeholder">Loading the artefact catalog…</div>';
    if (!compilerUi.catalogWait) {
      compilerUi.catalogWait = loadCompileCatalog().then(() => {
        compilerUi.catalogWait = null;
        setFocusedCompileContent(null);
        appHost.renderMainView();
      });
    }
    return;
  }

  const catalog = focusedCompileCatalog();
  // Catalog-load error — show it, do NOT re-trigger the fetch. Without
  // this guard the renderCompileView → loadCompileCatalog → renderMainView
  // chain loops on persistent 4xx (e.g. uploaded packs the server has no
  // id for) and hangs the tab via fetch + localStorage thrash.
  if (catalog.error) {
    steps.innerHTML = compilerStepsHtml(0);
    nav.innerHTML = '<div class="placeholder">No catalog available.</div>';
    stage.innerHTML = `<div class="error">Compile catalog failed: ${escapeHtml(catalog.error)}</div>`;
    return;
  }
  const groups = catalog.groups || [];
  if (!groups.length) {
    steps.innerHTML = compilerStepsHtml(0);
    nav.innerHTML = '<div class="placeholder">This pack has nothing compilable yet — add SLOs, dashboards, or pipelines to the source.</div>';
    return;
  }

  // ---- Step 1: the artefact tree ----
  nav.insertAdjacentHTML('beforeend', stepHeadHtml(1, 'Select an artefact'));
  for (const g of groups) {
    const groupEl = document.createElement('div');
    groupEl.className = 'compile-group' + (g.id === focusedCompileGroup() ? ' is-active-group' : '');
    groupEl.innerHTML = `
      <div class="compile-group-head">
        <span class="compile-group-label">${escapeHtml(g.label)}</span>
        <span class="compile-group-count">${(g.items || []).length}</span>
      </div>
    `;
    const list = document.createElement('ul');
    list.className = 'compile-item-list';
    for (const it of (g.items || [])) {
      const li = document.createElement('li');
      const selected = (g.id === focusedCompileGroup()) && (it.id === focusedCompileArtifact());
      li.className = 'compile-item' + (selected ? ' is-active' : '');
      li.innerHTML = `
        <button type="button" class="compile-item-btn" title="${escapeHtml(it.subtitle || '')}"${selected ? ' aria-current="true"' : ''}>
          <span class="compile-item-bullet" aria-hidden="true">${selected ? '●' : '○'}</span>
          <span class="compile-item-body">
            <span class="compile-item-label">${escapeHtml(it.label)}</span>
            ${it.subtitle ? `<span class="compile-item-sub">${escapeHtml(it.subtitle)}</span>` : ''}
          </span>
        </button>
      `;
      li.querySelector('button').onclick = () => {
        setFocusedCompileGroup(g.id);
        setFocusedCompileArtifact(it.id);
        // Reconcile flavor with the chosen group.
        if (!g.flavors?.some(f => f.id === focusedCompileFlavor())) {
          setFocusedCompileFlavor(g.flavors?.[0]?.id || null);
        }
        setFocusedCompileContent(null);
        appHost.renderMainView();
      };
      list.appendChild(li);
    }
    groupEl.appendChild(list);
    nav.appendChild(groupEl);
  }

  const activeGroup = groups.find(g => g.id === focusedCompileGroup()) || groups[0];
  const activeFlavor = activeGroup?.flavors?.find(f => f.id === focusedCompileFlavor()) || activeGroup?.flavors?.[0];
  const activeItem = (activeGroup?.items || []).find(it => it.id === focusedCompileArtifact());

  // ---- Step 2: target format + the explicit "where does this land?" ----
  const formatStep = document.createElement('div');
  formatStep.className = 'ux-rm-compiler-step';
  formatStep.innerHTML = stepHeadHtml(2, 'Choose the target format');
  if ((activeGroup?.flavors || []).length > 1) {
    const flavorBar = document.createElement('div');
    flavorBar.className = 'compile-flavor-bar';
    flavorBar.setAttribute('role', 'group');
    flavorBar.setAttribute('aria-label', 'Target format');
    flavorBar.innerHTML = '<span class="compile-flavor-key">FORMAT</span>';
    for (const f of activeGroup.flavors) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'compile-flavor-pill' + (f.id === focusedCompileFlavor() ? ' is-active' : '');
      b.setAttribute('aria-pressed', f.id === focusedCompileFlavor() ? 'true' : 'false');
      b.textContent = f.label;
      b.title = `${f.platform} · ${f.description}`;
      b.onclick = () => {
        if (focusedCompileFlavor() === f.id) return;
        setFocusedCompileFlavor(f.id);
        setFocusedCompileContent(null);
        appHost.renderMainView();
      };
      flavorBar.appendChild(b);
    }
    formatStep.appendChild(flavorBar);
  }
  const callout = document.createElement('div');
  callout.className = 'compile-callout';
  callout.innerHTML = `
    <div class="compile-callout-head">
      <span class="compile-callout-label">TARGET PLATFORM</span>
      <span class="compile-callout-platform">${escapeHtml(activeFlavor?.platform || '—')}</span>
    </div>
    <div class="compile-callout-body">${escapeHtml(activeFlavor?.description || '')}</div>
  `;
  formatStep.appendChild(callout);
  stage.appendChild(formatStep);

  // ---- Step 3: preview ----
  const previewStep = document.createElement('div');
  previewStep.className = 'ux-rm-compiler-step';
  previewStep.innerHTML = stepHeadHtml(3, 'Preview the output');
  stage.appendChild(previewStep);
  if (activeItem) {
    const head2 = document.createElement('div');
    head2.className = 'compile-artifact-head';
    head2.innerHTML = `
      <span class="compile-artifact-label">${escapeHtml(activeItem.label)}</span>
      ${activeItem.subtitle ? `<span class="compile-artifact-sub">${escapeHtml(activeItem.subtitle)}</span>` : ''}
    `;
    previewStep.appendChild(head2);
  }

  // Content — compile once per selection; progress and outcome announced.
  if (!focusedCompileContent()) {
    steps.innerHTML = compilerStepsHtml(2);
    const ph = document.createElement('div');
    ph.className = 'placeholder';
    ph.setAttribute('role', 'status');
    ph.textContent = 'Compiling…';
    previewStep.appendChild(ph);
    const key = [focusedPackId(), focusedEnv(), focusedCompileGroup(), focusedCompileFlavor(), focusedCompileArtifact()].join('|');
    if (compilerUi.compileKey !== key) {
      compilerUi.compileKey = key;
      announce(`Compiling ${activeItem?.label || 'the artefact'} for ${activeFlavor?.platform || 'its target platform'}…`);
      loadCompiled().then(() => {
        if (compilerUi.compileKey === key) compilerUi.compileKey = null;
        const done = focusedCompileContent();
        if (done) announce(done.error ? `Compile failed: ${done.error}` : `Compiled ${done.filename}. The preview is ready.`);
        appHost.renderMainView();
      });
    }
    return;
  }
  if (focusedCompileContent().error) {
    steps.innerHTML = compilerStepsHtml(2);
    const err = document.createElement('div');
    err.className = 'error';
    err.textContent = `Compile failed: ${focusedCompileContent().error}`;
    previewStep.appendChild(err);
    return;
  }
  steps.innerHTML = compilerStepsHtml(3);
  const c = focusedCompileContent();
  // Map current selection to the legacy target name the deploy path expects.
  state.compileTarget = legacyDeployTargetFor(focusedCompileGroup()) || state.compileTarget;

  const meta = document.createElement('div');
  meta.className = 'compile-actions ux-rm-preview-meta';
  meta.innerHTML = `
    <div class="compile-meta">
      <code>${escapeHtml(c.filename)}</code>
      <span class="muted">${escapeHtml(c.contentType)}</span>
      <span class="muted">${c.text.length.toLocaleString()} bytes</span>
      ${c.source ? `<span class="muted">from <code>${escapeHtml(c.source)}</code></span>` : ''}
    </div>
  `;
  previewStep.appendChild(meta);

  const codeWrap = document.createElement('div');
  codeWrap.className = 'compile-code-wrap';
  const code = document.createElement('pre');
  code.className = 'compile-code ' + (c.contentType === 'application/json' ? 'lang-json' : 'lang-yaml');
  code.tabIndex = 0;
  code.setAttribute('aria-label', `Compiled output: ${c.filename}`);
  code.textContent = c.text;
  codeWrap.appendChild(code);
  previewStep.appendChild(codeWrap);

  // ---- Step 4: download (stays here) and deploy (goes live), kept apart ----
  const envLabel = focusedEnv() || '';
  const canDeploy = isDeployable(state.compileTarget) && activeFlavor?.deployable !== false && !activeItem?.generated;
  const noDeployReason = activeItem?.generated
    ? 'This generated board is not declared in the pack; declare it in spec.dashboards[] to deploy and verify it.'
    : (state.deployMatrix?.targets?.[state.compileTarget]?.reason
      || (activeFlavor?.deployable === false ? 'This format is not deployable from the studio; hand the file to its platform.' : 'No deploy path is configured for this target.'));
  const outStep = document.createElement('div');
  outStep.className = 'ux-rm-compiler-step';
  outStep.innerHTML = `
    ${stepHeadHtml(4, 'Download or deploy')}
    <div class="ux-rm-outputs">
      <div class="ux-rm-output is-local">
        <p class="ux-rm-output-title">Keep a copy</p>
        <p class="ux-rm-output-note">Stays on this machine. Nothing is deployed.</p>
        <div class="ux-rm-output-actions">
          <a class="ux-secondary-btn ux-rm-download" id="download-compiled" download="${escapeHtml(c.filename)}">Download ${escapeHtml(c.filename)}</a>
          <button class="ux-secondary-btn" id="copy-compiled" type="button">Copy to clipboard</button>
        </div>
      </div>
      <div class="ux-rm-output is-live${canDeploy ? '' : ' is-unavailable'}">
        <p class="ux-rm-output-title">Deploy to live <span class="ux-rm-effect is-live">Changes live systems</span></p>
        ${canDeploy ? `
          <p class="ux-rm-output-note">Writes to ${escapeHtml(activeFlavor?.platform || 'the live platform')}${envLabel ? ` for <strong>${escapeHtml(envLabel)}</strong>` : ''} through your MCP gateway. You review the destination, environment and artefacts before anything is written.</p>
          <div class="ux-rm-output-actions">
            <button class="ux-rm-deploy-btn" id="deploy-compiled" type="button">Review and deploy to live ↗</button>
          </div>` : `
          <p class="ux-rm-output-note">Not deployable from the studio: ${escapeHtml(noDeployReason)}</p>`}
      </div>
    </div>
  `;
  stage.appendChild(outStep);

  // Inline deploy panel — kept for its ids; the deploy button opens the
  // deploy review modal instead, so it stays hidden.
  const deployPanel = document.createElement('div');
  deployPanel.className = 'deploy-panel';
  deployPanel.hidden = true;
  if (isDeployable(state.compileTarget)) {
    deployPanel.innerHTML = renderDeployPanelMarkup(state.compileTarget);
  }
  stage.appendChild(deployPanel);

  outStep.querySelector('#copy-compiled').onclick = async () => {
    try { await navigator.clipboard.writeText(c.text); toast('Copied to clipboard'); announce(`Copied ${c.filename} to the clipboard.`); }
    catch (e) { toast('Copy failed: ' + e.message, 'error'); }
  };
  const dl = outStep.querySelector('#download-compiled');
  const blob = new Blob([c.text], { type: c.contentType });
  dl.href = URL.createObjectURL(blob);

  const deployBtn = outStep.querySelector('#deploy-compiled');
  if (deployBtn) {
    deployBtn.onclick = () => appHost.openDeployModal({ packId: focusedPackId(), presetIdentities: presetForCompileItem(activeItem) });
  }

  // Live re-derive the default tool name as the user changes product /
  // version / scope. We DON'T overwrite a user-typed override — only when
  // the input still matches the previous default do we refresh it.
  function rewireDefaults() {
    const toolInput = deployPanel.querySelector('#deploy-mcp-tool');
    if (!toolInput) return;
    const newDefault = computeDeployTool(state.compileTarget);
    if (toolInput.value === toolInput.dataset.lastDefault || !toolInput.value) {
      toolInput.value = newDefault;
    }
    toolInput.dataset.lastDefault = newDefault;
  }
  const prodSel = deployPanel.querySelector('#deploy-product');
  if (prodSel) prodSel.addEventListener('change', () => { state.deployProduct = prodSel.value; rewireDefaults(); });
  const verSel = deployPanel.querySelector('#deploy-version');
  if (verSel) verSel.addEventListener('change', () => { state.deployVersion = verSel.value; rewireDefaults(); });
  const scopeSel = deployPanel.querySelector('#deploy-scope');
  if (scopeSel) scopeSel.addEventListener('change', () => { state.deployScope = scopeSel.value; rewireDefaults(); });

  const goBtn2 = deployPanel.querySelector('#deploy-go-btn');
  if (goBtn2) goBtn2.onclick = () => doDeploy(deployPanel);
  const cancelBtn = deployPanel.querySelector('#deploy-cancel-btn');
  if (cancelBtn) cancelBtn.onclick = () => { deployPanel.hidden = true; };
}

// Mirror the server's defaultDeployTool function. Kept in sync with
// server/index.mjs::defaultDeployTool.
function computeDeployTool(target) {
  const product = state.deployProduct;
  if (product === 'grafana') {
    if (target === 'prometheus-rules') {
      return 'grafana_create_alert_rule';
    }
    if (target === 'grafana-dashboard') return 'grafana_create_dashboard';
  }
  return `apply_${String(target || '').replace(/-/g, '_')}`;
}

function renderDeployPanelMarkup(target) {
  const matrix = state.deployMatrix || { products: ['grafana'], versions: { grafana: ['12', '13'] }, scopes: ['both', 'recording', 'alerting'] };
  const products = matrix.products.length ? matrix.products : ['grafana'];
  const versions = matrix.versions[state.deployProduct] || matrix.versions[products[0]] || ['12', '13'];
  const scopes = matrix.scopes || ['both', 'recording', 'alerting'];
  const scopable = targetScopable(target);

  const scopeLabels = {
    both:      'both — recording + alerting rules',
    recording: 'recording rules only',
    alerting:  'alerting rules only',
  };

  return `
    <div class="deploy-panel-head">
      <div class="deploy-panel-title">Deploy via MCP write tool</div>
      <div class="deploy-panel-sub">Target a specific product + version. The pack stays the source of truth — re-deploy any time by re-emitting from the pack.</div>
    </div>
    <div class="deploy-panel-body">
      <div class="deploy-trio">
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target product</span>
          <select id="deploy-product">
            ${products.map(p => `<option value="${escapeHtml(p)}" ${p === state.deployProduct ? 'selected' : ''}>${escapeHtml(p)}</option>`).join('')}
          </select>
        </label>
        <label class="mcp-field deploy-field">
          <span class="mcp-field-key">Target version</span>
          <select id="deploy-version">
            ${versions.map(v => `<option value="${escapeHtml(v)}" ${v === state.deployVersion ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('')}
          </select>
        </label>
        ${scopable ? `
          <label class="mcp-field deploy-field">
            <span class="mcp-field-key">Rules scope</span>
            <select id="deploy-scope">
              ${scopes.map(s => `<option value="${escapeHtml(s)}" ${s === state.deployScope ? 'selected' : ''}>${escapeHtml(scopeLabels[s] || s)}</option>`).join('')}
            </select>
          </label>` : ''}
      </div>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP URL</span>
        <input id="deploy-mcp-url" type="url" placeholder="https://your-mcp.example.com/observability" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">Tool name <em>(default per product · version · scope)</em></span>
        <input id="deploy-mcp-tool" type="text" placeholder="grafana_create_alert_rule" autocomplete="off">
      </label>
      <label class="mcp-field">
        <span class="mcp-field-key">MCP client key <em>(optional, not persisted)</em></span>
        <input id="deploy-mcp-auth" type="password" placeholder="sk-..." autocomplete="off">
      </label>
      <div class="deploy-panel-actions">
        <button id="deploy-go-btn" class="mcp-refresh-btn" type="button">deploy</button>
        <button id="deploy-cancel-btn" class="ctrl-btn" type="button">cancel</button>
        <span id="deploy-status" class="mcp-refresh-status"></span>
      </div>
      <div id="deploy-result" class="deploy-result" hidden></div>
    </div>
  `;
}

async function doDeploy(panel) {
  const url  = panel.querySelector('#deploy-mcp-url').value.trim();
  const tool = panel.querySelector('#deploy-mcp-tool').value.trim() || computeDeployTool(state.compileTarget);
  const auth = panel.querySelector('#deploy-mcp-auth').value;
  const product = panel.querySelector('#deploy-product')?.value || state.deployProduct;
  const version = panel.querySelector('#deploy-version')?.value || state.deployVersion;
  const scope   = panel.querySelector('#deploy-scope')?.value   || (targetScopable(state.compileTarget) ? state.deployScope : undefined);
  const statusEl = panel.querySelector('#deploy-status');
  const resultEl = panel.querySelector('#deploy-result');
  const setStatus = (msg, kind) => {
    statusEl.textContent = msg;
    statusEl.className = 'mcp-refresh-status' + (kind ? ' is-' + kind : '');
  };
  if (!url) { setStatus('mcp url required', 'error'); return; }
  try { localStorage.setItem('mcpUrl', url); } catch (_) {}

  const goBtn = panel.querySelector('#deploy-go-btn');
  goBtn.disabled = true;
  setStatus(`deploying to ${product} ${version}${scope && scope !== 'both' ? ' · ' + scope : ''}…`);
  resultEl.hidden = true;

  const qs = new URLSearchParams();
  const deployEnv = focusedEnv();
  if (deployEnv) qs.set('env', deployEnv);
  if (state.compileDashId) qs.set('dashboardId', state.compileDashId);
  const target = state.compileTarget;
  const path = `/api/packs/${encodeURIComponent(focusedPackId())}/deploy/${encodeURIComponent(target)}?${qs}`;

  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: url,
        mcpAuth: auth || undefined,
        mcpTool: tool,
        targetProduct: product,
        targetVersion: version,
        scope,
      }),
    });
    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();
    let body;
    if (!ct.includes('application/json')) {
      setStatus(`error: server returned ${r.status} ${ct || 'no content-type'}`, 'error');
      console.error('[deploy] non-JSON response:', raw.slice(0, 400));
      return;
    }
    try { body = JSON.parse(raw); }
    catch (e) { setStatus(`error: malformed JSON (${e.message})`, 'error'); return; }

    if (!body.ok) {
      setStatus(`error: ${body.error || 'unknown'}`, 'error');
      resultEl.textContent = JSON.stringify(body, null, 2);
      resultEl.hidden = false;
      return;
    }
    setStatus(`deployed in ${body.tookMs}ms via ${escapeHtml(body.tool)}`, 'ok');
    resultEl.textContent = JSON.stringify(body.result, null, 2);
    resultEl.hidden = false;
    toast(`Deployed ${body.filename} to ${body.env || 'mcp'}`);
  } catch (e) {
    setStatus(`error: ${e.message}`, 'error');
  } finally {
    goBtn.disabled = false;
  }
}

// ============================================================
// The deploy modal's pre-deploy review.
//
// Destination, environment, the artefacts that change and the validation
// state in ONE panel beside the Deploy button (index.html #deploy-review),
// with Download kept apart as a quiet alternative. The modal's form and its
// handlers live in app.mjs; this only READS the form (the pure model is
// verify-deploy.mjs deployReviewModel) and re-renders the panel whenever the
// form, the manifest table or the modal's visibility changes. It also
// announces the modal's deploy status line through #ux-status.
// ============================================================

// Template values the open pack still carries (library.todo.* annotations
// and Scaffold artefacts): the same signal the Conformance screen uses for
// "some passes may rest on placeholders".
function templateValueCount(pack) {
  if (!pack) return 0;
  const ann = pack.meta?.annotations || pack.metadata?.annotations || {};
  const todos = Object.keys(ann).filter(k => k.startsWith('library.todo.')).length;
  let scaffolds = 0;
  for (const L of LAYERS_FOR_DIFF) scaffolds += layerItemsFor(pack, L).filter(a => a?.source === 'Scaffold').length;
  return todos + scaffolds;
}

function readDeployReview(doc) {
  const val = (id) => String(doc.getElementById(id)?.value ?? '').trim();
  const packId = val('deploy-source-pack');
  const entry = packId ? catalogEntryFor(packId) : null;
  const sameAsOpen = !!packId && packId === state.selectedPackId;
  const profileSel = doc.getElementById('deploy-target-profile');
  const rows = [...doc.querySelectorAll('#deploy-manifest-tbody tr[data-key]')]
    .filter(tr => tr.querySelector('input[type=checkbox]')?.checked)
    .map(tr => {
      const cells = tr.querySelectorAll('td');
      const key = tr.dataset.key || '';
      const pill = /type-pill-([a-z]+)/.exec(tr.querySelector('.type-pill')?.className || '')?.[1];
      const type = pill || (key.startsWith('dashboards:') ? 'dashboard' : (key.startsWith('rules:alert') ? 'alert' : 'recording'));
      return { type, id: cells[2]?.textContent?.trim() || '', name: cells[3]?.textContent?.trim() || '' };
    });
  const hiddenTypes = [...doc.querySelectorAll('#deploy-type-filters input[type=checkbox]')]
    .filter(i => !i.checked)
    .map(i => ({ value: i.value, label: i.closest('label')?.textContent?.trim() || i.value }));
  // Selected rows the filter hides, per type, when the modal reports them
  // (data-hidden-selected on the manifest tbody, JSON { type: n }). Without
  // it the note still says the true effect, just without counts.
  let hiddenSelected = null;
  try {
    const raw = doc.getElementById('deploy-manifest-tbody')?.dataset?.hiddenSelected;
    if (raw) hiddenSelected = JSON.parse(raw);
  } catch { hiddenSelected = null; }
  const hiddenNote = hiddenSelectionNote({ hiddenTypes, hiddenSelected });
  const model = deployReviewModel({
    target: {
      product: val('deploy-target-product'),
      version: val('deploy-target-version'),
      url: val('deploy-target-url'),
      folder: val('deploy-target-folder'),
      mcpUrl: val('deploy-target-mcp'),
      profile: profileSel?.value ? profileSel.selectedOptions?.[0]?.textContent : '',
    },
    source: { id: packId, label: entry?.label || packId, version: entry?.version || (sameAsOpen ? state.pack?.meta?.version : '') },
    env: state.selectedEnv || null,
    rows,
    validation: {
      // The catalog's `ok` only says the file parsed. The open pack was served
      // by GET /api/packs/:id, which refuses a schema-invalid pack, so it is
      // the one pack known valid; any other reads "not checked".
      schemaValid: entry?.ok === false ? false : (sameAsOpen && state.pack ? true : null),
      rubric: sameAsOpen && state.conformance
        ? {
            conformant: !!state.conformance.conformant,
            tier: state.conformance.declaredTier || null,
            placeholders: Array.isArray(state.conformance.onPlaceholder) ? state.conformance.onPlaceholder.length : 0,
            templates: templateValueCount(state.pack),
          }
        : null,
    },
  });
  return { model, packId, hiddenNote };
}

function deployReviewHtml(r, { downloadHref = '', hiddenNote = '' } = {}) {
  const d = r.destination;
  const dest = d.platform ? `${d.platform}${d.host ? ` at ${d.host}` : ''}` : 'No target product chosen';
  const destNote = [
    d.folder ? `folder ${d.folder}` : '',
    d.gateway ? `through the MCP gateway ${d.gateway}` : 'no MCP gateway URL yet',
    d.profile ? `profile “${d.profile}”` : '',
  ].filter(Boolean).join(' · ');
  const src = r.source.label ? `${r.source.label}${r.source.version ? ` v${r.source.version}` : ''}` : '';
  const changes = r.changes.total ? `${plural(r.changes.total, 'artefact')}: ${r.changes.summary}` : 'Nothing selected';
  const sample = r.changes.sample.length
    ? `${r.changes.sample.join(', ')}${r.changes.more ? ` and ${r.changes.more} more` : ''}`
    : 'Tick artefacts in the table above.';
  const checks = r.checks.map(c => statusChipHtml('assessment', c.status, { label: c.label })).join(' ');
  return `
    <p class="deploy-review-verdict ux-tone-${r.ready ? 'ok' : 'warn'}">${escapeHtml(r.headline)}</p>
    <dl class="deploy-review-grid">
      <div class="deploy-review-cell">
        <dt>Destination</dt>
        <dd><span class="deploy-review-val">${escapeHtml(dest)}</span><span class="deploy-review-note">${escapeHtml(destNote)}</span></dd>
      </div>
      <div class="deploy-review-cell">
        <dt>Environment</dt>
        <dd><span class="deploy-review-val">${escapeHtml(r.environment || 'Pack default')}</span><span class="deploy-review-note">${escapeHtml(src ? `compiled from ${src}` : 'the environment the artefacts compile for')}</span></dd>
      </div>
      <div class="deploy-review-cell">
        <dt>Changed artefacts</dt>
        <dd><span class="deploy-review-val">${escapeHtml(changes)}</span><span class="deploy-review-note">${escapeHtml(sample)}</span>${hiddenNote ? `<span class="deploy-review-note is-caution">${escapeHtml(hiddenNote)}</span>` : ''}</dd>
      </div>
      <div class="deploy-review-cell">
        <dt>Validation</dt>
        <dd class="deploy-review-checks">${checks}</dd>
      </div>
    </dl>
    <p class="deploy-review-alt">Deploy writes to the live platform, then re-checks each artefact through the live read path.${downloadHref
      ? ` Prefer to apply the files yourself? <a class="deploy-review-download" id="deploy-review-download" href="${escapeHtml(downloadHref)}" download>Download the compiled files (ZIP)</a> — nothing is deployed.`
      : ''}</p>`;
}

function renderDeployReview(doc) {
  const host = doc.getElementById('deploy-review-body');
  if (!host) return;
  const { model, packId, hiddenNote } = readDeployReview(doc);
  const env = state.selectedEnv;
  const downloadHref = packId ? `/api/packs/${encodeURIComponent(packId)}/export.zip${env ? `?env=${encodeURIComponent(env)}` : ''}` : '';
  host.innerHTML = deployReviewHtml(model, { downloadHref, hiddenNote });
  // The Deploy button says what it does and where (app.mjs only toggles
  // its disabled state, never its label).
  const go = doc.getElementById('deploy-modal-go');
  if (go) {
    const n = model.changes.total;
    go.innerHTML = `<span class="deploy-go-icon" aria-hidden="true">↑</span> ${escapeHtml(n ? `Deploy ${plural(n, 'artefact')} to live` : 'Deploy to live')}`;
    go.title = model.destination.platform
      ? `Writes to ${model.destination.platform}${model.destination.gateway ? ` through ${model.destination.gateway}` : ''}`
      : 'Writes to the live platform';
  }
}

let deployReviewWired = false;

// Idempotent. Self-wired below when the module loads in the browser; the
// modal markup is static, so there is nothing to wait for.
export function wireDeployReview(doc = (typeof document !== 'undefined' ? document : null)) {
  if (deployReviewWired || !doc?.getElementById) return;
  const modal = doc.getElementById('deploy-modal');
  if (!modal || !doc.getElementById('deploy-review-body') || typeof MutationObserver !== 'function') return;
  deployReviewWired = true;

  let queued = false;
  const refresh = () => {
    if (queued) return;
    queued = true;
    setTimeout(() => {
      queued = false;
      if (!modal.hidden) renderDeployReview(doc);
    }, 0);
  };
  modal.addEventListener('input', refresh);
  modal.addEventListener('change', refresh);
  const watch = new MutationObserver(refresh);
  watch.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
  // Rebuilt by app.mjs without firing input events: the manifest table, the
  // selects it (re)populates and the target summary a profile load rewrites.
  for (const id of ['deploy-manifest-tbody', 'deploy-target-product', 'deploy-target-version', 'deploy-source-pack', 'deploy-target-profile', 'deploy-target-summary']) {
    const el = doc.getElementById(id);
    if (el) watch.observe(el, { childList: true, characterData: true, subtree: true });
  }

  // Deploy progress, announced once per change (docs/UX_SCREEN_GRAMMAR.md).
  const status = doc.getElementById('deploy-modal-status');
  if (status) {
    let last = '';
    new MutationObserver(() => {
      const text = status.textContent.replace(/\s+/g, ' ').trim();
      if (!text || text === last) return;
      last = text;
      announce(`Deploy: ${text}`, doc);
    }).observe(status, { childList: true, characterData: true, subtree: true });
  }
}

if (typeof document !== 'undefined') wireDeployReview(document);
