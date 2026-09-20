// tools/test-studio-graph.mjs
//
// Links the entire studio ES-module graph by dynamically importing app.mjs.
// The studio is untyped browser code — a renamed/removed export leaves a
// dangling import that node --check (parse-only) can NOT catch and nothing
// else exercises headlessly. Module LINKING resolves every import/export
// binding across the whole graph before any evaluation runs, so:
//
//   - a missing export  → SyntaxError at link time  → FAIL here
//   - successful link   → evaluation starts and dies on the first DOM
//     touch (`document is not defined`) → that ReferenceError is the PASS
//
// If the studio ever gains a headless entry (no boot() at module tail),
// a clean import becomes the pass instead.

try {
  await import('../studio/app.mjs');
  console.log('studio module graph linked and evaluated cleanly (headless).');
} catch (e) {
  const isEvalOnly = e instanceof ReferenceError
    && /\b(document|window|localStorage|navigator)\b/.test(e.message);
  if (!isEvalOnly) {
    console.error(`studio module graph failed to LINK (dangling import/export?):\n  ${e.constructor.name}: ${e.message}`);
    process.exit(1);
  }
  console.log(`studio module graph links cleanly (evaluation stopped at the expected DOM touch: ${e.message}).`);
}
