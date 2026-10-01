// server/library.mjs
//
// The Node side of the BUILD journey engine: reads library/**/*.library.yaml
// from disk, parses and validates each entry with tools/lib/library.mjs (the
// pure, browser-safe engine — nothing under tools/lib touches the filesystem)
// and returns the entries plus the per-file errors. Used by tools/pack-init.mjs
// (packc init) today and by the slice-2 API routes tomorrow.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseLibraryEntry, validateLibraryEntry } from '../tools/lib/library.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The library shipped with the repo. */
export function defaultLibraryRoot() {
  return resolve(ROOT, 'library');
}

const ENTRY_SUFFIX = '.library.yaml';

/** Every *.library.yaml under root, recursively, sorted by path (stable order for listings and tests). */
export function listLibraryFiles(root = defaultLibraryRoot()) {
  const out = [];
  const walk = (dir) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const full = join(dir, name);
      let st;
      try { st = statSync(full); } catch { continue; }
      if (st.isDirectory()) walk(full);
      else if (name.endsWith(ENTRY_SUFFIX)) out.push(full);
    }
  };
  walk(root);
  return out;
}

/**
 * loadLibrary({ root }) → { root, entries, errors }
 *   entries  the entries that parsed AND validated, each with `__file` (path relative to root)
 *   errors   [{ file, errors: [string] }] for the files that did not (a parse error is one error string);
 *            a root that is not a directory is one error on the root itself (file = root), never an empty library
 * A duplicate entry id across files is an error on the later file, which is dropped.
 */
export function loadLibrary({ root = defaultLibraryRoot() } = {}) {
  const entries = [];
  const errors = [];
  const seen = new Map();
  // An install without library/ (or a wrong --library) must say why every --entry is unknown.
  let rootStat = null;
  try { rootStat = statSync(root); } catch { /* reported below */ }
  if (!rootStat || !rootStat.isDirectory()) return { root, entries, errors: [{ file: root, errors: [`library root not found: ${root} (the package ships library/ beside server/ and tools/; --library <dir> selects another)`] }] };
  for (const file of listLibraryFiles(root)) {
    const rel = relative(root, file).replace(/\\/g, '/');
    let entry;
    try { entry = parseLibraryEntry(readFileSync(file, 'utf8')); }
    catch (e) { errors.push({ file: rel, errors: [`parse: ${e.message}`] }); continue; }
    const errs = validateLibraryEntry(entry);
    if (errs.length) { errors.push({ file: rel, errors: errs }); continue; }
    if (seen.has(entry.id)) { errors.push({ file: rel, errors: [`duplicate entry id '${entry.id}' (also in ${seen.get(entry.id)})`] }); continue; }
    seen.set(entry.id, rel);
    Object.defineProperty(entry, '__file', { value: rel, enumerable: false });
    entries.push(entry);
  }
  return { root, entries, errors };
}

/** One entry by id, or null. */
export function findEntry(library, id) {
  return library.entries.find(e => e.id === id) || null;
}
