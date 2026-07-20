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

- **Team Setup demonstrator** (primary) — `revideo/example-team-setup.tsx`: 6
  screenshots, each held to its voiceover, Ken-Burns zoom + eyebrow + caption →
  **≈ 87s** (the 60–90s target; the earlier one-clip spike was a too-fast 10s).
  Reproduce:
  ```bash
  cp scripts/team-setup.narration.json scripts/narration.json && npm run tts
  npm run render:team-setup      # → out/final/team-setup-walkthrough.mp4
  ```
- **Continuous-clip beat** (optional motion) — `revideo/example-variant-c.tsx`:
  motion 0–3.5s → freeze → hold, `npm run render:example`.

Foundation findings baked in:

1. **Video/audio/image assets are served from `public/`**, not vite-imported — the
   ffmpeg bridge maps URLs back to `<outDir>/../public`. `prep:shots` / `prep:clips`
   copy the fixtures there.
2. **Optional motion clips must be H.264 mp4**, not VP9 `.webm` (what Playwright
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
journeys/*.yaml ──▶ voiceover: text ──▶ extract ──▶ Edge-TTS ──▶ public/audio/*.mp3
   (steps + narrative)                (T4/#744)   (generate-tts.py)  + data/audio-manifest.json (durations)
        │                                                                     │
        ▼                                                                     ▼
   journey.webm  +  journey.cuts.json   ─────────────────────────▶   Revideo scene (playAndWait)
  (journey-video project)  (cut-marks, T3/#743)                       Variant C: motion → freeze
                                                                              │
                                                                              ▼
                                                                     agent-studio-walkthrough.mp4
                                                                        (Revideo assembler, T5/#745)
```

## Files (vendored foundation)

| Path | Role | Status |
|---|---|---|
| `revideo/example-team-setup.tsx` | **primary reference scene** — screenshots-per-step, held to the voiceover (Team Setup, 6 beats ≈ 87s) | reference — T5 generalises to all journeys |
| `revideo/example-variant-c.tsx` | optional-motion reference — continuous clip → freeze → hold | reference (optional path) |
| `revideo/utils/audio.tsx` | `audioSec(id)` + `audioUrl(id)` + `playAndWait(...)` — **the audio-driven timing primitive** | vendored, reuse as-is |
| `revideo/utils/transitions.ts` | `fadeIn` / `fadeOut` / `crossFade` | vendored |
| `revideo/render.ts` | CLI renderer (`renderVideo` + the puppeteer/outDir workarounds) | vendored |
| `scripts/generate-tts.py` | Edge-TTS → MP3 + `data/audio-manifest.json` (real durations) | vendored, reuse as-is |
| `scripts/team-setup.narration.json` | the demonstrator's per-step `voiceover:` text (the source of the committed mp3s) | fixture |
| `scripts/extract-narration.mjs` | collects narration entries → `scripts/narration.json` | **reference** — T4 replaces with a journey `voiceover:` extractor |
| `fixtures/shots/*.png` | the 5 Team Setup step screenshots (demonstrator) — `prep:shots` copies them to `public/shots/` | fixture |
| `fixtures/audio/*.mp3` + `audio-manifest.json` | the demonstrator's Edge-TTS voiceovers — `prep:audio` copies them to `public/audio/` + `data/` | fixture |
| `fixtures/sample-journey.mp4` | a short real UI clip (H.264) for the optional-motion reference | fixture |
| `data/audio-manifest.json` | durations the scene reads (seeded `{}`; `prep:audio` regenerates it at render time) | generated |
| `vite.config.ts` | the `@revideo/vite-plugin` config the renderer bundles with | vendored |
| `patches/` | the three Revideo 0.10.4 fixes (see `patches/README.md`) | T2 finalises after first install |

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

## Open tickets on this lane

T1 #749 (dispatch trigger) · **T2 #742 (spike + finalise patches)** · T3 #743
(cut-marks) · T4 #744 (`voiceover:` + TTS) · T5 #745 (journey-driven assembler,
replaces the example) · T6 #746 (subtitles + chapter cards) · T7 #747 (deck parity,
see `docs/walkthrough/target-deck.md`) · T8 #748 (journey coverage).
