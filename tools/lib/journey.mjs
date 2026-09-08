// tools/lib/journey.mjs
//
// Saved journeys (VALUE_BACKLOG item 11) — a named, parameterized,
// repeatable drift check. A journey definition freezes one comparison:
// where Pack A comes from (a pack file or a repo crawl), where Pack B
// comes from (a pack file or a live MCP draft), the env/service scope,
// and the pass criteria. Running it composes the engines that already run
// headlessly — crawler, fetcher, adapter, diff, conformance, diagnostic
// grade — into one verdict, appends a run record to the workspace
// (drift over time), and reports per the gate contract in
// docs/PHASE_1_VERDICT_TRUST_RESEARCH.md Workstream D:
//   exit 0 = verdict passes the gate
//   exit 1 = verdict ran, gate failed
//   exit 2 = tooling / configuration / input / live-fetch error
//
// Secrets never live in a journey file: MCP auth is referenced by env var
// name (authEnv), resolved at run time. The gate reports verification
// evidence as verification — never "validated" (that word is reserved for
// incident ground truth).
//
// Definition shape (.journey.yaml):
//   name: repo-vs-live
//   packA: { file: ./pack.yaml }            # or { crawl: { path: ../svc, name: svc, env: prod } }
//   packB: { mcp: { url: https://…/mcp, authEnv: MY_MCP_TOKEN } }   # or { file: … }
//   env: prod              # optional Pack A environment overlay
//   service: svc           # optional diff service scope
//   scopeMode: service     # optional diff scope mode
//   gate:                  # all optional; omitted criteria don't gate
//     requireGradePass: true
//     minAlignmentPct: 85
//     maxDeclaredNotLive: 0
//     maxDrifted: 5
//     maxLiveAgeHours: 24
//     failOnPartialEvidence: true   # any probe family FAILED → the verdict is not trustworthy
//     maxUnhealthy: 0               # scrape jobs down + unhealthy rules observed on the wire
//     stack:                        # step 3: thresholds on the stack self-metric SAMPLES
//       requireSampled: true        #   breach unless the panel was sampled and a row answered data
//       rows:                       #   per row id (contracts table), min/max on the sampled value
//         scrape_success_ratio: { min: 0.9 }
//         scrape_targets_down: { max: 0 }
//     A stack breach is an early warning to a business owner — a
//     point-in-time sample outside a declared band — never an SLO verdict.
//   keepLivePack: transitions   # step 4: snapshot Pack B under runs/<name>/live/
//                               #   transitions (default) — first run, any chain
//                               #   verdict change, gate failure, or after a
//                               #   vantage loss · always · never
//
// Vantage: when Pack B is a live MCP source and the fetch itself fails
// (endpoint down, core tools unavailable), the run still leaves a record
// with outcome 'vantage-lost' before the error propagates (exit 2) — a
// total loss of the observation point is a point in the drift history,
// not a hole in it.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from './mini-yaml.mjs';
import { validateCanonical } from './validator.mjs';
import { adapt } from './adapter.mjs';
import { evaluateConformance } from './conformance.mjs';
import { diffPacks } from './diff.mjs';
import { comparePackBranches } from './traceability-graph.mjs';
import { crawlFiles } from './crawler.mjs';
import { baseWorkspacePath, brandEnv } from './brand-env.mjs';
import { STACK_SELF_METRIC_PROBES, STACK_OUTCOMES, displayHint } from './contracts/stack-self-metrics.mjs';
import { formatStackValue } from './stack-evidence.mjs';
import { branchRecordsFromGraph, chainSummary, diffRunBranches, rankCauses, deploysInWindow, topCause } from './chain-history.mjs';
import { computeDiagnosticGrade, computePostureMatrix, partialLiveEvidence, DIAGNOSTIC_PASS_SCORE_THRESHOLD } from '../../studio/diagnostic-grade.mjs';
import { sliBaseOfSloId } from '../../studio/verify-deploy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA = JSON.parse(readFileSync(
  resolve(__dirname, '../../vendor/observability-pack-spec/v1.2/observability-pack.schema.json'), 'utf8'));

// The engine stays server-agnostic: by default the root comes from env
// (flat workspace), but a host can inject a context-aware resolver —
// the server wires Stage 2 tenancy (workspace-per-org) through here at
// boot without this module importing any server code.
let workspaceRootResolver = null;
export function setWorkspaceRootResolver(fn) { workspaceRootResolver = typeof fn === 'function' ? fn : null; }
function workspaceRoot() {
  if (workspaceRootResolver) return workspaceRootResolver();
  return baseWorkspacePath();
}
function journeysDir()   { return join(workspaceRoot(), 'journeys'); }
function runsDir(name)   { return join(workspaceRoot(), 'runs', sanitizeName(name)); }
function sanitizeName(n) { return String(n).replace(/[^A-Za-z0-9._-]/g, '_'); }

export function listJourneys() {
  try {
    return readdirSync(journeysDir())
      .filter(f => f.endsWith('.journey.yaml'))
      .map(f => f.slice(0, -'.journey.yaml'.length));
  } catch (_) { return []; }
}

// Persist a journey definition into the workspace. Used by the studio's
// "save this comparison as a journey" capture; the file is plain YAML the
// user can edit (e.g. swap a frozen pack file for a crawl: source).
export function saveJourneyDef(name, def, { banner } = {}) {
  const safe = sanitizeName(name);
  if (!safe) throw new Error('journey name required');
  if (!def?.packA || !def?.packB) throw new Error('journey def needs packA and packB');
  mkdirSync(journeysDir(), { recursive: true });
  const path = join(journeysDir(), `${safe}.journey.yaml`);
  const head = (banner || []).map(l => `# ${l}`).join('\n');
  writeFileSync(path, (head ? head + '\n' : '') + emitYaml({ name: safe, ...def }));
  return { name: safe, path };
}

// Resolve a journey by name (workspace journeys/) or by literal file path.
export function loadJourneyDef(ref) {
  const candidates = [
    join(journeysDir(), `${sanitizeName(ref)}.journey.yaml`),
    resolve(ref),
  ];
  let text = null, source = null;
  for (const p of candidates) {
    try { text = readFileSync(p, 'utf8'); source = p; break; } catch (_) {}
  }
  if (text === null) {
    const known = listJourneys();
    throw new Error(`journey not found: ${ref}` + (known.length ? `\n  known journeys: ${known.join(', ')}` : `\n  (no journeys saved under ${journeysDir()})`));
  }
  const def = parseYaml(text);
  if (!def || typeof def !== 'object') throw new Error(`journey ${ref}: not a YAML mapping`);
  def.name = def.name || sanitizeName(ref).replace(/\.journey\.yaml$/, '');
  if (!def.packA || (!def.packA.file && !def.packA.crawl)) throw new Error(`journey ${def.name}: packA needs file: or crawl:`);
  if (!def.packB || (!def.packB.file && !def.packB.mcp)) throw new Error(`journey ${def.name}: packB needs file: or mcp:`);
  if (def.gate && typeof def.gate === 'object' && def.gate.stack !== undefined) validateGateStack(def.gate.stack, def.name);
  if (def.keepLivePack !== undefined && !KEEP_LIVE_PACK_POLICIES.includes(def.keepLivePack)) {
    throw new Error(`journey ${def.name}: keepLivePack must be one of ${KEEP_LIVE_PACK_POLICIES.join(', ')} (got ${JSON.stringify(def.keepLivePack)})`);
  }
  def.__source = source;
  return def;
}

// Step 4: when the run keeps a snapshot of Pack B beside its record
// (runs/<journey>/live/<stem>.json). `transitions` keeps the packs that
// explain a change in the chain history; `always` keeps every one;
// `never` keeps none. A file-sourced Pack B is never snapshotted — the
// file is the snapshot.
export const KEEP_LIVE_PACK_POLICIES = Object.freeze(['transitions', 'always', 'never']);
export const KEEP_LIVE_PACK_DEFAULT = 'transitions';

