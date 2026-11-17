// tools/lib/run-basis.mjs — what a run's match figure rests on, read the same way by every reader.
//
// No figure without its basis: a run record's match (drift.alignmentPct) is a figure only over a
// comparison — something was compared — and over a live side that returned data. Every reader of a
// run outside the studio (the journeys listing, the markdown report, `packc journey list`, the demo,
// the Neuron model) asks this module, so a record that claims 100 over an empty comparison, or a
// live read whose every probe failed, never shows a percentage, and never reads as passed.
//
// The rule, over a record old or new:
//   compared  drift.compared when it is a count, else aligned + drifted + declaredNotLive +
//             liveNotDeclared (a record written before drift.compared), else null (no drift, or a
//             drift that counts nothing — only hand-made fixtures carry one; their figure stands)
//   vantage   'lost' when the record says so, or when probes were attempted and none returned data
//             (an older record whose every probe failed, or came back empty, still said partial or
//             full); 'restricted' (no longer written) reads 'full'; else the record's own
//   match     null when nothing was compared or the vantage was lost, else drift.alignmentPct
//   reading   the record's outcome as a reader says it: a pass or a failed gate over nothing
//             compared is 'nothing-compared', any run whose vantage was lost 'vantage-lost'
// The first probe error is the first failed family's that names one, by the engine's own rule
// (tools/lib/live-fetch.mjs firstProbeError: the order the live read's stages run — the family a
// lost run's `error` is written from), its first entry (the cascade's own cause), on one line, with
// URL userinfo and every credential-named query parameter masked, at most 200 characters.
//
// Browser-safe (served at /lib); its imports, mcp-url-safety.mjs and live-fetch.mjs, are zero-import.
// studio/overview-model.mjs holds the studio's copy of the rule (a studio module never imports
// tools/lib) and studio/verdict-ui.mjs the figure's; tools/test-run-basis.mjs pins them equal.

import { credentialParamName } from './mcp-url-safety.mjs';
// One stage order and one "first probe error" for the engine and every reader.
import { firstProbeError, inStageOrder } from './live-fetch.mjs';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const count = (v) => { const n = finite(v); return n !== null && n >= 0 ? Math.floor(n) : null; };
const names = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x) : null);
const COUNTS = ['aligned', 'drifted', 'declaredNotLive', 'liveNotDeclared'];

const FAMILY_WORDS = { alerting_routes: 'alert routes', scrape_configs: 'scrape targets', recording_rules: 'recording rules', alert_rules: 'alert rules', dashboards: 'dashboards', metric_names: 'metric names' };
export const familyWord = (f) => FAMILY_WORDS[f] || String(f || '').replace(/_/g, ' ');
const listWords = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

export const NOTHING_REASON = 'Neither side had anything this check could compare';

// How much the run compared (C2): a count, or null when the record cannot say.
export function comparedOf(drift) {
  if (!isObj(drift)) return null;
  const c = count(drift.compared);
  if (c !== null) return c;
  if (!COUNTS.some((k) => finite(drift[k]) !== null)) return null;
  return COUNTS.reduce((s, k) => s + Math.max(0, finite(drift[k]) ?? 0), 0);
}

// The vantage a reader goes by (C3), for a record or a journeys-listing entry.
export function vantageOf(record) {
  if (!isObj(record)) return null;
  const p = isObj(record.probes) ? record.probes : null;
  const attempted = p ? names(p.attempted) : null;
  const succeeded = p ? names(p.succeeded) : null;
  if (record.vantage === 'lost' || (attempted?.length && succeeded && !succeeded.length)) return 'lost';
  const v = typeof record.vantage === 'string' && record.vantage ? record.vantage : null;
  return v === 'restricted' ? 'full' : v;
}

// The match, only over a comparison and a live side that gave data.
export function matchPctOf(record) {
  if (!isObj(record) || !isObj(record.drift)) return null;
  if (comparedOf(record.drift) === 0 || vantageOf(record) === 'lost') return null;
  return finite(record.drift.alignmentPct);
}

