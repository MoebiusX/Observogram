// studio/drawer.mjs
//
// The artefact detail drawer — the slide-in panel that renders an artefact's
// full spec, cross-references, and per-type panels (SLI/SLO/backend/dashboard/
// chaos/…). Opened from the cards (openDrawer) and closed from the chrome
// (closeDrawer). Re-render entrypoints come through the studio host seam
// (host.mjs); cardKey is imported from layers-view.mjs.

import { state, $, $$ } from './state.mjs';
import { L4_SUBGROUPS } from './constants.mjs';
import { escapeHtml, toast } from './util.mjs';
import { host as appHost } from './host.mjs';
import { cardKey } from './layers-view.mjs';

// ---------- drawer ----------

// Map: side → element ids. drawerB (right) is the legacy drawer used
// everywhere outside the compare view. drawerA (left) is only used in
// the compare view to surface Pack A's artefact alongside Pack B's.
const DRAWER_ELS = {
  a: { drawer: '#drawer-a', eyebrow: '#drawer-a-eyebrow', title: '#drawer-a-title',
       meta: '#drawer-a-meta', panels: '#drawer-a-panels', close: '#drawer-a-close' },
  b: { drawer: '#drawer',   eyebrow: '#drawer-eyebrow',   title: '#drawer-title',
       meta: '#drawer-meta', panels: '#drawer-panels',   close: '#drawer-close' },
};

export function openDrawer(artefact, def, sublayerKey, side = 'b') {
  const els = DRAWER_ELS[side];
  if (!els) return;
  const drawer = $(els.drawer);
  drawer.setAttribute('aria-hidden', 'false');
  drawer.dataset.layer = def.id;
  // Don't lock body scroll in compare view — both sides can scroll while
  // the user reads from both drawers. We only no-scroll for single-side
  // detail panels.
  if (state.activeLayer !== 'COMPARE') document.body.classList.add('no-scroll');

  const ckey = cardKey(def.id, sublayerKey, artefact.id);
  if (side === 'a') state.activeCardKeyA = ckey;
  else if (side === 'b' && state.activeLayer === 'COMPARE') state.activeCardKeyB = ckey;
  else state.activeCardKey = ckey;
  $$('.card').forEach(c => {
    const k = c.dataset.key;
    c.classList.toggle('is-active',
      k === state.activeCardKey || k === state.activeCardKeyA || k === state.activeCardKeyB);
  });

  $(els.eyebrow).textContent = `${def.num}${sublayerKey ? `.${sublayerKey}` : ''} · ${artefact.id}`;
  $(els.title).textContent   = artefact.title || artefact.id;

  // Meta strip (always shown)
  const meta = $(els.meta);
  meta.innerHTML = '';
  const rows = [];
  if (artefact.tool)         rows.push(['tool', artefact.tool]);
  if (artefact.tags?.length) rows.push(['tags', artefact.tags.join(', ')]);
  if (artefact.source)       rows.push(['source', artefact.source]);
  if (artefact.defines)      rows.push(['defines', artefact.defines]);
  if (artefact.refs?.length) rows.push(['refs', renderRefList(artefact.refs)]);
  if (artefact.desc)         rows.push(['summary', artefact.desc]);
  for (const [k, v] of rows) {
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'string') dd.textContent = v;
    else dd.appendChild(v);
    meta.appendChild(dt); meta.appendChild(dd);
  }

  // Broken refs warning (if any) — only meaningful for the right (B)
  // drawer in single-pack views; in compare we check both packs.
  const panels = $(els.panels);
  panels.innerHTML = '';
  const broken = state.symbolTable?.broken?.get(ckey);
  if (broken && broken.length) {
    const sec = panel('Broken references', 'broken-refs');
    sec.innerHTML += '<div class="broken-list">' +
      broken.map(r => `<code>${escapeHtml(r)}</code>`).join('') +
      '</div>';
    panels.appendChild(sec);
  }

  // Per-artefact-type structured panels.
  const typed = renderTypedPanels(artefact, def);
  if (typed) panels.appendChild(typed);
  const trace = renderRequirementTracePanel(artefact, side);
  if (trace) panels.appendChild(trace);

  // Always-show canonical source
  const src = panel('Canonical source', 'canonical-source');
  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.textContent = JSON.stringify(artefact.spec ?? artefact, null, 2);
  src.appendChild(pre);
  panels.appendChild(src);
}

