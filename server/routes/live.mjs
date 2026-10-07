// server/routes/live.mjs — the live MCP API (rebadge batch 3, C2):
// POST /api/mcp/ping, "test the connection" without building a pack.
//
// The route is `operator` with the live MCP API's posture
// (server/route-table.mjs LIVE): a server-side request to an MCP target, so
// without sign-in it answers only a request sent straight to a loopback
// address, it is closed when the server is exposed without sign-in, and it
// takes the CSRF header in every posture but the bearer's (R2). Its target
// is resolveMcpTarget's (server/service-admin.mjs) like a draft's: by id the
// endpoint's read token rides exactly as it would for a fetch — so the ping
// checks that wiring too —, and a typed `mcpUrl` is an admin's (R4); the
// origin allowlist applies either way.
//
// pingMcp (tools/fetch-live-pack.mjs) does the wire work; this file shapes
// its result into R2's answer and nothing else: the verdict, the origin,
// the endpoint used, reachability, the auth outcome (what was sent — the
// kind, never a value), the tool inventory through capabilityInventory
// (only names a capability maps; every other tool a count), the one read's
// bounded outcome, the timings, and the sentences. No string the target
// supplied reaches the answer beyond those mapped tool names, an origin a
// refused redirect pointed at, and the read's bounded detail; an HTTP
// failure is named by its status and step, never by its body.
//
// It writes no live file and no pack. A `live.ping` row is written only
// when the caller typed the URL (the R4 privilege in use; the origin and
// the verdict); a ping by id writes nothing. One stderr line per ping:
// `[mcp-ping] <verdict> <origin> <ms>`. A transport hook fault answers 502,
// redacted with the resolved target, as the deploy routes do. SQL-free.
//
// The live jobs (rebadge batch 3, C1; RULINGS R1) — a snapshot or a draft
// as a job (server/live-jobs.mjs holds them, in memory):
//   GET  /api/mcp/jobs                 the configured snapshot scope, your
//                                      running job here, how long the org's
//                                      last snapshot and draft took
//   POST /api/mcp/jobs                 { kind, mcpEndpointId | mcpUrl,
//                                      mcpAuth?, scope?, packName?, label? }
//                                      → 202 { ok, job, poll } + Location
//   GET  /api/mcp/jobs/:jobId?since=   the job, its stage records after the
//                                      cursor, `next`, and at its end the
//                                      result or the error
//   POST /api/mcp/jobs/:jobId/cancel   the starter, or an admin of the org
// A job's target is resolveMcpTarget's at start (the typed-URL and origin
// rules as for every fetch). Its body runs inside runWithOrg(job's org);
// before it registers, the starter's authority is checked again (the org
// still live, a session still a member of at least the operator role or an
// owner, the bearer still configured, the open posture still open), and the
// pack registers under the actor captured at start. A snapshot is
// validated (the schema) and bounded (livePackBytesLimit()) before it
// registers; a draft is draftFromMcp's (server/index.mjs), so its canonical
// is POST /api/draft-from-mcp's byte for byte. Every terminal state writes
// one live.fetch row (the origin; counts, never a URL or a token).

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { pingMcp, PING_DEADLINE_MS, fetchMcp, buildSnapshotPack } from '../../tools/fetch-live-pack.mjs';
import { capabilityInventory, productAttestedByTool } from '../../tools/lib/contracts/mcp-capabilities.mjs';
import { isTransportHookError } from '../../tools/lib/mcp-client.mjs';
import { adapt } from '../../tools/lib/adapter.mjs';
import { classify } from '../../tools/lib/artefact-model.mjs';
import { LIVE_KINDS, normalizeScope } from '../../tools/lib/live-fetch.mjs';
import { emit as emitYaml } from '../../tools/lib/mini-yaml.mjs';
import { livePackKind } from '../../tools/lib/service-keys.mjs';
import { validateCanonical, SPEC_SCHEMA_PATH } from '../../tools/lib/validator.mjs';
import { auditAfter, auditAfterAs, actorForRecord } from '../audit-after.mjs';
import { authEnabled } from '../auth.mjs';
import { apiToken, rankOf, rankOfRole } from '../authz.mjs';
import {
  JOB_MAX_MS, JOB_TTL_MS, MAX_RUNNING_JOBS, cancelJob, findJob, jobRecords, jobView, lastTookIn, livePackBytesLimit,
  runningJobCount, runningJobIn, snapshotScopeConfig, startJob,
} from '../live-jobs.mjs';
import { mcpUrlOrigin } from '../mcp-url.mjs';
import { mcpCallerOf, mcpRefusalBody, redactTarget } from '../mcp-target-policy.mjs';
import { registerPack, uploadsMap } from '../pack-registry.mjs';
import { resolveMcpTarget } from '../service-admin.mjs';
import { runWithOrg } from '../tenancy.mjs';
import { currentStore } from '../store/db.mjs';
import { liveOrg } from '../store/identity.mjs';
import { getMcpEndpoint } from '../store/mcp-endpoints.mjs';
import { getMembership } from '../store/memberships.mjs';
import { clampPackText } from '../store/packs.mjs';
import { getUser, getUserByLogin } from '../store/users.mjs';
import { bodyOf } from './util.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCHEMA = JSON.parse(readFileSync(resolve(ROOT, SPEC_SCHEMA_PATH), 'utf8'));

