import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ADD_ROLE_MATERIALIZE_DEFAULT, ADD_ROLE_MATERIALIZE_HINT, ADD_ROLE_MATERIALIZE_LABEL,
  addRoleMaterializeBody, addRoleNotice, addRoleSubmitLabel,
} from './add-role-materialize.js';
import { MATERIALIZE_NOW_HINT, MATERIALIZE_NOW_LABEL } from '../agent-chat/add-member-view.js';

test('#2558 AC2: the checkbox defaults to OFF — an untouched dialog asks for a stub', () => {
  assert.equal(ADD_ROLE_MATERIALIZE_DEFAULT, false);
  assert.deepEqual(addRoleMaterializeBody(), { materialize: false });
  assert.deepEqual(addRoleMaterializeBody({ materializeNow: ADD_ROLE_MATERIALIZE_DEFAULT }), { materialize: false });
});

test('#2558 AC3/AC4: unchecked → stub, checked → materialize now', () => {
  assert.deepEqual(addRoleMaterializeBody({ materializeNow: false }), { materialize: false });
  assert.deepEqual(addRoleMaterializeBody({ materializeNow: true }), { materialize: true });
});

test('the key is always a boolean, and only an explicit `true` provisions', () => {
  for (const v of [undefined, null, 'x', 1, 0, '']) {
    const body = addRoleMaterializeBody({ materializeNow: v });
    assert.equal(typeof body.materialize, 'boolean');
    assert.equal(body.materialize, false, `${JSON.stringify(v)} must not provision`);
  }
});

test('#2558 AC1: label and hint are the rail "Add member" dialog\'s, so the two cannot drift', () => {
  assert.equal(ADD_ROLE_MATERIALIZE_LABEL, MATERIALIZE_NOW_LABEL);
  assert.equal(ADD_ROLE_MATERIALIZE_HINT, MATERIALIZE_NOW_HINT);
  assert.equal(ADD_ROLE_MATERIALIZE_LABEL, 'Materialize now');
  assert.match(ADD_ROLE_MATERIALIZE_HINT, /stub/);
  assert.match(ADD_ROLE_MATERIALIZE_HINT, /no clone/);
  assert.match(ADD_ROLE_MATERIALIZE_HINT, /Not materialized yet/);
});

test('submit label names the deferred mode on a live team only', () => {
  assert.equal(addRoleSubmitLabel({ live: true, materializeNow: false }), 'Add agent (stub)');
  assert.equal(addRoleSubmitLabel({ live: true, materializeNow: true }), 'Add agent');
  assert.equal(addRoleSubmitLabel({ live: true }), 'Add agent (stub)');
  // A draft role has nothing to provision — the label stays as it was.
  assert.equal(addRoleSubmitLabel({ live: false, materializeNow: false }), 'Add agent');
  assert.equal(addRoleSubmitLabel({ busy: true, live: true }), 'Adding…');
  assert.equal(addRoleSubmitLabel({ busy: true, live: false }), 'Adding…');
});

test('#2558 AC6: the notice reads the mode the SERVER reports, not the request', () => {
  const stub = addRoleNotice({ id: 't-dev', stub: true, materialized: false });
  assert.match(stub, /'t-dev' created as a stub/);
  assert.match(stub, /Not materialized yet/);
  // Materializing branch returns no `materialized` key → provisioned.
  const full = addRoleNotice({ id: 't-dev' });
  assert.match(full, /'t-dev' added and started/);
  assert.doesNotMatch(full, /stub/);
});
