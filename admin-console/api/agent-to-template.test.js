'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const a2t = require('./agent-to-template');
const { validateTemplate } = require('./agent-templates-store');

// ─── slugifyTemplateId / suggestTemplateId ──────────────────────────────────

test('slugifyTemplateId lowercases, collapses non-slug chars, trims hyphens', () => {
  assert.equal(a2t.slugifyTemplateId('COBOL_Agent.v2'), 'cobol-agent-v2');
  assert.equal(a2t.slugifyTemplateId('--weird--'), 'weird');
  assert.equal(a2t.slugifyTemplateId('team-x-developer'), 'team-x-developer');
});

test('slugifyTemplateId falls back to "agent" for an unusable id', () => {
  assert.equal(a2t.slugifyTemplateId('___'), 'agent');
  assert.equal(a2t.slugifyTemplateId(''), 'agent');
  assert.equal(a2t.slugifyTemplateId(null), 'agent');
});

test('suggestTemplateId returns the base slug when free', () => {
  assert.equal(a2t.suggestTemplateId('cobol-agent', new Set()), 'cobol-agent');
  assert.equal(a2t.suggestTemplateId('cobol-agent', ['other']), 'cobol-agent');
});

test('suggestTemplateId de-duplicates with a numeric suffix (both tiers)', () => {
  const taken = new Set(['cobol-agent', 'cobol-agent-2']);
  assert.equal(a2t.suggestTemplateId('cobol-agent', taken), 'cobol-agent-3');
});

// ─── inference (AC2) ─────────────────────────────────────────────────────────

test('inferCategory: per-invocation → reactive, persistent → chat', () => {
  assert.equal(a2t.inferCategory({ sessionPolicy: 'per-invocation' }), 'reactive');
  assert.equal(a2t.inferCategory({ sessionPolicy: 'persistent' }), 'chat');
  assert.equal(a2t.inferCategory({}), 'chat');
});

test('inferCategory prefers an explicit valid category on the config', () => {
  assert.equal(a2t.inferCategory({ category: 'pattern', sessionPolicy: 'per-invocation' }), 'pattern');
  assert.equal(a2t.inferCategory({ category: 'bogus' }), 'chat');
});

test('inferPatternRole: standalone agent → standalone, member → author', () => {
  assert.equal(a2t.inferPatternRole({ role: 'agent' }), 'standalone');
  assert.equal(a2t.inferPatternRole({ role: 'team-member' }), 'author');
});

test('inferPatternRole prefers an explicit valid patternRole', () => {
  assert.equal(a2t.inferPatternRole({ role: 'team-member', patternRole: 'scout' }), 'scout');
  assert.equal(a2t.inferPatternRole({ patternRole: 'nope', role: 'agent' }), 'standalone');
});

// ─── trigger mapping (AC6 / AC8 round-trip) ──────────────────────────────────

test('agentTriggerToTemplateTrigger: cron wake prompt → promptTemplate, stamps dropped', () => {
  const out = a2t.agentTriggerToTemplateTrigger({
    id: 'self-curation', type: 'cron', cron: '14 3 * * *', enabled: true,
    intrinsic: true, description: 'daily', prompt: 'Curate memory.',
    createdAt: '2026-01-01T00:00:00Z', activatedAt: '2026-01-01T00:00:00Z',
  });
  assert.deepEqual(out, {
    id: 'self-curation', type: 'cron', enabled: true, description: 'daily',
    promptTemplate: 'Curate memory.', intrinsic: true, cron: '14 3 * * *',
  });
  assert.ok(!('createdAt' in out) && !('activatedAt' in out) && !('prompt' in out));
});

test('agentTriggerToTemplateTrigger: github-event keeps markers, drops repo', () => {
  const out = a2t.agentTriggerToTemplateTrigger({
    id: 'on-pr', type: 'github-event', events: ['pull_request.opened'],
    repo: 'org/repo', labelFilter: 'ready', claim: { remove: 'ready', add: 'ready:wip' },
    transport: 'internal', dataFlow: true, channel: true, sources: ['x'],
    prompt: 'Review the PR.', createdAt: 'x', activatedAt: 'y', enabled: false,
  });
  assert.equal(out.repo, undefined);
  assert.equal(out.enabled, false);
  assert.deepEqual(out.events, ['pull_request.opened']);
  assert.equal(out.labelFilter, 'ready');
  assert.deepEqual(out.claim, { remove: 'ready', add: 'ready:wip' });
  assert.equal(out.transport, 'internal');
  assert.equal(out.dataFlow, true);
  assert.equal(out.channel, true);
  assert.equal(out.promptTemplate, 'Review the PR.');
});

test('agentTriggerToTemplateTrigger drops loop / unexpressible types', () => {
  assert.equal(a2t.agentTriggerToTemplateTrigger({ id: 'l', type: 'loop', maxIterations: 3 }), null);
  assert.equal(a2t.agentTriggerToTemplateTrigger(null), null);
  assert.equal(a2t.agentTriggerToTemplateTrigger({ id: 'x' }), null);
});

// ─── buildTemplateFromAgent (AC5 / AC7) ──────────────────────────────────────

