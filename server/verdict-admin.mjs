// server/verdict-admin.mjs — the rules of a reviewer's verdicts (GAP batch 2,
// B3.1; docs/ADAPTER.md "Verdicts — a reviewer's record per artefact"), a
// sibling of service-admin.mjs: every rule the verdicts API applies lives
// here once, every refusal is an AdminRefusal with a `kind` — 'invalid'
// (bad input), 'missing' (no such pack artefact, no such verdict) or
// 'conflict' (a catalogue pack: nothing to record on) — which the routes
// answer as 400, 404 and 409 (server/routes/util.mjs).
//
// A verdict is `trusted | suspect | failed` with a reason, the actor and the
// time, on ONE artefact — the adapter's positional id (`SLI-01`), frozen
// within a content-hash pack id — of ONE registered pack. `unreviewed` is
// the absence of a row. Nothing here sums verdicts into a score, into
// conformance or into the diagnostic grade: Diagnose's "verdict"
// (studio/verdict-ui.mjs, buildVerdictModel) is the engine's grade; this is
// a reviewer's record, shown beside it.
//
// The artefact index (artefactIndex) walks the adapted pack the way the
// studio's board does — L1, L2, L2X, L3, L4 {policy, alerting, healing}, L5,
// GOV (studio/layers-view.mjs layerEntries, tools/test-golden-board.mjs
// boardEntries) — and gives every artefact its card key (`L1/SLI-01`,
// `L4/alerting/ALR-01`), its behavioural identity key
// (tools/lib/artefact-model.mjs identityKeyOf, `#01..#0n`-suffixed within a
// colliding group in walk order, tools/lib/diff.mjs's rule) and a hash of
// its behavioural contract. The key is how a label re-registration carries
// a verdict onto the new pack's artefact (planVerdictCarry →
// applyVerdictCarry, called by server/pack-registry.mjs inside the
// register's atomic()). The family a view shows is the LIVE classifier's
// (classify follows the server's bound taxonomy); the stored family is
// audit detail only.
//
// No SQL of its own: every read and write goes through server/store/verdicts.mjs.

import { createHash } from 'node:crypto';
import { adapt } from '../tools/lib/adapter.mjs';
import { behaviorOf, classify, identityKeyOf } from '../tools/lib/artefact-model.mjs';
import { AdminRefusal } from './identity-admin.mjs';
import { atomic } from './store/db.mjs';
import { VERDICT_STATUSES, carryVerdicts, clearVerdict, getVerdict, listVerdicts, setVerdict } from './store/verdicts.mjs';

export { VERDICT_STATUSES };

const refuse = (message, kind = 'conflict') => { throw new AdminRefusal(message, kind); };
const invalid = (message) => refuse(message, 'invalid');
const missing = (message) => refuse(message, 'missing');

export const REASON_MAX = 2000;
const ARTEFACT_ID_MAX = 100;
// The adapter's positional id: an upper-case family prefix, a dash, digits
// (`SLI-01`, `METRIC-SRC-12`, `PIP-EXP-MET`).
const ARTEFACT_ID_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;

// The layers and the L4 subgroups, in the walk order of the studio's board
// (studio/constants.mjs LAYER_DEFS and L4_SUBGROUPS — inlined, not
// imported: server code reads no studio module; studio/static-backend.mjs
// inlines the same walk for the bundle's empty document, and
// tools/test-verdict-admin.mjs holds the two to the same count).
export const LAYER_WALK = Object.freeze(['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']);
export const L4_WALK = Object.freeze(['policy', 'alerting', 'healing']);

// The way out each refusal names.
export const WAYS = Object.freeze({
  status: (x) => `status must be one of ${VERDICT_STATUSES.join(', ')} (unreviewed is the absence of a verdict: DELETE it), not ${JSON.stringify(x)}`,
  reason: `reason must be a string of at most ${REASON_MAX} characters`,
  artefactId: `artefact id must be the adapter's positional id (SLI-01, ALR-02 …), 1–${ARTEFACT_ID_MAX} characters`,
  noArtefact: (packId, id) => `no artefact ${id} in pack ${packId} — GET /api/packs/${packId} lists its layers and their ids`,
  notRegistered: (packId) => `pack ${packId} is a catalogue pack: a verdict is recorded on a registered pack — upload it (POST /api/validate) and record the verdict on the registered id`,
  noVerdict: (packId, id) => `no verdict on ${id} in pack ${packId} — GET /api/packs/${packId}/verdicts lists them`,
});

