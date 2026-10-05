// server/waiver-admin.mjs — the rules of a service record's waivers (GAP
// batch 2, B3.2; docs/CONFORMANCE.md "Waivers", docs/ADAPTER.md "Waivers —
// a service record's suppression of a finding"), a sibling of
// service-admin.mjs and verdict-admin.mjs: every rule the waivers API applies
// lives here once, every refusal is an AdminRefusal with a `kind` — 'invalid'
// (bad input), 'missing' (no such service, no such waiver) or 'conflict' (an
// active waiver of the same key exists; the waiver is revoked already) —
// which the routes answer as 400, 404 and 409 (server/routes/util.mjs).
//
// A waiver is a time-boxed, reasoned suppression of ONE rubric clause
// (`ruleId`, tools/lib/conformance.mjs RUBRIC), optionally scoped to ONE
// canonical symbol of a per-item clause (`artefactId`: `slis.<id>`,
// `slos.<id>` — the adapter's `defines` vocabulary, never a JSONPath) of the
// SERVICE the pack is primarily linked to (serviceTierFor, service-admin.mjs):
// a re-upload keeps it, a catalogue pack has no service and no waiver. The
// author is the audit actor (a login or the token label, never an email);
// the body's `author` and `createdAt` are ignored — the principal and the
// server's clock sign a waiver. Immutable but for the revoke, which keeps the
// row as history; one active waiver per (service, ruleId, artefactId); a new
// one may follow an expiry (renewal). Schema errors are not waivable: a pack
// the validator refuses is never graded. The vocabulary of states and the
// overlay are tools/lib/waivers.mjs's — the same engine the CLI's sidecar
// file goes through.
//
// No SQL of its own: every read and write goes through server/store/waivers.mjs.

import { RUBRIC, SUBJECT_CLAUSES } from '../tools/lib/conformance.mjs';
import { MAX_REASON, MAX_TEXT, applyWaiversToConformance, oneLine, waiverView } from '../tools/lib/waivers.mjs';
import { AdminRefusal } from './identity-admin.mjs';
import { WAYS as SERVICE_WAYS } from './service-admin.mjs';
import { atomic } from './store/db.mjs';
import { getService } from './store/services.mjs';
import { createWaiver, getWaiver, listWaivers, revokeWaiver } from './store/waivers.mjs';

const refuse = (message, kind = 'conflict') => { throw new AdminRefusal(message, kind); };
const invalid = (message) => refuse(message, 'invalid');
const missing = (message) => refuse(message, 'missing');

export const EXPIRY_MAX_DAYS = 366;
const DAY_MS = 86400000;
// A canonical symbol of a per-item clause: an SLI or an SLO as the adapter's
// defines names it (the schema's Slug for the id).
const SYMBOL_RE = /^(slis|slos)\.[a-z][a-z0-9_-]*$/;
const RULE_IDS = new Set(RUBRIC.map((c) => c.id));

const scope = (w) => (w.artefactId ? `${w.ruleId} on ${w.artefactId}` : w.ruleId);

// The way out each refusal names.
export const WAYS = Object.freeze({
  noService: SERVICE_WAYS.noService,
  ruleId: (x) => `ruleId must be a rubric clause id — GET /api/maturity-rubric lists them — not ${JSON.stringify(x)}`,
  packLevelOnly: (ruleId) => `${ruleId} grades the whole pack and takes no artefactId; the per-item clauses are ${SUBJECT_CLAUSES.join(', ')}`,
  artefactId: `artefactId must be a canonical symbol of the pack — an SLI or SLO as the adapter's defines names it (slis.<id>, slos.<id>), at most ${MAX_TEXT} characters — or null for the whole clause`,
  reason: `reason is one line of 1–${MAX_REASON} characters`,
  expiresAt: (x) => `expiresAt must be an ISO time after now and at most ${EXPIRY_MAX_DAYS} days ahead, not ${JSON.stringify(x)}`,
  duplicate: (w) => `an active waiver of ${scope(w)} exists on this service (id ${w.id}, expires ${w.expiresAt}) — POST /api/waivers/${w.id}/revoke ends it, or wait for it to expire`,
  noWaiver: (id) => `no waiver ${id}`,
  revoked: (w) => `waiver ${w.id} is revoked already (${w.revokedAt}, by ${w.revokedBy})`,
  revokeReason: `a revoke reason is one line of at most ${MAX_REASON} characters`,
});

// ---------- the body ----------

