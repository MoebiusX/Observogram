// The agreement's score: each commitment on seven weighted dimensions, at a level from 0 to 4.
//
// It reads the facts (studio/agreement.mjs commitmentFacts) and nothing else: what the repository has
// behind each commitment. It is the stage before the repository — how the repository covers what was
// promised — and never reaches a letter.
//
// A cell is one commitment on one dimension:
//   scored          a level 0–4, and why
//   not-applicable  the commitment's own links do not call for it (a dashboard that must exist has
//                   nothing to alert on): left out of its total
//   not-checked     the engine could not look (no pack read; runtime evidence, which is not read
//                   yet): no level — never a 0
// A commitment's points are Σ weight × level / 4 over its scored cells, of Σ weight over them. A
// service's are those sums over the commitments it answers for, each times the commitment's own
// weight: sums, never a mean of ratios, and never one blended figure with what was not checked.
//
// The scorer is replaceable. A result names the scorer that made it (id, version, label) and carries
// its own dimensions and levels, so a reader needs no table from here to draw it, and two results are
// compared only when they come from the same scorer and version (resultTermsKey).
// Zero-import.

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The built-in scorer's rules, version 1 (decided 2026-11-19). */
export const BUILT_IN_SCORER = Object.freeze({ id: 'observogram.levels', version: 1, label: 'Built-in levels, version 1' });
export const LEVEL_MAX = 4;
export const DIMENSIONS = Object.freeze([
  Object.freeze({ key: 'in_pack', label: 'In the repository', short: 'Repo', weight: 15 }),
  Object.freeze({ key: 'measurable', label: 'Measured', short: 'Meas', weight: 20 }),
  Object.freeze({ key: 'detectable', label: 'Alerted on', short: 'Alert', weight: 15 }),
  Object.freeze({ key: 'actionable', label: 'Routed', short: 'Route', weight: 15 }),
  Object.freeze({ key: 'observable', label: 'Shown', short: 'Shown', weight: 10 }),
  Object.freeze({ key: 'target_match', label: 'Target match', short: 'Target', weight: 15 }),
  Object.freeze({ key: 'evidence', label: 'Proven live', short: 'Live', weight: 10 }),
]);

const scored = (level, why) => ({ state: 'scored', level, why });
const na = (why) => ({ state: 'not-applicable', why });
const unchecked = (why) => ({ state: 'not-checked', why });

/** One commitment's cells under the built-in rules: { [dimension key]: cell }. `fact`: one of commitmentFacts' commitments. */
export function builtInCells(fact) {
  const evidence = unchecked('Whether it holds live is not read yet.');
  if (!isObj(fact) || fact.state === 'not-read') {
    const why = 'The repository is not read yet.';
    return { in_pack: unchecked(why), measurable: unchecked(why), detectable: unchecked(why), actionable: unchecked(why), observable: unchecked(why), target_match: unchecked(why), evidence };
  }
  const has = fact.has;
  const target = fact.target || { state: 'none', words: '' };
  const targetCell = () => (target.state === 'none' || target.state === 'words' ? na(target.words)
    : target.state === 'same' || target.state === 'stricter' ? scored(4, target.words)
      : target.state === 'approximated' ? scored(3, target.words)
        : target.state === 'looser' ? scored(1, target.words)
          : scored(0, target.words));   // no objective to compare it with, or the scan's default
  if (!has) {
    // Linked to nothing the repository declares: nothing shows it is measured, alerted on, routed or shown.
    const why = (fact.links || []).length ? 'Nothing it is linked to is in the repository.' : 'It is linked to nothing in the repository.';
    return { in_pack: scored(0, why), measurable: scored(0, why), detectable: scored(0, why), actionable: scored(0, why), observable: scored(0, why), target_match: targetCell(), evidence };
  }
  const kinds = Array.isArray(has.kinds) ? has.kinds : [];
  // Something measured against a target: an objective or an indicator is among its links.
  const reliability = kinds.includes('slo') || kinds.includes('indicator');
  const alerts = Array.isArray(has.alerts) ? has.alerts : [];
  const severities = Array.isArray(has.severities) ? has.severities : [];
  const unrouted = Array.isArray(has.unrouted) ? has.unrouted : [];
  const cells = {};
  cells.in_pack = fact.state === 'covered' ? scored(4, 'Everything it is linked to is in the repository.') : scored(2, 'Some of what it is linked to is not in the repository.');
  cells.measurable = has.measure === 'indicator' ? scored(4, 'An indicator with a series measures it.')
    : has.measure === 'series' ? scored(2, 'A metric or a recording rule stands behind it, but no indicator.')
      : reliability ? scored(0, 'Nothing measures it.')
        : na('Its links call for no measure.');
  cells.detectable = alerts.length ? scored(4, `${alerts.length === 1 ? 'An alert' : `${alerts.length} alerts`} would fire for it.`)
    : reliability ? scored(0, 'No alert would fire for it.')
      : na('Its links call for no alert.');
  cells.actionable = !alerts.length ? (reliability ? scored(0, 'No alert, so nothing reaches anyone.') : na('It has no alert to route.'))
    : !severities.length ? scored(0, 'Its alerts state no severity, so nothing says where they go.')
      : !unrouted.length ? scored(4, 'Every severity its alerts page at is routed.')
        : unrouted.length < severities.length ? scored(2, `Its alerts page at ${unrouted.join(', ')}, which the repository routes nowhere.`)
          : scored(0, `Its alerts page at ${unrouted.join(', ')}, which the repository routes nowhere.`);
  cells.observable = has.dashboards > 0 ? scored(4, `${has.dashboards === 1 ? 'A dashboard shows' : `${has.dashboards} dashboards show`} it.`)
    : reliability ? scored(0, 'No dashboard shows it.')
      : na('Its links call for no dashboard.');
  cells.target_match = reliability || target.state === 'none' || target.state === 'words' ? targetCell() : na('Its links hold no objective to set its target beside.');
  cells.evidence = evidence;
  return cells;
}

