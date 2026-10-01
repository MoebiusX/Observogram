// studio/atlases.mjs
//
// Atlas renderers — visual metaphors for the same pair of packs:
//
//   - strata   — geological cross-section (Cuvier 1812 / Lyell 1830 / USGS)
//   - periodic — Mendeleev's table (every artefact a cell; dashed = gap)
//
// Constellation, Skyline, Transit, and Arbor are reserved for follow-up
// PRs. They were retired in Phase 3a and are being restored two at a
// time; only strata and periodic are wired in this iteration so the
// variant selector doesn't surface placeholder/half-baked versions.
//
// Each renderer takes (host, dataset, opts) where dataset is
//   { a: layeredPack, b: layeredPack, diff: diffResult }.
// opts.onArtefactClick(artefact, layerId) opens the drawer in app.mjs.

const LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV'];

const LAYER_NAMES = {
  L1:  'Contract',
  L2:  'Telemetry',
  L2X: 'Extended',     // spec v1.2 RFC-0001 sibling layer
  L3:  'Insight',
  L4:  'Action',
  L5:  'Validation',
  GOV: 'Governance',
};

// Layer hex palette mirroring the CSS variables — SVG attributes need
// explicit colors at definition time so we can build patterns/gradients
// against them. Kept in sync with :root in app.css.
const C = {
  L1:  '#C97700', L2:  '#2E75B6', L3:  '#006B6B',
  L4:  '#A22323', L5:  '#5B2C82', GOV: '#4A4A4A',
};
const CBG = {
  L1:  '#FFF4E0', L2:  '#E5ECF5', L3:  '#DBEEEE',
  L4:  '#F8DCDC', L5:  '#ECE0F4', GOV: '#E8E8E8',
};
const SRC_MISSING = '#DC2626';
const SRC_ADDED   = '#16A34A';

export const ATLAS_META = {
  strata: {
    title: 'Stratigraphy of the platform',
    lede: 'Read the layers like rock. Where the silhouette is jagged, something is missing. The right column shows the layer-stack the architecture is meant to be — clean parallelograms floating on dashed datum, after Cuvier and Lyell.',
  },
  periodic: {
    title: 'A periodic table of observability',
    lede: 'Every artefact gets a cell. Dashed cells are gaps — Mendeleev predicted gallium from a hole in his 1869 table; we do the same with missing recording rules and chaos coverage. Stripes encode the source.',
  },
  // The four below are intentionally not exported via VARIANTS yet —
  // they'll come back as their faithful ports land.
  constellation: {
    title: 'The night sky of the platform',
    lede: 'A celestial chart of the observability domain. Bright stars are present; dashed ghosts are gaps. Asterism lines connect symbols within the same layer. Drag the slider to see the sky fill in — every gap closed is a star reignited. After Cellarius (1660) and Hevelius (1690).',
  },
  skyline: {
    title: 'The maturity skyline',
    lede: 'A Tufte slopegraph: one line per layer, from A on the left to B on the right. The steeper the line, the larger the delta — and the louder that layer needs to be in your project plan. Labels are auto-displaced with leader lines so nothing collides.',
  },
  transit: {
    title: 'The platform as a transit network',
    lede: 'A subway-style map. Each layer is a line; each artefact is a station. Open rings with a red ✕ are closed stations — gaps the network plan still shows but the train can\'t reach. Dashed vertical chains are interchanges, where an SLO becomes a query becomes a rule becomes an alert.',
  },
  arbor: {
    title: 'A botanical of the platform',
    lede: 'A plant rooted in the service. Branches divide upward through the layers — L1 closest to root, GOV at the canopy. Where two upper branches share a single downstream ancestor, the stems fuse: self-inosculation. From Latin "osculari" — to kiss. Two branches of the same tree, growing together until bark and wood become a single conduit.',
  },
};

// ============================================================
// Helpers
// ============================================================

function flatLayer(pack, layerId) {
  const ls = pack?.layers || {};
  if (layerId === 'L4') {
    return [...(ls.L4?.policy || []), ...(ls.L4?.alerting || []), ...(ls.L4?.healing || [])];
  }
  return ls[layerId] || [];
}

function allArtefacts(pack) {
  const out = [];
  for (const l of LAYERS) for (const a of flatLayer(pack, l)) out.push(a);
  return out;
}

// Canonical key — matches by `defines` when possible so the same SLI in
// two different packs is recognised as the same artefact even though its
// positional ID (SLI-NN) differs.
function keyOf(art) {
  if (!art) return null;
  return art.defines || art.id;
}

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

// Read a CSS custom property from the document root, with a hard-coded
// fallback colour when the variable is missing (SSR, server-rendered
// SVG, or theme not yet applied). Used by skyline so its slopegraph
// inherits the active theme colours.
function cssVar(name, fallback) {
  try {
    if (typeof document === 'undefined') return fallback;
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  } catch (_) { return fallback; }
}

// ============================================================
// 1) STRATIGRAPHY — geological cross-section.
//
// Two stacks of layer bands, current on the left and target on the right.
// Left bands have hatching fills + jagged top edges (slight waviness) +
// notches carved upward for each "missing" artefact (items B has and A
// doesn't, per the diff). Right bands are clean parallelograms with a
// subtle isometric skew, filled with a per-layer linear gradient and
// drop-shadowed via an SVG filter. A central bridge calls out the
// migration math: how many artefacts to add, how many gaps to close.
//
// Inspired by Cuvier 1812, Lyell 1830, USGS strata columns.
// ============================================================

