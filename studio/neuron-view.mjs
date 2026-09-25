// studio/neuron-view.mjs
//
// Advanced → Neuron — the observability control neuron as ONE surface: the
// monitor of the monitors, re-checking run after run that the artefacts which
// observe a system keep doing their job.
//
// The page follows the studio's screen grammar (docs/UX_SCREEN_GRAMMAR.md,
// the 2026-09 UX review): it answers "what needs my attention, and what do I
// do next" before it shows any chart.
//
//   1. Decision   one sentence about the journey in focus, from its newest
//                 record — "The latest check lost its vantage point four days
//                 ago." — with Run now and Investigate cause, the two or three
//                 causes behind it and a few plain measures. The outcomes a
//                 person must tell apart each keep their own label, tone and
//                 remedy: not run · unable to observe (the vantage was lost) ·
//                 check failed (the gate breached) · notification failed (the
//                 check ran, nobody was warned) · passed — plus a schedule
//                 that stopped producing runs.
//   2. Latest check   when it ran (relative and absolute), what it checked,
//                 the outcome, the affected service, the evidence or the
//                 missing prerequisite, delivery, schedule, next step.
//   3. Details    the fleet tiles that carry data, then the trends — held
//                 back until TREND_MIN_RUNS runs make a direction (an empty
//                 state says how many so far) — what breached and what the
//                 ranker blamed, then ONE journey in focus: its ladder per
//                 run, chain integrity, stack self-metric small multiples,
//                 run duration, and the newest record opened up (requirement
//                 chains, candidate causes, the transition since the run
//                 before, the gate, the stack evidence, the vantage, backend
//                 versions, delivery and the schedule snippets). The saved-
//                 journey cards (capture, run-now, history) stay at the bottom.
//
// The long "what is Neuron" explanation is an optional disclosure, not the
// first thing to read.
//
// Conventions (docs/UI_CONVENTIONS.md): the loader (`loadNeuronData`) fetches
// and builds the model through tools/lib/neuron-model.mjs; the renderer
// (`renderNeuron(container, { data, ui }, host)`) is data in, DOM out; the
// dispatcher entry (`renderNeuronView(view)`) composes the two. The model
// and the chart builders are imported at call time from /lib (the server
// exposes tools/lib there), never statically: the studio graph stays
// linkable headless and a failed load degrades to a message, never to a
// broken view.
//
// Honesty rules the surface keeps (see neuron-model.mjs header): gaps stay
// gaps, stack samples are drawn in one ink colour and worded as signals,
// ladder buckets are counts, candidate causes say "not a verdict", and a lost
// vantage is never worded as a failed check.

import { state } from './state.mjs';
import { api } from './api.mjs';
import { escapeHtml, toast } from './util.mjs';
import { host as appHost } from './host.mjs';
import {
  renderCaptureBar, renderJourneyCards, CHECK_OUTCOMES, checkOutcome, DELIVERY_OUTCOMES, runResultText, runErrorText,
} from './journeys-view.mjs';
import {
  decisionHeaderHtml, wireUxActions, emptyStateHtml, disclosureHtml, termHtml, announce, plural, listSentence,
} from './ux-kit.mjs';

const enc = encodeURIComponent;
const POST = { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: '{}' };
const LADDER_KEYS = ['healthy', 'degraded', 'broken', 'unobserved'];
// A neutral ramp: on-wire liveness buckets are counts, not verdicts, so no
// red/green — the accent for healthy, then greys by depth.
const LADDER_COLORS = ['var(--NRN, #0F766E)', 'var(--ink-5, #9AA3AD)', 'var(--ink-2, #1F3A5F)', 'var(--line, #D4D9DF)'];
const ACCENT = 'var(--NRN, #0F766E)';
const MUTED = 'var(--ink-4, #6B6B6B)';
// Blast radius segments: what would go blind if the node died. Structural
// exposure, not a claim that it is blind — so no verdict colour: the accent
// for SLOs, ink for alerts, a light grey for the other consumers.
const BLAST_KEYS = ['SLOs', 'alerts', 'other consumers (panels · dashboards · routes · remediations)'];
const BLAST_COLORS = [ACCENT, 'var(--ink-2, #1F3A5F)', 'var(--ink-5, #9AA3AD)'];
const MAX_BLAST_ROWS = 12;
const blastLegend = () => `<div class="nrn-legend">${BLAST_KEYS.map((k, i) => `<span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${BLAST_COLORS[i]}"></span>${escapeHtml(k)}</span>`).join('')}</div>`;
const blastItem = (n, label) => ({ label, values: [n.slos, n.alerts, Math.max(0, n.total - n.slos - n.alerts)], note: `${n.status || ''}${n.ladderStatus ? ` · ${n.ladderStatus}` : ''} · in ${n.chains.length} chain${n.chains.length === 1 ? '' : 's'}: ${n.chains.join(', ')} · ${n.panels} panels · ${n.dashboards} dashboards · ${n.routes} routes · ${n.remediations} remediations` });
// Integer y ticks for small counts; the chart's own nice ticks above that.
const countTicks = (maxV) => (maxV <= 6 ? { yMax: Math.max(1, maxV), yTicks: Array.from({ length: Math.max(1, maxV) + 1 }, (_, i) => i) } : { yMax: null, yTicks: null });
const MAX_STACK_PANELS = 12;
// The evidence blocks "Investigate cause" and the cause links can open.
const EVIDENCE_KEYS = ['vantage', 'gate', 'causes', 'chains', 'delivery', 'schedule', 'record'];

let _libs = null;
async function neuronLibs() {
  if (!_libs) {
    const [model, charts, stack, sched] = await Promise.all([
      import('/lib/neuron-model.mjs'),
      import('/lib/svg-charts.mjs'),
      import('/lib/stack-evidence.mjs').catch(() => null),
      import('/lib/schedule.mjs').catch(() => null),
    ]);
    _libs = { model, charts, stack, sched };
  }
  return _libs;
}

// ---------- loader ----------

export async function loadNeuronData({ fetchFn = api, window = 50 } = {}) {
  const { model } = await neuronLibs();
  const { journeys = [] } = await fetchFn('/api/journeys');
  const runsByName = {};
  await Promise.all(journeys.map(async (j) => {
    try { runsByName[j.name] = (await fetchFn(`/api/journeys/${enc(j.name)}/runs?limit=${window}`)).runs || []; }
    catch { runsByName[j.name] = []; }
  }));
  return { journeys, runsByName, window, model: model.buildNeuronModel({ journeys, runsByName, window }) };
}

// ---------- dispatcher entry ----------

export function renderNeuronView(view) {
  const section = document.createElement('section');
  section.className = 'section neuron-view';
  section.dataset.layer = 'NRN';
  section.innerHTML = `
    <div class="refs-head nrn-head">
      <h2 class="refs-title">Neuron <span class="nrn-title-sub">observability control</span></h2>
      <p class="refs-sub nrn-lede">Keeps checking that the artefacts which observe your systems still do their job, and warns early when one stops.</p>
      ${disclosureHtml('What is Neuron?', aboutNeuronHtml(), { cls: 'nrn-about' })}
    </div>
    <div class="nrn-body" id="nrn-body" aria-busy="true"><div class="refs-empty">Reading the saved journeys and their run history…</div></div>`;
  view.appendChild(section);
  refreshNeuron(section.querySelector('#nrn-body'));
}

// The explanation that used to open the page — now on demand, with the
// outcome guide and where the neuron shows up elsewhere in the studio.
function aboutNeuronHtml() {
  const guide = ['never-run', 'vantage-lost', 'gate-failed', 'pass'].map((k) => {
    const o = CHECK_OUTCOMES[k];
    return `<dt>${outcomeChipHtml(k)}</dt><dd>${escapeHtml(o.meaning)} <span class="nrn-guide-remedy">${escapeHtml(o.remedy)}</span></dd>`;
  });
  const df = DELIVERY_OUTCOMES.failed;
  guide.splice(3, 0, `<dt>${deliveryChipHtml('failed')}</dt><dd>${escapeHtml(df.meaning)} <span class="nrn-guide-remedy">${escapeHtml(df.remedy)}</span></dd>`);
  return `
    <p>Neuron is the monitor of the monitors. Every saved journey re-checks, run after run, that the artefacts which
      observe a system — dashboards, alerts, rules, scrape jobs and the chains that tie them to an objective — are still
      present, alive and doing their job. This page reads all of them as one instrument: the latest word, the trend,
      what broke, what the evidence points at, and one journey opened up. Signals stay signals; verdicts come only
      from a journey's gate.</p>
    <p class="nrn-guide-title">What a check can tell you</p>
    <dl class="nrn-guide">${guide.join('')}</dl>
    <p><strong>Elsewhere in the studio.</strong> Diagnose reads the same requirement chains per node — present but
      unhealthy · present but stale · unobserved — and says <em>blinds N SLOs</em> beside a missing or drifted
      artefact. Remediate compiles the <em>assurance</em> group (Watchdog + instrument liveness) into every rules file
      and deploys it as its own row. From a shell: <code>packc journey run --all</code> ·
      <code>packc journey schedule &lt;name&gt;</code> · <code>packc journey list</code>.</p>`;
}

async function refreshNeuron(container, host = appHost, { announceDone = false } = {}) {
  if (!container) return;
  container.setAttribute('aria-busy', 'true');
  try {
    const data = await loadNeuronData({ window: windowOf(state.neuronWindow) });
    await renderNeuron(container, { data, ui: uiFromState(data.model) }, host);
    if (announceDone) announce(`Neuron refreshed: ${plural(data.model.fleet.journeys, 'journey')}, ${plural(data.model.generatedFrom.runs, 'run')} in the window.`);
  } catch (e) {
    container.innerHTML = emptyStateHtml({
      title: 'Couldn\'t read the saved journeys.',
      checked: 'the journey listing and each journey\'s run history',
      body: e.message,
      actions: [{ action: 'refresh', label: 'Try again' }],
      tone: 'fail',
    });
    wireUxActions(container, { refresh: () => refreshNeuron(container, host, { announceDone: true }) });
  } finally {
    container.removeAttribute('aria-busy');
  }
}

const windowOf = (v) => ([20, 50, 100, 200].includes(Number(v)) ? Number(v) : 50);
function uiFromState(model) {
  const names = Object.keys(model?.perJourney || {});
  let focus = typeof state.neuronJourney === 'string' && names.includes(state.neuronJourney) ? state.neuronJourney : null;
  return { focus, metric: state.neuronMetric === 'grade' ? 'grade' : 'alignment', window: windowOf(state.neuronWindow) };
}

// ---------- renderer ----------

