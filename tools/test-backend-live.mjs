#!/usr/bin/env node
/**
 * tools/test-backend-live.mjs
 *
 * T4 of docs/TEST_PLAN_COMPILER_VALIDITY.md — the round trip that IS the
 * product story, against a REAL Grafana:
 *
 *   compile → deploy (the server's real /api/packs/:id/deploy-bulk path,
 *   MCP tools, snapshots and all) → fetch the live state back (the real
 *   fetch-live builder) → diff (the real engine) → assert the deployed
 *   set landed ALIGNED.
 *
 * Anything declared-not-live after a successful deploy is, by
 * definition, either a compiler emission bug or a diff/identity bug.
 *
 * Infrastructure: the disposable Grafana from
 * docker/validate.compose.yaml plus tools/lib/grafana-mcp-bridge.mjs —
 * the bridge plays otel-mcp-server's gateway role so the entire ratified
 * MCP chain is exercised. If Grafana isn't reachable and docker can't
 * start it, the suite SKIPS loudly; --strict (CI) turns that into a
 * failure. The Observogram server runs in-process against a temp
 * workspace, so the host's .observogram/ is never touched.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const STRICT = process.argv.includes('--strict');
const GRAFANA_URL = process.env.T4_GRAFANA_URL || 'http://127.0.0.1:13000';
const GRAFANA13_URL = process.env.T4_GRAFANA13_URL || 'http://127.0.0.1:13013';
const GRAFANA_PROV_URL = process.env.T4_GRAFANA_PROV_URL || 'http://127.0.0.1:13002';
const GRAFANA_AUTH = process.env.T4_GRAFANA_AUTH || 'admin:admin';
const COMPOSE_FILE = join(ROOT, 'docker', 'validate.compose.yaml');
const PROV_DIR = join(ROOT, 'docker', '.t2-provisioning', 'alerting');
const FOLDER = 't4-roundtrip';

// The in-process server must see an isolated workspace BEFORE the module
// loads (workspace paths resolve from this env at call time, but boot
// rehydration runs at start()).
const WORKSPACE = mkdtempSync(join(tmpdir(), 'observogram-t4-'));
process.env.OBSERVOGRAM_WORKSPACE = WORKSPACE;

import { createHarness } from './lib/harness.mjs';
const { assert, failures, report } = createHarness({ indent: '  ', truncate: 400 });

function skip(reason) {
  if (STRICT) {
    assert(false, `T4 preconditions (--strict): ${reason}`);
    report('backend-live');
    return;
  }
  process.stdout.write(`backend-live: SKIPPED — ${reason}\n`);
  process.stdout.write('  (start it with: docker compose -f docker/validate.compose.yaml up -d --wait)\n');
  process.exit(0);
}

async function grafanaUp() {
  try {
    const r = await fetch(`${GRAFANA_URL}/api/health`);
    return r.ok;
  } catch (_) { return false; }
}

async function ensureGrafana() {
  // The grafana-prov service mounts this generated dir — it must exist
  // before compose creates the container.
  mkdirSync(PROV_DIR, { recursive: true });
  const healthy = async (url) => { try { return (await fetch(`${url}/api/health`)).ok; } catch (_) { return false; } };
  // All three services answering → nothing to do. Otherwise run compose
  // (idempotent — also creates services added since the stack last started).
  if (await healthy(GRAFANA_URL) && await healthy(GRAFANA13_URL) && await healthy(GRAFANA_PROV_URL)) return true;
  const probe = spawnSync('docker', ['version', '--format', '{{.Server.Version}}'], { encoding: 'utf8' });
  if (probe.status !== 0) return await grafanaUp();
  process.stdout.write(`backend-live: starting Grafana stack via ${COMPOSE_FILE}\n`);
  const up = spawnSync('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--wait'], { encoding: 'utf8', timeout: 300_000 });
  if (up.status !== 0) {
    process.stdout.write(`  docker compose up failed: ${(up.stderr || '').slice(0, 300)}\n`);
    return false;
  }
  for (let i = 0; i < 45; i++) {
    if (await grafanaUp()) return true;
    await new Promise(r => setTimeout(r, 2000));
  }
  return false;
}

async function api(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) { /* non-JSON */ }
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json;
}

