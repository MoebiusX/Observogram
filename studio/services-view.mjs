// studio/services-view.mjs
//
// The renderers of the services axis (docs/STORE_PLAN.md §6, slice 6a): the
// Services home (renderServicesHome, markUnavailable), the service page and
// the no-org home. Renderers only
// (docs/UI_CONVENTIONS.md §2–3): render(container, model, host) over a model
// studio/services-model.mjs built, no state read, no fetch; the services
// actions ride `host.services`, built by the app.mjs controller — reached
// with optional chaining so a headless render under node:test with
// `{ services: {} }` never throws. Every field is escaped at the seam.

import { host as appHost } from './host.mjs';
import { escapeHtml, fmtRelative } from './util.mjs';
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
// table could not be read — then the catalogue packs apart. The controller
// fills the import sources below this container. Actions: a card →
// host.services.openService(id, slug); a derived tile → openDerived(key); a
// catalogue row → openPack(id); Retry → retry(). The search filters the grid.
export function renderServicesHome(container, model, host = appHost) {
  let section;
  if (model.kind === 'table') {
    section = gridHtml(model.heading, model.cards.map(serviceCardHtml).join(''));
  } else if (model.kind === 'empty') {
    section = `<p class="home-check-empty">${escapeHtml(model.empty.title)} ${escapeHtml(model.empty.body)}</p>`;
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
// No fabricated way in: the studio has no member screen until Settings
// (6b); the server's sentence names the way out that works.
export function renderNoOrgHome(container, model, host = appHost) {
  const actions = (model.actions || []).map((a) => ({ id: `svc-noorg-${a.id}`, label: a.label }));
  container.innerHTML = `
    <section class="svc-noorg">
      ${emptyStateHtml({ title: model.title, checked: model.checked, body: model.body, actions })}
      ${model.hint ? `<p class="svc-noorg-hint">${escapeHtml(model.hint)}</p>` : ''}
    </section>`;
  container.querySelector('#svc-noorg-sign-out')?.addEventListener('click', () => host.services?.signOut?.());
}
