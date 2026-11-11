# A journey's notify hooks (follow-up journey-notify-env-ownership)

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §17, keeping its section numbers.*

A journey's `notify:` names the variables that hold its webhook's URL and
token. A journey the studio server runs now reads only its org's own
**notify hook** for them; the CLI keeps reading whatever names its invoker's
environment holds (17.3). Before, the server read whatever variable a
definition named and posted its value: any operator — or, on a server
without sign-in, anyone who could reach it — could have the server post
another org's MCP token, or one of the server's own secrets, to a URL of
their choosing. Every declared change is in one CHANGELOG entry
(`## Unreleased`, "Follow-up `journey-notify-env-ownership`"). The rule
lives in `server/notify-target-policy.mjs` (server code, not vendorable);
`tools/lib/journey.mjs` (excluded from the manifest) gains
`notifyTargetOf`, `scrubNotifyError` and `runJourney`'s `resolveNotify`
option, and `tools/lib/schedule-snippets.mjs` (listed) takes
`refusedEnvNames`.

## 17.1 The rule

**A hook.** A notify hook of org `<org>` is a pair of variables the
server's operator sets in the server's environment:
`OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL` and, optionally,
`OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_TOKEN`, sent as `Authorization:
Bearer <value>`. `<KEY>` is the org id in capitals with `-` as `_` (`pay-eu`
→ `PAY_EU`; the default org's is `DEFAULT` only when its id is `default` —
`npm run orgs -- list` prints the ids); `<HOOK>` is words of A–Z and 0–9
joined by single `_` (`ONCALL`, `PLATFORM_ALERTS`); the whole name is upper
case exactly and at most 200 characters. A journey names the hook by its URL
variable, `notify.urlEnv`; `notify.authEnv` is that same hook's `_TOKEN`, or
absent — a hook's token goes only to its own URL.

**Whose it is.** A variable `OBSERVOGRAM_ORG_<KEY>_…` belongs to the org
whose prefix is the longest match among every org, removed ones included
(the read-token rule of README "Services, Environments And MCP Endpoints").
A hook must be its org's **alone**: a name another org's id also maps onto —
an org whose id extends this one's (`acme-notify-eu` owns
`OBSERVOGRAM_ORG_ACME_NOTIFY_EU_*`; an `acme-notify` would own every
`OBSERVOGRAM_ORG_ACME_NOTIFY_*`), or a KEY tie (`a-b` and `a_b`) — is
refused for everyone, and the refusal names no other org. An org whose every
hook name another org's id takes (the tie, or an `acme-notify` beside
`acme`) can have no hook at all, whatever is set: its listing, every refusal
of its `notify` and its schedule snippets (17.3) say so, and that the way
out is to leave `notify` out. Org creation (`POST /api/admin/orgs`, `npm run
orgs -- create`) refuses an id that would take another org's hooks, whose
own hooks another org already takes, or that differs from another org's id
only in `-` and `_` (409, naming the other org to the owner who creates it);
the orgs-file import is not guarded, and the start's report names each set
hook variable such a pair shadows.

**What a server run reads.** At most those two variables — never another
org's, never one of the server's own (`OBSERVOGRAM_API_TOKEN`,
`OBSERVOGRAM_SESSION_SECRET`, …), never one outside `OBSERVOGRAM_ORG_`,
never the org's MCP token, never `packB.mcp.authEnv`. The names are judged
before any variable is read, so a refused name gets the same sentence
whether its variable is set or not. Then the values: the URL must be http(s),
without `user:password`, at most 2000 characters; the token, once its
surrounding spaces, tabs and line breaks are trimmed, printable ASCII without
spaces (a webhook that needs Basic auth is not supported).

| Variable | Read by | When unset |
|---|---|---|
| `OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL` | the start's report, the hooks listing, capture, and a server run of a journey of org `<KEY>` that names it | not listed; capture and a run refuse it |
| `OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_TOKEN` | the same, for a journey that names it as `notify.authEnv` | listed with `tokenEnv: null`; a journey that names it is refused |
| `OBSERVOGRAM_NOTIFY_ORIGINS` (`TOMOGRAPH_NOTIFY_ORIGINS` honoured) | every org's hooks, at each check | with the org's unset too, only loopback is posted to |
| `OBSERVOGRAM_ORG_<KEY>_NOTIFY_ORIGINS` | org `<KEY>`'s hooks, at each check, when the org owns the name alone | the deployment's list alone applies |

