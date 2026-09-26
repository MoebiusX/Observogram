// studio/trace-chain.mjs
//
// The studio's reading of a requirement's proof chain — pack.traceability,
// built by tools/lib/traceability.mjs and attached by the adapter. The
// engine answers "what did we find for this SLO?"; this module answers the
// questions the 2026-09 UX review asked of the Traceability screen
// (docs/UX_SCREEN_GRAMMAR.md):
//
//   - which requirements are broken, and where the chain first breaks;
//   - how strong each link is — proven, inferred, unverified, missing or
//     not required — so "a scrape job was observed" never reads as proof
//     that THIS metric was scraped;
//   - what exists somewhere versus what is linked and proven for this
//     requirement;
//   - the plain words for the engine's machine codes, and which
//     requirements share a gap so it can be fixed once.
//
// Pure and zero-import (safe under node for the headless tests); the view
// in compare-view.mjs and the drawer's trace panel both read it. It never
// changes the engine's verdict: a link is "missing" exactly when the engine
// records the gap.

// ---------- plain language for the engine's codes ----------
//
// kind 'gap' is a hole the engine records (chain.gaps); kind 'note' is a
// caveat on a link that exists (chain.notes). `link` names the chain link
// the code is about; `fix` is the remedy shared by every requirement with it.
export const TRACE_ISSUES = {
  missing_sli: {
    kind: 'gap', link: 'sli', label: 'SLI missing',
    why: 'The SLO references an SLI the pack does not declare.',
    fix: 'Declare the SLIs these SLOs reference.',
  },
  missing_metric_mapping: {
    kind: 'gap', link: 'metric', label: 'No metric mapped',
    why: 'Nothing ties the SLI to a metric: its queries name none the studio recognises.',
    fix: 'Give each SLI a query (or good/total pair) that names its metric.',
  },
  missing_metrics_exporter: {
    kind: 'gap', link: 'exporter', label: 'Metrics exporter missing',
    why: 'The pipeline declares no metrics exporter, so nothing carries the metric to a backend.',
    fix: 'Declare one metrics exporter in the pipeline; it serves every requirement.',
  },
  missing_scrape_evidence: {
    kind: 'gap', link: 'scrape', label: 'Scrape evidence missing',
    why: 'No scrape job was declared or observed at all, so nothing shows the metric is collected.',
    fix: 'Refresh the live draft (or declare the scrape configuration), then check again.',
  },
  missing_dashboard_evidence: {
    kind: 'gap', link: 'dashboard', label: 'Dashboard evidence missing',
    why: 'No dashboard panel shows this requirement.',
    fix: 'Add a panel bound to each SLO or SLI — one SLO dashboard can cover them all.',
  },
  missing_alert_evidence: {
    kind: 'gap', link: 'alert', label: 'Alert evidence missing',
    why: 'No healthy alert would fire when this requirement burns its error budget.',
    fix: 'Add a multi-window burn-rate alert per SLO, or repair the live rule each one maps to.',
  },
  scrape_jobs_observed_but_not_metric_specific: {
    kind: 'note', link: 'scrape', label: 'Scrape jobs found, none tied to this metric',
    why: 'Scrape jobs exist, but none is linked to this requirement’s metrics. A job being observed is not proof that this metric is scraped.',
    fix: 'Tie a scrape job to these metrics (a job or target that emits them), so collection is proven per metric.',
  },
  some_metrics_not_in_live_inventory_sample: {
    kind: 'note', link: 'metric', label: 'Some metrics not seen live',
    why: 'A metric this requirement names is absent from the live metric inventory sample.',
    fix: 'Check these metric names against the live inventory: a rename or a missing exporter shows up here.',
  },
};

function humanise(code) {
  const s = String(code ?? '').replace(/_/g, ' ').trim();
  return s ? s[0].toUpperCase() + s.slice(1) : '';
}

/** The plain-language record for an engine code; unknown codes are humanised, never dropped. */
export function traceIssue(code) {
  const hit = TRACE_ISSUES[code];
  return hit ? { code, ...hit } : { code, kind: 'gap', link: null, label: humanise(code), why: '', fix: '' };
}
export function traceIssueLabel(code) { return traceIssue(code).label; }

