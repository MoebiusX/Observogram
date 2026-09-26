// studio/ux-kit.mjs
//
// The studio's shared screen grammar (the 2026-09 UX review,
// docs/UX_SCREEN_GRAMMAR.md). Every working screen answers three questions
// in the same order — what am I looking at, what needs my attention, what can
// I do next — and then explains itself and offers the detail:
//
//   1. Context      service · environment · pack and version (A and B named)
//   2. Decision     one sentence stating the outcome
//   3. Next action  one primary button
//   4. Explanation  a few measures and the reasons behind the decision
//   5. Details      filters, artefacts, proof, configuration, raw output
//
// This module renders 1–4 (decisionHeaderHtml), the status vocabulary every
// screen shares (statusChipHtml — four separate properties, never one
// interchangeable badge), the plain-language glossary, empty states that
// explain what was checked, a sticky section index for the long pages, and a
// single live region for status announcements.
//
// Pure string builders plus two tiny DOM helpers (wireSectionNav, announce)
// that only run when called. Safe to import under node for the headless tests.

import { escapeHtml } from './util.mjs';

// ---------- the four status properties ----------
//
// Origin, completion, evidence and assessment answer different questions.
// The studio used to render all of them as one badge vocabulary (verified ·
// declared · scaffold · candidate · recorded live · pass · pass on placeholder
// · conformant · valid · warning · gap · todo), which read as interchangeable.
// Each property has its own values, its own question and its own shape.

export const STATUS_PROPERTIES = {
  origin: {
    label: 'Origin',
    question: 'Where did this come from?',
    values: {
      library:    { label: 'Library',    tone: 'neutral', tip: 'Instantiated from the Observogram library.' },
      imported:   { label: 'Imported',   tone: 'neutral', tip: 'Loaded from an uploaded or scanned pack.' },
      discovered: { label: 'Discovered', tone: 'neutral', tip: 'Found on the live platform, not declared in the repository.' },
      authored:   { label: 'Authored',   tone: 'neutral', tip: 'Written or edited by a person in the studio.' },
    },
  },
  completion: {
    label: 'Completion',
    question: 'Have we filled it in?',
    values: {
      draft:      { label: 'Draft',        tone: 'info', tip: 'Proposed, not yet reviewed.' },
      needsInput: { label: 'Needs input',  tone: 'warn', tip: 'Template value needs completion: the requirement is represented, but a real value is still needed.' },
      complete:   { label: 'Complete',     tone: 'ok',   tip: 'Every required value is filled in.' },
    },
  },
  evidence: {
    label: 'Evidence',
    question: 'What supports it?',
    values: {
      live:       { label: 'Live evidence found', tone: 'ok',      tip: 'The live platform reports this signal. That shows it exists; it does not by itself prove every link of a requirement.' },
      declared:   { label: 'Declared only',       tone: 'neutral', tip: 'Declared in the pack or repository; no live evidence was checked or found.' },
      unverified: { label: 'Unverified',          tone: 'warn',    tip: 'Expected, but nothing live confirms it yet.' },
      missing:    { label: 'Missing',             tone: 'fail',    tip: 'Required, and neither declared nor observed.' },
    },
  },
  assessment: {
    label: 'Assessment',
    question: 'Did it meet this check?',
    values: {
      pass:          { label: 'Pass',            tone: 'ok',      tip: 'Met this check with real values.' },
      placeholder:   { label: 'Represented',     tone: 'warn',    tip: 'Requirement represented; real value still needed. It passes the rubric on a placeholder.' },
      warning:       { label: 'Warning',         tone: 'warn',    tip: 'Met the check, with a finding worth reviewing.' },
      fail:          { label: 'Fail',            tone: 'fail',    tip: 'Did not meet this check.' },
      notEvaluated:  { label: 'Not evaluated',   tone: 'neutral', tip: 'This check has not run, or could not run, for this item.' },
      notApplicable: { label: 'Not applicable',  tone: 'muted',   tip: 'Excluded at this tier: shown for reference only, not counted.' },
    },
  },
};

