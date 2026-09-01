import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  commandQuery,
  filterCommands,
  commandInsertion,
  nextIndex,
} from './command-palette.js';

const CMDS = [
  { command: 'cobol:build', name: 'build', namespace: 'cobol', invocation: '/cobol:build', description: 'Compile the program' },
  { command: 'deploy', name: 'deploy', namespace: null, invocation: '/deploy', description: null },
  { command: 'spec-kit:plan', name: 'plan', namespace: 'spec-kit', invocation: '/spec-kit:plan', description: 'Make a plan' },
];

test('commandQuery opens only for a whole-value leading /token', () => {
  assert.equal(commandQuery('/'), '');           // bare slash → open, empty query
  assert.equal(commandQuery('/spec'), 'spec');
  assert.equal(commandQuery('/spec-kit:plan'), 'spec-kit:plan');
  assert.equal(commandQuery(''), null);          // empty composer
  assert.equal(commandQuery('hello'), null);     // no slash
  assert.equal(commandQuery('hello /foo'), null);// slash mid-message (edge case)
  assert.equal(commandQuery('/plan arg'), null); // a space started the arguments
  assert.equal(commandQuery(' /plan'), null);    // leading whitespace is not first-char
  assert.equal(commandQuery(null), null);
});

test('filterCommands empty query returns the whole list unchanged', () => {
  assert.deepEqual(filterCommands(CMDS, ''), CMDS);
  assert.deepEqual(filterCommands(CMDS, null), CMDS);
});

test('filterCommands is case-insensitive and matches token/name/description', () => {
  assert.deepEqual(filterCommands(CMDS, 'PLAN').map((c) => c.command), ['spec-kit:plan']);
  assert.deepEqual(filterCommands(CMDS, 'cobol').map((c) => c.command), ['cobol:build']);
  // description-only match
  assert.deepEqual(filterCommands(CMDS, 'compile').map((c) => c.command), ['cobol:build']);
  // no match
  assert.deepEqual(filterCommands(CMDS, 'zzz'), []);
});

test('filterCommands ranks prefix matches above substring/description matches', () => {
  const cmds = [
    { command: 'x:plan', name: 'plan', invocation: '/x:plan', description: null },
    { command: 'planner', name: 'planner', invocation: '/planner', description: null },
    { command: 'other', name: 'other', invocation: '/other', description: 'has plan inside desc' },
  ];
  const out = filterCommands(cmds, 'plan').map((c) => c.command);
  // 'planner' (name prefix) and 'x:plan' (token substring / name prefix) beat the
  // description-only 'other'. 'planner' name-prefix and 'x:plan' name-prefix both
  // rank 0; 'other' is last.
  assert.equal(out[out.length - 1], 'other');
  assert.ok(out.includes('planner') && out.includes('x:plan'));
});

test('commandInsertion inserts the invocation + trailing space, caret at end', () => {
  assert.deepEqual(commandInsertion(CMDS[2]), { value: '/spec-kit:plan ', caret: '/spec-kit:plan '.length });
  assert.deepEqual(commandInsertion(CMDS[1]), { value: '/deploy ', caret: '/deploy '.length });
  // fallback when a row lacks an invocation
  assert.deepEqual(commandInsertion({ command: 'foo' }), { value: '/foo ', caret: '/foo '.length });
});

test('nextIndex wraps around and is safe on an empty list', () => {
  assert.equal(nextIndex(0, 1, 3), 1);
  assert.equal(nextIndex(2, 1, 3), 0);   // wrap forward
  assert.equal(nextIndex(0, -1, 3), 2);  // wrap backward
  assert.equal(nextIndex(1, -1, 3), 0);
  assert.equal(nextIndex(0, 1, 0), 0);   // empty list
  assert.equal(nextIndex(undefined, 1, 3), 1); // non-int current defaults to 0
});
