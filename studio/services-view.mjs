// studio/services-view.mjs
//
// The renderers of the services axis (docs/STORE_PLAN.md §6, slice 6a): the
// Services home (renderServicesHome, markUnavailable), the service page
// (renderServicePage, wireServiceTabs) and the no-org home. Renderers only
// (docs/UI_CONVENTIONS.md §2–3): render(container, model, host) over a model
// studio/services-model.mjs built, no state read, no fetch; the services
// actions ride `host.services`, built by the app.mjs controller — reached
// with optional chaining so a headless render under node:test with
// `{ services: {} }` never throws. Every field is escaped at the seam.

import { host as appHost } from './host.mjs';
import { escapeHtml, fmtRelative, TRAPPED_DIALOGS } from './util.mjs';
import { disclosureHtml, emptyStateHtml } from './ux-kit.mjs';

// ---------- the Services home ----------

// One record card (STORE_PLAN §6 slice 6a, design §4.1): the name, the slug,
// one meta line (tier · owners · packs) the card is described by, one row
// per environment with its verdict pill, and when it was opened here. It
// keeps today's tile class and `data-service` (the slug) so one selector
// finds a service on the home in every posture; `.svc-card` tells a record
// from a derived tile. The pill's text carries its meaning — a colour never
// does alone — and a failed report's parsed refusal rides its title.
function serviceCardHtml(card) {
  const metaId = `svc-card-${card.id}-meta`;
  const busy = card.envs.some((e) => e.verdict.state === 'loading');
  const envs = card.envs.length
    ? card.envs.map((e) => `<li class="svc-env"><span class="svc-env-name">${escapeHtml(e.name)}</span> ${verdictPillHtml(e.verdict)}</li>`).join('')
    : '<li class="svc-env svc-env-none">no environments yet</li>';
  return `
    <button type="button" class="svc-gate-card svc-card" data-service="${escapeHtml(card.slug)}" data-service-id="${escapeHtml(String(card.id))}"
            data-search="${escapeHtml(card.search)}" aria-describedby="${metaId}">
      <span class="svc-gate-name">${escapeHtml(card.name)}</span>
      <span class="svc-card-slug">${escapeHtml(card.slug)}</span>
      <span class="svc-gate-meta" id="${metaId}">${escapeHtml(`${card.tierText} · ${card.ownersText} · ${card.packsText}`)}</span>
      <ul class="svc-card-envs" aria-label="Environments"${busy ? ' aria-busy="true"' : ''}>${envs}</ul>
      ${card.openedText ? `<span class="svc-gate-activity">${escapeHtml(card.openedText)}</span>` : ''}
    </button>`;
}

function verdictPillHtml(v) {
  const cls = `svc-verdict is-${escapeHtml(v.state)}${v.mismatch ? ' is-mismatch' : ''}`;
  const title = v.state === 'error' && v.detail ? ` title="${escapeHtml(v.detail)}"` : '';
  const detail = v.mismatch && v.detail ? ` <small class="svc-verdict-detail">· ${escapeHtml(v.detail)}</small>` : '';
  return `<span class="${cls}"${title}>${escapeHtml(v.text)}${detail}</span>`;
}

// Today's pack-derived tile, drawn where the table is unavailable (the static
// bundle, a failed read): what tells two services apart — environments, packs
// and drafts, tier, when it was last opened, and the one issue worth knowing.
function derivedTileHtml(s) {
  const packs = [
    s.packCount ? `${s.packCount} pack${s.packCount === 1 ? '' : 's'}` : '',
    s.liveCount ? `${s.liveCount} live draft${s.liveCount === 1 ? '' : 's'}` : '',
  ].filter(Boolean).join(' · ') || 'no packs';
  const envs = (s.environments || []).join(', ');
  const tiers = (s.tiers || []).join(', ');
  const issue = !s.packCount && s.liveCount ? 'Live draft only — no repository pack to compare with' : '';
  return `
    <button type="button" class="svc-gate-card" data-service="${escapeHtml(s.key)}"
            data-search="${escapeHtml(`${s.label} ${envs} ${tiers}`.toLowerCase())}">
      <span class="svc-gate-name">${escapeHtml(s.label)}</span>
      <span class="svc-gate-meta">${escapeHtml([envs, packs, tiers].filter(Boolean).join(' · '))}</span>
      <span class="svc-gate-activity">${s.openedAt ? `Opened ${escapeHtml(fmtRelative(s.openedAt))}` : 'Not opened here yet'}</span>
      ${issue ? `<span class="svc-gate-issue">${escapeHtml(issue)}</span>` : ''}
    </button>`;
}