// ---------- the artefact index ----------

export const cardKey = (layerId, sub, id) => (sub ? `${layerId}/${sub}/${id}` : `${layerId}/${id}`);

export function behaviorHashOf(artefact) {
  return createHash('sha256').update(JSON.stringify(behaviorOf(artefact))).digest('hex').slice(0, 16);
}

// Every artefact of an adapted pack in walk order: { artefactId, layer, sub,
// cardKey, key, family, behaviorHash, title }. A duplicate positional id is
// a plain Error (adapt() mints ids positionally, so it is unreachable
// through adapt(); a hand-built pack can reach it).
export function artefactIndex(adapted) {
  const layers = adapted?.layers || {};
  const walk = [];
  for (const layerId of LAYER_WALK) {
    if (layerId === 'L4') {
      for (const sub of L4_WALK) for (const a of (layers.L4?.[sub] || [])) walk.push({ a, layerId, sub });
    } else {
      for (const a of (layers[layerId] || [])) walk.push({ a, layerId, sub: null });
    }
  }
  // The colliding groups, keyed by the bare identity key, in walk order.
  const groups = new Map();
  for (const { a } of walk) {
    const k = identityKeyOf(a);
    groups.set(k, (groups.get(k) || 0) + 1);
  }
  const seen = new Map();
  const ids = new Set();
  const entries = [];
  for (const { a, layerId, sub } of walk) {
    if (ids.has(a.id)) throw new Error(`verdicts: duplicate artefact id ${a.id} in the adapted pack`);
    ids.add(a.id);
    const bare = identityKeyOf(a);
    const n = groups.get(bare);
    const i = (seen.get(bare) || 0) + 1;
    seen.set(bare, i);
    entries.push({
      artefactId: a.id,
      layer: layerId,
      sub,
      cardKey: cardKey(layerId, sub, a.id),
      key: n > 1 ? `${bare}#${String(i).padStart(2, '0')}` : bare,
      family: classify(a),
      behaviorHash: behaviorHashOf(a),
      title: a.title || a.id,
    });
  }
  return entries;
}

const byArtefactId = (index) => new Map(index.map((e) => [e.artefactId, e]));

// ---------- the views ----------

// The view of one row with the live index's entry (family, card key and
// title from the pack as it is; the stored family is audit detail). An
// orphan — a row whose artefact the pack no longer has — is flagged.
export function verdictView(row, entry) {
  return {
    artefact: row.artefactId,
    key: entry ? entry.cardKey : null,
    family: entry ? entry.family : row.family,
    title: entry ? entry.title : null,
    status: row.status,
    reason: row.reason,
    actor: row.actor,
    setAt: row.setAt,
    carriedFrom: row.carriedFrom,
    ...(entry ? {} : { orphaned: true }),
  };
}

// GET /api/packs/:id/verdicts: the rows of a registered pack (a catalogue
// pack has none, by construction — the same empty document the static
// bundle answers), with a summary. `?env=` is ignored: verdicts are per
// pack, the artefact ids positional within it.
export function verdictsDocument(db, { meta, adapted }) {
  const index = artefactIndex(adapted);
  const rows = meta.uploaded ? listVerdicts(db, meta.id) : [];
  const entries = byArtefactId(index);
  const views = rows.map((r) => verdictView(r, entries.get(r.artefactId) || null));
  const count = (status) => views.filter((v) => !v.orphaned && v.status === status).length;
  const orphaned = views.filter((v) => v.orphaned).length;
  return {
    ok: true,
    pack: meta.id,
    verdicts: views,
    summary: {
      artefacts: index.length,
      trusted: count('trusted'),
      suspect: count('suspect'),
      failed: count('failed'),
      unreviewed: index.length - (views.length - orphaned),
      orphaned,
    },
  };
}

