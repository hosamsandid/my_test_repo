import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2708 "Remove this hand-off?" copy guard ────────────────────────────────
//
// The Edit hand-off → Delete… confirmation used to read "Delete listener
// trigger t1790815937966 on <agent>" — the auto-generated trigger ID means
// nothing to the user. It now describes the trigger by what it does and keeps
// the ID only as a tooltip. The admin-console-src job cannot render JSX (#651),
// so this pins the source text.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped first so the explanatory comment can't satisfy a matcher.
const dialogs = readFileSync(join(here, './EdgeDialogs.jsx'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '')
  .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

// The confirm block of EditLabelHandoff: from its heading to the emit checkbox.
function confirmBlock() {
  const start = dialogs.indexOf('Remove this hand-off?');
  assert.ok(start >= 0, 'confirm heading not found — this guard needs re-pointing');
  const end = dialogs.indexOf('setDelEmit(e.target.checked)', start);
  assert.ok(end > start, 'emit checkbox not found — this guard needs re-pointing');
  return dialogs.slice(start, end);
}

test('#2708: the listener checkbox describes the trigger by agent and label', () => {
  assert.match(confirmBlock(),
    /checked=\{delListener\}[^\n]*\/>\s*Delete the trigger that wakes \{toName \|\| to\} on label <code>\{label\}<\/code>\s*<\/label>/);
});

test('#2708: the raw trigger ID is a tooltip only, not checkbox text', () => {
  const block = confirmBlock();
  assert.match(block, /<label style=\{check\} title=\{`Trigger ID: \$\{triggerId\}`\}>\s*<input type="checkbox" checked=\{delListener\}/);
  assert.doesNotMatch(block, /<code>\{triggerId\}<\/code>/);
  assert.doesNotMatch(block, /listener trigger/);
});
