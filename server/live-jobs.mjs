// server/live-jobs.mjs — the live MCP jobs (rebadge batch 3, C1; RULINGS
// R1): a snapshot or a draft runs as a job, not a held request. Starting
// one answers at once with an id; the caller polls the job's gate log by a
// cursor (?since=<seq>) and reads the result when it ends; a reconnect, or a
// page reload in the same org, polls the same id again.
//
// In memory, SQL-free. A restart loses running and finished jobs: a running
// fetch dies with the process and registers nothing, a poll then answers 404
// `gone`, and a pack registered before the restart stays in the catalogue.
//
// The rules (docs/DOWNSTREAM.md §15.2):
//   id         randomBytes(16) base64url — 22 characters, unguessable, no
//              credential in it
//   scope      keyed by the org and the principal (session:<userId>,
//              bearer, local): the gate log and the result are that
//              principal's in that org only; any other lookup is the
//              unknown-id 404. An admin of the org may cancel any job
//              (server/routes/live.mjs checks the rank)
//   bound      one running job per org; at most MAX_RUNNING_JOBS in the
//              deployment
//   retention  a finished job is kept JOB_TTL_MS, at most
//              MAX_FINISHED_PER_ORG per org (the oldest evicted); at a
//              terminal state the job drops its target and credential
//   watchdog   JOB_MAX_MS: past it the job is aborted and fails
//   log        append-only stage records, at most MAX_LOG_RECORDS (progress
//              records are dropped first), each message at most
//              SNAPSHOT_LIMITS.messageChars and redacted with the target
//   shutdown   abortAllLiveJobs() (the server's `close`) aborts every
//              running job; every timer is unref()'d
//
// The configured snapshot scope (snapshotScopeConfig) is read here too:
// OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES / _FOLDER_UIDS / _DATASOURCE_UID for
// the deployment, OBSERVOGRAM_ORG_<KEY>_SNAPSHOT_* for one org (read only by
// the org that owns the name, the longest-prefix rule of
// server/store/mcp-endpoints.mjs), the org's overriding the deployment's
// field by field. Read per request; inert when unset.

