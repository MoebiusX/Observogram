// server/routes/control-room.mjs — Overview's control room: what a service's live side shows now.
//
// POST /api/services/:id/control-room { env?, fresh? }
//   The environment's live MCP endpoint, read with the org endpoint's
//   server-held read token (the same target its Run uses, resolved by id:
//   never a typed URL), through tools/lib/control-room.mjs: what is firing,
//   the targets up (and the scrape jobs the repository declares), how long
//   incidents took to clear over 30 days, and the known metric families'
//   tiles. Nothing from the request reaches a query: the body names an
//   environment, nothing else.
//
// Class operator with the live MCP posture (server/route-table.mjs LIVE):
// every server-side MCP read is one. A viewer is told why, as for a Run.
// No audit row — a read by endpoint id, as the ping by id writes none; one
// stderr line per read instead.
//
// Cost: one read serves every viewer of the same service environment and
// endpoint (its address and credential) for CONTROL_ROOM_TTL_MS (single
// flight while it runs); the firing history, the heavy part and the
// endpoint's whatever service reads it, is kept per endpoint
// CONTROL_ROOM_TIMING_TTL_MS — CONTROL_ROOM_TIMING_FAILED_TTL_MS when it
// could not be read or was cut — and its open incidents are checked against
// each fresh read's alerts (an alert firing now that it does not hold open,
// or one firing beside an empty history, has it read again on the next
// read). At most CONTROL_ROOM_MAX_IN_FLIGHT reads run at once in the
// deployment and CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG in one org (a 429 with
// Retry-After past either). Each read ends the MCP sessions it opened.
//
// The deadline: at CONTROL_ROOM_DEADLINE_MS the read is cut — what it has
// read is answered, the rest said as not read (out of time); with nothing
// read, a 502. A read that is not back CONTROL_ROOM_GRACE_MS later (a
// transport that ignores the cut) is answered 502 and its slot freed; such
// reads still pending are counted, and past CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG
// of them the org is refused until they end. Nothing a read given up on
// returns is kept.
//
// Answers 200 with each part's own outcome (data · empty · failed ·
// not-attempted, never a made-up zero); 404 / 400 for the service or the
// environment (pickServiceEnvironment's sentences, the Run's); 409 when the
// environment names no endpoint; 403 / 400 from the target policy; 502 when
// the endpoint did not answer at all. Every string is redacted against the
// resolved target before it leaves.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express from 'express';
import { adapt } from '../../tools/lib/adapter.mjs';
import { cleanError, controlRoomFamilies, openControlRoom, readControlRoom } from '../../tools/lib/control-room.mjs';
import { loadJourneyDef, readJourneyPackA } from '../../tools/lib/journey.mjs';
import { isTransportHookError } from '../../tools/lib/mcp-client.mjs';
import { mcpTransport } from '../../tools/mcp-transport.mjs';
import { actorForRecord } from '../audit-after.mjs';
import { mcpUrlOrigin } from '../mcp-url.mjs';
import { mcpCallerOf, mcpRefusalBody, redactTarget } from '../mcp-target-policy.mjs';
import { currentOrg } from '../org-context.mjs';
import { pickServiceEnvironment, resolveMcpTarget, serviceJourneyName } from '../service-admin.mjs';
import { currentStore } from '../store/db.mjs';
import { baseWorkspaceRoot, orgWorkspaceRoot } from '../tenancy.mjs';
import { bodyOf } from './util.mjs';

export const CONTROL_ROOM_TTL_MS = 30_000;
export const CONTROL_ROOM_TIMING_TTL_MS = 10 * 60_000;
export const CONTROL_ROOM_TIMING_FAILED_TTL_MS = 2 * 60_000;
export const CONTROL_ROOM_DEADLINE_MS = 20_000;
export const CONTROL_ROOM_GRACE_MS = 2_000;
export const CONTROL_ROOM_MAX_IN_FLIGHT = 8;
// Half the deployment's: one org reading many services at once still leaves room for another.
export const CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG = 4;
// A "fresh" read (the panel's Refresh) is taken at most this often.
export const CONTROL_ROOM_FRESH_MIN_MS = 5_000;

// The families: the built-in ones and, when the operator names a file
// (OBSERVOGRAM_CONTROL_ROOM_FAMILIES, a JSON { families: [...] }), its rows,
// read once when the route is mounted and checked (tools/lib/control-room.mjs
// controlRoomFamilies); a warning is one stderr line.
let familySet = null;
export function controlRoomFamilySet() {
  if (familySet) return familySet;
  const path = process.env.OBSERVOGRAM_CONTROL_ROOM_FAMILIES;
  let custom = null;
  const warnings = [];
  if (path) {
    try { custom = JSON.parse(readFileSync(path, 'utf8')); }
    catch (e) { warnings.push(`OBSERVOGRAM_CONTROL_ROOM_FAMILIES (${path}) could not be read (${e.code || e.message}); only the built-in families are read`); }
  }
  const merged = controlRoomFamilies(custom);
  familySet = { families: merged.families, warnings: [...warnings, ...merged.warnings] };
  for (const w of familySet.warnings) process.stderr.write(`[control-room] ${w}\n`);
  return familySet;
}

