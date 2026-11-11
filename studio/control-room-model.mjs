// studio/control-room-model.mjs — Overview's control room, the model: pure, zero imports.
//
// A panel beside the Overview board for one service environment: what its
// live side shows now and how fast its incidents clear. The server reads it
// (POST /api/services/:id/control-room, tools/lib/control-room.mjs); this
// module turns the answer into words and numbers, and keeps the panel's
// state from one read to the next (open, reading, answered, failed, the
// next read's wait). The renderer (control-room-view.mjs) formats units and
// times; the host (app.mjs) drives the reads (control-room-api.mjs).
//
// Headline first: MTTR and MTTD, the numbers people ask for, each saying
// what it measures, over what, on how many incidents — or why there is no
// number. A figure is never shown that the read did not support: too few
// incidents is said as too few, a part not read is said as not read, quiet
// is said only where the store shows an alert history at all, and nothing
// is ever drawn as a zero it did not see. The figures are the endpoint's —
// everything it reads, not only this service — and the panel says so.

export const CONTROL_ROOM_INTERVAL_MS = 60_000;
// After consecutive failed reads, the next waits 1, then 2, then 4 minutes; after a "too many reads
// now" (429), a quarter of a minute — the server is busy, not failing.
const BACKOFF = [60_000, 120_000, 240_000];
const BUSY_WAIT_MS = 15_000;
// Refusals a later read would only repeat: the panel stops and says why.
const FINAL_STATUSES = [400, 401, 403, 404, 409, 501];
// Fewer incidents than this give no median (the server's minIncidents, when it does not say).
const MIN_INCIDENTS = 5;

export const CONTROL_ROOM_CLOSED = Object.freeze({ open: false });

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
// null, undefined and '' are no number (Number(null) is 0: a value never read must not read as 0).
const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };

// ---------- the panel's state ----------

/** Open it for one service environment (a new key starts over). */
export function controlRoomOpened(state, { serviceId, env, now = Date.now() } = {}) {
  const key = `${serviceId}:${env ?? ''}`;
  if (state?.open && state.key === key) return state;
  return { open: true, key, serviceId, env: env ?? null, reading: false, answer: null, error: null, status: null, stopped: false, failures: 0, settledAt: null, openedAt: now };
}
export function controlRoomClosed() { return CONTROL_ROOM_CLOSED; }
export function controlRoomReading(state) { return state?.open ? { ...state, reading: true } : state; }
export function controlRoomAnswered(state, body, { now = Date.now() } = {}) {
  if (!state?.open) return state;
  // answeredAt: when this answer came (a later failure keeps the answer and moves settledAt, never this).
  return { ...state, reading: false, answer: isObj(body) ? body : null, error: null, status: 200, stopped: false, failures: 0, settledAt: now, answeredAt: now };
}
export function controlRoomFailed(state, error, { now = Date.now() } = {}) {
  if (!state?.open) return state;
  const status = Number.isInteger(error?.status) ? error.status : null;
  const text = String(error?.message || 'no answer').replace(/^\d{3}: /, '');
  return { ...state, reading: false, error: text, status, stopped: FINAL_STATUSES.includes(status), failures: state.failures + 1, settledAt: now };
}
/** The wait after a settled read: the interval, longer after consecutive failures. */
function waitAfter(state, intervalMs) {
  if (state.status === 429) return BUSY_WAIT_MS;
  return state.failures ? BACKOFF[Math.min(state.failures, BACKOFF.length) - 1] : intervalMs;
}
/** How long until the next read: ms, or null (closed, reading, stopped, the page hidden). */
export function controlRoomDue(state, { now = Date.now(), hidden = false, intervalMs = CONTROL_ROOM_INTERVAL_MS } = {}) {
  if (!state?.open || state.reading || state.stopped || hidden) return null;
  if (state.settledAt === null) return 0;
  return Math.max(0, state.settledAt + waitAfter(state, intervalMs) - now);
}

// ---------- words ----------

/** "4 min", "3 h 34 min", "12 days", "40 s". */
export function durationWords(seconds) {
  const s = num(seconds);
  if (s === null || s < 0) return '';
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60), rm = m % 60;
  if (h < 48) return rm ? `${h} h ${rm} min` : `${h} h`;
  return `${Math.round(h / 24)} days`;
}

