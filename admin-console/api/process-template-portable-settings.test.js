'use strict';
// Portable role settings in a process-template bundle (#2813): memory
// requirement, model, prompt mode + team prompt, the github flags and the
// pool workspace/workSource — export → validate → materialise round trip, and
// the infrastructure fields that must NEVER ride a bundle (AC17).

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildProcessTemplate, validateProcessTemplate, coerceImportBundle, templateToCustomRoles,
  buildMemberFromTemplate, resolveBundleModels, staleModelPin, promptModeWarnings, portableTeamPrompt,
} = require('./process-template');

const liveRoles = [
  {
    id: 'acme-dev', displayName: 'Developer', role: 'team-member', sessionPolicy: 'per-invocation',
    systemPrompt: 'Also run the linter.', promptMode: 'additional',
    modelOverride: 'ignored-live-key', model: 'claude-sonnet-5', memoryLimit: '4G',
    github: { producesPr: true },
    pool: {
      enabled: true, maxInstances: 2, workspace: 'none',
      workSource: { items: ['a', 'b'], outputDir: 'out', inputDir: 'in' },
    },
    triggers: [],
    // Infrastructure — never portable (AC17).
    environmentId: 'env-1', llmEndpointId: 'prov-1', agentRepositories: [{ url: 'git@x:y.git' }],
    contextMounts: [{ hostPath: '/data' }], skillsOverride: ['cobol'], mcpServersOverride: [{ serverId: 'wiki' }],
    pluginsOverride: ['jira'], env: { SECRET: 'x' },
  },
  {
    id: 'acme-qa', displayName: 'QA', role: 'team-member', systemPrompt: '', promptMode: 'inherit', triggers: [],
  },
];

function exportBundle(extra = {}) {
  return buildProcessTemplate({
    name: 'Acme', level: 'live', teamId: 'acme', roles: liveRoles, wipLimit: 3,
    teamPrompt: 'You work on {{repoFullName}}.', ...extra,
  });
}

test('export carries memory, model, prompt mode, team prompt, github flags and pool (AC2/AC8/AC11/AC12/AC15)', () => {
  const b = exportBundle();
  const dev = b.roles.find(r => r.id === 'dev');
  assert.equal(dev.memoryLimit, '4g', 'normalised');
  assert.equal(dev.model, 'claude-sonnet-5');
  assert.equal(dev.promptMode, 'additional');
  assert.equal(dev.systemPrompt, 'Also run the linter.', 'the role\'s own text, not a flattened prompt');
  assert.deepEqual(dev.github, { producesPr: true });
  assert.equal(dev.pool.workspace, 'none');
  assert.deepEqual(dev.pool.workSource, { items: ['a', 'b'], outputDir: 'out', inputDir: 'in' });
  assert.equal(b.teamPrompt, 'You work on {{repoFullName}}.');
  const qa = b.roles.find(r => r.id === 'qa');
  assert.ok(!('model' in qa) && !('memoryLimit' in qa), 'defaults are omitted');
  assert.equal(validateProcessTemplate(b).ok, true);
});

test('no infrastructure field ever appears in a bundle (AC17)', () => {
  const json = JSON.stringify(exportBundle());
  for (const k of ['environmentId', 'llmEndpointId', 'agentRepositories', 'repositories', 'contextMounts',
    'skillsOverride', 'mcpServersOverride', 'mcpServers', 'pluginsOverride', '"env"', 'modelOverride', 'git@x']) {
    assert.ok(!json.includes(k), `${k} must not be exported`);
  }
});

test('round trip: export → coerce → materialise keeps every portable setting (AC3/AC9/AC13/AC16)', () => {
  const { bundle } = coerceImportBundle(JSON.parse(JSON.stringify(exportBundle())), { clampMemory: true });
  assert.equal(validateProcessTemplate(bundle).ok, true);
  const [dev, qa] = templateToCustomRoles(bundle);
  const m = buildMemberFromTemplate(dev, {
    teamId: 'acme2', memberId: 'acme2-dev', memberDisplayName: 'Developer', vars: { repoFullName: 'o/r', agentId: 'acme2-dev' },
  });
  assert.equal(m.promptMode, 'additional');
  assert.equal(m.modelOverride, 'claude-sonnet-5');
  assert.equal(m.memoryLimit, '4g');
  assert.equal(m.systemPromptOverride, 'Also run the linter.');
  const q = buildMemberFromTemplate(qa, { teamId: 'acme2', memberId: 'acme2-qa', memberDisplayName: 'QA', vars: {} });
  assert.equal(q.promptMode, 'inherit');
  // Re-export of the materialised member gives the same bundle back.
  const again = buildProcessTemplate({
    name: 'Acme', level: 'live', teamId: 'acme2', wipLimit: 3, teamPrompt: bundle.teamPrompt,
    roles: [{ ...m, id: 'acme2-dev', systemPrompt: m.systemPromptOverride, model: m.modelOverride, pool: bundle.roles[0].pool, github: bundle.roles[0].github, triggers: [] }],
  });
  const r = again.roles[0];
  assert.deepEqual(
    { memoryLimit: r.memoryLimit, model: r.model, promptMode: r.promptMode, pool: r.pool, github: r.github },
    { memoryLimit: '4g', model: 'claude-sonnet-5', promptMode: 'additional', pool: bundle.roles[0].pool, github: { producesPr: true } },
  );
});

