#!/usr/bin/env node
// CLI: assemble the journey walkthrough video (#712, `make video-journeys`).
//
//   node video/bin/video.js [--out <file>] [--artifacts <dir>] [--plan]
//
// Concats the per-journey screen recordings a green `journey-video` run left under
// the artifacts dir, interleaving title cards from each journey title and its
// narrative-only steps, into one .webm. `--plan` prints the full ffmpeg-free build
// description (chapter ordering + per-card text + ffmpeg arg arrays) and exits —
// the inspection path for containers without ffmpeg. Final watch-through is a
// human step (requested in the PR).
'use strict';

const path = require('path');

const { assembleVideo, computeVideoBuild, ffmpegAvailable } = require('../video');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.outFile = path.resolve(argv[(i += 1)]);
    else if (a === '--artifacts') opts.artifactsDir = path.resolve(argv[(i += 1)]);
    else if (a === '--plan') opts.plan = true;
    else {
      process.stderr.write(`video: unknown argument "${a}"\n`);
      process.exit(2);
    }
  }
  return opts;
}

function printPlan(build) {
  const { plan, fontFile, steps } = build;
  process.stdout.write(`${plan.title}\n`);
  process.stdout.write(
    `  ${plan.journeyCount} journey(s), ${steps.length} segment(s) ` +
      `(${steps.filter((s) => s.kind === 'title').length} card(s), ` +
      `${steps.filter((s) => s.kind === 'clip').length} clip(s))\n`,
  );
  process.stdout.write(`  font: ${fontFile || '(fontconfig default)'}\n`);
  if (plan.missingVideo.length) {
    process.stdout.write(`  ⚠ no clip captured for: ${plan.missingVideo.join(', ')}\n`);
  }
  process.stdout.write('\n');
  for (const step of steps) {
    const seg = step.segment;
    if (step.kind === 'title') {
      process.stdout.write(`  [card:${seg.role}] ${seg.seconds}s  "${seg.text}"\n`);
    } else {
      process.stdout.write(`  [clip]         ${seg.src}\n`);
    }
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.plan) {
    printPlan(computeVideoBuild(opts));
    return;
  }

  if (!ffmpegAvailable()) {
    // Don't hard-fail with a stack trace: print the plan so the run is still
    // useful in a container without ffmpeg, then exit non-zero so CI notices.
    process.stderr.write('video: ffmpeg not found on PATH — printing the plan instead of rendering.\n\n');
    printPlan(computeVideoBuild(opts));
    process.exit(1);
  }

  const summary = assembleVideo(opts);
  process.stdout.write(
    `✓ wrote video to ${summary.outFile}\n` +
      `  ${summary.journeyCount} journey(s), ${summary.cardCount} title card(s), ` +
      `${summary.clipCount} clip(s), ${(summary.bytes / 1024 / 1024).toFixed(1)} MiB\n`,
  );
  if (summary.missingVideo.length) {
    process.stdout.write(`  ⚠ no clip captured for: ${summary.missingVideo.join(', ')}\n`);
  }
}

main();
