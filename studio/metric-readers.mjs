// studio/metric-readers.mjs
//
// What reads a metric one pack holds and the other does not.
//
// A repository scan records, on every metric it declares, where the metric
// comes from (`spec.origin_kind`: emitted by source code, the output of a
// recording rule, or only named in a query) and what in the repository reads
// it (`spec.used_by`: `alert:<rule>`, `dashboard:<dashboard>/<panel>`,
// `recording_rule:<record>`). Compare lists such a metric under "Only in A"
// and stops there. These helpers answer the next question — what does its
// absence from the other pack cost? — from what the pack itself says: the
// alert rules, dashboard panels and recording rules that read it.
//
// The wording stays with what is known. "Reads a metric Pack B does not
// hold" is a fact of the two packs; "this alert can never fire" is not (a
// rule built on absent() fires exactly then), so nothing here says it.
//
// Pure and zero-import (safe under node for the headless tests); the Compare
// view in compare-view.mjs reads it.

// The scanner's reader prefixes (tools/lib/crawler.mjs, `usedBy`).
const READER_PREFIX = { alert: 'alerts', recording_rule: 'rules', dashboard: 'panels' };

// Where a metric comes from, strongest claim first: a metric the code emits
// AND a query names is, for this purpose, one the code emits.
const ORIGINS = ['source-code', 'recording-rule-output', 'promql-reference'];
const ORIGIN_KEY = { 'source-code': 'code', 'recording-rule-output': 'ruleOutput', 'promql-reference': 'query' };

const nameOf = (art) => String(art?.spec?.name || art?.title || '');
const uniqueSorted = (xs) => [...new Set(xs)].sort((x, y) => x.localeCompare(y));

/**
 * The readers of one metric. `artefacts` is every artefact that stands for it
 * — one, or the members of a metric family (a histogram's _bucket / _count /
 * _sum series are separate artefacts and a query names the series, not the
 * family).
 *
 * → { origin: 'code' | 'ruleOutput' | 'query' | '', alerts: [name],
 *     rules: [record], panels: ['<dashboard>/<panel>'], dashboards: [id],
 *     count, known }
 *
 * `known` is false when no artefact carries the scanner's record at all (a
 * live draft's metric, a hand-written pack): nothing can be said, which is
 * not the same as "nothing reads it". A recording rule is not a reader of
 * its own output.
 */
export function metricReaders(artefacts) {
  const arts = (Array.isArray(artefacts) ? artefacts : [artefacts]).filter(Boolean);
  const own = new Set(arts.map(nameOf).filter(Boolean));
  const out = { alerts: [], rules: [], panels: [] };
  let known = false;
  let origin = '';
  for (const art of arts) {
    const spec = art.spec || {};
    if (Array.isArray(spec.used_by) || spec.origin_kind) known = true;
    const o = String(spec.origin_kind || '');
    if (ORIGINS.includes(o) && (!origin || ORIGINS.indexOf(o) < ORIGINS.indexOf(origin))) origin = o;
    for (const ref of Array.isArray(spec.used_by) ? spec.used_by : []) {
      const text = String(ref || '');
      const at = text.indexOf(':');
      const bucket = READER_PREFIX[text.slice(0, at)];
      const name = text.slice(at + 1);
      if (at < 1 || !bucket || !name) continue;
      if (bucket === 'rules' && own.has(name)) continue;
      out[bucket].push(name);
    }
  }
  const alerts = uniqueSorted(out.alerts);
  const rules = uniqueSorted(out.rules);
  const panels = uniqueSorted(out.panels);
  const dashboards = uniqueSorted(panels.map((p) => p.split('/')[0]));
  return {
    origin: ORIGIN_KEY[origin] || '',
    alerts, rules, panels, dashboards,
    count: alerts.length + rules.length + panels.length,
    known,
  };
}

/**
 * Every metric of a group at once. `metrics` is a list of artefact lists, one
 * per metric (see metricReaders). Readers are counted once however many of
 * the metrics they read.
 *
 * → { metrics, known, read, unread, alerts, rules, panels, dashboards,
 *     unreadByOrigin: { code, ruleOutput, query, other } }
 */
