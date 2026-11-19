// A service's operational agreement, as the studio keeps it, and what of it the repository covers.
//
// The stage before the repository: agreement → repository → each environment. The grade says how a
// live environment represents the repository's model; this says how the repository's model covers
// what was promised. It never feeds a letter, and nothing here is a score: a commitment is covered,
// covered in part, or not covered, by what it is linked to and whether the repository declares it.
//
// Kept per service as { versions: [{ source: { document, version, effective }, commitments: [...],
// by, at }] } (the server's schema_meta key agreement:<org>:<service>), newest last. A version is the
// agreement as one issue of its source document states it; saving under another document, version or
// effective date adds a version, saving under the same one corrects it in place.
//
// A commitment: { id, clause, text, target, owner, links }.
//   target  what was promised, kept as written ("99.9% per calendar month, excluding planned
//           maintenance"): text, never parsed, never checked against an SLO's limits.
//   owner   'service' (this service answers for it), 'consumer' (the consuming team does: it needs
//           to be visible here, no more) or 'both'.
//   weight  how much it counts beside the others, 1 to 100 (1 when not said). Nothing here adds
//           weights up: a scorer does.
//   links   [{ kind, name }] — anything the repository can declare (LINK_KINDS), or none.
// Zero-import, so the server and every studio copy read the same rules.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v) => (typeof v === 'string' ? v.trim() : '');
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** What a commitment can be linked to: the kinds a repository's pack declares, as the studio names them. */
export const LINK_KINDS = Object.freeze([
  Object.freeze({ kind: 'slo', label: 'Objective', many: 'objectives' }),
  Object.freeze({ kind: 'indicator', label: 'Indicator', many: 'indicators' }),
  Object.freeze({ kind: 'alert', label: 'Alert rule', many: 'alert rules' }),
  Object.freeze({ kind: 'burn_alert', label: 'Burn-rate alert', many: 'burn-rate alerts' }),
  Object.freeze({ kind: 'recording_rule', label: 'Recording rule', many: 'recording rules' }),
  Object.freeze({ kind: 'dashboard', label: 'Dashboard', many: 'dashboards' }),
  Object.freeze({ kind: 'metric', label: 'Metric', many: 'metrics' }),
  Object.freeze({ kind: 'exporter', label: 'Exporter', many: 'exporters' }),
]);
const KINDS = new Set(LINK_KINDS.map((k) => k.kind));
export const linkKindLabel = (kind) => LINK_KINDS.find((k) => k.kind === kind)?.label || String(kind || '');

export const AGREEMENT_OWNERS = Object.freeze(['service', 'consumer', 'both']);
export const WEIGHT_MAX = 100;
const ownerOf = (c) => (c?.owner === 'consumer' ? 'consumer' : c?.owner === 'both' ? 'both' : 'service');
const weightOf = (c) => (Number.isInteger(c?.weight) && c.weight >= 1 && c.weight <= WEIGHT_MAX ? c.weight : 1);
export const AGREEMENT_VERSIONS_MAX = 20;
export const COMMITMENTS_MAX = 200;
export const LINKS_MAX = 20;
const MAX = Object.freeze({ document: 200, version: 40, clause: 80, text: 500, target: 300, name: 200 });
const ID_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const realDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
const line = (v, max) => { const t = text(v); return t && t.length <= max && !CONTROL.test(t) ? t : null; };

/**
 * Why `v` is not an agreement as a client sends it ({ source: { document, version, effective },
 * commitments: [...] }): a list of reasons, empty when it is. null (no agreement) is.
 */
