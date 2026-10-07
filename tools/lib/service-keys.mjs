// tools/lib/service-keys.mjs — the service rules the server and the studio share.
//
// A service has no record of its own until the pack registry gives it one
// (STORE_PLAN slice 4): what a pack says about its service is derived from
// the canonical and from the catalogue entry `GET /api/packs` serves for it.
// Until this module existed the derivation lived twice — `serviceMetadata`
// in server/index.mjs, and the key / name / aggregate rules in studio/app.mjs
// — and the two could never be proven to agree. They now live here, once,
// and both sides import them: the server to write rows, the studio to draw
// its tiles. A rule changed here changes both at the same time.
//
// Browser-safe by construction: this module imports NOTHING (not even a
// sibling of tools/lib) and reads no `process.env` — the studio loads it
// from `/lib/service-keys.mjs`, so a caller that needs `listEnvironments`
// (tools/lib/adapter.mjs) passes the names in. tools/test-service-keys.mjs
// pins that textually.
//
// Every function is moved verbatim from its origin (named below) — the
// regexes and fallbacks are the ones a 0.5.0 studio applies today, so the
// rows the registry writes name exactly the services the tiles showed.

// The one key every service goes by (studio/app.mjs `normalizeServiceKey`):
// lowercase, every run of anything but [a-z0-9] → '-', edges trimmed.
// '' for all-junk input. `services.slug` is this.
export function normalizeServiceKey(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// { service, namespace, services } from a canonical (server/index.mjs
// `serviceMetadata`): `service` is the binding or the pack's name,
// `namespace` the binding, the service binding or the name; `services` is
// the sorted set of every name the bindings and the discovery annotations
// carry, split on ','.
export function serviceMetadata(canonical) {
  const bindings = canonical?.metadata?.bindings || {};
  const annotations = canonical?.metadata?.annotations || {};
  const services = new Set();
  const add = (value) => {
    for (const part of String(value || '').split(',')) {
      const service = part.trim();
      if (service) services.add(service);
    }
  };
  add(bindings.service);
  add(bindings.namespace);
  add(annotations['mcp.servicesDiscovered']);
  add(annotations['observogram.services']);
  add(annotations['tomograph.services']);   // legacy namespace (pre-rebrand packs)
  return {
    service: bindings.service || canonical?.metadata?.name || '',
    namespace: bindings.namespace || bindings.service || canonical?.metadata?.name || '',
    services: [...services].sort(),
  };
}

// Every name a catalogue entry spells for its service, as spelt, deduped,
// in the order service, namespace, name, services[] (studio/app.mjs
// `serviceNamesForPack`).
export function serviceNamesForPack(entry) {
  const names = new Set();
  const add = (value) => {
    const v = String(value || '').trim();
    if (v) names.add(v);
  };
  add(entry?.service);
  add(entry?.namespace);
  add(entry?.name);
  if (Array.isArray(entry?.services)) entry.services.forEach(add);
  return [...names];
}

// The name the entry's primary service goes by: service ‖ namespace ‖ name
// ‖ label, trimmed (studio/app.mjs `primaryServiceName`). A pack that names
// nothing falls back to its label — so a label is a service name, and two
// labels for the same content are two primaries (the registry's reconcile
// handles that; the rule itself is kept).
export function primaryServiceName(entry) {
  return String(entry?.service || entry?.namespace || entry?.name || entry?.label || '').trim();
}

// The primary's key (studio/app.mjs `serviceKeyForPack`).
export function serviceKeyForPack(entry) {
  return normalizeServiceKey(primaryServiceName(entry));
}

// A live aggregate — a snapshot of a whole MCP backend, naming many
// services — has no service of its own (studio/app.mjs `isLiveAggregatePack`).
// The regex is the studio's, kept verbatim and label-dependent on purpose
// (a `?source=mcp-notes.yaml` hint or a service literally called
// `mcp-gateway` makes its pack an aggregate; documented, not fixed).
// A live snapshot (`entry.live === 'snapshot'`, livePackKind below) is an
// aggregate whatever its label says — `Payments prod` never becomes one
// service's pack; a draft keeps the label rule (its links do not move).
export function isLiveAggregatePack(entry) {
  if (entry?.live === 'snapshot') return true;
  const text = [
    entry?.id, entry?.label, entry?.name, entry?.description, entry?.source,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(live|mcp|production-live|draft-from-mcp)\b/.test(text);
}

// Which kind of live pack a canonical is, from what it says of itself:
// 'snapshot' when it carries `observogram.live.mode: snapshot` (written by
// tools/fetch-live-pack.mjs buildSnapshotPack — an inventory of what is
// deployed), else 'scaffold' when it carries `mcp.refreshedAt` (every pack
// the fetcher drafts — schema-forced sections stamped mcp.scaffold.*),
// else null. A provenance claim like any annotation: a hand-uploaded pack
// can make it, and the pickers show what the pack says.
export function livePackKind(canonical) {
  const annotations = canonical?.metadata?.annotations;
  if (!annotations || typeof annotations !== 'object') return null;
  if (annotations['observogram.live.mode'] === 'snapshot') return 'snapshot';
  if (annotations['mcp.refreshedAt'] != null && annotations['mcp.refreshedAt'] !== '') return 'scaffold';
  return null;
}

// The longest key a `services.slug` column holds (server/store/rows.mjs
// `optionalText`): a longer one is dropped from the plan, never cut — a
// cut key would name a service nobody spelt.
const MAX_KEY_LENGTH = 200;

// The per-pack rule of the studio's `serviceCatalogue()`: the primary
// unless the pack is an aggregate, then each services[] entry — an
// aggregate's own primary key skipped, a member equal to a non-aggregate's
// primary folded into it (one entry, role 'primary', never a second as
// member). Keys deduped in first-seen order; an empty key or one over 200
// characters dropped. The result is the plan the registry links and the
// set of tiles the studio draws.
export function servicesForPack(entry) {
  const out = [];
  const seen = new Set();
  const add = (name, role) => {
    const key = normalizeServiceKey(name);
    if (!key || key.length > MAX_KEY_LENGTH || seen.has(key)) return;
    seen.add(key);
    out.push({ name: String(name).trim(), key, role });
  };
  const aggregate = isLiveAggregatePack(entry);
  const primaryKey = serviceKeyForPack(entry);
  if (!aggregate) add(primaryServiceName(entry), 'primary');
  for (const svc of Array.isArray(entry?.services) ? entry.services : []) {
    if (aggregate && normalizeServiceKey(svc) === primaryKey) continue;
    add(svc, 'member');
  }
  return out;
}

// The catalogue entry an uploaded pack yields — exactly what `GET /api/packs`
// serves for it (server/index.mjs `uploadedMeta` + `catalogEntryForUpload`),
// built from the registry's record: the label falls back to the pack's name
// and then to its id, the description names the source, `source` is the
// catalogue's 'uploaded' marker. One builder, so the rows the registry
// writes (`servicesForPack(entry)`) and the tiles the studio draws from the
// same entry can never name different services. `environments` comes from
// the caller (`listEnvironments(canonical)`) to keep this module import-free.
//
// `live` ('scaffold' | 'snapshot', livePackKind) is present only for a live
// pack: every other entry is byte-identical to what it was.
export function catalogEntryOf(id, { label = null, source = 'upload' } = {}, canonical, environments = []) {
  const svc = serviceMetadata(canonical);
  const live = livePackKind(canonical);
  return {
    id,
    label: label || canonical?.metadata?.name || id,
    description: `Uploaded pack — ${source}`,
    name: canonical?.metadata?.name,
    version: canonical?.metadata?.version,
    binding: canonical?.metadata?.binding,
    criticality: canonical?.metadata?.bindings?.criticality,
    service: svc.service,
    namespace: svc.namespace,
    services: svc.services,
    environments,
    ...(live ? { live } : {}),
    source: 'uploaded',
    ok: true,
  };
}
