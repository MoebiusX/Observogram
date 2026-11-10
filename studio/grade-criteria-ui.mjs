// studio/grade-criteria-ui.mjs
//
// A service's grade criteria where Expert shows the grade (Diagnose): which
// criteria the grade on screen is taken over, which are left out and why, and
// the switch that changes it. The board (overview-view.mjs) says the same in
// its own place, with the same words (overview-model.mjs notGradedLines), so a
// criterion left out reads alike on both screens.
//
// Pure: facts in, strings out. compare-view.mjs draws them and routes the
// actions (diag-grade-*); the host saves a switch (host.setGradeCriterion).
// Without that hook nothing is offered, and what is off is still said.

import { escapeHtml } from './util.mjs';
import { GRADE_CRITERIA, gradeOffKeys } from './diagnostic-grade.mjs';
import { notGradedLines } from './overview-model.mjs';

const LABEL = Object.fromEntries(GRADE_CRITERIA.map((c) => [c.key, c.label]));

// The short names the Diagnose measures give each criterion, and the longer
// ones of "How the grade is calculated" — with every criterion graded, both
// lists read as they always have.
export const CRITERION_SHORT = Object.freeze({
  'multi-modal': 'signal types', correlated: 'correlation', calibrated: 'calibration', comprehensive: 'breadth',
  'chaos-validated': 'recovery tested', 'drift-free': 'matches live', fresh: 'recently verified',
});
export const CRITERION_LONG = Object.freeze({
  'multi-modal': 'signal types', correlated: 'correlation', calibrated: 'calibration', comprehensive: 'breadth across layers',
  'chaos-validated': 'recovery tested by chaos', 'drift-free': 'declarations matching live', fresh: 'verified within 24 hours',
});

// criteriaScope({ service, canSwitch, canWrite, writeReason }) → the criteria of the grade on
// screen, or null when the pack is no service's own (graded on all seven, nothing to switch):
//   { serviceId, serviceName, total, graded, offKeys, notGraded: [{ key, label, text, by }],
//     switches: { enabled, reason } | null }
// `service`: the record whose primary pack is on screen ({ id, name, gradeOff }).
// `canSwitch`: the host saves a switch; without it `switches` is null.
// `canWrite` / `writeReason`: whether this reader may switch (operator and above), and why not.
export function criteriaScope({ service = null, canSwitch = false, canWrite = true, writeReason = '' } = {}) {
  if (!service || typeof service !== 'object' || service.id == null) return null;
  const off = Array.isArray(service.gradeOff) ? service.gradeOff : [];
  const offKeys = gradeOffKeys(off);
  const may = canWrite !== false;
  return {
    serviceId: service.id,
    serviceName: String(service.name || service.slug || 'this service'),
    total: GRADE_CRITERIA.length,
    graded: GRADE_CRITERIA.length - offKeys.length,
    offKeys,
    notGraded: offKeys.length ? notGradedLines(off) : [],
    switches: canSwitch ? { enabled: may, reason: may ? null : (writeReason || 'Not available for your role here.') } : null,
  };
}

const joinAnd = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

// "Fresh is not graded for this service" · "Chaos-validated and Fresh are not graded for this service" · ''.
// `labels`: the criteria left out, by their labels, in the engine's order.
export function notGradedSentence(labels) {
  const words = Array.isArray(labels) ? labels.filter(Boolean) : [];
  if (!words.length) return '';
  return `${joinAnd(words)} ${words.length === 1 ? 'is' : 'are'} not graded for this service`;
}

// A group of the engine's grade (its coverage or trust: { criteria }), by name:
// { graded: 'recovery tested, matches live', off: 'recently verified', count } —
// `names` CRITERION_SHORT or CRITERION_LONG. A criterion the grade left out
// (applies: false) is named under `off`.
export function groupNames(group, names = CRITERION_SHORT) {
  const criteria = Array.isArray(group?.criteria) ? group.criteria : [];
  const order = GRADE_CRITERIA.map((c) => c.key);
  const sorted = [...criteria].sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  const name = (c) => names[c.key] || c.label || c.key;
  const on = sorted.filter((c) => c.applies !== false);
  const off = sorted.filter((c) => c.applies === false);
  return { graded: on.map(name).join(', '), off: joinAnd(off.map(name)), count: on.length };
}

