# Neuron Fleet Plan: the service registry as the inventory, and a live SLO map

*The maintainer's request, verbatim: "where is the inventory?? we dont we
have an adapter to read the service's registry?" and then "we discussed that
as one of Neuron's main tasks. we should be able to get a graphical view of
the fleet, specially when there are SLOs violations". On how the three
registries relate: "one fleet model built from the three registries, with
rules for when they disagree; Not at the same time, at any given time,
there's only one source of truth configured".*

*His decisions, which this plan builds on:*

- *Registry adapters for Kubernetes Services, the Backstage catalog and
  Consul. They are pluggable, but **only one source of truth is configured
  per org at any given time**. Sources are never merged and there are no
  precedence rules between them.*
- *Switching the configured source is an explicit, audited operation that
  reconciles again. Services the new source does not know are retired,
  never deleted.*
- *Current SLO state is read **live** through the MCP when the view opens.
  Trends come from journey run history.*
- *This plan is a docs-only PR he ratifies before any code is written.*
- *Implementation comes after the STORE_PLAN slice that makes services
  records (see decision 1). The one exception is
  [HANDOVER.md](HANDOVER.md) item B's compiler prerequisite, which may
  start right after STORE_PLAN slice 2b.*

*Status: proposal. This is a plan, not a spec. It names the model, the
seams, the states, the routes, the slices, the gates and the risks.*

## 0 · Status quo: what exists and what is missing

