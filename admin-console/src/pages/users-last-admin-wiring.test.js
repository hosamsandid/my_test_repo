import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Source-reading drift guard (the #651 convention) for the client mirror of the
// "the last System Admin cannot be deleted or demoted" refusal (#2059 AC7).
//
// The rule itself and the two sentences are unit-tested in `users-view.test.js`
// (including a two-sided check against the store's own constants). What cannot
// be reached from a pure test is whether `Users.jsx` actually WIRES the guard to
// the two controls it exists to gate — so that is asserted over the source.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.join(HERE, 'Users.jsx'), 'utf8');

// Index of `needle`, asserted present. A bare indexOf would make the ordering
// assertions below trivially true via `-1 < anything`.
function at(needle, from = 0) {
  const i = page.indexOf(needle, from);
  assert.ok(i > -1, `Users.jsx must contain ${JSON.stringify(needle)}`);
  return i;
}

test('the page imports the mirror rather than restating the rule', () => {
  assert.match(page, /lastSystemAdminGuard/, 'the pure guard is used');
  assert.match(page, /from '\.\/users-view'/);
  // The refusal sentences live in one place. A literal here would be a second
  // copy that could drift from the 409 the server actually throws.
  assert.ok(!page.includes('cannot be deleted —'), 'the reason text is not inlined in the page');
  assert.ok(!page.includes('cannot be demoted —'), 'the reason text is not inlined in the page');
  // ...and the rule is not re-derived locally either.
  assert.ok(!/filter\([^)]*systemAdmin/.test(page), 'the page does not count System Admins itself');
});

test('Delete is disabled with the store\'s reason, on the row action', () => {
  // The whole `IconButton` call for Delete, sliced to the matching `/>` at
  // brace depth 0 — `onClick={() => …}` contains a `>`, so scanning to the
  // first `>` would cut the element short.
  const start = at('icon={Trash2}');
  const call = sliceElement(start);

  assert.match(call, /disabled=\{!deleteGuardFor\([^)]*\)\.ok\}/, 'disabled comes from the guard');
  assert.match(call, /title=\{deleteGuardFor\([^)]*\)\.reason/, 'the reason is the tooltip');
  assert.match(call, /\|\| 'Delete user'/, 'and falls back to the ordinary label when allowed');
});

test('the System-Admin checkbox is locked for the last System Admin', () => {
  const field = page.slice(at('function SysAdminField('), at('/* ── Create-user form'));
  assert.match(field, /disabled=\{!!lockedReason\}/, 'the input itself is disabled');
  assert.match(field, /\{lockedReason\}/, 'the reason is rendered as visible text, not only a tooltip');
  assert.match(field, /title=\{lockedReason \|\| undefined\}/);

  // The edit panel passes it from the guard, asked about 'demote' — asking
  // about 'delete' there would lock the box with the wrong sentence.
  const usage = page.slice(at('<SysAdminField'), at('{lockoutWarn &&'));
  assert.match(usage, /lockedReason=\{demoteGuard\.ok \? null : demoteGuard\.reason\}/);
  assert.match(page, /lastSystemAdminGuard\(\{ users, target: user, action: 'demote' \}\)/);
});

test('the two guards stay separate: advisory self-warning vs blocking estate rule', () => {
  // Both are live in the edit panel. `selfActionWarning` must NOT gate the
  // control (it is about your own account and is deliberately non-blocking),
  // and the estate rule must not be downgraded to a warning.
  assert.match(page, /selfActionWarning\(/, 'the self-lockout warning survives');
  assert.match(page, /<WarnNote>\{lockoutWarn\}<\/WarnNote>/);
  // The `canSave` EXPRESSION itself, not a window around it: the declarations
  // of both guards sit within a few lines, so any slice wide enough to be
  // convenient would contain the identifiers this asserts are absent — and
  // pass for the wrong reason. (Anchored inside EditUserPanel because
  // CreateUserPanel above it declares a `canSave` of its own.)
  const editPanel = at('function EditUserPanel(');
  const canSaveExpr = page.slice(at('const canSave =', editPanel)).split('\n')[0];
  assert.match(canSaveExpr, /!validation && !saving/, 'the expression is what it looks like');
  assert.ok(!canSaveExpr.includes('lockoutWarn'), 'the self-warning never disables Save');
  assert.ok(!canSaveExpr.includes('demoteGuard'), 'nor does the estate rule — it gates the checkbox');
});

test('the delete guard is declared before the column renderers that call it', () => {
  // `deleteGuardFor` is a `const` arrow, so a declaration after `COLUMNS`
  // relies on the renderer running later — true today, and a trap for the next
  // edit that moves a call out of a callback.
  assert.ok(at('const deleteGuardFor =') < at('const COLUMNS = ['));
});

test('the server stays the authority: a refusal is still rendered verbatim', () => {
  // The mirror is UX. If a request is made anyway (stale list, another admin
  // demoted in parallel), the 409's message must still reach the user.
  assert.match(page, /catch \(e\) \{ setActionError\(e\.message\); setDeleteTarget\(null\); \}/);
  assert.match(page, /catch \(e\) \{ setEditError\(e\.message\); \}/);
});

// Slice a self-closing JSX element starting at `from`, scanning to the `/>`
// that closes it at brace depth 0.
function sliceElement(from) {
  let depth = 0;
  for (let i = from; i < page.length; i++) {
    const c = page[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (depth === 0 && c === '/' && page[i + 1] === '>') return page.slice(from, i + 2);
  }
  assert.fail('unterminated JSX element');
  return '';
}
