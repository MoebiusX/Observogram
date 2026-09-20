// tools/lib/stack-evidence.mjs
//
// STACK-HEALTH EVIDENCE OVER TIME — pure helpers over journey run records
// (roadmap step 3). A journey run keeps the stack self-metric samples it
// saw as `stackEvidence` (tools/lib/journey.mjs); the run history is the
// time series. These helpers read that history for the surfaces (the
// journeys view, `GET /api/journeys`, the CLI) and for a downstream studio
// that vendors them.
//
// THESIS LINE: every value here is a point-in-time SIGNAL, never a verdict.
// Nothing here creates a `Verified` stamp, an SLO verdict, or a grade
// change; a sampled posture budget is offered only when the cadence and
// window could statistically carry one, and its note says "signal, not
// verdict" either way.
//
// Browser-safe by construction: no Node APIs, no environment, no state.
// The only import is the contracts table (data + lookups), used for the
// table order that breaks ties in `latestByFamily`.

import { STACK_SELF_METRIC_PROBES } from './contracts/stack-self-metrics.mjs';

const TABLE_INDEX = new Map(STACK_SELF_METRIC_PROBES.map((r, i) => [r.id, i]));

// A sampled budget is only offered when the window would allow at least
// this many bad samples at the journey's cadence — below that, one bad
// sample burns a disproportionate share and the fraction reads as noise.
export const STACK_BUDGET_MIN_ALLOWANCE = 10;

// Display formatting for a sampled value by its contracts unit. Pure; a
// non-number reads '—' so a missing sample never prints as a number.
// journey.mjs re-exports this so the CLI, the report and the studio print
// one vocabulary.
export function formatStackValue(value, unit) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '—';
  switch (unit) {
    case 'ratio': return `${(value * 100).toFixed(1)}%`;
    case 'per-second': return `${value.toFixed(3)}/s`;
    case 'per-hour': return `${value.toFixed(1)}/h`;
    case 'seconds': return `${value.toFixed(1)}s`;
    case 'count': return String(Math.round(value));
    default: return String(value);
  }
}

// Display text for a row outcome that is not `data` — the honest
// non-answers, never "ok"/"missing". Unknown outcomes print as themselves.
export function stackOutcomeLabel(outcome) {
  switch (outcome) {
    case 'data': return 'data';
    case 'empty': return 'empty';
    case 'failed': return 'probe failed';
    case 'not-in-inventory': return 'not in inventory';
    case 'not-attempted': return 'not attempted';
    default: return String(outcome ?? 'unknown');
  }
}

const isRecord = (r) => r && typeof r === 'object';
const rowsOf = (record) => (isRecord(record) && isRecord(record.stackEvidence) && Array.isArray(record.stackEvidence.rows))
  ? record.stackEvidence.rows.filter(isRecord)
  : [];
const dataValue = (row) => (row.outcome === 'data' && typeof row.value === 'number' && Number.isFinite(row.value)) ? row.value : null;
const startedMs = (r) => { const t = Date.parse(r?.startedAt || ''); return Number.isFinite(t) ? t : 0; };

// The time series of one row across a journey's runs, oldest → newest.
// `runs` may arrive in any order (readJourneyRuns returns newest first);
// they are sorted by startedAt. A run without stackEvidence, or without
// that row, is a gap and is skipped — nothing is interpolated. Non-data
// outcomes are kept with value null so the series shows when the probe
// stopped answering, not only when it answered.
export function stackSeries(runs, rowId) {
  const sorted = (Array.isArray(runs) ? runs : []).filter(isRecord)
    .map((r, i) => ({ r, i }))
    .sort((a, b) => startedMs(a.r) - startedMs(b.r) || a.i - b.i);
  const out = [];
  for (const { r } of sorted) {
    const row = rowsOf(r).find(x => x.id === rowId);
    if (!row) continue;
    out.push({
      at: typeof row.at === 'string' && row.at ? row.at : (r.startedAt ?? null),
      value: dataValue(row),
      outcome: row.outcome ?? null,
      hint: row.hint ?? null,
    });
  }
  return out;
}

