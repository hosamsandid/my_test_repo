import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  STICK_TO_BOTTOM_THRESHOLD_PX,
  distanceFromBottom,
  isAtBottom,
  isNearTop,
} from './chat-scroll.js';

test('threshold constant is the documented 100 px', () => {
  assert.equal(STICK_TO_BOTTOM_THRESHOLD_PX, 100);
});

test('distanceFromBottom reports content still below the fold', () => {
  // 1000 tall, viewport 400, scrolled to 200 -> 400 px still below
  assert.equal(distanceFromBottom({ scrollHeight: 1000, scrollTop: 200, clientHeight: 400 }), 400);
  // exactly at the bottom
  assert.equal(distanceFromBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 }), 0);
});

test('distanceFromBottom never returns a negative (over-scroll / rubber-band)', () => {
  // scrollHeight can momentarily be smaller than scrollTop+clientHeight while
  // off-screen estimates collapse during the settle; clamp so callers do not
  // see a spurious "past the bottom" distance.
  assert.equal(distanceFromBottom({ scrollHeight: 900, scrollTop: 600, clientHeight: 400 }), 0);
});

test('isAtBottom is true within the threshold, false beyond it', () => {
  // 50 px below the fold -> at bottom
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 550, clientHeight: 400 }), true);
  // exactly 100 px below -> NOT at bottom (strict <, semantics preserved)
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 }), false);
  // far up
  assert.equal(isAtBottom({ scrollHeight: 5000, scrollTop: 0, clientHeight: 400 }), false);
});

test('isAtBottom on a list shorter than the viewport is always true', () => {
  // no scrolling possible -> distance 0 -> at bottom, so no spurious pill
  assert.equal(isAtBottom({ scrollHeight: 200, scrollTop: 0, clientHeight: 400 }), true);
});

test('isAtBottom honours a custom threshold', () => {
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 550, clientHeight: 400 }, 40), false);
  assert.equal(isAtBottom({ scrollHeight: 1000, scrollTop: 580, clientHeight: 400 }, 40), true);
});

test('isNearTop mirrors the same threshold at the top edge', () => {
  assert.equal(isNearTop({ scrollTop: 50 }), true);
  assert.equal(isNearTop({ scrollTop: 100 }), false); // strict <, matches old `scrollTop < 100`
  assert.equal(isNearTop({ scrollTop: 0 }), true);
  assert.equal(isNearTop({ scrollTop: 30 }, 20), false);
});
