# Delivery report — rebadge batch 4 (in-page MCP server settings)

The short report the batch's acceptance asks for, per work item: what
shipped, the test counts, what is deferred and why. Rebadge batch 4
(`codex/rebadge-batch4`, stacked on rebadge batch 3) delivers four items —
D1 server-settings discovery, D2 the in-page modal and the opt-in
pass-through, D3 the settings-policy seam, D4 the mock MCP, the tests and the
docs — so that a downstream can configure its MCP server from the studio page
and retire a separate configuration page. Each item sits behind a documented
seam and is free of downstream vocabulary. This report is a reading aid over
the documents that carry the detail — `docs/CHANGELOG.md` (`## Unreleased`,
"Rebadge batch 4, D1–D4"), `docs/UPDATE_JOURNEY.md` ("Rebadge batch 4"),
`docs/MCP_INTEGRATION.md` ("Server settings (admin configuration)"),
`docs/DOWNSTREAM.md` §9, §10 and §16, and the README — and quotes nothing
those documents do not state. The totals below are the chain
`tools/test-doc-test-totals.mjs` guards: `npm test` on Linux, measured at
each commit, from 1250 at the head of rebadge batch 3 to 1353 at the head of
this branch.

## What the scout and the critique found

- **The studio server sends no CORS or CSP header**, so the page may call
  any origin; a browser-direct request is answered only if the MCP server
  sends CORS headers, preflight included. In the static bundle a request to
  another origin skips the shim.
- **The studio's fetch guard rejected any `fetch(` without `authHeaders()`**,
  which would have sent the studio's CSRF header and active org to a third
  origin. The exemption is now file-scoped: one call in
  `studio/mcp-settings-api.mjs`, pinned to `credentials: 'omit'`,
  `redirect: 'manual'` and `mode: 'cors'`.
- **Express quotes a malformed JSON body back**, in its HTML 400 and on
  stderr — for a settings request, a fragment holding the secret. Fixed on
  the two new routes only (M6 (b)); the rest is a named follow-up.
- **The connection test says `connected` even when its read failed**, so
  the modal reports the read's outcome, never the verdict alone.
- **The taxonomy's pattern guard bounds ids, not URLs**: a pattern it
  accepted took 1.27 s on a 2048-character URL. The settings policy adds a
  one-unbounded-quantifier rule and a timing run against URL-shaped values.
- **A loopback target from a remote page is the reader's own machine.** The
  browser's same-machine rule refuses it, with a way out per posture.
- **The fake MCP answered every path with a JSON-RPC 200.** Its admin
  surface routes paths, and the library names a JSON-RPC answer as "not a
  settings description".

## D1 — server-settings discovery

**Shipped.** The settings description, version 1, at `<MCP server
root>/admin/schema` — parsed and bounded by `tools/lib/mcp-server-settings.mjs`
(new, listed): `parseSettingsDescriptor`, the root and the strict path rule
(`settingsRoot`, `resolveSettingsPath`, re-checked after resolution),
`normaliseUrlValue`, `genericDescriptor`, `settingsRequest`, `outcomeOf` with
redaction by value in every form and by class, `compileSettingsPolicy` and
`policyFindings`. `compileBoundedPattern` (`tools/lib/artefact-classify.mjs`)
is the taxonomy's pattern rule as one export; `isLoopbackOrigin` moved to
`tools/lib/mcp-url-safety.mjs` with `mayBeThisMachine` (the server re-exports
the same function). Discovery is an HTTP GET, not a tool: the MCP tool
registry is unchanged (M9).

**Tests.** Tests: 1250 → 1253. Tests: 1253 → 1299.

**Deferred.** `settings-current-values`, `settings-descriptor-v2`.

## D3 — the settings-policy seam

