// tools/lib/diff.mjs
//
// Pack arithmetic — set operations on the artefact symbols of two adapted
// layered packs. Pure ESM, no Node APIs, so the client could (and may, in
// a future restoration) call it directly.
//
// MATCHING
//   Two artefacts "are the same" when they share a behavioural identity —
//   NOT a name. The behavioural model (tools/lib/artefact-model.mjs) builds a
//   typed object per artefact family: an `identity` derived from what the
//   artefact DOES (a backend's product+signal, a metric's series name, a
//   rule's output series, a panel's binding target) and a `behavior` that
//   captures its full deployed contract. `identityKeyOf` pairs A↔B by
//   behaviour; `behaviorEqual` / `deltasOf` decide aligned vs drifted.
//
// SET OPS
//   For each layer we produce these buckets:
//     - onlyInA  artefacts present in A but not B
//     - onlyInB  artefacts present in B but not A, in a family A also declares
//     - inBoth   matched pairs, with both A's and B's projection so the
//                  caller can show spec differences side-by-side
//     - outOfScope  present in B, in a family A declares NOTHING of — the rest
//                  of the platform's inventory, kept out of the drift headline
//     - scaffold   artefacts whose `source` is 'Scaffold' on EITHER side — the
//                  schema-forced placeholders a crawler or the live fetcher had
//                  to invent (crawler.scaffold.* / mcp.scaffold.*). A
//                  placeholder is not a declaration and not live evidence, so
//                  it never pairs: a declared burn-rate alert must not read
//                  `aligned` against the live pack's fallback entry, and a repo
//                  placeholder must not read `declared, not live`. Parked here,
//                  outside every ratio.
//     - notObserved  artefacts one pack holds in a family the OTHER pack says
//                  it had no way to look at (its `observogram.unobserved.<kind>`
//                  annotation: no tool for it, or the tool failed). "Declared,
//                  and the live side could not check" is a different statement
//                  from "declared, and not there": a Grafana that refuses the
//                  fetcher's login does not make seven dashboards missing.
//                  Each entry carries the `side` that holds the artefact and
//                  the other side's `reason`. Outside every ratio.
//                  A live snapshot read with a SCOPE (metric prefixes, folder
//                  uids — its `observogram.scope.<kind>` annotations,
//                  tools/lib/live-fetch.mjs) did not look outside it either:
//                  an unmatched artefact on the other side, in a scoped
//                  family, lands here when it is outside the scope ("outside
//                  the snapshot's metric scope (prefixes …)") or when it does
//                  not say what the scope needs — a crawled dashboard names no
//                  folder uid — with a reason that states only that. An
//                  artefact inside the scope is compared as usual.
//
// METRIC FAMILIES
//   Metrics are compared as families, not series: a declared histogram and
//   the `_bucket` / `_count` / `_sum` series a store lists for it are one
//   metric (artefact-model.mjs, foldMetricFamilies). A family's entry carries
//   `series`, the names it stands for on that side.
//
// DYNAMIC FAMILIES
//   An exporter that mints metric names at runtime (one counter per queue)
//   declares them as a pattern in its manifest (METRIC-FAM-NN, spec.name_pattern;
//   tools/lib/exporter-metrics.mjs). A family never pairs by name and is never
//   folded: it is lifted out of its side first, and a metric the other side
//   holds with no pair of its own whose name it matches goes to inBoth,
//   aligned, `matchedBy: 'declared-family'`, the family as that side's artefact.
//   The first family that matches wins, a literal pair always wins over a
//   family. Two sides declaring one pattern pair with each other. A family
//   with no member is never onlyInA: it is counted in
//   `summary.dynamicFamilies`, a key present only when a family is declared.
//   A member is a pair like any other, so it counts in `jaccard` and `alignment`;
//   `summary.dynamicFamilies.members` says how much of them rests on a pattern.
//
// DECLARED AHEAD
//   A statement that an artefact was authored ahead of an environment
//   (`lifecycle`, tools/lib/lifecycle.mjs) parks it when it has no counterpart and
//   its state for the compared environment is explicitly not `deployed`: in
//   `bucket.declaredAhead`, with the reason, out of the union like notObserved.
//   Every artefact of the group must say so. notObserved wins (nothing was
//   checked at all), and an artefact that pairs is compared as usual. The compared
//   environment is `opts.environment`; without it, the environments of both packs,
//   and the statement must hold for each: a repo read for staging against a pack
//   bound to prod parks nothing that is deployed in either. The bucket and the
//   summary's `declaredAhead` and `lifecycleEnvironments` exist only when a pack
//   carries statements, so a pack without one keeps its bytes.
//
// IDENTITY MODES
//   `diffPacks(a, b, { identity })` pairs by another key: a mode id of
//   tools/lib/identity-modes.mjs (`'behaviour'`, `'name'`, `'id'`) or a
//   function `(artefact, { side }) → '<kind>::…'`. Behaviour still decides
//   aligned vs drifted. Omitted, `'behaviour'` or `identityKeyOf` itself is
//   the default path, byte-identical, with no `identity` key in the answer;
//   any other adds `identity: { mode: 'name' | 'id' | 'custom' }`. The key
//   must keep the `<kind>::` prefix (scope, notObserved and collisions read
//   it): a function that drops it is a TypeError. The `side` lets a key that
//   must never pair (an artefact with no name) differ between A and B.
//
//   The classic operations follow (over the concrete, non-scaffold artefacts):
//     A ∪ B  = onlyInA ∪ inBoth ∪ onlyInB
//     A ∩ B  = inBoth
//     A − B  = onlyInA
//     B − A  = onlyInB ∪ outOfScope

