# Overview — the 90-second demo

The script for showing Observogram to someone who will not read the screen.
Written 2026-10-27 for the investor follow-up; the numbers are the ones the
seed measured that night and will differ a little on the day — read them off
the screen, never from this page.

## Pre-flight (10 minutes before)

1. `npm run demo` in the repository (Node ≥ 22.16). Wait for
   `[demo] ready — open http://127.0.0.1:8010/?mode=overview&theme=dark`.
   A first start takes about a minute: it drafts the live pack from the
   public MCP and runs the journey. A later start seeds nothing and runs the
   check again when the last one is older than ten minutes, so the page
   opens on *Checked a few minutes ago* and the live side is warm for the
   room (a cold endpoint answers its first probes in 20–30 s). The log says
   *the live side did not answer* when it is down — you know before the
   page opens.
2. Open the address the seed prints, exactly as printed. It forces Overview
   and the dark theme and the browser remembers both, so the profile that
   saw Expert yesterday opens here too (`?theme=light` for a bright
   projector).
3. Press **Check again** once and watch it come back (3–30 s). If it comes
   back *Unreachable*, the public MCP is down: skip to "If live is down".
4. Leave the page on Krystaline · prod. Full screen, nothing else open. The
   three answers and an open *Why* fit a 768 px-tall laptop screen; *Why
   this grade* scrolls there and fits at 1080p.

Rehearsed 2026-10-27 22:40: a second `npm run demo` starts in seconds and
seeds nothing; a fresh profile opens on Overview in dark; Check again came
back in 11 s; the refusal and the live-down states both render as written
here. 2026-10-28 00:50: the printed address opens Overview in dark on a
profile that held Expert; *Why this grade* reads its seven lines; the
picker lists Krystaline alone; the warm check at start reads as written —
and caught the stack behind krystaline.io restarting (one check half blind,
the next a 503, the one after B again), which is now its own beat below.

## The 90 seconds

**0:00 — the page.** One letter, large. Say: *"This is the real service
behind krystaline.io. One letter says how well it is observed — B, industrial
grade, almost diagnostic grade. Under it: is that still true in production,
right now."*

**0:20 — press Check again.** The line reads *Checking against live now…*.
Say, while it runs: *"It is talking to the production monitoring stack
through its MCP endpoint, drafting what is actually deployed, and comparing
it with what the repository promises."*

**0:40 — it comes back.** *Checked just now against live — 43 things differ
from what the repository declares.* The grade line reads *Graded against
live, just now.* Say: *"Same answer as last night. The moment it stops being
the same, this line says so first — that is the monitor of the monitors."*

**0:55 — open Why.** Three lines: *38 declared things are not running live ·
5 things run differently live than declared · 30 things run live that the
repository does not declare.* Say: *"Three plain facts, no dashboards to
read. The button takes the engineer to the differences."*

**1:05 — open Why this grade, under the letter.** Seven lines, each a yes,
a partly or a no, and the sum: *4.8 of 7 points. B+ starts at 5.3.* Say:
*"Three things it has, one nearly, three it lacks. That is the whole grade;
nobody has to take the letter on trust."* Close it.

**1:15 — press Expert.** The service page, then Discover · Diagnose ·
Remediate. Say: *"Everything you saw last time is one click behind this."*
Press **Overview** to come back.

**1:30 — done.** Leave the letter on screen.

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

## After the meeting

Expert is unchanged; Overview is additive. The seed's workspace is
`.observogram-demo` (gitignored); delete it to start clean. The design and
its rules: docs/UX_SCREEN_GRAMMAR.md "Two faces".
