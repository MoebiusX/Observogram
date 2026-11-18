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
//   owner   'service' (this service answers for it) or 'consumer' (the consuming team does: it needs
//           to be visible here, no more).
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

export const AGREEMENT_OWNERS = Object.freeze(['service', 'consumer']);
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
    for (const k of Object.keys(c)) if (!['id', 'clause', 'text', 'target', 'owner', 'links'].includes(k)) errors.push(`${at}.${k} is not a commitment field`);
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
  return { id: c.id, clause: text(c.clause), text: text(c.text), target: text(c.target), owner: c.owner === 'consumer' ? 'consumer' : 'service', links };
};
const contentKey = (v) => JSON.stringify([v?.source?.document, v?.source?.version, v?.source?.effective, (v?.commitments || []).map((c) => [c.id, c.clause, c.text, c.target, c.owner, (c.links || []).map((l) => [l.kind, l.name])])]);
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
  for (const value of Object.values(layers)) {
    const list = Array.isArray(value) ? value : isObj(value) ? Object.values(value).flat() : [];
    for (const a of list) {
      if (!isObj(a) || typeof a.id !== 'string') continue;
      const kind = PREFIX_KIND.find(([re]) => re.test(a.id))?.[1];
      if (!kind || /^METRIC-FAM-/.test(a.id)) continue;
      const name = nameOf(kind, a).trim();
      const key = `${kind}\u0000${name}`;
      if (!name || seen.has(key)) continue;
      seen.add(key);
      out.push({ kind, name, guessed: a.source === 'Scaffold' });
    }
  }
  return out;
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
  const commitments = isObj(version) && Array.isArray(version.commitments) ? version.commitments.filter(isObj) : [];
  const read = isObj(layered?.layers);
  const catalogue = read ? agreementCatalogue(layered) : [];
  const find = (l) => catalogue.find((x) => x.kind === l.kind && x.name === l.name) || null;
  const rows = commitments.map((c) => {
    const links = (Array.isArray(c.links) ? c.links : []).map((l) => {
      const hit = read ? find(l) : null;
      return { kind: l.kind, name: l.name, state: !read ? 'not-read' : !hit ? 'missing' : hit.guessed ? 'guessed' : 'declared' };
    });
    const declared = links.filter((l) => l.state === 'declared').length;
    const state = !read ? 'not-read' : !declared ? 'not-covered' : declared === links.length ? 'covered' : 'part';
    return { id: c.id, clause: c.clause || '', text: c.text || '', target: c.target || '', owner: c.owner === 'consumer' ? 'consumer' : 'service', links, state };
  });
  const own = rows.filter((r) => r.owner === 'service');
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
    commitments.push({ id, clause: clause || '', text: said, target: target || '', owner: /^consumer/i.test(whose || '') ? 'consumer' : 'service', links });
  });
  return { commitments, problems };
}
