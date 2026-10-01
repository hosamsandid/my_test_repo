'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { locateCorrelationId } = require('./session-locate');

test('locateCorrelationId: an agent reply resolves via its message.posted row', () => {
  const events = [
    { type: 'message.received', correlationId: '$user1' },
    { type: 'trigger.fired', correlationId: 'trigger:t1:gh:e1' },
    { type: 'message.posted', correlationId: 'trigger:t1:gh:e1', eventId: '$reply' },
  ];
  assert.equal(locateCorrelationId(events, '$reply'), 'trigger:t1:gh:e1');
});

test('locateCorrelationId: a reply posted after an unrelated user message keeps its own run', () => {
  // The client-side "previous user message" guess would say $user2 here.
  const events = [
    { type: 'trigger.fired', correlationId: 'trigger:t1:100' },
    { type: 'message.received', correlationId: '$user2' },
    { type: 'message.posted', correlationId: 'trigger:t1:100', eventId: '$reply' },
  ];
  assert.equal(locateCorrelationId(events, '$reply'), 'trigger:t1:100');
});

test('locateCorrelationId: a user message resolves to itself when its rows exist', () => {
  const events = [{ type: 'message.received', correlationId: '$user1' }];
  assert.equal(locateCorrelationId(events, '$user1'), '$user1');
});

test('locateCorrelationId: null when the log has no row for the message', () => {
  const events = [
    { type: 'message.received', correlationId: '$user1' },
    { type: 'message.posted', correlationId: '$user1', eventId: '$reply1' },
  ];
  assert.equal(locateCorrelationId(events, '$gone'), null);
  assert.equal(locateCorrelationId([], '$user1'), null);
});

test('locateCorrelationId: ignores malformed rows and input', () => {
  const events = [
    null,
    'garbage',
    { type: 'message.posted', eventId: '$reply' }, // no correlationId
    { type: 'message.posted', correlationId: '', eventId: '$reply' },
  ];
  assert.equal(locateCorrelationId(events, '$reply'), null);
  assert.equal(locateCorrelationId(null, '$reply'), null);
  assert.equal(locateCorrelationId(events, ''), null);
  assert.equal(locateCorrelationId(events, null), null);
});
