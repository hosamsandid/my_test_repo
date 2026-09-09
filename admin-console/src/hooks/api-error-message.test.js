import test from 'node:test';
import assert from 'node:assert/strict';

import {
  isEngineErrorMessage,
  apiErrorMessage,
  GENERIC_SERVER_ERROR,
} from './api-error-message.js';

test('the message that started #2135 is recognised as an engine error', () => {
  assert.equal(isEngineErrorMessage('orchestrator is not defined'), true);
});

test('every engine-error shape that reaches a handler is recognised', () => {
  for (const m of [
    'orchestrator is not defined',
    'teamsStore.createUser is not a function',
    "Cannot read properties of undefined (reading 'adminClient')",
    "Cannot read property 'id' of null",
    "Cannot access 'created' before initialization",
    'Assignment to constant variable.',
    'Unexpected token } in JSON at position 12',
    'x is not iterable',
    'Foo is not a constructor',
  ]) {
    assert.equal(isEngineErrorMessage(m), true, `expected an engine error: ${m}`);
  }
});

test('a human sentence is never mistaken for one', () => {
  // These are the messages the console relies on being shown verbatim. The
  // third and fourth are the trap: they contain the engine vocabulary but are
  // written for a person, so the pattern is anchored rather than a substring.
  for (const m of [
    "Team 'payments' still owns 3 agents",
    'Removing the last admin requires a successor',
    'The environment is not defined for this agent — pick one first',
    'A repository URL is not a function of the branch name',
    'user_store_unavailable',
    '',
    '   ',
  ]) {
    assert.equal(isEngineErrorMessage(m), false, `expected a human message: ${m}`);
  }
});

test('a non-string is not an engine error', () => {
  for (const v of [null, undefined, 0, {}, [], NaN]) {
    assert.equal(isEngineErrorMessage(v), false);
  }
});

test('a 500 carrying an engine error is rewritten, and keeps the technical string', () => {
  const { message, technicalMessage } = apiErrorMessage(500, 'orchestrator is not defined');
  assert.equal(message, GENERIC_SERVER_ERROR);
  assert.equal(technicalMessage, 'orchestrator is not defined');
  assert.equal(
    message.includes('orchestrator'),
    false,
    'the raw identifier must not survive into what the operator reads',
  );
});

test('a 500 with a human message is left exactly as the server wrote it', () => {
  const { message, technicalMessage } = apiErrorMessage(500, "Team 'payments' still owns 3 agents");
  assert.equal(message, "Team 'payments' still owns 3 agents");
  assert.equal(technicalMessage, null);
});

test('a 4xx is never rewritten, engine-shaped or not', () => {
  // A 409 from the store IS the instruction (the D4 hand-over), and a 4xx is by
  // definition about the request rather than an internal fault.
  for (const status of [400, 401, 403, 404, 409, 424]) {
    const { message, technicalMessage } = apiErrorMessage(status, 'orchestrator is not defined');
    assert.equal(message, 'orchestrator is not defined');
    assert.equal(technicalMessage, null);
  }
});

test('a missing body still falls back to the bare status, as before', () => {
  assert.deepEqual(apiErrorMessage(502, null), { message: 'HTTP 502', technicalMessage: null });
  assert.deepEqual(apiErrorMessage(404, null), { message: 'HTTP 404', technicalMessage: null });
});
