import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveDismissHandler, backdropDismisses, escapeDismisses } from './confirm-dialog-view.js';

test('confirm dialog dismisses as CANCEL (the safe, non-destructive default)', () => {
  const onCancel = () => 'cancelled';
  const onConfirm = () => 'confirmed';
  const h = resolveDismissHandler({ alertOnly: false, onConfirm, onCancel });
  assert.equal(h, onCancel);
  assert.equal(h(), 'cancelled');
});

test('alert (OK-only) dismisses as ACKNOWLEDGE via onConfirm', () => {
  const onConfirm = () => 'ok';
  const h = resolveDismissHandler({ alertOnly: true, onConfirm });
  assert.equal(h, onConfirm);
  assert.equal(h(), 'ok');
});

test('alert with only onCancel wired falls back to it', () => {
  const onCancel = () => 'x';
  assert.equal(resolveDismissHandler({ alertOnly: true, onCancel }), onCancel);
});

test('missing handler resolves to null (never called with undefined)', () => {
  assert.equal(resolveDismissHandler({ alertOnly: false }), null);
  assert.equal(resolveDismissHandler({ alertOnly: true }), null);
  assert.equal(resolveDismissHandler(), null);
});

test('backdrop dismisses only when press and release both landed on the overlay', () => {
  assert.equal(backdropDismisses({ pressedOverlay: true, releasedOverlay: true }), true);
  // press started inside the card (e.g. text selection) then released on backdrop
  assert.equal(backdropDismisses({ pressedOverlay: false, releasedOverlay: true }), false);
  // released on the card
  assert.equal(backdropDismisses({ pressedOverlay: true, releasedOverlay: false }), false);
  assert.equal(backdropDismisses({}), false);
});

test('backdrop never dismisses while an async action is in flight', () => {
  assert.equal(backdropDismisses({ pressedOverlay: true, releasedOverlay: true, busy: true }), false);
});

test('Escape dismisses unless busy (mirrors the disabled buttons)', () => {
  assert.equal(escapeDismisses({ busy: false }), true);
  assert.equal(escapeDismisses({}), true);
  assert.equal(escapeDismisses({ busy: true }), false);
});
