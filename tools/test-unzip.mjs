#!/usr/bin/env node
// tools/test-unzip.mjs — the ZIP reader a scan's upload uses
// (tools/lib/unzip.mjs): STORE and DEFLATE entries read back byte for byte
// (tools/lib/zip.mjs's own archives among them), the top folder named, the
// caller's file rule applied before anything is inflated, and every way an
// archive or an entry is refused, each with its sentence — a name that
// leaves the folder, encryption, another method, a header that lies about
// its size, a bad checksum, the caps, ZIP64, a split archive, not a ZIP.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { readZip, safeEntryPath, UNZIP_LIMITS, ZipRefusal } from './lib/unzip.mjs';
import { makeZip } from './lib/zip.mjs';

const enc = new TextEncoder();
const dec = new TextDecoder();

const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c >>> 0; } return t; })();
const crc32 = (b) => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };

// An archive built by hand, so a test can write what a real tool would not:
// each entry { name, data, method (0 | 8 | other), flags, size, crc } — size
// and crc default to the truth, and override it.
function buildZip(entries, { eocd = {} } = {}) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name);
    const data = typeof e.data === 'string' ? enc.encode(e.data) : e.data;
    const method = e.method ?? 8;
    const body = method === 8 ? new Uint8Array(deflateRawSync(data)) : data;
    const crc = e.crc ?? crc32(data);
    const size = e.size ?? data.length;
    const flags = (e.flags ?? 0) | 0x800;
    const local = new Uint8Array(30 + name.length + body.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint32(14, crc, true); lv.setUint32(18, body.length, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true);
    local.set(name, 30); local.set(body, 30 + name.length);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true); cv.setUint16(10, method, true);
    cv.setUint32(16, crc, true); cv.setUint32(20, body.length, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true); central.set(name, 46);
    locals.push(local); centrals.push(central);
    offset += local.length;
  }
  const cdSize = centrals.reduce((n, c) => n + c.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(4, eocd.disk ?? 0, true);
  ev.setUint16(8, entries.length, true); ev.setUint16(10, eocd.count ?? entries.length, true);
  ev.setUint32(12, cdSize, true); ev.setUint32(16, eocd.offset ?? offset, true);
  const out = new Uint8Array(offset + cdSize + 22);
  let at = 0;
  for (const p of [...locals, ...centrals, end]) { out.set(p, at); at += p.length; }
  return out;
}

const texts = (r) => Object.fromEntries(r.entries.map((e) => [e.path, dec.decode(e.bytes)]));

test('STORE and DEFLATE entries read back byte for byte, in the archive\'s order; the one top folder is named; folders are not entries; tools/lib/zip.mjs\'s own archives read', async () => {
  const rules = 'groups:\n  - name: shop\n    rules:\n      - alert: ShopDown\n        expr: up{job="shop"} == 0\n'.repeat(40);
  const r = await readZip(buildZip([
    { name: 'shop-main/', data: '', method: 0 },
    { name: 'shop-main/prometheus/rules.yaml', data: rules },
    { name: 'shop-main/README.md', data: '# shop\n', method: 0 },
    { name: 'shop-main\\otel\\collector.yaml', data: 'receivers: {}\n' },
  ]));
  assert.deepEqual(Object.keys(texts(r)), ['shop-main/prometheus/rules.yaml', 'shop-main/README.md', 'shop-main/otel/collector.yaml'], 'a backslash is a folder separator');
  assert.equal(texts(r)['shop-main/prometheus/rules.yaml'], rules);
  assert.deepEqual([r.root, r.skipped, r.ignored, r.truncated], ['shop-main', [], 0, false]);
  const own = await readZip(makeZip([{ name: 'a.yaml', data: 'x: 1\n' }, { name: 'dir/b.json', data: '{}' }]));
  assert.deepEqual(texts(own), { 'a.yaml': 'x: 1\n', 'dir/b.json': '{}' });
  assert.equal(own.root, null, 'files at the top: no root');
  const fromBuffer = makeZip([{ name: 'c.yml', data: 'y' }]);
  assert.equal((await readZip(fromBuffer.buffer.slice(fromBuffer.byteOffset, fromBuffer.byteOffset + fromBuffer.byteLength))).entries.length, 1, 'an ArrayBuffer is read too');
});

