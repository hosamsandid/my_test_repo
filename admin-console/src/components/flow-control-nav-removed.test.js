import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * #2147 (step 1 of 2, epic #2112): the **Flow Control** nav entry is removed
 * from the sidebar. The page, its route, its help and its backend all stay —
 * only `Shell.jsx`'s nav item and its now-dangling `LayoutDashboard` import go.
 * Step 2 is #2145 (re-ship the board as an installable, team-grantable plugin).
 *
 * A removal guard rather than a feature test, for the same reason
 * `access-page-removed.test.js` and `missing-roles-removed.test.js` exist:
 * nothing left in the tree can fail when a removed nav item quietly comes back
 * — this is mutation-proved below.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

// Comment-stripped, because this file's own explanatory comment names the
// very tokens ("Flow Control", "LayoutDashboard") the negative assertions
// look for.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const RAW_SHELL = read('./Shell.jsx');
const SHELL = stripComments(RAW_SHELL);

test('the strip leaves real code standing (a whole-file eat would fake every pass)', () => {
  assert.equal(stripComments("// a comment\nconst A = 1;").trim(), 'const A = 1;');
  assert.match(SHELL, /NAV_GROUPS/, 'Shell.jsx lost its own code to the strip');
});

test('Shell.jsx declares no /flow-control nav item', () => {
  assert.ok(!SHELL.includes("path: '/flow-control'"), 'the Flow Control nav entry must be gone, not hidden');
  assert.ok(!/label:\s*'Flow Control'/.test(SHELL), 'no nav item may still be labelled Flow Control');
});

test('Shell.jsx imports no LayoutDashboard icon', () => {
  assert.ok(!SHELL.includes('LayoutDashboard'), 'the icon was imported only for the removed entry');
});

/* ── the mutation proof ──────────────────────────────────────────────────
   Written over the raw source so it can be re-run against a sabotaged copy —
   without this the checks above would pass identically if they were vacuous. */

test('each check actually fires on a reintroduction', () => {
  const navBack = SHELL.replace(
    "{ path: '/role-templates',",
    "{ path: '/flow-control', label: 'Flow Control', Icon: LayoutDashboard },\n    { path: '/role-templates',",
  );
  assert.notEqual(navBack, SHELL, 'the sabotage must change the source');
  assert.ok(navBack.includes("path: '/flow-control'"), 'the nav check would catch a re-added entry');
  assert.ok(/label:\s*'Flow Control'/.test(navBack), 'the label check would catch a re-added entry');
  assert.ok(navBack.includes('LayoutDashboard'), 'the import check would catch a re-added icon usage');
});
