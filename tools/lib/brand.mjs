// tools/lib/brand.mjs — the one brand config (docs/DOWNSTREAM.md §9, the
// branding seam).
//
// Everything the studio shell, the JS chrome, the auth pages and the design
// tokens say about the PRODUCT — its name, wordmark, tagline, logo, footer,
// links, hero — comes from one normalized brand object. The default is
// today's Observogram, string for string: DEFAULT_BRAND is normalizeBrand({})
// and tools/test-brand.mjs pins every default against the literal it
// replaced. A downstream rebadges with a JSON file (OBSERVOGRAM_BRAND_FILE,
// read by tools/lib/brand-env.mjs loadBrand) or the OBSERVOGRAM_BRAND_*
// scalars; one `name` is enough — every other string derives from it unless
// the override names it.
//
// Browser-safe and zero-import (a listed vendorable module): the
// studio loads it the house way (`import('/lib/brand.mjs')`, studio/brand.mjs)
// and the server imports it for the shell and the auth pages.
//
// Trust boundary. Every brand string is escaped where it lands: text nodes
// text-escaped, attribute values attribute-escaped (escapeHtml does both,
// `& < > " '`). The ONE raw field is logo.svg — inline SVG markup, injected
// only through innerHTML into the JS header (studio/app.mjs) and never into
// the server-rendered shell or the auth pages; normalizeBrand refuses a value
// that is not `<svg…` or that carries `<script` — a tripwire for a pasted
// page, not a sanitizer: the brand file is operator config like any other
// server file.
//
// What is NOT brand (and never reads this module): protocol and storage
// names — the X-Observogram-* headers, the observogram_* cookies, the
// observogram.* annotation keys, the .observogram/ workspace, compiled
// artefacts and the gen-site output (golden-gated, brand-free).

const UPSTREAM = Object.freeze({
  name: 'Observogram',
  wordmark: Object.freeze({ lead: 'Observo', tail: 'gram' }),
  compassMark: 'OBSERVO',
  repoUrl: 'https://github.com/MoebiusX/Observogram',
  changelogUrl: 'https://github.com/MoebiusX/Observogram/blob/develop/docs/CHANGELOG.md',
});

export const SPEC_LINK = Object.freeze({
  label: 'spec v1.4',
  href: 'https://github.com/MoebiusX/otel-observability-pack/blob/e64e58132a46364afd5432a86e67d470858936cf/spec/ObservabilityPack-Spec.md',
});

// The description's tail after "<name> — ".
const DESCRIPTION_TAIL = 'write one ObservabilityPack manifest, compile it to Prometheus / Grafana / OTel Collector / Alertmanager, scan your posture and score conformance. Trust what your eyes see.';

// The header hexagon (studio/reskin.css re-strokes it with --og-accent).
export const DEFAULT_LOGO_SVG = `<svg viewBox="0 0 36 36" fill="none" xmlns="http://www.w3.org/2000/svg">
            <defs>
              <linearGradient id="observaLogoG" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0%"  stop-color="#3b82f6"/>
                <stop offset="50%" stop-color="#a855f7"/>
                <stop offset="100%" stop-color="#10b981"/>
              </linearGradient>
            </defs>
            <path d="M18 3 L31 11 L31 25 L18 33 L5 25 L5 11 Z" stroke="url(#observaLogoG)" stroke-width="2" fill="none"/>
            <path d="M18 11 L25 15 L25 22 L18 26 L11 22 L11 15 Z" stroke="url(#observaLogoG)" stroke-width="1.4" fill="rgba(168,85,247,0.12)"/>
            <circle cx="18" cy="18" r="2.4" fill="url(#observaLogoG)"/>
          </svg>`;

export const TOKEN_NAME_RE = /^[a-z][a-z0-9-]*$/;

export function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
// A string field: trimmed; anything else (missing, null, a number) is "not given".
const str = (v) => (typeof v === 'string' ? v.trim() : '');
const given = (v) => str(v) !== '';
const pick = (v, fallback) => (given(v) ? str(v) : fallback);

function normalizeLinks(raw, fallback) {
  if (!Array.isArray(raw)) return fallback;
  return raw
    .filter((l) => isPlainObject(l) && given(l.label) && given(l.href))
    .map((l) => Object.freeze({ label: str(l.label), href: str(l.href) }));
}

function normalizeTokens(raw, theme) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  for (const [name, value] of Object.entries(raw)) {
    if (!TOKEN_NAME_RE.test(name)) throw new Error(`brand: tokens.${theme}.${name} is not a design token name`);
    const v = str(value);
    if (!v) continue;
    if (/[;{}<>]/.test(v)) throw new Error(`brand: token value for ${name} contains ;{}<>`);
    out[name] = v;
  }
  return out;
}

