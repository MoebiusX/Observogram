// A service's SLO objectives stated in the studio ("State it…").
//
// The scan infers an SLO from each recording-rule family and gives it 99% over 30 days: a guess, which
// the grade (diagnostic-grade.mjs, schema 6) no longer counts. A person states the objective here, per
// SLO, signed and dated; the grade counts it where the repository states none — on the grade's copy of
// the pack only (`meta.studioObjectives`), never in the comparison with live.
//
// Kept per service as { slos: { '<slo id>': { objective, window, by, at } } } (the server's schema_meta
// key slo_objectives:<org>:<service>), written into the service's saved checks as `sloObjectives:`.
// Zero-import, so the board unit can be copied with it (tools/test-overview-model.mjs).

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

/** The windows the pack specification allows an SLO (tools/lib/library.mjs SLO_WINDOWS; pinned equal by a test). */
export const OBJECTIVE_WINDOWS = Object.freeze(['7d', '28d', '30d', '90d']);
export const OBJECTIVES_MAX = 200;
const ID_RE = /^[a-z0-9][a-z0-9_.:-]{0,63}$/i;
const ENTRY_KEYS = new Set(['objective', 'window', 'by', 'at']);

const validObjective = (n) => typeof n === 'number' && Number.isFinite(n) && n > 0 && n < 1;
const entriesOf = (o) => (isObj(o) && isObj(o.slos) ? Object.entries(o.slos) : []);

/**
 * Why `o` is not a service's stated objectives as a client sends them
 * ({ slos: { '<slo id>': { objective, window } } }): a list of reasons, empty when it is. null (none) is.
 */
export function objectivesErrors(o) {
  if (o === null) return [];
  if (!isObj(o) || !isObj(o.slos)) return ['objectives is { slos: { "<slo id>": { objective, window } } } or null'];
  const errors = [];
  for (const k of Object.keys(o)) if (k !== 'slos') errors.push(`${k} is not an objectives field`);
  const entries = Object.entries(o.slos);
  if (entries.length > OBJECTIVES_MAX) errors.push(`more than ${OBJECTIVES_MAX} SLOs`);
  for (const [id, e] of entries.slice(0, OBJECTIVES_MAX)) {
    const shown = JSON.stringify(String(id).slice(0, 64));
    if (!ID_RE.test(id)) { errors.push(`${shown} is not an SLO id (letters, digits, _ . : -, at most 64)`); continue; }
    if (!isObj(e)) { errors.push(`${shown} is not { objective, window }`); continue; }
    for (const k of Object.keys(e)) if (!ENTRY_KEYS.has(k)) errors.push(`${shown}: ${k} is not an objective field`);
    if (!validObjective(e.objective)) errors.push(`${shown}: objective is a number above 0 and below 1 (0.999 for 99.9%)`);
    if (!OBJECTIVE_WINDOWS.includes(e.window)) errors.push(`${shown}: window is one of ${OBJECTIVE_WINDOWS.join(', ')}`);
  }
  return errors;
}

/**
 * The objectives to keep, or null when none: each entry { objective, window, by, at }. An entry that is
 * the same as `current`'s keeps who stated it and when; a new or changed one takes `actor` and `now`.
 */
export function objectivesRecord(o, { current = null, actor = null, now = null } = {}) {
  const out = {};
  const was = isObj(current) && isObj(current.slos) ? current.slos : {};
  for (const [id, e] of entriesOf(o).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const old = isObj(was[id]) ? was[id] : null;
    const same = old && old.objective === e.objective && old.window === e.window;
    out[id] = {
      objective: e.objective, window: e.window,
      by: same && typeof old.by === 'string' ? old.by : (typeof actor === 'string' && actor ? actor : null),
      at: same && typeof old.at === 'string' ? old.at : (typeof now === 'string' && now ? now : null),
    };
  }
  return Object.keys(out).length ? { slos: out } : null;
}

/** Two objectives records the same (who and when aside). */
export const sameObjectives = (a, b) => objectivesTermKey(a) === objectivesTermKey(b);

/** The entries that read: { '<id>': { objective, window } }, sorted; {} for none. */
function readable(o) {
  const out = {};
  for (const [id, e] of entriesOf(o).slice(0, OBJECTIVES_MAX).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (ID_RE.test(id) && isObj(e) && validObjective(e.objective) && OBJECTIVE_WINDOWS.includes(e.window)) out[id] = { objective: e.objective, window: e.window };
  }
  return out;
}

