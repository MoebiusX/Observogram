// server/routes/mcp-settings.mjs — the MCP server-settings API (rebadge
// batch 4, D2/D3).
//
//   GET /api/mcp-settings   { ok, proxy, policy, configured } — the
//                           settings policy the server was started with
//                           (OBSERVOGRAM_MCP_SETTINGS_POLICY, server/
//                           mcp-settings-policy.mjs: the document or null,
//                           never its path) and whether the opt-in
//                           pass-through is on (OBSERVOGRAM_MCP_ADMIN_PROXY=1,
//                           read per request). A viewer route: neither is a
//                           secret, and the studio reads it only when the
//                           Server settings modal opens, never at boot.
//                           `no-store` like /api/taxonomy: the answer changes
//                           with the process, not with the resource.
//
// SQL-free; deployment-global (no org is consulted).

import express from 'express';
import { settingsPolicyAnswer } from '../mcp-settings-policy.mjs';

export function mcpSettingsRoutes({ authorize }) {
  // Case-sensitive like the app (server/index.mjs): a nested router does not inherit the app's setting.
  const router = express.Router({ caseSensitive: true });

  router.get('/api/mcp-settings', authorize('GET /api/mcp-settings'), (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json(settingsPolicyAnswer());
  });

  return router;
}
