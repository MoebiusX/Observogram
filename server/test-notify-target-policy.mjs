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

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
for (const k of Object.keys(process.env)) if (k.startsWith('OBSERVOGRAM_ORG_')) delete process.env[k];
const { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } = await import('node:fs');
const { createServer } = await import('node:http');
const { networkInterfaces, tmpdir } = await import('node:os');
const { dirname, join, resolve } = await import('node:path');
const { fileURLToPath } = await import('node:url');
const policy = await import('./notify-target-policy.mjs');
const {
  NOTIFY_ORIGINS_VAR, ORG_NOTIFY_ORIGINS_NAME, HOOK_RE, NOTIFY_HOOKS_ROUTE, orgNotifyOriginsVar, hookVarsOf,
  notifyHookOf, isOrgHookShaped, notifyNamesRefusal, notifyOriginList, resolveJourneyNotify, captureNotifyRefusal,
  notifyHooksOf, notifyBootReport, notifyPostureRefusal,
} = policy;
const { closeStore, openRaw, openStore, prepare } = await import('./store/db.mjs');
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
// J: the journey's file as a run text names it — relative to the workspace, in the org's root (the default
// org's is the base, any other org's orgs/<id>): the file the run loaded, whose stem the definition's name: need not match.
const J = (stem, org = 'acme') => `${org === 'default' ? '' : `orgs/${org}/`}journeys/${stem}.journey.yaml`;
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
  runName: (journey, urlEnv, org, file = J(journey, org)) => RUN(journey, `its notify.urlEnv ${q(urlEnv)} is not a notify hook of org '${org}' — the server posts only to ${P(org)}NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from ${P(org)}NOTIFY_<HOOK>_TOKEN; whoever holds the workspace sets notify.urlEnv in ${file} to one that ${L} lists (packc journey run reads any name from its own environment)`),
  runShadow: (journey, urlEnv, org, file = J(journey, org)) => RUN(journey, `its notify.urlEnv ${q(urlEnv)} has the shape of a notify hook of org '${org}', but another org's id also maps onto it by the longest-prefix rule — whoever holds the workspace sets notify.urlEnv in ${file} to one that ${L} lists`),
  runPair: (journey, authEnv, tokenEnv, file = J(journey)) => RUN(journey, `its notify.authEnv ${q(authEnv)} is not the token of the hook its urlEnv names — a hook's token goes only to its own URL: whoever holds the workspace sets notify.authEnv in ${file} to ${tokenEnv}, or removes it`),
  runUnsetUrl: (journey, urlEnv, file = J(journey)) => RUN(journey, `its notify hook ${urlEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace sets notify.urlEnv in ${file} to one that ${L} lists`),
  runUnsetToken: (journey, authEnv, file = J(journey)) => RUN(journey, `its notify.authEnv ${authEnv} is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace removes notify.authEnv from ${file}`),
  // every hook name of the org taken by another org's id (a KEY tie, or an id whose prefix is <P>NOTIFY_)
  taken: (urlEnv, org) => `notify.urlEnv ${q(urlEnv)} cannot be a notify hook of org '${org}' — another org's id also maps onto every ${P(org)}NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys: leave notify out`,
  runTaken: (journey, urlEnv, org, file = J(journey, org)) => RUN(journey, `its notify.urlEnv ${q(urlEnv)} cannot be a notify hook of org '${org}' — another org's id also maps onto every ${P(org)}NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys; whoever holds the workspace removes notify from ${file} (packc journey run reads any name from its own environment)`),
  noneTaken: (org) => `no notify hook can be set for org '${org}' — another org's id also maps onto every ${P(org)}NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys: whoever holds the workspace leaves notify out of them`,
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

