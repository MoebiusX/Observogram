# gen-site: a fleet from one reference pack

`tools/gen-site.mjs` renders one partition per environment from a reference ObservabilityPack
and one or more *site inventories*: a derived site pack, the compiled burn-rate rules, the
pack module's templates and dashboards, and a `site.json` manifest. The generic core lives in
`tools/lib/site/` (browser-safe, vendorable: it imports only its siblings by relative path);
everything pack-specific arrives through `--module <esm>`, the same pattern as
`tools/gen-dashboards.mjs --module`.

The design rules the core enforces:

- **Templates, not serialisers.** The reference pack is rewritten as text with exact-count
  anchors; a module's templates are `(ctx) => string` functions over the reference files. No
  YAML is re-serialised, so comments and layout survive.
- **Anchors fail loudly.** Every substitution declares how many times it matches in the
  reference pack text; the counts are asserted there, all at once, before anything is applied,
  so a different count is an error naming the anchor and an anchor that overlaps an earlier one
  counts the same in every environment. A replacement must not introduce text a later anchor
  matches (error naming that anchor).
- **Environment is a label, not a pack name.** `metadata.name` stays what the pack says;
  the environment lives in the partition path, `site.json` and the labels the module emits.
- **Secrets are references** (paths and names in the inventory), never values.

```
node tools/gen-site.mjs --inventory <file> [--inventory <file>…] [--env <name|all>]
     [--pack <pack.yaml>] [--module <esm>] [--out sites] [--registry <file> --adapter <esm>]
     [--check] [--dry-run] [--strict] [--repo-url <url>] [--schema <pack schema.json>]
```

## Inventory v1

One file per environment, one file for the whole fleet, or a mix: `--inventory` repeats and
the files are merged. `tools/lib/site/inventory.schema.json` is the schema (the JSON Schema
2020-12 subset `tools/lib/validator.mjs` implements); the module's `paramsSchema` fragments
are spliced in as `$defs/siteParams`, `$defs/hostParams` and `$defs/instanceParams`, so the
schema never changes for a new pack or registry, only the module and the adapter do.

