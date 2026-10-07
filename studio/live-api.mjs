// studio/live-api.mjs
//
// The loaders of the live MCP API (rebadge batch 3): POST /api/mcp/ping and
// the live jobs (/api/mcp/jobs).
// The controller (studio/app.mjs) owns when it is called; the model
// (studio/live-model.mjs) owns what is drawn. Every call goes through
// requestJson() (studio/services-api.mjs): the CSRF and org headers on
// every request — the live MCP API takes the CSRF header in every posture —,
// the 401 sign-in rule, and the server's refusal thrown as
// `<status>: <sentence>`, never a raw body (in the static bundle: the 501
// sentence that names the feature). No loader logs.

import { requestJson } from './services-api.mjs';

// POST /api/mcp/ping with the picker's target ({ mcpEndpointId } or
// { mcpUrl }, and mcpAuth when typed) → the answer (200 whenever the ping
// ran, whatever its verdict).
export async function pingMcp(target, { fetchFn = requestJson } = {}) {
  return fetchFn('/api/mcp/ping', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(target ?? {}),
  });
}

// GET /api/mcp/jobs → { ok, scope: { defaults, from, errors }, running, lastTook }.
export async function readLiveJobs({ fetchFn = requestJson } = {}) {
  return fetchFn('/api/mcp/jobs');
}

// POST /api/mcp/jobs { kind, target…, packName?, label?, scope? } → 202 { ok, job, poll }.
export async function startLiveJob(body, { fetchFn = requestJson } = {}) {
  return fetchFn('/api/mcp/jobs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
}

// GET /api/mcp/jobs/:id?since= → { ok, job, stages, next, result?, error? };
// a job the server no longer has throws with status 404.
export async function pollLiveJob(id, since = 0, { fetchFn = requestJson } = {}) {
  return fetchFn(`/api/mcp/jobs/${encodeURIComponent(id)}?since=${encodeURIComponent(since)}`);
}

// POST /api/mcp/jobs/:id/cancel → { ok, job }.
export async function cancelLiveJob(id, { fetchFn = requestJson } = {}) {
  return fetchFn(`/api/mcp/jobs/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}
