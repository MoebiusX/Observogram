# User Journey

Observogram has one product journey:

```text
Discover -> Diagnose -> Remediate
```

The journey is not a marketing funnel and not a dashboard catalogue. It is a
diagnostic workflow for one question:

> Is this service's observability diagnostic-grade?

Design and implementation decisions must shorten the path from raw inputs to
that answer.

## The Three Questions

| Step | User question | Product answer | Overview's stage asks | Expert's tab reads |
|---|---|---|---|---|
| Discover | What do we have? | Render the observogram from a repository scan, a live MCP draft or a pack. | What is in place? | What Do We Have? |
| Diagnose | Can we trust it? | Grade coverage and trust; show declared-vs-live drift. | Is it diagnostic-grade? | How reliable is this pack? |
| Remediate | How do we fix it? | Compile and deploy the source-backed delta, or update the repository from live. | What to change? | Resolve gaps |

The studio has two faces over the same three steps:

- **Overview** (`?mode=overview`) — the simplified face. It opens on the
  **Services** list; **Open** on a row draws that service's board: three
  numbered stages, *1 Discover · 2 Diagnose · 3 Remediate*, each over its
  column, every number the engine's own. `&layout=simple` is the fallback, the
  three sentences alone (*How well is it observed?* · *Is that still true
  right now?* · *What to do next*).
- **Expert** (`?mode=expert`) — the full studio: the home and its services,
  the service page, the three primary tabs, the Advanced views, Build or
  update a pack, Settings, and Neuron's journeys.

The switch, *Overview | Expert*, sits in the chrome on every screen; Advanced
→ Administration → **Overview** opens it too. Until the person picks a face, a
browser opens on Overview whenever the services table has rows, and on
Expert's home when it has none. The choice is the browser's
(`studioUiMode.v1`), never the snapshot's, and so is the layout
(`studioOverviewLayout.v1`); `?mode=` and `?layout=` win and are remembered.
In Overview the context bar, the tab cards and the Advanced menu are hidden.
From the board, **Expert** opens that service's page; **Overview**, or the
brand, returns to the Services list, where **Open →** draws the board again.
In Expert the brand returns to the home.

Expert's primary chrome uses the questions directly, one tab card each (step
word, title, tagline):

1. **Discover — What Do We Have?** — *Layers, artefacts and evidence*
2. **Diagnose — How reliable is this pack?** — *Assessment and comparison*
3. **Remediate — Resolve gaps** — *Update, compile and deploy*

Advanced views exist, but they are not the core journey. They support expert
analysis: Neuron, References, Conformance, Schema, OTLP Coverage,
Traceability, Atlas. The same menu's Administration group holds Settings,
Overview, Live MCP connection, Pack catalogue API, Switch light / dark theme,
Reset the studio… and About Observogram (version and build).

## OLA And Observability Contract

The OLA is the service's observability intent. Observogram represents that intent
as a canonical ObservabilityPack:

- criticality and ownership
- SLOs and SLIs
- telemetry and backend bindings
- recording rules and dashboards
- alerts, routes, and remediations
- validation evidence and freshness expectations

A service is two places: its **repository**, where the contract is declared,
and, for each environment, the **live MCP endpoint** that reads what runs. A
service's **Run** scans the repository now and registers the scan as the
service's own pack — Pack A, the declared contract — and reads the live side
through the environment's endpoint — Pack B, the verified live state. The
check is saved as the journey `<slug>.<env>` and run. Diagnose answers whether
the live production posture satisfies the declared contract well enough to be
diagnostic-grade.

What code cannot say, a repository can declare about itself: an
`.observability/*.yaml` file holding `kind: ObservabilityPack` is read by
every scan, in every environment scope. The scan takes its
`spec.validation.chaos_experiments` (spec 1.5), merged by id — the declared
entry wins over the one the scan discovered — and its `spec.baselines`, the
MTTD / MTTR targets the team holds itself to, in place of the placeholder
the scan writes otherwise. An entry that does not validate is left out with
a warning, never a failed scan.

## North-Star Flow

```text
Open the studio
  |
  v
Overview: Services          one row per service and environment:
  |                         its repository, its live MCP endpoint, its last check
  |-- Add a service         1 Service · 2 Environment
  |                         3 Repository (GitHub · Azure DevOps · Folder · Upload)
  |                         4 Live (an MCP endpoint of the org, or a new one)
  |                         5 Targets (MTTD / MTTR: a profile, custom minutes, or none)
  |-- Save and run, or Run on a row
  v
The Run
  |-- the repository scanned now: Pack A, the service's own pack
  |   (read as the person who runs it; the scan report kept)
  |-- the live side read through the environment's endpoint: Pack B
  |-- graded and compared; the run record kept
  v
Open: the board              1 Discover · 2 Diagnose · 3 Remediate
  |-- Layers: what the repository declares, layer by layer,
  |   and what the scan read and left out
  |-- A: the grade, Why this grade, the required rules
  |-- B: the alignment, four counts, the promises; Check again
  |-- Changes to apply: to add · to update · to review; the next step
  v
Open in Discover / Open in Diagnose / Open in Remediate
  |   Expert, bound to the service, with the live pack the board graded as Pack B
  |
  |-- Discover: the layered inventory
  |-- Diagnose: Assessment (grade, gaps, comparison and drift drill, evidence,
  |   requirement chains, response path, layer scores) · Compare
  |-- Remediate: the reconciliation plan
  |     deploy repository changes to live · update the repository from live
  |     · review differences individually · sync in both directions
  |-- compile selected artifacts
  |-- deploy through MCP write tools
  v
Check again (live against the last scan) or Run (the repository too), and compare again
```

Expert keeps its own doors for packs already in hand: the header's
**upload**, **scan a repo** and **new from live**, and the home's *Check an
existing service or pack*, load Pack A and Pack B directly into Discover and
Diagnose. Overview's Services list links there: *Already have the packs?
Upload one or compare two instead*.

## Diagnostic Grade Contract

The Diagnostic Grade is the top-level answer. It is scored from seven
criteria (grade schema 4), plus one informational operability check:

### Coverage - Are We Observing The Right Things?

1. **Multi-modal** - at least three of metrics, logs, traces and profiles are
   declared as telemetry backends.
2. **Correlated** - a tracecontext propagator is declared, with log
   correlation or a logs backend, so traces and logs can be joined.
