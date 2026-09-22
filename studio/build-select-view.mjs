// studio/build-select-view.mjs
//
// BUILD step 1 — SELECT, "What are we building?": the service (name, owners,
// environment), its criticality tier (each with what it requires, from the
// tier's clauses) and the library entries it runs on (products) or is built
// as (archetypes), then the selection's params with their defaults and the
// placeholders flagged. Also home to the clause rail the three steps share
// (the tier is chosen here, so the tier's requirements are introduced here).
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with the model from build-model.mjs's buildSelectModel / buildRailModel and
// the host the controller in app.mjs passes — host.build.* are the actions
// (update, toggleEntry, setParam, setStep, exit); no state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { BUILD_STEPS } from './build-model.mjs';

const EVIDENCE_LABEL = {
  'recorded-live': 'recorded live', 'reference-pack': 'reference pack', 'upstream-docs': 'upstream docs', semconv: 'semconv',
};

export function evidenceBadge(status, verifiedOn) {
  if (!status) return '';
  const title = verifiedOn ? `${EVIDENCE_LABEL[status] || status} · verified ${verifiedOn}` : (EVIDENCE_LABEL[status] || status);
  return `<span class="build-evidence build-evidence-${escapeHtml(status)}" title="${escapeHtml(title)}">${escapeHtml(EVIDENCE_LABEL[status] || status)}</span>`;
}

export function stepHeadHtml(step, title, lede) {
  const n = BUILD_STEPS.indexOf(step) + 1;
  return `
    <header class="build-step-head">
      <div class="build-eyebrow">build · step ${n} of ${BUILD_STEPS.length} · ${escapeHtml(step)}</div>
      <h2 class="build-title">${escapeHtml(title)}</h2>
      <p class="build-lede">${lede}</p>
    </header>`;
}

function entryCardHtml(c) {
  const counts = c.sliCountByTier || {};
  return `
    <button type="button" class="build-entry${c.selected ? ' is-selected' : ''}" data-entry="${escapeHtml(c.id)}" aria-pressed="${c.selected ? 'true' : 'false'}">
      <span class="build-entry-top">
        <span class="build-entry-title">${escapeHtml(c.title)}</span>
        ${evidenceBadge(c.evidence.status, c.evidence.verifiedOn)}
      </span>
      <span class="build-entry-summary">${escapeHtml(c.summary)}</span>
      <span class="build-entry-meta">
        <span class="build-entry-slis" title="SLIs at tier-3 / tier-2 / tier-1">SLIs ${counts['tier-3'] ?? '–'}/${counts['tier-2'] ?? '–'}/${counts['tier-1'] ?? '–'}</span>
        <span class="build-entry-at">${c.sliCountAtTier} at this tier</span>
        ${c.placeholderParams ? `<span class="build-entry-ph">${c.placeholderParams} placeholder${c.placeholderParams === 1 ? '' : 's'}</span>` : ''}
        ${c.evidence.gaps ? `<span class="build-entry-gaps" title="the entry names what it could not verify">${c.evidence.gaps} gap${c.evidence.gaps === 1 ? '' : 's'}</span>` : ''}
        <span class="build-entry-id">${escapeHtml(c.id)}@${escapeHtml(c.version)}</span>
      </span>
    </button>`;
}

