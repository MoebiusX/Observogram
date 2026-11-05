// tools/lib/unzip.mjs
//
// A small ZIP reader for a scan: the files of a .zip a person picked (a
// repository's "Download ZIP", a folder zipped by hand). STORE and DEFLATE
// only, inflated with the platform's DecompressionStream('deflate-raw'),
// which every current browser and Node 18+ have, so the same module runs in
// the studio and in Node with no dependency (tools/lib/zip.mjs is its writer).
//
// It never writes a file: entries come back as bytes keyed by their path
// inside the archive. A name that would leave the archive's folder (absolute,
// a drive, a `..` segment, a NUL) is skipped and named, as are encrypted
// entries, other compression methods and an entry whose checksum does not
// match. ZIP64 archives (over 4 GiB or 65,535 entries) and split archives are
// refused whole. Bounded: at most `maxEntries` files are read, each at most
// `maxFileBytes` once inflated and all of them together `maxTotalBytes`; an
// entry is inflated only up to its cap, so a small archive cannot expand past
// it whatever sizes its headers claim.

export const UNZIP_LIMITS = Object.freeze({ maxEntries: 20000, maxFileBytes: 5 * 1024 * 1024, maxTotalBytes: 64 * 1024 * 1024 });

/** The archive as a whole cannot be read (not a ZIP, ZIP64, split, damaged directory, no inflater). */
export class ZipRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = 'ZipRefusal';
    this.code = 'ERR_OBSERVOGRAM_ZIP_REFUSED';
  }
}

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_LOCAL = 0x04034b50;
const EOCD_MIN = 22;
const EOCD_SEARCH = EOCD_MIN + 0xffff;   // the comment is at most 65,535 bytes

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const utf8 = new TextDecoder('utf-8');

// A name inside the archive as a path a scan may key a file by, or null when
// it would leave the archive's folder.
export function safeEntryPath(name) {
  const p = String(name).replace(/\\/g, '/');
  if (!p || p.includes('\0') || p.startsWith('/') || /^[A-Za-z]:/.test(p)) return null;
  const parts = p.split('/');
  if (parts.some((s) => s === '..')) return null;
  return parts.filter((s) => s !== '' && s !== '.').join('/') || null;
}

// Inflate `data` (raw DEFLATE) to at most `cap` bytes: the bytes, or null
// when it would go past the cap.
async function inflateRaw(data, cap) {
  const source = new ReadableStream({ start(c) { c.enqueue(data); c.close(); } });
  const reader = source.pipeThrough(new DecompressionStream('deflate-raw')).getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > cap) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const mb = (n) => `${Math.round((n / (1024 * 1024)) * 10) / 10} MB`;

// readZip(bytes, { accept, maxEntries, maxFileBytes, maxTotalBytes }) →
//   { entries: [{ path, bytes }], skipped: [{ path, why }], ignored, truncated, root }
//   accept(path)  whether the caller wants an entry (a scan's file rule); an
//                 entry it declines is counted in `ignored`, never read
//   root          the one top-level folder every entry sits in (a "Download
//                 ZIP" of a repository), or null
// Entries keep the order of the archive's directory. Throws ZipRefusal when
// the archive as a whole cannot be read.
export async function readZip(input, { accept = () => true, maxEntries = UNZIP_LIMITS.maxEntries, maxFileBytes = UNZIP_LIMITS.maxFileBytes, maxTotalBytes = UNZIP_LIMITS.maxTotalBytes } = {}) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (typeof DecompressionStream !== 'function') throw new ZipRefusal('this browser cannot inflate a .zip (it has no DecompressionStream): pick the folder instead');
  if (bytes.length < EOCD_MIN) throw new ZipRefusal('this is not a .zip: it is too short to hold a ZIP directory');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - EOCD_MIN; i >= Math.max(0, bytes.length - EOCD_SEARCH); i--) {
    if (view.getUint32(i, true) === SIG_EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipRefusal('this is not a .zip: no ZIP directory at its end');
  const disk = view.getUint16(eocd + 4, true);
  const cdDisk = view.getUint16(eocd + 6, true);
  const count = view.getUint16(eocd + 10, true);
  const cdSize = view.getUint32(eocd + 12, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (disk !== 0 || cdDisk !== 0) throw new ZipRefusal('this .zip is split across several files, which is not read: zip the folder as one file');
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipRefusal('this .zip is a ZIP64 archive (over 4 GB or 65,535 entries), which is not read: zip only the folder the scan needs');
  if (cdOffset + cdSize > eocd) throw new ZipRefusal('this .zip is damaged: its directory points past its end');

  const entries = [];
  const skipped = [];
  let ignored = 0;
  let truncated = false;
  let total = 0;
  let files = 0;
  let at = cdOffset;
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || view.getUint32(at, true) !== SIG_CENTRAL) throw new ZipRefusal('this .zip is damaged: its directory ends early');
    const flags = view.getUint16(at + 8, true);
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLen = view.getUint16(at + 28, true);
    const extraLen = view.getUint16(at + 30, true);
    const commentLen = view.getUint16(at + 32, true);
    const localAt = view.getUint32(at + 42, true);
    const name = utf8.decode(bytes.subarray(at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/') || name.endsWith('\\')) continue;   // a folder
    const path = safeEntryPath(name);
    if (!path) { skipped.push({ path: name, why: 'its name leaves the archive\'s folder' }); continue; }
    if (!accept(path)) { ignored++; continue; }
    if (files >= maxEntries) { truncated = true; break; }
    files++;
    if (flags & 0x1) { skipped.push({ path, why: 'it is encrypted' }); continue; }
    if (method !== 0 && method !== 8) { skipped.push({ path, why: `it is compressed with method ${method}, which is not read` }); continue; }
    if (size > maxFileBytes) { skipped.push({ path, why: `it is larger than ${mb(maxFileBytes)}` }); continue; }
    if (total + size > maxTotalBytes) { truncated = true; break; }
    if (localAt + 30 > bytes.length || view.getUint32(localAt, true) !== SIG_LOCAL) { skipped.push({ path, why: 'it is damaged (no file header where the directory says)' }); continue; }
    const dataAt = localAt + 30 + view.getUint16(localAt + 26, true) + view.getUint16(localAt + 28, true);
    if (dataAt + compSize > bytes.length) { skipped.push({ path, why: 'it is damaged (it runs past the end of the archive)' }); continue; }
    const raw = bytes.subarray(dataAt, dataAt + compSize);
    let out;
    if (method === 0) out = raw.slice();
    else {
      try { out = await inflateRaw(raw, Math.min(size, maxFileBytes)); }
      catch { skipped.push({ path, why: 'it is damaged (it does not inflate)' }); continue; }
      if (out === null) { skipped.push({ path, why: 'it inflates past the size its header gives' }); continue; }
    }
    if (out.length !== size || crc32(out) !== crc) { skipped.push({ path, why: 'it is damaged (its size or checksum does not match)' }); continue; }
    total += out.length;
    entries.push({ path, bytes: out });
  }
  const tops = new Set(entries.map((e) => (e.path.includes('/') ? e.path.slice(0, e.path.indexOf('/')) : '')));
  const root = tops.size === 1 && !tops.has('') ? [...tops][0] : null;
  return { entries, skipped, ignored, truncated, root };
}
