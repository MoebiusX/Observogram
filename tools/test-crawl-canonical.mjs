#!/usr/bin/env node
// tools/test-crawl-canonical.mjs — a fresh crawl is a valid spec pack, whatever the repository throws at it.
//
// The crawler used to copy a folder name, a rule name, a group interval, a dashboard uid or schemaVersion and an
// alert-derived id into the manifest verbatim, fail its own schema, print the YAML anyway with "this is a crawler
// bug" and exit 3. Two fixture repositories on disk hold every such value (tools/fixtures/crawl/canonical/): this
// suite proves the library normalizes what it can spell canonically, records what the spec cannot hold as evidence,
// and that the CLI refuses the flags the spec cannot hold BEFORE the crawl (exit 2, nothing on stdout). The mirror
// pins hold the library's hand-written copies of the schema's Slug / Duration / Binding / Criticality rules to the
// vendored $defs, so a spec bump that moves a pattern fails here by name.
//
// Windows-safe by construction: every path through fileURLToPath (never .pathname), the CLI spawned with
// process.execPath, temp output in mkdtempSync(tmpdir()), the fixture tree read in sorted order. The CLI env drops
// OBSERVOGRAM_DIFF_SCOPE / TOMOGRAPH_DIFF_SCOPE (crawl-repo.mjs reads brandEnv('DIFF_SCOPE'); a CLI knob, not a
// boot knob, so serve-child.mjs's STRIP does not cover it).
//
// Run: node tools/test-crawl-canonical.mjs

import { readFileSync, readdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, relative, sep, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { crawlFiles } from './lib/crawler.mjs';
import { packSlug } from './lib/slug.mjs';
import { isSpecRecordingRuleName, SPEC_DURATION_RE } from './lib/sli-inference.mjs';
import { validate, validateCanonical, SPEC_VERSION, SPEC_SCHEMA_PATH } from './lib/validator.mjs';
import { parse as parseYaml } from './lib/mini-yaml.mjs';
import { adapt } from './lib/adapter.mjs';
import { createHarness } from './lib/harness.mjs';

const { assert, report } = createHarness({ truncate: 600 });

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCHEMA = JSON.parse(readFileSync(join(ROOT, ...SPEC_SCHEMA_PATH.split('/')), 'utf8'));
const FIXTURES = fileURLToPath(new URL('./fixtures/crawl/canonical/', import.meta.url));
const CRAWL = join(ROOT, 'tools', 'crawl-repo.mjs');
const VALIDATE = join(ROOT, 'tools', 'validate-pack.mjs');
const HOSTILE_DIR = join(FIXTURES, 'Hostile_Repo');
const TIER3_DIR = join(FIXTURES, 'tier3-alerts');
const HELM_DIR = join(FIXTURES, 'helm-dashboard');
const NOW = '2026-10-04T00:00:00.000Z';
const SLUG_RE = new RegExp(SCHEMA.$defs.Slug.pattern);

// The fixture directory as a file map, in sorted order (readdir order is not guaranteed: ext4 hashes, NTFS sorts).
function readTree(dir) {
  const out = new Map();
  (function walk(d) {
    for (const ent of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name !== 'README.md') out.set(relative(dir, p).split(sep).join('/'), readFileSync(p, 'utf8'));
    }
  })(dir);
  return out;
}
const errorsOf = (canonical) => validateCanonical(canonical, SCHEMA);
const env = { ...process.env };
delete env.OBSERVOGRAM_DIFF_SCOPE;
delete env.TOMOGRAPH_DIFF_SCOPE;
const cli = (...args) => spawnSync(process.execPath, [CRAWL, ...args], { encoding: 'utf8', env });

// ---------- the hostile repository, library level ----------
const hostile = crawlFiles(readTree(HOSTILE_DIR), { repoName: 'Hostile_Repo', now: NOW });
const { canonical, summary } = hostile;
const ann = canonical.metadata.annotations;

// 1. the headline
assert(errorsOf(canonical).length === 0, 'a crawl of the hostile repository validates against the vendored schema', errorsOf(canonical).slice(0, 5));

// 2. the name
assert(canonical.metadata.name === 'hostile_repo' && canonical.metadata.bindings.service === 'hostile_repo',
  'a non-Slug folder name is normalized into metadata.name and bindings.service', [canonical.metadata.name, canonical.metadata.bindings.service]);
