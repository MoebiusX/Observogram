// studio/services-api.mjs
//
// The loaders of the Services home and the service page (docs/STORE_PLAN.md
// §6, slice 6a): GET /api/orgs, GET /api/services, GET /api/services/:id,
// GET /api/packs/:id/conformance?env=, PATCH /api/services/:id. The
// controller (studio/app.mjs) owns WHEN each is called; the models
// (studio/services-model.mjs) own what is drawn from the answers.
//
// Why not api() alone: api() keeps a guard's denial ({ error, denied }) as
// `<status>: <error>` but a handler's own refusal ({ ok: false, error }
// without `denied` — the 404 `no service 9`, the conformance 404 `unknown
// pack: x`, a 400 from WAYS.tier) only as a sliced raw body. requestJson()
// parses the body and throws servicesRefusal(status, body) so every status
// line, toast and title shows the server's sentence and never a `{`. It
// spreads authHeaders() on every call — the CSRF header the session PATCH
// needs and the active org (server/test-authz.mjs's studio guard) — and
// follows api()'s 401 rule (a `login` in the body is the sign-in page).

import { authHeaders, deniedError } from './api.mjs';

// The Error a refused services call throws: the guard's denial as
// deniedError() words it (`.denied`, `.status`), else `<status>: <error>`
// from the handler's body; a body without a sentence reads 'no answer'.
// `body` may be the parsed JSON, its text, or null.
export function servicesRefusal(status, body) {
  let json = body;
  if (typeof body === 'string') { try { json = JSON.parse(body); } catch { json = null; } }
  const denial = deniedError(status, json);
  if (denial) return denial;
  const text = typeof json?.error === 'string' && json.error ? json.error : 'no answer';
  const err = new Error(`${status}: ${text}`);
  err.status = status;
  return err;
}

export async function requestJson(path, opts = {}) {
  const r = await fetch(path, {
    ...opts,
    headers: { Accept: 'application/json', ...authHeaders(), ...(opts.headers || {}) },
  });
  if (r.status === 401) {
    const body = await r.clone().json().catch(() => null);
    if (body?.login) { window.location.assign(body.login); throw new Error('signed out — redirecting to login'); }
  }
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw servicesRefusal(r.status, text);
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const body = await r.text().catch(() => '');
    throw new Error(`${path}: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${body ? '\n' + body.slice(0, 200) : ''}`);
  }
  return r.json();
}

const enc = encodeURIComponent;

// GET /api/orgs → the body ({ ok, tenancy, orgs: [{ id, name, role, effectiveRole }], active }).
export async function loadOrgs({ fetchFn = requestJson } = {}) {
  return fetchFn('/api/orgs');
}

// GET /api/services → ServiceView[] (by slug).
export async function loadServices({ fetchFn = requestJson } = {}) {
  const doc = await fetchFn('/api/services');
  return Array.isArray(doc?.services) ? doc.services : [];
}

// GET /api/services/:id → ServiceView (a 404 throws `404: no service <id>`).
export async function loadService(id, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/services/${enc(id)}`);
  return doc?.service ?? null;
}

// GET /api/packs/:id/conformance?env= → the report (a 404 throws `404: unknown pack: <id>`).
export async function loadVerdict(packId, env, { fetchFn = requestJson } = {}) {
  const q = env ? `?env=${enc(env)}` : '';
  return fetchFn(`/api/packs/${enc(packId)}/conformance${q}`);
}

// PATCH /api/services/:id → { service, changed } (operator; CSRF and org headers through requestJson).
export async function patchService(id, patch, { fetchFn = requestJson } = {}) {
  const doc = await fetchFn(`/api/services/${enc(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch || {}),
  });
  return { service: doc?.service ?? null, changed: Array.isArray(doc?.changed) ? doc.changed : [] };
}

// A small pool for the verdicts the home and the page fetch lazily: at most
// `concurrency` reports in flight, one promise per (pack, env) — a second
// load() of the same key while the first is pending shares it; a settled
// report is not cached here (state.serviceVerdicts is the cache).
export function verdictLoader({ fetchFn = requestJson, concurrency = 4 } = {}) {
  const inFlight = new Map();
  const queue = [];
  let active = 0;
  const pump = () => {
    while (active < concurrency && queue.length) {
      const job = queue.shift();
      active += 1;
      loadVerdict(job.packId, job.env, { fetchFn })
        .then(job.resolve, job.reject)
        .finally(() => { active -= 1; inFlight.delete(job.key); pump(); });
    }
  };
  return {
    load(packId, env) {
      const key = `${packId}::${env}`;
      if (inFlight.has(key)) return inFlight.get(key);
      const p = new Promise((resolve, reject) => { queue.push({ key, packId, env, resolve, reject }); });
      inFlight.set(key, p);
      pump();
      return p;
    },
    pending() { return inFlight.size; },
  };
}
