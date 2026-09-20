# studio/assets

Static assets served by the studio at `/assets/...`.

## observogram-hero.png

The Discover dashboard (OBSERVOGRAM SCAN) renders this image as the scanner
centerpiece:

```
studio/assets/observogram-hero.png   →   served at /assets/observogram-hero.png
```

Drop the CT-scanner hero render here and it appears instantly — no code
change needed. The `<img>` tag in `renderDiscoverDashboard()` points at
this exact path.

If the file is absent, the dashboard falls back to a CSS-rendered stack
of layer slabs (L1 Identity … L5 Operations) with live artefact counts,
so the view is never broken. The raster simply replaces the fallback
when present.

Recommended: wide landscape (≈ 1600×900 or similar), dark background so
it blends with the navy chrome.
