// server/store/pack-import.mjs — boot step 5: the one-shot pack import and
// the backfill (docs/STORE_PLAN.md §4 items 4–5; slice 4).
//
//   planPackImport(db, org, ctx, files)   reads only: one org's index.json (strictly),
//                                         its pack files, the rows it would write
//   applyPackImport(db, plans, ctx)       one tx(): the rows, the links, the meta
//                                         (pack_index_hashes, packs_imported, the
//                                         report), ONE store.packs-import audit row
//   formatPackReport(report)              the boot log lines
//
// Each live org root's packs/index.json — the registry before this slice —
// is read ONCE here and never again: it stays on disk, frozen, and its hash
// (the canonical form, legacy-files.mjs) goes under schema_meta
// pack_index_hashes — a key of its OWN, never legacy_hashes, because a
// 0.5.0 build's stale-import guard compares every legacy_hashes key and
// rewrites index.json on every pack read; a pack key there would make a
// rollback to 0.5.0 refuse its second start with no way out that works
// there. No marker is written: the marker records the identity files only.
//
// The plan never throws on a FIELD: an entry a 0.5.0 build wrote must
// import, whatever it holds — a label or source over the text limit is cut
// (reported), a time that is no time takes the file's mtime (reported), an
// entry that is no object imports with nothing but its id. Only the FILE
// refuses: an index.json that exists but cannot be read, or a packs/ that
// cannot be listed, throws a LegacyFileError naming the path — "could not
// read" is not "empty" (the 2026-06-11 incident) — and the start aborts
// before any pack row is written. A corrupt or wrong-shaped index is not an
// error: that root's rows are rebuilt from the pack files, labels null, and
// the report names the path.
//
// Layering: this module may not import server/workspace.mjs (a store module
// above the server layer), so the pack-file reads arrive as `files` —
// { list(root) → { ids } | { error }, read(root, id) → { raw } | { error } |
// null, stat(root, id) → { mtimeMs } | null } — which server/boot.mjs builds
// from workspace.mjs's readers against each org's explicit root.

import { join } from 'node:path';
import { parse as parseYaml } from '../../tools/lib/mini-yaml.mjs';
import { listEnvironments } from '../../tools/lib/adapter.mjs';
import { catalogEntryOf, servicesForPack } from '../../tools/lib/service-keys.mjs';
import { tx } from './db.mjs';
import { writeAudit } from './audit.mjs';
import { getMeta, putMeta, storeId } from './meta.mjs';
import { runWithOrg } from '../org-context.mjs';
import { SYSTEM } from './identity.mjs';
import { addPack, clampPackText, listPacks } from './packs.mjs';
import { linkPack } from './pack-links.mjs';
import { isoOf, LegacyFileError, PACK_INDEX_TAIL, packIndexHash, packIndexKey, readPackIndexStrict } from './legacy-files.mjs';

const TEXT_MAX = 200;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// A pack file's canonical: the parsed YAML when it is an object, else null
// (an unparseable file is still a pack — registered, with no services).
export function parsePackFile(raw) {
  try {
    const c = parseYaml(raw);
    return isPlainObject(c) ? c : null;
  } catch {
    return null;
  }
}

// The entry the plan links: what GET /api/packs serves for the pack.
export function entryOf(id, { label, source }, canonical) {
  return catalogEntryOf(id, { label, source }, canonical, listEnvironments(canonical));
}

// ---------- planning (reads only) ----------

