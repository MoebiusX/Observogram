// tools/lib/journey-notify.mjs
//
// EARLY-WARNING DELIVERY — the pure half of a journey's `notify:` block
// (roadmap step 5). Observogram monitors the artefacts that monitor the
// system; a journey run is one observation of them, and this module decides
// WHETHER that observation is worth a message and WHAT the message says.
// The wire itself (env-var resolution, the bounded POST, the record field)
// lives in tools/lib/journey.mjs — the Node-only exception.
//
// Definition (journey file):
//   notify:
//     urlEnv: MY_JOURNEY_WEBHOOK_URL   # env var NAME holding the POST URL (required)
//     authEnv: MY_JOURNEY_WEBHOOK_TOKEN # optional; Authorization: Bearer <value>
//     on: transitions                  # transitions (default) | breach | always
//     format: json                     # json (default) | text (one line + markdown body)
//     timeoutMs: 5000                  # per attempt; clamp [1000, 60000]; one retry
//     studioUrl: https://studio.example # optional non-secret literal → links in the payload
//
// Secrets never live in a journey file: `url`, `token` and `headers` are
// refused at load time; the env vars are resolved at RUN time only.
//
// Zero-import and browser-safe: the studio can preview a decision or a
// payload from a run record with the same code the runner used.

export const NOTIFY_POLICIES = Object.freeze(['transitions', 'breach', 'always']);
export const NOTIFY_DEFAULT_POLICY = 'transitions';
export const NOTIFY_FORMATS = Object.freeze(['json', 'text']);
export const NOTIFY_DEFAULT_FORMAT = 'json';
export const NOTIFY_TIMEOUT_DEFAULT_MS = 5000;
export const NOTIFY_TIMEOUT_MIN_MS = 1000;
export const NOTIFY_TIMEOUT_MAX_MS = 60000;
export const NOTIFY_PAYLOAD_KIND = 'observogram.journey';
export const NOTIFY_PAYLOAD_VERSION = 1;
// The keys a notify block may carry, and the literal-secret keys it may not.
export const NOTIFY_KEYS = Object.freeze(['urlEnv', 'authEnv', 'on', 'format', 'timeoutMs', 'studioUrl']);
export const NOTIFY_FORBIDDEN_KEYS = Object.freeze({
  url: 'reference an env var name with urlEnv',
  token: 'reference an env var name with authEnv',
  headers: 'only Authorization: Bearer <authEnv value> is sent',
});
export const ENV_NAME_RE = /^[A-Z_][A-Z0-9_]*$/i;
const CAUSES_IN_TEXT = 3;

const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// Whether a run record's chain transition got worse — the same predicate
// journey.mjs transitionGotWorse applies to `transition.changed` (that
// function also consults the ranker's top cause; the ranker only ranks
// worse transitions, so the two agree on every recorded run — pinned by
// tools/test-journey.mjs). Re-implemented here so the module stays
// zero-import.
export function chainGotWorse(record) {
  const changed = Array.isArray(record?.transition?.changed) ? record.transition.changed : [];
  return changed.some(c => c && c.direction === 'worse');
}

// Key = JSON of the [kind, evidence] pair: unambiguous (no separator can
// collide with either value) and free of control bytes in the source.
const causeKey = (c) => JSON.stringify([String(c?.kind ?? ''), String(c?.evidence ?? '')]);
const causesOf = (record) => (Array.isArray(record?.causes?.causes) ? record.causes.causes : []).filter(isObj);

// Candidate causes of `record` that `previousRun` did not already carry
// (by kind + evidence). A cause repeated run after run is old news.
export function newCandidateCauses(record, previousRun) {
  const seen = new Set(causesOf(previousRun).map(causeKey));
  return causesOf(record).filter(c => !seen.has(causeKey(c)));
}