function tierCardHtml(t) {
  const adds = t.adds.length
    ? `<ul class="build-tier-adds">${t.adds.slice(0, 6).map(c => `<li title="${escapeHtml(c.id)}"><span class="build-sev build-sev-${c.severity.toLowerCase()}">${c.severity}</span> ${escapeHtml(c.description)}</li>`).join('')}${t.adds.length > 6 ? `<li class="build-tier-more">+ ${t.adds.length - 6} more clause${t.adds.length - 6 === 1 ? '' : 's'} (the rail lists every one)</li>` : ''}</ul>`
    : `<p class="build-tier-adds build-tier-adds-empty">${t.loaded ? 'the baseline every pack meets' : 'loading the tier’s clauses…'}</p>`;
  return `
    <label class="build-tier${t.selected ? ' is-selected' : ''}" data-tier="${escapeHtml(t.id)}">
      <input type="radio" name="build-tier" value="${escapeHtml(t.id)}" ${t.selected ? 'checked' : ''}>
      <span class="build-tier-head">
        <span class="build-tier-name">${escapeHtml(t.id)}</span>
        <span class="build-tier-word">${escapeHtml(t.word)}</span>
        <span class="build-tier-counts">${t.must == null ? '…' : `${t.must} MUST${t.should ? ` · ${t.should} SHOULD` : ''}`}</span>
      </span>
      <span class="build-tier-blurb">${escapeHtml(t.blurb)}</span>
      <span class="build-tier-requires">${t.id === 'tier-3' ? 'requires' : 'adds'}</span>
      ${adds}
    </label>`;
}

// One param as an input (the same param may fill several todos on VALIDATE:
// idSuffix keeps the ids and focus keys distinct while they share the key).
export function paramRowHtml(p, { compact = false, idSuffix = '' } = {}) {
  const focusKey = `param:${p.key}${idSuffix ? `@${idSuffix}` : ''}`;
  const id = `bp-${idSuffix ? `${idSuffix}-` : ''}${p.key}`;
  return `
    <div class="build-param${p.placeholder ? ' is-placeholder' : ''}${p.atDefault ? '' : ' is-set'}" data-param="${escapeHtml(p.key)}">
      <label class="build-param-label" for="${escapeHtml(id)}">
        <span class="build-param-name">${escapeHtml(p.label)}</span>
        <span class="build-param-key">${escapeHtml(p.key)}${p.entry ? '' : ' · scaffold'}</span>
        ${p.placeholder ? `<span class="build-param-flag" title="left at its default this value is written into the pack AND reported as a todo">${p.atDefault ? 'placeholder → todo' : 'placeholder filled'}</span>` : ''}
      </label>
      <input id="${escapeHtml(id)}" class="build-param-input" type="text" data-focus-key="${escapeHtml(focusKey)}"
             value="${escapeHtml(p.value ?? '')}" placeholder="${escapeHtml(String(p.default ?? ''))}" autocomplete="off" spellcheck="false">
      ${compact ? '' : `<span class="build-param-desc">${escapeHtml(p.description)}</span>`}
    </div>`;
}

