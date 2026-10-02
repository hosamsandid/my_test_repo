import test from 'node:test';
import assert from 'node:assert/strict';

import { teamOptionsWithCurrent, teamOptionsWithAssigned, unknownTeamLabel } from './environment-ownership-view.js';

// #2695: a <select> whose value matches no option shows the FIRST option; the
// current value must therefore always be one of the rendered options.

const opts = [{ id: 'agent-studio-2-0', name: 'Agent Studio 2.0' }, { id: 'ui-team', name: 'UI team' }];

test('teamOptionsWithCurrent keeps the list when the value is offered or empty', () => {
  assert.deepEqual(teamOptionsWithCurrent(opts, 'ui-team'), opts);
  assert.deepEqual(teamOptionsWithCurrent(opts, ''), opts);
  assert.deepEqual(teamOptionsWithCurrent(opts, undefined), opts);
});

test('teamOptionsWithCurrent renders an unknown current value as its own marked option', () => {
  const out = teamOptionsWithCurrent(opts, 'default');
  assert.equal(out.length, 3);
  assert.deepEqual(out[2], { id: 'default', name: unknownTeamLabel('default'), unknown: true });
  assert.match(out[2].name, /^default \(not an Agent Team\)$/);
  // Every value the select can hold has an option with that exact value.
  assert.ok(out.some(o => o.id === 'default'));
  // Tolerates junk input.
  assert.deepEqual(teamOptionsWithCurrent(null, 'x'), [{ id: 'x', name: unknownTeamLabel('x'), unknown: true }]);
});

test('teamOptionsWithAssigned surfaces every assigned id the list does not offer, once', () => {
  const out = teamOptionsWithAssigned(opts, ['ui-team', 'default', 'gone', 'default']);
  assert.deepEqual(out.map(o => o.id), ['agent-studio-2-0', 'ui-team', 'default', 'gone']);
  assert.deepEqual(teamOptionsWithAssigned(opts, undefined), opts);
});