// ---------- link strength ----------
//
// One scale for every link of the chain. "Proven" needs both an explicit
// reference for THIS requirement and live evidence behind it; a
// declaration alone is "unverified", a name match is "inferred".
export const LINK_STATES = {
  proven:      { label: 'Proven',       tone: 'ok',    rank: 0, tip: 'An explicit reference ties it to this requirement, and live evidence confirms it.' },
  inferred:    { label: 'Inferred',     tone: 'info',  rank: 1, tip: 'Matched by name or query text, not by an explicit reference to this requirement.' },
  unverified:  { label: 'Unverified',   tone: 'warn',  rank: 2, tip: 'Present, but nothing confirms it for this requirement: declared only, job-level only, or reported unhealthy.' },
  missing:     { label: 'Missing',      tone: 'fail',  rank: 3, tip: 'Nothing found: the chain has a gap here.' },
  notRequired: { label: 'Not required', tone: 'muted', rank: -1, tip: 'Not part of this requirement’s proof.' },
};

// The chain, in order. `layer` is where the link's artefacts live in
// Discover, so a broken link can jump there.
export const CHAIN_LINKS = [
  { key: 'sli',       label: 'SLI',            layer: 'L1' },
  { key: 'metric',    label: 'Metric',         layer: 'L2' },
  { key: 'rule',      label: 'Recording rule', layer: 'L3' },
  { key: 'exporter',  label: 'Exporter',       layer: 'L2' },
  { key: 'scrape',    label: 'Scrape',         layer: 'L2' },
  { key: 'dashboard', label: 'Dashboard',      layer: 'L3' },
  { key: 'alert',     label: 'Alert',          layer: 'L4' },
];

// A requirement's overall state, worst first.
export const CHAIN_STATES = {
  broken:     { label: 'Broken chain',        tone: 'fail', rank: 3 },
  unverified: { label: 'Not confirmed live',  tone: 'warn', rank: 2 },
  inferred:   { label: 'Linked by inference', tone: 'info', rank: 1 },
  proven:     { label: 'Proven',              tone: 'ok',   rank: 0 },
};

// ---------- what the pack holds (the "exists somewhere" side) ----------

function annotationList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.map(v => String(v).trim()).filter(Boolean);
  const raw = String(value).trim();
  if (!raw) return [];
  if (raw.startsWith('[')) {
    try {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.map(v => String(v).trim()).filter(Boolean);
    } catch { /* fall through to delimiter parsing */ }
  }
  return raw.split(/[,\r\n]+/).map(s => s.trim()).filter(Boolean);
}

function layerItems(pack, L) {
  const v = pack?.layers?.[L];
  if (Array.isArray(v)) return v;
  if (v && typeof v === 'object') {
    return Object.entries(v).flatMap(([sub, items]) => (Array.isArray(items) ? items.map(it => ({ ...it, _sub: sub })) : []));
  }
  return [];
}

/**
 * traceIndex(pack) → the pack-wide facts the chain reading needs: whether it
 * is a live draft, which metrics and scrape jobs are live or declared, and
 * the artefact behind each chain item (so a link can open it).
 */
