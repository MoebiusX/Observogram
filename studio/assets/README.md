# studio/assets

Static assets served by the studio at `/assets/...`.

## observogram-hero.png

The Discover dashboard (the "<SHORT NAME> SCAN" panel) renders this image as
the scanner centerpiece — its path and alt text are the brand's `hero.src` /
`hero.alt` (`tools/lib/brand.mjs`; defaults below). A rebadged brand (one
that sets `name`) shows the CSS fallback until it names its own `hero.src`,
so upstream's art never appears under another name:

```
studio/assets/observogram-hero.png   →   served at /assets/observogram-hero.png
```

Drop the CT-scanner hero render here and it appears instantly — no code
change needed. The `<img>` tag in `renderDiscoverDashboard()` points at
this exact path by default.

If the file is absent, the dashboard falls back to a CSS-rendered stack
of layer slabs (L1 Identity … L5 Operations) with live artefact counts,
so the view is never broken. The raster simply replaces the fallback
when present.

Recommended: wide landscape (≈ 1600×900 or similar), dark background so
it blends with the navy chrome.