export function agreementErrors(v) {
  if (v === null) return [];
  if (!isObj(v) || !isObj(v.source) || !Array.isArray(v.commitments)) return ['agreement is { source: { document, version, effective }, commitments: [...] } or null'];
  const errors = [];
  for (const k of Object.keys(v)) if (!['source', 'commitments'].includes(k)) errors.push(`${k} is not an agreement field`);
  for (const k of Object.keys(v.source)) if (!['document', 'version', 'effective'].includes(k)) errors.push(`source.${k} is not a source field`);
  if (line(v.source.document, MAX.document) === null) errors.push(`source.document names the document the agreement is written in (1 to ${MAX.document} characters on one line)`);
  if (line(v.source.version, MAX.version) === null) errors.push(`source.version is that document's version (1 to ${MAX.version} characters on one line)`);
  if (typeof v.source.effective !== 'string' || !realDate(v.source.effective)) errors.push('source.effective is the day it comes into force, as YYYY-MM-DD');
  if (v.commitments.length > COMMITMENTS_MAX) errors.push(`more than ${COMMITMENTS_MAX} commitments`);
  const seen = new Set();
  v.commitments.slice(0, COMMITMENTS_MAX).forEach((c, i) => {
    const at = `commitments[${i}]`;
    if (!isObj(c)) { errors.push(`${at} is not { id, clause, text, target, owner, links }`); return; }
    for (const k of Object.keys(c)) if (!['id', 'clause', 'text', 'target', 'owner', 'weight', 'links'].includes(k)) errors.push(`${at}.${k} is not a commitment field`);
    if (c.weight !== undefined && !(Number.isInteger(c.weight) && c.weight >= 1 && c.weight <= WEIGHT_MAX)) errors.push(`${at}.weight is a whole number from 1 to ${WEIGHT_MAX}`);
    if (typeof c.id !== 'string' || !ID_RE.test(c.id)) errors.push(`${at}.id is a short id (lower-case letters, digits, _ . -, at most 64)`);
    else if (seen.has(c.id)) errors.push(`${at}.id ${JSON.stringify(c.id)} is used twice`);
    else seen.add(c.id);
    if (c.clause !== undefined && c.clause !== '' && line(c.clause, MAX.clause) === null) errors.push(`${at}.clause is where the document says it (at most ${MAX.clause} characters on one line)`);
    if (line(c.text, MAX.text) === null) errors.push(`${at}.text says what is promised (1 to ${MAX.text} characters on one line)`);
    if (c.target !== undefined && c.target !== '' && line(c.target, MAX.target) === null) errors.push(`${at}.target is the target as written (at most ${MAX.target} characters on one line)`);
    if (c.owner !== undefined && !AGREEMENT_OWNERS.includes(c.owner)) errors.push(`${at}.owner is one of ${AGREEMENT_OWNERS.join(', ')}`);
    if (c.links !== undefined && !Array.isArray(c.links)) { errors.push(`${at}.links is a list of { kind, name }`); return; }
    if ((c.links || []).length > LINKS_MAX) errors.push(`${at}: more than ${LINKS_MAX} links`);
    (c.links || []).slice(0, LINKS_MAX).forEach((l, j) => {
      if (!isObj(l) || !KINDS.has(l.kind) || line(l.name, MAX.name) === null) errors.push(`${at}.links[${j}] is { kind, name } with kind one of ${[...KINDS].join(', ')}`);
    });
  });
  return errors;
}

const cleanCommitment = (c) => {
  const links = [];
  for (const l of Array.isArray(c.links) ? c.links : []) {
    const name = text(l.name);
    if (!links.some((x) => x.kind === l.kind && x.name === name)) links.push({ kind: l.kind, name });
  }
  // A weight of 1 is not written: a version saved before weights reads the same as one saved after.
  return { id: c.id, clause: text(c.clause), text: text(c.text), target: text(c.target), owner: ownerOf(c), ...(weightOf(c) > 1 ? { weight: weightOf(c) } : {}), links };
};
const contentKey = (v) => JSON.stringify([v?.source?.document, v?.source?.version, v?.source?.effective, (v?.commitments || []).map((c) => [c.id, c.clause, c.text, c.target, ownerOf(c), weightOf(c), (c.links || []).map((l) => [l.kind, l.name])])]);
const sameSource = (a, b) => !!a && !!b && a.document === b.document && a.version === b.version && a.effective === b.effective;