export function traceIndex(pack) {
  const ann = pack?.meta?.annotations || pack?.metadata?.annotations || {};
  const L2 = layerItems(pack, 'L2');
  const L3 = layerItems(pack, 'L3');
  const L4 = layerItems(pack, 'L4');
  const at = (layer, art) => (art ? { layer, id: art.id, sub: art._sub || null } : null);
  const liveMetrics = new Set(L2.filter(a => /^METRIC-\d/.test(a.id || '')).map(a => a.spec?.name || a.title).filter(Boolean));
  const declaredMetrics = new Set(L2.filter(a => /^METRIC-SRC-/.test(a.id || '')).map(a => a.spec?.name || a.title).filter(Boolean));
  const liveJobs = new Set(L2.filter(a => /^SCRAPE-\d/.test(a.id || '')).map(a => a.spec?.job).filter(Boolean));
  const declaredJobs = new Set(L2.filter(a => /^SCRAPE-SRC-/.test(a.id || '')).map(a => a.spec?.job).filter(Boolean));
  const metricArt = new Map();
  for (const a of L2) {
    if (!/^METRIC-/.test(a.id || '')) continue;
    const name = a.spec?.name || a.title;
    if (name && (!metricArt.has(name) || /^METRIC-\d/.test(a.id))) metricArt.set(name, at('L2', a));
  }
  const jobArt = new Map();
  for (const a of L2) {
    if (!/^SCRAPE-/.test(a.id || '') || !a.spec?.job) continue;
    if (!jobArt.has(a.spec.job) || /^SCRAPE-\d/.test(a.id)) jobArt.set(a.spec.job, at('L2', a));
  }
  const dashboards = new Map();
  for (const a of L3) if (/^DASH-/.test(a.id || '') && a.spec?.id) dashboards.set(a.spec.id, a);
  const rules = new Map();
  for (const a of L3) if (/^QRY-/.test(a.id || '') && a.title) rules.set(a.title, a);
  const burnRate = L4.filter(a => /^POL-/.test(a.id || ''));
  const byId = new Map();
  for (const L of ['L1', 'L2', 'L3', 'L4', 'L5']) for (const a of layerItems(pack, L)) if (a?.id && !byId.has(a.id)) byId.set(a.id, { layer: L, art: a });
  return {
    live: !!ann['mcp.url'],
    liveMetrics, declaredMetrics, liveJobs, declaredJobs,
    liveAlertRules: annotationList(ann['mcp.discovered.alert_rule_names']).length,
    burnRateAlerts: burnRate.filter(a => a.source !== 'Scaffold').length,
    dashboardCount: dashboards.size,
    metricTarget: (name) => metricArt.get(name) || null,
    jobTarget: (job) => jobArt.get(job) || null,
    ruleTarget: (name) => at('L3', rules.get(name)),
    dashboardTarget: (id) => at('L3', dashboards.get(id)),
    dashboardArt: (id) => dashboards.get(id) || null,
    target: (id) => { const hit = id ? byId.get(id) : null; return hit ? at(hit.layer, hit.art) : null; },
    artefact: (id) => (id ? byId.get(id)?.art || null : null),
  };
}

// Live evidence stands behind an artefact only when it carries its own
// verification stamp (source 'Verified'). Being in a live draft is not
// enough: the fetcher leaves Declared what it could not confirm (a burn-rate
// alert fed by an unhealthy rule) and marks schema-forced placeholders
// Scaffold, and neither is live evidence.
function confirmedLive(_index, art) {
  return art?.source === 'Verified';
}

function few(names, n = 3) {
  const xs = names.filter(Boolean);
  if (!xs.length) return '';
  return xs.length <= n ? xs.join(', ') : `${xs.slice(0, n).join(', ')} and ${xs.length - n} more`;
}

// ---------- one requirement ----------

function link(key, state, detail, items = [], extra = {}) {
  const def = CHAIN_LINKS.find(l => l.key === key);
  return { key, label: def.label, layer: def.layer, state, detail, items, ...extra };
}

function sliLink(chain, index) {
  if (!chain.sli) return link('sli', 'missing', 'The SLO references an SLI the pack does not declare.');
  const sliArt = index.artefact(chain.sli.artefactId);
  const sloArt = chain.slo ? index.artefact(chain.slo.artefactId) : null;
  const items = [{ text: chain.sli.id, target: index.target(chain.sli.artefactId) }];
  // A template placeholder (Scaffold) is nobody's measurement: never proven.
  const scaffold = [sliArt, sloArt].filter(a => a?.source === 'Scaffold');
  if (scaffold.length) {
    const what = scaffold.length === 2 ? 'The SLI and its SLO are template placeholders' : `${scaffold[0] === sliArt ? `SLI ${chain.sli.id}` : 'The SLO'} is a template placeholder`;
    return link('sli', 'unverified', `${what}: nothing measured or confirmed ${scaffold.length === 2 ? 'them' : 'it'}. Replace ${scaffold.length === 2 ? 'them' : 'it'} with the real definition.`, items, { scaffold: true });
  }
  if (!confirmedLive(index, sliArt)) {
    const detail = chain.slo
      ? `The SLO names SLI ${chain.sli.id}; it is declared only, and nothing live confirms it is measured.`
      : `A standalone SLI, declared only: no SLO sets a target for it, and nothing live confirms it is measured.`;
    return link('sli', 'unverified', detail, items, { declaredOnly: true, inLiveDraft: index.live });
  }
  const detail = chain.slo
    ? `The SLO names SLI ${chain.sli.id}, and a verification stamp confirms it is measured.`
    : `A standalone SLI, confirmed live: no SLO sets a target for it.`;
  return link('sli', 'proven', detail, items);
}

