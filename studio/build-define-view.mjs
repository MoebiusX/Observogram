// studio/build-define-view.mjs
//
// BUILD step 1 — DEFINE, "What are we observing?": the service (name, owners,
// environment), its criticality tier (each with what it requires, from the
// tier's clauses) and the library entries it runs on (products) or is built
// as (archetypes), then the selection's params with their defaults and the
// placeholders flagged. Also home to the clause rail the three steps share
// (the tier is chosen here, so the tier's requirements are introduced here).
//
// Renderer only (docs/UI_CONVENTIONS.md §2-3): render(container, model, host)
// with the model from build-model.mjs's buildDefineModel / buildRailModel and
// the host the controller in app.mjs passes — host.build.* are the actions
// (update, toggleEntry, setParam, setStep, exit); no state reads, no fetches.

import { escapeHtml } from './util.mjs';
import { host as appHost } from './host.mjs';
import { BUILD_STEPS, MAX_SERVICE_SLUG } from './build-model.mjs';
import { evidenceBadge, paramRowHtml, wireParamInputs, clauseRowHtml, STATE_GLYPH } from './build-atoms.mjs';
import { buildStackHtml, wireBuildStack } from './build-stack-view.mjs';

// The atoms the three steps share moved to build-atoms.mjs (the stack view draws
// them too); re-exported here so the step views keep one import for them.
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

/** The last instantiation's usage errors as one note: the general ones spelled out, the rejected params counted (their rows carry the reason). */
export function instantiateErrorHtml(error, { stale = false, where = 'below' } = {}) {
  if (!error) return '';
  const parts = [...error.general.map(escapeHtml)];
  if (error.paramCount) parts.push(`${error.paramCount} parameter value${error.paramCount === 1 ? '' : 's'} rejected — marked on ${error.paramCount === 1 ? 'its row' : 'their rows'} ${where}`);
  return `<div class="build-note build-note-err" role="alert"><strong>The last compilation failed${stale ? ' — the pack shown is the previous one' : ''}.</strong> ${parts.join(' · ')}</div>`;
}

/** render(container, model, host) — the DEFINE step. */
export function renderBuildDefine(container, model, host = appHost) {
  const act = host.build;
  const entriesCount = model.selectedEntries.length;
  const stack = model.stack;
  const candidates = stack.slabs.reduce((n, s) => n + s.ghosts.filter(g => g.kind === 'sli').length, 0);
  container.innerHTML = `
    <section class="build-step build-define">
      ${stepHeadHtml('define', 'What are we observing?', 'Name the service, pick its criticality tier and the library entries it runs on — products with an evidence bar, or an archetype for a service built from scratch. The tier draws the silhouette of the pack it demands, layer by layer; the entries drop their SLIs onto L1; the edges light up as soon as the selection compiles.')}

      <div class="build-fields">
        <label class="build-field">
          <span class="build-field-key">Service name</span>
          <input id="build-name" type="text" data-focus-key="name" value="${escapeHtml(model.name)}" placeholder="orders-api" autocomplete="off" spellcheck="false">
          <span class="build-field-hint">${model.name && model.slug !== model.name ? `slugs to <code>${escapeHtml(model.slug)}</code>` : `metadata.name and the metric prefix of every recording rule — at most ${MAX_SERVICE_SLUG} characters once slugged`}</span>
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

      <div class="build-stack-wrap build-silhouette">
        <div class="build-section-key">The stack ${escapeHtml(model.tier || '')} requires
          <span class="build-section-sub">${stack.counts.clauses.total} clause${stack.counts.clauses.total === 1 ? '' : 's'} over ${stack.slabs.filter(s => s.counts.clauses).length} layers — one ghost card per clause the tier applies in that dimension; ${candidates ? `the selection’s ${candidates} SLI${candidates === 1 ? '' : 's'} and the SLO each gets at ${escapeHtml(model.tier || 'this tier')} on L1 (ticking is on Compile)` : 'pick an entry and its SLIs land on L1 with the SLO each gets'}. Change the tier and the silhouette reshapes${stack.counts.clauses.pending < stack.counts.clauses.total ? '; the edges carry the compiled pack’s verdict per layer — click one for its clauses' : ''}.</span>
        </div>
        ${buildStackHtml(stack)}
      </div>

      ${entriesCount ? `
      ${instantiateErrorHtml(model.error, { stale: model.stale, where: 'below' })}
      <details class="build-params-wrap" ${model.params.some(p => !p.atDefault || p.error) ? 'open' : ''}>
        <summary class="build-section-key">Parameters <span class="build-section-sub">${model.params.length} for this selection · ${model.placeholders.remaining != null
          ? `${model.placeholders.remaining} placeholder${model.placeholders.remaining === 1 ? '' : 's'} still at their default in the generated pack — each is a todo`
          : `${model.placeholders.flagged} placeholder param${model.placeholders.flagged === 1 ? '' : 's'} in this selection — one left at its default becomes a todo where the tier writes it`}; fill them here or inline on Verify</span></summary>
        <div class="build-params">${model.params.map(p => paramRowHtml(p)).join('')}</div>
      </details>` : ''}

      <footer class="build-step-actions">
        <span class="build-step-status">${!model.valid ? `Still needed: ${model.errors.map(escapeHtml).join(' and ')}.` : model.error ? 'Selection complete, but the last compilation failed — see the error above.' : 'Selection complete — the tier’s clauses are being checked on the right.'}</span>
        <button type="button" class="mcp-refresh-btn build-next" id="build-next" ${model.valid ? '' : 'disabled'}>Continue to Compile <span aria-hidden="true">→</span></button>
      </footer>
    </section>`;

  const byId = (id) => container.querySelector(`#${id}`);
  byId('build-name').addEventListener('input', (e) => act.update({ name: e.target.value }));
  byId('build-owners').addEventListener('input', (e) => act.update({ owners: e.target.value }));
  byId('build-env').addEventListener('input', (e) => act.update({ environment: e.target.value }));
  container.querySelectorAll('input[name="build-tier"]').forEach(r => r.addEventListener('change', () => act.setTier(r.value)));
  container.querySelectorAll('.build-entry').forEach(b => b.addEventListener('click', () => act.toggleEntry(b.dataset.entry)));
  wireParamInputs(container, act);
  wireBuildStack(container, stack, host);
  byId('build-next').addEventListener('click', () => act.setStep('compile'));
}

