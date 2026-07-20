"""Generate voiceover MP3s via Microsoft Edge TTS (free, neural, no API key).

Reads scripts/narration.json and writes:
  - public/audio/<id>.mp3
  - public/audio/audio-manifest.json
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

import edge_tts

VOICE = "en-US-AndrewMultilingualNeural"
RATE = "-5%"

ROOT = Path(__file__).resolve().parent.parent
NARRATION = ROOT / "scripts" / "narration.json"
AUDIO_DIR = ROOT / "public" / "audio"
# Manifest goes inside src/data/ so Vite can import it statically.
MANIFEST = ROOT / "src" / "data" / "audio-manifest.json"


async def synth(entry_id: str, text: str) -> dict:
    mp3_path = AUDIO_DIR / f"{entry_id}.mp3"
    communicate = edge_tts.Communicate(text, VOICE, rate=RATE)
    last_end_ticks = 0
    with open(mp3_path, "wb") as f:
        async for chunk in communicate.stream():
            if chunk["type"] == "audio":
                f.write(chunk["data"])
            elif chunk["type"] in ("SentenceBoundary", "WordBoundary"):
                end = int(chunk.get("offset", 0)) + int(chunk.get("duration", 0))
                if end > last_end_ticks:
                    last_end_ticks = end
    duration = last_end_ticks / 10_000_000.0
    return {"durationSec": round(duration, 3), "mediaFile": f"{entry_id}.mp3"}


async def main() -> int:
    if not NARRATION.exists():
        print(f"ERROR: {NARRATION} missing. Run `node scripts/extract-narration.mjs` first.")
        return 1
    entries = json.loads(NARRATION.read_text(encoding="utf-8"))
    AUDIO_DIR.mkdir(parents=True, exist_ok=True)
    MANIFEST.parent.mkdir(parents=True, exist_ok=True)
    manifest: dict[str, dict] = {}
    for e in entries:
        info = await synth(e["id"], e["text"])
        manifest[e["id"]] = info
        print(f"  {e['id']:30s} {info['durationSec']:6.2f}s  {info['mediaFile']}")
    MANIFEST.write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote manifest: {MANIFEST}")
    return 0


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