// The decision: { send, reason, triggers[] }. Pure over the record and the
// newest previous record (null on a first run).
//   always      → send every run.
//   breach      → send on a non-pass run (gate-failed / vantage-lost) and
//                 once when a breach clears; a pass after a pass is skipped.
//   transitions → send when the outcome changed, a chain got worse, a new
//                 candidate cause appeared or the vantage changed. A first
//                 run is a baseline, not a transition (skipped — this
//                 deliberately differs from livePackDecision, which keeps
//                 the first run's snapshot). A vantage-lost run after a
//                 vantage-lost run is skipped: nobody is paged every 15 min
//                 for an outage they already know about.
export function notifyDecision({ policy = NOTIFY_DEFAULT_POLICY, record, previousRun = null } = {}) {
  const p = NOTIFY_POLICIES.includes(policy) ? policy : NOTIFY_DEFAULT_POLICY;
  const outcome = String(record?.outcome ?? 'unknown');
  const prev = isObj(previousRun) ? previousRun : null;
  const prevOutcome = prev ? String(prev.outcome ?? 'unknown') : null;
  if (p === 'always') return { send: true, reason: 'policy always', triggers: ['always'] };
  if (p === 'breach') {
    if (outcome === 'vantage-lost') return { send: true, reason: 'vantage lost', triggers: ['vantage-lost'] };
    if (outcome !== 'pass') {
      const criteria = (Array.isArray(record?.gate?.breaches) ? record.gate.breaches : []).map(b => String(b?.criterion ?? '?'));
      const uniq = [...new Set(criteria)];
      return { send: true, reason: `gate failed: ${uniq.join(', ') || outcome}`, triggers: uniq.length ? uniq.map(c => `gate-failed:${c}`) : [`gate-failed`] };
    }
    if (prev && prevOutcome !== 'pass') return { send: true, reason: `breach cleared: ${prevOutcome} → pass`, triggers: ['breach-cleared'] };
    return { send: false, reason: 'outcome pass, no breach to clear', triggers: [] };
  }
  // transitions
  if (!prev) return { send: false, reason: 'first run: no previous run to compare against', triggers: [] };
  if (outcome === 'vantage-lost' && prevOutcome === 'vantage-lost') {
    return { send: false, reason: `still vantage-lost since ${prev.startedAt || '?'}`, triggers: [] };
  }
  const triggers = [];
  if (prevOutcome !== outcome) triggers.push(`outcome changed ${prevOutcome} → ${outcome}`);
  if (chainGotWorse(record)) triggers.push('chain got worse');
  if (newCandidateCauses(record, prev).length) triggers.push('new candidate cause');
  if (record?.causes?.vantage?.changed === true) triggers.push('vantage changed');
  if (!triggers.length) return { send: false, reason: `no transition since ${prev.startedAt || '?'}`, triggers: [] };
  return { send: true, reason: triggers.join(' · '), triggers };
}

// `//user:pass@host` → `//***@host`. The same regex as server/mcp-url.mjs
// redactCredentials — duplicated on purpose: this module must not import
// server code (it is served to the browser).
export function redactUrlCredentials(text) {
  return String(text ?? '').replace(/\/\/[^/\s@]+@/g, '//***@');
}

// The record stem (the run file name without .json): startedAt with ':'
// and '.' replaced by '-'. Same shape as journey.mjs runStem.
export const runIdOf = (startedAt) => String(startedAt ?? '').replace(/[:.]/g, '-');

const packRef = (p) => ({
  name: p?.name ?? null,
  version: p?.version ?? null,
  source: p?.source == null ? null : redactUrlCredentials(p.source),
});