// ---------- the rules ----------

function parseBody(body) {
  if (!VERDICT_STATUSES.includes(body.status)) invalid(WAYS.status(body.status));
  const reason = body.reason === undefined || body.reason === null || body.reason === '' ? null : body.reason;
  if (reason !== null && (typeof reason !== 'string' || reason.length > REASON_MAX)) invalid(WAYS.reason);
  return { status: body.status, reason };
}

function requireArtefactId(id) {
  if (typeof id !== 'string' || id.length === 0 || id.length > ARTEFACT_ID_MAX || !ARTEFACT_ID_RE.test(id)) invalid(WAYS.artefactId);
  return id;
}

// PUT /api/packs/:id/verdicts/:artefact → { verdict, changed }. A catalogue
// pack is 409 (nothing to record on), an unknown artefact 404, a bad body
// 400; the same status and reason as the row holds → `changed: []` and no
// row written (no audit row either: nothing changed).
export function setVerdictFromApi(db, actor, { meta, adapted, artefactId, body }) {
  requireArtefactId(artefactId);
  const { status, reason } = parseBody(body);
  if (!meta.uploaded) refuse(WAYS.notRegistered(meta.id));
  const entry = byArtefactId(artefactIndex(adapted)).get(artefactId);
  if (!entry) missing(WAYS.noArtefact(meta.id, artefactId));
  return atomic(db, () => {
    const current = getVerdict(db, meta.id, artefactId);
    const changed = [];
    if (!current || current.status !== status) changed.push('status');
    if ((current?.reason ?? null) !== reason) changed.push('reason');
    if (current && changed.length === 0) return { verdict: verdictView(current, entry), changed: [] };
    const { verdict } = setVerdict(db, actor, {
      packId: meta.id, artefactId, artefactKey: entry.key, family: entry.family, status, reason, behaviorHash: entry.behaviorHash,
    });
    return { verdict: verdictView(verdict, entry), changed };
  });
}

// DELETE /api/packs/:id/verdicts/:artefact → { cleared: VerdictView }. A
// catalogue pack is 409; no verdict on the artefact 404.
export function clearVerdictFromApi(db, actor, { meta, adapted, artefactId }) {
  requireArtefactId(artefactId);
  if (!meta.uploaded) refuse(WAYS.notRegistered(meta.id));
  const entry = byArtefactId(artefactIndex(adapted)).get(artefactId) || null;
  return atomic(db, () => {
    const current = getVerdict(db, meta.id, artefactId);
    if (!current) missing(WAYS.noVerdict(meta.id, artefactId));
    const cleared = clearVerdict(db, actor, meta.id, artefactId);
    return { cleared: verdictView(cleared, entry) };
  });
}

// ---------- the carry (a label re-registration) ----------

// Before the replaced pack's row goes: its verdicts and, when it has any,
// the new pack's artefact index as a Map key → { artefactId, family,
// behaviorHash }. With no rows there is nothing to plan: `map` is null and
// the new canonical is never adapted (a replace with no verdicts costs
// nothing and writes nothing — server/test-services-api.mjs pins the audit
// rows of such a replace).
export function planVerdictCarry(db, { fromPackId, toCanonical }) {
  const rows = listVerdicts(db, fromPackId);
  if (!rows.length) return { fromPackId, rows: [], map: null };
  const map = new Map();
  for (const e of artefactIndex(adapt(toCanonical))) {
    if (!map.has(e.key)) map.set(e.key, { artefactId: e.artefactId, family: e.family, behaviorHash: e.behaviorHash });
  }
  return { fromPackId, rows, map };
}

// After the new pack's row exists: the carry, one verdict.carry row — or
// nothing at all for a plan with no rows.
export function applyVerdictCarry(db, actor, { toPackId, plan }) {
  if (!plan || plan.map === null) return { kept: 0, dropped: [] };
  return carryVerdicts(db, actor, { fromPackId: plan.fromPackId, toPackId, rows: plan.rows, map: plan.map });
}
