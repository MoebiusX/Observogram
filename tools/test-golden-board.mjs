#!/usr/bin/env node
/**
 * tools/test-golden-board.mjs
 *
 * Golden-output regression gate for the Discover BOARD and the artefact
 * FAMILIES. For every catalogue pack (examples/*.pack.yaml,
 * reference-packs/*.pack.yaml and the vendored spec example) the adapted
 * pack is rendered the way studio/layers-view.mjs renders it — the board's
 * head (boardHeadHtml) and one band of groups per layer (boardGroupsHtml),
 * the entries built exactly as layerEntries()/discoverModel() build them —
 * and every artefact's family (tools/lib/artefact-model.mjs classify) is
 * written beside the rule that decided it (tools/lib/artefact-classify.mjs
 * classifyArtefact().via). Both must be byte-identical to
 * the committed goldens:
 *
 *   tools/fixtures/golden/board/<pack>.board.html
 *   tools/fixtures/golden/board/<pack>.families.json
 *
 * Why: the board groups artefacts and the diff/traceability/blast-radius
 * engines key them by family. A change to the classification — a new
 * rule, a reordered one, a group that moves — must show up as a golden
 * diff reviewed in the same commit, never as a silent regrouping. The
 * families file keys entries `${layer}:${sub}:${id}` (the L4 subgroup in
 * the key, like layers-view's cardKey) and records `via` next to the
 * family, so a move from one rule to another is visible even when the
 * family it lands on is unchanged.
 *
 * The typed fixture (tools/fixtures/taxonomy/typed.pack.json — a layered pack
 * from another toolchain: every artefact carries a `type`, the ids follow
 * its own scheme) is rendered twice: with no override (typed.unmapped.*: a
 * foreign type name places nothing, so those artefacts are each layer's
 * "Other"; a family name in `type` is read) and with
 * tools/fixtures/taxonomy/taxonomy.json (typed.mapped.*: every artefact in
 * its family's group, none in "Other"). The same override is installed
 * process-wide for the diff, so a self-diff of the typed pack keys every
 * artefact by its family — what the server does with OBSERVOGRAM_TAXONOMY.
 *
 * The typed-canonical fixture (tools/fixtures/taxonomy/typed-canonical.pack.json)
 * is examples/production-curated.pack.yaml as JSON with seven declared types
 * in metadata.annotations["observogram.artefact.type.<symbol>"] — a CANONICAL
 * pack with declared types, the shape --pack and the server accept — so
 * tools/test-studio-bundle.mjs T8 can prove a baked bundle against a
 * configured server over the same goldens (typed-canonical.unmapped.* and
 * typed-canonical.mapped.*). Without the override the adapter's `defines`
 * and ids place every artefact (a declared type name a default family does
 * not know places nothing); with it POL-01 moves from burn_rate/id to
 * alert_rule/type — the L4 band regroups.
 *
 * To update after an INTENDED output change:
 *   node tools/test-golden-board.mjs --update
 * then review `git diff tools/fixtures/golden/board/`. Exit 0 = pass.
 */

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { SPEC_DIR } from './lib/validator.mjs';
import { adapt } from './lib/adapter.mjs';
import { classify } from './lib/artefact-model.mjs';
import { diffPacks } from './lib/diff.mjs';
import * as artefactClassify from './lib/artefact-classify.mjs';
import { bindTaxonomy } from '../studio/taxonomy.mjs';
import { createHarness } from './lib/harness.mjs';
import { LAYER_DEFS, L4_SUBGROUPS } from '../studio/constants.mjs';
import { boardHeadHtml, boardGroupsHtml } from '../studio/discover-board.mjs';

const { classifyArtefact } = artefactClassify;
// The board groups through the bound taxonomy (studio/taxonomy.mjs), as the
// studio's boot() binds it — here with no override: the default families.
bindTaxonomy(artefactClassify, null);

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const GOLDEN_DIR = resolve(__dirname, 'fixtures/golden/board');

const { assert, report } = createHarness({ indent: '  ', truncate: 200 });
const UPDATE = process.argv.includes('--update');

// ---------------------------------------------------------------------------
// The packs: the whole catalogue the studio offers, so the proof covers every
// id family the adapter emits. Adding a pack adds a golden pair (--update).
// ---------------------------------------------------------------------------
const packFiles = (dir) => readdirSync(resolve(ROOT, dir)).filter(f => f.endsWith('.pack.yaml')).sort().map(f => `${dir}/${f}`);
const PACKS = [
  `${SPEC_DIR}/examples/payment-service.pack.yaml`,
  ...packFiles('examples'),
  ...packFiles('reference-packs'),
].map(path => ({ id: basename(path, '.pack.yaml'), path }));