test('U1 names: every deny-list row is refused for acme with its text (NAME, SHADOW for a shadowed name, the other org unnamed; an org whose every hook name another org\'s id takes — a KEY tie, an id <org>-notify — one sentence for any name, whose way out is to leave notify out), before any env read; an acme hook passes; the shape is exact upper case; a removed org still shadows; a refused name\'s text does not depend on whether its variable is set', async () => {
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
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', at, journey: 'j1', file: J('j1') }), null, at);
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv }, { org: 'acme', at, journey: 'j1', file: J('j1') }), null, `${at} with its token`);
    }
    const max = `OBSERVOGRAM_ORG_ACME_NOTIFY_${'X'.repeat(200 - 'OBSERVOGRAM_ORG_ACME_NOTIFY__URL'.length)}_URL`;
    assert.equal(notifyHookOf(db, max, 'acme').kind, 'hook', '200 characters is the bound');
    // every NAME row, as urlEnv, at capture and at run, and through both resolvers with an env that throws on any read
    for (const urlEnv of NAME_ROWS) {
      assert.equal(notifyHookOf(db, urlEnv, 'acme').kind, 'name', urlEnv);
      assert.equal(notifyNamesRefusal(db, { urlEnv }, { org: 'acme', at: 'capture' }), T.name(urlEnv, 'acme'), urlEnv);
      assert.equal(notifyNamesRefusal(db, { urlEnv }, { org: 'acme', at: 'run', journey: 'legacy', file: J('legacy') }), T.runName('legacy', urlEnv, 'acme'), urlEnv);
      assert.equal(captureNotifyRefusal(db, { urlEnv, authEnv: ONCALL.tokenEnv }, { org: 'acme', env: THROWING_ENV }), T.name(urlEnv, 'acme'), `${urlEnv}: no env read`);
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv }, { org: 'acme', journey: 'legacy', file: J('legacy'), env: THROWING_ENV }), { refused: T.runName('legacy', urlEnv, 'acme') }, `${urlEnv}: no env read`);
    }
    // the mixed-case row passes ownership — only the shape refuses it (Windows reads process.env case-insensitively)
    assert.deepEqual(envNameOwnedBy(db, 'OBSERVOGRAM_ORG_ACME_NOTIFY_oncall_URL'), ['acme']);
    // SHADOW: acme-notify-eu owns OBSERVOGRAM_ORG_ACME_NOTIFY_EU_*; a removed org still owns its names
    const shadows = [
      ['OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL', 'acme', 'acme-notify-eu'],
      ['OBSERVOGRAM_ORG_BRAVO_NOTIFY_OLD_X_URL', 'bravo', 'bravo-notify-old'],
    ];
    for (const [urlEnv, org, other] of shadows) {
      assert.deepEqual(notifyHookOf(db, urlEnv, org), { kind: 'shadow' }, `${urlEnv} for ${org}`);
      const capture = notifyNamesRefusal(db, { urlEnv }, { org, at: 'capture' });
      const run = notifyNamesRefusal(db, { urlEnv }, { org, at: 'run', journey: 'j2', file: J('j2', org) });
      assert.equal(capture, T.shadow(urlEnv, org));
      assert.equal(run, T.runShadow('j2', urlEnv, org));
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv }, { org, journey: 'j2', file: J('j2', org), env: THROWING_ENV }), { refused: run }, 'no env read');
      for (const text of [capture, run]) assert.ok(!text.includes(`'${other}'`) && !text.includes(` ${other} `), `${text} names no other org`);
    }
    // Every hook name taken: a KEY tie (a-b, a_b), or an id whose prefix is the org's <P>NOTIFY_ (pay-notify
    // beside pay; a removed rem_notify beside rem — ids are never reused). No name is ever the org's, whatever
    // the operator sets, so no text sends anyone to the listing: any refused name — shadowed or not — gets the
    // one sentence whose way out is to leave notify out, naming no other org, before any env read.
    const taken = await freshStore(['pay', 'pay-notify', 'rem'], { removed: ['rem_notify'] });
    try {
      const takenOrgs = [[db, 'a-b', 'a_b'], [db, 'a_b', 'a-b'], [taken.db, 'pay', 'pay-notify'], [taken.db, 'rem', 'rem_notify']];
      for (const [store, org, other] of takenOrgs) {
        for (const hook of ['ONCALL', 'X', 'NOTIFY', 'ZZZ_1']) assert.deepEqual(notifyHookOf(store, `${P(org)}NOTIFY_${hook}_URL`, org), { kind: 'shadow' }, `${org} ${hook}`);
        for (const urlEnv of [`${P(org)}NOTIFY_ONCALL_URL`, `${P(org)}NOTIFY_ZZZ_1_URL`, 'OBSERVOGRAM_API_TOKEN', 'MY_JOURNEY_WEBHOOK_URL', `${P(org)}MCP_TOKEN`]) {
          const capture = notifyNamesRefusal(store, { urlEnv }, { org, at: 'capture' });
          const run = notifyNamesRefusal(store, { urlEnv, authEnv: 'OBSERVOGRAM_API_TOKEN' }, { org, at: 'run', journey: 'j4', file: J('j4', org) });
          assert.equal(capture, T.taken(urlEnv, org), `${org}: ${urlEnv}`);
          assert.equal(run, T.runTaken('j4', urlEnv, org), `${org}: ${urlEnv}`);
          assert.equal(captureNotifyRefusal(store, { urlEnv }, { org, env: THROWING_ENV }), capture, `${org}: ${urlEnv}: no env read`);
          assert.deepEqual(resolveJourneyNotify(store, { urlEnv }, { org, journey: 'j4', file: J('j4', org), env: THROWING_ENV }), { refused: run }, `${org}: ${urlEnv}: no env read`);
          for (const text of [capture, run]) {
            assert.ok(!text.includes(L), `${text}: never the listing, which can never hold one`);
            assert.ok(!text.includes(`'${other}'`) && !text.includes(` ${other} `), `${text} names no other org`);
          }
        }
      }
      // the org whose prefix takes them has hooks of its own
      assert.equal(notifyNamesRefusal(taken.db, { urlEnv: 'OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL' }, { org: 'pay-notify', at: 'run', journey: 'j4', file: J('j4', 'pay-notify') }), null);
    } finally {
      taken.close();
    }
    // a removed org's hook is no other org's
    assert.equal(notifyHookOf(db, 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_OLD_NOTIFY_X_URL', 'acme').kind, 'name');
    // as authEnv of acme's own hook, every name but the hook's own token is PAIR
    for (const authEnv of [...NAME_ROWS.filter((n) => n !== ONCALL.tokenEnv), PAGER.tokenEnv, 'OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_TOKEN']) {
      assert.equal(notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv }, { org: 'acme', at: 'capture' }), T.pair(authEnv, ONCALL.tokenEnv), authEnv);
      assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv }, { org: 'acme', journey: 'j3', file: J('j3'), env: THROWING_ENV }), { refused: T.runPair('j3', authEnv, ONCALL.tokenEnv) }, `${authEnv}: no env read`);
    }
    // the same text whether the refused variable is set or not: no existence oracle
    const bravoHook = 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL';
    const unset = captureNotifyRefusal(db, { urlEnv: bravoHook }, { org: 'acme', env: {} });
    assert.equal(unset, T.name(bravoHook, 'acme'));
    assert.equal(captureNotifyRefusal(db, { urlEnv: bravoHook }, { org: 'acme', env: { [bravoHook]: 'http://127.0.0.1:9/bravo' } }), unset);
    assert.equal(resolveJourneyNotify(db, { urlEnv: 'OBSERVOGRAM_API_TOKEN' }, { org: 'acme', journey: 'j', file: J('j'), env: { OBSERVOGRAM_API_TOKEN: 'marker' } }).refused,
      resolveJourneyNotify(db, { urlEnv: 'OBSERVOGRAM_API_TOKEN' }, { org: 'acme', journey: 'j', file: J('j'), env: {} }).refused);
    // bravo's own hook is bravo's
    assert.equal(notifyNamesRefusal(db, { urlEnv: bravoHook, authEnv: 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_TOKEN' }, { org: 'bravo', at: 'run', journey: 'b', file: J('b', 'bravo') }), null);
    assert.throws(() => notifyNamesRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', at: 'deploy' }), TypeError);
    // a run text names the journey's file: a run without it is a caller's error, never a text that names another
    assert.throws(() => notifyNamesRefusal(db, { urlEnv: 'MY_HOOK_URL' }, { org: 'acme', at: 'run', journey: 'j' }), TypeError);
    assert.throws(() => resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', journey: 'j', env: {} }), TypeError);
  } finally {
    close();
  }
});

test('U2 pairing: a hook\'s token goes only to its own URL — PAGER\'s token with ONCALL\'s URL is PAIR naming ONCALL\'s token, the org\'s MCP token is PAIR, no authEnv passes', async () => {
  const { db, close } = await freshStore(['acme']);
  try {
    const env = { [ONCALL.urlEnv]: 'http://127.0.0.1:9/oncall', [ONCALL.tokenEnv]: 'tok-oncall', [PAGER.urlEnv]: 'http://127.0.0.1:9/pager', [PAGER.tokenEnv]: 'tok-pager', OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'tok-mcp' };
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', env }), T.pair(PAGER.tokenEnv, ONCALL.tokenEnv));
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', journey: 'p', file: J('p'), env }), { refused: T.runPair('p', PAGER.tokenEnv, ONCALL.tokenEnv) });
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv, authEnv: 'OBSERVOGRAM_ORG_ACME_MCP_TOKEN' }, { org: 'acme', env }), T.pair('OBSERVOGRAM_ORG_ACME_MCP_TOKEN', ONCALL.tokenEnv));
    assert.equal(captureNotifyRefusal(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', env }), null, 'no authEnv');
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv }, { org: 'acme', journey: 'p', file: J('p'), env }), { refused: null, url: 'http://127.0.0.1:9/oncall', auth: null, urlEnv: ONCALL.urlEnv }, 'no token is sent without authEnv, though one is set');
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: PAGER.urlEnv, authEnv: PAGER.tokenEnv }, { org: 'acme', journey: 'p', file: J('p'), env }), { refused: null, url: 'http://127.0.0.1:9/pager', auth: 'tok-pager', urlEnv: PAGER.urlEnv });
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
      return { capture: captureNotifyRefusal(db, notify, { org: 'acme', env }), run: resolveJourneyNotify(db, notify, { org: 'acme', journey: 'v', file: J('v'), env }) };
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
    assert.deepEqual(resolveJourneyNotify(db, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv, on: 'always' }, { org: 'acme', journey: 'ok', file: J('ok'), env }),
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