// Test seams: the clock, the deadline and its grace, and a cache reset.
const seams = { now: () => Date.now(), deadlineMs: CONTROL_ROOM_DEADLINE_MS, graceMs: CONTROL_ROOM_GRACE_MS };
export function setControlRoomSeams(over = {}) { Object.assign(seams, over); }
export function resetControlRoom() {
  cache.clear();
  timings.clear();
  inFlight = 0;
  orgInFlight.clear();
  orgAbandoned.clear();
  familySet = null;
  seams.now = () => Date.now();
  seams.deadlineMs = CONTROL_ROOM_DEADLINE_MS;
  seams.graceMs = CONTROL_ROOM_GRACE_MS;
}

// key → { at, answer, flight: Promise | null, freshAt, touched }; the firing history per endpoint:
// org:endpointKey → { at, ttl, value }
const cache = new Map();
const timings = new Map();
let inFlight = 0;
const orgInFlight = new Map(); // org → reads running
const orgAbandoned = new Map(); // org → reads given up on at the deadline and still pending
const bump = (map, org, by) => { const n = (map.get(org) || 0) + by; if (n > 0) map.set(org, n); else map.delete(org); };

// An entry nobody read for the history's whole keep is dropped (a repointed
// endpoint, a deleted service): the map holds only what is still looked at.
function sweep(now) {
  for (const [k, e] of cache) {
    if (e.flight) continue;
    const last = Math.max(e.at || 0, e.freshAt || 0, e.touched || 0);
    if (now - last > CONTROL_ROOM_TIMING_TTL_MS) cache.delete(k);
  }
  for (const [k, t] of timings) if (now - t.at > t.ttl) timings.delete(k);
}

// The endpoint as a cache key: its id, and a digest of the address and the
// credential the read rides (a repointed endpoint, or the same URL under
// another token, is another backend). The digest never leaves the process.
const endpointKey = (target, id) => `${id}:${createHash('sha256').update(`${target.mcpUrl}\u0000${target.mcpAuth ?? ''}`).digest('hex').slice(0, 24)}`;

// The scrape jobs the service's repository declares: its saved check's Pack A
// (the scan its last Run registered), read inside this org's own part of the
// workspace, as a run reads it. None when it was never run.
function declaredJobsOf(service, env) {
  try {
    const def = loadJourneyDef(serviceJourneyName(service.slug, env.name), { allowPath: false });
    const canonical = readJourneyPackA(def, { crawlScope: { base: baseWorkspaceRoot(), ownRoot: orgWorkspaceRoot() } });
    if (!canonical) return [];
    const jobs = new Set();
    for (const layer of Object.values(adapt(canonical).layers || {})) {
      const list = Array.isArray(layer) ? layer : Object.values(layer || {}).filter(Array.isArray).flat();
      for (const a of list) if (/^SCRAPE-SRC-/.test(String(a?.id || '')) && a.source !== 'Scaffold' && a.spec?.job) jobs.add(String(a.spec.job));
    }
    return [...jobs].sort();
  } catch { return []; }
}

const redactAll = (v, target) => (typeof v === 'string' ? redactTarget(v, target)
  : Array.isArray(v) ? v.map((x) => redactAll(x, target))
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactAll(x, target)])) : v);

const NOT_OFFERED = 'the endpoint offers no PromQL query tool, so nothing live could be read';
const READ = (p) => p && (p.outcome === 'data' || p.outcome === 'empty');

// The firing history may be minutes older than the alerts read now. An
// incident it holds open that is not firing now has closed since (its length
// unknown to this history) and is not said as open. A history that found
// nothing while something fires now, or one that does not hold open an alert
// firing now (it fired after the history was read), is marked `outdated`:
// the route drops it, so the next read reads it again.
export function reconcileTiming(timing, alerts) {
  if (!timing || !READ(alerts)) return timing;
  const by = alerts.bySeverity || {};
  const firingCount = ['critical', 'warning', 'other', 'info'].reduce((n, k) => n + (Number(by[k]) || 0), 0);
  if (timing.outcome === 'empty' && firingCount > 0) return { ...timing, outdated: true };
  if (!Array.isArray(timing.open)) return timing;
  const firing = new Set((alerts.active || []).filter((a) => a.state === 'firing').map((a) => a.name));
  const held = new Set(timing.open.map((o) => o.name));
  const outdated = [...firing].some((n) => !held.has(n));
  // A list cut at its length cannot say an alert is not firing: the open ones stay as they are.
  if (alerts.more > 0) return outdated ? { ...timing, outdated: true } : timing;
  const open = timing.open.filter((o) => firing.has(o.name));
  if (open.length === timing.open.length && !outdated) return timing;
  return { ...timing, open, ...(open.length !== timing.open.length ? { closedSince: timing.open.length - open.length } : {}), ...(outdated ? { outdated: true } : {}) };
}