assert(ann['crawler.nameNormalizedFrom'] === 'Hostile_Repo', 'the original name is kept in crawler.nameNormalizedFrom', ann['crawler.nameNormalizedFrom']);
assert(summary.warnings.some(w => w.includes("normalized to 'hostile_repo'")), 'the summary warns about the normalization', summary.warnings);
assert(JSON.stringify(summary.normalized.name) === JSON.stringify({ from: 'Hostile_Repo', to: 'hostile_repo' }), 'summary.normalized.name records from → to', summary.normalized);
assert(summary.environment.requested === 'prod' && summary.normalized.environment === null, 'the default environment is already a Slug: nothing normalized', summary.normalized);

// 3. recording rules: the spec's names only, the rest recorded as evidence; intervals as Durations; the Grafana record form read
const ruleNames = canonical.spec.queries.recording_rules.map(r => r.name);
assert(JSON.stringify(ruleNames) === JSON.stringify(['hostile:availability:good', 'hostile:availability:total', 'hostile:orders:rate5m']),
  'only <service>:<metric>:<op> rules are declared; the Grafana `record: { metric, from }` form is read', ruleNames);
assert(canonical.spec.queries.recording_rules.slice(0, 2).every(r => r.interval === '30s'), 'a numeric group interval becomes a Duration (30 → 30s)', canonical.spec.queries.recording_rules.map(r => r.interval));
const grafanaRule = canonical.spec.queries.recording_rules[2];
assert(grafanaRule.interval === '1m' && grafanaRule.expr === 'sum(rate(orders_total[5m]))', 'the Grafana recording rule keeps its stated 1m interval and takes its expr from the data node', grafanaRule);
const omitted = JSON.parse(ann['crawler.omitted.recording_rules']);
assert(JSON.stringify(omitted.map(r => r.name).sort()) === JSON.stringify([':node_memory_MemAvailable_bytes:sum', 'HTTP:Requests:Rate', 'apiserver_request:burnrate1d']),
  'the three non-conforming names are recorded in crawler.omitted.recording_rules', omitted);
