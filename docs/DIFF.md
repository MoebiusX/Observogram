# Diff — Behavioural Artefact Matching

`tools/lib/diff.mjs` compares two adapted, layered packs and powers the
drift/gap view exposed by `GET /api/diff?a=<packId>&b=<packId>`.

The comparison is directional: **A is the declared pack under review, B is the
reference or live pack**. Observogram reports in-scope drift for A against B and
keeps unrelated live inventory in a separate `outOfScope` bucket.

## The Claim

Observogram separates two questions:

1. **Identity:** is this the same control?
2. **Agreement:** do both sides declare the same contract for that control?

This is the core matcher claim that is safe to repeat: a shared identity does
not receive credit unless the comparable contract also aligns.

## Identity

`keyOf(artefact)` delegates to `tools/lib/artefact-model.mjs`, which classifies
each artefact family and builds a behavioural identity object. The adapter's
positional ids (`SLI-01`, `BAK-03`, `ALR-02`) are never identity.

Representative identities:

| Family | Identity |
|---|---|
| SLI / SLO | declared contract id, because other controls bind to it |
| Backend | `product + signal` |
| Metric | series name |
| Recording rule | output series name |
| Dashboard | declared dashboard id |
| Panel | dashboard parent + `binds_to` target |
| Pipeline receiver/processor | stage name |
| Pipeline exporter | signal + exporter kind |
| Alert route | severity, with duplicates preserved via occurrence ordinals. Channel kinds deliberately stay OUT of identity — live connectors fabricate them when routing cannot be introspected — and surface as decision-bearing drift instead |
| L2X profiling/network/policy | product |
| L2X mesh/collection | product + role |

The precise phrasing matters: Observogram matches on behaviour. For reliability
contract artefacts, the declared id is the behavioural handle by design.

### Identity modes

Behaviour is the default and the only key the server's `GET /api/diff` uses.
`diffPacks(a, b, { identity })` pairs by another key — rebadge batch 3, C3,
`tools/lib/identity-modes.mjs` — while **behaviour still decides aligned vs
drifted**, so a pair formed by name or id can drift:

