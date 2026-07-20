# Walkthrough video lane (Revideo, audio-driven — Variant C)

Turns the journey walkthrough into a **narrated explainer video**: for each view we
first play the real Playwright interaction, then **freeze the final frame and hold**
— for exactly as long as the auto-generated voiceover takes. The audio, not slowMo,
drives how long each view is shown.

This lane is a **self-contained Revideo sub-project** (own `package.json`), so the
heavy `@revideo/*` deps only install for the video job, not the normal `make e2e`
run. It supersedes the earlier ffmpeg assembler (PR #738); the recording side
(`journey-video` Playwright project + `journeys.spec.js` saving `journey.webm`) is
unchanged and still feeds this lane.

Epic **#741**. Foundation vendored from the proven Revideo PoC (MIT).

## Spike proof (#742)

The Variant-C beat is proven end-to-end on this stack: `revideo/example-variant-c.tsx`
renders `fixtures/sample-journey.mp4` → **real UI motion (0–3.5s) → freeze on the last
frame → hold**, timed to a real Edge-TTS voiceover (10.84s), out to an **H.264 + AAC
mp4** with audible narration (mean −24.7 dB) and an on-screen subtitle. Two findings
baked into this foundation:

1. **Clips must be H.264 mp4.** Revideo's frame extractor fails on VP9 `.webm` (what
   Playwright records) with a `ffprobe: No input specified` error. So the lane
   transcodes clips to mp4 before embedding (`ffmpeg -c:v libx264 -pix_fmt yuv420p`);
   the committed fixture is already mp4. T3/T5 must transcode each `journey.webm`.
2. **Video/audio assets are served from `public/`**, not vite-imported — the ffmpeg
   bridge maps URLs back to `<outDir>/../public`. `prep:clips` copies fixtures there.

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
| `revideo/utils/audio.tsx` | `audioSec(id)` + `playAndWait(view, audioId, visuals, pad)` — **the audio-driven timing primitive** | vendored, reuse as-is |
| `revideo/utils/transitions.ts` | `fadeIn` / `fadeOut` / `crossFade` | vendored |
| `revideo/render.ts` | CLI renderer (`renderVideo` + the puppeteer/outDir workarounds) | vendored |
| `revideo/example-variant-c.tsx` | **reference scene** proving the Variant-C beat over `fixtures/sample-journey.webm` | reference — T5 replaces with a journey-driven generator |
| `scripts/generate-tts.py` | Edge-TTS → MP3 + `data/audio-manifest.json` (real durations) | vendored, reuse as-is |
| `scripts/extract-narration.mjs` | collects narration entries → `scripts/narration.json` | **reference** — T4 replaces with a journey `voiceover:` extractor |
| `fixtures/sample-journey.mp4` | a short real UI clip (H.264) so the lane is testable without recording the stack | fixture |
| `data/audio-manifest.json` | generated durations (seeded `{}` so the import never dangles) | generated |
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
