// studio/conformance-view.mjs
//
// The Conformance view — how MATURE is the focused pack against the v1.4
// maturity rubric (MUST/SHOULD per tier). Self-contained; returns the
// rendered <section> for the caller to append.
//
// The 2026-09 UX review (§3 "Conformance / maturity rubric",
// docs/UX_SCREEN_GRAMMAR.md): "Conformant: no · 65% overall · 67% MUST"
// and a long list of muted clauses left people to work out what blocks
// conformance, and a "applies tier-3+" label beside a tier-2 assessment
// did not say whether a row was evaluated, excluded or shown for
// reference. The screen now states the governing result first, splits the
// clauses into what blocks, what passes only on a template value, what
// passes, and what does not apply at this tier (drawn as excluded, never as
// failed), gives every blocker a reason and a fix, and keeps the weighting
// in a collapsed "Scoring rules" section.
//
// View layer only: the verdict is tools/lib/conformance.mjs's, unchanged.
//
// Waivers (GAP batch 2, B3.2): when the report carries a `waivers` block
// (the service record's open waivers, server/waiver-admin.mjs over
// tools/lib/waivers.mjs) a failing clause the block marks `waived` moves
// to its own group, the header gains a Waived measure, the scoring rules a
// bullet, and a blocking clause whose waiver is `partial` or `expired` says
// so. Every piece is gated on `c.waivers` being an object — a bare report
// renders byte for byte what it did (tools/test-waivers.mjs pins it) — and
// every operator-typed text (reason, author, symbol) goes through
// escapeHtml. The headline stays the engine's; `effective` sits beside it.

import { state } from './state.mjs';
import { effectiveFocus, focusedConformance, focusedEnv, focusedPack, focusedPackId } from './focus.mjs';
import { orgQuery } from './api.mjs';
import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { layerItemsFor } from './diagnostic-grade.mjs';
import { clauseGhostLabel } from './build-model.mjs';
import {
  decisionHeaderHtml, layerTitle, LAYER_PURPOSE, plural, sectionNavHtml, statusChipHtml, statusRecord, termHtml,
  wireSectionNav, wireUxActions,
} from './ux-kit.mjs';

const RUBRIC_URL = 'https://github.com/MoebiusX/otel-observability-pack/blob/e64e58132a46364afd5432a86e67d470858936cf/docs/maturity-model.md';

const DIMENSIONS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5'];

