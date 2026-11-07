# Chaos experiments: declared, and proven

**Status: decided 2026-11-06, built in 0.8.7.** The owner accepted all eight
recommendations at the end. Spec 1.5 is RFC-0004 in
MoebiusX/otel-observability-pack#11. Observogram vendors it from that branch's
commit `adea3bf3` and moves the pin to `develop` once it merges. The build
differs from the text below in four places:

- **The live side keeps `observogram.unobserved.chaos`** (§5 said it goes when
  the feed answers). The live side never holds an experiment's definition, and
  without the key the diff would read every declared experiment as missing
  live, which costs Drift-free. The reason now says what the feed reported, and
  the runs ride in `mcp.chaos.runs`.
- **The posture matrix's chaos column still counts presence** (§4 said it
  follows the same rule). Since 0.8.5 it reads *declared*. Making it score
  proof would move Comprehensive too, so proof lives in Chaos-validated alone.
- **`.observability/*.yaml` is read in every environment scope.** A prod
  scope of a Kubernetes repository kept only Kubernetes paths and dropped it.
- **The tier rule** became: a tier-2 repository that holds an experiment
  infers tier-1. krystaline now infers tier-1, so its conformance is held to
  the tier-1 clauses.

## The problem

krystaline has run chaos experiments, yet the board says *"Recovery has never
been proven by fault injection."* The board is not wrong about the record:
no run of them is recorded anywhere. But nothing in Observogram could see
the experiments either, whether from code, from a CRD, from a declaration
in the repository or from live:

| Where | What happens today |
|---|---|
| Scan | No chaos detector. `detectArtefactKind` returns `'unknown'` for every chaos source, and the walk drops it (`tools/lib/crawler.mjs:619`). `spec.validation` holds only a made-up blackbox check (`:1054-1062`). |
| `.observability/pack.yaml` | The path rule admits it (`:83`), then it is classified `'unknown'` too. The GitHub and ADO paths never fetch it (`server/github-crawl.mjs` `isCrawlerFile`). |
| Service Run | Each Run replaces Pack A with a fresh scan (`server/index.mjs:1370-1380`). |
| Live | The fetcher writes `validation: {}` and `observogram.unobserved.chaos` (`tools/fetch-live-pack.mjs:2064-2066`, `:2095`). No capability reads run evidence. |
| Spec 1.4 | `engine` must be chaos-mesh, litmus or gremlin, and `schedule` daily, weekly or monthly. There is no field for a run's result, and the object is `additionalProperties: false` (`vendor/observability-pack-spec/v1.4/observability-pack.schema.json:463-479`). A pack that does not validate makes the Run fail with 422 (`server/index.mjs:1371-1374`). |

