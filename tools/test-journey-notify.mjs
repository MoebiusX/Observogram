#!/usr/bin/env node
/**
 * tools/test-journey-notify.mjs
 *
 * Unit test for tools/lib/journey-notify.mjs — the pure half of a
 * journey's `notify:` block (step 5): the decision truth table per policy,
 * the payload shape (copied from the record, never recomputed; credentials
 * redacted; nothing from the definition or the environment), the text
 * rendering, and the zero-import guard. The wire is exercised by
 * tools/test-journey.mjs against a node:http receiver. Exit 0 = pass.
 */

import { readFileSync } from 'node:fs';
import { createHarness } from './lib/harness.mjs';
import {
  NOTIFY_POLICIES, NOTIFY_DEFAULT_POLICY, NOTIFY_FORMATS, NOTIFY_TIMEOUT_DEFAULT_MS, NOTIFY_TIMEOUT_MIN_MS, NOTIFY_TIMEOUT_MAX_MS,
  NOTIFY_KEYS, NOTIFY_FORBIDDEN_KEYS, NOTIFY_PAYLOAD_KIND, NOTIFY_PAYLOAD_VERSION,
  notifyDecision, chainGotWorse, newCandidateCauses, redactUrlCredentials, buildNotifyPayload, renderNotifyText, runIdOf,
} from './lib/journey-notify.mjs';

const { assert, report } = createHarness();