| Concern | Today | Where | Gap |
|---|---|---|---|
| Site inventory v1 | A pack's *instances* (queue managers, brokers) and hosts per environment, loaded from YAML, merged, resolved and validated | `tools/lib/site/inventory.mjs:153` `loadInventories`, `:196` `mergeInventories`, `:302` `resolveEnvironments`; `tools/lib/site/inventory.schema.json` | Its grain is the instances *inside* one pack's product, not the services of a fleet. It knows nothing about owners, systems or lifecycle |
| Registry seam | `--registry <file> --adapter <esm>`: the adapter's `toInventory(raw)` result becomes one more inventory file | `tools/lib/site/inventory.mjs:165-176`, `tools/gen-site.mjs:61-62,88-89`, `docs/gen-site.md:202-204,334` | **No adapter exists.** The seam takes a registry *file* someone has already exported. Nothing reads a live registry |
| Inventory coverage | `silent` / `down` / `up` / `unexpected` per kind from `max by (<label>) (up{job=~…})`, with the statuses `checked`, `partial`, `not-attempted` and `failed` | `tools/lib/inventory-coverage.mjs:11-20,88-92,109`; the live half is `tools/fetch-live-pack.mjs:2729` `observeInventory` | Coverage is only as good as the declared expected set, which comes from a hand-written site. `observeInventory` borrows the `stack_self_metrics` capability (`fetch-live-pack.mjs:2732`) for its query |
| Neuron | The fleet of *saved journeys* read as one instrument: tiles, trends, the outcome heatmap, blast radius, inventory roll-up | `studio/neuron-view.mjs`, `tools/lib/neuron-model.mjs:269` `buildNeuronModel`, `:160` `blastRadiusNodes`, `:387` `fleetInventory` | The unit is the journey, not the service. There is no service map and no SLO state. The loader makes 1 + N requests (`studio/neuron-view.mjs:75-85`), which does not scale to 500 services |
| Charts | Zero-dependency SVG: line, stacked bars, step and legend | `tools/lib/svg-charts.mjs:122,157,183,205,239,272` | No grid or tile layout |
| MCP capability registry | The only place tool names live. Metrics queries ride the rows `build_info_versions`, `firing_alerts_evidence` and `stack_self_metrics`; rule listings ride `alert_rules` | `tools/lib/contracts/mcp-capabilities.mjs:83,175-207`, `capabilityTool` `:296`; the guard is `tools/test-contract-guard.mjs:47` (an explicit file list) and `:51` (literals in call positions) | No capability means "read SLO state" |
| SLO records | Per SLO: `<prefix>:errorbudget:burn_5m` / `burn_1h`, labels `{ slo, sli, service }` only. Every counter leg is `sum(increase(sel[w]))` with no `by`, so any environment label is aggregated away. Per threshold SLI: `<prefix>:<sli>:error_ratio_5m` | `tools/lib/burn-rules.mjs:141` `RECORD_WINDOWS`, `:403-404` (the wrap), `:512` `errorBudgetRecordingRules`, `:554` labels; `tools/lib/compile.mjs:62` (`RECORDING_INTERVAL = '30s'`), `:370-382` | **No window-long error ratio and no budget remaining** (item B's prerequisite). A 30-day budget cannot be read from 5 m and 1 h burn rates. **No record is split by environment** |
| Burn and forecast alerts | Burn alerts: labels `{ severity, slo, sli, service, burn_rate, window_short, window_long, pack }`, groups `<svc>_<slo>_burn`. Forecasts add `kind: 'forecast'` | `compile.mjs:469-503,529`, `burn-rules.mjs:588-601,616` | Burn alerts live in their own groups, so a backend can hold the records without the alerts |
| Service label | Compiled records carry `service = metadata.name ‖ bindings.service` and the record prefix `metricPrefix(name)`. No org or pack-id label | `tools/lib/compile.mjs:116-118,217-218,379`, `tools/lib/slug.mjs:34` | This is the only join key between a pack and its series, and it is not unique on a shared backend. Nothing joins either one to a registry |
| Blast radius | The transitive consumers of a degraded node: structural exposure. A run record keeps **counts** per node (`slos`, `alerts`, … `total`), not which SLOs | `tools/lib/blast-radius.mjs:161,168`, `tools/lib/chain-history.mjs:77-81` `blastSummary`, `neuron-model.mjs:160-184` | Per journey, not per SLO. Reused as it is (§9.2, §9.3) |
| Store (in flight) | `services` (`org_id`, slug `UNIQUE(org_id, slug)`, name, owners, tier), `environments` (per service, `mcp_endpoint_id`), `mcp_endpoints` (url, `read_token_env`, syntax-checked only), `pack_services` (`role IN ('primary','member')`, one primary per pack) | `server/store/migrations.mjs:74-132`, `server/store/services.mjs:42-88`, `server/store/environments.mjs:48-58`, `server/store/mcp-endpoints.mjs:19-47`; [STORE_PLAN.md](STORE_PLAN.md) §2, §5, §7 | Repositories with no callers until STORE_PLAN slice 4. A service has no source and no retirement. `deleteService` cascades (`services.mjs:78`). A token env name may be any variable of the server process (`mcp-endpoints.mjs:41-47`) |
| SSRF gate | `validateMcpUrl`: http(s) only, credentials stripped; private and link-local addresses **allowed by default** and logged; no DNS resolution | `server/mcp-url.mjs:7-14,42-60` | Not enough for a credentialed fetch to an admin-typed URL (§1) |
| Journeys → service | A journey may name `service:` and `env:` | `tools/lib/journey.mjs:21-27` | Nothing links a journey to a service record |

The missing piece is exactly what the maintainer named: nothing reads the
registry the organisation already keeps. Every fleet-level surface stops at
"the packs someone registered" or "the journeys someone saved".

## 1 · The shape

- **One fleet per org, read from one configured source.** A source is one
  of four kinds. `observogram` is the default: services are the store's own
  hand-made rows, as STORE_PLAN slice 4 ships them. The other three are
  `kubernetes`, `backstage` and `consul`.
  - Exactly one source is active per org. This is enforced in the schema
    (§5), not by convention.
  - The fleet is never a merge of two sources. A Kubernetes source may read
    several clusters and a Consul source several datacenters: that is one
    source of one kind, not two sources (§3.1, §3.3).
  - "Rules for when they disagree" are therefore rules for **a switch**
    (§4.3) and for **disagreement inside the one source** (§2.3). There is
    no rule for disagreement between two live sources, because two are
    never live together.
- **Three layers, split along the browser-safe line.**
  - **Pure and browser-safe, in `tools/lib/fleet/`:** the normalised model
    and its validation (`model.mjs`); one pure mapper per adapter, from raw
    API pages to fleet entries (`map-kubernetes.mjs`, `map-backstage.mjs`,
    `map-consul.mjs`); the reconciliation plan (`reconcile.mjs`, which
    diffs the mirror against the entries and returns the writes, and
    performs none); the SLO state machine and query builder
    (`slo-state.mjs`); and the map layout (`fleet-map.mjs`). None of them
    imports `node:*`, and all of them are tested under `node:test` over
    recorded fixtures.
  - **Node, in `server/fleet/`:** one fetcher per adapter, all on
    `node:https` / `node:http` through one `registry-fetch.mjs` (below);
    the sync job; and the routes. The live SLO reader is
    `tools/fleet-live.mjs`, next to `observeInventory`. It reuses
    `createMcpClient` (`tools/fetch-live-pack.mjs:106`) and resolves every
    tool through the capability registry.
  - **The store:** the source record, the sync log and the source columns
    on `services` and `environments` (§5). Only repositories write SQL
    (STORE_PLAN §1).
- **No new dependency.** Kubernetes is read through its REST API. Backstage
  and Consul are read over HTTP. Everything uses `node:` built-ins.
- **Secrets are env-var names only**, as with the journeys'
  `urlEnv`/`authEnv` (`tools/lib/journey.mjs:188-198`) and
  `mcp_endpoints.read_token_env`.
  - A source's config holds URLs, label keys, mappings and env **names**,
    never a token. A URL with userinfo or a credential-looking query
    parameter is refused by the same rule as `mcp_endpoints`
    (`server/store/mcp-endpoints.mjs:19,33-36`), without echoing the URL.
  - **A stored env name must match `OBSERVOGRAM_ORG_<KEY>_[A-Z0-9_]+`,
    unconditionally**, where `<KEY>` is the org id upper-cased with `-`
    written `_` (org ids are slugs, `server/store/orgs.mjs:36`). This holds
    in a single-org deployment too. Journey `authEnv` is written by whoever
    holds the repo; a source's `tokenEnv` is typed by a web admin, who must
    not be able to name `OBSERVOGRAM_SESSION_SECRET` or
    `OBSERVOGRAM_OIDC_CLIENT_SECRET` and have the server send its value to a
    URL they chose. No server knob uses the `ORG_` suffix today (every
    `brandEnv(…)` key was checked), and a gate keeps it so. Two org ids
    whose keys collide (`a-b`, `a_b`) cannot store a token env name; the
    refusal names the collision. Decision 5 extends the rule to
    `mcp_endpoints.read_token_env`.
- **The registry fetch rule** (`server/fleet/registry-fetch.mjs`). A
  credentialed fetch to an admin-typed URL needs more than
  `validateMcpUrl`, which allows private and link-local addresses by
  default and resolves no names (`server/mcp-url.mjs:7-14`):
  - http(s) only, credentials stripped, as `validateMcpUrl`;
  - the hostname is resolved once with `node:dns` `lookup({ all: true })`;
    every address is checked, and the connection goes to the checked
    address through the request's `lookup` option, so a second resolution
    cannot swap it;
  - link-local (`169.254.0.0/16`, `fe80::/10`) and the cloud metadata
    addresses are **always** refused, whatever `OBSERVOGRAM_ALLOW_LOCAL_MCP`
    says;
  - loopback and private ranges are refused unless the deployment lists
    them in `OBSERVOGRAM_FLEET_PRIVATE_CIDRS` (for example `10.0.0.0/8`).
    Registries are usually internal, so the deploy docs show it. It is an
    env var, so only whoever runs the deployment sets it;
  - redirects are never followed: any 3xx is a failure named by its status,
    never its `Location`. A registry header (`Authorization`,
    `X-Consul-Token`) therefore never reaches a second host;
  - the in-cluster Kubernetes address bypasses the private-range rule only
    through the `in-cluster` credential mode (§3.1), which is owner-only.
- **The fleet model is not the site inventory.** gen-site's
  `toInventory(raw)` seam stays as it is, for a pack's instances. A registry
  adapter produces *services*. The two meet only through the pack a service
  links to, never by an adapter writing an inventory file.

## 2 · The normalised fleet model

### 2.1 An entry, as an adapter emits it

```text
FleetEntry {
  sourceKey     string  -- stable key of the object inside the source (§2.2); stored on the environment row; never shown as the name
  service       string  -- the service identity inside the source (§2.2), normalised with service-keys.mjs; the store slug
  name          string  -- display name
  telemetryName string  -- the value the live series carry for this service (§2.4)
  environment   string? -- resolved by the source's environment rule (§3); null = the rule found none
  owner         string? -- null = the source does not say. Never defaulted
  system        string? -- null = the source does not say
  lifecycle     'production' | 'experimental' | 'deprecated' | 'unknown'
  labels        { [k]: string }  -- filtered to the configured keys, capped at 32 entries of 256 chars
  dependsOn     string[]         -- entity refs; only Backstage fills it; stored, not drawn in v1 (§9.2)
  folded        string[]         -- the other source keys folded into this entry (§2.3)
}
```

`null` and `unknown` mean "the source does not say". The view prints
"owner not in Backstage", never a blank that reads as "nobody".

### 2.2 Identity inside the one source

A **service** is the set of entries that share `service`. An **environment
of that service** is the `environment` of each entry. So `checkout` in the
`prod` and `staging` namespaces is one service with two environments, not
two services.

**The store row is keyed on the slug**, which is `service`
(`UNIQUE(org_id, slug)`, `server/store/migrations.mjs:84`). The source's own
object keys live on the environment rows only. No source offers rename
tracking: a Kubernetes Service name is immutable and a delete-and-recreate
mints a new `metadata.uid`; a Backstage rename is a new entity ref; Consul
has no uid. So a renamed service is a retirement plus a creation, and the
plan claims nothing more.

| Source | `sourceKey` | `service` defaults to | Override |
|---|---|---|---|
| Kubernetes | `<cluster>/<namespace>/<name>` | label `app.kubernetes.io/name`, else the Service name | config `identity.label` |
| Backstage | the entity ref `component:<namespace>/<name>` | `metadata.name` | annotation `observogram.dev/service` |
| Consul | `<datacenter>/<partition>/<namespace>/<name>` (the default partition and namespace are written `default`) | the service name | `ServiceMeta["observogram-service"]` |

Normalising is `tools/lib/service-keys.mjs`, which STORE_PLAN slice 4
ships. It is the same function the studio's `normalizeServiceKey` inlines
today (`studio/app.mjs:210`).

### 2.3 Disagreement inside the one source

A source can contradict itself. The rule is to **report, never invent a
precedence**.

| Case | Result |
|---|---|
| Several objects of one *workload* (Kubernetes: Services sharing identity, cluster and namespace, such as `checkout`, `checkout-headless`, `checkout-metrics`; Consul: the instances of one service in one datacenter, partition and namespace) | **Folded** into one entry: labels unioned, the lowest key kept as `sourceKey`, the rest listed in `folded`. No conflict unless their owner, system or lifecycle actually differ; then the field follows the row below |
| Two entries still map to the same (service, environment) after folding (for example two namespaces mapped to `production`) | The entry with the lowest `sourceKey` in byte order is kept, so the result is deterministic. The sync reports a `duplicate` conflict naming both keys. The drill-down lists it; the map carries no mark for it (§9.2) |
| The entries of one service disagree on `owner`, `system` or `lifecycle` | The field is `null` with `conflict: [values…]`. The view says "owner conflicting in source: team-a, team-b". Its environments keep their own values in the drill-down |
| An entry has no environment and the rule has no default | Skipped with a `no-environment` note in the sync report. It never lands in a made-up environment |
| An entry's `service` normalises to an empty slug | Skipped with an `invalid-identity` note |

### 2.4 Matching a service to its pack, its SLOs and its series

The joins, in order:

1. **Service ↔ pack** goes through `pack_services` (STORE_PLAN §2), which
   is Observogram-owned. A sync *proposes* a link when a registered pack's
   `metadata.name` or `bindings.service` normalises to the service's slug
   (the same fields as `serviceMetadata`, `server/index.mjs:318`). A link is
   written automatically only when exactly one pack matches, and then with
   role `primary`. Zero or several matches leave the service `unlinked`, and
   the drill-down lists the candidates for an operator to pick.
2. **Pack ↔ SLOs: only through a `primary` link.** A pack's compiled
   records carry `service = <the pack's name>`, not the member service's
   (`compile.mjs:116-118,379`), and a pack is not always one service
   (STORE_PLAN §2, `pack_services.role`). So the SLOs of an aggregate pack
   `core` with members `payments`, `ledger` and `fx` belong to `core`'s
   primary service only. A member-linked cell reads `no-slo` with the note
   "SLOs belong to aggregate pack core", and the drill-down lists them
   under that heading. The pack schema has no per-SLO service field, so
   there is no finer attribution to make.
3. **SLO ↔ live series** come from the compiled records:
   `<metricPrefix(pack name)>:errorbudget:…{slo="<id>", service="<pack name>"}`.
   The join never guesses from the registry name. It goes registry service
   → primary-linked pack → the pack's own name.
4. **Environment ↔ series.** Each environment row is read through its own
   MCP endpoint (`environments.mcp_endpoint_id`). Two topologies work:
   - **One backend per environment.** The backend *is* the environment. No
     matcher is needed.
   - **A shared backend whose series carry an environment label that
     survives rule evaluation**: rules evaluated per environment (a
     Prometheus or vmagent per environment with an `external_labels`
     entry, remote-writing to one store). The environment row names that
     label as `series_matcher: { label, value }`, and the reducer splits the
     answer by it.

   **A rule evaluated centrally** (a Mimir ruler or vmalert over a shared
   TSDB) blends every environment into one record, because the legs carry
   no `by` (`burn-rules.mjs:403-404`). The reader checks that every record
   it attributes carries the matcher's label. When it does not, the cells
   read `unknown`, "records carry no `<label>`: evaluated centrally, not
   split by environment". A blended series is never read as one
   environment's. Per-environment records from the compiler are decision 8.
5. **Service ↔ presence** (is anything answering at all?) uses
   `telemetryName` against one configured label, `match.label`, which
   defaults to **`job`**. Prometheus's OTLP receiver writes `service.name`
   (prefixed `<service.namespace>/` when set) into `job`, and
   prometheus-operator scrapes set `job` too. The presence series is
   `target_info` for OTLP-pushed services (they have no `up`), else `up`.
   `service_name` exists only with `promote_resource_attributes` or a
   collector exporter using `resource_to_telemetry_conversion`, so it is an
   option, and `packc fleet preview` reports which label actually carries
   the registry's names (§12 F4). Each adapter reads a per-service override
   from the annotation, label or meta key `observogram.dev/telemetry-name`.
   This is the inventory-coverage vocabulary (`inventory-coverage.mjs:11-20`)
   applied to fleet services: `silent` means registered but no series, and
   `unexpected` means series with no registered service.
6. **Journey ↔ (service, environment).** The journey's `service:` and
   `env:` (`journey.mjs:21-27`) come first. Otherwise its Pack A's primary
   service through `pack_services`, with the environment from `env:`. A
   journey that matches no cell, or several, is listed as unlinked. It is
   never attached to a cell by a guess.

## 3 · The three adapters

Every fetcher returns `{ complete: boolean, parts: [{ name, complete, pages, error? }], entries, notes }`.
A part is a cluster or a datacenter; `complete` is true only when every page
of every part was read without error. §4 retires nothing on an incomplete
read, and never retires an entry of an incomplete part.

### 3.1 Kubernetes Services

| | |
|---|---|
| Clusters | `clusters: [{ name, mode: 'in-cluster' \| 'token', apiUrl?, tokenEnv?, caFile? }]`, one or more. `name` is the `<cluster>` of `sourceKey`. At most one cluster is `in-cluster` |
| Endpoint | `GET /api/v1/services`, cluster-wide, or `GET /api/v1/namespaces/<ns>/services` for each configured namespace. With `labelSelector` from config. `GET /api/v1/namespaces` only when the environment rule reads namespace labels |
| Excluded by default | `default/kubernetes`, and the namespaces `kube-system`, `kube-public` and `kube-node-lease` (`exclude.namespaces`, configurable) |
| Auth | **`in-cluster`**: the token at `/var/run/secrets/kubernetes.io/serviceaccount/token` (re-read on every sync, because projected tokens rotate), the CA `ca.crt` beside it, and `KUBERNETES_SERVICE_HOST`/`_PORT`. **`token`**: an API URL, a bearer token read from an env **name** (§1), and a CA read from `caFile`, which must be a file name inside `OBSERVOGRAM_FLEET_CA_DIR` (a directory whoever runs the deployment sets), else the system store. The CA's contents are never echoed; a parse error says "CA file unreadable or not PEM". No kubeconfig parsing. RBAC: `get`/`list` on `services` (and `namespaces`). The deploy docs ship that ClusterRole |
| Pagination | `limit=500` with `continue`. A `410 Gone` (an expired continue token) restarts the list once; a second 410 makes that cluster incomplete |
| Rate | Self-limited to 5 requests/s per cluster (client-go's default QPS), one sync at a time per org |
| Environment rule | In order: the value of `environment.label` (default `environment`) on the Service; the namespace through `environment.namespaces: { prod: production, … }`; a namespace label; the cluster's `environment`; the source's `environment.default`. The first that answers wins, and a Service none answers is skipped (§2.3) |
| Owner / system / lifecycle | From configured annotation or label keys (defaults `observogram.dev/owner`, `app.kubernetes.io/part-of`, `observogram.dev/lifecycle`), else `null` / `unknown` |
| Failure modes | 401/403 (the token or RBAC), named with the verb and resource; TLS failure; timeout (10 s per page); a 5xx; a 3xx (never followed) |
| Can tell | That the Service exists now, its namespace, labels and selector |
| Cannot tell | Ownership unless annotated, lifecycle, dependencies, or whether the backing pods run (a Service with no endpoints is still listed; presence in §6 answers that) |

### 3.2 Backstage catalog

| | |
|---|---|
| Endpoint | `GET /api/catalog/entities/by-query?filter=kind=component[,spec.type=service]&limit=200&fields=kind,metadata,spec,relations`, then `cursor=<pageInfo.nextCursor>`. `filter` is extendable from config |
| Auth | `Authorization: Bearer <value of tokenEnv>`: a Backstage static external-access token, read-only |
| Pagination | Cursor-based; stops when `nextCursor` is absent. `totalItems` is checked against the entries counted, and a mismatch is noted but not fatal (the catalog moved during the read) |
| Minimum version | A backend with `by-query`. A 404 on it refuses with "this Backstage has no entities/by-query; upgrade", rather than falling back to the offset API |
| Rate | Pages read one after another, at most 4 requests/s |
| Environment rule | Backstage has no environment on a component. The environments come from the annotation `observogram.dev/environments: prod,staging` (one entry per environment) or from the source's `environment.default`. Otherwise skipped |
| Owner / system / lifecycle | `spec.owner` and `spec.system` are entity refs, often written short (`team-pay`). They are normalised to the full ref, `group:default/team-pay` for an owner and `system:default/payments` for a system, with Backstage's own defaults for a missing kind and namespace, and shown short when the namespace is `default`. `spec.lifecycle`: `production` / `experimental` / `deprecated`, anything else `unknown` |
| Relations | `relations[type=dependsOn]` to other components becomes `dependsOn` |
| Failure modes | 401/403; a 404 on `by-query`; a 5xx; a 3xx; a malformed page (schema-checked like any input) |
| Can tell | Ownership, system, lifecycle, declared dependencies |
| Cannot tell | Whether anything runs. A catalog is declarative, so `silent` (§2.4) is where a stale catalog shows |

### 3.3 Consul

| | |
|---|---|
| Endpoint | `GET /v1/catalog/services?dc=<dc>` for names and tags, then `GET /v1/catalog/service/<name>?dc=<dc>` per service, which answers **one element per instance**, each with its own `ServiceMeta`. Datacenters come from config, or from `GET /v1/catalog/datacenters`. With `enterprise: true` in config, `ns=*` and `partition=<p>` are sent (Enterprise-only parameters; never sent otherwise) |
| Instances | Folded per (datacenter, partition, namespace, name) into one entry (§2.3). Meta that differs between instances raises the §2.3 conflict on that field |
| Auth | `X-Consul-Token: <value of tokenEnv>`, an ACL token with `service:read` (and `node:read` for the per-service call) |
| Pagination | None; a catalog answer is whole. The per-service calls are N + 1, so they run with concurrency 4 and a cap (default 2,000 services per datacenter; past it that datacenter is incomplete, and the report names the cap) |
| Change detection | The `X-Consul-Index` of each list call is kept on the sync. An unchanged index skips the per-service calls and marks the sync `complete-unchanged` |
| Rate | At most 10 requests/s. `?stale` is allowed, and `X-Consul-LastContact` above 10 s is noted as a stale read |
| Environment rule | `ServiceMeta["environment"]`, else the datacenter through `environment.datacenters: { dc1: production }`, else `environment.default`. The `consul` service itself is excluded |
| Owner / system / lifecycle | Configured `ServiceMeta` keys (defaults `owner`, `system`, `lifecycle`), else `null` / `unknown` |
| Failure modes | 403 (ACL), 500 "No cluster leader", a 3xx, a datacenter that does not answer (that datacenter is incomplete) |
| Can tell | Registered services, tags and meta, per datacenter |
| Cannot tell | Ownership unless in meta, lifecycle, dependencies (mesh intentions are out of scope) |

## 4 · Reconciliation into the store

### 4.1 Mirrored and owned fields

| Field | Owner when the source is external | Owner when the source is `observogram` |
|---|---|---|
| existence, slug, name, owners (`[owner]`), system, lifecycle, labels, environment membership | **the source**, mirrored read-only. The API refuses edits with 409 "change it in <source>" | Observogram (STORE_PLAN slice 4 CRUD) |
| tier (criticality), pack links, each environment's MCP endpoint and `series_matcher`, description | **Observogram**, always. They survive every sync and every switch | Observogram |

While an external source is active, creating a service by hand is refused
with 409, naming the source. That is what "one source of truth" means at
the API.

**Environment bindings by default.** A 500-service registry yields about
1,500 environment rows, and binding each by hand would leave the map grey.
The source's config therefore carries a default per environment name:

```text
environments: { production: { mcpEndpoint: "<mcp_endpoints.name>", seriesMatcher: { label, value }? }, … }
```

A sync applies it to every environment row whose binding is null (new, or
never bound). A binding set on the row itself is never overwritten. A
default naming an MCP endpoint the org does not have is a config error at
preview.

### 4.2 A sync

Syncs run on demand, and periodically in the server (default every 10 min
per org, under `runWithOrg(id)` as STORE_PLAN §1 requires for code outside a
request, with the actor `system:fleet-sync`). The CLI and the journey
CronJob never open the database (STORE_PLAN §8 "Journey engine" gate
holds). Each sync:

1. **Fetches outside any transaction.** `tx()` must stay synchronous
   (STORE_PLAN §1).
2. Maps the pages to entries with the pure mapper, then plans with
   `reconcile.mjs`. The plan lists `create`, `update` (mirrored fields),
   `retire`, `return` (unretire), `bind` (§4.1 defaults) and `conflicts`.
3. **Retires nothing unless the read was complete.** A partial read applies
   creates and updates, retires nothing, and the sync reads `partial`.
4. **Holds with the retire brake.** A complete read that would retire more
   than 20 % of the active services, or all of them (an empty answer from a
   mis-scoped token), is stored as `held` and applies nothing. An admin
   releases or discards it.
5. Applies the plan in **one `tx()`** with its audit row (§5).

**When a service disappears from the source**, it is retired: `retired_at`
is set, its mirrored fields are frozen as last seen, and its pack links,
journeys, runs and audit stay. It is hidden from the map by default. **When
the same slug comes back, the retired row returns** (`retired_at` cleared)
with its owned fields intact. Under `UNIQUE(org_id, slug)` this is the only
possible outcome, and it is the intended one: a new, different `checkout`
inherits the old one's tier and links, which the drill-down shows as
"returned <t>, last seen <t>" so an operator can review them. An
environment missing from a still-present service is retired the same way
(`environments.retired_at`). Nothing a sync does deletes a row.

### 4.3 Switching the source

The switch is the only place two sources meet, and they meet only as
**before and after**:

1. **Preview.** `POST /api/fleet/source/preview` reads the new source,
   plans against the current mirror and writes nothing. It returns counts
   and lists of services that would be `adopted` (the same slug exists: the
   row is kept and re-pointed), `created` and `retired` (known to the old
   source and not to the new one), the bindings the defaults would set, plus
   the new source's conflicts.
2. **Commit.** `PUT /api/fleet/source` carries the same config and the
   preview's `planHash`. If the source's answer changed since the preview,
   the hash no longer matches and the call answers 409 with the new plan.
   In one `tx()`:
   - the old source row gets `active = 0` and `deactivated_at`;
   - the new row is inserted active;
   - adopted rows get the new `source_id`, and their environment rows the
     new `source_key`; their mirrored fields are overwritten by the new
     source (the new source *is* the truth);
   - owned fields are untouched;
   - unmatched rows are retired;
   - new rows are created;
   - the audit rows are written.
3. **The retire brake does not apply** to a committed switch, because the
   preview is the confirmation. A partial read refuses to commit a switch
   at all: a switch must never retire on half an answer.
4. **Switching back to `observogram`** keeps every row active as a
   hand-made record: nothing is retired, the source columns are cleared and
   the mirrored fields become editable.

## 5 · Store additions (one migration, after STORE_PLAN slice 4)

```text
fleet_sources   id PK, org_id FK NOT NULL, kind NOT NULL CHECK (kind IN ('observogram','kubernetes','backstage','consul')),
                config JSON NOT NULL,          -- URLs, keys, mappings, env NAMES (§1 rule), environment defaults (§4.1);
                                               -- refused if it holds a token-looking value
                in_cluster INTEGER NOT NULL DEFAULT 0,   -- set only through the owner routes (§10)
                active INTEGER NOT NULL, created_at, created_by, deactivated_at NULL;
                UNIQUE INDEX one_active ON fleet_sources (org_id) WHERE active = 1
fleet_syncs     id PK, org_id FK, source_id FK, actor NOT NULL, started_at, finished_at,
                status CHECK (status IN ('complete','complete-unchanged','partial','failed','held','discarded')),
                counts JSON, conflicts JSON, notes JSON, parts JSON, plan JSON NULL (held only),
                error_class NULL CHECK (error_class IN ('auth','tls','timeout','redirect','refused-address','upstream-5xx','malformed','cap')),
                error NULL,                    -- redacted with redactCredentials, trimmed; never an upstream body
                cursor JSON NULL               -- Consul X-Consul-Index per datacenter
services        + source_id FK NULL, source_attrs JSON NULL
                  (system, lifecycle, labels, conflicts, dependsOn), last_seen_at NULL, retired_at NULL, returned_at NULL
environments    + source_key NULL, source_folded JSON NULL, last_seen_at NULL, retired_at NULL;
                  UNIQUE (service_id, source_key) WHERE source_key IS NOT NULL
mcp_endpoints   + tenant_matcher JSON NULL     -- { label, value } for a backend shared across orgs (§6.4)
```

- **One active source per org** is a partial unique index, so a race
  between two switches cannot leave two active.
- **The org default.** An org with no `fleet_sources` row reads as
  `observogram`.
- **`deleteService`** (`services.mjs:78`) refuses a source-backed row.
  Retirement is the only removal a source causes.
- **`fleet_syncs` retention.** The last 100 rows per org are kept.
- **Audit rows.** They commit in the same `tx()` as their writes
  (STORE_PLAN §5). STORE_PLAN §2 bounds audit growth by "the rate of human
  and CI actions", so a timer writes only when something happened:
  - `fleet.source.set`: detail `{ from, to, planHash, counts }`;
  - `fleet.sync` only when the applied plan is non-empty, or the sync is
    `held` or `failed` (a failed sync writes once per run of failures, not
    once per tick): detail `{ status, counts, retired[], returned[], created[] }`,
    lists capped at 200 slugs plus a count. The periodic sync's actor is
    `system:fleet-sync`;
  - `fleet.sync.release` and `fleet.sync.discard` for a held plan;
  - `service.link` when a sync writes a `pack_services` link automatically.

## 6 · Live SLO state

### 6.1 The capabilities

A new row in `tools/lib/contracts/mcp-capabilities.mjs`, in **its own
commented section** (not under the `stack_self_metrics` block, whose comment
forbids SLO verdicts, `:194-199`): **`slo_state`**, kind `evidence`,
`responseShape: 'instant-vector'`. Its one candidate is the same
metrics-query tool the `stack_self_metrics` row carries, so the tool-surface
snapshot in `tools/test-contract-guard.mjs` does not move. The existing
**`alert_rules`** row (`:83`) confirms that burn alerts are loaded (§6.3).

`tools/fleet-live.mjs` resolves both with `capabilityTool(…)` and is added
by name to the guard's explicit `GUARDED_FILES` list (`:47`). It calls tools
only through `callTool(`/`cachedCall(` positions, which the guard's regex
(`:51`) scans. No other new file calls an MCP tool; `server/fleet/*` talks
to registries, not to MCPs.

Aside, not in scope: `observeInventory` borrowing `stack_self_metrics`
(`fetch-live-pack.mjs:2732`) would read more honestly under its own row.
It is noted in HANDOVER §5 as debt.

### 6.2 The queries: a fixed number per MCP endpoint, not per service

A Prometheus-API instant query stamps every sample with the evaluation
time, so a sample's age is read with `timestamp()`. Each record family is
read once, with its clock:

| # | Query | Gives |
|---|---|---|
| 1 | `{__name__=~".+:errorbudget:(remaining\|error_ratio_window\|window_coverage)"}` | the window family (§7): budget remaining, window error ratio (availability is 1 − it), coverage |
| 2 | `timestamp({__name__=~".+:errorbudget:remaining"})` | the window family's sample time (the three records share one group) |
| 3 | `{__name__=~".+:errorbudget:burn_(5m\|1h)"}` | current burn (already compiled) |
| 4 | `timestamp({__name__=~".+:errorbudget:burn_1h"})` | the burn family's sample time |
| 5 | `ALERTS{alertstate="firing", slo!="", burn_rate!="", kind!="forecast"}` and, in the same call, `or ALERTS{alertstate="firing", kind="forecast"}` | burn alerts firing (labels per `compile.mjs:495-503`); forecasts, told apart by `kind` |
| 6 | `count by (<match.label>[, <env label>]) (target_info) or max by (<match.label>[, <env label>]) (up)` | presence (§2.4) |
| 7 | the `alert_rules` capability, cached 10 min per endpoint | which packs' burn alerts are loaded (§6.3) |

- **No matcher is appended in PromQL.** The answer is split in the reducer
  by `series_matcher.label` (§2.4 step 4), so several environments on one
  endpoint cost no extra calls, and a record that lacks the label is seen
  as such instead of reading as absent.
- **A backend that refuses a `__name__` regex** (it answers with an error,
  not an empty vector) falls back to explicit names of the linked packs,
  `or`-joined 100 per query. Its cost per endpoint is
  ⌈packs / 100⌉ × 4 + 3 calls: 23 for 500 packs. The reason goes on the
  state's `detail`.
- **The per-view budget:** 7 calls per endpoint on the regex path, with a
  ceiling of **60 calls** per view load (`OBSERVOGRAM_FLEET_MAX_CALLS`,
  server-side). Endpoints past the ceiling read `unknown` with the reason
  "query budget (60) reached". 500 services on 3 endpoints cost 21 calls on
  the regex path and 69 on the fallback, so the third fallback endpoint
  hits the ceiling; the gate proves both numbers.
- **The cache.** Answers are cached per (org, endpoint) for 30 s, the
  interval of the fastest family read (the burn records, `compile.mjs:62`).
  The window family changes every 2 min, so a 30 s TTL never serves it past
  its own staleness threshold. Reopening the view or several viewers do not
  multiply calls. The response carries `readAt` per endpoint.
- Tokens come from `mcp_endpoints.read_token_env`, resolved server-side.
  The browser never talks to an MCP.

### 6.3 States: a missing measurement is never green

Per (service, environment, SLO). "Fresh" is per family: burn samples no
older than 60 s (2 × 30 s), window samples no older than 4 min (2 × 2 min),
both read from queries 2 and 4. A sample older than the backend's lookback
(5 min by default) is not returned at all and reads as absent.

| State | When |
|---|---|
| `breached` | `remaining ≤ 0`, fresh, with coverage of at least 0.5 |
| `burning` | not breached, and a burn alert (query 5) for this `slo` and `service` is firing. A firing *forecast* alone is a note, not `burning` |
| `met` | `remaining > 0`, fresh, coverage ≥ 0.9, **and** query 5 succeeded, **and** the pack's burn alerts (`<slo>_burn_<factor>x_<short>_<long>`, `compile.mjs:483`) are confirmed loaded through query 7. A pack whose policy declares no burn alerts for this SLO needs no confirmation; the cell notes "no burn alerts declared" |
| `met-partial` | as `met`, with coverage between 0.5 and 0.9. Drawn as `met`, and the trust ring (§9.2) says "window partly measured" |
| `unknown` | anything else, **with a reason**: the environment has no MCP endpoint; the capability is not advertised (`not attempted`, the inventory wording); a query failed (its class, §9.4); the series is absent; the sample is `stale`; records carry no `<label>` (§2.4 step 4); series ambiguous on a shared backend (§6.4); coverage < 0.5; the query budget was reached; the pack has no window record yet (compiled before §7); burn alerts not confirmed loaded (the `alert_rules` capability is not advertised, failed, or does not list them) |
| `no-slo` | structural: the service has no primary-linked pack, or its pack has no budgeted SLO, or it is a member of an aggregate pack (§2.4 step 2). This is not a claim about the service. It is drawn as an empty outline |

- **Rollup.** A cell (service × environment) takes the worst of its SLOs,
  in the order `breached` > `burning` > `unknown` > `met-partial` > `met`,
  and carries counts ("2 met · 1 unknown"). Because `unknown` outranks
  `met`, one unmeasured SLO keeps the cell from reading healthy.
- **Presence is a separate fact.** A `silent` service keeps its SLO state
  (usually `unknown` / absent) and gains a "registered, nothing answering"
  mark. Presence is never folded into the SLO colour.
- **Three clocks, all labelled.** The mirror shows "fleet from <source> as
  of <last complete sync>". Live state shows "read <t>" per endpoint.
  Trends show "journey runs to <t>". The view never mixes a live number into
  a run series or the other way round.

### 6.4 A backend shared by more than one org, or by two packs of one name

Records carry `service = <pack name>` and no org or pack id (§0), so two
orgs that each register a pack `checkout` on one backend would read each
other's budgets.

- **Detection.** When an org's MCP endpoint URL (normalised, credentials
  stripped) is registered in another org, the repository says only
  `shared: true`, never which org. A shared endpoint needs a
  `tenant_matcher: { label, value }` (an external label the tenant's rules
  carry); the reducer keeps only series carrying it. Without one, every cell
  on that endpoint reads `unknown`, "endpoint shared with another org; no
  tenant matcher", and `unexpected` (§2.4 step 5) is not computed there, so
  no other tenant's service names are shown.
- **The backstop,** since two different URLs can reach one backend: when
  more than one series answers for one (service, slo, environment) after
  every matcher, or two primary-linked packs on one endpoint share a name,
  the cells read `unknown`, "series ambiguous on a shared backend". The
  first number is never picked.
- A compiler-stamped pack-id label would make this exact; it is decision 8's
  sibling and out of v1.

## 7 · Item B's compiler prerequisite, spelled out

This work is allowed to start right after STORE_PLAN slice 2b. It touches
no store.

For each budgeted SLO whose SLI has an error-ratio form (the condition
`errorBudgetRecordingRules` uses, `burn-rules.mjs:512-519`), with labels
`{ slo, sli, service }` and the prefix `metricPrefix(name)`. Reading 30 days
of 30 s samples at each evaluation costs about 86,400 samples per series,
so the records are **hierarchical**: hourly sub-records every 5 min, and
window records that sum the sub-records.

| Group (interval) | Record | Expr |
|---|---|---|
| `<svc>_errorbudget_hour` (5m) | `<prefix>:errorbudget:bad_1h`, `:total_1h` | counter SLIs: the bad and total legs over 1 h, as `errorRatioAt` builds them. State and threshold SLIs: `:error_ratio_1h`, whose expected-sample denominator is uniform |
| | `<prefix>:errorbudget:coverage_1h` | `count_over_time(<prefix>:errorbudget:burn_5m{slo="<id>"}[1h]) / 120`, capped with `clamp_max(…, 1)` |
| `<svc>_errorbudget_window` (2m) | `<prefix>:errorbudget:error_ratio_window` | counters: `sum_over_time(bad_1h[<window>]) / sum_over_time(total_1h[<window>])` (every hour is counted twelve times in both, which cancels). State and threshold: `avg_over_time(error_ratio_1h[<window>])` |
| | `<prefix>:errorbudget:remaining` | `1 - error_ratio_window / <1 - objective>`. It goes negative when overspent and is never clamped, so the ledger can say "overspent by 40 %" |
| | `<prefix>:errorbudget:window_coverage` | `clamp_max(sum_over_time(coverage_1h[<window>]) / <window / 5m>, 1)`. A missing sub-record counts as 0, not skipped. A 30 d SLO on a 7 d retention reads about 0.23, so it is `unknown`, not a fabricated budget |

Each evaluation of a window record reads 8,640 samples per series for a
30 d window, a tenth of the naive form. The group names follow each
target's convention (`<svc>_…` in `compile.mjs`, `<svc>.errorbudget.…` in
`compileBurnRules`). The window group's 2 min interval keeps its staleness
threshold (4 min) inside the default 5 min lookback, so `timestamp()` can
see a late sample (§6.3).

