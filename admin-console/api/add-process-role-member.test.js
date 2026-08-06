'use strict';

// Locks in the pure transform the members endpoint runs when adding a role from
// a PROCESS template (#1375): a single process-template role →
// templateToCustomRoles → (optional) labelSuffix stamp → buildMemberFromTemplate.
// The endpoint (POST /api/agents/:teamId/members, processTemplateId branch) is a
// thin HTTP shell over exactly this composition, so testing it here covers the
// change without booting Express or the orchestrator.

const test = require('node:test');
const assert = require('node:assert/strict');

const { templateToCustomRoles, buildMemberFromTemplate } = require('./process-template');
const { applyLabelSuffix } = require('./label-suffix');

// A trimmed but faithful `merger` role from dispatched-sdlc.json — a pure
// consumer (label listener) with an internal-transport github-event trigger, a
// cron self-curation trigger, and an outcome.
const MERGER = {
  id: 'merger',
  displayName: 'Merger',
  role: 'team-member',
  sessionPolicy: 'per-invocation',
  stage: 'Build',
  systemPrompt: 'You are the **Merger** on team **{{teamName}}**, working on `{{repoFullName}}`. Merge when `ready-to-merge` is set.',
  triggers: [
    {
      id: 'merge-on-ready-to-merge',
      type: 'github-event',
      events: ['pull_request.labeled'],
      labelFilter: 'ready-to-merge',
      claim: { remove: 'ready-to-merge', add: 'ready-to-merge:wip' },
      from: 'team',
      enabled: true,
      description: 'Woken when the Code Reviewer approves a PR for merge.',
      prompt: 'A pull request was labelled `ready-to-merge`. Merge it.',
      transport: 'internal',
    },
    { id: 'self-curation', type: 'cron', cron: '25 3 * * 1', enabled: true, description: 'Weekly.', prompt: 'Curate.' },
  ],
  outcomes: { mode: 'anyOf', options: [{ id: 'merges-pr', title: 'Merges the PR', when: 'PR is merged', actions: [{ type: 'none' }] }] },
};

const VARS = { teamName: 'Florian 03', repoFullName: 'acme/widgets', branch: 'main' };

function buildMemberBody(role, { teamId, suffix }) {
  let customRole = templateToCustomRoles({ roles: [role] })[0];
  if (suffix) customRole = applyLabelSuffix([customRole], [], suffix).members[0];
  const memberId = `${teamId}-${role.id}`;
  return buildMemberFromTemplate(customRole, {
    teamId,
    memberId,
    memberDisplayName: role.displayName,
    vars: { ...VARS, agentId: memberId },
  });
}

test('merger role → member body: prompt substituted, per-invocation, ids composed', () => {
  const body = buildMemberBody(MERGER, { teamId: 'florian-03' });
  assert.equal(body.id, 'florian-03-merger');
  assert.equal(body.displayName, 'Merger');
  assert.equal(body.sessionPolicy, 'per-invocation');
  assert.ok(body.systemPromptOverride.includes('team **Florian 03**'));
  assert.ok(body.systemPromptOverride.includes('`acme/widgets`'));
  assert.ok(!body.systemPromptOverride.includes('{{'));
});

test('merger role → member body: github-event trigger gets repo + claim + internal transport', () => {
  const body = buildMemberBody(MERGER, { teamId: 'florian-03' });
  const gh = body.triggers.find(t => t.type === 'github-event');
  assert.equal(gh.repo, 'acme/widgets');
  assert.equal(gh.labelFilter, 'ready-to-merge');
  assert.equal(gh.transport, 'internal');
  assert.deepEqual(gh.claim, { remove: 'ready-to-merge', add: 'ready-to-merge:wip' });
  // The self-curation cron survives too.
  assert.ok(body.triggers.some(t => t.type === 'cron' && t.cron === '25 3 * * 1'));
});

test('merger role → member body: a team labelSuffix stamps the label everywhere', () => {
  const body = buildMemberBody(MERGER, { teamId: 't', suffix: 'k3f9' });
  const gh = body.triggers.find(t => t.type === 'github-event');
  assert.equal(gh.labelFilter, 'ready-to-merge-k3f9');
  // Claim is re-derived from the stamped labelFilter, so it carries the suffix too.
  assert.equal(gh.claim.remove, 'ready-to-merge-k3f9');
  assert.equal(gh.claim.add, 'ready-to-merge-k3f9:wip');
  // Backtick-quoted label in the prompt is stamped as well.
  assert.ok(gh.prompt.includes('`ready-to-merge-k3f9`'));
});
