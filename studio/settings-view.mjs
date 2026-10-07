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
import { escapeHtml, TRAPPED_DIALOGS } from './util.mjs';
import { markUnavailable } from './services-view.mjs';

// The nav: one button per built section — aria-current names the one on
// screen (a section is a page, not a tab panel). The deployment's sections
// (an owner's) under their own head; for a reader who is not an owner, the
// head and one line saying who to ask instead.
function navHtml(nav, deployment = null) {
  const item = (n) => `
          <button type="button" class="set-nav-item" data-section="${escapeHtml(n.id)}" aria-current="${n.current ? 'page' : 'false'}">${escapeHtml(n.label)}</button>`;
  const org = nav.filter((n) => n.group !== 'deployment').map(item).join('');
  if (!deployment) return org;
  const head = `
          <p class="set-nav-group" id="set-nav-deployment">${escapeHtml(deployment.head)}</p>`;
  const rest = deployment.note ? `
          <p class="set-nav-note" id="set-nav-no-owner">${escapeHtml(deployment.note)}</p>` : nav.filter((n) => n.group === 'deployment').map(item).join('');
  return org + head + rest;
}

// The environments, grouped by service: each service's name and slug, "Open
// service" (its page), then one line per environment — the name, the tier
// (or "graded by the pack"), the MCP endpoint it is checked through, the
// bindings and links counted — and, for a rank that may write, Edit… (the
// environment editor over it).
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
                <span class="set-row-meta">${escapeHtml(`${e.tierText} · MCP: ${e.mcpText} · ${e.bindingsCount} ${e.bindingsCount === 1 ? 'binding' : 'bindings'} · ${e.linksCount} ${e.linksCount === 1 ? 'link' : 'links'}`)}</span>${e.canEdit ? `
                <button type="button" class="ux-secondary-btn" data-edit-env="${escapeHtml(String(e.id))}" aria-label="${escapeHtml(`Edit ${e.name} of ${g.name}`)}">Edit…</button>` : ''}
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
            </span>${r.canEdit ? `
            <button type="button" class="ux-secondary-btn" data-edit-endpoint="${escapeHtml(String(r.id))}" aria-label="${escapeHtml(`Edit ${r.name}`)}">Edit…</button>` : ''}
          </li>`).join('')}
        </ul>`;
}

// The members: the login, the name, the role, a disabled badge, since when;
// "you" on the reader's own row. No email (the loaders dropped it). For an
// admin, Change role… and Remove… — Remove… unavailable with the last-admin
// sentence on the org's only enabled admin (an owner passes that rule).
function membersHtml(model) {
  if (!model.rows.length) return '';
  return `
        <ul class="set-list" aria-label="${escapeHtml(`Members of ${model.org.name}`)}">${model.rows.map((r) => `
          <li class="set-row" data-member-id="${escapeHtml(String(r.userId))}">
            <span class="set-row-name">${escapeHtml(r.login)}</span>${r.you ? `
            <span class="set-you">you</span>` : ''}
            <span class="set-row-meta">${escapeHtml([r.name, r.role, r.since ? `since ${String(r.since).slice(0, 10)}` : null].filter(Boolean).join(' · '))}</span>${r.disabled ? `
            <span class="set-badge is-disabled">disabled</span>` : ''}${r.canEdit ? `
            <span class="set-row-actions">
              <button type="button" class="ux-secondary-btn" data-member-role="${escapeHtml(String(r.userId))}" aria-label="${escapeHtml(`Change the role of ${r.login}`)}">Change role…</button>
              <button type="button" class="ux-secondary-btn" data-member-remove="${escapeHtml(String(r.userId))}" aria-label="${escapeHtml(`Remove ${r.login}`)}">Remove…</button>
            </span>` : ''}
          </li>`).join('')}
        </ul>`;
}

// The deployment's users: the login, "you", the badges (owner, disabled,
// must change password, seeded default), how they sign in, their
// organisations and their last sign-in. No email (the loader dropped it).
// For an owner, Manage… (the user's dialog).
function usersHtml(model) {
  if (!model.rows.length) return '';
  return `
        <ul class="set-list" aria-label="Users of this deployment">${model.rows.map((r) => `
          <li class="set-row" data-user-id="${escapeHtml(String(r.id))}">
            <span class="set-row-name">${escapeHtml(r.login)}</span>${r.you ? `
            <span class="set-you">you</span>` : ''}${r.badges.map((b) => `
            <span class="set-badge${b === 'owner' ? ' is-owner' : b === 'disabled' ? ' is-disabled' : ''}">${escapeHtml(b)}</span>`).join('')}
            <span class="set-row-facts">
              <span class="set-row-meta">${escapeHtml([r.name, r.kind, r.memberships, r.lastSignIn].filter(Boolean).join(' · '))}</span>
            </span>${r.canManage ? `
            <button type="button" class="ux-secondary-btn" data-user-manage="${escapeHtml(String(r.id))}" aria-label="${escapeHtml(`Manage ${r.login}`)}">Manage…</button>` : ''}
          </li>`).join('')}
        </ul>`;
}