// gate.stack is validated at load time, not at run time: a typo in a row
// id would otherwise breach every run with "no sample" and read as a stack
// problem. Ids are case-sensitive against the contracts table; min/max
// must be finite numbers; an entry that declares neither has nothing to
// check and is refused rather than silently passing.
export function validateGateStack(stack, journeyName = '?') {
  const where = `journey ${journeyName}: gate.stack`;
  if (!stack || typeof stack !== 'object' || Array.isArray(stack)) throw new Error(`${where} must be a mapping`);
  if (stack.requireSampled !== undefined && typeof stack.requireSampled !== 'boolean') {
    throw new Error(`${where}.requireSampled must be true or false`);
  }
  if (stack.rows === undefined) return;
  if (!stack.rows || typeof stack.rows !== 'object' || Array.isArray(stack.rows)) throw new Error(`${where}.rows must be a mapping of row id → { min, max }`);
  for (const [id, entry] of Object.entries(stack.rows)) {
    if (!STACK_ROW_BY_ID.has(id)) {
      throw new Error(`${where}.rows names unknown row ${id}; known rows: ${STACK_SELF_METRIC_PROBES.map(r => r.id).join(', ')}`);
    }
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${where}.rows.${id} must be a mapping with min and/or max`);
    for (const bound of ['min', 'max']) {
      if (entry[bound] !== undefined && !(typeof entry[bound] === 'number' && Number.isFinite(entry[bound]))) {
        throw new Error(`${where}.rows.${id}.${bound} must be a finite number`);
      }
    }
    if (entry.min === undefined && entry.max === undefined) throw new Error(`${where}.rows.${id} declares neither min nor max — nothing to check`);
    if (entry.min !== undefined && entry.max !== undefined && entry.min > entry.max) throw new Error(`${where}.rows.${id}: min ${entry.min} is above max ${entry.max}`);
  }
}

// ---------- pack sources ----------

function loadPackFile(path, baseDir) {
  const p = resolve(baseDir || '.', path);
  const text = readFileSync(p, 'utf8');
  const pack = extname(p) === '.json' ? JSON.parse(text) : parseYaml(text);
  return { canonical: pack, source: p };
}

// Minimal repo walk for the crawl source — mirrors tools/crawl-repo.mjs's
// filters (that script runs main() on import, so it can't be imported).
const SKIP_DIRS = new Set(['.git', 'node_modules', 'dist', 'build', 'out', '.observogram', '.tomograph', 'coverage', 'vendor']);
const SCAN_EXT = /\.(ya?ml|json|cs|go|java|py|ts|tsx|js|mjs|rs|kt)$/i;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 16 * 1024 * 1024;

function walkRepo(root) {
  const files = {};
  let total = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) stack.push(join(dir, e.name));
        continue;
      }
      if (!SCAN_EXT.test(e.name)) continue;
      const full = join(dir, e.name);
      let size = 0;
      try { size = statSync(full).size; } catch (_) { continue; }
      if (size > MAX_FILE_BYTES || total + size > MAX_TOTAL_BYTES) continue;
      try {
        files[full.slice(root.length + 1).replaceAll('\\', '/')] = readFileSync(full, 'utf8');
        total += size;
      } catch (_) {}
    }
  }
  return files;
}

async function resolvePackA(def, baseDir) {
  if (def.packA.file) return loadPackFile(def.packA.file, baseDir);
  const c = def.packA.crawl;
  const root = resolve(baseDir || '.', c.path);
  const files = walkRepo(root);
  if (!Object.keys(files).length) throw new Error(`crawl source ${root}: no scannable files found`);
  const out = crawlFiles(files, {
    repoName: c.name || undefined,
    environment: c.env || def.env || undefined,
    criticality: c.criticality || undefined,
  });
  return { canonical: out.canonical, source: `crawl:${root}` };
}

async function resolvePackB(def) {
  if (def.packB.file) return loadPackFile(def.packB.file, def.__baseDir);
  const m = def.packB.mcp;
  if (!m?.url) throw new Error(`journey ${def.name}: packB.mcp.url required`);
  const mcpAuth = m.authEnv ? (process.env[m.authEnv] || null) : null;
  if (m.authEnv && !mcpAuth) {
    throw new Error(`journey ${def.name}: packB.mcp.authEnv names ${m.authEnv}, but that env var is not set`);
  }
  // Imported lazily: fetch-live-pack is the heaviest module and only the
  // live path needs it. Composition mirrors the server's draft route.
  const { fetchMcp, buildCanonicalPack } = await import('../fetch-live-pack.mjs');
  try {
    const fetched = await fetchMcp({ mcpUrl: m.url, mcpAuth });
    const refreshedAt = new Date().toISOString();
    const canonical = buildCanonicalPack({ refreshedAt, mcpUrl: m.url, ...fetched });
    return { canonical, source: `mcp:${m.url}` };
  } catch (e) {
    // The vantage point itself failed (unreachable, core tools missing,
    // unbuildable answer) — distinct from the configuration errors above,
    // which never reach the wire and leave no run record.
    e.vantageLost = true;
    throw e;
  }
}

// ---------- gate ----------

function hoursSince(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? (Date.now() - t) / 3.6e6 : null;
}

export function evaluateGate(gate, facts) {
  const breaches = [];
  if (!gate || typeof gate !== 'object') return breaches;
  const add = (criterion, detail) => breaches.push({ criterion, detail });
  if (gate.requireGradePass && !facts.gradePass) {
    add('requireGradePass', `diagnostic grade ${facts.gradeScore}% is below the ${DIAGNOSTIC_PASS_SCORE_THRESHOLD}% pass bar`);
  }
  if (Number.isFinite(gate.minAlignmentPct) && facts.alignmentPct < gate.minAlignmentPct) {
    add('minAlignmentPct', `alignment ${facts.alignmentPct}% < required ${gate.minAlignmentPct}%`);
  }
  if (Number.isFinite(gate.maxDeclaredNotLive) && facts.declaredNotLive > gate.maxDeclaredNotLive) {
    add('maxDeclaredNotLive', `${facts.declaredNotLive} declared artefact(s) not confirmed live (max ${gate.maxDeclaredNotLive})`);
  }
  if (Number.isFinite(gate.maxDrifted) && facts.drifted > gate.maxDrifted) {
    add('maxDrifted', `${facts.drifted} drifted artefact(s) (max ${gate.maxDrifted})`);
  }
  if (Number.isFinite(gate.maxLiveAgeHours)) {
    if (facts.liveAgeHours === null) {
      add('maxLiveAgeHours', 'live evidence carries no refresh timestamp — staleness cannot be proven fresh');
    } else if (facts.liveAgeHours > gate.maxLiveAgeHours) {
      add('maxLiveAgeHours', `live evidence is ${facts.liveAgeHours.toFixed(1)}h old (max ${gate.maxLiveAgeHours}h)`);
    }
  }
  // Vantage-aware criteria. A failed probe family is a hole of unknown
  // size in the live evidence: whatever the diff says about that family
  // is unverifiable, so a verdict built on it must not pass a gate that
  // asked for whole evidence. (An EMPTY probe is an honest zero and an
  // UNSUPPORTED one a restricted tier — neither breaches on its own; the
  // one exception is a vantage that is entirely lost.)
  if (gate.failOnPartialEvidence) {
    const failed = facts.probes?.failed || [];
    if (failed.length) {
      add('failOnPartialEvidence', `live evidence is partial: probes failed: ${failed.join(', ')} — verdict not trustworthy`);
    } else if (facts.vantage === 'lost') {
      const unsupported = facts.probes?.unsupported || [];
      add('failOnPartialEvidence', `live evidence is lost: no probe family answered (not exposed: ${unsupported.join(', ') || '-'}) — verdict not trustworthy`);
    }
  }
  if (Number.isFinite(gate.maxUnhealthy)) {
    const down = facts.scrapeJobsDown ?? 0;
    const unhealthy = facts.unhealthyRules ?? 0;
    if (down + unhealthy > gate.maxUnhealthy) {
      const names = [
        ...(facts.scrapeJobsDownNames || []).map(n => `job ${n} down`),
        ...(facts.unhealthyRuleNames || []).map(n => `rule ${n} unhealthy`),
      ];
      add('maxUnhealthy', `${down} scrape job(s) down + ${unhealthy} unhealthy rule(s) observed on the wire (max ${gate.maxUnhealthy})`
        + (names.length ? `: ${names.slice(0, 8).join(', ')}${names.length > 8 ? ', …' : ''}` : ''));
    }
  }
  if (gate.stack && typeof gate.stack === 'object') evaluateStackGate(gate.stack, facts.stackEvidence, add);
  return breaches;
}

// Display formatting for a sampled value lives in the browser-safe
// tools/lib/stack-evidence.mjs (the studio prints the same vocabulary);
// re-exported here so the CLI and the tests keep one import.
export { formatStackValue };

// gate.stack — thresholds on the stack self-metric SAMPLES of this run.
// Honesty rules: a threshold can only be checked against a row that
// answered `data`; anything else (row absent, empty, failed, not in
// inventory, not attempted, a file-sourced B with no evidence at all)
// breaches as "no sample" rather than passing by absence. A breach is a
// point-in-time sample outside a declared band — an early warning, never
// an SLO verdict — and the detail says so.
function evaluateStackGate(stack, evidence, add) {
  const rows = Array.isArray(evidence?.rows) ? evidence.rows : [];
  const byId = new Map(rows.map(r => [r.id, r]));
  const isData = (r) => r && r.outcome === 'data' && typeof r.value === 'number' && Number.isFinite(r.value);
  if (stack.requireSampled) {
    const why = !evidence ? 'Pack B is not a live draft'
      : evidence.status !== 'sampled' ? (evidence.reason || evidence.status)
      : !rows.some(isData) ? 'sampled, but no row answered with data'
      : null;
    if (why) add('stack', `stack self-metrics not sampled (${why}) — the vantage cannot prove stack health`);
  }
  const thresholds = stack.rows && typeof stack.rows === 'object' ? stack.rows : {};
  for (const [id, t] of Object.entries(thresholds)) {
    // evaluateGate is exported and a host may compose a gate object
    // without going through loadJourneyDef's validation: a threshold that
    // cannot be checked breaches as such — it never passes by silence.
    const invalid = invalidThreshold(t);
    if (invalid) { add(`stack.${id}`, `threshold invalid (${invalid}) — cannot be checked`); continue; }
    const row = byId.get(id);
    if (!isData(row)) {
      // A row the fetcher never wrote is one the sampler never attempted:
      // on a not-attempted panel the tier reason is the whole story, on a
      // sampled panel the call budget ran out or the row was not observed.
      const outcome = !evidence ? 'no stack evidence'
        : !row ? (evidence.status === 'not-attempted'
          ? `not-attempted: ${evidence.reason || 'no reason recorded'}`
          : 'not attempted by the sampler — call budget exhausted or row not observed')
        : row.outcome === 'data' ? 'data without a numeric value' : row.outcome;
      add(`stack.${id}`, `no sample for ${id} (${outcome}${row?.reason ? `: ${row.reason}` : ''}) — threshold cannot be checked`);
      continue;
    }
    const min = t.min === undefined ? null : t.min;
    const max = t.max === undefined ? null : t.max;
    const belowMin = min !== null && row.value < min;
    const aboveMax = max !== null && row.value > max;
    if (belowMin || aboveMax) {
      const unit = row.unit || 'value';
      const shown = formatStackValue(row.value, unit);
      const band = `[${min === null ? '-∞' : formatStackValue(min, unit)} … ${max === null ? '∞' : formatStackValue(max, unit)}]`;
      // Display rounding can print the value equal to the bound it broke
      // (0.0004/s max 0 → "0.000/s outside [-∞ … 0.000/s]"); the raw
      // number keeps the explanation readable.
      const raw = shown === formatStackValue(belowMin ? min : max, unit) ? ` (raw ${row.value})` : '';
      add(`stack.${id}`, `${id} = ${shown}${raw} ${unit} outside ${band} — point-in-time sample, not an SLO verdict`);
    }
  }
}

// Why a declared row threshold cannot be evaluated, or null when it can.
// Mirrors validateGateStack's rules at run time (finite numeric bounds,
// at least one of them, min ≤ max).
function invalidThreshold(t) {
  if (!t || typeof t !== 'object' || Array.isArray(t)) return 'not a mapping with min and/or max';
  for (const bound of ['min', 'max']) {
    if (t[bound] !== undefined && !(typeof t[bound] === 'number' && Number.isFinite(t[bound]))) return `${bound} is not a finite number`;
  }
  if (t.min === undefined && t.max === undefined) return 'neither min nor max declared';
  if (t.min !== undefined && t.max !== undefined && t.min > t.max) return `min ${t.min} is above max ${t.max}`;
  return null;
}

// ---------- step 3: stack-health evidence (samples, kept per run) ----------
//
// The fetcher's step-2 panel rides on Pack B as JSON annotations
// (mcp.observed.stack_metrics / .alertmanager / .grafana.*). Each run
// keeps what it saw so the run history becomes the time series. Every
// row is still a point-in-time sample: `hint` is the contracts' display
// marker and `referenceSli` the vocabulary it follows — neither is a
// verdict, and malformed JSON degrades to "no rows", never to health.
const STACK_ROW_BY_ID = new Map(STACK_SELF_METRIC_PROBES.map(r => [r.id, r]));
const STACK_EVIDENCE_ROW_CAP = 64;

function parseJsonAnnotation(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { return JSON.parse(value); } catch (_) { return null; }
}

function stackEvidenceRows(observed) {
  return (Array.isArray(observed) ? observed : [])
    .filter(r => r && typeof r === 'object' && typeof r.id === 'string' && r.id)
    .slice(0, STACK_EVIDENCE_ROW_CAP)
    .map(r => {
      const def = STACK_ROW_BY_ID.get(r.id) || null;
      const value = typeof r.value === 'number' && Number.isFinite(r.value) ? r.value : null;
      const direction = def?.direction || r.direction || 'info';
      return {
        id: r.id,
        family: def?.family || r.family || null,
        product: r.product ?? null,
        value,
        unit: def?.unit || r.unit || null,
        direction,
        // A declared outcome is kept as it is; an outcome the contracts do
        // not know is kept verbatim (never relabelled as a probe failure
        // nothing reported — it is still never `data`), and a missing one
        // reads 'unknown'.
        outcome: STACK_OUTCOMES.includes(r.outcome) ? r.outcome
          : (typeof r.outcome === 'string' && r.outcome.trim() ? r.outcome.trim() : 'unknown'),
        hint: displayHint({ direction }, value),
        at: typeof r.at === 'string' ? r.at : null,
        // A row the table no longer declares keeps null: no vocabulary
        // is claimed for a sample nothing maps any more.
        referenceSli: def?.referenceSli ?? null,
        ...(r.reason ? { reason: String(r.reason) } : {}),
      };
    });
}

function stackEvidenceFromAnnotations(ann) {
  const status = ann['mcp.stack.status'];
  if (status !== 'sampled' && status !== 'not-attempted') return null;
  const am = parseJsonAnnotation(ann['mcp.observed.alertmanager']);
  const dsRaw = parseJsonAnnotation(ann['mcp.observed.grafana.datasources']);
  const cpRaw = parseJsonAnnotation(ann['mcp.observed.grafana.contact_points']);
  const grafanaError = ann['mcp.observed.grafana.error'] ? String(ann['mcp.observed.grafana.error']) : null;
  const datasources = (Array.isArray(dsRaw) ? dsRaw : []).filter(d => d && typeof d === 'object');
  const hasGrafana = Array.isArray(dsRaw) || (cpRaw && typeof cpRaw === 'object') || grafanaError;
  return {
    status,
    reason: status === 'not-attempted' ? String(ann['mcp.stack.reason'] || 'not attempted') : null,
    rows: stackEvidenceRows(parseJsonAnnotation(ann['mcp.observed.stack_metrics'])),
    alertmanager: am && typeof am === 'object' ? {
      version: am.version ?? null,
      clusterStatus: am.clusterStatus ?? null,
      silencesActive: typeof am.silences?.active === 'number' ? am.silences.active : null,
      error: am.error ? String(am.error) : null,
    } : null,
    grafana: hasGrafana ? {
      datasources: Array.isArray(dsRaw) ? datasources.length : null,
      // Only a health verdict of 'error' is unhealthy; 'unknown' means the
      // health was never checked and must not read as either.
      unhealthyDatasources: datasources.filter(d => d.health === 'error').map(d => String(d.name ?? d.uid ?? '?')),
      contactPoints: cpRaw && typeof cpRaw === 'object' && typeof cpRaw.count === 'number' ? cpRaw.count : null,
      error: grafanaError,
    } : null,
  };
}

// On-wire liveness facts read from Pack B's fetcher annotations
// (docs/MCP_INTEGRATION.md). A file-sourced Pack B carries none: every
// list is empty, counts are 0, toolsExposedCount is null — absence of
// evidence is reported as absence, never as health.
export function liveEvidenceFacts(canonicalB) {
  const ann = canonicalB?.metadata?.annotations || {};
  const list = (k) => String(ann[k] || '').split(',').map(x => x.trim()).filter(Boolean);
  const ev = partialLiveEvidence(canonicalB);
  const scrapeJobsDownNames = list('mcp.discovered.scrape_jobs_down');
  const unhealthyRuleNames = [
    ...list('mcp.discovered.recording_rules_unhealthy'),
    ...list('mcp.discovered.alert_rules_unhealthy'),
  ];
  const exposed = Number(ann['mcp.toolsExposedCount']);
  // Step 2 stack self-metrics counts (mcp.stack.*). status is null when
  // Pack B carries no panel (file-sourced, or a pre-step-2 refresh); the
  // counts are then 0 — an absence, never a healthy stack. No gate key
  // reads the counts; gate.stack reads the samples in stackEvidence below,
  // and even then a breach is an early warning, not a verdict.
  const stackStatus = ann['mcp.stack.status'] === 'sampled' || ann['mcp.stack.status'] === 'not-attempted'
    ? ann['mcp.stack.status'] : null;
  const stackCount = (k) => { const v = Number(ann[k]); return Number.isFinite(v) ? v : 0; };
  return {
    probes: {
      attempted: ev.attempted,
      succeeded: list('mcp.probesSucceeded'),
      empty: ev.empty,
      failed: ev.failed,
      unsupported: ev.unsupported,
    },
    probeErrors: ev.errors,
    vantage: ev.vantage,
    toolsExposedCount: ann['mcp.toolsExposedCount'] != null && String(ann['mcp.toolsExposedCount']) !== '' && Number.isFinite(exposed) ? exposed : null,
    scrapeJobsDown: scrapeJobsDownNames.length,
    scrapeJobsDownNames,
    unhealthyRules: unhealthyRuleNames.length,
    unhealthyRuleNames,
    stack: {
      status: stackStatus,
      reason: stackStatus === 'not-attempted' ? String(ann['mcp.stack.reason'] || 'not attempted') : null,
      sampled: stackCount('mcp.stack.sampled'),
      empty: stackCount('mcp.stack.empty'),
      failed: stackCount('mcp.stack.failed'),
      notAttempted: stackCount('mcp.stack.notAttempted'),
    },
    // Step 3: the samples themselves (null when Pack B carries no panel).
    stackEvidence: stackEvidenceFromAnnotations(ann),
  };
}

// ---------- step 4: chain history, versions, live-pack snapshot ----------

// mcp.versions.<product> → value, from Pack B's fetcher annotations
// (docs/MCP_INTEGRATION.md). Only the bare product keys — the provenance
// keys (mcp.versions.<product>.source / .commit / …) are not versions.
// null when the pack carries none (file-sourced B, or no version probe
// answered): an absence, never "unchanged".
export function liveVersions(canonicalB) {
  const ann = canonicalB?.metadata?.annotations || {};
  const out = {};
  for (const key of Object.keys(ann).sort()) {
    const m = /^mcp\.versions\.([^.]+)$/.exec(key);
    if (m && ann[key] != null && String(ann[key]) !== '') out[m[1]] = String(ann[key]);
  }
  return Object.keys(out).length ? out : null;
}

// The snapshot decision for this run, before anything is written. Pure so
// the policy is testable; `previousRun` is the newest record read before
// this run's write (null on the first run). A previous record that carries
// no chains (vantage lost, or written before chains were recorded) cannot
// be diffed, so the pack is kept: a snapshot nobody can compare against is
// cheaper than a transition nobody can explain.
export function livePackDecision({ policy, previousRun, transition, outcome, packBIsFile, packBSource }) {
  if (packBIsFile) return { kept: false, reason: `Pack B is a file (${packBSource})` };
  const p = KEEP_LIVE_PACK_POLICIES.includes(policy) ? policy : KEEP_LIVE_PACK_DEFAULT;
  if (p === 'never') return { kept: false, reason: 'keepLivePack: never' };
  if (p === 'always') return { kept: true, reason: 'keepLivePack: always' };
  if (!previousRun) return { kept: true, reason: 'first run (no previous record)' };
  if (previousRun.outcome === 'vantage-lost') return { kept: true, reason: `previous run ${previousRun.startedAt || '?'} lost its vantage` };
  if (!transition) return { kept: true, reason: `previous run ${previousRun.startedAt || '?'} carries no chain record to compare` };
  if (transition.any) {
    const bits = [];
    if (transition.changed.length) bits.push(`${transition.changed.length} changed`);
    if (transition.appeared.length) bits.push(`${transition.appeared.length} appeared`);
    if (transition.disappeared.length) bits.push(`${transition.disappeared.length} disappeared`);
    return { kept: true, reason: `chains changed since ${previousRun.startedAt || '?'}: ${bits.join(' · ')}` };
  }
  if (outcome === 'gate-failed') return { kept: true, reason: 'gate failed' };
  return { kept: false, reason: `no transition since ${previousRun.startedAt || '?'}` };
}

// The snapshot filename shape beside a record: `live/<record stem>.json`.
// Only this shape is ever read back or pruned — a hand-edited record path
// cannot point outside the journey's live/ directory.
export const LIVE_PACK_PATH_RE = /^live\/(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.json$/;
const runStem = (startedAt) => String(startedAt).replace(/[:.]/g, '-');

// Write Pack B's canonical JSON beside the record. Returns the livePack
// field for the record; a failure lands as `error` (the caller notes it as
// historyError) — the verdict already exists and is never thrown away.
function writeLivePack(name, startedAt, canonical) {
  const stem = runStem(startedAt);
  const relPath = `live/${stem}.json`;
  const dir = join(runsDir(name), 'live');
  try {
    const text = JSON.stringify(canonical, null, 2);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${stem}.json`), text);
    return { path: relPath, bytes: Buffer.byteLength(text, 'utf8'), error: null };
  } catch (e) {
    return { path: null, bytes: null, error: `live pack ${relPath}: ${e.message}` };
  }
}

