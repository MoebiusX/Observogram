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
// bearer route. With sign-in /auth/me's `orgs[].effectiveRole` of the active
// org decides, and an owner outside every membership (server/authz.mjs lands
// them in the default org as admin) reads the form from `user.owner` — the
// flag's name on the wire (server/auth.mjs GET /auth/me), not the store
// row's `isOwner`. fetch() is stubbed per test (studio/api.mjs reads the
// global), the probe re-run with `refresh`; nothing here touches a server.
// Also here: the load's orphan filter, the Refine counts, refusalText.

import test from 'node:test';
import assert from 'node:assert/strict';

const { state } = await import('../studio/state.mjs');
const { setActiveOrg } = await import('../studio/api.mjs');
const { loadVerdicts, loadAnonymousRole, anonymousViewer, canRecordVerdict, verdictPanel, verdictOf, verdictCounts, refusalText } = await import('../studio/verdicts.mjs');

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
  state.identity = { ok: true, mode: 'local', authenticated: true, user: { login: 'vera', kind: 'local', owner: false }, orgs: [{ id: 'acme', role: 'viewer', effectiveRole: 'viewer' }, { id: 'bravo', role: 'operator', effectiveRole: 'operator' }] };
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

test('an owner with no membership of the active org records: /auth/me names the flag `user.owner`, and that is what the panel reads', async () => {
  stubServer('viewer');
  await loadAnonymousRole({ refresh: true });
  state.identity = { ok: true, mode: 'local', authenticated: true, user: { login: 'olive', kind: 'local', owner: true }, orgs: [] };
  setActiveOrg(null);
  await loadVerdicts(PACK);
  assert.equal(canRecordVerdict(), true, 'the org gate lands an owner in the default org as admin (server/authz.mjs)');
  assert.match(verdictPanel(ARTEFACT).innerHTML, /class="verdict-form"/);
  state.identity = { ok: true, mode: 'local', authenticated: true, user: { login: 'nobody', kind: 'local', owner: false }, orgs: [] };
  assert.equal(canRecordVerdict(), false, 'not an owner, no membership: the gate refuses every call');
  assert.match(verdictPanel(ARTEFACT).innerHTML, /read-only for your role/);
});

test('loadVerdicts keeps the live rows only — an orphaned row (its artefact gone from the pack) is dropped — and verdictCounts files the rest under unreviewed', async () => {
  stubServer('admin');
  await loadAnonymousRole({ refresh: true });
  const row = (artefact, status, extra = {}) => ({ artefact, status, actor: 'rev', setAt: '2026-10-01T00:00:00Z', reason: null, carriedFrom: null, orphaned: false, ...extra });
  globalThis.fetch = async (path) => (path === `/api/packs/${PACK}/verdicts`
    ? json(200, { ok: true, pack: PACK, verdicts: [row('SLI-01', 'trusted'), row('SLO-01', 'failed'), row('ALERT-09', 'suspect', { orphaned: true }), null], summary: {} })
    : json(404, { ok: false, error: `unknown ${path}` }));
  const map = await loadVerdicts(PACK);
  assert.deepEqual([...map.keys()], ['SLI-01', 'SLO-01'], 'the orphan and the null row are not verdicts of this pack');
  assert.equal(verdictOf('ALERT-09'), null);
  assert.equal(state.verdictsPack, PACK);
  assert.deepEqual(verdictCounts([{ id: 'SLI-01' }, { id: 'SLO-01' }, { id: 'ALERT-09' }, { id: 'SLO-02' }]), { trusted: 1, suspect: 0, failed: 1, unreviewed: 2 });
  globalThis.fetch = async () => json(500, { ok: false, error: 'boom' });
  assert.equal(await loadVerdicts(PACK), null, 'an unanswered load is null, never a throw');
  assert.equal(state.verdictsPack, PACK, 'the pack is still the one asked for: the panel addresses it');
  assert.deepEqual(verdictCounts([{ id: 'SLI-01' }]), { trusted: 0, suspect: 0, failed: 0, unreviewed: 1 });
});

test('refusalText quotes the body\'s error from an api() failure, else the message', () => {
  assert.equal(refusalText(new Error('409 Conflict on /api/packs/x/verdicts/y: {"ok":false,"error":"a catalogue pack has no verdicts — upload it"}')), 'a catalogue pack has no verdicts — upload it');
  assert.equal(refusalText(new Error('502 Bad Gateway on /api/x: <html>')), '502 Bad Gateway on /api/x: <html>');
  assert.equal(refusalText(new Error('401 Unauthorized on /api/x: {"ok":false}')), '401 Unauthorized on /api/x: {"ok":false}', 'a body without an error string falls back to the message');
  assert.equal(refusalText(null), 'null');
});
