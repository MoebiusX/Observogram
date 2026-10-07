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

import express from 'express';
import { pingMcp, PING_DEADLINE_MS } from '../../tools/fetch-live-pack.mjs';
import { capabilityInventory, productAttestedByTool } from '../../tools/lib/contracts/mcp-capabilities.mjs';
import { isTransportHookError } from '../../tools/lib/mcp-client.mjs';
import { auditAfter } from '../audit-after.mjs';
import { mcpUrlOrigin } from '../mcp-url.mjs';
import { mcpCallerOf, mcpRefusalBody, redactTarget } from '../mcp-target-policy.mjs';
import { resolveMcpTarget } from '../service-admin.mjs';
import { currentStore } from '../store/db.mjs';
import { getMcpEndpoint } from '../store/mcp-endpoints.mjs';
import { bodyOf } from './util.mjs';

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
  const outcome = r.verdict === 'auth-refused' ? 'refused' : auth.sent === 'none' ? 'not-sent' : 'sent';
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
    notChecked.push('whether each other family answers — a draft finds that out', 'the backends behind every other tool');
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

export function liveRoutes({ authorize }) {
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

  return router;
}