// The deployment's organisations: the name and id, the default badge, the
// members counted, where the files live, when it was created; a removed one
// greyed with when, its id never used again. For an owner, Remove… on each
// live one — the default org's unavailable with the server's sentence.
function orgsHtml(model) {
  if (!model.rows.length) return '';
  return `
        <ul class="set-list" aria-label="Organisations of this deployment">${model.rows.map((r) => `
          <li class="set-row${r.removed ? ' is-removed' : ''}" data-org-id="${escapeHtml(r.id)}">
            <span class="set-row-name">${escapeHtml(r.name)}</span>
            <span class="set-row-meta">(${escapeHtml(r.id)})</span>${r.isDefault ? `
            <span class="set-badge">default</span>` : ''}
            <span class="set-row-facts">
              <span class="set-row-meta">${escapeHtml(r.facts)}</span>${r.removedText ? `
              <span class="set-row-meta">${escapeHtml(r.removedText)}</span>` : ''}
            </span>${r.remove ? `
            <button type="button" class="ux-secondary-btn" data-org-remove="${escapeHtml(r.id)}" aria-label="${escapeHtml(`Remove ${r.name} (${r.id})`)}">Remove…</button>` : ''}
          </li>`).join('')}
        </ul>`;
}

// The join role: the role recorded (the scope sentence above says what it
// does under the sign-in mode the server runs).
function joinRoleHtml(model) {
  if (!model.roleText) return '';
  return `
        <ul class="set-list" aria-label="The join role">
          <li class="set-row"><span class="set-row-name" id="set-join-role">${escapeHtml(model.roleText)}</span></li>
        </ul>`;
}

// The members section's head line: the org's name and id, and Rename… (an
// admin's; unavailable with its reason otherwise).
function membersOrgHtml(model) {
  return `
        <p class="set-section-scope"><span class="set-row-name">${escapeHtml(model.org.name)}</span>${model.org.id ? ` <span class="set-row-meta">(${escapeHtml(model.org.id)})</span>` : ''}
          <button type="button" class="ux-secondary-btn" id="set-rename">Rename…</button></p>`;
}

// The audit (read-only): the filters — for an owner the scope first; the
// actor as the rows show it; the kind a text input over a list of the kinds
// the server writes today (a later kind stays reachable); the action, the
// target; the days from and through, whole UTC days — then Apply. The rows
// as a table under its caption: when (local time over the ISO in a <time>),
// the org (when the scope spans orgs), the actor as served, the action, the
// target, and the detail — JSON pretty-printed and escaped inside a
// <details>. "Older rows" while the server says there are.
const AUDIT_FIELDS = [
  { name: 'actor', label: 'Actor', type: 'text', max: 200, help: 'a login, local, token, system or cli — as the rows show it' },
  { name: 'kind', label: 'Kind', type: 'text', list: 'set-audit-kinds' },
  { name: 'action', label: 'Action', type: 'text', help: '<kind>.<verb>' },
  { name: 'targetKind', label: 'Target kind', type: 'text', max: 100 },
  { name: 'targetId', label: 'Target id', type: 'text', max: 200 },
  { name: 'from', label: 'From (UTC day)', type: 'date' },
  { name: 'through', label: 'Through (UTC day)', type: 'date' },
];
const auditFieldId = (name) => `set-audit-${name}`;

