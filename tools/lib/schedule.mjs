// tools/lib/schedule.mjs
//
// The journey `schedule:` key (roadmap step 5 — early-warning delivery).
// Scheduling itself is DELEGATED, not built (docs/VALUE_BACKLOG.md item 11:
// no scheduler in the server, no in-process timer): this module only parses
// what a journey declares so that
//   - `loadJourneyDef` can refuse a malformed block at load time,
//   - `packc journey schedule` can print cron / schtasks / GitHub Actions /
//     CronJob snippets from it (tools/lib/schedule-snippets.mjs), and
//   - the journeys view can derive the CADENCE a sampled posture budget
//     needs (tools/lib/stack-evidence.mjs stackPostureBudget).
//
// Accepted shapes:
//   schedule: "*/15 * * * *"                         # 5-field cron
//   schedule: { cron: "0 */2 * * *", timezone: Europe/Madrid }
//   schedule: { every: 15m }                         # <N>m | <N>h | <N>d
//   macros @hourly · @daily · @midnight · @weekly normalise to cron
//
// Honesty rule: a cadence is derived ONLY from a regular shape (`* * * * *`,
// `*/N * * * *`, `M */N * * *`, `M H * * *`, `M H * * D`, or `every:`).
// An irregular cron yields cadenceMs null with a note — never a guess.
//
// Zero-import and browser-safe: no node: modules, no environment, no state.
// Served at /lib so the studio uses the same parser the server used.

export const SCHEDULE_ERROR = 'schedule must be a 5-field cron expression, { cron, timezone? } or { every: <N>m|<N>h|<N>d }';

const MINUTE_MS = 60_000;
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

const MACROS = Object.freeze({
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
});

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

// [min, max, names] per cron field: minute, hour, day-of-month, month, day-of-week.
const FIELDS = [
  { name: 'minute', min: 0, max: 59, names: null },
  { name: 'hour', min: 0, max: 23, names: null },
  { name: 'day-of-month', min: 1, max: 31, names: null },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES },
  { name: 'day-of-week', min: 0, max: 7, names: DAY_NAMES },
];

const SCHEDULE_KEYS = Object.freeze(['cron', 'timezone', 'every']);
const EVERY_RE = /^(\d+)([mhd])$/;
// IANA zone ids (Area/Location, with optional further segments) or UTC.
const TIMEZONE_RE = /^(?:UTC|Etc\/[A-Za-z0-9_+-]+|[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+)+)$/;

const fail = (value, why) => {
  const e = new Error(`${SCHEDULE_ERROR}${why ? ` — ${why}` : ''} (got ${JSON.stringify(value)})`);
  e.code = 'ERR_SCHEDULE';
  return e;
};

// A single cron field value → its number, or null when it is not one.
function fieldNumber(token, field) {
  if (/^\d+$/.test(token)) return Number(token);
  if (field.names) {
    const i = field.names.indexOf(token.toLowerCase());
    if (i >= 0) return field.min + i;
  }
  return null;
}

// Syntax + range check of one cron field (`*`, `*/N`, `A`, `A-B`, `A-B/N`,
// `A/N`, comma lists; day/month name tokens). Returns why it is invalid,
// or null when it is fine.
function checkField(raw, field) {
  if (!raw) return `${field.name} field is empty`;
  for (const item of raw.split(',')) {
    const [range, step, ...more] = item.split('/');
    if (more.length) return `${field.name} field ${JSON.stringify(item)} has more than one /`;
    if (step !== undefined && !(/^\d+$/.test(step) && Number(step) >= 1)) return `${field.name} step ${JSON.stringify(step)} is not a positive integer`;
    if (range === '*') continue;
    const [lo, hi, ...rest] = range.split('-');
    if (rest.length) return `${field.name} field ${JSON.stringify(item)} has more than one -`;
    const a = fieldNumber(lo, field);
    if (a === null) return `${field.name} value ${JSON.stringify(lo)} is not a number${field.names ? ' or a name' : ''}`;
    if (a < field.min || a > field.max) return `${field.name} value ${a} is outside ${field.min}-${field.max}`;
    if (hi !== undefined) {
      const b = fieldNumber(hi, field);
      if (b === null) return `${field.name} value ${JSON.stringify(hi)} is not a number${field.names ? ' or a name' : ''}`;
      if (b < field.min || b > field.max) return `${field.name} value ${b} is outside ${field.min}-${field.max}`;
      if (b < a) return `${field.name} range ${item} runs backwards`;
    }
  }
  return null;
}

// Normalise a cron string: macros expanded, whitespace collapsed; throws on
// anything that is not five valid fields.
function normaliseCron(raw, original) {
  const text = String(raw).trim();
  const expanded = MACROS[text.toLowerCase()] || text;
  const fields = expanded.split(/\s+/);
  if (fields.length !== 5) throw fail(original, `${fields.length} field(s), need 5`);
  for (let i = 0; i < 5; i++) {
    if (!/^[0-9*,/A-Za-z-]+$/.test(fields[i])) throw fail(original, `${FIELDS[i].name} field ${JSON.stringify(fields[i])} carries characters outside [0-9*,/-] and names`);
    const why = checkField(fields[i], FIELDS[i]);
    if (why) throw fail(original, why);
  }
  return fields.join(' ');
}

const isInt = (s) => /^\d+$/.test(s);