// The parsed Pack B snapshot of a run record, or null when the record
// kept none, the path is not the snapshot shape, or the file is gone /
// unparseable (a pruned snapshot reads as absent, never as an error).
export function readLivePack(name, record) {
  const rel = record?.livePack?.path;
  if (typeof rel !== 'string' || !LIVE_PACK_PATH_RE.test(rel)) return null;
  try { return JSON.parse(readFileSync(join(runsDir(name), 'live', `${LIVE_PACK_PATH_RE.exec(rel)[1]}.json`), 'utf8')); } catch (_) { return null; }
}

// Pure: which files of live/ no longer have a run record. Only names of the
// run-file shape are candidates; a snapshot whose record exists is never
// named, whatever else the directory holds.
export function pruneLiveSnapshots(recordFiles, liveFiles) {
  const records = new Set((Array.isArray(recordFiles) ? recordFiles : []).filter(f => typeof f === 'string' && JOURNEY_RUN_FILE_RE.test(f)));
  return (Array.isArray(liveFiles) ? liveFiles : [])
    .filter(f => typeof f === 'string' && JOURNEY_RUN_FILE_RE.test(f) && !records.has(f))
    .sort();
}

// ---------- the run ----------

export async function runJourney(def, { baseDir } = {}) {
  def.__baseDir = baseDir || (def.__source ? dirname(def.__source) : '.');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const a = await resolvePackA(def, def.__baseDir);
  let b;
  try {
    b = await resolvePackB(def);
  } catch (e) {
    // Only a LIVE source that reached the wire can lose its vantage; a
    // missing pack file or an unset authEnv is a configuration error and
    // leaves no record.
    if (def.packB?.mcp && e?.vantageLost) {
      writeRunRecord(def.name, startedAt, {
        journey: def.name,
        startedAt,
        tookMs: Date.now() - t0,
        outcome: 'vantage-lost',
        error: String(e.message || e),
        packA: { source: a.source, name: a.canonical?.metadata?.name || null, version: a.canonical?.metadata?.version || null },
        packB: { source: `mcp:${def.packB.mcp.url}` },
        scope: { env: def.env || null, service: def.service || null, scopeMode: def.scopeMode || null },
        gate: { thresholds: def.gate || {}, breaches: [] },
      });
    }
    throw e;
  }

  for (const [label, pack] of [['packA', a.canonical], ['packB', b.canonical]]) {
    const errors = validateCanonical(pack, SCHEMA);
    if (errors.length) throw new Error(`${label} failed schema validation: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`);
  }

  const layeredA = adapt(a.canonical, { environment: def.env || undefined });
  const layeredB = adapt(b.canonical, {});
  // Same construct as the studio's /api/diff: the requirement-chain
  // comparison rides on the diff, and the grade's Drift-free criterion
  // reads it when declared commitments exist. Without it the CLI would
  // grade on raw diff buckets while the studio graded on chain integrity
  // — two scores for one comparison.
  const diff = {
    ...diffPacks(layeredA, layeredB, { scopeMode: def.scopeMode, service: def.service }),
    traceabilityGraph: comparePackBranches(layeredA, layeredB),
  };
  const conformance = evaluateConformance(a.canonical);
  const posture = computePostureMatrix(layeredA, layeredB);
  const grade = computeDiagnosticGrade(layeredA, layeredB, posture, null, diff);

  const liveRefreshedAt = b.canonical?.metadata?.annotations?.['mcp.refreshedAt'] || null;
  const live = liveEvidenceFacts(b.canonical);
  // grade.overall.audit is the canonical PASS/FAIL contract (score > 85%).
  const audit = grade.overall?.audit || { scorePctExact: 0, passes: false };
  const facts = {
    gradeScore: Math.round(audit.scorePctExact ?? 0),
    gradePass: !!audit.passes,
    alignmentPct: Math.round((diff.summary?.alignment ?? 0) * 100),
    declaredNotLive: diff.summary?.onlyInA ?? 0,
    liveNotDeclared: diff.summary?.onlyInB ?? 0,
    drifted: diff.summary?.drifted ?? 0,
    aligned: diff.summary?.aligned ?? 0,
    liveAgeHours: hoursSince(liveRefreshedAt),
    ...live,
  };
  const breaches = evaluateGate(def.gate, facts);
  const rollup = diff.traceabilityGraph?.rollup || null;
  const outcome = breaches.length ? 'gate-failed' : 'pass';

  // Step 4: the per-chain verdicts this run saw, the previous record they
  // are compared against (read BEFORE this run is written, so the diff is
  // against history, never against itself) and the snapshot decision.
  const branches = branchRecordsFromGraph(diff.traceabilityGraph);
  const chains = chainSummary({ branches });
  const previousRun = readJourneyRuns(def.name, { limit: 1 })[0] || null;
  const transition = diffRunBranches(previousRun, { branches });
  const livePackDecided = livePackDecision({
    policy: def.keepLivePack, previousRun, transition, outcome,
    packBIsFile: !!def.packB?.file, packBSource: b.source,
  });
  let livePack = { kept: false, path: null, reason: livePackDecided.reason };
  let livePackError = null;
  if (livePackDecided.kept) {
    const written = writeLivePack(def.name, startedAt, b.canonical);
    if (written.error) livePackError = written.error;
    else livePack = { kept: true, path: written.path, bytes: written.bytes, reason: livePackDecided.reason };
  }

  const record = {
    journey: def.name,
    startedAt,
    tookMs: Date.now() - t0,
    // Workstream D gate-contract fields. This is VERIFICATION evidence.
    packA: { source: a.source, name: a.canonical?.metadata?.name || null, version: a.canonical?.metadata?.version || null },
    packB: { source: b.source, name: b.canonical?.metadata?.name || null, version: b.canonical?.metadata?.version || null, refreshedAt: liveRefreshedAt },
    scope: { env: def.env || null, service: def.service || null, scopeMode: def.scopeMode || null },
    // schema identifies which scoring construct produced the score, so a
    // step in the gradeScore series is explainable as re-scoring vs reality
    // (schema 1: 8 scored criteria incl. Actionable; schema 2: 7 — Actionable
    // is informational operability).
    grade: {
      score: facts.gradeScore, pass: facts.gradePass, threshold: DIAGNOSTIC_PASS_SCORE_THRESHOLD,
      schema: grade.gradeSchema ?? 1,
      letter: grade.overall?.instrumentGrade?.letter ?? null,
      letterLabel: grade.overall?.instrumentGrade?.label ?? null,
      // Which construct Drift-free was scored on: requirement-chain
      // integrity (studio parity) when declared commitments exist, else
      // the diff buckets. Explains a score step across a pack change.
      driftConstruct: rollup && rollup.declaredTotal > 0 ? 'requirement-chain' : 'diff-buckets',
    },
    traceability: rollup ? {
      integrityPct: rollup.integrityPct, intact: rollup.intact, partial: rollup.partial,
      broken: rollup.broken, undeclared: rollup.undeclared, declaredTotal: rollup.declaredTotal,
    } : null,
    // Step 4: per requirement chain — the scored verdict, the on-wire ladder
    // verdict and the degraded nodes with their blast radius (chain-history.mjs;
    // caps 64 branches × 16 nodes, `truncated` marks a cut). [] when the
    // graph has no branches.
    branches,
    // The listing summary over `branches` (counts, means, top exposure);
    // GET /api/journeys recomputes the same function from the record.
    chains,
    // mcp.versions.<product> as Pack B reported them; null when none.
    versions: liveVersions(b.canonical),
    // What changed since the previous record's chains; null on the first
    // run or when the previous record carries no chains (vantage lost).
    transition,
    // Whether Pack B was snapshotted beside this record and why (policy
    // keepLivePack, default transitions). A file-sourced B is never kept.
    livePack,
    conformance: { scorePercent: conformance.scorePercent, mustPercent: conformance.mustPercent, conformant: conformance.conformant, declaredTier: conformance.declaredTier },
    drift: {
      alignmentPct: facts.alignmentPct,
      aligned: facts.aligned,
      drifted: facts.drifted,
      declaredNotLive: facts.declaredNotLive,
      liveNotDeclared: facts.liveNotDeclared,
      outOfScope: diff.summary?.outOfScope ?? 0,
      // Placeholders parked on either side (never paired, never counted).
      scaffold: diff.summary?.scaffold ?? 0,
    },
    freshness: { liveAgeHours: facts.liveAgeHours, refreshedAt: liveRefreshedAt },
    // On-wire liveness of the vantage point itself (Pack B annotations).
    // probes.* are family NAMES so a breach can say which hole it saw.
    probes: live.probes,
    probeErrors: live.probeErrors,
    vantage: live.vantage,
    toolsExposedCount: live.toolsExposedCount,
    scrapeJobsDown: live.scrapeJobsDown,
    unhealthyRules: live.unhealthyRules,
    // Step 2 stack self-metric sample counts — recorded as a signal for the
    // drift-over-time series, never gated on.
    stack: live.stack,
    // Step 3: the samples this run saw (rows + Alertmanager / Grafana
    // status), null when Pack B carries no panel. Point-in-time evidence
    // kept per run so the history is the time series; gate.stack reads it.
    stackEvidence: live.stackEvidence,
    gate: { thresholds: def.gate || {}, breaches },
    outcome,
  };
  // Step 4: candidate causes for the chains that got worse since the
  // previous run — ranked over Observogram's own deploys inside the window
  // (previous start, this start] with every item's artifact selector
  // resolved against Pack A (the ranker matches names exactly, never by
  // substring), the drift and version facts of this record and its stack
  // samples (chain-history.mjs rankCauses). A vantage change rides beside
  // them, never among them. null on the first run: nothing to explain yet.
  record.causes = previousRun
    ? rankCauses({ previous: previousRun, current: record, deploys: resolveDeployItems(deploysInWindow(readDeployLog(), previousRun.startedAt ?? null, startedAt), a.canonical) })
    : null;
  if (livePackError) record.historyError = livePackError;

  writeRunRecord(def.name, startedAt, record);
  return record;
}

