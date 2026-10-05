// server/fixtures/platform.mjs — the platform facts the suites share: the ONE
// place a suite names win32. Every skip states its reason, so a Windows run
// prints `# SKIP win32: <reason>` (node:test) or `- SKIP win32: <reason>`
// (a harness suite) — never a silent pass. tools/test-platform.mjs guards it:
// no other suite or fixture spells the platform, every skip call carries a
// reason, and README's "Platforms" count matches the call sites.
//
// Imports nothing (server code least of all): a tools suite imports it as
// '../server/fixtures/platform.mjs', a server suite statically or after its
// STRIP loop — server/test-hermetic-suites.mjs exempts ./fixtures/.

export const WIN32 = Object.freeze({
  modes: 'POSIX mode bits: Windows reports 0666/0444 and chmod cannot make a file unreadable',
  signals: 'signal semantics: process.kill(pid, "SIGTERM"|"SIGINT") ends a Windows process outright — no handler runs, the store cannot close itself',
  symlinks: 'symlinks: creating one needs a privilege (Developer Mode or an elevated shell) on Windows',
});

/**
 * The helpers for a given platform (injectable for the guard's own tests).
 *   isWin32, isLinux     — the facts (the one place a suite reads process.platform).
 *   win32Skip(reason)    — node:test's option form: test('…', { skip: win32Skip(WIN32.modes) }, …);
 *                          false runs the test, a string skips it with that reason.
 *   skipOnWin32(t, reason) — mid-suite: t is the node:test context (t.skip(reason) is
 *                          called) or null for a harness suite (the reason is printed as
 *                          `- SKIP win32: <reason>`); true when skipped. After
 *                          `if (skipOnWin32(t, …)) return;` nothing else may run — t.skip
 *                          does not terminate the test. A POSIX-only paragraph inside an
 *                          otherwise portable test is a subtest with the option form,
 *                          never a mid-test t.skip after assertions ran.
 */
export function platformHelpers(platform = process.platform, out = (s) => process.stdout.write(s)) {
  const isWin32 = platform === 'win32';
  const isLinux = platform === 'linux';
  const win32Skip = (reason) => (isWin32 ? `win32: ${reason}` : false);
  const skipOnWin32 = (t, reason) => {
    if (!isWin32) return false;
    const text = `win32: ${reason}`;
    if (t && typeof t.skip === 'function') t.skip(text); else out(`- SKIP ${text}\n`);
    return true;
  };
  return { isWin32, isLinux, win32Skip, skipOnWin32 };
}

export const { isWin32, isLinux, win32Skip, skipOnWin32 } = platformHelpers();
// For a printout only (a notice naming the host); a branch reads isWin32 / isLinux.
export const PLATFORM = process.platform;
