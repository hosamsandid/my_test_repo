'use strict';

// #1008 — preset-reuse regression (concept §8.3 rule 2): the wiring engine's
// dedupe/reuse keying treats TEMPLATE-PRESET triggers as first-class. Wiring a
// hand-off or review gate onto a role instantiated from a real shipped catalog
// template must reuse its preset listener (same (label, event) key) instead of
// adding a second one — the poller has no origin filter, so a duplicate would
// wake the agent redundantly on every matching event.
//
// Lives in api/ (the CI-covered suite) and dynamic-imports the ESM engine from
// src/pages/process, exactly across the same package boundary the app uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('node:url');

const { buildMemberFromTemplate } = require('./process-template');

const CATALOG = path.join(__dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates');
const PROCESS_DIR = path.join(__dirname, '..', 'src', 'pages', 'process');
const esm = (name) => import(pathToFileURL(path.join(PROCESS_DIR, name)).href);

const tpl = (id) => JSON.parse(fs.readFileSync(path.join(CATALOG, `${id}.json`), 'utf8'));

// Instantiate a REAL template the way POST /api/teams does, then reshape the
// member-create body into the bundle-role shape the draft adapter serves.
function memberRole(templateId) {
  const t = tpl(templateId);
  const m = buildMemberFromTemplate(t, {
    teamId: 'team', memberId: `team-${t.id}`, memberDisplayName: t.displayName,
    vars: { repoFullName: 'org/repo', agentId: `team-${t.id}`, teamName: 'Team' },
  });
  return {
    id: m.id, name: t.displayName,
    triggers: m.triggers,
    ...(m.outcomes ? { outcomes: m.outcomes } : {}),
    ...(m.github ? { github: m.github } : {}),
  };
}

test('§8.3 rule 2: a label hand-off onto the reworker template reuses its preset listener', async () => {
  const { wireLabelHandoff } = await esm('wiring-engine.js');
  const { makeDraftLike } = await esm('test-fakes.js');

  const rework = memberRole('reworker');
  const preset = rework.triggers.find(x => x.labelFilter === 'revisions-required');
  assert.ok(preset, 'the shipped reworker template must preset the revisions-required listener');
  const presetPrompt = preset.prompt;
  const bundle = { roles: [{ id: 'reviewer', name: 'Code Reviewer' }, rework], humans: [] };
  const ctx = makeDraftLike(bundle);

  await wireLabelHandoff(ctx, {
    from: 'reviewer', to: rework.id, label: 'revisions-required',
    target: 'pull_request', prompt: 'engine-authored prompt',
  });

  const listeners = rework.triggers.filter(x => x.type === 'github-event' && x.labelFilter === 'revisions-required');
  assert.equal(listeners.length, 1, 'the preset listener is reused, never duplicated');
  assert.equal(listeners[0].id, preset.id);
  assert.equal(listeners[0].prompt, presetPrompt, 'the preset prompt is left untouched');
  assert.deepEqual(listeners[0].claim, { remove: 'revisions-required', add: 'revisions-required:wip' },
    'the migrated preset claim (#1008) survives the wire');
  // The producer side is still written: reviewer gains the setLabel outcome,
  // recording that the label lands on the PR (#2629).
  const reviewer = bundle.roles[0];
  assert.deepEqual(reviewer.outcomes.options.map(o => o.actions).flat(),
    [{ type: 'setLabel', label: 'revisions-required', target: 'pr' }]);
});

test('developer + review gate: one listener, idempotent re-run, preset outcome reused', async () => {
  const { wireReviewGate } = await esm('wiring-engine.js');
  const { makeDraftLike, clone } = await esm('test-fakes.js');

  const ba = memberRole('business-analyst');
  const dev = memberRole('developer');
  const bundle = { roles: [ba, dev], humans: [{ id: 'po', name: 'Product Owner' }] };
  const ctx = makeDraftLike(bundle);
  const gate = { from: ba.id, human: 'po', to: dev.id, artifact: 'issue', gateLabel: 'ready-for-implementation' };

  await wireReviewGate(ctx, gate);
  const once = clone({ roles: bundle.roles, humans: bundle.humans });
  await wireReviewGate(ctx, gate); // re-run: must converge, not duplicate
  assert.deepEqual({ roles: bundle.roles, humans: bundle.humans }, once, 'the gesture is idempotent');

  const listeners = dev.triggers.filter(x => x.type === 'github-event' && x.labelFilter === 'ready-for-implementation');
  assert.equal(listeners.length, 1, 'exactly one gate listener on the developer');
  assert.deepEqual(listeners[0].events, ['issues.labeled'], 'single event, picked from artifact context');
  assert.deepEqual(listeners[0].claim,
    { remove: 'ready-for-implementation', add: 'ready-for-implementation:wip' });
  // The BA template already ships the `opens-issue` outcome — the engine reuses
  // it rather than adding a second openIssue option.
  const openIssue = ba.outcomes.options.filter(o => (o.actions || []).some(a => a.type === 'openIssue'));
  assert.equal(openIssue.length, 1);
  assert.equal(openIssue[0].id, 'opens-issue');
  // The named human carries the triangle's people-half.
  const [po] = bundle.humans;
  assert.deepEqual(po.emits, ['ready-for-implementation']);
  assert.deepEqual(po.consumes, [{ artifact: 'issue', from: ba.id }]);
});

test('a review gate onto the dispatcher template reuses its preset ready-for-implementation listener', async () => {
  const { wireReviewGate } = await esm('wiring-engine.js');
  const { makeDraftLike } = await esm('test-fakes.js');

  const ba = memberRole('business-analyst');
  const dispatcher = memberRole('dispatcher');
  const preset = dispatcher.triggers.find(x => x.labelFilter === 'ready-for-implementation');
  assert.ok(preset, 'the shipped dispatcher template must preset the ready-for-implementation listener');
  const presetPrompt = preset.prompt;
  const bundle = { roles: [ba, dispatcher], humans: [{ id: 'po', name: 'Product Owner' }] };
  const ctx = makeDraftLike(bundle);

  await wireReviewGate(ctx, {
    from: ba.id, human: 'po', to: dispatcher.id, artifact: 'issue', gateLabel: 'ready-for-implementation',
  });

  const listeners = dispatcher.triggers.filter(x => x.type === 'github-event' && x.labelFilter === 'ready-for-implementation');
  assert.equal(listeners.length, 1, 'the preset listener is reused, never duplicated');
  assert.equal(listeners[0].id, preset.id);
  assert.equal(listeners[0].prompt, presetPrompt, 'the preset prompt is left untouched');
});