// ---------- run history + retention ----------
//
// One JSON per run under runs/<journey>/ — the drift-over-time series the
// journeys surface reads. Continuity is the point (a journey run from cron
// every few minutes is the intended cadence), so the directory is bounded:
// after every write it is pruned to the newest JOURNEY_RUN_RETENTION files.
// Filenames are the ISO start time with ':' and '.' replaced, so their
// lexical order IS their chronological order; "newest" needs no stat.
export const JOURNEY_RUN_RETENTION_DEFAULT = 1000;

// Defensive parse of the retention knob: a non-negative integer, else the
// default. 0 means unlimited (no pruning). Exported so the policy is
// testable without touching the environment.
export function parseRunRetention(raw, fallback = JOURNEY_RUN_RETENTION_DEFAULT) {
  if (raw === undefined || raw === null) return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return fallback;
  const n = Number(s);
  return Number.isSafeInteger(n) && n >= 0 ? n : fallback;
}

// Read at write time (not at import) so an operator's env change and a
// test's env flip both take effect on the next run. OBSERVOGRAM_JOURNEY_RUN_RETENTION
// (legacy TOMOGRAPH_* spelling honoured by brandEnv).
export function journeyRunRetention() {
  return parseRunRetention(brandEnv('JOURNEY_RUN_RETENTION') || undefined);
}

