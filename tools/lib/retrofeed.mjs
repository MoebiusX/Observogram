// tools/lib/retrofeed.mjs
//
// Repo retrofeed — the reverse arrow of remediation (VALUE_BACKLOG item 4).
// Deploy closes declared-not-live by pushing compiled artefacts INTO the
// platform; retrofeed closes live-not-declared by adopting verified shadow
// signals BACK into the declared pack, so the repo's contract catches up
// with production reality instead of silently lagging it.
//
// Pure and DOM-free: input is the declared canonical pack plus the diff's
// onlyInB entries (layered artefacts whose `spec` is the canonical
// sub-object the adapter projected them from); output is the additions, the
// updated canonical, and an honest skipped-list for everything that cannot
// be re-declared mechanically. The caller validates the result against the
// schema before letting it out — retrofeed must never produce a pack that
// fails its own spec.

import { parseDiffKey } from '../../studio/verify-deploy.mjs';

const clone = (v) => JSON.parse(JSON.stringify(v));

// Families the retrofeed can re-declare, in dependency order (SLIs before
// the SLOs that reference them, SLOs before the burn-rate alerts bound to
// them). Each entry: where the spec object lands, and how to detect a
// pre-existing declaration so we never duplicate.
const FAMILIES = [
  { kind: 'sli',            path: ['slis'],                          exists: (spec, s) => (spec.slis || []).some(x => x.id === s.id) },
  { kind: 'slo',            path: ['slos'],                          exists: (spec, s) => (spec.slos || []).some(x => x.id === s.id) },
  { kind: 'backend',        path: ['telemetry', 'backends'],         exists: (spec, s) => (spec.telemetry?.backends || []).some(x => x.product === s.product && x.signal === s.signal) },
  { kind: 'recording_rule', path: ['queries', 'recording_rules'],    exists: (spec, s) => (spec.queries?.recording_rules || []).some(x => x.name === s.name) },
  { kind: 'derived_view',   path: ['queries', 'derived_views'],      exists: (spec, s) => (spec.queries?.derived_views || []).some(x => x.id === s.id) },
  { kind: 'dashboard',      path: ['dashboards'],                    exists: (spec, s) => (spec.dashboards || []).some(x => x.id === s.id) },
  { kind: 'alert_route',    path: ['alerting', 'routes'],            exists: () => false /* severities may repeat */ },
  { kind: 'burn_rate',      path: ['policy', 'burn_rate_alerts'],    exists: (spec, s) => (spec.policy?.burn_rate_alerts || []).some(x => x.slo === s.slo) },
];
const FAMILY_BY_KIND = new Map(FAMILIES.map(f => [f.kind, f]));
const ORDER = new Map(FAMILIES.map((f, i) => [f.kind, i]));

function ensurePath(spec, path) {
  let node = spec;
  for (const seg of path.slice(0, -1)) {
    if (!node[seg] || typeof node[seg] !== 'object') node[seg] = {};
    node = node[seg];
  }
  const leaf = path[path.length - 1];
  if (!Array.isArray(node[leaf])) node[leaf] = [];
  return node[leaf];
}

function idOf(kind, spec) {
  if (kind === 'recording_rule') return spec.name;
  if (kind === 'backend') return `${spec.product}/${spec.signal}`;
  if (kind === 'burn_rate') return spec.slo;
  if (kind === 'alert_route') return spec.severity;
  return spec.id;
}

// entries: diff onlyInB entries ({ key, artefact }). Returns
// { adopted, skipped, updatedCanonical, fragment } — updatedCanonical is a
// deep copy; the input pack is never mutated. `now` is caller-supplied so
// output stays deterministic (golden-testable).
export function retrofeedShadowSignals(canonicalA, entries, { now } = {}) {
  const updated = clone(canonicalA || {});
  if (!updated.spec || typeof updated.spec !== 'object') updated.spec = {};
  const spec = updated.spec;

  const adopted = [];
  const skipped = [];
  const fragment = {};

  // Dependency order: an SLO adopted in this pass may satisfy a burn-rate
  // alert adopted in the same pass.
  const sorted = [...(entries || [])].map(e => ({ e, p: parseDiffKey(e?.key) }))
    .sort((a, b) => (ORDER.get(a.p?.kind) ?? 99) - (ORDER.get(b.p?.kind) ?? 99));

  for (const { e, p } of sorted) {
    const key = e?.key || '(no key)';
    if (!p) { skipped.push({ key, kind: null, reason: 'unparseable diff key' }); continue; }
    const fam = FAMILY_BY_KIND.get(p.kind);
    const art = e.artefact || {};
    if (!fam) {
      // Honest non-goals: expand-level inventory (metrics, panels), scrape
      // jobs, pipeline stages, L2X products — evidence, not mechanically
      // re-declarable spec. Name the reason instead of silently dropping.
      const reason = (p.kind === 'metric' || p.kind === 'panel')
        ? 'inventory-level evidence, not a declarable spec entry'
        : `no retrofeed mapping for family '${p.kind}' yet`;
      skipped.push({ key, kind: p.kind, reason });
      continue;
    }
    if (!art.spec || typeof art.spec !== 'object') {
      skipped.push({ key, kind: p.kind, reason: 'live artefact carries no canonical spec to adopt' });
      continue;
    }
    const s = clone(art.spec);
    if (fam.exists(spec, s)) {
      skipped.push({ key, kind: p.kind, reason: `already declared (${idOf(p.kind, s) ?? 'same identity'})` });
      continue;
    }
    // Referential guards — adopting a dangling reference would produce a
    // pack that lies in a different way.
    if (p.kind === 'slo' && !(spec.slis || []).some(x => x.id === s.sli)) {
      skipped.push({ key, kind: p.kind, reason: `references SLI '${s.sli}' which is not declared (adopt the SLI too)` });
      continue;
    }
    if (p.kind === 'burn_rate' && !(spec.slos || []).some(x => x.id === s.slo)) {
      skipped.push({ key, kind: p.kind, reason: `references SLO '${s.slo}' which is not declared (adopt the SLO too)` });
      continue;
    }
    ensurePath(spec, fam.path).push(s);
    ensurePath(fragment, fam.path.length > 1 ? fam.path : fam.path).push(clone(s));
    adopted.push({ key, kind: p.kind, id: idOf(p.kind, s) ?? null });
  }

  // Provenance: the pack itself records what was adopted from live and when.
  if (adopted.length) {
    if (!updated.metadata) updated.metadata = {};
    if (!updated.metadata.annotations || typeof updated.metadata.annotations !== 'object') updated.metadata.annotations = {};
    updated.metadata.annotations['observogram.retrofeed.adoptedAt'] = now || new Date().toISOString();
    updated.metadata.annotations['observogram.retrofeed.adopted'] =
      adopted.map(a => `${a.kind}:${a.id}`).join(' · ');
  }

  return { adopted, skipped, updatedCanonical: updated, fragment: adopted.length ? { spec: fragment } : null };
}
