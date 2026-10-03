#!/usr/bin/env node
/**
 * tools/test-service-keys.mjs
 *
 * The service rules the server and the studio share (tools/lib/service-keys.mjs,
 * STORE_PLAN slice 4 §8). Every function is a move: the reference copies below
 * are the originals as they stood in server/index.mjs (`serviceMetadata`,
 * `uploadedMeta` + `catalogEntryForUpload`) and studio/app.mjs (the catalogue
 * loop) before the move, kept here verbatim so the module is pinned to the
 * behaviour a 0.5.0 build had — on the real example and reference packs, not
 * only on hand-made entries. A rule change must change these copies too, on
 * purpose, in the same commit.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHarness } from './lib/harness.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { listEnvironments } from './lib/adapter.mjs';
import {
  normalizeServiceKey, serviceMetadata, serviceNamesForPack, primaryServiceName, serviceKeyForPack,
  isLiveAggregatePack, servicesForPack, catalogEntryOf,
} from './lib/service-keys.mjs';

const { assert, report } = createHarness({ indent: '  ', truncate: 240 });
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);   // key order included: the JSON the API serves

// ---------- browser-safety: the module imports nothing ----------
// Comments stripped first: the header may NAME what the code must not touch.
const source = readFileSync(join(ROOT, 'tools/lib/service-keys.mjs'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');
assert(!/^\s*import\b/m.test(source) && !/\bimport\s*\(/.test(source), 'service-keys.mjs has no import at all (static or dynamic)');
assert(!/\bnode:/.test(source) && !/\bprocess\.env\b/.test(source) && !/\brequire\s*\(/.test(source),
  'service-keys.mjs touches no node: API, process.env or require');
assert(/^export function (normalizeServiceKey|serviceMetadata|serviceNamesForPack|primaryServiceName|serviceKeyForPack|isLiveAggregatePack|servicesForPack|catalogEntryOf)\(/m.test(source),
  'the module exports plain functions');

// ---------- normalizeServiceKey ----------
for (const [input, want] of [
  ['Checkout', 'checkout'],
  ['  payment service  ', 'payment-service'],
  ['payment_service', 'payment-service'],
  ['Payments/API v2', 'payments-api-v2'],
  ['--odd--', 'odd'],
  ['café Ñandú', 'caf-and'],            // non-ASCII letters are not [a-z0-9]: runs collapse to one '-'
  ['!!!', ''],
  ['', ''],
  [null, ''],
  [undefined, ''],
  [42, '42'],
]) assert(normalizeServiceKey(input) === want, `normalizeServiceKey(${JSON.stringify(input)}) → ${JSON.stringify(want)}`, normalizeServiceKey(input), want);

// ---------- serviceMetadata, byte-equal to the server's copy on every example and reference pack ----------
// server/index.mjs before the move, verbatim.
function serviceMetadataBefore(canonical) {
  const bindings = canonical?.metadata?.bindings || {};
  const annotations = canonical?.metadata?.annotations || {};
  const services = new Set();
  const add = (value) => {
    for (const part of String(value || '').split(',')) {
      const service = part.trim();
      if (service) services.add(service);
    }
  };
  add(bindings.service);
  add(bindings.namespace);
  add(annotations['mcp.servicesDiscovered']);
  add(annotations['observogram.services']);
  add(annotations['tomograph.services']);
  return {
    service: bindings.service || canonical?.metadata?.name || '',
    namespace: bindings.namespace || bindings.service || canonical?.metadata?.name || '',
    services: [...services].sort(),
  };
}

const packFiles = [];
for (const dir of ['examples', 'reference-packs']) {
  for (const f of readdirSync(join(ROOT, dir)).filter(f => f.endsWith('.pack.yaml')).sort()) packFiles.push(`${dir}/${f}`);
}
assert(packFiles.length >= 4, `found the example and reference packs (${packFiles.length})`, packFiles.length);
const canonicals = new Map(packFiles.map(rel => [rel, parseYaml(readFileSync(join(ROOT, rel), 'utf8'))]));
for (const [rel, c] of canonicals) {
  assert(same(serviceMetadata(c), serviceMetadataBefore(c)), `serviceMetadata byte-equal to the server's copy on ${rel}`, serviceMetadata(c), serviceMetadataBefore(c));
}
// The hand-made shapes the examples do not cover: annotations split on ',', trimmed, deduped, sorted; the fallbacks.
const annotated = {
  metadata: {
    name: 'gateway', bindings: { service: 'edge', namespace: 'web' },
    annotations: { 'mcp.servicesDiscovered': ' checkout, payments ,edge', 'observogram.services': 'ledger', 'tomograph.services': 'payments,,' },
  },
};
assert(same(serviceMetadata(annotated), { service: 'edge', namespace: 'web', services: ['checkout', 'edge', 'ledger', 'payments', 'web'] }),
  'serviceMetadata: bindings + three annotations, split on commas, trimmed, deduped, sorted', serviceMetadata(annotated));
assert(same(serviceMetadata(annotated), serviceMetadataBefore(annotated)), 'serviceMetadata byte-equal to the server\'s copy on the annotated shape');
assert(same(serviceMetadata({ metadata: { name: 'solo' } }), { service: 'solo', namespace: 'solo', services: [] }),
  'serviceMetadata: no bindings → service and namespace fall back to the name, services empty');
assert(same(serviceMetadata({ metadata: { bindings: { service: 'api' } } }), { service: 'api', namespace: 'api', services: ['api'] }),
  'serviceMetadata: namespace falls back to the service binding');
assert(same(serviceMetadata(null), { service: '', namespace: '', services: [] }), 'serviceMetadata(null) → empty strings, no services');
assert(same(serviceMetadata({}), serviceMetadataBefore({})), 'serviceMetadata({}) byte-equal to the server\'s copy');

// ---------- the studio's rules on a table of catalogue entries ----------
const plain = { id: 'uploaded-checkout-abc', label: 'Checkout', name: 'checkout', service: 'checkout', namespace: 'shop', services: ['checkout', 'shop'], description: 'Uploaded pack — checkout.pack.yaml', source: 'uploaded', ok: true };
const nsOnly = { id: 'ns-1', label: 'Orders', name: 'orders', service: 'orders', namespace: 'commerce', services: ['commerce', 'orders'], ok: true };
const aggregate = { id: 'uploaded-production-live-1', label: 'production-live (live MCP draft)', name: 'production-live', description: 'Uploaded pack — draft-from-mcp', source: 'uploaded', service: 'production-live', namespace: 'production-live', services: ['checkout', 'payments', 'production-live'], ok: true };
const aggregateSelf = { id: 'agg-2', label: 'Platform (live)', name: 'platform', service: 'platform', namespace: 'platform', services: ['platform', 'platform', 'ledger'], ok: true };
const repeatsPrimary = { id: 'p-3', label: 'Ledger', name: 'ledger', service: 'Ledger', namespace: 'ledger', services: ['ledger', 'LEDGER', 'audit'], ok: true };
const junk = { id: 'j-4', label: '!!!', name: '', service: '', namespace: '', services: ['???', ' '], ok: true };
const long = { id: 'l-5', label: 'x'.repeat(201), name: '', service: '', namespace: '', services: ['y'.repeat(200), 'z'.repeat(201)], ok: true };
const nameless = { id: 'uploaded-pack-deadbeef', label: 'uploaded-pack-deadbeef', name: undefined, service: '', namespace: '', services: [], description: 'Uploaded pack — upload', source: 'uploaded', ok: true };
const mcpHint = { id: 'uploaded-notes-1', label: 'Notes', name: 'notes', service: 'notes', namespace: 'notes', services: ['notes'], description: 'Uploaded pack — mcp-notes.yaml', source: 'uploaded', ok: true };

assert(same(serviceNamesForPack(plain), ['checkout', 'shop']), 'serviceNamesForPack: service, namespace, name, services[] as spelt, deduped', serviceNamesForPack(plain));
assert(same(serviceNamesForPack(repeatsPrimary), ['Ledger', 'ledger', 'LEDGER', 'audit']), 'serviceNamesForPack dedupes as spelt, not by key', serviceNamesForPack(repeatsPrimary));
assert(same(serviceNamesForPack(junk), ['???']), 'serviceNamesForPack keeps junk names (keys are the caller\'s business), drops blanks and never reads the label', serviceNamesForPack(junk), ['???']);
assert(same(serviceNamesForPack(null), []), 'serviceNamesForPack(null) → []');

assert(primaryServiceName(plain) === 'checkout', 'primaryServiceName: the service binding first');
assert(primaryServiceName({ namespace: ' ns ', name: 'n', label: 'l' }) === 'ns', 'primaryServiceName: then the namespace, trimmed');
assert(primaryServiceName({ name: 'n', label: 'l' }) === 'n', 'primaryServiceName: then the name');
assert(primaryServiceName({ label: 'Just a label' }) === 'Just a label', 'primaryServiceName: then the label');
assert(primaryServiceName({}) === '' && primaryServiceName(undefined) === '', 'primaryServiceName: nothing → \'\'');
assert(serviceKeyForPack({ label: 'Just a label' }) === 'just-a-label', 'serviceKeyForPack = normalizeServiceKey(primaryServiceName)');

for (const [entry, want, why] of [
  [plain, false, 'a plain pack'],
  [aggregate, true, 'a live MCP draft (label, description and source all say so)'],
  [{ id: 'x', label: 'Checkout live' }, true, 'the word live in the label'],
  [{ id: 'x', description: 'Uploaded pack — mcp-notes.yaml' }, true, 'an mcp word in the description (a ?source= hint)'],
  [{ id: 'x', name: 'production-live' }, true, 'production-live as a name'],
  [{ id: 'x', source: 'draft-from-mcp' }, true, 'draft-from-mcp as a source'],
  [{ id: 'x', label: 'Alive and Olivemcp' }, false, 'the words only on word boundaries (alive, olivemcp are not matches)'],
  [{ id: 'mcp-gateway', label: 'Gateway' }, true, 'a service literally named mcp-gateway is an aggregate (verbatim regex; documented, not fixed)'],
  [null, false, 'nothing'],
]) assert(isLiveAggregatePack(entry) === want, `isLiveAggregatePack: ${why} → ${want}`);

// servicesForPack — the catalogue loop of studio/app.mjs serviceCatalogue(), verbatim, so the module's
// plan is pinned to the tiles a 0.5.0 studio drew (keys and roles) for every entry of the table.
function catalogueKeysBefore(p) {
  const keys = [];
  const add = (name) => {
    const key = normalizeServiceKey(name);
    if (!key) return;
    if (!keys.includes(key)) keys.push(key);
  };
  const aggregate = isLiveAggregatePack(p);
  const primaryKey = serviceKeyForPack(p);
  if (!aggregate) add(primaryServiceName(p));
  for (const svc of p.services || []) {
    if (aggregate && normalizeServiceKey(svc) === primaryKey) continue;
    add(svc);
  }
  return keys;
}
for (const [entry, want, why] of [
  [plain, [{ name: 'checkout', key: 'checkout', role: 'primary' }, { name: 'shop', key: 'shop', role: 'member' }], 'a plain pack: primary = service, the namespace a member'],
  [nsOnly, [{ name: 'orders', key: 'orders', role: 'primary' }, { name: 'commerce', key: 'commerce', role: 'member' }], 'a namespace pack: the namespace is a member'],
  [aggregate, [{ name: 'checkout', key: 'checkout', role: 'member' }, { name: 'payments', key: 'payments', role: 'member' }], 'a live aggregate: no primary, its own name skipped, two members'],
  [aggregateSelf, [{ name: 'ledger', key: 'ledger', role: 'member' }], 'an aggregate whose services[] repeats its own name: skipped'],
  [repeatsPrimary, [{ name: 'Ledger', key: 'ledger', role: 'primary' }, { name: 'audit', key: 'audit', role: 'member' }], 'a non-aggregate whose services[] repeats the primary (any case): one primary, no member for it'],
  [junk, [], 'junk names → nothing (\'!!!\' normalises to \'\')'],
  [long, [{ name: 'y'.repeat(200), key: 'y'.repeat(200), role: 'member' }], 'a 201-character primary and member dropped, a 200-character one kept'],
  [nameless, [{ name: 'uploaded-pack-deadbeef', key: 'uploaded-pack-deadbeef', role: 'primary' }], 'a pack with no name: its label (= its id) is the primary, as the studio does'],
  [mcpHint, [], 'a ?source=mcp-notes.yaml hint makes the pack an aggregate: no primary, and its one services[] entry is its own name → nothing'],
]) {
  const got = servicesForPack(entry);
  assert(same(got, want), `servicesForPack: ${why}`, got, want);
  const keys = got.map(s => s.key);
  const before = catalogueKeysBefore(entry).filter(k => k.length <= 200);
  assert(same(keys, before), `servicesForPack keys = the studio catalogue's keys for ${entry.id}`, keys, before);
  assert(got.filter(s => s.role === 'primary').length <= 1, `servicesForPack: at most one primary for ${entry.id}`);
}
assert(same(servicesForPack(null), []), 'servicesForPack(null) → []');

// ---------- catalogEntryOf, byte-equal to today's GET /api/packs entry for an uploaded pack ----------
// server/index.mjs before the move, verbatim: uploadedMeta()'s label/description composed into catalogEntryForUpload().
function catalogEntryForUploadBefore(id, upl) {
  const meta = {
    label: upl.label || upl.canonical?.metadata?.name || id,
    description: `Uploaded pack — ${upl.source}`,
  };
  const c = upl.canonical;
  const svc = serviceMetadataBefore(c);
  return {
    id,
    label: meta.label,
    description: meta.description,
    name: c?.metadata?.name,
    version: c?.metadata?.version,
    binding: c?.metadata?.binding,
    criticality: c?.metadata?.bindings?.criticality,
    service: svc.service,
    namespace: svc.namespace,
    services: svc.services,
    environments: listEnvironments(c),
    source: 'uploaded',
    ok: true,
  };
}
const demo = canonicals.get('examples/demo-skeleton.pack.yaml');
const namelessCanonical = { apiVersion: 'observability.pack/v1', kind: 'ObservabilityPack', metadata: { version: '0.0.1' }, spec: { environments: { prod: {} } } };
const records = [
  ['a label and a source', 'uploaded-demo-1', { label: 'Demo (scanned)', source: 'Demo (scanned)' }, demo],
  ['a null label (an upload) → the pack\'s name', 'uploaded-demo-2', { label: null, source: 'demo-skeleton.pack.yaml' }, demo],
  ['no label and no name → the id', 'uploaded-pack-3', { label: null, source: 'upload' }, namelessCanonical],
  ['a source hint with an mcp word (the entry is an aggregate in both)', 'uploaded-demo-4', { label: null, source: 'mcp-notes.yaml' }, demo],
  ['the default source (\'upload\') when the record has none', 'uploaded-demo-5', {}, demo],
];
for (const [why, id, rec, canonical] of records) {
  const want = catalogEntryForUploadBefore(id, { label: rec.label ?? null, source: rec.source ?? 'upload', canonical });
  const got = catalogEntryOf(id, rec, canonical, listEnvironments(canonical));
  assert(same(got, want), `catalogEntryOf byte-equal to catalogEntryForUpload: ${why}`, got, want);
}
for (const [rel, c] of canonicals) {
  const id = `uploaded-${rel.replace(/[^a-z0-9]+/gi, '-')}`;
  const want = catalogEntryForUploadBefore(id, { label: null, source: rel, canonical: c });
  assert(same(catalogEntryOf(id, { source: rel }, c, listEnvironments(c)), want), `catalogEntryOf byte-equal to catalogEntryForUpload on ${rel}`);
}
assert(catalogEntryOf('x', { label: null, source: 'mcp-notes.yaml' }, demo, []).description === 'Uploaded pack — mcp-notes.yaml'
  && isLiveAggregatePack(catalogEntryOf('x', { label: null, source: 'mcp-notes.yaml' }, demo, [])),
  'a ?source=mcp-notes.yaml hint reaches the description, and the entry is an aggregate — in the rows and the tiles alike');
assert(same(catalogEntryOf('uploaded-pack-3', { label: null }, namelessCanonical, []).environments, []), 'catalogEntryOf takes environments from the caller (none passed → [])');
assert(catalogEntryOf('uploaded-pack-3', { label: null, source: 'upload' }, namelessCanonical, []).label === 'uploaded-pack-3'
  && servicesForPack(catalogEntryOf('uploaded-pack-3', { label: null, source: 'upload' }, namelessCanonical, []))[0]?.key === 'uploaded-pack-3',
  'a pack with no name gets primary = its id in the rows, as the studio does with the tile');

report('service-keys', 'all service-keys assertions pass.');