/** The version of an agreement that is the service's now: the newest, or null. */
export function agreementCurrent(record) {
  const versions = isObj(record) && Array.isArray(record.versions) ? record.versions : [];
  return versions.length && isObj(versions[versions.length - 1]) ? versions[versions.length - 1] : null;
}

/**
 * The record to keep after `v` (already through agreementErrors) is saved over `current`, or null
 * when `v` is null. The same source as the newest version corrects that version (who and when are
 * kept when nothing in it changed); another source adds a version, the oldest dropped past the cap.
 */
export function agreementRecord(v, { current = null, actor = null, now = null } = {}) {
  if (v === null || v === undefined) return null;
  const next = {
    source: { document: text(v.source.document), version: text(v.source.version), effective: v.source.effective },
    commitments: v.commitments.map(cleanCommitment),
  };
  const versions = isObj(current) && Array.isArray(current.versions) ? current.versions.filter(isObj) : [];
  const last = versions[versions.length - 1] || null;
  const signed = { ...next, by: typeof actor === 'string' && actor ? actor : null, at: typeof now === 'string' && now ? now : null };
  if (last && sameSource(last.source, next.source)) {
    const kept = contentKey(last) === contentKey(next) ? { ...next, by: last.by ?? null, at: last.at ?? null } : signed;
    return { versions: [...versions.slice(0, -1), kept] };
  }
  return { versions: [...versions, signed].slice(-AGREEMENT_VERSIONS_MAX) };
}

/** Two agreements whose current versions say the same (who and when aside). */
export const sameAgreement = (a, b) => {
  const [x, y] = [agreementCurrent(a), agreementCurrent(b)];
  return (!x && !y) || (!!x && !!y && contentKey(x) === contentKey(y));
};

/** A stored record that does not read: why, or ''. */
export function storedAgreementError(record) {
  if (!isObj(record) || !Array.isArray(record.versions) || !record.versions.length) return 'it is not { versions: [...] }';
  for (const v of record.versions) {
    if (!isObj(v)) return 'a version is not an object';
    const errors = agreementErrors({ source: v.source, commitments: v.commitments });
    if (errors.length) return errors[0];
  }
  return '';
}

// ---------- what the repository declares ----------

const stripRef = (s) => String(s ?? '').replace(/^ref:[a-z_]+\./, '').replace(/^ref:/, '');
// A layered artefact's kind and name as a commitment links to it, by the id the adapter gives it.
const PREFIX_KIND = [
  [/^SLO-/, 'slo'], [/^SLI-/, 'indicator'], [/^RULE-/, 'alert'], [/^POL-/, 'burn_alert'], [/^QRY-/, 'recording_rule'],
  [/^DASH-/, 'dashboard'], [/^METRIC-/, 'metric'], [/^SCRAPE-/, 'exporter'],
];
const severitiesOf = (a) => [...new Set((Array.isArray(a.spec?.windows) ? a.spec.windows : []).map((w) => String(w?.severity || '')).filter(Boolean))];
// The scan's own words for an indicator it inferred, and its default objective (studio/diagnostic-grade.mjs
// sloObjectiveGuessed, restated: this module imports nothing).
const GUESSED_WORDS = /^(Inferred from recording rule|Auto-derived from burn-rate alert|Stub SLI)/;
function objectiveSourceOf(layered, slo, sli) {
  const ann = isObj(layered?.meta?.annotations) ? layered.meta.annotations : {};
  const id = String(slo.spec?.id ?? slo.title ?? '');
  const marked = ann[`crawler.scaffold.slos.${id}.objective`] !== undefined || ann[`crawler.scaffold.slos.${id}`] !== undefined;
  const guessed = slo.source === 'Scaffold' || (marked && slo.spec?.objective === 0.99)
    || (ann['crawler.guessMarks'] === undefined && slo.spec?.objective === 0.99 && slo.spec?.window === '30d' && GUESSED_WORDS.test(String(sli?.spec?.description || '')));
  if (!guessed) return 'repository';
  const stated = isObj(layered?.meta?.studioObjectives) ? layered.meta.studioObjectives[id] : null;
  return isObj(stated) && typeof stated.objective === 'number' ? 'studio' : 'guessed';
}
const nameOf = (kind, a) => (kind === 'burn_alert' ? stripRef(a.spec?.slo) || String(a.title || '').replace(/^burn-rate alert:\s*/, '') : String(a.title ?? ''));

