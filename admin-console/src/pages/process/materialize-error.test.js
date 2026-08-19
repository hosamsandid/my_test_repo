import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeMaterializeError } from './materialize-error.js';

// Helper: shape an error the way `apiCall` throws it.
function apiError({ status, serverMessage } = {}) {
  const e = new Error(serverMessage || (status ? `HTTP ${status}` : 'Failed to fetch'));
  if (status != null) e.status = status;
  if (serverMessage) e.serverMessage = serverMessage;
  return e;
}

test('5xx gateway error with no JSON body → human-readable message, status only as detail (AC1, AC4)', () => {
  const { message, detail } = describeMaterializeError(apiError({ status: 502 }), { action: 'create the team' });
  assert.doesNotMatch(message, /^HTTP 502$/);
  assert.match(message, /server could not create the team/i);
  assert.match(message, /try again in a moment/i);
  // The bare status is NOT the primary message; it survives as secondary detail.
  assert.equal(detail, 'HTTP 502');
  assert.doesNotMatch(message, /502/);
});

test('503/504 are treated the same as 502 (any 5xx)', () => {
  for (const status of [500, 503, 504]) {
    const { message, detail } = describeMaterializeError(apiError({ status }));
    assert.match(message, /server could not/i);
    assert.equal(detail, `HTTP ${status}`);
  }
});

test('structured JSON error body is shown as-is, no regression (AC2)', () => {
  const { message, detail } = describeMaterializeError(
    apiError({ status: 409, serverMessage: 'Team "billing" already exists.' }),
  );
  assert.equal(message, 'Team "billing" already exists.');
  // Server-provided messages are trusted and left undecorated.
  assert.equal(detail, null);
});

test('a 5xx WITH a structured body still shows the body, not the generic 5xx text', () => {
  const { message } = describeMaterializeError(
    apiError({ status: 500, serverMessage: 'Repository clone failed: authentication required.' }),
  );
  assert.equal(message, 'Repository clone failed: authentication required.');
});

test('network failure / no status → reachability message, never undefined (AC5, edge: timeout)', () => {
  const { message, detail } = describeMaterializeError(apiError({}), { action: 'create the team' });
  assert.match(message, /could not reach the server/i);
  assert.match(message, /try again/i);
  assert.equal(detail, null);
  assert.doesNotMatch(message, /undefined/);
});

test('4xx with no JSON body → readable message with status inline (edge: no error field)', () => {
  const { message, detail } = describeMaterializeError(apiError({ status: 404 }));
  assert.match(message, /rejected by the server \(HTTP 404\)/);
  assert.equal(detail, null);
  assert.doesNotMatch(message, /undefined/);
});

test('the three client-distinguishable classes produce distinct messages (AC5)', () => {
  const network = describeMaterializeError(apiError({})).message;
  const server = describeMaterializeError(apiError({ status: 502 })).message;
  const validation = describeMaterializeError(apiError({ status: 400, serverMessage: 'Invalid slug.' })).message;
  assert.notEqual(network, server);
  assert.notEqual(server, validation);
  assert.notEqual(network, validation);
});

test('action noun is woven into the generated messages', () => {
  assert.match(describeMaterializeError(apiError({ status: 502 }), { action: 'load working environments' }).message, /load working environments/);
  assert.match(describeMaterializeError(apiError({}), { action: 'load working environments' }).message, /load working environments/);
});

test('default action noun when none supplied → no "undefined"', () => {
  const { message } = describeMaterializeError(apiError({ status: 502 }));
  assert.doesNotMatch(message, /undefined/);
  assert.match(message, /complete the request/);
});

test('a JSON body without an error field (serverMessage absent) does not surface undefined', () => {
  // apiCall leaves serverMessage undefined when the parsed body has no error/message.
  const e = new Error('HTTP 500');
  e.status = 500;
  const { message } = describeMaterializeError(e);
  assert.doesNotMatch(message, /undefined/);
  assert.match(message, /server could not/i);
});

test('an empty/whitespace serverMessage is ignored (falls through to status class)', () => {
  const e = new Error('HTTP 500');
  e.status = 500;
  e.serverMessage = '   ';
  const { message } = describeMaterializeError(e);
  assert.match(message, /server could not/i);
});
