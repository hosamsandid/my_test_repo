'use strict';

// Drift guard for the #2177 (epic #2166 B5) baseline-credential wiring inside
// `orchestrator.js`.
//
// The decision itself is a real unit test (`credential-resolution.test.js`'s
// "B5 migration" cases, over the same three pure calls this wrapper
// composes). What that cannot see is whether `startAgentProcess` actually
// THREADS the container's GH_TOKEN/GITHUB_TOKEN injection through the new
// baseline resolver rather than reading `env.githubTokenId` directly — the
// exact regression that would leave every in-container `gh`/`git` call
// (issue/PR comments, `gh pr review`) authenticating as the raw shared team
// secret forever, the thing this ticket exists to retire. `orchestrator.js`
// boots two HTTP servers on require, so it cannot be loaded in a unit test;
// these assertions read its source instead (the `acting-sender-wiring.test.js`
// technique).

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
  assert.ok(body.length > 100, `region '${openingLine}' came back too short (${body.length}) — re-point this guard`);
  return body;
}

const startAgentProcessBody = () => region('function startAgentProcess(', '\n}\n');
const baselineResolver = () => region('function resolveBaselineGithubTokenId(', '\n}');
const baselineSshResolver = () => region('function resolveBaselineSshKeyId(', '\n}');
const materializeAgentSshKeyBody = () => region('function materializeAgentSshKey(', '\n}\n');

// #2560 moved the composition itself (baseline owner → personal credential →
// never-refusing `resolveCredential`) into the pure, unit-tested
// `credentialResolution.describeBaselineCredential`, so the console's
// effective-identity display and the spawn-time bake share ONE decision. These
// guards now pin the delegation chain instead of the three inline calls.
const describeGithub = () => region('function describeBaselineGithubToken(', '\n}');
const describeSsh = () => region('function describeBaselineSshKey(', '\n}');

