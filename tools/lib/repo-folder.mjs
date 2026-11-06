// tools/lib/repo-folder.mjs — a repository folder on disk, read the way a
// scan reads it. One walker for the server's Folder repository and `crawl:`
// journeys (tools/lib/journey.mjs scanRepoFolder, under the org's crawl
// scope) and the CLI (tools/crawl-repo.mjs), on the crawler library's own
// rule (tools/lib/crawler.mjs scanSkipsName, SCAN_EXT, SCAN_MAX_FILE_BYTES,
// scanRefusesName) — the rule the studio's folder, drop and .zip readers and
// the GitHub and Azure DevOps reads apply too, so a folder gives the same
// files whichever door it comes through.
//
// The folder's own .gitignore files are honoured (tools/lib/gitignore.mjs):
// a folder git ignores is not entered, a file git ignores is not read. A file
// the rule would read and this read did not is named in `skipped` with why —
// git ignores it, a secrets file, larger than a scan reads, past the total,
// unreadable, or refused by the caller's scope — never left out in silence.
// What the rule never looks at (other extensions, node_modules, build
// output, dot-folders) is not listed.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createGitignore } from './gitignore.mjs';
import { SCAN_EXT, SCAN_MAX_FILE_BYTES, SCAN_WHY, scanRefusesName, scanSkipsName } from './crawler.mjs';

const byName = (x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0);
const reason = (e) => e?.code || e?.message || String(e);

/**
 * readRepoFolder(root, { refuse, maxTotalBytes }) →
 *   { files, skipped, bytes, notEntered }
 * files       { <path relative to root, forward slashes>: text }, in path order
 * skipped     [{ path, why }] in path order; a folder's path ends in `/`
 * bytes       the size of what was read
 * notEntered  how many dependency, build or hidden folders were not entered
 * `refuse(absPath)` → '' or why not (a sentence that follows "it": "belongs
 * to another org's …") — a folder refused is not entered, a file not read.
 * `maxTotalBytes` stops reading once that much is read (Infinity: no stop);
 * the files after it are skipped and named, in path order.
 */
export function readRepoFolder(root, { refuse = null, maxTotalBytes = Infinity } = {}) {
  const files = {};
  const skipped = [];
  const gitignore = createGitignore();
  let bytes = 0;
  let notEntered = 0;
  const walk = (dir, rel) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }).sort(byName); }
    catch (e) { if (rel) skipped.push({ path: `${rel}/`, why: `it could not be listed (${reason(e)})` }); return; }
    if (entries.some((e) => e.name === '.gitignore' && !e.isDirectory())) {
      try { gitignore.add(rel, readFileSync(join(dir, '.gitignore'), 'utf8')); } catch { /* unreadable: nothing to honour */ }
    }
    for (const e of entries) {
      const path = rel ? `${rel}/${e.name}` : e.name;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (scanSkipsName(e.name, { dir: true })) { notEntered++; continue; }
        if (gitignore.ignores(path, { dir: true })) { skipped.push({ path: `${path}/`, why: SCAN_WHY.gitignoredFolder }); continue; }
        const why = refuse?.(full);
        if (why) { skipped.push({ path: `${path}/`, why: `it ${why}` }); continue; }
        walk(full, path);
        continue;
      }
      if (scanSkipsName(e.name) || !SCAN_EXT.test(e.name)) continue;
      if (gitignore.ignores(path)) { skipped.push({ path, why: SCAN_WHY.gitignored }); continue; }
      if (scanRefusesName(e.name)) { skipped.push({ path, why: SCAN_WHY.secret }); continue; }
      const why = refuse?.(full);   // a symlinked file included
      if (why) { skipped.push({ path, why: `it ${why}` }); continue; }
      let st;
      try { st = statSync(full); } catch (err) { skipped.push({ path, why: `it could not be read (${reason(err)})` }); continue; }
      if (!st.isFile()) continue;   // a symlinked folder is not followed
      if (st.size > SCAN_MAX_FILE_BYTES) { skipped.push({ path, why: SCAN_WHY.tooLarge() }); continue; }
      if (bytes + st.size > maxTotalBytes) { skipped.push({ path, why: SCAN_WHY.totalCap(maxTotalBytes) }); continue; }
      try {
        files[path] = readFileSync(full, 'utf8');
        bytes += st.size;
      } catch (err) { skipped.push({ path, why: `it could not be read (${reason(err)})` }); }
    }
  };
  walk(root, '');
  return { files, skipped, bytes, notEntered };
}
