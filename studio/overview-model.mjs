// studio/overview-model.mjs — the Overview screen's model, pure.
//
// Overview is the studio's front door for everyone who is not doing the
// work: one service at a time, three answers, no reading required —
//
//   How well is it observed?        the diagnostic grade, as a letter and a label
//   Is that still true right now?   when it was last checked against live, and
//                                   whether what the repository declares still runs
//   What is the one thing to do?    one sentence, one button, at most three items
//
// Nothing here computes anew. The grade is computeDiagnosticGrade's (the pack
// alone, or the same engine run server-side by a journey with the live side as
// Pack B); "still true" is the service's journey and its last run (the one
// mechanism that yields a truthful "last checked at <time>"); the next step is
// the run's drift facts, or buildAssessmentDecision's causes when nothing live
// was ever checked. Every input is explicit, so the same functions run under
// node:test (tools/test-overview-model.mjs) and in the browser.
//
// Five status words, ever: Never checked · Unchanged · Changed · Unreachable ·
// Nothing compared — what the last check found. A service row's last check is
// in one of five states, which say what it rests on (lastCheckOf): Never
// checked · Unreachable · Nothing compared · Checked (partial) · Checked. No
// match figure without a comparison, no gate passed over nothing.
// No layer code, no artefact id, no percentage reaches a string this module
// returns (the test holds it to that). The formal terms live behind
// termHtml hovers in the renderer, never in the sentence.
//
// Two layouts draw the same model. The board (the default) shows the machine
// as pictures under the three questions — the stack's four layers with the
// kinds of signal each has, the grade with its seven criteria open, the live
// fidelity as a ring and four counts, the delta as three counts; the simple
// layout is the three sentences alone. Percentages stay numbers in this
// module (alignmentPct, pct); the renderer puts the sign on them.

import { agoText, packForService } from './services-model.mjs';
import { computeDiagnosticGrade, computePostureMatrix, instrumentGradeFor, INSTRUMENT_GRADE_SCALE, layerItemsFor, POSTURE_LAYERS, POSTURE_MECHANISMS_PER_LAYER, GRADE_CRITERIA, GRADE_SCHEMA, gradeOffKeys, isScaffoldArtefact } from './diagnostic-grade.mjs';
import { setAsideFingerprint } from './set-asides.mjs';
import { CHAIN_LINKS, declaredByTier, differencesOf, familyWords as tierWords } from './artefact-tiers.mjs';
import { MTTX_CUSTOM, MTTX_PROFILES, MTTX_RECOMMENDED, durationSeconds as targetSeconds, targetsTermKey, recommendedProfile, sameTargets, targetsFormProblems, targetsFormValues, targetsFromForm, targetsOptions, targetsRecord, targetsView } from './mttx-targets.mjs';
import { OBJECTIVE_WINDOWS, objectivesFormModel as objectiveRowsOf, objectivesFromForm, objectivesTermKey, sameObjectives, withStatedObjectives } from './slo-objectives.mjs';
import { AGREEMENT_OWNERS, COMMITMENTS_MAX, WEIGHT_MAX, agreementCurrent, commitmentFacts, commitmentId, commitmentsFromText, coverageSummary, coverageWords, gapsWords, linkText, linksFromText, sameAgreement } from './agreement.mjs';
import { CHAOS_RUN_AHEAD_MS, CHAOS_RUN_NOTE_MAX, CHAOS_RUN_OUTCOMES, CHAOS_RUNS_MAX, chaosRunId, chaosRunWords, mttdDuration, parseMttdText } from './chaos-runs.mjs';
import { LAYER_DEFS } from './constants.mjs';
import { CLAUSE_FIX } from './clause-fixes.mjs';

export const UI_MODE_KEY = 'studioUiMode.v1';
export const UI_MODES = Object.freeze(['overview', 'expert']);
export const OVERVIEW_LAYOUT_KEY = 'studioOverviewLayout.v1';
export const OVERVIEW_LAYOUTS = Object.freeze(['board', 'simple']);

// The layout: ?layout= wins (and is remembered by the caller), else the
// browser's preference, else the board.
export function decideOverviewLayout({ saved = null, query = null } = {}) {
  if (OVERVIEW_LAYOUTS.includes(query)) return query;
  if (OVERVIEW_LAYOUTS.includes(saved)) return saved;
  return 'board';
}

export const OVERVIEW_STATUS = Object.freeze({
  never: 'Never checked',
  unchanged: 'Unchanged',
  changed: 'Changed',
  unreachable: 'Unreachable',
  nothing: 'Nothing compared',
});

// The grade engine's freshness window (diagnostic-grade.mjs, the `fresh`
// criterion): a live reading older than this is not trusted.
export const FRESH_WINDOW_MS = 24 * 3600 * 1000;

// Tone per ladder tier (compare-view.mjs GRADE_TONE, private there).
export const GRADE_TONE = Object.freeze({ a: 'ok', b: 'warn', c: 'warn', d: 'fail', ref: 'info' });

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const things = (n) => plural(n, 'thing');

// ---------- which mode the studio opens in ----------

// `query` is the page's ?mode= (wins and is remembered by the caller), `saved`
// the browser's remembered preference, `hasServices` whether the org's
// services table has rows. The empty studio boots exactly as before — the
// hero home — so a first run lands on Overview only when there is a service
// to show; an investor never sees Overview's empty state, and the suites that
// boot an empty workspace see today's home.
export function decideUiMode({ saved = null, query = null, hasServices = false } = {}) {
  if (UI_MODES.includes(query)) return query;
  if (UI_MODES.includes(saved)) return saved;
  return hasServices ? 'overview' : 'expert';
}

// ---------- the service on screen ----------

// The services table's rows, the ones with a pack of their own first (a row
// whose only pack is a live aggregate's membership has nothing to grade), in
// table order within each group.
export function orderServicesForOverview(services, catalog, { isLiveAggregatePack = () => false } = {}) {
  const rows = Array.isArray(services) ? services.filter(Boolean) : [];
  const own = [], rest = [];
  for (const s of rows) {
    const { how } = packForService(s, catalog, { isLiveAggregatePack });
    (how === 'primary' ? own : rest).push(s);
  }
  return [...own, ...rest];
}

// The row to show: the remembered one when it is still there, else the first
// row with a pack of its own, else the first row; its environment the
// remembered one when the row has it, else the row's first.
export function pickOverviewService(services, catalog, { serviceId = null, env = null, isLiveAggregatePack = () => false } = {}) {
  const ordered = orderServicesForOverview(services, catalog, { isLiveAggregatePack });
  if (!ordered.length) return { service: null, env: null, envs: [], pack: null, how: 'none' };
  const service = ordered.find((s) => s.id === serviceId) || ordered[0];
  const envs = (service.environments || []).map((e) => e.name);
  const chosen = envs.includes(env) ? env : (envs[0] ?? null);
  const { pack, how } = packForService(service, catalog, { isLiveAggregatePack });
  return { service, env: chosen, envs, pack: pack || null, how };
}

// ---------- the journey that checks this service ----------

const baseName = (p) => String(p || '').replace(/\\/g, '/').split('/').pop();
const normalizeKey = (s) => String(s || '').trim().toLowerCase();

// A journey belongs to a service when its scope names the service, or when
// its Pack A is the service's own pack file (the listing's `packA` is the
// file path; a captured journey names the pack by id). The scope string is
// also the diff's service scope, so a journey of a live aggregate is captured
// without one — the pack is the surer link. A journey scoped to another
// environment checks that one, never this: each environment has its own
// check (a service's Run saves one per environment), so for an environment
// nobody checked the answer is none. Among the rest, the ones scoped to this
// environment first, then — within them — the ones that check the service's
// own pack (a check saved by the start or a Run, beside an older one scoped
// to the service); else the first.
export function journeyForService(journeys, { slug = null, env = null, packId = null } = {}) {
  const list = Array.isArray(journeys) ? journeys.filter(Boolean) : [];
  const byPack = (j) => !!packId && baseName(j.packA) === `${packId}.pack.yaml`;
  const mine = list.filter((j) => byPack(j) || (slug && normalizeKey(j.scope?.service) === normalizeKey(slug)));
  const fits = mine.filter((j) => !env || !j.scope?.env || j.scope.env === env);
  if (!fits.length) return null;
  const exact = env ? fits.filter((j) => j.scope?.env === env) : [];
  const scoped = exact.length ? exact : fits;
  const pool = scoped.some(byPack) ? scoped.filter(byPack) : scoped;
  return pool[0];
}

// The listing says where Pack B comes from: "mcp: <url>" for a live draft,
// a file path for a recording. Only a live journey can be checked again — a
// re-read of a recording proves nothing about production.
export function journeyIsLive(journey) {
  return /^mcp:/i.test(String(journey?.packB || ''));
}

// The comparison the board graded, for Expert's views: the live side the
// journey's last run read, which a host's server keeps as a pack (the
// journeys listing's `livePack: { id, label, refreshedAt }`) — only when it
// is THAT run's read (the same refreshedAt the record names as
// packB.refreshedAt), that run is the one the board's letter comes from
// (runGradesBoard: it graded `pack`, its live side did not shrink), and the
// catalogue has it. → { packBId, envB, label }, where envB is null: the run
// adapted Pack B with no environment. null otherwise — no live run yet, a
// run that lost its vantage or saw less than the check before (the board
// grades the repository alone then, and so does Expert), a recording, a
// listing without the field — and Expert opens on the repository alone, as
// before: a host whose server keeps no live pack is unchanged.
export function boardComparison({ journey = null, run = null, catalog = [], pack = null, off = [], aside = '', targets = '' } = {}) {
  const kept = journey?.livePack;
  const read = run?.packB?.refreshedAt;
  if (!kept || typeof kept.id !== 'string' || !kept.id || !read || kept.refreshedAt !== read) return null;
  if (!runGradesBoard(run, pack, off, aside, targets)) return null;
  if (!(Array.isArray(catalog) ? catalog : []).some((p) => p && p.id === kept.id && p.ok !== false)) return null;
  return { packBId: kept.id, envB: null, label: typeof kept.label === 'string' && kept.label ? kept.label : null };
}

// ---------- a live side that showed less than the check before ----------

// The run's causes.vantage compares which probe families failed with the
// check before. A family that newly failed means the live side showed less
// than last time, so the counts are not comparable with the last reading —
// a half-blind live side must never read as "86 things differ" (it did, the
// night before the first demo, while the stack behind the MCP restarted).
// The newly failed families; [] when the vantage held, grew, or is unknown.
const FAMILY_WORDS = { alerting_routes: 'alert routes', scrape_configs: 'scrape targets', recording_rules: 'recording rules', alert_rules: 'alert rules', dashboards: 'dashboards', metric_names: 'metric names' };
const familyWord = (f) => FAMILY_WORDS[f] || String(f || '').replace(/_/g, ' ');
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
export function vantageShrank(run) {
  const v = run?.causes?.vantage;
  if (!v || !v.changed) return [];
  // The check before saw nothing at all, or carried no live picture (a Run that stopped on a
  // partial scan): there is no earlier picture to have shrunk from (the first good check after
  // an outage is a recovery).
  if (!v.from || v.from.vantage === 'lost') return [];
  const from = Array.isArray(v.from?.failed) ? v.from.failed : [];
  const to = Array.isArray(v.to?.failed) ? v.to.failed : [];
  return to.filter((f) => !from.includes(f));
}

