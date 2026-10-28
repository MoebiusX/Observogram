# Overview — the 90-second demo

The script for showing Observogram to someone who will not read the screen.
Written 2026-10-27 for the investor follow-up and rewritten 2026-10-28 for
the board; the numbers are the ones the seed measured and will differ a
little on the day — read them off the screen, never from this page.

## Pre-flight (10 minutes before)

1. `npm run demo` in the repository (Node ≥ 22.16). Wait for
   `[demo] ready — open http://127.0.0.1:8010/?mode=overview&theme=dark&layout=board`.
   A first start takes about a minute: it drafts the live pack from the
   public MCP and runs the journey. A later start seeds nothing and runs the
   check again when the last one is older than ten minutes, so the page
   opens on *Checked a few minutes ago* and the live side is warm for the
   room (a cold endpoint answers its first probes in 20–30 s). The log says
   *the live side did not answer* when it is down — you know before the
   page opens. The second line it prints is the same page as the three
   sentences alone (`&layout=simple`): the fallback, should anything on the
   board look wrong in the room.
2. Open the address the seed prints, exactly as printed. It forces Overview,
   the board and the dark theme, and the browser remembers all three, so the
   profile that saw Expert yesterday, or the simple layout in a rehearsal,
   opens here too (`theme=light` for a bright projector).
3. Press **Check again** once (middle column) and watch it come back
   (3–30 s). If it comes back *Unreachable*, the public MCP is down: skip to
   "If live is down". If the ring and counts change a lot and the card says
   *the live side showed less than the check before*, read "If live answers
   only in part" before the room.
4. Leave the page on Krystaline · prod. Full screen, nothing else open. The
   three columns fit a 1366 × 768 laptop above the fold; there the seven
   criteria sit behind *Why this grade*, on a monitor taller than 1000 px
   they are open. Under 1100 px wide the columns stack — do not demo in a
   half-width window.

Rehearsed 2026-10-27 22:40: a second `npm run demo` starts in seconds and
seeds nothing; a fresh profile opens on Overview in dark; Check again came
back in 11 s; the refusal and the live-down states both render as written
here. 2026-10-28 00:50: the printed address opens Overview in dark on a
profile that held Expert; *Why this grade* reads its seven lines; the
picker lists Krystaline alone; the warm check at start reads as written —
and caught the stack behind krystaline.io restarting (one check half blind,
the next a 503, the one after B again), which is now its own beat below.

## The 90 seconds

**0:00 — the page.** Three columns, the words you showed last time on top of
each: Discover · Diagnose · Remediate. Say: *"This is the real service behind
krystaline.io. Left, what the repository puts in place, layer by layer — 600
things; the application layer has seven of the ten kinds of signal, the
user-experience layer none, and that is where the 35 in 100 comes from.
Middle, the grade — B, industrial grade — and whether what the repository
promises holds up in production right now. Right, what to change."*

**0:20 — press Check again** (middle column, under the ring). The row reads
*Checking against live now…*. Say, while it runs: *"It is talking to the
production monitoring stack through its MCP endpoint, drafting what is
actually deployed, and comparing it with what the repository promises."*

**0:40 — it comes back.** The ring and the four counts refresh — *78 %
aligned · 252 match · 5 run differently · 38 not running live · 30 live
only* — the row reads *Checked just now against live — 43 things differ from
what the repository declares*, the grade line *Graded against live, just
now*, and the right column *38 to add · 5 to update · 30 to review*. Say:
*"Same answer as last night. The moment it stops being the same, this card
says so first — that is the monitor of the monitors."*

**0:55 — point at the promises bar.** *5 of 18 promises hold end to end, 1
in part.* Say: *"A promise is an objective with everything it needs to be
true — the metric, the rule, the dashboard, the alert. Twelve are broken
somewhere along that chain, and that is the one thing in this grade that
moves with drift."*

**1:05 — Why this grade** (open on a tall monitor; on a laptop, open it).
Seven lines, each a yes, a partly or a no, and the sum: *4.8 of 7 points. B+
starts at 5.3.* Say: *"Four things it has, one nearly, two it lacks. That is
the whole grade; nobody has to take the letter on trust."* Above it, the
rules bar: *12 of 15 required rules met for a tier 2 service.*

**1:15 — press Open in Remediate** (bottom of the right column). Expert's
Remediate, on this service. Say: *"Everything you saw last time is one click
behind each column: Discover, Diagnose, Remediate — the same words."* Press
**Overview** to come back.

**1:30 — done.** Leave the board on screen.

## If live is down

The check comes back *Unreachable — Last check just now: the live side did
not answer, so nothing is known about it right now.* and the next step reads
*Check again once the live side answers*. Say: *"That is the product telling
you your monitoring is blind right now — the thing nobody's dashboard tells
them."* Do not retry on stage; the morning pre-flight decides which beat
this is.

