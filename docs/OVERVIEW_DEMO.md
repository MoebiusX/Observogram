# Overview — the 90-second demo

The script for showing Observogram to someone who will not read the screen.
Written 2026-10-27 for the investor follow-up; the numbers are the ones the
seed measured that night and will differ a little on the day — read them off
the screen, never from this page.

## Pre-flight (10 minutes before)

1. `npm run demo` in the repository (Node ≥ 22.16). Wait for
   `[demo] ready — open http://127.0.0.1:8010`. A first start takes about a
   minute: it drafts the live pack from the public MCP and runs the journey.
2. Open http://127.0.0.1:8010 in a **fresh browser profile** (or press
   **Reset** in Expert once). A profile that already holds an Expert session
   keeps it; a fresh one opens on Overview.
3. Dark theme: open Expert once, press the theme button, come back — or set
   `localStorage.studioTheme = 'dark'`. The page follows the system theme
   otherwise.
4. Press **Check again** once and watch it come back (3–30 s). If it comes
   back *Unreachable*, the public MCP is down: skip to "If live is down".
5. Leave the page on Krystaline · prod. Full screen, nothing else open.

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

**1:10 — press Expert.** The service page, then Discover · Diagnose ·
Remediate. Say: *"Everything you saw last time is one click behind this."*
Press **Overview** to come back.

**1:25 — done.** Leave the letter on screen.

## If live is down

The check comes back *Unreachable — Last check just now: the live side did
not answer, so nothing is known about it right now.* and the next step reads
*Check again once the live side answers*. Say: *"That is the product telling
you your monitoring is blind right now — the thing nobody's dashboard tells
them."* Do not retry on stage; the morning pre-flight decides which beat
this is.

## Questions that may come

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
