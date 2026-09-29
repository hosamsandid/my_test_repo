'use strict';

// Guards the route half of #2460 AC4 — the one thing the pure module can't own.
//
// `llm-probe-fallback.js` decides WHAT a fixed-base 404 means: with `{ oauth:
// true }` a 404 on the fixed api.anthropic.com base is auth-OK regardless of
// body shape (the route always exists there); without it, classification falls
// back to the weaker `isUnknownModelBody` body check. That logic is unit-tested
// there (classifyMessagesFallback, both with and without the flag).
//
// But WHICH call sites pass the flag lives in the route. The Test-connection
// path (`probeLlmEndpointTest`) and the Discover-models path
// (`probeLlmEndpointDiscover`) both hit the SAME fixed base for an OAuth
// provider, so they must classify a 404 identically — otherwise Test reports
// success while Discover reports "check the Base URL" for the same valid
// provider (and the Base URL isn't even operator-editable for OAuth). #2460
// shipped the flag on Test but dropped it on Discover; this locks them together.
//
// api.js cannot be `require`d in a unit test (it boots Express and reaches for
// the orchestrator), so this reads the route's source — the same drift-guard
// technique copilot-timeout-wiring.test.js and the src-side `*-wiring.test.js`
// files use (#651). Every check is a named function over an arbitrary source
// string, so the mutation proof at the bottom re-runs the very same check
// against a sabotaged copy and asserts it fires.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

function stripComments(src) {
  return src.replace(/(^|[^:])\/\/[^\n]*/g, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** Slice one top-level function's body, so a match elsewhere in the 14k-line file can't fool us. */
function func(src, marker) {
  const start = src.indexOf(marker);
  assert.ok(start > 0, `function ${marker} not found — this guard needs re-pointing`);
  const end = src.indexOf('\nasync function ', start + marker.length);
  assert.ok(end > start, `could not find the end of function ${marker}`);
  return stripComments(src.slice(start, end));
}

// `messagesRoute: true` keeps the OAuth probe on /v1/messages — Anthropic
// rejects JWT/OAuth bearer tokens on count_tokens ("401 jwt auth is not yet
// supported on count_tokens"), so both paths must probe the messages route.
const OAUTH_FIXED_BASE_CALL =
  /probeMessagesFallback\(ANTHROPIC_DIRECT_BASE, headers, OAUTH_PROBE_SYSTEM, \{ oauth: true, messagesRoute: true \}\)/;

const CHECKS = {
  /** Test-connection's OAuth branch classifies the fixed-base 404 as auth-OK. */
  testPassesOauthFlag(src) {
    assert.match(func(src, 'async function probeLlmEndpointTest('), OAUTH_FIXED_BASE_CALL,
      'probeLlmEndpointTest must pass { oauth: true } on the fixed api.anthropic.com base');
  },

  /** Discover-models must match Test exactly (the #2460 AC4 regression). */
  discoverPassesOauthFlag(src) {
    assert.match(func(src, 'async function probeLlmEndpointDiscover('), OAUTH_FIXED_BASE_CALL,
      'probeLlmEndpointDiscover must pass { oauth: true } so Discover and Test agree on a fixed-base 404');
  },
};

for (const [name, check] of Object.entries(CHECKS)) {
  test(`probe wiring: ${name}`, () => check(API_SRC));
}

// ── mutation proof ───────────────────────────────────────────────────────────
// Dropping the flag from either path must trip exactly that path's check.

const MUTATIONS = [
  {
    fires: 'discoverPassesOauthFlag',
    // Re-introduce the original #2460 bug: Discover loses the flag.
    apply: (s) => s.replace(
      "const fallback = await probeMessagesFallback(ANTHROPIC_DIRECT_BASE, headers, OAUTH_PROBE_SYSTEM, { oauth: true, messagesRoute: true });\n    return oauthDiscoverResult(fallback);",
      "const fallback = await probeMessagesFallback(ANTHROPIC_DIRECT_BASE, headers, OAUTH_PROBE_SYSTEM, { messagesRoute: true });\n    return oauthDiscoverResult(fallback);",
    ),
  },
  {
    fires: 'testPassesOauthFlag',
    apply: (s) => s.replace(
      "const fallback = await probeMessagesFallback(ANTHROPIC_DIRECT_BASE, headers, OAUTH_PROBE_SYSTEM, { oauth: true, messagesRoute: true });\n    return {",
      "const fallback = await probeMessagesFallback(ANTHROPIC_DIRECT_BASE, headers, OAUTH_PROBE_SYSTEM, { messagesRoute: true });\n    return {",
    ),
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