// The JSON-serialisable payload. Everything is COPIED from the record
// (transition, causes, chains, stack rows), never recomputed; nothing from
// the definition's notify block, no env value, no raw userinfo and none of
// the record's historyError paths ride along. `text` is the one-line
// summary the caller assembled (journey.mjs has chainStatusLine /
// causeLine / vantageLine); `links` is {} unless notify.studioUrl is set.
export function buildNotifyPayload({ record, previousRun = null, decision, links = {}, text = '' } = {}) {
  const r = isObj(record) ? record : {};
  const rows = Array.isArray(r.stackEvidence?.rows) ? r.stackEvidence.rows.filter(isObj) : [];
  return {
    kind: NOTIFY_PAYLOAD_KIND,
    version: NOTIFY_PAYLOAD_VERSION,
    journey: r.journey ?? null,
    runId: runIdOf(r.startedAt),
    startedAt: r.startedAt ?? null,
    tookMs: r.tookMs ?? null,
    outcome: r.outcome ?? null,
    previousOutcome: isObj(previousRun) ? (previousRun.outcome ?? null) : null,
    reason: decision?.reason ?? null,
    triggers: Array.isArray(decision?.triggers) ? decision.triggers.slice() : [],
    // A vantage-lost record carries the fetch error (credentials redacted).
    error: r.error == null ? null : redactUrlCredentials(r.error),
    gate: { breaches: Array.isArray(r.gate?.breaches) ? r.gate.breaches : [] },
    // `off`: the criteria the score left out (the service's switches at that run) — only when it left some out.
    grade: isObj(r.grade) ? { score: r.grade.score ?? null, pass: r.grade.pass ?? null, letter: r.grade.letter ?? null, ...(Array.isArray(r.grade.off) && r.grade.off.length ? { off: r.grade.off.filter((k) => typeof k === 'string').slice(0, 7) } : {}) } : null,
    drift: isObj(r.drift) ? { alignmentPct: r.drift.alignmentPct ?? null, drifted: r.drift.drifted ?? null, declaredNotLive: r.drift.declaredNotLive ?? null, liveNotDeclared: r.drift.liveNotDeclared ?? null } : null,
    freshness: { liveAgeHours: r.freshness?.liveAgeHours ?? null },
    vantage: r.vantage ?? null,
    probes: { failed: Array.isArray(r.probes?.failed) ? r.probes.failed : [] },
    transition: r.transition ?? null,
    causes: r.causes ?? null,
    chains: r.chains ?? null,
    stack: rows.map(row => ({ id: row.id ?? null, family: row.family ?? null, outcome: row.outcome ?? null, value: row.value ?? null, unit: row.unit ?? null, hint: row.hint ?? null })),
    livePack: r.livePack ?? null,
    packs: { a: packRef(r.packA), b: packRef(r.packB) },
    links: isObj(links) ? links : {},
    text: String(text ?? ''),
  };
}

// `format: text` — the one-line summary, a blank line, then a compact
// markdown body: breaches, the transition lines, the top causes (never a
// root-cause verdict), the vantage line and the links. ntfy-style: the
// first line is the notification, the rest is the body.
export function renderNotifyText(payload) {
  const p = isObj(payload) ? payload : {};
  const out = [String(p.text || `${p.journey ?? '?'}: ${p.outcome ?? '?'}`), ''];
  out.push(`reason: ${p.reason ?? '-'}`);
  if (p.error) out.push(`error: ${p.error}`);
  const breaches = Array.isArray(p.gate?.breaches) ? p.gate.breaches : [];
  if (breaches.length) {
    out.push('', 'gate breaches:');
    for (const b of breaches) out.push(`- ${b?.criterion ?? '?'} — ${b?.detail ?? ''}`);
  }
  const changed = Array.isArray(p.transition?.changed) ? p.transition.changed.filter(isObj) : [];
  if (changed.length) {
    out.push('', `transitions since ${p.transition?.since ?? 'the previous run'}:`);
    for (const c of changed) out.push(`- ${c.title || c.rootKey || '?'}: ${c.from?.verdict ?? '?'}/${c.from?.ladderVerdict ?? '?'} → ${c.to?.verdict ?? '?'}/${c.to?.ladderVerdict ?? '?'} (${c.direction ?? '?'})`);
  }
  const causes = Array.isArray(p.causes?.causes) ? p.causes.causes.filter(isObj) : [];
  if (causes.length) {
    out.push('', 'candidate causes — ranked by evidence, not a root-cause verdict:');
    for (const c of causes.slice(0, CAUSES_IN_TEXT)) out.push(`${c.rank ?? '-'}. [${c.kind ?? '?'}] ${c.evidence ?? ''}`);
    if (causes.length > CAUSES_IN_TEXT) out.push(`(+${causes.length - CAUSES_IN_TEXT} more)`);
  }
  if (p.causes?.vantage?.changed === true) out.push('', `vantage changed: ${p.causes.vantage.detail ?? ''}`);
  const links = isObj(p.links) ? Object.entries(p.links) : [];
  if (links.length) { out.push(''); for (const [k, v] of links) out.push(`${k}: ${v}`); }
  return out.join('\n') + '\n';
}
