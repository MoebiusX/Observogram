#!/usr/bin/env node
/**
 * tools/test-blast-radius.mjs
 *
 * Unit test for tools/lib/blast-radius.mjs — the zero-import reverse index
 * over the traceability graph: what WOULD go blind (transitive consumers)
 * and what WOULD lose protection (transitive protection losers) if a node
 * died. Pure functions over hand-built graph shapes: hop distances along
 * the full artefact chain, the protection relation, scaffold exclusion,
 * cycle safety, determinism, the listing cap and the accepted input shapes.
 * Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { createHarness } from './lib/harness.mjs';
import {
  CONSUMER_SIDE, PROTECTION_SIDE, KIND_ORDER, DEFAULT_WEIGHTS, BLINDED_NODES_CAP,
  normalizeGraphShape, blastRadiusOf, blastRadiusIndex,
} from './lib/blast-radius.mjs';

const { assert, report } = createHarness();

// --- vendoring guard: zero-import, no Node APIs, no environment ---
const src = readFileSync(new URL('./lib/blast-radius.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\s/m.test(src), 'blast-radius.mjs is zero-import (vendored verbatim downstream)');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\./.test(src), 'blast-radius.mjs reads no node: module and no environment');

// --- the tables ---
assert(Object.values(CONSUMER_SIDE).every((side) => side === 'from' || side === 'to'), 'CONSUMER_SIDE maps every edge type to from|to');
assert(CONSUMER_SIDE.materialises === 'to' && Object.entries(CONSUMER_SIDE).filter(([, side]) => side === 'to').length === 1,
       'materialises is the only edge whose `to` side (the SLI) consumes', CONSUMER_SIDE);
assert(['sli_of', 'sources', 'exported_by', 'produced_by', 'protects', 'forecasts', 'visualises', 'contains', 'routes', 'remediates', 'validates']
         .every((type) => CONSUMER_SIDE[type] === 'from'), 'every other edge type is consumed by its `from` side');
assert(Object.keys(PROTECTION_SIDE).sort().join() === 'protects,remediates,routes' && Object.values(PROTECTION_SIDE).every((s) => s === 'to'),
       'PROTECTION_SIDE: the `to` side loses when the `from` side dies, for protects / routes / remediates');
assert(KIND_ORDER.slice(0, 3).join() === 'slo,sli,burn_rate' && KIND_ORDER.includes('dashboard') && KIND_ORDER.includes('synthetic'),
       'KIND_ORDER leads with the commitment, its SLI and its alert');
assert(DEFAULT_WEIGHTS.slo === 3 && DEFAULT_WEIGHTS.sli === 3 && DEFAULT_WEIGHTS.burn_rate === 2 && DEFAULT_WEIGHTS.panel === 0.35 && DEFAULT_WEIGHTS.backend === 0.5,
       'DEFAULT_WEIGHTS carries the graph limb weights');
assert(BLINDED_NODES_CAP === 64, 'the listing cap is 64');

// --- fixture: the full chain ---
//   scrape_job <- metric <- rule -> SLI <- SLO <- alert <- route / remediation
//   panel -> SLI, dashboard -> panel, forecast -> SLO, chaos -> SLO
const N = (key, kind, label = key, extra = {}) => ({ key, kind, label, ...extra });
const E = (from, to, type) => ({ from, to, type, provenance: 'declared' });
const chainNodes = () => [
  N('scrape:checkout', 'scrape_job', 'checkout-api'),
  N('metric:latency', 'metric', 'checkout_latency_seconds_bucket', { virtual: true }),
  N('rule:latency', 'recording_rule', 'checkout:latency:ratio_5m'),
  N('sli:latency', 'sli', 'checkout_latency'),
  N('slo:latency', 'slo', 'checkout_latency_99'),
  N('alert:burn', 'burn_rate', 'checkout burn'),
  N('route:sev1', 'alert_route', 'SEV1 oncall'),
  N('rem:restart', 'remediation', 'restart checkout'),
  N('panel:latency', 'panel', 'Checkout latency'),
  N('dash:checkout', 'dashboard', 'checkout-slo'),
  N('forecast:budget', 'forecast', 'budget forecast'),
  N('chaos:kill', 'chaos', 'kill checkout pod'),
];
const chainEdges = () => [
  E('metric:latency', 'scrape:checkout', 'exported_by'),
  E('rule:latency', 'metric:latency', 'sources'),
  E('rule:latency', 'sli:latency', 'materialises'),
  E('slo:latency', 'sli:latency', 'sli_of'),
  E('alert:burn', 'slo:latency', 'protects'),
  E('route:sev1', 'alert:burn', 'routes'),
  E('rem:restart', 'alert:burn', 'remediates'),
  E('panel:latency', 'sli:latency', 'visualises'),
  E('dash:checkout', 'panel:latency', 'contains'),
  E('forecast:budget', 'slo:latency', 'forecasts'),
  E('chaos:kill', 'slo:latency', 'validates'),
];
const chain = () => ({ nodes: chainNodes(), edges: chainEdges() });
const hopsOf = (r) => Object.fromEntries(r.blinded.nodes.map((n) => [n.key, n.hop]));

// (a) a dead scrape job blinds the whole chain, hop by hop
{
  const r = blastRadiusOf(chain(), 'scrape:checkout');
  assert(r && r.key === 'scrape:checkout' && r.kind === 'scrape_job' && r.label === 'checkout-api', 'blastRadiusOf names the origin', r && [r.key, r.kind, r.label]);
  const want = {
    'metric:latency': 1, 'rule:latency': 2, 'sli:latency': 3, 'slo:latency': 4, 'panel:latency': 4,
    'alert:burn': 5, 'forecast:budget': 5, 'chaos:kill': 5, 'dash:checkout': 5,
    'route:sev1': 6, 'rem:restart': 6,
  };
  const got = hopsOf(r);
  assert(Object.keys(want).length === Object.keys(got).length && Object.keys(want).every((k) => got[k] === want[k]),
         'a dead scrape job blinds metric, rule, SLI, SLO, alert, forecast, panel, dashboard, chaos, route and remediation at the right hop', got, want);
  assert(r.blinded.total === 11 && r.blinded.nodes.length === 11 && !r.blinded.nodes.some((n) => n.key === 'scrape:checkout'), 'the origin is excluded from its own blast radius', r.blinded.total, 11);
  assert(r.blinded.nodes.some((n) => n.key === 'metric:latency'), 'a virtual metric node is included');
  assert(JSON.stringify(r.blinded.byKind) === JSON.stringify({ slo: 1, sli: 1, burn_rate: 1, recording_rule: 1, metric: 1, alert_route: 1, remediation: 1, forecast: 1, panel: 1, dashboard: 1, chaos: 1 }),
         'byKind counts every blinded kind, in KIND_ORDER', r.blinded.byKind);
  assert(r.blinded.weight === 16.45, 'weight sums DEFAULT_WEIGHTS over the blinded nodes (4 dp)', r.blinded.weight, 16.45);
  assert(JSON.stringify(r.summary) === JSON.stringify({ slos: 1, alerts: 1, panels: 1, dashboards: 1, routes: 1, remediations: 1, total: 11 }),
         'summary: slos 1, alerts 1, panels 1, dashboards 1, routes 1, remediations 1, total 11', r.summary);
  assert(r.unprotected.slos.length === 0 && r.unprotected.alerts.length === 0, 'nothing is merely unprotected — the SLO and alert are already blinded', r.unprotected);
  const hops = r.blinded.nodes.map((n) => n.hop);
  assert(hops.every((h, i) => i === 0 || h >= hops[i - 1]), 'blinded.nodes is sorted by hop first', hops);
  const hop5 = r.blinded.nodes.filter((n) => n.hop === 5).map((n) => n.kind);
  assert(hop5.join() === 'burn_rate,forecast,dashboard,chaos', 'ties on hop follow KIND_ORDER', hop5);
}

// (b) a dead alert: its route and remediation go blind; its SLO loses protection
{
  const r = blastRadiusOf(chain(), 'alert:burn');
  assert(r.blinded.nodes.map((n) => `${n.key}@${n.hop}`).join() === 'route:sev1@1,rem:restart@1', 'a dead alert blinds the route and the remediation that act on it', r.blinded.nodes);
  assert(JSON.stringify(r.unprotected.slos) === JSON.stringify([{ key: 'slo:latency', label: 'checkout_latency_99', hop: 1 }]) && r.unprotected.alerts.length === 0,
         'the protected SLO is unprotected (not blinded) at hop 1', r.unprotected);
  assert(r.summary.slos === 1 && r.summary.alerts === 0 && r.summary.routes === 1 && r.summary.remediations === 1 && r.summary.total === 3,
         'summary counts the unprotected SLO once and totals blinded + unprotected', r.summary);
}

// (c) a dead route: the alert loses delivery, the SLO loses protection — transitively
{
  const r = blastRadiusOf(chain(), 'route:sev1');
  assert(r.blinded.total === 0 && r.blinded.weight === 0 && JSON.stringify(r.blinded.byKind) === '{}', 'nothing consumes a route, so a dead route blinds nothing', r.blinded);
  assert(JSON.stringify(r.unprotected) === JSON.stringify({
    slos: [{ key: 'slo:latency', label: 'checkout_latency_99', hop: 2 }],
    alerts: [{ key: 'alert:burn', label: 'checkout burn', hop: 1 }],
  }), 'a dead route leaves its alert undelivered (hop 1) and the SLO unprotected (hop 2)', r.unprotected);
  assert(r.summary.slos === 1 && r.summary.alerts === 1 && r.summary.total === 2, 'summary: slos 1, alerts 1, total 2', r.summary);
  const rem = blastRadiusOf(chain(), 'rem:restart');
  assert(rem.unprotected.alerts.length === 1 && rem.unprotected.slos.length === 1, 'a dead remediation likewise leaves alert and SLO exposed', rem.unprotected);
}

// a dead SLO: everything that reads or protects it goes blind (hops from the SLO)
{
  const r = blastRadiusOf(chain(), 'slo:latency');
  assert(JSON.stringify(hopsOf(r)) === JSON.stringify({ 'alert:burn': 1, 'forecast:budget': 1, 'chaos:kill': 1, 'route:sev1': 2, 'rem:restart': 2 }),
         'a dead SLO blinds alert / forecast / chaos, then route / remediation', hopsOf(r));
  assert(r.summary.slos === 0 && r.summary.alerts === 1 && r.unprotected.slos.length === 0, 'the origin never counts itself', r.summary);
}

// (d) scaffold nodes are excluded and never traversed
{
  const shape = chain();
  shape.nodes.push(N('alert:scaffold', 'burn_rate', 'placeholder burn-rate', { scaffold: true }));
  shape.nodes.push(N('route:viaScaffold', 'alert_route', 'SEV9 via placeholder'));
  shape.nodes.push({ key: 'route:artefactScaffold', kind: 'alert_route', artefact: { source: 'Scaffold', title: 'fallback route' } });
  shape.edges.push(E('alert:scaffold', 'slo:latency', 'protects'));
  shape.edges.push(E('route:viaScaffold', 'alert:scaffold', 'routes'));
  shape.edges.push(E('route:artefactScaffold', 'alert:burn', 'routes'));
  const norm = normalizeGraphShape(shape);
  assert(norm.nodes.get('alert:scaffold').scaffold === true && norm.nodes.get('route:artefactScaffold').scaffold === true && norm.nodes.get('route:viaScaffold').scaffold === false,
         'scaffold via `scaffold: true` or `artefact.source === "Scaffold"`');
  assert(norm.nodes.get('route:artefactScaffold').label === 'fallback route', 'a raw graph node without a label is labelled from its artefact');
  const r = blastRadiusOf(shape, 'slo:latency');
  const keys = r.blinded.nodes.map((n) => n.key);
  assert(!keys.includes('alert:scaffold') && !keys.includes('route:viaScaffold') && !keys.includes('route:artefactScaffold'),
         'a scaffold alert is never listed and the route behind it is never reached', keys);
  assert(r.summary.alerts === 1 && r.summary.routes === 1, 'summary ignores the placeholders', r.summary);
  const alert = blastRadiusOf(shape, 'alert:burn');
  assert(!alert.blinded.nodes.some((n) => n.key === 'route:artefactScaffold') && alert.summary.routes === 1, 'a scaffold route consuming a real alert is not listed either', alert.blinded.nodes);
  const idx = blastRadiusIndex(shape);
  assert(!idx.has('alert:scaffold') && !idx.has('route:artefactScaffold') && idx.has('route:viaScaffold'), 'the index skips scaffold nodes', [...idx.keys()]);
  const own = blastRadiusOf(shape, 'alert:scaffold');
  assert(own && own.blinded.total === 0 && own.unprotected.slos.length === 0 && own.summary.total === 0, 'a scaffold origin blinds nothing (a placeholder never monitored anything)', own);
}

// (e) cycle safety
{
  const shape = chain();
  shape.edges.push(E('metric:latency', 'sli:latency', 'sources'));   // metric consumes SLI: sli -> metric -> rule -> sli
  const r = blastRadiusOf(shape, 'scrape:checkout');
  assert(r.blinded.total === 11 && !r.blinded.nodes.some((n) => n.key === 'scrape:checkout'), 'a cycle terminates and does not double-count', r.blinded.total);
  const sli = blastRadiusOf(shape, 'sli:latency');
  assert(!sli.blinded.nodes.some((n) => n.key === 'sli:latency') && hopsOf(sli)['metric:latency'] === 1 && hopsOf(sli)['rule:latency'] === 2,
         'walking a cycle from inside it never re-adds the origin and keeps shortest hops', hopsOf(sli));
  shape.edges.push(E('alert:burn', 'alert:burn', 'routes'));   // self loop
  assert(blastRadiusOf(shape, 'alert:burn').blinded.total === 2, 'a self-loop is ignored');
}

// (f) determinism: shuffled input order yields identical output
{
  const a = chain();
  const b = { nodes: chainNodes().reverse(), edges: chainEdges().reverse() };
  const c = { nodes: [...chainNodes()].sort((x, y) => (x.key.length - y.key.length) || (x.key < y.key ? 1 : -1)), edges: [...chainEdges()].sort((x, y) => (x.type < y.type ? 1 : -1)) };
  for (const key of ['scrape:checkout', 'alert:burn', 'route:sev1', 'sli:latency']) {
    const ra = JSON.stringify(blastRadiusOf(a, key));
    assert(ra === JSON.stringify(blastRadiusOf(b, key)) && ra === JSON.stringify(blastRadiusOf(c, key)), `blastRadiusOf(${key}) is independent of node and edge order`);
  }
  const ia = JSON.stringify([...blastRadiusIndex(a)]);
  assert(ia === JSON.stringify([...blastRadiusIndex(b)]) && ia === JSON.stringify([...blastRadiusIndex(c)]), 'blastRadiusIndex is independent of input order (sorted keys)');
  assert([...blastRadiusIndex(a).keys()].join() === [...blastRadiusIndex(a).keys()].sort().join(), 'the index iterates node keys sorted');
  assert(blastRadiusIndex(a).size === 12 && blastRadiusIndex(a).get('scrape:checkout').slos === 1 && blastRadiusIndex(a).get('route:sev1').total === 2,
         'the index carries one summary per non-scaffold node', blastRadiusIndex(a).size);
}

// (g) unknown key -> null
assert(blastRadiusOf(chain(), 'no:such') === null && blastRadiusOf(chain(), null) === null && blastRadiusOf(chain(), 42) === null && blastRadiusOf({}, 'x') === null,
       'an unknown or non-string key yields null');

// (h) the listing cap
{
  const shape = { nodes: [N('slo:big', 'slo'), N('sli:big', 'sli')], edges: [E('slo:big', 'sli:big', 'sli_of')] };
  for (let i = 0; i < 100; i++) {
    shape.nodes.push(N(`panel:${String(i).padStart(3, '0')}`, 'panel', `Panel ${String(i).padStart(3, '0')}`));
    shape.edges.push(E(`panel:${String(i).padStart(3, '0')}`, 'slo:big', 'visualises'));
  }
  const r = blastRadiusOf(shape, 'sli:big');
  assert(r.blinded.total === 101 && r.blinded.byKind.panel === 100 && r.summary.panels === 100 && r.summary.total === 101, 'totals and byKind are uncapped', [r.blinded.total, r.blinded.byKind.panel]);
  assert(r.blinded.nodes.length === 64 && r.blinded.nodes[0].key === 'slo:big' && r.blinded.nodes[1].label === 'Panel 000' && r.blinded.nodes[63].label === 'Panel 062',
         'blinded.nodes lists the first 64 after sorting hop -> kind -> label', [r.blinded.nodes.length, r.blinded.nodes[63].label]);
  assert(r.blinded.weight === 38, 'weight covers all 101 nodes (3 + 100 * 0.35)', r.blinded.weight, 38);
}

// (i) normalizeGraphShape accepts Map / object / array, drops broken edges
{
  const asArray = chain();
  const asMap = { nodes: new Map(chainNodes().map((n) => [n.key, n])), edges: chainEdges() };
  const asObject = { nodes: Object.fromEntries(chainNodes().map((n) => [n.key, n])), edges: chainEdges() };
  const want = JSON.stringify(blastRadiusOf(asArray, 'scrape:checkout'));
  assert(want === JSON.stringify(blastRadiusOf(asMap, 'scrape:checkout')) && want === JSON.stringify(blastRadiusOf(asObject, 'scrape:checkout')),
         'array, Map and keyed-object node inputs are equivalent');
  const keyless = { nodes: { 'slo:k': { kind: 'slo', label: 'keyed by map key' }, 'sli:k': { kind: 'sli' } }, edges: [E('slo:k', 'sli:k', 'sli_of')] };
  const nk = normalizeGraphShape(keyless);
  assert(nk.nodes.get('slo:k')?.key === 'slo:k' && nk.nodes.get('sli:k')?.label === 'sli:k' && nk.nodes.get('sli:k')?.identityKey === 'sli:k',
         'a keyed object supplies the key; label and identityKey fall back to it', [...nk.nodes.values()]);
  assert(blastRadiusOf(keyless, 'sli:k').summary.slos === 1, 'keyed-object input traverses');
  const broken = normalizeGraphShape({
    nodes: [N('a', 'slo'), N('b', 'sli'), { key: 'nokind' }, { kind: 'panel' }, null, 'junk'],
    edges: [E('a', 'b', 'sli_of'), { from: 'a', to: 'b' }, { from: 'a', type: 'sli_of' }, { to: 'b', type: 'sli_of' }, null, E('a', 'ghost', 'sli_of')],
  });
  assert(broken.nodes.size === 2 && broken.edges.length === 2, 'nodes without key or kind and edges lacking from/to/type are dropped', [broken.nodes.size, broken.edges.length]);
  assert(blastRadiusOf(broken, 'b').blinded.total === 1, 'an edge to an unknown node is ignored during traversal');
  const already = normalizeGraphShape(normalizeGraphShape(chain()));
  assert(already.nodes.size === 12 && already.edges.length === 11 && already.nodes.get('metric:latency').virtual === true, 'normalizeGraphShape is idempotent');
  assert(normalizeGraphShape(null).nodes.size === 0 && normalizeGraphShape(undefined).edges.length === 0 && normalizeGraphShape({ nodes: 7, edges: 'x' }).nodes.size === 0,
         'garbage input normalizes to an empty shape');
  const passthrough = normalizeGraphShape({ nodes: [N('a', 'slo')], edges: [{ key: 'k', from: 'a', to: 'a', type: 'sli_of', provenance: 'inferred' }] });
  assert(passthrough.edges[0].key === 'k' && passthrough.edges[0].provenance === 'inferred', 'edge key and provenance pass through');
}

// unknown edge types carry no direction; weights can be overridden
{
  const shape = chain();
  shape.edges.push({ from: 'route:sev1', to: 'dash:checkout', type: 'mystery' });
  assert(blastRadiusOf(shape, 'dash:checkout').blinded.total === 0 && blastRadiusOf(shape, 'route:sev1').blinded.total === 0, 'an edge type outside the table is ignored');
  const r = blastRadiusOf(chain(), 'slo:latency', { weights: { burn_rate: 10, forecast: 0 } });
  assert(r.blinded.weight === 10 + 0 + 1 + 1 + 1, 'weights merge over the defaults (alert 10, forecast 0, chaos 1, route 1, remediation 1)', r.blinded.weight, 13);
  const unknown = blastRadiusOf({ nodes: [N('x', 'slo'), N('y', 'widget')], edges: [E('y', 'x', 'visualises')] }, 'x');
  assert(unknown.blinded.weight === 0.5 && unknown.blinded.nodes[0].kind === 'widget', 'an unknown kind weighs 0.5 and lists after the known kinds', unknown.blinded);
}

// --- purity: inputs untouched ---
{
  const shape = chain();
  const before = JSON.stringify(shape);
  blastRadiusOf(shape, 'scrape:checkout'); blastRadiusIndex(shape); normalizeGraphShape(shape);
  assert(JSON.stringify(shape) === before, 'the helpers never mutate the input shape');
}

report('blast-radius', 'all blast-radius assertions pass.');