const round2 = (n) => Math.round(n * 100) / 100;
/** A commitment's points over its cells: { earned, of } — Σ weight × level / max over the scored ones. */
export function pointsOf(cells, dimensions = DIMENSIONS, levelMax = LEVEL_MAX) {
  let earned = 0; let of = 0;
  for (const d of dimensions) {
    const c = cells?.[d.key];
    if (c?.state !== 'scored') continue;
    earned += d.weight * Math.max(0, Math.min(levelMax, Number(c.level) || 0)) / levelMax;
    of += d.weight;
  }
  return { earned: round2(earned), of };
}

/**
 * The agreement scored by the built-in rules.
 *   → { state: 'scored', scorer, levelMax, dimensions, commitments: [{ id, owner, weight, counted,
 *       cells, earned, of }], total: { commitments, earned, of, notChecked } }
 * `counted`: false for the consumer's alone (shown, never in the total). `total` is over the counted
 * ones, each times its weight; `notChecked` the dimensions no counted commitment could be scored on.
 */
export function scoreAgreement(facts) {
  const list = isObj(facts) && Array.isArray(facts.commitments) ? facts.commitments.filter(isObj) : [];
  const commitments = list.map((f) => {
    const cells = builtInCells(f);
    return { id: String(f.id ?? ''), owner: f.owner === 'consumer' ? 'consumer' : f.owner === 'both' ? 'both' : 'service', weight: Number.isInteger(f.weight) && f.weight >= 1 ? f.weight : 1, counted: f.owner !== 'consumer', cells, ...pointsOf(cells) };
  });
  return finish({ scorer: { ...BUILT_IN_SCORER }, levelMax: LEVEL_MAX, dimensions: DIMENSIONS.map(({ key, label, short, weight }) => ({ key, label, short, weight })), commitments });
}

// The totals, from the commitments as scored: sums, each commitment times its own weight.
function finish(result) {
  const counted = result.commitments.filter((c) => c.counted !== false);
  const total = {
    commitments: counted.length,
    earned: round2(counted.reduce((n, c) => n + c.weight * c.earned, 0)),
    of: round2(counted.reduce((n, c) => n + c.weight * c.of, 0)),
    notChecked: result.dimensions.filter((d) => counted.length > 0 && counted.every((c) => c.cells?.[d.key]?.state === 'not-checked')).map((d) => d.key),
  };
  return { state: 'scored', ...result, total };
}

const CELL_STATES = ['scored', 'not-applicable', 'not-checked'];
/**
 * A replaceable scorer's answer, checked and completed: its own dimensions and levels, a cell per
 * commitment and dimension. What does not read is never patched with the built-in's numbers:
 *   → the result (state 'scored', totals computed here), or { state: 'not-scored', scorer, reason }.
 * `answer`: { levelMax?, dimensions: [{ key, label, short?, weight }], commitments: [{ id, cells }] }.
 */