// --- vendoring guard: zero-import, no Node APIs, no environment ---
const src = readFileSync(new URL('./lib/journey-notify.mjs', import.meta.url), 'utf8');
assert(!/^\s*import\s/m.test(src), 'journey-notify.mjs is zero-import (browser-safe, previewable by the studio)');
assert(!/from\s+'node:/.test(src) && !/process\.env/.test(src) && !/\bprocess\./.test(src) && !/\bfetch\(/.test(src), 'journey-notify.mjs reads no node: module, no environment and never touches the wire');
// Fix round 0: a raw U+0000 once sat inside the causeKey template literal
// (the tool-transport trap) — git classed the module as binary (no line
// diff, no blame) and /lib served a control byte to the browser. Byte-wise
// check, written without escape sequences so the guard itself cannot regress
// the same way: only TAB, LF and CR are allowed below 0x20.
{
  const controlBytes = [];
  for (let i = 0; i < src.length; i++) {
    const c = src.charCodeAt(i);
    if (c < 0x20 && c !== 9 && c !== 10 && c !== 13) controlBytes.push({ offset: i, code: c });
  }
  assert(controlBytes.length === 0, 'journey-notify.mjs contains no control byte (git must diff it as text)', controlBytes.slice(0, 3));
}

// --- the vocabulary ---
assert(NOTIFY_POLICIES.join() === 'transitions,breach,always' && Object.isFrozen(NOTIFY_POLICIES) && NOTIFY_DEFAULT_POLICY === 'transitions', 'policies: transitions (default) · breach · always');
assert(NOTIFY_FORMATS.join() === 'json,text' && NOTIFY_TIMEOUT_DEFAULT_MS === 5000 && NOTIFY_TIMEOUT_MIN_MS === 1000 && NOTIFY_TIMEOUT_MAX_MS === 60000, 'formats json|text; timeout default 5000 within [1000, 60000]');
assert(NOTIFY_KEYS.join() === 'urlEnv,authEnv,on,format,timeoutMs,studioUrl' && Object.keys(NOTIFY_FORBIDDEN_KEYS).join() === 'url,token,headers', 'known keys are env NAMES + policy knobs; url/token/headers are forbidden literals');
assert(NOTIFY_PAYLOAD_KIND === 'observogram.journey' && NOTIFY_PAYLOAD_VERSION === 1, 'payload kind/version are pinned');

// --- fixtures ---
const pass = (startedAt, extra = {}) => ({ journey: 'j', startedAt, tookMs: 5, outcome: 'pass', gate: { thresholds: {}, breaches: [] }, transition: { since: null, changed: [], appeared: [], disappeared: [], any: false, skipped: [], reason: 'first run' }, causes: null, ...extra });
const failed = (startedAt, criteria = ['minAlignmentPct'], extra = {}) => ({ ...pass(startedAt), outcome: 'gate-failed', gate: { thresholds: {}, breaches: criteria.map(c => ({ criterion: c, detail: `${c} breached` })) }, ...extra });
const lost = (startedAt) => ({ journey: 'j', startedAt, tookMs: 2, outcome: 'vantage-lost', error: 'connect ECONNREFUSED', gate: { thresholds: {}, breaches: [] } });
const worse = (startedAt, dir = 'worse', extra = {}) => pass(startedAt, {
  transition: { since: 't0', changed: [{ rootKey: 'slo::x', title: 'x', from: { verdict: 'intact', ladderVerdict: 'healthy' }, to: { verdict: 'intact', ladderVerdict: 'unobserved' }, direction: dir, nodes: { newlyDegraded: ['rule'], recovered: [] }, note: null }], appeared: [], disappeared: [], any: true, skipped: [], reason: null },
  causes: { causes: [], vantage: { changed: false, from: 'partial', to: 'partial', detail: null }, note: 'candidate causes ranked by evidence — not a root-cause verdict' },
  ...extra,
});
const withCause = (startedAt, causes, vantageChanged = false) => worse(startedAt, 'worse', {
  causes: { causes: causes.map((c, i) => ({ rank: i + 1, kind: c.kind, score: 3, evidence: c.evidence, chains: ['x'], nodes: [] })), vantage: { changed: vantageChanged, from: 'partial', to: vantageChanged ? 'restricted' : 'partial', detail: vantageChanged ? 'vantage partial → restricted' : null }, note: 'candidate causes ranked by evidence — not a root-cause verdict' },
});

// --- always ---
{
  const d = notifyDecision({ policy: 'always', record: pass('t1'), previousRun: null });
  assert(d.send === true && d.reason === 'policy always' && d.triggers.join() === 'always', 'always sends even the first run', d);
  assert(notifyDecision({ policy: 'always', record: lost('t1'), previousRun: lost('t0') }).send === true, 'always sends a repeated vantage-lost too');
}

// --- breach ---
{
  const gf = notifyDecision({ policy: 'breach', record: failed('t1', ['minAlignmentPct', 'stack.scrape_targets_down']), previousRun: null });
  assert(gf.send === true && gf.triggers.join() === 'gate-failed:minAlignmentPct,gate-failed:stack.scrape_targets_down' && gf.reason === 'gate failed: minAlignmentPct, stack.scrape_targets_down', 'breach sends a gate-failed run with one trigger per criterion', gf);
  const vl = notifyDecision({ policy: 'breach', record: lost('t1'), previousRun: null });
  assert(vl.send === true && vl.triggers.join() === 'vantage-lost' && vl.reason === 'vantage lost', 'breach sends a vantage-lost run', vl);
  const cleared = notifyDecision({ policy: 'breach', record: pass('t2'), previousRun: failed('t1') });
  assert(cleared.send === true && cleared.triggers.join() === 'breach-cleared' && cleared.reason === 'breach cleared: gate-failed → pass', 'breach sends once when the breach clears', cleared);
  assert(notifyDecision({ policy: 'breach', record: pass('t2'), previousRun: lost('t1') }).reason === 'breach cleared: vantage-lost → pass', 'a pass after a vantage loss is a cleared breach too');
  const quiet = notifyDecision({ policy: 'breach', record: pass('t2'), previousRun: pass('t1') });
  assert(quiet.send === false && quiet.reason === 'outcome pass, no breach to clear' && quiet.triggers.length === 0, 'breach skips a pass after a pass', quiet);
  assert(notifyDecision({ policy: 'breach', record: pass('t1'), previousRun: null }).send === false, 'breach skips a passing first run');
  assert(notifyDecision({ policy: 'breach', record: failed('t2'), previousRun: failed('t1') }).send === true, 'breach re-sends a still-failing gate (that is what breach means)');
  assert(notifyDecision({ policy: 'breach', record: { outcome: 'gate-failed', gate: { breaches: [] } }, previousRun: null }).triggers.join() === 'gate-failed', 'a gate-failed record without breach rows still triggers gate-failed');
}

// --- transitions (default) ---
{
  const first = notifyDecision({ record: pass('t1'), previousRun: null });
  assert(first.send === false && first.reason === 'first run: no previous run to compare against', 'transitions (default policy) skips the first run — a baseline, not a transition', first);
  assert(notifyDecision({ policy: 'nonsense', record: pass('t1'), previousRun: null }).reason === first.reason, 'an unknown policy falls back to transitions');
  const same = notifyDecision({ record: pass('t2'), previousRun: pass('t1') });
  assert(same.send === false && same.reason === 'no transition since t1' && same.triggers.length === 0, 'an identical pass after a pass is skipped, naming the previous run', same);
  const flipped = notifyDecision({ record: failed('t2'), previousRun: pass('t1') });
  assert(flipped.send === true && flipped.triggers.join() === 'outcome changed pass → gate-failed' && flipped.reason === 'outcome changed pass → gate-failed', 'pass → gate-failed is an outcome transition', flipped);
  assert(notifyDecision({ record: pass('t2'), previousRun: failed('t1') }).triggers.join() === 'outcome changed gate-failed → pass', 'gate-failed → pass is an outcome transition');
  assert(notifyDecision({ record: lost('t2'), previousRun: pass('t1') }).triggers.join() === 'outcome changed pass → vantage-lost', 'pass → vantage-lost is an outcome transition');
  const still = notifyDecision({ record: lost('t3'), previousRun: lost('t2') });
  assert(still.send === false && still.reason === 'still vantage-lost since t2', 'a vantage-lost run after a vantage-lost run is skipped (no re-page every 15 min)', still);
  const w = notifyDecision({ record: worse('t2'), previousRun: pass('t1') });
  assert(w.send === true && w.triggers.join() === 'chain got worse', 'a direction: worse transition sends', w);
  assert(notifyDecision({ record: worse('t2', 'better'), previousRun: pass('t1') }).send === false && notifyDecision({ record: worse('t2', 'changed'), previousRun: pass('t1') }).send === false,
         'better / changed alone do not send');
  const c1 = withCause('t2', [{ kind: 'observogram-deploy', evidence: 'deploy dep_in by carlos' }]);
  const nc = notifyDecision({ record: c1, previousRun: pass('t1') });
  assert(nc.send === true && nc.triggers.join() === 'chain got worse,new candidate cause' && nc.reason === 'chain got worse · new candidate cause', 'a new candidate cause is a trigger beside the worse chain', nc);
  const c2 = withCause('t3', [{ kind: 'observogram-deploy', evidence: 'deploy dep_in by carlos' }]);
  c2.transition = { ...c2.transition, changed: [] };   // nothing got worse THIS run, same cause still ranked
  const sameCause = notifyDecision({ record: c2, previousRun: c1 });
  assert(sameCause.send === false && sameCause.reason === 'no transition since t2', 'the same cause (kind + evidence) repeated is old news — skipped', sameCause);
  const c3 = withCause('t3', [{ kind: 'observogram-deploy', evidence: 'deploy dep_in by carlos' }, { kind: 'version-change', evidence: 'prometheus 2.53.0 → 2.54.0' }]);
  c3.transition = { ...c3.transition, changed: [] };
  assert(notifyDecision({ record: c3, previousRun: c1 }).triggers.join() === 'new candidate cause', 'a second, new cause beside a known one sends');
  assert(newCandidateCauses(c3, c1).length === 1 && newCandidateCauses(c3, c1)[0].kind === 'version-change' && newCandidateCauses(c1, null).length === 1, 'newCandidateCauses compares by kind + evidence');
  // The key is the JSON pair, not a concatenation: the same characters split
  // differently between kind and evidence are two different causes.
  const split1 = withCause('t4', [{ kind: 'deploy', evidence: 'x|dep_in' }]);
  const split2 = withCause('t5', [{ kind: 'deploy|x', evidence: 'dep_in' }]);
  assert(newCandidateCauses(split2, split1).length === 1 && newCandidateCauses(split1, split1).length === 0, 'kind/evidence boundaries matter: a shifted split is a new cause, the same pair is not');
  const v = notifyDecision({ record: withCause('t2', [], true), previousRun: pass('t1') });
  assert(v.triggers.join() === 'chain got worse,vantage changed', 'a vantage change is a trigger of its own (never a cause)', v);
  const vOnly = pass('t2', { causes: { causes: [], vantage: { changed: true, from: 'full', to: 'partial', detail: 'probe family recording_rules newly failed' }, note: 'n' } });
  assert(notifyDecision({ record: vOnly, previousRun: pass('t1') }).triggers.join() === 'vantage changed', 'a vantage-only change sends');
  const all = notifyDecision({ record: withCause('t2', [{ kind: 'k', evidence: 'e' }], true), previousRun: lost('t1') });
  assert(all.triggers.join() === 'outcome changed vantage-lost → pass,chain got worse,new candidate cause,vantage changed', 'triggers are listed in a fixed order', all);
  assert(chainGotWorse(worse('t')) === true && chainGotWorse(worse('t', 'better')) === false && chainGotWorse(pass('t')) === false && chainGotWorse(lost('t')) === false && chainGotWorse(null) === false, 'chainGotWorse reads transition.changed direction worse only');
}

// --- redaction + payload ---
{
  assert(redactUrlCredentials('mcp:https://user:pw@host/mcp') === 'mcp:https://***@host/mcp' && redactUrlCredentials('https://host/x') === 'https://host/x' && redactUrlCredentials(null) === '', 'redactUrlCredentials masks //user:pass@ like server/mcp-url.mjs');
  assert(runIdOf('2026-09-20T10:15:30.123Z') === '2026-09-20T10-15-30-123Z', 'runIdOf is the record stem');
  const record = withCause('2026-09-20T10:15:30.123Z', [{ kind: 'observogram-deploy', evidence: 'deploy dep_in by carlos' }], true);
  Object.assign(record, {
    packA: { source: 'C:/repo/pack.yaml', name: 'payment-service', version: '1.5.0' },
    packB: { source: 'mcp:https://user:pw@host/mcp', name: 'production-live', version: 'live', refreshedAt: 'x' },
    grade: { score: 91, pass: true, threshold: 85, schema: 2, letter: 'A', letterLabel: 'Assured', driftConstruct: 'requirement-chain' },
    drift: { alignmentPct: 88, aligned: 10, drifted: 1, declaredNotLive: 0, liveNotDeclared: 2, outOfScope: 0, scaffold: 0 },
    freshness: { liveAgeHours: 0.2, refreshedAt: 'x' },
    vantage: 'partial', probes: { attempted: ['a', 'b'], succeeded: ['a'], empty: [], failed: ['b'], unsupported: [] },
    chains: { declaredTotal: 3, intact: 2, partial: 1, broken: 0, undeclared: 0, ladder: { healthy: 2, degraded: 1, broken: 0, unobserved: 0 }, degradedNodes: 1, undeclaredNodes: 0, topExposure: { label: 'rule', kind: 'recording_rule', slos: 1 } },
    stackEvidence: { status: 'sampled', reason: null, rows: [{ id: 'scrape_targets_down', family: 'scrape', product: 'generic', value: 2, unit: 'count', direction: 'lower', outcome: 'data', hint: 'nonzero', at: 'x', referenceSli: null }] },
    livePack: { kept: true, path: 'live/2026-09-20T10-15-30-123Z.json', bytes: 10, reason: 'chains changed' },
    historyError: 'prune live/x.json: EPERM C:/secret/path',
  });
  const decision = notifyDecision({ record, previousRun: pass('t1') });
  const links = { runs: 'https://studio/api/journeys/j/runs?limit=1', journey: 'https://studio/#journeys' };
  const payload = buildNotifyPayload({ record, previousRun: pass('t1'), decision, links, text: 'j: pass · chains 2/3 intact' });
  assert(Object.keys(payload).join() === 'kind,version,journey,runId,startedAt,tookMs,outcome,reading,previousOutcome,reason,triggers,error,gate,grade,drift,freshness,vantage,probes,transition,causes,chains,stack,livePack,packs,links,text',
         'the payload carries the documented keys in order', Object.keys(payload));
  assert(payload.kind === 'observogram.journey' && payload.version === 1 && payload.journey === 'j' && payload.runId === '2026-09-20T10-15-30-123Z' && payload.outcome === 'pass' && payload.reading === 'pass' && payload.previousOutcome === 'pass', 'identity fields come from the record and the previous run; the reading beside the outcome');
  assert(payload.reason === decision.reason && payload.triggers.join() === decision.triggers.join() && payload.triggers !== decision.triggers, 'reason and triggers come from the decision (copied)');
  assert(payload.transition === record.transition && payload.causes === record.causes && payload.chains === record.chains && payload.livePack === record.livePack, 'transition, causes, chains and livePack are the record\'s own objects — copied, never recomputed');
  assert(payload.packs.b.source === 'mcp:https://***@host/mcp' && payload.packs.a.source === 'C:/repo/pack.yaml' && payload.packs.b.name === 'production-live', 'pack B userinfo arrives redacted');
  assert(JSON.stringify(payload.grade) === JSON.stringify({ score: 91, pass: true, letter: 'A' }) && JSON.stringify(payload.drift) === JSON.stringify({ alignmentPct: 88, compared: null, drifted: 1, declaredNotLive: 0, liveNotDeclared: 2 }), 'grade and drift are trimmed to the summary fields (compared: null for a record written before it was kept)');
  assert(payload.freshness.liveAgeHours === 0.2 && payload.vantage === 'partial' && payload.probes.failed.join() === 'b', 'freshness, vantage and failed probes ride along');
  assert(JSON.stringify(payload.stack) === JSON.stringify([{ id: 'scrape_targets_down', family: 'scrape', outcome: 'data', value: 2, unit: 'count', hint: 'nonzero' }]), 'stack rows are trimmed to id/family/outcome/value/unit/hint');
  assert(payload.links === links && payload.text === 'j: pass · chains 2/3 intact' && payload.error === null, 'links and text are passed through; error is null on a verdict');
  const json = JSON.stringify(payload);
  assert(!/historyError|C:\/secret|user:pw|urlEnv|authEnv|timeoutMs/.test(json), 'no historyError path, no raw userinfo and no definition key reaches the wire', json.length);
  assert(JSON.parse(json).transition.changed[0].direction === 'worse', 'the payload is JSON-serialisable');
  const lostPayload = buildNotifyPayload({ record: { ...lost('t9'), error: 'fetch https://u:p@h/mcp failed' }, previousRun: null, decision: notifyDecision({ policy: 'breach', record: lost('t9') }) });
  assert(lostPayload.error === 'fetch https://***@h/mcp failed' && lostPayload.grade === null && lostPayload.drift === null && lostPayload.transition === null && lostPayload.stack.length === 0 && lostPayload.previousOutcome === null,
         'a vantage-lost payload carries the redacted error and null for what was never verified', lostPayload);
  assert(buildNotifyPayload({}).journey === null && buildNotifyPayload({}).links && typeof buildNotifyPayload({}).links === 'object', 'buildNotifyPayload tolerates an empty call');

  // --- grade.off: the criteria the score left out ride with it, only when it left some out ---
  // A run graded on fewer than seven criteria (its service's switches, or its
  // definition's gradeOff) records them as grade.off; the payload's grade then
  // carries `off` after score, pass and letter. A record without it — every
  // record before the switches existed — gives the payload it always gave.
  {
    const build = (grade) => buildNotifyPayload({ record: { ...record, grade }, previousRun: pass('t1'), decision, links, text: 'j: pass · chains 2/3 intact' });
    const whole = JSON.stringify(payload);
    assert(JSON.stringify(build(record.grade)) === whole && !('off' in payload.grade), 'a record whose grade has no off: the payload is the one above, and its grade has no off key');
    const off = ['chaos-validated', 'fresh'];
    const withOff = build({ ...record.grade, off });
    assert(JSON.stringify(withOff.grade) === JSON.stringify({ score: 91, pass: true, letter: 'A', off: ['chaos-validated', 'fresh'] }), 'grade.off rides in the payload\'s grade, after score, pass and letter', withOff.grade);
    assert(withOff.grade.off !== off && off.join() === 'chaos-validated,fresh', 'the list is copied, and the record\'s own is left as it was');
    assert(JSON.stringify(Object.keys(withOff)) === JSON.stringify(Object.keys(payload)) && JSON.stringify({ ...withOff, grade: { score: 91, pass: true, letter: 'A' } }) === whole,
           'nothing else of the payload moves: the same keys in the same order, every other value the same');
    for (const none of [[], null, undefined, 'chaos-validated', 7, { 0: 'fresh', length: 1 }]) {
      const p = build({ ...record.grade, off: none });
      assert(JSON.stringify(p) === whole && !('off' in p.grade), 'grade.off empty or not a list: no off key, the payload it always was', { none, grade: p.grade });
    }
    assert(build({ ...record.grade, off: ['fresh', 7, null, { key: 'calibrated' }, 'a', 'b', 'c', 'd', 'e', 'f', 'g'] }).grade.off.join() === 'fresh,a,b,c,d,e,f', 'only strings are copied, seven at most');
    assert(buildNotifyPayload({ record: { ...lost('t9'), grade: undefined }, decision: notifyDecision({ policy: 'breach', record: lost('t9') }) }).grade === null, 'a record that graded nothing still has grade null');
    assert(JSON.parse(JSON.stringify(withOff)).grade.off.join() === 'chaos-validated,fresh', 'the payload with off is JSON-serialisable');
    // The text form prints no grade line, so it is the same with and without off.
    assert(renderNotifyText(withOff) === renderNotifyText(payload), 'the text rendering is unchanged by grade.off');
  }

  // --- text rendering ---
  const text = renderNotifyText(payload);
  const lines = text.split('\n');
  assert(lines[0] === 'j: pass · chains 2/3 intact' && lines[1] === '' && lines[2] === `reason: ${decision.reason}`, 'text: the one-liner, a blank line, then the reason', lines.slice(0, 3));
  assert(/transitions since t0:\n- x: intact\/healthy → intact\/unobserved \(worse\)/.test(text), 'text lists the transition lines');
  assert(/candidate causes — ranked by evidence, not a root-cause verdict:\n1\. \[observogram-deploy\] deploy dep_in by carlos/.test(text), 'text lists the causes under the not-a-verdict heading');
  assert(/vantage changed: vantage partial → restricted/.test(text) && /runs: https:\/\/studio\/api\/journeys\/j\/runs\?limit=1/.test(text), 'text carries the vantage line and the links');
  const many = { ...payload, causes: { ...payload.causes, causes: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, kind: 'k', evidence: `e${i}` })) } };
  assert(/3\. \[k\] e2\n\(\+2 more\)/.test(renderNotifyText(many)) && !/e3/.test(renderNotifyText(many)), 'text caps the causes at 3 and says how many more');
  const gfText = renderNotifyText(buildNotifyPayload({ record: failed('t1', ['minAlignmentPct']), decision: notifyDecision({ policy: 'breach', record: failed('t1') }), text: 'j: gate-failed' }));
  assert(/gate breaches:\n- minAlignmentPct — minAlignmentPct breached/.test(gfText), 'text lists gate breaches');
  assert(renderNotifyText({}).startsWith('?: ?\n\nreason: -'), 'renderNotifyText tolerates an empty payload');
}