**The notify origin allowlist.** The two lists are unioned and read at each
check. Loopback (`localhost`, `127.0.0.0/8`, `[::1]`) always passes. With a
list set, a hook URL's origin must be in it (an entry `*` admits every
origin); a list without an accepted entry admits nothing. **With no list,
only loopback is posted to**: a webhook off this machine needs its origin
listed. Entries are origins, `scheme://host[:port]`, comma-separated; a
rejected entry is noted once on stderr by its position only —
`[notify-origins] OBSERVOGRAM_NOTIFY_ORIGINS: entry 2 is a URL, not an origin
— list only its scheme://host[:port]` — never echoed, because a pasted
webhook URL carries its secret. It is a separate list from the MCP one
(`OBSERVOGRAM_MCP_ORIGINS`): an MCP origin is a host the server sends a read
token to, a webhook origin a data sink, and listing one never opens the
other. An `http:` origin carries the URL's secret and the token in clear:
list one only for a relay on a path you trust. The list compares the URL's
origin as a name — a guard against a typo and a confused deputy, not a
network policy: `*`, or a listed name whose DNS someone else controls,
reaches whatever address the name resolves to, link-local and metadata
addresses included. An address policy belongs to the deployment's egress
controls (a Kubernetes NetworkPolicy on the studio pod).

**The request.** One bounded POST with the platform's `fetch` — never through
the MCP transport hook, with no cookie and no MCP token. A 3xx is a failed
delivery with its status and is never followed.

**The list a journey chooses from.** `GET /api/journeys/notify-hooks`
(every member of the org; no audit row) answers `{ ok, org, pattern, hooks:
[{ hook, urlEnv, tokenEnv, usable, problem }], none }`: every set hook URL
variable the org owns alone, sorted by hook; `tokenEnv` the hook's token
variable when that is set, else `null`; `usable`, or the `problem` capture
would answer; `pattern` the org's exact prefix; `none`, when there is no
hook, the sentence saying who sets one — or, for an org whose every hook
name another org's id takes, `no notify hook can be set for org '<org>' —
another org's id also maps onto every OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL
by the longest-prefix rule, so the server posts no notification for this
org's journeys: whoever holds the workspace leaves notify out of them`.
Never a value, an origin, an origin-list entry or another org's name. No
role types a webhook URL in the app — a literal `url:` stays refused for
every role, admins included; a journey names one of the hooks the server's
operator registered, as an `mcpEndpointId` names a registered MCP endpoint.
The static bundle answers the route with its 501 "Journeys", as every
`/api/journeys` path.

**The start's report** (stderr, beside the store's warnings; nothing at all
when no hook-shaped variable is set) — variables and org ids only:

- `[notify-hooks] org '<org>': <urlEnv> — <problem>` — a set hook a run
  would refuse (its value or origin);
