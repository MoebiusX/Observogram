// server/repo-auth.mjs — whose access reads a repository on GitHub or Azure
// DevOps. Observogram serves several people, so a repository is read as the
// person who asked: the token they send with that request (`repoAuth`), used
// for that one read and never stored, logged or sent back. The server's own
// token (GITHUB_TOKEN, AZURE_DEVOPS_TOKEN) is read only where the server has
// no sign-in — the person's own machine, or a server run without identity —
// so once sign-in is on, nobody reads a repository with the server's access.
//
// A schedule or Check now never reads the repository: it checks live against
// the last scan, which a person's Run made (README, A service's Run).

import { authEnabled } from './auth.mjs';

export const REPO_AUTH_MAX = 4096;
const SERVER_TOKEN_VAR = Object.freeze({ github: 'GITHUB_TOKEN', ado: 'AZURE_DEVOPS_TOKEN' });
export const HOST_LABEL = Object.freeze({ github: 'GitHub', ado: 'Azure DevOps' });

export const REPO_AUTH_WAYS = Object.freeze({
  shape: 'repoAuth is your own token for the repository\'s host: one line of 1–4096 characters, no spaces',
  needed: (kind) => (kind === 'ado'
    ? 'it needs your own Azure DevOps token (a personal access token with Code (Read)), sent with this Run and never kept'
    : 'if it is private, run it with your own GitHub token (read access to its contents), sent with this Run and never kept'),
  refused: (kind) => `your ${HOST_LABEL[kind] || 'repository host'} token was refused or cannot read it — check that it can read this repository`,
});

export class RepoAuthRefusal extends Error {
  constructor(message) { super(message); this.name = 'RepoAuthRefusal'; this.status = 400; }
}

// The request's `repoAuth` → the token, or null when none was sent; a value
// that is no token is refused (its text is never quoted back).
export function parseRepoAuth(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > REPO_AUTH_MAX || /\s/.test(value)) throw new RepoAuthRefusal(REPO_AUTH_WAYS.shape);
  return value;
}

// Whether the server has sign-in: local users armed, OIDC or a reverse proxy.
// Outside a request the store may not be open; that reads as sign-in on, the
// cautious answer.
export function signInOn() {
  try { return authEnabled(); } catch { return true; }
}

// repositoryCredential(kind, { repoAuth, signIn, env }) → { token, source }
//   source  'request' — the person's own token, for this read only
//           'server'  — the server's own token, only on a server without sign-in
//           'none'    — no token: a public repository reads; a private one asks for the person's
//   serverHeld  (with 'none') the server holds a token it does not use because sign-in is on
export function repositoryCredential(kind, { repoAuth = null, signIn = signInOn(), env = process.env } = {}) {
  if (repoAuth) return { token: repoAuth, source: 'request' };
  const name = SERVER_TOKEN_VAR[kind];
  const server = name ? String(env[name] ?? '').trim() : '';
  if (server && !signIn) return { token: server, source: 'server' };
  return { token: null, source: 'none', serverHeld: !!server };
}

// What a read the host refused or could not see asks of the person: the
// host and whether their own token was the one refused — or null when
// their token would not change the answer (the server's own token was
// refused: its operator's fix; a host error that is no access question).
// GitHub answers a private repository with 404 to a reader who cannot see it.
export function repoAuthNeed(kind, credential, status) {
  if (!HOST_LABEL[kind] || ![401, 403, 404].includes(status)) return null;
  if (credential?.source === 'server') return null;
  return { kind, label: `${HOST_LABEL[kind]} token`, refused: credential?.source === 'request' };
}

// Every occurrence of the token in a text a person or a log will read, masked.
export function redactToken(text, token) {
  const s = String(text ?? '');
  if (!token || token.length < 4) return s;
  return s.split(token).join('[your token]');
}