// The run filename shape writeRunRecord produces: the ISO start time with
// ':' and '.' replaced by '-'. Only names of this shape are run records for
// retention — a hand-dropped notes.json would otherwise sort after every
// ISO name, count as the "newest" run and displace a real record.
export const JOURNEY_RUN_FILE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.json$/;

// Pure retention policy: given the run filenames of one journey and the
// number to keep, return the names to delete, oldest first. keep <= 0 (or
// a non-number) means unlimited → nothing is deleted. Files that are not
// run records (JOURNEY_RUN_FILE_RE) are never candidates and never count.
export function pruneRunFiles(files, keep) {
  const n = Number(keep);
  if (!Number.isFinite(n) || n <= 0) return [];
  const runs = (Array.isArray(files) ? files : [])
    .filter(f => typeof f === 'string' && JOURNEY_RUN_FILE_RE.test(f))
    .sort();
  const excess = runs.length - Math.floor(n);
  return excess > 0 ? runs.slice(0, excess) : [];
}

// A write failure is reported on the record, never thrown: the verdict
// already exists. Pruning likewise: a file that cannot be deleted is noted
// as historyError and the run still counts.
function writeRunRecord(name, startedAt, record) {
  const dir = runsDir(name);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${runStem(startedAt)}.json`), JSON.stringify(record, null, 2));
  } catch (e) {
    record.historyError = [record.historyError, e.message].filter(Boolean).join('; ');
    return;
  }
  const keep = journeyRunRetention();
  const errors = [];
  let victims = [];
  if (keep > 0) {
    try { victims = pruneRunFiles(readdirSync(dir), keep); } catch (e) { errors.push(`list ${dir}: ${e.message}`); }
    for (const f of victims) {
      try { unlinkSync(join(dir, f)); } catch (e) { errors.push(`prune ${f}: ${e.message}`); }
    }
  }
  // Step 4: a live-pack snapshot outlives its record only until the next
  // write — then it is an orphan and goes. Listed AFTER the record prune so
  // the survivors are the records that still exist; a snapshot whose
  // record exists is never touched. No live/ directory: nothing to do.
  const liveDir = join(dir, 'live');
  let liveFiles = null;
  try { liveFiles = readdirSync(liveDir); } catch (_) { liveFiles = null; }
  if (liveFiles) {
    let orphans = [];
    try { orphans = pruneLiveSnapshots(readdirSync(dir), liveFiles); } catch (e) { errors.push(`list ${dir}: ${e.message}`); }
    for (const f of orphans) {
      try { unlinkSync(join(liveDir, f)); } catch (e) { errors.push(`prune live/${f}: ${e.message}`); }
    }
  }
  if (errors.length) {
    record.historyError = [record.historyError, ...errors].filter(Boolean).join('; ');
  }
}

export function readJourneyRuns(name, { limit = 50 } = {}) {
  const dir = runsDir(name);
  let files = [];
  try { files = readdirSync(dir).filter(f => f.endsWith('.json')).sort().reverse(); } catch (_) { return []; }
  const out = [];
  for (const f of files.slice(0, limit)) {
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); } catch (_) {}
  }
  return out;
}

// Observogram's own deploy audit — server/workspace.mjs appends it as JSON
// lines to deploys.jsonl under the same workspace root the runs live in.
// Read here without importing server code (the engine stays
// server-agnostic): every parseable line, deploy and verify alike, for
// chain-history's deploysInWindow to window and merge. Missing file → [];
// a torn or unparseable line is skipped, never fatal.
function readDeployLog() {
  let raw = '';
  try { raw = readFileSync(join(workspaceRoot(), 'deploys.jsonl'), 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const rec = JSON.parse(line);
      if (rec && typeof rec === 'object' && !Array.isArray(rec)) out.push(rec);
    } catch (_) {}
  }
  return out;
}

// The names a deploy item's `artifact` selector stands for in Pack A — the
// selectors the server persists on its audit lines (server/routes/deploy.mjs
// writes the compile selector: `all`, `declared:<i>`, `slo:<id>`,
// `dash:<id>`; a rollback writes the bare dashboard uid). Resolved here,
// where the pack is in memory, following the studio's post-deploy verifier
// (studio/verify-deploy.mjs): `declared:<i>` → the i-th declared recording
// rule's name; `slo:<id>` → the SLO id, its SLI base and the SLI the pack
// binds it to; `dash:<id>` → the dashboard id; a bare name → itself; `all`
// and an unresolvable index → nothing (a group-wide write is the pack-level
// touch the ranker scores on its own). Names only — the ranker matches
// them exactly.
export function resolveDeployArtifact(artifact, canonicalA) {
  const a = String(artifact ?? '').trim();
  const low = a.toLowerCase();
  if (!a || low === 'all') return [];
  const spec = canonicalA?.spec || {};
  if (low.startsWith('declared:')) {
    const idx = /^declared:(\d+)$/i.exec(a);
    const name = idx ? (Array.isArray(spec.queries?.recording_rules) ? spec.queries.recording_rules[Number(idx[1])]?.name : null) : null;
    return typeof name === 'string' && name ? [name] : [];
  }
  if (low.startsWith('slo:')) {
    const id = a.slice(4);
    if (!id) return [];
    const slo = (Array.isArray(spec.slos) ? spec.slos : []).find(s => s && typeof s === 'object' && s.id === id);
    const sli = typeof slo?.sli === 'string' ? slo.sli.replace(/^slis\./, '') : '';
    return [...new Set([id, sliBaseOfSloId(id), sli].filter(Boolean))];
  }
  if (low.startsWith('dash:')) return a.slice(5) ? [a.slice(5)] : [];
  return [a];
}

// Every item of every windowed deploy, with `resolved` beside its
// `artifact` for the ranker. Records are copied, never mutated.
function resolveDeployItems(deploys, canonicalA) {
  return deploys.map(d => (d && typeof d === 'object' && Array.isArray(d.items)
    ? { ...d, items: d.items.map(it => (it && typeof it === 'object' && !Array.isArray(it) ? { ...it, resolved: resolveDeployArtifact(it.artifact, canonicalA) } : it)) }
    : d));
}

// ---------- report rendering ----------

function probesLine(r) {
  const p = r.probes;
  if (!p || !p.attempted?.length) return (!r.vantage || r.vantage === 'none') ? 'no live probes (file-sourced B)' : `vantage ${r.vantage}`;
  const fam = (xs) => (xs && xs.length) ? xs.join(', ') : '-';
  return `${p.attempted.length} attempted · succeeded: ${fam(p.succeeded)} · empty: ${fam(p.empty)} · **failed: ${fam(p.failed)}** · not exposed: ${fam(p.unsupported)} · vantage **${r.vantage}**`
    + (r.toolsExposedCount != null ? ` · ${r.toolsExposedCount} MCP tools exposed` : '');
}

function stackLine(r) {
  const s = r.stack;
  if (!s || !s.status) return 'no stack sample (file-sourced B or pre-step-2 refresh)';
  if (s.status === 'not-attempted') return `not attempted (${s.reason || 'no reason recorded'})`;
  return `sampled ${s.sampled ?? 0} · empty ${s.empty ?? 0} · failed ${s.failed ?? 0}`;
}

export function renderJourneyMarkdown(r) {
  if (r.outcome === 'vantage-lost') {
    return [
      `## ⚠️ Journey \`${r.journey}\` — VANTAGE LOST`,
      '',
      `| | |`,
      `|---|---|`,
      `| Declared (A) | \`${r.packA?.name || '?'}@${r.packA?.version || '?'}\` — ${r.packA?.source || '?'} |`,
      `| Live (B) | ${r.packB?.source || '?'} — **unreachable** |`,
      `| Error | ${r.error || '?'} |`,
      `| Took | ${r.tookMs ?? '?'}ms |`,
      '',
      '_No verdict: the live vantage point did not answer, so nothing about the declared artefacts could be verified. Recorded so the loss is a point in history, not a gap._',
    ].join('\n');
  }
  const icon = r.outcome === 'pass' ? '✅' : '❌';
  const lines = [
    `## ${icon} Journey \`${r.journey}\` — ${r.outcome === 'pass' ? 'PASS' : 'GATE FAILED'}`,
    '',
    `| | |`,
    `|---|---|`,
    `| Declared (A) | \`${r.packA.name || '?'}@${r.packA.version || '?'}\` — ${r.packA.source} |`,
    `| Live/reference (B) | \`${r.packB.name || '?'}@${r.packB.version || '?'}\` — ${r.packB.source} |`,
    `| Scope | env=${r.scope.env || '-'} service=${r.scope.service || '-'} mode=${r.scope.scopeMode || 'default'} |`,
    `| Diagnostic grade | **${r.grade.letter ? `${r.grade.letter} · ${r.grade.letterLabel} · ` : ''}${r.grade.score}%** (${r.grade.pass ? 'PASS' : 'FAIL'}, bar ${r.grade.threshold}%) |`,
    `| Conformance | ${r.conformance.scorePercent}% (${r.conformance.declaredTier}, ${r.conformance.conformant ? 'conformant' : 'not conformant'}) |`,
    `| Alignment | **${r.drift.alignmentPct}%** — ${r.drift.aligned} aligned · ${r.drift.drifted} drifted · ${r.drift.declaredNotLive} declared-not-live · ${r.drift.liveNotDeclared} live-not-declared |`,
    `| Live freshness | ${r.freshness.liveAgeHours === null ? 'no refresh timestamp' : r.freshness.liveAgeHours.toFixed(1) + 'h old'} |`,
    `| Live probes | ${probesLine(r)} |`,
    `| On-wire health | ${r.scrapeJobsDown ?? 0} scrape job(s) down · ${r.unhealthyRules ?? 0} unhealthy rule(s) |`,
    `| Stack self-metrics | ${stackLine(r)} |`,
    `| Took | ${r.tookMs}ms |`,
  ];
  lines.push(...stackEvidenceTable(r.stackEvidence));
  lines.push(...requirementChainsTable(r.branches));
  lines.push(...transitionsSection(r));
  lines.push(...causesSection(r));
  if (r.gate.breaches.length) {
    lines.push('', '### Gate breaches', '');
    for (const b of r.gate.breaches) lines.push(`- **${b.criterion}** — ${b.detail}`);
  }
  lines.push('', '_Verification evidence (declared vs observed); not incident-validated._');
  return lines.join('\n');
}