| `identity` | Pairs by | Answer |
|---|---|---|
| omitted, `'behaviour'`, or `identityKeyOf` itself | the behavioural identity above | byte-identical to today's; no `identity` key (the stored goldens `tools/fixtures/golden/diff/` run all three) |
| `'name'` | `nameKeyOf`: the name or title, trimmed, white space collapsed, lower case | `identity: { mode: 'name' }` after `scope` |
| `'id'` | `idKeyOf`: a stable id or uid (a dashboard's uid, a spec id); a family whose name is its id (metric, recording rule, alert rule, scrape job) uses the name | `identity: { mode: 'id' }` |
| a function `(artefact, { side }) → '<kind>::…'` | the caller's key | `identity: { mode: 'custom' }` |

Every key keeps the `<kind>::` prefix — scope, `notObserved` and collisions
read it — and a function whose key drops it is a TypeError (`diffPacks: an
identity function must return "<kind>::…" for each artefact (got "<x>" for a
<kind>)`); an unknown mode id names the three. The engine calls the key with
the **side** (`'a'` or `'b'`), which is how an artefact with no name (or no
stable id) is keyed — `dashboard::{"unnamed":"a:DASH-01"}` — so two unnamed
artefacts of a family never pair; each lands in `onlyInA` / `onlyInB`. The
parked placeholders (`scaffold`) are keyed by the same function. Where each
mode's material comes from, per family, is the table in docs/ADAPTER.md
("Identity modes"). Verdict keys, the traceability graph, the remediation flow
and chain history stay on behaviour.

## Collision Handling

Multiple artefacts in one pack can share the same identity key: multiple SEV2
routes, duplicate dashboard ids, same-named pipeline stages, or more than one
Prometheus metrics backend. `diffPacks` groups by identity instead of using a
last-write-wins `Map`.

Within each identity group it:

1. Pairs exact behavioural matches first.
2. Pairs remaining same-identity artefacts as drifted, the closest pair over
   all of them first — the fewest fields apart, ties in declared order — so
   an artefact declared first cannot take the counterpart of a closer one.
   The requirement chain pairs the same way (`pairClosestFirst`,
   tools/lib/artefact-model.mjs), so the chain and the diff hold one form.
3. Leaves surplus controls visible as `onlyInA` or `onlyInB`.

Duplicate entries receive stable occurrence suffixes such as
`dashboard::{"id":"overview"}#02`, so counts preserve artefacts instead of
collapsing them to identity classes.

The result also carries a top-level `collisions` array — one entry per
identity key held by more than one artefact on either side:

```js
{ layer, kind, key, aCount, bCount }
```

The buckets already preserve every instance; `collisions` is the explicit
fail-loud surface, so callers (including downstream vendors who bucket by
`identityKeyOf` themselves) never have to infer collisions from `#NN` key
suffixes. `buildDependencyGraph` exposes the same surface as
`graph.collisions` (`{ key, kind, count }`). `otel` and `baselines` keep
deliberately empty identities: the spec makes them singular objects, so at
most one exists per pack and their `{}` identity cannot collide.

Alert-route identity precision was evaluated and deliberately declined:
`fetch-live-pack.mjs` and the crawler fabricate a channel kind (an msteams
placeholder) when live routing cannot be introspected, so channel-kind
identity would split declared routes from their live placeholders and report
them falsely missing in production. Severity-keyed identity keeps that pair
matched, with the channel difference reported as decision-bearing drift.

## Agreement

`projectOf(artefact)` returns the canonical comparable contract, and
`deltasOf(a, b)` reports the top-level fields of that contract that differ,
each as `{ field, a, b }`. For a burn-rate pair whose two sides both state
the alerting rules they were read from it also reports what differs in those
rules, each as `{ field, a, b, rule, nth? }` under the alert rule's own field
name (`expr`, `for`, `severity`, `labels`) — not a field of the entry's
`{ slo, windows }` contract (*The rules a burn-rate entry was read from*,
below). `deltas` is a list, not a map: one `field` may occur in it more than
once. A matched pair is:

```js
{ key, a, b, match: 'aligned' | 'drifted', deltas, unobserved? }
```

`aligned` means the declared contract matches after normalisation. It does not
mean byte-identical source.

Normalisation rules:

- Object keys are sorted.
- Arrays are normalised element-wise, sorted, and empty arrays are treated like
  absent fields.
- Empty `null`, `undefined`, `''`, `{}`, and `[]` values are dropped.
- Expressions in `expr`, `query`, `promql`, and `expression` are
  order-canonicalized when the expression parses cleanly (parser-proven):
  selector matcher order (`{b="2",a="1"}` ≡ `{a="1",b="2"}`), aggregation
  grouping label order (`sum by (a,b)` ≡ `sum by (b,a)`), structural
  whitespace (`rate( x [5m] )` ≡ `rate(x[5m])`), and whitespace around the
  symbolic binary operators `+ * / % ^ == != <= >= < > =~ !~`
  (`a / b` ≡ `a/b`, `rate(x[5m]) > 0.5` ≡ `rate(x[5m])>0.5`). `-` is never
  tightened (unary/binary ambiguity) and keyword operators (`and`, `or`,
  `unless`, `bool`, `offset`, `by`, `on`, …) keep the space that bounds
  them. Anything that fails to parse falls back to whitespace collapse only
  — recorded as `textual-fallback` by `tools/lib/promql-canon.mjs`. A
  comment (`#` to the end of a line, outside a string) is dropped first,
  parsed or not: a ruler lists the query re-printed without it. A pipeline's
  token (`#{Name}#`, `#{Name}`) is no comment, and what follows it is kept.
  Explicit non-goals (per `PHASE_1_VERDICT_TRUST_RESEARCH.md` Workstream B):
  no algebraic rewrites, no binary-expression or vector-matching
  reordering, no regex equivalence, no histogram folding.
- A leading `ref:` on the reference-bearing fields `slo`, `sli`, `trigger`,
  `error_budget_policy` — and on `expr` when the whole value is a reference
  (`ref:slis.x`) — is authoring syntax, not behaviour: `slo: ref:x` and
  `slo: x` compare equal, matching what identity already does.
- `version` blocks compare by `declared` when present.
- Deployment/presentation fields are stripped:

```text
endpoints, endpoint, url, address, host, auth,
description, desc, title, summary, annotations,
source, evidence, mcp, default, folder, provider
```

## Buckets

Each layer (`L1`, `L2`, `L2X`, `L3`, `L4`, `L5`, `GOV`) contains:

| Bucket | Meaning |
|---|---|
| `onlyInA` | A declares it; B does not have an in-scope counterpart |
| `onlyInB` | B has it in a family A participates in; A does not |
| `inBoth` | same identity on both sides, with `aligned` or `drifted` verdict |
| `outOfScope` | B has it, but A declares nothing in that artefact family |
| `scaffold` | a placeholder (`source: Scaffold`) on either side — parked before pairing, never counted; entries carry `side` (`a`/`b`) and `artefact` |
| `notObserved` | one pack holds it, in a family the OTHER pack says it had no way to observe, or a backend only a shared exporter's job attests (below) — unchecked, never counted; entries carry `side`, `artefact` and the other side's `reason` |

`outOfScope` prevents a single-service drift view from being flooded by the
rest of a platform's live inventory. It is reported, but excluded from the
in-scope ratios.

`scaffold` holds the schema-forced placeholders the crawler
(`crawler.scaffold.<symbol>`) or the live fetcher (`mcp.scaffold.<symbol>`)
had to invent. A placeholder is neither a declaration nor live evidence, so
it is removed from both sides **before** identity pairing: a declared
burn-rate alert never reads `aligned` (or `drifted`) against the live pack's
fallback entry — even when both carry the compiler's default windows on the
same SLO — and a repo placeholder never reads `declared, not live`. A real
live artefact whose repo counterpart is only a placeholder reads `live, not
declared` as it should. `summary.scaffold` counts the parked entries.

`notObserved` separates "the other pack looked and it is not there" from "the
other pack could not look". A pack's producer names the artefact families it
had no way to observe in `observogram.unobserved.<kind>` annotations — `<kind>`
is the model's family (`dashboard`, `pipeline_receiver`, `alert_route`, …),
the value the reason (`the dashboards probe got no answer: HTTP 401`, `no MCP
tool exposes the collector configuration`). An artefact with no counterpart
whose family the other pack names there goes to `notObserved` instead of
`onlyInA` / `onlyInB`: a Grafana that refuses the fetcher's login does not
make seven declared dashboards missing. An artefact that DOES have a
counterpart is compared as usual, whatever the annotation says. The live
fetcher writes these keys (docs/MCP_INTEGRATION.md, *What the fetch could not
look at*); a pack without them behaves exactly as before.
`summary.notObserved` counts the entries; they are outside the union.
A live read that covered only some STORES of a rule family says so in
`observogram.unread.alert_rule` (`{ grafana?, ruler?, loki }`) and
`observogram.unread.recording_rule` (`{ grafana }`): no Grafana alert-rule
tool answered, no Prometheus-compatible ruler did, no tool reads a Loki
ruler or Grafana-managed recording rules. An unmatched artefact every one of
whose rules lives in a store so named — a declared rule's `engine` (absent,
`prometheus`, `mimir`, `thanos`, `victoriametrics` → a ruler; `grafana`;
`loki`), a recording rule that states Grafana's facts, a burn-rate entry
every rule of which it was read from sits in such a store (its source rules,
below: `engine: grafana` is Grafana's store, any other a ruler's) — goes to
`notObserved` with that reason; a scope's own reason, more specific, comes
first. A rule is `loki` only where its own source says so — a pack that
states it, or a scanned rule whose expression is LogQL by a pipeline stage
PromQL has no operator for (`|=`, `|~`, `!~`, `| json`, …) — never by the path
a rule file ships under nor by a selector PromQL also has (`rate({app="x"}[5m])`,
`x{job="y"} != 1`): a mixin's PromQL alert on `loki_*` series under `loki/`
is a Prometheus rule, and missing live it reads *declared, not live*. A
burn-rate **pair** one side of which was read from a rule in a store the
other side's read did not cover (an SLO guarded by a Prometheus rule and a
Grafana-managed one, against a read whose Grafana tool gave no answer) is
not compared on its `windows` — the other side derived its own from fewer
rules — and says so, `unobserved: [{ field: 'windows', side, keys: [], rule }]`
(counted in `partlyCompared`); the rules both sides read are compared as
below.