function gridHtml(heading, cardsHtml) {
  return `
    <div class="home-check-head">
      <h2 class="home-check-title" id="svc-gate-which">${escapeHtml(heading)}</h2>
      <label class="home-check-search">
        <span class="sr-text">Search services</span>
        <input type="search" id="home-service-search" placeholder="Search by service, environment or tier" autocomplete="off" aria-controls="home-service-grid">
      </label>
    </div>
    <div class="svc-gate-grid" id="home-service-grid">${cardsHtml}</div>
    <p class="home-check-none" id="home-service-none" role="status" hidden>No service matches that search.</p>`;
}

// The catalogue packs (an example, a file-backed entry) listed apart, closed
// by default: a catalogue pack has no service row and must never read as one.
function catalogueHtml(catalogue) {
  if (!catalogue.length) return '';
  const rows = catalogue.map((p) => `
    <button type="button" class="home-pick-row" data-pack-id="${escapeHtml(p.id)}">
      <span class="home-pick-name">${escapeHtml(p.label)}</span>
      <span class="home-pick-meta">
        ${p.tier ? `<span class="home-pick-tier">${escapeHtml(p.tier)}</span>` : ''}
        ${p.version ? `<span class="home-pick-ver">v${escapeHtml(String(p.version))}</span>` : ''}
      </span>
      <span class="home-pick-go" aria-hidden="true">→</span>
    </button>`).join('');
  return disclosureHtml(`Catalogue packs (${catalogue.length})`, rows, { cls: 'svc-catalogue' });
}

// The services section of the home (design §3.2), from buildServicesHomeModel:
// the table as record cards, the empty state worded for the reader's rank,
// or today's derived tiles — with the status line and its Retry when the
// table could not be read — then the catalogue packs apart. With the table
// read, `model.derived` is the own services no record covers (a registered
// pack whose row was deleted): tiles after the cards, or under the empty
// sentence, so the pack stays reachable from the home. The controller
// fills the import sources below this container. Actions: a card →
// host.services.openService(id, slug); a derived tile → openDerived(key); a
// catalogue row → openPack(id); Retry → retry(). The search filters the grid.
export function renderServicesHome(container, model, host = appHost) {
  let section;
  const tiles = model.derived.map(derivedTileHtml).join('');
  if (model.kind === 'table') {
    section = gridHtml(model.heading, model.cards.map(serviceCardHtml).join('') + tiles);
  } else if (model.kind === 'empty') {
    section = `<p class="home-check-empty">${escapeHtml(model.empty.title)} ${escapeHtml(model.empty.body)}</p>${tiles ? gridHtml(model.heading, tiles) : ''}`;
  } else {
    section = model.derived.length
      ? gridHtml(model.heading, model.derived.map(derivedTileHtml).join(''))
      : '<p class="home-check-empty">No services yet. Bring a pack in from one of the sources below.</p>';
  }
  const status = model.kind === 'error'
    ? `<p class="svc-status" id="home-services-status" role="status">${escapeHtml(model.error)} <button type="button" class="ux-secondary-btn" id="home-services-retry">Retry</button></p>`
    : '';
  container.innerHTML = `${status}${section}${model.kind === 'table' || model.kind === 'empty' ? catalogueHtml(model.catalogue) : ''}`;

  container.querySelectorAll('.svc-gate-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (card.dataset.serviceId !== undefined) host.services?.openService?.(Number(card.dataset.serviceId), card.dataset.service);
      else host.services?.openDerived?.(card.dataset.service);
    });
  });
  container.querySelectorAll('.home-pick-row').forEach((row) => {
    row.addEventListener('click', () => host.services?.openPack?.(row.dataset.packId));
  });
  container.querySelector('#home-services-retry')?.addEventListener('click', () => host.services?.retry?.());
  const search = container.querySelector('#home-service-search');
  search?.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    let shown = 0;
    container.querySelectorAll('.svc-gate-card').forEach((card) => {
      const hit = !q || (card.dataset.search || '').includes(q);
      card.hidden = !hit;
      if (hit) shown++;
    });
    const none = container.querySelector('#home-service-none');
    if (none) none.hidden = shown > 0;
  });
}

