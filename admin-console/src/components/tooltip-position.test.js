import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveTooltipPlacement,
  clampTooltipLeft,
  tooltipAnchorTop,
} from './tooltip-position.js';

test('resolveTooltipPlacement: prefers top when it fits above', () => {
  const rect = { top: 200, bottom: 224 };
  assert.equal(resolveTooltipPlacement(rect, 24, 800), 'top');
});

test('resolveTooltipPlacement: flips to bottom when no room above but room below', () => {
  const rect = { top: 10, bottom: 34 };
  assert.equal(resolveTooltipPlacement(rect, 40, 800), 'bottom');
});

test('resolveTooltipPlacement: keeps top when neither side has room but top has more', () => {
  // trigger near the bottom of a short viewport: little room above, less below
  const rect = { top: 60, bottom: 90 };
  assert.equal(resolveTooltipPlacement(rect, 200, 100), 'top');
});

test('resolveTooltipPlacement: respects the top margin exactly', () => {
  // rect.top - gap - height === margin  → still fits above
  const rect = { top: 22, bottom: 46 }; // 22 - 6 - 8 === 8 === margin
  assert.equal(resolveTooltipPlacement(rect, 8, 800, 6, 8), 'top');
});

test('clampTooltipLeft: leaves a centred tooltip untouched', () => {
  assert.equal(clampTooltipLeft(500, 120, 1000), 500);
});

test('clampTooltipLeft: pushes a left-edge tooltip inward', () => {
  // centre 10, half-width 60 → left edge at -50; min centre = margin+half = 68
  assert.equal(clampTooltipLeft(10, 120, 1000, 8), 68);
});

test('clampTooltipLeft: pushes a right-edge tooltip inward', () => {
  // viewport 1000, half 60, margin 8 → max centre = 1000-8-60 = 932
  assert.equal(clampTooltipLeft(990, 120, 1000, 8), 932);
});

test('clampTooltipLeft: centres a tooltip wider than the viewport', () => {
  assert.equal(clampTooltipLeft(100, 900, 800, 8), 400);
});

test('tooltipAnchorTop: top placement anchors above the trigger', () => {
  assert.equal(tooltipAnchorTop({ top: 200, bottom: 224 }, 'top', 6), 194);
});

test('tooltipAnchorTop: bottom placement anchors below the trigger', () => {
  assert.equal(tooltipAnchorTop({ top: 200, bottom: 224 }, 'bottom', 6), 230);
});