**A Grafana-managed rule** states beside the spec what the closed AlertRule
cannot hold (`observogram.grafana_rule.alerting.rules[<i>]`, the adapter's
`grafana`: `{ uid?, folder?, folderUid?, group?, condition? }`). Its
`condition` — the expression nodes from the query to the alert (a threshold,
its recovery threshold, a reduce, math, classic conditions), the other
queries, the condition reference and `paused`, as one text both readers
derive the same way — is part of its behaviour: a threshold raised in Grafana
reads drifted on `condition`. A side that states none (a listing that does
not show it; a repository whose threshold, or any node of it, is a value a
Helm chart fills in at deploy time or a `${VAR}` — no number the repository
states) is no difference: the pair carries `unobserved: [{ field:
'condition', side, keys: [] }]` and counts in `partlyCompared`. Its `uid`
pairs a rule renamed on one side: when both sides state one uid under two
names and neither name has a counterpart, the two are one `inBoth` entry,
`matchedBy: 'uid'`, drifted on `name` (the alertname routing and silences
match) — on the default identity path only, and never in place of a name both
sides hold. Its `folder` (a title, as a provisioning file states it) and
`group` answer a scope: a folder entry whose live read named one of its
folders by that title holds it inside; one that named every folder and none
so, outside; else not known, and the reason names the folder the pack
states.

A backend the live side has only from a scrape job named for an exporter
that reads more than one product — the elasticsearch_exporter reads
Elasticsearch and OpenSearch alike (`productsAScrapeJobServes`,
tools/lib/backend-products.mjs) — cannot say which of them runs. Where the
other pack declares the look-alike and nothing else live attests it, the
pair goes to `notObserved` with that reason (`the live evidence (scrape job
elasticsearch-exporter) reads elasticsearch and opensearch alike, …`),
neither *in both* nor *declared, not live*. The live side's own
`mcp.backends.evidence` annotation says which job attested each backend; a
job named for either product still says which runs, whichever job the
listing gives first (the live fetch keeps such a job's evidence over the
exporter's). Only the comparison's own key pairs backends by product: under
a name or an id the live backend keeps its product and is never set aside.

The same holds one level down, for a **field a producer was shown only in
part**. A live rule listing that gives each alert rule a flat `severity` and
no `labels` object showed that one label and no other; the rule's `service`
or `team` label was never shown, so it cannot differ. The pack says so per
artefact — `observogram.partial.<symbol>` = `<field>=<key>,<key>` (of that
field, the keys the producer was shown; none after the `=`, nothing of it;
`alerting.rules[4]` = `labels=severity`) — the adapter puts it on the
artefact as `partial: { labels: ['severity'] }`, and `deltasOf` compares the
pair's labels on the keys both sides were shown: equal there, no delta;
different there, a `labels` delta holding those keys alone. The pack's
`severity` is read from the severity label, so it is compared only when that
key was shown. The pair then carries what went uncompared, `unobserved:
[{ field: 'labels', side: 'b', keys: ['service', 'team'] }]` — `side` the
one that did not see the keys the other states (`unobservedOf`) — and
`summary.partlyCompared` counts the alert rules compared this way (the key is
absent when there is none; a run record carries it as
`drift.partlyCompared`). A pair compared whole has no such key, and a listing
that does give each rule its labels object is compared in full: there a
missing label is drift. One family uses it, the alert rule — an operational
rule's labels, and those of the rules a burn-rate entry was read from
(below); the live fetcher writes the statement (docs/MCP_INTEGRATION.md), and
the scan does for a rule a chart's include gives labels it does not read
(*Where the scan reads a rule*, below). The scan also states an operational
rule's `expr` and `for` with no keys (`expr=`, `for=`) where a chart or a
deploy step fills them in (*A value the chart fills in*, below): a field one
side was shown none of is not compared against the other, and the pair's
`unobserved` names it (`{ field: 'for', side: 'a', keys: [] }`) whether the
other side states it or not; where both sides list it — two readings of the
repository — their texts are compared where the pack keeps them, which is
the expression's: a wait or a label value a deploy step fills in is left out
on both sides, so two readings that fill it differently read alike.
`labels.filled=<keys>` names the label
keys written with a value filled in: each is named uncompared, unless the
other side fills it in too.

**Where the scan reads a rule.** A rule file, a ConfigMap a Helm chart
renders (each data key a rule file), and a Prometheus Operator
`PrometheusRule` resource (0.8.42): its `spec.groups` are read as a rule
file's `groups` — in a file of its own, in any document of a manifest
(whatever else the file holds, whatever it is called), and in a chart's
template, there from its `apiVersion` (or one the chart fills in), `kind`
and `spec` alone, since its name and labels are mostly the chart's includes
and its rules need none of them. The operator hands those groups to a
Prometheus (or a Thanos Ruler) as they are written, so a resource's rule is
the `prometheus` engine's whatever its path — but for a rule in LogQL, which
a Loki ruler runs (Grafana Alloy loads PrometheusRule resources into one).
The operator can also be told to add a namespace label to every rule and
matcher (`enforcedNamespaceLabel` on the Prometheus resource), which the
scan cannot see: there a resource's rules read as different on those labels
and expressions.

In a chart's template, a line holding only template actions does not end a
ConfigMap's data map or block (Helm renders control flow to nothing, an
include to YAML indented by the action itself). In a rules file — a
ConfigMap's or a PrometheusRule's — a line that holds only an include
(`{{ toYaml .Values.extraLabels | indent 12 }}`, kube-prometheus-stack's way;
`{{- include "x.labels" . | nindent 8 }}`) renders YAML from the chart's
values or helpers, which the scan does not read. The scan leaves it out, and
its column — its `indent`/`nindent` argument; where the chart computes the
indent, the line above it, or under a key with nothing after it that map's
own keys; else where it stands; never deeper than the text reaches — says
what it renders into. Into a rule's labels, or a rule or a group that writes
no labels of its own (a group's keys after an indented rules list too): that
rule is held to the labels it writes (a *field a producer was shown only in
part*, above): the operational rule carries
`observogram.partial.alerting.rules[i]`, an SLO's stated rule `partial`, and
a label the rendered rule adds reads uncompared, never as a difference. A
`labels:` the chart fills in whole is read so too. Beside a labels map the
rule writes, it cannot add to it: that rule is whole. Into the rules list or
the groups (more rules, more groups from values, an indentless list's too —
the include right after `rules:`, or the list's first item in the key's own
column): the rules written around it are whole. Written at the margin with
an indent the chart computes, closing a ConfigMap's block, it is read as
extending the block's last rule (where it renders the ConfigMap's next data
key instead, that rule is held to the labels it writes). Right after a block
scalar, at the scalar's key or left of it, it ends the scalar. An action that
prints a scalar — a threshold on the line below its expression, a value on
the line below its key — is the chart's value there, never YAML (*A value the
chart fills in*, below). A bare rules template whose include stands in a
rule's labels is read as a rules file.

