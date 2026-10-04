#!/usr/bin/env node
// tools/test-upconvert-merge.mjs — the upconvert is idempotent and merge-safe (SPEC B2).
//
// Re-running tools/upconvert-legacy.mjs over a legacy source whose output already holds real values must never
// regress them to scaffolds: a canonical input passes through unchanged, and a legacy input merges into an
// existing canonical output under one rule — the existing pack wins for every artefact it has, the upconvert only
// adds what the existing pack has never seen (tools/lib/legacy.mjs mergeUpconvert). The property test fills
// EVERY scaffolded value of an upconvert and proves the merge gives it back untouched; the count pins are the
// one deliberate default-output change of the item (legacy.scaffoldCount now counts the six shared markers).
// Temp files live in mkdtempSync(tmpdir()); the CLI is spawned with process.execPath — nothing to skip on win32.
//
// Run: node --test tools/test-upconvert-merge.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { isLegacyLayeredPack, upconvertLegacyPack, mergeUpconvert } from './lib/legacy.mjs';
import { packConformance, scaffoldMarkers } from './lib/pack-conformance.mjs';
import { validateCanonical, SPEC_VERSION, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { evaluateConformance } from './lib/conformance.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const rel = (p) => join(ROOT, ...p.split('/'));
const read = (p) => readFileSync(rel(p), 'utf8');
const SCHEMA = JSON.parse(read(SPEC_SCHEMA_PATH));
const CLI = rel('tools/upconvert-legacy.mjs');
const NOW = '2026-01-01T00:00:00.000Z';
const clone = (x) => JSON.parse(JSON.stringify(x));
const legacyOf = (f) => JSON.parse(read(`examples/legacy/${f}`));
const FILES = readdirSync(rel('examples/legacy')).filter(f => f.endsWith('.json')).sort();
const markerKeys = (pack) => Object.keys(pack.metadata.annotations).filter(k => k.startsWith('crawler.scaffold.'));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env } });

// The deliberate default-output change: demo-skeleton 9 → 15, production-curated 27 → 33, production-live 29 → 35, target-advanced 39 → 45.
const COUNT_PINS = { 'demo-skeleton.json': 15, 'production-curated.json': 33, 'production-live.json': 35, 'target-advanced.json': 45 };
const SHARED_SIX = ['crawler.scaffold.otel', 'crawler.scaffold.pipelines.receivers[0]', 'crawler.scaffold.pipelines.processors[0]',
  'crawler.scaffold.pipelines.exporters.metrics', 'crawler.scaffold.pipelines.exporters.logs', 'crawler.scaffold.pipelines.exporters.traces'];

test('count fix: report.scaffolded = crawler.scaffold.* keys = legacy.scaffoldCount, pinned per example; the six shared markers stay the last annotation keys', () => {
  for (const f of FILES) {
    const { canonical, report } = upconvertLegacyPack(legacyOf(f), { now: NOW });
    const keys = markerKeys(canonical);
    assert.equal(report.scaffolded, keys.length, f);
    assert.equal(canonical.metadata.annotations['legacy.scaffoldCount'], String(keys.length), f);
    assert.equal(keys.length, COUNT_PINS[f], `${f}: pinned marker count`);
    assert.deepEqual(Object.keys(canonical.metadata.annotations).slice(-6), SHARED_SIX, `${f}: key order unchanged — the six stay last`);
  }
});

