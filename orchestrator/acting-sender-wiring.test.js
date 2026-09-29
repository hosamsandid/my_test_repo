'use strict';

// Drift guard for the #2175 (epic #2166 B3) acting-sender wiring inside
// `orchestrator.js`.
//
// The decision is a real unit test (`credential-resolution.test.js`'s
// `resolveEffectiveOwnerId` cases). What that cannot see is whether the
// orchestrator's git-push/PR path actually THREADS the acting sender through
// to it rather than silently keeping the static `resolveAgentOwnerId` — the
// exact regression that would leave every interactive commit/PR/push
// attributed to the team creator no matter who is chatting. `orchestrator.js`
// boots two HTTP servers on require, so it cannot be loaded in a unit test;
// these assertions read its source instead (the `ownership-wiring.test.js`
// technique).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');

// Strip LINE comments only — see ownership-wiring.test.js for why a block-
// comment pass would make the negative assertions here silently vacuous.
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
  assert.ok(body.length > 100, `region '${openingLine}' came back too short (${body.length}) — re-point this guard`);
  return body;
}

const actingSenderResolver = () => region('function resolveActingSenderUserId(', '\n}');
const attributedToken = () => region('function resolveAttributedGithubToken(', '\n}');
const attributedSshKey = () => region('function resolveAttributedSshKey(', '\n}');
const gitPush = () => region('async function agentGitPush(', '\n}');
const createPr = () => region('async function agentCreatePr(', '\n}');

// ── the sender→userId hop reuses the #2137 lookup ───────────────────────────

