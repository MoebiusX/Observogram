#!/usr/bin/env node
/**
 * server/test-audit-report-api.mjs — GET /api/packs/:id/audit-report and
 * GET /api/packs/:id/placeholders (GAP batch 2 B3.5, server/routes/
 * audit-report.mjs over tools/lib/audit-report.mjs), in-process over HTTP on
 * one stand-alone identity server as test-verdicts-api.mjs does, plus two
 * hermetic children (server/fixtures/serve-child.mjs) for a branded and a
 * taxonomy-configured server.
 *
 * What is pinned: the 404 and 400 shapes, no-store; the JSON report's
 * conformance fields equal to the /conformance body's (the one
 * conformanceReportFor() call — the extraction's proof), `?env=`; the HTML
 * document and the download names; a registered pack's real verdict and
 * waiver rows mapped field by field from GET /verdicts and GET
 * /api/services/:id/waivers, the waived clause and `effective`, the service
 * tier; a branded child's chrome and a taxonomy child's coverage; the
 * export ZIP's entries untouched; /placeholders equal to
 * packConformance(overlaid). Who may reach the routes is test-authz's,
 * which org's packs a member reaches is test-tenancy's.
 *
 * The fixture is test-identity-api's: default {olive: admin} (an owner),
 * acme {ada: admin, oscar: operator, vera: viewer}, bravo {bob: admin}.
 */

// Hermetic (§0): a developer shell's store, identity or per-org token
// variables never reach this process's imports. serve-child.mjs imports no
// server code.
const { STRIP, serve, signIn, dropInheritedOrgVars } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}
dropInheritedOrgVars();

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-audit-report-api-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

const { hashPassword } = await import('./auth.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');

const pw = (login) => `${login}-passw0rd-api`;
const LOGINS = ['olive', 'ada', 'oscar', 'vera', 'bob'];
writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(WORKSPACE, 'users.json'));
writeOrgsFile({
  default: { name: 'Default', members: { olive: 'admin' } },
  acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer' } },
  bravo: { name: 'Bravo', members: { bob: 'admin' } },
}, join(WORKSPACE, 'orgs.json'));

const { start } = await import('./index.mjs');
const { closeStore } = await import('./store/db.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const { adapt, overlaidCanonical } = await import('../tools/lib/adapter.mjs');
const { packConformance } = await import('../tools/lib/pack-conformance.mjs');
const { AUDIT_REPORT_VERSION, splitClauses, flattenArtefacts } = await import('../tools/lib/audit-report.mjs');

const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
const BASE = `http://127.0.0.1:${srv.address().port}`;
after(async () => {
  await new Promise((resolve) => srv.close(resolve));
  closeStore();
  rmSync(WORKSPACE, { recursive: true, force: true });
});

const cookies = {};
for (const login of LOGINS) {
  const s = await signIn(BASE, login, pw(login));
  assert.equal(s.status, 200, `${login} signs in: ${JSON.stringify(s.json)}`);
  cookies[login] = s.session;
}

const CSRF = { 'X-Observogram-CSRF': '1' };
async function call(who, method, path, body, extra = {}) {
  const headers = { Accept: 'application/json', ...CSRF, Cookie: cookies[who], ...(who === 'olive' ? { 'X-Observogram-Org': 'acme' } : {}), ...extra };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] ??= 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }
  const r = await fetch(`${BASE}${path}`, { method, headers, body: payload, redirect: 'manual' });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text, headers: r.headers };
}

const PAY_YAML = readFileSync(join(ROOT, `${SPEC_DIR}/examples/payment-service.pack.yaml`), 'utf8');
const PAYMENT = parseYaml(PAY_YAML);
const HTTP3_YAML = readFileSync(join(ROOT, 'tools/fixtures/library/http-service.tier-3.pack.yaml'), 'utf8');
const YAML = { 'Content-Type': 'text/yaml' };
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const KEYS = ['reportVersion', 'generator', 'generatedAt', 'pack', 'tier', 'conformance', 'placeholders', 'assessments', 'waivers', 'coverage', 'goesBlind', 'responsePath'];
const ids = {};