- `[notify-hooks] <name> has the shape of org '<org>''s notify hook, but org
  '<other>' also maps onto it by the longest-prefix rule — no journey can use
  it` — never for a name that is another org's own hook
  (`OBSERVOGRAM_ORG_PAY_NOTIFY_NOTIFY_X_URL` has `pay`'s shape too, but it is
  `pay-notify`'s hook `X`);
- `[notify-hooks] <name> is no org's notify hook (no org's id maps onto it)`
  — `(only a removed org's id maps onto it)` when that is so.

**Capture.** `POST /api/journeys/capture` with a `notify` that is not one of
the org's set, usable hooks answers 400 with the capture sentence and writes
no file and no row. The studio's capture sends no `notify`. A captured file
is parsed before it is written and must read back as exactly what was
validated (`journey <name>: the definition does not read back as written
(<key>) — nothing was saved`, 400, the earlier file untouched): a pack
label's line breaks stay inside one banner comment line.

**A run.** `POST /api/journeys/:name/run` of a journey with `notify`
resolves its hook **before anything runs**, after the Pack B target: a
refusal is 400 `journey <name> is not run: …`, with no record, no row and
nothing sent — a refused studio run never becomes the CronJob's next
baseline. Without sign-in (`OBSERVOGRAM_AUTH=off`, or
`OBSERVOGRAM_INSECURE_NO_AUTH=1` beyond loopback) such a run is answered
only to a request sent straight to a loopback address, and never on a server
bound beyond loopback: 403 `posture`, the live MCP API's rule and sentences
(`… — open the studio at http://127.0.0.1:<port>`; `… restart it without
OBSERVOGRAM_AUTH=off and sign in as an owner, or bind it to loopback`). A
journey without `notify` runs as before. `GET /api/journeys` carries the
run's refusal as `notify.problem` for a journey a run would refuse, and the
Neuron view prints it, the run's `journey <name> is not run: ` replaced by
its own lead (`The server will not run this journey as it stands: …`) where
it said "Set up", and after the newest record's delivery for a journey that
has run. For an org whose every hook name another org's id takes it carries
`notifyUnavailable`, the listing's `none`, which the studio says where it
would name a hook to add.

**The sentences.** Each names what to fix and who fixes it — the server's
operator for the environment, with the restart a running server needs;
whoever holds the workspace for the journey file — and never a value, an
origin or another org. Below, `<P>` is the org's prefix
`OBSERVOGRAM_ORG_<KEY>_`, `<T>` the hook's `_TOKEN` variable, `<J>` the
journey's file relative to the workspace, in the org's root:
`journeys/<file>.journey.yaml` for an org whose root is `.`, and
`orgs/<id>/journeys/<file>.journey.yaml` for any other — `<file>` the name
the journey is listed and run by, which its `name:` need not match — and
`<L>` `GET /api/journeys/notify-hooks`. Every run sentence starts
`journey <name> is not run: `, `<name>` the journey's `name:`.

| Case | At capture | On a run (after the prefix) |
|---|---|---|
| a name that is not the org's hook | `notify.urlEnv "<name>" is not a notify hook of org '<org>' — the server posts a journey's notification only to <P>NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from <P>NOTIFY_<HOOK>_TOKEN: name one that <L> lists` | `its notify.urlEnv "<name>" is not a notify hook of org '<org>' — the server posts only to <P>NOTIFY_<HOOK>_URL (<HOOK>: words of A–Z and 0–9 joined by single _), with its token, if any, from <P>NOTIFY_<HOOK>_TOKEN; whoever holds the workspace sets notify.urlEnv in <J> to one that <L> lists (packc journey run reads any name from its own environment)` |
| shadowed | `notify.urlEnv "<name>" has the shape of a notify hook of org '<org>', but another org's id also maps onto it by the longest-prefix rule, so it is not this org's — name one that <L> lists` | `its notify.urlEnv "<name>" has the shape of a notify hook of org '<org>', but another org's id also maps onto it by the longest-prefix rule — whoever holds the workspace sets notify.urlEnv in <J> to one that <L> lists` |
| any name, where another org's id takes every one of the org's hook names (a KEY tie; `<org>-notify` beside `<org>`) | `notify.urlEnv "<name>" cannot be a notify hook of org '<org>' — another org's id also maps onto every <P>NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys: leave notify out` | `its notify.urlEnv "<name>" cannot be a notify hook of org '<org>' — another org's id also maps onto every <P>NOTIFY_<HOOK>_URL by the longest-prefix rule, so the server posts no notification for this org's journeys; whoever holds the workspace removes notify from <J> (packc journey run reads any name from its own environment)` |
| another token | `notify.authEnv "<name>" is not the token of the hook notify.urlEnv names — a hook's token goes only to its own URL: name <T>, or leave authEnv out` | `its notify.authEnv "<name>" is not the token of the hook its urlEnv names — a hook's token goes only to its own URL: whoever holds the workspace sets notify.authEnv in <J> to <T>, or removes it` |
| the URL unset | `notify.urlEnv <urlEnv> is not set in the server's environment — name one that <L> lists, or the server's operator sets it and restarts the server` | `its notify hook <urlEnv> is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace sets notify.urlEnv in <J> to one that <L> lists` |
| the token unset | `notify.authEnv <authEnv> is not set in the server's environment — leave authEnv out, or the server's operator sets it and restarts the server` | `its notify.authEnv <authEnv> is not set in the server's environment — the server's operator sets it and restarts the server, or whoever holds the workspace removes notify.authEnv from <J>` |
| the URL's value | `<urlEnv> does not hold an http(s) URL without user:password — the server's operator corrects its value and restarts the server (the server sends only Authorization: Bearer from <T>; a webhook that needs Basic auth is not supported)` | the same |
| the token's value | `<authEnv> holds a value the server cannot send as a bearer token (printable ASCII without spaces, once surrounding whitespace is trimmed) — the server's operator corrects it and restarts the server` | the same |
| off this machine, no list | `the webhook in <urlEnv> is not on this machine, and no notify origin is listed, so the server posts only to this machine — the server's operator lists that URL's origin (scheme://host[:port]) in OBSERVOGRAM_NOTIFY_ORIGINS or <P>NOTIFY_ORIGINS, comma-separated, and restarts the server` | the same |
| not on the list | `the webhook in <urlEnv> is at an origin that is not in <the list variables set, joined by ", nor in "> — the server's operator adds that URL's origin (scheme://host[:port]) there and restarts the server` | the same |

**What records and rows keep.** A delivery error never carries any part of
the hook's URL (as read, trimmed or normalised: its origin, host, port, path
and query), the address its host resolved to, or its token (as read,
trimmed, per line): `<redacted>`, on the CLI too. A failed lookup or
connection reads `getaddrinfo ENOTFOUND <redacted>`, `connect ECONNREFUSED
<redacted>`, `Connect Timeout Error (attempted address: <redacted>, timeout:
10000ms)` or `Hostname/IP does not match certificate's altnames:
<redacted>`. `GET /api/journeys/:name/runs` serves an older record's
`notify.error` with those four texts scrubbed, and undici's two that quote a
value (`Headers.append: "<redacted>" is an invalid header value.`, `Request
cannot be constructed from a URL that includes credentials: <redacted>`).
The audit rows name the hook only for a journey with `notify` —
`journey.capture` adds `notify: { urlEnv, authEnv }`, `journey.run` adds
`notify: { urlEnv, status, attempts }` — never any part of the URL; a
refused capture or run writes none.