test('resolveActingSenderUserId resolves through the shared usage-attribution lookup', () => {
  const src = actingSenderResolver();
  assert.match(
    src,
    /usageAttribution\.userIdForMatrixId\(/,
    'must reuse the same Matrix-id → platform-user hop enrichUsageRecord uses for cost attribution, not a second lookup',
  );
  assert.match(src, /teamsStore\.listUsers\(\)/);
});

// #2187 review finding: an unauthenticated, self-asserted sender string must
// never be trusted for credential resolution as-is. A resolved userId must be
// filtered through the pure `isActingSenderTrusted` boundary before it is
// returned — the vulnerable pre-fix shape returned `usageAttribution.
// userIdForMatrixId(...)`'s result directly with no further check.
test('#2187: a resolved userId is filtered through credentialResolution.isActingSenderTrusted before being returned', () => {
  const src = actingSenderResolver();
  assert.match(
    src,
    /credentialResolution\.isActingSenderTrusted\(cfg, userId, hasMembership\)/,
    'the resolved userId must be re-checked against the agent\'s own team/owner before use — trusting it as-is is the #2187 finding',
  );
  // The membership lookup passed in must be a REAL, injected function over the
  // teams store — not a stub that always says yes (which would defeat the
  // whole point while still satisfying the call-shape assertion above).
  assert.match(src, /teamsStore\.listMemberships\(\{ teamId, userId: uid \}\)/);
});

// ── both attributed-credential resolvers key on the effective (not static) owner ─

test('resolveAttributedGithubToken resolves the owner through resolveEffectiveOwnerId, not resolveAgentOwnerId directly', () => {
  const src = attributedToken();
  assert.match(
    src,
    /credentialResolution\.resolveEffectiveOwnerId\(/,
    'a static resolveAgentOwnerId call here would attribute every interactive write to the team creator, never the acting human',
  );
  assert.doesNotMatch(
    src,
    /credentialResolution\.resolveAgentOwnerId\(/,
    'must not also call the static resolver directly — resolveEffectiveOwnerId already falls back to it when there is no acting sender',
  );
  assert.match(src, /resolveActingSenderUserId\(actingSenderMatrixId, cfg\)/);
});

test('resolveAttributedSshKey exists as the SSH sibling and resolves the same way', () => {
  const src = attributedSshKey();
  assert.match(src, /credentialResolution\.resolveEffectiveOwnerId\(/);
  assert.match(src, /resolveActingSenderUserId\(actingSenderMatrixId, cfg\)/);
  assert.match(src, /kind: "SSH key"/);
  assert.match(src, /loadSshKeyIndex\(\)/, 'must resolve against the SSH-key credential index, not the GitHub-token one');
});

// ── the two call sites forward the request body's actingSender ──────────────

test('agentGitPush forwards body.actingSender and picks the credential by transport', () => {
  const src = gitPush();
  assert.match(
    src,
    /resolveAttributedSshKey\(id, repo\.sshKeyId, "push-ssh", body\.actingSender\)/,
    'an SSH remote must resolve the owner\'s personal SSH key, keyed on the acting sender',
  );
  assert.match(
    src,
    /resolveAttributedGithubToken\(id, env, "push-https", body\.actingSender\)/,
    'an HTTPS remote must resolve the owner\'s personal PAT, keyed on the acting sender',
  );
  assert.match(src, /agentGitOps\.isSshUrl\(repo\.url\)/, 'the transport branch must be the actual repo URL, not env-wide state');
});

test('agentCreatePr forwards body.actingSender to the token resolution', () => {
  const src = createPr();
  assert.match(
    src,
    /resolveAttributedGithubToken\(id, env, "pr", body\.actingSender\)/,
    'opening a PR is an attributed write — omitting the sender here would silently revert to the static team-creator owner',
  );
  // The pre-PR branch push additionally needs the personal SSH key on an SSH
  // remote — the same resolver agentGitPush uses, not a re-derived one.
  assert.match(src, /resolveAttributedSshKey\(id, repo\.sshKeyId, "push-ssh", body\.actingSender\)/);
});

// ── autonomous runs are unaffected: no caller invents a sender ──────────────

test('neither attributed-credential resolver is ever called with a literal/hardcoded sender', () => {
  // A hardcoded acting sender at either call site would attribute every
  // future run to one fixed identity — the exact failure "autonomous runs are
  // unaffected" (the ticket's own AC) exists to rule out. Every call site
  // must pass the request-scoped `body.actingSender` through untouched.
  for (const src of [gitPush(), createPr()]) {
    assert.doesNotMatch(src, /resolveAttributed(GithubToken|SshKey)\([^)]*,\s*"[^"]*:[^"]*"\s*\)/);
  }
});

// ── #2176 (epic #2166 B4): team-admin baseline + interactive JIT refusal ────
//
// Both resolvers must (1) thread the `{ users, memberships }` baseline
// snapshot into `resolveEffectiveOwnerId` — the wiring that lets an
// autonomous run resolve the CURRENT team-admin rather than the static
// creator owner — and (2) compute and forward an `interactive` flag into
// `resolveCredential`, derived from the resolved (trusted) sender itself, not
// re-derived from the raw untrusted matrix id.

test('resolveAttributedGithubToken threads the team-admin baseline snapshot and the interactive flag', () => {
  const src = attributedToken();
  assert.match(
    src,
    /resolveEffectiveOwnerId\(\s*cfg, loadAgentConfig, actingSenderUserId, loadBaselineDeps\(\)\)/,
    'must pass a { users, memberships } snapshot so the autonomous fallback can resolve the team-admin baseline (#2176 B4)',
  );
  assert.match(
    src,
    /const interactive = actingSenderUserId != null;/,
    'interactive must be derived from the resolved (trusted) sender, not the raw actingSenderMatrixId',
  );
  // The computed `interactive` flag must reach resolveCredential as a shorthand
  // field. (#2357 added a further field after it — globalServiceCredentialId —
  // so it is no longer necessarily the LAST field; assert it is passed, not that
  // it is last.)
  assert.match(src, /\n\s+interactive,\n/, 'the computed interactive flag must reach resolveCredential');
});

test('resolveAttributedSshKey threads the team-admin baseline snapshot and the interactive flag', () => {
  const src = attributedSshKey();
  assert.match(
    src,
    /resolveEffectiveOwnerId\(\s*cfg, loadAgentConfig, actingSenderUserId, loadBaselineDeps\(\)\)/,
  );
  assert.match(src, /const interactive = actingSenderUserId != null;/);
  assert.match(src, /\n\s+interactive,\n/);
});

test('loadBaselineDeps reads live users/memberships, not a cached or hardcoded snapshot', () => {
  const src = region('function loadBaselineDeps(', '\n}');
  assert.match(src, /teamsStore\.listUsers\(\)/);
  assert.match(src, /teamsStore\.listMemberships\(\)/);
  // Fail-open, the `loadLiveUserGate` convention: an unreadable store must
  // degrade to empty arrays (which `resolveBaselineOwnerId` already handles),
  // never throw out of the credential-resolution path.
  assert.match(src, /catch/);
  assert.match(src, /users: \[\], memberships: \[\]/);
});
