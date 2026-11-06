// studio/repository-files.mjs — the files of a repository the person picked
// on their own machine, read in the browser the way a scan reads them: a
// folder (showDirectoryPicker's handle, a webkitdirectory FileList or the
// entries of a drop) or a .zip of it (tools/lib/unzip.mjs). Overview's Upload
// sends the result to PUT /api/services/:id/repository-upload; Expert's scan
// stages it for /api/crawl.
//
// Which files count is the crawler library's rule (scanReadsPath,
// scanRefusal, scanSkipsName, SCAN_EXT, SCAN_MAX_FILE_BYTES), the same the
// CLI walker and the server apply, so a folder gives the same files picked,
// dropped, zipped or scanned from a terminal: the folder's .gitignore files
// honoured, a secrets file never read. A file the rule would read and the
// reader did not — git ignores it, a secrets file, too large, not UTF-8
// text — is skipped and named (lib.SCAN_WHY's words). Every reader answers
//   { name, files: { path: text }, bytes, skipped: [{ path, why }], ignored, truncated }
// `ignored` counts what the rule does not read (node_modules, build output,
// other extensions), never listed.

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

// Under the server's 16 MB cap, with room for the JSON around the text.
export const REPOSITORY_FILES_CAP = 15 * 1024 * 1024;

let crawlerLib = null;
let unzipLib = null;
const crawler = async () => (crawlerLib ??= await import('/lib/crawler.mjs'));
const unzip = async () => (unzipLib ??= await import('/lib/unzip.mjs'));

const blank = (name) => ({ name, files: {}, bytes: 0, skipped: [], ignored: 0, truncated: false });

function decodeText(bytes) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return null; }
}

function add(out, path, text) {
  if (text === null) { out.skipped.push({ path, why: 'it is not UTF-8 text' }); return; }
  if (out.bytes + text.length > REPOSITORY_FILES_CAP) { out.truncated = true; return; }
  out.files[path] = text;
  out.bytes += text.length;
}

// A folder the browser hands over (showDirectoryPicker): walked by the
// crawler's walker, which never enters a folder a scan skips.
export async function filesFromFolderHandle(dir, { onProgress } = {}) {
  const lib = await crawler();
  const out = blank(dir?.name || 'folder');
  let n = 0;
  out.ignored += await lib.walkScanFolder(dir, async (rel, handle) => {
    const file = await handle.getFile();
    if (file.size > lib.SCAN_MAX_FILE_BYTES) { out.skipped.push({ path: rel, why: `it is larger than ${mb(lib.SCAN_MAX_FILE_BYTES)}` }); return; }
    add(out, rel, decodeText(new Uint8Array(await file.arrayBuffer())));
    if (++n % 25 === 0) onProgress?.(n);
  }, undefined, { onSkip: (path, why) => out.skipped.push({ path, why }) });
  return out;
}

// The .gitignore files of a webkitdirectory FileList, read → the matcher
// (lib.gitignoreOf) the rule asks of each path.
export async function gitignoreOfFileList(list, lib) {
  const pairs = [];
  for (const f of list) {
    const rel = f.webkitRelativePath || f.name;
    if (!lib.scanHonoursGitignore(rel, { skipRoot: !!f.webkitRelativePath })) continue;
    try { pairs.push({ path: rel, text: await f.text() }); } catch { /* unreadable: nothing to honour */ }
  }
  return lib.gitignoreOf(pairs, { skipRoot: !!list[0]?.webkitRelativePath });
}

// A webkitdirectory FileList (every file under the folder, the folder's
// name first in each webkitRelativePath): the rule applied to the path
// before anything is read, the folder's .gitignore files read first.
export async function filesFromFileList(fileList) {
  const lib = await crawler();
  const list = [...fileList];
  const out = blank(list[0]?.webkitRelativePath?.split('/')[0] || 'folder');
  const gitignore = await gitignoreOfFileList(list, lib);
  for (const f of list) {
    const rel = f.webkitRelativePath || f.name;
    const why = lib.scanRefusal(rel, { skipRoot: !!f.webkitRelativePath, gitignore });
    if (why) { out.skipped.push({ path: rel, why }); continue; }
    if (!lib.scanReadsPath(rel, { skipRoot: !!f.webkitRelativePath })) { out.ignored++; continue; }
    if (f.size > lib.SCAN_MAX_FILE_BYTES) { out.skipped.push({ path: rel, why: `it is larger than ${mb(lib.SCAN_MAX_FILE_BYTES)}` }); continue; }
    add(out, rel, decodeText(new Uint8Array(await f.arrayBuffer())));
  }
  return out;
}

