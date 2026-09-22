// Generic dashboards from any ObservabilityPack.
//
// Every pack gets a Unified Observability board, `<name>-unified`, whether or not it declares
// one: the whole pack on one page in the pack's own section order (§1-2 contract: every SLI
// and SLO → §10 validation: MTTD, MTTR, certification and the synthetic checks → §7-8 policy and
// alerting → §9 remediation → the signals behind the SLIs: pack-module rows and the pack's
// derived views → §3-5 pipelines → logs and traces). It is the board that matters most; the
// declared boards are views of it.
//
// Then one board per `spec.dashboards[]` entry: a `source:` entry gets exactly what its
// `panel_bindings` declare (SLI tiles, error-budget burn for bound SLOs, per-resource rollups
// for bound derived views) plus the alert timelines; `template: ref:platform/slo-burn-template`
// becomes a real burn board for `params.slos`; `ref:platform/per-resource-template` a board for
// `params.view`. A pack module (tools/gen-dashboards.mjs --module) can replace the derived SLI
// tiles with hand-written ones, add synthetic panels, and add signal rows per board id.
//
// Every row the generator emits is 24 columns wide with one height (lib.mjs header): SLI and
// SLO tiles take splitWidths(n), derived views viewWidths(n), and a source board's contract block
// is shaped by how many SLIs it binds (contractPanels).
import {
  configure, ctx, humanize, row, text, stat, ts, logs, traces, header, dashboard, resetIds, splitWidths, viewWidths, viewRenders,
  derivedSliTiles, derivedViewPanel, burnBars, burnCurves, burnThresholds, alertTimelines, alertTable, alertCounters,
  certTiles, mttdBars, mttrBars, certCounts, remediationTable, okAbove, C, DS,
} from './lib.mjs';
import { metricSafe, metricPrefix } from '../burn-rules.mjs';

