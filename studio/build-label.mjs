// studio/build-label.mjs — which build is this studio?
//
// The footer's `<span id="build-label">` ships a fallback (package.json's
// version, pinned by tools/test-build-info.mjs) and is filled at boot from
// GET /api/version — public, no-store, served by server/build-info.mjs:
// { version, build, commit, branch, dirty, date, source, label }. The text
// becomes the label ('v0.4.0 · build 975 · 9c4f827 · develop'), the title
// the commit date and where the answer came from ('source: git' | 'file'
// | 'package'). When the fetch fails the fallback stays — a stale server
// without the route answers the HTML shell, which api() reports as an
// error, so nothing is ever painted from a guess.
//
// docs/UI_CONVENTIONS.md §2–3: loader (fetch + normalise, fetchFn injectable)
// → model (pure, testable under node:test) → renderer (container, model).

import { api } from './api.mjs';

// Loader: the server's answer, or null when it cannot be had.
export async function loadBuildInfo({ fetchFn = api } = {}) {
  try {
    const info = await fetchFn('/api/version');
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

// Model: what the footer shows. Null when there is nothing trustworthy to
// show (the renderer then leaves the fallback alone).
export function buildLabelModel(info) {
  if (!info || typeof info !== 'object') return null;
  const version = typeof info.version === 'string' && info.version ? info.version : null;
  const build = Number.isInteger(info.build) ? info.build : null;
  const label = typeof info.label === 'string' && info.label
    ? info.label
    : `v${version ?? '?'} · build ${build ?? 'unknown'}`;
  const shortLabel = `v${version ?? '?'} · build ${build ?? 'unknown'}`;
  const source = ['git', 'file', 'package'].includes(info.source) ? info.source : 'unknown';
  const date = typeof info.date === 'string' && info.date ? info.date : null;
  const title = `${date ?? 'commit date unknown'} · source: ${source}`;
  const commit = typeof info.commit === 'string' && info.commit ? info.commit : null;
  const branch = typeof info.branch === 'string' && info.branch ? info.branch : null;
  return { label, shortLabel, title, version, build, commit, branch, dirty: info.dirty === true, source, date };
}

// Renderer: paints the model into the span; no fetch, no state.
export function renderBuildLabel(container, model) {
  if (!container || !model) return;
  container.textContent = model.label;
  container.title = model.title;
}