// A reason and a fix per rubric clause (tools/lib/conformance.mjs RUBRIC).
// UI copy only — the verdict stays the engine's; an id not listed here
// falls back to the clause's own description and its layer.
export const CLAUSE_FIX = {
  'L1.MUST.availability_slo':             { reason: 'No availability SLO',                                   action: 'Add an availability SLO on a ratio SLI' },
  'L1.MUST.latency_slo':                  { reason: 'No latency SLO',                                        action: 'Add a latency SLO on a threshold or distribution SLI' },
  'L1.SHOULD.domain_slo':                 { reason: 'Fewer than four SLOs',                                  action: 'Add a domain-specific SLO' },
  'L1.MUST.sli_covered_by_slo':           { reason: 'An SLI has no SLO',                                     action: 'Give every SLI an SLO, or remove the unused SLI' },
  'L2.MUST.otlp_receiver':                { reason: 'No OTLP receiver in the collector pipeline',            action: 'Add an otlp receiver' },
  'L2.MUST.service_name_required':        { reason: 'service.name is not a required resource attribute',     action: 'Require service.name' },
  'L2.MUST.semconv_floor':                { reason: 'Semantic conventions older than 1.26.0',                action: 'Raise otel.semconv to 1.26.0 or later' },
  'L2.MUST.semconv_current':              { reason: 'Semantic conventions not at 1.27.0',                    action: 'Set otel.semconv to 1.27.0' },
  'L2.MUST.resource_attrs_5plus':         { reason: 'Fewer than five required resource attributes',          action: 'Require at least five resource attributes' },
  'L2.MUST.log_correlation':              { reason: 'Trace IDs are not injected into logs',                  action: 'Turn on otel.sdk.log_correlation' },
  'L2.MUST.metrics_exporter':             { reason: 'The pipeline exports no metrics',                       action: 'Add a metrics exporter' },
  'L2.MUST.logs_and_traces_exporters':    { reason: 'Logs or traces are not exported',                       action: 'Add logs and traces exporters' },
  'L2.MUST.tail_sampling':                { reason: 'No tail sampling',                                      action: 'Add a tail_sampling processor' },
  'L2.MUST.metrics_logs_traces_backends': { reason: 'Backends do not cover metrics, logs and traces',        action: 'Declare a backend for each signal' },
  'L2.SHOULD.backend_gating_enforce':     { reason: 'No backend pins a minimum version',                     action: 'Pin a minimum version with gating' },
  'L2X.MUST.extended_backend_refs_resolve': { reason: 'An extended surface names an undeclared backend',     action: 'Point it at a declared backend or an explicit ref:' },
  'L3.MUST.recording_rule_per_slo':       { reason: 'An SLO has no recording rule',                          action: 'Add a recording rule for each SLO' },
  'L3.SHOULD.derived_view':               { reason: 'No derived view',                                       action: 'Add a derived view (golden signals or a rollup)' },
  'L3.MUST.service_overview_dashboard':   { reason: 'No dashboard',                                          action: 'Add a service overview dashboard' },
  'L3.MUST.slo_burn_dashboard':           { reason: 'No SLO burn dashboard',                                 action: 'Add an SLO burn dashboard' },
  'L3.MUST.tier1_dashboards':             { reason: 'Fewer than four dashboards',                            action: 'Add deployment-overlay and customer-impact dashboards' },
  'L4.MUST.multi_window_burn_rate':       { reason: 'An SLO lacks a multi-window burn-rate alert',           action: 'Add a multi-window burn-rate alert for each SLO' },
  'L4.SHOULD.forecast_on_availability':   { reason: 'No forecast on availability',                           action: 'Add a forecast on the availability SLO' },
  'L4.MUST.tier1_voice_route':            { reason: 'L4 alert routing: the SEV1 route has no voice channel', action: 'Add a voice channel to the SEV1 route' },
  'L4.MUST.tier1_at_least_one_automation':{ reason: 'No self-healing remediation',                           action: 'Declare a remediation' },
  'L5.SHOULD.tier1_release_gate':         { reason: 'The regression gate does not block releases',           action: 'Set the regression gate to block releases' },
  'L5.MUST.synthetic_probe':              { reason: 'No synthetic check',                                    action: 'Add a synthetic check' },
  'L5.MUST.tier1_chaos_for_each_slo':     { reason: 'An SLO has no chaos experiment',                        action: 'Add a chaos experiment for each SLO' },
  'L5.MUST.tier2_chaos_staging':          { reason: 'No regular chaos experiment in staging',                action: 'Schedule a monthly (or more frequent) chaos experiment in staging' },
  'L5.MUST.tier1_weekly_prod_chaos':      { reason: 'No weekly production chaos with instrumented probes',   action: 'Schedule weekly production chaos with OTel-instrumented probes' },
};

const NUMBER_WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const countWord = (n) => NUMBER_WORDS[n] ?? String(n);
const tierLabel = (t) => String(t || '').replace(/^tier-/, 'tier ');
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// Where a clause applies, in words (minTier is the least stringent tier it
// reaches; tier 1 is the most stringent).
function appliesText(minTier) {
  if (minTier === 'tier-3') return 'Applies at every tier';
  if (minTier === 'tier-2') return 'Applies at tiers 1 and 2';
  if (minTier === 'tier-1') return 'Applies at tier 1 only';
  return `Applies from ${tierLabel(minTier)}`;
}

// The clauses that pass only on a template value, when the report says so:
// /conformance carries onPlaceholder for a pack with library todos (and the
// validation summary, summary.onPlaceholder, names them for a fresh build or
// upload). Any other report omits it, so this is null and the view hedges.
function placeholderEntries(c) {
  const src = c?.onPlaceholder || c?.summary?.onPlaceholder || null;
  if (!Array.isArray(src)) return null;
  return new Map(src.map(x => (typeof x === 'string' ? [x, { id: x, todos: [] }] : [x.id, x])));
}

// Template values the pack still carries: library.todo.* annotations and
// Scaffold artefacts (crawler / fetcher / library stubs), per layer.
function templateValues(pack) {
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const todos = Object.keys(ann).filter(k => k.startsWith('library.todo.')).length;
  const byLayer = {};
  let scaffolds = 0;
  for (const L of DIMENSIONS) {
    const n = layerItemsFor(pack, L).filter(a => a?.source === 'Scaffold').length;
    if (n) { byLayer[L] = n; scaffolds += n; }
  }
  return { todos, scaffolds, byLayer, any: todos + scaffolds > 0 };
}

