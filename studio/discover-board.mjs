// studio/discover-board.mjs
//
// Discover's pack board — the "ObservabilityPack realisation" sheet: the pack
// drawn as one band per layer, each band a row of groups holding what the
// pack has there (SLI tiles, SLO targets, the telemetry pipeline in the order
// signals flow through it, dashboards, alert routing, validation). It is the
// catalogue made visible: every item is an artefact of the pack and opens its
// record; nothing is scored. Pure HTML builders over the adapted pack (no
// state, no DOM), like card-html.mjs; layers-view.mjs wires the actions.
// A group title and a head fact carry a glossary mark (studio/glossary.mjs)
// when the bound taxonomy's v2 glossary explains them — nothing otherwise.

import { escapeHtml } from './util.mjs';
import { classifyArtefact, requireTaxonomy } from './taxonomy.mjs';
import { verdictBadgeHtml } from './verdict-html.mjs';
import { glossaryGroupMarkHtml, glossaryLabelHtml } from './glossary.mjs';

// Items a group draws before "+N more" (which opens the layer's full list).
export const BOARD_ITEMS_SHOWN = 6;

// Per layer: its groups, in order. A group takes the artefacts whose family
// (tools/lib/artefact-classify.mjs, bound through studio/taxonomy.mjs) has
// its home there — FAMILY_HOME maps every family to one layer and group;
// anything no group claims lands in a trailing "Other" group, so the board
// never hides an artefact, and the board never moves an artefact across
// layers: an artefact whose family lives elsewhere is this layer's "Other".
// `flow` draws an arrow between consecutive groups (signals move left to
// right); an `aside` group is an inventory beside the flow, not a step in
// it. An `optional` group is not drawn when empty.
export const BOARD_LAYERS = {
  L1: { groups: [
    { id: 'sli', title: 'SLIs', draw: 'sli' },
    { id: 'slo', title: 'SLOs · targets', draw: 'slo' },
  ] },
  L2: { flow: true, groups: [
    { id: 'otel', title: 'Instrumentation', draw: 'otel' },
    { id: 'rcv', title: 'Receivers' },
    { id: 'prc', title: 'Processors' },
    { id: 'exp', title: 'Exporters & storage', draw: 'signal' },
    { id: 'metrics', title: 'Metric inventory', draw: 'inventory', aside: true, optional: true },
  ] },
  L2X: { groups: [
    { id: 'prof', title: 'Profiles', optional: true },
    { id: 'net', title: 'Network', optional: true },
    { id: 'poe', title: 'Policy engine', optional: true },
    { id: 'mesh', title: 'Service mesh', optional: true },
    { id: 'col', title: 'Collection', optional: true },
  ] },
  L3: { flow: true, groups: [
    { id: 'qry', title: 'Recording rules' },
    { id: 'view', title: 'Derived views' },
    { id: 'dash', title: 'Dashboards', draw: 'dash' },
    { id: 'panel', title: 'Dashboard panels', draw: 'inventory', aside: true, optional: true },
  ] },
  L4: { flow: true, groups: [
    { id: 'pol', title: 'Policy & detection' },
    { id: 'alr', title: 'Alert routing', draw: 'route' },
    { id: 'rule', title: 'Operational alert rules', optional: true },
    { id: 'heal', title: 'Remediation' },
  ] },
  L5: { groups: [
    { id: 'base', title: 'Baselines & performance', draw: 'baseline' },
    { id: 'chaos', title: 'Chaos experiments' },
    { id: 'syn', title: 'Synthetic checks' },
  ] },
  GOV: { groups: [
    { id: 'imp', title: 'Imports' },
  ] },
};

// ---------- small drawings (stroke icons, 24 × 24, currentColor) ----------

