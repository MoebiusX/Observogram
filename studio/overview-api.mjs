// studio/overview-api.mjs — what the Overview screen reads and does, over
// the routes the studio already uses. Loaders only (docs/UI_CONVENTIONS.md
// §2): every call goes through requestJson (studio/services-api.mjs), which
// spreads authHeaders() and turns a refusal into a sentence; nothing here
// touches the DOM or the state. The grade of the pack alone is the engine's
// (studio/diagnostic-grade.mjs), computed here so the model stays free of it.

import { requestJson } from './services-api.mjs';
import { computeDiagnosticGrade, computePostureMatrix } from './diagnostic-grade.mjs';

const enc = encodeURIComponent;
const sentence = (e) => String(e?.message || e || 'unknown error');

// The posture matrix of the pack on its own — which kinds of signal the
// repository declares on which layer — the board's stack and the engine's
// Comprehensive criterion, from one computation.
export function computeOverviewPosture(layered) {
  if (!layered) return null;
  return computePostureMatrix(layered, null);
}

// The grade of the pack on its own: no Pack B, no diff — the repository's
// declaration graded by the same engine Diagnose runs. `posture` is the
// matrix above when the caller already has it.
export function computeOverviewDiagnostic(layered, posture = null) {
  if (!layered) return null;
  return computeDiagnosticGrade(layered, null, posture || computePostureMatrix(layered, null), null, null);
}

// loadOverviewFacts({ pack, env, journeyFor, fetchFn }) → the facts the model
// projects, each failure captured as a sentence, never thrown:
//   { layered, layeredError, conformance, conformanceError, journeys, journeysError, journey, run, runError }
// `journeyFor(journeys)` picks this service's journey (the model's rule), so
// the run is read for the right one. The conformance (the pack against the
// specification's clauses for its tier) is the board's "required rules" line;
// a failure there costs that line and nothing else.
export async function loadOverviewFacts({ pack = null, env = null, journeyFor = () => null, fetchFn = requestJson } = {}) {
  const out = { layered: null, layeredError: null, conformance: null, conformanceError: null, journeys: null, journeysError: null, journey: null, run: null, runError: null };
  const reads = [];
  if (pack?.id) {
    const q = env ? `?env=${enc(env)}` : '';
    reads.push(fetchFn(`/api/packs/${enc(pack.id)}${q}`)
      .then((body) => { out.layered = body; })
      .catch((e) => { out.layeredError = sentence(e); }));
    reads.push(fetchFn(`/api/packs/${enc(pack.id)}/conformance${q}`)
      .then((body) => { out.conformance = body && typeof body === 'object' ? body : null; })
      .catch((e) => { out.conformanceError = sentence(e); }));
  }
  reads.push(fetchFn('/api/journeys')
    .then((body) => { out.journeys = Array.isArray(body?.journeys) ? body.journeys : []; })
    .catch((e) => { out.journeysError = sentence(e); }));
  await Promise.all(reads);
  out.journey = journeyFor(out.journeys) || null;
  if (out.journey?.lastRun) {
    try {
      const body = await fetchFn(`/api/journeys/${enc(out.journey.name)}/runs?limit=1`);
      out.run = Array.isArray(body?.runs) ? body.runs[0] || null : null;
    } catch (e) { out.runError = sentence(e); }
  }
  return out;
}

// POST /api/journeys/:name/run — "check now". 200 → { ok, record } (the gate's
// outcome is data, not an error); 502 → the server wrote a vantage-lost record
// first, so the caller re-reads; a refusal (400/403) throws the server's
// sentence with its status.
export async function runServiceCheck(name, { fetchFn = requestJson } = {}) {
  // requestJson spreads authHeaders(), which carries the CSRF header.
  return fetchFn(`/api/journeys/${enc(name)}/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
}
