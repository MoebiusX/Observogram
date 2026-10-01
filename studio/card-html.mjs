// studio/card-html.mjs
//
// The artefact card's inner HTML — one helper for every view that draws an
// adapter artefact as a `.card` grid tile (the Build stack), so the markup is
// written once: the head
// (id · unresolved-reference flag · version-gating chip · source pill), the
// title, the subtitle when the adapter gives one (an SLI's bound with its
// direction: '≤ 0.5 seconds', '≥ 2 consumers'), the one-line desc, the foot
// (tool · tags · an optional benchmark CTA). Pure: it reads no state and
// touches no DOM — the caller passes what
// it knows (the unresolved-reference count from its symbol table, the
// benchmark match from the lens catalogue) and owns the element, its
// classes (is-active, has-broken-refs, is-scaffold) and its click handling.
//
// Discover draws the same adapter artefacts (id for id) as readable ROWS
// instead (artefactRowHtml, the 2026-09 UX review): name + what it does +
// status first, the id, tool, tags and symbols one expansion away. The row
// keeps the card's `.card` / data-key / is-active / has-broken-refs /
// is-scaffold contract so the drawer highlights it the same way. Discover's
// View control draws that row at four degrees of detail (DISCOVER_VIEWS):
// the full row, the card (artefactCardHtml: the grid Discover drew before the
// review), or less still as a tile or a list line (artefactLightRowHtml).
// The pure pieces that row needs — the
// plain-language kind of an artefact, its status on the studio's four-property
// vocabulary, the Discover task filters, and the "Inferred from recording
// rule …" relationship — live here too so they stay testable headlessly.

import { escapeHtml } from './util.mjs';
import { statusChipHtml, statusRecord } from './ux-kit.mjs';

/**
 * artefactCardHtml(artefact, { broken, benchmark, tagLimit, note }) → the HTML inside a `.card`.
 *   broken     the number of unresolved references the caller found on this card (0: no flag)
 *   benchmark  { slug, refPackId, label } when a backend's product matches a reference pack (the CTA)
 *   tagLimit   how many tags the foot shows (Discover shows four)
 *   note       one short line in the foot the caller knows (Build: "customised: objective, query")
 *   titleButton  the title is a button (`.dv-row-main`), for a caller whose card is not itself one
 *                (Discover's Cards view: the keyboard's way to open the full record)
 */