function renderStrata(host, { a, b, diff }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the strata.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;

  // Per-layer "list" for A's silhouette: present items + injected gap
  // markers (one per onlyInB diff entry) so notches carve into the band.
  function aSilhouetteList(L) {
    const present = flatLayer(A, L);
    const gaps = (diff?.layers?.[L]?.onlyInB || []).map(e => ({
      ...e.artefact,
      _isGap: true,
    }));
    return [...present, ...gaps];
  }

  function layerStats(pack, L) {
    const list = flatLayer(pack, L);
    return { list, count: list.length };
  }

  const VB_W = 1100, VB_H = 600;
  const PAD_L = 30, PAD_R = 30, PAD_T = 30;
  const COL_W = (VB_W - PAD_L - PAD_R - 200) / 2;
  const LEFT_X = PAD_L;
  const RIGHT_X = PAD_L + COL_W + 200;
  const STACK_TOP = PAD_T + 40;
  const STACK_H = VB_H - STACK_TOP - 80;
  const BAND_H = STACK_H / LAYERS.length - 6;

  // ---- jagged silhouette path (current/left) ----
  function jaggedPath(x, y, w, h, list) {
    if (!list.length) return `M ${x} ${y} L ${x+w} ${y} L ${x+w} ${y+h} L ${x} ${y+h} Z`;
    const n = list.length;
    const cw = w / n;
    let d = `M ${x} ${y}`;
    const segs = 6;
    for (let s = 1; s <= segs; s++) {
      const tx = x + (w * s / segs);
      const wave = Math.sin(s * 1.7 + x * 0.003) * 1.2;
      d += ` L ${tx} ${y + wave}`;
    }
    d += ` L ${x+w} ${y+h}`;
    for (let i = n - 1; i >= 0; i--) {
      const segX0 = x + i * cw;
      const segX1 = x + (i + 1) * cw;
      const item = list[i];
      if (item._isGap) {
        const mid = (segX0 + segX1) / 2;
        const depth = h * (0.55 + (i % 3) * 0.08);
        const lipL = segX1 - cw * 0.10;
        const lipR = segX0 + cw * 0.10;
        const peakY = y + h - depth;
        d += ` L ${lipL} ${y + h}`;
        d += ` L ${mid + cw*0.10} ${peakY + h*0.18}`;
        d += ` L ${mid - cw*0.04} ${peakY}`;
        d += ` L ${mid - cw*0.14} ${peakY + h*0.10}`;
        d += ` L ${lipR} ${y + h}`;
      }
      d += ` L ${segX0} ${y + h}`;
    }
    d += ` Z`;
    return d;
  }

  function targetPath(x, y, w, h, skew) {
    return `M ${x + skew} ${y} L ${x + w} ${y} L ${x + w - skew} ${y + h} L ${x} ${y + h} Z`;
  }

  // ---- defs: hatching + gradient + shadow + bedrock ----
  const defs = `
    <defs>
      ${LAYERS.map(L => `
        <pattern id="hatch-${L}" patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
          <rect width="6" height="6" fill="${CBG[L]}" />
          <line x1="0" y1="0" x2="0" y2="6" stroke="${C[L]}" stroke-width="0.6" opacity="0.30"/>
        </pattern>
        <linearGradient id="tg-${L}" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stop-color="${C[L]}" stop-opacity="0.95"/>
          <stop offset="100%" stop-color="${C[L]}" stop-opacity="0.75"/>
        </linearGradient>
      `).join('')}
      <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="3"/>
        <feOffset dx="0" dy="4" result="off"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.18"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
      <pattern id="bedrock" patternUnits="userSpaceOnUse" width="8" height="8">
        <rect width="8" height="8" fill="#F1ECE0"/>
        <path d="M 0 8 L 8 0" stroke="#C8C0AC" stroke-width="0.6"/>
      </pattern>
    </defs>`;

  let svg = `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="strata-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">${defs}`;

  // ---- column headers ----
  svg += `
    <text x="${LEFT_X + COL_W/2}" y="${PAD_T - 2}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.18em; text-transform:uppercase; fill:#6B6B6B;">Present State</text>
    <text x="${LEFT_X + COL_W/2}" y="${PAD_T + 22}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:18px; fill:#1F3A5F;">${escapeHtml(A.name)}</text>
    <text x="${RIGHT_X + COL_W/2}" y="${PAD_T - 2}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.18em; text-transform:uppercase; fill:#6B6B6B;">Target State</text>
    <text x="${RIGHT_X + COL_W/2}" y="${PAD_T + 22}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:18px; fill:#1F3A5F;">${escapeHtml(B.name)}</text>
  `;

  // ---- bedrock + sky datum lines ----
  const bedY = STACK_TOP + STACK_H + 6;
  svg += `
    <rect x="${LEFT_X}" y="${bedY}" width="${COL_W}" height="20" fill="url(#bedrock)" opacity="0.6"/>
    <line x1="${LEFT_X}" y1="${bedY}" x2="${LEFT_X + COL_W}" y2="${bedY}" stroke="#8B8472" stroke-width="0.6"/>
    <line x1="${RIGHT_X}" y1="${PAD_T + 40}" x2="${RIGHT_X + COL_W}" y2="${PAD_T + 40}" stroke="#D4D9DF" stroke-width="0.6" stroke-dasharray="2 4"/>
    <text x="${RIGHT_X}" y="${PAD_T + 36}" style="font-family:'Newsreader', serif; font-style:italic; font-size:10px; fill:#9BA3AD;">— ideal datum —</text>
  `;

  // ---- bands ----
  let totalAddedAll = 0, totalGapsAll = 0;

  LAYERS.forEach((L, idx) => {
    const sa = layerStats(A, L);
    const sb = layerStats(B, L);
    const aList = aSilhouetteList(L);
    const gapsHere = aList.filter(x => x._isGap).length;
    const addedHere = Math.max(0, sb.count - sa.count);
    totalAddedAll += addedHere;
    totalGapsAll += gapsHere;

    const yTop = STACK_TOP + idx * (BAND_H + 6);

    // CURRENT — jagged, hatched
    const dPath = jaggedPath(LEFT_X, yTop, COL_W, BAND_H, aList);
    svg += `
      <g class="strata-band current" data-layer="${L}" data-side="current">
        <path d="${dPath}" fill="url(#hatch-${L})" stroke="${C[L]}" stroke-width="1.3" stroke-linejoin="round"/>
        <text x="${LEFT_X + 8}" y="${yTop + 14}" style="fill:${C[L]}; font-weight:700; font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.04em;">${L} · ${LAYER_NAMES[L].toUpperCase()}</text>
        <text x="${LEFT_X + COL_W - 8}" y="${yTop + 14}" text-anchor="end"
          style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#4A4A4A;">${sa.count} present · ${gapsHere ? gapsHere + ' missing' : 'no gaps'}</text>
      </g>
    `;

    // Gap tag pins under the current band
    if (gapsHere > 0) {
      const gaps = aList.filter(x => x._isGap).slice(0, 3);
      gaps.forEach((g, gi) => {
        const gx = LEFT_X + 16 + gi * (COL_W / Math.min(gapsHere + 1, 4));
        const gy = yTop + BAND_H - 4;
        svg += `
          <g>
            <circle cx="${gx}" cy="${gy + 12}" r="2.2" fill="${SRC_MISSING}"/>
            <line x1="${gx}" y1="${gy}" x2="${gx}" y2="${gy + 10}" stroke="${SRC_MISSING}" stroke-width="0.8" stroke-dasharray="1.5 1.5"/>
          </g>`;
      });
    }

    // TARGET — clean isometric ribbon
    const skew = 12;
    const tPath = targetPath(RIGHT_X, yTop, COL_W, BAND_H, skew);
    svg += `
      <g class="strata-band target" data-layer="${L}" data-side="target" filter="url(#softShadow)">
        <path d="${tPath}" fill="url(#tg-${L})" stroke="${C[L]}" stroke-width="1.2" stroke-linejoin="miter"/>
        <text x="${RIGHT_X + 18}" y="${yTop + 16}" style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#fff; font-weight:500;">${L} · ${LAYER_NAMES[L]}</text>
        <text x="${RIGHT_X + COL_W - 8}" y="${yTop + 16}" text-anchor="end"
          style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#fff; opacity:0.92;">${sb.count} artefacts</text>
        ${addedHere > 0 ? `
          <text x="${RIGHT_X + COL_W - 8}" y="${yTop + BAND_H - 8}" text-anchor="end"
            style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#ECFCEF; font-weight:600;">+${addedHere} new</text>` : ''}
      </g>
    `;
  });

  // ---- central bridge ----
  const bridgeX = LEFT_X + COL_W + 30;
  const bridgeY = STACK_TOP + STACK_H / 2;
  svg += `
    <g>
      <text x="${bridgeX + 70}" y="${STACK_TOP + 12}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; letter-spacing:0.10em; fill:#6B6B6B; text-transform:uppercase;">Migration</text>
      <line x1="${bridgeX}" y1="${STACK_TOP + 40}" x2="${bridgeX + 140}" y2="${STACK_TOP + 40}" stroke="#1F3A5F" stroke-width="0.8"/>
      <path d="M ${bridgeX + 130} ${STACK_TOP + 36} L ${bridgeX + 140} ${STACK_TOP + 40} L ${bridgeX + 130} ${STACK_TOP + 44}" fill="none" stroke="#1F3A5F" stroke-width="0.8"/>
      <text x="${bridgeX + 70}" y="${bridgeY - 30}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#1F3A5F;">close the gap</text>
      <text x="${bridgeX + 70}" y="${bridgeY}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-size:34px; font-weight:500; fill:${SRC_ADDED}; font-variant-numeric:tabular-nums;">+${totalAddedAll}</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 18}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.08em; fill:#6B6B6B;">artefacts to add</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 60}" text-anchor="middle"
        style="font-family:'Newsreader', serif; font-size:26px; font-weight:500; fill:${SRC_MISSING}; font-variant-numeric:tabular-nums;">${totalGapsAll}</text>
      <text x="${bridgeX + 70}" y="${bridgeY + 78}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.08em; fill:#6B6B6B;">gaps to close</text>
    </g>
  `;

  // ---- caption ----
  svg += `
    <text x="${VB_W/2}" y="${VB_H - 30}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:13px; fill:#6B6B6B;">
      Each notch in the left-hand strata is an artefact missing from ${escapeHtml(A.name)}.
      The right column shows the layer-stack ${escapeHtml(B.name)} is meant to be.
    </text>
    <text x="${VB_W/2}" y="${VB_H - 12}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; letter-spacing:0.12em; fill:#9BA3AD; text-transform:uppercase;">
      after Cuvier · Lyell · USGS
    </text>
  `;

  svg += `</svg>`;

  host.innerHTML = `
    <div class="strata-wrap">${svg}</div>
    <div class="strata-legend">
      Click any layer band to open the drawer for its first artefact.
      Notches on the left represent items present in <code>${escapeHtml(B.name)}</code> but absent from <code>${escapeHtml(A.name)}</code>.
      Ribbons on the right are scaled to <code>${escapeHtml(B.id)}</code>.
    </div>
  `;

  // Wire clicks
  host.querySelectorAll('.strata-band').forEach(el => {
    el.addEventListener('click', () => {
      const L = el.dataset.layer;
      const side = el.dataset.side;
      const pack = side === 'current' ? A : B;
      const list = flatLayer(pack, L);
      const target = list[0];
      if (target && onClick) onClick(target, L);
    });
  });
}

// ============================================================
// 2) PERIODIC — Mendeleev's table of observability elements.
//
// HTML/CSS-based grid. Two sides (current + target). Each row is a layer
// (L1..GOV). Each cell is an artefact, with:
//   - a coloured source stripe down the left edge
//   - an "atomic number" (stable counter per artefact ID across both packs)
//   - a 1-2 letter "element symbol" derived from the title
//   - the truncated title beneath
// Dashed cells (`.empty`) are gaps — items the other pack has and this one
// doesn't. Cells marked `.added` show up only on the target side and are
// flagged with a ★ in the corner. Clicking any cell opens the drawer.
// ============================================================

function renderPeriodic(host, { a, b }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the periodic table.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;

  function symbolFor(title) {
    if (!title) return '··';
    const cleaned = String(title).replace(/[—–·:].*/, '').trim();
    const words = cleaned.split(/\s+/).filter(w => w.length > 1 &&
      !/^(the|of|and|a|an|to|for|in|on|at|by)$/i.test(w));
    if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return cleaned.slice(0, 2).toUpperCase();
  }

  // Stable atomic numbers across both sides — assign in the order we see
  // each canonical key for the first time.
  const numberMap = new Map();
  let counter = 1;
  function num(key) {
    if (!numberMap.has(key)) numberMap.set(key, counter++);
    return numberMap.get(key);
  }

  // Pre-seed counter from A so its numbering reads first.
  for (const L of LAYERS) for (const it of flatLayer(A, L)) num(keyOf(it));
  for (const L of LAYERS) for (const it of flatLayer(B, L)) num(keyOf(it));

  // For each side, build a per-layer list that includes:
  //   - real items in this pack (filled cells)
  //   - "gap" items the OTHER pack has and this one doesn't (dashed cells)
  function rowsFor(pack, otherPack, side) {
    const otherKeys = new Set(allArtefacts(otherPack).map(keyOf));
    return LAYERS.map(L => {
      const here = flatLayer(pack, L);
      const otherHere = flatLayer(otherPack, L);
      const hereKeys = new Set(here.map(keyOf));
      const missingHere = otherHere.filter(o => !hereKeys.has(keyOf(o)))
        .map(o => ({ ...o, _isGap: true }));
      const list = [...here, ...missingHere];
      const present = here.length;
      const tot = list.length;
      const pct = tot ? Math.round(100 * present / tot) : 0;

      const cells = list.map(item => {
        const isGap = !!item._isGap;
        const isAdded = side === 'target' && !otherKeys.has(keyOf(item)) && !isGap;
        const classes = ['pcell', `row-${L}`, `src-${(item.source || 'Declared')}`];
        if (isGap)   classes.push('empty');
        if (isAdded) classes.push('added');
        return `
          <button type="button" class="${classes.join(' ')}"
                  data-key="${escapeHtml(keyOf(item))}" data-layer="${L}"
                  data-side="${side}" title="${escapeHtml(item.title || item.id)}">
            <span class="pstripe" style="background:${isGap ? SRC_MISSING : C[L]}"></span>
            <span class="pnum">${num(keyOf(item))}</span>
            <span class="psym">${escapeHtml(symbolFor(item.title || item.id))}</span>
            <span class="pname">${escapeHtml(shorten(item.title || item.id, 22))}</span>
            ${isAdded ? '<span class="pstar" aria-hidden="true">★</span>' : ''}
          </button>`;
      }).join('');

      return `
        <div class="periodic-row" data-layer="${L}">
          <div class="periodic-row-label" style="color:${C[L]}">${L}<span class="pct">${pct}%</span></div>
          <div class="periodic-cells">${cells}</div>
        </div>
      `;
    }).join('');
  }

  function renderSide(pack, otherPack, side) {
    const all = allArtefacts(pack).length;
    const otherKeys = new Set(allArtefacts(otherPack).map(keyOf));
    const matched = allArtefacts(pack).filter(it => otherKeys.has(keyOf(it))).length;
    const pct = all ? Math.round(100 * matched / all) : 0;
    return `
      <div class="periodic-side" data-side="${side}">
        <div class="periodic-head">
          <div class="label">${side === 'current' ? 'Present State' : 'Target State'}</div>
          <div class="name">${escapeHtml(pack.name)}</div>
          <div class="coverage"><strong>${matched}</strong>/${all} · ${pct}% in common</div>
        </div>
        <div class="periodic-rows">${rowsFor(pack, otherPack, side)}</div>
      </div>
    `;
  }

  host.innerHTML = `
    <div class="periodic-wrap">
      ${renderSide(A, B, 'current')}
      ${renderSide(B, A, 'target')}
      <div class="periodic-foot">
        Dashed cells are <strong>gaps</strong> — the periodic equivalent of the holes Mendeleev left for undiscovered elements.
        Cells marked with ★ are <strong>added</strong> in the target side. The colour stripe is the layer.
      </div>
    </div>
  `;

  // Wire clicks
  host.querySelectorAll('.pcell').forEach(el => {
    el.addEventListener('click', () => {
      const key = el.dataset.key;
      const layer = el.dataset.layer;
      const side = el.dataset.side;
      const pack = side === 'current' ? A : B;
      // Match by canonical key first; if not present (gap), open the
      // other pack's version since that's where the artefact lives.
      const here = flatLayer(pack, layer).find(it => keyOf(it) === key);
      if (here) return onClick && onClick(here, layer);
      const other = flatLayer(side === 'current' ? B : A, layer).find(it => keyOf(it) === key);
      if (other) return onClick && onClick(other, layer);
    });
  });
}

function shorten(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// ============================================================
// Public dispatcher
// ============================================================

// ============================================================
// 3) CONSTELLATION — celestial chart.
//
// Polar layout: 6 layer sectors (L1..L5, plus L2X) radiating from a
// central compass-rose, GOV ringed on the outer arc. Each artefact is a
// star placed at a deterministic (hash-based) polar position so the
// chart reads the same on every render. Stars in the same layer are
// joined by faint asterism lines (the "constellation").
//
// Source / set-membership encodes brightness:
//   - in both packs → bright always
//   - only in A    → bright at mix=0, fades as mix→1
//   - only in B    → dim at mix=0, reignites as mix→1
// Mix slider drives a CSS-free opacity animation per star.
//
// Reads from defs: `starGlow` Gaussian-blur bloom and per-layer
// `radialGradient` nebulae (the warm haze across each sector).
// ============================================================

const CONST_LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5'];
const CONST_HEX = {
  L1:  '#FFB45A', L2:  '#79A8E5', L2X: '#5BC8C2',
  L3:  '#4FC3B8', L4:  '#E07474', L5:  '#A37FCC',
};

function hashStr(s) {
  let x = 0;
  for (let i = 0; i < s.length; i++) x = (x * 31 + s.charCodeAt(i)) | 0;
  return ((x ^ (x >>> 13)) >>> 0) / 4294967295;
}

function renderConstellation(host, { a, b, diff }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the constellation.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;
  const mix = typeof opts.morph === 'number' ? Math.max(0, Math.min(1, opts.morph)) : 0;

  function unionLayer(L) {
    const aItems = flatLayer(A, L);
    const bItems = flatLayer(B, L);
    const map = new Map();
    for (const x of aItems) map.set(x.defines || x.id, { ...x, inA: true, inB: false, _from: 'a' });
    for (const x of bItems) {
      const k = x.defines || x.id;
      const ex = map.get(k);
      if (ex) { ex.inB = true; }
      else map.set(k, { ...x, inA: false, inB: true, _from: 'b' });
    }
    return Array.from(map.values());
  }

  const VB = 900, CX = VB / 2, CY = VB / 2;
  const R_INNER = 90, R_OUTER = 360;
  const govR = R_OUTER + 30;
  const N = CONST_LAYERS.length;

  // ----- defs -----
  let svg = `<svg viewBox="0 0 ${VB} ${VB}" class="const-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">`;
  svg += `<defs>
    <filter id="starGlow" x="-300%" y="-300%" width="600%" height="600%">
      <feGaussianBlur stdDeviation="2.4" result="b1"/>
      <feGaussianBlur stdDeviation="6" result="b2"/>
      <feMerge>
        <feMergeNode in="b2"/>
        <feMergeNode in="b1"/>
        <feMergeNode in="SourceGraphic"/>
      </feMerge>
    </filter>
    ${CONST_LAYERS.map(L => `
      <radialGradient id="neb-${L}" cx="50%" cy="50%" r="50%">
        <stop offset="0%"   stop-color="${CONST_HEX[L]}" stop-opacity="0.10"/>
        <stop offset="100%" stop-color="${CONST_HEX[L]}" stop-opacity="0"/>
      </radialGradient>`).join('')}
  </defs>`;

  // ----- night-sky background + magnitude rings -----
  svg += `<rect x="0" y="0" width="${VB}" height="${VB}" fill="#0B1530"/>`;
  for (let r = R_INNER; r <= R_OUTER; r += 70) {
    svg += `<circle cx="${CX}" cy="${CY}" r="${r}" fill="none" stroke="rgba(232,220,196,0.16)" stroke-width="0.5"/>`;
  }
  svg += `<circle cx="${CX}" cy="${CY}" r="${govR}" fill="none" stroke="rgba(232,220,196,0.22)" stroke-width="0.6"/>`;

  // ----- spokes between sectors -----
  for (let i = 0; i < N; i++) {
    const angle = (-Math.PI / 2) + i * (2 * Math.PI / N);
    const x1 = CX + Math.cos(angle) * R_INNER;
    const y1 = CY + Math.sin(angle) * R_INNER;
    const x2 = CX + Math.cos(angle) * R_OUTER;
    const y2 = CY + Math.sin(angle) * R_OUTER;
    svg += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(232,220,196,0.18)" stroke-width="0.6"/>`;
  }

  // ----- nebulae per sector (faint glow) -----
  CONST_LAYERS.forEach((L, i) => {
    const angle = (-Math.PI / 2) + (i + 0.5) * (2 * Math.PI / N);
    const nx = CX + Math.cos(angle) * (R_INNER + R_OUTER) / 2;
    const ny = CY + Math.sin(angle) * (R_INNER + R_OUTER) / 2;
    svg += `<circle cx="${nx}" cy="${ny}" r="120" fill="url(#neb-${L})"/>`;
  });

  // ----- central compass-rose -----
  svg += `<g>
    <circle cx="${CX}" cy="${CY}" r="50" fill="none" stroke="rgba(232,220,196,0.30)" stroke-width="0.6"/>
    <circle cx="${CX}" cy="${CY}" r="36" fill="none" stroke="rgba(232,220,196,0.20)" stroke-width="0.5"/>
    <g transform="translate(${CX} ${CY})">
      ${[0, 60, 120, 180, 240, 300].map(a => {
        const rad = a * Math.PI / 180;
        const x1 = Math.cos(rad) * 20, y1 = Math.sin(rad) * 20;
        const x2 = Math.cos(rad) * 50, y2 = Math.sin(rad) * 50;
        return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="rgba(232,220,196,0.4)" stroke-width="0.5"/>`;
      }).join('')}
      <text x="0" y="-58" text-anchor="middle" style="font-family:'Newsreader', serif; font-style:italic; fill:#E8DCC4; font-size:11px;">★</text>
      <text x="0" y="4"   text-anchor="middle" style="font-family:'Newsreader', serif; font-style:italic; fill:#E8DCC4; font-size:9px; letter-spacing:0.10em;">OBSERVO</text>
      <text x="0" y="14"  text-anchor="middle" style="font-family:'IBM Plex Mono', monospace; fill:rgba(232,220,196,0.55); font-size:7.5px; letter-spacing:0.16em;">${escapeHtml(A.name || 'A')} → ${escapeHtml(B.name || 'B')}</text>
    </g>
  </g>`;

  // ----- sector labels at the rim -----
  CONST_LAYERS.forEach((L, i) => {
    const angle = (-Math.PI / 2) + (i + 0.5) * (2 * Math.PI / N);
    const lx = CX + Math.cos(angle) * (R_OUTER + 22);
    const ly = CY + Math.sin(angle) * (R_OUTER + 22);
    const angleDeg = (angle * 180 / Math.PI);
    const rotate = (Math.cos(angle) < 0) ? angleDeg + 180 : angleDeg;
    svg += `<text x="${lx}" y="${ly}" text-anchor="middle" dominant-baseline="middle"
      transform="rotate(${rotate} ${lx} ${ly})"
      style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.10em; fill:rgba(232,220,196,0.75);">${L} · ${LAYER_NAMES[L].toUpperCase()}</text>`;
  });

  // ----- stars per sector, with asterism lines -----
  const sectorStars = {};
  CONST_LAYERS.forEach((L, i) => {
    const items = unionLayer(L);
    const sectorAngleStart = (-Math.PI / 2) + i * (2 * Math.PI / N) + 0.08;
    const sectorAngleEnd   = (-Math.PI / 2) + (i + 1) * (2 * Math.PI / N) - 0.08;
    const sectorWidth = sectorAngleEnd - sectorAngleStart;
    sectorStars[L] = [];
    items.forEach((item, j) => {
      const hash  = hashStr(item.id + L);
      const hash2 = hashStr(item.id + '#radial');
      const t = items.length > 0 ? (j + 0.5) / items.length : 0.5;
      const wob = (hash - 0.5) * sectorWidth * 0.25;
      const angle = sectorAngleStart + t * sectorWidth + wob;
      const radius = R_INNER + 30 + hash2 * (R_OUTER - R_INNER - 60);
      const x = CX + Math.cos(angle) * radius;
      const y = CY + Math.sin(angle) * radius;
      sectorStars[L].push({ item, x, y });
    });
    // Asterism: thin polyline connecting consecutive stars in this layer.
    if (sectorStars[L].length >= 2) {
      const pts = sectorStars[L];
      let path = `M ${pts[0].x} ${pts[0].y}`;
      for (let k = 1; k < pts.length; k++) path += ` L ${pts[k].x} ${pts[k].y}`;
      svg += `<path d="${path}" fill="none" stroke="rgba(255,246,224,0.18)" stroke-width="0.6"/>`;
    }
  });

  // ----- draw stars -----
  CONST_LAYERS.forEach(L => {
    const color = CONST_HEX[L];
    sectorStars[L].forEach(({ item, x, y }) => {
      const r = 2.5 + (hashStr(item.id) * 2.2);
      const onlyA = item.inA && !item.inB;
      const onlyB = item.inB && !item.inA;
      const both  = item.inA && item.inB;
      const cls = both ? 'inboth' : (onlyA ? 'only-a' : 'only-b');
      // Opacity is animated by JS based on mix.
      svg += `<g class="const-star" data-cls="${cls}" data-id="${escapeHtml(item.id)}"
                 data-layer="${L}" data-from="${escapeHtml(item._from)}" style="cursor:pointer">
        <circle class="star-halo" cx="${x}" cy="${y}" r="${r * 2.4}" fill="${color}" opacity="0.22" filter="url(#starGlow)"/>
        ${onlyB
          ? `<circle cx="${x}" cy="${y}" r="${r}" fill="none" stroke="${color}" stroke-width="0.9" stroke-dasharray="1.5 1.5"/>`
          : `<circle cx="${x}" cy="${y}" r="${r}" fill="#FFF6E0"/>`}
        ${both ? `<g stroke="#FFF6E0" stroke-width="0.5" opacity="0.55">
          <line x1="${x - r*2.5}" y1="${y}" x2="${x + r*2.5}" y2="${y}"/>
          <line x1="${x}" y1="${y - r*2.5}" x2="${x}" y2="${y + r*2.5}"/>
        </g>` : ''}
        <title>${escapeHtml(item.id + ' · ' + (item.title || ''))}</title>
      </g>`;
    });
  });

  // ----- GOV markers on the outer arc -----
  const gItems = unionLayer('GOV');
  gItems.forEach((item, i) => {
    const t = gItems.length > 0 ? (i + 0.5) / gItems.length : 0.5;
    const angle = Math.PI * 0.55 + t * Math.PI * 0.9;
    const x = CX + Math.cos(angle) * (govR + 8);
    const y = CY + Math.sin(angle) * (govR + 8);
    const isGap = !item.inA && item.inB;
    const cls = (item.inA && item.inB) ? 'inboth' : (item.inA ? 'only-a' : 'only-b');
    svg += `<g class="const-star" data-cls="${cls}" data-id="${escapeHtml(item.id)}"
               data-layer="GOV" data-from="${escapeHtml(item._from)}" style="cursor:pointer">
      <circle cx="${x}" cy="${y}" r="2.6"
        fill="${isGap ? 'rgba(220,38,38,0.35)' : '#FFF6E0'}"
        ${isGap ? 'stroke="rgba(220,38,38,0.7)" stroke-width="0.8" stroke-dasharray="1 1.2"' : ''}/>
      <title>${escapeHtml(item.id + ' · ' + (item.title || ''))}</title>
    </g>`;
  });
  svg += `<text x="${CX}" y="${CY + govR + 50}" text-anchor="middle"
    style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; letter-spacing:0.12em; fill:rgba(232,220,196,0.65);">GOVERNANCE · constellation of evidence</text>`;

  svg += `</svg>`;
  host.innerHTML = svg;

  // ----- per-star opacity animation driven by `mix` -----
  function applyMix(m) {
    host.querySelectorAll('.const-star').forEach(el => {
      const cls = el.dataset.cls;
      let op;
      if (cls === 'inboth')      op = 1;
      else if (cls === 'only-a') op = Math.max(0.30, 1 - 0.65 * m);   // fades toward B
      else                       op = 0.18 + 0.82 * m;                  // reignites toward B
      el.style.opacity = op;
    });
  }
  applyMix(mix);

  // ----- click handlers — open the star's source pack -----
  host.querySelectorAll('.const-star').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const L  = el.dataset.layer;
      const from = el.dataset.from;
      const pack = from === 'a' ? A : B;
      const list = flatLayer(pack, L);
      const target = list.find(x => x.id === id);
      if (target && onClick) onClick(target, L);
    });
  });
}

