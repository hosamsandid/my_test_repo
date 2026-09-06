import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #1956 shared create form (AC3/AC5).
 *
 * AC5 is a *structural* claim — one module serves `/create` and, while it
 * existed, the Agents page — and structure is precisely what a pure test cannot
 * see: `Create.jsx` and `AgentCreateForm.jsx` are JSX, which `node --test` does
 * not load (#651). A second, forked copy of the form would leave
 * `agent-create-submit-state.test.js` and every other pure test green while the
 * two surfaces quietly diverged — which is the exact failure the Agents-page
 * removal depended on not having happened.
 *
 * #1930 has since removed that second surface, and the removal is guarded in
 * `agents-page-removal-guard.test.js`. What survives here is AC5's durable
 * half: the launcher hosts the ONE shared form and sends the ONE request
 * through the ONE gate — the properties that made the page droppable, and the
 * ones a future second caller will depend on again.
 *
 * Same source-reading shape as `rail-lifecycle-wiring.test.js`: wiring only,
 * never copy, so a reworded label or restyled button is free to change.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Tolerant on purpose: a missing file is a finding this guard should REPORT
// (see the first assertion), not a module-load crash that takes the whole file
// down before a single test names what is wrong.
function read(rel) {
  try { return fs.readFileSync(path.join(HERE, rel), 'utf8'); } catch { return ''; }
}

// Comments are stripped first so a comment *naming* a symbol can't stand in for
// the code that should be there. The `(^|[^:])` guard protects `https://` in a
// URL from being eaten as a line comment (the `missing-roles-removed.js`
// variant — these files carry route strings).
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

const create = code(read('./Create.jsx'));
const form = code(read('./agent-lifecycle/AgentCreateForm.jsx'));

test('the create form lives in one shared module (AC5)', () => {
  assert.ok(form, 'agent-lifecycle/AgentCreateForm.jsx exists');
  assert.match(form, /export default function AgentCreateForm/);
  // The launcher imports that module rather than defining a form of its own.
  assert.match(
    create,
    /import AgentCreateForm from '\.{1,2}(\/pages)?\/agent-lifecycle\/AgentCreateForm\.jsx'/,
    'Create.jsx imports the shared form',
  );
  assert.doesNotMatch(create, /function AgentCreateForm/, 'Create.jsx defines no second copy');
});

test('the role picker stays inside the form module (AC5)', () => {
  // `RoleCard` is only ever used by this form. A copy in the host page is a
  // fork waiting to be edited on one side only — which is what happened while
  // the Agents page rendered its own inline create form.
  assert.match(form, /function RoleCard/);
  assert.doesNotMatch(create, /function RoleCard/);
  assert.doesNotMatch(create, /<RoleCard/);
});

test('the request goes through the one gate, from the form itself (AC3)', () => {
  // The gate: one pure module decides submittability for whoever renders it —
  // so a host page cannot re-derive "is this submittable" and drift.
  assert.match(form, /describeAgentSubmitState\(form\)/);
  assert.doesNotMatch(create, /describeAgentSubmitState/);
  // The request: the raw form object, POSTed by the shared module. Hoisting it
  // into the host is AC3's "same result as today" quietly failing.
  assert.match(create, /apiCall\('POST', '\/api\/agents', form\)/, 'Create.jsx POSTs the raw form');
});

test('the launcher hosts the form behind its own entry, not a new route (AC3)', () => {
  // The panel is a state of `/create`, decided by the pure helper — so the
  // header's `New Agent` can hand over to plain `/create` and still land here.
  assert.match(create, /isSingleAgentFormOpen\(searchParams\)/);
  assert.match(create, /<AgentCreateForm/);
  // Success has to go somewhere: a create form that leaves the user on the
  // launcher with no feedback is the dead end this AC is about.
  assert.match(create, /navigate\(createdAgentDestination\(/);
});
