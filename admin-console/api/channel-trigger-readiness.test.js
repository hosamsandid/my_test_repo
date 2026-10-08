'use strict';

// #2912: a readiness gate edited on a flow-derived channel listener in Agent
// Chat → Triggers is written back to the consumer's PR channel ports, so the
// regenerated listener and the Flow editor show the same gate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { applyChannelTriggerReadiness, expandGithubChannels, channelTriggerId } = require('./process-template');

const derive = (channels) => expandGithubChannels({
  roles: [
    { id: 't-dev', displayName: 'Dev' },
    { id: 't-ops', displayName: 'Ops' },
    { id: 't-rev', displayName: 'Rev', channels },
  ],
}).roles.find(r => r.id === 't-rev').triggers;

test('the edited gate lands on the matching PR channel and the reconcile derives it back', () => {
  const channels = [
    { artifact: 'pr', from: 't-dev', label: 'ready-for-review' },
    { artifact: 'issue', from: 't-dev', label: 'ready-for-review' },
    { artifact: 'pr', from: 't-dev', label: 'other' },
  ];
  const id = channelTriggerId('t-rev', 'pr', 'ready-for-review');
  const next = applyChannelTriggerReadiness(channels, 't-rev', id, { ci: true, conflict: false, timeoutMinutes: 60 });
  assert.deepEqual(next[0], { artifact: 'pr', from: 't-dev', label: 'ready-for-review', readiness: { ci: true, conflict: false } });
  assert.equal(next[1], channels[1], 'an issue channel on the same label is untouched');
  assert.equal(next[2], channels[2], 'a channel on another label is untouched');
  assert.deepEqual(derive(next).find(t => t.id === id).readinessGate, { ci: true, conflict: false });
});

test('fan-in: every contributing channel gets the edited gate, so the merged gate is exactly it', () => {
  const channels = [
    { artifact: 'pr', from: 't-dev', label: 'ready', readiness: { ci: true, conflict: false } },
    { artifact: 'pr', from: 't-ops', label: 'ready', readiness: { ci: false, conflict: true, failureLabel: 'fix-me' } },
  ];
  const id = channelTriggerId('t-rev', 'pr', 'ready');
  assert.deepEqual(derive(channels).find(t => t.id === id).readinessGate,
    { ci: true, conflict: true, failureLabel: 'fix-me' }, 'the combined state Agent Chat shows');
  const next = applyChannelTriggerReadiness(channels, 't-rev', id, { ci: true, conflict: false });
  assert.deepEqual(next.map(c => c.readiness), [{ ci: true, conflict: false }, { ci: true, conflict: false }]);
  assert.deepEqual(derive(next).find(t => t.id === id).readinessGate, { ci: true, conflict: false });
});

test('null or both toggles off clears the gate on every contributing channel', () => {
  const channels = [
    { artifact: 'pr', from: 't-dev', label: 'ready', readiness: { ci: true, conflict: true } },
    { artifact: 'pr', from: 't-ops', label: 'ready', readiness: { ci: true, conflict: false }, autoClaim: false },
  ];
  const id = channelTriggerId('t-rev', 'pr', 'ready');
  for (const gate of [null, { ci: false, conflict: false }]) {
    const next = applyChannelTriggerReadiness(channels, 't-rev', id, gate);
    assert.deepEqual(next, [
      { artifact: 'pr', from: 't-dev', label: 'ready' },
      { artifact: 'pr', from: 't-ops', label: 'ready', autoClaim: false },
    ]);
    assert.equal(derive(next).find(t => t.id === id).readinessGate, undefined);
  }
});

test('an unlabelled PR channel (PR opened) matches its own listener id', () => {
  const channels = [{ artifact: 'pr', from: 't-dev' }];
  const id = channelTriggerId('t-rev', 'pr', '');
  assert.deepEqual(applyChannelTriggerReadiness(channels, 't-rev', id, { ci: true })[0].readiness, { ci: true, conflict: false });
});

test('no port derives the trigger → null (nothing to write back)', () => {
  assert.equal(applyChannelTriggerReadiness([{ artifact: 'pr', from: 't-dev', label: 'x' }], 't-rev', 't-rev-on-pr-y', { ci: true }), null);
  assert.equal(applyChannelTriggerReadiness(undefined, 't-rev', 't-rev-on-pr-y', { ci: true }), null);
  // A self-channel never derives a listener, so it is never written either.
  assert.equal(applyChannelTriggerReadiness([{ artifact: 'pr', from: 't-rev', label: 'x' }], 't-rev', 't-rev-on-pr-x', { ci: true }), null);
});

test('source: the trigger PUT writes a channel listener gate back to the ports and re-derives the team', () => {
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf("app.put('/api/agents/:id/triggers/:triggerId'");
  const route = src.slice(start, src.indexOf('async function deleteAgentTrigger', start));
  assert.match(route, /isChannelTrigger\(prev\) && reqTrigger && 'readinessGate' in reqTrigger/);
  assert.match(route, /applyChannelTriggerReadiness\(agentCfg && agentCfg\.channels, id, triggerId, merged\.readinessGate \|\| null\)/);
  assert.match(route, /fresh\.channels = channelWriteBack;\s*writeJsonAtomic\(cfgPath, fresh\);/);
  assert.match(route, /if \(channelWriteBack && agentCfg && agentCfg\.parentTeamId\) \{\s*await reconcileTeamGithubChannels\(agentCfg\.parentTeamId\);/);
});
