'use strict';

// Drift guard for the #2938 SSH commit-signing wiring inside `orchestrator.js`.
// The decisions are unit-tested in `commit-signing.test.js` / `ssh-sign.test.js`;
// what those cannot see is whether every PLATFORM commit site actually runs
// with the signing env, and whether the push/PR failure paths translate an
// unsigned-commit rejection. `orchestrator.js` boots servers on require, so —
// like `acting-sender-wiring.test.js` — this reads its source.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function region(openingLine, endNeedle = '\n}\n') {
  const start = SRC.indexOf(openingLine);
  assert.ok(start > 0, `'${openingLine}' not found — this guard needs re-pointing`);
  const end = SRC.indexOf(endNeedle, start + openingLine.length);
  assert.ok(end > start, `could not find the end of '${openingLine}'`);
  return stripComments(SRC.slice(start, end));
}

test('every KB git env carries the team signing config (bootstrap, migration, heal, convergence, rebases)', () => {
  const body = region('function _buildKbGitEnv(');
  assert.match(body, /withPlatformSigningEnv\(_buildKbGitEnvUnsigned\(repoRef, env\), resolveTeamSigning\(env\)\)/);
  // No KB call site bypasses the signed builder.
  const unsignedUses = SRC.match(/_buildKbGitEnvUnsigned\(/g) || [];
  assert.equal(unsignedUses.length, 2, 'only the definition and _buildKbGitEnv itself may name the unsigned builder');
});

test('the pool-teardown commit signs with the pooled role\'s resolution', () => {
  const body = region('async function gracefulPoolTeardown(');
  assert.match(body, /"commit", "-m", `chore\(pool\)[^\n]*\n\s*cwd: repoPath, env: withPlatformSigningEnv\(process\.env, resolveAgentSigning\(cfg, env, null\)\)/);
});

test('push and PR failures translate an unsigned-commit rejection (AC8)', () => {
  const push = region('async function _agentGitPushLocked(');
  assert.match(push, /unsignedRejectionMessage\(id, "push", raw, body\.actingSender\)/);
  const pr = region('async function _agentCreatePrLocked(');
  assert.match(pr, /unsignedRejectionMessage\(id, "PR", raw, body\.actingSender\)/);
  assert.match(SRC, /if \(err\.unsignedCommits\) payload\.code = 'unsigned-commits-rejected';/);
});

test('a forwarded gh pr merge / update-branch failure carries the unsigned-commit message (AC8)', () => {
  const start = SRC.indexOf("const ghWriteMatch = ");
  assert.ok(start > 0);
  const route = stripComments(SRC.slice(start, SRC.indexOf('\n    }\n', start)));
  assert.match(route, /commitSigning\.ghUnsignedOperation\(parsed\.args\)/);
  assert.match(route, /unsignedRejectionMessage\(id, ghOp, [^\n]*parsed\.actingSender\)/);
  assert.match(route, /result\.code = 'unsigned-commits-rejected'/);
});

test('the unsigned-hint route serves the shim\'s merge post-check, allowlisted with own scope (AC8)', () => {
  const start = SRC.indexOf("const unsignedHintMatch = ");
  assert.ok(start > 0);
  const route = stripComments(SRC.slice(start, SRC.indexOf('\n    }\n', start)));
  assert.match(route, /commitSigning\.UNSIGNED_HINT_OPERATIONS\.includes\(parsed\.operation\)/);
  assert.match(route, /unsignedRejectionMessage\(id, operation, parsed\.detail\.slice\(0, UNSIGNED_HINT_MAX_BYTES\), parsed\.actingSender\)/);
  const auth = fs.readFileSync(path.join(__dirname, 'internal-auth.js'), 'utf8');
  assert.match(auth, /git\\\/unsigned-hint\$\/, scope: "own"/);
});

test('the agent signer re-resolves the key per call and refuses a changed key', () => {
  const body = region('async function signAgentPayload(');
  assert.match(body, /resolveAgentSigning\(cfg, env, resolveActingSenderUserId\(body\.actingSender, cfg\)\)/);
  assert.match(body, /signing key changed since this run started/);
  assert.match(body, /sshSign\.signPayload\(/);
});

test('the signing routes are served and allowlisted with own scope', () => {
  assert.match(SRC, /\\\/git\\\/signing-config\$\//);
  assert.match(SRC, /\\\/git\\\/sign\$\//);
  const auth = fs.readFileSync(path.join(__dirname, 'internal-auth.js'), 'utf8');
  assert.match(auth, /git\\\/signing-config\$\/, scope: "own"/);
  assert.match(auth, /git\\\/sign\$\/, scope: "own"/);
});

test('the effective-credentials description includes the signing key', () => {
  const body = region('function describeAgentBaselineCredentials(');
  assert.match(body, /signing: describeSigning\(resolveAgentSigning\(cfg, env, null\)\)/);
});