/**
 * What a repository's pack declares that a commitment can be linked to:
 * [{ kind, name, guessed }] — `guessed` for an artefact the scan invented (its source is the scan's
 * placeholder), which covers nothing. Each once, in the pack's order.
 */
export function agreementCatalogue(layered) {
  const out = [];
  const seen = new Set();
  const layers = isObj(layered?.layers) ? layered.layers : {};
  const all = [];
  for (const value of Object.values(layers)) {
    const list = Array.isArray(value) ? value : isObj(value) ? Object.values(value).flat() : [];
    for (const a of list) if (isObj(a) && typeof a.id === 'string') all.push(a);
  }
  // What stands behind an objective or an indicator, by the references the pack's artefacts carry.
  const refsTo = (symbol) => all.filter((a) => Array.isArray(a.refs) && a.refs.some((r) => String(r).replace(/^ref:/, '') === symbol));
  const dashboardsOf = (symbols) => [...new Set(symbols.flatMap(refsTo).filter((a) => /^(DASH|PANEL)-/.test(a.id)).map((a) => (/^PANEL-/.test(a.id) ? String(a.parent || a.title) : String(a.title))))].length;
  const seriesOf = (sli) => !!sli && ['good', 'total', 'query', 'bad'].some((k) => typeof sli.spec?.[k] === 'string' && sli.spec[k].trim());
  const sliByName = new Map(all.filter((a) => /^SLI-/.test(a.id)).map((a) => [String(a.title), a]));
  for (const a of all) {
    const kind = PREFIX_KIND.find(([re]) => re.test(a.id))?.[1];
    if (!kind || /^METRIC-FAM-/.test(a.id)) continue;
    const name = nameOf(kind, a).trim();
    const key = `${kind}\u0000${name}`;
    if (!name || seen.has(key)) continue;
    seen.add(key);
    const entry = { kind, name, guessed: a.source === 'Scaffold' };
    if (kind === 'slo') {
      const indicator = stripRef(a.spec?.sli);
      const sli = sliByName.get(indicator) || null;
      const burn = refsTo(`slos.${name}`).filter((x) => /^POL-/.test(x.id));
      Object.assign(entry, {
        indicator: sli ? indicator : '', measured: seriesOf(sli),
        objective: typeof a.spec?.objective === 'number' ? a.spec.objective : null, window: typeof a.spec?.window === 'string' ? a.spec.window : '',
        objectiveSource: objectiveSourceOf(layered, a, sli),
        // The severities its burn-rate alert pages at; null when the repository declares none for it.
        burn: burn.length ? [...new Set(burn.flatMap(severitiesOf))] : null,
        dashboards: dashboardsOf([`slos.${name}`, ...(sli ? [`slis.${indicator}`] : [])]),
      });
    } else if (kind === 'indicator') {
      Object.assign(entry, { measured: seriesOf(a), dashboards: dashboardsOf([`slis.${name}`]) });
    } else if (kind === 'burn_alert') {
      Object.assign(entry, { severities: severitiesOf(a) });
    } else if (kind === 'alert') {
      const severity = String(a.spec?.severity || a.spec?.labels?.severity || '');
      Object.assign(entry, { severities: severity ? [severity] : [] });
    }
    out.push(entry);
  }
  return out;
}