// The legacy badge words, mapped onto the property they actually describe.
// Screens that still receive an engine's old word call this so the chip they
// render says which question it answers.
const LEGACY_STATUS = {
  verified:              ['evidence', 'live'],
  'recorded live':       ['evidence', 'live'],
  live:                  ['evidence', 'live'],
  declared:              ['evidence', 'declared'],
  unverified:            ['evidence', 'unverified'],
  stale:                 ['evidence', 'unverified'],
  missing:               ['evidence', 'missing'],
  scaffold:              ['completion', 'needsInput'],
  placeholder:           ['completion', 'needsInput'],
  todo:                  ['completion', 'needsInput'],
  candidate:             ['completion', 'draft'],
  draft:                 ['completion', 'draft'],
  complete:              ['completion', 'complete'],
  library:               ['origin', 'library'],
  imported:              ['origin', 'imported'],
  uploaded:              ['origin', 'imported'],
  discovered:            ['origin', 'discovered'],
  authored:              ['origin', 'authored'],
  pass:                  ['assessment', 'pass'],
  passed:                ['assessment', 'pass'],
  valid:                 ['assessment', 'pass'],
  conformant:            ['assessment', 'pass'],
  'pass on placeholder': ['assessment', 'placeholder'],
  'pass-placeholder':    ['assessment', 'placeholder'],
  warning:               ['assessment', 'warning'],
  warn:                  ['assessment', 'warning'],
  fail:                  ['assessment', 'fail'],
  failed:                ['assessment', 'fail'],
  gap:                   ['assessment', 'fail'],
  'n/a':                 ['assessment', 'notApplicable'],
  'not applicable':      ['assessment', 'notApplicable'],
  'not evaluated':       ['assessment', 'notEvaluated'],
};

export function statusFromLegacy(word) {
  const hit = LEGACY_STATUS[String(word ?? '').trim().toLowerCase()];
  return hit ? { property: hit[0], value: hit[1] } : null;
}

// Resolve a (property, value) pair to its display record, or null.
export function statusRecord(property, value) {
  const p = STATUS_PROPERTIES[property];
  const v = p?.values?.[value];
  return v ? { property, value, propertyLabel: p.label, question: p.question, ...v } : null;
}

// One chip for one property. `label` overrides the display text (a count, a
// shorter word) while the tooltip keeps the full plain-language meaning.
// With `showProperty` the chip names the property it answers ("Evidence ·
// Declared only") — use it where several properties share a row.
export function statusChipHtml(property, value, { label = null, showProperty = false, extraTip = '' } = {}) {
  const r = statusRecord(property, value);
  if (!r) return '';
  const text = label ?? r.label;
  const tip = `${r.propertyLabel} — ${r.question} ${r.tip}${extraTip ? ` ${extraTip}` : ''}`;
  return `<span class="ux-chip ux-chip-${r.tone} ux-chip-${property}" title="${escapeHtml(tip)}">`
    + (showProperty ? `<span class="ux-chip-prop">${escapeHtml(r.propertyLabel)}</span>` : '')
    + `${escapeHtml(text)}</span>`;
}

// Chip for an engine's legacy word; falls back to a neutral chip with the word itself.
export function legacyStatusChipHtml(word, opts = {}) {
  const s = statusFromLegacy(word);
  if (s) return statusChipHtml(s.property, s.value, opts);
  return `<span class="ux-chip ux-chip-neutral">${escapeHtml(opts.label ?? word)}</span>`;
}

// ---------- plain language first, formal term second ----------

