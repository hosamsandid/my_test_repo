'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

const { buildAgentStatus } = require('./agent-statuses');

describe('buildAgentStatus', () => {
  it('reports a disabled agent regardless of running/status inputs', () => {
    const s = buildAgentStatus({
      id: 'a', cfg: { enabled: false, displayName: 'Alpha' },
      running: true, status: { state: 'busy', lastResponseAt: 5 },
      dmRoom: { roomId: 'r' }, sessionFileExists: true,
    });
    assert.deepEqual(s, { id: 'a', displayName: 'Alpha', activityState: 'disabled', hasSession: false });
  });

  it('reports offline when the container is not running', () => {
    const s = buildAgentStatus({ id: 'b', cfg: {}, running: false });
    assert.deepEqual(s, { id: 'b', displayName: 'b', activityState: 'offline', hasSession: false });
  });

  it('falls back to the id when no displayName is set', () => {
    const s = buildAgentStatus({ id: 'no-name', cfg: {}, running: false });
    assert.equal(s.displayName, 'no-name');
  });

  it('maps a busy status.json to activityState busy', () => {
    const s = buildAgentStatus({
      id: 'c', cfg: { displayName: 'Cee' }, running: true,
      status: { state: 'busy', lastResponseAt: 123 }, dmRoom: null, sessionFileExists: false,
    });
    assert.equal(s.activityState, 'busy');
    assert.equal(s.lastResponseAt, 123);
    assert.equal(s.hasSession, false);
  });

  it('defaults a running agent with no/unknown state to idle and null lastResponseAt', () => {
    const s = buildAgentStatus({ id: 'd', cfg: {}, running: true, status: null });
    assert.equal(s.activityState, 'idle');
    assert.equal(s.lastResponseAt, null);
  });

  it('hasSession requires both a dm room and the session-pointer file', () => {
    const base = { id: 'e', cfg: {}, running: true, status: { state: 'idle' } };
    assert.equal(buildAgentStatus({ ...base, dmRoom: { roomId: 'r' }, sessionFileExists: true }).hasSession, true);
    assert.equal(buildAgentStatus({ ...base, dmRoom: { roomId: 'r' }, sessionFileExists: false }).hasSession, false);
    assert.equal(buildAgentStatus({ ...base, dmRoom: null, sessionFileExists: true }).hasSession, false);
    assert.equal(buildAgentStatus({ ...base, dmRoom: {}, sessionFileExists: true }).hasSession, false);
  });
});
