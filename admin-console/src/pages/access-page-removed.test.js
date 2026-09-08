// Run: node --test admin-console/src/pages/access-page-removed.test.js
//
// #2085 (epic #2076 P6, AC1/AC4, concept D10): the **Access** page is dissolved,
// not renamed. `Teams.jsx` and its `ManageTeamPanel` are deleted (the Share
// dialog, #2082, superseded them), `/teams` is a redirect, and the nav entry is
// gone. A removal guard rather than a feature test, for the same reason
// `agents-page-removal-guard.test.js` and `missing-roles-removed.test.js` exist:
// nothing left in the tree can fail when a removed thing quietly comes back.
//
// It replaces `access-create-removed.test.js` (#2081 AC3), whose whole premise
// was the file this ticket deletes. Its one substantive assertion — that no
// client code POSTs to the retired scope-create route — is carried over below
// and widened from that one page to the whole `src/` tree, which is strictly
// stronger. Its D4-refusal half moved with the surface: the Share panel relays
// the store's 409 verbatim and `team-share-view` covers that.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDIRECTS, CONTEXT_KEYS } from '../context/page-help-view.js';
import { BREADCRUMBS } from '../components/breadcrumbs.js';
import { ROUTE_TITLES } from '../route-title.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(here, '..');

// Comment-stripped, because this ticket's own comments name the very page,
// route and component the negative assertions look for.
function strip(text) {
  return text
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(js|jsx)$/.test(entry.name) && !/\.test\.jsx?$/.test(entry.name)) out.push(full);
  }
  return out;
}

const SOURCES = walk(src).map(file => [path.relative(src, file), strip(fs.readFileSync(file, 'utf8'))]);

test('the strip leaves real code standing (a whole-file eat would fake every pass)', () => {
  assert.equal(strip("// a comment\nconst A = 1;").trim(), 'const A = 1;');
  assert.match(strip("const u = 'https://x/y';"), /https:\/\/x\/y/);
  const app = SOURCES.find(([name]) => name === 'App.jsx');
  assert.ok(app && /<Routes>/.test(app[1]), 'App.jsx lost its own code to the strip');
});

test('the page and its retired modules are gone from disk', () => {
  for (const gone of [
    'pages/Teams.jsx',
    'pages/teams-ownership.js',
    'pages/teams-ownership.test.js',
    'pages/access-help-sections.js',
    'pages/access-help-extraction.test.js',
  ]) {
    assert.ok(!fs.existsSync(path.join(src, gone)), `${gone} must be deleted, not merely unrendered`);
  }
});

test('nothing imports the deleted page or its modules', () => {
  for (const [name, code] of SOURCES) {
    for (const gone of ['./Teams', 'teams-ownership', 'access-help-sections', 'ACCESS_HELP_SECTIONS']) {
      assert.ok(!code.includes(gone), `${name} still references '${gone}'`);
    }
  }
});

test('ManageTeamPanel is deleted — the Share dialog superseded it (D10)', () => {
  for (const [name, code] of SOURCES) {
    assert.ok(
      !/\bManageTeamPanel\b/.test(code),
      `${name} still renders ManageTeamPanel; #2082's Share panel is the member surface now`,
    );
  }
});

test('/teams is a redirect to the Administration surface, not a rendered page', () => {
  const app = SOURCES.find(([name]) => name === 'App.jsx')[1];
  assert.match(
    app,
    /<Route path="\/teams"\s+element=\{<Navigate to="\/users" replace \/>\}/,
    'the /teams route must be a Navigate — a bookmark may not dead-end (edge case 2)',
  );
  assert.equal(REDIRECTS['/teams'], '/users', 'help must resolve an old /teams link to the new topic');
});

test('the nav entry is removed and the survivor is relabelled Administration (AC2)', () => {
  const shell = SOURCES.find(([name]) => name === 'components/Shell.jsx')[1];
  assert.ok(!shell.includes("path: '/teams'"), 'the Access nav entry must be gone, not hidden');
  assert.match(
    shell,
    /\{ path: '\/users',\s+label: 'Administration',[^}]*adminOnly: true/,
    'the one surviving entry must be labelled Administration and stay System-Admin-only',
  );
  // The icon that only ever served the removed entry goes with it, or it is an
  // unused import that reads as a surface still being there.
  assert.ok(!shell.includes('Building2'), 'prune the now-unused lucide icon');
});