The grade has the opposite fault. `chaos-validated` passes, under the label
*"recovery proven by fault injection"*, as soon as there is **one** `CHAOS-`
artefact (`studio/diagnostic-grade.mjs:365-366`). A library template in a
Build pack counts. [Grade honestly](#scope-and-order) fixes the credit and the
wording for today's data. This proposal adds what the grade needs to tell
*declared* apart from *proven*.

Spec §5.11 already asks for this: *"a chaos experiment that fails to trigger
the expected alert within `expected_mttd` is recorded as failed"*. But
there is no field to record it in.

## What krystaline has

The repository is krystalinex-core at `1fa8d8e`, 2026-10-27. It holds an
in-process chaos system:

| Scenario | Source | Duration | Fault | Alerts its own text names |
|---|---|---|---|---|
| `latency-spike` | `server/monitor/chaos-controller.ts:63` | 180 s | 5000 ms delay on `/api/v1/trade`, `/api/v1/wallet` | HighLatencyP99 |
| `error-burst` | `:74` | 120 s | 40 % HTTP 500, 200 ms delay | HighErrorRate, "SLO burn" |
| `slow-degradation` | `:87` | 300 s | 5 phases, 200 ms → 6000 ms, then 10 % errors | — |
| `intermittent-errors` | `:105` | 180 s | 15 % HTTP 502, 1500 ms delay, `/api/v1/trade` | — |
| `cascade-failure` | `:118` | 240 s | 4 phases, wallet → trade → every route, up to 70 % HTTP 503 | — |

Around them:

- **Control surface.** `POST /api/v1/monitor/chaos/start`, `custom` and `stop`, plus `GET status`
  (`server/monitor/routes.ts:1000-1095`), gated by `X-Chaos-Key` against
  `CHAOS_API_KEY`. The middleware is `server/middleware/chaos.ts`.
- **Toggle.** `server.chaos.enabled: false` in `k8s/charts/krystalinex/values.yaml:114`,
  off since chart 0.3.0 (June).
- **Client-side drills.** Three in `scripts/chaos-scenarios.js`: brute-force,
  whale-trade and rate-limit-flood. They send real traffic, but no fault is
  injected and there is no table: each is a function behind a `switch`.
- **Expected alerts.** `docs/CHAOS_INJECTION.md` names more alerts than the
  code does, such as HighLatencyP99Critical. The scan does not read Markdown.
  HighErrorRate (`for: 2m`), HighLatencyP99 (`for: 5m`) and
  HighLatencyP99Critical (`for: 2m`) are real rules in
  `k8s/charts/krystalinex/templates/configmaps.yaml`, and the crawler already
  lifts them. The doc's `config/alerting-rules.yml` no longer exists.
- **Runs.** On 2026-04-09, `48f8c4c` enabled the chaos API on krystaline.io.
  The controller only **logs** a run ("Chaos scenario started via API"). It
  publishes no metric, keeps no ledger and records no result.

So the honest line for krystaline today is **"5 chaos experiments declared,
never recorded as run"**. That is better than "never proven", and it is not
"proven".

## The proposal

### 1. Spec 1.5: RFC-0004 upstream, additive

The vendored spec is a byte-for-byte copy of `MoebiusX/otel-observability-pack`,
checked by `tools/sync-spec.mjs --check`, and every other reader of a pack
validates against the same schema. So the change belongs upstream, as
RFC-0002 and RFC-0003 did (`docs/rfcs/0003-alerting-rules.md` there, §2.3: "the gap is
in the contract, so the fix is in the contract"). Then `sync-spec` vendors
`v1.5/` and `SPEC_VERSION` moves. Every 1.4 pack still validates, and
`apiVersion` does not change.

The values below are illustrative. No April run of krystaline is recorded,
so the date, the SLO id and the link are made up.

```yaml
validation:
  chaos_experiments:
    - id: latency-spike
      engine: in-process          # NEW: in-process | custom (beside chaos-mesh, litmus, gremlin)
      target: kx-server
      steady_state_hypothesis: ref:slos.api_latency_p99
      fault: { kind: latency, duration: 180s, delay_ms: 5000, routes: [/api/v1/trade, /api/v1/wallet] }
      expected_alerts: [HighLatencyP99]
      expected_mttd: 6m
      schedule: on-demand         # NEW: on-demand | ci (beside daily, weekly, monthly)
      last_result:                # NEW, optional: the newest recorded run
        at: 2026-04-12T10:14:00Z      # required, date-time
        outcome: pass                 # required: pass | fail | aborted
        environment: prod
        observed_mttd: 4m12s
        alerts_fired: [HighLatencyP99]
        evidence: https://grafana.krystaline.io/d/…   # free text: a run id, a link, a file
```

- `in-process`: the service injects faults into itself through its own
  code, like krystaline's middleware. `custom` covers any other tool, such as
  toxiproxy, AWS FIS or a k6 fault script.
- `on-demand` means somebody triggers it by hand. `ci` means a pipeline step
  runs it.
- `last_result` keeps the **newest** run only, because a pack is a manifest,
  not a ledger. The history lives with whatever measured it (see §5).
- The required fields stay required. L5 is the chain "names the SLO it
  stresses and the alert it expects" (§3 of the spec). Relaxing them would
  make an experiment that proves nothing valid. Where a scan cannot know a
  field, it fills it and says so (§2).

`fault` is already open (`additionalProperties: true`), so delay, rate,
routes and phases need no schema change.

### 2. A chaos detector in the scan

It runs as a **separate pass over every file**, not as a file kind. A file
has one kind, and a chaos controller that also exports metrics would
otherwise be read as `metric-source-code` and lose its scenarios. It emits
one experiment per scenario, and the evidence map records where it was
found, so it is *discovered*, not *scaffold*.

| Engine | Keyed on | One experiment per |
|---|---|---|
| Chaos Mesh | `apiVersion: chaos-mesh.org/v1alpha1`, kind `*Chaos`, `Schedule` or `Workflow` | resource; a `Schedule` or `Workflow` replaces the chaos it wraps, so it is not counted twice |
| Litmus | `apiVersion: litmuschaos.io/v1alpha1`, kind `ChaosEngine` or `ChaosSchedule` | `spec.experiments[]` entry. A `ChaosExperiment` is a hub template: counted, not emitted. |
| Gremlin | none: attacks and scenarios live in Gremlin's service, not in the repository | only by a declaration in `.observability/pack.yaml` (§3) |
| in-process | A file with `chaos` in its path, holding a scenario table: entries keyed by a slug, each with `durationSeconds` and `delayMs` or `errorRate` | table entry |

For in-process systems, the routes `/chaos/(start|stop|status)`, the
`X-Chaos-Key` header and a `chaos.enabled` or `CHAOS_API_KEY` toggle are
**corroboration**. They annotate how the experiments are triggered and gated,
and create none on their own. If the scanned environment has the toggle off,
the experiments are still declared, annotated *disabled in `<env>`*.

What code cannot supply is filled, and each filled field gets a field mark
(`crawler.scaffold.validation.chaos_experiments.<id>.<field>`). A field mark
parks nothing; the conformance report shows it.

- `expected_alerts`: the alert names in the scenario's own text that match an
  alert rule the scan found. If none matches, `unresolved:not-in-code`, the
  same convention the scan already uses for a channel whose address it
  cannot know.
- `expected_mttd`: the slowest matched rule's `for:` plus one evaluation
  interval. Otherwise the pack's `baselines.mttd_target_p50`.
- `steady_state_hypothesis`: the SLO a matched burn-rate alert protects.
  Otherwise the SLO whose SLI fits the fault (latency or errors). Otherwise
  the first SLO.
- `schedule`: `on-demand` when the code has no timer. A `Schedule` CRD's cron
  maps to daily, weekly or monthly.
- `target`: the service.

Two side changes come with it. The GitHub and ADO file rule admits code paths
with `chaos` in them: today `server/middleware/chaos.ts` is read only from a
local folder. The tier rule at `crawler.mjs:901` ("tier-1 = … +
chaos") gets the chaos it names.

### 3. `.observability/pack.yaml`: an `observability-pack` artefact kind

A hand-written ObservabilityPack in the repository becomes the place to
declare what code cannot say, and to record runs:

- **Kind.** `.observability/*.yaml` with `kind: ObservabilityPack`, fetched on
  the GitHub and ADO paths too.
- **Merge.** `spec.validation.chaos_experiments` entries merge into the
  scanned pack **by id**. The declared entry wins over the discovered one
  with the same id, since it is a person correcting an inference; any other
  entry is added.
- **Evidence.** The evidence path is
  `.observability/pack.yaml#spec.validation.chaos_experiments.<id>`.
- **Partial packs.** The file may be partial. Each entry is validated alone
  against the experiment schema, and one that fails is left out with a
  warning naming the file and the error. It never fails the Run with a 422.

This also answers the Service Run problem. The repository is a service's
home (a service is its repository plus a live target), so declarations and
recorded runs live there and survive every scan. Pack A does not need to
remember anything between Runs.

### 4. The grade: declared is partial credit, only a fresh pass is full

`chaos-validated` gets a `score`, which the engine already supports
(`criterionScore`, `diagnostic-grade.mjs:139`), and a structured `chaos`
field, so the board stops parsing numbers out of `detail`:

| State | When | Score | Board line |
|---|---|---|---|
| none | no experiment, or only scaffold or library-template ones | 0 | Recovery has never been proven by fault injection: no chaos experiment is declared. |
| declared | ≥ 1 real experiment, no recorded run | 0.25 | 5 chaos experiments declared, never recorded as run. |
| stale | the newest pass is older than the window | 0.25 | 5 chaos experiments declared; the last recorded pass, 2026-04-12, is older than 35 days. |
| failed | the newest run of any experiment failed | 0 | latency-spike failed on 2026-11-01: HighLatencyP99 did not fire within 6m. |
| proven | ≥ 1 pass within the window | 0.25 + 0.75 × (fresh passes ÷ experiments) | Recovery proven 2026-11-01 by fault injection: 3 of 5 experiments (measured). |

- **Pass.** `pass` (the board's *yes*) needs every declared experiment to
  have a fresh pass. Anything above 0 and below that is *partly*.
- **Window.** It comes from the experiment's own schedule: daily 2 d,
  weekly 8 d, monthly 35 d, on-demand and ci 90 d.
- **Source.** The line names where the result came from. *Measured* means
  the live feed (§5). *Recorded in the repository* means `last_result`. The
  live feed wins when both exist.
- **Posture matrix.** The *Chaos validated* column follows the same rule.

### 5. Live evidence: a `chaos_run_evidence` capability

The live side reads run evidence, so a run can be proven without a commit.
A new row in `tools/lib/contracts/mcp-capabilities.mjs` carries it:
`kind: 'evidence'`, `responseShape: 'instant-vector'`, `candidates:
[{ tool: 'metrics_query' }]`. As with every row, the tool name appears in
that file only. The PromQL lives in a contract table, the way
`stack-self-metrics.mjs` holds its probes:

- **The MQ lab's certification feed** (`npm run certify` publishes it to the
  alert-sink, scraped as job `certification`). These are the series
  `tools/lib/dashboards/lib.mjs:322-344` already charts:
  `mq_cert_run_timestamp_seconds`, `mq_cert_checks{suite="chaos"}` and
  `mq_cert_mttd_seconds{experiment,alertname}`. Before the build, the labels
  are checked against the lab.
- **Optional: a neutral family** that any harness can publish (decision 6).

Like every stack self-metric, the evidence is **sampled and point-in-time**.
It feeds this one criterion through the window and stamps nothing
*Verified*. When the probe answers, `observogram.unobserved.chaos` goes away.

krystaline publishes neither feed. To read *proven*, its repository needs
either a `last_result` written after a run, or a run metric from its chaos
controller. The second is a krystalinex-core change, outside this
repository.

## What krystaline would show

On the first scan after the build:

- **Experiments.** Five `in-process` experiments, `on-demand`, from
  `server/monitor/chaos-controller.ts`.
- **Gating.** Each is annotated as gated by `X-Chaos-Key` and *disabled in
  prod* (`server.chaos.enabled: false`).
- **Alerts.** `expected_alerts` is matched for latency-spike (HighLatencyP99)
  and error-burst (HighErrorRate). The other three are
  `unresolved:not-in-code`, with field marks.
- **Board.** *"5 chaos experiments declared, never recorded as run."*, at
  0.25 credit.

A `.observability/pack.yaml` in krystalinex-core could add the alerts the
doc names and a `last_result` for the April runs, if there is evidence of
them. Seven months on, that would read *"stale"* under any window in this
proposal. That is the honest reading.

## Decisions for the owner

| # | Decision | Recommendation | Alternatives |
|---|---|---|---|
| 1 | Where the spec change lives | **RFC-0004 upstream → spec 1.5**, then `sync-spec` | An Observogram-only overlay schema, which other readers reject and which breaks `sync-spec --check`. Or annotations only (`observogram.chaos.<id>.lastResult`), string-valued and never validated: a stopgap at best. |
| 2 | New enum values | `engine` + `in-process`, `custom`; `schedule` + `on-demand`, `ci` | Also add `aws-fis`, `azure-chaos-studio` now. |
| 3 | Run results | **`last_result` on each experiment, newest only** | `validation.chaos_runs[]`, a history in the pack: it grows with every run and needs a commit per run. |
| 4 | Fields code cannot supply | **Keep them required**; the scan fills them from evidence, with field marks | Relax `required` to `[id, engine, target]` in 1.5. |
| 5 | Client-side drills (`scripts/chaos-scenarios.js`) | **Not emitted** (traffic drills, not fault injection); listed in the scan summary | Emit them as `custom` with `fault.kind: synthetic-traffic`. |
| 6 | Live run evidence | **`mq_cert_*` only, for now** | Also define a neutral run family in RFC-0004 for any harness to publish. |
| 7 | Credit and window | declared 0.25; full only with a fresh pass of every experiment; windows 2 d / 8 d / 35 d / 90 d | declared 0.5; full with ≥ 1 fresh pass; one window for all. |
| 8 | A self-reported `last_result` | **Counts as proven** while fresh, labelled *recorded in the repository* | Partial credit only; full only with *measured* evidence. |

## Scope and order

- **Before this.** Two companion tasks run beside this one. *Grade honestly*
  stops giving credit for scaffold and library-template experiments and
  fixes the overclaiming wording for today's data. *The scan reports what it
  drops* makes `'unknown'` files visible. This proposal builds on both, so
  its grade change lands after the first.
- **The order.** First the RFC-0004 PR in otel-observability-pack. Then one
  Observogram PR: the 1.5 vendor, the detector, the `observability-pack`
  kind and the fetch rule, the grade and the board line, the capability.
  That PR carries the next patch version, the vendor manifest and goldens
  regenerated with the diff explained.
- **Not in this proposal:**
  - Observogram triggering chaos itself, which it never will: it watches
    the monitors;
  - matching a run's window against `ALERTS` history to work out pass or
    fail;
  - the Update journey authoring experiments in the studio;
  - merging sections of `.observability/pack.yaml` other than
    `validation.chaos_experiments`.