/** render(container, model, host) — the SELECT step. */
export function renderBuildSelect(container, model, host = appHost) {
  const act = host.build;
  const entriesCount = model.selectedEntries.length;
  container.innerHTML = `
    <section class="build-step build-select">
      ${stepHeadHtml('select', 'What are we building?', 'Name the service, pick its criticality tier and the library entries it runs on — products with an evidence bar, or an archetype for a service built from scratch. The rail on the right lists what the tier requires and fills in as soon as the selection is complete.')}

      <div class="build-fields">
        <label class="build-field">
          <span class="build-field-key">Service name</span>
          <input id="build-name" type="text" data-focus-key="name" value="${escapeHtml(model.name)}" placeholder="orders-api" autocomplete="off" spellcheck="false">
          <span class="build-field-hint">${model.name && model.slug !== model.name ? `slugs to <code>${escapeHtml(model.slug)}</code>` : 'metadata.name and the metric prefix of every recording rule'}</span>
        </label>
        <label class="build-field">
          <span class="build-field-key">Owners</span>
          <input id="build-owners" type="text" data-focus-key="owners" value="${escapeHtml(model.owners)}" placeholder="team-orders, sre-platform" autocomplete="off" spellcheck="false">
          <span class="build-field-hint">${model.ownerList.length ? `${model.ownerList.length} owner${model.ownerList.length === 1 ? '' : 's'}` : 'comma-separated — empty is a todo'}</span>
        </label>
        <label class="build-field">
          <span class="build-field-key">Environment</span>
          <input id="build-env" type="text" data-focus-key="environment" list="build-env-options" value="${escapeHtml(model.environment)}" placeholder="prod" autocomplete="off" spellcheck="false">
          <datalist id="build-env-options"><option value="prod"></option><option value="staging"></option><option value="dev"></option><option value="eks"></option><option value="local-docker"></option></datalist>
          <span class="build-field-hint">the pack’s one environment; its overlay carries the tier</span>
        </label>
      </div>

      <fieldset class="build-tiers" aria-label="Criticality tier">
        <legend class="build-section-key">Criticality tier <span class="build-section-sub">the tier is the only definition of what the pack must contain — the conformance rubric filtered by minTier</span></legend>
        <div class="build-tier-grid">${model.tiers.map(tierCardHtml).join('')}</div>
      </fieldset>

      <div class="build-library">
        <div class="build-section-key">Library entries <span class="build-section-sub">${entriesCount ? `${entriesCount} selected — ${model.selectedEntries.map(e => escapeHtml(e.title)).join(', ')}` : 'pick one or more; several compose into one pack'}</span></div>
        <div class="build-entry-group">
          <div class="build-entry-kind">Products <span>what the service runs on — SLIs read from the product’s own exposition</span></div>
          <div class="build-entry-grid">${model.products.map(entryCardHtml).join('')}</div>
        </div>
        <div class="build-entry-group">
          <div class="build-entry-kind">Archetypes <span>a service built from scratch — OTel semantic conventions in Prometheus spelling</span></div>
          <div class="build-entry-grid">${model.archetypes.map(entryCardHtml).join('')}</div>
        </div>
        ${model.libraryErrors.length ? `<div class="build-note build-note-warn">${model.libraryErrors.length} library file${model.libraryErrors.length === 1 ? '' : 's'} did not load: ${model.libraryErrors.map(e => `<code>${escapeHtml(e.file)}</code>`).join(', ')}</div>` : ''}
      </div>

      ${entriesCount ? `
      <details class="build-params-wrap" ${model.params.some(p => !p.atDefault) ? 'open' : ''}>
        <summary class="build-section-key">Parameters <span class="build-section-sub">${model.params.length} for this selection · ${model.params.filter(p => p.placeholder && p.atDefault).length} placeholder${model.params.filter(p => p.placeholder && p.atDefault).length === 1 ? '' : 's'} still at their default — each becomes a todo; fill them here or inline on Validate</span></summary>
        <div class="build-params">${model.params.map(p => paramRowHtml(p)).join('')}</div>
      </details>` : ''}

      <footer class="build-step-actions">
        <span class="build-step-status">${model.valid ? 'Selection complete — the tier’s clauses are being checked on the right.' : `Still needed: ${model.errors.join(' and ')}.`}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${model.valid ? '' : 'disabled'}>Continue to Generate <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  const byId = (id) => container.querySelector(`#${id}`);
  byId('build-name').addEventListener('input', (e) => act.update({ name: e.target.value }));
  byId('build-owners').addEventListener('input', (e) => act.update({ owners: e.target.value }));
  byId('build-env').addEventListener('input', (e) => act.update({ environment: e.target.value }));
  container.querySelectorAll('input[name="build-tier"]').forEach(r => r.addEventListener('change', () => act.setTier(r.value)));
  container.querySelectorAll('.build-entry').forEach(b => b.addEventListener('click', () => act.toggleEntry(b.dataset.entry)));
  wireParamInputs(container, act);
  byId('build-next').addEventListener('click', () => act.setStep('generate'));
}

/** Param inputs commit on change (Enter / blur), so typing never re-renders under the caret. */
export function wireParamInputs(container, act) {
  container.querySelectorAll('.build-param-input').forEach(inp => {
    const key = inp.closest('.build-param')?.dataset.param;
    inp.addEventListener('change', () => act.setParam(key, inp.value));
    inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); inp.blur(); } });
  });
}

// ---------- the clause rail (steps 1-3) ----------

