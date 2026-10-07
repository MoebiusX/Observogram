# MCP Integration

Observogram uses MCP for two jobs:

1. **Read live production posture** and reconstruct it as an ObservabilityPack.
2. **Write selected remediation artifacts** back to the observability platform.

The read path powers Diagnose. The write path powers Remediate.

## Read Path: Live Pack Generation

`tools/fetch-live-pack.mjs` interrogates an MCP endpoint and emits a canonical
ObservabilityPack v1.4 manifest. By default it writes the ignored local file:

```text
examples/production-live.pack.yaml
```

That file is runtime evidence, not a committed fixture. Upload it through the
studio or generate it locally when you need a live Pack B.

The studio's own live pack — the LIVE badge — is per org: the MCP panel's
refresh (`POST /api/refresh-live`) writes the active org's
`<org root>/live/production-live.pack.yaml`, and `GET /api/live-status`
reads it. `OUTPUT=<org root>/live/production-live.pack.yaml npm run fetch-live`
writes the same file from the CLI. The MCP URL is stored without userinfo,
fragment or credential query parameters (`token`, `api_key`, …); a token goes
in the auth field (`mcpAuth`; `MCP_AUTH` for the CLI), sent as a header and
never stored — never in the URL's path.

The studio can also call the same flow through `POST /api/draft-from-mcp`.
Successful drafts are registered in memory and become selectable as Pack B.

An org can name its MCP endpoints once (STORE_PLAN slice 4): an admin
registers `{ name, url, readTokenEnv? }` with `POST /api/mcp-endpoints`
(`X-Observogram-CSRF: 1` in every posture), every member lists them with
`GET /api/mcp-endpoints` (the URL and the variable's name to operators and
above), and an environment of a service names the one it is checked through
(`mcpEndpointId`). `POST /api/refresh-live` and `POST /api/draft-from-mcp`
then take `mcpEndpointId` in place of `mcpUrl`: the record's URL, and the
read token from the variable the record names —
`OBSERVOGRAM_ORG_<ORG>_<NAME>`, set in the server's environment (the k8s
studio Deployment's `env`, from a Secret) — read at request time when the
request sends no `mcpAuth`, never logged, returned or stored. An admin may
name only their org's variables (the owning org is the one whose prefix is
the longest match, so `OBSERVOGRAM_ORG_ACME_EU_X` is `acme-eu`'s); the URL
may carry no credential-looking query parameter. The deploy and rollback
routes take `mcpEndpointId` for the URL only — a write token is always the
request's `mcpAuth`. See the README's Services, Environments And MCP
Endpoints.

```bash
MCP_URL=https://otel-mcp.example.com/mcp \
MCP_AUTH=$MCP_CLIENT_KEY \
npm run fetch-live
```

### Who may name the target, and where a credential may go

Rebadge batch 3, C0 (docs/DOWNSTREAM.md §15.1 has the migration). A typed
`mcpUrl` — in the ping, the live jobs, the draft, the refresh, the deploy
routes and a journey's raw Pack B URL — is an admin's (`TYPED_MCP_URL_ROLE`,
`server/mcp-target-policy.mjs`); everyone else names a registered endpoint
(`mcpEndpointId`). Every target, typed or registered, meets the **origin
allowlist** on the server at registration and at each use:
`OBSERVOGRAM_MCP_ORIGINS` ∪ `OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS`, loopback
always allowed. With no list set, **no credential leaves for an origin other
than loopback**: an endpoint's server-held token, the caller's `mcpAuth`, a
credential in a typed URL, and a loaded **transport hook** — which counts as
a credential, because it may attach its own headers or client certificate;
the allowlist judges the target the caller chose, before the hook rewrites
it. A server-held token rides only to its own endpoint's registered URL. The
check does not resolve DNS: a hostname that resolves to a private address is
judged by its name (as `server/mcp-url.mjs` documents).

**Redirects are refused everywhere** (`tools/lib/mcp-client.mjs`, D10): every
request is sent with `redirect: 'manual'`, and a 3xx (or a browser's
`opaqueredirect`) is an error naming only the origin it pointed at — the
server, `npm run fetch-live`, the scheduled refresh and journeys alike. An MCP
behind a redirect is configured with its final URL. **Every answer text is
redacted by value** — an error's and a successful result's alike — before
it reaches an error, a 502 body, a log line, a gate-log message, a
`mcp.probeErrors.*` annotation, a ping's answer or a pack: the bearer, the URL's
userinfo and credential-named query values become `<redacted>` (in a
successful result the bearer and the userinfo at any length, a
credential-named query value only from 12 characters, and a tool's JSON
text only once it is parsed, so a short credential-named value such as
`sortkey=title` never renames a key or breaks the JSON), and the
server's routes redact the credential they resolved once more. One answer is
read up to 32 MiB (`MAX_MCP_ANSWER_BYTES`), and a caller's `AbortSignal` ends
every request in flight.

### Test the connection first: the ping

`POST /api/mcp/ping` (C2; `pingMcp` in `tools/fetch-live-pack.mjs`) runs
`initialize` and `notifications/initialized`, the whole `tools/list` (its
`nextCursor` followed up to ten pages) and **one** cheap read — the dashboards
search asked for one item, else the Grafana health read (credential-free: it
answers without the MCP's backend credentials, and the answer says so), else
`system_health` — within a 10 s deadline (5 s per request). The verdict is
read from where a failure surfaced: HTTP 401/403 → `auth-refused`; no answer
or a 5xx → `unreachable`; a timeout → `timeout`; any other status, a body that
is not JSON-RPC, a JSON-RPC error or a redirect → `not-mcp`; else `connected`
(a read whose tool answered an unauthorized text is kept as
`backendAuthRefused`, the MCP's own credentials to its backend). Advertised
tools are reported only through `capabilityInventory` (the capabilities a
fetch reads; the rest a count). The answer lists what it `checked` and what it
did `notChecked`; it writes no pack and no live file.

### Snapshot mode and live jobs

`fetchMcp({ mode: 'snapshot', scope, onStage, signal })` (C1) inventories what
is deployed rather than drafting a scaffold: every stage reports to `onStage`
with the stage ids of `tools/lib/live-fetch.mjs`; there is no core abort (a
stage whose tools are missing is skipped with its gap and the fetch goes on);
the stack self-metrics, the Alertmanager and Grafana observers and the ALERTS
query are not read, while the recording-rule grep still runs over the whole
metric-name list (it feeds the SLI and SLO inference); the scope narrows
metric names (prefixes, then a 20 000-name cap), dashboards (folder uids,
before the detail reads) and alert rules (folder uids, when every rule names
its folder); every advertised alert-rule engine is read and the rules unioned
by name, Grafana-managed rules read from the provisioning shape (`title`,
`data[]`, `folderUID`); a dashboard's id is its obs-pack-id tag, else the
crawler's `dashboardSpecId`, so a uid pairs with a crawled repository.
`buildSnapshotPack` writes `mcp.url` as the origin and the
`observogram.live.*`, `observogram.scope.<kind>` and
`observogram.unobserved.<kind>` annotations (docs/ADAPTER.md, "Live packs").
The draft (`mode: 'draft'`, the default) is the fetch as it was, byte for
byte. On the server both run as **live jobs** — `POST /api/mcp/jobs` answers
202 with an id, `GET /api/mcp/jobs/:jobId?since=<seq>` is the gate log —
in memory, so a restart loses them (docs/DOWNSTREAM.md §15.2 has the shapes
and the stage table). The configured scope is
`OBSERVOGRAM_SNAPSHOT_METRIC_PREFIXES`, `_FOLDER_UIDS` and `_DATASOURCE_UID`
(deployment) or `OBSERVOGRAM_ORG_<KEY>_SNAPSHOT_*` (one org); a datasource uid
is named in the gate log as not applied, since no advertised tool takes one.

## Server settings (admin configuration)

Rebadge batch 4. The MCP panel's **Server settings…** button configures the
**MCP server itself** — the backend base URL, user and secret it reads its
backend with, its own API key — not the studio's connection to it (the
panel's URL, endpoint and token stay what they were). The studio never keeps
any of it: by default the browser sends the settings straight to the MCP
server, and an opt-in pass-through (`OBSERVOGRAM_MCP_ADMIN_PROXY=1`, below)
exists for a deployment whose browser cannot reach the MCP server. This
section is the contract an MCP server implements to be configured from the
studio; `tools/lib/mcp-server-settings.mjs` (a listed module, pure and
browser-safe) holds the parser, the path rule, the request builder and the
outcome model, so a server author can vendor it and check their own
description against it.

### The settings description, version 1

The server describes its settings at `<MCP server root>/admin/schema`
(`SETTINGS_DESCRIPTOR_PATH`):

```jsonc
{
  "version": 1,                                   // required, an integer; only 1 is read
  "endpoint": "/configure",                       // required; the path rule below
  "auth": { "field": "apiKey", "scheme": "bearer" },   // optional: that secret field goes as Authorization: Bearer
  "fields": [                                     // required, 1–24
    { "name": "grafanaUrl",                       // /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/, unique; never
                                                  //   __proto__, constructor, prototype or action
      "label": "Backend base URL",                // required, 1–80 characters, one line
      "type": "url",                              // text | url | secret | boolean; any other type is read as text
      "required": true,                           // optional (default false)
      "help": "…",                                // optional, ≤ 240, one line
      "placeholder": "https://…" }                // optional, ≤ 120; ignored on a secret
  ],
  "actions": [                                    // optional, 0–4
    { "name": "disable",                          // the field-name rule; unique among actions
      "label": "Clear server credential",         // required, 1–80
      "endpoint": "/configure",                   // optional (default: the description's endpoint); the path rule
      "fields": ["apiKey"],                       // optional: the fields the action sends
      "confirm": "The server forgets the backend credential." }   // optional, ≤ 160: asks for a second click
  ]
}
```

- **At most 16 KiB.** A label, help, placeholder, confirm or action label
  holding a control character (U+0000–U+001F, U+007F) is refused, as are
  duplicate names, a reserved name, an action naming an unknown field, an
  `auth.field` that is not a `secret` field and an `auth.scheme` other than
  `bearer`. Each refusal names its rule (`fields[2].name "__proto__" is
  reserved`, `duplicate field name "user"`), and the modal shows it with
  **Try again** and **Use the generic form**.
- **A 200 that is not a description** — JSON without `version` and `fields`
  (a JSON-RPC answer such as `{"jsonrpc":"2.0","id":1,"result":{}}`), or a
  content type that is not JSON — is named as such and treated as no
  description: the generic form is offered.
- **Unknown keys are ignored** at every level, so an additive change stays
  version 1; a breaking change is a new version, which this studio refuses
  with `this server describes its settings in version N; this studio reads
  version 1 — update the studio, or use the generic form`.
- **A description carries no current values.** It is read without a
  credential; a `value` key is an unknown key, never read and never shown.
- **Field types.** `text` is a text input, `url` a URL input, `secret` a
  password input, `boolean` a checkbox; every text-like input takes at most
  2048 characters. A `url` value is sent normalised (`new URL`, http or https
  only, scheme and host lower-cased) and is refused when it carries a user or
  password before `@` — those go in their own fields, so they are treated as
  secrets. The studio checks nothing else about that URL: the MCP server owns
  its SSRF policy for its backend.

### Where it lives: the root and the path rule

**The MCP server root** is the MCP URL with its last path segment dropped
(one trailing slash ignored) and no query, fragment or userinfo:
`http://127.0.0.1:9000/mcp` and `…/mcp/` give `http://127.0.0.1:9000/`;
`https://gw.example/team-a/mcp` gives `https://gw.example/team-a/`. A server
behind a path-prefix gateway therefore publishes its description under its
own prefix (`https://gw.example/team-a/admin/schema`).

**Every path** — the description's `endpoint`, each action's `endpoint`, the
generic form's path and the settings policy's `generic.path` — is 1–128
characters of `^/?[A-Za-z0-9._~-]+(?:/[A-Za-z0-9._~-]+)*$`, with no segment
`.` or `..` and none starting with `..`: no `%` escape, `;`, `:`, `@`, `\`,
`?`, `#`, white space or empty segment. A leading `/` is relative to the
**root**, not the origin (`/configure` under `https://gw.example/team-a/` is
`https://gw.example/team-a/configure`). The resolved URL is checked again —
the same origin, under the root, no userinfo, query or fragment, and
`mcpUrlPolicy` clean — in the browser and again in the pass-through. A path
that fails is refused by name (`… is not a plain path under <root> … — the
studio sends settings only to the MCP server itself; its author fixes the
descriptor`), and nothing is sent.

### The generic form (servers without a description)

A 404, 405, 501, 401 or 403 on the description, or an answer that is not a
description, gives the **generic form**, which always says it is generic and
why: `Backend base URL` (`url`, required), `User`, `Password / token` and
`Server API key` (`secret`, "leave empty only if the server needs none"),
named `url`, `user`, `secret` and `apiKey`, sent to `/configure`, every field
in the body (`genericDescriptor`). Under **What the server expects** the
reader may rename the four fields, change the path and send the API key as
`Authorization: Bearer` instead. A deployment sets the prefill in its
settings policy's optional `generic` block (`{ path, names, auth: 'body' |
'bearer' }`, below); nothing the reader changes is remembered.

### The request

Opening the modal sends nothing at boot and nothing when the panel opens. On
open the studio reads `GET /api/mcp-settings` (the settings policy, and
whether the pass-through is on) and, once the target passes the checks below,
the description — from the browser, a CORS simple `GET` with **no header and
no credential** (`credentials: 'omit'`, `redirect: 'manual'`,
`referrerPolicy: 'no-referrer'`, `cache: 'no-store'`), 10 s, read with a
16 KiB cap.

**Send to the server** POSTs `application/json` from the browser to the
resolved endpoint (`credentials: 'omit'`, `redirect: 'manual'`, 15 s): one
key per field — a URL normalised, a secret exactly as typed, a boolean as
`true`/`false`, an empty optional field omitted — at most 64 KiB. When the
description has `auth`, that field leaves the body and goes as
`Authorization: Bearer <value>`. Nothing of the studio goes with it: no
cookie, no `X-Observogram-*` header (no CSRF header, no active org), no
referrer. An **action** sends `{ "action": "<name>" }` plus its declared
`fields`; without them, the `auth` field when there is one, else every
secret the reader typed — the note under the button says which, and that an
empty one means a server that needs it will refuse. An action skips the
required fields, and the policy's acknowledgements unless it carries a field
a rule matched: then it waits for that acknowledgement (and for a readable
policy), as the pass-through does.

The **target** is checked before any request (`studio/mcp-settings-model.mjs`
`settingsTargetModel`): `mcpUrlPolicy`; never the studio's own origin, nor
another name for this machine on the loopback page's port (a settings request
there would reach the studio server); a loopback MCP server
(or a host that may be this machine — `*.localhost`, `0.0.0.0`, `[::]`) only
from a page that is itself on loopback; `https:` unless loopback; and a
loopback or **listed** origin — the server's `OBSERVOGRAM_MCP_ORIGINS` (or the
org's `OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS`), or in the static bundle the list
`--mcp-origins` baked. Each refusal names its reason and the way out for the
reader's posture. Who sees the button enabled: whoever may register an MCP
endpoint (`GET /api/mcp-endpoints` `policy.register.allowed` — a session
admin or owner, or the open posture's caller on a direct loopback request);
anyone else sees it `aria-disabled` with the reason.

Secret inputs are password inputs with `autocomplete="new-password"` and the
password managers' ignore attributes, in no `<form>` and with no `name`, so a
saved studio login is never offered; their values are emptied as soon as the
request is sent, and every input is gone when the modal closes.

### The outcome

A server answers its configure (and each action) with the outcome shape —
optional, and the only source of "verified":

```jsonc
{ "ok": true,                                  // the server's verdict
  "message": "Connected as svc-observogram",   // ≤ 500 characters shown
  "checks": [ { "label": "Identity", "status": "pass", "detail": "role Viewer" },   // ≤ 24
              { "label": "Toolset: alerting", "status": "fail", "detail": "403 from backend" } ] }
```

| The answer | The modal says |
|---|---|
| 2xx, `ok: true` | `The server reports the settings verified (HTTP <s>).` — then the panel's connection test runs |
| 2xx, `ok` absent or not JSON | `The server accepted the settings (HTTP <s>). It reported no verification.` |
| 2xx, `ok: false` | `The server answered HTTP <s> but reports a failure.` |
| any other status | `The server refused the settings: HTTP <s>.` |
| a redirect | `The server answered with a redirect, which the studio never follows.` and that it may have applied the settings |
| sent, but the answer could not be read (network, no CORS on the answer, timeout) | that the outcome is unknown — never that nothing happened — with **Test the connection** |

A check's status is shown as a word (`pass`, `fail`, `skip`, anything else
`unknown`). The body is shown as the server returned it — pretty-printed when
it is JSON, 8 KiB of the 64 KiB read — as text only, after the studio hides
every submitted secret of 4+ characters it finds echoed back (raw,
URI-encoded, JSON-escaped, base64, and base64 `<user>:<secret>`), then, in
parsed JSON, every value under a submitted secret's name or a
credential-like key (`password`, `secret`, `token`, `apiKey`, `credential`,
`authorization`) whatever its length; the modal says how many it hid.

After a verified configure the panel's **connection test** runs, and the
modal reports its read's outcome, not only the verdict — `connected, and the
read <tool> answered: …` or `connected, but the read failed: …` — since the
connection test says `connected` even when the MCP server's backend read
fails. **Open the live panel** then opens the live panel on the same target
with its test run, so a Snapshot is one click away.

### What your server must do

The studio cannot enforce any of this on the browser-direct path; the MCP
server's configure endpoint is what holds. The server author:

1. **Authenticates the configure endpoint and every action** — `auth`
   (`Authorization: Bearer`) or a body field the action also sends. An
   unauthenticated configure endpoint makes **every studio user, every
   script running on the studio's origin and every process on that machine**
   the server's admin: any of them can point it at a backend of their choosing
   (packs built from a backend they control, requests from the MCP server to
   an internal host). They need no existing secret — they bring their own
   backend. The only tolerable exception is a single-user development
   machine, at that cost.
2. **Restricts CORS to the studio's origin(s), on every response** — the
   description, the configure and every action path, **errors and 401
   included** (set CORS before auth and before the error handler): an exact
   `Access-Control-Allow-Origin: <studio origin>` with `Vary: Origin`. Never
   `*` on the configure endpoint and never `null` (a `file://` page sends
   `Origin: null`); never `Access-Control-Allow-Credentials` (the studio sends
   no cookie). The `OPTIONS` preflight allows `POST` and the headers
   `content-type, authorization`.
