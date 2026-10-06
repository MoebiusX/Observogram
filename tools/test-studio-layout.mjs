#!/usr/bin/env node
// tools/test-studio-layout.mjs — nothing in the studio opens behind its header.
//
// Two bars are pinned at the top of the studio: the chrome (the stepper,
// --observa-chrome-h) and, under it, the context bar with the pack pickers
// and operations (--ux-context-h, measured at run time because it wraps onto
// a second row). Anything else that pins or floats — a panel, a drawer, a
// sticky strip — must start below BOTH, or its head sits behind them: the bug
// that hid the MCP, draft and scan panels and the artefact drawers' titles.
//
// So every `position: fixed | sticky` rule in studio/*.css is classified
// here. CLEARS: it must have a rule whose `top` adds both heights. EXEMPT: it
// is not under the bars, with the reason. A new pinned element fails the
// suite until it is put in one list or the other.
//
// Run: node --test tools/test-studio-layout.mjs

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const dir = new URL('../studio/', import.meta.url);

// Every rule of every stylesheet: { file, selector, body }. Comments are
// dropped first; a rule inside an @media block is found like any other.
function rules() {
  const out = [];
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith('.css')).sort()) {
    const css = fs.readFileSync(new URL(file, dir), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ file, selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] });
    }
  }
  return out;
}
const pinned = (r) => /position:\s*(fixed|sticky)/.test(r.body);
const topOf = (r) => /(?<![-\w])top:\s*([^;]+);/.exec(r.body)?.[1].trim() ?? null;
// The element a rule is about: the last compound of each selector in the list.
const subjects = (selector) => selector.split(',').map(s => s.trim().split(/\s+/).at(-1));

// Pinned or floating under the two bars: `top` must add both heights.
const CLEARS = [
  '.mcp-panel',            // Refresh from MCP
  '.crawl-panel',          // Scan a repo · Draft from a live MCP server
  '.drawer',               // the artefact drawers (right; Pack A's on the left in Compare)
  '.ux-decision.is-sticky',
  '.ux-section-nav',
  '.diag-sticky',
  '.compare-cols-head',    // Compare's pinned Pack A | Pack B heads
];

// Pinned, but not under the bars.
const EXEMPT = {
  'body::before': 'the page backdrop',
  '.observa-hdr': 'the chrome itself',
  '.hdr': 'the context bar itself: pinned under the chrome by its height',
  '.drawer-head': 'sticky inside the drawer, which scrolls on its own',
  '.toast': 'bottom of the window',
  '.no-backend-notice': 'bottom of the window, like .toast — the static bundle\'s notice (studio/static-backend.mjs; the live studio never links its stylesheet)',
  '.drop-overlay': 'covers the whole window while a file is dragged over it',
  '.deploy-modal': 'a centred modal, stacked over both bars',
  '.about-overlay': 'a modal overlay covering the whole window',
  'th': 'the deploy manifest table head, sticky inside the modal body',
  '.observa-adv-menu': 'placed by script under its button (app.mjs positionAdv)',
  '.build-def': 'Build: the context bar is hidden there',
  '.build-sheet': 'Build: the context bar is hidden there',
  '.build-editor-scrim': 'a modal scrim',
  '.build-editor': 'a centred modal',
  '.svc-editor-scrim': 'a modal scrim (the service record editor)',
  '.svc-editor': 'a centred modal (the service record editor)',
  '.proto-switcher': 'prototype only (?proto)',
  '.proto-actionbar': 'prototype only (?proto)',
  '.proto-deploybar': 'prototype only (?proto)',
  '.pc-rail': 'prototype only (?proto)',
  '.mc-actionbar': 'prototype only (?proto)',
  '.mc-deploybar': 'prototype only (?proto)',
};

test('every pinned element of the studio is classified: it clears both bars, or it is exempt with a reason', () => {
  const unknown = [];
  for (const r of rules().filter(pinned)) {
    for (const subject of subjects(r.selector)) {
      if (!CLEARS.includes(subject) && !(subject in EXEMPT)) unknown.push(`${r.file}: ${r.selector}`);
    }
  }
  assert.deepEqual(unknown, [], 'a new position: fixed / sticky rule — add it to CLEARS (and give it a top that adds both bar heights) or to EXEMPT with the reason');
});

test('what opens under the header starts below the chrome AND the context bar', () => {
  const all = rules();
  for (const subject of CLEARS) {
    const tops = all.filter(r => subjects(r.selector).includes(subject)).map(topOf).filter(Boolean);
    assert.ok(tops.length, `${subject} sets a top`);
    assert.ok(
      tops.some(t => t.includes('--observa-chrome-h') && t.includes('--ux-context-h')),
      `${subject} must have a rule whose top adds --observa-chrome-h and --ux-context-h (found: ${tops.join(' | ')})`,
    );
  }
});

test('the context bar height is measured, not assumed: it wraps onto a second row', () => {
  const app = fs.readFileSync(new URL('app.mjs', dir), 'utf8');
  assert.ok(/setProperty\('--ux-context-h'/.test(app) && /ResizeObserver/.test(app), 'app.mjs keeps --ux-context-h at the bar\'s real height');
});

test('a modal is stacked over the chrome and the context bar, never under them', () => {
  const all = rules();
  const z = (subject, scope = '') => all
    .filter(r => subjects(r.selector).includes(subject) && r.selector.includes(scope))
    .map(r => Number(/z-index:\s*(\d+)/.exec(r.body)?.[1])).filter(Number.isFinite);
  const chrome = Math.max(...z('.observa-hdr'));
  const bar = Math.max(...z('.hdr', 'chrome-observa'));
  assert.ok(chrome > 0 && bar > 0, 'the two bars set a z-index');
  for (const modal of ['.deploy-modal', '.about-overlay']) {
    const top = Math.max(...z(modal));
    assert.ok(top > chrome && top > bar, `${modal} (z ${top}) sits over the chrome (${chrome}) and the context bar (${bar})`);
  }
  // Every class the About dialog's markup uses has a rule: it once had none.
  const app = fs.readFileSync(new URL('app.mjs', dir), 'utf8');
  const about = app.slice(app.indexOf('function openAboutModal'), app.indexOf('// /auth/me'));
  for (const cls of new Set([...about.matchAll(/class(?:Name)?\s*=\s*["'`]([\w -]+)["'`]/g)].flatMap(m => m[1].split(' ')).filter(c => c.startsWith('about-')))) {
    assert.ok(all.some(r => r.selector.includes(`.${cls}`)), `.${cls} is styled`);
  }
});
