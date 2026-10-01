// tools/lib/assurance-rules.mjs
//
// THE `${svc}_assurance` GROUP (roadmap step 5 — early-warning delivery).
// Observogram compiles the artefacts that monitor the system; this group
// watches whether those artefacts are being evaluated and delivered at all.
// It is the compiled counterpart of the journey's stack-health evidence:
// the journey samples the stack's self-metrics from outside every N
// minutes, this group makes the ruler itself say so continuously.
//
//   1. Watchdog            vector(1), always firing, severity none — the
//                          dead-man contract: route it to a heartbeat
//                          receiver and page when the heartbeat STOPS
//                          (silence = ruler, Alertmanager or the notification
//                          path is down). Kept as the conventional name so
//                          heartbeat receivers match alertname="Watchdog";
//                          per-pack uniqueness comes from the pack/service
//                          labels.
//   2. <svc>_scrape_target_down   up{job=~"<declared jobs>"} == 0 — only when
//                          the pack declares scrape jobs (an instrument
//                          nobody scrapes would fire forever).
//   3. <svc>_<family>_silent_<product>   absent_over_time(<required metric>[5m])
//                          per ruler / notify family and product from the
//                          stack self-metric alias table — the instrument
//                          stopped exposing itself.
//   4. degraded alerts     <svc>_ruler_stale_<p> / _ruler_errors_<p> /
//                          _notify_errors_<p> — the instrument runs but
//                          evaluates late or fails.
//
// Every metric name comes from `requires[]` of tools/lib/contracts/
// stack-self-metrics.mjs (the names verified live against the real products,
// never from an alias `expr`, which carries rate() the compiler's alert
// contract forbids). otelcol rows are OMITTED on purpose in step 5: the table
// proves their _sent_/_accepted_ siblings register lazily, and
// otelcol_exporter_queue_capacity's startup presence is watched
// (tools/test-stack-live.mjs) but not asserted — a follow-up, not a guess.
//
// Opt-out: metadata.annotations["observogram.assurance"]: on (default) |
// watchdog-only | off (precedent: observogram.diff.scopeMode; `spec` is
// additionalProperties: false, so no spec key). Default ON is the feature.
//
// Browser-safe: imports only the contracts table.

import { STACK_SELF_METRIC_PROBES } from './contracts/stack-self-metrics.mjs';

export const ASSURANCE_ANNOTATION = 'observogram.assurance';
export const ASSURANCE_MODES = Object.freeze(['on', 'watchdog-only', 'off']);
export const ASSURANCE_GROUP_INTERVAL = '30s';
export const ASSURANCE_KIND = 'assurance';
export const WATCHDOG_ALERT = 'Watchdog';
const SILENT_WINDOW = '5m';
const STALE_SECONDS = 120;
// The families this group covers in step 5 (ruler = rules are evaluated,
// notify = alerts are delivered). Other families (collector, tsdb,
// dashboards, synthetic, logs, traces) are sampled by the journey, not
// compiled — see the header.
const ASSURANCE_FAMILIES = Object.freeze(['ruler', 'notify']);
// Which row of a family carries its SILENT (liveness) signal, in order of
// preference: a metric present whenever the component runs (last evaluation
// timestamp, notifications sent) beats an error counter — the first row
// with an alias for the product wins, one silent alert per family/product.
const SILENT_ROW_PREFERENCE = Object.freeze({
  ruler: ['rule_evaluation_staleness', 'rule_evaluation_failures'],
  notify: ['notifications_sent', 'notification_errors'],
});
// Which rows carry the DEGRADED signals and the alert suffix each produces.
const DEGRADED_ROWS = Object.freeze([
  { id: 'rule_evaluation_staleness', suffix: 'ruler_stale', form: 'stale' },
  { id: 'rule_evaluation_failures', suffix: 'ruler_errors', form: 'increase' },
  { id: 'notification_errors', suffix: 'notify_errors', form: 'increase' },
]);
// Products whose rows are gated on a declared scrape job (an instrument
// nobody scrapes would fire forever). blackbox / promtail / jaeger carry no
// ruler/notify row today; the gate is kept so a table extension stays gated.
const JOB_GATED = Object.freeze([
  { product: 'grafana', re: /grafana/i },
  { product: 'blackbox', re: /blackbox/i },
  { product: 'promtail', re: /promtail/i },
  { product: 'jaeger', re: /jaeger/i },
]);

