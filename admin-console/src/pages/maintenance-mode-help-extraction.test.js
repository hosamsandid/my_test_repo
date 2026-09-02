import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── E13 (#1887, epic #1870) extraction drift guard ──────────────────────────
//
// MaintenanceMode.jsx's intro paragraph and its bordered "While active" box are
// gone; their content is the single-sourced help topic
// (api/helper-chat/help-topics/maintenance-mode.md, guarded for content by
// help-topics-content.test.js). This test reads the page source and asserts the
// *page side* of that move: the prose did not quietly grow back, and the two
// affordances that replaced it are still wired.
//
// The page's JSX is otherwise uncovered per the #651 convention — this is a
// source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));
const raw = readFileSync(join(here, 'MaintenanceMode.jsx'), 'utf8');

// Strip comments before asserting on the copy: this extraction's own explanatory
// comments name what moved to the topic ("the cron catch-up / event queuing /
// nothing-force-stopped bullets"), and would otherwise false-positive the very
// guard they belong to.
const src = raw
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('the "While active" box and its bullets are gone from the page', () => {
  assert.ok(!/While active/.test(src), 'the bordered "While active" heading must be gone');
  for (const phrase of [
    "won't fire",
    'exactly one catch-up run',
    'keep queuing and drain once you end it',
    "they aren't dropped",
    'wind-down window for sessions still in flight',
  ]) {
    assert.ok(
      !src.includes(phrase),
      `"${phrase}" belongs to help-topics/maintenance-mode.md, not to the page`,
    );
  }
});

test('the intro paragraph no longer re-states what the flag does or does not lock', () => {
  // The page keeps a one-line description; the "does not stop, restart, or lock
  // anything" claim moved to the topic — and was corrected there, because the
  // console *does* lock every chat composer while the flag is up (#502).
  assert.ok(
    !/does not stop, restart, or lock anything/.test(src),
    'the topic carries this claim (in a form that accounts for the chat lock)',
  );
  assert.ok(
    /Signals an upcoming platform restart/.test(src),
    'the page keeps its one-line description',
  );
});

test('the countdown note keeps only the rule that qualifies the live figure', () => {
  // Same rule as copy above a required input: the sentence that says what the
  // number on screen does NOT do stays; the list of what remains suppressed in
  // the meantime is the topic's job.
  assert.ok(
    /does not end maintenance mode on its own/.test(src),
    'the remaining-grace note must still say the countdown does not end the mode',
  );
  assert.ok(
    !/Scheduled triggers stay suppressed and events keep queuing/.test(src),
    'the suppression/queuing detail moved to the topic',
  );
});

test('both "?" affordances that replaced the removed copy are wired', () => {
  assert.ok(
    /^import PageHelpButton from '\.\.\/components\/PageHelpButton';$/m.test(raw),
    'the page must import the shared PageHelpButton',
  );
  const uses = src.match(/<PageHelpButton/g) || [];
  assert.equal(
    uses.length, 2,
    'one "?" next to the page description, one next to the Activate form '
    + '(where the removed "While active" box used to sit)',
  );
});