const STATE_GLYPH = { pass: '✓', placeholder: '◐', fail: '✗', pending: '○' };
const STATE_WORD = { pass: 'passes', placeholder: 'passes on a placeholder', fail: 'fails', pending: 'not evaluated yet' };
const DIM_NAME = { L1: 'Contract', L2: 'Telemetry', L2X: 'Extended', L3: 'Insight', L4: 'Action', L5: 'Validation', GOV: 'Governance' };

/** render(container, railModel) — the tier's clauses as a live checklist with three states, plus the todo and warning counts. */
export function renderClauseRail(container, rail) {
  const c = rail.checklist;
  const k = c.counts;
  const status = rail.pending ? 'checking…'
    : rail.error ? 'the last instantiation failed'
    : !rail.valid ? 'complete the selection to evaluate'
    : !rail.ready ? 'evaluating…'
    : (c.conformant ? 'conformant at this tier' : `${k.must.fail} MUST clause${k.must.fail === 1 ? '' : 's'} failing`);
  container.className = `build-rail${rail.pending ? ' is-pending' : ''}${rail.ready && !rail.pending ? (c.conformant ? ' is-ok' : ' is-fail') : ''}`;
  container.innerHTML = `
    <div class="build-rail-head">
      <span class="build-rail-tier">${escapeHtml(rail.tier || '')} requirements</span>
      <span class="build-rail-totals">${k.must.total} MUST${k.should.total ? ` · ${k.should.total} SHOULD` : ''}</span>
    </div>
    <div class="build-rail-status">${escapeHtml(status)}</div>
    <div class="build-rail-counts" aria-label="clause states">
      <span class="build-rail-count is-pass" title="passes on the pack as written"><b>${STATE_GLYPH.pass}</b> ${k.pass} pass</span>
      <span class="build-rail-count is-placeholder" title="passes, but only on a placeholder value the team still has to fill"><b>${STATE_GLYPH.placeholder}</b> ${k.placeholder} on a placeholder</span>
      <span class="build-rail-count is-fail" title="does not pass at this tier"><b>${STATE_GLYPH.fail}</b> ${k.fail} fail</span>
    </div>
    <div class="build-rail-list">
      ${c.groups.map(g => `
        <div class="build-rail-group">
          <div class="build-rail-dim">${escapeHtml(g.dimension)} <span>${escapeHtml(DIM_NAME[g.dimension] || '')}</span></div>
          <ul class="build-rail-clauses">
            ${g.items.map(i => `
              <li class="build-rail-clause is-${i.state}" title="${escapeHtml(`${i.id} — ${STATE_WORD[i.state]}${i.todos.length ? ` · ${i.todos.join(', ')}` : ''}`)}">
                <span class="build-rail-glyph" aria-hidden="true">${STATE_GLYPH[i.state]}</span>
                <span class="build-rail-text">
                  <span class="build-rail-desc">${escapeHtml(i.description)}</span>
                  <span class="build-rail-id"><span class="build-sev build-sev-${i.severity.toLowerCase()}">${i.severity}</span> ${escapeHtml(i.id)}${i.state === 'placeholder' ? ` · <em>on ${i.todos.length} placeholder${i.todos.length === 1 ? '' : 's'}</em>` : ''}</span>
                </span>
              </li>`).join('')}
          </ul>
        </div>`).join('')}
    </div>
    <div class="build-rail-foot">
      <span class="build-rail-todos" title="placeholders and scaffold defaults only the team can fill"><b>${rail.todoCount}</b> todo${rail.todoCount === 1 ? '' : 's'}</span>
      <span class="build-rail-warnings${rail.blockingWarnings ? ' is-blocking' : ''}" title="promql (blocking) · sli-excluded · burn-rules"><b>${rail.warningCount}</b> warning${rail.warningCount === 1 ? '' : 's'}</span>
      <span class="build-rail-ph"><b>${rail.placeholdersRemaining}</b> placeholder${rail.placeholdersRemaining === 1 ? '' : 's'} left</span>
    </div>`;
}
