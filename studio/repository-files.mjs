// studio/repository-files.mjs — the files of a repository the person picked
// on their own machine, read in the browser the way a scan reads them: a
// folder (showDirectoryPicker's handle, a webkitdirectory FileList or the
// entries of a drop) or a .zip of it (tools/lib/unzip.mjs). Overview's Upload
// sends the result to PUT /api/services/:id/repository-upload; Expert's scan
// stages it for /api/crawl.
//
// Which files count is the crawler library's rule (scanReadsPath,
// scanSkipsName, SCAN_EXT, SCAN_MAX_FILE_BYTES), the same the CLI walker and
// the server apply, so a folder gives the same files picked, dropped, zipped
// or scanned from a terminal. A file that is not UTF-8 text is skipped and
// named. Every reader answers
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
  });
  return out;
}

// A webkitdirectory FileList (every file under the folder, the folder's
// name first in each webkitRelativePath): the rule applied to the path
// before anything is read.
export async function filesFromFileList(fileList) {
  const lib = await crawler();
  const list = [...fileList];
  const out = blank(list[0]?.webkitRelativePath?.split('/')[0] || 'folder');
  for (const f of list) {
    const rel = f.webkitRelativePath || f.name;
    if (!lib.scanReadsPath(rel, { skipRoot: !!f.webkitRelativePath })) { out.ignored++; continue; }
    if (f.size > lib.SCAN_MAX_FILE_BYTES) { out.skipped.push({ path: rel, why: `it is larger than ${mb(lib.SCAN_MAX_FILE_BYTES)}` }); continue; }
    add(out, rel, decodeText(new Uint8Array(await f.arrayBuffer())));
  }
  return out;
}

// The entries of a drop (webkitGetAsEntry): a folder walked, the dropped
// folder's own name kept whatever it is, as the scan's drop does.
export async function filesFromEntries(entries) {
  const lib = await crawler();
  const out = blank(entries.find((e) => e?.isDirectory)?.name || entries[0]?.name || 'folder');
  async function walk(entry, prefix) {
    if (!entry) return;
    if (entry.isFile) {
      if (lib.scanSkipsName(entry.name) || !lib.SCAN_EXT.test(entry.name)) { out.ignored++; return; }
      const file = await new Promise((res, rej) => entry.file(res, rej));
      const rel = (prefix ? `${prefix}/` : '') + entry.name;
      if (file.size > lib.SCAN_MAX_FILE_BYTES) { out.skipped.push({ path: rel, why: `it is larger than ${mb(lib.SCAN_MAX_FILE_BYTES)}` }); return; }
      add(out, rel, decodeText(new Uint8Array(await file.arrayBuffer())));
    } else if (entry.isDirectory) {
      if (prefix && lib.scanSkipsName(entry.name, { dir: true })) { out.ignored++; return; }
      const reader = entry.createReader();
      const here = (prefix ? `${prefix}/` : '') + entry.name;
      let batch;
      do {
        batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        for (const e of batch) await walk(e, here);
      } while (batch.length > 0);
    }
  }
  for (const e of entries) await walk(e, '');
  return out;
}

// A .zip (a File or its bytes): the archive's entries the rule reads, each
// inflated only up to the scan's file size. The archive's own refusals
// (not a ZIP, ZIP64, encrypted…) throw their sentence.
export async function filesFromZip(file) {
  const [lib, zip] = await Promise.all([crawler(), unzip()]);
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
  const read = await zip.readZip(bytes, {
    accept: (path) => lib.scanReadsPath(path),
    maxFileBytes: lib.SCAN_MAX_FILE_BYTES,
    maxTotalBytes: REPOSITORY_FILES_CAP,
  });
  const name = String(file?.name || 'archive.zip');
  const out = blank(read.root || name.replace(/\.zip$/i, '') || name);
  out.ignored = read.ignored;
  out.skipped.push(...read.skipped);
  out.truncated = read.truncated;
  for (const e of read.entries) add(out, e.path, decodeText(e.bytes));
  out.archive = name;
  return out;
}

export const isZipName = (name) => /\.zip$/i.test(String(name || ''));
