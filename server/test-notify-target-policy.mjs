#!/usr/bin/env node
/**
 * server/test-notify-target-policy.mjs — server/notify-target-policy.mjs (the
 * follow-up journey-notify-env-ownership): a server-run journey's
 * notification reads only its org's hook pair, OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL
 * and that hook's own _TOKEN, solely owned by the org, under the notify
 * origin allowlist. In process, over temp stores, with `env` always passed
 * explicitly: the names (every deny-list row, sole ownership, the shape's
 * exact case, no env read before the names pass), the pairing, the values,
 * the origin list, the resolver, the hook shape, the listing and the boot
 * report. A flat file of top-level tests (tools/test-doc-test-totals.mjs
 * LEDGER).
 */

// Hermetic (§0): the children's STRIP list, both spellings, before any server
// module loads (serve-child.mjs imports no server code).
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];
const { mkdtempSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const policy = await import('./notify-target-policy.mjs');
const {
  NOTIFY_ORIGINS_VAR, ORG_NOTIFY_ORIGINS_NAME, HOOK_RE, NOTIFY_HOOKS_ROUTE, orgNotifyOriginsVar, hookVarsOf,
  notifyHookOf, isOrgHookShaped, notifyNamesRefusal, notifyOriginList, resolveJourneyNotify, captureNotifyRefusal,
  notifyHooksOf, notifyBootReport, notifyPostureRefusal,
} = policy;
const { closeStore, openStore } = await import('./store/db.mjs');
const orgs = await import('./store/orgs.mjs');
const { envNameOwnedBy } = await import('./store/mcp-endpoints.mjs');

const tmpDirs = [];
process.on('exit', () => { for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch {} } });
async function freshStore(orgIds, { removed = [] } = {}) {
  const d = mkdtempSync(join(tmpdir(), 'observogram-notify-policy-'));
  tmpDirs.push(d);
  const path = join(d, 'observogram.db');
  const db = await openStore({ path });
  for (const id of [...orgIds, ...removed]) orgs.createOrg(db, 'system', { id, name: id });
  for (const id of removed) orgs.removeOrg(db, 'system', id);
  return { db, close: () => closeStore(path) };
}

// stderr written while fn runs.
async function stderrOf(fn) {
  const lines = [];
  const write = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { lines.push(String(chunk)); return typeof rest.at(-1) === 'function' ? (rest.at(-1)(), true) : true; };
  try { await fn(); } finally { process.stderr.write = write; }
  return lines.join('');
}

// ---------- the texts, as the design states them (A.1.4) ----------

const q = (v) => JSON.stringify(v);
const P = (org) => `OBSERVOGRAM_ORG_${org.toUpperCase().replaceAll('-', '_')}_`;
const L = 'GET /api/journeys/notify-hooks';
const J = (journey) => `journeys/${journey}.journey.yaml`;
const RUN = (journey, text) => `journey ${journey} is not run: ${text}`;
const T = {
  name: (urlEnv, org) => `notify.urlEnv ${q(urlEnv)} is not a notify hook of org '${org}' — the server posts a journey's notification only to ${P(org)}NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from ${P(org)}NOTIFY_<HOOK>_TOKEN: name one that ${L} lists`,
  shadow: (urlEnv, org) => `notify.urlEnv ${q(urlEnv)} has the shape of a notify hook of org '${org}', but another org's id also maps onto it by the longest-prefix rule, so it is not this org's — name one that ${L} lists`,
  pair: (authEnv, tokenEnv) => `notify.authEnv ${q(authEnv)} is not the token of the hook notify.urlEnv names — a hook's token goes only to its own URL: name ${tokenEnv}, or leave authEnv out`,
  unsetUrl: (urlEnv) => `notify.urlEnv ${urlEnv} is not set in the server's environment — name one that ${L} lists, or the server's operator sets it and restarts the server`,
  unsetToken: (authEnv) => `notify.authEnv ${authEnv} is not set in the server's environment — leave authEnv out, or the server's operator sets it and restarts the server`,
  badUrl: (urlEnv, tokenEnv) => `${urlEnv} does not hold an http(s) URL without user:password — the server's operator corrects its value and restarts the server (the server sends only Authorization: Bearer from ${tokenEnv}; a webhook that needs Basic auth is not supported)`,
  badToken: (authEnv) => `${authEnv} holds a value the server cannot send as a bearer token (printable ASCII without spaces, once surrounding whitespace is trimmed) — the server's operator corrects it and restarts the server`,
  originNoList: (urlEnv, org) => `the webhook in ${urlEnv} is not on this machine, and no notify origin is listed, so the server posts only to this machine — the server's operator lists that URL's origin (scheme://host[:port]) in OBSERVOGRAM_NOTIFY_ORIGINS or ${P(org)}NOTIFY_ORIGINS, comma-separated, and restarts the server`,
  originListed: (urlEnv, names) => `the webhook in ${urlEnv} is at an origin that is not in ${names.join(', nor in ')} — the server's operator adds that URL's origin (scheme://host[:port]) there and restarts the server`,
  runName: (journey, urlEnv, org) => RUN(journey, `its notify.urlEnv ${q(urlEnv)} is not a notify hook of org '${org}' — the server posts only to ${P(org)}NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from ${P(org)}NOTIFY_<HOOK>_TOKEN; whoever holds the workspace sets notify.urlEnv in ${J(journey)} to one that ${L} lists (packc journey run reads any name from its own environment)`),
  runShadow: (journey, urlEnv, org) => RUN(journey, `its notify.urlEnv ${q(urlEnv)} has the shape of a notify hook of org '${org}', but another org's id also maps onto it by the longest-prefix rule — whoever holds the workspace sets notify.urlEnv in ${J(journey)} to one that ${L} lists`),
  runPair: (journey, authEnv, tokenEnv) => RUN(journey, `its notify.authEnv ${q(authEnv)} is not the token of the hook its urlEnv names — a hook's token goes only to its own URL: whoever holds the workspace sets notify.authEnv in ${J(journey)} to ${tokenEnv}, or removes it`),
  runUnsetUrl: (journey, urlEnv) => RUN(journey, `its notify hook ${urlEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace sets notify.urlEnv in ${J(journey)} to one that ${L} lists`),
  runUnsetToken: (journey, authEnv) => RUN(journey, `its notify.authEnv ${authEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace removes notify.authEnv from ${J(journey)}`),
};

