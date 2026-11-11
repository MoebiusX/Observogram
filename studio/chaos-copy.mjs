// studio/chaos-copy.mjs
//
// The Diagnose blocker for Chaos-validated (studio/compare-view.mjs
// criterionBlocker), worded from the engine's proof: studio/diagnostic-grade.mjs
// chaosProof, state none | declared | stale | failed | proven. It never reads
// "is anything declared" alone, so a pack that declares five experiments and
// runs none is told to run them, not to declare one. Pure: tools/test-chaos-studio.mjs
// reads it without the app.
//
// On a pack the repository scan wrote, a hand edit lasts until the next Run,
// so the fix points at the board's Record a chaos run… (a run kept with the
// service, studio/chaos-runs.mjs) and at the repository. The scan reads its scenario tables and
// resources, and `.observability/*.yaml` carries a run's `last_result`. A pack
// scanned before the scan read chaos still carries the scan's "cannot detect"
// stamp (`unobserved.repository`), and its fix says so.

const capitalise = (s) => s[0].toUpperCase() + s.slice(1);

/**
 * chaosBlockerCopy(criterion) → the { title, why, fix } that replace the
 * blocker's generic copy (only the keys that change; {} for none on a pack
 * nobody scanned, whose generic copy already says to declare one).
 * `criterion` is the engine's Chaos-validated criterion: `proof`, `declared`,
 * `fromScan`, `unobserved`.
 */
export function chaosBlockerCopy(c = {}) {
  const proof = c.proof || { state: (c.declared || 0) > 0 ? 'declared' : 'none' };
  const record = c.fromScan
    ? 'record each run on the board (Record a chaos run… on the MTTD / MTTR tile, kept with the service), or in the repository as the experiment’s last_result in .observability/pack.yaml (the next Run reads it), or let the live check read the chaos run feed'
    : 'record each run as the experiment’s last_result, or let the live check read the chaos run feed';
  if (proof.state === 'none') {
    if (!c.fromScan) return {};
    return {
      fix: c.unobserved?.repository
        ? 'This pack was written by a repository scan that could not read chaos experiments. Scan the repository again: the scan reads scenario tables in code, Chaos Mesh and Litmus resources, and .observability/*.yaml. An experiment declared here by hand lasts only until the next Run.'
        : 'This pack was written by the repository scan, which found no chaos experiment: no scenario table in code, no Chaos Mesh or Litmus resource, nothing in .observability/*.yaml. Declare one in the repository; an experiment added here by hand lasts only until the next Run.',
    };
  }
  if (proof.state === 'declared') {
    return {
      title: 'No chaos experiment has a recorded run',
      why: 'A declared experiment says what should happen under a fault; only a passing run shows that the alerts fire and recovery works. A declared experiment earns a quarter of this check, and the rest needs a passing run within the window its schedule sets.',
      fix: `Run the experiments, then ${record}.`,
    };
  }
  if (proof.state === 'stale') {
    return {
      title: 'The last chaos pass is too old',
      why: 'A pass older than its schedule’s window says recovery worked then, not now: the service, its alerts or its runbooks may have changed since.',
      fix: `Run the experiments again, then ${record}.`,
    };
  }
  if (proof.state === 'failed') {
    return {
      title: 'A chaos experiment failed its last run',
      why: 'The fault was injected and the run failed: the expected alerts did not fire in time, or the service did not recover. That is a finding about the service, not a gap in the pack, and it earns nothing until a run passes.',
      fix: `Fix what the run found, run the experiment again, then ${record}.`,
    };
  }
  // Proven part of the way: some experiments passed a recent run, not all.
  return {
    title: 'Not every chaos experiment has a recent pass',
    why: 'Recovery is proven for the experiments that passed within their window; the others are declared, not proven, and earn a quarter each.',
    fix: `Run the remaining experiments. ${capitalise(record)}.`,
  };
}
