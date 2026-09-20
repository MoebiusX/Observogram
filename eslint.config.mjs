// ESLint flat config for Observogram.
//
// Intent: catch real correctness problems (undeclared names, unreachable
// code, duplicate object keys, broken regex, etc.) — NOT enforce a style.
// This complements the per-module `node --check` parse lints and the
// regression suites; it is deliberately light so it stays green on a
// fast-moving, single-maintainer codebase rather than becoming busywork.

import js from '@eslint/js';
import globals from 'globals';

export default [
  { ignores: ['node_modules/**', 'vendor/**', 'examples/**', 'reference-packs/**', 'coverage/**'] },

  js.configs.recommended,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
    },
    rules: {
      // Style/cosmetic findings are downgraded to warnings so they inform
      // without blocking CI. Genuine errors (no-undef, no-dupe-keys,
      // no-unreachable, …) stay at the recommended `error` level.
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
      // New-in-ESLint-10 recommended rules that flag smells, not bugs.
      // Keep them visible as warnings rather than blocking CI.
      'no-useless-assignment': 'warn',
      'preserve-caught-error': 'warn',
    },
  },

  // The studio client runs in the browser.
  {
    files: ['studio/**/*.mjs'],
    languageOptions: { globals: { ...globals.browser } },
  },

  // The server, tools, CLIs and test suites run on Node.
  {
    files: ['server/**/*.mjs', 'tools/**/*.mjs', '*.mjs'],
    languageOptions: { globals: { ...globals.node } },
  },
];