**Shipped.** `OBSERVOGRAM_MCP_SETTINGS_POLICY` (both spellings): a strict
file read once at start (a byte-order mark stripped; an unreadable or invalid
file refuses the start), served at `GET /api/mcp-settings` with whether the
pass-through is on; baked into the static bundle by `--mcp-settings-policy`,
with `--mcp-origins` baking the MCP origin list the bundle's modal may send
to (M3). In the modal a matching rule — or one that cannot run on this form —
shows its warning and blocks the send until its acknowledgement is ticked;
nothing is remembered. The optional `generic` block prefills the generic
form (M4).

**Tests.** Tests: 1299 → 1307. Tests: 1307 → 1308. Tests: 1334 → 1335.

**Deferred.** `settings-policy-target-rules`, `settings-policy-url-part`.

## D2 — the in-page modal, and the opt-in pass-through

**Shipped.** The MCP panel's **Server settings…** (the one declared default
change: a button that asks nothing until clicked), enabled for whoever may
register an MCP endpoint (M1 (a)) and `aria-disabled` with its reason for
everyone else. The modal (`studio/mcp-settings-model.mjs`,
`studio/mcp-settings-api.mjs`, `studio/mcp-settings-view.mjs`, the `.mss-*`
zone) checks the target in the browser — `mcpUrlPolicy`, never the studio's
own origin, the same-machine rule, https unless loopback, a loopback or
listed origin (M2) — reads the description from the browser with no
credential, and sends the configure and each action from the browser
straight to the MCP server with no cookie and no studio header (M0); secret
inputs are emptied as soon as the request is sent and every input on close.
The outcome is shown as the server returned it, as text, after redaction;
after a verified configure the connection test runs and the modal reports the
read's outcome, then offers **Open the live panel** on the same target.

`OBSERVOGRAM_MCP_ADMIN_PROXY=1` (M5) moves every request to `POST
/api/mcp-settings/describe` and `/submit`: admin, the read token never sent,
`mcpAuth` refused, the origin allowlist for a submit, only the paths the
server read, the policy re-checked, the platform's `fetch` and never the
transport hook (M10), no redirect, the body never logged or kept, the outcome
shape only, one `live.mcp-settings` audit row of names and rule indexes (M7).
The static bundle answers both `501`.

**Tests.** Tests: 1308 → 1324. Tests: 1324 → 1334. Tests: 1335 → 1347.
Tests: 1347 → 1351.

**Deferred.** `malformed-json-app-wide`, `settings-browser-audit-note`,
`settings-endpoint-path-column`.

## D4 — the mock MCP, the tests and the docs

**Shipped.** `serve()` hands back the child's log (`logs()`, a verbose boot);
the fake MCP's `admin` surface (a description, configure and disable, CORS for
one origin, an API key in the header or the body, every admin request
recorded, off unless asked); the browser journeys and the acceptance flow:
configure → verify → snapshot with nothing but the studio page,
browser-direct and through the pass-through, then a reload, a sign-out and a
sign-in, and the secret scan — `localStorage`, `sessionStorage`, the cookies,
the DOM and every input, every request to the studio and its answer, the
audit, every file under the workspace (the store file and its `-wal`
included, as UTF-8 and UTF-16LE) and the server's log. Through the
pass-through the values are expected in exactly one place, the body of the
submit. The docs: MCP_INTEGRATION "Server settings (admin configuration)"
(the contract, what a server must do, what the studio cannot do, a minimal
server), DOWNSTREAM §9's row and §16, the README note on configuring the
server versus the studio's connection to it, the UI_CONVENTIONS zone.

**Tests.** Tests: 1351 → 1353.

## Mutation checks

Run during the build and the review; each change, made alone, failed the named test.