// The review's wording table (§4) plus the studio's recurring formal terms.
// The glossary is the ONE place an explanation lives; labels link to it with
// termHtml instead of repeating a paragraph in every panel.
export const GLOSSARY = {
  'diagnostic-grade': { term: 'Diagnostic grade', plain: 'Assessment', def: 'A letter grade for how well the pack is backed by evidence and how closely it matches the selected baseline. It combines coverage, trust and the audit gate.' },
  coverage:     { term: 'Coverage', plain: 'Coverage', def: 'How much of the service the pack observes: the grade’s coverage checks (signal types, correlation, calibration, breadth) that pass.' },
  trust:        { term: 'Trust', plain: 'Trust', def: 'The share of this pack’s claims backed by live evidence rather than declaration alone.' },
  'audit-gate': { term: 'Audit gate', plain: 'Audit requirement', def: 'The minimum evidence the tier requires. A pack can have live signals and still fail it when required evidence is incomplete.' },
  baseline:     { term: 'Target', plain: 'Selected baseline', def: 'The pack you are comparing against — usually the curated repository pack.' },
  retrofeed:    { term: 'Retrofeed', plain: 'Update repository from live', def: 'Copies signals that exist on the live platform into the repository pack, as a patch you review and commit.' },
  deploy:       { term: 'Deploy', plain: 'Deploy repository changes to live', def: 'Pushes compiled artefacts from the pack to a live backend (for example Grafana).' },
  reconcile:    { term: 'Reconcile', plain: 'Review differences individually', def: 'Walk each difference between repository and live and decide per item.' },
  bidirectional:{ term: 'Bidirectional', plain: 'Sync in both directions', def: 'Deploy repository-only items and adopt live-only items in one plan.' },
  scaffold:     { term: 'Scaffold', plain: 'Template value needs completion', def: 'A value generated from a template so the requirement is represented; a person must supply the real value.' },
  placeholder:  { term: 'Pass on a placeholder', plain: 'Requirement represented; real value still needed', def: 'The rubric clause is satisfied structurally, but by a template value, not a real one.' },
  conformant:   { term: 'Conformant', plain: 'Meets tier rubric', def: 'Every MUST clause for the tier is satisfied — possibly on placeholders. It says nothing about deployment readiness.' },
  jaccard:      { term: 'Jaccard similarity', plain: 'Overlap', def: 'Shared artefacts divided by all artefacts in either pack. Useful to spot two packs that describe different things; the counts are usually more telling.' },
  tier:         { term: 'Criticality tier', plain: 'Criticality', def: 'How critical the service is. Higher tiers require more objectives, signals and alerting.' },
  sli:          { term: 'SLI', plain: 'Service level indicator', def: 'A measurement of how the service behaves, such as the ratio of good requests.' },
  slo:          { term: 'SLO', plain: 'Service level objective', def: 'The target for an SLI over a window, such as 99.9% good over 30 days.' },
  vantage:      { term: 'Vantage point', plain: 'Where the check observes from', def: 'The probe or MCP endpoint a Neuron journey uses to see the platform. When it is lost the check cannot observe, which is different from the check failing.' },
};

// An inline term: the plain wording, with the formal term and definition on
// hover/focus. `text` overrides the visible words.
export function termHtml(key, text = null) {
  const g = GLOSSARY[key];
  if (!g) return escapeHtml(text ?? key);
  const shown = text ?? g.plain;
  const formal = g.term !== shown ? `${g.term}: ` : '';
  return `<span class="ux-term" tabindex="0" title="${escapeHtml(formal + g.def)}">${escapeHtml(shown)}</span>`;
}

// ---------- the layer model, translated ----------

// Every layer code travels with its plain-English purpose (review §3 Discover).
export const LAYER_PURPOSE = {
  L1:  { name: 'Contract',   question: 'What should we measure?',          blurb: 'Objectives, indicators and the promises the service makes.' },
  L2:  { name: 'Telemetry',  question: 'How do signals arrive?',            blurb: 'Metrics, logs and traces, and the pipelines that carry them.' },
  L2X: { name: 'Extended',   question: 'What else do we collect?',          blurb: 'Additional signals beyond the core three: profiles, events, synthetic data.' },
  L3:  { name: 'Insight',    question: 'How do we see what is happening?',  blurb: 'Recording rules and dashboards that turn signals into answers.' },
  L4:  { name: 'Action',     question: 'What happens when it breaks?',      blurb: 'Alerts, routing, policy and self-healing.' },
  L5:  { name: 'Validation', question: 'How do we know it works?',          blurb: 'Tests, synthetic checks and chaos experiments that prove the rest.' },
  GOV: { name: 'Governance', question: 'Who owns it and how is it kept?',   blurb: 'Ownership, review and change control.' },
};

