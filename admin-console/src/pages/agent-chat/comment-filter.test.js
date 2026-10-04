import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  showsCommentFilter, commentFilterToForm, commentFilterBody, commentFilterFormError, commentFilterSummary,
} from './comment-filter.js';
import { summarizeGithubEventTrigger } from './trigger-summary.js';

test('#2822: the comment fields show only for issue_comment events', () => {
  assert.equal(showsCommentFilter(['issue_comment.created']), true);
  assert.equal(showsCommentFilter(['issues.labeled']), false);
  assert.equal(showsCommentFilter([]), false);
  assert.equal(showsCommentFilter(undefined), false);
});

test('#2822: stored trigger → form state, unknown values degrade to "no filter"', () => {
  assert.deepEqual(commentFilterToForm({ requireLabel: 'clarifying', skipAgentComments: true, target: 'pr' }),
    { requireLabel: 'clarifying', skipAgentComments: true, commentTarget: 'pr' });
  assert.deepEqual(commentFilterToForm({ target: 'bogus', skipAgentComments: 'yes' }),
    { requireLabel: '', skipAgentComments: false, commentTarget: '' });
  assert.deepEqual(commentFilterToForm(undefined), { requireLabel: '', skipAgentComments: false, commentTarget: '' });
});

test('#2822: form → body sends every key, null when unset or hidden (AC4: an edit clears it)', () => {
  const form = { requireLabel: '  clarifying ', skipAgentComments: true, commentTarget: 'issue' };
  assert.deepEqual(commentFilterBody(form), { requireLabel: 'clarifying', skipAgentComments: true, target: 'issue' });
  assert.deepEqual(commentFilterBody(form, { show: false }), { requireLabel: null, skipAgentComments: null, target: null });
  assert.deepEqual(commentFilterBody({ requireLabel: ' ', skipAgentComments: false, commentTarget: '' }),
    { requireLabel: null, skipAgentComments: null, target: null });
});

test('#2822: a required label longer than GitHub allows is a form error', () => {
  assert.equal(commentFilterFormError({ requireLabel: 'x'.repeat(50) }), null);
  assert.match(commentFilterFormError({ requireLabel: 'x'.repeat(51) }), /at most 50/);
});

test('#2822: the trigger card summarises the comment filters', () => {
  const t = { type: 'github-event', events: ['issue_comment.created'], requireLabel: 'clarifying', skipAgentComments: true, target: 'pr' };
  assert.deepEqual(commentFilterSummary(t), ['PRs only', 'item labelled “clarifying”', 'ignores agent comments']);
  assert.deepEqual(summarizeGithubEventTrigger(t).comments, ['PRs only', 'item labelled “clarifying”', 'ignores agent comments']);
  assert.deepEqual(commentFilterSummary({ events: ['issue_comment.created'] }), []);
  assert.deepEqual(commentFilterSummary({ events: ['issues.labeled'], requireLabel: 'x' }), [], 'stale field on another event is not shown');
  assert.deepEqual(summarizeGithubEventTrigger(undefined).comments, []);
});

test('#2822: TriggerForm wires the comment fields into state, validation and the saved body', () => {
  const src = readFileSync(new URL('./TriggersPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /\.\.\.commentFilterToForm\(initialValues\)/);
  assert.match(src, /showsCommentFilter\(form\.events\)/);
  assert.match(src, /commentFilterFormError\(form\)/);
  assert.match(src, /Object\.assign\(body, commentFilterBody\(form, \{ show: showCommentFilter \}\)\)/);
  assert.match(src, /Ignore comments written by agents/);
  assert.match(src, /Required label on the item/);
  assert.match(src, /ghSummary\.comments/);
});
