// studio/compare-identity.mjs — Compare's "Pair by" switch (rebadge batch 3,
// C3): behaviour (the server's answer), name or id, re-keyed in this browser
// over the two packs on screen — no refetch, no second implementation.
//
// The engine is the vendorable library itself — /lib/identity-modes.mjs
// (the modes, pairingOf) and /lib/diff.mjs (diffPacks with `identity`) —
// loaded on first use with literal specifiers, so the bundler's import map
// carries both (studio/remediation-flow-view.mjs is the precedent). Behaviour
// never runs here: it is `state.diff`, what GET /api/diff answered. A name or
// id view runs `diffPacks(pack, packB, { scopeMode, service, identity })` over
// the very packs the server diffed (GET /api/packs/:id answers exactly
// `adapt()`), checked first against the server answer's pack metadata; when
// they differ, when the engine did not load or when the taxonomy binding fell
// back, behaviour is shown with one sentence saying why.
//
// Layout (docs/UI_CONVENTIONS.md §2): the loader (compareIdentityEngine), the
// pure models (viewDiffFor, identitySwitchModel, the sentences), and the
// renderer (renderCompareIdentitySwitch). The models read no `state`.

import { escapeHtml } from './util.mjs';

export const DEFAULT_PAIRING = 'behaviour';

// What the switch draws before the engine answers, and in the bundle's
// absence of it: the registry's ids and words (tools/lib/identity-modes.mjs
// IDENTITY_MODES), so the switch has its three radios from the first paint.
// tools/test-identity-modes.mjs pins that the two agree.
export const PAIRING_MODES = Object.freeze([
  Object.freeze({ id: 'behaviour', label: 'Behaviour', matchedBy: 'behaviour', hint: 'What each artefact does (default): series, product and signal, contract handles.' }),
  Object.freeze({ id: 'name', label: 'Name', matchedBy: 'name', hint: 'The name or title only. Behaviour still decides aligned vs drifted.' }),
  Object.freeze({ id: 'id', label: 'Id', matchedBy: 'id', hint: 'Stable ids and uids only (a dashboard uid, a spec id); a family named by its name uses the name.' }),
]);

export function pairingModeOf(id) {
  return PAIRING_MODES.find((m) => m.id === id) || PAIRING_MODES[0];
}

// ---------- the loader ----------

let engine;          // undefined: not asked yet or loading; null: failed; else { identity, diff }
let engineError = '';
let loading = null;

/**
 * The engine `{ identity, diff }` when loaded, `null` when its import failed
 * (compareIdentityEngineError() says why), `undefined` while it loads — the
 * first call starts the imports and `onLoaded` runs once when they land.
 */
export function compareIdentityEngine({
  importFn = () => Promise.all([import('/lib/identity-modes.mjs'), import('/lib/diff.mjs')]),
  onLoaded = null,
} = {}) {
  if (engine !== undefined) return engine;
  if (!loading) {
    loading = Promise.resolve()
      .then(() => importFn())
      .then(([identity, diff]) => {
        if (typeof identity?.pairingOf !== 'function' || typeof diff?.diffPacks !== 'function') throw new Error('the modules do not export pairingOf and diffPacks');
        engine = { identity, diff };
      })
      .catch((e) => {
        engine = null;
        engineError = String(e?.message || e).split('\n')[0];
        console.warn(`compare pairing: /lib/identity-modes.mjs or /lib/diff.mjs did not load (${engineError}); behaviour pairing only`);
      })
      .then(() => { loading = null; if (typeof onLoaded === 'function') onLoaded(); });
  }
  return undefined;
}

export function compareIdentityEngineError() { return engineError; }

/** Tests: forget the loaded engine so the next call imports again. */
export function resetCompareIdentityEngine() { engine = undefined; engineError = ''; loading = null; }

// ---------- the models ----------

// The pack metadata the diff engine stamps on its answer (diff.mjs packMeta),
// computed from an adapted pack, to check that the packs on screen are the
// packs the server compared.
function packMetaOf(layered) {
  return JSON.stringify({
    id: layered?.id, name: layered?.name, service: layered?.meta?.service, criticality: layered?.meta?.criticality,
    environment: layered?.meta?.environment, version: layered?.meta?.version, binding: layered?.meta?.binding,
  });
}

export function packsMatchDiff(diff, pack, packB) {
  return !!diff?.a && !!diff?.b && packMetaOf(pack) === JSON.stringify(diff.a) && packMetaOf(packB) === JSON.stringify(diff.b);
}

let memo = null;

/**
 * The diff Compare draws for `mode`: `{ diff, mode, unavailable }`.
 * Behaviour is the server's `diff` itself. Name or id is re-keyed over
 * `pack` / `packB` with the engine; `unavailable` is the reason behaviour is
 * shown instead ('' when it is not). Memoised on (diff, mode, pack, packB).
 */