test('buildTemplateFromAgent carries prompt, skills, sessionPolicy (AC5)', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 'my-tmpl', displayName: 'My Agent', description: '  a helper  ',
    cfg: { role: 'agent', sessionPolicy: 'persistent' },
    effectivePrompt: 'You are helpful.', skills: ['cobol', 'jcl'],
    sessionPolicy: 'persistent',
  });
  assert.equal(t.templateSchemaVersion, 1);
  assert.equal(t.id, 'my-tmpl');
  assert.equal(t.displayName, 'My Agent');
  assert.equal(t.description, 'a helper');
  assert.equal(t.promptTemplate, 'You are helpful.');
  assert.deepEqual(t.skills, ['cobol', 'jcl']);
  assert.equal(t.sessionPolicy, 'persistent');
  assert.equal(t.category, 'chat');
  assert.equal(t.patternRole, 'standalone');
});

test('buildTemplateFromAgent never emits runtime/identity or composition fields (AC7)', () => {
  const cfg = {
    id: 'src', role: 'team-member', userId: '@src:local', token: 'secret',
    environmentId: 'env1', teamId: 'teamA', enabled: true, parentTeamId: 'teamA',
    systemPrompt: 'override', systemPromptTemplate: 'base', stage: 'Build',
    parentMemberId: 'teamA-lead', emits: ['ready'], outcomes: { mode: 'anyOf' },
    github: { producesPr: true }, channels: [{ artifact: 'pr', from: 'x' }],
    dataFlow: { dependsOn: ['y'] }, labelSuffix: 'ab12', skillsOverride: ['s'],
    mcpServersOverride: {}, blueprintId: 'bp', _provisioning: true,
  };
  const t = a2t.buildTemplateFromAgent({
    id: 'neutral', displayName: 'Neutral', cfg,
    effectivePrompt: 'override', skills: ['s'], sessionPolicy: 'per-invocation',
    triggers: [], includeTriggers: true,
  });
  const forbidden = [
    'userId', 'token', 'environmentId', 'teamId', 'enabled', 'role',
    'systemPrompt', 'systemPromptTemplate', 'parentTeamId', 'stage',
    'parentMemberId', 'emits', 'outcomes', 'github', 'channels', 'dataFlow',
    'labelSuffix', 'skillsOverride', 'mcpServersOverride', 'blueprintId', '_provisioning',
  ];
  for (const f of forbidden) assert.ok(!(f in t), `template must not carry ${f}`);
  // Only the known template keys are present.
  assert.deepEqual(
    Object.keys(t).sort(),
    ['category', 'patternRole', 'promptTemplate', 'sessionPolicy', 'skills', 'displayName', 'id', 'templateSchemaVersion'].sort(),
  );
});

test('buildTemplateFromAgent: includeTriggers off → no triggers[] (AC6)', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 't', displayName: 'T', cfg: { role: 'agent' }, effectivePrompt: 'p',
    skills: [], sessionPolicy: 'persistent',
    triggers: [{ id: 'c', type: 'cron', cron: '0 3 * * *', prompt: 'x' }],
    includeTriggers: false,
  });
  assert.ok(!('triggers' in t));
});

test('buildTemplateFromAgent: includeTriggers on but empty set → no triggers[] (edge case)', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 't', displayName: 'T', cfg: { role: 'agent' }, effectivePrompt: 'p',
    skills: [], sessionPolicy: 'persistent', triggers: [], includeTriggers: true,
  });
  assert.ok(!('triggers' in t));
});

test('buildTemplateFromAgent: includeTriggers on with a loop-only set → no triggers[]', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 't', displayName: 'T', cfg: { role: 'agent' }, effectivePrompt: 'p',
    skills: [], sessionPolicy: 'persistent',
    triggers: [{ id: 'l', type: 'loop', maxIterations: 5 }], includeTriggers: true,
  });
  assert.ok(!('triggers' in t));
});

// ─── validation compatibility (persists through the existing create path) ────

test('a template built from an agent passes validateTemplate (requireId)', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 'built', displayName: 'Built', cfg: { role: 'team-member', sessionPolicy: 'per-invocation' },
    effectivePrompt: 'Do the work.', skills: ['cobol'], sessionPolicy: 'per-invocation',
    triggers: [
      { id: 'on-pr', type: 'github-event', events: ['pull_request.opened'], prompt: 'review', repo: 'o/r' },
      { id: 'cur', type: 'cron', cron: '14 3 * * *', prompt: 'curate', intrinsic: true },
    ],
    includeTriggers: true,
  });
  const { valid, errors } = validateTemplate(t, { requireId: true });
  assert.ok(valid, `expected valid template, got errors: ${JSON.stringify(errors)}`);
  assert.equal(t.triggers.length, 2);
});

test('an empty-prompt agent yields a template validateTemplate rejects', () => {
  const t = a2t.buildTemplateFromAgent({
    id: 'blank', displayName: 'Blank', cfg: { role: 'agent' },
    effectivePrompt: '', skills: [], sessionPolicy: 'persistent',
  });
  const { valid, errors } = validateTemplate(t, { requireId: true });
  assert.ok(!valid);
  assert.ok(errors.some(e => /prompt/i.test(e)));
});