function auditFiltersHtml(model, filters) {
  const f = filters || {};
  const scope = model.scopeControl ? `
          <label class="set-editor-field">
            <span class="set-editor-label">Scope</span>
            <select id="${auditFieldId('scope')}" name="scope">${model.scopeControl.options.map((o) => `
              <option value="${escapeHtml(o.value)}"${o.value === model.scopeControl.value ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
            </select>
          </label>` : '';
  const fields = AUDIT_FIELDS.map((d) => {
    const id = auditFieldId(d.name);
    const help = d.help ? `<span class="set-editor-help" id="${id}-help">${escapeHtml(d.help)}</span>` : '';
    return `
          <label class="set-editor-field">
            <span class="set-editor-label">${escapeHtml(d.label)}</span>
            <input id="${id}" name="${d.name}" type="${d.type}" value="${escapeHtml(String(f[d.name] ?? ''))}"${d.max ? ` maxlength="${d.max}"` : ''}${d.list ? ` list="${d.list}"` : ''} autocomplete="off" spellcheck="false"${d.help ? ` aria-describedby="${id}-help"` : ''}>
            ${help}
          </label>`;
  }).join('');
  return `
        <form class="set-audit-filters" id="set-audit-filters" aria-label="Filter the audit">${scope}${fields}
          <datalist id="set-audit-kinds">${(model.kinds || []).map((k) => `<option value="${escapeHtml(k)}"></option>`).join('')}</datalist>
          <button type="submit" class="mcp-refresh-btn" id="set-audit-apply">Apply</button>
        </form>`;
}

function auditHtml(model, filters) {
  const table = model.caption ? `
        <div class="set-audit-wrap">
        <table class="set-audit">
          <caption>${escapeHtml(model.caption)}</caption>
          <thead><tr><th scope="col">When</th>${model.showOrg ? '<th scope="col">Org</th>' : ''}<th scope="col">Actor</th><th scope="col">Action</th><th scope="col">Target</th><th scope="col">Detail</th></tr></thead>
          <tbody>${model.rows.map((r) => `
            <tr data-seq="${escapeHtml(String(r.seq))}">
              <td><time datetime="${escapeHtml(r.iso)}">${escapeHtml(r.when)}</time></td>${model.showOrg ? `
              <td>${escapeHtml(r.org ?? '—')}</td>` : ''}
              <td class="set-audit-actor">${escapeHtml(r.actor)}</td>
              <td>${escapeHtml(r.action)}</td>
              <td>${escapeHtml(r.target)}</td>
              <td class="set-audit-detail"><details><summary>detail</summary><pre>${escapeHtml(r.detailJson)}</pre></details></td>
            </tr>`).join('')}
          </tbody>
        </table>
        </div>` : '';
  const more = model.more ? `
        <button type="button" class="ux-secondary-btn" id="set-audit-more">Older rows</button>` : '';
  return auditFiltersHtml(model, filters) + table + more;
}

// The section's status line: reading…, the read's refusal as served with
// Retry, what the last write did, or the empty sentence (with Build for a rank that may build, when
// the org has no service yet).
function statusHtml(section) {
  const { model, status } = section;
  if (status?.kind === 'loading') return escapeHtml(status.text);
  // A refusal of what was asked (the audit's filters: a 400) is not retried
  // as is — the filters above are the way out.
  if (model?.error) return `${escapeHtml(model.error)}${model.retry === false ? '' : ' <button type="button" class="ux-secondary-btn" id="set-retry">Retry</button>'}`;
  // What the last write did (a delete: the record is gone from the list,
  // so its sentence stays here), then the empty sentence.
  const notice = status?.kind === 'ok' && status.text ? escapeHtml(status.text) : '';
  if (model?.empty) return `${notice ? `${notice} ` : ''}${escapeHtml(model.empty)}${model.build ? ' <button type="button" class="ux-secondary-btn" id="set-build">Build</button>' : ''}`;
  // The audit's last page: the server said there is nothing older.
  if (model?.end) return `${notice ? `${notice} ` : ''}${escapeHtml(model.end)}`;
  return notice;
}

// The section's primary action (the editor that creates a record), drawn
// once its editor is built — unavailable with its reason for a rank that
// cannot use it.
const PRIMARY_LABEL = { environments: 'Add environment', endpoints: 'New MCP endpoint', members: 'Add member', users: 'New local user', orgs: 'New organisation', 'join-role': 'Change the join role…' };
const PRIMARY_KIND = { environments: 'environment', endpoints: 'endpoint', members: 'member-add', users: 'user-create', orgs: 'org-create', 'join-role': 'join-role' };

function sectionHtml(section) {
  if (!section?.id) return '';
  const primary = section.model?.primary && PRIMARY_LABEL[section.id]
    ? `<button type="button" class="mcp-refresh-btn set-primary" id="set-primary">${escapeHtml(PRIMARY_LABEL[section.id])}</button>` : '';
  const body = section.id === 'environments' ? environmentsHtml(section.model)
    : section.id === 'endpoints' ? endpointsHtml(section.model)
      : section.id === 'members' ? membersHtml(section.model)
        : section.id === 'audit' ? auditHtml(section.model, section.filters)
          : section.id === 'users' ? usersHtml(section.model)
            : section.id === 'orgs' ? orgsHtml(section.model)
              : section.id === 'join-role' ? joinRoleHtml(section.model) : '';
  const loading = section.status?.kind === 'loading';
  // The scope sentence: the head's, or the section model's own (the members name the org's id).
  const scope = section.head.scope ?? section.model?.scopeSentence ?? null;
  return `
      <section class="set-section" id="set-section" data-section="${escapeHtml(section.id)}" aria-labelledby="set-section-title"${loading ? ' aria-busy="true"' : ''}>
        <h2 class="set-section-title" id="set-section-title">${escapeHtml(section.head.title)}</h2>
        ${scope ? `<p class="set-section-scope">${escapeHtml(scope)}</p>` : ''}
        ${section.id === 'members' && section.model?.org ? membersOrgHtml(section.model) : ''}
        ${primary}
        ${body}
        <p class="set-status" id="set-section-status" role="status" aria-live="polite">${statusHtml(section)}</p>
      </section>`;
}

// The page. `frame` is buildSettingsFrameModel(); `section` is { id, head
// (settingsSectionHead), model (the section's build*SectionModel), status
// ({ kind, text } | null); the audit's also its applied filters and the
// drafts readAuditDrafts() read before the repaint } — or null (the static
// bundle: the banner alone).
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
        <nav class="set-nav" aria-label="Settings sections">${navHtml(frame.nav, frame.deployment)}
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
  const primary = section.model?.primary;
  const primaryBtn = container.querySelector('#set-primary');
  if (primaryBtn && primary) {
    if (!primary.enabled) markUnavailable(primaryBtn, primary.reason);
    const kind = PRIMARY_KIND[section.id];
    primaryBtn.addEventListener('click', () => {
      if (!primary.enabled) { host.settings?.explain?.(primary.reason); return; }
      host.settings?.openEditor?.({ kind });
    });
  }
  container.querySelectorAll('[data-edit-endpoint]').forEach((btn) => {
    btn.addEventListener('click', () => host.settings?.openEditor?.({ kind: 'endpoint', id: Number(btn.dataset.editEndpoint) }));
  });
  container.querySelectorAll('[data-edit-env]').forEach((btn) => {
    btn.addEventListener('click', () => host.settings?.openEditor?.({ kind: 'environment', id: Number(btn.dataset.editEnv) }));
  });
  if (section.id === 'members') wireMembers(container, section.model, host);
  container.querySelectorAll('[data-user-manage]').forEach((btn) => {
    btn.addEventListener('click', () => host.settings?.openEditor?.({ kind: 'user', id: Number(btn.dataset.userManage) }));
  });
  // An organisation's Remove…: its dialog on the remove step, or why not.
  container.querySelectorAll('[data-org-remove]').forEach((btn) => {
    const row = (section.model?.rows || []).find((r) => r.id === btn.dataset.orgRemove);
    const reason = row?.remove && !row.remove.enabled ? row.remove.reason : null;
    if (reason) markUnavailable(btn, reason);
    btn.addEventListener('click', () => {
      if (reason) { host.settings?.explain?.(reason); return; }
      host.settings?.openEditor?.({ kind: 'org', id: btn.dataset.orgRemove, step: 'confirm-delete' });
    });
  });
  if (section.id === 'audit') {
    for (const [name, v] of section.drafts || []) { const el = container.querySelector(`#${auditFieldId(name)}`); if (el) el.value = v; }
    wireAudit(container, section.model, host);
  }
}

