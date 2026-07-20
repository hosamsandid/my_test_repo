// Render the selected walkthrough chapter(s) (#749).
//
// Entry point for the `walkthrough-video.yml` workflow_dispatch. Reads the
// selection from WALKTHROUGH_JOURNEYS ('all' | comma/space-separated chapter ids)
// and runs each chapter's composed `npm run render:<id>` in registry order,
// streaming its output. Fails fast (non-zero exit) on the first chapter that
// errors so the workflow surfaces the failure.
//
// The narration language and slowMo pace arrive as WALKTHROUGH_LANG /
// WALKTHROUGH_SLOWMO and are inherited by the child renders via the environment.
// The current audio-driven render (screenshots held to the voiceover, see
// README.md) does not yet consume either — they are wired through for the language
// decision and the optional continuous-clip beat that lands later.
import { spawnSync } from 'node:child_process';
import { resolveChapters, chapterIds } from './chapters.mjs';

const selection = process.env.WALKTHROUGH_JOURNEYS || 'all';

let chapters;
try {
  chapters = resolveChapters(selection);
} catch (err) {
  console.error(`[walkthrough] ${err.message}`);
  process.exit(2);
}

console.log(
  `[walkthrough] selection="${selection}" → rendering: ${chapters
    .map((c) => c.id)
    .join(', ')}`,
);
console.log(`[walkthrough] valid chapters: ${chapterIds().join(', ')} (or 'all')`);
if (process.env.WALKTHROUGH_LANG) {
  console.log(`[walkthrough] language=${process.env.WALKTHROUGH_LANG} (reserved — not yet consumed)`);
}
if (process.env.WALKTHROUGH_SLOWMO) {
  console.log(`[walkthrough] slowmo=${process.env.WALKTHROUGH_SLOWMO}ms (reserved — audio-driven render ignores it)`);
}

const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';

for (const ch of chapters) {
  console.log(`\n[walkthrough] ── chapter "${ch.id}" (npm run ${ch.script}) ──`);
  const res = spawnSync(npm, ['run', ch.script], {
    stdio: 'inherit',
    env: process.env,
  });
  if (res.status !== 0) {
    const how = res.status != null ? `exit ${res.status}` : `signal ${res.signal}`;
    console.error(`[walkthrough] chapter "${ch.id}" failed (${how}).`);
    process.exit(res.status || 1);
  }
}

console.log(
  `\n[walkthrough] done — ${chapters.length} chapter(s) rendered to out/final/.`,
);
