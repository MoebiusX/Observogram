// tools/lib/remediation-flow.mjs
//
// The diagnose → remediate flow (GAP batch 2, B3.3): the response path from a
// firing alert to the remediation the pack declares for it, computed from pack
// data alone. The spec's remediation entry names its trigger as an alert ID
// (`trigger: alert:<slug>`, spec §5.9) and nothing else binds the two, so this
// module is the one place that resolves a trigger to the alert artefacts it
// means and says what stands between the declaration and a working path.
//
// The linking rule (normative; docs/ADAPTER.md "Response path"). Targets are
// the pack's L4 alerts — `policy` artefacts classified `burn_rate`, `alerting`
// artefacts classified `alert_rule` — and its `alerting` routes classified
// `alert_route`; remediations are the `healing` artefacts classified
// `remediation`, addressed by position (`remediation[i]`). Four tiers, the
// first tier with at least one hit wins and every hit of that tier links:
//
//   T0 annotation  `metadata.annotations["observogram.remediates.remediation[<i>]"]`
//                  = "<symbol>[, <symbol>…]" — `alerting.rules[<j>]`,
//                  `policy.burn_rate_alerts[<j>]`, `slos.<id>` (every burn alert
//                  of that SLO) or `alert:<slug>` (T1 then T2 over the slug);
//                  a symbol resolving to nothing is a warning, never a link.
//   T1 rule-name   slugKey(rule.name) === triggerSlug(trigger)
//   T2 burn-name   a compiled burn-rule name of a burn alert equals the slug
//                  (`<slo>_burn_<factor>x_<short>_<long>`, non-word runs → `_`
//                  — compile.mjs's formula, cross-checked by its test)
//   T3 slo         slugKey(burn.spec.slo) === triggerSlug(trigger)
//
// No hit → `unresolved`, with suggestions scored on shared name tokens (the
// service and pack name tokens dropped) — never a link, never counted as
// covered, never a deploy action. slugKey lowercases and strips every
// non-alphanumeric (traceability-graph.mjs's `compact`), so `alert:High-Error
// Rate` meets `HighErrorRate`.
//
// States come from the comparison (tools/lib/diff.mjs's buckets, indexed by
// each entry's artefact through identityKeyOf, never by parsing a key) when
// one is given: `live` (aligned on both sides — "in the baseline" when the
// other side is a baseline), `drifted`, `missing` (declared, not on the other
// side), `unverified` (the other side did not observe the family or the
// comparison did not cover the artefact), `placeholder` (a Scaffold on the
// declared side), `unhealthy` (live, but listed in the live side's
// `mcp.discovered.alert_rules_unhealthy`); without a comparison every alert is
// `declared` and the path `uncompared`. A remediation whose own source is
// Scaffold (the legacy upconvert marks every one it invents) is a
// `placeholder`: its guardrails and automation are template values.
//
// Pure ESM, browser-safe, vendorable (a listed module); imports
// ./artefact-model.mjs (classify, identityKeyOf) only. Never throws on a
// malformed input, never mutates its inputs, reads no clock, and walks in
// pack order so two runs over the same inputs are the same model. The studio
// loads it at call time (studio/remediation-flow-view.mjs) and the audit
// report reads the same model.

import { classify, identityKeyOf } from './artefact-model.mjs';

export const REMEDIATES_ANNOTATION_PREFIX = 'observogram.remediates.';
export const LINK_TIERS = Object.freeze(['annotation', 'rule-name', 'burn-name', 'slo']);
export const FLOW_STATES = Object.freeze(['declared', 'live', 'drifted', 'missing', 'unhealthy', 'unverified', 'placeholder', 'uncompared']);
export const BLOCKING_STATES = Object.freeze(['missing', 'unhealthy', 'drifted', 'placeholder']);
export const STEP_KINDS = Object.freeze(['deploy-alert', 'fix-alert', 'reconcile-alert', 'complete-alert', 'route', 'register-automation', 'human', 'runbook', 'automation', 'guardrails', 'annotate']);
export const OTHER_SIDES = Object.freeze(['live', 'baseline']);
export const MAX_SUGGESTIONS = 3;

