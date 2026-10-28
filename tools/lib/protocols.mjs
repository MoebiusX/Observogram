// tools/lib/protocols.mjs
//
// PROTOCOLS — the versioned canon.
//
// A *protocol* is a wire/serialization contract that one or more *products*
// speak: the Prometheus rule format, PromQL, the Grafana dashboard schema, the
// OTel Collector config, the Alertmanager config. Each protocol has its own
// version line, and each version adds/changes *features* — the things that
// determine what a conforming consumer accepts or does.
//
// This is the right home for facts like "keep_firing_for landed in the
// Prometheus rule format at 2.42": the feature belongs to the *format*, not to
// any one product. Prometheus, Thanos, Mimir, and Cortex all speak that format;
// they converge on the same feature set by binding to the same protocol
// version (see profiles.mjs). VictoriaMetrics consumes the same format but
// diverges (MetricsQL) — that's a product-level dialect override, layered on
// top of the protocol, not a fork of the protocol itself.
//
// Keeping the facts here (once) instead of duplicated across product tables is
// what lets a new product become a one-line binding rather than a copy of every
// knob — and what lets the drift checker (tools/drift-profiles.mjs) watch a
// single version line per upstream.
//
// TRACTABILITY is a property of the *protocol*, not the product: faithfully
// validating PromQL or the rule format needs Go (promtool/rulefmt); the Grafana
// dashboard JSON shape is small enough to model natively in JS. See the
// per-protocol `tractability` markers below.
//
// Every feature carries provenance: `since` (the version it landed in) and an
// `evidence` handle, so review is a diff against a dated, sourced claim rather
// than archaeology.
//
// Pure ESM, no Node APIs — the studio imports this in the browser.

// ---------------------------------------------------------------------------
// Minimal semver-range matcher (shared by protocols.mjs and profiles.mjs).
//
// Enough to drive selection without pulling in `semver` (a Node-only
// dependency). Supports "12", "12.3", "12.3.1", "v2.45.0", "0.96.0" and range
// predicates ">=", ">", "<=", "<", "=" plus a bare "major"/"major.minor"
// shorthand. Ranges are ANDed space-separated terms, e.g. ">=12 <13".
// ---------------------------------------------------------------------------

export function parseVersion(v) {
  if (v == null) return null;
  const s = String(v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  return [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)];
}

export function compareVersions(a, b) {
  const va = Array.isArray(a) ? a : parseVersion(a);
  const vb = Array.isArray(b) ? b : parseVersion(b);
  if (!va || !vb) return 0;
  for (let i = 0; i < 3; i++) {
    if (va[i] !== vb[i]) return va[i] < vb[i] ? -1 : 1;
  }
  return 0;
}

function satisfiesTerm(ver, term) {
  const t = term.trim();
  if (!t || t === '*') return true;
  const m = t.match(/^(>=|<=|>|<|=)?\s*(.+)$/);
  if (!m) return false;
  const op = m[1] || '=';
  const target = parseVersion(m[2]);
  if (!target) return false;
  const c = compareVersions(ver, target);
  switch (op) {
    case '>=': return c >= 0;
    case '>':  return c > 0;
    case '<=': return c <= 0;
    case '<':  return c < 0;
    case '=':  // bare major "=12" means same major; "=12.3" same major.minor
      if (/^\d+$/.test(m[2].trim())) return ver[0] === target[0];
      if (/^\d+\.\d+$/.test(m[2].trim())) return ver[0] === target[0] && ver[1] === target[1];
      return c === 0;
    default:   return false;
  }
}

export function satisfies(version, range) {
  const ver = parseVersion(version);
  if (!ver) return false;
  return String(range).split(/\s+/).filter(Boolean).every((term) => satisfiesTerm(ver, term));
}

// The lower bound of a range term like ">=12 <13" → [12,0,0]. Used by the
// profile resolver to decide whether an unmatched version sits *above* the
// newest known band (extrapolate) or *below* it (fall back).
export function rangeFloor(range) {
  for (const term of String(range).split(/\s+/).filter(Boolean)) {
    const m = term.match(/^(>=|>)\s*(.+)$/);
    if (m) return parseVersion(m[2]) || [0, 0, 0];
  }
  return [0, 0, 0];
}

// ---------------------------------------------------------------------------
// Protocol registry
//
// Each protocol lists versions newest-first; each version has a semver `range`
// and a `features` map. `tractability` is protocol-wide.
// ---------------------------------------------------------------------------