test('U7 notifyHooksOf and notifyBootReport: the org\'s set hooks sorted, tokenEnv null when its token is unset, usable or the capture problem, a shadowed name left out, `none` when there are none (that none can be set, for an org whose every hook name another org\'s id takes); the boot lines; never a value, an origin or a list entry', async () => {
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
    // a name shadowed here and there (acme-notify-eu takes acme's EU_* only) leaves the org hooks to set: who sets one
    assert.equal(notifyHooksOf(db, 'acme', {}).none, "no notify hook is set for org 'acme' — the server's operator sets OBSERVOGRAM_ORG_ACME_NOTIFY_<HOOK>_URL (and OBSERVOGRAM_ORG_ACME_NOTIFY_<HOOK>_TOKEN when the webhook takes a bearer token) in the server's environment and restarts the server");
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
    const tie = await freshStore(['a-b', 'a_b', 'pay', 'pay-notify'], { removed: ['gone'] });
    try {
      // an org whose every hook name another org's id takes (the tie; pay-notify beside pay) can have none, whatever
      // the operator sets: its `none` says so and that its journeys leave notify out — never who sets one
      const takenEnv = { OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL: 'http://127.0.0.1:9/h', OBSERVOGRAM_ORG_PAY_NOTIFY_ONCALL_URL: 'http://127.0.0.1:9/h' };
      for (const org of ['a-b', 'a_b', 'pay']) {
        for (const e of [takenEnv, {}]) assert.deepEqual(notifyHooksOf(tie.db, org, e), { org, pattern: `${P(org)}NOTIFY_<HOOK>_URL`, hooks: [], none: T.noneTaken(org) }, org);
      }
      assert.match(notifyHooksOf(tie.db, 'pay-notify', {}).none, /^no notify hook is set for org 'pay-notify' — the server's operator sets OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_<HOOK>_URL /);
      assert.deepEqual(notifyBootReport(tie.db, { OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL: 'http://127.0.0.1:9/h', OBSERVOGRAM_ORG_GONE_NOTIFY_X_URL: 'http://127.0.0.1:9/h' }), [
        "[notify-hooks] OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL has the shape of org 'a-b''s notify hook, but org 'a_b' also maps onto it by the longest-prefix rule — no journey can use it",
        "[notify-hooks] OBSERVOGRAM_ORG_A_B_NOTIFY_X_URL has the shape of org 'a_b''s notify hook, but org 'a-b' also maps onto it by the longest-prefix rule — no journey can use it",
        "[notify-hooks] OBSERVOGRAM_ORG_GONE_NOTIFY_X_URL is no org's notify hook (only a removed org's id maps onto it)",
      ]);
      // pay-notify's own hook X has pay's shape too (HOOK NOTIFY_X): it is pay-notify's, usable, so the start says
      // nothing of it — never that pay-notify "also maps onto" it or that no journey can use it; when a run would
      // refuse it, only pay-notify's own line. A name of pay's shape that is no hook of pay-notify's stays a shadow.
      const own = { OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL: 'http://127.0.0.1:9/h' };
      assert.deepEqual(notifyHooksOf(tie.db, 'pay-notify', own).hooks, [{ hook: 'X', urlEnv: 'OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL', tokenEnv: null, usable: true, problem: null }]);
      assert.deepEqual(notifyBootReport(tie.db, own), []);
      assert.deepEqual(notifyBootReport(tie.db, { OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL: 'http://u:p@127.0.0.1:9/h', OBSERVOGRAM_ORG_PAY_NOTIFY_ONCALL_URL: 'http://127.0.0.1:9/h' }), [
        `[notify-hooks] org 'pay-notify': OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL — ${T.badUrl('OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL', 'OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_TOKEN')}`,
        "[notify-hooks] OBSERVOGRAM_ORG_PAY_NOTIFY_ONCALL_URL has the shape of org 'pay''s notify hook, but org 'pay-notify' also maps onto it by the longest-prefix rule — no journey can use it",
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
// Everything the HTTP tests saw, for the secret scan (H17): every response
// body, every child (its output is kept after it stops), every workspace a
// child served, every receiver and every MCP request's Authorization.
const SEEN = { bodies: [], children: [], workspaces: new Set(), receivers: [], mcpAuth: [] };
async function serveSeen(ws, opts) {
  const srv = await serve(ws, opts);
  SEEN.children.push(srv);
  SEEN.workspaces.add(ws);
  return srv;
}
const getJson = async (base, path, headers = {}) => {
  const r = await fetch(`${base}${path}`, { headers });
  const text = await r.text();
  SEEN.bodies.push(text);
  return { status: r.status, text, json: (() => { try { return JSON.parse(text); } catch { return null; } })() };
};
const noMarkerIn = (where, text) => { for (const m of MARKERS) assert.ok(!text.includes(m), `${where}: ${m} never appears`); };

test('H14 GET /api/journeys/notify-hooks: a viewer, an operator, the bearer and the anonymous local caller read their org\'s hooks — names, usable or the problem, a shadowed name left out; bravo\'s listing says who sets one; no value, origin or other org in any body', { timeout: 120_000 }, async () => {
  const children = [];
  try {
    const srv = await serveSeen(identityWorkspace(), { env: { ...HOOK_ENV, OBSERVOGRAM_API_TOKEN: BEARER_TOKEN, OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot' } });
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
    const open = await serveSeen(openWs, { env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_ORG_DEFAULT_NOTIFY_LOCAL_URL: 'http://127.0.0.1:9/local-path-marker', ...HOOK_ENV } });
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
  const srv = await serveSeen(identityWorkspace(), { verbose: true, env: { ...HOOK_ENV, OBSERVOGRAM_API_TOKEN: BEARER_TOKEN } });
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

// ---------- over HTTP: capture, a run, the records and the rows (C4) ----------
//
// Three children share the cases below: the identity child (users file
// armed; the API token's marker doubles as the bearer), the loopback
// OBSERVOGRAM_AUTH=off child (the anonymous local caller, which acts in the
// default org) and, for H11 alone, an OBSERVOGRAM_AUTH=off child bound to
// 0.0.0.0. Every variable the deny-list names, the server's own secrets and
// another org's included, holds a marker value in them (but the API tokens
// in the open children, where they would make the posture `token`); the
// webhooks are loopback receivers that record every request. H17, last,
// scans everything the suite saw for the markers.

const { validateNotify } = await import('../tools/lib/journey.mjs');
const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');
const { startFakeMcp, registerMcpEndpoint } = await import('./fixtures/fake-mcp.mjs');
const { scheduleSnippets } = await import('../tools/lib/schedule-snippets.mjs');
const { brandEnv } = await import('../tools/lib/brand-env.mjs');

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');
const PAY_FILE = resolve(REPO, SPEC_DIR, 'examples', 'payment-service.pack.yaml').replaceAll('\\', '/');
const CUR_FILE = join(REPO, 'examples', 'production-curated.pack.yaml').replaceAll('\\', '/');
const CAPTURE = { packAId: 'payment-service', packBId: 'production-curated' };
const REDIRECT = hookVarsOf('acme', 'REDIRECT');
const FAR = 'OBSERVOGRAM_ORG_ACME_NOTIFY_FAR_URL';
const BAD = hookVarsOf('acme', 'BAD');
const SHADOWED = 'OBSERVOGRAM_ORG_ACME_NOTIFY_EU_X_URL';
const D = { oncall: hookVarsOf('default', 'ONCALL'), far: hookVarsOf('default', 'FAR'), iface: hookVarsOf('default', 'IFACE') };

// The server's own secrets and the platform's (T21), each a marker: the
// session secret at least 32 characters, the proxy secret at its minimum,
// the admin password with no seeded admin to rescue.
const SERVER_SECRET_ENV = {
  OBSERVOGRAM_SESSION_SECRET: 'session-secret-marker-0123456789abcdef',
  OBSERVOGRAM_PROXY_AUTH_SHARED_SECRET: 'proxy-secret-marker-0123456789ab',
  OBSERVOGRAM_ADMIN_PASSWORD: 'admin-password-marker',
  OBSERVOGRAM_OIDC_CLIENT_SECRET: 'oidc-client-secret-marker',
  GITHUB_TOKEN: 'github-token-marker',
  DATABASE_URL: 'postgres://db-user-marker:db-pass-marker@db-host-marker.test:5432/db-path-marker',
  OBSERVOGRAM_ORG_BRAVO_MCP_TOKEN: 'tok-bravo-mcp-marker',
};

// A webhook: a node:http server that records every request — method, path,
// Authorization and body — and answers 200 (or `answer`). `path` and `token`
// are what it may legitimately see (its own hook's path and token; none for a
// trap), which H17 holds every recorded request to.
async function receiver({ host = '127.0.0.1', address = '127.0.0.1', path = null, token = null, answer = null } = {}) {
  const hits = [];
  const srv = createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      hits.push({ method: req.method, path: req.url, authorization: req.headers.authorization ?? null, body });
      if (answer) answer(req, res); else res.end('ok');
    });
  });
  await new Promise((r) => srv.listen(0, host, r));
  const rx = {
    hits, path, token, url: `http://${address}:${srv.address().port}`,
    close: () => new Promise((r) => srv.close(() => r())),
  };
  SEEN.receivers.push(rx);
  return rx;
}

// One request: { status, json, text }, the body kept for the scan.
async function call(base, method, path, { headers = {}, body } = {}) {
  const h = { Accept: 'application/json', 'X-Observogram-CSRF': '1', ...headers };
  if (body !== undefined) h['Content-Type'] = 'application/json';
  const r = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
  const text = await r.text();
  SEEN.bodies.push(text);
  let json = null;
  try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, json, text };
}
const run = (child, name, headers = {}) => call(child.base, 'POST', `/api/journeys/${name}/run`, { headers, body: {} });
const capture = (child, body, headers = {}) => call(child.base, 'POST', '/api/journeys/capture', { headers, body: { ...CAPTURE, ...body } });

// The child's audit rows, read from its store file: [action, actor, org, target, detail].
async function auditSeq(ws) {
  const db = await openRaw(join(ws, 'observogram.db'), { readOnly: true });
  try { return prepare(db, 'SELECT coalesce(max(seq), 0) AS s FROM audit').get().s; } finally { db.close(); }
}
async function auditRowsAfter(ws, seq) {
  const db = await openRaw(join(ws, 'observogram.db'), { readOnly: true });
  try {
    return prepare(db, 'SELECT org_id, actor, action, target_id, detail FROM audit WHERE seq > ? ORDER BY seq').all(seq)
      .map((r) => [r.action, r.actor, r.org_id, r.target_id, r.detail === null ? null : JSON.parse(r.detail)]);
  } finally {
    db.close();
  }
}

// An org's part of a child's workspace (the default org's is the base), and
// a definition planted there as whoever holds the workspace would write it.
const orgRoot = (ws, org) => (org === 'default' ? ws : join(ws, 'orgs', org));
function plant(ws, org, name, { packA = `{ file: ${PAY_FILE} }`, packB = `{ file: ${CUR_FILE} }`, notify = null, defName = name } = {}) {
  const dir = join(orgRoot(ws, org), 'journeys');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.journey.yaml`), [
    `name: ${defName}`, `packA: ${packA}`, `packB: ${packB}`, 'gate: { minAlignmentPct: 1 }', ...(notify ? [`notify: ${notify}`] : []),
  ].join('\n') + '\n');
}
const hasRecord = (ws, org, name) => existsSync(join(orgRoot(ws, org), 'runs', name));
// capture's own shape check first (journey-notify's validateNotify), then the hook rule.
const validateText = (notify, name) => { try { validateNotify(notify, name); return null; } catch (e) { return e.message; } };

let identityChildP = null;
function identityChild() {
  identityChildP ??= (async () => {
    const rx = {
      oncall: await receiver({ path: '/acme-oncall-path-marker', token: 'tok-acme-oncall-marker' }),
      pager: await receiver({ path: '/acme-pager-path-marker', token: 'tok-acme-pager-marker' }),
      trap: await receiver(),
      legacy: await receiver(),
    };
    rx.redirect = await receiver({
      path: '/acme-redirect-path-marker', token: 'tok-acme-redirect-marker',
      answer: (req, res) => { res.writeHead(302, { Location: `${rx.trap.url}/followed` }); res.end(); },
    });
    const ws = identityWorkspace();
    const srv = await serveSeen(ws, {
      env: {
        ...SERVER_SECRET_ENV,
        OBSERVOGRAM_API_TOKEN: BEARER_TOKEN, OBSERVOGRAM_API_TOKEN_LABEL: 'ci-bot', TOMOGRAPH_API_TOKEN: 'tomograph-token-marker',
        [ONCALL.urlEnv]: `${rx.oncall.url}/acme-oncall-path-marker`, [ONCALL.tokenEnv]: 'tok-acme-oncall-marker',
        [PAGER.urlEnv]: `${rx.pager.url}/acme-pager-path-marker`, [PAGER.tokenEnv]: 'tok-acme-pager-marker',
        [REDIRECT.urlEnv]: `${rx.redirect.url}/acme-redirect-path-marker`, [REDIRECT.tokenEnv]: 'tok-acme-redirect-marker',
        [FAR]: 'https://far-host-marker.test/far-path-marker',
        [BAD.urlEnv]: 'http://dbuser-marker:dbpass-marker@127.0.0.1:9/bad-path-marker',
        [SHADOWED]: `${rx.trap.url}/shadow-path-marker`,
        OBSERVOGRAM_ORG_ACME_EU_NOTIFY_X_URL: `${rx.trap.url}/acme-eu-path-marker`,
        OBSERVOGRAM_ORG_ACME_MCP_TOKEN: 'tok-acme-mcp-marker',
        observogram_org_acme_notify_oncall_url: `${rx.trap.url}/lower-case-path-marker`,
        OBSERVOGRAM_ORG_ACME_NOTIFY_oncall_URL: `${rx.trap.url}/mixed-case-path-marker`,
        MY_HOOK_URL: `${rx.legacy.url}/my-hook-path-marker`,
        MY_JOURNEY_WEBHOOK_URL: `${rx.trap.url}/bare-path-marker`,
        SMOKE_HOOK_URL: `${rx.trap.url}/smoke-path-marker`,
        OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL: `${rx.legacy.url}/bravo-hook-path-marker`,
        OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_TOKEN: 'tok-bravo-oncall-marker',
      },
    });
    const as = {};
    for (const login of LOGINS) {
      const s = await signIn(srv.base, login, pw(login));
      assert.equal(s.status, 200, `${login} signs in`);
      as[login] = { Cookie: s.session };
    }
    as.oliveInAcme = { ...as.olive, 'X-Observogram-Org': 'acme' };
    as.bearer = { Authorization: `Bearer ${BEARER_TOKEN}`, 'X-Observogram-Org': 'acme' };
    // The posture (T21): sign-in is armed — an anonymous read is refused — and the bearer answers in acme.
    assert.equal((await call(srv.base, 'GET', '/api/journeys/notify-hooks')).status, 401, 'identity: anonymous is refused');
    assert.equal((await call(srv.base, 'GET', '/api/journeys/notify-hooks', { headers: as.bearer })).json?.org, 'acme', 'identity: the bearer acts in acme');
    return { ...srv, ws, rx, as };
  })();
  return identityChildP;
}

const IFACE = Object.values(networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal) ?? null;
let openChildP = null;
function openChild() {
  openChildP ??= (async () => {
    const rx = { oncall: await receiver({ path: '/default-oncall-path-marker', token: 'tok-default-oncall-marker' }) };
    // A receiver on a non-loopback interface of this host (T12), bound to 0.0.0.0 — when the host has one.
    if (IFACE) rx.iface = await receiver({ host: '0.0.0.0', address: IFACE.address, path: '/iface-path-marker', token: 'tok-iface-marker' });
    const ws = mkdtempSync(join(tmpdir(), 'observogram-notify-open-'));
    tmpDirs.push(ws);
    const srv = await serveSeen(ws, {
      env: {
        OBSERVOGRAM_AUTH: 'off', ...SERVER_SECRET_ENV,
        OBSERVOGRAM_NOTIFY_ORIGINS: ['https://other.test', ...(rx.iface ? [rx.iface.url] : [])].join(','),
        [D.oncall.urlEnv]: `${rx.oncall.url}/default-oncall-path-marker`, [D.oncall.tokenEnv]: 'tok-default-oncall-marker',
        [D.far.urlEnv]: 'https://far-host-marker.test/default-far-path-marker',
        ...(rx.iface ? { [D.iface.urlEnv]: `${rx.iface.url}/iface-path-marker`, [D.iface.tokenEnv]: 'tok-iface-marker' } : {}),
        MY_HOOK_URL: `${rx.oncall.url}/my-hook-path-marker`,
      },
    });
    // The posture (T21): no sign-in, no token — the anonymous caller is answered as local, in the default org.
    const hooks = await call(srv.base, 'GET', '/api/journeys/notify-hooks');
    assert.deepEqual([hooks.status, hooks.json?.org], [200, 'default'], 'open: the anonymous local caller reads the default org');
    return { ...srv, ws, rx, port: Number(new URL(srv.base).port) };
  })();
  return openChildP;
}

async function stopAll() {
  for (const c of SEEN.children) await c.stop();
  for (const rx of SEEN.receivers) await rx.close();
}
after(stopAll);

test('H1 capture refuses a notify that is not one of the org\'s set hooks — for an operator, an admin, an owner acting in acme, the bearer and the anonymous local caller without sign-in: every deny-list row, another variable as the hook\'s token, an unset hook, and a literal url from an operator and from an admin; 400 with its exact text, no file, no row', { timeout: 300_000 }, async () => {
  const A = await identityChild();
  const B = await openChild();
  for (const [who, child, headers, org] of [
    ['oscar (operator)', A, A.as.oscar, 'acme'], ['ada (admin)', A, A.as.ada, 'acme'], ['olive (an owner acting in acme)', A, A.as.oliveInAcme, 'acme'],
    ['the bearer', A, A.as.bearer, 'acme'], ['local (OBSERVOGRAM_AUTH=off)', B, {}, 'default'],
  ]) {
    const seq = await auditSeq(child.ws);
    const hook = hookVarsOf(org, 'ONCALL');
    const unset = hookVarsOf(org, 'UNSET').urlEnv;
    const cases = [
      ...[...NAME_ROWS, SHADOWED, ...(org === 'acme' ? [] : [ONCALL.urlEnv])].map((urlEnv) => [{ urlEnv },
        validateText({ urlEnv }, 'h1-refused') ?? (org === 'acme' && urlEnv === SHADOWED ? T.shadow(urlEnv, org) : T.name(urlEnv, org))]),
      ...['OBSERVOGRAM_API_TOKEN', 'OBSERVOGRAM_ORG_BRAVO_MCP_TOKEN', `${P(org)}MCP_TOKEN`].map((authEnv) => [{ urlEnv: hook.urlEnv, authEnv }, T.pair(authEnv, hook.tokenEnv)]),
      [{ urlEnv: unset }, T.unsetUrl(unset)],
    ];
    for (const [notify, error] of cases) {
      const r = await capture(child, { name: 'h1-refused', notify: { ...notify, on: 'always' } }, headers);
      assert.deepEqual([r.status, r.json], [400, { ok: false, error }], `${who}: ${JSON.stringify(notify)}`);
      noMarkerIn(`${who}: ${notify.urlEnv}`, r.text);
    }
    assert.equal(existsSync(join(orgRoot(child.ws, org), 'journeys', 'h1-refused.journey.yaml')), false, `${who}: no file`);
    assert.deepEqual(await auditRowsAfter(child.ws, seq), [], `${who}: no row`);
  }
  // No role supplies a webhook URL in the app — an admin included.
  const seq = await auditSeq(A.ws);
  for (const login of ['oscar', 'ada']) {
    const notify = { url: 'https://hooks.example/x' };
    const r = await capture(A, { name: 'h1-refused', notify }, A.as[login]);
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: validateText(notify, 'h1-refused') }], login);
  }
  assert.deepEqual(await auditRowsAfter(A.ws, seq), []);
  assert.equal(A.rx.trap.hits.length + A.rx.legacy.hits.length, 0, 'nothing was posted');
});

test('H2 capture accepts one of the org\'s set hooks: the file holds its two names and reads back, the row names them (never a value); a set hook whose origin is not listed or whose URL carries user:password is refused, naming variables only', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const CAPTURE_ROW = { packA: 'payment-service', packB: 'production-curated', live: false, env: null, service: null, scopeMode: null };
  const row = (name, notify) => ['journey.capture', 'oscar', 'acme', name, { ...CAPTURE_ROW, ...(notify === undefined ? {} : { notify }) }];
  let seq = await auditSeq(A.ws);
  let r = await capture(A, { name: 'h2-oncall', notify: { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv, on: 'always' } }, A.as.oscar);
  assert.deepEqual([r.status, r.json], [200, { ok: true, name: 'h2-oncall' }], r.text);
  const file = readFileSync(join(orgRoot(A.ws, 'acme'), 'journeys', 'h2-oncall.journey.yaml'), 'utf8');
  assert.deepEqual(parseYaml(file).notify, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv, on: 'always' }, 'the file holds the two names');
  r = await capture(A, { name: 'h2-pager', notify: { urlEnv: PAGER.urlEnv } }, A.as.oscar);
  assert.equal(r.status, 200, r.text);
  r = await capture(A, { name: 'h2-plain' }, A.as.oscar);
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(await auditRowsAfter(A.ws, seq), [
    row('h2-oncall', { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv }),
    row('h2-pager', { urlEnv: PAGER.urlEnv, authEnv: null }),
    row('h2-plain'),
  ], 'the rows name the hook\'s variables; without notify, no notify key');
  const listed = Object.fromEntries((await call(A.base, 'GET', '/api/journeys', { headers: A.as.vera })).json.journeys.map((j) => [j.name, j]));
  assert.deepEqual([listed['h2-oncall'].loadError, listed['h2-oncall'].notify], [null, { urlEnv: ONCALL.urlEnv, authEnv: ONCALL.tokenEnv, on: 'always', format: 'json' }], 'it reads back; no problem');
  seq = await auditSeq(A.ws);
  for (const [notify, error] of [
    [{ urlEnv: FAR }, T.originNoList(FAR, 'acme')],
    [{ urlEnv: BAD.urlEnv }, T.badUrl(BAD.urlEnv, BAD.tokenEnv)],
  ]) {
    r = await capture(A, { name: 'h2-refused', notify }, A.as.oscar);
    assert.deepEqual([r.status, r.json], [400, { ok: false, error }], notify.urlEnv);
    noMarkerIn(notify.urlEnv, r.text);
  }
  assert.equal(existsSync(join(orgRoot(A.ws, 'acme'), 'journeys', 'h2-refused.journey.yaml')), false);
  assert.deepEqual(await auditRowsAfter(A.ws, seq), []);
});

test('H3 a definition written before the rule — a bare name with the API token as its bearer, another org\'s hook — is refused before it runs: 400 with the run text, no record, no row, nothing posted; GET /api/journeys carries that text as notify.problem, and a journey through its org\'s hook has none; the text names the file the run loaded, relative to the workspace, in its org\'s root — whatever its name: says', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h3-bare', { notify: '{ urlEnv: MY_HOOK_URL, authEnv: OBSERVOGRAM_API_TOKEN, on: always }' });
  plant(A.ws, 'acme', 'h3-bravo', { notify: '{ urlEnv: OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL, on: always }' });
  plant(A.ws, 'acme', 'h3-hook', { notify: `{ urlEnv: ${ONCALL.urlEnv}, on: breach }` });
  plant(A.ws, 'acme', 'h3-renamed', { defName: 'h3-other', notify: '{ urlEnv: MY_HOOK_URL, on: always }' });
  const want = {
    'h3-bare': T.runName('h3-bare', 'MY_HOOK_URL', 'acme'),
    'h3-bravo': T.runName('h3-bravo', 'OBSERVOGRAM_ORG_BRAVO_NOTIFY_ONCALL_URL', 'acme'),
    'h3-renamed': T.runName('h3-other', 'MY_HOOK_URL', 'acme', J('h3-renamed')),
  };
  // The way out, followed literally from the workspace, opens the journey's own file (never the default org's
  // journeys/, never a file named after its name:).
  for (const name of Object.keys(want)) assert.ok(existsSync(join(A.ws, J(name))), `${J(name)} is in the workspace`);
  const seq = await auditSeq(A.ws);
  for (const [name, error] of Object.entries(want)) {
    const r = await run(A, name, A.as.oscar);
    assert.deepEqual([r.status, r.json], [400, { ok: false, error }], name);
    assert.equal(hasRecord(A.ws, 'acme', name), false, `${name}: no record`);
  }
  assert.deepEqual(await auditRowsAfter(A.ws, seq), [], 'no row');
  assert.equal(A.rx.legacy.hits.length, 0, 'nothing was posted — not the API token, not bravo\'s hook');
  const listed = Object.fromEntries((await call(A.base, 'GET', '/api/journeys', { headers: A.as.vera })).json.journeys.map((j) => [j.name, j]));
  for (const [name, error] of Object.entries(want)) assert.equal(listed[name].notify.problem, error, `${name}: the listing says why`);
  assert.deepEqual(listed['h3-hook'].notify, { urlEnv: ONCALL.urlEnv, authEnv: null, on: 'breach', format: 'json' }, 'no problem key');
  // the default org's root is the base: its text names journeys/<file>, which is there
  const B = await openChild();
  plant(B.ws, 'default', 'h3-default', { notify: '{ urlEnv: MY_HOOK_URL, on: always }' });
  assert.equal(J('h3-default', 'default'), 'journeys/h3-default.journey.yaml');
  assert.ok(existsSync(join(B.ws, J('h3-default', 'default'))));
  const r = await run(B, 'h3-default');
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.runName('h3-default', 'MY_HOOK_URL', 'default') }]);
  assert.equal(hasRecord(B.ws, 'default', 'h3-default'), false);
});

test('H4 a run through the org\'s hook posts once, with that hook\'s own token, a payload without any variable\'s name or value; the 200 row adds notify { urlEnv, status, attempts }, the vantage-lost 502 row the delivery its record kept, and a 502 with no record { status: null, attempts: 0 }', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h4-sent', { notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${ONCALL.tokenEnv}, on: always }` });
  const before = A.rx.oncall.hits.length;
  let seq = await auditSeq(A.ws);
  let r = await run(A, 'h4-sent', A.as.oscar);
  assert.equal(r.status, 200, r.text);
  const { status, httpStatus, attempts, urlEnv, error } = r.json.record.notify;
  assert.deepEqual({ status, httpStatus, attempts, urlEnv, error }, { status: 'sent', httpStatus: 200, attempts: 1, urlEnv: ONCALL.urlEnv, error: null });
  const hits = A.rx.oncall.hits.slice(before);
  assert.deepEqual(hits.map((h) => [h.method, h.path, h.authorization]), [['POST', '/acme-oncall-path-marker', 'Bearer tok-acme-oncall-marker']], 'one POST, its own token');
  for (const s of [...MARKERS, 'OBSERVOGRAM_', 'urlEnv', 'authEnv']) assert.ok(!hits[0].body.includes(s), `the payload carries no ${s}`);
  assert.equal(JSON.parse(hits[0].body).journey, 'h4-sent');
  let rows = await auditRowsAfter(A.ws, seq);
  assert.deepEqual(rows.map((x) => x.slice(0, 4)), [['journey.run', 'oscar', 'acme', 'h4-sent']]);
  assert.deepEqual(Object.keys(rows[0][4]), ['startedAt', 'outcome', 'alignmentPct', 'gradeScore', 'gradePass', 'breaches', 'tookMs', 'notify']);
  assert.deepEqual(rows[0][4].notify, { urlEnv: ONCALL.urlEnv, status: 'sent', attempts: 1 });
  // The vantage-lost path (T7): the record is kept and posted; the 502 row reads its delivery.
  const ep = await registerMcpEndpoint(A.base, { name: 'h4-unreachable', url: 'http://127.0.0.1:1/mcp' }, { headers: A.as.ada });
  assert.equal(ep.status, 201, ep.text);
  plant(A.ws, 'acme', 'h4-lost', { packB: `{ mcp: { url: "http://127.0.0.1:1/mcp", endpointId: ${ep.id} } }`, notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${ONCALL.tokenEnv}, on: always }` });
  seq = await auditSeq(A.ws);
  r = await run(A, 'h4-lost', A.as.oscar);
  assert.equal(r.status, 502, r.text);
  assert.equal(A.rx.oncall.hits.length, before + 2, 'the vantage-lost record was posted');
  rows = await auditRowsAfter(A.ws, seq);
  assert.deepEqual(rows.map((x) => [...x.slice(0, 4), x[4].outcome, x[4].notify]), [['journey.run', 'oscar', 'acme', 'h4-lost', 'vantage-lost', { urlEnv: ONCALL.urlEnv, status: 'sent', attempts: 1 }]]);
  // A run that fails before any record: nothing left the server.
  plant(A.ws, 'acme', 'h4-gone', { packA: `{ file: ${join(A.ws, 'no-such.pack.yaml').replaceAll('\\', '/')} }`, notify: `{ urlEnv: ${ONCALL.urlEnv}, on: always }` });
  seq = await auditSeq(A.ws);
  r = await run(A, 'h4-gone', A.as.oscar);
  assert.equal(r.status, 502, r.text);
  assert.equal(A.rx.oncall.hits.length, before + 2, 'nothing posted');
  rows = await auditRowsAfter(A.ws, seq);
  assert.deepEqual(rows.map((x) => [...x.slice(0, 4), x[4].outcome, x[4].notify]), [['journey.run', 'oscar', 'acme', 'h4-gone', 'error', { urlEnv: ONCALL.urlEnv, status: null, attempts: 0 }]]);
});

test('H5 a hook\'s token goes only to its own URL: ONCALL\'s URL with PAGER\'s token (both set) is refused before it runs — 400 PAIR, neither webhook hit, no record, no row', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h5-pair', { notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${PAGER.tokenEnv}, on: always }` });
  const counts = [A.rx.oncall.hits.length, A.rx.pager.hits.length];
  const seq = await auditSeq(A.ws);
  const r = await run(A, 'h5-pair', A.as.oscar);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.runPair('h5-pair', PAGER.tokenEnv, ONCALL.tokenEnv) }]);
  assert.deepEqual([A.rx.oncall.hits.length, A.rx.pager.hits.length], counts, 'neither webhook was hit');
  assert.equal(hasRecord(A.ws, 'acme', 'h5-pair'), false);
  assert.deepEqual(await auditRowsAfter(A.ws, seq), []);
});