// The report's waivers block when it carries one (an object), else null.
const waiversOf = (c) => (c?.waivers && typeof c.waivers === 'object' && !Array.isArray(c.waivers) ? c.waivers : null);
const EXPIRING_DAYS = 30;

/**
 * readConformance(c, pack) → the report split the way the screen reads it:
 * blocking (a MUST that applies and fails), recommended (a SHOULD that
 * fails — never blocking), waived (a failing clause the report's waivers
 * block covers whole), placeholder (passes only on a template value, when
 * the report names them), passed, and notApplicable (excluded at this
 * tier). Pure; the verdict fields are the engine's. `waived`, `effective`,
 * `waiverCounts` and `expiringSoon` default to [], null, null and 0 on a
 * report without a waivers block.
 */
export function readConformance(c, pack = null) {
  const ph = placeholderEntries(c);
  const templates = templateValues(pack);
  const wv = waiversOf(c)?.clauses || null;
  const groups = { blocking: [], recommended: [], waived: [], placeholder: [], passed: [], notApplicable: [] };
  for (const cl of c?.clauses || []) {
    const fix = CLAUSE_FIX[cl.id] || { reason: cl.description, action: `Review ${layerTitle(cl.dimension)}` };
    const row = { ...cl, ...fix, name: cap(clauseGhostLabel(cl.id)), placeholderTodos: ph?.get(cl.id)?.todos || [], waiver: wv?.[cl.id] || null };
    if (!cl.applies) groups.notApplicable.push(row);
    else if (!cl.pass) {
      if (row.waiver?.status === 'waived') groups.waived.push(row);
      else (cl.severity === 'MUST' ? groups.blocking : groups.recommended).push(row);
    } else if (ph?.has(cl.id)) groups.placeholder.push(row);
    else groups.passed.push(row);
  }
  // The active waivers quoted on any clause (waived or partial) that lapse within EXPIRING_DAYS, counted once each.
  const soon = new Set();
  for (const r of [...groups.waived, ...groups.blocking, ...groups.recommended]) {
    for (const w of r.waiver?.waivers || []) if (typeof w.expiresInDays === 'number' && w.expiresInDays >= 0 && w.expiresInDays <= EXPIRING_DAYS) soon.add(w.id ?? `${w.ruleId}|${w.artefactId}|${w.expiresAt}`);
  }
  return {
    tier: c?.declaredTier,
    conformant: !!c?.conformant,
    must: c?.must || { passed: 0, total: 0 },
    should: c?.should || { passed: 0, total: 0 },
    scorePercent: c?.scorePercent,
    mustPercent: c?.mustPercent,
    groups,
    placeholderKnown: !!ph,
    templates,
    // "Passed with real values" is only claimable when the report names the
    // placeholder passes, or the pack carries no template value at all.
    passedIsReal: !!ph || !templates.any,
    placeholderMust: groups.placeholder.filter(r => r.severity === 'MUST').length,
    waived: groups.waived,
    effective: waiversOf(c)?.effective || null,
    waiverCounts: waiversOf(c)?.counts || null,
    expiringSoon: soon.size,
  };
}

// Discover, filtered to one layer (the focused pack's).
function openLayer(layer) {
  state.view = 'layers';
  state.layerFilter = layer;
  state.activeLayer = layer;
  state.activeCardKey = null;
  appHost.renderTabs();
  appHost.renderMainView();
}

function sevText(sev) {
  return sev === 'MUST' ? 'Required (MUST)' : sev === 'SHOULD' ? 'Recommended (SHOULD)' : sev;
}

function metaLine(r, extra = '') {
  return `
    <div class="conf-row-meta">
      <span class="conf-row-sev" data-sev="${escapeHtml(r.severity)}">${escapeHtml(sevText(r.severity))}</span>
      <span>${escapeHtml(layerTitle(r.dimension))}</span>
      <span>${escapeHtml(extra || appliesText(r.minTier))}</span>
      <code>${escapeHtml(r.id)}</code>
      ${r.specRef ? `<span>spec ${escapeHtml(r.specRef)}</span>` : ''}
    </div>`;
}