const ONCALL = hookVarsOf('acme', 'ONCALL');
const PAGER = hookVarsOf('acme', 'PAGER');
// An env whose every read throws: a step that reads before the names pass fails loudly (M5).
const THROWING_ENV = new Proxy({}, { get(_, k) { throw new Error(`env read before the names passed: ${String(k)}`); }, has() { throw new Error('env probed'); }, ownKeys() { throw new Error('env listed'); } });

// The enumerated deny-list (A.1.3), as notify.urlEnv in org acme: NAME unless marked.
const SERVER_SECRETS = ['OBSERVOGRAM_API_TOKEN', 'OBSERVOGRAM_SESSION_SECRET', 'OBSERVOGRAM_OIDC_CLIENT_SECRET', 'OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET', 'OBSERVOGRAM_ADMIN_PASSWORD', 'TOMOGRAPH_API_TOKEN'];
const DEPLOYMENT = ['GITHUB_TOKEN', 'DATABASE_URL', 'HOME', 'PATH'];
const OTHER_ORG = ['OBSERVOGRAM_ORG_BRAVO_MCP_TOKEN', 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL', 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_TOKEN'];
const LONGER_ORG = ['OBSERVOGRAM_ORG_ACME_EU_NOTIFY_X_URL'];
const OWN_NOT_HOOK = ['OBSERVOGRAM_ORG_ACME_MCP_TOKEN', 'OBSERVOGRAM_ORG_ACME_MCP_ORIGINS', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ONCALL_TOKEN'];
const LONG_201 = `OBSERVOGRAM_ORG_ACME_NOTIFY_${'X'.repeat(201 - 'OBSERVOGRAM_ORG_ACME_NOTIFY__URL'.length)}_URL`;
const SHAPE = ['observogram_org_acme_notify_oncall_url', 'OBSERVOGRAM_ORG_ACME_NOTIFY_oncall_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY__URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY__X_URL',
  'OBSERVOGRAM_ORG_ACME_NOTIFY_X__Y_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ONCALL_URL ', LONG_201];
const BARE = ['MY_JOURNEY_WEBHOOK_URL', 'SMOKE_HOOK_URL'];
const NAME_ROWS = [...SERVER_SECRETS, ...DEPLOYMENT, ...OTHER_ORG, ...LONGER_ORG, ...OWN_NOT_HOOK, ...SHAPE, ...BARE];

test('U1 names: every deny-list row is refused for acme with its text (NAME, SHADOW for a shadowed name and a KEY tie, both orgs unnamed), before any env read; an acme hook passes; the shape is exact upper case; a removed org still shadows; a refused name\'s text does not depend on whether its variable is set', async () => {
  const { db, close } = await freshStore(['acme', 'acme-eu', 'acme-notify-eu', 'bravo', 'a-b', 'a_b'], { removed: ['bravo-notify-old'] });
  try {
    assert.equal(LONG_201.length, 201);
    assert.equal(HOOK_RE.test('ON_CALL2'), true);
    for (const bad of ['', 'on', 'A__B', '_A', 'A_', 'A-B']) assert.equal(HOOK_RE.test(bad), false, bad);
    assert.deepEqual(ONCALL, { urlEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_ONCALL_URL', tokenEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_ONCALL_TOKEN' });
    assert.deepEqual(hookVarsOf('pay-eu', 'X'), { urlEnv: 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_X_URL', tokenEnv: 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_X_TOKEN' });
    // the org's own hook
    assert.deepEqual(notifyHookOf(db, ONCALL.urlEnv, 'acme'), { kind: 'hook', hook: 'ONCALL', ...ONCALL });
    for (const at of ['capture', 'run']) {
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', at, journey: 'j1' }), null, at);
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv }, { org: 'acme', at, journey: 'j1' }), null, `${at} with its token`);
    }
    const max = `OBSERVOGRAM_ORG_ACME_NOTIFY_${'X'.repeat(200 - 'OBSERVOGRAM_ORG_ACME_NOTIFY__URL'.length)}_URL`;
    assert.equal(notifyHookOf(db, max, 'acme').kind, 'hook', '200 characters is the bound');
    // every NAME row, as urlEnv, at capture and at run, and through both resolvers with an env that throws on any read
    for (const urlEnv of NAME_ROWS) {
      assert.equal(notifyHookOf(db, urlEnv, 'acme').kind, 'name', urlEnv);
      assert.equal(notifyNamesRefusal(db, { urlEnv }, { org: 'acme', at: 'capture' }), T.name(urlEnv, 'acme'), urlEnv);
      assert.equal(notifyNamesRefusal(db, { urlEnv }, { org: 'acme', at: 'run', journey: 'legacy' }), T.runName('legacy', urlEnv, 'acme'), urlEnv);
      assert.equal(captureNotifyRefusal(db, { urlEnv, authEnv: ONCALL.tokenEnv }, { org: 'acme', env: THROWING_ENV }), T.name(urlEnv, 'acme'), `${urlEnv}: no env read`);
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv }, { org: 'acme', journey: 'legacy', env: THROWING_ENV }), { refused: T.runName('legacy', urlEnv, 'acme') }, `${urlEnv}: no env read`);
    }
    // the mixed-case row passes ownership — only the shape refuses it (Windows reads process.env case-insensitively)
    assert.deepEqual(envNameOwnedBy(db, 'OBSERVOGRAM_ORG_ACME_NOTIFY_oncall_URL'), ['acme']);
    // SHADOW: acme-notify-eu owns OBSERVOGRAM_ORG_ACME_NOTIFY_EU_*; a-b and a_b tie; a removed org still owns its names
    const shadows = [
      ['OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL', 'acme', 'acme-notify-eu'],
      ['OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL', 'a-b', 'a_b'],
      ['OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL', 'a_b', 'a-b'],
      ['OBSERVOGRAM_ORG_BRAVO_NOTIFY_OLD_X_URL', 'bravo', 'bravo-notify-old'],
    ];
    for (const [urlEnv, org, other] of shadows) {
      assert.deepEqual(notifyHookOf(db, urlEnv, org), { kind: 'shadow' }, `${urlEnv} for ${org}`);
      const capture = notifyNamesRefusal(db, { urlEnv }, { org, at: 'capture' });
      const run = notifyNamesRefusal(db, { urlEnv }, { org, at: 'run', journey: 'j2' });
      assert.equal(capture, T.shadow(urlEnv, org));
      assert.equal(run, T.runShadow('j2', urlEnv, org));
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv }, { org, journey: 'j2', env: THROWING_ENV }), { refused: run }, 'no env read');
      for (const text of [capture, run]) assert.ok(!text.includes(`'${other}'`) && !text.includes(` ${other} `), `${text} names no other org`);
    }
    // a removed org's hook is no other org's
    assert.equal(notifyHookOf(db, 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_OLD_NOTIFY_X_URL', 'acme').kind, 'name');
    // as authEnv of acme's own hook, every name but the hook's own token is PAIR
    for (const authEnv of [...NAME_ROWS.filter((n) => n !== ONCALL.tokenEnv), PAGER.tokenEnv, 'OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_TOKEN']) {
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv }, { org: 'acme', at: 'capture' }), T.pair(authEnv, ONCALL.tokenEnv), authEnv);
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv }, { org: 'acme', journey: 'j3', env: THROWING_ENV }), { refused: T.runPair('j3', authEnv, ONCALL.tokenEnv) }, `${authEnv}: no env read`);
    }
    // the same text whether the refused variable is set or not: no existence oracle
    const bravoHook = 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL';
    const unset = captureNotifyRefusal(db, { urlEnv: bravoHook }, { org: 'acme', env: {} });
    assert.equal(unset, T.name(bravoHook, 'acme'));
    assert.equal(captureNotifyRefusal(db, { urlEnv: bravoHook }, { org: 'acme', env: { [bravoHook]: 'http://127.0.0.1:9/bravo' } }), unset);
    assert.equal(resolveJourneyNotify(db, { urlEnv: 'OBSERVOGRAM_API_TOKEN' }, { org: 'acme', journey: 'j', env: { OBSERVOGRAM_API_TOKEN: 'marker' } }).refused,
      resolveJourneyNotify(db, { urlEnv: 'OBSERVOGRAM_API_TOKEN' }, { org: 'acme', journey: 'j', env: {} }).refused);
    // bravo's own hook is bravo's
    assert.equal(notifyNamesRefusal(db, { urlEnv: bravoHook, authEnv: 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_TOKEN' }, { org: 'bravo', at: 'run', journey: 'b' }), null);
    assert.throws(() => notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', at: 'deploy' }), TypeError);
  } finally {
    close();
  }
});

test('U2 pairing: a hook\'s token goes only to its own URL — PAGER\'s token with ONCALL\'s URL is PAIR naming ONCALL\'s token, the org\'s MCP token is PAIR, no authEnv passes', async () => {
  const { db, close } = await freshStore(['acme']);
  try {
    const env = { [ONCALL.urlEnv]: 'http://127.0.0.1:9/oncall', [ONCALL.tokenEnv]: 'tok-oncall', [PAGER.urlEnv]: 'http://127.0.0.1:9/pager', [PAGER.tokenEnv]: 'tok-pager', OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'tok-mcp' };
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', env }), T.pair(PAGER.tokenEnv, ONCALL.tokenEnv));
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', journey: 'p', env }), { refused: T.runPair('p', PAGER.tokenEnv, ONCALL.tokenEnv) });
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { org: 'acme', env }), T.pair('OBSERVOGRAM_ORG_ACME_MCP_TOKEN', ONCALL.tokenEnv));
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', env }), null, 'no authEnv');
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', journey: 'p', env }), { refused: null, url: 'http://127.0.0.1:9/oncall', auth: null, urlEnv: ONCALL.urlEnv }, 'no token is sent without authEnv, though one is set');
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: PAGER.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', journey: 'p', env }), { refused: null, url: 'http://127.0.0.1:9/pager', auth: 'tok-pager', urlEnv: PAGER.urlEnv });
  } finally {
    close();
  }
});