// ---------- the service page ----------

const ACTION_IDS = { layers: 'svc-action-discover', compare: 'svc-action-diagnose', compile: 'svc-action-remediate', build: 'svc-action-build' };

// The environments as a tablist (roving tabindex; ArrowLeft / ArrowRight /
// Home / End move and select — the Advanced menu's pattern), the selected
// tab's panel below it.
function tabsHtml(tabs) {
  return `
    <div class="svc-tabs" role="tablist" aria-label="Environments">
      ${tabs.map((t) => `<button type="button" role="tab" class="svc-tab" id="svc-tab-${escapeHtml(String(t.id))}" data-env="${escapeHtml(t.name)}"
        aria-selected="${t.selected ? 'true' : 'false'}" aria-controls="svc-env-${escapeHtml(String(t.id))}" tabindex="${t.selected ? '0' : '-1'}">${escapeHtml(t.name)}</button>`).join('')}
    </div>`;
}

const row = (dt, ddHtml, cls = '') => `<div class="svc-panel-row${cls ? ` ${cls}` : ''}"><dt>${escapeHtml(dt)}</dt><dd>${ddHtml}</dd></div>`;

// What the selected environment shows: the verdict pill (the conformance
// report of the current primary pack, §4.3), the MCP endpoint as its safe
// form only — name and origin, never a URL — the tier line, the bindings,
// the http(s) links (rel="noopener noreferrer" — a third-party dashboard gets
// no Referer), the pack it is graded with, and the drift note (D3).
function panelHtml(m) {
  const p = m.panel;
  const env = p.env;
  const rows = [];
  if (p.verdict) rows.push(row('Verdict', verdictPillHtml(p.verdict), 'svc-panel-verdict'));
  if (env) {
    rows.push(row('Checked through', p.mcp.kind === 'bound'
      ? `<span class="svc-env-mcp"><span class="svc-env-mcp-name">${escapeHtml(p.mcp.name)}</span> · <span class="svc-env-mcp-origin">${escapeHtml(p.mcp.origin)}</span></span>`
      : `<span class="svc-env-mcp-none">${escapeHtml(p.mcp.text)}</span>`));
  }
  rows.push(row('Tier', escapeHtml(p.tierLine)));
  if (p.bindings.length) {
    rows.push(row('Bindings', `<dl class="svc-env-bindings">${p.bindings.map(([k, v]) => `<div><dt>${escapeHtml(k)}</dt><dd>${escapeHtml(String(v))}</dd></div>`).join('')}</dl>`));
  }
  if (p.links.length) {
    rows.push(row('Links', `<span class="svc-env-links">${p.links.map(([name, url]) => `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(name)} ↗</a>`).join(' · ')}</span>`));
  }
  rows.push(row('Pack', p.pack
    ? `<span class="svc-env-pack">${escapeHtml(p.pack.label)}${p.pack.version ? ` v${escapeHtml(String(p.pack.version))}` : ''} <span class="svc-env-pack-how">(${p.pack.how === 'primary' ? 'current primary' : 'member pack — a live aggregate'}${p.pack.source ? ` · ${escapeHtml(p.pack.source)}` : ''})</span></span>`
    : '<span class="svc-env-pack svc-env-pack-none">No pack yet for this service — Discover below says how one is registered.</span>'));
  rows.push(row('Drift runs', escapeHtml(p.driftNote), 'svc-panel-drift'));
  const ids = env ? ` id="svc-env-${escapeHtml(String(env.id))}" aria-labelledby="svc-tab-${escapeHtml(String(env.id))}" role="tabpanel"` : '';
  return `<div class="svc-panel"${ids} tabindex="0"><dl class="svc-panel-facts">${rows.join('')}</dl></div>`;
}