// ---------------------------------------------------------------------------
// The render, mirroring studio/layers-view.mjs: layerEntries() (L4 split on
// its subgroups, `sub` null elsewhere), the entry key, the head's facts.
// ---------------------------------------------------------------------------
export function boardEntries(pack, layerId) {
  const layers = pack?.layers || {};
  const key = (sub, id) => (sub ? `${layerId}/${sub}/${id}` : `${layerId}/${id}`);
  if (layerId === 'L4') {
    const out = [];
    for (const sg of L4_SUBGROUPS) for (const a of (layers.L4?.[sg.key] || [])) out.push({ a, sub: sg.key, key: key(sg.key, a.id) });
    return out;
  }
  return (layers[layerId] || []).map(a => ({ a, sub: null, key: key(null, a.id) }));
}

export function renderBoard(pack, { env = '' } = {}) {
  const bands = LAYER_DEFS.map(def => ({ id: def.id, entries: boardEntries(pack, def.id) }));
  const artefacts = bands.flatMap(b => b.entries.map(e => e.a));
  const head = boardHeadHtml({
    meta: { ...(pack.meta || {}), service: pack.meta?.service || '' },
    env,
    total: artefacts.length,
    layers: bands.filter(b => b.entries.length > 0).length,
    artefacts,
  });
  const groups = bands
    .filter(b => !(b.id === 'L2X' && !b.entries.length))   // optional in the spec: no band when empty
    .map(b => `<!-- ${b.id} -->\n${boardGroupsHtml(b.id, b.entries)}`);
  return `${head}\n${groups.join('\n')}\n`;
}

export function familiesOf(pack) {
  const out = {};
  for (const def of LAYER_DEFS) {
    for (const e of boardEntries(pack, def.id)) {
      const family = classify(e.a);
      const { via } = classifyArtefact(e.a);
      out[`${def.id}:${e.sub ?? ''}:${e.a.id}`] = { family, via };
    }
  }
  return Object.fromEntries(Object.entries(out).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0)));
}

// ---------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------
function checkGolden(file, actual, label) {
  const path = resolve(GOLDEN_DIR, file);
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, actual);
    assert(true, `${label}: golden written (${actual.length} bytes)`);
    return;
  }
  if (!existsSync(path)) { assert(false, `${label}: golden ${file} is missing (run with --update)`); return; }
  const expected = readFileSync(path, 'utf8');
  if (expected === actual) { assert(true, `${label}: byte-identical to ${file}`); return; }
  const a = expected.split('\n');
  const b = actual.split('\n');
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  assert(false, `${label}: differs from ${file} at line ${i + 1}`, b[i], a[i]);
}

