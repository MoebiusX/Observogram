# Observogram

*(formerly **Tomograph** — pre-rebrand env vars, headers, workspaces, and pack annotations keep working; see docs/CHANGELOG.md.)*

**Observogram is the observability compiler and diagnostic workspace for
ObservabilityPack spec v1.3.**

It answers one operational question:

> Is this service's observability diagnostic-grade?

Observogram checks that in two parts:

1. **Coverage** - are we observing the right signals for the service's
   observability goals and OLA?
2. **Trust** - do the declared signals, rules, dashboards, alerts, and response
   paths match what is active in production?

The workflow is intentionally simple:

```text
Discover -> Diagnose -> Remediate
```

Use a repo scan, a live MCP scan, or an uploaded pack to create an
ObservabilityPack. Compare the declared repo posture with the live production
posture. Then compile and deploy the delta through the platform tools.

In Observogram, the OLA is represented as an observability contract inside the
pack: criticality, SLOs, SLIs, telemetry bindings, rules, dashboards, alerts,
runbooks, and validation expectations. A repo-derived pack captures what the
service declares. A live MCP-derived pack captures what production verifies.
The gap between those two packs is the diagnostic finding.

The canonical specification lives at
[MoebiusX/otel-observability-pack](https://github.com/MoebiusX/otel-observability-pack).
A checksummed copy is vendored under
[`vendor/observability-pack-spec/v1.3/`](vendor/observability-pack-spec/v1.3/).

## Why It Exists

Most observability failures are not caused by a missing chart. They come from
drift:

- the repo declares an SLO, but the recording rule is not in production
- Grafana has dashboards that no pack owns
- alerts still exist, but their thresholds no longer match the SLO
- live telemetry exists, but no OLA or runbook says why it matters
- the team cannot explain whether the service is truly diagnosable

Observogram treats observability as a compiled contract. The pack is the source
of truth. Native artifacts are generated from it. Live systems are scanned back
into pack shape. The diff between declared and live is the operational truth.

## Main Journey

The first decision is about the pack, because a service may already exist without
one. Both landings open with **"What would you like to do?"** — *check an existing
service or pack* (select a service, or import one: upload, repo scan, live MCP draft)
or *build a new pack* (Define · Compile · Verify). The two paths join at *Pack
available in Discover*: a compiled pack enters the same audit journey as an imported
one, with its unresolved placeholders still visible.

### No pack yet? Build one

A second, parallel journey for a service that has no pack: **Build** — three
steps in the same visual language as the three below, reached from the home
hero, the service gate or the upload popover ("Build from the library…"), and
ending where Discover begins ([`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md)).
**The pack is the axis** of the screen on every step: a sticky **definition
column** on the left — the service, the tier as a segmented control (each
segment with its MUST · SHOULD counts), the library entries as chips, the
conformance summary (pass · on a placeholder · fail, the failing clauses,
todos and placeholders left) — and, as the main surface, **the layer stack of
the pack being compiled** — L1 Contract · L2 Telemetry · L3 Insight · L4 Action
(policy · alerting · self-healing) · L5 Validation · GOV — drawn through the
same adapter and the same artefact cards Discover uses, so what you build is
exactly what Discover shows afterwards. Each slab's edge carries the rubric's
verdict for that layer (green pass, amber pass on a placeholder, red fail —
naming the clause), a placeholder artefact is *Scaffold*, and a clause the tier
still needs is a ghost card on its slab. **Click a layer and its sheet opens**
over the stack with the layer's question, its clauses at the tier and what you
can add on that layer: the SLI rolodex and the SLOs switch on L1 (*What should
we measure?*), the scrape jobs, backends and endpoints on L2 (*Where does the
telemetry flow?*), the Dashboards switch and the boards on L3 (*How do we see
it?*), the burn policy, the routes with their channels and the remediation on
L4 (*What happens when it breaks?*), the probes and chaos experiments on L5
(*How do we prove it?*), the owners and imports on GOV (*Who owns it?*):

1. **Define - What Are We Observing?** — in the definition column: the service
   name, owners and environment, its criticality tier and one or more library
   entries: products it runs on (Kafka, Prometheus, Grafana, IBM MQ,
   Alertmanager, Loki, Tempo, the OTel Collector, every one with its evidence
   dot) or an archetype for a service built from scratch (HTTP service, queue
   consumer — OTel semconv). **The tier is a seed, not a constraint**: it decides
   which SLIs the pack starts with and which rubric grades it, never which SLIs
   you may add. It draws the **silhouette** of the pack it starts with — one
   ghost card per clause on each slab, reshaping as the tier changes — and the
   entries drop their SLIs and the SLO each gets onto L1; a layer's sheet opens
   in preview, with *Compose in Compile →*. **Seed the pack →** confirms the
   definition once: on the next steps the column is a compact, read-only *seed
   card* (service, owners, environment, one tier chip, the entries) with
   *Change seed →*, and the conformance summary stays live beneath it.
2. **Compile - What Should We Watch?** — the **live stack** of the instantiated
   pack, its real artefacts per layer with the edges in the clause states, and
   the sheets where composition happens: on L1 the **SLI rolodex** — a
   scroll-snapping carousel of SLI cards from the selected entries (every
   product's behind a filter; adding one from a product not yet selected
   selects it too), each with the objective and window it starts with and an
   add / remove switch — **any** SLI is addable; one above the tier says which
   profile it starts from (*from the tier-1 profile*) — and the SLOs switch.
   **The library's values are copies, not links**: *Customise* expands a card
   in place into its edit face — the objective, the window, the bound, the
   PromQL, the description, each with *↺ library default* — the SLO id follows
   an edited objective, and an edited expression drops the library's evidence
   to *custom*, honestly; the last card, **+ Custom SLI**, writes an SLI from
   scratch (the engine's errors inline). Section switches on L3, L4 and L5 say
   which clauses they drop; the params sit on the layer they shape. Remove an
   SLI and L1 loses its card, switch dashboards off and L3 dims with its clauses
   red and an *off* chip on its head; the pack YAML as a collapsible underneath.
3. **Verify - Is It Ready to Use?** — the conformance verdict at the tier with
   three clause states (pass · pass on a placeholder · fail) and a **maturity
   bar per layer**, the schema verdict, the warnings, the stack again with the
   **todos pinned to the slab of the artefact each names** (routes and runbooks
   on L4, backends and pipelines on L2, probes and chaos on L5) and the parameter
   that fills each one editable inline — on the slab and on the layer's sheet,
   read-only otherwise, the customised and custom SLIs with their provenance
   (*customised: objective, window*) — the compiled artefacts (Prometheus rules,
   OTel Collector, Alertmanager, Grafana dashboards) previewed and downloadable,
   and **Ready to continue?** — *Resolve or adjust* returns to Define; *Continue
   with visible gaps* (*Continue to Discover* when none remain) registers the pack
   the way an upload is registered and hands it to the journey below, saying how
   many placeholders remain. A placeholder-laden pack is conformant on paper; the
   third state, the amber edges and the todos are what tell it from a real one.

### 1. Discover - What Do We Have?

Create or load a pack:

- scan a service repository
- generate a live pack from an OpenTelemetry MCP server
- upload a canonical YAML or JSON ObservabilityPack

The Discover view renders the observability Observogram across the layered model:

- L1 Contract: SLIs and SLOs
- L2 Telemetry: OTel, backends, collectors, pipelines
- L3 Insight: recording rules, dashboards, derived views
- L4 Action: alerts, routes, remediations
- L5 Validation: baselines, synthetics, chaos, release checks
- GOV: ownership and governance metadata

![Observogram Discover view showing the layered observability inventory](docs/img/xray-discover.png)

### 2. Diagnose - Can We Trust It?

Load the declared repo pack as **Pack A** and the live production pack as
**Pack B**. Observogram computes the Diagnostic Grade:

- **Score**: total criteria passed out of 7
- **Coverage**: four checks for "are we observing the right things?"
- **Trust**: three checks for "can we trust what the signals show?"
- **Operability**: one informational check (Actionable — runbooks linked),
  displayed but never scored
- **Verified**: whether a live MCP signal is present

The score maps onto a metrology-style **instrument grade** — the rating users
actually read; the full ladder renders on the grade card with the current rung
highlighted:

| Grade | Class | Score band |
|---|---|---|
| A++ | Calibration / Reference Grade | — (needs external reference benchmarking) |
| A+ | Laboratory / Research Grade | ≥ 95% |
| A | Diagnostic / Clinical Grade | > 85% (the audit bar) |
| B+ | Inspection Grade | ≥ 75% |
| B | Industrial Grade | ≥ 62.5% |
| C | Field Grade | ≥ 37.5% |
| D | Consumer Grade | < 37.5% |

The machine contract is unchanged: the audit **passes when the score is
greater than 85%** — i.e. exactly when the grade is A or better; the letter
and PASS/FAIL can never disagree. Failed criteria remain visible as evidence.
A pack can therefore pass the grade while still showing drift that belongs in
Remediate.

The checks are (grade schema 2):

| Area | Criteria | Scored |
|---|---|---|
| Coverage | Multi-modal, Correlated, Calibrated, Comprehensive | yes |
| Trust | Chaos-validated, Drift-free, Fresh | yes |
| Operability | Actionable | no — informational |

Runbooks measure response readiness of the overall solution, not diagnostic
capability — a perfectly diagnostic system tells you what is wrong even when
nobody wrote the response script. The runbook gap stays visible on the grade
card and in the posture matrix; it just no longer costs diagnostic credit.

The drift drill shows:

- aligned artifacts
- matched artifacts whose behavior drifted
- declared artifacts not confirmed live
- live-only shadow signals
- out-of-scope live inventory that belongs to the wider platform

Traceability shows requirement chains from SLO to SLI, metrics, recording
rules, exporters, scrape evidence, dashboards, alerts, and runbooks.

![Observogram Diagnose view showing Diagnostic Grade and live drift buckets](docs/img/xray-diagnose-drift.png)

### 3. Remediate - Fix The Gaps

Observogram compiles the pack delta into native backend artifacts:

- Prometheus recording and alerting rules
- Grafana-managed rules
- Grafana dashboards
- OTel Collector pipelines
- Alertmanager routes

Deployable artifacts can be pushed through an MCP write target. Non-deployable
or inferred artifacts remain visible as manual follow-up, not silent production
changes.

![Observogram Remediate view showing the Pack A minus Pack B deploy delta](docs/img/xray-remediate.png)

## Quickstart

Requires **Node 22.16 or later** (`engines` in `package.json`). The studio
is moving users, orgs, services and environments into an embedded store on
Node's built-in `node:sqlite`, which is unflagged from 22.13; 22.16 is the
floor because it fixes a `StatementSync` use-after-free and the `run()`
statement reset that a store hits. CI runs the suites on 22.16.0 and on the
latest 22. See [docs/STORE_PLAN.md](docs/STORE_PLAN.md).

```bash
git clone https://github.com/MoebiusX/Observogram.git
cd Observogram
npm install
npm run dev
```

Open `http://127.0.0.1:8000` and sign in with **admin / admin** — first
boot seeds this default user and asks for a password change at sign-in
(skippable for now; it asks again each sign-in until a real password
lands — or change it any time from the account menu, top right). From
there it's a signed-in app: your packs, deploy audit and run history
belong to you. (`OBSERVOGRAM_AUTH=off` skips login entirely
for a throwaway open sandbox.)

### Security Posture

1. **Local (default).** The server binds to `127.0.0.1` and ships like
   Grafana: first boot seeds a default `admin` user (password `admin`,
   change asked at every sign-in until it lands — skippable per
   session). The default credential is
   loopback-only — the server refuses to bind beyond loopback until it
   is changed; container/network first boots seed a real secret with
   `OBSERVOGRAM_ADMIN_PASSWORD` instead. `OBSERVOGRAM_AUTH=off` restores
   the pre-0.5 open mode: no login, a zero-friction local workspace.
2. **Exposed with a token.** Set `OBSERVOGRAM_API_TOKEN=<secret>` and bind
   wherever you need (`HOST=0.0.0.0`). Mutating `/api/*` routes (crawl,
   draft, validate-register, deploy, verify, reset) then require
   `Authorization: Bearer <secret>`; read routes stay open. Set
   `OBSERVOGRAM_API_TOKEN_LABEL=<team-or-owner>` to stamp the deploy audit
   log with the token's ownership — the secret itself never lands in any
   log. A token configured on a fresh workspace suppresses the
   default-admin seed: the token is the expressed auth intent.
3. **Exposed without any auth.** The server **refuses to start** with a
   clear message. `OBSERVOGRAM_INSECURE_NO_AUTH=1` overrides knowingly (it
   logs a loud warning) for trusted-network demos only.

Real users and SSO: `npm run users` manages locally-defined accounts,
`OBSERVOGRAM_OIDC_*` wires any OIDC provider, and `npm run orgs` arms
workspace-per-org tenancy — see
[docs/PRODUCTIZATION_PLAN.md](docs/PRODUCTIZATION_PLAN.md). The next stage,
an embedded store for users, orgs, services and environments, is planned
in [docs/STORE_PLAN.md](docs/STORE_PLAN.md).

MCP write tokens are unrelated to the API token: they pass through per
request and are never stored server-side. Registered packs and the deploy
audit live in the `.observogram/` workspace (`OBSERVOGRAM_WORKSPACE`
relocates it).

Two read routes answer without a session in every posture: `/healthz`
(probes) and `GET /api/version` — version, build, commit, branch, dirty,
date, shallow, source — which the studio footer reads before anyone signs
in. Neither carries a secret, but the second does tell an anonymous client
which branch a hosted studio runs and whether its tree was dirty; see
[Which Build Am I Running?](#which-build-am-i-running).

Useful local checks:

```bash
npm run lint:server
npm run lint:studio
npm run lint:crawler
npm run lint:fetcher
npm run test
```

### Run In Docker Or Kubernetes

The whole app is one Express process, so the container story is one image:

```bash
npm run build:stamp                    # build.json: the commit the image is built from (the image has no .git)
docker build -t observogram:0.4.0 .
docker run --rm -p 8000:8000 -e OBSERVOGRAM_ADMIN_PASSWORD=<secret> observogram:0.4.0
```

The image binds `0.0.0.0`, so it needs a seeded sign-in (or
`OBSERVOGRAM_API_TOKEN`) to start — see Security Posture above. Its workspace
is `/app/.observogram` (owned by the `node` user the container runs as);
mount a volume there, or point `OBSERVOGRAM_WORKSPACE` at one, to keep users
and packs across containers.

Kubernetes manifests (Deployment + Service + Ingress, applied with Kustomize)
live in [`deploy/k8s/`](deploy/k8s/README.md):

```bash
kubectl apply -k deploy/k8s            # the studio
kubectl apply -k deploy/k8s-journeys   # + the opt-in journeys CronJob and its workspace PVC (deploy/k8s/README.md)
```

### Which Build Am I Running?

There is no build step — the studio is served from the checkout — so the
identity of a running Observogram is the commit it was started from, and
one reader (`server/build-info.mjs`) answers everywhere:

- the studio footer: `v0.4.0 · build 975 · 9c4f827 · develop` (hover for
  the commit date and the source), the same label on Advanced → About;
- `packc --version` prints that label (`--version --json` the fields);
- `GET /api/version` returns `{ version, build, commit, branch, dirty, date,
  shallow, source, label }` — readable without a session (Security
  Posture), `Cache-Control: no-store`, so a proxy never pins an old build
  to a new process; `/healthz` keeps its composite `build: "975.9c4f827"`.

The **build number is the commit count on the branch** (`git rev-list
--count HEAD`): it climbs with every commit, so two studios can be compared
at a glance; the **sha** is what makes it unique (two branches can share a
count); **dirty** means git listed uncommitted or untracked files
(`git status --porcelain`) when the process started — the code running is
not exactly that commit. For a copy without
`.git` (a tarball, a container image) run `npm run build:stamp` in the
checkout first: it writes a git-ignored `build.json` that the reader falls
back to (`source: file`; run again inside such a copy it keeps that file —
it is the copy's only identity); with neither, the answer is package.json's
version and `build unknown` (`source: package`) — never a guess.

A **shallow clone** (`git clone --depth 1`; `actions/checkout` fetches one
commit by default) has no history to count, so it reads `build unknown ·
<sha> · <branch> · shallow` (`shallow: true`) rather than the clone depth,
and `npm run build:stamp` refuses it (exit 2) until the history is there —
`fetch-depth: 0` in the workflow, `git fetch --unshallow` locally.

## Common Operations

### Scan A Repo

```bash
npm run crawl -- path/to/service-repo --name krystalinex-core --env prod > repo.pack.yaml
npm run validate-pack -- repo.pack.yaml
```

The crawler reads source files such as:

- Prometheus rule files
- Grafana dashboard JSON
- Alertmanager config
- OTel Collector config
- Helm and Kubernetes manifests
- Docker Compose files

It emits a canonical v1.3 pack plus crawler annotations describing what was
scanned and what was inferred.

### Fetch Live From MCP

```bash
MCP_URL=https://otel-mcp.example.com/mcp \
MCP_AUTH=$MCP_CLIENT_KEY \
npm run fetch-live
```

The default output is the ignored local file `examples/production-live.pack.yaml`.
When the MCP exposes `metrics_query`, the fetch also samples the observability
stack's own self-metrics (scrape, ruler, notify, tsdb, collector, dashboards,
synthetic, logs, traces) as point-in-time signals — never verdicts, stamps or
grade inputs; on a restricted tier the pack says `not-attempted` and why.
`npm run record-fixtures` verifies the alias table behind that sample against
your endpoint (report only; `-- --write` records fixtures), and
`npm run test:stack:live` re-verifies every alias against the real products at
pinned versions in Docker (`docker/stack.compose.yaml`; skips without Docker).

See [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) for the live fetch and
write-back contract.

### Validate Or Upload A Pack

```bash
npm run validate-pack -- path/to/pack.yaml
```

The studio also accepts drag-and-drop or file picker upload. Uploaded, crawled,
and MCP-drafted packs are registered in memory and become addressable through
the same `/api/packs/:id/*` endpoints as catalog packs.

### Compile Artifacts

```bash
# Enumerate the compile tree
curl http://127.0.0.1:8000/api/packs/<pack-id>/compile-catalog

# Compile one artifact
curl "http://127.0.0.1:8000/api/packs/<pack-id>/compile-artifact?group=rules&flavor=grafana-managed&artifact=slo:slo_settlement_latency_99"
```

The UI exposes the same path through **Remediate -> Compile & Deploy**.

**Assurance rules.** Every compiled rules file (Prometheus and Grafana-managed)
ends with a `<svc>_assurance` group that monitors the monitors: an always-firing
`Watchdog` (route it to a heartbeat receiver and page when the heartbeat stops),
`<svc>_scrape_target_down` over the pack's declared scrape jobs, and instrument
liveness / degradation alerts (`<svc>_ruler_silent_prometheus`,
`_notify_silent_prometheus`, `_ruler_stale_`, `_ruler_errors_`,
`_notify_errors_`; `vmalert_*` rows under VictoriaMetrics, Alertmanager and
Grafana rows only when the pack declares them) built from the stack self-metric
alias table. Opt out per pack with the annotation
`observogram.assurance: watchdog-only | off` (default `on`). The catalog lists it
as the `assurance` item with its own file. See
[`docs/ASSURANCE_RULES.md`](docs/ASSURANCE_RULES.md) for the rules and a sample
heartbeat route.

### Build A Pack From The Library

For a service that has no pack yet: pick the products it runs on (or an archetype
for a service built from scratch), a criticality tier and a name, and `packc init`
instantiates the library entries into a canonical v1.3 pack that validates,
compiles through every target and passes every MUST clause of the tier — with the
values only the team can fill (pager service, chaos target, endpoints) reported as
todos, never hidden. The same engine drives the studio's Build journey (Define ·
Compile · Verify, see "Main Journey" above) through `/api/library/*`; the
contract is [`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md) and the entries and
their evidence bar are in [`library/README.md`](library/README.md).

```bash
$ node tools/cli.mjs init --list
entry           kind       version  evidence       SLIs t3/t2/t1  title
alertmanager    product    1.0.0    recorded-live  2/3/4          Alertmanager
grafana         product    1.0.0    recorded-live  2/6/8          Grafana
ibm-mq          product    1.0.0    recorded-live  2/6/8          IBM MQ
kafka           product    1.0.0    recorded-live  2/5/6          Apache Kafka
loki            product    1.0.0    recorded-live  1/2/4          Grafana Loki
otel-collector  product    1.0.0    recorded-live  1/4/6          OpenTelemetry Collector
prometheus      product    1.0.0    recorded-live  2/6/8          Prometheus
tempo           product    1.0.0    recorded-live  1/2/4          Grafana Tempo
http-service    archetype  1.0.0    semconv        1/2/4          HTTP service (OTel semconv)
queue-consumer  archetype  1.0.0    semconv        1/2/4          Queue consumer (OTel semconv)

$ node tools/cli.mjs init --show alertmanager      # params, SLIs per tier, objectives, evidence
alertmanager@1.0.0 — Alertmanager (product, product alertmanager)
  Availability, notification delivery success and failure rate, and silence count of a Prometheus Alertmanager.

evidence: recorded-live (verified 2026-09-07)
  - tools/lib/contracts/stack-self-metrics.mjs — rows notification_errors, notifications_sent, active_silences (…)
  …

$ node tools/cli.mjs init --entry kafka --tier tier-2 --name orders-kafka --owner team-orders \
    --param pager_service=pagerduty://orders --out orders-kafka.pack.yaml
packc init: orders-kafka@tier-2 from kafka@1.0.0 — 5 SLI(s), sections slos:on policy:on routes:on dashboards:on validation:on → orders-kafka.pack.yaml
conformance @ tier-2: MUST 15/15, SHOULD 1/1 (4 clause(s) pass on a placeholder)
todos (20) — placeholders only the team can fill:
  - alerting.routes[0]: channels.0.msteams: Chat channel for SEV1/SEV2: placeholder '#orders-kafka-oncall' (param oncall_channel) — …
  - baselines: mttd_target_p50: MTTD / MTTR targets are the tier-2 defaults, not measured: set them from the service's incident history
  - remediation[0]: runbook: write the runbook file://<runbook_dir>/broker-down.md
  - telemetry.backends.metrics-prom: version.declared: Prometheus version you run: placeholder '3.14' (param prometheus_version) — … · endpoints.0: Prometheus query endpoint: placeholder 'http://prometheus:9090' (param metrics_endpoint) — …  [L2.MUST.metrics_logs_traces_backends]
  - validation.synthetic_checks.produce-consume-canary: target: Bootstrap servers: placeholder 'kafka.kafka:9092' (param bootstrap) — …  [L5.MUST.synthetic_probe]
  …
schema: valid (spec v1.3)
```

The pack goes to stdout or `--out`; the todo list and the conformance line go to
stderr. `--slis a,b` (or `--sli <id>`, repeatable) picks the SLIs — any SLI of the
entries, above the tier too: the tier is a seed, an SLI above it starts from its own
tier's profile; `--override <sli>.<id|objective|window|threshold|good_when|semconv_metric>=<value>` (repeatable)
edits a selected SLI's copy of the library's value (the SLO id follows the objective; a
query is edited in the studio or the pack file; an override for an SLI not in the pack
is a `warning [override]`). A threshold SLI's bound has a direction since spec 1.3 —
`good_when: below` (a ceiling, the default) or `above` (a floor: connected consumers,
in-sync replicas) — declared in a library entry, in an override (`--override
<sli>.good_when=above`, or the editor's *good when* control) or in a custom SLI, and the
compiled burn alert then counts the samples under the bound; `--no-dashboards`,
`--no-policy`, `--no-routes`, `--no-validation`, `--no-slos` leave that section out
(the schema and the rubric then both say what is missing, exit `1`); `--entry
kafka,http-service` composes several entries into one pack; `--json` returns
`{ canonical, todos, provenance, warnings, schemaErrors, summary }`. Exit codes: `0` ok,
`1` the pack does not validate (the schema, a MUST clause of its tier — `MUST 14/15` is
never exit 0 — or an SLI that no longer parses once the `--param` values are in), `2`
usage error (an unknown `--param` key, a value carrying a quote). Every produced pack carries
`metadata.annotations["library.source"] = "<entry>@<version>"` and one
`library.todo.<artefact>` per placeholder, which the studio parks as *Scaffold* the
way it parks a crawler stub. `npm run test:library` proves every entry at every
tier (schema, four compile targets, dashboard bindings, conformance, goldens).

### Saved Journeys — Repeatable Drift Checks

Freeze a comparison as a journey file and run it on demand or on a schedule:

```yaml
# .observogram/journeys/repo-vs-live.journey.yaml
name: repo-vs-live
packA:
  crawl: { path: ../my-service, name: my-service, env: prod }
packB:
  mcp: { url: https://otel-mcp.example.com/mcp, authEnv: MY_MCP_TOKEN }
gate:
  minAlignmentPct: 85
  requireGradePass: true
  maxLiveAgeHours: 24
  failOnPartialEvidence: true   # a probe family FAILED → the verdict is not trustworthy
  maxUnhealthy: 0               # scrape jobs down + rules failing to evaluate, as seen on the wire
  stack:                        # thresholds on the stack's own self-metric samples (early warning)
    requireSampled: true        # breach unless the MCP tier let the run sample them
    rows:
      scrape_targets_down: { max: 0 }   # row ids come from the stack self-metrics table
keepLivePack: transitions       # snapshot Pack B beside the run: transitions (default) · always · never
schedule: "*/15 * * * *"        # the cadence it is MEANT to run at — declared, never fired from here
                                #   also { cron, timezone } or { every: 15m }
stackBudget: { objective: 0.99, window: 30d }   # posture budget the Journeys view prints per gated stack row (signal, not verdict)
notify:                         # early-warning delivery: one bounded POST per run
  urlEnv: MY_JOURNEY_WEBHOOK_URL     # env var NAME holding the URL (a literal url: is refused)
  authEnv: MY_JOURNEY_WEBHOOK_TOKEN  # optional → Authorization: Bearer <value>
  on: transitions                    # transitions (default) · breach · always
  format: json                       # json · text (one line + markdown body, ntfy-style)
inventory:                      # is the right number of things being monitored? (gen-site partition)
  site: ../sites/prod/site.json      # its `expected` block: names per kind, counted kinds with floors
  kinds: [qmgr, host]                # optional subset
# and under gate:  inventory: { maxSilent: 0, maxDown: 0, maxUnexpected: 0, minCoveragePct: 100 }
```

```bash
node tools/cli.mjs journey run repo-vs-live          # markdown report
node tools/cli.mjs journey run repo-vs-live --json   # automation output
node tools/cli.mjs journey run --all                 # every saved journey in sequence (exit = the worst)
node tools/cli.mjs journey schedule repo-vs-live     # cron · schtasks · GitHub Actions · CronJob snippets from schedule:
node tools/cli.mjs journey list                      # journeys + last outcome (+ notify status)
```

Exit codes follow the gate contract: `0` verdict passes, `1` gate failed,
`2` tooling/config error — so the same command is a cron job, a Windows
scheduled task, or a CI gate. Every run appends a JSON record under
`.observogram/runs/<journey>/` (the drift-over-time series), including the
vantage of the live source itself (`probes`, `vantage`, `toolsExposedCount`,
`scrapeJobsDown`, `unhealthyRules`). When the live MCP does not answer at
all, the run still writes an `outcome: vantage-lost` record before exiting
`2` — the loss is a point in the history, not a gap. The CLI grades on the
same construct as the studio (requirement-chain integrity rides on the
diff), so both report one score for one comparison. Secrets never live in
journey files — MCP auth is referenced by env-var name.

Run history is bounded so a journey on a cron cadence never fills the disk:
after every run the journey's `runs/` directory is pruned to the newest
`OBSERVOGRAM_JOURNEY_RUN_RETENTION` records (default `1000`; `0` = unlimited).
A record that cannot be deleted is noted on the run as `historyError` — the
verdict still stands. Scheduling itself stays external (cron, CI, a Windows
scheduled task, a Kubernetes CronJob) by design — `packc journey schedule
<name>` prints the ready-made snippet for each from the journey's `schedule:`
(`--format cron|schtasks|actions|k8s`), with secrets only ever as env-var
names, and the opt-in [`deploy/k8s-journeys`](deploy/k8s/README.md) overlay
runs `journey run --all` as a CronJob against the studio's workspace PVC.
`notify:` posts a run to a webhook only when it says something new
(`transitions`: outcome changed, a chain got worse, a new candidate cause, the
vantage changed; `breach`; `always`) — the outcome lands on the record as
`notify` and never changes the exit code. Each record of a live run also keeps the stack
self-metric samples it saw (`stackEvidence`: the rows, plus the Alertmanager
and Grafana status the MCP answered) — point-in-time signals kept per run so
the history is the time series, never a verdict.

The `stack:` gate block turns those samples into an early warning: `rows`
declares a `min` / `max` band per row id (validated against the table when
the journey loads — an unknown id is refused with the known ids listed), and
`requireSampled: true` breaches when the tier could not sample at all, or
sampled with no row answering data. A threshold can only be checked against
a row that answered data; a row that was empty, failed, not in the
inventory or absent breaches as *no sample* rather than passing by absence
(on a restricted tier the breach carries the tier reason), and a threshold
that is not a finite band breaches as *threshold invalid* instead of
passing silently. A stack breach reads
`scrape_targets_down = 2 count outside [-∞ … 0] — point-in-time sample, not
an SLO verdict`: it is a signal to look, not an SLO verdict, and it never
touches the grade. The report prints the samples in a *Stack self-metrics*
table and `journey list` shows `stack sampled N` / `stack not attempted` /
`stack none` per journey (a definition that fails to load prints why instead
of looking never-run). In the studio (Advanced → Neuron, the journey cards) each card
carries a "stack self-metrics — point-in-time samples" line: one chip per
family with the last run's value — the row with a `nonzero` signal first,
then lower-is-comfortable rows, so a healthy-looking ratio never hides a
target that is down — a muted `nonzero` marker where a
lower-is-comfortable row is above zero, `nonzero in N of last M runs` over
the fetched history, and a single muted chip with the reason when the tier
could not sample — chips never carry an ok/error colour, because a sample
is a signal, not a verdict.

**Inventory coverage.** A journey that names a gen-site partition (`inventory: { site:
<partition>/site.json }`, relative to the journey file) compares the site's `expected` sets
(`docs/gen-site.md`: per kind the inventoried names — queue managers, brokers, and hosts where
the module says `up` carries a `host` label — and counted kinds such as queues per queue manager with floors) against the live `up` series read
through the MCP's metrics query tool, once per kind. The record carries
`inventory: { status, reason, kinds }`: per enumerated kind *up*, *down* (targeted, every
target down), *silent* (no `up` series at all — the site's own Silent alert asks the same
question in Prometheus), *unexpected* (answering but not inventoried) and a coverage
percentage; per counted kind the live count per parent against the floors. A file-sourced
Pack B is `not-attempted` (no live series), an MCP without the tool `not-attempted` with the
tier reason, an unreadable site `failed` with the reason, a `kinds` entry the site does not
declare `failed` naming it, and a kind whose query failed `failed` with no numbers (a failed
query is not an outage of every name). `gate.inventory` turns it into a
verdict: `requireChecked` (default `true`) breaches when coverage could not be checked,
`maxSilent` / `maxDown` / `maxUnexpected` / `minCoveragePct` per enumerated kind, and a
counted kind's floors breach whenever undercut; `kinds` narrows the gate. The report prints an
*Inventory coverage* line and a per-kind table, `journey list` an `inventory 11/12 qmgr …`
segment, `GET /api/journeys` the summary as `lastRun.inventory`, and Advanced → Neuron a
fleet tile, per-kind coverage over time for the journey in focus and the newest record's
table. Coverage never touches the grade or the alignment.

Each run also records its requirement chains: per chain the scored verdict
beside the on-wire *ladder* verdict (is the artefact merely present, doing
its job, or could the vantage not look — `unobserved` means the tier could
not look, never "absent"; nothing scored changes), the degraded nodes with
their *blast radius* (how many SLOs would go blind if that node really died
— structural exposure, not a claim that they are blind), the product
versions seen, and what moved since the previous run with the candidate
causes the evidence can offer — Observogram's own deploys inside the window,
decision-bearing drift, a backend version change, a stack self-metric signal
— ranked by evidence, never a root-cause verdict; a change of the vantage
itself is reported beside them, never as one. `keepLivePack` decides when
Pack B is snapshotted under `runs/<journey>/live/` (by default on the first
run, whenever a chain's verdict moved, on a gate failure, or after a vantage
loss; snapshots are pruned with their records). `journey list`
appends `chains 8/10 intact · ladder 7 healthy · 2 degraded` per journey,
only when a chain got worse `top cause: [observogram-deploy] deploy
dep_x by … touched …`, and whenever the vantage itself moved `vantage
changed: vantage full → partial · …` — named beside the cause, never as
one. In the studio the Diagnose chain cards show the
ladder verdict, name present-but-unhealthy / stale / unobserved nodes and
say `blinds N SLOs` beside a missing or drifted one, and each journey card
under Advanced → Neuron carries a plain-text chains line and a
candidate-cause line — counts and muted markers, no colours.

### Neuron — the monitor of the monitors, as one page

**Advanced → Neuron** reads every saved journey as one instrument. A toolbar
picks the window (the newest 20 / 50 / 100 / 200 runs per journey), the trend
metric (alignment or grade), the journey in focus, and offers **run all**
(every journey in sequence, the studio form of `packc journey run --all`).
Fleet tiles give the last word: journeys (scheduled · notify · stack-gated ·
broken definitions), last outcomes with a pass / gate-failed / vantage-lost
bar, fleet alignment and grade (the mean of each journey's last value, with a
*paired* delta against the run before), requirement chains intact / declared
with the four ladder buckets, journeys whose chains got worse, the widest
exposure across the fleet, delivery sent / failed / skipped, and the journeys
whose last run carried a nonzero lower-is-comfortable stack sample. Six
fleet panels follow — alignment or grade over time per journey (a time axis
when the records carry times; a vantage-lost run is a gap, never a 0), an
outcome heatmap newest-right, breached criteria and candidate-cause kinds over
every run in the window, blind-spot exposure over time (the SLOs the widest
degraded artefact would blind, per journey) and the widest exposures across
the fleet's newest records as stacked bars (SLOs · alerts · other consumers
that would go blind — structural exposure on the requirement graph, never a
claim that they are blind). Then the journey in focus (chosen, or the one that
most needs eyes: a chain getting worse, then gate-failed, then vantage-lost,
then the lowest alignment): alignment and grade per run, the ladder buckets
per run as stacked bars in a neutral ramp, scored vs ladder integrity, run
duration, the blast radius of the newest record (every degraded node of a
declared chain once, with the chains it degrades, as a stacked bar) with the
widest node's exposure per run, one small step chart per stack self-metric row in a single ink
colour (a ring on `nonzero` samples, a hollow marker where the probe did not
answer, the posture-budget note under gated rows), and the newest record
opened up — requirement chains with their degraded nodes and blast radius,
the ranked candidate causes with the vantage beside them, the transition
since the run before, the gate, drift / grade / conformance / freshness, the
stack evidence table with the Alertmanager and Grafana status, the vantage,
backend versions, delivery, and the schedule with its cron / schtasks /
GitHub Actions / CronJob snippets (`GET /api/journeys/:name/schedule`, loaded
on demand). The saved-journey cards close the page. The charts are
zero-dependency inline SVG (`tools/lib/svg-charts.mjs`); the numbers come
from one pure model (`tools/lib/neuron-model.mjs`), so what the page says can
be tested without a browser. The view needs no pack loaded.

### Back Up And Restore The Store

The embedded store (`observogram.db` in the workspace, or wherever
`OBSERVOGRAM_DB` points; [docs/STORE_PLAN.md](docs/STORE_PLAN.md) §3) runs
in WAL mode. **A file-by-file copy (`cp -r`, rsync, tar) taken while any
process has it open is not a backup**, even with `-wal` and `-shm`
included: a checkpoint between two file copies tears it. Safe options:

1. a copy with nothing holding the database — the server stopped, and no
   `npm run users`, `npm run orgs` or `packc store` running;
2. an atomic volume snapshot;
3. with the server running, `packc store backup`:

```bash
packc store backup /backups/observogram-2026-09-24.db
# backup written: /backups/observogram-2026-09-24.db
# store_id: 3f0c… (schema v1, from /app/.observogram/observogram.db)
```

It runs `VACUUM INTO` outside any transaction into `<path>.tmp` and renames
that into place: every committed row, as one rollback-journal file, while
writers stay active. It refuses an existing `<path>`, `:memory:`, and a
path with no database (it never creates one).

The other workspace files (packs, snapshots, journeys, runs,
`deploys.jsonl`, `session-secret`) can be copied live as before. Where the
database lives outside the workspace, a workspace copy alone holds no
users, orgs, memberships or audit.

**Restore** with the server stopped:

```bash
packc store restore /backups/observogram-2026-09-24.db
# restored … -> /app/.observogram/observogram.db
# store_id: 3f0c… (schema v1); previous store_id: 3f0c…
# moved aside: /app/.observogram/observogram.db.pre-restore-20260924T101500123Z
```

It refuses while anything holds the database (switching it out of WAL
needs exclusive access, so even an idle server is caught), checks the
backup is an Observogram store, moves `observogram.db`, `-wal` and `-shm`
aside together under one timestamp, and copies the backup in; the next
start switches it back to WAL. Never copy a backup over the `.db` alone: a
`-wal` left by an unclean stop would be replayed onto it. To move a
database, move the file with nothing holding it: it carries its
`store_id`.

## API Surface

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/healthz` | Health and vendored spec version |
| `GET` | `/api/version` | Which build is this: version, build (commit count), commit, branch, dirty, date, shallow, source, label — public, no-store |
| `GET` | `/api/packs` | In-memory and catalog pack registry |
| `GET` | `/api/examples` | Bundled example packs |
| `GET` | `/api/references` | Curated catalogue reference packs |
| `GET` | `/api/packs/:id` | Adapted layered pack |
| `GET` | `/api/packs/:id/canonical` | Canonical pack with env overlay |
| `GET` | `/api/packs/:id/conformance` | Maturity-rubric scoring |
| `GET` | `/api/diff?a=&b=` | Repo/live or pack/pack structural diff |
| `GET` | `/api/packs/:id/compile-catalog` | Per-artifact compile tree |
| `GET` | `/api/packs/:id/compile-artifact` | Compile one artifact or group |
| `POST` | `/api/validate` | Validate and register uploaded YAML/JSON (`summary.onPlaceholder` when the pack carries `library.todo.*` annotations) |
| `GET` | `/api/library` | The pack library index (`entries`, `scaffoldParams`, `errors`: the files that did not load) — the BUILD journey's DEFINE step |
| `GET` | `/api/library/requirements/:tier` | The conformance clauses that apply at a tier (the rubric filtered by `minTier`; 400 names the known tiers) |
| `GET` | `/api/library/:id` | One library entry: its index row plus the full SLI templates and params (404 names the known entries) |
| `POST` | `/api/library/instantiate` | `{ entries, name, tier, environment, owners, params, toggles }` → `canonical`, `canonicalYaml`, `todos`, `provenance`, `warnings`, `schemaErrors`, `summary`, `conformance`, `adapted` (the adapter's layered projection, as `/api/validate` returns it — what Build's stack draws; an engine usage error is 400, never 500) |
| `POST` | `/api/library/compile` | `{ canonical, target }` → one compiled artefact (`label`, `contentType`, `artifact { filename, content, warnings, profile }`), nothing registered |
| `POST` | `/api/library/register` | `{ canonical, source? }` → the upload registry as `/api/validate` registers (`registered { id, source }`, `adapted`, `conformance`, `summary`; the source defaults to `library:<entries>@<tier>` for a library-built pack, `metadata.name` otherwise) — "VERIFY's "Continue with visible gaps"" |
| `POST` | `/api/crawl` | Draft a pack from uploaded repo files |
| `POST` | `/api/crawl-github` | Draft a pack from a GitHub URL |
| `POST` | `/api/draft-from-mcp` | Draft a live pack from an MCP endpoint |
| `POST` | `/api/packs/:id/deploy-bulk` | Deploy selected compiled artifacts |
| `POST` | `/api/packs/:id/deploy/:target` | Deploy one compiled target |
| `DELETE` | `/api/uploads` | Clear uploaded/crawled/drafted packs |
| `GET` | `/api/journeys` | Saved journeys with their `schedule` (parsed: `cron`, `timezone`, `every`, `cadenceMs`, `cadenceNote`), `stackBudget`, `notify` (env-var names + policy, never a URL) and the last run (outcome, alignment, grade, breaches, `stack` summary, `chains` summary, `transition` counts, `topCause`, `vantageChanged`, `notify` `{ status, httpStatus, reason }`, `inventory` `{ status, reason, environment, kinds }`) |
| `GET` | `/api/journeys/:name/runs?limit=` | Run history, newest first (the drift-over-time series) |
| `GET` | `/api/journeys/:name/schedule` | The parsed `schedule:` and the cron / schtasks / GitHub Actions / CronJob snippets (env var names only; `placeholder: true` without a schedule) |
| `POST` | `/api/journeys/:name/run` | Run a saved journey now |
| `POST` | `/api/journeys/capture` | Freeze the current A/B session as a journey file |

## Repository Map

```text
server/
  index.mjs                Express API, upload registry, compile/deploy routes
  library.mjs              Loads library/**/*.library.yaml from disk (the Node side of the BUILD engine)
  store/                   The embedded store (docs/STORE_PLAN.md): db.mjs (the one node:sqlite door), migrations, repositories, backup/restore — no server callers yet
  test-smoke.mjs           End-to-end route smoke tests

studio/
  app.mjs                  Browser app shell and three-step workflow
  compare-view.mjs         Diagnostic Grade, drift, traceability entry points
  compile-view.mjs         Remediate, compile catalog, deploy surfaces
  layers-view.mjs          Discover Observogram and artifact cards
  neuron-view.mjs          Advanced → Neuron: fleet tiles, trend / heatmap / bar panels, the journey in focus, the newest record opened up
  journeys-view.mjs        Saved journeys: capture, run-now, history, stack chips, chains + cause lines (the cards Neuron composes)
  build-model.mjs          The BUILD journey's pure models (define / compile / verify, the stack, the definition column, the layer sheet, the clause checklist's three states, step reachability)
  build-api.mjs            The BUILD journey's loaders over /api/library/* (fetchFn injectable)
  build-definition-view.mjs  BUILD — the definition column on every step (service, the tier as a segmented control, the entries as chips, the conformance summary)
  build-sheet-view.mjs     BUILD — the per-layer sheet (the layer's question and clauses, the L1 SLI rolodex, the section switches, the params, the lists; preview · edit · verify)
  build-stack-view.mjs     BUILD — the layer stack of the pack being compiled (Discover's cards; a slab head opens its sheet)
  build-define-view.mjs    BUILD step 1 — Define (the silhouette) + the step head and error note the three steps share
  build-compile-view.mjs  BUILD step 2 — Compile (the live stack, the warnings, the pack YAML)
  build-verify-view.mjs  BUILD step 3 — Verify (verdict, the stack with its todos, artefacts, Continue with visible gaps)

tools/
  cli.mjs                  packc CLI (journey run / list, compile, init, store backup / restore, …)
  crawl-repo.mjs           CLI repo crawler
  fetch-live-pack.mjs      MCP live-pack fetcher
  pack-init.mjs            packc init: build a pack from the library (list / show / instantiate)
  test-build-model.mjs     The BUILD journey's studio models over captured API responses (tools/fixtures/build/)
  validate-pack.mjs        Canonical pack validator
  lib/
    adapter.mjs            Canonical pack -> layered UI model
    blast-radius.mjs       Blind-spot blast radius over the requirement graph (zero-import, vendorable)
    chain-history.mjs      Requirement-chain records per run, transitions, candidate causes (zero-import, vendorable)
    compile.mjs            packc compiler
    conformance.mjs        Maturity rubric
    diff.mjs               Structural pack diff
    journey.mjs            Journey definitions, runner, gate, run history (node-only)
    library.mjs            The BUILD journey engine: entries, tier scaffold, instantiation, todos, provenance (browser-safe)
    stack-evidence.mjs     Stack self-metric history helpers (browser-safe, vendorable)
    traceability.mjs       Requirement chains

examples/
  production-curated.pack.yaml
  target-advanced.pack.yaml
  demo-skeleton.pack.yaml

vendor/observability-pack-spec/v1.3/examples/
  payment-service.pack.yaml

reference-packs/
  kafka.pack.yaml
  prometheus.pack.yaml
  grafana.pack.yaml

library/                   The pack library packc init builds from (docs/BUILD_JOURNEY.md, library/README.md)
  products/                kafka · prometheus · grafana · ibm-mq · alertmanager · loki · tempo · otel-collector (.library.yaml)
  archetypes/              http-service · queue-consumer (OTel semconv v1.27.0)

deploy/k8s/
  kustomization.yaml       Kustomize entry point (see deploy/k8s/README.md)
```

## Key Docs

- [`docs/HANDOVER.md`](docs/HANDOVER.md) - hand-over note for the next session: where the three repos stand, the maintainer's working rules, the backlog and the known debts (2026-09-24)
- [`docs/STORE_PLAN.md`](docs/STORE_PLAN.md) - the embedded `node:sqlite` store for users, orgs, services, environments and the audit: schema, import from today's files, roles, slices and gates (decisions ratified 2026-09-24)
- [`docs/USER_JOURNEY.md`](docs/USER_JOURNEY.md) - product journey and design invariants
- [`docs/DRY_RUN.md`](docs/DRY_RUN.md) - dry-run script and readiness checklist
- [`docs/RELEASE_READINESS.md`](docs/RELEASE_READINESS.md) - V1 release gate
- [`docs/MCP_INTEGRATION.md`](docs/MCP_INTEGRATION.md) - live fetch, verification, deploy writes
- [`docs/MODEL.md`](docs/MODEL.md) - the layered observability model (L1–L5, L2X, GOV)
- [`docs/DIFF.md`](docs/DIFF.md) - structural alignment and drift model
- [`docs/CONFORMANCE.md`](docs/CONFORMANCE.md) - maturity rubric scoring
- [`docs/BUILD_JOURNEY.md`](docs/BUILD_JOURNEY.md) - the BUILD journey (Define · Compile · Verify): the pack library, the tier scaffold, placeholders and provenance, the engine API and `packc init`
- [`docs/DIAGNOSTIC_GRADE_FRAMEWORK.md`](docs/DIAGNOSTIC_GRADE_FRAMEWORK.md) - the eight coverage/trust criteria behind the Diagnose grade
- [`docs/PHASE_1_VERDICT_TRUST_RESEARCH.md`](docs/PHASE_1_VERDICT_TRUST_RESEARCH.md) - draft research/spec for the verdict-trust phase
- [`docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md`](docs/TRACEABILITY_GRAPH_COMPARISON_SPEC.md) - requirement-chain comparison semantics
- [`docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md`](docs/SCORING_PROPOSAL_LADDER_INTEGRITY.md) - proposal (not applied) for Drift-free to read the per-node ladder integrity
- [`docs/USER_STORY_CRAWLER_PROVENANCE.md`](docs/USER_STORY_CRAWLER_PROVENANCE.md) - provenance requirements for deployable artifacts
- [`docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md`](docs/USER_STORY_REQUIRED_DEPLOYMENT_ENVIRONMENT.md) - backlog story for required crawl environment selection
- [`docs/ADVANCED_FEATURE_AUDIT.md`](docs/ADVANCED_FEATURE_AUDIT.md) - per-view audit of the Advanced tools (References · Conformance · Schema · OTLP · Traceability · Atlas)
- [`docs/VALUE_BACKLOG.md`](docs/VALUE_BACKLOG.md) - prioritized product backlog for the next iterations
- [`docs/gen-site.md`](docs/gen-site.md) - gen-site: inventory v1, the module contract, the timing model and the CLI that renders one partition per environment
- [`docs/REFACTORING_PLAN.md`](docs/REFACTORING_PLAN.md) - maintainability refactor backlog from the 2026-06 audit
- [`docs/BRANCHING.md`](docs/BRANCHING.md) - the branching model: lanes, per-commit bar, multi-writer rules, promotion cadence
- [`docs/VENDORING.md`](docs/VENDORING.md) - vendoring the verdict/diff engines into a downstream studio, and how to stay current
- [`docs/UI_CONVENTIONS.md`](docs/UI_CONVENTIONS.md) - studio view-module conventions: the host seam, loader/renderer split, render signatures, CSS zones

Superseded planning docs live in [`docs/archive/`](docs/archive/README.md).

## License

MIT - see [LICENSE](LICENSE).