function actionsHtml(m) {
  return `
    <div class="svc-actions" role="group" aria-label="Open this service in">
      ${m.actions.map((a) => `<button type="button" class="svc-action${a.view === 'build' ? ' is-build' : ''}" id="${ACTION_IDS[a.view]}" data-view="${a.view}">${escapeHtml(a.label)}</button>`).join('')}
    </div>`;
}

// Every pack linked to the record, the chosen primary marked "current"; each
// row opens on its own, so an older primary or a member pack is one click
// away but never the default. A link to a pack no longer in the catalogue
// here is listed, not opened.
function packsHtml(m) {
  const rows = m.packs.map((p) => `
      <li class="svc-pack-row${p.current ? ' is-current' : ''}" data-pack-id="${escapeHtml(p.id)}">
        <span class="svc-pack-label">${escapeHtml(p.label ?? p.id)}</span>
        <span class="svc-pack-meta">${escapeHtml([p.role, p.source].filter(Boolean).join(' · '))}${p.current ? ' <span class="svc-pack-current">current</span>' : ''}</span>
        ${p.inCatalogue
    ? `<button type="button" class="svc-pack-open ux-secondary-btn" data-pack-id="${escapeHtml(p.id)}">open in Discover</button>`
    : '<span class="svc-pack-gone">not in the catalogue here</span>'}
      </li>`).join('');
  return `
    <section class="svc-packs" aria-labelledby="svc-packs-title">
      <h2 class="svc-packs-title" id="svc-packs-title">Packs linked to this service (${m.packs.length})</h2>
      ${m.packs.length ? `<ul class="svc-pack-list">${rows}</ul>` : '<p class="svc-packs-none">None yet — a register (Build, a scan, a draft or an upload) that names this service links its pack here.</p>'}
    </section>`;
}

// The tablist's keyboard: ArrowLeft / ArrowRight / Home / End move the focus
// and select; a click selects. `onSelect(envName)` is the controller's.
export function wireServiceTabs(tablist, onSelect) {
  if (!tablist) return;
  const tabs = () => [...tablist.querySelectorAll('[role="tab"]')];
  tabs().forEach((tab) => tab.addEventListener('click', () => onSelect(tab.dataset.env)));
  tablist.addEventListener('keydown', (e) => {
    const all = tabs();
    const i = all.indexOf(e.target.closest?.('[role="tab"]'));
    if (i < 0 || !all.length) return;
    let next = null;
    if (e.key === 'ArrowRight') next = (i + 1) % all.length;
    else if (e.key === 'ArrowLeft') next = (i - 1 + all.length) % all.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = all.length - 1;
    if (next === null) return;
    e.preventDefault();
    all[next].focus();
    onSelect(all[next].dataset.env);
  });
}