3. **Calibrated** - SLOs have numeric objectives and baselines are declared
   (the scan's default baselines and the SLOs it invents from an alert name,
   scaffolds, do not count); where the repository states no baselines, the
   MTTD / MTTR targets set in the studio for the service count, said as the
   studio's.
4. **Comprehensive** - coverage spans the major service layers (the average
   of the posture matrix's four layers: infrastructure, platform,
   application, user experience); met when that average reaches 50 in 100.

### Trust - Can We Trust What The Signals Show?

5. **Chaos-validated** - declared experiments earn a quarter (a scaffold
   does not count); full credit needs a recent passing run of every one, from
   its `last_result` or the live run feed, within the window its schedule
   sets. A failed newest run earns nothing
   ([`CHAOS_EXPERIMENTS.md`](CHAOS_EXPERIMENTS.md)).
6. **Drift-free** - declared artifacts match live state. It earns partial
   credit: the integrity of the declared requirement chains is the points
   (0.85 of a point at 85 in 100), and the criterion is met at the bar of 85;
   without chains, the weighted share of declared artifacts confirmed live
   (what runs live undeclared costs a little); with no comparison, the share
   of live probes that answered; with nothing live, nothing.
7. **Fresh** - the live signal was verified recently: within 24 hours. A live
   picture that does not say when it was taken does not count as recent.

Chaos-validated, in full (`chaosProof`, `studio/diagnostic-grade.mjs`):

| State | Score |
|---|---|
| no experiment declared | 0 |
| declared, never run (an aborted run counts here) | 0.25 |
| stale: the newest pass is past its window | 0.25 |
| failed: the newest run of any experiment failed | 0 |
| proven | 0.25 + 0.75 × fresh passes ÷ declared |

- The windows come from the experiment's `schedule`: daily 2 days, weekly 8,
  monthly 35, on-demand and ci 90.