3. **Checks `Origin` on the configure POST**: refuses a present Origin that is
   not a listed studio origin; accepts an absent Origin only from an
   authenticated caller (the pass-through sends none); requires
   `Content-Type: application/json`. CORS alone does not stop a cross-site
   form POST.
4. **Checks the `Host` header** against its own bind address(es). A loopback
   server without this check can be reached by DNS rebinding from any page.
5. **Never redirects** the description or the configure endpoint (the studio
   follows no redirect), and **never echoes a submitted secret** — the
   studio's redaction is a backstop, not the contract.
6. **Serves the description without credentials and without current
   values**, as `application/json` with `Cache-Control: no-store`: it is a
   schema, not a state read.
7. **Validates the values itself**, including its own SSRF policy for a `url`
   field: the MCP server is what will call that backend.
8. **Answers the outcome shape and audits its own configure calls.** A
   configure the browser sends directly leaves no studio record.
9. **Serves over https unless it binds to loopback** — the studio refuses a
   plain-http settings target that is not loopback.

### What the studio does, and what it cannot do

The studio's guarantee is that **it** never sends a settings value anywhere
but the MCP server the panel names, and never keeps one: no value reaches
`localStorage`, `sessionStorage`, a cookie, the studio's state, the
workspace, the store, a server log, an audit row or any studio API body
(`server/test-mcp-settings-studio.mjs` scans all of them after a configure,
a verify and a snapshot, a reload, a sign-out and a sign-in). On the
browser-direct path the role gate, the target checks and the settings
policy's acknowledgements are the studio's affordances: a request sent from
the browser meets none of the studio server's authorization, its origin
allowlist, its no-redirect client or its audit, and a reader with the
browser's developer tools (or curl) can skip all of them. The MCP server's
own authentication, CORS, Origin and Host checks (above) are what enforce. A
page reached through an SSH tunnel on `127.0.0.1` passes the studio's
same-machine check while the MCP server is remote from the reader; there,
too, the MCP server's Host and Origin checks are what hold.
`OBSERVOGRAM_ALLOW_LOCAL_MCP=0` protects the studio server's own network from
its own requests; a browser-direct request is not one, so only the
pass-through applies it.

**The settings policy** (`OBSERVOGRAM_MCP_SETTINGS_POLICY`, docs/DOWNSTREAM.md
§9 and §16) adds friction only: a rule whose pattern matches a field's value
(a URL as its normalised form; a rule never reads a secret) shows its warning
and, with `require.ack`, blocks the send until its acknowledgement is ticked;
a rule whose field the form does not have cannot run, says so, and still
requires its acknowledgement. Acknowledgements are never remembered. On the
browser-direct path that block is advisory; the pass-through re-checks it
against the description it reads itself. A deployment that needs the rule
enforced enforces it in the MCP server.

### The pass-through: `OBSERVOGRAM_MCP_ADMIN_PROXY=1`

Off by default (read per request, no restart). Use it when the browser cannot
reach the MCP server — it sends no CORS headers, or it listens on a machine
the reader's browser is not on. When `GET /api/mcp-settings` says it is on,
the modal sends **every** request through the studio server —
`POST /api/mcp-settings/describe` and `POST /api/mcp-settings/submit` (README
"API Surface" has the shapes) — and never falls back from one path to the
other. The routes are `admin`, take the CSRF header in every posture, answer
without sign-in only a direct loopback request, and are closed when the
server is exposed without sign-in. The studio server:

