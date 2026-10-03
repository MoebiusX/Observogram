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
// The two offline operations reconcile the same way (§10 of the slice-4
// design; the rehydrate's rule — a file with no row is adopted, a row whose
// file is gone is removed on positive evidence):
//   planPackExport / applyPackExport      `packc store export` in place: the rows
//                                         and the files agree BEFORE index.json
//                                         is written from the rows (an older
//                                         build would otherwise adopt or prune
//                                         at its first start and "change" the
//                                         file nobody edited); packIndexDataOf
//                                         is the file's shape (ms numbers)
//   planPackReplace / applyPackReplace    `packc store import --replace`: the
//                                         index.json a rolled-back build wrote
//                                         is the record — entries with files
//                                         are added or relabelled from it, rows
//                                         whose file is gone removed; the hash
//                                         rewritten (pack_index_hashes only)
//   formatPackReplace(report)             the replace's log lines
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
import { getMeta, getMetaJson, putMeta, storeId } from './meta.mjs';
import { runWithOrg } from '../org-context.mjs';
import { SYSTEM } from './identity.mjs';
import { addPack, clampPackText, getPack, listPacks, removePack, upsertPack } from './packs.mjs';
import { linkPack } from './pack-links.mjs';
import { isoOf, LegacyFileError, PACK_INDEX_TAIL, packIndexHash, packIndexKey, readPackIndexStrict } from './legacy-files.mjs';

const TEXT_MAX = 200;
const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// The replace's way out for an unreadable index.json or packs/: the request
// stays pending, so a fixed file is taken in at the next start.
export const PACK_REPLACE_TAIL = 'the replace takes no pack registry from a file it cannot read — a transient EPERM or EBUSY must not become an '
  + 'empty registry (the 2026-06-11 incident); nothing was replaced and the request stays pending. With the server stopped, make it readable '
  + 'or move it aside (the store\'s rows then stand; files without a row are adopted with no label) and start again: the next start carries the replace out';

// A pack directory that cannot be listed at an export: refused, nothing written.
export class PackFilesError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PackFilesError';
    this.code = 'ERR_OBSERVOGRAM_PACK_FILES';
  }
}

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

// ---------- an index entry, read as every writer before this slice wrote it ----------

// The entry of `id`: as parsed when it is an object, {} when it is some
// other value (imported with its id only, reported), null when there is none.
function entryMeta(entries, id, bad) {
  const rawMeta = entries.has(id) ? entries.get(id) : undefined;
  if (rawMeta !== undefined && !isPlainObject(rawMeta)) bad(id, 'entry', 'not an object — imported with its id only');
  return isPlainObject(rawMeta) ? rawMeta : rawMeta !== undefined ? {} : null;
}

// The row's fields from an entry (meta) or, with none, the adoption's
// (label null, source 'workspace', the file's mtime). Never throws on a
// field: a text over the limit is cut, a time that is no time falls back.
function entryFields(id, meta, mtimeIso, bad) {
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
  return { label, source, createdAt, lastUsedAt };
}