- A run is the live run feed on Pack B (`mcp.chaos.runs`, measured) or the
  pack's own `last_result` — recorded in the repository, or in the studio
  with *Record a chaos run…* (said as the studio's) when newer than the
  repository's; the live one wins.
- The scan reads experiments from code (a scenario table in a file with
  `chaos` in its path), from Chaos Mesh and Litmus resources (a Litmus
  `ChaosExperiment` is a template, never declared) and from the repository's
  own `.observability/*.yaml`.
- The live side never holds an experiment's definition: a live pack keeps
  `observogram.unobserved.chaos`, with what the feed reported, and the
  screens say the live side cannot observe chaos experiments.
- An experiment sits on the layer of its target, else of its steady-state
  SLO, never of the words in its name. The posture matrix's chaos column
  counts presence (*declared*); proof lives in this criterion alone.

A scaffold earns nothing (since grade schema 3). The MTTD/MTTR baselines
every scan writes as defaults (`crawler.scaffold.baselines`, and the live
fetcher's `mcp.scaffold.baselines`) do not make a pack Calibrated, and a
library experiment still on its generic fault does not make it
Chaos-validated. In the conformance rubric, a check the crawler or the live
fetcher invented (the health check written when a repository has none)
satisfies no clause, while a library placeholder (`library.todo.*`) still
represents its requirement and is listed as passing on a placeholder.

### Operability - Can Oncall Act On What It Sees? (informational, not scored)

- **Actionable** - alerts lead to a runbook or remediation path. This
  measures response readiness of the overall observability solution, not
  diagnostic capability, so it is observed and displayed but never moves
  the score (reclassified 2026-06-10; journey run records carry
  `grade.schema` so score history steps are explainable).

The audit verdict (the machine contract journeys gate on) is:

```text
PASS when score > 85%
FAIL otherwise
```

The displayed verdict is the **instrument grade** the score lands on,
rendered as a full ladder with the current rung highlighted:

| Grade | Class | Score band |
|---|---|---|
| A++ | Calibration / Reference Grade | not score-reachable (external benchmarking) |
| A+ | Laboratory / Research Grade | ≥ 95% |
| A | Diagnostic / Clinical Grade | > 85% — anchored to the audit bar |
| B+ | Inspection Grade | ≥ 75% |
| B | Industrial Grade | ≥ 62.5% |
| C | Field Grade | ≥ 37.5% |
| D | Consumer Grade | < 37.5% |

A or better and audit PASS are by construction the same statement. Journey
run records carry `grade.letter` alongside `grade.score`.

Failed criteria still render as evidence. A score can pass while drift remains
visible. That is intentional: the grade answers whether the posture is
diagnostic-grade overall; the drill-down tells the team what to fix next.

The repository alone grades without its live side: with nothing live
checked, Drift-free and Fresh score nothing, and the source line says
*Graded from the repository alone.* Checked against live, the same pack can
grade higher while differences are found: the grade says how well the
service is observed and verified, and a declaration nobody checked cannot
score on verification.

A criterion that does not apply to a service can be switched off for it — a
project with no fault injection has no use for *Chaos-validated*. On the
board each line of *Why this grade* ends with *Not for this service…*, which
asks why in place; **Stop grading it** saves the switch on the service's
record (who, when, why) and checks against live again. The letter is then
over the criteria that are on — *Graded on 6 of 7 criteria*, *3.9 of 6
points* — and the ones off are listed under the reasons, each with **Grade it
again**. Expert's Diagnose says it too — *on 6 of 7 criteria* beside its
score, and the criterion's own row reads *Off* with why, who and when. Each
scored row of its checks has a switch: flipping one is a what-if (the grade
is taken again at once, nothing saved), and **Keep for** the service saves
the set, asking once why. Every run of the service's checks grades the same way and its record
names what it left out; a run that graded on other criteria is not the
board's letter until the next check. README, *Criteria a service is not
graded on*.

What the comparison finds is taken as the service's until a person says
otherwise: a difference can be set aside for it. In Expert's Diagnose,
against live, the comparison's row opens on *The differences* — declared, not
live and live, not declared, by layer — each with a switch, a layer with one
for all of it. A switch is the same what-if (the grade, the counts and the
chains taken again at once), and **Keep for** the service saves it as *Under
development* (reviewed on a date; past it the difference counts again) or
*Not this service's*. Every screen that counts the differences says how many
are set aside, Remediate proposes nothing for them, and every run of the
service's checks grades without them. README, *Differences set aside*.

On Overview, *Why this grade* gives the seven criteria as seven plain lines,
each with *Yes*, *Partly* or *No*, the yeses first, and the sum with the next
band (*3.8 of 7 points. B starts at 4.4.*). Five lines read the repository
alone; *holds up live* and *checked against live* come from the run that
graded the letter, or say that nothing live was checked. The list is offered
only when it adds up to the letter on screen (within two points of a hundred),
only for a run graded under the current schema, and only when that run scored
Drift-free on the declared requirement chains; a run recorded under an
earlier schema explains nothing until the next check.

## Pack Roles

| Role | Meaning |
|---|---|
| Pack A | The declared posture. In a service's Run, the scan of its repository: the service's own pack, registered as `<name> · <env> · repository`, replaced by the next Run's scan. |
| Pack B | The verified/live posture, read through the environment's MCP endpoint. The live side a journey's last run read is kept as `<service> · <env> · live` (else `<journey> · live`), never a primary, replaced by the next run. |
| Reference pack | A curated target posture used for benchmarking, not the default dry-run path. |

The dry-run path is **repo vs live**, not repo vs aspirational reference.

## Required UI Invariants

1. **The first screen must be useful.** Where the services table has rows,
   the first run opens on Overview's Services list, every row with its last
   check and its Run. An empty list says how a service is checked and offers
   **Add a service**; where the table has no rows, the studio opens on
   Expert's home, which lets a user create or load a pack immediately
   (*Check an existing service or pack* · *Build or update a pack*).

2. **A service is its repository plus a live endpoint.** The record holds
   where the repository is — GitHub, Azure DevOps, a folder on the server, or
   an upload from the person's own machine — and each environment holds the
   MCP endpoint that reads what runs there. A Run reads both again and grades
   the one against the other. A row missing a place says which (*Add the
   repository*, *Choose the MCP endpoint*, *Add an environment*), and its Run,
   drawn unavailable, says why when pressed.

3. **Repository access is the person's.** A GitHub or Azure DevOps repository
   is read as the person who runs it: their own token, which the server uses
   for that one read only (the studio holds it in the tab's memory and sends
   it with this tab's Runs of that host's repositories), or their sign-in to
   the host; an upload's files came from their own machine. The server's own
   token reads only on a server without sign-in. The server never stores,
   logs or sends back a person's token, and a sign-in's token stays in a
   cookie the page cannot read. A schedule, **Check now** and **Check again**
   never read the repository: they check live against the last scan a
   person's Run made.

4. **The scan says what it left out.** Every door — a GitHub or Azure DevOps
   read, a Folder, an Upload, the CLI, Expert's folder, drop and .zip — reads
   files by the crawler's one rule. The local doors honour the folder's
   `.gitignore` files. No door reads a YAML or JSON file whose name holds
   `secret`; each names it instead. A Run keeps its scan report in the run
   record (`packA.scan`); the Run's toast counts what was not read, what fell
   past the file cap, what the environment's scope left out and what was
   recognised as nothing, and the board lists those files with why. A grade
   never rests on files nobody was told were missing.

5. **The board never claims what nobody checked.** Numbers are withheld with
   the reason, never drawn as zeros: when nothing live was checked, when the
   live side did not answer, and when it showed less than the check before
   (a probe family newly failed). The letter then falls back to the
   repository's and says why. *Why this grade* appears only when its lines
   add up to the letter. A check whose Pack B is a recording is graded
   *against a live recording* and has no Check button: re-reading a file
   proves nothing about production. The chaos line says what the experiments
   prove: proven on a date and by what (measured live or recorded in the
   repository), the experiment that failed and the alerts that did not fire,
   a pass older than its window, or declared and never recorded as run. With
   none declared it says what each side could not see, never that recovery
   is unproven. Each line counts what the engine counted, so the seven lines
   still add up to the letter.

6. **Overview speaks plainly, with one primary button.** Four status words
   on the board and no others — *Never checked · Unchanged · Changed ·
   Unreachable*; the Services list's last check reads *Checked 2 hours ago*,
   *Never checked*, *Unreachable*, or *Not known* when the checks could not
   be read. No sentence the model returns carries a percentage, a layer code,
   an artefact id or an engine state word (declared only, scaffold,
   candidate, recorded live); a number is drawn as a picture — the ring, the
   bars — and the renderer puts the sign on it. At most one primary button
   on the screen: exactly one wherever there is something to do from here
   (**Add a service**, **Save and run**, the next step or **Check again**),
   none over the start's cards or where nothing can be done. Colour says
   which layer; the pill beside it says how well.

7. **The three primary tabs are the workflow.** Do not add another first-class
   navigation layer that competes with Discover, Diagnose, Remediate. The
   service page is the home's second level — a card opens it, its actions
   open the three tabs bound to the service — not a fourth tab. Overview is a
   face of the same journey, not a fourth tab: its stages use the same
   words, and each column ends in the link to its Expert view, bound to the
   service.

8. **Pack identity must be explicit.** Uploaded/crawled/drafted pack selectors
   must show enough source context to prevent stale or typo uploads from being
   mistaken for the dry-run input. The header names **Pack A** and **Pack B**,
   each with its environment, on every workspace screen.

9. **Pack B means comparison.** When a live pack is loaded as Pack B, Diagnose
   must be able to answer repo-vs-live drift without another conceptual mode.
   Expert opened from the board binds the live pack the board graded as Pack
   B, so Diagnose shows the board's letter; when the board graded the
   repository alone, it opens with no Pack B.

10. **The Assessment is one screen.** Diagnose's verdict band carries the
    grade letter, its plain name and one sentence, and the score on the grade
    scale with the distance to the target (grade A, above 85%); its context
    line names both packs (*Declared* and *Live*, or the pack and its
    *Baseline*). The live target belongs in the context and the comparison,
    not in the grade title. Under it, the checks behind the grade: one row
    each, said once, opened for the why and the fix. The formal term, the
    ladder and the scoring rules sit behind *How the grade is calculated*, a
    folded row like the comparison, the layer scores and the evidence ledger.

11. **Drift remains evidence, not decoration.** Declared-not-live, drifted, and
    live-only signals must stay visible even when the overall grade passes.

12. **Remediate separates deployable from manual.** Source-backed artifacts may
    be selected for deploy. Inferred guidance must be labelled and kept out of
    default deploy selections.

13. **State must not create false confidence.** Persisted local state is useful,
    but reset and source labels must make stale comparisons easy to clear.
    From the board, Pack B is the board's comparison or none: a Pack B left
    from an earlier Expert visit is cleared.

14. **Services are records.** The home and the SERVICE selector read the
    services table (`GET /api/services`); a service page binds Discover ·
    Diagnose · Remediate · Build to a service and an environment through one
    pack resolver (the newest primary); a pack-derived tile appears only where
    the table is unavailable (the static bundle) or for a registered pack whose
    service row was deleted, and behaves as before. Overview's Services list
    reads the same table; where there is none (the static bundle), Overview
    keeps the board and draws no list.

15. **Settings is entered from a menu, not a tab** (Advanced → Settings; the
    account menu); it never competes with Discover · Diagnose · Remediate.

## What Belongs In Each Step

### Overview: the Services list

Overview's front door. One row per service and environment, in the columns
*Service · Repository · Live · Last check*, the rows a person can run first.
Each one is checked where it is declared — its repository — against where it
runs, read through its live MCP endpoint.

Belongs here:

- the service's name and its environment as a pill;
- the repository: its kind (*GitHub · Azure DevOps · Folder · Upload*) over
  `owner/repo`, `project/repo` or the folder's name, the branch or the full
  path beneath; an upload's name with *uploaded 2 days ago · 12 files*;
- the live endpoint: *MCP* over the endpoint's name and host;
- the last check: the grade letter, *Checked 2 hours ago*, how much matches
  live — or *Never checked · Run it to check*, *Unreachable* with *the live
  side did not answer*, or *Not known* when the checks could not be read;
- **Run** (*Running… Scanning the repository, then checking live*), **Open →**
  (the board, offered when the service has a pack of its own or a check) and
  **Change** (where it is declared, where it runs, its MTTD / MTTR targets);
- **Add a service**, the one primary button: five numbered answers — *1
  Service*, *2 Environment* (prod by default), *3 Repository — where it is
  declared*, *4 Live — where it runs* (one of the org's endpoints, or *A new
  MCP endpoint…* with *Endpoint URL*, *Its name* and an optional *Token
  variable* when this reader may register one), *5 Targets — how fast an
  incident is detected and resolved* (a dropdown: *Lab default — MTTD ≤ 1
  min · MTTR ≤ 5 min (recommended)*, chosen for a new service, the three
  other profiles, *Custom* with *MTTD, minutes* and *MTTR, minutes*, or *Not
  set*) — then **Save and run**,
  **Save** or **Cancel**. A name that keys an existing record completes it,
  never a second one;
- the Repository answer's kinds: GitHub or Azure DevOps with an optional
  branch and, under the address, *Your GitHub token* (*optional*: a public
  repository needs none) or *Your Azure DevOps token* — the person's own,
  sent with the Run that **Save and run** starts and kept for the tab by
  **Save**, not drawn where this tab already holds that host's token or the
  person is signed in to the host — with **Sign in to GitHub** (or Azure
  DevOps) before it where the server offers that sign-in, the form's
  answers kept while it is under way; **Folder**, its full path on the server, typed or picked with
  **Browse…** (the server's folders by name — *Up*, each repository marked,
  *Use this folder*, *Close* — drawn only where the server would take a folder
  from this reader); **Upload**, *Choose a folder*, *Choose a .zip* or a drop,
  read in the browser by the scan's rule and sent with Save, each Run scanning
  the kept copy again;
- the toast a Run ends with: *… checked: 200 of 396 files from … (196 past the
  file cap, 62 recognised as nothing), grade …, …% matches live.*;
- a missing answer marked where it goes once a save was tried; the server's
  refusal shown as its sentence; a Run that did not finish says why on its
  row, in the server's words;
- for a rank that cannot write (a viewer), **Add a service** and **Run**
  drawn unavailable, each saying why when pressed, the form's **Save and
  run** and **Save** disabled, and no **Browse…**, upload buttons, token
  field or token ask: drawn, never removed;
- the services a live draft saw with no repository yet, counted under the
  list (*3 more services were seen live with no repository yet. Show them*);
- *Already have the packs? Upload one or compare two instead* — Expert's home.

Does not belong here:

- the grade's explanation, the layers, the counts (the board's);
- a token's value — a typed token sits in a password field and, once sent,
  in the tab's memory only;
- a repository read with the server's own access on a server with sign-in;
- members and the org's MCP endpoint records beyond registering a new one
  here (Settings).

### Overview: repository access

A row whose repository is on GitHub or Azure DevOps has the place for the
person's own access on it from the start, unless this tab already holds
their token for that host, they are signed in to it, or its last Run read
the repository without their access — a public repository, or the server's
own token on a server without sign-in. No Run has to fail to be asked, and
a row that needs nothing shows nothing. The form that adds or changes a
service has the same two ways, so a new private repository's first **Save
and run** reads it. After a refusal the row says what the host answered,
and runs again once answered.

Belongs here:

- **Sign in to GitHub** or **Sign in to Azure DevOps**, where the server is
  set up for the host and has sign-in: the host's own sign-in in a window
  that reports back, after which every Run of that host's repositories reads
  as that account in this browser (a token typed in this tab still wins; an
  Azure DevOps Server repository still takes a personal access token);
- or *Your GitHub token* (*Your Azure DevOps token*) and **Run with it**,
  sent with this tab's Runs of that host's repositories and never kept on
  the server; the row's own **Run** sends what the field holds too, and
  with it empty reads a public repository as before; a token the host
  refuses is dropped, and the row says so;
- the same field in the form, under the repository's address: **Save and
  run** sends it with the Run that follows, **Save** keeps it for the tab's
  next Run of that host, and neither keeps it when the save is refused;
- **Sign in to …** in the form too, before the field: a window where the
  browser allows one, else this tab goes to the host and comes back — the
  form's answers (never the token's field) are kept for the tab meanwhile
  and are there again, once, when it returns;
