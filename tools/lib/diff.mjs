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
//
//   The classic operations follow:
//     A ∪ B  = onlyInA ∪ inBoth ∪ onlyInB
//     A ∩ B  = inBoth
//     A − B  = onlyInA
//     B − A  = onlyInB ∪ outOfScope

import {
  classify,
  identityKeyOf,
  behaviorOf,
  deltasOf,
} from './artefact-model.mjs';

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

export function diffPacks(aLayered, bLayered, opts = {}) {
  if (!aLayered || !bLayered) throw new Error('diffPacks: both packs required');

  const scopeMode = normalizeScopeMode(opts.scopeMode);
  const serviceScope = buildServiceScope(aLayered, opts.service);
  const layers = {};
  const collisions = [];
  let onlyInA = 0, onlyInB = 0, inBoth = 0, aligned = 0, drifted = 0, outOfScope = 0;

  for (const layerId of LAYER_ORDER) {
    const aItems = layerArtefacts(aLayered, layerId);
    const bItems = layerArtefacts(bLayered, layerId);

    const aByKey = groupByKey(aItems);
    const bByKey = groupByKey(bItems);
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

    const bucket = { onlyInA: [], onlyInB: [], inBoth: [], outOfScope: [] };

    for (const [k, aGroup] of aByKey) {
      if (bByKey.has(k)) {
        matchGroups(k, aGroup, bByKey.get(k), bucket);
      } else {
        pushUnmatched(bucket.onlyInA, k, aGroup);
      }
    }
    for (const [k, bGroup] of bByKey) {
      if (aByKey.has(k)) continue;
      const kind = k.slice(0, k.indexOf('::'));
      if (scopeMode === 'service' && isOutsideServiceScope(bGroup, serviceScope)) {
        pushUnmatched(bucket.outOfScope, k, bGroup);
      } else if (aKinds.has(kind) || scopeMode === 'all') {
        pushUnmatched(bucket.onlyInB, k, bGroup);
      } else {
        pushUnmatched(bucket.outOfScope, k, bGroup);
      }
    }

    // Stable order — alphabetical by key — so the UI doesn't reshuffle on
    // every load.
    bucket.onlyInA.sort((x, y) => x.key.localeCompare(y.key));
    bucket.onlyInB.sort((x, y) => x.key.localeCompare(y.key));
    bucket.inBoth.sort ((x, y) => x.key.localeCompare(y.key));
    bucket.outOfScope.sort((x, y) => x.key.localeCompare(y.key));

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
  }

  return {
    a: packMeta(aLayered),
    b: packMeta(bLayered),
    scope: diffScopeMeta(scopeMode, serviceScope),
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

const GENERIC_METRIC_PREFIXES = new Set([
  'alert', 'alertmanager', 'alerts', 'container', 'go', 'grafana', 'grpc',
  'http', 'jaeger', 'jvm', 'kube', 'kubelet', 'loki', 'node', 'nodejs',
  'otel', 'otelcol', 'pg', 'pod', 'process', 'prometheus', 'promtail',
  'pushgateway', 'rabbitmq', 'redis', 'tempo', 'vm',
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

  for (const layerId of LAYER_ORDER) {
    for (const artefact of layerArtefacts(layered, layerId)) {
      const kind = classify(artefact);
      const spec = artefact?.spec || {};
      if (kind === 'metric') {
        const metric = String(spec.name || artefact.title || '').trim();
        if (!metric) continue;
        declaredMetrics.add(metric.toLowerCase());
        const prefix = metricPrefix(metric);
        if (isUsefulMetricPrefix(prefix)) metricPrefixes.add(prefix);
      }
      if (spec.origin_service) addNameTokens(explicit, spec.origin_service, { allowShort: false });
      if (spec.service) addNameTokens(explicit, spec.service, { allowShort: false });
    }
  }

  return { service: serviceOverride || layered?.meta?.service || layered?.meta?.name || layered?.name || layered?.id || '', explicit, declaredMetrics, metricPrefixes };
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
    for (const metric of scope.declaredMetrics || []) {
      if (metric && mentionsPromMetric(text, metric)) return true;
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
    for (const token of scope.explicit || []) {
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
  return chunks.filter(Boolean).join(' ');
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

function groupByKey(items) {
  const out = new Map();
  for (const item of items) {
    const k = keyOf(item);
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
