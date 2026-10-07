import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  OUTCOME_EDGE_COLOR, OUTCOME_EDGE_LEGEND, WEBHOOK_EDGE_COLOR,
  LEGEND_BOTTOM_OFFSET, LEGEND_GAP, legendReserve, fitTransform,
} from './flow-legend.js';
import { PREVIEW_AMBER } from './drag-preview-anchor.js';
import { WAKE_EDGE_COLOR } from './wake-edge-view.js';

const RENDER = new URL('./flow-graph-render.js', import.meta.url);
// Strip comments so prose that names a colour or key cannot satisfy a guard.
const renderSource = () => readFileSync(RENDER, 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/(^|\s)\/\/.*$/gm, '$1');

// ── AC1: the outcome edge colour has a legend entry, and no hue is shared ────

test('the outcome edge keeps the amber of the ◇ switch badge and outcome ports', () => {
  assert.equal(OUTCOME_EDGE_COLOR, '#eab308');
  assert.equal(OUTCOME_EDGE_COLOR, PREVIEW_AMBER, 'drag preview of an outcome port stays the same amber');
  assert.equal(OUTCOME_EDGE_LEGEND, 'outcome → label');
});

test('webhook no longer shares the outcome amber, nor any other edge hue', () => {
  assert.notEqual(WEBHOOK_EDGE_COLOR, OUTCOME_EDGE_COLOR);
  const others = {
    label: '#3b82f6', outcome: OUTCOME_EDGE_COLOR, artifact: '#22c55e', dependency: '#ef4444',
    gate: '#dc2626', handoff: '#e11d48', review: '#f59e0b', event: '#f97316',
    timer: '#0ea5e9', loop: '#d946ef', pr: '#8b5cf6', issue: '#14b8a6', wake: WAKE_EDGE_COLOR,
  };
  for (const [name, hex] of Object.entries(others)) {
    assert.notEqual(WEBHOOK_EDGE_COLOR, hex, `webhook must not collide with ${name}`);
  }
});

test('EDGE_STYLES has an `outcome` entry and webhook reads its new hue (drift guard, #651)', () => {
  const src = renderSource();
  assert.match(src, /outcome:\s*\{\s*color:\s*OUTCOME_EDGE_COLOR,\s*label:\s*OUTCOME_EDGE_LEGEND\s*\}/);
  assert.doesNotMatch(src, /outcome:\s*\{[^}]*dashed/, 'outcome edges are drawn solid, so the key is solid');
  assert.match(src, /webhook:\s*\{\s*color:\s*WEBHOOK_EDGE_COLOR,/);
  // No second, local definition of the outcome colour that could drift.
  assert.doesNotMatch(src, /const OUTCOME_EDGE_COLOR\s*=/);
});

test('the fixed legend key list shows `outcome`, and every listed hue is unique', () => {
  const src = renderSource();
  const keys = src.match(/const keys = \[([^\]]*)\]/);
  assert.ok(keys, 'the legend key list is still a fixed array');
  const order = keys[1].split(',').map(s => s.trim().replace(/'/g, ''));
  assert.ok(order.includes('outcome'), 'an outcome edge draws with a legend entry');
  assert.ok(order.includes('webhook'));
});

// ── AC2: Fit reserves the band the legend covers ─────────────────────────────

test('legendReserve: legend height plus its offset and a gap; nothing when not laid out', () => {
  assert.equal(legendReserve(30, 800), 30 + LEGEND_BOTTOM_OFFSET + LEGEND_GAP);
  assert.equal(legendReserve(0, 800), 0);
  assert.equal(legendReserve(undefined, 800), 0);
  assert.equal(legendReserve(NaN, 800), 0);
});

test('legendReserve is capped at half the viewport', () => {
  assert.equal(legendReserve(500, 400), 200);
  assert.equal(legendReserve(500, 0), 0);
});

test('fitTransform without a reserve reproduces the old Fit maths', () => {
  const bounds = { minX: 0, minY: 0, maxX: 900, maxY: 500 };
  const t = fitTransform({ bounds, vw: 1000, vh: 600 });
  const zoom = Math.min(1000 / 1000, 600 / 600, 1.5);
  assert.equal(t.zoom, zoom);
  assert.equal(t.panX, (1000 - 1000 * zoom) / 2 + 50 * zoom);
  assert.equal(t.panY, (600 - 600 * zoom) / 2 + 50 * zoom);
});

test('with a reserve, the fitted content ends above the legend', () => {
  const bounds = { minX: 0, minY: 0, maxX: 900, maxY: 500 };
  const vh = 600;
  const reserveBottom = legendReserve(60, vh);
  const t = fitTransform({ bounds, vw: 1000, vh, reserveBottom });
  const contentBottom = t.panY + bounds.maxY * t.zoom;
  assert.ok(contentBottom <= vh - reserveBottom, `content bottom ${contentBottom} must clear the legend`);
  const contentTop = t.panY + bounds.minY * t.zoom;
  assert.ok(contentTop >= 0, 'and still starts inside the viewport');
});

test('a short, wide graph is not shrunk by the reserve when width is the limit', () => {
  const bounds = { minX: 0, minY: 0, maxX: 1900, maxY: 100 };
  const a = fitTransform({ bounds, vw: 1000, vh: 800 });
  const b = fitTransform({ bounds, vw: 1000, vh: 800, reserveBottom: 80 });
  assert.equal(a.zoom, b.zoom);
  assert.ok(b.panY + bounds.maxY * b.zoom <= 800 - 80);
});

test('fitTransform clamps zoom to [minZoom, maxZoom]', () => {
  assert.equal(fitTransform({ bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 }, vw: 1000, vh: 1000 }).zoom, 1.5);
  assert.equal(fitTransform({ bounds: { minX: 0, minY: 0, maxX: 1e6, maxY: 1e6 }, vw: 100, vh: 100 }).zoom, 0.1);
});

test('the renderer fits around the legend and re-fits when it is toggled (drift guard, #651)', () => {
  const src = renderSource();
  const fit = src.match(/function fitToView\(\) \{([\s\S]*?)\n  \}/);
  assert.ok(fit, 'fitToView is still there');
  assert.match(fit[1], /legendReserve\(legendEl\.offsetHeight,/);
  assert.match(fit[1], /fitTransform\([^;]*reserveBottom/);
  const toggle = src.match(/data-legend-toggle\]'\)\) \{([\s\S]*?)return;/);
  assert.ok(toggle, 'the legend toggle branch is still there');
  assert.match(toggle[1], /if \(!state\.userTransform\) fitToView\(\)/);
});
