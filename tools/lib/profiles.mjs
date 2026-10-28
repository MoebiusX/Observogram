// tools/lib/profiles.mjs
//
// PRODUCT PROFILES — product@version bound to the protocols it speaks.
//
// A *profile* is the resolved canon for ONE product at ONE version: the union
// of the feature sets of every protocol that product speaks at that version,
// plus any product-level *dialect* overrides. The compiler resolves a profile
// from the version the pack declares (or an explicit override) and shapes every
// artefact through it.
//
// The facts themselves live in protocols.mjs (the versioned canon). A product
// entry here is a thin *binding*: "at my version V, I speak protocol P at
// version W." Multiple products that bind to the same (protocol, version)
// converge on the same feature set — that's how Prometheus, Thanos, and Mimir
// share `keep_firing_for` without duplicating the fact. A product that consumes
// a protocol but diverges (VictoriaMetrics / MetricsQL) carries a `dialect`
// override that wins over the protocol features.
//
// The returned `knobs` map is intentionally the same flat shape the compiler
// already consumes, so compile.mjs and every existing test are unaffected by
// the protocol decomposition.
//
// TRACTABILITY ('native' / 'partial' / 'vendored-go-needed') is now a property
// of each *protocol* (see protocols.mjs); the product carries the family
// headline, and the resolved profile lists per-protocol tractability under
// `protocols[]`.
//
// Pure ESM, no Node APIs — the studio imports this in the browser.

import {
  parseVersion, satisfies, compareVersions, rangeFloor,
  resolveProtocolVersion, listProtocols, PROTOCOLS,
} from './protocols.mjs';

// Re-export the semver primitives so existing importers (and compile.mjs's
// re-export) keep working unchanged.
export { parseVersion, satisfies, compareVersions, listProtocols };

// ---------------------------------------------------------------------------
// Product registry
//
// Each product lists version bands newest-first. A band has:
//   range    semver range over the PRODUCT version
//   speaks   { protocolId: selectorVersion } — the protocol versions this
//            product band speaks, resolved against protocols.mjs.
//   dialect  optional knob overrides that win over the protocol features
//            (e.g. VictoriaMetrics omitting keep_firing_for).
//
// `family` / `tractability` are the product-family headline. `upstream` ties
// the product to a GitHub repo + the newest version we've profiled, for the
// staleness checker (tools/drift-profiles.mjs).
// ---------------------------------------------------------------------------