// The cadence of a REGULAR cron shape in ms, or null. Only the shapes named
// in the header; anything else is "irregular" and gets no number.
export function cronCadenceMs(cron) {
  const f = String(cron || '').trim().split(/\s+/);
  if (f.length !== 5) return null;
  const [min, hour, dom, mon, dow] = f;
  if (dom !== '*' || mon !== '*') return null;
  if (min === '*' && hour === '*' && dow === '*') return MINUTE_MS;
  let m = /^\*\/(\d+)$/.exec(min);
  if (m && hour === '*' && dow === '*') return Number(m[1]) >= 1 && Number(m[1]) <= 59 && 60 % Number(m[1]) === 0 ? Number(m[1]) * MINUTE_MS : null;
  if (!isInt(min)) return null;
  m = /^\*\/(\d+)$/.exec(hour);
  if (m && dow === '*') return Number(m[1]) >= 1 && Number(m[1]) <= 23 && 24 % Number(m[1]) === 0 ? Number(m[1]) * HOUR_MS : null;
  if (hour === '*' && dow === '*') return HOUR_MS;
  if (!isInt(hour)) return null;
  if (dow === '*') return DAY_MS;
  if (isInt(dow) || DAY_NAMES.includes(dow.toLowerCase())) return WEEK_MS;
  return null;
}

// `every: <N>m|<N>h|<N>d` → { cadenceMs, cron|null, cadenceNote|null }.
function parseEvery(raw, original) {
  const m = EVERY_RE.exec(String(raw).trim());
  if (!m || Number(m[1]) < 1) throw fail(original, `every must be <N>m, <N>h or <N>d with N ≥ 1`);
  const n = Number(m[1]);
  const unit = m[2];
  const cadenceMs = n * (unit === 'm' ? MINUTE_MS : unit === 'h' ? HOUR_MS : DAY_MS);
  // Derive an exact cron only when one exists; the note says when it does not.
  let cron = null;
  if (unit === 'm') {
    if (n <= 59 && 60 % n === 0) cron = `*/${n} * * * *`;
    else if (n % 60 === 0) cron = hoursCron(n / 60);
  } else if (unit === 'h') {
    cron = hoursCron(n);
  } else if (n === 1) {
    cron = '0 0 * * *';
  } else if (n === 7) {
    cron = '0 0 * * 0';
  }
  const every = `${n}${unit}`;
  return {
    cron,
    every,
    cadenceMs,
    cadenceNote: cron ? null : `every ${every} has no exact cron form — snippets print it as a comment`,
  };
}

function hoursCron(h) {
  if (h === 1) return '0 * * * *';
  if (h === 24) return '0 0 * * *';
  if (h >= 1 && h <= 23 && 24 % h === 0) return `0 */${h} * * *`;
  return null;
}

export const IRREGULAR_CRON_NOTE = 'irregular cron: cadence not derivable — posture budget not computed';

// parseSchedule(value) → { cron, timezone, every, cadenceMs, cadenceNote }
// or throws with SCHEDULE_ERROR (plus why and the offending value).
export function parseSchedule(value) {
  if (typeof value === 'string') {
    if (!value.trim()) throw fail(value, 'empty');
    const cron = normaliseCron(value, value);
    const cadenceMs = cronCadenceMs(cron);
    return { cron, timezone: null, every: null, cadenceMs, cadenceNote: cadenceMs === null ? IRREGULAR_CRON_NOTE : null };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(value);
  for (const k of Object.keys(value)) {
    if (!SCHEDULE_KEYS.includes(k)) throw fail(value, `schedule.${k} is not a known key`);
  }
  const hasCron = value.cron !== undefined;
  const hasEvery = value.every !== undefined;
  if (hasCron === hasEvery) throw fail(value, hasCron ? 'schedule needs cron or every, not both' : 'schedule needs cron or every');
  let timezone = null;
  if (value.timezone !== undefined) {
    if (typeof value.timezone !== 'string' || !TIMEZONE_RE.test(value.timezone.trim())) throw fail(value, `schedule.timezone must be an IANA zone id such as Europe/Madrid`);
    timezone = value.timezone.trim();
  }
  if (hasCron) {
    if (typeof value.cron !== 'string' || !value.cron.trim()) throw fail(value, 'schedule.cron must be a 5-field cron string');
    const cron = normaliseCron(value.cron, value);
    const cadenceMs = cronCadenceMs(cron);
    return { cron, timezone, every: null, cadenceMs, cadenceNote: cadenceMs === null ? IRREGULAR_CRON_NOTE : null };
  }
  if (typeof value.every !== 'string' && typeof value.every !== 'number') throw fail(value, 'every must be <N>m, <N>h or <N>d');
  const e = parseEvery(value.every, value);
  return { cron: e.cron, timezone, every: e.every, cadenceMs: e.cadenceMs, cadenceNote: e.cadenceNote };
}

// The cadence a journey definition declares, in ms — null without a
// schedule, with an unparseable one, or with an irregular cron (never a
// guess: the posture budget is simply not computed).
export function cadenceOf(def) {
  if (!def || typeof def !== 'object' || def.schedule === undefined || def.schedule === null) return null;
  try { return parseSchedule(def.schedule).cadenceMs; } catch { return null; }
}

// `<N>m|<N>h|<N>d` → ms (stackBudget.window); null when not of that shape.
export function windowMs(str) {
  const m = EVERY_RE.exec(String(str ?? '').trim());
  if (!m || Number(m[1]) < 1) return null;
  const n = Number(m[1]);
  return n * (m[2] === 'm' ? MINUTE_MS : m[2] === 'h' ? HOUR_MS : DAY_MS);
}
