// studio/build-verify-view.mjs
//
// BUILD step 3 — VERIFY, "What is ready, and what remains?" (the 2026-09 UX
// review, "Build / Verify", P0; docs/UX_SCREEN_GRAMMAR.md). The screen reads
// in the grammar's order:
//
//   1. Context      the service, its environment, the tier, what it is built from
//   2. Decision     one sentence ("Ready for team completion; not ready for
//                   deployment.") that never lets "meets the tier rubric" mask a
//                   clause passing on a placeholder
//   3. Next action  one primary button at the actual gate — fix what blocks the
//                   hand-off, resolve a failing requirement, "Complete required
//                   values", or "Open pack in Discover"
//   4. Explanation  four readiness states displayed independently: schema valid,
//                   meets tier rubric, implementation, deployment ready
//   5. Details      "What remains" — the smallest actionable list (what blocks the
//                   hand-off, the clauses that fail at the tier, warnings, clauses
//                   whose requirement is represented but whose real value is
//                   still needed, the values to fill by
//                   layer, the todos no value fills), each item with "Fix now" and,
//                   for a non-blocking warning, "Accept with reason"; then the
//                   rubric per layer (collapsed), the layer stack with the todos
//                   pinned to their slabs and their inputs inline, the compile
//                   targets, and the hand-off footer.
//
// "Fix now" reuses the journey's own handlers: a value or a todo is revealed on
// the stack below with its input focused (revealTodo); a warning opens the SLI's
// editor, and a schema error the layer's sheet, on COMPILE (VERIFY's editor is
// read-only). "Accept with reason" is a per-session acknowledgement kept on the
// draft (build.accepted, never persisted, never written into the pack): there is
// no backend for it, and the screen says so. There is no owner per item (the
// pack's owners are one team), so there is no "Assign".
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with buildVerifyModel's output; host.build.* are the actions.

import { escapeHtml, downloadText } from './util.mjs';
import { host as appHost } from './host.mjs';
import { stepHeadHtml, instantiateErrorHtml } from './build-define-view.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';
import { revealTodo, todoLines } from './build-atoms.mjs';
import { decisionHeaderHtml, wireUxActions, termHtml, disclosureHtml, emptyStateHtml, announce, plural, LAYER_PURPOSE } from './ux-kit.mjs';

const GLYPH = { pass: '✓', placeholder: '◐', fail: '✗' };
const REPRESENTED = 'Requirement represented; real value still needed';

/**
 * The per-layer maturity bars: clause counts per dimension, pass on a placeholder its own
 * segment — and its own number: the text beside the bar is the pass share plus, when any
 * clause passes only on a placeholder, that share with the ◐ glyph, so the split is read
 * without the colour (and by a screen reader through the bar's label).
 */
function maturityHtml(rows) {
  if (!rows.length) return '';
  const counts = (m) => `${m.pass} pass, ${m.placeholder} need${m.placeholder === 1 ? 's' : ''} a real value, ${m.fail} fail${m.pending ? `, ${m.pending} not evaluated` : ''} of ${m.total} clause${m.total === 1 ? '' : 's'}`;
  return `
    <div class="build-maturity" aria-label="maturity per layer">
      ${rows.map(m => `
        <div class="build-maturity-row" data-layer="${escapeHtml(m.id)}" title="${escapeHtml(`${m.num} ${m.name}: ${counts(m)} at this tier`)}">
          <span class="build-maturity-name"><b>${escapeHtml(m.num)}</b>${escapeHtml(m.name)}</span>
          <span class="build-maturity-bar" role="img" aria-label="${escapeHtml(`${m.num} ${m.name}: ${counts(m)}`)}">
            <span class="build-maturity-seg is-pass" style="width:${m.passPct}%"></span>
            <span class="build-maturity-seg is-placeholder" style="width:${m.placeholderPct}%"></span>
            <span class="build-maturity-seg is-fail" style="width:${m.failPct}%"></span>
            <span class="build-maturity-seg is-pending" style="width:${m.pendingPct}%"></span>
          </span>
          <span class="build-maturity-pct">${m.total ? `${m.passPct}%${m.placeholder ? ` <span class="build-maturity-ph" title="${escapeHtml(REPRESENTED.toLowerCase())}">+${m.placeholderPct}% ${GLYPH.placeholder}</span>` : ''}` : 'n/a'}</span>
        </div>`).join('')}
      <div class="build-maturity-legend"><span class="is-pass"><i></i>pass</span><span class="is-placeholder"><i></i>represented, real value still needed</span><span class="is-fail"><i></i>fail</span></div>
    </div>`;
}

