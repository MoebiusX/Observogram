// server/routes/deploy.mjs — the deploy domain's HTTP surface.
//
// Everything that writes to (or plans writes against) a live Grafana
// through an MCP gateway: the deploy matrix, the audit trail + verify
// write-back, rollback plan/execute, bulk deploy and the legacy
// single-artefact deploy. Routes moved VERBATIM from index.mjs; the
// shaping transforms live in server/deploy-helpers.mjs (unit-tested).
//
// The factory takes the pack-registry seam as injected deps — those
// functions own per-org in-memory state and stay with the registry in
// index.mjs until the registry extraction slice:
//   findPackMeta(id)            → pack meta or null
//   loadPackCanonical(meta)     → canonical pack object
//   overlaidCanonical(c, env)   → { canonical } with env overlay applied
//   readEnv(query)              → ?env= param or null
//   contentHash(canonical)      → 8-char content hash for audit records
// The actor of a record and its row is the principal's (req.observogramPrincipal.actor:
// a login, the bearer's label, `local`), read through actorForRecord().
//
// Every route that appends to deploys.jsonl writes its audit row AFTER the
// append (STORE_PLAN §5, slice 5: deploy.run, deploy.bulk, deploy.rollback,
// deploy.verify) through recordDeploy()/auditAfter(): the actor is checked
// before the line, the row carries counts and the MCP origin (never the
// URL, an error or a tool name), a failed insert never fails the deploy
// (the response says `auditError`), and a line that could not be appended
// still gets its row, flagged `fileError`.

import express from 'express';
import {
  DEPLOY_PRODUCTS, DEPLOY_VERSIONS, RULES_SCOPES,
  GRAFANA_ALERT_RULE_TOOL, GRAFANA_DASHBOARD_TOOL,
  defaultDeployTool, discoverMcpToolNames, deployToolMissingError,
  targetIsDeployable, filterPromRulesScope, buildNativeDeployCalls,
  newDeployId, captureDeploySnapshot, deployAuditRow,
} from '../deploy-helpers.mjs';
import { auditAfter, actorForRecord, bounded, finite } from '../audit-after.mjs';
import { redactCredentials } from '../mcp-url.mjs';
import { resolveMcpTarget } from '../service-admin.mjs';
import { currentStore } from '../store/db.mjs';
import { brandEnv } from '../../tools/lib/brand-env.mjs';
import {
  appendDeployRecord, appendDeployVerify, readDeployRecords, readDeploySnapshot,
} from '../workspace.mjs';
import { createMcpClient } from '../../tools/fetch-live-pack.mjs';
import { isTransportHookError } from '../../tools/lib/mcp-client.mjs';
import { compile, compileArtifact } from '../../tools/lib/compile.mjs';

