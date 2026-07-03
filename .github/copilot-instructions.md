# Repository instructions for coding agents

Canonical agent guidance for Observogram (Copilot, Codex, Claude, and friends).
The authoritative branching contract is [docs/BRANCHING.md](../docs/BRANCHING.md);
the architecture/sequencing plan is
[docs/ARCHITECTURE_EVOLUTION.md](../docs/ARCHITECTURE_EVOLUTION.md). This file
is the condensed, agent-facing version — when in doubt, those docs win.

## Branch workflow

- Topic branches: `codex/<topic>`, created from the latest `origin/develop`,
  merged into `develop` by PR. One branch per task.
- `develop` is the default/integration branch. `main` is the release line and
  advances ONLY by promotion PR from `develop` — never push or merge to
  `main` directly.
- Always `git fetch` before pushing. Never force-push `develop` or `main`.

## Validation — the per-commit bar

- `npm run lint` (0 errors) and `npm test` (the full aggregate) must be green
  before every commit and push. There is NO build step: this is plain ESM
  `.mjs` (Node 18+), not TypeScript — do not add transpilers or a build.
- Changes visible in the studio UI must be browser-verified (boot the server,
  render the affected view, check the console) before the work is called done.
- Conventional commit messages (`feat(server): …`, `fix(studio): …`,
  `docs: …`) whose body says *why*, not just what.

## Pinned sources of truth — edit the source, run its gate

These are deliberate single sources of truth with CI gates. Never work around
them; change them at the source and update the gate in the same commit.

- **MCP tool names** live ONLY in the contract registry
  `tools/lib/contracts/mcp-capabilities.mjs` (keyed by capability; candidate
  order = fallback order; deprecation metadata on renamed tools). Never
  hardcode a tool name at a call site — `tools/test-contract-guard.mjs`
  fails the build. Changing the registry requires updating
  `EXPECTED_TOOL_SURFACE` in that guard in the same commit; the diff is the
  wire-surface changelog.
- **Compiler and crawler output is golden-gated.** Any change to what the
  crawler or a compiler *emits* must pass `npm run test:golden` (crawl) and
  `npm run test:golden:compile` (per target, per version band). For intended
  output changes, regenerate with the matching `:update` script in the same
  commit and explain the golden diff in the commit/PR description. An
  unexplained golden diff is a blocker, not a formality.
- **Product/protocol version facts** live in the data tables
  `tools/lib/profiles.mjs` and `tools/lib/protocols.mjs`, each fact with an
  upstream `evidence:` reference. Do not scatter version checks or feature
  knobs into compiler code.
- **The vendored spec** under `vendor/observability-pack-spec/` is synced,
  never hand-edited: use `npm run sync-spec`; `npm run sync-spec:check`
  verifies SHA256 integrity and runs in CI.
- **Browser-safety rule:** modules under `tools/lib/` (including
  `tools/lib/contracts/`) are imported by the studio in the browser — they
  must not import `node:*` APIs or read `process.env`. Node-only code lives
  in `tools/*.mjs`, `server/`, or `tools/lib/journey.mjs` (the known
  exception).

## Git hygiene

- Check `git status` before staging, committing, or pushing; stage only files
  related to the current task.
- Never overwrite or revert user changes unless explicitly asked.
- If a push is rejected because the remote moved, fetch and merge (never
  force-push) per the repo workflow.
- Prefer non-interactive git commands.
- End every working session with a clean tree: everything committed and
  pushed, or the unfinished remainder named explicitly in the handover note.
