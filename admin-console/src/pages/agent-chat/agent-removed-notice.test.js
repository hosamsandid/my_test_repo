import { test } from 'node:test';
import assert from 'node:assert/strict';

import { agentRemovedNoticeText } from './agent-removed-notice.js';

test('agentRemovedNoticeText: includes the agent display name when given', () => {
  const text = agentRemovedNoticeText('COBOL Migration Bot');
  assert.match(text, /"COBOL Migration Bot"/);
  assert.match(text, /removed or is no longer available/);
  assert.match(text, /preserved/);
});

test('agentRemovedNoticeText: falls back to a generic subject with no name', () => {
  const text = agentRemovedNoticeText(null);
  assert.match(text, /^This agent was removed/);
});

test('agentRemovedNoticeText: falls back to a generic subject with an empty string', () => {
  const text = agentRemovedNoticeText('');
  assert.match(text, /^This agent was removed/);
});
