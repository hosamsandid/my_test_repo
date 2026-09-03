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
// purpose (AC6 / R3): the BP → flow-draft import is the migration path off the
// model, so `briefingsToUnified` and
// `POST /api/process/drafts/import-briefings` must still be present. A blanket
// `doesNotMatch(/bp-explorer/)` would therefore be wrong — it would fail on the
// very code the ticket says to leave alone. Each assertion below is anchored on
// the specific route that went away instead.
//
// #1965 (Phase 4) moved that line twice, and both halves are asserted at the
// bottom of this file:
//   - the `?workspace=` graph projection is no longer retained; it went with
//     the Flows page's BriefingPack listing that was its only caller;
//   - the retained import no longer READS through bp-explorer. It walks the
//     mission directory in Node (`briefings-fs.js`) behind `safeAgentPath`,
//     which is what lets Phase 2 (#1963) delete the service.

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

/* ── #1965 (Phase 4): the graph projection went, the import was ported ───── */

// Slice one route's body out of this 14k-line file, so a match anywhere else
// cannot stand in for the route under test. The end anchor is searched FROM the
// start offset (an earlier `\napp.` would otherwise yield an empty slice and a
// silently vacuous assertion).
function routeBody(marker) {
  const from = CODE.indexOf(marker);
  assert.notEqual(from, -1, `route not found: ${marker}`);
  const end = CODE.indexOf('\napp.', from + marker.length);
  const body = CODE.slice(from, end === -1 ? undefined : end);
  assert.ok(body.length > 200, `route slice for ${marker} looks empty — update the anchor`);
  return body;
}

test('#1965 AC1: the BP source of the unified graph endpoint is gone', () => {
  // The endpoint itself is RETAINED and must keep serving the live source
  // unchanged (AC6) — this asserts only that its `?workspace=` branch went.
  const route = routeBody("app.get('/api/flows/graph'");
  assert.doesNotMatch(route, /req\.query\.workspace/, 'the BP branch still reads ?workspace=');
  assert.doesNotMatch(route, /BP_EXPLORER_URL/, 'the graph route still calls bp-explorer');
  assert.doesNotMatch(route, /briefingsToUnified/, 'the graph route still maps BP packs');
  // …and the live half it must not have taken with it.
  assert.match(route, /source: 'live'/);
  assert.match(route, /buildUnifiedGraph\(/);
});

test('#1965 AC3: the import reads the filesystem, not bp-explorer', () => {
  const route = routeBody("app.post('/api/process/drafts/import-briefings'");
  assert.doesNotMatch(route, /BP_EXPLORER_URL/, 'the import still calls bp-explorer');
  assert.doesNotMatch(route, /\bfetch\(/, 'the import still makes an HTTP call');
  assert.match(route, /readBriefingPacks\(/, 'the import must read packs off disk');
});

test('#1965: the import reports its skipped packs, and omits the key when there are none', () => {
  // `readBriefingPacks` collects `skipped` (packs with no resolvable id, which
  // therefore contribute no role). The first cut of this route destructured
  // only `packs`, so the list was collected, unit-tested and then discarded by
  // its only caller. Two properties, both of which the route comment leans on:
  const route = routeBody("app.post('/api/process/drafts/import-briefings'");
  //   1. it is actually read off the helper…
  assert.match(route, /\{\s*packs\s*,\s*skipped\s*\}\s*=\s*readBriefingPacks\(/,
    'the route must destructure skipped, not just packs');
  //   2. …and put on the response only when non-empty, so the normal 201 body
  //      is byte-identical to before the diagnostic existed. Anchored on the
  //      conditional spread rather than the bare word, because an
  //      unconditional `{ ...draft, skipped }` would satisfy a bare match
  //      while silently changing every response.
  assert.match(route, /skipped\.length\s*>\s*0/, 'the emptiness check is gone');
  assert.match(route, /res\.status\(201\)\.json\([^)]*\?[\s\S]{0,80}?skipped[\s\S]{0,40}?:\s*draft/,
    'skipped must be added conditionally, never on every response');
  // And never persisted: the draft on disk is a process-template bundle.
  assert.doesNotMatch(route, /writeJsonAtomic\([^)]*\)[\s\S]{0,80}?skipped\s*[,}]/,
    'skipped must not be written into the persisted draft');
});

test('#1965 AC3: the import resolves its path through the shared containment barrier', () => {
  const route = routeBody("app.post('/api/process/drafts/import-briefings'");
  // `safeAgentPath` is the resolver every sibling workspace handler uses: it
  // realpaths the agent root and refuses traversal, absolute paths and
  // outward-pointing symlinks. A null return must end the request.
  assert.match(route, /safeAgentPath\(/);
  assert.match(route, /if\s*\(!missionDir\)[\s\S]{0,160}?res\.status\(400\)/);
  // The old contract took a bare absolute path no barrier ever saw.
  assert.doesNotMatch(route, /req\.body\?\.workspace/, 'the unguarded workspace body field is back');
});

test('#1965: bp-explorer is no longer reachable from either BP flow path', () => {
  // BP_EXPLORER_URL is still legitimately defined and used — by the workspace
  // directory picker, which #1965 does not touch (it is Phase 2's to remove
  // with the service). So this is anchored on the two routes that DID stop
  // using it rather than on the constant, which would fail for the wrong
  // reason. The definition plus that one consumer is the expected floor.
  const uses = (CODE.match(/BP_EXPLORER_URL/g) || []).length;
  assert.ok(uses >= 2, `expected the definition plus >=1 consumer, saw ${uses}`);
  assert.doesNotMatch(CODE, /BP_EXPLORER_URL[^\n]*api\/briefings/, 'the /api/briefings fetch is back');
});