## If live answers only in part

A probe family that answered the check before can fail on this one (the
stack behind the MCP restarting, a backend down for a minute). The engine
would read it as a flood of missing things; Overview does not. The check
comes back *Changed — Checked just now against live — the live side showed
less than the check before: its metric names could not be read, so what
differs cannot be told yet*, the letter falls back to the repository's C
with *the last live check saw only part of production* under it, and the
next step is **Check again**. Press it once. Say: *"It just told you it was
half blind, instead of inventing a number — most monitoring would have
paged you with 86 failures."* The night before the first demo (2026-10-28
00:26) this happened for real: one check read like this, the next got a 503
from the stack, the one after was B again.

On the board the ring and the four counts are withheld in this state, with
the reason in their place; the right column reads *Check against live to
count what to change.*

**Known since 2026-10-28 09:30:** the public MCP's `metrics_metadata` tool
now rejects the fetcher's call (it wants a `metric` argument), so every new
check loses the *metric names* family. On a workspace whose last good check
still had it, the first Check again in the room reads exactly as above (the
half-blind beat); a second Check again compares like with like and shows the
numbers again, smaller — the board then says *The live side answered only in
part: its dashboards and metric names could not be read.* under the counts.
A fresh seed starts in that state and never shows the beat. Either way the
screen says what it could not see; the fix is the fetcher's (another tool
for the metric inventory), not the screen's.

## Questions that may come

- **"Why a B when 43 things differ?"** Two measures. The 43 counts things
  the repository declares that are not running live, or run differently.
  The grade is seven criteria at a point each, and only one of them moves
  with drift: *holds up live*, scored on the 18 declared commitment chains,
  where 84 in 100 holds up — 0.84 of a point, just under the bar of 85. The
  other six (three kinds of signal, joined traces and logs, numbers for
  normal, checked against live; coverage of the stack and fault injection
  lacking) do not move with drift. *Why this grade* shows exactly this.
- **"The check found 43 differences and the grade went *up*?"** Yes. The
  repository alone grades C (3 of 7): with nothing live checked, the two
  live criteria score nothing. Checked against production it earns *checked
  against live* in full and 0.84 of *holds up live*. The grade says how well
  the service is observed *and verified*; a declaration nobody has checked
  cannot score on verification. The journey's own gate (85) still fails at
  69, which Overview reads as *Changed*, never as *Check failed*.
- **"Why is the Grafana part partial?"** The Grafana behind the public MCP
  answers 401 to the dashboards probe, so the live picture is five probe
  families of six; the screen says *live evidence is partial* in Expert and
  the grade accounts for it. A token on the endpoint would complete it.
- **"Why does Diagnose show a different letter?"** It does not when Pack B is
  the live draft (the same B); with no Pack B loaded, Diagnose grades the
  repository alone (C), which Overview says in its source line when that is
  the case. **See the differences** opens Neuron on the same journey, same
  numbers.
- **"Does it run by itself?"** The journey has no schedule in the demo, so
  *Checks run only when you click*; a schedule (`packc journey schedule`)
  turns it into continuous assurance, and Neuron shows the trend.
- **"What is a thing?"** An artefact the repository declares — an SLO, a
  recording rule, a dashboard panel, an alert route. The word is deliberate:
  Overview names no artefact types.
- **"What are the cells?"** Ten kinds of signal per layer — indicators,
  objectives, metrics, logs, traces, dashboards, alerts, runbooks, chaos
  tests, synthetic checks (on a laptop the legend under the stack names
  them; on a tall monitor each layer's own line names the kinds it has). A
  lit cell is a kind the repository declares on that layer, with how many;
  a dot is a kind seen live without a declaration. The four layers' average
  is the *coverage* line of the grade: the application row alone reads 70;
  platform 40, infrastructure 30 and the empty user-experience row bring the
  average to 35.
- **"600 things here, 43 differences there?"** The 600 is everything the
  repository declares, on every layer. The check compares what can be
  compared against the live side (its probe families) and counts 252 that
  match, 5 that run differently, 38 declared but not running, 30 running
  unasked; the rest is out of the live side's view, and the card says which
  families it could not read.
- **"Can I see the old page?"** `&layout=simple` on the address — the three
  sentences alone; the browser remembers it until `&layout=board`.

## After the meeting

Expert is unchanged; Overview is additive. The seed's workspace is
`.observogram-demo` (gitignored); delete it to start clean; a second demo
runs beside it with `npm run demo -- --port 8020 --workspace
.observogram-demo-board`. The design and its rules:
docs/UX_SCREEN_GRAMMAR.md "Two faces".
