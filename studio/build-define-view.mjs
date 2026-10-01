// studio/build-define-view.mjs
//
// BUILD step 1 — DEFINE, "What are we building for?", in four short visible
// substeps (the 2026-09 UX review, "Build / Define": the first screen asked
// for everything at once and opened by teaching the engine's mechanics):
//
//   1 Service             name, owners, environment
//   2 Criticality         the tier as three radio cards, each with what it asks
//                         of the pack in plain words (read from the rubric)
//   3 Technology          the products and archetypes as cards — "Adds N
//                         suggested SLIs", with a preview of their names
//                         before one is picked
//   4 Review suggestions  the proposed SLIs grouped by technology, individual
//                         checkboxes and "Select recommended", then "Why these
//                         suggestions?" (the tier's rubric clauses) and
//                         "Advanced review" (the silhouette: the layer stack
//                         with one ghost card per clause and the SLI / SLO
//                         candidates on L1 — a click on a slab opens its live
//                         sheet, a candidate card the SLI's editor)
//
// A substep indicator at the top (and the progress summary in the column,
// build-definition-view.mjs) moves between them; the draft remembers the one
// shown (`defineSub`, UI state, never persisted) and the data behind them is
// the draft's as before. DEFINE is the seeding step (docs/BUILD_JOURNEY.md
// "The seed and the copies"): its primary action is "Seed the pack →"
// (host.build.seed: seeded, persisted, on to COMPILE), "Continue to Compile →"
// once seeded. Also home to the step head and the compilation-error note the
// three steps share.
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with the model from build-model.mjs's buildDefineModel and the host the
// controller in app.mjs passes — host.build.* are the actions (update,
// setTier, toggleEntry, setSli, openEditor, seed; openSheet through the
// stack); no state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { BUILD_STEPS, MAX_SERVICE_SLUG } from './build-model.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';
import { evidenceDot } from './build-atoms.mjs';
import { wireBuildDefinition } from './build-definition-view.mjs';
import { termHtml } from './ux-kit.mjs';

const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// The atoms the three steps share live in build-atoms.mjs (the stack view draws
// them too); re-exported here so a step view keeps one import for them.
export { evidenceBadge, paramRowHtml, wireParamInputs } from './build-atoms.mjs';

export function stepHeadHtml(step, title, lede) {
  const n = BUILD_STEPS.indexOf(step) + 1;
  return `
    <header class="build-step-head">
      <div class="build-eyebrow">build · step ${n} of ${BUILD_STEPS.length} · ${escapeHtml(step)}</div>
      <h2 class="build-title">${escapeHtml(title)}</h2>
      <p class="build-lede">${lede}</p>
    </header>`;
}

/** The rejected copies of the last instantiation, as `<sli>.<field>` (a custom SLI's whole-SLI error as `<id>`). */
export function rejectedCopies(error) {
  // byCustom[''] holds the '+ Custom SLI' form's own errors (`custom[i]…`): the form shows them, no card does.
  const list = (map, prefix) => Object.entries(map || {}).filter(([sli]) => sli).flatMap(([sli, fields]) => Object.keys(fields || {}).map(f => `${prefix}${sli}${f ? `.${f}` : ''}`));
  return [...list(error?.byOverride, ''), ...list(error?.byCustom, 'custom ')];
}

/**
 * The last instantiation's usage errors as one note: the general ones spelled out, the rejected params counted
 * (their rows carry the reason), the rejected customised values named with the card to open — a closed face or
 * sheet showed only "the last compilation failed" and the user had to guess which card to Customise.
 */
