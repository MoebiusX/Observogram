// server/audit-admin.mjs — the rule of the audit reader (docs/STORE_PLAN.md
// §5, slice 5, design §5): who sees which rows, and what a query may ask.
// A sibling of identity-admin.mjs and service-admin.mjs: pure over the
// query object and the principal's two facts, so GET /api/audit
// (server/routes/audit.mjs) and a CLI reader are two callers of one rule.
//
// Scope — the one authorization the route adds over the guard's `admin`:
//   an org admin reads the rows with its org's id (scope=org, the only
//   scope it may ask for — never a deployment row, org_id NULL, never
//   another org's); an owner reads the deployment's (scope=all, the
//   default for an owner: every org's and the deployment's in one
//   sequence), the context org's (scope=org — the org selector,
//   X-Observogram-Org / ?org=, picks it as everywhere; ?org= is never a
//   filter here) or the rows with no org (scope=deployment).
//
// Filters map one to one onto the audit repository's (listAudit): actor,
// action, kind (every action `<kind>.*`), targetKind, targetId, since /
// until (a date or a UTC time, normalised to the `at` column's form),
// limit (1–500, default 100 — under the repository's clamp of 1000 so
// `limit + 1` always fits and `next: null` means no more) and before (the
// `next` of the previous page). Unknown parameters are ignored; an empty
// value is "not given". Every refusal is an AdminRefusal of kind
// `invalid` (400) whose text names a way out. The two callers are two
// surfaces of one rule (as identity-admin.mjs's): `api` spells a parameter
// as the query string does (`targetKind must be …`), `cli` as the flag of
// `packc store audit` (`--target-kind must be …`, tools/store-admin.mjs);
// the rule, the shapes and the limits are the same.
//
// No field-level redaction: the scoping is the redaction (design §5.7) —
// every org row is its admins' as it is, including the actor of an owner
// who acted in the org without being a member (a stated disclosure);
// every row naming a path, an issuer or a deployment user is a deployment
// row, owners only. auditView() is the one place a redaction would go.
// This module holds no SQL (server/test-store-guards.mjs keeps it so).

import { AdminRefusal } from './identity-admin.mjs';

export const SCOPES = Object.freeze(['org', 'deployment', 'all']);
export const LIMIT_DEFAULT = 100;
export const LIMIT_MAX = 500;

const ACTION = /^[a-z]+(?:_[a-z]+)*(?:[.-][a-z]+(?:_[a-z]+)*)+$/;   // the route table's own rule
const KIND = /^[a-z]+(?:_[a-z]+)*$/;
const TIME = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z)?$/;
const INTEGER = /^(?:0|[1-9][0-9]*)$/;

// How each surface spells a parameter in a refusal: the query string's
// name, or the CLI's flag (`--target` is targetId: the flag takes the id).
export const CLI_FLAGS = Object.freeze({
  actor: '--actor', action: '--action', kind: '--kind', targetKind: '--target-kind', targetId: '--target',
  since: '--since', until: '--until', limit: '--limit', before: '--before',
});
const SPELL = Object.freeze({ api: (name) => name, cli: (name) => CLI_FLAGS[name] ?? name });

const waysFor = (n) => Object.freeze({
  scope: 'scope is org, deployment or all',
  ownersOnly: (org) => `the deployment's audit (scope=deployment, scope=all) is an owner's: as an admin of org '${org}' you read its rows (scope=org, the default) — drop scope, or ask an owner`,
  limit: `${n('limit')} must be an integer from 1 to ${LIMIT_MAX}`,
  before: `${n('before')} must be a positive integer — the next value of the previous page`,
  time: (name) => `${n(name)} must be a date or a UTC time: 2026-10-04 or 2026-10-04T09:00:00Z`,
  order: `${n('since')} must be before ${n('until')}`,
  action: `${n('action')} must be <kind>.<verb>, lower case, e.g. deploy.run or mcp_endpoint.create`,
  kind: `${n('kind')} must be a lower-case word, e.g. deploy, pack or mcp_endpoint`,
  text: (name, max) => `${n(name)} must be 1–${max} characters`,
});
// The API's texts (the route's 400s); the CLI's are the same with the flags.
export const WAYS = waysFor(SPELL.api);
const WAYS_BY_SURFACE = Object.freeze({ api: WAYS, cli: waysFor(SPELL.cli) });

