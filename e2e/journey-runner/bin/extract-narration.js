#!/usr/bin/env node
// CLI: extract journey `voiceover:` fields into the video lane's narration files
// (epic #741, T4/#744, `npm run journeys:narration`).
//
//   node journey-runner/bin/extract-narration.js [journeyId ...]
//
// With no args it processes every journey that carries at least one voiceover.
// For each, it writes ../video/scripts/generated/<journeyId>.narration.json =
// [{ id, text }, …] in document order — the exact shape generate-tts.py (TTS
// input) and mux-narration.mjs (beat order) consume. Pure Node + js-yaml (via
// the loader), so it runs in the light unit-test lane; no browser, no podman.
//
// This is the live-storyline replacement for the demonstrator's tsx-scraping
// scripts/extract-narration.mjs: the storyline now lives in the journey YAML,
// not hand-written beat lists. Output lands in a generated/ dir so it never
// clobbers the committed demonstrator fixtures (scripts/*.narration.json).
const fs = require('fs');
const path = require('path');
const { loadJourneysDir } = require('../loader');
const { journeyNarration } = require('../narration');

const OUT_DIR = path.resolve(__dirname, '..', '..', 'video', 'scripts', 'generated');

function main(argv) {
  const wanted = new Set(argv.filter((a) => !a.startsWith('-')));
  let journeys;
  try {
    journeys = loadJourneysDir();
  } catch (err) {
    process.stderr.write(`✗ ${err.message}\n`);
    process.exit(1);
  }

  // Fail loudly on a requested id that doesn't exist — a typo shouldn't pass silently.
  for (const id of wanted) {
    if (!journeys.some((j) => j.id === id)) {
      process.stderr.write(`✗ no journey with id "${id}"\n`);
      process.exit(1);
    }
  }

  const selected = journeys.filter((j) => wanted.size === 0 || wanted.has(j.id));
  fs.mkdirSync(OUT_DIR, { recursive: true });
  let wrote = 0;
  for (const doc of selected) {
    const entries = journeyNarration(doc);
    if (!entries.length) {
      if (wanted.has(doc.id)) process.stderr.write(`  ${doc.id}: no voiceover fields — nothing to extract\n`);
      continue;
    }
    const out = path.join(OUT_DIR, `${doc.id}.narration.json`);
    fs.writeFileSync(out, JSON.stringify(entries, null, 1) + '\n', 'utf8');
    process.stdout.write(`✓ ${doc.id}: ${entries.length} narration entries → ${path.relative(process.cwd(), out)}\n`);
    wrote += 1;
  }
  if (!wrote) process.stdout.write('No narration written (no selected journey carries voiceover fields).\n');
}

main(process.argv.slice(2));
