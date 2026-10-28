// studio/update-model.mjs
//
// The UPDATE journey's pure models (docs/UPDATE_JOURNEY.md): Build's second
// door. `update` opens an existing pack on Build's own screen, Compile lists
// the changes since the saved version, Verify shows the saved pack beside the
// pack with the changes and saves the next version of the same pack.
//
// Everything here is computed from the reopen answer (POST /api/library/reopen),
// the draft (state.build) and the instantiate answer (whose `review` is the
// server's artefact-by-artefact comparison with the saved pack). No DOM, no
// fetch, no engine import: the studio reaches tools/lib only through the API,
// so the two engine rules it needs to spell — the next version, an addition's
// label — are restated here in the engine's own words.

/** `0.1.0` → `0.2.0` — the version Save writes (the engine's rule, tools/lib/pack-update.mjs nextVersion, restated for the studio). */
export function nextVersionOf(version) {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)/.exec(String(version || '').trim());
  return m ? `${m[1]}.${Number(m[2]) + 1}.0` : '0.2.0';
}

export const ADDITION_KINDS = ['slo', 'route', 'alert_rule'];
export const SEVERITIES = ['SEV1', 'SEV2', 'SEV3', 'SEV4'];
export const CHANNEL_KINDS = ['msteams', 'voice', 'whatsapp', 'email', 'webhook'];
export const SLO_WINDOWS = ['7d', '28d', '30d', '90d'];
export const ALERT_ENGINES = ['prometheus', 'mimir', 'thanos', 'victoriametrics', 'loki', 'grafana', 'alertmanager'];
/** The default burn-rate windows of an added SLO (the engine's BURN_PROFILES: availability for a ratio SLI, latency for a threshold one; tier-3 demotes one step). */
const BURN_DEFAULTS = {
  ratio: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV1' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV2' }],
  threshold: [{ short: '5m', long: '1h', factor: 14, severity: 'SEV2' }, { short: '30m', long: '6h', factor: 6, severity: 'SEV3' }],
};
const DEMOTE = { SEV1: 'SEV2', SEV2: 'SEV3', SEV3: 'SEV3', SEV4: 'SEV4' };
export function defaultBurnWindows(sliType, tier) {
  return (BURN_DEFAULTS[sliType] || BURN_DEFAULTS.ratio).map(w => ({ ...w, severity: tier === 'tier-3' ? DEMOTE[w.severity] : w.severity }));
}

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const sameJson = (a, b) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
const pct = (objective) => (typeof objective === 'number' ? `${Number((objective * 100).toFixed(4))}%` : '');

/** One line for an addition, in the user's terms (the engine's additionLabel, restated). */
export function additionLabel(a) {
  if (!isObj(a)) return 'an addition';
  if (a.kind === 'slo') return `SLO ${a.slo?.id || sloIdFor(a.slo?.sli, a.slo?.objective)} ${pct(a.slo?.objective)} on ${a.slo?.sli || '?'}, with its burn-rate alert`.replace(/\s+/g, ' ').trim();
  if (a.kind === 'route') {
    const ch = (a.route?.channels || []).map(c => { const k = Object.keys(c)[0]; return `${k} ${c[k]}`; }).join(', ');
    return `route ${a.route?.severity || '?'} → ${ch || '?'}`;
  }
  if (a.kind === 'alert_rule') return `alert rule ${a.rule?.name || '?'}${a.rule?.severity ? ` (${a.rule.severity})` : ''}`;
  return `an addition (${a.kind})`;
}
/** `availability` at 0.9995 → `availability_99_95` (the engine's sloIdFor). */
export function sloIdFor(sliId, objective) {
  if (!sliId || typeof objective !== 'number') return '';
  return `${sliId}_${Number((objective * 100).toFixed(4)).toString().replace('.', '_')}`;
}

// ---------------------------------------------------------------------------
// 1. Open — can the studio reopen this pack without losing anything?
// ---------------------------------------------------------------------------