const ROW_BY_ID = new Map(STACK_SELF_METRIC_PROBES.map(r => [r.id, r]));

// on | watchdog-only | off — opts.assurance wins over the annotation;
// anything else warns once and reads as on.
export function assuranceMode(canonical, opts = {}, warn = () => {}) {
  const raw = opts?.assurance ?? canonical?.metadata?.annotations?.[ASSURANCE_ANNOTATION] ?? 'on';
  const v = String(raw).trim().toLowerCase();
  if (ASSURANCE_MODES.includes(v)) return v;
  warn(`${ASSURANCE_ANNOTATION}: unknown mode ${JSON.stringify(raw)} (${ASSURANCE_MODES.join(' | ')}); assuming on`);
  return 'on';
}

// The pack's declared scrape job names, declaration order, de-duplicated —
// the same source packStepSeconds / sliStepSeconds read (burn-rules.mjs).
export function declaredScrapeJobs(canonical) {
  const names = (canonical?.spec?.pipelines?.receivers || [])
    .flatMap(r => (Array.isArray(r?.scrape_configs) ? r.scrape_configs : []))
    .map(c => (c && c.job_name != null ? String(c.job_name) : ''))
    .filter(Boolean);
  return [...new Set(names)];
}

// The ordered product list whose table rows this pack's group carries:
// generic always; the metrics profile's product when it is prometheus or
// victoriametrics (mimir / thanos expose no prometheus_* rows → generic
// only); alertmanager when a telemetry backend names it; grafana / blackbox
// / promtail / jaeger ONLY when a declared scrape job names them (warned
// when declared as a backend without a job).
export function assuranceProducts(canonical, profile, jobs = [], warn = () => {}) {
  const products = ['generic'];
  const p = String(profile?.product || '').toLowerCase();
  if (p === 'prometheus' || p === 'victoriametrics') products.push(p);
  const backends = (canonical?.spec?.telemetry?.backends || []).filter(b => b && typeof b === 'object');
  if (backends.some(b => /alertmanager/i.test(String(b.product || '')))) products.push('alertmanager');
  for (const { product, re } of JOB_GATED) {
    if (jobs.some(j => re.test(j))) products.push(product);
    else if (backends.some(b => re.test(String(b.product || '')))) {
      warn(`assurance: ${product} is declared as a backend but no scrape job names it — its instrument-liveness alerts are not emitted (an instrument nobody scrapes would fire forever)`);
    }
  }
  return products;
}

// Escape for TWO contexts at once: RE2 (each job name is a regex alternative)
// AND the PromQL double-quoted string it sits in, where only Go escapes are
// legal — a lone `\.` is "unknown escape sequence" and rejects the WHOLE rules
// file at load (every burn/forecast rule of the pack with it). Two backslashes
// on the wire: PromQL unescapes them to one, RE2 then sees `\.` (fix round 0).
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\\\$&');

const aliasFor = (rowId, product) => {
  const row = ROW_BY_ID.get(rowId);
  const alias = row ? (row.aliases || []).find(a => a && a.product === product && Array.isArray(a.requires) && a.requires.length) : null;
  return alias ? { row, alias } : null;
};

function commonLabels(ctx, severity, instrument) {
  return { severity, kind: ASSURANCE_KIND, instrument, service: ctx.service, pack: ctx.service };
}

function annotations(ctx, summary, description) {
  return { summary, description, runbook: ctx.runbooks?.assurance ?? '(supply runbook URL)' };
}