- no field on a row whose last Run read the repository with nothing or with
  the server's own token; a repository that stops being readable that way
  answers its next Run with the ask;
- a token typed and not sent yet staying in its field while the list is
  drawn again (a Run that ends, a select in the form), the caret where it
  was — and going with its field: a row that starts to run, another kind
  chosen, the form closed;
- above the list, under its heading, each token the tab holds with **Forget
  it**, and each host the person is signed in to (*Signed in to GitHub as …*)
  with **Sign out of GitHub**;
- the sentence the row asks with, naming whose access was refused: the
  token, or the account signed in, or a sign-in that has ended.

Does not belong here:

- a browser's own password store on these fields: each is marked so that
  it neither offers to keep what is typed nor fills a saved sign-in into it
  (measured in Chrome; its key icon in the address bar still shows while one
  is typed in);
- the host's token on any page: it comes back to the person's browser
  sealed in an HttpOnly cookie the page cannot read, bound to their login and
  session, and ends with the host's token, the session, signing out of the
  host or of Observogram;
- a sign-in on a server without sign-in (`OBSERVOGRAM_AUTH=off`), where the
  server's own token reads instead.

Expert's GitHub scan has a field for the person's token, sent with that scan
only, and its error offers the same sign-in button.

### Overview: the board

One service at a time. The header has **← Services**, the service picker
and the environment; under it the three stages, *1 Discover · 2 Diagnose · 3
Remediate*, each over its column in a 30 / 40 / 30 rhythm.