import { LIFECYCLE_ANNOTATION, lifecycleStateFor, normalizeLifecycleEnvironment } from './lifecycle.mjs';
import {
  classify,
  identityKeyOf,
  behaviorOf,
  deltasOf,
  foldMetricFamilies,
} from './artefact-model.mjs';
import { scopeOf, inScope, scopeReason } from './live-fetch.mjs';
import { identityMode, DEFAULT_IDENTITY_MODE } from './identity-modes.mjs';
import { DYNAMIC_FAMILY_LIMITS, GENERIC_METRIC_PREFIXES, compileMetricFamilyPattern, metricFamilyPrefix } from './exporter-metrics.mjs';

const LAYER_ORDER = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

// Behavioural identity key for pairing A↔B. Delegates to the artefact model so
// matching is driven by what an artefact does, never by its name or position.
// Exported under the historical `keyOf` name for backward compatibility.
export function keyOf(artefact) {
  return identityKeyOf(artefact);
}

// The full behavioural contract object of an artefact — what "compare the
// contents" actually compares. Retained under the `projectOf` name for
// backward compatibility; delegates to the artefact model.
export function projectOf(artefact) {
  return behaviorOf(artefact);
}

// Re-export the behavioural delta helper so existing importers keep working.
export { deltasOf };

function layerArtefacts(layered, layerId) {
  const ls = layered?.layers || {};
  const comparable = (artefact) => classify(artefact) !== 'panel';
  if (layerId === 'L4') {
    return [
      ...(ls.L4?.policy   || []),
      ...(ls.L4?.alerting || []),
      ...(ls.L4?.healing  || []),
    ].filter(comparable);
  }
  return (ls[layerId] || []).filter(comparable);
}

function packMeta(layered) {
  return {
    id: layered?.id,
    name: layered?.name,
    service: layered?.meta?.service,
    criticality: layered?.meta?.criticality,
    environment: layered?.meta?.environment,
    version: layered?.meta?.version,
    binding: layered?.meta?.binding,
  };
}

// The pairing key of `opts.identity`: null on the default path (behaviour),
// else { mode, keyOf(artefact, { side }) }.
function resolveIdentity(identity) {
  if (identity == null || identity === DEFAULT_IDENTITY_MODE || identity === identityKeyOf) return null;
  if (typeof identity === 'string') {
    const row = identityMode(identity);
    return { mode: row.id, keyOf: row.keyOf };
  }
  if (typeof identity === 'function') return { mode: 'custom', keyOf: prefixChecked(identity) };
  throw new TypeError(`diffPacks: identity must be a mode id or a function (got ${typeof identity})`);
}

function prefixChecked(fn) {
  return (artefact, ctx) => {
    const key = fn(artefact, ctx);
    const kind = classify(artefact);
    if (typeof key !== 'string' || !key.startsWith(`${kind}::`)) {
      throw new TypeError(`diffPacks: an identity function must return "${kind}::…" for each artefact (got ${JSON.stringify(key)} for a ${kind})`);
    }
    return key;
  };
}