// A duration to the unit below durationWords' ("7 min 20 s", "2 days 10 h"): for a figure beside a
// target its rounding would make look equal to it.
function preciseWords(seconds) {
  const s = num(seconds);
  if (s === null || s < 0) return '';
  if (s < 3600) { const m = Math.floor(s / 60), r = Math.round(s - m * 60); return m ? (r ? `${m} min ${r} s` : `${m} min`) : `${r} s`; }
  if (s < 172_800) { const h = Math.floor(s / 3600), m = Math.round((s - h * 3600) / 60); return m ? `${h} h ${m} min` : `${h} h`; }
  const d = Math.floor(s / 86400), h = Math.round((s - d * 86400) / 3600);
  return h ? `${d} days ${h} h` : `${d} days`;
}
// A KPI's figure: its words, finer when they would read as its target's while the verdict says otherwise
// (or the same) — "7 min · Target 7 min · over target" never stands.
const figureWords = (seconds, target, verdict) => (verdict && target !== null && durationWords(seconds) === durationWords(target) ? preciseWords(seconds) : durationWords(seconds));

// A day as the board says it ("5 Nov", the UTC day), with its year when it is not the year of `now`.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayWords(iso, now) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  const d = new Date(t);
  const year = d.getUTCFullYear() !== new Date(now).getUTCFullYear() ? ` ${d.getUTCFullYear()}` : '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year}`;
}

