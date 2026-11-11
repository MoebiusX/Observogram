# In-page MCP server settings (rebadge batch 4)

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §16, keeping its section numbers.*

The MCP panel's **Server settings…** configures the MCP server behind it —
the backend base URL, user and secret it reads its backend with, and its own
API key — in a modal of the studio page. A downstream that ships a separate
configuration page (and the process that serves it) only to POST that
configuration can retire it. The contract an MCP server implements is in
[`MCP_INTEGRATION.md`](MCP_INTEGRATION.md), "Server settings (admin
configuration)"; the engine is `tools/lib/mcp-server-settings.mjs`, a listed
module, so the MCP server's own tooling can vendor the parser and the path
rule. Each change is its own CHANGELOG entry (`## Unreleased`, "Rebadge batch
4, D1–D4").

## 16.1 Retiring a sidecar configuration page

1. **Publish the description** at `<MCP server root>/admin/schema` — the MCP
   URL with its last segment dropped, so `http://127.0.0.1:9000/mcp` reads
   `http://127.0.0.1:9000/admin/schema` — as `application/json`, without
   credentials and without current values: `{ version: 1, endpoint, auth?,
   fields, actions? }`. A server without one gets the generic form (`url`,
   `user`, `secret`, `apiKey` to `/configure`, every field in the body),
   whose names, path and API-key placement the settings policy's `generic`
   block prefills (16.2).
2. **Authenticate the configure endpoint and every action** (a bearer the
   description names in `auth`, or a field the action sends). Without it,
   every studio user, every script on the studio's origin and every local
   process can repoint the MCP server at a backend of their choosing.
3. **Answer CORS for the studio's origin on every response** — the
   description, the configure and each action, errors and 401 included: an
   exact `Access-Control-Allow-Origin` and `Vary: Origin`, never `*` or `null`,
   never `Access-Control-Allow-Credentials`; the preflight allows `POST` and
   `content-type, authorization`.
4. **Check `Origin` and `Host`** on the configure POST (a present Origin must
   be a listed studio origin; the Host one of the server's own bind
   addresses — the DNS-rebinding guard for a loopback server), never redirect,
   never echo a submitted secret, validate the backend URL against the
   server's own SSRF policy, answer the outcome shape `{ ok, message, checks }`
   and audit the call.
5. **Let the studio reach it.** A loopback MCP server is configured from a
   studio page on the same machine (`http://127.0.0.1:<port>`); a remote one
   must be https and **listed**: `OBSERVOGRAM_MCP_ORIGINS` (or the org's
   `OBSERVOGRAM_ORG_<KEY>_MCP_ORIGINS`) on a server, `--mcp-origins` baked into
   a static bundle ([`DOWNSTREAM.md`](DOWNSTREAM.md) §10). Settings carry a credential, so they go only to
   loopback or a listed origin — never to the studio's own origin.
6. **Or turn on the pass-through** (16.3) where the browser cannot reach the
   MCP server.

Who opens it: whoever may register an MCP endpoint (`GET /api/mcp-endpoints`
`policy.register.allowed` — a session admin or owner, or the open posture's
caller on a direct loopback request). Anyone else sees the button
`aria-disabled` with the reason. On the browser-direct path the studio keeps
nothing and records nothing: no value reaches storage, a cookie, the
workspace, the store, a log, an audit row or a studio API body, and no studio
row records the configure — the MCP server audits its own. The studio's gate,
target checks and policy acknowledgements are affordances there; the MCP
server's checks (steps 2–4) are what enforce.

## 16.2 The settings policy

`OBSERVOGRAM_MCP_SETTINGS_POLICY=<path.json>` ([`DOWNSTREAM.md`](DOWNSTREAM.md) §9) — strict, read once at
start, served at `GET /api/mcp-settings`, baked into a bundle by
`--mcp-settings-policy`:

```json
{
  "version": 1,
  "rules": [
    { "when": { "field": "grafanaUrl", "pattern": "^(?!https://approved\\.)" },
      "warn": "Non-approved backend host.",
      "require": { "ack": "I have operator approval for this target" } }
  ],
  "generic": { "path": "/configure", "names": { "url": "grafanaUrl" }, "auth": "body" }
}
```

- **`when`** names a `field` or a `type` (`url`, `text`, `boolean` — a rule on
  `type: "url"` covers a generic form's URL whatever its name). A rule never
  names a secret. `pattern` is anchored (`^`), at most 200 characters, flags
  `""` or `"i"`, with no quantified group and at most one unbounded
  quantifier — checks of shape, made at start. No start-time probe can
  prove a pattern fast on every value, so none refuses one: the
  pass-through evaluates the policy in a worker with a 100 ms deadline per
  rule, counted from the rule's own start, and a rule that does not finish
  counts as matched, as do the rules after it (its warning shows, its
  acknowledgement is required, the server log names the rule and never the
  value); a worker that cannot start counts every rule as matched, and one
  that fails every rule it did not finish.
  A server started with V8 flags (`node --max-old-space-size=…`) starts the
  worker without any flags. The studio evaluates the policy in the page,
  where a slow pattern freezes only that admin's tab. Keep patterns simple:
  a slow one costs every sender its acknowledgement.
- **Matching.** A URL is matched as its normalised form (scheme and host
  lower-cased; a URL with a user or password before `@` is refused, not
  matched); a value is checked only when non-empty; a value over 512
  characters is itself a finding. A rule whose field the form does not have
  cannot run: it says so and still requires its acknowledgement.
- **`warn`** is shown in the modal; **`require.ack`** blocks the send until
  ticked. Acknowledgements are never remembered — closed and reopened, they
  are unticked. An action that sends no field the rule matched (`disable`)
  skips them; one that carries the matched field waits for the ack, as the
  pass-through does. Through the pass-through, a rule its re-check names
  (the 409 below) that the page's check did not flag — one the server could
  not check, or one it matched — gets its acknowledgement in the modal too,
  with a line saying which; an action that carries a field the rule checks
  waits for it as for the page's own (the page's own box, when its check
  flagged that rule on another field); ticked, the next send carries it,
  exactly what an API caller's `acks` attest, and an edit of any value
  but a secret takes it away (the page's check decides again; a secret,
  which no rule reads, keeps it).
- **`generic`** prefills the generic form's path, field names and API-key
  placement (`body` or `bearer`); the reader may change them per use and
  nothing is kept.

**How far it reaches.** The policy adds friction only: it can never enable a
control, lift a refusal or change a target. On the browser-direct path the
acknowledgement is advisory — a reader with the browser's developer tools or
curl skips it. The pass-through re-checks it against the description the
server reads itself. A downstream that needs the rule enforced enforces it in
the MCP server.

## 16.3 The pass-through

`OBSERVOGRAM_MCP_ADMIN_PROXY=1` (off by default, read per request) moves
every settings request of the modal to the studio server: `POST
/api/mcp-settings/describe` and `POST /api/mcp-settings/submit` (README "API
Surface"). Use it when the MCP server sends no CORS headers or listens where
the reader's browser cannot reach it. The contract:

- `admin` by class, the CSRF header in every posture, closed when exposed
  without sign-in, without sign-in only a direct loopback request; off, both
  answer `404 { denied: 'off' }`.
- The target is a registered endpoint or an admin's typed URL, as on every
  MCP route; the endpoint's read token is never sent and an `mcpAuth` is
  refused; `OBSERVOGRAM_ALLOW_LOCAL_MCP`, https unless loopback, never the
  studio's own address, and for a submit the origin allowlist.
- The paths are the server's: `<root>/admin/schema`, the endpoint the
  description declares (read again at submit), or the policy's
  `generic.path` (else `/configure`). The policy is re-checked (a missing
  acknowledgement is `409 { denied: 'policy-ack', rule }`, with
  `unevaluated: true` when the server could not check that rule — it did not
  finish, the worker could not start or failed, it cannot run on the form,
  or a value it checks is over 512 characters); the modal draws the named
  rule's acknowledgement (§16.2).
- One request with the platform's `fetch`, **never through the transport
  hook**: no redirect followed, 10 s, a capped read, exactly `Content-Type`,
  `Accept` and the description's own `Authorization`.
- **The outcome shape only** comes back: the description re-serialised, or
  the outcome's `ok`, `message` and `checks` redacted — never another body
  (an HTML 500 is named by status, media type and size). The request body is
  never logged, kept or echoed; a malformed one is a 400 that quotes none of
  it. One stderr line per upstream request with status codes only, and one
  `live.mcp-settings` audit row per submit (field names and acknowledged rule
  indexes, never a value).

A static bundle has no pass-through: both routes answer `501` naming
"Passing MCP server settings through the studio server" ([`DOWNSTREAM.md`](DOWNSTREAM.md) §10), and its modal
sends from the browser.

## 16.4 Follow-ups, by name

- *`malformed-json-app-wide`* — **done** (the follow-up that followed this
  batch): the parse error is answered as JSON on every route, closing the
  existing quote of a malformed `POST /api/mcp/ping` body (with its
  `mcpAuth`) in Express's error page and on stderr; this batch had fixed it
  on the two new routes only. Every body the app-wide parsers refuse is now
  `{ ok: false, error }` with a fixed text and the parser's status — `400 the
  request body is not valid JSON`, 413 too large, 415 an unsupported charset
  or encoding — no fragment of the body, nothing logged
  (`server/index.mjs` `bodyParserError`; `server/test-malformed-json.mjs`).
  The two pass-through routes keep their own parser and answers.
- *`settings-current-values`* — an authenticated read of the server's current
  non-secret values to prefill the form (version 1 reads no values).
- *`settings-policy-target-rules`* — rules on the MCP origin itself
  (`when: { target: … }`).
- *`settings-policy-url-part`* — URL rules on the host or the origin only
  (`when.part`).
- *`settings-browser-audit-note`* — a values-free studio note of a
  browser-direct configure, if wanted (the browser would assert it).
- *`settings-endpoint-path-column`* — a generic path per registered
  endpoint, if per-endpoint paths turn out to matter.
- *`settings-descriptor-v2`* — a richer field model (a choice list,
  validation patterns), as a new version.
