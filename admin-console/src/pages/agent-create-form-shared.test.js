import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Drift guard for the #1956 shared create form (AC3/AC5).
 *
 * AC5 is a *structural* claim — one module serves `/create` and, while it
 * exists, the Agents page — and structure is precisely what a pure test cannot
 * see: `Agents.jsx`, `Create.jsx` and `AgentCreateForm.jsx` are JSX, which
 * `node --test` does not load (#651). A second, forked copy of the form would
 * leave `agent-create-submit-state.test.js` and every other pure test green
 * while the two surfaces quietly diverged — which is the exact failure the
 * Agents-page removal depends on not happening.
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

const agents = code(read('./Agents.jsx'));
const create = code(read('./Create.jsx'));
const form = code(read('./agent-lifecycle/AgentCreateForm.jsx'));

test('the create form lives in one shared module (AC5)', () => {
  assert.ok(form, 'agent-lifecycle/AgentCreateForm.jsx exists');
  assert.match(form, /export default function AgentCreateForm/);
  // Both surfaces import that module rather than defining a form of their own.
  for (const [name, src] of [['Agents.jsx', agents], ['Create.jsx', create]]) {
    assert.match(
      src,
      /import AgentCreateForm from '\.{1,2}(\/pages)?\/agent-lifecycle\/AgentCreateForm\.jsx'/,
      `${name} imports the shared form`,
    );
    assert.doesNotMatch(src, /function AgentCreateForm/, `${name} defines no second copy`);
  }
});

test('the role picker moved with the form and was not left behind (AC5)', () => {
  // `RoleCard` was only ever used by this form. A copy left on the Agents page
  // is a fork waiting to be edited on one side only.
  assert.match(form, /function RoleCard/);
  assert.doesNotMatch(agents, /function RoleCard/);
  assert.doesNotMatch(agents, /<RoleCard/);
});

test('both surfaces send the same request through the same gate (AC3)', () => {
  // The gate: one pure module decides submittability for whoever renders it.
  assert.match(form, /describeAgentSubmitState\(form\)/);
  assert.doesNotMatch(agents, /describeAgentSubmitState/);
  assert.doesNotMatch(create, /describeAgentSubmitState/);
  // The request: the raw form object, POSTed to the same endpoint on both
  // sides. A divergence here is AC3's "same result as today" quietly failing.
  for (const [name, src] of [['Agents.jsx', agents], ['Create.jsx', create]]) {
    assert.match(src, /apiCall\('POST', '\/api\/agents', form\)/, `${name} POSTs the raw form`);
  }
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
