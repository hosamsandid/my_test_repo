#!/usr/bin/env node
// CLI: dry-run every journey (#706, `npm run journeys:dryrun`).
//
// Resolves every step + fixture against the live registries and param-checks
// against the catalog, without a browser or the stack. Exits non-zero on any
// unresolved step/fixture or param error. Requires @playwright/test (the
// package) to be installed — the CI journeys job installs the e2e deps.
const { dryRunAll } = require('../dry-run');

const { errors, journeyCount } = dryRunAll();
if (errors.length) {
  process.stderr.write(`\n✗ ${errors.length} dry-run error(s):\n`);
  for (const e of errors) process.stderr.write(`  - ${e}\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${journeyCount} journey(s) resolve + param-check clean (dry-run).\n`);