/** The severities the repository routes somewhere (an alert route with a channel), as agreementCatalogue's companion. */
export function agreementRoutes(layered) {
  const layers = isObj(layered?.layers) ? layered.layers : {};
  const out = new Set();
  for (const value of Object.values(layers)) {
    const list = Array.isArray(value) ? value : isObj(value) ? Object.values(value).flat() : [];
    for (const a of list) {
      if (isObj(a) && /^ALR-/.test(String(a.id)) && a.source !== 'Scaffold' && a.spec?.severity && Array.isArray(a.spec.channels) && a.spec.channels.length) out.add(String(a.spec.severity));
    }
  }
  return [...out].sort();
}

/**
 * A version of the agreement against the repository's pack: each commitment with its links looked up,
 * and the counts.
 *   link.state        'declared' | 'guessed' (only the scan's placeholder is there) | 'missing'
 *   commitment.state  'covered' (every link declared) | 'part' (some) | 'not-covered' (none declared,
 *                     or no link at all) | 'not-read' (no pack to look in)
 *   counts            { total, service, consumer, covered, part, notCovered } — covered, part and
 *                     notCovered over the service's own commitments; null each when no pack was read
 */
export function agreementCoverage(version, layered) {
  return coverageOver(version, isObj(layered?.layers) ? agreementCatalogue(layered) : null);
}
/** The same over a catalogue already read (agreementCatalogue's, as the server answers it): null for none read. */
export function coverageOver(version, known) {
  const commitments = isObj(version) && Array.isArray(version.commitments) ? version.commitments.filter(isObj) : [];
  const read = Array.isArray(known);
  const catalogue = read ? known : [];
  const find = (l) => catalogue.find((x) => x.kind === l.kind && x.name === l.name) || null;
  const rows = commitments.map((c) => {
    const links = (Array.isArray(c.links) ? c.links : []).map((l) => {
      const hit = read ? find(l) : null;
      return { kind: l.kind, name: l.name, state: !read ? 'not-read' : !hit ? 'missing' : hit.guessed ? 'guessed' : 'declared' };
    });
    const declared = links.filter((l) => l.state === 'declared').length;
    const state = !read ? 'not-read' : !declared ? 'not-covered' : declared === links.length ? 'covered' : 'part';
    return { id: c.id, clause: c.clause || '', text: c.text || '', target: c.target || '', owner: ownerOf(c), weight: weightOf(c), links, state };
  });
  // The service answers for its own and for the ones it shares; the consumer's alone are counted apart.
  const own = rows.filter((r) => r.owner !== 'consumer');
  const n = (state) => (read ? own.filter((r) => r.state === state).length : null);
  return {
    read, commitments: rows,
    counts: { total: rows.length, service: own.length, consumer: rows.length - own.length, covered: n('covered'), part: n('part'), notCovered: n('not-covered') },
  };
}

/** A commitment's state in words, as every screen says it. */
export function coverageWords(row) {
  if (row.state === 'not-read') return 'Not looked up: the repository is not read yet';
  if (row.state === 'covered') return 'Covered by the repository';
  if (!row.links.length) return 'Not covered: linked to nothing';
  const guessed = row.links.filter((l) => l.state === 'guessed').length;
  const missing = row.links.filter((l) => l.state === 'missing').length;
  const why = [missing ? `${missing} not in the repository` : '', guessed ? `${guessed} only a placeholder the scan wrote` : ''].filter(Boolean).join(', ');
  return row.state === 'part' ? `Covered in part: ${why}` : `Not covered: ${why}`;
}