function normalizeLogoSvg(raw) {
  if (!given(raw)) return DEFAULT_LOGO_SVG;
  const svg = str(raw);
  if (!/^<svg[\s>]/i.test(svg) || /<script/i.test(svg)) throw new Error('brand: logo.svg is not inline SVG');
  return svg;
}

const deepFreeze = (o) => {
  for (const v of Object.values(o)) if (v && typeof v === 'object' && !Object.isFrozen(v)) deepFreeze(v);
  return Object.freeze(o);
};

/**
 * normalizeBrand(raw) — the brand object every renderer reads. `raw` is a
 * plain object (the brand file, merged with the env scalars); anything else
 * is treated as {}. Every field has a default; the defaults derive from
 * `name` when the override names it (a one-field rebadge rebrands every
 * string) and are the upstream literals when it does not. `configured` is
 * whether anything at all was given.
 */
export function normalizeBrand(raw) {
  const r = isPlainObject(raw) ? raw : {};
  const configured = Object.keys(r).length > 0;
  const named = given(r.name);
  const name = named ? str(r.name) : UPSTREAM.name;
  const shortName = pick(r.shortName, name);
  const titleSuffix = pick(r.titleSuffix, 'the Observability Compiler');
  const tagline = pick(r.tagline, 'the observability compiler');
  const wordmark = isPlainObject(r.wordmark) && given(r.wordmark.lead)
    ? { lead: str(r.wordmark.lead), tail: str(r.wordmark.tail) }
    : named ? { lead: name, tail: '' } : { ...UPSTREAM.wordmark };
  const docsUrl = str(r.docsUrl);
  const footerRaw = isPlainObject(r.footer) ? r.footer : {};
  const defaultLinks = named
    ? [SPEC_LINK, ...(docsUrl ? [{ label: 'docs', href: docsUrl }] : [])]
    : [SPEC_LINK, { label: 'repo', href: UPSTREAM.repoUrl }];
  const logoRaw = isPlainObject(r.logo) ? r.logo : {};
  const aboutRaw = isPlainObject(r.about) ? r.about : {};
  const heroRaw = isPlainObject(r.hero) ? r.hero : {};
  const tokensRaw = isPlainObject(r.tokens) ? r.tokens : {};
  const brand = {
    configured,
    name,
    shortName,
    wordmark,
    tagline,
    titleSuffix,
    description: pick(r.description, `${name} — ${DESCRIPTION_TAIL}`),
    compassMark: pick(r.compassMark, named ? shortName.toUpperCase() : UPSTREAM.compassMark),
    docsUrl,
    logo: { svg: normalizeLogoSvg(logoRaw.svg), url: str(logoRaw.url) },
    favicon: str(r.favicon),
    footer: {
      text: pick(footerRaw.text, `${name} · ${titleSuffix}`),
      links: normalizeLinks(footerRaw.links, defaultLinks),
    },
    about: { changelogUrl: pick(aboutRaw.changelogUrl, named ? docsUrl : UPSTREAM.changelogUrl) },
    // The Discover hero is upstream art: a rebadged brand shows the CSS
    // fallback until it names its own (studio/assets/README.md).
    hero: { src: pick(heroRaw.src, named ? '' : '/assets/observogram-hero.png'), alt: pick(heroRaw.alt, `${name} scan`) },
    tokens: { light: normalizeTokens(tokensRaw.light, 'light'), dark: normalizeTokens(tokensRaw.dark, 'dark') },
  };
  return deepFreeze(brand);
}

export const DEFAULT_BRAND = normalizeBrand({});

/**
 * brandChrome(brand) — every chrome string, escaped for where it lands.
 * Plain strings are text (escape them where they enter markup); the *Html
 * members are markup, already escaped; logoHtml is the one that may carry
 * the raw logo.svg (innerHTML in the JS header only).
 */
export function brandChrome(b = DEFAULT_BRAND) {
  const { name, shortName, tagline, wordmark, logo, footer, about, hero, favicon } = b;
  const wordmarkHtml = (tag = 'strong', attrs = '', { upper = false } = {}) => {
    const lead = upper ? wordmark.lead.toUpperCase() : wordmark.lead;
    const tail = upper ? wordmark.tail.toUpperCase() : wordmark.tail;
    const open = `<${tag}${attrs ? ` ${attrs}` : ''}>`;
    return `${escapeHtml(lead)}${tail ? `${open}${escapeHtml(tail)}</${tag}>` : ''}`;
  };
  const footerLinksHtml = footer.links
    .map((l) => `<a href="${escapeHtml(l.href)}" target="_blank" rel="noopener">${escapeHtml(l.label)}</a>`)
    .join('\n    ·\n    ');
  return Object.freeze({
    name,
    shortName,
    tagline,
    description: b.description,
    title: `${name} — ${b.titleSuffix}`,
    homeAriaLabel: `${name} home`,
    aboutLabel: `About ${name}`,
    resetTitle: `Reset ${name}?`,
    apiUnreachable: `Failed to reach ${name}'s API.`,
    scannerTitle: `${shortName.toUpperCase()} SCAN`,
    compassMark: b.compassMark,
    libraryTip: `Instantiated from the ${name} library.`,
    loginTitle: `${name} — sign in`,
    footerText: footer.text,
    footerLinksHtml,
    aboutChangelogHref: about.changelogUrl,
    heroSrc: hero.src,
    heroAlt: hero.alt,
    favicon,
    versionTitle: (label) => `${name} ${label}`,
    wordmarkHtml,
    logoHtml: (cls = '') => (logo.url ? `<img class="${escapeHtml(cls)}" src="${escapeHtml(logo.url)}" alt="">` : logo.svg),
  });
}