assert(omitted.every(r => /^prometheus\/rules\.yml#hostile-slo\/.+$/.test(r.source)), 'each omitted rule names its <file>#<group>/<name> source', omitted);
assert(ann['crawler.omittedRecordingRuleCount'] === '3' && summary.discovered.recordingRulesOmitted === 3, 'the omitted count rides in the annotation and the summary', [ann['crawler.omittedRecordingRuleCount'], summary.discovered.recordingRulesOmitted]);
assert(summary.warnings.some(w => /3 recording rule\(s\) are not named/.test(w)), 'one warning names the omitted rules', summary.warnings);
const origins = JSON.parse(ann['crawler.discovered.metric_origins']);
assert('node_memory_MemAvailable_bytes' in origins, 'an omitted rule\'s expression still feeds the metric inventory (evidence is never lost)', Object.keys(origins));
assert(summary.omitted.ruleIntervals.length === 0, 'every interval in the fixture is a Duration once spelled', summary.omitted.ruleIntervals);

// 4. the operational alert is kept, its numeric label stringified
const diskFull = (canonical.spec.alerting.rules || []).find(r => r.name === 'DiskFull');
assert(diskFull && diskFull.labels.priority === '1', 'DiskFull is declared in alerting.rules with labels.priority as a string', diskFull);

// 5. dashboards: ids always Slugs, an old schemaVersion kept in params
const dashIds = canonical.spec.dashboards.map(d => d.id).sort();
assert(JSON.stringify(dashIds) === JSON.stringify(['a'.repeat(59), 'legacy', 'same', 'same']),
  'uid `--` falls back to the title, a 70-char uid is cut and trimmed, two same-uid files keep one id (commit 1)', dashIds);
assert(canonical.spec.dashboards.every(d => SLUG_RE.test(d.id) && d.id.length <= 64), 'every dashboard id matches the Slug pattern', dashIds);
const legacyDash = canonical.spec.dashboards.find(d => d.id === 'legacy');
assert(legacyDash.provider.schemaVersion === undefined && legacyDash.params.schema_version === 16,
  'schemaVersion 16 is below the spec minimum: not declared, kept in params.schema_version', legacyDash);
assert(summary.warnings.some(w => /dashboard legacy: schemaVersion 16 is below the spec minimum/.test(w)), 'the summary warns about the undeclared schemaVersion', summary.warnings);

// 6. the exporter alternation
assert(canonical.spec.pipelines.exporters.traces.kind === 'otlp', 'an otlphttp exporter is `otlp`, never prometheusremotewrite', canonical.spec.pipelines.exporters.traces);

// 7. no project-specific vocabulary
const text = JSON.stringify(canonical);
assert(!text.includes('krystalinex'), 'no downstream service name is invented for a server/ folder');
assert(!text.includes('sol_event_'), 'no product-family prefix is invented for a Java file under event/');
assert(origins.a_total?.service === 'hostile_repo', 'a metric under server/ belongs to the crawled service', origins.a_total);
assert('published_total' in origins, 'the Java counter under event/ is read under its own name', Object.keys(origins).filter(k => /published/.test(k)));

// 8. the tier is inferred from what was found; the backends keep their images
assert(canonical.metadata.bindings.criticality === 'tier-2', 'rules + dashboards + alertmanager infer tier-2', canonical.metadata.bindings.criticality);
assert(summary.scaffold.every(s => !/^telemetry\.backends\.[^.]+$/.test(s)), 'no real backend is parked as a scaffold', summary.scaffold);

// ---------- the Helm ConfigMap path: a dashboard without schemaVersion ----------
const helm = crawlFiles(readTree(HELM_DIR), { repoName: 'helm-dashboard', now: NOW });
assert(errorsOf(helm.canonical).length === 0, 'the Helm ConfigMap dashboard crawl validates', errorsOf(helm.canonical).slice(0, 3));
const helmDash = helm.canonical.spec.dashboards.find(d => d.id === 'helm-ops');
assert(helmDash && helmDash.params.schema_version === undefined && helmDash.provider.schemaVersion === 41,
  'a dashboard that states no schemaVersion keeps the 41 default (commit 1) and nothing in params', helmDash?.provider);

// ---------- tier-3 fallback: alert-derived ids are Slugs and Refs ----------
const tier3 = crawlFiles(readTree(TIER3_DIR), { repoName: 'tier3-alerts', now: NOW });
{
  const c = tier3.canonical;
  assert(errorsOf(c).length === 0, 'the alerts-only repository validates', errorsOf(c).slice(0, 5));
  const ids = [...c.spec.slis.map(s => s.id), ...c.spec.slos.map(s => s.id)];
  assert(ids.every(id => id.length <= 64 && SLUG_RE.test(id)), 'every alert-derived SLI/SLO id is a Slug of at most 64 characters', ids);
  const sliIds = new Set(c.spec.slis.map(s => s.id));
  const sloIds = new Set(c.spec.slos.map(s => s.id));
  assert(c.spec.slos.every(s => sliIds.has(s.sli)), 'every SLO references an emitted SLI', c.spec.slos.map(s => s.sli));
  assert(c.spec.policy.burn_rate_alerts.every(a => sloIds.has(a.slo)), 'every burn-rate alert references an emitted SLO', c.spec.policy.burn_rate_alerts.map(a => a.slo));
  assert(c.spec.slos.some(s => s.id.startsWith('tier3_alerts_5xxspike')), 'a digit-led alert name is prefixed with the service namespace', c.spec.slos.map(s => s.id));
  assert(adapt(c).layers.L1.length === 4, 'the adapter projects the two derived pairs', adapt(c).layers.L1.map(a => a.id));
}

// ---------- the empty repository and the programmatic doors ----------
{
  const empty = crawlFiles({}, { repoName: 'svc', now: NOW });
  assert(errorsOf(empty.canonical).length === 0, 'an empty repository validates', errorsOf(empty.canonical).slice(0, 3));
  const gh = crawlFiles({}, { repoName: '1password-x', now: NOW });
  assert(gh.canonical.metadata.name === 'svc-1password-x' && errorsOf(gh.canonical).length === 0,
    'a digit-led default name (the GitHub door\'s owner-repo) is prefixed, never truncated at the front', gh.canonical.metadata.name);
  const dup = crawlFiles({}, { repoName: 'svc', owners: ['team-a', 'team-a'], now: NOW });
  assert(JSON.stringify(dup.canonical.metadata.owners) === JSON.stringify(['team-a', 'team-a']), 'duplicate owners validate today and are emitted unchanged (no dedupe)', dup.canonical.metadata.owners);
  const own = crawlFiles({}, { repoName: 'svc', owners: ['Team Platform', 'ok-team'], environment: 'Prod', now: NOW });
  assert(JSON.stringify(own.canonical.metadata.owners) === JSON.stringify(['team-platform', 'ok-team']) && errorsOf(own.canonical).length === 0,
    'a non-Slug owner is normalized', own.canonical.metadata.owners);
  assert(!Object.values(own.canonical.metadata.annotations).some(v => /Team Platform/.test(v)), 'the raw owner string never reaches the annotations (an owner may be an address)');
  assert(JSON.stringify(own.summary.normalized.owners) === JSON.stringify([{ from: 'Team Platform', to: 'team-platform' }]), 'the raw owner is kept in the summary only', own.summary.normalized.owners);
  assert(own.canonical.metadata.bindings.environments[0] === 'prod' && own.canonical.metadata.annotations['crawler.environmentNormalizedFrom'] === 'Prod' && own.summary.environment.requested === 'Prod',
    'a non-Slug environment is normalized, the original kept in the annotation and summary.environment.requested', [own.canonical.metadata.bindings.environments, own.summary.environment.requested]);
  const long = crawlFiles({}, { repoName: 'x'.repeat(70), now: NOW });
  assert(errorsOf(long.canonical).length === 0 && long.canonical.spec.dashboards[0].id.length <= 64 && long.canonical.spec.validation.synthetic_checks[0].id.length <= 64,
    'a 64-character name still yields Slug stub ids (dashboard, synthetic check)', [long.canonical.spec.dashboards[0].id, long.canonical.spec.validation.synthetic_checks[0].id]);
}

// ---------- mirror pins: the hand-written copies of the schema rules ----------
assert(SPEC_DURATION_RE.source === SCHEMA.$defs.Duration.pattern, 'SPEC_DURATION_RE mirrors $defs.Duration', [SPEC_DURATION_RE.source, SCHEMA.$defs.Duration.pattern]);
assert(isSpecRecordingRuleName('svc:metric:op') && !isSpecRecordingRuleName(':x:y') && !isSpecRecordingRuleName('HTTP:Requests:Rate') && !isSpecRecordingRuleName({ metric: 'a:b:c' }),
  'isSpecRecordingRuleName is the <service>:<metric>:<op> reading');
{
  const probes = ['My_Repo', '1password', '.', 'a', 'payments.git', '--', '_foo', 'x'.repeat(70), 'Team Platform', 'Canonical_Repo', 'golden', 'ab', 'a-', 'prod'];
  const bad = [];
  for (const p of probes) {
    const out = packSlug(p);
    const errs = [];
    validate(out, SCHEMA.$defs.Slug, '$', errs, SCHEMA);
    if (errs.length) bad.push([p, out, errs]);
    const already = [];
    validate(p, SCHEMA.$defs.Slug, '$', already, SCHEMA);
    if (!already.length && out !== p) bad.push([p, out, 'not a fixed point']);
  }
  assert(bad.length === 0, 'every packSlug result validates against $defs.Slug, and a valid input is a fixed point', bad);
  assert(packSlug('1password') === 'svc-1password' && packSlug('_foo') === 'foo' && packSlug('.') === 'crawled-service' && packSlug('a') === 'crawled-service' && packSlug('payments.git') === 'payments-git' && packSlug('2024', 'prod', { prefix: 'env-' }) === 'env-2024',
    'packSlug: prefix when not letter-led, leading separators stripped, fallback under 2 characters', [packSlug('1password'), packSlug('_foo'), packSlug('.'), packSlug('a'), packSlug('payments.git'), packSlug('2024', 'prod', { prefix: 'env-' })]);
}
{
  const echoes = SCHEMA.$defs.Binding.enum.map(b => crawlFiles({}, { repoName: 'svc', binding: b, now: NOW }).canonical.metadata.binding);
  assert(JSON.stringify(echoes) === JSON.stringify(SCHEMA.$defs.Binding.enum), 'every spec Binding is echoed', echoes);
  const foo = crawlFiles({}, { repoName: 'svc', binding: 'foo', now: NOW });
  assert(foo.canonical.metadata.binding === 'otel-elastic-prometheus-grafana' && foo.canonical.metadata.annotations['crawler.bindingIgnored'] === 'foo' && errorsOf(foo.canonical).length === 0,
    'an unknown binding is defaulted, recorded in crawler.bindingIgnored, and the pack validates', [foo.canonical.metadata.binding, foo.canonical.metadata.annotations['crawler.bindingIgnored']]);
  const tiers = SCHEMA.$defs.Criticality.enum.map(t => crawlFiles({}, { repoName: 'svc', criticality: t, now: NOW }).canonical.metadata.bindings.criticality);
  assert(JSON.stringify(tiers) === JSON.stringify(SCHEMA.$defs.Criticality.enum), 'every spec Criticality is echoed', tiers);
  const t9 = crawlFiles({}, { repoName: 'svc', criticality: 'tier-9', now: NOW });
  assert(t9.canonical.metadata.bindings.criticality === 'tier-3' && t9.canonical.metadata.annotations['crawler.criticalityIgnored'] === 'tier-9' && errorsOf(t9.canonical).length === 0,
    'an unknown criticality yields the inferred tier and crawler.criticalityIgnored', [t9.canonical.metadata.bindings.criticality, t9.canonical.metadata.annotations['crawler.criticalityIgnored']]);
}

// ---------- the CLI ----------
const tmp = mkdtempSync(join(tmpdir(), 'crawl-canonical-'));
try {
  const r = cli(HOSTILE_DIR);
  assert(r.status === 0, 'the CLI crawls the hostile repository with exit 0', [r.status, r.stderr.slice(-400)]);
  assert(/schema\s+: valid/.test(r.stderr), 'the summary says the pack is valid', r.stderr.slice(-300));
  assert(r.stderr.includes("name             : hostile_repo (normalized from 'Hostile_Repo')"), 'the summary shows the normalized name and its origin', r.stderr);
  assert(r.stderr.includes('rules omitted    : 3'), 'the summary counts the omitted rules', r.stderr);
  const out = join(tmp, 'hostile.pack.yaml');
  writeFileSync(out, r.stdout);
  const v = spawnSync(process.execPath, [VALIDATE, out], { encoding: 'utf8', env });
  assert(v.status === 0 && v.stdout.includes('✓') && v.stdout.includes(`[spec v${SPEC_VERSION}]`), 'the emitted YAML validates through validate-pack with no upconversion (the end-to-end door)', [v.status, v.stdout, v.stderr]);
  assert(parseYaml(r.stdout).metadata.name === 'hostile_repo', 'the YAML carries the normalized name', parseYaml(r.stdout).metadata.name);

  const refusals = [
    [['--name', 'My-Service'], /--name/, /Slug/],
    [['--env', 'Prod'], /--env/, /Slug/],
    [['--criticality', 'tier-9'], /--criticality/, /tier-1, tier-2, tier-3/],
    [['--binding', 'foo'], /--binding/, /otel-elastic-prometheus-grafana/],
    [['--owners', 'Team Platform,ok'], /--owners "Team Platform"/, /Slug/],
    [['--owners'], /--owners/, /Slug/],
  ];
  for (const [args, flagRe, ruleRe] of refusals) {
    const x = cli(HOSTILE_DIR, ...args);
    assert(x.status === 2 && x.stdout === '' && flagRe.test(x.stderr) && ruleRe.test(x.stderr) && !/at .*\.mjs:\d+/.test(x.stderr),
      `${args.join(' ')} is refused before the crawl: exit 2, nothing on stdout, the rule in the message`, [x.status, x.stdout.slice(0, 80), x.stderr.slice(0, 400)]);
  }
  const ok = cli(HOSTILE_DIR, '--name', 'my-service', '--env', 'prod', '--owners', 'team-a,team-b', '--criticality', 'tier-1', '--binding', 'otel-grafanalabs');
  assert(ok.status === 0 && parseYaml(ok.stdout).metadata.name === 'my-service', 'valid flags pass', [ok.status, ok.stderr.slice(-200)]);

  const t = cli(TIER3_DIR);
  assert(t.status === 0, 'the alerts-only repository crawls with exit 0', [t.status, t.stderr.slice(-300)]);
  const tOut = join(tmp, 'tier3.pack.yaml');
  writeFileSync(tOut, t.stdout);
  assert(spawnSync(process.execPath, [VALIDATE, tOut], { encoding: 'utf8', env }).status === 0, 'its YAML validates through validate-pack');
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

report('crawl-canonical', 'a fresh crawl of a hostile repository is a valid pack; invalid flags are usage errors.');
