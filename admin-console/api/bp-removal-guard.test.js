'use strict';

// Removal guard for the console-API half of the BriefingPack removal
// (#1962, epic #1961 Phase 1).
//
// Why this file exists as a sibling of `orchestrator/bp-removal-guard.test.js`:
// AC1 spans BOTH services, but that guard reads `orchestrator.js` only. The two
// console-side surfaces it removed — `POST /api/agents/:id/sync-bps` and the
// `app.all('/api/bp-explorer/*')` pass-through proxy — had no guard at all, so
// nothing would have caught either coming back.
//
// The line between "gone" and "deliberately retained" matters here more than on
// the orchestrator side, because this file KEEPS real BriefingPack code on
// purpose (AC6 / R3): the BP → flow-draft import is explicitly out of scope for
// this phase, so `briefingsToUnified`, the `?workspace=` graph projection and
// `POST /api/process/drafts/import-briefings` must all still be present. A
// blanket `doesNotMatch(/bp-explorer/)` would therefore be wrong — it would
// fail on the very code the ticket says to leave alone. Each assertion below is
// anchored on the specific route that went away instead.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/**
 * Comments name the very feature under test — strip them before asserting.
 *
 * Line-oriented for the same reason as the orchestrator guard, and the hazard
 * is concrete in this file: `api.js` contains Express route STRINGS ending in
 * `/*` (the plugin UI proxy `'/plugins/:id/ui/*'` is the surviving example, and
 * the removed `'/api/bp-explorer/*'` was another). A naive
 * `/\/\*[\s\S]*?\*\//` sweep reads that `/*` as a block-comment opener and eats
 * hundreds of lines of real code, after which every `doesNotMatch` below would
 * pass for entirely the wrong reason.
 */
function stripComments(src) {
  return src
    .replace(/^[ \t]*\/\/[^\n]*$/gm, '')   // whole-line // comments
    .replace(/^[ \t]*\*[^\n]*$/gm, '')      // continuation lines of /* … */ blocks
    .replace(/^[ \t]*\/\*[^\n]*$/gm, '')    // opening line of a /* … */ block
    .replace(/[ \t]\/\/[^\n]*$/gm, '');     // trailing comments
}

const CODE = stripComments(SRC);

// Sanity-check the strip itself: if it ever swallows real code, the removal
// assertions become vacuous. Anchor on structural signatures that must survive.
test('the comment strip leaves the file structurally intact', () => {
  assert.ok(CODE.length > SRC.length * 0.5, 'strip removed more than half the file');
  for (const signature of [
    "app.post('/api/teams'",
    "app.get('/api/agents'",
    "require('./unified-graph')",
  ]) {
    assert.ok(CODE.includes(signature), `strip destroyed real code: ${signature} is gone`);
  }
});

// ---- AC1 (console API half): the two removed surfaces ----------------------

test('AC1: the sync-bps route is gone from the console API', () => {
  // The mission-scan trigger. Anchored on the path token rather than the whole
  // route expression so a re-add under any HTTP verb or router still trips it.
  assert.doesNotMatch(CODE, /sync-bps/);
});

test('AC1: the bp-explorer pass-through proxy is gone', () => {
  // The catch-all proxy that exposed bp-explorer to the browser. Deliberately
  // narrow: `BP_EXPLORER_URL` itself is RETAINED (see below), so this asserts
  // the absence of the *route*, not of the constant.
  assert.doesNotMatch(CODE, /['"]\/api\/bp-explorer/);
  assert.doesNotMatch(CODE, /app\.all\(\s*['"][^'"]*bp-explorer/);
});

// ---- AC6 / R3: what this phase deliberately KEEPS --------------------------
//
// These are preservation assertions, not removal ones. They pass against
// `origin/main` too, by design: their job is to fail if a later cleanup pass
// deletes the BP → flow-draft import that #1962 scoped OUT of this phase.

test('AC6: the BP → flow-draft import is still present', () => {
  assert.match(CODE, /briefingsToUnified/);
  assert.match(CODE, /\/api\/process\/drafts\/import-briefings/);
});

test('R3: BP_EXPLORER_URL is retained for the import paths that still read it', () => {
  assert.match(CODE, /BP_EXPLORER_URL/);
  // One definition plus the consumers the import paths need. Asserted as a
  // floor, not an exact count, so adding a legitimate consumer does not fail —
  // the point is that the constant did not become dead alongside a live route.
  const uses = (CODE.match(/BP_EXPLORER_URL/g) || []).length;
  assert.ok(uses >= 2, `expected the definition plus >=1 consumer, saw ${uses}`);
});