// ============================================================
// 4) SKYLINE — Tufte slopegraph of per-layer coverage.
//
// One line per layer from "A coverage" on the left to "B coverage" on
// the right. Coverage is computed against the canonical union (A∪B per
// layer); a pack that holds every shared symbol scores 100%, an empty
// pack scores 0%. Labels are auto-displaced with leader lines so that
// even tightly-bunched lines remain legible. Delta annotations colour
// green (improving), red (regressing), or grey (flat). Click any label
// to open the layer's first artefact in the drawer.
// ============================================================

const SKYLINE_LAYERS = ['L1', 'L2', 'L2X', 'L3', 'L4', 'L5', 'GOV'];

function renderSkyline(host, { a, b, diff }, opts = {}) {
  if (!a || !b) {
    host.innerHTML = '<div class="placeholder">Pick a Pack B to render the skyline.</div>';
    return;
  }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;

  function coverage(side, L) {
    const sideItems = flatLayer(side, L);
    // Universe for the layer = items in A's layer ∪ items in B's layer.
    const aSet = new Set(flatLayer(A, L).map(x => x.defines || x.id));
    const bSet = new Set(flatLayer(B, L).map(x => x.defines || x.id));
    const universe = new Set([...aSet, ...bSet]);
    const present = sideItems.length;
    const total   = universe.size;
    return { present, total, pct: total ? present / total : 1 };
  }

  const VB_W = 1100, VB_H = 560;
  const PAD_L = 220, PAD_R = 200, PAD_T = 40, PAD_B = 50;
  const plotW = VB_W - PAD_L - PAD_R, plotH = VB_H - PAD_T - PAD_B;

  let svg = `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="skyline-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">`;

  // ----- "Now / Target" column headers -----
  svg += `
    <text x="${PAD_L}" y="${PAD_T - 16}"
      style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; fill:${cssVar('--ink-4', '#6B6B6B')};">A · ${escapeHtml(A.name || 'pack A')}</text>
    <text x="${VB_W - PAD_R}" y="${PAD_T - 16}" text-anchor="end"
      style="font-family:'IBM Plex Mono', monospace; font-size:10px; letter-spacing:0.16em; text-transform:uppercase; fill:${cssVar('--ink-4', '#6B6B6B')};">B · ${escapeHtml(B.name || 'pack B')}</text>
  `;

  // ----- percentage gridlines -----
  for (const p of [0, 25, 50, 75, 100]) {
    const y = PAD_T + (1 - p / 100) * plotH;
    const dash = (p === 0 || p === 100) ? '0' : '2 4';
    svg += `
      <line x1="${PAD_L}" y1="${y}" x2="${VB_W - PAD_R}" y2="${y}"
        stroke="${cssVar('--line-2', '#E5E8EC')}" stroke-width="0.6" stroke-dasharray="${dash}"/>
      <text x="${PAD_L - 8}" y="${y + 3}" text-anchor="end"
        style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; fill:${cssVar('--ink-5', '#9BA3AD')};">${p}%</text>
    `;
  }

  // ----- per-layer entries -----
  const entries = SKYLINE_LAYERS.map(L => {
    const cA = coverage(A, L), cB = coverage(B, L);
    return {
      L, cA, cB,
      yA: PAD_T + (1 - cA.pct) * plotH,
      yB: PAD_T + (1 - cB.pct) * plotH,
      color: C[L] || cssVar('--ink-3', '#3B3B3B'),
    };
  });

  // ----- displace labels so they don't collide -----
  const minSpacing = 30;
  const sortedL = [...entries].sort((x, y) => x.yA - y.yA);
  let lastL = -Infinity;
  for (const e of sortedL) { e.labelYL = Math.max(e.yA, lastL + minSpacing); lastL = e.labelYL; }
  const sortedR = [...entries].sort((x, y) => x.yB - y.yB);
  let lastR = -Infinity;
  for (const e of sortedR) { e.labelYR = Math.max(e.yB, lastR + minSpacing); lastR = e.labelYR; }

  // ----- lines + endpoints + leader lines + labels -----
  const xA = PAD_L, xB = VB_W - PAD_R;
  for (const e of entries) {
    const delta = e.cB.pct - e.cA.pct;
    const isFlat = Math.abs(delta) < 0.01;
    svg += `<line x1="${xA}" y1="${e.yA}" x2="${xB}" y2="${e.yB}"
      stroke="${e.color}" stroke-width="${isFlat ? 1.5 : 2.3}" opacity="${isFlat ? 0.55 : 0.95}" stroke-linecap="round"/>`;
    svg += `<circle cx="${xA}" cy="${e.yA}" r="5" fill="${e.color}" stroke="${cssVar('--card', '#fff')}" stroke-width="1.5"/>`;
    svg += `<circle cx="${xB}" cy="${e.yB}" r="6" fill="${e.color}" stroke="${cssVar('--card', '#fff')}" stroke-width="1.8"/>`;

    if (Math.abs(e.labelYL - e.yA) > 1) {
      svg += `<line x1="${xA - 6}" y1="${e.yA}" x2="${xA - 10}" y2="${e.labelYL}" stroke="${e.color}" stroke-width="0.7" stroke-dasharray="1.5 2" opacity="0.6"/>`;
    }
    if (Math.abs(e.labelYR - e.yB) > 1) {
      svg += `<line x1="${xB + 6}" y1="${e.yB}" x2="${xB + 10}" y2="${e.labelYR}" stroke="${e.color}" stroke-width="0.7" stroke-dasharray="1.5 2" opacity="0.6"/>`;
    }

    svg += `<g class="slope-left" data-layer="${e.L}" data-side="a" style="cursor:pointer">
      <rect x="${PAD_L - 200}" y="${e.labelYL - 13}" width="190" height="26" fill="transparent"/>
      <text x="${PAD_L - 14}" y="${e.labelYL - 2}" text-anchor="end"
        style="font-family:'IBM Plex Mono', monospace; font-size:11px; font-weight:600; fill:${e.color};">${e.L} · ${LAYER_NAMES[e.L]}</text>
      <text x="${PAD_L - 14}" y="${e.labelYL + 11}" text-anchor="end"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:${cssVar('--ink-4', '#6B6B6B')};">${Math.round(e.cA.pct * 100)}% · ${e.cA.present}/${e.cA.total}</text>
    </g>`;

    const deltaStr = (delta >= 0 ? '+' : '') + Math.round(delta * 100) + '%';
    const deltaColor = delta > 0.05 ? '#16A34A' : (delta < -0.05 ? '#DC2626' : '#9BA3AD');
    svg += `<g class="slope-right" data-layer="${e.L}" data-side="b" style="cursor:pointer">
      <text x="${VB_W - PAD_R + 14}" y="${e.labelYR - 2}"
        style="font-family:'Newsreader', serif; font-style:italic; font-size:14px; fill:${e.color};">${e.L} · ${LAYER_NAMES[e.L]}</text>
      <text x="${VB_W - PAD_R + 14}" y="${e.labelYR + 13}"
        style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:${cssVar('--ink-4', '#6B6B6B')};">${Math.round(e.cB.pct * 100)}% · ${e.cB.present}/${e.cB.total}<tspan dx="6" style="fill:${deltaColor}; font-weight:600;">${deltaStr}</tspan></text>
    </g>`;
  }

  // ----- caption -----
  svg += `<text x="${VB_W/2}" y="${VB_H - 14}" text-anchor="middle"
    style="font-family:'Newsreader', serif; font-style:italic; font-size:12px; fill:${cssVar('--ink-4', '#6B6B6B')};">
    Each line is a layer. The steeper the slope, the larger the delta — and the louder that layer needs to be in the project plan.
  </text>`;

  svg += `</svg>`;
  host.innerHTML = svg;

  // ----- click handlers -----
  host.querySelectorAll('.slope-left, .slope-right').forEach(el => {
    el.addEventListener('click', () => {
      const L = el.dataset.layer;
      const pack = el.dataset.side === 'a' ? A : B;
      const list = flatLayer(pack, L);
      const target = list[0];
      if (target && onClick) onClick(target, L);
    });
  });
}

