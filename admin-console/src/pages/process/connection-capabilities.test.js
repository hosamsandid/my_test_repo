import test from 'node:test';
import assert from 'node:assert/strict';

import {
  capabilitiesFor,
  processMode,
  createTypesFor,
  sourceKindOf,
} from './connection-capabilities.js';
// Namespace import as well, so the removal assertions below can ask whether an
// export is gone. A named import of a missing export is a link-time error in
// ESM, which would fail the file instead of failing the assertion.
import * as capabilities from './connection-capabilities.js';

// The matrix reproduces today's per-view behaviour exactly (#409 was a pure
// refactoring): live + draft edit everything, blueprint and viewer are
// read-only with a hint. The fifth mode, `bp`, went with the BriefingPack
// source in #1965 — see the removal guards at the bottom.

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

/* ── #1965 (epic #1961 Phase 4): the BriefingPack mode is gone ───────────── */

test('#1965 — the bp mode is no longer in the matrix and fails closed', () => {
  // Not merely absent from the exported table: `capabilitiesFor` falls back to
  // `viewer` for anything it does not know, so an editor still asking for 'bp'
  // (an old bookmark, a stale prop) gets a read-only view rather than an
  // editable one wired to write-back ops that no longer exist.
  const caps = capabilitiesFor('bp');
  assert.equal(caps.mode, 'viewer');
  assert.equal(caps.editable, false);
  assert.equal(caps.connectPort, false);
  assert.deepEqual(createTypesFor(caps, 'agent'), []);
});

test('#1965 — bpMode is no longer exported', () => {
  // The resolver that turned a `workspace` prop into the 'bp' mode. Asserted on
  // the namespace so a re-add is caught here rather than by a stray consumer.
  assert.equal(capabilities.bpMode, undefined);
});

test('#1965 — no surviving mode offers the BP-only dependency tile', () => {
  // 'dependency' was reachable as an explicit create-type only in the BP view.
  // An artifact with no name still degrades to a plain dependency in the edge
  // engine — that path is untouched; this is about the picker's tile list.
  for (const mode of ['live', 'draft', 'blueprint', 'viewer']) {
    const caps = capabilitiesFor(mode);
    for (const kind of ['agent', 'github', 'external']) {
      assert.ok(
        !createTypesFor(caps, kind).includes('dependency'),
        `${mode}/${kind} still offers the BP dependency tile`,
      );
    }
  }
});