// ---------- what a run's figures rest on ----------
//
// The studio's copy of tools/lib/run-basis.mjs (a studio module never imports tools/lib;
// tools/test-run-basis.mjs pins the two equal): no figure without its basis. A run's match is a
// figure only over a comparison (drift.compared, or the four counts of an older record) and a
// live side that returned data; a vantage is lost when no probe family returned data, whatever an
// older record says; the first probe error is shown on one line, credentials masked.
const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finiteOf = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const countOf = (v) => { const n = finiteOf(v); return n !== null && n >= 0 ? Math.floor(n) : null; };
const namesOf = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : null);
const DRIFT_COUNTS = ['aligned', 'drifted', 'declaredNotLive', 'liveNotDeclared'];
const PROBE_ORDER = ['metric_names', 'recording_rules', 'alert_rules', 'dashboards', 'scrape_configs', 'alerting_routes'];
const probeRank = (f) => { const i = PROBE_ORDER.indexOf(f); return i < 0 ? PROBE_ORDER.length : i; };
const inProbeOrder = (xs) => xs.slice().sort((a, b) => probeRank(a) - probeRank(b) || a.localeCompare(b, 'en'));
// tools/lib/mcp-url-safety.mjs credentialParamName, restated: a name that is or ends in a credential word.
const CREDENTIAL_WORDS = ['token', 'tokens', 'key', 'keys', 'secret', 'secrets', 'pass', 'passwd', 'password', 'passphrase', 'passcode', 'pwd', 'auth', 'authorization', 'sig', 'signature', 'credential', 'credentials', 'jwt', 'session', 'sessionid', 'sessid', 'cookie', 'bearer', 'sas'];
const ORDINARY_WORDS = ['bypass', 'compass', 'overpass', 'surpass', 'monkey', 'donkey', 'turkey', 'hockey', 'jockey', 'whiskey', 'hotkey', 'obsession'];
const credentialWord = (w) => CREDENTIAL_WORDS.some((c) => w.endsWith(c)) && !ORDINARY_WORDS.some((o) => w.endsWith(o));
export function credentialName(name) {
  const text = String(name ?? '');
  const words = text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2').split(/[^A-Za-z]+/).filter(Boolean).map((w) => w.toLowerCase());
  return words.some(credentialWord) || credentialWord(text.replace(/[^A-Za-z]+/g, '').toLowerCase());
}
const decodedParam = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
export function safeErrorText(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/\/\/[^/\s@]+@/g, '//***@')
    .replace(/([?&;])([^=&;#\s]+)=([^&;#\s]*)/g, (m, sep, name) => (credentialName(decodedParam(name)) ? `${sep}${name}=***` : m))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
export const NOTHING_REASON = 'Neither side had anything this check could compare';

export function comparedOf(drift) {
  if (!isPlain(drift)) return null;
  const c = countOf(drift.compared);
  if (c !== null) return c;
  if (!DRIFT_COUNTS.some((k) => finiteOf(drift[k]) !== null)) return null;
  return DRIFT_COUNTS.reduce((s, k) => s + Math.max(0, finiteOf(drift[k]) ?? 0), 0);
}
export function vantageOf(record) {
  if (!isPlain(record)) return null;
  const p = isPlain(record.probes) ? record.probes : null;
  const attempted = p ? namesOf(p.attempted) : null;
  const succeeded = p ? namesOf(p.succeeded) : null;
  if (record.vantage === 'lost' || (attempted?.length && succeeded && !succeeded.length)) return 'lost';
  const v = typeof record.vantage === 'string' && record.vantage ? record.vantage : null;
  return v === 'restricted' ? 'full' : v;
}
export function matchPctOf(record) {
  if (!isPlain(record) || !isPlain(record.drift)) return null;
  if (comparedOf(record.drift) === 0 || vantageOf(record) === 'lost') return null;
  return finiteOf(record.drift.alignmentPct);
}
export function firstProbeErrorOf(record) {
  if (!isPlain(record)) return null;
  const errs = isPlain(record.probeErrors) ? record.probeErrors : {};
  const text = (v) => (typeof v === 'string' && v.trim() ? v : '');
  const raw = inProbeOrder(namesOf(record.probes?.failed) || []).map((f) => text(errs[f])).find(Boolean)
    || inProbeOrder(Object.keys(errs)).map((f) => text(errs[f])).find(Boolean) || '';
  if (raw) return safeErrorText(raw.split(' · ')[0]);
  if (!isPlain(record.probes) && (record.outcome === 'vantage-lost' || record.outcome === 'error') && text(record.error)) return safeErrorText(record.error);
  return null;
}
export function liveLossOf(record) {
  const error = firstProbeErrorOf(record);
  if (error) return { cause: 'error', error };
  const lost = vantageOf(record) === 'lost';
  if (lost && isPlain(record?.probes) && !(namesOf(record.probes.failed) || []).length) return { cause: 'no-data', error: null };
  return { cause: lost || record?.outcome === 'vantage-lost' || record?.outcome === 'error' ? 'error' : 'unknown', error: null };
}
export function readingOutcome(x) {
  if (!isPlain(x)) return null;
  const outcome = typeof x.outcome === 'string' && x.outcome ? x.outcome : null;
  if (outcome === 'scan-partial' || outcome === 'error') return outcome;
  if (outcome === 'vantage-lost' || vantageOf(x) === 'lost') return 'vantage-lost';
  const compared = isPlain(x.drift) ? comparedOf(x.drift) : countOf(x.compared);
  if ((outcome === 'pass' || outcome === 'gate-failed') && compared === 0) return 'nothing-compared';
  return outcome;
}
const lineOf = (v, max) => (typeof v === 'string' && v.trim() ? safeErrorText(v, max) : null);
// An older record's environment scope, by the surface its crawler profile stood for (never an environment's name).
const SURFACE_OF_PROFILE = Object.freeze({ prod: 'kubernetes', eks: 'eks', 'local-k8s': 'local-kubernetes', 'local-docker': 'compose' });
const surfaceOfProfile = (profile) => (profile && Object.hasOwn(SURFACE_OF_PROFILE, profile) ? SURFACE_OF_PROFILE[profile] : profile);
export function scanFactsOf(scan) {
  if (!isPlain(scan)) return null;
  let filter = null;
  if (isPlain(scan.filter) && lineOf(scan.filter.surface, 40)) filter = { surface: lineOf(scan.filter.surface, 40), excluded: countOf(scan.filter.excluded) ?? 0 };
  else if (isPlain(scan.environment) && (countOf(scan.environment.excluded) ?? 0) > 0) filter = { surface: surfaceOfProfile(lineOf(scan.environment.profile, 40)), excluded: countOf(scan.environment.excluded) };
  return {
    partial: scan.partial === true, notRead: countOf(scan.notRead), candidates: countOf(scan.candidates), files: countOf(scan.files),
    treeTruncated: scan.treeTruncated === true || scan.truncated === true, filter, excludedMost: scan.excludedMost === true,
  };
}
export function filesNotReadWords(s) {
  if (!isPlain(s)) return '';
  const known = s.notRead !== null && s.notRead > 0 && s.candidates !== null;
  const head = known ? `${s.notRead} of ${s.candidates} files not read` : s.partial ? 'The scan did not read every file' : '';
  const cut = s.treeTruncated ? 'the host cut its file list short' : '';
  return head && cut ? `${head}; ${cut}` : head || (cut ? `${cut[0].toUpperCase()}${cut.slice(1)}` : '');
}
export const stoppedRunKept = (record) => isPlain(record?.packA) && typeof record.packA.source === 'string' && record.packA.source !== '';
export function scanPartialReading(scan, { kept = true } = {}) {
  const s = scanFactsOf(scan);
  const tail = kept === false ? 'no complete scan of this repository is kept' : 'the previous pack is kept';
  return s && s.notRead !== null && s.candidates !== null
    ? `Partial scan — ${s.notRead} of ${s.candidates} files not read; ${tail}`
    : `Partial scan — ${tail}`;
}
export function basisFactsOf(record) {
  const r = isPlain(record) ? record : {};
  const tiers = isPlain(r.drift?.tiers) ? r.drift.tiers : null;
  const aside = isPlain(r.drift?.setAside) ? (countOf(r.drift.setAside.declaredNotLive) ?? 0) + (countOf(r.drift.setAside.liveNotDeclared) ?? 0) : 0;
  return {
    notReadLive: tiers ? Object.values(tiers).reduce((s, t) => s + (isPlain(t) ? countOf(t.notRead) ?? 0 : 0), 0) : null,
    probesFailed: inProbeOrder(namesOf(r.probes?.failed) || []).slice(0, 8).map((f) => f.slice(0, 40)),
    ...((namesOf(r.probes?.partial) || []).length ? { probesPartial: inProbeOrder(namesOf(r.probes.partial)).slice(0, 8).map((f) => f.slice(0, 40)) } : {}),
    scoped: isPlain(r.packB?.liveScope) && Object.keys(r.packB.liveScope).length > 0,
    setAsideCount: aside,
    scan: scanFactsOf(r.packA?.scan),
  };
}
export function nothingReason(facts) {
  const x = isPlain(facts) ? facts : {};
  const unread = countOf(x.notReadLive);
  if (unread) return `${unread} declared ${unread === 1 ? 'thing' : 'things'} not read live`;
  const failed = namesOf(x.probesFailed) || [];
  if (failed.length) return `Live answered in part: ${listWords(failed.map(familyWord))} not read`;
  const files = filesNotReadWords(x.scan);
  if (files) return files;
  if (x.scoped === true) return 'The live read was scoped to part of the estate';
  if (countOf(x.setAsideCount)) return 'Every difference was set aside';
  return NOTHING_REASON;
}
export function partialParts(facts, vantage) {
  const x = isPlain(facts) ? facts : {};
  const failed = namesOf(x.probesFailed) || [];
  // A family read in part (one of its stores went unread beside rules another gave) is named too.
  const inPart = (namesOf(x.probesPartial) || []).filter((f) => !failed.includes(f));
  const said = [failed.length ? `${listWords(failed.map(familyWord))} not read` : '', inPart.length ? `${listWords(inPart.map(familyWord))} read only in part` : ''].filter(Boolean).join('; ');
  return [
    vantage === 'partial' ? (said ? `Live answered in part: ${said}` : 'Live answered in part') : '',
    filesNotReadWords(x.scan),
  ].filter(Boolean);
}
// The line a stopped Run adds beside the last check (the journeys listing's stoppedRun, or the
// record itself): "Last Run stopped: partial scan — 49 of 220 files not read; the previous pack is kept."
// A Run that kept no complete scan (the listing's `kept: false`, a record with no packA.source) says so.
export function stoppedNote(stopped) {
  if (!isPlain(stopped)) return '';
  const record = isPlain(stopped.packA);
  const s = record && isPlain(stopped.packA.scan) ? scanFactsOf(stopped.packA.scan) : { notRead: countOf(stopped.notRead), candidates: countOf(stopped.candidates) };
  const files = s && s.notRead !== null && s.candidates !== null ? ` — ${s.notRead} of ${s.candidates} files not read` : '';
  const kept = record ? stoppedRunKept(stopped) : stopped.kept !== false;
  return `Last Run stopped: partial scan${files}; ${kept ? 'the previous pack is kept' : 'no complete scan of this repository is kept'}.`;
}

// ---------- the grade ----------

// "Industrial Grade" → "Industrial grade"; "Diagnostic / Clinical Grade" →
// "Diagnostic grade": the first word of the engine's label, then "grade".
export function shortGradeLabel(ig) {
  const label = String(ig?.label || '').trim();
  if (!label) return '';
  const head = label.split(' / ')[0].replace(/\s+Grade$/i, '').trim();
  return `${head} grade`;
}

// The verdict word the engine attaches to a score (diagnostic-grade.mjs, the
// same bands), for a run record that carries the score but not the word.
export function verdictWordFor(scorePct) {
  if (scorePct === null || scorePct === undefined || scorePct === '') return '';
  const p = Number(scorePct);
  if (!Number.isFinite(p)) return '';
  if (p > 85) return 'Diagnostic-grade';
  if (p >= 62.5) return 'Almost diagnostic-grade';
  if (p >= 37.5) return 'Not yet diagnostic-grade';
  return 'Far from diagnostic-grade';
}

// A run graded THIS pack when its Pack A is the pack on screen: the record's
// packA.source is the pack file (named by id), else name and version agree.
// Whether the run's grade is the board's letter for `pack`: it finished (pass
// or gate-failed) with a letter, graded this pack, and its live side did not
// shrink since the check before (vantageShrank). gradeModel letters by it;
// boardComparison hands Expert the run's live read only by it.
// `off`: the criteria the service is not graded on (its record's gradeOff).
// A run that graded on other criteria (its grade.off) scored something else:
// it is not the board's letter until the next check. `aside`: the name of the
// set-asides that hold for the service now (studio/set-asides.mjs
// setAsideFingerprint, '' for none) — a run that left out other differences
// (its grade.setAside.fingerprint) is not the letter either.
const offKey = (off) => gradeOffKeys(off).join(',');
const asideKey = (run) => (typeof run?.grade?.setAside?.fingerprint === 'string' ? run.grade.setAside.fingerprint : '');
// `targets`: the key of the MTTD / MTTR targets set in the studio the grade counts now
// (mttx-targets.mjs targetsTermKey, '' for none: none set, or Calibrated does not read them) — a
// run graded with other targets (its grade.targets, recorded only when its Calibrated counted
// them) is not the letter either.
// With them, the key of the SLO objectives stated in the studio the grade counts (slo-objectives.mjs
// objectivesTermKey; the run's is its grade.objectives.key), joined as '<targets>#<objectives>'.
const runObjectivesKey = (run) => (typeof run?.grade?.objectives?.key === 'string' ? run.grade.objectives.key : '');
const termsOf = (targets, objectives) => (objectives ? `${targets || ''}#${objectives}` : (targets || ''));
const termParts = (terms) => { const t = String(terms || ''); const at = t.indexOf('#'); return at < 0 ? [t, ''] : [t.slice(0, at), t.slice(at + 1)]; };
const runTargetsKey = (run) => termsOf(targetsTermKey(run?.grade?.targets ?? null), runObjectivesKey(run));
const runFinishedWithLetter = (run) => !!run && (run.outcome === 'pass' || run.outcome === 'gate-failed') && !!run.grade?.letter;
// A run graded under another grade schema (its grade.schema) scored by other rules: its letter is
// not this engine's either. A record that names no schema is not judged by it.
const otherSchema = (schema) => schema != null && Number(schema) !== GRADE_SCHEMA;
const sameTerms = (run, off, aside, targets = '') => !otherSchema(run?.grade?.schema) && offKey(run?.grade?.off) === offKey(off) && asideKey(run) === (aside || '') && runTargetsKey(run) === (targets || '');
// A run whose live side returned no data (an older record whose every probe failed still carried a
// letter) is never the board's letter either.
export function runGradesBoard(run, pack, off = [], aside = '', targets = '') {
  return runFinishedWithLetter(run) && vantageOf(run) !== 'lost' && !vantageShrank(run).length && runGradedPack(run, pack) && sameTerms(run, off, aside, targets);
}
// The key of a service's MTTD / MTTR targets now ('' for none).
export const serviceTargetsKey = (service) => targetsTermKey(service?.targets ?? null);
// Whether the grade counts the service's targets set in the studio: its Calibrated read them (the
// repository states no baselines of its own, and Calibrated is graded). null: no grade to ask.
export function studioTargetsCounted(diagnostic) {
  if (!diagnostic) return null;
  const c = criterionOf(diagnostic, 'calibrated');
  return !!c?.baselines?.studio && c.applies !== false;
}
// The key of the service's stated SLO objectives the grade counts now: the ones its Calibrated counted
// (criterion.objectives.studioIds); with no grade to ask, all of them. '' for none.
export function serviceObjectivesKey(service, diagnostic = null) {
  if (!diagnostic) return objectivesTermKey(service?.objectives ?? null);
  const c = criterionOf(diagnostic, 'calibrated');
  if (!c || c.applies === false) return '';
  return objectivesTermKey(service?.objectives ?? null, Array.isArray(c.objectives?.studioIds) ? c.objectives.studioIds : []);
}
// The name of a service's set-asides that hold at `now` ('' for none).
export const serviceAsideKey = (service, now = Date.now()) => setAsideFingerprint(service?.setAside, new Date(now).toISOString());

export function runGradedPack(run, pack) {
  if (!run || !pack) return false;
  const src = run.packA?.source;
  if (src && pack.id && baseName(src) === `${pack.id}.pack.yaml`) return true;
  const name = run.packA?.name, version = run.packA?.version;
  return !!name && name === (pack.name ?? pack.label) && (!version || !pack.version || String(version) === String(pack.version));
}

// ---------- why this grade ----------
//
// The seven criteria the engine scores (studio/diagnostic-grade.mjs, grade
// schema 5: one point each, Multi-modal, Comprehensive, Chaos-validated and
// Drift-free fractional), each as one plain
// sentence with a yes / partly / no mark, the yeses first. Five read the
// repository alone and come from the pack-alone diagnostic's criteria; the
// two that need the other side (Drift-free, Fresh) come from the run that
// graded the letter on screen, or say that nothing live was checked. The
// list is offered only when it adds up to the letter shown (within two
// points of a hundred): a run of another schema, or a pack whose own
// annotations already carry live evidence, explains nothing and shows nothing.
// The lines' criteria, in the order the two builders below return them.
const REPOSITORY_LINE_KEYS = ['multi-modal', 'correlated', 'calibrated', 'comprehensive', 'chaos-validated'];
const LIVE_LINE_KEYS = ['drift-free', 'fresh'];
const CRITERION_LABEL = Object.fromEntries(GRADE_CRITERIA.map((c) => [c.key, c.label]));
const keyed = (keys) => (line, i) => ({ ...line, key: keys[i], label: CRITERION_LABEL[keys[i]] || keys[i] });
const GRADE_BAR = 85;
const WHY_RANK = { yes: 0, partly: 1, no: 2 };
const criterionOf = (diagnostic, key) => [...(diagnostic?.coverage?.criteria || []), ...(diagnostic?.trust?.criteria || [])].find((c) => c && c.key === key) || null;
const numbersIn = (s) => (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
const tenth = (n) => String(Math.round(n * 10) / 10);

// The five criteria that read the repository alone, from the engine's
// criteria (key, pass, detail) — the numbers are read back out of the detail,
// the counts the engine states (baselines, experiments) from their fields.
// `liveUnobserved` lists the families the run's Pack B could not look at
// (the record's packB.unobserved), [] without a run.
function repositoryGradeLines(diagnostic, liveUnobserved = []) {
  const keys = ['multi-modal', 'correlated', 'calibrated', 'comprehensive', 'chaos-validated'];
  const c = Object.fromEntries(keys.map((k) => [k, criterionOf(diagnostic, k)]));
  if (keys.some((k) => !c[k])) return null;
  const [got = 0, of = 4] = numbersIn(c['multi-modal'].detail);
  const kinds = (String(c['multi-modal'].detail).match(/\(([^)]*)\)/) || [])[1] || '';
  const [objectives = 0] = numbersIn(c.calibrated.detail);
  const [coverage = 0] = numbersIn(c.comprehensive.detail);
  // A criterion the engine scores by how far it gets (its `score`: Multi-modal's kinds of four,
  // Comprehensive's average observed) counts that, so the lines still add up to the letter:
  // the mark follows the bar, the points follow the score — short of the bar but above
  // nothing is a "partly".
  const line = (crit, yes, no) => (typeof crit.score === 'number'
    ? { ok: crit.pass ? 'yes' : (crit.score > 0 ? 'partly' : 'no'), score: Math.max(0, Math.min(1, crit.score)), text: crit.pass ? yes : no }
    : { ok: crit.pass ? 'yes' : 'no', text: crit.pass ? yes : no });
  return [
    line(c['multi-modal'],
      `${got} of ${of} kinds of signal are collected${kinds ? `: ${kinds}` : ''}.`,
      got ? `Only ${got} of ${of} kinds of signal ${got === 1 ? 'is' : 'are'} collected${kinds ? `: ${kinds}` : ''}.` : 'No kind of signal is collected yet.'),
    line(c.correlated,
      'Traces and logs can be joined, so one request can be followed end to end.',
      'Traces and logs cannot be joined, so a request cannot be followed end to end.'),
    line(c.calibrated,
      c.calibrated.baselines?.studio
        // Counted from the studio: said as the studio's, never as the repository's.
        ? `Normal is defined with numbers: ${objectives} objective${objectives === 1 ? '' : 's'}${statedWords(c.calibrated)}, with detection and repair targets set in the studio (${studioTargetsName(c.calibrated.baselines.studio)}).`
        : `Normal is defined with numbers: ${objectives} objective${objectives === 1 ? '' : 's'}${statedWords(c.calibrated)}, with detection and repair baselines.`,
      calibratedNo(c.calibrated)),
    line(c.comprehensive,
      `Coverage reaches ${coverage} in 100 across infrastructure, platform, application and user experience; the bar is 50.`,
      `Coverage reaches only ${coverage} in 100 across infrastructure, platform, application and user experience; the bar is 50.`),
    chaosLine(c['chaos-validated'], liveUnobserved),
  ];
}

// The objectives counted from the studio, said as the studio's, never as the repository's.
function statedWords(crit) {
  const n = Number(crit?.objectives?.studio) || 0;
  if (!n) return '';
  const left = Number(crit.objectives.guessed) || 0;
  return ` (${n === Number(crit.objectives.declared) ? 'stated in the studio' : `${n} stated in the studio`}${left ? `; ${left} more ${left === 1 ? 'carries' : 'carry'} the scan's default` : ''})`;
}

// The targets set in the studio, named: a profile's name ("lab default"), or their minutes.
function studioTargetsName(t) {
  const v = targetsView(t);
  if (!v) return 'set by hand';
  return v.profile === MTTX_CUSTOM ? v.words : v.name.toLowerCase();
}

// Calibrated's "no": the baselines are missing, or only placeholders the
// scan wrote (the engine's `baselines.scaffolds`), or no objective has a target.
function calibratedNo(crit) {
  if (!/no .*baselines/i.test(crit.detail)) {
    // The baselines half is there; the objectives are missing, or only the scan's invented ones (`objectives.scaffolds`).
    const guessed = Number(crit.objectives?.guessed) || 0;
    if (guessed > 0 && !crit.objectives.declared) {
      return `Normal is not defined with numbers: the ${guessed === 1 ? 'one objective is' : `${guessed} objectives are`} the scan's default (99% over 30 days), which nobody stated.`;
    }
    return crit.objectives?.scaffolds > 0 && !crit.objectives.declared
      ? 'Normal is not defined with numbers: the objectives are defaults the scan wrote, not targets anyone set.'
      : 'Normal is not defined with numbers: no objective has a target.';
  }
  return crit.baselines?.scaffolds > 0
    ? 'Normal is not defined with numbers: the detection and repair baselines are defaults the scan wrote, not measurements.'
    : 'Normal is not defined with numbers: no detection and repair baselines.';
}

// Chaos-validated, as the engine knows it (grade schema 4, `proof`): proven
// by a recent passing run, failed, declared with only an old pass, declared
// and never recorded as run — or none, and then what each side could not
// see, never that recovery is unproven.
const PROOF_SOURCE = { measured: 'measured live', recorded: 'recorded in the repository', studio: 'recorded in the studio' };
function chaosLine(crit, liveUnobserved) {
  const n = Number.isFinite(crit.declared) ? crit.declared : (numbersIn(crit.detail)[0] || 0);
  const exps = `${n} chaos experiment${n === 1 ? '' : 's'}`;
  const day = (iso) => String(iso || '').slice(0, 10);
  const p = crit.proof;
  // The line counts what the engine counted (its `score`: a quarter for a
  // declaration), so the seven lines still add up to the letter.
  const scored = (line) => (typeof crit.score === 'number' ? { ...line, score: crit.score } : line);
  if (p?.state === 'proven') {
    return scored({ ok: crit.pass ? 'yes' : 'partly', text: `Recovery proven ${day(p.provenAt)} by fault injection: ${p.fresh} of ${exps} passed a recent run (${PROOF_SOURCE[p.source] || p.source}).` });
  }
  if (p?.state === 'failed') {
    const f = p.failed[0];
    const why = f.missing?.length ? `: ${f.missing.join(', ')} did not fire${f.expectedMttd ? ` within ${f.expectedMttd}` : ''}` : '';
    return scored({ ok: 'no', text: `Chaos experiment ${f.id} failed on ${day(f.at)}${why}.` });
  }
  if (p?.state === 'stale') return scored({ ok: 'partly', text: `${exps} declared; the last recorded pass, ${day(p.stale.at)}, is older than ${p.stale.windowDays} days.` });
  if (p?.state === 'declared') return scored({ ok: 'partly', text: `${exps} declared, never recorded as run.` });
  if (!p && crit.pass) return { ok: 'yes', text: `${n} chaos experiment${n === 1 ? ' is' : 's are'} declared; none has a recorded result.` };
  const blind = [
    crit.unobserved?.repository && 'the repository scan cannot detect chaos tooling',
    (crit.unobserved?.live || liveUnobserved.includes('chaos')) && 'the live side cannot observe it',
  ].filter(Boolean);
  return { ok: 'no', text: blind.length ? `No chaos experiment is declared — ${blind.join(' and ')}.` : 'No chaos experiment is declared in this pack.' };
}

// The two criteria that need the other side, from the run that graded the
// letter on screen: Drift-free is the integrity of the declared commitment
// chains (the run's traceability), Fresh the age of the live picture when
// the run read it. Null when the run scored drift on another construct.
// The age is the run's `freshness.liveAgeHours`, null when Pack B carries no
// `mcp.refreshedAt` (a pack file, a recording): the engine scores that Fresh
// = no, so an age that is not a number is never fresh — Number(null) is 0,
// "zero hours old", and would count a point the engine never gave.
function liveGradeLines(run, { against, where, now }) {
  if (run?.grade?.driftConstruct !== 'requirement-chain' || !(Number(run.traceability?.declaredTotal) > 0)) return null;
  // Nothing compared (drift.compared 0, or an older record's four counts): the engine scores Drift-free
  // nothing and backs it with no figure — the chains' declared links would read broken for want of
  // anything compared (studio/diagnostic-grade.mjs) — so the line says nothing was compared, and why,
  // never "0 in 100 hold up".
  const nothing = comparedOf(run.drift) === 0;
  const pct = Number(run.traceability.integrityPct);
  if (!nothing && !Number.isFinite(pct)) return null;
  const ageHours = run.freshness?.liveAgeHours;
  const dated = typeof ageHours === 'number' && Number.isFinite(ageHours);
  const fresh = dated && ageHours * 3600e3 <= FRESH_WINDOW_MS;
  const picture = where === 'live' ? 'live picture' : 'recording';
  // The engine scores this criterion by the integrity itself (0.85 of a
  // point at 85 in 100) and calls it met at the bar: the mark follows the
  // bar, the points follow the integrity, above the bar too.
  // The integrity is the mean share of each promise's LINKS that hold; the
  // board's chains strip counts the promises whose every link holds — the
  // sentence says which it counts, so 93 in 100 beside "7 of 18" reads as
  // two measures, not a contradiction.
  const promises = Number(run.traceability.declaredTotal);
  return [
    nothing
      ? { ok: 'no', score: 0, text: `Nothing was compared on the last check, so no promise is confirmed ${where}. ${nothingReason(basisFactsOf(run))}.` }
      : { ok: pct >= GRADE_BAR ? 'yes' : (pct > 0 ? 'partly' : 'no'), score: Math.max(0, Math.min(1, pct / 100)),
        text: `Of the links in the repository's ${promises} promise${promises === 1 ? '' : 's'}, ${Math.round(pct)} in 100 hold up ${where}; the bar is ${GRADE_BAR}.` },
    { ok: fresh ? 'yes' : 'no',
      text: fresh ? `Checked ${against} ${agoText(run.startedAt, now)}.`
        : dated ? `The ${picture} was more than a day old when it was checked.`
          : `The ${picture} does not say when it was taken, so it does not count as recent.` },
  ];
}

// A line's points: its fractional score when it carries one (the engine's
// criterionScore), else one for a yes and nothing otherwise.
const gradePoints = (lines) => lines.reduce((n, l) => n + (typeof l.score === 'number' ? l.score : (l.ok === 'yes' ? 1 : 0)), 0);

// "4.8 of 7 points. B+ starts at 5.3." — the next band up in points, so the
// distance to the next letter is one subtraction.
// `of`: the criteria graded — seven, or fewer when the service switched some off.
function pointsText(points, letter, of) {
  const bands = INSTRUMENT_GRADE_SCALE.filter((g) => g.minPct !== null).reverse();
  const i = bands.findIndex((g) => g.letter === letter);
  const next = i >= 0 ? bands[i + 1] : null;
  const head = `${tenth(points)} of ${of} points.`;
  if (!next) return head;
  return `${head} ${next.letter} starts ${next.exclusiveMin ? 'above' : 'at'} ${tenth(next.minPct / 100 * of)}.`;
}

// The criteria a service is not graded on, as the board lists them under the
// reasons: the criterion, why (the reason on the record), who switched it off
// and when. `off` is the service record's gradeOff ([{ key, reason, by, at }]);
// bare keys are listed without a reason.
export function notGradedLines(off) {
  const entries = new Map((Array.isArray(off) ? off : []).filter((x) => x && typeof x === 'object').map((x) => [x.key, x]));
  return gradeOffKeys(off).map((key) => {
    const e = entries.get(key) || {};
    const label = CRITERION_LABEL[key] || key;
    const reason = typeof e.reason === 'string' ? e.reason.trim() : '';
    const by = [typeof e.by === 'string' ? e.by : '', dayMonth(e.at)].filter(Boolean).join(', ');
    return { key, label, text: `${label} is not graded for this service${reason ? `: ${reason}` : '.'}`, by };
  });
}

// gradeWhy({ diagnostic, run, letter, score, against, where, now, off }) → { why, points, notGraded? }
//   why     [{ ok: 'yes' | 'partly' | 'no', text, key, label }] — one line per criterion graded, or none
//   points  "4.8 of 7 points. B+ starts at 5.3." — or ''; "of 6" when one is off
//   off     the criteria the service is not graded on (its record's gradeOff): they leave the
//           lines and the points, and are listed as `notGraded` ([{ key, label, text, by }],
//           absent when none is off) — also when the lines themselves are not offered
// `checked`: there was a live check, but it does not count for this letter (it lost its vantage, saw
// less than the one before, or was graded on other terms): the two live lines say so, never "never checked".
export function gradeWhy({ diagnostic = null, run = null, letter = '', score = null, against = 'against live', where = 'live', now = Date.now(), off = [], checked = false } = {}) {
  const offKeys = gradeOffKeys(off);
  const left = offKeys.length ? { notGraded: notGradedLines(off) } : {};
  const none = { why: [], points: '', ...left };
  if (otherSchema(run?.grade?.schema) || otherSchema(diagnostic?.gradeSchema)) return none;
  const fixed = repositoryGradeLines(diagnostic, Array.isArray(run?.packB?.unobserved) ? run.packB.unobserved : []);
  if (!fixed) return none;
  const live = run ? liveGradeLines(run, { against, where, now }) : checked ? [
    { ok: 'no', text: 'The last check does not count for this letter, so no promise is confirmed live.' },
    { ok: 'no', text: 'Checked before, but that check does not count for this letter.' },
  ] : [
    { ok: 'no', text: 'Nothing live has been checked, so no promise is confirmed live.' },
    { ok: 'no', text: 'Never checked against live.' },
  ];
  if (!live) return none;
  const lines = [...fixed.map(keyed(REPOSITORY_LINE_KEYS)), ...live.map(keyed(LIVE_LINE_KEYS))].filter((l) => !offKeys.includes(l.key));
  const points = gradePoints(lines);
  const pct = Number(score);
  if (Number.isFinite(pct) && Math.abs(points / lines.length * 100 - pct) > 2) return none;
  const why = lines.slice().sort((a, b) => WHY_RANK[a.ok] - WHY_RANK[b.ok]).map(({ ok, text, key, label }) => ({ ok, text, key, label }));
  return { why, points: pointsText(points, letter, lines.length), ...left };
}

const toneForLetter = (letter) => {
  const l = String(letter || '');
  if (l.startsWith('A')) return l === 'A++' ? GRADE_TONE.ref : GRADE_TONE.a;
  if (l.startsWith('B')) return GRADE_TONE.b;
  if (l === 'C') return GRADE_TONE.c;
  if (l === 'D') return GRADE_TONE.d;
  return 'neutral';
};

// gradeModel({ pack, how, diagnostic, diagnosticError, run, journey, now, off })
//   diagnostic   computeDiagnosticGrade(packA alone)  — the repository's own grade
//   run          the journey's newest run record      — the same engine against live
//   off          the criteria the service is not graded on (its record's gradeOff; the
//                host computes `diagnostic` with the same). The letter is then over the
//                others: `criteria` says "Graded on 6 of 7 criteria" (absent when none is
//                off), `notGraded` lists them. A run that graded on other criteria is not
//                the letter: the repository alone is, and the source line says to check again.
//   aside        the name of the service's set-asides that hold now (serviceAsideKey): a run
//                that left out other differences is not the letter either.
// The run's letter wins when the run graded this pack and could see the live
// side (outcome pass or gate-failed); otherwise the pack-alone grade, and the
// source line says which. A live recording as Pack B is graded "against a
// recording", never "against live".
export function gradeModel({ pack = null, how = 'none', diagnostic = null, diagnosticError = null, run = null, journey = null, now = Date.now(), off = [], aside = '', targets = '' } = {}) {
  const offCount = gradeOffKeys(off).length;
  const criteria = offCount ? { criteria: `Graded on ${GRADE_CRITERIA.length - offCount} of ${GRADE_CRITERIA.length} criteria` } : {};
  if (!pack || how === 'none') {
    return { letter: '–', label: 'No pack yet', word: 'Nothing to grade: no pack is registered for this service.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '' };
  }
  if (how !== 'primary') {
    return { letter: '–', label: 'No pack of its own', word: 'This service appears in a live draft, but no pack of its own is registered yet.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '' };
  }
  // A run that saw less of the live side than the check before graded a
  // smaller picture: not usable as the letter, and the source line says so.
  const shrank = vantageShrank(run);
  if (runGradesBoard(run, pack, off, aside, targets)) {
    const ig = instrumentGradeFor(Number(run.grade.score)) || { letter: run.grade.letter, label: run.grade.letterLabel || '', blurb: '' };
    const letter = run.grade.letter;
    const label = shortGradeLabel({ label: run.grade.letterLabel || ig.label });
    const recording = journey ? !journeyIsLive(journey) : !/^mcp:/i.test(String(run.packB?.source || ''));
    const against = recording ? 'against a live recording' : 'against live';
    // A run the record marks not comparable with the one before (its scan read other files) says so.
    const notComparable = run.comparable?.withPrevious === false ? ` Not comparable with the check before${typeof run.comparable.reason === 'string' && run.comparable.reason.trim() ? `: ${safeErrorText(run.comparable.reason)}` : ''}.` : '';
    return {
      letter, label, word: verdictWordFor(run.grade.score),
      source: `Graded ${against}, ${agoText(run.startedAt, now)}.${notComparable}`,
      tone: toneForLetter(letter), title: `${letter} · ${run.grade.letterLabel || ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
      basis: recording ? 'recording' : 'live',
      ...criteria,
      // The objectives the scan derived from alert names root no promise: said where the letter is.
      ...(Number(run.traceability?.placeholderRoots) > 0 ? { placeholders: `${run.traceability.placeholderRoots} placeholder objective${run.traceability.placeholderRoots === 1 ? '' : 's'} the scan derived from alert names root${run.traceability.placeholderRoots === 1 ? 's' : ''} no promise: what drifted is scored on what was compared.` } : {}),
      ...gradeWhy({ diagnostic, run, letter, score: run.grade.score, against, where: recording ? 'in the recording' : 'live', now, off }),
    };
  }
  if (diagnosticError) {
    return { letter: '?', label: 'Not graded', word: `The pack could not be read: ${diagnosticError}`, source: '', tone: 'neutral', title: '', basis: 'error', why: [], points: '' };
  }
  if (!diagnostic?.overall) {
    return { letter: '·', label: 'Reading…', word: '', source: '', tone: 'neutral', title: '', basis: 'pending', why: [], points: '' };
  }
  const ig = diagnostic.overall.instrumentGrade || instrumentGradeFor(diagnostic.overall.audit?.scorePctExact ?? 0);
  // A live side that gave no data — a lost run, or an older record whose every probe failed.
  const lost = run && (run.outcome === 'vantage-lost' || vantageOf(run) === 'lost') && runGradedPack(run, pack);
  // A Run that stopped on a partial scan checked nothing (the board reads the last check that did).
  const stopped = !lost && run?.outcome === 'scan-partial';
  const partial = !lost && !stopped && run && shrank.length > 0 && runGradedPack(run, pack);
  // The last live check graded this pack, on other criteria than the service's now, or
  // leaving out other differences than its set-asides now.
  const regraded = !lost && !partial && runFinishedWithLetter(run) && runGradedPack(run, pack) && !sameTerms(run, off, aside, targets);
  const [nowTargets, nowObjectives] = termParts(targets);
  const wasTargets = targetsTermKey(run?.grade?.targets ?? null);
  const whatChanged = otherSchema(run?.grade?.schema) ? 'how the grade scores changed'
    : offKey(run?.grade?.off) !== offKey(off) ? 'the criteria graded here changed'
    : asideKey(run) !== (aside || '') ? 'what is set aside changed'
      : wasTargets !== nowTargets ? (!wasTargets ? 'the grade has counted the MTTD / MTTR targets set in the studio'
        : !nowTargets ? 'the grade has stopped counting the MTTD / MTTR targets set in the studio'
          : 'the MTTD / MTTR targets changed')
        : !runObjectivesKey(run) ? 'the grade has counted the objectives stated in the studio'
          : !nowObjectives ? 'the grade has stopped counting the objectives stated in the studio'
            : 'the objectives stated in the studio changed';
  // A check that reads a recording is not checked again from here: the line does not say to.
  const liveCheck = journey ? journeyIsLive(journey) : /^mcp:/i.test(String(run?.packB?.source || ''));
  return {
    letter: ig.letter, label: shortGradeLabel(ig), word: diagnostic.overall.verdict?.word || verdictWordFor(diagnostic.overall.audit?.scorePctExact),
    source: lost ? 'Graded from the repository alone; the last live check could not see production.'
      : stopped ? 'Graded from the repository alone; the last Run read the repository in part and stopped before checking.'
      : partial ? 'Graded from the repository alone; the last live check saw only part of production.'
        : regraded ? (liveCheck ? `Graded from the repository alone: ${whatChanged} since the last live check. Check again to grade against live.`
          : `Graded from the repository alone: ${whatChanged} since the last check.`)
          : 'Graded from the repository alone.',
    tone: GRADE_TONE[ig.tier] || 'neutral', title: `${ig.letter} · ${ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
    basis: 'repository',
    ...criteria,
    ...gradeWhy({ diagnostic, letter: ig.letter, score: diagnostic.overall.audit?.scorePctExact, now, off, checked: !!(lost || stopped || partial || regraded) }),
  };
}

// ---------- is that still true right now? ----------

const dayMonth = (iso) => {
  const t = Date.parse(iso || '');
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][d.getUTCMonth()]}`;
};

// What differs: things the repository declares that are not running live,
// plus things that run differently. Live-only things are a Why item, not a
// difference from what the repository declares.
export function differenceCount(run) {
  const d = run?.drift || {};
  return (Number(d.declaredNotLive) || 0) + (Number(d.drifted) || 0);
}

// The same, split at the chain (a record with drift.tiers; else null): what
// differs in the exporters, alerts and dashboards, what differs beyond them,
// and the links live could not read.
//   → { chain, beyond, beyondLiveOnly, links: [{ key, name, many, one, missing, drifted, aligned, notRead, liveOnly }],
//       unread: ['dashboards'] } | null
export function chainDifferences(run) {
  const tiers = run?.drift?.tiers;
  if (!tiers || typeof tiers !== 'object' || !CHAIN_LINKS.every((l) => tiers[l.key] && typeof tiers[l.key] === 'object')) return null;
  const n = (v) => Number(v) || 0;
  const links = CHAIN_LINKS.map((l) => {
    const c = tiers[l.key];
    return { key: l.key, name: l.name, many: l.many, one: l.one, missing: n(c.declaredNotLive), drifted: n(c.drifted), aligned: n(c.aligned), notRead: n(c.notRead), liveOnly: n(c.liveNotDeclared) };
  });
  const beyondOf = (t) => n(t?.declaredNotLive) + n(t?.drifted);
  return {
    chain: links.reduce((k, l) => k + l.missing + l.drifted, 0),
    beyond: beyondOf(tiers.detail) + beyondOf(tiers.machinery),
    beyondLiveOnly: n(tiers.detail?.liveNotDeclared) + n(tiers.machinery?.liveNotDeclared),
    links,
    unread: CHAIN_LINKS.filter((l) => n(tiers[l.key].notRead)).map((l) => l.many),
  };
}

// The chain in words, from chainDifferences — what every sentence about a check says, so none of
// them falls back to "things":
//   differ    "2 alerts and 1 dashboard" (declared, not live or not as declared), or ''
//   matched   "exporters and alerts": the links declared, compared and alike
//   unread    "the 7 dashboards": the links live could not read (never "match")
//   liveOnly  "1 alert": what runs live in the chain that the repository does not declare, or ''
const countWords = (k, l) => `${k} ${k === 1 ? l.one : l.many}`;
export function chainWords(split) {
  if (!split) return null;
  const differ = listWords(split.links.filter((l) => l.missing + l.drifted).map((l) => countWords(l.missing + l.drifted, l)));
  const matched = listWords(split.links.filter((l) => !l.missing && !l.drifted && !l.notRead && l.aligned).map((l) => l.many));
  const unread = listWords(split.links.filter((l) => l.notRead).map((l) => `the ${countWords(l.notRead, l)}`));
  const liveOnly = listWords(split.links.filter((l) => l.liveOnly).map((l) => countWords(l.liveOnly, l)));
  return { differ, matched, unread, liveOnly };
}
const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

// stillTrueModel({ journey, run, now, running, startError, journeysError, stopped })
//   journey   the GET /api/journeys entry for this service (or null)
//   run       its newest run record that checked something (GET /api/journeys/:name/runs), or null
//   stopped   a Run newer than `run` that stopped on a partial scan (outcome scan-partial), or null
// Returns { status (one of OVERVIEW_STATUS keys or null), pill, sentence, note,
//   cadence, stale, canCheck, checkLabel, checkPrimary, tone, error } and, only when there is one,
//   `reason` (why the live side gave nothing: its first probe error) and `stopped` (the stopped
//   Run's line). Nothing compared is never "it matches"; a run the record marks not comparable
//   with the one before says so in place of what moved since.
export function stillTrueModel(input = {}) {
  const s = stillTrueCore(input);
  const run = input.run || null;
  const stopped = input.stopped?.outcome === 'scan-partial' && run?.outcome !== 'scan-partial'
    && (!run || String(input.stopped.startedAt || '') > String(run.startedAt || '')) ? stoppedNote(input.stopped) : '';
  return stopped && s.status !== null ? { ...s, stopped } : s;
}

const declaredSideCompared = (run) => {
  const d = run?.drift || {};
  return (Number(d.aligned) || 0) + (Number(d.drifted) || 0) + (Number(d.declaredNotLive) || 0) > 0;
};
// Only live-only things were compared (every declared one of their families set aside, or none left in
// the comparison): something was compared (C2 — a figure, 0, over it), nothing the repository declares
// was. The board reads it Changed with that sentence, never "it matches" and never Nothing compared — the
// row (lastCheckOf), the ring (fidelityModel) and the Run's toast show the figure, and one record reads
// one way everywhere.
const liveOnlyAlone = (run) => {
  const compared = comparedOf(run?.drift);
  return compared !== null && compared > 0 && differenceCount(run) === 0 && (Number(run?.drift?.liveNotDeclared) || 0) > 0 && !declaredSideCompared(run);
};
const asideCountOf = (run) => (Number(run?.drift?.setAside?.declaredNotLive) || 0) + (Number(run?.drift?.setAside?.liveNotDeclared) || 0);

function stillTrueCore({ journey = null, run = null, now = Date.now(), running = false, startError = null, journeysError = null, pending = false } = {}) {
  const live = journeyIsLive(journey);
  // The cadence line belongs to a check this screen can run; a recording has nothing to click.
  const cadence = journey && live ? (journey.schedule ? 'Checks run on a schedule.' : 'Checks run only when you click.') : '';
  const base = { status: null, pill: '', sentence: '', note: '', cadence, stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'neutral', error: startError || null, pending: false, running: false, ago: '' };
  // The facts are still being read: say so, never "never checked" for a moment.
  if (pending) return { ...base, cadence: '', sentence: 'Reading…', pending: true };
  if (running) {
    return { ...base, status: run ? statusOf(run) : 'never', pill: OVERVIEW_STATUS[run ? statusOf(run) : 'never'], sentence: 'Checking against live now…', tone: 'info', canCheck: true, checkLabel: 'Checking…', running: true };
  }
  if (journeysError) {
    return { ...base, sentence: `Whether it was ever checked could not be read: ${journeysError}`, tone: 'warn', error: null, retry: true };
  }
  if (!journey) {
    return { ...base, status: 'never', pill: OVERVIEW_STATUS.never, sentence: 'Never checked against live.', tone: 'info' };
  }
  if (!run) {
    // The one Check now is the next step's primary; this panel only says so.
    const env = journey.scope?.env ? ` for ${journey.scope.env}` : '';
    return { ...base, status: 'never', pill: OVERVIEW_STATUS.never, sentence: `Never checked against live. A live check is set up${env}.`, tone: 'info', canCheck: false, checkLabel: '', checkPrimary: false };
  }
  const ago = agoText(run.startedAt, now);
  base.ago = ago;
  const startedMs = Date.parse(run.startedAt || '');
  const stale = Number.isFinite(startedMs) && now - startedMs > FRESH_WINDOW_MS;
  // A live side that gave nothing — a lost run, or an older record whose every probe failed: the
  // reason beneath names the first probe error; a live side that answered with no data says so.
  if (run.outcome === 'vantage-lost' || vantageOf(run) === 'lost') {
    const loss = liveLossOf(run);
    return { ...base, status: 'unreachable', pill: OVERVIEW_STATUS.unreachable, tone: 'warn', stale,
      sentence: loss.cause === 'no-data'
        ? `Last check ${ago}: the live side answered but returned nothing this check reads, so nothing is known about it right now.`
        : `Last check ${ago}: the live side did not answer, so nothing is known about it right now.`,
      canCheck: false, checkLabel: '', ...(loss.error ? { reason: `Live did not answer — ${loss.error}` } : {}) };
  }
  // A Run that stopped on a partial scan compared nothing: the previous pack is kept.
  if (run.outcome === 'scan-partial') {
    const s = scanFactsOf(run.packA?.scan);
    const files = s && s.notRead !== null && s.candidates !== null ? ` (${s.notRead} of ${s.candidates} files not read)` : '';
    return { ...base, status: 'nothing', pill: OVERVIEW_STATUS.nothing, tone: 'warn', stale,
      sentence: `Last Run ${ago}: the repository was read in part${files}, so nothing was compared; the previous pack is kept.`,
      canCheck: false, checkLabel: '', tried: true };
  }
  const recording = !live;
  const when = run.packB?.refreshedAt ? dayMonth(run.packB.refreshedAt) : '';
  const against = recording ? `against a live recording${when ? ` from ${when}` : ''}` : 'against live';
  const k = differenceCount(run);
  const extra = Number(run.drift?.liveNotDeclared) || 0;
  // The differences the service set aside (the run left them out of the counts): said, never hidden.
  const asideN = (Number(run.drift?.setAside?.declaredNotLive) || 0) + (Number(run.drift?.setAside?.liveNotDeclared) || 0);
  const asideSays = asideN ? ` ${asideN} more ${asideN === 1 ? 'is' : 'are'} set aside for this service.` : '';
  const t = run.transition || {};
  const changedCount = Array.isArray(t.changed) ? t.changed.length : Number(t.changed) || 0;
  const worseCount = Array.isArray(t.changed) ? t.changed.filter((c) => c && c.direction === 'worse').length : Number(t.worse) || 0;
  // The transition counts requirement chains that moved since the previous
  // run; the first run has none, and the sentence then says nothing of it.
  const firstRun = !run.transition || t.reason === 'first run' || !t.since;
  let since = '';
  const betterCount = Array.isArray(t.changed) ? t.changed.filter((c) => c && c.direction === 'better').length : 0;
  if (!firstRun && worseCount > 0) since = ` ${worseCount} got worse since the check before.`;
  else if (!firstRun && changedCount > 0 && betterCount === changedCount) since = ` ${changedCount} recovered since the check before.`;
  else if (!firstRun && changedCount > 0) since = ` ${changedCount} changed since the check before.`;
  // Not comparable with the check before (its scan read other files): nothing moved "since" it.
  if (run.comparable?.withPrevious === false) {
    const why = typeof run.comparable.reason === 'string' && run.comparable.reason.trim() ? `: ${safeErrorText(run.comparable.reason)}` : '';
    since = ` Not comparable with the check before${why}.`;
  }
  // The live side showed less than the check before: the counts are not
  // comparable, so the sentence says so instead of announcing a difference,
  // and Check again (the next step's primary) is the one thing to do.
  const shrank = vantageShrank(run);
  if (shrank.length) {
    return { ...base, status: 'changed', pill: OVERVIEW_STATUS.changed, tone: 'warn', stale,
      sentence: `Checked ${ago} ${against} — the live side showed less than the check before: its ${listWords(shrank.map(familyWord))} could not be read, so what differs cannot be told yet.`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
  }
  // A record that counts the chain says it in the chain's words: exporters, alerts, dashboards.
  const split = chainDifferences(run);
  const cw = chainWords(split);
  // Nothing compared: never "it matches". The first reason that holds is said.
  const compared = comparedOf(run.drift);
  const asideN2 = asideCountOf(run);
  const asideIs = asideN2 ? ` ${asideN2} ${asideN2 === 1 ? 'is' : 'are'} set aside for this service.` : '';
  if (compared === 0) {
    return { ...base, status: 'nothing', pill: OVERVIEW_STATUS.nothing, tone: 'warn', stale,
      sentence: `Checked ${ago} ${against} — nothing was compared. ${nothingReason(basisFactsOf(run))}.${asideIs}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
  }
  // Only live-only things were compared: nothing the repository declares was, so nothing of it "matches";
  // what live runs undeclared was compared, and differs (liveOnlyAlone).
  if (liveOnlyAlone(run)) {
    return { ...base, status: 'changed', pill: OVERVIEW_STATUS.changed, tone: 'warn', stale,
      sentence: `Checked ${ago} ${against} — nothing the repository declares was compared: ${extra} ${extra === 1 ? 'thing runs' : 'things run'} live that it does not declare.${asideIs}${since}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
  }
  // Counts that hold nothing over a comparison the record says held something (no writer produces one:
  // the union is the four counts): never "it matches" over it.
  if (k === 0 && compared !== null && !declaredSideCompared(run)) {
    return { ...base, status: 'nothing', pill: OVERVIEW_STATUS.nothing, tone: 'warn', stale,
      sentence: `Checked ${ago} ${against} — nothing was compared. ${nothingReason(basisFactsOf(run))}.${asideIs}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
  }
  if (k === 0 && cw) {
    const said = cw.unread
      ? `${cw.matched ? `its ${cw.matched} match live; ` : ''}not read live, so not compared: ${cw.unread}.`
      : `it matches: ${cw.matched ? `its ${cw.matched}` : 'everything the repository declares'} ${cw.matched ? 'are' : 'is'} running live as declared.`;
    const liveOnly = [cw.liveOnly, split.beyondLiveOnly ? `${split.beyondLiveOnly} ${split.beyondLiveOnly === 1 ? 'detail' : 'details'}` : ''].filter(Boolean);
    const more = liveOnly.length ? ` Also running live, not declared: ${listWords(liveOnly)}.` : '';
    return { ...base, status: 'unchanged', pill: OVERVIEW_STATUS.unchanged, tone: stale || cw.unread ? 'warn' : 'ok', stale,
      sentence: `Checked ${ago} ${against} — ${said}${more}${asideSays}${since}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: live && !stale && !extra };
  }
  if (k === 0) {
    // Live-only things are not a difference from what the repository
    // declares, but they are not hidden either: the sentence names them.
    const more = extra ? ` ${extra} more ${extra === 1 ? 'thing runs' : 'things run'} live that it does not declare.` : '';
    return { ...base, status: 'unchanged', pill: OVERVIEW_STATUS.unchanged, tone: stale ? 'warn' : 'ok', stale,
      sentence: `Checked ${ago} ${against} — it matches: everything the repository declares is running live.${more}${asideSays}${since}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: live && !stale && !extra };
  }
  // A record that counts the chain says the chain first, in its own words, and the rest beyond it.
  let what = `${things(k)} ${k === 1 ? 'differs' : 'differ'} from what the repository declares.`;
  const beyondWords = split?.beyond ? `${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'}` : '';
  const unreadSays = cw?.unread ? ` ${cap(cw.unread)} could not be read live.` : '';
  if (split && split.chain) {
    what = `${cw.differ} ${split.chain === 1 ? 'differs' : 'differ'} from what the repository declares${beyondWords ? `, and ${beyondWords} beyond the chain` : ''}.${unreadSays}`;
  } else if (split) {
    // Nothing compared (every link not read) is never "nothing differs".
    const head = cw.matched ? `its ${cw.matched} match live${cw.unread ? `, and ${cw.unread} could not be read` : ''}`
      : cw.unread ? `nothing in the chain could be compared: ${cw.unread} could not be read` : 'nothing in the chain differs';
    what = `${head}. ${beyondWords} ${split.beyond === 1 ? 'differs' : 'differ'} beyond the chain.`;
  }
  return { ...base, status: 'changed', pill: OVERVIEW_STATUS.changed, tone: 'warn', stale,
    sentence: `Checked ${ago} ${against} — ${what}${asideSays}${since}`,
    canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
}

function statusOf(run) {
  if (!run) return 'never';
  if (run.outcome === 'vantage-lost' || vantageOf(run) === 'lost') return 'unreachable';
  if (run.outcome === 'scan-partial' || comparedOf(run.drift) === 0) return 'nothing';
  if (liveOnlyAlone(run)) return 'changed';
  // Counts that hold nothing over a comparison the record says held something (no writer produces one).
  if (differenceCount(run) === 0 && comparedOf(run.drift) !== null && !declaredSideCompared(run)) return 'nothing';
  return differenceCount(run) === 0 ? 'unchanged' : 'changed';
}

// ---------- what to do next ----------

// nextActionModel({ still, grade, decision, run, journey, stopped })
//   decision  buildAssessmentDecision(...) for the pack alone (its causes name
//             what keeps the grade down when nothing live was checked)
//   stopped   a Run newer than `run` that stopped on a partial scan (its record), as stillTrueModel
//             takes it: the stop is the next step's news (still.stopped says one is there; the record
//             gives its counts and first reason)
// Returns { sentence, button: { label, action } | null, why: [string] (≤ 3),
//   primary: boolean } — across the whole screen exactly one primary button
//   exists: this one, or the still-true panel's Check button when that is the
//   only thing to do.
export function nextActionModel(input = {}) {
  const next = nextActionCore(input);
  // While a check runs, its button is the busy one in the still-true panel;
  // the next step offers no second Check.
  if (input.still?.running && next.button?.action === 'ov-check') return { ...next, button: null, primary: false };
  return next;
}

// `rulesLeft`: the specification's rules Remediate lists as not met (rulesModel's `missing`): with
// live in agreement, the next step says those are what is left, never "nothing to do".
function nextActionCore({ still = null, grade = null, decision = null, run = null, journey = null, now = Date.now(), rulesLeft = 0, stopped = null } = {}) {
  const live = journeyIsLive(journey);
  if (grade?.basis === 'none' || grade?.basis === 'error') {
    return { sentence: 'Open Expert mode to register or repair the pack.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  }
  if (!still || still.retry || still.pending) {
    return { sentence: '', button: null, why: [], primary: false };
  }
  if (still.status === 'never' && !journey) {
    const why = (decision?.causes || []).slice(0, 3).map((c) => c.title).filter(Boolean);
    return { sentence: 'Nothing live has been checked yet; the grade rests on what the repository declares.', button: { label: 'See what to fix', action: 'ov-next-diagnose' }, why, primary: true };
  }
  if (still.status === 'never' && journey) {
    return live
      ? { sentence: 'Check it against live now.', button: { label: 'Check now', action: 'ov-check' }, why: [], primary: true }
      : { sentence: 'The saved check reads a recording; open Expert mode to run it.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  }
  if (still.status === 'unreachable') {
    const noData = liveLossOf(run).cause === 'no-data';
    return live
      ? noData
        ? { sentence: 'Check again once the live side returns data; until then nothing is known.', button: { label: 'Check again', action: 'ov-check' }, why: ['The live side answered the last check, but returned nothing this check reads.'], primary: true }
        : { sentence: 'Check again once the live side answers; until then nothing is known.', button: { label: 'Check again', action: 'ov-check' }, why: ['The live side did not answer the last check.'], primary: true }
      : { sentence: 'The recording could not be read; open Expert mode to look.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  }
  // A Run stopped on a partial scan after the check on screen: the check shown is the one before it,
  // and the stop is what is new — never "nothing to do" beside it.
  if (still.stopped) return stoppedNext(stopped?.outcome === 'scan-partial' ? stopped : null, live, { after: true });
  // The live side showed less than the check before: the one thing to do is
  // to check again; the differences are not worth a trip until it answers.
  const shrank = vantageShrank(run);
  if (shrank.length && still.status === 'changed') {
    return live
      ? { sentence: 'Check again: the live side answered only in part.', button: { label: 'Check again', action: 'ov-check' }, why: [`Its ${listWords(shrank.map(familyWord))} could not be read this time.`, 'What differs was counted against a smaller live picture.'], primary: true }
      : { sentence: 'The recording answered only in part; open Expert mode to look.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  }
  if (still.stale && live) {
    const ago = run?.startedAt ? agoText(run.startedAt, now) : '';
    return { sentence: 'Check it against live now.', button: { label: 'Check now', action: 'ov-check' }, why: [`The last check is ${ago.replace(/ ago$/, '')} old; readings older than a day are not trusted.`], primary: true };
  }
  if (still.status === 'nothing') return nothingNext(run, live);
  if (still.status === 'unchanged') {
    // The still-true panel's Check again is the primary when there is one.
    const extra = Number(run?.drift?.liveNotDeclared) || 0;
    const split0 = chainDifferences(run);
    const cw = chainWords(split0);
    if (cw && (extra || cw.unread)) {
      // In the chain's words: what runs live undeclared (to review) — in the chain and beyond it, as the
      // line above says — and what could not be read (never "matches").
      const beyondLive = split0.beyondLiveOnly ? `${split0.beyondLiveOnly} ${split0.beyondLiveOnly === 1 ? 'detail' : 'details'} beyond the chain` : '';
      const liveOnly = [cw.liveOnly, beyondLive].filter(Boolean);
      const review = liveOnly.length ? `Running live, not in the repository yet: ${listWords(liveOnly)}.` : '';
      const unread = cw.unread ? `Not read live, so not compared: ${cw.unread}.${cw.matched ? ` Its ${cw.matched} match.` : ''}` : '';
      const sentence = [cw.unread ? unread : 'Nothing is missing live.', review].filter(Boolean).join(' ');
      return { sentence, button: review || extra ? { label: 'See the differences', action: 'ov-next-neuron' } : null, why: [], primary: !!(review || extra) };
    }
    if (extra) {
      return { sentence: `Nothing is missing live. ${extra} ${extra === 1 ? 'thing runs' : 'things run'} live that the repository does not declare yet.`, button: { label: 'See the differences', action: 'ov-next-neuron' }, why: [], primary: true };
    }
    if (rulesLeft > 0) return { sentence: `Live matches what the repository declares; the ${rulesLeft === 1 ? 'rule' : `${rulesLeft} rules`} the specification requires, above, ${rulesLeft === 1 ? 'is' : 'are'} what is left to add.`, button: null, why: [], primary: false };
    return { sentence: 'Nothing to do right now: live matches what the repository declares.', button: null, why: [], primary: false };
  }
  // changed
  // Live-only things alone (liveOnlyAlone): nothing the repository declares was compared, and what runs
  // live undeclared is the thing to look at — never "fix 0 things".
  if (liveOnlyAlone(run)) {
    const extra = Number(run.drift.liveNotDeclared) || 0;
    return { sentence: `Nothing the repository declares was compared; ${extra} ${extra === 1 ? 'thing runs' : 'things run'} live that it does not declare yet.`, button: { label: 'See the differences', action: 'ov-next-neuron' }, why: nothingWhy(run), primary: true };
  }
  // A record that counts the chain: the chain's differences are the thing to fix; the
  // details beyond it are one line.
  const split = chainDifferences(run);
  if (split) {
    const why = [];
    for (const l of split.links) {
      if (l.missing) why.push(`${l.missing} declared ${l.missing === 1 ? `${l.one} is` : `${l.many} are`} not running live.`);
      if (l.drifted) why.push(`${l.drifted} ${l.drifted === 1 ? `${l.one} runs` : `${l.many} run`} differently live than declared.`);
    }
    const cw = chainWords(split);
    // What was not read, in one line; the line beyond the chain is never cut by it.
    if (cw.unread) why.push(`Not read live, so not compared: ${cw.unread}.`);
    const beyondWhy = split.beyond ? `Beyond the chain, ${split.beyond} ${split.beyond === 1 ? 'detail differs' : 'details differ'}.` : '';
    // In the chain's words: never "things", never "the chain matches" over a link live did not read.
    // "The chain matches" only when a link of it matched; a chain with nothing compared says so.
    const sentence = split.chain
      ? `Fix the ${cw.differ} the live side does differently.`
      : cw.unread
        ? `${cw.matched ? `${cap(cw.matched)} match live, ${cw.unread} could not be read` : `Nothing in the chain could be compared: ${cw.unread} could not be read`}; look at the ${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'} beyond the chain.`
        : cw.matched
          ? `The chain matches live; look at the ${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'} beyond it.`
          : `Nothing in the chain was compared; look at the ${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'} beyond it.`;
    const shown = beyondWhy ? [...why.slice(0, 2), beyondWhy] : why.slice(0, 3);
    return { sentence, button: { label: 'See the differences', action: 'ov-next-neuron' }, why: shown, primary: true };
  }
  const d = run?.drift || {};
  const why = [];
  const dnl = Number(d.declaredNotLive) || 0, dr = Number(d.drifted) || 0, lnd = Number(d.liveNotDeclared) || 0;
  if (dnl) why.push(dnl === 1 ? '1 declared thing is not running live.' : `${dnl} declared things are not running live.`);
  if (dr) why.push(`${things(dr)} ${dr === 1 ? 'runs' : 'run'} differently live than declared.`);
  // "more": these are beside the count in the sentence, not part of it.
  if (lnd) why.push(`${lnd} more ${lnd === 1 ? 'thing runs' : 'things run'} live that the repository does not declare.`);
  if (Array.isArray(run?.probes?.failed) && run.probes.failed.length) why.push('Part of the live side could not be read.');
  const k = differenceCount(run);
  return { sentence: `Fix the ${things(k)} the live side does differently.`, button: { label: 'See the differences', action: 'ov-next-neuron' }, why: why.slice(0, 3), primary: true };
}

// The next step after a Run that stopped on a partial scan (`stopped`, its record; null when the host
// gave only the panel's line): check against live again, and run the service again once its
// repository answers in full. `after`: the stop came after the check on screen, which is the one
// before it; else the stop is the newest record itself, and the previous pack is kept.
function stoppedNext(stopped, live, { after = false } = {}) {
  const s = scanFactsOf(stopped?.packA?.scan);
  const first = Array.isArray(stopped?.packA?.scan?.notReadReasons) ? stopped.packA.scan.notReadReasons.find(isPlain) : null;
  const why = [
    s && s.notRead !== null && s.candidates !== null ? `${s.notRead} of ${s.candidates} files were not read.` : '',
    first ? `The first not read: ${safeErrorText(`${first.path ?? '?'} — ${first.why ?? '?'}`)}.` : '',
  ].filter(Boolean);
  const head = after
    ? 'The last Run read the repository in part and stopped, so the check shown is the one before it'
    : 'The last Run read the repository in part and stopped, so the previous pack is kept';
  return live
    ? { sentence: `${head}: check it against live again, and run the service again once its repository answers in full.`, button: { label: 'Check again', action: 'ov-check' }, why, primary: true }
    : { sentence: `${head}; run the service again once its repository answers in full.`, button: null, why, primary: false };
}

// Why nothing the repository declares was compared, in at most three plain items: the declared things
// live could not read, the families it could not read, the files the scan did not read, a scoped live
// read, the differences set aside.
function nothingWhy(run) {
  const facts = basisFactsOf(run);
  const cw = chainWords(chainDifferences(run));
  const aside = asideCountOf(run);
  return [
    facts.notReadLive ? (cw?.unread ? `Not read live, so not compared: ${cw.unread}.` : `${things(facts.notReadLive)} the repository declares could not be read live.`) : '',
    facts.probesFailed.length ? `Part of the live side could not be read: its ${listWords(facts.probesFailed.map(familyWord))}.` : '',
    filesNotReadWords(facts.scan) ? `${filesNotReadWords(facts.scan)}.` : '',
    facts.scoped ? 'The live read was scoped to part of the estate; what lies outside it was not compared.' : '',
    aside ? `${aside} ${aside === 1 ? 'difference is' : 'differences are'} set aside for this service.` : '',
  ].filter(Boolean).slice(0, 3);
}

// The next step when the last check compared nothing: a stopped Run checks the kept pack again;
// otherwise what each side holds, in Diagnose, with the reasons nothing was compared.
function nothingNext(run, live) {
  if (run?.outcome === 'scan-partial') return stoppedNext(run, live);
  return { sentence: 'Nothing was compared, so nothing is confirmed live: see what each side holds.', button: { label: 'Open in Diagnose', action: 'ov-next-diagnose' }, why: nothingWhy(run), primary: true };
}

// ---------- the board: what is in place ----------
//
// The stack as the engine sees it: four layers (the posture matrix's, drawn
// top-down, user experience first) and, per layer, which of the ten kinds of
// signal the repository declares there and how many of each. The average of
// the four layers' coverage is the engine's Comprehensive criterion ("35%
// average observed across infra · platform · app · ux"), so the picture and
// the Why line agree by construction. The composition is the pack's own
// layers (the names Discover uses), one count each.

// Top-down, as a tomogram reads: the user at the top, the metal at the bottom.
export const BOARD_LAYERS = Object.freeze([
  { key: 'ux', name: 'User experience', hint: 'front end · journeys · business outcomes' },
  { key: 'app', name: 'Application', hint: 'services · APIs · jobs' },
  { key: 'platform', name: 'Platform', hint: 'databases · caches · queues · gateways' },
  { key: 'infra', name: 'Infrastructure', hint: 'nodes · pods · disks · network' },
]);

// The ten kinds the matrix knows, in drawing order, each with its plain
// word (many, one, and none when "no <many>" would not read). A dashboard's
// panels count with the dashboards (the engine's dashboard kind is "a
// human-readable view"), so the word names both.
const SIGNAL_WORDS = {
  sli: ['indicators', 'indicator'], slo: ['objectives', 'objective'], metric: ['metrics', 'metric'], log: ['logs', 'log'], trace: ['traces', 'trace'],
  dashboard: ['dashboards and panels', 'dashboard or panel', 'no dashboards'], alert: ['alerts', 'alert'], runbook: ['runbooks', 'runbook'], chaos: ['chaos tests', 'chaos test'], synthetic: ['synthetic checks', 'synthetic check'],
};
const SIGNAL_ORDER = ['sli', 'slo', 'metric', 'log', 'trace', 'dashboard', 'alert', 'runbook', 'chaos', 'synthetic'];
export const SIGNAL_KINDS = Object.freeze(SIGNAL_ORDER
  .filter((k) => POSTURE_MECHANISMS_PER_LAYER.some((m) => m.key === k))
  .map((k) => {
    const [word, one, none] = SIGNAL_WORDS[k] || [k, k];
    return { key: k, word, one, none: none || `no ${word}` };
  }));

// A cell is the matrix's list of artefacts, or (in a test, or a saved
// posture) just its count. The matrix lists a telemetry backend twice (in
// its own cell, and on the application layer as the signal it carries,
// marked `_propagated`) and adds evidence pseudo-artefacts from a live
// side's annotations; the board counts what the repository declares, each
// artefact once — but a cell is present (lit, and observed by the engine's
// Comprehensive criterion) when it holds anything at all, evidence included.
const cellOf = (cells, key) => {
  const v = cells?.[key];
  if (!Array.isArray(v)) { const n = Number(v) || 0; return { count: n, present: n > 0 }; }
  const ids = new Set();
  let anonymous = 0;
  for (const a of v) {
    if (!a || a._evidence || a._propagated) continue;
    if (a.id) ids.add(a.id); else anonymous += 1;
  }
  return { count: ids.size + anonymous, present: v.length > 0 };
};
const layerTone = (pct) => (pct >= 70 ? 'ok' : pct >= 30 ? 'warn' : 'fail');

// The pack's own layers, as Discover names them, one count each; the small
// extended telemetry layer counts with the telemetry it extends.
export function compositionOf(layered) {
  if (!layered?.layers) return [];
  const counts = Object.fromEntries(LAYER_DEFS.map((d) => [d.id, layerItemsFor(layered, d.id).length]));
  counts.L2 += counts.L2X || 0;
  counts.L2X = 0;
  return LAYER_DEFS.filter((d) => counts[d.id] > 0).map((d) => ({ name: d.name, count: counts[d.id] }));
}

// What an artefact with no kind of its own is, in the Unplaced note's words
// (the families studio/diagnostic-grade.mjs MECHANISM_BY_ID_PREFIX marks
// null, and a backend whose signal is none of metrics, logs, traces).
const UNKINDED_WORDS = [
  ['ALR-', ['alert route', 'alert routes']],
  ['PIP-', ['pipeline part', 'pipeline parts']],
  ['COL-', ['collection agent', 'collection agents']],
  ['BAK-', ['backend for another signal', 'backends for other signals']],
];
const PLATFORM_WIDE = ['platform-wide setting', 'platform-wide settings'];
function unkindedNote(unkinded) {
  const groups = new Map();
  for (const a of unkinded) {
    const id = String(a?.id || '');
    const words = (UNKINDED_WORDS.find(([p]) => id.startsWith(p)) || [null, PLATFORM_WIDE])[1];
    groups.set(words, (groups.get(words) || 0) + 1);
  }
  return [...groups].sort((a, b) => b[1] - a[1]).map(([[one, many], n]) => `${n} ${n === 1 ? one : many}`).join(', ');
}

// layersModel({ cells, layered, unkinded }) → { rows, coveragePct, unplaced, placeless, unkinded, composition, declared, lead, coverage, unplacedNote } | null
//   rows      one per BOARD_LAYERS entry: { key, name, hint, covered, of, pct, total, tone,
//             kinds: [{ key, word, count, present, label }] (all ten, in drawing order;
//             a kind present by live evidence alone has count 0 and reads "seen live") }
//   coveragePct  the engine's Comprehensive figure: the four layers' covered
//             shares summed in the matrix's layer order, then rounded once
//   unkinded  the matrix's artefacts with no kind of their own
//             (computePostureMatrix(...).unkinded; a list, or a count)
//   unplaced  everything declared that is on no plate: `placeless` (a kind,
//             no layer it could be placed on) plus `unkinded` — so the plates
//             and Unplaced add up to Declared, each artefact counted once
export function layersModel({ cells = null, layered = null, unkinded = null } = {}) {
  if (!cells) return null;
  const rows = BOARD_LAYERS.map((L) => {
    const kinds = SIGNAL_KINDS.map((k) => {
      const { count, present } = cellOf(cells, `${L.key}:${k.key}`);
      const label = count > 0 ? `${count} ${count === 1 ? k.one : k.word}` : (present ? `${k.word} seen live` : k.none);
      return { key: k.key, word: k.word, count, present, label };
    });
    const covered = kinds.filter((k) => k.present).length;
    const pct = Math.round(covered / kinds.length * 100);
    return { key: L.key, name: L.name, hint: L.hint, covered, of: kinds.length, pct, total: kinds.reduce((n, k) => n + k.count, 0), tone: layerTone(pct), kinds };
  });
  // Summed the way computeDiagnosticGrade sums it (infra, platform, app, ux),
  // so the two round the same way.
  let shares = 0;
  for (const l of POSTURE_LAYERS) { const r = rows.find((x) => x.key === l.key); if (r) shares += r.covered / r.of; }
  const coveragePct = Math.round(shares / rows.length * 100);
  const placeless = SIGNAL_KINDS.reduce((n, k) => n + cellOf(cells, `unknown:${k.key}`).count, 0);
  const kindless = Array.isArray(unkinded) ? unkinded.length : (Number(unkinded) || 0);
  const unplaced = placeless + kindless;
  const composition = compositionOf(layered);
  const declared = composition.reduce((n, c) => n + c.count, 0);
  const what = Array.isArray(unkinded) && unkinded.length ? ` (${unkindedNote(unkinded)})` : '';
  const unplacedNote = !unplaced ? ''
    : !kindless ? `${things(placeless)} could not be placed on a layer.`
      : !placeless ? `${things(kindless)} ${kindless === 1 ? 'is' : 'are'} on no layer: no kind of signal of ${kindless === 1 ? 'its' : 'their'} own${what}.`
        : `${things(unplaced)} are on no layer: ${placeless} could not be placed on one, and ${kindless} ${kindless === 1 ? 'is' : 'are'} no kind of signal of ${kindless === 1 ? 'its' : 'their'} own${what}.`;
  return {
    rows, coveragePct, unplaced, placeless, unkinded: kindless, composition, declared,
    lead: declared ? `${things(declared)} declared in the repository.` : '',
    coverage: `Coverage reaches ${coveragePct} in 100 across the four layers.`,
    unplacedNote,
  };
}

// ---------- the board: the chain ----------
//
// What people know and care about (studio/artefact-tiers.mjs): the exporters
// that are scraped, the alerts that fire, the dashboards they open, and the
// MTTD / MTTR the team holds itself to. Discover draws these four and says
// the rest in one line — the detail (indicators, objectives, metrics, …) —
// with the machinery (panels, recording rules, pipeline parts) behind the
// layers. Nothing here is graded: the letter is the engine's, as before.

const CHAIN_EMPTY = {
  exporters: 'No scrape job found in the repository.',
  alerts: 'No alert found in the repository.',
  dashboards: 'No dashboard found in the repository.',
};
const familyList = (families) => families.map((x) => x.words).join(' · ');

// Where a service's MTTD / MTTR targets come from: the repository's, when its pack states both
// (spec.baselines mttd_target_p50 and mttr_target_p50); else the studio's (the service record's
// `targets`, mttx-targets.mjs); else none (null). A pack that states one alone is refused before it
// gets here — the pack schema requires both, and the scan leaves such baselines out with a warning
// (tools/lib/repo-pack.mjs) — so a half is read as none, never half the repository's.
function targetsSource(m, targets) {
  if (m.declared && typeof m.mttd === 'string' && typeof m.mttr === 'string') {
    return { origin: 'repository', mttd: m.mttd, mttr: m.mttr, words: `MTTD ${m.mttd} · MTTR ${m.mttr}`, view: null };
  }
  const v = targetsView(targets);
  return v ? { origin: 'studio', mttd: v.mttd, mttr: v.mttr, words: v.words, view: v } : null;
}

// The chaos run an environment's MTTD stands on, as the control room picks it
// (control-room-model.mjs mttdOf): its newest; one that names no environment stands in.
function chaosRunFor(m, env) {
  const runs = (Array.isArray(m.runs) ? m.runs : [])
    .filter((r) => r && typeof r === 'object' && Number.isFinite(Date.parse(r.at || '')))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at));
  return runs.find((r) => env && r.environment === env) || runs.find((r) => !r.environment) || null;
}

// The measured MTTD beside its target: { words, met, over, elsewhere }. A failed run is said as failed,
// an aborted one as aborted; a verdict (over / within) only for a run that names this environment —
// `met` only for a verdict, so a run with none (it names no environment, or the target does not
// read as a duration) never turns the tile green. With no run here, `elsewhere` names another
// environment's measurement, as the control room does, never used as this one's.
function measuredMttd(run, src, { runs = [], env = null } = {}) {
  if (!run) {
    const other = (Array.isArray(runs) ? runs : []).filter((r) => r && r.outcome === 'pass' && r.environment && targetSeconds(r.mttd) !== null && Number.isFinite(Date.parse(r.at || '')))
      .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0];
    const elsewhere = other ? `Not measured${env ? ` in ${env}` : ' here'}: a chaos test in ${other.environment} measured MTTD ${other.mttd} on ${dayMonth(other.at)}.` : '';
    return { words: '', met: false, over: false, elsewhere };
  }
  const on = dayMonth(run.at);
  if (run.outcome === 'fail') return { words: `The last chaos test, on ${on}, failed: an alert it expected never fired.`, met: false, over: false, elsewhere: '' };
  if (run.outcome !== 'pass') return { words: `The last chaos test, on ${on}, was ${run.outcome === 'aborted' ? 'aborted' : `recorded as ${run.outcome}`}: nothing measured.`, met: false, over: false, elsewhere: '' };
  const s = targetSeconds(run.mttd);
  if (s === null) return { words: `The last chaos test, on ${on}, passed without recording how fast its alerts fired.`, met: false, over: false, elsewhere: '' };
  const t = src && run.environment ? targetSeconds(src.mttd) : null;
  const target = t === null ? '' : src.view ? src.view.mttdWords.replace(/^≤ /, '') : src.mttd;
  const over = t !== null && s > t;
  const unplaced = src && !run.environment ? ' (the run names no environment: no verdict)' : '';
  return { words: `MTTD ${run.mttd} in a chaos test on ${on}${run.studio ? ', recorded in the studio' : ''}${t === null ? unplaced : over ? `, over the ${target} target` : `, within the ${target} target`}`, met: t !== null && !over, over, elsewhere: '' };
}

// The way to give a service its targets from where the gap shows (the board's tile, the control room):
// 'Set targets…' while it has none, 'Change targets…' for the studio's; none where the repository
// states its own (they come first, a studio's would change nothing) or where the host cannot open the
// service's form (`settable`: the service list drawn, a service record, a rank that may change it).
const targetsActionFor = (origin, settable) => (!settable || origin === 'repository' ? null : origin === 'studio' ? 'Change targets…' : 'Set targets…');

// chainModel({ layered, targets, env, settable }) → null without a pack, else
//   { links: [{ key, name, hint, count, words, parts, note, tone }],
//     mttx: { declared, origin, targets, measured, note, hint, tone, recommended, action },
//     detail: { count, line }, machinery: { count, line } }
//   targets  the service's MTTD / MTTR targets set in the studio (its record's `targets`,
//            mttx-targets.mjs), or null. The repository's own (spec.baselines, both stated) win;
//            then the studio's, said as the studio's; with neither, `recommended` is the
//            recommended profile and the others ({ name, words, profiles: [{ name, words, conditions }] }).
//   env      the board's environment: its newest chaos run is the measured MTTD (a failed run said
//            as failed), set beside the target — over it, the tile is amber, never green
//   origin   'repository' | 'studio' | null
//   action   'Set targets…' | 'Change targets…' | null — the tile's button (targetsActionFor)
//   record   'Record a chaos run…' | null — its other button, where the pack declares an experiment
//            (chaosExperimentsOf) and the host can open the form (`settable`, as for the targets)
//   parts  for a link of several families, each one's count ("58 alert rules · 8 burn-rate alerts")
//   note   alerts: the objectives no burn-rate alert covers; a link with none: that none was found
export function chainModel({ layered = null, targets = null, env = null, settable = false, counted = false } = {}) {
  if (!layered) return null;
  const d = declaredByTier(layered);
  const links = CHAIN_LINKS.map((l) => {
    const x = d.links[l.key];
    // A link of several families says each, when more than one is there ("58 alert rules · 8 burn-rate alerts").
    const present = l.families.filter((f) => x.families[f]);
    const parts = present.length > 1 ? present.map((f) => tierWords(f, x.families[f])).join(' · ') : '';
    const bare = l.key === 'alerts' && d.objectives.withoutAlert
      ? `${d.objectives.withoutAlert} of ${d.objectives.total} objectives ${d.objectives.withoutAlert === 1 ? 'has' : 'have'} no burn-rate alert.`
      : '';
    const note = x.count ? bare : CHAIN_EMPTY[l.key];
    return { key: l.key, name: l.name, hint: l.hint, count: x.count, words: x.count === 1 ? l.one : l.many, parts, note, tone: !x.count ? 'fail' : (bare ? 'warn' : 'ok') };
  });
  const m = d.mttx;
  const src = targetsSource(m, targets);
  // The measured MTTD: this environment's newest chaos run, and how it stands against the target.
  const { words: measured, met, elsewhere } = measuredMttd(chaosRunFor(m, env), src, { runs: m.runs, env });
  const notMeasured = 'Not measured yet: no chaos test has recorded how fast an alert fired, and nothing measures recovery.';
  const rec = recommendedProfile();
  const mttx = src?.origin === 'repository' ? {
    declared: true, origin: 'repository',
    targets: src.words,
    measured,
    note: measured ? '' : (elsewhere || notMeasured),
    hint: 'The repository states them itself, and they come first.',
    tone: met ? 'ok' : 'warn', recommended: null, action: null,
  } : src ? {
    // Set in the studio (Add a service, Change): real targets, said as the studio's, never the repository's.
    declared: true, origin: 'studio',
    targets: src.words,
    measured,
    note: `Set in the studio${src.view.profile === MTTX_CUSTOM ? '' : ` (${src.view.name.toLowerCase()})`}, not in the repository${counted ? '; the grade counts them for Calibrated' : ''}. ${measured ? `${measured}.`.replace(/\.\.$/, '.') : (elsewhere || notMeasured)}`,
    hint: 'Set in the studio for this service and kept with its record.',
    tone: met ? 'ok' : 'warn', recommended: null, action: targetsActionFor('studio', settable),
  } : {
    declared: false, origin: null,
    targets: '',
    measured,
    note: 'No MTTD / MTTR targets are set for this service.',
    hint: 'Until they are set, the recommendation is what to aim for.',
    tone: 'fail', action: targetsActionFor(null, settable),
    // What to aim for meanwhile: the recommended profile, and the others with the incidents each fits.
    recommended: {
      name: rec.name, words: `MTTD ${rec.mttdWords} · MTTR ${rec.mttrWords}`,
      profiles: MTTX_PROFILES.filter((p) => !p.recommended).map((p) => ({ name: p.name, words: `MTTD ${p.mttdWords} · MTTR ${p.mttrWords}`, conditions: p.conditions })),
      conditions: rec.conditions,
    },
  };
  mttx.record = settable && chaosExperimentsOf(layered).length ? CHAOS_RECORD_LABEL : null;
  return {
    links, mttx,
    detail: { count: d.detail.count, line: familyList(d.detail.families) },
    machinery: { count: d.machinery.count, line: familyList(d.machinery.families) },
  };
}

// controlRoomMttx({ loaded, layered, layeredError, targets, settable }) → the control room's `mttx`
// (control-room-model.mjs buildControlRoomModel): { unread: true } while the pack is not read;
// the repository's targets ({ declared, origin: 'repository', mttdTarget, mttrTarget, runs, action: null });
// else the studio's, with their words ({ declared, origin: 'studio', mttdTarget, mttrTarget,
// mttdWords, mttrWords, runs, action }) — measured against, said as the studio's; else the recommendation
// ({ declared: false, runs, recommended: { name, mttd, mttr, mttdWords, mttrWords }, action }), never a verdict.
// `action`: 'Set targets…' | 'Change targets…' | null, as on the board's tile (targetsActionFor);
// `record`: true where Record a chaos run… opens (the pack declares an experiment, and `settable`).
// `objectives` (the service's stated SLO objectives) ride along for the panel's SLO rows, with
// `objectivesAction` ('State objectives…' | 'Change objectives…' | null, as under the board's letter).
export function controlRoomMttx(facts = {}) {
  const m = controlRoomMttxOf(facts);
  if (m.unread) return m;
  const offer = facts.diagnostic ? objectivesOffer(facts.diagnostic, { objectives: facts.objectives ?? null }, { settable: !!facts.settable }) : null;
  return { ...m, ...(facts.objectives ? { objectives: facts.objectives } : {}), ...(offer ? { objectivesAction: offer.label } : {}) };
}
function controlRoomMttxOf({ loaded = false, layered = null, layeredError = null, targets = null, settable = false } = {}) {
  if (!loaded || layeredError || !layered) return { unread: true };
  const m = declaredByTier(layered).mttx;
  const runs = Array.isArray(m.runs) ? m.runs : [];
  const src = targetsSource(m, targets);
  const record = !!settable && chaosExperimentsOf(layered).length > 0;
  if (src?.origin === 'repository') return { declared: true, origin: 'repository', mttdTarget: src.mttd, mttrTarget: src.mttr, runs, action: null, record };
  if (src) return { declared: true, origin: 'studio', mttdTarget: src.mttd, mttrTarget: src.mttr, mttdWords: src.view.mttdWords, mttrWords: src.view.mttrWords, runs, action: targetsActionFor('studio', settable), record };
  const rec = recommendedProfile();
  return { declared: false, runs, recommended: { name: rec.name, mttd: rec.mttd, mttr: rec.mttr, mttdWords: rec.mttdWords, mttrWords: rec.mttrWords }, action: targetsActionFor(null, settable), record };
}

// What a run says about the chain, from its record's drift.tiers (a record
// written before it has none: null, and the board counts everything, as before).
//   links  [{ key, name, live, of, line, tone, counts }] — live of declared (21 of 21) drawn as
//          the count; `line` what else holds ("1 not as declared · 7 not read live"), or ''
//   pct    the chain's alignment: what matches of what was compared, over the three links
//   beyond { count, liveOnly, line } — outside the chain, what differs from what the
//          repository declares (by family), and what runs live undeclared
function chainLive(run) {
  const tiers = run?.drift?.tiers;
  if (!tiers || typeof tiers !== 'object' || !CHAIN_LINKS.every((l) => tiers[l.key] && typeof tiers[l.key] === 'object')) return null;
  const n = (v) => Number(v) || 0;
  let matched = 0, compared = 0;
  const links = CHAIN_LINKS.map((l) => {
    const c = tiers[l.key];
    const of = n(c.aligned) + n(c.drifted) + n(c.declaredNotLive);
    matched += n(c.aligned);
    compared += of + n(c.liveNotDeclared);
    const parts = [];
    if (n(c.drifted)) parts.push(`${n(c.drifted)} not as declared`);
    if (n(c.notRead)) parts.push(`${n(c.notRead)} not read live`);
    if (n(c.liveNotDeclared)) parts.push(`${n(c.liveNotDeclared)} live only`);
    if (n(c.setAside)) parts.push(`${n(c.setAside)} set aside`);
    const tone = n(c.declaredNotLive) ? 'fail' : (n(c.drifted) || n(c.liveNotDeclared) || n(c.notRead)) ? 'warn' : of ? 'ok' : 'neutral';
    return { key: l.key, name: l.name, live: n(c.aligned) + n(c.drifted), of, line: parts.join(' · ') || (of ? '' : `no ${l.many} declared`), tone, counts: c };
  });
  const families = {};
  for (const t of [tiers.detail, tiers.machinery]) for (const [f, k] of Object.entries(t?.families || {})) families[f] = (families[f] || 0) + n(k);
  const beyondCount = differencesOf(tiers.detail) + differencesOf(tiers.machinery);
  const liveOnly = n(tiers.detail?.liveNotDeclared) + n(tiers.machinery?.liveNotDeclared);
  const list = Object.entries(families).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'en')).map(([f, k]) => tierWords(f, k));
  const more = liveOnly ? ` ${liveOnly} more ${liveOnly === 1 ? 'runs' : 'run'} live, not declared.` : '';
  const beyond = {
    count: beyondCount,
    liveOnly,
    line: beyondCount
      ? `Beyond the chain, ${beyondCount} ${beyondCount === 1 ? 'detail differs' : 'details differ'}: ${listWords(list.slice(0, 3))}${list.length > 3 ? ' and more' : ''}.${more}`
      : `Beyond the chain, the details match too.${more}`,
  };
  return { links, pct: compared ? Math.round(matched / compared * 100) : null, beyond };
}

// ---------- the board: the specification's rules, in Remediate ----------

// The rules the specification requires of the service's tier are not part of
// the grade — a second figure beside the letter read as a second verdict on
// the same thing — so the board lists them where they are things to do: in
// Remediate, each unmet rule something to add to the pack.
//
// rulesModel(conformance, { error }) → { passed, total, pct, tier, met, unknown, unmet, missing, waived, sentence, tone } | null
//   conformance  GET /api/packs/:id/conformance — the pack against the
//                specification's clauses for its declared tier (`tier` in the
//                body is an object; the string is `declaredTier` or `tier.graded`)
//   error        the read's failure sentence, when it failed: the line then
//                says the rules could not be read — not that none apply
//   unmet        the required rules not met (total − passed)
//   missing      [text] — those rules in the specification's order, each as the thing to do
//                (studio/clause-fixes.mjs, Expert's Conformance's own words), else its clause's
//                description — never its id (a layer code); a waived one is left out (`waived` counts them)
export function rulesModel(conformance, { error = null } = {}) {
  const must = conformance?.must;
  const passed = Number(must?.passed) || 0, total = Number(must?.total) || 0;
  if (!total) {
    if (!conformance && error) return { passed: 0, total: 0, pct: 0, tier: '', met: false, unknown: true, unmet: 0, missing: [], waived: 0, sentence: 'The rules the specification requires could not be read.', tone: 'neutral' };
    return null;
  }
  const pct = Math.round(passed / total * 100);
  const rawTier = conformance.declaredTier || (conformance.tier && typeof conformance.tier === 'object' ? conformance.tier.graded : conformance.tier) || '';
  const tier = String(rawTier).replace(/^tier-/i, '').trim();
  const met = conformance.conformant === true;
  const unmet = Math.max(0, total - passed);
  const waivedIds = new Set(Object.entries(conformance.waivers?.clauses || {}).filter(([, w]) => w && w.status === 'waived').map(([id]) => id));
  const failing = (Array.isArray(conformance.clauses) ? conformance.clauses : [])
    .filter((c) => c && c.applies && c.severity === 'MUST' && c.pass === false && typeof c.id === 'string');
  const missing = failing.filter((c) => !waivedIds.has(c.id))
    .map((c) => CLAUSE_FIX[c.id]?.action || (typeof c.description === 'string' ? c.description.trim() : ''))
    .filter(Boolean);
  const waived = failing.filter((c) => waivedIds.has(c.id)).length;
  const whose = `the specification requires${tier ? ` of a tier ${tier} service` : ''}`;
  return {
    passed, total, pct, tier, met, unknown: false, unmet, missing, waived,
    sentence: unmet
      ? `${unmet} of the ${total} rules ${whose} ${unmet === 1 ? 'is' : 'are'} not met${waived ? ` (${waived} of them waived)` : ''}.`
      : `All ${total} rules ${whose} are met.`,
    tone: met ? 'ok' : (pct >= 50 ? 'warn' : 'fail'),
  };
}

// ---------- the board: can you trust what the signals show? ----------

// fidelityModel({ run, journey, pack, now }) → { known, alignmentPct, tiles, chains, against, note }
//   known      a run graded this pack and saw the live side whole; else the
//              note says why the numbers are withheld (never shown as zeros)
//   tiles      [{ key, value, label, note, tone }] — match · run differently ·
//              not running live · live only, the run's drift counts
//   chains     { total, intact, partial, broken, integrityPct, sentence } | null
//   note       beside the numbers: the probe families that could not be read,
//              the rules compared in part (labels or a Grafana rule's condition
//              the live side does not show, values a chart or a deploy step
//              fills in), and a reading older than a day, which the engine
//              does not trust
//   partial    what of the live side was not read, in the strip's words: the
//              failed probe families, and "rule labels or conditions" when the
//              run compared rules on part of them (drift.partlyCompared)
//   chain      the chain's links against live (chainLive), when the record
//              counts them (drift.tiers); the board then draws the links and
//              their alignment, and says the rest in one line
export function fidelityModel({ run = null, journey = null, pack = null, now = Date.now() } = {}) {
  const against = journey ? (journeyIsLive(journey) ? 'live' : 'recording') : (/^mcp:/i.test(String(run?.packB?.source || '')) || !run ? 'live' : 'recording');
  const base = { known: false, alignmentPct: null, tiles: [], chains: null, against, note: '', partial: [], chain: null };
  if (!run || !runGradedPack(run, pack)) return { ...base, note: 'Never checked against live.' };
  if (run.outcome === 'vantage-lost' || vantageOf(run) === 'lost') {
    return { ...base, note: liveLossOf(run).cause === 'no-data'
      ? 'The live side answered the last check but returned nothing this check reads, so nothing is known about it right now.'
      : 'The live side did not answer the last check, so nothing is known about it right now.' };
  }
  // Nothing compared: the counts are withheld with the reason, never drawn as zeros; the families
  // the live side could not read are still named (the status strip says them).
  if (run.outcome === 'scan-partial') return { ...base, nothing: true, note: 'The last Run read the repository in part and stopped before comparing anything; the previous pack is kept.' };
  if (vantageShrank(run).length) return { ...base, note: 'The live side showed less than the check before, so the counts cannot be compared yet.' };
  if (comparedOf(run.drift) === 0) {
    const failedWords = Array.isArray(run.probes?.failed) ? run.probes.failed.map(familyWord) : [];
    return { ...base, nothing: true, note: `Nothing was compared on the last check, so there is nothing to count. ${nothingReason(basisFactsOf(run))}.`, partial: failedWords };
  }
  const n = (x) => Number(x) || 0;
  const d = run.drift || {};
  const tiles = [
    { key: 'aligned', value: n(d.aligned), label: 'match', note: 'declared and running live', tone: 'ok' },
    { key: 'drifted', value: n(d.drifted), label: 'run differently', note: 'running live, not as declared', tone: 'warn' },
    { key: 'missing', value: n(d.declaredNotLive), label: 'not running live', note: `declared, nowhere live${n(d.setAside?.declaredNotLive) ? ` · ${n(d.setAside.declaredNotLive)} set aside` : ''}`, tone: 'fail' },
    { key: 'extra', value: n(d.liveNotDeclared), label: 'live only', note: `running live, not declared${n(d.setAside?.liveNotDeclared) ? ` · ${n(d.setAside.liveNotDeclared)} set aside` : ''}`, tone: 'info' },
  ];
  const t = run.traceability || {};
  const total = n(t.declaredTotal);
  const integrity = Number(t.integrityPct);
  const chains = total ? {
    total, intact: n(t.intact), partial: n(t.partial), broken: n(t.broken), integrityPct: Number.isFinite(integrity) ? integrity : null,
    // Whole promises: every link holds (intact), a link runs differently
    // (partial), a link the promise rests on is missing (broken).
    sentence: `${n(t.intact)} of ${total} promises hold in every link${n(t.partial) ? `, ${n(t.partial)} in part` : ''}${n(t.broken) ? `, ${n(t.broken)} broken` : ''}.`,
  } : null;
  // A figure only where the record has one (Number(null) is 0).
  const pct = typeof d.alignmentPct === 'number' ? d.alignmentPct : NaN;
  // A live side that answered only in part (a probe family failed) is said
  // beside the numbers: they count what could be seen.
  const failed = Array.isArray(run.probes?.failed) ? run.probes.failed.map(familyWord) : [];
  const notes = [];
  if (failed.length) notes.push(`The live side answered only in part: its ${listWords(failed)} could not be read.`);
  // Rules matched on what each side showed of them: a listing that gives a
  // severity and no other label never showed the rest, one that gives a
  // Grafana-managed rule's query without its condition (its threshold) never
  // showed that, and a chart that fills in a value never showed it — so
  // "match" says nothing about those parts, and the board says that
  // (drift.partlyCompared counts them all).
  const partly = n(d.partlyCompared);
  if (partly) notes.push(`${partly} alert ${partly === 1 ? 'rule was' : 'rules were'} compared in part: labels or a condition the live side does not show, or values a chart or a deploy step fills in, were not compared.`);
  const startedMs = Date.parse(run.startedAt || '');
  if (Number.isFinite(startedMs) && now - startedMs > FRESH_WINDOW_MS) notes.push(`Counted ${agoText(run.startedAt, now)}; readings older than a day are not trusted.`);
  return { ...base, known: true, alignmentPct: Number.isFinite(pct) ? pct : null, tiles, chains, note: notes.join(' '), partial: [...failed, ...(partly ? ['rule labels or conditions'] : [])], chain: chainLive(run) };
}

// ---------- the board: what the scan read ----------
//
// A service's Run keeps what its scan saw in the run record (packA.scan,
// tools/lib/crawler.mjs scanReport): the files read, and every file the scan
// left out — the files the rule would read and the read did not (git ignores
// them, a secrets file, too large, a download failed), those past a host
// read's file cap, those the environment's deployment profile excludes, the
// files read and recognised as nothing — with the crawl's warnings. The
// board says it beside the layers, so a grade never rests on files nobody
// was told were missing.

// The deployment surfaces an environment may read alone — tools/lib/crawler.mjs
// DEPLOYMENT_SURFACES, mirrored here (a studio module never imports tools/lib;
// tools/test-overview-model.mjs pins the ids): the service form's choices, the
// first ('') reading every file, and the words a sentence names each by.
export const DEPLOYMENT_SURFACE_CHOICES = Object.freeze([
  Object.freeze({ id: '', label: 'No — every file the scan reads (default)' }),
  Object.freeze({ id: 'kubernetes', label: 'Kubernetes and Helm' }),
  Object.freeze({ id: 'eks', label: 'Kubernetes on Amazon EKS' }),
  Object.freeze({ id: 'local-kubernetes', label: 'A local Kubernetes cluster (kind, minikube)' }),
  Object.freeze({ id: 'compose', label: 'Docker Compose' }),
]);
const SURFACE_IDS = DEPLOYMENT_SURFACE_CHOICES.map((c) => c.id).filter(Boolean);
const SURFACE_WORDS = Object.freeze({ kubernetes: 'Kubernetes and Helm', eks: 'Amazon EKS', 'local-kubernetes': 'local Kubernetes', compose: 'Docker Compose' });
// A surface in a sentence ("14 left out by the Kubernetes and Helm filter"); 'environment' for anything else.
export function surfaceLabel(id) {
  return Object.hasOwn(SURFACE_WORDS, id) ? SURFACE_WORDS[id] : 'environment';
}

// The losses of a scan, in a few words ("347 past the 200-file cap, 3 not
// read, …"), or '' when it read everything it takes. The Run's toast says it.
// A record whose scan counts what it did not read (`notRead`, from this
// release on) is said by kind — could not be read, over the scan's limits,
// past the file cap — and a file left out on purpose (a secrets file, one git
// ignores) is no loss; an older record reads as it always did.
export function scanLossText(scan) {
  if (!scan || typeof scan !== 'object') return '';
  const n = (v) => Number(v) || 0;
  const parts = [];
  if (typeof scan.notRead === 'number') {
    const lost = n(scan.lost);
    const capped = n(scan.capped);
    const limit = Math.max(0, n(scan.notRead) - lost - capped);
    if (lost) parts.push(`${lost} could not be read`);
    if (limit) parts.push(`${limit} over the scan's limits`);
    if (capped) parts.push(`${capped} past the file cap`);
    if (scan.treeTruncated || scan.truncated) parts.push('the host cut its file list short');
    const excluded = n(scan.filter?.excluded ?? scan.environment?.excluded);
    if (excluded) parts.push(`${excluded} left out by the ${surfaceLabel(scan.filter?.surface)} filter`);
    if (n(scan.unclassified)) parts.push(`${n(scan.unclassified)} recognised as nothing`);
    return parts.join(', ');
  }
  if (n(scan.capped)) parts.push(`${n(scan.capped)} past the file cap`);
  if (n(scan.skipped)) parts.push(`${n(scan.skipped)} not read`);
  if (scan.truncated) parts.push('the host cut its file list short');
  if (n(scan.environment?.excluded)) parts.push(`${n(scan.environment.excluded)} left out by the ${scan.environment.profile || 'environment'} scope`);
  if (n(scan.unclassified)) parts.push(`${n(scan.unclassified)} recognised as nothing`);
  return parts.join(', ');
}

// scanModel({ run }) → null when the record carries no scan, else
//   { sentence, tone, groups: [{ key, title, count, rows: [{ path, why }], more }], warnings,
//     partial, notRead, candidates }
//   tone  'warn' when the scan did not read files it takes (could not, over
//         a limit, past the cap, a cut list) or its deployment surface left
//         out most of the repository, else 'neutral' — a file left out on
//         purpose never warns
export function scanModel({ run = null } = {}) {
  const scan = run?.packA?.scan;
  if (!scan || typeof scan !== 'object') return null;
  const n = (v) => Number(v) || 0;
  const files = n(scan.files);
  const candidates = n(scan.candidates);
  const of = candidates > files ? ` of ${candidates}` : '';
  const loss = scanLossText(scan);
  const sentence = `Read ${files}${of} file${(candidates || files) === 1 ? '' : 's'}${scan.source ? ` from ${scan.source}` : ''}${loss ? ` — ${loss}` : ''}.`;
  const rowsOf = (list, why = '') => (Array.isArray(list) ? list : []).map((x) => (typeof x === 'string' ? { path: x, why } : { path: String(x?.path || ''), why: String(x?.why || why) }));
  const group = (key, title, count, rows) => ({ key, title, count, rows, more: Math.max(0, count - rows.length) });
  const groups = [];
  const warnings = (Array.isArray(scan.warnings) ? scan.warnings : []).map(String);
  if (typeof scan.notRead === 'number') {
    const skippedOf = (kind) => rowsOf((Array.isArray(scan.skippedFiles) ? scan.skippedFiles : []).filter((x) => x?.kind === kind));
    const lost = n(scan.lost);
    const capped = n(scan.capped);
    const limit = Math.max(0, n(scan.notRead) - lost - capped);
    const onPurpose = Math.max(0, n(scan.skipped) - lost - limit);
    const excluded = n(scan.filter?.excluded ?? scan.environment?.excluded);
    const label = surfaceLabel(scan.filter?.surface);
    if (lost) groups.push(group('lost', 'Could not be read — the host or the disk failed these; run it again', lost, skippedOf('lost')));
    if (limit) groups.push(group('limit', 'Not read — over what a scan reads (too large, past the total, not text, an archive entry it cannot open)', limit, skippedOf('limit')));
    if (capped) groups.push(group('capped', 'Past the file cap — the read takes the likely artefacts first and stops at its cap', capped, rowsOf(scan.cappedFiles, 'past the file cap')));
    if (scan.treeTruncated || scan.truncated) groups.push(group('truncated', 'The host cut its file list short: files it did not list were not read, and nothing here can name them', 0, []));
    if (onPurpose) groups.push(group('onPurpose', 'Skipped on purpose — a name that says it holds secrets, or git ignores it', onPurpose, skippedOf('on-purpose')));
    if (excluded) groups.push(group('excluded', `Left out by the ${label} filter — files for other deployment surfaces`, excluded, rowsOf(scan.environment?.excludedFiles)));
    if (n(scan.unclassified)) groups.push(group('unknown', 'Read, recognised as nothing — no observability artefact the scan knows', n(scan.unclassified), rowsOf(scan.unknownFiles)));
    const warn = lost || limit || capped || scan.treeTruncated || scan.truncated || scan.excludedMost === true;
    return { sentence, tone: warn ? 'warn' : 'neutral', groups, warnings, partial: scan.partial === true, notRead: n(scan.notRead), candidates };
  }
  if (n(scan.skipped)) groups.push(group('skipped', 'Not read', n(scan.skipped), rowsOf(scan.skippedFiles)));
  if (n(scan.capped)) groups.push(group('capped', `Past the file cap — the read takes the likely artefacts first and stops at its cap`, n(scan.capped), []));
  if (scan.truncated) groups.push(group('truncated', 'The host cut its file list short: files it did not list were not read, and nothing here can name them', 0, []));
  if (n(scan.environment?.excluded)) groups.push(group('excluded', `Left out by the ${scan.environment.profile || 'environment'} scope — files for other deployment surfaces`, n(scan.environment.excluded), rowsOf(scan.environment.excludedFiles)));
  if (n(scan.unclassified)) groups.push(group('unknown', 'Read, recognised as nothing — no observability artefact the scan knows', n(scan.unclassified), rowsOf(scan.unknownFiles)));
  return { sentence, tone: n(scan.capped) || n(scan.skipped) || scan.truncated ? 'warn' : 'neutral', groups, warnings };
}

// ---------- the board: what to change ----------

// changesModel({ fidelity }) → { known, items, total, sentence, beyond }
//   items  [{ key, value, label, note, tone }] — to add (declared, not running
//          live: what Remediate compiles) · to update (runs differently) · to
//          review (live only, not in the repository)
//   When the run counts the chain (fidelity.chain), the items count the
//   chain's links alone and `beyond` says the rest in one line ('' when the
//   record counts everything together).
export function changesModel({ fidelity = null } = {}) {
  if (!fidelity?.known) return { known: false, items: [], total: 0, sentence: fidelity?.nothing ? 'Nothing was compared on the last check, so there is nothing to change yet.' : 'Check against live to count what to change.', beyond: '' };
  const chain = fidelity.chain;
  if (chain) {
    const num = (l, k) => Number(l.counts?.[k]) || 0;
    const sum = (k) => chain.links.reduce((n, l) => n + num(l, k), 0);
    // Compared at all: a link live read in part counts what it read; one it read none of is "not read".
    const compared = (l) => num(l, 'aligned') + num(l, 'drifted') + num(l, 'declaredNotLive') + num(l, 'liveNotDeclared') > 0;
    const blind = (l) => num(l, 'notRead') > 0 && !compared(l);
    // Each tile says its count by link, in the chain's words: Exporters 0 · Alerts 2 · Dashboards –.
    const partsOf = (k) => chain.links.map((l) => ({ key: l.key, name: l.name, value: num(l, k), unread: blind(l) && !num(l, k) }));
    // Nothing of the chain was read: no count is known, so none is drawn as 0.
    const nothingRead = chain.links.every((l) => !compared(l)) && chain.links.some(blind);
    const items = [
      { key: 'add', value: sum('declaredNotLive'), label: 'to add', note: 'exporters, alerts or dashboards declared in the repository, not running live', tone: 'fail', parts: partsOf('declaredNotLive') },
      { key: 'update', value: sum('drifted'), label: 'to update', note: 'exporters, alerts or dashboards running live, but not as declared', tone: 'warn', parts: partsOf('drifted') },
      { key: 'review', value: sum('liveNotDeclared'), label: 'to review', note: 'exporters, alerts or dashboards running live, not in the repository', tone: 'info', parts: partsOf('liveNotDeclared') },
    ].map((i) => (nothingRead ? { ...i, value: null, unread: true } : i));
    const total = items.reduce((n, i) => n + (i.value || 0), 0);
    // Nothing to change: the links that match, named; a link live did not read is said so, never "matches".
    // The links' words are plural ("exporters", "dashboards"): they match, they are.
    const alike = chain.links.filter((l) => l.of && !num(l, 'declaredNotLive') && !num(l, 'drifted') && !num(l, 'liveNotDeclared') && !num(l, 'notRead')).map((l) => l.name.toLowerCase());
    const unread = chain.links.filter((l) => num(l, 'notRead')).map((l) => `the ${num(l, 'notRead')} ${num(l, 'notRead') === 1 ? CHAIN_LINKS.find((c) => c.key === l.key)?.one : l.name.toLowerCase()}`);
    // None declared: nothing compared, none not read, none set aside (a link whose declared ones are all set aside is no gap).
    const none = chain.links.filter((l) => !l.of && !num(l, 'notRead') && !num(l, 'liveNotDeclared') && !num(l, 'setAside')).map((l) => l.name.toLowerCase());
    const orWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);
    const sentence = total ? (unread.length ? `Not read live, so not counted here: ${listWords(unread)}.` : '')
      : [
        alike.length ? `Nothing to change in the ${listWords(alike)}: they match live.`
          : nothingRead ? 'Nothing in the chain could be compared.'
            : (unread.length ? '' : 'Nothing to change: live matches what the repository declares.'),
        unread.length ? `Not read live, so not compared: ${listWords(unread)}.` : '',
        none.length ? `No ${orWords(none)} are declared.` : '',
      ].filter(Boolean).join(' ');
    return {
      known: true, items, total,
      sentence,
      beyond: chain.beyond.count || chain.beyond.liveOnly ? chain.beyond.line : '',
    };
  }
  const v = (k) => fidelity.tiles.find((t) => t.key === k)?.value || 0;
  const items = [
    { key: 'add', value: v('missing'), label: 'to add', note: 'declared in the repository, not running live', tone: 'fail' },
    { key: 'update', value: v('drifted'), label: 'to update', note: 'running live, but not as declared', tone: 'warn' },
    { key: 'review', value: v('extra'), label: 'to review', note: 'running live, not in the repository', tone: 'info' },
  ];
  const total = items.reduce((n, i) => n + i.value, 0);
  return { known: true, items, total, sentence: total ? '' : 'Nothing to change: live matches what the repository declares.', beyond: '' };
}

// ---------- the drift check started here ----------
//
// The start (no service, or a service with no pack) is the drift check in
// three steps: step 1 lands Pack A, step 2 Pack B, step 3 is the comparison.
// The host keeps the state — it passes it to buildOverviewModel as `start` —
// and owns the flows (its scan, its live draft, its upload); these two say
// what each event does to the state, so every host routes the packs alike.
// A state is { slot, a }: `slot` the pack the next flow fills ('a' | 'b' |
// null), `a` Pack A once in ({ id, label }).
export const START_IDLE = Object.freeze({ slot: null, a: null });

// A start card opened one of the host's flows for `slot` ('a' | 'b').
export function startChoose(start, slot) {
  return { slot: slot === 'b' ? 'b' : 'a', a: start?.a ?? null };
}

// One of those flows registered `pack` ({ id, label }) while the board was
// on screen. → { start, compare, said, refused }: step 1 keeps Pack A
// (compare null; the board shows step 2 next); step 2 answers the pair the
// host opens its comparison on (compare { a, b }) and the state is idle
// again; the same pack offered as Pack B is refused and Pack A kept. `said`
// is the sentence to announce. A pack with no id changes nothing.
export function startAdopted(start, pack) {
  const id = pack?.id ?? null;
  const label = String(pack?.label || pack?.id || '');
  const a = start?.a ?? null;
  if (!id) return { start: start ?? START_IDLE, compare: null, said: '', refused: false };
  if (start?.slot !== 'b' || !a) return { start: { slot: null, a: { id, label } }, compare: null, said: `Pack A loaded: ${label}. Step 2: its live side.`, refused: false };
  if (a.id === id) return { start: { slot: null, a }, compare: null, said: 'That pack is Pack A already: step 2 needs its live side.', refused: true };
  return { start: START_IDLE, compare: { a, b: { id, label } }, said: `Comparing ${a.label} against ${label}.`, refused: false };
}

// ---------- the whole screen ----------

// Scan, live and upload are operator routes — a rank without them gets the
// server's reason to draw.
const sourcesOf = (access) => ({ enabled: access?.canWrite !== false, reason: access?.canWrite === false ? (access.reason || null) : null });

// buildOverviewModel({ services, servicesStatus, catalog, serviceId, env, isLiveAggregatePack,
//   diagnostic, diagnosticError, decision, journeys, journeysError, run, running, startError,
//   now, productName, pending, layout, cells, layered, conformance, conformanceError, access, start, startable, listable })
// `listable`: the host draws the service list (serviceListModel, below) as
// Overview's front door; the service's header then links back to it.
export function buildOverviewModel(input = {}) {
  const {
    services = null, servicesStatus = null, catalog = [], serviceId = null, env = null, isLiveAggregatePack = () => false,
    diagnostic = null, diagnosticError = null, decision = null, journeys = null, journeysError = null, run = null,
    running = false, startError = null, now = Date.now(), productName = '', pending = false,
    layout = 'board', cells = null, layered = null, unkinded = null, conformance = null, conformanceError = null, access = null, start = null, startable = false,
    listable = false, gradeSwitches = false, controlRoom = false, controlRoomOpen = false,
    // A Run newer than `run` that stopped on a partial scan (its record, outcome scan-partial), or null.
    stopped = null,
  } = input;
  const ordered = orderServicesForOverview(services, catalog, { isLiveAggregatePack });
  const picked = pickOverviewService(services, catalog, { serviceId, env, isLiveAggregatePack });
  // The picker lists the rows with a pack of their own; a row whose only pack
  // is a live aggregate's membership has nothing to grade and is Expert's to
  // show — unless it is the one remembered, which stays so the screen can say
  // so. When no row has a pack of its own, every row is listed.
  const own = ordered.filter((s) => packForService(s, catalog, { isLiveAggregatePack }).how === 'primary');
  const listed = own.length ? ordered.filter((s) => own.includes(s) || (picked.service && s.id === picked.service.id)) : ordered;
  const options = listed.map((s) => ({ id: s.id, name: s.name, selected: picked.service ? s.id === picked.service.id : false }));
  // A drift check started here (step 1 loaded Pack A) stays on screen until
  // step 2 opens the comparison — though registering Pack A has just put its
  // service in the table.
  // `startable`: the host runs the start (it supplies the start's hooks and
  // routes packs with startAdopted). Without it the board is what it was —
  // the empty state and "Open Expert mode" — so a host that copies these
  // files and has not wired the start never draws cards that do nothing.
  const started = startable && !!start?.a;
  if (!picked.service || started) {
    const unreadable = servicesStatus && servicesStatus.kind !== 'ok' && servicesStatus.kind !== 'loading' ? (servicesStatus.error || 'the services table could not be read') : null;
    const kind = started ? 'empty' : (unreadable ? 'error' : (servicesStatus?.kind === 'loading' ? 'loading' : 'empty'));
    const blank = { kind, error: kind === 'error' ? unreadable : null, options: [], service: null, envs: [], env: null, grade: null, still: null, next: null, productName, primary: null, layout, board: null };
    // Empty: the drift check starts here. `start` is the check under way:
    // Pack A once step 1 loaded it.
    return kind === 'empty' && startable ? {
      ...blank,
      sources: sourcesOf(access),
      start: { a: start?.a ? { label: String(start.a.label || start.a.id || 'Pack A') } : null },
    } : blank;
  }
  const journey = journeyForService(journeys, { slug: picked.service.slug, env: picked.env, packId: picked.pack?.id || null });
  // The criteria this service is not graded on (its record's gradeOff). `gradeSwitches`: the host
  // wires the switch (setGradeCriterion); without it the board lists what is off and offers no switch.
  const off = Array.isArray(picked.service.gradeOff) ? picked.service.gradeOff : [];
  // The differences its grade leaves out (its record's setAside), by the name of those that hold now.
  const aside = serviceAsideKey(picked.service, now);
  // The MTTD / MTTR targets its grade counts (its record's targets, where Calibrated reads them), by
  // their key; with no grade to ask, the record's.
  const counted = studioTargetsCounted(pending ? null : diagnostic);
  // No grade to ask (the pack could not be read): Calibrated switched off counts nothing either way.
  const targetsOnly = counted === false || (counted === null && gradeOffKeys(off).includes('calibrated')) ? '' : serviceTargetsKey(picked.service);
  // …and the SLO objectives stated in the studio its Calibrated counts, joined to them.
  const targets = termsOf(targetsOnly, !pending && diagnostic ? serviceObjectivesKey(picked.service, diagnostic) : (gradeOffKeys(off).includes('calibrated') ? '' : serviceObjectivesKey(picked.service)));
  const graded0 = gradeModel({ pack: picked.pack, how: picked.how, diagnostic: pending ? null : diagnostic, diagnosticError: pending ? null : diagnosticError, run: run && journey && !pending ? run : null, journey, now, off, aside, targets });
  const canSwitch = gradeSwitches === true && picked.how === 'primary' && !pending;
  // `graded`: the criteria the service is graded on, by name — where the reasons are not offered
  // (they would not add up to the letter), the board lists these so each can still be switched.
  const offKeys = gradeOffKeys(off);
  const grade = canSwitch ? {
    ...graded0,
    switches: { enabled: access?.canWrite !== false, reason: access?.canWrite !== false ? null : (access?.reason || 'Not available for your role here.') },
    graded: GRADE_CRITERIA.filter((c) => !offKeys.includes(c.key)).map((c) => ({ key: c.key, label: c.label })),
  } : graded0;
  // State objectives… / Change objectives…: where the host draws the service list (the form lives
  // there), for a service record, to a rank that may change it — and only when an SLO takes one.
  const offer = objectivesOffer(pending ? null : diagnostic, picked.service, { settable: !!listable && picked.how === 'primary' && Number.isInteger(picked.service?.id) && access?.canWrite !== false });
  if (offer) grade.objectives = offer;
  const still = stillTrueModel({ journey, run: journey ? run : null, now, running, startError, journeysError, pending, stopped: journey ? stopped : null });
  // A service with no pack at all has nothing to grade: the drift check
  // starts here, as with no service, under the service's own header — the
  // start's cards are the way in, not "Open Expert mode". (A member-only row,
  // whose one pack is a live aggregate's, stays Expert's to show.)
  const startHere = startable && picked.how === 'none';
  // The specification's rules not met, which Remediate lists (read before the next step, which names them when live agrees).
  const rules = picked.how === 'primary' && !pending ? rulesModel(conformance, { error: conformanceError }) : null;
  const next = startHere ? { sentence: '', button: null, why: [], primary: false } : nextActionModel({ still, grade, decision, run: journey ? run : null, journey, now, rulesLeft: rules && !rules.unknown ? rules.missing.length : 0, stopped: journey ? stopped : null });
  // One primary button on the screen: the next step's when it has one, else
  // the still-true panel's Check button; none over the start.
  const primary = startHere ? null : (next.button && next.primary ? 'next' : (still.checkPrimary ? 'check' : null));
  // The board's pictures, from the same facts: nothing while the facts are
  // still being read, nothing for a service without a pack of its own.
  const graded = picked.how === 'primary' && !pending;
  const fidelity = fidelityModel({ run: graded && journey ? run : null, journey, pack: picked.pack, now });
  const board = {
    // The chain the repository declares (exporters, alerts, dashboards, MTTD / MTTR).
    // Set targets… / Change targets… only where the host draws the service list (the form lives there),
    // for a service record, to a rank that may change it.
    chain: graded ? chainModel({ layered, targets: picked.service?.targets ?? null, env: picked.env ?? null, settable: !!listable && Number.isInteger(picked.service?.id) && access?.canWrite !== false, counted: counted === true }) : null,
    layers: graded ? layersModel({ cells, layered, unkinded }) : null,
    // What the last Run's scan read and left out (null: no record says).
    scan: graded && journey ? scanModel({ run }) : null,
    rules,
    fidelity: graded ? fidelity : null,
    changes: graded ? changesModel({ fidelity }) : null,
  };
  return {
    kind: 'service', error: null, options, back: !!listable,
    service: { id: picked.service.id, name: picked.service.name, slug: picked.service.slug },
    envs: picked.envs.map((name) => ({ name, selected: name === picked.env })), env: picked.env,
    journey: journey ? { name: journey.name, live: journeyIsLive(journey) } : null,
    // What the columns' "Open in …" carry to the host: the comparison the
    // board graded (boardComparison), null while nothing graded it.
    compare: graded && journey ? boardComparison({ journey, run, catalog, pack: picked.pack, off, aside, targets }) : null,
    grade, still, next, primary, productName, layout, board,
    // The control room (control-room-model.mjs): offered when the host wires
    // it (`controlRoom`) — a read of the environment's live endpoint, so the
    // environment must name one and the person must be allowed to read live.
    ...(controlRoom ? { controlRoom: controlRoomOffer(picked, access, controlRoomOpen) } : {}),
    ...(startHere ? { start: { a: null }, sources: sourcesOf(access) } : {}),
  };
}

// The control room's button on the board: offered, or why not (the button is
// then drawn unavailable and says so when pressed).
export function controlRoomOffer(picked, access, open) {
  const env = (picked.service?.environments || []).find((e) => e.name === picked.env) || null;
  if (access?.canWrite === false) return { offered: false, open: false, reason: access.reason || 'Reading live is not open to your role here.' };
  if (!env) return { offered: false, open: false, reason: `${picked.service?.name || 'This service'} has no environment yet: add one, with the live endpoint that reads it.` };
  if (!env.mcpEndpoint) return { offered: false, open: false, reason: `${picked.env} has no live endpoint yet: Change on the service list chooses one.` };
  return { offered: true, open: !!open, reason: null };
}

// ---------- the service list: Overview's front door ----------
//
// A service is two places: its repository — where what it declares lives
// (GitHub, Azure DevOps, or a folder on the server) — and, for each of its
// environments, the live MCP endpoint that reads what runs there. The list
// shows one row per service and environment with both places and its last
// check; Run (the host's: POST /api/services/:id/run) scans the repository
// again, checks the scan against live and saves the check. Add a service is
// the form of five answers: the name, the environment, the repository, the
// live endpoint, the MTTD / MTTR targets. Everything here is pure: the host keeps the state (the
// form's values, which row runs), carries out the save plan, and passes the
// facts in — the services table, the journeys listing, the MCP endpoints.
// A host that does not opt in (`listable`) never draws it.

export const REPOSITORY_KINDS = Object.freeze([
  Object.freeze({ kind: 'github', label: 'GitHub', placeholder: 'https://github.com/owner/repo', hint: 'A public repository, or a private one read with your own GitHub token.' }),
  Object.freeze({ kind: 'ado', label: 'Azure DevOps', placeholder: 'https://dev.azure.com/org/project/_git/repo', hint: 'Read with your own Azure DevOps token (Code (Read)).' }),
  Object.freeze({ kind: 'path', label: 'Folder', placeholder: 'C:\\src\\my-service  or  /srv/src/my-service', hint: 'A folder the server can read: its full path on the server.' }),
  // Offered only by a host that wires it (formModel's `uploads`): the files come from the person's own machine.
  Object.freeze({ kind: 'upload', label: 'Upload', placeholder: '', hint: 'A folder or a .zip from your machine. Its files are kept for this service and each Run scans them again; upload again when they change.' }),
  // A pack file in place of the repository (server/service-packs.mjs): an export of the declared pack, used as it is.
  Object.freeze({ kind: 'pack', label: 'Pack file', placeholder: '', hint: 'An exported pack (YAML or JSON) from your machine, used as the declaration as it is: each Run checks it against live without a scan. Upload it again when it changes.' }),
]);
// The Live answer's export of live (server/service-packs.mjs): a pack file in place of the MCP endpoint.
export const LIVE_PACK = 'pack';

// ---------- an environment's live scope ----------
//
// The scope an environment's live read applies (the server's normalizeScope fields; the studio never
// imports tools/lib, so the list rule is restated): the form's five answers, as typed — prefixes,
// folder uids and rule groups by commas, exclude patterns by white space — and the compact scope
// they make ({ metricPrefixes?, folderUids?, datasourceUid?, metricExclude?, ruleGroups? }, or null).
// The server checks every value; the form only splits them.
export const SCOPE_FIELDS = Object.freeze([
  Object.freeze({ value: 'scopePrefixes', field: 'metricPrefixes', label: 'Metric prefixes', placeholder: 'checkout_, http_server_', split: 'comma' }),
  Object.freeze({ value: 'scopeFolders', field: 'folderUids', label: 'Dashboard / rule folder uids', placeholder: 'abc123, def456', split: 'comma' }),
  Object.freeze({ value: 'scopeExclude', field: 'metricExclude', label: 'Exclude metric names matching', placeholder: '^go_ ^process_', split: 'space' }),
  Object.freeze({ value: 'scopeGroups', field: 'ruleGroups', label: 'Rule groups', placeholder: 'checkout, checkout-slo', split: 'comma' }),
  Object.freeze({ value: 'scopeDatasource', field: 'datasourceUid', label: 'Datasource uid', placeholder: 'prometheus', split: null }),
]);
const scopeList = (text, split) => [...new Set(String(text ?? '').split(split === 'space' ? /\s+/ : ',').map((x) => x.trim()).filter(Boolean))];

// A compact scope → the form's five answers.
export function scopeFormValues(scope) {
  const s = scope && typeof scope === 'object' ? scope : {};
  return Object.fromEntries(SCOPE_FIELDS.map((f) => [f.value, f.split === null ? (typeof s[f.field] === 'string' ? s[f.field] : '')
    : (Array.isArray(s[f.field]) ? s[f.field].join(f.split === 'space' ? ' ' : ', ') : '')]));
}

// The form's five answers → the compact scope, or null when every answer is empty.
export function scopeFromValues(values) {
  const out = {};
  for (const f of SCOPE_FIELDS) {
    if (f.split === null) { const v = trimmed(values?.[f.value]); if (v) out[f.field] = v; continue; }
    const list = scopeList(values?.[f.value], f.split);
    if (list.length) out[f.field] = list;
  }
  return Object.keys(out).length ? out : null;
}

// Two compact scopes the same (null and {} alike).
export function sameScope(a, b) {
  const key = (x) => JSON.stringify(SCOPE_FIELDS.map((f) => (x && x[f.field] !== undefined ? x[f.field] : null)));
  return key(a) === key(b);
}

// A scope said in a few words: "2 prefixes, 5 folders" (null for none).
export function scopeSummary(scope) {
  if (!scope || typeof scope !== 'object') return null;
  const n = (list, one, many) => (Array.isArray(list) && list.length ? `${list.length} ${list.length === 1 ? one : many}` : null);
  const parts = [
    n(scope.metricPrefixes, 'prefix', 'prefixes'), n(scope.folderUids, 'folder', 'folders'), n(scope.ruleGroups, 'rule group', 'rule groups'),
    n(scope.metricExclude, 'exclude pattern', 'exclude patterns'), typeof scope.datasourceUid === 'string' && scope.datasourceUid ? `datasource ${scope.datasourceUid}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(', ') : null;
}

// The server's configured snapshot scope as GET /api/mcp/jobs answers it ({ defaults, from, errors })
// → compact, or null (none configured, or not readable here).
// A configured scope with a variable that does not parse is none here: the Run refuses it, naming the
// variable, unless the environment has a scope of its own.
export function liveScopeDefaultsOf(answer) {
  if (!answer || typeof answer !== 'object' || !answer.defaults) return null;
  if (Array.isArray(answer.errors) && answer.errors.length) return null;
  return scopeFromValues(scopeFormValues(answer.defaults));
}

// The scope an environment's read applies and where it comes from: its own, else the server's
// configured snapshot scope (`defaults`, compact), else none → { scope, from: 'environment' | 'server' | null }.
// Kept for hosts that call it; the board no longer does — the server default never applies to an
// environment that exists (envScopeCell, formScopeOf below).
export function resolvedScope(own, defaults) {
  if (own && typeof own === 'object' && Object.keys(own).length) return { scope: own, from: 'environment' };
  if (defaults && typeof defaults === 'object' && Object.keys(defaults).length) return { scope: defaults, from: 'server' };
  return { scope: null, from: null };
}

// ---------- the server default, the save and the check of a live scope ----------
//
// The server's configured snapshot scope (OBSERVOGRAM_SNAPSHOT_*, GET /api/mcp/jobs) never applies
// to a service environment on its own: a Run reads the environment's own scope, else none. It
// pre-fills the form of a NEW environment, each field said "from the server default", and saved it
// is that environment's own. It is not pre-filled for a service whose environments read other
// metric prefixes, nor kept for one whose repository declares no metric it would read (the scope
// check, below); an environment that exists and has none opens empty, says so, and offers
// Use the server default.
export const SCOPE_DEFAULT_IGNORED = 'No live scope — the server default no longer applies here; set one';

const prefixesOf = (scope) => (Array.isArray(scope?.metricPrefixes) ? scope.metricPrefixes : []);
const sameSet = (a, b) => a.length === b.length && a.every((x) => b.includes(x));

// The pre-fill a new environment of `service` (null: a new service) opens with: { values } — the
// default's five answers — or { refused: { defaultPrefixes, servicePrefixes } } when the service's
// environments read other metric prefixes of their own, or null (no default). A default that names
// no metric prefixes cannot show it is this service's (SPEC P5: never pre-filled for a service whose
// prefixes differ from the default's) — its folders, rule groups and patterns are one service's — so
// it is never pre-filled: { refused: { defaultPrefixes: [], servicePrefixes: null, unprefixed: true } },
// and the form offers Use the server default instead.
export function scopePrefillOf(service, defaults) {
  if (!defaults || typeof defaults !== 'object' || !scopeFromValues(scopeFormValues(defaults))) return null;
  const dp = prefixesOf(defaults);
  if (!dp.length) return { refused: { defaultPrefixes: [], servicePrefixes: null, unprefixed: true } };
  const mine = (Array.isArray(service?.environments) ? service.environments : []).map((e) => prefixesOf(e?.liveScope)).filter((p) => p.length);
  if (mine.some((p) => !sameSet(p, dp))) return { refused: { defaultPrefixes: dp, servicePrefixes: [...new Set(mine.flat())] } };
  return { values: scopeFormValues(defaults) };
}

// The scope answers a form opens with, and what the form keeps about them: an environment that
// exists (`env`, with its liveScope) on its own scope, empty when it has none; a new one
// pre-filled (scopePrefillOf). → { values, from, form: { scopeFrom, scopePrefill, scopePrefillRefused, scopeCheck } }
export function formScopeOf(service, env, defaults) {
  if (env) {
    const own = env.liveScope && typeof env.liveScope === 'object' && Object.keys(env.liveScope).length ? env.liveScope : null;
    return { values: scopeFormValues(own), from: own ? 'environment' : null, form: { scopeFrom: own ? 'environment' : null, scopePrefill: null, scopePrefillRefused: null, scopeCheck: null } };
  }
  const prefill = scopePrefillOf(service, defaults);
  if (prefill?.values) return { values: prefill.values, from: 'server', form: { scopeFrom: 'server', scopePrefill: defaults, scopePrefillRefused: null, scopeCheck: null } };
  return { values: scopeFormValues(null), from: null, form: { scopeFrom: null, scopePrefill: null, scopePrefillRefused: prefill?.refused || null, scopeCheck: null } };
}

// Use the server default (an environment that exists, with none of its own): its five answers on
// the form, said "from the server default" — saved, they are the environment's own.
export function useServerDefaultScope(form) {
  if (!form?.open || !form.scopeDefaults) return form;
  return { ...form, values: { ...form.values, ...scopeFormValues(form.scopeDefaults) }, scopePrefill: form.scopeDefaults, scopePrefillRefused: null, scopeFrom: 'server', scopeCheck: null, error: null };
}

// The answers still holding the pre-fill that a save would NOT keep: all of them when the save
// would write over a scope the environment has of its own, or onto a record the form was not
// opened on (`known` false: a blank Add naming an existing service); all but the prefixes when
// the prefixes typed differ from the default's — a default that names none included, once any are
// typed (its rule groups, folders and patterns are another service's then); none otherwise.
function scopeDropped(values, { prefill, known = true, was = null }) {
  if (!prefill) return [];
  const pre = scopeFormValues(prefill);
  const held = SCOPE_FIELDS.filter((f) => pre[f.value] !== '' && String(values?.[f.value] ?? '') === pre[f.value]);
  if (!held.length) return [];
  if (!known || was) return held;
  const typed = scopeList(values?.scopePrefixes, 'comma');
  const preset = scopeList(pre.scopePrefixes, 'comma');
  return !sameSet(typed, preset) ? held.filter((f) => f.field !== 'metricPrefixes') : [];
}

// The scope a save keeps for an environment (savePlan): an untouched scope of its own as kept (a
// rule group with a comma, say, is never split by a save that did not touch it); else what is
// typed, less the pre-filled answers it must not keep (scopeDropped) — a scope typed equal to the
// server default IS saved: the default never applies on its own. Over a scope of its own, a
// pre-fill that leaves nothing typed keeps that scope (it is never cleared by answers not saved).
// Null for none.
export function scopeSaveOf(values, { was = null, prefill = null, known = true } = {}) {
  const untouched = was && SCOPE_FIELDS.every((f) => String(values?.[f.value] ?? '') === scopeFormValues(was)[f.value]);
  if (untouched) return was;
  const dropped = scopeDropped(values, { prefill, known, was });
  if (!dropped.length) return scopeFromValues(values);
  const kept = { ...values };
  for (const f of dropped) kept[f.value] = '';
  return scopeFromValues(kept) ?? (was || null);
}

// The matrix cell's live scope for an environment (serviceListModel): its own, said in a few words;
// none of its own while the server has a default — said so (`defaultIgnored`, the row's sentence:
// the default no longer applies); else none.
function envScopeCell(own, defaults) {
  if (own && typeof own === 'object' && Object.keys(own).length) return { text: scopeSummary(own), from: 'environment' };
  if (defaults && typeof defaults === 'object' && Object.keys(defaults).length) return { text: null, from: null, defaultIgnored: SCOPE_DEFAULT_IGNORED, defaultSummary: scopeSummary(defaults) };
  return null;
}

// The scope check (POST /api/services/:id/scope-check): what a scope would leave out, asked before
// it is saved. scopeCheckOf(form) → { serviceId, env, scope, key } — a service with a record, an
// environment named (one not added yet is checked against the service's own pack), an MCP
// endpoint and a scope typed — or null. The host sends it and hands the answer back with the key:
// an answer for another key (an older scope) is dropped.
export function scopeCheckOf(form) {
  if (!form?.open || form.chaosRun || form.objectives || form.agreement || form.targetsOnly || !Number.isInteger(form.serviceId)) return null;
  const v = form.values || {};
  const env = trimmed(v.env);
  if (!env || !v.endpointId || v.endpointId === LIVE_PACK) return null;
  const scope = scopeFromValues(v);
  if (!scope) return null;
  return { serviceId: form.serviceId, env, scope, key: JSON.stringify([form.serviceId, env, SCOPE_FIELDS.map((f) => scope[f.field] ?? null)]) };
}
export function scopeChecking(form, key) {
  return form?.open ? { ...form, scopeCheck: { state: 'checking', key, answer: null, error: null } } : form;
}
export function scopeCheckFailed(form, error, key) {
  if (!form?.open || form.scopeCheck?.key !== key) return form;
  return { ...form, scopeCheck: { state: 'failed', key, answer: null, error: sentenceOf(error) } };
}
// The answer, kept with when its live read was (`readAgo`, as `now` says it). A pre-fill whose
// prefixes no declared metric of the service carries is another service's: its answers still
// holding the default are cleared, and the form says why (scopePrefillRefused).
export function scopeChecked(form, answer, key, { now = Date.now() } = {}) {
  if (!form?.open || form.scopeCheck?.key !== key) return form;
  const readAt = answer?.live?.readAt;
  const check = { state: 'done', key, answer: answer && typeof answer === 'object' ? answer : null, error: null, readAgo: readAt ? agoText(readAt, now) : null };
  const metric = check.answer?.declared?.families?.find((x) => x.family === 'metric');
  const pre = form.scopePrefill ? scopeFormValues(form.scopePrefill) : null;
  if (pre && pre.scopePrefixes && String(form.values?.scopePrefixes ?? '') === pre.scopePrefixes && metric?.declared > 0 && metric.inside === 0) {
    const values = { ...form.values };
    for (const f of SCOPE_FIELDS) if (pre[f.value] !== '' && String(values[f.value] ?? '') === pre[f.value]) values[f.value] = '';
    return { ...form, values, scopePrefill: null, scopeFrom: null, scopeCheck: null, scopePrefillRefused: { defaultPrefixes: prefixesOf(form.scopePrefill), servicePrefixes: null, declared: metric.declared } };
  }
  return { ...form, scopeCheck: check };
}

const SCOPE_NOUNS = Object.freeze({ metric: ['metric', 'metrics'], dashboard: ['dashboard', 'dashboards'], alert_rule: ['alert rule', 'alert rules'], recording_rule: ['recording rule', 'recording rules'] });
const quotedList = (names) => names.map((n) => `"${n}"`).join(', ');
const shortList = (names) => (names.length > 6 ? `${names.slice(0, 6).join(', ')}, … (${names.length - 6} more)` : names.join(', '));

// The scope check's answer as the form words it (scopeModel's `check`), for a host that redraws only that.
export function scopeCheckView(form) {
  return form?.open ? scopeCheckModel(form, form.values || {}) : null;
}

// formModel's scope `check`: { state, warnings: [text], notes: [text] } as §5 of the design words them, or null.
function scopeCheckModel(form, v) {
  const c = form.scopeCheck;
  if (!c) return null;
  if (c.state === 'checking') return { state: 'checking', warnings: [], notes: ['Checking the scope…'] };
  if (c.state === 'failed') return { state: 'failed', warnings: [], notes: [`The scope could not be checked: ${c.error || 'no answer'}`] };
  const env = trimmed(v.env) || 'this environment';
  const scope = scopeFromValues(v) || {};
  const groups = Array.isArray(scope.ruleGroups) ? scope.ruleGroups : [];
  const warnings = [];
  const notes = [];
  const live = c.answer?.live || null;
  const ago = c.readAgo ? ` (${c.readAgo})` : '';
  if (groups.length) {
    if (!live) notes.push(`No live read of ${env} yet: Run it once to check the rule groups against live.`);
    else if (live.ruleGroups === null) notes.push(`The last live read of ${env}${ago} did not record its rule groups: Run it again to check them.`);
    else if (Array.isArray(live.foldersNotRead) && live.foldersNotRead.length) {
      notes.push(`The last live read of ${env} read only the folders ${shortList(live.folders || [])}: Run it with this scope once to check the rule groups of ${shortList(live.foldersNotRead)}.`);
    } else if (live.ruleGroupsKept && Number.isInteger(live.ruleGroupsKept.of) && Number.isInteger(live.ruleGroupsKept.kept)) {
      // The live read listed more rule groups than its record keeps: a group not among those kept may be there.
      const unlisted = groups.filter((g) => !(Array.isArray(live.ruleGroups) && live.ruleGroups.includes(g)));
      if (unlisted.length) notes.push(`The last live read of ${env}${ago} listed ${live.ruleGroupsKept.of} rule groups and kept the first ${live.ruleGroupsKept.kept}: ${quotedList(unlisted)} ${unlisted.length === 1 ? 'is' : 'are'} not among them, so whether ${unlisted.length === 1 ? 'it is' : 'they are'} there is not known.`);
    } else if (Array.isArray(live.missingGroups) && live.missingGroups.length) {
      const missing = live.missingGroups;
      const where = Array.isArray(scope.folderUids) && scope.folderUids.length ? ` in the folders ${shortList(scope.folderUids)}` : '';
      warnings.push(live.ruleGroups.length
        ? `Not in the last live read of ${env}${ago}: the rule group${missing.length === 1 ? '' : 's'} ${quotedList(missing)}. It listed ${shortList(live.ruleGroups)}${where}.`
        : `The last live read of ${env}${ago} listed no rule group${where}, so ${quotedList(missing)} ${missing.length === 1 ? 'is' : 'are'} not there.`);
    }
  }
  const declared = c.answer?.declared || null;
  if (!declared) notes.push(`No scan of ${form.values?.name ? trimmed(form.values.name) : 'this service'} in ${env} yet: Run it once to check this scope against what the repository declares.`);
  for (const x of declared?.families || []) {
    if (!(x.declared > 0) || x.inside > 0) continue;
    const [one, many] = SCOPE_NOUNS[x.family] || [x.family, `${x.family}s`];
    const noun = x.declared === 1 ? one : many;
    if (!x.unknown) warnings.push(`None of the ${x.declared} declared ${noun} is inside this scope: a Run would compare none of them.`);
    else {
      const what = x.family === 'dashboard' ? 'folder' : x.family === 'metric' ? 'name' : (Array.isArray(scope.folderUids) && scope.folderUids.length && groups.length ? 'folder or group' : groups.length ? 'group' : 'folder');
      // Those the repository files under a folder TITLE the live read gave no uid of (server/scope-check.mjs
      // byTitle): their place is not known, which is no fault of the repository's — said apart.
      const byTitle = Number.isInteger(x.byTitle) && x.byTitle > 0 ? Math.min(x.byTitle, x.unknown) : 0;
      const silent = x.unknown - byTitle;
      const parts = [];
      if (byTitle) {
        const titles = Array.isArray(x.titles) && x.titles.length ? ` (${quotedList(x.titles)})` : '';
        const folders = Array.isArray(x.untitledFolders) && x.untitledFolders.length ? x.untitledFolders : (Array.isArray(scope.folderUids) ? scope.folderUids : []);
        const read = live ? `the last live read of ${env}${ago} did not give the title of the folder${folders.length === 1 ? '' : 's'} ${shortList(folders)}` : `no live read of ${env} has given the titles of its folders yet`;
        parts.push(`${byTitle === x.declared ? 'they name' : `${byTitle} of them name`} their folder by its title only${titles}, and ${read}`);
      }
      if (silent) parts.push(`${silent} of them do not say which ${what} they are in`);
      if (x.outside) parts.push(`${x.outside} are outside`);
      const sentence = `None of the ${x.declared} declared ${noun} is known to be inside this scope: ${parts.join(byTitle ? '; ' : ', ')}.`;
      // Every one filed by a title alone, none outside: not known to be wrong — a note, not a warning.
      if (byTitle === x.unknown && !x.outside) notes.push(`${sentence} A Run with it compares those it finds in these folders; one it does not find reads not checked.`);
      else warnings.push(sentence);
    }
  }
  return { state: 'done', warnings, notes };
}
const KIND_LABEL = Object.fromEntries(REPOSITORY_KINDS.map((k) => [k.kind, k.label]));
// The org's repository sources (GET /api/repository-sources: { github, ado,
// path, upload }, a missing kind on; null when not read — every source on,
// and the server still refuses one switched off). A source switched off, in
// the server's words (server/service-admin.mjs WAYS.repositorySourceOff).
export const sourceOffText = (kind) => `${KIND_LABEL[kind] || kind} is switched off in Settings → Repository sources — an org admin can switch it back on`;
export const ALL_SOURCES_OFF = 'Every repository source is switched off in Settings → Repository sources — an org admin can switch one on.';
const sourceOff = (sources, kind) => !!sources && typeof sources === 'object' && sources[kind === 'pack' ? 'upload' : kind] === false;
export const NEW_ENDPOINT = 'new';

const lastSegments = (p, n) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).slice(-n).join('/');
const decoded = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The repository as one short line ({ kind, kindText, text, ref, detail, title }), or null.
// An upload's second line is when it came and how much (`now` dates it).
export function repositoryLine(repository, { now = Date.now() } = {}) {
  if (!repository || typeof repository !== 'object' || !repository.location) return null;
  const { kind, location, ref = null } = repository;
  if (kind === 'pack') {
    const ago = repository.uploadedAt ? agoText(repository.uploadedAt, now) : '';
    return { kind, kindText: KIND_LABEL[kind], text: location, ref: null, detail: ago ? `uploaded ${ago}` : 'uploaded', title: repository.uploadedAt ? `${location}, uploaded ${repository.uploadedAt}` : location };
  }
  if (kind === 'upload') {
    const ago = repository.uploadedAt ? agoText(repository.uploadedAt, now) : '';
    const count = Number.isFinite(repository.files) ? `${repository.files} file${repository.files === 1 ? '' : 's'}` : '';
    const detail = [ago ? `uploaded ${ago}` : 'uploaded', count].filter(Boolean).join(' · ');
    return { kind, kindText: KIND_LABEL[kind], text: location, ref: null, detail, title: repository.uploadedAt ? `${location}, uploaded ${repository.uploadedAt}` : location };
  }
  let text = location;
  if (kind === 'github') text = lastSegments(location, 2);
  else if (kind === 'ado') {
    const m = /\/([^/]+)\/_git\/([^/?#]+)/.exec(location);
    text = m ? `${decoded(m[1])}/${decoded(m[2])}` : location;
  } else if (kind === 'path') text = lastSegments(location, 1) || location;
  // A folder's second line is where it is; a remote one's, its branch.
  const detail = kind === 'path' ? location : (ref || null);
  return { kind, kindText: KIND_LABEL[kind] || String(kind || ''), text, ref: ref || null, detail, title: ref ? `${location} (${ref})` : location };
}

// The last check of a row, from the journeys listing's lastRun: never,
// unreachable (the live side did not answer), or checked — the grade letter
// the score earns and how much matches live (numbers; the renderer writes
// the sign).
// `off`: the criteria the service is not graded on now (its record's gradeOff);
// `aside`: the name of its set-asides that hold now (serviceAsideKey).
// A letter scored under another grade schema (the listing's lastRun.gradeSchema) says so too.
// A row has no grade to ask whether the targets count now. A run that counted targets differs from a
// service with other targets or none (the board always grades it again then); a run that names none
// (before any were set, or its Calibrated did not read them) is not flagged — only a grade can tell.
const targetsDiffer = (runTargets, targets) => {
  const was = targetsTermKey(runTargets ?? null);
  return !!was && was !== (targets || '');
};
// The same for the stated SLO objectives a run counted (the listing's lastRun.objectives, their key):
// the service's own for those SLOs now read otherwise, or are gone.
const objectivesDiffer = (was, objectives) => {
  if (typeof was !== 'string' || !was) return false;
  return objectivesTermKey(objectives ?? null, was.split(';').map((p) => p.slice(0, p.lastIndexOf('=')))) !== was;
};
// The row's five states (the listing's lastRun is the newest run that is not a stopped Run; its
// facts are tools/lib/run-basis.mjs basisSummary's — an older server's listing has none, and its
// row reads as before):
//   never        no run                       label 'Not checked yet'
//   unreachable  the live side gave nothing   label 'Live did not answer' (reason: its first probe
//                                             error) or 'Live returned no data'; no letter; the gate failed
//   nothing      nothing was compared         label 'Nothing compared', reason the first that holds
//   partial      a match, live answered in part or the scan lost files: the figure, and what was
//                not read beside it (reason)
//   checked      the figure; files the scan did not read (its caps) beside it
// → { state, word, ago, letter, tone, gradeLabel?, alignmentPct, gate, label, reason, notes, when }
//   label   the cell's words in place of the figure ('' when the figure is the words)
//   notes   [{ text, tone }]: a Run that stopped since, the files a surface filter excluded (a
//           warning past half), not comparable with the check before
// No figure without a comparison; a gate never passes over nothing.
const stoppedNoteOf = (journey) => (journey?.stoppedRun && typeof journey.stoppedRun === 'object' ? stoppedNote(journey.stoppedRun) : '');
function lastCheckNotes(journey, last) {
  const notes = [];
  const stopped = stoppedNoteOf(journey);
  if (stopped) notes.push({ text: stopped, tone: 'warn' });
  const f = last?.scan?.filter;
  const excluded = countOf(f?.excluded);
  if (f && excluded) {
    // The surface by its words (surfaceLabel: 'Kubernetes and Helm'), never its id or an environment's name.
    const said = `${excluded} ${excluded === 1 ? 'file' : 'files'} excluded by the ${surfaceLabel(f.surface)} filter`;
    notes.push(last.scan.excludedMost === true ? { text: `${said} — more than half of the files the scan recognised`, tone: 'warn' } : { text: said, tone: 'neutral' });
  }
  if (last?.comparable && last.comparable.withPrevious === false) {
    notes.push({ text: `Not comparable with the check before${typeof last.comparable.reason === 'string' && last.comparable.reason ? `: ${last.comparable.reason}` : ''}`, tone: 'warn' });
  }
  // Stored exclude patterns the last read went without (the listing's scopeNotApplied): the read was wider
  // than the scope the service keeps, and the check says so until the patterns change.
  const skipped = countOf(last?.scopeNotApplied);
  if (skipped) notes.push({ text: `${skipped} stored exclude ${skipped === 1 ? 'pattern' : 'patterns'} not applied — may be too slow to match; change ${skipped === 1 ? 'it' : 'them'} in the live scope`, tone: 'warn' });
  return notes;
}
function lastCheckOf(journey, now, off = [], aside = '', targets = '', objectives = null) {
  const last = journey?.lastRun || null;
  const notes = lastCheckNotes(journey, last);
  if (!last) return { state: 'never', word: OVERVIEW_STATUS.never, ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null, label: 'Not checked yet', reason: '', notes, when: '' };
  const ago = agoText(last.startedAt, now);
  const reading = readingOutcome(last);
  // A stopped Run as the last run (a listing that names one): it compared nothing.
  if (reading === 'scan-partial') {
    return { state: 'nothing', word: OVERVIEW_STATUS.nothing, ago, letter: null, tone: 'neutral', alignmentPct: null, gate: null, label: OVERVIEW_STATUS.nothing, reason: scanPartialReading(last.scan), notes, when: ago ? `Tried ${ago}` : '' };
  }
  if (reading === 'vantage-lost' || reading === 'error') {
    const error = typeof last.firstProbeError === 'string' && last.firstProbeError ? last.firstProbeError : '';
    return {
      state: 'unreachable', word: OVERVIEW_STATUS.unreachable, ago, letter: null, tone: 'warn', alignmentPct: null,
      gate: reading === 'vantage-lost' ? 'fail' : null,
      label: !error && last.liveLoss === 'no-data' ? 'Live returned no data' : 'Live did not answer', reason: error, notes, when: ago ? `Tried ${ago}` : '',
    };
  }
  const score = Number.isFinite(last.gradeScore) ? last.gradeScore : null;
  const ig = score === null ? null : instrumentGradeFor(score);
  // A letter over fewer criteria (the service's switches at that run) says so where it is named.
  const offCount = gradeOffKeys(last.gradeOff).length;
  const over = ig && offCount ? ` · on ${GRADE_CRITERIA.length - offCount} of ${GRADE_CRITERIA.length} criteria` : '';
  // A letter graded on other criteria than the service's now, or leaving out other differences, says so:
  // the board grades it again.
  const lastAside = typeof last.setAside?.fingerprint === 'string' ? last.setAside.fingerprint : '';
  const before = !ig ? ''
    : otherSchema(last.gradeSchema) ? ' · graded before the grade changed how it scores'
    : offKey(last.gradeOff) !== offKey(off) ? " · graded before this service's criteria changed"
      : lastAside !== (aside || '') ? " · graded before this service's set-asides changed"
        : targetsDiffer(last.targets, targets) ? " · graded before this service's targets changed"
          : objectivesDiffer(last.objectives, objectives) ? " · graded before this service's objectives changed" : '';
  const lastAsideN = (Number(last.setAside?.declared) || 0) + (Number(last.setAside?.live) || 0);
  const asideSaid = ig && lastAsideN && !before ? ` · ${lastAsideN} set aside` : '';
  // How much it compared: the listing's count (null from an older server, which is read as before).
  const compared = countOf(last.compared);
  const alignmentPct = compared === 0 ? null : (Number.isFinite(last.alignmentPct) ? last.alignmentPct : null);
  const graded = {
    ago, letter: ig ? ig.letter : null, tone: ig ? (GRADE_TONE[ig.tier] || 'neutral') : 'neutral', gradeLabel: ig ? `${shortGradeLabel(ig)}${over}${asideSaid}${before}` : '',
    alignmentPct,
    gate: last.outcome === 'gate-failed' ? 'fail' : (last.outcome === 'pass' && compared !== 0 ? 'pass' : null),
  };
  const facts = { notReadLive: last.notReadLive, probesFailed: last.probesFailed, scan: last.scan, scoped: last.scoped, setAsideCount: last.setAsideCount };
  const when = ago ? `Checked ${ago}` : '';
  if (compared === 0) {
    return { state: 'nothing', word: OVERVIEW_STATUS.nothing, ...graded, label: OVERVIEW_STATUS.nothing, reason: nothingReason(facts), notes, when };
  }
  const vantage = vantageOf(last);
  const partial = vantage === 'partial' || last.scan?.partial === true;
  return {
    state: partial ? 'partial' : 'checked', word: ago ? `Checked${partial ? ' (partial)' : ''} ${ago}` : `Checked${partial ? ' (partial)' : ''}`, ...graded,
    label: alignmentPct === null ? 'Match not known' : '', reason: partialParts(facts, vantage).join(' · '), notes, when,
  };
}

export const rowKey = (serviceId, env) => `${serviceId}:${env ?? ''}`;

// The Run's toast, as facts (overview-view.mjs runToastText writes the words and the signs): what the
// scan read, the live read's scope, the grade where one exists, the match only over a comparison, and
// what the reading leaves out. `row`: the list row ({ name, env, repository }); `answer`: POST
// /api/services/:id/run's 200 body ({ record, scan }).
//   → { head, read, scoped, notApplied, letter, pct, nothing, unreachable, livePart, notComparable, filterWarn, tone }
//   tone  'ok' only for a whole reading: nothing lost or capped by the scan, something compared, the
//         live side whole, comparable with the check before, no filter warning; else ''
export function runToastModel(row, answer) {
  const record = isPlain(answer?.record) ? answer.record : null;
  const scan = isPlain(answer?.scan) ? answer.scan : null;
  const of = scan && Number(scan.candidates) > Number(scan.files) ? ` of ${scan.candidates}` : '';
  const loss = scanLossText(scan);
  const read = scan
    ? `${scan.files ?? '?'}${of} files from ${scan.source || 'the repository'}${loss ? ` (${loss})` : ''}${scan.partial === true ? ' — a partial scan' : ''}`
    : `the pack file${row?.repository?.text ? ` ${row.repository.text}` : ''}`;
  const vantage = vantageOf(record);
  const lost = vantage === 'lost';
  const gone = lost ? liveLossOf(record) : null;
  const failed = namesOf(record?.probes?.failed) || [];
  const s = scanFactsOf(scan);
  const filterWarn = s?.excludedMost ? `the ${surfaceLabel(s.filter?.surface)} filter excluded more than half of the files the scan recognised` : '';
  const nothing = comparedOf(record?.drift) === 0;
  const notComparable = record?.comparable?.withPrevious === false;
  // A stored exclude pattern the read went without (packB.notApplied, one sentence each): said, so the
  // scope the toast names is the one applied and nobody takes the wider read for the narrow one.
  const skipped = Array.isArray(record?.packB?.notApplied) ? record.packB.notApplied.length : 0;
  return {
    head: `${row?.name ?? '?'} · ${row?.env ?? '?'} checked`,
    read,
    scoped: record?.packB?.liveScope ? `live read scoped to ${scopeSummary(record.packB.liveScope)}` : '',
    notApplied: skipped ? `${skipped} stored exclude pattern${skipped === 1 ? '' : 's'} not applied (may be too slow to match; change ${skipped === 1 ? 'it' : 'them'} in the service's live scope)` : '',
    letter: !lost && typeof record?.grade?.letter === 'string' && record.grade.letter ? record.grade.letter : null,
    pct: matchPctOf(record),
    nothing,
    unreachable: lost ? (gone.error ? `live did not answer — ${gone.error}` : gone.cause === 'no-data' ? 'live returned no data' : 'live did not answer') : '',
    livePart: vantage === 'partial' ? (failed.length ? `live answered in part (its ${listWords(inProbeOrder(failed).map(familyWord))} not read)` : 'live answered in part') : '',
    notComparable,
    filterWarn,
    tone: !loss && scan?.partial !== true && !nothing && !lost && vantage !== 'partial' && !notComparable && !filterWarn && !skipped ? 'ok' : '',
  };
}

// A Run the server answered with an error but recorded (502: the live side gave nothing; 409: the scan
// lost files and the Run stopped): what the refreshed listing says of it; else, when the listing does
// not show it, what the answer itself said — the 502's `outcome` 'vantage-lost' (its body's: the loss
// was recorded) with `error`, the server's sentence, or the 409's `outcome` 'scan-partial' with its
// scan (`unlisted: true`: the row's cell is not its reading yet); else null (nothing says this Run
// was recorded: it did not finish). `before` / `after`: the
// row's journeys-listing entry before the Run and after it (null when there was none). `scan` and
// `kept`: a 409's own (services-api.mjs servicesRefusal — what the stopped Run's scan read, and the
// scan the service keeps, { id, label } or null): whether a complete scan is kept is the 409's answer
// where it gives one, else the listing's; a stop the listing does not show yet (a first Run that kept
// none saves no check) is said from the 409's scan.
//   → { text, tone: 'error', unlisted? } | null (the toast's own tones: 'ok' · 'error' · '')
export function runRecordedToast({ name = '?', env = '?', before = null, after = null, outcome = null, error = '', scan = null, kept = undefined } = {}) {
  const newer = (a, b) => isPlain(a) && typeof a.startedAt === 'string' && a.startedAt !== (isPlain(b) ? b.startedAt : undefined);
  const head = `${name} · ${env}`;
  const keptOf = (listed) => (kept !== undefined ? !!kept : listed?.kept !== false);
  if (isPlain(after) && newer(after.stoppedRun, before?.stoppedRun)) return { text: `${head}: ${scanPartialReading(after.stoppedRun, { kept: keptOf(after.stoppedRun) })}.`, tone: 'error' };
  if (isPlain(after) && newer(after.lastRun, before?.lastRun) && readingOutcome(after.lastRun) === 'vantage-lost') {
    const first = typeof after.lastRun.firstProbeError === 'string' && after.lastRun.firstProbeError ? after.lastRun.firstProbeError : '';
    return { text: `${head}: ${first ? `Live did not answer — ${first}` : after.lastRun.liveLoss === 'no-data' ? 'Live returned no data' : 'Live did not answer'}.`, tone: 'error' };
  }
  if (outcome === 'vantage-lost') {
    const said = safeErrorText(String(error ?? '').replace(/^\d{3}: /, ''));
    return { text: `${head}: ${OVERVIEW_STATUS.unreachable} — ${said || 'the run is recorded'}.`, tone: 'error', unlisted: true };
  }
  if (outcome === 'scan-partial') return { text: `${head}: ${scanPartialReading(isPlain(scan) ? scan : null, { kept: keptOf(null) })}.`, tone: 'error', unlisted: true };
  return null;
}

// serviceListModel({ services, servicesStatus, catalog, isLiveAggregatePack, journeys, journeysError,
//   endpoints, access, now, running, results, showAll, heldTokens, repoSignIn })
//   running   { [rowKey]: true } — the rows whose Run is under way
//   results   { [rowKey]: { error, repoAuth } } — the last Run's refusal, the server's sentence;
//             repoAuth ({ kind, label, refused }) when its host wants the person's own token
//   showAll   also list the services nobody gave a repository that have no pack of their own
//             (the ones a live draft discovered): counted, not drawn, until asked
//   heldTokens  the hosts ('github' | 'ado') whose token the person gave in this tab (the host
//             keeps it, in memory only, and sends it with each Run of that host's repositories)
//   repoSignIn  /auth/me's `repoSignIn` ({ github: { available, signedIn, account }, ado: … }): the
//             hosts this person may sign in to here and the ones they are signed in to. A host that
//             passes it draws Sign in to … and Sign out of … (hooks signInRepoHost, signOutRepoHost);
//             one that passes none draws neither
// → { kind: 'loading' | 'error' | 'list', error, rows, hidden, canWrite, reason, empty, tokens, accounts }
//   a row's `auth` is where the person gives their own token: { kind, label, refused, text },
//   and `signIn` ({ kind, label }) when the host offers sign-in here. It is there from the
//   start (`offered: true`) on every row a Run of which may need one — a GitHub or Azure
//   DevOps repository, no token of that host held in this tab, the person not signed in to
//   the host — so nobody has to fail a Run to be asked; after a refusal it says what the
//   host answered (authAsk). A row whose last scan read this repository with no access of
//   the person's (the journeys listing's lastRun.repositoryAccess: none at all, or the
//   server's own) is offered none: there is nothing to give
//   accounts  the hosts the person is signed in to: { kind, host, account, text }
export function serviceListModel(input = {}) {
  const {
    services = null, servicesStatus = null, catalog = [], isLiveAggregatePack = () => false,
    journeys = null, journeysError = null, endpoints = null, access = null, now = Date.now(),
    running = {}, results = {}, showAll = false, heldTokens = [], repoSignIn = null, sources = null,
    // The server's configured snapshot scope (GET /api/mcp/jobs's scope.defaults, compact), or null.
    liveScopeDefaults = null,
    // Each service's agreement against its repository (overview-api.mjs loadAgreementFacts), by id; null on a host that reads none.
    agreements = null,
  } = input;
  const canWrite = access?.canWrite !== false;
  const reason = canWrite ? null : (access?.reason || 'Not available for your role here.');
  const tokens = (Array.isArray(heldTokens) ? heldTokens : []).filter((k) => HOST_LABEL[k]).map((k) => ({ kind: k, label: `${HOST_LABEL[k]} token`, text: `Your ${HOST_LABEL[k]} token is sent with this tab's Runs of ${HOST_LABEL[k]} repositories; it is never kept on the server.` }));
  const signIn = repoSignIn && typeof repoSignIn === 'object' ? repoSignIn : null;
  const held = (Array.isArray(heldTokens) ? heldTokens : []).filter((k) => HOST_LABEL[k]);
  const accounts = signIn ? Object.keys(HOST_LABEL).filter((k) => signIn[k]?.signedIn === true).map((k) => {
    const account = typeof signIn[k].account === 'string' && signIn[k].account ? signIn[k].account : null;
    return { kind: k, host: HOST_LABEL[k], account, text: `Signed in to ${HOST_LABEL[k]}${account ? ` as ${account}` : ''}: your Runs of ${HOST_LABEL[k]} repositories read as that account in this browser.` };
  }) : [];
  if (!Array.isArray(services)) {
    const failed = !!servicesStatus && !['ok', 'loading'].includes(servicesStatus.kind);
    return { kind: failed ? 'error' : 'loading', error: failed ? (servicesStatus.error || 'the services table could not be read') : null, rows: [], hidden: 0, canWrite, reason, empty: false, tokens, accounts };
  }
  const endpointById = new Map((Array.isArray(endpoints) ? endpoints : []).map((e) => [e.id, e]));
  const listed = [];
  let hidden = 0;
  for (const s of services) {
    if (!s) continue;
    const { pack, how } = packForService(s, catalog, { isLiveAggregatePack });
    const ownPack = how === 'primary';
    if (!showAll && !s.repository && !ownPack) { hidden += 1; continue; }
    const line = repositoryLine(s.repository, { now });
    // A repository whose source is switched off keeps its record; its Run waits for the switch.
    const off = !!line && sourceOff(sources, s.repository.kind);
    const repository = line && off ? { ...line, off: true } : line;
    const envs = Array.isArray(s.environments) && s.environments.length ? s.environments : [null];
    for (const env of envs) {
      const key = rowKey(s.id, env?.name ?? null);
      const ep = env?.mcpEndpoint ? (endpointById.get(env.mcpEndpoint.id) || env.mcpEndpoint) : null;
      const live = ep ? { id: ep.id, name: ep.name, origin: ep.origin || '' } : null;
      // The export of live uploaded in place of the endpoint (one or the other): its file and when.
      const exported = env?.livePack && typeof env.livePack.name === 'string' ? { name: env.livePack.name, ago: env.livePack.uploadedAt ? agoText(env.livePack.uploadedAt, now) : '' } : null;
      const journey = journeysError ? null : journeyForService(journeys, { slug: s.slug, env: env?.name ?? null, packId: pack?.id || null });
      const last = journeysError
        ? { state: 'unknown', word: 'Not known', ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null }
        : lastCheckOf(journey, now, s.gradeOff, serviceAsideKey(s, now), serviceTargetsKey(s), s.objectives ?? null);
      const busy = !!running[key];
      let why = reason;
      if (!why && !env) why = `Add an environment to ${s.name} first.`;
      else if (!why && !repository) why = `Say where ${s.name}'s repository is first.`;
      else if (!why && off) why = `${sourceOffText(s.repository.kind)}.`;
      else if (!why && !live && !exported) why = `Choose the live MCP endpoint for ${env.name}, or upload an export of live, first.`;
      // The branch this environment's Run reads (a GitHub or Azure DevOps repository): its own, else the repository's.
      const remoteRepo = s.repository?.kind === 'github' || s.repository?.kind === 'ado';
      const ownRef = env ? ownRefOf(s, env.name) : null;
      const branch = remoteRepo ? { name: ownRef || s.repository.ref || null, own: !!ownRef } : null;
      // The deployment surface this environment reads alone ({ id, label }), or null: every file.
      const surfaceId = env ? ownSurfaceOf({ envSurfaces: s.envSurfaces }, env.name) : '';
      listed.push({
        key, serviceId: s.id, name: s.name, slug: s.slug, env: env?.name ?? null, envId: env?.id ?? null,
        repository, live, livePack: exported, last, journey: journey?.name || null, branch,
        agreement: agreements ? agreementCell(s, agreements[s.id] ?? null, { canWrite }) : null,
        surface: surfaceId ? { id: surfaceId, label: surfaceLabel(surfaceId) } : null,
        // The scope its live read applies (an MCP read): { text: '2 prefixes, 5 folders', from: 'environment' }; none of its
        // own while the server has a default: { text: null, from: null, defaultIgnored, defaultSummary }; else null.
        // The server default never applies to it: none of its own is said as such (`defaultIgnored`) while one is configured.
        scope: live && !exported ? envScopeCell(env?.liveScope ?? null, liveScopeDefaults) : null,
        run: { enabled: !why && !busy, reason: why, running: busy },
        open: { enabled: ownPack || !!journey },
        error: results[key]?.error || null,
        // What the host answered the last Run, else the offer a row that can run starts with.
        auth: authAsk(results[key]?.repoAuth, canWrite, signIn) || (!why && !busy ? authOffer(s.repository, { canWrite, repoSignIn: signIn, held, lastAccess: journey?.lastRun?.repositoryAccess || null }) : null),
        complete: !!(env && repository && (live || exported)),
      });
    }
  }
  // The rows a person can run first, then the ones still missing a place; by name, then environment.
  listed.sort((a, b) => (Number(b.complete) - Number(a.complete)) || String(a.name).localeCompare(String(b.name)) || String(a.env || '').localeCompare(String(b.env || '')));
  // The same rows as a matrix (serviceMatrix): what the list draws.
  return { kind: 'list', error: null, rows: listed, matrix: serviceMatrix({ kind: 'list', rows: listed }), hidden, canWrite, reason, empty: listed.length === 0, tokens, accounts };
}

// ---------- the service list as a matrix ----------
//
// One row per service, a column per environment, in the order a release
// travels — dev, test, acceptance, staging, production — whatever order they
// were declared in; a name none of those is goes after them, by name. Each
// cell is the list's row for that service and environment (its endpoint, its
// branch, its grade and last check, Run and Open); a service that does not
// declare a column's environment has none there.
const ENV_ORDER = [
  /^(dev|devel|develop|development|local|sandbox)$/,
  /^(test|testing|qa|sit|int|integration)$/,
  /^(uat|acc|acceptance)$/,
  /^(stg|stage|staging|preprod|pre-prod|perf)$/,
  /^(prd|prod|production|live)$/,
];
export function envRank(name) {
  const n = String(name || '').trim().toLowerCase();
  const i = ENV_ORDER.findIndex((re) => re.test(n));
  return i < 0 ? ENV_ORDER.length : i;
}

// serviceMatrix(list) → { columns, services, legend } | null — `list` is serviceListModel's
// (kind 'list'); columns the environments in release order; each service { serviceId, name, slug,
// repository, cells: { [env]: row }, bare (its row when it declares no environment, else null),
// rows, complete, runAll: { keys, running } } — runAll's keys the rows that can run now, in the
// columns' order; legend the grade's letters, best first, each with the score it starts at
// (`from`, a number: the renderer writes the sign; `above` when the score must exceed it) — the
// last starts at 0 and reads as below the one before it.
export function serviceMatrix(list) {
  if (!list || list.kind !== 'list') return null;
  const byOrder = (a, b) => (envRank(a) - envRank(b)) || String(a).localeCompare(String(b));
  const columns = [...new Set(list.rows.map((r) => r.env).filter((e) => typeof e === 'string' && e))].sort(byOrder);
  const services = new Map();
  for (const r of list.rows) {
    let svc = services.get(r.serviceId);
    if (!svc) {
      svc = { serviceId: r.serviceId, name: r.name, slug: r.slug, repository: r.repository, agreement: r.agreement ?? null, cells: {}, bare: null, rows: [] };
      services.set(r.serviceId, svc);
    }
    if (r.env) svc.cells[r.env] = r; else svc.bare = r;
    svc.rows.push(r);
  }
  const out = [...services.values()].map((svc) => {
    const ordered = columns.map((c) => svc.cells[c]).filter(Boolean);
    return {
      ...svc,
      complete: svc.rows.some((r) => r.complete),
      runAll: { keys: ordered.filter((r) => r.run.enabled).map((r) => r.key), running: ordered.some((r) => r.run.running) },
    };
  });
  // The services a person can run first, then the ones still missing a place; by name.
  out.sort((a, b) => (Number(b.complete) - Number(a.complete)) || String(a.name).localeCompare(String(b.name)));
  const legend = INSTRUMENT_GRADE_SCALE.filter((g) => g.minPct !== null).map((g) => ({ letter: g.letter, from: g.minPct, above: !!g.exclusiveMin, tone: GRADE_TONE[g.tier] || 'neutral' }));
  // The Agreement column is drawn where the host reads agreements (each row then carries its cell).
  return { columns, services: out, legend, ...(out.some((s) => s.agreement) ? { agreements: true } : {}) };
}

// The repository hosts whose token a person gives as their own.
const HOST_LABEL = Object.freeze({ github: 'GitHub', ado: 'Azure DevOps' });

// A Run its host would not read without the person's own token: what to ask.
// Signing in to the host is offered when the host (the server's answer, or
// /auth/me) offers it and the page passed `repoSignIn`.
function authAsk(need, canWrite, repoSignIn = null) {
  if (!canWrite || !need || typeof need !== 'object' || !HOST_LABEL[need.kind]) return null;
  const host = HOST_LABEL[need.kind];
  // `signIn: false` from the server: this repository's host takes no sign-in (an Azure DevOps Server).
  const offered = !!repoSignIn && need.signIn !== false && (need.signIn === true || repoSignIn[need.kind]?.available === true);
  const signIn = offered ? { kind: need.kind, label: `Sign in to ${host}` } : null;
  let text;
  if (need.via === 'sign-in') {
    text = need.expired
      ? `Your ${host} sign-in has ended. Sign in to ${host} again, or give your own token.`
      : `You are signed in to ${host}${need.account ? ` as ${need.account}` : ''}, and that account cannot read this repository. Sign in as one that can, or give a token that can.`;
  } else if (need.refused) {
    text = `That ${host} token was refused, or cannot read this repository. Give one that can.${signIn ? ` Or sign in to ${host}.` : ''}`;
  } else {
    text = signIn
      ? `${host} shows this repository only to someone who can read it. Sign in to ${host} to run it as you, or give your own token: it is sent with this tab's Runs only and never kept on the server.`
      : `${host} reads this repository with your own token. It is sent with this tab's Runs only and never kept on the server.`;
  }
  return { kind: need.kind, label: `${host} token`, refused: need.refused === true, text, ...(signIn ? { signIn } : {}) };
}

// The person's own token, offered on the row before any Run: a repository on
// GitHub or Azure DevOps that this tab holds no token for and that no sign-in
// to the host reads. A Run that would need one no longer has to fail first,
// and a page read again (the tab's memory is all that holds a token) shows
// the field where the token goes, not an error. A public GitHub repository
// needs none, and the note says so: Run reads it as before, the field empty.
// The Azure DevOps sign-in reads Azure DevOps Services only, so a repository
// on another host is offered the token alone — also to a person signed in to
// Azure DevOps, whose sign-in does not read it.
//   lastAccess  how the last scan read a repository ({ by, kind, location }:
//               the journeys listing's lastRun.repositoryAccess). When it read
//               this very one with no access of the person's — 'none', a
//               public repository, or 'server', the server's own on a server
//               without sign-in — the row is offered nothing. A repository
//               that stops being readable that way answers its next Run with
//               the ask (authAsk), as every row did before the offer.
//   blankTakesSignIn  the form, where the address is still to be typed: an
//               Azure DevOps address not given yet is offered the sign-in.
const ADO_SERVICES = /^https:\/\/(?:dev\.azure\.com|[a-z0-9-]+\.visualstudio\.com)(?:[/:?#]|$)/i;
const READ_WITHOUT_THE_PERSON = ['none', 'server'];
function authOffer(repository, { canWrite = true, repoSignIn = null, held = [], lastAccess = null, blankTakesSignIn = false } = {}) {
  const kind = repository?.kind;
  if (!canWrite || !HOST_LABEL[kind] || held.includes(kind)) return null;
  if (lastAccess && READ_WITHOUT_THE_PERSON.includes(lastAccess.by) && lastAccess.kind === kind && lastAccess.location === repository.location) return null;
  const location = String(repository.location ?? '').trim();
  const takesSignIn = kind !== 'ado' || ADO_SERVICES.test(location) || (blankTakesSignIn && !location);
  const s = repoSignIn ? repoSignIn[kind] : null;
  if (s?.signedIn === true && takesSignIn) return null;   // read as that account: nothing to give
  const host = HOST_LABEL[kind];
  const signIn = s?.available === true && takesSignIn ? { kind, label: `Sign in to ${host}` } : null;
  const kept = 'sent with this tab\'s Runs only and never kept on the server';
  let text;
  if (kind === 'ado') {
    text = signIn
      ? `Azure DevOps reads this repository as you: sign in to Azure DevOps, or give your own token (Code (Read)) — ${kept}.`
      : `Azure DevOps reads this repository with your own token (Code (Read)) — ${kept}.`;
  } else {
    text = signIn
      ? `A private repository reads as you: sign in to GitHub, or give your own token — ${kept}. A public one needs neither.`
      : `A private repository reads with your own GitHub token — ${kept}. A public one needs none.`;
  }
  return { kind, label: `${host} token`, refused: false, offered: true, text, ...(signIn ? { signIn } : {}) };
}

// A repository kind's hint on this server: a host that offers sign-in (and
// the person signed in to this studio, which is when the page passes
// `repoSignIn`) is named with it — the hint never mentions only a token where
// Sign in is the first way offered. Both are in the form (formAuth) and on
// the service's row. A person already signed in is told as whom; an Azure
// DevOps repository off Azure DevOps Services still takes their own token.
function repositoryHint(kind, repoSignIn) {
  const host = HOST_LABEL[kind.kind];
  const s = host && repoSignIn && typeof repoSignIn === 'object' ? repoSignIn[kind.kind] : null;
  if (!s || s.available !== true) return kind.hint;
  if (s.signedIn) {
    const as = s.account ? ` as ${s.account}` : '';
    return kind.kind === 'github'
      ? `A public repository, or a private one read as you: you are signed in to GitHub${as}.`
      : `Read as you: you are signed in to Azure DevOps${as}. A repository on another Azure DevOps host takes your own token (Code (Read)).`;
  }
  return kind.kind === 'github'
    ? 'A public repository, or a private one read as you: sign in to GitHub, or give your own GitHub token.'
    : 'Read as you: sign in to Azure DevOps, or give your own token (Code (Read)).';
}

// The person's own token, in the form: the field a row would offer
// (authOffer) is in the form too, so the first Save and run of a private
// repository reads it and no Run has to fail to be asked. Opt-in: only a host
// that passes `heldTokens` — it keeps the person's tokens, and its
// saveService takes what the field holds (`repoAuth`) — draws it. Never where
// a row would offer none: a folder, an upload, a source switched off, a token
// of that host already held in the tab, the person signed in to the host, a
// reader who cannot save. GitHub's is marked optional: a public repository
// needs none. Where the host offers sign-in here (`repoSignIn`), `signIn`
// ({ kind, label }) comes first, as on the row: the view calls
// signInRepoHost(kind, null, { fromForm: true }), and the form's answers
// outlive a sign-in that takes this tab to the host's page (formDraft, below).
function formAuth(v, { canWrite = true, repoSignIn = null, heldTokens = null, sources = null } = {}) {
  if (!Array.isArray(heldTokens) || sourceOff(sources, v.kind)) return null;
  const offer = authOffer({ kind: v.kind, location: v.location }, { canWrite, repoSignIn: repoSignIn && typeof repoSignIn === 'object' ? repoSignIn : null, held: heldTokens, blankTakesSignIn: true });
  if (!offer) return null;
  const host = HOST_LABEL[offer.kind];
  const optional = offer.kind === 'github';
  let text;
  if (offer.signIn) {
    text = `${optional ? 'For a private repository: sign' : 'Sign'} in to ${host} to read it as you, or give your own token — sent with this tab's Runs only and never kept on the server.`;
  } else {
    text = `${optional ? 'For a private repository. ' : ''}Sent with this tab's Runs only and never kept on the server.`;
  }
  return { kind: offer.kind, label: offer.label, optional, text, ...(offer.signIn ? { signIn: offer.signIn } : {}) };
}

// ---------- the Add a service form ----------
//
// The form's state is the host's: { open, mode: 'add' | 'edit', serviceId, envFixed, values, saving,
// error }. `values` = { name, env, kind, location, ref, endpointId, epName, epUrl, epToken };
// endpointId is an endpoint's id, NEW_ENDPOINT for one registered with the form, or ''.
// The person's own token is never one of them: its field is the view's, read when Save is
// pressed and handed to saveService, so nothing typed there is written into the markup.

export const FORM_CLOSED = Object.freeze({ open: false });

// The form opened: blank (add), or a row's service and environment (edit).
// A new form opens on the first source switched on (`sources`, as serviceListModel takes it).
// `pick`: the service's own Change (the matrix's row), not one environment's — a service in two or
// more environments opens with the environment as a choice (`envChoices`, in release order), on
// `env` or the first; choosing another loads that environment's endpoint and branch (formInput).
// `addEnv`: Add environment on the service's row — its form with the environment to name (empty),
// the service's own answers kept; the save adds it (formProblems refuses a name it already has).
// `scopeDefaults`: the server's configured snapshot scope (compact), which pre-fills a NEW environment
// (form.scopeFrom 'server', form.scopePrefill); an environment that exists opens on its own scope (formScopeOf).
export function formOpened(services, { serviceId = null, env = null, endpoints = [], sources = null, pick = false, addEnv = false, scopeDefaults = null } = {}) {
  const s = Array.isArray(services) ? services.find((x) => x && x.id === serviceId) : null;
  const e = s && Array.isArray(s.environments) ? s.environments.find((x) => x.name === env) || null : null;
  const eps = Array.isArray(endpoints) ? endpoints : [];
  let endpointId = '';
  if (e?.livePack) endpointId = LIVE_PACK;
  else if (e?.mcpEndpoint?.id != null) endpointId = String(e.mcpEndpoint.id);
  else if (eps.length === 1) endpointId = String(eps[0].id);
  else if (!eps.length) endpointId = NEW_ENDPOINT;
  const values = {
    name: s?.name || '', env: e?.name || env || (s ? '' : 'prod'),
    // The branch is the environment's own where the service names one (its envRefs), else the repository's.
    kind: s?.repository?.kind || firstSourceOn(sources), location: s?.repository?.location || '', ref: '',
    endpointId, epName: '', epUrl: '', epToken: '',
    // The MTTD / MTTR targets (mttx-targets.mjs): a new service starts on the recommended profile.
    ...targetsFormValues(s?.targets ?? null, { isNew: !s }),
  };
  // The live scope: an environment that exists opens on its own (empty when it has none); a new one is
  // pre-filled from the server default where it may be (formScopeOf).
  const scoped = formScopeOf(s, addEnv ? null : e, scopeDefaults);
  Object.assign(values, scoped.values);
  // A service whose repository is an upload: what was uploaded and when (kept while nothing new is chosen).
  const r = s?.repository;
  const uploaded = r?.kind === 'upload' ? { name: r.location, uploadedAt: r.uploadedAt || null, files: Number.isFinite(r.files) ? r.files : null } : null;
  // The pack files kept: the repository's and this environment's export of live (packs: { repo, live }).
  const packs = { repo: r?.kind === 'pack' ? { kept: { name: r.location, uploadedAt: r.uploadedAt || null } } : null, live: e?.livePack ? { kept: { name: e.livePack.name, uploadedAt: e.livePack.uploadedAt || null } } : null };
  // The repository as saved: a source switched off since may still be kept as it is.
  // The record as the branch rule reads it (branchIsEnvironments): the form opens on the environment's own
  // branch where the rule makes it the environment's, else on the repository's.
  const record = s ? { repository: r ? { kind: r.kind, location: r.location || '', ref: r.ref || null } : null, environments: (s.environments || []).map((x) => ({ name: x?.name, endpointId: x?.mcpEndpoint?.id ?? null, livePack: x?.livePack ? { name: x.livePack.name, uploadedAt: x.livePack.uploadedAt || null } : null, liveScope: x?.liveScope ?? null })), envRefs: s.envRefs && typeof s.envRefs === 'object' ? { ...s.envRefs } : {} } : null;
  values.ref = (branchIsEnvironments(values, record) && ownRefOf(record, values.env)) || r?.ref || '';
  const adding = !!addEnv && !!s;
  // The deployment surface this environment reads alone, '' for every file (the service's envSurfaces).
  if (record) record.envSurfaces = s.envSurfaces && typeof s.envSurfaces === 'object' ? { ...s.envSurfaces } : {};
  values.surface = adding ? '' : ownSurfaceOf(record, values.env);
  const original = r ? { kind: r.kind, location: r.location || '', ref: values.ref } : null;
  // The environments to choose from, when the service's Change is asked for one of two or more.
  const names = record ? record.environments.map((x) => x.name).filter((n) => typeof n === 'string' && n) : [];
  const envChoices = pick && names.length > 1 ? [...names].sort((a, b) => (envRank(a) - envRank(b)) || a.localeCompare(b)) : null;
  // `defaultRef`: the repository's own branch, which an environment left blank reads.
  if (adding) values.env = '';
  // The server keeps a surface per environment (its ServiceView carries envSurfaces; for a new
  // service, any listed one does): only then is the setting offered, so an older server never
  // takes an answer it would drop.
  const surfaceKnown = s ? !!(s.envSurfaces && typeof s.envSurfaces === 'object') : (Array.isArray(services) && services.some((x) => x && x.envSurfaces && typeof x.envSurfaces === 'object'));
  // The services listed, by slug: a blank Add whose name keys one of them completes that record, and
  // savePlan keeps no pre-filled scope answer onto it (scopeModel says so before the save).
  const listedSlugs = s ? null : (Array.isArray(services) ? services : []).map((x) => x?.slug).filter((x) => typeof x === 'string' && x);
  const opened = { open: true, mode: s ? 'edit' : 'add', serviceId: s?.id ?? null, envFixed: !!e && !adding, values, saving: false, error: null, uploaded, upload: null, packs, original, scopeDefaults: scopeDefaults || null, scopeFrom: scoped.from, defaultRef: r?.ref || '', record, surfaceKnown, ...(listedSlugs ? { listedSlugs } : {}), ...(envChoices && !adding ? { envChoices } : {}), ...(adding ? { addEnv: true } : {}) };
  Object.assign(opened, scoped.form);
  // Opened on no environment of its own (the row's Change of a service whose first is another): its first choice.
  return envChoices && !e && !adding ? formInput({ ...opened, envFixed: true }, 'env', envChoices[0]) : opened;
}

// The environment chosen on a form that offers the choice: that environment's own endpoint and
// branch (the rest — the repository, the targets — is the service's, and stays as answered).
function chooseEnvironment(form) {
  const e = form.record?.environments?.find((x) => x.name === form.values.env);
  if (!e) return form;
  const values = { ...form.values, endpointId: e.livePack ? LIVE_PACK : e.endpointId != null ? String(e.endpointId) : form.values.endpointId };
  form = { ...form, packs: { ...(form.packs || {}), live: e.livePack ? { kept: e.livePack } : null } };
  const scoped = formScopeOf(null, e, form.scopeDefaults ?? null);
  Object.assign(values, scoped.values);
  form = { ...form, ...scoped.form };
  values.ref = (branchIsEnvironments(values, form.record) && ownRefOf(form.record, e.name)) || form.record.repository?.ref || '';
  values.surface = ownSurfaceOf(form.record, e.name);
  return { ...form, envFixed: true, values, original: form.original ? { ...form.original, ref: values.ref } : form.original };
}

// A service's own branch for an environment (its envRefs' own entry, never an inherited name), or null.
const ownRefOf = (record, envName) => {
  const refs = record?.envRefs;
  return refs && typeof refs === 'object' && Object.hasOwn(refs, envName) && typeof refs[envName] === 'string' && refs[envName] ? refs[envName] : null;
};

// The deployment surface an environment reads alone (the service's envSurfaces' own entry, a surface
// this build knows), else '' — every file.
const ownSurfaceOf = (record, envName) => {
  const map = record?.envSurfaces;
  const id = map && typeof map === 'object' && Object.hasOwn(map, envName) ? map[envName] : '';
  return SURFACE_IDS.includes(id) ? id : '';
};

// Whether the form's branch answer is the environment's own (the service's envRefs) rather than the
// repository's: the record reads this same GitHub or Azure DevOps repository, and the service has —
// with this environment — two or more environments, or already names a branch for this one. A
// service in one environment keeps one branch, the repository's, as before.
export function branchIsEnvironments(values, record) {
  const was = record?.repository;
  const env = trimmed(values?.env);
  if (!was || !env || (values.kind !== 'github' && values.kind !== 'ado')) return false;
  if (was.kind !== values.kind || was.location !== trimmed(values.location)) return false;
  const names = new Set((record.environments || []).map((e) => e?.name).filter(Boolean));
  names.add(env);
  return names.size > 1 || !!ownRefOf(record, env);
}

// The first source switched on, a folder or an address before Upload (and a pack file after it);
// GitHub when every one is off.
function firstSourceOn(sources) {
  const on = REPOSITORY_KINDS.filter((k) => !sourceOff(sources, k.kind));
  return (on.find((k) => k.kind !== 'upload' && k.kind !== 'pack') || on.find((k) => k.kind === 'upload') || on[0] || REPOSITORY_KINDS[0]).kind;
}

// One field typed into: the state with that value (only known fields). A
// change of kind closes the folder panel (Browse…: below); a change to or
// from Upload swaps the location — an upload's is its name, never an address.
export function formInput(form, field, value) {
  if (!form?.open || !Object.hasOwn(form.values || {}, field)) return form;
  const next = { ...form, values: { ...form.values, [field]: String(value ?? '') }, error: null };
  // The targets answered by the person (not the form's own start): only then may a save change a record's.
  if (field.startsWith('target')) next.targetsTouched = true;
  if (field === 'kind' && next.browse) next.browse = null;
  // Upload's and Pack file's location is a file's name, no address: leaving either clears it, and
  // coming to one takes its file's.
  const named = (k) => k === 'upload' || k === 'pack';
  if (field === 'kind' && form.values.kind !== next.values.kind && (named(form.values.kind) || named(next.values.kind))) {
    const p = form.packs?.repo;
    next.values.location = next.values.kind === 'upload' ? (form.upload?.staged?.name || form.uploaded?.name || '')
      : next.values.kind === 'pack' ? (p?.staged?.name || p?.kept?.name || '') : '';
  }
  // Another of the service's environments chosen: its own endpoint and branch.
  if (field === 'env' && Array.isArray(form.envChoices)) return chooseEnvironment(next);
  return next;
}

const trimmed = (v) => String(v ?? '').trim();

// The form's answers, to outlive a sign-in that takes this tab to the host's
// own page and back (a blocked window, or a browser that opens windows in the
// tab): formDraft(form) is what the host keeps for the tab, formRestored the
// form opened again from it. Never a token — it is no form value — and never
// an upload's files, which leave with the page: a draft on Upload opens on
// the form's first kind. A draft older than FORM_DRAFT_TTL_MS, of a service
// that is gone, or that is no draft at all restores nothing.
export const FORM_DRAFT_TTL_MS = 15 * 60_000;
const FORM_DRAFT_VALUE_MAX = 2048;

// The server default the scope answers were pre-filled with (form.scopePrefill: a new environment's
// pre-fill, or Use the server default) rides along, compact, so the restored form keeps and drops on
// save what it said it would before the round trip.
export function formDraft(form, { now = Date.now() } = {}) {
  if (!form?.open || form.chaosRun || form.objectives || form.agreement) return null;
  const prefill = form.scopePrefill ? scopeFromValues(scopeFormValues(form.scopePrefill)) : null;
  return { v: 1, at: now, serviceId: form.serviceId ?? null, env: form.envFixed ? form.values.env : null, values: { ...form.values }, targetsTouched: !!form.targetsTouched, ...(prefill ? { scopePrefill: prefill } : {}) };
}

export function formRestored(services, draft, { endpoints = [], sources = null, scopeDefaults = null, now = Date.now() } = {}) {
  if (!draft || typeof draft !== 'object' || draft.v !== 1 || !Number.isFinite(draft.at)) return null;
  if (now - draft.at > FORM_DRAFT_TTL_MS || draft.at - now > 60_000) return null;
  const serviceId = draft.serviceId ?? null;
  if (serviceId !== null && !(Array.isArray(services) && services.some((x) => x && x.id === serviceId))) return null;
  let form = formOpened(services, { serviceId, env: typeof draft.env === 'string' ? draft.env : null, endpoints, sources, scopeDefaults });
  const values = draft.values && typeof draft.values === 'object' ? draft.values : {};
  if (values.kind === 'upload') return form;
  for (const field of Object.keys(form.values)) {
    const value = values[field];
    if (typeof value !== 'string' || value.length > FORM_DRAFT_VALUE_MAX) continue;
    if (field === 'kind' && !REPOSITORY_KINDS.some((k) => k.kind === value)) continue;
    // The targets come back only when the person had answered them; a profile this build does not
    // know (an older or a broken draft) stays as the form opened it.
    if (field.startsWith('target') && draft.targetsTouched !== true) continue;
    if (field === 'targetProfile' && value !== '' && value !== MTTX_CUSTOM && !MTTX_PROFILES.some((p) => p.id === value)) continue;
    // A deployment surface this build does not know stays as the form opened it.
    if (field === 'surface' && value !== '' && !SURFACE_IDS.includes(value)) continue;
    form = formInput(form, field, value);
  }
  // The pre-fill the draft's form held (formDraft), read back as a compact scope, each answer within
  // the draft's bound: the form says and saves what it did before the round trip — an environment
  // that exists opens with none, so Use the server default would otherwise be forgotten.
  const pre = draft.scopePrefill && typeof draft.scopePrefill === 'object' && !Array.isArray(draft.scopePrefill) ? scopeFromValues(scopeFormValues(draft.scopePrefill)) : null;
  if (pre && Object.values(scopeFormValues(pre)).every((x) => x.length <= FORM_DRAFT_VALUE_MAX)) {
    form = { ...form, scopePrefill: pre, scopePrefillRefused: null, scopeFrom: 'server' };
  }
  return form;
}

// targetsFormOpened(services, { serviceId, env, endpoints, sources }) → the form the board's and the
// control room's Set targets… / Change targets… open: the service's own, at its Targets answer
// alone (`targetsOnly`), the recommended profile chosen when it has none (answered, so one Save sets
// it); null for a service that is not a record.
export function targetsFormOpened(services, { serviceId = null, env = null, endpoints = [], sources = null } = {}) {
  if (!Array.isArray(services) || !services.some((s) => s && s.id === serviceId)) return null;
  let form = { ...formOpened(services, { serviceId, env, endpoints, sources }), targetsOnly: true, focus: 'targetProfile', scroll: true };
  if (!form.values.targetProfile) form = formInput(form, 'targetProfile', MTTX_RECOMMENDED);
  return form;
}

// targetsOnlyPlan(values, { services, serviceId }) → what Save does on that form:
// { problems, serviceId, patch, name, envName } — the targets' own problems alone (the rest of the
// record is not this form's), and `patch` { targets } only when they differ from the record's.
export function targetsOnlyPlan(values = {}, { services = [], serviceId = null } = {}) {
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === serviceId) || null;
  const problems = existing ? targetsFormProblems(values) : { targetProfile: 'This service is no longer listed: close the form and open it again.' };
  const targets = targetsFromForm(values);
  const changed = !!existing && !Object.keys(problems).length && !sameTargets(existing.targets ?? null, targets ? targetsRecord(targets) : null);
  return { problems, serviceId: existing ? existing.id : null, patch: changed ? { targets } : null, name: existing?.name || trimmed(values.name), envName: trimmed(values.env) };
}

// ---------- The agreement ----------
//
// The stage before the repository (agreement → repository → each environment): what the service
// promised, kept in versions with the document each one comes from, and what of it the repository
// covers (studio/agreement.mjs). Never a score and never beside a letter: a commitment is covered,
// covered in part or not covered, by what it is linked to.

const dayMonthYear = (iso) => {
  const t = Date.parse(`${iso}T00:00:00Z`);
  return Number.isFinite(t) ? new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }) : String(iso || '');
};
const versionWords = (v) => `${v.source.document} · ${v.source.version}`;

// agreementCell(service, fact, { canWrite }) → the list's Agreement cell for a service:
//   { state: 'none', action } — none recorded; `action` 'Record the agreement…' for a writer, else null
//   { state: 'recorded', title, since, summary, tone, action: 'Open' } — its current version, and
//     what the repository covers of it (`fact`: loadServiceAgreement's answer; not loaded yet, or
//     failed: the count alone, and why)
export function agreementCell(service, fact = null, { canWrite = true } = {}) {
  const current = agreementCurrent(service?.agreement ?? null);
  if (!current) return { state: 'none', action: canWrite ? 'Record the agreement…' : null };
  const n = current.commitments.length;
  const counts = fact?.coverage?.counts || null;
  const summary = fact?.error ? `${n} commitment${n === 1 ? '' : 's'}; what the repository covers was not read: ${fact.error}`
    : counts ? coverageSummary(counts) : `${n} commitment${n === 1 ? '' : 's'}.`;
  const tone = !counts || counts.covered === null || !counts.service ? 'neutral' : counts.covered === counts.service ? 'ok' : 'warn';
  return { state: 'recorded', title: versionWords(current), since: `in force since ${dayMonthYear(current.source.effective)}`, summary, tone, action: 'Open' };
}

const AGR = 'agr:';
const ownerOfRow = (o) => (AGREEMENT_OWNERS.includes(o) ? o : 'service');
const weightOfRow = (w) => { const n = Number(trimmed(w)); return Number.isInteger(n) && n >= 1 && n <= WEIGHT_MAX ? n : null; };
const rowOfCommitment = (c) => ({ id: c.id, clause: c.clause || '', text: c.text || '', target: c.target || '', owner: ownerOfRow(c.owner), weight: Number.isInteger(c.weight) && c.weight > 1 ? String(c.weight) : '', links: (c.links || []).map(linkText).join(', ') });
const versionOfForm = (form) => ({
  source: { document: trimmed(form.values.agrDocument), version: trimmed(form.values.agrVersion), effective: trimmed(form.values.agrEffective) },
  commitments: (form.rows || []).map((r) => ({ id: r.id, clause: trimmed(r.clause), text: trimmed(r.text), target: trimmed(r.target), owner: ownerOfRow(r.owner), ...(weightOfRow(r.weight) > 1 ? { weight: weightOfRow(r.weight) } : {}), links: linksFromText(r.links).links })),
});

// agreementFormOpened(services, { serviceId, fact, today }) → the form the list's Agreement cell
// opens: the current version's source and commitments (none recorded: an empty document in force
// `today`, one empty commitment), with what the repository declares to link to (`fact.catalogue`).
// null for a service that is not a record.
export function agreementFormOpened(services, { serviceId = null, fact = null, today = '' } = {}) {
  const service = (Array.isArray(services) ? services : []).find((s) => s && s.id === serviceId) || null;
  if (!service) return null;
  const current = agreementCurrent(service.agreement ?? null);
  const rows = current ? current.commitments.map(rowOfCommitment) : [{ id: 'c-1', clause: '', text: '', target: '', owner: 'service', weight: '', links: '' }];
  return {
    open: true, mode: 'edit', agreement: true, serviceId: service.id, rows,
    catalogue: fact && !fact.error && fact.repository ? fact.catalogue : null,
    routes: fact && !fact.error && Array.isArray(fact.routes) ? fact.routes : [],
    repository: fact?.repository ?? null, readError: fact?.error || null,
    versions: (service.agreement?.versions || []).map((v) => ({ words: versionWords(v), since: dayMonthYear(v.source.effective), commitments: v.commitments.length, by: v.by || '', at: v.at || '' })),
    values: { name: service.name, agrDocument: current?.source.document || '', agrVersion: current?.source.version || '', agrEffective: current?.source.effective || today, agrPaste: '' },
    focus: current ? null : 'agrDocument', scroll: true, saving: false, error: null,
  };
}

// One answer typed or chosen: a source field, the paste box, or a commitment's ("agr:<row>:<field>").
export function agreementFormInput(form, field, value) {
  if (!form?.agreement) return form;
  const v = String(value ?? '');
  if (!field.startsWith(AGR)) return { ...form, values: { ...form.values, [field]: v }, error: null };
  const [, at, key] = field.split(':');
  const i = Number(at);
  if (!Number.isInteger(i) || !form.rows[i] || !['clause', 'text', 'target', 'owner', 'weight', 'links'].includes(key)) return form;
  return { ...form, rows: form.rows.map((r, j) => (j === i ? { ...r, [key]: key === 'owner' ? (AGREEMENT_OWNERS.includes(v) ? v : 'service') : v } : r)), error: null };
}
// Add a commitment: an empty row, the focus on what it promises.
export function agreementFormAdd(form) {
  if (!form?.agreement || form.rows.length >= COMMITMENTS_MAX) return form;
  const id = commitmentId('', form.rows.map((r) => r.id));
  return { ...form, rows: [...form.rows, { id, clause: '', text: '', target: '', owner: 'service', weight: '', links: '' }], focus: `${AGR}${form.rows.length}:clause`, scroll: true, error: null };
}
export function agreementFormRemove(form, i) {
  if (!form?.agreement || !form.rows[i]) return form;
  return { ...form, rows: form.rows.filter((_, j) => j !== i), error: null };
}
// Paste several: the box's lines become commitments after the ones there (an empty first row gives way).
export function agreementFormPaste(form) {
  if (!form?.agreement) return form;
  const kept = form.rows.filter((r) => trimmed(r.clause) || trimmed(r.text) || trimmed(r.target) || trimmed(r.links) || trimmed(r.weight));
  const { commitments, problems } = commitmentsFromText(form.values.agrPaste, kept.map((r) => r.id));
  if (!commitments.length) return { ...form, error: problems[0] || 'Nothing to add: one commitment a line — clause | what is promised | target | whose | links.' };
  if (kept.length + commitments.length > COMMITMENTS_MAX) return { ...form, error: `At most ${COMMITMENTS_MAX} commitments.` };
  return { ...form, rows: [...kept, ...commitments.map(rowOfCommitment)], values: { ...form.values, agrPaste: '' }, error: problems.length ? `Added ${commitments.length}; ${problems.join('; ')}.` : null };
}

// What is wrong before Save — { field: sentence }.
function agreementProblems(form) {
  const out = {};
  const v = form.values || {};
  if (!trimmed(v.agrDocument)) out.agrDocument = 'Name the document the agreement is written in.';
  if (!trimmed(v.agrVersion)) out.agrVersion = 'Give that document\'s version.';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed(v.agrEffective))) out.agrEffective = 'Say the day it comes into force.';
  (form.rows || []).forEach((r, i) => {
    if (!trimmed(r.text)) out[`${AGR}${i}:text`] = 'Say what is promised, or remove the row.';
    if (trimmed(r.weight) && weightOfRow(r.weight) === null) out[`${AGR}${i}:weight`] = `A whole number from 1 to ${WEIGHT_MAX}, or blank for 1.`;
    const bad = linksFromText(r.links).problems;
    if (bad.length) out[`${AGR}${i}:links`] = `${bad.map((b) => JSON.stringify(b)).join(', ')} is not a link: write kind:name, such as alert:CheckoutErrorsHigh.`;
  });
  return out;
}

// agreementPlan(form, { services }) → what Save does: { problems, serviceId, patch, name, words } —
// `patch` { agreement: { source, commitments } } only when it differs from the record's current version.
export function agreementPlan(form, { services = [] } = {}) {
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === form?.serviceId) || null;
  const name = existing?.name || trimmed(form?.values?.name);
  if (!existing) return { problems: { agrDocument: 'This service is no longer listed: close the form and open it again.' }, serviceId: null, patch: null, name, words: '' };
  const problems = agreementProblems(form);
  const version = versionOfForm(form);
  const changed = !Object.keys(problems).length && !sameAgreement(existing.agreement ?? null, { versions: [version] });
  return { problems, serviceId: existing.id, patch: changed ? { agreement: version } : null, name, words: `${version.source.document} · ${version.source.version}` };
}

// agreementWhatIf(form) → { summary, states: [{ words, tone }] } — what the repository covers of the
// form as it reads now, said under the rows and beside each at every keystroke.
export function agreementWhatIf(form) {
  if (!form?.agreement) return { summary: '', states: [] };
  // The facts behind each commitment (studio/agreement.mjs commitmentFacts): its state, then what it lacks.
  const coverage = commitmentFacts(versionOfForm(form), form.catalogue, form.routes);
  const said = coverage.commitments.filter((c) => c.text);
  const own = said.filter((c) => c.owner !== 'consumer');
  const n = (state) => (coverage.read ? own.filter((c) => c.state === state).length : null);
  const counts = { total: said.length, service: own.length, consumer: said.length - own.length, covered: n('covered'), part: n('part'), notCovered: n('not-covered') };
  return {
    summary: coverageSummary(counts),
    states: coverage.commitments.map((c) => ({
      words: !c.text ? '' : c.owner === 'consumer' ? `The consumer's: shown here, not counted. ${coverageWords(c)}` : [coverageWords(c), gapsWords(c.gaps)].filter(Boolean).join('. ').replace(/\.\.$/, '.'),
      // What it lacks, sentence by sentence, each with its fix (a title on the line).
      gaps: !c.text || c.owner === 'consumer' ? [] : c.gaps.filter((g) => g.key !== 'in-pack').map((g) => `${g.words} ${g.fix}`),
      tone: !c.text || c.state === 'not-read' ? 'neutral' : c.state === 'covered' ? (c.owner !== 'consumer' && gapsWords(c.gaps) ? 'warn' : 'ok') : c.state === 'part' ? 'warn' : 'fail',
    })),
  };
}

// What the renderer draws.
function agreementFormView(form, { access = null } = {}) {
  const canWrite = access?.canWrite !== false;
  const whatIf = agreementWhatIf(form);
  return {
    open: true, mode: 'edit', agreement: true, saving: !!form.saving, error: form.error || null, focus: form.focus || null, scroll: !!form.scroll,
    title: `Agreement · ${form.values.name}`,
    hint: 'What this service promised, as its agreement states it. Each commitment is linked to what the repository declares for it — an objective, an alert rule, a dashboard, a metric — or to nothing, which reads not covered. This is the stage before the repository: it says how much of the agreement the repository covers, and never moves a letter.',
    values: { ...form.values },
    rows: (form.rows || []).map((r, i) => ({ ...r, i, state: whatIf.states[i] || { words: '', tone: 'neutral' }, owners: [{ value: 'service', label: 'This service', selected: ownerOfRow(r.owner) === 'service' }, { value: 'consumer', label: 'The consumer', selected: r.owner === 'consumer' }, { value: 'both', label: 'Both', selected: r.owner === 'both' }] })),
    summary: whatIf.summary,
    repository: form.readError ? `What the repository declares was not read: ${form.readError}`
      : form.repository ? `Looked up in ${form.repository.pack}${form.repository.env ? `, the pack ${form.repository.env} is checked against` : ''}.`
        : 'The repository has no pack yet: Run the service once, and the links are looked up.',
    catalogue: (form.catalogue || []).filter((x) => !x.guessed).map(linkText),
    versions: form.versions || [],
    canAdd: (form.rows || []).length < COMMITMENTS_MAX,
    problems: agreementProblems(form),
    canWrite, reason: canWrite ? null : (access?.reason || 'Not available for your role here.'),
  };
}

// ---------- State objectives… ----------
//
// An SLO the scan inferred carries its default objective (99% over 30 days), which the grade does not
// count (schema 6). The form asks the objective and its window per such SLO (studio/slo-objectives.mjs),
// shown with the indicator it reads and that indicator's series; Save sends the service's whole
// record (PATCH { objectives }) and checks the service again, so the grade takes it.

const OBJ = 'obj:';
const WIN = 'win:';
const DROP = 'drop:';
const calibratedOf = (diagnostic) => criterionOf(diagnostic, 'calibrated');
// The repository's own grade with these objectives stated (and no others): the letter the board shows
// after a Save, until the service is checked again.
function gradeWithObjectives(layered, objectives, off = [], posture = null) {
  const bare = { ...layered, meta: { ...(layered.meta && typeof layered.meta === 'object' ? layered.meta : {}), studioObjectives: undefined } };
  const pack = withStatedObjectives(bare, objectives);
  return computeDiagnosticGrade(pack, null, posture || computePostureMatrix(pack, null), null, null, { off });
}

// objectivesOffer(diagnostic, service, { settable }) → { label, note, left, of } | null — what the
// board offers under the letter: 'State objectives…' while an SLO still carries the scan's default,
// 'Change objectives…' once each has one. null: nothing to state, Calibrated is not graded, or the
// reader may not change the service.
export function objectivesOffer(diagnostic, service, { settable = false } = {}) {
  const c = settable ? calibratedOf(diagnostic) : null;
  if (!c || c.applies === false) return null;
  const rows = objectiveRowsOf(c, service?.objectives ?? null);
  if (!rows.ask.length) return null;
  const left = rows.ask.filter((r) => !r.stated).length;
  const of = rows.ask.length;
  return {
    label: left ? 'State objectives…' : 'Change objectives…', left, of,
    note: left
      ? `${left === of ? (of === 1 ? 'Its one objective carries' : `All ${of} objectives carry`) : `${left} of ${of} objectives carry`} the scan's default (99% over 30 days): nobody stated ${left === 1 ? 'it' : 'them'}, so the grade does not count ${left === 1 ? 'it' : 'them'}.`
      : `${of === 1 ? 'Its objective is' : `All ${of} objectives are`} stated in the studio.`,
  };
}

// objectivesFormOpened(services, { serviceId, env, layered }) → the form State objectives… opens: a
// row per SLO that takes an objective, the ones already stated filled in. null for a service that is
// not a record, a pack that is not read, or one with nothing to state.
export function objectivesFormOpened(services, { serviceId = null, env = null, layered = null } = {}) {
  const service = (Array.isArray(services) ? services : []).find((s) => s && s.id === serviceId) || null;
  if (!service || !layered) return null;
  const off = Array.isArray(service.gradeOff) ? service.gradeOff : [];
  let posture; let rows;
  try {
    posture = computePostureMatrix(layered, null);
    rows = objectiveRowsOf(calibratedOf(gradeWithObjectives(layered, service.objectives ?? null, off, posture)), service.objectives ?? null);
  } catch (_) { return null; }
  if (!rows.ask.length && !rows.elsewhere.length) return null;
  const values = { name: service.name, env: env || '' };
  for (const r of rows.ask) { values[`${OBJ}${r.id}`] = r.percent; values[`${WIN}${r.id}`] = r.window; }
  const first = rows.ask.find((r) => !r.stated) || rows.ask[0] || null;
  return { open: true, mode: 'edit', objectives: true, serviceId: service.id, envFixed: !!env, layered, posture, rows, values, focus: first ? `${OBJ}${first.id}` : null, scroll: true, saving: false, error: null };
}

export function objectivesFormInput(form, field, value) {
  if (!form?.objectives) return form;
  return { ...form, values: { ...form.values, [field]: String(value ?? '') }, error: null };
}

// objectivesPlan(form, { services }) → what Save does: { problems, serviceId, objectives, patch, name,
// envName } — `objectives` the service's whole record as the form now reads (the entries for SLOs this
// scan does not hold kept, unless ticked for removal), `patch` { objectives } only when it differs
// from the record's.
export function objectivesPlan(form, { services = [] } = {}) {
  const v = form?.values || {};
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === form?.serviceId) || null;
  const name = existing?.name || trimmed(v.name);
  const envName = trimmed(v.env);
  if (!existing) return { problems: { [form?.focus || 'name']: 'This service is no longer listed: close the form and open it again.' }, serviceId: null, objectives: null, patch: null, name, envName };
  const asked = new Set((form.rows?.ask || []).map((r) => r.id));
  const was = existing.objectives?.slos && typeof existing.objectives.slos === 'object' ? existing.objectives.slos : {};
  const keep = Object.fromEntries(Object.entries(was).filter(([id]) => !asked.has(id) && v[`${DROP}${id}`] !== '1'));
  const answers = Object.fromEntries([...asked].map((id) => [id, { percent: v[`${OBJ}${id}`], window: v[`${WIN}${id}`] }]));
  const { objectives, problems: list } = objectivesFromForm(answers, keep);
  const problems = Object.fromEntries(list.map((p) => [`${OBJ}${p.id}`, p.text]));
  const changed = !Object.keys(problems).length && !sameObjectives(existing.objectives ?? null, objectives);
  return { problems, serviceId: existing.id, objectives, patch: changed ? { objectives } : null, name, envName };
}

// objectivesWhatIf(form, { services }) → { text, tone } — said under the rows at every keystroke: how
// many are stated, and the letter the repository alone would read with them (the letter the board
// shows after Save, until the check that follows).
export function objectivesWhatIf(form, { services = [] } = {}) {
  if (!form?.objectives) return { text: '', tone: 'neutral' };
  const plan = objectivesPlan(form, { services });
  if (Object.keys(plan.problems).length) return { text: 'Give each objective as a percent above 0 and below 100, such as 99.9; leave one blank to state nothing for it.', tone: 'warn' };
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === form.serviceId) || null;
  const off = Array.isArray(existing?.gradeOff) ? existing.gradeOff : [];
  let now; let then;
  try {
    now = gradeWithObjectives(form.layered, existing?.objectives ?? null, off, form.posture);
    then = gradeWithObjectives(form.layered, plan.objectives, off, form.posture);
  } catch (_) { return { text: '', tone: 'neutral' }; }
  const c = calibratedOf(then);
  const of = (form.rows?.ask || []).length;
  const stated = (form.rows?.ask || []).filter((r) => trimmed(form.values[`${OBJ}${r.id}`])).length;
  const said = (g) => `${g.overall?.instrumentGrade?.letter || '–'} ${Math.round(g.overall?.audit?.scorePctExact ?? 0)}`;
  const head = `${stated} of ${of} stated.`;
  if (c?.applies === false) return { text: `${head} Calibrated is not graded for this service, so the letter does not move.`, tone: 'neutral' };
  const needsTargets = /no .*baselines/i.test(String(c?.detail || ''));
  const moved = said(now) === said(then)
    ? `The repository alone reads ${said(now)} either way`
    : `The repository alone would read ${said(then)} (it reads ${said(now)} now)`;
  return {
    text: `${head} ${moved}${needsTargets ? ' — Calibrated also needs detection and repair targets: Set targets… on the board.' : '.'} Save checks the service again, so the letter against live takes them.`,
    tone: stated === of ? 'ok' : 'neutral',
  };
}

// What the renderer draws.
function objectivesFormView(form, { access = null } = {}) {
  const v = form.values || {};
  const env = trimmed(v.env);
  const canWrite = access?.canWrite !== false;
  const rows = form.rows || { ask: [], unbounded: [], repository: 0, elsewhere: [] };
  return {
    open: true, mode: 'edit', objectives: true, saving: !!form.saving, error: form.error || null, focus: form.focus || null, scroll: !!form.scroll,
    title: `State objectives · ${v.name}${env ? ` · ${env}` : ''}`,
    hint: 'The scan gives every objective it infers 99% over 30 days — a default, which the grade does not count. State what the service is actually held to: kept with this service, signed and dated, and counted by the grade where the repository states none. The comparison with live is not touched.',
    values: { ...v },
    rows: rows.ask.map((r) => ({
      id: r.id, sli: r.sli, series: r.series, field: `${OBJ}${r.id}`, windowField: `${WIN}${r.id}`, percent: v[`${OBJ}${r.id}`] ?? '',
      windows: OBJECTIVE_WINDOWS.map((w) => ({ value: w, label: `over ${w.replace(/d$/, '')} days`, selected: (v[`${WIN}${r.id}`] || '30d') === w })),
      was: r.stated ? 'stated in the studio' : 'the scan\'s default, not counted',
    })),
    unbounded: rows.unbounded.length
      ? `${rows.unbounded.length} recorded series ${rows.unbounded.length === 1 ? 'has' : 'have'} no bound that says what "good" is, so ${rows.unbounded.length === 1 ? 'it holds' : 'they hold'} no objective and ${rows.unbounded.length === 1 ? 'is' : 'are'} left out of the count: ${rows.unbounded.slice(0, 4).map((r) => r.sli).join(', ')}${rows.unbounded.length > 4 ? `, and ${rows.unbounded.length - 4} more` : ''}.`
      : '',
    repository: rows.repository ? `${rows.repository} ${rows.repository === 1 ? 'objective is' : 'objectives are'} stated in the repository and ${rows.repository === 1 ? 'needs' : 'need'} nothing here.` : '',
    elsewhere: rows.elsewhere.map((r) => ({ id: r.id, words: `${r.percent}% over ${String(r.window).replace(/d$/, '')} days`, field: `${DROP}${r.id}`, checked: v[`${DROP}${r.id}`] === '1' })),
    whatIf: objectivesWhatIf(form, { services: form.servicesAtOpen || [] }),
    problems: objectivesPlan(form, { services: form.servicesAtOpen || [] }).problems,
    canWrite, reason: canWrite ? null : (access?.reason || 'Not available for your role here.'),
  };
}

// ---------- Record a chaos run… ----------
//
// A chaos run's result entered in the studio (studio/chaos-runs.mjs): opened from the board's MTTD /
// MTTR tile and the control room, on the service list where the service's form lives; Save sends the
// service's whole list with the new run first (PATCH { chaosRuns }) and checks the service again,
// so the grade's Chaos-validated, the measured MTTD and the control room read it.

export const CHAOS_RECORD_LABEL = 'Record a chaos run…';
const SLUG_ID = /^[a-z][a-z0-9_-]*[a-z0-9]$/;

// chaosExperimentsOf(layered) → the experiments a run can be recorded for: the pack's own chaos
// experiments, scaffolds aside (a library placeholder never ran), each once —
// [{ id, expectedAlerts, expectedMttd, schedule, environment }]. An id that is not a spec Slug is
// left out: a run names its experiment by it.
export function chaosExperimentsOf(layered) {
  const L5 = Array.isArray(layered?.layers?.L5) ? layered.layers.L5 : [];
  const seen = new Set();
  const out = [];
  for (const a of L5) {
    if (!a || typeof a !== 'object' || !/^CHAOS-/.test(String(a.id || '')) || isScaffoldArtefact(a)) continue;
    const id = String(a.spec?.id || a.title || '');
    if (id.length < 2 || id.length > 64 || !SLUG_ID.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      expectedAlerts: Array.isArray(a.spec?.expected_alerts) ? [...new Set(a.spec.expected_alerts.filter((x) => typeof x === 'string' && x.trim()))] : [],
      expectedMttd: typeof a.spec?.expected_mttd === 'string' ? a.spec.expected_mttd : null,
      schedule: typeof a.spec?.schedule === 'string' ? a.spec.schedule : null,
      environment: typeof a.spec?.environment === 'string' ? a.spec.environment : null,
    });
  }
  return out;
}

const pad2 = (n) => String(n).padStart(2, '0');
// The datetime-local value ("2026-11-11T14:05") of `ms` in a zone `tzOffset` minutes behind UTC
// (Date#getTimezoneOffset: -60 in Paris in winter).
export function localDateTimeValue(ms, tzOffset = 0) {
  const d = new Date(ms - tzOffset * 60_000);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}T${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}`;
}
// A datetime-local value back to a date-time in UTC ("2026-11-11T13:05:00Z"), or null.
export function isoFromLocal(value, tzOffset = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const [y, mo, d, h, mi, s] = m.slice(1).map((x) => Number(x || 0));
  const local = new Date(Date.UTC(y, mo - 1, d, h, mi, s));
  if (local.getUTCMonth() !== mo - 1 || local.getUTCDate() !== d || h > 23 || mi > 59 || s > 59) return null;
  return new Date(local.getTime() + tzOffset * 60_000).toISOString().replace('.000Z', 'Z');
}

const FIRED = 'crFired:';
const firedValues = (experiment) => Object.fromEntries((experiment?.expectedAlerts || []).map((a) => [`${FIRED}${a}`, '1']));
const withoutFired = (values) => Object.fromEntries(Object.entries(values).filter(([k]) => !k.startsWith(FIRED)));
const runsHere = (runs, env) => (Array.isArray(runs) ? runs : []).filter((r) => r && (!env || !r.environment || r.environment === env));

// chaosRunFormOpened(services, { serviceId, env, layered, now, tzOffset }) → the form Record a chaos
// run… opens: the service's own experiments (chaosExperimentsOf), the first chosen, now as the time,
// Passed, every expected alert ticked as fired; the service's recorded runs (`runs`) for its list.
// null for a service that is not a record, or a pack that declares no experiment.
export function chaosRunFormOpened(services, { serviceId = null, env = null, layered = null, now = Date.now(), tzOffset = 0 } = {}) {
  const service = (Array.isArray(services) ? services : []).find((s) => s && s.id === serviceId) || null;
  const experiments = chaosExperimentsOf(layered);
  if (!service || !experiments.length) return null;
  return {
    open: true, mode: 'edit', chaosRun: true, serviceId: service.id, envFixed: !!env, experiments, tzOffset,
    runs: Array.isArray(service.chaosRuns) ? service.chaosRuns : [],
    values: { name: service.name, env: env || '', crExperiment: experiments[0].id, crAt: localDateTimeValue(now, tzOffset), crOutcome: 'pass', crMttd: '', crNote: '', ...firedValues(experiments[0]) },
    focus: 'crExperiment', scroll: true, saving: false, error: null,
  };
}

// One answer typed or chosen; another experiment brings its own expected alerts, each ticked.
export function chaosRunFormInput(form, field, value) {
  if (!form?.chaosRun) return form;
  let values = { ...form.values, [field]: String(value ?? '') };
  if (field === 'crExperiment') values = { ...withoutFired(values), ...firedValues((form.experiments || []).find((x) => x.id === value)) };
  return { ...form, values, error: null };
}

// What is wrong before Save — { field: sentence }: the experiment, when (not in the future), the
// outcome, the MTTD as seconds or a duration, the note's length; a run already recorded at that time.
export function chaosRunProblems(values = {}, { experiments = [], tzOffset = 0, now = Date.now(), runs = [] } = {}) {
  const out = {};
  const e = (Array.isArray(experiments) ? experiments : []).find((x) => x.id === values.crExperiment);
  if (!e) out.crExperiment = 'Choose the experiment that ran.';
  const at = isoFromLocal(values.crAt, tzOffset);
  if (!at) out.crAt = 'Say when it ran: a date and a time.';
  else if (Date.parse(at) > now + CHAOS_RUN_AHEAD_MS) out.crAt = 'It cannot have run in the future.';
  else if (Date.parse(at) < Date.UTC(2000, 0, 1)) out.crAt = 'Say when it ran: a date from 2000 on.';
  if (!CHAOS_RUN_OUTCOMES.includes(values.crOutcome)) out.crOutcome = 'Say whether it passed, failed or was aborted.';
  if (Number.isNaN(parseMttdText(values.crMttd))) out.crMttd = 'Give the MTTD in seconds (45) or as a duration (2m30s), at most a week.';
  // eslint-disable-next-line no-control-regex
  if (String(values.crNote ?? '').trim().length > CHAOS_RUN_NOTE_MAX || /[\u0000-\u001f\u007f]/.test(String(values.crNote ?? ''))) out.crNote = `At most ${CHAOS_RUN_NOTE_MAX} characters on one line.`;
  if (!Object.keys(out).length) {
    const list = Array.isArray(runs) ? runs : [];
    const id = chaosRunId({ experiment: e.id, at, environment: trimmed(values.env) || null });
    if (list.some((r) => chaosRunId(r) === id)) out.crAt = 'A run of this experiment at this time is already recorded.';
    else if (list.length >= CHAOS_RUNS_MAX) out.crExperiment = `${CHAOS_RUNS_MAX} runs are recorded for this service: forget an old one first.`;
  }
  return out;
}

// chaosRunPlan(form, { services, now }) → what Save does: { problems, serviceId, patch, run, name, envName }
// — `patch` { chaosRuns } the service's list as the server last gave it with the new run first
// (the server keeps who recorded each and when), null while there are problems.
export function chaosRunPlan(form, { services = [], now = Date.now() } = {}) {
  const v = form?.values || {};
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === form?.serviceId) || null;
  const runs = Array.isArray(existing?.chaosRuns) ? existing.chaosRuns : [];
  const experiments = Array.isArray(form?.experiments) ? form.experiments : [];
  const problems = existing ? chaosRunProblems(v, { experiments, tzOffset: form?.tzOffset || 0, now, runs }) : { crExperiment: 'This service is no longer listed: close the form and open it again.' };
  const name = existing?.name || trimmed(v.name);
  if (Object.keys(problems).length) return { problems, serviceId: existing?.id ?? null, patch: null, run: null, name, envName: trimmed(v.env) };
  const e = experiments.find((x) => x.id === v.crExperiment);
  const s = parseMttdText(v.crMttd);
  const run = {
    experiment: e.id, at: isoFromLocal(v.crAt, form.tzOffset || 0), outcome: v.crOutcome,
    environment: trimmed(v.env) || null,
    mttd: s === null ? null : mttdDuration(s),
    alertsFired: e.expectedAlerts.length ? e.expectedAlerts.filter((a) => v[`${FIRED}${a}`] === '1') : null,
    note: trimmed(v.crNote),
  };
  return { problems, serviceId: existing.id, patch: { chaosRuns: [run, ...runs] }, run, name, envName: trimmed(v.env) };
}

// chaosRunForgetPlan(services, serviceId, runId) → { serviceId, patch: { chaosRuns }, name } — the
// list without the run (chaosRunId), or null when it is not there.
export function chaosRunForgetPlan(services, serviceId, runId) {
  const existing = (Array.isArray(services) ? services : []).find((s) => s && s.id === serviceId) || null;
  const runs = Array.isArray(existing?.chaosRuns) ? existing.chaosRuns : [];
  const next = runs.filter((r) => chaosRunId(r) !== runId);
  return existing && next.length !== runs.length ? { serviceId: existing.id, patch: { chaosRuns: next }, name: existing.name } : null;
}

const OUTCOME_OPTIONS = [['pass', 'Passed — the expected alerts fired and it recovered'], ['fail', 'Failed — an expected alert did not fire, or it did not recover'], ['aborted', 'Aborted — stopped before it said anything']];

// chaosRunFormModel(form, { access, now }) → what the renderer draws: the experiment (its expected
// MTTD), when, the outcome, the measured MTTD, the expected alerts that fired, a note; Save and
// Cancel; the runs already recorded here, newest first, each with Forget.
export function chaosRunFormModel(form, { access = null, now = Date.now() } = {}) {
  const v = form.values || {};
  const experiments = Array.isArray(form.experiments) ? form.experiments : [];
  const chosen = experiments.find((x) => x.id === v.crExperiment) || null;
  const canWrite = access?.canWrite !== false;
  const env = trimmed(v.env);
  return {
    open: true, mode: 'edit', chaosRun: true, saving: !!form.saving, error: form.error || null, focus: form.focus || null, scroll: !!form.scroll,
    title: `Record a chaos run · ${v.name}${env ? ` · ${env}` : ''}`,
    values: { ...v },
    experiments: experiments.map((x) => ({ id: x.id, label: `${x.id}${x.expectedMttd ? ` — expects MTTD ≤ ${x.expectedMttd}` : ''}`, selected: x.id === v.crExperiment })),
    outcomes: OUTCOME_OPTIONS.map(([value, label]) => ({ value, label, selected: value === v.crOutcome })),
    fired: (chosen?.expectedAlerts || []).map((alert) => ({ alert, field: `${FIRED}${alert}`, checked: v[`${FIRED}${alert}`] === '1' })),
    hint: `Kept with this service${env ? ` for ${env}` : ''} and said as recorded in the studio: the grade's Chaos-validated, the MTTD on the board and the control room read it. A run the repository records later than this one comes first. Save checks the service again, so the grade takes it.`,
    recent: runsHere(form.runs, env).slice(0, 8).map((r) => ({ id: chaosRunId(r), experiment: r.experiment, words: chaosRunWords(r), note: r.note || '' })),
    problems: chaosRunProblems(v, { experiments, tzOffset: form.tzOffset || 0, now, runs: form.runs }),
    canWrite, reason: canWrite ? null : (access?.reason || 'Not available for your role here.'),
  };
}