test('H6 the notify origin list: with none, a hook off this machine is refused without a lookup (ORIGIN, no list); with OBSERVOGRAM_NOTIFY_ORIGINS, an origin outside it is refused (ORIGIN, listed) and one inside it — a non-loopback address of this host — is posted to', { timeout: 120_000 }, async (t) => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h6-far', { notify: `{ urlEnv: ${FAR}, on: always }` });
  let r = await run(A, 'h6-far', A.as.oscar);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: RUN('h6-far', T.originNoList(FAR, 'acme')) }]);
  assert.equal(hasRecord(A.ws, 'acme', 'h6-far'), false);
  const B = await openChild();
  plant(B.ws, 'default', 'h6-listed', { notify: `{ urlEnv: ${D.far.urlEnv}, on: always }` });
  r = await run(B, 'h6-listed');
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: RUN('h6-listed', T.originListed(D.far.urlEnv, ['OBSERVOGRAM_NOTIFY_ORIGINS'])) }]);
  if (!B.rx.iface) {
    t.diagnostic('this host has no non-loopback IPv4 interface: the listed-origin delivery is not exercised (T12)');
    process.stdout.write('# H6: skipped the listed-origin delivery — this host has no non-loopback IPv4 interface\n');
  } else {
    plant(B.ws, 'default', 'h6-iface', { notify: `{ urlEnv: ${D.iface.urlEnv}, authEnv: ${D.iface.tokenEnv}, on: always }` });
    r = await run(B, 'h6-iface');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.record.notify.status, 'sent', JSON.stringify(r.json.record.notify));
    assert.deepEqual(B.rx.iface.hits.map((h) => [h.method, h.path, h.authorization]), [['POST', '/iface-path-marker', 'Bearer tok-iface-marker']]);
  }
  for (const text of [...SEEN.bodies, A.logs().stderr, B.logs().stderr]) assert.ok(!text.includes('ENOTFOUND') && !text.includes('getaddrinfo'), 'no lookup was made');
});