test('U3 values: the URL is http(s), without user:password, at most 2000 characters; the token is printable ASCII without spaces once its surrounding HTTP whitespace is trimmed; unset is refused; no text carries a value or the origin', async () => {
  const { db, close } = await freshStore(['acme']);
  try {
    const at = (url, token, notify = { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv }) => {
      const env = {};
      if (url !== undefined) env[ONCALL.urlEnv] = url;
      if (token !== undefined) env[ONCALL.tokenEnv] = token;
      return { capture: captureNotifyRefusal(db, notify, { org: 'acme', env }), run: resolveJourneyNotify(db, notify, { org: 'acme', journey: 'v', env }) };
    };
    const base = 'http://127.0.0.1:9/';
    const long = (n) => `${base}${'a'.repeat(n - base.length)}`;
    // the URL
    for (const url of [undefined, '', '   \n']) {
      const r = at(url, 'tok');
      assert.equal(r.capture, T.unsetUrl(ONCALL.urlEnv), q(url));
      assert.deepEqual(r.run, { refused: T.runUnsetUrl('v', ONCALL.urlEnv) }, q(url));
    }
    const badUrls = ['not a url', 'ftp://127.0.0.1/x', 'data:text/plain,x', 'http://dbuser:dbpass@127.0.0.1:5432/prod-db', 'http://dbuser@127.0.0.1/', long(2001), 'javascript:alert(1)'];
    for (const url of badUrls) {
      const r = at(url, 'tok');
      assert.equal(r.capture, T.badUrl(ONCALL.urlEnv, ONCALL.tokenEnv), url.slice(0, 40));
      assert.deepEqual(r.run, { refused: RUN('v', T.badUrl(ONCALL.urlEnv, ONCALL.tokenEnv)) }, url.slice(0, 40));
      for (const secret of ['dbuser', 'dbpass', 'prod-db', 'not a url', 'aaaa']) assert.ok(!r.capture.includes(secret), secret);
    }
    assert.equal(at(long(2000), 'tok').capture, null, '2000 characters is the bound');
    assert.equal(at(`${base}h#frag`, 'tok').capture, null, 'a fragment is allowed (fetch never sends it)');
    assert.equal(at('  http://127.0.0.1:9/h \n', 'tok').run.url, 'http://127.0.0.1:9/h', 'the value is trimmed');
    // the token
    for (const token of ['tok\n', 'tok\r\n', ' tok\t', '\r\n tok \t']) {
      const r = at(`${base}h`, token);
      assert.equal(r.capture, null, q(token));
      assert.equal(r.run.auth, 'tok', `${q(token)} is sent trimmed`);
    }
    for (const token of [undefined, '', ' \r\n\t']) {
      const r = at(`${base}h`, token);
      assert.equal(r.capture, T.unsetToken(ONCALL.tokenEnv), q(token));
      assert.deepEqual(r.run, { refused: T.runUnsetToken('v', ONCALL.tokenEnv) }, q(token));
    }
    for (const token of ['to\nk-secret', '\0', 'tok secret', 'tók-secret', 'tok x', 'x'.repeat(4097)]) {
      const r = at(`${base}h`, token);
      assert.equal(r.capture, T.badToken(ONCALL.tokenEnv), q(token).slice(0, 30));
      assert.deepEqual(r.run, { refused: RUN('v', T.badToken(ONCALL.tokenEnv)) });
      assert.ok(!r.capture.includes('secret') && !r.capture.includes('127.0.0.1'));
    }
    assert.equal(at(`${base}h`, 'x'.repeat(4096)).capture, null, '4096 characters is the bound');
    // the URL is checked before the token
    assert.equal(at('ftp://x/', undefined).capture, T.badUrl(ONCALL.urlEnv, ONCALL.tokenEnv));
  } finally {
    close();
  }
});