// ============================================================
// 5) TRANSIT — subway-style map.
//
// Each layer is a coloured horizontal line; each artefact is a station
// on that line. L4 becomes a junction with three branches (policy /
// alerting / healing). Stations the pack declares are filled discs;
// gaps (artefacts only in B, viewed from A's perspective) are open
// rings with a red ✕. Verified stations get a cyan halo.
//
// Interchange chains — where stations in adjacent layers share
// approximately the same x — are drawn as dashed vertical leaders.
// This is what makes "SLO → recording rule → alert → remediation"
// readable as a single line of intent on the map.
// ============================================================

const TRANSIT_LAYERS = ['L1', 'L2', 'L3', 'L5', 'GOV'];   // L4 handled separately
const TRANSIT_C = {
  L1: '#C97700', L2: '#2E75B6', L3: '#006B6B',
  L4: '#A22323', L5: '#5B2C82', GOV: '#4A4A4A',
};

function renderTransit(host, { a, b, diff }, opts = {}) {
  if (!a) { host.innerHTML = '<div class="placeholder">Pack A required.</div>'; return; }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;
  // Hard cap: transit's interchange detection is O(N²) across adjacent
  // layers (every station compared to every adjacent station for x-column
  // proximity). At ~800 stations total it crosses the 100ms perception
  // threshold; at ~1500 it locks the tab. Cap with a clear message.
  const totalCount = TRANSIT_LAYERS.reduce((s, L) => s + flatLayer(A, L).length, 0)
                   + (A.layers?.L4 ? (A.layers.L4.policy?.length || 0) + (A.layers.L4.alerting?.length || 0) + (A.layers.L4.healing?.length || 0) : 0);
  if (totalCount > 600) {
    host.innerHTML = `<div class="placeholder">Transit atlas is capped at 600 artefacts (this pack has ${totalCount}).<br><br>
      Pick a smaller pack, narrow with a per-layer filter on the Layers view, or use the Periodic / Strata atlases — they cope better with large packs.</div>`;
    return;
  }

  // Synthesise per-layer list: present items + injected gap items
  // (artefacts only in B viewed from A's POV). Gap markers carry
  // _isGap = true and the artefact's id from B.
  function withGaps(L) {
    const present = flatLayer(A, L);
    const gaps = (diff?.layers?.[L]?.onlyInB || []).map(e => ({ ...e.artefact, _isGap: true }));
    return [...present, ...gaps];
  }

  const VB_W = 1100, VB_H = 720;
  const X_LEFT = 160, X_RIGHT = 1020;
  const Y = { L1: 100, L2: 190, L3: 280, L4_POL: 340, L4_ALR: 380, L4_HEAL: 420, L5: 520, GOV: 600 };
  const CARD = '#11192A', INK_3 = '#9BA3AD';

  function xsFor(n) {
    if (n <= 1) return [(X_LEFT + X_RIGHT) / 2];
    const step = (X_RIGHT - X_LEFT) / (n - 1);
    return Array.from({ length: n }, (_, i) => X_LEFT + i * step);
  }

  // ----- per-layer station tables (excluding L4 branches) -----
  const lines = TRANSIT_LAYERS.map(L => {
    const list = withGaps(L);
    const xs = xsFor(list.length);
    const y = Y[L];
    return { id: L, y, color: TRANSIT_C[L], stations: list.map((it, i) => ({ ...it, x: xs[i], y })) };
  });

  // L4 sub-branches
  const L4 = A.layers?.L4 || {};
  const polList  = (L4.policy   || []).map(x => ({ ...x, _col: 'policy'  }));
  const alrList  = (L4.alerting || []).map(x => ({ ...x, _col: 'alerting'}));
  const healList = (L4.healing  || []).map(x => ({ ...x, _col: 'healing' }));
  const polXs  = xsFor(polList.length),  alrXs = xsFor(alrList.length),  healXs = xsFor(healList.length);
  const polStations  = polList .map((it, i) => ({ ...it, x: polXs[i],  y: Y.L4_POL  }));
  const alrStations  = alrList .map((it, i) => ({ ...it, x: alrXs[i],  y: Y.L4_ALR  }));
  const healStations = healList.map((it, i) => ({ ...it, x: healXs[i], y: Y.L4_HEAL }));

  // ----- interchange detection: adjacent layers, same column -----
  const layerOrder = ['L1', 'L2', 'L3', 'L4_ALR', 'L5', 'GOV'];
  const byLayer = {
    L1: lines.find(l => l.id === 'L1').stations,
    L2: lines.find(l => l.id === 'L2').stations,
    L3: lines.find(l => l.id === 'L3').stations,
    L4_ALR: alrStations,
    L5: lines.find(l => l.id === 'L5').stations,
    GOV: lines.find(l => l.id === 'GOV').stations,
  };
  const TOL = 35;
  const interchangeStations = new Set();
  const interchangeColumns = [];
  for (let i = 0; i < layerOrder.length - 1; i++) {
    const above = byLayer[layerOrder[i]], below = byLayer[layerOrder[i + 1]];
    for (const sa of above) for (const sb of below) {
      if (Math.abs(sa.x - sb.x) <= TOL) {
        interchangeStations.add(sa.id);
        interchangeStations.add(sb.id);
        interchangeColumns.push({ x: (sa.x + sb.x) / 2, y1: sa.y, y2: sb.y });
      }
    }
  }

  // ----- SVG build -----
  let svg = `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="transit-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">`;
  svg += `<rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="#0A111E"/>`;

  // Title
  svg += `<text x="${VB_W/2}" y="28" text-anchor="middle"
    style="font-family:'Newsreader', serif; font-size:18px; font-weight:600; fill:#E5E7EB;">The platform as a transit network</text>
    <text x="${VB_W/2}" y="48" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; fill:#9BA3AD; letter-spacing:0.04em;">
      ● operational  ◎ live  ○ closed/gap   |   dashed = interchange chain
    </text>`;

  // Interchange columns (drawn before lines)
  const colsByX = new Map();
  for (const c of interchangeColumns) {
    const key = Math.round(c.x / 8) * 8;
    if (!colsByX.has(key)) colsByX.set(key, { x: c.x, yMin: c.y1, yMax: c.y2 });
    const g = colsByX.get(key);
    g.yMin = Math.min(g.yMin, c.y1, c.y2);
    g.yMax = Math.max(g.yMax, c.y1, c.y2);
  }
  for (const g of colsByX.values()) {
    svg += `<line x1="${g.x}" y1="${g.yMin}" x2="${g.x}" y2="${g.yMax}"
              stroke="${INK_3}" stroke-width="1" stroke-dasharray="2 3" opacity="0.5"/>`;
  }

  // Headline interchange annotation — pick the leftmost cluster spanning L1 → L4_ALR
  let canonicalCol = null;
  for (const g of colsByX.values()) {
    if (g.yMin <= Y.L1 + 5 && g.yMax >= Y.L4_ALR - 5) {
      if (!canonicalCol || g.x < canonicalCol.x) canonicalCol = g;
    }
  }
  if (canonicalCol) {
    svg += `<text x="${canonicalCol.x + 10}" y="68"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; fill:#C4CCD6;">
      interchange · the SLO → alert chain</text>`;
  }

  // Draw each line + label
  function drawLine(x1, y, x2, color) {
    return `<line x1="${x1}" y1="${y}" x2="${x2}" y2="${y}" stroke="${color}" stroke-width="7" stroke-linecap="round" opacity="0.95"/>`;
  }
  function lineLabel(L, y, label) {
    return `<text x="20" y="${y - 6}" style="font-family:'IBM Plex Mono', monospace; font-size:11px; font-weight:700; fill:${TRANSIT_C[L]}; letter-spacing:0.04em;">${L}</text>
            <text x="20" y="${y + 10}" style="font-family:'Newsreader', serif; font-size:13px; fill:#D7DCE3;">${label}</text>`;
  }
  for (const L of TRANSIT_LAYERS) {
    const ln = lines.find(l => l.id === L);
    svg += drawLine(X_LEFT - 20, ln.y, X_RIGHT + 20, ln.color);
    svg += lineLabel(L, ln.y, LAYER_NAMES[L]);
  }

  // L4 — junction + 3 branches
  const JX = 200, JY = Y.L4_ALR;
  svg += lineLabel('L4', JY, 'Action');
  svg += `<line x1="${JX}" y1="${JY}" x2="${X_RIGHT + 20}" y2="${JY}"
    stroke="${TRANSIT_C.L4}" stroke-width="7" stroke-linecap="round"/>`;
  const POL_X0 = JX + 40, HEAL_X0 = JX + 40;
  svg += `<path d="M ${JX} ${JY} L ${POL_X0} ${Y.L4_POL} L ${X_RIGHT + 20} ${Y.L4_POL}"
    stroke="${TRANSIT_C.L4}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.92"/>`;
  svg += `<path d="M ${JX} ${JY} L ${HEAL_X0} ${Y.L4_HEAL} L ${X_RIGHT + 20} ${Y.L4_HEAL}"
    stroke="${TRANSIT_C.L4}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round" fill="none" opacity="0.92"/>`;
  svg += `
    <text x="${X_RIGHT + 26}" y="${Y.L4_POL  + 4}" style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:${TRANSIT_C.L4};">policy ›</text>
    <text x="${X_RIGHT + 26}" y="${Y.L4_ALR  + 4}" style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:${TRANSIT_C.L4};">alerting ›</text>
    <text x="${X_RIGHT + 26}" y="${Y.L4_HEAL + 4}" style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:${TRANSIT_C.L4};">healing ›</text>
    <text x="${JX - 6}" y="${JY - 16}" text-anchor="end"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:10.5px; fill:#9BA3AD;">junction</text>
    <circle cx="${JX}" cy="${JY}" r="5" fill="${TRANSIT_C.L4}" stroke="#11192A" stroke-width="1.5"/>`;

  // ----- station glyphs -----
  function stationGlyph(s, L) {
    const color = TRANSIT_C[L];
    const inter = interchangeStations.has(s.id);
    const baseR = inter ? 9 : 6;
    let body = '';
    if (s._isGap) {
      body += `<circle cx="${s.x}" cy="${s.y}" r="${baseR}" fill="${CARD}" stroke="${color}" stroke-width="1.7"/>`;
      body += `<g stroke="#DC2626" stroke-width="1.8" stroke-linecap="round">
                 <line x1="${s.x-3.4}" y1="${s.y-3.4}" x2="${s.x+3.4}" y2="${s.y+3.4}"/>
                 <line x1="${s.x-3.4}" y1="${s.y+3.4}" x2="${s.x+3.4}" y2="${s.y-3.4}"/>
               </g>`;
    } else if (s.source === 'Verified') {
      body += `<circle cx="${s.x}" cy="${s.y}" r="${baseR + 1}" fill="#06B6D4" stroke="${color}" stroke-width="2"/>`;
    } else {
      body += `<circle cx="${s.x}" cy="${s.y}" r="${baseR}" fill="${color}" stroke="${CARD}" stroke-width="1.2"/>`;
    }
    if (inter && !s._isGap) {
      body += `<circle cx="${s.x}" cy="${s.y}" r="${baseR + 3}" fill="none" stroke="${color}" stroke-width="1.6" opacity="0.85"/>`;
    }
    return body;
  }
  function stationLabel(s, i) {
    const dy = (i % 2 === 0) ? -16 : 22;
    const lbl = s.id + (s.source === 'Verified' ? ' (live)' : '');
    return `<text x="${s.x}" y="${s.y + dy}" text-anchor="middle"
      style="font-family:'IBM Plex Mono', monospace; font-size:10px; fill:#D7DCE3;">${escapeHtml(lbl)}</text>`;
  }
  function renderStations(stations, L) {
    return stations.map((s, i) => `
      <g class="transit-station" data-id="${escapeHtml(s.id)}" data-layer="${L}"
         data-from="${s._isGap ? 'b' : 'a'}" style="cursor:pointer">
        ${stationGlyph(s, L)}
        ${stationLabel(s, i)}
        <title>${escapeHtml(s.id + ' — ' + (s.title || ''))}${s._isGap ? ' · gap' : ''}</title>
      </g>`).join('');
  }
  for (const L of TRANSIT_LAYERS) svg += renderStations(lines.find(l => l.id === L).stations, L);
  svg += renderStations(polStations,  'L4');
  svg += renderStations(alrStations,  'L4');
  svg += renderStations(healStations, 'L4');

  // Reading guide footer
  svg += `<g transform="translate(20 ${VB_H - 80})">
    <rect x="0" y="0" width="${VB_W - 40}" height="70" rx="6" fill="#0B1424" stroke="#1F2937" stroke-width="1"/>
    <text x="14" y="20" style="font-family:'IBM Plex Mono', monospace; font-size:11px; fill:#E5E7EB; font-weight:600;">Reading the map</text>
    <text x="14" y="38" style="font-family:'Newsreader', serif; font-size:12px; fill:#C4CCD6;">Open circles with a red ✕ are gaps: the station exists on the plan but isn't built.</text>
    <text x="14" y="56" style="font-family:'Newsreader', serif; font-size:12px; fill:#C4CCD6;">A dashed vertical means the SLO at top connects through query → alert → automation below.</text>
  </g>`;

  svg += `</svg>`;
  host.innerHTML = `<div class="transit-wrap" style="background:#0A111E; border-radius:8px; padding:12px;">
    <div style="display:flex; justify-content:space-between; align-items:center; margin:4px 8px 10px; color:#C4CCD6;">
      <span style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.06em;">SHOWING: ${escapeHtml(A.name)}</span>
      ${B ? `<span style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; color:#9BA3AD;">gaps inferred from ${escapeHtml(B.name)}</span>` : ''}
    </div>${svg}</div>`;

  host.querySelectorAll('.transit-station').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.id;
      const L = el.dataset.layer;
      const from = el.dataset.from;
      const pack = from === 'b' ? B : A;
      const list = flatLayer(pack, L);
      const target = list.find(x => x.id === id) || list[0];
      if (target && onClick) onClick(target, L);
    });
  });
}

// ============================================================
// 6) ARBOR — a botanical of the platform.
//
// The pack is rendered as a plant, rooted in the service and
// branching upward through the layers — L1 closest to the root,
// GOV at the canopy. Where two upper-layer artefacts share a single
// downstream ancestor in the layer below, their stems CONVERGE to a
// fusion point before branching out: self-inosculation.
//
// In botany: two branches of the same tree grow together until their
// bark and wood fuse into a single conduit. Here it's exact: when
// two L3 artefacts share a parent L2 artefact (by tag affinity), their
// lineage is literally one branch.
//
// Parent selection: tag overlap > id-prefix > horizontal proximity.
// ============================================================

const ARBOR_LAYERS = ['L1', 'L2', 'L3', 'L4', 'L5', 'GOV'];
const ARBOR_C = {
  L1: '#C97700', L2: '#2E75B6', L3: '#006B6B',
  L4: '#A22323', L5: '#5B2C82', GOV: '#4A4A4A',
};

function renderArbor(host, { a, b, diff }, opts = {}) {
  if (!a) { host.innerHTML = '<div class="placeholder">Pack A required.</div>'; return; }
  const A = a, B = b;
  const onClick = opts.onArtefactClick;
  const samePack = !B || A.id === B.id;
  const mode = samePack ? 'A' : (opts.arborView || 'A');
  const showA = mode === 'A' || mode === 'both';
  const showB = !samePack && (mode === 'B' || mode === 'both');
  // Hard cap: parent-affinity is O(N×parents-per-layer); inosculation
  // detection is O(children²). At ~700 artefacts per side the trunk
  // becomes a forest of overlapping leaves and the layout hangs the
  // tab. Cap before we get there.
  const sideCount = (pack) => pack ? ARBOR_LAYERS.reduce((s, L) => {
    if (L === 'L4') return s + (pack.layers?.L4 ? (pack.layers.L4.policy?.length || 0) + (pack.layers.L4.alerting?.length || 0) + (pack.layers.L4.healing?.length || 0) : 0);
    return s + (pack.layers?.[L]?.length || 0);
  }, 0) : 0;
  const aCount = sideCount(A), bCount = showB ? sideCount(B) : 0;
  const heaviest = Math.max(aCount, bCount);
  if (heaviest > 500) {
    host.innerHTML = `<div class="placeholder">Arbor atlas is capped at 500 artefacts per side (PACK A: ${aCount}${showB ? `, PACK B: ${bCount}` : ''}).<br><br>
      The botanical layout's parent-affinity + self-inosculation passes are O(N²) per layer. Try Strata, Skyline, or Periodic for large packs.</div>`;
    return;
  }

  function buildTree(pack, otherPack) {
    const VB_W = 1100, VB_H = 820;
    const TRUNK_C = '#7A4A1F', TRUNK_C_DARK = '#5B3614';
    const PAPER = '#F7F1E1', PAPER_2 = '#EFE6CF';
    const INK = '#3B2F1E', INK_SOFT = '#7A6A50';
    const ROOT_X = VB_W / 2, ROOT_Y = VB_H - 60;
    const Y = { L1: 640, L2: 520, L3: 400, L4: 290, L5: 180, GOV: 90 };
    const X_LEFT = 100, X_RIGHT = VB_W - 100;

    // Synthesise per-layer list — include B-only items as gap "buds"
    // (only when otherPack exists).
    function nodesFor(L) {
      if (L === 'L4') {
        const out = [];
        for (const col of ['policy', 'alerting', 'healing']) {
          for (const x of (pack.layers.L4?.[col] || [])) out.push({ ...x, _col: col, layer: 'L4' });
        }
        if (otherPack) {
          const gaps = (diff?.layers?.L4?.onlyInB || []).map(e => ({ ...e.artefact, layer: 'L4', _isGap: true }));
          out.push(...gaps);
        }
        return out;
      }
      const out = flatLayer(pack, L).map(x => ({ ...x, layer: L }));
      if (otherPack) {
        const gaps = (diff?.layers?.[L]?.onlyInB || []).map(e => ({ ...e.artefact, layer: L, _isGap: true }));
        out.push(...gaps);
      }
      return out;
    }

    function spreadXs(n, leftPad = 0, rightPad = 0) {
      if (n <= 0) return [];
      const xl = X_LEFT + leftPad, xr = X_RIGHT - rightPad;
      if (n === 1) return [(xl + xr) / 2];
      const step = (xr - xl) / (n - 1);
      return Array.from({ length: n }, (_, i) => xl + i * step);
    }

    const padding = { L1: 220, L2: 80, L3: 40, L4: 40, L5: 100, GOV: 220 };
    const byLayer = {};
    for (const L of ARBOR_LAYERS) {
      const list = nodesFor(L);
      const xs = spreadXs(list.length, padding[L] || 60, padding[L] || 60);
      byLayer[L] = list.map((it, i) => ({ ...it, x: xs[i] || ROOT_X, y: Y[L] }));
    }

    // Parent assignment by tag affinity
    function sharedTags(a, b) {
      const as = new Set(a.tags || []);
      let n = 0; for (const t of (b.tags || [])) if (as.has(t)) n++;
      return n;
    }
    function idPrefix(id) { return (id || '').split('-')[0]; }
    function pickParent(child, parents) {
      if (!parents.length) return null;
      let best = null, bestScore = -Infinity;
      for (const p of parents) {
        const score = sharedTags(child, p) * 10
                    + (idPrefix(child.id) === idPrefix(p.id) ? 4 : 0)
                    - Math.abs(child.x - p.x) / 100;
        if (score > bestScore) { bestScore = score; best = p; }
      }
      return best;
    }
    const childrenOf = new Map();
    for (let i = 1; i < ARBOR_LAYERS.length; i++) {
      const upper = byLayer[ARBOR_LAYERS[i]], lower = byLayer[ARBOR_LAYERS[i - 1]];
      for (const child of upper) {
        const p = pickParent(child, lower);
        if (p) {
          if (!childrenOf.has(p.id)) childrenOf.set(p.id, []);
          childrenOf.get(p.id).push(child);
        }
      }
    }
    function findNodeById(id) {
      for (const L of ARBOR_LAYERS) {
        const n = byLayer[L].find(x => x.id === id);
        if (n) return n;
      }
      return null;
    }

    // ----- SVG -----
    let svg = `<svg viewBox="0 0 ${VB_W} ${VB_H}" class="arbor-svg atlas-svg" xmlns="http://www.w3.org/2000/svg" font-family="IBM Plex Sans, system-ui">`;
    svg += `<defs>
      <radialGradient id="arborBg" cx="50%" cy="92%" r="85%">
        <stop offset="0%"   stop-color="${PAPER}"/>
        <stop offset="60%"  stop-color="${PAPER_2}"/>
        <stop offset="100%" stop-color="#E2D6B6"/>
      </radialGradient>
      <radialGradient id="canopyGlow" cx="50%" cy="0%" r="60%">
        <stop offset="0%"   stop-color="#A8C97A" stop-opacity="0.35"/>
        <stop offset="100%" stop-color="#A8C97A" stop-opacity="0"/>
      </radialGradient>
      <filter id="leafShadow" x="-20%" y="-20%" width="140%" height="140%">
        <feGaussianBlur in="SourceAlpha" stdDeviation="1.2"/>
        <feOffset dx="0" dy="1" result="off"/>
        <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
        <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
      </filter>
    </defs>
    <rect x="0" y="0" width="${VB_W}" height="${VB_H}" fill="url(#arborBg)"/>
    <rect x="0" y="0" width="${VB_W}" height="280" fill="url(#canopyGlow)"/>`;

    // Title
    svg += `<text x="${VB_W/2}" y="32" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-size:18px; font-weight:600; fill:${INK};">A botanical of the platform</text>
      <text x="${VB_W/2}" y="52" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; fill:${INK_SOFT}; letter-spacing:0.04em;">
        rooted in the service · branches fuse where lineage is shared (self-inosculation)
      </text>`;

    // Layer guide rules + names
    for (const L of ARBOR_LAYERS) {
      const y = Y[L];
      svg += `<line x1="${X_LEFT - 40}" y1="${y}" x2="${X_RIGHT + 40}" y2="${y}"
        stroke="${INK_SOFT}" stroke-width="0.6" stroke-dasharray="1 6" opacity="0.4"/>
        <text x="${X_LEFT - 50}" y="${y - 6}" text-anchor="end"
          style="font-family:'IBM Plex Mono', monospace; font-size:10px; font-weight:700; fill:${ARBOR_C[L]}; letter-spacing:0.04em;">${L}</text>
        <text x="${X_LEFT - 50}" y="${y + 8}" text-anchor="end"
          style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; fill:${INK_SOFT};">${LAYER_NAMES[L]}</text>`;
    }

    // Trunk: root → L1 fanout
    const l1Nodes = byLayer.L1;
    svg += `<line x1="${ROOT_X}" y1="${ROOT_Y}" x2="${ROOT_X}" y2="${Y.L1 + 60}"
      stroke="${TRUNK_C_DARK}" stroke-width="14" stroke-linecap="round"/>`;
    svg += `<ellipse cx="${ROOT_X}" cy="${ROOT_Y + 14}" rx="120" ry="10" fill="#4A3622" opacity="0.55"/>`;
    svg += `<ellipse cx="${ROOT_X}" cy="${ROOT_Y + 20}" rx="160" ry="6" fill="#3B2A18" opacity="0.35"/>`;
    for (const n of l1Nodes) {
      svg += `<path d="M ${ROOT_X} ${Y.L1 + 60}
        C ${ROOT_X} ${Y.L1 + 50}, ${n.x} ${Y.L1 + 10}, ${n.x} ${n.y}"
        stroke="${TRUNK_C}" stroke-width="6" fill="none" stroke-linecap="round"/>`;
    }

    // Branches + inosculation
    function branchPath(parent, child) {
      const dy = parent.y - child.y;
      return `<path d="M ${parent.x} ${parent.y - 6}
        C ${parent.x} ${parent.y - dy * 0.45}, ${child.x} ${child.y + dy * 0.45}, ${child.x} ${child.y + 6}"
        stroke="${TRUNK_C}" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.9"/>`;
    }
    const inoscFusionPoints = [];
    for (const [parentId, children] of childrenOf) {
      const parent = findNodeById(parentId);
      if (!parent) continue;
      if (children.length === 1) { svg += branchPath(parent, children[0]); continue; }
      const meanChildX = children.reduce((s, c) => s + c.x, 0) / children.length;
      const childY = children[0].y;
      const fY = parent.y + (childY - parent.y) * 0.42;
      const fX = (parent.x + meanChildX) / 2;
      inoscFusionPoints.push({ x: fX, y: fY, n: children.length });
      svg += `<path d="M ${parent.x} ${parent.y - 6}
        C ${parent.x} ${parent.y - 30}, ${fX} ${fY + 40}, ${fX} ${fY}"
        stroke="${TRUNK_C}" stroke-width="4.5" fill="none" stroke-linecap="round"/>`;
      for (const c of children) {
        svg += `<path d="M ${fX} ${fY}
          C ${fX} ${fY - 30}, ${c.x} ${c.y + 30}, ${c.x} ${c.y + 6}"
          stroke="${TRUNK_C}" stroke-width="3" fill="none" stroke-linecap="round" opacity="0.92"/>`;
      }
      // Inosculation knot
      svg += `<ellipse cx="${fX}" cy="${fY}" rx="5" ry="3.2"
        fill="${TRUNK_C_DARK}" stroke="${PAPER}" stroke-width="0.8"
        transform="rotate(20 ${fX} ${fY})"/>`;
    }

    // Leaves
    function leafGlyph(n) {
      const color = ARBOR_C[n.layer];
      const isCanopy = n.layer === 'GOV' || n.layer === 'L5';
      const baseR = isCanopy ? 9 : 7;
      let body = '';
      if (n._isGap) {
        body += `<circle cx="${n.x}" cy="${n.y}" r="${baseR}" fill="${PAPER}" stroke="${color}" stroke-width="1.7"/>`;
        body += `<g stroke="#DC2626" stroke-width="1.8" stroke-linecap="round">
                   <line x1="${n.x-3.4}" y1="${n.y-3.4}" x2="${n.x+3.4}" y2="${n.y+3.4}"/>
                   <line x1="${n.x-3.4}" y1="${n.y+3.4}" x2="${n.x+3.4}" y2="${n.y-3.4}"/>
                 </g>`;
      } else if (n.source === 'Verified') {
        body += `<circle cx="${n.x}" cy="${n.y}" r="${baseR + 5}" fill="#06B6D4" opacity="0.22"/>`;
        body += `<circle cx="${n.x}" cy="${n.y}" r="${baseR + 1}" fill="#06B6D4" stroke="${color}" stroke-width="1.6"/>`;
      } else {
        body += `<ellipse cx="${n.x}" cy="${n.y}" rx="${baseR + 1}" ry="${baseR - 2}"
          fill="${color}" stroke="${PAPER}" stroke-width="1.2"
          transform="rotate(-25 ${n.x} ${n.y})" filter="url(#leafShadow)"/>`;
      }
      return body;
    }
    function leafLabel(n, idx) {
      const dy = (idx % 2 === 0) ? -14 : 20;
      return `<text x="${n.x}" y="${n.y + dy}" text-anchor="middle"
        style="font-family:'IBM Plex Mono', monospace; font-size:9.5px; fill:${INK};">${escapeHtml(n.id)}</text>`;
    }
    for (const L of ARBOR_LAYERS) {
      byLayer[L].forEach((n, i) => {
        svg += `<g class="arbor-node" data-id="${escapeHtml(n.id)}" data-layer="${L}"
                  data-from="${n._isGap ? 'b' : 'a'}" style="cursor:pointer">
                  ${leafGlyph(n)}
                  ${leafLabel(n, i)}
                  <title>${escapeHtml(n.id + ' — ' + (n.title || ''))}${n._isGap ? ' · gap (from B)' : ''}</title>
                </g>`;
      });
    }

    // Root + label
    svg += `<circle cx="${ROOT_X}" cy="${ROOT_Y}" r="9" fill="${TRUNK_C_DARK}" stroke="${PAPER}" stroke-width="1.5"/>`;
    svg += `<text x="${ROOT_X}" y="${ROOT_Y + 38}" text-anchor="middle"
      style="font-family:'Newsreader', serif; font-style:italic; font-size:12px; fill:${INK_SOFT};">root · the service</text>`;

    // Inosculation legend
    if (inoscFusionPoints.length) {
      const total = inoscFusionPoints.length;
      const totalChildren = inoscFusionPoints.reduce((s, p) => s + p.n, 0);
      svg += `<g transform="translate(${VB_W - 280} ${VB_H - 92})">
        <rect x="0" y="0" width="260" height="74" rx="8" fill="#FFFDF6" stroke="${INK_SOFT}" stroke-width="0.8" opacity="0.92"/>
        <ellipse cx="20" cy="22" rx="5.5" ry="3.5" fill="${TRUNK_C_DARK}" transform="rotate(20 20 22)"/>
        <text x="36" y="20" style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; font-weight:700; fill:${INK};">SELF-INOSCULATION</text>
        <text x="36" y="36" style="font-family:'Newsreader', serif; font-size:11px; fill:${INK};">${total} fusion point${total === 1 ? '' : 's'} · ${totalChildren} converging branches</text>
        <text x="14" y="58" style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; fill:${INK_SOFT};">Two branches sharing an ancestor</text>
        <text x="14" y="71" style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; fill:${INK_SOFT};">fuse — lineage made visible.</text>
      </g>`;
    }

    // Reading guide
    svg += `<g transform="translate(20 ${VB_H - 92})">
      <rect x="0" y="0" width="420" height="74" rx="8" fill="#FFFDF6" stroke="${INK_SOFT}" stroke-width="0.8" opacity="0.92"/>
      <text x="14" y="20" style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; fill:${INK}; font-weight:700;">READING THE PLANT</text>
      <text x="14" y="38" style="font-family:'Newsreader', serif; font-size:11.5px; fill:${INK};">Filled ellipses = present · cyan halo = verified · ✕ open ring = gap.</text>
      <text x="14" y="55" style="font-family:'Newsreader', serif; font-size:11.5px; fill:${INK};">Affinity by shared tags decides parentage — which is what produces inosculation.</text>
      <text x="14" y="70" style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; fill:${INK_SOFT};">Click any leaf to open its drawer.</text>
    </g>`;

    svg += `</svg>`;
    return svg;
  }

  const svgA = showA ? buildTree(A, B) : null;
  const svgB = showB ? buildTree(B, A) : null;

  const cardA = svgA ? `
    <div class="arbor-wrap" data-pack="A" style="background:#EFE6CF; border-radius:8px; padding:12px; min-width:0;">
      <div style="display:flex; justify-content:space-between; margin:4px 8px 10px; color:#3B2F1E;">
        <span style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.06em;">PACK A · ${escapeHtml(A.name)}</span>
        <span style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; color:#7A6A50;">${escapeHtml(A.meta?.criticality || '')}</span>
      </div>${svgA}</div>` : '';
  const cardB = svgB ? `
    <div class="arbor-wrap" data-pack="B" style="background:#EFE6CF; border-radius:8px; padding:12px; min-width:0;">
      <div style="display:flex; justify-content:space-between; margin:4px 8px 10px; color:#3B2F1E;">
        <span style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.06em;">PACK B · ${escapeHtml(B?.name || '')}</span>
        <span style="font-family:'IBM Plex Mono', monospace; font-size:10.5px; color:#7A6A50;">${escapeHtml(B?.meta?.criticality || '')}</span>
      </div>${svgB}</div>` : '';
  const gridCols = (showA && showB) ? 'minmax(0,1fr) minmax(0,1fr)' : '1fr';

  host.innerHTML = `
    <div class="arbor-toolbar" style="display:flex; gap:10px; align-items:center; margin:2px 2px 10px;">
      <label style="font-family:'IBM Plex Mono', monospace; font-size:11px; letter-spacing:0.06em; color:var(--ink-4);">VIEW</label>
      <select id="arborViewSel" ${samePack ? 'disabled' : ''}
        style="font-family:'IBM Plex Mono', monospace; font-size:11px; padding:4px 8px; border-radius:6px;">
        <option value="A"    ${mode === 'A'    ? 'selected' : ''}>Pack A · ${escapeHtml(A.name)}</option>
        <option value="B"    ${mode === 'B'    ? 'selected' : ''} ${samePack ? 'disabled' : ''}>Pack B · ${escapeHtml((B || A).name)}</option>
        <option value="both" ${mode === 'both' ? 'selected' : ''} ${samePack ? 'disabled' : ''}>Both side-by-side</option>
      </select>
      ${samePack ? `<span style="font-family:'Newsreader', serif; font-style:italic; font-size:11px; color:var(--ink-4);">pick a Pack B to enable side-by-side</span>` : ''}
    </div>
    <div class="arbor-pair" style="display:grid; grid-template-columns:${gridCols}; gap:14px; align-items:start;">
      ${cardA}${cardB}
    </div>`;

  // Click-through per card
  const cardAEl = host.querySelector('[data-pack="A"]');
  if (cardAEl) cardAEl.querySelectorAll('.arbor-node').forEach(el => {
    el.addEventListener('click', () => {
      const list = flatLayer(A, el.dataset.layer);
      const target = list.find(x => x.id === el.dataset.id) || list[0];
      if (target && onClick) onClick(target, el.dataset.layer);
    });
  });
  const cardBEl = host.querySelector('[data-pack="B"]');
  if (cardBEl && B) cardBEl.querySelectorAll('.arbor-node').forEach(el => {
    el.addEventListener('click', () => {
      const list = flatLayer(B, el.dataset.layer);
      const target = list.find(x => x.id === el.dataset.id) || list[0];
      if (target && onClick) onClick(target, el.dataset.layer);
    });
  });

  // View selector
  const sel = host.querySelector('#arborViewSel');
  if (sel) sel.addEventListener('change', () => {
    opts.onArborViewChange?.(sel.value);
  });
}

const RENDERERS = {
  strata:        renderStrata,
  periodic:      renderPeriodic,
  constellation: renderConstellation,
  skyline:       renderSkyline,
  transit:       renderTransit,
  arbor:         renderArbor,
};

export function render(variant, host, dataset, opts = {}) {
  const fn = RENDERERS[variant];
  if (!fn) {
    host.innerHTML = `<div class="placeholder">${escapeHtml(variant)} — coming in a follow-up restoration PR.</div>`;
    return;
  }
  try {
    fn(host, dataset, opts);
  } catch (e) {
    host.innerHTML = `<div class="error">Atlas render failed: ${escapeHtml(e.message)}</div>`;
    console.error('[atlas]', e);
  }
}

// Only export the variants we actually ship. constellation/skyline/transit/
// arbor return to VARIANTS as their faithful ports land.
export const VARIANTS = Object.keys(RENDERERS);