const basename = (p) => String(p).replace(/^file:\/\//, '').split('/').pop();
export const unifiedIdOf = (pack) => `${pack.metadata.name}-unified`;
/** "grafana-alerting-health" → "Alerting health" (the pack name prefix is dropped). */
export function titleOf(pack, d) {
  if (d.id === unifiedIdOf(pack)) return 'Unified Observability';
  const id = String(d.id).replace(new RegExp(`^${pack.metadata.name}[-_]`), '');
  return humanize(id);
}
function bindings(d) {
  const out = { slis: [], slos: [], views: [] };
  for (const b of d.panel_bindings || []) {
    const t = String(b.binds_to);
    let m;
    if ((m = /^slis\.(.+)$/.exec(t))) out.slis.push(m[1]);
    else if ((m = /^slos\.(.+)$/.exec(t))) out.slos.push(m[1]);
    else if ((m = /^ref:queries\.(.+)$/.exec(t))) out.views.push(m[1]);
  }
  return out;
}
const scrapeJobs = (pack) => (pack.spec.pipelines?.receivers || []).flatMap(r => (r.scrape_configs || []).map(s => s.job_name)).filter(Boolean);
const backendProducts = (pack) => new Set((pack.spec.telemetry?.backends || []).map(b => b.product));
/** The pack declares a certification feed: a scrape job named `certification` (what the MQ harness's alert-sink is scraped as). */
const hasCertificationFeed = (pack) => scrapeJobs(pack).includes('certification');

/**
 * §10 validation row. The certification tiles read `{job="certification", pack="<name>"}` (lib.mjs
 * `certSel`; the pack matcher stays, or the MQ harness's verdict would show on every other pack's
 * board), so on a pack no harness certifies every tile is empty. The tiles are rendered only when
 * the pack declares that feed; a pack with chaos experiments and no feed gets the row header and
 * one text panel that says exactly that (the same note pattern as logsTracesPanels).
 */
function validationPanels(pack) {
  const chaos = pack.spec.validation?.chaos_experiments || [];
  if (!chaos.length) return [];
  const head = row('§10 · Validation — MTTD, MTTR and certification');
  if (hasCertificationFeed(pack)) return [head, ...certTiles(), mttdBars(12, 8), mttrBars(12, 8), ...certCounts()];
  const engines = [...new Set(chaos.map(e => e.engine).filter(Boolean))], envs = [...new Set(chaos.map(e => e.environment).filter(Boolean))];
  const where = [engines.length ? engines.join(', ') : null, envs.length ? envs.join(', ') : null].filter(Boolean).join('; ');
  return [head, text(`The pack declares ${chaos.length} chaos experiment${chaos.length === 1 ? '' : 's'}${where ? ` (${where})` : ''} but no certification pipeline — a scrape job named \`certification\` — so nothing feeds MTTD, MTTR or a verdict here.`, { title: 'No certification feed', h: 3 })];
}

function pipelinesPanels(pack) {
  // The metric-name prefix (`payment-service` → `payment_service`): every recording rule the
  // generators emit is named with it, so a raw dashed name here would match no series.
  const svc = metricPrefix(pack.metadata.name);
  const jobs = scrapeJobs(pack);
  return [
    row('§3-5 · Pipelines, storage and queries'),
    stat('TSDB series', 'max(prometheus_tsdb_head_series)', { desc: 'Active series in the metrics store.', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Samples appended / s', 'sum(rate(prometheus_tsdb_head_samples_appended_total[2m]))', { unit: 'ops', decimals: 0, mode: 'none', w: 4, h: 5 }),
    stat('Recording rules producing', `count(count by (__name__)({__name__=~"${svc}:.*"}))`, { desc: `Distinct ${svc}:* recording-rule series currently produced (pack queries + generated error-budget rules).`, decimals: 0, mode: 'none', spark: false, w: 4, h: 5 }),
    ts('Scrape duration by job', [{ expr: jobs.length ? `max by (job)(scrape_duration_seconds{job=~"${jobs.join('|')}"})` : 'max by (job)(scrape_duration_seconds)', legend: '{{job}}' }], { desc: jobs.length ? `The pack's scrape jobs: ${jobs.join(', ')}.` : 'Every scrape job.', unit: 's', w: 12, h: 5 }),
    ts('Collector · exported per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_metric_points_total[2m]))', legend: 'metric points → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_log_records_total[2m]))', legend: 'log records → {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_sent_spans_total[2m]))', legend: 'spans → {{exporter}}' },
    ], { desc: 'OpenTelemetry Collector export throughput (present when the pack pipeline runs through a collector).', unit: 'ops', h: 6, colors: { '/^metric points/': C.blue, '/^log records/': C.green, '/^spans/': C.violet } }),
    ts('Collector · export failures per second', [
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_metric_points_total[2m])) or vector(0)', legend: 'metric points {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_log_records_total[2m])) or vector(0)', legend: 'log records {{exporter}}' },
      { expr: 'sum by (exporter)(rate(otelcol_exporter_send_failed_spans_total[2m])) or vector(0)', legend: 'spans {{exporter}}' },
    ], { desc: 'The failure counters only exist once a batch has failed; a flat zero is the collector saying nothing has.', unit: 'ops', h: 6, colors: { '/.*/': C.red } }),
  ];
}
function logsTracesPanels(pack) {
  const svc = pack.metadata.name, products = backendProducts(pack), out = [row('Logs and traces')];
  if (products.has('loki')) out.push(logs('Logs', `{service_name="${svc}"}`, { desc: `Log lines the collector labelled service_name="${svc}".`, h: 9 }));
  if (products.has('tempo')) out.push(traces('Recent traces', `{ resource.service.name = "${svc}" }`, { desc: `Traces whose resource is the ${svc} service.`, h: 8 }));
  if (out.length === 1) {
    const declared = [...products].filter(p => ['elasticsearch', 'opensearch', 'jaeger', 'splunk'].includes(p));
    out.push(text(`The pack declares ${declared.length ? declared.join(', ') : 'no Loki or Tempo backend'} for logs and traces; this generator renders Loki and Tempo panels only.`, { title: 'Logs and traces', h: 3 }));
  }
  return out;
}
/** The pack's synthetic checks as declared (id, kind, target, interval, assertions, severity): what the canary of this pack is supposed to prove. */
function syntheticTable(pack) {
  const checks = pack.spec.validation?.synthetic_checks || [];
  const fmt = (a) => (a && typeof a === 'object' ? Object.entries(a).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : String(a));
  const rows = checks.map(c => `| \`${c.id}\` | ${c.kind || '-'} | \`${c.target || '-'}\` | ${c.interval || '-'} | ${(c.assertions || []).map(fmt).join('; ') || '-'} | ${c.on_fail_severity || '-'} |`);
  return text(`| Check | Kind | Target | Interval | Assertions | On fail |\n|---|---|---|---|---|---|\n${rows.join('\n')}\n\n<small>Declared in the pack's \`validation.synthetic_checks\`; the pack module supplies the panels that show the probes' own metrics.</small>`, { title: 'Synthetic checks · as declared', h: Math.min(3 + checks.length, 8) });
}
/** One burn tile per SLO of a burn-template board, the run filling its row (8 SLOs → 8 × w3). */
const sloTiles = (pack, sloIds) => { const c = ctx(); const slos = pack.spec.slos.filter(s => sloIds.includes(s.id)); const widths = splitWidths(slos.length); return slos.map((s, i) =>
  stat(`${c.sloRename[s.id]} · burn 1 h`, `${c.svc}:errorbudget:burn_1h{slo="${s.id}"}`, { binds: `slos.${s.id}`, desc: `1 h burn rate of ${c.sloLabel[s.id]} (objective ${s.objective} over ${s.window}).`, decimals: 1, thresholds: burnThresholds(s.id), w: widths[i] })); };