export async function renderNeuron(container, { data, ui }, host = appHost) {
  const { model: mdl, charts, stack: stackLib, sched: schedLib } = await neuronLibs();
  const model = data.model;
  const names = Object.keys(model.perJourney);

  if (!names.length) {
    container.innerHTML = `
      ${renderNoJourneys()}
      <h3 class="nrn-section-title" id="nrn-saved">Save a journey</h3>
      <div class="journeys-capture" id="nrn-capture"></div>`;
    renderCaptureBar(container.querySelector('#nrn-capture'));
    wire(container, { data, ui: { ...ui, focus: null } }, host);
    return;
  }

  const focus = ui.focus || mdl.defaultFocus(model);
  const d = model.perJourney[focus];
  const now = Date.now();
  const check = mdl.latestCheck(d, { now });
  const attention = mdl.attentionList(model, { now }).filter((a) => a.name !== focus);
  const fleetReady = mdl.fleetTrendReadiness(model);
  const u = { ...ui, focus };

  container.innerHTML = `
    ${renderDecision(model, d, check, attention)}
    ${renderLatestRecord(d, check)}
    ${renderToolbar(model, u, names, fleetReady)}
    ${renderFleet(model, u, charts, fleetReady, data)}
    ${renderFocus(d, charts, stackLib, schedLib, mdl.trendReadiness(d), fleetReady)}
    <h3 class="nrn-section-title" id="nrn-saved">Saved journeys</h3>
    <div class="journeys-capture" id="nrn-capture"></div>
    <div class="journeys-list" id="nrn-cards"></div>`;

  renderCaptureBar(container.querySelector('#nrn-capture'));
  renderJourneyCards(container.querySelector('#nrn-cards'), { journeys: data.journeys, runsByName: data.runsByName, stackLib, schedLib }, { onRun: () => refreshNeuron(container, host) });
  wire(container, { data, ui: u }, host, { investigate: investigateKey(check) });
}

// ---------- plain words ----------

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const countWords = (n, unit) => `${n < NUMBER_WORDS.length ? NUMBER_WORDS[n] : n} ${unit}${n === 1 ? '' : 's'}`;
// "four days ago" — the decision sentence's clock. Absolute time sits beside
// it in the latest-check record.
function agoText(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'at an unrecorded time';
  const min = Math.round(ms / 60e3);
  if (min < 1) return 'just now';
  if (min < 60) return `${countWords(min, 'minute')} ago`;
  const h = Math.round(min / 60);
  if (h < 24) return `${countWords(h, 'hour')} ago`;
  const days = Math.round(h / 24);
  if (days < 14) return `${countWords(days, 'day')} ago`;
  if (days < 60) return `${countWords(Math.round(days / 7), 'week')} ago`;
  return `${countWords(Math.round(days / 30), 'month')} ago`;
}
const capitalise = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
function absTime(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return iso || '';
  try { return new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }); } catch { return new Date(t).toLocaleString(); }
}
const fmtMs = (v) => (v >= 1000 ? `${Number((v / 1000).toFixed(1))} s` : `${v} ms`);

// One chip per outcome, each with its own tone and mark (ux.css assessment
// chips: ✓ passed · ✕ check failed · ! unable to observe · – not run), so
// colour is never the only cue.
function outcomeChipHtml(key) {
  const o = checkOutcome(key);
  return `<span class="ux-chip ux-chip-assessment ux-chip-${o.chip} nrn-outcome-chip" title="${escapeHtml(o.meaning)}">${escapeHtml(o.label)}</span>`;
}
// Delivery is a separate question from the check (ux-neuron.css gives it its
// own envelope mark).
function deliveryChipHtml(key) {
  const x = DELIVERY_OUTCOMES[key] || DELIVERY_OUTCOMES.unknown;
  return `<span class="ux-chip ux-chip-${x.chip} nrn-delivery-chip" title="${escapeHtml(x.meaning)}">${escapeHtml(x.label)}</span>`;
}

// The runs of one journey in the window, in words: "2 passed and 1 unable to observe".
function outcomeCounts(o) {
  return listSentence([
    o.pass && `${o.pass} passed`,
    o['gate-failed'] && `${o['gate-failed']} failed`,
    o['vantage-lost'] && `${o['vantage-lost']} unable to observe`,
    o['never-run'] && `${o['never-run']} not run yet`,
  ]);
}

// ---------- no journeys: the empty state explains ----------

function renderNoJourneys() {
  const ready = !!(state.selectedPackId && state.compareBId);
  return emptyStateHtml({
    title: 'Nothing is being watched yet: no journeys are saved.',
    checked: 'the workspace\'s saved journeys (.observogram/journeys/)',
    body: 'A journey is a saved comparison — a pack against what is live — that Neuron re-runs to check your observability artefacts keep doing their job. '
      + (ready
        ? 'Save the comparison you have open as a journey below, then run it here.'
        : 'Load Pack A and Pack B to compare, save that comparison as a journey, then run it here. Or add .observogram/journeys/<name>.journey.yaml by hand and check again.'),
    actions: ready
      ? [{ id: 'nrn-create-journey', action: 'create-journey', label: 'Save this comparison as a journey' }, { action: 'refresh', label: 'Check again' }]
      : [{ id: 'nrn-go-compare', action: 'go-compare', label: 'Choose two packs to compare' }, { action: 'refresh', label: 'Check again' }],
    tone: 'info',
  });
}

// ---------- 1. the decision ----------

const ATTENTION_TEXT = {
  'load-error': { label: 'definition does not load', why: 'It cannot run until the journey file is fixed.', tone: 'fail' },
  'gate-failed': { label: 'check failed', why: CHECK_OUTCOMES['gate-failed'].remedy, tone: 'fail' },
  'vantage-lost': { label: 'unable to observe', why: CHECK_OUTCOMES['vantage-lost'].remedy, tone: 'warn' },
  'notify-failed': { label: 'notification failed', why: DELIVERY_OUTCOMES.failed.remedy, tone: 'fail' },
  overdue: { label: 'its schedule stopped running', why: 'No run for more than two of its cadences. Check the scheduler that runs it.', tone: 'warn' },
  'never-run': { label: 'not run yet', why: CHECK_OUTCOMES['never-run'].remedy, tone: 'info' },
};

// Where "Investigate cause" goes for this state.
function investigateKey(c) {
  if (!c || c.loadError) return 'record';
  if (c.outcome === 'vantage-lost') return 'vantage';
  if (c.outcome === 'gate-failed') return 'gate';
  if (c.delivery === 'failed') return 'delivery';
  if (c.overdue || c.outcome === 'never-run') return 'schedule';
  return 'record';
}

function renderDecision(model, d, c, attention) {
  const f = model.fleet;
  const multi = f.journeys > 1;
  const e = escapeHtml;
  const o = checkOutcome(c.outcome);
  const ago = agoText(c.ageMs);
  const cadence = fmtCadence(c.cadenceMs);
  const who = multi ? `The latest check of ${d.name}` : 'The latest check';
  let html;
  let tone = o.tone;
  let verdict = o.label;
  let verdictTitle = o.meaning;
  let note = o.meaning;

  if (c.loadError) {
    html = `${e(d.name)}'s journey definition does not load, so it cannot run.`;
    tone = 'fail'; verdict = 'Cannot run'; verdictTitle = c.loadError; note = c.loadError;
  } else {
    switch (c.outcome) {
      case 'never-run': html = `${e(d.name)} has never run, so nothing is being checked yet.`; break;
      case 'vantage-lost': html = `${e(who)} lost its ${termHtml('vantage', 'vantage point')} ${e(ago)}.`; break;
      case 'gate-failed': html = `${e(who)} failed ${e(ago)}${c.breaches ? `: ${e(plural(c.breaches, 'criterion', 'criteria'))} of its gate ${c.breaches === 1 ? 'was' : 'were'} breached` : ''}.`; break;
      case 'pass': html = `${e(who)} passed ${e(ago)}.`; break;
      default: html = `${e(who)} ran ${e(ago)} with an outcome this studio does not recognise.`;
    }
    if (c.delivery === 'failed') {
      html = `${html.replace(/\.$/, '')}${c.outcome === 'pass' ? ', but its notification could not be delivered.' : ', and its notification could not be delivered either.'}`;
      tone = 'fail';
      note = DELIVERY_OUTCOMES.failed.meaning;
      if (c.outcome === 'pass') { verdict = DELIVERY_OUTCOMES.failed.label; verdictTitle = DELIVERY_OUTCOMES.failed.meaning; }
    } else if (c.overdue && c.outcome !== 'never-run') {
      html = `${html.replace(/\.$/, '')}, and none has run since: its schedule expects one ${e(cadence || 'regularly')}.`;
      if (tone === 'ok') { tone = 'warn'; verdict = 'Overdue'; verdictTitle = 'The schedule has stopped producing runs.'; }
      note = 'A schedule that stops running is a silent gap: nothing warns you until someone looks.';
    }
  }
  if (multi) note = `${note} Latest checks across ${f.journeys} journeys: ${outcomeCounts(f.outcomes)}.`;

  // The two or three causes behind the sentence, each with its action.
  const own = [];
  const last = d.latest;
  if (c.outcome === 'vantage-lost') {
    own.push({ title: 'The live source did not answer', why: errorGist(c.error), actionLabel: 'See what failed', actionId: 'evidence:vantage', tone: 'warn' });
  }
  if (c.outcome === 'gate-failed' && last) {
    const bs = last.breaches;
    if (bs.length === 1) own.push({ title: `Breached: ${bs[0].criterion || '?'}`, why: bs[0].detail || '', actionLabel: 'See the gate', actionId: 'evidence:gate', tone: 'fail' });
    else if (bs.length) own.push({ title: `${bs.length} gate criteria breached`, why: bs.slice(0, 3).map((b) => `${b.criterion || '?'}${b.detail ? ` (${b.detail})` : ''}`).join(' · ') + (bs.length > 3 ? ` · +${bs.length - 3} more` : ''), actionLabel: 'See the gate', actionId: 'evidence:gate', tone: 'fail' });
    const top = last.causes?.causes?.[0];
    if (top) own.push({ title: `Candidate cause: ${top.kind || '?'}`, why: `${top.evidence || ''} — ranked by evidence, not a verdict`, actionLabel: 'See candidate causes', actionId: 'evidence:causes', tone: 'info' });
  }
  if (c.delivery === 'failed') {
    const n = last?.notify || {};
    own.push({ title: 'The notification was not delivered', why: [n.error, n.httpStatus != null && `HTTP ${n.httpStatus}`].filter(Boolean).join(' · ') || DELIVERY_OUTCOMES.failed.remedy, actionLabel: 'See the delivery', actionId: 'evidence:delivery', tone: 'fail' });
  }
  if (c.overdue) {
    own.push({ title: `No run since ${ago}`, why: `Its schedule expects one ${cadence || 'regularly'}. Check the scheduler that runs packc journey run ${d.name}.`, actionLabel: 'See the schedule', actionId: 'evidence:schedule', tone: 'warn' });
  }
  const others = attention.map((a) => ({
    title: `${a.name}: ${ATTENTION_TEXT[a.reason]?.label || a.reason}`,
    why: ATTENTION_TEXT[a.reason]?.why || '',
    actionLabel: `Focus ${a.name}`,
    actionId: `focus:${a.name}`,
    tone: ATTENTION_TEXT[a.reason]?.tone || 'info',
  }));
  const causes = [...own.slice(0, others.length ? 2 : 3), ...others].slice(0, 3);
  const unseen = others.length - causes.filter((x) => x.actionId?.startsWith('focus:')).length;
  if (unseen > 0) note = `${note} ${unseen} more ${unseen === 1 ? 'journey needs' : 'journeys need'} attention: ${listSentence(attention.slice(-unseen).map((a) => a.name))}.`;
  if (causes.length < 3 && !c.scheduled && !c.loadError && c.outcome !== 'never-run') {
    causes.push({ title: 'Runs only when someone asks', why: 'No schedule is declared, so nothing checks between visits. A schedule turns this into continuous assurance.', actionLabel: 'Set up a schedule', actionId: 'evidence:schedule', tone: 'info' });
  }

  const quiet = c.outcome === 'pass' && c.delivery !== 'failed' && !c.overdue && !c.loadError;
  const secondary = c.loadError ? []
    : c.outcome === 'never-run' ? [{ id: 'nrn-investigate', label: 'Set up a schedule', action: 'evidence:schedule' }]
      : [{ id: 'nrn-investigate', label: quiet ? 'See the evidence' : 'Investigate cause', action: 'investigate' }];
  const primary = c.loadError
    ? { id: 'nrn-run-now', label: 'Check again', action: 'refresh', title: 'Re-read the journey definitions' }
    : { id: 'nrn-run-now', label: 'Run now', action: 'run-now', title: `Run ${d.name} now` };

  return decisionHeaderHtml({
    id: 'nrn-decision',
    eyebrow: 'Latest check',
    context: [
      { key: 'Journey', value: d.name },
      { key: 'Service', value: d.scope?.service || 'every service in the pack' },
      { key: 'Environment', value: d.scope?.env || '' },
      multi ? { key: 'Watching', value: plural(f.journeys, 'journey') } : null,
    ],
    decisionHtml: html,
    tone,
    verdict,
    verdictTitle,
    note,
    primary,
    secondary,
    causes,
    measures: decisionMeasures(model, d, c.trend),
  });
}

