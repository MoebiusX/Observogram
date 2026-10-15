// server/taxonomy.mjs — the artefact taxonomy override (OBSERVOGRAM_TAXONOMY).
//
// A downstream whose packs carry typed artefacts (`type: PackSLI |
// PrometheusRule | …`) with foreign id schemes points the server at a JSON
// file mapping those names and id patterns onto Observogram's families
// (tools/lib/artefact-classify.mjs, "The taxonomy override"). start() reads
// it once, before the store boots: the compiled override is installed
// process-wide (configureTaxonomy) so the diff, the traceability graph and
// the blast radius classify by it server-side, and GET /api/taxonomy serves
// the document to the studio, which binds the same module at boot. An
// unreadable or invalid file REFUSES the start — a silently ignored
// override would group every typed pack wrong with no sign of why — with
// `OBSERVOGRAM_TAXONOMY: <path>: <reason>` (the ENOENT text, the JSON
// parse error, or the classifier's `taxonomy: …` reason). The path is
// logged once at start (`[taxonomy] loaded <path>: N types, M id rules`),
// never served: the route answers `configured: true | false`.
//
// Unset (the default): nothing is read, nothing is configured, the route
// answers { ok: true, taxonomy: null, configured: false }.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { brandEnvFrom } from '../tools/lib/brand-env.mjs';
import { compileTaxonomy, validateTaxonomy, configureTaxonomy, describeTaxonomy } from '../tools/lib/artefact-classify.mjs';

export const TAXONOMY_ENV = 'OBSERVOGRAM_TAXONOMY';

/** { taxonomy: object | null, path: string | null } — throws on an unreadable or invalid file. */
export function readTaxonomyConfig(env = process.env) {
  const raw = brandEnvFrom(env, 'TAXONOMY');
  if (!raw) return { taxonomy: null, path: null };
  const path = resolve(raw);
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (e) { throw new Error(`${TAXONOMY_ENV}: ${path}: ${e.message}`, { cause: e }); }
  let json;
  try { json = JSON.parse(text); } catch (e) { throw new Error(`${TAXONOMY_ENV}: ${path}: invalid JSON: ${e.message}`, { cause: e }); }
  const errors = validateTaxonomy(json);
  if (errors.length) throw new Error(`${TAXONOMY_ENV}: ${path}: ${errors[0]}${errors.length > 1 ? ` (+${errors.length - 1} more)` : ''}`);
  return { taxonomy: json, path };
}

let current = { taxonomy: null, path: null };

/** Read the file (if any), install the override process-wide, log the path once. Returns { taxonomy, path }. */
export function loadTaxonomy({ env = process.env, log = () => {} } = {}) {
  current = readTaxonomyConfig(env);
  const compiled = current.taxonomy ? compileTaxonomy(current.taxonomy) : null;
  configureTaxonomy(compiled);
  if (current.path) log(`[taxonomy] loaded ${current.path}: ${describeTaxonomy(compiled)}`);
  return current;
}

/** The GET /api/taxonomy body: the document the studio compiles, never the path. */
export function taxonomyAnswer() {
  return { ok: true, taxonomy: current.taxonomy, configured: current.taxonomy !== null };
}
