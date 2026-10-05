// studio/services-view.mjs
//
// The renderers of the services axis (docs/STORE_PLAN.md §6, slice 6a): the
// Services home, the service page and the no-org home. Renderers only
// (docs/UI_CONVENTIONS.md §2–3): render(container, model, host) over a model
// studio/services-model.mjs built, no state read, no fetch; the services
// actions ride `host.services`, built by the app.mjs controller — reached
// with optional chaining so a headless render under node:test with
// `{ services: {} }` never throws. Every field is escaped at the seam.

import { host as appHost } from './host.mjs';
import { escapeHtml } from './util.mjs';
import { emptyStateHtml } from './ux-kit.mjs';

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
