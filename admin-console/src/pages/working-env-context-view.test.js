import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { promptRebuildSummary } from './working-env-context-view.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

test('no report (Additional context unchanged) → nothing to show', () => {
  assert.equal(promptRebuildSummary(undefined), null);
  assert.equal(promptRebuildSummary(null), null);
  assert.equal(promptRebuildSummary({ ok: true, rebuilt: [], pending: [], failed: [] }), null);
});

test('rebuilt and pending agents are each named', () => {
  const r = promptRebuildSummary({ ok: true, rebuilt: ['dev', 'qa'], pending: ['new'], failed: [] });
  assert.equal(r.tone, 'ok');
  assert.deepEqual(r.lines, [
    'Additional context written into the CLAUDE.md of dev, qa — in effect from the next run.',
    'Not created yet: new — gets the new text when it is created.',
  ]);
});

test('a failed agent turns the report into a warning and keeps its reason', () => {
  const r = promptRebuildSummary({ ok: true, rebuilt: ['dev'], failed: [{ id: 'qa', error: 'boom' }, { error: 'no id' }] });
  assert.equal(r.tone, 'warn');
  assert.deepEqual(r.lines.slice(1), ['CLAUDE.md not updated for qa: boom.']);
});

test('an unreachable orchestrator is reported, not swallowed', () => {
  const r = promptRebuildSummary({ ok: false, error: 'could not reach the orchestrator (timeout)' });
  assert.equal(r.tone, 'warn');
  assert.match(r.lines[0], /could not be updated: could not reach the orchestrator \(timeout\)\./);
});

// JSX is not executed in this suite (#651); pin the wiring and copy at source level.
test('Team Settings shows the rebuild report and no longer over-promises in the help text', () => {
  const src = fs.readFileSync(path.join(HERE, 'agent-chat', 'TeamEnvironmentPanel.jsx'), 'utf8').replace(/\s+/g, ' ');
  assert.match(src, /setContextReport\(promptRebuildSummary\(saved\?\.promptRebuild\)\)/);
  assert.match(src, /Saving a change also updates the CLAUDE\.md of existing members/);
});

test('the template name help text no longer refers to the removed agent list', () => {
  const src = fs.readFileSync(path.join(HERE, 'EnvironmentTemplates.jsx'), 'utf8');
  assert.doesNotMatch(src, /agent list/);
});