function panel(title, className = '') {
  const sec = document.createElement('section');
  sec.className = 'drawer-section ' + className;
  sec.innerHTML = `<h3>${escapeHtml(title)}</h3>`;
  return sec;
}

function renderRefList(refs) {
  const span = document.createElement('span');
  refs.forEach((r, i) => {
    const a = document.createElement('a');
    a.href = '#';
    a.className = 'ref-link';
    a.textContent = r;
    a.dataset.ref = r;
    if (state.symbolTable && !isRefResolved(r)) a.classList.add('is-broken');
    a.onclick = (e) => { e.preventDefault(); jumpToRef(r); };
    span.appendChild(a);
    if (i < refs.length - 1) span.appendChild(document.createTextNode(', '));
  });
  return span;
}

function isRefResolved(ref) {
  if (!ref) return true;
  if (/^alert:/.test(ref)) return true;             // alerts are external
  if (/^ref:[A-Za-z0-9_-]+\//.test(ref) && !state.symbolTable.defined.has(ref)) return true;  // external import
  return state.symbolTable.defined.has(ref);
}

function jumpToRef(symbol) {
  // Find any artefact whose `defines` matches `symbol`, switch to its layer, open its drawer.
  if (!state.pack) return;
  const layers = state.pack.layers;
  const findIn = (items, layerId, sublayerKey) => {
    for (const a of items || []) {
      if (a.defines === symbol) return { a, layerId, sublayerKey };
    }
    return null;
  };
  let hit = null;
  for (const layerId of ['L1', 'L2', 'L2X', 'L3', 'L5', 'GOV']) {
    hit = findIn(layers[layerId], layerId);
    if (hit) break;
  }
  if (!hit) {
    for (const sg of L4_SUBGROUPS) {
      hit = findIn(layers.L4?.[sg.key], 'L4', sg.key);
      if (hit) break;
    }
  }
  if (!hit) { toast(`no artefact defines ${symbol}`, 'error'); return; }
  state.activeLayer = hit.layerId;
  appHost.renderTabs();
  appHost.renderMainView();
  openDrawer(hit.a, { id: hit.layerId }, hit.sublayerKey);
  // Scroll the now-active card into view if visible
  requestAnimationFrame(() => {
    const card = document.querySelector(`.card.is-active`);
    if (card) card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}

// ---------- per-artefact-type drawer panels ----------

function renderTypedPanels(artefact, def) {
  const id = artefact.id || '';
  const s = artefact.spec || {};
  if (id.startsWith('SLI-'))     return panelSLI(s);
  if (id.startsWith('SLO-'))     return panelSLO(s);
  if (id.startsWith('OTEL-'))    return panelOtel(s);
  if (id.startsWith('BAK-'))     return panelBackend(s);
  if (id.startsWith('STO-'))     return panelStorage(s);
  if (id.startsWith('METRIC-'))  return panelMetric(s);
  if (id.startsWith('SCRAPE-'))  return panelScrapeJob(s);
  if (id.startsWith('PIP-'))     return panelPipeline(id, s);
  if (id.startsWith('DASH-'))    return panelDashboard(s);
  if (id.startsWith('PANEL-'))   return panelDashboardPanel(s);
  if (id.startsWith('QRY-'))     return panelRecordingRule(s);
  if (id.startsWith('VIEW-'))    return panelDerivedView(s);
  if (id.startsWith('POL-'))     return panelBurnRate(s);
  if (id.startsWith('FCST-'))    return panelForecast(s);
  if (id.startsWith('ALR-'))     return panelAlertRoute(s);
  if (id.startsWith('HEAL-'))    return panelRemediation(s);
  if (id.startsWith('BASE-'))    return panelBaselines(s);
  if (id.startsWith('CHAOS-'))   return panelChaos(s);
  if (id.startsWith('SYN-'))     return panelSynthetic(s);
  if (id.startsWith('PROF-') || id.startsWith('NET-') || id.startsWith('POE-') ||
      id.startsWith('MESH-') || id.startsWith('COL-')) return panelExtended(id, s);
  if (id.startsWith('IMP-'))     return panelImport(s);
  return null;
}

function renderRequirementTracePanel(artefact, side = 'b') {
  const pack = side === 'a'
    ? state.pack
    : (state.activeLayer === 'COMPARE' && side === 'b' ? state.packB : state.pack);
  const chains = pack?.traceability?.chains || [];
  if (!chains.length) return null;
  const symbol = artefact.defines;
  if (!symbol || !/^(slis|slos)\./.test(symbol)) return null;
  const hits = chains.filter(c => c.slo?.symbol === symbol || c.sli?.symbol === symbol);
  if (!hits.length) return null;

  const p = panel('Requirement trace', 'p-requirement-trace');
  for (const chain of hits.slice(0, 3)) {
    const sec = subpanel(chain.slo?.id || chain.sli?.id || 'requirement');
    sec.appendChild(dl([
      ['slo', chain.slo?.id],
      ['sli', chain.sli?.id],
      ['status', chain.gaps?.length ? `${chain.gaps.length} gap(s)` : 'complete'],
      ['metrics', chain.metrics?.map(m => m.name).slice(0, 6).join(', ')],
      ['recording rules', chain.recordingRules?.map(r => r.name).slice(0, 4).join(', ')],
      ['exporters', chain.exporters?.map(e => e.title || e.id).join(', ')],
      ['scrape evidence', chain.scrapeJobs?.items?.length
        ? chain.scrapeJobs.items.map(j => j.name).join(', ')
        : (chain.scrapeJobs?.observedCount ? `${chain.scrapeJobs.observedCount} jobs observed` : null)],
      ['dashboards', chain.dashboards?.map(d => d.title || d.id).slice(0, 4).join(', ')],
      ['alerts', chain.alerts?.map(a => a.name).slice(0, 5).join(', ')],
    ]));
    if (chain.gaps?.length) {
      const gap = document.createElement('div');
      gap.className = 'trace-gap-list';
      gap.innerHTML = chain.gaps.map(g => `<code>${escapeHtml(g)}</code>`).join('');
      sec.appendChild(gap);
    }
    p.appendChild(sec);
  }
  return p;
}

function dl(rows) {
  const dl = document.createElement('dl');
  dl.className = 'panel-dl';
  for (const [k, v] of rows) {
    if (v == null || v === '') continue;
    const dt = document.createElement('dt'); dt.textContent = k;
    const dd = document.createElement('dd');
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') dd.textContent = String(v);
    else dd.appendChild(v);
    dl.appendChild(dt); dl.appendChild(dd);
  }
  return dl;
}

function code(text) {
  const pre = document.createElement('pre');
  pre.className = 'json';
  pre.style.maxHeight = '12rem';
  pre.textContent = String(text);
  return pre;
}

function table(rows, headers) {
  const t = document.createElement('table');
  t.className = 'panel-table';
  if (headers) {
    const thead = document.createElement('thead');
    const tr = document.createElement('tr');
    for (const h of headers) { const th = document.createElement('th'); th.textContent = h; tr.appendChild(th); }
    thead.appendChild(tr);
    t.appendChild(thead);
  }
  const tbody = document.createElement('tbody');
  for (const row of rows) {
    const tr = document.createElement('tr');
    for (const cell of row) {
      const td = document.createElement('td');
      if (typeof cell === 'string' || typeof cell === 'number') td.textContent = cell;
      else if (cell instanceof Node) td.appendChild(cell);
      else td.textContent = cell == null ? '—' : JSON.stringify(cell);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  return t;
}

function panelSLI(s) {
  const p = panel('SLI', 'p-sli');
  p.appendChild(dl([
    ['type', s.type],
    ['semconv metric', s.semconv_metric],
    ['unit', s.unit],
    ['threshold', s.threshold],
    ['percentile', s.percentile],
    ['owner', s.owner],
  ]));
  if (s.good) { const sec = subpanel('good (PromQL)'); sec.appendChild(code(s.good)); p.appendChild(sec); }
  if (s.total) { const sec = subpanel('total (PromQL)'); sec.appendChild(code(s.total)); p.appendChild(sec); }
  if (s.query) { const sec = subpanel('query (PromQL)'); sec.appendChild(code(s.query)); p.appendChild(sec); }
  if (s.expression) { const sec = subpanel('expression'); sec.appendChild(code(s.expression)); p.appendChild(sec); }
  return p;
}

function panelSLO(s) {
  const p = panel('SLO', 'p-slo');
  const sliRefSpan = document.createElement('span');
  if (s.sli) {
    const link = document.createElement('a');
    link.href = '#'; link.className = 'ref-link'; link.textContent = s.sli;
    link.onclick = (e) => { e.preventDefault(); jumpToRef(s.sli.startsWith('slis.') ? s.sli : `slis.${s.sli}`); };
    sliRefSpan.appendChild(link);
  }
  p.appendChild(dl([
    ['sli', sliRefSpan],
    ['objective', s.objective != null ? `${(s.objective * 100).toFixed(2).replace(/\.?0+$/, '')}%` : null],
    ['window', s.window],
    ['error budget policy', s.error_budget_policy],
  ]));
  return p;
}

function panelOtel(s) {
  const p = panel('OTel contract', 'p-otel');
  p.appendChild(dl([
    ['semconv', s.semconv],
    ['languages', s.sdk?.languages?.join(', ')],
    ['propagators', s.sdk?.propagators?.join(', ')],
    ['sampling', s.sdk?.sampling ? `${s.sdk.sampling.policy}${s.sdk.sampling.ratio != null ? ` @ ${s.sdk.sampling.ratio}` : ''}` : null],
    ['log correlation', s.sdk?.log_correlation == null ? null : String(s.sdk.log_correlation)],
    ['required attributes', s.resource_attributes?.required?.join(', ')],
    ['custom attributes', s.resource_attributes?.custom?.join(', ')],
  ]));
  return p;
}

function panelBackend(s) {
  const p = panel('Telemetry backend', 'p-backend');
  p.appendChild(dl([
    ['id', s.id],
    ['signal', s.signal],
    ['product', s.product],
    ['default', s.default == null ? null : String(s.default)],
    ['tenant', s.tenant],
  ]));
  if (s.version) {
    const sec = subpanel('version policy');
    sec.appendChild(dl([
      ['declared', s.version.declared],
      ['min', s.version.min],
      ['max', s.version.max],
      ['gating', s.version.gating],
      ['capabilities', s.version.capabilities?.join(', ')],
    ]));
    p.appendChild(sec);
  }
  if (s.endpoints?.length) {
    const sec = subpanel('endpoints');
    const ul = document.createElement('ul'); ul.className = 'endpoint-list';
    for (const e of s.endpoints) { const li = document.createElement('li'); li.textContent = e; ul.appendChild(li); }
    sec.appendChild(ul);
    p.appendChild(sec);
  }
  if (s.auth) {
    const sec = subpanel('auth');
    sec.appendChild(dl([
      ['kind', s.auth.kind],
      ['secretRef', s.auth.secretRef],
      ['tenant', s.auth.tenant],
      ['orgId', s.auth.orgId],
    ]));
    p.appendChild(sec);
  }
  return p;
}

function panelStorage(s) {
  const p = panel('Storage', 'p-storage');
  p.appendChild(dl([
    ['backend', s.backend],
    ['version', s.version],
    ['min version', s.min_version],
    ['gating', s.gating],
    ['backend ref', s.backend_ref],
    ['retention', s.retention],
    ['data stream', s.data_stream],
    ['ilm policy', s.ilm_policy],
    ['sampling', s.sampling],
  ]));
  if (s.remote_write?.length) {
    const sec = subpanel('remote write');
    sec.appendChild(table(s.remote_write.map(r => [r.url, r.tenant || '—']), ['url', 'tenant']));
    p.appendChild(sec);
  }
  if (s.downsample?.length) {
    const sec = subpanel('downsample');
    sec.appendChild(table(s.downsample.map(d => [d.resolution, d.retain_for]), ['resolution', 'retain for']));
    p.appendChild(sec);
  }
  return p;
}

function panelScrapeJob(s) {
  const isTelemetrySource = s.type === 'TelemetrySource';
  const p = panel(isTelemetrySource ? 'Telemetry source' : 'Scrape job', 'p-scrape');
  p.appendChild(dl([
    ['type', s.type],
    ['job', s.job],
    ['source', s.source],
    ['file', s.origin_file || s.file],
    ['query', s.scrape_query || s.metrics_path],
    ['interval', s.interval],
    ['targets', s.targets?.join(', ')],
  ]));
  if (s.exports?.length) {
    const sec = subpanel(`exports (${s.exports.length})`);
    const ul = document.createElement('ul');
    ul.className = 'endpoint-list';
    for (const name of s.exports) {
      const li = document.createElement('li');
      li.textContent = name;
      ul.appendChild(li);
    }
    sec.appendChild(ul);
    p.appendChild(sec);
  }
  return p;
}

function panelMetric(s) {
  const p = panel('Metric', 'p-metric');
  p.appendChild(dl([
    ['name', s.name],
    ['source name', s.source_name],
    ['source', s.source],
    ['origin kind', s.origin_kind],
    ['confidence', s.confidence],
    ['candidate', s.candidate ? 'yes' : null],
    ['telemetry source', s.origin_service],
    ['file', s.origin_file],
    ['query', s.query || s.origin_query || s.name],
    ['type', s.metric_type],
    ['help', s.help],
    ['labels', s.origin_labels?.join(', ')],
    ['used by', s.used_by?.join(', ')],
  ]));
  if (s.references?.length) {
    const sec = subpanel(`references (${s.references.length})`);
    sec.appendChild(table(
      s.references.map(r => [r.kind, r.name, r.file]),
      ['kind', 'name', 'file'],
    ));
    p.appendChild(sec);
  }
  return p;
}

function panelPipeline(id, s) {
  let kind = 'pipeline';
  if (id.startsWith('PIP-RCV-')) kind = 'receiver';
  else if (id.startsWith('PIP-PRC-')) kind = 'processor';
  else if (id.startsWith('PIP-EXP-')) kind = 'exporter';
  const p = panel(`OTel Collector ${kind}`, 'p-pipeline');
  p.appendChild(dl([['name', s.name], ['kind', s.kind]]));
  return p;
}

function panelDashboard(s) {
  const p = panel('Dashboard', 'p-dashboard');
  p.appendChild(dl([
    ['id', s.id],
    ['provider', s.provider?.kind],
    ['provider version', s.provider?.version],
    ['schemaVersion', s.provider?.schemaVersion],
    ['folder', s.folder],
    ['source', s.source],
    ['template', s.template],
  ]));
  if (s.datasources) {
    const sec = subpanel('datasources');
    sec.appendChild(dl(Object.entries(s.datasources).map(([k, v]) => [k, v])));
    p.appendChild(sec);
  }
  if (s.panel_bindings?.length) {
    const sec = subpanel('panel bindings');
    const rows = s.panel_bindings.map(b => {
      const a = document.createElement('a');
      a.href = '#'; a.className = 'ref-link'; a.textContent = b.binds_to;
      a.onclick = (e) => { e.preventDefault(); jumpToRef(b.binds_to); };
      return [b.panel, a];
    });
    sec.appendChild(table(rows, ['panel', 'binds to']));
    p.appendChild(sec);
  }
  if (s.params?.panels?.length) {
    const sec = subpanel(`uses (${s.params.panels.length})`);
    sec.appendChild(table(
      s.params.panels.slice(0, 80).map(panel => [
        panel.title || panel.panel,
        panel.binds_to || '—',
        (panel.metrics || []).slice(0, 4).join(', '),
        panel.expr || panel.query || '',
      ]),
      ['panel', 'binds to', 'metrics', 'query'],
    ));
    if (s.params.panels.length > 80) {
      const note = document.createElement('p');
      note.className = 'muted';
      note.textContent = `${s.params.panels.length - 80} more panel query uses captured in canonical source.`;
      sec.appendChild(note);
    }
    p.appendChild(sec);
  }
  return p;
}

function panelDashboardPanel(s) {
  const p = panel('Dashboard panel', 'p-dashboard-panel');
  p.appendChild(dl([
    ['panel', s.panel || s.title],
    ['binds to', s.binds_to],
    ['confidence', s.binding_confidence],
    ['reason', s.binding_reason],
    ['datasource', s.datasource],
    ['refId', s.refId],
    ['metrics', s.metrics?.join(', ')],
  ]));
  if (s.expr || s.query) {
    const sec = subpanel('query');
    sec.appendChild(code(s.expr || s.query));
    p.appendChild(sec);
  }
  return p;
}

function panelRecordingRule(s) {
  const p = panel('Recording rule', 'p-rule');
  p.appendChild(dl([['name', s.name], ['interval', s.interval]]));
  if (s.expr) { const sec = subpanel('expr (PromQL)'); sec.appendChild(code(s.expr)); p.appendChild(sec); }
  if (s.labels) { const sec = subpanel('labels'); sec.appendChild(dl(Object.entries(s.labels))); p.appendChild(sec); }
  return p;
}

function panelDerivedView(s) {
  const p = panel('Derived view', 'p-view');
  p.appendChild(dl([['id', s.id], ['bind', s.bind]]));
  if (s.params) { const sec = subpanel('params'); sec.appendChild(code(JSON.stringify(s.params, null, 2))); p.appendChild(sec); }
  return p;
}

function panelBurnRate(s) {
  const p = panel('Burn-rate alert', 'p-burn');
  const sloSpan = document.createElement('span');
  if (s.slo) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.slo;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.slo.startsWith('slos.') ? s.slo : `slos.${s.slo}`); };
    sloSpan.appendChild(a);
  }
  p.appendChild(dl([['slo', sloSpan]]));
  if (s.windows?.length) {
    const sec = subpanel('windows');
    sec.appendChild(table(
      s.windows.map(w => [w.short, w.long, w.factor + 'x', w.severity]),
      ['short', 'long', 'factor', 'severity'],
    ));
    p.appendChild(sec);
  }
  return p;
}

function panelForecast(s) {
  const p = panel('Forecast', 'p-forecast');
  const sloSpan = document.createElement('span');
  if (s.slo) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.slo;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.slo.startsWith('slos.') ? s.slo : `slos.${s.slo}`); };
    sloSpan.appendChild(a);
  }
  p.appendChild(dl([['slo', sloSpan], ['method', s.method], ['horizon', s.horizon], ['on projected breach', s.on_projected_breach]]));
  return p;
}

