#!/usr/bin/env node
// CLI: lint every journey (#706, `npm run journeys:lint`).
//
// Runs the catalog-freshness check first (a stale catalog would validate names
// against the wrong vocabulary), then lints every journey. Exits non-zero on the
// first category of failure so CI blocks the PR. Pure Node — no browser, no
// podman — so it runs in the light unit-test lane.
const { execFileSync } = require('child_process');
const path = require('path');
const { lintAll } = require('../lint');

// 1. Catalog freshness — reuse the gen-catalog --check path.
try {
  execFileSync('node', [path.resolve(__dirname, 'gen-catalog.js'), '--check'], { stdio: 'inherit' });
} catch {
  process.exit(1);
}

// 2. Lint the journeys.
const { errors, journeyCount } = lintAll();
if (errors.length) {
  process.stderr.write(`\n✗ ${errors.length} journey lint error(s):\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${journeyCount} journey(s) lint-clean.\n`);