const PRODUCTS = {
  // ----- Metrics stores: speak the Prometheus rule format + PromQL ---------
  prometheus: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'prometheus/prometheus', latestKnown: '3' },
    bands: [
      { id: 'prom-3',    range: '>=3 <4',    label: 'Prometheus 3.x', default: true,
        speaks: { 'prometheus-rule-format': '3.0',  promql: '3.0' } },
      { id: 'prom-2.42', range: '>=2.42 <3', label: 'Prometheus 2.42+',
        speaks: { 'prometheus-rule-format': '2.42', promql: '2.42' } },
      { id: 'prom-2',    range: '>=2 <2.42', label: 'Prometheus 2.x (<2.42)',
        speaks: { 'prometheus-rule-format': '2.0',  promql: '2.0' } },
    ],
  },

  // Thanos consumes the Prometheus rule format and modern PromQL.
  thanos: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'thanos-io/thanos', latestKnown: '0.37' },
    bands: [
      { id: 'thanos', range: '*', label: 'Thanos', default: true,
        speaks: { 'prometheus-rule-format': '2.42', promql: '2.49' } },
    ],
  },

  // Mimir / Cortex: rule format on par with Prometheus 3, modern PromQL.
  mimir: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'grafana/mimir', latestKnown: '2.15' },
    bands: [
      { id: 'mimir', range: '*', label: 'Mimir / Cortex', default: true,
        speaks: { 'prometheus-rule-format': '3.0', promql: '2.49' } },
    ],
  },

  // VictoriaMetrics vmalert consumes the Prometheus rule format but speaks the
  // MetricsQL dialect — notably it does NOT support keep_firing_for. The
  // dialect override wins over the bound protocol's features.
  victoriametrics: {
    family: 'prometheus-rules',
    tractability: 'vendored-go-needed',
    upstream: { repo: 'VictoriaMetrics/VictoriaMetrics', latestKnown: '1.99' },
    bands: [
      { id: 'vm', range: '*', label: 'VictoriaMetrics vmalert', default: true,
        speaks: { 'prometheus-rule-format': '2.42' },
        dialect: { keepFiringFor: false, queryLanguage: 'metricsql' } },
    ],
  },

  // ----- Grafana: dashboard schema + alerting provisioning -----------------
  grafana: {
    family: 'grafana-dashboard',
    tractability: 'native',
    upstream: { repo: 'grafana/grafana', latestKnown: '13' },
    bands: [
      { id: 'grafana-13', range: '>=13 <14', label: 'Grafana 13.x',
        speaks: { 'grafana-dashboard-schema': '13', 'grafana-alerting-provisioning': '13' } },
      { id: 'grafana-12', range: '>=12 <13', label: 'Grafana 12.x', default: true,
        speaks: { 'grafana-dashboard-schema': '12', 'grafana-alerting-provisioning': '12' } },
      { id: 'grafana-11', range: '>=11 <12', label: 'Grafana 11.x',
        speaks: { 'grafana-dashboard-schema': '11', 'grafana-alerting-provisioning': '11' } },
      { id: 'grafana-10', range: '>=10 <11', label: 'Grafana 10.x',
        speaks: { 'grafana-dashboard-schema': '10', 'grafana-alerting-provisioning': '10' } },
      { id: 'grafana-9',  range: '>=9 <10',  label: 'Grafana 9.x',
        speaks: { 'grafana-dashboard-schema': '9', 'grafana-alerting-provisioning': '9' } },
    ],
  },

  // Grafana-managed rules — the alerting/recording provisioning family,
  // version-tracked by the Grafana release.
  'grafana-managed': {
    family: 'grafana-managed-rules',
    tractability: 'partial',
    upstream: { repo: 'grafana/grafana', latestKnown: '13' },
    bands: [
      { id: 'gma-12', range: '>=11', label: 'Grafana 11–13 unified alerting', default: true,
        speaks: { 'grafana-alerting-provisioning': '12' } },
      { id: 'gma-10', range: '>=9 <11', label: 'Grafana 9–10 unified alerting',
        speaks: { 'grafana-alerting-provisioning': '10' } },
    ],
  },

  // ----- OTel Collector ----------------------------------------------------
  'otel-collector': {
    family: 'otel-collector',
    tractability: 'partial',
    upstream: { repo: 'open-telemetry/opentelemetry-collector', latestKnown: '0.96' },
    bands: [
      { id: 'otelcol-0.96+', range: '>=0.96', label: 'OTel Collector 0.96+', default: true,
        speaks: { 'otel-collector-config': '0.96' } },
      { id: 'otelcol-0.86', range: '>=0.86 <0.96', label: 'OTel Collector 0.86–0.95',
        speaks: { 'otel-collector-config': '0.86' } },
      { id: 'otelcol-pre-0.86', range: '<0.86', label: 'OTel Collector <0.86',
        speaks: { 'otel-collector-config': '0.80' } },
    ],
  },

  // ----- Alertmanager ------------------------------------------------------
  alertmanager: {
    family: 'alertmanager',
    tractability: 'partial',
    upstream: { repo: 'prometheus/alertmanager', latestKnown: '0.28' },
    bands: [
      { id: 'am-0.28+', range: '>=0.28', label: 'Alertmanager 0.28+', default: true,
        speaks: { 'alertmanager-config': '0.28' } },
      { id: 'am-0.26', range: '>=0.26 <0.28', label: 'Alertmanager 0.26–0.27',
        speaks: { 'alertmanager-config': '0.26' } },
      { id: 'am-pre-0.26', range: '<0.26', label: 'Alertmanager <0.26',
        speaks: { 'alertmanager-config': '0.20' } },
    ],
  },

  // ----- Blackbox exporter (the producer side of the synthetic checks) -----
  'blackbox-exporter': {
    family: 'blackbox-exporter',
    tractability: 'partial',
    upstream: { repo: 'prometheus/blackbox_exporter', latestKnown: '0.27' },
    bands: [
      { id: 'bb-0.20+', range: '>=0.20', label: 'Blackbox exporter 0.20+', default: true,
        speaks: { 'blackbox-exporter-config': '0.20' } },
      { id: 'bb-pre-0.20', range: '<0.20', label: 'Blackbox exporter <0.20',
        speaks: { 'blackbox-exporter-config': '0.19' } },
    ],
  },
};

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