const layerName = (id) => (LAYER_PURPOSE[id] ? `${id} ${LAYER_PURPOSE[id].name}` : id);

// ---------- "What remains": the smallest actionable list ----------

/** The reason form under a warning whose "Accept with reason" is open. */
function acceptFormHtml(item, draft) {
  const text = draft?.key === item.key ? draft.text || '' : '';
  return `
    <form class="bres-accept" data-accept-form>
      <label class="bres-accept-label" for="bres-accept-reason">Why is this acceptable?</label>
      <input id="bres-accept-reason" class="bres-accept-input" type="text" data-focus-key="accept:reason" value="${escapeHtml(text)}" autocomplete="off" required aria-describedby="bres-accept-hint">
      <p class="bres-accept-hint" id="bres-accept-hint">Kept for this session only — not saved, and not written into the pack.</p>
      <div class="bres-accept-actions">
        <button type="submit" class="ux-secondary-btn" data-ux-action="accept-save" data-key="${escapeHtml(item.key)}">Accept</button>
        <button type="button" class="ux-link-btn" data-ux-action="accept-cancel">Cancel</button>
      </div>
    </form>`;
}

function factsHtml(item) {
  return `
    <dl class="bres-facts">
      <div><dt>Impacts</dt><dd>${escapeHtml(item.impact)}</dd></div>
      <div><dt>Suggested correction</dt><dd>${escapeHtml(item.suggestion)}</dd></div>
    </dl>`;
}

/** A warning or a schema error: what it says, what it impacts, the suggested correction, Fix now (and Accept with reason). */
function warningItemHtml(item, model) {
  const where = item.fix.kind === 'editor' ? 'Opens the SLI’s editor on Compile' : `Opens the ${layerName(item.fix.layer)} sheet on Compile`;
  return `
    <li class="bres-item ux-tone-${item.blocking ? 'fail' : 'warn'}">
      <div class="bres-item-main">
        <span class="bres-kind">${escapeHtml(item.label)}${item.blocking ? ' · blocking' : ''}</span>
        <p class="bres-msg">${escapeHtml(item.message)}</p>
        ${factsHtml(item)}
      </div>
      <div class="bres-actions">
        <button type="button" class="ux-secondary-btn" data-ux-action="fix" data-key="${escapeHtml(item.key)}" title="${escapeHtml(where)}" aria-label="${escapeHtml(`Fix now: ${item.label}${item.sli ? ` on ${item.sli}` : ''}`)}">Fix now</button>
        ${item.acceptable && model.accepting !== item.key ? `<button type="button" class="ux-link-btn" data-ux-action="accept-open" data-key="${escapeHtml(item.key)}">Accept with reason</button>` : ''}
      </div>
      ${item.acceptable && model.accepting === item.key ? acceptFormHtml(item, model.acceptDraft) : ''}
    </li>`;
}

function clauseItemHtml(c) {
  return `
    <li class="bres-item ux-tone-warn">
      <div class="bres-item-main">
        <span class="bres-kind">${escapeHtml(layerName(c.layer))} · ${escapeHtml(c.severity)}</span>
        <p class="bres-msg"><strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(c.description)}</p>
        <p class="bres-rest">Rests on ${plural(c.todos.length, 'placeholder')}: ${c.todos.map(t => `<code>${escapeHtml(t)}</code>`).join(', ')}</p>
      </div>
      <div class="bres-actions">
        <button type="button" class="ux-secondary-btn" data-ux-action="fix" data-key="${escapeHtml(c.key)}" title="Shows the first placeholder it rests on, below" aria-label="${escapeHtml(`Fix now: ${c.label}`)}">Fix now</button>
      </div>
    </li>`;
}

