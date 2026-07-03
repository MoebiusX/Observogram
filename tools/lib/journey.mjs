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

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { resolve, join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, emit as emitYaml } from './mini-yaml.mjs';
import { validateCanonical } from './validator.mjs';
import { adapt } from './adapter.mjs';
import { evaluateConformance } from './conformance.mjs';
import { diffPacks } from './diff.mjs';
import { crawlFiles } from './crawler.mjs';
import { baseWorkspacePath } from './brand-env.mjs';
import { computeDiagnosticGrade, computePostureMatrix, DIAGNOSTIC_PASS_SCORE_THRESHOLD } from '../../studio/diagnostic-grade.mjs';

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
  def.__source = source;
  return def;
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
  const fetched = await fetchMcp({ mcpUrl: m.url, mcpAuth });
  const refreshedAt = new Date().toISOString();
  const canonical = buildCanonicalPack({ refreshedAt, mcpUrl: m.url, ...fetched });
  return { canonical, source: `mcp:${m.url}` };
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
  return breaches;
}

// ---------- the run ----------

export async function runJourney(def, { baseDir } = {}) {
  def.__baseDir = baseDir || (def.__source ? dirname(def.__source) : '.');
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const a = await resolvePackA(def, def.__baseDir);
  const b = await resolvePackB(def);

  for (const [label, pack] of [['packA', a.canonical], ['packB', b.canonical]]) {
    const errors = validateCanonical(pack, SCHEMA);
    if (errors.length) throw new Error(`${label} failed schema validation: ${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (+${errors.length - 3} more)` : ''}`);
  }

  const layeredA = adapt(a.canonical, { environment: def.env || undefined });
  const layeredB = adapt(b.canonical, {});
  const diff = diffPacks(layeredA, layeredB, { scopeMode: def.scopeMode, service: def.service });
  const conformance = evaluateConformance(a.canonical);
  const posture = computePostureMatrix(layeredA, layeredB);
  const grade = computeDiagnosticGrade(layeredA, layeredB, posture, null, diff);

  const liveRefreshedAt = b.canonical?.metadata?.annotations?.['mcp.refreshedAt'] || null;
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
  };
  const breaches = evaluateGate(def.gate, facts);

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
    },
    conformance: { scorePercent: conformance.scorePercent, mustPercent: conformance.mustPercent, conformant: conformance.conformant, declaredTier: conformance.declaredTier },
    drift: {
      alignmentPct: facts.alignmentPct,
      aligned: facts.aligned,
      drifted: facts.drifted,
      declaredNotLive: facts.declaredNotLive,
      liveNotDeclared: facts.liveNotDeclared,
      outOfScope: diff.summary?.outOfScope ?? 0,
    },
    freshness: { liveAgeHours: facts.liveAgeHours, refreshedAt: liveRefreshedAt },
    gate: { thresholds: def.gate || {}, breaches },
    outcome: breaches.length ? 'gate-failed' : 'pass',
  };

  // History: one JSON per run — the drift-over-time series.
  try {
    const dir = runsDir(def.name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify(record, null, 2));
  } catch (e) {
    record.historyError = e.message;
  }
  return record;
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

// ---------- report rendering ----------

export function renderJourneyMarkdown(r) {
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
    `| Took | ${r.tookMs}ms |`,
  ];
  if (r.gate.breaches.length) {
    lines.push('', '### Gate breaches', '');
    for (const b of r.gate.breaches) lines.push(`- **${b.criterion}** — ${b.detail}`);
  }
  lines.push('', '_Verification evidence (declared vs observed); not incident-validated._');
  return lines.join('\n');
}
