#!/usr/bin/env node
// server/launch.mjs — the image's entrypoint: server/index.mjs in a child
// Node, started with Node's own proxy switch (NODE_USE_ENV_PROXY=1) when
// HTTPS_PROXY or HTTP_PROXY is set and every proxy variable set is a URL Node
// can use (server/outbound-proxy.mjs launchPlan). Node reads that switch only
// when a process starts, and a value it cannot parse stops the start before
// any of the server's code runs, printing the value whole. So the switch is
// decided here, one process up, and the server's start then says which
// proxy is in use, or which variable to fix. The image leaves the switch
// unset for that reason: set in the container's environment, it applies to
// this launcher's own Node too. NODE_USE_ENV_PROXY=0 (or any value but 1)
// keeps every request direct. Signals go to the child, and this process ends
// with the child's exit code.

import { spawn } from 'node:child_process';
import { constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchPlan } from './outbound-proxy.mjs';

const { env } = launchPlan();
const child = spawn(process.execPath, [...process.execArgv, fileURLToPath(new URL('./index.mjs', import.meta.url)), ...process.argv.slice(2)], { stdio: 'inherit', env });
for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(signal, () => { if (child.exitCode === null) child.kill(signal); });
child.on('error', (e) => { process.stderr.write(`[studio] failed to start: ${e.message}\n`); process.exit(1); });
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 128 + (constants.signals[signal] || 0) : 1)));
