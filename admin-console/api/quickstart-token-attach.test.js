'use strict';

// Run: node --test admin-console/api/quickstart-token-attach.test.js
//
// #2158 AC11 — POST /api/quickstart's reused-environment branch used to write
// `env.githubTokenId` with NO authorization check at all: any authenticated
// caller who happened to POST a repo URL matching an existing tokenless
// environment could get the server to attach a GitHub token to a record they
// cannot otherwise manage. #2158 made this materially worse — environments
// are now discoverable by every user via the global tier, so an id that used
// to require a guess is now advertised in every environment picker.
//
// api.js boots two listeners on require (#651), so the route cannot be driven
// live here. This is the `tiered-resource-routes.test.js` source-reading
// shape: named predicates over a source string, driven over both the real
// source and a deliberately sabotaged copy (the literal pre-fix code) so the
// guard is proven to actually fail when the gate is missing.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

// One route handler's body, comment-free. Anchored on the exact `app.post(`
// registration and cut at the next top-level route, so the slice can never
// run past its own handler into a neighbour's gate.
function route(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(src.slice(start, end));
}

const MARKER = "app.post('/api/quickstart', ";

const CHECKS = {
  // The fix itself: the reused-env-without-a-token branch must not write
  // `env.githubTokenId` unless the caller can manage that environment.
  'quickstart-token-attach-is-gated': (s) =>
    /if \(canManageEnvironment\(getScope\(req\), env\)\) \{\s*env\.githubTokenId = chosenTokenId;/
      .test(route(s, MARKER)),
  // A refused attach must not silently disappear — the sanity check that
  // there IS an else-branch (a refusal signal), not just a dropped write.
  'quickstart-token-attach-refusal-is-tracked': (s) =>
    /tokenAttachRefused = true/.test(route(s, MARKER)),
  // The refusal must actually reach the response in some form, not just sit
  // in a local variable nothing reads.
  'quickstart-token-warning-reaches-the-response': (s) => {
    const body = route(s, MARKER);
    return (body.match(/\.\.\.\(tokenWarning \? \{ tokenWarning \} : \{\}\)/g) || []).length >= 2;
  },
  // Sanity: the handler must resolve a real scope, or every check above could
  // pass against a `getScope` that was never actually reachable in this file.
  'getScope-is-a-real-function-in-this-file': (s) => /function getScope\(req\)/.test(s),
};

function runChecks(src) {
  const failed = [];
  for (const [name, fn] of Object.entries(CHECKS)) {
    let ok = false;
    try { ok = !!fn(src); } catch { ok = false; }
    if (!ok) failed.push(name);
  }
  return failed;
}

test('AC11: the quickstart reused-env token attach carries its gate', () => {
  assert.deepEqual(runChecks(API_SRC), [], 'wiring missing for these checks');
});

// ── the mutation proof ───────────────────────────────────────────────────
//
// The literal pre-#2158-fix code: an unconditional write, no gate, no
// refusal signal. If this guard cannot tell that shape from the fixed one,
// it is not testing anything.

const UNGATED_ORIGINAL =
  "} else if (!env.githubTokenId) {\n" +
  "    // Existing env without a token — attach the chosen one so the clone works.\n" +
  "    env.githubTokenId = chosenTokenId;\n" +
  "    env.updatedAt = new Date().toISOString();\n" +
  "    saveEnvironment(env.id, env);\n" +
  "  }";

test('mutation proof: reverting to the ungated write fails the guard', () => {
  const body = route(API_SRC, MARKER);
  const start = body.indexOf('} else if (!env.githubTokenId)');
  assert.ok(start > 0, 'could not find the branch this guard protects — re-point it');
  const end = body.indexOf('\n  }', start) + '\n  }'.length;
  const sabotaged = API_SRC.slice(0, API_SRC.indexOf(MARKER)) +
    route(API_SRC, MARKER).slice(0, start) + UNGATED_ORIGINAL + route(API_SRC, MARKER).slice(end) +
    API_SRC.slice(API_SRC.indexOf(MARKER) + route(API_SRC, MARKER).length);
  const failed = runChecks(sabotaged);
  assert.ok(failed.includes('quickstart-token-attach-is-gated'), `expected the gate check to fail; failed=[${failed.join(', ')}]`);
  assert.ok(failed.includes('quickstart-token-attach-refusal-is-tracked'), `expected the refusal-tracking check to fail; failed=[${failed.join(', ')}]`);
});
