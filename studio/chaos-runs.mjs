// studio/chaos-runs.mjs — chaos runs recorded in the studio: pure, zero imports.
//
// A chaos experiment proves recovery only through a recorded run (spec 1.5
// `last_result`: when, pass / fail / aborted, the MTTD it measured, the
// alerts that fired). A repository records it in its own pack
// (.observability/*.yaml), and a live run feed can measure it. Neither is
// always there, so a person can record a run in the studio: Record a chaos
// run… on the board's MTTD / MTTR tile and in the control room.
//
// A run, as the server keeps it beside the service's row
// (server/store/services.mjs, schema_meta chaos_runs:<org>:<id>; no schema
// step): { experiment, at, outcome, environment, mttd, alertsFired, note,
// by, recordedAt }
//   experiment   the pack's experiment id (a spec Slug)
//   at           when the run happened, an ISO date-time, at most 5 minutes ahead
//   outcome      pass | fail | aborted
//   environment  the environment it ran in (a spec Slug), or null for any
//   mttd         the MTTD it measured, a spec Duration in whole seconds ("45s", "2m30s"), or null
//   alertsFired  the expected alerts that fired, or null when not said
//   note         at most 280 characters on one line, '' for none
//   by, at       the server's: who recorded it, and when
//
// withStudioRuns(layered, runs, { env }) gives each experiment of a layered
// pack the newest run recorded for it in that environment (one naming no
// environment stands for any) as its `last_result`, when it is newer than
// the repository's own, with its `evidence` saying it was recorded in the
// studio. The artefact carries `_studioRun`, so a reader (the grade, the
// board, the control room) can say where the run comes from. Everything that
// reads `last_result` then reads it: the grade's Chaos-validated, the
// board's measured MTTD, the control room. The server applies it when a
// check is graded (tools/lib/journey.mjs runJourney), the board when it reads
// the service's pack (app.mjs).
//
// Used by the studio (overview-model.mjs: the form, the board) and the server
// (service-admin.mjs parseChaosRuns; tools/lib/journey.mjs), as
// set-asides.mjs and mttx-targets.mjs are.

export const CHAOS_RUN_OUTCOMES = Object.freeze(['pass', 'fail', 'aborted']);
export const CHAOS_RUNS_MAX = 200;
export const CHAOS_RUN_NOTE_MAX = 280;
export const CHAOS_RUN_ALERTS_MAX = 50;
/** A measured MTTD, at most: a week, in seconds. */
export const CHAOS_RUN_MTTD_MAX = 604_800;
/** How far ahead of the server's clock a run's time may be (a browser's clock a little fast). */
export const CHAOS_RUN_AHEAD_MS = 5 * 60 * 1000;
/** The keys a run may carry, `by` and `recordedAt` the server's. */
export const CHAOS_RUN_FIELDS = Object.freeze(['experiment', 'at', 'outcome', 'environment', 'mttd', 'alertsFired', 'note', 'by', 'recordedAt']);

const SLUG_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;
const DATE_TIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/;
const DURATION_RE = /^(?:\d+h)?(?:\d+m)?(?:\d+s)?$/;
const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
const isSlug = (v) => typeof v === 'string' && v.length >= 2 && v.length <= 64 && SLUG_RE.test(v);
// eslint-disable-next-line no-control-regex
const hasControl = (s) => /[\u0000-\u001f\u007f]/.test(s);
const isLine = (v, max) => typeof v === 'string' && v.length <= max && !hasControl(v);

/** Seconds in a Duration of hours, minutes and seconds ("2m30s", "45s", "1h"), or null. */
export function mttdSeconds(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!s || !DURATION_RE.test(s)) return null;
  const part = (u) => { const m = new RegExp(`(\\d+)${u}`).exec(s); return m ? Number(m[1]) : 0; };
  return part('h') * 3600 + part('m') * 60 + part('s');
}

