#!/usr/bin/env node
// CLI: compare a PR's journey screenshots against the downloaded main baseline,
// write the before/after/diff images + the sticky comment body (#709, §3.4).
//
//   node visual-diff/bin/compare-and-comment.js \
//     --baseline <dir> --current <dir> --out <dir> \
//     [--base-url <url>] [--artifact-url <url>] [--run-url <url>] \
//     [--commit <sha>] [--baseline-ref <label>]
//
// Only images for CHANGED/ADDED/REMOVED captures are emitted (unchanged frames
// stay in the baseline artifact) so the evidence bundle is small. Always exits
// 0 for a completed comparison — this lane is evidence, never a gate (§10.4);
// it exits non-zero only on its own operational error (bad args / unreadable
// tree), which is a workflow bug, not a PR verdict.

const fs = require('fs');
const path = require('path');
const { loadArtifactsRoot } = require('../loader');
const { compareSets, STATUS } = require('../compare');
const { renderComment } = require('../comment');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a.startsWith('--')) out[a.slice(2)] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return out;
}

const flat = (id) => id.replace(/\//g, '__');

function main() {
  const args = parseArgs(process.argv.slice(2));
  const baselineDir = args.baseline;
  const currentDir = args.current;
  const outDir = args.out;
  if (!currentDir || !outDir) {
    console.error('usage: compare-and-comment --current <dir> --out <dir> [--baseline <dir>] [--base-url <url>] ...');
    process.exit(2);
  }

  const baseline = loadArtifactsRoot(baselineDir).captures;
  const current = loadArtifactsRoot(currentDir).captures;
  const comparison = compareSets(baseline, current);

  fs.mkdirSync(outDir, { recursive: true });

  // Emit images only for the captures the reviewer needs to see.
  const emitted = new Set();
  for (const r of comparison.results) {
    if (r.status === STATUS.UNCHANGED) continue;
    const base = flat(r.id);
    if (r.status !== STATUS.ADDED && baseline.has(r.id)) {
      fs.writeFileSync(path.join(outDir, `${base}.baseline.png`), baseline.get(r.id).buffer);
      emitted.add(`${base}.baseline`);
    }
    if (r.status !== STATUS.REMOVED && current.has(r.id)) {
      fs.writeFileSync(path.join(outDir, `${base}.current.png`), current.get(r.id).buffer);
      emitted.add(`${base}.current`);
    }
    if (r.diff) {
      fs.writeFileSync(path.join(outDir, `${base}.diff.png`), r.diff);
      emitted.add(`${base}.diff`);
    }
  }

  const baseUrl = typeof args['base-url'] === 'string' ? args['base-url'].replace(/\/$/, '') : null;
  const urlFor = baseUrl
    ? (r, kind) => (emitted.has(`${flat(r.id)}.${kind}`) ? `${baseUrl}/${flat(r.id)}.${kind}.png` : null)
    : null;

  const body = renderComment(comparison, {
    urlFor,
    artifactUrl: typeof args['artifact-url'] === 'string' ? args['artifact-url'] : null,
    runUrl: typeof args['run-url'] === 'string' ? args['run-url'] : null,
    commit: typeof args.commit === 'string' ? args.commit.slice(0, 7) : null,
    baselineRef: typeof args['baseline-ref'] === 'string' ? args['baseline-ref'] : 'main',
  });

  fs.writeFileSync(path.join(outDir, 'comment.md'), `${body}\n`);
  // Machine-readable roll-up (drop the raw diff buffers) for later steps/logs.
  const summaryJson = {
    ...comparison.summary,
    pixelThreshold: comparison.pixelThreshold,
    results: comparison.results.map(({ diff, ...rest }) => rest),
  };
  fs.writeFileSync(path.join(outDir, 'summary.json'), `${JSON.stringify(summaryJson, null, 2)}\n`);

  console.log(`visual-diff: ${comparison.summary.changed} changed, ${comparison.summary.added} new, ` +
    `${comparison.summary.removed} removed, ${comparison.summary.unchanged} unchanged ` +
    `(of ${comparison.summary.total}); wrote ${outDir}/comment.md`);
}

main();