export function resultFrom(scorer, answer, facts) {
  const name = { id: String(scorer?.id ?? '').slice(0, 80), version: scorer?.version ?? null, label: String(scorer?.label ?? scorer?.id ?? '').slice(0, 120) };
  const fail = (reason) => ({ state: 'not-scored', scorer: name, reason });
  if (!name.id) return fail('the scorer names no id');
  if (!isObj(answer) || !Array.isArray(answer.dimensions) || !Array.isArray(answer.commitments)) return fail('its answer is not { dimensions, commitments }');
  const levelMax = Number.isInteger(answer.levelMax) && answer.levelMax >= 1 && answer.levelMax <= 100 ? answer.levelMax : LEVEL_MAX;
  const dimensions = [];
  for (const d of answer.dimensions) {
    if (!isObj(d) || typeof d.key !== 'string' || !/^[a-z][a-z0-9_]{0,39}$/.test(d.key) || !(Number(d.weight) > 0) || !Number.isFinite(Number(d.weight))) return fail('a dimension is not { key, label, weight } with a weight above 0');
    if (dimensions.some((x) => x.key === d.key)) return fail(`the dimension ${d.key} is named twice`);
    dimensions.push({ key: d.key, label: String(d.label ?? d.key).slice(0, 60), short: String(d.short ?? d.label ?? d.key).slice(0, 12), weight: Number(d.weight) });
  }
  if (!dimensions.length || dimensions.length > 20) return fail('it names no dimension, or more than 20');
  const known = new Map((isObj(facts) && Array.isArray(facts.commitments) ? facts.commitments : []).map((f) => [String(f.id), f]));
  const byId = new Map();
  for (const c of answer.commitments) {
    if (!isObj(c) || !known.has(String(c.id)) || !isObj(c.cells)) return fail('a commitment in its answer is not one of the agreement\'s, or has no cells');
    const cells = {};
    for (const d of dimensions) {
      const cell = c.cells[d.key];
      if (!isObj(cell) || !CELL_STATES.includes(cell.state)) return fail(`the cell ${c.id} · ${d.key} is not scored, not-applicable or not-checked`);
      if (cell.state === 'scored' && !(Number.isFinite(Number(cell.level)) && Number(cell.level) >= 0 && Number(cell.level) <= levelMax)) return fail(`the cell ${c.id} · ${d.key} has no level from 0 to ${levelMax}`);
      cells[d.key] = { state: cell.state, ...(cell.state === 'scored' ? { level: Number(cell.level) } : {}), why: String(cell.why ?? '').slice(0, 300) };
    }
    byId.set(String(c.id), cells);
  }
  if (byId.size !== known.size) return fail('its answer leaves a commitment out');
  const commitments = [...known.values()].map((f) => {
    const cells = byId.get(String(f.id));
    return { id: String(f.id), owner: f.owner === 'consumer' ? 'consumer' : f.owner === 'both' ? 'both' : 'service', weight: Number.isInteger(f.weight) && f.weight >= 1 ? f.weight : 1, counted: f.owner !== 'consumer', cells, ...pointsOf(cells, dimensions, levelMax) };
  });
  return finish({ scorer: name, levelMax, dimensions, commitments });
}

/** The terms a result was scored on: two results compare only when this is the same. */
export const resultTermsKey = (result) => (isObj(result?.scorer) ? `${result.scorer.id}@${result.scorer.version ?? ''}:${(result.dimensions || []).map((d) => `${d.key}=${d.weight}`).join(',')}/${result.levelMax ?? ''}` : '');

/** Whether the page may score again as the form is typed: only the built-in's own rules are here. */
export const scoredByBuiltIn = (result) => result?.scorer?.id === BUILT_IN_SCORER.id && result?.scorer?.version === BUILT_IN_SCORER.version;

const pts = (n) => String(Math.round(n * 10) / 10);
/** A commitment's points in words: "62.5 of 75 points" — '' when nothing of it could be scored. */
export const pointsWords = (c) => (c && c.of > 0 ? `${pts(c.earned)} of ${pts(c.of)} points` : '');
/** The service's line: "187.5 of 250 points over 3 commitments · Built-in levels, version 1. Proven live is not checked yet." */
export function scoreSummary(result) {
  if (!isObj(result)) return '';
  if (result.state === 'not-scored') return `Not scored: ${result.scorer?.label || 'the scorer'} did not answer — ${result.reason}.`;
  const t = result.total || {};
  if (!t.commitments) return '';
  if (!(t.of > 0)) return `Not scored yet: the repository is not read. ${result.scorer.label}.`;
  const left = (t.notChecked || []).map((k) => result.dimensions.find((d) => d.key === k)?.label).filter(Boolean);
  return `${pts(t.earned)} of ${pts(t.of)} points over ${t.commitments} commitment${t.commitments === 1 ? '' : 's'} · ${result.scorer.label}.${left.length ? ` ${left.join(', ')} ${left.length === 1 ? 'is' : 'are'} not checked yet.` : ''}`;
}
