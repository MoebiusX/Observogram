// tools/lib/audit-report.mjs
//
// The service audit report (GAP batch 2, B3.5): ONE document per pack that
// says, in order, how the pack grades against the maturity rubric, what it
// still carries as placeholders, what a reviewer has recorded on its
// artefacts (verdicts), which findings its service has waived, how its
// artefacts cover the taxonomy's families, which nodes would blind an SLO
// if they died, and whether its remediations answer to an alert. Every
// section reads an engine this repository already ships — nothing here
// grades, scores or classifies on its own:
//
//   conformance   the /conformance body (tools/lib/conformance.mjs through
//                 server/index.mjs conformanceReportFor — the engine's numbers
//                 headline; a waivers overlay's `effective` sits beside them,
//                 never in their place)
//   placeholders  tools/lib/pack-conformance.mjs packConformance(canonical),
//                 plus the Conformance view's two template counts (library
//                 todos, Scaffold artefacts)
//   assessments   the verdict rows (server/verdict-admin.mjs verdictsDocument,
//                 or a --verdicts file), one state per artefact; `unreviewed`
//                 is the absence of a row
//   waivers       the service's waiver views (server/waiver-admin.mjs
//                 listWaiverViews, or a --waivers file); a revoked row is
//                 history and is never counted active
//   coverage      tools/lib/artefact-classify.mjs — every family, how many
//                 artefacts the pack has in it and whether a rubric clause
//                 that applies at the graded tier names the family
//   goesBlind     tools/lib/blast-radius.mjs over the traceability graph's
//                 shape (the graph arrives as a shape: traceability-graph.mjs
//                 needs the PromQL parser, which this module must not import)
//   responsePath  tools/lib/remediation-flow.mjs buildRemediationFlowModel
//                 over the adapted pack alone (`compared: false` by construction)
//
// Two artefact addresses appear in one document and each engine's own is
// printed (docs/ADAPTER.md "Artefact addresses"): a verdict names the
// adapter's positional id (`SLI-01`, with its card key `L1/SLI-01`), a waiver
// or a placeholder row names the canonical symbol (`slos.<id>`). Nothing here
// unifies them.
//
// Honesty rules. A section whose source was not given says so (`available:
// false`, "not recorded by this build" — the CLI and the static bundle have
// no store); a section whose source is empty says "none recorded". A verdict
// never feeds the conformance numbers. Determinism: the same inputs render
// the same bytes — `generatedAt` is the caller's (null for an unstamped
// report), every list is sorted by a stated key, nothing reads a clock.
//
// Browser-safe, vendorable (a listed module): no Node APIs, no DOM. Imports
// ./artefact-classify.mjs, ./blast-radius.mjs, ./brand.mjs,
// ./pack-conformance.mjs and ./remediation-flow.mjs.

import { FAMILIES, FAMILY_HOME, familyOf } from './artefact-classify.mjs';
import { blastRadiusIndex, blastRadiusOf } from './blast-radius.mjs';
import { DEFAULT_BRAND, brandChrome, brandTokensCss, escapeHtml } from './brand.mjs';
import { packConformance } from './pack-conformance.mjs';
import { buildRemediationFlowModel } from './remediation-flow.mjs';

export const AUDIT_REPORT_VERSION = 1;
// A reviewer's states (server/verdict-admin.mjs VERDICT_STATUSES plus the absence of a row).
export const VERDICT_STATES = Object.freeze(['unreviewed', 'trusted', 'suspect', 'failed']);
// A waiver view's states (tools/lib/waivers.mjs WAIVER_STATES) plus `unknown` for a row the reader could not state.
export const WAIVER_STATUSES = Object.freeze(['active', 'expired', 'revoked', 'unknown']);
export const COVERAGE_STATUSES = Object.freeze(['present', 'absent', 'missing']);
export const DEFAULT_RISK_TOP = 10;
export const RISK_TOP_MAX = 100;
// The walk every artefact count in this repository takes (server/verdict-admin.mjs
// artefactIndex, studio/static-backend.mjs artefactCount): the board's layers, L4 by subgroup.
export const LAYER_ORDER = Object.freeze(['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV']);
export const L4_SUBGROUPS = Object.freeze(['policy', 'alerting', 'healing']);
export const SOURCES = Object.freeze(['Declared', 'Verified', 'Scaffold']);