Belongs here:

- **Discover — The chain** (*Exporters, alerts, dashboards and MTTD / MTTR,
  as the repository declares them*; *… MTTD / MTTR set in the studio* when
  they are the studio's):
  - three tiles in the order a signal travels — **Exporters** (scrape jobs),
    **Alerts** (alert rules and burn-rate alerts, each counted under the
    tile), **Dashboards** (whole dashboards, never their panels) — each a
    count, its top edge green, amber or red; under the row, the warning a
    link carries (*10 of 18 objectives have no burn-rate alert.*, *No
    dashboard found in the repository.*);
  - the **MTTD / MTTR** tile: the targets the repository states (*MTTD 5m ·
    MTTR 2h*, both or none — the scan's placeholder never counts); else the
    ones set in the studio, said so (*Set in the studio (lab default), not in
    the repository; the grade counts them for Calibrated.*, the last clause
    only where it does); else *Not declared* with *Recommended: MTTD ≤ 1 min ·
    MTTR ≤ 5 min* and the other profiles behind a fold — and the MTTD this
    environment's newest chaos run recorded (*over the 5m target*: amber,
    never green; a failed or aborted run said as such), or *Not measured
    yet*; **Set targets…** (with none) or **Change targets…** (the studio's)
    opens a form on the list with the *Targets* answer alone (*MTTD / MTTR
    targets · Demo · prod*), the recommended profile chosen when there were
    none; Save (Enter too, never a Run) patches the targets alone, so a
    service with no repository or endpoint yet still gets them; Save or
    Cancel brings the board back, the focus on the button; a repository's own
    targets have no button (they come first); a chaos run that names no
    environment gives no verdict (amber, never green), and another
    environment's run is named (*Not measured in prod: a chaos test in
    staging measured MTTD 4m on 1 Nov.*);
  - **Record a chaos run…** beside it, for a pack that declares an
    experiment, opens a form on the list (*Record a chaos run · Demo ·
    prod*): the experiment, when it ran (your time, now), passed / failed /
    aborted, the measured MTTD (`45`, `2m30s`), the expected alerts that
    fired, a note. **Save and check again** keeps it with the service and
    checks again, so Chaos-validated, the tile's MTTD (*MTTD 45s in a chaos
    test on 11 Nov, recorded in the studio, within the 1 min target*) and the
    control room read it; the runs recorded here are listed under the form,
    each with **Forget**;
  - *Under it*, the detail in one line (*18 indicators · 18 objectives · 208
    metrics · 11 backends · 8 alert routes · 5 chaos tests*);
  - behind *The machinery and the layers*, the machinery in one line (*324
    panels · 39 recording rules · …*), the stack — user experience,
    application, platform, infrastructure — each layer with its ten kinds of
    signal (*SLI · SLO · Met · Log · Trc · Dash · Alrt · Run · Chaos · Syn*),
    lit where the repository declares that kind and carrying the count, a
    pill such as *7 of 10 kinds* — and the coverage (*Coverage reaches 35 in
    100 across the four layers.*) with what found no layer;
  - the scan line, *Read 200 of 396 files from … — 196 past the file cap, …*,
    amber when files the rule takes were lost, and behind it each group:
    *Not read* with each file and why, *Past the file cap* (a count: the read
    takes the likely artefacts first), *The host cut its file list short*
    when it did, *Left out by the prod scope* and *Read, recognised as
    nothing* with their files, and the scan's warnings;
  - **Open in Discover**;