- **Where they land:** `compileBurnRules` (`burn-rules.mjs:526`), the full
  and per-SLO Prometheus files (`compile.mjs:245-262,398-411`), and every
  target that emits the error-budget group. The `--pack-snippet`
  (`packSnippet`, `burn-rules.mjs:656`) carries them.
  `dedupeGeneratedRecords` treats a pack-declared record of the same name
  and labels as the pack's own (`compile.mjs:419-439`).
- **Not emitted,** honestly absent: SLOs without a budget, SLIs without an
  error-ratio form (distribution, custom), and SLO windows that are not
  durations. The warning names the SLO.
- **Goldens.** `npm run test:golden:compile` changes on purpose. It is
  regenerated with `:update` in the same commit, and the PR body lists the
  new records per fixture pack. `npm run test:golden` (crawl) must not
  move.
- **Checks:** promtool accepts every generated file (the existing check).
  `tools/test-compile.mjs` cases: a 30 d SLO with objective 0.999 has
  `remaining = 1 - ratio/0.001`; one record set per SLO; none for a
  distribution SLI; a `promtool test rules` case where 25 % of the
  sub-record samples are missing reads coverage 0.75, not 1.

**Then the rest of item B:**

- A journey run samples queries 1–4 for its pack through `slo_state` and
  stores `slos: { [sloId]: { remaining, errorRatioWindow, burn1h, coverage, sampledAt, state, reason } }`
  on the run record, with the same states as §6.3.
