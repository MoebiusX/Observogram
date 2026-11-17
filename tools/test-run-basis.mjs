#!/usr/bin/env node
/**
 * tools/test-run-basis.mjs
 *
 * tools/lib/run-basis.mjs — what a run's match figure rests on — over the records the request
 * describes (a live side whose every probe failed, an empty comparison, a stopped Run, a partial
 * scan, a filter that excluded most files), old and new, and its studio copies
 * (studio/overview-model.mjs, studio/verdict-ui.mjs), pinned equal. node:test.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as rb from './lib/run-basis.mjs';
import { credentialParamName } from './lib/mcp-url-safety.mjs';
import * as om from '../studio/overview-model.mjs';
import { healthPctOf, historyAlignmentPct } from '../studio/verdict-ui.mjs';

const probes = (o) => ({ attempted: [], succeeded: [], empty: [], failed: [], unsupported: [], ...o });
const empty = { aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 };

// The request's situations as run records (generic names), old and new.
const R = {
  // Defect 1 as history holds it: every probe failed, an empty union, alignment 100, a pass.
  defect1Old: { outcome: 'pass', vantage: 'lost', probes: probes({ attempted: ['alert_rules', 'dashboards'], failed: ['dashboards', 'alert_rules'] }),
    probeErrors: { dashboards: 'dashboards_search: HTTP 500', alert_rules: 'alert_rules_list: HTTP 500: no backend session · ruler_rules: HTTP 500' },
    drift: { alignmentPct: 100, ...empty }, grade: { score: 54, letter: 'C' } },
  // Defect 1 as the engine now writes it (C4): a lost run, no grade, no drift.
  defect1New: { outcome: 'vantage-lost', error: 'alert_rules_list: HTTP 500: no backend session', vantage: 'lost', probes: probes({ attempted: ['alert_rules'], failed: ['alert_rules'] }),
    probeErrors: { alert_rules: 'alert_rules_list: HTTP 500: no backend session' }, gate: { breaches: [{ criterion: 'vantage', detail: 'vantage lost' }] } },
  // Defect 2 as history holds it: tools listed, no probe returned data, the record said partial.
  defect2Old: { outcome: 'gate-failed', vantage: 'partial', probes: probes({ attempted: ['alert_rules', 'metric_names'], failed: ['metric_names'], empty: ['alert_rules'] }),
    probeErrors: { metric_names: 'metrics_metadata: MCP error -32602: Input validation error' }, drift: { alignmentPct: 14, aligned: 2, drifted: 0, declaredNotLive: 12, liveNotDeclared: 0 } },
  // Every family answered, none with data (C4 with no failure).
  noData: { outcome: 'vantage-lost', error: 'no probe family returned data', vantage: 'lost', probes: probes({ attempted: ['alert_rules', 'dashboards'], empty: ['alert_rules', 'dashboards'] }), probeErrors: {} },
  // A loss before any probe (the fetch threw): no probe table, its own error.
  thrown: { outcome: 'vantage-lost', error: 'connect ECONNREFUSED https://user:pw@mcp.example.test/mcp' },
  // Defect 4: a Run that stopped on a partial scan (C8).
  stopped: { journey: 'shop.prod', startedAt: '2026-11-16T10:00:00.000Z', outcome: 'scan-partial', error: '49 of 220 files not read: grafana/a.json — HTTP 403',
    packA: { source: '/w/packs/shop.pack.yaml', scan: { files: 171, candidates: 220, partial: true, notRead: 49, notReadReasons: [{ path: 'grafana/a.json', why: 'it could not be downloaded (HTTP 403)' }] } }, packB: { source: 'mcp:https://mcp.example.test/mcp' } },
  // Defect 4 with the option off: a partial scan compared (C7), not comparable with the run before.
  partialScan: { outcome: 'gate-failed', vantage: 'full', probes: probes({ attempted: ['alert_rules'], succeeded: ['alert_rules'] }),
    drift: { alignmentPct: 54, compared: 100, aligned: 54, drifted: 6, declaredNotLive: 30, liveNotDeclared: 10 },
    packA: { scan: { files: 171, candidates: 220, partial: true, notRead: 49, filter: { surface: 'kubernetes', excluded: 12 }, excludedMost: false } },
    comparable: { withPrevious: false, reason: 'this scan could not read 49 of 220 files' } },
  // A new record over an empty union (C1/C2).
  emptyNew: { outcome: 'gate-failed', vantage: 'full', probes: probes({ attempted: ['alert_rules'], succeeded: ['alert_rules'] }), drift: { alignmentPct: null, compared: 0, ...empty } },
  // An older record over an empty union, its every family read: alignment 100, a pass.
  emptyOld: { outcome: 'pass', vantage: 'full', probes: probes({ attempted: ['alert_rules'], succeeded: ['alert_rules'] }), drift: { alignmentPct: 100, ...empty } },
  // An empty union whose declared things the live side could not read (drift.tiers), the live side in part.
  emptyUnread: { outcome: 'gate-failed', vantage: 'partial', probes: probes({ attempted: ['dashboards', 'alert_rules'], succeeded: ['alert_rules'], failed: ['dashboards'] }),
    probeErrors: { dashboards: 'dashboards_search: HTTP 401' }, drift: { alignmentPct: null, compared: 0, ...empty, tiers: { dashboards: { notRead: 7 }, alerts: { notRead: 0 } } } },
  // A hand-made fixture: a figure and no counts (no writer ever produced one): its figure stands.
  fixture: { outcome: 'pass', drift: { alignmentPct: 90 } },
  // A whole reading.
  checked: { outcome: 'pass', vantage: 'full', probes: probes({ attempted: ['alert_rules'], succeeded: ['alert_rules'] }), drift: { alignmentPct: 92, compared: 50, aligned: 46, drifted: 2, declaredNotLive: 2, liveNotDeclared: 0 } },
  // A live side read in part, a match.
  livePart: { outcome: 'gate-failed', vantage: 'partial', probes: probes({ attempted: ['alert_rules', 'dashboards'], succeeded: ['alert_rules'], failed: ['dashboards'] }),
    probeErrors: { dashboards: 'dashboards_search: HTTP 401' }, drift: { alignmentPct: 78, aligned: 252, drifted: 5, declaredNotLive: 38, liveNotDeclared: 30 } },
  restricted: { outcome: 'pass', vantage: 'restricted', drift: { alignmentPct: 80, aligned: 8, drifted: 0, declaredNotLive: 2, liveNotDeclared: 0 } },
  fileB: { outcome: 'pass', vantage: 'none', probes: probes({}), drift: { alignmentPct: 70, aligned: 7, drifted: 0, declaredNotLive: 3, liveNotDeclared: 0 } },
};

test('RB1 comparedOf: drift.compared when it is a count, else the four counts summed — the union an older record kept; null for no drift and for a drift that counts nothing', () => {
  assert.equal(rb.comparedOf(R.emptyNew.drift), 0);
  assert.equal(rb.comparedOf(R.emptyOld.drift), 0, 'an older record: its four counts');
  assert.equal(rb.comparedOf(R.livePart.drift), 325);
  assert.equal(rb.comparedOf({ compared: 7, aligned: 1 }), 7, 'the recorded count wins');
  assert.equal(rb.comparedOf({ aligned: 3, drifted: -2 }), 3, 'a negative count is none');
  assert.equal(rb.comparedOf(R.fixture.drift), null, 'a drift that counts nothing is not known');
  assert.equal(rb.comparedOf(null), null);
  assert.equal(rb.comparedOf([]), null);
});

test('RB2 vantageOf: lost when probes were attempted and none returned data, whatever the record says (defects 1 and 2 as history holds them); restricted reads full; a file-sourced Pack B keeps none', () => {
  assert.equal(rb.vantageOf(R.defect1Old), 'lost');
  assert.equal(rb.vantageOf(R.defect2Old), 'lost', 'the record said partial');
  assert.equal(rb.vantageOf(R.noData), 'lost');
  assert.equal(rb.vantageOf(R.thrown), null, 'no probe table: the record names no vantage');
  assert.equal(rb.vantageOf(R.livePart), 'partial');
  assert.equal(rb.vantageOf(R.restricted), 'full');
  assert.equal(rb.vantageOf(R.fileB), 'none');
  assert.equal(rb.vantageOf({ vantage: 'full', probes: { attempted: ['dashboards'] } }), 'full', 'a table without succeeded is not judged');
  assert.equal(rb.vantageOf({ vantage: 'lost' }), 'lost', 'a listing entry says it');
});

test('RB3 matchPctOf: the figure only over a comparison and a live side that gave data — an older record\'s 100 over an empty union is no figure; null, a missing drift, a non-number', () => {
  assert.equal(rb.matchPctOf(R.emptyOld), null, 'alignmentPct 100 and aligned 0 over an empty union: Nothing compared');
  assert.equal(rb.matchPctOf(R.emptyNew), null);
  assert.equal(rb.matchPctOf(R.defect1Old), null);
  assert.equal(rb.matchPctOf(R.defect2Old), null, 'a live side that gave no data has no figure');
  assert.equal(rb.matchPctOf(R.defect1New), null, 'no drift');
  assert.equal(rb.matchPctOf(R.checked), 92);
  assert.equal(rb.matchPctOf(R.livePart), 78);
  assert.equal(rb.matchPctOf(R.fixture), 90, 'a fixture with no counts keeps its figure');
  assert.equal(rb.matchPctOf({ drift: { alignmentPct: '88', aligned: 1 } }), null, 'a non-number is no figure');
  assert.equal(rb.matchPctOf(null), null);
});

test('RB4 firstProbeErrorOf and liveLossOf: the first failed family\'s first error in stage order, one line, credentials masked, at most 200 characters; an older lost record\'s own error; no data when no family failed and none answered', () => {
  assert.equal(rb.firstProbeErrorOf(R.defect1Old), 'alert_rules_list: HTTP 500: no backend session', 'alert_rules runs before dashboards; its first entry only');
  assert.equal(rb.firstProbeErrorOf(R.thrown), 'connect ECONNREFUSED https://***@mcp.example.test/mcp', 'a thrown loss: its own error, userinfo masked');
  assert.equal(rb.firstProbeErrorOf(R.noData), null, 'nothing failed: the record\'s "no probe family returned data" is not a probe error');
  const leaky = { outcome: 'vantage-lost', probes: probes({ attempted: ['dashboards'], failed: ['dashboards'] }),
    probeErrors: { dashboards: 'dashboards_search: HTTP 401 — https://grafana.example.test/api/search?limit=100&api_key=EXAMPLE&type=dash-db;pwd=x Authorization: Bearer abc.def' } };
  assert.equal(rb.firstProbeErrorOf(leaky), 'dashboards_search: HTTP 401 — https://grafana.example.test/api/search?limit=100&api_key=***&type=dash-db;pwd=*** Authorization: Bearer ***');
  const long = { outcome: 'vantage-lost', probes: probes({ attempted: ['dashboards'], failed: ['dashboards'] }), probeErrors: { dashboards: `x\n${'y'.repeat(400)}` } };
  const cut = rb.firstProbeErrorOf(long);
  assert.equal(cut.length, 200);
  assert.ok(cut.endsWith('…') && !cut.includes('\n'));
  assert.deepEqual(rb.liveLossOf(R.defect1New), { cause: 'error', error: 'alert_rules_list: HTTP 500: no backend session' });
  assert.deepEqual(rb.liveLossOf(R.noData), { cause: 'no-data', error: null });
  assert.deepEqual(rb.liveLossOf({ outcome: 'vantage-lost' }), { cause: 'error', error: null }, 'a loss with nothing recorded: did not answer');
  assert.deepEqual(rb.liveLossOf(R.checked), { cause: 'unknown', error: null });
});

test('RB5 runBasis over the request\'s seven situations: unreachable with the first probe error, no live data, a stopped Run\'s partial scan, nothing compared with its reason, a partial live side, a partial scan compared, checked', () => {
  const t = (r) => { const b = rb.runBasis(r); return [b.state, b.text]; };
  assert.deepEqual(t(R.defect1Old), ['unreachable', 'Live did not answer — alert_rules_list: HTTP 500: no backend session'], 'defect 1: never 100%');
  assert.deepEqual(t(R.defect1New), ['unreachable', 'Live did not answer — alert_rules_list: HTTP 500: no backend session']);
  assert.deepEqual(t(R.defect2Old), ['unreachable', 'Live did not answer — metrics_metadata: MCP error -32602: Input validation error'], 'defect 2: never 14%');
  assert.deepEqual(t(R.noData), ['unreachable', 'Live returned no data']);
  assert.deepEqual(t(R.thrown), ['unreachable', 'Live did not answer — connect ECONNREFUSED https://***@mcp.example.test/mcp']);
  assert.deepEqual(t(R.stopped), ['scan-partial', 'Partial scan — 49 of 220 files not read; the previous pack is kept'], 'defect 4: the previous pack is kept');
  assert.deepEqual(t(R.partialScan), ['partial', '54% match — 49 of 220 files not read']);
  assert.deepEqual(t(R.emptyNew), ['nothing', 'Nothing compared — Neither side had anything this check could compare']);
  assert.deepEqual(t(R.emptyOld), ['nothing', 'Nothing compared — Neither side had anything this check could compare'], 'an older record\'s 100 over an empty union');
  assert.deepEqual(t(R.emptyUnread), ['nothing', 'Nothing compared — 7 declared things not read live'], 'the first reason that holds');
  assert.deepEqual(t(R.livePart), ['partial', '78% match — Live answered in part: dashboards not read']);
  assert.deepEqual(t(R.checked), ['checked', '92% match']);
  assert.deepEqual(t(null), ['never', 'Never checked']);
  // The reasons, in order: declared not read live, live in part, files not read (the host's cut too), scoped, set aside.
  const r = (f) => rb.nothingReason(f);
  assert.equal(r({ notReadLive: 0, probesFailed: ['metric_names', 'dashboards'] }), 'Live answered in part: metric names and dashboards not read');
  assert.equal(r({ scan: { notRead: 3, candidates: 9, treeTruncated: true } }), '3 of 9 files not read; the host cut its file list short');
  assert.equal(r({ scan: { partial: true, notRead: null, candidates: null } }), 'The scan did not read every file');
  assert.equal(r({ scoped: true }), 'The live read was scoped to part of the estate');
  assert.equal(r({ setAsideCount: 4 }), 'Every difference was set aside');
  assert.equal(r({}), rb.NOTHING_REASON);
  // Readings, as the Journeys and Neuron views count them.
  assert.deepEqual(Object.fromEntries(Object.entries(R).map(([k, x]) => [k, rb.readingOutcome(x)])), {
    defect1Old: 'vantage-lost', defect1New: 'vantage-lost', defect2Old: 'vantage-lost', noData: 'vantage-lost', thrown: 'vantage-lost', stopped: 'scan-partial',
    partialScan: 'gate-failed', emptyNew: 'nothing-compared', emptyOld: 'nothing-compared', emptyUnread: 'nothing-compared', fixture: 'pass', checked: 'pass',
    livePart: 'gate-failed', restricted: 'pass', fileB: 'pass',
  });
  assert.equal(rb.readingOutcome({ outcome: 'pass', compared: 0 }), 'nothing-compared', 'a listing entry: its compared');
  assert.deepEqual(['emptyOld', 'defect1Old', 'checked', 'noData', 'fixture'].map((k) => rb.alignmentWords(R[k])), ['nothing compared', 'live did not answer', 'alignment 92%', 'live returned no data', 'alignment 90%']);
  assert.equal(rb.alignmentWords({ outcome: 'pass', drift: { alignmentPct: null, aligned: 1 } }), 'alignment not recorded');
});

test('RB6 basisSummary: what GET /api/journeys lists of the last run — the figure only over a comparison, compared, vantage, failed families, the first probe error, the scan\'s counts and filter, comparable; bounded, nothing else of the record', () => {
  const s = rb.basisSummary(R.partialScan);
  assert.deepEqual(s, {
    alignmentPct: 54, compared: 100, vantage: 'full', reading: 'gate-failed', firstProbeError: null, liveLoss: null,
    notReadLive: null, probesFailed: [], scoped: false, setAsideCount: 0,
    scan: { partial: true, notRead: 49, candidates: 220, files: 171, treeTruncated: false, filter: { surface: 'kubernetes', excluded: 12 }, excludedMost: false },
    comparable: { withPrevious: false, reason: 'this scan could not read 49 of 220 files' },
  });
  assert.deepEqual([rb.basisSummary(R.emptyOld).alignmentPct, rb.basisSummary(R.emptyOld).compared], [null, 0], 'an older record\'s 100 over an empty union lists no figure');
  assert.deepEqual([rb.basisSummary(R.noData).liveLoss, rb.basisSummary(R.defect1New).liveLoss], ['no-data', 'error']);
  const old = rb.basisSummary({ packA: { scan: { files: 3, candidates: 17, environment: { profile: 'prod', excluded: 14 } } } });
  assert.deepEqual(old.scan.filter, { surface: 'prod', excluded: 14 }, 'a scan before C7: its environment scope is its filter');
  const huge = rb.basisSummary({ outcome: 'gate-failed', probes: probes({ attempted: ['x'], succeeded: ['y'], failed: Array.from({ length: 12 }, (_, i) => `f${i}${'z'.repeat(60)}`) }) });
  assert.ok(huge.probesFailed.length === 8 && huge.probesFailed.every((f) => f.length <= 40), 'at most eight families, each at most 40 characters');
  assert.ok(!JSON.stringify(rb.basisSummary(R.thrown)).includes('pw@'), 'no userinfo rides along');
  // A stopped Run, as the listing names it beside the last check (A9).
  assert.deepEqual(rb.stoppedSummary(R.stopped), { startedAt: '2026-11-16T10:00:00.000Z', notRead: 49, candidates: 220, firstReason: 'grafana/a.json — it could not be downloaded (HTTP 403)' });
  assert.equal(rb.stoppedSummary(R.checked), null);
});

test('RB7 the studio\'s copies agree: overview-model\'s rule and verdict-ui\'s history figure give run-basis\'s answers over every record above; the credential rule is mcp-url-safety\'s; verdict-ui\'s healthPctOf is no figure over an empty denominator, whether the engine says null or (before that rule) 100', () => {
  const same = ['comparedOf', 'vantageOf', 'matchPctOf', 'firstProbeErrorOf', 'liveLossOf', 'readingOutcome', 'basisFactsOf', 'scanPartialReading', 'filesNotReadWords', 'nothingReason', 'safeErrorText'];
  for (const name of same) assert.equal(typeof om[name], 'function', `overview-model exports ${name}`);
  for (const [k, r] of Object.entries(R)) {
    assert.deepEqual(om.comparedOf(r.drift), rb.comparedOf(r.drift), `comparedOf ${k}`);
    for (const name of ['vantageOf', 'matchPctOf', 'firstProbeErrorOf', 'liveLossOf', 'readingOutcome', 'basisFactsOf']) assert.deepEqual(om[name](r), rb[name](r), `${name} ${k}`);
    assert.equal(om.scanPartialReading(r.packA?.scan), rb.scanPartialReading(r.packA?.scan), `scanPartialReading ${k}`);
    assert.equal(om.nothingReason(rb.basisFactsOf(r)), rb.nothingReason(rb.basisFactsOf(r)), `nothingReason ${k}`);
    assert.deepEqual(om.partialParts(rb.basisFactsOf(r), rb.vantageOf(r)), rb.partialParts(rb.basisFactsOf(r), rb.vantageOf(r)), `partialParts ${k}`);
    assert.equal(historyAlignmentPct(r), rb.matchPctOf(r), `verdict-ui historyAlignmentPct ${k}`);
  }
  // The credential words: the copy decides as the server's rule does, over the names its own tests pin.
  const names = [...readFileSync(new URL('../server/test-mcp-url.mjs', import.meta.url), 'utf8').matchAll(/'([A-Za-z0-9_.-]{2,40})'/g)].map((m) => m[1]);
  assert.ok(names.length > 40, `read ${names.length} names`);
  for (const n of [...names, 'token', 'apiKey', 'X-Amz-Signature', 'sortkey', 'bypass', 'design', 'keyspace', 'author', 'tier']) assert.equal(om.credentialName(n), credentialParamName(n), `credential name ${n}`);
  for (const t of ['a?token=1&b=2', 'https://u:p@h/x?sig=9#f', 'x;pwd=1', 'Bearer abc', 'plain', `${'z'.repeat(300)}`]) assert.equal(om.safeErrorText(t), rb.safeErrorText(t), `safeErrorText ${t.slice(0, 20)}`);
  // The weighted health.
  assert.equal(healthPctOf({ healthPct: null, totalBadness: 0 }, 0), null, 'the engine says null');
  assert.equal(healthPctOf({ healthPct: 100, totalBadness: 0 }, 0), null, 'an engine before that rule says 100 over nothing');
  assert.equal(healthPctOf({ healthPct: 87, totalBadness: 3 }, 20), 87);
  assert.equal(healthPctOf(null), null);
});
