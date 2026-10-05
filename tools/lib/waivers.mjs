// tools/lib/waivers.mjs
//
// Waivers (GAP batch 2, B3.2): the time-boxed, reasoned suppression of a
// conformance finding. A waiver names ONE rubric clause (`ruleId`, the id of
// tools/lib/conformance.mjs RUBRIC — or, in a sidecar file, a placeholder
// rule of tools/lib/pack-conformance.mjs) and, optionally, ONE canonical
// symbol of it (`artefactId`: `slis.<id>`, `slos.<id>` — the adapter's
// `defines` vocabulary, never a JSONPath), with a reason, an author, an
// expiry and the time it was recorded. A waiver never rewrites a report: the
// overlay keeps the engine's numbers and adds a `waivers` block with the
// `effective` numbers beside them (docs/CONFORMANCE.md "Waivers").
//
// Two homes, one object: the server keeps waivers on the service record
// (server/store/waivers.mjs, served by GET /api/services/:id/waivers) and the
// CLI reads a sidecar file (`packc conformance --waivers <file>`, the shape
// readWaiverFile accepts). Both hand this module the same normalized object.
//
// States are computed, never stored: `revoked` (revokedAt set — kept as
// history, matches nothing), `expired` (expiresAt at or before `now` — the
// finding fails again and the report surfaces the lapsed waiver), `active`.
// Matching: the clause must agree; a pack-level waiver (artefactId null)
// covers every subject of the clause, an artefact-scoped one covers that
// subject alone and beats a pack-level one; among equals the newest wins.
// A clause whose failing subjects are all covered is `waived`; some of them,
// `partial` (still failing); none, with a lapsed waiver on one, `expired`.
//
// Pure ESM, browser-safe, vendorable (a listed module); imports
// ./conformance.mjs (clauseSubjects) only. Every text an operator typed
// stays as typed — the renderers escape, this module refuses control
// characters so a reason is one line.

import { clauseSubjects } from './conformance.mjs';

export const MAX_REASON = 2000;
export const MAX_TEXT = 200;
export const WAIVER_FILE_VERSION = 1;
export const WAIVER_STATES = Object.freeze(['active', 'expired', 'revoked']);
export const FINDING_STATUSES = Object.freeze(['failing', 'waived', 'expired']);
export const CLAUSE_WAIVER_STATUSES = Object.freeze(['waived', 'partial', 'expired']);

const WORD = /^\S+$/;
const DAY_MS = 86400000;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const refuse = (message) => { throw new Error(`waiver: ${message}`); };
const nowIso = (now) => (typeof now === 'string' ? new Date(now).toISOString() : new Date().toISOString());

// A control character (U+0000–U+001F, U+007F) anywhere: a line break, a tab,
// an escape — none belongs in a reason, an author, a rule or a symbol.
const hasControl = (s) => { for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); if (c < 32 || c === 127) return true; } return false; };

/** Text of 1–`max` characters on one line (no control character) — the one text rule every waiver field follows. */
export function oneLine(value, max) {
  return typeof value === 'string' && value.length >= 1 && value.length <= max && !hasControl(value);
}

const line = oneLine;
const word = (v, max) => line(v, max) && WORD.test(v);

// ---------- the shape ----------

function isoOf(value, field, { optional = false } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    refuse(`${field} is an ISO time (toISOString()), not ${JSON.stringify(value)}`);
  }
  const ms = typeof value === 'string' && value.trim() !== '' ? Date.parse(value) : NaN;
  if (!Number.isFinite(ms)) refuse(`${field} is an ISO time (toISOString()), not ${JSON.stringify(value)}`);
  return new Date(ms).toISOString();
}

/**
 * One waiver as every reader takes it — { id, artefactId, ruleId, reason,
 * expiresAt, author, createdAt, revokedAt, revokedBy, revokeReason } with the
 * times normalised to toISOString(), `id` and `createdAt` null when absent,
 * unknown keys dropped. Throws `waiver: …` on a bad field.
 */
