// studio/atlas-view.mjs
//
// The Atlas view (Advanced) — the visual atlases (strata · periodic ·
// constellation · skyline · transit · arbor) rendered from atlases.mjs over
// the loaded pack(s). Self-contained rendering; loads Pack B on demand for
// the cross-pack variants.

import { state } from './state.mjs';
import { render as renderAtlas, VARIANTS as ATLAS_VARIANTS, ATLAS_META } from './atlases.mjs';
import { escapeHtml } from './util.mjs';
import { api } from './api.mjs';
import { openDrawer } from './drawer.mjs';
import { renderComparePicker, loadDiff } from './compare-view.mjs';
import { CROSS_PACK_VARIANTS } from './app.mjs';
import { host as appHost } from './host.mjs';

export function renderAtlasView(view) {
  const hasB = !!state.packB;
  // If the user is on a cross-pack variant but Pack B isn't loaded,
  // fall back to a single-pack variant so the view stays usable.
  if (!hasB && CROSS_PACK_VARIANTS.has(state.atlasVariant)) {
    state.atlasVariant = 'strata';
  }

  const section = document.createElement('section');
  section.className = 'section atlas-view';
  section.dataset.layer = 'ATLAS';

  const meta = ATLAS_META[state.atlasVariant] || { title: state.atlasVariant, lede: '' };
  const head = document.createElement('div');
  head.className = 'section-head';
  head.innerHTML = `
    <span class="section-num">ATL</span>
    <span class="section-name">${escapeHtml(meta.title)}${hasB ? '' : ' · single pack'}</span>
    <span class="section-count">${escapeHtml(state.atlasVariant)}</span>
  `;
  section.appendChild(head);

  const sub = document.createElement('div');
  sub.className = 'atlas-lede';
  sub.textContent = meta.lede;
  section.appendChild(sub);

  // Variant selector pills. Cross-pack variants are filtered out when
  // Pack B isn't loaded — the picker only shows what'll actually work.
  const pills = document.createElement('div');
  pills.className = 'atlas-variants';
  const availableVariants = hasB
    ? ATLAS_VARIANTS
    : ATLAS_VARIANTS.filter(v => !CROSS_PACK_VARIANTS.has(v));
  for (const v of availableVariants) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'atlas-variant' + (v === state.atlasVariant ? ' is-active' : '');
    b.textContent = v;
    b.onclick = () => {
      state.atlasVariant = v;
      appHost.renderTabs();
      appHost.renderMainView();
    };
    pills.appendChild(b);
  }
  section.appendChild(pills);

  // Pack-B + env-B + swap. Only useful in compare mode — skip in single.
  if (hasB) section.appendChild(renderComparePicker());

  // Stage for SVG
  const stage = document.createElement('div');
  stage.className = 'atlas-stage';
  section.appendChild(stage);

  // Constellation gets a morph slider
  if (state.atlasVariant === 'constellation') {
    const tools = document.createElement('div');
    tools.className = 'atlas-tools';
    tools.innerHTML = `
      <label class="atlas-morph">
        <span class="ctrl-key">A → B</span>
        <input type="range" min="0" max="100" value="${Math.round(state.atlasMorph * 100)}" id="atlas-morph">
      </label>
    `;
    section.appendChild(tools);
    setTimeout(() => {
      const r = section.querySelector('#atlas-morph');
      if (!r) return;
      r.oninput = () => {
        state.atlasMorph = Number(r.value) / 100;
        renderAtlas(state.atlasVariant, stage, datasetFor(), { morph: state.atlasMorph });
      };
    }, 0);
  }

  view.appendChild(section);

  // Render — fetch packB lazily if missing
  const atlasOpts = {
    morph: state.atlasMorph,
    arborView: state.arborView || 'A',
    onArborViewChange: (v) => { state.arborView = v; appHost.renderMainView(); },
    onArtefactClick: (artefact, layerId) => openDrawer(artefact, { id: layerId }, null),
  };
  const dataset = datasetFor();
  if (!dataset.b) {
    stage.innerHTML = '<div class="placeholder">Loading pack B…</div>';
    Promise.all([
      state.packB ? Promise.resolve() : appHost.loadPackB(),
      state.diff  ? Promise.resolve() : loadDiff(),
    ]).then(() => {
      renderAtlas(state.atlasVariant, stage, datasetFor(), atlasOpts);
    }).catch((e) => {
      stage.innerHTML = `<div class="error">Failed to load pack B: ${escapeHtml(e.message)}</div>`;
    });
  } else {
    renderAtlas(state.atlasVariant, stage, dataset, atlasOpts);
  }
}

function datasetFor() {
  return { a: state.pack, b: state.packB, diff: state.diff };
}