// Resolve the profile for a product at a declared version. Composes the bound
// protocol feature sets into a flat `knobs` map (dialect overrides win), and
// reports which protocol versions were resolved.
//
// Returns a frozen object:
//   { product, family, tractability, version, band, label, knobs,
//     protocols: [{ protocol, version, label, tractability }],
//     matched, extrapolated }
//
//   matched=false, extrapolated=true  → version is newer than the newest band
//                                        we know; shaped as the newest band.
//   matched=false, extrapolated=false → version below all bands / unparseable;
//                                        fell back to the default band.
export function resolveProfile(product, version) {
  const key = normalizeProduct(product);
  const entry = PRODUCTS[key];
  if (!entry) {
    return Object.freeze({
      product: key, family: 'unknown', tractability: 'vendored-go-needed',
      version: version ?? null, band: null, label: `${product} (no profile)`,
      knobs: Object.freeze({}), protocols: Object.freeze([]),
      matched: false, extrapolated: false,
    });
  }

  const v = version != null ? parseVersion(version) : null;
  let band = v ? (entry.bands.find((b) => satisfies(version, b.range)) || null) : null;
  const matched = !!band;
  let extrapolated = false;

  if (!band) {
    // No band matched. If the version sits at/above the newest known band's
    // floor, it's a *future* version — shape it as the newest band and flag
    // the extrapolation rather than silently dropping to the default.
    const newest = entry.bands[0];
    if (v && compareVersions(v, rangeFloor(newest.range)) >= 0) {
      band = newest;
      extrapolated = true;
    } else {
      band = entry.bands.find((b) => b.default) || entry.bands[0];
    }
  }

  // Compose protocol feature sets → flat knobs.
  const knobs = {};
  const protocols = [];
  for (const [pid, selector] of Object.entries(band.speaks || {})) {
    const pv = resolveProtocolVersion(pid, selector);
    if (!pv) continue;
    Object.assign(knobs, pv.features);
    protocols.push({ protocol: pid, version: pv.id, label: pv.label, tractability: pv.tractability });
  }
  // Dialect overrides win over protocol features.
  if (band.dialect) Object.assign(knobs, band.dialect);

  return Object.freeze({
    product: key,
    family: entry.family,
    tractability: entry.tractability,
    version: version ?? null,
    band: band.id,
    label: band.label,
    knobs: Object.freeze({ ...knobs }),
    protocols: Object.freeze(protocols),
    matched,
    extrapolated,
  });
}

// Map common product aliases / images to a registry key.
function normalizeProduct(product) {
  const p = String(product || '').toLowerCase();
  if (/grafana-managed|grafana_managed/.test(p)) return 'grafana-managed';
  if (/victoria|vmalert|vm-/.test(p)) return 'victoriametrics';
  if (/otel|opentelemetry|collector/.test(p)) return 'otel-collector';
  if (/alertmanager/.test(p)) return 'alertmanager';
  if (/grafana/.test(p)) return 'grafana';
  if (/thanos/.test(p)) return 'thanos';
  if (/mimir|cortex/.test(p)) return 'mimir';
  if (/prometheus/.test(p)) return 'prometheus';
  return p;
}

// Enumerate the product registry for UIs / tests / the drift checker. Each
// band lists the protocols it binds so the UI can show the product→protocol map.
export function listProfiles() {
  return Object.entries(PRODUCTS).map(([product, entry]) => ({
    product,
    family: entry.family,
    tractability: entry.tractability,
    upstream: entry.upstream || null,
    bands: entry.bands.map((b) => ({
      id: b.id, range: b.range, label: b.label, default: !!b.default,
      speaks: Object.keys(b.speaks || {}),
      dialect: b.dialect ? Object.keys(b.dialect) : [],
    })),
  }));
}

// Expose the raw registries for the staleness checker (it reads `upstream` to
// know which repos and which "latest known" version to compare).
export { PRODUCTS, PROTOCOLS };