// --- no figure without its basis: nothing compared, a stopped Run, a run not comparable with the one before ---
{
  const stopped = (startedAt) => ({ journey: 'j', startedAt, tookMs: 3, outcome: 'scan-partial', error: '49 of 220 files not read: a.json — it could not be downloaded (HTTP 403)', packA: { source: 'a', scan: { partial: true, notRead: 49, candidates: 220 } }, gate: { thresholds: {}, breaches: [] } });
  // The payload copies drift.compared; no figure over nothing compared, whatever alignmentPct a record carries.
  const nothing = failed('t1', ['minAlignmentPct'], { drift: { alignmentPct: null, compared: 0, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 } });
  const np = buildNotifyPayload({ record: nothing, decision: notifyDecision({ policy: 'always', record: nothing }) });
  assert(JSON.stringify(np.drift) === JSON.stringify({ alignmentPct: null, compared: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 }), 'the payload over nothing compared: compared 0, no figure', np.drift);
  const claims = buildNotifyPayload({ record: { ...nothing, drift: { ...nothing.drift, alignmentPct: 100 } }, decision: { reason: 'r', triggers: [] } });
  assert(claims.drift.alignmentPct === null, 'a record that claims 100 over compared 0 is posted without a figure');
  assert(/\nmatch: nothing compared\n/.test(renderNotifyText(np)), 'the text says nothing compared', renderNotifyText(np));
  assert(!/match:/.test(renderNotifyText(buildNotifyPayload({ record: pass('t1', { drift: { alignmentPct: 92, compared: 50, aligned: 46, drifted: 2, declaredNotLive: 2, liveNotDeclared: 0 } }), decision: { reason: 'r', triggers: [] } }))), 'a run that compared something: no match line');
  // breach posts a stopped Run, as a lost vantage is; transitions skips a repeat.
  assert(JSON.stringify(notifyDecision({ policy: 'breach', record: stopped('t2'), previousRun: pass('t1') })) === JSON.stringify({ send: true, reason: 'partial scan', triggers: ['scan-partial'] }), 'breach: a stopped Run is posted as a partial scan — never "gate failed: scan-partial"');
  assert(notifyDecision({ policy: 'transitions', record: stopped('t2'), previousRun: pass('t1') }).send === true, 'transitions: a Run that stops after a check is news');
  assert(JSON.stringify(notifyDecision({ policy: 'transitions', record: stopped('t3'), previousRun: stopped('t2') })) === JSON.stringify({ send: false, reason: 'still scan-partial since t2', triggers: [] }), 'transitions: a stopped Run after a stopped Run is skipped');
  // A stopped Run before this run observed nothing: no outcome changed since it, no vantage changed from it, no breach cleared.
  const after = failed('t3', ['minAlignmentPct'], { causes: { causes: [], vantage: { changed: true, from: null, to: { vantage: 'partial', failed: ['dashboards'] }, detail: 'vantage none → partial' } } });
  assert(JSON.stringify(notifyDecision({ policy: 'transitions', record: after, previousRun: stopped('t2') })) === JSON.stringify({ send: false, reason: 'no transition since t2', triggers: [] }), 'transitions: no page after a stopped Run for what the check before it already said');
  assert(notifyDecision({ policy: 'breach', record: pass('t3'), previousRun: stopped('t2') }).send === false, 'breach: no "breach cleared" from a stopped Run');
  // Not comparable with the run before: said so, never "chain got worse" or "outcome changed" across the pair.
  const worse = failed('t2', ['minAlignmentPct'], { comparable: { withPrevious: false, reason: 'this scan could not read 49 of 220 files' }, transition: { since: 't1', changed: [{ direction: 'worse' }], any: true } });
  const d = notifyDecision({ policy: 'transitions', record: worse, previousRun: pass('t1') });
  assert(JSON.stringify(d.triggers) === JSON.stringify(['not comparable with the previous run']) && d.send === true, 'transitions: not comparable is the trigger, nothing else across the pair', d);
  // A breach written { key } is read by it.
  assert(notifyDecision({ policy: 'breach', record: { ...failed('t1'), gate: { breaches: [{ key: 'vantage', detail: 'x' }] } } }).reason === 'gate failed: vantage', 'a breach { key } names its key');
  assert(/- vantage — x/.test(renderNotifyText({ gate: { breaches: [{ key: 'vantage', detail: 'x' }] } })), 'the text names a breach { key }');
}