// A spec Duration ("15m", "1h30m", "2d") in seconds, or null.
export function durationSeconds(text) {
  const m = String(text ?? '').trim().match(/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/);
  if (!m) return null;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  for (const [, n, u] of String(text).matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) total += Number(n) * unit[u];
  return total;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const isAre = (n) => (n === 1 ? 'is' : 'are');
const SEVERITY_ORDER = ['critical', 'warning', 'other', 'info'];
const STATUS = {
  critical: { word: 'Critical', tone: 'fail' },
  warning: { word: 'Warning', tone: 'warn' },
  firing: { word: 'Firing', tone: 'warn' },
  quiet: { word: 'Quiet', tone: 'ok' },
  unknown: { word: 'Not known', tone: 'neutral' },
};

// The history window in words: days, hours below a day, or unknown.
function overWords(timing) {
  const days = num(timing.coversDays);
  if (days === null) return { over: 'the history this store keeps', known: false };
  if (days < 1) { const h = Math.max(1, Math.round(days * 24)); return { over: `the last ${plural(h, 'hour')}`, known: true }; }
  return { over: `the last ${plural(Math.round(days), 'day')}`, known: true };
}

// A severity label in a sentence: as it came, or "none set" for an alert without one.
const labelWords = (l) => (String(l ?? '').trim() ? String(l).trim() : 'none set');

function statusOf(alerts, windowDays, lastFiredAt, now) {
  if (!isObj(alerts) || alerts.outcome === 'failed' || alerts.outcome === 'not-attempted') {
    return { ...STATUS.unknown, key: 'unknown', sentence: `The alerts could not be read${alerts?.reason ? `: ${alerts.reason}` : ''}.`, counts: null, pending: 0 };
  }
  const by = { critical: 0, warning: 0, info: 0, other: 0, ...(alerts.bySeverity || {}) };
  const pending = Number(alerts.pending) || 0;
  const pend = pending ? ` ${plural(pending, 'alert')} ${isAre(pending)} pending.` : '';
  if (by.critical > 0) return { ...STATUS.critical, key: 'critical', sentence: `${plural(by.critical, 'critical alert')} firing.${pend}`, counts: by, pending };
  if (by.other > 0) {
    // A severity this panel does not know may be critical: never "nothing critical" beside it.
    const labels = Array.isArray(alerts.otherSeverities) && alerts.otherSeverities.length ? ` (${alerts.otherSeverities.map(labelWords).join(', ')})` : '';
    const warn = by.warning ? `, and ${plural(by.warning, 'warning')}` : '';
    return { ...STATUS.firing, key: 'firing', sentence: `${plural(by.other, 'alert')} of a severity not recognised${labels} firing${warn}.${pend}`, counts: by, pending };
  }
  if (by.warning > 0) return { ...STATUS.warning, key: 'warning', sentence: `${plural(by.warning, 'warning')} firing, nothing critical.${pend}`, counts: by, pending };
  // Nothing fires. Quiet only where the store shows an alert history at all: with none, quiet and unwatched look the same.
  if (alerts.outcome === 'empty' && alerts.evidence !== true) {
    const why = alerts.evidence === false
      ? `Nothing is firing, and no alert has fired or been pending here in ${plural(windowDays, 'day')}: this store shows no alert history, so quiet cannot be told from unwatched.`
      : `Nothing is firing, but whether this store holds an alert history could not be read.`;
    return { ...STATUS.unknown, key: 'unwatched', sentence: why, counts: null, pending };
  }
  // Quiet, with when an alert last fired, from a day ago on: an evaluator that stopped writing weeks
  // ago reads as a long quiet, said. In days only: the history is kept a few minutes (an alert seen
  // firing since has it read again), which a count of days does not feel, and the words change once a day.
  const last = Date.parse(lastFiredAt || '');
  const days = Number.isFinite(last) ? Math.floor((now - last) / 86_400_000) : 0;
  const ago = days >= 1 ? ` The last alert here fired ${plural(days, 'day')} ago.` : '';
  return { ...STATUS.quiet, key: 'quiet', sentence: `No alert is firing${by.info ? ` beyond ${plural(by.info, 'notice')}` : ''}.${pend}${ago}`, counts: by, pending };
}

// The repository's targets: stated, not read, or none.
const targetOf = (mttx, key) => (mttx && !mttx.unread && mttx.declared ? durationSeconds(mttx[key]) : null);
const UNREAD_TARGETS = "The repository's targets were not read.";

// The MTTR proxy, from the server's timing part.
function mttrOf(timing, mttx, { readAt }) {
  const target = targetOf(mttx, 'mttrTarget');
  const targetWords = target !== null ? `Target ${durationWords(target)}` : mttx?.unread ? UNREAD_TARGETS : '';
  const base = { label: 'MTTR', long: 'Time to resolve', value: null, words: '—', sub: '', detail: '', target: targetWords, verdict: null, tone: 'neutral', basis: '', asOf: '', asOfWord: 'History read at' };
  // How it is measured, said whatever the read gave: the rule does not change with the answer.
  const stepMin = Math.round((num(timing?.stepSeconds) || 120) / 60);
  const mergeMin = Math.round((num(timing?.mergeSeconds) || 300) / 60);
  const rule = `How long the alert rules' own firing records lasted, in ${stepMin}-minute steps; an alert that pauses for ${mergeMin} minutes or less and fires again is one incident, at the highest severity it reached.`;
  const scope = ' The figures are the endpoint\'s: every alert it holds, not only this service\'s, over the history the store keeps (an evaluator that began writing later than that is not seen).';
  if (!isObj(timing)) return { ...base, sub: 'Not read yet.', basis: `${rule}${scope}` };
  // The history is kept a few minutes longer than the rest: its own read time, when older.
  const lag = Date.parse(readAt || '') - Date.parse(timing.readAt || '');
  const asOf = Number.isFinite(lag) && lag >= 60_000 ? timing.readAt : '';
  // Not read: when it was last tried, never "History read at".
  if (timing.outcome === 'failed' || timing.outcome === 'not-attempted') return { ...base, asOf, asOfWord: 'Last tried at', sub: `The alert history could not be read${timing.reason ? `: ${timing.reason}` : ''}.`, basis: `${rule}${scope}` };
  const { over, known } = overWords(timing);
  const left = [];
  const before = Number(timing.before) || 0;
  const names = Array.isArray(timing.beforeNames) ? timing.beforeNames : [];
  if (before > 0) left.push(`${plural(before, 'incident')} that began before the history (${names.join(', ') || 'unnamed'}${before > names.length && names.length ? `, and ${before - names.length} more` : ''})`);
  if (Number(timing.notices) > 0) left.push(`${plural(Number(timing.notices), 'info notice')}`);
  const leftCount = before + (Number(timing.notices) || 0);
  const basis = `${rule} An alert still firing is left out${left.length ? `, and so ${leftCount === 1 ? 'is' : 'are'} ${left.join(' and ')}` : ''}.${known ? '' : ' How far back this store keeps its history is not known.'}${scope}`;
  if (timing.outcome === 'empty') {
    // Kept from an earlier read while something fires now: said as that read's, and read again next time.
    if (timing.outdated) return { ...base, asOf, sub: `No alert had fired in ${over} when the history was read; it is read again with the next refresh.`, basis };
    if (timing.evidence === true) return { ...base, asOf, sub: `No alert fired in ${over}.`, basis };
    return { ...base, asOf, sub: timing.evidence === false ? 'No alert history in this store: nothing to time.' : 'Whether this store holds an alert history could not be read.', basis };
  }
  const min = num(timing.minIncidents) || MIN_INCIDENTS;
  if (timing.tooFew) return { ...base, asOf, sub: `Too few incidents to say: ${timing.closed} cleared in ${over} (${min} needed).`, basis };
  const median = num(timing.medianSeconds);
  const verdict = known && target !== null && median !== null ? (median <= target ? 'met' : 'missed') : null;
  return {
    ...base, asOf,
    value: median, words: figureWords(median, target, verdict),
    sub: `Median time an incident took to clear, over ${plural(timing.closed, 'incident')} in ${over}.`,
    detail: num(timing.p95Seconds) !== null ? `95 in 100 cleared within ${durationWords(timing.p95Seconds)}.` : '',
    verdict, tone: verdict === 'missed' ? 'warn' : verdict === 'met' ? 'ok' : 'neutral', basis,
  };
}

// MTTD: no alert history knows when a fault began; a chaos run does. The run is this environment's
// newest (one that names no environment stands in, said so, with no verdict); a failed run is said as
// failed, an aborted one as aborted — never a figure "within target" — and another environment's run
// is named beside, never used.
const MEASURED_BASIS = 'From the fault the test injected to the slowest of the alerts it expected: a chaos test knows when its fault began.';
const RECORD_BASIS = 'A chaos test knows its start. Record its runs in the repository (.observability/pack.yaml, each experiment\'s last_result, with its environment) and MTTD shows here.';
function mttdOf(mttx, envName, now) {
  const target = targetOf(mttx, 'mttdTarget');
  const base = { label: 'MTTD', long: 'Time to detect', value: null, words: '—', detail: '', target: target !== null ? `Target ${durationWords(target)}` : '', verdict: null, tone: 'neutral', asOf: '' };
  if (mttx?.unread) return { ...base, sub: 'Not measured here: an alert knows when it fired, not when the fault began.', target: '', basis: `${UNREAD_TARGETS} A chaos test recorded there knows a fault's start, and its MTTD shows here once the repository is read (a Run).` };
  const runs = Array.isArray(mttx?.runs)
    ? mttx.runs.filter((r) => isObj(r) && Number.isFinite(Date.parse(r.at || ''))).sort((x, y) => Date.parse(y.at) - Date.parse(x.at))
    : [];
  const here = runs.find((r) => envName && r.environment === envName);
  const unplaced = runs.find((r) => !r.environment);
  const pick = here || unplaced || null;
  const when = (r) => dayWords(r.at, now);
  const what = (r) => `The last chaos test${r.environment ? ` in ${r.environment}` : ''}${r.experiment ? ` (${r.experiment})` : ''}, on ${when(r)},`;
  if (pick) {
    const s = durationSeconds(pick.mttd);
    if (pick.outcome === 'fail') return { ...base, tone: 'warn', sub: `${what(pick)} failed: an alert it expected never fired.`, detail: s !== null ? `The alerts that did fire took up to ${durationWords(s)}.` : '', basis: MEASURED_BASIS };
    if (pick.outcome !== 'pass') return { ...base, sub: `${what(pick)} was ${pick.outcome === 'aborted' ? 'aborted' : `recorded as ${pick.outcome}`}: nothing measured.`, basis: MEASURED_BASIS };
    if (s === null) return { ...base, sub: `${what(pick)} passed without recording how fast its alerts fired.`, basis: RECORD_BASIS };
    const placed = !!pick.environment;
    const verdict = placed && target !== null ? (s <= target ? 'met' : 'missed') : null;
    return {
      ...base, value: s, words: figureWords(s, target, verdict),
      sub: `Measured in a chaos test${placed ? ` in ${pick.environment}` : ''} on ${when(pick)}, recorded in the repository.${placed ? '' : ' The run names no environment, so no verdict.'}`,
      verdict, tone: verdict === 'missed' ? 'warn' : verdict === 'met' ? 'ok' : 'neutral', basis: MEASURED_BASIS,
    };
  }
  // Only other environments' runs: named, never this environment's figure.
  const other = runs.find((r) => r.outcome === 'pass' && durationSeconds(r.mttd) !== null);
  return {
    ...base,
    sub: `Not measured${envName ? ` in ${envName}` : ''}: an alert knows when it fired, not when the fault began.`,
    detail: other ? `A chaos test in ${other.environment} measured ${durationWords(durationSeconds(other.mttd))} on ${when(other)}.` : '',
    basis: RECORD_BASIS,
  };
}

// The names firing now, when the alerts were read whole (null when they were not).
function firingNow(alerts) {
  if (!isObj(alerts) || (alerts.outcome !== 'data' && alerts.outcome !== 'empty') || !Array.isArray(alerts.active)) return null;
  if (Number(alerts.more) > 0) return null;
  return new Set(alerts.active.filter((a) => a.state === 'firing').map((a) => a.name));
}

// The things the timing found worth saying.
function insightsOf(timing, alerts, now, readAt) {
  if (!isObj(timing) || timing.outcome !== 'data') return [];
  const out = [];
  const min = num(timing.minIncidents) || MIN_INCIDENTS;
  const crit = timing.bySeverity?.critical;
  if (crit?.closed) {
    const median = num(crit.medianSeconds);
    out.push({
      tone: 'fail',
      text: median !== null && crit.closed >= min
        ? `Critical: ${plural(crit.closed, 'incident')}, cleared in ${durationWords(median)} at the median.`
        : `Critical: ${plural(crit.closed, 'incident')}${num(crit.longestSeconds) !== null ? `, the longest ${durationWords(crit.longestSeconds)}` : ''}.`,
    });
  }
  const b = timing.busiest;
  if (b && timing.closed >= min && b.incidents >= 3 && b.incidents / timing.closed >= 0.4) out.push({ tone: 'warn', text: `${b.incidents} of the ${timing.closed} incidents are one alert, ${b.name}: it fires and clears again and again.` });
  // Open in the history and firing now, info notices aside (a heartbeat such as Watchdog fires for
  // ever by design), the most severe first; with the alerts not read whole, none is said as open.
  // Its age is the history's only where the rows' rule allows it (no gap the history could not see).
  const firing = firingNow(alerts);
  const rank = { critical: 0, warning: 1, other: 2 };
  const ageOf = ageRule(alerts, timing, readAt);
  const open = (Array.isArray(timing.open) ? timing.open : [])
    .filter((x) => firing && firing.has(x.name) && x.severity !== 'info')
    .sort((x, y) => (rank[x.severity] ?? 2) - (rank[y.severity] ?? 2) || Date.parse(x.since || '') - Date.parse(y.since || ''));
  for (const o of open.slice(0, 3)) {
    const seconds = ageOf(o.name, now);
    const ago = seconds !== null ? durationWords(seconds) : '';
    // The history's start is when it began firing; the evaluator's own age counts its pending wait
    // too: "firing for" only for the first, "active for" for the second.
    const fromHistory = seconds !== null && Math.abs(seconds - (now - Date.parse(o.since || '')) / 1000) <= 1;
    out.push({ tone: o.severity === 'critical' ? 'fail' : 'warn', text: `${o.name} has been ${fromHistory ? 'firing' : 'active'} for ${ago || 'a while'}${o.began && fromHistory ? ', since before the history begins' : ''}: still open, so not in the figure.` });
  }
  return out;
}

// How long a firing alert has held: the evaluator's own age, or the history's open start when the
// history is this read's or the evaluator says the alert has held since before the history was read
// (an evaluator restart resets its own; a clear and a new firing after the history read does too).
function ageRule(alerts, timing, readAt) {
  const openSince = new Map((isObj(timing) && Array.isArray(timing.open) ? timing.open : []).map((o) => [o.name, Date.parse(o.since || '')]));
  const historyAt = Date.parse(timing?.readAt || '');
  const readAtMs = Date.parse(readAt || '');
  const historyLag = Number.isFinite(historyAt) && Number.isFinite(readAtMs) ? Math.max(0, (readAtMs - historyAt) / 1000) : 0;
  const firingAge = new Map((isObj(alerts) && Array.isArray(alerts.active) ? alerts.active : []).filter((a) => a.state === 'firing').map((a) => [a.name, num(a.seconds)]));
  return (name, now, own = firingAge.get(name) ?? null) => {
    let seconds = own;
    const fromHistory = openSince.get(name);
    const continuous = historyLag === 0 || (seconds !== null && seconds >= historyLag);
    if (Number.isFinite(fromHistory) && continuous) {
      const age = Math.max(0, (now - fromHistory) / 1000);
      if (seconds === null || age > seconds) seconds = age;
    }
    return seconds;
  };
}

function scrapeOf(scrape) {
  if (!isObj(scrape)) return { words: 'Targets not read', sub: '', ratio: null, tone: 'neutral', declared: null };
  const total = num(scrape.total), up = num(scrape.up);
  const down = Array.isArray(scrape.downJobs) && scrape.downJobs.length ? `Down: ${scrape.downJobs.join(', ')}.` : '';
  const d = scrape.declared;
  let declared = null;
  if (isObj(d) && d.outcome === 'data') {
    const bits = [];
    if (d.partlyCount) bits.push(`${plural(d.partlyCount, 'declared job')} ${isAre(d.partlyCount)} partly down: ${d.partly.join(', ')}${d.partlyCount > d.partly.length ? ', …' : ''}.`);
    if (d.downCount) bits.push(`${plural(d.downCount, 'declared job')} ${isAre(d.downCount)} down: ${d.down.join(', ')}${d.downCount > d.down.length ? ', …' : ''}.`);
    if (d.missingCount) bits.push(`${plural(d.missingCount, 'declared job')} ${isAre(d.missingCount)} not scraped at all${d.missing?.length ? `: ${d.missing.join(', ')}${d.missingCount > d.missing.length ? ', …' : ''}` : ''}.`);
    const all = d.up === d.jobs && !d.cut;
    // Jobs cut from the read: the count is of those read, and the repository's own total is said.
    const head = d.cut
      ? `${d.up} of the ${d.jobs} exporters read are up; the repository declares ${d.jobs + d.cut}, the other ${d.cut} ${d.cut === 1 ? 'was' : 'were'} not read.`
      : `${d.up} of the ${plural(d.jobs, 'exporter')} the repository declares ${d.jobs === 1 ? 'is' : 'are'} up.`;
    declared = { words: `${head}${bits.length ? ` ${bits.join(' ')}` : ''}`, tone: all ? 'ok' : (d.up === 0 ? 'fail' : 'warn') };
  } else if (isObj(d)) declared = { words: `The declared exporters could not be read${d.reason ? `: ${d.reason}` : ''}.`, tone: 'neutral' };
  // No up series at all is a finding (nothing answers here), not a read that failed; the declared line stays either way.
  if (scrape.outcome === 'empty') return { words: 'No targets answer here', sub: scrape.reason || '', ratio: null, tone: 'warn', declared };
  if (scrape.outcome === 'failed' || scrape.outcome === 'not-attempted') return { words: 'Targets not read', sub: scrape.reason || '', ratio: null, tone: 'neutral', declared };
  if (up === null || total === null) {
    return { words: total !== null ? `${plural(total, 'target')}; how many are up was not read` : 'Targets not read', sub: [scrape.upReason || '', down].filter(Boolean).join(' '), ratio: null, tone: 'neutral', declared };
  }
  const ratio = total ? up / total : null;
  return { words: `${up} of ${plural(total, 'target')} up`, sub: down, ratio, tone: ratio === null ? 'neutral' : ratio >= 1 ? 'ok' : ratio >= 0.9 ? 'warn' : 'fail', declared };
}

// An alert's age: the evaluator's own activeAt resets when the evaluator
// restarts, so a firing alert the history shows open since earlier takes
// the history's start — when the history is this read's, or the evaluator
// says the alert has held since before the history was read (no gap between
// them the history could not see).
function alertRowsOf(alerts, timing, now, readAt) {
  if (!isObj(alerts) || !Array.isArray(alerts.active)) return { rows: [], more: 0 };
  const ageOf = ageRule(alerts, timing, readAt);
  return {
    rows: alerts.active.map((a) => {
      const seconds = a.state === 'firing' ? ageOf(a.name, now, num(a.seconds)) : num(a.seconds);
      // Where the age came from: the history's firing start, or the evaluator's own (its pending wait included).
      const since = Date.parse((isObj(timing) && Array.isArray(timing.open) ? timing.open : []).find((o) => o.name === a.name)?.since || '');
      const fromHistory = a.state === 'firing' && seconds !== null && Number.isFinite(since) && Math.abs(seconds - (now - since) / 1000) <= 1;
      const severity = SEVERITY_ORDER.includes(a.severity) ? a.severity : 'other';
      return {
        name: String(a.name || ''), severity,
        severityText: severity === 'other' ? (String(a.label || '').trim() || 'No severity') : '',
        state: a.state === 'firing' ? 'firing' : 'pending',
        forWords: seconds !== null ? durationWords(seconds) : '',
        ageFrom: seconds === null ? null : fromHistory ? 'history' : 'evaluator',
        instances: num(a.instances) || 1,
      };
    }),
    more: Number(alerts.more) || 0,
  };
}

const TONE_RANK = { bad: 0, warn: 1, good: 2, info: 3 };
function familiesOf(families, absent) {
  if (!isObj(families)) return { rows: [], note: '', absent: '' };
  if (families.outcome === 'failed' || families.outcome === 'not-attempted') return { rows: [], note: `The known metrics could not be read${families.reason ? `: ${families.reason}` : ''}.`, absent: '' };
  const rows = (Array.isArray(families.rows) ? families.rows : []).filter(isObj).map((f) => {
    const tiles = (Array.isArray(f.tiles) ? f.tiles : []).filter(isObj).map((t) => {
      const value = num(t.value);
      const notRead = t.outcome === 'failed' || t.outcome === 'not-attempted';
      return {
        id: String(t.id || ''), label: String(t.label || ''), unit: String(t.unit || ''), value,
        outcome: t.outcome, tone: value === null ? 'none' : (['good', 'warn', 'bad', 'info'].includes(t.tone) ? t.tone : 'info'),
        bound: isObj(t.judge) ? { kind: t.judge.kind, bound: num(t.judge.bound), critical: num(t.judge.critical), from: String(t.judge.from || '') } : null,
        note: value === null ? (notRead ? `Not read: ${t.reason || 'no answer'}` : (t.reason || 'No data now')) : '',
      };
    });
    const ranked = tiles.filter((t) => t.tone !== 'none').sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone]);
    const worst = ranked[0];
    // The closed row's two numbers: the worst first, so an amber or red tile is never hidden behind a fold.
    const urgency = (t) => (t.tone === 'bad' ? 0 : t.tone === 'warn' ? 1 : 2);
    const headline = tiles.filter((t) => t.value !== null).map((t, i) => ({ t, i })).sort((a, b) => urgency(a.t) - urgency(b.t) || a.i - b.i).slice(0, 2).map((x) => x.t);
    const chart = isObj(f.chart) && f.chart.outcome === 'data' && Array.isArray(f.chart.points) && f.chart.points.length > 1
      ? { label: String(f.chart.label || ''), unit: String(f.chart.unit || ''), range: String(f.chart.range || ''), points: f.chart.points.filter(Array.isArray).map((p) => [num(p[0]), num(p[1])]).filter((p) => p[0] !== null) }
      : null;
    const tone = worst ? worst.tone : 'none';
    const toneWords = tone === 'bad' ? `${ranked.filter((t) => t.tone === 'bad').length} past its red bound` : tone === 'warn' ? `${ranked.filter((t) => t.tone === 'warn').length} past its amber bound` : '';
    return { id: String(f.id || ''), title: String(f.title || f.id || ''), layer: ['app', 'platform', 'infra'].includes(f.layer) ? f.layer : 'app', tone, toneWords, tiles, headline, chart };
  });
  const names = (Array.isArray(absent) ? absent : []).map((a) => String(a?.title || a?.id || '')).filter(Boolean);
  return { rows, note: rows.length ? '' : 'None of the known metric families is exposed live.', absent: names.length ? `Not exposed live: ${names.join(', ')}.` : '' };
}