- **Diagnose**:
  - one status strip for the column (*Graded against live · checked 2 hours
    ago · live side partial: dashboards not read · checks run when you
    click*);
  - **A — Are the right signals in place?** (*The repository against what
    good looks like*): the grade letter in a shield, its ladder name in plain
    words (*Field grade*), the verdict word, the required rules (*11 / 15
    required rules met · tier 2*) and *Why this grade*, closed until the
    reader opens it — where a criterion that does not apply to this service
    is switched off (*Not for this service…*, a reason required) and back on
    (*Grade it again*), and *Graded on 6 of 7 criteria* under the verdict
    word when one is off;
  - **B — Can you trust what the signals show?** (*The repository against
    live*): one line per link of the chain (*Exporters 21/21*, *Dashboards 7
    not read live –*, *Alerts 1 not as declared 66/66*), the chain's alignment
    as the ring; the promises (*5 of 18 promises hold in every link, 1 in part, 12
    broken.*), then the status word, one sentence with a time — the chain
    first, in its words (*… — 1 exporter and 2 alerts differ from what the
    repository declares, and 31 details beyond the chain.*; never "the chain
    matches" over a link live did not read) — and **Check again**. A check recorded before
    the runs counted by tier draws the alignment and four counts of
    everything — *match · run differently · not running live · live only* —
    as before;
  - **Open in Diagnose**;
- **Remediate — Changes to apply** (*Between the repository and live*): *to
  add · to update · to review*, each with its note (*review* never reads as
  removal) and its count by link (*Exporters 0 · Alerts 2 · Dashboards –*,
  the dash a link live did not read) — the chain's exporters, alerts and
  dashboards alone, the details in one line under them (*Beyond the chain, 31
  details differ: 31 metrics. 4 more run live, not declared.*); a link live
  could not read said so, never "matches" (*Nothing to change in the
  exporters and alerts: they match live. Not read live, so not compared: the 7
  dashboards.*); the next step, one sentence and one button, in the chain's
  words (*Fix the 1 exporter and 2 alerts the live side does differently.*,
  *Exporters and alerts match live, the 7 dashboards could not be read; look
  at the 32 details beyond the chain.*, or *The chain matches live; look at
  the 31 details beyond it.*) — **See the
  differences** (Neuron, on the run whose numbers the board showed), **See
  what to fix** (Expert's Diagnose, with the assessment's first three causes
  behind *Why*), **Check now** or **Check again**, or **Open Expert mode**
  when the check reads a recording; with nothing to change, the sentence
  alone (*Nothing to do right now: live matches what the repository
  declares.*); **Open in Remediate**;
- where there is no Services list (the static bundle), or for a service with
  a check but no pack yet, the drift check started here in three steps —
  *Scan a repo* (Pack A: **Scan a repository** or **Upload a pack**),
  *Generate from live* (Pack B: **Generate live from MCP** or **Upload a
  pack**, waiting for Pack A), *Diagnose drift* (automatic: the pair is saved
  as the service's check, `<service>-repo-vs-live`, and run on the board;
  should the server refuse to save it, the comparison opens in Expert's
  Diagnose and the toast says why); under it, *Already have packs?* **Open
  Expert mode**. On a server, a new service starts with **Add a service**;
- **Control room** at the end of the context bar (a secondary button,
  unavailable with its reason when the environment names no live endpoint or
  the person may not read live): a panel at the right of the board, not a
  modal, starting below the context bar so its button stays in sight — it
  lies over the board's right (from 2040 px the board makes room for it), on
  a phone the whole screen —
  - *Control room* and the service · environment, **Refresh**, **Close**
    (and Escape); one line saying the endpoint, the time read and the next
    read (every minute while open; 1, 2, then 4 minutes after failures;
    *reads stopped* after a refusal; *cut at its time limit* when a slow
    endpoint left parts unread); one line saying the figures are the
    service's own (*Only Krystaline's own: the alert rules its repository
    names and its 21 scrape jobs, read through prod-mcp. A service that
    shares one of these jobs (an exporter or a collector they all use) is
    counted on it too.*) — or, before its first Run there, that nothing is
    read until it has been run;
  - the status word (*Critical · Warning · Firing · Quiet · Not known*), its
    sentence and the firing counts by severity — *Not known* when nothing
    of the service's fires and the store holds no history of its alerts;
  - **MTTR** and **MTTD** side by side: the median time an incident took to
    clear over the last 30 days with its incident count and p95, against the
    target the repository states, else the studio's (*· set in the studio*),
    else the recommendation with no verdict, with *Set targets…* / *Change
    targets…* under them (the panel closes, the form opens at its Targets
    answer); *too few to say* below five; the history's
    own read time when it is older than the rest; MTTD measured by this
    environment's newest chaos run recorded in the repository (a failed or
    aborted one said as such, with no figure; another environment's named
    beside), or *Not measured in prod: an alert knows when it fired, not when
    the fault began*; each with *How it is measured*;
  - what it found (a critical incident, a flapping alert, an alert still
    open, never an info heartbeat), the exporters up (and the declared ones),
    the active alerts, and one closed row per known metric family with its
    numbers (the worst first, *red* or *amber* in a word) and a 6-hour line;
  - the families the endpoint does not expose, named once;
- the simple layout, the three sentences alone, as the fallback
  (`&layout=simple`), drawn by the renderer itself should the board fail, and
  for a service without a pack of its own (one only a live draft has seen),
  whose next step is **Open Expert mode**.

Does not belong here:

- a count drawn as zero, or a letter graded against a smaller live picture;
- a count of everything the repository declares (*741 things*): the chain
  is counted, the rest named in a line;
- anything without an engine behind it: cost and ingestion, a quality trend,
  a 3-D tomogram;
- a second primary button;
- editing the pack, compile or deploy (Expert's, one click away).

### Home and the service page

Expert's home. When the services table has rows it is the org's services, one
card per record, and a card opens the service page: the environments as tabs,
each with the verdict the pack is graded to at the record's tier (a base grade
is named as such when the pack declares no overlay for that environment; "no
verdict yet" is said, never a zero), the MCP endpoint it is checked through,
and the four actions — Discover · Diagnose · Remediate · Build — bound to the
service and the environment through one pack resolver. Catalogue packs are
listed apart; the affordances are drawn from the effective role the server
reports for the active org (`GET /api/orgs`). On an empty workspace the home
is the hero. Both landings open with the same first decision: *Check an
existing service or pack* or *Build or update a pack* (*Start a new pack* ·
*Update a pack you have*).

Belongs here:

- the services table and the record's facts (tier, owners, the packs linked,
  the newest primary marked current);
- the verdict per environment — the conformance report at the record's tier,
  the mismatch with the pack's own tier said;
- the MCP endpoint as its name and origin only;
- the four actions, worded for the rank that reads them (a control a role
  cannot use is drawn disabled with its reason, never as usable);
- the record editor (name, owners, tier, description) for operators, and
  *Add environment* · *Edit environment*, which open Settings' environment
  editor;
- catalogue packs, apart from the records.

Does not belong here:

- a URL or a token (the endpoint's safe form is all the page shows);
- members and MCP endpoint records (Settings);
- journeys (Neuron) and the deploy history; the page says that drift runs
  are Neuron's, not part of this verdict;
- the service's repository and its Run (Overview's Services list: **Change**,
  **Run**).

### Settings

The org's administration, as a mode of its own: Advanced → Settings or the
account menu opens it, its Back returns to where it was opened from, and a
journey tab leaves it. The sections and every control in them are drawn from
the rank the server reports for the active org; a section or a write that
rank cannot use is listed `aria-disabled` with its reason, never hidden as if
it did not exist and never drawn as usable.

Belongs here:

- environments — every service's, each with its tier, bindings, links and
  MCP endpoint — read by every member, added, edited and deleted by
  operators (the same editor opens from the service page); a service's row
  also holds Delete…, which removes the service with its environments, pack
  links and waivers after a confirm step that names them;
- the org's MCP endpoint records for admins — the URL and the token as the
  NAME of a server variable under the org's prefix, never its value; a viewer
  reads the name and the origin only;
- members and the org's name for admins — add by login or verified email,
  change a role, remove; the last-admin rule drawn before the server says it;
- the audit for admins: the org's rows, filtered by whole UTC days, paged
  back; for owners, the deployment's;
- for owners, the deployment: users (a new local user's temporary password
  shown once, changed at first sign-in; the last-owner rule drawn first),
  organisations (create and switch to it, act in one they are not a member
  of, remove with the id typed) and the join role beside the sign-in mode it
  applies to;
- one banner naming the way in where the server names one — a token-only
  server, a server without sign-in, the static bundle — in the server's
  words;
