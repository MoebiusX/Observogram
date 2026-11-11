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
import { instrumentGradeFor, INSTRUMENT_GRADE_SCALE, layerItemsFor, POSTURE_LAYERS, POSTURE_MECHANISMS_PER_LAYER, GRADE_CRITERIA, gradeOffKeys, isScaffoldArtefact } from './diagnostic-grade.mjs';
import { setAsideFingerprint } from './set-asides.mjs';
import { CHAIN_LINKS, declaredByTier, differencesOf, familyWords as tierWords } from './artefact-tiers.mjs';
import { MTTX_CUSTOM, MTTX_PROFILES, MTTX_RECOMMENDED, durationSeconds as targetSeconds, targetsTermKey, recommendedProfile, sameTargets, targetsFormProblems, targetsFormValues, targetsFromForm, targetsOptions, targetsRecord, targetsView } from './mttx-targets.mjs';
import { CHAOS_RUN_AHEAD_MS, CHAOS_RUN_NOTE_MAX, CHAOS_RUN_OUTCOMES, CHAOS_RUNS_MAX, chaosRunId, chaosRunWords, mttdDuration, parseMttdText } from './chaos-runs.mjs';
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
const runTargetsKey = (run) => targetsTermKey(run?.grade?.targets ?? null);
const runFinishedWithLetter = (run) => !!run && (run.outcome === 'pass' || run.outcome === 'gate-failed') && !!run.grade?.letter;
const sameTerms = (run, off, aside, targets = '') => offKey(run?.grade?.off) === offKey(off) && asideKey(run) === (aside || '') && runTargetsKey(run) === (targets || '');
export function runGradesBoard(run, pack, off = [], aside = '', targets = '') {
  return runFinishedWithLetter(run) && !vantageShrank(run).length && runGradedPack(run, pack) && sameTerms(run, off, aside, targets);
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
// schema 3: one point each, Drift-free fractional), each as one plain
// sentence with a yes / partly / no mark, the yeses first. Five read the
// repository alone and come from the pack-alone diagnostic's criteria; the
// two that need the other side (Drift-free, Fresh) come from the run that
// graded the letter on screen, or say that nothing live was checked. The
// list is offered only when it adds up to the letter shown (within two
// points of a hundred): a run of another schema, or a pack whose own
// annotations already carry live evidence, explains nothing and shows nothing.
const GRADE_SCHEMA = 4;
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
  const line = (crit, yes, no) => ({ ok: crit.pass ? 'yes' : 'no', text: crit.pass ? yes : no });
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
        ? `Normal is defined with numbers: ${objectives} objective${objectives === 1 ? '' : 's'}, with detection and repair targets set in the studio (${studioTargetsName(c.calibrated.baselines.studio)}).`
        : `Normal is defined with numbers: ${objectives} objective${objectives === 1 ? '' : 's'}, with detection and repair baselines.`,
      calibratedNo(c.calibrated)),
    line(c.comprehensive,
      `Coverage reaches ${coverage} in 100 across infrastructure, platform, application and user experience.`,
      `Coverage reaches only ${coverage} in 100 across infrastructure, platform, application and user experience.`),
    chaosLine(c['chaos-validated'], liveUnobserved),
  ];
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
  const pct = Number(run.traceability.integrityPct);
  if (!Number.isFinite(pct)) return null;
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
    { ok: pct >= GRADE_BAR ? 'yes' : (pct > 0 ? 'partly' : 'no'), score: Math.max(0, Math.min(1, pct / 100)),
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
export function gradeWhy({ diagnostic = null, run = null, letter = '', score = null, against = 'against live', where = 'live', now = Date.now(), off = [] } = {}) {
  const offKeys = gradeOffKeys(off);
  const left = offKeys.length ? { notGraded: notGradedLines(off) } : {};
  const none = { why: [], points: '', ...left };
  if (run && run.grade?.schema != null && Number(run.grade.schema) !== GRADE_SCHEMA) return none;
  if (diagnostic?.gradeSchema != null && Number(diagnostic.gradeSchema) !== GRADE_SCHEMA) return none;
  const fixed = repositoryGradeLines(diagnostic, Array.isArray(run?.packB?.unobserved) ? run.packB.unobserved : []);
  if (!fixed) return none;
  const live = run ? liveGradeLines(run, { against, where, now }) : [
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
    return {
      letter, label, word: verdictWordFor(run.grade.score),
      source: `Graded ${against}, ${agoText(run.startedAt, now)}.`,
      tone: toneForLetter(letter), title: `${letter} · ${run.grade.letterLabel || ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
      basis: recording ? 'recording' : 'live',
      ...criteria,
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
  const lost = run && run.outcome === 'vantage-lost' && runGradedPack(run, pack);
  const partial = !lost && run && shrank.length > 0 && runGradedPack(run, pack);
  // The last live check graded this pack, on other criteria than the service's now, or
  // leaving out other differences than its set-asides now.
  const regraded = !lost && !partial && runFinishedWithLetter(run) && runGradedPack(run, pack) && !sameTerms(run, off, aside, targets);
  const whatChanged = offKey(run?.grade?.off) !== offKey(off) ? 'the criteria graded here changed'
    : asideKey(run) !== (aside || '') ? 'what is set aside changed'
      : !runTargetsKey(run) ? 'the grade has counted the MTTD / MTTR targets set in the studio'
        : !targets ? 'the grade has stopped counting the MTTD / MTTR targets set in the studio'
          : 'the MTTD / MTTR targets changed';
  // A check that reads a recording is not checked again from here: the line does not say to.
  const liveCheck = journey ? journeyIsLive(journey) : /^mcp:/i.test(String(run?.packB?.source || ''));
  return {
    letter: ig.letter, label: shortGradeLabel(ig), word: diagnostic.overall.verdict?.word || verdictWordFor(diagnostic.overall.audit?.scorePctExact),
    source: lost ? 'Graded from the repository alone; the last live check could not see production.'
      : partial ? 'Graded from the repository alone; the last live check saw only part of production.'
        : regraded ? (liveCheck ? `Graded from the repository alone: ${whatChanged} since the last live check. Check again to grade against live.`
          : `Graded from the repository alone: ${whatChanged} since the last check.`)
          : 'Graded from the repository alone.',
    tone: GRADE_TONE[ig.tier] || 'neutral', title: `${ig.letter} · ${ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
    basis: 'repository',
    ...criteria,
    ...gradeWhy({ diagnostic, letter: ig.letter, score: diagnostic.overall.audit?.scorePctExact, now, off }),
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
    return { sentence: 'Nothing to do right now: live matches what the repository declares.', button: null, why: [], primary: false };
  }
  // changed
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
    const sentence = split.chain
      ? `Fix the ${cw.differ} the live side does differently.`
      : cw.unread
        ? `${cw.matched ? `${cap(cw.matched)} match live, ${cw.unread} could not be read` : `Nothing in the chain could be compared: ${cw.unread} could not be read`}; look at the ${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'} beyond the chain.`
        : `The chain matches live; look at the ${split.beyond} ${split.beyond === 1 ? 'detail' : 'details'} beyond it.`;
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
export function controlRoomMttx({ loaded = false, layered = null, layeredError = null, targets = null, settable = false } = {}) {
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
//              the rules compared without labels the live side does not show,
//              and a reading older than a day, which the engine does not trust
//   partial    what of the live side was not read, in the strip's words: the
//              failed probe families, and "rule labels" when the run compared
//              rules on part of their labels (drift.partlyCompared)
//   chain      the chain's links against live (chainLive), when the record
//              counts them (drift.tiers); the board then draws the links and
//              their alignment, and says the rest in one line
export function fidelityModel({ run = null, journey = null, pack = null, now = Date.now() } = {}) {
  const against = journey ? (journeyIsLive(journey) ? 'live' : 'recording') : (/^mcp:/i.test(String(run?.packB?.source || '')) || !run ? 'live' : 'recording');
  const base = { known: false, alignmentPct: null, tiles: [], chains: null, against, note: '', partial: [], chain: null };
  if (!run || !runGradedPack(run, pack)) return { ...base, note: 'Never checked against live.' };
  if (run.outcome === 'vantage-lost') return { ...base, note: 'The live side did not answer the last check, so nothing is known about it right now.' };
  if (vantageShrank(run).length) return { ...base, note: 'The live side showed less than the check before, so the counts cannot be compared yet.' };
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
  const pct = Number(d.alignmentPct);
  // A live side that answered only in part (a probe family failed) is said
  // beside the numbers: they count what could be seen.
  const failed = Array.isArray(run.probes?.failed) ? run.probes.failed.map(familyWord) : [];
  const notes = [];
  if (failed.length) notes.push(`The live side answered only in part: its ${listWords(failed)} could not be read.`);
  // Rules matched on what the live listing showed of them: a listing that
  // gives a severity and no other label never showed the rest, so "match"
  // says nothing about those labels — and the board says that.
  const partly = n(d.partlyCompared);
  if (partly) notes.push(`${partly} alert ${partly === 1 ? 'rule was' : 'rules were'} compared without the labels the live side does not show.`);
  const startedMs = Date.parse(run.startedAt || '');
  if (Number.isFinite(startedMs) && now - startedMs > FRESH_WINDOW_MS) notes.push(`Counted ${agoText(run.startedAt, now)}; readings older than a day are not trusted.`);
  return { ...base, known: true, alignmentPct: Number.isFinite(pct) ? pct : null, tiles, chains, note: notes.join(' '), partial: [...failed, ...(partly ? ['rule labels'] : [])], chain: chainLive(run) };
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

// The losses of a scan, in a few words ("347 past the 200-file cap, 3 not
// read, …"), or '' when it read everything it takes. The Run's toast says it.
export function scanLossText(scan) {
  if (!scan || typeof scan !== 'object') return '';
  const n = (v) => Number(v) || 0;
  const parts = [];
  if (n(scan.capped)) parts.push(`${n(scan.capped)} past the file cap`);
  if (n(scan.skipped)) parts.push(`${n(scan.skipped)} not read`);
  if (scan.truncated) parts.push('the host cut its file list short');
  if (n(scan.environment?.excluded)) parts.push(`${n(scan.environment.excluded)} left out by the ${scan.environment.profile || 'environment'} scope`);
  if (n(scan.unclassified)) parts.push(`${n(scan.unclassified)} recognised as nothing`);
  return parts.join(', ');
}

// scanModel({ run }) → null when the record carries no scan, else
//   { sentence, tone, groups: [{ key, title, count, rows: [{ path, why }], more }], warnings }
//   tone  'warn' when the scan lost files it takes (cap, not read, a cut
//         list), else 'neutral'
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
  if (n(scan.skipped)) groups.push(group('skipped', 'Not read', n(scan.skipped), rowsOf(scan.skippedFiles)));
  if (n(scan.capped)) groups.push(group('capped', `Past the file cap — the read takes the likely artefacts first and stops at its cap`, n(scan.capped), []));
  if (scan.truncated) groups.push(group('truncated', 'The host cut its file list short: files it did not list were not read, and nothing here can name them', 0, []));
  if (n(scan.environment?.excluded)) groups.push(group('excluded', `Left out by the ${scan.environment.profile || 'environment'} scope — files for other deployment surfaces`, n(scan.environment.excluded), rowsOf(scan.environment.excludedFiles)));
  if (n(scan.unclassified)) groups.push(group('unknown', 'Read, recognised as nothing — no observability artefact the scan knows', n(scan.unclassified), rowsOf(scan.unknownFiles)));
  const warnings = (Array.isArray(scan.warnings) ? scan.warnings : []).map(String);
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
  if (!fidelity?.known) return { known: false, items: [], total: 0, sentence: 'Check against live to count what to change.', beyond: '' };
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
  const targets = counted === false || (counted === null && gradeOffKeys(off).includes('calibrated')) ? '' : serviceTargetsKey(picked.service);
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
    // The chain the repository declares (exporters, alerts, dashboards, MTTD / MTTR).
    // Set targets… / Change targets… only where the host draws the service list (the form lives there),
    // for a service record, to a rank that may change it.
    chain: graded ? chainModel({ layered, targets: picked.service?.targets ?? null, env: picked.env ?? null, settable: !!listable && Number.isInteger(picked.service?.id) && access?.canWrite !== false, counted: counted === true }) : null,
    layers: graded ? layersModel({ cells, layered, unkinded }) : null,
    // What the last Run's scan read and left out (null: no record says).
    scan: graded && journey ? scanModel({ run }) : null,
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
]);
const KIND_LABEL = Object.fromEntries(REPOSITORY_KINDS.map((k) => [k.kind, k.label]));
// The org's repository sources (GET /api/repository-sources: { github, ado,
// path, upload }, a missing kind on; null when not read — every source on,
// and the server still refuses one switched off). A source switched off, in
// the server's words (server/service-admin.mjs WAYS.repositorySourceOff).
export const sourceOffText = (kind) => `${KIND_LABEL[kind] || kind} is switched off in Settings → Repository sources — an org admin can switch it back on`;
export const ALL_SOURCES_OFF = 'Every repository source is switched off in Settings → Repository sources — an org admin can switch one on.';
const sourceOff = (sources, kind) => !!sources && typeof sources === 'object' && sources[kind] === false;
export const NEW_ENDPOINT = 'new';

const lastSegments = (p, n) => String(p || '').replace(/\\/g, '/').replace(/\/+$/, '').split('/').filter(Boolean).slice(-n).join('/');
const decoded = (s) => { try { return decodeURIComponent(s); } catch { return s; } };

// The repository as one short line ({ kind, kindText, text, ref, detail, title }), or null.
// An upload's second line is when it came and how much (`now` dates it).
export function repositoryLine(repository, { now = Date.now() } = {}) {
  if (!repository || typeof repository !== 'object' || !repository.location) return null;
  const { kind, location, ref = null } = repository;
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
// A row has no grade to ask whether the targets count now. A run that counted targets differs from a
// service with other targets or none (the board always grades it again then); a run that names none
// (before any were set, or its Calibrated did not read them) is not flagged — only a grade can tell.
const targetsDiffer = (runTargets, targets) => {
  const was = targetsTermKey(runTargets ?? null);
  return !!was && was !== (targets || '');
};
function lastCheckOf(journey, now, off = [], aside = '', targets = '') {
  const last = journey?.lastRun || null;
  if (!last) return { state: 'never', word: OVERVIEW_STATUS.never, ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null };
  const ago = agoText(last.startedAt, now);
  if (last.outcome === 'vantage-lost' || last.outcome === 'error') {
    return { state: 'unreachable', word: OVERVIEW_STATUS.unreachable, ago, letter: null, tone: 'warn', alignmentPct: null, gate: null };
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
    : offKey(last.gradeOff) !== offKey(off) ? " · graded before this service's criteria changed"
      : lastAside !== (aside || '') ? " · graded before this service's set-asides changed"
        : targetsDiffer(last.targets, targets) ? " · graded before this service's targets changed" : '';
  const lastAsideN = (Number(last.setAside?.declared) || 0) + (Number(last.setAside?.live) || 0);
  const asideSaid = ig && lastAsideN && !before ? ` · ${lastAsideN} set aside` : '';
  return {
    state: 'checked', word: ago ? `Checked ${ago}` : 'Checked', ago,
    letter: ig ? ig.letter : null, tone: ig ? (GRADE_TONE[ig.tier] || 'neutral') : 'neutral', gradeLabel: ig ? `${shortGradeLabel(ig)}${over}${asideSaid}${before}` : '',
    alignmentPct: Number.isFinite(last.alignmentPct) ? last.alignmentPct : null,
    gate: last.outcome === 'pass' ? 'pass' : (last.outcome === 'gate-failed' ? 'fail' : null),
  };
}

export const rowKey = (serviceId, env) => `${serviceId}:${env ?? ''}`;

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
      const journey = journeysError ? null : journeyForService(journeys, { slug: s.slug, env: env?.name ?? null, packId: pack?.id || null });
      const last = journeysError
        ? { state: 'unknown', word: 'Not known', ago: '', letter: null, tone: 'neutral', alignmentPct: null, gate: null }
        : lastCheckOf(journey, now, s.gradeOff, serviceAsideKey(s, now), serviceTargetsKey(s));
      const busy = !!running[key];
      let why = reason;
      if (!why && !env) why = `Add an environment to ${s.name} first.`;
      else if (!why && !repository) why = `Say where ${s.name}'s repository is first.`;
      else if (!why && off) why = `${sourceOffText(s.repository.kind)}.`;
      else if (!why && !live) why = `Choose the live MCP endpoint for ${env.name} first.`;
      listed.push({
        key, serviceId: s.id, name: s.name, slug: s.slug, env: env?.name ?? null, envId: env?.id ?? null,
        repository, live, last, journey: journey?.name || null,
        run: { enabled: !why && !busy, reason: why, running: busy },
        open: { enabled: ownPack || !!journey },
        error: results[key]?.error || null,
        // What the host answered the last Run, else the offer a row that can run starts with.
        auth: authAsk(results[key]?.repoAuth, canWrite, signIn) || (!why && !busy ? authOffer(s.repository, { canWrite, repoSignIn: signIn, held, lastAccess: journey?.lastRun?.repositoryAccess || null }) : null),
        complete: !!(env && repository && live),
      });
    }
  }
  // The rows a person can run first, then the ones still missing a place; by name, then environment.
  listed.sort((a, b) => (Number(b.complete) - Number(a.complete)) || String(a.name).localeCompare(String(b.name)) || String(a.env || '').localeCompare(String(b.env || '')));
  return { kind: 'list', error: null, rows: listed, hidden, canWrite, reason, empty: listed.length === 0, tokens, accounts };
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
export function formOpened(services, { serviceId = null, env = null, endpoints = [], sources = null } = {}) {
  const s = Array.isArray(services) ? services.find((x) => x && x.id === serviceId) : null;
  const e = s && Array.isArray(s.environments) ? s.environments.find((x) => x.name === env) || null : null;
  const eps = Array.isArray(endpoints) ? endpoints : [];
  let endpointId = '';
  if (e?.mcpEndpoint?.id != null) endpointId = String(e.mcpEndpoint.id);
  else if (eps.length === 1) endpointId = String(eps[0].id);
  else if (!eps.length) endpointId = NEW_ENDPOINT;
  const values = {
    name: s?.name || '', env: e?.name || env || (s ? '' : 'prod'),
    kind: s?.repository?.kind || firstSourceOn(sources), location: s?.repository?.location || '', ref: s?.repository?.ref || '',
    endpointId, epName: '', epUrl: '', epToken: '',
    // The MTTD / MTTR targets (mttx-targets.mjs): a new service starts on the recommended profile.
    ...targetsFormValues(s?.targets ?? null, { isNew: !s }),
  };
  // A service whose repository is an upload: what was uploaded and when (kept while nothing new is chosen).
  const r = s?.repository;
  const uploaded = r?.kind === 'upload' ? { name: r.location, uploadedAt: r.uploadedAt || null, files: Number.isFinite(r.files) ? r.files : null } : null;
  // The repository as saved: a source switched off since may still be kept as it is.
  const original = r ? { kind: r.kind, location: r.location || '', ref: r.ref || '' } : null;
  return { open: true, mode: s ? 'edit' : 'add', serviceId: s?.id ?? null, envFixed: !!e, values, saving: false, error: null, uploaded, upload: null, original };
}

// The first source switched on, a folder or an address before Upload; GitHub when every one is off.
function firstSourceOn(sources) {
  const on = REPOSITORY_KINDS.filter((k) => !sourceOff(sources, k.kind));
  return (on.find((k) => k.kind !== 'upload') || on[0] || REPOSITORY_KINDS[0]).kind;
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
  if (field === 'kind' && (form.values.kind === 'upload') !== (next.values.kind === 'upload')) {
    next.values.location = next.values.kind === 'upload' ? (form.upload?.staged?.name || form.uploaded?.name || '') : '';
  }
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

export function formDraft(form, { now = Date.now() } = {}) {
  if (!form?.open || form.chaosRun) return null;
  return { v: 1, at: now, serviceId: form.serviceId ?? null, env: form.envFixed ? form.values.env : null, values: { ...form.values }, targetsTouched: !!form.targetsTouched };
}

export function formRestored(services, draft, { endpoints = [], sources = null, now = Date.now() } = {}) {
  if (!draft || typeof draft !== 'object' || draft.v !== 1 || !Number.isFinite(draft.at)) return null;
  if (now - draft.at > FORM_DRAFT_TTL_MS || draft.at - now > 60_000) return null;
  const serviceId = draft.serviceId ?? null;
  if (serviceId !== null && !(Array.isArray(services) && services.some((x) => x && x.id === serviceId))) return null;
  let form = formOpened(services, { serviceId, env: typeof draft.env === 'string' ? draft.env : null, endpoints, sources });
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
    form = formInput(form, field, value);
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
export function formProblems(values = {}, { sources = null, original = null, uploadStaged = false } = {}) {
  const out = {};
  if (!trimmed(values.name)) out.name = 'Name the service.';
  if (!trimmed(values.env)) out.env = 'Name the environment, e.g. prod.';
  if (!REPOSITORY_KINDS.some((k) => k.kind === values.kind)) out.kind = 'Choose where the repository is.';
  else if (sourceOff(sources, values.kind)) {
    const kept = !!original && original.kind === values.kind
      && (values.kind === 'upload' ? !uploadStaged : trimmed(values.location) === original.location && trimmed(values.ref) === original.ref);
    if (!kept) out.kind = REPOSITORY_KINDS.every((k) => sourceOff(sources, k.kind)) ? ALL_SOURCES_OFF : `${sourceOffText(values.kind)}: choose another source.`;
  }
  if (!trimmed(values.location)) {
    out.location = values.kind === 'path' ? "Give the folder's full path on the server."
      : values.kind === 'upload' ? 'Choose a folder or a .zip to upload.' : "Give the repository's address.";
  }
  if (!trimmed(values.endpointId)) out.endpointId = 'Choose the MCP endpoint that reads it live.';
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
  const v = form.values || {};
  const eps = Array.isArray(endpoints) ? endpoints : [];
  const canWrite = access?.canWrite !== false;
  const newAllowed = register ? register.allowed !== false : true;
  const offered = REPOSITORY_KINDS
    .filter((k) => (k.kind !== 'upload' || uploads || v.kind === 'upload') && (!sourceOff(sources, k.kind) || k.kind === v.kind || k.kind === form.original?.kind))
    .map((k) => {
      if (!sourceOff(sources, k.kind)) return { ...k, hint: repositoryHint(k, repoSignIn) };
      // The record's own source, switched off since: it may be kept as it is (and chosen again, to keep it).
      const own = form.original?.kind === k.kind;
      return { ...k, off: true, hint: `${sourceOffText(k.kind)}.${own ? ' A service kept on it as it is still saves its other changes.' : ''}` };
    });
  const switchedOff = REPOSITORY_KINDS.filter((k) => sourceOff(sources, k.kind)).map((k) => k.label);
  return {
    open: true, mode: form.mode, saving: !!form.saving, error: form.error || null, focus: form.focus || null, scroll: !!form.scroll,
    // Opened from the board's Set targets… (targetsFormOpened): the Targets answer alone, saved alone.
    targetsOnly: !!form.targetsOnly,
    title: form.targetsOnly ? `MTTD / MTTR targets · ${v.name}${v.env && form.envFixed ? ` · ${v.env}` : ''}`
      : form.mode === 'edit' ? `${v.name}${v.env && form.envFixed ? ` · ${v.env}` : ''}` : 'Add a service',
    nameFixed: form.mode === 'edit', envFixed: !!form.envFixed,
    values: { ...v },
    kinds: offered.map((k) => ({ ...k, selected: k.kind === v.kind })),
    kind: offered.find((k) => k.kind === v.kind) || offered[0],
    sourcesNote: switchedOff.length ? `Switched off in Settings → Repository sources: ${switchedOff.join(', ')}.` : null,
    auth: formAuth(v, { canWrite, repoSignIn, heldTokens, sources }),
    browse: browseModel(form, v, folders, canWrite),
    upload: uploadModel(form, v, { uploads, canWrite, now }),
    endpoints: eps.map((e) => ({ id: String(e.id), name: e.name, origin: e.origin || '', selected: String(e.id) === v.endpointId })),
    newEndpoint: { allowed: newAllowed, reason: newAllowed ? null : (register?.why || 'A new MCP endpoint cannot be registered here.'), selected: v.endpointId === NEW_ENDPOINT },
    // The MTTD / MTTR targets: the dropdown, the custom minutes when chosen, and what they mean.
    targets: {
      options: targetsOptions(v.targetProfile ?? ''),
      custom: v.targetProfile === MTTX_CUSTOM,
      hint: "Kept with this service: the board and the control room measure against them, said as set in the studio, while the repository states none of its own (a repository's own come first). Change them at any time.",
    },
    problems: formProblems(v, { sources, original: form.original ?? null, uploadStaged: !!form.upload?.staged }),
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
export function savePlan(values, { services = [], keyOf = defaultKeyOf, serviceId = null, upload = null, targetsTouched = false } = {}) {
  const name = trimmed(values.name);
  const envName = trimmed(values.env);
  const uploading = values.kind === 'upload';
  const repository = { kind: values.kind, location: trimmed(values.location), ...(trimmed(values.ref) ? { ref: trimmed(values.ref) } : {}) };
  const list = Array.isArray(services) ? services.filter(Boolean) : [];
  const existing = list.find((s) => s.id === serviceId) || list.find((s) => s.slug === keyOf(name)) || null;
  const endpoint = values.endpointId === NEW_ENDPOINT
    ? { create: { name: trimmed(values.epName), url: trimmed(values.epUrl), ...(trimmed(values.epToken) ? { readTokenEnv: trimmed(values.epToken) } : {}) } }
    : { id: Number(values.endpointId) };
  const sameRepo = (r) => !!r && r.kind === repository.kind && r.location === repository.location && (r.ref || '') === (repository.ref || '');
  const targets = targetsFromForm(values);
  // Compared as the record would keep them (who and when aside): unchanged targets are not sent.
  // …or a record with none yet: the targets the form showed chosen are the ones it gets.
  const mayRetarget = !!existing && (existing.id === serviceId || targetsTouched === true || !existing.targets);
  const targetsChanged = mayRetarget && !sameTargets(existing.targets ?? null, targets ? targetsRecord(targets) : null);
  const patchOf = (repo) => {
    const p = { ...(repo ? { repository: repo } : {}), ...(targetsChanged ? { targets } : {}) };
    return Object.keys(p).length ? p : null;
  };
  let service;
  if (uploading) service = existing ? { id: existing.id, patch: patchOf(null) } : { create: { name, targets } };
  else service = existing ? { id: existing.id, patch: patchOf(sameRepo(existing.repository) ? null : repository) } : { create: { name, repository, targets } };
  const env = existing ? (existing.environments || []).find((e) => e.name === envName) || null : null;
  return {
    endpoint, service,
    env: env ? { id: env.id, bind: !(endpoint.id !== undefined && env.mcpEndpoint?.id === endpoint.id) } : { create: { name: envName } },
    upload: uploading && upload?.files ? { name: upload.name, files: upload.files, skipped: Array.isArray(upload.skipped) ? upload.skipped : [] } : null,
    envName, name,
  };
}
function defaultKeyOf(s) {
  return String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
