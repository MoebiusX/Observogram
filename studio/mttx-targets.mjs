// studio/mttx-targets.mjs — the MTTD / MTTR targets a service can be given in the studio: pure, zero imports.
//
// A repository states its targets in its own pack (.observability/*.yaml,
// spec.baselines: mttd_target_p50, mttr_target_p50) and the scan reads them;
// those always win. A repository that states none can be given them in the
// studio, per service — Add a service and Change, one of the profiles below
// or custom minutes — and the board and the control room say them as the
// studio's, never as the repository's. With neither, the board recommends the
// profile marked `recommended` and lists the others.
//
// The profiles (the product's recommendation):
//   Lab default                 MTTD ≤ 1 min    MTTR ≤ 5 min    a service crash, a dependency outage, a failed deployment
//   Critical financial service  MTTD ≤ 1 min    MTTR ≤ 15 min   order processing unavailable, a price feed stale, wallet operations blocked
//   Significant degradation     MTTD ≤ 5 min    MTTR ≤ 60 min   elevated latency, partial failures, a growing queue backlog
//   Noncritical service         MTTD ≤ 15 min   MTTR ≤ 4 hours  internal dashboards or delayed reporting
//
// A service's targets, as the server keeps them (server/store/services.mjs,
// beside the row): { profile, mttd, mttr, by, at } — profile one of the ids
// below or 'custom', mttd / mttr spec Durations in whole minutes ("1m",
// "90m"), copied from the profile when one is chosen, so a later change to
// this table never moves a service's targets — or null for none.
//
// Used by the studio (overview-model.mjs: the form, the board's tile and
// which run's letter holds; app.mjs: the control room and Expert's pack), by
// the server (service-admin.mjs parseTargets; index.mjs writing them into the
// service's checks) and by tools/lib/journey.mjs (a check's `mttxTargets:`).
// diagnostic-grade.mjs reads the pack's meta.studioTargets on its own, with
// no import.

export const MTTX_PROFILES = Object.freeze([
  Object.freeze({ id: 'lab', name: 'Lab default', mttd: '1m', mttr: '5m', mttdWords: '≤ 1 min', mttrWords: '≤ 5 min', conditions: 'A service crash, a dependency outage, a failed deployment', recommended: true }),
  Object.freeze({ id: 'financial', name: 'Critical financial service', mttd: '1m', mttr: '15m', mttdWords: '≤ 1 min', mttrWords: '≤ 15 min', conditions: 'Order processing unavailable, a price feed stale, wallet operations blocked' }),
  Object.freeze({ id: 'degradation', name: 'Significant degradation', mttd: '5m', mttr: '60m', mttdWords: '≤ 5 min', mttrWords: '≤ 60 min', conditions: 'Elevated latency, partial failures, a growing queue backlog' }),
  Object.freeze({ id: 'noncritical', name: 'Noncritical service', mttd: '15m', mttr: '240m', mttdWords: '≤ 15 min', mttrWords: '≤ 4 hours', conditions: 'Internal dashboards or delayed reporting' }),
]);
export const MTTX_RECOMMENDED = 'lab';
export const MTTX_CUSTOM = 'custom';
// Custom minutes, at most: a week.
export const MTTX_MINUTES_MAX = 10_080;

export const mttxProfile = (id) => MTTX_PROFILES.find((p) => p.id === id) || null;
export const recommendedProfile = () => mttxProfile(MTTX_RECOMMENDED);

const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

/** Whole minutes as a spec Duration ("90m"). */
export const minutesDuration = (n) => `${n}m`;

