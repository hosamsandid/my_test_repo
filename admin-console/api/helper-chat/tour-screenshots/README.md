# Helper Chat tour screenshots

These PNGs are the screenshots shown by the Helper Chat **Tour** (#1736). They
are **committed on purpose** and **generated, not hand-authored** — do not edit
them by hand.

## Why they live here

`api.js` serves them at `/api/helper/tour-screenshot/<journey>/<step>.png` from
`TOUR_ARTIFACTS_DIR`, which defaults to this directory. They sit next to the
generated `tour-manifest.json` so the Dockerfile's
`COPY api/helper-chat ./api/helper-chat` bakes them into the admin-console image
— the tour would 404 on every screenshot otherwise, because the real captures
live under the gitignored `e2e/artifacts/`, outside the image build context.

## How they are produced

A green journey run (`e2e/journeys/*.yaml`) captures one PNG per narrated step
into `e2e/artifacts/<journey>/<step>.png`. Then:

```
make tour-screenshots   # = make tour-manifest + vendor the referenced PNGs here
```

`make tour-manifest` regenerates `../tour-manifest.json` from the captures
(dropping any step whose PNG is missing); the vendoring step
(`e2e/journey-runner/copy-tour-screenshots.js`) copies exactly the PNGs the
manifest references into this directory. Commit the diff.

## Staying fresh

The scheduled **`.github/workflows/tour-screenshots.yml`** re-runs the journey
pass weekly (and on manual dispatch), runs `make tour-screenshots`, and opens a
PR when anything changed — a human merges it to publish the refreshed tour.
`make tour-screenshots:check` (also runnable in CI) fails if the committed PNGs
have drifted from the captures / the manifest.