function fixLine(r, lead = 'Fix') {
  return `
    <div class="conf-row-fix">
      <span class="conf-row-fix-key">${escapeHtml(lead)}:</span>
      <span>${escapeHtml(r.action)}</span>
      <button type="button" class="ux-link-btn" data-ux-action="conf-open:${escapeHtml(r.dimension)}">Open ${escapeHtml(r.dimension)} ${escapeHtml(LAYER_PURPOSE[r.dimension]?.name || '')} →</button>
    </div>`;
}

// The chip on a passed clause. The shared 'pass' tooltip says the clause was
// met with real values; when the report cannot say that (no onPlaceholder
// list, and the pack still carries template values) the chip keeps its look
// but its tooltip says what is unknown instead.
export function passChipHtml(passedIsReal) {
  if (passedIsReal) return statusChipHtml('assessment', 'pass');
  const r = statusRecord('assessment', 'pass');
  const tip = `${r.propertyLabel} — ${r.question} Met this check. This report does not say whether the pass rests on a real or a template value.`;
  return `<span class="ux-chip ux-chip-${r.tone} ux-chip-assessment" title="${escapeHtml(tip)}">${escapeHtml(r.label)}</span>`;
}

// One waiver, as the row quotes it: who, until when, why — every text the operator typed, escaped.
function waiverLine(w, lead) {
  const days = typeof w.expiresInDays === 'number' ? ` (${w.expiresInDays < 0 ? `${plural(-w.expiresInDays, 'day')} ago` : `in ${plural(w.expiresInDays, 'day')}`})` : '';
  const scope = w.artefactId ? ` on <code>${escapeHtml(w.artefactId)}</code>` : '';
  return `<p class="conf-row-waiver"><span class="conf-row-fix-key">${escapeHtml(lead)}:</span> <span>by ${escapeHtml(w.author ?? '')}${scope} until ${escapeHtml(String(w.expiresAt ?? '').slice(0, 10))}${escapeHtml(days)} — ${escapeHtml(w.reason ?? '')}</span></p>`;
}

// A blocking or recommended clause the waivers block marks partial or expired: the caveat under the fix.
function waiverCaveatHtml(r) {
  const w = r.waiver;
  if (!w || (w.status !== 'partial' && w.status !== 'expired')) return '';
  const label = w.status === 'expired' ? 'Waiver expired' : 'Partially waived';
  const remaining = w.subjects?.remaining?.length ? ` Still failing: ${w.subjects.remaining.map(s => `<code>${escapeHtml(s)}</code>`).join(', ')}.` : '';
  const text = w.status === 'expired' ? 'A waiver covered this requirement and has lapsed: it fails again until it is renewed or fixed.' : 'A waiver covers some of this requirement\'s subjects, not all: the clause still fails.';
  return `<p class="conf-row-caveat">${statusChipHtml('assessment', 'waived', { label })} ${escapeHtml(text)}${remaining}</p>${(w.waivers || []).map(x => waiverLine(x, w.status === 'expired' ? 'Lapsed' : 'Waived')).join('')}`;
}