const seconds = (ms) => `${Math.round(ms / 100) / 10} s`;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

// What rode with the ping, for the sentences: { sent, text }.
function authOf(sent, tokenVar) {
  if (sent === 'endpoint-variable') return { sent, text: `the endpoint's variable ${tokenVar}` };
  if (sent === 'request') return { sent, text: 'the auth key sent with this request' };
  return { sent: 'none', text: null };
}

// An error that surfaced at a step, named without the target's own words.
function failureText(r) {
  if (r.httpStatus !== null) return `HTTP ${r.httpStatus} on ${r.stage}`;
  const error = String(r.error ?? '');
  if (r.verdict === 'not-mcp') {
    const redirect = /the MCP answered with (a redirect[^—]*?) — /.exec(error);
    if (redirect) return `it answered ${r.stage} with ${redirect[1].trim()}, which is not followed (register the URL it points at)`;
    if (/is not (?:valid JSON|a JSON-RPC result)/.test(error)) return `the answer to ${r.stage} is not a JSON-RPC result`;
    return `a JSON-RPC error on ${r.stage}`;
  }
  return error;
}

// The answer POST /api/mcp/ping sends for one pingMcp result. Pure.
//   ctx: { origin, mcpEndpoint: { id, name } | null, sent: 'endpoint-variable'
//          | 'request' | 'none', tokenVar }
export function pingAnswer(r, { origin, mcpEndpoint = null, sent = 'none', tokenVar = null } = {}) {
  const auth = authOf(sent, tokenVar);
  const inv = r.tools ? capabilityInventory(r.tools.names) : null;
  const count = r.tools ? r.tools.names.length : 0;
  const reads = inv ? count - inv.unmatched : 0;
  const tools = r.tools
    ? { count, capabilities: inv.capabilities, unmatched: inv.unmatched, complete: !r.tools.more }
    : null;
  const read = r.read
    ? {
      capability: r.read.capability, tool: r.read.tool, outcome: r.read.outcome,
      detail: r.read.outcome === 'ok' ? r.read.detail : null,
      backendAuthRefused: r.read.backendAuthRefused, credentialFree: r.read.credentialFree,
    }
    : null;
  const product = r.read?.tool ? (productAttestedByTool(r.read.tool) ?? 'its backend') : 'its backend';
  // Nothing answered (refused, unresolved, or silent before initialize): what
  // became of a token is unknown — null, never 'sent', which says the MCP answered.
  const unanswered = !r.initialized && (r.verdict === 'unreachable' || r.verdict === 'timeout');
  const outcome = r.verdict === 'auth-refused' ? 'refused' : auth.sent === 'none' ? 'not-sent' : unanswered ? null : 'sent';
  const listed = r.tools
    ? `listed ${plural(count, 'tool')}${r.tools.more ? ` in ${r.tools.pages} pages, and more remained` : ''} (${reads} that a fetch reads)`
    : null;

  const checked = [];
  const notChecked = [];
  if (r.initialized) checked.push('the MCP answered initialize');
  if (r.tools) checked.push(`tools/list listed ${plural(count, 'tool')}${r.tools.more ? ` (${r.tools.pages} pages; more remained)` : ''}`);
  let sentence;

  if (r.verdict === 'connected') {
    const withToken = auth.sent === 'none' ? 'without a token' : 'with the token sent';
    let tail;
    if (!read || read.outcome === 'not-advertised') {
      tail = '; it offers none of the reads a ping makes, so no tool was called.';
      notChecked.push('any tool call — this MCP offers none of the reads a ping makes');
    } else if (read.outcome === 'ok') {
      checked.push(`${read.tool} answered`);
      tail = read.credentialFree
        ? `, and ${read.tool} answered ${withToken} — but ${read.tool} answers without backend credentials, so whether the MCP's own credentials to ${product} work was not checked.`
        : `, and ${read.tool} answered ${withToken}.`;
      if (read.credentialFree) notChecked.push(`${read.tool} answers without backend credentials — whether the MCP's own credentials to ${product} work was not checked`);
    } else if (read.backendAuthRefused) {
      const status = /\b(401|403)\b/.exec(String(r.read.error ?? ''))?.[1];
      tail = `; but ${read.tool} failed: ${status ? `HTTP ${status} from ${product}` : `${product} refused it`} — the MCP's own credentials to ${product} were refused, so the tools behind it will fail.`;
      checked.push(`${read.tool} was called (its backend refused the MCP's credentials)`);
    } else if (read.outcome === 'timeout') {
      tail = `; but ${read.tool} did not answer in time.`;
      notChecked.push(`whether ${read.tool} answers — it did not answer in time`);
    } else {
      tail = `; but ${read.tool} answered with an error.`;
      checked.push(`${read.tool} was called (it answered with an error)`);
    }
    sentence = `Connected to ${origin} in ${r.timings.totalMs} ms: the MCP answered initialize, ${listed}${tail}`;
    notChecked.push('whether each other family answers — a snapshot or a draft finds that out', 'the backends behind every other tool');
  } else if (r.verdict === 'auth-refused' && r.stage === 'tools/call') {
    checked.push(`${r.read?.tool ?? 'the tool call'} was refused by the MCP`);
    const why = auth.sent === 'none'
      ? "no token was sent, and this MCP needs one for tool calls: set the endpoint's token variable, or send an auth key"
      : `the token sent (${auth.text}) is not accepted for tool calls`;
    sentence = `${origin} listed ${plural(count, 'tool')} but refused the tool call: HTTP ${r.httpStatus} on tools/call — ${why}`;
    notChecked.push('whether any tool answers with a token the MCP accepts');
  } else if (r.verdict === 'auth-refused') {
    const why = auth.sent === 'endpoint-variable' ? `${auth.text} was sent, and refused`
      : auth.sent === 'request' ? `${auth.text} was refused`
        : "no token was sent; this MCP needs one: set the endpoint's token variable, or send an auth key";
    sentence = `${origin} refused the connection: HTTP ${r.httpStatus} on ${r.stage} — ${why}`;
  } else if (r.verdict === 'unreachable') {
    sentence = `${origin} could not be reached: ${failureText(r)}`;
  } else if (r.verdict === 'timeout') {
    sentence = `${origin} did not answer ${r.stage} within ${seconds(r.limitMs ?? PING_DEADLINE_MS)}`;
  } else {
    sentence = `${origin} answered, but not as an MCP server: ${failureText(r)}`;
  }
  if (r.verdict !== 'connected') {
    if (!r.initialized) notChecked.push('whether the MCP answers initialize');
    if (!r.tools) notChecked.push('which tools the MCP offers');
    if (!read || r.stage !== 'tools/call') notChecked.push('any tool call');
  }

  return {
    ok: r.verdict === 'connected',
    verdict: r.verdict,
    origin,
    mcpEndpoint,
    reachable: { initialized: r.initialized },
    auth: { outcome, sent: auth.sent },
    tools,
    read,
    timings: r.timings,
    sentence,
    checked,
    notChecked,
  };
}


