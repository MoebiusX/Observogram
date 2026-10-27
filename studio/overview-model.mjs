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

import { agoText, packForService } from './services-model.mjs';
import { instrumentGradeFor } from './diagnostic-grade.mjs';

export const UI_MODE_KEY = 'studioUiMode.v1';
export const UI_MODES = Object.freeze(['overview', 'expert']);

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
    return { letter: '–', label: 'No pack yet', word: 'Nothing to grade: no pack is registered for this service.', source: '', tone: 'neutral', title: '', basis: 'none' };
  }
  if (how !== 'primary') {
    return { letter: '–', label: 'No pack of its own', word: 'This service appears in a live draft, but no pack of its own is registered yet.', source: '', tone: 'neutral', title: '', basis: 'none' };
  }
  const usable = run && (run.outcome === 'pass' || run.outcome === 'gate-failed') && run.grade?.letter && runGradedPack(run, pack);
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
    };
  }
  if (diagnosticError) {
    return { letter: '?', label: 'Not graded', word: `The pack could not be read: ${diagnosticError}`, source: '', tone: 'neutral', title: '', basis: 'error' };
  }
  if (!diagnostic?.overall) {
    return { letter: '·', label: 'Reading…', word: '', source: '', tone: 'neutral', title: '', basis: 'pending' };
  }
  const ig = diagnostic.overall.instrumentGrade || instrumentGradeFor(diagnostic.overall.audit?.scorePctExact ?? 0);
  const lost = run && run.outcome === 'vantage-lost' && runGradedPack(run, pack);
  return {
    letter: ig.letter, label: shortGradeLabel(ig), word: diagnostic.overall.verdict?.word || verdictWordFor(diagnostic.overall.audit?.scorePctExact),
    source: lost ? 'Graded from the repository alone; the last live check could not see production.' : 'Graded from the repository alone.',
    tone: GRADE_TONE[ig.tier] || 'neutral', title: `${ig.letter} · ${ig.label}${ig.blurb ? ` — ${ig.blurb}` : ''}`,
    basis: 'repository',
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
    const env = journey.scope?.env ? ` for ${journey.scope.env}` : '';
    return { ...base, status: 'never', pill: OVERVIEW_STATUS.never, sentence: `Never checked against live. A live check is set up${env}.`, tone: 'info', canCheck: live, checkLabel: 'Check now', checkPrimary: false };
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
  if (!firstRun && worseCount > 0) since = ` ${worseCount} got worse since the check before.`;
  else if (!firstRun && changedCount > 0) since = ` ${changedCount} changed since the check before.`;
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

// ---------- the whole screen ----------

// buildOverviewModel({ services, servicesStatus, catalog, serviceId, env, isLiveAggregatePack,
//   diagnostic, diagnosticError, decision, journeys, journeysError, run, running, startError,
//   now, productName })
export function buildOverviewModel(input = {}) {
  const {
    services = null, servicesStatus = null, catalog = [], serviceId = null, env = null, isLiveAggregatePack = () => false,
    diagnostic = null, diagnosticError = null, decision = null, journeys = null, journeysError = null, run = null,
    running = false, startError = null, now = Date.now(), productName = '', pending = false,
  } = input;
  const ordered = orderServicesForOverview(services, catalog, { isLiveAggregatePack });
  const picked = pickOverviewService(services, catalog, { serviceId, env, isLiveAggregatePack });
  const options = ordered.map((s) => ({ id: s.id, name: s.name, selected: picked.service ? s.id === picked.service.id : false }));
  if (!picked.service) {
    const unreadable = servicesStatus && servicesStatus.kind !== 'ok' && servicesStatus.kind !== 'loading' ? (servicesStatus.error || 'the services table could not be read') : null;
    return { kind: unreadable ? 'error' : (servicesStatus?.kind === 'loading' ? 'loading' : 'empty'), error: unreadable, options: [], service: null, envs: [], env: null, grade: null, still: null, next: null, productName, primary: null };
  }
  const journey = journeyForService(journeys, { slug: picked.service.slug, env: picked.env, packId: picked.pack?.id || null });
  const grade = gradeModel({ pack: picked.pack, how: picked.how, diagnostic: pending ? null : diagnostic, diagnosticError: pending ? null : diagnosticError, run: run && journey && !pending ? run : null, journey, now });
  const still = stillTrueModel({ journey, run: journey ? run : null, now, running, startError, journeysError, pending });
  const next = nextActionModel({ still, grade, decision, run: journey ? run : null, journey, now });
  // One primary button on the screen: the next step's when it has one, else
  // the still-true panel's Check button.
  const primary = next.button && next.primary ? 'next' : (still.checkPrimary ? 'check' : null);
  return {
    kind: 'service', error: null, options,
    service: { id: picked.service.id, name: picked.service.name, slug: picked.service.slug },
    envs: picked.envs.map((name) => ({ name, selected: name === picked.env })), env: picked.env,
    journey: journey ? { name: journey.name, live: journeyIsLive(journey) } : null,
    grade, still, next, primary, productName,
  };
}