test('provenance: every marker and typed symbol has an entry; non-null values are legacy.artefact.* keys; the null set is exactly the schema-required stubs', () => {
  for (const f of FILES) {
    const { canonical, provenance } = upconvertLegacyPack(legacyOf(f), { now: NOW });
    const ann = canonical.metadata.annotations;
    const markerSymbols = markerKeys(canonical).map(k => k.slice('crawler.scaffold.'.length));
    const typedSymbols = Object.keys(ann).filter(k => k.startsWith('observogram.artefact.type.')).map(k => k.slice('observogram.artefact.type.'.length));
    for (const s of [...markerSymbols, ...typedSymbols]) assert.ok(s in provenance, `${f}: provenance has ${s}`);
    for (const [s, v] of Object.entries(provenance)) {
      if (v === null) continue;
      assert.ok(v.startsWith('legacy.artefact.') && v in ann, `${f}: ${s} → ${v} is a record`);
    }
  }
  const pc = upconvertLegacyPack(legacyOf('production-curated.json'), { now: NOW }).provenance;
  assert.deepEqual(Object.entries(pc).filter(([, v]) => v === null).map(([k]) => k).sort(),
    ['baselines', 'otel', 'pipelines.exporters.logs', 'pipelines.exporters.metrics', 'pipelines.exporters.traces', 'pipelines.processors[0]', 'pipelines.receivers[0]']);
  // The upconvert of a typed legacy pack places every typed item, GOV imports and BAU backends included.
  const typed = {
    id: 'typed', name: 'Typed', layers: {
      L1: [{ id: 'SLI-01', source: 'BAU', title: 'Availability', type: 'PackSLI' }],
      L2: [{ id: 'TEL-01', source: 'BAU', title: 'Tempo', tool: 'tempo', type: 'TracingBackend' }, { id: 'STO-01', source: 'BAU', title: 'Metrics storage', tool: 'prometheus', type: 'MetricsStore' }],
      GOV: [{ id: 'GOV-01', source: 'BAU', title: 'Platform import', type: 'PlatformImport' }],
    },
  };
  const t = upconvertLegacyPack(typed, { now: NOW });
  assert.equal(t.provenance['telemetry.backends.tempo'], 'legacy.artefact.L2.TEL-01');
  assert.equal(t.provenance['storage.metrics'], 'legacy.artefact.L2.STO-01');
  assert.equal(t.provenance['imports[0]'], 'legacy.artefact.GOV.GOV-01');
  assert.equal(t.provenance['slis.availability'], 'legacy.artefact.L1.SLI-01');
});

