// NAV_PAGES reader (docs/journey-spec-concept.md §3.2 item 3, #707).
//
// The coverage report cross-checks journeys against the platform's nav-page
// inventory. That inventory already exists — the `NAV_PAGES` constant in the F0
// nav-smoke spec (e2e/tests/f0-nav-smoke.spec.js) — and the issue names it as the
// source of truth, so we read it there rather than duplicating the list.
//
// We parse the array literal with a regex instead of `require`-ing the spec: the
// spec pulls in @playwright/test and calls test()/describe() at module load, so
// requiring it outside a Playwright run is unsafe. Parsing keeps this pure Node,
// runnable in the podman-free unit lane.
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_SPEC = path.resolve(__dirname, '..', 'tests', 'f0-nav-smoke.spec.js');

// Extract the ordered list of nav-page labels from the spec source. Throws a
// clear error if the constant can't be found — a silent empty list would make
// every page look uncovered.
function readNavPages(specPath = DEFAULT_SPEC) {
  const src = fs.readFileSync(specPath, 'utf8');
  const start = src.indexOf('NAV_PAGES');
  if (start === -1) {
    throw new Error(`docgen: NAV_PAGES constant not found in ${specPath}`);
  }
  const open = src.indexOf('[', start);
  const close = src.indexOf('];', open);
  if (open === -1 || close === -1) {
    throw new Error(`docgen: could not parse NAV_PAGES array in ${specPath}`);
  }
  const block = src.slice(open, close);
  const labels = [];
  const re = /label:\s*'([^']+)'/g;
  let m = re.exec(block);
  while (m) {
    labels.push(m[1]);
    m = re.exec(block);
  }
  if (labels.length === 0) {
    throw new Error(`docgen: NAV_PAGES parsed to zero labels in ${specPath}`);
  }
  return labels;
}

module.exports = { readNavPages, DEFAULT_SPEC };