function metricLink(chain, index) {
  const metrics = chain.metrics || [];
  if (!metrics.length) return link('metric', 'missing', 'No metric is mapped: the SLI’s queries name none the studio recognises.');
  const items = metrics.slice(0, 8).map(m => ({ text: m.name, evidence: m.verified ? 'live' : 'declared', target: index.metricTarget(m.name) }));
  const explicit = metrics.filter(m => (m.sources || []).includes('sli'));
  if (!explicit.length) {
    return link('metric', 'inferred', `Found by name (${few(metrics.map(m => m.name))}); the SLI’s own queries name no metric.`, items);
  }
  const confirmed = explicit.filter(m => m.verified);
  const inventoryChecked = index.liveMetrics.size > 0 || (chain.notes || []).includes('some_metrics_not_in_live_inventory_sample');
  if (confirmed.length === explicit.length) {
    return link('metric', 'proven', `The SLI’s query names ${few(explicit.map(m => m.name))}, and the live metric inventory reports ${explicit.length === 1 ? 'it' : 'them'}.`, items);
  }
  if (inventoryChecked) {
    const absent = explicit.filter(m => !m.verified).map(m => m.name);
    return link('metric', 'unverified', `The SLI’s query names ${few(explicit.map(m => m.name))}, but ${few(absent)} ${absent.length === 1 ? 'is' : 'are'} not in the live metric inventory sample.`, items);
  }
  const inRepo = explicit.every(m => m.declared || index.declaredMetrics.has(m.name));
  return link('metric', 'unverified', `The SLI’s query names ${few(explicit.map(m => m.name))}${inRepo ? `, and the repository defines ${explicit.length === 1 ? 'it' : 'them'}` : ''}. No live metric inventory was fetched, so nothing confirms ${explicit.length === 1 ? 'it is' : 'they are'} emitted.`, items, { noInventory: true });
}

function ruleLink(chain, index) {
  const rules = chain.recordingRules || [];
  if (!rules.length) return link('rule', 'notRequired', 'No recording rule mentions it. Optional in this chain; the rubric checks one rule per SLO separately.');
  return link('rule', 'inferred', `${rules.length} recording rule${rules.length === 1 ? ' matches' : 's match'} by name or shared metric.`,
    rules.slice(0, 6).map(r => ({ text: r.name, target: index.ruleTarget(r.name) })));
}

function exporterLink(chain, index) {
  const ex = chain.exporters || [];
  if (!ex.length) return link('exporter', 'missing', 'The pipeline declares no metrics exporter.');
  return link('exporter', 'inferred', 'The pack’s metrics exporter carries every metric; it is not specific to this one.',
    ex.map(e => ({ text: e.title || e.id, evidence: confirmedLive(index, e) ? 'live' : 'declared', target: index.target(e.id) })));
}

// `metricProven`: the live inventory reports every metric the SLI names —
// the metric is being collected, whichever job does it.
function scrapeLink(chain, index, metricProven = false) {
  const s = chain.scrapeJobs || { observedCount: 0, items: [] };
  const where = () => {
    const parts = [];
    if (index.liveJobs.size) parts.push(`${index.liveJobs.size} observed live`);
    if (index.declaredJobs.size) parts.push(`${index.declaredJobs.size} declared in scrape configuration`);
    return parts.length ? ` (${parts.join(', ')})` : '';
  };
  if (!s.observedCount) return link('scrape', 'missing', 'No scrape job was declared or observed, so nothing shows the metric is collected.');
  if (metricProven) {
    return link('scrape', 'proven',
      `The live metric inventory reports this requirement’s metric, so it is being collected${s.items?.length ? `; the job name ${s.items.length === 1 ? 'that matches is' : 's that match are'} ${few(s.items.map(j => j.name))}` : '; which job scrapes it was not checked'}.`,
      (s.items || []).slice(0, 6).map(j => ({ text: j.name, evidence: index.liveJobs.has(j.name) ? 'live' : 'declared', target: index.jobTarget(j.name) })));
  }
  if (s.items?.length) {
    const names = s.items.map(j => j.name);
    const live = names.filter(n => index.liveJobs.has(n));
    return link('scrape', 'inferred',
      `Job name matches this requirement’s metrics (${few(names)})${live.length ? `; ${live.length === names.length ? 'all' : live.length} observed live` : '; declared, not observed live'}. The jobs’ targets were not checked for these metrics.`,
      s.items.slice(0, 6).map(j => ({ text: j.name, evidence: index.liveJobs.has(j.name) ? 'live' : 'declared', target: index.jobTarget(j.name) })));
  }
  return link('scrape', 'unverified',
    `${s.observedCount} scrape job${s.observedCount === 1 ? '' : 's'} exist${s.observedCount === 1 ? 's' : ''}${where()}, but none is tied to this requirement’s metrics. A job being observed is not proof that this metric is scraped.`,
    [], { jobLevelOnly: true });
}