function panelAlertRoute(s) {
  const p = panel('Alert route', 'p-alert');
  p.appendChild(dl([['severity', s.severity]]));
  if (s.channels?.length) {
    const sec = subpanel('channels');
    const rows = s.channels.map(ch => {
      const kind = Object.keys(ch)[0];
      const target = ch[kind];
      return [kind, target];
    });
    sec.appendChild(table(rows, ['kind', 'target']));
    p.appendChild(sec);
  }
  if (s.match) { const sec = subpanel('match'); sec.appendChild(dl(Object.entries(s.match))); p.appendChild(sec); }
  return p;
}

function panelRemediation(s) {
  const p = panel('Remediation', 'p-heal');
  p.appendChild(dl([
    ['trigger', s.trigger],
    ['runbook', s.runbook],
    ['automation', s.automation],
  ]));
  if (s.guardrails) {
    const sec = subpanel('guardrails');
    sec.appendChild(dl([
      ['max invocations / hour', s.guardrails.max_invocations_per_hour],
      ['requires human above', s.guardrails.requires_human_above],
      ['rollback on failure', s.guardrails.rollback_on_failure == null ? null : String(s.guardrails.rollback_on_failure)],
      ['cooldown after success', s.guardrails.cooldown_after_success],
      ['circuit breaker', s.guardrails.circuit_breaker
        ? `${s.guardrails.circuit_breaker.failures} failures / ${s.guardrails.circuit_breaker.window}`
        : null],
    ]));
    p.appendChild(sec);
  }
  return p;
}

