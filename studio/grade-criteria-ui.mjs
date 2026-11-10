// studio/grade-criteria-ui.mjs
//
// A service's grade criteria where Expert shows the grade (Diagnose): which
// criteria the grade on screen is taken over, which are left out and why, and
// whether this reader may keep another set. The board (overview-view.mjs) says
// the same in its own place, with the same words (overview-model.mjs
// notGradedLines), so a criterion left out reads alike on both screens.
//
// Pure: facts in, facts and words out. The Assessment's rows and their
// switches are assessment-page.mjs's; compare-view.mjs routes the actions and
// the host keeps a set (host.setGradeCriteria). Without that hook a switch is
// a what-if only, and what is off is still said.

import { GRADE_CRITERIA, gradeOffKeys } from './diagnostic-grade.mjs';
import { notGradedLines } from './overview-model.mjs';

// The short names Diagnose gives each criterion (the verdict's coverage and
// trust, on hover), and the longer ones of "How the grade is calculated".
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
// `canSwitch`: the host keeps a set; without it `switches` is null.
// `canWrite` / `writeReason`: whether this reader may keep one (operator and above), and why not.
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
