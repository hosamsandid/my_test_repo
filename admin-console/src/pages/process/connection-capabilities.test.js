import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capabilitiesFor,
  processMode,
  bpMode,
  createTypesFor,
  sourceKindOf,
} from './connection-capabilities.js';

// The matrix reproduces today's per-view behaviour exactly (#409 is a pure
// refactoring): live + draft edit everything, BP edits only its two BP types,
// blueprint and viewer are read-only with a hint.

test('live and draft are fully editable with the process type set', () => {
  for (const mode of ['live', 'draft']) {
    const caps = capabilitiesFor(mode);
    assert.equal(caps.editable, true);
    assert.equal(caps.connectPort, true);
    assert.equal(caps.edgeClick, true);
    assert.equal(caps.actorSources, true);
    assert.equal(caps.readOnlyHint, null);
    assert.deepEqual(createTypesFor(caps, 'agent'), ['github-pr', 'github-issue', 'label', 'artifact', 'hierarchy']);
    assert.deepEqual(createTypesFor(caps, 'github'), ['event']);
    assert.deepEqual(createTypesFor(caps, 'external'), ['webhook']);
    // @human and @timer are no longer drag sources: human actions are GitHub
    // label events, schedules live in the card / trigger editor.
    assert.deepEqual(createTypesFor(caps, 'human'), []);
    assert.deepEqual(createTypesFor(caps, 'timer'), []);
  }
});

test('sourceKindOf maps actor ids and falls back to agent', () => {
  assert.equal(sourceKindOf('@github'), 'github');
  assert.equal(sourceKindOf('@external'), 'external');
  // The generic @human hub is gone (#987) — human roles are named nodes, wired
  // via the human-aware CreateEdgeDialog (branches on the node's `kind`), so
  // there is no '@human' source kind any more; it resolves like a plain agent.
  assert.equal(sourceKindOf('@human'), 'agent');
  // @timer stays a former actor — resolves like any unknown id (plain agent).
  assert.equal(sourceKindOf('@timer'), 'agent');
  assert.equal(sourceKindOf('developer'), 'agent');
});

test('bp workspace edits only dependency + artifact, offers no actors', () => {
  const caps = capabilitiesFor('bp');
  assert.equal(caps.editable, true);
  assert.equal(caps.connectPort, true);
  assert.equal(caps.actorSources, false);
  assert.deepEqual(createTypesFor(caps, 'agent'), ['dependency', 'artifact']);
});

test('blueprint and viewer are read-only and carry a hint', () => {
  for (const mode of ['blueprint', 'viewer']) {
    const caps = capabilitiesFor(mode);
    assert.equal(caps.editable, false);
    assert.equal(caps.connectPort, false);
    assert.equal(caps.edgeClick, false);
    assert.equal(typeof caps.readOnlyHint, 'string');
    assert.deepEqual(createTypesFor(caps, 'agent'), []);
  }
});

test('unknown modes fail closed to the viewer capabilities', () => {
  const caps = capabilitiesFor('nope');
  assert.equal(caps.editable, false);
  assert.deepEqual(createTypesFor(caps, 'agent'), []);
});

test('processMode resolves scope like the Process Canvas did ad hoc', () => {
  assert.equal(processMode({ isDraft: true, imported: null, level: 'template' }), 'draft');
  assert.equal(processMode({ isDraft: false, imported: { bundle: {} }, level: 'live' }), 'blueprint');
  assert.equal(processMode({ isDraft: false, imported: null, level: 'template' }), 'blueprint');
  assert.equal(processMode({ isDraft: false, imported: null, level: 'live' }), 'live');
});

test('bpMode resolves on the workspace prop', () => {
  assert.equal(bpMode({ workspace: '/workspace/agents/x/briefings' }), 'bp');
  assert.equal(bpMode({ workspace: '' }), 'viewer');
  assert.equal(bpMode({}), 'viewer');
});