export function instantiateErrorHtml(error, { stale = false, where = 'below' } = {}) {
  if (!error) return '';
  const parts = [...error.general.map(escapeHtml)];
  if (error.paramCount) parts.push(`${error.paramCount} parameter value${error.paramCount === 1 ? '' : 's'} rejected — marked on ${error.paramCount === 1 ? 'its row' : 'their rows'} ${where}`);
  const copies = rejectedCopies(error);
  if (copies.length) parts.push(`${copies.length} customised value${copies.length === 1 ? '' : 's'} rejected — ${escapeHtml(copies.join(', '))}: open ${copies.length === 1 ? 'its card' : 'their cards'} on L1 (the stack or the sheet), the field carries the reason`);
  return `<div class="build-note build-note-err" role="alert"><strong>The last compilation failed${stale ? ' — the pack shown is the previous one' : ''}.</strong> ${parts.join(' · ')}</div>`;
}

// ---------- the substep indicator ----------

/** The four substeps as a list of buttons at the top of the step: number (a tick once done), name, the current one aria-current="step". */
export function substepsHtml(model) {
  return `
      <nav class="bd-substeps" aria-label="Define in four steps">
        <ol class="bd-substeps-list">${model.substeps.map(s => `
          <li class="bd-substep is-${escapeHtml(s.status)}${s.complete && s.status !== 'complete' ? ' is-complete' : ''}">
            <button type="button" class="bd-substep-btn" data-define-sub="${escapeHtml(s.id)}" data-focus-key="${escapeHtml(s.focusKey)}"${s.current ? ' aria-current="step"' : ''}>
              <span class="bd-substep-n" aria-hidden="true">${s.complete && !s.current ? '✓' : s.n}</span>
              <span class="bd-substep-label">${escapeHtml(s.label)}</span>
              <span class="sr-text">${s.current ? ' — current step' : s.complete ? ' — done' : ' — needs input'}</span>
            </button>
          </li>`).join('')}
        </ol>
      </nav>`;
}

/** A panel's shell: its heading (the focus lands on it when the substep changes), its lede, its body, Back / Continue. */
function panelHtml(model, id, lede, body) {
  const i = model.substeps.findIndex(s => s.id === id);
  const s = model.substeps[i];
  const prev = model.substeps[i - 1] || null;
  const next = model.substeps[i + 1] || null;
  return `
      <section class="bd-panel" id="bd-panel-${escapeHtml(id)}" data-panel="${escapeHtml(id)}" aria-labelledby="bd-h-${escapeHtml(id)}"${s.current ? '' : ' hidden'}>
        <h3 class="bd-panel-title" id="bd-h-${escapeHtml(id)}" tabindex="-1" data-focus-key="dpanel:${escapeHtml(id)}"><span class="bd-panel-n">${s.n}</span> ${escapeHtml(s.question)}</h3>
        <p class="bd-panel-lede">${lede}</p>
        ${body}
        <div class="bd-panel-nav">
          ${prev ? `<button type="button" class="ux-secondary-btn" data-define-sub="${escapeHtml(prev.id)}"><span aria-hidden="true">←</span> Back to ${escapeHtml(prev.label)}</button>` : ''}
          ${next ? `<button type="button" class="ux-primary-btn" data-define-sub="${escapeHtml(next.id)}">Continue to ${escapeHtml(next.label)} <span aria-hidden="true">→</span></button>` : ''}
        </div>
      </section>`;
}

// ---------- 1 · Service ----------

