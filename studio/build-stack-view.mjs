// studio/build-stack-view.mjs
//
// The layer stack of the pack being compiled — centre stage on the three
// BUILD steps (docs/BUILD_JOURNEY.md "The scan"). Draws buildStackModel's
// slabs in Discover's language: the same .section / .section-head /
// .section-grid / .card markup, the same layer tokens (--L1 … --GOV through
// .section[data-layer]), the card body from the shared card-html helper —
// so what Build shows is what Discover will show for the same pack. Each
// slab's left edge carries the rubric's verdict for its dimension (green
// pass, amber pass on a placeholder, red fail, neutral when no clause
// applies, grey while pending); a click on the slab head — or its '+' —
// opens the layer's sheet (build-sheet-view.mjs: the clauses, and what you
// can add on that layer). A ghost card is a clause of the tier (the silhouette on DEFINE,
// an unmet clause afterwards) or an SLI / SLO candidate; a Scaffold artefact
// is dashed as Discover parks it; the detail artefacts Discover folds
// (panels, queries) fold here too. On VERIFY the todos sit on their slab
// with their inline param inputs, and a card that a todo names carries a pin.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host).
// host.build.openSheet opens a layer's sheet; host.build.update keeps which
// detail folds are open (in the draft, never persisted); host.build.setParam
// commits a filled placeholder.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { artefactCardHtml } from './card-html.mjs';
import { todoFocusSuffix, LAYER_QUESTIONS } from './build-model.mjs';
import { evidenceBadge, todoHtml, wireParamInputs, revealTodo, STATE_GLYPH, STATE_WORD } from './build-atoms.mjs';

