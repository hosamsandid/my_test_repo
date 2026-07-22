# Revideo patches (patch-package)

Revideo 0.10.4 needs three small fixes, proven in the original PoC. They are applied
via `patch-package` on `postinstall` (see `../package.json`). This directory holds
the `.patch` files.

**Status (#742 / T2 — done):** the patch files are committed and applied by
`patch-package` on every `npm ci` (see `../package.json` `postinstall`). Verified to
apply cleanly against a fresh `npm ci` of the committed lock. `scripts/patches.test.mjs`
(runs on the fast CI lane, no toolchain install) guards that each of the three fixes
below stays encoded in the committed patches.

The three fixes land in **two** patch files (patch-package writes one file per
package): `@revideo+renderer+0.11.0.patch` carries fixes 1 + 2, and
`@revideo+ffmpeg+0.10.4.patch` carries fix 3.

**Regenerating** (after a `@revideo/*` version bump — the file names embed the
version): `npm ci`, re-apply the three edits to the files under `node_modules/@revideo/…`,
then `npx patch-package @revideo/renderer @revideo/ffmpeg` and commit the refreshed
`patches/*.patch` (delete the old-version files).

## The three fixes

1. **`@revideo/renderer` — strip hardcoded `--single-process`** (`lib/server/render-video.js`).
   The renderer unconditionally `args.push('--single-process')` before launching
   Chrome, which crashes headless Chrome on some Linux/CI hosts. The patch drops the
   forced push so callers opt in via `settings.puppeteer.args`. (`render.ts` also
   filters the flag defensively from `puppeteer.launch`, so this is belt-and-braces —
   the source fix is the durable one and lets that runtime shim be retired later.)

2. **`@revideo/renderer` — basename the outFile** (`lib/server/validate-settings.js`).
   Revideo builds its temp folder as `revideo-<outputFileName>-<uuid>` from the
   `outFile` (minus extension); an absolute or slashed `outFile` produces an invalid
   folder name. The patch takes `path.basename(settings.outFile)` before stripping the
   extension, so a full path can no longer corrupt the temp-folder name. (`render.ts`
   also passes only the basename in `settings.outFile` + the dir in `settings.outDir`.)

3. **`@revideo/ffmpeg` — configurable public folder for audio assets** (`dist/utils.js`).
   `resolvePath` hardcodes `path.join(output, '../public', assetPath)`, so audio MP3s
   only resolve when `outDir` is a sibling of `./public` (see the PoC's
   `AUDIO-FIX-REPORT.md`). The patch honours `process.env.REVIDEO_PUBLIC_DIR` when set
   and falls back to the original `<output>/../public` otherwise — backwards-compatible,
   so the existing `render.ts` convention keeps working unchanged.

## Upstreaming

These are candidates for upstream PRs to https://github.com/redotvideo/revideo.
Until then, `patch-package` keeps them surviving a fresh `npm ci`.