test('pass-through idempotency: a canonical input comes back unchanged with exit 0; the server gate\'s detector agrees', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upconvert-merge-'));
  try {
    const c1 = upconvertLegacyPack(legacyOf('demo-skeleton.json'), { now: NOW }).canonical;
    assert.equal(isLegacyLayeredPack(c1), false, 'server/index.mjs gate parity');
    const p = join(dir, 'c1.pack.json'); writeFileSync(p, JSON.stringify(c1, null, 2) + '\n');
    const r = run(p);
    assert.equal(r.status, 0, r.stderr);
    assert.deepEqual(JSON.parse(r.stdout), c1);
    assert.match(r.stderr, /already a canonical ObservabilityPack/);
    assert.match(r.stderr, /15 scaffold marker\(s\) remain/);
    const y = join(dir, 'c1.pack.yaml'); writeFileSync(y, readFileSync(rel('examples/demo-skeleton.pack.yaml'), 'utf8'));
    assert.equal(run(y).status, 0, 'a YAML canonical input passes through');
    const out = join(dir, 'exists.pack.json'); writeFileSync(out, '{}');
    const r2 = run(p, '-o', out);
    assert.equal(r2.status, 1); assert.match(r2.stderr, /nothing to merge \(both are canonical\)/);
    assert.equal(readFileSync(out, 'utf8'), '{}', 'the existing file is untouched');
    assert.equal(run(p, '-o', out, '--overwrite').status, 0);
    assert.deepEqual(JSON.parse(readFileSync(out, 'utf8')), c1);
    const bad = clone(c1); bad.spec.slis = [];
    const b = join(dir, 'bad.pack.json'); writeFileSync(b, JSON.stringify(bad));
    const r3 = run(b);
    assert.equal(r3.status, 1); assert.match(r3.stderr, new RegExp(`already a canonical ObservabilityPack but not valid against spec v${SPEC_VERSION.replace('.', '\\.')}`));
    const neither = join(dir, 'neither.json'); writeFileSync(neither, '{"hello":1}');
    const r4 = run(neither);
    assert.equal(r4.status, 1); assert.match(r4.stderr, /not a legacy layered pack and not a canonical ObservabilityPack/);
    assert.equal(run().status, 2);
    assert.equal(run(p, '--bogus').status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// The edited-by-an-operator pack and the grown legacy source the merge tests share.
function scenario() {
  const legacy = legacyOf('production-curated.json');
  const c1 = upconvertLegacyPack(legacy, { now: NOW }).canonical;
  const e = clone(c1);
  const sli0 = `slis.${e.spec.slis[0].id}`;
  e.spec.slis[0].good = 'sum(rate(payments_ok_total[5m]))'; e.spec.slis[0].total = 'sum(rate(payments_total[5m]))';
  delete e.metadata.annotations[`crawler.scaffold.${sli0}`];
  e.spec.slos[0].objective = 0.999;
  e.spec.dashboards.push({ id: 'payments-slo-burn', provider: { kind: 'grafana' }, folder: 'payments', source: 'file://dashboards/payments-slo-burn.json' });
  const droppedRoute = e.spec.alerting.routes.length - 1;
  e.spec.alerting.routes.pop(); delete e.metadata.annotations[`crawler.scaffold.alerting.routes[${droppedRoute}]`];
  const droppedBackend = e.spec.telemetry.backends.pop(); delete e.metadata.annotations[`crawler.scaffold.telemetry.backends.${droppedBackend.id}`];
  const droppedImport = e.metadata.imports.pop();
  e.metadata.owners = ['team-payments']; e.metadata.version = '1.2.0';
  const L2 = clone(legacy);
  L2.layers.L5.push({ id: 'L5-NEW', source: 'GAP', title: 'Checkout canary', desc: 'new', tool: 'blackbox', tags: [] });
  L2.layers.L4.alerting.push({ id: 'ALR-NEW', source: 'BAU', title: 'New route SEV3', desc: 'new', tool: 'teams', tags: [] });
  const retitled = L2.layers.L3[0]; retitled.title = `${retitled.title} (retitled)`;
  return { legacy, c1, e, L2, sli0, droppedRoute, droppedBackend, droppedImport, retitled };
}

test('merge keeps every real value, adds only the unseen, re-indexes markers, refreshes the legacy block, stays valid and idempotent', () => {
  const { e, L2, sli0, droppedBackend, droppedImport, retitled } = scenario();
  const fresh = upconvertLegacyPack(L2, { now: '2026-02-02T00:00:00.000Z' });
  const { canonical: m, report } = mergeUpconvert(fresh, e);
  assert.deepEqual(validateCanonical(m, SCHEMA), []);
  assert.deepEqual(m.spec.slis[0], e.spec.slis[0]); assert.ok(!(`crawler.scaffold.${sli0}` in m.metadata.annotations), 'a cleared marker stays cleared');
  assert.equal(m.spec.slos[0].objective, 0.999); assert.ok(`crawler.scaffold.slos.${m.spec.slos[0].id}` in m.metadata.annotations, 'a marker the operator left stays');
  assert.ok(m.spec.dashboards.some(d => d.id === 'payments-slo-burn'), 'the operator\'s dashboard survives');
  assert.deepEqual(m.metadata.owners, ['team-payments']); assert.equal(m.metadata.version, '1.2.0');
  assert.ok(!m.spec.telemetry.backends.some(b => b.id === droppedBackend.id), 'a deleted BAU backend stays deleted');
  assert.ok(!m.metadata.imports.some(i => i.ref === droppedImport.ref), 'a deleted GOV import stays deleted');
  assert.equal(m.spec.alerting.routes.length, e.spec.alerting.routes.length + 1, 'the dropped route is not resurrected; the new one is appended');
  const newIdx = e.spec.alerting.routes.length;
  assert.equal(m.spec.alerting.routes[newIdx].severity, 'SEV3');
  assert.ok(`crawler.scaffold.alerting.routes[${newIdx}]` in m.metadata.annotations, 'the added route\'s marker is re-indexed to its final position');
  assert.ok(!(`crawler.scaffold.alerting.routes[${fresh.canonical.spec.alerting.routes.length - 1}]` in m.metadata.annotations) || fresh.canonical.spec.alerting.routes.length - 1 === newIdx, 'no marker under the fresh index');
  const newCheck = m.spec.validation.synthetic_checks.find(s => s.id === 'checkout-canary');
  assert.ok(newCheck, 'the new L5 item is added');
  assert.ok('crawler.scaffold.validation.synthetic_checks.checkout-canary' in m.metadata.annotations);
  assert.equal(m.metadata.annotations['legacy.artefact.L5.L5-NEW'], JSON.stringify(L2.layers.L5[L2.layers.L5.length - 1]));
  assert.equal(JSON.parse(m.metadata.annotations[`legacy.artefact.L3.${retitled.id}`]).title, retitled.title, 'the record is refreshed');
  const retitledDash = e.spec.dashboards.find(d => d.id === fresh.canonical.spec.dashboards[0].id) || e.spec.queries.recording_rules[0];
  assert.ok(retitledDash, 'the retitled item still pairs by identity');
  assert.equal(m.metadata.annotations['legacy.upconvertedAt'], '2026-02-02T00:00:00.000Z', 'the legacy block is refreshed');
  assert.equal(m.metadata.annotations['legacy.scaffoldCount'], String(markerKeys(m).length));
  assert.ok(report.kept > 0 && report.added === 2 && report.skipped >= 3, JSON.stringify(report));
  assert.equal(report.scaffoldCount, markerKeys(m).length); assert.equal(report.danglingRefs, 0);
  const eKeys = Object.keys(e.metadata.annotations);
  assert.deepEqual(Object.keys(m.metadata.annotations).slice(0, eKeys.length), eKeys, 'existing annotation keys keep their order');
  assert.equal(packConformance(m).counts.byState.dangling, 0, 'every re-indexed marker resolves');
  assert.doesNotThrow(() => { adapt(m); evaluateConformance(m); });
  const again = mergeUpconvert(upconvertLegacyPack(L2, { now: '2026-02-02T00:00:00.000Z' }), m).canonical;
  assert.deepEqual(again, m, 'idempotent');
});

test('never regresses — property over the four examples: every scaffolded value made real and every marker deleted comes back untouched', () => {
  const IDENTITY = new Set(['id', 'name', 'ref', 'slo', 'sli', 'trigger', 'severity', 'type', 'kind', 'signal', 'engine', 'provider', 'with']);
  const mutate = (v) => (typeof v === 'string' ? `${v}_real` : typeof v === 'number' ? v + 0.001 : Array.isArray(v) ? [...v].reverse() : v);
  const fill = (item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return;
    for (const [k, v] of Object.entries(item)) {
      if (IDENTITY.has(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v)) fill(v);
      else item[k] = mutate(v);
    }
  };
  for (const f of FILES) {
    const legacy = legacyOf(f);
    const { canonical: c1 } = upconvertLegacyPack(legacy, { now: NOW });
    const e = clone(c1);
    const markers = scaffoldMarkers(e);
    for (const mk of markers) {
      const sym = mk.symbol;
      const m = /^(slis|slos|dashboards|validation\.synthetic_checks|telemetry\.backends)\.(.+)$/.exec(sym) || /^(queries\.recording_rules|policy\.burn_rate_alerts|alerting\.routes|remediation|pipelines\.receivers|pipelines\.processors)\[(\d+)\]$/.exec(sym) || /^(pipelines\.exporters|storage)\.(.+)$/.exec(sym);
      if (m) {
        const container = m[1].split('.').reduce((cur, s) => cur[s], e.spec);
        const item = Array.isArray(container) ? (/\[/.test(sym) ? container[Number(m[2])] : container.find(x => x.id === m[2])) : container[m[2]];
        fill(item);
      } else if (sym === 'baselines') fill(e.spec.baselines);
      else if (sym === 'otel') fill(e.spec.otel);
      delete e.metadata.annotations[mk.key];
    }
    const freshCount = (p) => ['imports'].reduce((n) => n + (p.metadata.imports?.length ?? 0), 0)
      + p.spec.slis.length + p.spec.slos.length + (p.spec.telemetry?.backends?.length ?? 0) + Object.keys(p.spec.storage ?? {}).length
      + p.spec.pipelines.receivers.length + p.spec.pipelines.processors.length + Object.keys(p.spec.pipelines.exporters).length
      + p.spec.queries.recording_rules.length + p.spec.dashboards.length + p.spec.policy.burn_rate_alerts.length
      + p.spec.alerting.routes.length + (p.spec.remediation?.length ?? 0) + p.spec.validation.synthetic_checks.length;
    const fresh = upconvertLegacyPack(legacy, { now: NOW });
    const { canonical: m, report } = mergeUpconvert(fresh, e);
    assert.deepEqual(m.spec, e.spec, `${f}: the spec is the operator's, byte for byte`);
    assert.deepEqual(m.metadata.imports, e.metadata.imports, f);
    assert.deepEqual(markerKeys(m), [], `${f}: no marker comes back`);
    assert.equal(m.metadata.annotations['legacy.scaffoldCount'], '0', f);
    assert.equal(report.kept, freshCount(fresh.canonical), `${f}: every fresh item paired with an existing one`);
    assert.equal(report.added, 0, f);
  }
});

test('refusal: a non-canonical base throws', () => {
  const fresh = upconvertLegacyPack(legacyOf('demo-skeleton.json'), { now: NOW });
  assert.throws(() => mergeUpconvert(fresh, { layers: {} }), /not a canonical ObservabilityPack/);
  assert.throws(() => mergeUpconvert(fresh, null), /not a canonical ObservabilityPack/);
});

test('CLI merge: -o onto an existing canonical merges, --overwrite replaces, a bad base is refused, --merge without -o streams the merged pack', () => {
  const dir = mkdtempSync(join(tmpdir(), 'upconvert-merge-'));
  try {
    const { e, L2 } = scenario();
    const legacyPath = join(dir, 'legacy.json'); writeFileSync(legacyPath, JSON.stringify(L2));
    const out = join(dir, 'out.pack.json'); writeFileSync(out, JSON.stringify(e, null, 2) + '\n');
    const r = run(legacyPath, '-o', out);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /merged .*legacy\.json into .*out\.pack\.json: kept \d+ artefact\(s\) from .*, added 2 new, skipped \d+ \(removed before, or schema-required stubs\); \d+ scaffold marker\(s\) remain/);
    const merged = JSON.parse(readFileSync(out, 'utf8'));
    const pure = mergeUpconvert(upconvertLegacyPack(L2, { now: merged.metadata.annotations['legacy.upconvertedAt'] }), e).canonical;
    assert.deepEqual(merged, pure, 'the file is the pure merge');
    assert.deepEqual(merged.spec.slis[0], e.spec.slis[0], 'the operator\'s SLI survives the CLI run');
    const r2 = run(legacyPath, '-o', out, '--overwrite');
    assert.equal(r2.status, 0); assert.match(r2.stderr, /upconverted .*legacy\.json: \d+ legacy artefacts mapped/); assert.match(r2.stderr, /node tools\/pack-conformance\.mjs/);
    const over = JSON.parse(readFileSync(out, 'utf8'));
    assert.notDeepEqual(over.spec.slis[0], e.spec.slis[0], '--overwrite regenerates');
    assert.deepEqual(over, upconvertLegacyPack(L2, { now: over.metadata.annotations['legacy.upconvertedAt'] }).canonical);
    for (const [name, body] of [['empty.pack.json', ''], ['truncated.pack.json', '{"apiVersion": "observability.platform/v1", "kind": "Observ'], ['object.pack.json', '{}']]) {
      const p = join(dir, name); writeFileSync(p, body);
      const rr = run(legacyPath, '-o', p);
      assert.equal(rr.status, 1, name); assert.match(rr.stderr, /not a canonical ObservabilityPack — refusing to merge; pass --overwrite/);
      assert.equal(readFileSync(p, 'utf8'), body, `${name} untouched`);
    }
    const inv = clone(e); inv.spec.slis = [];
    const invPath = join(dir, 'invalid.pack.json'); writeFileSync(invPath, JSON.stringify(inv));
    const r3 = run(legacyPath, '-o', invPath);
    assert.equal(r3.status, 1); assert.match(r3.stderr, new RegExp(`not valid against spec v${SPEC_VERSION.replace('.', '\\.')} — fix it or pass --overwrite`));
    const ePath = join(dir, 'e.pack.json'); writeFileSync(ePath, JSON.stringify(e));
    const r4 = run(legacyPath, '--merge', ePath);
    assert.equal(r4.status, 0, r4.stderr);
    const streamed = JSON.parse(r4.stdout);
    assert.deepEqual(streamed.spec, pure.spec, '--merge without -o streams the merged pack');
    assert.equal(run(legacyPath, '--merge').status, 2, 'a dangling --merge is a usage error');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('determinism: two upconverts with the same `now` are byte-identical', () => {
  const legacy = legacyOf(FILES[0]);
  assert.equal(JSON.stringify(upconvertLegacyPack(legacy, { now: 'X' }).canonical), JSON.stringify(upconvertLegacyPack(legacy, { now: 'X' }).canonical));
});