function failingItemHtml(c) {
  return `
    <li class="bres-item ux-tone-fail">
      <div class="bres-item-main">
        <span class="bres-kind">${escapeHtml(layerName(c.layer))} · ${escapeHtml(c.severity)}</span>
        <p class="bres-msg"><strong>${escapeHtml(c.label)}</strong> — ${escapeHtml(c.description)}</p>
      </div>
      <div class="bres-actions">
        <button type="button" class="ux-secondary-btn" data-ux-action="fix" data-key="${escapeHtml(c.key)}" title="${escapeHtml(`Opens the ${layerName(c.layer)} sheet on Compile`)}" aria-label="${escapeHtml(`Fix now: ${c.label}`)}">Fix now</button>
      </div>
    </li>`;
}

function valueItemHtml(v) {
  return `
    <li class="bres-value">
      <span class="bres-value-name">${escapeHtml(v.label)}</span>
      <code class="bres-value-key">${escapeHtml(v.key)}</code>
      <span class="bres-value-now" title="the placeholder written into the pack today">${v.current ? `now <code>${escapeHtml(v.current)}</code>` : ''}</span>
      <button type="button" class="ux-link-btn" data-ux-action="fix" data-key="${escapeHtml(`value:${v.key}`)}" title="${escapeHtml(`Fills ${plural(v.todos.length, 'todo')} — focuses its input below`)}" aria-label="${escapeHtml(`Fix now: ${v.label}`)}">Fix now</button>
    </li>`;
}

function manualItemHtml(t) {
  const first = todoLines(t.what)[0] || '';
  return `
    <li class="bres-value is-manual">
      <span class="bres-value-name"><code>${escapeHtml(t.path)}</code></span>
      <span class="bres-value-now">${escapeHtml(first)}</span>
      <button type="button" class="ux-link-btn" data-ux-action="fix" data-key="${escapeHtml(t.key)}" title="No parameter fills it — shows it on its layer below" aria-label="${escapeHtml(`Show ${t.path}`)}">Show</button>
    </li>`;
}

function groupHtml({ id, title, count, why = '', tone = 'warn', body }) {
  return `
    <div class="bres-group ux-tone-${tone}" data-group="${escapeHtml(id)}">
      <h4 class="bres-group-title">${title} <span class="bres-count">${count}</span></h4>
      ${why ? `<p class="bres-group-why">${why}</p>` : ''}
      ${body}
    </div>`;
}

