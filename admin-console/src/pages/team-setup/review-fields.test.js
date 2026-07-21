import test from 'node:test';
import assert from 'node:assert/strict';

import { buildReviewFields, knowledgeLearningValue, knowledgeGateSummary } from './review-fields.js';

// Minimal stand-ins for the constants the real KnowledgeLearningConfig module
// exports (that module imports React, so it cannot be loaded under node:test).
const KNOWLEDGE_META = {
  defaults: { autonomy: 1, review: true, gates: {} },
  autonomyLevels: [
    { level: 0, label: 'Off' },
    { level: 1, label: 'Guided' },
    { level: 2, label: 'Autonomous' },
  ],
  gateOrder: ['agent>team', 'team>global'],
  gateLabels: { 'agent>team': 'Agent → Team', 'team>global': 'Team → Global' },
};

const baseForm = {
  teamName: 'Alpha Squad',
  teamId: 'alpha',
  environmentId: 'env-1',
  repoUrl: 'git@github.com:acme/widgets.git',
  branch: 'develop',
  sshKeyId: 'k1',
  githubTokenId: 't1',
  skills: ['agent-studio-dev', 'code-review'],
  knowledgeConfig: { autonomy: 2, review: false, gates: { 'agent>team': 'auto' } },
};

const env = { id: 'env-1', name: 'Studio' };
const sshKey = { id: 'k1', name: 'deploy-key' };
const ghToken = { id: 't1', name: 'ci-token' };

function byKey(fields) {
  return Object.fromEntries(fields.map(f => [f.key, f.value]));
}

test('buildReviewFields returns every scalar field in order', () => {
  const fields = buildReviewFields({ form: baseForm, env, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META });
  assert.deepEqual(
    fields.map(f => f.key),
    ['team', 'environment', 'repository', 'sshKey', 'githubToken', 'skills', 'knowledge'],
  );
  // No information dropped in the compaction (#760 AC2).
  assert.equal(fields.length, 7);
});

test('resolved values render name + id / url + branch', () => {
  const v = byKey(buildReviewFields({ form: baseForm, env, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META }));
  assert.equal(v.team, 'Alpha Squad (alpha)');
  assert.equal(v.environment, 'Studio (env-1)');
  assert.equal(v.repository, 'git@github.com:acme/widgets.git @ develop');
  assert.equal(v.sshKey, 'deploy-key');
  assert.equal(v.githubToken, 'ci-token');
  assert.equal(v.skills, 'agent-studio-dev, code-review');
});

test('empty / default states use — placeholders (#760 AC6)', () => {
  const form = {
    teamName: 'Solo', teamId: 'solo',
    environmentId: '', repoUrl: '', branch: '',
    sshKeyId: null, githubTokenId: null, skills: [],
  };
  const v = byKey(buildReviewFields({ form, env: undefined, sshKey: undefined, ghToken: undefined, knowledgeMeta: KNOWLEDGE_META }));
  assert.equal(v.environment, '—');
  assert.equal(v.sshKey, '—');
  assert.equal(v.githubToken, '—');
  assert.equal(v.skills, '—');
  // Missing branch falls back to main.
  assert.equal(v.repository, ' @ main');
});

test('environment falls back to raw id when the lookup misses', () => {
  const form = { ...baseForm, environmentId: 'ghost' };
  const v = byKey(buildReviewFields({ form, env: undefined, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META }));
  assert.equal(v.environment, 'ghost');
});

test('knowledgeGateSummary marks team>global as always reviewed and honours auto/review', () => {
  const summary = knowledgeGateSummary(
    { gates: { 'agent>team': 'auto' } },
    KNOWLEDGE_META.gateOrder,
    KNOWLEDGE_META.gateLabels,
  );
  assert.equal(summary, 'Agent → Team: automatic · Team → Global: always reviewed');
});

test('knowledgeLearningValue composes autonomy + level label + review + gates', () => {
  const value = knowledgeLearningValue(baseForm, KNOWLEDGE_META);
  assert.equal(
    value,
    'Autonomy 2 · Autonomous · Review off · Agent → Team: automatic · Team → Global: always reviewed',
  );
});

test('knowledgeLearningValue falls back to defaults when no config on the form', () => {
  const value = knowledgeLearningValue({ ...baseForm, knowledgeConfig: undefined }, KNOWLEDGE_META);
  assert.equal(
    value,
    'Autonomy 1 · Guided · Review on · Agent → Team: needs review · Team → Global: always reviewed',
  );
});