function dashboardLink(chain, index) {
  const ds = chain.dashboards || [];
  if (!ds.length) return link('dashboard', 'missing', 'No dashboard panel shows this requirement.');
  const symbols = new Set([chain.slo?.symbol, chain.sli?.symbol].filter(Boolean).flatMap(s => [s, `ref:${s}`]));
  const isBound = (d) => (d.panels || []).some(p => p.bindsTo && symbols.has(p.bindsTo));
  const bound = ds.filter(isBound);
  const items = ds.slice(0, 6).map(d => {
    const n = d.panels?.length || 0;
    return {
      text: `${d.title || d.id}${n ? ` (${n} panel${n === 1 ? '' : 's'}${isBound(d) ? ', bound' : ''})` : ''}`,
      evidence: confirmedLive(index, index.dashboardArt(d.id)) ? 'live' : 'declared',
      target: index.dashboardTarget(d.id),
    };
  });
  if (!bound.length) return link('dashboard', 'inferred', 'Panels mention its metrics or rules, but none is bound to this SLO or SLI.', items);
  if (bound.some(d => confirmedLive(index, index.dashboardArt(d.id)))) {
    return link('dashboard', 'proven', `A panel on ${few(bound.map(d => d.title || d.id), 2)} is bound to this requirement, and the dashboard is confirmed live.`, items);
  }
  return link('dashboard', 'unverified', `A panel on ${few(bound.map(d => d.title || d.id), 2)} is bound to this requirement in the pack; no live dashboard confirms it.`, items);
}

function alertLink(chain, index) {
  const alerts = chain.alerts || [];
  const gap = (chain.gaps || []).includes('missing_alert_evidence');
  const items = alerts.slice(0, 6).map(a => ({
    text: `${a.name}${a.verified === false ? ' (unhealthy)' : ''}`,
    evidence: a.type === 'live_alert_rule' ? 'live' : (confirmedLive(index, index.artefact(a.artefactId)) ? 'live' : 'declared'),
    target: index.target(a.artefactId),
  }));
  if (gap) {
    const unhealthy = alerts.filter(a => a.verified === false);
    if (unhealthy.length) {
      return link('alert', 'unverified', `A matching live rule exists (${few(unhealthy.map(a => a.name), 2)}), but the ruler reports it unhealthy, so it is not alert evidence.`, items, { broken: true });
    }
    return link('alert', 'missing', chain.slo ? 'No burn-rate alert is declared for this SLO, and no live alert rule matches it.' : 'No alert rule matches this SLI.', items);
  }
  const declared = alerts.filter(a => a.type === 'burn_rate');
  const liveHealthy = alerts.filter(a => a.type === 'live_alert_rule' && a.verified !== false);
  const liveUnhealthy = alerts.filter(a => a.type === 'live_alert_rule' && a.verified === false);
  // One unhealthy window is enough: a multi-window alert with a rule that
  // cannot evaluate is not alert evidence, however healthy the others are.
  if (liveUnhealthy.length) {
    const bad = few(liveUnhealthy.map(a => a.name), 2);
    const one = liveUnhealthy.length === 1;
    return link('alert', 'unverified', declared.length
      ? `A burn-rate alert is declared for this SLO, but ${one ? 'a matching live rule' : 'matching live rules'} (${bad}) ${one ? 'is' : 'are'} reported unhealthy.`
      : `A live alert rule’s name matches, but ${bad} ${one ? 'is' : 'are'} reported unhealthy; nothing is declared for this SLO.`, items, { unhealthy: true });
  }
  if (declared.length) {
    // In a live draft the fetcher's stamp is the verdict: it withholds it
    // from an alert it could not confirm, so a healthy name match alone does
    // not override it.
    const confirmed = declared.some(a => confirmedLive(index, index.artefact(a.artefactId))) || (!index.live && liveHealthy.length > 0);
    return confirmed
      ? link('alert', 'proven', `A burn-rate alert is declared for this SLO${liveHealthy.length ? ', and a matching live rule is healthy' : ' and confirmed live'}.`, items)
      : link('alert', 'unverified', index.live
        ? 'A burn-rate alert is declared for this SLO, but the live draft did not confirm it: a rule it maps to may be unhealthy or missing.'
        : 'A burn-rate alert is declared for this SLO in the pack; no live rule confirms it fires.', items);
  }
  return link('alert', 'inferred', `A live alert rule’s name matches (${few(liveHealthy.map(a => a.name), 2)}); it is not declared for this SLO.`, items);
}