export function layerTitle(code) {
  const p = LAYER_PURPOSE[code];
  return p ? `${code} ${p.name} · ${p.question}` : String(code ?? '');
}

// ---------- the decision header ----------
//
// context:   [{ key, value, title? }] — the working context line (service,
//            environment, pack + version; A and B named on comparison screens)
// eyebrow:   small screen name (optional)
// decision:  the one sentence stating the outcome (HTML allowed via decisionHtml)
// tone:      'ok' | 'warn' | 'fail' | 'info' | 'neutral'
// verdict:   optional short word/grade shown beside the sentence ('C', 'Not ready')
// primary:   { id, label, action? } — the one prominent next step
// secondary: [{ id, label, action? }] — quieter alternatives
// causes:    [{ title, why?, actionLabel?, actionId?, tone? }] — the two or
//            three causes that most affect the result, each with its action
// measures:  [{ label, value, note?, tone?, group? }] — a few explained numbers
// id:        DOM id for the header section
export function decisionHeaderHtml({
  context = [], eyebrow = '', decision = '', decisionHtml = null, tone = 'info', verdict = '',
  verdictTitle = '', primary = null, secondary = [], causes = [], measures = [], id = '', sticky = false, note = '',
} = {}) {
  const ctx = context.filter(c => c && (c.value ?? '') !== '').map(c => `
      <span class="ux-ctx-item"${c.title ? ` title="${escapeHtml(c.title)}"` : ''}>
        ${c.key ? `<span class="ux-ctx-key">${escapeHtml(c.key)}</span>` : ''}
        <span class="ux-ctx-val">${escapeHtml(c.value)}</span>
      </span>`).join('<span class="ux-ctx-sep" aria-hidden="true">·</span>');
  const btn = (b, cls) => b ? `<button type="button" class="${cls}"${b.id ? ` id="${escapeHtml(b.id)}"` : ''}${b.action ? ` data-ux-action="${escapeHtml(b.action)}"` : ''}${b.title ? ` title="${escapeHtml(b.title)}"` : ''}>${escapeHtml(b.label)}</button>` : '';
  const causeList = causes.length ? `
      <ol class="ux-causes" aria-label="Main causes">
        ${causes.map(c => `
          <li class="ux-cause ux-tone-${escapeHtml(c.tone || tone)}">
            <span class="ux-cause-text">
              <span class="ux-cause-title">${escapeHtml(c.title)}</span>
              ${c.why ? `<span class="ux-cause-why">${escapeHtml(c.why)}</span>` : ''}
            </span>
            ${c.actionLabel ? `<button type="button" class="ux-link-btn"${c.actionId ? ` data-ux-action="${escapeHtml(c.actionId)}"` : ''}>${escapeHtml(c.actionLabel)} →</button>` : ''}
          </li>`).join('')}
      </ol>` : '';
  const measureList = measures.length ? `
      <dl class="ux-measures">
        ${measures.map(m => `
          <div class="ux-measure ux-tone-${escapeHtml(m.tone || 'neutral')}"${m.title ? ` title="${escapeHtml(m.title)}"` : ''}>
            <dt>${m.labelHtml ?? escapeHtml(m.label)}</dt>
            <dd><span class="ux-measure-val">${escapeHtml(m.value)}</span>${m.note ? `<span class="ux-measure-note">${escapeHtml(m.note)}</span>` : ''}</dd>
          </div>`).join('')}
      </dl>` : '';
  return `
    <section class="ux-decision ux-tone-${escapeHtml(tone)}${sticky ? ' is-sticky' : ''}"${id ? ` id="${escapeHtml(id)}"` : ''} aria-label="${escapeHtml(eyebrow || 'Summary')}">
      ${ctx ? `<div class="ux-ctx">${ctx}</div>` : ''}
      <div class="ux-decision-main">
        <div class="ux-decision-text">
          ${eyebrow ? `<div class="ux-eyebrow">${escapeHtml(eyebrow)}</div>` : ''}
          <p class="ux-decision-sentence">${verdict ? `<span class="ux-verdict"${verdictTitle ? ` title="${escapeHtml(verdictTitle)}"` : ''}>${escapeHtml(verdict)}</span>` : ''}${decisionHtml ?? escapeHtml(decision)}</p>
          ${note ? `<p class="ux-decision-note">${escapeHtml(note)}</p>` : ''}
        </div>
        ${(primary || secondary.length) ? `
        <div class="ux-decision-actions">
          ${btn(primary, 'ux-primary-btn')}
          ${secondary.map(s => btn(s, 'ux-secondary-btn')).join('')}
        </div>` : ''}
      </div>
      ${causeList}
      ${measureList}
    </section>`;
}