function remainsHtml(model) {
  const rm = model.remains;
  if (!rm) return '';
  const k = rm.counts;
  const summary = [
    k.blocking && `${plural(k.blocking, 'blocking issue')}`,
    k.failing && `${plural(k.failing, 'failing clause')}`,
    `${plural(k.warnings, 'warning')}`,
    `${plural(k.clauses, 'clause')} passing on placeholders`,
    `${plural(k.values, 'value')} to fill`,
    k.manual && `${k.manual} to write or measure`,
  ].filter(Boolean).join(' · ');
  const groups = [];
  if (rm.blocking.length) groups.push(groupHtml({ id: 'blocking', title: 'Blocking the hand-off', count: rm.blocking.length, tone: 'fail', why: 'The pack is not handed off while any of these stands.', body: `<ul class="bres-items">${rm.blocking.map(i => warningItemHtml(i, model)).join('')}</ul>` }));
  if (rm.failing?.length) groups.push(groupHtml({ id: 'failing', title: 'Failing at this tier', count: rm.failing.length, tone: 'fail', why: 'The pack does not meet the tier’s rubric while any of these fails. Each is resolved on its layer’s sheet on Compile.', body: `<ul class="bres-items">${rm.failing.map(failingItemHtml).join('')}</ul>` }));
  if (rm.warnings.length) groups.push(groupHtml({ id: 'warnings', title: 'Warnings to review', count: rm.warnings.length, body: `<ul class="bres-items">${rm.warnings.map(i => warningItemHtml(i, model)).join('')}</ul>` }));
  if (rm.clauses.length) groups.push(groupHtml({ id: 'clauses', title: termHtml('placeholder', REPRESENTED), count: rm.clauses.length, why: 'These clauses pass the rubric on a template value. They count toward the tier; they page nobody until the value is real.', body: `<ul class="bres-items">${rm.clauses.map(clauseItemHtml).join('')}</ul>` }));
  if (rm.values.total) {
    groups.push(groupHtml({
      id: 'values', title: 'Values to fill', count: rm.values.total,
      why: 'Grouped by the layer each value shapes. Fill one in its todo below (Enter or leave the field) and the pack regenerates; a filled value leaves this list.',
      body: rm.values.groups.map(g => `
        <div class="bres-layer-group" data-layer="${escapeHtml(g.layer)}">
          <h5 class="bres-layer-title">${escapeHtml(g.num)} ${escapeHtml(g.name)} <span class="bres-layer-q">${escapeHtml(g.question)}</span> <span class="bres-count">${g.items.length}</span></h5>
          <ul class="bres-values">${g.items.map(valueItemHtml).join('')}</ul>
        </div>`).join(''),
    }));
  }
  if (rm.manual.length) groups.push(groupHtml({ id: 'manual', title: 'To write or measure outside the studio', count: rm.manual.length, tone: 'neutral', why: 'No parameter fills these — a runbook to write, a baseline to measure. They travel with the pack as todos until the pack is edited.', body: `<ul class="bres-values">${rm.manual.map(manualItemHtml).join('')}</ul>` }));
  const accepted = rm.accepted.length ? disclosureHtml(`Accepted this session (${rm.accepted.length})`, `
      <p class="bres-group-why">Acknowledged here, for this session only: not saved, not written into the pack, not seen by anyone else.</p>
      <ul class="bres-items">${rm.accepted.map(i => `
        <li class="bres-item ux-tone-neutral">
          <div class="bres-item-main">
            <span class="bres-kind">${escapeHtml(i.label)}</span>
            <p class="bres-msg">${escapeHtml(i.message)}</p>
            <p class="bres-rest"><strong>Reason:</strong> ${escapeHtml(i.accepted.reason || '')}</p>
          </div>
          <div class="bres-actions"><button type="button" class="ux-link-btn" data-ux-action="accept-undo" data-key="${escapeHtml(i.key)}">Undo</button></div>
        </li>`).join('')}</ul>`, { cls: 'bres-accepted' }) : '';
  return `
    <section class="bres-remains" id="build-remains" aria-labelledby="build-remains-title">
      <div class="bres-head">
        <h3 class="bres-title" id="build-remains-title">What remains</h3>
        <p class="bres-sub">${escapeHtml(summary)}</p>
      </div>
      ${rm.empty ? emptyStateHtml({ title: 'Nothing remains', checked: 'the schema, the tier’s rubric, every warning, every placeholder value and every todo', tone: 'ok' }) : groups.join('')}
      ${rm.evaluated ? '' : emptyStateHtml({ title: 'The tier rubric is not evaluated yet', body: 'Nothing here says the pack meets it; what remains against the rubric is unknown until it is checked.', tone: 'neutral' })}
      ${accepted}
    </section>`;
}