// Which families a rubric clause's presence test names (tools/lib/conformance.mjs
// RUBRIC, every id): a family a clause that applies at the graded tier names
// is `required` in the coverage section — a pack with none of it is `missing`
// there, not `absent`. A referential clause (L2X: declared extended backends
// resolve; it passes on absence) names no family.
export const CLAUSE_FAMILIES = Object.freeze({
  'L1.MUST.availability_slo': ['sli', 'slo'],
  'L1.MUST.latency_slo': ['sli', 'slo'],
  'L1.SHOULD.domain_slo': ['slo'],
  'L1.MUST.sli_covered_by_slo': ['sli', 'slo'],
  'L2.MUST.otlp_receiver': ['pipeline_receiver'],
  'L2.MUST.service_name_required': ['otel'],
  'L2.MUST.semconv_floor': ['otel'],
  'L2.MUST.semconv_current': ['otel'],
  'L2.MUST.resource_attrs_5plus': ['otel'],
  'L2.MUST.log_correlation': ['otel'],
  'L2.MUST.metrics_exporter': ['pipeline_exporter_metrics'],
  'L2.MUST.logs_and_traces_exporters': ['pipeline_exporter_logs', 'pipeline_exporter_traces'],
  'L2.MUST.tail_sampling': ['pipeline_processor'],
  'L2.MUST.metrics_logs_traces_backends': ['backend'],
  'L2.SHOULD.backend_gating_enforce': ['backend'],
  'L2X.MUST.extended_backend_refs_resolve': [],
  'L3.MUST.recording_rule_per_slo': ['recording_rule'],
  'L3.SHOULD.derived_view': ['derived_view'],
  'L3.MUST.service_overview_dashboard': ['dashboard'],
  'L3.MUST.slo_burn_dashboard': ['dashboard'],
  'L3.MUST.tier1_dashboards': ['dashboard'],
  'L4.MUST.multi_window_burn_rate': ['burn_rate'],
  'L4.SHOULD.forecast_on_availability': ['forecast'],
  'L4.MUST.tier1_voice_route': ['alert_route'],
  'L4.MUST.tier1_at_least_one_automation': ['remediation'],
  'L5.SHOULD.tier1_release_gate': ['synthetic'],
  'L5.MUST.synthetic_probe': ['synthetic'],
  'L5.MUST.tier1_chaos_for_each_slo': ['chaos'],
  'L5.MUST.tier2_chaos_staging': ['chaos'],
  'L5.MUST.tier1_weekly_prod_chaos': ['chaos'],
});

// ---------- helpers ----------

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v) => (typeof v === 'string' ? v : v == null ? null : String(v));
const num = (v, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cardKey = (layer, sub, id) => (sub ? `${layer}/${sub}/${id}` : `${layer}/${id}`);

/** Every artefact of an adapted pack in walk order: [{ layer, sub, artefact, key }]. */
export function flattenArtefacts(adapted) {
  const layers = adapted?.layers || {};
  const out = [];
  for (const layer of LAYER_ORDER) {
    if (layer === 'L4') {
      for (const sub of L4_SUBGROUPS) for (const a of layers.L4?.[sub] || []) out.push({ layer, sub, artefact: a, key: cardKey(layer, sub, a?.id) });
    } else {
      for (const a of layers[layer] || []) out.push({ layer, sub: null, artefact: a, key: cardKey(layer, null, a?.id) });
    }
  }
  return out;
}

// ---------- 1. conformance ----------

const clauseRow = (cl, wv) => ({
  id: cl.id,
  dimension: cl.dimension,
  severity: cl.severity,
  minTier: cl.minTier,
  description: cl.description,
  specRef: cl.specRef ?? null,
  families: CLAUSE_FAMILIES[cl.id] ?? [],
  ...(wv ? { waiver: { status: wv.status, subjects: wv.subjects ?? null, waivers: (wv.waivers || []).map(waiverRow) } } : {}),
});

/**
 * The /conformance body split the way the report reads it: blocking (a MUST
 * that applies and fails, no waiver covering it whole), waived (a failing
 * clause the report's `waivers` block covers whole), recommended (a failing
 * SHOULD), passed, notApplicable. The engine's numbers are quoted as they
 * are; `effective` is the overlay's when the body carries one, else null.
 */
export function splitClauses(conformance) {
  const c = isObj(conformance) ? conformance : {};
  const wv = isObj(c.waivers) && isObj(c.waivers.clauses) ? c.waivers.clauses : null;
  const groups = { blocking: [], waived: [], recommended: [], passed: [], notApplicable: [] };
  for (const cl of Array.isArray(c.clauses) ? c.clauses : []) {
    if (!isObj(cl)) continue;
    const row = clauseRow(cl, wv?.[cl.id] ?? null);
    if (!cl.applies) groups.notApplicable.push(row);
    else if (cl.pass) groups.passed.push(row);
    else if (row.waiver?.status === 'waived') groups.waived.push(row);
    else (cl.severity === 'MUST' ? groups.blocking : groups.recommended).push(row);
  }
  const eff = isObj(c.waivers) && isObj(c.waivers.effective) ? c.waivers.effective : null;
  return {
    declaredTier: str(c.declaredTier),
    conformant: c.conformant === true,
    scorePercent: num(c.scorePercent, null),
    mustPercent: num(c.mustPercent, null),
    must: { passed: num(c.must?.passed), total: num(c.must?.total) },
    should: { passed: num(c.should?.passed), total: num(c.should?.total) },
    byDimension: isObj(c.byDimension) ? c.byDimension : {},
    effective: eff ? {
      conformant: eff.conformant === true,
      scorePercent: num(eff.scorePercent, null),
      mustPercent: num(eff.mustPercent, null),
      must: { passed: num(eff.must?.passed), total: num(eff.must?.total) },
      should: { passed: num(eff.should?.passed), total: num(eff.should?.total) },
      byDimension: isObj(eff.byDimension) ? eff.byDimension : {},
    } : null,
    counts: Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.length])),
    clauses: groups,
    onPlaceholder: Array.isArray(c.onPlaceholder) ? c.onPlaceholder.map((x) => (typeof x === 'string' ? x : x?.id)).filter(Boolean) : null,
  };
}

// ---------- 2. placeholders ----------

/**
 * packConformance(canonical) — the rows and counts as the engine states them
 * — beside the Conformance view's two template counts: `library.todo.*`
 * annotations and Scaffold artefacts of the adapted pack.
 */