/** The counts in one line: "14 of 20 commitments covered by the repository, 2 in part, 4 not; 3 more are the consumer's." */
export function coverageSummary(counts) {
  if (!counts || !counts.total) return 'No commitment recorded.';
  const s = counts.service;
  const consumer = counts.consumer ? `${counts.consumer}${s ? ' more' : ''} ${counts.consumer === 1 ? 'is' : 'are'} the consumer's` : '';
  if (!s) return `${consumer[0].toUpperCase()}${consumer.slice(1)}.`;
  if (counts.covered === null) return `${s} commitment${s === 1 ? '' : 's'}; the repository is not read yet${consumer ? `. ${consumer[0].toUpperCase()}${consumer.slice(1)}` : ''}.`;
  const rest = [counts.part ? `${counts.part} in part` : '', counts.notCovered ? `${counts.notCovered} not` : ''].filter(Boolean).join(', ');
  return `${counts.covered} of ${s} commitment${s === 1 ? '' : 's'} covered by the repository${rest ? `, ${rest}` : ''}${consumer ? `; ${consumer}` : ''}.`;
}

// ---------- what stands behind a commitment ----------

const pct = (n) => `${Math.round(n * 1e6) / 1e4}%`;
const windowWords = (w) => (/^\d+d$/.test(w) ? `${w.slice(0, -1)} days` : String(w || ''));
/**
 * The agreement's target, as written, beside the objective that approximates it:
 *   { state, words } — 'none' (no target written) · 'words' (a target with no percentage: not compared) ·
 *   'no-objective' (nothing linked holds one) · 'guessed' (the objective is the scan's default) ·
 *   'same' · 'approximated' (the same number over another period, or a 100% no objective can hold) ·
 *   'looser' (the objective asks less than the agreement) · 'stricter'.
 * The target is read, never changed: only a percentage and its period are looked for in it.
 */
export function targetMatch(target, objective) {
  const written = text(target);
  if (!written) return { state: 'none', words: 'No target is written.' };
  const m = /(\d{1,3}(?:\.\d+)?)\s*%/.exec(written);
  if (!m) return { state: 'words', words: 'The target is in words: it is not compared with a number.' };
  if (!objective || typeof objective.value !== 'number') return { state: 'no-objective', words: `The target says ${m[1]}%: nothing linked holds an objective to compare it with.` };
  const said = `${pct(objective.value)} over ${windowWords(objective.window)}`;
  if (objective.source === 'guessed') return { state: 'guessed', words: `The target says ${m[1]}%; the objective beside it (${said}) is the scan's default, which nobody stated.` };
  const want = Number(m[1]) / 100;
  const period = /calendar month|per month|monthly|a month\b/i.test(written) ? 'calendar month'
    : /quarter/i.test(written) ? 'quarter'
      : (/(\d+)\s*-?\s*days?\b/i.exec(written)?.[1] ? `${/(\d+)\s*-?\s*days?\b/i.exec(written)[1]}d` : '');
  if (want >= 1) return { state: 'approximated', words: `The target says 100%, which no objective can hold: ${said} approximates it.` };
  if (Math.abs(want - objective.value) > 1e-9) {
    return want > objective.value
      ? { state: 'looser', words: `The target says ${m[1]}%; the objective asks less, ${said}.` }
      : { state: 'stricter', words: `The target says ${m[1]}%; the objective asks more, ${said}.` };
  }
  if (period && period !== objective.window) return { state: 'approximated', words: `The same number over another period: a ${/^\d+d$/.test(period) ? windowWords(period).replace(/^/, '') + ' window' : period} in the agreement, ${windowWords(objective.window)} in the repository.` };
  return { state: 'same', words: `The target and the objective agree: ${said}.` };
}