test('U4 the notify origin list: loopback passes with no list, any other origin needs one (deployment, org, legacy spelling, `*`); a list of rejected entries allows nothing; a note names an entry\'s position, never the entry; the org\'s list counts only for its sole owner', async () => {
  const { db, close } = await freshStore(['acme']);
  try {
    assert.equal(NOTIFY_ORIGINS_VAR, 'OBSERVOGRAM_NOTIFY_ORIGINS');
    assert.equal(ORG_NOTIFY_ORIGINS_NAME, 'NOTIFY_ORIGINS');
    assert.equal(orgNotifyOriginsVar('pay-eu'), 'OBSERVOGRAM_ORG_PAY_EU_NOTIFY_ORIGINS');
    const far = 'https://hooks.far.test/services/abc';
    const decide = (url, extra = {}) => captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', env: { [ONCALL.urlEnv]: url, ...extra } });
    // a pasted webhook URL in a list: noted by position, the entry and its host never on stderr (first, so the note is fresh)
    let said = await stderrOf(() => assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://hooks.slack.com/services/T0/B0/SECRET' }), T.originListed(ONCALL.urlEnv, ['OBSERVOGRAM_NOTIFY_ORIGINS'])));
    assert.equal(said, '[notify-origins] OBSERVOGRAM_NOTIFY_ORIGINS: entry 1 is a URL, not an origin — list only its scheme://host[:port]\n');
    assert.ok(!said.includes('SECRET') && !said.includes('hooks.slack.com'));
    // no list: loopback only
    for (const url of ['http://127.0.0.1:9/h', 'http://localhost:9/h', 'http://[::1]:9/h', 'http://[::ffff:127.0.0.1]:9/h', 'https://127.1.2.3/h']) assert.equal(decide(url), null, url);
    assert.deepEqual(notifyOriginList(db, 'acme', {}), { set: false });
    assert.deepEqual(notifyOriginList(db, 'acme', { OBSERVOGRAM_NOTIFY_ORIGINS: '  ' }), { set: false });
    const noList = decide(far);
    assert.equal(noList, T.originNoList(ONCALL.urlEnv, 'acme'));
    assert.ok(!noList.includes('hooks.far.test'), 'the origin is never named');
    // the deployment's list, the org's, the legacy spelling, `*`
    assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://other.test, https://HOOKS.far.test:443' }), null);
    assert.equal(decide(far, { OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'https://hooks.far.test' }), null);
    assert.equal(decide(far, { TOMOGRAPH_NOTIFY_ORIGINS: 'https://hooks.far.test' }), null, 'the legacy spelling (brand-env)');
    assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://other.test' }), T.originListed(ONCALL.urlEnv, ['OBSERVOGRAM_NOTIFY_ORIGINS']));
    assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://other.test', OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'https://other2.test' }),
      T.originListed(ONCALL.urlEnv, ['OBSERVOGRAM_NOTIFY_ORIGINS', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS']));
    assert.equal(decide('http://hooks.far.test/x', { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://hooks.far.test' }), T.originListed(ONCALL.urlEnv, ['OBSERVOGRAM_NOTIFY_ORIGINS']), 'the scheme is part of the origin');
    assert.deepEqual(notifyOriginList(db, 'acme', { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://g.test', OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'https://a.test' }),
      { set: true, any: false, origins: new Set(['https://g.test', 'https://a.test']), from: ['deployment', 'org'], names: ['OBSERVOGRAM_NOTIFY_ORIGINS', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS'] });
    said = await stderrOf(() => assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: '*' }), null));
    assert.equal(said, '[notify-origins] every notify origin is allowed (OBSERVOGRAM_NOTIFY_ORIGINS=*)\n');
    said = await stderrOf(() => assert.equal(decide(far, { OBSERVOGRAM_NOTIFY_ORIGINS: '*' }), null));
    assert.equal(said, '', 'once per process');
    // a list set with no accepted entry allows nothing
    said = await stderrOf(() => assert.equal(decide(far, { OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'hooks.far.test, https://*.far.test' }), T.originListed(ONCALL.urlEnv, ['OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS'])));
    assert.equal(said, '[notify-origins] OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: entry 1 is not an origin (http(s)://host[:port])\n[notify-origins] OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: entry 2 is not an origin (http(s)://host[:port])\n');
    assert.ok(!said.includes('far.test'));
    // loopback passes whatever the list says
    assert.equal(decide('http://127.0.0.1:9/h', { OBSERVOGRAM_NOTIFY_ORIGINS: 'https://other.test' }), null);
  } finally {
    close();
  }
  // The owner case (M7): with org acme-notify present, OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS is acme-notify's name, so acme never reads it.
  const second = await freshStore(['acme', 'acme-notify']);
  try {
    assert.deepEqual(envNameOwnedBy(second.db, 'OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS'), ['acme-notify']);
    assert.deepEqual(notifyOriginList(second.db, 'acme', { OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'https://hooks.far.test' }), { set: false });
  } finally {
    second.close();
  }
});

test('U5 resolveJourneyNotify and captureNotifyRefusal: the trimmed values on success; an unset hook and a set but unlisted hook refused at capture; notifyPostureRefusal answers a notifying run without sign-in as the live MCP API would', async () => {
  const { db, close } = await freshStore(['acme']);
  try {
    const env = { [ONCALL.urlEnv]: ' http://127.0.0.1:9/oncall?k=v ', [ONCALL.tokenEnv]: '\ttok-oncall\r\n' };
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv, on: 'always' }, { org: 'acme', journey: 'ok', env }),
      { refused: null, url: 'http://127.0.0.1:9/oncall?k=v', auth: 'tok-oncall', urlEnv: ONCALL.urlEnv });
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv }, { org: 'acme', env }), null);
    assert.equal(captureNotifyRefusal(db, { urlEnv: PAGER.urlEnv }, { org: 'acme', env }), T.unsetUrl(PAGER.urlEnv), 'an unset hook is refused at capture');
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', env: { [ONCALL.urlEnv]: 'https://hooks.far.test/x' } }), T.originNoList(ONCALL.urlEnv, 'acme'), 'a set hook whose origin is not listed');
    // the posture (N11 (a)): signed-in postures are not this rule's; without sign-in, a direct request only, never exposed
    const local = { kind: 'local', actor: 'local', role: 'admin', owner: true };
    const caller = (extra) => ({ principal: local, org: 'acme', port: 8123, posture: 'open-loopback', direct: true, authOff: false, ...extra });
    for (const posture of ['identity', 'token']) assert.equal(notifyPostureRefusal(caller({ posture, direct: false, principal: { kind: 'session', actor: 'oscar', role: 'operator', owner: false } })), null, posture);
    assert.equal(notifyPostureRefusal(caller()), null, 'a direct loopback request');
    assert.deepEqual(notifyPostureRefusal(caller({ direct: false })), {
      status: 403, denied: 'posture',
      error: 'on a server without sign-in running a journey that notifies answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:8123',
    });
    assert.deepEqual(notifyPostureRefusal(caller({ posture: 'open-exposed', host: '0.0.0.0', authOff: true })), {
      status: 403, denied: 'posture',
      error: 'running a journey that notifies is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback',
    });
    assert.match(notifyPostureRefusal(caller({ posture: 'open-exposed', direct: true })).error, /^running a journey that notifies is closed on a server bound to a non-loopback address without sign-in \(OBSERVOGRAM_INSECURE_NO_AUTH=1\): add the first user/);
  } finally {
    close();
  }
});

test('U6 isOrgHookShaped: the URL or TOKEN shape of any org\'s hook, live or removed, whoever owns the name; an MCP token and the org\'s origin list are not', async () => {
  const { db, close } = await freshStore(['acme', 'acme-notify', 'bravo'], { removed: ['gone'] });
  try {
    for (const name of [ONCALL.urlEnv, ONCALL.tokenEnv, 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_X_URL', 'OBSERVOGRAM_ORG_GONE_NOTIFY_X_TOKEN', 'OBSERVOGRAM_ORG_ACME_NOTIFY_MCP_TOKEN']) assert.equal(isOrgHookShaped(db, name), true, name);
    // acme-notify owns OBSERVOGRAM_ORG_ACME_NOTIFY_ONCALL_TOKEN by the general rule — it is still a hook's shape (acme's), so neither org reads it as an MCP token (C-F7)
    assert.deepEqual(envNameOwnedBy(db, ONCALL.tokenEnv), ['acme-notify']);
    for (const name of ['OBSERVOGRAM_ORG_ACME_MCP_TOKEN', 'OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS', 'OBSERVOGRAM_ORG_ACME_NOTIFY_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_x_TOKEN', 'OBSERVOGRAM_ORG_NOBODY_NOTIFY_X_URL', 'OBSERVOGRAM_API_TOKEN', null]) {
      assert.equal(isOrgHookShaped(db, name), false, String(name));
    }
  } finally {
    close();
  }
});

test('U7 notifyHooksOf and notifyBootReport: the org\'s set hooks sorted, tokenEnv null when its token is unset, usable or the capture problem, a shadowed name left out, `none` when there are none; the boot lines; never a value, an origin or a list entry', async () => {
  const { db, close } = await freshStore(['acme', 'acme-eu', 'acme-notify-eu', 'bravo']);
  try {
    const env = {
      [ONCALL.urlEnv]: 'http://127.0.0.1:9/oncall-path', [ONCALL.tokenEnv]: 'tok-oncall-secret',
      [PAGER.urlEnv]: 'http://localhost:9/pager-path', [PAGER.tokenEnv]: '  ',
      OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL: 'http://dbuser:dbpass@127.0.0.1:9/bad-path',
      OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL: 'https://hooks.far.test/far-path',
      OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL: 'http://127.0.0.1:9/shadow-path',
      OBSERVOGRAM_ORG_ACME_NOTIFY_EMPTY_URL: '',
      OBSERVOGRAM_ORG_ACME_NOTIFY_oncall_URL: 'http://127.0.0.1:9/mixed-path',
      OBSERVOGRAM_ORG_ACME_EU_NOTIFY_Y_URL: 'http://127.0.0.1:9/eu-path',
      OBSERVOGRAM_ORG_NOBODY_NOTIFY_X_URL: 'http://nobody.test/nobody-path',
      OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS: 'https://hooks.slack.com/services/T0/B0/LISTSECRET',
    };
    const acme = await (async () => { let r; await stderrOf(() => { r = notifyHooksOf(db, 'acme', env); }); return r; })();
    assert.deepEqual(acme, {
      org: 'acme',
      pattern: 'OBSERVOGRAM_ORG_ACME_NOTIFY_<HOOK>_URL',
      hooks: [
        { hook: 'BAD', urlEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', tokenEnv: null, usable: false, problem: T.badUrl('OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_TOKEN') },
        { hook: 'FAR', urlEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', tokenEnv: null, usable: false, problem: T.originListed('OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', ['OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS']) },
        { hook: 'ONCALL', ...ONCALL, usable: true, problem: null },
        { hook: 'PAGER', urlEnv: PAGER.urlEnv, tokenEnv: null, usable: true, problem: null },
      ],
      none: null,
    });
    assert.deepEqual(notifyHooksOf(db, 'acme-eu', env).hooks.map((h) => h.urlEnv), ['OBSERVOGRAM_ORG_ACME_EU_NOTIFY_Y_URL'], 'acme-eu\'s own, never acme\'s');
    assert.deepEqual(notifyHooksOf(db, 'acme-notify-eu', env).hooks, [], 'the shadowing org has no hook of that name either');
    assert.deepEqual(notifyHooksOf(db, 'bravo', env), {
      org: 'bravo', pattern: 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_URL', hooks: [],
      none: "no notify hook is set for org 'bravo' — the server's operator sets OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_URL (and OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_TOKEN when the webhook takes a bearer token) in the server's environment and restarts the server",
    });
    let lines;
    const said = await stderrOf(() => { lines = notifyBootReport(db, env); });
    assert.deepEqual(lines, [
      `[notify-hooks] org 'acme': OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL — ${T.badUrl('OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_TOKEN')}`,
      `[notify-hooks] org 'acme': OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL — ${T.originListed('OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', ['OBSERVOGRAM_ORG_ACME_NOTIFY_ORIGINS'])}`,
      "[notify-hooks] OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL has the shape of org 'acme''s notify hook, but org 'acme-notify-eu' also maps onto it by the longest-prefix rule — no journey can use it",
      "[notify-hooks] OBSERVOGRAM_ORG_NOBODY_NOTIFY_X_URL is no org's notify hook (no org's id maps onto it)",
    ]);
    const everything = JSON.stringify([acme, notifyHooksOf(db, 'acme-eu', env), lines]) + said;
    for (const secret of ['-path', 'tok-oncall-secret', 'dbuser', 'dbpass', 'hooks.far.test', 'nobody.test', '127.0.0.1', 'localhost', 'LISTSECRET', 'hooks.slack.com']) {
      assert.ok(!everything.includes(secret), `${secret} is never in the listing, the report or a note`);
    }
    // nothing set, nothing said; a tie names both orgs to the server's operator
    assert.deepEqual(notifyBootReport(db, {}), []);
    assert.deepEqual(notifyBootReport(db, { [ONCALL.urlEnv]: 'http://127.0.0.1:9/h', OBSERVOGRAM_API_TOKEN: 'x' }), []);
    const tie = await freshStore(['a-b', 'a_b'], { removed: ['gone'] });
    try {
      assert.deepEqual(notifyBootReport(tie.db, { OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL: 'http://127.0.0.1:9/h', OBSERVOGRAM_ORG_GONE_NOTIFY_X_URL: 'http://127.0.0.1:9/h' }), [
        "[notify-hooks] OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL has the shape of org 'a-b''s notify hook, but org 'a_b' also maps onto it by the longest-prefix rule — no journey can use it",
        "[notify-hooks] OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL has the shape of org 'a_b''s notify hook, but org 'a-b' also maps onto it by the longest-prefix rule — no journey can use it",
        "[notify-hooks] OBSERVOGRAM_ORG_GONE_NOTIFY_X_URL is no org's notify hook (only a removed org's id maps onto it)",
      ]);
    } finally {
      tie.close();
    }
    assert.equal(NOTIFY_HOOKS_ROUTE, L);
    assert.equal(typeof policy.notifyValueRefusal, 'function');
  } finally {
    close();
  }
});

// ---------- over HTTP: the hooks listing and the boot report (children) ----------
//
// Each server is a child (server/fixtures/serve-child.mjs: an explicit env,
// this process's minus STRIP and every OBSERVOGRAM_ORG_*, plus the test's
// own). The orgs are planted through the orgs file (the import N9's guard
// does not cover): acme {ada admin, oscar operator, vera viewer}, acme-eu {},
// acme-notify-eu {} — which owns OBSERVOGRAM_ORG_ACME_NOTIFY_EU_* by the
// longest prefix —, bravo {bob admin}, default {olive admin, the owner}.

const { serve, signIn } = await import('./fixtures/serve-child.mjs');
const { writeUsersFile, writeOrgsFile } = await import('./store/legacy-files.mjs');
const { hashPassword } = await import('./auth.mjs');

const BEARER_TOKEN = 'notify-bearer-marker-0123456789';
const LOGINS = ['ada', 'oscar', 'vera', 'bob', 'olive'];
const pw = (login) => `${login}-passw0rd-notify`;
function identityWorkspace() {
  const ws = mkdtempSync(join(tmpdir(), 'observogram-notify-http-'));
  tmpDirs.push(ws);
  writeUsersFile({ users: Object.fromEntries(LOGINS.map((l) => [l, { name: l, createdAt: 'test', password: hashPassword(pw(l)) }])) }, join(ws, 'users.json'));
  writeOrgsFile({
    default: { name: 'Default', members: { olive: 'admin' } },
    acme: { name: 'Acme', members: { ada: 'admin', oscar: 'operator', vera: 'viewer' } },
    'acme-eu': { name: 'Acme EU', members: {} },
    'acme-notify-eu': { name: 'Acme Notify EU', members: {} },
    bravo: { name: 'Bravo', members: { bob: 'admin' } },
  }, join(ws, 'orgs.json'));
  return ws;
}
// The values the children hold: every marker below is a part of a value that
// must never leave the server but toward its own webhook.
const HOOK_ENV = {
  [ONCALL.urlEnv]: 'http://127.0.0.1:9/acme-oncall-path-marker',
  [ONCALL.tokenEnv]: 'tok-acme-oncall-marker',
  [PAGER.urlEnv]: 'http://localhost:9/acme-pager-path-marker',
  OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL: 'http://dbuser-marker:dbpass-marker@127.0.0.1:9/bad-path-marker',
  OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL: 'https://far-host-marker.test/far-path-marker',
  OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL: 'http://127.0.0.1:9/shadow-path-marker',
  OBSERVOGRAM_ORG_NOBODY_NOTIFY_X_URL: 'http://nobody-host-marker.test/nobody-path-marker',
  OBSERVOGRAM_ORG_BRAVO_MCP_TOKEN: 'tok-bravo-mcp-marker',
};
const MARKERS = ['-marker', 'dbuser', 'far-host', 'nobody-host'];
const ACME_LISTING = {
  ok: true,
  org: 'acme',
  pattern: 'OBSERVOGRAM_ORG_ACME_NOTIFY_<HOOK>_URL',
  hooks: [
    { hook: 'BAD', urlEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', tokenEnv: null, usable: false, problem: T.badUrl('OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_TOKEN') },
    { hook: 'FAR', urlEnv: 'OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', tokenEnv: null, usable: false, problem: T.originNoList('OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', 'acme') },
    { hook: 'ONCALL', ...ONCALL, usable: true, problem: null },
    { hook: 'PAGER', urlEnv: PAGER.urlEnv, tokenEnv: null, usable: true, problem: null },
  ],
  none: null,
};
const getJson = async (base, path, headers = {}) => {
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const noMarkerIn = (where, text) => { for (const m of MARKERS) assert.ok(!text.includes(m), `${where}: ${m} never appears`); };

test('H14 GET /api/journeys/notify-hooks: a viewer, an operator, the bearer and the anonymous local caller read their org\'s hooks — names, usable or the problem, a shadowed name left out; bravo\'s listing says who sets one; no value, origin or other org in any body', { timeout: 120_000 }, async () => {
  const children = [];
  try {
    const srv = await serve(identityWorkspace(), { env: { ...HOOK_ENV, OBSERVOGRAM_API_TOKEN: BEARER_TOKEN, OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' } });
    children.push(srv);
    const cookie = async (login) => { const s = await signIn(srv.base, login, pw(login)); assert.equal(s.status, 200, `${login} signs in`); return s.session; };
    const bodies = [];
    for (const [who, headers] of [
      ['vera (viewer)', { Cookie: await cookie('vera') }],
      ['oscar (operator)', { Cookie: await cookie('oscar'), 'X-Observogram-Org': 'acme' }],
      ['the bearer', { Authorization: `Bearer ${BEARER_TOKEN}`, 'X-Observogram-Org': 'acme' }],
    ]) {
      const r = await getJson(srv.base, '/api/journeys/notify-hooks', headers);
      assert.equal(r.status, 200, `${who}: ${r.text}`);
      assert.deepEqual(r.json, ACME_LISTING, who);
      bodies.push(r.text);
    }
    const bravo = await getJson(srv.base, '/api/journeys/notify-hooks', { Cookie: await cookie('bob') });
    assert.deepEqual(bravo.json, {
      ok: true, org: 'bravo', pattern: 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_URL', hooks: [],
      none: "no notify hook is set for org 'bravo' — the server's operator sets OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_URL (and OBSERVOGRAM_ORG_BRAVO_NOTIFY_<HOOK>_TOKEN when the webhook takes a bearer token) in the server's environment and restarts the server",
    });
    bodies.push(bravo.text);
    // the anonymous local caller without sign-in: the open posture acts in the default org
    const openWs = mkdtempSync(join(tmpdir(), 'observogram-notify-open-'));
    tmpDirs.push(openWs);
    const open = await serve(openWs, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_ORG_DEFAULT_NOTIFY_LOCAL_URL: 'http://127.0.0.1:9/local-path-marker', ...HOOK_ENV } });
    children.push(open);
    const local = await getJson(open.base, '/api/journeys/notify-hooks');
    assert.equal(local.status, 200, local.text);
    assert.deepEqual(local.json, {
      ok: true, org: 'default', pattern: 'OBSERVOGRAM_ORG_DEFAULT_NOTIFY_<HOOK>_URL',
      hooks: [{ hook: 'LOCAL', urlEnv: 'OBSERVOGRAM_ORG_DEFAULT_NOTIFY_LOCAL_URL', tokenEnv: null, usable: true, problem: null }], none: null,
    });
    bodies.push(local.text);
    for (const [i, text] of bodies.entries()) {
      noMarkerIn(`body ${i}`, text);
      for (const other of ['acme-eu', 'acme-notify-eu', 'NOTIFY_EU_X', 'NOBODY', 'BRAVO_MCP', '127.0.0.1', 'localhost']) assert.ok(!text.includes(other), `body ${i}: ${other} never appears`);
    }
    for (const c of children) { const { stdout, stderr } = c.logs(); noMarkerIn('the children\'s output', stdout + stderr); }
  } finally {
    for (const c of children) await c.stop();
  }
});

test('H15 the start reports each set hook a run would refuse, a name another org\'s id shadows and a name no org owns — one [notify-hooks] line each, never a value; nothing for a usable hook', { timeout: 120_000 }, async () => {
  const srv = await serve(identityWorkspace(), { verbose: true, env: { ...HOOK_ENV, OBSERVOGRAM_API_TOKEN: BEARER_TOKEN } });
  try {
    // stderr and stdout are two pipes: the start's lines may land after LISTENING.
    for (let i = 0; i < 100 && !srv.logs().stderr.includes("no org's id maps onto it"); i++) await new Promise((r) => setTimeout(r, 50));
    const { stdout, stderr } = srv.logs();
    assert.deepEqual(stderr.split('\n').filter((l) => l.startsWith('[notify-hooks]')), [
      `[notify-hooks] org 'acme': OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL — ${T.badUrl('OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_URL', 'OBSERVOGRAM_ORG_ACME_NOTIFY_BAD_TOKEN')}`,
      `[notify-hooks] org 'acme': OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL — ${T.originNoList('OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL', 'acme')}`,
      "[notify-hooks] OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL has the shape of org 'acme''s notify hook, but org 'acme-notify-eu' also maps onto it by the longest-prefix rule — no journey can use it",
      "[notify-hooks] OBSERVOGRAM_ORG_NOBODY_NOTIFY_X_URL is no org's notify hook (no org's id maps onto it)",
    ]);
    assert.match(stdout, /\[studio\] listening on /, 'a verbose start');
    noMarkerIn('stdout and stderr', stdout + stderr);
  } finally {
    await srv.stop();
  }
});