import { randomBytes } from 'node:crypto';
import { brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { normalizeScope, stagesFor, SNAPSHOT_LIMITS } from '../tools/lib/live-fetch.mjs';
import { redactTarget } from './mcp-target-policy.mjs';
import { envNameOwnedBy, orgEnvPrefix } from './store/mcp-endpoints.mjs';

export const JOB_TTL_MS = 15 * 60_000;
export const JOB_MAX_MS = 10 * 60_000;
export const MAX_RUNNING_JOBS = 4;
export const MAX_FINISHED_PER_ORG = 8;
export const MAX_LOG_RECORDS = 500;
export const JOB_STATES = Object.freeze(['running', 'done', 'failed', 'cancelled']);
const FINAL_STAGE_STATES = new Set(['done', 'failed', 'skipped']);

// ---------- the configured snapshot scope ----------

export const SNAPSHOT_SCOPE_VARS = Object.freeze([
  Object.freeze({ field: 'metricPrefixes', name: 'SNAPSHOT_METRIC_PREFIXES' }),
  Object.freeze({ field: 'folderUids', name: 'SNAPSHOT_FOLDER_UIDS' }),
  Object.freeze({ field: 'datasourceUid', name: 'SNAPSHOT_DATASOURCE_UID' }),
]);

// The scope an org's snapshots use when the request sends none →
// { defaults: { metricPrefixes, folderUids, datasourceUid }, from: 'org' |
// 'deployment' | null, errors: [text] }. `from` is 'org' when any field came
// from the org's own variable. A variable that does not parse names itself
// in `errors` and contributes nothing.
export function snapshotScopeConfig(db, org, env = process.env) {
  const input = {};
  const errors = [];
  let from = null;
  for (const { field, name } of SNAPSHOT_SCOPE_VARS) {
    const orgName = org ? `${orgEnvPrefix(org)}${name}` : null;
    const orgValue = orgName ? String(env[orgName] ?? '').trim() : '';
    let value = null;
    let varName = null;
    if (orgValue && envNameOwnedBy(db, orgName).includes(org)) {
      value = orgValue;
      varName = orgName;
      from = 'org';
    } else {
      const global = brandEnvFrom(env, name);
      if (global) { value = global; varName = `OBSERVOGRAM_${name}`; from ??= 'deployment'; }
    }
    if (value === null) continue;
    const one = normalizeScope({ [field]: value });
    if (one.errors.length) errors.push(...one.errors.map((e) => e.replace(/^scope\.[A-Za-z]+/, varName)));
    else input[field] = one.scope[field];
  }
  return {
    defaults: {
      metricPrefixes: input.metricPrefixes ?? [],
      folderUids: input.folderUids ?? [],
      datasourceUid: input.datasourceUid ?? null,
    },
    from,
    errors,
  };
}

// ---------- the registry ----------

const jobs = new Map();          // id → job, insertion order = start order
const lastTook = new Map();      // org → { snapshot, draft } (ms of the last finished job of each kind)

// Test seams (server/test-mcp-jobs.mjs): the clock the retention reads, and
// the pack size limit (a 16 MB pack is not built in a unit suite).
const seams = { now: () => Date.now(), packBytes: SNAPSHOT_LIMITS.packBytes };
export function setLiveJobSeams({ now, packBytes } = {}) {
  if (now !== undefined) seams.now = now ?? (() => Date.now());
  if (packBytes !== undefined) seams.packBytes = packBytes ?? SNAPSHOT_LIMITS.packBytes;
}
export const livePackBytesLimit = () => seams.packBytes;

const iso = (ms) => (ms === null ? null : new Date(ms).toISOString());
const cut = (text) => (text == null ? null : String(text).slice(0, SNAPSHOT_LIMITS.messageChars));

// Finished jobs past their TTL go; then each org keeps its newest
// MAX_FINISHED_PER_ORG finished jobs.
function prune() {
  const now = seams.now();
  const finishedByOrg = new Map();
  for (const [id, job] of jobs) {
    if (job.finishedAtMs === null) continue;
    if (now - job.finishedAtMs > JOB_TTL_MS) { jobs.delete(id); continue; }
    if (!finishedByOrg.has(job.orgId)) finishedByOrg.set(job.orgId, []);
    finishedByOrg.get(job.orgId).push(job);
  }
  for (const list of finishedByOrg.values()) {
    list.sort((a, b) => a.finishedAtMs - b.finishedAtMs);
    for (const job of list.slice(0, Math.max(0, list.length - MAX_FINISHED_PER_ORG))) jobs.delete(job.id);
  }
}

// The org's running job, or null.
export function runningJobIn(orgId) {
  for (const job of jobs.values()) if (job.orgId === orgId && job.state === 'running') return job;
  return null;
}

export function runningJobCount() {
  let n = 0;
  for (const job of jobs.values()) if (job.state === 'running') n++;
  return n;
}

// A job of this org by id, or null (expired, evicted, another org's, unknown).
export function findJob(orgId, id) {
  prune();
  const job = typeof id === 'string' ? jobs.get(id) : undefined;
  return job && job.orgId === orgId ? job : null;
}

// How long the org's last finished job of each kind took: { snapshot, draft }.
export function lastTookIn(orgId) {
  return { snapshot: null, draft: null, ...(lastTook.get(orgId) ?? {}) };
}

// JobView: what any reader of the job sees.
export function jobView(job) {
  const end = job.finishedAtMs ?? seams.now();
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    cancelRequested: job.cancelRequested,
    startedAt: iso(job.startedAtMs),
    finishedAt: iso(job.finishedAtMs),
    elapsedMs: Math.max(0, end - job.startedAtMs),
    label: job.label,
    target: { mcpEndpoint: job.target.mcpEndpoint, origin: job.target.origin },
    scope: job.scope,
  };
}

// The records after `since`, and the cursor to send next.
export function jobRecords(job, since = 0) {
  const stages = job.records.filter((r) => r.seq > since);
  return { stages, next: stages.length ? stages[stages.length - 1].seq : Math.max(0, Math.min(since, job.seq)) };
}

