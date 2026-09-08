// Run: node --test admin-console/src/pages/access-create-removed.test.js
//
// #2081 AC3, client half: creating an access scope from the Access page is
// retired, not hidden. `POST /api/admin/teams` answers 410, so a form still
// wired to it would be a button that fails — the form is deleted.
//
// A removal guard rather than a feature test, for the same reason
// `missing-roles-removed.test.js` and `bp-removal-guard.test.js` exist: nothing
// left in the tree can fail when a removed thing quietly comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const TEAMS = fs.readFileSync(path.join(here, 'Teams.jsx'), 'utf8');

// Comment-stripped, because the note left where the form used to be names the
// very route and component the negative assertions look for.
const CODE = TEAMS
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

test('nothing on the Access page POSTs to the retired scope-create route', () => {
  assert.doesNotMatch(CODE, /apiCall\(\s*'POST'\s*,\s*'\/api\/admin\/teams'/);
  assert.ok(TEAMS.includes("'/api/admin/teams'"), 'the LIST read is unaffected and must stay');
});

test('the create form, its trigger and its state are gone', () => {
  for (const gone of ['CreateTeamForm', 'setCreating', 'savingCreate', 'setCreateError', 'New Team']) {
    assert.ok(!CODE.includes(gone), `'${gone}' should have gone with the create form`);
  }
});

test('the empty state no longer points at a button that does not exist', () => {
  assert.doesNotMatch(CODE, /Click 'New Team'/);
  assert.match(CODE, /emptyText="[^"]*\+ Create[^"]*"/, 'it should point at the real creation path');
});

test('managing an existing scope is untouched — only minting a new one is closed', () => {
  // The read/rename/delete verbs still back the Access page and the team
  // dropdowns until the P5 successor retires `teams/index.json` (concept A3.3).
  assert.match(CODE, /apiCall\('PUT', `\/api\/admin\/teams\//);
  assert.match(CODE, /apiCall\('DELETE', `\/api\/admin\/teams\//);
  assert.match(CODE, /apiCall\('POST', '\/api\/admin\/memberships'/);
});

test('a membership refusal reaches the user rather than being swallowed', () => {
  // The D4 hand-over (#2081 AC4) is enforced server-side and its 409 message is
  // the whole instruction ("name a successor…"), so the panel showing
  // `e.message` IS the UI for it. If these handlers ever stop reporting the
  // error, a refused removal becomes a silently no-op button.
  for (const fn of ['setRole', 'removeMember']) {
    const at = CODE.indexOf(`async function ${fn}(`);
    assert.notEqual(at, -1, `${fn} not found`);
    assert.match(CODE.slice(at, at + 400), /catch \(e\) \{ onError\(e\.message\); \}/, `${fn} must surface the refusal`);
  }
});
