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
  assert(Object.keys(payload).join() === 'kind,version,journey,runId,startedAt,tookMs,outcome,previousOutcome,reason,triggers,error,gate,grade,drift,freshness,vantage,probes,transition,causes,chains,stack,livePack,packs,links,text',
         'the payload carries the documented keys in order', Object.keys(payload));
  assert(payload.kind === 'observogram.journey' && payload.version === 1 && payload.journey === 'j' && payload.runId === '2026-09-20T10-15-30-123Z' && payload.outcome === 'pass' && payload.previousOutcome === 'pass', 'identity fields come from the record and the previous run');
  assert(payload.reason === decision.reason && payload.triggers.join() === decision.triggers.join() && payload.triggers !== decision.triggers, 'reason and triggers come from the decision (copied)');
  assert(payload.transition === record.transition && payload.causes === record.causes && payload.chains === record.chains && payload.livePack === record.livePack, 'transition, causes, chains and livePack are the record\'s own objects — copied, never recomputed');
  assert(payload.packs.b.source === 'mcp:https://***@host/mcp' && payload.packs.a.source === 'C:/repo/pack.yaml' && payload.packs.b.name === 'production-live', 'pack B userinfo arrives redacted');
  assert(JSON.stringify(payload.grade) === JSON.stringify({ score: 91, pass: true, letter: 'A' }) && JSON.stringify(payload.drift) === JSON.stringify({ alignmentPct: 88, drifted: 1, declaredNotLive: 0, liveNotDeclared: 2 }), 'grade and drift are trimmed to the summary fields');
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

report('journey-notify', 'all journey-notify assertions pass.');