export function diffPacks(aLayered, bLayered, opts = {}) {
  if (!aLayered || !bLayered) throw new Error('diffPacks: both packs required');

  const identity = resolveIdentity(opts.identity);
  const pairKey = identity ? identity.keyOf : keyOf;

  const scopeMode = normalizeScopeMode(opts.scopeMode);
  const serviceScope = buildServiceScope(aLayered, opts.service);
  // The artefact families each pack says it could not observe, with why.
  const aBlind = unobservedKinds(aLayered);
  const bBlind = unobservedKinds(bLayered);
  // The families each pack read only within a scope (a live snapshot's).
  const aScoped = scopeOf(aLayered?.meta?.annotations);
  const bScoped = scopeOf(bLayered?.meta?.annotations);
  const familyLedger = new Map();
  const hasLifecycle = Boolean(aLayered?.meta?.annotations?.[LIFECYCLE_ANNOTATION] || bLayered?.meta?.annotations?.[LIFECYCLE_ANNOTATION]);
  const lifecycleEnvironments = hasLifecycle ? comparedEnvironments(opts.environment, aLayered, bLayered) : [];
  let declaredAhead = 0;
  const layers = {};
  const collisions = [];
  let onlyInA = 0, onlyInB = 0, inBoth = 0, aligned = 0, drifted = 0, outOfScope = 0, scaffold = 0, notObserved = 0;

  for (const layerId of LAYER_ORDER) {
    const aAll = layerArtefacts(aLayered, layerId);
    const bAll = layerArtefacts(bLayered, layerId);
    // Placeholders never pair (see the header): park them before matching
    // so a declared artefact cannot align with, or drift against, a
    // schema-forced fallback on the other side.
    // Metrics pair as families (see the header), folded with what both
    // sides know about which series belong together.
    // A dynamic family is a pattern, not a metric: it stays out of the fold
    // and out of pairing, and claims what is left unpaired below.
    const concrete = (x) => !isScaffoldArtefact(x) && !isDynamicFamilyArtefact(x);
    const aFamilies = familyMatchers(aAll, 'a', familyLedger);
    const bFamilies = familyMatchers(bAll, 'b', familyLedger);
    const folded = foldMetricFamilies(aAll.filter(concrete), bAll.filter(concrete));
    const aItems = folded.a;
    const bItems = folded.b;
    const parked = [
      ...aAll.filter(isScaffoldArtefact).map((artefact) => ({ side: 'a', artefact })),
      ...bAll.filter(isScaffoldArtefact).map((artefact) => ({ side: 'b', artefact })),
    ];

    const aByKey = groupByKey(aItems, pairKey, 'a');
    const bByKey = groupByKey(bItems, pairKey, 'b');
    collectCollisions(collisions, layerId, aByKey, bByKey);

    // Kinds (artefact families) the declared side (A) actually participates in
    // for this layer. The behavioural key is `${kind}::${identity}`, so the
    // prefix is the family. When A contributes ZERO artefacts of a family, B's
    // artefacts of that family are out of the declared pack's SCOPE, not
    // actionable drift: comparing one service's declaration against a
    // whole-platform live inventory would otherwise flood "live, not declared"
    // with the entire fleet. Declare even one artefact of a family and the rest
    // of that family's live members become in-scope (genuine shadow signal).
    const aKinds = new Set();
    for (const k of aByKey.keys()) aKinds.add(k.slice(0, k.indexOf('::')));
    if (aFamilies.length) aKinds.add('metric');
    // A side that says it cannot observe metrics claims nothing through a family.
    const aClaims = aBlind.has('metric') ? [] : aFamilies;
    const bClaims = bBlind.has('metric') ? [] : bFamilies;

    const bucket = { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [], scaffold: [], notObserved: [] };

    for (const [k, aGroup] of aByKey) {
      const kind = k.slice(0, k.indexOf('::'));
      if (bByKey.has(k)) {
        matchGroups(k, aGroup, bByKey.get(k), bucket);
      } else if (!claimByFamily(k, aGroup, bClaims, 'a', bucket)) {
        // B never looked at this family, or read it only within a scope this
        // artefact is not in: A's artefact is unchecked, not absent.
        const unchecked = bBlind.has(kind) ? bBlind.get(kind) : outsideScope(kind, aGroup, bScoped, 'a');
        const ahead = unchecked ? null : declaredAheadReason(aGroup, lifecycleEnvironments);
        if (unchecked) pushNotObserved(bucket.notObserved, k, aGroup, 'a', unchecked);
        else if (ahead) pushNotObserved(bucketAhead(bucket), k, aGroup, 'a', ahead);
        else pushUnmatched(bucket.onlyInA, k, aGroup);
      }
    }
    for (const [k, bGroup] of bByKey) {
      if (aByKey.has(k) || claimByFamily(k, bGroup, aClaims, 'b', bucket)) continue;
      const kind = k.slice(0, k.indexOf('::'));
      const unchecked = aBlind.has(kind) ? aBlind.get(kind) : outsideScope(kind, bGroup, aScoped, 'b');
      if (unchecked) {
        pushNotObserved(bucket.notObserved, k, bGroup, 'b', unchecked);
      } else if (scopeMode === 'service' && isOutsideServiceScope(bGroup, serviceScope)) {
        pushUnmatched(bucket.outOfScope, k, bGroup);
      } else if (aKinds.has(kind) || scopeMode === 'all') {
        const ahead = declaredAheadReason(bGroup, lifecycleEnvironments);
        if (ahead) pushNotObserved(bucketAhead(bucket), k, bGroup, 'b', ahead);
        else pushUnmatched(bucket.onlyInB, k, bGroup);
      } else {
        pushUnmatched(bucket.outOfScope, k, bGroup);
      }
    }

    pairDeclaredFamilies(aFamilies, bFamilies, bucket);
    noteOtherCover(aClaims, bItems);
    noteOtherCover(bClaims, aItems);

    // Stable order — alphabetical by key — so the UI doesn't reshuffle on
    // every load.
    bucket.onlyInA.sort((x, y) => x.key.localeCompare(y.key, 'en'));
    bucket.onlyInB.sort((x, y) => x.key.localeCompare(y.key, 'en'));
    bucket.inBoth.sort ((x, y) => x.key.localeCompare(y.key, 'en'));
    bucket.outOfScope.sort((x, y) => x.key.localeCompare(y.key, 'en'));
    bucket.notObserved.sort((x, y) => `${x.side}:${x.key}`.localeCompare(`${y.side}:${y.key}`, 'en'));
    bucket.declaredAhead?.sort((x, y) => `${x.side}:${x.key}`.localeCompare(`${y.side}:${y.key}`, 'en'));
    // Parked placeholders keep their behavioural key (with the side, so a
    // placeholder present on both sides stays two entries) for display.
    const parkedKey = ({ side, artefact }) => pairKey(artefact, { side });
    parked
      .sort((x, y) => `${x.side}:${parkedKey(x)}`.localeCompare(`${y.side}:${parkedKey(y)}`, 'en'))
      .forEach((entry, i) => {
        const { side, artefact } = entry;
        bucket.scaffold.push({ key: `${parkedKey(entry)}@${side}#${String(i + 1).padStart(2, '0')}`, side, artefact });
      });

    // Per-layer aligned/drifted split of the matched pairs.
    bucket.aligned = bucket.inBoth.filter((e) => e.match === 'aligned').length;
    bucket.drifted = bucket.inBoth.filter((e) => e.match === 'drifted').length;

    layers[layerId] = bucket;
    onlyInA += bucket.onlyInA.length;
    onlyInB += bucket.onlyInB.length;
    inBoth  += bucket.inBoth.length;
    aligned += bucket.aligned;
    drifted += bucket.drifted;
    outOfScope += bucket.outOfScope.length;
    scaffold += bucket.scaffold.length;
    notObserved += bucket.notObserved.length;
    declaredAhead += bucket.declaredAhead?.length || 0;
  }

  const dynamicFamilies = familySummary([...familyLedger.values()], { a: aBlind, b: bBlind }, { a: aScoped, b: bScoped });

  return {
    a: packMeta(aLayered),
    b: packMeta(bLayered),
    scope: diffScopeMeta(scopeMode, serviceScope),
    // Only off the default path: which key paired A with B.
    ...(identity ? { identity: { mode: identity.mode } } : {}),
    // Identity keys held by more than one artefact on either side. The bucket
    // entries already preserve every instance via `#NN` occurrence suffixes;
    // this is the explicit fail-loud surface so callers (and downstream
    // vendors bucketing by identityKeyOf) never have to infer collisions from
    // key strings. Top-level on purpose — several consumers enumerate
    // `layers` as a map of layer buckets.
    collisions,
    summary: {
      onlyInA,
      onlyInB,
      inBoth,
      aligned,
      drifted,
      // Live artefacts whose whole family the declared pack never mentions —
      // surfaced separately so the headline drift count isn't dominated by the
      // rest of the platform's inventory.
      outOfScope,
      // Placeholders parked on either side (never paired, never counted).
      scaffold,
      // Artefacts one side holds in a family the other side could not
      // observe: unchecked, not missing. Never paired, never counted.
      notObserved,
      // Only when a side declares a dynamic family, so a pack without one
      // keeps its bytes: what each family claimed, and what it could not.
      ...(dynamicFamilies ? { dynamicFamilies } : {}),
      // Only when a pack states a lifecycle: what was parked as authored ahead
      // of the environment it was compared for. Never paired, never counted.
      ...(hasLifecycle ? { declaredAhead, lifecycleEnvironments } : {}),
      union: onlyInA + onlyInB + inBoth,
      aTotal: onlyInA + inBoth,
      bTotal: onlyInB + inBoth,
      jaccard: (onlyInA + onlyInB + inBoth) === 0
        ? 1
        : Math.round((inBoth / (onlyInA + onlyInB + inBoth)) * 100) / 100,
      // True alignment ratio: only structurally-equal matches count, over
      // the full union. Identity-only matches that drifted are excluded.
      alignment: (onlyInA + onlyInB + inBoth) === 0
        ? 1
        : Math.round((aligned / (onlyInA + onlyInB + inBoth)) * 100) / 100,
    },
    layers,
  };
}