// The audit's filters as typed in the form on screen (Apply not pressed
// yet), read before a repaint of the section (a read settling, Older rows)
// so it draws them again (section.drafts) instead of the applied ones —
// typing during a read loses nothing. Null when no audit form is on screen.
export function readAuditDrafts(container) {
  if (!container.querySelector('#set-audit-filters')) return null;
  const out = [];
  for (const name of ['scope', ...AUDIT_FIELDS.map((d) => d.name)]) {
    const v = container.querySelector(`#${auditFieldId(name)}`)?.value;
    if (typeof v === 'string') out.push([name, v]);
  }
  return out;
}

// The audit's controls: Apply hands the filled filters to
// host.settings.auditApply (the list starts again); Older rows asks for the
// next page.
function wireAudit(container, model, host) {
  const form = container.querySelector('#set-audit-filters');
  const read = () => {
    const out = {};
    for (const name of [...(model?.scopeControl ? ['scope'] : []), ...AUDIT_FIELDS.map((d) => d.name)]) {
      const v = container.querySelector(`#${auditFieldId(name)}`)?.value;
      if (typeof v === 'string' && v.trim()) out[name] = v.trim();
    }
    return out;
  };
  form?.addEventListener('submit', (e) => { e?.preventDefault?.(); host.settings?.auditApply?.(read()); });
  container.querySelector('#set-audit-more')?.addEventListener('click', () => host.settings?.auditMore?.());
}

// The members' controls: Rename… (the org's name), and each row's Change
// role… and Remove… — Remove… opens the member's dialog on its remove step;
// one the rank or the last-admin rule refuses is unavailable with its reason,
// and its click explains.
function wireMembers(container, model, host) {
  const rename = container.querySelector('#set-rename');
  if (rename && model?.org) {
    if (!model.org.canRename) markUnavailable(rename, model.org.renameReason);
    rename.addEventListener('click', () => {
      if (!model.org.canRename) { host.settings?.explain?.(model.org.renameReason); return; }
      host.settings?.openEditor?.({ kind: 'org-name', id: model.org.id });
    });
  }
  const rowOf = (id) => (model?.rows || []).find((r) => String(r.userId) === id) || null;
  container.querySelectorAll('[data-member-role]').forEach((btn) => {
    btn.addEventListener('click', () => host.settings?.openEditor?.({ kind: 'member', id: Number(btn.dataset.memberRole) }));
  });
  container.querySelectorAll('[data-member-remove]').forEach((btn) => {
    const row = rowOf(btn.dataset.memberRemove);
    const reason = row?.reasons?.remove ?? null;
    if (reason) markUnavailable(btn, reason);
    btn.addEventListener('click', () => {
      if (reason) { host.settings?.explain?.(reason); return; }
      host.settings?.openEditor?.({ kind: 'member', id: Number(btn.dataset.memberRemove), step: 'confirm-delete' });
    });
  });
}

// ---------- the record editor (design §5, the editor idiom) ----------

const fieldId = (name) => `set-edit-${name}`;
const INPUT_TYPES = new Set(['text', 'url', 'email']);