// The next step for a link that is broken or weak.
function nextActionFor(l, chain) {
  const req = chain.slo?.id || chain.sli?.id || chain.id;
  const metrics = chain.metrics || [];
  const firstMetric = (metrics.find(m => (m.sources || []).includes('sli')) || metrics[0])?.name;
  const target = (l.items || []).find(i => i.target)?.target || null;
  const at = (label, useTarget = false) => ({ label, layer: l.layer, target: useTarget ? target : null, link: l.key });
  switch (`${l.key}:${l.state}`) {
    case 'sli:missing':          return at('Declare the SLI this SLO references');
    case 'sli:unverified':       return l.scaffold ? at('Replace the placeholder SLI with the real one', true) : at(l.inLiveDraft ? 'Check the rules behind the SLI are healthy, then refresh live evidence' : 'Capture a live draft to confirm the SLI is measured', true);
    case 'metric:missing':       return { label: 'Map the SLI to a metric', layer: 'L1', target: null, link: 'metric', openSli: true };
    case 'metric:unverified':    return at(l.noInventory ? `Capture a live draft to confirm ${firstMetric || 'the metric'}` : `Confirm ${firstMetric || 'the metric'} is emitted live`, true);
    case 'metric:inferred':      return { label: 'Name the metric in the SLI’s query', layer: 'L1', target: null, link: 'metric', openSli: true };
    case 'exporter:missing':     return at('Add a metrics exporter to the pipeline');
    case 'scrape:missing':       return at('Capture scrape evidence: refresh the live draft');
    case 'scrape:unverified':    return at(`Tie a scrape job to ${firstMetric || 'this metric'}`);
    case 'scrape:inferred':      return at(`Check the matching job scrapes ${firstMetric || 'this metric'}`, true);
    case 'dashboard:missing':    return at(`Add a dashboard panel bound to ${req}`);
    case 'dashboard:inferred':   return at(`Bind a panel to ${req}`, true);
    case 'dashboard:unverified': return at('Deploy the dashboard, then refresh live evidence', true);
    case 'alert:missing':        return at(`Add a burn-rate alert for ${req}`);
    case 'alert:inferred':       return at(`Declare a burn-rate alert for ${req}`);
    case 'alert:unverified':     return (l.broken || l.unhealthy) ? at('Repair the unhealthy alert rule') : at('Deploy the burn-rate alert, then refresh live evidence', true);
    default:                     return null;
  }
}

/**
 * readChain(chain, index) → one requirement as the list draws it: its links
 * in chain order (each with a state, a sentence and the items behind it),
 * its overall state, the first broken link (a gap the engine records) or
 * else the weakest one, the next action, and its issues in plain words.
 */
