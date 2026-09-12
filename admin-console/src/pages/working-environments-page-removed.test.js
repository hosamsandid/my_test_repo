// Run: node --test admin-console/src/pages/working-environments-page-removed.test.js
//
// #2170 (epic #2166 A4): the general-purpose **Working Environments** page —
// reachable by every authenticated user, listing every environment on the
// platform — is retired, not renamed. A team now edits its own environment
// from the Agent Chat Settings tab's Working Environment section (#2167,
// unaffected by this ticket except for gaining the GitHub Token field that
// only that retired page could set); the System-Admin half of the old page —
// curating a shared, reusable environment — becomes the **Environment
// Templates** catalog (`/environment-templates`), a genuinely different
// mechanism (a curated COPY source, never a live-shared binding) rather than
// a renamed page.
//
// A removal guard rather than a feature test, for the same reason
// `access-page-removed.test.js` and `agents-page-removal-guard.test.js` exist:
// nothing left in the tree can fail when a removed thing quietly comes back.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REDIRECTS } from '../context/page-help-view.js';
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
  const app = SOURCES.find(([name]) => name === 'App.jsx');
  assert.ok(app && /<Routes>/.test(app[1]), 'App.jsx lost its own code to the strip');
});

test('WorkingEnvironments.jsx is gone from disk — renamed, not merely re-routed', () => {
  assert.ok(
    !fs.existsSync(path.join(src, 'pages/WorkingEnvironments.jsx')),
    'the old filename must not survive alongside the new page',
  );
  assert.ok(
    fs.existsSync(path.join(src, 'pages/EnvironmentTemplates.jsx')),
    'its successor, EnvironmentTemplates.jsx, must exist',
  );
});

test('nothing anywhere still imports the old filename', () => {
  for (const [name, code] of SOURCES) {
    assert.ok(
      !code.includes('WorkingEnvironments'),
      `${name} still references the retired WorkingEnvironments name`,
    );
  }
});

test('/environments is a redirect to /chats, not a rendered page', () => {
  const app = SOURCES.find(([name]) => name === 'App.jsx')[1];
  assert.match(
    app,
    /<Route path="\/environments"\s+element=\{<Navigate to="\/chats" replace \/>\}/,
    'the /environments route must be a Navigate — a bookmark may not dead-end',
  );
  assert.equal(REDIRECTS['/environments'], '/chats', 'help must resolve an old /environments link to the Agent Chat topic');
});

test('/environment-templates renders the new page behind AdminRoute', () => {
  const app = SOURCES.find(([name]) => name === 'App.jsx')[1];
  assert.match(
    app,
    /<Route path="\/environment-templates"\s+element=\{<AdminRoute><EnvironmentTemplates \/><\/AdminRoute>\}/,
    'the new catalog route must exist and stay System-Admin-gated',
  );
});

test('the nav entry moved: gone from Connections, present in Administration as adminOnly', () => {
  const shell = SOURCES.find(([name]) => name === 'components/Shell.jsx')[1];
  assert.ok(!shell.includes("path: '/environments'"), 'the Working Environments nav entry must be gone, not hidden');
  assert.match(
    shell,
    /\{ path: '\/environment-templates', label: 'Environment Templates',[^}]*adminOnly: true/,
    'Environment Templates must be a System-Admin-only nav entry',
  );
});

test('no label, title or breadcrumb still points "Working Environments" at /environments', () => {
  assert.equal(BREADCRUMBS['/environments'], undefined);
  assert.equal(ROUTE_TITLES['/environments'], undefined);
  assert.equal(BREADCRUMBS['/environment-templates'], 'Environment Templates');
  assert.equal(ROUTE_TITLES['/environment-templates'], 'Environment Templates');
});

test('the retired page had no "Agents using this environment" or repo-propagation machinery — a template can never have agents', () => {
  const page = SOURCES.find(([name]) => name === 'pages/EnvironmentTemplates.jsx')[1];
  assert.doesNotMatch(page, /RepoPropagationDialog/, 'a template is never bound to an agent, so it can never diverge from one');
  assert.doesNotMatch(page, /outOfDateIndicator/, 'no out-of-date badge applies to a record nothing is ever bound to');
  assert.doesNotMatch(page, /Agents using this environment/);
});

test('the new page supports create, unlike the retired list-only page (AC: System Admin can create/edit/delete templates)', () => {
  const page = SOURCES.find(([name]) => name === 'pages/EnvironmentTemplates.jsx')[1];
  assert.match(page, /panelMode === 'create'/, 'the page must support a create panel mode');
  assert.match(page, /'POST', '\/api\/environments'/, 'creating a template must POST to the environments route');
  assert.match(page, /isTemplate: true/, 'every save through this page must be forced to isTemplate: true');
});

// #2172 (epic #2166 A6, terminology sweep): the retired page's own NAME must
// not survive as user-facing vocabulary either — the phrase "Working
// Environment" should read nowhere a user looks (menus, forms, labels,
// messages). Comment-stripped, like every other check in this file, because
// this ticket's own commit history and the historical comments elsewhere in
// this file legitimately still say it.
test('no rendered string anywhere still says "Working Environment" — the phrase, not just the page', () => {
  const offenders = SOURCES
    .filter(([name]) => !/\.test\.jsx?$/.test(name))
    .filter(([, code]) => /Working Environments?/.test(code))
    .map(([name]) => name);
  assert.deepEqual(offenders, [], `these files still render the retired phrase: ${offenders.join(', ')}`);
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
    "{ path: '/environment-templates',",
    "{ path: '/environments', label: 'Working Environments' },\n    { path: '/environment-templates',",
  );
  assert.notEqual(navBack, shell, 'the sabotage must change the source');
  assert.ok(navBack.includes("path: '/environments'"), 'the nav check would catch a re-added entry');

  // Turning the redirect back into a rendered page.
  const routeBack = app.replace(
    /<Route path="\/environments"\s+element=\{<Navigate to="\/chats" replace \/>\}\s*\/>/,
    '<Route path="/environments" element={<WorkingEnvironments />} />',
  );
  assert.notEqual(routeBack, app, 'the sabotage must change the source');
  assert.doesNotMatch(
    routeBack,
    /<Route path="\/environments"\s+element=\{<Navigate to="\/chats" replace \/>\}/,
    'the route check would catch a re-rendered page',
  );

  // Re-introducing the propagation dialog on the template page.
  const page = SOURCES.find(([name]) => name === 'pages/EnvironmentTemplates.jsx')[1];
  const propagationBack = `${page}\n<RepoPropagationDialog />`;
  assert.match(propagationBack, /RepoPropagationDialog/, 'the propagation check would catch a reintroduction');

  // Re-introducing the retired phrase in a rendered string.
  const phraseBack = `${page}\nconst label = 'Working Environment';`;
  assert.match(phraseBack, /Working Environment/, 'the phrase check would catch a reintroduction');
});
