// studio/settings-view.mjs
//
// The renderers of Settings (docs/STORE_PLAN.md §6 item 3, slice 6b): the
// page — the bar with Back, the head (the h1 and the scope line: the org and
// the reader's role), one banner naming the way in where the server names
// one, the nav of the sections this build draws, and the section on screen
// (its heading, its records, its status line). Renderers only
// (docs/UI_CONVENTIONS.md §2–3): render(container, model, host) over models
// studio/settings-model.mjs built, no state read, no fetch; the Settings
// actions ride `host.settings`, built by the app.mjs controller — reached
// with optional chaining so a headless render under node:test with
// `{ settings: {} }` never throws. Every field is escaped at the seam. A
// control the reader's rank or the server's posture refuses is drawn with
// its reason (markUnavailable, the services axis' atom) and its click
// explains — never usable.

import { host as appHost } from './host.mjs';
import { escapeHtml } from './util.mjs';
import { markUnavailable } from './services-view.mjs';

// The nav: one button per built section — aria-current names the one on
// screen (a section is a page, not a tab panel).
function navHtml(nav) {
  return nav.map((n) => `
          <button type="button" class="set-nav-item" data-section="${escapeHtml(n.id)}" aria-current="${n.current ? 'page' : 'false'}">${escapeHtml(n.label)}</button>`).join('');
}

// The environments, grouped by service: each service's name and slug, "Open
// service" (its page), then one line per environment — the name, the tier
// (or "graded by the pack"), the MCP endpoint it is checked through, the
// bindings and links counted.
function environmentsHtml(model) {
  if (!model.groups.length) return '';
  return `
        <ul class="set-list" aria-label="Services and their environments">${model.groups.map((g) => `
          <li class="set-row" data-service-id="${escapeHtml(String(g.serviceId))}">
            <span class="set-row-name">${escapeHtml(g.name)}</span>
            <span class="set-row-meta">${escapeHtml(g.slug)}</span>
            <button type="button" class="ux-secondary-btn" data-open-service="${escapeHtml(String(g.serviceId))}">Open service</button>
            <ul class="set-envs" aria-label="${escapeHtml(`Environments of ${g.name}`)}">${g.envs.length ? g.envs.map((e) => `
              <li class="set-env" data-env-id="${escapeHtml(String(e.id))}">
                <span class="set-row-name">${escapeHtml(e.name)}</span>
                <span class="set-row-meta">${escapeHtml(`${e.tierText} · MCP: ${e.mcpText} · ${e.bindingsCount} ${e.bindingsCount === 1 ? 'binding' : 'bindings'} · ${e.linksCount} ${e.linksCount === 1 ? 'link' : 'links'}`)}</span>
              </li>`).join('') : `
              <li class="set-env"><span class="set-row-meta">no environments</span></li>`}
            </ul>
          </li>`).join('')}
        </ul>`;
}

// The MCP endpoints: the name, the origin; for an operator and above the
// URL and the token variable's NAME (never a value — the API has none);
// the environments checked through it.
function endpointsHtml(model) {
  if (!model.rows.length) return '';
  return `
        <ul class="set-list" aria-label="MCP endpoints">${model.rows.map((r) => `
          <li class="set-row" data-endpoint-id="${escapeHtml(String(r.id))}">
            <span class="set-row-name">${escapeHtml(r.name)}</span>
            <span class="set-row-meta">${escapeHtml(r.origin)}</span>
            <span class="set-row-facts">${r.url ? `
              <span class="set-row-meta">${escapeHtml(r.url)}</span>` : ''}${r.tokenText ? `
              <span class="set-row-meta">${escapeHtml(r.tokenText)}</span>` : ''}
              <span class="set-row-meta">${escapeHtml(r.boundText)}</span>
            </span>
          </li>`).join('')}
        </ul>`;
}

// The section's status line: reading…, the read's refusal as served with
// Retry, or the empty sentence (with Build for a rank that may build, when
// the org has no service yet).
function statusHtml(section) {
  const { model, status } = section;
  if (status?.kind === 'loading') return escapeHtml(status.text);
  if (model?.error) return `${escapeHtml(model.error)} <button type="button" class="ux-secondary-btn" id="set-retry">Retry</button>`;
  if (model?.empty) return `${escapeHtml(model.empty)}${model.build ? ' <button type="button" class="ux-secondary-btn" id="set-build">Build</button>' : ''}`;
  return '';
}

function sectionHtml(section) {
  if (!section?.id) return '';
  const body = section.id === 'environments' ? environmentsHtml(section.model)
    : section.id === 'endpoints' ? endpointsHtml(section.model) : '';
  const loading = section.status?.kind === 'loading';
  return `
      <section class="set-section" id="set-section" data-section="${escapeHtml(section.id)}" aria-labelledby="set-section-title"${loading ? ' aria-busy="true"' : ''}>
        <h2 class="set-section-title" id="set-section-title">${escapeHtml(section.head.title)}</h2>
        ${section.head.scope ? `<p class="set-section-scope">${escapeHtml(section.head.scope)}</p>` : ''}
        ${body}
        <p class="set-status" id="set-section-status" role="status" aria-live="polite">${statusHtml(section)}</p>
      </section>`;
}

// The page. `frame` is buildSettingsFrameModel(); `section` is { id, head
// (settingsSectionHead), model (the section's build*SectionModel), status
// ({ kind, text } | null) } — or null (the static bundle: the banner alone).
export function renderSettings(container, frame, section, host = appHost) {
  const banner = frame.banner;
  container.innerHTML = `
    <section class="set-page" aria-labelledby="set-title">
      <div class="set-bar">
        <button type="button" class="set-back" id="set-back">← Back</button>
      </div>
      <header class="set-head">
        <h1 class="set-title" id="set-title" tabindex="-1">${escapeHtml(frame.title)}</h1>
        <p class="set-scope">${escapeHtml(frame.scope)}</p>
      </header>
      ${banner ? `<div class="set-banner is-${escapeHtml(banner.kind)}" role="status">${escapeHtml(banner.text)}</div>` : ''}
      ${frame.nav.length ? `
      <div class="set-layout">
        <nav class="set-nav" aria-label="Settings sections">${navHtml(frame.nav)}
        </nav>
        ${sectionHtml(section)}
      </div>` : ''}
    </section>`;

  container.querySelector('#set-back')?.addEventListener('click', () => host.settings?.back?.());
  for (const n of frame.nav) {
    const btn = container.querySelector(`.set-nav-item[data-section="${n.id}"]`);
    if (!btn) continue;
    if (!n.enabled) markUnavailable(btn, n.reason);
    btn.addEventListener('click', () => {
      if (!n.enabled) { host.settings?.explain?.(n.reason); return; }
      host.settings?.selectSection?.(n.id);
    });
  }
  if (!section?.id) return;
  container.querySelector('#set-retry')?.addEventListener('click', () => host.settings?.retry?.(section.id));
  container.querySelector('#set-build')?.addEventListener('click', () => host.settings?.build?.());
  container.querySelectorAll('[data-open-service]').forEach((btn) => {
    btn.addEventListener('click', () => host.settings?.openService?.(Number(btn.dataset.openService)));
  });
}