// ---------- the clause rail (steps 1-3) ----------
// The rows are build-atoms clauseRowHtml — the same row a slab's clause list draws.

const DIM_NAME = { L1: 'Contract', L2: 'Telemetry', L2X: 'Extended', L3: 'Insight', L4: 'Action', L5: 'Validation', GOV: 'Governance' };

/**
 * render(container, railModel, host) — the compact summary of the tier's clauses:
 * the status, the three counts, the clauses that fail (always listed — the stack's
 * red edges, named), how many pass only on a placeholder, and the todo / warning
 * counts; the full list by layer folds under "all clauses" (the per-layer clauses
 * live on the stack's slabs). Whether it is open is kept in the draft through
 * host.build.update, never persisted.
 */
export function renderClauseRail(container, rail, host = appHost) {
  const c = rail.checklist;
  const k = c.counts;
  const status = rail.pending ? 'checking…'
    : rail.error ? (rail.stale ? 'the last compilation failed — showing the previous pack' : 'the last instantiation failed')
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
    ${rail.failing.length ? `
    <div class="build-rail-failing">
      <div class="build-rail-dim">failing <span>the red edges on the stack</span></div>
      <ul class="build-rail-clauses">${rail.failing.map(clauseRowHtml).join('')}</ul>
    </div>` : ''}
    ${rail.onPlaceholder.length ? `<div class="build-rail-ph-note">${rail.onPlaceholder.length} clause${rail.onPlaceholder.length === 1 ? ' passes' : 's pass'} only on a placeholder — the amber edges on the stack; the todos on those slabs are the difference.</div>` : ''}
    <details class="build-rail-all"${rail.expanded ? ' open' : ''}>
      <summary>all ${k.total} clause${k.total === 1 ? '' : 's'} by layer</summary>
      <div class="build-rail-list">
        ${c.groups.map(g => `
          <div class="build-rail-group">
            <div class="build-rail-dim">${escapeHtml(g.dimension)} <span>${escapeHtml(DIM_NAME[g.dimension] || '')}</span></div>
            <ul class="build-rail-clauses">${g.items.map(clauseRowHtml).join('')}</ul>
          </div>`).join('')}
      </div>
    </details>
    <div class="build-rail-foot">
      <span class="build-rail-todos" title="placeholders and scaffold defaults only the team can fill"><b>${rail.todoCount}</b> todo${rail.todoCount === 1 ? '' : 's'}</span>
      <span class="build-rail-warnings${rail.blockingWarnings ? ' is-blocking' : ''}" title="promql (blocking) · sli-excluded · burn-rules"><b>${rail.warningCount}</b> warning${rail.warningCount === 1 ? '' : 's'}</span>
      <span class="build-rail-ph"><b>${rail.placeholdersRemaining}</b> placeholder${rail.placeholdersRemaining === 1 ? '' : 's'} left</span>
    </div>`;
  // The click lands before <details> toggles, so the new state is the opposite of the current one.
  const all = container.querySelector('.build-rail-all');
  all?.querySelector('summary')?.addEventListener('click', () => host.build?.update?.({ railOpen: !all.open }, { reinstantiate: false }));
}
