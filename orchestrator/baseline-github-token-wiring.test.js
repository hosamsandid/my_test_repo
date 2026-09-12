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

test('resolveBaselineGithubTokenId exists and is composed from the same three pure calls the attributed resolvers use', () => {
  const src = baselineResolver();
  assert.match(
    src,
    /credentialResolution\.resolveBaselineOwnerId\(/,
    'must resolve WHO through the team-admin baseline, not a static/effective-owner call meant for a live chat turn',
  );
  assert.doesNotMatch(
    src,
    /credentialResolution\.resolveEffectiveOwnerId\(/,
    'a container spawn has no acting sender — resolveEffectiveOwnerId would be reaching for interactive-only machinery',
  );
  assert.match(src, /const tokenIndex = loadGithubTokenIndex\(\);/);
  assert.match(src, /credentialResolution\.findPersonalCredentialState\(tokenIndex, ownerId, undefined, liveUserGate\)/);
  assert.match(src, /credentialResolution\.resolveCredential\(\{/);
  // The operation must be OUTSIDE ATTRIBUTED_OPERATIONS so this can never
  // refuse — a spawn/clone must always have a working path.
  assert.doesNotMatch(src, /operation:\s*"(commit|pr|review|push-https|push-ssh)"/);
  assert.match(src, /sharedCredentialId,?\s*\n?\s*kind: "GitHub token"/);
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