export function placeholdersOf(canonical, adapted) {
  const report = packConformance(canonical || {});
  const ann = canonical?.metadata?.annotations || {};
  const todos = Object.keys(ann).filter((k) => k.startsWith('library.todo.')).length;
  const scaffolds = flattenArtefacts(adapted).filter(({ artefact }) => artefact?.source === 'Scaffold').length;
  return {
    conformant: report.conformant,
    markers: report.markers,
    writers: report.writers,
    counts: report.counts,
    templates: { todos, scaffolds },
    rows: report.rows.map(({ symbol, path, field, needs, source, hint, state, marker, writer, rule }) => ({ symbol, path, field, needs, source, hint, state, marker, writer, rule })),
  };
}

// ---------- 3. assessments (verdicts) ----------

const verdictRow = (v) => ({
  artefactKey: str(v.artefactKey ?? v.artefact),
  key: str(v.key),
  family: str(v.family),
  title: str(v.title),
  state: VERDICT_STATES.includes(v.state ?? v.status) ? (v.state ?? v.status) : 'unreviewed',
  reason: str(v.reason),
  at: str(v.at ?? v.setAt),
  by: str(v.by ?? v.actor),
});

/**
 * The reviewer's record over the pack's artefacts. `rows` null → the source
 * was not given (`available: false`); [] → none recorded. Every artefact the
 * pack has and no row names is `unreviewed`; a row naming an artefact the
 * pack no longer has is `orphaned`.
 */
export function assessmentSummary(rows, adapted) {
  const all = flattenArtefacts(adapted);
  const available = Array.isArray(rows);
  const views = available ? rows.filter(isObj).map(verdictRow).sort((a, b) => cmp(a.artefactKey, b.artefactKey)) : [];
  const known = new Set(all.map(({ artefact }) => str(artefact?.id)));
  const counts = Object.fromEntries(VERDICT_STATES.map((s) => [s, 0]));
  let orphaned = 0;
  for (const v of views) {
    if (!known.has(v.artefactKey)) { orphaned += 1; continue; }
    counts[v.state] += 1;
  }
  counts.unreviewed = all.length - (views.length - orphaned);
  return { available, artefacts: all.length, counts, orphaned, verdicts: views };
}

// ---------- 4. waivers ----------

const waiverRow = (w) => ({
  id: w.id ?? null,
  artefactKey: str(w.artefactKey ?? w.artefactId),
  rule: str(w.rule ?? w.ruleId),
  reason: str(w.reason),
  expiresAt: str(w.expiresAt),
  at: str(w.at ?? w.createdAt),
  by: str(w.by ?? w.author),
  status: WAIVER_STATUSES.includes(w.status ?? w.state) ? (w.status ?? w.state) : 'unknown',
  ...(w.revokedAt ? { revokedAt: str(w.revokedAt), revokedBy: str(w.revokedBy), revokeReason: str(w.revokeReason) } : {}),
});

/** The service's waivers: counts by state, `active` first then newest; null rows → not given. */
export function waiverSummary(rows) {
  const available = Array.isArray(rows);
  const views = available ? rows.filter(isObj).map(waiverRow) : [];
  const rank = (s) => WAIVER_STATUSES.indexOf(s);
  views.sort((a, b) => rank(a.status) - rank(b.status) || cmp(b.at ?? '', a.at ?? '') || cmp(String(a.id), String(b.id)));
  const counts = Object.fromEntries(WAIVER_STATUSES.map((s) => [s, 0]));
  for (const w of views) counts[w.status] += 1;
  return { available, counts, waivers: views };
}

// ---------- 5. coverage by family ----------

/**
 * Every family of the taxonomy (tools/lib/artefact-classify.mjs FAMILIES,
 * `unknown` only when the pack has one) with the artefacts the pack has in it
 * and their sources. `required` is "named by a presence clause that applies
 * at the graded tier" (CLAUSE_FAMILIES over the report's applicable clauses);
 * `missing` is required with none, `absent` not required with none.
 */
export function coverageByFamily(adapted, conformance) {
  const counts = new Map(FAMILIES.map((f) => [f, { count: 0, declared: 0, verified: 0, scaffold: 0 }]));
  for (const { artefact } of flattenArtefacts(adapted)) {
    const family = familyOf(artefact);
    const c = counts.get(family) ?? counts.set(family, { count: 0, declared: 0, verified: 0, scaffold: 0 }).get(family);
    c.count += 1;
    if (artefact?.source === 'Verified') c.verified += 1;
    else if (artefact?.source === 'Scaffold') c.scaffold += 1;
    else c.declared += 1;
  }
  const required = new Map();
  for (const cl of Array.isArray(conformance?.clauses) ? conformance.clauses : []) {
    if (!isObj(cl) || !cl.applies) continue;
    for (const f of CLAUSE_FAMILIES[cl.id] ?? []) (required.get(f) ?? required.set(f, []).get(f)).push(cl.id);
  }
  const families = [];
  for (const [family, c] of counts) {
    if (family === 'unknown' && c.count === 0) continue;
    const home = FAMILY_HOME[family] ?? null;
    const clauses = required.get(family) ?? [];
    families.push({
      family,
      label: home?.label ?? null,
      layer: home?.layer ?? null,
      group: home?.group ?? null,
      ...c,
      required: clauses.length > 0,
      clauses,
      status: c.count > 0 ? 'present' : clauses.length ? 'missing' : 'absent',
    });
  }
  const summary = Object.fromEntries(COVERAGE_STATUSES.map((s) => [s, families.filter((f) => f.status === s).length]));
  return { families, counts: summary };
}

// ---------- 6. goes-blind risks ----------

const listing = ({ key, label }) => ({ key, label });

