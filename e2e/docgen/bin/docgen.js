#!/usr/bin/env node
// CLI: generate the journey user guide + coverage report (#707, `make docs-journeys`).
//
//   node docgen/bin/docgen.js [--out <dir>] [--artifacts <dir>] [--check]
//
// --check regenerates into a temp dir and diffs against the existing output dir,
// exiting non-zero on any difference — the guard against hand-edited generated
// docs (§3.2). Without a real run's artifacts the pages are narrative-only; the
// golden test (docgen/index.test.js) proves the full screenshot-interleaving path
// podman-free from the committed fixture.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { generate, DEFAULT_OUT } = require('../index');

function parseArgs(argv) {
  const opts = { check: false };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--check') opts.check = true;
    else if (a === '--out') opts.outDir = path.resolve(argv[(i += 1)]);
    else if (a === '--artifacts') opts.artifactsDir = path.resolve(argv[(i += 1)]);
    else {
      process.stderr.write(`docgen: unknown argument "${a}"\n`);
      process.exit(2);
    }
  }
  return opts;
}

// Recursively list files (relative paths) under a dir; [] if it doesn't exist.
function listFiles(dir, base = dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs, base));
    else out.push(path.relative(base, abs));
  }
  return out.sort();
}

function diffTrees(expectedDir, actualDir) {
  const files = new Set([...listFiles(expectedDir), ...listFiles(actualDir)]);
  const diffs = [];
  for (const rel of [...files].sort()) {
    const a = path.join(expectedDir, rel);
    const b = path.join(actualDir, rel);
    const ea = fs.existsSync(a);
    const eb = fs.existsSync(b);
    if (!ea) diffs.push(`+ ${rel} (regenerated, not committed)`);
    else if (!eb) diffs.push(`- ${rel} (committed, no longer generated)`);
    else if (!fs.readFileSync(a).equals(fs.readFileSync(b))) diffs.push(`~ ${rel} (content differs)`);
  }
  return diffs;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.check) {
    const target = opts.outDir || DEFAULT_OUT;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-check-'));
    generate({ ...opts, outDir: tmp });
    const diffs = diffTrees(target, tmp);
    fs.rmSync(tmp, { recursive: true, force: true });
    if (diffs.length) {
      process.stderr.write(`\n✗ generated docs are stale or hand-edited (run: make docs-journeys):\n`);
      for (const d of diffs) process.stderr.write(`  ${d}\n`);
      process.exit(1);
    }
    process.stdout.write('✓ generated docs are up to date.\n');
    return;
  }

  const { outDir, pages, coverage } = generate(opts);
  for (const p of pages) {
    const shots = p.hasManifest ? `${p.copied} screenshot(s)` : 'no run manifest — narrative only';
    process.stdout.write(`  ${p.file} (${shots})\n`);
  }
  process.stdout.write(
    `\n✓ wrote ${pages.length} page(s) to ${outDir}\n` +
      `  coverage: ${coverage.navGaps.length} nav-page gap(s), ${coverage.chapterGaps.length} chapter gap(s) → coverage.md\n`,
  );
}

main();