// The service page (design §5): the breadcrumb back to Services, the head
// (name, slug, facts, description), the environments as tabs with the
// selected one's panel — or the rank-worded line when the record has none —
// the four actions (Discover · Diagnose · Remediate bound to the service and
// the environment; Build a pack for <env>, disabled with its reason for a
// rank without the operator role), and every pack linked. Actions:
// host.services.home / selectEnv / openIn / openBuild / openPack / explain /
// openEditor / addEnvironment / editEnvironment. Edit (the record editor,
// renderServiceEditor), Add environment (in the bar and in the
// no-environments line) and Edit environment (beside the tabs, over the
// selected one — the environment editor Settings draws) are drawn only when
// the rank may write (model.canEdit — the service and the environment routes
// are both an operator's); a viewer reads the facts as they are.
export function renderServicePage(container, model, host = appHost) {
  const envName = model.panel.env?.name ?? null;
  const envId = model.panel.env?.id ?? null;
  const bind = { serviceId: model.id, env: envName };
  const noEnv = model.noEnvironments;
  const tabs = tabsHtml(model.tabs);
  container.innerHTML = `
    <section class="svc-page" aria-labelledby="svc-page-name">
      <div class="svc-page-bar">
        <button type="button" class="svc-page-back" id="svc-page-back">← Services</button>
        ${model.canEdit ? `<span class="svc-page-tools">
          <button type="button" class="svc-add-env ux-secondary-btn" id="svc-add-env">Add environment</button>
          <button type="button" class="svc-edit ux-secondary-btn" id="svc-edit">Edit</button>
        </span>` : ''}
      </div>
      <header class="svc-page-head">
        <h1 class="svc-page-name" id="svc-page-name" tabindex="-1">${escapeHtml(model.name)}</h1>
        <span class="svc-page-slug">${escapeHtml(model.slug)}</span>
        <p class="svc-page-facts">${escapeHtml(`${model.facts.tierText} · ${model.facts.ownersText} · ${model.facts.packsText}`)}</p>
        ${model.description ? `<p class="svc-page-desc">${escapeHtml(model.description)}</p>` : ''}
      </header>
      ${noEnv
    ? `<p class="svc-status svc-noenv" role="status">${escapeHtml(noEnv.text)}</p>${noEnv.action === 'add-environment' && model.canEdit ? `
      <button type="button" class="svc-noenv-add ux-secondary-btn" id="svc-noenv-add">Add environment</button>` : ''}`
    : model.canEdit && envId !== null ? `
      <div class="svc-tabs-row">${tabs}
        <button type="button" class="svc-edit-env ux-secondary-btn" id="svc-edit-env" data-env-id="${escapeHtml(String(envId))}">Edit environment</button>
      </div>` : tabs}
      ${panelHtml(model)}
      ${actionsHtml(model)}
      ${packsHtml(model)}
    </section>`;

  container.querySelector('#svc-page-back')?.addEventListener('click', () => host.services?.home?.());
  container.querySelector('#svc-edit')?.addEventListener('click', () => host.services?.openEditor?.(model.id));
  for (const id of ['svc-add-env', 'svc-noenv-add']) container.querySelector(`#${id}`)?.addEventListener('click', () => host.services?.addEnvironment?.(model.id));
  container.querySelector('#svc-edit-env')?.addEventListener('click', () => host.services?.editEnvironment?.(envId));
  wireServiceTabs(container.querySelector('.svc-tabs'), (name) => host.services?.selectEnv?.(name));
  for (const a of model.actions) {
    const btn = container.querySelector(`#${ACTION_IDS[a.view]}`);
    if (!btn) continue;
    if (!a.enabled) markUnavailable(btn, a.reason);
    btn.addEventListener('click', () => {
      if (!a.enabled) { host.services?.explain?.(a.reason); return; }
      if (a.view === 'build') host.services?.openBuild?.(bind);
      else host.services?.openIn?.(a.view, bind);
    });
  }
  container.querySelectorAll('.svc-pack-open').forEach((btn) => {
    btn.addEventListener('click', () => host.services?.openPack?.(btn.dataset.packId, envName));
  });
}