// ---------- the live jobs ----------

// The artefacts a pack holds: { artefacts, scaffold, byKind: { <family>: n } }
// — `scaffold` the sections the fetcher stamped mcp.scaffold.*.
export function livePackCounts(canonical) {
  const byKind = {};
  let artefacts = 0;
  // A layer is a list, but L4's three lists (policy, alerting, healing).
  const lists = Object.values(adapt(canonical).layers ?? {}).flatMap((layer) => (Array.isArray(layer) ? [layer] : Object.values(layer ?? {})));
  for (const layer of lists) {
    for (const a of Array.isArray(layer) ? layer : []) {
      artefacts++;
      const kind = classify(a);
      byKind[kind] = (byKind[kind] ?? 0) + 1;
    }
  }
  const annotations = canonical?.metadata?.annotations ?? {};
  const scaffold = Object.keys(annotations).filter((k) => k.startsWith('mcp.scaffold.')).length;
  return { artefacts, scaffold, byKind: Object.fromEntries(Object.keys(byKind).sort().map((k) => [k, byKind[k]])) };
}

// The key a job is held under beside its org: the principal, never a credential.
function principalKeyOf(p) {
  if (!p) return null;
  if (p.kind === 'session') return `session:${p.user?.id ?? p.actor}`;
  return p.kind;   // 'bearer', 'local'
}

