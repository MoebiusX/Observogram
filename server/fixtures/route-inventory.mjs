#!/usr/bin/env node
// server/fixtures/route-inventory.mjs — a child script for
// server/test-authz.mjs's completeness test (docs/STORE_PLAN.md slice 3).
//
// Imports server/index.mjs (no start(), no store: initAuth() registers the
// /auth/* routes of the mode this process's env selects, at import) and
// prints one JSON line: the walk of app.router.stack, recursing into every
// layer whose handle has a stack (a router).
//
//   routes      per route AND per method: { key, guard } — guard is the
//               routeKey of the first handler of that method when it is an
//               authorize() guard, else null; route.all is recorded in `alls`
//   routers     { mountedAtRoot, caseSensitive } per router layer
//   middleware  the name of every other non-static layer
//   statics     the mount of every serveStatic layer ('/' or a STATIC_MOUNTS key)
//   appCaseSensitive  app.router.caseSensitive

import { app } from '../index.mjs';
import { STATIC_MOUNTS } from '../route-table.mjs';

const out = { routes: [], alls: [], routers: [], middleware: [], statics: [], appCaseSensitive: app.router.caseSensitive === true };

function walk(stack) {
  for (const layer of stack) {
    if (layer.route) {
      const route = layer.route;
      const path = String(route.path);
      for (const m of Object.keys(route.methods)) {
        if (m === '_all') { out.alls.push(path); continue; }
        const first = route.stack.find((l) => l.method === m);
        const guard = first && first.handle.name === 'authorize' && typeof first.handle.routeKey === 'string' ? first.handle.routeKey : null;
        out.routes.push({ key: `${m.toUpperCase()} ${path}`, guard });
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      out.routers.push({ mountedAtRoot: layer.slash === true, caseSensitive: layer.handle.caseSensitive === true });
      walk(layer.handle.stack);
    } else if (layer.name === 'serveStatic') {
      const mount = layer.slash ? '/' : Object.keys(STATIC_MOUNTS).filter((m) => m !== '/' && layer.match(`${m}/x`));
      out.statics.push(Array.isArray(mount) ? (mount.length === 1 ? mount[0] : `?${mount.join(',')}`) : mount);
    } else {
      out.middleware.push(layer.name || '<anonymous>');
    }
  }
}
walk(app.router.stack);
process.stdout.write(JSON.stringify(out) + '\n');