const SOURCE_TITLE = {
  Required: 'required by the tier — the pack does not exist yet',
  Missing: 'required by the tier, not present in the pack as toggled',
  Candidate: 'an SLI of the selection at this tier, with the SLO it gets — ticked on Compile',
};
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** A ghost card: a clause the tier requires (its severity as the id, the rubric's description) or an SLI / SLO candidate. */
export function ghostCardHtml(g) {
  const state = g.state && g.state !== 'pending' ? g.state : null;
  const glyph = state ? `<span class="build-ghost-state is-${state}" title="${escapeHtml(STATE_WORD[state])}">${STATE_GLYPH[state]}</span>` : '';
  const tags = (g.tags || []).slice(0, 4).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('');
  const title = g.kind === 'clause' ? `${g.clauseId} — ${STATE_WORD[g.state] || 'required'}` : (SOURCE_TITLE[g.source] || '');
  return `
    <div class="card card-ghost is-${escapeHtml(g.kind)}${state ? ` is-${state}` : ''}" data-ghost="${escapeHtml(g.key)}" title="${escapeHtml(title)}">
      <div class="card-head">
        <span class="card-id">${escapeHtml(g.kind === 'clause' ? g.severity : g.kind.toUpperCase())}</span>
        ${glyph}
        <span class="card-source" data-source="${escapeHtml(g.source)}">${escapeHtml(g.source)}</span>
      </div>
      <div class="card-title">${escapeHtml(g.title)}</div>
      ${g.desc ? `<div class="card-desc">${escapeHtml(g.desc)}</div>` : ''}
      <div class="card-foot">
        ${g.tool ? `<span class="tool">${escapeHtml(g.tool)}</span>` : ''}
        ${tags}
        ${g.evidence ? evidenceBadge(g.evidence) : ''}
      </div>
    </div>`;
}

/**
 * A real artefact: Discover's card body, Scaffold dashed, a pin when a todo names it, folded
 * when it is detail. The todos are drawn on VERIFY only, so elsewhere the pin is a jump
 * (data-jump) to that step, where its todo is.
 */
function artefactCardHtmlInStack(a, mode) {
  const cls = ['card', a.source === 'Scaffold' ? 'is-scaffold' : '', a.todoPath ? 'has-todo' : '', a.detail ? 'is-detail' : ''].filter(Boolean).join(' ');
  const jump = mode !== 'verify';
  return `
    <div class="${cls}" data-artefact="${escapeHtml(a.id)}"${a.symbol ? ` data-symbol="${escapeHtml(a.symbol)}"` : ''}>
      ${artefactCardHtml(a)}
      ${a.todoPath ? `<button type="button" class="build-card-pin" data-todo-path="${escapeHtml(a.todoPath)}"${jump ? ' data-jump="verify"' : ''} title="${escapeHtml(`todo: ${a.todoPath} — a placeholder value the team must fill${jump ? ', on Verify' : ''}`)}">todo</button>` : ''}
    </div>`;
}

function gridHtml(artefacts, ghosts, mode, { l4 = false } = {}) {
  if (!artefacts.length && !ghosts.length) return '';
  return `<div class="section-grid${l4 ? ' section-grid-l4' : ''}">${artefacts.map(a => artefactCardHtmlInStack(a, mode)).join('')}${ghosts.map(ghostCardHtml).join('')}</div>`;
}

// The inputs' focus keys are slab + todo path, so a survivor keeps its key when a filled todo disappears.
function todosHtml(slab, todos) {
  if (!todos.length) return '';
  return `
    <div class="build-slab-todos">
      <div class="build-slab-todos-head">${plural(todos.length, 'todo')} on this layer <span>placeholders and scaffold defaults only the team can fill — fill one inline and the pack regenerates</span></div>
      <ul class="build-todo-list">${todos.map(t => todoHtml(t, todoFocusSuffix(slab.id, t.path))).join('')}</ul>
    </div>`;
}

function emptyText(slab, mode) {
  if (mode === 'define') return slab.clauses.length ? '' : 'no clause of the tier applies to this layer — nothing to build here';
  if (!slab.counts.clauses) return slab.id === 'GOV' ? 'no governance artefact (imports) — no clause applies' : 'nothing declared — no clause applies';
  if (slab.state === 'pending') return 'not yet acquired — waiting for the first compilation';
  return `nothing declared — ${plural(slab.counts.clauses, 'clause')} pass${slab.counts.clauses === 1 ? 'es' : ''} with nothing to check`;
}

function countLabel(slab, mode) {
  if (mode === 'define') {
    const cl = plural(slab.counts.clauses, 'clause');
    const cand = slab.ghosts.filter(g => g.kind !== 'clause').length;
    return cand ? `${cl} · ${plural(cand, 'candidate')}` : cl;
  }
  const parts = [plural(slab.counts.artefacts, 'artefact')];
  if (slab.counts.scaffold) parts.push(`${slab.counts.scaffold} scaffold`);
  if (slab.counts.ghosts) parts.push(`${slab.counts.ghosts} missing`);
  if (slab.counts.todos) parts.push(plural(slab.counts.todos, 'todo'));
  return parts.join(' · ');
}

function slabHtml(slab, mode) {
  const visible = (items) => items.filter(a => !a.detail || slab.detailOpen);
  let body;
  if (slab.subgroups) {
    body = slab.subgroups.map(sg => `
      <div class="build-slab-sub subgroup${sg.offSections.length ? ' is-off' : ''}" data-subgroup="${escapeHtml(sg.key)}">
        <h4 class="subgroup-head">L4.${escapeHtml(sg.key)} · ${escapeHtml(sg.label)}${sg.offSections.length ? ` <span class="build-slab-off">${sg.offSections.map(s => `${escapeHtml(s)} off`).join(' · ')}</span>` : ''}</h4>
        ${gridHtml(visible(sg.artefacts), sg.ghosts, mode, { l4: true }) || `<div class="empty">${mode === 'define' ? (sg.ghosts.length ? '' : `no ${escapeHtml(sg.label.toLowerCase())} clause at this tier`) : `no ${escapeHtml(sg.label.toLowerCase())} declared`}</div>`}
        ${mode === 'verify' ? todosHtml(slab, sg.todos) : ''}
      </div>`).join('');
  } else {
    const grid = gridHtml(visible(slab.artefacts), slab.ghosts, mode);
    const empty = emptyText(slab, mode);
    body = grid || (empty ? `<div class="empty">${escapeHtml(empty)}</div>` : '');
    if (mode === 'verify') body += todosHtml(slab, slab.todos);
  }
  const detail = slab.counts.detail
    ? `<button type="button" class="section-expand-toggle build-slab-detail${slab.detailOpen ? ' is-on' : ''}" data-detail="${escapeHtml(slab.id)}" title="the detail artefacts Discover folds behind Expand — panels, queries, live evidence"><span class="section-expand-glyph" aria-hidden="true">${slab.detailOpen ? '⊟' : '⊞'}</span> ${slab.detailOpen ? 'Hide' : 'Expand'} detail <span class="section-expand-count">${slab.counts.detail}</span></button>`
    : '';
  // The head opens the layer's sheet: the clauses at the tier and what you can add on this layer.
  const question = LAYER_QUESTIONS[slab.id] || '';
  const sheetTitle = `${slab.num} · ${slab.name} — ${question}`;
  return `
    <section class="section build-slab is-${slab.state}${slab.dimmed ? ' is-dimmed' : ''}${slab.present || slab.ghosts.length ? '' : ' is-empty'}${slab.expanded ? ' is-expanded' : ''}" data-layer="${escapeHtml(slab.id)}">
      <div class="section-head build-slab-head">
        <button type="button" class="build-slab-edge" data-slab="${escapeHtml(slab.id)}" aria-haspopup="dialog" aria-expanded="${slab.expanded ? 'true' : 'false'}" title="${escapeHtml(`${slab.why.length ? slab.why.join('\n') : `${slab.num} ${slab.name}: ${slab.stateText}`}\nOpen: ${question}`)}">
          <span class="section-num">${escapeHtml(slab.num)}</span>
          <span class="section-name">${escapeHtml(slab.name)}</span>
          <span class="build-slab-verdict is-${slab.state}"><b aria-hidden="true">${STATE_GLYPH[slab.state]}</b> ${escapeHtml(slab.stateText)}</span>
          ${slab.offSections.length && !slab.subgroups ? `<span class="build-slab-off">${slab.offSections.map(s => `${escapeHtml(s)} off`).join(' · ')}</span>` : ''}
          <span class="build-slab-toggle">${escapeHtml(question)}</span>
        </button>
        ${detail}
        <span class="section-count">${escapeHtml(countLabel(slab, mode))}</span>
        <button type="button" class="build-slab-add" data-slab="${escapeHtml(slab.id)}" aria-haspopup="dialog" aria-expanded="${slab.expanded ? 'true' : 'false'}" aria-label="${escapeHtml(`Open ${sheetTitle}`)}" title="${escapeHtml(sheetTitle)}"><span aria-hidden="true">+</span></button>
      </div>
      ${body}
    </section>`;
}

/** The stack as HTML — what a step template embeds; wireBuildStack(container, model, host) wires it once in the DOM. */
export function buildStackHtml(model) {
  return `<div class="build-stack" data-mode="${escapeHtml(model.mode)}">${model.slabs.map(s => slabHtml(s, model.mode)).join('')}</div>`;
}

/**
 * render(container, model, host) — the stack on its own. `model` is
 * buildStackModel's output; host.build.update / setParam are the only actions it calls.
 */
export function renderBuildStack(container, model, host = appHost) {
  container.innerHTML = buildStackHtml(model);
  wireBuildStack(container, model, host);
}

/** The stack's handlers: the slab heads and '+' (the layer's sheet), the detail toggles, the todo pins, the param inputs. */
export function wireBuildStack(container, model, host = appHost) {
  const act = host.build;

  // A slab head (or its '+') opens the layer's sheet; the controller keeps which layer is
  // open on the draft (never persisted) and moves focus into the sheet and back.
  container.querySelectorAll('.build-slab-edge, .build-slab-add').forEach(btn => btn.addEventListener('click', () => act?.openSheet?.(btn.dataset.slab)));
  // The open detail folds live in the draft (never persisted).
  const openMap = () => Object.fromEntries(model.slabs.flatMap(s => (s.detailOpen ? [[`${s.id}/detail`, true]] : [])));
  container.querySelectorAll('.build-slab-detail').forEach(btn => btn.addEventListener('click', () => {
    const slab = model.slabs.find(s => s.id === btn.dataset.detail);
    if (!slab) return;
    slab.detailOpen = !slab.detailOpen;
    act?.update?.({ stackOpen: openMap() }, { rerender: true, reinstantiate: false });
  }));
  // A pin reveals its todo on this step; where the todos are not drawn (COMPILE) it
  // asks the controller for the step that has them, which reveals the todo after the render.
  container.querySelectorAll('.build-card-pin').forEach(pin => pin.addEventListener('click', (e) => {
    e.stopPropagation();
    const path = pin.dataset.todoPath;
    const todo = container.querySelector(`[data-todo="${CSS.escape(path)}"]`);
    if (todo) revealTodo(todo);
    else if (pin.dataset.jump) act?.setStep?.(pin.dataset.jump, { todo: path });
  }));
  // Only the stack's own inputs: a step that wires its parameter section itself must not see them wired twice.
  if (act) wireParamInputs(container, act, '.build-stack .build-param-input');
}
