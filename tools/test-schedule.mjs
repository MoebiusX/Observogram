#!/usr/bin/env node
/**
 * tools/test-schedule.mjs
 *
 * Unit test for tools/lib/schedule.mjs (the journey `schedule:` parser,
 * step 5) and its loader integration in tools/lib/journey.mjs
 * (`schedule:` / `stackBudget:` validation at load time, round-trip
 * through saveJourneyDef). No MCP, no network. Exit 0 = pass.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHarness } from './lib/harness.mjs';
import { parseSchedule, cadenceOf, windowMs, cronCadenceMs, SCHEDULE_ERROR, IRREGULAR_CRON_NOTE } from './lib/schedule.mjs';
import { stackPostureBudget, stackSeries } from './lib/stack-evidence.mjs';

const { assert, report } = createHarness();

const TMP = mkdtempSync(join(tmpdir(), 'observogram-schedule-'));
process.env.OBSERVOGRAM_WORKSPACE = TMP;
const { loadJourneyDef, saveJourneyDef, validateSchedule, validateStackBudget } = await import('./lib/journey.mjs');

// --- vendoring guard: zero-import, no Node APIs, no environment ---
const src = readFileSync(new URL('./lib/schedule.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\s/m.test(src), 'schedule.mjs is zero-import (browser-safe, served at /lib)');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\./.test(src), 'schedule.mjs reads no node: module and no environment');

const throwsWith = (fn, re) => { try { fn(); return false; } catch (e) { return re.test(e.message) ? true : `wrong message: ${e.message}`; } };

// --- accepted shapes ---
{
  const s = parseSchedule('*/15 * * * *');
  assert(JSON.stringify(s) === JSON.stringify({ cron: '*/15 * * * *', timezone: null, every: null, cadenceMs: 900000, cadenceNote: null }),
         'a string cron parses to { cron, timezone null, every null, cadenceMs 900000, no note }', s);
  const tz = parseSchedule({ cron: '0 */2 * * *', timezone: 'Europe/Madrid' });
  assert(tz.cron === '0 */2 * * *' && tz.timezone === 'Europe/Madrid' && tz.cadenceMs === 7200000 && tz.every === null, '{ cron, timezone } keeps the zone and derives 2 h', tz);
  const ev = parseSchedule({ every: '15m' });
  assert(ev.cron === '*/15 * * * *' && ev.every === '15m' && ev.cadenceMs === 900000 && ev.cadenceNote === null && ev.timezone === null, '{ every: 15m } derives */15 * * * * and 900000 ms', ev);
  assert(parseSchedule({ every: '2h' }).cron === '0 */2 * * *' && parseSchedule({ every: '2h' }).cadenceMs === 7200000, '{ every: 2h } derives 0 */2 * * *');
  assert(parseSchedule({ every: '1h' }).cron === '0 * * * *' && parseSchedule({ every: '60m' }).cron === '0 * * * *', '1h and 60m derive the hourly cron');
  assert(parseSchedule({ every: '1d' }).cron === '0 0 * * *' && parseSchedule({ every: '1d' }).cadenceMs === 86400000, '{ every: 1d } derives 0 0 * * *');
  assert(parseSchedule({ every: '24h' }).cron === '0 0 * * *', '24h derives the daily cron');
  assert(parseSchedule({ every: '7d' }).cron === '0 0 * * 0' && parseSchedule({ every: '7d' }).cadenceMs === 604800000, '7d derives the weekly cron');
  const odd = parseSchedule({ every: '45m' });
  assert(odd.cron === null && odd.cadenceMs === 2700000 && odd.cadenceNote === 'every 45m has no exact cron form — snippets print it as a comment',
         'every: 45m keeps its cadence, yields cron null and the note (never a fake cron)', odd);
  assert(parseSchedule({ every: '5h' }).cron === null && parseSchedule({ every: '3d' }).cron === null && parseSchedule({ every: '3d' }).cadenceMs === 3 * 86400000, '5h and 3d have no exact cron either');
  assert(throwsWith(() => parseSchedule({ every: 15 }), /every must be <N>m, <N>h or <N>d/) === true, 'a unitless numeric every is refused (no unit, no guess)');
  assert(parseSchedule('@hourly').cron === '0 * * * *' && parseSchedule('@daily').cron === '0 0 * * *' && parseSchedule('@weekly').cron === '0 0 * * 0' && parseSchedule('@midnight').cron === '0 0 * * *',
         'macros @hourly / @daily / @weekly / @midnight normalise to cron');
  assert(parseSchedule('  0   4  *  *  * ').cron === '0 4 * * *', 'whitespace is collapsed');
  assert(parseSchedule('0 9 * * mon-fri').cron === '0 9 * * mon-fri' && parseSchedule('0 0 1 jan *').cron === '0 0 1 jan *', 'day and month name tokens are accepted');
  assert(parseSchedule('0 0 * * 7').cron === '0 0 * * 7', 'day-of-week 7 (Sunday alias) is in range');
  assert(parseSchedule('0,30 * * * *').cron === '0,30 * * * *' && parseSchedule('0 8-18/2 * * 1-5').cron === '0 8-18/2 * * 1-5', 'lists, ranges and stepped ranges are accepted');
}