**MCP read tokens.** An MCP endpoint's `readTokenEnv` may not name a
variable with the shape of any org's notify hook (URL or token, of a live or
a removed org): it is refused at registration and, for an endpoint
registered before, where the token is read, before it is read — 400
`observogram store: <name> has the shape of a notify hook's variable
(OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL or _TOKEN), which the server sends
only to its own webhook — name another variable of this org (for example
<P>MCP_TOKEN)` (`<P>MCP_READ_KEY` when `<P>MCP_TOKEN` is itself a hook's
token), followed at use by ` — PATCH /api/mcp-endpoints/<id> names another
variable`. A hook's variables go to its webhook and nowhere else.

**A host of its own.** A downstream that runs journeys for others with
`runJourney` passes `resolveNotify: (notify) => notifyTargetOf(notify, {
url, auth })` with the values it resolved under its own rule, so the engine
reads no variable a definition names; without it the engine reads
`process.env[notify.urlEnv]` and `process.env[notify.authEnv]`, as the CLI
does.

## 17.2 The migration

Rotate and scrub first: a journey that named another variable has already
posted its value every time it notified.

1. **Find every journey that notifies**, in every org's root, the ones only
   the CronJob runs included:
   `grep -nE 'urlEnv|authEnv' <workspace>/journeys/*.journey.yaml <workspace>/orgs/*/journeys/*.journey.yaml`
   (`npm run orgs -- list` prints each org's root: `.` is `<workspace>`
   itself, `orgs/<id>` is `<workspace>/orgs/<id>`). It also lists an
   `authEnv` under `packB:` — Pack B's MCP token (`packB.mcp.authEnv`),
   which a server run never reads: that name is outside this rule. Any
   `notify` name other than that org's
   `OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL` / `_TOKEN` needs steps 4–8; a
   name of the server's own (`OBSERVOGRAM_API_TOKEN`,
   `OBSERVOGRAM_SESSION_SECRET`, …), another org's
   (`OBSERVOGRAM_ORG_<other>_*`) or the platform's (`GITHUB_TOKEN`, a cloud
   credential) needs step 2 as well. The studio flags each such journey
   (`notify.problem` on `GET /api/journeys`, and the Neuron view's line).
2. **Rotate every secret so named.** A server run posted the variable's
   value — to whatever URL the definition paired it with, as the URL or as
   `Authorization: Bearer` — every time it notified. In each org's root,
   `grep -h '"urlEnv"' <root>/runs/*/*.json | sort | uniq -c` lists every
   `urlEnv` the records name, with how many records name it (`authEnv` is
   not on records; the definition file names it).
3. **Scrub the records that carry a leaked value:** `grep -lE
   'Headers\.append|cannot be constructed from a URL' <root>/runs/*/*.json`,
   then delete those records or blank their `notify.error`. The studio
   serves them scrubbed already, but the files stay on the volume and in any
   repository the workspace is committed to. A record whose error is a
   failed lookup or connection (`getaddrinfo ENOTFOUND <host>`, `connect
   ECONNREFUSED <address>:<port>`) names the webhook's host or the address it
   resolved to, which the studio serves scrubbed too: `grep -lE
   'getaddrinfo|connect E|Connect Timeout|Hostname/IP'
   <root>/runs/*/*.json` lists them (and any record whose live source failed
   the same way); treat their `notify.error` the same way where the host is
   the webhook's credential.
4. **Choose a hook name per webhook per org** (`ONCALL`, `PLATFORM_ALERTS`).
   An org id that equals `<another org's id>-notify` or starts with
   `<another org's id>-notify-` (with `-` or `_`, removed orgs included)
   takes that org's hooks: the start's report names each set hook such an
   id shadows, and org creation refuses new ones.
5. **Set the hook in the studio's environment** from a Secret, and restart:
   `OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL` (and `_TOKEN`). If the org's
   journeys also run through the CronJob, bind the same names there. Check the
   start's `[notify-hooks]` lines and `GET /api/journeys/notify-hooks`.
6. **List the webhook origins:**
   `OBSERVOGRAM_NOTIFY_ORIGINS=https://hooks.slack.com,…`, or per org
   `OBSERVOGRAM_ORG_<KEY>_NOTIFY_ORIGINS`. Loopback needs no listing.
7. **Rename `notify.urlEnv` and `notify.authEnv` in each journey file**
   (whoever holds the workspace). Re-capturing through `POST
   /api/journeys/capture` with the new `notify` also works, but it rebuilds
   the journey from the session's packs and the body alone (the scope,
   `gate`, `schedule`, `stackBudget` and `notify`): a `crawl:` source,
   `inventory:`, `keepLivePack` and comments are lost. The studio's Save
   writes no `notify` at all.