// One field: its label, the help under it (named by aria-describedby), the
// control. The token variable's input asks for capitals; nothing is spell-
// checked or autocompleted (names, URLs and variable names).
function fieldHtml(f, limits) {
  const id = fieldId(f.name);
  const help = f.help ? `<span class="set-editor-help" id="${id}-help">${escapeHtml(f.help)}</span>` : '';
  const described = f.help ? ` aria-describedby="${id}-help"` : '';
  const max = limits?.[f.name] ?? f.max ?? null;
  const maxAttr = max ? ` maxlength="${escapeHtml(String(max))}"` : '';
  if (INPUT_TYPES.has(f.type)) {
    const caps = f.name === 'readTokenEnv' ? ' autocapitalize="characters"' : '';
    return `
        <label class="set-editor-field">
          <span class="set-editor-label">${escapeHtml(f.label)}</span>
          <input id="${id}" name="${escapeHtml(f.name)}" type="${f.type}" value="${escapeHtml(String(f.value ?? ''))}"${maxAttr} autocomplete="off" spellcheck="false"${caps}${described}>
          ${help}
        </label>`;
  }
  if (f.type === 'textarea') {
    return `
        <label class="set-editor-field">
          <span class="set-editor-label">${escapeHtml(f.label)}</span>
          <textarea id="${id}" name="${escapeHtml(f.name)}" rows="4" spellcheck="false"${described}>${escapeHtml(String(f.value ?? ''))}</textarea>
          ${help}
        </label>`;
  }
  if (f.type === 'select') {
    // An option's value null is drawn as "" (none); a field the reader cannot
    // change stays focusable, aria-disabled, its reason the help it names.
    const off = f.disabled ? ' aria-disabled="true"' : '';
    return `
        <label class="set-editor-field">
          <span class="set-editor-label">${escapeHtml(f.label)}</span>
          <select id="${id}" name="${escapeHtml(f.name)}"${off}${described}>${(f.options || []).map((o) => `
            <option value="${escapeHtml(o.value === null || o.value === undefined ? '' : String(o.value))}"${o.selected ? ' selected' : ''}>${escapeHtml(o.label)}</option>`).join('')}
          </select>
          ${help}
        </label>`;
  }
  if (f.type === 'segmented' || f.type === 'radio') {
    // A radio group of buttons (roving tabindex): an option's value null is "".
    // An option the reader cannot choose is aria-disabled (its reason is the
    // group's help, said once).
    return `
        <div class="set-editor-field" role="radiogroup" aria-labelledby="${id}-label"${described}>
          <span class="set-editor-label" id="${id}-label">${escapeHtml(f.label)}</span>
          <div class="set-editor-seg" id="${id}">${(f.options || []).map((o) => `
            <button type="button" role="radio" class="set-editor-seg-btn" data-seg="${escapeHtml(f.name)}" data-value="${escapeHtml(o.value === null || o.value === undefined ? '' : String(o.value))}" aria-checked="${o.selected ? 'true' : 'false'}"${o.enabled === false ? ' aria-disabled="true"' : ''} tabindex="${o.selected ? '0' : '-1'}">${escapeHtml(o.label)}</button>`).join('')}
          </div>
          ${help}
        </div>`;
  }
  if (f.type === 'checkbox') {
    // A box to tick (take over a directory; the join role's admin
    // confirmation — drawn while its condition holds: f.showWhen).
    const shown = !f.showWhen || f.showWhen.now === true;
    return `
        <label class="set-editor-field set-editor-check" id="${id}-field"${shown ? '' : ' hidden'}>
          <input id="${id}" name="${escapeHtml(f.name)}" type="checkbox"${f.checked ? ' checked' : ''}${described}>
          <span class="set-editor-check-text">${escapeHtml(f.label)}</span>
          ${help}
        </label>`;
  }
  throw new Error(`no Settings editor field of type ${JSON.stringify(f.type)}`);
}

// The footer's buttons by step: editing — Close, Delete… (a record), the
// primary; the delete step — Back and the danger button naming the record.
function editorActionsHtml(model) {
  // The secret step and the step after one's own sign-out: Close, and Go to
  // sign-in when this browser's session has ended or sign-in just came on.
  if (model.step === 'secret' || model.step === 'notice') {
    return `
          <button type="button" class="ctrl-btn set-editor-cancel" data-editor-close>Close</button>${model.signIn ? `
          <button type="button" class="mcp-refresh-btn set-editor-save" id="set-editor-signin">Go to sign-in</button>` : ''}${model.switchTo ? `
          <button type="button" class="mcp-refresh-btn set-editor-save" id="set-editor-switch">${escapeHtml(model.switchTo.label)}</button>` : ''}`;
  }
  if ((model.step === 'confirm-delete' || model.step === 'confirm-action') && model.confirm) {
    // A removal that asks for the id typed: unavailable until it matches.
    const typed = model.confirm.typed ? ' aria-describedby="set-editor-typed-label"' : '';
    return `
          <button type="button" class="ctrl-btn set-editor-cancel" id="set-editor-back">Back</button>
          <button type="button" class="set-danger" id="set-editor-confirm" aria-disabled="${model.saving || model.confirm.typed ? 'true' : 'false'}"${typed}>${escapeHtml(model.confirm.danger)}</button>`;
  }
  return `
          <button type="button" class="ctrl-btn set-editor-cancel" data-editor-close>Close</button>${model.remove ? `
          <button type="button" class="ctrl-btn set-editor-delete" id="set-editor-delete">${escapeHtml(model.remove.label || 'Delete…')}</button>` : ''}${model.primary ? `
          <button type="button" class="mcp-refresh-btn set-editor-save" id="set-editor-save" aria-disabled="${model.primary.enabled ? 'false' : 'true'}">${escapeHtml(model.primary.label)}</button>` : ''}`;
}

