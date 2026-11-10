// server/repo-auth.mjs — whose access reads a repository on GitHub or Azure
// DevOps. Observogram serves several people, so a repository is read as the
// person who asked: the token they send with that request (`repoAuth`), used
// for that one read and never stored, logged or sent back. The server's own
// token (GITHUB_TOKEN, AZURE_DEVOPS_TOKEN) is read only where the server has
// no sign-in — the person's own machine, or a server run without identity —
// so once sign-in is on, nobody reads a repository with the server's access.
//
// Between the two, the person's sign-in to the host (server/repo-sign-in.mjs):
// their own token again, which their browser holds sealed and sends with each
// request, so nobody pastes it.
//
// A schedule or Check now never reads the repository: it checks live against
// the last scan, which a person's Run made (README, A service's Run).

import { authEnabled } from './auth.mjs';

export const REPO_AUTH_MAX = 4096;
const SERVER_TOKEN_VAR = Object.freeze({ github: 'GITHUB_TOKEN', ado: 'AZURE_DEVOPS_TOKEN' });
export const HOST_LABEL = Object.freeze({ github: 'GitHub', ado: 'Azure DevOps' });

export const REPO_AUTH_WAYS = Object.freeze({
  shape: 'repoAuth is your own token for the repository\'s host: one line of 1–4096 printable characters, no spaces',
  // `serverToken`: a server without sign-in, where the operator's AZURE_DEVOPS_TOKEN reads every Run.
  needed: (kind, { serverToken = false } = {}) => (kind === 'ado'
    ? `it needs your own Azure DevOps token (a personal access token with Code (Read)), sent with this Run and never kept${serverToken ? ', or AZURE_DEVOPS_TOKEN set on this server for every Run' : ''}`
    : 'if it is private, run it with your own GitHub token (read access to its contents), sent with this Run and never kept'),
  refused: (kind) => `your ${HOST_LABEL[kind] || 'repository host'} token was refused or cannot read it — check that it can read this repository${kind === 'ado' ? ' (Code (Read))' : ''}`,
  // The person is signed in to the host, and that account was refused or cannot see it.
  signedInRefused: (kind, account, { expired = false } = {}) => (expired
    ? `your ${HOST_LABEL[kind]} sign-in has ended — sign in to ${HOST_LABEL[kind]} again`
    : `you are signed in to ${HOST_LABEL[kind]}${account ? ` as ${account}` : ''}, and that account cannot read this repository — sign in as one that can, or run it with a token that can`),
  // The host offers sign-in here: the way to the fix that needs no token.
  signIn: (kind) => (kind === 'ado'
    ? 'sign in to Azure DevOps to read it as you, or run it with your own Azure DevOps token (Code (Read))'
    : 'if it is private, sign in to GitHub to read it as you, or run it with your own GitHub token'),
});

// The sentence a refused read ends with, from repoAuthNeed's answer.
// `serverToken`: the server has no sign-in, so its own token would read it too.
export function repoAuthTail(need, { serverToken = false } = {}) {
  if (!need) return '';
  if (need.via === 'sign-in') return REPO_AUTH_WAYS.signedInRefused(need.kind, need.account, { expired: need.expired === true });
  if (need.refused) return REPO_AUTH_WAYS.refused(need.kind);
  return need.signIn ? REPO_AUTH_WAYS.signIn(need.kind) : REPO_AUTH_WAYS.needed(need.kind, { serverToken });
}

export class RepoAuthRefusal extends Error {
  constructor(message) { super(message); this.name = 'RepoAuthRefusal'; this.status = 400; }
}

// The request's `repoAuth` → the token, or null when none was sent; a value
// that is no token is refused (its text is never quoted back). Printable
// ASCII only: a control character makes fetch refuse to build the request
// at all, which would read as a host the server could not reach.
export function parseRepoAuth(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > REPO_AUTH_MAX || !/^[\x21-\x7e]+$/.test(value)) throw new RepoAuthRefusal(REPO_AUTH_WAYS.shape);
  return value;
}

// Whether the server has sign-in: local users armed, OIDC or a reverse proxy.
// Outside a request the store may not be open; that reads as sign-in on, the
// cautious answer.
export function signInOn() {
  try { return authEnabled(); } catch { return true; }
}

// repositoryCredential(kind, { repoAuth, link, signIn, env }) → { token, source }
//   source  'request' — the person's own token, for this read only
//           'link'    — the person's sign-in to the host (server/repo-sign-in.mjs
//                       readRepoLink), with `account`
//           'server'  — the server's own token, only on a server without sign-in
//           'none'    — no token: a public repository reads; a private one asks for the person's
//   serverHeld  (with 'none') the server holds a token it does not use because sign-in is on
export function repositoryCredential(kind, { repoAuth = null, link = null, signIn = signInOn(), env = process.env } = {}) {
  if (repoAuth) return { token: repoAuth, source: 'request' };
  if (link?.token) return { token: link.token, source: 'link', account: link.account ?? null };
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
//   signIn    the host offers sign-in here: `signIn: true` in the answer
//   via       'sign-in' — the person's sign-in was the one refused, with its
//             `account`, and `expired` when the host no longer takes it (GitHub's 401)
export function repoAuthNeed(kind, credential, status, { signIn = false } = {}) {
  if (!HOST_LABEL[kind] || ![401, 403, 404].includes(status)) return null;
  if (credential?.source === 'server') return null;
  const need = { kind, label: `${HOST_LABEL[kind]} token`, refused: credential?.source === 'request' || credential?.source === 'link' };
  if (signIn) need.signIn = true;
  if (credential?.source === 'link') {
    need.via = 'sign-in';
    need.account = credential.account ?? null;
    if (kind === 'github' && status === 401) need.expired = true;
  }
  return need;
}

// How a repository on GitHub or Azure DevOps was read, for the record a Run
// keeps with its scan (packA.scan.access) — the kind of access, never its
// value, and the repository it read, so a record of another repository is
// never taken for this one's:
//   by  'token'    the person's own token, sent with the Run
//       'sign-in'  the person's sign-in to the host
//       'server'   the server's own token (a server without sign-in)
//       'none'     no token at all: a public repository
// The service list reads it (GET /api/journeys, lastRun.repositoryAccess) to
// stop offering the person's token field on a row whose repository was read
// without their access. null for a folder or an upload.
const ACCESS_BY = Object.freeze({ request: 'token', link: 'sign-in', server: 'server', none: 'none' });
export const REPOSITORY_ACCESS = Object.freeze(Object.values(ACCESS_BY));
export function repositoryAccess(repository, credential) {
  const kind = repository?.kind;
  if (!HOST_LABEL[kind] || typeof repository.location !== 'string' || !repository.location) return null;
  return { by: ACCESS_BY[credential?.source] || 'none', kind, location: repository.location };
}

// A record's `access` as the listing gives it: the three known fields, or null
// when the record has none or holds anything else (an older record, a hand-edited one).
export function recordedAccess(access) {
  if (!access || typeof access !== 'object') return null;
  const { by, kind, location } = access;
  if (!REPOSITORY_ACCESS.includes(by) || !HOST_LABEL[kind] || typeof location !== 'string' || !location || location.length > 2048) return null;
  return { by, kind, location };
}

// Every occurrence of the token in a text a person or a log will read, masked.
export function redactToken(text, token) {
  const s = String(text ?? '');
  if (!token || token.length < 4) return s;
  return s.split(token).join('[your token]');
}
