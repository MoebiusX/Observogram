#!/usr/bin/env node
// tools/test-bundle-compare-pairs.mjs — Compare in the static bundle, every
// ordered pair (follow-up compare-in-bundle, M1; docs/DOWNSTREAM.md §10).
//
// The static shim's GET /api/diff (studio/static-backend.mjs) against a child
// server (serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } })) over the same ten
// packs under the server's ids — its six, and the golden crawl, the two
// compare-modes packs and the library-built orders pack, registered through
// POST /api/validate — for every ordered pair, self-pairs included, in each
// scope mode the studio sends (studio/compare-view.mjs loadDiff always sends
// one of service, family, all): 300 queries. "Equal" is the same status,
// reason phrase, content type, Cache-Control, Content-Disposition,
// X-Content-Type-Options and raw body text. Its own file so it runs beside
// tools/test-bundle-compare.mjs (C3 holds the spellings no studio sends, the
// environments, the refusals and the largest answers).
//
// A flat suite of top-level test( calls.
//
// Run: node --test tools/test-bundle-compare-pairs.mjs

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { serve } from '../server/fixtures/serve-child.mjs';
import { createStaticBackend } from '../studio/static-backend.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_SCHEMA_PATH } from './lib/validator.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(resolve(ROOT, rel), 'utf8');
const packFile = (rel) => (rel.endsWith('.json') ? JSON.parse(read(rel)) : parseYaml(read(rel)));
// The six packs a server serves by id, from the files it reads them from (server/index.mjs).
const SERVER_PACKS = [
  ['payment-service', 'vendor/observability-pack-spec/v1.4/examples/payment-service.pack.yaml'],
  ['target-advanced', 'examples/target-advanced.pack.yaml'],
  ['production-curated', 'examples/production-curated.pack.yaml'],
  ['kafka-reference', 'reference-packs/kafka.pack.yaml'],
  ['prometheus-reference', 'reference-packs/prometheus.pack.yaml'],
  ['grafana-reference', 'reference-packs/grafana.pack.yaml'],
];
const HEADERS = ['content-type', 'cache-control', 'content-disposition', 'x-content-type-options'];
const answerOf = async (r) => ({ status: r.status, statusText: r.statusText, headers: Object.fromEntries(HEADERS.map((h) => [h, r.headers.get(h)])), text: await r.text() });

test('M1 every ordered pair of ten packs, in each scope mode the studio sends: the shim\'s GET /api/diff is the server\'s, status, reason phrase, headers and raw text', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-bundle-pairs-'));
  const child = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off' } });
  t.after(async () => { await child.stop(); rmSync(ws, { recursive: true, force: true }); });
  const register = async (body, contentType, source = '') => {
    const r = await fetch(`${child.base}/api/validate${source ? `?source=${encodeURIComponent(source)}` : ''}`, { method: 'POST', headers: { 'Content-Type': contentType }, body }).then((x) => x.json());
    assert.equal(r.ok, true, JSON.stringify(r.errors));
    return r.registered.id;
  };
  const packs = SERVER_PACKS.map(([id, rel]) => ({ id, label: id, canonical: packFile(rel) }));
  const golden = JSON.parse(read('tools/fixtures/golden-crawl.pack.json'));
  packs.push({ id: await register(JSON.stringify(golden), 'application/json'), canonical: golden });
  for (const side of ['a', 'b']) {
    const text = read(`tools/fixtures/compare-modes/${side}.pack.yaml`);
    packs.push({ id: await register(text, 'text/yaml', `compare-modes-${side}.pack.yaml`), canonical: parseYaml(text) });
  }
  const orders = JSON.parse(read('tools/fixtures/build/orders-api.tier-2.instantiate.json')).canonical;
  packs.push({ id: await register(JSON.stringify(orders), 'application/json'), canonical: orders });
  for (const p of packs) p.label ??= p.id;
  assert.equal(packs.length, 10);
  const backend = createStaticBackend({ version: '0.0.0', schema: JSON.parse(read(SPEC_SCHEMA_PATH)), packs });

  const problems = [];
  let queries = 0;
  for (const scopeMode of ['service', 'family', 'all']) {
    for (const a of packs) {
      for (const b of packs) {
        const path = `/api/diff?${new URLSearchParams({ a: a.id, b: b.id, scopeMode })}`;
        const server = await answerOf(await fetch(`${child.base}${path}`));
        const shim = await answerOf(await backend.handle(path));
        queries++;
        if (server.status !== 200) problems.push(`${path}: the server answered ${server.status}`);
        const differs = ['status', 'statusText'].filter((k) => server[k] !== shim[k])
          .concat(HEADERS.filter((h) => server.headers[h] !== shim.headers[h]))
          .concat(server.text === shim.text ? [] : [`the body (${server.text.length} / ${shim.text.length} chars)`]);
        if (differs.length) problems.push(`${path}: ${differs.join(', ')} differ`);
      }
    }
  }
  assert.equal(queries, 300);
  assert.deepEqual(problems, [], `${problems.length} of ${queries} answers differ from the server's`);
});