function servicePanelHtml(model) {
  return panelHtml(model, 'service', 'Name the service, say who owns it and where it runs.', `
        <div class="bd-fields">
          <label class="build-def-field">
            <span class="build-def-label">Name</span>
            <input id="build-name" type="text" data-focus-key="name" value="${escapeHtml(model.name)}" placeholder="orders-api" autocomplete="off" spellcheck="false" aria-describedby="build-name-hint">
            <span class="build-def-hint" id="build-name-hint">${model.name && model.slug !== model.name ? `becomes <code>${escapeHtml(model.slug)}</code>` : `The pack’s name and metric prefix — up to ${MAX_SERVICE_SLUG} characters`}</span>
          </label>
          <label class="build-def-field">
            <span class="build-def-label">Owners</span>
            <input id="build-owners" type="text" data-focus-key="owners" value="${escapeHtml(model.owners)}" placeholder="team-orders, sre-platform" autocomplete="off" spellcheck="false" aria-describedby="build-owners-hint">
            <span class="build-def-hint" id="build-owners-hint">${model.ownerList.length ? plural(model.ownerList.length, 'owner') : 'Teams, comma-separated — you can leave it for later'}</span>
          </label>
          <label class="build-def-field">
            <span class="build-def-label">Environment</span>
            <input id="build-env" type="text" data-focus-key="environment" list="build-env-options" value="${escapeHtml(model.environment)}" placeholder="prod" autocomplete="off" spellcheck="false" aria-describedby="build-env-hint">
            <datalist id="build-env-options"><option value="prod"></option><option value="staging"></option><option value="dev"></option><option value="eks"></option><option value="local-docker"></option></datalist>
            <span class="build-def-hint" id="build-env-hint">Where it runs, e.g. prod or staging</span>
          </label>
        </div>`);
}

// ---------- 2 · Criticality ----------

/**
 * One tier as a radio card (a role=radio button in the tier radiogroup — the arrow keys move, wireBuildDefinition):
 * its name and word, its MUST · SHOULD counts, and what it asks of the pack, row by row, read from the rubric.
 */
export function tierCardHtml(t) {
  const counts = t.must == null ? '<b>…</b>' : `<b>${t.must} MUST</b>${t.should ? `<b>${t.should} SHOULD</b>` : ''}`;
  const c = t.consequences || { rows: [], sentence: t.blurb || '' };
  const rows = c.rows.length
    ? c.rows.map(r => `<span class="bd-tier-row"><span class="bd-tier-key">${escapeHtml(r.label)}</span><span class="bd-tier-val">${escapeHtml(r.text || '—')}${r.recommended ? ` <span class="bd-tier-rec">· recommended: ${escapeHtml(r.recommended)}</span>` : ''}</span></span>`).join('')
    : `<span class="bd-tier-row"><span class="bd-tier-val">${escapeHtml(c.sentence)}</span></span>`;
  const id = escapeHtml(t.id);
  return `
          <button type="button" role="radio" class="build-seg-btn bd-tier" data-tier="${id}" aria-checked="${t.selected ? 'true' : 'false'}" tabindex="${t.selected ? '0' : '-1'}" data-focus-key="tier:${id}"
                  aria-label="${escapeHtml(`${t.label}, ${t.word}`)}" aria-describedby="bd-tier-${id}-counts bd-tier-${id}-what">
            <span class="bd-tier-head"><span class="build-seg-name">${id}</span><span class="bd-tier-word">${escapeHtml(t.word)}</span></span>
            <span class="build-seg-counts" id="bd-tier-${id}-counts" aria-label="${escapeHtml(t.must == null ? 'loading the requirements' : `${t.must} MUST${t.should ? `, ${t.should} SHOULD` : ''}`)}">${counts}</span>
            <span class="bd-tier-what" id="bd-tier-${id}-what">${rows}</span>
          </button>`;
}

function criticalityPanelHtml(model) {
  return panelHtml(model, 'criticality', `Each ${termHtml('tier', 'tier')} says what the pack must include. Pick the one that matches the harm an outage would do.`, `
        <div class="bd-tiers" role="radiogroup" aria-label="Criticality tier">${model.tiers.map(tierCardHtml).join('')}
        </div>`);
}

// ---------- 3 · Technology ----------

/**
 * One library entry as a card: the toggle (aria-pressed; title, evidence, what it is, "Adds N suggested SLIs", the
 * placeholder params the team fills later) and, beside it, a preview of the SLIs it adds at the tier — named, before
 * it is picked. The preview is a fold the draft remembers (`preview:<id>`).
 */
