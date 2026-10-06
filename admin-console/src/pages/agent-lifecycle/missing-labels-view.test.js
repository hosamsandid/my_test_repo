import test from 'node:test';
import assert from 'node:assert/strict';
import { missingLabelRows, unreadableNote } from './missing-labels-view.js';
import { lintAction, lintView } from '../process/lint-view.js';

test('missingLabelRows: one row per (repo, label), naming every listener (#2878)', () => {
  const rows = missingLabelRows({ missing: [
    { repo: 'o/r', label: 'ready-for-code-review-prod', agentId: 'team-code-reviewer', triggerId: 't1' },
    { repo: 'o/r', label: 'ready-for-code-review-prod', agentId: 'team-security', triggerId: 't2' },
    { repo: 'o/r', label: 'other', agentId: 'team-dev' },
    null,
  ] });
  assert.deepEqual(rows.map((r) => [r.repo, r.label, r.agents]), [
    ['o/r', 'ready-for-code-review-prod', ['team-code-reviewer', 'team-security']],
    ['o/r', 'other', ['team-dev']],
  ]);
  assert.equal(rows[0].text, "'ready-for-code-review-prod' does not exist on o/r — team-code-reviewer, team-security can never be woken by it.");
  assert.deepEqual(missingLabelRows(null), []);
});

test('unreadableNote: names repos that were not checked (#2878)', () => {
  assert.equal(unreadableNote({ unreadable: [{ repo: 'o/a' }, { repo: 'o/b' }] }), 'Labels of o/a, o/b could not be read, so they are not checked.');
  assert.equal(unreadableNote({ unreadable: [] }), null);
});

test('lint panel: a missing wake label reads plainly and offers Create label; other lints offer nothing (#2878)', () => {
  const l = { code: 'wake-label-missing', severity: 'warning', repo: 'o/r', label: 'ready-for-code-review-prod', message: 'x' };
  assert.equal(lintView(l).title, 'Wake label does not exist on GitHub');
  assert.deepEqual(lintAction(l), { kind: 'create-label', repo: 'o/r', label: 'ready-for-code-review-prod', text: 'Create label', title: "Create 'ready-for-code-review-prod' on o/r" });
  assert.equal(lintAction({ code: 'dead-end-emitter' }), null);
  assert.equal(lintAction({ code: 'wake-label-missing' }), null);
});
