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
// Four status words, ever: Never checked · Unchanged · Changed · Unreachable.
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
import { instrumentGradeFor, INSTRUMENT_GRADE_SCALE, layerItemsFor, POSTURE_LAYERS, POSTURE_MECHANISMS_PER_LAYER } from './diagnostic-grade.mjs';
import { LAYER_DEFS } from './constants.mjs';

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
// without one — the pack is the surer link. Among several, the one whose
// scope.env is the environment on screen; else the first.
export function journeyForService(journeys, { slug = null, env = null, packId = null } = {}) {
  const list = Array.isArray(journeys) ? journeys.filter(Boolean) : [];
  const mine = list.filter((j) => {
    const scoped = slug && normalizeKey(j.scope?.service) === normalizeKey(slug);
    const byPack = packId && baseName(j.packA) === `${packId}.pack.yaml`;
    return scoped || byPack;
  });
  if (!mine.length) return null;
  return mine.find((j) => env && j.scope?.env === env) || mine[0];
}

// The listing says where Pack B comes from: "mcp: <url>" for a live draft,
// a file path for a recording. Only a live journey can be checked again — a
// re-read of a recording proves nothing about production.
export function journeyIsLive(journey) {
  return /^mcp:/i.test(String(journey?.packB || ''));
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
  // The check before saw nothing at all: there is no earlier picture to have
  // shrunk from (the first good check after an outage is a recovery).
  if (v.from?.vantage === 'lost') return [];
  const from = Array.isArray(v.from?.failed) ? v.from.failed : [];
  const to = Array.isArray(v.to?.failed) ? v.to.failed : [];
  return to.filter((f) => !from.includes(f));
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
// schema 2: one point each, Drift-free fractional), each as one plain
// sentence with a yes / partly / no mark, the yeses first. Five read the
// repository alone and come from the pack-alone diagnostic's criteria; the
// two that need the other side (Drift-free, Fresh) come from the run that
// graded the letter on screen, or say that nothing live was checked. The
// list is offered only when it adds up to the letter shown (within two
// points of a hundred): a run of another schema, or a pack whose own
// annotations already carry live evidence, explains nothing and shows nothing.
const GRADE_POINTS = 7;
const GRADE_SCHEMA = 2;
const GRADE_BAR = 85;
const WHY_RANK = { yes: 0, partly: 1, no: 2 };
const criterionOf = (diagnostic, key) => [...(diagnostic?.coverage?.criteria || []), ...(diagnostic?.trust?.criteria || [])].find((c) => c && c.key === key) || null;
const numbersIn = (s) => (String(s || '').match(/\d+(?:\.\d+)?/g) || []).map(Number);
const tenth = (n) => String(Math.round(n * 10) / 10);

// The five criteria that read the repository alone, from the engine's
// criteria (key, pass, detail) — the numbers are read back out of the detail.
function repositoryGradeLines(diagnostic) {
  const keys = ['multi-modal', 'correlated', 'calibrated', 'comprehensive', 'chaos-validated'];
  const c = Object.fromEntries(keys.map((k) => [k, criterionOf(diagnostic, k)]));
  if (keys.some((k) => !c[k])) return null;
  const [got = 0, of = 4] = numbersIn(c['multi-modal'].detail);
  const kinds = (String(c['multi-modal'].detail).match(/\(([^)]*)\)/) || [])[1] || '';
  const [objectives = 0] = numbersIn(c.calibrated.detail);
  const [coverage = 0] = numbersIn(c.comprehensive.detail);
  const [experiments = 0] = numbersIn(c['chaos-validated'].detail);
  const line = (crit, yes, no) => ({ ok: crit.pass ? 'yes' : 'no', text: crit.pass ? yes : no });
  return [
    line(c['multi-modal'],
      `${got} of ${of} kinds of signal are collected${kinds ? `: ${kinds}` : ''}.`,
      got ? `Only ${got} of ${of} kinds of signal ${got === 1 ? 'is' : 'are'} collected${kinds ? `: ${kinds}` : ''}.` : 'No kind of signal is collected yet.'),
    line(c.correlated,
      'Traces and logs can be joined, so one request can be followed end to end.',
      'Traces and logs cannot be joined, so a request cannot be followed end to end.'),
    line(c.calibrated,
      `Normal is defined with numbers: ${objectives} objective${objectives === 1 ? '' : 's'}, with detection and repair baselines.`,
      /no .*baselines/i.test(c.calibrated.detail) ? 'Normal is not defined with numbers: no detection and repair baselines.' : 'Normal is not defined with numbers: no objective has a target.'),
    line(c.comprehensive,
      `Coverage reaches ${coverage} in 100 across infrastructure, platform, application and user experience.`,
      `Coverage reaches only ${coverage} in 100 across infrastructure, platform, application and user experience.`),
    line(c['chaos-validated'],
      `Recovery has been proven by fault injection: ${experiments} experiment${experiments === 1 ? '' : 's'}.`,
      'Recovery has never been proven by fault injection.'),
  ];
}

