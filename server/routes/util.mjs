// server/routes/util.mjs — what the JSON routers over the store's rules
// share (server/routes/identity.mjs since STORE_PLAN slice 3b,
// server/routes/services.mjs since slice 4): the handler that hands a
// route the store, the principal and its audit actor and answers a rule's
// refusal by its kind — invalid 400, missing 404, conflict 409 — and a
// repository's own TypeError ('observogram store: …') as bad input, 400;
// the JSON object body; the integer id a path parameter holds. Nothing
// here answers 403: that is the guard's (authorize(), server/authz.mjs),
// and means an authorization denial only. Anything else a handler throws
// is a bug and goes on to Express (500).

import { AdminRefusal } from '../identity-admin.mjs';
import { currentStore } from '../store/db.mjs';

const STATUS = Object.freeze({ invalid: 400, missing: 404, conflict: 409 });
const PATH_ID = /^[1-9][0-9]{0,15}$/;

// A rule's refusal, or a repository's TypeError, answered; anything else
// is a bug and goes on to Express (500).
export function refused(res, e) {
  if (e instanceof AdminRefusal) return res.status(STATUS[e.kind]).json({ ok: false, error: e.message });
  if (e instanceof TypeError && e.message.startsWith('observogram store: ')) return res.status(400).json({ ok: false, error: e.message });
  throw e;
}

// The handler, with the store, the principal and its audit actor. Each is
// synchronous around its rule — no await between reading a row and the
// atomic() that changes it.
export const handler = (fn) => function ruleHandler(req, res) {
  const principal = req.observogramPrincipal;
  try {
    return fn(req, res, { db: currentStore(), principal, actor: principal.actor });
  } catch (e) {
    return refused(res, e);
  }
};

// A JSON object body, else {} (each rule refuses what is then missing).
export const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// The row id a path parameter holds, bound as a number — or null, the 400
// sent, naming the kind of row ('user', 'service', 'environment', 'MCP
// endpoint'). A 16-digit id past 2^53 - 1 is refused too, and the text
// says why: as a number it would round, and a refusal would name an id the
// caller never sent.
export function pathId(req, res, param, kind = 'user') {
  const id = req.params[param];
  const n = PATH_ID.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) {
    res.status(400).json({ ok: false, error: `${kind} id must be a positive integer, at most 9007199254740991` });
    return null;
  }
  return n;
}
