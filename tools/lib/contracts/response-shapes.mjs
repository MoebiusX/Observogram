// tools/lib/contracts/response-shapes.mjs
//
// TOLERANT response-shape contracts for MCP capability payloads.
//
// Each shape declares the MINIMUM a response must carry for the probe's
// adapt() to produce something usable — the critical fields only. Extra
// fields, unknown keys, vendor additions: all ignored by design. The gate
// exists to catch REMOVALS and RENAMES of fields we depend on, not to pin
// vendors' full payloads — additive upstream changes must never break a
// fetch (docs/ARCHITECTURE_EVOLUTION.md §3.2).
//
// A shape row:
//   lists        candidate paths (dot-separated; '' = the response itself)
//                where the payload array may live, tried in order
//   objectKeysAt paths where a plain OBJECT also counts as a payload
//                (its keys are the values — e.g. metrics_metadata's data map)
//   itemAnyOf    for object items: groups of field paths; every group must
//                have at least ONE field present on each item. String items
//                pass automatically (adapters filter non-strings leniently).
//   object       true for shapes whose payload is a single plain OBJECT
//                rather than a list (a status document, a health verdict)
//   objectAt     for object shapes: candidate paths where that object may
//                live ('' = the response itself), tried in order
//   anyOfKeys    for object shapes: groups of key paths; every group must
//                have at least ONE key present on the located object
//
// An EMPTY payload array is a PASS: "the backend says zero" is a legitimate,
// meaningful response (the fetcher's outcome:'empty' case) — shape checking
// guards structure, not population.
//
// Pure ESM, browser-safe: data tables + a small structural checker.

export const RESPONSE_SHAPES = Object.freeze({
  // Prometheus/VMAlert rule listings — recording_rules and alert_rules both
  // consume this. Rules may be nested in groups or flat.
  'rule-groups': {
    lists: ['groups', 'data.groups', 'rules'],
    nestedRules: true, // items in groups[] carry their own rules[] arrays
    itemAnyOf: [
      ['record', 'name', 'alert'],   // rule identity
      ['expr', 'query'],             // rule body
    ],
  },
  // Grafana dashboard search results (otel-mcp-server + community shapes).
  'dashboard-search': {
    lists: ['results', 'dashboards', 'items', ''],
    itemAnyOf: [
      ['uid', 'id'],                 // addressable identity
    ],
  },
  // Prometheus scrape targets (otel-mcp-server flat shape + /api/v1/targets).
  'scrape-targets': {
    lists: ['targets', 'activeTargets', 'data.activeTargets', ''],
    itemAnyOf: [
      ['job', 'labels.job'],         // the job identity the crawler keys on
    ],
  },
  // Metric-name enumerations (label values / inventories / metadata maps).
  'name-values': {
    lists: ['values', 'data', 'metrics', 'names', ''],
    objectKeysAt: ['data'],
    itemAnyOf: [],                   // items are strings
  },

  // ---- step 2: stack self-metrics + status surfaces ----------------------
  // PromQL instant vector — otel-mcp-server's metrics_query ({ result })
  // and the Prometheus HTTP API envelope ({ data: { result } }). Consumed
  // by build_info_versions and stack_self_metrics.
  'instant-vector': {
    lists: ['result', 'data.result'],
    itemAnyOf: [
      ['value', 'values', 'metric'], // a sample (or a series identity)
    ],
  },
  // Alertmanager API v2 silences.
  'silences': {
    lists: ['silences', 'data', ''],
    itemAnyOf: [
      ['id', 'status', 'matchers'],
    ],
  },
  // Grafana datasource listing.
  'datasources': {
    lists: ['datasources', 'data', ''],
    itemAnyOf: [
      ['uid', 'id', 'name'],
    ],
  },
  // Grafana contact points (provisioning API).
  'contact-points': {
    lists: ['contactPoints', 'contact_points', 'data', ''],
    itemAnyOf: [
      ['name', 'uid'],
    ],
  },
  // Alertmanager API v2 /status — a single object, not a list.
  //
  // objectAt is ENVELOPE-FIRST: a Prometheus-API-style wrapper
  // `{ status: 'success', data: {...} }` carries the generic key `status`
  // at its root, so a root-first locator would pick the wrapper and read
  // `success` as the cluster status (or a wrapped `{ status: 'ERROR' }`
  // health verdict as healthy). The innermost candidate that carries the
  // key group wins; a bare document still locates at the root.
  'status-object': {
    object: true,
    objectAt: ['data', ''],
    anyOfKeys: [
      ['versionInfo', 'version', 'uptime', 'cluster', 'status'],
    ],
  },
  // Grafana datasource health check — a single verdict object.
  'health-object': {
    object: true,
    objectAt: ['data', ''],
    anyOfKeys: [
      ['status', 'message', 'ok'],
    ],
  },
});