const ALERT_FAMILIES = Object.freeze(['burn_rate', 'alert_rule']);
const UNHEALTHY_ANNOTATION = 'mcp.discovered.alert_rules_unhealthy';
// Words that name the mechanism, not the failure: they would pair every
// trigger with every alert.
const STOP_TOKENS = new Set(['alert', 'alerts', 'burn', 'fast', 'slow', 'high', 'low', 'rate', 'error', 'errors', 'failure', 'failures', 'critical', 'warning', 'page', 'ticket', 'under', 'over', 'above', 'below', 'too', 'many', 'soon', 'svc', 'service']);
// The worst state first — a path is as broken as its most broken alert.
const STATE_SEVERITY = Object.freeze(['missing', 'unhealthy', 'drifted', 'placeholder', 'unverified', 'declared', 'live']);

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** Lowercase, every non-alphanumeric stripped: the key two names meet on. */
export function slugKey(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** The slug of a remediation trigger: `ref:` then `alert:` stripped (case-insensitively), then slugKey. */
export function triggerSlug(trigger) {
  if (typeof trigger !== 'string') return '';
  return slugKey(trigger.trim().replace(/^ref:/i, '').replace(/^alert:/i, ''));
}

function stripRef(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/^ref:/, '').replace(/^slos\./, '').replace(/^slis\./, '');
}

/**
 * The alert names tools/lib/compile.mjs emits for a burn-rate alert
 * (`${slo.id}_burn_${factor}x_${short}_${long}`, every run outside
 * [A-Za-z0-9_] → `_`; the factor defaults to 1), one per window. `14.4x`
 * therefore reads `14_4x` — the compiler's test cross-checks this list
 * against the rules it really emits.
 */
export function burnRuleNames(spec) {
  const slo = stripRef(spec?.slo);
  if (!slo || !Array.isArray(spec?.windows)) return [];
  return spec.windows
    .filter((w) => w && typeof w === 'object')
    .map((w) => `${slo}_burn_${w.factor || 1}x_${w.short}_${w.long}`.replace(/[^a-zA-Z0-9_]/g, '_'));
}