// Step 4: one row per requirement chain (cap CHAIN_REPORT_ROW_CAP), only
// when the record carries chains — no table means no chains were declared
// or recorded, never that every chain is intact. The worst node is the
// first of the branch's degraded list (worst first by construction).
const CHAIN_REPORT_ROW_CAP = 24;
const mdCell = (v) => String(v ?? '-').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
function requirementChainsTable(branches) {
  const rows = Array.isArray(branches) ? branches.filter(b => b && typeof b === 'object') : [];
  if (!rows.length) return [];
  const out = [
    '',
    '### Requirement chains',
    '',
    '| chain | verdict | ladder | integrity | ladder integrity | worst node |',
    '|---|---|---|---|---|---|',
  ];
  for (const b of rows.slice(0, CHAIN_REPORT_ROW_CAP)) {
    const worst = Array.isArray(b.degraded) && b.degraded[0] ? worstNodeCell(b.degraded[0]) : '-';
    const more = Array.isArray(b.degraded) && b.degraded.length > 1 ? ` (+${b.degraded.length - 1}${b.truncated ? '+' : ''} more)` : (b.truncated ? ' (+more)' : '');
    out.push(`| ${mdCell(b.title || b.rootKey)} | ${mdCell(b.verdict)} | ${mdCell(b.ladderVerdict)} | ${mdCell(b.integrityPct)}% | ${mdCell(b.ladderIntegrityPct)}% | ${mdCell(worst)}${more} |`);
  }
  if (rows.length > CHAIN_REPORT_ROW_CAP) out.push('', `_${rows.length - CHAIN_REPORT_ROW_CAP} more chain(s) not shown._`);
  out.push('', '_Ladder columns are on-wire liveness beside the scored verdict — unscored; `unobserved` means the vantage could not look, never "absent"._');
  return out;
}