// A few plain measures: replaces the "0/1 pass", "0 sent", "1 without notify"
// tiles with what they mean.
function decisionMeasures(model, d, trend) {
  const f = model.fleet;
  const o = f.outcomes;
  const ran = f.journeys - o['never-run'];
  const notPassed = listSentence([
    o['gate-failed'] && `${o['gate-failed']} failed`,
    o['vantage-lost'] && `${o['vantage-lost']} unable to observe`,
    o['never-run'] && `${o['never-run']} not run yet`,
  ]);
  const del = Object.fromEntries(f.delivery.map((x) => [x.key, x.count]));
  const without = f.journeys - f.notifying;
  const runs = d.runs;
  return [
    {
      label: 'Journeys watched', value: String(f.journeys), tone: 'neutral',
      note: f.scheduled ? `${f.scheduled} on a schedule${f.scheduled < f.journeys ? `, ${f.journeys - f.scheduled} on demand only` : ''}` : 'none on a schedule — they run only when asked',
    },
    {
      label: 'Latest outcomes', value: ran ? `${o.pass} of ${ran} passed` : 'none yet',
      note: notPassed || (ran ? 'every journey that ran passed' : 'no journey has run'),
      tone: o['gate-failed'] ? 'fail' : o['vantage-lost'] ? 'warn' : ran ? 'ok' : 'neutral',
    },
    {
      label: 'Notifications, latest runs',
      value: del.failed ? `${del.failed} failed` : del.sent ? `${del.sent} sent` : f.notifying ? 'none needed' : 'not set up',
      note: [
        del.failed && del.sent && `${del.sent} sent`,
        del.skipped && `${del.skipped} had nothing to report`,
        without && `${without} ${without === 1 ? 'journey has' : 'journeys have'} no notifications — results show only here`,
      ].filter(Boolean).join(' · '),
      tone: del.failed ? 'fail' : 'neutral',
    },
    {
      label: `Run history of ${d.name}`, value: plural(runs, 'run'), tone: 'neutral',
      note: trend.ready ? `in the last ${model.window} — enough for trends` : `trends appear after ${trend.minRuns} runs; ${runs} so far`,
    },
  ];
}

// ---------- 2. the latest-check record ----------

function renderLatestRecord(d, c) {
  const last = d.latest;
  const o = checkOutcome(c.outcome);
  const row = (k, v) => `<div class="nrn-rec-row"><dt>${escapeHtml(k)}</dt><dd>${v}</dd></div>`;
  const when = last
    ? `${escapeHtml(capitalise(agoText(c.ageMs)))} <span class="nrn-rec-abs">${escapeHtml(absTime(last.startedAt))}</span>${last.tookMs !== null ? ` <span class="nrn-rec-abs">· took ${escapeHtml(fmtMs(last.tookMs))}</span>` : ''}`
    : 'Never — no run is on record.';
  const what = `Journey <strong>${escapeHtml(d.name)}</strong> compares Pack A <code>${escapeHtml(d.packA || '?')}</code> with Pack B <code>${escapeHtml(d.packB || '?')}</code> <span class="nrn-rec-abs">· gate: ${escapeHtml(gateBits(d.gate))}</span>`;
  const outcome = `${outcomeChipHtml(c.outcome)} <span class="nrn-rec-meaning">${escapeHtml(o.meaning)}</span>`;
  const s = d.scope || {};
  const service = `${s.service ? `<strong>${escapeHtml(s.service)}</strong>` : 'Every service in the pack (no service scope)'}${s.env ? ` · environment ${escapeHtml(s.env)}` : ''}${s.scopeMode ? ` · scope mode ${escapeHtml(s.scopeMode)}` : ''}`;
  const [evKey, evHtml] = evidenceLine(d, c);
  return `
    <section class="nrn-latest" id="nrn-latest" aria-labelledby="nrn-latest-title">
      <h3 class="nrn-section-title" id="nrn-latest-title">Latest check of ${escapeHtml(d.name)}</h3>
      <dl class="nrn-record">
        ${row('When', when)}
        ${row('What it checked', what)}
        ${row('Outcome', outcome)}
        ${row('Affected service', service)}
        ${row(evKey, evHtml)}
        ${row('Notification', deliveryLine(d, c))}
        ${row('Schedule', scheduleLine(d, c))}
        ${row('Next step', nextStep(d, c))}
      </dl>
    </section>`;
}

// The evidence behind the outcome, or the prerequisite that was missing.
function evidenceLine(d, c) {
  const last = d.latest;
  if (d.loadError) return ['Missing prerequisite', `The journey definition does not load: <code>${escapeHtml(d.loadError)}</code>`];
  if (!last) return ['Evidence', 'None yet — the first run takes the first reading.'];
  if (c.outcome === 'vantage-lost') {
    return ['Missing prerequisite', `The live source (Pack B <code>${escapeHtml(d.packB || '?')}</code>) did not answer${last.error ? `: <code>${escapeHtml(last.error)}</code>` : ''}. No drift, grade or requirement chain was read on this run.`];
  }
  const ch = last.chains;
  const facts = [
    last.drift ? `alignment ${last.drift.alignmentPct}%` : null,
    last.grade ? `grade ${last.grade.score}%${last.grade.letter ? ` (${last.grade.letter})` : ''}` : null,
    ch && ch.declaredTotal ? `${ch.intact ?? 0} of ${ch.declaredTotal} requirement chains intact` : null,
  ].filter(Boolean).map(escapeHtml).join(' · ');
  if (c.outcome === 'gate-failed') {
    const bs = last.breaches;
    const listed = bs.slice(0, 3).map((b) => `<li><strong>${escapeHtml(b.criterion || '?')}</strong>${b.detail ? ` — ${escapeHtml(b.detail)}` : ''}</li>`).join('');
    const top = last.causes?.causes?.[0];
    return ['Evidence', `${bs.length ? `${escapeHtml(plural(bs.length, 'criterion', 'criteria'))} of the gate breached:<ul class="nrn-rec-list">${listed}${bs.length > 3 ? `<li>and ${bs.length - 3} more — see the gate below</li>` : ''}</ul>` : ''}${facts ? `<span class="nrn-rec-abs">${facts}</span>` : ''}${top ? `<br><span class="nrn-rec-meaning">Candidate cause, ranked by evidence (not a verdict): [${escapeHtml(top.kind || '?')}] ${escapeHtml(top.evidence || '')}</span>` : ''}`];
  }
  return ['Evidence', facts || 'The record carries no drift or grade facts.'];
}

function deliveryLine(d, c) {
  const ds = c.delivery;
  if (!ds) {
    return d.notify
      ? `Set up: posts ${escapeHtml(d.notify.on || 'transitions')} to the webhook in <code>$${escapeHtml(d.notify.urlEnv)}</code>.`
      : `${deliveryChipHtml('not-configured')} <span class="nrn-rec-meaning">${escapeHtml(DELIVERY_OUTCOMES['not-configured'].meaning)}</span>`;
  }
  const x = DELIVERY_OUTCOMES[ds] || DELIVERY_OUTCOMES.unknown;
  const n = d.latest?.notify || {};
  const detail = ds === 'sent' ? [n.httpStatus != null && `HTTP ${n.httpStatus}`, n.reason].filter(Boolean).join(' · ')
    : ds === 'skipped' ? (n.reason || x.meaning)
      : ds === 'failed' ? `${x.meaning}${n.error ? ` ${n.error}` : ''}${n.httpStatus != null ? ` (HTTP ${n.httpStatus})` : ''}`
        : x.meaning;
  return `${deliveryChipHtml(ds)}${detail ? ` <span class="nrn-rec-meaning">${escapeHtml(detail)}</span>` : ''}`;
}

function scheduleLine(d, c) {
  if (!d.schedule) {
    return 'On demand only — nothing checks between visits. <button type="button" class="ux-link-btn" data-ux-action="evidence:schedule">Set up a schedule →</button>';
  }
  const txt = escapeHtml(scheduleText(d.schedule));
  if (c.overdue) return `${txt} <strong class="nrn-rec-warn">Overdue</strong> <span class="nrn-rec-meaning">— no run since ${escapeHtml(agoText(c.ageMs))}.</span>`;
  if (c.overdue === null && d.latest && !c.cadenceMs) return `${txt} <span class="nrn-rec-abs">· irregular cadence, so whether it is on time is not computed</span>`;
  return txt;
}

function nextStep(d, c) {
  const o = checkOutcome(c.outcome);
  const steps = [];
  if (d.loadError) steps.push('Fix the journey file so it loads, then check again.');
  else if (c.delivery === 'failed' && c.outcome === 'pass') steps.push(DELIVERY_OUTCOMES.failed.remedy);
  else if (c.overdue && c.outcome === 'pass') steps.push(`Check the scheduler that runs packc journey run ${d.name}: it has stopped.`);
  else steps.push(o.remedy);
  if (!d.loadError && c.delivery === 'failed' && c.outcome !== 'pass') steps.push(DELIVERY_OUTCOMES.failed.remedy);
  return escapeHtml(steps.join(' '));
}

// ---------- toolbar ----------

function renderToolbar(model, ui, names, fleetReady) {
  const opt = (v, label, cur) => `<option value="${escapeHtml(v)}"${String(v) === String(cur) ? ' selected' : ''}>${escapeHtml(label)}</option>`;
  const trendOff = !fleetReady.observedReady;
  return `
    <div class="nrn-toolbar" role="toolbar" aria-label="Neuron controls">
      <label class="nrn-ctl">Journey in focus <select class="nrn-select" id="nrn-focus" ${names.length ? '' : 'disabled'}>
        ${names.length ? names.map((n) => opt(n, n, ui.focus)).join('') : '<option>no journeys</option>'}</select></label>
      <label class="nrn-ctl">History <select class="nrn-select" id="nrn-window" title="How many of each journey's newest runs the charts keep">
        ${[20, 50, 100, 200].map((n) => opt(n, `last ${n} runs`, ui.window)).join('')}</select></label>
      <label class="nrn-ctl">Trend line <select class="nrn-select" id="nrn-metric"${trendOff ? ` title="Trends appear after ${fleetReady.minRuns} runs that could observe"` : ''}>
        ${opt('alignment', 'alignment %', ui.metric)}${opt('grade', 'grade score %', ui.metric)}</select></label>
      <span class="nrn-toolbar-spacer"></span>
      <span class="nrn-muted" title="journeys · run records in the window">${escapeHtml(plural(model.generatedFrom.journeys, 'journey'))} · ${escapeHtml(plural(model.generatedFrom.runs, 'run'))} in the window</span>
      <button type="button" class="ctrl-btn" id="nrn-run-all" ${names.length ? '' : 'disabled'} title="Run every saved journey now, one after the other (the CLI form is packc journey run --all)">▶ Run all journeys</button>
      <button type="button" class="ctrl-btn" id="nrn-refresh" title="Re-read the journeys and their run history">↻ Refresh</button>
    </div>`;
}

