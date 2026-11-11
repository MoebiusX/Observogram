# Platforms

*Moved from [`DOWNSTREAM.md`](DOWNSTREAM.md) §13.*

Linux and Windows are tested in CI: `npm test` runs on Ubuntu and on
`windows-latest` (GitHub-hosted, an elevated runner, Defender as the image
ships it), each on Node 22.16.0 and the latest 22, on every PR into develop or
main and every push to them. The Windows leg fails unless the run prints
README's count of `SKIP win32:` lines and runs what the Linux floor runs: the
same tests, the same harness assertions per file (fewer only under a counted
win32 skip) and the same other skips (`tools/tap-summary.mjs`, whose block
ends the job's log). The browser suites (Playwright) run on no CI leg. Windows
(Node ≥ 22.16, PowerShell or cmd) runs the CLI, the server, the studio and the
static bundle, and `npm test` is green there except the explicit skips, every
one printed as `# SKIP win32: <reason>` by `node --test` or
`- SKIP win32: <reason>` by a harness suite — never a silent pass. The skipped
facts are the ones Windows cannot express: POSIX mode bits (`0600`, `0644`,
`chmod 0000`), signal delivery (`process.kill` ends a Windows process
outright, so the store's SIGTERM/SIGINT self-close cannot be exercised) and
symlink creation (a privilege), skipped on every Windows host, elevated or
not. There are 16 skip sites — `server/test-store.mjs` (8),
`server/test-store-ops.mjs` (4), `server/test-store-import.mjs` (2),
`tools/test-journey.mjs` (1), `server/test-outbound-proxy.mjs` (1) — and
**a Windows run prints 20 `SKIP win32:` lines**, plus the PID 1 namespace test's
`# SKIP unshare --pid is unavailable here` and the browser suites' Playwright
skips when `OBSERVOGRAM_PLAYWRIGHT` is unset. Inside an export copy six more
skip, each `# SKIP an export copy: <why>`: the three tests that read the CI
workflow, which the export leaves out, and the three that export a git
checkout ([`DOWNSTREAM_REFRESH.md`](DOWNSTREAM_REFRESH.md) step 5). When the leg first went green
its summary printed Windows 10.0.26100 on 4 CPUs, Node v22.16.0 and v22.23.3
(the latest 22), the checkout on `D:` and `TEMP` an 8.3 short name on `C:`
(`C:\Users\RUNNER~1\AppData\Local\Temp`), a symlink created, and the tests the
Linux floor ran; `npm test` takes 138–219 s there. Every suite names the
platform only through `server/fixtures/platform.mjs` (`isWin32`, `isLinux`,
`PLATFORM`, `win32Skip(reason)`, `skipOnWin32(t, reason)`, and
`WIN32_PLATFORM` for a suite that fakes the platform as data);
`tools/test-platform.mjs` keeps the count and the reasons honest and proves
the module-relative resolvers (`fileURLToPath`, never `URL.pathname`, which is
`/C:/…` on Windows and percent-encoded everywhere) on every platform. The
checkout is LF everywhere (`.gitattributes`: `* text=auto eol=lf`), so the
goldens and `VENDOR-MANIFEST.json`'s sha256 verify under any `core.autocrlf`.

On Windows, today:

- The database, its backups and `users.json` are protected by their
  directories' ACLs: Windows does not enforce `0600`. Limit the workspace
  directory (and the database's, where `OBSERVOGRAM_DB` puts it elsewhere)
  to the account the server runs as, e.g. from cmd:
  `icacls C:\observogram /inheritance:r /grant:r "%USERNAME%:(OI)(CI)F"`.
- The store refuses a network filesystem on Linux only. On Windows, keep the
  database on a local disk, not a share or a mapped drive.
- Journey names that differ only in case share one definition file and one
  runs folder.
- `packc journey list`, `GET /api/journeys` and `packc journey run --all`
  follow the directory's order, which on NTFS is case-insensitive.

The CI leg is the acceptance for `windows-latest`. Your own Windows box can
still differ in ways CI cannot show: an unelevated shell, a profile path with
a space, an antivirus that holds a just-written file. To report from there,
run this from cmd or PowerShell at the checkout's root:

```
cmd /c "set NODE_OPTIONS=--test-reporter=tap&& npm test > test.tap 2>&1"
node tools/tap-summary.mjs test.tap --win32-skips readme
```

From Git Bash:

```sh
NODE_OPTIONS=--test-reporter=tap npm test > test.tap 2>&1
node tools/tap-summary.mjs test.tap --win32-skips readme
```

`NODE_OPTIONS` names the reporter because Node 23 and later print the spec
reporter even into a file; it replaces any `NODE_OPTIONS` of your own for
that run. `cmd /c` keeps the bytes; Windows PowerShell's own `>` re-encodes a
program's output through the console code page. Send the block the summary
prints: a count other than 19, or any failure, is the report. A test that
fails only on Windows is first made OS-neutral upstream; only a fact Windows
cannot express becomes a reasoned skip site, with the README counts the guard
and the Windows leg force.