/** Whole seconds as a Duration: "45s", "2m30s", "1h", "0s". */
export function mttdDuration(seconds) {
  let s = Math.max(0, Math.round(Number(seconds) || 0));
  if (s === 0) return '0s';
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s ? `${s}s` : ''}`;
}

/**
 * What a person types for a measured MTTD, in seconds: '' is none (null); a
 * plain number is seconds ("45"); a Duration of h / m / s ("2m30s", "1m",
 * "90s"); NaN for anything else or past CHAOS_RUN_MTTD_MAX.
 */
export function parseMttdText(text) {
  const s = String(text ?? '').trim().toLowerCase().replace(/\s+/g, '');
  if (!s) return null;
  const n = /^\d+$/.test(s) ? Number(s) : mttdSeconds(s);
  return n === null || !Number.isFinite(n) || n > CHAOS_RUN_MTTD_MAX ? NaN : n;
}

/** The reasons `run` is not a run a client may send, `[]` when it is. `now` the server's clock, in ms. */
export function chaosRunErrors(run, { now = Date.now() } = {}) {
  if (!isObj(run)) return ['a run is { experiment, at, outcome, environment, mttd, alertsFired, note }'];
  const errors = [];
  for (const k of Object.keys(run)) if (!CHAOS_RUN_FIELDS.includes(k)) errors.push(`${k} is not a run's field`);
  if (!isSlug(run.experiment)) errors.push(`experiment ${JSON.stringify(run.experiment ?? null)} is not an experiment's id`);
  const at = typeof run.at === 'string' && DATE_TIME_RE.test(run.at) ? Date.parse(run.at) : NaN;
  if (!Number.isFinite(at)) errors.push(`at ${JSON.stringify(run.at ?? null)} is not a date-time (2026-11-11T14:05:00Z)`);
  else if (at > now + CHAOS_RUN_AHEAD_MS) errors.push(`at ${run.at} is in the future`);
  else if (at < Date.UTC(2000, 0, 1)) errors.push(`at ${run.at} is before 2000`);
  if (!CHAOS_RUN_OUTCOMES.includes(run.outcome)) errors.push(`outcome is ${CHAOS_RUN_OUTCOMES.join(', ')}, not ${JSON.stringify(run.outcome ?? null)}`);
  if (run.environment !== undefined && run.environment !== null && !isSlug(run.environment)) errors.push(`environment ${JSON.stringify(run.environment)} is not an environment's name`);
  if (run.mttd !== undefined && run.mttd !== null) {
    const s = mttdSeconds(run.mttd);
    if (s === null || s > CHAOS_RUN_MTTD_MAX) errors.push(`mttd ${JSON.stringify(run.mttd)} is not a Duration of at most a week ("45s", "2m30s")`);
  }
  if (run.alertsFired !== undefined && run.alertsFired !== null) {
    if (!Array.isArray(run.alertsFired) || run.alertsFired.length > CHAOS_RUN_ALERTS_MAX
      || run.alertsFired.some((a) => typeof a !== 'string' || !a.trim() || !isLine(a, 200))) errors.push(`alertsFired is a list of at most ${CHAOS_RUN_ALERTS_MAX} alert names, or null`);
  }
  if (run.note !== undefined && run.note !== null && !isLine(run.note, CHAOS_RUN_NOTE_MAX)) errors.push(`note is at most ${CHAOS_RUN_NOTE_MAX} characters on one line`);
  return errors;
}

/** A run sent, as it is kept (without `by` / `recordedAt`): the time in UTC, the MTTD in whole seconds, no duplicate alert. */
export function chaosRunRecord(run) {
  const s = run.mttd === undefined || run.mttd === null ? null : mttdSeconds(run.mttd);
  return {
    experiment: run.experiment,
    at: new Date(Date.parse(run.at)).toISOString().replace('.000Z', 'Z'),
    outcome: run.outcome,
    environment: run.environment ?? null,
    mttd: s === null ? null : mttdDuration(s),
    alertsFired: Array.isArray(run.alertsFired) ? [...new Set(run.alertsFired.map((a) => a.trim()))] : null,
    note: typeof run.note === 'string' ? run.note.trim() : '',
  };
}

