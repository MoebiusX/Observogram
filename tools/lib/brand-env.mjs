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