- every editor a pop-up over one record, its status line naming what the
  server changed, or its refusal as served.

Does not belong here:

- services themselves (Overview's Add a service, Build and the service page
  write them);
- a secret's value — a token anywhere on the page, a password outside the
  one dialog that shows a new temporary password once;
- an email in a member row;
- a journey tab.

### Build or update a pack

A parallel journey for a service that has no pack (Build), or for a pack made
in Build that needs its next version (Update), in the same visual language as
the three steps below and ending in Discover
([`BUILD_JOURNEY.md`](BUILD_JOURNEY.md)). Build is reached from the home hero,
the service gate, the upload popover and the service page's *Build a pack for
<env>*; Update from the home's *Update a pack you have* and the header's
**update**; neither from the three primary tabs, and neither changes what
Discover, Diagnose or Remediate show. Both landings open with the first
decision — *Check an existing service or pack* or *Build or update a pack* —
and both paths join at Discover.

Belongs here:

- the pack as the axis of the screen on every step: a sticky definition column
  on the left — on Define the live form (the service; the tier as a segmented
  control with its MUST · SHOULD counts; the library entries as chips with their
  evidence dot), on Compile and Verify the read-only seed card it becomes once
  the pack is seeded (*Seed the pack →*; *Change seed →* returns), and under
  both the conformance summary — pass · on a placeholder · fail, the failing
  clauses, todos and placeholders left — and the layer stack of the pack being compiled
  as the main surface — L1 SLI/SLO · L2 Metrics/Logs/Traces · (L2X) · L3
  Dashboards/Recording Rules · L4 Alerts/Policy/Self-healing · L5 Self-check · GOV
  — drawn through the same adapter and the same
  artefact cards Discover uses, each slab's edge carrying the rubric's verdict
  for that layer (pass · pass on a placeholder · fail · neutral when no clause
  applies), a placeholder artefact as Scaffold, a clause the tier still needs as
  a ghost card on its slab
- a sheet per layer, opened from the slab head: the layer's question (L1 *What
  should we measure?* … GOV *Who owns it?*), its clauses at the tier with their
  state, and what the pack can carry on that layer — always read from the
  instantiated pack, never a made-up menu; one sheet at a time, Esc closes,
  focus returns to the slab; a preview on Define (*Compose in Compile →*),
  editable on Compile, read-only with the layer's todos on Verify
- Define: the service name, owners, environment, the criticality tier and the
  library entries in the definition column; the tier as the silhouette of the
  pack it demands (one ghost per clause per slab, reshaping with the tier), the
  entries' SLIs and their SLOs as candidates on L1
- Compile: composition on the sheets — the SLI rolodex on L1 (the selected
  entries' SLIs, every product's behind a filter, any SLI addable — one above
  the tier says which profile it starts from; the tier is a seed, not a gate —
  the objective and window it starts with, add / remove as a switch; adding
  from a product not yet selected selects it too; *Customise* edits a card's
  copy of the library's values in place — objective, window, bound, PromQL,
  description, each back to the library default in one click, an edited
  expression dropping the library's evidence to *custom* — and *+ Custom SLI*
  writes one from scratch) and the SLOs
  switch; the Dashboards, Policy, Routes and Validation switches on their
  layers, each saying which clauses it drops; the scrape targets, endpoints,
  channels and probe targets as params on the layer they shape — over the live
  stack of the instantiated pack (a section off dims its slab, marks its head
  *off* and its clauses go red on the edge), the pack YAML as a collapsible below
