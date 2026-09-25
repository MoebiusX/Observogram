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
import { inventorySeries } from './inventory-coverage.mjs';

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

// The blast radius a record keeps per degraded node (chain-history.mjs
// blastSummary): the transitive consumers that would go blind if the node
// died — structural exposure, never a claim that they are blind.
export const BLAST_FIELDS = Object.freeze(['slos', 'alerts', 'panels', 'dashboards', 'routes', 'remediations', 'total']);
const compareBlast = (a, b) => (b.slos - a.slos) || (b.alerts - a.alerts) || (b.total - a.total) || (a.label < b.label ? -1 : a.label > b.label ? 1 : 0);

// Every degraded node of the record's DECLARED chains, once, widest first
// (SLOs, then alerts, then total, then label), with every chain it degrades.
// Nodes of undeclared chains are live-only inventory and are left out, as
// chainSummary leaves them out of topExposure. [] without branches.
export function blastRadiusNodes(record) {
  const branches = Array.isArray(record?.branches) ? record.branches.filter(isRecord) : [];
  const acc = new Map();
  for (const b of branches) {
    if (b.verdict === 'undeclared') continue;
    const title = String(b.title || b.rootKey || '?');
    for (const n of (Array.isArray(b.degraded) ? b.degraded : []).filter(isRecord)) {
      const id = typeof n.key === 'string' && n.key ? n.key : `${n.kind ?? '?'}:${n.label ?? '?'}`;
      const radius = isRecord(n.blastRadius) ? n.blastRadius : {};
      const cur = acc.get(id) || {
        key: id, label: String(n.label ?? n.key ?? '?'), kind: String(n.kind ?? 'unknown'),
        status: n.status ?? null, ladderStatus: n.ladder?.status ?? null, chains: [],
        ...Object.fromEntries(BLAST_FIELDS.map((f) => [f, 0])),
      };
      for (const f of BLAST_FIELDS) cur[f] = Math.max(cur[f], num(radius[f]) ?? 0);
      if (!cur.chains.includes(title)) cur.chains.push(title);
      acc.set(id, cur);
    }
  }
  return [...acc.values()].sort(compareBlast);
}

