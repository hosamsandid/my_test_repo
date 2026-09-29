import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideComposerAction } from './composer-action.js';

test('idle with text and enabled composer → Send, enabled (AC1)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: false, canStop: true, hasText: true, disabled: false, stopBusy: false }),
    { mode: 'send', enabled: true },
  );
});

test('idle with no text → Send, disabled', () => {
  assert.deepEqual(
    decideComposerAction({ busy: false, canStop: true, hasText: false, disabled: false, stopBusy: false }),
    { mode: 'send', enabled: false },
  );
});

test('idle with a disabled composer → Send, disabled even with text', () => {
  assert.deepEqual(
    decideComposerAction({ busy: false, canStop: true, hasText: true, disabled: true, stopBusy: false }),
    { mode: 'send', enabled: false },
  );
});

test('busy turn/loop with stop wired → Stop, enabled (AC2)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: true, canStop: true, hasText: false, disabled: false, stopBusy: false }),
    { mode: 'stop', enabled: true },
  );
});

test('busy but a stop is already in flight → Stop, disabled (no double-abort)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: true, canStop: true, hasText: false, disabled: false, stopBusy: true }),
    { mode: 'stop', enabled: false },
  );
});

test('Stop ignores the composer disabled state — abortable mid-turn (AC3)', () => {
  // While a turn runs the composer is typically disabled (sending); Stop must
  // stay clickable regardless.
  assert.deepEqual(
    decideComposerAction({ busy: true, canStop: true, hasText: false, disabled: true, stopBusy: false }),
    { mode: 'stop', enabled: true },
  );
});

test('busy but no stop handler wired → stays Send (never a dead Stop)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: true, canStop: false, hasText: true, disabled: false, stopBusy: false }),
    { mode: 'send', enabled: true },
  );
});

test('typed text while busy does not turn Stop into Send', () => {
  // A user may type the next message while the agent is still working; the
  // primary action remains Stop until the turn ends.
  assert.equal(
    decideComposerAction({ busy: true, canStop: true, hasText: true, disabled: false, stopBusy: false }).mode,
    'stop',
  );
});

test('missing/partial input object does not throw → Send, disabled', () => {
  assert.deepEqual(decideComposerAction(), { mode: 'send', enabled: false });
  assert.deepEqual(decideComposerAction({}), { mode: 'send', enabled: false });
});

test('idle with text but an attachment still uploading → Send, disabled (#2567 AC11)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: false, canStop: true, hasText: true, disabled: false, stopBusy: false, uploading: true }),
    { mode: 'send', enabled: false },
  );
});

test('busy while uploading → Stop stays available (upload gates Send only)', () => {
  assert.deepEqual(
    decideComposerAction({ busy: true, canStop: true, hasText: true, disabled: false, stopBusy: false, uploading: true }),
    { mode: 'stop', enabled: true },
  );
});
