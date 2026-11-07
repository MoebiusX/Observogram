// studio/symbol-refs.mjs
//
// Whether a cross-reference an artefact carries (its `refs`) resolves in its
// pack. Pure. The symbol table (app.mjs buildSymbolTable: the Broken
// references panel and the "N unresolved" badges) and the drawer's ref links
// both read it, so the two never disagree.
//
// An artefact `defines` a symbol: `slos.<id>`, `slis.<id>`, `dashboards.<id>`.
// The spec's Ref form names the same symbol with a `ref:` prefix
// (`steady_state_hypothesis: ref:slos.<id>`, an SLO's `sli: ref:slis.<id>`).
// `ref:<name>/<path>` is a vertical-composition import, outside the pack.
// `alert:<name>` names an alert rule. Alerts are no first-class symbol yet,
// so any name resolves, CamelCase Prometheus names included. The one
// exception is the placeholder the chaos scan writes when the code names no
// alert: it names none. The name mirrors tools/lib/chaos-detect.mjs
// UNRESOLVED_EXPECTED_ALERT (the live server serves tools/lib at /lib only,
// so a studio module cannot import it); tools/test-chaos-detect.mjs pins the
// two equal.

export const UNRESOLVED_ALERT_PLACEHOLDER = 'unresolved:not-in-code';

const IMPORT_RE = /^ref:[A-Za-z0-9_-]+\//;
const PLACEHOLDER_ALERT = `alert:${UNRESOLVED_ALERT_PLACEHOLDER}`;

/** The symbol a ref names inside its pack: `ref:slos.x` → `slos.x`; an import or any other ref as it is. */
export function refSymbol(ref) {
  const s = String(ref ?? '');
  return /^ref:[^/]+$/.test(s) ? s.slice('ref:'.length) : s;
}

/** Whether `ref` resolves against `defined`, the Set of the pack's `defines`. An empty ref is nothing to resolve. */
export function refResolves(ref, defined) {
  if (!ref) return true;
  if (ref.startsWith('alert:')) return ref.length > 'alert:'.length && ref !== PLACEHOLDER_ALERT;
  if (defined?.has(ref) || defined?.has(refSymbol(ref))) return true;
  return IMPORT_RE.test(ref);
}
