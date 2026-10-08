// server/mcp-settings-eval.mjs — the opt-in pass-through's settings-policy
// check, off the request thread (rebadge batch 4, D3).
//
// A policy pattern is bounded by shape when the file loads
// (compileSettingsPolicy: anchored, at most 200 characters, no nested or
// quantified group, at most one unbounded quantifier), but no probe can
// prove a regex fast on every value: a pattern whose slow part is followed
// by something a probe's last character satisfies backtracks for minutes on
// a real value and passes every probe in milliseconds. So the server never
// runs a policy pattern on its own thread. evaluatePolicy() runs the pure
// policyFindings (tools/lib/mcp-server-settings.mjs) in a node:worker_threads
// Worker, one per submit, rule by rule, and gives each rule
// POLICY_EVAL_DEADLINE_MS from its own start: the worker posts each rule's
// start and this thread restarts the deadline when it reads it, so the time
// the rules before it took never counts against a rule, and a machine too
// busy to run the worker promptly costs a fast rule nothing unless that one
// rule is held past the deadline. A rule that does not finish within the
// deadline of its start ends the check: the worker is terminated — never
// reused — and the check FAILS CLOSED: that rule, and every rule after it
// (never run), counts as matched on each field it checks (`timedOut: true`),
// so its warning applies and its acknowledgement is required, exactly as if
// the pattern had matched. One stderr line names the rules
// (`[mcp-settings] policy rules[2] did not finish within 100 ms — counted as
// matched`) and the deadline; no value, field value or pattern is ever
// logged, and the 409 the route answers quotes the rule's warn and ack only.
// A check therefore takes at most WORKER_START_LIMIT_MS for the worker to
// start plus the deadline once per rule — with at most
// SETTINGS_LIMITS.policyRules (32) rules, 32 × 100 ms = 3.2 s once started.
//
// The studio evaluates policyFindings in the page directly: a slow pattern
// there freezes only the admin's own tab, never the server.

import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { policyFindings } from '../tools/lib/mcp-server-settings.mjs';

/** How long each policy rule may run for one submit, from the moment the worker starts it. */
export const POLICY_EVAL_DEADLINE_MS = 100;
// How long the worker may take to start (load the module) before the check
// fails closed — a start, not the patterns, so it is generous.
const WORKER_START_LIMIT_MS = 10_000;
const MARK = 'observogram-mcp-settings-eval';

const defaultLog = (line) => process.stderr.write(`${line}\n`);
// An error's class name, or 'Error' — never its message.
function errorClass(e) {
  const name = e?.constructor?.name ?? e?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'Error';
}

// What a rule that did not finish counts as: a match on every field it checks.
function timedOutFindings(rule, descriptor, deadlineMs) {
  const n = rule.index + 1;
  const fields = rule.field !== null ? [rule.field] : descriptor.fields.filter((f) => f.type === rule.type).map((f) => f.name);
  return (fields.length ? fields : [null]).map((field) => ({
    rule: rule.index, field, warn: rule.warn, ack: rule.ack, unevaluated: false, timedOut: true,
    note: `Policy rule ${n} did not finish within ${deadlineMs} ms, so it counts as matched`,
  }));
}

/**
 * The policy's findings for a form and its values, as policyFindings returns
 * them, computed in a worker under a deadline per rule. → Promise<{
 * findings, timedOut }>: `timedOut` the indexes of the rules that did not
 * finish (the one past its deadline and the ones after it, never run), each
 * of which is in `findings` as a match (`timedOut: true`). Never rejects.
 */
export async function evaluatePolicy(policy, descriptor, values, { deadlineMs = POLICY_EVAL_DEADLINE_MS, log = defaultLog } = {}) {
  if (!policy || policy.rules.length === 0) return { findings: [], timedOut: [] };
  const rules = policy.rules.map((r) => ({ index: r.index, field: r.field, type: r.type, source: r.re.source, flags: r.re.flags, warn: r.warn, ack: r.ack }));
  const { port1, port2 } = new MessageChannel();
  const worker = new Worker(new URL(import.meta.url), {
    workerData: { [MARK]: true, port: port2, rules, descriptor: { fields: descriptor.fields.map((f) => ({ ...f })) }, values: Object.entries(values ?? {}) },
    transferList: [port2],
    // A server started with `node --input-type=module -e …` (the suites'
    // children) would hand the worker a flag it refuses with a file.
    execArgv: process.execArgv.filter((a) => !a.startsWith('--input-type')),
  });
  const done = new Map();
  let started = null; // the index of the rule the worker last said it started
  let finished = false;
  let failure = null;
  const take = (m) => {
    if (m.rule !== undefined) done.set(m.rule, m.findings);
    if (m.start !== undefined) started = m.start;
    if (m.done) finished = true;
  };
  // What the worker posted but this thread has not yet read.
  const drain = () => { for (let m; (m = receiveMessageOnPort(port1));) take(m.message); };
  await new Promise((resolve) => {
    let timer = null;
    let ended = false;
    const end = () => { ended = true; clearTimeout(timer); resolve(); };
    const arm = (ms) => { clearTimeout(timer); if (!ended) timer = setTimeout(expire, ms); };
    // A deadline can fall due behind messages this thread was too busy to
    // read: read them first, and a rule the worker started since gets its
    // own deadline, from now.
    const expire = () => {
      const was = started;
      drain();
      if (!finished && started !== was) arm(deadlineMs);
      else end();
    };
    arm(WORKER_START_LIMIT_MS);
    port1.on('message', (m) => {
      take(m);
      if (finished) end();
      else if (m.start !== undefined) arm(deadlineMs);
    });
    worker.on('error', (e) => { failure = errorClass(e); end(); });
    worker.on('exit', end);
  });
  // What the worker posted before the check ended but this thread has not
  // yet read counts as finished.
  drain();
  port1.close();
  worker.terminate().catch(() => {});
  const findings = [];
  const timedOut = [];
  for (const r of policy.rules) {
    if (done.has(r.index)) findings.push(...done.get(r.index));
    else { timedOut.push(r.index); findings.push(...timedOutFindings(r, descriptor, deadlineMs)); }
  }
  if (timedOut.length) {
    const which = timedOut.map((i) => `rules[${i}]`).join(', ');
    log(failure ? `[mcp-settings] the policy worker failed (${failure}) — ${which} counted as matched`
      : `[mcp-settings] policy ${which} did not finish within ${deadlineMs} ms — counted as matched`);
  }
  return { findings, timedOut };
}

// ---------- the worker ----------

if (!isMainThread && workerData?.[MARK] === true) {
  const { port, rules, descriptor } = workerData;
  const values = Object.create(null);
  for (const [k, v] of workerData.values) values[k] = v;
  // Each rule's start, so its deadline counts from it. A rule's answer and
  // the next rule's start travel in one message, so the main thread never
  // sees a rule finished and the next one not yet started.
  port.postMessage({ start: rules[0].index });
  rules.forEach((r, i) => {
    const rule = { ...r, re: new RegExp(r.source, r.flags) };
    const findings = policyFindings({ version: 1, rules: [rule], generic: null }, descriptor, values);
    const next = rules[i + 1];
    port.postMessage(next ? { rule: r.index, findings, start: next.index } : { rule: r.index, findings, done: true });
  });
  port.close();
  parentPort?.close();
}