// The editor's body by step: the consequence sentence (a confirm step); the
// temporary password, once, beside its sentence and Copy (the secret step);
// nothing but the status line (the step after one's own sign-out); a user's
// facts and actions; else the kind's fields.
function editorBodyHtml(model) {
  const confirming = (model.step === 'confirm-delete' || model.step === 'confirm-action') && model.confirm;
  if (confirming) return `
        <p class="set-confirm" id="set-editor-confirm-text">${escapeHtml(model.confirm.text)}</p>${model.confirm.typed ? `
        <label class="set-editor-field set-editor-typed">
          <span class="set-editor-typed-label" id="set-editor-typed-label">Type <code>${escapeHtml(model.confirm.typed)}</code> to remove it</span>
          <input id="set-editor-typed" type="text" autocomplete="off" spellcheck="false" autocapitalize="none">
        </label>` : ''}`;
  if (model.step === 'secret' && model.secret) return `
        <div class="set-secret">
          <p class="set-secret-text">${escapeHtml(model.secret.text)}</p>
          <code class="set-secret-value" id="set-secret-value">${escapeHtml(model.secret.value)}</code>
          <button type="button" class="ux-secondary-btn" id="set-secret-copy">Copy</button>
        </div>`;
  if (model.step === 'notice') return '';
  if (model.kind === 'org') return (model.facts || []).map((f) => `
        <p class="set-row-meta set-user-fact">${escapeHtml(f)}</p>`).join('');
  if (model.kind === 'user') return `${(model.facts || []).map((f) => `
        <p class="set-row-meta set-user-fact">${escapeHtml(f)}</p>`).join('')}
        <div class="set-row-actions set-user-actions" role="group" aria-label="${escapeHtml(`Actions on ${model.title}`)}">${(model.actions || []).map((a) => `
          <button type="button" class="ux-secondary-btn" data-user-action="${escapeHtml(a.id)}">${escapeHtml(a.label)}</button>`).join('')}
        </div>`;
  return (model.fields || []).map((f) => fieldHtml(f, model.limits)).join('');
}

