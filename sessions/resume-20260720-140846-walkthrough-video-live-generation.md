# 🔄 Resume — Walkthrough video: live generation (T4 + T5)

**Session ID**: 20260720-140846-walkthrough-video-live-generation
**Project**: Agent Studio (i-sase-aee) · epic #741 · PR #754 (open)
**Branch**: feat/745-screenshots-per-step
**Status**: 🚧 In Progress — demonstrators done; live-source wiring is next

---

## 📋 Quick Start

```
Read sessions/session-20260720-140846-walkthrough-video-live-generation.md for full context,
then start with Priority 1 below. Also recall memory walkthrough-video-epic.md.
```

---

## 🎯 Recap

Built a narrated walkthrough video lane (Revideo, in `e2e/video/`): **screenshots-per-step**,
each held to its voiceover length, Ken-Burns zoom + eyebrow + caption, audio muxed on
externally. Two chapters render clean & flat-loudness: Team Setup (~98s) and IBAN Story
(~197s). Foundation merged (#751); chapter work on **PR #754 (open)**.

**Current videos are fixture-based** (screenshots from the target PPTX, hand-written
narration) — so they resemble the deck. The point now is to drive them from the **live
source**: journey screenshots + `voiceover:` fields in the journey YAMLs.

---

## ⚡ Immediate Next Actions

### Priority 1 — T4 (#744): storyline in the journey + TTS
**What**: add a `voiceover:` field per step in `e2e/journeys/team-setup.yaml` (short video
narration, distinct from the fuller `narrative`); extractor `voiceover:` → `narration.json`
→ Edge-TTS (`e2e/video/scripts/generate-tts.py`) → `data/audio-manifest.json`.
**Why**: makes the storyline editable in the journey; regenerates audio on change.
**Files**: `e2e/journeys/*.yaml`, `e2e/journey-runner/schema.js` + `loader.js` (+ lint),
`e2e/video/scripts/`.

### Priority 2 — T5 (#745): journey-driven generator (replaces hardcoded BEATS)
**What**: read a journey YAML → for each step map `screenshot:` → live artifact
`e2e/artifacts/<journeyId>/<name>.png` and `voiceover:` → its MP3 → build the beat list →
`makeWalkthroughProject` (from `e2e/video/revideo/walkthrough.tsx`) → render silent → mux
(`scripts/mux-narration.mjs`).
**Why**: this is the actual "live screenshots + regenerable voiceover → video" loop.
**How**: keep `example-team-setup.tsx`/`example-iban-story.tsx` as reference/fallback; the
generator produces the beat list instead of hardcoding it. Unit-test the mapping against a
fixture `e2e/artifacts/` tree; real screenshots come from a green journey run.

### Priority 3 — verify the loop
Run a journey screenshot pass (`make e2e` / CI) to produce fresh `e2e/artifacts/`, then
generate the video from live shots. Confirm a UI change → new screenshots → new video, and
a `voiceover:` edit → new audio.

---

## 🔑 Key Context / Gotchas (don't rediscover)

- ❗ **Audio:** render SILENT; mux voiceover externally (`scripts/mux-narration.mjs`). Revideo sums `<Audio>` nodes toward scene end → clipping. mux is chapter-aware via the narration file arg.
- ❗ **Local render browser:** `export PUPPETEER_EXECUTABLE_PATH="$HOME/Library/Caches/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-mac-arm64/chrome-headless-shell"` (npm v26 blocks puppeteer's own Chromium download).
- ❗ **Render/TTS never run in the agent container** — CI or workstation only. Agent work = pure logic + unit tests.
- ⚠️ Container agents (`agent-studio-*`) may already be pushing to these branches — `git pull --rebase` before pushing.
- ⚠️ Edge-TTS python: `~/Projects/e-vgh-agentic-mainframe-modernization/40-tools/66-revideo-tutorials/.venv/bin/python`.
- ⚠️ Keep `e2e/video/data/audio-manifest.json` committed as `{}` (prep regenerates it at render time).
- Render commands: `cd e2e/video && npm ci && npm run render:team-setup` (or `render:iban-story`).

---

## 📂 Files to review first
- `e2e/video/revideo/walkthrough.tsx` — the shared beat builder (T5 feeds it).
- `e2e/video/revideo/example-team-setup.tsx` — the hardcoded beat list T5 will generate.
- `e2e/video/scripts/mux-narration.mjs` — chapter-aware audio mux.
- `e2e/journeys/team-setup.yaml` — steps + `screenshot:` names + `narrative` (add `voiceover:`).
- `e2e/video/README.md` — approach + gotchas.

---

## 💬 Suggested opening message

```
Resuming epic #741 (walkthrough video), session 20260720-140846.
Read sessions/session-20260720-140846-walkthrough-video-live-generation.md for context.
The demonstrators are fixture-based; now let's build the LIVE loop — T4 (voiceover: field in
the journey YAMLs + TTS) then T5 (generator that reads a journey, uses live e2e/artifacts
screenshots, and feeds makeWalkthroughProject). Start with T4 on team-setup.yaml.
```

---
**Session ID**: 20260720-140846-walkthrough-video-live-generation