/**
 * What the repository has behind each commitment, and what it lacks — the facts a scorer reads; no
 * level, no weight added up. `known`: agreementCatalogue's entries (null: no pack read);
 * `routes`: agreementRoutes' severities.
 *   has.measured     an indicator with a series behind it, a recording rule or a metric
 *   has.alerts       the alert rules and burn-rate alerts that would fire for it
 *   has.routed       every severity those page at goes somewhere (null: no alert to route)
 *   has.dashboards   how many dashboards show it
 *   has.objective    { slo, value, window, source: 'repository' | 'studio' | 'guessed' } | null
 *   target           targetMatch of the target as written against that objective
 *   gaps             [{ key, words, fix }] — what is missing, each with its fix where the studio has one.
 *                    Only what the commitment's own links call for: one linked to an objective or an
 *                    indicator is something measured against a target, so it should be measured, alerted
 *                    on and shown; one linked to an alert should have that alert go somewhere; one that
 *                    is a dashboard, a metric or an exporter that must exist lacks nothing more.
 */
export function commitmentFacts(version, known, routes = []) {
  const coverage = coverageOver(version, known);
  if (!coverage.read) return { read: false, commitments: coverage.commitments.map((c) => ({ ...c, has: null, target: null, gaps: [] })) };
  const find = (l) => known.find((x) => x.kind === l.kind && x.name === l.name && !x.guessed) || null;
  const routed = new Set(Array.isArray(routes) ? routes : []);
  const commitments = coverage.commitments.map((c) => {
    const hits = c.links.map(find).filter(Boolean);
    const slos = hits.filter((h) => h.kind === 'slo');
    const measured = hits.some((h) => (h.kind === 'slo' || h.kind === 'indicator') ? h.measured : (h.kind === 'recording_rule' || h.kind === 'metric'));
    const alerts = [
      ...hits.filter((h) => h.kind === 'alert').map((h) => ({ kind: 'alert', name: h.name, severities: h.severities || [] })),
      ...hits.filter((h) => h.kind === 'burn_alert').map((h) => ({ kind: 'burn_alert', name: h.name, severities: h.severities || [] })),
      ...slos.filter((h) => Array.isArray(h.burn) && !hits.some((x) => x.kind === 'burn_alert' && x.name === h.name)).map((h) => ({ kind: 'burn_alert', name: h.name, severities: h.burn })),
    ];
    const severities = [...new Set(alerts.flatMap((a) => a.severities))].sort();
    const unrouted = severities.filter((sev) => !routed.has(sev));
    const dashboards = hits.filter((h) => h.kind === 'dashboard').length + hits.filter((h) => h.kind === 'slo' || h.kind === 'indicator').reduce((n, h) => n + (h.dashboards || 0), 0);
    const first = slos[0] || null;
    const objective = first && first.objective !== null ? { slo: first.name, value: first.objective, window: first.window, source: first.objectiveSource } : null;
    const target = targetMatch(c.target, objective);
    const gaps = [];
    if (!hits.length) gaps.push({ key: 'in-pack', words: c.links.length ? 'Nothing it is linked to is in the repository.' : 'It is linked to nothing in the repository.', fix: 'Link it to what the repository declares for it, or declare it.' });
    else {
      // Something measured against a target: an objective or an indicator is among its links.
      const reliability = hits.some((h) => h.kind === 'slo' || h.kind === 'indicator');
      if (reliability && !measured) gaps.push({ key: 'measured', words: 'Nothing measures it: no indicator with a series, recording rule or metric stands behind it.', fix: 'Link the indicator or the metric that measures it.' });
      if (reliability && !alerts.length) {
        const bare = slos.filter((h) => !Array.isArray(h.burn)).map((h) => h.name);
        gaps.push({ key: 'detected', words: bare.length ? `No alert would fire: the objective ${bare.join(', ')} has no burn-rate alert.` : 'No alert would fire for it.', fix: bare.length ? 'Remediate compiles a burn-rate alert for each objective.' : 'Link the alert rule that fires for it.' });
      } else if (alerts.length && unrouted.length) gaps.push({ key: 'routed', words: `Its alerts page at ${unrouted.join(', ')}, which the repository routes nowhere.`, fix: 'Declare an alert route with a channel for that severity.' });
      else if (alerts.length && !severities.length) gaps.push({ key: 'routed', words: 'Its alerts state no severity, so nothing says where they go.', fix: 'Give the alert rule a severity.' });
      if (reliability && !dashboards) gaps.push({ key: 'seen', words: 'No dashboard shows it.', fix: 'Link the dashboard that shows it.' });
      if (objective?.source === 'guessed') gaps.push({ key: 'objective', words: `The objective ${objective.slo} carries the scan's default (99% over 30 days), which nobody stated.`, fix: 'State objectives… on the service\'s board.' });
      if (target.state === 'looser') gaps.push({ key: 'target', words: target.words, fix: 'State the objective the agreement asks for.' });
    }
    return {
      ...c,
      has: hits.length ? { measured, alerts: alerts.map(({ kind, name }) => ({ kind, name })), routed: alerts.length ? (severities.length > 0 && !unrouted.length) : null, dashboards, objective } : null,
      target, gaps,
    };
  });
  return { read: true, commitments };
}