test('H7 a hook that answers 302 is a failed delivery, never followed: the run is 200, the record says HTTP 302 after one attempt, the redirect target receives nothing', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h7-redirect', { notify: `{ urlEnv: ${REDIRECT.urlEnv}, authEnv: ${REDIRECT.tokenEnv}, on: always }` });
  const r = await run(A, 'h7-redirect', A.as.oscar);
  assert.equal(r.status, 200, r.text);
  const { status, httpStatus, attempts, error } = r.json.record.notify;
  assert.deepEqual({ status, httpStatus, attempts, error }, { status: 'failed', httpStatus: 302, attempts: 1, error: 'HTTP 302' });
  assert.deepEqual(A.rx.redirect.hits.map((h) => h.authorization), ['Bearer tok-acme-redirect-marker'], 'the hook saw its token once');
  assert.equal(A.rx.trap.hits.length, 0, 'the Location was never requested');
});

test('H8 across orgs and under a shadow: bravo\'s admin cannot capture acme\'s hook, a bravo journey naming it is refused before it runs, and a name another org\'s id shadows is refused for acme without naming that org', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const bodies = [];
  let r = await capture(A, { name: 'h8-x', notify: { urlEnv: ONCALL.urlEnv } }, A.as.bob);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.name(ONCALL.urlEnv, 'bravo') }]);
  bodies.push(r.text);
  plant(A.ws, 'bravo', 'h8-bravo', { notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${ONCALL.tokenEnv}, on: always }` });
  const before = A.rx.oncall.hits.length;
  r = await run(A, 'h8-bravo', A.as.bob);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.runName('h8-bravo', ONCALL.urlEnv, 'bravo') }]);
  bodies.push(r.text);
  assert.equal(A.rx.oncall.hits.length, before, 'acme\'s hook was not posted to');
  assert.equal(hasRecord(A.ws, 'bravo', 'h8-bravo'), false);
  r = await capture(A, { name: 'h8-y', notify: { urlEnv: SHADOWED } }, A.as.oscar);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.shadow(SHADOWED, 'acme') }]);
  bodies.push(r.text);
  for (const text of bodies) assert.ok(!text.includes('acme-notify-eu'), 'no other org is named');
});

test('H9 the server never reads packB.mcp.authEnv: a journey whose Pack B names the API token (set) as its MCP token fetches through its endpoint, and the MCP receives no Authorization', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const fake = await startFakeMcp(['system_health', 'system_topology'], () => ({}));
  try {
    const ep = await registerMcpEndpoint(A.base, { name: 'h9-fake', url: fake.url }, { headers: A.as.ada });
    assert.equal(ep.status, 201, ep.text);
    plant(A.ws, 'acme', 'h9-mcp', { packB: `{ mcp: { url: "${fake.url}", endpointId: ${ep.id}, authEnv: OBSERVOGRAM_API_TOKEN } }` });
    const r = await run(A, 'h9-mcp', A.as.oscar);
    assert.ok([200, 502].includes(r.status), r.text);
    assert.ok(fake.authHeaders.length > 0, 'the MCP was asked');
    assert.deepEqual([...new Set(fake.authHeaders)], [null], 'never an Authorization');
    SEEN.mcpAuth.push(...fake.authHeaders);
  } finally {
    await fake.close();
  }
});

test('H10 an unset hook of the org is refused before the run (it was a 502): 400 naming the variable and who sets it, no record, no row', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const gone = hookVarsOf('acme', 'GONE').urlEnv;
  plant(A.ws, 'acme', 'h10-unset', { notify: `{ urlEnv: ${gone}, on: always }` });
  const seq = await auditSeq(A.ws);
  const r = await run(A, 'h10-unset', A.as.oscar);
  assert.deepEqual([r.status, r.json], [400, { ok: false, error: T.runUnsetUrl('h10-unset', gone) }]);
  assert.equal(hasRecord(A.ws, 'acme', 'h10-unset'), false);
  assert.deepEqual(await auditRowsAfter(A.ws, seq), []);
});

test('H11 without sign-in a journey that notifies runs only from a direct loopback request and never on an exposed bind — 403 posture, nothing posted, no record; a journey without notify still runs there', { timeout: 120_000 }, async () => {
  const exposedRx = await receiver();
  const ws = mkdtempSync(join(tmpdir(), 'observogram-notify-exposed-'));
  tmpDirs.push(ws);
  const C = await serveSeen(ws, {
    host: '0.0.0.0',
    env: { OBSERVOGRAM_AUTH: 'off', OBSERVOGRAM_INSECURE_NO_AUTH: '1', ...SERVER_SECRET_ENV, [D.oncall.urlEnv]: `${exposedRx.url}/exposed-path-marker`, [D.oncall.tokenEnv]: 'tok-exposed-marker' },
  });
  try {
    plant(ws, 'default', 'h11-notify', { notify: `{ urlEnv: ${D.oncall.urlEnv}, authEnv: ${D.oncall.tokenEnv}, on: always }` });
    plant(ws, 'default', 'h11-plain');
    const seq = await auditSeq(ws);
    let r = await run(C, 'h11-notify');
    assert.deepEqual([r.status, r.json], [403, {
      ok: false, denied: 'posture',
      error: 'running a journey that notifies is closed on a server bound to 0.0.0.0 without sign-in (OBSERVOGRAM_INSECURE_NO_AUTH=1, OBSERVOGRAM_AUTH=off): restart it without OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback',
    }]);
    assert.equal(hasRecord(ws, 'default', 'h11-notify'), false);
    assert.deepEqual(await auditRowsAfter(ws, seq), []);
    r = await run(C, 'h11-plain');
    assert.equal(r.status, 200, r.text);
    assert.equal(exposedRx.hits.length, 0, 'nothing was posted');
  } finally {
    await C.stop();
  }
  const B = await openChild();
  plant(B.ws, 'default', 'h11-direct', { notify: `{ urlEnv: ${D.oncall.urlEnv}, authEnv: ${D.oncall.tokenEnv}, on: always }` });
  let r = await run(B, 'h11-direct', { 'X-Forwarded-For': '203.0.113.9' });
  assert.deepEqual([r.status, r.json], [403, {
    ok: false, denied: 'posture',
    error: `on a server without sign-in running a journey that notifies answers only requests sent straight to a loopback address (Host localhost, 127.0.0.1 or [::1]; no Forwarded / Via / X-Forwarded-* / X-Real-IP / client-IP header; an Origin, if any, naming that host) — open the studio at http://127.0.0.1:${B.port}`,
  }]);
  assert.equal(B.rx.oncall.hits.length, 0);
  assert.equal(hasRecord(B.ws, 'default', 'h11-direct'), false);
  r = await run(B, 'h11-direct');
  assert.equal(r.status, 200, r.text);
  assert.deepEqual(B.rx.oncall.hits.map((h) => [h.path, h.authorization]), [['/default-oncall-path-marker', 'Bearer tok-default-oncall-marker']], 'a direct request posts');
  const rows = await auditRowsAfter(B.ws, 0);
  assert.deepEqual(rows.filter((x) => x[3] === 'h11-direct').map((x) => [x[0], x[1], x[2], x[4].notify]), [['journey.run', 'local', 'default', { urlEnv: D.oncall.urlEnv, status: 'sent', attempts: 1 }]]);
});