export function artefactCardHtml(artefact, { broken = 0, benchmark = null, tagLimit = 4, note = null, titleButton = false } = {}) {
  const tags = (artefact.tags || []).slice(0, tagLimit).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`).join('');

  // Version-gating chip for backend artefacts.
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}" title="version: ${escapeHtml(artefact.spec.version.declared || '?')} · gating: ${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  const brokenIndicator = broken
    ? `<span class="ref-indicator" title="${broken} unresolved reference(s)">⚠</span>`
    : '';

  // Benchmark CTA — from a backend card, one click to "how does my X compare
  // to best practice?" (the caller decides whether this artefact has one).
  const benchmarkCta = benchmark
    ? `<button type="button" class="benchmark-cta"
      data-product="${escapeHtml(benchmark.slug)}"
      data-ref-pack="${escapeHtml(benchmark.refPackId)}"
      title="Compare your ${escapeHtml(benchmark.label)} posture against the catalogue reference pack."
    >⛯ Benchmark vs ${escapeHtml(benchmark.label)} →</button>`
    : '';

  return `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${brokenIndicator}
      ${gatingChip}
      <span class="card-source" data-source="${escapeHtml(artefact.source || 'Declared')}">${escapeHtml(artefact.source || 'Declared')}</span>
    </div>
    ${titleButton
    ? `<button type="button" class="card-title dv-row-main" title="Open the full record">${escapeHtml(artefact.title || artefact.id)}</button>`
    : `<div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>`}
    ${artefact.subtitle ? `<div class="card-sub">${escapeHtml(artefact.subtitle)}</div>` : ''}
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot">
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
      ${tags}
      ${benchmarkCta}
      ${note ? `<span class="card-note">${escapeHtml(note)}</span>` : ''}
    </div>
  `;
}

// ---------- the Discover row ----------

// What an artefact IS, in plain words, by the adapter's id family
// (tools/lib/adapter.mjs). Order matters: the longer prefixes first.
// `role` is the one-line "what it does" when the adapter's desc says nothing
// more useful.
export const ARTEFACT_KINDS = [
  ['SLI-',        'Service level indicator',      'Measures how the service behaves.'],
  ['SLO-',        'Objective',                    'Sets the target an indicator must meet over a window.'],
  ['OTEL-',       'Instrumentation contract',     'Sets how the service emits traces, metrics and logs.'],
  ['BAK-',        'Telemetry backend',            'Stores and serves one kind of signal.'],
  ['PIP-RCV-',    'Pipeline receiver',            'Accepts signals into the collector.'],
  ['PIP-PRC-',    'Pipeline processor',           'Transforms signals on their way through the collector.'],
  ['PIP-EXP-',    'Pipeline exporter',            'Sends signals from the collector to a backend.'],
  ['STO-',        'Storage',                      'Keeps one kind of signal for a retention period.'],
  ['METRIC-SRC-', 'Metric defined in the code',   'A metric the service repository defines.'],
  ['SCRAPE-SRC-', 'Scrape job in the repository', 'A collection job the repository configures.'],
  ['SCRAPE-',     'Live scrape job',              'A collection job the live platform runs.'],
  ['METRIC-',     'Live metric',                  'A metric the live platform reports.'],
  ['PROF-',       'Profiling',                    'Collects continuous profiles.'],
  ['NET-',        'Network telemetry',            'Observes network flows.'],
  ['POE-',        'Policy engine',                'Enforces telemetry policy.'],
  ['MESH-',       'Service mesh telemetry',       'Emits telemetry from the service mesh.'],
  ['COL-',        'Collection',                   'Collects an additional signal source.'],
  ['QRY-',        'Recording rule',               'Precomputes a query so dashboards and alerts read it cheaply.'],
  ['VIEW-',       'Derived view',                 'A named query other artefacts bind to.'],
  ['DASH-',       'Dashboard',                    'Shows the signals to people.'],
  ['PANEL-',      'Dashboard panel',              'One chart on a dashboard.'],
  ['POL-',        'Burn-rate alert',              'Warns when an objective burns its error budget too fast.'],
  ['FCST-',       'Forecast',                     'Predicts when a budget or capacity runs out.'],
  ['ALR-',        'Alert route',                  'Sends alerts of one severity to the people who act on them.'],
  ['HEAL-',       'Self-healing action',          'Runs a remediation when an alert fires.'],
  ['BASE-',       'Baselines',                    'Records normal behaviour to compare against.'],
  ['CHAOS-',      'Chaos experiment',             'Breaks something on purpose to prove the alerts fire.'],
  ['SYN-',        'Synthetic check',              'Probes the service the way a user would.'],
  ['IMP-',        'Import',                       'Reuses a shared definition from another pack.'],
];

export function artefactKind(artefact) {
  const id = String(artefact?.id ?? '');
  const hit = ARTEFACT_KINDS.find(([prefix]) => id.startsWith(prefix));
  return hit
    ? { kind: hit[1], role: hit[2] }
    : { kind: artefact?.tool ? String(artefact.tool) : 'Artefact', role: '' };
}

// An artefact on the four-property vocabulary (studio/ux-kit.mjs): the
// adapter's one `source` word answers two different questions, so it is split.
//   Verified -> evidence: live          Declared -> evidence: declared
//   Scaffold -> completion: needsInput
// The adapter emits only those three (tools/lib/adapter.mjs). 'Missing' maps
// to evidence: missing only to keep the shared vocabulary total (the Model
// view's clause ghosts use that word); no artefact carries it, so Discover
// never counts or lists one. Something the pack lacks is a required check not
// met, reported by the tier rubric, never a detected artefact.
// `attention` marks an artefact a person must act on: a template value to
// complete or a reference that does not resolve. Evidence alone never makes
// it one — a repository pack is declared-only by nature.
export function artefactStatus(artefact, { broken = 0 } = {}) {
  const src = String(artefact?.source || 'Declared');
  const scaffold = src === 'Scaffold';
  const missing = src === 'Missing';
  const live = src === 'Verified';
  const nBroken = broken || 0;
  return {
    source: src,
    evidence: live ? 'live' : missing ? 'missing' : scaffold ? null : 'declared',
    completion: scaffold ? 'needsInput' : null,
    broken: nBroken,
    live,
    attention: scaffold || nBroken > 0,
  };
}

// "Inferred from recording rule slo:x:ratio_5m." — the live fetcher's SLI
// inference (tools/lib/sli-inference.mjs) writes the rule(s) it read into the
// description. Returns the rule names, or null when the artefact was not
// inferred. The inference now names every rule in full; packs fetched before
// that wrote a good/total pair as the shorthand `a:b:good/total`, which still
// expands to its two members, `a:b:good` and `a:b:total` (stems, not rule
// names — see resolveInferredRule), so those older packs keep resolving.
const INFERRED_RE = /^\s*Inferred from recording rules?\s+(.+?)\.?\s*$/i;
export function inferredFrom(artefact) {
  const text = String(artefact?.spec?.description ?? artefact?.desc ?? '');
  const m = INFERRED_RE.exec(text);
  if (!m) return null;
  const rules = [];
  for (const raw of m[1].split(/\s+and\s+/)) {
    const part = raw.trim();
    const pair = /^(.*:)([^:/]+)\/([^:/]+)$/.exec(part);
    if (pair) rules.push(`${pair[1]}${pair[2]}`, `${pair[1]}${pair[3]}`);
    else if (part) rules.push(part);
  }
  return rules.length ? { sentence: text.trim(), rules } : null;
}

// The recording rule, among `ruleNames`, that an inferredFrom() name stands for,
// or null. An exact name wins. Fallback for packs fetched before
// tools/lib/sli-inference.mjs named both rules of a good/total pair: those wrote
// the shorthand `a:b:good/total`, while the rules themselves are
// `a:b:good_<window>` and `a:b:total_<window>` (the inference reads the pair
// only from those), so a `…:good` or `…:total` stem resolves to the first rule
// named `<stem>_…`, the one the inference read.
export function resolveInferredRule(name, ruleNames) {
  const names = [...(ruleNames || [])].filter(n => typeof n === 'string' && n);
  if (names.includes(name)) return name;
  if (!/:(good|total)$/.test(String(name || ''))) return null;
  return names.find(n => n.startsWith(`${name}_`)) || null;
}

// Discover's View control: four degrees of detail over the same artefacts,
// least first. Details is the full row (artefactRowHtml as the review drew it)
// and the default; the others show less of each artefact so more of a layer
// fits on one screen. Cards is the card grid Discover drew before the review
// (artefactCardHtml, the card the Build stack still draws): the id and the
// adapter's source word on its face. `cap` is how many artefacts an open
// layer draws before "Show all N": a lighter view draws more.
export const DISCOVER_VIEWS = [
  { id: 'list',    label: 'List',    cap: 480,
    tip: 'The name and a status mark only: the most artefacts on one screen.' },
  { id: 'tiles',   label: 'Tiles',   cap: 180,
    tip: 'The name with its kind, bound and status.' },
  { id: 'cards',   label: 'Cards',   cap: 120,
    tip: 'The earlier card grid: ID, source, name, bound, summary, type and tags on each card.' },
  { id: 'details', label: 'Details', cap: 60,
    tip: 'Everything: what each artefact does, what it was inferred from, and its ID, tags and references.' },
];
export const DISCOVER_VIEW_DEFAULT = 'details';

// The view for an id; anything unknown (a stale persisted value) is Details.
export function discoverView(id) {
  return DISCOVER_VIEWS.find(v => v.id === id) || DISCOVER_VIEWS.find(v => v.id === DISCOVER_VIEW_DEFAULT);
}

// The status chips a Discover row shows: only the properties that apply.
// `short` (the Tiles view) keeps each chip to a word or two; the tooltip
// carries the full meaning either way.
const SHORT_EVIDENCE = { live: 'Live', declared: 'Declared' };
export function artefactStatusChipsHtml(status, { liveWhen = '', short = false } = {}) {
  const chips = [];
  if (status.completion === 'needsInput') {
    chips.push(statusChipHtml('completion', 'needsInput', { label: 'Template value' }));
  }
  if (status.evidence) {
    const opts = liveWhen && status.evidence === 'live' ? { extraTip: `Last seen live: ${liveWhen}.` } : {};
    if (short && SHORT_EVIDENCE[status.evidence]) opts.label = SHORT_EVIDENCE[status.evidence];
    chips.push(statusChipHtml('evidence', status.evidence, opts));
  }
  if (status.broken) {
    chips.push(statusChipHtml('assessment', 'fail', {
      label: short ? `${status.broken} unresolved` : `${status.broken} unresolved reference${status.broken === 1 ? '' : 's'}`,
      extraTip: 'It names another artefact this pack does not define, so the chain between them is broken.',
    }));
  }
  return chips.join(' ');
}

// The List view has no room for chips, so each artefact's status is one mark
// and the same words as the chips, for the tooltip, the legend and assistive
// technology. The mark's shape builds on the chip vocabulary (studio/ux.css):
// evidence stays a dot and a failed assessment a cross, as on the chips; the
// mark's own are filled = live / hollow = declared only, and a dashed box for
// a template value (the dashed frame such a row has) — so colour is never the
// only cue. One mark per artefact: what a person must act on wins.
export const STATUS_MARKS = [
  { id: 'broken',     label: 'Unresolved reference' },
  { id: 'needsInput', label: 'Template value' },
  { id: 'live',       label: statusRecord('evidence', 'live').label },
  { id: 'declared',   label: statusRecord('evidence', 'declared').label },
  { id: 'missing',    label: statusRecord('evidence', 'missing').label },
];

export function artefactStatusMark(status) {
  if (status?.broken) return 'broken';
  if (status?.completion === 'needsInput') return 'needsInput';
  return status?.evidence || 'declared';
}

export function statusMarkHtml(mark) {
  return `<span class="dv-mark dv-mark-${escapeHtml(mark)}" aria-hidden="true"></span>`;
}

export function artefactStatusWords(status) {
  const words = [];
  if (status?.completion === 'needsInput') words.push('Template value');
  if (status?.evidence) words.push(statusRecord('evidence', status.evidence)?.label);
  if (status?.broken) words.push(`${status.broken} unresolved reference${status.broken === 1 ? '' : 's'}`);
  return words.filter(Boolean);
}

// Adapter summaries that only restate what the kind already says.
const GENERIC_DESC = /^(otel collector (receiver|processor|exporter)|recording rule\b|derived view$|live scrape job|declared metric$|\w+ sli$|vertical composition import$)/;

function liveWhenOf(artefact) {
  const m = artefact?.mcp;
  if (!m) return '';
  if (typeof m === 'string') return m;
  return m.when ? String(m.when) : '';
}

/**
 * artefactRowHtml(artefact, opts) → the HTML inside Discover's `.dv-row`.
 *   broken         the unresolved-reference count the caller found (symbol table)
 *   benchmark      { slug, refPackId, label }: the benchmark CTA, as on the card
 *   rules          [{ name, found }]: the inferred-from recording rules, resolved
 *                  against the pack by the caller; a found rule is a button
 *                  that opens it (data-dv-rule="<name>"), found:false says it
 *                  is not in the pack, and without `rules` nothing was checked
 *   outsideFilter  true when the row shows only because it is open in the
 *                  detail panel, not because it matches the current filter
 *   view           'details' (the default: the full row), 'cards', 'tiles' or
 *                  'list' (DISCOVER_VIEWS): the same artefact with less of it drawn
 * Name, what it does and status lead; id, type, tags and symbols sit in the
 * row's Details. Tiles and List are artefactLightRowHtml; Cards is the card
 * body (artefactCardHtml) with its title as the button that opens the record.
 */
export function artefactRowHtml(artefact, { broken = 0, benchmark = null, rules = null, outsideFilter = false, view = DISCOVER_VIEW_DEFAULT } = {}) {
  if (view === 'tiles' || view === 'list') return artefactLightRowHtml(artefact, { broken, outsideFilter, view });
  if (view === 'cards') {
    return artefactCardHtml(artefact || {}, { broken, benchmark, titleButton: true, note: outsideFilter ? 'Open in the detail panel · outside this filter' : null });
  }
  const a = artefact || {};
  const { kind, role } = artefactKind(a);
  const status = artefactStatus(a, { broken });
  const inference = inferredFrom(a);
  const name = a.title || a.id;
  const desc = String(a.desc || '').trim();
  // What it does: a description a person wrote (the canonical item's own
  // `description`), else the kind's plain role. The adapter's generated
  // summary ('99% over 30d (SLI: x)', '1 channel(s): webhook') follows as a
  // quieter spec line unless it only repeats the kind. An inference sentence
  // is provenance, not a description: it becomes the source line below.
  const authored = !inference && !!desc && desc === String(a.spec?.description ?? '').trim();
  const what = authored ? desc : (role || desc);
  const low = desc.toLowerCase();
  const repeatsKind = !desc || !!inference || desc === what
    || low.startsWith(kind.toLowerCase()) || GENERIC_DESC.test(low);
  const specLine = repeatsKind ? '' : desc;
  const resolved = rules || (inference ? inference.rules.map(n => ({ name: n, found: null })) : []);

  const ruleHtml = (r) => r.found
    ? `<button type="button" class="dv-rule-link" data-dv-rule="${escapeHtml(r.name)}" title="Open this recording rule"><code>${escapeHtml(r.name)}</code></button>`
    : r.found === false
      ? `<code class="dv-rule-missing" title="No recording rule of this name is in this pack">${escapeHtml(r.name)}</code>`
      : `<code class="dv-rule-missing">${escapeHtml(r.name)}</code>`;
  const one = resolved.length === 1;
  const those = one ? 'that rule' : 'those rules';
  // What the inference establishes depends on the evidence: never more than
  // the rule's own status (a declared rule is not a produced series) and
  // nothing at all about a rule this pack does not hold.
  const notFound = resolved.filter(r => r.found === false).length;
  const why = notFound
    ? (notFound === resolved.length
      ? `${one ? 'That rule is' : 'Those rules are'} not in this pack, so the query cannot be traced to ${one ? 'it' : 'them'} here.`
      : `${notFound} of those rules ${notFound === 1 ? 'is' : 'are'} not in this pack, so the query cannot be fully traced here.`)
    : status.live
      ? `Its query comes from ${those}, which the live platform reported when the pack was drafted or refreshed.`
      : `Its query comes from ${those} as declared in the pack; nothing live has confirmed that ${one ? 'it runs' : 'they run'} or that the series ${one ? 'has' : 'have'} data.`;
  const sourceLine = inference ? `
    <p class="dv-row-source">
      <span class="dv-row-source-what">Inferred from recording rule${one ? '' : 's'} ${resolved.map(ruleHtml).join(' and ')}.</span>
      <span class="dv-row-source-why">${escapeHtml(why)} The target and threshold are defaults until someone sets them.</span>
    </p>` : '';

  const gating = (/^BAK-/.test(a.id || '') && a.spec?.version?.gating)
    ? `<dt>Version gating</dt><dd>${escapeHtml(a.spec.version.gating)}${a.spec.version.declared ? ` · declared ${escapeHtml(a.spec.version.declared)}` : ''}</dd>` : '';
  const liveWhen = liveWhenOf(a);
  const details = `
      <details class="dv-row-details">
        <summary>Details</summary>
        <dl>
          <dt>ID</dt><dd class="dv-mono">${escapeHtml(a.id || '—')}</dd>
          ${a.tool ? `<dt>Type</dt><dd>${escapeHtml(a.tool)}</dd>` : ''}
          <dt>Source</dt><dd>${escapeHtml(status.source)}</dd>
          ${liveWhen ? `<dt>Last seen live</dt><dd>${escapeHtml(liveWhen)}</dd>` : ''}
          ${a.defines ? `<dt>Defines</dt><dd class="dv-mono">${escapeHtml(a.defines)}</dd>` : ''}
          ${a.refs?.length ? `<dt>References</dt><dd class="dv-mono">${a.refs.map(escapeHtml).join(', ')}</dd>` : ''}
          ${gating}
          ${a.tags?.length ? `<dt>Tags</dt><dd class="dv-tags">${a.tags.map(t => `<span class="tag">${escapeHtml(t)}</span>`).join('')}</dd>` : ''}
          ${desc && desc !== what && !specLine ? `<dt>Summary</dt><dd>${escapeHtml(desc)}</dd>` : ''}
        </dl>
        <p class="dv-row-details-hint">Select the name to open the full record, including its canonical source.</p>
      </details>`;

  const benchmarkCta = benchmark
    ? `<button type="button" class="benchmark-cta"
      data-product="${escapeHtml(benchmark.slug)}"
      data-ref-pack="${escapeHtml(benchmark.refPackId)}"
      title="Compare your ${escapeHtml(benchmark.label)} posture against the catalogue reference pack."
    >Benchmark vs ${escapeHtml(benchmark.label)} →</button>`
    : '';

  return `
    <div class="dv-row-head">
      <button type="button" class="dv-row-main" title="Open the full record">
        <span class="dv-row-kind">${escapeHtml(kind)}</span>
        <span class="dv-row-name">${escapeHtml(name)}</span>
        ${a.subtitle ? `<span class="dv-row-bound">${escapeHtml(a.subtitle)}</span>` : ''}
      </button>
      <span class="dv-row-status">${artefactStatusChipsHtml(status, { liveWhen })}</span>
    </div>
    ${what ? `<p class="dv-row-what">${escapeHtml(what)}</p>` : ''}
    ${specLine ? `<p class="dv-row-spec">${escapeHtml(specLine)}</p>` : ''}
    ${sourceLine}
    <div class="dv-row-foot">
      ${details}
      ${benchmarkCta}
      ${outsideFilter ? `<span class="dv-row-pinned" title="${PINNED_TIP}">Open in the detail panel · outside this filter</span>` : ''}
    </div>
  `;
}

const PINNED_TIP = 'Shown because it is open in the detail panel; the current filter would hide it.';

// A name set in a narrow column: a break opportunity after each separator, so
// 'genai_client_operation_duration' wraps at a word, not mid-word. A number
// stays whole: no break between two digits ('1.27.0', '12:30') or after a
// leading minus ('-5').
function breakableHtml(text) {
  return escapeHtml(text).replace(/([_:./-])(?=\S)/g, (m, sep, i, s) => {
    const before = s[i - 1] || '';
    const inNumber = /\d/.test(s[i + 1]) && (/\d/.test(before) || (sep === '-' && (!before || /\s/.test(before))));
    return inNumber ? sep : `${sep}<wbr>`;
  });
}

/**
 * artefactLightRowHtml(artefact, { broken, outsideFilter, view }) → the HTML
 * inside a `.dv-row` on Discover's two lightest views, Tiles and List
 * (DISCOVER_VIEWS; Cards is artefactCardHtml, through artefactRowHtml): the
 * same artefact as artefactRowHtml, with less of it drawn.
 *   tiles  the name, then its kind and bound, with the status chips (short
 *          labels; the tooltip keeps the meaning)
 *   list   the name and one status mark; kind, bound and status in words are
 *          the tooltip and the text assistive technology reads
 * Both are one `.dv-row-main` button that opens the full record, as the full
 * row's name does; what the row leaves out is there.
 */
export function artefactLightRowHtml(artefact, { broken = 0, outsideFilter = false, view = 'tiles' } = {}) {
  const a = artefact || {};
  const { kind } = artefactKind(a);
  const status = artefactStatus(a, { broken });
  const name = a.title || a.id;

  if (view === 'list') {
    const words = [kind, a.subtitle, ...artefactStatusWords(status), outsideFilter ? 'Open in the detail panel, outside this filter' : '']
      .filter(Boolean);
    return `
    <button type="button" class="dv-row-main">
      <span class="dv-row-line" title="${escapeHtml(words.join(' · '))}">
        ${statusMarkHtml(artefactStatusMark(status))}
        <span class="dv-row-name">${breakableHtml(name)}</span>
      </span>
      <span class="sr-text">${escapeHtml(`${words.join('. ')}.`)}</span>
    </button>
  `;
  }

  return `
    <button type="button" class="dv-row-main" title="Open the full record">
      <span class="dv-row-name">${breakableHtml(name)}</span>
      <span class="dv-row-meta">
        <span class="dv-row-kind">${escapeHtml(kind)}</span>
        ${a.subtitle ? `<span class="dv-row-bound">${escapeHtml(a.subtitle)}</span>` : ''}
      </span>
      <span class="dv-row-status">${artefactStatusChipsHtml(status, { liveWhen: liveWhenOf(a), short: true })}</span>
    </button>
    ${outsideFilter ? `<span class="dv-row-pinned" title="${PINNED_TIP}">Open in the detail panel · outside this filter</span>` : ''}
  `;
}