export function entryCardHtml(c, folds = {}) {
  const n = c.suggested?.length ?? c.sliCountAtTier;
  const id = escapeHtml(c.id);
  const preview = (c.suggested || []).length || c.optional
    ? `<details class="bd-entry-preview" data-define-fold="preview:${id}"${folds[`preview:${c.id}`] ? ' open' : ''}>
              <summary>Preview ${n === 1 ? 'the SLI' : `the ${n} SLIs`}</summary>
              <ul class="bd-entry-slis">${(c.suggested || []).map(s => `<li>${escapeHtml(s.name)} <span class="bd-entry-sli-type">${escapeHtml(s.type)}</span></li>`).join('')}</ul>
              ${c.optional ? `<p class="bd-entry-optional">+ ${plural(c.optional, 'more SLI')} from a higher tier, optional</p>` : ''}
            </details>`
    : '';
  return `
          <div class="bd-entry${c.selected ? ' is-selected' : ''}">
            <button type="button" class="build-chip${c.selected ? ' is-selected' : ''}" data-entry="${id}" aria-pressed="${c.selected ? 'true' : 'false'}" data-focus-key="entry:${id}" aria-describedby="bd-entry-${id}-adds"
                    title="${escapeHtml(`${c.title} — ${c.summary || ''}${c.gaps ? ` · ${plural(c.gaps, 'evidence gap')}` : ''}`)}">
              <span class="build-chip-top">
                <span class="build-chip-title">${escapeHtml(c.title)}</span>
                ${evidenceDot(c.evidence.status, c.evidence.verifiedOn)}
              </span>
              ${c.summary ? `<span class="bd-entry-sum">${escapeHtml(c.summary)}</span>` : ''}
              <span class="build-chip-meta">
                <span class="build-chip-slis" id="bd-entry-${id}-adds">Adds ${plural(n, 'suggested SLI')}</span>
                ${c.placeholderParams ? `<span class="build-chip-ph" title="values the library cannot know — the team fills them later; each left at its default is a todo">${plural(c.placeholderParams, 'value')} to fill</span>` : ''}
              </span>
            </button>
            ${preview}
          </div>`;
}

function technologyPanelHtml(model) {
  const f = model.folds || {};
  return panelHtml(model, 'technology', 'Pick what the service runs on. Each pick adds the SLIs it can measure; several compose into one pack.', `
        <h4 class="build-chip-kind">Products <span>what the service runs on</span></h4>
        <div class="bd-entries" role="group" aria-label="Products">${model.products.map(c => entryCardHtml(c, f)).join('')}
        </div>
        <h4 class="build-chip-kind">Archetypes <span>for a service built from scratch</span></h4>
        <div class="bd-entries" role="group" aria-label="Archetypes">${model.archetypes.map(c => entryCardHtml(c, f)).join('')}
        </div>
        ${model.libraryErrors.length ? `<div class="build-note build-note-warn">${plural(model.libraryErrors.length, 'library file')} did not load: ${model.libraryErrors.map(e => `<code>${escapeHtml(e.file)}</code>`).join(', ')}</div>` : ''}`);
}

// ---------- 4 · Review suggestions ----------

/** One proposed SLI: its checkbox and name, recommended or optional, the bound / objective line, Edit. */
function suggestionHtml(it) {
  const key = escapeHtml(it.key);
  const tag = it.recommended ? '<span class="bd-tag is-rec">Recommended</span>' : `<span class="bd-tag" title="its own tier is ${escapeHtml(it.profileTier)}: optional here, it starts from that tier’s objective">Optional · ${escapeHtml(it.profileTier)}</span>`;
  return `
            <li class="bd-sugg${it.checked ? ' is-on' : ''}">
              <input type="checkbox" class="bd-sugg-box" id="bd-sugg-${key}" data-sugg-sli="${key}" data-focus-key="${escapeHtml(it.focusKey)}"${it.checked ? ' checked' : ''} aria-describedby="bd-sugg-${key}-meta">
              <label class="bd-sugg-label" for="bd-sugg-${key}"><span class="bd-sugg-name">${escapeHtml(it.name)}</span>${tag}${it.customised ? '<span class="bd-tag is-edited">Edited</span>' : ''}</label>
              <span class="bd-sugg-meta" id="bd-sugg-${key}-meta">${escapeHtml(it.meta)}</span>
              <button type="button" class="ux-link-btn bd-sugg-edit" data-sugg-edit="${key}" data-focus-key="sugg-edit:${key}" aria-haspopup="dialog" aria-label="${escapeHtml(`Edit ${it.name}`)}">Edit</button>
            </li>`;
}

