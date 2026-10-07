'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const extract = require('./extract-template');
const store = require('./agent-templates-store');

// A representative live team-member config + triggers (post-substitution).
const MEMBER_CFG = {
  id: 'acme-developer',
  displayName: 'Developer',
  role: 'team-member',
  parentTeamId: 'acme',
  teamId: 'default',
  userId: '@acme-developer:local',
  token: 'secret-token',
  environmentId: 'acme',
  enabled: true,
  sessionPolicy: 'per-invocation',
  stage: 'build',
  labelSuffix: 'ab12',
  parentMemberId: 'acme-architect',
  patternRole: 'author',
};

const MEMBER_TRIGGERS = [
  {
    id: 'on-ready',
    type: 'github-event',
    enabled: true,
    description: 'Implement ready issues',
    prompt: 'Implement the issue for acme/repo.',
    events: ['issues.labeled'],
    repo: 'acme/repo',
    labelFilter: 'ready-ab12',
    claim: { remove: 'ready-ab12', add: 'ready-ab12:wip' },
    transport: 'internal',
    createdAt: '2026-08-01T00:00:00Z',
    activatedAt: '2026-08-01T00:00:00Z',
  },
  {
    id: 'self-curation',
    type: 'cron',
    enabled: true,
    intrinsic: true,
    cron: '2 3 * * *',
    prompt: 'Daily memory curation.',
  },
];

test('buildExtractedTemplate carries prompt, skills, sessionPolicy (AC-5)', () => {
  const t = extract.buildExtractedTemplate({
    id: 'developer-x',
    displayName: 'Developer',
    prompt: 'You are the Developer.',
    skills: ['repo-conventions', 'ci-and-build'],
    sessionPolicy: 'per-invocation',
  });
  assert.equal(t.promptTemplate, 'You are the Developer.');
  assert.deepEqual(t.skills, ['repo-conventions', 'ci-and-build']);
  assert.equal(t.sessionPolicy, 'per-invocation');
  assert.equal(t.templateSchemaVersion, 1);
});

test('runtime/identity + team-composition fields never leak (AC-7)', () => {
  // Pass a full live config as the source — the whitelist must ignore all of it.
  const t = extract.buildExtractedTemplate({
    ...MEMBER_CFG,
    id: 'developer-x',
    displayName: 'Developer',
    prompt: 'p',
    skills: [],
    includeTriggers: true,
    triggers: MEMBER_TRIGGERS,
  });
  for (const forbidden of [
    'userId', 'token', 'environmentId', 'teamId', 'enabled', 'role',
    'stage', 'stages', 'parentTeamId', 'parentMemberId', 'labelSuffix',
  ]) {
    assert.equal(Object.prototype.hasOwnProperty.call(t, forbidden), false,
      `template must not carry ${forbidden}`);
  }
});

test('include-triggers on: inline triggers[] present, team-specific bits stripped (AC-6)', () => {
  const t = extract.buildExtractedTemplate({
    id: 'developer-x', displayName: 'Developer', prompt: 'p', skills: [],
    triggers: MEMBER_TRIGGERS, includeTriggers: true,
  });
  assert.equal(Array.isArray(t.triggers), true);
  assert.equal(t.triggers.length, 2);
  const gh = t.triggers.find(x => x.id === 'on-ready');
  assert.equal(gh.promptTemplate, 'Implement the issue for acme/repo.');
  assert.deepEqual(gh.events, ['issues.labeled']);
  assert.equal(gh.labelFilter, 'ready-ab12');
  // Runtime/team-specific fields must be gone.
  for (const dropped of ['repo', 'claim', 'transport', 'createdAt', 'activatedAt', 'prompt']) {
    assert.equal(Object.prototype.hasOwnProperty.call(gh, dropped), false,
      `trigger must not carry ${dropped}`);
  }
  const cron = t.triggers.find(x => x.id === 'self-curation');
  assert.equal(cron.cron, '2 3 * * *');
  assert.equal(cron.intrinsic, true);
});

