const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSetupStatus } = require('./setup-status');

test('buildSetupStatus: returns exactly the three redefined steps', () => {
  const { steps } = buildSetupStatus({ llmCount: 0, sshCount: 0, ghCount: 0 });
  assert.deepEqual(steps.map(s => s.id), ['llm', 'ssh-key', 'gh-token']);
  // The dropped steps must be gone.
  assert.ok(!steps.some(s => s.id === 'environment'));
  assert.ok(!steps.some(s => s.id === 'agent'));
});

test('buildSetupStatus: the Model Provider step is labelled and required, others optional', () => {
  const { steps } = buildSetupStatus({});
  const llm = steps.find(s => s.id === 'llm');
  assert.equal(llm.label, 'Model Provider');
  assert.equal(llm.required, true);
  assert.equal(steps.find(s => s.id === 'ssh-key').required, false);
  assert.equal(steps.find(s => s.id === 'gh-token').required, false);
});

test('buildSetupStatus: isComplete is driven solely by the required Model Provider step', () => {
  assert.equal(buildSetupStatus({ llmCount: 0, sshCount: 9, ghCount: 9 }).isComplete, false);
  assert.equal(buildSetupStatus({ llmCount: 1, sshCount: 0, ghCount: 0 }).isComplete, true);
});

test('buildSetupStatus: completionPercent is over the three-step set', () => {
  assert.equal(buildSetupStatus({ llmCount: 0, sshCount: 0, ghCount: 0 }).completionPercent, 0);
  assert.equal(buildSetupStatus({ llmCount: 1, sshCount: 0, ghCount: 0 }).completionPercent, 33);
  assert.equal(buildSetupStatus({ llmCount: 1, sshCount: 1, ghCount: 0 }).completionPercent, 67);
  assert.equal(buildSetupStatus({ llmCount: 1, sshCount: 1, ghCount: 1 }).completionPercent, 100);
});

test('buildSetupStatus: done flags reflect the per-credential counts', () => {
  const { steps } = buildSetupStatus({ llmCount: 2, sshCount: 0, ghCount: 5 });
  assert.equal(steps.find(s => s.id === 'llm').done, true);
  assert.equal(steps.find(s => s.id === 'ssh-key').done, false);
  assert.equal(steps.find(s => s.id === 'gh-token').done, true);
});

test('buildSetupStatus: no-args defaults to an all-incomplete state', () => {
  const r = buildSetupStatus();
  assert.equal(r.isComplete, false);
  assert.equal(r.completionPercent, 0);
});
