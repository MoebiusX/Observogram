// server/route-table.mjs — every route the server registers, and who may
// call it (docs/STORE_PLAN.md §5, slice 3). Pure data: no imports.
//
// Every route registers `authorize('<METHOD> <path>')` (server/authz.mjs)
// as its first handler, per method; authorize() looks the key up here at
// registration and throws on a key this table does not hold, so an
// unclassified route fails every server suite at import.
// server/test-authz.mjs walks the app's router (server/fixtures/
// route-inventory.mjs) and fails on a route whose first handler is not its
// own guard, a stale entry, an unexpected middleware or a class that
// disagrees with its own literal EXPECTED_CLASS.
//
// The key is `${METHOD} ${path}` exactly as registered; the SPA fallback's
// is `GET ${String(regex)}`.
//
// Entry fields (defaults filled by routeEntry()):
//   class        public · self · viewer · operator · admin · owner (required)
//   audit        the audit actions a successful call writes in this build,
//                exactly; [] = none
//   later        the rows a later slice adds, for review; not asserted
//   csrf         none · session · always · form — GET → none, any other
//                /api method → session
//   exposed      allow · refuse · rule — the open-exposed posture's answer;
//                admin / owner → refuse, else allow
//   identityApi  the identity API (/api/admin/*, /api/org*)
//   modes        where the route is registered: local, oidc, proxy, off
//                (the /auth/* routes follow initAuth()'s mode)
//   self         { pwflow, session, unauth } — class self only

export const CLASSES = Object.freeze(['public', 'self', 'viewer', 'operator', 'admin', 'owner']);
export const MODES = Object.freeze(['local', 'oidc', 'proxy', 'off']);

// A route that registers a pack (server/pack-registry.mjs): the pack's row
// (pack.register, or pack.update for the same content under another label
// or source), the quick-start dedup (pack.replace), the cap (pack.evict),
// and the reconcile of its service links (pack.link / pack.unlink, with
// service.create / environment.create for the rows it names when absent).
const PACK_REGISTER = Object.freeze([
  'pack.register', 'pack.update', 'pack.replace', 'pack.evict', 'pack.link', 'pack.unlink', 'service.create', 'environment.create',
]);