// What is missing before the form can be saved — { field: sentence }. The
// server judges the rest (an address it cannot read, a folder it may not, an
// endpoint origin it does not allow) and its sentence is shown as written.
// A source switched off (`sources`) is refused here too, before any call:
// only a repository kept exactly as saved (`original`; an upload with
// nothing new staged) may stay on one.
// `taken`: Add environment's — the names the service already has, each refused (it has its own Change).
// `packs`: the form's pack files ({ repo, live }) — Pack file and the Live answer's export each need theirs.
export function formProblems(values = {}, { sources = null, original = null, uploadStaged = false, taken = null, packs = null } = {}) {
  const out = {};
  if (!trimmed(values.name)) out.name = 'Name the service.';
  if (!trimmed(values.env)) out.env = 'Name the environment, e.g. prod.';
  else if (Array.isArray(taken) && taken.includes(trimmed(values.env))) out.env = `${trimmed(values.name)} already has ${trimmed(values.env)} — change it with its own Change.`;
  if (!REPOSITORY_KINDS.some((k) => k.kind === values.kind)) out.kind = 'Choose where the repository is.';
  else if (sourceOff(sources, values.kind)) {
    const kept = !!original && original.kind === values.kind
      && (values.kind === 'upload' ? !uploadStaged : values.kind === 'pack' ? !packs?.repo?.staged : trimmed(values.location) === original.location && trimmed(values.ref) === original.ref);
    if (!kept) out.kind = REPOSITORY_KINDS.every((k) => sourceOff(sources, k.kind)) ? ALL_SOURCES_OFF : `${sourceOffText(values.kind)}: choose another source.`;
  }
  if (values.kind === 'pack') {
    if (!packReady(packs?.repo)) out.location = 'Choose the pack file exported from the repository.';
  } else if (!trimmed(values.location)) {
    out.location = values.kind === 'path' ? "Give the folder's full path on the server."
      : values.kind === 'upload' ? 'Choose a folder or a .zip to upload.' : "Give the repository's address.";
  }
  if (!trimmed(values.endpointId)) out.endpointId = 'Choose the MCP endpoint that reads it live, or a pack file exported from live.';
  else if (values.endpointId === LIVE_PACK && !packReady(packs?.live)) out.endpointId = 'Choose the pack file exported from live.';
  if (values.endpointId === NEW_ENDPOINT) {
    if (!trimmed(values.epUrl)) out.epUrl = "Give the MCP endpoint's URL.";
    if (!trimmed(values.epName)) out.epName = 'Name the endpoint.';
  }
  Object.assign(out, targetsFormProblems(values));
  return out;
}