- Verify: the conformance verdict at the tier with three clause states (pass
  · pass on a placeholder · fail) and a maturity bar per layer, the schema
  verdict, the warnings, the stack with the todos pinned to the slab of the
  artefact each names (and on that layer's sheet) and the parameter that fills
  each one, the compiled artefacts, the hand-off ("Ready to continue?": resolve
  or adjust at Define, or continue with visible gaps, which registers the pack
  as an upload)
- Update ([`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md), slices 1 and 2): the
  header's **update** (beside **export**, while a pack is open) or the home's
  *Update a pack you have* reopens a pack made in Build on Build's screen;
  Compile names source and destination (*Updating v0.1.0 → saves as v0.2.0*),
  adds **+ SLI · + SLO · + Route · + Alert rule** and lists *Changes since
  v0.1.0*, each with *undo*; Verify shows the saved pack beside the pack with
  the changes, and **Save as <pack> v0.2.0** registers the next version of the
  same pack, keeping the earlier one under it. A scan, a live draft, an
  uploaded pack and a shipped example have no definition to reopen and say
  so

Does not belong here:

- a fourth primary tab (the header shows the build cards only while building)
- a pack that pages nobody presented as done: a placeholder-laden pack is
  conformant on paper, so the third clause state, the amber slab edges and the
  todo count travel with it into Discover
- a library value that cannot be changed, or a tier that forbids an SLI: the
  library seeds and the rubric grades; what the team measures is the team's
  (an edited expression carries no library evidence, and says so)
- a second rendering of the pack: the stack is the adapter's projection — the
  artefacts Discover will show, id for id — never a Build-only drawing of the
  canonical
- deploy actions (Remediate's, on the registered pack)
- what the update journey has not built: Remediate's *Open as the next
  version* and upload's *Save as the next version*, the live check of new
  expressions before saving, and slice 3 (keeping a scan or a live draft as
  one's own pack, changing what Build generated beyond its inputs)

### Discover

Discover is a catalogue: it lists what the open pack holds, layer by layer,
and judges nothing.

Belongs here:

- repo scan (a folder, a drop, a .zip or a GitHub URL; the staged panel lists
  *N files not read, and why*)
- live MCP generation
- YAML/JSON upload
- pack catalog selection
- layered artifact inventory
- source metadata and crawler summary
- an empty group that says why when its producer could not look (*None
  declared — the live side cannot observe chaos experiments*), else *None in
  this pack*
- the machinery (panels, recording rules, derived views, pipeline parts,
  instrumentation settings) folded on the board, each band saying what it
  folds with **Show the machinery**, and one *Machinery* switch, remembered,
  that draws it here and in Compare

Does not belong here:

- final diagnostic verdict
- a decision sentence, evidence or attention counts: with one pack there is
  nothing to judge against
- deploy actions
- benchmark marketing copy

### Diagnose

Belongs here:

- the Assessment, on one screen: the verdict band (the grade letter and its
  plain name, one sentence, the score on the grade scale; coverage, trust,
  live signals and requirement chains in a number each), then the checks
  behind the grade — one row per check, a what-if switch on each scored one,
  the row opened for what failed, why it matters and the fix
- score, coverage, trust, verified status
- everything else folded under the checks, a closed row each with its
  headline: Layer scores, the comparison, Requirement chains, Response path,
  the Evidence ledger, *How the grade is calculated*
- evidence table
- drift drill
- traceability to explain why an artifact matters
- the response path: which alert each declared remediation answers to, and
  whether that alert is live (read-only here; the fixes are on Remediate)
- Compare: Pack A and Pack B side by side, paired by behaviour, name or id,
  the machinery folded until the *Machinery* switch draws it
- the differences to set aside, a closed row per layer and the machinery's
  last, in one row of its own
- comparison and atlas analysis as advanced diagnostics

Does not belong here:

- deploy submission
- compile output as the main surface
- unrelated reference browsing

### Neuron (Advanced)

Where the board's **See the differences** leads, on the journey whose run the
board showed, and where the service page sends drift runs: every saved check
(journey) read as one instrument, run after run.

Belongs here:

- one sentence about the journey in focus, from its newest record, with **Run
  now** and the causes behind it;
- the saved journeys and their runs over time: outcomes, alignment and grade,
  the requirement chains and their causes, the schedule;
- the newest record opened up, and the saved-journey cards.

Does not belong here:

- a grade of its own: it reads the run records the engine wrote;
- editing the pack, compile or deploy (Remediate's).

### Remediate

Belongs here:

- A minus B delta
- the reconciliation plan, each strategy named by its effect and saying
  source → destination: *Deploy repository changes to live* (changes live
  systems), *Update the repository from live* (changes the repository),
  *Review differences individually* (preview only), *Sync in both directions*
- deployable rows
- manual follow-up rows
- compile preview
- deploy modal
- **export** (in the header while a pack is open): the pack.yaml and every
  compiled artefact as a ZIP, to commit to the repository
- validation status
- rollback/dry-run affordances
- the response path's next steps: deploy a missing burn alert, reconcile a
  drifted one, name the alert an unresolved trigger means

Does not belong here:

- hiding drift because the grade passed
- deploying artifacts without provenance
- forcing all artifacts through the same deploy path

## Dry-Run Golden Path

The path a person takes today, end to end:

1. Start the studio (`npm run dev`, `http://127.0.0.1:8000`) and sign in (a
   first boot seeds `admin` and asks for a new password at sign-in;
   `OBSERVOGRAM_AUTH=off` runs without sign-in). Until a face is picked, the
   studio opens on Overview's **Services** when the table has rows, and on
   Expert's home when it has none; **Overview** in the switch (or
   `?mode=overview`) opens the list.
   (`npm run demo` starts a populated studio on port 8010:
   [`OVERVIEW_DEMO.md`](OVERVIEW_DEMO.md).)
2. **Add a service**: the service, the environment, the repository (GitHub,
   Azure DevOps, a Folder or an Upload), the live MCP endpoint. A Folder is
   taken only under the folders `OBSERVOGRAM_REPO_ROOTS` lists or, where it
   lists none, on the server's own machine while it runs without sign-in on
   loopback; **Browse…** shows only what the server would take. Press **Save
   and run**. For a row already listed, press **Run**, or **Change** to say
   where it is.
3. For a private repository, give your own token first: in the form's
   field before **Save and run**, or in the row's before **Run** — both are
   there from the start. Or **Sign in to GitHub** (or Azure DevOps), in the
   form or on the row, where the server offers it.
4. Read the toast: the files read, of how many, from where, what was left
   out, the grade and how much matches live.
5. Press **Open →**. On the board, read what the scan left out under
   *Layers*; the grade and *Why this grade*; the four counts and the
   promises; the status strip, which names any probe family the live side
   could not read.
6. If the board reads *Unreachable*, or *the live side showed less than the
   check before*, press **Check again** before reading any count.
7. **Open in Diagnose**: Expert's Assessment of the scan against the live
   pack the board graded, with the same letter. Explain the remaining drift
   from the drift drill under Comparison and the requirement chains;
   Advanced → Traceability shows the SLO-to-artifact evidence.
8. **Open in Remediate**: choose the strategy, select the source-backed
   artefacts and compile them.
9. Deploy only when the MCP write target is ready: writes enabled, a client
   key, the backend's token on the MCP server ([`DRY_RUN.md`](DRY_RUN.md),
   *Deploy Gate*).
10. Press **Overview**, then **Open →** on the row; on the board **Check
    again** checks live against the last scan, and **Run** on the Services
    list reads the repository again too. Compare again.

[`DRY_RUN.md`](DRY_RUN.md) is the runbook of the first dry run (June 2026),
which loaded supplied pack files as Pack A and Pack B in Expert; that path
still works through the header's **upload**.

## See Also

- [`UX_SCREEN_GRAMMAR.md`](UX_SCREEN_GRAMMAR.md) - the screen contract, and "Two faces: Overview and Expert"
- [`OVERVIEW_DEMO.md`](OVERVIEW_DEMO.md) - the board in ninety seconds, on the seeded demo
- [`BUILD_JOURNEY.md`](BUILD_JOURNEY.md) - building a new pack: Define, Compile, Verify
- [`UPDATE_JOURNEY.md`](UPDATE_JOURNEY.md) - changing a pack that already exists: slices 1 and 2 built as *Build or update a pack*, slice 3 a proposal
- [`CHAOS_EXPERIMENTS.md`](CHAOS_EXPERIMENTS.md) - declared versus proven, grade schema 4
- [`DIAGNOSTIC_GRADE_FRAMEWORK.md`](DIAGNOSTIC_GRADE_FRAMEWORK.md) - what "diagnostic grade" means
- [`DIFF.md`](DIFF.md) - structural drift model
- [`MCP_INTEGRATION.md`](MCP_INTEGRATION.md) - live scan and write-back path
- [`CONFORMANCE.md`](CONFORMANCE.md) - maturity rubric scoring
- [`USER_STORY_CRAWLER_PROVENANCE.md`](USER_STORY_CRAWLER_PROVENANCE.md) - provenance for deployable artifacts
- [`UI_CONVENTIONS.md`](UI_CONVENTIONS.md) - how a studio view is built
- README, *A Service's Run* and *Whose access reads a repository* - the Run, the repository kinds and the sign-in configuration
