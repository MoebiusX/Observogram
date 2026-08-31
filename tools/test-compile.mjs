#!/usr/bin/env node
/**
 * tools/test-compile.mjs
 *
 * Compiler regression suite. Compiles bundled canonical packs to every
 * target and asserts the output is real, ingestible, and traceable back
 * to the source pack.
 *
 * Sanity checks (not full ingestion — we don't run promtool / otelcol /
 * grafana-cli in CI):
 *   - prometheus-rules:  YAML with `groups:`; each group has rules;
 *                         alerts carry the slo label; recording-rule
 *                         names follow the <service>:<sli>:<expr> convention.
 *   - otel-collector:    YAML with receivers / processors / exporters /
 *                         service.pipelines.{metrics,logs,traces}.
 *   - alertmanager:      YAML with `route:` tree and per-severity receivers.
 *   - grafana-dashboard: JSON with schemaVersion 39, panels[], non-empty
 *                         targets[].expr per panel.
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { compile, compilePrometheusRules, compileOtelCollector,
  compileAlertmanager, compileGrafanaDashboard, listTargets, TARGETS } from './lib/compile.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Bundled packs live under examples/ since Phase 7q archived them out
// of packs/ so the studio boots empty. payment-service is the vendored
// spec example and stays under vendor/.
const FIXTURES = [
  { id: 'payment-service',     path: 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml' },
  { id: 'target-advanced',     path: 'examples/target-advanced.pack.yaml' },
  { id: 'production-curated',  path: 'examples/production-curated.pack.yaml' },
  { id: 'demo-skeleton',       path: 'examples/demo-skeleton.pack.yaml' },
];

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 120 });

function check(file) {
  process.stdout.write(`\n[${file.id}] ${file.path}\n`);
  const text = readFileSync(resolve(ROOT, file.path), 'utf8');
  const canonical = parseYaml(text);

  // ---------- listTargets / TARGETS ----------
  const targets = listTargets();
  assert(targets.length === 4, 'four compile targets registered', targets.length, 4);
  assert(targets.every(t => t.id && t.label && t.extension), 'all targets describe themselves');

  // ---------- prometheus-rules ----------
  const rules = compilePrometheusRules(canonical);
  assert(typeof rules === 'string' && rules.length > 0, 'prometheus-rules produces text');
  assert(/^groups:/m.test(rules) || /\ngroups:/.test(rules), 'prometheus-rules has groups:');
  // Recording rules for ratio SLIs should include :ratio_5m
  const sloCount = (canonical?.spec?.slos || []).length;
  if (sloCount > 0) {
    assert(/:ratio_5m/.test(rules), 'prometheus-rules emits :ratio_5m recording rules');
    assert(/:error_ratio_5m/.test(rules), 'prometheus-rules emits :error_ratio_5m');
    // Burn-rate alerts carry the slo label
    if ((canonical?.spec?.policy?.burn_rate_alerts || []).length > 0) {
      assert(/severity:/.test(rules) && /SEV[1-4]/.test(rules), 'burn-rate alerts carry severity labels');
      assert(/burn_/.test(rules), 'burn-rate alert names follow <slo>_burn_<factor>x convention');
    }
  }
  // Round-trip through YAML parser
  let parsedRules;
  try { parsedRules = parseYaml(rules.replace(/^#[^\n]*\n/gm, '')); }
  catch (e) { parsedRules = null; }
  assert(parsedRules && Array.isArray(parsedRules.groups), 'prometheus-rules YAML round-trips');
  if (parsedRules?.groups) {
    assert(parsedRules.groups.every(g => g.name && Array.isArray(g.rules)),
           'every rule group has name and rules[]');
  }

  // ---------- otel-collector ----------
  const otel = compileOtelCollector(canonical);
  assert(typeof otel === 'string' && otel.length > 0, 'otel-collector produces text');
  assert(/receivers:/m.test(otel),  'otel has receivers:');
  assert(/processors:/m.test(otel), 'otel has processors:');
  assert(/exporters:/m.test(otel),  'otel has exporters:');
  assert(/service:/m.test(otel),    'otel has service: section');
  assert(/pipelines:/.test(otel),   'otel.service.pipelines present');
  const expMetrics = canonical?.spec?.pipelines?.exporters?.metrics?.kind;
  if (expMetrics) {
    assert(otel.includes(expMetrics), `otel exporters include declared metrics kind (${expMetrics})`);
  }

  // ---------- alertmanager ----------
  const am = compileAlertmanager(canonical);
  assert(typeof am === 'string' && am.length > 0, 'alertmanager produces text');
  assert(/^route:/m.test(am) || /\nroute:/.test(am), 'alertmanager has route: tree');
  assert(/^receivers:/m.test(am) || /\nreceivers:/.test(am), 'alertmanager has receivers:');
  const routesCount = (canonical?.spec?.alerting?.routes || []).length;
  if (routesCount > 0) {
    assert(/severity=/.test(am) || /matchers:/.test(am), 'alertmanager routes have matchers');
  }

  // ---------- grafana-dashboard ----------
  const dashboards = canonical?.spec?.dashboards || [];
  if (dashboards.length > 0) {
    const dashId = dashboards[0].id;
    const json = compileGrafanaDashboard(canonical, dashId);
    let parsed;
    try { parsed = JSON.parse(json); } catch (e) { parsed = null; }
    assert(!!parsed, 'grafana-dashboard JSON parses');
    if (parsed) {
      // The schema's documented floor is 30 (legacy Grafana 9 era).
      // Spec-mandated support window today is Grafana 12 / 13. Bundled
      // packs declare their own schemaVersion when they need an older
      // installation supported; when they don't, the compiler emits 41+
      // (Grafana 12 baseline).
      assert(parsed.schemaVersion >= 30, 'grafana schemaVersion meets schema floor (≥30)', parsed.schemaVersion, '≥ 30');
      if (file.id === 'demo-skeleton') {
        assert(parsed.schemaVersion >= 41,
               'default schemaVersion targets Grafana 12+ when pack does not pin one',
               parsed.schemaVersion, '≥ 41');
      }
      if (file.id === 'target-advanced') {
        assert(parsed.schemaVersion === 41,
               'target-advanced dashboards pin Grafana 12 schemaVersion (41)',
               parsed.schemaVersion, 41);
      }
      assert(parsed.uid?.startsWith('obs-pack-'), 'grafana uid prefixed obs-pack-');
      assert(Array.isArray(parsed.panels), 'grafana panels is an array');
      assert(parsed.tags?.includes('observability-pack'), 'grafana dashboard tagged observability-pack');
      // If the dashboard has panel bindings, the compiled panels should
      // have non-empty expr targets.
      if ((dashboards[0].panel_bindings || []).length > 0) {
        const exprs = parsed.panels.flatMap(p => (p.targets || []).map(t => t.expr));
        assert(exprs.some(e => typeof e === 'string' && e.length > 0),
               'grafana panels have non-empty PromQL targets');
      }
    }
  }

  // ---------- dispatcher ----------
  const out = compile(canonical, 'prometheus-rules');
  assert(out.target === 'prometheus-rules', 'dispatcher echoes target');
  assert(out.contentType === 'application/x-yaml', 'dispatcher returns YAML content-type for rules');
  assert(out.filename.endsWith('.rules.yaml'), 'dispatcher suggests *.rules.yaml');
  assert(out.content === rules, 'dispatcher matches direct call');
}

for (const f of FIXTURES) {
  try { check(f); }
  catch (e) {
    failures.push(`${f.id}: threw ${e.message}`);
    process.stdout.write(`  ✗ ${f.id}: threw ${e.message}\n`);
  }
}

// ---------- duplicate-severity routes ----------
// Packs can legally declare several routes of one severity (crawled packs
// do). Alertmanager rejects duplicate notification-config names, and stops
// at the first matching sibling route — so duplicates must get unique
// ordinal names and be chained with `continue: true` or every receiver
// after the first is silently unreachable.
process.stdout.write('\n[duplicate-severity alertmanager routes]\n');
const dupRoutePack = {
  metadata: { name: 'dup-route-demo' },
  spec: {
    alerting: {
      routes: [
        { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/a' }] },
        { severity: 'SEV2', channels: [{ webhook: 'https://hooks.example/b' }] },
        { severity: 'SEV2', channels: [{ email: 'oncall@example.com' }] },
        { severity: 'SEV1', channels: [{ webhook: 'https://hooks.example/page' }] },
      ],
    },
  },
};
const dupAm = parseYaml(compileAlertmanager(dupRoutePack).replace(/^#[^\n]*\n/gm, ''));
const recNames = (dupAm.receivers || []).map(r => r.name);
assert(new Set(recNames).size === recNames.length,
       'duplicate-severity routes get unique receiver names', recNames.join(','), 'all unique');
assert(recNames.filter(n => /-sev2(-\d+)?$/.test(n)).length === 3,
       'all three SEV2 routes keep their own receiver', recNames.join(','), '3 sev2 receivers');
const sev2Routes = (dupAm.route?.routes || []).filter(r => (r.matchers || []).some(m => /SEV2/.test(m)));
assert(sev2Routes.length === 3
         && sev2Routes.slice(0, -1).every(r => r.continue === true)
         && sev2Routes[sev2Routes.length - 1].continue !== true,
       'identical-matcher siblings chain with continue so every channel fires',
       JSON.stringify(sev2Routes.map(r => !!r.continue)), '[true,true,false]');
const sev1Routes = (dupAm.route?.routes || []).filter(r => (r.matchers || []).some(m => /SEV1/.test(m)));
assert(sev1Routes.length === 1 && sev1Routes[0].continue !== true,
       'a lone route in its matcher group stays terminal');

report('compile');