function rowHtml(r, kind, model) {
  const tier = tierLabel(model.tier);
  if (kind === 'blocking' || kind === 'recommended') {
    const chip = kind === 'blocking'
      ? statusChipHtml('assessment', 'fail', { extraTip: 'A required clause that applies at this tier: it blocks conformance.' })
      : statusChipHtml('assessment', 'fail', { label: 'Not met', extraTip: 'Recommended (SHOULD): lowers the score, never blocks conformance.' });
    return `
      <li class="conf-row" data-group="${kind}" data-dim="${escapeHtml(r.dimension)}" data-sev="${escapeHtml(r.severity)}">
        <div class="conf-row-status">${chip}</div>
        <div class="conf-row-body">
          <p class="conf-row-title">${escapeHtml(r.reason)}</p>
          <p class="conf-row-desc">${escapeHtml(r.description)}</p>
          ${fixLine(r)}${waiverCaveatHtml(r)}
          ${metaLine(r)}
        </div>
      </li>`;
  }
  if (kind === 'waived') {
    const covered = r.waiver.subjects?.waived?.length ? `<p class="conf-row-todos"><span class="conf-row-fix-key">Covered:</span> ${r.waiver.subjects.waived.map(s => `<code>${escapeHtml(s)}</code>`).join(' ')}</p>` : '';
    return `
      <li class="conf-row" data-group="waived" data-dim="${escapeHtml(r.dimension)}" data-sev="${escapeHtml(r.severity)}">
        <div class="conf-row-status">${statusChipHtml('assessment', 'waived')}</div>
        <div class="conf-row-body">
          <p class="conf-row-title">${escapeHtml(r.reason)}</p>
          <p class="conf-row-desc">${escapeHtml(r.description)}</p>
          ${(r.waiver.waivers || []).map(w => waiverLine(w, 'Waived')).join('')}
          ${covered}
          ${fixLine(r, 'Before it lapses')}
          ${metaLine(r)}
        </div>
      </li>`;
  }
  if (kind === 'placeholder') {
    return `
      <li class="conf-row" data-group="placeholder" data-dim="${escapeHtml(r.dimension)}" data-sev="${escapeHtml(r.severity)}">
        <div class="conf-row-status">${statusChipHtml('assessment', 'placeholder')}</div>
        <div class="conf-row-body">
          <p class="conf-row-title">${escapeHtml(r.name)}</p>
          <p class="conf-row-desc">Requirement represented; real value still needed. ${escapeHtml(r.description)}</p>
          ${r.placeholderTodos.length ? `<p class="conf-row-todos"><span class="conf-row-fix-key">Template values:</span> ${r.placeholderTodos.map(t => `<code>${escapeHtml(t)}</code>`).join(' ')}</p>` : ''}
          ${fixLine({ ...r, action: 'Replace the template value with the real one' }, 'Complete')}
          ${metaLine(r)}
        </div>
      </li>`;
  }
  if (kind === 'passed') {
    const layerTemplates = !model.passedIsReal && model.templates.byLayer[r.dimension];
    return `
      <li class="conf-row" data-group="passed" data-dim="${escapeHtml(r.dimension)}" data-sev="${escapeHtml(r.severity)}">
        <div class="conf-row-status">${passChipHtml(model.passedIsReal)}</div>
        <div class="conf-row-body">
          <p class="conf-row-title">${escapeHtml(r.name)}</p>
          <p class="conf-row-desc">${escapeHtml(r.description)}</p>
          ${layerTemplates ? `<p class="conf-row-caveat">${statusChipHtml('completion', 'needsInput', { label: 'Layer has template values' })} ${escapeHtml(`${r.dimension} still carries ${plural(layerTemplates, 'template value')}; this pass may rest on one.`)}</p>` : ''}
          ${metaLine(r)}
        </div>
      </li>`;
  }
  // Not applicable: excluded at this tier — shown for reference, not evaluated.
  return `
    <li class="conf-row" data-group="na" data-dim="${escapeHtml(r.dimension)}" data-sev="${escapeHtml(r.severity)}">
      <div class="conf-row-status">${statusChipHtml('assessment', 'notApplicable', { extraTip: `Not evaluated at ${tier}.` })}</div>
      <div class="conf-row-body">
        <p class="conf-row-title">${escapeHtml(r.name)}</p>
        <p class="conf-row-desc">${escapeHtml(r.description)}</p>
        ${metaLine(r, `Excluded at ${tier}: ${appliesText(r.minTier).toLowerCase()}`)}
      </div>
    </li>`;
}

function groupHtml(id, title, note, rows, kind, model, { collapsible = false, open = true, tone = 'neutral' } = {}) {
  if (!rows.length) return '';
  const list = `<ol class="conf-rows">${rows.map(r => rowHtml(r, kind, model)).join('')}</ol>`;
  const noteHtml = note ? `<p class="conf-group-note">${escapeHtml(note)}</p>` : '';
  if (collapsible) {
    return `
      <details class="ux-disclosure conf-group conf-group-${kind} ux-section-target" id="${id}"${open ? ' open' : ''}>
        <summary>${escapeHtml(title)} <span class="conf-group-count">${rows.length}</span></summary>
        <div class="ux-disclosure-body">${noteHtml}${list}</div>
      </details>`;
  }
  return `
    <section class="conf-group conf-group-${kind} ux-tone-${tone} ux-section-target" id="${id}" tabindex="-1" aria-labelledby="${id}-title">
      <h3 class="conf-group-title" id="${id}-title">${escapeHtml(title)} <span class="conf-group-count">${rows.length}</span></h3>
      ${noteHtml}
      ${list}
    </section>`;
}

