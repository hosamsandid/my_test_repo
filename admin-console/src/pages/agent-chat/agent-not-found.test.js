import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  agentNotFoundState,
  agentNotFoundFrom,
  agentNotFoundCopy,
  MAX_ECHOED_ID_LENGTH,
} from './agent-not-found.js';

test('agentNotFoundState/agentNotFoundFrom round-trip the requested id', () => {
  assert.equal(agentNotFoundFrom(agentNotFoundState('uitest-does-not-exist')), 'uitest-does-not-exist');
});

test('agentNotFoundFrom: any other router state means no notice', () => {
  for (const s of [null, undefined, 'x', 42, {}, { revealAgentId: 'acme-dev' },
    { agentNotFoundId: '' }, { agentNotFoundId: 7 }, { agentNotFoundId: null }]) {
    assert.equal(agentNotFoundFrom(s), null, JSON.stringify(s));
  }
});

test('agentNotFoundCopy names the id and offers another pick', () => {
  const c = agentNotFoundCopy('uitest-does-not-exist');
  assert.equal(c.title, 'Agent "uitest-does-not-exist" not found');
  assert.match(c.hint, /Pick another agent/);
});

test('agentNotFoundCopy does not reveal whether an inaccessible agent exists', () => {
  const c = agentNotFoundCopy('other-team-dev');
  // One wording for both cases: "deleted" and "no access" are both offered.
  assert.match(c.hint, /deleted/);
  assert.match(c.hint, /don't have access/);
});

test('agentNotFoundCopy truncates an overlong id', () => {
  const long = 'a'.repeat(MAX_ECHOED_ID_LENGTH + 50);
  const c = agentNotFoundCopy(long);
  assert.equal(c.title, `Agent "${'a'.repeat(MAX_ECHOED_ID_LENGTH)}…" not found`);
  assert.equal(agentNotFoundCopy('a'.repeat(MAX_ECHOED_ID_LENGTH)).title.includes('…'), false);
});