test('H12 a file is exactly what capture validated: a pack label with line breaks stays one banner comment line (no notify block of its own), and a gate key or a scope scalar that would not read back is refused with nothing written — the earlier file of that name, and its schedule, intact', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const path = join(orgRoot(A.ws, 'acme'), 'journeys', 'h12-inj.journey.yaml');
  let r = await capture(A, { name: 'h12-inj', schedule: { every: '2h' } }, A.as.oscar);
  assert.equal(r.status, 200, r.text);
  const earlier = readFileSync(path, 'utf8');
  // The measured banner injection: a crawl labelled with a notify block of its own.
  const files = {
    'prometheus/rules.yml': 'groups:\n  - name: payments\n    rules:\n      - alert: HighErrorRate\n        expr: rate(http_requests_total{code=~"5.."}[5m]) > 0.1\n        labels:\n          severity: page\n',
    'README.md': '# payments\nservice: payments\n',
  };
  const crawl = await call(A.base, 'POST', '/api/crawl', { headers: A.as.oscar, body: { files, repoName: 'payments', label: 'x\nnotify:\n  urlEnv: OBSERVOGRAM_API_TOKEN\n  on: always\n#' } });
  assert.ok(crawl.json?.registered?.id, crawl.text.slice(0, 200));
  r = await capture(A, { name: 'h12-banner', packAId: crawl.json.registered.id }, A.as.oscar);
  assert.equal(r.status, 200, r.text);
  const banner = readFileSync(join(orgRoot(A.ws, 'acme'), 'journeys', 'h12-banner.journey.yaml'), 'utf8');
  assert.equal(parseYaml(banner).notify, undefined, 'no notify block');
  assert.ok(banner.split('\n').some((l) => l.startsWith('# Pack A: x notify:   urlEnv: OBSERVOGRAM_API_TOKEN   on: always #')), 'the label is one comment line');
  const listed = (await call(A.base, 'GET', '/api/journeys', { headers: A.as.vera })).json.journeys.find((j) => j.name === 'h12-banner');
  assert.equal(listed.notify, null);
  // A gate key and an env value with a line break do not read back: refused, nothing written.
  const seq = await auditSeq(A.ws);
  for (const [body, reason] of [
    [{ gate: { 'k\nnotify': 1 } }, 'it does not parse as YAML'],
    [{ env: 'prod\nnotify: { urlEnv: OBSERVOGRAM_API_TOKEN }' }, '"env" differs'],
  ]) {
    r = await capture(A, { name: 'h12-inj', ...body }, A.as.oscar);
    assert.deepEqual([r.status, r.json], [400, { ok: false, error: `journey h12-inj: the definition does not read back as written (${reason}) — nothing was saved` }]);
  }
  assert.equal(readFileSync(path, 'utf8'), earlier, 'the earlier file is untouched');
  assert.deepEqual(await auditRowsAfter(A.ws, seq), []);
  const sched = await call(A.base, 'GET', '/api/journeys/h12-inj/schedule', { headers: A.as.vera });
  assert.deepEqual([sched.status, sched.json.schedule?.every, sched.json.envNames], [200, '2h', []], 'the schedule is the earlier one\'s');
});