/**
 * The nodes whose death would blind the most (tools/lib/blast-radius.mjs over
 * a graph shape), the top `top` by what goes blind — total, then the SLOs,
 * then the weight, then the key — and how many nodes would blind at least one
 * SLO. `shape` null → not computed (`available: false`): the graph needs the
 * PromQL parser the caller may not have.
 */
export function goesBlindRisks(shape, { top = DEFAULT_RISK_TOP } = {}) {
  if (!isObj(shape)) return { available: false, top: clampTop(top), nodes: 0, edges: 0, sloBlindingNodes: 0, risks: [] };
  const n = clampTop(top);
  const index = blastRadiusIndex(shape);
  const rows = [];
  let sloBlinding = 0;
  for (const [key, summary] of index) {
    if (summary.slos > 0) sloBlinding += 1;
    if (summary.total === 0) continue;
    rows.push({ key, summary });
  }
  rows.sort((a, b) => b.summary.total - a.summary.total || b.summary.slos - a.summary.slos || b.summary.alerts - a.summary.alerts || cmp(a.key, b.key));
  const risks = rows.slice(0, n).map(({ key, summary }) => {
    const r = blastRadiusOf(shape, key);
    return {
      key,
      kind: r.kind,
      label: r.label,
      summary,
      weight: r.blinded.weight,
      byKind: r.blinded.byKind,
      unprotected: { slos: r.unprotected.slos.map(listing), alerts: r.unprotected.alerts.map(listing) },
    };
  });
  const nodes = Array.isArray(shape.nodes) ? shape.nodes.length : shape.nodes instanceof Map ? shape.nodes.size : isObj(shape.nodes) ? Object.keys(shape.nodes).length : 0;
  return { available: true, top: n, nodes, edges: Array.isArray(shape.edges) ? shape.edges.length : 0, sloBlindingNodes: sloBlinding, risks };
}

function clampTop(top) {
  const n = Math.trunc(num(top, DEFAULT_RISK_TOP));
  return Math.min(RISK_TOP_MAX, Math.max(1, n));
}

// ---------- 7. response path ----------

const refOf = (r) => (isObj(r) ? { id: str(r.id), symbol: str(r.symbol), identityKey: str(r.identityKey), family: str(r.family), title: str(r.title), source: str(r.source) } : null);

/** tools/lib/remediation-flow.mjs over the adapted pack alone: declared, never compared. */
export function responsePath(adapted) {
  const m = buildRemediationFlowModel({ pack: adapted, diff: null });
  return {
    configured: m.configured,
    compared: false,
    counts: { ...m.counts },
    links: m.links.map((l) => ({ remediation: refOf(l.remediation), trigger: str(l.trigger), tier: l.tier, state: l.state, placeholder: l.placeholder === true, alerts: l.alerts.map((a) => ({ ...refOf(a.ref), state: a.state })), routes: l.routes.map(refOf) })),
    unresolved: m.unresolved.map((u) => ({ remediation: refOf(u.remediation), trigger: str(u.trigger), placeholder: u.placeholder === true, suggestions: u.suggestions.map((s) => ({ ...refOf(s.ref), score: num(s.score, null) })), annotation: u.steps.find((s) => s.kind === 'annotate')?.annotation ?? null })),
    uncovered: m.uncovered.map((u) => ({ ...refOf(u.ref), state: u.state })),
    families: m.families.map((f) => ({ ...f })),
    warnings: m.warnings.map(String),
  };
}

// ---------- the document ----------

const sourceCounts = (adapted) => {
  const counts = Object.fromEntries(SOURCES.map((s) => [s, 0]));
  for (const { artefact } of flattenArtefacts(adapted)) counts[SOURCES.includes(artefact?.source) ? artefact.source : 'Declared'] += 1;
  return counts;
};

/**
 * buildAuditReport(input) → the report document, keys in this order:
 * reportVersion, generator, generatedAt, pack, tier, conformance,
 * placeholders, assessments, waivers, coverage, goesBlind, responsePath.
 *
 * input: {
 *   pack: { id, label?, source? }, canonical (the overlaid canonical the
 *   conformance body graded), adapted (adapt(canonical)), conformance (the
 *   /conformance body), graph (a traceability graph SHAPE or null), verdicts
 *   (rows or null = not recorded by this build), waivers (rows or null),
 *   environment, generatedAt (an ISO string or null — never a clock read
 *   here), generator ({ name, version }), top (the goes-blind listing size)
 * }
 */
export function buildAuditReport(input = {}) {
  const { pack = {}, canonical = {}, adapted = {}, conformance = {}, graph = null, verdicts = null, waivers = null, environment = null, generatedAt = null, generator = null, top = DEFAULT_RISK_TOP } = input;
  const meta = canonical?.metadata || {};
  const tier = isObj(conformance?.tier) ? conformance.tier : {
    graded: str(conformance?.declaredTier), pack: str(meta.bindings?.criticality), from: 'pack', service: null, environment: null, mismatch: false,
  };
  return {
    reportVersion: AUDIT_REPORT_VERSION,
    generator: isObj(generator) ? { name: str(generator.name), version: str(generator.version) } : null,
    generatedAt: str(generatedAt),
    pack: {
      id: str(pack.id),
      label: str(pack.label),
      source: str(pack.source),
      name: str(meta.name),
      version: str(meta.version),
      service: str(meta.bindings?.service ?? adapted?.meta?.service),
      environment: str(environment),
      environments: Array.isArray(adapted?.meta?.environments) ? adapted.meta.environments.map(String) : [],
      criticality: str(meta.bindings?.criticality),
      artefacts: flattenArtefacts(adapted).length,
      sources: sourceCounts(adapted),
    },
    tier: {
      graded: str(tier.graded), pack: str(tier.pack), from: str(tier.from) ?? 'pack',
      service: isObj(tier.service) ? { id: tier.service.id ?? null, slug: str(tier.service.slug) } : null,
      environment: isObj(tier.environment) ? { id: tier.environment.id ?? null, name: str(tier.environment.name) } : null,
      mismatch: tier.mismatch === true,
    },
    conformance: splitClauses(conformance),
    placeholders: placeholdersOf(canonical, adapted),
    assessments: assessmentSummary(verdicts, adapted),
    waivers: waiverSummary(waivers),
    coverage: coverageByFamily(adapted, conformance),
    goesBlind: goesBlindRisks(graph, { top }),
    responsePath: responsePath(adapted),
  };
}