// A criterion's switch. 'off' asks why first (diag-grade-ask); 'on' grades it again
// (diag-grade-on). A reader who may not switch gets the same words, explained when
// pressed (diag-grade-explain).
export function switchHtml(switches, which, key, label = LABEL[key] || key) {
  if (!switches) return '';
  const on = which === 'on';
  const words = on ? 'Grade it again' : 'Not for this service…';
  const aria = on ? `Grade ${label} for this service again` : `Stop grading ${label} for this service`;
  return switches.enabled
    ? `<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-${on ? 'on' : 'ask'}:${escapeHtml(key)}" aria-label="${escapeHtml(aria)}">${words}</button>`
    : `<button type="button" class="ux-link-btn diag-crit-switch" data-ux-action="diag-grade-explain" aria-disabled="true" title="${escapeHtml(switches.reason || '')}" aria-label="${escapeHtml(aria)}">${words}</button>`;
}

// The ask, in place under the criterion's row: why it does not apply to this
// service, then Stop grading it (a reason is required) or Cancel.
export function askRowHtml(ask, key, { colspan = 4 } = {}) {
  const label = LABEL[key] || key;
  return `<tr class="diag-crit-ask"><td colspan="${colspan}"><div class="diag-crit-ask-row">`
    + `<label class="diag-crit-ask-l"><span>Why is ${escapeHtml(label)} not graded for this service?</span>`
    + `<input class="og-input" data-diag-grade-reason="${escapeHtml(key)}" value="${escapeHtml(ask?.reason || '')}" maxlength="200" autocomplete="off" placeholder="e.g. this project runs no fault injection"></label>`
    + `<button type="button" class="ux-secondary-btn" data-ux-action="diag-grade-off:${escapeHtml(key)}">Stop grading it</button>`
    + `<button type="button" class="ux-link-btn" data-ux-action="diag-grade-cancel">Cancel</button>`
    + '</div></td></tr>';
}

// The summary's panel: what the grade is taken over, each criterion left out —
// why, who, when — with Grade it again, and where the others are switched.
// '' when nothing is off and no switch is offered: the summary is then what it
// always was.
export function criteriaPanelHtml(scope) {
  if (!scope || (!scope.offKeys.length && !scope.switches)) return '';
  const sw = scope.switches;
  const name = escapeHtml(scope.serviceName);
  const lede = scope.offKeys.length
    ? `Graded on ${scope.graded} of ${scope.total} criteria: ${escapeHtml(notGradedSentence(scope.offKeys.map((k) => LABEL[k] || k)))}.`
    : `Graded on all ${scope.total} criteria.`;
  const off = scope.notGraded.length
    ? `<ul class="diag-criteria-off">${scope.notGraded.map((x) => `<li class="diag-criteria-item"><span class="ux-chip ux-chip-neutral">Off</span><span class="diag-criteria-text">${escapeHtml(x.text)}${x.by ? ` <span class="diag-criteria-by">${escapeHtml(x.by)}</span>` : ''}</span>${switchHtml(sw, 'on', x.key, x.label)}</li>`).join('')}</ul>`
    : '';
  const how = sw
    ? `<p class="diag-criteria-how"><span>A criterion that does not apply to ${name} is left out under Evidence: <em>Not for this service…</em> beside it, with a reason.</span><button type="button" class="ux-link-btn" data-ux-action="diag-goto:diag-evidence">Choose the criteria →</button></p>`
    : '';
  return `<section class="diag-criteria" aria-labelledby="diag-criteria-title"><h3 class="diag-measure-group-title" id="diag-criteria-title">Criteria graded for ${name}</h3><p class="diag-criteria-lede">${lede}</p>${off}${how}</section>`;
}
