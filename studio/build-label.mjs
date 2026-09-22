// studio/build-label.mjs — which build is this studio?
//
// The footer's `<span id="build-label">` ships a fallback (package.json's
// version, pinned by tools/test-build-info.mjs) and is filled at boot from
// GET /api/version — public, no-store, served by server/build-info.mjs:
// { version, build, commit, branch, dirty, date, shallow, source, label }.
// The text becomes the label ('v0.4.0 · build 975 · 9c4f827 · develop'),
// the title the commit date and where the answer came from ('source: git'
// | 'file' | 'package', plus a note when the checkout is a shallow clone
// with no history to count). When the fetch fails the fallback stays — a
// stale server without the route answers the HTML shell, which api()
// reports as an error, so nothing is ever painted from a guess.
//
// docs/UI_CONVENTIONS.md §2–3: loaders (fetch + normalise, fetchFn
// injectable) → model (pure, testable under node:test) → renderers
// (container, model). app.mjs's loadVersion() is only the composition:
// loadBuildInfo + loadHealth → buildLabelModel → renderVersionChrome.

import { api } from './api.mjs';

// Loader: /api/version, or null when it cannot be had.
export async function loadBuildInfo({ fetchFn = api } = {}) {
  try {
    const info = await fetchFn('/api/version');
    return info && typeof info === 'object' ? info : null;
  } catch {
    return null;
  }
}

// Loader: /healthz — { version, build, node, specVersion } — the About
// modal's spec and runtime rows; null when it cannot be had.
export async function loadHealth({ fetchFn = api } = {}) {
  try {
    const health = await fetchFn('/healthz');
    return health && typeof health === 'object' ? health : null;
  } catch {
    return null;
  }
}

// Model: what the footer shows. Null when there is nothing trustworthy to
// show (the renderers then leave the fallback alone).
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
  const shallow = info.shallow === true;
  const title = `${date ?? 'commit date unknown'} · source: ${source}${shallow ? ' · shallow clone: no history to count' : ''}`;
  const commit = typeof info.commit === 'string' && info.commit ? info.commit : null;
  const branch = typeof info.branch === 'string' && info.branch ? info.branch : null;
  return { label, shortLabel, title, version, build, commit, branch, dirty: info.dirty === true, shallow, source, date };
}

// Renderer: the footer span alone; no fetch, no state.
export function renderBuildLabel(container, model) {
  if (!container || !model) return;
  container.textContent = model.label;
  container.title = model.title;
}

// Renderer: every place the label lives — the footer span, the About entry
// in the Advanced menu, the header subtitle (the short form, appended once)
// and the brand tooltip. `container` is what to search (document at
// runtime, a stub headlessly); a target that is not there is skipped.
export function renderVersionChrome(container, model) {
  if (!container || !model) return;
  renderBuildLabel(container.querySelector('#build-label'), model);
  const sub = container.querySelector('#observa-about-sub');
  if (sub) sub.textContent = model.label;
  const hdrSub = container.querySelector('.hdr-sub');
  if (hdrSub && !hdrSub.textContent.includes('build')) hdrSub.textContent += ` · ${model.shortLabel}`;
  const brand = container.querySelector('.observa-brand');
  if (brand) brand.title = `Observogram ${model.label}`;
}