function tokens(text, drop = new Set()) {
  return String(text ?? '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !/^\d/.test(t) && !/^p\d+$/.test(t) && !STOP_TOKENS.has(t) && !drop.has(t));
}

// The tokens two names share: equal, or one a ≥4-letter prefix of the other
// (`settler` ~ `settlement`), each token of `a` counted once.
function sharedTokens(a, b) {
  const out = [];
  const bs = [...new Set(b)];
  for (const x of new Set(a)) {
    const hit = bs.find((y) => x === y || (x.length >= 4 && y.startsWith(x)) || (y.length >= 4 && x.startsWith(y)));
    if (hit) out.push(x === hit ? x : `${x.length <= hit.length ? x : hit}~`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Targets: the L4 artefacts the path runs through, each as a Ref
// ---------------------------------------------------------------------------

function listOf(value) {
  return Array.isArray(value) ? value.filter((a) => a && typeof a === 'object') : [];
}

function ref(artefact, symbol, sub, family) {
  return {
    id: String(artefact.id ?? ''),
    symbol,
    identityKey: safeIdentityKey(artefact),
    family,
    title: String(artefact.title ?? artefact.id ?? ''),
    layer: 'L4',
    sub,
    source: artefact.source ?? 'Declared',
  };
}

function safeIdentityKey(artefact) {
  try { return identityKeyOf(artefact); } catch { return null; }
}

function safeClassify(artefact) {
  try { return classify(artefact); } catch { return 'unknown'; }
}

function alertSeverities(alert) {
  if (alert.family === 'burn_rate') {
    return [...new Set((Array.isArray(alert.spec?.windows) ? alert.spec.windows : []).map((w) => w?.severity).filter((s) => typeof s === 'string' && s))];
  }
  const s = alert.spec?.severity ?? alert.spec?.labels?.severity;
  return typeof s === 'string' && s ? [s] : [];
}

function alertNames(alert) {
  if (alert.family === 'burn_rate') return burnRuleNames(alert.spec);
  const n = alert.spec?.name;
  return typeof n === 'string' && n ? [n] : [];
}

/**
 * The pack's response-path artefacts as Refs: `remediations` (`remediation[i]`),
 * `alerts` (burn alerts `policy.burn_rate_alerts[j]` then rules
 * `alerting.rules[j]`, in the layer walk's order), `routes`
 * (`alerting.routes[j]`), `slos` (the L1 SLO artefacts, by `slos.<id>`). The
 * index in a symbol is the artefact's position among its family — the
 * adapter's own symbol for a canonical pack, the same rule for a typed one.
 */
export function remediationTargets(pack) {
  const L4 = pack?.layers?.L4 && typeof pack.layers.L4 === 'object' ? pack.layers.L4 : {};
  const remediations = [];
  const alerts = [];
  const routes = [];
  const slos = [];
  let i = 0;
  for (const a of listOf(L4.healing)) {
    if (safeClassify(a) !== 'remediation') continue;
    const spec = a.spec && typeof a.spec === 'object' ? a.spec : {};
    remediations.push({
      ...ref(a, `remediation[${i}]`, 'healing', 'remediation'),
      index: i,
      trigger: typeof spec.trigger === 'string' ? spec.trigger : '',
      runbook: typeof spec.runbook === 'string' ? spec.runbook : '',
      automation: typeof spec.automation === 'string' ? spec.automation : '',
      guardrails: spec.guardrails && typeof spec.guardrails === 'object' ? spec.guardrails : null,
      placeholder: a.source === 'Scaffold',
    });
    i += 1;
  }
  let j = 0;
  for (const a of listOf(L4.policy)) {
    if (safeClassify(a) !== 'burn_rate') continue;
    const r = { ...ref(a, `policy.burn_rate_alerts[${j}]`, 'policy', 'burn_rate'), spec: a.spec && typeof a.spec === 'object' ? a.spec : {} };
    r.slo = stripRef(r.spec.slo);
    r.names = alertNames(r);
    r.severities = alertSeverities(r);
    alerts.push(r);
    j += 1;
  }
  let k = 0;
  let m = 0;
  for (const a of listOf(L4.alerting)) {
    const family = safeClassify(a);
    if (family === 'alert_rule') {
      const r = { ...ref(a, `alerting.rules[${k}]`, 'alerting', 'alert_rule'), spec: a.spec && typeof a.spec === 'object' ? a.spec : {} };
      r.slo = '';
      r.names = alertNames(r);
      r.severities = alertSeverities(r);
      alerts.push(r);
      k += 1;
    } else if (family === 'alert_route') {
      const spec = a.spec && typeof a.spec === 'object' ? a.spec : {};
      routes.push({
        ...ref(a, `alerting.routes[${m}]`, 'alerting', 'alert_route'),
        severity: typeof spec.severity === 'string' ? spec.severity : '',
        channels: (Array.isArray(spec.channels) ? spec.channels : []).map((c) => (c && typeof c === 'object' ? Object.keys(c)[0] : null)).filter(Boolean),
      });
      m += 1;
    }
  }
  for (const a of listOf(pack?.layers?.L1)) {
    const defines = typeof a.defines === 'string' ? a.defines : '';
    if (!defines.startsWith('slos.')) continue;
    slos.push({ id: String(a.id ?? ''), symbol: defines, sloId: defines.slice('slos.'.length), identityKey: safeIdentityKey(a), title: String(a.title ?? a.id ?? '') });
  }
  return { remediations, alerts, routes, slos };
}

// ---------------------------------------------------------------------------
// The linking rule
// ---------------------------------------------------------------------------

function bySlug(alerts, slug) {
  if (!slug) return { t1: [], t2: [], t3: [] };
  return {
    t1: alerts.filter((a) => a.family === 'alert_rule' && slugKey(a.spec.name) === slug),
    t2: alerts.filter((a) => a.family === 'burn_rate' && a.names.some((n) => slugKey(n) === slug)),
    t3: alerts.filter((a) => a.family === 'burn_rate' && slugKey(a.slo) === slug),
  };
}

// One annotation symbol → the alerts it names (possibly none).
function resolveSymbol(symbol, alerts) {
  const s = symbol.trim();
  if (!s) return [];
  if (/^(alerting\.rules|policy\.burn_rate_alerts)\[\d+\]$/.test(s)) return alerts.filter((a) => a.symbol === s);
  if (/^slos\./.test(s)) { const slo = s.slice('slos.'.length); return alerts.filter((a) => a.family === 'burn_rate' && a.slo === slo); }
  if (/^alert:/i.test(s)) { const { t1, t2 } = bySlug(alerts, triggerSlug(s)); return t1.length ? t1 : t2; }
  return [];
}

/**
 * Resolve one remediation's trigger over the pack's alerts:
 * `{ tier, alerts }` when a tier hits, else `{ tier: null, alerts: [],
 * suggestions }`. `warnings` collects the annotation symbols that name no
 * alert. Exported for the tests and the audit report; the model calls it.
 */
export function resolveTrigger(remediation, targets, { annotations = null, drop = new Set(), warnings = [] } = {}) {
  const alerts = targets?.alerts || [];
  const annotation = annotations && typeof annotations === 'object' ? annotations[`${REMEDIATES_ANNOTATION_PREFIX}${remediation.symbol}`] : undefined;
  if (typeof annotation === 'string' && annotation.trim()) {
    const hits = [];
    for (const symbol of annotation.split(',')) {
      const resolved = resolveSymbol(symbol, alerts);
      if (!resolved.length && symbol.trim()) warnings.push(`${remediation.symbol}: ${REMEDIATES_ANNOTATION_PREFIX}${remediation.symbol} names ${symbol.trim()}, which resolves to no alert of this pack`);
      for (const a of resolved) if (!hits.includes(a)) hits.push(a);
    }
    if (hits.length) return { tier: 'annotation', alerts: hits.sort((x, y) => alerts.indexOf(x) - alerts.indexOf(y)) };
  }
  const slug = triggerSlug(remediation.trigger);
  const { t1, t2, t3 } = bySlug(alerts, slug);
  if (t1.length) return { tier: 'rule-name', alerts: t1 };
  if (t2.length) return { tier: 'burn-name', alerts: t2 };
  if (t3.length) return { tier: 'slo', alerts: t3 };
  return { tier: null, alerts: [], suggestions: suggestionsFor(remediation, alerts, drop) };
}

function suggestionsFor(remediation, alerts, drop) {
  const tt = tokens(String(remediation.trigger ?? '').replace(/^ref:/i, '').replace(/^alert:/i, ''), drop);
  if (!tt.length) return [];
  const scored = alerts
    .map((a, i) => { const shared = sharedTokens(tt, tokens(`${a.spec.name ?? ''} ${a.slo}`, drop)); return { a, i, shared, score: shared.length }; })
    .filter((x) => x.score > 0);
  let picked = scored.filter((x) => x.score >= 2);
  if (!picked.length) { const ones = scored.filter((x) => x.score === 1); picked = ones.length === 1 ? ones : []; }
  picked.sort((x, y) => y.score - x.score || x.i - y.i);
  return picked.slice(0, MAX_SUGGESTIONS).map((x) => ({ ref: alertRef(x.a), score: x.score, shared: x.shared }));
}

function alertRef(a) {
  return { id: a.id, symbol: a.symbol, identityKey: a.identityKey, family: a.family, title: a.title, layer: a.layer, sub: a.sub, source: a.source, names: a.names, severities: a.severities, slo: a.slo || null };
}

function routeRef(r) {
  return { id: r.id, symbol: r.symbol, identityKey: r.identityKey, family: r.family, title: r.title, layer: r.layer, sub: r.sub, source: r.source, severity: r.severity, channels: r.channels };
}

function remediationRef(r) {
  return { id: r.id, symbol: r.symbol, identityKey: r.identityKey, family: r.family, title: r.title, layer: r.layer, sub: r.sub, source: r.source, trigger: r.trigger, runbook: r.runbook, automation: r.automation, guardrails: r.guardrails, placeholder: r.placeholder };
}

// ---------------------------------------------------------------------------
// States from the comparison
// ---------------------------------------------------------------------------

function unhealthyNames(liveAnnotations) {
  const value = liveAnnotations && typeof liveAnnotations === 'object' ? liveAnnotations[UNHEALTHY_ANNOTATION] : undefined;
  if (value == null || value === '') return new Set();
  const list = Array.isArray(value) ? value : String(value).split(',');
  return new Set(list.map((e) => String(e).trim()).filter(Boolean));
}

/**
 * The comparison's verdict per declared artefact, indexed by the ARTEFACT's
 * identity key (`onlyInA[].artefact`, `inBoth[].a`, `scaffold[].artefact` and
 * `notObserved[].artefact` of side `a`) — a key string is read only for an
 * entry that carries no artefact. `null` when the diff is absent or errored.
 */
export function alertStatesFromDiff(diff) {
  if (!diff || typeof diff !== 'object' || diff.error || !diff.layers || typeof diff.layers !== 'object') return null;
  const states = new Map();
  const put = (artefact, key, state, entry) => {
    const k = (artefact ? safeIdentityKey(artefact) : null) ?? (typeof key === 'string' ? key.replace(/@[ab]#\d+$/, '') : null);
    if (k && !states.has(k)) states.set(k, { state, entry });
  };
  for (const bucket of Object.values(diff.layers)) {
    if (!bucket || typeof bucket !== 'object') continue;
    for (const e of listOf(bucket.inBoth)) put(e.a, e.key, e.match === 'drifted' ? 'drifted' : 'live', e);
    for (const e of listOf(bucket.onlyInA)) put(e.artefact, e.key, 'missing', e);
    for (const e of listOf(bucket.scaffold)) if (e.side === 'a') put(e.artefact, e.key, 'placeholder', e);
    for (const e of listOf(bucket.notObserved)) if (e.side === 'a') put(e.artefact, e.key, 'unverified', e);
  }
  return states;
}

function alertState(alert, states, unhealthy) {
  if (alert.source === 'Scaffold') return { state: 'placeholder', deltas: [] };
  if (!states) return { state: 'declared', deltas: [] };
  const hit = alert.identityKey ? states.get(alert.identityKey) : null;
  if (!hit) return { state: 'unverified', deltas: [] };
  const deltas = hit.state === 'drifted' ? listOf(hit.entry?.deltas).map((d) => String(d.field ?? '')).filter(Boolean) : [];
  if ((hit.state === 'live' || hit.state === 'drifted') && alert.names.some((n) => unhealthy.has(n))) return { state: 'unhealthy', deltas };
  return { state: hit.state, deltas };
}

function worstState(states) {
  for (const s of STATE_SEVERITY) if (states.includes(s)) return s;
  return 'declared';
}

// ---------------------------------------------------------------------------
// Steps — what next, in the order a responder walks the path
// ---------------------------------------------------------------------------

const otherWord = (otherSide) => (otherSide === 'baseline' ? 'in the baseline' : 'live');

function alertSteps(alert, status, slos, otherSide) {
  const name = alert.names[0] || alert.title || alert.id;
  const other = otherWord(otherSide);
  switch (status.state) {
    case 'missing': {
      if (alert.family === 'burn_rate') {
        const slo = slos.find((s) => s.sloId === alert.slo) || null;
        return [{
          kind: 'deploy-alert', tone: 'fail', alert: alert.symbol,
          text: `Deploy the burn-rate rules of ${alert.slo || name}: declared, not ${other}.`,
          action: slo ? { type: 'deploy', identity: slo.sloId, artefactId: slo.id, symbol: slo.symbol, rows: 2 } : null,
        }];
      }
      return [{ kind: 'deploy-alert', tone: 'fail', alert: alert.symbol, text: `Ship ${name} with the alert rule set: declared, not ${other} (not a compiled artefact — it goes with its own rule files).`, action: null }];
    }
    case 'drifted':
      return [{ kind: 'reconcile-alert', tone: 'warn', alert: alert.symbol, text: `${name} differs ${other}${status.deltas.length ? ` (${status.deltas.join(', ')})` : ''}: reconcile the repository or the deployed rule before relying on it.` }];
    case 'unhealthy':
      return [{ kind: 'fix-alert', tone: 'fail', alert: alert.symbol, text: `${name} is ${other} but not evaluating (listed in ${UNHEALTHY_ANNOTATION}): fix the rule before the remediation can fire.` }];
    case 'placeholder':
      return [{ kind: 'complete-alert', tone: 'warn', alert: alert.symbol, text: `${name} is a placeholder (template values): fill the rule before it can fire.` }];
    default:
      return [];
  }
}

function routeSteps(link, routes) {
  const severities = [...new Set(link.alerts.flatMap((a) => a.ref.severities))];
  const steps = [];
  for (const sev of severities) {
    const carried = routes.filter((r) => r.severity === sev);
    if (!carried.length) steps.push({ kind: 'route', tone: 'warn', severity: sev, text: `No route carries ${sev}: add an alerting.routes entry for it, or the alert fires into silence.` });
    else steps.push({ kind: 'route', tone: 'ok', severity: sev, text: `${sev} reaches ${carried.map((r) => `${r.id} (${r.channels.join(', ') || 'no channels'})`).join(', ')}.` });
  }
  return steps;
}

function remediationSteps(r) {
  const steps = [];
  const template = r.placeholder ? ' (template values — the upconvert invented them)' : '';
  if (r.automation) {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r.automation)) {
      steps.push({ kind: 'register-automation', tone: 'info', text: `Register ${r.automation} to run when the alert fires${template}.` });
    } else {
      steps.push({ kind: 'human', tone: 'info', text: `Manual remediation (${r.automation}): a human runs the runbook; nothing fires automatically${template}.` });
    }
  }
  const above = r.guardrails?.requires_human_above;
  if (typeof above === 'string' && above) steps.push({ kind: 'human', tone: 'info', text: `${above} and above need a human before the automation runs (requires_human_above)${template}.` });
  if (r.runbook) {
    const href = /^https?:\/\//i.test(r.runbook) ? r.runbook : null;
    steps.push({ kind: 'runbook', tone: 'info', text: `Runbook: ${r.runbook}${template}.`, href });
  }
  if (r.guardrails) {
    const g = r.guardrails;
    const parts = [];
    if (g.max_invocations_per_hour != null) parts.push(`at most ${g.max_invocations_per_hour}/hour`);
    if (g.cooldown_after_success) parts.push(`cooldown ${g.cooldown_after_success}`);
    if (g.rollback_on_failure != null) parts.push(g.rollback_on_failure ? 'rolls back on failure' : 'no rollback on failure');
    if (g.circuit_breaker && typeof g.circuit_breaker === 'object') parts.push(`circuit breaker ${g.circuit_breaker.failures ?? '?'} failures in ${g.circuit_breaker.window ?? '?'}`);
    if (parts.length) steps.push({ kind: 'guardrails', tone: 'info', text: `Guardrails: ${parts.join(' · ')}${template}.` });
  }
  return steps;
}

function annotateStep(r, suggestions) {
  const example = suggestions[0]?.ref.symbol || 'alerting.rules[<j>]';
  return {
    kind: 'annotate', tone: 'warn',
    text: `No alert of this pack answers to ${r.trigger || '(no trigger)'}. Name the alert it means: metadata.annotations["${REMEDIATES_ANNOTATION_PREFIX}${r.symbol}"] = "${example}"${suggestions.length ? ` — or rename the trigger to the alert's name.` : '.'}`,
    annotation: `${REMEDIATES_ANNOTATION_PREFIX}${r.symbol}`,
    example,
  };
}

// ---------------------------------------------------------------------------
// The model
// ---------------------------------------------------------------------------

function emptyCounts() {
  return { remediations: 0, alerts: 0, linked: 0, unresolved: 0, uncovered: 0, blocked: 0, suggestions: 0, placeholder: 0 };
}

/**
 * The response-path model of an adapted pack:
 * `{ configured, compared, otherSide, counts, links[], unresolved[], uncovered[], families[], warnings[] }`.
 * `configured` is false (and everything else empty) when the pack declares no
 * remediation — the renderers draw nothing then. `diff` is the comparison
 * with the other side (`/api/diff`'s body, or diffPacks' result) or null;
 * `liveAnnotations` the other side's `metadata.annotations` (the unhealthy
 * list); `otherSide` names what the comparison is against for the copy.
 */
export function buildRemediationFlowModel({ pack = null, diff = null, liveAnnotations = null, otherSide = 'live' } = {}) {
  const side = OTHER_SIDES.includes(otherSide) ? otherSide : 'live';
  const targets = remediationTargets(pack);
  const counts = emptyCounts();
  const model = { configured: targets.remediations.length > 0, compared: false, otherSide: side, counts, links: [], unresolved: [], uncovered: [], families: [], warnings: [] };
  if (!model.configured) return model;

  const states = alertStatesFromDiff(diff);
  model.compared = states !== null;
  const unhealthy = unhealthyNames(liveAnnotations);
  const annotations = pack?.meta?.annotations && typeof pack.meta.annotations === 'object' ? pack.meta.annotations : null;
  const drop = new Set([...tokens(pack?.meta?.service), ...tokens(pack?.meta?.name ?? pack?.name)]);
  const statusOf = new Map(targets.alerts.map((a) => [a, alertState(a, states, unhealthy)]));
  const covered = new Set();

  counts.remediations = targets.remediations.length;
  counts.alerts = targets.alerts.length;
  for (const r of targets.remediations) {
    if (r.placeholder) counts.placeholder += 1;
    const resolved = resolveTrigger(r, targets, { annotations, drop, warnings: model.warnings });
    if (!resolved.tier) {
      const suggestions = resolved.suggestions;
      counts.suggestions += suggestions.length;
      model.unresolved.push({ remediation: remediationRef(r), trigger: r.trigger, placeholder: r.placeholder, suggestions, steps: [annotateStep(r, suggestions), ...remediationSteps(r)] });
      continue;
    }
    const alerts = resolved.alerts.map((a) => { covered.add(a); const st = statusOf.get(a); return { ref: alertRef(a), state: st.state, deltas: st.deltas }; });
    const link = {
      remediation: remediationRef(r),
      trigger: r.trigger,
      tier: resolved.tier,
      alerts,
      routes: [],
      state: 'declared',
      blocked: false,
      placeholder: r.placeholder,
      steps: [],
    };
    const severities = new Set(alerts.flatMap((a) => a.ref.severities));
    link.routes = targets.routes.filter((rt) => severities.has(rt.severity)).map(routeRef);
    const worst = worstState(alerts.map((a) => a.state));
    link.state = !model.compared
      ? (r.placeholder || worst === 'placeholder' ? 'placeholder' : 'uncompared')
      : (r.placeholder && !BLOCKING_STATES.includes(worst) ? 'placeholder' : worst);
    link.blocked = BLOCKING_STATES.includes(link.state);
    if (link.blocked) counts.blocked += 1;
    link.steps = [
      ...resolved.alerts.flatMap((a) => alertSteps(a, statusOf.get(a), targets.slos, side)),
      ...routeSteps(link, targets.routes),
      ...remediationSteps(r),
    ];
    model.links.push(link);
  }
  counts.linked = model.links.length;
  counts.unresolved = model.unresolved.length;
  for (const a of targets.alerts) {
    if (covered.has(a)) continue;
    model.uncovered.push({ ref: alertRef(a), state: statusOf.get(a).state });
  }
  counts.uncovered = model.uncovered.length;
  for (const family of ALERT_FAMILIES) {
    const all = targets.alerts.filter((a) => a.family === family);
    if (!all.length) continue;
    const linked = model.links.filter((l) => l.alerts.some((a) => a.ref.family === family));
    model.families.push({
      family,
      alerts: all.length,
      covered: all.filter((a) => covered.has(a)).length,
      uncovered: all.filter((a) => !covered.has(a)).length,
      remediations: linked.map((l) => l.remediation.symbol),
      blocked: linked.filter((l) => l.blocked).length,
    });
  }
  return model;
}