/** A run's identity: its experiment, its time and its environment. Two with one identity are one run. */
export const chaosRunId = (run) => `${run?.experiment ?? ''}\u0000${run?.at ?? ''}\u0000${run?.environment ?? ''}`;

/** Two runs that say the same thing (who recorded them and when aside). */
export function sameChaosRun(a, b) {
  if (!isObj(a) || !isObj(b)) return false;
  const fired = (r) => (Array.isArray(r.alertsFired) ? [...r.alertsFired].sort().join('\u0000') : null);
  return chaosRunId(a) === chaosRunId(b) && a.outcome === b.outcome && (a.mttd ?? null) === (b.mttd ?? null)
    && fired(a) === fired(b) && (a.note || '') === (b.note || '');
}

/** The newest run recorded for `experiment` that applies in `env` (one naming no environment applies anywhere; with no env, every run does). */
export function studioRunFor(runs, experiment, env = null) {
  return (Array.isArray(runs) ? runs : [])
    .filter((r) => isObj(r) && r.experiment === experiment && Number.isFinite(Date.parse(r.at || '')) && (!env || !r.environment || r.environment === env))
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at))[0] || null;
}

/** A recorded run as an experiment's spec 1.5 `last_result`, its evidence saying it was recorded in the studio. */
export function lastResultOf(run) {
  const day = typeof run.recordedAt === 'string' ? run.recordedAt.slice(0, 10) : '';
  return {
    at: run.at,
    outcome: run.outcome,
    ...(run.environment ? { environment: run.environment } : {}),
    ...(run.mttd ? { observed_mttd: run.mttd } : {}),
    ...(Array.isArray(run.alertsFired) ? { alerts_fired: [...run.alertsFired] } : {}),
    evidence: `Recorded in the studio${run.by ? ` by ${run.by}` : ''}${day ? ` on ${day}` : ''}${run.note ? `: ${run.note}` : ''}`,
  };
}

/**
 * The layered pack with each chaos experiment's newest studio run in `env` as
 * its `last_result`, where it is newer than the pack's own — the artefact
 * marked `_studioRun: { by, recordedAt, note }`. Nothing to apply: the same
 * object, untouched.
 */
export function withStudioRuns(layered, runs, { env = null } = {}) {
  const list = Array.isArray(runs) ? runs.filter(isObj) : [];
  const L5 = layered?.layers?.L5;
  if (!list.length || !Array.isArray(L5)) return layered;
  let changed = false;
  const next = L5.map((a) => {
    if (!isObj(a) || !/^CHAOS-/.test(String(a.id || ''))) return a;
    const id = String(a.spec?.id || a.title || '');
    const run = studioRunFor(list, id, env);
    if (!run) return a;
    const own = a.spec?.last_result;
    const ownAt = isObj(own) ? Date.parse(own.at || '') : NaN;
    if (Number.isFinite(ownAt) && ownAt >= Date.parse(run.at)) return a;
    changed = true;
    return { ...a, spec: { ...(a.spec || {}), last_result: lastResultOf(run) }, _studioRun: { by: run.by ?? null, recordedAt: run.recordedAt ?? null, note: run.note || '' } };
  });
  return changed ? { ...layered, layers: { ...layered.layers, L5: next } } : layered;
}

const OUTCOME_WORDS = { pass: 'Passed', fail: 'Failed', aborted: 'Aborted' };

/** A recorded run in one line: "Passed · 2026-11-11 14:05 UTC · MTTD 45s · prod · by carlos". */
export function chaosRunWords(run) {
  if (!isObj(run)) return '';
  const at = typeof run.at === 'string' ? `${run.at.slice(0, 10)} ${run.at.slice(11, 16)} UTC` : '';
  return [OUTCOME_WORDS[run.outcome] || String(run.outcome || ''), at, run.mttd ? `MTTD ${run.mttd}` : '', run.environment || '', run.by ? `by ${run.by}` : '']
    .filter(Boolean).join(' · ');
}