test('the caller\'s rule is applied before anything is inflated: a declined entry is counted, never read, even when it is damaged', async () => {
  const seen = [];
  const r = await readZip(buildZip([
    { name: 'repo/node_modules/x/index.js', data: 'nope', crc: 1 },
    { name: 'repo/rules.yaml', data: 'groups: []\n' },
  ]), { accept: (p) => { seen.push(p); return !p.includes('node_modules'); } });
  assert.deepEqual(seen, ['repo/node_modules/x/index.js', 'repo/rules.yaml']);
  assert.deepEqual([Object.keys(texts(r)), r.ignored, r.skipped], [['repo/rules.yaml'], 1, []]);
});

test('an entry the reader will not take is skipped and named: a name that leaves the folder, encryption, another method, past the file cap, a header that understates its size, a bad checksum', async () => {
  const big = 'a'.repeat(4096);
  const r = await readZip(buildZip([
    { name: '../outside.yaml', data: 'x' },
    { name: '/etc/passwd', data: 'x' },
    { name: 'C:/Windows/x.yaml', data: 'x' },
    { name: 'repo/a/../../up.yaml', data: 'x' },
    { name: 'repo/locked.yaml', data: 'x', flags: 0x1 },
    { name: 'repo/bzip.yaml', data: 'x', method: 12 },
    { name: 'repo/huge.yaml', data: big, size: 9 * 1024 * 1024 },
    { name: 'repo/bomb.yaml', data: big, size: 100 },
    { name: 'repo/bad-crc.yaml', data: 'groups: []\n', crc: 0xdeadbeef },
    { name: 'repo/ok.yaml', data: 'groups: []\n' },
  ]));
  assert.deepEqual(Object.keys(texts(r)), ['repo/ok.yaml']);
  assert.deepEqual(r.skipped, [
    { path: '../outside.yaml', why: 'its name leaves the archive\'s folder' },
    { path: '/etc/passwd', why: 'its name leaves the archive\'s folder' },
    { path: 'C:/Windows/x.yaml', why: 'its name leaves the archive\'s folder' },
    { path: 'repo/a/../../up.yaml', why: 'its name leaves the archive\'s folder' },
    { path: 'repo/locked.yaml', why: 'it is encrypted' },
    { path: 'repo/bzip.yaml', why: 'it is compressed with method 12, which is not read' },
    { path: 'repo/huge.yaml', why: 'it is larger than 5 MB' },
    { path: 'repo/bomb.yaml', why: 'it inflates past the size its header gives' },
    { path: 'repo/bad-crc.yaml', why: 'it is damaged (its size or checksum does not match)' },
  ]);
  for (const [name, safe] of [['a/./b', 'a/b'], ['a//b', 'a/b'], ['a\0b', null], ['..', null], ['', null], ['.', null]]) assert.equal(safeEntryPath(name), safe, JSON.stringify(name));
});

test('the caps: at most maxEntries files are read and at most maxTotalBytes in all, then the result says it stopped', async () => {
  const many = buildZip(Array.from({ length: 5 }, (_, i) => ({ name: `r/${i}.yaml`, data: `n: ${i}\n` })));
  const r = await readZip(many, { maxEntries: 3 });
  assert.deepEqual([r.entries.length, r.truncated], [3, true]);
  const t = await readZip(buildZip(Array.from({ length: 4 }, (_, i) => ({ name: `r/${i}.yaml`, data: 'x'.repeat(100) }))), { maxTotalBytes: 250 });
  assert.deepEqual([t.entries.length, t.truncated], [2, true]);
  assert.deepEqual(UNZIP_LIMITS, { maxEntries: 20000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });
});

test('an archive refused whole, with its sentence: not a ZIP, ZIP64, split, a directory past its end', async () => {
  const refused = async (bytes, message) => {
    await assert.rejects(readZip(bytes), (e) => { assert.ok(e instanceof ZipRefusal); assert.equal(e.message, message); return true; });
  };
  await refused(enc.encode('PK'), 'this is not a .zip: it is too short to hold a ZIP directory');
  await refused(enc.encode('x'.repeat(200)), 'this is not a .zip: no ZIP directory at its end');
  await refused(buildZip([{ name: 'a.yaml', data: 'x' }], { eocd: { count: 0xffff } }), 'this .zip is a ZIP64 archive (over 4 GB or 65,535 entries), which is not read: zip only the folder the scan needs');
  await refused(buildZip([{ name: 'a.yaml', data: 'x' }], { eocd: { disk: 1 } }), 'this .zip is split across several files, which is not read: zip the folder as one file');
  await refused(buildZip([{ name: 'a.yaml', data: 'x' }], { eocd: { offset: 5000 } }), 'this .zip is damaged: its directory points past its end');
});