| Key | Meaning |
| --- | --- |
| `inventory: v1` | required |
| `env` | file-level default environment for this file's hosts and instances |
| `pack` | reference pack path, relative to the inventory file (`--pack` wins) |
| `environments.<name>` | per-environment wiring: `scrape_interval`, `vantage: single\|dual` (default `dual`), `profile: container\|non-container` (default `container`), `endpoints{remote_write, loki, tempo, alertmanager, alert_sink, otlp, grafana}`, `receivers{sev1, sev2, sev3}`, `secrets{receiver → secret path}`, `repo_url`, `rule_labels`, `params{}` (module site params) |
| `hosts[]` | `name`, `env` (inherits the file's), `site` (free label), `roles[]` (informative), `params{}` (module host params) |
| `instances[]` | the things the pack monitors — the module names the key (`module.instances.key`; the IBM MQ module keeps `queue_managers[]`): `name`, `shape` (a free string the module may require and constrain, e.g. `container\|host\|multi-instance\|rdqm-ha\|rdqm-dr`), `env`, `hosts[]` (names from `hosts[]`), `address{host, port}`, `exporter_host` (default: the environment's `params.monitoring_host`), `params{}` (module instance params) |

What an instance *is* comes from the module, not the core: `module.instances = { key, kind,
label, title, schema }` names the collection key, the kind the expected sets and the inventory
series use (`qmgr`, `broker`, `cluster` …), the label the live series carry, the title error
messages print, and a JSON Schema fragment merged into the `Instance` definition. Without a
module the key is `instances`, the kind `instance`, and `shape` is optional.

A fleet with two environments in one file:

```yaml
inventory: v1
pack: packs/ibmmq.pack.yaml
environments:
  prod:
    scrape_interval: 30s            # else spec.environments.prod.overrides['prometheus.scrape_interval'], else the pack step
    vantage: dual
    profile: non-container
    endpoints:
      remote_write: https://mimir.prod.internal/api/v1/push
      loki: https://loki.prod.internal/otlp
      tempo: tempo.prod.internal:4317
      alertmanager: https://am.prod.internal
      alert_sink: http://alert-sink.mq-obs.svc:9095
      otlp: http://otel-gateway.mq-obs.svc:4318
      grafana: https://grafana.prod.internal
    receivers: { sev1: pagerduty://mq, sev2: "#mq-oncall", sev3: "#mq-team" }
    secrets: { pagerduty://mq: /etc/alertmanager/secrets/pagerduty_mq, "#mq-oncall": /etc/alertmanager/secrets/msteams_mq_oncall, "#mq-team": /etc/alertmanager/secrets/msteams_mq_team }
    repo_url: https://github.com/MoebiusX/mq-observability-pack/blob/main
    params:
      app_queue_pattern: "ORD\\..*|PAY\\..*"
      monitored_queues: [ "ORD.*", "PAY.*" ]
      deadq: SYSTEM.DEAD.LETTER.QUEUE
      canary_queue: MON.CANARY
      orders_queue: null
      listener: SYSTEM.LISTENER.TCP.1
      users: { monitor: mqmon, canary: mqcanary }
      monitoring_hosts: "10.20.1-40.*"
      monitoring_host: mon1.prod.internal
      exporter_poll_interval: 30s
      canary_interval: 30s
      log_source: amqerr-json
  staging:
    vantage: single                  # client exporter only today → degraded alert set
    profile: non-container
    endpoints: { remote_write: https://mimir.stg.internal/api/v1/push, loki: https://loki.stg.internal/otlp, tempo: tempo.stg.internal:4317, alertmanager: https://am.stg.internal, alert_sink: http://alert-sink.mq-obs-stg.svc:9095, otlp: http://otel-gateway.mq-obs-stg.svc:4318 }
    receivers: { sev1: "#mq-team", sev2: "#mq-team", sev3: "#mq-team" }
    params: { app_queue_pattern: "ORD\\..*", monitored_queues: [ "ORD.*" ], deadq: SYSTEM.DEAD.LETTER.QUEUE, canary_queue: MON.CANARY, users: { monitor: mqmon, canary: mqcanary }, monitoring_hosts: "10.30.*", monitoring_host: mon1.stg.internal, log_source: amqerr-json }
hosts:
  - { name: mqha1.prod.internal, env: prod, site: dc1, roles: [rdqm-ha] }
  - { name: mqha2.prod.internal, env: prod, site: dc1, roles: [rdqm-ha] }
  - { name: mqha3.prod.internal, env: prod, site: dc1, roles: [rdqm-ha] }
  - { name: mqpay1.prod.internal, env: prod, site: dc2, roles: [standalone] }
  - { name: mqord1.stg.internal, env: staging, site: dc1 }
queue_managers:
  - name: QMORD1
    shape: rdqm-ha                          # env inherited from its hosts (all prod)
    hosts: [ mqha1.prod.internal, mqha2.prod.internal, mqha3.prod.internal ]
    address: { host: 10.20.5.11, port: 1414 }   # rdqmint floating IP
    params:
      native_port: 9157
      client_port: 9161
      channels: { monitoring: MON.SVRCONN, canary: CANARY.SVRCONN, define: true }
      tls: { ccdt_url: file:///etc/mq/ccdt/QMORD1.json, key_repository: /etc/mq/tls/mqmon, cipher: ANY_TLS12_OR_HIGHER, sslcauth: REQUIRED }
      credentials: { monitor_secret: /run/secrets/mqmon-QMORD1, canary_secret: /run/secrets/mqcanary-QMORD1 }
      rdqm: { group: ord, dr: false }
  - name: QMPAY1
    shape: host
    hosts: [ mqpay1.prod.internal ]
    address: { host: mqpay1.prod.internal, port: 1415 }
    params: { native_port: 9157, client_port: 9162, channels: { monitoring: MON.SVRCONN, canary: CANARY.SVRCONN, define: true }, tls: { ccdt_url: file:///etc/mq/ccdt/QMPAY1.json, key_repository: /etc/mq/tls/mqmon, cipher: ANY_TLS12_OR_HIGHER }, credentials: { monitor_secret: /run/secrets/mqmon-QMPAY1, canary_secret: /run/secrets/mqcanary-QMPAY1 } }
  - name: QMORDS
    env: staging
    shape: host
    hosts: [ mqord1.stg.internal ]
    address: { host: mqord1.stg.internal, port: 1414 }
    params: { client_port: 9161, channels: { monitoring: MON.SVRCONN, canary: CANARY.SVRCONN, define: true }, tls: { ccdt_url: file:///etc/mq/ccdt/QMORDS.json, key_repository: /etc/mq/tls/mqmon, cipher: ANY_TLS12_OR_HIGHER }, credentials: { monitor_secret: /run/secrets/mqmon-QMORDS, canary_secret: /run/secrets/mqcanary-QMORDS } }
```

A lab as an inventory (the file-level `env` is inherited by its single host and queue manager):

```yaml
inventory: v1
env: lab
pack: packs/ibmmq.pack.yaml
environments:
  lab:
    scrape_interval: 10s
    vantage: dual
    profile: container
    endpoints: { remote_write: http://prometheus:9090/api/v1/write, loki: http://loki:3100/otlp, tempo: tempo:4317, alertmanager: http://alertmanager:9093, alert_sink: http://alert-sink:9095, otlp: http://otel-collector:4318, grafana: http://grafana:3000 }
    receivers: { sev1: webhook://alert-sink, sev2: webhook://alert-sink, sev3: webhook://alert-sink }
    params:
      app_queue_pattern: "APP.*"
      monitored_queues: [ "APP.*", "DEV.*" ]
      deadq: APP.DLQ
      canary_queue: APP.CANARY
      orders_queue: APP.ORDERS.REQ
      burst_queue: APP.BURST
      listener: SYSTEM.LISTENER.TCP.1
      users: { monitor: admin, canary: app }
      monitoring_host: mq-exporter
      exporter_poll_interval: 10s
      canary_interval: 10s
      log_source: docker
hosts:
  - { name: mq, site: lab, roles: [container] }
queue_managers:
  - name: QM1
    shape: container
    hosts: [ mq ]
    address: { host: mq, port: 1414 }
    params:
      native_port: 9157
      client_port: 9157
      channels: { monitoring: DEV.ADMIN.SVRCONN, canary: DEV.APP.SVRCONN, define: false }
      tls: null
      credentials: { monitor_secret: /run/secrets/mqAdminPassword, canary_secret: /run/secrets/mqAppPassword }
```

(The `params` blocks above are the IBM MQ module's; the core only knows the four names it
reads itself: `monitoring_host`, `exporter_poll_interval`, `canary_interval` on the site, and
`native_port`, `client_port` on an instance.)

### Merge, inheritance, validation (`inventory.mjs`)

- **Merge** (`mergeInventories(files, { packChosen, module })`): `hosts` and the instances
  (under the module's key) are concatenated (a duplicate host name across files is an error
  naming both files; a duplicate instance name within one environment is an error naming both
  files, checked once the environments are resolved, so `QM1` in prod and `QM1` in staging are
  two instances); `environments` keys are merged (the same key in two files must be
  deep-equal); a file-level `env` applies only to that file's items, kept as
  `source: { file, env }` on each merged item. The merged model carries `instanceKind` (the
  module's descriptor) and `instances`, plus the same array under the module's key when it
  differs. Two files whose `pack:` strings differ are an error for a library caller that did
  not choose the pack (`run({ packChosen })`); the CLI always chooses it (`--pack`, or each
  file's `pack:` resolved relative to that file), so one file per directory may spell the same
  pack differently.
- **Inheritance** (`resolveEnvironments`): `host.env = host.env ?? file.env` (error when
  neither); `instance.env = instance.env ?? unique(env of its hosts) ?? file.env` (error when
  the hosts disagree, naming them; when the instance's `env` differs from its hosts' env; when
  nothing resolves). Every error names the item and its file.
- **Names**: every environment referenced (file `env`, host `env`, instance `env`,
  `environments` keys) must be in the pack's `metadata.bindings.environments`; the error quotes
  the pack's list. Every environment with members (a host or an instance) needs an
  `environments.<env>` block (endpoints are required to emit anything; a host-only environment
  is rendered too, so it needs one). A pack without `spec.environments.<env>` is a warning
  (`--strict`: error).
- **Semantics** (`validateInventory`): the core checks what every inventory shares — every
  `hosts[]` reference exists, `address.host` is one instance's per environment, the module's
  required params fire even when a `params` block is omitted. The product's own rules come from
  `module.checkInventory({ inventory, envs, hostByName, itemLabel, instanceKind })`, which
  returns error strings: the IBM MQ module (and the test fixture module) check there that
  `rdqm-ha` has at least 3 hosts and an `address`, that `vantage: dual` with
  `profile: non-container` has `params.native_port` on every queue manager, that
  `client_port` is unique per `exporter_host` across environments (without an `exporter_host`
  the port is scoped to the environment) and `native_port` per host.
- **Adapter**: `--registry <file> --adapter <esm>`; the adapter exports `toInventory(raw)`
  (raw = the registry parsed as JSON or YAML) and its result goes through the same schema and
  semantic checks as a file.

## The module contract (`run.mjs`)

Every hook is optional; every hook receives the `ctx` object first.

| Hook | Returns |
| --- | --- |
| `instances` | `{ key, kind, label, title, schema }` — what an instance is: the inventory key (default `instances`), the kind name (`qmgr`, `broker` …; default `instance`), the live label (default: the kind), the title in messages, a schema fragment merged into `Instance` |
| `paramsSchema` | `{ site, host, instance }` JSON Schema fragments spliced into the inventory schema |
| `checkInventory({ inventory, envs, hostByName, itemLabel, instanceKind })` | the product's own inventory rules → `string[]` of errors (a throwing hook is one error) |
| `expectedKinds(ctx)` | `{ kind: { title, label, jobs, names, by, query, per, min } }` merged over the built-in expected kinds (below) |
| `packSubstitutions(ctx)` | `[{ name, find, replace, count }]` exact-count anchors over the reference pack text (`find` a string, literal, or a RegExp with `$1` replacement); counted on the reference before any is applied, applied in order, and a replacement must not introduce text a later anchor matches |
| `packRemovals(ctx)` | `[{ key, value }]` list items dropped from the site pack (`dropItem`: from `- key: value`, block or flow form, to the end of that item, everywhere it appears) |
| `runbooks(ctx)` | `{ sliId: runbookPath }` for the burn-rate alert annotations |
| `templates(ctx)` | `{ path: string \| (ctx) => string }` or `[{ path, render }]` |
| `perInstance(ctx, instance)` | the same shape, once per instance of the environment (`perQmgr` is accepted as the legacy name) |
| `boards({ pack, lib, repoUrl, site })` | dashboards `[{ id, file, dashboard }]` (gen-dashboards' shape), checked with `checkBindings` |
| `dashboardOptions(ctx)` | the `site` object `boards()` receives (default: the manifest) |
| `harness(ctx)` | stored as `manifest.harness` (what a certification harness reads from `site.json`) |
| `checks(ctx, files)` | `string[]` of errors, or `{ errors, warnings }`, over the emitted `[{ path, content }]` |
| `fleet(ctxs)` | files written at `<out>/` (only with `--env all` and more than one environment) |

`ctx`, one per environment:

| Field | Content |
| --- | --- |
| `env`, `lab`, `strict`, `environments` | the environment name, `env === 'lab'`, the strict flag, every selected environment |
| `envModel` | the resolved environment: `scrape_interval`, `vantage`, `profile`, `endpoints`, `receivers`, `secrets`, `repo_url`, `rule_labels`, `params`, `hosts[]`, `instances[]` (also under the module's key), `instanceKind` |
| `refPack`, `refPackText` | the reference pack (object, text) |
| `pack`, `packText` | the derived site pack; the reference pack while `packSubstitutions`/`packRemovals` run |
| `timing` | the Timing object below |
| `vantage`, `profile`, `p` (alias `params`), `endpoints`, `receivers`, `secrets`, `repoUrl`, `ruleLabels` | shortcuts into the environment |
| `instances[]`, `hosts[]`, `instanceKind` | the members and the module's descriptor; each instance carries its resolved `env`, `exporter_host` and `site` (`qmgrs` is the same array under its legacy name) |
| `siteOf(instance)` | the site label of an instance's hosts |
| `burn` | `{ groups, recording, forecasts, warnings, step }` from `compileBurnRules` (after derivation) |
| `manifest` | the `site.json` object (after it is built; templates may read it), including `expected` |
| `lib` | the dashboards library handed to `boards()` |

Per environment the core: builds the timing model; derives the site pack
(substitutions, removals, `validateCanonical`); compiles the burn-rate rules with
`compileBurnRules(sitePack, { step, lab: env === 'lab', runbooks, minBadSamples: 2 })`;
splices `packSnippet(recording)` into the site pack's `spec.queries.recording_rules` between
the `# --- error-budget rules, GENERATED …` marker and the end of the list, and re-validates;
asserts that every burn alert's `for:` equals the override declared for its short window;
renders templates, per-instance templates and dashboards; emits the inventory rules unless a
template already did; writes `site.json`; runs the module's checks. Any error leaves that
environment with no files, and the CLI writes nothing.

Output tree per environment (`<out>/<env>/`): `site.json`, `packs/<name>.pack.yaml`,
`prometheus/rules/<name>.burn.yml`, `prometheus/rules/<name>.inventory.yml`,
`grafana/dashboards/<file>` and whatever the module's templates return.

## Expected sets and inventory rules (`expected.mjs`)

Every partition publishes what the inventory says should be reporting, so the monitor of the
monitors can ask "is the right number of things being monitored?" against a declared answer.
`site.json` carries:

```json
"expected": {
  "generated_from": "gen-site inventory v1", "environment": "prod", "series_prefix": "ibmmq:inventory:",
  "kinds": {
    "qmgr": { "title": "queue manager", "label": "qmgr", "series": "ibmmq:inventory:qmgr", "jobs": ["ibmmq-exporter", "ibmmq-native"],
              "names": ["QMORD1", "QMPAY1"], "by": { "QMORD1": { "site": "dc1", "hosts": ["…"], "shape": "rdqm-ha" } } },
    "host": { "title": "host", "label": "host", "series": "ibmmq:inventory:host", "jobs": [], "names": ["…"], "by": { } },
    "queue": { "title": "queue", "label": "queue", "per": "qmgr", "query": "count by (qmgr) (…)", "min": { "QMORD1": 12 } }
  }
}
```

- **Enumerated kinds** carry `names`: the module's instance kind and `host` are always there;
  each gets a recording series `<svc>:inventory:<kind>` (`vector(1)`, one per name, labelled
  `<label>=<name>, environment=<env>` plus `site`/`shape` when known) and `jobs`, the scrape
  jobs whose `up` series carry that label on the live side (`[]` = any job). The module adds
  `jobs` (and may add enumerated kinds of its own) through `expectedKinds(ctx)`.
- **Counted kinds** carry a `query` (PromQL grouped `by (<per>)`, e.g. queues per queue manager)
  and optional `min` floors per parent: the inventory cannot enumerate them, so a journey
  reports the live count and breaches only below the floor.
- The core emits `prometheus/rules/<name>.inventory.yml` with the enumerated series unless a
  module template already produced that path (the IBM MQ module does, adding its
  `IBMMQQueueManagerSilent` join); an alert can join them the same way
  (`<series> unless on (<label>) up`).
- A journey (`inventory: { site: <partition>/site.json }`, see the README) compares these sets
  with the live `up` series through the MCP and records, per kind, expected / observed /
  silent / unexpected.

## The timing model (`timing.mjs`)

Inputs: the environment's `scrape_interval`, the site params, and the pack's
`spec.environments.<env>.overrides`.

```
step  = envModel.scrape_interval ?? overrides['prometheus.scrape_interval'] ?? packStepSeconds(pack)
poll  = params.exporter_poll_interval ?? overrides['exporter.poll_interval'] ?? step
probe = params.canary_interval ?? step

window3 = 3*step        gate = max(60, 6*step)     keepFiring = 6*step      subq = step
canaryShort = 4*probe   canaryHung = 12*probe      interval = timeInterval = step
scrapeTimeout = min(8, step - 2)                   evalScale = step / 10 (promtool eval_time = lab value × evalScale)
symptomFor(literal) = max(literal, overrides['alerts.symptom.for'])   (the literal when no override)
alertmanager: group_wait = overrides['alertmanager.group_wait'] ?? 5s, group_wait_sev1 = overrides['alertmanager.group_wait.sev1'] ?? 2s,
              group_interval/repeat_interval = 10s/1h for lab, 5m/4h otherwise, resolve_timeout = max(1m, 2*step)
rebudgetMttd(labExpected, forLab) = lab + (symptomFor(forLab) − forLab) + (group_wait − 5s) + 2*(step − 10s)   (seconds)
```

`dur(seconds)` prints `1m` for 60 and `<n>s` otherwise, so the lab (step 10) reproduces its
literals (`[30s]`, `[1m]`, `keep_firing_for: 1m`); a string passes through unchanged, so
values that come from an override (`2m`, `5m`) keep the spelling the pack declares.
`durM(seconds)` is the minutes-first spelling (`2m` for 120, `90s` for 90) for templates whose
lab literal is written in minutes.

The override vocabulary is closed: `prometheus.scrape_interval`, `exporter.poll_interval`,
`alerts.symptom.for`, `alerts.burn_rate.for.short_{5m,30m,1h}`, `alertmanager.group_wait`,
`alertmanager.group_wait.sev1`. Any other key under `alerts.*`, `alertmanager.*`,
`prometheus.*` or `exporter.*` is an error; other keys (`storage.*`, `otel.*`) pass through
in `timing.passthrough`. Burn-rate `for:` are what `compileBurnRules` implements
(`lab`: 30 s / 2 m / 5 m by short window, else 2 m / 5 m / 10 m); the pack declares them in
`alerts.burn_rate.for.short_*` and gen-site fails when the two disagree. `minBadSamples = 2`
is kept at every step and recorded in the manifest.

## The CLI

| Flag | Meaning |
| --- | --- |
| `--inventory <file>` | repeatable; merged |
| `--env <name\|all>` | the environment to render, or every environment present (one partition each); may be omitted only when the merged inventory has exactly one environment |
| `--pack <file>` | the reference pack (default: the unique `pack:` of the inventories, relative to the file that declares it) |
| `--module <esm>` | the pack module; without it only the site pack, the burn rules and `site.json` are emitted |
| `--registry <file> --adapter <esm>` | a raw registry turned into an inventory by the adapter's `toInventory(raw)` |
| `--out <dir>` | default `sites`; files land under `<out>/<env>/` |
| `--check` | validate, derive, self-check; write nothing |
| `--dry-run` | like `--check`, and list the files that would be written |
| `--strict` | warnings are errors |
| `--repo-url <url>` | runbook link base (default: the environment's `repo_url`) |
| `--schema <file>` | the ObservabilityPack schema (default: the vendored v1.2 schema) |

Exit codes: `0` ok, `1` validation or self-check failed (nothing written), `2` usage (bad flags,
no pack, `--env` omitted with several environments, `--env` naming an environment without
members).

## Tests and fixtures

`tools/test-gen-site.mjs` (`npm test`) runs on `tools/fixtures/site/`: a minimal pack
(`bindings.environments: [prod, lab]`, prod overrides with the closed vocabulary, one ratio and
one threshold SLI, one SLO with two policy windows, a `recording_rules` list with the GENERATED
marker, a 10 s pipeline step), a prod inventory with a file-level `env`, a lab inventory, and a
fixture module (an instances descriptor that calls them queue managers, params schema, the
product's inventory rules in `checkInventory`, `expectedKinds`, exact-count substitutions, one
template, per-instance files, a self-check, no boards). Under the lab inventory every
substitution maps a value to itself, and the test asserts the lab site pack is byte-identical
to the fixture pack.

## Vendoring

The core is `tools/lib/site/{inventory.schema.json,inventory.mjs,expected.mjs,timing.mjs,derive.mjs,run.mjs}`.
It imports only `../mini-yaml.mjs`, `../validator.mjs`, `../burn-rules.mjs` and
`../dashboards/generic.mjs`, by relative path, so a downstream copy under
`vendor/observogram/lib/site/` works unchanged next to the already vendored siblings. The
core reads no files: the host passes the pack text, the pack schema and the inventory schema in.