function suggestionGroupHtml(g) {
  return `
          <fieldset class="bd-sugg-group">
            <legend class="bd-sugg-legend">${escapeHtml(g.title)} <span class="bd-sugg-legend-count">${g.counts.selected} of ${g.counts.total} selected</span></legend>
            <ul class="bd-sugg-list">${g.items.map(suggestionHtml).join('')}
            </ul>
          </fieldset>`;
}

function customGroupHtml(custom) {
  if (!custom.length) return '';
  return `
          <fieldset class="bd-sugg-group is-custom">
            <legend class="bd-sugg-legend">Your custom SLIs <span class="bd-sugg-legend-count">always in the pack</span></legend>
            <ul class="bd-sugg-list">${custom.map(c => `
              <li class="bd-sugg is-on is-custom">
                <span class="bd-sugg-label"><span class="bd-sugg-name">${escapeHtml(c.name)}</span><span class="bd-tag">Custom</span></span>
                <span class="bd-sugg-meta">${escapeHtml(c.meta)}</span>
                <button type="button" class="ux-link-btn bd-sugg-edit" data-sugg-edit="${escapeHtml(c.key)}" data-sugg-custom="1" data-focus-key="${escapeHtml(c.focusKey)}" aria-haspopup="dialog" aria-label="${escapeHtml(`Edit ${c.name}`)}">Edit</button>
              </li>`).join('')}
            </ul>
          </fieldset>`;
}

/** "Why these suggestions?" — where the rubric clauses went: how a suggestion is made, then the tier's requirements by theme. */
function whyHtml(model, open) {
  const w = model.why;
  const clause = (c) => `<li class="bd-why-clause"><span class="build-sev build-sev-${escapeHtml(String(c.severity).toLowerCase())}">${escapeHtml(c.severity)}</span> ${escapeHtml(c.description)} <code>${escapeHtml(c.id)}</code></li>`;
  const body = `
            <p>Each technology you picked lists the SLIs it can measure. An SLI is <b>recommended</b> when its own tier is ${escapeHtml(w.tier || 'the chosen tier')} or lower; the others start from a higher tier’s objective and stay optional. The tier suggests — it never forbids an SLI.</p>
            ${w.loaded ? `<p>${escapeHtml(w.tier)} (${escapeHtml(w.word)}) grades the pack against ${plural(w.must, 'required clause')}${w.should ? ` and ${plural(w.should, 'recommended one')}` : ''} of the rubric:</p>
            <dl class="bd-why">${w.themes.map(t => `
              <div class="bd-why-theme"><dt>${escapeHtml(t.label)} <span>${escapeHtml(t.text)}</span></dt><dd><ul>${t.clauses.map(clause).join('')}</ul></dd></div>`).join('')}
              ${w.also.length ? `<div class="bd-why-theme"><dt>Also checked</dt><dd><ul>${w.also.map(clause).join('')}</ul></dd></div>` : ''}
            </dl>` : '<p>The tier’s requirements are still loading.</p>'}`;
  return `<details class="ux-disclosure bd-fold" data-define-fold="why"${open ? ' open' : ''}><summary>Why these suggestions?</summary><div class="ux-disclosure-body">${body}</div></details>`;
}

