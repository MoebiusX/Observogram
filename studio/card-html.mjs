// studio/card-html.mjs
//
// The artefact card's inner HTML — one helper for every view that draws an
// adapter artefact as a `.card` (Discover's layers view, the Build stack),
// so the markup is written once and the two journeys cannot drift: the head
// (id · unresolved-reference flag · version-gating chip · source pill), the
// title, the one-line desc, the foot (tool · tags · an optional benchmark
// CTA). Pure: it reads no state and touches no DOM — the caller passes what
// it knows (the unresolved-reference count from its symbol table, the
// benchmark match from the lens catalogue) and owns the element, its
// classes (is-active, has-broken-refs, is-scaffold) and its click handling.

import { escapeHtml } from './util.mjs';

/**
 * artefactCardHtml(artefact, { broken, benchmark, tagLimit }) → the HTML inside a `.card`.
 *   broken     the number of unresolved references the caller found on this card (0: no flag)
 *   benchmark  { slug, refPackId, label } when a backend's product matches a reference pack (the CTA)
 *   tagLimit   how many tags the foot shows (Discover shows four)
 */
export function artefactCardHtml(artefact, { broken = 0, benchmark = null, tagLimit = 4 } = {}) {
  const tags = (artefact.tags || []).slice(0, tagLimit).map(t =>
    `<span class="tag">${escapeHtml(t)}</span>`).join('');

  // Version-gating chip for backend artefacts.
  let gatingChip = '';
  if (/^BAK-/.test(artefact.id) && artefact.spec?.version?.gating) {
    const g = artefact.spec.version.gating;
    gatingChip = `<span class="gating-chip" data-gating="${escapeHtml(g)}" title="version: ${escapeHtml(artefact.spec.version.declared || '?')} · gating: ${escapeHtml(g)}">${escapeHtml(g)}</span>`;
  }

  const brokenIndicator = broken
    ? `<span class="ref-indicator" title="${broken} unresolved reference(s)">⚠</span>`
    : '';

  // Benchmark CTA — from a backend card, one click to "how does my X compare
  // to best practice?" (the caller decides whether this artefact has one).
  const benchmarkCta = benchmark
    ? `<button type="button" class="benchmark-cta"
      data-product="${escapeHtml(benchmark.slug)}"
      data-ref-pack="${escapeHtml(benchmark.refPackId)}"
      title="Compare your ${escapeHtml(benchmark.label)} posture against the catalogue reference pack."
    >⛯ Benchmark vs ${escapeHtml(benchmark.label)} →</button>`
    : '';

  return `
    <div class="card-head">
      <span class="card-id">${escapeHtml(artefact.id)}</span>
      ${brokenIndicator}
      ${gatingChip}
      <span class="card-source" data-source="${escapeHtml(artefact.source || 'Declared')}">${escapeHtml(artefact.source || 'Declared')}</span>
    </div>
    <div class="card-title">${escapeHtml(artefact.title || artefact.id)}</div>
    ${artefact.desc ? `<div class="card-desc">${escapeHtml(artefact.desc)}</div>` : ''}
    <div class="card-foot">
      ${artefact.tool ? `<span class="tool">${escapeHtml(artefact.tool)}</span>` : ''}
      ${tags}
      ${benchmarkCta}
    </div>
  `;
}