/** `<pack-id>.audit-report.<json|html>` — the id made file-safe. */
export function auditReportFilename(packId, format = 'json') {
  const safe = String(packId ?? 'pack').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'pack';
  return `${safe}.audit-report.${format === 'html' ? 'html' : 'json'}`;
}

// ---------- the HTML ----------

// The report's own layout over the design kit (studio/design-kit.css `.og-*`
// over studio/design-tokens.css `--og-*`): one zone, `.ar-*`, light theme,
// no script, nothing fixed or sticky, print-friendly.
export const REPORT_CSS = `
.ar-page { max-width: 1080px; margin: 0 auto; padding: 32px 24px 48px; }
.ar-head { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px 24px; align-items: baseline; padding-bottom: 16px; border-bottom: 1px solid var(--og-line); }
.ar-brand { font: var(--og-h3-font); color: var(--og-muted); }
.ar-meta { display: flex; flex-wrap: wrap; gap: 6px 18px; margin: 12px 0 0; padding: 0; list-style: none; color: var(--og-text-2); font: var(--og-label-font); }
.ar-meta li b { color: var(--og-text); font-weight: 550; }
.ar-toc { display: flex; flex-wrap: wrap; gap: 6px 14px; margin: 20px 0 0; padding: 0; list-style: none; font: var(--og-label-font); }
.ar-toc a { color: var(--og-accent); text-decoration: none; }
.ar-toc a:hover, .ar-toc a:focus-visible { text-decoration: underline; }
.ar-section { margin-top: 36px; }
.ar-section > .og-h2 { margin-bottom: 4px; }
.ar-lede { margin: 0 0 14px; color: var(--og-text-2); }
.ar-stats { display: grid; grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); gap: 12px; margin: 14px 0; }
.ar-table { width: 100%; border-collapse: collapse; margin: 12px 0; font-size: 14px; }
.ar-table th, .ar-table td { text-align: left; vertical-align: top; padding: 7px 10px; border-bottom: 1px solid var(--og-line); }
.ar-table th { font: var(--og-eyebrow-font); letter-spacing: var(--og-eyebrow-tracking); text-transform: uppercase; color: var(--og-muted); }
.ar-table td.ar-num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.ar-table .og-code { font-size: 13px; word-break: break-word; }
.ar-none { margin: 10px 0; color: var(--og-muted); font-style: italic; }
.ar-sub { margin: 18px 0 6px; }
.ar-foot { margin-top: 44px; padding-top: 16px; border-top: 1px solid var(--og-line); display: flex; flex-wrap: wrap; justify-content: space-between; gap: 8px 24px; color: var(--og-muted); font: var(--og-label-font); }
.ar-foot a { color: var(--og-accent); }
@media print { .ar-page { padding: 0; } .ar-toc { display: none; } .ar-stats > * { break-inside: avoid; } }
`;