function normalizeScopeMode(value) {
  const raw = String(value || 'service').trim().toLowerCase();
  if (raw === 'family' || raw === 'legacy' || raw === 'off') return 'family';
  if (raw === 'all' || raw === 'none' || raw === 'strict') return 'all';
  return 'service';
}

function diffScopeMeta(mode, scope) {
  return {
    mode,
    service: scope.service || null,
    serviceTokens: [...(scope.explicit || [])].sort(),
    // Present only when an exporter lent its name (no pack in the catalogue
    // does), so every stored golden keeps its bytes.
    ...(scope.exporterTokens?.size ? { exporterTokens: [...scope.exporterTokens].sort() } : {}),
    declaredMetricCount: scope.declaredMetrics?.size || 0,
    metricPrefixes: [...(scope.metricPrefixes || [])].sort(),
  };
}

const GENERIC_SERVICE_TOKENS = new Set([
  'alert', 'alerts', 'api', 'app', 'apps', 'availability', 'backend',
  'client', 'clients', 'core', 'dashboard', 'dashboards', 'demo', 'draft',
  'error', 'errors', 'exporter', 'frontend', 'health', 'latency', 'live',
  'local', 'log', 'logs', 'mcp', 'metric', 'metrics', 'monitoring',
  'observability', 'pack', 'platform', 'prod', 'production', 'processor',
  'repo', 'request', 'requests', 'runtime', 'scanned', 'server', 'service',
  'services', 'signal', 'signals', 'system', 'target', 'telemetry', 'test',
  'total', 'trace', 'traces', 'worker',
  'alertmanager', 'alloy', 'cilium', 'collector', 'grafana', 'jaeger',
  'kong', 'kube', 'kubernetes', 'kubestatemetrics', 'kubelet', 'loki',
  'node', 'nodeexporter', 'otel', 'postgres', 'postgresql', 'prometheus',
  'promtail', 'rabbitmq', 'redis', 'tempo', 'vector', 'victoria',
  'victoriametrics',
]);

function buildServiceScope(layered, serviceOverride) {
  const explicit = new Set();
  const addExplicit = (value) => addNameTokens(explicit, value, { allowShort: false });
  addExplicit(serviceOverride);
  addExplicit(layered?.meta?.service);
  addExplicit(layered?.meta?.name);
  addExplicit(layered?.name);
  addExplicit(layered?.id);

  const declaredMetrics = new Set();
  const metricPrefixes = new Set();
  const exporterTokens = new Set();
  // The declared metrics specific enough to carry a dashboard in by name:
  // a segmented name under a prefix that is not a platform's (`up`,
  // `node_cpu_seconds_total`, `http_requests_total` are charted by every
  // board in the estate; `checkout_requests_total` by this service's).
  const specificMetrics = new Set();

  for (const layerId of LAYER_ORDER) {
    for (const artefact of layerArtefacts(layered, layerId)) {
      const kind = classify(artefact);
      const spec = artefact?.spec || {};
      if (isDynamicFamilyArtefact(artefact)) {
        // A pattern is no metric name, but it says whose names they are: the
        // exporter's other metrics stay this pack's business.
        const prefix = metricPrefix(metricFamilyPrefix(spec.name_pattern));
        if (isUsefulMetricPrefix(prefix)) metricPrefixes.add(prefix);
      } else if (kind === 'metric') {
        const metric = String(spec.name || artefact.title || '').trim();
        if (!metric) continue;
        declaredMetrics.add(metric.toLowerCase());
        const prefix = metricPrefix(metric);
        if (isUsefulMetricPrefix(prefix)) {
          metricPrefixes.add(prefix);
          if (/[_:]/.test(metric)) specificMetrics.add(metric.toLowerCase());
        }
      }
      // A metric read from an exporter's manifest or catalogue config names
      // the EMITTING exporter as its service, not the service this pack
      // declares. Its name and prefix count (above); its service strings go
      // to exporterTokens, which only the scrape-job test reads: the job that
      // scrapes the exporter is this pack's business, a dashboard or rule
      // whose text merely says "event" is not.
      const target = isExporterOrigin(spec) ? exporterTokens : explicit;
      if (spec.origin_service) addNameTokens(target, spec.origin_service, { allowShort: false });
      if (spec.service) addNameTokens(target, spec.service, { allowShort: false });
    }
  }

  return { service: serviceOverride || layered?.meta?.service || layered?.meta?.name || layered?.name || layered?.id || '', explicit, declaredMetrics, metricPrefixes, exporterTokens, specificMetrics };
}