/** A commitment's gaps in one line: "Lacks an alert, a dashboard." — '' when it lacks nothing. */
const GAP_WORD = { 'in-pack': '', measured: 'a measure', detected: 'an alert', routed: 'a route for its alerts', seen: 'a dashboard', objective: 'a stated objective', target: 'an objective as strict as its target' };
export function gapsWords(gaps) {
  const words = (Array.isArray(gaps) ? gaps : []).map((g) => GAP_WORD[g.key]).filter(Boolean);
  return words.length ? `Lacks ${words.join(', ')}.` : '';
}

// ---------- the form ----------

/** A link as the form writes it: "alert:CheckoutErrorsHigh". */
export const linkText = (l) => `${l.kind}:${l.name}`;
/** The form's links answer → { links, problems }: comma- or line-separated "kind:name". */
export function linksFromText(value) {
  const links = [];
  const problems = [];
  for (const part of String(value ?? '').split(/[,\n]/).map((p) => p.trim()).filter(Boolean)) {
    const at = part.indexOf(':');
    const kind = at > 0 ? part.slice(0, at).trim().toLowerCase().replace(/[\s-]+/g, '_') : '';
    const name = at > 0 ? part.slice(at + 1).trim() : '';
    if (!KINDS.has(kind) || !name || name.length > MAX.name) { problems.push(part); continue; }
    if (!links.some((x) => x.kind === kind && x.name === name)) links.push({ kind, name });
  }
  return { links, problems };
}

/** An id for a new commitment: its clause, slugged, else c-<n>; never one already taken. */
export function commitmentId(clause, taken = []) {
  const base = text(clause).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'c';
  const used = new Set(taken);
  if (base !== 'c' && !used.has(base)) return base;
  for (let n = 1; ; n += 1) { const id = `${base}-${n}`; if (!used.has(id)) return id; }
}

/**
 * Several commitments pasted at once, one a line: "clause | what is promised | target | whose | links".
 * Only the promise is required; whose is "consumer" for the consumer's. → { commitments, problems }.
 */
export function commitmentsFromText(value, taken = []) {
  const commitments = [];
  const problems = [];
  const ids = [...taken];
  String(value ?? '').split(/\r?\n/).forEach((raw, i) => {
    if (!raw.trim()) return;
    const cells = raw.split('|').map((c) => c.trim());
    const [clause, said, target, whose, linked] = cells.length === 1 ? ['', cells[0], '', '', ''] : cells;
    if (!said) { problems.push(`line ${i + 1}: nothing says what is promised`); return; }
    const { links, problems: bad } = linksFromText(linked || '');
    if (bad.length) problems.push(`line ${i + 1}: ${bad.map((b) => JSON.stringify(b)).join(', ')} is not kind:name`);
    const id = commitmentId(clause, ids);
    ids.push(id);
    commitments.push({ id, clause: clause || '', text: said, target: target || '', owner: /^consumer/i.test(whose || '') ? 'consumer' : /^both/i.test(whose || '') ? 'both' : 'service', links });
  });
  return { commitments, problems };
}
