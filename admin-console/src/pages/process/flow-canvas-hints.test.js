import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CANVAS_TITLES,
  orientationTitle,
  archivedTitle,
  stagesTitle,
} from './flow-canvas-hints.js';

test('every one-shot view action has a hint', () => {
  for (const key of ['fit', 'expandAll', 'collapseAll']) {
    assert.equal(typeof CANVAS_TITLES[key], 'string');
    assert.ok(CANVAS_TITLES[key].length > 0, `${key} needs copy`);
  }
});

test('the direction hint names the direction the click switches TO', () => {
  assert.match(orientationTitle('vertical'), /top-down to left-right/);
  assert.match(orientationTitle('horizontal'), /left-right to top-down/);
});

test('each toggle hint states the action, not just the subject', () => {
  // The whole point of a state-dependent hint: "Archived" alone never told the
  // user whether clicking shows or hides.
  assert.match(archivedTitle(false), /^Show /);
  assert.match(archivedTitle(true), /^Hide /);
  assert.match(stagesTitle(false), /^Show /);
  assert.match(stagesTitle(true), /^Hide /);
});

test('toggle hints differ between the two states', () => {
  assert.notEqual(archivedTitle(true), archivedTitle(false));
  assert.notEqual(stagesTitle(true), stagesTitle(false));
  assert.notEqual(orientationTitle('vertical'), orientationTitle('horizontal'));
});
