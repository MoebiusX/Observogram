# Measuring availability of an event broker

*Proposal · draft for review · 13 November 2026*

A broker answers no HTTP requests, so the request-ratio SLI every service uses does not apply. This proposal defines what “available” means for an event broker, the SLIs that measure it, the one number to put an objective on, and what is needed from the broker team to make it real.

## What “available” means for a broker

Three questions, each failing independently. A broker can be up and refuse messages, or accept them and never deliver.

- **Is it serving?** The messaging tenant is operational on the node that is active in its HA pair.
- **Does it accept?** Messages sent to it are spooled or forwarded, not discarded for a broker-side reason.
- **Does it deliver?** A message published now reaches a consumer, within a bound, end to end.

## Recommendation

**Availability = tenant reachability × delivery ratio, as one SLO** (decided 13 November). The product is recorded every 30 seconds; the SLO counts the samples in which the broker served, and is burn-rate alerted as the service SLOs are. At tier-1, add a synthetic canary as its own SLO. Spool usage and queue depth are saturation: forecast them, and do not count them against availability.

The shape follows the IBM MQ entry already in the library (`library/products/ibm-mq.library.yaml`), which was certified end to end against a real queue manager. That entry pairs process liveness with client reachability, and adds depth headroom, message age, a dead-letter queue and a put/get canary. The broker gets the same structure with its own metrics.

## The SLIs

The PromQL below gives each SLI's shape. The exact metric names come from the broker team's exporter and are confirmed from a live scrape before anything is certified (see “What is needed”).

| SLI | Answers | Measured as | From tier | Objective (t1 / t2 / t3) |
| --- | --- | --- | --- | --- |
| `broker_process_up` | Can we read the broker at all? (availability) | Exporter scrapes that reached the broker's management API, over all scrapes. Ratio. | tier-3 | 99.9 / 99.9 / 99 % |
| `tenant_reachable` | Is the messaging tenant serving clients? (availability) | Redundancy groups whose active node reports the tenant operational, over all groups. Ratio. Diverges from `broker_process_up` when the process lives but the tenant is down or disabled. | tier-3 | 99.9 / 99.9 / 99 % |
| `ha_active_nodes` | Is exactly one node active? (availability) | Active nodes per redundancy group, ceiling 1. Two active is split brain; zero is caught by `tenant_reachable`. | tier-2 | 99.9 % |
| `delivery_ratio` | Does it accept what it is sent? (availability) | 1 − broker-side ingress discards ÷ messages received, per tenant. Ratio. Spool-full, quota, ACL and TTL discards count; “no subscription” discards on topics do not (decision 2). | tier-2 | 99.9 / 99.5 % |
| `dlq_depth` | Did any message fail delivery for good? (availability) | Messages on the dead-letter queue, ceiling 0. Any message there needs a person. | tier-2 | 99.9 % |
| `spool_headroom` | How close is the spool to full? (saturation) | Spool usage ÷ spool quota, ceiling 0.8, with a 7-day exhaustion forecast. Not part of availability. | tier-2 | 99 % |
| `canary_success` | Does a message get through, end to end? (availability) | Synthetic guaranteed messages published to a canary queue and consumed within 5 s, over attempts. Ratio. | tier-2 | 99.9 % |
| `canary_roundtrip_p99` | How long does it take? (latency) | p99 publish-to-consume time of the canary, client-observed. Threshold. | tier-1 | 99 % under the bound |

## The headline number

One recording rule per tenant, the product of the two ratios. It reads zero during an HA failover (the tenant is not operational until the standby takes over), which is correct: clients see that gap too.

The SLO is time-based. A 30-second sample is good when the composite is at or above 0.99: the tenant is serving and at most 1 % of messages were discarded for a broker-side reason in the last 5 minutes. The objective is the share of good samples, so 99.9 % over 30 days allows about 43 minutes of bad samples.

```yaml
record: slo:broker_availability:composite_5m
expr: |
  (
    sum by (tenant) (<tenant operational on the active node>)
    / count by (tenant) (<tenant status series, one per redundancy group>)
  )
  *
  (
    1 - sum by (tenant) (rate(<ingress discards, broker-side reasons only>[5m]))
      / sum by (tenant) (rate(<messages received>[5m]))
  )
```