test('H13 a record written before the rule is served scrubbed: undici\'s echo of a bearer token and of a URL with credentials, and the hook\'s host or address in a failed lookup or connect, read <redacted> on GET /api/journeys/:name/runs', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const dir = join(orgRoot(A.ws, 'acme'), 'runs', 'h13-old');
  mkdirSync(dir, { recursive: true });
  const leaks = [
    ['2026-01-01T00:00:00.000Z', 'Headers.append: "Bearer tok-h13-marker\n" is an invalid header value.', 'Headers.append: "<redacted>" is an invalid header value.'],
    ['2026-01-02T00:00:00.000Z', 'Request cannot be constructed from a URL that includes credentials: http://***@h13-host-marker.test:5432/h13-path-marker', 'Request cannot be constructed from a URL that includes credentials: <redacted>'],
    ['2026-01-03T00:00:00.000Z', 'getaddrinfo ENOTFOUND h13-lookup-marker.test', 'getaddrinfo ENOTFOUND <redacted>'],
    ['2026-01-04T00:00:00.000Z', 'connect ECONNREFUSED 203.0.113.13:47998', 'connect ECONNREFUSED <redacted>'],
  ];
  for (const [startedAt, error] of leaks) {
    writeFileSync(join(dir, `${startedAt.replace(/[:.]/g, '-')}.json`), JSON.stringify({
      journey: 'h13-old', startedAt, tookMs: 1, outcome: 'pass',
      notify: { status: 'failed', reason: 'policy always', triggers: ['always'], httpStatus: null, attempts: 1, tookMs: 1, urlEnv: 'MY_HOOK_URL', error },
    }));
  }
  try {
    const r = await call(A.base, 'GET', '/api/journeys/h13-old/runs?limit=5', { headers: A.as.vera });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.runs.map((x) => x.notify.error), leaks.map((l) => l[2]).reverse());
    assert.ok(!r.text.includes('203.0.113.13') && !r.text.includes('47998'), 'no resolved address or port is served');
    assert.deepEqual(Object.keys(r.json.runs[0].notify), ['status', 'reason', 'triggers', 'httpStatus', 'attempts', 'tookMs', 'urlEnv', 'error'], 'the record otherwise as written');
    noMarkerIn('the served records', r.text);
  } finally {
    rmSync(dir, { recursive: true, force: true });   // the planted leak is not the server's (H17 scans the workspace)
  }
});