/** The draft fields a reopen answer opens Build with (its inputs → state.build's fields). */
export function draftFromReopen(reopen, { additions = null, from = null } = {}) {
  const i = reopen?.inputs || {};
  const fields = {
    name: i.name || reopen?.name || '',
    owners: (i.owners || []).join(', '),
    environment: i.environment || reopen?.environment || 'prod',
    tier: i.tier || 'tier-2',
    entries: (i.entries || []).map(e => e.id),
    params: clone(i.params) || {},
    slis: Array.isArray(i.toggles?.slis) ? [...i.toggles.slis] : null,
    toggles: Object.fromEntries(['slos', 'policy', 'routes', 'dashboards', 'validation'].map(k => [k, i.toggles?.[k] !== false])),
    overrides: clone(i.overrides) || {},
    custom: clone(i.custom) || [],
    additions: clone(additions ?? reopen?.additions ?? []),
    seeded: true,
    step: 'compile',
    registeredId: null,
    serviceId: null,
    update: { id: reopen.id, name: reopen.name, version: reopen.version, label: reopen.label || reopen.name, environment: reopen.environment || null, from },
  };
  fields.opened = openedSnapshot(fields);
  return fields;
}

/** The definition as opened — what "Changes since v0.1.0" compares with. */
export function openedSnapshot(b) {
  return clone({
    tier: b.tier, entries: b.entries || [], params: b.params || {}, slis: b.slis ?? null, toggles: b.toggles || {},
    overrides: b.overrides || {}, custom: b.custom || [], additions: b.additions || [], owners: b.owners || '', environment: b.environment || '',
  });
}

const ORIGIN_WORD = { build: 'made in Build', scan: 'scanned from a repository', live: 'drafted from live', hand: 'uploaded', example: 'ships with the studio' };

/** The Open stage's context line: `checkout · prod · v0.1.0 · made in Build`. */
export function openContext(reopen) {
  return [
    { key: 'Pack', value: reopen?.name || reopen?.label || reopen?.id || '' },
    { key: 'Environment', value: reopen?.environment || '' },
    { key: 'Version', value: reopen?.version ? `v${reopen.version}` : '' },
    { key: 'Origin', value: ORIGIN_WORD[reopen?.origin] || '' },
  ];
}

const CAN_BUILD = [
  'Any SLI: add one, change its objective, window, threshold, direction or expression, rename or remove it',
  'A second SLO on an SLI, with its own burn-rate alert — added on top of Build’s output and kept across every regenerate',
  'A route (severity → channels) beside the generated ones; a plain alert rule',
  'The values: channels, pager, endpoints, versions, runbook folder; a whole section on or off; the technology and the tier',
];
const CANNOT_BUILD = [
  'The windows of an alert Build generated, or a generated route — by file until slice 3',
  'Recording rules, dashboards and panels, backends, pipelines, baselines — by file until slice 3',
];

/** Whether Build holds work that opening another pack would replace: a seeded draft not yet saved, of another pack (or a new one). */
export function draftIsBusy(draft, packId) {
  if (!draft) return false;
  if (draft.update?.id && draft.update.id === packId) return false;   // the same pack: resume it
  if (draft.registeredId) return false;                                // saved: nothing to lose
  return !!(draft.seeded || draft.result) && ((draft.entries || []).length > 0 || (draft.custom || []).length > 0);
}

/**
 * The Open stage's decision over a reopen answer and the current draft:
 *   { kind: 'open' | 'busy' | 'differs' | 'foreign' | 'origin' | 'superseded' | 'error' | 'unavailable',
 *     context, sentence, items, can, cannot, actions: [{ id, label, primary }], notice, adopted }
 * 'open' lands on Compile with `notice`; the others draw one panel. `kind: 'differs'` opens on the user's say
 * ('open-with-build-values'); 'foreign' with leftovers cannot open before slice 3. An adoptable foreign artefact
 * (an SLO with its alert, a route, an alert rule) is read in as an addition and said in the notice.
 */
