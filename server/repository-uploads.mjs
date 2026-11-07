// server/repository-uploads.mjs — a service's repository uploaded from the
// person's own machine (Overview's Upload): the files their browser read
// from a folder or a .zip, kept as the service's copy so that each Run scans
// it again and checks it against live. The person's own access got them the
// files, so no server-held token reads anything (docs: README, A service's
// Run). One copy per service, in the request's org's part of the workspace
// (<org root>/repository-uploads/<service id>.json); a new upload replaces
// it, and a service deleted or pointed elsewhere takes it with it.
//
// The record's repository says where the copy came from and when:
// { kind: 'upload', location: <the folder's or the .zip's name>, ref: null,
//   uploadedAt, files, bytes }. It is set by PUT /api/services/:id/repository-upload
// only — POST and PATCH refuse to name an upload (service-admin.mjs).

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { safeEntryPath } from '../tools/lib/unzip.mjs';
import { scanRefusal } from '../tools/lib/crawler.mjs';
import { AdminRefusal } from './identity-admin.mjs';
import { updateService, getService } from './store/services.mjs';
import { WAYS } from './service-admin.mjs';
import { orgWorkspaceRoot } from './tenancy.mjs';

// The /api/crawl caps (16 MiB of text, a scan's 5 MiB file), and a count
// a repository's scanned files stay far under.
export const UPLOAD_LIMITS = Object.freeze({ files: 20000, fileBytes: 5 * 1024 * 1024, totalBytes: 16 * 1024 * 1024, name: 200, path: 500, skipped: 500, why: 200 });
const UPLOAD_FORMAT = 1;

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

export const UPLOAD_WAYS = Object.freeze({
  body: 'expected { name, files: { <path inside the folder>: <text> } } — the folder\'s or the .zip\'s name and the files a scan reads',
  name: 'name the upload: the folder\'s or the .zip\'s name, one line of 1–200 characters',
  none: 'the upload holds no file: pick a folder or a .zip with the files a scan reads (Prometheus rules, collector configs, dashboards, compose files, Helm values, metrics code)',
  tooMany: `the upload holds more than ${UPLOAD_LIMITS.files} files: upload only the folder the scan needs`,
  path: (p) => `${JSON.stringify(String(p).slice(0, 120))} is not a path inside the uploaded folder (relative, with no .. and at most ${UPLOAD_LIMITS.path} characters)`,
  text: (p) => `${JSON.stringify(String(p).slice(0, 120))} is not text: an upload carries each file's text`,
  fileTooBig: (p) => `${JSON.stringify(String(p).slice(0, 120))} is larger than ${mb(UPLOAD_LIMITS.fileBytes)}, which a scan does not read`,
  tooBig: (n) => `the upload is ${mb(n)}; at most ${mb(UPLOAD_LIMITS.totalBytes)} of the files a scan reads — leave out build output and vendored code`,
  gone: (name) => `the upload ${JSON.stringify(name)} is no longer on the server — upload the folder or the .zip again`,
});

const invalid = (message) => { throw new AdminRefusal(message, 'invalid'); };
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

// What the person's browser did not read (studio/repository-files.mjs:
// git ignores it, a secrets file, too large, not text): kept with the copy
// so each Run names it. Bounded; an entry that is not { path, why } strings
// is dropped.
function skippedOf(list) {
  if (!Array.isArray(list)) return [];
  return list.slice(0, UPLOAD_LIMITS.skipped)
    .filter((x) => isPlainObject(x) && typeof x.path === 'string' && x.path && typeof x.why === 'string')
    .map((x) => ({ path: x.path.slice(0, UPLOAD_LIMITS.path), why: x.why.slice(0, UPLOAD_LIMITS.why) }));
}

// The body of an upload → { name, files, bytes, skipped } (files a
// null-prototype map), or the AdminRefusal. `skipped` is what the browser
// named as not read, and any secrets file in the body (the crawler's rule,
// scanRefusal): never kept, named instead.
export function parseUpload(body) {
  if (!isPlainObject(body) || !isPlainObject(body.files)) invalid(UPLOAD_WAYS.body);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name || name.length > UPLOAD_LIMITS.name || /[\r\n\0]/.test(name)) invalid(UPLOAD_WAYS.name);
  const keys = Object.keys(body.files);
  if (!keys.length) invalid(UPLOAD_WAYS.none);
  if (keys.length > UPLOAD_LIMITS.files) invalid(UPLOAD_WAYS.tooMany);
  const files = Object.create(null);
  const skipped = skippedOf(body.skipped);
  let total = 0;
  for (const key of keys) {
    if (key.length > UPLOAD_LIMITS.path || safeEntryPath(key) !== key) invalid(UPLOAD_WAYS.path(key));
    const text = body.files[key];
    if (typeof text !== 'string') invalid(UPLOAD_WAYS.text(key));
    if (text.length > UPLOAD_LIMITS.fileBytes) invalid(UPLOAD_WAYS.fileTooBig(key));
    const why = scanRefusal(key);
    if (why) { skipped.push({ path: key, why }); continue; }
    total += text.length;
    files[key] = text;
  }
  if (total > UPLOAD_LIMITS.totalBytes) invalid(UPLOAD_WAYS.tooBig(total));
  if (!Object.keys(files).length) invalid(UPLOAD_WAYS.none);
  return { name, files, bytes: total, skipped };
}

export const uploadPathOf = (serviceId) => join(orgWorkspaceRoot(), 'repository-uploads', `${Number(serviceId)}.json`);

// Writes the copy (whole, then renamed into place) → the record's
// repository for it.
export function saveUpload(serviceId, { name, files, bytes, skipped = [] }, { now = new Date() } = {}) {
  const path = uploadPathOf(serviceId);
  mkdirSync(dirname(path), { recursive: true });
  const uploadedAt = now.toISOString();
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ format: UPLOAD_FORMAT, name, uploadedAt, files, skipped }));
  renameSync(tmp, path);
  return { kind: 'upload', location: name, ref: null, uploadedAt, files: Object.keys(files).length, bytes };
}

// The copy → { name, uploadedAt, files, skipped }, or null when there is
// none (a copy kept before `skipped` was: []).
export function readUpload(serviceId) {
  let text;
  try { text = readFileSync(uploadPathOf(serviceId), 'utf8'); }
  catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const doc = JSON.parse(text);
  if (doc?.format !== UPLOAD_FORMAT || !isPlainObject(doc.files)) throw new Error(`the upload of service ${serviceId} is not a format ${UPLOAD_FORMAT} copy`);
  return { name: doc.name, uploadedAt: doc.uploadedAt, files: doc.files, skipped: skippedOf(doc.skipped) };
}

export function deleteUpload(serviceId) {
  rmSync(uploadPathOf(serviceId), { force: true });
}

// The record points at its new copy (one service.update row, as a PATCH of
// the repository writes) → { service, changed }.
export function setUploadedRepository(db, actor, serviceId, repository) {
  const current = getService(db, serviceId);
  if (!current) throw new AdminRefusal(WAYS.noService(serviceId), 'missing');
  const service = updateService(db, actor, serviceId, { repository });
  return { service, changed: ['repository'] };
}
