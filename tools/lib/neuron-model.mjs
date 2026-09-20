// tools/lib/neuron-model.mjs
//
// The Neuron view's model (Advanced → Neuron): the fleet of saved journeys
// read as ONE instrument — the observability control neuron that watches
// the artefacts which monitor the system. Pure and browser-safe (the studio
// imports it at call time from /lib, node:test imports it directly): takes
// what GET /api/journeys and GET /api/journeys/:name/runs return and derives
// every number, series and table the view draws. Nothing here fetches,
// nothing reads state, nothing renders.
//
// Honesty rules carried over from the run record (docs/MCP_INTEGRATION.md):
//   - A vantage-lost run has no drift facts: it is a GAP in the alignment /
//     grade series (value null), never a 0.
//   - Stack self-metric samples are signals, not verdicts: the model keeps
//     their direction and hint so a surface can mark "nonzero", and never
//     turns them into pass/fail.
//   - Ladder buckets are on-wire liveness beside the scored verdict; counts.
//   - Candidate causes are ranked by evidence, not root-cause verdicts.
//   - Means are over the journeys that HAVE the number; an empty set is null,
//     never 100 %. Deltas are paired (latest − previous per journey), so a
//     journey that gained a first run never moves the fleet delta.
//
// Everything returned is plain JSON-able data.

import { stackSeries, latestByFamily } from './stack-evidence.mjs';

export const OUTCOMES = Object.freeze(['pass', 'gate-failed', 'vantage-lost']);
export const LADDER_KEYS = Object.freeze(['healthy', 'degraded', 'broken', 'unobserved']);
export const NEURON_WINDOWS = Object.freeze([20, 50, 100, 200]);
export const NEURON_WINDOW_DEFAULT = 50;
export const NEURON_METRICS = Object.freeze(['alignment', 'grade']);

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const startedMs = (r) => { const t = Date.parse(r?.startedAt || ''); return Number.isFinite(t) ? t : null; };
const round1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const mean = (values) => {
  const xs = values.filter((v) => v !== null);
  return xs.length ? round1(xs.reduce((s, v) => s + v, 0) / xs.length) : null;
};

// Oldest → newest by startedAt; records without a parseable time sort
// first in their input order (a broken record is still a run).
export function sortRunsOldestFirst(runs) {
  return (Array.isArray(runs) ? runs : []).filter(isRecord)
    .map((r, i) => ({ r, i, t: startedMs(r) }))
    .sort((a, b) => ((a.t ?? -Infinity) - (b.t ?? -Infinity)) || a.i - b.i)
    .map((x) => x.r);
}

const alignmentOf = (r) => num(r?.drift?.alignmentPct);
const gradeOf = (r) => num(r?.grade?.score);
const outcomeOf = (r) => (OUTCOMES.includes(r?.outcome) ? r.outcome : 'unknown');

// One {t, v} per run, oldest first. v is null on a vantage-lost run (no
// drift facts) — a gap the chart must leave open.
export function metricPoints(runs, metric = 'alignment') {
  const pick = metric === 'grade' ? gradeOf : alignmentOf;
  return sortRunsOldestFirst(runs).map((r) => ({ t: startedMs(r), v: pick(r), outcome: outcomeOf(r) }));
}

// Paired delta: mean over journeys of (latest − previous) for the journeys
// that carry both numbers. null when none does.
function pairedDelta(perJourneyPairs) {
  const ds = perJourneyPairs.filter(([a, b]) => a !== null && b !== null).map(([a, b]) => a - b);
  return ds.length ? round1(ds.reduce((s, d) => s + d, 0) / ds.length) : null;
}

// Latest and previous value of a metric for one journey's runs (oldest
// first), skipping vantage-lost gaps for the PREVIOUS only: the latest is
// the newest run whatever it holds (a gap is the honest latest).
function latestAndPrevious(runs, pick) {
  const sorted = sortRunsOldestFirst(runs);
  const latest = sorted.length ? pick(sorted[sorted.length - 1]) : null;
  let previous = null;
  for (let i = sorted.length - 2; i >= 0; i--) { const v = pick(sorted[i]); if (v !== null) { previous = v; break; } }
  return [latest, previous];
}