async function apiText(base, path, opts = {}) {
  const res = await fetch(`${base}${path}`, opts);
  const text = await res.text();
  if (!res.ok) throw new Error(`${path} HTTP ${res.status}: ${text.slice(0, 300)}`);
  return text;
}

// Every name a diff entry answers to — key, ids, titles on either side.
function entryNames(entry) {
  const names = new Set();
  const add = (v) => { if (v && typeof v === 'string') names.add(v); };
  add(entry?.key);
  for (const side of [entry?.artefact, entry?.a, entry?.b]) {
    add(side?.id); add(side?.title); add(side?.name);
  }
  return names;
}

async function main() {
  if (!(await ensureGrafana())) {
    skip(`Grafana not reachable at ${GRAFANA_URL} and docker could not start it`);
    return;
  }
  process.stdout.write(`backend-live: Grafana up at ${GRAFANA_URL}\n`);

  // ---- boot the real server in-process on an ephemeral port ----
  const { start } = await import('../server/index.mjs');
  const srv = await start({ port: 0, host: '127.0.0.1', silent: true });
  const base = `http://127.0.0.1:${srv.address().port}`;

  // ---- the MCP gateway (otel-mcp-server's role) over the real Grafana ----
  const { startGrafanaMcpBridge } = await import('./lib/grafana-mcp-bridge.mjs');
  const bridge = await startGrafanaMcpBridge({ grafanaUrl: GRAFANA_URL, auth: GRAFANA_AUTH, datasourceUid: 'obs-pack-prom' });
  process.stdout.write(`backend-live: MCP bridge at ${bridge.url}\n`);

  try {
    // ---- register Pack A (the canonical spec example) ----
    const packYaml = readFileSync(join(ROOT, 'vendor/observability-pack-spec/v1.2/examples/payment-service.pack.yaml'), 'utf8');
    const reg = await api(base, '/api/validate?env=prod&source=t4-pack-a', {
      method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: packYaml,
    });
    assert(reg.ok === true && reg.registered?.id, 'Pack A registers via /api/validate', reg.registered, 'registered id');
    const packAId = reg.registered.id;
    const { parse: parseYaml } = await import('./lib/mini-yaml.mjs');
    const canonical = parseYaml(packYaml);
    const dashboardIds = (canonical?.spec?.dashboards || []).map(d => d.id);

    // ---- deploy through the REAL bulk path ----
    const items = [
      { group: 'rules', artifact: 'all', scope: 'both' },
      ...dashboardIds.map(id => ({ group: 'dashboards', dashboardId: id })),
    ];
    const deploy = await api(base, `/api/packs/${encodeURIComponent(packAId)}/deploy-bulk?env=prod`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mcpUrl: bridge.url,
        targetProduct: 'grafana',
        targetVersion: '12',
        targetFolder: FOLDER,
        mode: 'upsert',
        items,
      }),
    });
    const results = deploy.results || [];
    assert(results.length === items.length, 'deploy-bulk returns one result per item', results.length, items.length);
    for (const r of results) {
      assert(r.ok === true, `deploy item ok · ${r.item?.group}${r.item?.dashboardId ? ':' + r.item.dashboardId : ''}`,
        r.error || r, 'ok: true');
    }
    const deployedRuleNames = results
      .filter(r => r.ok && r.item?.group === 'rules')
      .flatMap(r => (r.result || []).map(c => c.name)).filter(Boolean);
    const deployedKinds = results
      .filter(r => r.ok && r.item?.group === 'rules')
      .flatMap(r => (r.result || []).map(c => c.kind));
    assert(deployedRuleNames.length > 0, 'rules deploy expanded into per-rule MCP calls', deployedRuleNames.length, '> 0');
    process.stdout.write(`  deployed: ${deployedRuleNames.length} rules (${deployedKinds.filter(k => k === 'alerting').length} alerting · ${deployedKinds.filter(k => k === 'recording').length} recording) + ${dashboardIds.length} dashboards\n`);

    // ---- authoritative read-back straight from Grafana ----
    const gfAuth = { headers: { Authorization: `Basic ${Buffer.from(GRAFANA_AUTH).toString('base64')}` } };
    const search = await api(GRAFANA_URL, '/api/search?type=dash-db&limit=200', gfAuth);
    // Compiled dashboards carry title = dash.id; uids are capped +
    // fingerprinted, so titles are the stable read-back identity.
    const liveDashTitles = new Set((search || []).map(d => d.title));
    for (const id of dashboardIds) {
      assert(liveDashTitles.has(id),
        `dashboard '${id}' exists in Grafana after deploy`, [...liveDashTitles].join(','), id);
    }
    const provisioned = await api(GRAFANA_URL, '/api/v1/provisioning/alert-rules', gfAuth);
    const liveRuleTitles = new Set((provisioned || []).map(r => r.title));
    for (const name of deployedRuleNames) {
      assert(liveRuleTitles.has(name), `rule '${name}' exists in Grafana provisioning after deploy`,
        [...liveRuleTitles].slice(0, 12).join(','), name);
    }

    // ---- fetch the live state back through the REAL fetch-live builder ----
    const { buildAndValidate } = await import('./fetch-live-pack.mjs');
    const { emit: emitYaml } = await import('./lib/mini-yaml.mjs');
    const { pack: packB } = await buildAndValidate({ mcpUrl: bridge.url, packName: 'payment-service' });
    assert(!!packB?.metadata?.name, 'fetch-live builds a schema-valid Pack B from the bridge');
    const regB = await api(base, '/api/validate?env=prod&source=t4-pack-b-live', {
      method: 'POST', headers: { 'Content-Type': 'text/yaml' }, body: emitYaml(packB),
    });
    assert(regB.ok === true && regB.registered?.id, 'Pack B registers via /api/validate');
    const packBId = regB.registered.id;

    // ---- THE diff — the engine's verdict on the round trip ----
    const diff = await api(base, `/api/diff?a=${encodeURIComponent(packAId)}&b=${encodeURIComponent(packBId)}&aEnv=prod&scopeMode=all`);
    assert(!!diff?.layers, 'diff engine produces layers');

    // Every deployed artefact must be CONFIRMED LIVE — i.e. absent from
    // every onlyInA bucket. Declared-not-live after a successful deploy
    // is the exact failure class T4 exists to catch.
    const deployedNames = new Set([...deployedRuleNames, ...dashboardIds]);
    const missingLive = [];
    for (const [L, bucket] of Object.entries(diff.layers)) {
      for (const entry of bucket?.onlyInA || []) {
        if (entry?.artefact?.source === 'Scaffold') continue;
        const names = entryNames(entry);
        for (const dn of deployedNames) {
          if (names.has(dn) || [...names].some(n => n.includes(dn))) {
            missingLive.push(`${L}: ${dn}`);
          }
        }
      }
    }
    assert(missingLive.length === 0,
      `every deployed artefact is confirmed live by the diff (${deployedNames.size} deployed)`,
      missingLive.join(' · '), 'none declared-not-live');

    // Deployed artefacts that came back DRIFTED must not drift on
    // decision-bearing fields — cosmetic round-trip rewrites are
    // tolerated (Grafana normalises), behaviour changes are not.
    const { driftedEntryBadness } = await import('../studio/diagnostic-grade.mjs');
    const decisionDrift = [];
    let driftedDeployed = 0;
    for (const [L, bucket] of Object.entries(diff.layers)) {
      for (const entry of (bucket?.inBoth || []).filter(e => e.match === 'drifted')) {
        const names = entryNames(entry);
        const isDeployed = [...deployedNames].some(dn => names.has(dn) || [...names].some(n => n.includes(dn)));
        if (!isDeployed) continue;
        driftedDeployed++;
        const cost = driftedEntryBadness(entry);
        if (cost.className === 'decision') {
          decisionDrift.push(`${L}: ${[...names][0]} (${(entry.deltas || []).map(d => d.field).join(',')})`);
        }
      }
    }
    assert(decisionDrift.length === 0,
      `no decision-bearing drift on deployed artefacts (${driftedDeployed} drifted cosmetically/default)`,
      decisionDrift.join(' · '), 'none');

    process.stdout.write(`\n  round trip: ${deployedNames.size} deployed → all confirmed live · ${driftedDeployed} round-trip drift (non-decision)\n`);

    // ================= T2 — version matrix + provisioning load =================
    // The rules/dashboards flavors claim "Grafana 12 / 13"; both versions
    // must accept every artifact, and the round trip must survive each
    // version's import rewrites on the decision-bearing fields.
    const gfAuthOf = () => ({ headers: { Authorization: `Basic ${Buffer.from(GRAFANA_AUTH).toString('base64')}` } });
    const reachable = async (url) => {
      try { return (await fetch(`${url}/api/health`)).ok; } catch (_) { return false; }
    };

    for (const target of [
      { name: 'grafana-12', url: GRAFANA_URL, deployed: true },
      { name: 'grafana-13', url: GRAFANA13_URL, deployed: false },
    ]) {
      if (!(await reachable(target.url))) {
        if (STRICT) assert(false, `T2: ${target.name} reachable at ${target.url}`);
        else process.stdout.write(`  T2 ${target.name}: SKIPPED (not reachable at ${target.url})\n`);
        continue;
      }
      process.stdout.write(`\n  T2 · ${target.name} (${target.url})\n`);

      // Deploy to this target through the real path (12 already carries
      // the T4 deploy; 13 gets its own).
      if (!target.deployed) {
        const b13 = await startGrafanaMcpBridge({ grafanaUrl: target.url, auth: GRAFANA_AUTH, datasourceUid: 'obs-pack-prom' });
        try {
          const dep13 = await api(base, `/api/packs/${encodeURIComponent(packAId)}/deploy-bulk?env=prod`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ mcpUrl: b13.url, targetProduct: 'grafana', targetVersion: '13', targetFolder: FOLDER, mode: 'upsert', items }),
          });
          for (const r of dep13.results || []) {
            assert(r.ok === true, `${target.name}: deploy item ok · ${r.item?.group}${r.item?.dashboardId ? ':' + r.item.dashboardId : ''}`, r.error || r, 'ok: true');
          }
        } finally { await b13.close(); }
      }

      // Dashboards: deep round trip — the exact bytes the deploy compiled
      // vs what this Grafana version returns after its import rewrites.
      for (const id of dashboardIds) {
        const emitted = JSON.parse(await apiText(base,
          `/api/packs/${encodeURIComponent(packAId)}/compile-artifact?env=prod&group=dashboards&flavor=grafana&artifact=${encodeURIComponent('dash:' + id)}`));
        const live = await api(target.url, `/api/dashboards/uid/${encodeURIComponent(emitted.uid)}`, gfAuthOf());
        assert(live?.dashboard?.title === id,
          `${target.name}: '${id}' retrievable by emitted uid, title intact`, live?.dashboard?.title, id);
        assert((live?.dashboard?.panels || []).length === (emitted.panels || []).length,
          `${target.name}: '${id}' panel count survives import`, (live?.dashboard?.panels || []).length, (emitted.panels || []).length);
        const sv = live?.dashboard?.schemaVersion;
        assert(typeof sv === 'number' && sv >= 30,
          `${target.name}: '${id}' schemaVersion is sane after import (emitted ${emitted.schemaVersion} → live ${sv})`, sv, '>= 30');
      }

      // Alert rules: decision-bearing fields survive the provisioning
      // round trip — title, condition, refIds, and the PromQL itself.
      const rulesYaml = await apiText(base,
        `/api/packs/${encodeURIComponent(packAId)}/compile-artifact?env=prod&group=rules&flavor=grafana-managed&artifact=all`);
      const { parse: parseYamlT2 } = await import('./lib/mini-yaml.mjs');
      const emittedGroups = parseYamlT2(rulesYaml.replace(/^(\s*#[^\n]*\n)+/, ''))?.groups || [];
      let rulesChecked = 0;
      for (const g of emittedGroups) {
        for (const rule of g.rules || []) {
          const live = await api(target.url, `/api/v1/provisioning/alert-rules/${encodeURIComponent(rule.uid)}`, gfAuthOf()).catch(() => null);
          if (!live) { assert(false, `${target.name}: rule '${rule.title}' retrievable by emitted uid`, 'not found', rule.uid); continue; }
          rulesChecked++;
          if (live.title !== rule.title) assert(false, `${target.name}: rule title survives · ${rule.uid}`, live.title, rule.title);
          if (rule.record) {
            // Recording rules carry their identity in record.metric/from;
            // Grafana returns no condition for them.
            if (live.record?.metric !== rule.record.metric) assert(false, `${target.name}: record metric survives · ${rule.title}`, live.record?.metric, rule.record.metric);
          } else if (live.condition !== rule.condition) {
            assert(false, `${target.name}: rule condition survives · ${rule.title}`, live.condition, rule.condition);
          }
          const emittedRefs = (rule.data || []).map(d => d.refId).join(',');
          const liveRefs = (live.data || []).map(d => d.refId).join(',');
          if (liveRefs !== emittedRefs) assert(false, `${target.name}: rule refIds survive · ${rule.title}`, liveRefs, emittedRefs);
          const emittedExpr = (rule.data || []).find(d => d.datasourceUid !== '__expr__')?.model?.expr || '';
          const liveExpr = (live.data || []).find(d => d.datasourceUid !== '__expr__')?.model?.expr || '';
          if (liveExpr !== emittedExpr) assert(false, `${target.name}: PromQL survives · ${rule.title}`, liveExpr.slice(0, 120), emittedExpr.slice(0, 120));
        }
      }
      assert(rulesChecked > 0, `${target.name}: deep rule round trip covered rules`, rulesChecked, '> 0');
      process.stdout.write(`  T2 ${target.name}: ${dashboardIds.length} dashboards + ${rulesChecked} rules round-tripped field-exact ✓\n`);
    }

    // T2a — the provisioning FILE path (the flavor's documented
    // "copy under provisioning/alerting/" usage), with the operator's
    // deploy-time datasource substitution applied as the banner instructs.
    if (await reachable(GRAFANA_PROV_URL)) {
      const provYaml = (await apiText(base,
        `/api/packs/${encodeURIComponent(packAId)}/compile-artifact?env=prod&group=rules&flavor=grafana-managed&artifact=all`))
        .replaceAll('${DS_PROMETHEUS}', 'obs-pack-prom');
      writeFileSync(join(PROV_DIR, 'observogram-rules.yaml'), provYaml);
      const reload = await fetch(`${GRAFANA_PROV_URL}/api/admin/provisioning/alerting/reload`, { method: 'POST', ...gfAuthOf() });
      assert(reload.ok, 'T2a: provisioning reload accepted', `HTTP ${reload.status}`, '2xx');
      const provRules = await api(GRAFANA_PROV_URL, '/api/v1/provisioning/alert-rules', gfAuthOf());
      const provTitles = new Set((provRules || []).map(r => r.title));
      const { parse: parseYamlProv } = await import('./lib/mini-yaml.mjs');
      const wantGroups = parseYamlProv(provYaml.replace(/^(\s*#[^\n]*\n)+/, ''))?.groups || [];
      let provChecked = 0;
      for (const g of wantGroups) for (const rule of g.rules || []) {
        provChecked++;
        if (!provTitles.has(rule.title)) assert(false, `T2a: file-provisioned rule loaded · '${rule.title}'`, [...provTitles].slice(0, 8).join(','), rule.title);
      }
      assert(provChecked > 0, `T2a: provisioning file path loads all ${provChecked} rules ✓`);
    } else if (STRICT) {
      assert(false, `T2a: provisioning Grafana reachable at ${GRAFANA_PROV_URL}`);
    } else {
      process.stdout.write(`  T2a provisioning load: SKIPPED (not reachable at ${GRAFANA_PROV_URL})\n`);
    }
  } finally {
    await bridge.close();
    await new Promise(r => srv.close(r));
    rmSync(WORKSPACE, { recursive: true, force: true });
  }

  report('backend-live');
}

main().catch(e => {
  process.stdout.write(`  ✗ backend-live threw: ${e.stack || e.message}\n`);
  failures.push(String(e.message));
  report('backend-live');
});
