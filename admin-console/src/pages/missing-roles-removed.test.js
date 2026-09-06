import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the removal of the missing-roles suggestion's client side (#1959).
//
// The inference module and both of its consumer surfaces are gone. The pure
// menu descriptors are covered by their own tests; what those cannot see is the
// JSX that used to render the warning block and dispatch the add — so this
// reads the sources, the same drift-guard technique `rail-lifecycle-wiring.test.js`
// uses for the wiring the pure tests cannot load (#651).
//
// #1959 asserted this over the two surfaces that then existed. One of them, the
// Agents page, has since been removed outright (#1930) — its absence is guarded
// in `agents-page-removal-guard.test.js`, which subsumes every assertion this
// file used to make about it. The rail is the surviving surface and the only
// place the affordance could come back.
//
// This is a *deletion* guard: the risk it covers is a later change reviving the
// affordance piecemeal (a re-added import, a fetch of the full process-template
// bundles on a page that has nothing else to do with them) rather than a
// behaviour regression.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = rel => fs.readFileSync(path.join(HERE, rel), 'utf8');

/** Drop comments so a comment *naming* what was removed is not a false positive. */
function code(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('the inference module and its test are deleted', () => {
  for (const gone of ['missing-roles-view.js', 'missing-roles-view.test.js']) {
    assert.equal(fs.existsSync(path.join(HERE, gone)), false, `${gone} should be deleted`);
  }
});

test('no page imports the inference module or infers a missing role', () => {
  for (const rel of ['agent-chat/RailLifecycleHost.jsx']) {
    const src = code(read(rel));
    assert.ok(!src.includes('missing-roles-view'), `${rel} must not import the module`);
    assert.ok(!src.includes('inferMissingRoles'), `${rel} must not call inferMissingRoles`);
    assert.ok(!src.includes('missingRoles'), `${rel} must carry no missingRoles state or prop`);
    assert.ok(!src.includes('add-role'), `${rel} must dispatch no add-role key`);
  }
});

test('the surviving surface still fetches no process-template bundles', () => {
  // The bundles were fetched *only* to infer a source template. The slim list is
  // legitimately used elsewhere in the app, so the assertion is scoped to this
  // file rather than to the endpoint globally.
  for (const rel of ['agent-chat/RailLifecycleHost.jsx']) {
    assert.ok(
      !code(read(rel)).includes('/api/process-templates'),
      `${rel} should no longer read the process-template registry`,
    );
  }
});

test('the team menu descriptor no longer takes a missingRoles argument', () => {
  const src = code(read('agent-lifecycle/agent-lifecycle-menu.js'));
  assert.ok(!/missingRoles\s*=/.test(src), 'buildTeamMenu must not destructure missingRoles');
  assert.ok(!src.includes('add-role'), 'no add-role key may be emitted');
});

test('growing a team is still offered on the surviving surface', () => {
  // The point of the removal is that inference is gone, not that a team can no
  // longer gain a member — "Add member" is the explicit replacement (AC2).
  assert.ok(code(read('agent-lifecycle/agent-lifecycle-menu.js')).includes("key: 'add-member'"));
  assert.ok(code(read('agent-chat/RailLifecycleHost.jsx')).includes("case 'add-member'"));
});
