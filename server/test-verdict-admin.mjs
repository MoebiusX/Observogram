#!/usr/bin/env node
/**
 * server/test-verdict-admin.mjs — the rules of a reviewer's verdicts
 * (server/verdict-admin.mjs, GAP batch 2 B3.1), headless under node:test
 * over a temp store: the refusal texts and their kinds, the artefact index
 * (the board's walk, the card keys, the `#NN`-suffixed identity keys over
 * the catalogue, the behaviour hash), the views and the document, the
 * carry plan (no rows → no adapt(), map null) and what a taxonomy change
 * between two registrations does to a carry. The routes over these rules
 * are server/test-verdicts-api.mjs's.
 */

// Hermetic (§0): a developer shell's store or identity variables never
// reach this process's imports — the children's STRIP list, both spellings,
// before any server module loads. serve-child.mjs imports no server code.
const { STRIP } = await import('./fixtures/serve-child.mjs');
for (const k of STRIP) {
  delete process.env[`OBSERVOGRAM_${k}`];
  delete process.env[`TOMOGRAPH_${k}`];
}

const { test, after } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { mkdtempSync, readFileSync, rmSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { dirname, join } = await import('node:path');
const { fileURLToPath } = await import('node:url');

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const { parse: parseYaml } = await import('../tools/lib/mini-yaml.mjs');
const { adapt } = await import('../tools/lib/adapter.mjs');
const { SPEC_DIR } = await import('../tools/lib/validator.mjs');
const { identityKeyOf, classify } = await import('../tools/lib/artefact-model.mjs');
const { compileTaxonomy, configureTaxonomy } = await import('../tools/lib/artefact-classify.mjs');
const { LAYER_DEFS, L4_SUBGROUPS } = await import('../studio/constants.mjs');
const { openStore, closeStore } = await import('./store/db.mjs');
const { createOrg } = await import('./store/orgs.mjs');
const { addPack } = await import('./store/packs.mjs');
const { listAudit } = await import('./store/audit.mjs');
const { runWithOrg } = await import('./org-context.mjs');
const { AdminRefusal } = await import('./identity-admin.mjs');
const admin = await import('./verdict-admin.mjs');
const {
  WAYS, VERDICT_STATUSES, LAYER_WALK, L4_WALK, artefactIndex, behaviorHashOf, cardKey, verdictView, verdictsDocument,
  setVerdictFromApi, clearVerdictFromApi, planVerdictCarry, applyVerdictCarry,
} = admin;

const loadPack = (path) => adapt(parseYaml(readFileSync(join(ROOT, path), 'utf8')));
const PAYMENT = loadPack(`${SPEC_DIR}/examples/payment-service.pack.yaml`);
const KRYSTALINE = loadPack('examples/krystaline-repo-carlos.pack.yaml');
const TYPED_CANONICAL = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/taxonomy/typed-canonical.pack.json'), 'utf8'));
const OVERRIDE = JSON.parse(readFileSync(join(ROOT, 'tools/fixtures/taxonomy/taxonomy.json'), 'utf8'));

const DIR = mkdtempSync(join(tmpdir(), 'observogram-verdict-admin-'));
const DB_PATH = join(DIR, 'observogram.db');
const db = await openStore({ path: DB_PATH });
createOrg(db, 'system', { id: 'acme', name: 'Acme' });
after(() => { closeStore(DB_PATH); rmSync(DIR, { recursive: true, force: true }); });

const refuses = (fn, kind, text) => {
  assert.throws(fn, (e) => e instanceof AdminRefusal && e.kind === kind && e.message === text, `${kind}: ${text}`);
};
const actions = (filter = {}) => listAudit(db, { orgId: 'acme', limit: 1000, ...filter }).reverse().map((r) => r.action);

test('the walk is the studio board\'s: LAYER_WALK and L4_WALK equal studio/constants LAYER_DEFS and L4_SUBGROUPS (inlined, never imported)', () => {
  assert.deepEqual([...LAYER_WALK], LAYER_DEFS.map((d) => d.id));
  assert.deepEqual([...L4_WALK], L4_SUBGROUPS.map((g) => g.key));
  const src = readFileSync(join(HERE, 'verdict-admin.mjs'), 'utf8');
  assert.ok(!/from ['"]\.\.\/studio\//.test(src), 'server code imports no studio module');
  assert.deepEqual([...VERDICT_STATUSES], ['trusted', 'suspect', 'failed']);
});

test('the refusal texts name a way out', () => {
  assert.equal(WAYS.status('maybe'), 'status must be one of trusted, suspect, failed (unreviewed is the absence of a verdict: DELETE it), not "maybe"');
  assert.equal(WAYS.reason, 'reason must be a string of at most 2000 characters');
  assert.equal(WAYS.artefactId, 'artefact id must be the adapter\'s positional id (SLI-01, ALR-02 …), 1–100 characters');
  assert.equal(WAYS.noArtefact('p', 'SLI-99'), 'no artefact SLI-99 in pack p — GET /api/packs/p lists its layers and their ids');
  assert.equal(WAYS.notRegistered('payment-service'), 'pack payment-service is a catalogue pack: a verdict is recorded on a registered pack — upload it (POST /api/validate) and record the verdict on the registered id');
  assert.equal(WAYS.noVerdict('p', 'SLI-01'), 'no verdict on SLI-01 in pack p — GET /api/packs/p/verdicts lists them');
});

test('artefactIndex over payment-service: 84 entries in walk order, unique positional ids, card keys as the board writes them, no identity collision, the live family', () => {
  const index = artefactIndex(PAYMENT);
  assert.equal(index.length, 84);
  assert.equal(new Set(index.map((e) => e.artefactId)).size, 84, 'positional ids are unique');
  assert.equal(new Set(index.map((e) => e.key)).size, 84, 'identity keys are unique (0 collisions: no suffix)');
  assert.ok(index.every((e) => !e.key.includes('#')), 'no suffix without a collision');
  assert.deepEqual(index[0], {
    artefactId: 'SLI-01', layer: 'L1', sub: null, cardKey: 'L1/SLI-01', key: identityKeyOf(PAYMENT.layers.L1[0]),
    family: 'sli', behaviorHash: behaviorHashOf(PAYMENT.layers.L1[0]), title: PAYMENT.layers.L1[0].title || 'SLI-01',
  });
  // The walk: L1, L2, L2X, L3, then L4 policy → alerting → healing, L5, GOV.
  const layers = [...new Set(index.map((e) => (e.sub ? `${e.layer}/${e.sub}` : e.layer)))];
  assert.deepEqual(layers, ['L1', 'L2', 'L2X', 'L3', 'L4/policy', 'L4/alerting', 'L4/healing', 'L5', 'GOV'].filter((l) => layers.includes(l)));
  assert.ok(layers.indexOf('L4/policy') < layers.indexOf('L4/alerting') && layers.indexOf('L4/alerting') < layers.indexOf('L4/healing'));
  const alr = index.find((e) => e.sub === 'alerting');
  assert.equal(alr.cardKey, `L4/alerting/${alr.artefactId}`);
  assert.equal(cardKey('L4', 'alerting', 'ALR-01'), 'L4/alerting/ALR-01');
  assert.equal(cardKey('L1', null, 'SLI-01'), 'L1/SLI-01');
  for (const e of index) assert.match(e.behaviorHash, /^[0-9a-f]{16}$/);
  for (const e of index) assert.equal(e.family, classify(PAYMENT.layers[e.layer]?.[e.sub]?.find((a) => a.id === e.artefactId) ?? PAYMENT.layers[e.layer].find((a) => a.id === e.artefactId)));
});

test('artefactIndex over krystaline: every colliding identity group is suffixed #01..#0n in walk order, singletons bare, and no final key repeats', () => {
  const index = artefactIndex(KRYSTALINE);
  assert.equal(index.length, 600);
  assert.equal(new Set(index.map((e) => e.key)).size, 600, 'final keys are unique');
  const bare = (k) => k.replace(/#\d+$/, '');
  const groups = new Map();
  for (const e of index) {
    const b = bare(e.key);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(e.key);
  }
  const colliding = [...groups.values()].filter((g) => g.length > 1);
  assert.ok(colliding.length >= 1, `the catalogue holds colliding groups (${colliding.length})`);
  for (const g of colliding) {
    assert.deepEqual(g, g.map((_, i) => `${bare(g[0])}#${String(i + 1).padStart(2, '0')}`), 'suffixed in walk order');
  }
  for (const [b, g] of groups) if (g.length === 1) assert.equal(g[0], b, 'a singleton is bare');
  // The groups are the identity collisions the adapter produces, no more.
  const bareKeys = new Map();
  const walk = LAYER_WALK.flatMap((l) => (l === 'L4' ? L4_WALK.flatMap((s) => KRYSTALINE.layers.L4?.[s] || []) : KRYSTALINE.layers[l] || []));
  for (const a of walk) bareKeys.set(identityKeyOf(a), (bareKeys.get(identityKeyOf(a)) || 0) + 1);
  assert.equal(colliding.length, [...bareKeys.values()].filter((n) => n > 1).length);
  // A duplicate positional id (unreachable through adapt()) is a plain Error.
  assert.throws(() => artefactIndex({ layers: { L1: [{ id: 'SLI-01' }, { id: 'SLI-01' }] } }), { message: 'verdicts: duplicate artefact id SLI-01 in the adapted pack' });
  assert.deepEqual(artefactIndex(null), []);
});

test('behaviorHashOf is stable, blind to a description edit and sensitive to a behavioural one', () => {
  const slo = PAYMENT.layers.L1.find((a) => a.id.startsWith('SLO-'));
  assert.equal(behaviorHashOf(slo), behaviorHashOf(JSON.parse(JSON.stringify(slo))));
  assert.equal(behaviorHashOf({ ...slo, desc: 'other words', title: 'Other', spec: { ...slo.spec, description: 'edited' } }), behaviorHashOf(slo));
  assert.notEqual(behaviorHashOf({ ...slo, spec: { ...slo.spec, window: '7d' } }), behaviorHashOf(slo));
});

test('verdictView: the live entry gives family, card key and title; an orphan keeps the stored family and is flagged', () => {
  const row = { artefactId: 'SLI-01', family: 'stored', status: 'trusted', reason: null, actor: 'ada', setAt: 'T', carriedFrom: null };
  const entry = artefactIndex(PAYMENT)[0];
  assert.deepEqual(verdictView(row, entry), { artefact: 'SLI-01', key: 'L1/SLI-01', family: 'sli', title: entry.title, status: 'trusted', reason: null, actor: 'ada', setAt: 'T', carriedFrom: null });
  assert.deepEqual(verdictView(row, null), { artefact: 'SLI-01', key: null, family: 'stored', title: null, status: 'trusted', reason: null, actor: 'ada', setAt: 'T', carriedFrom: null, orphaned: true });
});

test('the rules over a store: a catalogue pack is 409 (nothing to record on) and answers the empty document; a registered pack takes a verdict, the same one again changes nothing, a clear empties it; every refusal kind', () => {
  runWithOrg('acme', () => {
    const catalogue = { meta: { id: 'payment-service', uploaded: false }, adapted: PAYMENT };
    assert.deepEqual(verdictsDocument(db, catalogue), { ok: true, pack: 'payment-service', verdicts: [], summary: { artefacts: 84, trusted: 0, suspect: 0, failed: 0, unreviewed: 84, orphaned: 0 } });
    refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01', body: { status: 'trusted' } }), 'conflict', WAYS.notRegistered('payment-service'));
    refuses(() => clearVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01' }), 'conflict', WAYS.notRegistered('payment-service'));
    // The body and the id are checked before the pack's status, so a bad request on a catalogue pack is 400.
    refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01', body: { status: 'maybe' } }), 'invalid', WAYS.status('maybe'));
    refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01', body: {} }), 'invalid', WAYS.status(undefined));
    refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01', body: { status: 'trusted', reason: 'x'.repeat(2001) } }), 'invalid', WAYS.reason);
    refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: 'SLI-01', body: { status: 'trusted', reason: 7 } }), 'invalid', WAYS.reason);
    for (const bad of ['', 'x'.repeat(101), '1-SLI', 'SLI 01', 'SLI/01']) refuses(() => setVerdictFromApi(db, 'ada', { ...catalogue, artefactId: bad, body: { status: 'trusted' } }), 'invalid', WAYS.artefactId);
    assert.deepEqual(actions(), [], 'nothing written');

    addPack(db, 'ada', { id: 'uploaded-pay-0123abcd', label: 'Pay' });
    const pack = { meta: { id: 'uploaded-pay-0123abcd', uploaded: true }, adapted: PAYMENT };
    refuses(() => setVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-99', body: { status: 'trusted' } }), 'missing', WAYS.noArtefact('uploaded-pay-0123abcd', 'SLI-99'));
    refuses(() => clearVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-01' }), 'missing', WAYS.noVerdict('uploaded-pay-0123abcd', 'SLI-01'));
    const first = setVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-01', body: { status: 'suspect', reason: 'the window is short' } });
    assert.deepEqual(first.changed, ['status', 'reason']);
    assert.deepEqual({ ...first.verdict, setAt: 'T' }, { artefact: 'SLI-01', key: 'L1/SLI-01', family: 'sli', title: PAYMENT.layers.L1[0].title || 'SLI-01', status: 'suspect', reason: 'the window is short', actor: 'ada', setAt: 'T', carriedFrom: null });
    const same = setVerdictFromApi(db, 'oscar', { ...pack, artefactId: 'SLI-01', body: { status: 'suspect', reason: 'the window is short' } });
    assert.deepEqual([same.changed, same.verdict.actor], [[], 'ada'], 'nothing differs: no row, the record as it was');
    const reasonOnly = setVerdictFromApi(db, 'oscar', { ...pack, artefactId: 'SLI-01', body: { status: 'suspect' } });
    assert.deepEqual([reasonOnly.changed, reasonOnly.verdict.reason, reasonOnly.verdict.actor], [['reason'], null, 'oscar'], 'an omitted reason clears the reason');
    const statusOnly = setVerdictFromApi(db, 'oscar', { ...pack, artefactId: 'SLI-01', body: { status: 'trusted', reason: '' } });
    assert.deepEqual([statusOnly.changed, statusOnly.verdict.status], [['status'], 'trusted'], 'an empty reason is no reason');
    const doc = verdictsDocument(db, pack);
    assert.deepEqual([doc.verdicts.length, doc.summary], [1, { artefacts: 84, trusted: 1, suspect: 0, failed: 0, unreviewed: 83, orphaned: 0 }]);
    assert.deepEqual(actions(), ['pack.register', 'verdict.set', 'verdict.set', 'verdict.set'], 'three records, the no-change call wrote none');
    const cleared = clearVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-01' });
    assert.deepEqual([cleared.cleared.artefact, cleared.cleared.status], ['SLI-01', 'trusted']);
    assert.deepEqual(verdictsDocument(db, pack).summary.unreviewed, 84);
    assert.deepEqual(actions({ action: 'verdict.clear' }), ['verdict.clear']);
    // An orphan: a row on an artefact the pack (adapted otherwise) no longer has.
    setVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-02', body: { status: 'failed' } });
    const shrunk = verdictsDocument(db, { ...pack, adapted: { layers: { L1: [PAYMENT.layers.L1[0]] } } });
    assert.deepEqual(shrunk.summary, { artefacts: 1, trusted: 0, suspect: 0, failed: 0, unreviewed: 1, orphaned: 1 });
    assert.deepEqual([shrunk.verdicts[0].orphaned, shrunk.verdicts[0].key, shrunk.verdicts[0].family], [true, null, 'sli']);
    clearVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-02' });
  });
});

test('planVerdictCarry with no rows returns map null and never adapts the new canonical; with rows the map keys every artefact of the new pack; applyVerdictCarry writes nothing for a null map', () => {
  runWithOrg('acme', () => {
    addPack(db, 'ada', { id: 'old', label: 'Carry' });
    addPack(db, 'ada', { id: 'new', label: 'Carry' });
    const untouchable = new Proxy({}, { get(_t, prop) { throw new Error(`adapt() read ${String(prop)} of a canonical no plan should touch`); } });
    const plan = planVerdictCarry(db, { fromPackId: 'old', toCanonical: untouchable });
    assert.deepEqual(plan, { fromPackId: 'old', rows: [], map: null });
    const before = actions();
    assert.deepEqual(applyVerdictCarry(db, 'ada', { toPackId: 'new', plan }), { kept: 0, dropped: [] });
    assert.deepEqual(applyVerdictCarry(db, 'ada', { toPackId: 'new', plan: null }), { kept: 0, dropped: [] });
    assert.deepEqual(actions(), before, 'no carry row');
    // With rows: the plan adapts the new canonical and keys its artefacts; the carry lands by key.
    const canonical = parseYaml(readFileSync(join(ROOT, `${SPEC_DIR}/examples/payment-service.pack.yaml`), 'utf8'));
    const pack = { meta: { id: 'old', uploaded: true }, adapted: PAYMENT };
    setVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLI-01', body: { status: 'trusted', reason: 'seen' } });
    setVerdictFromApi(db, 'ada', { ...pack, artefactId: 'SLO-01', body: { status: 'failed' } });
    const full = planVerdictCarry(db, { fromPackId: 'old', toCanonical: canonical });
    assert.equal(full.rows.length, 2);
    assert.equal(full.map.size, 84);
    assert.deepEqual(full.map.get(artefactIndex(PAYMENT)[0].key), { artefactId: 'SLI-01', family: 'sli', behaviorHash: artefactIndex(PAYMENT)[0].behaviorHash });
    const r = applyVerdictCarry(db, 'ada', { toPackId: 'new', plan: full });
    assert.deepEqual(r, { kept: 2, dropped: [] });
    const doc = verdictsDocument(db, { meta: { id: 'new', uploaded: true }, adapted: PAYMENT });
    assert.deepEqual(doc.verdicts.map((v) => [v.artefact, v.status, v.reason, v.carriedFrom]), [['SLI-01', 'trusted', 'seen', 'old'], ['SLO-01', 'failed', null, 'old']]);
    assert.deepEqual(actions({ action: 'verdict.carry' }), ['verdict.carry']);
  });
});

test('a taxonomy change between two registrations can drop a verdict: under the override the typed burn alert\'s family and identity key differ, so a carry planned under one taxonomy does not find it under the other', () => {
  const plain = adapt(TYPED_CANONICAL);
  const byId = (index) => new Map(index.map((e) => [e.artefactId, e]));
  configureTaxonomy(null);
  const before = byId(artefactIndex(plain));
  configureTaxonomy(compileTaxonomy(OVERRIDE));
  const after = byId(artefactIndex(plain));
  configureTaxonomy(null);
  assert.deepEqual([...before.keys()], [...after.keys()], 'the positional ids and the walk are the taxonomy\'s business nowhere');
  const pol = before.get('POL-01');
  assert.ok(pol, 'the typed fixture declares a burn alert (POL-01)');
  assert.notEqual(after.get('POL-01').family, pol.family, `the override reclassifies POL-01 (${pol.family} → ${after.get('POL-01').family})`);
  assert.notEqual(after.get('POL-01').key, pol.key, 'and its identity key follows the family');
  const moved = [...before.keys()].filter((id) => before.get(id).key !== after.get(id).key);
  assert.ok(moved.includes('POL-01') && moved.length < before.size, `only the reclassified artefacts move (${moved.join(', ')})`);
  // The carry follows the keys: a plan built under the override does not hold the plain key.
  runWithOrg('acme', () => {
    addPack(db, 'ada', { id: 'typed-old', label: 'Typed' });
    addPack(db, 'ada', { id: 'typed-new', label: 'Typed' });
    setVerdictFromApi(db, 'ada', { meta: { id: 'typed-old', uploaded: true }, adapted: plain, artefactId: 'POL-01', body: { status: 'suspect' } });
    setVerdictFromApi(db, 'ada', { meta: { id: 'typed-old', uploaded: true }, adapted: plain, artefactId: 'SLI-01', body: { status: 'trusted' } });
    configureTaxonomy(compileTaxonomy(OVERRIDE));
    let plan;
    try { plan = planVerdictCarry(db, { fromPackId: 'typed-old', toCanonical: TYPED_CANONICAL }); } finally { configureTaxonomy(null); }
    const r = applyVerdictCarry(db, 'ada', { toPackId: 'typed-new', plan });
    assert.deepEqual(r, { kept: 1, dropped: [pol.key] }, 'SLI-01 carries (its family is sli under both); POL-01 is dropped — the documented consequence (docs/ADAPTER.md)');
  });
});