- `neuron-model.mjs` gains `sloSeries(runs, sloId)`, modelled on
  `inventorySeries`, and `sloLedger(lastRuns)`.
- The Neuron gets the SLO ledger: a tile, a table (one row per SLO:
  availability, budget remaining, burn, window coverage, chain integrity)
  and small multiples. The fleet map (§9) drills into that table's row.

## 8 · Decisions for the maintainer

1. **The gating slice.** The brief says "after STORE_PLAN slice 3
   (services as records)". In STORE_PLAN §7, slice 3 is *roles enforced*
   and slice 4 is *services, environments, MCP endpoints*. This plan needs
   both, so it gates on **slice 4**. Confirm.
2. **Item B beyond the compiler.** The journey SLO sampling and the Neuron
   ledger (F2, F3) touch no store: runs are files. May they start after F1,
   before STORE_PLAN slice 4? The recommendation is yes: the ledger is
   useful without a registry, and the map needs it.
3. **`observogram` as the fourth kind and the default.** While an external
   source is active, hand-made services are refused (409), and switching
   back to `observogram` keeps every row. The recommendation is yes: it is
   the literal "one source of truth".
4. **The retire brake.** Hold a sync that would retire more than 20 % of
   the active services, or all of them, for an admin to release. The
   recommendation is 20 %, fixed in v1.