export function readChain(chain, index) {
  const metric = metricLink(chain, index);
  const links = [
    sliLink(chain, index), metric, ruleLink(chain, index), exporterLink(chain, index),
    scrapeLink(chain, index, metric.state === 'proven'), dashboardLink(chain, index), alertLink(chain, index),
  ];
  const gaps = chain.gaps || [];
  for (const l of links) {
    const code = gaps.find(g => TRACE_ISSUES[g]?.link === l.key);
    if (code) { l.gap = code; l.broken = true; }
    else if (l.state === 'missing') l.broken = true;
    // Recording rules and the exporter support the chain without being
    // specific to one requirement (a rule is optional; the exporter carries
    // every metric): a gap there still breaks the chain, but their
    // inferred-by-nature link never holds a requirement back from proven.
    if (l.key === 'rule' || l.key === 'exporter') l.supporting = true;
  }
  const bearing = links.filter(l => !l.supporting);
  const firstBroken = links.find(l => l.broken) || null;
  const weakest = firstBroken ? null : bearing.find(l => l.state === 'unverified') || bearing.find(l => l.state === 'inferred') || null;
  const state = firstBroken ? 'broken'
    : bearing.some(l => l.state === 'unverified') ? 'unverified'
      : bearing.some(l => l.state === 'inferred') ? 'inferred' : 'proven';
  const focus = firstBroken || weakest;
  const sloLabel = chain.slo
    ? [chain.slo.objective != null && typeof chain.slo.objective === 'number' ? `${(chain.slo.objective * 100).toFixed(2).replace(/\.?0+$/, '')}%` : chain.slo.objective, chain.slo.window].filter(v => v != null && v !== '').join(' over ')
    : '';
  return {
    id: chain.id,
    title: chain.slo?.id || chain.sli?.id || chain.id,
    kind: chain.kind,
    objective: sloLabel,
    sliId: chain.sli?.id || null,
    sloTarget: index.target(chain.slo?.artefactId),
    sliTarget: index.target(chain.sli?.artefactId),
    links,
    state,
    ...CHAIN_STATES[state],
    stateKey: state,
    gapCount: gaps.length,
    firstBroken,
    weakest,
    next: focus ? nextActionFor(focus, chain) : null,
    issues: [...gaps, ...(chain.notes || [])].map(traceIssue),
  };
}

/**
 * readTraceability(pack) → the whole screen's model: the requirements sorted
 * worst first, counts by state, per-link "linked" versus "proven" counts,
 * what exists in the pack regardless of any requirement, and the issue
 * groups (every requirement that shares a gap, so it can be fixed once).
 * null when the pack carries no requirement chains.
 */
export function readTraceability(pack) {
  const chains = Array.isArray(pack?.traceability?.chains) ? pack.traceability.chains : [];
  if (!chains.length) return null;
  const index = traceIndex(pack);
  const rows = chains.map(c => readChain(c, index))
    .sort((a, b) => b.rank - a.rank || b.gapCount - a.gapCount || String(a.title).localeCompare(String(b.title)));
  const total = rows.length;
  const counts = { broken: 0, unverified: 0, inferred: 0, proven: 0 };
  for (const r of rows) counts[r.stateKey]++;
  // "Linked" means tied to THIS requirement: a job-level scrape match or a
  // link the engine still counts as a gap (an unhealthy alert) is not.
  const byLink = {};
  for (const def of CHAIN_LINKS) {
    const ls = rows.map(r => r.links.find(l => l.key === def.key)).filter(Boolean);
    byLink[def.key] = {
      linked: ls.filter(l => l.state !== 'missing' && l.state !== 'notRequired' && !l.jobLevelOnly && !l.broken).length,
      proven: ls.filter(l => l.state === 'proven').length,
      missing: ls.filter(l => l.broken).length,
    };
  }
  const groups = new Map();
  for (const r of rows) {
    for (const issue of r.issues) {
      if (!groups.has(issue.code)) groups.set(issue.code, { ...issue, layer: CHAIN_LINKS.find(l => l.key === issue.link)?.layer || null, ids: [] });
      groups.get(issue.code).ids.push(r.id);
    }
  }
  const scrapeObserved = Math.max(0, ...chains.map(c => c.scrapeJobs?.observedCount || 0));
  return {
    total,
    rows,
    counts,
    byLink,
    exists: {
      metrics: { live: index.liveMetrics.size, declared: index.declaredMetrics.size },
      scrape: { observed: scrapeObserved, live: index.liveJobs.size, declared: index.declaredJobs.size },
      dashboards: index.dashboardCount,
      alerts: { burnRate: index.burnRateAlerts, liveRules: index.liveAlertRules },
    },
    live: index.live,
    issueGroups: [...groups.values()].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'gap' ? -1 : 1) || b.ids.length - a.ids.length || a.label.localeCompare(b.label)),
  };
}
