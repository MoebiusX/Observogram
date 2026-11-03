// tools/lib/blackbox.mjs
//
// Canonical ObservabilityPack → Blackbox exporter configuration: the first
// PRODUCER-side compile target. Every other target (rules, collector,
// Alertmanager, dashboards) consumes series that already exist; this one
// emits the thing that makes `probe_success`, `probe_duration_seconds` and
// `probe_ssl_earliest_cert_expiry` exist for the pack's synthetic checks.
//
// Two artefacts, from spec.validation.synthetic_checks[]:
//
//   modules        blackbox.yml — one module per check of kind
//                  `blackbox-exporter`, named by the check id. The prober
//                  follows the target (https?:// → http, grpc:// → grpc,
//                  tcp:// or host:port → tcp, a bare host → icmp); the
//                  assertions the exporter can enforce become module settings
//                  (status codes, body regexes, TLS required); the ones it
//                  cannot (latency, certificate expiry) are named in the banner
//                  as rules on the probe series, never silently dropped.
//   scrape-config  the Prometheus scrape jobs that drive those modules — one
//                  job per check (`blackbox-<id>`, the check's interval, the
//                  standard __param_target / instance relabelling) so the probed
//                  URL is the `instance` label the dashboards and rules read.
//
// Checks declared for another engine (elastic-synthetics, checkly, k6,
// grafana-synthetics) are NOT compiled: the pack names their engine of
// record, and a blackbox stand-in would verify against series the real
// engine never writes. They are listed in the banner so nothing is hidden.
//
// Pure ESM, browser-friendly. No Node APIs.

import { emit as emitYaml } from './mini-yaml.mjs';
import { fileSlug as slug } from './slug.mjs';
import { SPEC_VERSION } from './validator.mjs';

export const BLACKBOX_KIND = 'blackbox-exporter';
export const DEFAULT_BLACKBOX_ADDRESS = 'blackbox-exporter:9115';
// Prometheus's default scrape_timeout; the exporter's module timeout must stay
// under the scrape timeout or the probe is cut off before it can report.
export const DEFAULT_PROBE_TIMEOUT_SECONDS = 10;

// ------------------------------------------------------------
// Small helpers
// ------------------------------------------------------------

