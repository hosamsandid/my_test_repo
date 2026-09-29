import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * WIP-transparency (PR3): the **Flow Control** nav entry is restored to the
 * sidebar. It had been removed under #2147 (pending a re-ship as a plugin,
 * #2145), but with admission control always on (the `AEE_POOLS_ENABLED` flag
 * removed), an operator needs a reachable view of what the WIP limit is
 * holding: which tickets are in flight, which dispatches are held, and the
 * Force-dispatch action. This reverses #2147's `flow-control-nav-removed`
 * guard — a feature test now, mutation-proved below.
 */

function read(rel) {
  return readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
}

// Comment-stripped, because this file's own explanatory comment names the very
// tokens ("Flow Control", "/flow-control") the assertions look for.
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const SHELL = stripComments(read('./Shell.jsx'));

test('the strip leaves real code standing (a whole-file eat would fake every pass)', () => {
  assert.equal(stripComments('// a comment\nconst A = 1;').trim(), 'const A = 1;');
  assert.match(SHELL, /NAV_GROUPS/, 'Shell.jsx lost its own code to the strip');
});

test('Shell.jsx declares the /flow-control nav item', () => {
  assert.ok(SHELL.includes("path: '/flow-control'"), 'the Flow Control nav entry must be present');
  assert.ok(/label:\s*'Flow Control'/.test(SHELL), 'the nav item must be labelled Flow Control');
});

test('each check actually fires if the entry is removed again', () => {
  const navGone = SHELL.replace(/\{ path: '\/flow-control',[^}]*\},\n\s*/, '');
  assert.notEqual(navGone, SHELL, 'the mutation must change the source');
  assert.ok(!navGone.includes("path: '/flow-control'"), 'the path check would catch a removal');
});
