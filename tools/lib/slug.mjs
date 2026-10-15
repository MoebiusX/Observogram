// tools/lib/slug.mjs
//
// The three slug flavours used across the toolchain, in one place. They are
// deliberately different — filenames want '-', PromQL-safe symbols want '_',
// and wire-derived service names need a fallback + length cap — so each is
// exported under a name that says which contract it satisfies.

// Dash slug for filenames and pack ids: lowercase, non [a-z0-9_-] → '-',
// runs collapsed, edges trimmed. May return '' for all-junk input.
export function fileSlug(s, fallback = 'pack') {
  if (typeof s !== 'string') return fallback;
  return s.toLowerCase().replace(/[^a-z0-9_-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

// fileSlug plus a minimum-length fallback and 50-char cap — for service
// names coming off the wire, where '' or a single junk char isn't a usable id.
export function serviceSlug(s, fallback = 'svc') {
  if (typeof s !== 'string' || !s) return fallback;
  const cleaned = fileSlug(s, fallback);
  if (cleaned.length < 2) return fallback;
  return cleaned.slice(0, 50);
}

// Underscore slug for symbol identifiers (PromQL rule/metric names):
// lowercase, non [a-z0-9-] runs → '_', edges trimmed.
export function symbolSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9-]+/g, '_').replace(/^_+|_+$/g, '');
}

// The metric-name prefix of a pack: fileSlug with '-' → '_' (`payment-service` →
// `payment_service`). Every recording rule the generators emit is named with it
// (`<prefix>:<sli>:…`, `<prefix>:inventory:<kind>`), so it lives here, a leaf module, and
// burn-rules.mjs re-exports it: a downstream that vendors only the site core needs no more.
export const metricPrefix = (name) => fileSlug(String(name ?? 'pack'), 'pack').replace(/-/g, '_');

// The spec Slug (`$defs.Slug`: ^[a-z][a-z0-9_-]*[a-z0-9]$, 2..64) for a value the
// crawler must spell canonically — a folder name, an environment, an owner:
// lowercase; every run outside [a-z0-9_-] → '-'; '-' runs collapsed; leading
// '-'/'_' stripped; PREFIXED (never truncated at the front) when the first
// character is not a letter (`1password` → `svc-1password`); cut at 64, then
// trailing non-alphanumerics trimmed; fewer than 2 characters → `fallback`.
// Mirrors the schema pattern by hand (a browser-safe module cannot read the
// schema file); tools/test-crawl-canonical.mjs pins the mirror.
export function packSlug(s, fallback = 'crawled-service', { prefix = 'svc-' } = {}) {
  let out = String(s ?? '').toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-_]+/, '');
  if (out && !/^[a-z]/.test(out)) out = `${prefix}${out}`;
  out = out.slice(0, 64).replace(/[^a-z0-9]+$/, '');
  return out.length >= 2 ? out : fallback;
}