const loadPack = (path) => adapt(parseYaml(readFileSync(resolve(ROOT, path), 'utf8')));
const loadJson = (path) => JSON.parse(readFileSync(resolve(ROOT, path), 'utf8'));
const TYPED = loadJson('tools/fixtures/taxonomy/typed.pack.json');
const TYPED_CANONICAL = adapt(loadJson('tools/fixtures/taxonomy/typed-canonical.pack.json'));
const OVERRIDE = loadJson('tools/fixtures/taxonomy/taxonomy.json');
// The [group, n] pairs of one layer's band, in board order (studio/discover-board.mjs
// boardGroupsHtml writes data-group and aria-label="<title>: <n>" on every section).
export const boardGroupCounts = (html, layer) => [...(html.split(`<!-- ${layer} -->`)[1] || '').split('<!-- ')[0].matchAll(/data-group="([a-z]+)" aria-label="[^"]*: (\d+)"/g)].map(m => [m[1], Number(m[2])]);
const groupsOf = boardGroupCounts;
const nonEmptyGroups = (html, layer) => groupsOf(html, layer).filter(([, n]) => n > 0).map(([g]) => g);

// The typed fixture, unbound config and bound config: the two goldens, and
// what each must show.
function typedCases() {
  const entriesOf = (pack) => LAYER_DEFS.flatMap(def => boardEntries(pack, def.id));
  const total = entriesOf(TYPED).length;
  const selfDiff = (pack) => JSON.stringify(diffPacks(pack, pack));

  // --- unmapped: the default families, no override ---
  bindTaxonomy(artefactClassify, null);
  const unmappedHtml = renderBoard(TYPED, { env: 'prod' });
  const unmappedFamilies = familiesOf(TYPED);
  checkGolden('typed.unmapped.board.html', unmappedHtml, 'typed unmapped board');
  checkGolden('typed.unmapped.families.json', JSON.stringify(unmappedFamilies, null, 2) + '\n', 'typed unmapped families');
  assert(total === 17, 'the typed fixture holds 17 artefacts', total, 17);
  const foreign = Object.entries(unmappedFamilies).filter(([, v]) => v.via === 'none');
  assert(foreign.length === 13 && foreign.every(([, v]) => v.family === 'unknown'), 'unmapped: the 13 artefacts with a foreign type name (12) or none (1) have no family', foreign.map(([k, v]) => `${k}=${v.family}/${v.via}`));
  assert(unmappedFamilies['L1::checkout-error-budget-sli'].family === 'sli' && unmappedFamilies['L1::checkout-error-budget-sli'].via === 'type', 'unmapped: a family name in `type` is read with no override (the one default-behaviour change)', unmappedFamilies['L1::checkout-error-budget-sli']);
  for (const [k, fam] of [['L2::mimir-main', 'backend'], ['L4:policy:burn-checkout-fast', 'burn_rate'], ['L4:healing:heal-rollout-restart', 'remediation']]) {
    assert(unmappedFamilies[k].family === fam && unmappedFamilies[k].via === 'type', `unmapped: ${k} declares the family ${fam}`, unmappedFamilies[k]);
  }
  assert(JSON.stringify(nonEmptyGroups(unmappedHtml, 'L1')) === JSON.stringify(['sli', 'other']), 'unmapped L1: the family-named SLI in sli, the four PackSLI/PackSLO in Other', nonEmptyGroups(unmappedHtml, 'L1'));
  assert(JSON.stringify(groupsOf(unmappedHtml, 'L1').find(([g]) => g === 'other')) === JSON.stringify(['other', 4]), 'unmapped L1: Other holds 4', groupsOf(unmappedHtml, 'L1'));
  assert(JSON.stringify(nonEmptyGroups(unmappedHtml, 'L2')) === JSON.stringify(['exp', 'other']), 'unmapped L2: the backend in exp, the OtelContract in Other', nonEmptyGroups(unmappedHtml, 'L2'));
  assert(JSON.stringify(nonEmptyGroups(unmappedHtml, 'L3')) === JSON.stringify(['other']), 'unmapped L3: a flat wall', nonEmptyGroups(unmappedHtml, 'L3'));
  assert(JSON.stringify(nonEmptyGroups(unmappedHtml, 'L4')) === JSON.stringify(['pol', 'heal', 'other']), 'unmapped L4: the two family-named ones placed, the rules and routes in Other', nonEmptyGroups(unmappedHtml, 'L4'));
  assert(!unmappedHtml.includes('<dt>OTel SemConv</dt>'), 'unmapped head: the OtelContract is not read as the instrumentation contract');
  assert(unmappedHtml.includes('<dd title="mimir">mimir</dd>'), 'unmapped head: the family-named backend is a fact');
  const unmappedDiff = selfDiff(TYPED);
  const u = JSON.parse(unmappedDiff);
  assert(u.summary.inBoth === 17 && u.summary.aligned === 17 && u.summary.onlyInA === 0 && u.summary.onlyInB === 0 && u.collisions.length === 0, 'unmapped self-diff: every artefact pairs with itself (unknown kinds key by id)', u.summary);
  assert(unmappedDiff.includes('"unknown::'), 'unmapped self-diff: foreign artefacts key as unknown');

  // --- mapped: the override installed, as start() installs OBSERVOGRAM_TAXONOMY ---
  bindTaxonomy(artefactClassify, OVERRIDE);
  try {
    const mappedHtml = renderBoard(TYPED, { env: 'prod' });
    const mappedFamilies = familiesOf(TYPED);
    checkGolden('typed.mapped.board.html', mappedHtml, 'typed mapped board');
    checkGolden('typed.mapped.families.json', JSON.stringify(mappedFamilies, null, 2) + '\n', 'typed mapped families');
    assert(!mappedHtml.includes('data-group="other"'), 'mapped: no "Other" group anywhere');
    assert(Object.values(mappedFamilies).every(v => v.family !== 'unknown'), 'mapped: every artefact has a family', Object.entries(mappedFamilies).filter(([, v]) => v.family === 'unknown').map(([k]) => k));
    const vias = Object.values(mappedFamilies).map(v => v.via);
    assert(vias.filter(v => v === 'type').length === 16 && vias.filter(v => v === 'override').length === 1, 'mapped: 16 by type, 1 by the override id rule', vias);
    assert(mappedFamilies['L4:alerting:promrule-LatencyBudgetBurn'].family === 'alert_rule' && mappedFamilies['L4:alerting:promrule-LatencyBudgetBurn'].via === 'override', 'mapped: the untyped promrule- id is placed by the id rule', mappedFamilies['L4:alerting:promrule-LatencyBudgetBurn']);
    for (const [layer, want] of [['L1', ['sli', 'slo']], ['L2', ['otel', 'exp']], ['L3', ['qry', 'dash']], ['L4', ['pol', 'alr', 'rule', 'heal']]]) {
      assert(JSON.stringify(nonEmptyGroups(mappedHtml, layer)) === JSON.stringify(want), `mapped ${layer}: groups ${want.join('/')} non-empty, nothing else`, nonEmptyGroups(mappedHtml, layer), want);
    }
    assert(JSON.stringify(groupsOf(mappedHtml, 'L1')) === JSON.stringify([['sli', 3], ['slo', 2]]), 'mapped L1: 3 indicators, 2 objectives', groupsOf(mappedHtml, 'L1'));
    assert(JSON.stringify(groupsOf(mappedHtml, 'L4').filter(([, n]) => n)) === JSON.stringify([['pol', 1], ['alr', 2], ['rule', 2], ['heal', 1]]), 'mapped L4: both rules (typed and id-matched) in rule', groupsOf(mappedHtml, 'L4'));
    assert(mappedHtml.includes('<dt>OTel SemConv</dt><dd title="1.28.0">1.28.0</dd>') && mappedHtml.includes('<dd title="go, typescript">go, typescript</dd>'), 'mapped head: the OtelContract is the instrumentation contract (semconv, languages)');
    assert(mappedHtml.includes('data-key="L4/alerting/promrule-HighErrorRate"') && mappedHtml.includes('data-sev="SEV1"'), 'mapped: items open their records; routes draw their severity');
    // The server installs the same override process-wide (server/taxonomy.mjs):
    // classify() keys the self-diff by family, with no collision and every artefact paired.
    const mappedDiff = selfDiff(TYPED);
    const m = JSON.parse(mappedDiff);
    assert(m.summary.inBoth === 17 && m.summary.aligned === 17 && m.summary.onlyInA === 0 && m.summary.onlyInB === 0 && m.collisions.length === 0, 'mapped self-diff: every artefact pairs with itself by family', m.summary);
    assert(!mappedDiff.includes('"unknown::') && mappedDiff.includes('"sli::') && mappedDiff.includes('"alert_rule::') && mappedDiff.includes('"dashboard::'), 'mapped self-diff: the keys carry the mapped families (classify() honours the override server-side)');
    assert(mappedDiff !== unmappedDiff, 'the override changes the diff of a typed pack');
  } finally {
    bindTaxonomy(artefactClassify, null);
  }
  assert(artefactClassify.activeTaxonomy() === null, 'the override is gone again');
  assert(selfDiff(TYPED) === unmappedDiff, 'configureTaxonomy(null) restores the unmapped self-diff byte for byte');
}

// The typed-canonical fixture: a canonical pack with seven declared types,
// adapted — the shape --pack and the server accept. Unmapped, the adapter's
// `defines`/ids place everything; mapped, the declared types win where they
// differ (POL-01: burn_rate/id → alert_rule/type), so the L4 band regroups.
function typedCanonicalCases() {
  const nonEmpty = (html, layer) => groupsOf(html, layer).filter(([, n]) => n);
  const typed = LAYER_DEFS.flatMap(def => boardEntries(TYPED_CANONICAL, def.id)).filter(e => typeof e.a.type === 'string');
  assert(typed.length === 7, 'the typed-canonical fixture carries 7 declared types through the adapter', typed.map(e => `${e.key}=${e.a.type}`), 7);

  // --- unmapped: no override — a declared type the default families do not know places nothing ---
  bindTaxonomy(artefactClassify, null);
  const unmappedHtml = renderBoard(TYPED_CANONICAL, { env: 'prod' });
  const unmappedFamilies = familiesOf(TYPED_CANONICAL);
  checkGolden('typed-canonical.unmapped.board.html', unmappedHtml, 'typed-canonical unmapped board');
  checkGolden('typed-canonical.unmapped.families.json', JSON.stringify(unmappedFamilies, null, 2) + '\n', 'typed-canonical unmapped families');
  const typedKeys = typed.map(e => `${e.key.split('/')[0]}:${e.sub ?? ''}:${e.a.id}`);
  assert(typedKeys.every(k => ['defines', 'id'].includes(unmappedFamilies[k].via)), 'unmapped: every typed artefact classifies via defines or id (the adapter decides, the foreign name places nothing)', typedKeys.map(k => `${k}=${unmappedFamilies[k].family}/${unmappedFamilies[k].via}`));
  assert(JSON.stringify(nonEmpty(unmappedHtml, 'L4')) === JSON.stringify([['pol', 3], ['alr', 2]]), 'unmapped L4: pol 3 · alr 2', nonEmpty(unmappedHtml, 'L4'));
  assert(unmappedFamilies['L4:policy:POL-01'].family === 'burn_rate' && unmappedFamilies['L4:policy:POL-01'].via === 'id', 'unmapped: POL-01 is a burn rate by id', unmappedFamilies['L4:policy:POL-01']);

  // --- mapped: the override installed, as the server installs OBSERVOGRAM_TAXONOMY ---
  bindTaxonomy(artefactClassify, OVERRIDE);
  try {
    const mappedHtml = renderBoard(TYPED_CANONICAL, { env: 'prod' });
    const mappedFamilies = familiesOf(TYPED_CANONICAL);
    checkGolden('typed-canonical.mapped.board.html', mappedHtml, 'typed-canonical mapped board');
    checkGolden('typed-canonical.mapped.families.json', JSON.stringify(mappedFamilies, null, 2) + '\n', 'typed-canonical mapped families');
    assert(JSON.stringify(nonEmpty(mappedHtml, 'L4')) === JSON.stringify([['pol', 2], ['alr', 2], ['rule', 1]]), 'mapped L4: pol 2 · alr 2 · rule 1 — POL-01 moved to the rules', nonEmpty(mappedHtml, 'L4'));
    for (const [k, family] of [['L1::SLI-01', 'sli'], ['L1::SLO-01', 'slo'], ['L2::OTEL-01', 'otel'], ['L3::QRY-01', 'recording_rule'], ['L3::DASH-01', 'dashboard'], ['L4:alerting:ALR-01', 'alert_route'], ['L4:policy:POL-01', 'alert_rule']]) {
      assert(mappedFamilies[k]?.family === family && mappedFamilies[k]?.via === 'type', `mapped: ${k} is ${family} by its declared type`, mappedFamilies[k], { family, via: 'type' });
    }
    assert(mappedHtml !== unmappedHtml, 'the override changes the board of the typed-canonical pack');
  } finally {
    bindTaxonomy(artefactClassify, null);
  }
  assert(artefactClassify.activeTaxonomy() === null, 'the override is gone again');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  // The catalogue, with the override installed and removed around it: an
  // adapted pack's board, families and self-diff are byte-identical either
  // way (adapted artefacts carry no `type`; `defines` beats every id rule).
  const payment = loadPack(PACKS[0].path);
  const paymentBoard = renderBoard(payment);
  const paymentDiff = JSON.stringify(diffPacks(payment, payment));
  bindTaxonomy(artefactClassify, OVERRIDE);
  let withOverride;
  try { withOverride = { board: renderBoard(payment), families: JSON.stringify(familiesOf(payment)), diff: JSON.stringify(diffPacks(payment, payment)) }; }
  finally { bindTaxonomy(artefactClassify, null); }
  for (const { id, path } of PACKS) {
    process.stdout.write(`\n${id}\n`);
    const pack = loadPack(path);
    checkGolden(`${id}.board.html`, renderBoard(pack), 'board');
    checkGolden(`${id}.families.json`, JSON.stringify(familiesOf(pack), null, 2) + '\n', 'families');
  }
  process.stdout.write('\nthe override over an adapted pack\n');
  assert(withOverride.board === paymentBoard, 'payment-service: the board is byte-identical with the override installed');
  assert(withOverride.families === JSON.stringify(familiesOf(payment)), 'payment-service: every family and via is unchanged by the override');
  assert(withOverride.diff === paymentDiff && paymentDiff === JSON.stringify(diffPacks(payment, payment)), 'payment-service: the self-diff is byte-identical with the override installed and after it is removed');
  process.stdout.write('\ntyped (tools/fixtures/taxonomy/typed.pack.json)\n');
  typedCases();
  process.stdout.write('\ntyped-canonical (tools/fixtures/taxonomy/typed-canonical.pack.json)\n');
  typedCanonicalCases();
  report('golden board', UPDATE ? 'board goldens updated — review git diff tools/fixtures/golden/board/' : 'all board goldens byte-identical.');
}