// The file's shape, as every build before this slice wrote it: id →
// { label, source, createdAt, lastUsedAt } with ms numbers.
export function packIndexDataOf(rows) {
  return Object.fromEntries(rows.map((r) => [r.id, { label: r.label, source: r.source, createdAt: Date.parse(r.createdAt), lastUsedAt: Date.parse(r.lastUsedAt) }]));
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
    const meta = entryMeta(entries, id, bad);
    const { label, source, createdAt, lastUsedAt } = entryFields(id, meta, isoOf(files.stat(root, id)?.mtimeMs) ?? ctx.now, bad);
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

// ---------- the export's reconcile (`packc store export` in place) ----------

// Reads only. One live org: its rows and its pack files under `readRoot`
// (where they are at plan time: the default org's are still flat when the
// export is about to move them), and what the index written at `writeRoot`
// will hold once the two agree:
//   adopt — files with no row (label null, source 'workspace', the file's
//           mtime; an unparseable file is a row with no services, as the
//           rehydrate adopts it; a name over the text limit is skipped and
//           reported, as the import skips it);
//   prune — rows whose file is gone, on positive evidence (the listing
//           succeeded and the file's stat says ENOENT);
//   packs — the rows after both, in listPacks order (created_at, id).
// A packs/ that cannot be listed is refused: an index written from the rows
// alone is exactly what the reconcile exists to prevent.
export function planPackExport(db, org, ctx, files, { readRoot = org.root, writeRoot = org.root } = {}) {
  const root = join(ctx.base, readRoot);
  const listed = files.list(root);
  if (listed.error) {
    throw new PackFilesError(`${join(root, 'packs')} cannot be listed (${listed.error}) — the export reconciles the pack files with the store's rows before it writes index.json, and cannot without the listing`);
  }
  const rows = runWithOrg(org.id, () => listPacks(db));
  const byId = new Map(rows.map((r) => [r.id, r]));
  const ids = [...listed.ids].sort();
  const adopt = [];
  const skipped = [];
  for (const id of ids) {
    if (byId.has(id)) continue;
    if (id.length > TEXT_MAX) { skipped.push(id); continue; }
    const at = isoOf(files.stat(root, id)?.mtimeMs) ?? ctx.now;
    const read = files.read(root, id);
    const canonical = read && !read.error ? parsePackFile(read.raw) : null;
    adopt.push({ id, at, canonical, entry: canonical ? entryOf(id, { label: null, source: 'workspace' }, canonical) : null });
  }
  const idSet = new Set(ids);
  const prune = rows.filter((r) => !idSet.has(r.id) && !files.stat(root, r.id)).map((r) => r.id);
  const packs = [
    ...rows.filter((r) => !prune.includes(r.id)),
    ...adopt.map((a) => ({ id: a.id, label: null, source: 'workspace', createdAt: a.at, lastUsedAt: a.at })),
  ].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return {
    org: org.id, root: writeRoot, readRoot, key: packIndexKey(writeRoot), path: join(ctx.base, writeRoot, 'packs', 'index.json'),
    packs, adopt, prune, skipped,
  };
}

// Inside the export's tx(): the adoptions (pack.register { adopted, via:
// 'export' } and the pack's links — the one place a CLI creates service
// rows) and the prunes (pack.remove { reason: 'file gone', via: 'export' }),
// by `actor` (the CLI). Returns the counts.
export function applyPackExport(db, actor, plans) {
  let adopted = 0;
  let pruned = 0;
  for (const plan of plans) {
    runWithOrg(plan.org, () => {
      for (const a of plan.adopt) {
        if (getPack(db, a.id)) continue;
        addPack(db, actor, { id: a.id, label: null, source: 'workspace', createdAt: a.at, lastUsedAt: a.at, detail: { adopted: true, via: 'export' } });
        if (a.canonical) linkPack(db, actor, { packId: a.id, entry: a.entry, canonical: a.canonical, via: 'export' });
        adopted += 1;
      }
      for (const id of plan.prune) {
        if (!getPack(db, id)) continue;
        removePack(db, actor, id, { detail: { reason: 'file gone', via: 'export' } });
        pruned += 1;
      }
    });
  }
  return { adopted, pruned };
}

// ---------- the replace's reconcile (`packc store import --replace`) ----------

// Reads only. `orgs` are the live orgs AFTER the replace — created ones
// included — each with the root it will have ({ id, root }; the roots are
// resolved by the caller: runWithOrg knows no roots). Per org: index.json
// read strictly (an unreadable one throws naming it, before any write), the
// files listed (likewise), the rows, and the reconcile:
//   add      — a file with no row: the entry's label/source/times when the
//              index has one, else adopted (label null, 'workspace', mtime);
//   relabel  — a row and an entry whose label or source differ: the index
//              is the downgrade's record (pack.update { fields, via });
//   remove   — a row whose file is gone, on positive evidence;
//   nothing  — a row, a file, no entry or an unchanged one;
//   corrupt  — reported; the rows keep their labels (nothing relabelled),
//              files without a row are adopted.
export function planPackReplace(db, orgs, ctx, files) {
  return orgs.map((org) => {
    const root = join(ctx.base, org.root);
    const idxPath = join(root, 'packs', 'index.json');
    const idx = readPackIndexStrict(idxPath);                                  // throws on an unreadable file
    const listed = files.list(root);
    if (listed.error) throw new LegacyFileError(join(root, 'packs'), `cannot be listed (${listed.error})`, undefined, PACK_REPLACE_TAIL);
    const rows = runWithOrg(org.id, () => listPacks(db));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const entries = idx.entries ? new Map(idx.entries) : new Map();
    const plan = {
      org: org.id, root: org.root, idxPath, key: packIndexKey(org.root), present: idx.exists, corrupt: idx.corrupt ?? null,
      hash: packIndexHash(idx), add: [], relabel: [], remove: [], skipped: [], badFields: [],
    };
    const bad = (id, field, reason) => plan.badFields.push({ id, field, reason });
    const ids = [...listed.ids].sort();
    for (const id of ids) {
      const row = byId.get(id);
      if (id.length > TEXT_MAX) { if (!row) plan.skipped.push(id); continue; }
      const meta = entryMeta(entries, id, bad);
      const fields = entryFields(id, meta, isoOf(files.stat(root, id)?.mtimeMs) ?? ctx.now, bad);
      if (!row) {
        const read = files.read(root, id);
        const canonical = read && !read.error ? parsePackFile(read.raw) : null;
        plan.add.push({ id, ...fields, adopted: !meta, canonical, entry: canonical ? entryOf(id, fields, canonical) : null });
        continue;
      }
      if (!meta) continue;
      const changed = [...(fields.label !== row.label ? ['label'] : []), ...(fields.source !== row.source ? ['source'] : [])];
      if (!changed.length) continue;
      const read = files.read(root, id);
      const canonical = read && !read.error ? parsePackFile(read.raw) : null;
      plan.relabel.push({ id, label: fields.label, source: fields.source, fields: changed, canonical, entry: canonical ? entryOf(id, fields, canonical) : null });
    }
    const idSet = new Set(ids);
    for (const row of rows) if (!idSet.has(row.id) && !files.stat(root, row.id)) plan.remove.push(row.id);
    return plan;
  });
}

// Inside the replace's tx(), after the root change: the rows by `system`
// (the replace is a boot step), the links through the same reconcile a
// register runs (via 'replace'), and pack_index_hashes rewritten — the
// canonical hash of each file as it stands (what the next start compares),
// `drop` keys (the pre-move 'packs/index.json' on a root change) gone.
// legacy_hashes is never touched here. Returns the report.
export function applyPackReplace(db, plans, { drop = [] } = {}) {
  const orgs = [];
  for (const plan of plans) {
    const o = { org: plan.org, root: plan.root, idxPath: plan.idxPath, corrupt: plan.corrupt, added: [], relabelled: [], removed: [], skipped: [...plan.skipped], badFields: [...plan.badFields] };
    runWithOrg(plan.org, () => {
      for (const a of plan.add) {
        if (getPack(db, a.id)) continue;
        addPack(db, SYSTEM, {
          id: a.id, label: a.label, source: a.source, createdAt: a.createdAt, lastUsedAt: a.lastUsedAt,
          detail: { via: 'replace', ...(a.adopted ? { adopted: true } : {}) },
        });
        if (a.canonical) linkPack(db, SYSTEM, { packId: a.id, entry: a.entry, canonical: a.canonical, via: 'replace' });
        o.added.push(a.id);
      }
      for (const r of plan.relabel) {
        if (!getPack(db, r.id)) continue;
        upsertPack(db, SYSTEM, { id: r.id, label: r.label, source: r.source }, { detail: { via: 'replace' } });
        if (r.canonical) linkPack(db, SYSTEM, { packId: r.id, entry: r.entry, canonical: r.canonical, via: 'replace' });
        o.relabelled.push(r.id);
      }
      for (const id of plan.remove) {
        if (!getPack(db, id)) continue;
        removePack(db, SYSTEM, id, { detail: { reason: 'file gone', via: 'replace' } });
        o.removed.push(id);
      }
    });
    orgs.push(o);
  }
  const next = { ...(getMetaJson(db, 'pack_index_hashes', {}) || {}) };
  for (const key of drop) delete next[key];
  for (const plan of plans) next[plan.key] = plan.hash;
  putMeta(db, 'pack_index_hashes', JSON.stringify(next));
  const sum = (f) => orgs.reduce((n, o) => n + f(o), 0);
  return { orgs, totals: { added: sum((o) => o.added.length), relabelled: sum((o) => o.relabelled.length), removed: sum((o) => o.removed.length) } };
}

// `[store]   packs: <org>: added a, b · relabelled c · removed d (file gone) · index.json corrupt (…)` per org with something to say.
export function formatPackReplace(r) {
  const out = [];
  for (const o of r?.orgs ?? []) {
    const parts = [];
    if (o.added.length) parts.push(`added ${o.added.join(', ')}`);
    if (o.relabelled.length) parts.push(`relabelled ${o.relabelled.join(', ')}`);
    if (o.removed.length) parts.push(`removed ${o.removed.join(', ')} (file gone)`);
    if (o.corrupt) parts.push(`index.json corrupt (${o.corrupt}; labels kept from the store)`);
    if (o.badFields.length) parts.push(`index fields dropped: ${o.badFields.map((b) => `${b.id} ${b.field} (${b.reason})`).join(', ')}`);
    if (o.skipped.length) parts.push(`pack files skipped (name over ${TEXT_MAX} characters): ${o.skipped.join(', ')}`);
    if (parts.length) out.push(`[store]   packs: ${o.org}: ${parts.join(' · ')}`);
  }
  return out;
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
