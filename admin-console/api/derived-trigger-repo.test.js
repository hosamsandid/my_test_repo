const test = require('node:test');
const assert = require('node:assert/strict');

const { injectDerivedTriggerRepo } = require('./derived-trigger-repo');
const { expandGithubChannels, expandDataFlowSteps } = require('./process-template');

const REPO = 'AccentureCodeFoundry/314092_agent-execution-environment';

// The poller's contract (github-poller.js `_buildPollPlan`): a github-event
// trigger with no `repo` is skipped and never becomes a subscriber.
const hasRepo = (t) => t.type !== 'github-event' || (typeof t.repo === 'string' && t.repo.length > 0);

test('expandGithubChannels emits a github-event trigger WITHOUT a repo (the bug)', () => {
  // A consumer reacting to a `ready`-labelled issue from a producer — exactly
  // the developer↔business-analyst channel that stopped firing.
  const { roles } = expandGithubChannels({
    roles: [
      { id: 'ba', displayName: 'Business Analyst', github: { producesIssue: true } },
      { id: 'dev', displayName: 'Developer', channels: [{ artifact: 'issue', from: 'ba', label: 'ready', gate: 'human' }] },
    ],
  });
  const dev = roles.find(r => r.id === 'dev');
  const derived = dev.triggers.find(t => t.type === 'github-event');
  assert.ok(derived, 'a github-event trigger was derived from the channel port');
  assert.equal(derived.repo, undefined, 'derived trigger carries no repo — poller would skip it');
});

test('injectDerivedTriggerRepo restores repo on channel triggers → poller-visible', () => {
  const { roles } = expandGithubChannels({
    roles: [
      { id: 'ba', displayName: 'Business Analyst', github: { producesIssue: true } },
      { id: 'dev', displayName: 'Developer', channels: [{ artifact: 'issue', from: 'ba', label: 'ready' }] },
    ],
  });
  const dev = roles.find(r => r.id === 'dev');
  const fixed = injectDerivedTriggerRepo(dev.triggers, REPO);
  assert.ok(fixed.every(hasRepo), 'every github-event trigger now has a repo');
  assert.equal(fixed.find(t => t.type === 'github-event').repo, REPO);
});

test('injectDerivedTriggerRepo restores repo on data-flow push triggers', () => {
  const { roles } = expandDataFlowSteps({
    roles: [
      { id: 'up', displayName: 'Upstream', outputs: [{ name: 'Design' }] },
      { id: 'down', displayName: 'Downstream', inputs: [{ name: 'Design' }] },
    ],
  });
  const down = roles.find(r => r.id === 'down');
  const derived = down.triggers.find(t => t.type === 'github-event');
  assert.ok(derived, 'a push trigger was derived from the data-flow port');
  assert.equal(derived.repo, undefined, 'derived data-flow trigger carries no repo either');

  const fixed = injectDerivedTriggerRepo(down.triggers, REPO);
  assert.ok(fixed.every(hasRepo));
  assert.equal(fixed.find(t => t.type === 'github-event').repo, REPO);
});

test('is idempotent — a trigger that already has a repo is left byte-identical', () => {
  const triggers = [
    { id: 'a', type: 'github-event', events: ['issues.labeled'], repo: 'owner/existing' },
    { id: 'b', type: 'cron', cron: '5 3 * * 1' },
  ];
  const out = injectDerivedTriggerRepo(triggers, REPO);
  assert.equal(out[0].repo, 'owner/existing', 'pre-existing repo is not overwritten');
  assert.deepEqual(out, triggers, 'no-op when nothing needs a repo');
});

test('a falsy repo (unresolvable env) leaves triggers untouched rather than writing junk', () => {
  const triggers = [{ id: 'a', type: 'github-event', events: ['push'] }];
  assert.deepEqual(injectDerivedTriggerRepo(triggers, null), triggers);
  assert.deepEqual(injectDerivedTriggerRepo(triggers, ''), triggers);
});

// #2322 — every github-event listener is stamped (all labelled hand-offs are
// poller-delivered since #2578, and the poller skips a repo-less trigger).
// Non-github-event triggers (cron) are untouched.
test('#2322 every github-event listener is stamped, a cron trigger is untouched', () => {
  const triggers = [
    { id: 'poller', type: 'github-event', events: ['issues.labeled'], labelFilter: 'ready' },
    { id: 'done', type: 'github-event', events: ['issues.labeled'], labelFilter: 'done' },
    { id: 'cron', type: 'cron', cron: '5 3 * * 1' },
  ];
  const out = injectDerivedTriggerRepo(triggers, REPO);
  assert.equal(out[0].repo, REPO, 'the first listener is stamped');
  assert.equal(out[1].repo, REPO, 'the second listener is stamped too');
  assert.deepEqual(out[2], triggers[2], 'a non-github-event trigger (cron) is byte-identical');
});

// #2322 — the regression: a repo added to an environment AFTER its team already
// has (repo-less) derived triggers. Models the full lifecycle at the trigger
// level: materialise with no repo → github-event triggers are undeliverable → the
// env gains a repo → the fan-out re-injects the primary repo → every github-event
// trigger becomes deliverable.
test('#2322 repo added after triggers already exist → every github-event trigger becomes deliverable (AC6)', () => {
  const { roles } = expandGithubChannels({
    roles: [
      { id: 'ba', displayName: 'Business Analyst', github: { producesIssue: true } },
      { id: 'dev', displayName: 'Developer', channels: [{ artifact: 'issue', from: 'ba', label: 'ready', gate: 'human' }] },
    ],
  });
  const dev = roles.find(r => r.id === 'dev');

  // Materialise time on a repo-LESS environment: expand emits repo-less triggers
  // and the null-repo inject is a no-op, so they stay poller-invisible. A member
  // also carrying a hand-authored label listener rides along.
  const materialised = injectDerivedTriggerRepo(
    [...dev.triggers, { id: 'authored', type: 'github-event', events: ['issues.labeled'], labelFilter: 'done' }],
    null,
  );
  assert.ok(
    materialised.every(t => t.type !== 'github-event' || !t.repo),
    'every github-event trigger starts repo-less — the poller would skip them all',
  );

  // The environment later GAINS its repo → the back-fill re-runs inject.
  const backfilled = injectDerivedTriggerRepo(materialised, REPO);
  const listeners = backfilled.filter(t => t.type === 'github-event');
  assert.ok(listeners.length >= 2, 'the channel listener and the authored one');
  assert.ok(backfilled.every(hasRepo), 'every github-event trigger now carries a repo');
});