/** The rubric per layer, collapsed: MUST / SHOULD, the three clause states, what fails, the maturity bars, the schema errors. */
function rubricDetailHtml(model) {
  const v = model.verdict;
  if (!v) return '';
  const k = model.checklist.counts;
  const body = `
    <p class="bres-rubric-line">MUST <b>${v.must.passed}/${v.must.total}</b>${v.should.total ? ` · SHOULD <b>${v.should.passed}/${v.should.total}</b>` : ''} at ${escapeHtml(model.tier || '')}</p>
    <div class="build-verdict-states">
      <span class="is-pass"><b>${GLYPH.pass}</b> ${k.pass} pass with real values</span>
      <span class="is-placeholder"><b>${GLYPH.placeholder}</b> ${k.placeholder} represented, real value still needed</span>
      <span class="is-fail"><b>${GLYPH.fail}</b> ${k.fail} fail</span>
    </div>
    ${v.failing.length ? `<ul class="build-verdict-failing">${v.failing.map(f => `<li><span class="build-sev build-sev-${f.severity.toLowerCase()}">${f.severity}</span> ${escapeHtml(f.description)} <code>${escapeHtml(f.id)}</code></li>`).join('')}</ul>` : ''}
    ${maturityHtml(model.maturity)}
    ${v.onPlaceholder.length ? `<p class="bres-rubric-note">The rubric reads no annotations, so a pager route of <code>pagerduty://…</code> satisfies it like a real one. ${termHtml('conformant', 'Meets tier rubric')} is not the same as ready to deploy.</p>` : ''}
    ${model.schema.errors.length ? `<ul class="build-verdict-errors">${model.schema.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('')}</ul>` : ''}`;
  return disclosureHtml(`Rubric detail — the ${model.tier || 'tier'} clauses per layer`, body, { open: v.conformant === false, cls: 'bres-rubric' });
}

// ---------- announcements ----------

let lastAnnouncement = '';
function announceResult(model) {
  if (!model.ready || model.pending || !model.decision) return;
  const k = model.remains?.counts;
  const msg = `Verify: ${model.decision.sentence}${k ? ` ${plural(k.values, 'value')} to fill, ${plural(k.warnings + k.blocking, 'warning')}.` : ''}`;
  if (msg === lastAnnouncement) return;
  lastAnnouncement = msg;
  announce(msg);
}

// ---------- render ----------

/** render(container, model, host) — the VERIFY step. */
export function renderBuildVerify(container, model, host = appHost) {
  const act = host.build;
  const stack = model.stack;
  const d = model.decision;
  const next = model.next || { primary: null, secondary: [] };
  const handoffIsPrimary = next.primary?.action === 'open-discover';
  const measures = (model.states || []).map(s => ({
    label: s.label, value: s.value, note: s.note, tone: s.tone,
    ...(s.id === 'rubric' ? { labelHtml: termHtml('conformant', 'Meets tier rubric') } : {}),
  }));
  container.innerHTML = `
    <section class="build-step build-verify">
      ${stepHeadHtml('verify', 'What is ready, and what remains?', 'The generated pack, read four ways — schema, the tier’s rubric, the implementation, deployment — then the smallest list of what remains. Fix a value inline and the pack regenerates.')}

      ${!model.ready && !model.error ? `<div class="build-note">${model.pending ? 'Compiling…' : 'Nothing compiled yet — go back to Compile.'}</div>` : ''}
      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'below, under its todo' })}

      ${model.ready && d ? decisionHeaderHtml({
        id: 'build-verify-decision', eyebrow: 'Verify · readiness', context: model.context,
        decision: d.sentence, verdict: d.word, tone: d.tone,
        note: d.note || (handoffIsPrimary ? model.readyText : ''),
        primary: next.primary, secondary: next.secondary, measures,
      }) : ''}

      ${model.ready ? remainsHtml(model) : ''}
      ${model.ready ? rubricDetailHtml(model) : ''}

      ${model.ready ? `
      <div class="build-todos build-stack-wrap" id="build-verify-stack">
        <div class="build-section-key">The pack, layer by layer — with its todos <span class="build-count">${model.todoCount}</span>
          <span class="build-section-sub">each todo sits on the slab of the artefact it names, with the values that fill it — ${plural(model.placeholdersRemaining, 'placeholder value')} still at the default. Fill one inline (Enter or leave the field) and the pack regenerates; a filled todo disappears and its card stops being Scaffold. Click a layer for its clauses, its options as compiled and its todos on one sheet.</span>
        </div>
        ${model.todoCount ? '' : '<div class="build-note build-note-ok">No todos: every placeholder is filled and the scaffold has nothing left to hand over.</div>'}
        ${buildStackHtml(stack)}
      </div>

      <div class="build-artifacts">
        <div class="build-section-key">Artefacts <span class="build-section-sub">what the pack compiles to today, through the same targets Remediate deploys — previewed from the generated canonical, nothing registered</span></div>
        <div class="build-artifact-grid">
          ${model.artifacts.map(a => `
            <div class="build-artifact${model.preview?.target === a.id ? ' is-open' : ''}" data-target="${escapeHtml(a.id)}">
              <div class="build-artifact-label">${escapeHtml(a.label)}</div>
              <div class="build-artifact-desc">${escapeHtml(a.description)}</div>
              <div class="build-artifact-actions">
                <button type="button" class="ctrl-btn" data-act="preview" aria-label="preview ${escapeHtml(a.label)}">${model.preview?.target === a.id ? 'previewing' : 'preview'}</button>
                <button type="button" class="ctrl-btn" data-act="download" aria-label="download ${escapeHtml(a.label)}">download</button>
              </div>
            </div>`).join('')}
        </div>
        ${model.preview ? `
          <div class="build-preview">
            <div class="build-preview-head">
              <span class="build-preview-name">${escapeHtml(model.preview.label)} · <code>${escapeHtml(model.preview.filename)}</code>${model.preview.profile ? ` · ${escapeHtml(model.preview.profile.label || `${model.preview.profile.product} ${model.preview.profile.version}`)}` : ''}</span>
              <span class="build-preview-actions"><button type="button" class="ctrl-btn" id="build-preview-download">download</button><button type="button" class="ctrl-btn" id="build-preview-close">close</button></span>
            </div>
            ${model.preview.error ? `<div class="build-note build-note-err">${escapeHtml(model.preview.error)}</div>` : ''}
            ${(model.preview.warnings || []).length ? `<div class="build-note build-note-warn">${model.preview.warnings.length} compile warning${model.preview.warnings.length === 1 ? '' : 's'}: ${model.preview.warnings.slice(0, 3).map(w => escapeHtml(w)).join(' · ')}${model.preview.warnings.length > 3 ? ' …' : ''}</div>` : ''}
            ${model.preview.content != null ? `<pre class="crawl-result-yaml build-yaml-pre">${escapeHtml(model.preview.content)}</pre>` : ''}
          </div>` : ''}
      </div>

      <footer class="build-step-actions bres-handoff">
        <span class="build-actions-left">
          <button type="button" class="ctrl-btn build-back" id="build-back">← Compile</button>
          <button type="button" class="ctrl-btn build-adjust" id="build-adjust" title="Back to Define — change the service, its tier or the library entries">Resolve or adjust</button>
        </span>
        <span class="build-step-status">${({
          registered: `Registered as <code>${escapeHtml(model.registeredId || '')}</code> — opening it again re-registers the current pack.`,
          ready: escapeHtml(model.readyText),
          error: 'The last compilation failed — fix the rejected value above; the pack shown is the previous one and is not handed off.',
          promql: 'A PromQL warning blocks the hand-off — fix it first.',
          schema: 'The pack does not validate against the schema — see what blocks the hand-off above.',
        })[model.handoff]}</span>
        <span class="build-actions-right">
          <button type="button" class="ctrl-btn" id="build-yaml-download">download pack yaml</button>
          <button type="button" class="${handoffIsPrimary ? 'mcp-refresh-btn build-next' : 'ctrl-btn build-next-secondary'}" id="build-open" ${model.canRegister ? '' : 'disabled'}>${escapeHtml(model.continueLabel)} <span aria-hidden="true">→</span></button>
        </span>
      </footer>` : ''}
    </section>`;

  wireBuildStack(container, stack, host);
  container.querySelectorAll('.build-artifact').forEach(card => {
    const target = card.dataset.target;
    card.querySelector('[data-act="preview"]').addEventListener('click', () => act.preview(target));
    card.querySelector('[data-act="download"]').addEventListener('click', () => act.downloadArtifact(target));
  });
  container.querySelector('#build-preview-download')?.addEventListener('click', () => {
    const p = model.preview;
    if (p?.content != null) downloadText(p.filename, p.content, p.contentType || 'text/plain');
  });
  container.querySelector('#build-preview-close')?.addEventListener('click', () => act.update({ preview: null }, { rerender: true, reinstantiate: false }));
  container.querySelector('#build-yaml-download')?.addEventListener('click', () => downloadText(model.fileName, model.yaml, 'application/x-yaml'));
  container.querySelector('#build-back')?.addEventListener('click', () => act.setStep('compile'));
  container.querySelector('#build-adjust')?.addEventListener('click', () => act.setStep('define'));
  container.querySelector('#build-open')?.addEventListener('click', () => act.openInDiscover());
  wireRemains(container, model, act);
  announceResult(model);
}

// ---------- wiring ----------

/** Scroll to a todo on this step's stack and land the caret in its input for `paramKey` (else its first input). */
function revealOnStack(container, { todo = null, paramKey = null } = {}) {
  const esc = (s) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : String(s).replace(/["\\]/g, '\\$&'));
  const row = paramKey ? container.querySelector(`#build-verify-stack .build-todo .build-param[data-param="${esc(paramKey)}"]`) : null;
  const el = row?.closest?.('[data-todo]') || (todo ? container.querySelector(`#build-verify-stack [data-todo="${esc(todo)}"]`) : null);
  if (!el || !revealTodo(el)) return false;
  row?.querySelector?.('.build-param-input')?.focus({ preventScroll: true });
  return true;
}

