'use strict';

// Drift guard for the unified-resource-access global-SERVICE credential
// fallback wiring inside `orchestrator.js` (epic #2361 PR4 #2357).
//
// The decision core is a real unit test (`credential-resolution.test.js`'s
// `resolveSharedServiceId` / `selectGlobalServiceCredentialId` /
// `resolveCredential` cases). What THAT cannot see is whether the four fs-bound
// resolver wrappers actually THREAD the flag and the scanned global-service id
// into `resolveCredential` — omit either and the feature is dead code even for
// an operator who opts in, and every unit test still passes (the exact silent
// failure mode the offboarding-reconcile guard exists for). `orchestrator.js`
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
  ['resolveBaselineGithubTokenId', 'function resolveBaselineGithubTokenId(', 'tokenIndex'],
  ['resolveBaselineSshKeyId', 'function resolveBaselineSshKeyId(', 'keyIndex'],
];

test('the mode flag is read once at boot into a RESOURCE_ACCESS_V2 const', () => {
  assert.match(SRC, /const RESOURCE_ACCESS_V2 = resolveResourceAccessV2\(process\.env\);/,
    'the orchestrator must resolve the flag from process.env, not re-read it per call');
  assert.match(SRC, /require\("\.\/resource-access-mode"\)/,
    'must import the byte-mirrored resource-access-mode module');
});

test('every attributed/baseline resolver threads the flag + a flag-guarded global-service scan into resolveCredential', () => {
  for (const [name, opening, indexVar] of WRAPPERS) {
    const body = region(opening, '\n}');
    // The flag itself must reach resolveCredential — otherwise the widened
    // shared-service fallback is unreachable even when the operator opts in.
    assert.match(body, /resourceAccessV2: RESOURCE_ACCESS_V2,/,
      `${name} must forward resourceAccessV2: RESOURCE_ACCESS_V2 into resolveCredential`);
    // The global-service id must be scanned from the SAME index array already
    // loaded for the personal lookup (single read)…
    assert.match(body, new RegExp(`selectGlobalServiceCredentialId\\(${indexVar}\\)`),
      `${name} must scan the global-service id from the already-loaded ${indexVar}`);
    // …and ONLY when the flag is on (the `RESOURCE_ACCESS_V2 ? … : null` guard
    // keeps the file scan out of the default, un-opted-in path entirely).
    assert.match(body, /globalServiceCredentialId: RESOURCE_ACCESS_V2/,
      `${name} must guard the scan behind RESOURCE_ACCESS_V2`);
  }
});

test('the unified resource-access mode is logged at boot so it is never a guess', () => {
  assert.match(SRC, /resourceAccessModeLogLine\(process\.env\)/);
});