export function readersDigest(metrics) {
  const all = (metrics || []).map(metricReaders);
  const known = all.filter((r) => r.known);
  const unread = known.filter((r) => r.count === 0);
  const unreadByOrigin = { code: 0, ruleOutput: 0, query: 0, other: 0 };
  for (const r of unread) unreadByOrigin[r.origin || 'other']++;
  return {
    metrics: all.length,
    known: known.length,
    read: known.length - unread.length,
    unread: unread.length,
    alerts: uniqueSorted(known.flatMap((r) => r.alerts)),
    rules: uniqueSorted(known.flatMap((r) => r.rules)),
    panels: uniqueSorted(known.flatMap((r) => r.panels)),
    dashboards: uniqueSorted(known.flatMap((r) => r.dashboards)),
    unreadByOrigin,
  };
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const andList = (parts) => (parts.length <= 1
  ? parts.join('')
  : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`);

// "5 alert rules, 34 dashboard panels and 7 recording rules", or ''.
export function readerCounts({ alerts = [], panels = [], rules = [] } = {}) {
  return andList([
    alerts.length ? count(alerts.length, 'alert rule') : '',
    panels.length ? count(panels.length, 'dashboard panel') : '',
    rules.length ? count(rules.length, 'recording rule') : '',
  ].filter(Boolean));
}

// The alert rules by name: they are the readers a person acts on first.
export const ALERT_NAMES_SHOWN = 6;
export function alertNames(alerts = []) {
  if (!alerts.length) return '';
  const shown = alerts.slice(0, ALERT_NAMES_SHOWN);
  const more = alerts.length - shown.length;
  return shown.join(', ') + (more > 0 ? ` and ${more} more` : '');
}

/**
 * One card's line: what reads this metric, or where it comes from when
 * nothing does. '' when the pack says nothing about it.
 */
export function readerLine(readers) {
  if (!readers?.known) return '';
  if (readers.count) {
    const parts = [
      readers.alerts.length === 1 ? `alert rule ${readers.alerts[0]}` : (readers.alerts.length ? count(readers.alerts.length, 'alert rule') : ''),
      readers.panels.length ? count(readers.panels.length, 'dashboard panel') : '',
      readers.rules.length === 1 ? `recording rule ${readers.rules[0]}` : (readers.rules.length ? count(readers.rules.length, 'recording rule') : ''),
    ].filter(Boolean);
    return `Read by ${andList(parts)}`;
  }
  if (readers.origin === 'code') return 'Emitted by code; nothing in this pack reads it';
  if (readers.origin === 'ruleOutput') return 'A recording rule’s output; nothing in this pack reads it';
  return '';
}

/**
 * The group's paragraph. `holder` and `other` are the pack letters ('A',
 * 'B'); `otherIsLive` says the other pack was drafted from a live system, so
 * "does not hold" can be said as what it is: the live system did not report
 * it. A group may hold other artefacts too (a scrape job beside the metrics):
 * the numbers are of the metrics the pack says something about.
 * '' when the pack says nothing about any of the metrics.
 */
export function readersSentence(digest, { holder = 'A', other = 'B', otherIsLive = false } = {}) {
  if (!digest?.known) return '';
  const parts = [];
  const lead = otherIsLive
    ? `Pack ${other} was drafted from the live system, which reported ${digest.known === 1 ? 'no such metric' : `none of these ${digest.known} metrics`}.`
    : '';
  if (lead) parts.push(lead);
  if (digest.read) {
    const names = alertNames(digest.alerts);
    parts.push(`In Pack ${holder}, ${readerCounts(digest)} read ${digest.read === digest.known ? (digest.known === 1 ? 'it' : 'them') : `${digest.read} of them`}${digest.dashboards.length ? `, on ${count(digest.dashboards.length, 'dashboard')}` : ''}.${names ? ` Alert rules: ${names}.` : ''}`);
  }
  if (digest.unread) {
    const u = digest.unreadByOrigin;
    const what = andList([
      u.code ? `${u.code} emitted by code` : '',
      u.ruleOutput ? `${count(u.ruleOutput, 'recording-rule output')}` : '',
      u.query + u.other ? `${u.query + u.other} named only in a query` : '',
    ].filter(Boolean));
    parts.push(`${digest.read ? `The other ${digest.unread}` : `${digest.unread === digest.known && digest.known > 1 ? 'All ' : ''}${digest.unread}`} ${digest.unread === 1 ? 'is' : 'are'} read by nothing in Pack ${holder}${what ? ` (${what})` : ''}.`);
  }
  return parts.join(' ');
}

// For ordering a group: what an alert reads first, then what anything reads,
// then the rest. Unknown sorts with the rest.
export function readerRank(readers) {
  if (!readers?.known || !readers.count) return 2;
  return readers.alerts.length ? 0 : 1;
}