const get = (obj, path) => path === ''
  ? obj
  : path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);

// The payload object an object shape locates in `response`: the first
// candidate in the shape's declared `objectAt` order (envelope paths
// first) that carries every key group, or null. Readers (the fetcher's
// status observers) MUST use this rather than "first object at the root"
// so they parse the same document the shape validated.
export function locateObjectPayload(shapeId, response) {
  const shape = RESPONSE_SHAPES[shapeId];
  if (!shape) throw new Error(`unknown response shape: ${shapeId}. Known: ${Object.keys(RESPONSE_SHAPES).join(', ')}`);
  if (!shape.object || response == null || typeof response !== 'object') return null;
  const candidates = (shape.objectAt || ['']).map(p => get(response, p))
    .filter(v => v && typeof v === 'object' && !Array.isArray(v));
  const missingGroup = (obj) => (shape.anyOfKeys || []).find(group => !group.some(k => get(obj, k) !== undefined));
  return candidates.find(obj => missingGroup(obj) === undefined) ?? null;
}

// Validate a response against a shape. Returns { ok, reason, items } —
// `items` is the located payload length (0 is a legitimate pass).
export function validateResponseShape(shapeId, response) {
  const shape = RESPONSE_SHAPES[shapeId];
  if (!shape) throw new Error(`unknown response shape: ${shapeId}. Known: ${Object.keys(RESPONSE_SHAPES).join(', ')}`);
  if (response == null || typeof response !== 'object') {
    return { ok: false, reason: 'response is not an object', items: 0 };
  }

  // Object shapes: a single plain object carrying at least one key of each
  // anyOfKeys group. Extras are never inspected; `items` is 1 when found.
  if (shape.object) {
    const paths = shape.objectAt || [''];
    const candidates = paths.map(p => get(response, p))
      .filter(v => v && typeof v === 'object' && !Array.isArray(v));
    if (candidates.length === 0) {
      return { ok: false, reason: `no payload object at any of: ${paths.map(p => p || '<root>').join(', ')}`, items: 0 };
    }
    // Same rule as locateObjectPayload: the first candidate in declared
    // path order (envelope first) carrying every key group wins.
    const missingGroup = (obj) => (shape.anyOfKeys || []).find(group => !group.some(k => get(obj, k) !== undefined));
    const found = locateObjectPayload(shapeId, response);
    if (!found) {
      return { ok: false, reason: `object missing all of: ${missingGroup(candidates[0]).join(' | ')}`, items: 1 };
    }
    return { ok: true, reason: null, items: 1 };
  }

  // Locate the payload: first declared path that yields an array (or, for
  // objectKeysAt paths, a plain object whose keys are the values).
  let payload = null;
  for (const path of shape.lists) {
    const v = get(response, path);
    if (Array.isArray(v)) { payload = v; break; }
    if (v && typeof v === 'object' && (shape.objectKeysAt || []).includes(path)) {
      payload = Object.keys(v); break;
    }
  }
  if (payload === null) {
    return { ok: false, reason: `no payload array at any of: ${shape.lists.map(p => p || '<root>').join(', ')}`, items: 0 };
  }

  // Flatten group nesting when the shape declares it (rules inside groups).
  const items = shape.nestedRules
    ? payload.flatMap(g => Array.isArray(g?.rules) ? g.rules : [g])
    : payload;

  // Critical-field check on object items only; string items pass (adapters
  // filter non-strings leniently). Extras are never inspected.
  for (const [i, item] of items.entries()) {
    if (item == null || typeof item !== 'object') continue;
    for (const group of shape.itemAnyOf) {
      if (!group.some(f => get(item, f) !== undefined)) {
        return { ok: false, reason: `item ${i} missing all of: ${group.join(' | ')}`, items: items.length };
      }
    }
  }
  return { ok: true, reason: null, items: items.length };
}