- resolves the target as every MCP route does (a registered endpoint, or an
  admin's typed URL), **never sending the endpoint's read token** and
  refusing an `mcpAuth`; applies `OBSERVOGRAM_ALLOW_LOCAL_MCP`, https unless
  loopback, never its own address, and to a submit (which carries a
  credential) the origin allowlist;
- sends only to the paths it read: the description at `<root>/admin/schema`;
  a described submit reads the description again and sends to the endpoint
  (or the action's endpoint) it declares, whatever the caller says; a generic
  submit only to the settings policy's `generic.path`, else `/configure`;
- re-checks the settings policy against what it read (a missing
  acknowledgement is a 409);
- sends with the platform's `fetch`, **never through the transport hook**, so
  a hook's own credential never rides to a settings path; no redirect
  followed; exactly `Content-Type`, `Accept` and the description's own
  `Authorization`; 10 s; the answer read with a cap;
- passes back **the outcome shape only** — the description re-serialised from
  its parse, or the outcome's `ok`, `message` and `checks` redacted; any other
  body is named by its status, media type and size and never shown;
- never logs, keeps or echoes the body (a malformed body is a 400 that quotes
  none of it); logs one line per upstream request,
  `[mcp-settings] <describe|submit|action:<name>> <status> <ms>ms`; writes one
  `live.mcp-settings` audit row per submit with field names and acknowledged
  rule indexes, never a value.

An MCP server reachable only through the transport hook's gateway cannot be
configured through the pass-through; configure it browser-direct, or have the
gateway forward `/admin/schema` and the configure path.

### A minimal server

A loopback MCP server on port 9000 configured by a studio at
`http://127.0.0.1:8090`, with its API key as the bearer:

```js
import { createServer } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

const STUDIO = 'http://127.0.0.1:8090';                 // the studio origin(s) allowed to configure this server
const HOSTS = new Set(['127.0.0.1:9000', 'localhost:9000']);
const KEY = Buffer.from(process.env.MCP_ADMIN_KEY);     // required: the server's own API key
const DESCRIPTION = JSON.stringify({
  version: 1, endpoint: '/configure', auth: { field: 'apiKey', scheme: 'bearer' },
  fields: [
    { name: 'grafanaUrl', label: 'Backend base URL', type: 'url', required: true },
    { name: 'user', label: 'User', type: 'text' },
    { name: 'secret', label: 'Password / token', type: 'secret' },
    { name: 'apiKey', label: 'Server API key', type: 'secret' },
  ],
  actions: [{ name: 'disable', label: 'Clear server credential' }],
});
const send = (res, status, body) => res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
const authorised = (req) => {
  const given = Buffer.from(String(req.headers.authorization ?? '').replace(/^Bearer /, ''));
  return given.length === KEY.length && timingSafeEqual(given, KEY);
};

createServer((req, res) => {
  if (!HOSTS.has(req.headers.host)) return send(res, 421, { ok: false, message: 'unknown host' });   // DNS rebinding
  res.setHeader('Vary', 'Origin');                                                       // CORS first, on every answer
  if (req.headers.origin === STUDIO) res.setHeader('Access-Control-Allow-Origin', STUDIO);
  if (req.method === 'OPTIONS') {
    return res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'content-type, authorization' }).end();
  }
  if (req.method === 'GET' && req.url === '/admin/schema') return send(res, 200, JSON.parse(DESCRIPTION));
  if (req.method !== 'POST' || req.url !== '/configure') return send(res, 404, { ok: false, message: 'not found' });
  if (req.headers.origin !== undefined && req.headers.origin !== STUDIO) return send(res, 403, { ok: false, message: 'origin not allowed' });
  if (!authorised(req)) return send(res, 401, { ok: false, message: 'API key required' });
  if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return send(res, 415, { ok: false, message: 'JSON only' });
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (c) => { raw += c; if (raw.length > 65536) req.destroy(); });
  req.on('end', () => {
    let body;
    try { body = JSON.parse(raw); } catch { return send(res, 400, { ok: false, message: 'not JSON' }); }
    if (body.action === 'disable') { /* forget the backend credential */ return send(res, 200, { ok: true, message: 'The server forgot the backend credential.' }); }
    // Validate grafanaUrl against this server's own SSRF policy, store the settings,
    // try the backend, and say what was checked — never echo body.secret.
    return send(res, 200, { ok: true, message: 'Settings applied.', checks: [{ label: 'Identity', status: 'pass' }] });
  });
}).listen(9000, '127.0.0.1');
```

`server/fixtures/fake-mcp.mjs` (its `admin` option) is the same surface as
the test suites drive it: a description, configure and disable, CORS for one
origin, an API key in the header or the body, and every admin request
recorded.

## Transport hook

Every MCP request Observogram makes — `npm run fetch-live`, `npm run
record-fixtures`, the live probes (`buildAndValidate`), a journey's live
source and the studio server's `POST /api/refresh-live`,
`POST /api/draft-from-mcp` and the deploy and rollback routes — goes through
one client, `tools/lib/mcp-client.mjs`, and its single `send()`. A
distribution behind a gateway with its own auth, extra headers, a proxy or a
private CA shapes those requests there, without forking the client:

```bash
OBSERVOGRAM_TRANSPORT_HOOK=./hooks/gateway.mjs npm run fetch-live
```

The value is a path — absolute, or relative to the working directory — or a
`file:` URL, of an ES module with one or both of these named exports:

```js
// hooks/gateway.mjs — runs in Node, with the process's trust.
import { Agent } from 'undici';           // the operator's own dependency, not Observogram's

// Applied to EVERY request. Sync or async. Return what you change: an
// omitted field keeps the input, returned headers are merged over the built
// ones ({ ...headers, ...returned }), so Mcp-Session-Id and the rest survive.
export async function prepareRequest({ url, headers }) {
  const exchanged = await exchangeToken(headers.Authorization);   // the bearer is visible: Bearer <MCP_AUTH>
  return {
    url: url.replace('https://otel-mcp.example.com/', 'https://gateway.internal/otel-mcp/'),
    headers: { ...headers, Authorization: `Bearer ${exchanged}`, 'X-Tenant': 'payments' },
  };
}

// Optional: replace the fetcher wholesale (a private CA, a corporate proxy,
// mTLS). init is { method: 'POST', headers, body, redirect: 'manual', signal } —
// the AbortSignal carries OBSERVOGRAM_MCP_TIMEOUT_MS and may be honoured or
// ignored; a redirect the fetcher returns is refused either way.
const dispatcher = new Agent({ connect: { ca: process.env.PRIVATE_CA_PEM } });
export const fetchImpl = (url, init) => fetch(url, { ...init, dispatcher });
```

What the hook sees and what it must do with it:

- `headers` is the request as the client built it — `Content-Type`,
  `Accept`, `MCP-Protocol-Version`, `Authorization: Bearer <token>` when a
  token was given (`MCP_AUTH`, `mcpAuth`, a journey's `authEnv`), and
  `Mcp-Session-Id` once the server issued one. `url` is the caller's URL as
  given, credential query parameters included (they are stripped for
  persistence, not for the wire). The hook may replace both. It is
  operator-installed code running with the process's trust: **never log the
  headers or the URL**. As a backstop the client replaces the bearer, the
  URL's userinfo and every credential-named query value with `<redacted>` in
  the hook's *own* error text; nothing else the hook does is redacted for it.
- The URL a `prepareRequest` returns passes the same policy the caller's URL
  passed: it must parse and be `http(s)`, and under
  `OBSERVOGRAM_ALLOW_LOCAL_MCP=0` it may not name a local or private address
  (`tools/lib/mcp-url-safety.mjs` `mcpUrlPolicy`, the pure form of the
  server's `validateMcpUrl`). A `fetchImpl`-only hook leaves the URL alone,
  so no second check runs. A hook cannot turn a public URL into `file:` or,
  in the strict posture, into a loopback one.
- A `fetchImpl` must answer a Response-like object (`ok`, `status`,
  `headers.get()`, `text()`, `json()`, and `body.getReader()` when it answers
  `text/event-stream`); `new Response(…)` satisfies all of it.

Only a **contract fault** is a hard failure (`TransportHookError`): the module
cannot load or exports neither function; `prepareRequest` throws or returns a
non-object, a non-string `url`, non-object `headers`, a header name or value
carrying CR or LF, a non-`http(s)` URL or one the policy refuses; `fetchImpl`
returns something that is not a Response. Then nothing is written:
`fetch-live` exits 1 at its FATAL line with the previous `OUTPUT` untouched,
the recorder exits 1 before its `--write` block, a journey run exits 2 with
no run record (a configuration error, like an unset `authEnv` — never a
`vantage-lost` record and never a `failed` inventory record), the studio
server refuses to start on a load failure (`[studio] failed to start:
OBSERVOGRAM_TRANSPORT_HOOK: cannot load …`) and answers a call-time fault
with one `502 { ok: false, error }` and no live pack, no per-item results
and no deploy or rollback record. **Network failures are not hook faults**:
a rejection from `fetchImpl` (or from native `fetch` through a
`prepareRequest`-only hook), a refused connection or an HTTP 503 on one probe
behave exactly as without a hook — retried once when transient, annotated as
that probe's failure, the pack written. A `fetchImpl` rejection's message is
still hook text, so it is redacted like a `prepareRequest` throw's (the
error itself stays ordinary: same name and code, the original kept as
`cause`); so is the text of a Response the `fetchImpl` *returns* — the body
of a non-OK answer (`MCP HTTP <status> on <method>: …`) and a JSON-RPC or
SSE `error.message`. Native `fetch` is redacted the same way: every text an
MCP answer puts into an error — a non-OK body, a JSON-RPC or SSE
`error.message`, a tool's `isError` text — goes through the redaction
whoever answered, so an upstream that repeats the request's Authorization
header never carries the token back; a body that is not JSON is reported as
`MCP <method>: the answer is not valid JSON` (the parser's message would
quote it).

The texts, exact: `OBSERVOGRAM_TRANSPORT_HOOK: cannot load <path>: <message>`
· `OBSERVOGRAM_TRANSPORT_HOOK: <path> exports neither prepareRequest nor
fetchImpl` · `OBSERVOGRAM_TRANSPORT_HOOK: <path> exports prepareRequest,
which is not a function` (same for `fetchImpl`) · `transport hook <path>:
prepareRequest threw: <redacted message>` · `transport hook <path>:
prepareRequest returned <null|string|…>, not { url, headers }` · `… returned
a url that is not a string` · `… returned headers that are not an object` ·
`… returned header "<name>" containing CR or LF` · `… returned a URL that is
not http(s): <safe url>` · `transport hook <path>: mcpUrl targets a
local/private address (<host>), which OBSERVOGRAM_ALLOW_LOCAL_MCP=0 forbids`
· `transport hook <path>: fetchImpl returned <type>, not a Response`.

The hook loads **once per process** (`tools/mcp-transport.mjs`
`mcpTransport()`) and cannot be swapped at runtime; each entrypoint logs the
path once — `[fetch-live-pack] transport hook: OBSERVOGRAM_TRANSPORT_HOOK=…
(prepareRequest: yes, fetchImpl: no)` on stderr, `[studio] MCP transport
hook: …` at start (a silent boot prints nothing) — never a header or a URL.
The legacy `TOMOGRAPH_TRANSPORT_HOOK` spelling is honoured
(`tools/lib/brand-env.mjs`'s rule, the modern name wins); every message
spells the modern name. Unset or empty, the hook is inert: no import, no log
line, `globalThis.fetch`, the same URL and the same headers in the same
order, no second URL check (`tools/test-mcp-transport.mjs` proves the request
log identical with no hook and with an identity hook). The hook runs in Node
only — the studio in the browser never loads it; the client module itself is
browser-safe and vendorable (`docs/DOWNSTREAM.md`). A suite that needs a hook
sets the variable for a child process, never for its own
(`server/fixtures/serve-child.mjs` strips it from every child it starts).

## What The Live Pack Contains

The live pack is not just a health summary. It carries the artifacts needed for
diagnostic-grade drift:

| Area | Live evidence |
|---|---|
| Services and topology | discovered services, service graph hints, OTel backend evidence |
| Metrics | metric inventory and names observed from the live platform |
| Scrape jobs | Prometheus/VictoriaMetrics scrape evidence |
| Recording rules | full rule names and expressions where the MCP exposes them |
| Alert rules | Grafana/Prometheus alerting rules; burn-rate alerts are mapped from them per SLO, never synthesised; every other rule is declared in `spec.alerting.rules` (spec 1.4) under its exact name |
| Alerting routes | the routes of the configuration the running Alertmanager reports — severities and channels, secret addresses as `redacted:secret` |
| Dashboards | Grafana dashboard metadata plus dashboard bodies, panels, variables, and targets |
| Baselines | none yet — MTTD/MTTR are platform defaults stamped `Scaffold`; anomaly baselines are only counted (`mcp.baselinesComputed`) |
| Backends | the products with evidence of running — a version they report, a scrape target of theirs that is up, a tool of theirs that answered — never the list of what the MCP supports |
| Backend versions | observed platform products and versions |

This is what lets Observogram compare declared repo artifacts against live
production artifacts instead of only checking whether a live endpoint responded.

## Verification Annotations

The schema constrains `metadata.annotations` to flat string keys, so MCP
attestation is stored as annotations:

```yaml
metadata:
  annotations:
    mcp.refreshedAt: "2026-06-09T00:09:14.730Z"
    mcp.url: "https://otel-mcp.example.com/mcp"
    mcp.toolsCalled: "system_health,vmalert_rules,metrics_label_values,metrics_targets"
    mcp.toolsFailed: ""                              # core tools only; probe families are accounted below
    mcp.toolsExposed: "system_health,vmalert_rules,metrics_label_values,metrics_targets,grafana_dashboards_search,…"
    mcp.toolsExposedCount: "14"
    mcp.toolsUnmatched: "logs_search"                # advertised, no probe pattern yet
    mcp.probesAttempted: "recording_rules,alert_rules,dashboards,metric_names,scrape_configs"
    mcp.probesSucceeded: "recording_rules,alert_rules,metric_names,scrape_configs"
    mcp.probesEmpty: ""                              # a probe answered with an empty list
    mcp.probesFailed: "dashboards"                   # every candidate errored — a hole of unknown size
    mcp.probesUnsupported: ""                        # e.g. "traces_services" when tools/list exposes no candidate — a restricted tier, not an outage
    mcp.probeErrors.dashboards: "HTTP 502 Bad Gateway"   # last erroring candidate of a FAILED family only (trimmed to 200 chars)

    mcp.verified.otel.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.telemetry.scrape: "2026-06-09T00:09:14.730Z"
    mcp.verified.pipelines.exporters.metrics: "2026-06-09T00:09:14.730Z"
    mcp.verified.queries.recording_rules: "2026-06-09T00:09:14.730Z"      # aggregate: at least one rule earned an indexed stamp
    mcp.verified.queries.recording_rules[0]: "2026-06-09T00:09:14.730Z"   # per rule, withheld when the ruler reports it unhealthy
    mcp.verified.slis.svc_checkout_availability: "2026-06-09T00:09:14.730Z"   # withheld when a feeding rule is unhealthy
    mcp.verified.slos.svc_checkout_availability_99_9: "2026-06-09T00:09:14.730Z"   # bound by a discovered burn-rate group (exact id or re-identified)
    mcp.verified.policy.burn_rate_alerts[0]: "2026-06-09T00:09:14.730Z"  # per mapped entry, never unindexed
    mcp.verified.dashboards: "2026-06-09T00:09:14.730Z"                   # aggregate
    mcp.verified.dashboards.kx-genai-operations: "2026-06-09T00:09:14.730Z"   # per discovered dashboard (the symbol the adapter reads)

    mcp.discovered.alert_rule_names: "svc_checkout_availability_99_9_burn_14x_5m_1h,..."
    mcp.discovered.alert_rules_unmapped: "svc_payments_latency_99"
    mcp.discovered.scrape_jobs: "node-exporter,grafana,otel-collector"
    mcp.discovered.scrape_jobs_down: "alertmanager"
    mcp.discovered.alert_rules_unhealthy: "HighLatencyP99"
    mcp.discovered.slis_unhealthy: "svc_payments_latency"      # SLIs whose feeding recorded rule is unhealthy (only when non-empty; likewise recording_rules_unhealthy, alert_rules_severity_inferred)
    mcp.observed.scrape_targets: '[{"job":"alertmanager","instance":"kx-alertmanager:9093","health":"down","lastScrape":"…","lastError":"dial tcp4 …: connection refused"}, …]'
    mcp.observed.recording_rules: '[{"name":"finops:cpu:usage_per_pod_5m","health":"ok","lastError":null,"lastEvaluation":"…","evaluationTime":0.0009}, …]'
    mcp.observed.alert_rules: '[{"name":"HighLatencyP99","health":"err","lastError":"…","lastEvaluation":"…","state":"inactive","activeAt":null}, …]'
    mcp.baselinesComputed: "2"

    mcp.scaffold.otel: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.receivers[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.processors[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.exporters.logs: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.pipelines.exporters.traces: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.telemetry.backends.logs-elastic: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.alerting.routes[0]: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.baselines: "schema-required fallback; not attested by any MCP tool"
    mcp.scaffold.policy.burn_rate_alerts[0]: "schema-required fallback; no burn-rate alerting rule discovered via MCP"
```

The adapter promotes artifacts with matching `mcp.verified.<symbol>` keys to
`Verified`, and projects `mcp.scaffold.<symbol>` keys (the live-side
counterpart of `crawler.scaffold.<symbol>`) as `Scaffold` — a schema-forced
placeholder the MCP did not attest, parked by the grade rather than counted.
The Diagnostic Grade uses these annotations to decide whether a fresh live
signal exists.

### Annotation reference

Every key the fetcher writes, by family. Comma lists are capped at 64 names;
JSON arrays (`annotationJson`) at 200 entries; error strings at 200 chars.

| Key | Value | Meaning |
|---|---|---|
| `mcp.refreshedAt`, `mcp.url` | ISO time, URL | when and from where the pack was fetched (the caller's stamp — the studio's or the journey's) |
| `mcp.fetchStartedAt` | ISO time | the fetcher's own clock: the instant this fetch began; the ladder's "now" for a family without `mcp.observedAt.<family>` (older packs fall back once more to `mcp.refreshedAt`, named in the detail) |
| `mcp.observedAt.<family>` | ISO time | the instant each probe family answered (data or empty outcomes; `dashboards` re-stamped after detail enrichment) — "now" for the ladder's staleness judgement on that family's `mcp.observed.*`, so a `refreshedAt` trailing a fresh observation never reads stale |
| `mcp.toolsCalled`, `mcp.toolsFailed` | comma list | core tools (`system_health`, …) called / errored |
| `mcp.toolsExposed`, `mcp.toolsExposedCount`, `mcp.toolsUnmatched` | comma list, count | the `tools/list` inventory, and advertised tools with no probe pattern |
| `mcp.probesAttempted` / `Succeeded` / `Empty` / `Failed` / `Unsupported` | comma list of probe families | outcome per family: answered with data / answered empty / every candidate errored / no candidate advertised by `tools/list` |
| `mcp.probeErrors.<family>` | string | last erroring candidate's message, written only for a family whose outcome is `failed` (a family whose later candidate answered carries none — it is in `probesSucceeded`) |
| `mcp.verified.<symbol>` | `refreshedAt` | the adapter projects the artefact as `Verified`; indexed for per-entry lists (`queries.recording_rules[<i>]`, `policy.burn_rate_alerts[<i>]`), per id for dashboards (`dashboards.<id>`, beside the aggregate `dashboards`) |
| `mcp.scaffold.<symbol>` | note string (same convention as `crawler.scaffold.*`) | schema-forced placeholder no tool attested; projects as `Scaffold` |
| `mcp.discovered.<family>` | count | array length of a probe's adapted result, `"0"` when it answered empty |
| `mcp.discovered.scrape_jobs` / `scrape_jobs_down` | comma list of job names | jobs with at least one target up (or of unknown health) / jobs whose every target is down |
| `mcp.discovered.recording_rules_unhealthy` / `alert_rules_unhealthy` | comma list of rule names | rules whose reported `health` is not `ok` |
| `mcp.discovered.alert_rule_names` | comma list | every alerting rule name the MCP exposed |
| `mcp.discovered.alert_rules_unmapped` / `alert_rules_severity_inferred` | comma list | burn-rate groups the schema cannot represent / rules whose severity came from the burn factor |
| `mcp.discovered.metric_names`, `_count`, `_sample` | JSON, count, comma list | the metric inventory |
| `mcp.discovered.dashboard_panels`, `dashboard_raw_json`, `dashboard_detail_errors` | counts, comma list | dashboard body capture |
| `mcp.discovered.alerts_firing.*`, `recording_rules_via_inventory.*` | counts, names, source | `ALERTS` series and rule names recovered from the metric inventory |
| `mcp.discovered.extended_surfaces`, `extended_surface_refs` | count, comma list | level-2 evidence surfaces |
| `mcp.observed.scrape_targets` | JSON `[{job, instance, health, lastScrape, lastError}]` | every scrape target's on-wire health |
| `mcp.observed.recording_rules` | JSON `[{name, health, lastError, lastEvaluation, evaluationTime}]` | every recording rule's evaluation state |
| `mcp.observed.alert_rules` | JSON `[{name, state, health, lastError, lastEvaluation, activeAt, interval?, labels?}]` | every alerting rule's evaluation state; `interval` is the group evaluation interval when the ruler reports one (the alert adapter keeps it too), `labels` the burn-rate linkage labels the compiler stamps — `{ slo, burn_rate, window_short, window_long }`, present keys only, omitted when none — so the ladder links a live rule to its declared window by labels first, name second |
| `mcp.servicesDiscovered`, `mcp.activeAnomalies`, `mcp.baselinesComputed` | comma list, counts | `system_health` / anomaly tools answered (not a measurement of anything in `spec.baselines`) |
| `mcp.capabilities.*`, `mcp.versions.<product>[.*]` | strings | `backend_capabilities` inventory and observed product versions |
| `mcp.capabilities.unobserved` | comma list of products | what the inventory lists and nothing showed to be running: supported, not deployed — never a backend |
| `mcp.backends.evidence` | `<backend id>=<what attested it>` joined by `\|` | per backend: the version probe (`metrics_query/vm_app_version`), the scrape job (`scrape job promtail`) or the product tool (`vmalert_rules`) behind it |
| `mcp.derived.<symbol>` | string | an entry READ from live rules without being attested as what the pack calls it — `policy.burn_rate_alerts[<i>]` read from plain alerting rules names the rules; projects as `Declared`, neither `Verified` nor `Scaffold` |
| `mcp.discovered.alert_rules_linked` / `alert_rules_operational` | counts | alerting rules that guard a recorded SLO (read as burn-rate entries) / that guard none — the latter are declared in `spec.alerting.rules` (spec 1.4), each stamped `mcp.verified.alerting.rules[<i>]` unless the ruler reports it unhealthy |
| `observogram.unobserved.<family>` | reason string | an artefact family this fetch had no way to look at (see *What the fetch could not look at*) |
| `mcp.stack.status` | `sampled` \| `not-attempted` | the stack self-metrics panel (step 2, "Stack self-metrics (sampling)"): whether it was sampled at all — signals, never verdicts; written whenever the fetcher ran the step-2 sampler (a caller that predates step 2 writes nothing) |
| `mcp.stack.reason` | string | only when `not-attempted`: why (`metrics_query not exposed by this MCP (restricted tier)`) |
| `mcp.stack.sampled` / `empty` / `failed` / `notInInventory` / `notAttempted` | counts (strings) | rows per outcome (`data` rows are `sampled`) |
| `mcp.stack.families` | comma list of `<family>:<best outcome>` | best outcome per family, `data > empty > failed > not-in-inventory > not-attempted` |
| `mcp.observed.stack_metrics` | JSON `[{id, family, product, expr, value, unit, direction, at, outcome, reason?}]` | attempted and `not-in-inventory` rows (cap 64); `not-attempted` rows are counted, not listed |
| `mcp.observed.alertmanager` | JSON `{version, uptime, clusterStatus, silences, error?}` | written when `alertmanager_status` / `alertmanager_silences` was ADVERTISED; `error` carries the trimmed failure of an advertised tool that did not answer — a failure, not a tier limit |
| `mcp.observed.grafana.datasources`, `mcp.observed.grafana.contact_points` | JSON `[{uid, name, type, health: ok\|error\|unknown, message}]`, `{count, names}` | `unknown` health means NOT CHECKED (health tool not exposed / errored / beyond the 10-uid cap), never "not unhealthy" |
| `mcp.observed.grafana.error` | string | the trimmed failure of an advertised Grafana status tool that did not answer |
| `mcp.observed.alertmanager` | JSON `{version, uptime, clusterStatus, silences: {active, total} \| null}` | Alertmanager status surface (`alertmanager_status` + `alertmanager_silences`) |
| `mcp.observed.grafana.datasources` | JSON `[{uid, name, type, health, message}]` | Grafana datasources with their health (`ok` \| `error` \| `unknown`, message trimmed to 200 chars) |
| `mcp.observed.grafana.contact_points` | JSON `{count, names}` | Grafana contact points (names capped at 32) |

### What the fetcher invents, and how it says so

The pack schema forces sections no MCP tool can attest. Every such entry the
fetcher has to invent is stamped `mcp.scaffold.<symbol>` (the symbol is the
one the adapter passes to `sourceOf`) and never `mcp.verified.<symbol>`:

| Placeholder | Symbol | Becomes `Verified` when |
|---|---|---|
| `spec.otel` (semconv, SDK languages, sampling, propagators) | `otel` | never — only `otel.metrics` is stamped, from the metric inventory |
| Collector receiver / processors | `pipelines.receivers[0]`, `pipelines.processors[<i>]` | never |
| Logs / traces exporters | `pipelines.exporters.logs`, `pipelines.exporters.traces` | never |
| Metrics exporter | `pipelines.exporters.metrics` | scrape targets or a metric inventory came back |
| Fallback backends (nothing evidenced any backend) | `telemetry.backends.metrics-prom` / `logs-elastic` / `traces-jaeger` | the topology names jaeger (traces-jaeger only); otherwise never — a product with evidence is minted under its own id instead and the fallback is not written |
| Per-service availability SLI/SLO guesses, `platform_availability` | `slis.<id>`, `slos.<id>` | never as guesses — SLIs inferred from real recorded rules are `Verified` (unless a feeding rule is unhealthy); an SLO bound by a discovered burn-rate group — exact id or re-identified — drops its scaffold marker and is `Verified` unless that group is fed by an unhealthy rule (then `Declared`) |
| Dashboard stub | `dashboards.platform-overview` | never (discovered dashboards replace it, each stamped `dashboards.<id>`) |
| SEV1 → Teams route | `alerting.routes[0]` | never (the routes of the running Alertmanager configuration replace it, each stamped `alerting.routes[<i>]`) |
| Baselines | `baselines` | never |
| Burn-rate placeholder | `policy.burn_rate_alerts[0]` | never (mapped rules replace it; so do entries read from alerting rules that guard a recorded SLO — those carry `mcp.derived.*`, not `mcp.verified.*`) |

`spec.baselines` is always the platform default for the declared criticality
(`measurement_source: platform-default`). Earlier builds derived
`mttd_target_p50` from the smallest `anomalies_baselines` `thresholdMs` — a
latency-anomaly threshold is not a time-to-detect target, so that derivation is
gone. `mcp.baselinesComputed` still counts the anomaly baselines the tool
returned: it is evidence the tool answered, **not** an MTTD measurement.

Known limitation: SLOs inferred from recorded rules carry a placeholder
objective (`0.99`) and window (`30d`) unless a discovered burn-rate group
binds them (exact id or re-identification, which also applies the rule's
`slo_objective` / `slo_window` evidence); the SLI is `Verified` (the recorded
series exist and evaluate), the SLO stays `Declared` — the rule evidences the
measurement, the objective is a guess until a burn-rate rule names it.

### On-wire liveness: scrape targets and rule health

Existing is not the same as working. The probes keep what the MCP reports
about whether each artefact is currently doing its job, and the fetcher
withholds `Verified` where it is not:

| Signal | Annotation | Effect on evidence |
|---|---|---|
| Every scrape target's `job`, `instance`, `health`, `lastScrape`, `lastError` (trimmed to 200 chars; at most 200 entries) | `mcp.observed.scrape_targets` (JSON) | none — the record |
| Scrape jobs with at least one target `up` (or of unknown health) | `mcp.discovered.scrape_jobs` | attest `telemetry.scrape` and `pipelines.exporters.metrics` |
| Scrape jobs whose **every** target is `down` | `mcp.discovered.scrape_jobs_down` | no stamp; when no job is up the metrics exporter falls back to its scaffold marker |
| Each recording rule's `health`, `lastError`, `lastEvaluation`, `evaluationTime` (at most 200) | `mcp.observed.recording_rules` (JSON) | none — the record |
| Recording rules whose reported `health` is not `ok` | `mcp.discovered.recording_rules_unhealthy` | no `mcp.verified.queries.recording_rules[<i>]` stamp for that index (the rule still lands in `spec.queries`, projected `Declared`); the group stamp `mcp.verified.queries.recording_rules` is kept only when at least one rule is healthy or carries no health |
| Each alerting rule's `state`, `health`, `lastError`, `lastEvaluation`, `activeAt` (at most 200) | `mcp.observed.alert_rules` (JSON) | none — the record |
| Alerting rules whose reported `health` is not `ok` | `mcp.discovered.alert_rules_unhealthy` | a burn-rate group fed by such a rule still maps but earns no `mcp.verified.policy.burn_rate_alerts[<i>]` stamp (projected `Declared`), and the SLO it bound is not stamped either; the requirement chain lists the rule with `verified: false` / `health: err` and does not let it close `missing_alert_evidence` |
| SLIs inferred from recorded rules of which at least one is unhealthy | `mcp.discovered.slis_unhealthy` | no `mcp.verified.slis.<id>` stamp (projected `Declared`) — an SLI whose total/ratio series are not being produced is not measuring anything |

Health the ruler did not report reads `null` in the observed arrays and is
**not** treated as unhealthy — only an explicit non-`ok` health withholds a
stamp. Older probe results that carried only job names still count as
(health-less) scrape evidence. The draft summary in the studio lists
`N scrape jobs down: …` and `N rules unhealthy: …` when either is non-empty.

Rule health is keyed by rule NAME with any-unhealthy-wins semantics: when the
ruler reports the same name from two groups (one evaluating, one failing) the
rule is unhealthy, so neither spec entry is stamped and the SLI inferred from
it stays `Declared`.

The requirement-chain comparison reads the same annotations a second time,
for the **per-node ladder** beside each node's scored status
(`docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md` §5b — additive, unscored): is
the artefact merely present, doing its job, or could the vantage not look at
all. Which annotation feeds which rung:

| Annotation | Node kind | Ladder reading |
|---|---|---|
| `mcp.observed.scrape_targets` (matched by `job`) | `scrape_job` | `healthy` when every target is `up` and `lastScrape` is within 2× the declared interval at the observation clock; `alive` when health is not reported, and when only SOME targets are down (`n/m targets down: <instances>` — a down target's `lastError` is not the job's); `present_unhealthy` when EVERY target is down (the fetcher's `scrape_jobs_down` rule); `present_stale` when the newest `lastScrape` is older than 2× the interval |
| `mcp.discovered.scrape_jobs_down` | `scrape_job` | `present_unhealthy` even when the job was withheld from Pack B (`declared_only` on the scored side) — on the wire beats absent |
| `mcp.observed.recording_rules` (by `name`) + `mcp.discovered.recording_rules_unhealthy` | `recording_rule` | the same rules on `health` / `lastError` / `lastEvaluation` against the declared interval |
| `mcp.observed.alert_rules` + `mcp.discovered.alert_rules_unhealthy` | `burn_rate` | linked by the observation's `labels` (`slo`, `burn_rate`, `window_short`, `window_long`) first, then by the compiler's `<slo>_burn_<factor>x_<short>_<long>` name convention on the SLO id (fractional factors accepted: `_burn_14_4x_` ↔ 14.4), narrowed to the declared windows — the `alert_rules_unhealthy` list is narrowed the same way and the detail names the matched / failing rule(s); judged stale against the longest linked `interval` when the entries carry one |
| `mcp.discovered.slis_unhealthy` | `sli` | `present_unhealthy`; otherwise `exists` ("liveness rides on its recording rules") |
| `mcp.versions.<product>` | `backend` | `alive` when the product answered its version probe |
| `mcp.probesFailed` / `mcp.probesUnsupported` (+ `mcp.probeErrors.<family>`) | a declared kind absent from Pack B | `unobserved` when the family that would carry the kind failed or is not exposed (`scrape_configs`, `recording_rules`, `alert_rules`, `metric_names`, `dashboards`; sli / slo need both `recording_rules` and `metric_names` gone) — the vantage could not look, never "absent" |
| `mcp.observedAt.<family>`, else `mcp.fetchStartedAt`, else `mcp.refreshedAt` | all | "now" for the staleness judgement — the instant the family answered, the fetch's own clock, or (older packs) the caller's refresh stamp, named in the detail only on that last fallback. No interval means `healthy` / `alive` only within a 1 h ceiling ("interval unknown; 1 h ceiling applied"), older reads `present_stale`; a timestamp more than 1 s past "now" reads `alive` with "timestamp <n>s in the future (clock skew); freshness not judged", never `healthy`; no clock at all means staleness is not judged ("no fetch timestamp on the wire (mcp.refreshedAt missing)" when the observation has a timestamp and the pack has none) |

A pack without any `mcp.` annotation reads `exists` for every present node
("no on-wire liveness"). A reported health of `unknown` stays
`present_unhealthy` (consistent with the fetcher's unhealthy lists), and
`ladderVerdict` ignores `live_only` nodes as the scored verdict does.
Nothing the ladder reads changes `integrity`, `verdict`, node `status` or
the grade; the switch is a proposal
(`docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md`).

### Burn-rate alerts are mapped, never synthesised

`spec.policy.burn_rate_alerts` is built only from the alerting rules the MCP
actually exposes. Rules emitted by the Observogram compiler carry the
`slo`, `burn_rate`, `window_short`, `window_long` and `severity` labels; any
other rule is recognised by the compiler's `<slo>_burn_<N>x_<short>_<long>`
name. Rules are grouped per SLO (identical windows deduplicated, short window
first) and each emitted entry is stamped `mcp.verified.policy.burn_rate_alerts[<i>]`.

- Groups are resolved in two passes. A group whose id exactly matches an
  inferred SLO binds it first and claims it. Only then does a group that
  merely shares an SLI base (inferred `svc_checkout_availability_99` vs.
  discovered `svc_checkout_availability_99_9`) re-identify a still-unclaimed
  placeholder to the discovered id — so with tiered SLOs on one SLI (`_99`
  and `_99_9`) the exact group keeps its SLO and the other is reported
  unmapped, never a dangling `slo` ref. Both paths replace the placeholder
  objective/window from the rule's `slo_objective` (`99.900%` → `0.999`) and
  `slo_window` annotations, drop the SLO's scaffold marker and stamp
  `mcp.verified.slos.<id>` — unless the group is fed by an unhealthy rule.
  A re-id is refused (group unmapped) when the discovered id is not a valid
  schema Slug (`^[a-z][a-z0-9_-]*[a-z0-9]$`, at most 64 chars).
- Forecast rules (`labels.kind=forecast`) are not burn-rate alerts; their
  names still surface in `mcp.discovered.alert_rule_names`.
- Every other alerting rule is read the way the repo crawler reads a rule
  file (`burnAlertsFromAlertRules`, tools/lib/sli-inference.mjs): a rule
  whose expression references a recorded series (`ns:metric:op`) guards that
  series' SLO and contributes its window (`for`, severity) to the SLO's
  entry; entries with fewer than two windows take the default pair; a rule
  that references no recorded series is an operational alert and no SLO
  contract — since spec 1.4 it is declared in `spec.alerting.rules` (below),
  not dropped. Hand-written rules carry neither the compiler's labels nor its
  names — without this a platform with seventy alerting rules read as having
  no burn-rate policy, and every alert its repository declares read "not
  live". Such an entry is real (no scaffold marker) and **not** `Verified`:
  the ruler attests an alert on the SLO's series, not a multi-window
  burn-rate alert. It names its rules in `mcp.derived.policy.burn_rate_alerts[<i>]`;
  `mcp.discovered.alert_rules_linked` / `alert_rules_operational` count the
  two kinds.
- A burn group for an SLO nobody inferred, or one with a single window (the
  schema requires two), is not representable and is listed in
  `mcp.discovered.alert_rules_unmapped` instead of being padded.
- **Operational rules are declared, not lost (spec 1.4 `alerting.rules`).**
  Every alerting rule the ruler reports that binds to no SLO is read with
  the same reading the crawler applies to a rule file
  (`sli-inference.mjs` `operationalAlertRule`): its exact `name` (the join
  key), `expr` (`query` on the wire), `for` as the canonical duration
  (`duration: 600` is `10m`), the pack's `severity` from `labels.severity`
  beside the engine's own word in `labels`, and `engine` from what the
  answering tool attests (the contract registry's `attests`: grafana,
  mimir, vmalert → victoriametrics; a plain Prometheus-API answer states
  none, which means prometheus). The repository's crawler declares the
  same rules from the rule files, so the two sides pair rule for rule by
  name in Compare — the engine is not compared (a rule file cannot tell a
  Prometheus ruler from a VictoriaMetrics one), the expression, wait,
  labels and severity are. Until 1.4 these rules were counted
  (`alert_rules_operational`) and carried nowhere, and a live Grafana
  snapshot matched zero alerts against the repository that provisioned them.
- A rule with no recognisable severity gets one from its burn factor
  (`>= 10x` SEV1, `>= 5x` SEV2, else SEV3) and is listed in
  `mcp.discovered.alert_rules_severity_inferred`.
- When nothing maps, the schema still forces one entry: a two-window
  placeholder on the first SLO, stamped `mcp.scaffold.policy.burn_rate_alerts[0]`
  and never `Verified`.

Dashboard search alone is not enough for diagnostic drift. The fetcher uses
`grafana_dashboards_search` to find dashboard UIDs, then calls
`grafana_dashboard_get` for each UID so Observogram captures panels, variables,
targets, and sanitized dashboard JSON.

### Backends are what runs, not what the MCP supports

`backend_capabilities` lists every product the MCP server can speak to —
five metrics stores side by side — and says nothing about which is deployed.
A backend is declared only on evidence the product runs here:

- a version it reported itself (`grafana_health`, a `*_build_info` series,
  `traces_services` answering);
- a scrape job for its own endpoint with a target up — job names resolve
  through `backendForScrapeJob` (tools/lib/backend-products.mjs, exact names
  only: `otel-mcp-server` is not the collector);
- a tool that belongs to the product answering with data — the registry's
  `attests` (`vmalert_rules` attests vmalert; the Alertmanager configuration
  answering attests Alertmanager).

Each is minted as `<signal>-<product>` with the product spelling and signal
the crawler gives the same product's container image (one shared table), so a
backend read live pairs with the one read from a repository. The inventory
still supplies an evidenced product's version policy (`min`, `gating`,
features) and is kept whole in `mcp.capabilities.*`. What it lists and
nothing attested is in `mcp.capabilities.unobserved`; what attested each
backend is in `mcp.backends.evidence`. With no evidence at all the
schema-forced fallbacks stand in as scaffolds, and the family is named
unobserved.

### Alerting routes: the running Alertmanager configuration

The `alerting_routes` probe reads the configuration a running Alertmanager
reports with its status (API v2 `/status` → `config`, as text or as
`{ original }`) and takes the routes out of it with the same reader the
crawler uses on a config file (`routesFromAlertmanagerConfig`,
tools/lib/alert-routes.mjs): the root route and its children, severities
mapped to `SEV1…SEV4`, receivers to channels. Alertmanager prints secret
addresses as `<secret>`; such a channel is kept with `redacted:secret` as its
value, which the diff reads as "address not stated", never as a different
address (docs/DIFF.md). Nothing else of the configuration text is kept — no
annotation carries it. A status answer WITHOUT a configuration (a tier that
trims it) is no answer for this probe: the family is `failed` with that
reason, not `empty`, because it is not "zero routes".

The status reading of the same tool (`mcp.observed.alertmanager`: version,
uptime, silences) stays a signal and stamps nothing.

### What the fetch could not look at

For every artefact family the fetch had no way to observe, the pack carries
`observogram.unobserved.<family>` = the reason. `<family>` is the behavioural
model's kind (tools/lib/artefact-model.mjs).

| Families | Named unobserved when | Reason |
|---|---|---|
| `otel`, `pipeline_receiver`, `pipeline_processor`, `pipeline_exporter_logs`, `pipeline_exporter_traces`, `storage_*`, `baselines`, `chaos`, `synthetic`, `remediation`, `derived_view`, `imports`, `forecast` | always | `no MCP tool exposes …` |
| `pipeline_exporter_metrics` | no scrape target and no metric inventory attested it | same |
| `dashboard`, `panel` · `burn_rate` · `metric` · `scrape_job` | the family's probe failed or is not offered | `the <family> probe got no answer: <its error>` / `this MCP offers no <family> tool` |
| `recording_rule`, `sli`, `slo` | no recorded series at all and the rules probe failed or is not offered | same |
| `alert_route` | the `alerting_routes` probe gave no routes | its failure, or that the status carries no configuration |
| `backend`, `profiling`, `network`, `policy_engine`, `mesh`, `collection` | nothing evidenced any backend | `no version probe, scrape target or product tool answered` |

A probe that ANSWERED — with data or with an honest zero — leaves its family
observed. `diffPacks` reads these keys: an artefact the other pack holds in an
unobserved family is reported **not checked** (`notObserved`), with the
reason, instead of "declared, not live" (docs/DIFF.md).

### One reading for the repository and for live

A repository scan and a live draft of the same system must describe it in
the same artefacts, or comparing them reports the difference between two
readers instead of the difference between declaration and production. What
both read, they read through one module:

| What | Module | Repository input | Live input |
|---|---|---|---|
| SLIs / SLOs | `sli-inference.mjs` `inferSlisFromRecordingRules` | rule files | the ruler's rule list — choices are made by rule NAME, never by arrival order |
| Burn-rate entries | `sli-inference.mjs` `burnAlertsFromAlertRules` | alerting rule files (`for: 2m`) | the ruler's alerting rules (`duration: 120`) |
| Operational alert rules (spec 1.4 `alerting.rules`) | `sli-inference.mjs` `operationalAlertRule` | the rules of a rule file or Grafana provisioning YAML that guard no SLO (`alert:` / `title:`, `expr` or `data[].model.expr`) | the ruler's alerting rules that bind to no SLO (`name`, `query`, `duration`) — paired by exact name |
| Routes | `alert-routes.mjs` `routesFromAlertmanagerConfig` | the Alertmanager config file (`${VAR}` → `unresolved:<VAR>`) | the running configuration (`<secret>` → `redacted:secret`) |
| Backends | `backend-products.mjs` | container images | scrape jobs, versions, product tools |
| Extended surfaces | `l2x.mjs` | the backends above | the backends above |

`tools/test-scan-live.mjs` holds the property end to end.

### Journeys read the vantage, and can gate on it

A saved journey (`tools/lib/journey.mjs`, `packc journey run`) whose Pack B is
an `mcp:` source reads the annotations above into its run record:

| Record field | Source annotations |
|---|---|
| `probes.attempted / succeeded / empty / failed / unsupported` | `mcp.probesAttempted`, `mcp.probesSucceeded`, `mcp.probesEmpty`, `mcp.probesFailed`, `mcp.probesUnsupported` (family names) |
| `probeErrors.<family>` | `mcp.probeErrors.<family>` |
| `vantage` | derived — `full` / `partial` / `restricted` / `lost` / `none` (same rule as `partialLiveEvidence`) |
| `toolsExposedCount` | `mcp.toolsExposedCount` (`null` when absent) |
| `scrapeJobsDown` | count of `mcp.discovered.scrape_jobs_down` |
| `unhealthyRules` | count of `mcp.discovered.recording_rules_unhealthy` + `mcp.discovered.alert_rules_unhealthy` |

A file-sourced Pack B carries none of these: the lists are empty, the counts
`0`, the vantage `none` — absence of evidence is reported as absence.

Two gate keys act on them:

```yaml
gate:
  failOnPartialEvidence: true   # breach when any probe family FAILED (a hole of unknown size),
                                # or when the vantage is entirely lost; EMPTY and UNSUPPORTED
                                # families never breach on their own
  maxUnhealthy: 0               # breach when scrapeJobsDown + unhealthyRules exceeds N
```

When the fetch itself fails (endpoint unreachable, core tools unavailable) the
journey writes a run record with `outcome: vantage-lost` and the error before
rethrowing — the CLI still exits `2`, the studio still answers 502 — so a total
loss of the observation point shows in the drift history instead of leaving a
gap. Configuration errors (missing pack file, unset `authEnv`) never reach the
wire and leave no record.

The journey grades on the same construct as the studio: the requirement-chain
comparison (`comparePackBranches`) is attached to the diff as
`traceabilityGraph` before `computeDiagnosticGrade`, and the record's
`grade.driftConstruct` says which construct scored Drift-free
(`requirement-chain` when declared commitments exist, else `diff-buckets`).

#### Run-history retention

Every run appends one JSON record under `runs/<journey>/` in the workspace;
the filename is the ISO start time, so lexical order is chronological order.
Continuity is the goal (a cron cadence of minutes is the intended use), so
the directory is bounded: after each write `writeRunRecord` prunes it to the
newest `OBSERVOGRAM_JOURNEY_RUN_RETENTION` files (`brandEnv`, legacy
`TOMOGRAPH_*` spelling honoured; default `1000`; `0` = unlimited; anything
that is not a non-negative integer falls back to the default). The policy is
the pure `pruneRunFiles(files, keep)` (returns the names to delete, oldest
first; only names of the run-record shape `JOURNEY_RUN_FILE_RE` —
`<ISO start time with : and . as ->.json` — are candidates or counted, so a
hand-dropped `notes.json` neither displaces a record nor is deleted) and the knob is read at
write time by `journeyRunRetention()`. A file that cannot be deleted is
recorded on the run as `historyError`, never thrown — the verdict already
exists. `readJourneyRuns(name, { limit })` is unchanged: newest first, at
most `limit` parsed.

#### Stack-health evidence on the run record (`stackEvidence`)

Next to the step-2 `stack` counts, each record keeps the samples the run saw
so the history is the time series (step 3). `stackEvidence` is `null` when
Pack B carries no `mcp.stack.status` (file-sourced, or a pre-step-2
refresh) — never an empty "healthy" panel — and otherwise:

| Field | Source | Notes |
|---|---|---|
| `status`, `reason` | `mcp.stack.status`, `mcp.stack.reason` | `not-attempted` keeps its reason (a restricted tier reads not-attempted, never absent) |
| `rows[]` | `mcp.observed.stack_metrics` (cap 64) | `{ id, family, product, value, unit, direction, outcome, hint, at, referenceSli, reason? }` — `expr` is dropped; `hint` is the contracts' display-only `displayHint` and `referenceSli` the table's reference-pack SLI, both looked up by `id` in `STACK_SELF_METRIC_PROBES`; a row the table no longer declares keeps `referenceSli: null` |
| `alertmanager` | `mcp.observed.alertmanager` | `{ version, clusterStatus, silencesActive, error }` or `null` when the surface was not advertised |
| `grafana` | `mcp.observed.grafana.datasources` / `.contact_points` / `.error` | `{ datasources, unhealthyDatasources: [names], contactPoints, error }` or `null`; only a health verdict of `error` is unhealthy (`unknown` was never checked) |

Malformed JSON in any of those annotations degrades to `rows: []` /
`null` for that surface — the status survives, nothing is fabricated. A row
outcome the contracts do not declare is kept verbatim (a missing one reads
`unknown`) — never relabelled as a probe failure nothing reported; it is
still never `data`. The `stack` gate key below is the only *gate* reader
(the history helpers, `GET /api/journeys` and the studio chips read the
record too, none of them as a verdict); a sample stays a signal, and a
breach is an early warning, not a verdict.

#### Gate key `stack`: thresholds on the samples

```yaml
gate:
  stack:
    requireSampled: true          # breach unless the panel was sampled AND a row answered data
    rows:                         # per row id of STACK_SELF_METRIC_PROBES (case-sensitive)
      scrape_success_ratio: { min: 0.9 }
      scrape_targets_down: { max: 0 }
      tsdb_active_series: { max: 2000000 }   # an `info` row may carry a threshold too
```

`loadJourneyDef` validates the block (`validateGateStack(stack, name)`):
an unknown row id throws `journey <name>: gate.stack.rows names unknown row
<id>; known rows: …`, `min` / `max` must be finite numbers when present, an
entry with neither is refused (nothing to check), `min > max` is refused,
and `requireSampled` must be a boolean. `POST /api/journeys/capture` runs
the same validation on a captured gate before saving (400 with the message),
so a capture never creates a journey that cannot load; a definition on disk
that fails to load is still listed by `GET /api/journeys` with `loadError`
(and by `packc journey list` as `definition does not load: …`) rather than
looking like a healthy never-run journey. The studio's capture default gate
stays `{ minAlignmentPct: 85 }`; the block is opt-in and every existing key
is unchanged.

`evaluateGate` reads `facts.stackEvidence` and breaches with the criteria
`stack` and `stack.<id>`:

| Condition | Criterion | Detail |
|---|---|---|
| `requireSampled` and `stackEvidence` is `null` (file-sourced B) | `stack` | `stack self-metrics not sampled (Pack B is not a live draft) — the vantage cannot prove stack health` |
| `requireSampled` and `status` is `not-attempted` | `stack` | `stack self-metrics not sampled (<reason>) — the vantage cannot prove stack health` |
| `requireSampled` and no row has outcome `data` | `stack` | `stack self-metrics not sampled (sampled, but no row answered with data) — …` |
| `rows.<id>` and the entry is not a finite band (a bound that is not a finite number, neither bound, `min > max`, not a mapping) — a gate object composed without `loadJourneyDef` | `stack.<id>` | `threshold invalid (<why>) — cannot be checked` |
| `rows.<id>` and the row's outcome is not `data` (or `data` with no number) | `stack.<id>` | `no sample for <id> (<outcome>[: reason]) — threshold cannot be checked` |
| `rows.<id>` and the row is absent from the record | `stack.<id>` | `no sample for <id> (no stack evidence)` for a file-sourced B; `no sample for <id> (not-attempted: <reason>)` on a not-attempted panel (the tier reason, so the breach reads as a tier limit, not a fetch hole); `no sample for <id> (not attempted by the sampler — call budget exhausted or row not observed)` on a sampled panel |
| `rows.<id>` and `value < min` or `value > max` | `stack.<id>` | `<id> = <value> <unit> outside [min … max] — point-in-time sample, not an SLO verdict`; when display rounding prints the value equal to the bound it broke (`0.0004/s` against `max: 0`) the raw number follows: `<id> = 0.000/s (raw 0.0004) per-second outside [-∞ … 0.000/s]` |

Honesty rules: thresholds compare numbers only and equality passes
(`< min` / `> max`); a file-sourced Pack B never breaches `stack.rows` unless
a threshold is declared — then it breaches with `no sample (no stack
evidence)` instead of passing by absence; nothing here touches the grade or
creates a `Verified` stamp. Values print through the pure
`formatStackValue(value, unit)` (`ratio` → `83.3%`, `per-second` →
`0.004/s`, `per-hour` → `0.0/h`, `seconds` → `7.4s`, `count` → `1`; a
non-number prints `—`), bounds in the same unit.

Surfaces: `renderJourneyMarkdown` adds a `Stack self-metrics — point-in-time
samples` table (`id | family | value unit | outcome | hint | reference SLI`,
capped at 24 rows, only when the run has rows) and lists stack breaches
with the others; `packc journey list` appends `stackStatusLine(record)` —
`stack sampled N` (rows that answered data), `stack not attempted`, or
`stack none` — to each line.

#### History helpers: the run history as a time series

`tools/lib/stack-evidence.mjs` is the browser-safe reader of that history
(pure functions, imports only the contracts table; the studio loads it
from `/lib/stack-evidence.mjs`, the server and a vendoring studio import
it directly — see `docs/VENDORING.md`):

| Helper | Returns | Honesty rule |
|---|---|---|
| `stackSeries(runs, rowId)` | oldest → newest `[{ at, value, outcome, hint }]` for one row (`runs` may be newest-first as `readJourneyRuns` returns them; sorted by `startedAt`) | a run without `stackEvidence` or without that row is a gap and is skipped, never interpolated; a non-data outcome is kept with `value: null` so the series shows when the probe stopped answering |
| `latestByFamily(record)` | `{ <family>: { id, value, unit, direction, outcome, hint, referenceSli, reason? } }` | per family the row that answered `data` (with a number) wins; among data rows the early-warning signal surfaces first — a `nonzero` hint, then a row the table declares before a retired one, then `lower` before `higher` / `info` — and the contracts table order breaks the rest, so a leading `higher` / `info` row (`scrape_success_ratio`, `tsdb_active_series`) never hides a lower-is-better row that carries signal; among non-answers the table order decides; `{}` without evidence |
| `stackSummary(record)` | `{ status, reason, sampled, families }` or `null` | `null` when the record has no `stackEvidence` — an absence, never a healthy stack; `sampled` counts rows that answered data |
| `nonzeroRuns(series)` | count of data samples with the display hint `nonzero` | a count of runs, not a verdict — "nonzero in N of the last M runs" is an early-warning phrase |
| `stackPostureBudget(series, { objective, cadenceMs, windowMs, isBad? })` | `{ samples, bad, fraction, allowance, measurable, note }` | the cadence heuristic: the window allows `(1 − objective) × window / cadence` bad samples and a sampled posture is only `measurable` when that allowance is ≥ 10 (99.99 % over 30 d at a 15 min cadence allows 0.29 — not measurable; 99 % over 7 d at 5 min allows 20.16 — measurable); `fraction = good / samples`, `null` with no data sample; the note says "signal, not verdict" in every branch |
| `formatStackValue(value, unit)`, `stackOutcomeLabel(outcome)` | the shared display vocabulary (`83.3%`, `0.004/s`, `0.0/h`, `7.4s`, `1`, `—`; `empty` / `probe failed` / `not in inventory` / `not attempted`) | one formatter for the CLI, the report and the studio |

Surfaces: `GET /api/journeys` puts `stackSummary(lastRun)` on
`lastRun.stack` (`null` for a file-sourced B); the studio's Journeys view
renders a `stack self-metrics — point-in-time samples` line under each
card — one chip per family (value in its unit, or the honest non-answer),
the `nonzero` hint as a muted marker, the row id and reference SLI in the
chip's title, and for lower-is-comfortable rows `nonzero in N of last M
runs` over the 20 fetched runs; a `not-attempted` panel is one muted chip
with the reason; a `sampled` panel where no row answered is one muted
`sampled, but no row answered` chip. No chip carries an ok/error colour: a
sample is a signal, and the runs table lists `stack` / `stack.<id>`
breaches like any other. The families are always taken from the newest
fetched run — an older run's evidence never stands in for a last run that
carried none (vantage lost, file-sourced B), so a file-vs-file journey
renders no stack line at all. The view loads the helper module at call
time from the server's `/lib` mount; a host that does not mount
`tools/lib` at `/lib` still renders the chips from `lastRun.stack`
(families only: no `nonzero in N of last M runs` history, and values print
as raw numbers — a ratio reads `0.95`, not `95.0%` — because the formatter
lives in the helper module). A card whose definition fails to load shows
`definition does not load: <loadError>` under its meta line.

#### Requirement chains on the run record (`branches`, `chains`, `versions`)

Step 4 keeps, per run, what the requirement-chain comparison saw — the
scored verdict and the on-wire ladder verdict per chain, and the nodes worth
recording with their blast radius — so the history can say what changed and
a snapshot of Pack B can be kept for the runs that explain a change. The
helpers live in the zero-import `tools/lib/chain-history.mjs` (vendorable,
`docs/VENDORING.md`); the runner writes the fields right after
`traceability`:

| Field | Shape | Notes |
|---|---|---|
| `branches[]` | `{ rootKey, title, rootKind, verdict, ladderVerdict, integrityPct, ladderIntegrityPct, confidence, missingRoles: [names], degraded: [node], truncated? }` — `branchRecordsFromGraph(diff.traceabilityGraph)` | one per chain in the graph's order; `[]` when the graph has none. `verdict` / `integrityPct` / node `status` are copied from the graph verbatim; the ladder fields ride beside them, unscored |
| `branches[].degraded[]` | `{ key, kind, label, status, ladder: { rung, status, detail } \| null, blastRadius: { slos, alerts, panels, dashboards, routes, remediations, total } \| null, deltaFields: [field], aId, bId }` | only nodes whose scored status is `declared_only` / `drifted` / `live_only` or whose ladder status is `present_unhealthy` / `present_stale` / `unobserved`; aligned-and-healthy nodes and `unverifiable` ones (an honest blind spot of the vantage, not a degradation) are not recorded. Worst first: absent, present-but-unhealthy, present-but-stale, drifted, unobserved (reported after the wire's own findings), live-only; ties by blast-radius total then label. `blastRadius` is structural exposure — what WOULD go blind if the node died — never a claim that it is blind. `aId` / `bId` are the adapter's artefact ids on each side (`QRY-01`, `DASH-02`, …; `null` when the side has no artefact) so a deploy item naming an artefact by id matches exactly on the persisted record |
| caps | 64 branches × 16 nodes × 6 delta fields (`BRANCH_RECORD_CAPS`) | a cut node list sets `truncated: true` on the branch; a cut branch list marks the in-memory array only (JSON drops it — a persisted record of exactly 64 branches may have been cut) |
| `chains` | `{ declaredTotal, intact, partial, broken, undeclared, ladder: { healthy, degraded, broken, unobserved }, integrityPct, ladderIntegrityPct, degradedNodes, undeclaredNodes, topExposure: { label, kind, slos, alerts } \| null }` — `chainSummary({ branches })` | counts over the declared chains; the integrities are means of the recorded per-branch percentages and `null` with no declared chain (an empty set is not 100 % healthy); `degradedNodes` counts the recorded nodes of the DECLARED chains and `topExposure` is the one of them that would blind the most SLOs (then alerts, then total), `null` when none would blind an SLO or an alert; the live-only nodes of undeclared chains are inventory, not degraded assurance — counted apart as `undeclaredNodes`, never the top exposure. `GET /api/journeys` recomputes it from the record with the same function |
| `versions` | `{ <product>: <version> }` or `null` — `liveVersions(canonicalB)` | the bare `mcp.versions.<product>` keys only (the provenance keys `mcp.versions.<product>.source` / `.commit` are not versions); `null` for a file-sourced B or when no version probe answered — an absence, never "unchanged" |

The markdown report prints a `Requirement chains` table (`chain | verdict
| ladder | integrity | ladder integrity | worst node`, capped at 24 rows,
the worst node being the first of the branch's degraded list with its ladder
detail and `blinds N SLOs`) only when the record carries chains — no table
means none were declared or recorded, never that every chain is intact.

#### Live-pack snapshots (`keepLivePack`, `livePack`)

A run can keep Pack B's canonical JSON beside its record, so a transition in
the history can be re-read against the pack it was observed on. The
definition key decides:

```yaml
keepLivePack: transitions   # transitions (default) · always · never
```

`loadJourneyDef` refuses any other value (`keepLivePack must be one of
transitions, always, never`). The pure, exported `livePackDecision({ policy,
previousRun, transition, outcome, packBIsFile, packBSource })` is applied in
this order — the first rule that fires names the reason on the record:

| Rule | `kept` | `reason` |
|---|---|---|
| Pack B is a file | `false` | `Pack B is a file (<source>)` — the file is the snapshot, whatever the policy |
| `never` | `false` | `keepLivePack: never` |
| `always` | `true` | `keepLivePack: always` |
| no previous record | `true` | `first run (no previous record)` |
| the previous record lost its vantage | `true` | `previous run <startedAt> lost its vantage` |
| the previous record carries no chains (pre-chain record) | `true` | `previous run <startedAt> carries no chain record to compare` — a snapshot nobody can compare against is cheaper than a transition nobody can explain |
| `transition.any` | `true` | `chains changed since <startedAt>: N changed · N appeared · N disappeared` |
| `outcome` is `gate-failed` | `true` | `gate failed` |
| otherwise | `false` | `no transition since <startedAt>` |

An unknown policy value reaching the decision reads as the default. A kept
run writes `runs/<journey>/live/<record stem>.json` (the record's own
filename stem — `LIVE_PACK_PATH_RE`) and records `livePack: { kept: true,
path: 'live/<stem>.json', bytes, reason }`; a run that keeps nothing records
`{ kept: false, path: null, reason }`. A snapshot write failure lands on the
record as `historyError`, never thrown — the verdict already exists — and
`livePack` then reads `{ kept: false, path: null, reason: 'snapshot write
failed: <error>' }`, never the policy that asked for the snapshot. `never`
writes none from now on; snapshots earlier runs kept stay until their
records age out of retention.
`readLivePack(name, record)` parses a snapshot back and is `null` when the
record kept none, `livePack.path` is not the snapshot shape (a hand-edited
path cannot point outside the journey's `live/` directory), or the file is
gone or unparseable — a pruned snapshot reads as absent, never as an error.

Retention is unchanged (`OBSERVOGRAM_JOURNEY_RUN_RETENTION`,
`JOURNEY_RUN_FILE_RE`; `readJourneyRuns` reads only run-shaped files — a
stray `notes.json` is never a record — and still ignores `live/`) and now
also prunes retention victims: after the record prune,
`pruneLiveSnapshots(recordFiles, liveFiles)` (pure) names the run-shaped
files under `live/` that are OLDER than the oldest surviving record — never
a survivor's snapshot, never a file that is not of the run-record shape, and
never a newer stem that merely has no record yet (a cron run and a `POST
/api/journeys/:name/run` can interleave; one writer's just-written snapshot
must not be the other's orphan; with no surviving record nothing is named)
— and `writeRunRecord` deletes them, noting a failure as `historyError`. A
journey that never kept a snapshot has no `live/` directory at all.

#### Transitions and candidate causes (`transition`, `causes`)

The run reads its history *before* it is written (so the diff is against
history, never against itself) and picks two records from it: the
**previous run** — the newest record whatever it holds — and the
**baseline** — the newest record that CARRIES chains (`BASELINE_SCAN_LIMIT`
= 25 records back; a vantage-lost record or one written before chains were
recorded cannot be diffed). The chain diff, the versions and the deploy
window are compared against the baseline; the vantage against the previous
run. `transition` is `diffRunBranches(baseline, { branches })` plus what
the run knows about the choice, and is never `null` on a new record:

```
transition: {
  reason: null,                       // a comparison was made
  since: <baseline startedAt>,
  changed: [{ rootKey, title,
              from: { verdict, ladderVerdict }, to: { verdict, ladderVerdict },
              direction: 'worse' | 'better' | 'changed',
              nodes: { newlyDegraded: [labels], recovered: [labels] },
              note: string | null }], // declared-side facts, see below
  appeared: [rootKey], disappeared: [rootKey],
  any: boolean,
  skipped: [{ startedAt, outcome }]   // records newer than the baseline that carry no chains (cap 8)
}
// or, when nothing could be compared:
transition: { reason: 'first run' | 'previous run lost its vantage' | 'previous runs carry no chain record',
              since: null, changed: [], appeared: [], disappeared: [], any: false, skipped: [...] }
```

A chain is `changed` when its verdict or ladder verdict differs; `direction`
comes from the rank tables `intact < partial < broken` and `healthy <
degraded < unobserved < broken` — `worse` when nothing improved and
something got worse, `better` the mirror, `changed` when the two moved
against each other or either side is `undeclared` / unknown. `note` names
what the declared side says about the change when no recorded node moved:
`declared side: missingRoles none → action` (a role the branch misses came
or went) and / or `degraded list truncated (cap 16) — a node that moved may
be unrecorded` (a list cut at the cap on either side). Records written
before this pass carry `transition: null` on their first run; every reader
tolerates both. A transition is a change between two point-in-time
observations, never a cause.

`causes` is `rankCauses({ previous, baseline, current, deploys })` without
the ranker's own copy of the diff (`transition` above is the single
persisted copy) whenever a previous record exists — `null` on the first
run, nothing to explain yet:

```
causes: {
  causes: [{ rank, kind, score, evidence, chains: [titles], rootKeys: [rootKey], nodes: [labels] }],
  vantage: { changed, from, to, detail } | null,
  note: 'candidate causes ranked by evidence — not a root-cause verdict'
} | null
```

Only chains whose transition reads `worse` (and chains that appeared already
partial / broken / degraded) are considered, and only the nodes the record
can say moved — new on the current side, or the same identity with a
different status / ladder status. A node whose status and ladder status are
identical on both sides did not move and is never blamed: when nothing
recorded moved, the change is on the declared side (the transition entry's
`note` says so) and the chain yields no cause. A node the vantage could not
look at (`unobserved`) generates no cause: a chain whose only movement is
the vantage looking away yields none. The four kinds and their fixed scores
(`CAUSE_SCORES`; a rank is explainable by reading the table):

| `kind` | Evidence | `score` |
|---|---|---|
| `observogram-deploy` | a deploy in the window `(baseline.startedAt, current.startedAt]` from `deploys.jsonl` beside `runs/` (Observogram's own audit — only the trailing 8 MB are read, `DEPLOY_LOG_TAIL_BYTES`, the cut first line dropped; the latest `verify` line is merged onto its deploy so the evidence names the outcome; a baseline whose start time cannot be parsed gives an EMPTY window, never all of history) whose item names a moved node. The server persists compile SELECTORS on its items, so `runJourney` resolves each one against Pack A first (`resolveDeployArtifact`: `declared:<i>` → the i-th declared recording rule's name, `slo:<id>` → the SLO id, its SLI base and the SLI the pack binds it to, `dash:<id>` → the id, a bare name — a rollback's dashboard uid — → itself, `all` → nothing; carried as `resolved` beside `artifact`); the ranker then matches EXACTLY, never by substring — the selector or a resolved name equals the node's `aId` / `bId`, or a resolved name equals the node's label or an identity handle of its `kind::{json}` key (`id`, `name`, `record`, `slo`, `job`, `uid`) — and only when the item's `group` can write the node's kind (`DEPLOY_GROUP_KINDS`: `dashboards` / `restore` / `delete` → dashboard, panel; `rules` → recording_rule, burn_rate, sli, slo; `alerts` → burn_rate, alert_route; `alertmanager` → alert_route; `pipelines` → pipeline_*, otel; an unknown or missing group constrains nothing). Evidence: `touched declared:0 → payment:api_availability:ratio_5m` (a bare name that is the label reads as itself; `(failed)` marks an item that failed) | 0.9 |
| `observogram-deploy` | a deploy in the window that wrote the journey's pack without an item naming a moved node — including a deploy whose only items are the group wildcard `all` (`wrote pack X (all rules) — no item names a moved artefact`). Needs the audit line's `pack.id` (the registry id — the pack FILE's stem) or `pack.name` to equal the record's `packA.name` (`metadata.name`) or `packA.id`: for a crawl-sourced Pack A, or a file whose stem differs from its `metadata.name`, this rung never fires | 0.6 |
| `config-drift` | a moved node that `drifted` on a decision-bearing field (`objective`, `expr`, `route`, `window`, … — the graph's vocabulary, copied so the module stays zero-import) | 0.8 |
| `config-drift` | drifted on cosmetic fields only, or on fields the record did not keep | 0.4 |
| `backend-version` | a product both records (baseline and current) reported with a different `versions.<product>`, when that product FEEDS the family of a moved node — `PRODUCT_FAMILIES`: prometheus / victoriametrics / thanos / mimir → scrape, ruler, tsdb; grafana → dashboards; alertmanager → notify; otel, otelcol → collector; loki, promtail → logs; jaeger, tempo → traces — crossed with `FAMILY_FOR_KIND` (`versionFeedsMovedKind`; a Grafana change on a Prometheus rule is not this rung) | 0.6 |
| `backend-version` | the same version change while a chain got worse elsewhere, or a product outside the table | 0.3 |
| `stack-self-metric` | a `stackEvidence` row of the current record that answered data and reads as a signal by direction and value alone (a `lower` row above 0, a `higher` ratio below 1 — the stored display hint is never consulted) in the family feeding a moved node's kind — scrape → `scrape_job`; ruler → `recording_rule` / `burn_rate` / `sli` / `slo`; notify → `alert_route`; tsdb → `backend` / `storage_metrics`; collector → `pipeline_*` / `otel`; dashboards → `panel` / `dashboard`; synthetic → `synthetic` | 0.5 |

A version that appears or disappears between the records is a vantage
matter, not a change — and so is a flip to or from the literal `live` (the
fetcher's word for "the product answered without a version number"): it
is never a cause and rides in `vantage.detail` as `mcp.versions.<product>
changed to/from live`. A `verify` record, a dry run or a line without
`type: 'deploy'` changed nothing on the wire and is skipped. One cause per
distinct evidence, aggregating every chain and node it explains; ordering
is score, then kind order, then evidence text — deterministic; every
evidence string collapses whitespace (labels, actor, deploy id, artifact
and product came off the wire or the request). `vantage` names what
changed about the vantage itself since the PREVIOUS run — `vantage lost →
restricted`, `probe family recording_rules newly failed (HTTP 502)` / `no
longer exposed` / `no longer probed` / `answers again` / `now exposed`,
`4 → 5 MCP tools exposed`, the `live` flips — and rides beside the causes,
never among them; `null` when neither record carries vantage facts (two
file-sourced runs) and no version flipped.

Surfaces: the markdown report's `Candidate causes — ranked by evidence, not
a root-cause verdict` section (`_no previous run_`, `_no chain got worse
since <baseline> (previous run <ts> lost its vantage — comparing against
<baseline>)_` when a record was skipped, `_previous run <ts> lost its
vantage — no earlier run carries chains to compare against — nothing to
rank_` when nothing could be compared, or `N. [kind] score — evidence
(chains: titles)`, then `vantage changed: …` / `vantage: unchanged`) and
`Transitions since previous run` (`_previous run <ts> lost its vantage —
comparing against <baseline>_` when a record was skipped, then one line per
changed chain with its direction, node lists and `note`, `appeared` /
`disappeared`, then the live-pack decision) — a run after an outage never
claims "no previous run", and every value either section interpolates goes
through `mdCell` (line breaks collapsed, `|` escaped, a line-leading `#` /
`-` / `*` / `+` / `>` / `1.` neutralised: a label carrying `\n\n### Gate
breaches` cannot forge a section; the gate-breach lines are escaped the
same way). `packc journey list` appends `chainStatusLine(record)` after the
stack segment (`chains 8/10 intact · ladder 7 healthy · 2 degraded`, zero
buckets omitted; `chains 0 declared` when the record carries chains but
declares none; `chains none (pre-step-4 record)` / `chains none (vantage
lost)` when it carries no `branches`), only when a chain got worse or a
cause was ranked `causeLine(record)` (`top cause: [kind] evidence` / `no
candidate causes`), and whenever the vantage block says it changed
`vantageLine(record)` (`vantage changed: <detail>`) — beside the cause,
never as one. `GET /api/journeys` puts on `lastRun`: `chains`
(`chainSummary`, `null` without chains), `transition: { any, changed, worse
} | null` (counts), `topCause` (the rank-1 cause object or `null`) and
`vantageChanged` (`true` / `false` / `null` without a causes block or with
`vantage: null`); `GET /api/journeys/:name/runs` hands the record through
unchanged. The studio's Journeys view prints one plain-text chains line per
card (`requirement chains: N/M intact · ladder: h healthy · d degraded · b
broken · u unobserved · top exposure: <label> (<kind>) blinds N SLOs`, then
`· N live-only in undeclared chains` only when `undeclaredNodes` > 0, a
muted `changed since previous run (W worse)` marker) and one cause line
(`candidate cause: [kind] evidence — not a verdict`, a muted `vantage
changed` marker) — counts and markers, no colours.

#### Reading a run record

Open `runs/<journey>/<stem>.json` (or `GET /api/journeys/<name>/runs`) and
read it top to bottom:

1. `outcome` and `gate.breaches` — did the run pass its own gate.
2. `traceability` — the scored chain rollup the grade used; `grade.score`
   and `grade.driftConstruct` say what scored it.
3. `branches[]` — per chain, `verdict` (scored: is the declared artefact in
   Pack B) beside `ladderVerdict` (on-wire: is it doing its job, or could the
   vantage not look). A chain that is `intact` and `degraded` is present but
   unhealthy or stale somewhere; `broken` and `unobserved` means the scored
   side blames production for what may be the instrument's blind spot.
4. `branches[].degraded[0]` — the worst node: its `status`, its `ladder.detail`
   in the fetcher's words (`health err, lastError "…"`, `probe family
   scrape_configs not exposed by this MCP tier`, `on the wire but withheld
   from Pack B: …`), and `blastRadius.slos` — how many SLOs would go blind if
   it really died. Exposure, not a claim that they are blind.
5. `transition` — what moved since `since` (the baseline: the newest earlier
   record that carries chains), per chain, with a direction, the nodes that
   newly degraded or recovered and a `note` when only the declared side
   moved; `skipped` names the records passed over to reach the baseline,
   `reason` says why nothing could be compared when that is the case.
6. `causes.causes[0]` — the top candidate with its evidence (its `chains`
   by title, `rootKeys` apart), and `causes.vantage` — read it before
   believing any cause: a chain that got worse while `vantage.changed` is
   `true` may only be the vantage looking elsewhere (a probe family gone, a
   version flipping to or from `live`).
7. `livePack` — whether Pack B was kept and why; `readLivePack(name, record)`
   returns it as it was observed.
8. `notify` — the delivery outcome of the run (`{ status: sent | skipped |
   failed, reason, triggers, httpStatus, attempts, tookMs, urlEnv, error }`),
   `null` when the definition has no `notify:` block. A record WITHOUT the key
   was written before delivery (a crash between the two writes, or a
   pre-step-5 runner) — readers print nothing for it, never "skipped".

#### Delegated scheduling (`schedule:`)

Scheduling is delegated, not built (docs/VALUE_BACKLOG.md item 11 — an
in-process timer was considered and not chosen): nothing in the server or
the runner fires a journey. The journey merely **declares** its cadence:

```yaml
schedule: "*/15 * * * *"                          # 5-field cron
# schedule: { cron: "0 */2 * * *", timezone: Europe/Madrid }
# schedule: { every: 15m }                        # <N>m | <N>h | <N>d
stackBudget: { objective: 0.99, window: 30d }     # optional, pairs with the cadence
```

`tools/lib/schedule.mjs` (browser-safe, served at `/lib`) parses it at load
time — a 4-field cron, an out-of-range field, an unknown sub-key or a
`15s` interval is a load-time configuration error (`journey <name>:
schedule must be a 5-field cron expression, { cron, timezone? } or { every:
<N>m|<N>h|<N>d } — … (got …)`; `journey list` prints it, `GET /api/journeys`
puts it in `loadError`, capture answers 400). A cadence (`cadenceMs`) is
derived only from a regular shape (`* * * * *`, `*/N`, `M */N`, `M H`,
`M H * * D`, `every:`); an irregular cron yields `cadenceMs: null` with the
note `irregular cron: cadence not derivable — posture budget not computed`,
and `every: 45m` keeps its cadence but yields `cron: null` (snippets print
its command as a comment) — nothing is ever guessed.

`packc journey schedule <name> [--format cron|schtasks|actions|k8s|all]
[--json]` prints the ready-made artefact for each scheduler from that block
(`tools/lib/schedule-snippets.mjs`): a crontab line (`CRON_TZ` when a
timezone is declared), a `schtasks /Create` command (exact shapes only —
anything else prints the DAILY form with `REM … translate by hand`), a
GitHub Actions workflow (history on a runner is per job, not a studio
workspace) and one Kubernetes CronJob wired to the workspace PVC of
`deploy/k8s/components/journeys`. Secrets appear only as env-var NAMES
(`export NAME=<set in your environment>`, `${{ secrets.NAME }}`,
`secretKeyRef`). Without a `schedule:` every snippet carries the literal
placeholder `*/15 * * * *`, marked `schedule: not set in <file> —
placeholder, edit before installing`, and stderr says so (exit 0).

`packc journey run --all` runs every saved journey in sequence in one
workspace (exit = the worst: 0 pass · 1 gate failed · 2 error, an
unloadable definition included); it is what the fleet CronJob runs. The
retention rule above still bounds the history, and the prune logic tolerates
a scheduled run interleaving with a `POST /api/journeys/:name/run` (two
writers never touch each other's just-written record or snapshot; two
fleets are kept apart by the CronJob's `concurrencyPolicy: Forbid`).

With a cadence and a `stackBudget`, the Journeys view prints one muted line
per gated stack row — `<row> posture over the last N runs: <b bad of n
sampled runs; the window allows x bad samples at this cadence — a sampled
posture, signal, not verdict>` — computed in the browser from the run
history with `stackPostureBudget` (see *History helpers*). Nothing enters
`gate`, `outcome` or any score.

#### Notify on transitions (`notify:`)

```yaml
notify:
  urlEnv: MY_JOURNEY_WEBHOOK_URL     # env var NAME holding the POST URL (required)
  authEnv: MY_JOURNEY_WEBHOOK_TOKEN  # optional → Authorization: Bearer <value>
  on: transitions                    # transitions (default) · breach · always
  format: json                       # json · text (one line + markdown body)
  timeoutMs: 5000                    # per attempt, clamped to [1000, 60000]; one retry
  studioUrl: https://studio.example  # optional non-secret literal → links in the payload
```

Secrets never live in a journey file: a literal `url:` / `token:` /
`headers:` is refused at load (`notify.url is not allowed — reference an env
var name with urlEnv (secrets never live in a journey file)`); the env vars
are resolved at RUN time only, and an unset one refuses to run exactly like
an unset `packB.mcp.authEnv` (exit 2, no record).

The decision is pure (`tools/lib/journey-notify.mjs`, browser-safe):
`always` posts every run; `breach` posts a gate-failed or vantage-lost run
and once when the breach clears; `transitions` (the default) posts when the
outcome changed, a chain got worse (`transition.changed[].direction ===
'worse'`), a new candidate cause appeared (kind + evidence not on the
previous run) or the vantage changed — a first run is a baseline, not a
transition (skipped; deliberately unlike `keepLivePack`, which snapshots
the first run), and a vantage-lost run after a vantage-lost run is skipped
(nobody is paged every 15 minutes for one outage).

The payload (`kind: observogram.journey`, `version: 1`) copies the record —
`transition`, `causes` (with its *not a root-cause verdict* note), `chains`,
trimmed `stack` rows, `grade`, `drift`, `gate.breaches`, `packs` with
`//user:pass@` redacted — plus `reason`, `triggers`, a one-line `text`
(`<journey>: <outcome> · <chain line> · <cause line> · <vantage line>`) and
`links` when `studioUrl` is set. It never carries a definition key, an env
value or a `historyError` path. The POST is bounded: one `AbortController`
per attempt, a second attempt only after a network error / timeout, a 429 or
a 5xx (any other 4xx is final), worst case 2 × `timeoutMs` + connect.

Order on disk: the record is written FIRST, then posted, then rewritten with
`notify` (same stem) — a record on disk before anything touches the wire.
The outcome never changes the exit code (a failed delivery on a passing run
still exits 0). `renderJourneyMarkdown` ends with `notify: sent (202) —
<reason>` / `notify: skipped — …` / `notify: failed after N attempts —
<error>`; `journey list` appends ` · notify <status>`; `GET /api/journeys`
carries `notify` as names (`{ urlEnv, authEnv, on, format }`) and
`lastRun.notify` as `{ status, httpStatus, reason }`; the Journeys view
prints `notify: sent (202) · <reason>`.

### Stack self-metrics (registry)

`tools/lib/contracts/stack-self-metrics.mjs` is the data-only alias table the
step-2 sampler reads to acquire the observability stack's *own* health
signals through `metrics_query`: 24 rows across nine families (`scrape`,
`ruler`, `notify`, `tsdb`, `collector`, `dashboards`, `synthetic`, `logs`,
`traces`), each with a plain-English `signal`, a `unit`, a display-only
`direction`, an optional `referenceSli` naming the reference-pack SLI whose
vocabulary it follows (`prometheus-reference/scrape_success_ratio`, …), an
ordered list of product `aliases` (`{ product, expr, requires, verified }` —
an alias is eligible only when every name in `requires` is in the metric
inventory; `verified` is the pinned product image whose real exposition
carried every required name and whose PromQL evaluated the `expr`, as
`<image:tag> <exposition|TSDB inventory|probe output> + PromQL, <date>`),
and a `source` naming the upstream documentation the metric names come from
plus the live evidence that confirmed them. The registry rows
`stack_self_metrics`, `alertmanager_status`, `alertmanager_silences`,
`grafana_datasources`, `grafana_datasource_health` and
`grafana_contact_points` carry the tool names; the response shapes
`instant-vector`, `status-object`, `silences`, `datasources`,
`health-object` and `contact-points` pin the critical fields against the
fixtures in `tools/fixtures/mcp/` — recordings from the Krystaline tiers
(public, and since 2026-09-08 the authenticated tier) where a tier answers,
hand-written `synthetic/` files where none can (see that directory's
README). Every sampled number is a
point-in-time **signal, never a verdict**: nothing in this table creates a
`Verified` stamp, an SLO verdict or a grade change, and on a restricted tier
the answer is "not attempted" with the reason.

Three known discrepancies, documented here; items 1 and 2 were fixed in the
reference pack on 2026-09-22 (`scrape_duration_p99` now reads
`max(quantile_over_time(0.99, scrape_duration_seconds[5m]))` and
`query_latency_p99` the `/api/v1/query*` handlers of
`prometheus_http_request_duration_seconds_bucket`, see
docs/catalogue-evidence/prometheus.md §10) while the rows keep the aliases
below: (1) the reference pack's `scrape_duration_p99` was written
over `scrape_duration_seconds_bucket`, but Prometheus exposes
`scrape_duration_seconds` as a per-target gauge with no histogram, so the
row `scrape_duration_max` samples `max(scrape_duration_seconds)` and points
at the reference SLI for vocabulary only; (2) the reference pack's
`query_latency_p99` was written over
`prometheus_engine_query_duration_seconds_bucket`, but Prometheus registers
`prometheus_engine_query_duration_seconds` as a **summary** (objectives 0.5 /
0.9 / 0.99, labels `slice` / `quantile`) with no `_bucket` series, so the
row `query_latency_p99` reads
`max(prometheus_engine_query_duration_seconds{slice="inner_eval",quantile="0.99"})`;
(3) the reference pack's `datasource_proxy_success_ratio` is written over
`grafana_datasource_request_total`, which Grafana 12.4.4 registers only on
the first datasource request — but that request is any rule evaluation, any
`/api/ds/query` (the path dashboards and Grafana-managed rules use) or any
legacy proxied query, so every Grafana with one dashboard or one rule has
it. The row `datasource_errors` reads the reference name
`grafana_datasource_request_total{code=~"5.."}` **first** (strict
`requires`) and keeps the pre-registered `grafana_proxy_response_status_total`
(present at startup with `code="500"` at 0) as the **fallback** for a
Grafana whose inventory lacks the reference name, because the proxy counter
observes only the legacy `/api/datasources/proxy/...` path: on 12.4.4 an
`/api/ds/query` increments `grafana_datasource_request_total` and leaves
every proxy counter untouched, and the sampler stops at the first alias
with data — the other order would read a systematically blind 0 on a
Grafana whose queries fail through `/api/ds/query`.

Rows that must read zero when healthy carry a **presence-guarded zero** —
`count(up == 0) or (count(up) * 0)` for the count rows
(`scrape_targets_down`, `synthetic_probe_failures`),
`sum(rate(m{code=~"5.."}[5m])) or (count(m) * 0)` for the Grafana 5xx rate
rows — so a healthy stack reads `0` rather than an empty vector while a
backend without the metric still reads `empty` (`or vector(0)` would
fabricate "0 down" where nothing is scraped); the ratio is
`sum(up) / count(up)` for the same reason. **Lazily-registered counters**
take the same guard one step further. The OpenTelemetry Collector creates
`otelcol_exporter_send_failed_<kind>` and `otelcol_receiver_refused_<kind>`
only when the first export / receive happens (0.115.1, observed
before/after a forced failure: registered together with `sent_<kind>` /
`accepted_<kind>`; 10 metric names at startup — a stable count — and 39 the
moment the three `send_failed_*` names register after one OTLP request per
kind, with more following as the dead exporter retries: 48 families some
minutes later) or, on 0.154.0, plausibly only on the first failure
(`send_failed_spans` absent while `sent_spans` is present on the public
tier, read-only — consistent with registration on the first failure; no
failure was forced there), so strict `requires` on the counter
would read `not-in-inventory` on a healthy collector forever. Those six
aliases therefore `require` the sibling that registers with or before the
counter (`otelcol_exporter_sent_<kind>`, `otelcol_receiver_accepted_<kind>`)
and end with `or (count(<sibling>) * 0)`: a collector that has exported
reads 0 failures unless the counter exists, a collector that never exported
that signal reads `not-in-inventory` (no evidence either way), and a renamed
counter on a future collector renames the sibling too, so the alias falls to
`not-in-inventory` instead of a false 0. Every other counter the table reads
is pre-registered at 0 by its product and keeps strict `requires`:
client_golang registers `prometheus_*`, `alertmanager_*`, `promtail_*` and
`jaeger_collector_*` at startup; VictoriaMetrics' own `metrics` library
registers `vm_*` at startup and vmalert's `*_rules_errors_total` per
**loaded** rule (per-rule label sets — a rule-less vmalert exposes none,
which is an honest `not-in-inventory`: no ruler work to observe). All are
present on the pinned stack's exposition; the live suite asserts
startup-vs-stimulus only for the collector and Grafana (the two services it
recreates), the other products' startup state was observed by hand once.

Names pinned against live exposition (2026-09-07, see "Live validation
tier" below): no `_total` suffix on any otelcol internal-telemetry name
(0.115.1 and 0.154.0 alike); `otelcol_processor_dropped_*` exist on no
current collector in either spelling (removed by the processorhelper
rework), so the former `collector_dropped_*` rows are now
`collector_refused_{metrics,spans,logs}` over the receiver counters — the
current-generation "the collector is losing telemetry" signal;
`collector_queue_saturation` takes the per-exporter max on both sides
(`queue_size` carries `data_type` and `queue_capacity` does not on 0.115.1,
both do on 0.154.0); vmalert's plural `vmalert_*_rules_errors_total`;
`jaeger_collector_spans_dropped_total` on Jaeger v1's admin port (a Jaeger
v2 is an otelcol distribution and answers through the collector rows, the
jaeger alias reading an honest `not-in-inventory` there). Resolvers:
`probeRows()`, `rowsForFamily(family)`, `eligibleAliases(row, inventory)`,
`productPreferenceOrder(row, seenProducts)`, `displayHint(row, value)`,
`bestOutcome(outcomes)`; integrity is pinned by `npm run test:stack`, the
live evidence by `npm run test:stack:live`.

### Stack self-metrics (sampling)

`sampleStackSelfMetrics(...)` in `tools/fetch-live-pack.mjs` walks the alias
table once per fetch, after the version probes (so the product preference
knows what is already seen). The policy:

- **Attempt only when `metrics_query` is available.** When `tools/list`
  answered, it must advertise the tool; a server with no `tools/list` at all
  (older servers) is attempted. Otherwise the panel is `not-attempted` with
  the reason `metrics_query not exposed by this MCP (restricted tier)` — every
  row carries that outcome, zero calls are made, nothing is "absent".
- **Inventory: evidence of presence, never of absence.** When the
  `metric_names` probe answered with data, its list is the inventory: an
  alias is eligible when *every* name in its `requires` is present, and
  eligible aliases are tried first — all of them, since the inventory is
  evidence they exist (no per-row cap on that path). A row with **no**
  eligible alias is `not-in-inventory` (no call; the reason names the
  inventory size and the required names) **only when the inventory is
  trusted**: `stackInventoryTrust(inventory)` trusts a list that carries `up`
  (present on every Prometheus-compatible backend). The `metric_names` tool
  has no completeness contract (no `limit`, no truncation marker; the
  recorded reference fixture is a 25-name subset without `up`), so an
  inventory without `up` — or an empty one — is treated as incomplete and
  gates nothing: those rows fall back to the bounded cascade and read
  `empty` / `failed` / `data` honestly, with `queried anyway` and the
  inventory size in the reason of an empty answer. Without an inventory at
  all (probe failed / empty / unsupported) every alias is eligible on the
  bounded cascade. The sampler result carries `inventory: { size, trusted,
  reason }` (not annotated) and the recorder prints the same verdict.
- **Product preference.** A row's eligible aliases are ordered `generic`
  first, then products already seen in `liveVersions` (build_info,
  `grafana_health`, `traces_services`) or in the `backend_capabilities`
  inventory, then the rest in declared order.
- **Bounded cascade.** Without a trusted inventory at most 2 calls per row,
  stopping at the first alias that returns data; an `empty` or `failed`
  answer falls through to the next alias and the last outcome is recorded.
- **Global budget.** 48 `metrics_query` calls per panel; rows beyond it are
  `not-attempted` with the reason `call budget exhausted`.
- **Every call goes through `quiet()`** under the family name
  `stack_self_metrics` (so `probeFailures.stack_self_metrics` keeps the first
  error); each row keeps its own last error as `reason`.
- **Parsing.** An instant vector in either envelope (`{ result }` or
  `{ data: { result } }`); the value is `Number(result[0].value[1])`. An empty
  array, a series without a sample, or `NaN` / `+Inf` / `-Inf` is `empty`
  (value `null`) — for every unit: a series-only answer is never counted as
  a value, because every `count` row is an aggregation returning one series
  and "1" would be a fabricated number; a non-vector answer is `failed` with
  the shape reason. The count rows' presence-guarded zero (registry section
  above) is what lets a healthy stack read `0` instead of `empty`.
- **Outcomes** are exactly `data | empty | failed | not-in-inventory |
  not-attempted` — a row is never "ok". No `Verified` stamp, no `Scaffold`
  marker, no grade input is produced by any of it; `displayHint(row, value)`
  (`nonzero` for a lower-is-better row above zero) is a display helper the
  server may compute, never something the pack stores.

The Alertmanager and Grafana status rows ride the same fetch
(`observeAlertmanager`, `observeGrafana`), each tool guarded by the
`tools/list` inventory when one exists and called through `quiet()`:
`alertmanager_status` → `{ version, uptime, clusterStatus }`;
`alertmanager_silences` → `{ active, total }`; `grafana_datasources` →
`[{ uid, name, type }]` then `grafana_datasource_health` per uid (at most 10,
called with `{ uid }`) → `health: ok | error | unknown` plus a message trimmed
to 200 chars (`unknown` means NOT CHECKED — the health tool is not
advertised, errored, or the datasource is beyond the cap — and is never
folded into "not unhealthy"); `grafana_contact_points` → a count and up to 32
names. Object payloads are located **envelope-first** (`locateObjectPayload`,
the same rule `validateResponseShape` applies): a Prometheus-API-style
`{ status: 'success', data: {...} }` wrapper is read from its inner document,
so a wrapped `{ status: 'ERROR' }` health verdict reads `error`, never `ok`.
Each observer returns `null` only when none of its tools is advertised (a
tier fact); an advertised tool that fails (HTTP error, timeout, bad shape)
yields a non-null result carrying `error` — annotated as
`mcp.observed.alertmanager.error` / `mcp.observed.grafana.error` — so the
surfaces say "probe failed", never "not exposed". Tools that answered join
`mcp.toolsCalled`; the sampler's tool joins only when at least one row
returned data or an honest empty. `hasToolsList` is whether the `tools/list`
RPC succeeded: a server advertising an empty list reads `not-attempted`
(tier), not a string of `tools/call` failures.

The table has four live evidence sources: the public Krystaline tier
(2026-09-07) and the authenticated Krystaline tier (2026-09-08,
`MCP_URL=https://www.krystaline.io/mcp` + `MCP_AUTH`) through this recorder,
the pinned stack of the real products through the live validation tier
below, and — for the Grafana-backed tools — that same stack fronted by a
local otel-mcp-server 1.8.0 ("Local MCP over the Docker stack" below);
re-record when a product version moves.
The authenticated tier answers the same metrics / vmalert / Alertmanager
surface as the public one (14 aliases `data` · 0 `failed` on the same
2,682-name inventory) but advertises **no Grafana-backed tools** — its
otel-mcp-server deployment carries no Grafana integration — which is why
the Grafana status fixtures come from the local stack.
`npm run record-fixtures`
(`tools/record-mcp-fixtures.mjs`, `MCP_URL` + optional `MCP_AUTH`) is the
verification path — it reuses the fetcher's client and the registry for
every tool name, never prints or stores the token, and by default only
**reports**: the `tools/list` surface with its drift against the registry,
the metric inventory, and for every alias of every row whether its
`requires` are all in the inventory plus the value read the way the sampler
reads it (`data <value>` / `empty` / `FAILED <reason>` /
`not-in-inventory (missing …)` / `not-attempted (restricted tier)`), then the
status tools. `-- --write` records the fixtures `tools/fixtures/mcp/README.md`
prescribes (the trimmed inventory that keeps every required name, the probe
payloads, one instant vector per family under `recorded-stack/`, the status
tools) and a recorded file takes precedence over its synthetic copy in the
shapes suite; the full inventory goes to the git-ignored
`.tmp-mcp-metric-names.json`. Afterwards: `node
tools/test-contract-shapes.mjs --update`, then `npm test`.

The annotation keys the sampler writes (`mcp.stack.*`,
`mcp.observed.stack_metrics`, `mcp.observed.alertmanager`,
`mcp.observed.grafana.*`) are listed once, in the annotation reference
above; they are written only when the fetch sampled — a caller that predates
step 2 writes none of them.

### Live validation tier

`docker/stack.compose.yaml` (`name: observogram-stack`; every port bound to
127.0.0.1, every image tag pinned, the port block disjoint from the validate
stack's) runs every product the table names: Prometheus v2.55.1 scraping all
of them plus a blackbox probe job, Alertmanager v0.27.0 with a dead webhook
receiver, VictoriaMetrics v1.113.0 scraping itself and a dead target, vmalert
v1.113.0, otel-collector-contrib 0.115.1 with a `debug` exporter beside an
OTLP exporter to a dead endpoint, Grafana 12.4.4 with a provisioned
Prometheus datasource and one always-firing alert rule, blackbox-exporter
v0.25.0, promtail 3.3.2 tailing a sample file into a dead Loki, and Jaeger
all-in-one 1.62.0 — deliberate faults so every failure counter exists and
moves on a fresh stack. `npm run test:stack:live` (`tools/test-stack-live.mjs`;
`:strict` turns the no-Docker skip into a failure; **not** part of
`npm test`) brings it up, recreates the collector and Grafana so neither
carries a previous run's stimulus (the collector's "at startup" name set is
then exact; Grafana's is snapshotted the moment its recreate returns, which
is "before the suite's stimulus" — the provisioned 10s rule is Grafana's
own first datasource request, so `grafana_datasource_request_total` /
`grafana_alerting_rule_*` can already be present on a slow start; reported,
never asserted), waits for every scrape job and for the rate windows, then
for **every alias of every row** asserts: (a) every `requires`
name is a metric family on the product's own exposition — `/metrics`, the
Prometheus TSDB name inventory for the scrape-synthesised `up` /
`scrape_duration_seconds` (which never appear on Prometheus' own
`/metrics`), the blackbox `/probe` output for `probe_success`, the vmalert
service for `vmalert_*`; (b) every lazily-registered counter the `expr`
reads beyond `requires` is present **after** the stimulus (one OTLP/HTTP
request per signal kind into the collector; one query through Grafana's
legacy datasource proxy and one through `/api/ds/query`, so both counter
paths are exercised) — that is what proves the counter's name; (c) the alias's
`verified` stamp names the compose image of the product it was checked on;
(d) the `expr` evaluates on the real Prometheus with no PromQL error, the
answer read through the fetcher's own `sampleFromInstantVector`. The
collector's and Grafana's name sets before and after the stimulus are
printed (the lazy-registration probe), and the ledger — alias |
product@version | exposition | query — goes to the git-ignored
`.tmp-stack-live-ledger.json`. The stack is left running (`docker compose
-f docker/stack.compose.yaml down -v` removes it); run one suite at a time —
two concurrent runs recreate the collector and Grafana under each other.
Note that `otel/opentelemetry-collector-contrib:0.115.1` self-reports
`service_version="0.115.0"` in `target_info` and on every `otelcol_*`
series; the `verified` stamps and the ledger's product@version use the
image tag.

Verification ledger, 2026-09-07 — 32 aliases: 32 ✓ exposition (lazy
counters included), 32 stamps matching their image, 32 `data` / 0 `empty` /
0 PromQL errors:

| product @ version | aliases verified |
|---|---|
| Prometheus `prom/prometheus:v2.55.1` | `scrape_success_ratio`, `scrape_targets_down` [generic], `scrape_duration_max` (TSDB inventory); `rule_evaluation_failures` [prometheus], `rule_evaluation_staleness`, `notification_errors` [prometheus], `notifications_sent` [prometheus], `tsdb_active_series` [prometheus], `tsdb_compaction_failures`, `wal_corruptions`, `query_latency_p99` |
| VictoriaMetrics `victoriametrics/victoria-metrics:v1.113.0` | `scrape_targets_down` [victoriametrics], `tsdb_active_series` [victoriametrics] |
| vmalert `victoriametrics/vmalert:v1.113.0` | `rule_evaluation_failures` [victoriametrics], `notification_errors` [victoriametrics] |
| Alertmanager `prom/alertmanager:v0.27.0` | `notification_errors` [alertmanager], `notifications_sent` [alertmanager], `active_silences` |
| OpenTelemetry Collector `otel/opentelemetry-collector-contrib:0.115.1` | `collector_export_failures_{metrics,spans,logs}`, `collector_refused_{metrics,spans,logs}` (six lazy counters, present after the stimulus), `collector_queue_saturation` |
| Grafana `grafana/grafana:12.4.4` | `rule_evaluation_failures` [grafana], `datasource_errors` (both aliases: the reference `grafana_datasource_request_total` first, the proxy-only counter as fallback), `grafana_http_errors` |
| blackbox-exporter `prom/blackbox-exporter:v0.25.0` | `synthetic_probe_failures` (probe output) |
| promtail `grafana/promtail:3.3.2` | `log_shipper_drops` |
| Jaeger `jaegertracing/all-in-one:1.62.0` | `trace_collector_drops` |

The public Krystaline tier (read-only:
`MCP_URL=https://www.krystaline.io/mcp/public npm run record-fixtures`) is
the second evidence source, at other versions (otel-collector 0.154.0,
Jaeger v2.18.0, Grafana 12.4.0, Alertmanager 0.27.0): after the correction it
reads 14 aliases `data` · 0 `empty` · 0 `failed` · 18 honest
`not-in-inventory` on its 2,682-name inventory (no Prometheus server, no
blackbox, vmalert not scraped, a traces-only collector, a v2 Jaeger), 13 of 24
rows with data. The authenticated tier (2026-09-08, `MCP_AUTH` bearer) is the
third: the same backends and the same alias outcomes, recorded into
`vmalert_rules.json`, `alertmanager_status.json` and `recorded-stack/`.

#### Local MCP over the Docker stack

The fourth evidence source (2026-09-08) is the same compose stack fronted
by a local **otel-mcp-server 1.8.0** — today the only place the
Grafana-backed tools answer (the public Krystaline tier answers `HTTP 401`
from Grafana, the authenticated tier does not advertise them). With the
stack up (`docker compose -f docker/stack.compose.yaml up -d --wait`),
start the server from a checkout of otel-mcp-server v1.8.0 with no MCP auth
keys — `PROMETHEUS_URL=http://127.0.0.1:18428 VMALERT_URL=http://127.0.0.1:18880
ALERTMANAGER_URL=http://127.0.0.1:19093 GRAFANA_URL=http://127.0.0.1:13030
GRAFANA_AUTH_BASIC=admin:admin node dist/index.js --http 3011` — then
`MCP_URL=http://127.0.0.1:3011/mcp npm run record-fixtures -- --write --out
.tmp-recorded-local`, review, and copy the files you keep into
`tools/fixtures/mcp/` (the README there lists the admin-seeded state:
datasources `VictoriaMetrics (stack)` and `Loki (absent)` → a service the
stack does not run, contact point `webhook-oncall`, dashboard `Orders
availability (stack validation)`). Two shape discoveries came out of it, and
the contracts and `observeGrafana` now read the real product:
`grafana_datasource_health` answers `{ datasource, health }`, where `health`
is `{ supported: true, status: 'OK' | 'ERROR', message, details }` when
Grafana's health endpoint answered 2xx and `{ supported: false, error: 'HTTP
400: Bad Request — <url>' }` when it did not — Grafana 12.4.4 answers a check
that ran and failed (backend unreachable) with `HTTP 400` and an unknown uid
with `500`, so the fetcher reads `supported: false` + `HTTP 400` as `error`
with the error text, any other `supported: false` as `unknown` (not checked,
never "not unhealthy"), and a `supported: true` answer without a status as
`unknown`; and `grafana_contact_points` answers the receivers API (`{ count,
contactPoints: [{ name, active, integrations }] }` — no `uid`, `type` or
`settings`), not the provisioning shape the synthetic fixture assumed. The
recorder keeps both datasource-health verdicts when several uids answer
(`grafana_datasource_health.json` is the first uid's answer, `.ok.json` /
`.error.json` the first answer of the other case).

### Stack self-metrics (surfaces)

The same annotations are read back, never re-sampled, on three surfaces:

- `POST /api/draft-from-mcp` — `summary.stack = { status, reason, sampled, empty, failed, notInInventory, notAttempted, families: { <family>: <best outcome> }, rows: [{ id, family, product, value, unit, direction, outcome, hint, reason? }] }` parsed from `mcp.stack.*` and `mcp.observed.stack_metrics`; `hint` is the contracts' display-only `displayHint` (`'nonzero'` when a lower-is-comfortable row is above zero, else `null`) and is computed here, never stored. `summary.alertmanager = { version, uptime, clusterStatus, silences, error }` and `summary.grafana = { datasources, healthChecked, contactPoints, error }` come from the `mcp.observed.*` JSON; each is `null` only when the surface was not advertised (or the fetcher predates step 2) — an advertised tool that failed keeps the summary with `error` set, and the server adds a `… status probe failed — <error>` warning. `healthChecked` counts the datasources that actually got a verdict; `health: 'unknown'` stays visible as "not checked". A `not-attempted` panel adds the warning `Stack self-metrics not attempted — metrics_query not exposed by this MCP tier.` (or `— <reason>.` for any other reason).
- `GET /api/live-status` — `stackStatus` (`sampled` | `not-attempted` | `null`) and `stackSampled` (number).
- The studio draft summary renders a "stack self-metrics — point-in-time sample, signal not verdict" block under the discovery rows: one row per family in `families` showing the family's best row (ratios as a percent, per-second to three decimals, seconds to one, counts as integers, `· nonzero` when hinted) or its outcome (`— empty`, `— probe failed: …`, `— not in inventory`; a family with no observed row reads `— not attempted: call budget exhausted`), a single `— not attempted: <summary.stack.reason>` row on a not-attempted panel, then `alertmanager: v<version> · N active silences` (`— probe failed: <error>` when advertised but failing), `datasources: N · M error: <names> · K unchecked: <names>` — or `N · health not checked (grafana_datasource_health not exposed or did not answer)` when no datasource got a verdict; `0 unhealthy`-style wording is never printed for a surface nothing checked — and `contact points: N`. `— not exposed` is reserved for a surface the MCP did not advertise.
- Journeys — `liveEvidenceFacts(canonicalB).stack = { status, reason, sampled, empty, failed, notAttempted }` (status `null` and zero counts for a file-sourced Pack B) rides on the run record as `stack` and prints one `Stack self-metrics` line in the markdown report; since step 3 the record also keeps the samples themselves as `stackEvidence` (see "Stack-health evidence on the run record" above), the report prints them as a table, and the opt-in `gate.stack` block (`requireSampled`, per-row `min` / `max`) breaches on them as an early warning — the counts are never gated on, and no breach is an SLO verdict.

## Diagnostic Drift Semantics

When Pack B is live-like, Diagnose treats the comparison as declared vs live:

| Bucket | Meaning |
|---|---|
| Aligned | Same artifact identity and same behavior. |
| Drifted | Same identity, different behavior. |
| Declared, not live | Pack A declares it, but Pack B did not confirm it. |
| Live, not declared | Production has it, but Pack A does not declare it. |
| Out of scope | Live platform inventory from families Pack A does not participate in. |

The Diagnostic Grade passes when the total score is greater than 85%. Drift is
still rendered as evidence and usually becomes the Remediate plan.

## Write Path: Deploy Through MCP

The Remediate deploy flow compiles selected pack artifacts and sends them to an
MCP write target. For Grafana, Observogram uses:

| Observogram artifact | MCP tool |
|---|---|
| Grafana-managed recording rules | `grafana_create_alert_rule` |
| Grafana-managed alerting rules | `grafana_create_alert_rule` |
| Grafana dashboards | `grafana_create_dashboard` |

Prometheus, Alertmanager, and OTel Collector compile outputs remain available
for download even when no write tool is configured.

## Required Server Configuration For Writes

Writes are intentionally explicit. The Grafana token belongs on the MCP server,
not in the browser.

```bash
MCP_ENABLE_WRITES=true
GRAFANA_URL=https://grafana.example.net
GRAFANA_AUTH_TOKEN=glsa_...
MCP_AUTH_KEYS='{"keys":[{"id":"observogram","key":"sk-observogram-prod"}]}'
```

The Observogram deploy modal receives the MCP client key, for example:

```text
sk-observogram-prod
```

Grafana permissions:

| Operation | Required permission |
|---|---|
| Managed rule write | `alert.provisioning:write` |
| Dashboard write | `dashboards:write` |
| Folder management | `folders:write` |

## Deploy Safety Rules

- Deploy only source-backed artifacts by default.
- Treat inferred artifacts as guidance unless the compiler materialized them
  from a source-backed contract.
- Prefer scoped deltas over full regeneration for dry runs.
- Re-run live generation after deploy and compare again.
- Never store Grafana service-account tokens in the browser or pack.

## Useful Endpoints

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/draft-from-mcp` | Generate and register a live pack from MCP |
| `GET` | `/api/packs/:id/compile-catalog` | Enumerate deployable compile items |
| `GET` | `/api/packs/:id/compile-artifact` | Compile one selected artifact |
| `POST` | `/api/packs/:id/deploy-bulk` | Deploy selected artifacts |
| `POST` | `/api/packs/:id/deploy/:target` | Deploy one compiled target |

## Offline Test

```bash
npm run test:fetch
```

The test suite exercises rich and partial MCP responses, validates the emitted
pack, checks verification markers, and confirms adapter integration.
