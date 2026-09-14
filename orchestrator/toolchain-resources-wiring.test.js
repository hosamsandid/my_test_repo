'use strict';

// Drift guard for #2282 Band 1's threading through `orchestrator.js`.
//
// The decision itself (does a toolchain's `resources` size the container/pod)
// is covered end-to-end by the pure unit tests in toolchain-registry.test.js,
// spawn-container.test.js and spawn-kubernetes-pod.test.js. What those cannot
// see is whether `resolveImageForAgent` actually CARRIES the full toolchain's
// `resources` field through to the seam, rather than dropping it the way the
// pre-#2282 code dropped everything except toolchainId/environmentId/
// environmentName — the exact regression that would leave Band 1's schema
// field validated and persisted but never reaching a spawn. `orchestrator.js`
// boots two HTTP servers on require, so it cannot be loaded in a unit test;
// these assertions read its source instead (the `acting-sender-wiring.test.js`
// technique, also used by `baseline-github-token-wiring.test.js`).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// Strip LINE comments only — a block-comment pass would make the negative
// assertions below silently vacuous (see acting-sender-wiring.test.js).
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice out one function body by its opening line. */
function region(openingLine, endNeedle) {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `could not find the end of '${openingLine}'`);
  const body = stripComments(SRC.slice(start, end));
  assert.ok(body.length > 50, `region '${openingLine}' came back too short (${body.length}) — re-point this guard`);
  return body;
}

const resolveImageForAgentBody = () => region('function resolveImageForAgent(', '\n}');

test('resolveImageForAgent carries the toolchain\'s resources through to the seam', () => {
  const src = resolveImageForAgentBody();
  assert.match(
    src,
    /resources:\s*resolved\.toolchain\.resources\s*\|\|\s*null/,
    'must thread resolved.toolchain.resources into the {toolchainId, environmentId, environmentName} ' +
      'context object — otherwise a validated resources override is never read at spawn time',
  );
});

test('resolveImageForAgent still resolves the image/toolchainId/environment fields unchanged', () => {
  const src = resolveImageForAgentBody();
  assert.match(src, /image:\s*resolved\.image/);
  assert.match(src, /toolchainId:\s*resolved\.toolchainId/);
  assert.match(src, /environmentId:\s*env\s*\?\s*env\.id\s*:\s*null/);
  assert.match(src, /environmentName:\s*env\s*\?\s*env\.name\s*:\s*null/);
});