/**
 * Build every board for a pack: the unified board first, then one per `spec.dashboards[]` entry.
 * Returns [{ id, file, dashboard }]. `module` may provide `configure(pack)` (displayName, sloLabel,
 * certSel, repoUrl), `sliTiles(pack, ids)`, `synthetic(pack)` (panels for the synthetic row) and
 * `signals[boardId]` (extra panels, inserted after remediation on the unified board and at the end
 * of a declared board).
 */
export function genericBoards(pack, { module = null, repoUrl = null } = {}) {
  const dashboards = pack.spec.dashboards || [];
  const unifiedId = unifiedIdOf(pack);
  const declaredUnified = dashboards.find(d => d.id === unifiedId) || null;
  const overrides = module?.configure ? module.configure(pack) : {};
  configure({ pack, repoUrl, ...overrides, boards: [[unifiedId, 'Unified'], ...dashboards.filter(d => d.id !== unifiedId).map(d => [d.id, titleOf(pack, d)])] });
  const c = ctx();
  const synth = pack.spec.validation?.synthetic_checks || [];
  const views = Object.fromEntries((pack.spec.queries?.derived_views || []).map(v => [v.id, v]));
  const allSlis = (pack.spec.slis || []).map(s => s.id), allSlos = (pack.spec.slos || []).map(s => s.id);
  // SLI tiles fill their row (splitWidths) unless the module draws its own; a source board that
  // binds one or two SLIs puts them at the burn panels' height so the contract block is one row.
  const tiles = (ids, { widths = splitWidths(ids.length), h = 4 } = {}) => (module?.sliTiles ? module.sliTiles(pack, ids) : derivedSliTiles(pack, ids, { widths, h }));
  // Derived views: the ones that render as time series share rows by viewWidths (graphs first),
  // then every note — an undeclared or unrenderable view — takes a w24 row of its own.
  const viewPanels = (ids) => {
    const graphs = ids.filter(v => views[v] && viewRenders(pack, views[v])), widths = viewWidths(graphs.length);
    const notes = ids.filter(v => !graphs.includes(v));
    return [
      ...graphs.map((v, i) => derivedViewPanel(pack, views[v], `ref:queries.${v}`, { w: widths[i] })),
      ...notes.map(v => (views[v] ? derivedViewPanel(pack, views[v], `ref:queries.${v}`) : text(`Derived view \`${v}\` is bound but not declared in spec.queries.derived_views.`, { title: humanize(v), h: 3 }))),
    ];
  };
  // A source board's §1-2 block, by the number of SLIs it binds (N) when it binds SLOs too:
  // N ≥ 3 the tiles on a row of their own, then the bar gauge w12 with the two burn curves w6;
  // N = 2 both tiles w6 h8 beside the bar gauge w12, the curves w12 on the next row;
  // N = 1 the tile, the bar gauge and the two curves w6 h8 on one row; N = 0 the bar gauge and
  // the curves. Without bound SLOs: the tiles only. The bar gauge is filtered to the bound SLOs.
  const contractPanels = (b) => {
    const n = b.slis.length;
    if (!n && !b.slos.length) return [];
    const head = row('§1-2 · Contract — SLIs and SLOs');
    if (!b.slos.length) return [head, ...tiles(b.slis)];
    const bars = (w) => burnBars(b.slos.map(s => `slos.${s}`), w, 8, b.slos);
    if (n === 0) return [head, bars(12), ...burnCurves(6, 'hidden')];
    if (n === 1) return [head, ...tiles(b.slis, { widths: [6], h: 8 }), bars(6), ...burnCurves(6, 'hidden')];
    if (n === 2) return [head, ...tiles(b.slis, { widths: [6, 6], h: 8 }), bars(12), ...burnCurves(12, 'hidden')];
    return [head, ...tiles(b.slis), bars(12), ...burnCurves(6, 'hidden')];
  };
  const out = [];

  // ---------------------------------------------------------------- unified (pack order)
  resetIds();
  const unified = [
    header('Unified Observability', 'One board in the pack\'s own order: SLIs and SLOs, the validation that proves them (MTTD, MTTR, certification, synthetic checks), policy and alerting, remediation, the signals underneath, the pipeline, logs and traces.', unifiedId),
    row('§1-2 · Contract — SLIs and SLOs'),
    ...tiles(allSlis),
    ...(allSlos.length ? [burnBars(allSlos.map(s => `slos.${s}`), 12, 8), ...burnCurves(6, 'hidden')] : []),
    ...validationPanels(pack),
    ...(synth.length || module?.synthetic ? [row('§10 · Validation — synthetic checks'), ...(module?.synthetic ? module.synthetic(pack) : []), ...(synth.length ? [syntheticTable(pack)] : [])] : []),
    row('§7-8 · Policy and alerting'),
    ...alertCounters(4), alertTimelines(12, 4)[0], alertTable(12, 8), alertTimelines(12, 8)[1],
    ...((pack.spec.remediation || []).length ? [row('§9 · Remediation — runbooks and guardrails'), remediationTable()] : []),
    ...(module?.signals?.[unifiedId] || []),
    ...(Object.keys(views).length ? [row('Signals — the pack\'s derived views'), ...viewPanels(Object.keys(views))] : []),
    ...pipelinesPanels(pack),
    ...logsTracesPanels(pack),
  ];
  out.push({ id: unifiedId, file: declaredUnified?.source ? basename(declaredUnified.source) : `${unifiedId}.json`, dashboard: dashboard(unifiedId, `${c.displayName} — Unified Observability`, unified, [pack.metadata.name, 'pack', 'unified'], {
    description: `Everything about ${c.displayName} on one board, in the pack's order: SLIs and SLOs, MTTD/MTTR and certification, policy and alerting, remediation, signals, pipeline, logs and traces.`,
    time: { from: 'now-3h', to: 'now' },
  }) });

  // ---------------------------------------------------------------- declared boards
  for (const d of dashboards) {
    if (d.id === unifiedId) continue;
    resetIds();
    const title = titleOf(pack, d);
    const tags = [pack.metadata.name, 'pack'];
    if (d.source) {
      const b = bindings(d);
      const blurb = [b.slis.length ? `SLIs ${b.slis.join(', ')}` : null, b.slos.length ? `SLOs ${b.slos.join(', ')}` : null, b.views.length ? `views ${b.views.join(', ')}` : null].filter(Boolean).join(' · ') || 'Pack-declared board.';
      const panels = [
        header(title, `${blurb}.`, d.id),
        ...contractPanels(b),
        ...(b.views.length ? [row('§5 · Derived views'), ...viewPanels(b.views)] : []),
        row('Alerting'), ...alertTimelines(12, 6),
        ...(module?.signals?.[d.id] || []),
      ];
      out.push({ id: d.id, file: basename(d.source), dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, tags, { description: `${c.displayName} pack board "${title}": ${blurb}.` }) });
      continue;
    }
    const tpl = String(d.template || '');
    if (/slo-burn-template$/.test(tpl)) {
      const sloIds = (d.params?.slos || []).filter(id => allSlos.includes(id));
      const panels = [
        header(title, 'Error-budget burn per SLO on the fast and slow windows, and the burn-rate / forecast alert history.', d.id),
        ...sloTiles(pack, sloIds),
        burnBars(null, 12, 8, sloIds),
        alertTimelines(12, 8)[1],
        ...burnCurves(12),
        ts('Error ratio · 5 m, per SLI', [{ expr: `{__name__=~"${c.svc}:.*:error_ratio_5m"}`, legend: '{{__name__}}' }], { desc: 'Bad events over the events that happened (counter SLIs) or bad samples over the expected samples (state and threshold SLIs) in the last 5 minutes, per SLI.', unit: 'percentunit', many: true, rename: Object.fromEntries(pack.spec.slis.map(s => [`${c.svc}:${metricSafe(s.id)}:error_ratio_5m`, s.id])) }),
        stat('Burn-rate alerts firing', `count(ALERTS{alertstate="firing", pack="${c.packName}", burn_rate!=""}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
        stat('Forecast alerts firing', `count(ALERTS{alertstate="firing", pack="${c.packName}", kind="forecast"}) or vector(0)`, { decimals: 0, spark: false, thresholds: okAbove(1, 1), w: 6, h: 7 }),
      ];
      out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, [...tags, 'slo'], { description: `Multi-window burn rates and forecasts for ${sloIds.length} ${c.displayName} SLOs.` }) });
      continue;
    }
    if (/per-resource-template$/.test(tpl)) {
      const v = views[d.params?.view];
      const panels = [header(title, v ? `Per-resource rollup ${v.id}.` : 'Per-resource rollup.', d.id), v ? derivedViewPanel(pack, v, `ref:queries.${v.id}`, { w: 24 }) : text(`Derived view \`${d.params?.view}\` is not declared in spec.queries.derived_views.`, { title, h: 3 })];
      out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, panels, tags, { description: `${c.displayName} per-resource view.` }) });
      continue;
    }
    out.push({ id: d.id, file: `${d.id}.json`, dashboard: dashboard(d.id, `${c.displayName} — ${title}`, [header(title, `Template ${tpl || '(none)'} is not one this generator renders.`, d.id)], tags, { description: `Unrendered template ${tpl}.` }), skipped: tpl });
  }
  return out;
}

