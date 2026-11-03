// tools/lib/lifecycle.mjs
//
// A statement that rules were authored ahead of an environment. A team writes a
// rules file before its service reaches prod; compared with prod, every rule in
// it would read "declared, not live", which looks like drift and is not.
//
// The statement is a comment block that opens the rules file, so it sits beside
// the rules and survives a re-crawl:
//
//   # observogram-lifecycle:
//   #   maturity: authored
//   #   deployment:
//   #     prod: planned
//   #     staging: deployed
//
// The crawler reads it (readLifecycleBlock) into one annotation, which is also
// what a hand-written pack states directly:
//
//   observogram.lifecycle: [{ source, maturity?, deployment: { <env>: <state> }, symbols: [...] }]
//
// A symbol names what the statement covers: `slis.<id>`, `slos.<id>`,
// `queries.recording_rules.<name>`, `alerting.rules.<name>`,
// `policy.burn_rate_alerts.<slo>` or `metrics.<name>`. The adapter stamps the
// statement on those artefacts as `lifecycle`, and tools/lib/diff.mjs parks an
// unpaired artefact whose state for the compared environment is explicitly not
// `deployed`. No statement, or no state for that environment, changes nothing.
//
// Pure ESM, no Node APIs.

export const LIFECYCLE_ANNOTATION = 'observogram.lifecycle';
export const LIFECYCLE_STATES = Object.freeze(['deployed', 'planned', 'not-deployed']);

const MARKER_RE = /^\s*#(\s*)observogram-lifecycle:\s*$/;
const ENV_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const MATURITY_RE = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const MAX_ENVIRONMENTS = 16;
const ENV_ALIASES = Object.freeze({ production: 'prod', prd: 'prod', staging: 'stg', stage: 'stg', development: 'dev' });
const SOURCE_MAX_LENGTH = 512;
// What may stand above the block: nothing there can have opened a YAML string, so
// the marker is a comment and not a rule's prose quoting one.
const ABOVE_BLOCK_RE = /^\s*(?:#.*|---\s*|\{\{.*\}\}\s*)?$/;

/** The one spelling of an environment name: `production` and `prod` are one environment. */
export function normalizeLifecycleEnvironment(name) {
  const env = String(name ?? '').trim().toLowerCase();
  return ENV_ALIASES[env] || env;
}

// One statement's fields, checked. The reason names the rule and never quotes
// what the file said, so a warning cannot carry a file's text.
function checkStatement({ maturity, deployment }) {
  if (maturity !== undefined && !MATURITY_RE.test(String(maturity))) return { problem: 'maturity must be one word' };
  const envs = deployment && typeof deployment === 'object' && !Array.isArray(deployment) ? Object.entries(deployment) : [];
  if (!envs.length) return { problem: 'it states no deployment' };
  if (envs.length > MAX_ENVIRONMENTS) return { problem: `it states more than ${MAX_ENVIRONMENTS} environments` };
  const clean = {};
  for (const [env, state] of envs) {
    const key = normalizeLifecycleEnvironment(env);
    if (!ENV_RE.test(key)) return { problem: 'an environment name is not a plain word' };
    if (!LIFECYCLE_STATES.includes(state)) return { problem: `a deployment state is not one of ${LIFECYCLE_STATES.join(', ')}` };
    if (key in clean && clean[key] !== state) return { problem: 'two spellings of one environment disagree' };
    clean[key] = state;
  }
  return { statement: { ...(maturity !== undefined ? { maturity: String(maturity) } : {}), deployment: clean } };
}

/**
 * The lifecycle block of a file's raw text: null when it has none, else
 * `{ statement }` or `{ problem }`. Raw text, because the YAML reader strips
 * comments, and that is why the block must open the file: further down, the same
 * lines may be a description or an expression that quotes one. It ends at the first
 * line that is not a comment indented under the marker.
 */
export function readLifecycleBlock(text) {
  if (typeof text !== 'string' || !text.includes('observogram-lifecycle:')) return null;
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => MARKER_RE.test(line));
  if (start < 0) return null;
  if (!lines.slice(0, start).every((line) => ABOVE_BLOCK_RE.test(line))) return { problem: 'the block must open the file, with only comments above it' };
  if (lines.slice(start + 1).some((line) => MARKER_RE.test(line))) return { problem: 'the file holds more than one block' };
  const base = MARKER_RE.exec(lines[start])[1].length;
  const fields = { deployment: undefined, maturity: undefined };
  let inDeployment = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const m = /^\s*#(\s*)(\S.*?)\s*$/.exec(lines[i]);
    if (!m || m[1].length <= base) break;
    const indent = m[1].length;
    const pair = /^([^\s:]+):(?:\s+(\S+))?$/.exec(m[2]);
    if (!pair) return { problem: 'a line of the block is not "key: value"' };
    const [, key, value] = pair;
    if (inDeployment && indent > inDeployment) {
      if (value === undefined) return { problem: 'a deployment state is missing' };
      fields.deployment[key] = value.replace(/^["']|["']$/g, '');
      continue;
    }
    inDeployment = 0;
    if (key === 'maturity' && value !== undefined) {
      fields.maturity = value.replace(/^["']|["']$/g, '');
    } else if (key === 'deployment' && value === undefined) {
      fields.deployment = {};
      inDeployment = indent;
    } else {
      return { problem: 'the block takes only maturity and a nested deployment' };
    }
  }
  return checkStatement(fields);
}

/**
 * The annotation's statements by symbol, `Map<symbol, { source, maturity?, deployment }>`.
 * An annotation is anyone's text: what does not read is left out, so an artefact
 * it should have covered simply reads as usual. The first statement naming a
 * symbol holds it.
 */
export function lifecycleBySymbol(annotation) {
  const out = new Map();
  if (typeof annotation !== 'string' || !annotation) return out;
  let parsed;
  try { parsed = JSON.parse(annotation); } catch { return out; }
  if (!Array.isArray(parsed)) return out;
  for (const entry of parsed) {
    if (!entry || typeof entry !== 'object' || !Array.isArray(entry.symbols)) continue;
    const { statement } = checkStatement(entry);
    if (!statement) continue;
    const named = typeof entry.source === 'string' && entry.source && entry.source.length <= SOURCE_MAX_LENGTH;
    const stamped = { ...(named ? { source: entry.source } : {}), ...statement };
    for (const symbol of entry.symbols) {
      if (typeof symbol === 'string' && !out.has(symbol)) out.set(symbol, stamped);
    }
  }
  return out;
}

/** True when two statements say the same about every environment. */
export function sameDeployment(a, b) {
  const entries = (statement) => JSON.stringify(Object.entries(statement?.deployment || {}).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
  return entries(a) === entries(b);
}

/** An artefact's explicit state for an environment, or null when its statement names none. */
export function lifecycleStateFor(lifecycle, environment) {
  if (!lifecycle || typeof lifecycle !== 'object' || !environment) return null;
  const state = lifecycle.deployment?.[normalizeLifecycleEnvironment(environment)];
  return LIFECYCLE_STATES.includes(state) ? state : null;
}