function panelBaselines(s) {
  const p = panel('Baselines', 'p-base');
  p.appendChild(dl([
    ['MTTD p50', s.mttd_target_p50],
    ['MTTD p95', s.mttd_target_p95],
    ['MTTR p50', s.mttr_target_p50],
    ['MTTR p95', s.mttr_target_p95],
    ['measurement source', s.measurement_source],
    ['review cadence', s.review_cadence],
    ['regression gate', s.regression_gate],
  ]));
  return p;
}

function panelChaos(s) {
  const p = panel('Chaos experiment', 'p-chaos');
  const hypSpan = document.createElement('span');
  if (s.steady_state_hypothesis) {
    const a = document.createElement('a');
    a.href = '#'; a.className = 'ref-link'; a.textContent = s.steady_state_hypothesis;
    a.onclick = (e) => { e.preventDefault(); jumpToRef(s.steady_state_hypothesis); };
    hypSpan.appendChild(a);
  }
  p.appendChild(dl([
    ['engine', s.engine],
    ['target', s.target],
    ['steady-state hypothesis', hypSpan],
    ['fault', s.fault ? `${s.fault.kind}${s.fault.duration ? ` · ${s.fault.duration}` : ''}${s.fault.fraction != null ? ` · ${s.fault.fraction}` : ''}` : null],
    ['expected MTTD', s.expected_mttd],
    ['schedule', s.schedule],
    ['environment', s.environment],
  ]));
  if (s.expected_alerts?.length) {
    const sec = subpanel('expected alerts');
    const ul = document.createElement('ul'); ul.className = 'endpoint-list';
    for (const a of s.expected_alerts) { const li = document.createElement('li'); li.textContent = a; ul.appendChild(li); }
    sec.appendChild(ul);
    p.appendChild(sec);
  }
  return p;
}

