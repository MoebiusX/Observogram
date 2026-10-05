#!/usr/bin/env node
// tools/test-verdicts-panel.mjs — who sees the drawer's Verdict form
// (studio/verdicts.mjs, GAP batch 2 B3.1), headless under node:test.
//
// /auth/me answers 404 in the open postures AND in the token-only posture
// (OBSERVOGRAM_API_TOKEN without identity), so `state.identity` is null in
// both; the server reads the anonymous browser as an owner in the first and
// as a viewer in the second (server/authz.mjs principalOf), where every
// write answers 401 naming a bearer header the studio cannot send. The panel
// must not draw a control the API refuses: without an identity the role is
// probed from GET /api/orgs once, and a viewer gets the note naming the
// bearer route. fetch() is stubbed per test (studio/api.mjs reads the
// global), the probe re-run with `refresh`; nothing here touches a server.

import test from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../studio/state.mjs');
const { setActiveOrg } = await import('../studio/api.mjs');
const { loadVerdicts, loadAnonymousRole, anonymousViewer, canRecordVerdict, verdictPanel } = await import('../studio/verdicts.mjs');

const PACK = 'uploaded-payment-service-1a2b3c4d';
const ARTEFACT = { id: 'SLI-01', name: 'api_availability' };
const EMPTY_DOC = { ok: true, pack: PACK, verdicts: [], summary: { artefacts: 1, trusted: 0, suspect: 0, failed: 0, unreviewed: 1, orphaned: 0 } };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const orgsDoc = (effectiveRole) => ({ ok: true, tenancy: true, orgs: [{ id: 'default', name: 'Default', role: null, effectiveRole }], active: 'default' });

// A server with no identity whose anonymous caller holds `role` in the
// default org (server/index.mjs GET /api/orgs); null answers the static
// bundle's 501 instead. Returns the paths fetched.
function stubServer(role) {
  const calls = [];
  globalThis.fetch = async (path) => {
    calls.push(String(path));
    if (path === '/api/orgs') {
      return role === null
        ? json(501, { ok: false, denied: 'no-backend', error: 'Verdicts needs the server' })
        : json(200, orgsDoc(role));
    }
    if (path === `/api/packs/${PACK}/verdicts`) return json(200, EMPTY_DOC);
    return json(404, { ok: false, error: `unknown ${path}` });
  };
  return calls;
}

// The DOM verdictPanel needs: a section whose innerHTML is kept as text and
// queried for the form by its class.
const stubElement = () => ({
  className: '', innerHTML: '',
  querySelector(sel) {
    if (sel === '.verdict-form') return /class="verdict-form"/.test(this.innerHTML) ? stubForm() : null;
    return null;
  },
});
const stubForm = () => ({
  querySelector: () => ({ innerHTML: '', addEventListener() {} }),
  querySelectorAll: () => [],
  addEventListener() {},
});

const realFetch = globalThis.fetch;
test.beforeEach(() => {
  state.identity = null;
  state.catalog = [{ id: PACK, source: 'uploaded' }];
  state.selectedPackId = PACK;
  setActiveOrg(null);
  globalThis.document = { createElement: stubElement };
});
test.afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.document;
});

test('token-only posture: an anonymous browser the server reads as a viewer gets no form — the note names the bearer route', async () => {
  const calls = stubServer('viewer');
  await loadAnonymousRole({ refresh: true });
  await loadVerdicts(PACK);
  assert.equal(anonymousViewer(), true);
  assert.equal(canRecordVerdict(), false, 'the API would answer 401 to the save');
  const sec = verdictPanel(ARTEFACT);
  assert.doesNotMatch(sec.innerHTML, /verdict-form/, 'no Save the server refuses');
  assert.match(sec.innerHTML, /verdict-note/);
  assert.match(sec.innerHTML, /read-only here/);
  assert.match(sec.innerHTML, new RegExp(`PUT /api/packs/${PACK}/verdicts/SLI-01`), 'the way out is the route a bearer may call');
  assert.match(sec.innerHTML, /Authorization: Bearer &lt;OBSERVOGRAM_API_TOKEN&gt;/);
  assert.doesNotMatch(sec.innerHTML, /for your role/, 'not the signed-in viewer\'s sentence: there is no role to change here');
  assert.equal(calls.filter((p) => p === '/api/orgs').length, 1, 'one probe per session: loadVerdicts reuses the answer');
});

test('open posture: the anonymous browser is an owner (effectiveRole admin) — the form draws as before', async () => {
  stubServer('admin');
  await loadAnonymousRole({ refresh: true });
  await loadVerdicts(PACK);
  assert.equal(anonymousViewer(), false);
  assert.equal(canRecordVerdict(), true);
  assert.match(verdictPanel(ARTEFACT).innerHTML, /class="verdict-form"/);
});

test('a server that does not answer /api/orgs (the static bundle\'s 501) leaves the open-posture behaviour: the role is not known, the form stays', async () => {
  stubServer(null);
  assert.equal(await loadAnonymousRole({ refresh: true }), null);
  await loadVerdicts(PACK);
  assert.equal(anonymousViewer(), false);
  assert.equal(canRecordVerdict(), true);
});

test('with sign-in the probe is not consulted: /auth/me\'s effectiveRole of the active org decides, a viewer reads the role sentence', async () => {
  const calls = stubServer('viewer');
  await loadAnonymousRole({ refresh: true });   // a stale viewer answer must not leak into the identity postures
  state.identity = { ok: true, mode: 'local', authenticated: true, user: { login: 'vera', isOwner: false }, orgs: [{ id: 'acme', role: 'viewer', effectiveRole: 'viewer' }, { id: 'bravo', role: 'operator', effectiveRole: 'operator' }] };
  setActiveOrg('acme');
  calls.length = 0;
  await loadVerdicts(PACK);
  assert.deepEqual(calls, [`/api/packs/${PACK}/verdicts`], 'no /api/orgs probe with an identity');
  assert.equal(anonymousViewer(), false);
  assert.equal(canRecordVerdict(), false);
  assert.match(verdictPanel(ARTEFACT).innerHTML, /read-only for your role/);
  setActiveOrg('bravo');
  assert.equal(canRecordVerdict(), true, 'an operator of the active org records');
  setActiveOrg(null);
});
