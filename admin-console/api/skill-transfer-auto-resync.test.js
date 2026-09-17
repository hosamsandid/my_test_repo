'use strict';

// #2316 — a skill transfer (Publish / Promote / Lift / Share / Adopt) changes a
// pool skill's effective content through the same commitSkillWrite path as a
// plain edit, so it must honour a team's `auto` resync mode identically to
// PUT /api/skills/:name. `skill-transfer.test.js` proves the pure planner; the
// property under test HERE is that the api.js route reaches the existing
// autoResyncOnEdit fan-out for both destination tiers.
//
// api.js boots listeners on require and cannot be exercised directly (#651), so
// its source is read — the skill-global-write-routes.test.js /
// skill-plugin-team-admin-routes.test.js technique. This gate is invisible when
// it goes missing: the transfer still succeeds and returns the right response;
// only teams on auto-sync are silently left un-synced (the exact bug #2316).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** The comments here quote the very ACs under test, so strip them first. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice one route's body out, bounded by the next `app.` registration, so a
 *  match elsewhere in the multi-thousand-line file cannot stand in for the
 *  call that is actually missing from THIS route. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

const TRANSFER = route("app.post('/api/skills/transfer',");

/* ─── AC1: a team-tier destination fans out to that team (as PUT does) ────── */

test('transfer: a team destination calls autoResyncOnEdit for that team', () => {
  assert.match(
    TRANSFER,
    /plan\.to\.tier === 'team'[\s\S]*?autoResyncOnEdit\(\s*destName\s*,\s*\{\s*tier:\s*'team',\s*teamId:\s*plan\.to\.teamId\s*\}\s*\)/,
    'a team-destination transfer must fan the resync out to the destination team, exactly as PUT /api/skills/:name does for a team-tier edit',
  );
});

/* ─── AC2: a global-tier destination fans out globally (as PUT does) ──────── */

test('transfer: a global destination calls autoResyncOnEdit at the global tier', () => {
  assert.match(
    TRANSFER,
    /plan\.to\.tier === 'global'[\s\S]*?autoResyncOnEdit\(\s*destName\s*,\s*\{\s*tier:\s*'global'\s*\}\s*\)/,
    'a global-destination transfer must fan the resync out to every granting team, exactly as PUT /api/skills/:name does for a global edit',
  );
});

/* ─── The fan-out uses destName, not the requested name ───────────────────── */

test('transfer: the resync targets the landed destName, so a rename collision syncs the right name', () => {
  // Both call sites pass destName (the collision-resolved destination name),
  // never plan.name — a `rename` lands the content under a new name.
  const calls = TRANSFER.match(/autoResyncOnEdit\([^)]*\)/g) || [];
  assert.equal(calls.length, 2, 'exactly the two destination tiers (team, global) fan out');
  for (const call of calls) {
    assert.match(call, /autoResyncOnEdit\(\s*destName\b/, `must pass destName, not plan.name: ${call}`);
  }
});

/* ─── AC4/AC6: the fan-out is a side-effect only — it never gates the write ─ */

test('transfer: the fan-out runs AFTER the write, never before the 201 short-circuits it', () => {
  const writeAt = TRANSFER.indexOf('commitSkillWrite(');
  const firstFanout = TRANSFER.indexOf('autoResyncOnEdit(');
  assert.ok(writeAt > 0 && firstFanout > 0, 'both the write and the fan-out must be present');
  assert.ok(
    firstFanout > writeAt,
    'auto-resync must only fire once the copy has landed on disk (a rejected/failed transfer changes nothing)',
  );
});
