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
// `off`: the criteria the service is not graded on (its record's gradeOff).
export function computeOverviewDiagnostic(layered, posture = null, { off = [] } = {}) {
  if (!layered) return null;
  return computeDiagnosticGrade(layered, null, posture || computePostureMatrix(layered, null), null, null, { off });
}

// loadOverviewFacts({ pack, env, journeyFor, fetchFn }) → the facts the model
// projects, each failure captured as a sentence, never thrown:
//   { layered, layeredError, conformance, conformanceError, journeys, journeysError, journey, run, stopped, runError }
// `journeyFor(journeys)` picks this service's journey (the model's rule), so
// the run is read for the right one. The conformance (the pack against the
// specification's clauses for its tier) is Remediate's "Required by the
// specification" block; a failure there costs that block and nothing else.
// `run` is the journey's newest run that checked something; a Run stopped on
// a scan that lost files (outcome 'scan-partial': the service kept its last
// complete scan) is `stopped` when it is the newest, never `run` — the board
// keeps showing the check of the pack the service kept, however many stops
// came after it (the runs route's `checked=1`; a server without it answers
// with its newest runs, and the newest 25 are read as before).
const STOPPED = 'scan-partial';
const STOPPED_LOOK_BACK = 25;
export async function loadOverviewFacts({ pack = null, env = null, journeyFor = () => null, fetchFn = requestJson } = {}) {
  const out = { layered: null, layeredError: null, conformance: null, conformanceError: null, journeys: null, journeysError: null, journey: null, run: null, stopped: null, runError: null };
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
  // The listing's lastRun is its last check (never a stopped Run): a journey whose only runs are stops
  // names them as stoppedRun alone, and its stop is read too.
  if (out.journey?.lastRun || out.journey?.stoppedRun) {
    try {
      const runsOf = async (query) => {
        const body = await fetchFn(`/api/journeys/${enc(out.journey.name)}/runs?${query}`);
        return Array.isArray(body?.runs) ? body.runs : [];
      };
      // The newest record alone, as before; only when it is a stop, the newest that checked something
      // behind it, past every stop (checked=1) — from a server that answers with a stop all the same
      // (it does not know checked=1), the 25 newest.
      let runs = await runsOf('limit=1');
      out.stopped = runs[0]?.outcome === STOPPED ? runs[0] : null;
      if (out.stopped) {
        runs = await runsOf('limit=1&checked=1');
        if (runs.some((r) => r?.outcome === STOPPED)) runs = await runsOf(`limit=${STOPPED_LOOK_BACK}`);
      }
      out.run = runs.find((r) => r && r.outcome !== STOPPED) || null;
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

// The service list's facts: the journeys listing (each row's last check),
// the org's MCP endpoints with what may be registered here (the form's
// fourth answer), and whether a folder can be picked on the server (the
// third answer's Browse…). Each failure is a sentence, never thrown:
//   { journeys, journeysError, endpoints, endpointsError, register, folders, sources }
//   sources  the org's repository sources ({ github, ado, path, upload }), or null when
//            not read (an older server): every source offered, the server judges
//   folders  { allowed, why } — may a folder be picked on the server, and if
//            not, the server's reason — or null when the server has no folder
//            listing (an older one) or this reader may not ask (a viewer):
//            Browse… is then not drawn
export async function loadServiceListFacts({ fetchFn = requestJson } = {}) {
  const out = { journeys: null, journeysError: null, endpoints: null, endpointsError: null, register: null, folders: null, sources: null, liveScope: null };
  await Promise.all([
    fetchFn('/api/journeys')
      .then((body) => { out.journeys = Array.isArray(body?.journeys) ? body.journeys : []; })
      .catch((e) => { out.journeysError = sentence(e); }),
    fetchFn('/api/mcp-endpoints')
      .then((body) => {
        out.endpoints = Array.isArray(body?.endpoints) ? body.endpoints : [];
        out.register = body?.policy?.register ?? null;
      })
      .catch((e) => { out.endpointsError = sentence(e); }),
    loadRepositoryFolders(null, { fetchFn })
      .then((body) => {
        if (!body || typeof body.allowed !== 'boolean') return;
        out.folders = { allowed: body.allowed, why: body.why || null };
      })
      .catch(() => { /* no listing here, or not for this reader: no Browse… */ }),
    // The server's configured snapshot scope ({ defaults, from, errors }): what an environment with no
    // live scope of its own reads with. An operator reads it; for anyone else, none is drawn.
    fetchFn('/api/mcp/jobs')
      .then((body) => { out.liveScope = body?.scope && typeof body.scope === 'object' ? body.scope : null; })
      .catch(() => { /* not for this reader, or an older server */ }),
    fetchFn('/api/repository-sources')
      .then((body) => { out.sources = body?.sources && typeof body.sources === 'object' ? body.sources : null; })
      .catch(() => { /* an older server: every source offered, and the server judges */ }),
  ]);
  return out;
}

// GET /api/services/:id/agreement — a service's agreement against its repository's pack:
// { agreement, coverage, catalogue, repository } (server/routes/services.mjs). A failure is a
// sentence, never thrown: { error }.
export async function loadServiceAgreement(serviceId, { fetchFn = requestJson } = {}) {
  try {
    const body = await fetchFn(`/api/services/${encodeURIComponent(serviceId)}/agreement`);
    return { agreement: body?.agreement ?? null, coverage: body?.coverage ?? null, catalogue: Array.isArray(body?.catalogue) ? body.catalogue : [], repository: body?.repository ?? null };
  } catch (e) { return { error: sentence(e) }; }
}
// The same for every service that has one, by id: what the list's Agreement column says.
export async function loadAgreementFacts(services, { fetchFn = requestJson } = {}) {
  const out = {};
  await Promise.all((Array.isArray(services) ? services : []).filter((s) => s && Number.isInteger(s.id) && s.agreement).map(async (s) => { out[s.id] = await loadServiceAgreement(s.id, { fetchFn }); }));
  return out;
}

// GET /api/repository-folders[?path=] — one folder on the server and the
// folders inside it, names only (Overview's Browse…; the server's rule is
// the one a save applies). `path` null is the top: the folders the server
// reads repositories from, or the home folder on the person's own machine.
// → { allowed, why, bounded, path, up, repository, folders, truncated, limit };
// a folder the server refuses throws its sentence with its status.
export async function loadRepositoryFolders(path = null, { fetchFn = requestJson } = {}) {
  return fetchFn(`/api/repository-folders${path ? `?path=${enc(path)}` : ''}`);
}

// POST /api/services/:id/scope-check — what a live scope would leave out of the environment's Run,
// asked before it is saved (overview-model.mjs scopeCheckOf / scopeChecked): the declared families
// with nothing inside it, the rule groups the environment's last live read did not list. Stored
// packs only (no MCP call); a scope that does not parse throws the server's sentence (400).
export async function checkServiceScope(serviceId, { env, scope }, { fetchFn = requestJson } = {}) {
  return fetchFn(`/api/services/${enc(String(serviceId))}/scope-check`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ env, scope }),
  });
}