// Count by a string key over a list; sorted desc by count then key.
function countBy(list, keyOf) {
  const acc = new Map();
  for (const item of list) {
    const k = keyOf(item);
    if (k === null || k === undefined || k === '') continue;
    acc.set(String(k), (acc.get(String(k)) || 0) + 1);
  }
  return [...acc.entries()].map(([key, count]) => ({ key, count }))
    .sort((a, b) => (b.count - a.count) || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

const breachesOf = (r) => (Array.isArray(r?.gate?.breaches) ? r.gate.breaches.filter(isRecord) : []);
const causesOf = (r) => {
  const box = r?.causes;
  const list = Array.isArray(box) ? box : (isRecord(box) && Array.isArray(box.causes) ? box.causes : []);
  return list.filter(isRecord);
};
const stackRowsOf = (r) => (isRecord(r?.stackEvidence) && Array.isArray(r.stackEvidence.rows) ? r.stackEvidence.rows.filter(isRecord) : []);

// Ladder buckets per run from the chain summary runJourney stores on the
// record (`chains`, chainSummary). A run without chains is skipped, not
// zeroed: an absent chain record is not four empty buckets.
export function ladderSeries(runs) {
  return sortRunsOldestFirst(runs)
    .filter((r) => isRecord(r.chains) && isRecord(r.chains.ladder))
    .map((r) => ({
      t: startedMs(r),
      healthy: num(r.chains.ladder.healthy) ?? 0,
      degraded: num(r.chains.ladder.degraded) ?? 0,
      broken: num(r.chains.ladder.broken) ?? 0,
      unobserved: num(r.chains.ladder.unobserved) ?? 0,
      intact: num(r.chains.intact) ?? 0,
      declaredTotal: num(r.chains.declaredTotal) ?? 0,
      integrityPct: num(r.chains.integrityPct),
      ladderIntegrityPct: num(r.chains.ladderIntegrityPct),
    }));
}

// Every stack row id seen across the runs, with the metadata of its newest
// appearance and its series (stack-evidence.mjs stackSeries: gaps where a
// run carried no sample, null values where the probe did not answer).
export function stackRowSeries(runs) {
  const sorted = sortRunsOldestFirst(runs);
  const meta = new Map();
  for (const r of sorted) {
    for (const row of stackRowsOf(r)) {
      if (typeof row.id !== 'string' || !row.id) continue;
      meta.set(row.id, { id: row.id, family: row.family ?? null, product: row.product ?? null, unit: row.unit ?? null, direction: row.direction ?? null, referenceSli: row.referenceSli ?? null });
    }
  }
  return [...meta.values()].map((m) => {
    const series = stackSeries(sorted, m.id);
    const data = series.filter((s) => s.outcome === 'data' && typeof s.value === 'number');
    return {
      ...m,
      series,
      samples: data.length,
      nonzero: data.filter((s) => s.hint === 'nonzero').length,
      latest: series.length ? series[series.length - 1] : null,
    };
  }).sort((a, b) => (b.nonzero - a.nonzero) || (directionRank(a.direction) - directionRank(b.direction)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// The early-warning rows first (same reading as stack-evidence.mjs
// latestByFamily): a row that read nonzero, then lower-is-comfortable rows,
// then higher-is-good, then info.
const directionRank = (d) => (d === 'lower' ? 0 : d === 'higher' ? 1 : d === 'info' ? 2 : 3);

// The per-journey slice: series and the newest record's detail blocks.
export function buildJourneyDetail(journey, runs) {
  const sorted = sortRunsOldestFirst(runs);
  const latest = sorted.length ? sorted[sorted.length - 1] : null;
  const rows = stackRowSeries(sorted);
  return {
    name: journey?.name ?? null,
    loadError: journey?.loadError ?? null,
    packA: journey?.packA ?? null,
    packB: journey?.packB ?? null,
    scope: journey?.scope ?? null,
    gate: journey?.gate ?? {},
    schedule: journey?.schedule ?? null,
    stackBudget: journey?.stackBudget ?? null,
    notify: journey?.notify ?? null,
    runs: sorted.length,
    outcomes: Object.fromEntries(OUTCOMES.map((o) => [o, sorted.filter((r) => r.outcome === o).length])),
    alignment: metricPoints(sorted, 'alignment'),
    grade: metricPoints(sorted, 'grade'),
    durations: sorted.map((r) => ({ t: startedMs(r), v: num(r.tookMs) })),
    ladder: ladderSeries(sorted),
    stackRows: rows,
    breachFrequency: countBy(sorted.flatMap(breachesOf), (b) => b.criterion),
    latest: latest ? {
      startedAt: latest.startedAt ?? null,
      tookMs: num(latest.tookMs),
      outcome: outcomeOf(latest),
      error: typeof latest.error === 'string' ? latest.error : null,
      drift: isRecord(latest.drift) ? latest.drift : null,
      grade: isRecord(latest.grade) ? latest.grade : null,
      conformance: isRecord(latest.conformance) ? latest.conformance : null,
      traceability: isRecord(latest.traceability) ? latest.traceability : null,
      freshness: isRecord(latest.freshness) ? latest.freshness : null,
      breaches: breachesOf(latest),
      chains: isRecord(latest.chains) ? latest.chains : null,
      branches: Array.isArray(latest.branches) ? latest.branches.filter(isRecord) : [],
      transition: isRecord(latest.transition) ? latest.transition : null,
      causes: isRecord(latest.causes) ? { ...latest.causes, causes: causesOf(latest) } : null,
      versions: isRecord(latest.versions) ? latest.versions : null,
      vantage: {
        vantage: latest.vantage ?? null,
        probes: isRecord(latest.probes) ? latest.probes : null,
        probeErrors: latest.probeErrors ?? null,
        toolsExposedCount: num(latest.toolsExposedCount),
        scrapeJobsDown: num(latest.scrapeJobsDown),
        unhealthyRules: num(latest.unhealthyRules),
      },
      stackEvidence: isRecord(latest.stackEvidence) ? {
        status: latest.stackEvidence.status ?? null,
        reason: latest.stackEvidence.reason ?? null,
        rows: stackRowsOf(latest),
        alertmanager: isRecord(latest.stackEvidence.alertmanager) ? latest.stackEvidence.alertmanager : null,
        grafana: isRecord(latest.stackEvidence.grafana) ? latest.stackEvidence.grafana : null,
        families: latestByFamily(latest),
      } : null,
      notify: isRecord(latest.notify) ? latest.notify : (latest.notify === null ? null : undefined),
      historyError: latest.historyError ?? null,
      packA: isRecord(latest.packA) ? latest.packA : null,
      packB: isRecord(latest.packB) ? latest.packB : null,
    } : null,
  };
}

// The fleet: every journey read together.
//   journeys   — GET /api/journeys `.journeys`
//   runsByName — { [name]: GET /api/journeys/:name/runs `.runs` } (any order,
//                already limited to the window by the caller)
//   window     — how many newest runs per journey the series keep
export function buildNeuronModel({ journeys = [], runsByName = {}, window = NEURON_WINDOW_DEFAULT } = {}) {
  const list = (Array.isArray(journeys) ? journeys : []).filter(isRecord);
  const win = Math.max(1, Math.floor(num(window) ?? NEURON_WINDOW_DEFAULT));
  const runsOf = (name) => sortRunsOldestFirst(runsByName?.[name]).slice(-win);

  const perJourney = {};
  for (const j of list) perJourney[j.name] = buildJourneyDetail(j, runsOf(j.name));

  const withRun = list.filter((j) => isRecord(j.lastRun));
  const lastRuns = withRun.map((j) => j.lastRun);
  const outcomes = {
    pass: lastRuns.filter((r) => r.outcome === 'pass').length,
    'gate-failed': lastRuns.filter((r) => r.outcome === 'gate-failed').length,
    'vantage-lost': lastRuns.filter((r) => r.outcome === 'vantage-lost').length,
    'never-run': list.length - withRun.length,
  };

  const alignPairs = list.map((j) => latestAndPrevious(runsOf(j.name), alignmentOf));
  const gradePairs = list.map((j) => latestAndPrevious(runsOf(j.name), gradeOf));
  const chainsList = lastRuns.map((r) => r.chains).filter(isRecord);
  const ladder = Object.fromEntries(LADDER_KEYS.map((k) => [k, chainsList.reduce((s, c) => s + (num(c.ladder?.[k]) ?? 0), 0)]));

  let topExposure = null;
  for (const j of withRun) {
    const t = j.lastRun.chains?.topExposure;
    if (!isRecord(t)) continue;
    const cand = { journey: j.name, label: t.label ?? '?', kind: t.kind ?? 'unknown', slos: num(t.slos) ?? 0, alerts: num(t.alerts) ?? 0 };
    if (!topExposure || cand.slos > topExposure.slos || (cand.slos === topExposure.slos && cand.alerts > topExposure.alerts)) topExposure = cand;
  }

  const delivery = countBy(lastRuns, (r) => (isRecord(r.notify) ? (r.notify.status ?? 'unknown') : null));
  const stackSignal = withRun.filter((j) => {
    const fams = j.lastRun.stack?.families;
    return isRecord(fams) && Object.values(fams).some((row) => isRecord(row) && row.hint === 'nonzero');
  }).map((j) => j.name);

  const allRuns = list.flatMap((j) => runsOf(j.name).map((r) => ({ journey: j.name, r })));
  const columns = Math.max(0, ...list.map((j) => runsOf(j.name).length));

  return {
    window: win,
    generatedFrom: { journeys: list.length, runs: allRuns.length },
    fleet: {
      journeys: list.length,
      loadErrors: list.filter((j) => j.loadError).length,
      scheduled: list.filter((j) => isRecord(j.schedule)).length,
      notifying: list.filter((j) => isRecord(j.notify)).length,
      stackGated: list.filter((j) => isRecord(j.gate?.stack?.rows) && Object.keys(j.gate.stack.rows).length > 0).length,
      outcomes,
      alignment: { mean: mean(alignPairs.map(([a]) => a)), delta: pairedDelta(alignPairs), n: alignPairs.filter(([a]) => a !== null).length },
      grade: { mean: mean(gradePairs.map(([a]) => a)), delta: pairedDelta(gradePairs), n: gradePairs.filter(([a]) => a !== null).length },
      chains: {
        journeys: chainsList.length,
        intact: chainsList.reduce((s, c) => s + (num(c.intact) ?? 0), 0),
        declaredTotal: chainsList.reduce((s, c) => s + (num(c.declaredTotal) ?? 0), 0),
        ladder,
        worse: withRun.filter((j) => (num(j.lastRun.transition?.worse) ?? 0) > 0).map((j) => j.name),
        integrityPct: mean(chainsList.map((c) => num(c.integrityPct))),
        ladderIntegrityPct: mean(chainsList.map((c) => num(c.ladderIntegrityPct))),
      },
      topExposure,
      delivery,
      stackSignal,
      vantageChanged: withRun.filter((j) => j.lastRun.vantageChanged === true).map((j) => j.name),
    },
    series: {
      alignment: list.map((j) => ({ name: j.name, points: perJourney[j.name].alignment })),
      grade: list.map((j) => ({ name: j.name, points: perJourney[j.name].grade })),
    },
    heatmap: {
      columns,
      rows: list.map((j) => {
        const runs = runsOf(j.name);
        const cells = runs.map((r) => ({ t: startedMs(r), outcome: outcomeOf(r), alignment: alignmentOf(r), grade: gradeOf(r), breaches: breachesOf(r).length }));
        return { name: j.name, cells: [...Array(columns - cells.length).fill(null), ...cells] };
      }),
    },
    breachFrequency: countBy(allRuns.flatMap(({ r }) => breachesOf(r)), (b) => b.criterion),
    causeKinds: countBy(allRuns.flatMap(({ r }) => causesOf(r)), (c) => c.kind),
    perJourney,
  };
}

// The journey the view should focus when nothing is selected (or the
// selection vanished): the one that most needs eyes — a chain got worse,
// then gate-failed, then vantage-lost, then the lowest alignment, then the
// first by name. null with no journeys.
export function defaultFocus(model) {
  const names = Object.keys(model?.perJourney || {});
  if (!names.length) return null;
  const score = (name) => {
    const d = model.perJourney[name];
    const last = d.latest;
    const worse = (model.fleet.chains.worse || []).includes(name) ? 0 : 1;
    const outcome = !last ? 3 : last.outcome === 'gate-failed' ? 0 : last.outcome === 'vantage-lost' ? 1 : 2;
    const align = last?.drift?.alignmentPct ?? 101;
    return [worse, outcome, align, name];
  };
  return names.slice().sort((a, b) => {
    const sa = score(a), sb = score(b);
    for (let i = 0; i < sa.length; i++) if (sa[i] !== sb[i]) return sa[i] < sb[i] ? -1 : 1;
    return 0;
  })[0];
}
