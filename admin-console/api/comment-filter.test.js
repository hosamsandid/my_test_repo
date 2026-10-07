'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { commentFilterError, commentFilterFields, normalizeCommentFilter } = require('./comment-filter');

test('commentFilterError (#2822): absent / null / blank / false are valid', () => {
  assert.equal(commentFilterError({}), null);
  assert.equal(commentFilterError({ requireLabel: null, skipAgentComments: null, target: null }), null);
  assert.equal(commentFilterError({ requireLabel: '', skipAgentComments: false, target: '' }), null);
  assert.equal(commentFilterError({ requireLabel: 'clarifying', skipAgentComments: true, target: 'issue' }), null);
  assert.equal(commentFilterError({ target: 'pr' }), null);
});

test('commentFilterError (#2822): malformed values are rejected', () => {
  assert.match(commentFilterError({ requireLabel: 7 }), /requireLabel/);
  assert.match(commentFilterError({ requireLabel: 'x'.repeat(51) }), /at most 50/);
  assert.match(commentFilterError({ skipAgentComments: 'yes' }), /skipAgentComments/);
  assert.match(commentFilterError({ target: 'both' }), /"issue" or "pr"/);
});

test('commentFilterFields (#2822): only set fields, in stored form', () => {
  assert.deepEqual(commentFilterFields({ requireLabel: ' clarifying ', skipAgentComments: true, target: 'issue' }),
    { requireLabel: 'clarifying', skipAgentComments: true, target: 'issue' });
  assert.deepEqual(commentFilterFields({ requireLabel: ' ', skipAgentComments: false, target: null }), {});
  assert.deepEqual(commentFilterFields(null), {});
});

test('normalizeCommentFilter (#2822): trims, and removes cleared keys', () => {
  const t = { id: 'a', requireLabel: ' clarifying ', skipAgentComments: null, target: '' };
  normalizeCommentFilter(t);
  assert.deepEqual(t, { id: 'a', requireLabel: 'clarifying' });
  const u = { id: 'b', skipAgentComments: true, target: 'pr' };
  normalizeCommentFilter(u);
  assert.deepEqual(u, { id: 'b', skipAgentComments: true, target: 'pr' });
});