// The rule objects, byte-stable order. `ctx` is the compiler's policy
// context ({ svc, service, lab, runbooks }); `profile` the metrics profile;
// `mode` from assuranceMode (off → []).
export function buildAssuranceRules(canonical, ctx, { profile, mode = 'on' } = {}) {
  if (mode === 'off') return [];
  const svc = ctx.svc;
  const pack = ctx.service;
  const F = ctx.lab ? '30s' : '2m';
  const S = ctx.lab ? '2m' : '10m';
  const rules = [];

  rules.push({
    alert: WATCHDOG_ALERT,
    expr: 'vector(1)',
    labels: commonLabels(ctx, 'none', 'watchdog'),
    annotations: annotations(ctx,
      `${pack} assurance watchdog — always firing`,
      `Dead-man contract for pack ${pack}: this alert fires continuously by construction. Route alertname="Watchdog", pack="${pack}" to a heartbeat receiver and page when the heartbeat STOPS — silence means the ruler, Alertmanager or the notification path is down. Until a heartbeat route is added at deploy time it falls to the compiled Alertmanager's null receiver.`),
  });
  if (mode === 'watchdog-only') return rules;

  const jobs = declaredScrapeJobs(canonical);
  if (jobs.length) {
    rules.push({
      alert: `${svc}_scrape_target_down`,
      expr: `up{job=~"${jobs.map(escapeRe).join('|')}"} == 0`,
      for: F,
      labels: commonLabels(ctx, 'SEV2', 'scrape'),
      annotations: annotations(ctx,
        `A declared scrape target of ${pack} is down`,
        `up == 0 for {{ $labels.job }}/{{ $labels.instance }} for ${F}. The pack declares scrape job(s) ${jobs.join(', ')}: every SLI, recording rule and burn alert of ${pack} reading them is blind while this fires.`),
    });
  }

  const products = assuranceProducts(canonical, profile, jobs, ctx.warn || (() => {}));

  // 3. silent — one per family/product, from the preferred liveness row.
  for (const family of ASSURANCE_FAMILIES) {
    for (const product of products) {
      const pick = (SILENT_ROW_PREFERENCE[family] || []).map(id => aliasFor(id, product)).find(Boolean);
      if (!pick) continue;
      const req = pick.alias.requires;
      rules.push({
        alert: `${svc}_${family}_silent_${product}`,
        expr: req.map(m => `absent_over_time(${m}[${SILENT_WINDOW}])`).join(' or '),
        for: S,
        labels: commonLabels(ctx, 'SEV2', `${family}/${product}`),
        annotations: annotations(ctx,
          `${product} ${family} instrument silent for ${pack}`,
          `${req.join(' / ')} has not been scraped for ${SILENT_WINDOW} (${S} sustained): the ${product} ${family} that ${family === 'ruler' ? 'evaluates' : 'delivers'} ${pack}'s rules is not exposing itself — stopped, unscraped or renamed. Its rules are unproven while this fires. (Stack self-metric row ${pick.row.id}.)`),
      });
    }
  }

  // 4. degraded — the instrument runs but evaluates late or fails.
  for (const d of DEGRADED_ROWS) {
    for (const product of products) {
      const pick = aliasFor(d.id, product);
      if (!pick) continue;
      const req = pick.alias.requires;
      let expr, summary, description;
      if (d.form === 'stale') {
        expr = `max(time() - ${req[0]}) > ${STALE_SECONDS}`;
        summary = `${product} rule evaluation stale for ${pack}`;
        description = `The newest rule-group evaluation is older than ${STALE_SECONDS}s for ${F}: ${pack}'s recording rules and burn alerts are being evaluated late. Caveat: a fully stopped ruler cannot evaluate this alert — the Watchdog covers that case.`;
      } else {
        expr = req.length === 1
          ? `increase(${req[0]}[5m]) > 0`
          : `${req.map(m => `sum(increase(${m}[5m]))`).join(' + ')} > 0`;
        summary = d.suffix === 'ruler_errors' ? `${product} rule evaluation errors for ${pack}` : `${product} notification errors for ${pack}`;
        description = d.suffix === 'ruler_errors'
          ? `${req.join(' + ')} increased in the last 5m for ${F}: some of ${pack}'s rules fail to evaluate — a failing rule records nothing and its burn alert can never fire.`
          : `${req.join(' + ')} increased in the last 5m for ${F}: ${product} failed to deliver notifications — ${pack}'s alerts may fire unseen.`;
      }
      rules.push({
        alert: `${svc}_${d.suffix}_${product}`,
        expr,
        for: F,
        labels: commonLabels(ctx, 'SEV3', `${pick.row.family}/${product}`),
        annotations: annotations(ctx, summary, description + ` (Stack self-metric row ${d.id}.)`),
      });
    }
  }
  return rules;
}

// Every metric name a rule set reads — for the suite that pins them to the
// table's requires[].
export function metricNamesOf(expr) {
  return [...new Set([...String(expr || '').matchAll(/(?<![\w:])([a-zA-Z_:][a-zA-Z0-9_:]*)(?=\s*(?:\{|\[))/g)].map(m => m[1]).filter(n => !/^(sum|max|min|increase|absent_over_time|time|vector|rate|count|avg)$/.test(n)))];
}
