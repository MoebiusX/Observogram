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
// Worker, one per submit, rule by rule, and gives it POLICY_EVAL_DEADLINE_MS
// from the moment the worker is ready. Past the deadline the worker is
// terminated — never reused — and the check FAILS CLOSED: every rule that did
// not finish counts as matched on each field it checks (`timedOut: true`),
// so its warning applies and its acknowledgement is required, exactly as if
// the pattern had matched. One stderr line names the rules
// (`[mcp-settings] policy rules[2] did not finish within 100 ms — counted as
// matched`) and the deadline; no value, field value or pattern is ever
// logged, and the 409 the route answers quotes the rule's warn and ack only.
//
// The studio evaluates policyFindings in the page directly: a slow pattern
// there freezes only the admin's own tab, never the server.

import { MessageChannel, Worker, isMainThread, parentPort, receiveMessageOnPort, workerData } from 'node:worker_threads';
import { policyFindings } from '../tools/lib/mcp-server-settings.mjs';

/** How long the policy's patterns may run for one submit, once the worker is ready. */
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
 * them, computed in a worker under a deadline. → Promise<{ findings,
 * timedOut }>: `timedOut` the indexes of the rules that did not finish, each
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
  let finished = false;
  let failure = null;
  const take = (m) => {
    if (m.rule !== undefined) done.set(m.rule, m.findings);
    if (m.done) finished = true;
  };
  await new Promise((resolve) => {
    let timer = setTimeout(resolve, WORKER_START_LIMIT_MS);
    port1.on('message', (m) => {
      if (m.ready) { clearTimeout(timer); timer = setTimeout(resolve, deadlineMs); return; }
      take(m);
      if (finished) { clearTimeout(timer); resolve(); }
    });
    worker.on('error', (e) => { failure = errorClass(e); clearTimeout(timer); resolve(); });
    worker.on('exit', () => { clearTimeout(timer); resolve(); });
  });
  // What the worker posted before the deadline but this thread has not yet
  // read counts as finished.
  for (let m; (m = receiveMessageOnPort(port1));) take(m.message);
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
  port.postMessage({ ready: true });
  for (const r of rules) {
    const rule = { ...r, re: new RegExp(r.source, r.flags) };
    const findings = policyFindings({ version: 1, rules: [rule], generic: null }, descriptor, values);
    port.postMessage({ rule: r.index, findings });
  }
  port.postMessage({ done: true });
  port.close();
  parentPort?.close();
}
