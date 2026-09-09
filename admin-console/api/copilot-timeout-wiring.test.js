'use strict';

// Guards the route half of #2131 — the two things the pure modules cannot own.
//
// `flow-copilot.js` decides WHAT a timeout is (`isTimeoutFailure`) and how a
// failed turn is classified (`classifyTurnFailure`), and both are unit-tested
// there. But two decisions live in the route:
//
//  1. the per-CALL deadline cap. Handing one call the whole remaining turn
//     budget means a slow single generation consumes the turn and the
//     generate-in-parts fallback never gets to run — the feature would be dead
//     code in exactly the scenario it was built for.
//  2. emitting the classified `code` on the NDJSON error event. Without it the
//     browser has to re-derive the failure class by matching on a transport
//     string, which is the drift AC1 exists to remove.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the route's source — the same drift-guard
// technique team-stream-materialize.test.js and the src-side `*-wiring.test.js`
// files use (#651). Every check is a named function over an arbitrary source
// string, so the mutation proof at the bottom re-runs the very same check
// against a sabotaged copy and asserts it fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/**
 * Strip comments, line comments FIRST. The order is load-bearing on api.js: a
 * line comment mentioning a path glob (`/api/*`) contains a `/*` that would
 * otherwise pair with the next real `*​/` hundreds of lines below and swallow
 * the code being asserted on.
 */
function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Slice one route's body, so a match elsewhere in the 14k-line file can't fool us. */
function route(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return src.slice(start, end);
}

const COPILOT_ROUTE = "app.post('/api/process/copilot'";
const copilotRoute = (src) => stripComments(route(src, COPILOT_ROUTE));

// ── the checks, as named functions over an arbitrary source ──────────────────
// Ordered most-specific-first: several read the same lines, so one mutation must
// trip exactly one check rather than whichever happens to run first.

const CHECKS = {
  /** The per-call budget is the MINIMUM of the call cap and what the turn has left. */
  callDeadlineIsCapped(src) {
    const r = copilotRoute(src);
    assert.match(r, /const deadlineMs = Math\.max\(5000, Math\.min\(COPILOT_CALL_DEADLINE_MS, remainingMs\)\)/,
      'a call must be bounded by the call cap, not just by the remaining turn budget');
  },

  /** The cap is derived from the turn deadline, so tuning one keeps them in step. */
  callCapDefaultsToHalfTheTurn(src) {
    const decl = stripComments(src).match(/const COPILOT_CALL_DEADLINE_MS = [^;]+;/);
    assert.ok(decl, 'COPILOT_CALL_DEADLINE_MS must be declared');
    assert.match(decl[0], /AEE_COPILOT_CALL_DEADLINE_MS/, 'the cap must stay operator-overridable');
    assert.match(decl[0], /COPILOT_STREAM_DEADLINE_MS \/ 2/,
      'the default must be half the turn deadline, so a timed-out single call leaves the split retry an equal budget');
  },

  /** The error event carries the classified code and status, never a hardcoded 502. */
  errorEventCarriesTheClassifiedCode(src) {
    const r = copilotRoute(src);
    assert.match(r, /const failure = classifyTurnFailure\(err\)/,
      'the route must classify the failure rather than re-deriving the class');
    assert.match(r, /emit\(\{ type: 'error', status: failure\.status, code: failure\.code, error: failure\.detail \}\)/,
      'the NDJSON error event must carry the stable code the client maps to guidance');
    assert.doesNotMatch(r, /type: 'error', status: 502/,
      'a hardcoded 502 would send every failure class to the same card');
  },

  /** The classifier is imported from the pure module, not reimplemented here. */
  classifierComesFromThePureModule(src) {
    const req = stripComments(src).match(/const \{[^}]*\} = require\('\.\/flow-copilot'\);/);
    assert.ok(req, "api.js must require ./flow-copilot");
    assert.match(req[0], /classifyTurnFailure/,
      'classifyTurnFailure belongs to flow-copilot.js, where it is unit-tested alongside isTimeoutFailure');
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`route wiring: ${name}`, () => check(API_SRC));
}

// ── mutation proof ───────────────────────────────────────────────────────────
// A source-reading assertion that has only ever run against correct source may
// be vacuous. Each sabotage below must make its own check throw — and only its
// own, which is what proves the checks are independent rather than overlapping.

const MUTATIONS = [
  {
    fires: 'callDeadlineIsCapped',
    apply: (s) => s.replace(
      'const deadlineMs = Math.max(5000, Math.min(COPILOT_CALL_DEADLINE_MS, remainingMs));',
      'const deadlineMs = Math.max(5000, remainingMs);',
    ),
  },
  {
    fires: 'callCapDefaultsToHalfTheTurn',
    apply: (s) => s.replace(
      '|| Math.round(COPILOT_STREAM_DEADLINE_MS / 2);',
      '|| 280000;',
    ),
  },
  {
    fires: 'errorEventCarriesTheClassifiedCode',
    apply: (s) => s.replace(
      "emit({ type: 'error', status: failure.status, code: failure.code, error: failure.detail });",
      "emit({ type: 'error', status: 502, error: err.message });",
    ),
  },
  {
    fires: 'classifierComesFromThePureModule',
    apply: (s) => s.replace('isCopilotAborted, classifyTurnFailure,', 'isCopilotAborted,'),
  },
];

for (const { fires, apply } of MUTATIONS) {
  test(`mutation proof: breaking ${fires} fires exactly that check`, () => {
    const mutated = apply(API_SRC);
    assert.notEqual(mutated, API_SRC, 'the mutation did not change the source — re-point it');
    assert.throws(() => CHECKS[fires](mutated), assert.AssertionError,
      `${fires} did not catch its own mutation`);
    for (const [name, check] of Object.entries(CHECKS)) {
      if (name === fires) continue;
      assert.doesNotThrow(() => check(mutated),
        `${name} also fired — the checks overlap, so a failure would name the wrong one`);
    }
  });
}