export const ROUTES = Object.freeze({
  // ---------- public ----------
  'GET /healthz': { class: 'public' },
  'GET /api/version': { class: 'public' },
  // The studio shell, by name (server/index.mjs sendShell — the branded
  // rendering or the file); the SPA fallback below is the same handler.
  'GET /': { class: 'public' },
  'GET /index.html': { class: 'public' },
  'GET /auth/login': { class: 'public', modes: ['local', 'oidc', 'proxy'] },
  'POST /auth/login': { class: 'public', csrf: 'form', modes: ['local'] },
  'GET /auth/callback': {
    class: 'public', modes: ['oidc'],
    audit: ['user.jit', 'membership.jit', 'owner.bootstrap', 'user.update'],
  },
  'POST /auth/logout': { class: 'public', csrf: 'none', modes: ['local', 'oidc', 'proxy'] },
  'GET /auth/me': { class: 'public', modes: ['local', 'oidc', 'proxy'] },
  'GET /^(?!\\/api\\/).*/': { class: 'public' },

  // ---------- self: the caller's own row ----------
  'GET /auth/change-password': {
    class: 'self', modes: ['local'],
    self: { pwflow: true, session: true, unauth: 'redirect' },
  },
  'POST /auth/change-password': {
    class: 'self', csrf: 'form', modes: ['local'], audit: ['user.password'],
    self: { pwflow: true, session: true, unauth: 'flow-expired' },
  },
  'POST /auth/change-password/skip': {
    class: 'self', csrf: 'form', modes: ['local'],
    self: { pwflow: true, session: false, unauth: 'flow-expired' },
  },
  // "Sign out my other sessions": a session only (never the pwflow cookie),
  // and an identity change, so the CSRF header in every mode. Not behind a
  // reverse proxy: the headers are the session, there is none to end.
  'POST /auth/signout-others': {
    class: 'self', csrf: 'always', modes: ['local', 'oidc'], audit: ['user.signout'],
    self: { pwflow: false, session: true, unauth: 'json' },
  },

  // ---------- viewer: every read in the org ----------
  'GET /api/orgs': { class: 'viewer' },
  'GET /api/packs': { class: 'viewer' },
  'GET /api/examples': { class: 'viewer' },
  'GET /api/taxonomy': { class: 'viewer' },
  'GET /api/references': { class: 'viewer' },
  'GET /api/packs/:id': { class: 'viewer' },
  'GET /api/packs/:id/canonical': { class: 'viewer' },
  'GET /api/packs/:id/conformance': { class: 'viewer' },
  'GET /api/diff': { class: 'viewer' },
  'GET /api/compile/targets': { class: 'viewer' },
  'GET /api/packs/:id/compile-catalog': { class: 'viewer' },
  'GET /api/packs/:id/compile-artifact': { class: 'viewer' },
  'GET /api/packs/:id/export.zip': { class: 'viewer' },
  'GET /api/deploy/matrix': { class: 'viewer' },
  'GET /api/deploys': { class: 'viewer' },
  'GET /api/deploys/:deployId/rollback-plan': { class: 'viewer' },
  'GET /api/journeys': { class: 'viewer' },
  'GET /api/journeys/:name/runs': { class: 'viewer' },
  'GET /api/journeys/:name/schedule': { class: 'viewer' },
  'GET /api/packs/:id/compile/:target': { class: 'viewer' },
  'GET /api/maturity-rubric': { class: 'viewer' },
  'GET /api/live-status': { class: 'viewer' },
  'GET /api/library': { class: 'viewer' },
  'GET /api/library/requirements/:tier': { class: 'viewer' },
  'GET /api/library/:id': { class: 'viewer' },

  // ---------- operator: every existing mutation ----------
  'DELETE /api/uploads': { class: 'operator', audit: ['pack.clear'] },
  'POST /api/packs/:id/retrofeed': { class: 'operator', later: 'none (computes; writes nothing)' },
  'POST /api/deploys/:deployId/verify': { class: 'operator', later: 'slice 5: deploy.verify' },
  'POST /api/deploys/:deployId/rollback': { class: 'operator', later: 'slice 5: deploy.rollback' },
  'POST /api/packs/:id/deploy-bulk': { class: 'operator', later: 'slice 5: deploy.bulk' },
  'POST /api/packs/:id/deploy/:target': { class: 'operator', later: 'slice 5: deploy.run' },
  'POST /api/journeys/:name/run': { class: 'operator', later: 'slice 5: journey.run' },
  'POST /api/journeys/capture': { class: 'operator', later: 'slice 5: journey.capture' },
  'POST /api/draft-from-mcp': { class: 'operator', audit: PACK_REGISTER },
  'POST /api/refresh-live': { class: 'operator', later: 'slice 5: live.refresh' },
  'POST /api/crawl': { class: 'operator', audit: PACK_REGISTER },
  'POST /api/crawl-github': { class: 'operator', audit: PACK_REGISTER },
  'POST /api/validate': { class: 'operator', audit: PACK_REGISTER },
  'POST /api/library/instantiate': { class: 'operator', later: 'none (computes)' },
  'POST /api/library/compile': { class: 'operator', later: 'none (computes)' },
  'POST /api/library/register': { class: 'operator', audit: PACK_REGISTER },

  // ---------- admin: the request's org — its name and its members ----------
  // The identity API (server/routes/identity.mjs) for the org the request
  // is in: no path names an org, so an admin never reaches another one (the
  // org middleware refused a header naming an org they are not in). An
  // owner is an admin in every org. Closed in the open, exposed posture and,
  // without sign-in, answered only to a request sent straight to loopback.
  'PATCH /api/org': { class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['org.rename'] },
  'GET /api/org/members': { class: 'admin', identityApi: true, exposed: 'refuse' },
  'POST /api/org/members': {
    class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['membership.add', 'membership.role'],
  },
  'PATCH /api/org/members/:userId': { class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['membership.role'] },
  'DELETE /api/org/members/:userId': { class: 'admin', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['membership.remove'] },

  // ---------- owner: the deployment's users, orgs and join role ----------
  // The identity API (server/routes/identity.mjs), whatever org the request
  // is in. Closed in the open, exposed posture — but for an org's creation,
  // which the rule itself refuses there (409) — and, without sign-in,
  // answered only to a request sent straight to loopback.
  'GET /api/admin/users': { class: 'owner', identityApi: true, exposed: 'refuse' },
  'POST /api/admin/users': {
    class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse',
    audit: ['user.create', 'owner.first-local-user', 'membership.add', 'meta.set'],
  },
  'POST /api/admin/users/:id/disable': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['user.disable'] },
  'POST /api/admin/users/:id/enable': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['user.enable'] },
  'POST /api/admin/users/:id/password': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['user.password'] },
  'POST /api/admin/users/:id/signout': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['user.signout'] },
  'PUT /api/admin/users/:id/owner': {
    class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['owner.grant', 'owner.revoke'],
  },
  'GET /api/admin/orgs': { class: 'owner', identityApi: true, exposed: 'refuse' },
  'POST /api/admin/orgs': {
    class: 'owner', identityApi: true, csrf: 'always', exposed: 'rule', audit: ['org.create', 'org.adopt', 'membership.add'],
  },
  'DELETE /api/admin/orgs/:id': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['org.remove'] },
  'GET /api/admin/join-role': { class: 'owner', identityApi: true, exposed: 'refuse' },
  'PUT /api/admin/join-role': { class: 'owner', identityApi: true, csrf: 'always', exposed: 'refuse', audit: ['meta.set'] },
});

// The static mounts, each public.
export const STATIC_MOUNTS = Object.freeze({ '/lib': 'public', '/': 'public' });

// The only non-route, non-router, non-static layers the app may hold, by
// function name (an anonymous app.use fails the completeness test).
export const MIDDLEWARE = Object.freeze([
  'authGate', 'orgContext', 'jsonParser', 'textParser', 'urlencodedParser', 'payloadTooLarge',
]);

// One entry with its class defaults filled; throws on a key the table does
// not hold.
export function routeEntry(key) {
  const raw = Object.hasOwn(ROUTES, key) ? ROUTES[key] : null;
  if (!raw) {
    throw new Error(`unclassified route ${key} — add it to server/route-table.mjs and to EXPECTED_CLASS in server/test-authz.mjs`);
  }
  const space = key.indexOf(' ');
  const method = key.slice(0, space);
  const path = key.slice(space + 1);
  const isApi = path.startsWith('/api/');
  return Object.freeze({
    key,
    method,
    path,
    class: raw.class,
    audit: Object.freeze([...(raw.audit || [])]),
    later: raw.later ?? null,
    csrf: raw.csrf ?? (method === 'GET' || !isApi ? 'none' : 'session'),
    exposed: raw.exposed ?? (raw.class === 'admin' || raw.class === 'owner' ? 'refuse' : 'allow'),
    identityApi: raw.identityApi === true,
    modes: Object.freeze([...(raw.modes || MODES)]),
    self: raw.self ? Object.freeze({ ...raw.self }) : null,
  });
}