export function openDecision({ reopen, draft = null, access = { canWrite: true } } = {}) {
  const context = openContext(reopen);
  const name = reopen?.name || reopen?.label || 'this pack';
  const v = reopen?.version ? `v${reopen.version}` : '';
  const base = { context, items: [], can: [], cannot: [], actions: [], notice: '', adopted: [] };
  if (access?.canWrite === false) {
    return { ...base, kind: 'unavailable', sentence: `Updating a pack ${access.reason || 'needs the operator role here'}.`, actions: [{ id: 'leave', label: 'Back' }] };
  }
  if (!reopen?.ok) return { ...base, kind: 'error', sentence: (reopen?.errors || ['The pack could not be read.']).join(' '), actions: [{ id: 'leave', label: 'Back' }] };
  if (reopen.head?.id) {
    return { ...base, kind: 'superseded', sentence: `${name} was saved as v${reopen.head.version || '?'} since ${v} — the newer version is the one to update.`, actions: [{ id: 'open-head', label: `Open ${name} v${reopen.head.version || '?'}`, primary: true }, { id: 'leave', label: 'Leave it' }] };
  }
  if (reopen.origin !== 'build') {
    return { ...base, kind: 'origin', origin: reopen.origin, sentence: reopen.originSentence || 'This pack has no definition Build can reopen.', cannot: [reopen.origin === 'scan' || reopen.origin === 'live' ? 'Edited in place — a reading is replaced by the next scan or draft, never changed here (slice 3: Keep as my pack)' : 'Opened in Build — it has no definition to rebuild from'], actions: [{ id: 'leave', label: 'Back' }] };
  }
  if (reopen.errors?.length) return { ...base, kind: 'error', sentence: reopen.errors.join(' '), actions: [{ id: 'leave', label: 'Back' }] };
  if (draftIsBusy(draft, reopen.id)) {
    const what = draft.update?.id ? `updating ${draft.update.name || draft.name || 'another pack'}` : `building ${draft.name || 'a new pack'}`;
    const n = changesSince(draft).count;
    const changes = draft.update?.id ? ` (${n} change${n === 1 ? '' : 's'}, not saved)` : ' (not saved)';
    return {
      ...base, kind: 'busy', sentence: `You are ${what}${changes}.`,
      items: draft.update?.id ? changesSince(draft).rows.map(r => r.text) : [],
      actions: [{ id: 'continue', label: 'Continue it', primary: true }, { id: 'discard', label: `Discard it and open ${name}` }],
    };
  }
  const adoptable = reopen.adoptable || { additions: [], leftover: [] };
  const differences = reopen.differences || [];
  const missing = reopen.missing || [];
  if (adoptable.leftover.length) {
    return {
      ...base, kind: 'foreign',
      sentence: `This pack holds ${adoptable.leftover.length} thing${adoptable.leftover.length === 1 ? '' : 's'} Build did not write.`,
      items: adoptable.leftover.map(l => `${labelOf(l)} — ${l.reason}`),
      can: adoptable.additions.length ? [`${adoptable.additions.length} other${adoptable.additions.length === 1 ? '' : 's'} could be read in as additions: ${adoptable.additions.map(additionLabel).join('; ')}`] : [],
      cannot: ['Opened here before slice 3 — the alternative is a new pack under a new name, without the things named above. The original is never changed.'],
      actions: [{ id: 'leave', label: 'Leave the pack as it is', primary: true }],
    };
  }
  const adopted = adoptable.additions.map(additionLabel);
  if (differences.length || missing.length) {
    const n = differences.length + missing.length;
    return {
      ...base, kind: 'differs',
      sentence: `Build would write ${n} value${n === 1 ? '' : 's'} differently today.`,
      items: [
        ...differences.map(d => `${d.key.replace(/^([a-z_]+):/, (_, k) => `${k} `)}: ${(d.fields || []).map(f => `${f.field || 'value'} ${short(f.a)} → ${short(f.b)}`).join(', ') || 'differs'}`),
        ...missing.map(m => `${labelOf(m)}: in Build’s output, not in the pack`),
      ],
      can: ['Open with Build’s values — each then appears on Verify as a change, pack value beside Build’s', ...CAN_BUILD.slice(0, 2)],
      cannot: ['Keep a value as the pack has it, when it is not an SLI’s — before slice 3 the choice is Build’s values or leaving the pack as it is', ...CANNOT_BUILD],
      notes: (reopen.notes || []).map(x => x.note),
      adopted,
      actions: [{ id: 'open-with-build-values', label: 'Open with Build’s values', primary: true }, { id: 'leave', label: 'Leave the pack as it is' }],
    };
  }
  const notice = `Opened ${name} ${v}. Build rebuilt it from its own definition and got the same pack.`
    + (adopted.length ? ` ${adopted.length} thing${adopted.length === 1 ? '' : 's'} added by hand ${adopted.length === 1 ? 'was' : 'were'} read in as additions: ${adopted.join('; ')}.` : '');
  return { ...base, kind: 'open', sentence: notice, notice, adopted, can: CAN_BUILD, cannot: CANNOT_BUILD, actions: [] };
}
const short = (v) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s == null ? '—' : s.length > 40 ? `${s.slice(0, 37)}…` : s; };
const labelOf = (x) => x?.label || String(x?.key || '').replace(/^([a-z_]+):/, (_, k) => `${k.replace(/_/g, ' ')} `);

