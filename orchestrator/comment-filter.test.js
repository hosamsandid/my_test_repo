'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cf = require('./comment-filter');

const commentEv = ({ body = 'hi', pr = false, labels = [] } = {}) => ({
  payload: {
    action: 'created',
    issue: { number: 4, labels: labels.map((name) => ({ name })), ...(pr ? { pull_request: { url: 'x' } } : {}) },
    comment: { body },
  },
});

test('parseCommentFilter: null without fields, canonical form otherwise', () => {
  assert.equal(cf.parseCommentFilter({}), null);
  assert.equal(cf.parseCommentFilter({ requireLabel: '  ', skipAgentComments: false, target: 'both' }), null);
  assert.deepEqual(cf.parseCommentFilter({ requireLabel: ' clarifying ' }), { requireLabel: 'clarifying', skipAgentComments: false, target: null });
  assert.deepEqual(cf.parseCommentFilter({ skipAgentComments: true, target: 'pr' }), { requireLabel: null, skipAgentComments: true, target: 'pr' });
  assert.equal(cf.parseCommentFilter({ skipAgentComments: 'yes' }), null, 'only a real true opts in');
});

test('isCommentEvent: issue_comment.* only', () => {
  assert.equal(cf.isCommentEvent('issue_comment.created'), true);
  assert.equal(cf.isCommentEvent('issue_comment.edited'), true);
  assert.equal(cf.isCommentEvent('issues.labeled'), false);
  assert.equal(cf.isCommentEvent('pull_request_review_comment.created'), false);
  assert.equal(cf.isCommentEvent(null), false);
});

test('hasAgentMarker: the gh-as-agent marker anywhere in the body', () => {
  assert.equal(cf.hasAgentMarker('Question?\n\n<!-- agent: team-x-spec -->\n'), true);
  assert.equal(cf.hasAgentMarker('<!--agent:a-->'), true);
  assert.equal(cf.hasAgentMarker('Sure, go with option B.'), false);
  assert.equal(cf.hasAgentMarker('<!-- agent: -->'), false);
  assert.equal(cf.hasAgentMarker(null), false);
});

test('commentPrecheck: target, then agent marker', () => {
  const f = cf.parseCommentFilter({ target: 'issue', skipAgentComments: true });
  assert.equal(cf.commentPrecheck(f, commentEv()).ok, true);
  assert.equal(cf.commentPrecheck(f, commentEv({ pr: true })).reason, 'comment-target');
  assert.equal(cf.commentPrecheck(f, commentEv({ body: 'q <!-- agent: a -->' })).reason, 'agent-comment');
  const prOnly = cf.parseCommentFilter({ target: 'pr' });
  assert.equal(cf.commentPrecheck(prOnly, commentEv()).reason, 'comment-target');
  assert.equal(cf.commentPrecheck(prOnly, commentEv({ pr: true })).ok, true);
  assert.equal(cf.commentPrecheck(null, commentEv({ pr: true })).ok, true);
});

test('requireLabelVerdict: exact label name in the given set', () => {
  const f = cf.parseCommentFilter({ requireLabel: 'clarifying' });
  assert.equal(cf.requireLabelVerdict(f, ['bug', 'clarifying']).ok, true);
  const v = cf.requireLabelVerdict(f, ['clarifying:wip']);
  assert.equal(v.ok, false);
  assert.equal(v.reason, 'comment-label');
  assert.equal(cf.requireLabelVerdict(cf.parseCommentFilter({ target: 'pr' }), []).ok, true);
});

test('labelNames: objects or strings, missing = empty', () => {
  assert.deepEqual(cf.labelNames({ labels: [{ name: 'a' }, 'b', null] }), ['a', 'b']);
  assert.deepEqual(cf.labelNames(null), []);
});