export function normalizeWaiver(raw) {
  if (!isObj(raw)) refuse('a waiver is an object');
  if (!word(raw.ruleId, MAX_TEXT)) refuse('ruleId is a clause id (L1.MUST.availability_slo) or a placeholder rule (placeholder.<family>.<field>), one word of 1–200 characters');
  const artefactId = raw.artefactId === undefined || raw.artefactId === null ? null : raw.artefactId;
  if (artefactId !== null && !word(artefactId, MAX_TEXT)) refuse("artefactId is a canonical symbol as the adapter's defines names it (slis.<id>, slos.<id>), one word of 1–200 characters, or null");
  if (!line(raw.reason, MAX_REASON)) refuse(`a reason is one line of 1–${MAX_REASON} characters`);
  if (!line(raw.author, MAX_TEXT)) refuse(`author is one line of 1–${MAX_TEXT} characters`);
  const expiresAt = isoOf(raw.expiresAt, 'expiresAt');
  const createdAt = isoOf(raw.createdAt, 'createdAt', { optional: true });
  const revokedAt = isoOf(raw.revokedAt, 'revokedAt', { optional: true });
  const revokedBy = raw.revokedBy === undefined || raw.revokedBy === null ? null : raw.revokedBy;
  if (revokedBy !== null && !line(revokedBy, MAX_TEXT)) refuse(`revokedBy is one line of 1–${MAX_TEXT} characters`);
  if (revokedAt !== null && revokedBy === null) refuse('a revoked waiver names who revoked it (revokedBy)');
  const revokeReason = raw.revokeReason === undefined || raw.revokeReason === null ? null : raw.revokeReason;
  if (revokeReason !== null && !line(revokeReason, MAX_REASON)) refuse(`a revoke reason is one line of 1–${MAX_REASON} characters`);
  const id = typeof raw.id === 'number' || typeof raw.id === 'string' ? raw.id : null;
  return { id, artefactId, ruleId: raw.ruleId, reason: raw.reason, expiresAt, author: raw.author, createdAt, revokedAt, revokedBy, revokeReason };
}

// ---------- the states ----------

/** active | expired | revoked at `now` (an ISO time; the current time when omitted). */
export function waiverState(waiver, now) {
  if (waiver.revokedAt) return 'revoked';
  return waiver.expiresAt <= nowIso(now) ? 'expired' : 'active';
}

/** Whole days until the expiry (ceil; negative once expired). */
export function expiresInDays(waiver, now) {
  return Math.ceil((Date.parse(waiver.expiresAt) - Date.parse(nowIso(now))) / DAY_MS);
}

/** The waiver with its computed `state` and `expiresInDays` — the view the API serves and the overlay quotes. */
export function waiverView(waiver, now) {
  return { ...waiver, state: waiverState(waiver, now), expiresInDays: expiresInDays(waiver, now) };
}

// ---------- the matching ----------

/** A finding is { ruleId, subject? }: the clause must agree; a pack-level waiver covers every subject, a scoped one its own. */
export function matchesFinding(waiver, finding) {
  if (waiver.ruleId !== finding.ruleId) return false;
  return waiver.artefactId === null || waiver.artefactId === (finding.subject ?? null);
}

const stripIndex = ({ index: _index, ...w }) => w;

// Artefact-scoped beats pack-level; then the newest (createdAt, then the later entry) wins.
const rank = (a, b) => (b.artefactId === null ? 0 : 1) - (a.artefactId === null ? 0 : 1) || String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? '')) || b.index - a.index;

/**
 * The findings with their waiver status: { findings: [{ …finding, status: failing | waived | expired, waiver }],
 * counts: { failing, waived, expired, unused }, unused: [waiver views that matched nothing] }. A revoked waiver matches
 * nothing; an expired one that would have matched marks the finding `expired` (it fails) and is surfaced on it.
 */
export function applyWaiversToFindings(findings, waivers, { now } = {}) {
  const at = nowIso(now);
  const open = (waivers || []).filter(w => w && !w.revokedAt).map((w, index) => ({ w, index, state: waiverState(w, at) }));
  const matched = new Set();
  const out = (findings || []).map((f) => {
    const hits = open.filter(o => matchesFinding(o.w, f));
    for (const h of hits) matched.add(h);
    const pick = (state) => hits.filter(o => o.state === state).map(o => ({ ...o.w, index: o.index })).sort(rank)[0];
    const active = pick('active');
    const expired = active ? null : pick('expired');
    const chosen = active || expired || null;
    return { ...f, status: active ? 'waived' : expired ? 'expired' : 'failing', waiver: chosen ? waiverView(stripIndex(chosen), at) : null };
  });
  const unused = open.filter(o => !matched.has(o)).map(o => waiverView(o.w, at));
  const counts = { failing: 0, waived: 0, expired: 0, unused: unused.length };
  for (const f of out) counts[f.status]++;
  return { findings: out, counts, unused };
}


// ---------- the conformance overlay ----------

// The evaluator's arithmetic (tools/lib/conformance.mjs evaluateConformance)
// over clauses whose `pass` is read with the waived ones met.
function effectiveOf(clauses) {
  const must = { passed: 0, total: 0 };
  const should = { passed: 0, total: 0 };
  const byDimension = {};
  for (const c of clauses) {
    if (!c.applies) continue;
    byDimension[c.dimension] ||= { applicable: 0, mustPassed: 0, mustTotal: 0, shouldPassed: 0, shouldTotal: 0 };
    byDimension[c.dimension].applicable++;
    if (c.severity === 'MUST') {
      must.total++;
      byDimension[c.dimension].mustTotal++;
      if (c.pass) { must.passed++; byDimension[c.dimension].mustPassed++; }
    } else if (c.severity === 'SHOULD') {
      should.total++;
      byDimension[c.dimension].shouldTotal++;
      if (c.pass) { should.passed++; byDimension[c.dimension].shouldPassed++; }
    }
  }
  const denom = must.total + 0.5 * should.total;
  const numer = must.passed + 0.5 * should.passed;
  return {
    conformant: must.total > 0 && must.passed === must.total,
    scorePercent: denom === 0 ? 100 : Math.round((numer / denom) * 100),
    mustPercent: must.total === 0 ? 100 : Math.round((must.passed / must.total) * 100),
    must,
    should,
    byDimension,
  };
}

