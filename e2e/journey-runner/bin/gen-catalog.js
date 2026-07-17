#!/usr/bin/env node
// CLI: regenerate (or check) steps-catalog.json (#706, `npm run journeys:catalog`).
//
//   node journey-runner/bin/gen-catalog.js          # write steps-catalog.json
//   node journey-runner/bin/gen-catalog.js --check   # exit 1 if it is stale
//
// The `--check` form is what CI runs on every PR: it fails when the committed
// catalog no longer matches the step library's JSDoc, so a step added/renamed
// without regenerating the catalog can't merge.
const fs = require('fs');
const { buildCatalog, renderCatalogJson, CATALOG_PATH } = require('../catalog');

const check = process.argv.includes('--check');
const rendered = renderCatalogJson(buildCatalog());

if (check) {
  let current = null;
  try {
    current = fs.readFileSync(CATALOG_PATH, 'utf8');
  } catch {
    current = null;
  }
  if (current !== rendered) {
    process.stderr.write(
      'steps-catalog.json is stale — run `npm run journeys:catalog` and commit the result.\n',
    );
    process.exit(1);
  }
  process.stdout.write('steps-catalog.json is up to date.\n');
  process.exit(0);
}

fs.writeFileSync(CATALOG_PATH, rendered);
process.stdout.write(`Wrote ${CATALOG_PATH}\n`);