function worstNodeCell(node) {
  const bits = [String(node.status ?? '?')];
  if (node.ladder?.detail) bits.push(String(node.ladder.detail));
  const slos = node.blastRadius?.slos;
  if (typeof slos === 'number') bits.push(`blinds ${slos} SLO${slos === 1 ? '' : 's'}`);
  return `${node.label || node.key || '?'} (${bits.join(' · ')})`;
}

// What moved since the previous record, plus whether Pack B was kept.
// A record written before transitions existed (no `transition` key) gets
// no section; null means there was no previous record to compare.
function transitionsSection(r) {
  if (!Object.prototype.hasOwnProperty.call(r, 'transition') && !r.livePack) return [];
  const out = ['', '### Transitions since previous run', ''];
  const t = r.transition;
  if (!t) {
    out.push('_no previous run to compare_');
  } else if (!t.any) {
    out.push(`_no chain changed since ${t.since || 'the previous run'}_`);
  } else {
    for (const c of t.changed || []) {
      const nodes = [];
      if (c.nodes?.newlyDegraded?.length) nodes.push(`newly degraded: ${c.nodes.newlyDegraded.join(', ')}`);
      if (c.nodes?.recovered?.length) nodes.push(`recovered: ${c.nodes.recovered.join(', ')}`);
      out.push(`- **${c.title || c.rootKey}** — ${c.from?.verdict}/${c.from?.ladderVerdict} → ${c.to?.verdict}/${c.to?.ladderVerdict} (${c.direction})${nodes.length ? `; ${nodes.join('; ')}` : ''}`);
    }
    if (t.appeared?.length) out.push(`- appeared: ${t.appeared.join(', ')}`);
    if (t.disappeared?.length) out.push(`- disappeared: ${t.disappeared.join(', ')}`);
  }
  if (r.livePack && typeof r.livePack === 'object') {
    out.push('', r.livePack.kept
      ? `live pack: kept (${r.livePack.path}, ${r.livePack.bytes} bytes) — ${r.livePack.reason}`
      : `live pack: not kept — ${r.livePack.reason}`);
  }
  return out;
}

