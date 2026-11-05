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
export function boardComparison({ journey = null, run = null, catalog = [], pack = null } = {}) {
  const kept = journey?.livePack;
  const read = run?.packB?.refreshedAt;
  if (!kept || typeof kept.id !== 'string' || !kept.id || !read || kept.refreshedAt !== read) return null;
  if (!runGradesBoard(run, pack)) return null;
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
// Whether the run's grade is the board's letter for `pack`: it finished (pass
// or gate-failed) with a letter, graded this pack, and its live side did not
// shrink since the check before (vantageShrank). gradeModel letters by it;
// boardComparison hands Expert the run's live read only by it.
export function runGradesBoard(run, pack) {
  return !!run && (run.outcome === 'pass' || run.outcome === 'gate-failed') && !!run.grade?.letter
    && !vantageShrank(run).length && runGradedPack(run, pack);
}

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
// The age is the run's `freshness.liveAgeHours`, null when Pack B carries no
// `mcp.refreshedAt` (a pack file, a recording): the engine scores that Fresh
// = no, so an age that is not a number is never fresh — Number(null) is 0,
// "zero hours old", and would count a point the engine never gave.
function liveGradeLines(run, { against, where, now }) {
  if (run?.grade?.driftConstruct !== 'requirement-chain' || !(Number(run.traceability?.declaredTotal) > 0)) return null;
  const pct = Number(run.traceability.integrityPct);
  if (!Number.isFinite(pct)) return null;
  const ageHours = run.freshness?.liveAgeHours;
  const dated = typeof ageHours === 'number' && Number.isFinite(ageHours);
  const fresh = dated && ageHours * 3600e3 <= FRESH_WINDOW_MS;
  const picture = where === 'live' ? 'live picture' : 'recording';
  // The engine scores this criterion by the integrity itself (0.85 of a
  // point at 85 in 100) and calls it met at the bar: the mark follows the
  // bar, the points follow the integrity, above the bar too.
  return [
    { ok: pct >= GRADE_BAR ? 'yes' : (pct > 0 ? 'partly' : 'no'), score: Math.max(0, Math.min(1, pct / 100)),
      text: `Of what the repository promises, ${Math.round(pct)} in 100 holds up ${where}; the bar is ${GRADE_BAR}.` },
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
  if (runGradesBoard(run, pack)) {
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
  const base = { known: false, alignmentPct: null, tiles: [], chains: null, against, note: '', partial: [] };
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
  return { ...base, known: true, alignmentPct: Number.isFinite(pct) ? pct : null, tiles, chains, note: notes.join(' '), partial: failed };
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
    listable = false,
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
  const grade = gradeModel({ pack: picked.pack, how: picked.how, diagnostic: pending ? null : diagnostic, diagnosticError: pending ? null : diagnosticError, run: run && journey && !pending ? run : null, journey, now });
  const still = stillTrueModel({ journey, run: journey ? run : null, now, running, startError, journeysError, pending });
  // A service with no pack at all has nothing to grade: the drift check
  // starts here, as with no service, under the service's own header — the
  // start's cards are the way in, not "Open Expert mode". (A member-only row,
  // whose one pack is a live aggregate's, stays Expert's to show.)
  const startHere = startable && picked.how === 'none';
  const next = startHere ? { sentence: '', button: null, why: [], primary: false } : nextActionModel({ still, grade, decision, run: journey ? run : null, journey, now });
  // One primary button on the screen: the next step's when it has one, else
  // the still-true panel's Check button; none over the start.
  const primary = startHere ? null : (next.button && next.primary ? 'next' : (still.checkPrimary ? 'check' : null));
  // The board's pictures, from the same facts: nothing while the facts are
  // still being read, nothing for a service without a pack of its own.
  const graded = picked.how === 'primary' && !pending;
  const fidelity = fidelityModel({ run: graded && journey ? run : null, journey, pack: picked.pack, now });
  const board = {
    layers: graded ? layersModel({ cells, layered, unkinded }) : null,
    rules: graded ? rulesModel(conformance, { error: conformanceError }) : null,
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
    compare: graded && journey ? boardComparison({ journey, run, catalog, pack: picked.pack }) : null,
    grade, still, next, primary, productName, layout, board,
    ...(startHere ? { start: { a: null }, sources: sourcesOf(access) } : {}),
  };
}

// ---------- the service list: Overview's front door ----------
//
// A service is two places: its repository — where what it declares lives
// (GitHub, Azure DevOps, or a folder on the server) — and, for each of its
// environments, the live MCP endpoint that reads what runs there. The list
// shows one row per service and environment with both places and its last
// check; Run (the host's: POST /api/services/:id/run) scans the repository
// again, checks the scan against live and saves the check. Add a service is
// the form of four answers: the name, the environment, the repository, the
// live endpoint. Everything here is pure: the host keeps the state (the
// form's values, which row runs), carries out the save plan, and passes the
// facts in — the services table, the journeys listing, the MCP endpoints.
// A host that does not opt in (`listable`) never draws it.

export const REPOSITORY_KINDS = Object.freeze([
  Object.freeze({ kind: 'github', label: 'GitHub', placeholder: 'https://github.com/owner/repo', hint: 'A public repository, or a private one when the server has a GitHub token.' }),
  Object.freeze({ kind: 'ado', label: 'Azure DevOps', placeholder: 'https://dev.azure.com/org/project/_git/repo', hint: "Read with the server's Azure DevOps token." }),
  Object.freeze({ kind: 'path', label: 'Folder', placeholder: 'C:\\src\\my-service  or  /srv/src/my-service', hint: 'A folder the server can read: its full path on the server.' }),
]);
const KIND_LABEL = Object.fromEntries(REPOSITORY_KINDS.map((k) => [k.kind, k.label]));
export const NEW_ENDPOINT = 'new';

const lastSegments = (p, n) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).slice(-n).join('/');
const decoded = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The repository as one short line ({ kind, kindText, text, ref, title }), or null.
export function repositoryLine(repository) {
  if (!repository || typeof repository !== 'object' || !repository.location) return null;
  const { kind, location, ref = null } = repository;
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
function lastCheckOf(journey, now) {
  const last = journey?.lastRun || null;
  if (!last) return { state: 'never', word: OVERVIEW_STATUS.never, ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null };
  const ago = agoText(last.startedAt, now);
  if (last.outcome === 'vantage-lost' || last.outcome === 'error') {
    return { state: 'unreachable', word: OVERVIEW_STATUS.unreachable, ago, letter: null, tone: 'warn', alignmentPct: null, gate: null };
  }
  const score = Number.isFinite(last.gradeScore) ? last.gradeScore : null;
  const ig = score === null ? null : instrumentGradeFor(score);
  return {
    state: 'checked', word: ago ? `Checked ${ago}` : 'Checked', ago,
    letter: ig ? ig.letter : null, tone: ig ? (GRADE_TONE[ig.tier] || 'neutral') : 'neutral', gradeLabel: ig ? shortGradeLabel(ig) : '',
    alignmentPct: Number.isFinite(last.alignmentPct) ? last.alignmentPct : null,
    gate: last.outcome === 'pass' ? 'pass' : (last.outcome === 'gate-failed' ? 'fail' : null),
  };
}

export const rowKey = (serviceId, env) => `${serviceId}:${env ?? ''}`;

// serviceListModel({ services, servicesStatus, catalog, isLiveAggregatePack, journeys, journeysError,
//   endpoints, access, now, running, results, showAll })
//   running   { [rowKey]: true } — the rows whose Run is under way
//   results   { [rowKey]: { error } } — the last Run's refusal, the server's sentence
//   showAll   also list the services nobody gave a repository that have no pack of their own
//             (the ones a live draft discovered): counted, not drawn, until asked
// → { kind: 'loading' | 'error' | 'list', error, rows, hidden, canWrite, reason, empty }
export function serviceListModel(input = {}) {
  const {
    services = null, servicesStatus = null, catalog = [], isLiveAggregatePack = () => false,
    journeys = null, journeysError = null, endpoints = null, access = null, now = Date.now(),
    running = {}, results = {}, showAll = false,
  } = input;
  const canWrite = access?.canWrite !== false;
  const reason = canWrite ? null : (access?.reason || 'Not available for your role here.');
  if (!Array.isArray(services)) {
    const failed = !!servicesStatus && !['ok', 'loading'].includes(servicesStatus.kind);
    return { kind: failed ? 'error' : 'loading', error: failed ? (servicesStatus.error || 'the services table could not be read') : null, rows: [], hidden: 0, canWrite, reason, empty: false };
  }
  const endpointById = new Map((Array.isArray(endpoints) ? endpoints : []).map((e) => [e.id, e]));
  const listed = [];
  let hidden = 0;
  for (const s of services) {
    if (!s) continue;
    const { pack, how } = packForService(s, catalog, { isLiveAggregatePack });
    const ownPack = how === 'primary';
    if (!showAll && !s.repository && !ownPack) { hidden += 1; continue; }
    const repository = repositoryLine(s.repository);
    const envs = Array.isArray(s.environments) && s.environments.length ? s.environments : [null];
    for (const env of envs) {
      const key = rowKey(s.id, env?.name ?? null);
      const ep = env?.mcpEndpoint ? (endpointById.get(env.mcpEndpoint.id) || env.mcpEndpoint) : null;
      const live = ep ? { id: ep.id, name: ep.name, origin: ep.origin || '' } : null;
      const journey = journeysError ? null : journeyForService(journeys, { slug: s.slug, env: env?.name ?? null, packId: pack?.id || null });
      const last = journeysError
        ? { state: 'unknown', word: 'Not known', ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null }
        : lastCheckOf(journey, now);
      const busy = !!running[key];
      let why = reason;
      if (!why && !env) why = `Add an environment to ${s.name} first.`;
      else if (!why && !repository) why = `Say where ${s.name}'s repository is first.`;
      else if (!why && !live) why = `Choose the live MCP endpoint for ${env.name} first.`;
      listed.push({
        key, serviceId: s.id, name: s.name, slug: s.slug, env: env?.name ?? null, envId: env?.id ?? null,
        repository, live, last, journey: journey?.name || null,
        run: { enabled: !why && !busy, reason: why, running: busy },
        open: { enabled: ownPack || !!journey },
        error: results[key]?.error || null,
        complete: !!(env && repository && live),
      });
    }
  }
  // The rows a person can run first, then the ones still missing a place; by name, then environment.
  listed.sort((a, b) => (Number(b.complete) - Number(a.complete)) || String(a.name).localeCompare(String(b.name)) || String(a.env || '').localeCompare(String(b.env || '')));
  return { kind: 'list', error: null, rows: listed, hidden, canWrite, reason, empty: listed.length === 0 };
}

// ---------- the Add a service form ----------
//
// The form's state is the host's: { open, mode: 'add' | 'edit', serviceId, envFixed, values, saving,
// error }. `values` = { name, env, kind, location, ref, endpointId, epName, epUrl, epToken };
// endpointId is an endpoint's id, NEW_ENDPOINT for one registered with the form, or ''.

export const FORM_CLOSED = Object.freeze({ open: false });

// The form opened: blank (add), or a row's service and environment (edit).
export function formOpened(services, { serviceId = null, env = null, endpoints = [] } = {}) {
  const s = Array.isArray(services) ? services.find((x) => x && x.id === serviceId) : null;
  const e = s && Array.isArray(s.environments) ? s.environments.find((x) => x.name === env) || null : null;
  const eps = Array.isArray(endpoints) ? endpoints : [];
  let endpointId = '';
  if (e?.mcpEndpoint?.id != null) endpointId = String(e.mcpEndpoint.id);
  else if (eps.length === 1) endpointId = String(eps[0].id);
  else if (!eps.length) endpointId = NEW_ENDPOINT;
  const values = {
    name: s?.name || '', env: e?.name || env || (s ? '' : 'prod'),
    kind: s?.repository?.kind || 'github', location: s?.repository?.location || '', ref: s?.repository?.ref || '',
    endpointId, epName: '', epUrl: '', epToken: '',
  };
  return { open: true, mode: s ? 'edit' : 'add', serviceId: s?.id ?? null, envFixed: !!e, values, saving: false, error: null };
}

// One field typed into: the state with that value (only known fields). A
// change of kind closes the folder panel (Browse…: below).
export function formInput(form, field, value) {
  if (!form?.open || !Object.hasOwn(form.values || {}, field)) return form;
  const next = { ...form, values: { ...form.values, [field]: String(value ?? '') }, error: null };
  if (field === 'kind' && next.browse) next.browse = null;
  return next;
}

const trimmed = (v) => String(v ?? '').trim();

// What is missing before the form can be saved — { field: sentence }. The
// server judges the rest (an address it cannot read, a folder it may not, an
// endpoint origin it does not allow) and its sentence is shown as written.
export function formProblems(values = {}) {
  const out = {};
  if (!trimmed(values.name)) out.name = 'Name the service.';
  if (!trimmed(values.env)) out.env = 'Name the environment, e.g. prod.';
  if (!REPOSITORY_KINDS.some((k) => k.kind === values.kind)) out.kind = 'Choose where the repository is.';
  if (!trimmed(values.location)) out.location = values.kind === 'path' ? "Give the folder's full path on the server." : "Give the repository's address.";
  if (!trimmed(values.endpointId)) out.endpointId = 'Choose the MCP endpoint that reads it live.';
  if (values.endpointId === NEW_ENDPOINT) {
    if (!trimmed(values.epUrl)) out.epUrl = "Give the MCP endpoint's URL.";
    if (!trimmed(values.epName)) out.epName = 'Name the endpoint.';
  }
  return out;
}

// formModel(form, { endpoints, register, access, folders }) → what the renderer draws:
//   register  GET /api/mcp-endpoints' policy.register ({ allowed, why }) — may a new endpoint be registered here
//   folders   loadServiceListFacts' `folders` ({ allowed, why }) — may a folder be picked on the server
//             (Browse…: below); without it the Folder answer is typed, as before
export function formModel(form, { endpoints = null, register = null, access = null, folders = null } = {}) {
  if (!form?.open) return { open: false };
  const v = form.values || {};
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const canWrite = access?.canWrite !== false;
  const newAllowed = register ? register.allowed !== false : true;
  return {
    open: true, mode: form.mode, saving: !!form.saving, error: form.error || null, focus: form.focus || null,
    title: form.mode === 'edit' ? `${v.name}${v.env && form.envFixed ? ` · ${v.env}` : ''}` : 'Add a service',
    nameFixed: form.mode === 'edit', envFixed: !!form.envFixed,
    values: { ...v },
    kinds: REPOSITORY_KINDS.map((k) => ({ ...k, selected: k.kind === v.kind })),
    kind: REPOSITORY_KINDS.find((k) => k.kind === v.kind) || REPOSITORY_KINDS[0],
    browse: browseModel(form, v, folders, canWrite),
    endpoints: eps.map((e) => ({ id: String(e.id), name: e.name, origin: e.origin || '', selected: String(e.id) === v.endpointId })),
    newEndpoint: { allowed: newAllowed, reason: newAllowed ? null : (register?.why || 'A new MCP endpoint cannot be registered here.'), selected: v.endpointId === NEW_ENDPOINT },
    problems: formProblems(v),
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

// The calls a save makes, in order, from the form's values and the facts on
// hand — pure, so every host saves alike:
//   endpoint  { create: { name, url, readTokenEnv? } } | { id }
//   service   { create: { name, repository } } | { id, patch: { repository } | null }
//   env       { create: { name } } | { id, bind: boolean } — bind: point it at the endpoint
// A name that keys an existing record (the catalogue's slug rule, `keyOf`,
// injected: tools/lib/service-keys.mjs normalizeServiceKey) is that record —
// the form completes it, never a second one.
export function savePlan(values, { services = [], keyOf = defaultKeyOf, serviceId = null } = {}) {
  const name = trimmed(values.name);
  const envName = trimmed(values.env);
  const repository = { kind: values.kind, location: trimmed(values.location), ...(trimmed(values.ref) ? { ref: trimmed(values.ref) } : {}) };
  const list = Array.isArray(services) ? services.filter(Boolean) : [];
  const existing = list.find((s) => s.id === serviceId) || list.find((s) => s.slug === keyOf(name)) || null;
  const endpoint = values.endpointId === NEW_ENDPOINT
    ? { create: { name: trimmed(values.epName), url: trimmed(values.epUrl), ...(trimmed(values.epToken) ? { readTokenEnv: trimmed(values.epToken) } : {}) } }
    : { id: Number(values.endpointId) };
  const sameRepo = (r) => !!r && r.kind === repository.kind && r.location === repository.location && (r.ref || '') === (repository.ref || '');
  const service = existing
    ? { id: existing.id, patch: sameRepo(existing.repository) ? null : { repository } }
    : { create: { name, repository } };
  const env = existing ? (existing.environments || []).find((e) => e.name === envName) || null : null;
  return {
    endpoint, service,
    env: env ? { id: env.id, bind: !(endpoint.id !== undefined && env.mcpEndpoint?.id === endpoint.id) } : { create: { name: envName } },
    envName, name,
  };
}
function defaultKeyOf(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