test('no label, title or breadcrumb still says "Access" for a route (AC4)', () => {
  assert.equal(BREADCRUMBS['/teams'], undefined);
  assert.equal(ROUTE_TITLES['/teams'], undefined);
  assert.equal(BREADCRUMBS['/users'], 'Administration');
  assert.equal(ROUTE_TITLES['/users'], 'Administration');
  for (const map of [BREADCRUMBS, ROUTE_TITLES]) {
    assert.ok(!Object.values(map).includes('Access'), 'no route may still be labelled "Access"');
  }
});

test('the Manage-panel overlay key retires with the panel', () => {
  assert.ok(!CONTEXT_KEYS['modal:team-manage'], 'a key for a deleted surface is dead weight');
  // Its replacement is the All Teams delete confirmation — a ConfirmDialog at
  // 9999, so it needs the panelZIndex lift for the same reason user-delete does.
  assert.ok(CONTEXT_KEYS['modal:team-delete'], 'the delete-team confirmation must publish a subject');
  assert.ok(!CONTEXT_KEYS['modal:team-delete'].alias, 'it falls through to /users, claiming no topic');
});

test('nothing anywhere in src POSTs to the retired scope-create route (#2081 AC3)', () => {
  // Carried over from access-create-removed.test.js and widened from one page to
  // the tree: `POST /api/admin/teams` answers 410, so any caller is a button
  // that fails.
  for (const [name, code] of SOURCES) {
    assert.doesNotMatch(
      code,
      /apiCall\(\s*'POST'\s*,\s*'\/api\/admin\/teams'/,
      `${name} POSTs to the retired scope-create route`,
    );
  }
});

test('the scope LIST read survives — it still backs the Resources tab and five dropdowns', () => {
  // A3.3 has not retired `teams/index.json` yet, so removing the read would be
  // a different (and premature) change.
  const admin = SOURCES.find(([name]) => name === 'pages/Users.jsx')[1];
  assert.match(admin, /useApi\('\/api\/admin\/teams'\)/);
});

/* ── the mutation proof ──────────────────────────────────────────────────
   Every check above is written over a source string, so each can be re-run
   against a sabotaged copy. Without this the suite would pass identically if
   the assertions were vacuous. */

test('each source-reading check actually fires on a reintroduction', () => {
  const shell = SOURCES.find(([name]) => name === 'components/Shell.jsx')[1];
  const app = SOURCES.find(([name]) => name === 'App.jsx')[1];

  // Re-adding the nav entry.
  const navBack = shell.replace(
    "{ path: '/users',",
    "{ path: '/teams', label: 'Access' },\n    { path: '/users',",
  );
  assert.notEqual(navBack, shell, 'the sabotage must change the source');
  assert.ok(navBack.includes("path: '/teams'"), 'the nav check would catch a re-added entry');

  // Turning the redirect back into a rendered page.
  const routeBack = app.replace(
    /<Route path="\/teams"\s+element=\{<Navigate to="\/users" replace \/>\}\s*\/>/,
    '<Route path="/teams" element={<Teams />} />',
  );
  assert.notEqual(routeBack, app, 'the sabotage must change the source');
  assert.doesNotMatch(
    routeBack,
    /<Route path="\/teams"\s+element=\{<Navigate to="\/users" replace \/>\}/,
    'the route check would catch a re-rendered page',
  );

  // Re-introducing the panel.
  const panelBack = `${shell}\nfunction ManageTeamPanel() { return null; }`;
  assert.match(panelBack, /\bManageTeamPanel\b/, 'the panel check would catch a reintroduction');

  // Re-introducing a create call.
  const createBack = "await apiCall('POST', '/api/admin/teams', body);";
  assert.match(
    createBack,
    /apiCall\(\s*'POST'\s*,\s*'\/api\/admin\/teams'/,
    'the create-route check would catch a caller coming back',
  );
});