function scoringHtml(model) {
  const { must, should } = model;
  const tier = tierLabel(model.tier);
  const numer = must.passed + 0.5 * should.passed;
  const denom = must.total + 0.5 * should.total;
  return `
    <details class="ux-disclosure conf-scoring ux-section-target" id="conf-scoring">
      <summary>Scoring rules</summary>
      <div class="ux-disclosure-body">
        <p><strong>Conformance and the score answer different questions.</strong></p>
        <ul class="conf-scoring-list">
          <li><strong>${termHtml('conformant', 'Conformant')}</strong> means every required (MUST) clause that applies at ${escapeHtml(tier)} passes. One failing required clause makes the pack not conformant, whatever the score.</li>
          <li><strong>The score</strong> weighs required clauses 1 and recommended (SHOULD) clauses 0.5:
            (${must.passed} + 0.5 × ${should.passed}) ÷ (${must.total} + 0.5 × ${should.total}) = ${escapeHtml(denom ? `${numer} ÷ ${denom}` : 'nothing to score')} = <strong>${escapeHtml(String(model.scorePercent))}%</strong>.
            Required clauses alone: ${must.passed} of ${must.total} = ${escapeHtml(String(model.mustPercent))}%.</li>
          <li><strong>Not applicable</strong> clauses apply only at a more critical tier. They are excluded from both the score and conformance, and listed for reference.</li>
          <li><strong>Template values count as passes.</strong> The rubric reads the pack’s declarations: a placeholder satisfies a clause like a real value would, and nothing here checks live evidence. Conformance says nothing about deployment readiness.</li>${waiversBulletHtml(model)}
        </ul>
        <p>Scored against the <a href="${RUBRIC_URL}" target="_blank" rel="noopener">maturity rubric</a> (spec §8).</p>
      </div>
    </details>`;
}

// The scoring bullet on waivers — only when the report carries a waivers block.
function waiversBulletHtml(model) {
  if (!model.waiverCounts) return '';
  const e = model.effective;
  const n = model.waived.length;
  const effective = e ? ` With ${plural(n, 'waived clause')} read as met: required ${e.must.passed} of ${e.must.total}, score ${escapeHtml(String(e.scorePercent))}%, ${e.conformant ? 'conformant' : 'not conformant'} (effective).` : '';
  return `<li><strong>Waivers</strong> suppress a finding for a time, with a reason and an author; they never change the numbers above, which stay the rubric’s.${escapeHtml(effective)} An expired waiver fails again until it is renewed or the finding is fixed.</li>`;
}