test('a legacy bundle without promptMode keeps materialising exclusive (AC14)', () => {
  const legacy = { processTemplateVersion: 1, name: 'old', roles: [{ id: 'dev', systemPrompt: 'Do it.', triggers: [] }] };
  assert.equal(validateProcessTemplate(legacy).ok, true);
  const [dev] = templateToCustomRoles(legacy);
  assert.ok(!('promptMode' in dev));
  const m = buildMemberFromTemplate(dev, { teamId: 't', memberId: 't-dev', memberDisplayName: 'Dev', vars: {} });
  assert.ok(!('promptMode' in m), 'no explicit mode → the orchestrator infers exclusive from the prompt');
  assert.equal(m.systemPromptOverride, 'Do it.');
});

test('invalid role settings are rejected with a message naming the role (AC4)', () => {
  const base = (role) => ({ processTemplateVersion: 1, name: 'x', roles: [{ id: 'dev', systemPrompt: 'p', triggers: [], ...role }] });
  for (const bad of ['lots', '-1g', '0g', '4']) {
    const v = validateProcessTemplate(base({ memoryLimit: bad }));
    assert.equal(v.ok, false, bad);
    assert.match(v.error, /role dev/);
  }
  assert.match(validateProcessTemplate(base({ memoryLimit: '16g' })).error, /role dev: .*ceiling of 8g/);
  assert.equal(validateProcessTemplate(base({ memoryLimit: '16g' }), { memoryCeiling: '32g' }).ok, true);
  assert.match(validateProcessTemplate(base({ promptMode: 'sometimes' })).error, /role dev: promptMode/);
  assert.equal(validateProcessTemplate(base({ model: 7 })).ok, false);
  assert.equal(validateProcessTemplate({ ...base({}), teamPrompt: 5 }).ok, false);
});

test('materialise clamps a memory requirement above the ceiling, with a warning (AC5)', () => {
  const raw = { processTemplateVersion: 1, name: 'x', roles: [{ id: 'dev', systemPrompt: 'p', memoryLimit: '16g', triggers: [] }] };
  const { bundle, warnings } = coerceImportBundle(raw, { clampMemory: true, memoryCeiling: '8g' });
  assert.equal(bundle.roles[0].memoryLimit, '8g');
  assert.ok(warnings.some(w => /Role dev: memory limit 16g exceeds the platform ceiling of 8g — using 8g\./.test(w)));
  // Without clamping (draft save) the value is left for the validator to refuse.
  assert.equal(coerceImportBundle(raw).bundle.roles[0].memoryLimit, '16g');
});

test('resolveBundleModels: kept when offered, dropped with a warning when not, pending without a provider (AC9)', () => {
  const roles = [{ id: 'dev', model: 'm1' }, { id: 'qa', model: 'm9' }, { id: 'ops' }];
  const ep = { id: 'p1', name: 'Proxy', models: [{ id: 'm1' }] };
  const { roles: out, warnings } = resolveBundleModels(roles, ep);
  assert.equal(out[0].model, 'm1');
  assert.ok(!('model' in out[1]));
  assert.deepEqual(warnings, ['model m9 not available in provider Proxy — using default (role qa)']);
  const pending = resolveBundleModels(roles, null);
  assert.equal(pending.roles[1].model, 'm9', 'no provider bound → kept pending');
  assert.ok(pending.warnings.every(w => /kept pending/.test(w)));
});

test('promptModeWarnings: an inherit role with an empty team prompt warns (edge case)', () => {
  const b = { roles: [{ id: 'qa', promptMode: 'inherit' }, { id: 'dev', promptMode: 'exclusive' }] };
  const w = promptModeWarnings(b);
  assert.equal(w.length, 1);
  assert.match(w[0], /Role qa inherits the team prompt/);
  assert.deepEqual(promptModeWarnings({ ...b, teamPrompt: 'Team prompt' }), []);
});

test('portableTeamPrompt replaces the repo and team name with placeholders (AC17)', () => {
  assert.equal(
    portableTeamPrompt('Team Acme works on org/repo.', { repoFullName: 'org/repo', teamName: 'Acme' }),
    'Team {{teamName}} works on {{repoFullName}}.',
  );
  assert.equal(portableTeamPrompt('   ', { repoFullName: 'org/repo' }), '');
});

test('portableTeamPrompt replaces the team name only as a whole word (review S1)', () => {
  assert.equal(
    portableTeamPrompt('You are on **QA**. Run QAT and SQA checks; QA owns it.', { teamName: 'QA' }),
    'You are on **{{teamName}}**. Run QAT and SQA checks; {{teamName}} owns it.',
  );
  assert.equal(portableTeamPrompt('Team A.B (x) here', { teamName: 'A.B (x)' }), 'Team {{teamName}} here');
  assert.equal(portableTeamPrompt('Team AxB here', { teamName: 'A.B' }), 'Team AxB here', 'regex characters are literal');
});

test('staleModelPin: a pending pin is dropped with a note once a provider without it is bound (AC9)', () => {
  const ep = { id: 'p1', name: 'Proxy', models: [{ id: 'm1' }] };
  assert.equal(staleModelPin({ id: 'a', modelOverride: 'm1' }, ep), null, 'served → applied as is');
  assert.equal(staleModelPin({ id: 'a', modelOverride: 'm9' }, ep),
    'model m9 not available in provider Proxy — using default (agent a)');
  assert.equal(staleModelPin({ id: 'a', modelOverride: 'm9' }, null), null, 'still no provider → stays pending');
  assert.equal(staleModelPin({ id: 'a' }, ep), null, 'no pin');
  assert.equal(staleModelPin({ id: 'a', modelOverride: 'm9', llmEndpointOverride: 'p2' }, ep), null,
    'a per-agent provider override is not affected by the environment provider');
});
