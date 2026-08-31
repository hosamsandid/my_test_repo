import { test } from 'node:test';
import assert from 'node:assert/strict';
import { focusTrapTarget, backdropDismisses } from './modal-view.js';

test('forward Tab off the last element wraps to the first', () => {
  assert.equal(focusTrapTarget(2, 3, false), 0);
});

test('forward Tab in the middle lets the browser handle it (null)', () => {
  assert.equal(focusTrapTarget(0, 3, false), null);
  assert.equal(focusTrapTarget(1, 3, false), null);
});

test('backward Shift+Tab off the first element wraps to the last', () => {
  assert.equal(focusTrapTarget(0, 3, true), 2);
});

test('backward Shift+Tab in the middle/end lets the browser handle it (null)', () => {
  assert.equal(focusTrapTarget(2, 3, true), null);
  assert.equal(focusTrapTarget(1, 3, true), null);
});

test('focus outside the list (index -1) is pulled back inside', () => {
  assert.equal(focusTrapTarget(-1, 3, false), 0); // Tab -> first
  assert.equal(focusTrapTarget(-1, 3, true), 2);  // Shift+Tab -> last
});

test('a single focusable always wraps back to itself', () => {
  assert.equal(focusTrapTarget(0, 1, false), 0);
  assert.equal(focusTrapTarget(0, 1, true), 0);
});

test('no focusables yields null (nothing to trap)', () => {
  assert.equal(focusTrapTarget(-1, 0, false), null);
  assert.equal(focusTrapTarget(-1, 0, true), null);
});

test('backdrop dismisses only when press starts AND ends on the overlay', () => {
  assert.equal(backdropDismisses(true, true), true);
  assert.equal(backdropDismisses(true, false), false); // drag out from the card
  assert.equal(backdropDismisses(false, true), false); // drag in onto the backdrop
  assert.equal(backdropDismisses(false, false), false);
});
