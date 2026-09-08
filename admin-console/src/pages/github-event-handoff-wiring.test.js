import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Source-reading drift guard (#651) over the direct-hand-off slice of the
// GitHub Event Log page (#2032). `GithubEventLog.jsx` cannot be imported here
// (JSX + React), and the pure decisions it calls are covered by
// `github-event-handoff-view.test.js` — what is left, and what this file
// pins, is that the page actually CALLS them. Each failure mode below is
// silent: the row renders, it just renders as the dashes it always did.
const src = fs.readFileSync(path.join(import.meta.dirname, 'GithubEventLog.jsx'), 'utf8');

test('the page imports the hand-off view helpers from the pure module', () => {
  assert.match(
    src,
    /import \{ isHandoffRow, handoffNote, handoffNoteDisplay, handoffTitleHint \} from '\.\/github-event-handoff-view'/,
  );
});

test("the producer's note reaches the row key the Title column filters on", () => {
  // DataTable filters and sorts by `row[col.key]`, not by rendered cell, so a
  // note rendered only inside the cell would be invisible to the text filter.
  // Anchored on the whole assignment rather than a character window before it.
  const line = src.split('\n').find(l => l.includes('workItemTitle:'));
  assert.ok(line, 'the rows projection still flattens a workItemTitle key');
  assert.match(line, /isHandoffRow\(e\)/);
  assert.match(line, /handoffNote\(e\)/);
  assert.match(line, /e\.workItem \? e\.workItem\.title : null/,
    'a work-item row keeps its own title');
});

test('the Title cell is told when its content is a note, not a title', () => {
  assert.match(src, /hint=\{handoffTitleHint\(row\)\}/);
  // The cell shows a FOLDED note (a note may be 1024 code points and the column
  // wraps) while the hover carries it whole — so nothing is hidden, and one
  // hand-off cannot turn into a twenty-line table row.
  assert.match(src, /title=\{handoffNoteDisplay\(row\) \|\| v\} hover=\{v\}/);
  // ...and TitleCell must actually USE it: an unused prop would leave a note
  // hovering as if it were a PR title.
  const cell = src.slice(src.indexOf('function TitleCell'));
  const body = cell.slice(0, cell.indexOf('\n}'));
  assert.match(body, /hint \?/, 'TitleCell branches on the hint');
  assert.match(body, /const full = hover \|\| title/,
    'the hover falls back to the rendered title, so a work-item row is unchanged');
  assert.match(body, /title=\{/, 'and still sets a hover title');
});

test('the Event column stays on the shared eventLabel helper', () => {
  // `handoff.wake` reads as "direct hand-off" only because eventLabel is the
  // single source of truth for event wording — a local map here would drift
  // from the trigger editor's.
  assert.match(src, /import \{ eventLabel \} from '\.\/agent-chat\/trigger-summary'/);
  assert.match(src, /const friendly = eventLabel\(v\)/);
  assert.doesNotMatch(src, /'handoff\.wake'/,
    'the page must not hard-code the event key — the pure module owns it');
});

test('the pending-queue section renders the kind through the shared view helpers', () => {
  // The `wake-agent` kind label/tooltip/detail live in pending-queue-view.js;
  // this is what keeps the queue row from reading "An unrecognised queue entry".
  //
  // Asserted by NAME, not as a fixed import line: a guard pinned to the exact
  // brace list breaks on the next ticket that imports one more helper from the
  // same module — which is precisely what #2102 (Reassign to…) did — and that
  // failure says nothing about hand-off rendering. Parse the brace list and
  // check only the names this guard is actually about.
  const m = src.match(/import\s*\{([^}]*)\}\s*from\s*'\.\/pending-queue-view'/);
  assert.ok(m, 'the page must import its queue-row helpers from pending-queue-view');
  const imported = new Set(m[1].split(',').map(s => s.trim()).filter(Boolean));
  for (const name of ['kindLabel', 'kindTooltip', 'entryDetail', 'totalPending']) {
    assert.ok(imported.has(name), `the page must import ${name} from pending-queue-view`);
  }
});