// Route [data-ux-action] clicks inside root to handlers[action](event, el).
// Idempotent per root: a re-render replaces the markup, the listener stays.
export function wireUxActions(root, handlers = {}) {
  if (!root) return;
  root._uxHandlers = handlers;
  if (root._uxWired) return;
  root._uxWired = true;
  root.addEventListener('click', (ev) => {
    const el = ev.target?.closest?.('[data-ux-action]');
    if (!el || !root.contains(el)) return;
    const fn = root._uxHandlers?.[el.dataset.uxAction];
    if (fn) { ev.preventDefault(); fn(ev, el); }
  });
}

// ---------- empty states that explain ----------
//
// title:   what the empty result means, in plain words
// checked: what scope was checked (so "nothing" is not mistaken for "not run")
// actions: [{ id?, action?, label }] — the relevant next steps
export function emptyStateHtml({ title, checked = '', body = '', actions = [], tone = 'neutral' } = {}) {
  return `
    <div class="ux-empty ux-tone-${escapeHtml(tone)}" role="note">
      <p class="ux-empty-title">${escapeHtml(title)}</p>
      ${checked ? `<p class="ux-empty-checked"><span class="ux-empty-key">Checked:</span> ${escapeHtml(checked)}</p>` : ''}
      ${body ? `<p class="ux-empty-body">${escapeHtml(body)}</p>` : ''}
      ${actions.length ? `<div class="ux-empty-actions">${actions.map(a => `<button type="button" class="ux-secondary-btn"${a.id ? ` id="${escapeHtml(a.id)}"` : ''}${a.action ? ` data-ux-action="${escapeHtml(a.action)}"` : ''}>${escapeHtml(a.label)}</button>`).join('')}</div>` : ''}
    </div>`;
}

// ---------- sticky section index for the long pages ----------
//
// sections: [{ id, label, count?, tone? }] — id is the target element's id.
export function sectionNavHtml(sections, { label = 'On this page' } = {}) {
  const items = sections.filter(Boolean);
  if (!items.length) return '';
  return `
    <nav class="ux-section-nav" aria-label="${escapeHtml(label)}">
      ${items.map(s => `
        <a class="ux-section-link ux-tone-${escapeHtml(s.tone || 'neutral')}" href="#${escapeHtml(s.id)}" data-ux-section="${escapeHtml(s.id)}">
          ${escapeHtml(s.label)}${s.count != null ? ` <span class="ux-section-count">${escapeHtml(String(s.count))}</span>` : ''}
        </a>`).join('')}
    </nav>`;
}