function panelSynthetic(s) {
  const p = panel('Synthetic check', 'p-syn');
  p.appendChild(dl([
    ['kind', s.kind],
    ['target', s.target],
    ['interval', s.interval],
    ['on fail severity', s.on_fail_severity],
    ['otel instrumentation', s.otel_instrumentation == null ? null : String(s.otel_instrumentation)],
  ]));
  if (s.assertions?.length) {
    const sec = subpanel('assertions');
    sec.appendChild(code(JSON.stringify(s.assertions, null, 2)));
    p.appendChild(sec);
  }
  return p;
}

function panelExtended(id, s) {
  let kind = 'extended surface';
  if (id.startsWith('PROF-')) kind = 'profiling';
  else if (id.startsWith('NET-'))  kind = 'network observability';
  else if (id.startsWith('POE-'))  kind = 'policy engine';
  else if (id.startsWith('MESH-')) kind = 'mesh / gateway';
  else if (id.startsWith('COL-'))  kind = 'collection pipeline';
  const p = panel(`Extended surface · ${kind}`, 'p-ext');
  p.appendChild(dl([
    ['product', s.product],
    ['role', s.role],
    ['backend', s.backend],
    ['version (declared)', s.version?.declared],
    ['version (min)', s.version?.min],
    ['gating', s.version?.gating],
    ['profile types', s.profile_types?.join(', ')],
    ['observe', s.observe?.join(', ')],
    ['bundles', s.bundles?.join(', ')],
  ]));
  return p;
}

