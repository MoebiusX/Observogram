// ============================================================
// repo-pack.mjs — the ObservabilityPack a repository keeps about itself.
//
// A service's repository is its home (a service is its repository plus a
// live target per environment), so what code cannot say — the chaos
// experiments a team runs, the alerts each should fire, the newest run of
// each (spec 1.5 `last_result`) — is declared there, in a hand-written pack
// under `.observability/` (`.observability/pack.yaml`, or any
// `.observability/*.yaml` whose document is `kind: ObservabilityPack`).
//
// The scan (crawler.mjs) reads it as the `observability-pack` artefact kind
// and merges `spec.validation.chaos_experiments` into the pack it drafts, by
// id: the declared entry wins over the one discovered with the same id (a
// person correcting an inference), any other is added. The file may be
// partial: each entry is checked alone against the spec 1.5 experiment
// (chaos-detect.mjs, chaosExperimentErrors), and one that fails is left out
// with a warning naming the file and the reason — never a failed scan.
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

/**
 * The chaos experiments one `.observability/` file declares:
 * `{ chaos: [{ entry, source }], refused: [{ id, reason }] }`, or null when
 * the file holds no ObservabilityPack document. `source` is the evidence
 * path, `<file>#spec.validation.chaos_experiments.<id>`.
 */
export function readRepoPack(relPath, content) {
  const docs = repoPackDocuments(content);
  if (!docs.length) return null;
  const chaos = [];
  const refused = [];
  for (const doc of docs) {
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
  return { chaos, refused };
}