// The editor (buildSettingsEditorModel): a scrim and a modal dialog drawn
// into its own host on <body>, so a section repaint keeps it. Its head names
// the record kind and the record; the body is the kind's fields, or — the
// delete step — the consequence sentence; the footer the status line (a
// live region: the idle hint, Saving…, what the server changed or its
// refusal as served) and the buttons. Rendered again for the same record
// and step, only the status and the buttons' state are repainted: what was
// typed and the focus stay. Close, the scrim, esc and Escape →
// host.settings.closeEditor(); the primary hands what was typed to
// host.settings.save(draft); Delete… / Back → host.settings.step(step,
// draft); the danger button → host.settings.confirm().
export function renderSettingsEditor(container, model, host = appHost) {
  // A user's dialog is drawn anew when its facts or its actions change (an
  // action done: Disable… becomes Enable…); every other kind by record and step.
  const key = `${model.kind}:${model.id ?? 'new'}:${model.step}${model.kind === 'user' ? `:${shortHash(JSON.stringify([model.facts, model.actions]))}` : ''}`;
  const mounted = container.querySelector('.set-editor');
  if (mounted && mounted.getAttribute('data-editor-key') === key) {
    paintSettingsEditorStatus(container, model.status);
    paintEditorButtons(container, model);
    return;
  }
  container.innerHTML = `
    <div class="set-editor-scrim" data-editor-close aria-hidden="true"></div>
    <div class="set-editor" role="dialog" aria-modal="true" aria-labelledby="set-editor-title" aria-describedby="set-editor-status" data-kind="${escapeHtml(model.kind)}" data-record-id="${escapeHtml(String(model.id ?? ''))}" data-editor-key="${escapeHtml(key)}" tabindex="-1">
      <header class="set-editor-head">
        <span class="set-editor-eyebrow">${escapeHtml(model.eyebrow)}</span>
        <h2 class="set-editor-title" id="set-editor-title">${escapeHtml(model.title)}</h2>
        <button type="button" class="set-editor-close" data-editor-close aria-label="Close the editor (Esc)"><span aria-hidden="true">esc</span></button>
      </header>
      <div class="set-editor-body">${editorBodyHtml(model)}
      </div>
      <footer class="set-editor-foot">
        <div class="set-editor-status is-${escapeHtml(model.status.kind)}" id="set-editor-status" role="status" aria-live="polite">${escapeHtml(model.status.text)}</div>
        <div class="set-editor-actions">${editorActionsHtml(model)}
        </div>
      </footer>
    </div>`;
  const act = () => host.settings || {};
  for (const el of container.querySelectorAll('[data-editor-close]') || []) el.addEventListener('click', () => act().closeEditor?.());
  container.querySelector('.set-editor')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    act().closeEditor?.();
  });
  bindDocumentEscape(container, host);
  const segs = wireSegmented(container, model.fields || [], {
    explain: (reason) => act().explain?.(reason),
    // Add member: "by login" / "by verified email" relabels the one input.
    // A box drawn on a choice (the join role's admin) follows it.
    change: (name, value) => {
      GATES.get(container)?.();
      if (model.kind !== 'member-add' || name !== 'by') return;
      const input = container.querySelector(`#${fieldId('value')}`);
      const label = input?.closest?.('.set-editor-field')?.querySelector?.('.set-editor-label');
      if (input) input.type = value === 'email' ? 'email' : 'text';
      if (label) label.textContent = value === 'email' ? 'Verified email' : 'Login';
    },
  });
  // What was typed, by field: a segmented group's checked value ("" → null);
  // a select the reader cannot change is left out (undefined — the binding it
  // shows is kept, never resent nor nulled); the rest by its value.
  const readDraft = () => Object.fromEntries((model.fields || []).map((f) => {
    if (f.type === 'segmented' || f.type === 'radio') return [f.name, Object.hasOwn(segs, f.name) ? segs[f.name] : (f.value ?? null)];
    if (f.type === 'select' && f.disabled) return [f.name, undefined];
    if (f.type === 'checkbox') return [f.name, (container.querySelector(`#${fieldId(f.name)}`)?.checked ?? f.checked) === true];
    return [f.name, container.querySelector(`#${fieldId(f.name)}`)?.value ?? f.value];
  }));
  // A box drawn on a choice is shown while the choice holds; one that is
  // required and unticked keeps Save unavailable with its reason (the
  // join role's admin: "tick the box first"). Answers that reason, or null.
  const gate = () => {
    let reason = null;
    for (const f of (model.fields || []).filter((x) => x.type === 'checkbox')) {
      const shown = !f.showWhen || (Object.hasOwn(segs, f.showWhen.field) ? segs[f.showWhen.field] : f.showWhen.now ? f.showWhen.value : null) === f.showWhen.value;
      const wrap = container.querySelector(`#${fieldId(f.name)}-field`);
      if (wrap) wrap.hidden = !shown;
      const ticked = (container.querySelector(`#${fieldId(f.name)}`)?.checked ?? f.checked) === true;
      if (shown && f.required && !ticked && reason === null) reason = f.required;
    }
    const now = EDITOR_MODEL.get(container) || model;
    const save = container.querySelector('#set-editor-save');
    if (save && now.primary?.enabled && !now.saving) {
      if (reason) markUnavailable(save, reason);
      else markAvailable(save);
    }
    return reason;
  };
  GATES.set(container, gate);
  for (const f of (model.fields || []).filter((x) => x.type === 'checkbox')) {
    container.querySelector(`#${fieldId(f.name)}`)?.addEventListener('change', () => gate());
  }
  // A select drawn aria-disabled cannot change: a change is undone and its reason said.
  for (const f of (model.fields || []).filter((x) => x.type === 'select' && x.disabled)) {
    const el = container.querySelector(`#${fieldId(f.name)}`);
    const was = el?.value;
    el?.addEventListener('change', () => { el.value = was; act().explain?.(f.reason); });
  }
  paintEditorButtons(container, model);
  container.querySelector('#set-editor-save')?.addEventListener('click', () => {
    const now = EDITOR_MODEL.get(container) || model;
    if (!now.primary.enabled) {
      if (now.primary.reason && !now.saving) act().explain?.(now.primary.reason);
      return;
    }
    const held = gate();
    if (held) { act().explain?.(held); return; }
    act().save?.(readDraft());
  });
  container.querySelector('#set-editor-delete')?.addEventListener('click', () => {
    const now = EDITOR_MODEL.get(container) || model;
    if (now.remove && !now.remove.enabled) { act().explain?.(now.remove.reason); return; }
    act().step?.('confirm-delete', readDraft());
  });
  container.querySelector('#set-editor-back')?.addEventListener('click', () => act().step?.('edit'));
  // A user's actions: each opens its confirm step, or says why it is unavailable.
  container.querySelectorAll('[data-user-action]').forEach((btn) => {
    const a = (model.actions || []).find((x) => x.id === btn.dataset.userAction);
    if (a && !a.enabled) markUnavailable(btn, a.reason);
    btn.addEventListener('click', () => {
      if (!a || !a.enabled) { host.settings?.explain?.(a?.reason ?? null); return; }
      host.settings?.step?.(`confirm-action:${a.id}`);
    });
  });
  container.querySelector('#set-secret-copy')?.addEventListener('click', () => host.settings?.copySecret?.());
  container.querySelector('#set-editor-signin')?.addEventListener('click', () => host.settings?.signIn?.());
  container.querySelector('#set-editor-switch')?.addEventListener('click', () => {
    if (model.switchTo) host.settings?.switchTo?.(model.switchTo.orgId, 'members');
  });
  // A removal asking for the id typed: the danger button follows the input.
  const typedInput = container.querySelector('#set-editor-typed');
  typedInput?.addEventListener('input', () => paintEditorButtons(container, EDITOR_MODEL.get(container) || model));
  container.querySelector('#set-editor-confirm')?.addEventListener('click', () => {
    const now = EDITOR_MODEL.get(container) || model;
    if (now.saving) return;
    const typed = now.confirm?.typed ?? null;
    if (typed) {
      const value = String(container.querySelector('#set-editor-typed')?.value ?? '').trim();
      if (value !== typed) { act().explain?.(`Type ${typed} to remove it`); return; }
      act().confirm?.(value);
      return;
    }
    act().confirm?.();
  });
}

// Undo markUnavailable (a gate lifted: the box ticked).
function markAvailable(control) {
  control.setAttribute('aria-disabled', 'false');
  control.classList?.remove?.('is-unavailable');
  control.querySelector?.('.svc-why')?.remove?.();
}

// A short, stable digest of a string (an editor key's part; not a secret's).
function shortHash(text) {
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h * 33) ^ text.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