// { ruleId, artefactId: null | symbol, reason, expiresAt (toISOString) } —
// `author` and `createdAt` in the body are ignored.
export function parseWaiverBody(body, { now }) {
  if (!RULE_IDS.has(body.ruleId)) invalid(WAYS.ruleId(body.ruleId));
  const artefactId = body.artefactId === undefined || body.artefactId === null || body.artefactId === '' ? null : body.artefactId;
  if (artefactId !== null && (typeof artefactId !== 'string' || artefactId.length > MAX_TEXT || !SYMBOL_RE.test(artefactId))) invalid(WAYS.artefactId);
  if (artefactId !== null && !SUBJECT_CLAUSES.includes(body.ruleId)) invalid(WAYS.packLevelOnly(body.ruleId));
  if (!oneLine(body.reason, MAX_REASON)) invalid(WAYS.reason);
  const ms = typeof body.expiresAt === 'string' ? Date.parse(body.expiresAt) : NaN;
  const nowMs = Date.parse(now);
  if (!Number.isFinite(ms) || ms <= nowMs || ms > nowMs + EXPIRY_MAX_DAYS * DAY_MS) invalid(WAYS.expiresAt(body.expiresAt));
  return { ruleId: body.ruleId, artefactId, reason: body.reason, expiresAt: new Date(ms).toISOString() };
}

function parseRevokeBody(body) {
  const reason = body.reason === undefined || body.reason === null || body.reason === '' ? null : body.reason;
  if (reason !== null && !oneLine(reason, MAX_REASON)) invalid(WAYS.revokeReason);
  return { reason };
}

// ---------- the views ----------

// The repository's row with its computed state (tools/lib/waivers.mjs
// waiverView), in the engine's key order, the org never echoed.
export function waiverViewOf(row, now) {
  const { id, artefactId, ruleId, reason, expiresAt, author, createdAt, revokedAt, revokedBy, revokeReason } = row;
  return { ...waiverView({ id, artefactId, ruleId, reason, expiresAt, author, createdAt, revokedAt, revokedBy, revokeReason }, now), serviceId: row.serviceId };
}

// GET /api/services/:id/waivers: newest first, history included (a revoked
// row stays, state `revoked`), with the counts by state.
export function listWaiverViews(db, service, now) {
  const waivers = listWaivers(db, service.id).map((row) => waiverViewOf(row, now));
  const counts = { active: 0, expired: 0, revoked: 0 };
  for (const w of waivers) counts[w.state]++;
  return { ok: true, service: { id: service.id, slug: service.slug }, waivers, counts };
}

const activeOf = (db, serviceId, now) => listWaivers(db, serviceId).map((row) => waiverViewOf(row, now)).filter((w) => w.state === 'active');

// ---------- the rules ----------

// POST /api/services/:id/waivers → the view (201). No such service 404; a
// bad field 400; an active waiver of the same (ruleId, artefactId) on the
// service 409 naming it. Audit waiver.create (the repository's).
export function createWaiverFromApi(db, actor, serviceId, body, { now = new Date().toISOString() } = {}) {
  return atomic(db, () => {
    const service = getService(db, serviceId);
    if (!service) missing(WAYS.noService(serviceId));
    const fields = parseWaiverBody(body, { now });
    const twin = activeOf(db, service.id, now).find((w) => w.ruleId === fields.ruleId && w.artefactId === fields.artefactId);
    if (twin) refuse(WAYS.duplicate(twin));
    return waiverViewOf(createWaiver(db, actor, { serviceId: service.id, ...fields }), now);
  });
}

// POST /api/waivers/:id/revoke → the view, state `revoked`. No such waiver
// 404; revoked already 409 (the row is history; nothing is written twice).
// Audit waiver.revoke.
export function revokeWaiverFromApi(db, actor, id, body, { now = new Date().toISOString() } = {}) {
  return atomic(db, () => {
    const current = getWaiver(db, id);
    if (!current) missing(WAYS.noWaiver(id));
    if (current.revokedAt) refuse(WAYS.revoked(current));
    const { reason } = parseRevokeBody(body);
    return waiverViewOf(revokeWaiver(db, actor, id, { reason }), now);
  });
}

// ---------- the conformance report's overlay ----------

// The `/conformance` body's hook (server/index.mjs conformanceReportFor):
// the service's waivers applied to the engine's report over the graded
// canonical. With no open waiver the SAME report comes back — the inert
// proof; else the overlay names the service in its `waivers` block.
export function conformanceWaivers(db, service, report, canonical, { now = new Date().toISOString() } = {}) {
  const waivers = listWaivers(db, service.id);
  const applied = applyWaiversToConformance(report, waivers, { now, canonical });
  if (applied === report) return report;
  return { ...applied, waivers: { service: { id: service.id, slug: service.slug }, ...applied.waivers } };
}