export function controlRoomRoutes({ authorize }) {
  const router = express.Router({ caseSensitive: true });
  controlRoomFamilySet();

  router.post('/api/services/:id/control-room', authorize('POST /api/services/:id/control-room'), async (req, res) => {
    const db = currentStore();
    const body = bodyOf(req);
    const picked = pickServiceEnvironment(db, req.params.id, body.env);
    if (picked.status) return res.status(picked.status).json({ ok: false, error: picked.error });
    const { service, env } = picked;
    if (env.mcpEndpointId === null || env.mcpEndpointId === undefined) {
      return res.status(409).json({ ok: false, error: `${service.name} in ${env.name} has no live target yet — choose the MCP endpoint that reads it` });
    }
    const target = resolveMcpTarget(db, { mcpEndpointId: env.mcpEndpointId }, { forWrite: false, caller: mcpCallerOf(req) });
    if (target.status) return res.status(target.status).json(mcpRefusalBody(target));
    try { actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }

    const org = currentOrg() ?? '';
    const now = seams.now();
    sweep(now);
    const key = `${org}:${service.id}:${env.id}:${endpointKey(target, env.mcpEndpointId)}`;
    const known = cache.get(key) || null;
    const wantsFresh = body.fresh === true && now - (known?.freshAt || 0) >= CONTROL_ROOM_FRESH_MIN_MS;
    if (known?.answer && !wantsFresh && now - known.at < CONTROL_ROOM_TTL_MS) { known.touched = now; return res.json({ ...known.answer, cached: true }); }
    if (known?.flight) {
      const shared = await known.flight;
      return res.status(shared.status).json(shared.status === 200 ? { ...shared.body, cached: true } : shared.body);
    }
    if (inFlight >= CONTROL_ROOM_MAX_IN_FLIGHT) {
      res.set('Retry-After', '5');
      return res.status(429).json({ ok: false, error: 'Too many live reads are running in this studio — try again in a few seconds' });
    }
    if ((orgInFlight.get(org) || 0) >= CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG) {
      res.set('Retry-After', '5');
      return res.status(429).json({ ok: false, error: 'Too many live reads are running for this organisation — try again in a few seconds' });
    }
    if ((orgAbandoned.get(org) || 0) >= CONTROL_ROOM_MAX_IN_FLIGHT_PER_ORG) {
      res.set('Retry-After', '30');
      return res.status(429).json({ ok: false, error: 'Earlier live reads of this organisation have not ended yet — they are given time to end' });
    }
    const entry = known || { at: 0, answer: null, flight: null, freshAt: 0, touched: now };
    cache.set(key, entry);
    // The firing history is the endpoint's: one per endpoint, whichever service environment reads it.
    const timingKey = `${org}:${endpointKey(target, env.mcpEndpointId)}`;
    if (wantsFresh) entry.freshAt = now;

    const origin = mcpUrlOrigin(target.safeMcpUrl);
    inFlight += 1;
    bump(orgInFlight, org, 1);
    const passed = new AbortController();
    let gaveUp = false;
    let settled = false;
    const failure = (why) => {
      process.stderr.write(`[control-room] ${service.slug}/${env.name} ${origin} failed: ${redactTarget(why, target)}\n`);
      return { status: 502, body: { ok: false, error: redactTarget(`The live endpoint did not answer: ${why}`, target) } };
    };
    const deadlineWords = () => `no answer within ${Math.max(1, Math.round(seams.deadlineMs / 1000))} s`;
    // The cut: the read keeps what it has, the rest is said as out of time.
    const cut = setTimeout(() => passed.abort(new Error('deadline')), seams.deadlineMs);
    let hardTimer = null;
    const hard = new Promise((resolve) => {
      hardTimer = setTimeout(() => { gaveUp = true; resolve(failure(deadlineWords())); }, seams.deadlineMs + seams.graceMs);
    });
    const work = (async () => {
      const started = seams.now();
      let room = null;
      try {
        const transport = await mcpTransport();
        room = await openControlRoom({ mcpUrl: target.mcpUrl, mcpAuth: target.mcpAuth, transport, timeoutMs: 10_000, signal: passed.signal });
        const declaredJobs = declaredJobsOf(service, env);
        const head = {
          ok: true, readAt: new Date(started).toISOString(),
          service: { id: service.id, name: service.name, slug: service.slug }, env: { name: env.name },
          endpoint: { id: target.endpoint?.id ?? env.mcpEndpointId, name: target.endpoint?.name ?? null, origin },
          scope: { kind: 'endpoint', declaredJobs: declaredJobs.length },
        };
        let read;
        // The history this read did not ask for (kept from an earlier one): never quoted as this read's failure.
        let timingKept = false;
        if (!room.advertised) {
          const none = { outcome: 'not-attempted', reason: NOT_OFFERED };
          read = { calls: { made: 0, budget: 0 }, alerts: { ...none, bySeverity: null, active: [], more: 0 }, scrape: { ...none }, timing: { ...none }, families: { ...none, rows: [] }, absent: [] };
        } else {
          const keptEntry = timings.get(timingKey);
          const kept = keptEntry && started - keptEntry.at < keptEntry.ttl ? keptEntry : null;
          timingKept = !!kept;
          read = await readControlRoom({
            callTool: room.callTool, callHistoryTool: room.callHistoryTool, tool: room.tool, families: controlRoomFamilySet().families,
            declaredJobs, nowSeconds: started / 1000, signal: passed.signal, timing: !kept,
          });
          // Given up on at the deadline: nothing this read returns is kept, or answered.
          if (gaveUp) return null;
          if (read.timing) {
            read.timing.readAt = head.readAt;
            // A history read whole is kept 10 minutes; one that failed or was cut, 2 (the heaviest query
            // is not started again on every read of a slow store).
            if (READ(read.timing)) timings.set(timingKey, { at: started, ttl: CONTROL_ROOM_TIMING_TTL_MS, value: read.timing });
            else if (read.timing.outcome === 'failed' || read.timing.outcome === 'not-attempted') timings.set(timingKey, { at: started, ttl: CONTROL_ROOM_TIMING_FAILED_TTL_MS, value: read.timing });
          } else read.timing = kept?.value ?? null;
          read.timing = reconcileTiming(read.timing, read.alerts);
          if (read.timing?.outdated) timings.delete(timingKey);
        }
        // Cut at the deadline with nothing read: no answer at all, with what the endpoint did say when it said something.
        if (passed.signal.aborted && !['alerts', 'scrape', 'timing', 'families'].some((p) => READ(read[p]))) {
          const said = ['alerts', 'scrape', ...(timingKept ? [] : ['timing']), 'families'].map((p) => read[p]).find((p) => p?.outcome === 'failed')?.reason;
          return failure(said ? `${deadlineWords()} (before that: ${said})` : deadlineWords());
        }
        const tookMs = Math.max(0, Math.round(seams.now() - started));
        const answer = redactAll({ ...head, tookMs, cached: false, ...read }, target);
        entry.at = seams.now();
        entry.answer = answer;
        process.stderr.write(`[control-room] ${service.slug}/${env.name} ${origin} ${read.calls.made} calls ${tookMs}ms${read.calls.outOfTime ? ' (cut at the deadline)' : ''}\n`);
        return { status: 200, body: answer };
      } catch (e) {
        if (gaveUp) return null;
        if (isTransportHookError(e)) {
          const error = redactTarget(e.message, target);
          process.stderr.write(`[control-room] transport hook fault: ${error}\n`);
          return { status: 502, body: { ok: false, error } };
        }
        return failure(passed.signal.aborted ? deadlineWords() : cleanError(e?.message));
      } finally {
        settled = true;
        // Nothing of this read may still run (a transport hook fault rejects the read with queries
        // queued), and the sessions it opened end, whatever happened (never awaited: the answer does not wait on it).
        if (!passed.signal.aborted) passed.abort(new Error('read ended'));
        room?.end?.().catch(() => {});
      }
    })();
    // The first to settle answers: the work, or the hard deadline (a transport that ignores the cut
    // cannot hold the flight or the slot past it; it is counted until it ends).
    const run = Promise.race([work, hard]).then((out) => out || failure(deadlineWords())).finally(() => {
      clearTimeout(cut);
      clearTimeout(hardTimer);
      inFlight -= 1;
      bump(orgInFlight, org, -1);
      if (entry.flight === run) entry.flight = null;
      if (!settled) {
        passed.abort(new Error('read ended'));
        bump(orgAbandoned, org, 1);
        work.finally(() => bump(orgAbandoned, org, -1));
      }
    });
    entry.flight = run;
    const out = await run;
    return res.status(out.status).json(out.body);
  });

  return router;
}