// The crawler's exporter walks (tools/lib/crawler.mjs) stamp three
// `origin_kind`s. Two name an emitter that is never the pack's own service:
// `exporter-manifest` (a metrics manifest; service = the manifest's
// `exporter`) and `exporter-config` (an exporter config read against the
// catalogue; service = the catalogue id, candidates only). The third,
// `exporter-snapshot` (a saved exposition), takes its service from the
// file's basename, which is as often the service itself
// (`checkout-api/docs/checkout-api.prom`) as a third party (`ibm-mq.prom`),
// and the annotation keeps that origin over the code's; it stays explicit.
const EXPORTER_EMITTER_ORIGINS = new Set(['exporter-manifest', 'exporter-config', 'exporter-family']);

function isExporterOrigin(spec) {
  return EXPORTER_EMITTER_ORIGINS.has(spec?.origin_kind);
}

function isOutsideServiceScope(group, scope) {
  if (!scopeHasSignal(scope)) return false;
  return group.every((artefact) => !artefactInServiceScope(artefact, scope));
}

function scopeHasSignal(scope) {
  return (scope?.explicit?.size || 0)
      || (scope?.declaredMetrics?.size || 0)
      || (scope?.metricPrefixes?.size || 0);
}

function artefactInServiceScope(artefact, scope) {
  if (!artefact) return false;
  const kind = classify(artefact);
  const spec = artefact.spec || {};
  const text = artefactScopeText(artefact);
  const compactText = compact(text);

  for (const token of scope.explicit || []) {
    if (token && compactText.includes(token)) return true;
  }
  if (kind !== 'metric') {
    // A dashboard is also read through the expressions its panels query, and
    // the estate's platform boards chart the generic series a service
    // declares too (`up`, `node_*`, `kube_*`, `http_*`); only a specific
    // declared name carries a dashboard in. Every other kind keeps the full
    // set over its own text, as before.
    const dashboard = kind === 'dashboard';
    const names = dashboard ? (scope.specificMetrics || new Set()) : (scope.declaredMetrics || new Set());
    const haystack = dashboard ? `${text} ${dashboardQueryText(spec)}` : text;
    for (const metric of names) {
      if (metric && mentionsPromMetric(haystack, metric)) return true;
    }
  }

  if (kind === 'metric') {
    const name = String(spec.name || artefact.title || '').toLowerCase();
    if ((scope.declaredMetrics || new Set()).has(name)) return true;
    const prefix = metricPrefix(name);
    return isUsefulMetricPrefix(prefix) && (scope.metricPrefixes || new Set()).has(prefix);
  }

  if (kind === 'scrape_job') {
    const job = compact(spec.job || artefact.title || '');
    // The exporter's own name counts here and nowhere else: a job named
    // for the exporter scrapes the metrics this pack declares.
    for (const token of [...(scope.explicit || []), ...(scope.exporterTokens || [])]) {
      if (job.includes(token) || token.includes(job)) return true;
    }
  }

  return false;
}

function artefactScopeText(artefact) {
  const spec = artefact?.spec || {};
  const chunks = [
    artefact?.id,
    artefact?.title,
    artefact?.desc,
    artefact?.defines,
    artefact?.parent,
    ...(artefact?.tags || []),
    ...(artefact?.refs || []),
  ];
  appendSpecScopeText(spec, chunks);
  if (classify(artefact) === 'dashboard') appendDashboardTitles(spec, chunks);
  return chunks.filter(Boolean).join(' ');
}

// A dashboard's own words beyond its id, folder and refs live under
// `params`, which appendSpecScopeText never walks (and whose raw targets sit
// deeper than it goes): a crawled Grafana dashboard carries
// `params.panels[].{title,expr}`, one entry per query target
// (tools/lib/crawler.mjs); a live one `params.title`, `params.panels[]`
// summaries ({id,title,type}; some servers add targets) and, when the MCP
// returned the dashboard JSON, `params.raw.panels[].targets[].expr`, rows
// nested one level (tools/fetch-live-pack.mjs dashboardFromGrafanaDetail).
// Two readers, because the two kinds of text are matched differently: the
// titles join the scope text, where a service token matches by substring as
// it does an id or a folder; the expressions are read for whole metric names
// only (mentionsPromMetric), never by substring — `loan_repayment_total`
// must not answer for a service called `payment`. Not read: template
// variables, descriptions, labels. Bounds: as many panels per list as the
// fetcher asks the MCP for (GRAFANA_DASHBOARD_PANEL_LIMIT caps at 500), so
// many targets per panel, strings only.
const DASHBOARD_SCOPE_PANELS = 512;
const DASHBOARD_SCOPE_TARGETS = 16;