```yaml
slis:
  - id: broker_availability
    type: threshold
    good_when: above        # spec 1.3: the bound is a floor
    query: <the composite expression above>
    threshold: 0.99
    unit: ratio
slos:
  - id: broker_availability_99_9
    sli: broker_availability
    objective: 0.999
    window: 30d
```

**Objectives.** 99.9 % over 30 days at tier-1 and tier-2, 99 % at tier-3, matching the IBM MQ entry. A 30-day window, not 1 day: a single long failover should not reset the budget overnight.

**Alerting.** The library's availability burn profile: 14× over 5 m and 1 h pages (SEV1); 6× over 30 m and 6 h is SEV2. At tier-3 each severity drops one step. Tier-1 adds a 24-hour budget-exhaustion forecast.

## Measures considered and set aside

- **A request success ratio.** There are no requests to count. The nearest equivalent is `delivery_ratio`.
- **`up` alone.** It proves the exporter reached the broker, not that clients can. That is why `tenant_reachable` sits beside it.
- **Client connection count.** It is traffic. It drops when clients scale down, which is not an outage.
- **Spool usage and queue depth.** Saturation. They predict an outage; they are not one.

## Proving it with chaos

Each SLI is certified the way the IBM MQ entry was: break one thing, measure how long the SLI takes to see it.

| Experiment | Expected to move | Expected to stay |
| --- | --- | --- |
| Stop the active node | `tenant_reachable` dips for the failover, then recovers | `ha_active_nodes` stays ≤ 1 |
| Stop the exporter | `broker_process_up` | `canary_success` (the differential: our view broke, the broker did not) |
| Fill the canary queue's spool quota | `delivery_ratio`, `spool_headroom`, `canary_success` | `tenant_reachable` |
| Deny the canary user by ACL | `canary_success` | every broker-side SLI (only the end-to-end probe catches this) |
| Publish a poison message | `dlq_depth` | `delivery_ratio` |

## What is needed from the broker team

1. The exporter and its version, and one `/metrics` scrape from each endpoint it enables. This pins the exact series names; nothing is certified on guessed names.
2. The HA topology: redundancy groups, which node is primary, and whether any tenant is replicated to a DR site.
3. The tenant names in scope and the dead-letter queue name.
4. Which discard counters the broker exposes, and whether they split by reason (spool full, quota, ACL, TTL, no subscription).
5. A canary client: a small publisher and consumer on a dedicated queue, sending one guaranteed message every 10 s and exporting attempts and round-trip time over OTLP.
6. A lab broker pair where the five experiments above can run.

## How it lands in Observogram

The library entry is generic, an “event broker” product with the SLI ids above. The product-specific PromQL arrives as the deploying pack's overrides, through fields the library already takes (`good`, `total`, `query`, `semconv_metric`, `id`; `tools/lib/library.mjs` `OVERRIDE_FIELDS`). The composite needs no new SLI shape and no spec change: the library and the burn-rate generator (`tools/lib/burn-rules.mjs`) already take a threshold SLI whose bound is a floor (`good_when: above`, spec 1.3) and count the samples under it as bad. The composite cannot be a ratio SLI, because the generator refuses a ratio that multiplies a rate by a gauge; a `custom` SLI gets no burn alerts today.

## Decisions

1. **Composite as one SLO.** Decided 13 November: one composite SLO, time-based as described above, buildable with what the library takes today.
2. **Do “no subscription” discards count as failures?** Recommended: no on topics, yes on queues, where a missing subscriber is a misconfiguration.
3. **Objectives per tier.** Recommended: 99.9 / 99.9 / 99 % over 30 days, as above.
4. **Who owns the canary?** It needs a deployment, a queue and a user on the broker. Recommended: the broker team runs it; Observogram only reads its metrics.

## Next steps

1. Collect the inputs above, starting with the live scrape.
2. Draft the generic library entry and the overrides from the confirmed names.
3. Run the five experiments in the lab and record each SLI's detection time.
4. Set the objectives, then turn on the burn alerts.

See also: the IBM MQ entry (`library/products/ibm-mq.library.yaml`) and the SLI catalogue ([`docs/SLI_CATALOGUE.md`](SLI_CATALOGUE.md)).