// The form's note when a save is stopped by formProblems: the switched-off
// source's own sentence when that is the only problem (nothing is missing),
// else that some answers are missing.
export function formProblemsNote(problems = {}) {
  const keys = Object.keys(problems);
  if (keys.length === 1 && keys[0] === 'kind' && /is switched off in Settings/.test(problems.kind)) return problems.kind;
  return 'Some answers are missing — each is marked where it goes.';
}

// formModel(form, { endpoints, register, access, folders, uploads, repoSignIn, now }) → what the renderer draws:
//   register  GET /api/mcp-endpoints' policy.register ({ allowed, why }) — may a new endpoint be registered here
//   folders   loadServiceListFacts' `folders` ({ allowed, why }) — may a folder be picked on the server
//             (Browse…: below); without it the Folder answer is typed, as before
//   uploads   true when the host wires Upload (below): the kind is offered; without it, never
//   repoSignIn  /auth/me's `repoSignIn` (as serviceListModel takes it): a host this server
//             offers sign-in to says so in its hint — a private repository is read as you
//   sources   the org's repository sources (as serviceListModel takes it): a source switched
//             off is not offered, but for the form's own kind, kept and marked off
//   heldTokens  the hosts whose token the person gave in this tab (as serviceListModel takes
//             it; [] when none). A host that passes it draws the person's own token field in
//             the form (`auth`: { kind, label, optional, text }, or null — formAuth) and takes
//             what it holds in saveService({ run, repoAuth }); one that passes none draws no field
export function formModel(form, { endpoints = null, register = null, access = null, folders = null, uploads = false, repoSignIn = null, sources = null, heldTokens = null, now = Date.now() } = {}) {
  if (!form?.open) return { open: false };
  if (form.chaosRun) return chaosRunFormModel(form, { access, now });
  if (form.objectives) return objectivesFormView(form, { access });
  if (form.agreement) return agreementFormView(form, { access });
  const v = form.values || {};
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const canWrite = access?.canWrite !== false;
  const newAllowed = register ? register.allowed !== false : true;
  const offered = REPOSITORY_KINDS
    .filter((k) => ((k.kind !== 'upload' && k.kind !== 'pack') || uploads || v.kind === k.kind) && (!sourceOff(sources, k.kind) || k.kind === v.kind || k.kind === form.original?.kind))
    .map((k) => {
      if (!sourceOff(sources, k.kind)) return { ...k, hint: repositoryHint(k, repoSignIn) };
      // The record's own source, switched off since: it may be kept as it is (and chosen again, to keep it).
      const own = form.original?.kind === k.kind;
      return { ...k, off: true, hint: `${sourceOffText(k.kind)}.${own ? ' A service kept on it as it is still saves its other changes.' : ''}` };
    });
  // A pack file is no switch of its own (it follows Upload's): the switches are named, not the kinds.
  const switchedOff = REPOSITORY_KINDS.filter((k) => k.kind !== 'pack' && sourceOff(sources, k.kind)).map((k) => k.label);
  return {
    open: true, mode: form.mode, saving: !!form.saving, error: form.error || null, focus: form.focus || null, scroll: !!form.scroll,
    // Opened from the board's Set targets… (targetsFormOpened): the Targets answer alone, saved alone.
    targetsOnly: !!form.targetsOnly,
    title: form.targetsOnly ? `MTTD / MTTR targets · ${v.name}${v.env && form.envFixed ? ` · ${v.env}` : ''}`
      : form.addEnv ? `Add an environment to ${v.name}`
      : form.mode === 'edit' ? `${v.name}${v.env && form.envFixed ? ` · ${v.env}` : ''}` : 'Add a service',
    addEnv: !!form.addEnv,
    nameFixed: form.mode === 'edit', envFixed: !!form.envFixed,
    // The service's environments to choose from (the row's Change), or null: a field to type in.
    envChoices: Array.isArray(form.envChoices) ? form.envChoices : null,
    // The branch answer on a service that has its repository: the environment's own (savePlan),
    // left blank the repository's.
    branch: form.mode === 'edit' && branchIsEnvironments(v, form.record)
      ? { placeholder: `branch (${form.defaultRef || 'default'})`, note: `The branch ${trimmed(v.env) || 'this environment'} reads. Left blank, it reads the repository's${form.defaultRef ? ` (${form.defaultRef})` : ' default branch'}.` }
      : { placeholder: 'branch (default)', note: '' },
    values: { ...v },
    kinds: offered.map((k) => ({ ...k, selected: k.kind === v.kind })),
    kind: offered.find((k) => k.kind === v.kind) || offered[0],
    sourcesNote: switchedOff.length ? `Switched off in Settings → Repository sources: ${switchedOff.join(', ')}.` : null,
    auth: formAuth(v, { canWrite, repoSignIn, heldTokens, sources }),
    browse: browseModel(form, v, folders, canWrite),
    upload: uploadModel(form, v, { uploads, canWrite, now }),
    // The pack files: the repository's (Pack file) and the Live answer's export.
    // Pack files, opt-in as Upload is (`uploads`): `wired` draws the Live answer's choice, `offered` its button.
    // The live scope (shown once the Live answer is an MCP endpoint): its fields and where the values came from.
    scope: scopeModel(form, v),
    // The deployment surface this environment reads alone (step 3, under the repository), or { shown: false }.
    surface: surfaceFormModel(form, v),
    packs: { repo: { offered: canWrite && !!uploads, ...packModel(form.packs?.repo, { now }) }, live: { wired: !!uploads, offered: canWrite && !!uploads, chosen: v.endpointId === LIVE_PACK, ...packModel(form.packs?.live, { now }) } },
    endpoints: eps.map((e) => ({ id: String(e.id), name: e.name, origin: e.origin || '', selected: String(e.id) === v.endpointId })),
    newEndpoint: { allowed: newAllowed, reason: newAllowed ? null : (register?.why || 'A new MCP endpoint cannot be registered here.'), selected: v.endpointId === NEW_ENDPOINT },
    // The MTTD / MTTR targets: the dropdown, the custom minutes when chosen, and what they mean.
    targets: {
      options: targetsOptions(v.targetProfile ?? ''),
      custom: v.targetProfile === MTTX_CUSTOM,
      hint: "Kept with this service: the board and the control room measure against them, said as set in the studio, while the repository states none of its own (a repository's own come first). Change them at any time.",
    },
    problems: formProblems(v, { sources, original: form.original ?? null, uploadStaged: !!form.upload?.staged, taken: form.addEnv ? (form.record?.environments || []).map((e) => e.name) : null, packs: form.packs || null }),
    canWrite, reason: canWrite ? null : (access?.reason || 'Not available for your role here.'),
  };
}