// The entry names of a ZIP, read off its central directory (test-verdicts-api.mjs's reader).
function zipEntryNames(bytes) {
  const b = Buffer.from(bytes);
  let eocd = b.length - 22;
  while (eocd >= 0 && b.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  assert.ok(eocd >= 0, 'the zip has an end-of-central-directory record');
  const count = b.readUInt16LE(eocd + 10);
  let at = b.readUInt32LE(eocd + 16);
  const names = [];
  for (let i = 0; i < count; i++) {
    assert.equal(b.readUInt32LE(at), 0x02014b50, 'a central file header');
    const nameLen = b.readUInt16LE(at + 28);
    const extraLen = b.readUInt16LE(at + 30);
    const commentLen = b.readUInt16LE(at + 32);
    names.push(b.subarray(at + 46, at + 46 + nameLen).toString('utf8'));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

// The report's conformance section is the /conformance body split — the one builder.
const sameConformance = (report, body) => assert.deepEqual(report.conformance, splitClauses(body), 'the report reads the /conformance body');

test('GET /api/packs/:id/audit-report on a catalogue pack: the JSON document (no-store), its conformance the /conformance body\'s, verdicts and waivers available and none recorded, the graph computed, the response path declared; ?env= grades the environment; unknown pack 404, bad format and top 400', async () => {
  const r = await call('vera', 'GET', '/api/packs/payment-service/audit-report');
  assert.equal(r.status, 200, r.text.slice(0, 200));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.match(r.headers.get('content-type'), /^application\/json/);
  assert.equal(r.headers.get('content-disposition'), null, 'no attachment without download=1');
  const doc = r.json;
  assert.deepEqual(Object.keys(doc), KEYS);
  assert.equal(doc.reportVersion, AUDIT_REPORT_VERSION);
  assert.ok(ISO.test(doc.generatedAt), 'stamped by the server');
  assert.equal(doc.generator.name, 'Observogram server', 'the product name is the brand\'s');
  assert.ok(typeof doc.generator.version === 'string' && doc.generator.version.length > 0);
  assert.deepEqual([doc.pack.id, doc.pack.source, doc.pack.environment, doc.pack.artefacts], ['payment-service', 'catalogue', null, 84]);
  const conf = (await call('vera', 'GET', '/api/packs/payment-service/conformance')).json;
  sameConformance(doc, conf);
  assert.deepEqual(doc.tier, conf.tier);
  assert.deepEqual([doc.assessments.available, doc.assessments.counts.unreviewed, doc.assessments.verdicts], [true, 84, []]);
  assert.deepEqual([doc.waivers.available, doc.waivers.waivers], [true, []]);
  assert.deepEqual([doc.goesBlind.available, doc.goesBlind.nodes, doc.goesBlind.edges, doc.goesBlind.risks.length], [true, 94, 72, 10]);
  assert.deepEqual([doc.responsePath.configured, doc.responsePath.counts.remediations], [true, 3]);
  // ?env=staging: the overlay's grading, named in the document.
  const staging = (await call('vera', 'GET', '/api/packs/payment-service/audit-report?env=staging')).json;
  const confStaging = (await call('vera', 'GET', '/api/packs/payment-service/conformance?env=staging')).json;
  sameConformance(staging, confStaging);
  assert.deepEqual([staging.pack.environment, staging.conformance.declaredTier], ['staging', confStaging.declaredTier]);
  // ?top=2 lists two risks; the count of SLO-blinding nodes does not depend on the listing.
  const two = (await call('vera', 'GET', '/api/packs/payment-service/audit-report?top=2')).json;
  assert.deepEqual([two.goesBlind.top, two.goesBlind.risks.length, two.goesBlind.sloBlindingNodes], [2, 2, doc.goesBlind.sloBlindingNodes]);
  // Refusals: the sibling pack reads' shapes.
  const nope = await call('vera', 'GET', '/api/packs/nope/audit-report');
  assert.deepEqual([nope.status, nope.json], [404, { error: 'unknown pack: nope' }]);
  const ph = await call('vera', 'GET', '/api/packs/nope/placeholders');
  assert.deepEqual([ph.status, ph.json], [404, { error: 'unknown pack: nope' }]);
  const fmt = await call('vera', 'GET', '/api/packs/payment-service/audit-report?format=pdf');
  assert.deepEqual([fmt.status, fmt.json], [400, { error: 'format must be one of json, html' }]);
  for (const top of ['0', '101', 'x', '-1', '1.5']) {
    const t = await call('vera', 'GET', `/api/packs/payment-service/audit-report?top=${top}`);
    assert.deepEqual([t.status, t.json], [400, { error: 'top must be an integer from 1 to 100' }], top);
  }
});

test('GET /api/packs/:id/audit-report?format=html: one HTML document (no-store) over the design kit, unbranded; download=1 names the attachment for both formats', async () => {
  const r = await call('vera', 'GET', '/api/packs/payment-service/audit-report?format=html');
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /^text\/html/);
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(r.text.startsWith('<!doctype html>'));
  assert.ok(r.text.includes('<h1 class="og-h1">payment-service</h1>') && r.text.includes('.og-stat {') && r.text.includes('.ar-page {'), 'the report over the kit');
  assert.ok(r.text.includes('Observogram · the Observability Compiler') && !r.text.includes('brand-tokens'), 'unbranded');
  assert.ok(!/<script/i.test(r.text));
  assert.ok(r.text.includes('None recorded: every artefact is unreviewed.') && r.text.includes('None recorded: no finding is waived.'), 'a server has the store: none recorded, not "not recorded by this build"');
  const dl = await call('vera', 'GET', '/api/packs/payment-service/audit-report?format=html&download=1');
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="payment-service.audit-report.html"');
  const dj = await call('vera', 'GET', '/api/packs/payment-service/audit-report?download=1');
  assert.equal(dj.headers.get('content-disposition'), 'attachment; filename="payment-service.audit-report.json"');
  assert.deepEqual(Object.keys(dj.json), KEYS);
});

test('a registered pack: the report carries its real verdict and waiver rows, mapped field by field from GET /verdicts and GET /api/services/:id/waivers, the waived clause under `waived` with `effective` beside the engine\'s numbers, the service in `tier`; the export ZIP gains no entry', async () => {
  const up = await call('ada', 'POST', '/api/validate?source=pay.yaml', PAY_YAML, YAML);
  assert.equal(up.status, 200, up.text.slice(0, 200));
  ids.pay = up.json.registered.id;
  const services = (await call('vera', 'GET', '/api/services')).json.services;
  ids.service = services.find((s) => s.slug === 'payment-service').id;
  const put = await call('oscar', 'PUT', `/api/packs/${ids.pay}/verdicts/SLI-01`, { status: 'suspect', reason: 'the window is short' });
  assert.equal(put.status, 200, put.text);
  const expires = new Date(Date.now() + 30 * 86400000).toISOString();
  const waived = await call('oscar', 'POST', `/api/services/${ids.service}/waivers`, { ruleId: 'L5.MUST.tier1_weekly_prod_chaos', reason: 'chaos day is scheduled for Q1', expiresAt: expires });
  assert.equal(waived.status, 201, waived.text);
  const revoked = await call('oscar', 'POST', `/api/services/${ids.service}/waivers`, { ruleId: 'L3.MUST.recording_rule_per_slo', artefactId: 'slos.consumer_success_99_95', reason: 'rule ships next sprint', expiresAt: expires });
  assert.equal(revoked.status, 201, revoked.text);
  const rv = await call('ada', 'POST', `/api/waivers/${revoked.json.waiver.id}/revoke`, { reason: 'shipped' });
  assert.equal(rv.status, 200, rv.text);

  const doc = (await call('vera', 'GET', `/api/packs/${ids.pay}/audit-report`)).json;
  const conf = (await call('vera', 'GET', `/api/packs/${ids.pay}/conformance`)).json;
  sameConformance(doc, conf);
  assert.deepEqual(doc.tier.service, { id: ids.service, slug: 'payment-service' });
  assert.deepEqual([doc.pack.id, doc.pack.source], [ids.pay, 'uploaded']);
  // The verdict row, from the GET document's view.
  const v = (await call('vera', 'GET', `/api/packs/${ids.pay}/verdicts`)).json.verdicts[0];
  assert.deepEqual(doc.assessments.verdicts, [{ artefactKey: v.artefact, key: v.key, family: v.family, title: v.title, state: v.status, reason: v.reason, at: v.setAt, by: v.actor }]);
  assert.deepEqual(doc.assessments.counts, { unreviewed: 83, trusted: 0, suspect: 1, failed: 0 });
  assert.equal(doc.assessments.verdicts[0].by, 'oscar');
  // The waiver rows, from the service's list: the active one first, the revoked one as history.
  const list = (await call('vera', 'GET', `/api/services/${ids.service}/waivers`)).json.waivers;
  const row = (w) => ({ id: w.id, artefactKey: w.artefactId, rule: w.ruleId, reason: w.reason, expiresAt: w.expiresAt, at: w.createdAt, by: w.author, status: w.state, ...(w.revokedAt ? { revokedAt: w.revokedAt, revokedBy: w.revokedBy, revokeReason: w.revokeReason } : {}) });
  const active = list.find((w) => w.state === 'active');
  const gone = list.find((w) => w.state === 'revoked');
  assert.deepEqual(doc.waivers.waivers, [row(active), row(gone)]);
  assert.deepEqual(doc.waivers.counts, { active: 1, expired: 0, revoked: 1, unknown: 0 });
  assert.deepEqual([doc.waivers.waivers[1].revokedBy, doc.waivers.waivers[1].revokeReason], ['ada', 'shipped']);
  // The waived clause and the effective numbers beside the engine's.
  assert.deepEqual(doc.conformance.clauses.waived.map((c) => c.id), ['L5.MUST.tier1_weekly_prod_chaos']);
  assert.deepEqual([doc.conformance.must, doc.conformance.effective.must], [{ passed: 21, total: 25 }, { passed: 22, total: 25 }]);
  assert.deepEqual(doc.conformance.clauses.waived[0].waiver.waivers[0].id, active.id);
  // The HTML shows them.
  const html = (await call('vera', 'GET', `/api/packs/${ids.pay}/audit-report?format=html`)).text;
  assert.ok(html.includes('the window is short') && html.includes('chaos day is scheduled for Q1') && html.includes('>revoked<'));
  // The export ZIP: verdicts.json rides (B3.1); no audit-report entry.
  const zip = await fetch(`${BASE}/api/packs/${ids.pay}/export.zip`, { headers: { Cookie: cookies.vera } });
  assert.equal(zip.status, 200);
  const names = zipEntryNames(await zip.arrayBuffer());
  assert.ok(names.includes('verdicts.json') && !names.some((n) => /audit-report/.test(n)), names.join(','));
});

test('GET /api/packs/:id/placeholders: packConformance(overlaid) bare — no rows for the vendored example, the library build\'s 19 rows; ?env= overlays first; no-store', async () => {
  const none = await call('vera', 'GET', '/api/packs/payment-service/placeholders');
  assert.equal(none.status, 200);
  assert.equal(none.headers.get('cache-control'), 'no-store');
  assert.deepEqual(none.json, packConformance(overlaidCanonical(PAYMENT, null).canonical));
  assert.deepEqual([none.json.conformant, none.json.rows], [true, []]);
  const staging = await call('vera', 'GET', '/api/packs/payment-service/placeholders?env=staging');
  assert.deepEqual(staging.json, packConformance(overlaidCanonical(PAYMENT, 'staging').canonical));
  const up = await call('ada', 'POST', '/api/validate?source=checkout.yaml', HTTP3_YAML, YAML);
  assert.equal(up.status, 200, up.text.slice(0, 200));
  const rows = await call('vera', 'GET', `/api/packs/${up.json.registered.id}/placeholders`);
  assert.deepEqual(rows.json, packConformance(parseYaml(HTTP3_YAML)));
  assert.equal(rows.json.counts.rows, 19);
  const doc = (await call('vera', 'GET', `/api/packs/${up.json.registered.id}/audit-report`)).json;
  assert.deepEqual([doc.placeholders.counts.rows, doc.placeholders.templates], [19, { todos: 15, scaffolds: 14 }]);
  assert.equal(doc.pack.artefacts, flattenArtefacts(adapt(parseYaml(HTTP3_YAML))).length);
});

test('a branded child (OBSERVOGRAM_BRAND_FILE) renders the HTML with its chrome and tokens; a taxonomy child (OBSERVOGRAM_TAXONOMY) classifies the coverage section as the Discover board does', async (t) => {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-audit-report-children-'));
  const branded = await serve(ws, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_BRAND_FILE: join(ROOT, 'tools/fixtures/brand/acme-static.json') } });
  t.after(async () => { await branded.stop(); rmSync(ws, { recursive: true, force: true }); });
  const html = await (await fetch(`${branded.base}/api/packs/payment-service/audit-report?format=html`)).text();
  assert.ok(html.includes('<style id="brand-tokens">') && html.includes('--og-accent:#b3261e;'), 'the brand tokens');
  assert.ok(html.includes('Acme Watch · a product of Acme Corp') && html.includes('status &lt;live&gt;'), 'the brand chrome, escaped');
  assert.ok(!html.replace(/<style[\s\S]*?<\/style>/g, '').includes('Observogram'), 'a branded report names its own product only');
  const json = await (await fetch(`${branded.base}/api/packs/payment-service/audit-report`)).json();
  assert.deepEqual(Object.keys(json), KEYS, 'the JSON is the same document');
  assert.equal(json.generator.name, 'Acme Watch server');

  const ws2 = mkdtempSync(join(tmpdir(), 'observogram-audit-report-taxonomy-'));
  const typed = await serve(ws2, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_TAXONOMY: join(ROOT, 'tools/fixtures/taxonomy/taxonomy.json') } });
  t.after(async () => { await typed.stop(); rmSync(ws2, { recursive: true, force: true }); });
  const canonical = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/taxonomy/typed-canonical.pack.json'), 'utf8'));
  const reg = await (await fetch(`${typed.base}/api/validate`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(canonical) })).json();
  assert.equal(reg.ok, true, JSON.stringify(reg.errors));
  const mapped = await (await fetch(`${typed.base}/api/packs/${reg.registered.id}/audit-report`)).json();
  const regHere = await call('ada', 'POST', '/api/validate', JSON.stringify(canonical));
  assert.equal(regHere.status, 200, regHere.text.slice(0, 200));
  const unmapped = (await call('vera', 'GET', `/api/packs/${regHere.json.registered.id}/audit-report`)).json;
  const count = (doc, family) => doc.coverage.families.find((f) => f.family === family).count;
  // With the override POL-01 moves from burn_rate (its id) to alert_rule (its declared type) — the board golden's move.
  assert.equal(count(mapped, 'alert_rule'), count(unmapped, 'alert_rule') + 1, 'the taxonomy child classifies by the declared type');
  assert.equal(count(mapped, 'burn_rate'), count(unmapped, 'burn_rate') - 1);
  assert.equal(mapped.pack.artefacts, unmapped.pack.artefacts, 'a taxonomy changes no count');
});