export function viewDiffFor({ engine: eng, diff, pack, packB, mode, taxonomyError = '' }) {
  const wanted = pairingModeOf(mode).id;
  if (wanted === DEFAULT_PAIRING || !diff || diff.error || !diff.layers) return { diff, mode: DEFAULT_PAIRING, unavailable: '' };
  if (memo && memo.diff === diff && memo.mode === wanted && memo.pack === pack && memo.packB === packB && memo.engine === eng) return memo.out;
  let out;
  if (eng === undefined) out = { diff, mode: DEFAULT_PAIRING, unavailable: 'still loading' };
  else if (!eng) out = { diff, mode: DEFAULT_PAIRING, unavailable: engineError || 'the pairing modules did not load' };
  else if (taxonomyError) out = { diff, mode: DEFAULT_PAIRING, unavailable: `the artefact taxonomy did not bind as the server's: ${taxonomyError}` };
  else if (!packsMatchDiff(diff, pack, packB)) out = { diff, mode: DEFAULT_PAIRING, unavailable: 'the packs on screen are not the ones the server compared' };
  else {
    try {
      const keyed = eng.diff.diffPacks(pack, packB, { scopeMode: diff.__for?.scopeMode || diff.scope?.mode, service: diff.__for?.service || undefined, identity: wanted });
      out = { diff: { ...keyed, traceabilityGraph: diff.traceabilityGraph, __for: diff.__for }, mode: wanted, unavailable: '' };
    } catch (e) {
      out = { diff, mode: DEFAULT_PAIRING, unavailable: String(e?.message || e).split('\n')[0] };
    }
  }
  memo = { diff, mode: wanted, pack, packB, engine: eng, out };
  return out;
}

/** The switch: the three radios, which is checked, which are disabled, and the sentence under it. */
export function identitySwitchModel({ chosen, shown, engineState, unavailable }) {
  const loadingNow = engineState === 'loading';
  const failed = engineState === 'failed' || (!!unavailable && unavailable !== 'still loading');
  return {
    checked: pairingModeOf(chosen).id,
    radios: PAIRING_MODES.map((m) => ({ ...m, disabled: m.id !== DEFAULT_PAIRING && (loadingNow || engineState === 'failed') })),
    sentence: failed ? unavailableText(unavailable || 'the pairing modules did not load') : '',
    note: shown !== DEFAULT_PAIRING ? identityNoteText(shown) : '',
  };
}

export function unavailableText(reason) {
  return `Name and id pairing could not load in this browser (${reason}) — behaviour pairing is shown.`;
}

export function identityNoteText(mode) {
  return `Paired by ${pairingModeOf(mode).matchedBy} in this browser over the two packs on screen; behaviour still decides aligned vs drifted. Chains, Diagnose and every action pair by behaviour.`;
}

/** What a change of the switch announces: 'Pairing by name: 12 in both, 9 only in A, 7 only in B.' */
export function identityAnnouncement(mode, totals) {
  const t = totals || {};
  return `Pairing by ${pairingModeOf(mode).matchedBy}: ${t.shared ?? 0} in both, ${t.onlyInA ?? 0} only in A, ${t.onlyInB ?? 0} only in B.`;
}

/** An in-both card's pill title in a name or id view; '' in behaviour (the title stays as it was). */
export function pairingTitle(eng, artefact, mode) {
  const m = pairingModeOf(mode);
  if (m.id === DEFAULT_PAIRING || !eng) return '';
  return `Paired by ${m.matchedBy}: ${eng.identity.pairingOf(artefact, m.id)}`;
}

/** Why an only-in card did not pair in a name or id view: 'has no name' / 'has no stable id', else ''. */
export function unpairedHint(eng, artefact, mode) {
  const m = pairingModeOf(mode);
  if (m.id === DEFAULT_PAIRING || !eng) return '';
  if (m.id === 'name') return eng.identity.nameOf(artefact) == null ? 'has no name' : '';
  return eng.identity.idOf(artefact) == null ? 'has no stable id' : '';
}

// ---------- the renderer ----------

/**
 * The "Pair by" fieldset into `container`: native radios (arrows, Tab and
 * Space by default), each hint as aria-describedby; `onChange(modeId)` runs
 * on a change. Draws the model only.
 */
export function renderCompareIdentitySwitch(container, model, { onChange } = {}) {
  const field = document.createElement('fieldset');
  field.className = 'compare-identity';
  const radios = model.radios.map((r) => `
    <label class="compare-identity-option">
      <input type="radio" name="compare-identity" value="${escapeHtml(r.id)}"${r.id === model.checked ? ' checked' : ''}${r.disabled ? ' disabled' : ''} aria-describedby="compare-identity-hint-${escapeHtml(r.id)}">
      <span class="compare-identity-label">${escapeHtml(r.label)}</span>
      <span class="compare-identity-hint" id="compare-identity-hint-${escapeHtml(r.id)}">${escapeHtml(r.hint)}</span>
    </label>`).join('');
  field.innerHTML = `<legend class="compare-identity-legend">Pair by</legend><div class="compare-identity-options">${radios}</div>`;
  if (model.sentence) {
    const p = document.createElement('p');
    p.className = 'compare-identity-unavailable';
    p.textContent = model.sentence;
    field.appendChild(p);
  }
  if (model.note) {
    const p = document.createElement('p');
    p.className = 'compare-identity-note';
    p.textContent = model.note;
    field.appendChild(p);
  }
  field.addEventListener('change', (e) => {
    const t = e.target;
    if (t?.name === 'compare-identity' && t.checked && typeof onChange === 'function') onChange(t.value);
  });
  container.appendChild(field);
  return field;
}