export function renderConformanceView() {
  const wrap = document.createElement('section');
  wrap.className = 'section conformance-view';
  wrap.dataset.layer = 'CONF';
  wrap.dataset.focus = effectiveFocus();

  const c = focusedConformance();
  const pk = focusedPack();
  if (!c) {
    wrap.innerHTML = '<div class="placeholder">conformance report unavailable</div>';
    return wrap;
  }

  const model = readConformance(c, pk);
  const g = model.groups;
  const tier = tierLabel(model.tier);
  const nBlock = g.blocking.length;
  const nPh = g.placeholder.length;
  const nWaived = g.waived.length;
  const hasWaivers = model.waiverCounts !== null;

  // The governing result, in one sentence.
  let tone = 'ok';
  let verdict = 'Meets tier rubric';
  let decision;
  if (!model.must.total) {
    tone = 'warn'; verdict = 'No MUST clauses';
    decision = `No required clause applies at ${tier}, so conformance cannot be claimed.`;
  } else if (!model.conformant) {
    // The sentence already says "Not conformant": the chip carries the count behind it.
    tone = 'fail'; verdict = `${model.must.passed}/${model.must.total} MUST`;
    decision = `Not conformant at ${tier}: ${countWord(nBlock)} required clause${nBlock === 1 ? ' needs' : 's need'} attention.`;
    // The headline stays the rubric's; the waivers' reading sits beside it.
    if (hasWaivers && nWaived) decision += model.effective?.conformant ? ` With ${plural(nWaived, 'waived clause')} read as met, every required clause is covered (effective).` : ` ${cap(plural(nWaived, 'further required clause is', 'further required clauses are'))} waived for a time.`;
  } else if (nPh) {
    tone = 'warn';
    decision = `Meets the ${tier} rubric, but ${countWord(nPh)} clause${nPh === 1 ? ' passes' : 's pass'} only on a template value.`;
  } else if (!model.passedIsReal) {
    tone = 'warn';
    decision = `Meets the ${tier} rubric; the pack still carries ${plural(model.templates.todos + model.templates.scaffolds, 'template value')}, so some passes may rest on placeholders.`;
  } else {
    decision = `Meets the ${tier} rubric: all ${countWord(model.must.total)} required clauses pass.`;
  }

  const meta = pk?.meta || {};
  const header = decisionHeaderHtml({
    id: 'conf-decision',
    eyebrow: 'Conformance · maturity rubric',
    context: [
      { key: 'Service', value: meta.service || '' },
      { key: 'Environment', value: c.environment || meta.environment || '' },
      { key: 'Pack', value: [meta.name || pk?.name || pk?.id, meta.version ? `v${meta.version}` : ''].filter(Boolean).join(' ') },
      { key: 'Criticality', value: tier, title: 'The rubric is evaluated at the pack’s declared tier.' },
      state.packB ? { key: 'Showing', value: `Pack ${effectiveFocus().toUpperCase()}` } : null,
    ],
    tone,
    verdict,
    verdictTitle: 'Conformant: every required (MUST) clause for the tier passes — possibly on placeholders. It says nothing about deployment readiness.',
    decision,
    note: 'Conformance reads the pack’s declarations against the rubric; it does not check live evidence or deployment readiness.',
    primary: nBlock ? { label: 'Review blocking requirements', action: 'conf-goto:conf-blocking' }
      : nPh ? { label: 'Review placeholder passes', action: 'conf-goto:conf-placeholder' } : null,
    causes: g.blocking.slice(0, 3).map(r => ({
      title: `${r.dimension} · ${r.reason}`,
      why: `Fix: ${r.action}.`,
      actionLabel: `Open ${r.dimension}`,
      actionId: `conf-open:${r.dimension}`,
      tone: 'fail',
    })),
    measures: [
      { label: 'Required (MUST)', value: `${model.must.passed} / ${model.must.total}`, note: nBlock ? `${nBlock} blocking` : 'none blocking', tone: nBlock ? 'fail' : 'ok' },
      hasWaivers ? { label: 'Waived', value: String(nWaived), note: model.effective ? `effective ${model.effective.must.passed} / ${model.effective.must.total} MUST${model.expiringSoon ? ` · ${plural(model.expiringSoon, 'waiver')} expiring within ${EXPIRING_DAYS} days` : ''}` : 'time-boxed, with a reason', tone: 'info' } : null,
      { label: 'Recommended (SHOULD)', value: `${model.should.passed} / ${model.should.total}`, note: 'lower the score; never block' },
      { label: 'Weighted score', value: `${model.scorePercent}%`, note: 'not the conformance decision' },
      { label: 'Not applicable', value: String(g.notApplicable.length), note: `excluded at ${tier}`, tone: 'muted' },
    ].filter(Boolean),
  });

  // The service audit report (GAP batch 2, B3.5; README "Export A Service
  // Audit Report"): the server's GET /api/packs/:id/audit-report as a
  // download, HTML and JSON, for the focused pack and environment, org-scoped
  // like every navigation (orgQuery). The static bundle answers it 501 and the
  // browser shows the server's sentence on the download; nothing is hidden.
  const packId = focusedPackId();
  const env = c.environment || focusedEnv() || '';
  const reportHref = (format) => `/api/packs/${encodeURIComponent(packId)}/audit-report?format=${format}&download=1${env ? `&env=${encodeURIComponent(env)}` : ''}${orgQuery('&')}`;
  const exports = packId ? `
    <div class="conf-exports" aria-label="Export the audit report">
      <span class="conf-exports-label">Audit report</span>
      <a class="ux-link-btn" href="${escapeHtml(reportHref('html'))}" download>Download HTML</a>
      <a class="ux-link-btn" href="${escapeHtml(reportHref('json'))}" download>Download JSON</a>
      <span class="conf-exports-note">conformance, placeholders, verdicts, waivers, coverage, goes-blind risks and the response path in one document</span>
    </div>` : '';

  const nav = sectionNavHtml([
    nBlock ? { id: 'conf-blocking', label: 'Blocking', count: nBlock, tone: 'fail' } : null,
    g.recommended.length ? { id: 'conf-recommended', label: 'Recommended', count: g.recommended.length, tone: 'warn' } : null,
    hasWaivers && nWaived ? { id: 'conf-waived', label: 'Waived', count: nWaived, tone: 'info' } : null,
    nPh ? { id: 'conf-placeholder', label: 'On placeholders', count: nPh, tone: 'warn' } : null,
    g.passed.length ? { id: 'conf-passed', label: 'Passed', count: g.passed.length, tone: 'ok' } : null,
    g.notApplicable.length ? { id: 'conf-na', label: 'Not applicable', count: g.notApplicable.length, tone: 'muted' } : null,
    { id: 'conf-scoring', label: 'Scoring rules' },
  ], { label: 'Conformance sections' });

  // Per layer: required and recommended clauses that apply here.
  const dims = DIMENSIONS.filter(d => (c.clauses || []).some(cl => cl.dimension === d));
  const dimGrid = `
    <div class="conf-dim-grid" role="list" aria-label="By layer">
      ${dims.map(d => {
        const s = c.byDimension?.[d] || { mustPassed: 0, mustTotal: 0, shouldPassed: 0, shouldTotal: 0 };
        const ok = s.mustTotal === 0 || s.mustPassed === s.mustTotal;
        const applies = (s.mustTotal + s.shouldTotal) > 0;
        return `
          <div class="conf-dim" role="listitem" data-layer="${d}" data-pass="${ok}" data-applies="${applies}">
            <div class="conf-dim-key">${escapeHtml(d)} <span class="conf-dim-name">${escapeHtml(LAYER_PURPOSE[d]?.name || '')}</span></div>
            ${applies ? `
              ${s.mustTotal ? `<div class="conf-dim-must">${s.mustPassed} of ${s.mustTotal} required</div>` : ''}
              ${s.shouldTotal ? `<div class="conf-dim-should">${s.shouldPassed} of ${s.shouldTotal} recommended</div>` : ''}`
            : `<div class="conf-dim-na">Nothing applies at ${escapeHtml(tier)}</div>`}
          </div>`;
      }).join('')}
    </div>`;

  const phNote = model.placeholderKnown
    ? 'Requirement represented; real value still needed. These count as passes, so conformance can hold while the value is still a template.'
    : '';
  const passedNote = model.passedIsReal
    ? 'The pack declares what each clause asks for, with real values.'
    : `This report does not say which passes rest on template values, and the pack still carries ${plural(model.templates.todos + model.templates.scaffolds, 'template value')}${Object.keys(model.templates.byLayer).length ? ` (in ${Object.keys(model.templates.byLayer).join(', ')})` : ''}. Passes in those layers may rest on one.`;

  wrap.innerHTML = `
    ${header}${exports}
    ${nav}
    ${dimGrid}
    ${groupHtml('conf-blocking', 'Blocking requirements', `Required clauses that apply at ${tier} and fail. Each one alone keeps the pack from conformance.`, g.blocking, 'blocking', model, { tone: 'fail' })}
    ${groupHtml('conf-recommended', 'Recommended, not met', 'Recommended (SHOULD) clauses that fail. They lower the score but never block conformance.', g.recommended, 'recommended', model, { tone: 'warn' })}${hasWaivers ? groupHtml('conf-waived', 'Waived requirements', 'Clauses that fail and that a time-boxed waiver covers whole. The rubric still counts them as not met; the effective numbers read them as met until the waiver expires.', g.waived, 'waived', model, { tone: 'info' }) : ''}
    ${groupHtml('conf-placeholder', 'Passes on placeholders', phNote, g.placeholder, 'placeholder', model, { tone: 'warn' })}
    ${groupHtml('conf-passed', model.passedIsReal ? 'Passed with real values' : 'Passed', passedNote, g.passed, 'passed', model, { collapsible: true, open: !nBlock && !nPh })}
    ${groupHtml('conf-na', `Not applicable at ${tier}`, `These clauses apply only at a more critical tier. They were not evaluated for this pack and do not count towards the score or conformance.`, g.notApplicable, 'notApplicable', model, { collapsible: true, open: false })}
    ${scoringHtml(model)}
  `;

  const handlers = {};
  for (const d of DIMENSIONS) handlers[`conf-open:${d}`] = () => openLayer(d);
  for (const id of ['conf-blocking', 'conf-placeholder', 'conf-waived']) {
    handlers[`conf-goto:${id}`] = () => {
      const el = wrap.querySelector(`#${id}`);
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      el?.focus?.({ preventScroll: true });
    };
  }
  wireUxActions(wrap, handlers);
  // The section index needs its targets in the document: wire it once the
  // caller has appended the view.
  const wireNav = () => wireSectionNav(wrap);
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(wireNav); else wireNav();
  return wrap;
}