8. **Re-apply the CronJob** from the studio's schedule snippet for each
   renamed journey (Advanced → Neuron, the journey's Schedule block, or `GET
   /api/journeys/<name>/schedule`), then remove the old variables from the
   studio's environment and the CronJob's Secret.
9. **Check:** "Run now". It answers the verdict, or 400 naming what to fix.
   Without sign-in it answers 403 `posture` unless the request goes straight
   to a loopback address of a server bound to loopback; that sentence names
   what to change (17.1, "A run").

## 17.3 The CLI

`packc journey run` is unchanged: it reads any name a journey declares from
its own environment, an unset one is still exit 2 with no record, and its
texts are byte-identical but for the redaction above. Its environment is its
invoker's — a shell, a CI job's `secrets.*`, a CronJob's `secretKeyRef`
bindings — and it cannot know the org: it resolves only the root it is
given. The server is one process holding every org's variables and its own
secrets, running a file someone else may have captured; that confused
deputy is what the rule closes. CI and Actions journeys that name
`secrets.MY_HOOK_URL` keep working.

**The shared workspace.** The fleet CronJob runs the CLI against an org's
root on the volume the studio writes. Capture refuses any name but the
org's hooks, a captured file reads back as validated, and the studio's
schedule snippets never bind a name the server refuses: `GET
/api/journeys/:name/schedule` moves such a name from `envNames` to
`refusedEnvNames` (a key present only when non-empty), and each snippet
carries, where its binding would have been, `# <NAME> is not a notify hook
of this org: the studio never reads it — rename it to
OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL/_TOKEN before scheduling
(docs/DOWNSTREAM.md §17.2)` (after `REM ` in the schtasks command) — or,
for a `notify.authEnv` refused beside the org's own hook (any name but that
hook's `_TOKEN`), `# <NAME> is not the token of the hook <urlEnv> names: a hook's
token goes only to its own URL — set the journey's notify.authEnv to
<the hook's _TOKEN>, or remove it, before scheduling (docs/DOWNSTREAM.md
§17.2)` — or, for one of the org's hook tokens beside a refused
`notify.urlEnv`, `# <NAME> is the token of the hook <its hook's _URL> names,
not of the journey's notify.urlEnv: a hook's token goes only to its own URL —
set the journey's notify.urlEnv to <its hook's _URL>, or remove
notify.authEnv, before scheduling (docs/DOWNSTREAM.md §17.2)` — or, for
one of the org's hook tokens named as `notify.urlEnv` itself (alone, or as
`notify.authEnv` too), `# <NAME> is the token of the hook <its hook's _URL>
names, refused as the journey's notify.urlEnv: the studio posts only to a
hook's URL — set the journey's notify.urlEnv to <its hook's _URL>, and its
notify.authEnv to <NAME> or leave it out, before scheduling
(docs/DOWNSTREAM.md §17.2)` — or, for any name of an org whose every
hook name another org's id takes (17.1, "Whose it is"; no rename can reach
a hook there), `# <NAME>
cannot be a notify hook of this org: another org's id also maps onto every
name of its hook shape (OBSERVOGRAM_ORG_<KEY>_NOTIFY_<HOOK>_URL/_TOKEN) by
the longest-prefix rule, so the studio posts no notification for its
journeys — remove the journey's notify before scheduling (docs/DOWNSTREAM.md
§17.1)` — or, for a name of the org's hook shape, URL or token, that another
org's id also maps onto (17.1, "Whose it is"; it already has the shape a
rename would give), `# <NAME> has the shape of a notify hook of this org,
but another org's id also maps onto it by the longest-prefix rule, so the
studio never reads it — set the journey's notify.urlEnv to one that GET
/api/journeys/notify-hooks lists, and its notify.authEnv to that hook's
_TOKEN or leave it out, before scheduling (docs/DOWNSTREAM.md §17.2)`.
What remains is a file written before the upgrade or edited by
hand, run by a CronJob whose Secret holds whatever the file named — 17.2
finds those files and the secrets to rotate. `packc journey schedule` passes
no `refusedEnvNames` and binds every name the journey declares, as before.

## 17.4 Follow-ups, by name

- *`notify-hooks-picker`* — a studio control that sets a journey's
  `notify` from the listing (it needs a route that rewrites only `notify`).
- *`notify-hooks-store`* — hooks registered in the app (store rows naming
  the org's variables, or an admin-typed URL), if in-app registration is
  wanted.
- *`notify-deployment-hooks`* — hooks every org may use.
- *`journey-cli-notify-org`* — the rule on the CLI when an org is named
  (`--org`), which the k8s snippet would set.
- *`journey-run-live-posture`* — the live Pack B run and capture keep
  their posture for journeys without `notify`.
- *`journey-schedule-mcp-authenv`* — the schedule route still binds a
  hand-written `packB.mcp.authEnv` (capture never writes one); the CLI reads
  it.
- *`mcp-origins-rejected-entry-echo`* — the MCP origin list names a
  rejected entry verbatim on stderr; the notify list names positions only,
  and the MCP list should follow.
- *`journey-records-principal`* — journey records readable only by the
  member whose run wrote them (today every member of the org reads them, as
  dashboards).
