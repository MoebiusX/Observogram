# Agent instructions

Read [.github/copilot-instructions.md](.github/copilot-instructions.md) — the
canonical agent guidance for this repo. The three rules agents break most:

1. **Never hardcode an MCP tool name.** They live only in
   `tools/lib/contracts/mcp-capabilities.mjs`; `tools/test-contract-guard.mjs`
   fails the build otherwise.
2. **Output changes are golden-gated.** `npm run test:golden` and
   `npm run test:golden:compile` must pass; intended changes regenerate
   goldens (`:update`) in the same commit with the diff explained.
3. **Branch contract:** `codex/<topic>` from `origin/develop`, PR into
   `develop`; `main` advances only by promotion PR. `npm run lint` +
   `npm test` green before every push. No build step — plain ESM, not
   TypeScript.