// --- rejected shapes ---
{
  const errPrefix = new RegExp(`^${SCHEDULE_ERROR.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
  assert(throwsWith(() => parseSchedule('* * * *'), /4 field\(s\), need 5/) === true, '4 fields are refused');
  assert(throwsWith(() => parseSchedule('* * * * * *'), /6 field\(s\), need 5/) === true, '6 fields are refused');
  assert(throwsWith(() => parseSchedule('*/15 * * * ?'), /characters outside|is not a number/) === true, 'a ? (Quartz) field is refused');
  assert(throwsWith(() => parseSchedule('60 * * * *'), /minute value 60 is outside 0-59/) === true, 'minute 60 is out of range');
  assert(throwsWith(() => parseSchedule('0 24 * * *'), /hour value 24 is outside 0-23/) === true, 'hour 24 is out of range');
  assert(throwsWith(() => parseSchedule('0 0 0 * *'), /day-of-month value 0 is outside 1-31/) === true, 'day-of-month 0 is out of range');
  assert(throwsWith(() => parseSchedule('0 0 * 13 *'), /month value 13 is outside 1-12/) === true, 'month 13 is out of range');
  assert(throwsWith(() => parseSchedule('0 0 * * 8'), /day-of-week value 8 is outside 0-7/) === true, 'day-of-week 8 is out of range');
  assert(throwsWith(() => parseSchedule('0 0 * * fry'), /day-of-week value "fry" is not a number or a name/) === true, 'a misspelt day name is refused');
  assert(throwsWith(() => parseSchedule('10-5 * * * *'), /runs backwards/) === true, 'a backwards range is refused');
  assert(throwsWith(() => parseSchedule('*/0 * * * *'), /step "0" is not a positive integer/) === true, 'a zero step is refused');
  assert(throwsWith(() => parseSchedule(''), /empty/) === true, 'an empty string is refused');
  assert(throwsWith(() => parseSchedule(15), errPrefix) === true, 'a bare number is refused');
  assert(throwsWith(() => parseSchedule(null), errPrefix) === true, 'null is refused');
  assert(throwsWith(() => parseSchedule(['*/15 * * * *']), errPrefix) === true, 'an array is refused');
  assert(throwsWith(() => parseSchedule({ cron: '*/15 * * * *', tz: 'UTC' }), /schedule\.tz is not a known key/) === true, 'an unknown sub-key is named');
  assert(throwsWith(() => parseSchedule({ every: '15m', cron: '* * * * *' }), /cron or every, not both/) === true, 'cron and every together are refused');
  assert(throwsWith(() => parseSchedule({ timezone: 'UTC' }), /schedule needs cron or every/) === true, 'a block with neither cron nor every is refused');
  assert(throwsWith(() => parseSchedule({ every: '15s' }), /every must be <N>m, <N>h or <N>d/) === true, 'every: 15s (seconds) is refused');
  assert(throwsWith(() => parseSchedule({ every: '0m' }), /every must be/) === true, 'every: 0m is refused');
  assert(throwsWith(() => parseSchedule({ cron: '*/15 * * * *', timezone: 'Madrid' }), /timezone must be an IANA zone id/) === true, 'a non-IANA timezone is refused');
  assert(throwsWith(() => parseSchedule({ cron: 5 }), /schedule\.cron must be a 5-field cron string/) === true, 'a non-string cron is refused');
  const got = throwsWith(() => parseSchedule('bad'), /\(got "bad"\)$/);
  assert(got === true, 'the error ends with the offending value as JSON', got);
}

// --- cadence derivation: regular shapes only, never a guess ---
{
  assert(cronCadenceMs('* * * * *') === 60000, '* * * * * → 60 s');
  assert(cronCadenceMs('*/15 * * * *') === 900000, '*/15 * * * * → 15 min');
  assert(cronCadenceMs('*/7 * * * *') === null, '*/7 (does not divide 60) → null: the intervals are uneven');
  assert(cronCadenceMs('0 */2 * * *') === 7200000, '0 */2 * * * → 2 h');
  assert(cronCadenceMs('30 */5 * * *') === null, '30 */5 (does not divide 24) → null');
  assert(cronCadenceMs('0 * * * *') === 3600000, '0 * * * * → 1 h');
  assert(cronCadenceMs('30 4 * * *') === 86400000, '30 4 * * * → 24 h');
  assert(cronCadenceMs('0 4 * * 1') === 604800000 && cronCadenceMs('0 4 * * mon') === 604800000, 'M H * * D → 7 d (numeric or name)');
  assert(cronCadenceMs('0 4 * * 1-5') === null, 'a weekday range is irregular → null');
  assert(cronCadenceMs('0,30 * * * *') === null && cronCadenceMs('0 4 1 * *') === null && cronCadenceMs('0 4 * 6 *') === null, 'lists, day-of-month and month constraints are irregular → null');
  const irregular = parseSchedule('0,30 * * * *');
  assert(irregular.cadenceMs === null && irregular.cadenceNote === IRREGULAR_CRON_NOTE && irregular.cadenceNote === 'irregular cron: cadence not derivable — posture budget not computed',
         'an irregular cron parses with cadenceMs null and the honesty note', irregular);
  assert(cadenceOf({ schedule: '*/15 * * * *' }) === 900000 && cadenceOf({ schedule: { every: '45m' } }) === 2700000, 'cadenceOf reads the definition');
  assert(cadenceOf({}) === null && cadenceOf(null) === null && cadenceOf({ schedule: 'garbage' }) === null && cadenceOf({ schedule: '0,30 * * * *' }) === null,
         'cadenceOf is null without a schedule, with an unparseable one and with an irregular one — never a guess');
}

// --- windowMs ---
assert(windowMs('30d') === 30 * 86400000 && windowMs('12h') === 12 * 3600000 && windowMs('90m') === 90 * 60000, 'windowMs reads <N>d / <N>h / <N>m');
assert(windowMs('30') === null && windowMs('1w') === null && windowMs('') === null && windowMs(undefined) === null && windowMs('0d') === null, 'windowMs is null for anything else');

// --- the studio's posture line, as a pure computation over the run history ---
{
  const runs = Array.from({ length: 12 }, (_, i) => ({
    startedAt: new Date(Date.UTC(2026, 8, 20, 0, 15 * i)).toISOString(),
    stackEvidence: { status: 'sampled', rows: [{ id: 'scrape_targets_down', outcome: 'data', value: i % 4 === 0 ? 1 : 0, hint: i % 4 === 0 ? 'nonzero' : null }] },
  }));
  const def = { schedule: '*/15 * * * *', stackBudget: { objective: 0.99, window: '30d' } };
  const b = stackPostureBudget(stackSeries(runs, 'scrape_targets_down'), { objective: def.stackBudget.objective, cadenceMs: parseSchedule(def.schedule).cadenceMs, windowMs: windowMs(def.stackBudget.window) });
  assert(b.samples === 12 && b.bad === 3 && b.measurable === true && b.allowance === 28.8 && /signal, not verdict$/.test(b.note),
         'schedule cadence + stackBudget feed stackPostureBudget: 30 d at 15 min allows 28.8 bad samples, measurable, signal not verdict', b);
  const tight = stackPostureBudget(stackSeries(runs, 'scrape_targets_down'), { objective: 0.9999, cadenceMs: parseSchedule(def.schedule).cadenceMs, windowMs: windowMs('30d') });
  assert(tight.measurable === false && /not measurable at this cadence/.test(tight.note), 'a 99.99 % objective at 15 min over 30 d is not measurable — the note says so', tight.note);
}

// --- loader integration ---
const PACK_A = resolve('vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml').replaceAll('\\', '/');
const PACK_B = resolve('examples/production-curated.pack.yaml').replaceAll('\\', '/');
try {
  mkdirSync(join(TMP, 'journeys'), { recursive: true });
  const write = (name, lines) => writeFileSync(join(TMP, 'journeys', `${name}.journey.yaml`), [`name: ${name}`, `packA: { file: ${PACK_A} }`, `packB: { file: ${PACK_B} }`, ...lines].join('\n'));
  write('scheduled', ['schedule: "*/15 * * * *"', 'stackBudget: { objective: 0.99, window: 30d }']);
  const def = loadJourneyDef('scheduled');
  assert(def.schedule === '*/15 * * * *' && def.stackBudget.objective === 0.99 && def.stackBudget.window === '30d', 'a valid schedule + stackBudget load as declared', { s: def.schedule, b: def.stackBudget });
  write('every-form', ['schedule:', '  every: 2h', '  timezone: Europe/Madrid']);
  assert(JSON.stringify(loadJourneyDef('every-form').schedule) === JSON.stringify({ every: '2h', timezone: 'Europe/Madrid' }), 'the { every, timezone } block loads as declared');
  write('typo', ['schedule: "*/15 * * *"']);
  assert(throwsWith(() => loadJourneyDef('typo'), /^journey typo: schedule must be a 5-field cron expression, \{ cron, timezone\? \} or \{ every: <N>m\|<N>h\|<N>d \} — 4 field\(s\), need 5 \(got "\*\/15 \* \* \*"\)$/) === true,
         'a 4-field schedule fails at load with the pinned message naming the journey', throwsWith(() => loadJourneyDef('typo'), /x^/));
  write('typo-key', ['schedule: { cron: "*/15 * * * *", zone: UTC }']);
  assert(throwsWith(() => loadJourneyDef('typo-key'), /^journey typo-key: schedule must be .*schedule\.zone is not a known key/) === true, 'an unknown schedule sub-key fails at load');
  write('bad-budget', ['stackBudget: { objective: 1, window: 30d }']);
  assert(throwsWith(() => loadJourneyDef('bad-budget'), /^journey bad-budget: stackBudget\.objective must be a number in \[0, 1\) \(got 1\)$/) === true, 'objective 1 is refused (must be < 1)');
  write('bad-window', ['stackBudget: { objective: 0.99, window: 30 }']);
  assert(throwsWith(() => loadJourneyDef('bad-window'), /^journey bad-window: stackBudget\.window must be <N>m, <N>h or <N>d \(got 30\)$/) === true, 'a unitless window is refused');
  write('bad-budget-key', ['stackBudget: { objective: 0.99, window: 30d, cadence: 15m }']);
  assert(throwsWith(() => loadJourneyDef('bad-budget-key'), /stackBudget\.cadence is not a known key/) === true, 'an unknown stackBudget key is refused (the cadence comes from schedule:)');
  assert(throwsWith(() => validateStackBudget('30d', 'x'), /^journey x: stackBudget must be a mapping/) === true, 'validateStackBudget refuses a scalar');
  assert(validateSchedule('@daily', 'x').cron === '0 0 * * *', 'validateSchedule returns the parse');
  assert(throwsWith(() => validateSchedule(null, 'j'), /^journey j: schedule must be/) === true, 'validateSchedule prefixes the journey name');

  // Round-trip: saveJourneyDef emits the cron quoted (a leading * would
  // otherwise read as a YAML alias) and loadJourneyDef reads it back.
  const saved = saveJourneyDef('captured-sched', { packA: { file: PACK_A }, packB: { file: PACK_B }, gate: { minAlignmentPct: 1 }, schedule: '*/15 * * * *', stackBudget: { objective: 0.99, window: '30d' } });
  const text = readFileSync(saved.path, 'utf8');
  assert(/^schedule: "\*\/15 \* \* \* \*"$/m.test(text), 'saveJourneyDef emits the cron double-quoted', text.split('\n').find(l => l.startsWith('schedule')));
  assert(/^stackBudget:\n {2}objective: 0\.99\n {2}window: 30d$/m.test(text), 'saveJourneyDef emits stackBudget as a mapping', text);
  const back = loadJourneyDef('captured-sched');
  assert(back.schedule === '*/15 * * * *' && back.stackBudget.window === '30d' && parseSchedule(back.schedule).cadenceMs === 900000, 'the saved definition loads back with the same schedule and budget');
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

report('schedule', 'all schedule assertions pass.');