// ---------- Browse…: the folder picked on the server ----------
//
// The Folder answer can be picked instead of typed, from the folders the
// server may read (GET /api/repository-folders, whose rule is the one a save
// applies). A browser's own folder dialog cannot answer it: it never gives a
// folder's full path, and every Run reads the folder on the server again.
// Opt-in: a host that passes formModel no `folders` fact draws the form as
// before. The panel's state rides on the form's (`form.browse`); these name
// its steps, and the host fetches between them (overview-api.mjs
// loadRepositoryFolders):
//   Browse…          folderBrowseStart(form.values) → the path to list (null: the top),
//                    folderBrowseOpening(form, path), the fetch
//   the answer       folderBrowseListed(form, listing) | folderBrowseFailed(form, error)
//   a folder in it   folderBrowseOpening(form, path), the fetch again (Up and
//                    Start from the top too: path null is the top)
//   Use this folder  folderBrowseChosen(form, path): the Folder answer, the panel closed
//   Close            folderBrowseClosed(form) — Browse… again too

const FULL_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

// Where Browse… opens: the folder already typed when it is a full path, else the top.
export function folderBrowseStart(values = {}) {
  const typed = trimmed(values.location);
  return values.kind === 'path' && FULL_PATH.test(typed) ? typed : null;
}