// Exposure per run from the chain summary runJourney stores: the SLOs and
// alerts the widest degraded node would blind (0 when no degraded node
// blinds anything), how many nodes are degraded, and which node is widest.
// Runs without chains are skipped, not zeroed.
export function exposureSeries(runs) {
  return sortRunsOldestFirst(runs)
    .filter((r) => isRecord(r.chains))
    .map((r) => ({
      t: startedMs(r),
      slos: num(r.chains.topExposure?.slos) ?? 0,
      alerts: num(r.chains.topExposure?.alerts) ?? 0,
      degradedNodes: num(r.chains.degradedNodes) ?? 0,
      label: r.chains.topExposure?.label ?? null,
    }));
}

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
    exposure: exposureSeries(sorted),
    blast: blastRadiusNodes(latest),
    inventory: inventoryDetail(sorted),
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
  // The widest exposures across the fleet's newest records: degraded nodes
  // that would blind at least one SLO or alert, with their journey.
  const exposures = list.flatMap((j) => perJourney[j.name].blast.map((n) => ({ ...n, journey: j.name })))
    .filter((n) => n.slos > 0 || n.alerts > 0)
    .sort(compareBlast)
    .slice(0, 12);

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
        degradedNodes: chainsList.reduce((s, c) => s + (num(c.degradedNodes) ?? 0), 0),
      },
      topExposure,
      exposures,
      delivery,
      stackSignal,
      vantageChanged: withRun.filter((j) => j.lastRun.vantageChanged === true).map((j) => j.name),
      inventory: fleetInventory(lastRuns, withRun.map((j) => j.name)),
    },
    series: {
      alignment: list.map((j) => ({ name: j.name, points: perJourney[j.name].alignment })),
      grade: list.map((j) => ({ name: j.name, points: perJourney[j.name].grade })),
      // SLOs the widest degraded node would blind, per run (runs without
      // chains carry no point).
      exposure: list.map((j) => ({ name: j.name, points: perJourney[j.name].exposure.map((e) => ({ t: e.t, v: e.slos })) })),
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
// Inventory coverage per journey: the enumerated kinds' coverage series over the window
// (inventory-coverage.mjs inventorySeries: only checked records carry a point) and the newest
// record's block as it is (any status), so the table can say "not attempted" honestly.
export function inventoryDetail(runs) {
  const sorted = sortRunsOldestFirst(runs);
  const newest = sorted.length ? sorted[sorted.length - 1] : null;
  const latest = newest && isRecord(newest.inventory) ? newest.inventory : null;
  const kinds = new Set();
  for (const r of sorted) {
    for (const [k, c] of Object.entries(isRecord(r.inventory?.kinds) ? r.inventory.kinds : {})) if (isRecord(c) && c.mode === 'enumerated') kinds.add(k);
  }
  return { latest, series: Object.fromEntries([...kinds].map((k) => [k, inventorySeries(sorted, k)])) };
}

// The fleet's inventory coverage from the listing summaries (lastRun.inventory): per
// enumerated kind the sums of inventoried / up / down / silent / unexpected across the journeys
// whose last run checked that kind, per counted kind the totals and the floors undercut, and
// the journeys whose last run could not check (not-attempted, failed, partial). Journeys
// without an inventory: block do not count at all — absence, never coverage.
export function fleetInventory(lastRuns, names = []) {
  const kinds = {}, counted = {};
  const withBlock = [], unchecked = [];
  (Array.isArray(lastRuns) ? lastRuns : []).forEach((r, i) => {
    const inv = isRecord(r?.inventory) ? r.inventory : null;
    if (!inv) return;
    const name = names[i] ?? String(i);
    withBlock.push(name);
    if (inv.status !== 'checked') unchecked.push(name);
    for (const [k, c] of Object.entries(isRecord(inv.kinds) ? inv.kinds : {})) {
      if (!isRecord(c) || c.status !== 'checked') continue;
      if (c.mode === 'counted') {
        const t = counted[k] || (counted[k] = { title: c.title ?? k, total: 0, below: 0, missing: 0, journeys: 0 });
        t.total += num(c.total) ?? 0; t.below += num(c.below) ?? 0; t.missing += num(c.missing) ?? 0; t.journeys += 1;
      } else {
        const t = kinds[k] || (kinds[k] = { title: c.title ?? k, expected: 0, up: 0, down: 0, silent: 0, unexpected: 0, journeys: 0 });
        t.expected += num(c.expected) ?? 0; t.up += num(c.up) ?? 0; t.down += num(c.down) ?? 0; t.silent += num(c.silent) ?? 0; t.unexpected += num(c.unexpected) ?? 0; t.journeys += 1;
      }
    }
  });
  for (const t of Object.values(kinds)) t.coveragePct = t.expected ? Math.round((t.up / t.expected) * 1000) / 10 : null;
  return { journeys: withBlock.length, unchecked, kinds, counted };
}

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

// ---------- the latest check, as a decision ----------
//
// The Neuron page leads with ONE sentence about the journey in focus (the
// 2026-09 UX review): when its latest check ran, which of the outcomes a
// person must tell apart it had — not run · unable to observe (the vantage
// was lost, nothing was looked at) · check failed (the gate breached) ·
// notification failed (the check ran, nobody was warned) — whether a
// declared schedule has stopped producing runs, and whether the history is
// long enough for a trend. Pure; `now` is injected so the tests pin the
// clock. The record's own words stay the keys ('never-run' · 'pass' ·
// 'gate-failed' · 'vantage-lost'); the surface owns the plain wording.

// Fewer runs than this is a reading, not a trend: the charts wait.
export const TREND_MIN_RUNS = 3;
// A scheduled journey whose newest run is older than this many cadences
// (plus a grace for a slow run) has stopped running on schedule.
export const OVERDUE_CADENCES = 2;
const OVERDUE_GRACE_MS = 5 * 60e3;
export const DELIVERY_STATES = Object.freeze(['sent', 'skipped', 'failed', 'not-configured', 'unknown']);

// The delivery of the newest record: 'sent' · 'skipped' (the notify policy
// had nothing to report) · 'failed' (nobody was warned) · 'not-configured'
// (no notify: block — the record says null, or an older record without the
// key on a journey that declares none) · 'unknown' (a record written before
// delivery on a journey that notifies, or an unrecognised status). null
// without a run.
export function deliveryState(detail) {
  const last = detail?.latest;
  if (!last) return null;
  const n = last.notify;
  if (isRecord(n)) return ['sent', 'skipped', 'failed'].includes(n.status) ? n.status : 'unknown';
  if (n === null) return 'not-configured';
  return isRecord(detail?.notify) ? 'unknown' : 'not-configured';
}

// How old the newest run is and whether a declared, regular schedule has
// stopped producing runs. `overdue` is null without a regular cadence (no
// schedule:, or an irregular cron): unknown, never "on time".
export function scheduleLag(detail, { now = Date.now() } = {}) {
  const t = Date.parse(detail?.latest?.startedAt || '');
  const ageMs = Number.isFinite(t) ? Math.max(0, now - t) : null;
  const cadenceMs = num(detail?.schedule?.cadenceMs);
  return {
    ageMs,
    cadenceMs,
    scheduled: isRecord(detail?.schedule),
    overdue: ageMs !== null && cadenceMs ? ageMs > cadenceMs * OVERDUE_CADENCES + OVERDUE_GRACE_MS : null,
  };
}

// Enough history for a trend: TREND_MIN_RUNS runs in the window (`ready`),
// and as many that could observe (`observedReady`) — a vantage-lost run is
// a gap in the alignment line, not a point.
export function trendReadiness(detail) {
  const runs = num(detail?.runs) ?? 0;
  const observed = (Array.isArray(detail?.alignment) ? detail.alignment : []).filter((p) => p && p.v !== null).length;
  return { minRuns: TREND_MIN_RUNS, runs, observed, ready: runs >= TREND_MIN_RUNS, observedReady: observed >= TREND_MIN_RUNS };
}

// The fleet reads as ready once its longest history is (the fleet charts
// draw one line per journey).
export function fleetTrendReadiness(model) {
  const all = Object.values(model?.perJourney || {}).map(trendReadiness);
  const runs = Math.max(0, ...all.map((r) => r.runs));
  const observed = Math.max(0, ...all.map((r) => r.observed));
  return { minRuns: TREND_MIN_RUNS, runs, observed, ready: runs >= TREND_MIN_RUNS, observedReady: observed >= TREND_MIN_RUNS };
}

// Everything the decision about one journey needs, as data.
export function latestCheck(detail, { now = Date.now() } = {}) {
  if (!detail) return null;
  const last = detail.latest;
  return {
    name: detail.name ?? null,
    outcome: last ? last.outcome : 'never-run',
    startedAt: last?.startedAt ?? null,
    delivery: deliveryState(detail),
    breaches: last ? last.breaches.length : 0,
    error: last?.error ?? null,
    loadError: detail.loadError ?? null,
    ...scheduleLag(detail, { now }),
    trend: trendReadiness(detail),
  };
}

// The journeys that need a person, most urgent first: a definition that
// does not load (it can never run), a failed check, a lost vantage, an
// undelivered notification, a schedule that stopped, then never run. Each
// journey appears once, under its most urgent reason; `reasons` keeps the
// rest. Passing, on-time journeys are left out.
export const ATTENTION_REASONS = Object.freeze(['load-error', 'gate-failed', 'vantage-lost', 'notify-failed', 'overdue', 'never-run']);
export function attentionList(model, { now = Date.now() } = {}) {
  const out = [];
  for (const [name, d] of Object.entries(model?.perJourney || {})) {
    const c = latestCheck(d, { now });
    const reasons = ATTENTION_REASONS.filter((r) => (
      r === 'load-error' ? !!c.loadError
        : r === 'notify-failed' ? c.delivery === 'failed'
          : r === 'overdue' ? c.overdue === true
            : c.outcome === r));
    if (reasons.length) out.push({ name, reason: reasons[0], reasons });
  }
  const rank = (r) => ATTENTION_REASONS.indexOf(r);
  return out.sort((a, b) => (rank(a.reason) - rank(b.reason)) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