test('H16 the schedule route never binds a notify name the server refuses: a legacy journey\'s envNames hold neither of its names, refusedEnvNames both, and every snippet says so where the binding would have been; a stranger token beside the org\'s hook is the only name refused, its comment naming that hook\'s own token; a journey through its org\'s hook has the body it always had', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  plant(A.ws, 'acme', 'h16-bare', { notify: '{ urlEnv: MY_HOOK_URL, authEnv: OBSERVOGRAM_API_TOKEN, on: always }' });
  plant(A.ws, 'acme', 'h16-pair', { notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${PAGER.tokenEnv} }` });
  plant(A.ws, 'acme', 'h16-hook', { notify: `{ urlEnv: ${ONCALL.urlEnv}, authEnv: ${ONCALL.tokenEnv}, on: always }` });
  const REFUSED = (e) => `${e} is not a notify hook of this org: the studio never reads it — rename it to OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL/_TOKEN before scheduling (docs/DOWNSTREAM.md §17.2)`;
  const schedule = async (name) => {
    const r = await call(A.base, 'GET', `/api/journeys/${name}/schedule`, { headers: A.as.vera });
    assert.equal(r.status, 200, r.text.slice(0, 200));
    return r.json;
  };
  const refusedIn = (s, e, note = REFUSED(e)) => {
    assert.ok(s.cron.split('\n').includes(`# ${note}`) && !s.cron.includes(`export ${e}=`), `cron: ${e}`);
    assert.ok(s.schtasks.split('\n').includes(`REM ${note}`) && !s.schtasks.includes(`setx ${e} `), `schtasks: ${e}`);
    assert.ok(s.actions.split('\n').includes(`          # ${note}`) && !s.actions.includes(`secrets.${e}`), `actions: ${e}`);
    assert.ok(s.k8s.split('\n').includes(`                # ${note}`) && !s.k8s.includes(`key: ${e}`), `k8s: ${e}`);
  };
  const bare = await schedule('h16-bare');
  assert.deepEqual([bare.envNames, bare.refusedEnvNames], [[], ['MY_HOOK_URL', 'OBSERVOGRAM_API_TOKEN']]);
  for (const e of bare.refusedEnvNames) refusedIn(bare.snippets, e);
  assert.ok(!bare.snippets.k8s.includes('secretKeyRef') && !bare.snippets.actions.includes('secrets.'), 'nothing is bound from a Secret');
  const pair = await schedule('h16-pair');
  assert.deepEqual([pair.envNames, pair.refusedEnvNames], [[ONCALL.urlEnv], [PAGER.tokenEnv]], 'the org\'s hook stays bound; the stranger token is refused');
  // PAGER's token is one of the org's hook names: its comment names ONCALL's own token (the PAIR way out), never a rename to the shape it has.
  refusedIn(pair.snippets, PAGER.tokenEnv, `${PAGER.tokenEnv} is not the token of the hook ${ONCALL.urlEnv} names: a hook's token goes only to its own URL — set the journey's notify.authEnv to ${ONCALL.tokenEnv}, or remove it, before scheduling (docs/DOWNSTREAM.md §17.2)`);
  for (const f of ['cron', 'schtasks', 'actions', 'k8s']) assert.ok(!pair.snippets[f].includes(REFUSED(PAGER.tokenEnv)), `${f}: the org's own hook token is never "not a notify hook of this org"`);
  // A journey through its org's hook: no new key, the snippets scheduleSnippets makes from the route's inputs.
  const hook = await schedule('h16-hook');
  assert.deepEqual(Object.keys(hook), ['ok', 'name', 'schedule', 'placeholder', 'envNames', 'snippets']);
  assert.deepEqual(hook.envNames, [ONCALL.urlEnv, ONCALL.tokenEnv]);
  const pkg = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8'));
  assert.deepEqual(hook.snippets, scheduleSnippets({
    name: 'h16-hook', cron: null, timezone: null, every: null, cadenceNote: null, envNames: [ONCALL.urlEnv, ONCALL.tokenEnv],
    nodePath: process.execPath, cliPath: resolve(REPO, 'tools/cli.mjs'), cwd: process.cwd(),
    workspace: orgRoot(A.ws, 'acme'), orgRoot: 'orgs/acme', image: `observogram:${pkg.version}`, namespace: 'observability',
    retention: brandEnv('JOURNEY_RUN_RETENTION') || null, placeholder: true, source: join(orgRoot(A.ws, 'acme'), 'journeys', 'h16-hook.journey.yaml'),
  }));
});

test('H17 the secret scan: no marker — a hook URL\'s host or path, a hook token, a server secret, another org\'s variable — in any response body, any child\'s output, any audit row, the stopped store or any workspace file; every webhook request went to its own hook with its own token, and the MCP never got an Authorization', { timeout: 120_000 }, async () => {
  const A = await identityChild();
  const audit = await call(A.base, 'GET', '/api/audit?limit=500', { headers: A.as.olive });
  assert.equal(audit.status, 200, audit.text.slice(0, 200));
  assert.ok(audit.json.rows.some((x) => x.action === 'journey.capture' && x.detail?.notify) && audit.json.rows.some((x) => x.action === 'journey.run' && x.detail?.notify),
    'the notify rows are among them');
  await stopAll();
  for (const [i, text] of SEEN.bodies.entries()) noMarkerIn(`response body ${i}`, text);
  for (const [i, c] of SEEN.children.entries()) { const { stdout, stderr } = c.logs(); noMarkerIn(`child ${i}'s output`, stdout + stderr); }
  const files = (dir) => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? files(p) : [p]; });
  let scanned = 0;
  for (const ws of SEEN.workspaces) {
    for (const file of files(ws)) {
      const bytes = readFileSync(file);
      scanned++;
      for (const m of MARKERS) assert.ok(!bytes.includes(m), `${file.slice(ws.length)}: ${m} never appears`);
    }
  }
  assert.ok(scanned > 0 && [...SEEN.workspaces].every((ws) => existsSync(join(ws, 'observogram.db'))), 'every store was scanned');
  for (const rx of SEEN.receivers) {
    for (const h of rx.hits) {
      assert.deepEqual([h.path, h.authorization], [rx.path, rx.token === null ? null : `Bearer ${rx.token}`], `${rx.url}: only its own hook, with its own token`);
      noMarkerIn(`a request to ${rx.url}`, h.body);
    }
  }
  assert.ok(SEEN.mcpAuth.length > 0 && SEEN.mcpAuth.every((a) => a === null), 'the MCP never got an Authorization');
});
