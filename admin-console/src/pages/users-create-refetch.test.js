import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #2135 AC8 — the create handler must refetch even when the request rejected.
//
// `POST /internal/admin/users` persists the record BEFORE its last steps, so a
// rejection can arrive for a user that already exists. With `refetch()` sitting
// after the `await` inside the `try`, a failure skipped it and left the operator
// with an error banner over a stale list — the symptom that made #2135 look like
// "nothing happened" when in fact the user had been created.
//
// `Users.jsx` is JSX, so `node --test` cannot import it (the #651 convention);
// this reads the source instead. Every assertion below was proved by mutation:
// moving `refetch()` back above the `catch` fires it.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = fs.readFileSync(path.join(HERE, 'Users.jsx'), 'utf8');

// Slice one `async function <name>(…) { … }` body by brace matching from the
// LAST brace on the signature line (a first-`{` scan would match a destructured
// parameter and close a few characters later, making every check vacuous).
function functionBody(name) {
  const at = SRC.indexOf(`async function ${name}(`);
  assert.notEqual(at, -1, `expected an async function ${name} in Users.jsx`);
  const lineEnd = SRC.indexOf('\n', at);
  const open = SRC.lastIndexOf('{', lineEnd);
  assert.ok(open > at, `could not find the opening brace of ${name}`);

  let depth = 0;
  for (let i = open; i < SRC.length; i += 1) {
    if (SRC[i] === '{') depth += 1;
    else if (SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return SRC.slice(open, i + 1);
    }
  }
  throw new Error(`unterminated body for ${name}`);
}

test('the slicer returns a real, non-trivial handler body', () => {
  // Anti-vacuity: a mis-sliced body would make every assertion below pass.
  const body = functionBody('handleCreate');
  assert.ok(body.length > 200, `handleCreate body looks truncated (${body.length} chars)`);
  assert.ok(body.includes("apiCall('POST', '/api/admin/users'"), 'expected the create request in the slice');
  assert.ok(body.includes('catch'), 'expected the error branch in the slice');
});

test('handleCreate refetches in `finally`, not only on the success path', () => {
  const body = functionBody('handleCreate');

  const catchAt = body.indexOf('catch (e)');
  const finallyAt = body.indexOf('finally');
  const refetchAt = body.indexOf('refetch()');

  assert.notEqual(catchAt, -1, 'handleCreate must still report the error');
  assert.notEqual(finallyAt, -1, 'handleCreate must still have a finally block');
  assert.notEqual(refetchAt, -1, 'handleCreate must still refresh the list');

  assert.ok(
    refetchAt > finallyAt,
    'refetch() must run in `finally` — after a failure the record may already exist, '
    + 'so refreshing only on success leaves the operator looking at a stale list',
  );
});

test('the dialog still closes only on success', () => {
  // The other half of the pair: closing in `finally` would hide the error the
  // operator has to read, so `closeCreate()` deliberately stays in the `try`.
  const body = functionBody('handleCreate');
  const closeAt = body.indexOf('closeCreate()');
  const catchAt = body.indexOf('catch (e)');

  assert.notEqual(closeAt, -1, 'handleCreate must still close the dialog on success');
  assert.ok(closeAt < catchAt, 'closeCreate() must stay on the success path');
});