export function planPackImport(db, org, ctx, files) {
  const root = join(ctx.base, org.root);
  const idxPath = join(root, 'packs', 'index.json');
  const key = packIndexKey(org.root);
  const idx = readPackIndexStrict(idxPath);                               // throws on an unreadable file
  const listed = files.list(root);
  if (listed.error) {
    throw new LegacyFileError(join(root, 'packs'), `cannot be listed (${listed.error})`, undefined, PACK_INDEX_TAIL);
  }
  const ids = [...listed.ids].sort();
  const entries = idx.entries ? new Map(idx.entries) : new Map();
  const plan = {
    org: org.id, root: org.root, idxPath, key, present: idx.exists, corrupt: idx.corrupt ?? null,
    hash: packIndexHash(idx),
    rows: [], adopted: [], dropped: [], skipped: [], badFields: [], unparseable: [], conflicts: [],
    links: { services: [], environments: [], links: [] },
  };
  const bad = (id, field, reason) => plan.badFields.push({ id, field, reason });
  for (const id of ids) {
    if (id.length > TEXT_MAX) {
      // A hand-copied file; the row cannot hold its name (the id column's
      // text limit). The rehydrate adopts it once renamed.
      plan.skipped.push({ id: `${id.slice(0, 60)}…`, reason: `name over ${TEXT_MAX} characters` });
      continue;
    }
    const rawMeta = entries.has(id) ? entries.get(id) : undefined;
    if (rawMeta !== undefined && !isPlainObject(rawMeta)) bad(id, 'entry', 'not an object — imported with its id only');
    const meta = isPlainObject(rawMeta) ? rawMeta : rawMeta !== undefined ? {} : null;
    const stat = files.stat(root, id);
    const mtimeIso = isoOf(stat?.mtimeMs) ?? ctx.now;
    let label = null;
    if (meta && meta.label !== undefined && meta.label !== null) {
      if (typeof meta.label !== 'string') bad(id, 'label', 'not a string');
      else if (meta.label.trim() === '') label = null;
      else if (meta.label.length > TEXT_MAX) { bad(id, 'label', `over ${TEXT_MAX} characters, cut`); label = clampPackText(meta.label); }
      else label = clampPackText(meta.label);
    }
    let source = meta ? 'upload' : 'workspace';
    if (meta && meta.source !== undefined && meta.source !== null && meta.source !== '') {
      if (typeof meta.source !== 'string') bad(id, 'source', 'not a string');
      else if (meta.source.length > TEXT_MAX) { bad(id, 'source', `over ${TEXT_MAX} characters, cut`); source = clampPackText(meta.source); }
      else source = clampPackText(meta.source) ?? 'upload';
    }
    let createdAt = meta ? isoOf(meta.createdAt) : null;
    if (meta && createdAt === null) {
      if (meta.createdAt !== undefined && meta.createdAt !== null) bad(id, 'createdAt', 'not a timestamp — the file\'s mtime is used');
      createdAt = mtimeIso;
    }
    if (!meta) createdAt = mtimeIso;
    let lastUsedAt = meta ? isoOf(meta.lastUsedAt) : null;
    if (meta && lastUsedAt === null && meta.lastUsedAt !== undefined && meta.lastUsedAt !== null) bad(id, 'lastUsedAt', 'not a timestamp — createdAt is used');
    lastUsedAt ??= createdAt;
    if (!meta && !idx.corrupt) plan.adopted.push(id);   // under a corrupt index every row is rebuilt: nothing is "adopted"
    const read = files.read(root, id);
    const canonical = read && !read.error ? parsePackFile(read.raw) : null;
    if (!canonical) plan.unparseable.push(id);
      plan.rows.push({ id, label, source, createdAt, lastUsedAt, canonical, entry: canonical ? entryOf(id, { label, source }, canonical) : null });
  }
  // An entry whose file is gone: positive evidence only (a listing we just
  // took, plus an existence check).
  const idSet = new Set(ids);
  for (const [id] of entries) if (!idSet.has(id) && !files.stat(root, id)) plan.dropped.push(id);
  return plan;
}

// ---------- applying ----------

export function applyPackImport(db, plans, ctx) {
  return tx(db, () => {
    if (getMeta(db, 'packs_imported')) {
      throw new Error(`observogram store: store ${storeId(db)} imported its pack registry while this start was planning it — restart to use it`);
    }
    for (const plan of plans) {
      runWithOrg(plan.org, () => {
        const existing = new Set(listPacks(db).map((p) => p.id));
        for (const row of plan.rows) {
          if (existing.has(row.id)) { plan.conflicts.push(row.id); continue; }   // a row the store already holds is never overwritten
          const adopted = plan.adopted.includes(row.id);
          addPack(db, SYSTEM, {
            id: row.id, label: row.label, source: row.source, createdAt: row.createdAt, lastUsedAt: row.lastUsedAt,
            detail: { imported: true, ...(adopted ? { adopted: true } : {}) },
          });
          if (!row.canonical) continue;
          const linked = linkPack(db, SYSTEM, { packId: row.id, entry: row.entry, canonical: row.canonical, via: 'import' });
          plan.links.services.push(...linked.services);
          plan.links.environments.push(...linked.environments);
          plan.links.links.push(...linked.links);
        }
      });
    }
    const report = reportOf(db, plans, ctx);
    putMeta(db, 'pack_index_hashes', JSON.stringify(Object.fromEntries(plans.map((p) => [p.key, p.hash]))));
    putMeta(db, 'packs_imported', ctx.now);
    putMeta(db, 'packs_import_report', JSON.stringify(report));
    writeAudit(db, SYSTEM, {
      action: 'store.packs-import', targetKind: 'store', targetId: report.storeId,
      detail: {
        orgs: report.orgs.length, packs: report.totals.packs, adopted: report.totals.adopted, dropped: report.totals.dropped,
        corrupt: report.orgs.filter((o) => o.corrupt).map((o) => o.idxPath),
        services: report.totals.services, environments: report.totals.environments, links: report.totals.links,
        conflicts: report.totals.conflicts,
      },
    });
    return report;
  });
}

