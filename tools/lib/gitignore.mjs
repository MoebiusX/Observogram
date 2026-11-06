// tools/lib/gitignore.mjs — which paths of a folder git ignores, from the
// folder's own .gitignore files. Browser-safe (no node: imports): the server's
// Folder walk, the CLI walker and the studio's folder, drop and .zip readers
// all ask the same matcher, so a local scan never reads what the repository
// keeps out of git (a secrets overlay, a local env file, build output).
//
// The patterns are git's (gitignore(5)): `#` comments and blank lines; a
// leading `!` re-includes; a trailing `/` matches a folder only; a pattern
// with a `/` at its start or in its middle is anchored to its .gitignore's
// folder, any other matches a name at any depth below it; `*` and `?` never
// cross a `/`; `**/`, `/**` and `/**/` cross any number of folders; `[…]` is a
// character class (`[!…]` negated); `\` escapes. The last pattern that matches
// decides, a deeper .gitignore after its parents'; a file under a folder git
// ignores stays ignored whatever a deeper pattern says (git never looks
// inside it). Only the .gitignore files inside the scanned folder count — not
// .git/info/exclude, a global excludes file or a .gitignore above the folder.

const escapeRe = (c) => c.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

// One glob (no leading `!`, no anchoring `/`, no trailing `/`) as a regex body.
function globBody(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '\\' && i + 1 < glob.length) { re += escapeRe(glob[++i]); continue; }
    if (c === '*') {
      if (glob[i + 1] === '*') {
        const atSegmentStart = i === 0 || glob[i - 1] === '/';
        const after = glob[i + 2];
        if (atSegmentStart && after === '/') { re += '(?:.*/)?'; i += 2; continue; }   // `**/`: any folders, or none
        if (atSegmentStart && after === undefined) { re += '.*'; i += 1; continue; }   // `/**`: everything inside
        while (glob[i + 1] === '*') i++;                                               // any other run: one `*`
      }
      re += '[^/]*';
      continue;
    }
    if (c === '?') { re += '[^/]'; continue; }
    if (c === '[') {
      let j = i + 1;
      if (glob[j] === '!' || glob[j] === '^') j++;
      if (glob[j] === ']') j++;
      while (j < glob.length && glob[j] !== ']') j++;
      if (j >= glob.length) { re += '\\['; continue; }   // no closing bracket: a literal [
      let body = glob.slice(i + 1, j);
      const negated = body[0] === '!' || body[0] === '^';
      if (negated) body = body.slice(1);
      const members = body.replace(/\\(.)/g, '$1').replace(/[\\\]^[]/g, '\\$&');
      re += `${negated ? '[^/' : '['}${members}]`;
      i = j;
      continue;
    }
    re += escapeRe(c);
  }
  return re;
}

/**
 * The rules of one .gitignore's text → [{ negate, dirOnly, anchored, re }],
 * in file order. `re` tests a path relative to the .gitignore's folder
 * (anchored) or one name (not anchored).
 */
export function parseGitignore(text) {
  const rules = [];
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    let line = raw.replace(/(?<!\\)\s+$/, '');   // trailing blanks, unless escaped
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1); }
    else if (line.startsWith('\\!') || line.startsWith('\\#')) line = line.slice(1);
    let dirOnly = false;
    if (line.endsWith('/') && !line.endsWith('\\/')) { dirOnly = true; line = line.replace(/\/+$/, ''); }
    if (!line) continue;
    const anchored = line.includes('/');
    if (line.startsWith('/')) line = line.slice(1);
    if (!line) continue;
    try {
      rules.push({ negate, dirOnly, anchored, re: new RegExp(`^${globBody(line)}$`) });
    } catch { /* a pattern no regex can say: git would not match it either */ }
  }
  return rules;
}

/**
 * A matcher over the .gitignore files of one folder tree. `add(base, text)`
 * reads the .gitignore of the folder `base` (relative, forward slashes, ''
 * for the scanned folder itself) — parents before their children, as a walk
 * from the top finds them. `ignores(relPath, { dir })` answers for one entry
 * whose parent folders were not ignored (a walk that stops at an ignored
 * folder asks no more); `ignoredAt(relPath)` checks the folders on the way
 * too and answers the first path git ignores (a folder, or the file itself),
 * or null — for a flat list of every file under the folder.
 */
export function createGitignore() {
  const scoped = [];   // [{ base, rules }] in the order added
  const ignores = (relPath, { dir = false } = {}) => {
    const path = String(relPath ?? '').replace(/^\/+|\/+$/g, '');
    if (!path) return false;
    const name = path.slice(path.lastIndexOf('/') + 1);
    let ignored = false;
    for (const { base, rules } of scoped) {
      if (base && !path.startsWith(`${base}/`)) continue;
      const rel = base ? path.slice(base.length + 1) : path;
      for (const r of rules) {
        if (r.dirOnly && !dir) continue;
        if (r.re.test(r.anchored ? rel : name)) ignored = !r.negate;
      }
    }
    return ignored;
  };
  return {
    get size() { return scoped.reduce((n, s) => n + s.rules.length, 0); },
    add(base, text) {
      const rules = parseGitignore(text);
      if (rules.length) scoped.push({ base: String(base ?? '').replace(/^\/+|\/+$/g, ''), rules });
      return rules.length;
    },
    ignores,
    ignoredAt(relPath) {
      const parts = String(relPath ?? '').split('/').filter(Boolean);
      for (let i = 1; i <= parts.length; i++) {
        const p = parts.slice(0, i).join('/');
        if (ignores(p, { dir: i < parts.length })) return p;
      }
      return null;
    },
  };
}