// May the job's starter still register in its org? The org is live; a
// session's user is enabled and an owner, or a member of at least the
// operator role; the bearer is still configured; the open posture's local
// caller still has no sign-in in front of it.
function authorityStill(db, principal, orgId) {
  if (!liveOrg(db, orgId)) return false;
  if (principal.kind === 'session') {
    const user = (principal.user?.id != null ? getUser(db, principal.user.id) : null) ?? getUserByLogin(db, principal.actor);
    if (!user || user.disabled) return false;
    if (user.isOwner) return true;
    const membership = getMembership(db, orgId, user.id);
    return !!membership && rankOfRole(membership.role) >= rankOfRole('operator');
  }
  if (principal.kind === 'bearer') return !!apiToken();
  if (principal.kind === 'local') return !authEnabled();
  return false;
}

const KIND_NOUN = { snapshot: 'snapshot', draft: 'draft' };
const LIVE_KIND_TEXT = { scaffold: 'scaffold draft', snapshot: 'snapshot' };
const plain = (text) => (typeof text === 'string' && text.trim() ? text.trim() : null);
const sizeText = (n) => (n >= 1024 * 1024 ? `${Math.round((n / (1024 * 1024)) * 10) / 10} MB` : `${n} bytes`);
const clock = (iso) => `${iso.slice(11, 16)} UTC`;
// The unknown-id answer: the same for an expired job, another principal's,
// another org's, and one a restart lost.
function goneBody(id) {
  const shown = typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : '(that id)';
  return {
    ok: false,
    gone: true,
    error: `no live job ${shown} for you in this org — it expired ${JOB_TTL_MS / 60_000} minutes after it finished, or the server restarted (jobs run in its memory); a pack it registered is in the catalogue — otherwise start it again`,
  };
}
class JobFailure extends Error {
  constructor(message, result) { super(message); this.result = result; }
}
// The last record of each stage.
function foldStages(records) {
  const last = new Map();
  for (const r of records) last.set(r.stage, r);
  return [...last.values()];
}
const stageGaps = (records) => foldStages(records).filter((r) => r.gap).map((r) => ({ stage: r.stage, reason: r.gap.reason }));
const validationOf = (errors) => ({ ok: errors.length === 0, errors: errors.length, first: errors.slice(0, 5) });