// Smooth-scroll the in-page links (a plain #hash would also move the router)
// and keep the current section highlighted.
export function wireSectionNav(root) {
  const nav = root?.querySelector?.('.ux-section-nav');
  if (!nav) return;
  nav.addEventListener('click', (ev) => {
    const a = ev.target.closest('[data-ux-section]');
    if (!a) return;
    ev.preventDefault();
    const target = root.ownerDocument.getElementById(a.dataset.uxSection);
    target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    target?.focus?.({ preventScroll: true });
  });
  if (typeof IntersectionObserver !== 'function') return;
  const links = [...nav.querySelectorAll('[data-ux-section]')];
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) continue;
      for (const l of links) l.classList.toggle('is-current', l.dataset.uxSection === e.target.id);
    }
  }, { rootMargin: '-30% 0px -60% 0px' });
  for (const l of links) {
    const t = root.ownerDocument.getElementById(l.dataset.uxSection);
    if (t) io.observe(t);
  }
}

// ---------- reference material, collapsed ----------

export function disclosureHtml(summary, bodyHtml, { open = false, cls = '' } = {}) {
  return `<details class="ux-disclosure${cls ? ` ${escapeHtml(cls)}` : ''}"${open ? ' open' : ''}><summary>${escapeHtml(summary)}</summary><div class="ux-disclosure-body">${bodyHtml}</div></details>`;
}

// ---------- status announcements ----------
//
// One persistent polite live region (index.html #ux-status) outside every
// re-rendered view, so scans, evaluations, compilation and deployment
// progress reach assistive technology once per change.
export function announce(message, doc = (typeof document !== 'undefined' ? document : null)) {
  const el = doc?.getElementById?.('ux-status');
  if (!el) return;
  el.textContent = '';
  // A separate task so a repeated message is still announced.
  setTimeout(() => { el.textContent = String(message ?? ''); }, 30);
}

// ---------- small grammar helpers ----------

export function plural(n, one, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`;
}

// "a, b and c"
export function listSentence(items) {
  const xs = items.filter(Boolean);
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`;
}

// ---------- who is here ----------

// A greeting name, or '' when the identity only carries a role or an
// address: "Welcome back, Admin" reads as a role label, not a greeting.
const ROLE_WORDS = new Set(['admin', 'administrator', 'root', 'user', 'operator', 'owner', 'guest', 'default', 'anonymous', 'system']);
export function personalName(identity) {
  const n = String(identity?.name ?? '').trim();
  if (!n || n.includes('@') || ROLE_WORDS.has(n.toLowerCase())) return '';
  const first = n.split(/\s+/)[0];
  return ROLE_WORDS.has(first.toLowerCase()) ? '' : first;
}

// ---------- the home screen's service list ----------

// When each service was last opened in this browser, from its stored JSON.
// A map with no prototype and only string values: a service keyed
// "constructor" must read as never opened, not as Object.prototype's function.
export function parseRecentServices(text) {
  const out = Object.create(null);
  let raw;
  try { raw = JSON.parse(text || '{}'); } catch { return out; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' && v) out[k] = v;
  return out;
}

// Most recently opened first, then by label. `opened` is a parseRecentServices map.
export function orderServicesByRecent(services, opened) {
  const at = (s) => (Object.hasOwn(opened || {}, s.key) && typeof opened[s.key] === 'string') ? opened[s.key] : '';
  return [...services].sort((a, b) => at(b).localeCompare(at(a)) || String(a.label).localeCompare(String(b.label)));
}

// ---------- which clauses pass only on a placeholder ----------

// A registration answer names the clauses that pass only on a placeholder
// (summary.onPlaceholder); the plain conformance report does not. Re-attach a
// remembered list to a refetched report only when it was worked out for the
// same environment — otherwise leave the report without it, and Conformance
// says it cannot tell which passes rest on placeholders.
export function withKnownPlaceholderPasses(conformance, known, env) {
  if (!conformance || Array.isArray(conformance.onPlaceholder)) return conformance;
  if (!known || !Array.isArray(known.onPlaceholder)) return conformance;
  if ((known.env || null) !== (env || null)) return conformance;
  return { ...conformance, onPlaceholder: known.onPlaceholder };
}
