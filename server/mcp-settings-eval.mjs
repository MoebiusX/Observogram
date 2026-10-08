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
// The worker gets the flags the server was started with, but --input-type.
// A V8 or process-wide flag (`node --max-old-space-size=512
// server/index.mjs`) is one a worker refuses at construction
// (ERR_WORKER_INVALID_EXEC_ARGV): the worker is constructed once more with
// none. A worker that cannot be constructed, or fails, FAILS CLOSED the same
// way — every rule it did not finish counts as matched, and the stderr line
// names the error's class (`[mcp-settings] the policy worker failed (Error)
// — rules[0] counted as matched`), never its message. evaluatePolicy never
// rejects.
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
const newWorker = (url, options) => new Worker(url, options);
// An error's class name, or 'Error' — never its message.
function errorClass(e) {
  const name = e?.constructor?.name ?? e?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(name) ? name : 'Error';
}

// What a rule that did not finish counts as: a match on every field it checks.
function timedOutFindings(rule, descriptor, deadlineMs) {
  const n = rule.index + 1;
  const all = Array.isArray(descriptor?.fields) ? descriptor.fields : [];
  const fields = rule.field !== null ? [rule.field] : all.filter((f) => f.type === rule.type).map((f) => f.name);
  return (fields.length ? fields : [null]).map((field) => ({
    rule: rule.index, field, warn: rule.warn, ack: rule.ack, unevaluated: false, timedOut: true,
    note: `Policy rule ${n} did not finish within ${deadlineMs} ms, so it counts as matched`,
  }));
}

// What the check answers: the findings of the rules the worker finished,
// and every other rule's timedOutFindings, with one stderr line naming them —
// and the worker's error class when it failed or could not be constructed.
function answer(policy, descriptor, done, failure, deadlineMs, log) {
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

// The worker, from this file, on a channel of its own per attempt (a port is
// never left open by a constructor that threw). `execArgv`: the server's
// flags but --input-type, which a server started with
// `node --input-type=module -e …` (the suites' children) would hand the
// worker, which refuses it with a file. A flag the constructor refuses is
// dropped with every other: the second attempt passes none — an empty list,
// never the default, which would inherit --input-type again.
function startWorker(createWorker, data, execArgv) {
  const attempt = (argv) => {
    const { port1, port2 } = new MessageChannel();
    try {
      const worker = createWorker(new URL(import.meta.url), { workerData: { ...data, port: port2 }, transferList: [port2], execArgv: argv });
      return { worker, port: port1 };
    } catch (e) {
      port1.close();
      port2.close();
      throw e;
    }
  };
  try {
    return attempt(execArgv.filter((a) => !a.startsWith('--input-type')));
  } catch (e) {
    if (e?.code !== 'ERR_WORKER_INVALID_EXEC_ARGV') throw e;
    return attempt([]);
  }
}

// One run of the worker over the rules: the findings of each rule it
// finished (Map index → findings), and its error class if it failed. Throws
// when the worker cannot be constructed.
async function runWorker(rules, descriptor, values, { deadlineMs, execArgv, createWorker }) {
  const data = {
    [MARK]: true,
    rules: rules.map((r) => ({ index: r.index, field: r.field, type: r.type, source: r.re.source, flags: r.re.flags, warn: r.warn, ack: r.ack })),
    descriptor: { fields: descriptor.fields.map((f) => ({ ...f })) },
    values: Object.entries(values ?? {}),
  };
  const { worker, port } = startWorker(createWorker, data, execArgv);
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
  const drain = () => { for (let m; (m = receiveMessageOnPort(port));) take(m.message); };
  try {
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
      port.on('message', (m) => {
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
  } finally {
    port.close();
    worker.terminate().catch(() => {});
  }
  return { done, failure };
}

/**
 * The policy's findings for a form and its values, as policyFindings returns
 * them, computed in a worker under a deadline per rule. → Promise<{
 * findings, timedOut }>: `timedOut` the indexes of the rules that did not
 * finish (the one past its deadline and the ones after it, never run; when
 * the worker failed, every rule it had not finished — a rule it finished
 * keeps its findings; every rule when it could not be constructed), each of
 * which is in `findings` as a match (`timedOut: true`). `policy` is
 * compileSettingsPolicy's, or null. Never rejects. `execArgv` (the server's
 * flags) and `createWorker` (`new Worker(url, options)`) are the suites'
 * seams.
 */
export async function evaluatePolicy(policy, descriptor, values, options) {
  const { deadlineMs = POLICY_EVAL_DEADLINE_MS, log = defaultLog, execArgv = process.execArgv, createWorker = newWorker } = options ?? {};
  if (!policy || policy.rules.length === 0) return { findings: [], timedOut: [] };
  const say = (line) => {
    try { log(line); } catch { /* a log that throws costs the line, never the answer */ }
  };
  try {
    const { done, failure } = await runWorker(policy.rules, descriptor, values, { deadlineMs, execArgv, createWorker });
    return answer(policy, descriptor, done, failure, deadlineMs, say);
  } catch (e) {
    // A worker that cannot be constructed — or anything else the check
    // threw — fails closed like a worker that failed: no rule finished.
    return answer(policy, descriptor, new Map(), errorClass(e), deadlineMs, say);
  }
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