// A folder asked for: the panel open and reading, the last listing kept on screen meanwhile.
export function folderBrowseOpening(form, path = null) {
  if (!form?.open) return form;
  return { ...form, browse: { loading: true, asked: trimmed(path) || null, listing: form.browse?.listing ?? null, error: null }, focus: null };
}

// The server's listing (a refusal at the top, allowed: false, is the failure it names).
export function folderBrowseListed(form, listing) {
  if (!form?.open || !form.browse) return form;
  if (!listing || typeof listing !== 'object' || listing.allowed === false) {
    return folderBrowseFailed(form, listing?.why || 'the server does not list folders here');
  }
  return { ...form, browse: { loading: false, asked: form.browse.asked, listing: listingOf(listing), error: null }, focus: 'folders' };
}

// The fetch refused (the server's sentence) or failed: the panel says so, the last listing kept.
export function folderBrowseFailed(form, error) {
  if (!form?.open || !form.browse) return form;
  return { ...form, browse: { ...form.browse, loading: false, error: sentenceOf(error) }, focus: 'folders' };
}

// Use this folder: the Folder answer, the panel closed, the field focused.
export function folderBrowseChosen(form, path) {
  const p = trimmed(path);
  if (!form?.open || !p) return form;
  return { ...form, values: { ...form.values, kind: 'path', location: p }, browse: null, focus: 'location', error: null };
}