test('include-triggers off: no triggers[] (AC-6)', () => {
  const t = extract.buildExtractedTemplate({
    id: 'developer-x', displayName: 'Developer', prompt: 'p', skills: [],
    triggers: MEMBER_TRIGGERS, includeTriggers: false,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(t, 'triggers'), false);
});

test('include-triggers on but no triggers → absent triggers[] (edge case)', () => {
  const t = extract.buildExtractedTemplate({
    id: 'developer-x', displayName: 'Developer', prompt: 'p', skills: [],
    triggers: [], includeTriggers: true,
  });
  assert.equal(Object.prototype.hasOwnProperty.call(t, 'triggers'), false);
});

test('sanitizeTemplateTrigger drops unsupported + derived triggers', () => {
  assert.equal(extract.sanitizeTemplateTrigger({ id: 'l', type: 'loop', cron: '' }), null);
  assert.equal(extract.sanitizeTemplateTrigger({ id: 'd', type: 'github-event', dataFlow: true }), null);
  assert.equal(extract.sanitizeTemplateTrigger({ id: 'c', type: 'github-event', channel: true }), null);
  assert.equal(extract.sanitizeTemplateTrigger({ type: 'cron', cron: '* * * * *' }), null); // no id
});

test('the produced template passes the store validator (AC-4 create path)', () => {
  const t = extract.buildExtractedTemplate({
    id: 'developer-x', displayName: 'Developer',
    description: 'A tuned developer.', category: 'reactive', patternRole: 'author',
    prompt: 'You are the Developer.', skills: ['repo-conventions'],
    sessionPolicy: 'per-invocation', triggers: MEMBER_TRIGGERS, includeTriggers: true,
  });
  const { valid, errors } = store.validateTemplate(t, { requireId: true });
  assert.equal(valid, true, `expected valid, got: ${errors.join('; ')}`);
});

test('a very long prompt is stored in full (edge case)', () => {
  const long = 'x'.repeat(50000);
  const t = extract.buildExtractedTemplate({ id: 'a', displayName: 'A', prompt: long });
  assert.equal(t.promptTemplate.length, 50000);
});

test('suggestTemplateId slugifies and de-dupes across both tiers (AC-2/AC-9)', () => {
  assert.equal(extract.suggestTemplateId('COBOL_Agent.v2', new Set()), 'cobol-agent-v2');
  assert.equal(extract.suggestTemplateId('acme-developer', new Set(['acme-developer'])), 'acme-developer-2');
  assert.equal(
    extract.suggestTemplateId('dev', new Set(['dev', 'dev-2', 'dev-3'])),
    'dev-4',
  );
  assert.equal(extract.suggestTemplateId('---', new Set()), 'agent-template');
});

test('category / patternRole inference from the source role (AC-2)', () => {
  // Standalone persistent chat agent.
  assert.equal(extract.inferTemplateCategory({ sessionPolicy: 'persistent' }, []), 'chat');
  assert.equal(extract.inferPatternRole({}, 'chat'), 'companion');
  // Reactive: per-invocation or event-driven.
  assert.equal(extract.inferTemplateCategory({ sessionPolicy: 'per-invocation' }, []), 'reactive');
  assert.equal(
    extract.inferTemplateCategory({}, [{ type: 'github-event' }]), 'reactive');
  // An explicit source patternRole wins.
  assert.equal(extract.inferPatternRole({ patternRole: 'scout' }, 'reactive'), 'scout');
  assert.equal(extract.inferPatternRole({}, 'reactive'), 'author');
});

test('round-trip: buildMemberFromTemplate reproduces prompt/sessionPolicy/triggers (AC-8)', () => {
  const processTemplate = require('./process-template');
  const t = extract.buildExtractedTemplate({
    id: 'developer-x', displayName: 'Developer',
    prompt: 'You are the Developer.', skills: ['repo-conventions'],
    sessionPolicy: 'per-invocation', triggers: MEMBER_TRIGGERS, includeTriggers: true,
  });
  const member = processTemplate.buildMemberFromTemplate(t, {
    teamId: 'beta', memberId: 'beta-developer-x', memberDisplayName: 'Developer',
    vars: { repoFullName: 'beta/repo', teamName: 'Beta', agentId: 'beta-developer-x' },
  });
  assert.equal(member.systemPromptOverride, 'You are the Developer.');
  assert.equal(member.sessionPolicy, 'per-invocation');
  // Both non-derived triggers survive the round trip; the github-event one gets
  // its team-specific repo re-injected from vars at materialise time.
  const ids = member.triggers.map(x => x.id).sort();
  assert.deepEqual(ids, ['on-ready', 'self-curation']);
  const gh = member.triggers.find(x => x.id === 'on-ready');
  assert.equal(gh.repo, 'beta/repo');
});

test('sanitizeTemplateTrigger (#2822) keeps a comment listener\'s filters', () => {
  const out = extract.sanitizeTemplateTrigger({
    id: 'answer', type: 'github-event', events: ['issue_comment.created'], prompt: 'Resume.',
    requireLabel: 'clarifying', skipAgentComments: true, target: 'issue',
  });
  assert.equal(out.requireLabel, 'clarifying');
  assert.equal(out.skipAgentComments, true);
  assert.equal(out.target, 'issue');
});