/** The token overrides as CSS; '' when the brand sets none. */
export function brandTokensCss(b = DEFAULT_BRAND) {
  const decl = (map) => Object.entries(map).map(([k, v]) => `--og-${k}:${v};`).join('');
  const light = decl(b.tokens.light);
  const dark = decl(b.tokens.dark);
  if (!light && !dark) return '';
  return `${light ? `:root{${light}}\n` : ''}${dark ? `[data-theme="dark"]{${dark}}\n` : ''}`;
}

// The shell literals brandShellHtml replaces — studio/index.html as shipped.
// Each is anchored exactly; a missing anchor throws, so a shell edit fails
// tools/test-brand.mjs instead of silently un-branding a deployment.
const d = brandChrome(DEFAULT_BRAND);
export const SHELL_ANCHORS = Object.freeze({
  title: `<title>${d.title}</title>`,
  description: `<meta name="description" content="${d.description}">`,
  h1: `<h1>${d.wordmarkHtml('span', 'class="ital"')}</h1>`,
  hdrSub: `<div class="hdr-sub">${d.tagline} · canonical spec v1.4</div>`,
  footerText: `<footer class="ftr">\n  <div>${d.footerText} · <span id="build-label"`,
  footerLinks: `  <div>\n    ${d.footerLinksHtml}\n  </div>\n</footer>`,
  tokensLink: '<link rel="stylesheet" href="/design-tokens.css">',
});

function replaceOnce(html, anchor, replacement, what) {
  const at = html.indexOf(anchor);
  if (at < 0 || html.indexOf(anchor, at + 1) >= 0) throw new Error(`brand: shell anchor missing or repeated (${what}): ${anchor.split('\n')[0]}`);
  return html.slice(0, at) + replacement + html.slice(at + anchor.length);
}

/** The JSON the studio reads back (studio/brand.mjs readBrandConfig), safe inside a <script>. */
export function brandConfigScript(b) {
  // `<` becomes \u003c so no "</script" can end the element; the two JSON-
  // legal line separators (U+2028/9) are escaped the same way.
  const json = JSON.stringify(b).replace(/[<\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
  return `<script type="application/json" id="brand-config">${json}</script>`;
}

/**
 * brandShellHtml(html, brand) — studio/index.html rebadged. The identity
 * when the brand is not configured (the inert proof: the same string back).
 */
export function brandShellHtml(html, b) {
  if (!b || !b.configured) return html;
  const c = brandChrome(b);
  let out = String(html);
  out = replaceOnce(out, SHELL_ANCHORS.title, `<title>${escapeHtml(c.title)}</title>`, 'title');
  out = replaceOnce(out, SHELL_ANCHORS.description, `<meta name="description" content="${escapeHtml(c.description)}">`, 'description');
  out = replaceOnce(out, SHELL_ANCHORS.h1, `<h1>${c.wordmarkHtml('span', 'class="ital"')}</h1>`, 'h1');
  out = replaceOnce(out, SHELL_ANCHORS.hdrSub, `<div class="hdr-sub">${escapeHtml(c.tagline)} · canonical spec v1.4</div>`, 'hdr-sub');
  out = replaceOnce(out, SHELL_ANCHORS.footerText, `<footer class="ftr">\n  <div>${escapeHtml(c.footerText)} · <span id="build-label"`, 'footer text');
  out = replaceOnce(out, SHELL_ANCHORS.footerLinks, `  <div>\n    ${c.footerLinksHtml}\n  </div>\n</footer>`, 'footer links');
  const tokensCss = brandTokensCss(b);
  const head = [
    SHELL_ANCHORS.tokensLink,
    ...(tokensCss ? [`<style id="brand-tokens">\n${tokensCss}</style>`] : []),
    brandConfigScript(b),
    ...(c.favicon ? [`<link rel="icon" href="${escapeHtml(c.favicon)}">`] : []),
  ].join('\n');
  out = replaceOnce(out, SHELL_ANCHORS.tokensLink, head, 'design-tokens link');
  return out;
}