export function folderBrowseClosed(form) {
  if (!form?.open || !form.browse) return form;
  return { ...form, browse: null, focus: 'location' };
}

function listingOf(body) {
  const folders = (Array.isArray(body.folders) ? body.folders : [])
    .filter((f) => f && typeof f.path === 'string' && f.path)
    .map((f) => ({ name: String(f.name || f.path), path: f.path, repository: f.repository === true }));
  return {
    path: typeof body.path === 'string' && body.path ? body.path : null,
    up: body.up && typeof body.up === 'object' ? { path: typeof body.up.path === 'string' && body.up.path ? body.up.path : null } : null,
    bounded: body.bounded === true, repository: body.repository === true, folders,
    truncated: body.truncated === true, limit: Number.isFinite(body.limit) ? body.limit : null,
  };
}

// A refusal as one sentence: the status a loader prefixes dropped, the first letter up, a full stop.
function sentenceOf(e) {
  const s = String(e?.message || e || 'the folder could not be read').replace(/^\d{3}: /, '').trim();
  const up = s.charAt(0).toUpperCase() + s.slice(1);
  return /[.!?…]$/.test(up) ? up : `${up}.`;
}

// formModel's `browse`: { offered, open, hint, panel }. `hint` replaces the
// Folder hint when the server will not take a folder from this reader (its
// sentence); `panel` is drawn while the panel is open.
function browseModel(form, v, folders, canWrite) {
  const none = { offered: false, open: false, hint: null, panel: null };
  if (v.kind !== 'path' || !folders || typeof folders !== 'object') return none;
  if (folders.allowed !== true) return { ...none, hint: folders.why ? sentenceOf(folders.why) : null };
  if (!canWrite) return none;
  const b = form.browse;
  if (!b) return { ...none, offered: true };
  const l = b.listing;
  const loading = !!b.loading;
  return {
    offered: true, open: true, hint: null,
    panel: {
      loading, error: b.error || null,
      title: !l ? 'Folders on the server' : (l.path ?? 'The folders this server reads repositories from'),
      path: l?.path ?? null,
      up: l?.up ? { path: l.up.path ?? '' } : null,                // '' — the top
      folders: l ? l.folders.map((f) => ({ ...f })) : [],
      empty: !!l && !loading && !b.error && l.folders.length === 0,
      note: l?.truncated ? `Only the first ${l.limit ?? l.folders.length} folders are listed: type the rest of the path to go further.` : '',
      here: l?.repository ? 'This folder is a repository.' : '',
      choose: { enabled: !!l?.path && !loading, path: l?.path ?? '' },
      restart: !!b.error && !loading && (b.asked !== null || !!l?.path),
    },
  };
}