// ---------- 3. the fleet: tiles that carry data, then trends ----------

const pct = (v) => (v === null || v === undefined ? '—' : `${v}`);
const signed = (v) => (v === null || v === undefined ? '' : v > 0 ? `+${v}` : `${v}`);
function tile({ label, value, unit = '', note = '', delta = null, acc = 'is-gray', warn = false }) {
  return `<div class="mc-tile ${acc}${warn ? ' is-warn' : ''}">
    <div class="mc-tile-label">${escapeHtml(label)}</div>
    <div class="mc-tile-value">${escapeHtml(String(value))}${unit ? `<span class="mc-tile-unit">${escapeHtml(unit)}</span>` : ''}</div>
    ${delta !== null && delta !== undefined ? `<div class="mc-tile-trend"><span class="mc-tile-delta">${escapeHtml(delta)}</span></div>` : ''}
    ${note ? `<div class="mc-tile-note">${note}</div>` : ''}
  </div>`;
}
const few = (list, n = 3) => (list.length <= n ? list.join(', ') : `${list.slice(0, n).join(', ')} +${list.length - n}`);

// Only the tiles that have something to say: an empty metric card reads as
// "zero", which is not the same as "not measured yet". The journeys, latest
// outcomes and delivery counts live in the decision's measures.
function renderTiles(model, data) {
  const f = model.fleet;
  const tiles = [];
  if (f.loadErrors) {
    tiles.push(tile({ label: 'definitions that do not load', value: f.loadErrors, acc: 'is-red', warn: true, note: 'these journeys can never run until their file is fixed' }));
  }
  if (f.alignment.mean !== null) {
    tiles.push(tile({ label: 'alignment, latest runs', value: pct(f.alignment.mean), unit: '%', acc: 'is-blue', delta: f.alignment.delta === null ? null : `${signed(f.alignment.delta)} pts vs the run before (paired)`, note: `mean of the latest run of ${plural(f.alignment.n, 'journey')} with a value` }));
  }
  if (f.grade.mean !== null) {
    tiles.push(tile({ label: 'grade score, latest runs', value: pct(f.grade.mean), unit: '%', acc: 'is-blue', delta: f.grade.delta === null ? null : `${signed(f.grade.delta)} pts vs the run before (paired)`, note: `verification score · ${plural(f.grade.n, 'journey')}` }));
  }
  if (f.chains.declaredTotal) {
    const chainsPct = Math.round((f.chains.intact / f.chains.declaredTotal) * 100);
    tiles.push(tile({ label: 'requirement chains intact', value: `${f.chains.intact}/${f.chains.declaredTotal}`, unit: `${chainsPct}%`, acc: 'is-cyan',
      note: `ladder: ${f.chains.ladder.healthy} healthy · ${f.chains.ladder.degraded} degraded · ${f.chains.ladder.broken} broken · ${f.chains.ladder.unobserved} unobserved${f.chains.integrityPct !== null ? ` · integrity ${f.chains.integrityPct}% scored / ${pct(f.chains.ladderIntegrityPct)}% ladder` : ''}${f.chains.degradedNodes ? ` · ${plural(f.chains.degradedNodes, 'degraded node')}` : ''}` }));
  }
  if (f.chains.journeys) {
    tiles.push(tile({ label: 'chains getting worse', value: f.chains.worse.length, acc: f.chains.worse.length ? 'is-red' : 'is-gray', warn: !!f.chains.worse.length, note: f.chains.worse.length ? `moved down since the run before: ${escapeHtml(few(f.chains.worse))}` : 'no chain moved down on the latest runs' }));
  }
  if (f.topExposure) {
    tiles.push(tile({ label: 'widest blind-spot exposure', value: f.topExposure.slos, unit: `SLO${f.topExposure.slos === 1 ? '' : 's'} would go blind`, acc: f.topExposure.slos > 0 ? 'is-amber' : 'is-gray',
      note: `${escapeHtml(f.topExposure.label)} (${escapeHtml(f.topExposure.kind)}) · ${escapeHtml(f.topExposure.journey)}${f.topExposure.alerts ? ` · ${f.topExposure.alerts} alerts` : ''} — structural exposure, not a claim they are blind` }));
  }
  const sampled = (data.journeys || []).filter((j) => j.lastRun?.stack).length;
  if (sampled) {
    tiles.push(tile({ label: 'monitoring-stack early warnings', value: f.stackSignal.length, unit: f.stackSignal.length === 1 ? 'journey' : 'journeys', acc: f.stackSignal.length ? 'is-amber' : 'is-gray',
      note: f.stackSignal.length ? `a lower-is-comfortable self-metric read nonzero on the latest run: ${escapeHtml(few(f.stackSignal))} — signal, not verdict` : `no nonzero lower-is-comfortable sample on the latest runs of ${plural(sampled, 'journey')}` }));
  }
  if (f.inventory?.journeys) tiles.push(inventoryTile(f.inventory));
  return tiles.length ? `<div class="mc-tiles nrn-tiles">${tiles.join('')}</div>` : '';
}

// Inventory coverage across the fleet (neuron-model.mjs fleetInventory): the largest
// enumerated kind headlines as up / inventoried, the other kinds and the counted totals follow,
// and the journeys whose last run could not check are named.
function inventoryTile(inv) {
  const kinds = Object.entries(inv.kinds).sort((a, b) => b[1].expected - a[1].expected);
  const [k, t] = kinds[0] || [null, null];
  const rest = kinds.slice(1).map(([kk, tt]) => `${tt.up}/${tt.expected} ${escapeHtml(kk)}`);
  const counted = Object.entries(inv.counted).map(([, tt]) => `${tt.total} ${escapeHtml(tt.title)}${tt.total === 1 ? '' : 's'}${tt.below ? ` (${tt.below} below floor)` : ''}`);
  const holes = t ? [t.down ? `${t.down} down` : null, t.silent ? `${t.silent} silent` : null, t.unexpected ? `${t.unexpected} unexpected` : null].filter(Boolean) : [];
  const unchecked = inv.unchecked.length ? `<span class="journey-load-error">${inv.unchecked.length} unchecked: ${escapeHtml(few(inv.unchecked))}</span>` : '';
  const note = [...holes, ...rest, ...counted, unchecked].filter(Boolean).join(' · ') || `${plural(inv.journeys, 'journey')} checked`;
  return tile({ label: 'inventory coverage', value: t ? `${t.up}/${t.expected}` : '—', unit: t ? `${escapeHtml(k)} up` : '', acc: !t ? 'is-gray' : (t.silent || t.down) ? 'is-amber' : 'is-green', warn: !!(t && (t.silent || t.down)), note });
}

function panel(title, note, body, extra = '') {
  return `<div class="nrn-panel">
    <div class="nrn-panel-head"><span class="nrn-panel-title">${title}</span>${note ? `<span class="nrn-panel-note">${note}</span>` : ''}</div>
    ${body}${extra}
  </div>`;
}

function renderFleet(model, ui, charts, ready, data) {
  const multi = model.fleet.journeys > 1;
  const tiles = renderTiles(model, data);
  const body = ready.ready
    ? renderFleetPanels(model, ui, charts, ready)
    : emptyStateHtml({
      title: `Trends appear after ${ready.minRuns} runs; ${ready.runs} so far.`,
      checked: `the newest ${model.window} runs of ${plural(model.fleet.journeys, 'journey')}`,
      body: 'One run is a reading, not a trend: alignment, grade, outcomes over time and blind-spot exposure are drawn once a journey has three. Each run adds a point, whether you run it here or its schedule does.',
      actions: [{ action: 'evidence:schedule', label: 'Set up a schedule' }],
    });
  return `
    <section class="nrn-fleet" id="nrn-trends" aria-labelledby="nrn-trends-title">
      <h3 class="nrn-section-title" id="nrn-trends-title">${multi ? 'Across all journeys' : 'Measures and trends'}</h3>
      ${tiles}
      ${body}
    </section>`;
}

function renderFleetPanels(model, ui, charts, ready) {
  const metricTitle = ui.metric === 'grade' ? 'Grade score' : 'Alignment';
  let trendPanel;
  if (ready.observedReady) {
    const series = model.series[ui.metric].map((s, i) => ({ ...s, color: charts.seriesColor(i) }));
    const ordered = [...series.filter((s) => s.name !== ui.focus), ...series.filter((s) => s.name === ui.focus)];
    const trend = charts.lineChart({ series: ordered, yMin: 0, yMax: 100, yTicks: [0, 25, 50, 75, 100], yFormat: (v) => `${v}%`, ariaLabel: `${ui.metric} per journey over the last ${model.window} runs`, markers: true, h: 220 });
    const legend = series.map((s) => `<button type="button" class="nrn-legend-item${s.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(s.name)}"><span class="nrn-legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</button>`).join('');
    trendPanel = panel(`${metricTitle} over time`, `per journey · gaps = unable to observe · ${trend.xMode === 'time' ? 'time axis' : 'run order'}`, trend.svg, `<div class="nrn-legend">${legend}</div>`);
  } else {
    trendPanel = panel(`${metricTitle} over time`, '', emptyStateHtml({
      title: `The ${metricTitle.toLowerCase()} line appears after ${ready.minRuns} runs that could observe; the longest history has ${ready.observed}.`,
      body: 'A run that lost its vantage point is a gap in the line, never a zero.',
    }));
  }
  const heat = renderHeatmap(model, ui);
  const breach = model.breachFrequency.length
    ? panel('Breached criteria', 'count over every run in the window', charts.barChartH({ items: model.breachFrequency.map((b) => ({ label: b.key, value: b.count })), ariaLabel: 'breached criteria', color: 'var(--fail-border, #DC2626)' }).svg)
    : '';
  const causes = model.causeKinds.length
    ? panel('Candidate cause kinds', 'ranked by evidence — not root-cause verdicts', charts.barChartH({ items: model.causeKinds.map((c) => ({ label: c.key, value: c.count })), ariaLabel: 'candidate cause kinds', color: MUTED }).svg)
    : '';
  const quiet = !breach && !causes ? `<p class="nrn-muted">No breached criteria and no candidate causes in the last ${model.window} runs of any journey.</p>` : '';
  return `<div class="nrn-grid nrn-grid-fleet">
    ${trendPanel}
    ${panel('Outcomes, newest right', `last ${model.heatmap.columns || 0} runs per journey`, heat)}
    ${breach}
    ${causes}
    ${renderFleetBlast(model, ui, charts, ready)}
  </div>${quiet}`;
}

