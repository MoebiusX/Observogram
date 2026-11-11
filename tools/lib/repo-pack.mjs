// ============================================================
// repo-pack.mjs — the ObservabilityPack a repository keeps about itself.
//
// A service's repository is its home (a service is its repository plus a
// live target per environment), so what code cannot say — the chaos
// experiments a team runs, the alerts each should fire, the newest run of
// each (spec 1.5 `last_result`), the MTTD / MTTR targets the team holds
// itself to (`spec.baselines`) — is declared there, in a hand-written pack
// under `.observability/` (`.observability/pack.yaml`, or any
// `.observability/*.yaml` whose document is `kind: ObservabilityPack`).
//
// The scan (crawler.mjs) reads it as the `observability-pack` artefact kind
// and merges `spec.validation.chaos_experiments` into the pack it drafts, by
// id: the declared entry wins over the one discovered with the same id (a
// person correcting an inference), any other is added. `spec.baselines`
// replaces the placeholder targets the scan otherwise writes (nothing in code
// says them). The file may be partial: each entry is checked alone against
// the spec 1.5 experiment (chaos-detect.mjs, chaosExperimentErrors), the
// baselines against the spec's Baselines (baselinesErrors, below), and one
// that fails is left out with a warning naming the file and the reason —
// never a failed scan.
//
// Pure ESM, no Node APIs — browser-safe.
// ============================================================

import { parseAll as parseYamlAll } from './mini-yaml.mjs';
import { chaosExperimentErrors } from './chaos-detect.mjs';

/** Whether `relPath` is where a repository keeps its own pack: `.observability/*.yaml`. */
export function isRepoPackPath(relPath) {
  return /(^|\/)\.observability\/[^/]+\.ya?ml$/i.test(String(relPath ?? '').replace(/\\/g, '/'));
}

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The ObservabilityPack documents in a file's text, or [] (a parse failure is []). */
export function repoPackDocuments(content) {
  let docs;
  try { docs = parseYamlAll(String(content ?? '')); } catch { return []; }
  return docs.filter(d => isObj(d) && d.kind === 'ObservabilityPack');
}

// The spec 1.5 Baselines: two targets required, the rest optional, nothing else.
const DURATION = /^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/;
const BASELINE_DURATIONS = ['mttd_target_p50', 'mttr_target_p50', 'mttd_target_p95', 'mttr_target_p95'];
const BASELINE_ENUMS = {
  review_cadence: ['weekly', 'monthly', 'quarterly'],
  regression_gate: ['warn_only', 'block_release_if_p50_mttd_breaches_target', 'block_release_if_p50_mttr_breaches_target', 'block_release_if_either_breaches_target'],
};

/** Why `b` is not a spec 1.5 `spec.baselines`: a list of reasons, empty when it is one. */
export function baselinesErrors(b) {
  if (!isObj(b)) return ['spec.baselines is not a mapping'];
  const errors = [];
  for (const k of ['mttd_target_p50', 'mttr_target_p50']) if (b[k] === undefined) errors.push(`${k} is required`);
  for (const k of BASELINE_DURATIONS) if (b[k] !== undefined && !(typeof b[k] === 'string' && DURATION.test(b[k]))) errors.push(`${k} is not a duration such as 15m or 1h30m`);
  for (const [k, allowed] of Object.entries(BASELINE_ENUMS)) if (b[k] !== undefined && !allowed.includes(b[k])) errors.push(`${k} is none of ${allowed.join(', ')}`);
  if (b.measurement_source !== undefined && typeof b.measurement_source !== 'string') errors.push('measurement_source is not text');
  const known = new Set([...BASELINE_DURATIONS, ...Object.keys(BASELINE_ENUMS), 'measurement_source']);
  for (const k of Object.keys(b)) if (!known.has(k)) errors.push(`${k} is not a baselines field`);
  return errors;
}

/**
 * What one `.observability/` file declares:
 * `{ chaos: [{ entry, source }], refused: [{ id, reason }], baselines, baselinesRefused }`,
 * or null when the file holds no ObservabilityPack document. `source` is the
 * evidence path, `<file>#spec.validation.chaos_experiments.<id>`.
 * `baselines` is `{ entry, source: '<file>#spec.baselines' }` or null (the
 * later document wins); `baselinesRefused` the reason one was left out, or null.
 */
export function readRepoPack(relPath, content) {
  const docs = repoPackDocuments(content);
  if (!docs.length) return null;
  const chaos = [];
  const refused = [];
  let baselines = null;
  let baselinesRefused = null;
  for (const doc of docs) {
    if (doc.spec?.baselines !== undefined) {
      const errors = baselinesErrors(doc.spec.baselines);
      if (errors.length) baselinesRefused = errors[0];
      else { baselines = { entry: { ...doc.spec.baselines }, source: `${relPath}#spec.baselines` }; baselinesRefused = null; }
    }
    const list = doc.spec?.validation?.chaos_experiments;
    if (list === undefined) continue;
    if (!Array.isArray(list)) { refused.push({ id: null, reason: 'spec.validation.chaos_experiments is not a list' }); continue; }
    list.forEach((entry, i) => {
      const id = isObj(entry) && typeof entry.id === 'string' ? entry.id : null;
      const errors = chaosExperimentErrors(entry);
      if (errors.length) { refused.push({ id: id ?? `#${i + 1}`, reason: errors[0] }); return; }
      chaos.push({ entry, source: `${relPath}#spec.validation.chaos_experiments.${entry.id}` });
    });
  }
  return { chaos, refused, baselines, baselinesRefused };
}
