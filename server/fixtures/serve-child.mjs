// server/fixtures/serve-child.mjs — the child-server helpers the server
// suites share (moved from server/test-store-boot.mjs; server/test-authz.mjs
// uses them too).
//
// Every server is a child: initAuth() decides the posture at import, and a
// boot must see exactly the env its test gives it. Children get an
// explicit env — this process's minus every variable a boot reads (STRIP),
// plus the test's own — and are spawned as process.execPath with the
// script, never through npm. This module imports no server code, so a
// suite can import it before it strips its own env.

import { spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_URL = pathToFileURL(join(HERE, '..', 'index.mjs')).href;

// Every variable a boot reads, under both spellings (OBSERVOGRAM_ and TOMOGRAPH_).
export const STRIP = [
  'DB', 'BOOTSTRAP_ADMIN', 'OIDC_JOIN_ROLE', 'ADMIN_PASSWORD', 'INSECURE_NO_AUTH', 'WORKSPACE', 'USERS_FILE',
  'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_REDIRECT_URL', 'OIDC_ALLOW_HTTP', 'OIDC_SECURE_COOKIES',
  'SESSION_SECRET', 'API_TOKEN', 'API_TOKEN_LABEL', 'AUTH', 'TRANSPORT_HOOK',
];

export function childEnv(ws, extra = {}) {
  const env = { ...process.env };
  for (const k of STRIP) { delete env[`OBSERVOGRAM_${k}`]; delete env[`TOMOGRAPH_${k}`]; }
  if (ws) env.OBSERVOGRAM_WORKSPACE = ws;
  for (const [k, v] of Object.entries(extra)) { if (v === undefined) delete env[k]; else env[k] = v; }
  return env;
}

// ---------- the children ----------

export const BOOT_CODE = `
const { start } = await import(${JSON.stringify(INDEX_URL)});
try {
  const srv = await start({ port: Number(process.env.BOOT_PORT || 0), host: process.env.BOOT_HOST, silent: process.env.BOOT_SILENT === '1', legacyLivePack: process.env.BOOT_LEGACY_LIVE_PACK || undefined });
  process.stdout.write('LISTENING ' + srv.address().port + '\\n');
  if (process.env.BOOT_KEEP !== '1') { srv.close(); process.exit(0); }
} catch (e) {
  process.stdout.write('REFUSED ' + JSON.stringify({ message: e.message, code: e.code ?? null, nothingMoved: e.nothingMoved ?? null }) + '\\n');
  process.exit(3);
}
`;

export function parseBoot(stdout) {
  const listening = /^LISTENING (\d+)$/m.exec(stdout);
  if (listening) return { listening: true, port: Number(listening[1]) };
  const refused = /^REFUSED (.*)$/m.exec(stdout);
  if (refused) return { listening: false, ...JSON.parse(refused[1]) };
  return { listening: false, message: null };
}

// One boot that exits: { listening, port?, message?, code?, nothingMoved?, stdout, stderr }.
export function boot(ws, { host = '127.0.0.1', env = {}, silent = true, port = 0 } = {}) {
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', BOOT_CODE], {
    env: childEnv(ws, { ...env, BOOT_HOST: host, BOOT_SILENT: silent ? '1' : '0', BOOT_PORT: String(port) }), encoding: 'utf8', timeout: 60_000,
  });
  const out = { ...parseBoot(r.stdout), stdout: r.stdout, stderr: r.stderr, status: r.status };
  if (out.message === null) throw new Error(`the boot child printed neither LISTENING nor REFUSED (status ${r.status}): ${r.stderr}`);
  return out;
}

// A server that keeps running: { base, stop() }.
export async function serve(ws, { host = '127.0.0.1', env = {} } = {}) {
  const proc = spawn(process.execPath, ['--input-type=module', '-e', BOOT_CODE], {
    env: childEnv(ws, { ...env, BOOT_HOST: host, BOOT_SILENT: '1', BOOT_KEEP: '1' }), stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.setEncoding('utf8');
  proc.stderr.setEncoding('utf8');
  proc.stderr.on('data', (c) => { stderr += c; });
  const exited = new Promise((res) => proc.on('exit', (code, signal) => res({ code, signal })));
  const port = await new Promise((res, rej) => {
    const t = setTimeout(() => { proc.kill('SIGKILL'); rej(new Error(`no LISTENING in 60 s: ${stderr}`)); }, 60_000);
    proc.stdout.on('data', (c) => {
      stdout += c;
      const b = parseBoot(stdout);
      if (b.listening) { clearTimeout(t); res(b.port); } else if (b.message !== null) { clearTimeout(t); rej(new Error(`refused: ${b.message}`)); }
    });
    exited.then((r) => { clearTimeout(t); rej(new Error(`the server exited (${r.code}/${r.signal}): ${stderr}`)); });
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: async () => {
      proc.kill('SIGTERM');
      const t = setTimeout(() => proc.kill('SIGKILL'), 10_000);
      await exited;
      clearTimeout(t);
    },
  };
}

// A CLI: process.execPath with the script, an explicit env, input piped.
export function cli(script, args, ws, { env = {}, input = '' } = {}) {
  return spawnSync(process.execPath, [script, ...args], { env: childEnv(ws, env), input, encoding: 'utf8', timeout: 60_000 });
}

// A stand-alone sign-in: { status, json, session, pwflow } (the two cookies, or null).
export async function signIn(base, username, password) {
  const r = await fetch(`${base}/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: `username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`,
  });
  const cookie = (name) => (r.headers.getSetCookie?.() || []).find((c) => c.startsWith(`${name}=`))?.split(';')[0] ?? null;
  return { status: r.status, json: await r.json().catch(() => null), session: cookie('observogram_session'), pwflow: cookie('observogram_pwflow') };
}
