#!/usr/bin/env node
/**
 * tools/test-gen-site.mjs
 *
 * gen-site core regression suite (tools/lib/site/*) on the fixtures under tools/fixtures/site/:
 *   T1 merge (two files → one model; a duplicate queue manager within one environment → error,
 *      the same name in two environments → two queue managers; differing `pack:` strings are an
 *      error only when the caller did not choose the pack)
 *   T2 environment inheritance (host env → qm; disagreeing hosts → error naming both; a host
 *      without env in a file without env → error)
 *   T3 environment names (an env outside metadata.bindings.environments → error quoting the
 *      pack's list, both as an item env and as an environments.<env> block)
 *   T5 the CLI: --env all partitions prod and lab; --env omitted with two environments → exit 2
 *   T8 an anchor whose count differs fails naming the anchor
 *   timing: the §5.1 formulas at step 10 (lab) and step 30 (prod), dur(), the closed override
 *      vocabulary; derive: dropItem on block and flow items, splicePackSnippet; run(): the lab
 *      site pack is byte-identical to the fixture pack, prod carries the rebudgeted windows.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { loadInventories, mergeInventories, resolveEnvironments, validateInventory, inventorySchema } from './lib/site/inventory.mjs';
import { timing, dur, durM, readOverrides, OVERRIDE_KEYS } from './lib/site/timing.mjs';
import { derivePack, assertCounts, dropItem, splicePackSnippet, countMatches } from './lib/site/derive.mjs';
import { run, selectEnvironments } from './lib/site/run.mjs';
import * as lib from './lib/dashboards/lib.mjs';
import { packSnippet, compileBurnRules } from './lib/burn-rules.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FIX = resolve(ROOT, 'tools', 'fixtures', 'site');
const readFix = (f) => readFileSync(resolve(FIX, f), 'utf8');
const schema = JSON.parse(readFileSync(resolve(ROOT, 'vendor', 'observability-pack-spec', 'v1.2', 'observability-pack.schema.json'), 'utf8'));
const invSchema = JSON.parse(readFileSync(resolve(ROOT, 'tools', 'lib', 'site', 'inventory.schema.json'), 'utf8'));
const packText = readFix('fixture.pack.yaml');
const pack = parseYaml(packText);
const module = await import(pathToFileURL(resolve(FIX, 'module.mjs')).href);
const prodInv = readFix('prod.inventory.yaml');
const labInv = readFix('lab.inventory.yaml');
const files = (...docs) => docs.map((d, i) => ({ name: `f${i}`, doc: d }));
const loadAll = (inputs) => loadInventories(inputs, { schema: invSchema, module });

// ----------------------------------------------------------------- T1 merge
test('T1 merge: two inventory files become one model; file-level env stays with its file', () => {
  const l = loadAll([{ name: 'prod.inventory.yaml', text: prodInv }, { name: 'lab.inventory.yaml', text: labInv }]);
  assert.deepEqual(l.errors, []);
  const m = mergeInventories(l.files);
  assert.deepEqual(m.errors, []);
  assert.equal(m.inventory.hosts.length, 5);
  assert.equal(m.inventory.queue_managers.length, 3);
  assert.deepEqual(Object.keys(m.inventory.environments).sort(), ['lab', 'prod']);
  assert.equal(m.inventory.pack, 'fixture.pack.yaml');
  const qm1 = m.inventory.queue_managers.find(q => q.name === 'QM1');
  assert.deepEqual(qm1.source, { file: 'lab.inventory.yaml', env: 'lab' });
  assert.equal(qm1.env, undefined, 'the file env is not written into the item');
  const v = validateInventory(m.inventory, pack, { schema: invSchema, module });
  assert.deepEqual(v.errors, []);
  const { envs, errors } = resolveEnvironments(m.inventory, pack);
  assert.deepEqual(errors, []);
  assert.deepEqual(envs.prod.queue_managers.map(q => q.name), ['QMORD1', 'QMPAY1']);
  assert.deepEqual(envs.lab.queue_managers.map(q => q.name), ['QM1']);
  assert.equal(envs.prod.queue_managers[0].exporter_host, 'mon1.prod.internal', 'exporter_host defaults to params.monitoring_host');
  assert.equal(envs.prod.queue_managers[0].site, 'dc1');
});

test('T1 merge: a duplicate queue manager name within one environment is an error naming both files; the same name in two environments is two queue managers', () => {
  const block = { prod: { endpoints: { remote_write: 'http://x' }, params: { queue_pattern: 'x' } } };
  const a = { inventory: 'v1', env: 'prod', environments: block, queue_managers: [{ name: 'QM1', shape: 'host' }] };
  const b = { inventory: 'v1', env: 'prod', queue_managers: [{ name: 'QM1', shape: 'container' }] };
  const same = mergeInventories([{ name: 'a.yaml', doc: a }, { name: 'b.yaml', doc: b }]);
  assert.deepEqual(same.errors, [], 'the merge concatenates; the name check needs the resolved environments');
  const dup = resolveEnvironments(same.inventory, pack);
  assert.deepEqual(dup.errors, ['queue manager QM1 (b.yaml): also declared in a.yaml in environment prod']);
  assert.deepEqual(validateInventory(same.inventory, pack, { schema: invSchema, module }).errors, dup.errors);
  const twice = resolveEnvironments(mergeInventories(files({ ...a, queue_managers: [...a.queue_managers, ...b.queue_managers] })).inventory, pack);
  assert.deepEqual(twice.errors, ['queue manager QM1 (f0): declared twice in environment prod']);
  // a host name stays unique across the whole inventory (a host is a machine)
  const hosts = mergeInventories([{ name: 'a.yaml', doc: { inventory: 'v1', env: 'prod', hosts: [{ name: 'h' }] } }, { name: 'b.yaml', doc: { inventory: 'v1', env: 'lab', hosts: [{ name: 'h' }] } }]);
  assert.deepEqual(hosts.errors, ['b.yaml: host h is also declared in a.yaml']);
  // design §2.3: QM1 in prod and QM1 in lab are different queue managers, rendered in two partitions
  const prodQm1 = prodInv.replace('name: QMPAY1', 'name: QM1');
  const r = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [{ name: 'prod.inventory.yaml', text: prodQm1 }, { name: 'lab.inventory.yaml', text: labInv }], env: 'all', module, lib });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(Object.keys(r.partitions).sort(), ['lab', 'prod']);
  assert.ok(r.partitions.prod.files.some(f => f.path === 'qmgrs/QM1/exporter.yaml') && r.partitions.lab.files.some(f => f.path === 'qmgrs/QM1/exporter.yaml'));
  assert.deepEqual(r.partitions.prod.manifest.queue_managers.map(q => q.name), ['QMORD1', 'QM1']);
});

test('T1 merge: inventories whose pack: strings differ are an error unless the caller chose the pack (--pack wins)', () => {
  const inv = [{ name: 'a/lab.inventory.yaml', text: labInv }, { name: 'b/prod.inventory.yaml', text: prodInv.replace('pack: fixture.pack.yaml', 'pack: ../a/fixture.pack.yaml') }];
  const l = loadAll(inv);
  assert.deepEqual(l.errors, []);
  assert.deepEqual(mergeInventories(l.files).errors, ['the inventories name different packs: fixture.pack.yaml, ../a/fixture.pack.yaml (pass --pack to choose)']);
  assert.deepEqual(mergeInventories(l.files, { packChosen: true }).errors, []);
  const refused = run({ pack, packText, schema, inventorySchema: invSchema, inventories: inv, env: 'all', module, lib });
  assert.match(refused.errors[0], /the inventories name different packs/); assert.deepEqual(refused.partitions, {});
  const chosen = run({ pack, packText, schema, inventorySchema: invSchema, inventories: inv, env: 'all', module, lib, packChosen: true });
  assert.deepEqual(chosen.errors, []);
  assert.deepEqual(Object.keys(chosen.partitions).sort(), ['lab', 'prod']);
});

test('T1 merge: the same environments key in two files must be deep-equal', () => {
  const env = { endpoints: { remote_write: 'http://x' } };
  const ok = mergeInventories(files({ inventory: 'v1', environments: { prod: env } }, { inventory: 'v1', environments: { prod: { ...env } } }));
  assert.deepEqual(ok.errors, []);
  const bad = mergeInventories(files({ inventory: 'v1', environments: { prod: env } }, { inventory: 'v1', environments: { prod: { endpoints: { remote_write: 'http://y' } } } }));
  assert.match(bad.errors[0], /environments\.prod is also declared in f0 with different content/);
});

// ----------------------------------------------------------------- T2 inheritance
test('T2 inheritance: a queue manager without env takes the unique env of its hosts, before the file env', () => {
  const doc = { inventory: 'v1', env: 'lab', environments: { prod: {}, lab: {} }, hosts: [{ name: 'h1', env: 'prod' }, { name: 'h2', env: 'prod' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1', 'h2'] }] };
  const { envs, errors } = resolveEnvironments(mergeInventories(files(doc)).inventory, pack);
  assert.deepEqual(errors, []);
  assert.equal(envs.prod.queue_managers[0].env, 'prod');
  assert.equal(envs.lab, undefined);
});

test('T2 inheritance: hosts that disagree on env are an error naming both hosts', () => {
  const doc = { inventory: 'v1', environments: { prod: {}, lab: {} }, hosts: [{ name: 'h1', env: 'prod' }, { name: 'h2', env: 'lab' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1', 'h2'] }] };
  const { errors } = resolveEnvironments(mergeInventories(files(doc)).inventory, pack);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /queue manager Q \(f0\): its hosts disagree on env: h1=prod, h2=lab/);
});

test('T2 inheritance: qm.env that differs from its hosts env is an error', () => {
  const doc = { inventory: 'v1', environments: { prod: {}, lab: {} }, hosts: [{ name: 'h1', env: 'prod' }], queue_managers: [{ name: 'Q', env: 'lab', shape: 'host', hosts: ['h1'] }] };
  const { errors } = resolveEnvironments(mergeInventories(files(doc)).inventory, pack);
  assert.match(errors[0], /queue manager Q \(f0\): env lab differs from its hosts' env prod \(h1\)/);
});

test('T2 inheritance: a host without env in a file without env is an error naming the host', () => {
  const doc = { inventory: 'v1', environments: { prod: {} }, hosts: [{ name: 'orphan' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['orphan'] }] };
  const { errors } = resolveEnvironments(mergeInventories(files(doc)).inventory, pack);
  assert.ok(errors.some(e => /host orphan \(f0\): no env and its file declares none/.test(e)), errors.join('\n'));
  assert.ok(errors.some(e => /queue manager Q \(f0\): no env, no hosts with an env, and its file declares none/.test(e)), errors.join('\n'));
});

// ----------------------------------------------------------------- T3 names
test('T3 names: an environment outside metadata.bindings.environments is an error quoting the pack list', () => {
  const doc = { inventory: 'v1', env: 'uat', environments: { uat: { endpoints: { remote_write: 'http://x' } } }, hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1'] }] };
  const v = validateInventory(mergeInventories(files(doc)).inventory, pack, { schema: invSchema, module });
  assert.ok(v.errors.some(e => e === "environment uat: not in the pack's metadata.bindings.environments [prod, lab]"), v.errors.join('\n'));
});

test('T3 names: an environments.<env> block alone is checked against the pack list too', () => {
  const doc = { inventory: 'v1', env: 'lab', environments: { lab: {}, uat: {} }, hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'container', hosts: ['h1'] }] };
  const v = validateInventory(mergeInventories(files(doc)).inventory, pack, { schema: invSchema, module });
  assert.ok(v.errors.some(e => /environment uat: not in the pack's metadata\.bindings\.environments \[prod, lab\]/.test(e)), v.errors.join('\n'));
});

test('T3 names: a queue manager env without an environments.<env> block is an error; a pack without spec.environments.<env> is a warning (error under strict)', () => {
  const doc = { inventory: 'v1', env: 'prod', hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1'] }] };
  const v = validateInventory(mergeInventories(files(doc)).inventory, pack, { schema: invSchema, module });
  assert.ok(v.errors.some(e => /environment prod: no environments\.prod block in the inventory/.test(e)), v.errors.join('\n'));
  const packNoEnv = { ...pack, spec: { ...pack.spec, environments: {} } };
  const ok = { inventory: 'v1', env: 'lab', environments: { lab: { endpoints: { remote_write: 'http://x' }, params: { queue_pattern: 'APP.*' } } }, hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'container', hosts: ['h1'] }] };
  const w = validateInventory(mergeInventories(files(ok)).inventory, packNoEnv, { schema: invSchema, module });
  assert.deepEqual(w.errors, []);
  assert.match(w.warnings[0], /environment lab: the pack has no spec\.environments\.lab/);
  const s = validateInventory(mergeInventories(files(ok)).inventory, packNoEnv, { schema: invSchema, module, strict: true });
  assert.match(s.errors[0], /no spec\.environments\.lab/);
});

test('T3 names: an environment with only a host needs its environments.<env> block too (it is selected and rendered)', () => {
  const hostOnly = labInv.replace('  - { name: mq, site: lab, roles: [container] }\n', '  - { name: mq, site: lab, roles: [container] }\n  - { name: mon1.prod.internal, env: prod, roles: [monitoring] }\n');
  assert.ok(/^hosts:\n {2}- \{ name: mq.*\n {2}- \{ name: mon1/m.test(hostOnly), 'the host lands in hosts[]');
  const l = loadAll([{ name: 'lab.inventory.yaml', text: hostOnly }]);
  assert.deepEqual(l.errors, []);
  const v = validateInventory(mergeInventories(l.files).inventory, pack, { schema: invSchema, module });
  assert.deepEqual(v.errors, ['environment prod: no environments.prod block in the inventory (endpoints are required to emit anything)']);
  const r = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [{ name: 'lab.inventory.yaml', text: hostOnly }], env: 'all', module, lib });
  assert.deepEqual(r.errors, v.errors); assert.deepEqual(r.partitions, {});
  // with the block, the host-only environment renders (no queue managers, a real params block)
  const withBlock = hostOnly.replace('environments:\n', 'environments:\n  prod:\n    endpoints: { remote_write: https://mimir.prod.internal/api/v1/push }\n    params: { queue_pattern: "ORD\\\\..*" }\n');
  const ok = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [{ name: 'lab.inventory.yaml', text: withBlock }], env: 'all', module, lib });
  assert.deepEqual(ok.errors, []);
  assert.deepEqual(ok.partitions.prod.manifest.queue_managers, []); assert.equal(ok.partitions.prod.manifest.hosts.length, 1);
  assert.ok(ok.partitions.prod.files.find(f => f.path === 'packs/fixture.pack.yaml').content.includes('queue=~"ORD\\..*"'), 'no queue=~"undefined"');
});

// ----------------------------------------------------------------- schema + semantics
test('schema: module params are spliced in and unknown keys are rejected; core semantic checks fire', () => {
  const s = inventorySchema(invSchema, module);
  assert.equal(s.$defs.siteParams, module.paramsSchema.site);
  assert.equal(inventorySchema(invSchema).$defs.siteParams.type, 'object');
  const bad = loadAll([{ name: 'bad.yaml', doc: { inventory: 'v1', env: 'lab', environments: { lab: { params: { queue_pattern: 'x', typo: 1 } } }, queue_managers: [{ name: 'Q', shape: 'blob', params: { client_port: 'nope' } }] } }]);
  assert.ok(bad.errors.some(e => /environments\.lab\.params: unknown property 'typo'/.test(e)), bad.errors.join('\n'));
  assert.ok(bad.errors.some(e => /queue_managers\[0\]\.shape: not in enum/.test(e)), bad.errors.join('\n'));
  assert.ok(bad.errors.some(e => /client_port: expected integer/.test(e)), bad.errors.join('\n'));
  const notV1 = loadAll([{ name: 'v0.yaml', doc: { inventory: 'v0' } }]);
  assert.match(notV1.errors[0], /inventory: "v0" is not "v1"/);

  const sem = { inventory: 'v1', env: 'prod', environments: { prod: { vantage: 'dual', profile: 'non-container', endpoints: { remote_write: 'http://x' }, params: { queue_pattern: 'x', monitoring_host: 'mon' } } },
    hosts: [{ name: 'h1' }, { name: 'h2' }],
    queue_managers: [
      { name: 'HA', shape: 'rdqm-ha', hosts: ['h1', 'h2'], params: { native_port: 9157, client_port: 9161 } },
      { name: 'A', shape: 'host', hosts: ['h1'], address: { host: 'h1', port: 1414 }, params: { native_port: 9157, client_port: 9161 } },
      { name: 'B', shape: 'host', hosts: ['h2'], address: { host: 'h1', port: 1415 } },
    ] };
  const v = validateInventory(mergeInventories(files(sem)).inventory, pack, { schema: invSchema, module });
  const has = (re) => assert.ok(v.errors.some(e => re.test(e)), `expected ${re}\n${v.errors.join('\n')}`);
  has(/queue manager HA \(f0\): shape rdqm-ha needs at least 3 hosts, has 2/);
  has(/queue manager HA \(f0\): shape rdqm-ha needs an address/);
  has(/queue manager B \(f0\): environment prod is vantage dual with profile non-container, so params\.native_port is required/);
  has(/queue manager B \(f0\): address\.host h1 is also used by queue manager A in environment prod/);
  has(/queue manager A \(f0\): client_port 9161 on exporter host mon is also used by queue manager HA/);
  has(/queue manager A \(f0\): native_port 9157 on host h1 is also used by queue manager HA/);
});

test('semantics: client_port is unique per exporter host across environments; without an exporter host it is scoped to the environment', () => {
  const file = (env, host, qm, monitoring_host) => ({ inventory: 'v1', env, environments: { [env]: { endpoints: { remote_write: 'http://x' }, params: { queue_pattern: 'x', ...(monitoring_host ? { monitoring_host } : {}) } } },
    hosts: [{ name: host }], queue_managers: [{ name: qm, shape: 'host', hosts: [host], address: { host, port: 1414 }, params: { client_port: 9161 } }] });
  const shared = validateInventory(mergeInventories(files(file('prod', 'hp', 'A', 'mon'), file('lab', 'hl', 'B', 'mon'))).inventory, pack, { schema: invSchema, module });
  assert.deepEqual(shared.errors, ['queue manager B (f1): client_port 9161 on exporter host mon is also used by queue manager A']);
  const separate = validateInventory(mergeInventories(files(file('prod', 'hp', 'A', 'mon-prod'), file('lab', 'hl', 'B', 'mon-lab'))).inventory, pack, { schema: invSchema, module });
  assert.deepEqual(separate.errors, []);
  const unknown = validateInventory(mergeInventories(files(file('prod', 'hp', 'A'), file('lab', 'hl', 'B'))).inventory, pack, { schema: invSchema, module });
  assert.deepEqual(unknown.errors, [], 'no exporter host known: the port collides only within one environment');
  const unknownSameEnv = validateInventory(mergeInventories(files({ ...file('prod', 'hp', 'A'), queue_managers: [...file('prod', 'hp', 'A').queue_managers, ...file('prod', 'hp', 'B').queue_managers] })).inventory, pack, { schema: invSchema, module });
  assert.ok(unknownSameEnv.errors.some(e => /queue manager B \(f0\): client_port 9161 on exporter host \(no exporter_host\) is also used by queue manager A/.test(e)), unknownSameEnv.errors.join('\n'));
});

test('adapter: a registry goes through toInventory() and the same checks', () => {
  const adapter = { toInventory: (raw) => ({ inventory: 'v1', env: 'lab', environments: { lab: { endpoints: { remote_write: raw.rw }, params: { queue_pattern: 'APP.*' } } }, hosts: raw.rows.map(r => ({ name: r.host })), queue_managers: raw.rows.map(r => ({ name: r.qmgr, shape: 'container', hosts: [r.host] })) }) };
  const l = loadInventories([], { schema: invSchema, module, adapter, registry: JSON.stringify({ rw: 'http://x', rows: [{ host: 'mq', qmgr: 'QM1' }] }) });
  assert.deepEqual(l.errors, []);
  assert.equal(l.files[0].name, 'registry (adapter)');
  const broken = loadInventories([], { schema: invSchema, module, adapter: { toInventory: () => ({ inventory: 'v1', hosts: 'nope' }) }, registry: '{}' });
  assert.ok(broken.errors.some(e => /registry \(adapter\): \$\.hosts: expected array/.test(e)), broken.errors.join('\n'));
  const noAdapter = loadInventories([], { schema: invSchema, registry: '{}' });
  assert.match(noAdapter.errors[0], /an adapter exporting toInventory\(raw\) is required/);
});

test('schema: an omitted params block is validated as {} so a module\'s required site/host/instance params fire; run() exits with an error and writes no file', () => {
  // the fixture module requires site.queue_pattern; a scratch module also requires a host and an instance param
  const strictModule = { ...module, paramsSchema: { ...module.paramsSchema,
    host: { type: 'object', required: ['rack'], additionalProperties: false, properties: { rack: { type: 'string' } } },
    instance: { ...module.paramsSchema.instance, required: ['client_port'] } } };
  const withQm = { inventory: 'v1', env: 'prod', environments: { prod: { endpoints: { remote_write: 'http://x' } } },
    hosts: [{ name: 'h1' }], queue_managers: [{ name: 'Q', shape: 'host', hosts: ['h1'], address: { host: 'h1', port: 1414 } }] };
  const v = validateInventory(mergeInventories(files(withQm)).inventory, pack, { schema: invSchema, module: strictModule });
  assert.deepEqual(v.errors, [
    "inventory: $.environments.prod.params: missing required key 'queue_pattern'",
    "inventory: $.hosts[0].params: missing required key 'rack'",
    "inventory: $.queue_managers[0].params: missing required key 'client_port'",
  ]);
  // written as {} the schema pass reports the same three, once each
  const empty = { ...withQm, environments: { prod: { ...withQm.environments.prod, params: {} } }, hosts: [{ name: 'h1', params: {} }], queue_managers: [{ ...withQm.queue_managers[0], params: {} }] };
  assert.deepEqual(validateInventory(mergeInventories(files(empty)).inventory, pack, { schema: invSchema, module: strictModule }).errors, v.errors);
  // a host-only environment whose block has no params is checked too; a block without members is not rendered and is left alone
  const hostOnly = { inventory: 'v1', env: 'prod', environments: { prod: { endpoints: { remote_write: 'http://x' } }, lab: { endpoints: { remote_write: 'http://y' } } }, hosts: [{ name: 'h1' }] };
  assert.deepEqual(validateInventory(mergeInventories(files(hostOnly)).inventory, pack, { schema: invSchema, module }).errors, ["inventory: $.environments.prod.params: missing required key 'queue_pattern'"]);
  // with the params present nothing new fires, and without a module the placeholders stay permissive
  assert.deepEqual(validateInventory(mergeInventories(files({ ...withQm, environments: { prod: { ...withQm.environments.prod, params: { queue_pattern: 'x' } } } })).inventory, pack, { schema: invSchema, module }).errors, []);
  assert.deepEqual(validateInventory(mergeInventories(files(withQm)).inventory, pack, { schema: invSchema }).errors, []);
  // end to end: the run stops before rendering, so no emitted file carries an undefined param
  const r = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [{ name: 'x.yaml', doc: withQm }], env: 'prod', module, lib });
  assert.deepEqual(r.errors, ["inventory: $.environments.prod.params: missing required key 'queue_pattern'"]);
  assert.deepEqual(r.partitions, {});
});

// ----------------------------------------------------------------- timing
test('timing: the §5.1 formulas at step 10 (lab) reproduce the lab literals', () => {
  const t = timing(pack, 'lab', { scrape_interval: '10s', params: { exporter_poll_interval: '10s' } });
  assert.equal(t.step, 10); assert.equal(t.poll, 10); assert.equal(t.probe, 10);
  assert.equal(dur(t.window3), '30s'); assert.equal(dur(t.subq), '10s'); assert.equal(dur(t.gate), '1m');
  assert.equal(dur(t.canaryShort), '40s'); assert.equal(dur(t.canaryHung), '120s'); assert.equal(durM(t.canaryHung), '2m');
  assert.equal(dur(t.keepFiring), '1m'); assert.equal(dur(t.interval), '10s'); assert.equal(dur(t.timeInterval), '10s');
  assert.equal(t.scrapeTimeout, 8); assert.equal(t.evalScale, 1); assert.equal(t.lab, true); assert.equal(t.minBadSamples, 2);
  assert.equal(t.symptomFor('10s'), '10s'); assert.equal(t.symptomFor('5m'), '5m');
  assert.deepEqual(t.alertmanager, { group_wait: '5s', group_wait_sev1: '2s', group_interval: '10s', repeat_interval: '1h', resolve_timeout: '1m' });
  assert.deepEqual(t.passthrough, { 'storage.metrics.retention': '2d' });
  assert.equal(t.rebudgetMttd('60s', '10s'), 60);
});

test('timing: step 30 (prod overrides) rebudgets every window and honours the declared for:', () => {
  const t = timing(pack, 'prod', { scrape_interval: null, params: { exporter_poll_interval: '30s' } });
  assert.equal(t.step, 30, 'step from overrides[prometheus.scrape_interval] when the inventory is silent');
  assert.equal(t.poll, 30); assert.equal(t.probe, 30);
  assert.equal(dur(t.window3), '90s'); assert.equal(dur(t.subq), '30s'); assert.equal(dur(t.gate), '180s');
  assert.equal(dur(t.canaryShort), '120s'); assert.equal(dur(t.canaryHung), '360s'); assert.equal(dur(t.keepFiring), '180s');
  assert.equal(t.scrapeTimeout, 8); assert.equal(t.evalScale, 3); assert.equal(t.lab, false);
  assert.equal(t.symptomFor('10s'), '2m', 'max(literal, alerts.symptom.for) keeps the override spelling');
  assert.equal(t.symptomFor('5m'), '5m', 'a literal above the override stays');
  assert.deepEqual(t.burnFor, { short_5m: '2m', short_30m: '5m', short_1h: '10m' });
  assert.deepEqual(t.alertmanager, { group_wait: '30s', group_wait_sev1: '10s', group_interval: '5m', repeat_interval: '4h', resolve_timeout: '1m' });
  assert.equal(t.rebudgetMttd('60s', '10s'), 60 + (120 - 10) + (30 - 5) + 2 * 20);
  // the inventory's scrape_interval wins over the override; params.canary_interval sets the probe
  const t2 = timing(pack, 'prod', { scrape_interval: '15s', params: { canary_interval: '5s' } });
  assert.equal(t2.step, 15); assert.equal(t2.poll, 30, 'poll from overrides[exporter.poll_interval]'); assert.equal(t2.probe, 5);
  assert.equal(t2.alertmanager.resolve_timeout, '1m'); assert.equal(dur(t2.gate), '90s'); assert.equal(t2.scrapeTimeout, 8);
  assert.equal(timing(pack, 'prod', { scrape_interval: '5s' }).scrapeTimeout, 3);
  // no override, no inventory interval: the pack step
  assert.equal(timing(pack, 'lab', {}).step, 10);
  // assertBurnFor: the library's for: must equal the declared override of the short window's bucket
  const ok = [{ rules: [{ alert: 'a', for: '2m', labels: { window_short: '5m' } }, { alert: 'b', for: '5m', labels: { window_short: '30m' } }, { alert: 'c', for: '10m', labels: { window_short: '1h' } }, { record: 'r' }] }];
  assert.deepEqual(t.assertBurnFor(ok), []);
  const bad = t.assertBurnFor([{ rules: [{ alert: 'x_burn', for: '30s', labels: { window_short: '5m' } }] }]);
  assert.deepEqual(bad, ['burn-rate alert x_burn: emitted for: 30s, the pack declares alerts.burn_rate.for.short_5m: 2m for environment prod']);
  assert.deepEqual(timing(pack, 'lab', {}).assertBurnFor(bad.length ? [{ rules: [{ alert: 'x', for: '30s', labels: { window_short: '5m' } }] }] : []), [], 'nothing declared, nothing asserted');
});

test('timing: dur() prints 1m for 60 and Ns otherwise, passes override strings through; durM() prints whole minutes', () => {
  assert.equal(dur(60), '1m'); assert.equal(dur(30), '30s'); assert.equal(dur(120), '120s'); assert.equal(dur(0), '0s'); assert.equal(dur(2.5), '2.5s');
  assert.equal(dur('2m'), '2m'); assert.equal(dur('90s'), '90s');
  assert.equal(durM(120), '2m'); assert.equal(durM(90), '90s'); assert.equal(durM(60), '1m'); assert.equal(durM('5m'), '5m');
  assert.throws(() => dur(-1), /not a duration/);
  assert.throws(() => dur(null), /not a duration/);
});

test('timing: an unknown key under alerts.*, alertmanager.*, prometheus.* or exporter.* is an error; other keys pass through', () => {
  const p = { ...pack, spec: { ...pack.spec, environments: { prod: { overrides: { 'alerts.symptom.for': '2m', 'alerts.symptom.four': '3m', 'prometheus.retention': '1d', 'storage.metrics.retention': '13mo' } } } } };
  assert.throws(() => timing(p, 'prod', {}), (e) => {
    assert.match(e.message, /spec\.environments\.prod\.overrides: unknown keys alerts\.symptom\.four, prometheus\.retention/);
    assert.ok(OVERRIDE_KEYS.every(k => e.message.includes(k)), 'the message lists the closed vocabulary');
    return true;
  });
  const p2 = { ...pack, spec: { ...pack.spec, environments: { prod: { overrides: { 'storage.metrics.retention': '13mo', 'otel.sdk.sampling.ratio': 0.1 } } } } };
  assert.deepEqual(readOverrides(p2, 'prod'), { timing: {}, passthrough: { 'storage.metrics.retention': '13mo', 'otel.sdk.sampling.ratio': 0.1 } });
  assert.deepEqual(readOverrides(pack, 'nowhere'), { timing: {}, passthrough: {} });
});

// ----------------------------------------------------------------- derive
test('T8 counts: an anchor that matches a different number of times fails naming the anchor', () => {
  const extra = packText.replace('threshold: 0.8', 'threshold: 0.8 # [30s]');
  assert.equal(countMatches(extra, '[30s]'), 3);
  assert.throws(() => assertCounts(extra, [{ name: 'window3', find: '[30s]', replace: '[90s]', count: 2 }]), /^Error: anchor window3: expected 2 occurrences, found 3$/);
  const r = derivePack(extra, [{ name: 'window3', find: '[30s]', replace: '[90s]', count: 2 }], [], { schema });
  assert.equal(r.text, null);
  assert.deepEqual(r.errors, ['anchor window3: expected 2 occurrences, found 3']);
  assert.throws(() => assertCounts(packText, [{ find: /queue=~"[^"]*"/g, replace: 'x', count: 2 }]), /anchor \/queue=~"\[\^"\]\*"\/g: expected 2 occurrences, found 1/);
  assert.throws(() => assertCounts(packText, [{ name: 'nocount', find: 'x', replace: 'y' }]), /anchor nocount: count must be a non-negative integer/);
  // a RegExp anchor replaces with capture groups; a string anchor is literal
  const ok = derivePack(packText, [{ name: 're', find: /queue=~"([^"]*)"/g, replace: 'queue=~"X$1"', count: 1 }, { name: 'lit', find: 'targets: [mq:9157]', replace: 'targets: [mq:9157]', count: 1 }], [], { schema });
  assert.deepEqual(ok.errors, []);
  assert.ok(ok.text.includes('queue=~"XAPP.*"'));
  assert.deepEqual(ok.applied, [{ name: 're', count: 1, changed: true }, { name: 'lit', count: 1, changed: false }]);
  // a substitution that breaks the pack is a validation error, not a written file
  const broken = derivePack(packText, [{ name: 'kind', find: 'kind: ObservabilityPack', replace: 'kind: Nope', count: 1 }], [], { schema });
  assert.equal(broken.pack, null);
  assert.match(broken.errors[0], /derived pack: not a canonical ObservabilityPack/);
});

test('T8 counts: anchors are counted over the reference text, so an anchor an earlier one overlaps passes in every environment; a replacement that introduces text a later anchor matches fails', () => {
  assert.equal(countMatches(packText, 'scrape_interval: 10s'), 1); assert.equal(countMatches(packText, 'interval: 10s'), 3);
  const subs = (step) => [
    { name: 'pipeline scrape_interval', find: 'scrape_interval: 10s', replace: `scrape_interval: ${step}`, count: 1 },
    { name: 'recording interval', find: 'interval: 10s', replace: `interval: ${step}`, count: 3 },
  ];
  const lab = derivePack(packText, subs('10s'), [], { schema });
  assert.deepEqual(lab.errors, []); assert.equal(lab.text, packText);
  const prod = derivePack(packText, subs('30s'), [], { schema });
  assert.deepEqual(prod.errors, [], 'the running text has 2 left after scrape_interval was rewritten; the reference has 3');
  assert.equal(countMatches(prod.text, 'interval: 30s'), countMatches(packText, 'interval: 30s') + 3); assert.equal(countMatches(prod.text, 'interval: 10s'), 0);
  assert.deepEqual(prod.applied, [{ name: 'pipeline scrape_interval', count: 1, changed: true }, { name: 'recording interval', count: 3, changed: true }]);
  // a mismatch is still reported against the reference, whatever the order
  assert.deepEqual(derivePack(packText, [subs('30s')[1], { ...subs('30s')[0], count: 2 }], [], { schema }).errors, ['anchor pipeline scrape_interval: expected 2 occurrences, found 1']);
  // an earlier replacement that introduces text a later anchor matches is an error naming the later anchor
  const introduced = derivePack(packText, [{ name: 'kind', find: 'kind: ObservabilityPack', replace: 'kind: ObservabilityPack # interval: 10s', count: 1 }, subs('30s')[1]], [], { schema });
  assert.deepEqual(introduced.errors, ['anchor recording interval: an earlier substitution introduced text it matches (4 occurrences now, 3 in the reference)']);
  assert.equal(introduced.text, null);
});

test('derive: dropItem removes a block item with its nested lines and a flow item, everywhere it appears', () => {
  const text = [
    'slis:',
    '  # --- process alive ---',
    '  - id: qmgr_process_up',
    '    type: ratio',
    '    good: |',
    '      sum(up == bool 1)',
    '',
    '  - id: qmgr_process_up_99_9_not_this',
    '    type: ratio',
    'slos:',
    '  - { id: qmgr_process_up_99_9, sli: qmgr_process_up, objective: 0.999 }',
    '  - { id: other, sli: x, objective: 0.9 }',
    'dashboards:',
    '  - id: a',
    '    panel_bindings:',
    '      - { panel: p1, binds_to: slis.qmgr_process_up }',
    '      - { panel: p2, binds_to: slis.qmgr_process_up_extra }',
    '  - id: b',
    '    panel_bindings:',
    '      - { panel: p1, binds_to: slis.qmgr_process_up }',
    'policy:',
    '  burn_rate_alerts:',
    '    - slo: qmgr_process_up_99_9',
    '      windows:',
    '        - { short: 5m, long: 1h }',
    '    - slo: other',
    '      windows:',
    '        - { short: 5m, long: 1h }',
    '',
  ].join('\n');
  let t = dropItem(text, 'id', 'qmgr_process_up');
  assert.ok(!t.includes('sum(up == bool 1)'), 'the nested block went with the item');
  assert.ok(t.includes('- id: qmgr_process_up_99_9_not_this'), 'a longer id is not a match');
  assert.ok(t.includes('  # --- process alive ---'), 'comments above the item are kept');
  t = dropItem(t, 'id', 'qmgr_process_up_99_9');
  assert.ok(!t.includes('objective: 0.999') && t.includes('{ id: other'), 'flow item removed, sibling kept');
  t = dropItem(t, 'binds_to', 'slis.qmgr_process_up');
  assert.equal((t.match(/binds_to: slis\.qmgr_process_up\b/g) || []).filter(m => !/extra/.test(m)).length, 0);
  assert.ok(t.includes('binds_to: slis.qmgr_process_up_extra'), 'the key inside a flow item matches the whole value only');
  assert.equal((t.match(/panel_bindings:/g) || []).length, 2);
  t = dropItem(t, 'slo', 'qmgr_process_up_99_9');
  assert.ok(t.includes('- slo: other\n      windows:\n        - { short: 5m, long: 1h }'));
  assert.ok(!t.includes('- slo: qmgr_process_up_99_9'));
  assert.equal((t.match(/windows:/g) || []).length, 1, 'the nested windows of the dropped policy entry went with it');
  assert.throws(() => dropItem(t, 'id', 'qmgr_process_up'), /dropItem: no list item with id: qmgr_process_up/);
  const parsed = parseYaml(t);
  assert.deepEqual(parsed.slos, [{ id: 'other', sli: 'x', objective: 0.9 }]);
  assert.deepEqual(parsed.policy.burn_rate_alerts.map(b => b.slo), ['other']);
  assert.deepEqual(parsed.dashboards.map(d => (d.panel_bindings || []).length), [1, 0]);
});

test('derive: splicePackSnippet replaces the generated block and keeps the marker header', () => {
  const snippet = "      - name: fixture:errorbudget:burn_5m\n        expr: 'x'\n        interval: 30s\n        labels: { slo: s, sli: i, service: fixture }";
  const t = splicePackSnippet(packText, snippet);
  const p = parseYaml(t);
  assert.deepEqual(p.spec.queries.recording_rules.map(r => r.name), ['fixture:qmgr_up:ratio_5m', 'fixture:queue_depth_headroom:ratio', 'fixture:errorbudget:burn_5m']);
  assert.equal(p.spec.queries.recording_rules[2].expr, 'x');
  assert.ok(t.includes('# --- error-budget rules, GENERATED from spec.policy by gen-site ----\n      # fixture:errorbudget:burn_{5m,1h}{slo}'), 'the marker and its comment lines stay');
  assert.ok(t.includes('\n\n  dashboards:'), 'the blank line before the next section survives');
  assert.deepEqual(p.spec.dashboards, pack.spec.dashboards);
  // idempotent: splicing the block that is already there changes nothing
  const same = splicePackSnippet(packText, packSnippet(compileBurnRules(pack, { step: 10 }).recording));
  assert.equal(same, packText);
  // a snippet at a different indentation is re-indented to the list
  const dedented = splicePackSnippet(packText, snippet.replace(/^ {6}/gm, ''));
  assert.equal(dedented, t);
  // an empty generated block gets the snippet right after the marker comments
  const from = packText.indexOf('      - name: fixture:errorbudget:burn_5m'), to = packText.indexOf('\n  dashboards:');
  const empty = packText.slice(0, from) + packText.slice(to + 1);
  assert.ok(!empty.includes('- name: fixture:errorbudget') && empty.includes('\n  dashboards:'), 'fixture without generated rules');
  const filled = parseYaml(splicePackSnippet(empty, snippet));
  assert.equal(filled.spec.queries.recording_rules.length, 3);
  assert.throws(() => splicePackSnippet(packText.replace('error-budget rules, GENERATED', 'nothing'), snippet), /no comment line containing/);
});

// ----------------------------------------------------------------- run()
const inventories = [{ name: 'prod.inventory.yaml', text: prodInv }, { name: 'lab.inventory.yaml', text: labInv }];
const runAll = (extra = {}) => run({ pack, packText, schema, inventorySchema: invSchema, inventories, env: 'all', module, lib, ...extra });

test('run: the lab site pack is byte-identical to the reference; prod carries the rebudgeted windows and the declared for:', () => {
  const r = runAll();
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, []);
  assert.deepEqual(Object.keys(r.partitions).sort(), ['lab', 'prod']);
  const lab = r.partitions.lab, prod = r.partitions.prod;
  assert.equal(lab.files.find(f => f.path === 'packs/fixture.pack.yaml').content, packText);
  const prodPack = prod.files.find(f => f.path === 'packs/fixture.pack.yaml').content;
  assert.equal(countMatches(prodPack, '[90s]'), 2); assert.equal(countMatches(prodPack, '[30s]'), 0);
  assert.ok(prodPack.includes('scrape_interval: 30s') && prodPack.includes('queue=~"ORD\\..*|PAY\\..*"') && prodPack.includes('environment: prod'));
  assert.ok(prodPack.includes('[5m:30s]') && prodPack.includes('* 10)) / 0.001') && prodPack.includes('[1h:30s]'), 'the generated block is re-spliced at the site step');
  const burn = prod.files.find(f => f.path === 'prometheus/rules/fixture.burn.yml').content;
  const rules = parseYaml(burn).groups.flatMap(g => g.rules);
  assert.deepEqual(rules.filter(x => x.alert).map(x => x.for), ['2m', '5m']);
  assert.deepEqual(parseYaml(lab.files.find(f => f.path === 'prometheus/rules/fixture.burn.yml').content).groups.flatMap(g => g.rules).filter(x => x.alert).map(x => x.for), ['30s', '2m']);
  // the pack's snippet and the burn file agree (what check-rules compares)
  const prodRules = parseYaml(prodPack).spec.queries.recording_rules.filter(x => /errorbudget/.test(x.name));
  assert.deepEqual(prodRules.map(x => x.expr), rules.filter(x => x.record).map(x => x.expr));
  // templates, per-qmgr files, manifest
  assert.equal(prod.files.find(f => f.path === 'prometheus/prometheus.yml').content.split('\n')[2], '  scrape_interval: 30s');
  assert.ok(prod.files.some(f => f.path === 'qmgrs/QMORD1/exporter.yaml') && prod.files.some(f => f.path === 'qmgrs/QMPAY1/exporter.yaml'));
  assert.ok(prod.files.find(f => f.path === 'qmgrs/QMORD1/exporter.yaml').content.includes('connName: 10.20.5.11(1414)'));
  const m = JSON.parse(prod.files.find(f => f.path === 'site.json').content);
  assert.equal(m.environment, 'prod'); assert.equal(m.timing.step, 30); assert.equal(m.timing.rendered.window3, '90s');
  assert.deepEqual(m.queue_managers.map(q => q.name), ['QMORD1', 'QMPAY1']); assert.equal(m.hosts.length, 4);
  assert.equal(m.repo_url, 'https://github.com/example/fixture/blob/main');
  assert.deepEqual(m.harness, { vantage: 'dual', probe: 30 });
  assert.deepEqual(m.burn, { recording: 2, alerts: 2, forecasts: 0, minBadSamples: 2, lab: false, step: 30 });
  assert.ok(m.files.includes('packs/fixture.pack.yaml') && !m.files.includes('site.json'));
  assert.equal(prod.manifest, m === prod.manifest ? m : prod.manifest);
  assert.equal(r.fleet, null, 'no fleet hook in the fixture module');
});

test('run: environment selection, usage errors, module checks, strict warnings, no module', () => {
  assert.deepEqual(selectEnvironments({ prod: { queue_managers: [1], hosts: [] }, lab: { queue_managers: [1], hosts: [] } }, null), { selected: [], error: '--env is required: the inventory contains 2 environments (prod, lab); pass one of them or --env all', usage: true });
  assert.deepEqual(selectEnvironments({ prod: { queue_managers: [1], hosts: [] } }, null).selected, ['prod']);
  assert.equal(selectEnvironments({ prod: { queue_managers: [1], hosts: [] } }, 'lab').usage, true);
  let r = runAll({ env: null });
  assert.equal(r.usage, true); assert.match(r.errors[0], /--env is required/); assert.deepEqual(r.partitions, {});
  r = runAll({ env: 'prod' });
  assert.deepEqual(r.errors, []); assert.deepEqual(Object.keys(r.partitions), ['prod']);
  r = runAll({ inventories: [{ name: 'lab.inventory.yaml', text: labInv }], env: null });
  assert.deepEqual(r.errors, []); assert.deepEqual(r.selected, ['lab']);
  // a module self-check failure is an error and nothing is written for that environment
  r = runAll({ module: { ...module, checks: () => ['port 9157 collides'] } });
  assert.deepEqual(r.errors, ['prod: port 9157 collides', 'lab: port 9157 collides']);
  assert.deepEqual(r.partitions.prod.files, []);
  // warnings become errors under --strict
  r = runAll({ module: { ...module, checks: () => ({ warnings: ['delta estimator unverified at 30 s'] }) } });
  assert.deepEqual(r.errors, []); assert.deepEqual(r.warnings, ['prod: delta estimator unverified at 30 s', 'lab: delta estimator unverified at 30 s']);
  r = runAll({ strict: true, module: { ...module, checks: () => ({ warnings: ['delta estimator unverified at 30 s'] }) } });
  assert.deepEqual(r.errors, ['prod: (strict) delta estimator unverified at 30 s', 'lab: (strict) delta estimator unverified at 30 s']);
  // the burn for: assertion: a module that rewrites the prod overrides to disagree with the library fails
  const disagree = { ...pack, spec: { ...pack.spec, environments: { ...pack.spec.environments, prod: { overrides: { ...pack.spec.environments.prod.overrides, 'alerts.burn_rate.for.short_5m': '3m' } } } } };
  r = run({ pack: disagree, packText, schema, inventorySchema: invSchema, inventories, env: 'prod', module, lib });
  assert.match(r.errors[0], /prod: burn-rate alert qmgr_up_99_9_burn_14x_5m_1h: emitted for: 2m, the pack declares alerts\.burn_rate\.for\.short_5m: 3m/);
  // an unknown override key stops that environment only
  const unknown = { ...pack, spec: { ...pack.spec, environments: { ...pack.spec.environments, lab: { overrides: { 'alertmanager.group_wait.sev0': '1s' } } } } };
  r = run({ pack: unknown, packText, schema, inventorySchema: invSchema, inventories, env: 'all', module, lib });
  assert.equal(r.errors.length, 1); assert.match(r.errors[0], /^lab: spec\.environments\.lab\.overrides: unknown key alertmanager\.group_wait\.sev0/);
  // a bad file path from a module is refused
  r = runAll({ module: { ...module, templates: () => ({ '../escape.yml': 'x' }) } });
  assert.ok(r.errors.some(e => /file path "\.\.\/escape\.yml": must be relative/.test(e)), r.errors.join('\n'));
  r = runAll({ module: { ...module, templates: () => ({ 'site.json': 'x' }) } });
  assert.ok(r.errors.some(e => /file site\.json: emitted twice/.test(e)), r.errors.join('\n'));
  // no module: site pack, burn rules and manifest only; the site pack keeps the lab literals
  r = run({ pack, packText, schema, inventorySchema: invSchema, inventories: [{ name: 'lab.inventory.yaml', text: labInv }], env: 'lab', lib });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.partitions.lab.files.map(f => f.path), ['packs/fixture.pack.yaml', 'prometheus/rules/fixture.burn.yml', 'site.json']);
  assert.equal(r.partitions.lab.files[0].content, packText);
  // the fleet hook runs only with --env all and more than one environment
  const fleet = { ...module, fleet: (ctxs) => ({ 'alertmanager.fleet.yml': ctxs.map(c => c.env).join(',') + '\n' }) };
  r = runAll({ module: fleet });
  assert.deepEqual(r.fleet.files, [{ path: 'alertmanager.fleet.yml', content: 'prod,lab\n' }]);
  assert.equal(runAll({ module: fleet, env: 'prod' }).fleet, null);
  // an inventory error stops before any environment is rendered
  r = runAll({ inventories: [{ name: 'x.yaml', text: 'inventory: v1\nenv: uat\nqueue_managers: [{ name: Q, shape: host }]\n' }] });
  assert.ok(r.errors.some(e => /environment uat: not in the pack's metadata\.bindings\.environments \[prod, lab\]/.test(e)), r.errors.join('\n'));
  assert.deepEqual(r.partitions, {});
});

// ----------------------------------------------------------------- T5 the CLI
const CLI = resolve(ROOT, 'tools', 'gen-site.mjs');
const cli = (...args) => spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
const INV = ['--inventory', resolve(FIX, 'prod.inventory.yaml'), '--inventory', resolve(FIX, 'lab.inventory.yaml'), '--module', resolve(FIX, 'module.mjs')];

test('T5 CLI: --env all writes <out>/prod and <out>/lab and nothing else; --env omitted with two environments exits 2', () => {
  const out = mkdtempSync(join(tmpdir(), 'gen-site-'));
  try {
    const r = cli(...INV, '--env', 'all', '--out', out);
    assert.equal(r.status, 0, r.stderr + r.stdout);
    assert.deepEqual(readdirSync(out).sort(), ['lab', 'prod']);
    assert.equal(readFileSync(join(out, 'lab', 'packs', 'fixture.pack.yaml'), 'utf8'), packText);
    assert.ok(existsSync(join(out, 'prod', 'qmgrs', 'QMPAY1', 'exporter.yaml')));
    assert.ok(existsSync(join(out, 'prod', 'site.json')) && existsSync(join(out, 'prod', 'prometheus', 'rules', 'fixture.burn.yml')));
    assert.match(r.stdout, /^prod: 2 queue managers, 4 hosts, 7 files → /m);
    assert.match(r.stdout, /^lab: 1 queue manager, 1 host, 6 files → /m);
    const omitted = cli(...INV, '--out', out, '--check');
    assert.equal(omitted.status, 2, omitted.stderr);
    assert.match(omitted.stderr, /--env is required: the inventory contains 2 environments \(prod, lab\)/);
    const dry = cli(...INV, '--env', 'all', '--dry-run', '--out', join(out, 'never'));
    assert.equal(dry.status, 0, dry.stderr);
    assert.ok(!existsSync(join(out, 'never')), '--dry-run writes nothing');
    assert.match(dry.stdout, /^ {2}prod\/site\.json$/m); assert.match(dry.stdout, /^ {2}lab\/qmgrs\/QM1\/exporter\.yaml$/m); assert.match(dry.stdout, /dry run ok: prod, lab/);
    const check = cli(...INV, '--env', 'lab', '--check', '--strict', '--out', join(out, 'never'));
    assert.equal(check.status, 0, check.stderr); assert.match(check.stdout, /check ok: lab/); assert.ok(!existsSync(join(out, 'never')));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('T5 CLI: usage and validation exit codes', () => {
  assert.equal(cli().status, 2);
  assert.equal(cli('--inventory').status, 2);
  assert.equal(cli('--inventory', resolve(FIX, 'lab.inventory.yaml'), '--registry', 'x.json').status, 2, '--registry without --adapter');
  assert.equal(cli('--inventory', resolve(FIX, 'lab.inventory.yaml'), '--bogus', '1').status, 2);
  const missing = cli(...INV, '--env', 'staging', '--check');
  assert.equal(missing.status, 2); assert.match(missing.stderr, /--env staging: no host or queue manager/);
  // the pack comes from the inventory's pack: field, relative to the inventory file; --pack wins
  const explicit = cli('--inventory', resolve(FIX, 'lab.inventory.yaml'), '--pack', resolve(FIX, 'fixture.pack.yaml'), '--module', resolve(FIX, 'module.mjs'), '--check');
  assert.equal(explicit.status, 0, explicit.stderr);
  // a self-check failure is exit 1 with nothing written
  const out = mkdtempSync(join(tmpdir(), 'gen-site-'));
  try {
    // one inventory per directory: the pack: strings differ but name the same file; --pack wins, and
    // without --pack each is resolved relative to its own file
    mkdirSync(join(out, 'a')); mkdirSync(join(out, 'b'));
    writeFileSync(join(out, 'a', 'fixture.pack.yaml'), packText);
    writeFileSync(join(out, 'a', 'lab.inventory.yaml'), labInv);
    writeFileSync(join(out, 'b', 'prod.inventory.yaml'), prodInv.replace('pack: fixture.pack.yaml', 'pack: ../a/fixture.pack.yaml'));
    const twoDirs = ['--inventory', join(out, 'a', 'lab.inventory.yaml'), '--inventory', join(out, 'b', 'prod.inventory.yaml'), '--module', resolve(FIX, 'module.mjs'), '--env', 'all', '--check'];
    const withPack = cli(...twoDirs, '--pack', join(out, 'a', 'fixture.pack.yaml'));
    assert.equal(withPack.status, 0, withPack.stderr); assert.match(withPack.stdout, /check ok: lab, prod/);
    const resolved = cli(...twoDirs);
    assert.equal(resolved.status, 0, resolved.stderr); assert.match(resolved.stdout, /check ok: lab, prod/);
    writeFileSync(join(out, 'b', 'other.inventory.yaml'), [
      'inventory: v1', 'env: prod', 'pack: other.pack.yaml',
      'environments:', '  prod:', '    scrape_interval: 30s',
      '    endpoints: { remote_write: https://mimir.prod.internal/api/v1/push }',
      '    params: { queue_pattern: "ORD\\\\..*", monitoring_host: mon1.prod.internal, exporter_poll_interval: 30s }',
      'hosts:', '  - { name: mqpay2.prod.internal, site: dc2 }',
      'queue_managers:', '  - { name: QMPAY2, shape: host, hosts: [mqpay2.prod.internal], address: { host: mqpay2.prod.internal, port: 1415 }, params: { client_port: 9163 } }', '',
    ].join('\n'));
    const differ = cli('--inventory', join(out, 'a', 'lab.inventory.yaml'), '--inventory', join(out, 'b', 'other.inventory.yaml'), '--module', resolve(FIX, 'module.mjs'), '--env', 'all', '--check');
    assert.equal(differ.status, 2, differ.stderr); assert.match(differ.stderr, /the inventories name different packs \(.*fixture\.pack\.yaml, .*other\.pack\.yaml\): pass --pack/);
    const differChosen = cli('--inventory', join(out, 'a', 'lab.inventory.yaml'), '--inventory', join(out, 'b', 'other.inventory.yaml'), '--module', resolve(FIX, 'module.mjs'), '--env', 'all', '--check', '--pack', join(out, 'a', 'fixture.pack.yaml'));
    assert.equal(differChosen.status, 0, differChosen.stderr);
    const badInv = join(out, 'bad.inventory.yaml');
    writeFileSync(badInv, labInv.replace('client_port: 9157', 'client_port: 9157, typo: 1'));
    const r = cli('--inventory', badInv, '--pack', resolve(FIX, 'fixture.pack.yaml'), '--module', resolve(FIX, 'module.mjs'), '--out', join(out, 'sites'));
    assert.equal(r.status, 1, r.stderr); assert.match(r.stderr, /unknown property 'typo'/); assert.ok(!existsSync(join(out, 'sites')));
    const noPack = cli('--inventory', badInv, '--check');
    assert.equal(noPack.status, 2, 'the inventory names a pack that is not next to it');
    assert.match(noPack.stderr, /cannot read pack/);
  } finally { rmSync(out, { recursive: true, force: true }); }
});