// --- a run that compared nothing is no pass: a gate whose own keys held (freshness only, or none) still passed it ---
{
  const NOTHING = { alignmentPct: null, compared: 0, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 };
  const passNothing = (startedAt, gate = { maxLiveAgeHours: 48 }) => pass(startedAt, { gate: { thresholds: gate, breaches: [] }, drift: NOTHING });
  const compared = (startedAt) => pass(startedAt, { drift: { alignmentPct: 92, compared: 50, aligned: 46, drifted: 2, declaredNotLive: 2, liveNotDeclared: 0 } });
  // breach: posted as nothing compared, a gate it breached named beside it.
  assert(JSON.stringify(notifyDecision({ policy: 'breach', record: passNothing('t2'), previousRun: compared('t1') })) === JSON.stringify({ send: true, reason: 'nothing compared', triggers: ['nothing-compared'] }), 'breach: a pass over nothing compared is posted — never "outcome pass, no breach to clear"');
  assert(JSON.stringify(notifyDecision({ policy: 'breach', record: passNothing('t2', {}) })) === JSON.stringify({ send: true, reason: 'nothing compared', triggers: ['nothing-compared'] }), 'breach: with no gate configured too — nothing was compared, so nothing is confirmed');
  const nothingFailed = failed('t2', ['minAlignmentPct'], { drift: NOTHING });
  assert(JSON.stringify(notifyDecision({ policy: 'breach', record: nothingFailed })) === JSON.stringify({ send: true, reason: 'nothing compared · gate failed: minAlignmentPct', triggers: ['nothing-compared', 'gate-failed:minAlignmentPct'] }), 'breach: a failed gate over nothing says both');
  assert(notifyDecision({ policy: 'breach', record: compared('t3'), previousRun: passNothing('t2') }).reason === 'breach cleared: nothing-compared → pass', 'breach: a comparison that passes after nothing compared clears it');
  // An older record over an empty union (its four counts, alignment 100) reads the same.
  const { compared: _c, ...olderNothing } = NOTHING;
  assert(notifyDecision({ policy: 'breach', record: pass('t2', { drift: { ...olderNothing, alignmentPct: 100 } }) }).reason === 'nothing compared', 'an older record over an empty union is no pass either');
  // transitions: pass → nothing compared is a transition; a repeat is skipped, as a repeated outage is.
  assert(notifyDecision({ record: passNothing('t2'), previousRun: compared('t1') }).triggers.join() === 'outcome changed pass → nothing-compared', 'transitions: a check that stops comparing anything is news');
  assert(JSON.stringify(notifyDecision({ record: passNothing('t3'), previousRun: passNothing('t2') })) === JSON.stringify({ send: false, reason: 'still nothing-compared since t2', triggers: [] }), 'transitions: nothing compared after nothing compared is skipped');
  assert(notifyDecision({ record: compared('t3'), previousRun: passNothing('t2') }).triggers.join() === 'outcome changed nothing-compared → pass', 'transitions: comparing again is news');
  // The payload: the record's outcome as it is, beside `reading`; the one-line text never leads with pass.
  const p = buildNotifyPayload({ record: passNothing('t2'), decision: notifyDecision({ policy: 'breach', record: passNothing('t2') }), text: 'j: pass · nothing compared · chains 0/6 intact' });
  assert(p.outcome === 'pass' && p.reading === 'nothing-compared' && p.text === 'j: nothing compared · chains 0/6 intact', 'the payload reads nothing compared, never pass', { outcome: p.outcome, reading: p.reading, text: p.text });
  assert(renderNotifyText(p).startsWith('j: nothing compared · chains 0/6 intact\n\nreason: nothing compared\nmatch: nothing compared\n'), 'the text form leads with it', renderNotifyText(p).split('\n').slice(0, 4));
  assert(renderNotifyText({ ...p, text: '' }).startsWith('j: nothing compared\n'), 'a payload without a summary leads with the reading too');
  assert(buildNotifyPayload({ record: nothingFailed, decision: { reason: 'r', triggers: [] }, text: 'j: gate-failed · nothing compared · chains 0/6 intact' }).text === 'j: gate-failed · nothing compared · chains 0/6 intact', 'a failed gate over nothing keeps its summary');
  assert(buildNotifyPayload({ record: compared('t1'), decision: { reason: 'r', triggers: [] }, text: 'j: pass · chains 2/3 intact' }).text === 'j: pass · chains 2/3 intact' && buildNotifyPayload({ record: compared('t1'), decision: { reason: 'r', triggers: [] } }).reading === 'pass', 'a pass over a comparison is a pass');
}

