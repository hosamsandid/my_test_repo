'use strict';

// Source-reading drift guard for the console's control-plane credential (#1456).
//
// The whole justification for wrapping the global `fetch` instead of editing 126
// call sites is that completeness becomes a property. That property has exactly
// two preconditions, and both live in api.js, which is 18 000 lines and cannot be
// required in a unit test (it starts servers and background pollers):
//
//   AC1  The install runs EXACTLY ONCE.
//   AC2  It runs BEFORE anything can make an orchestrator call — i.e. before the
//        express app is built, and therefore before every route handler, every
//        background poller, and `auth.js`'s pre-session users/verify call.
//
// Both fail silently: a call site that goes out without the header succeeds in
// observe mode (the whole point of the observe rung) and 401s only after an
// operator flips to enforce, in production, weeks later.
//
// Every check is a predicate over a source string so the mutation block below can
// prove each one actually fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

// Line comments BEFORE block comments: api.js's very first comment mentions a
// glob, whose `/*` would otherwise pair with a `*/` far below and swallow the
// code being asserted on.
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')
    .replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '');
}
const CODE = stripComments(SRC);

test('the comment strip did not eat the source it is reading', () => {
  assert.ok(CODE.length > SRC.length * 0.5, `stripped ${SRC.length} → ${CODE.length}`);
  assert.ok(CODE.includes('const app = express();'));
});

const CHECKS = {
  'installed-exactly-once': (code) => {
    const calls = code.split('installInternalAuthFetch(').length - 1;
    assert.equal(calls, 1,
      `installInternalAuthFetch must be called exactly once, found ${calls} — a second `
      + 'call is a no-op today but signals two competing wrappers');
    assert.match(code, /const internalAuthClient = require\('\.\/internal-auth-client'\);/,
      'the client module must be required in api.js');
  },

  'installed-before-the-app': (code) => {
    const installAt = code.indexOf('internalAuthClient.installInternalAuthFetch()');
    const appAt = code.indexOf('const app = express();');
    assert.notEqual(installAt, -1, 'the install call is missing');
    assert.notEqual(appAt, -1, 'the express app creation moved — re-anchor this guard');
    assert.ok(installAt < appAt,
      'the fetch wrapper must be installed before the express app is built, or a route '
      + 'or poller registered above it can reach :4002 without the control-plane token');
  },

  'no-call-site-sets-its-own-internal-authorization': (code) => {
    // If a call site hand-rolled an Authorization header for :4002, the wrapper
    // would defer to it (it never overrides) and that site would silently be the
    // one exception. Nothing does this today; this keeps it that way.
    const lines = code.split('\n');
    const offenders = [];
    lines.forEach((line, i) => {
      if (!/\$\{(?:orchestratorUrl|ORCH_URL\(\)|CONTEXT_ORCH_URL\(\))\}\/internal\//.test(line)) return;
      // A fetch init is written on the call line or in the few lines that follow.
      const window = lines.slice(i, i + 4).join('\n');
      if (/[Aa]uthorization/.test(window)) offenders.push(i + 1);
    });
    assert.deepEqual(offenders, [],
      `orchestrator call site(s) setting their own Authorization at line(s): ${offenders}`);
  },
};

function runCheck(name, code) {
  try { CHECKS[name](code); return null; } catch (err) { return err.message; }
}

for (const name of Object.keys(CHECKS)) {
  test(`wiring: ${name}`, () => {
    const failure = runCheck(name, CODE);
    assert.equal(failure, null, failure || '');
  });
}

const MUTATIONS = [
  {
    name: 'removing the install call',
    check: 'installed-exactly-once',
    apply: (code) => code.replace('internalAuthClient.installInternalAuthFetch()', 'null'),
  },
  {
    name: 'moving the install below the express app',
    check: 'installed-before-the-app',
    apply: (code) => {
      const line = '  const r = internalAuthClient.installInternalAuthFetch();';
      assert.ok(code.includes(line));
      return code.replace(line, '').replace('const app = express();', `const app = express();\n${line}`);
    },
  },
  {
    name: 'a call site hand-rolling its own Authorization for :4002',
    check: 'no-call-site-sets-its-own-internal-authorization',
    // The realistic shape: a call whose init object, one line below, carries an
    // Authorization the wrapper would then defer to.
    apply: (code) => code.replace(
      '${ORCH_URL()}/internal/',
      '${ORCH_URL()}/internal/x`, {\n      headers: { Authorization: `Bearer hand-rolled` },\n    });\nvoid `${ORCH_URL()}/internal/'),
  },
];

for (const mutation of MUTATIONS) {
  test(`mutation proof: ${mutation.name} trips ${mutation.check}`, () => {
    const mutated = mutation.apply(CODE);
    assert.notEqual(mutated, CODE, 'the sabotage matched nothing — this proof would be vacuous');
    const failure = runCheck(mutation.check, mutated);
    assert.ok(failure, `${mutation.check} did NOT fire on: ${mutation.name}`);
  });
}

test('every check is covered by at least one mutation', () => {
  const covered = new Set(MUTATIONS.map((m) => m.check));
  for (const name of Object.keys(CHECKS)) {
    assert.ok(covered.has(name), `check "${name}" has no mutation proving it fires`);
  }
});

test('the console does not require the orchestrator package at runtime', () => {
  // The admin-console image copies only `api/*.js`, so a runtime require of
  // ../../orchestrator would crash the container. The two-sided derivation guard
  // in internal-auth-client.test.js may do it (tests never run in the image);
  // the shipped module may not.
  const client = fs.readFileSync(path.join(__dirname, 'internal-auth-client.js'), 'utf8');
  assert.doesNotMatch(client, /require\(['"]\.\.\/\.\.\/orchestrator/,
    'internal-auth-client.js must stay self-contained');
});
