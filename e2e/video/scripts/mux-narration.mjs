// Mux the per-beat voiceover onto the SILENT Revideo render, deterministically.
//
// Why not let Revideo play the <Audio> nodes: it mixes every audio node toward the
// scene end, so the beats accumulate and clip (loudness grew to 0 dBFS by the last
// beat). Instead the scene renders silent and this step lays each MP3 at its exact
// beat offset, then a limiter guarantees no clipping. The offset model mirrors
// example-team-setup.tsx: audio i starts at the beat's visual start; each beat runs
// FADE_IN (0.5) + hold (dur+PAD, PAD=0.4) + FADE_OUT (0.45) ⇒ +1.35s beyond dur.
//
// Beat order + durations come from the audio manifest, whose keys are in narration
// order (generate-tts.py writes them in narration.json order = beat order).
//
// Usage: node scripts/mux-narration.mjs <silent-in.mp4> <out.mp4>

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const FADE_IN = 0.5;
const FADE_OUT = 0.45;
const PAD = 0.4;
const PER_BEAT_EXTRA = FADE_IN + PAD + FADE_OUT; // 1.35 — keep in sync with the scene

const [, , inArg, outArg] = process.argv;
const inFile = resolve(inArg || 'out/final/team-setup-walkthrough.mp4');
const outFile = resolve(outArg || inFile);
const manifest = JSON.parse(readFileSync('data/audio-manifest.json', 'utf8'));

const beats = Object.entries(manifest).map(([id, m]) => ({
  id,
  file: resolve('public/audio', m.mediaFile || `${id}.mp3`),
  dur: m.durationSec,
}));
if (!beats.length) throw new Error('no beats in data/audio-manifest.json — run the TTS/prep step first');
for (const b of beats) if (!existsSync(b.file)) throw new Error(`missing voiceover: ${b.file}`);

// Cumulative start offset per beat (seconds).
let offset = 0;
for (const b of beats) {
  b.offsetMs = Math.round(offset * 1000);
  offset += b.dur + PER_BEAT_EXTRA;
}

// ffmpeg: video from the silent render (input 0), each MP3 as an input, delayed to
// its offset, summed WITHOUT amix normalisation (they don't overlap), then a limiter.
const args = ['-y', '-i', inFile];
for (const b of beats) args.push('-i', b.file);

const delays = beats
  .map((b, i) => `[${i + 1}:a]adelay=${b.offsetMs}|${b.offsetMs}[a${i}]`)
  .join(';');
const mixIns = beats.map((_, i) => `[a${i}]`).join('');
const filter =
  `${delays};${mixIns}amix=inputs=${beats.length}:normalize=0:dropout_transition=0[mix];` +
  `[mix]alimiter=limit=0.89:level=false,aresample=48000[aout]`;

args.push(
  '-filter_complex', filter,
  '-map', '0:v', '-map', '[aout]',
  '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
  outFile === inFile ? `${outFile}.tmp.mp4` : outFile,
);

console.log(`Muxing ${beats.length} voiceovers onto ${inFile}`);
beats.forEach((b) => console.log(`  ${b.id.padEnd(18)} @ ${(b.offsetMs / 1000).toFixed(2)}s  (${b.dur}s)`));
execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { stdio: 'inherit' });

if (outFile === inFile) {
  execFileSync('sh', ['-c', `mv "${outFile}.tmp.mp4" "${outFile}"`]);
}
console.log(`Wrote ${outFile}`);