test('resolveBaselineGithubTokenId delegates to describeBaselineGithubToken — the same decision the console displays (#2560)', () => {
  const src = baselineResolver();
  assert.match(src, /return describeBaselineGithubToken\(cfg, env\)\.credentialId;/);
  assert.doesNotMatch(
    src,
    /credentialResolution\.resolveEffectiveOwnerId\(/,
    'a container spawn has no acting sender — resolveEffectiveOwnerId would be reaching for interactive-only machinery',
  );
});

test('describeBaselineGithubToken composes the shared pure describeBaselineCredential over the token index', () => {
  const src = describeGithub();
  assert.match(src, /credentialResolution\.describeBaselineCredential\(\{/);
  assert.match(src, /\.\.\.loadBaselineDeps\(\)/, 'must resolve WHO through the current team-admin snapshot');
  assert.match(src, /index: loadGithubTokenIndex\(\),/);
  assert.match(src, /liveUsers: loadLiveUserGate\(\),/);
  assert.match(src, /sharedCredentialId: env\?\.githubTokenId \|\| null,/);
  assert.match(src, /kind: "GitHub token"/);
  assert.doesNotMatch(src, /operation:/, 'the operation is fixed to the never-refusing "spawn" inside the pure core');
});

test('resolveBaselineGithubTokenId falls back to the raw env.githubTokenId when there is no cfg (AC8/"migrate existing bindings")', () => {
  const src = baselineResolver();
  assert.match(
    src,
    /if \(!cfg\) return sharedCredentialId;/,
    'a not-yet-persisted or missing config must resolve byte-identically to the pre-#2177 behaviour',
  );
  assert.match(src, /const sharedCredentialId = env\?\.githubTokenId \|\| null;/);
});

test('startAgentProcess injects GH_TOKEN/GITHUB_TOKEN via resolveBaselineGithubTokenId, not env.githubTokenId directly', () => {
  const src = startAgentProcessBody();
  assert.match(
    src,
    /const resolvedGithubTokenId = resolveBaselineGithubTokenId\(config, env\);/,
    'the container-baked token is exactly the "interactive action" B3/#2175 left out of scope for this ticket to close',
  );
  assert.match(src, /if \(resolvedGithubTokenId\)/);
  assert.match(src, /GH_TOKENS_DIR, resolvedGithubTokenId/);
  assert.match(src, /childEnv\.GH_TOKEN = ghToken;/);
  assert.match(src, /childEnv\.GITHUB_TOKEN = ghToken;/);
  // Negative: no remaining direct env.githubTokenId read feeding the injected
  // token — that would silently bypass the baseline resolution above.
  assert.doesNotMatch(
    src,
    /GH_TOKENS_DIR,\s*env\.githubTokenId/,
    'must not read env.githubTokenId directly for the injected token — the whole point of #2177 is that this id is now RESOLVED, not read raw',
  );
});

// #2212 review finding: the issue's own AC names "`env.githubTokenId` (and
// per-repo `sshKeyId`)" together, but the shipped PR wired only the
// GitHub-token half — `materializeAgentSshKey` still read the environment's
// raw shared deploy key directly. These mirror the GitHub-token guards above
// for the SSH-key sibling.

test('resolveBaselineSshKeyId delegates to describeBaselineSshKey, which composes the shared pure core over the key index', () => {
  assert.match(baselineSshResolver(), /return describeBaselineSshKey\(cfg, sharedSshKeyId\)\.credentialId;/);
  const src = describeSsh();
  assert.match(src, /credentialResolution\.describeBaselineCredential\(\{/);
  assert.match(src, /\.\.\.loadBaselineDeps\(\)/);
  assert.match(src, /index: loadSshKeyIndex\(\),/);
  assert.match(src, /liveUsers: loadLiveUserGate\(\),/);
  assert.match(src, /sharedCredentialId:\s*sharedSshKeyId \|\| null,\s*\n?\s*kind: "SSH key"/);
  assert.doesNotMatch(src, /operation:/);
});

test('resolveBaselineSshKeyId falls back to the raw shared sshKeyId when there is no cfg (AC8/"migrate existing bindings")', () => {
  const src = baselineSshResolver();
  assert.match(
    src,
    /if \(!cfg\) return sharedSshKeyId \|\| null;/,
    'a not-yet-persisted or missing config must resolve byte-identically to the pre-#2212 behaviour',
  );
});

test('materializeAgentSshKey resolves its key through resolveBaselineSshKeyId, not the raw env.repositories[].sshKeyId', () => {
  const src = materializeAgentSshKeyBody();
  assert.match(
    src,
    /const sharedSshKeyId = baselineSharedSshKeyId\(env\);/,
    'the per-repo shared key is discovered by the helper the effective-identity display uses too (#2560)',
  );
  assert.match(
    region('function baselineSharedSshKeyId(', '\n}'),
    /repos\.find\(\(r\) => r && r\.sshKeyId\)\?\.sshKeyId/,
    'still the first repository carrying a key — only what feeds the actual bake changes',
  );
  assert.match(
    src,
    /const sshKeyId = resolveBaselineSshKeyId\(cfg, sharedSshKeyId\);/,
    'the installed identity must come from the baseline resolver, mirroring the GH_TOKEN bake',
  );
  // Negative: nothing downstream in this function reads sharedSshKeyId again
  // for the actual install (only the resolved `sshKeyId` may feed the copy).
  assert.doesNotMatch(
    src,
    /SSH_KEYS_DIR,\s*sharedSshKeyId\)/,
    'must not read the raw shared sshKeyId directly for the installed key material',
  );
});

test('startAgentProcess threads cfg into materializeAgentSshKey so the baseline resolver has an owner to resolve', () => {
  const src = startAgentProcessBody();
  assert.match(
    src,
    /materializeAgentSshKey\(id, env, childEnv, config\);/,
    'materializeAgentSshKey needs the agent config to resolve a baseline owner — calling it with 3 args silently reverts to the raw shared key',
  );
});

// #2560: the console's effective-identity endpoint must describe what the spawn
// path bakes — the same describe functions and the same shared-key discovery.
test('the effective-credentials endpoint reuses the spawn-path describe functions (#2560 AC7)', () => {
  const src = region('function describeAgentBaselineCredentials(', '\n}');
  assert.match(src, /github: describeBaselineGithubToken\(cfg, env\),/);
  assert.match(src, /ssh: describeBaselineSshKey\(cfg, baselineSharedSshKeyId\(env\)\),/);
  assert.match(SRC, /\/internal\\\/agents\\\/\(\[\^\/\]\+\)\\\/effective-credentials\$\//);
  assert.match(SRC, /\.\.\.describeAgentBaselineCredentials\(cfg\)/);
});

// #2560 AC7: the console's effective-identity endpoints must describe through the
// SAME describeBaseline* functions the spawn bake uses — never a second resolver.
test('#2560 the effective-credentials endpoints go through describeAgentBaselineCredentials', () => {
  const effective = region("const effectiveCredsMatch = req.method === 'GET'", '\n      return;\n    }\n');
  assert.match(effective, /describeAgentBaselineCredentials\(cfg\)/);
  const owners = region("const ownerBaselineMatch = req.method === 'GET'", '\n      return;\n    }\n');
  assert.match(owners, /describeAgentBaselineCredentials\(cfg\)/);
  assert.match(owners, /described\.github\.ownerId !== userId && described\.ssh\.ownerId !== userId/);
  const both = region('function describeAgentBaselineCredentials(', '\n}');
  assert.match(both, /github: describeBaselineGithubToken\(cfg, env\)/);
  assert.match(both, /ssh: describeBaselineSshKey\(cfg, baselineSharedSshKeyId\(env\)\)/);
  assert.match(materializeAgentSshKeyBody(), /const sharedSshKeyId = baselineSharedSshKeyId\(env\);/);
});