// One row per family from a single run record. Rank: a row that answered
// `data` wins over any non-answer; among data rows the signal an early
// warning needs surfaces first — a `nonzero` hint (a lower-is-comfortable
// row above zero), then a row the contracts table declares before one it
// no longer declares (a retired row's direction is only what the wire
// said), then any lower-is-comfortable row before `higher` / `info` rows
// — and the contracts table order breaks the rest. Without the direction
// ranking a family whose first table row is `higher` or `info`
// (scrape_success_ratio, tsdb_active_series) hid its lower-is-better rows
// whenever that first row answered, and the chip read `scrape 95.0%`
// while the run breached on scrape_targets_down. {} when the record has
// no evidence. `referenceSli` and `reason` ride along so a surface can
// say which SLI vocabulary the row follows and why a probe did not answer.
export function latestByFamily(record) {
  const rank = (row) => {
    const data = dataValue(row) !== null;
    return [
      data ? 0 : 1,
      data && row.hint === 'nonzero' ? 0 : 1,
      TABLE_INDEX.has(row.id) ? 0 : 1,
      data && row.direction === 'lower' ? 0 : 1,
      TABLE_INDEX.has(row.id) ? TABLE_INDEX.get(row.id) : Number.MAX_SAFE_INTEGER,
    ];
  };
  const before = (a, b) => { for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] < b[i]; return false; };
  const best = new Map();
  for (const row of rowsOf(record)) {
    if (typeof row.id !== 'string' || !row.id) continue;
    const family = typeof row.family === 'string' && row.family ? row.family : 'unknown';
    const cur = best.get(family);
    if (!cur || before(rank(row), rank(cur))) best.set(family, row);
  }
  const out = {};
  for (const [family, row] of best) {
    out[family] = {
      id: row.id,
      value: dataValue(row),
      unit: row.unit ?? null,
      direction: row.direction ?? 'info',
      outcome: row.outcome ?? null,
      hint: row.hint ?? null,
      referenceSli: row.referenceSli ?? null,
      ...(row.reason ? { reason: String(row.reason) } : {}),
    };
  }
  return out;
}

// The summary a listing shows per journey: null when the last run carries
// no evidence (file-sourced B, pre-step-3 record); otherwise the status,
// the reason when not attempted, how many rows answered data, and the
// best row per family. `GET /api/journeys` puts this on `lastRun.stack`.
export function stackSummary(record) {
  const se = isRecord(record) ? record.stackEvidence : null;
  if (!isRecord(se) || !se.status) return null;
  return {
    status: se.status,
    reason: se.reason ?? null,
    sampled: rowsOf(record).filter(r => r.outcome === 'data').length,
    families: latestByFamily(record),
  };
}

// How many data samples in a series carried the display hint 'nonzero'
// (a lower-is-comfortable signal above zero). A count of runs, not a
// verdict: "nonzero in N of the last M runs" is an early-warning phrase.
export function nonzeroRuns(series) {
  return (Array.isArray(series) ? series : []).filter(s => s && s.outcome === 'data' && s.hint === 'nonzero').length;
}

// A sampled posture budget over a series — offered only when the cadence
// heuristic says the window could carry one. With objective o, cadence c
// and window w, the window allows (1 - o) * w / c bad samples; below
// STACK_BUDGET_MIN_ALLOWANCE the budget is not measurable at that cadence
// (e.g. 99.99 % over 30 d at a 15 min cadence allows 0.29 bad samples: a
// single bad run overshoots by 3x and reads as noise). `isBad(sample)`
// decides badness per data sample; the default is the 'nonzero' hint.
// fraction = good / samples, null when there is no data sample. Never a
// verdict: the note says so in both branches.
export function stackPostureBudget(series, { objective, cadenceMs, windowMs, isBad } = {}) {
  const bad_ = typeof isBad === 'function' ? isBad : (s) => s.hint === 'nonzero';
  const data = (Array.isArray(series) ? series : []).filter(s => s && s.outcome === 'data');
  const samples = data.length;
  const bad = data.filter(s => !!bad_(s)).length;
  const fraction = samples > 0 ? (samples - bad) / samples : null;
  const okInputs = typeof objective === 'number' && objective >= 0 && objective < 1
    && typeof cadenceMs === 'number' && cadenceMs > 0
    && typeof windowMs === 'number' && windowMs > 0;
  // Rounded to 6 decimals so the printed allowance and the comparison
  // agree at the floor ((1 - 0.9) * 100 is 9.999999999999998 in IEEE 754).
  const allowance = okInputs ? Number(((1 - objective) * windowMs / cadenceMs).toFixed(6)) : null;
  const measurable = allowance !== null && allowance >= STACK_BUDGET_MIN_ALLOWANCE;
  const fmtAllow = allowance === null ? '?' : (Number.isInteger(allowance) ? String(allowance) : allowance.toFixed(2));
  const note = !okInputs
    ? 'no budget: objective must be in [0, 1) and cadence / window positive — signal, not verdict'
    : measurable
      ? `${bad} bad of ${samples} sampled runs; the window allows ${fmtAllow} bad samples at this cadence — a sampled posture, signal, not verdict`
      : `not measurable at this cadence: the window allows ${fmtAllow} bad samples (< ${STACK_BUDGET_MIN_ALLOWANCE}); ${bad} bad of ${samples} sampled runs is signal, not verdict`;
  return { samples, bad, fraction, allowance, measurable, note };
}
