// tools/lib/contracts/chaos-run-evidence.mjs
//
// CHAOS RUN FEEDS — the run records a certification harness publishes about
// a pack's chaos experiments, as Observogram reads them through the MCP's
// `metrics_query` tool (the `chaos_run_evidence` capability; the tool name
// lives in mcp-capabilities.mjs only).
//
// THESIS LINE: a run record is SAMPLED, point-in-time evidence. It feeds
// one criterion — the grade's Chaos-validated (studio/diagnostic-grade.mjs
// chaosProof), which weighs its age against the experiment's schedule — and
// never a Verified stamp, an SLO verdict, or a declaration: the live pack
// declares no experiment from it.
//
// A feed row:
//   id       stable feed id
//   source   who publishes it, and where that is verified
//   queries  { pass, finished, mttd } — PromQL, each an instant vector:
//     pass      one series per experiment, label `experiment` (the pack's
//               experiment id) and `status` (PASS | FAIL | anything else =
//               aborted); value 1 on a pass
//     finished  when the run finished, unix seconds (one series)
//     mttd      one series per experiment and expected alert, labels
//               `experiment` and `alertname`, value seconds to the alert
//
// Pure ESM, data + a reducer. No Node APIs.

export const CHAOS_RUN_PROBES = Object.freeze([
  Object.freeze({
    id: 'mq-cert',
    source: 'the MQ lab certification harness (`npm run certify`), published by its alert-sink and scraped as job "certification" (mq-observability-pack harness/alert-sink/server.mjs; charted by tools/lib/dashboards/lib.mjs certTiles / mttdBars)',
    queries: Object.freeze({
      pass: 'mq_cert_experiment_pass',
      finished: 'max(mq_cert_run_timestamp_seconds)',
      mttd: 'mq_cert_mttd_seconds',
    }),
  }),
]);

const seriesOf = (response) => {
  if (Array.isArray(response?.result)) return response.result;
  if (Array.isArray(response?.data?.result)) return response.data.result;
  return null;
};
const valueOf = (series) => {
  const n = Number(series?.value?.[1]);
  return Number.isFinite(n) ? n : null;
};
const OUTCOME_OF = { PASS: 'pass', FAIL: 'fail' };

function formatSeconds(seconds) {
  let s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600); s -= h * 3600;
  const m = Math.floor(s / 60); s -= m * 60;
  return `${h ? `${h}h` : ''}${m ? `${m}m` : ''}${s || (!h && !m) ? `${s}s` : ''}`;
}

/**
 * The runs one feed's three answers say: `{ outcome, runs, reason }`.
 *   outcome  data (at least one experiment) | empty (the feed answered with
 *            nothing) | failed (an answer is not an instant vector)
 *   runs     { <experiment id>: { at, outcome, observed_mttd?, alerts_fired } }
 *            — `at` the run's finish time (the feed records no per-experiment
 *            time); `observed_mttd` the slowest expected alert's time.
 */
export function chaosRunsFromAnswers({ pass, finished, mttd } = {}) {
  const passSeries = seriesOf(pass);
  if (passSeries === null) return { outcome: 'failed', runs: {}, reason: 'the pass answer is not an instant vector' };
  if (!passSeries.length) return { outcome: 'empty', runs: {}, reason: 'no run is published' };
  const finishedSeries = seriesOf(finished) || [];
  const finishedS = finishedSeries.length ? valueOf(finishedSeries[0]) : null;
  if (finishedS === null) return { outcome: 'empty', runs: {}, reason: 'the run publishes no finish time' };
  const at = new Date(finishedS * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const timing = new Map();
  for (const s of seriesOf(mttd) || []) {
    const id = s?.metric?.experiment;
    const alert = s?.metric?.alertname;
    const v = valueOf(s);
    if (!id || !alert || v === null) continue;
    if (!timing.has(id)) timing.set(id, []);
    timing.get(id).push([alert, v]);
  }
  const runs = {};
  for (const s of passSeries) {
    const id = s?.metric?.experiment;
    if (!id || Object.prototype.hasOwnProperty.call(runs, id)) continue;
    const status = String(s.metric.status || (valueOf(s) === 1 ? 'PASS' : '')).toUpperCase();
    const fired = timing.get(id) || [];
    runs[id] = {
      at,
      outcome: OUTCOME_OF[status] || 'aborted',
      ...(fired.length ? { observed_mttd: formatSeconds(Math.max(...fired.map(([, v]) => v))) } : {}),
      alerts_fired: [...new Set(fired.map(([a]) => a))].sort(),
    };
  }
  return Object.keys(runs).length ? { outcome: 'data', runs, reason: null } : { outcome: 'empty', runs: {}, reason: 'no series names an experiment' };
}
