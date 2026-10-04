// server/routes/identity.mjs — the identity API (docs/STORE_PLAN.md §5,
// slice 3b): the deployment's users, orgs and join role under /api/admin/*,
// each class `owner` in server/route-table.mjs, whatever org the request is
// in; and the request's own org — its name and its members — under
// /api/org*, class `admin`. No path names an org: the org is the one the
// org middleware resolved (and checked the membership of), so an org admin
// never reaches another org.
//
// Every rule is server/identity-admin.mjs's — the CLIs' own, called with
// `surface: 'api'`, which changes only the way out a refusal names (a route
// instead of a command). This module parses the request, names a user by
// its users.id, projects rows into views (never a password, never a session
// epoch) and answers a refusal by its kind: invalid 400, missing 404,
// conflict 409. A repository's own TypeError ('observogram store: …') is bad
// input too, 400. Nothing here answers 403: that is the guard's
// (authorize(), server/authz.mjs), and means an authorization denial only.
//
// Each handler is synchronous around its rule — no await between reading a
// row and the atomic() that changes it. The audit actor is the principal's
// (the user's login, or `local` on a server without sign-in); the rows each
// route writes are listed in server/route-table.mjs.
//
// What an org admin's refusal reveals stays inside the org (STORE_PLAN §5:
// an admin cannot list the deployment's users): a member route names a
// user by id and answers "not a member" whether or not the id exists, and
// an add that finds no one, a disabled user or several is one 404. An
// owner gets the detailed texts.

import express from 'express';
import { join } from 'node:path';
import { authDisabled, authEnabled, oidcEnabled } from '../auth.mjs';
import { proxyAuthConfig } from '../auth-proxy.mjs';
import { apiTokenLabel } from '../authz.mjs';
import {
  AdminRefusal, addLocalUser, addMember, createOrgFromAdmin, disableUser, enableUser, findMemberCandidate, liveSignInMode,
  parseRole, removeMember, removeOrgSoft, renameOrgFromAdmin, setJoinRole, setLocalPassword, setMemberRole, setOwnerFlag,
  signOutEverywhere,
} from '../identity-admin.mjs';
import { atomic, currentStore } from '../store/db.mjs';
import { defaultOrgId } from '../store/identity.mjs';
import { listMembers, listMembershipsForUser } from '../store/memberships.mjs';
import { getMeta } from '../store/meta.mjs';
import { getOrg, listOrgs } from '../store/orgs.mjs';
import { getUser, listUsersWithMemberships } from '../store/users.mjs';
import { baseWorkspaceRoot } from '../tenancy.mjs';

const STATUS = Object.freeze({ invalid: 400, missing: 404, conflict: 409 });
const USER_ID = /^[1-9][0-9]{0,15}$/;

// A rule's refusal, or a repository's TypeError, answered; anything else
// is a bug and goes on to Express (500).
function refused(res, e) {
  if (e instanceof AdminRefusal) return res.status(STATUS[e.kind]).json({ ok: false, error: e.message });
  if (e instanceof TypeError && e.message.startsWith('observogram store: ')) return res.status(400).json({ ok: false, error: e.message });
  throw e;
}

// The handler, with the store, the principal and its audit actor.
const handler = (fn) => function identityHandler(req, res) {
  const principal = req.observogramPrincipal;
  try {
    return fn(req, res, { db: currentStore(), principal, actor: principal.actor });
  } catch (e) {
    return refused(res, e);
  }
};

// A JSON object body, else {} (each rule refuses what is then missing).
const bodyOf = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

// The users.id a path parameter holds, bound as a number — or null, the
// 400 sent. A 16-digit id past 2^53 - 1 is refused too, and the text says
// why: as a number it would round, and a refusal would name an id the
// caller never sent.
function pathId(req, res, param) {
  const id = req.params[param];
  const n = USER_ID.test(id) ? Number(id) : NaN;
  if (!Number.isSafeInteger(n)) {
    res.status(400).json({ ok: false, error: 'user id must be a positive integer, at most 9007199254740991' });
    return null;
  }
  return n;
}

// The user an owner route's path names — or null, the answer (400 / 404)
// sent. (The member routes never say whether an id exists: pathId only.)
function pathUser(req, res, db) {
  const id = pathId(req, res, 'id');
  if (id === null) return null;
  const row = getUser(db, id);
  if (!row) {
    res.status(404).json({ ok: false, error: `no user ${id}` });
    return null;
  }
  return row;
}

// The user view: named fields only, so a password or a session epoch the
// row carries never leaves.
function userView(u, memberships) {
  return {
    id: u.id, login: u.login, kind: u.kind, name: u.name, email: u.email, emailVerified: u.emailVerified,
    owner: u.isOwner, disabled: u.disabled, mustChange: u.mustChange, seededDefault: u.seededDefault,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt,
    memberships: memberships.map((m) => ({ orgId: m.orgId, role: m.role })),
  };
}
const userViewOf = (db, id) => userView(getUser(db, id), listMembershipsForUser(db, id));