// Blast radius at fleet level: exposure over time (the SLOs the widest
// degraded artefact would blind, per journey) and the widest exposures
// across the newest records, ranked. Each panel only when it has data.
function renderFleetBlast(model, ui, charts, ready) {
  const series = model.series.exposure.map((s, i) => ({ ...s, color: charts.seriesColor(i) }));
  const maxV = Math.max(0, ...series.flatMap((s) => s.points.map((p) => p.v ?? 0)));
  const { yMax, yTicks } = countTicks(maxV);
  const longest = Math.max(0, ...series.map((s) => s.points.length));
  const over = longest >= ready.minRuns
    ? panel('Blind-spot exposure over time', 'SLOs the widest degraded artefact would blind · structural, not a claim they are blind',
      charts.lineChart({ series: [...series.filter((s) => s.name !== ui.focus), ...series.filter((s) => s.name === ui.focus)], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `SLOs the widest degraded artefact would blind, per journey over the last ${model.window} runs`, h: 180 }).svg
        + `<div class="nrn-legend">${series.map((s) => `<button type="button" class="nrn-legend-item${s.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(s.name)}"><span class="nrn-legend-swatch" style="background:${s.color}"></span>${escapeHtml(s.name)}</button>`).join('')}</div>`)
    : '';
  const ex = model.fleet.exposures;
  const widest = ex.length
    ? panel('Widest exposures, newest records', `degraded nodes of declared chains · what goes blind if the node dies${ex.length >= 12 ? ' · top 12' : ''}`,
      charts.stackedBarH({ items: ex.map((n) => blastItem(n, `${n.label} [${n.kind}] · ${n.journey}`)), keys: BLAST_KEYS, colors: BLAST_COLORS, ariaLabel: 'widest exposures across the fleet, newest records' }).svg + blastLegend())
    : '';
  return `${over}${widest}`;
}

// Blast radius of the journey in focus: every degraded node of the newest
// record's declared chains as a stacked bar (current state — drawn from the
// first run), and exposure per run (a trend — drawn from TREND_MIN_RUNS).
function renderBlast(d, charts, trend) {
  const blast = d.blast || [];
  const exp = d.exposure || [];
  const hasChains = !!d.latest?.chains;
  const top = blast.slice(0, MAX_BLAST_ROWS);
  const bars = blast.length
    ? charts.stackedBarH({ items: top.map((n) => blastItem(n, `${n.label} [${n.kind}]`)), keys: BLAST_KEYS, colors: BLAST_COLORS, ariaLabel: `${d.name}: blast radius of the degraded nodes, newest record` }).svg
      + blastLegend()
      + (blast.length > MAX_BLAST_ROWS ? `<p class="nrn-muted">${blast.length - MAX_BLAST_ROWS} more degraded node${blast.length - MAX_BLAST_ROWS === 1 ? '' : 's'} with a narrower radius — the requirement-chains table lists them all.</p>` : '')
    : '';
  const maxV = Math.max(0, ...exp.map((e) => Math.max(e.slos, e.alerts)));
  const { yMax, yTicks } = countTicks(maxV);
  const title = (e) => `${e.slos} SLO${e.slos === 1 ? '' : 's'} · ${e.alerts} alert${e.alerts === 1 ? '' : 's'} · ${e.degradedNodes} degraded node${e.degradedNodes === 1 ? '' : 's'}${e.label ? ` · widest: ${e.label}` : ''}${e.t ? ` · ${new Date(e.t).toLocaleString()}` : ''}`;
  const perRun = exp.length >= trend.minRuns
    ? charts.lineChart({ series: [
      { name: 'SLOs blinded by the widest node', points: exp.map((e) => ({ t: e.t, v: e.slos, title: title(e) })), color: ACCENT },
      { name: 'alerts blinded by the widest node', points: exp.map((e) => ({ t: e.t, v: e.alerts, title: title(e) })), color: MUTED },
    ], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `${d.name}: exposure per run`, h: 160 }).svg
      + `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>SLOs blinded by the widest degraded node</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>alerts blinded by it</span></div>`
      + `<p class="nrn-muted">latest: ${escapeHtml(title(exp[exp.length - 1]))}</p>`
    : '';
  if (!bars && !perRun) {
    return hasChains
      ? '<p class="nrn-muted">Blast radius: no degraded node in the newest record\'s declared chains — nothing would go blind that is not already declared missing.</p>'
      : '';
  }
  return `<h4 class="nrn-sub-title">Blast radius <span class="nrn-muted">— what would go blind if a degraded artefact died: structural exposure on the requirement graph, never a claim that it is blind</span></h4>
    <div class="nrn-grid nrn-grid-blast">
      ${bars ? panel('Degraded nodes by radius, newest record', `${blast.length} degraded node${blast.length === 1 ? '' : 's'} in declared chains · one bar per node, SLOs · alerts · other consumers`, bars) : ''}
      ${perRun ? panel('Exposure per run', 'the widest degraded node\'s radius, run by run', perRun) : ''}
    </div>`;
}

function renderHeatmap(model, ui) {
  if (!model.heatmap.rows.length) return '<p class="nrn-muted">no journeys</p>';
  const rows = model.heatmap.rows.map((r) => `
    <button type="button" class="nrn-heat-name${r.name === ui.focus ? ' is-focus' : ''}" data-focus="${escapeHtml(r.name)}" title="focus ${escapeHtml(r.name)}">${escapeHtml(r.name)}</button>
    <div class="nrn-heat-row" role="img" aria-label="${escapeHtml(r.name)}: ${escapeHtml(r.cells.filter(Boolean).map((c) => checkOutcome(c.outcome).label.toLowerCase()).join(', ') || 'never run')}">
      ${r.cells.map((c) => (c
    ? `<span class="nrn-cell is-${escapeHtml(c.outcome)}" title="${escapeHtml(`${checkOutcome(c.outcome).label}${c.alignment !== null ? ` · alignment ${c.alignment}%` : ''}${c.grade !== null ? ` · grade ${c.grade}%` : ''}${c.breaches ? ` · ${c.breaches} breach${c.breaches === 1 ? '' : 'es'}` : ''}${c.t ? ` · ${new Date(c.t).toLocaleString()}` : ''}`)}"></span>`
    : '<span class="nrn-cell is-none"></span>')).join('')}
      ${r.cells.length ? '' : '<span class="nrn-muted">never run</span>'}
    </div>`).join('');
  return `<div class="nrn-heat">${rows}</div>
    <div class="nrn-heat-legend"><span class="nrn-cell is-pass"></span> passed <span class="nrn-cell is-gate-failed"></span> check failed <span class="nrn-cell is-vantage-lost"></span> unable to observe (vantage lost) <span class="nrn-cell is-none"></span> no run</div>`;
}

// ---------- the journey in focus ----------

