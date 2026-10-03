'use strict';

// #2688: an environment's Additional context edit must reach its existing
// agents' CLAUDE.md, not only agents created afterwards.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { planEnvironmentPromptRebuild, summarizePromptRebuild } = require('./env-prompt-rebuild');

test('plan: bound members are rebuilt, unprovisioned ones pending, team record and other envs skipped', () => {
  const plan = planEnvironmentPromptRebuild([
    { id: 'dev', cfg: { environmentId: 'env-a', role: 'team-member', token: 't' } },
    { id: 'new', cfg: { environmentId: 'env-a', role: 'team-member' } },
    { id: 'squad', cfg: { environmentId: 'env-a', role: 'team', token: 't' } },
    { id: 'other', cfg: { environmentId: 'env-b', token: 't' } },
    { id: 'broken', cfg: null },
  ], 'env-a');
  assert.deepEqual(plan, [
    { id: 'dev', action: 'rebuild' },
    { id: 'new', action: 'pending' },
  ]);
});

test('plan: tolerates a non-array input', () => {
  assert.deepEqual(planEnvironmentPromptRebuild(undefined, 'env-a'), []);
});

test('summary: every outcome lands in exactly one bucket', () => {
  assert.deepEqual(summarizePromptRebuild([
    { id: 'a', status: 'rebuilt' },
    { id: 'b', status: 'pending' },
    { id: 'c', status: 'failed', detail: 'boom' },
    { id: 'd', status: 'failed' },
    { status: 'rebuilt' },
    null,
  ]), {
    rebuilt: ['a'],
    pending: ['b'],
    failed: [{ id: 'c', error: 'boom' }, { id: 'd', error: 'failed' }],
  });
});

// The fan-out and its route live in orchestrator.js, which cannot be required
// in a test; pin the wiring at source level.
test('orchestrator wires the environment prompt-rebuild route to the planner and rebuildAgentPrompt', () => {
  const src = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8').replace(/\s+/g, ' ');
  assert.match(src, /envPromptRebuild\.planEnvironmentPromptRebuild\(listAgentConfigs\(\), envId\)/);
  assert.match(src, /await rebuildAgentPrompt\(id, reason\)/);
  assert.match(src, /\\\/internal\\\/environments\\\/\(\[\^\/\]\+\)\\\/prompt-rebuild\$/);
  assert.match(src, /await rebuildEnvironmentPrompts\(envId, reason\)/);
});