function reportOf(db, plans, ctx) {
  const orgs = plans.map((p) => ({
    org: p.org, root: p.root, idxPath: p.idxPath, key: p.key, present: p.present, corrupt: p.corrupt,
    packs: p.rows.length - p.conflicts.length,
    adopted: [...p.adopted], dropped: [...p.dropped], skipped: [...p.skipped], badFields: [...p.badFields],
    unparseable: [...p.unparseable], conflicts: [...p.conflicts],
    noService: p.rows.filter((r) => r.canonical && !p.conflicts.includes(r.id) && r.entry && servicesForPack(r.entry).length === 0).map((r) => r.id),
    links: { services: [...p.links.services], environments: [...p.links.environments], links: [...p.links.links] },
  }));
  const sum = (f) => orgs.reduce((n, o) => n + f(o), 0);
  return {
    kind: 'packs-import', at: ctx.now, storeId: storeId(db), dbPath: ctx.dbPath ?? null, orgs,
    totals: {
      packs: sum((o) => o.packs), adopted: sum((o) => o.adopted.length), dropped: sum((o) => o.dropped.length),
      services: sum((o) => o.links.services.length), environments: sum((o) => o.links.environments.length), links: sum((o) => o.links.links.length),
      noService: sum((o) => o.noService.length) + sum((o) => o.unparseable.length), conflicts: sum((o) => o.conflicts.length),
    },
  };
}

// ---------- the boot log ----------

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function formatPackReport(r) {
  const out = [];
  const from = (o) => (o.corrupt ? 'index.json corrupt: rebuilt from the pack files' : o.present ? 'from packs/index.json' : '(no index.json: adopted from the pack files)');
  const per = r.orgs.map((o) => `${o.org} (${o.root}) ${plural(o.packs, 'pack')} ${from(o)}`).join(' · ');
  out.push(`[store] imported the pack registry of ${plural(r.orgs.length, 'org')} into ${r.dbPath} (store ${r.storeId})${r.orgs.length ? `: ${per}` : ''}`);
  if (r.totals.packs > 0) {
    out.push(`[store]   services: ${r.totals.services} created, ${plural(r.totals.environments, 'environment')}, ${plural(r.totals.links, 'pack link')}; `
      + `${plural(r.totals.noService, 'pack')} name no service`);
  }
  for (const o of r.orgs) {
    if (o.corrupt) out.push(`[store]   ${o.org}: ${o.idxPath} is corrupt (${o.corrupt}) — ${plural(o.packs, 'row')} rebuilt from the pack files, labels lost (null)`);
    if (o.adopted.length || o.dropped.length) {
      const parts = [];
      if (o.adopted.length) parts.push(`adopted ${plural(o.adopted.length, 'pack file')} with no index entry: ${o.adopted.join(', ')}`);
      if (o.dropped.length) parts.push(`dropped ${plural(o.dropped.length, 'index entry')} whose file is gone: ${o.dropped.join(', ')}`);
      out.push(`[store]   ${o.org}: ${parts.join(' · ')}`);
    }
    if (o.badFields.length) out.push(`[store]   ${o.org}: index fields dropped: ${o.badFields.map((b) => `${b.id} ${b.field} (${b.reason})`).join(' · ')}`);
    if (o.skipped.length) {
      out.push(`[store]   ${o.org}: pack files skipped (name over ${TEXT_MAX} characters — rename the file and start again, the rehydrate adopts it): ${o.skipped.map((s) => s.id).join(', ')}`);
    }
    if (o.unparseable.length) out.push(`[store]   ${o.org}: unparseable pack files (registered, no services): ${o.unparseable.join(', ')}`);
    if (o.conflicts.length) out.push(`[store]   ${o.org}: already in the store (kept): ${o.conflicts.join(', ')}`);
  }
  return out;
}