// The strip's word on the next read: as the driver will do it.
function nextOf(state, intervalMs = CONTROL_ROOM_INTERVAL_MS) {
  if (state.stopped) return 'reads stopped: Refresh tries again';
  if (state.reading) return 'reading now';
  if (state.failures) return `next read in ${durationWords(waitAfter(state, intervalMs) / 1000)}`;
  return 'refreshes every minute while open';
}

// buildControlRoomModel({ state, serviceName, envName, mttx, now })
//   state   the panel's state (controlRoomOpened …)
//   mttx    the board's MTTD / MTTR tile (overview-model.mjs chainModel's
//           mttx: { declared, targets, measured … }), read as
//           { declared, mttdTarget, mttrTarget, measured: { mttd, day } } —
//           the targets the repository states and its chaos runs — or
//           { unread: true } while the repository's pack is not read
//   → null when closed, else { title, scope, reading, stopped, error, readAt, cached, endpoint, next,
//      status, kpis: { mttr, mttd }, insights, scrape, alerts, families, calls }
export function buildControlRoomModel({ state = CONTROL_ROOM_CLOSED, serviceName = '', envName = '', mttx = null, now = Date.now() } = {}) {
  if (!state?.open) return null;
  const a = isObj(state.answer) ? state.answer : null;
  // Ages against the server's clock (the answer's readAt and how long ago it came), never the browser's:
  // a browser an hour fast must not add an hour to every alert.
  const readAtMs = Date.parse(a?.readAt || '');
  const answeredAt = Number.isFinite(state.answeredAt) ? state.answeredAt : state.settledAt;
  const serverNow = Number.isFinite(readAtMs) && Number.isFinite(answeredAt) ? readAtMs + Math.max(0, num(a?.tookMs) || 0) + Math.max(0, now - answeredAt) : now;
  const name = serviceName || a?.service?.name || 'Service';
  const title = `${name}${envName || a?.env?.name ? ` · ${envName || a.env.name}` : ''}`;
  const first = !a && !state.error;
  const endpoint = String(a?.endpoint?.name || a?.endpoint?.origin || '');
  // Every figure but the declared exporters is the endpoint's, whatever else it reads.
  const scope = a && a.scope?.kind !== 'service'
    ? `Everything ${endpoint || 'this endpoint'} reads, not only ${name}: its alerts, incidents, targets and metrics.${num(a.scope?.declaredJobs) ? ` Only the line on the exporters the repository declares is ${name}'s own.` : ''}`
    : '';
  return {
    key: state.key, title, scope, reading: !!state.reading, first, stopped: !!state.stopped,
    error: state.error ? { text: state.error, final: !!state.stopped } : null,
    readAt: a?.readAt || null, cached: !!a?.cached,
    endpoint, next: nextOf(state),
    status: a ? statusOf(a.alerts, num(a.timing?.windowDays) || 30, a.timing?.lastFiredAt || null, serverNow) : null,
    kpis: a ? { mttr: mttrOf(a.timing, mttx, { readAt: a.readAt }), mttd: mttdOf(mttx, envName || a?.env?.name || '', serverNow) } : null,
    timingReadAt: a?.timing?.readAt || null,
    // Cut at the deadline: the parts not read say so; the strip says why.
    outOfTime: !!a?.calls?.outOfTime,
    insights: a ? insightsOf(a.timing, a.alerts, serverNow, a.readAt) : [],
    scrape: a ? scrapeOf(a.scrape) : null,
    alerts: a ? alertRowsOf(a.alerts, a.timing, serverNow, a.readAt) : { rows: [], more: 0 },
    families: a ? familiesOf(a.families, a.absent) : { rows: [], note: '', absent: '' },
    calls: a?.calls || null,
  };
}