const invalid = (text) => { throw new AdminRefusal(text, 'invalid'); };

function waysOf(surface) {
  if (!Object.hasOwn(WAYS_BY_SURFACE, surface)) throw new TypeError(`a surface is api or cli, not ${JSON.stringify(surface)}`);
  return WAYS_BY_SURFACE[surface];
}

// The value of one parameter: undefined when absent or empty; otherwise
// the string, or the raw value (an array from a repeated parameter) for the
// check to refuse.
function given(query, name) {
  const v = query?.[name];
  if (v === undefined || v === null || v === '') return undefined;
  return v;
}

// A free-text equality filter, 1–max characters.
function text(query, name, max, ways) {
  const v = given(query, name);
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || v.length > max) invalid(ways.text(name, max));
  return v;
}

// A date (midnight UTC) or a UTC time, as the `at` column spells it
// (toISOString), so the repository's text compare is a time compare.
function time(query, name, ways) {
  const v = given(query, name);
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !TIME.test(v)) invalid(ways.time(name));
  const d = new Date(v.length === 10 ? `${v}T00:00:00.000Z` : v);
  const iso = Number.isNaN(d.getTime()) ? null : d.toISOString();
  if (iso === null || iso.slice(0, 10) !== v.slice(0, 10)) invalid(ways.time(name));   // 2026-02-30 is no date
  return iso;
}

// The query of one listing, checked: { scope, org, filters, limit } —
// `org` the context org for scope=org, null otherwise (echoed by the
// response so a client never guesses); `filters` what listAudit takes.
//   query: the request's query object (string values; a repeated parameter
//          is refused by that parameter's text)
//   owner: the principal is an owner (`local` in the open postures too)
//   org:   the context org the org middleware resolved
//   surface: `api` (the default; the query string's names in a refusal) or
//          `cli` (`packc store audit`'s flags) — one rule, two spellings
export function parseAuditQuery(query, { owner, org, surface = 'api' }) {
  const WAYS = waysOf(surface);
  const asked = given(query, 'scope');
  if (asked !== undefined && !SCOPES.includes(asked)) invalid(WAYS.scope);
  const scope = asked ?? (owner ? 'all' : 'org');
  if (!owner && scope !== 'org') invalid(WAYS.ownersOnly(org));

  const rawLimit = given(query, 'limit');
  let limit = LIMIT_DEFAULT;
  if (rawLimit !== undefined) {
    if (typeof rawLimit !== 'string' || !INTEGER.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > LIMIT_MAX) invalid(WAYS.limit);
    limit = Number(rawLimit);
  }
  const rawBefore = given(query, 'before');
  let beforeSeq;
  if (rawBefore !== undefined) {
    if (typeof rawBefore !== 'string' || !INTEGER.test(rawBefore) || Number(rawBefore) < 1 || !Number.isSafeInteger(Number(rawBefore))) invalid(WAYS.before);
    beforeSeq = Number(rawBefore);
  }
  const since = time(query, 'since', WAYS);
  const until = time(query, 'until', WAYS);
  if (since !== undefined && until !== undefined && since >= until) invalid(WAYS.order);
  const action = given(query, 'action');
  if (action !== undefined && (typeof action !== 'string' || !ACTION.test(action))) invalid(WAYS.action);
  const kind = given(query, 'kind');
  if (kind !== undefined && (typeof kind !== 'string' || !KIND.test(kind))) invalid(WAYS.kind);
  const actor = text(query, 'actor', 200, WAYS);
  const targetKind = text(query, 'targetKind', 100, WAYS);
  const targetId = text(query, 'targetId', 200, WAYS);

  const filters = { actor, action, kind, targetKind, targetId, since, until, beforeSeq };
  if (scope === 'org') filters.orgId = org;
  else if (scope === 'deployment') filters.orgId = null;
  for (const k of Object.keys(filters)) if (filters[k] === undefined) delete filters[k];
  return { scope, org: scope === 'org' ? org : null, filters, limit };
}

// A row as the API serves it: the eight named fields of the repository's
// rowToAudit, nothing else. The one place to redact a field, should one
// ever need it (none does: design §5.7).
export function auditView(row) {
  return {
    seq: row.seq, at: row.at, orgId: row.orgId, actor: row.actor, action: row.action,
    targetKind: row.targetKind, targetId: row.targetId, detail: row.detail,
  };
}