/** "Advanced review" — the layer mechanics that used to open the step: the silhouette of the pack, layer by layer. */
function advancedHtml(model, open) {
  const stack = model.stack;
  const candidates = stack.slabs.reduce((n, s) => n + s.ghosts.filter(g => g.kind === 'sli').length, 0);
  return `<details class="ux-disclosure bd-fold" data-define-fold="advanced"${open ? ' open' : ''}><summary>Advanced review: the pack layer by layer</summary><div class="ux-disclosure-body">
            <p>The tier is a seed: it draws the silhouette of the pack it starts with — one ghost card per requirement, layer by layer — and decides which rubric grades it, never which SLIs you may add. Your SLIs land on L1 with the SLO each gets; each layer’s edge shows its verdict once the selection compiles. Open a layer for its parameters and sections, or an SLI card to edit it.</p>
            <div class="build-stack-wrap build-silhouette">
              <div class="build-section-key">The stack ${escapeHtml(model.tier || '')} requires
                <span class="build-section-sub">${plural(stack.counts.clauses.total, 'clause')} over ${stack.slabs.filter(s => s.counts.clauses).length} layers${candidates ? ` · ${plural(candidates, 'SLI')} on L1` : ''}</span>
              </div>
              ${buildStackHtml(stack)}
            </div>
          </div></details>`;
}

function reviewPanelHtml(model) {
  const s = model.suggestions;
  const f = model.folds || {};
  // Advanced review opens by itself when a rejected value waits on a layer sheet or a card (unless the user closed it).
  const rejected = !!(model.error && (model.error.paramCount || rejectedCopies(model.error).length));
  const advancedOpen = f.advanced === true || (f.advanced !== false && rejected);
  const tierNote = model.tiers.find(t => t.selected)?.consequences?.sentence || '';
  const list = s.groups.length
    ? `
        <div class="bd-sugg-bar">
          <span class="bd-sugg-count">${s.counts.selected} of ${plural(s.counts.total, 'suggested SLI')} selected${s.counts.custom ? ` · ${s.counts.custom} custom` : ''}</span>
          <span class="bd-sugg-actions">
            <button type="button" class="ux-secondary-btn" data-sugg-recommended data-focus-key="sugg:recommended"${s.allRecommended ? ' disabled' : ''}>${s.allRecommended ? 'All recommended selected' : `Select recommended (${s.counts.recommended})`}</button>
            <button type="button" class="ux-link-btn" data-sugg-create data-focus-key="sugg:create" aria-haspopup="dialog">Add a custom SLI</button>
          </span>
        </div>
        ${s.groups.map(suggestionGroupHtml).join('')}
        ${customGroupHtml(s.custom)}`
    : `
        <div class="ux-empty ux-tone-neutral" role="note">
          <p class="ux-empty-title">No suggestions yet</p>
          <p class="ux-empty-checked"><span class="ux-empty-key">Checked:</span> the technologies picked for this service — none so far.</p>
          <div class="ux-empty-actions"><button type="button" class="ux-secondary-btn" data-define-sub="technology">Pick a technology</button></div>
        </div>`;
  return panelHtml(model, 'review', `These SLIs come from the technology you picked, at ${escapeHtml(model.tier || 'the chosen tier')}. The recommended ones are ticked — add or remove any, or edit one.`, `
        ${list}
        ${tierNote ? `<p class="bd-requirements"><span class="bd-requirements-key">${escapeHtml(model.tier || '')} also requires</span> ${escapeHtml(tierNote)}.</p>` : ''}
        ${whyHtml(model, !!f.why)}
        ${advancedHtml(model, advancedOpen)}`);
}

// ---------- the step ----------