// The caller acted on its own row (its session ends with a disable or a
// sign-out everywhere).
const isCaller = (principal, row) => principal.user?.id === row.id;

// The member view (admin routes): the membership and named fields of its
// user — never a password, a session epoch or the user's other orgs.
function memberView(m, u) {
  return { userId: u.id, login: u.login, kind: u.kind, name: u.name, email: u.email, role: m.role, disabled: u.disabled, since: m.createdAt };
}

// The request's org, as the admin routes show it.
function orgView(db, id) {
  const org = getOrg(db, id);
  return { id: org.id, name: org.name, default: org.id === defaultOrgId(db) };
}

// An owner (and `local` without sign-in) acts as an owner here: the org's
// last admin may be demoted or removed, and a refusal gives the detail.
const byOwnerOf = (principal) => principal.owner === true;

export function identityRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  // ---------- users ----------

  router.get('/api/admin/users', authorize('GET /api/admin/users'), handler((req, res, { db }) => {
    res.json({ ok: true, users: listUsersWithMemberships(db).map((u) => userView(u, u.memberships)) });
  }));

  // A local user. The first local user while no enabled local owner exists
  // is made an owner where local users can sign in (the rule's A-16);
  // `note` says why not, or that local users cannot sign in under OIDC.
  router.post('/api/admin/users', authorize('POST /api/admin/users'), handler((req, res, { db, actor }) => {
    const { login, password, name, email, role, orgId } = bodyOf(req);
    const r = addLocalUser(db, actor, {
      login, password, name: name ?? null, email: email ?? null, role, orgId: orgId ?? null,
      via: 'api', surface: 'api', mode: liveSignInMode(), tokenLabel: apiTokenLabel(),
    });
    const note = r.ownerWithheld
      ?? (r.mode.kind === 'oidc' ? `local users cannot sign in while this server signs in through OIDC issuer ${r.mode.issuerKey}` : null);
    res.status(201).json({ ok: true, user: userViewOf(db, r.user.id), owner: r.owner, joined: r.joined, armed: r.armed, note });
  }));

  router.post('/api/admin/users/:id/disable', authorize('POST /api/admin/users/:id/disable'), handler((req, res, { db, actor, principal }) => {
    const row = pathUser(req, res, db);
    if (!row) return;
    disableUser(db, actor, row.login, { surface: 'api', mode: liveSignInMode() });
    res.json({ ok: true, user: userViewOf(db, row.id), you: isCaller(principal, row) });
  }));

  router.post('/api/admin/users/:id/enable', authorize('POST /api/admin/users/:id/enable'), handler((req, res, { db, actor }) => {
    const row = pathUser(req, res, db);
    if (!row) return;
    enableUser(db, actor, row.login, { surface: 'api' });
    res.json({ ok: true, user: userViewOf(db, row.id) });
  }));

  // A temporary password: changed at the next sign-in, with no skip; every
  // session of the user ends.
  router.post('/api/admin/users/:id/password', authorize('POST /api/admin/users/:id/password'), handler((req, res, { db, actor, principal }) => {
    const row = pathUser(req, res, db);
    if (!row) return;
    setLocalPassword(db, actor, row.login, bodyOf(req).password, { mustChange: true, surface: 'api', callerId: principal.user?.id ?? null });
    res.json({ ok: true, user: userViewOf(db, row.id), mustChange: true });
  }));

  // Sign out everywhere: every cookie of the user stops working at its next request.
  router.post('/api/admin/users/:id/signout', authorize('POST /api/admin/users/:id/signout'), handler((req, res, { db, actor, principal }) => {
    const row = pathUser(req, res, db);
    if (!row) return;
    const { sessionEpoch } = signOutEverywhere(db, actor, row.login, { surface: 'api' });
    res.json({ ok: true, user: userViewOf(db, row.id), sessionEpoch, you: isCaller(principal, row) });
  }));

  // The owner flag, both ways; a revoke touches no membership (`note` says
  // when the user is still the default org's admin).
  router.put('/api/admin/users/:id/owner', authorize('PUT /api/admin/users/:id/owner'), handler((req, res, { db, actor }) => {
    const row = pathUser(req, res, db);
    if (!row) return;
    const r = setOwnerFlag(db, actor, row.login, bodyOf(req).owner, { surface: 'api', mode: liveSignInMode() });
    res.json({ ok: true, user: userViewOf(db, row.id), changed: r.changed, memberships: r.memberships, note: r.note });
  }));

  // ---------- orgs ----------

  router.get('/api/admin/orgs', authorize('GET /api/admin/orgs'), handler((req, res, { db }) => {
    const defaultOrg = defaultOrgId(db);
    const orgs = listOrgs(db, { includeRemoved: true }).map((o) => ({
      id: o.id, name: o.name, root: o.root, default: o.id === defaultOrg, removedAt: o.removedAt, createdAt: o.createdAt,
      members: listMembers(db, o.id).length,
    }));
    res.json({ ok: true, defaultOrg, orgs });
  }));

  // The creator becomes the org's first admin. A server without identity
  // is refused first (the rule's 409): a second org would make its next
  // start refuse.
  router.post('/api/admin/orgs', authorize('POST /api/admin/orgs'), handler((req, res, { db, actor, principal }) => {
    const { id, name, adopt } = bodyOf(req);
    const { adopted, path, ...org } = createOrgFromAdmin(db, actor, {
      id, name: name ?? null, adopt: adopt === true, adminUserId: principal.user?.id ?? null, base: baseWorkspaceRoot(),
      serverIdentity: authEnabled(), authOff: authDisabled(), surface: 'api',
    });
    res.status(201).json({ ok: true, org, adopted, path });
  }));

  // Soft removal: the row and the files stay; the org middleware refuses
  // the org from its members' next request.
  router.delete('/api/admin/orgs/:id', authorize('DELETE /api/admin/orgs/:id'), handler((req, res, { db, actor }) => {
    const org = removeOrgSoft(db, actor, req.params.id, { surface: 'api' });
    res.json({
      ok: true, org,
      note: `its files under ${join(baseWorkspaceRoot(), org.root)} stay; with the server stopped, packc store purge-org ${org.id} deletes them`,
    });
  }));

  // ---------- the join role ----------

  // `mode` is the sign-in mode this server runs (local | oidc | proxy): the
  // recorded join role rules OIDC and local rows only — behind a reverse
  // proxy (server/auth-proxy.mjs) the first-sight role is the env's
  // OBSERVOGRAM_PROXY_AUTH_JOIN_ROLE, or the groups header when configured,
  // and `proxy` says which.
  router.get('/api/admin/join-role', authorize('GET /api/admin/join-role'), handler((req, res, { db }) => {
    const proxy = proxyAuthConfig();
    res.json({
      ok: true, role: getMeta(db, 'oidc_join_role'), oidc: oidcEnabled(), issuerKey: getMeta(db, 'oidc_issuer'),
      mode: oidcEnabled() ? 'oidc' : proxy ? 'proxy' : 'local',
      ...(proxy ? { proxy: { joinRole: proxy.joinRole, groupsConfigured: !!proxy.groupsHeader, org: proxy.org } } : {}),
    });
  }));

  // The role an IdP user gets in the default org when their row is created
  // (it backfills nobody); 'admin' needs "confirm": true.
  router.put('/api/admin/join-role', authorize('PUT /api/admin/join-role'), handler((req, res, { db, actor }) => {
    const { role, confirm } = bodyOf(req);
    const r = setJoinRole(db, actor, role, { confirm });
    res.json({ ok: true, role: r.role, from: r.from });
  }));

  // ---------- the request's org: its name and its members ----------

  router.patch('/api/org', authorize('PATCH /api/org'), handler((req, res, { db, actor }) => {
    const org = renameOrgFromAdmin(db, actor, req.observogramOrg, bodyOf(req).name);
    res.json({ ok: true, org: orgView(db, org.id) });
  }));

  router.get('/api/org/members', authorize('GET /api/org/members'), handler((req, res, { db }) => {
    const orgId = req.observogramOrg;
    res.json({ ok: true, org: orgView(db, orgId), members: listMembers(db, orgId).map((m) => memberView(m, getUser(db, m.userId))) });
  }));

  // An EXISTING user, by exact login or by the one enabled user whose
  // sign-in verified that email — never a new row. An upsert: a member at
  // another role gets that role (the org's last admin is not demoted but by
  // an owner). The role is read first, so a bad one never looks anyone up;
  // the lookup and the change are one transaction.
  router.post('/api/org/members', authorize('POST /api/org/members'), handler((req, res, { db, actor, principal }) => {
    const { login, email, role } = bodyOf(req);
    const byOwner = byOwnerOf(principal);
    parseRole(role);
    const r = atomic(db, () => {
      const user = findMemberCandidate(db, { login, email, detailed: byOwner });
      return addMember(db, actor, { orgId: req.observogramOrg, userId: user.id, role, byOwner });
    });
    const member = memberView(r.membership, r.user);
    if (r.added) return res.status(201).json({ ok: true, member, added: true });
    return res.json({ ok: true, member, added: false, changed: r.changed });
  }));

  router.patch('/api/org/members/:userId', authorize('PATCH /api/org/members/:userId'), handler((req, res, { db, actor, principal }) => {
    const userId = pathId(req, res, 'userId');
    if (userId === null) return;
    const r = setMemberRole(db, actor, { orgId: req.observogramOrg, userId, role: bodyOf(req).role, byOwner: byOwnerOf(principal) });
    res.json({ ok: true, member: memberView(r.membership, r.user), changed: r.changed });
  }));

  router.delete('/api/org/members/:userId', authorize('DELETE /api/org/members/:userId'), handler((req, res, { db, actor, principal }) => {
    const userId = pathId(req, res, 'userId');
    if (userId === null) return;
    const r = removeMember(db, actor, { orgId: req.observogramOrg, userId, byOwner: byOwnerOf(principal) });
    res.json({ ok: true, removed: memberView(r.membership, r.user) });
  }));

  return router;
}