/**
 * The layered pack carrying the service's stated objectives for the grade, as `meta.studioObjectives`
 * ({ '<slo id>': { objective, window } }): computeDiagnosticGrade counts one for an SLO whose own
 * objective is the scan's guess. Only the grade reads them: the comparison with live does not. None
 * stated: the same object, untouched.
 */
export function withStatedObjectives(layered, objectives) {
  const slos = readable(objectives);
  if (!Object.keys(slos).length || !isObj(layered)) return layered;
  return { ...layered, meta: { ...(isObj(layered.meta) ? layered.meta : {}), studioObjectives: slos } };
}

/**
 * The objectives a grade was given, as a key a record and the board compare ('' for none). `ids`, when
 * given, keeps only the entries a run counted (two environments with other SLO ids each compare their own).
 */
export function objectivesTermKey(o, ids = null) {
  const slos = readable(o);
  const keep = Array.isArray(ids) ? new Set(ids) : null;
  return Object.entries(slos).filter(([id]) => !keep || keep.has(id)).map(([id, e]) => `${id}=${e.objective}/${e.window}`).join(';');
}

/** A check file's `sloObjectives` (the service's, written by the studio): why it does not read, or ''. */
export function storedObjectivesError(o) {
  if (!isObj(o) || !isObj(o.slos)) return 'it is not { slos: { <slo id>: { objective, window } } }';
  const errors = objectivesErrors(o);
  return errors.length ? errors[0] : '';
}

// ---------- the form ----------

/** 0.999 → "99.9"; a percent the form shows and takes. */
export const objectivePercent = (n) => (validObjective(n) ? String(Math.round(n * 1e6) / 1e4) : '');
/** "99.9" → 0.999, or null when it is no percent above 0 and below 100. */
export function percentObjective(text) {
  const t = String(text ?? '').trim().replace(/%$/, '').trim();
  if (!/^\d{1,2}(\.\d{1,4})?$/.test(t)) return null;
  const n = Number(t) / 100;
  return validObjective(n) ? Math.round(n * 1e6) / 1e6 : null;
}

/**
 * The form's rows for one environment's pack, from the grade's Calibrated criterion over that pack
 * (`criterion.objectiveRows`, diagnostic-grade.mjs): the SLOs that take an answer first, then what the
 * form only reports.
 *   → { ask: [{ id, sli, series, percent, window, stated }], unbounded: [{ id, sli }], repository: n,
 *       elsewhere: [{ id, percent, window }] }   (elsewhere: stated for an SLO this scan does not hold)
 */
export function objectivesFormModel(criterion, objectives) {
  const rows = Array.isArray(criterion?.objectiveRows) ? criterion.objectiveRows : [];
  const stated = readable(objectives);
  const known = new Set(rows.map((r) => r.id));
  return {
    ask: rows.filter((r) => r.state === 'guessed' || r.state === 'studio').map((r) => ({
      id: r.id, sli: r.sli || r.id, series: r.series || '',
      percent: stated[r.id] ? objectivePercent(stated[r.id].objective) : '', window: stated[r.id]?.window || '30d', stated: !!stated[r.id],
    })),
    unbounded: rows.filter((r) => r.state === 'unbounded').map((r) => ({ id: r.id, sli: r.sli || r.id })),
    repository: rows.filter((r) => r.state === 'repository').length,
    elsewhere: Object.entries(stated).filter(([id]) => !known.has(id)).map(([id, e]) => ({ id, percent: objectivePercent(e.objective), window: e.window })),
  };
}

/**
 * The form's answers → { objectives, problems }: `answers` is { '<slo id>': { percent, window } }; a
 * blank percent states nothing for that SLO. `keep` are entries kept as they are (the ones for SLOs
 * this scan does not hold, unless removed).
 */
export function objectivesFromForm(answers = {}, keep = {}) {
  const slos = { ...readable({ slos: keep }) };
  const problems = [];
  for (const [id, a] of Object.entries(isObj(answers) ? answers : {})) {
    const text = String(a?.percent ?? '').trim();
    if (!text) { delete slos[id]; continue; }
    const objective = percentObjective(text);
    if (objective === null) { problems.push({ id, text: 'A percent above 0 and below 100, such as 99.9' }); continue; }
    slos[id] = { objective, window: OBJECTIVE_WINDOWS.includes(a?.window) ? a.window : '30d' };
  }
  return { objectives: Object.keys(slos).length ? { slos } : null, problems };
}