/** A Duration of whole minutes or hours ("90m", "1h30m", "4h") in minutes, or null for anything else (a non-text value included). */
export function durationMinutes(text) {
  if (typeof text !== 'string') return null;
  const s = text.trim();
  if (!/^(?:\d+h)?(?:\d+m)?$/.test(s) || !s) return null;
  const h = /(\d+)h/.exec(s), m = /(\d+)m/.exec(s);
  return (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

/** A spec Duration ("4m30s", "1h", "2d", "500ms") in seconds, or null — to set a measured MTTD beside a target. */
export function durationSeconds(text) {
  if (typeof text !== 'string' || !/^(?:\d+(?:\.\d+)?(?:ms|s|m|h|d|w))+$/.test(text.trim())) return null;
  const unit = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };
  let total = 0;
  for (const [, n, u] of text.trim().matchAll(/(\d+(?:\.\d+)?)(ms|s|m|h|d|w)/g)) total += Number(n) * unit[u];
  return total;
}

/** Minutes in words: "≤ 5 min", "≤ 1 hour", "≤ 4 hours", "≤ 1 h 30 min". */
export function minutesWords(n) {
  if (!Number.isFinite(n)) return '';
  if (n < 60) return `≤ ${n} min`;
  const h = Math.floor(n / 60), m = n % 60;
  if (!m) return `≤ ${h} ${h === 1 ? 'hour' : 'hours'}`;
  return `≤ ${h} h ${m} min`;
}

// A count of minutes typed in a form: a whole number from 1 to MTTX_MINUTES_MAX, or null.
const typedMinutes = (v) => {
  const s = String(v ?? '').trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= MTTX_MINUTES_MAX ? n : null;
};

/**
 * Why `t` is not a service's targets as a client sends them ({ profile } or { profile: 'custom', mttd, mttr }):
 * a list of reasons, empty when it is one. null (no targets) is one.
 */
export function targetsErrors(t) {
  if (t === null) return [];
  if (!isObj(t)) return ['targets is { profile } — a profile id or "custom" with mttd and mttr — or null'];
  const errors = [];
  const known = new Set(['profile', 'mttd', 'mttr', 'by', 'at']);
  for (const k of Object.keys(t)) if (!known.has(k)) errors.push(`${k} is not a targets field`);
  if (t.profile === MTTX_CUSTOM) {
    for (const k of ['mttd', 'mttr']) {
      const n = durationMinutes(t[k]);
      if (n === null || n < 1 || n > MTTX_MINUTES_MAX) errors.push(`${k} is not a duration of whole minutes from 1m to ${MTTX_MINUTES_MAX}m (a week)`);
    }
  } else if (!mttxProfile(t.profile)) {
    errors.push(`profile is none of ${[...MTTX_PROFILES.map((p) => p.id), MTTX_CUSTOM].join(', ')}`);
  } else {
    const p = mttxProfile(t.profile);
    for (const k of ['mttd', 'mttr']) if (t[k] !== undefined && (typeof t[k] !== 'string' || durationMinutes(t[k]) !== durationMinutes(p[k]))) errors.push(`${k} is the profile's own (${p[k]}): leave it out, or choose "custom"`);
  }
  return errors;
}

/** The targets to keep: a profile's own durations copied in, custom minutes as Durations; null stays null. */
export function targetsRecord(t) {
  if (t === null || t === undefined) return null;
  const p = mttxProfile(t.profile);
  if (p) return { profile: p.id, mttd: p.mttd, mttr: p.mttr };
  return { profile: MTTX_CUSTOM, mttd: minutesDuration(durationMinutes(t.mttd)), mttr: minutesDuration(durationMinutes(t.mttr)) };
}

/** Two targets records the same (who and when aside). */
export const sameTargets = (a, b) => (a ?? null) === (b ?? null) || (!!a && !!b && a.profile === b.profile && durationMinutes(a.mttd) === durationMinutes(b.mttd) && durationMinutes(a.mttr) === durationMinutes(b.mttr));

/**
 * A service's targets in words, or null: { profile, name, mttd, mttr, mttdWords, mttrWords, words, by, at }.
 * A profile's words are its own; custom minutes are said in minutes or hours.
 */
export function targetsView(t) {
  if (!isObj(t)) return null;
  const mttd = durationMinutes(t.mttd), mttr = durationMinutes(t.mttr);
  if (mttd === null || mttr === null) return null;
  const p = mttxProfile(t.profile);
  const own = p && durationMinutes(p.mttd) === mttd && durationMinutes(p.mttr) === mttr;
  const mttdWords = own ? p.mttdWords : minutesWords(mttd);
  const mttrWords = own ? p.mttrWords : minutesWords(mttr);
  return {
    profile: own ? p.id : MTTX_CUSTOM, name: own ? p.name : 'Custom', mttd: t.mttd, mttr: t.mttr, mttdWords, mttrWords,
    words: `MTTD ${mttdWords} · MTTR ${mttrWords}`, by: typeof t.by === 'string' ? t.by : null, at: typeof t.at === 'string' ? t.at : null,
  };
}

// ---------- the grade ----------
//
// The grade (diagnostic-grade.mjs Calibrated) counts a service's targets where the repository states
// none; the server writes them into the service's saved checks (`mttxTargets:`, tools/lib/journey.mjs)
// and the board compares a run's with the service's (overview-model.mjs). A duration out of the
// studio's range (1m to a week) is no target.

const STORED_KEYS = new Set(['profile', 'mttd', 'mttr', 'by', 'at']);
const inRange = (n) => n !== null && n >= 1 && n <= MTTX_MINUTES_MAX;
const gradeTargetsView = (t) => {
  const v = targetsView(t);
  return v && inRange(durationMinutes(v.mttd)) && inRange(durationMinutes(v.mttr)) ? v : null;
};

/**
 * The layered pack carrying the service's targets for the grade, as `meta.studioTargets`
 * ({ profile, mttd, mttr }): computeDiagnosticGrade (diagnostic-grade.mjs) counts them for Calibrated
 * where the repository states none of its own — a person chose them, signed and dated, which the
 * scan's placeholder never was. Only the grade reads them: the comparison with live does not. None
 * set (or not targets): the same object, untouched.
 */
export function withStudioTargets(layered, targets) {
  const v = gradeTargetsView(targets);
  if (!v || !isObj(layered)) return layered;
  return { ...layered, meta: { ...(isObj(layered.meta) ? layered.meta : {}), studioTargets: { profile: v.profile, mttd: v.mttd, mttr: v.mttr } } };
}

/** The targets a grade was given, as a key a record and the board compare ('' for none). */
export function targetsTermKey(t) {
  const v = gradeTargetsView(t);
  return v ? `${v.profile}:${durationMinutes(v.mttd)}:${durationMinutes(v.mttr)}` : '';
}

/** A check file's `mttxTargets` (the service's, written by the studio): why it does not read, or ''. */
export function storedTargetsError(t) {
  if (!isObj(t)) return 'it is not { profile, mttd, mttr }';
  const extra = Object.keys(t).filter((k) => !STORED_KEYS.has(k));
  if (extra.length) return `${extra.join(', ')} ${extra.length === 1 ? 'is not a targets field' : 'are not targets fields'}`;
  return gradeTargetsView(t) ? '' : `mttd and mttr are not durations of whole minutes from 1m to ${MTTX_MINUTES_MAX}m (a week)`;
}

// ---------- the form's answer ----------

// The form's values for targets: targetProfile (a profile id, 'custom' or '' for none), targetMttd and
// targetMttr (minutes, for custom). A new service starts on the recommended profile; a service
// already kept starts on what it has, '' when it has none.
export function targetsFormValues(t, { isNew = false } = {}) {
  const v = targetsView(t);
  if (!v) return { targetProfile: isNew ? MTTX_RECOMMENDED : '', targetMttd: '', targetMttr: '' };
  return { targetProfile: v.profile, targetMttd: String(durationMinutes(v.mttd)), targetMttr: String(durationMinutes(v.mttr)) };
}

/** The form's answer as the API takes it: { profile } | { profile: 'custom', mttd, mttr } | null (none). */
export function targetsFromForm(values = {}) {
  const profile = String(values.targetProfile ?? '').trim();
  if (!profile) return null;
  if (profile !== MTTX_CUSTOM) return { profile };
  const d = typedMinutes(values.targetMttd), r = typedMinutes(values.targetMttr);
  return { profile: MTTX_CUSTOM, mttd: d === null ? String(values.targetMttd ?? '') : minutesDuration(d), mttr: r === null ? String(values.targetMttr ?? '') : minutesDuration(r) };
}

/** What is missing in the form's targets answer — { targetMttd?, targetMttr? }: custom minutes only. */
export function targetsFormProblems(values = {}) {
  const out = {};
  if (String(values.targetProfile ?? '').trim() !== MTTX_CUSTOM) return out;
  const say = `Minutes, a whole number from 1 to ${MTTX_MINUTES_MAX}.`;
  if (typedMinutes(values.targetMttd) === null) out.targetMttd = say;
  if (typedMinutes(values.targetMttr) === null) out.targetMttr = say;
  return out;
}

/** The dropdown's options, in order: the profiles (the recommended one says so), Custom, Not set. */
export function targetsOptions(selected = '') {
  return [
    ...MTTX_PROFILES.map((p) => ({ value: p.id, label: `${p.name} — MTTD ${p.mttdWords} · MTTR ${p.mttrWords}${p.recommended ? ' (recommended)' : ''}`, selected: selected === p.id })),
    { value: MTTX_CUSTOM, label: 'Custom — minutes of your own', selected: selected === MTTX_CUSTOM },
    { value: '', label: 'Not set (the board recommends one)', selected: selected === '' },
  ];
}