// The record editor (design §6.5): a pop-up over one record in the Build SLI
// editor's idiom — a scrim and a centred dialog (role="dialog" aria-modal,
// labelled by its title, described by its status line; installDialogFocusTrap
// covers it by selector), the four fields — name, owners as text, the tier as
// a radio group with "graded by the pack" for null, the description — and NO
// slug field: the note under the name says the slug stays and what that
// means for packs and for a Build from the page. Save hands the draft to
// host.services.saveService(id, draft) — the controller diffs it
// (buildServicePatch), PATCHes and comes back with a status — Save reads
// aria-disabled while that is pending, so the focus stays on it; Close, the
// scrim, the esc button and Escape → host.services.closeEditor(). Rendered
// again for the same record (a status change), only the status line and the
// Save button are repainted: what was typed and the focus stay.
export function renderServiceEditor(container, model, host = appHost) {
  const mounted = container.querySelector('.svc-editor');
  if (mounted && mounted.getAttribute('data-service-id') === String(model.id)) {
    paintServiceEditorStatus(container, model.status);
    container.querySelector('#svc-editor-save')?.setAttribute('aria-disabled', model.saving ? 'true' : 'false');
    return;
  }
  const f = model.fields;
  container.innerHTML = `
    <div class="svc-editor-scrim" data-editor-close aria-hidden="true"></div>
    <div class="svc-editor" role="dialog" aria-modal="true" aria-labelledby="svc-editor-title" aria-describedby="svc-editor-status" data-service-id="${escapeHtml(String(model.id))}" tabindex="-1">
      <header class="svc-editor-head">
        <span class="svc-editor-eyebrow">Service record · ${escapeHtml(model.slug)}</span>
        <h2 class="svc-editor-title" id="svc-editor-title">${escapeHtml(model.title)}</h2>
        <button type="button" class="svc-editor-close" data-editor-close aria-label="Close the editor (Esc)" title="Close (Esc)"><span aria-hidden="true">esc</span></button>
      </header>
      <div class="svc-editor-body">
        <label class="svc-editor-field">
          <span class="svc-editor-label">Name</span>
          <input id="svc-edit-name" type="text" value="${escapeHtml(f.name)}" maxlength="${model.limits.name}" autocomplete="off" spellcheck="false" aria-describedby="svc-editor-slug-note">
        </label>
        <p class="svc-editor-note" id="svc-editor-slug-note">${escapeHtml(model.slugNote)}</p>
        <label class="svc-editor-field">
          <span class="svc-editor-label">Owners <span class="svc-editor-help">comma-separated, at most ${model.limits.owners}</span></span>
          <input id="svc-edit-owners" type="text" value="${escapeHtml(f.owners)}" autocomplete="off" spellcheck="false" placeholder="team-orders, sre-platform">
        </label>
        <div class="svc-editor-field" role="radiogroup" aria-labelledby="svc-edit-tier-label">
          <span class="svc-editor-label" id="svc-edit-tier-label">Tier <span class="svc-editor-help">the tier the pack is graded at; the environment may override it</span></span>
          <div class="svc-editor-seg">
            ${model.tiers.map((t) => `<button type="button" role="radio" class="svc-editor-seg-btn" data-tier="${t.value ?? ''}" aria-checked="${t.selected ? 'true' : 'false'}" tabindex="${t.selected ? '0' : '-1'}">${escapeHtml(t.label)}</button>`).join('')}
          </div>
        </div>
        <label class="svc-editor-field">
          <span class="svc-editor-label">Description <span class="svc-editor-help">at most ${model.limits.description} characters</span></span>
          <textarea id="svc-edit-desc" rows="3" maxlength="${model.limits.description}">${escapeHtml(f.description)}</textarea>
        </label>
      </div>
      <footer class="svc-editor-foot">
        <div class="svc-editor-status is-${escapeHtml(model.status.kind)}" id="svc-editor-status" role="status" aria-live="polite">${escapeHtml(model.status.text)}</div>
        <div class="svc-editor-actions">
          <button type="button" class="ctrl-btn svc-editor-cancel" data-editor-close>Close</button>
          <button type="button" class="mcp-refresh-btn svc-editor-save" id="svc-editor-save" aria-disabled="${model.saving ? 'true' : 'false'}">Save</button>
        </div>
      </footer>
    </div>`;
  const act = host.services || {};
  const dialog = container.querySelector('.svc-editor');
  for (const el of container.querySelectorAll('[data-editor-close]') || []) el.addEventListener('click', () => act.closeEditor?.());
  dialog?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    act.closeEditor?.();
  });
  bindDocumentEscape(container, host);
  // The tier radios: a click checks one; ArrowLeft / ArrowRight / Home / End move and check (roving tabindex).
  let tier = f.tier;
  const radios = [...(container.querySelectorAll('.svc-editor-seg-btn') || [])];
  const check = (btn) => {
    tier = btn.dataset.tier || null;
    for (const r of radios) { r.setAttribute('aria-checked', r === btn ? 'true' : 'false'); r.setAttribute('tabindex', r === btn ? '0' : '-1'); }
  };
  radios.forEach((btn) => btn.addEventListener('click', () => check(btn)));
  container.querySelector('.svc-editor-seg')?.addEventListener('keydown', (e) => {
    const i = radios.indexOf(e.target.closest?.('[role="radio"]'));
    if (i < 0 || !radios.length) return;
    let next = null;
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = (i + 1) % radios.length;
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = (i - 1 + radios.length) % radios.length;
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = radios.length - 1;
    if (next === null) return;
    e.preventDefault();
    radios[next].focus();
    check(radios[next]);
  });
  container.querySelector('#svc-editor-save')?.addEventListener('click', () => {
    act.saveService?.(model.id, {
      name: container.querySelector('#svc-edit-name')?.value ?? f.name,
      owners: container.querySelector('#svc-edit-owners')?.value ?? f.owners,
      tier,
      description: container.querySelector('#svc-edit-desc')?.value ?? f.description,
    });
  });
}

