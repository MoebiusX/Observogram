// tools/lib/brand-env.mjs
//
// Rebrand shim (Tomograph → Observogram, 2026-07). Every runtime knob is
// spelled OBSERVOGRAM_*, but the legacy TOMOGRAPH_* spelling from pre-0.5
// deployments keeps working — the new name wins when both are set. Shared
// by server/ and tools/ so the fallback rule lives in exactly one place.
//
// Remove the TOMOGRAPH_* fallback after one deprecation cycle (target: 0.6).

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

// brandEnvFrom(env, 'SESSION_SECRET') → env.OBSERVOGRAM_SESSION_SECRET,
// falling back to env.TOMOGRAPH_SESSION_SECRET. Returns '' when neither is
// set (matching the `(env[k] || '').trim()` idiom the call sites already
// used). The env is a parameter so a loader can be tested against a plain
// object without mutating process.env (tools/mcp-transport.mjs).
export function brandEnvFrom(env, suffix) {
  const modern = env?.[`OBSERVOGRAM_${suffix}`];
  if (modern !== undefined && String(modern).trim() !== '') return String(modern).trim();
  const legacy = env?.[`TOMOGRAPH_${suffix}`];
  return legacy === undefined ? '' : String(legacy).trim();
}

// brandEnv(suffix) — the same rule against process.env.
export function brandEnv(suffix) {
  return brandEnvFrom(process.env, suffix);
}

// The deployment-level workspace root (packs, users.json, orgs.json…).
// Precedence: env override → an existing .observogram/ → an existing
// .tomograph/ (pre-rebrand workspaces keep their data without any
// migration step) → fresh default .observogram/.
export function baseWorkspacePath() {
  const fromEnv = brandEnv('WORKSPACE');
  if (fromEnv) return resolve(fromEnv);
  if (existsSync('.observogram')) return resolve('.observogram');
  if (existsSync('.tomograph')) return resolve('.tomograph');
  return resolve('.observogram');
}

// ---------- the brand (tools/lib/brand.mjs) ----------
//
// loadBrand({ env }) → the normalized brand the server and the CLIs read:
// the JSON file OBSERVOGRAM_BRAND_FILE names (relative to the working
// directory), then the scalar overrides OBSERVOGRAM_BRAND_NAME /
// _SHORT_NAME / _TAGLINE / _LOGO_URL / _DOCS_URL / _FOOTER / _ACCENT /
// _ACCENT_DARK on top (TOMOGRAPH_* honoured through brandEnvFrom). Nothing
// set ⇒ normalizeBrand({}) ⇒ configured:false, today's strings. An
// unreadable or invalid file throws `brand file <path>: <reason>` — the
// server refuses to start on it; the reason never carries the file's
// contents. The env is a parameter so a suite stays hermetic against the
// developer's shell; with the default (process.env) the answer is cached
// for the process (resetBrandCache() for tests).

import { readFileSync } from 'node:fs';
import { normalizeBrand } from './brand.mjs';

export const BRAND_ENV = Object.freeze([
  'BRAND_FILE', 'BRAND_NAME', 'BRAND_SHORT_NAME', 'BRAND_TAGLINE', 'BRAND_LOGO_URL', 'BRAND_DOCS_URL', 'BRAND_FOOTER',
  'BRAND_ACCENT', 'BRAND_ACCENT_DARK',
]);

let cached = null;

export function resetBrandCache() { cached = null; }

/** Where the brand comes from: the file's path, 'env' for scalars alone, null when unconfigured. */
export function brandSource(env = process.env) {
  const file = brandEnvFrom(env, 'BRAND_FILE');
  if (file) return resolve(file);
  return BRAND_ENV.some((k) => brandEnvFrom(env, k)) ? 'env' : null;
}

function readBrandFile(path) {
  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (e) { throw new Error(`brand file ${path}: ${e.code === 'ENOENT' ? 'not found' : e.code === 'EISDIR' ? 'is a directory' : 'unreadable'}`, { cause: e }); }
  let raw;
  // The parse error's message quotes the text; the cause keeps it off the message.
  try { raw = JSON.parse(text); }
  catch (e) { throw new Error(`brand file ${path}: not valid JSON`, { cause: e }); }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`brand file ${path}: not a JSON object`);
  return raw;
}

export function loadBrand({ env = process.env } = {}) {
  const useCache = env === process.env;
  if (useCache && cached) return cached;
  const file = brandEnvFrom(env, 'BRAND_FILE');
  const raw = file ? readBrandFile(resolve(file)) : {};
  const set = (path, value) => {
    if (!value) return;
    let o = raw;
    for (const k of path.slice(0, -1)) {
      if (o[k] === null || typeof o[k] !== 'object' || Array.isArray(o[k])) o[k] = {};
      o = o[k];
    }
    o[path[path.length - 1]] = value;
  };
  set(['name'], brandEnvFrom(env, 'BRAND_NAME'));
  set(['shortName'], brandEnvFrom(env, 'BRAND_SHORT_NAME'));
  set(['tagline'], brandEnvFrom(env, 'BRAND_TAGLINE'));
  set(['logo', 'url'], brandEnvFrom(env, 'BRAND_LOGO_URL'));
  set(['docsUrl'], brandEnvFrom(env, 'BRAND_DOCS_URL'));
  set(['footer', 'text'], brandEnvFrom(env, 'BRAND_FOOTER'));
  set(['tokens', 'light', 'accent'], brandEnvFrom(env, 'BRAND_ACCENT'));
  set(['tokens', 'dark', 'accent'], brandEnvFrom(env, 'BRAND_ACCENT_DARK'));
  const brand = normalizeBrand(raw);
  if (useCache) cached = brand;
  return brand;
}
