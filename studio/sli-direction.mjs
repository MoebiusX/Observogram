// studio/sli-direction.mjs
//
// The direction of a threshold SLI's bound, spelled once for the browser: the
// engine's tools/lib/good-when.mjs (spec 1.3 `good_when: below | above`;
// absent means below; the bound itself is good either way), which the studio
// cannot import — a studio module is served at the site root and resolves
// `../tools/lib/…` to a path nothing serves, while `/lib/…` resolves nowhere
// under node:test. tools/test-build-model.mjs holds the two copies together on
// every input. Zero imports; the Discover drawer, the Build cards and the
// editor read the direction through here and never the raw field.

export const GOOD_WHEN = ['below', 'above'];
export const DEFAULT_GOOD_WHEN = 'below';
export const DIRECTED_TYPES = ['threshold', 'distribution'];

/** 'above' when the SLI says so, else 'below' — absent, null, or anything the schema would refuse. */
export function goodWhen(sli) {
  return sli?.good_when === 'above' ? 'above' : DEFAULT_GOOD_WHEN;
}
/** Whether an SLI type carries a bound. */
export const hasDirection = (type) => DIRECTED_TYPES.includes(type);
/** ≤ for a ceiling (good at or below the bound), ≥ for a floor (good at or above it). */
export const boundGlyph = (sli) => (goodWhen(sli) === 'above' ? '≥' : '≤');
/** '≤ 0.5 seconds', '≥ 2 consumers' ('≤ 0.5' without a unit; '' without a bound). */
export function boundText(sli) {
  const t = sli?.threshold;
  const n = typeof t === 'number' ? String(t) : String(t ?? '').trim();
  if (!n) return '';
  const unit = String(sli?.unit ?? '').trim();
  return `${boundGlyph(sli)} ${n}${unit ? ` ${unit}` : ''}`;
}
