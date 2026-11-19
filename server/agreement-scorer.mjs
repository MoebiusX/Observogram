// The agreement's scorer on this server: the built-in rules (studio/agreement-score.mjs), or the
// host's own.
//
// OBSERVOGRAM_AGREEMENT_SCORER names an ES module that replaces the built-in:
//   export const scorer = { id, version, label };
//   export function score({ facts, agreement, builtIn }) → { levelMax?, dimensions, commitments }
// `facts` is commitmentFacts' answer (what the repository has behind each commitment), `agreement` the
// current version as kept, `builtIn` the built-in's own result, to start from or to ignore. `score` is
// synchronous and returns a cell per commitment and dimension ({ state: 'scored' | 'not-applicable' |
// 'not-checked', level?, why? }). Loaded once, at start. A module that does not load, or an answer
// that does not read, is said — "not scored", with why — and never replaced by the built-in's numbers:
// a host that asked for its own scoring must not be shown another's as if it were.
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resultFrom, scoreAgreement } from '../studio/agreement-score.mjs';

let custom = null;     // { scorer, score } once loaded
let fault = null;      // { scorer, reason } when the named module did not load

export async function loadAgreementScorer(log = () => {}, { path = process.env.OBSERVOGRAM_AGREEMENT_SCORER } = {}) {
  custom = null; fault = null;
  const named = typeof path === 'string' ? path.trim() : '';
  if (!named) return null;
  const label = named.split(/[\\/]/).pop();
  try {
    const mod = await import(pathToFileURL(resolve(named)).href);
    if (!mod?.scorer || typeof mod.scorer.id !== 'string' || !mod.scorer.id || typeof mod.score !== 'function') throw new Error('it exports no scorer { id, version, label } and score()');
    custom = { scorer: { id: mod.scorer.id, version: mod.scorer.version ?? null, label: mod.scorer.label || mod.scorer.id }, score: mod.score };
    log(`[studio] agreement scorer: ${custom.scorer.label} (${custom.scorer.id}${custom.scorer.version != null ? ` @ ${custom.scorer.version}` : ''}) from ${label}`);
  } catch (e) {
    fault = { scorer: { id: label, version: null, label }, reason: `the module ${label} did not load: ${String(e?.message || e).slice(0, 200)}` };
    process.stderr.write(`[studio] agreement scorer: ${fault.reason} — agreements read "not scored" until it does\n`);
  }
  return custom ? custom.scorer : null;
}

/** The agreement's result for these facts: the host's scorer when one is named, else the built-in's. */
export function scoreFacts(facts, agreement = null) {
  if (fault) return { state: 'not-scored', scorer: fault.scorer, reason: fault.reason };
  const builtIn = scoreAgreement(facts);
  if (!custom) return builtIn;
  let answer;
  try { answer = custom.score({ facts, agreement, builtIn }); }
  catch (e) { return { state: 'not-scored', scorer: custom.scorer, reason: `it threw: ${String(e?.message || e).slice(0, 200)}` }; }
  if (answer && typeof answer.then === 'function') return { state: 'not-scored', scorer: custom.scorer, reason: 'score() answered a promise: it must answer at once' };
  return resultFrom(custom.scorer, answer, facts);
}