function dashboardParams(spec) {
  const params = spec?.params;
  return params && typeof params === 'object' && !Array.isArray(params) ? params : null;
}

function appendDashboardTitles(spec, chunks) {
  const params = dashboardParams(spec);
  if (!params) return;
  if (typeof params.title === 'string') chunks.push(params.title);
  for (const panel of dashboardPanels(params)) {
    for (const key of ['title', 'panel']) {
      if (typeof panel[key] === 'string') chunks.push(panel[key]);
    }
  }
}

function dashboardQueryText(spec) {
  const params = dashboardParams(spec);
  if (!params) return '';
  const chunks = [];
  for (const panel of dashboardPanels(params)) {
    for (const key of ['expr', 'query', 'expression']) {
      if (typeof panel[key] === 'string') chunks.push(panel[key]);
    }
    const targets = Array.isArray(panel.targets) ? panel.targets.slice(0, DASHBOARD_SCOPE_TARGETS) : [];
    for (const target of targets) {
      if (!target || typeof target !== 'object') continue;
      for (const key of ['expr', 'query', 'expression']) {
        if (typeof target[key] === 'string') chunks.push(target[key]);
      }
    }
  }
  return chunks.join(' ');
}

// The panels of a dashboard's params. The raw Grafana JSON's first, because
// those carry the targets, with a row's nested `panels` flattened (Grafana
// rows do not nest, and a row container itself is not a panel); then the
// flat `panels` list (the crawler's, with expressions; the fetcher's
// summaries). Each list has the whole budget to itself, so a board the
// fetcher returned with hundreds of summaries still has its targets read.
function dashboardPanels(params) {
  const out = [];
  const take = (list) => {
    let taken = 0;
    for (const panel of Array.isArray(list) ? list : []) {
      if (taken >= DASHBOARD_SCOPE_PANELS) return;
      if (!panel || typeof panel !== 'object') continue;
      if (Array.isArray(panel.panels)) {
        for (const inner of panel.panels) {
          if (taken >= DASHBOARD_SCOPE_PANELS) return;
          if (inner && typeof inner === 'object') { out.push(inner); taken++; }
        }
        continue;
      }
      out.push(panel);
      taken++;
    }
  };
  if (params.raw && typeof params.raw === 'object') take(params.raw.panels);
  take(params.panels);
  return out;
}

function appendSpecScopeText(value, chunks, depth = 0) {
  if (value == null || depth > 4) return;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    chunks.push(String(value));
    return;
  }
  if (Array.isArray(value)) {
    value.slice(0, 48).forEach((item) => appendSpecScopeText(item, chunks, depth + 1));
    return;
  }
  if (typeof value === 'object') {
    for (const key of [
      'id', 'name', 'job', 'service', 'source_name', 'origin_service',
      'origin_file', 'file', 'query', 'expr', 'promql', 'expression',
      'binds_to', 'slo', 'sli', 'record', 'folder', 'title',
    ]) {
      if (key in value) appendSpecScopeText(value[key], chunks, depth + 1);
    }
    for (const key of ['used_by', 'references', 'labels', 'annotations', 'targets']) {
      if (key in value) appendSpecScopeText(value[key], chunks, depth + 1);
    }
  }
}

function addNameTokens(target, value, { allowShort = false } = {}) {
  if (typeof value !== 'string') return;
  for (const token of serviceTokens(value, allowShort)) target.add(token);
}

function serviceTokens(value, allowShort = false) {
  const raw = String(value || '').toLowerCase();
  const out = new Set();
  const whole = compact(raw);
  if (isUsefulServiceToken(whole, allowShort)) out.add(whole);
  for (const part of raw.split(/[^a-z0-9]+/i)) {
    const token = compact(part);
    if (isUsefulServiceToken(token, allowShort)) out.add(token);
  }
  return [...out];
}

function isUsefulServiceToken(token, allowShort = false) {
  if (!token) return false;
  if (GENERIC_SERVICE_TOKENS.has(token)) return false;
  if (token.length >= 3) return true;
  return allowShort && token.length >= 2;
}

function metricPrefix(name) {
  const raw = String(name || '').toLowerCase();
  const sep = raw.includes(':') ? ':' : '_';
  return raw.split(sep)[0] || '';
}

function mentionsPromMetric(text, metric) {
  const haystack = String(text || '').toLowerCase();
  const needle = String(metric || '').toLowerCase();
  if (!needle) return false;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    const before = index === 0 ? '' : haystack[index - 1];
    const after = haystack[index + needle.length] || '';
    if (!isPromMetricChar(before) && !isPromMetricChar(after)) return true;
    index = haystack.indexOf(needle, index + 1);
  }
  return false;
}

function isPromMetricChar(ch) {
  return !!ch && /[a-z0-9_:]/i.test(ch);
}

function isUsefulMetricPrefix(prefix) {
  return !!prefix
    && prefix.length >= 2
    && !GENERIC_METRIC_PREFIXES.has(prefix)
    && !GENERIC_SERVICE_TOKENS.has(prefix);
}