// ---------------------------------------------------------------------------
// 2. Compile — "Changes since v0.1.0": one row per thing the user did, with undo
// ---------------------------------------------------------------------------

/**
 * The changes between the draft and the definition it was opened with: `{ rows: [{ key, text, restore }], count }`,
 * `restore` being the patch that undoes the row. An addition is one row; a changed SLI value one row per field.
 */
export function changesSince(build) {
  const o = build?.opened;
  const rows = [];
  if (!o) return { rows, count: 0 };
  const row = (key, text, restore) => rows.push({ key, text, restore });
  if (build.tier !== o.tier) row('tier', `Tier ${o.tier} → ${build.tier}`, { tier: o.tier });
  if (!sameJson(build.entries || [], o.entries || [])) {
    const added = (build.entries || []).filter(e => !(o.entries || []).includes(e));
    const removed = (o.entries || []).filter(e => !(build.entries || []).includes(e));
    row('entries', [added.length ? `Added ${added.join(', ')}` : '', removed.length ? `Removed ${removed.join(', ')}` : ''].filter(Boolean).join(' · ') || 'Technology changed', { entries: clone(o.entries) });
  }
  if (!sameJson(build.slis ?? null, o.slis ?? null)) {
    const a = new Set(build.slis || []), b = new Set(o.slis || []);
    const added = [...a].filter(x => !b.has(x)), removed = [...b].filter(x => !a.has(x));
    row('slis', [added.length ? `Added SLI ${added.join(', ')}` : '', removed.length ? `Removed SLI ${removed.join(', ')}` : ''].filter(Boolean).join(' · ') || 'SLI selection changed', { slis: clone(o.slis) });
  }
  for (const k of ['slos', 'policy', 'routes', 'dashboards', 'validation']) {
    const now = build.toggles?.[k] !== false, was = o.toggles?.[k] !== false;
    if (now !== was) row(`toggle:${k}`, `Section ${k} switched ${now ? 'on' : 'off'}`, { toggles: { ...(build.toggles || {}), [k]: was } });
  }
  const params = build.params || {}, oparams = o.params || {};
  for (const k of new Set([...Object.keys(params), ...Object.keys(oparams)])) {
    if (sameJson(params[k], oparams[k])) continue;
    const text = oparams[k] === undefined ? `Filled ${k} → ${params[k]}` : params[k] === undefined ? `Cleared ${k} (was ${oparams[k]})` : `Changed ${k} ${oparams[k]} → ${params[k]}`;
    const restored = { ...params }; if (oparams[k] === undefined) delete restored[k]; else restored[k] = oparams[k];
    row(`param:${k}`, text, { params: restored });
  }
  const ov = build.overrides || {}, oov = o.overrides || {};
  for (const sli of new Set([...Object.keys(ov), ...Object.keys(oov)])) {
    for (const f of new Set([...Object.keys(ov[sli] || {}), ...Object.keys(oov[sli] || {})])) {
      if (sameJson(ov[sli]?.[f], oov[sli]?.[f])) continue;
      const was = oov[sli]?.[f], now = ov[sli]?.[f];
      const text = f === 'objective' ? `${sli}: objective ${was == null ? 'library’s' : pct(was)} → ${now == null ? 'library’s' : pct(now)}` : `${sli}: ${f} ${was == null ? 'library’s' : short(was)} → ${now == null ? 'library’s' : short(now)}`;
      const restored = clone(ov); if (!restored[sli]) restored[sli] = {};
      if (was === undefined) delete restored[sli][f]; else restored[sli][f] = was;
      if (!Object.keys(restored[sli]).length) delete restored[sli];
      row(`override:${sli}.${f}`, text, { overrides: restored });
    }
  }
  const custom = build.custom || [], ocustom = o.custom || [];
  for (const c of custom) { const was = ocustom.find(x => x.id === c.id); if (!was) row(`custom:${c.id}`, `Added custom SLI ${c.id}`, { custom: clone(ocustom) }); else if (!sameJson(c, was)) row(`custom:${c.id}`, `Changed custom SLI ${c.id}`, { custom: clone(ocustom) }); }
  for (const c of ocustom) if (!custom.find(x => x.id === c.id)) row(`custom:${c.id}`, `Removed custom SLI ${c.id}`, { custom: clone(ocustom) });
  const adds = build.additions || [], oadds = o.additions || [];
  adds.forEach((a, i) => { if (!oadds.some(x => sameJson(x, a))) row(`addition:${i}`, `Added ${additionLabel(a)}`, { additions: adds.filter((_, j) => j !== i) }); });
  oadds.forEach((a) => { if (!adds.some(x => sameJson(x, a))) row(`addition-removed:${additionLabel(a)}`, `Removed ${additionLabel(a)}`, { additions: [...adds, clone(a)] }); });
  if ((build.owners || '') !== (o.owners || '')) row('owners', `Owners ${o.owners || 'none'} → ${build.owners || 'none'}`, { owners: o.owners });
  if ((build.environment || '') !== (o.environment || '')) row('environment', `Environment ${o.environment} → ${build.environment}`, { environment: o.environment });
  return { rows, count: rows.length };
}