export function deployRoutes({ findPackMeta, loadPackCanonical, overlaidCanonical, readEnv, contentHash, authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  // A transport hook fault (OBSERVOGRAM_TRANSPORT_HOOK breaking its contract
  // on a call) is one 502 for the whole request and NO deploy record: the
  // per-item catches below rethrow it instead of recording N identical
  // item failures for a deploy that never reached the wire. Every other
  // error keeps its existing path (Express's own handler, or the single
  // deploy route's audited 502).
  const hookFaultTo502 = (handler) => async (req, res) => {
    try {
      await handler(req, res);
    } catch (e) {
      if (!isTransportHookError(e) || res.headersSent) throw e;
      process.stderr.write(`[deploy]   transport hook fault: ${redactCredentials(e.message)}\n`);
      res.status(502).json({ ok: false, error: redactCredentials(e.message) });
    }
  };
  const rethrowHook = (e) => { if (isTransportHookError(e)) throw e; };

  // One line and one row for a deploy-shaped act (deploy, deploy-bulk,
  // rollback). In order: the principal's actor goes on the record (a blank
  // one — a bug past authorize() — throws requireActor's TypeError before
  // anything is written: neither the line nor the row); the line is
  // appended (a failure is one stderr line and the response stands, as
  // before); the audit row is written after it, flagged fileError when the
  // line is missing. Returns null, or the insert's error text for the
  // response's `auditError`.
  function recordDeploy(req, record, { action, mcpEndpoint = null, manual, tag }) {
    record.actor = actorForRecord(req);
    let fileError = false;
    try {
      appendDeployRecord(record);
    } catch (e) {
      fileError = true;
      process.stderr.write(`[${tag}]   audit append failed: ${e.message}\n`);
    }
    return auditAfter(req, deployAuditRow(record, { action, mcpEndpoint, manual, fileError }), { tag });
  }
  const withAuditError = (auditError) => (auditError ? { auditError } : {});

  router.get('/api/deploy/matrix', authorize('GET /api/deploy/matrix'), (req, res) => {
    // Surface the deployable targets + products + versions so the client
    // can drive the UI from one source of truth.
    res.json({
      products: DEPLOY_PRODUCTS,
      versions: DEPLOY_VERSIONS,
      scopes: RULES_SCOPES,
      targets: {
        'prometheus-rules': {
          deployable: true,
          products: ['grafana'],
          scopable: true,
          scopes: RULES_SCOPES,
          description: 'Recording + multi-window burn-rate alerting rules, applied via Grafana\'s unified alerting (Mimir-compatible) ruler.',
        },
        'grafana-dashboard': {
          deployable: true,
          products: ['grafana'],
          scopable: false,
          description: 'Grafana 12/13 dashboard JSON, applied via the dashboards API.',
        },
        'otel-collector': {
          deployable: false,
          reason: 'OTel Collector configs are environment-specific; emit and apply via your own deploy pipeline (kustomize / helm).',
        },
        'alertmanager': {
          deployable: false,
          reason: 'Standalone Alertmanager deploys are handled out-of-band; routes are folded into Grafana unified alerting for now.',
        },
      },
    });
  });

  // GET /api/deploys — the audit trail (VALUE_BACKLOG 10C). Newest first;
  // ?pack=<id> filters, ?limit=N caps (default 50). Records include the
  // post-deploy verify outcome once item 9 writes it back.
  router.get('/api/deploys', authorize('GET /api/deploys'), (req, res) => {
    const packId = typeof req.query.pack === 'string' && req.query.pack ? req.query.pack : undefined;
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 50));
    try {
      res.json({ deploys: readDeployRecords({ packId, limit }) });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });

  // POST /api/deploys/:deployId/verify — the post-deploy re-verify outcome
  // (VALUE_BACKLOG item 9) written back into the audit trail. Appended as its
  // own record and merged at read time; the original deploy line is never
  // rewritten. A verify outcome is read-path evidence — "deployed" stays
  // distinct from "verified live" (Phase 1 language contract).
  router.post('/api/deploys/:deployId/verify', authorize('POST /api/deploys/:deployId/verify'), (req, res) => {
    const deployId = String(req.params.deployId || '');
    if (!/^dep_[A-Za-z0-9_-]+$/.test(deployId)) {
      return res.status(400).json({ ok: false, error: 'malformed deployId' });
    }
    const known = readDeployRecords({ limit: 0 }).some(d => d.deployId === deployId);
    if (!known) return res.status(404).json({ ok: false, error: `unknown deployId: ${deployId}` });
    const b = req.body || {};
    // The principal's actor, checked before the line (the verify line itself
    // carries none; the deploy.verify row is where who verified is recorded).
    try { actorForRecord(req); } catch (e) { return res.status(500).json({ ok: false, error: e.message }); }
    const verify = {
      outcome: typeof b.outcome === 'string' ? b.outcome : 'unknown',
      summary: (b.summary && typeof b.summary === 'object') ? b.summary : null,
      transitions: Array.isArray(b.transitions) ? b.transitions.slice(0, 200) : null,
      packB: typeof b.packB === 'string' ? b.packB : null,
      refreshedAt: typeof b.refreshedAt === 'string' ? b.refreshedAt : null,
      attempts: finite(b.attempts),
      alignment: finite(b.alignment),
    };
    let fileError = null;
    try {
      appendDeployVerify(deployId, verify);
    } catch (e) {
      fileError = e;
    }
    // The row after the append attempt: the three scalars the line carries
    // (outcome bounded to 100 characters), fileError when the line is
    // missing — the verification was asserted by a principal either way.
    const auditError = auditAfter(req, {
      action: 'deploy.verify', targetKind: 'deploy', targetId: deployId,
      detail: { outcome: bounded(verify.outcome, 100), alignment: verify.alignment, attempts: verify.attempts, ...(fileError ? { fileError: true } : {}) },
    }, { tag: 'verify' });
    if (fileError) return res.status(500).json({ ok: false, error: fileError.message, ...withAuditError(auditError) });
    res.json({ ok: true, deployId, ...withAuditError(auditError) });
  });

  // GET /api/deploys/:deployId/rollback-plan — what a rollback WOULD do
  // (10D). No MCP contact: derived from the snapshot taken at deploy time.
  router.get('/api/deploys/:deployId/rollback-plan', authorize('GET /api/deploys/:deployId/rollback-plan'), (req, res) => {
    const deployId = String(req.params.deployId || '');
    if (!/^dep_[A-Za-z0-9_-]+$/.test(deployId)) return res.status(400).json({ ok: false, error: 'malformed deployId' });
    const snap = readDeploySnapshot(deployId);
    if (!snap) return res.json({ ok: true, deployId, canRollback: false, reason: 'no snapshot was taken for this deploy (dry run, or pre-10D record)', plan: [] });
    const plan = (snap.meta.items || []).map(it => {
      if (it.kind === 'dashboard' && it.preState === 'captured') {
        return { ref: it.ref, kind: it.kind, action: 'restore', detail: 'upsert the captured pre-deploy dashboard JSON' };
      }
      if (it.kind === 'dashboard' && it.restore === 'delete') {
        return { ref: it.ref, kind: it.kind, action: 'delete', detail: 'created by this deploy — removed via grafana_delete_dashboard when the MCP advertises it, manual otherwise' };
      }
      return { ref: it.ref, kind: it.kind, action: 'manual', detail: it.kind === 'rules-listing' ? 'pre-deploy rule listing saved as evidence; per-rule restore is not yet automated' : `pre-state ${it.preState}` };
    });
    res.json({ ok: true, deployId, canRollback: plan.some(p => p.action === 'restore'), snapshotStatus: snap.meta.status, plan });
  });

  // POST /api/deploys/:deployId/rollback — restore the pre-deploy snapshot
  // (10D). Updates restore by re-upserting captured state through the same
  // write tools; creates need delete tools the MCP doesn't expose yet and are
  // returned as manual steps with exact identities. The rollback is itself a
  // deploy-shaped act and lands in the audit log with `rollbackOf`.
  router.post('/api/deploys/:deployId/rollback', authorize('POST /api/deploys/:deployId/rollback'), hookFaultTo502(async (req, res) => {
    const rollbackOf = String(req.params.deployId || '');
    if (!/^dep_[A-Za-z0-9_-]+$/.test(rollbackOf)) return res.status(400).json({ ok: false, error: 'malformed deployId' });
    const original = readDeployRecords({ limit: 0 }).find(d => d.deployId === rollbackOf);
    if (!original) return res.status(404).json({ ok: false, error: `unknown deployId: ${rollbackOf}` });
    const snap = readDeploySnapshot(rollbackOf);
    if (!snap || !['captured', 'partial'].includes(snap.meta.status)) {
      return res.status(409).json({ ok: false, error: `no usable snapshot for ${rollbackOf} (status: ${snap?.meta?.status || 'none'}) — nothing to restore from` });
    }
    const b = req.body || {};
    // mcpUrl, or the org's MCP endpoint by mcpEndpointId (its URL only: a
    // write token is the request's, never a stored variable's).
    const target = resolveMcpTarget(currentStore(), b, { forWrite: true });
    if (target.status) return res.status(target.status).json({ ok: false, error: target.error });
    const { mcpUrl, safeMcpUrl, mcpAuth } = target;
    const dryRun = b.dryRun === true || b.dry_run === true;

    const t0 = Date.now();
    const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'observabilitypack-studio-rollback', version: '0.4.0' },
    }).catch(rethrowHook);
    const availableTools = await discoverMcpToolNames(rpc);

    const results = [];
    const manual = [];
    for (const it of snap.meta.items || []) {
      if (it.kind === 'dashboard' && it.preState === 'captured') {
        const itStart = Date.now();
        const raw = snap.readFile(it.file);
        // Defensive unwrap: tools differ in whether they wrap the dashboard.
        const dashboard = raw?.dashboard || raw?.json || raw;
        if (!dashboard || typeof dashboard !== 'object') {
          results.push({ ref: it.ref, action: 'restore', ok: false, error: 'snapshot file unreadable' });
          continue;
        }
        try {
          if (availableTools && !availableTools.includes(GRAFANA_DASHBOARD_TOOL)) throw new Error(`${GRAFANA_DASHBOARD_TOOL} not advertised by this MCP`);
          const result = await callTool(GRAFANA_DASHBOARD_TOOL, {
            dashboard,
            folder_uid: snap.meta.folder || undefined,
            message: `Observogram rollback of ${rollbackOf}`,
            mode: 'upsert',
            dry_run: dryRun,
          });
          results.push({ ref: it.ref, action: 'restore', ok: true, tookMs: Date.now() - itStart, result });
        } catch (e) {
          rethrowHook(e);
          results.push({ ref: it.ref, action: 'restore', ok: false, error: redactCredentials(String(e.message)), tookMs: Date.now() - itStart });
        }
      } else if (it.kind === 'dashboard' && it.restore === 'delete') {
        if (availableTools && availableTools.includes('grafana_delete_dashboard')) {
          const itStart = Date.now();
          try {
            const result = await callTool('grafana_delete_dashboard', { uid: it.ref, dry_run: dryRun });
            results.push({ ref: it.ref, action: 'delete', ok: true, tookMs: Date.now() - itStart, result });
          } catch (e) {
            rethrowHook(e);
            results.push({ ref: it.ref, action: 'delete', ok: false, error: redactCredentials(String(e.message)), tookMs: Date.now() - itStart });
          }
        } else {
          manual.push({ ref: it.ref, kind: it.kind, why: 'created by the deploy; the MCP does not advertise grafana_delete_dashboard — remove it by hand' });
        }
      } else {
        manual.push({ ref: it.ref, kind: it.kind, why: it.kind === 'rules-listing' ? 'per-rule restore is not yet automated — the pre-deploy listing is saved as evidence in the snapshot' : `pre-state ${it.preState}` });
      }
    }

    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    const deployId = newDeployId();
    let auditError;
    try {
      auditError = recordDeploy(req, {
        deployId,
        at: new Date().toISOString(),
        rollbackOf,
        pack: original.pack || null,
        env: original.env || null,
        mcpUrl: safeMcpUrl,
        target: original.target || null,
        mode: 'rollback',
        dryRun,
        items: results.map(r => ({ artifact: r.ref, group: r.action, ok: r.ok, tookMs: r.tookMs || 0, ...(r.error ? { error: r.error } : {}) })),
        summary: { total: results.length, ok: okCount, failed: failCount },
        tookMs: Date.now() - t0,
      }, { action: 'deploy.rollback', mcpEndpoint: target.endpoint, manual: manual.length, tag: 'rollback' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    res.status(failCount > 0 && okCount === 0 && results.length > 0 ? 502 : 200).json({
      ok: failCount === 0,
      deployId,
      rollbackOf,
      dryRun,
      results,
      manual,
      summary: { total: results.length, ok: okCount, failed: failCount, manual: manual.length },
      tookMs: Date.now() - t0,
      ...withAuditError(auditError),
    });
  }));

  // ----------------------------------------------------------------
  // POST /api/packs/:id/deploy-bulk — multi-artefact deploy.
  // Body: {
  //   mcpUrl | mcpEndpointId, mcpAuth?,   (an endpoint by id: its URL only;
  //                                        the write token stays per request)
  //   targetProduct, targetVersion, targetFolder?,
  //   items: [{ group, flavor?, artifact?, dashboardId?, scope? }, ...]
  // }
  // Iterates items, compiling each via compileArtifact() and pushing
  // to the MCP tool the dispatcher chooses based on group + flavor.
  // Returns per-item ok/error so the UI can show partial success
  // instead of failing the whole batch.
  // ----------------------------------------------------------------
  router.post('/api/packs/:id/deploy-bulk', authorize('POST /api/packs/:id/deploy-bulk'), hookFaultTo502(async (req, res) => {
    const meta = findPackMeta(req.params.id);
    if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });
    const body = req.body || {};
    const product = (typeof body.targetProduct === 'string' && body.targetProduct.trim()) ? body.targetProduct.trim() : 'grafana';
    const version = (typeof body.targetVersion === 'string' && body.targetVersion.trim()) ? body.targetVersion.trim() : '12';
    const folder  = typeof body.targetFolder === 'string' ? body.targetFolder.trim() : '';
    const mode = ['create', 'upsert', 'update'].includes(body.mode) ? body.mode : 'upsert';
    const dryRun = body.dryRun === true || body.dry_run === true;
    const items = Array.isArray(body.items) ? body.items : null;
    const env = readEnv(req.query);

    const target = resolveMcpTarget(currentStore(), body, { forWrite: true });
    if (target.status) return res.status(target.status).json({ ok: false, error: target.error });
    const { mcpUrl, safeMcpUrl, mcpAuth } = target;
    if (!items || items.length === 0) return res.status(400).json({ ok: false, error: 'items array required and must be non-empty' });
    if (!DEPLOY_PRODUCTS.includes(product)) return res.status(400).json({ ok: false, error: `unsupported target product: ${product}` });
    if (!DEPLOY_VERSIONS[product]?.includes(version)) return res.status(400).json({ ok: false, error: `unsupported ${product} version: ${version}` });

    const t0 = Date.now();
    const canonical = loadPackCanonical(meta);
    const { canonical: overlaid } = overlaidCanonical(canonical, env);

    // Map item.group → legacy target id used by defaultDeployTool.
    const targetFor = (group) => {
      if (group === 'rules') return 'prometheus-rules';
      if (group === 'dashboards') return 'grafana-dashboard';
      return group;
    };

    const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'observabilitypack-studio-deploy-bulk', version: '0.4.0' },
    }).catch(rethrowHook);
    const availableTools = await discoverMcpToolNames(rpc);
    const missingTools = new Set();

    // Pre-deploy snapshot (10D): capture the live state of everything we are
    // about to overwrite BEFORE the first write, so rollback always has a
    // pre-state — or an honest record that the artefact didn't exist yet.
    const deployId = newDeployId();
    const strictSnapshot = body.strictSnapshot === true || brandEnv('STRICT_SNAPSHOT') === '1';
    const snapshot = await captureDeploySnapshot({ deployId, callTool, availableTools, items, dryRun, folder, safeMcpUrl });
    if (strictSnapshot && !['captured', 'empty', 'skipped'].includes(snapshot.status)) {
      return res.status(412).json({
        ok: false, deployId,
        error: `pre-deploy snapshot is '${snapshot.status}' and strict snapshot mode is on — refusing to deploy without a rollback point. ` +
               `Fix the read path (grafana_dashboard_get / grafana_alert_rules) or retry without strictSnapshot.`,
        snapshot: { status: snapshot.status, items: snapshot.itemCount },
      });
    }

    const results = [];
    process.stderr.write(`[deploy-bulk] ${meta.id} -> ${safeMcpUrl} (${items.length} item${items.length === 1 ? '' : 's'}, ${product} ${version}, snapshot ${snapshot.status})\n`);

    for (const item of items) {
      const itStart = Date.now();
      const itemTarget = targetFor(item.group);
      try {
        // The deploy modal's dashboard rows carry only dashboardId; the
        // compiler addresses single dashboards as `dash:<id>` (bare 'all'
        // would compile the comment-annotated multi-dashboard bundle, which
        // is not deployable JSON).
        const artifact = item.artifact
          || (item.group === 'dashboards' && item.dashboardId ? `dash:${item.dashboardId}` : 'all');
        // Rules: `all` (the full file, groups `<svc>_recording` / `<svc>_<slo>_burn` /
        // `<svc>_forecast`) and `slo:<id>` (groups `<svc>_<sli>_sli_recording` /
        // `<svc>_<slo>_recording` / `_burn` / `_forecast`) record the same series
        // under disjoint group names, so a ruler keyed by (namespace, group) must
        // receive one or the other, never both, in one namespace.
        const compiled = compileArtifact(overlaid, {
          group: item.group,
          flavor: (product === 'grafana' && item.group === 'rules') ? 'grafana-managed' : item.flavor,
          artifact,
          dashboardId: item.dashboardId,
        });
        const scope = item.scope || (itemTarget === 'prometheus-rules' ? 'both' : undefined);
        const tool = defaultDeployTool({ product, target: itemTarget, scope });
        if (!tool) {
          results.push({ item, ok: false, error: `no default deploy tool for (${product}, ${itemTarget})`, tookMs: Date.now() - itStart });
          continue;
        }
        if (availableTools && !availableTools.includes(tool)) {
          missingTools.add(tool);
          results.push({ item, ok: false, tool, error: deployToolMissingError(tool, availableTools), tookMs: Date.now() - itStart });
          continue;
        }
        const nativeCalls = buildNativeDeployCalls({
          target: itemTarget,
          compiled,
          scope,
          folder,
          tool,
          mode,
          dryRun,
          message: `Observogram deploy ${meta.id}@${overlaid?.metadata?.version || '?'}`,
        });
        if (!nativeCalls) {
          results.push({ item, ok: false, tool, error: `no native deploy adapter for '${tool}'`, tookMs: Date.now() - itStart });
          continue;
        }
        const callResults = [];
        for (const call of nativeCalls) {
          callResults.push({
            name: call.name,
            kind: call.kind,
            result: await callTool(call.tool, call.args),
          });
        }
        results.push({
          item,
          ok: true,
          tool,
          mode,
          dryRun,
          operations: nativeCalls.length,
          bytes: nativeCalls.reduce((sum, c) => sum + c.bytes, 0),
          tookMs: Date.now() - itStart,
          result: callResults,
        });
      } catch (e) {
        rethrowHook(e);
        results.push({ item, ok: false, error: e.message, tookMs: Date.now() - itStart });
      }
    }
    const totalMs = Date.now() - t0;
    const okCount = results.filter(r => r.ok).length;
    const failCount = results.length - okCount;
    process.stderr.write(`[deploy-bulk]   done in ${totalMs}ms: ${okCount} ok / ${failCount} failed\n`);
    let auditError;
    try {
      auditError = recordDeploy(req, {
        deployId,
        at: new Date().toISOString(),
        pack: { id: meta.id, version: canonical?.metadata?.version || null, contentHash: contentHash(canonical) },
        env: env || null,
        mcpUrl: safeMcpUrl,
        target: { product, version, folder: folder || null },
        mode, dryRun,
        snapshot: { status: snapshot.status, items: snapshot.itemCount },
        items: results.map(r => ({
          ...(r.item || {}),
          ok: !!r.ok,
          tool: r.tool || null,
          operations: r.operations || 0,
          bytes: r.bytes || 0,
          tookMs: r.tookMs || 0,
          ...(r.error ? { error: redactCredentials(String(r.error)) } : {}),
        })),
        summary: { total: results.length, ok: okCount, failed: failCount },
        tookMs: totalMs,
      }, { action: 'deploy.bulk', mcpEndpoint: target.endpoint, tag: 'deploy-bulk' });
    } catch (e) {
      return res.status(500).json({ ok: false, error: e.message });
    }
    res.status(failCount > 0 && okCount === 0 ? 502 : 200).json({
      ok: failCount === 0,
      deployId,
      results,
      summary: { total: results.length, ok: okCount, failed: failCount },
      targetProduct: product,
      targetVersion: version,
      targetFolder: folder || null,
      mode,
      dryRun,
      missingTools: [...missingTools],
      mcpToolsAvailable: availableTools,
      env,
      tookMs: totalMs,
      ...withAuditError(auditError),
    });
  }));

  router.post('/api/packs/:id/deploy/:target', authorize('POST /api/packs/:id/deploy/:target'), hookFaultTo502(async (req, res) => {
    const meta = findPackMeta(req.params.id);
    if (!meta) return res.status(404).json({ ok: false, error: `unknown pack: ${req.params.id}` });

    const target = req.params.target;
    if (!targetIsDeployable(target)) {
      return res.status(400).json({
        ok: false, target,
        error: `deploy not supported for target '${target}'. Deploy is currently limited to Grafana 12/13 — see GET /api/deploy/matrix.`,
      });
    }

    const body = req.body || {};
    const product = (typeof body.targetProduct === 'string' && body.targetProduct.trim())
      ? body.targetProduct.trim() : 'grafana';
    const version = (typeof body.targetVersion === 'string' && body.targetVersion.trim())
      ? body.targetVersion.trim() : '12';
    const folder = typeof body.targetFolder === 'string' ? body.targetFolder.trim() : '';
    const mode = ['create', 'upsert', 'update'].includes(body.mode) ? body.mode : 'upsert';
    const dryRun = body.dryRun === true || body.dry_run === true;
    const scope = (target === 'prometheus-rules' && typeof body.scope === 'string' && RULES_SCOPES.includes(body.scope))
      ? body.scope : (target === 'prometheus-rules' ? 'both' : undefined);

    if (!DEPLOY_PRODUCTS.includes(product)) {
      return res.status(400).json({ ok: false, error: `unsupported target product: ${product}. Known: ${DEPLOY_PRODUCTS.join(', ')}.` });
    }
    if (!DEPLOY_VERSIONS[product]?.includes(version)) {
      return res.status(400).json({ ok: false, error: `unsupported ${product} version: ${version}. Known: ${(DEPLOY_VERSIONS[product] || []).join(', ')}.` });
    }

    const mcpTool = (typeof body.mcpTool === 'string' && body.mcpTool.trim())
      ? body.mcpTool.trim()
      : defaultDeployTool({ product, target, scope });
    if (!mcpTool) {
      return res.status(400).json({ ok: false, error: 'no default deploy tool for this (product, target) combination; pass mcpTool in body.' });
    }

    const env = readEnv(req.query);
    const dashboardId = typeof req.query.dashboardId === 'string' ? req.query.dashboardId : undefined;
    // mcpUrl, or the org's MCP endpoint by mcpEndpointId (its URL only; the
    // write token stays the request's mcpAuth).
    const mcp = resolveMcpTarget(currentStore(), body, { forWrite: true });
    if (mcp.status) return res.status(mcp.status).json({ ok: false, error: mcp.error });
    const { mcpUrl, safeMcpUrl, mcpAuth } = mcp;

    const t0 = Date.now();
    let canonical = null;   // hoisted: the catch-path audit record reads it
    try {
      canonical = loadPackCanonical(meta);
      const { canonical: overlaid } = overlaidCanonical(canonical, env);
      const nativeTool = mcpTool === GRAFANA_ALERT_RULE_TOOL || mcpTool === GRAFANA_DASHBOARD_TOOL;
      const compiled = (mcpTool === GRAFANA_ALERT_RULE_TOOL && product === 'grafana' && target === 'prometheus-rules')
        ? compileArtifact(overlaid, { group: 'rules', flavor: 'grafana-managed', artifact: 'all' })
        : compile(overlaid, target, { dashboardId });

      // For rules deploy, apply the scope filter (recording-only / alerting-only).
      const payload = (target === 'prometheus-rules')
        ? filterPromRulesScope(compiled.content, scope)
        : compiled.content;

      process.stderr.write(`[deploy] ${meta.id}@${canonical.metadata?.version || '?'} -> ${safeMcpUrl} via ${mcpTool} ` +
        `(${product} ${version}, target=${target}, scope=${scope || '—'}, env=${env || 'none'}, mode=${mode}, ${payload.length}b)\n`);

      const { rpc, callTool } = createMcpClient({ mcpUrl, mcpAuth });
      await rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'observabilitypack-studio-deploy', version: '0.4.0' },
      }).catch(rethrowHook);

      const availableTools = await discoverMcpToolNames(rpc);
      if (availableTools && !availableTools.includes(mcpTool)) {
        throw new Error(deployToolMissingError(mcpTool, availableTools));
      }

      let result;
      let bytes = payload.length;
      let operations = 1;
      if (nativeTool) {
        const nativeCalls = buildNativeDeployCalls({
          target,
          compiled,
          scope,
          folder,
          tool: mcpTool,
          mode,
          dryRun,
          message: `Observogram deploy ${meta.id}@${canonical.metadata?.version || '?'}`,
        });
        result = [];
        operations = nativeCalls.length;
        bytes = nativeCalls.reduce((sum, c) => sum + c.bytes, 0);
        for (const call of nativeCalls) {
          result.push({
            name: call.name,
            kind: call.kind,
            result: await callTool(call.tool, call.args),
          });
        }
      } else {
        const args = {
          payload,
          content_type: compiled.contentType,
          environment: env || undefined,
          filename: compiled.filename,
          pack_source: `${meta.id}@${canonical.metadata?.version || '?'}`,
          target,
          target_product: product,
          target_version: version,
          scope: scope || undefined,
          folder: folder || undefined,
        };
        result = await callTool(mcpTool, args);
      }

      const tookMs = Date.now() - t0;
      process.stderr.write(`[deploy]   ok in ${tookMs}ms\n`);
      const { deployId, auditError } = auditSingleDeploy({
        req, meta, canonical, env, safeMcpUrl, mcpEndpoint: mcp.endpoint, product, version, folder, mode, dryRun,
        item: { target, scope: scope || null, ok: true, tool: mcpTool, operations, bytes, tookMs },
      });
      res.json({
        ok: true,
        deployId,
        ...withAuditError(auditError),
        target, env, tool: mcpTool, mcpUrl,
        targetProduct: product, targetVersion: version, scope: scope || null, targetFolder: folder || null,
        mode, dryRun, operations,
        filename: compiled.filename,
        bytes,
        tookMs,
        result,
      });
    } catch (e) {
      rethrowHook(e);   // one 502 without an audit record (hookFaultTo502)
      const tookMs = Date.now() - t0;
      process.stderr.write(`[deploy]   error in ${tookMs}ms: ${redactCredentials(e.message)}\n`);
      let recorded;
      try {
        recorded = auditSingleDeploy({
          req, meta, canonical, env, safeMcpUrl, mcpEndpoint: mcp.endpoint, product, version, folder, mode, dryRun,
          item: { target, scope: scope || null, ok: false, tool: mcpTool, tookMs, error: redactCredentials(String(e.message)) },
        });
      } catch (actorErr) {
        return res.status(500).json({ ok: false, error: actorErr.message });
      }
      const { deployId, auditError } = recorded;
      res.status(502).json({ ok: false, deployId, error: e.message, tool: mcpTool, target,
        targetProduct: product, targetVersion: version, scope: scope || null, targetFolder: folder || null,
        mode, dryRun, env, tookMs, ...withAuditError(auditError) });
    }
  }));

  // One audit record for the single-artefact deploy route — same shape as a
  // bulk record with exactly one item, so /api/deploys consumers see a
  // uniform stream — and its deploy.run row after it. Audit failures never
  // fail the deploy response (auditError says so); a blank actor throws
  // before anything is written.
  function auditSingleDeploy({ req, meta, canonical, env, safeMcpUrl, mcpEndpoint, product, version, folder, mode, dryRun, item }) {
    const deployId = newDeployId();
    const auditError = recordDeploy(req, {
      deployId,
      at: new Date().toISOString(),
      pack: { id: meta.id, version: canonical?.metadata?.version || null, contentHash: contentHash(canonical) },
      env: env || null,
      mcpUrl: safeMcpUrl,
      target: { product, version, folder: folder || null },
      mode, dryRun,
      items: [item],
      summary: { total: 1, ok: item.ok ? 1 : 0, failed: item.ok ? 0 : 1 },
      tookMs: item.tookMs || 0,
    }, { action: 'deploy.run', mcpEndpoint, tag: 'deploy' });
    return { deployId, auditError };
  }

  return router;
}