export const PROTOCOLS = {
  // -------------------------------------------------------------------------
  // Prometheus rule format — the YAML that wraps recording/alerting rules.
  // Spoken by Prometheus, Thanos, Mimir, Cortex, and (with a dialect) by
  // VictoriaMetrics vmalert. Faithful validation needs promtool/rulefmt (Go).
  // -------------------------------------------------------------------------
  'prometheus-rule-format': {
    label: 'Prometheus rule format',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'prometheus/prometheus', latestKnown: '3' },
    versions: [
      {
        id: 'prf-3', range: '>=3 <4', label: 'rule-format 3.x',
        features: {
          keepFiringFor:  { value: true,  since: '2.42', evidence: 'prometheus#11827' },
          ruleQueryOffset:{ value: true,  since: '3.0',  evidence: 'prometheus#14785' },
        },
      },
      {
        id: 'prf-2.42', range: '>=2.42 <3', label: 'rule-format 2.42+',
        features: {
          keepFiringFor:  { value: true,  since: '2.42', evidence: 'prometheus#11827' },
          ruleQueryOffset:{ value: false, since: '3.0',  evidence: 'prometheus#14785' },
        },
      },
      {
        id: 'prf-2', range: '<2.42', label: 'rule-format <2.42',
        features: {
          keepFiringFor:  { value: false, since: '2.42', evidence: 'prometheus#11827' },
          ruleQueryOffset:{ value: false, since: '3.0',  evidence: 'prometheus#14785' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // PromQL — the query language. A protocol in its own right, *associated with
  // several products* (Prometheus, Thanos, Mimir, Cortex). The query strings
  // inside recording rules / alerts / dashboard panels are PromQL, so its
  // version is what determines whether an expression parses on the target.
  // VictoriaMetrics speaks MetricsQL (a dialect) — handled as a product-level
  // override, not bound here.
  // -------------------------------------------------------------------------
  promql: {
    label: 'PromQL',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'prometheus/prometheus', latestKnown: '3' },
    versions: [
      {
        id: 'promql-2.49', range: '>=2.49', label: 'PromQL 2.49+',
        features: {
          atModifier:     { value: true, since: '2.26', evidence: 'prometheus#8121' },
          negativeOffset: { value: true, since: '2.26', evidence: 'prometheus#8121' },
          sortByLabel:    { value: true, since: '2.49', evidence: 'prometheus#13273' },
        },
      },
      {
        id: 'promql-2.26', range: '>=2.26 <2.49', label: 'PromQL 2.26–2.48',
        features: {
          atModifier:     { value: true,  since: '2.26', evidence: 'prometheus#8121' },
          negativeOffset: { value: true,  since: '2.26', evidence: 'prometheus#8121' },
          sortByLabel:    { value: false, since: '2.49', evidence: 'prometheus#13273' },
        },
      },
      {
        id: 'promql-2.0', range: '<2.26', label: 'PromQL <2.26',
        features: {
          atModifier:     { value: false, since: '2.26', evidence: 'prometheus#8121' },
          negativeOffset: { value: false, since: '2.26', evidence: 'prometheus#8121' },
          sortByLabel:    { value: false, since: '2.49', evidence: 'prometheus#13273' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Grafana dashboard schema — the dashboard JSON model. `schemaVersion` is
  // Grafana's own dashboard migration counter (NOT the product version); it
  // tracks the Grafana release, so the version axis here is expressed in
  // Grafana-version terms. Small enough to model natively in JS.
  // -------------------------------------------------------------------------
  'grafana-dashboard-schema': {
    label: 'Grafana dashboard schema',
    tractability: 'native',
    upstream: { repo: 'grafana/grafana', latestKnown: '13' },
    versions: [
      {
        id: 'gds-13', range: '>=13 <14', label: 'dashboard schema (Grafana 13)',
        features: {
          schemaVersion:        { value: 42, since: '13.0', evidence: 'grafana/dashboard-schemas' },
          datasourceForm:       { value: 'object', since: '10.0', evidence: 'grafana#54157' },
          panelTargetDatasource:{ value: true,  since: '10.0', evidence: 'grafana#54157' },
          thresholdsMode:       { value: 'absolute', since: '7.0', evidence: 'grafana/fieldconfig' },
          legacyAngular:        { value: false, since: '11.0', evidence: 'grafana#33744' },
        },
      },
      {
        id: 'gds-12', range: '>=12 <13', label: 'dashboard schema (Grafana 12)',
        features: {
          schemaVersion:        { value: 41, since: '12.0', evidence: 'grafana/dashboard-schemas' },
          datasourceForm:       { value: 'object', since: '10.0', evidence: 'grafana#54157' },
          panelTargetDatasource:{ value: true,  since: '10.0', evidence: 'grafana#54157' },
          thresholdsMode:       { value: 'absolute', since: '7.0', evidence: 'grafana/fieldconfig' },
          legacyAngular:        { value: false, since: '11.0', evidence: 'grafana#33744' },
        },
      },
      {
        id: 'gds-11', range: '>=11 <12', label: 'dashboard schema (Grafana 11)',
        features: {
          schemaVersion:        { value: 40, since: '11.0', evidence: 'grafana/dashboard-schemas' },
          datasourceForm:       { value: 'object', since: '10.0', evidence: 'grafana#54157' },
          panelTargetDatasource:{ value: true,  since: '10.0', evidence: 'grafana#54157' },
          thresholdsMode:       { value: 'absolute', since: '7.0', evidence: 'grafana/fieldconfig' },
          legacyAngular:        { value: false, since: '11.0', evidence: 'grafana#33744' },
        },
      },
      {
        id: 'gds-10', range: '>=10 <11', label: 'dashboard schema (Grafana 10)',
        features: {
          schemaVersion:        { value: 39, since: '10.0', evidence: 'grafana/dashboard-schemas' },
          datasourceForm:       { value: 'object', since: '10.0', evidence: 'grafana#54157' },
          panelTargetDatasource:{ value: true,  since: '10.0', evidence: 'grafana#54157' },
          thresholdsMode:       { value: 'absolute', since: '7.0', evidence: 'grafana/fieldconfig' },
          legacyAngular:        { value: true,  since: '11.0', evidence: 'grafana#33744' },
        },
      },
      {
        id: 'gds-9', range: '>=9 <10', label: 'dashboard schema (Grafana 9)',
        features: {
          schemaVersion:        { value: 37, since: '9.0', evidence: 'grafana/dashboard-schemas' },
          datasourceForm:       { value: 'string', since: '0', evidence: 'grafana#54157' }, // bare uid pre-v10
          panelTargetDatasource:{ value: false, since: '10.0', evidence: 'grafana#54157' },
          thresholdsMode:       { value: 'absolute', since: '7.0', evidence: 'grafana/fieldconfig' },
          legacyAngular:        { value: true,  since: '11.0', evidence: 'grafana#33744' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Grafana alerting provisioning — the unified-alerting rule file (apiVersion 1).
  // The rule object shape evolved across Grafana 9 → 12. Partial: we model the
  // high-impact knobs; the full alert model is larger than we encode.
  // -------------------------------------------------------------------------
  'grafana-alerting-provisioning': {
    label: 'Grafana alerting provisioning',
    tractability: 'partial',
    upstream: { repo: 'grafana/grafana', latestKnown: '13' },
    versions: [
      {
        id: 'gap-11', range: '>=11', label: 'unified alerting (Grafana 11+)',
        features: {
          apiVersion:           { value: 1,    since: '9.0',  evidence: 'grafana/alerting-provisioning' },
          recordBlock:          { value: true, since: '11.0', evidence: 'grafana#8213x' },
          keepFiringFor:        { value: true, since: '10.4', evidence: 'grafana#83025' },
          notificationSettings: { value: true, since: '11.0', evidence: 'grafana#80162' },
        },
      },
      {
        id: 'gap-9', range: '>=9 <11', label: 'unified alerting (Grafana 9–10)',
        features: {
          apiVersion:           { value: 1,     since: '9.0',  evidence: 'grafana/alerting-provisioning' },
          recordBlock:          { value: false, since: '11.0', evidence: 'grafana#82013' },
          keepFiringFor:        { value: false, since: '10.4', evidence: 'grafana#83025' },
          notificationSettings: { value: false, since: '11.0', evidence: 'grafana#80162' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // OTel Collector config. `logging` exporter renamed `debug` in 0.86;
  // service.telemetry.metrics.address deprecated for `readers`. Partial: the
  // full config is validated by the Collector's own Go confmap unmarshaller.
  // -------------------------------------------------------------------------
  'otel-collector-config': {
    label: 'OTel Collector config',
    tractability: 'partial',
    upstream: { repo: 'open-telemetry/opentelemetry-collector', latestKnown: '0.96' },
    versions: [
      {
        id: 'occ-0.96', range: '>=0.96', label: 'Collector config 0.96+',
        features: {
          debugExporter:           { value: true, since: '0.86', evidence: 'opentelemetry-collector#7769' },
          telemetryMetricsReaders: { value: true, since: '0.96', evidence: 'opentelemetry-collector#9322' },
        },
      },
      {
        id: 'occ-0.86', range: '>=0.86 <0.96', label: 'Collector config 0.86–0.95',
        features: {
          debugExporter:           { value: true,  since: '0.86', evidence: 'opentelemetry-collector#7769' },
          telemetryMetricsReaders: { value: false, since: '0.96', evidence: 'opentelemetry-collector#9322' },
        },
      },
      {
        id: 'occ-pre-0.86', range: '<0.86', label: 'Collector config <0.86',
        features: {
          debugExporter:           { value: false, since: '0.86', evidence: 'opentelemetry-collector#7769' },
          telemetryMetricsReaders: { value: false, since: '0.96', evidence: 'opentelemetry-collector#9322' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Alertmanager config. msteamsv2_configs added in 0.28; msteams_configs in
  // 0.26. Route/receiver shape otherwise stable.
  // -------------------------------------------------------------------------
  'alertmanager-config': {
    label: 'Alertmanager config',
    tractability: 'partial',
    upstream: { repo: 'prometheus/alertmanager', latestKnown: '0.28' },
    versions: [
      {
        id: 'amc-0.28', range: '>=0.28', label: 'Alertmanager config 0.28+',
        features: {
          msteamsV2: { value: true, since: '0.28', evidence: 'alertmanager#3819' },
          msteams:   { value: true, since: '0.26', evidence: 'alertmanager#3324' },
        },
      },
      {
        id: 'amc-0.26', range: '>=0.26 <0.28', label: 'Alertmanager config 0.26–0.27',
        features: {
          msteamsV2: { value: false, since: '0.28', evidence: 'alertmanager#3819' },
          msteams:   { value: true,  since: '0.26', evidence: 'alertmanager#3324' },
        },
      },
      {
        id: 'amc-pre-0.26', range: '<0.26', label: 'Alertmanager config <0.26',
        features: {
          msteamsV2: { value: false, since: '0.28', evidence: 'alertmanager#3819' },
          msteams:   { value: false, since: '0.26', evidence: 'alertmanager#3324' },
        },
      },
    ],
  },

  // -------------------------------------------------------------------------
  // Blackbox exporter module config. The http / tcp / icmp probers and their
  // module settings (valid_status_codes, fail_if_body_*_regexp, fail_if_not_ssl,
  // preferred_ip_protocol) predate every version we profile; the grpc prober
  // arrived in 0.20. A grpc:// target compiled for an older exporter is
  // skipped with a warning rather than emitted as a module it cannot load.
  // -------------------------------------------------------------------------
  'blackbox-exporter-config': {
    label: 'Blackbox exporter config',
    tractability: 'partial',
    upstream: { repo: 'prometheus/blackbox_exporter', latestKnown: '0.27' },
    versions: [
      {
        id: 'bbc-0.20', range: '>=0.20', label: 'Blackbox config 0.20+',
        features: {
          grpcProber: { value: true, since: '0.20', evidence: 'blackbox_exporter v0.20.0 (gRPC prober)' },
        },
      },
      {
        id: 'bbc-pre-0.20', range: '<0.20', label: 'Blackbox config <0.20',
        features: {
          grpcProber: { value: false, since: '0.20', evidence: 'blackbox_exporter v0.20.0 (gRPC prober)' },
        },
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

// Flatten a version's `features` map ({ key: {value, since, evidence} }) into a
// plain { key: value } knob map for the compiler to consume.
function flattenFeatures(features) {
  const out = {};
  for (const [k, f] of Object.entries(features || {})) {
    out[k] = (f && typeof f === 'object' && 'value' in f) ? f.value : f;
  }
  return out;
}

// Resolve which version of a protocol a given selector (a version string)
// lands on. Returns { protocol, id, label, range, features (flattened),
// tractability } or null when the protocol is unknown / no version matches.
export function resolveProtocolVersion(protocolId, selector) {
  const proto = PROTOCOLS[protocolId];
  if (!proto) return null;
  const ver = proto.versions.find((pv) => satisfies(selector, pv.range)) || null;
  if (!ver) return null;
  return {
    protocol: protocolId,
    id: ver.id,
    label: ver.label,
    range: ver.range,
    features: flattenFeatures(ver.features),
    tractability: proto.tractability,
  };
}

// Enumerate the protocol registry for UIs / docs / the drift checker.
export function listProtocols() {
  return Object.entries(PROTOCOLS).map(([id, p]) => ({
    id,
    label: p.label,
    tractability: p.tractability,
    upstream: p.upstream || null,
    versions: p.versions.map((v) => ({ id: v.id, range: v.range, label: v.label })),
  }));
}