/** The step's footer status: what is still needed, or what seeding does. */
function statusText(model) {
  const entriesCount = model.selectedEntries.length;
  if (!model.valid) return `Still needed: ${model.errors.map(escapeHtml).join(' and ')}.`;
  if (model.error) return 'Selection complete, but the last compilation failed — see the error above.';
  if (model.seeded) return `Seeded — ${entriesCount} entr${entriesCount === 1 ? 'y' : 'ies'}; your edits are already in the pack — Compile shows its artefacts.`;
  return `Selection complete — ${entriesCount} entr${entriesCount === 1 ? 'y' : 'ies'}; seeding the pack opens Compile, where the artefacts are.`;
}

/** render(container, model, host) — the DEFINE step: four substeps, and the way to Compile. */
export function renderBuildDefine(container, model, host = appHost) {
  const act = host.build;
  // One primary action per state: on the last substep Seed the pack is it; before, Continue is, and seeding stays available.
  const last = model.substep === 'review';
  container.innerHTML = `
    <section class="build-step build-define">
      ${stepHeadHtml('define', 'What are we building for?', 'Describe the service in four short steps. We suggest the SLIs and requirements it needs; you review them, then seed the pack.')}

      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'on its layer sheet (L2 · L4 · L5)' })}

      ${substepsHtml(model)}
      <div class="bd-panels">
        ${servicePanelHtml(model)}
        ${criticalityPanelHtml(model)}
        ${technologyPanelHtml(model)}
        ${reviewPanelHtml(model)}
      </div>

      <footer class="build-step-actions">
        <span class="build-step-status">${statusText(model)}</span>
        <button type="button" class="${last ? 'mcp-refresh-btn' : 'ctrl-btn'} build-next" id="build-next" ${model.valid ? '' : 'disabled'}>${escapeHtml(model.nextLabel)} <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  wireBuildDefinition(container, model, host);   // the fields, the tier cards, the technology cards, the substep buttons
  wireBuildStack(container, model.stack, host);
  wireSuggestions(container, model, act);
  container.querySelector('#build-next').addEventListener('click', () => (act.seed ? act.seed() : act.setStep('compile')));
  // The substep shown is pinned on the draft (UI state, never persisted) the first time the step renders: the default
  // follows the draft, so without the pin the first technology picked, or a re-render while the name is typed, would
  // move the user to another substep by itself.
  if (!model.substepPinned) act?.update?.({ defineSub: model.substep }, { rerender: false, reinstantiate: false });
}

/**
 * The Review substep's handlers and the folds: a checkbox puts its SLI in or out of the pack (setSli, the rolodex's
 * action), "Select recommended" adds every recommended SLI to the selection, Edit opens the SLI's editor (focus
 * returns to the Edit), "Add a custom SLI" opens it in create mode; a fold opened or closed is remembered on the
 * draft (never persisted), so a re-render keeps it.
 */
export function wireSuggestions(container, model, act) {
  const s = model.suggestions;
  container.querySelectorAll('[data-sugg-sli]').forEach(box => box.addEventListener('change', () => act?.setSli?.(box.dataset.suggSli, !!box.checked, s.allKeys)));
  container.querySelector('[data-sugg-recommended]')?.addEventListener('click', () => {
    if (s.allRecommended) return;
    act?.update?.({ slis: s.recommendedSlis }, { rerender: true, delay: 0, focus: 'dpanel:review' });
  });
  container.querySelectorAll('[data-sugg-edit]').forEach(b => b.addEventListener('click', () => act?.openEditor?.({ key: b.dataset.suggEdit, custom: b.dataset.suggCustom === '1', opener: b.dataset.focusKey || null })));
  container.querySelector('[data-sugg-create]')?.addEventListener('click', () => act?.openEditor?.({ create: true, opener: 'sugg:create' }));
  const folds = { ...(model.folds || {}) };
  container.querySelectorAll('details[data-define-fold]').forEach(d => d.addEventListener('toggle', () => {
    if (folds[d.dataset.defineFold] === d.open) return;
    folds[d.dataset.defineFold] = d.open;
    act?.update?.({ defineFolds: { ...folds } }, { rerender: false, reinstantiate: false });
  }));
}