// The two criteria that need the other side, from the run that graded the
// letter on screen: Drift-free is the integrity of the declared commitment
// chains (the run's traceability), Fresh the age of the live picture when
// the run read it. Null when the run scored drift on another construct.
function liveGradeLines(run, { against, where, now }) {
  if (run?.grade?.driftConstruct !== 'requirement-chain' || !(Number(run.traceability?.declaredTotal) > 0)) return null;
  const pct = Number(run.traceability.integrityPct);
  if (!Number.isFinite(pct)) return null;
  const ageHours = Number(run.freshness?.liveAgeHours);
  const fresh = Number.isFinite(ageHours) ? ageHours * 3600e3 <= FRESH_WINDOW_MS : true;
  return [
    { ok: pct >= GRADE_BAR ? 'yes' : (pct > 0 ? 'partly' : 'no'), score: Math.max(0, Math.min(1, pct / 100)),
      text: `Of what the repository promises, ${Math.round(pct)} in 100 holds up ${where}; the bar is ${GRADE_BAR}.` },
    { ok: fresh ? 'yes' : 'no',
      text: fresh ? `Checked ${against} ${agoText(run.startedAt, now)}.` : `The ${where === 'live' ? 'live picture' : 'recording'} was more than a day old when it was checked.` },
  ];
}

const gradePoints = (lines) => lines.reduce((n, l) => n + (l.ok === 'yes' ? 1 : l.ok === 'partly' ? (l.score ?? 0) : 0), 0);

// "4.8 of 7 points. B+ starts at 5.3." — the next band up in points, so the
// distance to the next letter is one subtraction.
function pointsText(points, letter) {
  const bands = INSTRUMENT_GRADE_SCALE.filter((g) => g.minPct !== null).reverse();
  const i = bands.findIndex((g) => g.letter === letter);
  const next = i >= 0 ? bands[i + 1] : null;
  const head = `${tenth(points)} of ${GRADE_POINTS} points.`;
  if (!next) return head;
  return `${head} ${next.letter} starts ${next.exclusiveMin ? 'above' : 'at'} ${tenth(next.minPct / 100 * GRADE_POINTS)}.`;
}

// gradeWhy({ diagnostic, run, letter, score, against, where, now }) → { why, points }
//   why     [{ ok: 'yes' | 'partly' | 'no', text }] — seven lines, or none
//   points  "4.8 of 7 points. B+ starts at 5.3." — or ''
export function gradeWhy({ diagnostic = null, run = null, letter = '', score = null, against = 'against live', where = 'live', now = Date.now() } = {}) {
  const none = { why: [], points: '' };
  if (run && run.grade?.schema != null && Number(run.grade.schema) !== GRADE_SCHEMA) return none;
  if (diagnostic?.gradeSchema != null && Number(diagnostic.gradeSchema) !== GRADE_SCHEMA) return none;
  const fixed = repositoryGradeLines(diagnostic);
  if (!fixed) return none;
  const live = run ? liveGradeLines(run, { against, where, now }) : [
    { ok: 'no', text: 'Nothing live has been checked, so no promise is confirmed live.' },
    { ok: 'no', text: 'Never checked against live.' },
  ];
  if (!live) return none;
  const lines = [...fixed, ...live];
  const points = gradePoints(lines);
  const pct = Number(score);
  if (Number.isFinite(pct) && Math.abs(points / GRADE_POINTS * 100 - pct) > 2) return none;
  const why = lines.slice().sort((a, b) => WHY_RANK[a.ok] - WHY_RANK[b.ok]).map(({ ok, text }) => ({ ok, text }));
  return { why, points: pointsText(points, letter) };
}

