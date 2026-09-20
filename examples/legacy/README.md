# Previous pack format — layered JSON

These four files are the **original pack format** (from when Observogram was named Tomograph): the layered
"studio-shape" JSON that the studio consumed before the canonical
ObservabilityPack v1.2 migration (Changelog 0.3.0, Phase 5). They are
restored verbatim from git history as working examples of the format.

```
{
  "id": "...", "name": "...", "badge": "...", "description": "...",
  "layers": {
    "L1": [ { "id", "source": "BAU"|"GAP", "title", "desc", "tool", "tags" }, ... ],
    "L2": [ ... ],
    "L3": [ ... ],
    "L4": { "policy": [...], "alerting": [...], "healing": [...] },
    "L5": [ ... ],
    "GOV": [ ... ]
  }
}
```

## Loading them today

Observogram still accepts this format everywhere a pack can enter:

- **Studio upload** — pick any of these files; the server detects the
  layered shape and upconverts it to a canonical v1.2 manifest at the
  gate (`POST /api/validate`), then everything downstream (validate,
  conformance, compile, deploy, diff) works on the import like on any
  other pack. The toast reports the conversion.
- **CLI** — `npm run upconvert-legacy examples/legacy/production-curated.json`
  prints the canonical JSON (add `-o out.pack.json` to write a file).

## What the conversion preserves — and what it marks

The legacy format declared **what existed** (titles, tools, BAU/GAP
status) but never the machine detail (PromQL exprs, burn-rate windows,
alert channels). The upconverter (`tools/lib/legacy.mjs`) is honest about
that line:

- Every legacy artefact is preserved **verbatim** in
  `metadata.annotations["legacy.artefact.<LAYER>.<ID>"]` — nothing is lost.
- Wherever a schema-required machine field had to be filled with a
  placeholder, the artefact is marked `crawler.scaffold.<symbol>` and
  projects as **Scaffold**, never Declared. Replace the placeholders with
  real values to earn Declared status (conformance shows the list).
- Legacy `GAP` items always convert as scaffolds.

`tools/test-legacy-pack.mjs` gates all four examples on every `npm test`.