const decodedName = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
// A text a reader may show of what a live source answered: one line, URL userinfo masked, every
// query parameter whose name says it holds a credential masked, a Bearer / Basic value masked, at
// most `max` characters.
export function safeErrorText(text, max = 200) {
  const t = String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/\/\/[^/\s@]+@/g, '//***@')
    .replace(/([?&;])([^=&;#\s]+)=([^&;#\s]*)/g, (m, sep, name) => (credentialParamName(decodedName(name)) ? `${sep}${name}=***` : m))
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi, '$1 ***');
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

// The first probe error a record carries, ready to show, or null: the first failed family's that
// names one (live-fetch.mjs firstProbeError, over the record's probe table alone), else the first
// message the record keeps for a family answered in part. A run lost before any probe (the fetch
// threw: no probe table) has its own error; a lost run whose families answered with no data has
// none — its `error` ("no probe family returned data") is no probe error.
export function firstProbeErrorOf(record) {
  if (!isObj(record)) return null;
  const text = (v) => (typeof v === 'string' && v.trim() ? v : '');
  const errs = Object.fromEntries(Object.entries(isObj(record.probeErrors) ? record.probeErrors : {}).filter(([, v]) => text(v)));
  const first = firstProbeError({ probes: { failed: names(record.probes?.failed) || [] }, probeErrors: errs });
  const raw = text(first?.error) || inStageOrder(Object.keys(errs)).map((f) => errs[f]).find(Boolean) || '';
  if (raw) return safeErrorText(raw.split(' · ')[0]);
  if (!isObj(record.probes) && (record.outcome === 'vantage-lost' || record.outcome === 'error') && text(record.error)) return safeErrorText(record.error);
  return null;
}

// Why the live side gave nothing: { cause: 'error' (with the first probe error, or null when the
// record names none) | 'no-data' (every family answered, none with data) | 'unknown', error }.
export function liveLossOf(record) {
  const error = firstProbeErrorOf(record);
  if (error) return { cause: 'error', error };
  const lost = vantageOf(record) === 'lost';
  if (lost && isObj(record?.probes) && !(names(record.probes.failed) || []).length) return { cause: 'no-data', error: null };
  return { cause: lost || record?.outcome === 'vantage-lost' || record?.outcome === 'error' ? 'error' : 'unknown', error: null };
}

// The record's outcome as a reader says it (a record or a journeys-listing entry); null for none.
export function readingOutcome(x) {
  if (!isObj(x)) return null;
  const outcome = typeof x.outcome === 'string' && x.outcome ? x.outcome : null;
  if (outcome === 'scan-partial' || outcome === 'error') return outcome;
  if (outcome === 'vantage-lost' || vantageOf(x) === 'lost') return 'vantage-lost';
  const compared = isObj(x.drift) ? comparedOf(x.drift) : count(x.compared);
  if ((outcome === 'pass' || outcome === 'gate-failed') && compared === 0) return 'nothing-compared';
  return outcome;
}

// ---------- the repository scan ----------

const oneLine = (v, max) => (typeof v === 'string' && v.trim() ? safeErrorText(v, max) : null);

// The deployment surface an older record's environment scope stood for, by the crawler's profile
// names (tools/lib/crawler.mjs DEPLOYMENT_SURFACES, inverted; tools/test-run-basis.mjs pins the two):
// a filter is named by its surface, never by an environment's name.
const SURFACE_OF_PROFILE = Object.freeze({ prod: 'kubernetes', eks: 'eks', 'local-k8s': 'local-kubernetes', 'local-docker': 'compose' });
const surfaceOfProfile = (profile) => (profile && Object.hasOwn(SURFACE_OF_PROFILE, profile) ? SURFACE_OF_PROFILE[profile] : profile);

// packA.scan (C7) as a reader needs it, or null; an older record's environment scope reads as its
// filter, by the surface its profile stood for.
export function scanFactsOf(scan) {
  if (!isObj(scan)) return null;
  let filter = null;
  if (isObj(scan.filter) && oneLine(scan.filter.surface, 40)) filter = { surface: oneLine(scan.filter.surface, 40), excluded: count(scan.filter.excluded) ?? 0 };
  else if (isObj(scan.environment) && (count(scan.environment.excluded) ?? 0) > 0) filter = { surface: surfaceOfProfile(oneLine(scan.environment.profile, 40)), excluded: count(scan.environment.excluded) };
  return {
    partial: scan.partial === true, notRead: count(scan.notRead), candidates: count(scan.candidates), files: count(scan.files),
    treeTruncated: scan.treeTruncated === true || scan.truncated === true, filter, excludedMost: scan.excludedMost === true,
  };
}

// "49 of 220 files not read" (and the host's own cut), or '' when nothing is known to be missing.
export function filesNotReadWords(s) {
  if (!isObj(s)) return '';
  const known = s.notRead !== null && s.notRead > 0 && s.candidates !== null;
  const head = known ? `${s.notRead} of ${s.candidates} files not read` : s.partial ? 'The scan did not read every file' : '';
  const cut = s.treeTruncated ? 'the host cut its file list short' : '';
  return head && cut ? `${head}; ${cut}` : head || (cut ? `${cut[0].toUpperCase()}${cut.slice(1)}` : '');
}

// Whether a stopped Run kept a complete scan: its record names the kept pack (packA.source). A Run
// that read no file of a repository it holds no complete scan of stops with none (packA.source null).
export const stoppedRunKept = (record) => isObj(record?.packA) && typeof record.packA.source === 'string' && record.packA.source !== '';

// A stopped Run's reading (C10). `kept: false` (a Run that kept no complete scan) says so in place of
// "the previous pack is kept".
export function scanPartialReading(scan, { kept = true } = {}) {
  const s = scanFactsOf(scan);
  const tail = kept === false ? 'no complete scan of this repository is kept' : 'the previous pack is kept';
  return s && s.notRead !== null && s.candidates !== null
    ? `Partial scan — ${s.notRead} of ${s.candidates} files not read; ${tail}`
    : `Partial scan — ${tail}`;
}

// ---------- what a run rests on ----------

// The facts the reasons are drawn from: declared things the live side could not read (the
// record's drift.tiers), the probe families that failed, the scan, a scoped live read, the
// differences set aside.
export function basisFactsOf(record) {
  const r = isObj(record) ? record : {};
  const tiers = isObj(r.drift?.tiers) ? r.drift.tiers : null;
  const aside = isObj(r.drift?.setAside) ? (count(r.drift.setAside.declaredNotLive) ?? 0) + (count(r.drift.setAside.liveNotDeclared) ?? 0) : 0;
  return {
    notReadLive: tiers ? Object.values(tiers).reduce((s, t) => s + (isObj(t) ? count(t.notRead) ?? 0 : 0), 0) : null,
    probesFailed: inStageOrder(names(r.probes?.failed) || []).slice(0, 8).map((f) => f.slice(0, 40)),
    scoped: isObj(r.packB?.liveScope) && Object.keys(r.packB.liveScope).length > 0,
    setAsideCount: aside,
    scan: scanFactsOf(r.packA?.scan),
  };
}

// Why nothing was compared: the first of the reasons that holds, else that neither side had anything.
export function nothingReason(facts) {
  const x = isObj(facts) ? facts : {};
  const unread = count(x.notReadLive);
  if (unread) return `${unread} declared ${unread === 1 ? 'thing' : 'things'} not read live`;
  const failed = names(x.probesFailed) || [];
  if (failed.length) return `Live answered in part: ${listWords(failed.map(familyWord))} not read`;
  const files = filesNotReadWords(x.scan);
  if (files) return files;
  if (x.scoped === true) return 'The live read was scoped to part of the estate';
  if (count(x.setAsideCount)) return 'Every difference was set aside';
  return NOTHING_REASON;
}

// What a checked run leaves out, beside its figure: the live families it could not read (a partial
// vantage) and the files the scan did not read.
export function partialParts(facts, vantage) {
  const x = isObj(facts) ? facts : {};
  const failed = names(x.probesFailed) || [];
  return [
    vantage === 'partial' ? (failed.length ? `Live answered in part: ${listWords(failed.map(familyWord))} not read` : 'Live answered in part') : '',
    filesNotReadWords(x.scan),
  ].filter(Boolean);
}

// One run in a line, for the command line and the report:
//   { state: 'never' | 'scan-partial' | 'unreachable' | 'nothing' | 'partial' | 'checked', reading,
//     compared, alignmentPct, firstProbeError, text }
export function runBasis(record) {
  if (!isObj(record)) return { state: 'never', reading: null, compared: null, alignmentPct: null, firstProbeError: null, text: 'Never checked' };
  const base = { reading: readingOutcome(record), compared: comparedOf(record.drift), alignmentPct: matchPctOf(record), firstProbeError: firstProbeErrorOf(record) };
  if (record.outcome === 'scan-partial') return { ...base, state: 'scan-partial', text: scanPartialReading(record.packA?.scan, { kept: stoppedRunKept(record) }) };
  if (base.reading === 'vantage-lost' || base.reading === 'error') {
    const loss = liveLossOf(record);
    return { ...base, state: 'unreachable', text: loss.error ? `Live did not answer — ${loss.error}` : loss.cause === 'no-data' ? 'Live returned no data' : 'Live did not answer' };
  }
  const facts = basisFactsOf(record);
  if (base.compared === 0) return { ...base, state: 'nothing', text: `Nothing compared — ${nothingReason(facts)}` };
  const vantage = vantageOf(record);
  const parts = partialParts(facts, vantage);
  const figure = base.alignmentPct !== null ? `${base.alignmentPct}% match` : 'Match not known';
  const partial = vantage === 'partial' || facts.scan?.partial === true;
  return { ...base, state: partial ? 'partial' : 'checked', text: parts.length ? `${figure} — ${parts.join(' · ')}` : figure };
}

// The match in a few words: 'alignment 92%' · 'nothing compared' · 'live did not answer' ·
// 'live returned no data' · 'alignment not recorded'.
export function alignmentWords(record) {
  const reading = readingOutcome(record);
  if (reading === 'vantage-lost' || reading === 'error') return liveLossOf(record).cause === 'no-data' ? 'live returned no data' : 'live did not answer';
  if (reading === 'nothing-compared' || (isObj(record?.drift) && comparedOf(record.drift) === 0)) return 'nothing compared';
  const pct = matchPctOf(record);
  return pct === null ? 'alignment not recorded' : `alignment ${pct}%`;
}

// What GET /api/journeys lists of a run beside its outcome (C9): the figure only over a comparison,
// what it rests on, and why not — counts, family names and one masked line, nothing else.
export function basisSummary(record) {
  const r = isObj(record) ? record : {};
  const v = vantageOf(r);
  const reason = oneLine(r.comparable?.reason, 200);
  const reading = readingOutcome(r);
  return {
    alignmentPct: matchPctOf(r),
    compared: comparedOf(r.drift),
    vantage: v ? v.slice(0, 16) : null,
    reading,
    firstProbeError: firstProbeErrorOf(r),
    // Why a lost run's live side gave nothing ('error' | 'no-data'), null for a run that read it.
    liveLoss: reading === 'vantage-lost' ? liveLossOf(r).cause : null,
    ...basisFactsOf(r),
    comparable: isObj(r.comparable) && r.comparable.withPrevious === false ? { withPrevious: false, reason } : null,
  };
}

// A stopped Run (outcome scan-partial, C8) as the listing names it beside the last check (A9):
// { startedAt, notRead, candidates, firstReason, kept } — `kept`, whether it kept a complete scan.
export function stoppedSummary(record) {
  if (!isObj(record) || record.outcome !== 'scan-partial') return null;
  const s = scanFactsOf(record.packA?.scan);
  const first = Array.isArray(record.packA?.scan?.notReadReasons) ? record.packA.scan.notReadReasons.find(isObj) : null;
  const firstReason = first ? oneLine(`${first.path ?? '?'} — ${first.why ?? '?'}`, 200) : oneLine(record.error, 200);
  return { startedAt: typeof record.startedAt === 'string' ? record.startedAt : null, notRead: s?.notRead ?? null, candidates: s?.candidates ?? null, firstReason, kept: stoppedRunKept(record) };
}
