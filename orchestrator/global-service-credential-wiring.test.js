'use strict';

// Drift guard for the unified-resource-access global-SERVICE credential
// fallback wiring inside `orchestrator.js` (epic #2361 PR4 #2357).
//
// The decision core is a real unit test (`credential-resolution.test.js`'s
// `resolveSharedServiceId` / `selectGlobalServiceCredentialId` /
// `resolveCredential` cases). What THAT cannot see is whether the four fs-bound
// resolver wrappers actually THREAD the scanned global-service id into
// `resolveCredential` — omit it and the feature is dead code, and every unit
// test still passes (the exact silent failure mode the offboarding-reconcile
// guard exists for). `orchestrator.js`
// boots HTTP listeners on require, so it cannot be imported; this reads its
// source (the `acting-sender-wiring.test.js` technique).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function region(openingLine, endNeedle) {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `could not find the end of '${openingLine}'`);
  const body = SRC.slice(start, end);
  assert.ok(body.length > 100, `region '${openingLine}' came back too short (${body.length})`);
  return body;
}

const WRAPPERS = [
  ['resolveAttributedGithubToken', 'function resolveAttributedGithubToken(', 'tokenIndex'],
  ['resolveAttributedSshKey', 'function resolveAttributedSshKey(', 'keyIndex'],
];

test('every attributed resolver threads the global-service scan into resolveCredential', () => {
  for (const [name, opening, indexVar] of WRAPPERS) {
    const body = region(opening, '\n}');
    // The global-service id must be scanned from the SAME index array already
    // loaded for the personal lookup (single read) and reach resolveCredential.
    assert.match(body, new RegExp(`globalServiceCredentialId: credentialResolution\\.selectGlobalServiceCredentialId\\(${indexVar}\\),`),
      `${name} must forward the global-service id scanned from the already-loaded ${indexVar}`);
  }
});

// #2560 moved the baseline composition into the pure `describeBaselineCredential`,
// which scans the global-service id from the index it is handed itself (unit-
// tested in credential-resolution.test.js: "no env binding → … source global").
// What stays fs-bound — and so guarded here — is that each baseline wrapper hands
// it the full, already-loaded index of the right kind.
test('every baseline resolver hands the full credential index to describeBaselineCredential (global-service scan inside)', () => {
  for (const [name, opening, indexLoad] of [
    ['describeBaselineGithubToken', 'function describeBaselineGithubToken(', 'loadGithubTokenIndex'],
    ['describeBaselineSshKey', 'function describeBaselineSshKey(', 'loadSshKeyIndex'],
  ]) {
    const body = region(opening, '\n}');
    assert.match(body, /credentialResolution\.describeBaselineCredential\(\{/, `${name} must use the shared pure core`);
    assert.match(body, new RegExp(`index: ${indexLoad}\\(\\),`), `${name} must pass the ${indexLoad}() index`);
  }
  const core = fs.readFileSync(path.join(__dirname, 'credential-resolution.js'), 'utf8');
  const start = core.indexOf('function describeBaselineCredential(');
  const body = core.slice(start, core.indexOf('\n}\n', start));
  assert.match(body, /const globalServiceCredentialId = selectGlobalServiceCredentialId\(index\);/);
  assert.match(body, /\n\s+globalServiceCredentialId,\n\s+\}\);/, 'the scanned id must reach resolveCredential');
});
