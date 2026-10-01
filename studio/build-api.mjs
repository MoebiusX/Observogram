// studio/build-api.mjs
//
// The loaders of the BUILD journey (docs/UI_CONVENTIONS.md §2): every call the
// Define · Compile · Verify steps make to the six /api/library routes,
// normalised, with the fetcher injectable (`fetchFn`, like verdict-ui.mjs's
// loadRunHistory) so the models can be fed under node:test. Nothing here
// touches the DOM or the studio state; the controller in app.mjs owns when
// to call and what to do with the answer.
//
// Instantiation ALWAYS goes through the API: the engine is browser-safe but
// the PromQL grammar check (Lezer) is Node-only, and a pack built in the
// browser would silently skip it.

import { authHeaders } from './api.mjs';
import { instantiateBody } from './build-model.mjs';

// The default fetcher: JSON in, JSON out, and a 4xx JSON body is an answer
// (the engine's usage errors come back as 400 { ok: false, errors }), not an
// exception. Only a non-JSON reply (a stale server, a proxy page) throws.
async function jsonFetch(path, { method = 'GET', body } = {}) {
  const r = await fetch(path, {
    method,
    headers: { Accept: 'application/json', ...authHeaders(), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (r.status === 401) {
    const j = await r.clone().json().catch(() => null);
    if (j?.login) { window.location.assign(j.login); throw new Error('signed out — redirecting to login'); }
  }
  const ct = r.headers.get('content-type') || '';
  if (!ct.includes('application/json')) {
    const text = await r.text().catch(() => '');
    throw new Error(`${path}: server returned non-JSON (${ct || 'no content-type'}, ${r.status}). Restart \`npm run dev\` if the route is new.${text ? '\n' + text.slice(0, 200) : ''}`);
  }
  const out = await r.json();
  if (out && typeof out === 'object') out.status = r.status;
  return out;
}

let _library = null;
let _libraryPromise = null;
const _requirements = new Map();           // tier → clauses[] (resolved)
const _requirementsInFlight = new Map();   // tier → the request in flight, shared by concurrent callers
let _targets = null;

/** GET /api/library, once per page: { entries, scaffoldParams, errors }. */
export async function loadLibrary({ fetchFn = jsonFetch, force = false } = {}) {
  if (_library && !force) return _library;
  if (_libraryPromise && !force) return _libraryPromise;
  _libraryPromise = (async () => {
    const out = await fetchFn('/api/library');
    if (!out?.ok) throw new Error(out?.error || (out?.errors || []).join('; ') || 'GET /api/library failed');
    _library = { entries: out.entries || [], scaffoldParams: out.scaffoldParams || [], errors: out.errors || [] };
    return _library;
  })();
  try { return await _libraryPromise; } finally { _libraryPromise = null; }
}
export function libraryCache() { return _library; }

/**
 * GET /api/library/requirements/:tier, cached per tier: the rubric filtered by
 * minTier. The request in flight is shared too (as loadLibrary shares
 * _libraryPromise): a page load in build mode asks for the active tier from
 * the shell, the rail and every repaint before the first answer lands, and
 * that was three requests for one tier.
 */
export async function loadRequirements(tier, { fetchFn = jsonFetch } = {}) {
  if (_requirements.has(tier)) return _requirements.get(tier);
  if (_requirementsInFlight.has(tier)) return _requirementsInFlight.get(tier);
  const inFlight = (async () => {
    const out = await fetchFn(`/api/library/requirements/${encodeURIComponent(tier)}`);
    if (!out?.ok) throw new Error(out?.error || `GET /api/library/requirements/${tier} failed`);
    _requirements.set(tier, out.clauses || []);
    return out.clauses || [];
  })();
  _requirementsInFlight.set(tier, inFlight);
  try { return await inFlight; } finally { _requirementsInFlight.delete(tier); }
}
export function requirementsCache() { return Object.fromEntries(_requirements); }

/** GET /api/library/:id — the full entry for a details drawer. */
export async function loadEntry(id, { fetchFn = jsonFetch } = {}) {
  const out = await fetchFn(`/api/library/${encodeURIComponent(id)}`);
  if (!out?.ok) throw new Error(out?.error || `GET /api/library/${id} failed`);
  return out;
}

/** GET /api/compile/targets — the compile catalog's targets (one artefact card each). */
export async function loadTargets({ fetchFn = jsonFetch } = {}) {
  if (_targets) return _targets;
  const out = await fetchFn('/api/compile/targets');
  _targets = out?.targets || [];
  return _targets;
}

/**
 * POST /api/library/instantiate from the draft. Resolves to the response
 * either way: { ok: true, canonical, canonicalYaml, todos, provenance,
 * warnings, schemaErrors, summary, conformance } or { ok: false, errors }.
 * With `library` the body carries only the overrides whose SLI is in the
 * current selection (instantiateBody); `body` replaces the draft's body
 * outright (the custom card's trial instantiation).
 */
export async function instantiate(build, { fetchFn = jsonFetch, library = null, body = null } = {}) {
  return fetchFn('/api/library/instantiate', { method: 'POST', body: body || instantiateBody(build, library) });
}

/** POST /api/library/compile — one artefact previewed from the canonical, nothing registered. */
export async function compilePreview(canonical, target, { fetchFn = jsonFetch, dashboardId } = {}) {
  return fetchFn('/api/library/compile', { method: 'POST', body: { canonical, target, ...(dashboardId ? { dashboardId } : {}) } });
}

/** POST /api/library/register — the pack into the upload registry, the way an upload lands. */
export async function registerBuiltPack(canonical, { fetchFn = jsonFetch, source } = {}) {
  return fetchFn('/api/library/register', { method: 'POST', body: { canonical, ...(source ? { source } : {}) } });
}