| Mutation | Fails |
|---|---|
| A module-level copy of the sent values restored when the modal opens | `server/test-mcp-settings-studio.mjs` BROWSER 12 (the modal reopened on the same page holds the values) |
| The sent values written to `localStorage` | BROWSER 12 and BROWSER 13 (storage) |
| The pass-through writing its request body to stderr | BROWSER 13 (the studio server's output) |
| Secret inputs not emptied once the request is sent | BROWSER 1 (the inputs while the outcome shows) |
| The pass-through's own parse-error handler removed | `server/test-mcp-settings.mjs`, the malformed-body case |
| The endpoint's read token resolved and sent with the description read | `server/test-mcp-settings.mjs`, the describe-by-id and described-submit cases (the headers recorded upstream) |
| `credentials: 'include'` in `directRequest` | `server/test-authz.mjs`, the fetch-exemption guard; also BROWSER 1–5, 8, 9, 10 and 12 (the fake MCP's CORS answer grants no credentials, so the browser refuses every answer) |
| One `textContent` in the view's node helper swapped for `innerHTML` | `server/test-authz.mjs`, the no-`innerHTML` guard; BROWSER 10 |
| The path character class widened (`%`, `;`, `:` admitted) | `tools/test-mcp-server-settings.mjs`, the path rule under a loopback root and under a path-prefixed https root |
| Redaction after parse dropped (the parsed body walked without the secret's forms) | `tools/test-mcp-server-settings.mjs`, the after-parse case (`\u0022`, `\u00e9`, `\/`) |
| Redaction dropped entirely | `tools/test-mcp-server-settings.mjs`, four redaction cases; `server/test-mcp-settings.mjs`, the no-upstream-text case (the echoed secret); BROWSER 3 |
| The document Escape handler's yield to the open modal removed (`if (mssOpen()) return`, `studio/app.mjs`) | BROWSER 9 (Escape on `<body>` closes the panel too) |
| The outside-click handler's `isConnected` test removed | BROWSER 9 (a click on the scrim, which the repaint removes, closes the panel too) |
| The browser following redirects (`redirect: 'follow'`) | `server/test-authz.mjs`, the fetch-exemption guard; BROWSER 8 (the redirect's sink) |
| The pass-through following redirects | `server/test-mcp-settings.mjs`, the redirect case (the sink receives nothing) |
| The pass-through's acknowledgement check removed | `server/test-mcp-settings.mjs`, the settings-policy re-check case (the 409) |
| The pass-through building a described submit from the caller's `generic` block instead of the description it read again | `server/test-mcp-settings.mjs`, the described-submit case (the description's endpoint, not the caller's path) |
| The pass-through's upstream request sent through the transport hook (M10) | `server/test-mcp-settings.mjs`, the transport-hook case |
| The line after the connection test mirroring the ping's `status` instead of its read's outcome | `tools/test-mcp-settings-model.mjs`, the after-the-connection-test case; BROWSER 1, 4 and 12 |

Dropping the path re-check in `resolveSettingsPath` (the same origin, under
the root, no userinfo, search or hash) fails no test: every path the shape
rule admits — letters, digits, `-`, `_`, `.`, `~` and `/`, no `.` or `..`
segment — resolves under the root, so no input reaches the re-check. It is
a second line behind the shape rule, as the widened-class row shows.

Resolving the read token (`forWrite: false`) without attaching it fails no
test: the pass-through builds its upstream headers itself and never reads
the resolved token, so `forWrite` is a second line, not the one the tests
pin.

## Open security items

- **The browser-direct path trusts the MCP server (M0).** A settings request
  the browser sends meets none of the studio server's authorization, origin
  allowlist, no-redirect client or audit. The studio's role gate, target
  checks and policy acknowledgements are affordances; an MCP server whose
  configure endpoint skips authentication makes every studio user, every
  script on the studio's origin and every local process its admin, able to
  point it at a backend of their choosing. MCP_INTEGRATION's "What your
  server must do" is normative for that reason.
- **The policy acknowledgement is advisory on the browser-direct path.** A
  reader with developer tools or curl skips it; the pass-through re-checks
  it; a downstream that needs enforcement enforces it in the MCP server.
- **`malformed-json-app-wide`** (pre-existing): every route but the two new
  ones still answers a malformed JSON body with Express's HTML page, which
  quotes a fragment of it (a `POST /api/mcp/ping` `mcpAuth` included), and
  logs it.