const sameWaiver = (a, b) => a === b || (a.id !== null && a.id === b.id) || (a.id === null && b.id === null && a.ruleId === b.ruleId && a.artefactId === b.artefactId && a.createdAt === b.createdAt && a.expiresAt === b.expiresAt && a.author === b.author && a.reason === b.reason);

/**
 * A conformance report with its waivers applied. With no open (unrevoked) waiver the SAME report object comes back —
 * the inert proof. Otherwise `{ ...report, waivers: { counts, clauses: { [id]: { status: waived | partial | expired,
 * waivers[], subjects: { failing, waived, remaining } | null } }, effective: { conformant, must, should, scorePercent,
 * mustPercent, byDimension }, unused[] } }` — the engine's numbers untouched, the effective ones beside them. The
 * failing subjects of a per-item clause come from `subjectsOf(clauseId, canonical)` (clauseSubjects); a clause
 * graded for the whole pack, or any clause when no canonical is given, is one finding with no subject.
 */
export function applyWaiversToConformance(report, waivers, { now, canonical = null, subjectsOf = clauseSubjects } = {}) {
  const open = (waivers || []).filter(w => w && !w.revokedAt);
  if (!open.length) return report;
  const at = nowIso(now);
  const failing = (report.clauses || []).filter(c => c.applies && !c.pass);
  const subjectsBy = new Map();
  const findings = [];
  for (const c of failing) {
    const subjects = canonical ? subjectsOf(c.id, canonical) : null;
    const list = Array.isArray(subjects) && subjects.length ? subjects : null;
    subjectsBy.set(c.id, list);
    if (list) for (const s of list) findings.push({ ruleId: c.id, subject: s });
    else findings.push({ ruleId: c.id, subject: null });
  }
  const applied = applyWaiversToFindings(findings, open, { now: at });
  const clauses = {};
  for (const c of failing) {
    const own = applied.findings.filter(f => f.ruleId === c.id);
    const waived = own.filter(f => f.status === 'waived');
    const expired = own.filter(f => f.status === 'expired');
    if (!waived.length && !expired.length) continue;
    const status = waived.length === own.length ? 'waived' : waived.length ? 'partial' : 'expired';
    const views = [];
    for (const f of own) if (f.waiver && !views.some(v => sameWaiver(v, f.waiver))) views.push(f.waiver);
    const list = subjectsBy.get(c.id);
    clauses[c.id] = {
      status,
      waivers: views,
      subjects: list ? { failing: list, waived: waived.map(f => f.subject), remaining: list.filter(s => !waived.some(f => f.subject === s)) } : null,
    };
  }
  const effective = effectiveOf((report.clauses || []).map(c => (clauses[c.id]?.status === 'waived' ? { ...c, pass: true } : c)));
  return { ...report, waivers: { counts: applied.counts, clauses, effective, unused: applied.unused } };
}

// ---------- the sidecar file ----------

/**
 * A waiver file — `{ version: 1, waivers: [ { ruleId, artefactId?, reason, expiresAt, author, createdAt?, … } ] }`,
 * the object the API serves per waiver — read into normalized waivers with their states counted at `now`:
 * { version, waivers, counts: { active, expired, revoked } }. Throws `waiver file: …` naming the entry.
 */
export function readWaiverFile(json, { now } = {}) {
  if (!isObj(json)) throw new Error('waiver file: the document is an object { version: 1, waivers: [...] }');
  if (json.version !== WAIVER_FILE_VERSION) throw new Error(`waiver file: version must be ${WAIVER_FILE_VERSION}, not ${JSON.stringify(json.version)}`);
  if (!Array.isArray(json.waivers)) throw new Error('waiver file: waivers must be an array');
  const at = nowIso(now);
  const waivers = json.waivers.map((raw, i) => {
    try { return normalizeWaiver(raw); }
    catch (e) { throw new Error(`waiver file: waivers[${i}]: ${String(e.message).replace(/^waiver: /, '')}`, { cause: e }); }
  });
  const counts = Object.fromEntries(WAIVER_STATES.map(s => [s, 0]));
  for (const w of waivers) counts[waiverState(w, at)]++;
  return { version: WAIVER_FILE_VERSION, waivers, counts };
}