// Chain status of a run record in a few words, for `packc journey list`:
// 'chains 8/10 intact · ladder 7 healthy · 2 degraded' (zero ladder
// buckets other than healthy are omitted), or 'chains none' when the record
// carries no chains or declares none.
export function chainStatusLine(record) {
  const s = chainSummary(record);
  if (!s || !s.declaredTotal) return 'chains none';
  const ladder = [`${s.ladder.healthy} healthy`];
  for (const k of ['degraded', 'broken', 'unobserved']) if (s.ladder[k] > 0) ladder.push(`${s.ladder[k]} ${k}`);
  return `chains ${s.intact}/${s.declaredTotal} intact · ladder ${ladder.join(' · ')}`;
}

// Step 4: the candidate causes of a worse transition, ranked by evidence
// (chain-history.mjs rankCauses) — never a root-cause verdict, the heading
// says so. A record written before the ranker existed (no `causes` key)
// gets no section; null means there was no previous run to rank against.
// The vantage line rides beside the causes, never among them.
function causesSection(r) {
  if (!Object.prototype.hasOwnProperty.call(r, 'causes')) return [];
  const out = ['', '### Candidate causes — ranked by evidence, not a root-cause verdict', ''];
  const c = r.causes;
  if (!c || typeof c !== 'object') { out.push('_no previous run_'); return out; }
  const list = Array.isArray(c.causes) ? c.causes.filter(x => x && typeof x === 'object') : [];
  if (!list.length) out.push(`_no chain got worse since ${c.transitions?.since || r.transition?.since || 'the previous run'}_`);
  const titles = new Map((Array.isArray(r.branches) ? r.branches : []).filter(b => b && typeof b === 'object').map(b => [String(b.rootKey), b.title || b.rootKey]));
  for (const cause of list) {
    const chains = Array.isArray(cause.chains) ? cause.chains.map(k => titles.get(String(k)) || k) : [];
    out.push(`${cause.rank}. [${cause.kind}] ${cause.score} — ${cause.evidence}${chains.length ? ` (chains: ${chains.join(', ')})` : ''}`);
  }
  if (c.vantage && typeof c.vantage === 'object') out.push('', c.vantage.changed ? `vantage changed: ${c.vantage.detail}` : 'vantage: unchanged');
  return out;
}

// The rank-1 candidate cause of a run record in a few words, for `packc
// journey list`: 'top cause: [observogram-deploy] deploy dep_x by …' or
// 'no candidate causes'. The CLI appends it only when a chain got worse.
export function causeLine(record) {
  const top = topCause(record);
  return top ? `top cause: [${top.kind}] ${top.evidence}` : 'no candidate causes';
}

// Whether a run record's transition got worse (or its ranker found a
// cause) — the CLI's condition for appending causeLine.
export function transitionGotWorse(record) {
  const changed = Array.isArray(record?.transition?.changed) ? record.transition.changed : [];
  return changed.some(c => c && c.direction === 'worse') || topCause(record) !== null;
}

// The samples this run saw, one row each (cap STACK_REPORT_ROW_CAP). Only
// rendered when there are rows: a not-attempted or absent panel already
// reads on the Stack self-metrics line above, and an empty table would
// look like an empty (healthy) stack.
const STACK_REPORT_ROW_CAP = 24;
function stackEvidenceTable(se) {
  const rows = Array.isArray(se?.rows) ? se.rows : [];
  if (!rows.length) return [];
  const cell = (v) => String(v ?? '-').replace(/\|/g, '\\|');
  const out = [
    '',
    '### Stack self-metrics — point-in-time samples',
    '',
    '| id | family | value unit | outcome | hint | reference SLI |',
    '|---|---|---|---|---|---|',
  ];
  for (const row of rows.slice(0, STACK_REPORT_ROW_CAP)) {
    const value = row.outcome === 'data' && typeof row.value === 'number' ? `${formatStackValue(row.value, row.unit)} ${row.unit || ''}`.trim() : '-';
    const outcome = row.outcome + (row.reason ? `: ${row.reason}` : '');
    out.push(`| ${cell(row.id)} | ${cell(row.family)} | ${cell(value)} | ${cell(outcome)} | ${cell(row.hint)} | ${cell(row.referenceSli)} |`);
  }
  if (rows.length > STACK_REPORT_ROW_CAP) out.push('', `_${rows.length - STACK_REPORT_ROW_CAP} more row(s) not shown._`);
  out.push('', "_Samples, not verdicts: each value is the stack's own self-metric at the moment of the run._");
  return out;
}

// Stack status of a run record in a few words, for `packc journey list`:
// 'stack sampled N' (rows that answered data), 'stack not attempted', or
// 'stack none' when the record carries no panel at all. Pre-step-3
// records (counts only) fall back to the fetcher's sampled count.
export function stackStatusLine(record) {
  const se = record?.stackEvidence;
  if (se && typeof se === 'object') {
    if (se.status !== 'sampled') return 'stack not attempted';
    return `stack sampled ${(Array.isArray(se.rows) ? se.rows : []).filter(r => r.outcome === 'data').length}`;
  }
  const s = record?.stack;
  if (s && s.status === 'sampled') return `stack sampled ${s.sampled ?? 0}`;
  if (s && s.status === 'not-attempted') return 'stack not attempted';
  return 'stack none';
}