// A dropped folder's entries, each folder's .gitignore read before its
// entries are walked (lib.createGitignore, paths below the dropped folder):
// walkDropped(entry, lib, { onFile(rel, file), onSkip(rel, why), onIgnored(dir), onZip(file) }):
// `onIgnored(dir)` for an entry the rule never reads (a folder: dir true),
// `onZip` — when given — for a .zip inside the drop. The dropped folder
// itself is the user's choice whatever it is called.
export async function walkDropped(top, lib, { onFile, onSkip, onIgnored = () => {}, onZip = null }) {
  const gitignore = lib.createGitignore();
  const inner = (rel) => rel.split('/').slice(1).join('/');   // below the dropped folder
  const fileOf = (entry) => new Promise((res, rej) => entry.file(res, rej));
  async function walk(entry, prefix) {
    if (!entry) return;
    const rel = (prefix ? `${prefix}/` : '') + entry.name;
    if (entry.isFile) {
      if (onZip && isZipName(entry.name)) { await onZip(await fileOf(entry)); return; }
      if (lib.scanSkipsName(entry.name) || !lib.SCAN_EXT.test(entry.name)) { onIgnored(false); return; }
      if (prefix && gitignore.ignores(inner(rel))) { onSkip(rel, lib.SCAN_WHY.gitignored); return; }
      if (lib.scanRefusesName(entry.name)) { onSkip(rel, lib.SCAN_WHY.secret); return; }
      await onFile(rel, await fileOf(entry));
    } else if (entry.isDirectory) {
      if (prefix && lib.scanSkipsName(entry.name, { dir: true })) { onIgnored(true); return; }
      if (prefix && gitignore.ignores(inner(rel), { dir: true })) { onSkip(`${rel}/`, lib.SCAN_WHY.gitignoredFolder); return; }
      const reader = entry.createReader();
      const all = [];
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        all.push(...batch);
      } while (batch.length > 0);
      all.sort((x, y) => (x.name < y.name ? -1 : x.name > y.name ? 1 : 0));
      const ignoreFile = all.find((e) => e.isFile && e.name === '.gitignore');
      if (ignoreFile) {
        try { gitignore.add(prefix ? inner(rel) : '', await (await fileOf(ignoreFile)).text()); } catch { /* unreadable: nothing to honour */ }
      }
      for (const e of all) await walk(e, rel);
    }
  }
  await walk(top, '');
}

// The entries of a drop (webkitGetAsEntry): a folder walked, the dropped
// folder's own name kept whatever it is, as the scan's drop does.
export async function filesFromEntries(entries) {
  const lib = await crawler();
  const out = blank(entries.find((e) => e?.isDirectory)?.name || entries[0]?.name || 'folder');
  for (const e of entries) {
    await walkDropped(e, lib, {
      onFile: async (rel, file) => {
        if (file.size > lib.SCAN_MAX_FILE_BYTES) { out.skipped.push({ path: rel, why: `it is larger than ${mb(lib.SCAN_MAX_FILE_BYTES)}` }); return; }
        add(out, rel, decodeText(new Uint8Array(await file.arrayBuffer())));
      },
      onSkip: (path, why) => out.skipped.push({ path, why }),
      onIgnored: () => { out.ignored++; },
    });
  }
  return out;
}

// A .zip (a File or its bytes): the archive's entries the rule reads, each
// inflated only up to the scan's file size, its .gitignore files honoured (a
// secrets file is never inflated). The archive's own refusals (not a ZIP,
// ZIP64, encrypted…) throw their sentence.
export async function filesFromZip(file) {
  const [lib, zip] = await Promise.all([crawler(), unzip()]);
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  const refused = [];
  const read = await zip.readZip(bytes, {
    accept: (path) => {
      if (lib.scanHonoursGitignore(path)) return true;
      const why = lib.scanRefusal(path);
      if (why) { refused.push({ path, why }); return false; }
      return lib.scanReadsPath(path);
    },
    maxFileBytes: lib.SCAN_MAX_FILE_BYTES,
    maxTotalBytes: REPOSITORY_FILES_CAP,
  });
  const name = String(file?.name || 'archive.zip');
  const out = blank(read.root || name.replace(/\.zip$/i, '') || name);
  out.ignored = read.ignored - refused.length;
  out.skipped.push(...read.skipped, ...refused);
  out.truncated = read.truncated;
  const skipRoot = !!read.root;
  const ignoreFiles = read.entries.filter((e) => lib.scanHonoursGitignore(e.path));
  const gitignore = lib.gitignoreOf(ignoreFiles.map((e) => ({ path: e.path, text: decodeText(e.bytes) ?? '' })), { skipRoot });
  for (const e of read.entries) {
    if (ignoreFiles.includes(e)) continue;
    const why = lib.scanRefusal(e.path, { skipRoot, gitignore });
    if (why) { out.skipped.push({ path: e.path, why }); continue; }
    add(out, e.path, decodeText(e.bytes));
  }
  out.archive = name;
  return out;
}

export const isZipName = (name) => /\.zip$/i.test(String(name || ''));