// The segmented groups: a click checks one; ArrowLeft / ArrowRight / Home /
// End move and check (roving tabindex — 6a's tier radios). Returns the
// checked value per group, kept current ("" → null).
function wireSegmented(container, fields, { explain = null, change = null } = {}) {
  const values = {};
  for (const f of fields.filter((x) => x.type === 'segmented' || x.type === 'radio')) {
    const radios = [...(container.querySelectorAll(`[data-seg="${f.name}"]`) || [])];
    if (!radios.length) continue;
    values[f.name] = f.value ?? null;
    // An option drawn aria-disabled is not checked: its click says why (the group's help).
    const off = (btn) => btn.getAttribute?.('aria-disabled') === 'true';
    const check = (btn) => {
      if (off(btn)) { explain?.(f.help); return; }
      values[f.name] = btn.dataset.value === '' ? null : btn.dataset.value;
      for (const r of radios) { r.setAttribute('aria-checked', r === btn ? 'true' : 'false'); r.setAttribute('tabindex', r === btn ? '0' : '-1'); }
      change?.(f.name, values[f.name]);
    };
    radios.forEach((btn) => btn.addEventListener('click', () => check(btn)));
    container.querySelector(`#${fieldId(f.name)}`)?.addEventListener('keydown', (e) => {
      const i = radios.indexOf(e.target?.closest?.('[role="radio"]'));
      if (i < 0) return;
      // The arrows move over the choices that can be made.
      const usable = radios.filter((r) => !off(r));
      const at = usable.indexOf(radios[i]);
      let next = null;
      if (!usable.length) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') next = usable[(at + 1) % usable.length];
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') next = usable[(at - 1 + usable.length) % usable.length];
      else if (e.key === 'Home') next = usable[0];
      else if (e.key === 'End') next = usable[usable.length - 1];
      if (!next) return;
      e.preventDefault();
      next.focus();
      check(next);
    });
  }
  return values;
}

// The model the buttons were last painted from (a repaint in place keeps
// the listeners, which read it), and the dialog's gate (a required box).
const EDITOR_MODEL = new WeakMap();
const GATES = new WeakMap();

// The buttons' state: the primary aria-disabled while a call is pending,
// and unavailable with its reason for a rank that cannot use it (never
// `disabled`: the reason stays reachable); the same for Delete….
function paintEditorButtons(container, model) {
  EDITOR_MODEL.set(container, model);
  const save = model.primary ? container.querySelector('#set-editor-save') : null;
  if (save) {
    if (!model.primary.enabled && !model.saving) markUnavailable(save, model.primary.reason);
    else save.setAttribute('aria-disabled', model.saving ? 'true' : 'false');
  }
  const del = container.querySelector('#set-editor-delete');
  if (del && model.remove && !model.remove.enabled) markUnavailable(del, model.remove.reason);
  const typed = model.confirm?.typed ?? null;
  const mismatch = Boolean(typed) && String(container.querySelector('#set-editor-typed')?.value ?? '').trim() !== typed;
  container.querySelector('#set-editor-confirm')?.setAttribute('aria-disabled', model.saving || mismatch ? 'true' : 'false');
  GATES.get(container)?.();
}

// The editor's status line repainted in place (the live region stays the
// same node, so the change is announced): the text and the kind class.
export function paintSettingsEditorStatus(container, status) {
  const el = container.querySelector('#set-editor-status');
  if (!el || !status) return;
  el.className = `set-editor-status is-${status.kind}`;
  el.textContent = status.text;
}

// The MCP target (design §6): drawn before a picker's URL field — the org's
// registered endpoints (`name — origin`, each option carrying the name and
// the origin it shows, never a URL or a variable), then "Type a URL…"; or,
// when the org has none, the sentence saying so (with the way to Settings →
// MCP endpoints for a reader known to be an admin). `model` is
// mcpTargetModel(); the container is hidden when there is nothing to draw.
// A change is the controller's (host.settings.pickMcpTarget: the URL row and
// the auth help follow); the select is not redrawn under the focus.
export function renderMcpTarget(container, model, host = appHost) {
  if (!container) return;
  const select = model?.show ? `
    <select class="set-mcp-target" aria-label="Registered MCP endpoint">${model.options.map((o) => `
      <option value="${escapeHtml(o.value)}"${o.value === model.value ? ' selected' : ''}${o.name ? ` data-name="${escapeHtml(o.name)}"` : ''}${o.origin ? ` data-origin="${escapeHtml(o.origin)}"` : ''}>${escapeHtml(o.label)}</option>`).join('')}
    </select>` : '';
  const hint = model?.hint ? `
    <span class="set-mcp-target-hint">${escapeHtml(model.hint.text)}${model.hint.button ? ` <button type="button" class="ux-secondary-btn" data-mcp-target-settings>${escapeHtml(model.hint.button)}</button>` : ''}</span>` : '';
  container.innerHTML = select + hint;
  container.hidden = !select && !hint;
  const sel = container.querySelector('select.set-mcp-target');
  sel?.addEventListener('change', () => host?.settings?.pickMcpTarget?.(container, sel.value));
  container.querySelector('[data-mcp-target-settings]')?.addEventListener('click', () => host?.settings?.openMcpEndpoints?.());
}

// One document listener per editor host (bound once; idle while no dialog is
// mounted): Escape closes the editor when nothing inside it has the focus,
// unless another modal is on top of it (that one keeps its own Escape).
const DOC_ESC = new WeakMap();
function bindDocumentEscape(container, host) {
  if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  const bound = DOC_ESC.has(container);
  DOC_ESC.set(container, host);
  if (bound) return;
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    const dialog = container.querySelector('.set-editor');
    if (!dialog || (e.target && dialog.contains?.(e.target))) return;
    const open = document.querySelectorAll(TRAPPED_DIALOGS);
    if (open.length && open[open.length - 1] !== dialog) return;
    e.preventDefault();
    DOC_ESC.get(container)?.settings?.closeEditor?.();
  });
}