function wireRemains(container, model, act) {
  const root = container.querySelector('.build-verify');
  if (!root || typeof root.addEventListener !== 'function') return;
  const rm = model.remains;
  const items = new Map();
  if (rm) {
    for (const i of [...rm.blocking, ...rm.warnings, ...rm.accepted]) items.set(i.key, { type: 'warning', item: i });
    for (const c of rm.clauses) items.set(c.key, { type: 'clause', item: c });
    for (const c of rm.failing || []) items.set(c.key, { type: 'failing', item: c });
    for (const g of rm.values.groups) for (const v of g.items) items.set(`value:${v.key}`, { type: 'value', item: v });
    for (const t of rm.manual) items.set(t.key, { type: 'todo', item: t });
  }
  // A warning is fixed where it can be edited: COMPILE (VERIFY's editor and sheets are read-only). The layer it
  // lands on is selected there first, so the slab head that focus returns to on close is drawn.
  const fixOnCompile = (fix) => {
    act.update?.({ compileView: [fix.layer || 'L1'] }, { reinstantiate: false });
    if (fix.kind === 'editor') { act.setStep('compile'); act.openEditor?.({ key: fix.key, custom: fix.custom, focus: fix.focus || null }); }
    else act.setStep('compile', { sheet: fix.layer || 'L1' });
  };
  const fix = (key) => {
    const hit = items.get(key);
    if (!hit) return;
    const { type, item } = hit;
    if (type === 'warning') { fixOnCompile(item.fix); return; }
    if (type === 'failing') { fixOnCompile({ kind: 'sheet', layer: item.layer }); return; }
    const ok = type === 'value' ? revealOnStack(container, { paramKey: item.key, todo: item.todos[0] })
      : type === 'clause' ? item.todos.some(t => revealOnStack(container, { todo: t }))
        : revealOnStack(container, { todo: item.path });
    if (!ok) act.openSheet?.(item.layer);
  };
  const firstValue = () => rm?.values?.groups?.[0]?.items?.[0];
  const acceptedMap = () => ({ ...(model.acceptedMap || {}) });
  const reasonInput = () => root.querySelector('.bres-accept-input');
  const save = (key) => {
    const input = reasonInput();
    const reason = String(input?.value || '').trim();
    if (!reason) { input?.setAttribute('aria-invalid', 'true'); input?.focus(); return; }
    act.update({ accepted: { ...acceptedMap(), [key]: { reason, at: new Date().toISOString() } }, accepting: null, acceptDraft: null }, { rerender: true, reinstantiate: false });
    announce(`Warning accepted for this session: ${reason}`);
  };
  wireUxActions(root, {
    fix: (_e, el) => fix(el.dataset.key),
    'complete-values': () => { const v = firstValue(); if (v) fix(`value:${v.key}`); },
    'fix-first': () => {
      // A rejected value is marked on its row under its todo; otherwise the first item that blocks the hand-off.
      const rejected = root.querySelector('#build-verify-stack .build-param.is-error .build-param-input');
      if (rejected) { revealTodo(rejected.closest('[data-todo]')); rejected.focus({ preventScroll: true }); return; }
      const first = rm?.blocking?.[0];
      if (first) fix(first.key);
    },
    'resolve-failing': () => {
      const failing = (model.checklist?.items || []).find(i => i.state === 'fail');
      fixOnCompile({ kind: 'sheet', layer: failing?.dimension || 'L1' });
    },
    'open-discover': () => act.openInDiscover(),
    'accept-open': (_e, el) => act.update({ accepting: el.dataset.key, acceptDraft: { key: el.dataset.key, text: '' } }, { rerender: true, reinstantiate: false, focus: 'accept:reason' }),
    'accept-cancel': () => act.update({ accepting: null, acceptDraft: null }, { rerender: true, reinstantiate: false }),
    'accept-save': (_e, el) => save(el.dataset.key),
    'accept-undo': (_e, el) => {
      const next = acceptedMap();
      delete next[el.dataset.key];
      act.update({ accepted: next }, { rerender: true, reinstantiate: false });
      announce('Acceptance undone — the warning is back on the list.');
    },
  });
  const form = root.querySelector('[data-accept-form]');
  if (form) {
    form.addEventListener('submit', (e) => { e.preventDefault(); save(model.accepting); });
    // The reason is kept on the draft as it is typed, so a re-render (the pack answering) does not lose it.
    reasonInput()?.addEventListener('input', (e) => act.update({ acceptDraft: { key: model.accepting, text: e.target.value } }, { reinstantiate: false }));
  }
}