const fmtCadence = (ms) => {
  if (!ms) return null;
  const m = ms / 60e3;
  if (m < 60) return `every ${m % 1 ? m.toFixed(1) : m} min`;
  const h = m / 60;
  if (h < 48) return `every ${h % 1 ? h.toFixed(1) : h} h`;
  return `every ${(h / 24) % 1 ? (h / 24).toFixed(1) : h / 24} d`;
};
const gateBits = (gate) => Object.entries(gate || {}).map(([k, v]) => `${k}=${v && typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ') || 'no gate';
const scheduleText = (s) => (!s ? 'no schedule: declared (run on demand)' : `${s.cron ? `cron ${s.cron}` : s.every ? `every ${s.every}` : 'schedule'}${s.timezone ? ` (${s.timezone})` : ''}${s.cadenceMs ? ` · ${fmtCadence(s.cadenceMs)}` : s.cadenceNote ? ` · ${s.cadenceNote}` : ''}`);
const val = (v) => (v === null || v === undefined ? '—' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const kv = (pairs) => `<dl class="nrn-kv">${pairs.filter(([, v]) => v !== undefined).map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${typeof v === 'string' && v.startsWith('<') ? v : escapeHtml(val(v))}</dd>`).join('')}</dl>`;
const tbl = (headers, rows) => (rows.length
  ? `<table class="nrn-table"><thead><tr>${headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`
  : '<p class="nrn-muted">none</p>');
// `key` marks the block "Investigate cause" and the cause links open.
const details = (title, body, { open = false, lazy = null, journey = null, key = null } = {}) => `<details class="nrn-details"${open ? ' open' : ''}${key ? ` data-nrn-evidence="${escapeHtml(key)}"` : ''}${lazy ? ` data-lazy="${escapeHtml(lazy)}" data-journey="${escapeHtml(journey || '')}"` : ''}><summary>${title}</summary><div class="nrn-details-body">${body}</div></details>`;

function renderFocus(d, charts, stackLib, schedLib, trend, fleetReady) {
  if (!d) return '';
  const last = d.latest;
  const counts = outcomeCounts(d.outcomes);
  const head = `
    <div class="nrn-focus-head">
      <span class="journey-name">${escapeHtml(d.name)}</span>
      ${outcomeChipHtml(last ? last.outcome : 'never-run')}
      ${last ? `<span class="journey-outcome">${last.drift ? `alignment ${last.drift.alignmentPct}% · grade ${last.grade?.score ?? '?'}%${last.grade?.letter ? ` (${escapeHtml(last.grade.letter)})` : ''} · ` : ''}${escapeHtml(agoText(Date.now() - Date.parse(last.startedAt || '')))}</span>` : ''}
      <button type="button" class="ctrl-btn nrn-run-focus" data-journey="${escapeHtml(d.name)}">▶ run now</button>
    </div>
    <div class="journey-card-meta">
      <span title="Pack A source">A: <code>${escapeHtml(d.packA || '?')}</code></span>
      <span title="Pack B source">B: <code>${escapeHtml(d.packB || '?')}</code></span>
      ${d.scope?.env || d.scope?.service ? `<span>scope: ${escapeHtml([d.scope.env && `env ${d.scope.env}`, d.scope.service && `service ${d.scope.service}`, d.scope.scopeMode && `mode ${d.scope.scopeMode}`].filter(Boolean).join(' · '))}</span>` : ''}
      <span title="Gate">gate: ${escapeHtml(gateBits(d.gate))}</span>
      <span title="schedule:">${escapeHtml(scheduleText(d.schedule))}</span>
      ${d.notify ? `<span title="notify: env var NAMES only">notify: ${escapeHtml(d.notify.on || 'transitions')} → $${escapeHtml(d.notify.urlEnv)}${d.notify.authEnv ? ` (bearer $${escapeHtml(d.notify.authEnv)})` : ''} · ${escapeHtml(d.notify.format || 'json')}</span>` : ''}
      <span>${escapeHtml(plural(d.runs, 'run'))} in the window${counts ? `: ${escapeHtml(counts)}` : ''}</span>
      ${d.loadError ? `<span class="journey-load-error">definition does not load: ${escapeHtml(d.loadError)}</span>` : ''}
    </div>`;

  if (!d.runs) {
    return `<section class="nrn-focus-section" id="nrn-focus" aria-labelledby="nrn-focus-title"><h3 class="nrn-section-title" id="nrn-focus-title">In focus</h3><div class="nrn-focus">${head}<p class="nrn-muted">No run yet, so there is nothing to chart or open.</p>${renderLatestDetails(d)}</div></section>`;
  }

  // Per-run charts wait for a trend: alignment + grade, ladder buckets,
  // chain integrity, duration.
  let chartsHtml;
  if (trend.ready) {
    const ag = trend.observedReady
      ? panel('Alignment and grade', 'per run · gaps = unable to observe', charts.lineChart({ series: [{ name: 'alignment', points: d.alignment, color: ACCENT }, { name: 'grade', points: d.grade, color: MUTED }], yMin: 0, yMax: 100, yTicks: [0, 25, 50, 75, 100], yFormat: (v) => `${v}%`, ariaLabel: `${d.name}: alignment and grade per run`, h: 170 }).svg,
        `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>alignment</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>grade</span></div>`)
      : panel('Alignment and grade', '', emptyStateHtml({ title: `This line appears after ${trend.minRuns} runs that could observe; ${trend.observed} of ${trend.runs} could.`, body: 'A run that lost its vantage point is a gap, never a zero.' }));
    const ladderBars = d.ladder.map((l) => ({ t: l.t, values: LADDER_KEYS.map((k) => l[k]), title: `${LADDER_KEYS.map((k) => `${l[k]} ${k}`).join(' · ')} · ${l.intact}/${l.declaredTotal} intact${l.t ? ` · ${new Date(l.t).toLocaleString()}` : ''}` }));
    const ladder = d.ladder.length
      ? charts.stackedBarChart({ bars: ladderBars, keys: LADDER_KEYS, colors: LADDER_COLORS, ariaLabel: `${d.name}: ladder buckets per run`, h: 170 }).svg
        + `<div class="nrn-legend">${LADDER_KEYS.map((k, i) => `<span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${LADDER_COLORS[i]}"></span>${k}</span>`).join('')}</div>`
      : '<p class="nrn-muted">no run in the window carries requirement chains (file-sourced B, or records written before step 4)</p>';
    const integrity = d.ladder.length
      ? charts.lineChart({ series: [{ name: 'scored integrity', points: d.ladder.map((l) => ({ t: l.t, v: l.integrityPct })), color: ACCENT }, { name: 'ladder integrity', points: d.ladder.map((l) => ({ t: l.t, v: l.ladderIntegrityPct })), color: MUTED }], yMin: 0, yMax: 100, yTicks: [0, 50, 100], yFormat: (v) => `${v}%`, ariaLabel: `${d.name}: chain integrity per run`, h: 150 }).svg
        + `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>scored (what the grade counts)</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>ladder (on-wire liveness, unscored)</span></div>`
      : '';
    const dur = charts.lineChart({ series: [{ name: 'took', points: d.durations, color: MUTED }], yMin: 0, yFormat: (v) => (v >= 1000 ? `${Number((v / 1000).toFixed(1))}s` : `${v}ms`), ariaLabel: `${d.name}: run duration`, h: 130 });
    chartsHtml = `<div class="nrn-grid nrn-grid-focus">
        ${ag}
        ${panel('Requirement-chain ladder', 'declared chains per run · counts, not colours-as-verdicts', ladder)}
        ${integrity ? panel('Chain integrity', 'mean per run', integrity) : ''}
        ${panel('Run duration', 'wall clock per run', dur.svg)}
      </div>`;
  } else if (fleetReady.ready) {
    chartsHtml = emptyStateHtml({
      title: `Trends for ${d.name} appear after ${trend.minRuns} runs; ${trend.runs} so far.`,
      checked: `${plural(trend.runs, 'run')} of ${d.name} in the window${trend.observed < trend.runs ? `, ${trend.observed} of them could observe` : ''}`,
      body: 'Alignment and grade, the chain ladder, chain integrity and run duration are drawn per run once there are three. The newest record below has the full evidence of the latest run.',
    });
  } else {
    chartsHtml = `<p class="nrn-muted">Per-run charts for ${escapeHtml(d.name)} appear after ${trend.minRuns} runs; ${trend.runs} so far. The newest record below has the full evidence.</p>`;
  }

  // Stack self-metric rows as small multiples, one ink colour — a series,
  // so it waits for a trend too; the newest samples stay in the table below.
  let stackHtml;
  if (!d.stackRows.length) {
    stackHtml = `<p class="nrn-muted">No stack self-metric samples in the window${last?.stackEvidence?.status === 'not-attempted' ? ` — last run: not attempted (${escapeHtml(last.stackEvidence.reason || 'no reason recorded')})` : ' (file-sourced Pack B, or a tier that exposes no metrics_query)'}.</p>`;
  } else if (!trend.ready) {
    stackHtml = `<p class="nrn-muted">Stack self-metric charts appear after ${trend.minRuns} runs; the newest samples (${plural(d.stackRows.length, 'row')}) are under Stack evidence below.</p>`;
  } else {
    const cadenceMs = d.schedule?.cadenceMs || null;
    const budgetWindowMs = schedLib && d.stackBudget?.window ? schedLib.windowMs(d.stackBudget.window) : null;
    const gatedRows = d.gate?.stack?.rows && typeof d.gate.stack.rows === 'object' ? Object.keys(d.gate.stack.rows) : [];
    const stackPanels = d.stackRows.slice(0, MAX_STACK_PANELS).map((row) => {
      const sc = charts.stepChart({ points: row.series, unit: row.unit || '', ariaLabel: `${row.id} per run`, valueFormat: stackLib ? (v) => stackLib.formatStackValue(v, row.unit) : null });
      const latestTxt = row.latest ? (row.latest.value === null ? `last: ${stackLib ? stackLib.stackOutcomeLabel(row.latest.outcome) : row.latest.outcome}` : `last: ${stackLib ? stackLib.formatStackValue(row.latest.value, row.unit) : row.latest.value}${row.latest.hint === 'nonzero' ? ' · nonzero' : ''}`) : '';
      let posture = '';
      if (gatedRows.includes(row.id) && d.stackBudget && cadenceMs && budgetWindowMs && stackLib?.stackPostureBudget) {
        const b = stackLib.stackPostureBudget(row.series, { objective: d.stackBudget.objective, cadenceMs, windowMs: budgetWindowMs });
        posture = `<p class="nrn-muted">posture: ${escapeHtml(b.note)}</p>`;
      } else if (gatedRows.includes(row.id) && d.stackBudget && d.schedule && !cadenceMs && d.schedule.cadenceNote) {
        posture = `<p class="nrn-muted">posture: ${escapeHtml(d.schedule.cadenceNote)}</p>`;
      }
      const gateBand = gatedRows.includes(row.id) ? ` · gate ${escapeHtml(JSON.stringify(d.gate.stack.rows[row.id]))}` : '';
      return panel(`<code>${escapeHtml(row.id)}</code>`, `${escapeHtml([row.family, row.product, row.direction && `${row.direction} is ${row.direction === 'lower' ? 'comfortable' : row.direction === 'higher' ? 'good' : 'info'}`].filter(Boolean).join(' · '))}${gateBand}`,
        sc.svg, `<p class="nrn-muted">${escapeHtml(latestTxt)} · ${row.samples} sample${row.samples === 1 ? '' : 's'}${row.direction === 'lower' ? ` · nonzero in ${row.nonzero} of ${row.samples}` : ''} — point-in-time samples, signal not verdict</p>${posture}`);
    }).join('');
    const stackNote = d.stackRows.length > MAX_STACK_PANELS ? `<p class="nrn-muted">${d.stackRows.length - MAX_STACK_PANELS} more row${d.stackRows.length - MAX_STACK_PANELS === 1 ? '' : 's'} not drawn — the stack evidence table below lists them all.</p>` : '';
    stackHtml = `<h4 class="nrn-sub-title">Stack self-metrics per run <span class="nrn-muted">— what the monitoring stack said about itself when the journey looked</span></h4><div class="nrn-grid nrn-grid-stack">${stackPanels}</div>${stackNote}`;
  }

  return `<section class="nrn-focus-section" id="nrn-focus" aria-labelledby="nrn-focus-title">
    <h3 class="nrn-section-title" id="nrn-focus-title">In focus</h3>
    <div class="nrn-focus">
      ${head}
      ${chartsHtml}
      ${renderBlast(d, charts, trend)}
      ${renderInventory(d, charts, trend)}
      ${stackHtml}
      ${renderLatestDetails(d)}
    </div>
  </section>`;
}

// Inventory coverage of the journey in focus: per enumerated kind a line of inventoried vs up
// per run (points only where the record checked that kind; drawn from TREND_MIN_RUNS points),
// then the newest record's table — up, down (targeted but every target down), silent (no up
// series at all), unexpected (answering but not inventoried), and the counted kinds' totals
// against their floors.
function renderInventory(d, charts, trend) {
  const inv = d.inventory;
  if (!inv || (!inv.latest && !Object.keys(inv.series || {}).length)) return '';
  const latest = inv.latest;
  const panels = Object.entries(inv.series || {}).filter(([, s]) => s.length >= trend.minRuns).map(([k, s]) => {
    const spec = latest?.kinds?.[k];
    const maxV = Math.max(1, ...s.map((p) => Math.max(p.expected, p.up + p.unexpected)));
    const { yMax, yTicks } = countTicks(maxV);
    const title = (p) => `${p.up}/${p.expected} up · ${p.down} down · ${p.silent} silent · ${p.unexpected} unexpected${p.t ? ` · ${new Date(p.t).toLocaleString()}` : ''}`;
    const chart = charts.lineChart({ series: [
      { name: 'inventoried', points: s.map((p) => ({ t: p.t, v: p.expected, title: title(p) })), color: MUTED },
      { name: 'up', points: s.map((p) => ({ t: p.t, v: p.up, title: title(p) })), color: ACCENT },
    ], yMin: 0, yMax, yTicks, yFormat: (v) => String(v), ariaLabel: `${d.name}: ${k} inventoried vs up per run`, h: 150 });
    const last = s[s.length - 1];
    return panel(`<code>${escapeHtml(k)}</code> ${escapeHtml(spec?.title || '')}`, `${last.up}/${last.expected} up · ${last.down} down · ${last.silent} silent · ${last.unexpected} unexpected${last.coveragePct !== null ? ` · ${last.coveragePct}%` : ''}`, chart.svg,
      `<div class="nrn-legend"><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${MUTED}"></span>inventoried</span><span class="nrn-legend-item is-static"><span class="nrn-legend-swatch" style="background:${ACCENT}"></span>up</span></div>`);
  }).join('');
  if (!panels && !latest) return '';
  return `<h4 class="nrn-sub-title">Inventory coverage <span class="nrn-muted">— the site's expected sets against the live up series: is the right number of things being monitored?</span></h4>
    ${panels ? `<div class="nrn-grid nrn-grid-inventory">${panels}</div>` : ''}
    ${latest ? inventoryTable(latest) : ''}`;
}

function inventoryTable(inv) {
  const head = `<p class="nrn-muted">newest record: <strong>${escapeHtml(inv.status)}</strong>${inv.reason ? ` — ${escapeHtml(inv.reason)}` : ''}${inv.site ? ` · ${escapeHtml(inv.site)}` : ''}${inv.environment ? ` · ${escapeHtml(inv.environment)}` : ''}</p>`;
  const rows = Object.entries(inv.kinds || {}).map(([k, c]) => (c.mode === 'counted'
    ? [
      `<code>${escapeHtml(k)}</code> ${escapeHtml(c.title || '')} <span class="nrn-muted">per ${escapeHtml(c.per || '?')}</span>`,
      `${Object.keys(c.min || {}).length} floor${Object.keys(c.min || {}).length === 1 ? '' : 's'}`,
      c.total === null || c.total === undefined ? '—' : `total ${c.total}`,
      '—', '—',
      (c.below || []).length ? `<em>${escapeHtml(c.below.map((b) => `${b.parent}: ${b.count} < ${b.min}`).join(', '))}</em>` : ((c.missing || []).length ? `<em>no count for ${escapeHtml(c.missing.join(', '))}</em>` : '—'),
      escapeHtml(c.status),
    ]
    : [
      `<code>${escapeHtml(k)}</code> ${escapeHtml(c.title || '')}`,
      String(c.expected ?? '—'),
      c.up === null || c.up === undefined ? '—' : String(c.up),
      (c.down || []).length ? escapeHtml(c.down.join(', ')) : '—',
      (c.silent || []).length ? `<em>${escapeHtml(c.silent.join(', '))}</em>` : '—',
      (c.unexpected || []).length ? escapeHtml(c.unexpected.join(', ')) : '—',
      `${escapeHtml(c.status)}${c.coveragePct !== null && c.coveragePct !== undefined ? ` · ${c.coveragePct}%` : ''}`,
    ]));
  return head + tbl(['kind', 'inventoried', 'up', 'down', 'silent', 'unexpected / below floor', 'status'], rows);
}

// The schedule block: where "Set up a schedule" lands. Lazy — the snippets
// load when it opens.
function scheduleDetails(d) {
  return details(`Schedule <span class="nrn-muted">${escapeHtml(scheduleText(d.schedule))}${d.stackBudget ? ` · posture budget ${d.stackBudget.objective} over ${escapeHtml(String(d.stackBudget.window))}` : ''}</span>`,
    `<p class="nrn-muted">Scheduling is delegated, not built: nothing fires from the studio. The snippets below install the same <code>packc journey run ${escapeHtml(d.name)}</code> under cron, Windows Task Scheduler, GitHub Actions or a Kubernetes CronJob${d.schedule ? '' : ' — with the placeholder cadence, since this journey declares no <code>schedule:</code>'}.</p><div class="nrn-snippets" data-state="idle"><p class="nrn-muted">opening…</p></div>`,
    { lazy: 'schedule', journey: d.name, key: 'schedule' });
}

function renderLatestDetails(d) {
  const last = d.latest;
  if (!last) return `<h4 class="nrn-sub-title" id="nrn-evidence" tabindex="-1">Set it running</h4>${scheduleDetails(d)}`;
  const when = last.startedAt ? new Date(last.startedAt).toLocaleString() : '?';
  const parts = [];

  if (last.outcome === 'vantage-lost') {
    parts.push(details(`Unable to observe <span class="nrn-muted">the vantage was lost</span>`, `<p class="nrn-muted">The live source did not answer — no verdict, the loss is a point in the history. Nothing about the artefacts was read on this run.</p><pre class="nrn-pre">${escapeHtml(last.error || 'unreachable')}</pre>`, { open: true, key: 'vantage' }));
  }

  // Requirement chains of the newest record.
  const branches = last.branches || [];
  if (branches.length) {
    const rows = branches.map((b) => [
      `<strong>${escapeHtml(b.title || b.rootKey || '?')}</strong><br><span class="nrn-muted">${escapeHtml(b.rootKind || '')}</span>`,
      escapeHtml(b.verdict || '?'),
      escapeHtml(b.ladderVerdict || '?'),
      `${val(b.integrityPct)}% / ${val(b.ladderIntegrityPct)}%`,
      escapeHtml(b.confidence || ''),
      (Array.isArray(b.missingRoles) && b.missingRoles.length) ? escapeHtml(b.missingRoles.join(', ')) : '—',
      (Array.isArray(b.degraded) && b.degraded.length)
        ? `<ul class="nrn-list">${b.degraded.map((n) => `<li>${escapeHtml(n.label || n.key || '?')} <span class="nrn-muted">[${escapeHtml(n.kind || '?')}] ${escapeHtml(n.status || '')}${n.ladder?.status ? ` · ${escapeHtml(n.ladder.status)}${n.ladder.detail ? ` — ${escapeHtml(n.ladder.detail)}` : ''}` : ''}${n.blastRadius && (n.blastRadius.slos || n.blastRadius.alerts) ? ` · blinds ${n.blastRadius.slos || 0} SLO${n.blastRadius.slos === 1 ? '' : 's'}${n.blastRadius.alerts ? `, ${n.blastRadius.alerts} alert${n.blastRadius.alerts === 1 ? '' : 's'}` : ''}` : ''}</span></li>`).join('')}${b.truncated ? '<li class="nrn-muted">list cut at the record cap</li>' : ''}</ul>`
        : '—',
    ]);
    const c = last.chains || {};
    parts.push(details(`Requirement chains <span class="nrn-muted">${c.intact ?? 0}/${c.declaredTotal ?? 0} intact · ladder ${c.ladder?.healthy ?? 0} healthy · ${c.ladder?.degraded ?? 0} degraded · ${c.ladder?.broken ?? 0} broken · ${c.ladder?.unobserved ?? 0} unobserved${c.undeclaredNodes ? ` · ${c.undeclaredNodes} live-only in undeclared chains` : ''}</span>`,
      tbl(['chain', 'verdict', 'ladder', 'integrity scored / ladder', 'confidence', 'missing roles', 'degraded nodes'], rows), { open: true, key: 'chains' }));
  }

  // Candidate causes + the vantage, beside not among them.
  if (last.causes) {
    const cs = last.causes.causes || [];
    const rows = cs.map((c) => [escapeHtml(String(c.rank ?? '')), escapeHtml(c.kind || ''), escapeHtml(String(c.score ?? '')), escapeHtml(c.evidence || ''), escapeHtml((c.chains || []).join(', ')), escapeHtml((c.nodes || []).join(', '))]);
    const v = last.causes.vantage;
    parts.push(details(`Candidate causes <span class="nrn-muted">${cs.length ? `${cs.length} ranked — ${escapeHtml(last.causes.note || 'ranked by evidence, not a root-cause verdict')}` : 'none ranked'}${v?.changed ? ' · <em>vantage changed</em>' : ''}</span>`,
      `${tbl(['#', 'kind', 'score', 'evidence', 'chains', 'nodes'], rows)}${v ? `<p class="nrn-muted">vantage: ${v.changed ? `changed — ${escapeHtml(v.detail || `${val(v.from)} → ${val(v.to)}`)}` : 'unchanged since the run before'} (reported beside the causes, never as one)</p>` : ''}`, { open: cs.length > 0, key: 'causes' }));
  }

  // Transition since the run before.
  if (last.transition) {
    const t = last.transition;
    const body = t.reason
      ? `<p class="nrn-muted">not compared: ${escapeHtml(t.reason)}${Array.isArray(t.skipped) && t.skipped.length ? ` · skipped ${t.skipped.length} record${t.skipped.length === 1 ? '' : 's'} in between` : ''}</p>`
      : `<p class="nrn-muted">since ${escapeHtml(t.since ? new Date(t.since).toLocaleString() : '?')} · ${t.changed?.length || 0} changed · ${t.appeared?.length || 0} appeared · ${t.disappeared?.length || 0} disappeared</p>${tbl(['chain', 'from', 'to', 'direction', 'newly degraded', 'recovered', 'note'], (t.changed || []).map((c) => [escapeHtml(c.title || c.rootKey || '?'), escapeHtml(`${c.from?.verdict}/${c.from?.ladderVerdict}`), escapeHtml(`${c.to?.verdict}/${c.to?.ladderVerdict}`), escapeHtml(c.direction || ''), escapeHtml((c.nodes?.newlyDegraded || []).join(', ') || '—'), escapeHtml((c.nodes?.recovered || []).join(', ') || '—'), escapeHtml(c.note || '')]))}`;
    parts.push(details(`Transition since the run before <span class="nrn-muted">${t.any ? `changed${t.changed?.some((c) => c.direction === 'worse') ? ' · <em>worse</em>' : ''}` : t.reason ? 'not compared' : 'no change'}</span>`, body, { open: !!t.any }));
  }

  // Gate.
  const breaches = last.breaches || [];
  parts.push(details(`Gate <span class="nrn-muted">${breaches.length ? `${breaches.length} breach${breaches.length === 1 ? '' : 'es'}` : last.outcome === 'vantage-lost' ? 'not evaluated — unable to observe' : 'no breach'}</span>`,
    `${tbl(['criterion', 'detail'], breaches.map((b) => [escapeHtml(b.criterion || '?'), escapeHtml(b.detail || val(b))]))}<p class="nrn-muted">thresholds: ${escapeHtml(gateBits(d.gate))}</p>`, { open: breaches.length > 0, key: 'gate' }));

  // Drift, grade, conformance, freshness.
  if (last.drift) {
    parts.push(details('Drift, grade, conformance, freshness', kv([
      ['alignment', `${last.drift.alignmentPct}% — ${last.drift.aligned ?? '?'} aligned · ${last.drift.drifted ?? '?'} drifted · ${last.drift.declaredNotLive ?? '?'} declared-not-live · ${last.drift.liveNotDeclared ?? '?'} live-not-declared${last.drift.outOfScope ? ` · ${last.drift.outOfScope} out of scope` : ''}${last.drift.scaffold ? ` · ${last.drift.scaffold} scaffold` : ''}`],
      ['grade', last.grade ? `${last.grade.score}% (${last.grade.pass ? 'PASS' : 'FAIL'} at ${last.grade.threshold ?? '?'}%)${last.grade.letter ? ` · ${last.grade.letter}${last.grade.letterLabel ? ` ${last.grade.letterLabel}` : ''}` : ''} · schema ${last.grade.schema ?? 1}${last.grade.driftConstruct ? ` · ${last.grade.driftConstruct}` : ''}` : '—'],
      ['traceability', last.traceability ? `${last.traceability.integrityPct}% integrity · ${last.traceability.intact} intact · ${last.traceability.partial} partial · ${last.traceability.broken} broken · ${last.traceability.undeclared} undeclared of ${last.traceability.declaredTotal} declared` : '—'],
      ['conformance', last.conformance ? `${last.conformance.scorePercent}% (MUST ${last.conformance.mustPercent}%) · ${last.conformance.conformant ? 'conformant' : 'not conformant'}${last.conformance.declaredTier ? ` · tier ${last.conformance.declaredTier}` : ''}` : '—'],
      ['live freshness', last.freshness ? `${last.freshness.liveAgeHours ?? '?'} h old${last.freshness.refreshedAt ? ` (refreshed ${new Date(last.freshness.refreshedAt).toLocaleString()})` : ''}` : '—'],
      ['took', last.tookMs !== null ? `${last.tookMs} ms` : '—'],
      ['pack A', last.packA ? `${last.packA.name || '?'} ${last.packA.version || ''} · ${last.packA.source || ''}` : '—'],
      ['pack B', last.packB ? `${last.packB.name || '?'} ${last.packB.version || ''} · ${last.packB.source || ''}` : '—'],
    ])));
  }

  // Stack evidence of the newest record.
  if (last.stackEvidence) {
    const se = last.stackEvidence;
    const rows = se.rows.map((r) => [
      `<code>${escapeHtml(r.id)}</code>`, escapeHtml(r.family || ''), escapeHtml(r.product || ''),
      r.outcome === 'data' && typeof r.value === 'number' ? escapeHtml(`${r.value}${r.unit ? ` ${r.unit}` : ''}`) : '—',
      escapeHtml(r.direction || ''), escapeHtml(r.outcome || ''), r.hint ? `<em>${escapeHtml(r.hint)}</em>` : '', escapeHtml(r.referenceSli || ''), escapeHtml(r.reason || ''),
    ]);
    const am = se.alertmanager, gf = se.grafana;
    parts.push(details(`Stack evidence <span class="nrn-muted">${escapeHtml(se.status || '?')}${se.reason ? ` — ${escapeHtml(se.reason)}` : ''} · ${se.rows.length} row${se.rows.length === 1 ? '' : 's'} · point-in-time, signal not verdict</span>`,
      `${tbl(['row', 'family', 'product', 'value', 'direction', 'outcome', 'hint', 'reference SLI', 'reason'], rows)}
       ${am || gf ? kv([
    ['alertmanager', am ? `${am.version || '?'} · cluster ${am.clusterStatus || '?'} · ${am.silencesActive ?? '?'} active silence${am.silencesActive === 1 ? '' : 's'}${am.error ? ` · error: ${am.error}` : ''}` : undefined],
    ['grafana', gf ? `${gf.datasources ?? '?'} datasources · ${Array.isArray(gf.unhealthyDatasources) ? (gf.unhealthyDatasources.length ? `unhealthy: ${gf.unhealthyDatasources.join(', ')}` : 'none unhealthy') : `${gf.unhealthyDatasources ?? '?'} unhealthy`} · ${gf.contactPoints ?? '?'} contact points${gf.error ? ` · error: ${gf.error}` : ''}` : undefined],
  ]) : ''}`));
  }

  // The vantage itself.
  const v = last.vantage || {};
  if (v.vantage || v.probes || v.toolsExposedCount !== null) {
    parts.push(details(`Vantage <span class="nrn-muted">${escapeHtml(val(v.vantage))}${v.toolsExposedCount !== null ? ` · ${v.toolsExposedCount} tools exposed` : ''}${v.scrapeJobsDown !== null ? ` · ${v.scrapeJobsDown} scrape jobs down` : ''}${v.unhealthyRules !== null ? ` · ${v.unhealthyRules} unhealthy rules` : ''}</span>`,
      kv([
        ['probes', v.probes ? Object.entries(v.probes).map(([k, x]) => `${k}: ${val(x)}`).join(' · ') : '—'],
        ['probe errors', v.probeErrors ? val(v.probeErrors) : '—'],
      ])));
  }

  // Versions.
  if (last.versions) {
    parts.push(details(`Backend versions <span class="nrn-muted">${Object.keys(last.versions).length} reported by Pack B</span>`, kv(Object.entries(last.versions))));
  }

  // Delivery.
  const n = last.notify;
  const nx = n ? (DELIVERY_OUTCOMES[n.status] || DELIVERY_OUTCOMES.unknown) : null;
  const nTitle = n === null ? DELIVERY_OUTCOMES['not-configured'].label : n === undefined ? 'unknown — the record was written before delivery' : `${nx.label}${n.httpStatus != null ? ` (HTTP ${n.httpStatus})` : ''}${n.reason ? ` · ${n.reason}` : ''}`;
  parts.push(details(`Notification <span class="nrn-muted">${escapeHtml(nTitle)}</span>`, n ? kv([
    ['status', n.status], ['http', n.httpStatus], ['reason', n.reason], ['policy', d.notify?.on || n.policy], ['format', d.notify?.format || n.format],
    ['triggers', Array.isArray(n.triggers) ? n.triggers.join(', ') : n.triggers], ['attempts', n.attempts], ['took', n.tookMs !== undefined ? `${n.tookMs} ms` : undefined], ['url env', n.urlEnv || d.notify?.urlEnv], ['auth env', n.authEnv || d.notify?.authEnv], ['error', n.error],
  ]) : `<p class="nrn-muted">${n === null ? 'Add <code>notify: { urlEnv: MY_WEBHOOK_URL }</code> to the journey file to post transitions to a webhook — the URL and token stay env var names.' : 'A crash between the record write and the delivery write leaves no notify key; the next run tells.'}</p>`, { open: n?.status === 'failed', key: 'delivery' }));

  // Schedule + snippets (lazy).
  parts.push(scheduleDetails(d));

  if (last.historyError) parts.push(`<p class="journey-load-error">history: ${escapeHtml(last.historyError)}</p>`);

  return `<h4 class="nrn-sub-title" id="nrn-evidence" tabindex="-1">Newest record, opened up <span class="nrn-muted">— ${escapeHtml(when)}</span></h4>${parts.join('')}`;
}

// ---------- events ----------

// Open and scroll to the evidence block behind a cause ("Investigate cause",
// the cause links, "Set up a schedule"). Opening a lazy block loads it.
function jumpTo(container, key) {
  const target = (key && container.querySelector(`[data-nrn-evidence="${key}"]`))
    || container.querySelector('#nrn-evidence')
    || container.querySelector('#nrn-latest');
  if (!target) return;
  if (target.tagName === 'DETAILS' && !target.open) target.open = true;
  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  (target.tagName === 'DETAILS' ? target.querySelector('summary') : target)?.focus?.({ preventScroll: true });
}

// Leave Neuron for the comparison the next journey is saved from.
function goCompare(host) {
  if (state.mode === 'home' || state.mode === 'build') state.mode = 'single';
  state.view = state.pack ? 'compare' : 'layers';
  host.renderTabs();
  host.renderMainView();
}

// Run journeys one after the other. Progress is observable: the button says
// which run is going, each step is announced through #ux-status, the result
// lands in the toast (a live region of its own) and the page re-reads.
async function runJourneys(names, { container, host, btn = null }) {
  if (!names.length) return;
  container.querySelectorAll('#nrn-run-now, #nrn-run-all, .nrn-run-focus').forEach((b) => { b.disabled = true; });
  btn?.setAttribute('aria-busy', 'true');
  const tally = { pass: 0, 'gate-failed': 0, 'vantage-lost': 0, error: 0 };
  for (const [i, name] of names.entries()) {
    if (btn) btn.textContent = names.length > 1 ? `Running ${i + 1} of ${names.length}…` : 'Running…';
    announce(names.length > 1 ? `Running ${i + 1} of ${names.length}: ${name}…` : `Running ${name}…`);
    try {
      const r = await api(`/api/journeys/${enc(name)}/run`, POST);
      const rec = r.record || {};
      tally[rec.outcome] = (tally[rec.outcome] || 0) + 1;
      if (names.length === 1) toast(runResultText(name, rec), rec.outcome === 'pass' && rec.notify?.status !== 'failed' ? '' : 'error');
    } catch (err) {
      tally.error += 1;
      if (names.length === 1) toast(runErrorText(name, err), 'error');
    }
  }
  if (names.length > 1) {
    const summary = listSentence([
      tally.pass && `${tally.pass} passed`,
      tally['gate-failed'] && `${tally['gate-failed']} failed`,
      tally['vantage-lost'] && `${tally['vantage-lost']} unable to observe`,
      tally.error && `${tally.error} did not finish`,
    ]);
    toast(`Ran ${plural(names.length, 'journey')}: ${summary}.`, tally.pass === names.length ? '' : 'error');
  }
  await refreshNeuron(container, host);
}

function wire(container, { data, ui }, host, { investigate = null } = {}) {
  const rerender = (patch = {}) => renderNeuron(container, { data, ui: { ...ui, ...patch } }, host);
  const focusOn = (name) => { state.neuronJourney = name; rerender({ focus: name }); };

  const handlers = {
    'run-now': (ev, el) => { if (ui.focus) runJourneys([ui.focus], { container, host, btn: el }); },
    investigate: () => jumpTo(container, investigate),
    refresh: () => refreshNeuron(container, host, { announceDone: true }),
    'create-journey': () => {
      const input = container.querySelector('#journey-capture-name');
      input?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      input?.focus({ preventScroll: true });
    },
    'go-compare': () => goCompare(host),
  };
  for (const k of EVIDENCE_KEYS) handlers[`evidence:${k}`] = () => jumpTo(container, k);
  for (const name of Object.keys(data.model.perJourney)) handlers[`focus:${name}`] = () => focusOn(name);
  wireUxActions(container, handlers);

  container.querySelector('#nrn-window')?.addEventListener('change', (e) => {
    state.neuronWindow = windowOf(e.target.value);
    refreshNeuron(container, host);
  });
  container.querySelector('#nrn-metric')?.addEventListener('change', (e) => {
    state.neuronMetric = e.target.value === 'grade' ? 'grade' : 'alignment';
    rerender({ metric: state.neuronMetric });
  });
  container.querySelector('#nrn-focus')?.addEventListener('change', (e) => focusOn(e.target.value));
  container.querySelectorAll('[data-focus]').forEach((el) => el.addEventListener('click', () => focusOn(el.dataset.focus)));
  container.querySelector('#nrn-refresh')?.addEventListener('click', () => refreshNeuron(container, host, { announceDone: true }));

  container.querySelector('#nrn-run-all')?.addEventListener('click', (e) => runJourneys(Object.keys(data.model.perJourney), { container, host, btn: e.currentTarget }));
  container.querySelectorAll('.nrn-run-focus').forEach((btn) => btn.addEventListener('click', () => runJourneys([btn.dataset.journey], { container, host, btn })));

  container.querySelectorAll('details[data-lazy="schedule"]').forEach((det) => det.addEventListener('toggle', async () => {
    const box = det.querySelector('.nrn-snippets');
    if (!det.open || !box || box.dataset.state !== 'idle') return;
    box.dataset.state = 'loading';
    try {
      const r = await api(`/api/journeys/${enc(det.dataset.journey)}/schedule`);
      renderSnippets(box, r);
      box.dataset.state = 'done';
    } catch (err) {
      box.innerHTML = `<p class="refs-error">Couldn't load the snippets: ${escapeHtml(err.message)}</p>`;
      box.dataset.state = 'error';
    }
  }));
}

const SNIPPET_TITLES = { cron: 'cron', schtasks: 'schtasks (Windows Task Scheduler)', actions: 'GitHub Actions', k8s: 'Kubernetes CronJob' };
function renderSnippets(box, r) {
  const formats = Object.keys(r.snippets || {});
  if (!formats.length) { box.innerHTML = '<p class="nrn-muted">no snippets</p>'; return; }
  box.innerHTML = `
    ${r.placeholder ? '<p class="journey-load-error">placeholder cadence — this journey declares no schedule:; edit before installing</p>' : ''}
    ${Array.isArray(r.envNames) && r.envNames.length ? `<p class="nrn-muted">env var names the run needs bound: ${r.envNames.map((n) => `<code>${escapeHtml(n)}</code>`).join(' ')}</p>` : ''}
    <div class="nrn-tabs" role="tablist">${formats.map((f, i) => `<button type="button" class="ctrl-btn nrn-tab${i === 0 ? ' is-active' : ''}" role="tab" data-format="${escapeHtml(f)}" aria-selected="${i === 0}">${escapeHtml(SNIPPET_TITLES[f] || f)}</button>`).join('')}</div>
    ${formats.map((f, i) => `<pre class="nrn-pre" data-format="${escapeHtml(f)}"${i === 0 ? '' : ' hidden'}>${escapeHtml(r.snippets[f])}</pre>`).join('')}`;
  box.querySelectorAll('.nrn-tab').forEach((tab) => tab.addEventListener('click', () => {
    box.querySelectorAll('.nrn-tab').forEach((t) => { t.classList.toggle('is-active', t === tab); t.setAttribute('aria-selected', String(t === tab)); });
    box.querySelectorAll('pre[data-format]').forEach((p) => { p.hidden = p.dataset.format !== tab.dataset.format; });
  }));
}

// A one-line gist of a recorded error for the cause list: the transport's own
// wording up to its payload dump, tags stripped, the HTTP status kept. The
// full text stays in the evidence block the cause links to.
function errorGist(text) {
  if (!text) return 'no error text was recorded';
  const flat = String(text).replace(/<[^>]*>/g, ' ').replace(/\\[rn]/g, ' ').replace(/\s+/g, ' ').trim();
  const head = flat.split(/\.?\s*errors?:\s*[{[]/)[0].trim();
  const status = flat.match(/HTTP (\d{3})/)?.[1];
  const gist = status && !head.includes(status) ? `${head} (HTTP ${status})` : head;
  return gist.length > 160 ? `${gist.slice(0, 157)}…` : gist;
}
