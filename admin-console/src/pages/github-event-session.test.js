import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTriggerCorrelationId,
  isSessionOutcome,
  findActiveSessionMatch,
  findFinishedSessionMatch,
  sessionLinkTarget,
  reapedInstanceNotice,
} from './github-event-session.js';

test('buildTriggerCorrelationId: composes the deterministic trigger:<t>:gh:<e> key', () => {
  assert.equal(
    buildTriggerCorrelationId('dev-2-on-issue', '11870476833'),
    'trigger:dev-2-on-issue:gh:11870476833',
  );
});

test('buildTriggerCorrelationId: null when either half is missing', () => {
  assert.equal(buildTriggerCorrelationId(null, 'e1'), null);
  assert.equal(buildTriggerCorrelationId('t1', null), null);
  assert.equal(buildTriggerCorrelationId('', 'e1'), null);
  assert.equal(buildTriggerCorrelationId('t1', ''), null);
  assert.equal(buildTriggerCorrelationId(undefined, undefined), null);
});

test('isSessionOutcome: only a delivered outcome carrying a triggerId is linkable', () => {
  assert.equal(isSessionOutcome({ status: 'delivered', triggerId: 't1' }), true);
});

test('isSessionOutcome: dropped / digest / no-triggerId outcomes are not linkable', () => {
  assert.equal(isSessionOutcome({ status: 'dropped', triggerId: 't1' }), false);
  assert.equal(isSessionOutcome({ status: 'digest', triggerId: 't1' }), false);
  assert.equal(isSessionOutcome({ status: 'delivered' }), false); // no triggerId
  assert.equal(isSessionOutcome({ status: 'delivered', triggerId: '' }), false);
  assert.equal(isSessionOutcome(null), false);
  assert.equal(isSessionOutcome(undefined), false);
});

test('findActiveSessionMatch: matches an active session by its single correlationId', () => {
  const sessions = [
    { id: 's1', correlationId: 'trigger:t1:gh:e1' },
    { id: 's2', correlationId: 'trigger:t2:gh:e2' },
  ];
  assert.equal(findActiveSessionMatch(sessions, 'trigger:t2:gh:e2')?.id, 's2');
  assert.equal(findActiveSessionMatch(sessions, 'trigger:tX:gh:eX'), null);
});

test('findActiveSessionMatch: safe on empty / non-array / null correlationId', () => {
  assert.equal(findActiveSessionMatch([], 'trigger:t1:gh:e1'), null);
  assert.equal(findActiveSessionMatch(null, 'trigger:t1:gh:e1'), null);
  assert.equal(findActiveSessionMatch([{ id: 's1', correlationId: 'x' }], null), null);
});

test('findFinishedSessionMatch: matches a finished group whose correlationIds set contains the key', () => {
  const history = [
    { id: 'g1', correlationIds: ['trigger:t1:gh:e1', 'msg:abc'] },
    { id: 'g2', correlationIds: ['trigger:t2:gh:e2'] },
  ];
  assert.equal(findFinishedSessionMatch(history, 'trigger:t1:gh:e1')?.id, 'g1');
  assert.equal(findFinishedSessionMatch(history, 'trigger:t2:gh:e2')?.id, 'g2');
  assert.equal(findFinishedSessionMatch(history, 'trigger:tX:gh:eX'), null);
});

test('findFinishedSessionMatch: safe when correlationIds is missing / not an array', () => {
  assert.equal(findFinishedSessionMatch([{ id: 'g1' }], 'trigger:t1:gh:e1'), null);
  assert.equal(findFinishedSessionMatch([{ id: 'g1', correlationIds: null }], 'trigger:t1:gh:e1'), null);
  assert.equal(findFinishedSessionMatch(null, 'trigger:t1:gh:e1'), null);
  assert.equal(findFinishedSessionMatch([{ id: 'g1', correlationIds: ['x'] }], null), null);
});

// ── #2596: the chip of a pooled delivery links the instance that ran it ───
test('sessionLinkTarget: a non-pooled delivery links its own agent, exactly as before (AC7)', () => {
  assert.deepEqual(
    sessionLinkTarget({ status: 'delivered', triggerId: 't1', agentId: 'dev' }),
    { kind: 'agent', agentId: 'dev' },
  );
});

test('sessionLinkTarget: a pooled delivery links the instance while it exists (AC4)', () => {
  const o = { status: 'delivered', triggerId: 't1', agentId: 'team-developer', instanceId: 'team-developer-i2562', instanceExists: true };
  assert.deepEqual(sessionLinkTarget(o), { kind: 'agent', agentId: 'team-developer-i2562' });
  // No existence flag (e.g. an unprojected row) never hides a working link.
  const { instanceExists, ...noFlag } = o;
  assert.deepEqual(sessionLinkTarget(noFlag), { kind: 'agent', agentId: 'team-developer-i2562' });
});

test('sessionLinkTarget: a reaped instance never silently falls back to the role (AC5)', () => {
  const t = sessionLinkTarget({
    status: 'delivered', triggerId: 't1', agentId: 'team-developer',
    instanceId: 'team-developer-i2562', instanceExists: false,
    instanceName: 'Developer · #2562', poolRoleName: 'Developer',
  });
  assert.deepEqual(t, { kind: 'reaped', instanceName: 'Developer · #2562', poolRoleId: 'team-developer', poolRoleName: 'Developer' });
  assert.match(reapedInstanceNotice(t), /^Developer · #2562 no longer exists/);
});

test('sessionLinkTarget: held / digest / dropped outcomes are not linkable (AC6)', () => {
  assert.equal(sessionLinkTarget({ status: 'held', reason: 'pool-paused', triggerId: 't1', agentId: 'r' }), null);
  assert.equal(sessionLinkTarget({ status: 'dropped', triggerId: 't1', agentId: 'r' }), null);
  assert.equal(sessionLinkTarget(null), null);
  assert.equal(reapedInstanceNotice({ kind: 'agent', agentId: 'x' }), null);
});
