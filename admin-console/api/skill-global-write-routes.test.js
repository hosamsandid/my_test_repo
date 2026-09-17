'use strict';

// #2307 — one permission rule for every path that writes into the global (or a
// team) skill pool: import, merge, create, edit. `skill-import.test.js` /
// `skill-merge.test.js` / `skill-transfer.test.js` prove the PERMISSION
// DECISION itself (requiredPoolWritePermission + the anyTeamAdmin branch of
// permitTransfer). What those unit tests cannot see is whether the actual
// api.js routes reach it — api.js boots listeners on require and cannot be
// exercised directly (#651), so its source is read, same technique as
// `skill-plugin-team-admin-routes.test.js` / `pool-control-routes.test.js`.
//
// The property under test for each route: it calls into the shared
// permission model (skillTransfer.permitTransfer / skillMerge.permitMerge)
// rather than a bespoke or missing check — AC18 calls out that
// `POST /api/skills/import` had no route-level test at all, which is how the
// stale System-Admin-only rule survived #2180 unnoticed.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const API_SRC = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');

/** Comments here quote the very ACs under test, so strip them first. */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

/** Slice one route's body out, bounded by the next `app.` registration, so a
 *  match elsewhere in the multi-thousand-line file cannot stand in for the
 *  gate that is actually missing from THIS route. */
function route(marker) {
  const start = API_SRC.indexOf(marker);
  assert.ok(start > 0, `route ${marker} not found — this guard needs re-pointing`);
  const end = API_SRC.indexOf('\napp.', start + 1);
  assert.ok(end > start, `could not find the end of route ${marker}`);
  return stripComments(API_SRC.slice(start, end));
}

/* ─── AC18: POST /api/skills/import is gated at all ──────────────────────── */

test('POST /api/skills/import: gated through the shared permission model, action "import"', () => {
  const src = route("app.post('/api/skills/import',");
  assert.match(src, /getScope\(req\)/, 'must resolve the caller scope');
  assert.match(src, /skillImport\.planImport\(/, 'must plan the import (tier/name/permission)');
  assert.match(src, /skillTransfer\.permitTransfer\(\s*plan\.permission/, 'must check the plan through the shared permit checker');
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/, 'must wire the any-team-admin capability so a global import can pass without System Admin');
  assert.match(src, /'import'\s*\)/, 'the action must be named "import" so a refusal never says "transfer"');
});

/* ─── POST /api/skills — previously had NO permission check at all ───────── */

test('POST /api/skills (create): gated on the shared pool-write permission, both tiers', () => {
  const src = route("app.post('/api/skills',");
  assert.match(src, /getScope\(req\)/);
  assert.match(src, /skillTransfer\.requiredPoolWritePermission\(/, 'must ask the shared engine for the tier permission');
  assert.match(src, /skillTransfer\.permitTransfer\(/);
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  assert.match(src, /'create'\s*,?\s*\)/, 'the action must be named "create"');
});

/* ─── PUT /api/skills/:name — previously had NO permission check at all ──── */

test('PUT /api/skills/:name (edit): gated on the shared pool-write permission, both tiers', () => {
  const src = route("app.put('/api/skills/:name',");
  assert.match(src, /getScope\(req\)/);
  assert.match(src, /skillTransfer\.requiredPoolWritePermission\(/);
  assert.match(src, /skillTransfer\.permitTransfer\(/);
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  assert.match(src, /'edit'\s*,?\s*\)/, 'the action must be named "edit"');
  // AC8: the agent tier stays read-only, wording unchanged — before the new gate.
  assert.match(src, /Agent skills are read-only from the registry\. Use the propagation flow to promote a skill to the pool\./);
});

/* ─── PUT /api/skills/:name/file — previously had NO permission check ────── */

test('PUT /api/skills/:name/file (edit): gated on the shared pool-write permission, both tiers', () => {
  const src = route("app.put('/api/skills/:name/file',");
  assert.match(src, /getScope\(req\)/);
  assert.match(src, /skillTransfer\.requiredPoolWritePermission\(/);
  assert.match(src, /skillTransfer\.permitTransfer\(/);
  assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  assert.match(src, /'edit'\s*,?\s*\)/);
  assert.match(src, /Agent skills are read-only from the registry\. Promote the skill to the pool to edit it\./);
});

/* ─── AC5: merge into a team target is unchanged; AC4: merge into global is
 * relaxed the same way as import/create/edit ─────────────────────────────── */

for (const marker of ["app.post('/api/skills/merge-draft',", "app.post('/api/skills/merge',"]) {
  test(`${marker} wires isTeamAdminOfAny into the shared merge permit checker`, () => {
    const src = route(marker);
    assert.match(src, /skillMerge\.permitMerge\(/);
    assert.match(src, /isTeamAdminOfAny:\s*\(\)\s*=>\s*isTeamAdminOfAny\(scope\)/);
  });
}

/* ─── AC9: deletion and move-out-of-global stay untouched (System-Admin-only,
 * unaffected by this ticket's relaxation) ─────────────────────────────────── */

test('DELETE /api/skills/:name: still uses the unmodified skillDeletion permit model (global stays System-Admin-only)', () => {
  const src = route("app.delete('/api/skills/:name',");
  assert.match(src, /skillDeletion\.permitDeletion\(/);
  assert.doesNotMatch(src, /anyTeamAdmin/, 'a delete must never gain the any-team-admin relaxation');
});
