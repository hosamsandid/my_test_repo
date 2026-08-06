import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  NO_TICKET_LABEL,
  parseIssueRefInput,
  truncateTitle,
  describeTicket,
  ticketHref,
} from './ticket-view.js';

test('NO_TICKET_LABEL is the unbound placeholder', () => {
  assert.equal(NO_TICKET_LABEL, 'No parent ticket');
});

test('parseIssueRefInput accepts bare / #-prefixed integers', () => {
  assert.deepEqual(parseIssueRefInput('123'), { kind: 'number', number: 123 });
  assert.deepEqual(parseIssueRefInput('#42'), { kind: 'number', number: 42 });
  assert.deepEqual(parseIssueRefInput('  7 '), { kind: 'number', number: 7 });
});

test('parseIssueRefInput parses a github issue URL', () => {
  assert.deepEqual(parseIssueRefInput('https://github.com/acme/widgets/issues/1383'), {
    kind: 'url',
    owner: 'acme',
    repo: 'widgets',
    number: 1383,
  });
});

test('parseIssueRefInput rejects junk / non-issue URLs', () => {
  for (const bad of ['0', '-1', 'abc', '', '  ', null, undefined, 5, 'https://github.com/a/b/pull/3']) {
    assert.equal(parseIssueRefInput(bad), null, `expected null for ${JSON.stringify(bad)}`);
  }
});

test('truncateTitle passes short titles through unchanged', () => {
  assert.equal(truncateTitle('short', 40), 'short');
  assert.equal(truncateTitle('', 40), '');
});

test('truncateTitle clips a long title with an ellipsis', () => {
  const t = truncateTitle('x'.repeat(60), 10);
  assert.equal(t.length, 10);
  assert.ok(t.endsWith('…'));
});

test('describeTicket returns null when unbound / malformed', () => {
  assert.equal(describeTicket(null), null);
  assert.equal(describeTicket({}), null);
  assert.equal(describeTicket({ number: 0, repo: 'a/b' }), null);
});

test('describeTicket builds the compact label and href', () => {
  const d = describeTicket({ repo: 'a/b', number: 12, title: 'Fix the thing', url: 'https://github.com/a/b/issues/12' });
  assert.equal(d.number, 12);
  assert.equal(d.repo, 'a/b');
  assert.equal(d.label, '#12 Fix the thing');
  assert.equal(d.href, 'https://github.com/a/b/issues/12');
  assert.equal(d.closed, false);
  assert.equal(d.state, null);
});

test('describeTicket flags a closed issue', () => {
  const d = describeTicket({ repo: 'a/b', number: 3, title: 'Done', state: 'closed' });
  assert.equal(d.state, 'closed');
  assert.equal(d.closed, true);
});

test('describeTicket label omits the title when empty', () => {
  const d = describeTicket({ repo: 'a/b', number: 9, title: '' });
  assert.equal(d.label, '#9');
});

test('ticketHref derives from repo+number when url is absent', () => {
  assert.equal(ticketHref({ repo: 'a/b', number: 7 }), 'https://github.com/a/b/issues/7');
  assert.equal(ticketHref({ number: 7 }), '');
  assert.equal(ticketHref(null), '');
});