const ICONS = {
  shield:  '<path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/><path d="M9 12l2.2 2.2L15.5 10"/>',
  gauge:   '<path d="M4.5 17a8.5 8.5 0 1 1 15 0"/><path d="M12 13l4-5"/><circle cx="12" cy="13" r="1.2"/>',
  service: '<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/><path d="M4 7.5l8 4.5 8-4.5M12 12v9"/>',
  tier:    '<path d="M12 3l9 5-9 5-9-5 9-5z"/><path d="M3 12l9 5 9-5M3 16l9 5 9-5"/>',
  env:     '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.2 3 14.8 0 18M12 3c-3 3.2-3 14.8 0 18"/>',
  owners:  '<circle cx="9" cy="9" r="3.2"/><path d="M3 20c.6-3.4 3-5 6-5s5.4 1.6 6 5"/><circle cx="17" cy="8" r="2.4"/><path d="M16 14.2c2.6.2 4.4 1.8 5 4.8"/>',
  code:    '<path d="M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14"/>',
  lang:    '<path d="M4 5h9M8.5 3v2M6 5c.6 4 3 7 6.5 8.5M11 5c-.6 4-3.2 7.2-7 8.5"/><path d="M13 21l4-9 4 9M14.4 18h5.2"/>',
  store:   '<ellipse cx="12" cy="6" rx="7.5" ry="3"/><path d="M4.5 6v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3V6M4.5 12v6c0 1.7 3.4 3 7.5 3s7.5-1.3 7.5-3v-6"/>',
  imports: '<rect x="3" y="4" width="8" height="6" rx="1.5"/><rect x="13" y="14" width="8" height="6" rx="1.5"/><path d="M7 10v4a3 3 0 0 0 3 3h3"/>',
  chart:   '<path d="M4 19h16"/><path d="M5 15l4-5 3 3 4-6 3 4"/>',
};
function icon(name, cls = 'dvb-ico') {
  return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${ICONS[name] || ''}</svg>`;
}

// ---------- reading an artefact ----------

// "receiver: otlp" → "otlp"; "burn-rate alert: orders_availability" →
// "orders_availability": the group's title already says the family.
function shortTitle(a) {
  const t = String(a?.title ?? a?.id ?? '');
  const m = /^(?:receiver|processor|burn-rate alert|forecast|import|chaos|synthetic)(?:\s*\([^)]*\))?:\s*(.+)$/i.exec(t);
  return m ? m[1] : t;
}

// 0.999 → "99.9%"; 99.5 → "99.5%". null when the artefact carries no target.
export function objectivePct(objective) {
  const n = Number(objective);
  if (!Number.isFinite(n) || n <= 0) return null;
  const pct = n <= 1 ? n * 100 : n;
  return `${Number(pct.toFixed(3))}%`;
}

function tip(a) {
  return [a.id, a.title, a.desc].filter(Boolean).join(' · ');
}
const itemAttrs = (e, cls) => `type="button" class="dvb-item ${cls}" data-ux-action="dv-item" data-key="${escapeHtml(e.key)}" title="${escapeHtml(tip(e.a))}"`;
// A reviewer's verdict on the entry (`e.verdict`, set by the Discover screen
// from state; the goldens' entries carry none): the last child of the item.
const badge = (e) => (e.verdict ? verdictBadgeHtml(e.verdict) : '');

// ---------- one item, per drawing ----------

const DRAW = {
  // The default: a line — the name, and the adapter's one-line summary.
  line(e) {
    const a = e.a;
    const name = shortTitle(a);
    const sub = a.desc && a.desc !== a.title ? a.desc : '';
    return `<button ${itemAttrs(e, 'dvb-line')}><span class="dvb-name">${escapeHtml(name)}</span>${sub ? `<span class="dvb-sub">${escapeHtml(sub)}</span>` : ''}${badge(e)}</button>`;
  },
  // An indicator: what it measures and how (ratio, threshold).
  sli(e) {
    const a = e.a;
    const type = String(a.spec?.type || '').toLowerCase();
    return `<button ${itemAttrs(e, 'dvb-tile')}>${icon(type === 'ratio' ? 'shield' : 'gauge')}<span class="dvb-name">${escapeHtml(a.title || a.id)}</span>${type ? `<span class="dvb-sub">${escapeHtml(type)}</span>` : ''}${badge(e)}</button>`;
  },
  // An objective: the target as a dial, its indicator and window.
  slo(e) {
    const a = e.a;
    const pct = objectivePct(a.spec?.objective);
    const fill = pct ? Math.max(0, Math.min(100, parseFloat(pct))) : 0;
    return `<button ${itemAttrs(e, 'dvb-tile dvb-slo')}>
        <span class="dvb-dial" style="--dvb-fill:${fill}"><span class="dvb-dial-val">${escapeHtml(pct || '—')}</span></span>
        <span class="dvb-name">${escapeHtml(a.spec?.sli || a.title || a.id)}</span>
        ${a.spec?.window ? `<span class="dvb-sub">/ ${escapeHtml(a.spec.window)}</span>` : ''}${badge(e)}
      </button>`;
  },
  // The instrumentation contract: its settings as facts.
  otel(e) {
    const s = e.a.spec || {};
    const sampling = s.sdk?.sampling;
    const facts = [
      ['SemConv', s.semconv],
      ['Languages', (s.sdk?.languages || []).join(', ')],
      ['Sampling', sampling ? `${sampling.policy || ''}${sampling.ratio != null ? ` @ ${sampling.ratio}` : ''}`.trim() : ''],
      ['Propagators', (s.sdk?.propagators || []).join(', ')],
      ['Required attributes', (s.resource_attributes?.required || []).join(', ')],
    ].filter(([, v]) => v);
    return `<button ${itemAttrs(e, 'dvb-facts-item')}>
        <span class="dvb-name">${escapeHtml(e.a.tool || e.a.title || e.a.id)}</span>
        ${facts.map(([k, v]) => `<span class="dvb-kv"><span class="dvb-k">${escapeHtml(k)}</span><span class="dvb-v">${escapeHtml(v)}</span></span>`).join('')}${badge(e)}
      </button>`;
  },
  // An exporter, backend or store: the signal, then where it goes.
  signal(e) {
    const a = e.a;
    const signal = a.spec?.signal || (a.tags || []).find(t => ['metrics', 'logs', 'traces', 'profiles'].includes(t)) || '';
    const target = a.spec?.product || a.spec?.kind || a.tool || '';
    if (!signal || !target) return DRAW.line(e);
    return `<button ${itemAttrs(e, 'dvb-line dvb-signal')}><span class="dvb-chip" data-signal="${escapeHtml(signal)}">${escapeHtml(signal)}</span><span class="dvb-arrow" aria-hidden="true">→</span><span class="dvb-name">${escapeHtml(target)}</span>${badge(e)}</button>`;
  },
  // An alert route: the severity, then who is told.
  route(e) {
    const a = e.a;
    const sev = a.spec?.severity || (a.tags || []).find(t => /^SEV\d$/i.test(t)) || '';
    const channels = (a.spec?.channels || []).map(c => (c && typeof c === 'object' ? Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') : String(c))).join(' · ');
    if (!sev) return DRAW.line(e);
    return `<button ${itemAttrs(e, 'dvb-line dvb-route')}><span class="dvb-sev" data-sev="${escapeHtml(String(sev).toUpperCase())}">${escapeHtml(sev)}</span><span class="dvb-arrow" aria-hidden="true">→</span><span class="dvb-name">${escapeHtml(channels || a.desc || '')}</span>${badge(e)}</button>`;
  },
  // A dashboard: a thumbnail tile.
  dash(e) {
    const a = e.a;
    return `<button ${itemAttrs(e, 'dvb-tile dvb-dash')}>${icon('chart', 'dvb-ico dvb-ico-wide')}<span class="dvb-name">${escapeHtml(a.title || a.id)}</span>${a.tool ? `<span class="dvb-sub">${escapeHtml(a.tool)}</span>` : ''}${badge(e)}</button>`;
  },
  // Baselines: the detection and recovery targets.
  baseline(e) {
    const s = e.a.spec || {};
    const facts = [
      ['MTTD p50', s.mttd_target_p50], ['MTTD p95', s.mttd_target_p95],
      ['MTTR p50', s.mttr_target_p50], ['MTTR p95', s.mttr_target_p95],
      ['Review', s.review_cadence],
    ].filter(([, v]) => v);
    if (!facts.length) return DRAW.line(e);
    return `<button ${itemAttrs(e, 'dvb-facts-item')}>
        <span class="dvb-name">${escapeHtml(e.a.title || e.a.id)}</span>
        ${facts.map(([k, v]) => `<span class="dvb-kv"><span class="dvb-k">${escapeHtml(k)}</span><span class="dvb-v">${escapeHtml(v)}</span></span>`).join('')}${badge(e)}
      </button>`;
  },
};
// Which drawings lay their items out as tiles (a grid) instead of lines.
const TILE_DRAWS = new Set(['sli', 'slo', 'dash']);

// ---------- a layer's groups ----------

/**
 * Split a layer's entries ({ a, key }) onto its groups by family; the rest
 * go to "Other". Throws until bindTaxonomy() has run (studio/taxonomy.mjs).
 */
export function boardGroups(layerId, entries) {
  requireTaxonomy();
  const def = BOARD_LAYERS[layerId] || { groups: [] };
  const groups = def.groups.map(g => ({ ...g, entries: [] }));
  const other = { id: 'other', title: 'Other', optional: true, entries: [] };
  for (const e of entries || []) {
    const c = classifyArtefact(e.a);
    const g = c.layer === layerId ? groups.find(x => x.id === c.group) : null;
    (g || other).entries.push(e);
  }
  return { flow: !!def.flow, groups: [...groups, other].filter(g => g.entries.length || !g.optional) };
}

function groupHtml(g, layerId) {
  const n = g.entries.length;
  let body;
  if (!n) {
    body = '<p class="dvb-none">None in this pack</p>';
  } else if (g.draw === 'inventory') {
    // A long inventory (every metric, every panel): its size and a few names.
    const names = g.entries.slice(0, 3).map(e => `<span class="dvb-inv-name">${escapeHtml(shortTitle(e.a))}${badge(e)}</span>`).join('');
    body = `<button type="button" class="dvb-item dvb-inv" data-ux-action="dv-open" data-layer="${escapeHtml(layerId)}" title="Open the layer's full list">
        <span class="dvb-inv-n">${n}</span>${names}<span class="dvb-more-text">Open the list →</span>
      </button>`;
  } else {
    const draw = DRAW[g.draw] || DRAW.line;
    const shown = g.entries.slice(0, BOARD_ITEMS_SHOWN);
    const more = n - shown.length;
    body = `<div class="dvb-items${TILE_DRAWS.has(g.draw) ? ' is-tiles' : ''}">${shown.map(draw).join('')}</div>${more > 0
      ? `<button type="button" class="dvb-more" data-ux-action="dv-open" data-layer="${escapeHtml(layerId)}" title="Open the layer's full list">+${more} more</button>` : ''}`;
  }
  return `
    <section class="dvb-group${g.aside ? ' is-aside' : ''}${n ? '' : ' is-empty'}" data-group="${escapeHtml(g.id)}" aria-label="${escapeHtml(`${g.title}: ${n}`)}">
      <h4 class="dvb-group-title">${escapeHtml(g.title)}${glossaryGroupMarkHtml(layerId, g.id, g.title)}${n ? ` <span class="dvb-group-n">${n}</span>` : ''}</h4>
      ${body}
    </section>`;
}

/** The groups of one layer band, as HTML. */
export function boardGroupsHtml(layerId, entries) {
  const { flow, groups } = boardGroups(layerId, entries);
  if (!groups.length) return '<div class="dv-groups"><p class="dvb-none">Nothing on this layer</p></div>';
  return `<div class="dv-groups${flow ? ' is-flow' : ''}">${groups.map(g => groupHtml(g, layerId)).join('')}</div>`;
}

// ---------- the board's head: which pack this is ----------

/**
 * The identity of the pack: its title and the facts the manifest states.
 * `artefacts` is every artefact of the pack (for the facts read off them:
 * the instrumentation contract, the backends, the imports).
 */
export function boardHeadHtml({ meta = {}, env = '', total = 0, layers = 0, artefacts = [] } = {}) {
  requireTaxonomy();
  const byFamily = (f) => artefacts.filter(a => classifyArtefact(a).family === f);
  const otel = byFamily('otel')[0]?.spec || {};
  const backends = [...new Set(byFamily('backend').map(a => a.spec?.product || a.tool).filter(Boolean))];
  const imports = byFamily('imports');
  const facts = [
    ['service', 'Service', meta.service],
    ['tier', 'Criticality', meta.criticality],
    ['env', 'Environment', env || meta.environment],
    ['owners', 'Owners', (meta.owners || []).join(', ')],
    ['code', 'OTel SemConv', otel.semconv],
    ['lang', 'Languages', (otel.sdk?.languages || []).join(', ')],
    ['store', 'Backends', backends.join(', ')],
    ['imports', 'Imports', imports.length ? imports.map(a => shortTitle(a)).join(', ') : ''],
  ].filter(([, , v]) => v);
  const name = meta.name || '';
  const version = meta.version ? `v${meta.version}` : '';
  const size = total
    ? `${total} artefact${total === 1 ? '' : 's'} across ${layers} layer${layers === 1 ? '' : 's'}`
    : 'no artefacts yet';
  return `
    <header class="dvb-head" id="dv-summary" aria-label="The open pack">
      <div class="dvb-head-text">
        <p class="dvb-eyebrow">Discover · What do we have?</p>
        <h2 class="dvb-h">ObservabilityPack${meta.service ? ` <span class="dvb-h-of">— ${escapeHtml(meta.service)}</span>` : ''}</h2>
        <p class="dvb-lede">${escapeHtml([name, version].filter(Boolean).join(' '))}${name || version ? ' · ' : ''}${escapeHtml(size)}</p>
      </div>
      ${facts.length ? `<dl class="dvb-facts">${facts.map(([ic, k, v]) => `
        <div class="dvb-fact">${icon(ic, 'dvb-fact-ico')}<dt>${glossaryLabelHtml(k)}</dt><dd title="${escapeHtml(v)}">${escapeHtml(v)}</dd></div>`).join('')}</dl>` : ''}
    </header>`;
}