const DURATION_UNITS = { ms: 0.001, s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export function durationSeconds(d) {
  if (typeof d === 'number' && Number.isFinite(d)) return d;
  const m = /^\s*(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)\s*$/.exec(String(d ?? ''));
  if (!m) return null;
  return Number(m[1]) * DURATION_UNITS[m[2]];
}

export function formatDuration(seconds) {
  if (seconds == null) return null;
  if (seconds < 1) return `${Math.round(seconds * 1000)}ms`;
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

const escapeRegex = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);

function nameOf(canonical) {
  return canonical?.metadata?.name || canonical?.metadata?.bindings?.service || 'service';
}
function serviceSlug(canonical) {
  return slug(nameOf(canonical));
}

// The prober a target asks for, and the address the exporter is handed.
// The blackbox exporter takes the full URL for http, host:port for tcp and
// grpc, and a host for icmp — the scheme the pack wrote is for us, not for it.
export function classifyTarget(target) {
  const t = String(target ?? '').trim();
  if (!t) return { prober: null, address: t, reason: 'the check has no target' };
  if (/^https?:\/\//i.test(t)) return { prober: 'http', address: t, tls: /^https:/i.test(t) };
  if (/^grpcs?:\/\//i.test(t)) return { prober: 'grpc', address: t.replace(/^grpcs?:\/\//i, ''), tls: /^grpcs:/i.test(t) };
  if (/^tcps?:\/\//i.test(t)) return { prober: 'tcp', address: t.replace(/^tcps?:\/\//i, ''), tls: /^tcps:/i.test(t) };
  if (/^icmp:\/\//i.test(t)) return { prober: 'icmp', address: t.replace(/^icmp:\/\//i, '') };
  if (/^[^\s/:]+:\d{1,5}$/.test(t)) return { prober: 'tcp', address: t, tls: false };
  if (/^[^\s/:]+$/.test(t) && !/\$\{/.test(t)) return { prober: 'icmp', address: t };
  return { prober: null, address: t, reason: 'the target is not a URL, a host:port or a host the blackbox exporter can probe' };
}

// ------------------------------------------------------------
// The plan — what each check becomes, with the notes the banner prints
// ------------------------------------------------------------

// planBlackboxChecks(canonical, opts) → { modules, skipped, warnings }
//   modules[]  { id, check, prober, address, module, notes[] }
//   skipped[]  { id, kind, reason }   — nothing compiled, reason stated
//   warnings[] strings, also pushed to opts.onWarning when given
// opts.knobs: the resolved profile knobs (grpcProber); opts.checkId limits
// the plan to one check (the per-check artifact).
export function planBlackboxChecks(canonical, opts = {}) {
  const checks = canonical?.spec?.validation?.synthetic_checks || [];
  const knobs = opts.knobs || opts.profile?.knobs || {};
  const warnings = [];
  const warn = (m) => { warnings.push(m); if (typeof opts.onWarning === 'function') opts.onWarning(m); };
  const modules = [];
  const skipped = [];

  for (const check of checks) {
    if (!isObj(check) || !check.id) continue;
    if (opts.checkId && check.id !== opts.checkId) continue;
    const id = String(check.id);
    if (check.kind !== BLACKBOX_KIND) {
      skipped.push({ id, kind: check.kind || '?', reason: `declared for ${check.kind || 'an unnamed engine'} — its engine of record, not the blackbox exporter` });
      continue;
    }
    const where = classifyTarget(check.target);
    if (!where.prober) {
      skipped.push({ id, kind: check.kind, reason: where.reason });
      warn(`blackbox: ${id} is not compiled — ${where.reason} (target ${JSON.stringify(String(check.target ?? ''))})`);
      continue;
    }
    if (where.prober === 'grpc' && knobs.grpcProber === false) {
      skipped.push({ id, kind: check.kind, reason: 'the grpc prober needs blackbox exporter 0.20 or newer' });
      warn(`blackbox: ${id} is not compiled — the grpc prober needs blackbox exporter 0.20 or newer, the pack declares an older one`);
      continue;
    }

    const notes = [];
    const intervalSeconds = durationSeconds(check.interval);
    const timeoutSeconds = intervalSeconds != null && intervalSeconds < DEFAULT_PROBE_TIMEOUT_SECONDS
      ? intervalSeconds
      : DEFAULT_PROBE_TIMEOUT_SECONDS;
    const module = { prober: where.prober, timeout: formatDuration(timeoutSeconds) };
    const section = { preferred_ip_protocol: 'ip4' };
    module[where.prober] = section;
    if (where.prober === 'grpc' && where.tls) section.tls = true;
    if (where.prober === 'tcp' && where.tls) section.tls = true;

    const validStatus = [];
    const mustMatch = [];
    const mustNotMatch = [];
    for (const assertion of Array.isArray(check.assertions) ? check.assertions : []) {
      if (!isObj(assertion)) { warn(`blackbox: ${id} has an assertion that is not an object — ignored`); continue; }
      for (const [key, value] of Object.entries(assertion)) {
        const httpOnly = () => {
          if (where.prober === 'http') return true;
          notes.push(`${key} ${JSON.stringify(value)} → not applicable to the ${where.prober} prober`);
          warn(`blackbox: ${id} asserts ${key} on a ${where.prober} target — the ${where.prober} prober has no such setting`);
          return false;
        };
        switch (key) {
          case 'status_code':
          case 'status_codes': {
            if (!httpOnly()) break;
            const codes = (Array.isArray(value) ? value : [value]).map((c) => Number(c));
            if (codes.every((c) => Number.isInteger(c) && c >= 100 && c <= 599)) validStatus.push(...codes);
            else {
              notes.push(`${key} ${JSON.stringify(value)} → not expressible: valid_status_codes takes integer codes`);
              warn(`blackbox: ${id} asserts ${key} ${JSON.stringify(value)} — valid_status_codes takes integer HTTP codes only`);
            }
            break;
          }
          case 'body_contains':
            if (httpOnly()) mustMatch.push(escapeRegex(value));
            break;
          case 'body_not_contains':
            if (httpOnly()) mustNotMatch.push(escapeRegex(value));
            break;
          case 'body_matches':
          case 'body_regex':
            if (httpOnly()) mustMatch.push(String(value));
            break;
          case 'body_not_matches':
            if (httpOnly()) mustNotMatch.push(String(value));
            break;
          case 'tls_expiry_gt': {
            const s = durationSeconds(value);
            if (where.prober === 'http') section.fail_if_not_ssl = true;
            else if (where.prober === 'tcp' || where.prober === 'grpc') section.tls = true;
            else { notes.push(`tls_expiry_gt ${JSON.stringify(value)} → not applicable to the ${where.prober} prober`); break; }
            notes.push(`tls_expiry_gt ${value} → TLS is required by the module; the horizon is a rule: probe_ssl_earliest_cert_expiry{instance="${where.address}"} - time() < ${s ?? '?'}`);
            break;
          }
          case 'latency_lt':
          case 'round_trip_latency_lt':
          case 'duration_lt': {
            const s = durationSeconds(value);
            notes.push(`${key} ${value} → not a module setting; a rule: probe_duration_seconds{instance="${where.address}"} > ${s ?? '?'}`);
            break;
          }
          default:
            notes.push(`${key} ${JSON.stringify(value)} → no blackbox module setting; left to a rule or to review`);
            warn(`blackbox: ${id} asserts ${key}, which has no blackbox module setting — left to a rule or to review`);
        }
      }
    }
    if (validStatus.length) section.valid_status_codes = [...new Set(validStatus)];
    if (mustMatch.length) section.fail_if_body_not_matches_regexp = mustMatch;
    if (mustNotMatch.length) section.fail_if_body_matches_regexp = mustNotMatch;
    if (check.otel_instrumentation === true) {
      notes.push('otel_instrumentation: true → not honoured: the blackbox exporter does not propagate traceparent');
      warn(`blackbox: ${id} asks for otel_instrumentation, which the blackbox exporter cannot provide (no traceparent on the probe)`);
    }

    modules.push({ id, check, prober: where.prober, address: where.address, module, notes });
  }

  return { modules, skipped, warnings };
}

// ------------------------------------------------------------
// Banners
// ------------------------------------------------------------

function header(title, canonical, generatedBy) {
  return (
    `# ${title} compiled from ObservabilityPack v${SPEC_VERSION}\n` +
    `# Pack: ${nameOf(canonical)} · version ${canonical?.metadata?.version || '?'}\n` +
    `# Source of truth — DO NOT hand-edit. Re-emit from the pack.\n` +
    `# Generated by tools/lib/blackbox.mjs${generatedBy ? ` (${generatedBy})` : ''}\n`
  );
}

function describeModule(m) {
  const c = m.check;
  const settings = [];
  const s = m.module[m.prober] || {};
  if (s.valid_status_codes) settings.push(`status ${s.valid_status_codes.join('|')}`);
  if (s.fail_if_body_not_matches_regexp) settings.push(`body must match ${s.fail_if_body_not_matches_regexp.map((r) => JSON.stringify(r)).join(', ')}`);
  if (s.fail_if_body_matches_regexp) settings.push(`body must not match ${s.fail_if_body_matches_regexp.map((r) => JSON.stringify(r)).join(', ')}`);
  if (s.fail_if_not_ssl || s.tls) settings.push('TLS required');
  const lines = [
    `# ${m.id} · ${m.prober} · ${m.address} · every ${c.interval} · timeout ${m.module.timeout} · ${c.on_fail_severity || 'severity ?'}`,
  ];
  if (settings.length) lines.push(`#   ${settings.join(' · ')}`);
  for (const n of m.notes) lines.push(`#   ${n}`);
  return lines.join('\n');
}

function planBanner(plan, { address } = {}) {
  const out = ['#'];
  if (plan.modules.length) {
    out.push(`# ${plan.modules.length} module${plan.modules.length === 1 ? '' : 's'}, one per synthetic check of kind ${BLACKBOX_KIND}, named by the check id.`);
    out.push(`# The scrape job that drives each one passes module=<id>&target=<address> to ${address || DEFAULT_BLACKBOX_ADDRESS}/probe`);
    out.push('# (the synthetics/scrape-config artifact); the probed address is its `instance` label.');
    if (plan.modules.some((m) => m.notes.length)) {
      out.push('# What a module cannot enforce is named under its check: latency and certificate horizons are rules on the probe series.');
    }
    out.push('#');
    for (const m of plan.modules) out.push(describeModule(m));
  } else {
    out.push(`# No synthetic check of kind ${BLACKBOX_KIND} in this pack: nothing for the blackbox exporter to probe.`);
  }
  if (plan.skipped.length) {
    out.push('#');
    out.push('# Not compiled:');
    for (const s of plan.skipped) out.push(`#   ${s.id} · ${s.reason}`);
  }
  return out.join('\n') + '\n';
}

// ------------------------------------------------------------
// The two artefacts
// ------------------------------------------------------------

// blackbox.yml — `modules:` keyed by check id.
export function compileBlackboxModules(canonical, opts = {}) {
  const plan = planBlackboxChecks(canonical, opts);
  const modules = {};
  for (const m of plan.modules) modules[m.id] = m.module;
  const title = opts.checkId ? `Blackbox exporter module — ${opts.checkId}` : 'Blackbox exporter modules';
  return header(title, canonical, 'blackbox.yml') + planBanner(plan, opts) + emitYaml({ modules });
}

// The Prometheus scrape jobs for those modules. One job per check so each
// keeps its own interval; the relabelling is the exporter's documented one.
export function compileBlackboxScrapeConfig(canonical, opts = {}) {
  const plan = planBlackboxChecks(canonical, opts);
  const address = opts.blackboxAddress || DEFAULT_BLACKBOX_ADDRESS;
  const service = nameOf(canonical);
  const scrape_configs = plan.modules.map((m) => ({
    job_name: `blackbox-${m.id}`,
    metrics_path: '/probe',
    scrape_interval: m.check.interval,
    scrape_timeout: m.module.timeout,
    params: { module: [m.id] },
    static_configs: [{ targets: [m.address], labels: { service, check: m.id } }],
    relabel_configs: [
      { source_labels: ['__address__'], target_label: '__param_target' },
      { source_labels: ['__param_target'], target_label: 'instance' },
      { target_label: '__address__', replacement: address },
    ],
  }));
  const where = [
    '#',
    `# Paste under \`scrape_configs:\` of prometheus.yml, or under the prometheus receiver's config in the collector file.`,
    `# The exporter is reached at ${address} (opts.blackboxAddress to change it); each job names the probed address as \`instance\`,`,
    '# so probe_success{instance="<address>"} is the series the rules and dashboards read.',
    '',
  ].join('\n');
  return header('Prometheus scrape jobs for the blackbox exporter', canonical, 'scrape_configs') + where + planBanner(plan, { address }) + emitYaml({ scrape_configs });
}

export function blackboxFileName(canonical, { checkId } = {}) {
  return checkId ? `${serviceSlug(canonical)}.${slug(checkId)}.blackbox.yaml` : `${serviceSlug(canonical)}.blackbox.yaml`;
}
export function blackboxScrapeFileName(canonical) {
  return `${serviceSlug(canonical)}.blackbox.scrape.yaml`;
}