Another config (a scrape config, an Alertmanager's, a collector's) ending in
the chart's extra-config hook is read whole, as it always was: the hook
renders after it. One with such a line inside it keeps the line, which the
reader cannot place: that block is not read, and the scan says so. A data
key the chart fills in whole (`{{ .Files.Get "dashboards/x.json" | indent 4
}}`) states nothing of its own and is not read. Where the reader stops in a
template, the scan says where, in the template's own lines.

Both branches of an `{{- if }} … {{- else }}` that writes a rule twice are
read: each form is declared. A rule a `range` renders several times under
one name is declared once.

**A rule named at deploy time** — by a chart's values (`- alert: {{
.Values.prefix }}Down`, a `range` over names) or by a deploy step's variable
in a rule file (`- alert: ${SERVICE}Down`) — is not declared: no ruler lists
that name, so it would pair with nothing and read *declared, not live*
beside each rendered rule's *live, not declared*. The scan names it, and the
metrics its expression reads stay in the inventory. A repository whose
recording rules are all named so records series all the same: its other
alerts stay operational rules, never SLOs read from their names.

**One rule in several files.** A rule written the same in several places —
a rule file and the PrometheusRule that wraps it, a chart's ConfigMap and
its PrometheusRule behind a values switch — is one rule where one of them is
deployed. The scan reads a rule as the comparison does — its name, its
expression with spacing and matcher order aside, its wait in any unit (a
zero wait no wait), its labels (an empty one no label) and a Grafana-managed
rule's uid, never its annotations or a recording group's interval. It
declares the rule as often as one place holds it and names the places. The
place a copy is left out of still speaks for it in a lifecycle block. Two
rule files one ruler loads that write a rule the same are read as one too
(the scan does not read which files a ruler loads): the listing's second
copy reads *live, not declared*. PrometheusRule resources named alike in
several files that write a rule, recording or alerting, differently — a
kustomize base and its overlay, which the scan does not merge, or two apps
that share a name — declare and state every form, and the scan says so. Each
live rule is held to the closest form — the one differing from it in the
fewest fields, the form declared first on a tie — an SLO's stated rules and
its operational rules alike; the others read *declared, not live*, the form
that runs too where it differs from the ruler in as many fields as an
earlier form or more (an overlay whose patched threshold the ruler changed
again leaves the base held). An SLO's burn-rate windows are read from its first form's rules. Rules
of one name in files that are no such resources — a page and a ticket rule
in two rule files, two services' alerts — all run, and are all stated.

**A value the chart fills in** inside a rule — not a whole line — reaches it
as the placeholder stripGoTemplate leaves (`up{job="helmvalue"}`, `for:
helmvalue` from kube-prometheus-stack's `dig … .Values.customRules`), or as
a variable a deploy step substitutes — any `${…}` (`${VAR}`, Flux's
`${var:=default}`), a bare `$NAME` in capitals, or a pipeline's token
(Azure DevOps' `#{Name}#`, Octopus Deploy's `#{Name}`, an Azure Pipelines
macro `$(Name)`, read in linear time, never one a comment names), never a capture group (`$1`, `$host` naming a group the
expression's regex defines), text PromQL holds itself (`/odata/$metadata`),
a comment, or the ruler's own templating. A label key a deploy step names is
no key written: the rule is held to the labels it writes. An unquoted token
after a space is a YAML comment, so the value reads only up to it
(`for: #{PageFor}#` as no wait, `expr: x > #{Threshold}#` as an expression
cut there); a quoted value, a block scalar, or a token with no space before
it reads whole.
It is no statement of the repository's: an operational rule is held to the
rest of what it writes (`observogram.partial.alerting.rules[i]` = `expr=`,
`for=`, `labels=<keys written>`, `labels.filled=<keys filled in>`), and the
comparison does not compare what one side lists with no keys. A wait that is
no spec Duration is left out and said (the scan's `omitted.ruleWaits`, the
chart's value shown as `…`), so the pack stays valid — in an SLO's burn-rate
rule too, whose window it no longer gives; a severity is never read from
such a value. Against the rendered rule live runs, the rule aligns on what
the chart writes, and the pair names the rest, a wait or a label key the
ruler lists none of included. Comparing the expression with the placeholder
as a wildcard is not done here. An SLO's rules holding one state nothing
(below), so none of them is compared, and the scan's warning says so for a
wait it left out; a wait that is no spec Duration, whatever writes it
(`__PageFor__`), makes its SLO state nothing too, and an SLO's rule whose
comment names a variable still states its rules.

Two alert rules that **share a name** — a warning and a critical threshold
under one alert — are two rules on both sides: a rule file keeps both and
the live fetcher keeps every operational rule the ruler lists, folding
none. The pair of groups is matched closest first — a pair that matches
whole, then one that matches on the part it was shown, then the fewest
deltas — under `#01` / `#02` occurrence keys and one `collisions` row.

**The rules a burn-rate entry was read from.** A hand-written alerting rule
on an SLO's recorded series is not an operational rule: both readers fold it
into that SLO's burn-rate entry (the spec keeps a rule in one place). The
entry is `{ slo, windows }` and nothing else, and its windows are the
reading's own — a rule's wait as `short`, constants for the rest (a
severity only where the rule's label is literally SEV1–SEV3), the default
pair when fewer than two survive — so the rule's expression (and with it
the threshold) is in no field of the entry, its severity word in none, and
its wait only where it survived as a window. Compared on the entry alone, a
rule loosened in production (`> 0.01 for 5m critical` against `> 0.5 for 2h
info`) read *aligned*.

So each entry says, beside it, the rules it was read from:
`observogram.source_rules.policy.burn_rate_alerts.<slo id>` = a JSON list of
`{ name, expr, for?, severity?, labels?, condition?, engine?, partial? }`
(`condition`: a Grafana-managed rule's threshold and other steps;
`engine: grafana`: its store, read only against the stores the other side's
read did not cover), the rules' terms as an
operational rule's are read (`sourceRuleTerms`, tools/lib/sli-inference.mjs
— the repository scan and the live fetch write the statement through that
one function, over every rule whose expression references a recorded series
of the SLO — a rule on two SLOs' series beside the first of them only, where
both readers put it — in one order whatever order they were read in). The adapter puts
the list on the burn-rate artefact as `sourceRules`, beside `spec`. When
**both** artefacts of a pair state it, `deltasOf` also holds the rules to
each other:

- the rules both sides state under one name are paired, and each pair is
  compared exactly as an operational alert rule: `expr`, `for`, `severity`,
  and `labels` on the keys both sides were shown. A difference is a delta of
  the burn-rate pair under the alert rule's own field name, with the rule's
  name beside it — `{ field: 'expr', a, b, rule: '<name>' }` — so the pair
  reads `drifted`, in the flat diff and in the requirement chain alike (the
  chain's alert link is the burn-rate entry);
- several rules under one name are paired closest first — a pair that
  matches whole, then one that matches on the part it was shown, then two
  with the same expression, then any two, each time the two of all still
  open that differ least — by what the rules say, never by the order a side
  lists them in, so the answer is the same with the sides swapped; their
  deltas and notes say which pair of the name they are (`nth`);
- a rule only one side states is held against nothing. That side may not
  have listed it at all — another rule engine, a rule scope, a file the scan
  did not read, a chart condition — so its absence is not reported as a rule
  that does not run.

The entry's own fields are compared as before: the rules are compared as
well as `slo` and `windows`, never in their place, so nothing that read as
a difference stops reading as one. Labels a listing never showed ride on the
pair as `unobserved`, one entry per rule and side, each naming its `rule`
(and `nth`); `partlyCompared` counts those rules. When only **one** side
states its rules — a pack written by hand, or one read before the statement
existed — nothing is held to it and the pair compares as it always did.

Not stated, so compared as before:

- an SLO any of whose rules the repository does not state as the ruler
  will list it: a value a Helm chart or another template engine fills in at
  deploy time, or a `${VAR}` / `$VAR` a deploy step substitutes, in its
  expression, wait or labels (a capture group's `$1` and the ruler's own
  `{{ $labels.x }}` in a label are the rule's text; a rule named so is not
  declared at all, above); a labels map a deploy step fills in whole, on the
  rule or on its group (one a chart's include fills in is held to the labels
  the rule writes, above), or given as an alias or a merge
  key the file does not resolve (an anchor it does not define, a merge key
  with its mapping written in place); group labels past the scan's copy
  budget (250,000 in one scan, with a warning). Held against what live
  renders there it would read as a difference, so that SLO states no rules. The rest the scan
  reads as the ruler does, and states: the labels a rule's group gives every
  rule (under the rule's own), anchors, aliases and merge keys naming
  aliases, a label written as a bare number or boolean (as its text, `99.0`,
  `True`), a value written over several lines or folded (`>`)
  (`tools/lib/mini-yaml.mjs`);
- an SLO the fold gave no entry: the fold reads the first rule of an alert
  name, on both sides, so a rule whose name an earlier rule took (on another
  SLO, or on no SLO) may leave its own SLO with none, and there is then no
  entry to state it beside (where the scan gives every SLO a default entry,
  it does state the rule there, and the rule is compared). A repository with
  no recording rules states nothing either.

Not covered, as for an operational rule: a ruler that re-prints expressions
(another number spelling, the aggregation modifier moved) reads the same
rule as different on `expr`, and a listing with neither a labels map nor a
flat severity on `labels` and `severity`; Helm control flow inside a rule
is read wrong by the scan; a label whose key the comparison drops everywhere as
volatile (`source`, `host`, `version`, `url`, `description`, …) is
compared on neither kind of rule. Two burn-rate entries on one SLO — no
reader writes them — both carry the SLO's one statement, and a rule that
differs then keeps the two from pairing by their own windows first.

A live **snapshot** read within a scope (rebadge batch 3, C1: metric
prefixes, dashboard or rule folder uids) records it per family as
`observogram.scope.<kind>` (`tools/lib/live-fetch.mjs` `scopeAnnotations`),
and the diff reads those keys beside `observogram.unobserved.<kind>`. An
unmatched artefact on the other side, in a scoped family, goes to
`notObserved` with one of two reasons, each stating only what is known:
**outside** the scope — `outside the snapshot's metric scope (prefixes
payments_, checkout_)`, with `; excluded ^app_event_\d+_total$` appended when
the snapshot also dropped names by pattern (`outside the snapshot's metric
scope (excluded ^go_)` when it set patterns and no prefix; a name longer than
256 characters is never dropped by a pattern, by the fetcher or here —
`tools/lib/live-fetch.mjs` `excludedBy` — and a pattern that can split a name
of up to 256 characters more than a million ways is refused where the scope is
parsed, never run), `outside the
snapshot's dashboard folders (Payments)`, `outside the snapshot's alert rule
groups (payments, checkout:slo)` (the group a crawled rule's `source` names,
`<file>#<group>/<name>`), `outside the snapshot's alert rule scope (folders
Payments; rule groups payments)` when both were applied
— or **cannot tell**, when the artefact does not say what the scope needs (a
crawled dashboard names no folder uid, and states a folder title only where
the repository provisions it — a sidecar annotation read as its YAML value, or
a dashboard provider that the same compose container's Grafana reads, alone):
`the snapshot read only the folders
Payments; Pack A does not say which folder this dashboard is in, so it was
not checked`, `the snapshot read only the rule groups payments; Pack A does not
say which group this recording rule is in, so it was not checked` (a canonical
recording rule names no group). One artefact of a key inside the scope keeps the group compared
as usual; an unobserved family keeps its own reason. Without the annotation
the answer is byte-identical.

## Metric families

Metrics are compared as **families**, not series. One declared metric is
several series on the wire — a histogram `x` is `x_bucket`, `x_count` and
`x_sum`; the Python client adds `x_created`; a counter declared `x` is exposed
as `x_total`. Source code declares the metric, a metrics store lists the
series, a query references one of them. Paired name for name, a declared
histogram read "not live" while its own three series read "live, not
declared".

`foldMetricFamilies(aItems, bItems)` (artefact-model.mjs) folds each side's
metric artefacts into one artefact per family before pairing, using what both
sides know (`metricFamilyResolver`):

| Series | Family | When |
|---|---|---|
| `x_bucket` | `x` | always — the suffix is reserved for histograms |
| `x_count`, `x_sum` | `x` | `x_bucket` is known, or `x` is declared a histogram / summary / timer, or both `_count` and `_sum` exist |
| `x_total` | `x` | `x` is known and declared a counter |
| `x_created` | what `x_total` resolves to, else `x` | that counter is known; or `x` is a distribution or is itself known |
| anything else | itself | a lone `queue_count` gauge is not folded |

A family's entry carries `series` (the names it stands for on that side) and
`memberIds` (the ids of the artefacts it replaces). A metric alone in its
family is passed through untouched.

## Dynamic metric families

An exporter that mints metric names at runtime declares them as a pattern in
its manifest (docs/EXPORTER_METRICS.md §18.1), which a pack carries as a
`METRIC-FAM-NN` artefact (`spec.origin_kind: exporter-family`,
`spec.name_pattern`). Without it, every name such an exporter mints reads
`live, not declared`, and no list could ever keep up.

- A family is **lifted out of its side before the fold**. It never pairs by
  name; it answers for what is left.
- A metric on the other side with **no pair of its own** whose name, or any
  series it stands for, the pattern matches goes to `inBoth`: `match: aligned`,
  `matchedBy: declared-family`, no deltas, the family as that side's artefact.
  Names are tested as listed (Prometheus names are case-sensitive), and one
  longer than the 256 characters a pattern is timed against is not tested.
- A **literal pair wins**: a name the pack also declares pairs with the literal.
  Among families the first in the pack's order holds the member.
- Either side may declare one, and the **same pattern on both sides pairs with
  itself** (`metric::family:<pattern>`), so a self-diff stays fully aligned. A
  side that says it cannot observe metrics claims nothing through a family.
- A family with **no member is never `onlyInA`**: a queue with no traffic mints
  nothing. It is named in `summary.dynamicFamilies.unmatched`, unless it did
  match names that went elsewhere first (its row's `covered`: they paired by name,
  or an earlier family holds them), or a side could
  not list metrics, or the other side read them within a scope that does not
  cover the family's prefix (its row's `notObserved`, with the reason).
- The pattern is compiled again here under the manifest's rule, because a pack's
  annotation is anyone's text. A **refused pattern claims nothing**, sits in no
  bucket, and is listed in `summary.dynamicFamilies.refused` with the reason, as
  is a family past the limit of 64.
- Declaring a family speaks for the metric family of artefacts (`aKinds`) and its
  exporter's name goes to `scope.exporterTokens`. The first segment of its literal
  prefix joins `scope.metricPrefixes` unless a platform owns it, so the other live
  metrics of `acme_` read `live, not declared` while those of `rabbitmq_` stay out
  of scope in service mode. A pattern is not counted in `scope.declaredMetricCount`.

`summary.dynamicFamilies` is present **only when a side declares a family**, so
a pack without one keeps its bytes:

```json
{
  "declared": 1,
  "members": 2,
  "unmatched": [],
  "refused": [],
  "families": [{ "pattern": "^demo_queue_", "side": "a", "exporter": "demo-exporter", "file": "metrics-manifest.json", "members": 2 }]
}
```

Members count like any other pair: in `inBoth`, `aligned` and `union`, and so in
**`jaccard` and `alignment`**. A gate on `alignment` reads them too, so a family
with many members can lift the score while declared metrics are gone. Those stay
named in `onlyInA`, and `summary.dynamicFamilies.members` says how many pairs rest
on a pattern. The studio's compare digest counts members as aligned, its head says
how many there are, and a member's card names the pattern that answered for it.

## Declared ahead of an environment

A team writes a rules file before its service reaches prod. Compared with prod,
every rule in it would read *declared, not live*, which looks like drift and is
not. A comment block that opens the file says so:

```yaml
# observogram-lifecycle:
#   maturity: authored
#   deployment:
#     prod: planned
#     staging: deployed
groups:
  - name: orders-slo
    rules: []
```

A state is `deployed`, `planned` or `not-deployed`. `prod` and `production`, `stg`
and `stage` and `staging`, `dev` and `development` are one environment, as are `prd`
and `prod`; any other spelling is its own. The crawler reads one block per rules
file, including a Helm template (`tools/lib/lifecycle.mjs`). The block must open the
file, with only comments, `---` and Helm directives above it, because further down
the same lines may be a rule's description quoting one. A block it cannot read is a
warning that names the file and the rule, never its text, and parks nothing.
It writes one annotation, which is also how a hand-written pack states this:

```json
"observogram.lifecycle": "[{ \"source\": \"rules/orders.rules.yml\", \"maturity\": \"authored\", \"deployment\": { \"prod\": \"planned\" }, \"symbols\": [\"slis.orders_availability\", \"slos.orders_availability_99\", \"queries.recording_rules.orders:availability:good\", \"alerting.rules.OrdersStuck\", \"policy.burn_rate_alerts.orders_availability_99\", \"metrics.orders_total\"] }]"
```

The adapter stamps the statement on those artefacts as `lifecycle`. An artefact
with no counterpart on the other side goes to `layers.<L>.declaredAhead`
(`{ key, side, artefact, reason }`) when its state for the compared environment is
explicitly not `deployed`:

- The compared environment is `diffPacks(a, b, { environment })`. Without it, it is
  each pack's own, and the statement must hold for both, so a repo read for staging
  against a pack bound to prod parks nothing deployed in either. The live fetcher
  binds its packs to `prod`, so comparing a staging repo with one parks only what is
  stated as not deployed in both. `summary.lifecycleEnvironments` names what was
  compared, and with none (`[]`) nothing is parked.
- Every artefact of a group must say so, and a folded metric family only keeps the
  statement when every series carries it from the same file.
- **A statement can only hide what its own file, or files that say the same,
  declare.** The crawler covers a symbol only when every file that speaks for it
  carries a block with the same deployment, so rules and alerts split across two
  files park together. A metric the code or a manifest's family also names, an SLI
  with a rule in a file with no block or another state, or anything an alert, a
  dashboard or a rule in such a file reads, down the chain, keeps reading as usual.
- An artefact `notObserved` stays there, because nothing was checked at all. One that
  pairs is compared as usual, and its statement is no delta.
- On side B, service scope comes first: what is outside the service stays
  `outOfScope`.
- Parked artefacts leave the union, like `notObserved`, so `alignment` and `jaccard`
  **rise** by what is parked: a pack with everything parked reads 100%. So
  `summary.declaredAhead` counts them, a journey records the count beside its
  alignment, and `gate.maxDeclaredAhead` can refuse it (opt-in; omitted, it does not
  gate).
- Requirement chains do not read the statement, so the grade's chain integrity
  still counts a parked rule as broken, and says how many are declared ahead.

`layers.<L>.declaredAhead`, `summary.declaredAhead` and
`summary.lifecycleEnvironments` exist only when a pack carries the annotation, so a
pack without one keeps its bytes. The studio shows the count wherever it shows
*not checked*.

**What this cannot catch.**

- A statement nobody updates keeps a rule parked after it should have gone live, and
  a rule that really is missing then reads as declared ahead. A statement does not
  expire. The count is there so that it stays visible.
- A live pack does not record which stack it read: the fetcher binds it to `prod`.
  With no environment named on either side, a default repo crawl compared with a
  staging stack is compared for `prod`.
- With several environments in a pack and none picked, the adapter reads the first.
- Only what the crawl reads can speak for a series. A `PrometheusRule` custom resource
  is walked (0.8.42), and a block at the top of its file covers its rules as a rule
  file's does.

## Addresses a source does not state

An alert route's channels are compared by kind and address. Two readers can
know a channel exists without being able to state its address: a running
Alertmanager prints every secret URL as `<secret>`, and a repository wires one
in at deploy time (`url: ${WEBHOOK_URL}`). They write `redacted:secret` and
`unresolved:<VAR>` in its place (tools/lib/alert-routes.mjs). `deltasOf`
treats such a value as partial evidence, like a reference-only expression:
when the channel KINDS agree one for one, and every kind where neither side
withholds an address agrees on its addresses, the route is aligned. A changed
e-mail address beside a redacted webhook is still drift.

## Summary Ratios

`union = onlyInA + onlyInB + inBoth` is the **in-scope** union. `outOfScope` is
reported separately.

- `jaccard = inBoth / union`: identity overlap.
- `alignment = aligned / union`: true agreement ratio.

With nothing in the union (`union` 0 — every declared artefact not checked,
parked or out of scope) both are `null`, never 1: nothing compared is no match.
A journey then records `drift.alignmentPct: null` beside `drift.compared: 0`,
and a gate on the figure fails ("nothing was compared").

The strongest diagnostic signal is the gap between them: high Jaccard and low
alignment means Observogram found the same controls, but their definitions drift.

## Weighted Drift Fidelity

The Diagnose view does not score every delta equally. It uses weighted badness:

| Bucket | Weight | Rationale |
|---|---:|---|
| Declared, not live | 1.0 | false reassurance: the pack claims production protection that live did not confirm |
| Drifted | 0.5 default | miscalibration: same control exists, but fields differ |
| Drifted decision field | 1.0 | SLO objective, query, alert window, severity, route/channel, MTTD/MTTR, etc. |
| Drifted cosmetic field | 0.1 | label, display, folder, tag, description, etc. |
| Live, not declared | 0.15 | shadow signal: useful inventory gap, but less dangerous than false reassurance |
| Out-of-scope live | 0.0 | excluded platform inventory |
| Scaffold | 0.0 | schema-required fallback with no source evidence |

`Scaffold` is the adapter's projection of a placeholder stamp on either side:
`crawler.scaffold.<symbol>` from the repo crawler, `mcp.scaffold.<symbol>` from
the live fetcher (the `spec.otel` block, collector receivers/processors,
logs/traces exporters, fallback backends, the `platform-overview` stub, the
SEV1 route, baselines, guessed SLI/SLOs and the burn-rate placeholder — see
`MCP_INTEGRATION.md`). Both sides can therefore contribute parked artefacts:
`diffPacks` moves them to the `scaffold` bucket before pairing (see
[Buckets](#buckets)), the requirement-chain comparison
(`comparePackBranches`) refuses a `Scaffold` live node as evidence — a
declared node against it reads `declared_only`, and a placeholder is never a
`live_only` node or an `undeclared` branch root — and the requirement
traceability chain skips a scaffold burn-rate entry when deciding
`missing_alert_evidence`. A live-pack placeholder therefore never weighs in
as `Live, not declared` and a repo scaffold never as `Declared, not live` on
**any** path: the diff-bucket grade, the requirement-chain grade the studio
and the journey CLI score on, and the journey's `alignmentPct` /
`declaredNotLive` gate facts (`isScaffoldDiffEntry` still filters older
diffs that carry no `scaffold` bucket).

Weighted fidelity is:

```text
aligned / (aligned + weighted_badness)
```

The current trusted-fidelity threshold is derived from decision cost: weighted
badness must stay below about `0.176` per confirmed artefact, roughly one
high-cost false reassurance per six confirmed controls. That maps to about
85% fidelity. The drift-free criterion contributes fractional credit equal to
the measured weighted fidelity; crossing the threshold decides whether the row
is safe to trust.

With nothing compared (an empty union, or nothing but placeholders to weigh)
the fidelity is `null` (`computeWeightedDeltaRisk` → `health` / `healthPct`
null), and Drift-free earns nothing: its detail begins `nothing compared`.

## Public API

```js
import { keyOf, projectOf, deltasOf, diffPacks } from './tools/lib/diff.mjs';

keyOf(artefact);              // behavioural identity key
projectOf(artefact);          // comparable contract projection
deltasOf(a, b);               // contract deltas; on a burn-rate pair also those of its source rules (`rule`)
diffPacks(aLayered, bLayered); // directional drift report
diffPacks(aLayered, bLayered, { scopeMode, service, identity }); // scopeMode service | family | all; identity as above
```

## Regression Coverage

`tools/test-diff.mjs` verifies:

- pack-vs-self preserves every artefact, including duplicate identity keys;
- duplicate SEV2 routes survive as distinct controls, and every duplicated
  identity group is reported once on `collisions` with its layer and counts;
- a declared route pairs with the live connector's fabricated placeholder
  route as channel drift, never as missing-in-live;
- surplus duplicate controls are reported as drift rather than dropped;
- empty arrays normalise like absent fields;
- dynamic metric families (members, literal pairs first, series of a folded
  metric, case, name length, first match, unmatched and not checked, refused
  patterns, either side, a self-diff, the kind and the scope, no key without
  one);
- metric families (each folding rule, and the lone `_count` that is not
  folded), `notObserved` in both directions and outside the union, and an
  address one side withholds.

`tools/test-golden-diff.mjs` (`npm run test:golden:diff`) pins the whole
default answer of 27 cases, written before rebadge batch 3 touched the engine,
and runs each with `identity: 'behaviour'` and `identity: identityKeyOf` too.
`tools/test-identity-modes.mjs` holds the identity modes: every family's
material, the three count sets of `tools/fixtures/compare-modes/` (behaviour
15 in both / 5 / 5, name 16 / 4 / 4, id 17 / 3 / 3), a custom function, the
unnamed and placeholder keys, and the parity of `diffPacks` over the JSON
`GET /api/packs/:id` answers with `GET /api/diff`.

`tools/test-scan-live.mjs` is the end-to-end form: one system described as a
repository and as the answers a live MCP gives for it, scanned, drafted and
compared — nothing only on one side, nothing drifted — then with one rule,
one route and one metric taken away from the live side, each of which shows
and only it.

`tools/test-packs.mjs` additionally asserts the self-diff invariant —
`diffPacks(pack, pack)` preserves every flat-comparable artefact with
alignment and Jaccard 1.0 — for every bundled example and reference pack,
including the crawled `krystaline-repo-carlos.pack.yaml` with its real
identity collisions. `tools/test-traceability-graph.mjs` covers duplicate
identity keys in the dependency graph and branch comparison.