// ---------------------------------------------------------------------------
// 3. Verify — the saved pack beside the pack with the changes
// ---------------------------------------------------------------------------

const LIVE_KINDS = new Set(['slo', 'burn_rate', 'alert_rule', 'recording_rule', 'dashboard', 'forecast']);
const kindOf = (key) => String(key || '').split(':')[0];
const idOf = (key) => String(key || '').replace(/^[a-z_]+:/, '').replace(/#\d+$/, '');

/**
 * The review on Verify: `review` is the instantiate answer's (the server's comparison with the saved pack). Returns
 *   { base, next, numbers: { onlySaved, both, changed, onlyNext }, sentence, rows, also, gone, live, primary, secondary, explainedBy }
 * — `rows` the artefacts the changes list explains (an addition, a changed SLI), `also` the rest ("Also changes"),
 * `gone` the artefacts no longer in the pack that may still be live. Null when the draft is not an update or the
 * answer carries no review.
 */
export function reviewModel({ build, result, access = { canWrite: true } } = {}) {
  const u = build?.update;
  const rv = result?.review;
  if (!u?.id) return null;
  if (!rv || rv.error) return { base: { id: u.id, version: u.version, name: u.name }, next: { version: nextVersionOf(u.version) }, error: rv?.error || 'The saved pack was not compared yet — the pack regenerates first.', rows: [], also: [], gone: [], numbers: null };
  const changes = changesSince(build);
  // What the changes list explains: an addition's artefacts, the SLIs whose values changed (their SLO, alert, rules and boards carry the SLI's id).
  const explained = new Map();
  for (const a of build.additions || []) {
    const label = `Added ${additionLabel(a)}`;
    if (a.kind === 'slo') { const id = a.slo?.id || sloIdFor(a.slo?.sli, a.slo?.objective); explained.set(`slo:${id}`, label); explained.set(`burn_rate:${id}`, label); }
    else if (a.kind === 'alert_rule') explained.set(`alert_rule:${a.rule?.name}`, label);
    else if (a.kind === 'route') explained.set(`route:${a.route?.severity}`, label);
  }
  const sliRows = changes.rows.filter(r => r.key.startsWith('override:') || r.key.startsWith('custom:') || r.key === 'slis');
  const touchesSli = (key) => sliRows.find(r => { const sli = r.key.startsWith('override:') ? r.key.slice(9).split('.')[0] : r.key.startsWith('custom:') ? r.key.slice(7) : null; return sli ? idOf(key).includes(sli) : r.key === 'slis'; });
  const explain = (key) => explained.get(key) || (explained.has(`${kindOf(key)}:${idOf(key)}`) ? explained.get(`${kindOf(key)}:${idOf(key)}`) : null) || touchesSli(key)?.text || null;
  const rowOf = (kind, x) => ({ kind, key: x.key, label: x.label || labelOf(x), fields: x.fields || [], saved: x.saved ?? x.value, next: x.next ?? x.value, why: explain(x.key) });
  const all = [
    ...(rv.onlyInNext || []).map(x => rowOf('added', x)),
    ...(rv.changed || []).map(x => rowOf('changed', x)),
    ...(rv.onlyInSaved || []).map(x => rowOf('removed', x)),
  ];
  const rows = all.filter(r => r.why);
  const also = all.filter(r => !r.why);
  const n = { onlySaved: (rv.onlyInSaved || []).length, changed: (rv.changed || []).length, onlyNext: (rv.onlyInNext || []).length, both: (rv.same || 0) + (rv.changed || []).length };
  const total = n.onlySaved + n.changed + n.onlyNext;
  const meets = result?.summary?.conformant;
  const tier = result?.summary?.tier || build?.tier || '';
  const sentence = total === 0 ? 'No change against the saved version yet.'
    : `${total} change${total === 1 ? '' : 's'}: ${n.onlyNext} artefact${n.onlyNext === 1 ? '' : 's'} added, ${n.changed} changed, ${n.onlySaved === 0 ? 'none' : n.onlySaved} removed.`
      + (meets === true ? ` The pack still meets ${tier}.` : meets === false ? ` The pack does not meet ${tier}.` : '');
  const gone = all.filter(r => (r.kind === 'removed' || (r.kind === 'changed' && kindOf(r.key) === 'slo')) && LIVE_KINDS.has(kindOf(r.key)));
  const writable = access?.canWrite !== false;
  const nextV = nextVersionOf(u.version);
  return {
    base: { id: u.id, version: u.version, name: u.name, count: (rv.same || 0) + (rv.changed || []).length + (rv.onlyInSaved || []).length },
    next: { version: nextV, count: (rv.same || 0) + (rv.changed || []).length + (rv.onlyInNext || []).length },
    numbers: n, total, sentence, rows, also, gone,
    changes: changes.rows.map(r => r.text),
    live: { text: 'Not checked here. Compare the saved version with the live pack after saving to see whether every new expression is reported.' },
    primary: writable && total > 0 ? { id: 'build-save-update', label: `Save as ${u.name} v${nextV}`, action: 'save-update' } : null,
    secondary: writable ? [{ id: 'build-save-new', label: 'Save as a new pack…', action: 'open-discover', title: 'Register the pack with the changes as a separate pack; the one you opened is left as it is.' }] : [],
    unchanged: total === 0,
    saveError: build?.saveError || null,
  };
}

/** The hand-off message after a Save, built only from what the answer says. */
export function handoffSentence({ name, version, previousVersion, changes = 0 } = {}) {
  return `Saved ${name} v${version} — ${changes} change${changes === 1 ? '' : 's'}. v${previousVersion || '?'} is kept under it. `
    + 'No deploy of the new version is recorded here. Export it for the repository: routes, pipelines and backend values leave by export; rules and dashboards also by deploy.';
}

// ---------------------------------------------------------------------------
// 4. The add forms — + SLO · + Route · + Alert rule
// ---------------------------------------------------------------------------

/** A fresh form draft for an addition of `kind`, prefilled from the pack (the SLIs it holds, the tier's windows). */
export function addDraft(kind, { build, result } = {}) {
  const slis = (result?.canonical?.spec?.slis || []).map(s => ({ id: s.id, type: s.type }));
  if (kind === 'slo') {
    const first = slis[0] || { id: '', type: 'ratio' };
    return { kind, sli: first.id, objective: '99.95', window: '30d', windows: defaultBurnWindows(first.type, build?.tier) };
  }
  if (kind === 'route') return { kind, severity: 'SEV2', channels: [{ kind: 'webhook', address: '' }] };
  return { kind, name: '', expr: '', severity: 'SEV3', for: '5m', engine: '' };
}

/** The form's model: its fields, choices and the errors on the draft as typed (`ok` when it can be added). */
export function addFormModel(draft, { result } = {}) {
  const slis = (result?.canonical?.spec?.slis || []).map(s => ({ id: s.id, type: s.type }));
  const errors = {};
  const d = draft || {};
  if (d.kind === 'slo') {
    const sli = slis.find(s => s.id === d.sli);
    if (!sli) errors.sli = 'pick an SLI of the pack';
    const o = Number(String(d.objective ?? '').trim());
    if (!(o > 0 && o < 100)) errors.objective = 'a percentage between 0 and 100 (99.95)';
    if (!SLO_WINDOWS.includes(d.window)) errors.window = `one of ${SLO_WINDOWS.join(', ')}`;
    const id = sli && o > 0 && o < 100 ? sloIdFor(sli.id, o / 100) : '';
    if (id && (result?.canonical?.spec?.slos || []).some(s => s.id === id)) errors.objective = `the pack already has the SLO ${id}`;
    (d.windows || []).forEach((w, i) => {
      if (!/^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/.test(String(w.short || ''))) errors[`windows.${i}.short`] = 'a duration (5m)';
      if (!/^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/.test(String(w.long || ''))) errors[`windows.${i}.long`] = 'a duration (1h)';
      if (!(Number(w.factor) > 1)) errors[`windows.${i}.factor`] = 'a number above 1';
      if (!SEVERITIES.includes(w.severity)) errors[`windows.${i}.severity`] = 'a severity';
    });
    if ((d.windows || []).length < 2) errors.windows = 'two windows at least';
    return { kind: 'slo', title: 'Add an SLO', lede: 'A second objective on an SLI the pack already measures, with its own burn-rate alert. It is added on top of Build’s output and kept across every regenerate; it is not on the boards and has no forecast until slice 3.', slis, id, errors, ok: !Object.keys(errors).length, draft: d, windows: SLO_WINDOWS, severities: SEVERITIES };
  }
  if (d.kind === 'route') {
    if (!SEVERITIES.includes(d.severity)) errors.severity = 'a severity';
    if (!(d.channels || []).length) errors.channels = 'one channel at least';
    (d.channels || []).forEach((c, i) => {
      if (!CHANNEL_KINDS.includes(c.kind)) errors[`channels.${i}.kind`] = 'a channel kind';
      if (!String(c.address || '').trim()) errors[`channels.${i}.address`] = 'an address';
      else if (c.kind === 'webhook' && !/^https?:\/\/\S+$/i.test(c.address.trim())) errors[`channels.${i}.address`] = 'an http(s) URL';
    });
    return { kind: 'route', title: 'Add a route', lede: 'A route beside the generated ones: the severity goes to these channels as well as to the existing ones. A generated route cannot be changed or removed before slice 3. Routes are an Alertmanager file: they leave by Export, not by deploy.', errors, ok: !Object.keys(errors).length, draft: d, severities: SEVERITIES, channelKinds: CHANNEL_KINDS };
  }
  const name = String(d.name || '').trim();
  if (!name || name.length > 190) errors.name = '1 to 190 characters';
  else if ((result?.canonical?.spec?.alerting?.rules || []).some(r => r.name === name)) errors.name = `the pack already has an alert rule named ${name}`;
  if (!String(d.expr || '').trim()) errors.expr = 'the condition, in the engine’s own language';
  if (d.severity && !SEVERITIES.includes(d.severity)) errors.severity = 'a severity';
  if (d.for && !/^([0-9]+(\.[0-9]+)?(ns|us|ms|s|m|h|d|w|mo|y))+$/.test(String(d.for))) errors.for = 'a duration (5m)';
  if (d.engine && !ALERT_ENGINES.includes(d.engine)) errors.engine = 'an engine';
  return { kind: 'alert_rule', title: 'Add an alert rule', lede: 'A plain alert rule (spec 1.4 alerting.rules): a condition the engine evaluates, not a burn rate on an SLO. It compiles to its own rule file and deploys with the rules.', errors, ok: !Object.keys(errors).length, draft: d, severities: SEVERITIES, engines: ALERT_ENGINES };
}

/** The addition an add form yields (the engine's shape), or null while the form has errors. */
export function toAddition(draft, ctx = {}) {
  const m = addFormModel(draft, ctx);
  if (!m.ok) return null;
  const d = m.draft;
  if (d.kind === 'slo') {
    const objective = Number((Number(String(d.objective).trim()) / 100).toFixed(6));
    return { kind: 'slo', slo: { id: m.id, sli: d.sli, objective, window: d.window }, burn_rate: { windows: d.windows.map(w => ({ short: String(w.short), long: String(w.long), factor: Number(w.factor), severity: w.severity })) } };
  }
  if (d.kind === 'route') return { kind: 'route', route: { severity: d.severity, channels: d.channels.map(c => ({ [c.kind]: c.address.trim() })) } };
  const rule = { name: d.name.trim(), expr: d.expr.trim() };
  if (d.severity) rule.severity = d.severity;
  if (d.for) rule.for = String(d.for).trim();
  if (d.engine) rule.engine = d.engine;
  return { kind: 'alert_rule', rule };
}

// ---------------------------------------------------------------------------
// 5. The catalogue — which packs can be updated, and the picker's version rows
// ---------------------------------------------------------------------------

const BUILT_HINT = /^Uploaded pack\s+—\s+library:/;
/** The workspace's packs an update can open: made in Build (their source says `library:`), the current version of each, newest first. */
export function updatablePacks(catalog = []) {
  return (catalog || []).filter(p => p?.ok !== false && p.source === 'uploaded' && BUILT_HINT.test(String(p.description || '')) && !p.superseded)
    .map(p => ({ id: p.id, label: p.label || p.name || p.id, name: p.name || p.label || p.id, version: p.version || '?', origin: 'made in Build', earlier: (catalog || []).filter(e => e.head === p.id).length }))
    .reverse();
}

/** The pack picker's rows: every head in catalogue order, each followed by its earlier versions (newest first), marked `earlier`. */
export function pickerRows(packs = []) {
  const byHead = new Map();
  for (const p of packs) if (p?.superseded && p.head) { if (!byHead.has(p.head)) byHead.set(p.head, []); byHead.get(p.head).push(p); }
  const out = [];
  for (const p of packs) {
    if (p?.superseded && p.head && packs.some(h => h.id === p.head)) continue;
    out.push({ ...p, earlier: false });
    for (const e of (byHead.get(p.id) || []).slice().reverse()) out.push({ ...e, earlier: true });
  }
  return out;
}