// The editor's status line repainted in place (the live region stays the
// same node, so the change is announced): the text and the kind class.
export function paintServiceEditorStatus(container, status) {
  const el = container.querySelector('#svc-editor-status');
  if (!el || !status) return;
  el.className = `svc-editor-status is-${status.kind}`;
  el.textContent = status.text;
}

// One document listener per editor host (bound once; idle while no dialog is
// mounted): Escape closes the editor when nothing inside it has the focus —
// the Build editor's rule. Another modal on top keeps its own Escape.
const DOC_ESC = new WeakMap();
function bindDocumentEscape(container, host) {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const bound = DOC_ESC.has(container);
  DOC_ESC.set(container, host);
  if (bound) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dialog = container.querySelector('.svc-editor');
    if (!dialog || (e.target && dialog.contains?.(e.target))) return;
    const open = document.querySelectorAll(TRAPPED_DIALOGS);
    if (open.length && open[open.length - 1] !== dialog) return;
    e.preventDefault();
    DOC_ESC.get(container)?.services?.closeEditor?.();
  });
}

// A control the reader's rank cannot use is drawn, not removed (the honesty
// rule, design §5.6): `aria-disabled="true"` (never `disabled`, so the reason
// stays reachable by keyboard), `.is-unavailable`, and the reason as a
// `.svc-why` line inside it (or inside `into`, a status slot beside it) —
// once, however often the control is repainted. The caller swaps the click
// for host.services.explain(reason).
export function markUnavailable(control, reason, { into = control } = {}) {
  if (!control) return;
  control.setAttribute('aria-disabled', 'true');
  control.classList.add('is-unavailable');
  const slot = into || control;
  let why = slot.querySelector('.svc-why');
  if (!why) {
    slot.insertAdjacentHTML('beforeend', '<span class="svc-why"></span>');
    why = slot.querySelector('.svc-why');
  }
  if (why) why.textContent = reason || '';
}

// A signed-in user in no organisation (§3.4): the server's refusal as is —
// `403: no org membership — ask an admin to add you` — under what was
// checked and as whom, and the one action that works for this user, Sign
// out (the account menu's handler, proxied through host.services.signOut).
// No fabricated way in: the hint names where an admin adds a member
// (Settings → Members) and that a reload is enough once they have.
export function renderNoOrgHome(container, model, host = appHost) {
  const actions = (model.actions || []).map((a) => ({ id: `svc-noorg-${a.id}`, label: a.label }));
  container.innerHTML = `
    <section class="svc-noorg">
      ${emptyStateHtml({ title: model.title, checked: model.checked, body: model.body, actions })}
      ${model.hint ? `<p class="svc-noorg-hint">${escapeHtml(model.hint)}</p>` : ''}
    </section>`;
  container.querySelector('#svc-noorg-sign-out')?.addEventListener('click', () => host.services?.signOut?.());
}
