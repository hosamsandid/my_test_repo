import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTINGS_SECTIONS, defaultSectionId, resolveSectionId, adjacentSectionId, sectionById,
} from './settings-modal-view.js';

test('ships the three UX-1 sections in order (Behavior, Model, Display)', () => {
  assert.deepEqual(SETTINGS_SECTIONS.map((s) => s.id), ['behavior', 'model', 'display']);
  assert.deepEqual(SETTINGS_SECTIONS.map((s) => s.label), ['Behavior', 'Model', 'Display']);
});

test('the modal opens on the first section', () => {
  assert.equal(defaultSectionId(), 'behavior');
});

test('resolveSectionId keeps a valid id and repairs a stale one', () => {
  assert.equal(resolveSectionId('model'), 'model');
  assert.equal(resolveSectionId('nope'), 'behavior');
  assert.equal(resolveSectionId(undefined), 'behavior');
});

test('resolveSectionId returns null for an empty section list', () => {
  assert.equal(resolveSectionId('behavior', []), null);
});

test('adjacentSectionId moves forward and backward with wrap-around', () => {
  assert.equal(adjacentSectionId('behavior', 1), 'model');
  assert.equal(adjacentSectionId('model', 1), 'display');
  assert.equal(adjacentSectionId('display', 1), 'behavior'); // wrap end -> start
  assert.equal(adjacentSectionId('behavior', -1), 'display'); // wrap start -> end
  assert.equal(adjacentSectionId('model', -1), 'behavior');
});

test('adjacentSectionId treats an unknown current id as the first section', () => {
  assert.equal(adjacentSectionId('nope', 1), 'model');
});

test('sectionById returns the descriptor, falling back to the first', () => {
  assert.equal(sectionById('display').label, 'Display');
  assert.equal(sectionById('nope').id, 'behavior');
});