export function liveRoutes({ authorize, draftFromMcp }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  router.post('/api/mcp/ping', authorize('POST /api/mcp/ping'), async (req, res) => {
    const body = bodyOf(req);
    const db = currentStore();
    const target = resolveMcpTarget(db, body, { forWrite: false, caller: mcpCallerOf(req) });
    if (target.status) return res.status(target.status).json(mcpRefusalBody(target));
    const typed = target.endpoint === null;
    const sentAuth = typeof body.mcpAuth === 'string' && body.mcpAuth !== '';
    const sent = sentAuth ? 'request' : target.mcpAuth ? 'endpoint-variable' : 'none';
    const tokenVar = sent === 'endpoint-variable' ? getMcpEndpoint(db, target.endpoint.id)?.readTokenEnv ?? null : null;
    const origin = mcpUrlOrigin(target.safeMcpUrl);
    let result;
    try {
      result = await pingMcp({ mcpUrl: target.mcpUrl, mcpAuth: target.mcpAuth });
    } catch (e) {
      if (!isTransportHookError(e)) throw e;
      const error = redactTarget(e.message, target);
      process.stderr.write(`[mcp-ping]   transport hook fault: ${error}\n`);
      return res.status(502).json({ ok: false, error });
    }
    process.stderr.write(`[mcp-ping] ${result.verdict} ${origin} ${result.timings.totalMs}ms\n`);
    const answer = pingAnswer(result, { origin, mcpEndpoint: target.endpoint, sent, tokenVar });
    // The R4 privilege in use: a typed URL's ping is on the record (the
    // origin and the verdict); a ping by id is a connectivity check.
    const auditError = typed
      ? auditAfter(req, { action: 'live.ping', targetKind: 'live', targetId: origin, detail: { verdict: result.verdict, typed: true } }, { tag: 'mcp-ping' })
      : null;
    // A second pass over every sentence: the resolved credential never
    // leaves, whatever the client's own redaction caught.
    answer.sentence = redactTarget(answer.sentence, target);
    res.json({ ...answer, ...(auditError ? { auditError } : {}) });
  });


  // ---------- the live jobs ----------

  router.get('/api/mcp/jobs', authorize('GET /api/mcp/jobs'), (req, res) => {
    const org = req.observogramOrg;
    const running = runningJobIn(org);
    const mine = running && running.principalKey === principalKeyOf(req.observogramPrincipal) ? jobView(running) : null;
    res.json({ ok: true, scope: snapshotScopeConfig(currentStore(), org), running: mine, lastTook: lastTookIn(org) });
  });

  router.post('/api/mcp/jobs', authorize('POST /api/mcp/jobs'), (req, res) => {
    const body = bodyOf(req);
    const db = currentStore();
    const org = req.observogramOrg;
    const principal = req.observogramPrincipal;
    const bad = (error, extra = {}) => res.status(400).json({ ok: false, error, ...extra });
    const kind = body.kind;
    if (!LIVE_KINDS.includes(kind)) return bad(`kind is snapshot or draft (got ${JSON.stringify(kind ?? null).slice(0, 40)})`);
    const hasScope = body.scope !== undefined && body.scope !== null;
    if (kind === 'draft' && hasScope) return bad('scope applies to a snapshot; a draft reads every family as POST /api/draft-from-mcp does');
    const target = resolveMcpTarget(db, body, { forWrite: false, caller: mcpCallerOf(req) });
    if (target.status) return res.status(target.status).json(mcpRefusalBody(target));
    let scope = null;
    if (kind === 'snapshot') {
      if (hasScope) {
        const normalized = normalizeScope(body.scope);
        if (normalized.errors.length) return bad(normalized.errors.join('; '));
        scope = normalized.scope;
      } else {
        const configured = snapshotScopeConfig(db, org);
        if (configured.errors.length) return bad(`the configured snapshot scope does not parse — ${configured.errors.join('; ')}; fix the variable, or send a scope with the request`);
        scope = configured.defaults;
      }
    }
    const packName = plain(body.packName);
    const label = clampPackText(body.label);
    // The registry deduplicates by label and carries verdicts: a label the
    // other live kind holds would replace that pack.
    if (label) {
      const other = kind === 'draft' ? 'snapshot' : 'scaffold';
      const held = [...uploadsMap(db).values()].some((rec) => rec.label === label && livePackKind(rec.canonical) === other);
      if (held) return res.status(409).json({ ok: false, error: `the label "${label}" is held by a ${LIVE_KIND_TEXT[other]}; registering under it would replace it and carry its verdicts — choose another label` });
    }
    const key = principalKeyOf(principal);
    const running = runningJobIn(org);
    if (running) {
      const mine = running.principalKey === key;
      const started = clock(jobView(running).startedAt);
      return res.status(409).json({
        ok: false,
        error: `a live job is already running in ${org} (started ${started} by ${mine ? 'you' : 'another member'}) — ${mine ? 'follow it here' : `it ends within ${JOB_MAX_MS / 60_000} minutes at most; an admin of ${org} can cancel it`}`,
        ...(mine ? { running: { id: running.id } } : {}),
      });
    }
    if (runningJobCount() >= MAX_RUNNING_JOBS) {
      return res.status(409).json({ ok: false, error: `the server is already running ${MAX_RUNNING_JOBS} live jobs (its limit) — try again in a few minutes` });
    }
    let actor;
    try { actor = actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    const origin = mcpUrlOrigin(target.safeMcpUrl);
    const typed = target.endpoint === null;
    const t0 = Date.now();

    // Registers a built pack for the job: cancel and authority checked first.
    const registerFor = (job, report, signal) => (pack, finalLabel) => {
      if (signal.aborted) throw signal.reason;
      const bytes = Buffer.byteLength(emitYaml(pack));
      if (bytes > livePackBytesLimit()) {
        const text = `the ${KIND_NOUN[kind]} is ${sizeText(bytes)}, over the ${sizeText(livePackBytesLimit())} limit an upload may be — narrow the scope`;
        report('register', 'failed', { message: text });
        throw new Error(text);
      }
      report('register', 'running');
      if (!authorityStill(currentStore(), principal, org)) {
        const text = `your access to ${org} changed during the job — nothing was registered`;
        report('register', 'failed', { message: text });
        throw new Error(text);
      }
      const id = registerPack(currentStore(), actor, { canonical: pack, source: finalLabel, label: finalLabel });
      job.label = finalLabel;
      report('register', 'done', { message: `registered as ${finalLabel}` });
      return id;
    };

    const runSnapshot = async ({ report, signal, job }) => {
      const onStage = (r) => report(r.stage, r.state, r);
      const fetched = await fetchMcp({ mcpUrl: target.mcpUrl, mcpAuth: target.mcpAuth, mode: 'snapshot', scope, onStage, signal });
      if (signal.aborted) throw signal.reason;
      report('build', 'running');
      const refreshedAt = new Date().toISOString();
      const gaps = fetched.snapshot?.gaps ?? [];
      const pack = buildSnapshotPack(fetched, { refreshedAt, origin, endpoint: target.endpoint, packName, scope, gaps });
      const errors = validateCanonical(pack, SCHEMA);
      const counts = livePackCounts(pack);
      const bytes = Buffer.byteLength(emitYaml(pack));
      const partial = { registered: null, validation: validationOf(errors), counts: counts.byKind, gaps };
      const buildCounts = { artefacts: counts.artefacts, scaffold: counts.scaffold, errors: errors.length, bytes };
      if (errors.length) {
        const text = `the snapshot failed schema validation (${errors.length} error${errors.length === 1 ? '' : 's'}) — nothing was registered`;
        report('build', 'failed', { counts: buildCounts, message: text });
        throw new JobFailure(text, partial);
      }
      if (bytes > livePackBytesLimit()) {
        const text = `the snapshot is ${sizeText(bytes)}, over the ${sizeText(livePackBytesLimit())} limit an upload may be — narrow the scope`;
        report('build', 'failed', { counts: buildCounts, message: text });
        throw new JobFailure(text, partial);
      }
      report('build', 'done', { counts: buildCounts });
      const finalLabel = label ?? `${pack.metadata?.name || 'live-snapshot'} (live MCP snapshot)`;
      const id = registerFor(job, report, signal)(pack, finalLabel);
      return { ...partial, registered: { id, label: finalLabel }, tookMs: Date.now() - t0 };
    };

    const runDraft = async ({ report, signal, job }) => {
      const answer = await draftFromMcp(target, {
        packName, label, signal, tag: 'mcp-job', verb: 'draft',
        onStage: (r) => report(r.stage, r.state, r),
        register: registerFor(job, report, signal),
      });
      const partial = {
        registered: null,
        validation: validationOf(answer.validation.errors),
        counts: livePackCounts(answer.canonical).byKind,
        gaps: stageGaps(job.records),
      };
      if (!answer.validation.ok) {
        const n = answer.validation.errors.length;
        throw new JobFailure(`the draft failed schema validation (${n} error${n === 1 ? '' : 's'}) — nothing was registered`, partial);
      }
      return {
        ...partial,
        registered: { id: answer.registered.id, label: job.label },
        tookMs: Date.now() - t0,
        draft: { summary: answer.summary, conformance: answer.conformance, mcpEndpoint: answer.mcpEndpoint },
      };
    };

    // At every end: one live.fetch row — where the server sent its
    // requests, whether or not anything registered.
    const onEnd = (job) => runWithOrg(org, () => {
      const folded = foldStages(job.records);
      const stages = { done: 0, skipped: 0, failed: 0 };
      for (const r of folded) if (r.state in stages) stages[r.state]++;
      const auditError = auditAfterAs(actor, {
        action: 'live.fetch',
        targetKind: 'live',
        targetId: origin,
        detail: {
          kind, outcome: job.state, typed, mcpEndpoint: target.endpoint, jobId: job.id,
          packId: job.result?.registered?.id ?? null, stages,
          gaps: folded.filter((r) => r.gap).map((r) => r.stage),
        },
      }, { tag: 'mcp-job' });
      if (auditError && job.result) job.result.auditError = auditError;
      process.stderr.write(`[mcp-job] ${job.id} ${kind} ${job.state} in ${job.finishedAtMs - job.startedAtMs}ms${job.error ? `: ${job.error}` : ''}\n`);
    });

    const job = startJob({
      orgId: org, principalKey: key, kind, label, scope,
      target: { mcpEndpoint: target.endpoint, origin },
      secrets: target,
      run: (ctx) => runWithOrg(org, () => (kind === 'snapshot' ? runSnapshot(ctx) : runDraft(ctx))),
      onEnd,
    });
    process.stderr.write(`[mcp-job] ${job.id} ${kind} started -> ${origin}\n`);
    const poll = `/api/mcp/jobs/${job.id}`;
    res.status(202).set('Location', poll).json({ ok: true, job: jobView(job), poll });
  });

  router.get('/api/mcp/jobs/:jobId', authorize('GET /api/mcp/jobs/:jobId'), (req, res) => {
    const job = findJob(req.observogramOrg, req.params.jobId);
    if (!job || job.principalKey !== principalKeyOf(req.observogramPrincipal)) return res.status(404).json(goneBody(req.params.jobId));
    const raw = req.query.since;
    const since = raw === undefined || raw === '' ? 0 : Number(raw);
    if (!Number.isInteger(since) || since < 0) return res.status(400).json({ ok: false, error: 'since is the seq of the last record read (a whole number, 0 or more)' });
    const { stages, next } = jobRecords(job, since);
    res.json({
      ok: true,
      job: jobView(job),
      stages,
      next,
      ...(job.result ? { result: job.result } : {}),
      ...(job.error ? { error: job.error } : {}),
    });
  });

  router.post('/api/mcp/jobs/:jobId/cancel', authorize('POST /api/mcp/jobs/:jobId/cancel'), (req, res) => {
    const principal = req.observogramPrincipal;
    const job = findJob(req.observogramOrg, req.params.jobId);
    const own = !!job && job.principalKey === principalKeyOf(principal);
    // An admin of the org may stop any job; it never reads the gate log.
    const asAdmin = !!job && !own && rankOf(principal) >= rankOfRole('admin');
    if (!own && !asAdmin) return res.status(404).json(goneBody(req.params.jobId));
    if (job.state !== 'running') return res.status(409).json({ ok: false, error: `the job already finished (${job.state}) — nothing to cancel` });
    cancelJob(job);
    res.json({ ok: true, job: own ? jobView(job) : { id: job.id, state: job.state } });
  });

  return router;
}
