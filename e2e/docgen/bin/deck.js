#!/usr/bin/env node
// CLI: generate the journey walkthrough deck + structurally validate it (#708,
// `make docs-deck`).
//
//   node docgen/bin/deck.js [--out <file>] [--artifacts <dir>]
//
// Builds one .pptx from all journeys (ordered by `order`) and the screenshots a
// green run left under the artifacts dir, then runs the scriptable structural
// validation (no PowerPoint needed) and exits non-zero if it fails — so a broken
// deck breaks the build even though final visual QA stays a human step.
'use strict';

const path = require('path');

const { generateDeck } = require('../deck');

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--out') opts.outFile = path.resolve(argv[(i += 1)]);
    else if (a === '--artifacts') opts.artifactsDir = path.resolve(argv[(i += 1)]);
    else {
      process.stderr.write(`deck: unknown argument "${a}"\n`);
      process.exit(2);
    }
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const { outFile, slideCount, journeyCount, validation } = await generateDeck(opts);

  process.stdout.write(
    `✓ wrote deck to ${outFile}\n` +
      `  ${journeyCount} journey(s), ${slideCount} slide(s), ${validation.noteCount} speaker-note set(s)\n`,
  );

  if (!validation.ok) {
    process.stderr.write('\n✗ structural validation failed:\n');
    for (const e of validation.errors) process.stderr.write(`  - ${e}\n`);
    process.exit(1);
  }
  process.stdout.write('✓ structural validation passed.\n');
}

main().catch((err) => {
  process.stderr.write(`deck: ${err.stack || err.message}\n`);
  process.exit(1);
});