const e = escapeHtml;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const pct = (v) => (v === null || v === undefined ? '—' : `${v}%`);
const dash = (v) => (v === null || v === undefined || v === '' ? '—' : String(v));
const tone = (ok, warn = false) => (ok ? 'ok' : warn ? 'warn' : 'fail');
const stat = (label, value, note = '', t = '') => `<div class="og-stat${t ? ` og-stat--${t}` : ''}"><span class="og-stat__label">${e(label)}</span><span class="og-stat__value">${e(String(value))}</span>${note ? `<span class="og-stat__note">${e(note)}</span>` : ''}</div>`;
const pill = (text, t) => `<span class="og-pill${t ? ` og-pill--${t}` : ''}">${e(text)}</span>`;
const none = (text) => `<p class="ar-none">${e(text)}</p>`;
const table = (heads, rows) => (rows.length ? `<table class="ar-table"><thead><tr>${heads.map((h) => `<th>${e(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.join('')}</tr>`).join('')}</tbody></table>` : '');
const td = (v, cls = '') => `<td${cls ? ` class="${cls}"` : ''}>${e(dash(v))}</td>`;
const code = (v) => `<td><span class="og-code">${e(dash(v))}</span></td>`;
const tdHtml = (html) => `<td>${html}</td>`;

const NOT_RECORDED = 'Not recorded by this build: the source needs the server (its store holds the record); the CLI and the static bundle have none.';

function clauseRows(rows, withWaiver = false) {
  return rows.map((r) => [
    code(r.id), td(r.severity), td(r.description),
    ...(withWaiver ? [tdHtml(r.waiver ? r.waiver.waivers.map((w) => `${e(w.rule)}${w.artefactKey ? ` · <span class="og-code">${e(w.artefactKey)}</span>` : ''} — ${e(dash(w.reason))} (until ${e(dash(w.expiresAt))}, by ${e(dash(w.by))})`).join('<br>') : '—')] : []),
  ]);
}

function conformanceHtml(c, tier) {
  const eff = c.effective;
  const headline = c.conformant ? 'Conformant' : c.must.total === 0 ? 'No required clause applies' : 'Not conformant';
  return `
<section class="ar-section" id="conformance">
  <h2 class="og-h2">1. Conformance</h2>
  <p class="ar-lede">The maturity rubric at ${e(dash(c.declaredTier))} (graded from the ${e(dash(tier.from))}${tier.mismatch ? `; the record's tier differs from the pack's ${e(dash(tier.pack))}` : ''}). The engine's numbers headline; a waiver never rewrites them.</p>
  <div class="ar-stats">
    ${stat('Decision', headline, c.conformant ? 'every required clause passes' : `${plural(c.counts.blocking, 'blocking clause')}`, tone(c.conformant, c.must.total === 0))}
    ${stat('Required (MUST)', `${c.must.passed} / ${c.must.total}`, pct(c.mustPercent), tone(c.must.passed === c.must.total))}
    ${stat('Recommended (SHOULD)', `${c.should.passed} / ${c.should.total}`, 'lower the score; never block')}
    ${stat('Weighted score', pct(c.scorePercent), 'not the conformance decision')}
    ${eff ? stat('With waivers', `${eff.must.passed} / ${eff.must.total}`, `effective · ${plural(c.counts.waived, 'waived clause')} · ${pct(eff.scorePercent)}`, eff.conformant ? 'ok' : 'warn') : ''}
  </div>
  <h3 class="og-h3 ar-sub">Blocking (${c.counts.blocking})</h3>
  ${c.counts.blocking ? table(['Clause', 'Severity', 'Requirement'], clauseRows(c.clauses.blocking)) : none('No required clause blocks.')}
  ${eff ? `<h3 class="og-h3 ar-sub">Waived (${c.counts.waived})</h3>${c.counts.waived ? table(['Clause', 'Severity', 'Requirement', 'Waiver'], clauseRows(c.clauses.waived, true)) : none('No clause is waived whole.')}` : ''}
  <h3 class="og-h3 ar-sub">Recommended, failing (${c.counts.recommended})</h3>
  ${c.counts.recommended ? table(['Clause', 'Severity', 'Requirement'], clauseRows(c.clauses.recommended)) : none('Every recommended clause that applies passes.')}
  <h3 class="og-h3 ar-sub">Passed (${c.counts.passed}) · not applicable at this tier (${c.counts.notApplicable})</h3>
  ${table(['Clause', 'Severity', 'Requirement'], clauseRows(c.clauses.passed))}
  ${c.onPlaceholder?.length ? `<p class="ar-lede">${plural(c.onPlaceholder.length, 'clause passes', 'clauses pass')} only on a template value: ${c.onPlaceholder.map((id) => `<span class="og-code">${e(id)}</span>`).join(', ')}.</p>` : ''}
</section>`;
}

function placeholdersHtml(p) {
  const by = (o) => Object.entries(o).map(([k, v]) => `${k} ${v}`).join(' · ');
  return `
<section class="ar-section" id="placeholders">
  <h2 class="og-h2">2. Placeholders</h2>
  <p class="ar-lede">What still has to become real: an artefact whose symbol carries a scaffold marker, or an importer's stub literal. The rubric grades what is declared, placeholders included.</p>
  <div class="ar-stats">
    ${stat('Rows', p.counts.rows, `${plural(p.counts.symbols, 'symbol')}`, tone(p.conformant))}
    ${stat('Markers', p.markers, 'scaffold annotations')}
    ${stat('Library todos', p.templates.todos, 'library.todo.* annotations')}
    ${stat('Scaffold artefacts', p.templates.scaffolds, 'parked by the studio')}
  </div>
  ${p.rows.length ? `<p class="ar-lede">By state: ${e(by(p.counts.byState))}. By source: ${e(by(p.counts.bySource))}.</p>${table(['Symbol', 'Field', 'Needs', 'From', 'State', 'Path'], p.rows.map((r) => [code(r.symbol), td(r.field), td(r.needs), td(r.source), td(r.state), code(r.path)]))}` : none('No placeholders: every value is real.')}
</section>`;
}

function assessmentsHtml(a) {
  const c = a.counts;
  const t = (s) => (s === 'trusted' ? 'ok' : s === 'suspect' ? 'warn' : s === 'failed' ? 'fail' : '');
  return `
<section class="ar-section" id="assessments">
  <h2 class="og-h2">3. Verdicts</h2>
  <p class="ar-lede">A reviewer's record per artefact (trusted, suspect, failed); unreviewed is the absence of a record. A verdict never feeds the conformance numbers above.</p>
  ${!a.available ? none(NOT_RECORDED) : `
  <div class="ar-stats">
    ${stat('Artefacts', a.artefacts)}
    ${stat('Trusted', c.trusted, '', c.trusted ? 'ok' : '')}
    ${stat('Suspect', c.suspect, '', c.suspect ? 'warn' : '')}
    ${stat('Failed', c.failed, '', c.failed ? 'fail' : '')}
    ${stat('Unreviewed', c.unreviewed)}
    ${a.orphaned ? stat('Orphaned', a.orphaned, 'records of artefacts the pack no longer has', 'warn') : ''}
  </div>
  ${a.verdicts.length ? table(['Artefact', 'Card', 'Family', 'Verdict', 'Reason', 'By', 'At'], a.verdicts.map((v) => [code(v.artefactKey), code(v.key), td(v.family), tdHtml(pill(v.state, t(v.state))), td(v.reason), td(v.by), td(v.at)])) : none('None recorded: every artefact is unreviewed.')}`}
</section>`;
}

function waiversHtml(w) {
  const c = w.counts;
  const t = (s) => (s === 'active' ? 'info' : s === 'expired' ? 'warn' : s === 'revoked' ? 'second' : '');
  return `
<section class="ar-section" id="waivers">
  <h2 class="og-h2">4. Waivers</h2>
  <p class="ar-lede">The service record's time-boxed suppressions of a conformance finding, by rubric clause and optionally one canonical symbol. An expired waiver covers nothing; a revoked one is history.</p>
  ${!w.available ? none(NOT_RECORDED) : `
  <div class="ar-stats">
    ${stat('Active', c.active, '', c.active ? 'info' : '')}
    ${stat('Expired', c.expired, 'failing again', c.expired ? 'warn' : '')}
    ${stat('Revoked', c.revoked, 'history')}
  </div>
  ${w.waivers.length ? table(['State', 'Clause', 'Artefact', 'Reason', 'Expires', 'By', 'Created'], w.waivers.map((x) => [tdHtml(pill(x.status, t(x.status))), code(x.rule), code(x.artefactKey), td(x.reason), td(x.expiresAt), td(x.by), td(x.at)])) : none('None recorded: no finding is waived.')}`}
</section>`;
}

function coverageHtml(cov) {
  const c = cov.counts;
  const t = (s) => (s === 'present' ? 'ok' : s === 'missing' ? 'fail' : '');
  return `
<section class="ar-section" id="coverage">
  <h2 class="og-h2">5. Coverage by family</h2>
  <p class="ar-lede">Every family of the artefact taxonomy and what the pack declares in it. A family is required when a rubric clause that applies at the graded tier names it; required with nothing declared is missing, otherwise absent.</p>
  <div class="ar-stats">
    ${stat('Present', c.present, 'families with artefacts', 'ok')}
    ${stat('Missing', c.missing, 'required, none declared', c.missing ? 'fail' : '')}
    ${stat('Absent', c.absent, 'not required here')}
  </div>
  ${table(['Family', 'Layer', 'Status', 'Artefacts', 'Declared', 'Verified', 'Scaffold', 'Named by'], cov.families.map((f) => [
    tdHtml(`${e(dash(f.label))} <span class="og-code og-muted">${e(f.family)}</span>`), td(f.layer), tdHtml(pill(f.status, t(f.status))),
    td(f.count, 'ar-num'), td(f.declared, 'ar-num'), td(f.verified, 'ar-num'), td(f.scaffold, 'ar-num'), tdHtml(f.clauses.length ? f.clauses.map((id) => `<span class="og-code">${e(id)}</span>`).join('<br>') : '—'),
  ]))}
</section>`;
}

function goesBlindHtml(g) {
  return `
<section class="ar-section" id="goes-blind">
  <h2 class="og-h2">6. Goes-blind risks</h2>
  <p class="ar-lede">Structural exposure from the declared edges: what WOULD go blind if a node died — never that something is blind. The top ${g.top} by what goes blind.</p>
  ${!g.available ? none('Not computed by this build: the traceability graph needs the PromQL parser the server and the CLI have; the static bundle does not.') : `
  <div class="ar-stats">
    ${stat('Graph', `${g.nodes} / ${g.edges}`, 'nodes / edges')}
    ${stat('Nodes whose loss would blind an SLO', g.sloBlindingNodes, '', g.sloBlindingNodes ? 'warn' : '')}
  </div>
  ${g.risks.length ? table(['Node', 'Kind', 'SLOs', 'Alerts', 'Panels', 'Dashboards', 'Routes', 'Total', 'Weight', 'Loses protection'], g.risks.map((r) => [
    tdHtml(`${e(dash(r.label))} <span class="og-code og-muted">${e(r.key)}</span>`), td(r.kind), td(r.summary.slos, 'ar-num'), td(r.summary.alerts, 'ar-num'), td(r.summary.panels, 'ar-num'), td(r.summary.dashboards, 'ar-num'), td(r.summary.routes, 'ar-num'), td(r.summary.total, 'ar-num'), td(r.weight, 'ar-num'),
    tdHtml([...r.unprotected.slos.map((s) => `SLO ${e(dash(s.label))}`), ...r.unprotected.alerts.map((s) => `alert ${e(dash(s.label))}`)].join('<br>') || '—'),
  ])) : none('No node blinds another: the graph declares no consuming edge.')}`}
</section>`;
}

function responsePathHtml(r) {
  const c = r.counts;
  return `
<section class="ar-section" id="response-path">
  <h2 class="og-h2">7. Response path (declared)</h2>
  <p class="ar-lede">Whether each remediation the pack declares answers to an alert of the pack — the linking rule of the diagnose → remediate flow, from pack data alone, never compared with a live side.</p>
  ${!r.configured ? none('The pack declares no remediation.') : `
  <div class="ar-stats">
    ${stat('Remediations', c.remediations, c.placeholder ? `${c.placeholder} with template values` : '')}
    ${stat('Linked', c.linked, '', c.linked ? 'ok' : '')}
    ${stat('Unresolved', c.unresolved, 'no alert answers the trigger', c.unresolved ? 'warn' : '')}
    ${stat('Alerts', c.alerts, `${c.uncovered} without a remediation`)}
  </div>
  ${r.links.length ? `<h3 class="og-h3 ar-sub">Linked</h3>${table(['Remediation', 'Trigger', 'Tier', 'Alerts', 'State'], r.links.map((l) => [code(l.remediation?.symbol), td(l.trigger), td(l.tier), tdHtml(l.alerts.map((a) => `<span class="og-code">${e(dash(a.symbol))}</span>`).join('<br>') || '—'), td(l.state)]))}` : ''}
  ${r.unresolved.length ? `<h3 class="og-h3 ar-sub">Unresolved</h3>${table(['Remediation', 'Trigger', 'Suggested alerts', 'Name it with'], r.unresolved.map((u) => [code(u.remediation?.symbol), td(u.trigger), tdHtml(u.suggestions.map((s) => `<span class="og-code">${e(dash(s.symbol))}</span>`).join('<br>') || '—'), code(u.annotation)]))}` : ''}
  ${r.uncovered.length ? `<h3 class="og-h3 ar-sub">Alerts without a remediation (${r.uncovered.length})</h3>${table(['Alert', 'Family', 'Title'], r.uncovered.map((u) => [code(u.symbol), td(u.family), td(u.title)]))}` : ''}
  ${r.warnings.length ? `<p class="ar-lede">${e(plural(r.warnings.length, 'warning'))}: ${r.warnings.map((w) => e(w)).join('; ')}</p>` : ''}`}
</section>`;
}

/**
 * renderAuditReportHtml(report, { brand, styles }) → one self-contained HTML
 * document: `styles` (the design tokens and kit, read by the caller — this
 * module reads no file) then REPORT_CSS in one <style>, the brand's token
 * overrides in `<style id="brand-tokens">` only when it sets any, no script,
 * light theme, every value through escapeHtml. A style text holding
 * "</style" cannot be inlined and is refused (tools/build-studio-bundle.mjs's
 * rule).
 */
export function renderAuditReportHtml(report, { brand = DEFAULT_BRAND, styles = '' } = {}) {
  const r = report || {};
  const chrome = brandChrome(brand);
  const css = `${styles || ''}\n${REPORT_CSS}`;
  if (/<\/style/i.test(css)) throw new Error('audit-report: a stylesheet contains "</style" and cannot be inlined');
  const tokens = brandTokensCss(brand);
  if (/<\/style/i.test(tokens)) throw new Error('audit-report: the brand tokens contain "</style" and cannot be inlined');
  const p = r.pack || {};
  const title = `${p.name || p.id || 'pack'} — service audit report`;
  const toc = [['conformance', '1. Conformance'], ['placeholders', '2. Placeholders'], ['assessments', '3. Verdicts'], ['waivers', '4. Waivers'], ['coverage', '5. Coverage'], ['goes-blind', '6. Goes-blind risks'], ['response-path', '7. Response path']];
  const gen = r.generator ? `${r.generator.name || ''}${r.generator.version ? ` ${r.generator.version}` : ''}`.trim() : '';
  return `<!doctype html>
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="${e(gen || chrome.name)}">
<title>${e(title)} · ${e(chrome.name)}</title>
<style>
${css}
</style>
${tokens ? `<style id="brand-tokens">\n${tokens}</style>\n` : ''}</head>
<body class="og-app">
<main class="ar-page">
  <header class="ar-head">
    <div>
      <p class="og-eyebrow">Service audit report</p>
      <h1 class="og-h1">${e(p.name || p.id || 'pack')}</h1>
    </div>
    <div class="ar-brand">${e(chrome.name)} · ${e(chrome.tagline)}</div>
  </header>
  <ul class="ar-meta">
    <li><b>Pack</b> ${e(dash(p.id))}${p.version ? ` v${e(p.version)}` : ''}</li>
    <li><b>Service</b> ${e(dash(p.service))}</li>
    <li><b>Environment</b> ${e(p.environment || 'as declared')}</li>
    <li><b>Criticality</b> ${e(dash(p.criticality))}</li>
    <li><b>Artefacts</b> ${e(String(p.artefacts ?? 0))} (${e(Object.entries(p.sources || {}).map(([k, v]) => `${k} ${v}`).join(' · '))})</li>
    <li><b>Generated</b> ${e(r.generatedAt || 'unstamped')}</li>
  </ul>
  <ul class="ar-toc">${toc.map(([id, label]) => `<li><a href="#${id}">${e(label)}</a></li>`).join('')}</ul>
  ${conformanceHtml(r.conformance || splitClauses({}), r.tier || {})}
  ${placeholdersHtml(r.placeholders || placeholdersOf({}, {}))}
  ${assessmentsHtml(r.assessments || assessmentSummary(null, {}))}
  ${waiversHtml(r.waivers || waiverSummary(null))}
  ${coverageHtml(r.coverage || coverageByFamily({}, {}))}
  ${goesBlindHtml(r.goesBlind || goesBlindRisks(null))}
  ${responsePathHtml(r.responsePath || responsePath({}))}
  <footer class="ar-foot">
    <div>${e(chrome.footerText)}${gen ? ` · ${e(gen)}` : ''} · audit report v${AUDIT_REPORT_VERSION}</div>
    <div>${chrome.footerLinksHtml}</div>
  </footer>
</main>
</body>
</html>
`;
}
