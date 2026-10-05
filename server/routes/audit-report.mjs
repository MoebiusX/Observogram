// server/routes/audit-report.mjs — the service audit report and the
// placeholder report of one pack (GAP batch 2, B3.5; docs/ADAPTER.md "The
// service audit report"), read-only, under /api/packs/:id:
//
//   GET /api/packs/:id/audit-report?format=json|html&top=&download=1&env=   viewer
//   GET /api/packs/:id/placeholders?env=                                      viewer
//
// The report is tools/lib/audit-report.mjs's over the engines the server
// already answers with: the conformance body is the ONE conformanceReportFor()
// call the /conformance route makes (injected — the two can never grade one
// pack differently), the verdict rows are verdictsDocument's views, the
// waiver rows listWaiverViews' over the pack's primary service record (the
// same `now` as the conformance overlay, so a revoke within one request
// cannot show a clause waived and its waiver gone), the goes-blind graph the
// traceability graph's shape. `assessments` and `waivers` are therefore
// `available: true` on a server even when empty ("none recorded"); the CLI
// and the static bundle have no store and say so. The brand is the one the
// shell was branded with; the styles are the studio's design tokens and kit,
// read once at the first request (never at import — boot is untouched).
//
// Refusals: an unknown pack is 404 `{ error: 'unknown pack: <id>' }` — the
// sibling pack reads' shape (server/index.mjs), not the services API's; a bad
// `format` or `top` is 400 naming the values; a canonical the schema refuses
// makes adapt() throw, a 500 like every pack read's. `Cache-Control:
// no-store` on every answer (verdicts and waivers move). `/placeholders`
// answers packConformance(overlaid) bare — the rows the CLI prints, for the
// environment asked.

import express from 'express';
import { adapt } from '../../tools/lib/adapter.mjs';
import { auditReportFilename, buildAuditReport, renderAuditReportHtml, DEFAULT_RISK_TOP, RISK_TOP_MAX } from '../../tools/lib/audit-report.mjs';
import { packConformance } from '../../tools/lib/pack-conformance.mjs';
import { buildDependencyGraph, graphShape } from '../../tools/lib/traceability-graph.mjs';

const FORMATS = ['json', 'html'];

/**
 * assessments: { verdictsFor(db, meta, env, adapted) → rows | null, waiversFor(db, meta, env, now) → rows | null }
 * — the readers over the store (server/index.mjs wires verdict-admin and waiver-admin); each may return null
 * ("not recorded by this build") where a build has no store.
 */
export function auditReportRoutes({ authorize, findPackMeta, loadPackCanonical, readEnv, conformanceReportFor, overlaidCanonical, currentStore, brand, styles, generator, assessments }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });
  let stylesText = null;
  const stylesOnce = () => (stylesText ??= (typeof styles === 'function' ? styles() : String(styles || '')));

  router.get('/api/packs/:id/audit-report', authorize('GET /api/packs/:id/audit-report'), (req, res) => {
    const meta = findPackMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
    const format = typeof req.query.format === 'string' ? req.query.format : 'json';
    if (!FORMATS.includes(format)) return res.status(400).json({ error: `format must be one of ${FORMATS.join(', ')}` });
    let top = DEFAULT_RISK_TOP;
    if (req.query.top !== undefined) {
      const raw = typeof req.query.top === 'string' ? req.query.top : '';
      top = /^\d+$/.test(raw) ? Number(raw) : NaN;
      if (!Number.isInteger(top) || top < 1 || top > RISK_TOP_MAX) return res.status(400).json({ error: `top must be an integer from 1 to ${RISK_TOP_MAX}` });
    }
    try {
      const canonical = loadPackCanonical(meta);
      const env = readEnv(req.query);
      const now = new Date().toISOString();
      const conformance = conformanceReportFor(meta, canonical, env, { now });
      const { canonical: overlaid } = overlaidCanonical(canonical, env);
      const adapted = adapt(overlaid);
      const db = currentStore();
      const report = buildAuditReport({
        pack: { id: meta.id, label: meta.label ?? null, source: meta.uploaded ? 'uploaded' : (meta.source ?? 'catalogue') },
        canonical: overlaid,
        adapted,
        conformance,
        graph: graphShape(buildDependencyGraph(adapted)),
        verdicts: assessments.verdictsFor(db, meta, env, adapted),
        waivers: assessments.waiversFor(db, meta, env, now),
        environment: env,
        generatedAt: now,
        generator: typeof generator === 'function' ? generator() : generator,
        top,
      });
      res.setHeader('Cache-Control', 'no-store');
      if (req.query.download === '1') res.setHeader('Content-Disposition', `attachment; filename="${auditReportFilename(meta.id, format)}"`);
      if (format === 'html') return res.type('html').send(renderAuditReportHtml(report, { brand: typeof brand === 'function' ? brand() : brand, styles: stylesOnce() }));
      return res.json(report);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  router.get('/api/packs/:id/placeholders', authorize('GET /api/packs/:id/placeholders'), (req, res) => {
    const meta = findPackMeta(req.params.id);
    if (!meta) return res.status(404).json({ error: `unknown pack: ${req.params.id}` });
    try {
      const canonical = loadPackCanonical(meta);
      const { canonical: overlaid } = overlaidCanonical(canonical, readEnv(req.query));
      res.setHeader('Cache-Control', 'no-store');
      return res.json(packConformance(overlaid));
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  });

  return router;
}