// Starts a job. `run({ report, signal, job })` does the work and resolves
// with the job's result, or throws (an error's `result` is kept beside its
// message). `onEnd(job)` runs once at the terminal state (the audit row).
//   { orgId, principalKey, kind, label, target: { mcpEndpoint, origin },
//     secrets (the resolved target, for redaction), scope, run, onEnd }
export function startJob({ orgId, principalKey, kind, label, target, secrets, scope = null, run, onEnd = null }) {
  const labels = new Map(stagesFor(kind).map((s) => [s.id, s.label]));
  const controller = new AbortController();
  const job = {
    id: randomBytes(16).toString('base64url'),
    orgId, principalKey, kind, label, target, scope,
    state: 'running', cancelRequested: false, timedOut: false, stopped: false,
    startedAtMs: seams.now(), finishedAtMs: null,
    seq: 0, records: [], stageStarted: new Map(), stageState: new Map(),
    result: null, error: null,
    secrets, controller, watchdog: null,
  };
  const report = (stage, state, { counts = null, message = null, gap = null } = {}) => {
    if (job.state !== 'running' || !labels.has(stage)) return;
    if (job.records.length >= MAX_LOG_RECORDS && state === 'running') return;   // progress goes first
    const now = seams.now();
    if (!job.stageStarted.has(stage)) job.stageStarted.set(stage, now);
    job.stageState.set(stage, state);
    const redact = (text) => (text == null ? null : cut(redactTarget(text, job.secrets)));
    job.records.push({
      seq: ++job.seq,
      stage,
      label: labels.get(stage),
      state,
      counts: counts && typeof counts === 'object' ? { ...counts } : null,
      startedAt: iso(job.stageStarted.get(stage)),
      finishedAt: FINAL_STAGE_STATES.has(state) ? iso(now) : null,
      message: redact(message),
      gap: gap ? { capability: gap.capability ?? null, reason: redact(gap.reason) } : null,
    });
  };
  job.report = report;
  jobs.set(job.id, job);
  job.watchdog = setTimeout(() => { job.timedOut = true; controller.abort(new DOMException('the job ran past its time limit', 'AbortError')); }, JOB_MAX_MS);
  job.watchdog.unref?.();

  const finish = (state, { result = null, error = null } = {}) => {
    if (job.state !== 'running') return;
    // A stage still reading when the job ended says it did not finish.
    const why = state === 'cancelled' ? 'cancelled before it finished' : 'stopped: the job ended before this stage finished';
    for (const [stage, st] of job.stageState) if (st === 'running') report(stage, 'failed', { message: why });
    job.state = state;
    job.finishedAtMs = seams.now();
    job.result = result;
    job.error = error === null ? null : cut(redactTarget(error, job.secrets));
    clearTimeout(job.watchdog);
    if (state === 'done') lastTook.set(job.orgId, { ...lastTookIn(job.orgId), [job.kind]: job.finishedAtMs - job.startedAtMs });
    try { onEnd?.(job); } catch (e) { process.stderr.write(`[live-jobs]   ${job.id}: the end hook failed: ${e.message}\n`); }
    // A finished job holds no target and no credential reference.
    job.secrets = null;
    job.controller = null;
    job.watchdog = null;
  };

  Promise.resolve()
    .then(() => run({ report, signal: controller.signal, job }))
    .then((result) => finish('done', { result }), (e) => {
      const result = e?.result ?? null;
      if (job.cancelRequested && controller.signal.aborted) return finish('cancelled', { result, error: `cancelled — nothing was registered` });
      if (job.timedOut) return finish('failed', { result, error: `the job ran past ${JOB_MAX_MS / 60_000} minutes and was stopped — nothing was registered` });
      if (job.stopped) return finish('failed', { result, error: 'the server stopped during the job — nothing was registered' });
      return finish('failed', { result, error: String(e?.message ?? e) });
    });
  prune();
  return job;
}

// Asks a running job to stop: it ends `cancelled` once its work notices.
export function cancelJob(job) {
  if (job.state !== 'running') return false;
  job.cancelRequested = true;
  job.controller?.abort(new DOMException('the job was cancelled', 'AbortError'));
  return true;
}

// The server's `close`: every running job is aborted (it fails, saying the
// server stopped) and its timer cleared.
export function abortAllLiveJobs() {
  for (const job of jobs.values()) {
    if (job.state !== 'running') continue;
    job.stopped = true;
    clearTimeout(job.watchdog);
    job.controller?.abort(new DOMException('the server stopped', 'AbortError'));
  }
}