function panelImport(s) {
  const p = panel('Import', 'p-import');
  p.appendChild(dl([['ref', s.ref]]));
  if (s.with) { const sec = subpanel('with'); sec.appendChild(code(JSON.stringify(s.with, null, 2))); p.appendChild(sec); }
  return p;
}

function subpanel(title) {
  const sec = document.createElement('div');
  sec.className = 'subpanel';
  sec.innerHTML = `<h4>${escapeHtml(title)}</h4>`;
  return sec;
}

export function closeDrawer(side) {
  // No side passed = close all (Esc key / external triggers).
  const sides = side ? [side] : ['a', 'b'];
  for (const s of sides) {
    const els = DRAWER_ELS[s];
    if (!els) continue;
    $(els.drawer).setAttribute('aria-hidden', 'true');
    if (s === 'a') state.activeCardKeyA = null;
    else if (state.activeLayer === 'COMPARE') state.activeCardKeyB = null;
    else state.activeCardKey = null;
  }
  // Only release body scroll lock when both drawers are closed.
  const anyOpen = ['a', 'b'].some(s => $(DRAWER_ELS[s].drawer).getAttribute('aria-hidden') === 'false');
  if (!anyOpen) document.body.classList.remove('no-scroll');
  $$('.card').forEach(c => {
    const k = c.dataset.key;
    c.classList.toggle('is-active',
      k === state.activeCardKey || k === state.activeCardKeyA || k === state.activeCardKeyB);
  });
}