const toneForLetter = (letter) => {
  const l = String(letter || '');
  if (l.startsWith('A')) return l === 'A++' ? GRADE_TONE.ref : GRADE_TONE.a;
  if (l.startsWith('B')) return GRADE_TONE.b;
  if (l === 'C') return GRADE_TONE.c;
  if (l === 'D') return GRADE_TONE.d;
  return 'neutral';
};

// gradeModel({ pack, how, diagnostic, diagnosticError, run, journey, now })
//   diagnostic   computeDiagnosticGrade(packA alone)  — the repository's own grade
//   run          the journey's newest run record      — the same engine against live
// The run's letter wins when the run graded this pack and could see the live
// side (outcome pass or gate-failed); otherwise the pack-alone grade, and the
// source line says which. A live recording as Pack B is graded "against a
// recording", never "against live".
export function gradeModel({ pack = null, how = 'none', diagnostic = null, diagnosticError = null, run = null, journey = null, now = Date.now() } = {}) {
  if (!pack || how === 'none') {
    return { letter: '–', label: 'No pack yet', word: 'Nothing to grade: no pack is registered for this service.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '' };
  }
  if (how !== 'primary') {
    return { letter: '–', label: 'No pack of its own', word: 'This service appears in a live draft, but no pack of its own is registered yet.', source: '', tone: 'neutral', title: '', basis: 'none', why: [], points: '' };
  }
  // A run that saw less of the live side than the check before graded a
  // smaller picture: not usable as the letter, and the source line says so.
  const shrank = vantageShrank(run);
  const usable = run && (run.outcome === 'pass' || run.outcome === 'gate-failed') && run.grade?.letter && !shrank.length && runGradedPack(run, pack);
  if (usable) {
    const ig = instrumentGradeFor(Number(run.grade.score)) || { letter: run.grade.letter, label: run.grade.letterLabel || '', blurb: '' };
    const letter = run.grade.letter;
    const label = shortGradeLabel({ label: run.grade.letterLabel || ig.label });
    const recording = journey ? !journeyIsLive(journey) : !/^mcp:/i.test(String(run.packB?.source || ''));
    const against = recording ? 'against a live recording' : 'against live';
    return {
      letter, label, word: verdictWordFor(run.grade.score),
      source: `Graded ${against}, ${agoText(run.startedAt, now)}.`,
      tone: toneForLetter(letter), title: `${letter} · ${run.grade.letterLabel || ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
      basis: recording ? 'recording' : 'live',
      ...gradeWhy({ diagnostic, run, letter, score: run.grade.score, against, where: recording ? 'in the recording' : 'live', now }),
    };
  }
  if (diagnosticError) {
    return { letter: '?', label: 'Not graded', word: `The pack could not be read: ${diagnosticError}`, source: '', tone: 'neutral', title: '', basis: 'error', why: [], points: '' };
  }
  if (!diagnostic?.overall) {
    return { letter: '·', label: 'Reading…', word: '', source: '', tone: 'neutral', title: '', basis: 'pending', why: [], points: '' };
  }
  const ig = diagnostic.overall.instrumentGrade || instrumentGradeFor(diagnostic.overall.audit?.scorePctExact ?? 0);
  const lost = run && run.outcome === 'vantage-lost' && runGradedPack(run, pack);
  const partial = !lost && run && shrank.length > 0 && runGradedPack(run, pack);
  return {
    letter: ig.letter, label: shortGradeLabel(ig), word: diagnostic.overall.verdict?.word || verdictWordFor(diagnostic.overall.audit?.scorePctExact),
    source: lost ? 'Graded from the repository alone; the last live check could not see production.'
      : partial ? 'Graded from the repository alone; the last live check saw only part of production.'
        : 'Graded from the repository alone.',
    tone: GRADE_TONE[ig.tier] || 'neutral', title: `${ig.letter} · ${ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
    basis: 'repository',
    ...gradeWhy({ diagnostic, letter: ig.letter, score: diagnostic.overall.audit?.scorePctExact, now }),
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

// stillTrueModel({ journey, run, now, running, startError, journeysError })
//   journey   the GET /api/journeys entry for this service (or null)
//   run       its newest run record (GET /api/journeys/:name/runs?limit=1), or null
// Returns { status (one of OVERVIEW_STATUS keys or null), pill, sentence, note,
//   cadence, stale, canCheck, checkLabel, checkPrimary, tone, error }.
export function stillTrueModel({ journey = null, run = null, now = Date.now(), running = false, startError = null, journeysError = null, pending = false } = {}) {
  const live = journeyIsLive(journey);
  // The cadence line belongs to a check this screen can run; a recording has nothing to click.
  const cadence = journey && live ? (journey.schedule ? 'Checks run on a schedule.' : 'Checks run only when you click.') : '';
  const base = { status: null, pill: '', sentence: '', note: '', cadence, stale: false, canCheck: false, checkLabel: '', checkPrimary: false, tone: 'neutral', error: startError || null, pending: false, running: false };
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
  const startedMs = Date.parse(run.startedAt || '');
  const stale = Number.isFinite(startedMs) && now - startedMs > FRESH_WINDOW_MS;
  if (run.outcome === 'vantage-lost') {
    return { ...base, status: 'unreachable', pill: OVERVIEW_STATUS.unreachable, tone: 'warn', stale,
      sentence: `Last check ${ago}: the live side did not answer, so nothing is known about it right now.`,
      canCheck: false, checkLabel: '' };
  }
  const recording = !live;
  const when = run.packB?.refreshedAt ? dayMonth(run.packB.refreshedAt) : '';
  const against = recording ? `against a live recording${when ? ` from ${when}` : ''}` : 'against live';
  const k = differenceCount(run);
  const extra = Number(run.drift?.liveNotDeclared) || 0;
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
  // The live side showed less than the check before: the counts are not
  // comparable, so the sentence says so instead of announcing a difference,
  // and Check again (the next step's primary) is the one thing to do.
  const shrank = vantageShrank(run);
  if (shrank.length) {
    return { ...base, status: 'changed', pill: OVERVIEW_STATUS.changed, tone: 'warn', stale,
      sentence: `Checked ${ago} ${against} — the live side showed less than the check before: its ${listWords(shrank.map(familyWord))} could not be read, so what differs cannot be told yet.`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
  }
  if (k === 0) {
    // Live-only things are not a difference from what the repository
    // declares, but they are not hidden either: the sentence names them.
    const more = extra ? ` ${extra} more ${extra === 1 ? 'thing runs' : 'things run'} live that it does not declare.` : '';
    return { ...base, status: 'unchanged', pill: OVERVIEW_STATUS.unchanged, tone: stale ? 'warn' : 'ok', stale,
      sentence: `Checked ${ago} ${against} — it matches: everything the repository declares is running live.${more}${since}`,
      canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: live && !stale && !extra };
  }
  return { ...base, status: 'changed', pill: OVERVIEW_STATUS.changed, tone: 'warn', stale,
    sentence: `Checked ${ago} ${against} — ${things(k)} ${k === 1 ? 'differs' : 'differ'} from what the repository declares.${since}`,
    canCheck: live && !stale, checkLabel: 'Check again', checkPrimary: false };
}

function statusOf(run) {
  if (!run) return 'never';
  if (run.outcome === 'vantage-lost') return 'unreachable';
  return differenceCount(run) === 0 ? 'unchanged' : 'changed';
}

// ---------- what to do next ----------

// nextActionModel({ still, grade, decision, run, journey })
//   decision  buildAssessmentDecision(...) for the pack alone (its causes name
//             what keeps the grade down when nothing live was checked)
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

function nextActionCore({ still = null, grade = null, decision = null, run = null, journey = null, now = Date.now() } = {}) {
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
    return live
      ? { sentence: 'Check again once the live side answers; until then nothing is known.', button: { label: 'Check again', action: 'ov-check' }, why: ['The live side did not answer the last check.'], primary: true }
      : { sentence: 'The recording could not be read; open Expert mode to look.', button: { label: 'Open Expert mode', action: 'ov-expert' }, why: [], primary: true };
  }
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
  if (still.status === 'unchanged') {
    // The still-true panel's Check again is the primary when there is one.
    const extra = Number(run?.drift?.liveNotDeclared) || 0;
    if (extra) {
      return { sentence: `Nothing is missing live. ${extra} ${extra === 1 ? 'thing runs' : 'things run'} live that the repository does not declare yet.`, button: { label: 'See the differences', action: 'ov-next-neuron' }, why: [], primary: true };
    }
    return { sentence: 'Nothing to do right now: live matches what the repository declares.', button: null, why: [], primary: false };
  }
  // changed
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
// word (many, one).
const SIGNAL_WORDS = {
  sli: ['indicators', 'indicator'], slo: ['objectives', 'objective'], metric: ['metrics', 'metric'], log: ['logs', 'log'], trace: ['traces', 'trace'],
  dashboard: ['dashboards', 'dashboard'], alert: ['alerts', 'alert'], runbook: ['runbooks', 'runbook'], chaos: ['chaos tests', 'chaos test'], synthetic: ['synthetic checks', 'synthetic check'],
};
const SIGNAL_ORDER = ['sli', 'slo', 'metric', 'log', 'trace', 'dashboard', 'alert', 'runbook', 'chaos', 'synthetic'];
export const SIGNAL_KINDS = Object.freeze(SIGNAL_ORDER
  .filter((k) => POSTURE_MECHANISMS_PER_LAYER.some((m) => m.key === k))
  .map((k) => ({ key: k, word: (SIGNAL_WORDS[k] || [k, k])[0], one: (SIGNAL_WORDS[k] || [k, k])[1] })));

// A cell is the matrix's list of artefacts, or (in a test, or a saved
// posture) just its count. The matrix lists a telemetry backend twice on the
// application layer (as itself and as the signal it carries) and adds
// evidence pseudo-artefacts from a live side's annotations; the board counts
// what the repository declares, each artefact once — but a cell is present
// (lit, and observed by the engine's Comprehensive criterion) when it holds
// anything at all, evidence included.
const cellOf = (cells, key) => {
  const v = cells?.[key];
  if (!Array.isArray(v)) { const n = Number(v) || 0; return { count: n, present: n > 0 }; }
  const ids = new Set();
  let anonymous = 0;
  for (const a of v) {
    if (!a || a._evidence) continue;
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

// layersModel({ cells, layered }) → { rows, coveragePct, unplaced, composition, declared, lead, coverage, unplacedNote } | null
//   rows      one per BOARD_LAYERS entry: { key, name, hint, covered, of, pct, total, tone,
//             kinds: [{ key, word, count, present, label }] (all ten, in drawing order;
//             a kind present by live evidence alone has count 0 and reads "seen live") }
//   coveragePct  the engine's Comprehensive figure: the four layers' covered
//             shares summed in the matrix's layer order, then rounded once
export function layersModel({ cells = null, layered = null } = {}) {
  if (!cells) return null;
  const rows = BOARD_LAYERS.map((L) => {
    const kinds = SIGNAL_KINDS.map((k) => {
      const { count, present } = cellOf(cells, `${L.key}:${k.key}`);
      const label = count > 0 ? `${count} ${count === 1 ? k.one : k.word}` : (present ? `${k.word} seen live` : `no ${k.word}`);
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
  const unplaced = SIGNAL_KINDS.reduce((n, k) => n + cellOf(cells, `unknown:${k.key}`).count, 0);
  const composition = compositionOf(layered);
  const declared = composition.reduce((n, c) => n + c.count, 0);
  return {
    rows, coveragePct, unplaced, composition, declared,
    lead: declared ? `${things(declared)} declared in the repository.` : '',
    coverage: `Coverage reaches ${coveragePct} in 100 across the four layers.`,
    unplacedNote: unplaced ? `${things(unplaced)} could not be placed on a layer.` : '',
  };
}

// ---------- the board: the specification's rules ----------

// rulesModel(conformance, { error }) → { passed, total, pct, tier, met, unknown, sentence, tone } | null
//   conformance  GET /api/packs/:id/conformance — the pack against the
//                specification's clauses for its declared tier (`tier` in the
//                body is an object; the string is `declaredTier` or `tier.graded`)
//   error        the read's failure sentence, when it failed: the line then
//                says the rules could not be read — not that none apply
export function rulesModel(conformance, { error = null } = {}) {
  const must = conformance?.must;
  const passed = Number(must?.passed) || 0, total = Number(must?.total) || 0;
  if (!total) {
    if (!conformance && error) return { passed: 0, total: 0, pct: 0, tier: '', met: false, unknown: true, sentence: 'The required rules could not be read.', tone: 'neutral' };
    return null;
  }
  const pct = Math.round(passed / total * 100);
  const rawTier = conformance.declaredTier || (conformance.tier && typeof conformance.tier === 'object' ? conformance.tier.graded : conformance.tier) || '';
  const tier = String(rawTier).replace(/^tier-/i, '').trim();
  const met = conformance.conformant === true;
  return {
    passed, total, pct, tier, met, unknown: false,
    sentence: `${passed} of ${total} required rules met${tier ? ` for a tier ${tier} service` : ''}.`,
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
//              and a reading older than a day, which the engine does not trust
export function fidelityModel({ run = null, journey = null, pack = null, now = Date.now() } = {}) {
  const against = journey ? (journeyIsLive(journey) ? 'live' : 'recording') : (/^mcp:/i.test(String(run?.packB?.source || '')) || !run ? 'live' : 'recording');
  const base = { known: false, alignmentPct: null, tiles: [], chains: null, against, note: '' };
  if (!run || !runGradedPack(run, pack)) return { ...base, note: 'Never checked against live.' };
  if (run.outcome === 'vantage-lost') return { ...base, note: 'The live side did not answer the last check, so nothing is known about it right now.' };
  if (vantageShrank(run).length) return { ...base, note: 'The live side showed less than the check before, so the counts cannot be compared yet.' };
  const n = (x) => Number(x) || 0;
  const d = run.drift || {};
  const tiles = [
    { key: 'aligned', value: n(d.aligned), label: 'match', note: 'declared and running live', tone: 'ok' },
    { key: 'drifted', value: n(d.drifted), label: 'run differently', note: 'running live, not as declared', tone: 'warn' },
    { key: 'missing', value: n(d.declaredNotLive), label: 'not running live', note: 'declared, nowhere live', tone: 'fail' },
    { key: 'extra', value: n(d.liveNotDeclared), label: 'live only', note: 'running live, not declared', tone: 'info' },
  ];
  const t = run.traceability || {};
  const total = n(t.declaredTotal);
  const integrity = Number(t.integrityPct);
  const chains = total ? {
    total, intact: n(t.intact), partial: n(t.partial), broken: n(t.broken), integrityPct: Number.isFinite(integrity) ? integrity : null,
    sentence: `${n(t.intact)} of ${total} promises hold end to end${n(t.partial) ? `, ${n(t.partial)} in part` : ''}.`,
  } : null;
  const pct = Number(d.alignmentPct);
  // A live side that answered only in part (a probe family failed) is said
  // beside the numbers: they count what could be seen.
  const failed = Array.isArray(run.probes?.failed) ? run.probes.failed.map(familyWord) : [];
  const notes = [];
  if (failed.length) notes.push(`The live side answered only in part: its ${listWords(failed)} could not be read.`);
  const startedMs = Date.parse(run.startedAt || '');
  if (Number.isFinite(startedMs) && now - startedMs > FRESH_WINDOW_MS) notes.push(`Counted ${agoText(run.startedAt, now)}; readings older than a day are not trusted.`);
  return { ...base, known: true, alignmentPct: Number.isFinite(pct) ? pct : null, tiles, chains, note: notes.join(' ') };
}

// ---------- the board: what to change ----------

// changesModel({ fidelity }) → { known, items, total, sentence }
//   items  [{ key, value, label, note, tone }] — to add (declared, not running
//          live: what Remediate compiles) · to update (runs differently) · to
//          review (live only, not in the repository)
export function changesModel({ fidelity = null } = {}) {
  if (!fidelity?.known) return { known: false, items: [], total: 0, sentence: 'Check against live to count what to change.' };
  const v = (k) => fidelity.tiles.find((t) => t.key === k)?.value || 0;
  const items = [
    { key: 'add', value: v('missing'), label: 'to add', note: 'declared in the repository, not running live', tone: 'fail' },
    { key: 'update', value: v('drifted'), label: 'to update', note: 'running live, but not as declared', tone: 'warn' },
    { key: 'review', value: v('extra'), label: 'to review', note: 'running live, not in the repository', tone: 'info' },
  ];
  const total = items.reduce((n, i) => n + i.value, 0);
  return { known: true, items, total, sentence: total ? '' : 'Nothing to change: live matches what the repository declares.' };
}

// ---------- the whole screen ----------

// buildOverviewModel({ services, servicesStatus, catalog, serviceId, env, isLiveAggregatePack,
//   diagnostic, diagnosticError, decision, journeys, journeysError, run, running, startError,
//   now, productName, pending, layout, cells, layered, conformance, conformanceError })
export function buildOverviewModel(input = {}) {
  const {
    services = null, servicesStatus = null, catalog = [], serviceId = null, env = null, isLiveAggregatePack = () => false,
    diagnostic = null, diagnosticError = null, decision = null, journeys = null, journeysError = null, run = null,
    running = false, startError = null, now = Date.now(), productName = '', pending = false,
    layout = 'board', cells = null, layered = null, conformance = null, conformanceError = null,
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
  if (!picked.service) {
    const unreadable = servicesStatus && servicesStatus.kind !== 'ok' && servicesStatus.kind !== 'loading' ? (servicesStatus.error || 'the services table could not be read') : null;
    return { kind: unreadable ? 'error' : (servicesStatus?.kind === 'loading' ? 'loading' : 'empty'), error: unreadable, options: [], service: null, envs: [], env: null, grade: null, still: null, next: null, productName, primary: null, layout, board: null };
  }
  const journey = journeyForService(journeys, { slug: picked.service.slug, env: picked.env, packId: picked.pack?.id || null });
  const grade = gradeModel({ pack: picked.pack, how: picked.how, diagnostic: pending ? null : diagnostic, diagnosticError: pending ? null : diagnosticError, run: run && journey && !pending ? run : null, journey, now });
  const still = stillTrueModel({ journey, run: journey ? run : null, now, running, startError, journeysError, pending });
  const next = nextActionModel({ still, grade, decision, run: journey ? run : null, journey, now });
  // One primary button on the screen: the next step's when it has one, else
  // the still-true panel's Check button.
  const primary = next.button && next.primary ? 'next' : (still.checkPrimary ? 'check' : null);
  // The board's pictures, from the same facts: nothing while the facts are
  // still being read, nothing for a service without a pack of its own.
  const graded = picked.how === 'primary' && !pending;
  const fidelity = fidelityModel({ run: graded && journey ? run : null, journey, pack: picked.pack, now });
  const board = {
    layers: graded ? layersModel({ cells, layered }) : null,
    rules: graded ? rulesModel(conformance, { error: conformanceError }) : null,
    fidelity: graded ? fidelity : null,
    changes: graded ? changesModel({ fidelity }) : null,
  };
  return {
    kind: 'service', error: null, options,
    service: { id: picked.service.id, name: picked.service.name, slug: picked.service.slug },
    envs: picked.envs.map((name) => ({ name, selected: name === picked.env })), env: picked.env,
    journey: journey ? { name: journey.name, live: journeyIsLive(journey) } : null,
    grade, still, next, primary, productName, layout, board,
  };
}