function compact(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

// The artefact families a pack's producer could not observe, as
// kind → reason, read from its `observogram.unobserved.<kind>` annotations
// (the adapter carries a pack's annotations on meta.annotations).
const UNOBSERVED_PREFIX = 'observogram.unobserved.';
function unobservedKinds(layered) {
  const out = new Map();
  const annotations = layered?.meta?.annotations;
  if (!annotations || typeof annotations !== 'object') return out;
  for (const [key, value] of Object.entries(annotations)) {
    if (key.startsWith(UNOBSERVED_PREFIX) && key.length > UNOBSERVED_PREFIX.length) {
      out.set(key.slice(UNOBSERVED_PREFIX.length), typeof value === 'string' && value ? value : 'not observed');
    }
  }
  return out;
}

// The notObserved reason when the other pack read `kind` within a scope that
// does not cover this group, else null. One artefact of the group inside the
// scope makes the group's absence real (it is compared as usual); otherwise
// "outside" when any is known to be outside, else the cannot-tell reason.
function outsideScope(kind, group, otherScoped, holder) {
  const entry = otherScoped.get(kind);
  if (!entry) return null;
  const verdicts = group.map((artefact) => inScope(kind, artefact, entry));
  if (verdicts.includes(true)) return null;
  return scopeReason(kind, verdicts.includes(false) ? false : null, entry, { holder });
}

function pushNotObserved(target, baseKey, group, side, reason) {
  const suffix = group.length > 1;
  group.forEach((artefact, i) => {
    target.push({ key: occurrenceKey(baseKey, i, suffix), side, artefact, reason });
  });
}

// ---------- declared ahead ----------

function bucketAhead(bucket) {
  if (!bucket.declaredAhead) bucket.declaredAhead = [];
  return bucket.declaredAhead;
}

// The environments a statement must hold for: the one asked for, else each pack's.
function comparedEnvironments(asked, aLayered, bLayered) {
  const usable = (name) => typeof name === 'string' && name.trim();
  const names = usable(asked) ? [asked] : [aLayered?.meta?.environment, bLayered?.meta?.environment].filter(usable);
  return [...new Set(names.map(normalizeLifecycleEnvironment))].sort();
}

// The reason a group is parked as authored ahead, or null: every artefact in it
// must state a state for every compared environment, and none may be deployed.
function declaredAheadReason(group, environments) {
  if (!environments.length) return null;
  const states = (artefact) => environments.map((environment) => lifecycleStateFor(artefact?.lifecycle, environment));
  if (group.some((artefact) => states(artefact).some((state) => !state || state === 'deployed'))) return null;
  const { source } = group[0].lifecycle;
  const where = states(group[0]).map((state, i) => `${state} in ${environments[i]}`).join(', ');
  return `Declared ahead: ${where}${source ? `, as ${source} states` : ''}.`;
}

// ---------- dynamic metric families ----------

function isDynamicFamilyArtefact(artefact) {
  return artefact?.spec?.origin_kind === 'exporter-family' && typeof artefact.spec.name_pattern === 'string';
}

// The families of one side and layer that compile, each with its row in the
// ledger (one per side and pattern, whichever layers repeat it); the ones that
// do not compile, or come past the limit, are recorded there and claim nothing.
function familyMatchers(items, side, ledger) {
  const out = [];
  for (const artefact of items.filter(isDynamicFamilyArtefact)) {
    const pattern = artefact.spec.name_pattern;
    if (out.some((family) => family.pattern === pattern)) continue;
    const key = `${side}\0${pattern}`;
    const known = ledger.get(key);
    const taken = [...ledger.values()].filter((row) => row.side === side && !row.refused).length;
    const compiled = !known && taken >= DYNAMIC_FAMILY_LIMITS.families
      ? { reason: `over the limit of ${DYNAMIC_FAMILY_LIMITS.families}` }
      : compileMetricFamilyPattern(pattern);
    const row = known || {
      pattern: pattern.slice(0, 200),
      side,
      ...(artefact.spec.origin_service ? { exporter: artefact.spec.origin_service } : {}),
      ...(artefact.spec.origin_file ? { file: artefact.spec.origin_file } : {}),
      members: 0,
      ...(compiled.reason ? { refused: compiled.reason } : {}),
    };
    ledger.set(key, row);
    if (compiled.re) out.push({ artefact, pattern, re: compiled.re, row });
  }
  return out;
}

// The first family that matches this metric, testing the name and, for a
// folded metric, each series it stands for, as listed (Prometheus names are
// case-sensitive).
function familyOfMetric(artefact, families) {
  const names = [artefact?.spec?.name, ...(artefact?.series || [])]
    .filter((n) => typeof n === 'string' && n.length <= DYNAMIC_FAMILY_LIMITS.nameLength);
  return families.find((family) => names.some((n) => family.re.test(n)));
}

// An unpaired metric group the other side's family answers for goes to inBoth.
function claimByFamily(baseKey, group, families, side, bucket) {
  if (!families.length || baseKey.slice(0, baseKey.indexOf('::')) !== 'metric') return false;
  const claims = group.map((artefact) => familyOfMetric(artefact, families));
  if (claims.some((family) => !family)) return false;
  const suffix = group.length > 1;
  group.forEach((artefact, i) => {
    const family = claims[i];
    family.row.members++;
    bucket.inBoth.push({
      key: occurrenceKey(baseKey, i, suffix),
      a: side === 'b' ? family.artefact : artefact,
      b: side === 'b' ? artefact : family.artefact,
      match: 'aligned',
      matchedBy: 'declared-family',
      deltas: [],
    });
  });
  return true;
}

// One pattern on both sides is one declaration, the same on each.
function pairDeclaredFamilies(aFamilies, bFamilies, bucket) {
  for (const a of aFamilies) {
    const b = bFamilies.find((family) => family.pattern === a.pattern);
    if (!b) continue;
    a.row.paired = true;
    b.row.paired = true;
    bucket.inBoth.push({ key: `metric::family:${a.pattern}`, a: a.artefact, b: b.artefact, match: 'aligned', deltas: [] });
  }
}

// A family with no member can still match names that went elsewhere first: the
// pack lists them too (`packc emit` keeps families beside the names it scrapes),
// or an earlier family holds them. It did not match nothing.
function noteOtherCover(families, otherItems) {
  for (const family of families) {
    if (family.row.members) continue;
    const covered = otherItems.filter((x) => classify(x) === 'metric' && familyOfMetric(x, [family])).length;
    if (covered) family.row.covered = (family.row.covered || 0) + covered;
  }
}

// Whether a side's metric scope read everything a family's prefix can name.
function scopeCoversFamily(entry, pattern) {
  if (entry?.by !== 'prefix' || entry.exclude?.length) return false;
  const prefix = metricFamilyPrefix(pattern);
  return entry.values.some((value) => prefix.startsWith(value));
}

// `summary.dynamicFamilies`, or null when no side declares one. `unmatched` is
// a family that matched nothing, not even a name that paired elsewhere, on a side
// that read what it could name; where a side could not list metrics, or read
// them within a scope that does not cover the family, the row says it was not
// checked instead.
function familySummary(ledger, blind, scoped) {
  if (!ledger.length) return null;
  const order = (x, y) => (x.pattern < y.pattern ? -1 : x.pattern > y.pattern ? 1 : x.side < y.side ? -1 : x.side > y.side ? 1 : 0);
  const families = ledger.map((row) => {
    if (row.refused || row.members || row.paired || row.covered) return row;
    const other = row.side === 'a' ? 'b' : 'a';
    const scope = scoped[other].get('metric');
    const reason = blind[row.side].get('metric') || blind[other].get('metric')
      || (scope && !scopeCoversFamily(scope, row.pattern) ? 'the other pack read its metrics only within a scope that does not cover this family, so it was not checked' : null);
    return reason ? { ...row, notObserved: reason } : row;
  }).sort(order);
  const distinct = (rows) => [...new Set(rows.map((row) => row.pattern))];
  return {
    declared: distinct(families).length,
    members: families.reduce((sum, row) => sum + row.members, 0),
    unmatched: distinct(families.filter((row) => !row.refused && !row.members && !row.paired && !row.covered && !row.notObserved)),
    refused: families.filter((row) => row.refused).map(({ pattern, side, refused }) => ({ pattern, side, reason: refused })),
    families,
  };
}

// A schema-forced placeholder projected by the adapter from a
// crawler.scaffold.* / mcp.scaffold.* marker. Not a declaration, not live.
function isScaffoldArtefact(artefact) {
  return artefact?.source === 'Scaffold';
}

function groupByKey(items, pairKey, side) {
  const out = new Map();
  for (const item of items) {
    const k = pairKey(item, { side });
    if (!out.has(k)) out.set(k, []);
    out.get(k).push(item);
  }
  return out;
}

function collectCollisions(target, layerId, aByKey, bByKey) {
  const keys = new Set([...aByKey.keys(), ...bByKey.keys()]);
  for (const k of [...keys].sort()) {
    const aCount = aByKey.get(k)?.length || 0;
    const bCount = bByKey.get(k)?.length || 0;
    if (aCount > 1 || bCount > 1) {
      target.push({ layer: layerId, kind: k.slice(0, k.indexOf('::')), key: k, aCount, bCount });
    }
  }
}

function matchGroups(baseKey, aGroup, bGroup, bucket) {
  const suffix = Math.max(aGroup.length, bGroup.length) > 1;
  let seq = 0;
  const unusedB = bGroup.map((b, i) => ({ b, i }));
  const usedA = new Set();

  // Pair exact behavioural matches first so a self-diff remains fully aligned
  // even when one pack contains duplicate identity keys.
  for (let ai = 0; ai < aGroup.length; ai++) {
    const bi = unusedB.findIndex(({ b }) => deltasOf(aGroup[ai], b).length === 0);
    if (bi === -1) continue;
    const [{ b }] = unusedB.splice(bi, 1);
    bucket.inBoth.push({
      key: occurrenceKey(baseKey, seq++, suffix),
      a: aGroup[ai],
      b,
      match: 'aligned',
      deltas: [],
    });
    usedA.add(ai);
  }

  const unusedA = aGroup
    .map((a, i) => ({ a, i }))
    .filter(({ i }) => !usedA.has(i));

  // Remaining items share identity but not the same contract. Pair each A with
  // the closest remaining B, then leave surplus controls visible as onlyInA/B.
  while (unusedA.length && unusedB.length) {
    const { a } = unusedA.shift();
    let best = 0;
    let bestDeltas = deltasOf(a, unusedB[0].b);
    for (let i = 1; i < unusedB.length; i++) {
      const d = deltasOf(a, unusedB[i].b);
      if (d.length < bestDeltas.length) {
        best = i;
        bestDeltas = d;
      }
    }
    const [{ b }] = unusedB.splice(best, 1);
    bucket.inBoth.push({
      key: occurrenceKey(baseKey, seq++, suffix),
      a,
      b,
      match: 'drifted',
      deltas: bestDeltas,
    });
  }

  for (const { a } of unusedA) {
    bucket.onlyInA.push({ key: occurrenceKey(baseKey, seq++, suffix), artefact: a });
  }
  for (const { b } of unusedB) {
    bucket.onlyInB.push({ key: occurrenceKey(baseKey, seq++, suffix), artefact: b });
  }
}

function pushUnmatched(target, baseKey, group) {
  const suffix = group.length > 1;
  group.forEach((artefact, i) => {
    target.push({ key: occurrenceKey(baseKey, i, suffix), artefact });
  });
}

function occurrenceKey(baseKey, index, suffix) {
  return suffix ? `${baseKey}#${String(index + 1).padStart(2, '0')}` : baseKey;
}