// ---------- Upload: the repository from the person's own machine ----------
//
// The files a person picks — a folder or a .zip — are read by their browser
// (the host's: studio/repository-files.mjs in the studio) and kept on the
// server as the service's copy (PUT /api/services/:id/repository-upload); each
// Run scans the copy. Opt-in: formModel offers the kind only with `uploads`.
// The state rides on the form (`form.upload`); the host reads between the
// steps:
//   a pick or a drop   uploadReading(form, name), then the host reads the files
//   the files read     uploadStaged(form, { name, files, bytes, skipped, ignored, truncated })
//   a read that failed uploadFailed(form, error)
// The save plan carries the staged files (savePlan's `upload`); nothing is
// sent before Save.

// A size as a person reads it: KB under a megabyte (never "0 MB"), MB with one decimal above.
const mbText = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`);

export function uploadReading(form, name) {
  if (!form?.open) return form;
  return { ...form, upload: { reading: String(name || 'the files') }, values: { ...form.values, kind: 'upload' }, error: null };
}

export function uploadStaged(form, read) {
  if (!form?.open) return form;
  const files = read?.files && typeof read.files === 'object' ? read.files : {};
  const count = Object.keys(files).length;
  if (!count) return uploadFailed(form, `${read?.name || 'That folder'} holds no file the scan reads — Prometheus rules, collector configs, dashboards, compose files, Helm values or metrics code`);
  const staged = {
    name: String(read.name || 'upload'), files, count, bytes: Number(read.bytes) || 0,
    skipped: Array.isArray(read.skipped) ? read.skipped : [], ignored: Number(read.ignored) || 0, truncated: read.truncated === true,
  };
  return { ...form, upload: { staged }, values: { ...form.values, kind: 'upload', location: staged.name }, error: null, focus: 'upload' };
}

export function uploadFailed(form, error) {
  if (!form?.open) return form;
  return { ...form, upload: { error: sentenceOf(error) }, focus: 'upload' };
}

// A pack file picked on the form — `side` 'repo' (in place of the repository) or 'live' (an export of
// live in place of the MCP endpoint): reading, then staged ({ name, text, bytes }) or failed. Staging the
// repository's chooses the Pack file kind; the live one, the Live answer's export.
const PACK_SIDES = ['repo', 'live'];
export function packReading(form, side, name) {
  if (!form?.open || !PACK_SIDES.includes(side)) return form;
  return { ...form, packs: { ...(form.packs || {}), [side]: { ...(form.packs?.[side] || {}), reading: String(name || 'the file'), error: null } }, error: null };
}
export function packStaged(form, side, file) {
  if (!form?.open || !PACK_SIDES.includes(side)) return form;
  const text = typeof file?.text === 'string' ? file.text : '';
  if (!text.trim()) return packFailed(form, side, `${file?.name || 'That file'} is empty`);
  const staged = { name: String(file.name || 'pack.yaml'), text, bytes: Number(file.bytes) || text.length };
  const packs = { ...(form.packs || {}), [side]: { kept: form.packs?.[side]?.kept || null, staged } };
  const values = side === 'repo' ? { ...form.values, kind: 'pack', location: staged.name } : { ...form.values, endpointId: LIVE_PACK };
  return { ...form, packs, values, error: null, focus: side === 'repo' ? 'pack-repo' : 'pack-live' };
}
export function packFailed(form, side, error) {
  if (!form?.open || !PACK_SIDES.includes(side)) return form;
  return { ...form, packs: { ...(form.packs || {}), [side]: { kept: form.packs?.[side]?.kept || null, error: sentenceOf(error) } }, focus: side === 'repo' ? 'pack-repo' : 'pack-live' };
}
// The form's pack file of a side, as drawn: { state: 'empty' | 'reading' | 'staged' | 'kept' | 'failed', text, error }.
function packModel(p, { now }) {
  if (p?.reading) return { state: 'reading', text: `Reading ${p.reading}…`, error: null };
  if (p?.staged) return { state: 'staged', text: `${p.staged.name} — read, sent with Save`, error: null };
  if (p?.error) return { state: 'failed', text: '', error: p.error };
  if (p?.kept) return { state: 'kept', text: `${p.kept.name}${p.kept.uploadedAt ? `, uploaded ${agoText(p.kept.uploadedAt, now)}` : ''} — kept; choose another to replace it`, error: null };
  return { state: 'empty', text: 'No file chosen yet.', error: null };
}
const packReady = (p) => !!(p?.staged || p?.kept);

// formModel's `scope`: { shown, from: 'environment' | 'server' | null, hint, fields: [{ value, label,
// placeholder, fromDefault }], dropped, offerDefault, defaultIgnored, check }.
// `from` is where the values now on the form stand: the server default's pre-fill while they still
// equal it. `fromDefault`: the field still holds the pre-filled value. `dropped`: the sentence when a
// save would not keep pre-filled answers (scopeDropped, read as savePlan reads it: a blank Add whose
// name keys a service already listed keeps none of them). The hint says what a save keeps.
// `offerDefault`: Use the server default — for an environment that exists with no scope of its own
// while the server has a default, and for a new one whose default names no metric prefixes (never
// pre-filled: scopePrefillOf). `defaultIgnored`: the row's sentence for the first
// (SCOPE_DEFAULT_IGNORED). `check`: the scope check's answer, worded.
function scopeModel(form, v) {
  const shown = !!v.endpointId && v.endpointId !== LIVE_PACK;
  const typed = scopeFromValues(v);
  const defaults = form.scopeDefaults || null;
  const prefill = form.scopePrefill || null;
  const pre = prefill ? scopeFormValues(prefill) : null;
  const fields = SCOPE_FIELDS.map((f) => ({ value: f.value, label: f.label, placeholder: f.placeholder, fromDefault: !!pre && pre[f.value] !== '' && String(v[f.value] ?? '') === pre[f.value] }));
  const from = typed && prefill && sameScope(typed, prefill) ? 'server' : typed ? 'environment' : null;
  const env = form.addEnv ? null : (form.record?.environments || []).find((x) => x?.name === trimmed(v.env)) || null;
  const was = env?.liveScope && typeof env.liveScope === 'object' && Object.keys(env.liveScope).length ? env.liveScope : null;
  const ignored = !!env && !was && !!defaults && !prefill;
  // As savePlan reads it (scopeKnown || !existing): a form opened on no record whose name keys a
  // service already listed completes that record, onto which no pre-filled answer is saved.
  const known = !!form.record || !(Array.isArray(form.listedSlugs) && form.listedSlugs.includes(defaultKeyOf(v.name)));
  const dropped = scopeDropped(v, { prefill, known, was });
  const kept = dropped.length ? scopeSaveOf(v, { was, prefill, known }) : typed;
  const fieldNames = { metricPrefixes: 'metric prefixes', folderUids: 'folder uids', metricExclude: 'exclude patterns', ruleGroups: 'rule groups', datasourceUid: 'datasource uid' };
  const names = dropped.map((f) => fieldNames[f.field]);
  const joined = names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const refused = form.scopePrefillRefused || null;
  const service = trimmed(v.name) || 'this service';
  const envName = trimmed(v.env) || 'this environment';
  const hint = from === 'server' && !dropped.length ? "Pre-filled from the server default: saved as this environment's own scope. Change or clear any field — the server default never applies on its own."
    : kept ? `This environment's own scope: each Run reads only ${scopeSummary(kept)} of the estate, and the match counts only that.`
      : typed ? `None of these answers is saved as ${envName}'s live scope.`
        : refused?.unprefixed ? `Empty: the server default (${scopeSummary(defaults) || 'set on the server'}) names no metric prefixes, so nothing shows it is ${service}'s — it is not pre-filled. Use the server default to make it this environment's own.`
          : refused ? `Empty: the server default (prefixes ${refused.defaultPrefixes.join(', ')}) is for another service — ${refused.servicePrefixes ? `${service}'s environments read ${refused.servicePrefixes.join(', ')}` : `${service}'s repository declares no metric with those prefixes`}.`
            : ignored ? `${SCOPE_DEFAULT_IGNORED}. Each Run reads the whole estate the endpoint serves; the server default (${scopeSummary(defaults)}) is not applied to an environment that exists — Use the server default to make it this environment's own.`
              : 'Empty: the whole estate the endpoint serves is read. Set prefixes or folders when it serves more than this service.';
  const presetPrefixes = prefixesOf(prefill);
  const droppedText = !dropped.length ? null
    : was ? `${envName} has a live scope of its own: the server default's ${joined} will not be saved over it.`
      : !known ? `${service} is a service already listed, and this form was not opened on it: the server default's ${joined} will not be saved for ${envName} — type your own, or use Change on its row.`
        : presetPrefixes.length ? `The server default is for the metric prefixes ${presetPrefixes.join(', ')}: its ${joined} will not be saved for this environment — type them again to keep them.`
          : `The server default names no metric prefixes, so nothing says it is for ${scopeList(v.scopePrefixes, 'comma').join(', ')}: its ${joined} will not be saved for this environment — type them again to keep them.`;
  return {
    shown, from, hint, fields,
    dropped: droppedText,
    offerDefault: (ignored || (!!refused?.unprefixed && !!defaults && !prefill)) && !typed,
    defaultIgnored: ignored ? SCOPE_DEFAULT_IGNORED : null,
    check: scopeCheckModel(form, v),
  };
}

// formModel's `surface`: { shown, label, options: [{ id, label, selected }], hint } — the deployment
// surface this environment reads alone, off ('') by default: every environment of a service reads the
// same files. Not shown for a pack file (no scan) or on a server that keeps none (form.surfaceKnown).
function surfaceFormModel(form, v) {
  if (v.kind === 'pack' || !form.surfaceKnown) return { shown: false };
  const chosen = SURFACE_IDS.includes(v.surface) ? v.surface : '';
  const env = trimmed(v.env) || 'this environment';
  const hint = chosen
    ? `${env} reads only the ${surfaceLabel(chosen)} files; its row says how many the filter left out.`
    : `Off: every environment of ${trimmed(v.name) || 'the service'} reads the same files. Chosen, ${env} reads only that surface's files, and its row says how many the filter left out.`;
  return { shown: true, label: 'Read only this deployment surface', options: DEPLOYMENT_SURFACE_CHOICES.map((c) => ({ id: c.id, label: c.label, selected: c.id === chosen })), hint };
}

// formModel's `upload`: { offered, state: 'empty' | 'reading' | 'staged' | 'kept' | 'failed', text, note, error }.
function uploadModel(form, v, { uploads, canWrite, now }) {
  if (v.kind !== 'upload') return { offered: !!uploads, state: null, text: '', note: '', error: null };
  const u = form.upload || {};
  const base = { offered: !!uploads && canWrite, error: null, note: '' };
  if (u.reading) return { ...base, state: 'reading', text: `Reading ${u.reading}…` };
  if (u.staged) {
    const s = u.staged;
    const parts = [];
    if (s.skipped.length) parts.push(`${s.skipped.length} not read: ${s.skipped.slice(0, 3).map((x) => `${x.path} (${x.why})`).join('; ')}${s.skipped.length > 3 ? '; …' : ''}`);
    if (s.truncated) parts.push(`it stops at ${mbText(15 * 1024 * 1024)}: upload only the folder the scan needs`);
    return { ...base, state: 'staged', text: `${s.name} · ${s.count} file${s.count === 1 ? '' : 's'} · ${mbText(s.bytes)} — uploaded when you save.`, note: parts.join(' · ') };
  }
  const failed = u.error ? { error: u.error } : {};
  if (form.uploaded) {
    const k = form.uploaded;
    const ago = k.uploadedAt ? agoText(k.uploadedAt, now) : '';
    return { ...base, ...failed, state: u.error ? 'failed' : 'kept', text: `${k.name} · uploaded${ago ? ` ${ago}` : ''}${k.files !== null ? ` · ${k.files} file${k.files === 1 ? '' : 's'}` : ''}.${base.offered ? ' Choose again to replace it.' : ''}` };
  }
  return { ...base, ...failed, state: u.error ? 'failed' : 'empty', text: 'Choose the folder, or a .zip of it, from your machine.' };
}

// The calls a save makes, in order, from the form's values and the facts on
// hand — pure, so every host saves alike:
//   endpoint  { create: { name, url, readTokenEnv? } } | { id }
//   service   { create: { name, repository } } | { id, patch: { repository } | null }
//   env       { create: { name } } | { id, bind: boolean } — bind: point it at the endpoint
//   upload    { name, files, skipped } | null — PUT /api/services/:id/repository-upload, last;
//             `skipped` what the browser did not read and why, kept with the copy so each Run names it
// The service's MTTD / MTTR targets ride on its create, or on its patch when they differ from the
// record's (mttx-targets.mjs targetsFromForm: { profile } | { profile: 'custom', mttd, mttr } | null)
// — for a record the form was opened on (`serviceId`), or one a typed name reached only when the
// person answered the targets (`targetsTouched`) or it has none: an Add that completes a record never
// replaces the targets it has with the form's own start.
// A name that keys an existing record (the catalogue's slug rule, `keyOf`,
// injected: tools/lib/service-keys.mjs normalizeServiceKey) is that record —
// the form completes it, never a second one. An Upload never names its
// repository: the service is created without one (or left as it is) and the
// upload points it at its copy; `upload` is the staged files (form.upload.staged).
// `packs`: the form's pack files ({ repo, live }); a staged one is sent after the record and the
// environment exist (PUT /api/services/:id/repository-pack, PUT /api/environments/:id/live-pack):
// `repoPack` / `livePack` { name, text } or null (a kept one is left as it is).
// `scopePrefill`: the server default the form was pre-filled with (form.scopePrefill; a host that
// passes only `scopeDefaults` has it taken as the pre-fill) — the scope a save keeps is scopeSaveOf's:
// a scope typed equal to it IS the environment's own (the default never applies on its own), its
// answers never written over a scope of the environment's own; the service's liveScopes map is sent
// whole (POST, PATCH) only when this environment's entry changes. An export of live has no scope.
// `scopeKnown`: the form was opened on this service's record (false for a blank Add that names an
// existing service — its environment's scope was never drawn, so an empty answer leaves it as it is;
// the same for its deployment surface, envSurfaces).
export function savePlan(values, { services = [], keyOf = defaultKeyOf, serviceId = null, upload = null, targetsTouched = false, packs = null, scopeDefaults = null, scopePrefill = undefined, scopeKnown = true } = {}) {
  const name = trimmed(values.name);
  const envName = trimmed(values.env);
  // A pack file is set by its own upload, never named in the record's create or patch — as an upload.
  const uploading = values.kind === 'upload' || values.kind === 'pack';
  const liveExport = values.endpointId === LIVE_PACK;
  const list = Array.isArray(services) ? services.filter(Boolean) : [];
  const existing = list.find((s) => s.id === serviceId) || list.find((s) => s.slug === keyOf(name)) || null;
  // The branch answered is this environment's when the record already reads this same GitHub or
  // Azure DevOps repository: the repository keeps its own branch (the one an environment left blank
  // reads) and the answer goes to the service's envRefs — one that is the repository's, or blank,
  // is no branch of its own. A new repository, or a new service, takes it as the repository's.
  const typedRef = trimmed(values.ref);
  const was = existing?.repository || null;
  const perEnv = branchIsEnvironments(values, existing);
  const repository = perEnv
    ? { kind: was.kind, location: was.location, ...(was.ref ? { ref: was.ref } : {}) }
    : { kind: values.kind, location: trimmed(values.location), ...(typedRef ? { ref: typedRef } : {}) };
  let envRefs = null;
  if (perEnv) {
    const current = existing.envRefs && typeof existing.envRefs === 'object' ? existing.envRefs : {};
    const next = { ...current };
    if (typedRef && typedRef !== (was.ref || '')) next[envName] = typedRef;
    else delete next[envName];
    const key = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (key(next) !== key(current)) envRefs = next;
  } else if (was && existing.envRefs && Object.keys(existing.envRefs).length && (was.kind !== values.kind || was.location !== trimmed(values.location))) {
    // Another repository: the branches named for the old one go (the server clears them too).
    envRefs = {};
  }
  const endpoint = liveExport ? { livePack: true }
    : values.endpointId === NEW_ENDPOINT
    ? { create: { name: trimmed(values.epName), url: trimmed(values.epUrl), ...(trimmed(values.epToken) ? { readTokenEnv: trimmed(values.epToken) } : {}) } }
    : { id: Number(values.endpointId) };
  const sameRepo = (r) => !!r && r.kind === repository.kind && r.location === repository.location && (r.ref || '') === (repository.ref || '');
  const targets = targetsFromForm(values);
  // Compared as the record would keep them (who and when aside): unchanged targets are not sent.
  // …or a record with none yet: the targets the form showed chosen are the ones it gets.
  const mayRetarget = !!existing && (existing.id === serviceId || targetsTouched === true || !existing.targets);
  const targetsChanged = mayRetarget && !sameTargets(existing.targets ?? null, targets ? targetsRecord(targets) : null);
  let liveScopes = null;
  if (!liveExport) {
    const current = existing?.liveScopes && typeof existing.liveScopes === 'object' ? existing.liveScopes : {};
    const was = current[envName] ?? null;
    // What the save keeps (scopeSaveOf): an untouched own scope as kept, else what is typed, never a
    // pre-filled server default written over the environment's own or onto a record not drawn here.
    const own = scopeSaveOf(values, { was, prefill: scopePrefill !== undefined ? scopePrefill : scopeDefaults, known: scopeKnown || !existing });
    const next = { ...current };
    if (own) next[envName] = own; else if (scopeKnown) delete next[envName];
    if (!sameScope(current[envName] ?? null, next[envName] ?? null)) liveScopes = next;
  }
  // The deployment surface this environment reads alone (values.surface, '' for every file): the
  // service's envSurfaces map, sent whole only when this environment's entry changes. A pack file
  // is no scan, so it leaves the setting as it is; so does a blank Add naming an existing service
  // that never drew it (scopeKnown false), unless one is chosen.
  let envSurfaces = null;
  if (values.kind !== 'pack' && Object.hasOwn(values, 'surface')) {
    const current = existing?.envSurfaces && typeof existing.envSurfaces === 'object' ? existing.envSurfaces : {};
    const chosen = SURFACE_IDS.includes(trimmed(values.surface)) ? trimmed(values.surface) : '';
    const next = { ...current };
    if (chosen) next[envName] = chosen; else if (scopeKnown) delete next[envName];
    const key = (m) => JSON.stringify(Object.keys(m).sort().map((k) => [k, m[k]]));
    if (key(next) !== key(current)) envSurfaces = next;
  }
  const patchOf = (repo) => {
    const p = { ...(repo ? { repository: repo } : {}), ...(targetsChanged ? { targets } : {}), ...(envRefs ? { envRefs } : {}), ...(liveScopes ? { liveScopes } : {}), ...(envSurfaces ? { envSurfaces } : {}) };
    return Object.keys(p).length ? p : null;
  };
  let service;
  const scopesOnCreate = { ...(liveScopes && Object.keys(liveScopes).length ? { liveScopes } : {}), ...(envSurfaces && Object.keys(envSurfaces).length ? { envSurfaces } : {}) };
  if (uploading) service = existing ? { id: existing.id, patch: patchOf(null) } : { create: { name, targets, ...scopesOnCreate } };
  else service = existing ? { id: existing.id, patch: patchOf(sameRepo(existing.repository) ? null : repository) } : { create: { name, repository, targets, ...scopesOnCreate } };
  const env = existing ? (existing.environments || []).find((e) => e.name === envName) || null : null;
  return {
    endpoint, service,
    // An export of live: no endpoint to bind (its upload unbinds the one there).
    env: env ? { id: env.id, bind: !liveExport && !(endpoint.id !== undefined && env.mcpEndpoint?.id === endpoint.id) } : { create: { name: envName } },
    upload: values.kind === 'upload' && upload?.files ? { name: upload.name, files: upload.files, skipped: Array.isArray(upload.skipped) ? upload.skipped : [] } : null,
    repoPack: values.kind === 'pack' && packs?.repo?.staged ? { name: packs.repo.staged.name, text: packs.repo.staged.text } : null,
    livePack: liveExport && packs?.live?.staged ? { name: packs.live.staged.name, text: packs.live.staged.text } : null,
    envName, name,
  };
}
function defaultKeyOf(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