/**
 * Every `panel_bindings[].binds_to` of a declared source dashboard must be bound by a panel, a
 * burn-template board must bind its `params.slos`, the unified board must bind every SLI and
 * SLO of the pack, and every board's uid must equal its id.
 */
export function checkBindings(pack, boards) {
  const problems = [];
  const unifiedId = unifiedIdOf(pack);
  const declared = new Map((pack.spec.dashboards || []).map(d => [d.id, d]));
  const ids = new Set([...declared.keys(), unifiedId]);
  for (const id of ids) {
    const d = declared.get(id);
    const b = boards.find(x => x.id === id);
    if (!b) { problems.push(`${id}: not generated`); continue; }
    if (b.dashboard.uid !== id) problems.push(`${id}: uid ${b.dashboard.uid}`);
    const panels = (b.dashboard.panels || []).flatMap(p => [p, ...(p.panels || [])]);
    const bound = new Set(panels.flatMap(p => (Array.isArray(p.pack?.binds_to) ? p.pack.binds_to : [])));
    const wanted = new Set();
    if (d?.source) for (const x of d.panel_bindings || []) wanted.add(x.binds_to);
    if (d && /slo-burn-template$/.test(String(d.template || ''))) for (const s of d.params?.slos || []) wanted.add(`slos.${s}`);
    if (id === unifiedId) { for (const s of pack.spec.slis || []) wanted.add(`slis.${s.id}`); for (const s of pack.spec.slos || []) wanted.add(`slos.${s.id}`); }
    for (const w of wanted) if (!bound.has(w)) problems.push(`${id}: no panel bound to ${w}`);
    for (const p of panels) for (const t of p.targets || []) if (/undefined|NaN/.test(String(t.expr || t.query || ''))) problems.push(`${id}: panel "${p.title}" has a malformed target`);
  }
  return problems;
}
export { DS };
