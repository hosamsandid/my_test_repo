import test from 'node:test';
import assert from 'node:assert/strict';

import { RESUME_MESSAGE, canResumeSession, resumeNeedsConfirm } from './resume-session.js';

test('RESUME_MESSAGE: fixed, non-empty, neutral predefined message', () => {
  assert.equal(typeof RESUME_MESSAGE, 'string');
  assert.ok(RESUME_MESSAGE.trim().length > 0);
});

test('canResumeSession: a finished DM session with a real session-ID is resumable', () => {
  assert.equal(canResumeSession({ type: 'dm', sessionId: 'abc-123' }), true);
});

test('canResumeSession: a DM fallback entry without a session-ID is not resumable', () => {
  // correlationId-keyed fallback (early-error run) — sessionId is null.
  assert.equal(canResumeSession({ type: 'dm', sessionId: null }), false);
  assert.equal(canResumeSession({ type: 'dm' }), false);
  assert.equal(canResumeSession({ type: 'dm', sessionId: '' }), false);
});

test('canResumeSession: non-DM sessions (trigger/handover/unknown) are not resumable', () => {
  assert.equal(canResumeSession({ type: 'trigger', sessionId: 'abc-123' }), false);
  assert.equal(canResumeSession({ type: 'handover', sessionId: 'abc-123' }), false);
  assert.equal(canResumeSession({ type: 'unknown', sessionId: 'abc-123' }), false);
});

test('canResumeSession: malformed input is safe', () => {
  assert.equal(canResumeSession(null), false);
  assert.equal(canResumeSession(undefined), false);
  assert.equal(canResumeSession({}), false);
  assert.equal(canResumeSession({ type: 'dm', sessionId: 42 }), false);
});

test('resumeNeedsConfirm: an active session in the room requires confirmation', () => {
  assert.equal(resumeNeedsConfirm([{ id: 's1' }]), true);
});

test('resumeNeedsConfirm: no active session ⇒ no confirmation', () => {
  assert.equal(resumeNeedsConfirm([]), false);
  assert.equal(resumeNeedsConfirm(null), false);
  assert.equal(resumeNeedsConfirm(undefined), false);
});