// --- the reading rule is run-basis's, restated (this module stays zero-import) ---
{
  const rb = await import('./lib/run-basis.mjs');
  const { readingOutcome } = await import('./lib/journey-notify.mjs');
  const probes = (o) => ({ attempted: [], succeeded: [], empty: [], failed: [], unsupported: [], ...o });
  const records = [
    null, {}, { outcome: 'pass' }, { outcome: 'scan-partial' }, { outcome: 'error', error: 'x' }, { outcome: 'vantage-lost' },
    { outcome: 'pass', vantage: 'lost' }, { outcome: 'pass', probes: probes({ attempted: ['alert_rules'], failed: ['alert_rules'] }), drift: { alignmentPct: 100, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 } },
    { outcome: 'pass', vantage: 'full', probes: probes({ attempted: ['alert_rules'] }) },
    { outcome: 'pass', drift: { alignmentPct: null, compared: 0 } }, { outcome: 'gate-failed', drift: { alignmentPct: 100, aligned: 0, drifted: 0, declaredNotLive: 0, liveNotDeclared: 0 } },
    { outcome: 'pass', drift: { alignmentPct: 90 } }, { outcome: 'pass', drift: { alignmentPct: 0, compared: 1, liveNotDeclared: 1 } }, { outcome: 'gate-failed', drift: { compared: 3, aligned: 3 } },
    { outcome: 'pass', compared: 0 }, { outcome: 'pass', drift: { aligned: -2, drifted: 0 } }, { outcome: 'pass', drift: [] },
  ];
  for (const r of records) assert(readingOutcome(r) === rb.readingOutcome(r), 'journey-notify readingOutcome gives run-basis\'s answer', { r, notify: readingOutcome(r), rb: rb.readingOutcome(r) });
}

report('journey-notify', 'all journey-notify assertions pass.');
