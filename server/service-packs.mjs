// server/service-packs.mjs — a pack file uploaded in place of either side of
// a service's check (Overview's Pack file answers): an export of the
// declared pack standing in for the repository, or an export of live
// standing in for an environment's MCP endpoint. The person's browser reads
// the file and sends its text; the server reads it as the studio's Upload
// does (YAML or JSON, a pre-v1.2 layered pack upconverted), validates it
// against the spec's schema and registers it as a pack, so each Run uses it
// as it is — no scan, no MCP call — until it is uploaded again.
//
// The repository's record: { kind: 'pack', location: <the file's name>,
//   ref: null, packId, uploadedAt, bytes } — set here only (POST and PATCH
//   refuse to name one, service-admin.mjs).
// An environment's live export, kept on the service (its livePacks, beside
//   the record): { packId, name, uploadedAt, bytes } by environment name;
//   the environment's MCP endpoint is unbound while it has one.

import { AdminRefusal } from './identity-admin.mjs';

export const PACK_UPLOAD_LIMITS = Object.freeze({ name: 200, bytes: 16 * 1024 * 1024 });

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

export const PACK_UPLOAD_WAYS = Object.freeze({
  body: 'expected { name, text } — the pack file\'s name and its text (YAML or JSON)',
  name: 'name the pack file: one line of 1–200 characters',
  empty: 'the pack file is empty',
  tooBig: (n) => `the pack file is ${mb(n)}; at most ${mb(PACK_UPLOAD_LIMITS.bytes)}`,
  unreadable: (why) => `the pack file could not be read as YAML or JSON: ${why}`,
  invalid: (first, n) => `the pack file is not a valid pack: ${first}${n > 1 ? ` (and ${n - 1} more)` : ''}`,
  gone: (name) => `the pack ${JSON.stringify(name)} is no longer on the server — upload the pack file again`,
});

const invalid = (message) => { throw new AdminRefusal(message, 'invalid'); };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// The body of a pack upload → { name, canonical, bytes }, or the AdminRefusal
// (400). `read(text)` → the pack object (the server's YAML parser),
// `upconvert(pack)` → the canonical form of a pre-v1.2 one (or the pack),
// `validate(canonical)` → the schema's errors ([] for none): the server's own,
// injected, so this module imports none of them.
export function parsePackUpload(body, { read, upconvert = (p) => p, validate }) {
  if (!isPlainObject(body) || typeof body.text !== 'string') invalid(PACK_UPLOAD_WAYS.body);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > PACK_UPLOAD_LIMITS.name || /[\r\n]/.test(name)) invalid(PACK_UPLOAD_WAYS.name);
  const bytes = Buffer.byteLength(body.text, 'utf8');
  if (bytes > PACK_UPLOAD_LIMITS.bytes) invalid(PACK_UPLOAD_WAYS.tooBig(bytes));
  if (!body.text.trim()) invalid(PACK_UPLOAD_WAYS.empty);
  let pack;
  try { pack = read(body.text); } catch (e) { invalid(PACK_UPLOAD_WAYS.unreadable(String(e?.message || e).split('\n')[0].slice(0, 200))); }
  if (!isPlainObject(pack)) invalid(PACK_UPLOAD_WAYS.unreadable('it is not a mapping'));
  const canonical = upconvert(pack);
  const errors = validate(canonical);
  if (Array.isArray(errors) && errors.length) invalid(PACK_UPLOAD_WAYS.invalid(String(errors[0]).slice(0, 300), errors.length));
  return { name, canonical, bytes };
}

// The record a pack file makes, now: the repository's, or an environment's live export.
export const repositoryPackRecord = ({ name, packId, bytes }, at = new Date().toISOString()) => ({ kind: 'pack', location: name, ref: null, packId, uploadedAt: at, bytes });
export const livePackRecord = ({ name, packId, bytes }, at = new Date().toISOString()) => ({ packId, name, uploadedAt: at, bytes });
