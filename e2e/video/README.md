# Walkthrough video lane (Revideo, audio-driven)

Turns the journey walkthrough into a **narrated explainer video**: for each step we
show its **screenshot, held for exactly as long as the auto-generated voiceover
takes**, with a gentle Ken-Burns zoom, an eyebrow (`Step N · …`) and a short caption.
The audio — not slowMo — drives how long each view is shown, so a chapter lands at a
readable, self-explanatory pace (Team Setup ≈ 80s over 6 beats).

**Primary approach: screenshots-per-step** (`revideo/example-team-setup.tsx`). It
reuses the screenshots the journey *screenshot* run already captures — no second
video recording, no cut-marks, no transcode. A **continuous-clip beat** (real click
motion, `revideo/example-variant-c.tsx`) stays available as an **optional per-step
enhancement** for steps where showing an interaction matters (typing, dragging); it
is not on the critical path.

This lane is a **self-contained Revideo sub-project** (own `package.json`), so the
heavy `@revideo/*` deps only install for the video job, not the normal `make e2e`
run. It supersedes the earlier ffmpeg assembler (PR #738); the recording side
(`journey-video` Playwright project + `journeys.spec.js` saving `journey.webm`) is
unchanged and still feeds this lane.

Epic **#741**. Foundation vendored from the proven Revideo PoC (MIT).

## Proof (#742)

Both approaches are proven end-to-end on this stack, rendered to **H.264 + AAC mp4**
with audible Edge-TTS narration:

Two chapters are built on the shared beat builder (`revideo/walkthrough.tsx`), the
shape T5 generalises to every journey:

- **Team Setup** — `revideo/example-team-setup.tsx`: 7 beats ≈ **98s** (the Process
  step is two beats so "we pick Core SDLC" matches the screen).
  `npm run render:team-setup` → `out/final/team-setup-walkthrough.mp4`.
- **IBAN Story / "Working with Agents"** — `revideo/example-iban-story.tsx`: 9 beats
  ≈ **197s**, the end-to-end idea→issue→approval→PR→review→merge story.
  `npm run render:iban-story` → `out/final/iban-story-walkthrough.mp4`.

Both are self-contained from committed fixtures (no stack, no recording, no network).

- **Continuous-clip beat** (optional motion) — `revideo/example-variant-c.tsx`:
  motion 0–3.5s → freeze → hold, `npm run render:example`.

Foundation findings baked in:

1. **Video/audio/image assets are served from `public/`**, not vite-imported — the
   ffmpeg bridge maps URLs back to `<outDir>/../public`. `prep:shots` / `prep:clips`
   copy the fixtures there.
2. **Audio is muxed on afterwards, not played by Revideo.** Revideo mixes every
   `<Audio>` node toward the scene end, so multiple beats' voiceovers accumulate and
   clip (loudness grew monotonically to 0 dBFS by the last beat). The scene renders
   **silent** (still timed to the audio durations via `audioSec`), and
   `scripts/mux-narration.mjs` lays each MP3 at its exact beat offset with a limiter
   → flat, clip-free loudness (verified ~−22 dB mean across the whole video).
3. **Optional motion clips must be H.264 mp4**, not VP9 `.webm` (what Playwright
   records): Revideo's frame extractor fails on webm (`ffprobe: No input specified`).
   Only relevant if/when the optional clip beat is used — the screenshot path avoids
   video entirely.

## Container feasibility — read this first

Rendering needs **headless Chromium + ffmpeg**, and the voiceover needs **Edge-TTS**
(network). Agent containers have none of these — same constraint PR #738 already
called out for ffmpeg. So the division of labour is:

- **Agent work** (any container): the **pure logic + unit tests** — segment planning,
  freeze/hold durations, subtitle timing, the journey→beats mapping. No render.
- **Render + TTS**: the **manual CI job** (T1/#749) or a workstation. The `.mp4` and
  the MP3s are produced there, never inside the agent container.

An agent that finds it "can't render locally" is **not blocked** — a green unit-test
suite + the code is the deliverable; the video is verified from the CI artifact.

## Pipeline

```
journeys/*.yaml ──▶ voiceover: field ──▶ extract-narration.js ──▶ generated/<id>.narration.json
  (per step, T4/#744)                    (journey-runner, npm run          │  [{id,text}] in beat order
                                          journeys:narration)              ▼
                                                              generate-tts.py <file>  (Edge-TTS)
                                                                            │
                                              public/audio/<id>.mp3  ◀───────┴──▶  data/audio-manifest.json
                                                    │                                      │ (durations, merged)
        journey screenshot run ──▶ e2e/artifacts/<id>/<name>.png                          │
                    │                       │                                              ▼
                    └───────────────────────┴──────────────────────▶  journey→beats (T5/#745)
                                                                         → makeWalkthroughProject → render silent
                                                                         → mux-narration.mjs → <id>-walkthrough.mp4
```

**T4 (#744) live narration — done.** The storyline now lives in the journey YAML:
each step carries a compact `voiceover:` (distinct from the deck's fuller
`narrative`). `npm run journeys:narration` (in `e2e/`) extracts every journey's
voiceover into `scripts/generated/<journeyId>.narration.json` (audio id
`<journeyId>-<screenshot|id>`), which `python3 scripts/generate-tts.py
scripts/generated/<journeyId>.narration.json` turns into `public/audio/*.mp3`
plus a **merged** `data/audio-manifest.json`. T5 (#745) reads the same journey to
map each beat's screenshot + audio id and replace the hardcoded example beat lists.

## Files (vendored foundation)

| Path | Role | Status |
|---|---|---|
| `revideo/walkthrough.tsx` | **shared beat builder** (`makeWalkthroughProject(name, beats)`) — screenshots-per-step, Ken-Burns + eyebrow + caption, audio-driven dwell | reference — T5 feeds it journey beats |
| `revideo/example-team-setup.tsx` | Team Setup chapter (7 beats) — thin beat list over the builder | reference |
| `revideo/example-iban-story.tsx` | IBAN Story chapter (9 beats) — thin beat list over the builder | reference |
| `revideo/example-variant-c.tsx` | optional-motion reference — continuous clip → freeze → hold | reference (optional path) |
| `revideo/utils/audio.tsx` | `audioSec(id)` + `audioUrl(id)` + `playAndWait(...)` — **the audio-driven timing primitive** | vendored, reuse as-is |
| `revideo/utils/transitions.ts` | `fadeIn` / `fadeOut` / `crossFade` | vendored |
| `revideo/render.ts` | CLI renderer (`renderVideo` + the puppeteer/outDir workarounds) | vendored |
| `scripts/generate-tts.py` | Edge-TTS → MP3 + `data/audio-manifest.json` (real durations) | vendored, reuse as-is |
| `scripts/team-setup.narration.json` | the demonstrator's per-step `voiceover:` text (the source of the committed mp3s) | fixture |
| `scripts/extract-narration.mjs` | legacy tsx-scraping extractor (the demonstrator example scenes) | **superseded** by the journey `voiceover:` extractor below |
| `../journey-runner/bin/extract-narration.js` | **journey-driven extractor** (T4/#744): `journeys/*.yaml` `voiceover:` → `scripts/generated/<id>.narration.json` | live — `npm run journeys:narration` |
| `../journey-runner/narration.js` | pure `journeyNarration(doc)` + `stepAudioId(journeyId, step)` — the one-place journey→audio-id mapping T5 reuses | live |
| `scripts/generated/<id>.narration.json` | per-journey narration (gitignored — regenerated from the YAML) | generated |
| `fixtures/shots/*.png` | the 5 Team Setup step screenshots (demonstrator) — `prep:shots` copies them to `public/shots/` | fixture |
| `fixtures/audio/*.mp3` + `audio-manifest.json` | the demonstrator's Edge-TTS voiceovers — `prep:audio` copies them to `public/audio/` + `data/` | fixture |
| `fixtures/sample-journey.mp4` | a short real UI clip (H.264) for the optional-motion reference | fixture |
| `data/audio-manifest.json` | durations the scene reads (seeded `{}`; `prep:audio` regenerates it at render time) | generated |
| `vite.config.ts` | the `@revideo/vite-plugin` config the renderer bundles with | vendored |
| `patches/` | the three Revideo fixes (see `patches/README.md`), applied by `patch-package` on `npm ci` postinstall | committed (T2/#742) — verified to apply on a fresh `npm ci` |

## Local render (workstation with Chromium + ffmpeg)

```bash
cd e2e/video
npm ci                     # installs @revideo/* + applies patches (postinstall)
# optional: generate the sample voiceover so the example has audio
#   echo '[{"id":"example-step","text":"The wizard opens on the Process step."}]' > scripts/narration.json
#   python3 scripts/generate-tts.py
npm run render:example     # → out/final/example-variant-c.mp4
```

Without a prior TTS run the example still renders; `audioSec` falls back to a 1s
hold per beat (see `audio.tsx`).

**Browser note.** Rendering needs a Chromium. In CI, puppeteer's `postinstall`
downloads it (and `apt-get ffmpeg` covers ffmpeg). On a workstation whose npm blocks
install scripts (npm ≥ 26 "allow-scripts"), puppeteer's Chromium may be missing —
point it at an existing one, e.g. Playwright's:

```bash
export PUPPETEER_EXECUTABLE_PATH="$(node -e "console.log(require('playwright').chromium.executablePath())" 2>/dev/null \
  || ls ~/Library/Caches/ms-playwright/chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell | tail -1)"
```

## Manual CI render (`walkthrough-video.yml`, #749)

The render runs as its own **manual** workflow, `.github/workflows/walkthrough-video.yml`
(`workflow_dispatch` — never on a schedule or a PR). Start it from the Actions UI
with:

- **journeys** — `all` (default) or comma-separated chapter ids (`team-setup,iban-story`).
- **language** — narration language; reserved for the language decision, not yet consumed.
- **slowmo** — reserved; the audio-driven render ignores it (audio drives dwell, not slowMo).

It installs ffmpeg + Chromium, runs `npm run render:walkthrough` (which renders the
selected chapters via `scripts/render-walkthrough.mjs` + `scripts/chapters.mjs`), and
uploads `out/final/` as the `walkthrough-video` artifact. Add a chapter by adding a
`render:<id>` script here and an entry to `CHAPTERS` in `scripts/chapters.mjs`; the
selection logic is unit-tested (`npm run test:unit`, dependency-free) and runs on the
fast CI lane.

## Open tickets on this lane

T1 #749 (dispatch trigger) · **T2 #742 (spike + finalise patches)** · T3 #743
(cut-marks) · T4 #744 (`voiceover:` + TTS) · T5 #745 (journey-driven assembler,
replaces the example) · T6 #746 (subtitles + chapter cards) · T7 #747 (deck parity,
see `docs/walkthrough/target-deck.md`) · T8 #748 (journey coverage).