5. **The env-name rule, and its reach into STORE_PLAN.** Every env name the
   store holds must match `OBSERVOGRAM_ORG_<KEY>_[A-Z0-9_]+`, in single-org
   deployments too (§1), because otherwise an org admin who is not an owner
   can send any server secret to a URL of their choice. This amends
   STORE_PLAN for `mcp_endpoints.read_token_env` (`mcp-endpoints.mjs:41-47`
   checks syntax only), which has no callers yet, so nothing existing
   breaks. The Kubernetes `in-cluster` mode (the pod's own service account)
   is owner-only. Confirm both.
6. **What a tile's size encodes.** (a) The criticality tier: stable, so a
   refresh never reflows the map. (b) Burn or budget consumed: salient, but
   the map reshuffles as numbers move. Colour carries the SLO state either
   way. The recommendation is (a); violations are raised by the
   violations headline (§9.1), not by size.
7. **How the window error ratio is computed.** (a) **Exact:**
   `errorRatioAt(sli, slo.window)`, the policy's own legs over 30 d on raw
   series every few minutes: heavy. (b) **Hierarchical** (§7): hourly
   sub-records summed over the window, a tenth of the samples, with coverage
   exact to the 5 min sub-sample. The recommendation is (b), with (a) as a
   compiler profile knob for small fleets. Downsampling backends (Thanos,
   VictoriaMetrics with downsampling) keep 5 min resolution for
   `sum_over_time` but read low coverage at coarser levels: `unknown`, never
   a wrong budget.
8. **Records split by environment (and by pack) for central rulers.** With
   a Mimir ruler or vmalert over a shared TSDB, today's records blend
   environments (§2.4 step 4); v1 reads those cells `unknown` with that
   reason. The fix is a compiler option that writes the legs as
   `sum by (<env label>)` for packs that declare an environment label, and
   optionally stamps a `pack_id` label (§6.4). It changes the label sets of
   the burn records and alerts, so it is golden-gated and touches alert
   routing. Should it be slice F1b (after F1, before F7), or wait for a
   deployment that needs it? The recommendation is F1b only if the first
   target deployment evaluates centrally.

## 9 · The Neuron fleet map

A new section at the top of *Advanced → Neuron*, above today's journey
instrument. The rest of the page is unchanged.

### 9.1 Layout

- **One org at a time.** The org is the request context. The org switcher
  (STORE_PLAN §6.4) changes it. No view aggregates across orgs.
- **The violations headline, never hidden.** At the top, always, one line
  of counts, for example "0 breached · 0 burning · 20 met · 480 unknown ·
  12 no SLO — read 14:02", then the unknown reasons grouped by count
  ("412 no MCP endpoint · 68 records carry no `deployment_environment`").
  Below it, a plain text list of every `breached` then `burning` cell:
  service, environment, SLO, budget remaining, burn, and "read <t>". With
  none, the list says "no breached or burning SLO among the 20 measured",
  never "no violations". It is the first thing the maintainer asked for.
- **Environment sections.** Sections run in the order of the environments'
  tiers, then by name. Inside a section, cells are grouped by `system` when
  the source fills it (one small caption per group), else not grouped. One
  fixed grouping, no selector.
- **Cells.** A wrapped grid of square cells, one per service × environment.
  Within a group, cells sort by rollup severity, then tier, then name. The
  sort is deterministic, so the layout reads the same every time.
- **The layout is pure.** `layoutFleetMap(model, { width })` in
  `tools/lib/fleet/fleet-map.mjs` returns positions only. The renderer
  draws one `<svg>` from them.

### 9.2 Encodings (restraint: colour only where it carries state)

| Channel | Encodes |
|---|---|
| Fill | `breached`: the studio's fail token. `burning`: the warning token. `met` and `met-partial`: a neutral light ink, because met is the absence of alarm and gets no green. `unknown`: diagonal hatch in grey. `no-slo`: no fill, dotted outline |
| Size | the tier, in three steps (decision 6) |
| Ring (measurement trust, from the linked journey's newest record) | **none** when the chain is intact, the run is fresh (within `maxLiveAgeHours`, else 2 × its schedule) and coverage is ≥ 0.9. **Dashed ink** when unverified: no linked journey, never run, stale, vantage lost, or `met-partial`. **Double ink** when the linked journey has a degraded node whose blast radius reaches at least one SLO (`blastSummary.slos > 0`, `chain-history.mjs:77-81`). This is per journey, not per SLO, because the record keeps counts only. It is structural exposure, and the tooltip says "a node the linked journey's SLOs depend on is degraded", never "blind" |
| Mark | a small bar for `silent` (registered, nothing answering) |

Conflicts inside the source, `dependsOn` and owner are drill-down text,
not map channels. Colour is never the only carrier: each state also has its
own pattern or outline, and the cell's accessible name spells it out, for
example "checkout, production: burning — availability_99_9 burn alert
firing; 2 met; budget 61 % remaining; measurement unverified (no journey)".

### 9.3 Drill-down

Selecting a cell opens a read-only side panel, with no page change:

- the service's mirrored fields, each naming its source ("owner: team-pay ·
  from Backstage"), and any conflict or fold (§2.3);
- its owned fields (tier, links, bindings), with "edit in Settings → Fleet"
  for an operator;
- **one SLO ledger row per SLO** (§7, item B's table, filtered to the
  primary-linked pack), and a trend sparkline of `remaining` over journey
  runs (`stepChart`, `svg-charts.mjs:239`), drawn with gaps where runs have
  no sample;
- **the blast radius** from `blastRadiusNodes` (`neuron-model.mjs:160`) of
  the linked journey's newest record, unfiltered, with the note "the linked
  journey's degraded nodes; not narrowed to this SLO", drawn with the
  existing blast bars;
- presence, with the query that answered it;
- the linked journey, with "open in journeys", or "no journey linked", with
  the capture action.

Opening a panel loads that one journey's runs. The map itself never loads
run history.

### 9.4 Empty, partial and unknown states

| Situation | What shows |
|---|---|
| No services at all | "No services yet. Connect a registry in Settings → Fleet, or add a service." Admins get the link and others get the sentence |
| Always | "fleet from <source> as of <last complete sync>" |
| The mirror is older than 3 × the sync interval | A banner: "the fleet has not refreshed since <t>" (the timer stopped or every sync failed) |
| The last sync failed | A banner with the error **class** (auth, tls, timeout, redirect, refused address, upstream 5xx, malformed, cap) and "showing the fleet as of <last complete sync>". Viewers see the class; admins also see the redacted error text in Settings → Fleet |
| The last sync was partial or held | A banner: "partial — <n> of <m> clusters/datacenters/pages unread; nothing retired", or "held — would retire <n> of <m>; an admin must confirm" |
| Many cells `unknown` | The headline's grouped reasons (§9.1), not a per-cell repetition |
| Live state still loading | Cells in a neutral skeleton that is visually distinct from `unknown`, so a loading map never flashes as an outage of knowledge |
| An endpoint over budget or failing | Its cells are `unknown`, and the endpoint's reason class is in a footer line per endpoint |

### 9.5 Scale (500+ services)

- **The data path.** `GET /api/fleet` returns services, environments,
  links and the journeys' `lastRun` summaries in one response, replacing
  the 1 + N loader (`neuron-view.mjs:75-85`) for this section. Live state
  is one further call. Run history loads only on drill-down.
- **Rendering.** The SVG is one string of `<rect>` and `<path>` elements
  set once. Events are delegated from the `<svg>` with no per-cell
  listeners, and there is no `<title>` per cell; the focused cell's text
  goes to one live region.
- **The performance gate.** `layoutFleetMap` for 5,000 cells runs in under
  50 ms under `node:test`, and the rendered string for 1,500 cells is
  under 400 KB.

### 9.6 Accessibility

- The grid is `role="grid"` with a roving `tabindex`. Arrow keys move
  between cells, Enter opens the panel and Escape closes it.
- The violations headline and a **"table view" toggle** give the same data
  as a plain table, which is the non-visual primary.
- WCAG AA holds in both themes. The AA scan in `tools/test-build-model.mjs`
  extends to the new `.flt-*` zone (STORE_PLAN §6's rule for new zones).
- Patterns and outlines are distinguishable in greyscale.

## 10 · API routes and their class (STORE_PLAN §5)

STORE_PLAN §5 makes `viewer` "every `GET` in the org, except
`GET /api/audit`" (`STORE_PLAN.md:883`), and the route table gives one class
per route. The fleet routes follow both. The source config holds URLs and
env names, which STORE already serves viewers for `mcp_endpoints`.

| Route | Class | Audit |
|---|---|---|
| `GET /api/fleet` (`?retired=1` includes retired) | viewer | none |
| `GET /api/fleet/state` (`?env=`) | viewer (reads are cached; the server makes the outbound calls) | none |
| `GET /api/fleet/services/:slug` | viewer | none |
| `GET /api/fleet/source` (config: URLs, keys, env names) | viewer | none |
| `GET /api/fleet/syncs` (error class; the redacted text only to admins, a field the handler drops, enumerated in the authz matrix) | viewer | none |
| `POST /api/fleet/source/preview` | admin; refuses a config with an `in-cluster` cluster (400, naming the owner route) | none (it writes nothing) |
| `PUT /api/fleet/source` | admin; same refusal | `fleet.source.set` + `fleet.sync` |
| `POST /api/fleet/source/in-cluster/preview`, `PUT /api/fleet/source/in-cluster` | owner | `fleet.source.set` + `fleet.sync` |
| `POST /api/fleet/sync` | operator | `fleet.sync` when non-empty (and `service.link`) |
| `POST /api/fleet/syncs/:id/release` / `discard` | admin | `fleet.sync.release` / `fleet.sync.discard` |
| `PATCH /api/services/:id`, `PATCH /api/environments/:id` on a source-backed row | operator for owned fields; mirrored fields answer 409 | `service.update` / `environment.update` (STORE_PLAN slice 4) |
| `POST /api/services`, `DELETE /api/services/:id` while a source is active | 409, naming the source | none |

Every route goes into the route table, so the completeness test covers it,
and every route is scoped to the org context. An admin `PUT` that switches
an owner-set in-cluster source to another config is allowed (it is the
org's own source); keeping or editing an in-cluster cluster needs the owner
route.

## 11 · Gates: the test that proves each claim

| Claim | Gate |
|---|---|
| Adapters map correctly | `tools/test-fleet-adapters.mjs`: recorded pages per adapter become the expected entries. Kubernetes: `continue` paging, a 410 restart, a second 410 as incomplete, two clusters with one incomplete, the environment rule's order, a chart shipping `checkout`, `checkout-headless` and `checkout-metrics` folding into one entry with no conflict, `default/kubernetes` and `kube-system` excluded. Backstage: cursor pages, the lifecycle map, `team-pay` and `group:default/team-pay` normalising to one owner, `dependsOn`, a 404 on `by-query`. Consul: multiple datacenters, three instances folding into one entry, instance meta disagreeing as a conflict, `ns=*` sent only with `enterprise`, an unchanged index, a 403, a missing datacenter as incomplete, the cap |
| Disagreement inside the source is reported, never resolved by invention | fixtures for a duplicate (service, environment) after folding (lowest key kept, conflict listed), a conflicting owner (`null` plus the values), no environment (skipped with a note) |
| One source at a time | The partial unique index refuses a second active row; two concurrent `PUT`s leave exactly one active; no read path touches an inactive source's config |
| Retire, never delete | A disappearing service is retired with its pack links, journeys and audit intact; the same slug returning reuses the same `id` with its owned fields and sets `returned_at`; `deleteService` refuses a source-backed row |
| No retiring on half an answer | A partial read retires nothing; a switch from a partial read refuses; more than 20 % or an empty answer is held and applies nothing until released |
| A switch re-reconciles as previewed | Adopted rows keep their id, tier, links and MCP bindings, and take the new mirrored fields; unmatched rows are retired; a changed source between preview and commit answers 409; switching back to `observogram` retires nothing |
| Bindings by default | A first sync of the 500-service fixture with `environments.production.mcpEndpoint` set yields every production row bound; a row bound by hand keeps its binding through a later sync |
| SLO attribution | An aggregate pack with three member services attributes nothing to a member cell (`no-slo`, "SLOs belong to aggregate pack core"); only its primary cell carries its SLOs |
| Environments never blend | A fixture of centrally evaluated records (no environment label) with two environments on one endpoint reads both cells `unknown` ("records carry no `<label>`"); a fixture with an external label splits them correctly |
| A missing measurement is never green | a table-driven test of the §6.3 machine: every `unknown` reason; `met` only with fresh samples, coverage ≥ 0.9, a successful ALERTS query and confirmed burn alerts; ALERTS failing → `unknown`; `alert_rules` not advertised or not listing the pack → `unknown`; a pack-declared alert with an `slo` label but no `burn_rate` never counts as burning; `unknown` outranks `met` in the rollup; `no-slo` never renders as `met`; presence never changes the SLO state |
| Staleness is measured, not assumed | Over a recorded MCP response, a `timestamp()` 90 s old on the burn family, or 5 min old on the window family, yields `stale` |
| The query budget holds | A 500-service, three-endpoint fixture makes 21 calls on the regex path and 69 on the fallback; the third fallback endpoint reads `unknown` with the budget reason; a fallback query holds at most 100 names |
| Shared backends never cross orgs | Two orgs, one backend URL, a pack `checkout` in each: without a tenant matcher both read `unknown` and neither response names the other's services; with tenant matchers each reads only its own series; two series for one (service, slo, environment) read `ambiguous` |
| No tool-name literal | `tools/fleet-live.mjs` is added by name to `GUARDED_FILES`; the tool-surface snapshot is unchanged; `slo_state` sits in its own section of the registry |
| Browser-safe | a guard that `tools/lib/fleet/*` imports no `node:*`; `tools/test-studio-graph.mjs` links the new view |
| No stored secrets | A config holding a token-looking value or a credentialed URL is refused without echoing it; no route response, audit row or log line contains a token env's *value* (a canary value is set in the test env and grepped for) |
| Env names cannot reach server secrets | In a **single-org** deployment, an admin who is not an owner setting `tokenEnv: OBSERVOGRAM_SESSION_SECRET` (or any name outside `OBSERVOGRAM_ORG_DEFAULT_*`) is refused; a preview with a refused name against a capture server receives no request at all; no `brandEnv` key starts with `ORG_` |
| The registry fetch rule | Against a capture server: a 302 to `169.254.169.254` is refused, and the `Location` is not echoed; a cross-origin 302 never delivers `X-Consul-Token` or `Authorization` to the second host; a hostname resolving to `10.x` is refused unless `OBSERVOGRAM_FLEET_PRIVATE_CIDRS` covers it; link-local is refused even with `OBSERVOGRAM_ALLOW_LOCAL_MCP=1`; the connection goes to the address that was checked; a `caFile` outside `OBSERVOGRAM_FLEET_CA_DIR` is refused |
| Errors leak nothing to viewers | The viewer response for a failed sync holds the error class and no upstream body; the redacted text is present only for admins |
| Audit stays bounded | 144 periodic syncs with no change write no `fleet.sync` row; a change writes one, with actor `system:fleet-sync` |
| Tenancy isolation (STORE_PLAN §8 extended) | Two orgs: org B reads or writes none of org A's `fleet_sources`, `fleet_syncs`, mirrored services or state cache; a sync under A never writes B; a token env with B's prefix is refused under A |
| AuthZ matrix (STORE_PLAN §8 extended) | every route in §10 × every role × every posture, including the in-cluster owner routes and the admin-only error text field |
| Compiler prerequisite | goldens regenerated in the same commit; promtool on every generated file; the `test-compile.mjs` and `promtool test rules` cases of §7 |
| Map | `layoutFleetMap` is deterministic and meets the performance gate; each accessible name holds its state words; the AA scan covers `.flt-*`; `buildFleetModel` over fixtures gives every §9.4 state, including the stale mirror; an all-`unknown` fixture renders the headline with its unknown count and no "no violations" wording |

`npm run lint` and `npm test` pass before every push. Branches follow the
`codex/<topic>` rule.

## 12 · Slices: each its own PR into `develop`, each green alone

| # | Slice | Needs | Ships | Effort |
|---|---|---|---|---|
| F0 | This plan | nothing | `docs/NEURON_FLEET_PLAN.md`; ratified before any code | — |
| F1 | Window records (item B prerequisite) | STORE 2b merged | §7's hourly and window records, the snippet, golden regeneration, compile and `promtool test rules` cases | 3 d |
| F1b | Per-environment records (decision 8, only if taken) | F1 | the `sum by (<env label>)` option, golden regeneration, alert-label notes | 2–3 d |
| F2 | Journey SLO sampling | F1 (decision 2) | the `slo_state` capability row; journey runs sample and store `slos` with `timestamp()` freshness; `sloSeries`; `journey list` line | 3 d |
| F3 | Neuron SLO ledger (item B) | F2 | the ledger tile, table and small multiples in Neuron, with trust from the chain | 3–4 d |
| F4 | Fleet model and adapters | STORE slice 4, F2 | `tools/lib/fleet/model.mjs`, the three mappers, `server/fleet/registry-fetch.mjs` and the three fetchers, `packc fleet preview --source <kind> --config <file> [--mcp <url> --auth-env <NAME>]` (prints the normalised fleet, folds and conflicts, and with `--mcp` the presence report: registered / answering / unexpected per candidate label `job`, `service_name`, `service`; opens no database), the RBAC and ACL snippets in the deploy docs | 6–7 d |
| F5 | Reconciliation in the store | F4, STORE slices 3–4 | the migration (§5), the env-name rule (decision 5), `reconcile.mjs`, sync, brake, binding defaults, switch, periodic sync, the §10 fleet routes except state, the audit rows, the isolation and authz rows | 6–7 d |
| F6 | Live SLO state | F1, F5 | `tools/fleet-live.mjs`, `slo-state.mjs`, the shared-backend rule (§6.4), the cache and budget, `GET /api/fleet/state` | 4 d |
| F7 | The fleet map | F3, F6 | layout, render, violations headline, drill-down, table view, a11y, the AA scan | 5 d |
| F8 | Settings → Fleet | F5, STORE 6b | the source editor pop-up, preview diff, switch confirm, environment binding defaults, owned-field editing, sync history with error text for admins, held-plan release | 3–4 d |

F4 can ship alone as the CLI preview, which is already an answer to "where
is the inventory". F1–F3 give the SLO ledger without any registry. Each
slice goes through the implementer → two reviewers → fixer pass of
STORE_PLAN §7. The total is about six weeks after STORE_PLAN slice 4 (plus
F1b if taken), with F1–F3 able to overlap the store work.

## 13 · Risks

- **A telemetry-name mismatch turns the map grey.** If registry names do
  not match the series' `job` (or the configured label), most cells are
  `silent` or `unknown`. Mitigations: `packc fleet preview --mcp` prints
  the presence report per candidate label before anyone switches (F4);
  `match.label` and the per-service `telemetry-name` override; the
  `unexpected` list names the series that answer.
- **Central rule evaluation greys shared-backend cells.** Honest, but
  disappointing on a Mimir or vmalert setup; decision 8 is the way out.
- **A mis-scoped token empties the fleet.** A token scoped to the wrong
  namespace or datacenter returns a valid, smaller answer. The brake, the
  preview and "retire, never delete" bound the damage to a reversible
  retirement.
- **A returning slug inherits the old row.** A different service reusing a
  retired name gets its tier and links. The drill-down's "returned" line
  makes that visible; it is the cost of keying on the slug.
- **Window-record cost, retention and downsampling.** Hierarchical records
  cut the read to a tenth, but 500 SLOs still read about 13 M samples every
  2 min. A retention shorter than the window, or a downsampled level
  coarser than 5 min, shows as low coverage and `unknown`, never as a wrong
  budget.
- **Consul's N + 1 read.** Thousands of services per datacenter make a
  slow sync. The index short-circuit, the concurrency limit and the cap
  keep it bounded, and the cap is reported, not silent.
- **Backends without a `__name__` regex, or with response size limits.**
  The fallback costs ⌈packs / 100⌉ × 4 + 3 calls per endpoint and can hit
  the budget. That surfaces as `unknown (budget)`, and the ceiling is
  tunable.
- **Two URLs to one backend.** Shared-backend detection sees only equal
  URLs; the ambiguity backstop (§6.4) catches equal pack names, not a
  tenant reading a differently named pack's series. A compiler pack-id label
  (decision 8's sibling) closes it.
- **Private registries need a deployment setting.** Refusing private
  ranges by default means every real deployment sets
  `OBSERVOGRAM_FLEET_PRIVATE_CIDRS`. The deploy docs and the preview's
  "refused address" class say so plainly.
- **Registry permissions broader than needed.** The deploy docs ship
  minimal RBAC (`get`/`list` services and namespaces), Consul ACL
  (`service:read`, `node:read`) and Backstage (read-only static token)
  examples. The in-cluster mode is owner-only.
- **Scope creep.** Out of scope:
  - merging sources, or per-field precedence between sources;
  - watch or stream APIs (polling only);
  - mesh topology, traffic edges, or drawing `dependsOn` on the map;
  - cross-org views;
  - writing back to a registry;
  - a registry as a gen-site inventory source;
  - per-SLO blast radius (it needs the run record to keep SLO ids,
    `chain-history.mjs:77-81`, a golden-gated change of its own).

## Critique log

| Finding | Verified against | Outcome |
|---|---|---|
| A1 / B6 env matcher cannot match compiled records | `burn-rules.mjs:403-404` (`sum(increase(…))`, no `by`), `:554` and `compile.mjs:379` (labels `{slo, sli, service}`) | **Changed.** §2.4 step 4 states the precondition (one backend per env, or an env label that survives evaluation); the matcher is applied in the reducer, which reads `unknown` "records carry no <label>" when the record lacks it; per-environment compiler records are decision 8 / F1b; gate added |
| A2 aggregate packs leak SLOs to members | `migrations.mjs:122-132` (`role`, one primary per pack), STORE_PLAN §2, `compile.mjs:116-118` | **Changed.** SLOs attach through the `primary` link only; members read `no-slo` "SLOs belong to aggregate pack"; gate added |
| A3 row identity / rename tracking | `migrations.mjs:84` `UNIQUE(org_id, slug)`; k8s/Backstage/Consul identity semantics | **Changed.** Row keyed on slug; `sourceUid` dropped; `source_key` per environment row; returning slug reuses the row (`returned_at`), named as a risk; gate added |
| A4 multi-Service charts and system Services | plan §2.3, §3.1 | **Changed.** Fold per (identity, cluster, namespace); conflict only when owner/system/lifecycle differ; `default/kubernetes`, `kube-system`, `kube-public`, `kube-node-lease` excluded; fixtures added |
| A5 every environment row unbound after first sync | `environments.mjs:48-58`, `migrations.mjs:105` | **Changed.** `config.environments` defaults applied to unbound rows, row override kept (§4.1); gate added |
| A6 / B4 staleness unmeasurable; cache interval | Prometheus instant-query semantics; `compile.mjs:62` (30 s is the burn group only) | **Changed.** `timestamp()` queries per family, counted in the budget; window group at 2 min so 4 min stale < 5 min lookback; cache TTL justified by the fastest family; gate over a recorded response |
| A7 blast radius is counts only | `chain-history.mjs:77-81`, `neuron-model.mjs:160-184` | **Changed.** Ring restated per journey (`slos > 0`); drill-down unfiltered with a note; per-SLO blast moved to out of scope |
| A8 route classes contradict STORE §5 | `STORE_PLAN.md:883` | **Changed.** Fleet GETs are viewer; in-cluster split into owner routes; the admin-only error text is a handler field enumerated in the matrix |
| A9 presence label default | `library.mjs:815` is only the resource-attribute list | **Changed.** Default `job` with `target_info`; `service_name` an option detected by the preview; citation removed |
| A10 / B7 shared backend across packs/orgs | `compile.mjs:379,503` (no org/pack-id label) | **Changed.** §6.4: shared-URL detection with a required tenant matcher, `unexpected` suppressed there, ambiguity backstop; isolation gate added. Not taken: role-restricting `unexpected` (suppressing it on shared endpoints removes the leak without a per-role field) |
| A11 fallback exceeds the ceiling | plan arithmetic | **Changed.** Fallback `or`-joins 100 names; cost formula stated; ceiling 60; gate shows where it is hit |
| A12 coverage record cost; downsampling | 30 d / 30 s = 86,400 samples | **Changed.** Hierarchical hourly sub-records; coverage counts missing sub-samples as 0; downsampling caveat in decision 7 and §13 |
| A13 burn alerts have no `kind` | `compile.mjs:495-503,529`, `burn-rules.mjs:588,616` | **Changed.** Query 5 uses `burn_rate!=""`, `kind!="forecast"`; gate for a pack-declared alert with `slo` |
| A14 one cluster per source | plan §3.1, §5 | **Changed.** A Kubernetes source holds a list of clusters; completeness per part; `token_env` column replaced by names in config |
| A15 presence in F4 | plan §12 | **Changed.** F4 ships `--mcp/--auth-env` presence report and needs F2 for the capability row |
| A16 Backstage refs, Consul instances | Backstage entity-ref format; Consul catalog API | **Changed.** Owner/system normalised to full refs, shown short; Consul instances folded, meta conflicts raised, `ns=*` only with `enterprise` |
| A17 audit growth from a timer | STORE_PLAN §2 "no retention", `migrations.mjs:138` `actor NOT NULL` | **Changed.** `fleet.sync` only when non-empty, held or failed; actor `system:fleet-sync`; gate added |
| A18 guard is an explicit list | `test-contract-guard.mjs:47,51`; `mcp-capabilities.mjs:194-199` | **Changed.** `tools/fleet-live.mjs` named explicitly; `server/fleet/*` calls no MCP; `slo_state` in its own section |
| B1 admin can exfiltrate server env vars | `mcp-endpoints.mjs:41-47` (syntax only), `brand-env.mjs` keys (none start `ORG_`), STORE_PLAN `is_owner` | **Changed.** `OBSERVOGRAM_ORG_<KEY>_*` unconditionally (a single prefix in every deployment, so adding a second org breaks nothing, rather than a separate `SRC_` prefix); decision 5 extends it to `mcp_endpoints`; gates added |
| B2 SSRF on a credentialed fetch | `mcp-url.mjs:7-14,55-60` | **Changed.** `registry-fetch.mjs` rule: resolve-and-pin via `lookup`, link-local/metadata always refused, private only via `OBSERVOGRAM_FLEET_PRIVATE_CIDRS`, no redirects. All fetchers move to `node:https`/`node:http` because `fetch` cannot pin an address without `undici`. Not taken: a per-source owner-set `allowPrivate` (a deployment env var is simpler and equally owner-bound); gates added |
| B3 `met` without confirmed burn alerts | `burn-rules.mjs:601`, `compile.mjs:285,579` (separate `_burn` groups); `alert_rules` capability `mcp-capabilities.mjs:83` | **Changed.** `met` requires a successful ALERTS query and burn alerts confirmed through `alert_rules`; otherwise `unknown`. Not taken: deriving `burning` from `burn_1h` against a factor (it would duplicate the alert logic without its two-window, minimum-sample guard) |
| B5 hidden strip reads as all-clear | plan §9.1 | **Changed.** Headline of counts always shown, unknown reasons grouped, no "no violations" wording; gate added |
| B8 silently stale mirror | plan §4.2, §9.4 | **Changed.** "fleet from <source> as of <t>" always; stale-mirror banner at 3 × interval; gate added |
| B9 CA path oracle, error text to viewers | plan §3.1, §9.4 | **Changed.** `caFile` confined to `OBSERVOGRAM_FLEET_CA_DIR`, contents never echoed; viewers see an error class, admins the redacted text, upstream bodies never kept. Not taken: hiding registry hosts from viewers, because STORE §5 already serves `mcp_endpoints` URLs to viewers; hiding them would be a STORE amendment for both |
| B10 extras beyond the request | plan §9.1–9.3 | **Changed.** `dependsOn` highlighting and group-by selector dropped; one fixed grouping; owned-field editing moved to F8 Settings → Fleet; conflict notch moved to drill-down text |
