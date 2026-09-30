import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildReviewFields, knowledgeLearningValue, knowledgeGateSummary, credentialValue, githubIdentityValue,
} from './review-fields.js';

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

test('buildReviewFields returns every scalar field in order (no-suffix case)', () => {
  const fields = buildReviewFields({ form: baseForm, env, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META });
  assert.deepEqual(
    fields.map(f => f.key),
    ['team', 'environment', 'repository', 'sshKey', 'githubToken', 'skills', 'knowledge'],
  );
  // No information dropped in the compaction (#760 AC2). 7 = baseForm has no
  // labelSuffix, so the optional suffix row is absent (see suffix test below).
  assert.equal(fields.length, 7);
});

test('labelSuffix row appears after team row when suffix is set', () => {
  const form = { ...baseForm, labelSuffix: 'k3f9' };
  const fields = buildReviewFields({ form, env, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META });
  assert.equal(fields.length, 8);
  assert.equal(fields[1].key, 'labelSuffix');
  assert.equal(fields[1].value, 'k3f9');
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
  // #2658: a repo-less, environment-less team says so instead of " @ main".
  assert.equal(v.environment, 'none (a fresh one is created for this team)');
  assert.equal(v.repository, 'none (repo-less team)');
  assert.equal(v.sshKey, 'none');
  assert.equal(v.githubToken, 'none');
  assert.equal(v.skills, '—');
});

test('a missing branch falls back to main', () => {
  const v = byKey(buildReviewFields({ form: { ...baseForm, branch: '' }, env, sshKey, ghToken, knowledgeMeta: KNOWLEDGE_META }));
  assert.equal(v.repository, 'git@github.com:acme/widgets.git @ main');
});

// ── #2658: credentials the caller cannot see ─────────────────────────────────

test('a credential hidden from the caller reads from the env descriptor, never as none', () => {
  const credentialRefs = {
    k1: { id: 'k1', kind: 'ssh-key', tier: 'team', ownerLabel: 'Platform', visibleToCaller: false },
    t1: { id: 't1', kind: 'github-token', tier: 'personal', ownerLabel: 'Thorsten', visibleToCaller: false },
  };
  const v = byKey(buildReviewFields({
    form: baseForm, env, sshKey: undefined, ghToken: undefined, credentialRefs, knowledgeMeta: KNOWLEDGE_META,
  }));
  assert.equal(v.sshKey, 'team SSH key of Platform (hidden)');
  assert.equal(v.githubToken, 'personal token of Thorsten (hidden)');
});

test('credentialValue covers system tier, a visible descriptor, and a not-yet-loaded descriptor', () => {
  assert.equal(
    credentialValue({ id: 't9', ref: { tier: 'system', ownerLabel: 'System', visibleToCaller: false }, noun: 'token' }),
    'system token (hidden)',
  );
  assert.equal(
    credentialValue({ id: 't9', ref: { tier: 'team', ownerLabel: 'Ops', visibleToCaller: true }, noun: 'token' }),
    'team token of Ops',
  );
  assert.equal(credentialValue({ id: 't9', noun: 'token' }), 't9 (not visible to you)');
  // The caller's own row wins over the descriptor.
  assert.equal(
    credentialValue({ id: 't1', visible: ghToken, ref: { tier: 'personal', ownerLabel: 'X' }, noun: 'token' }),
    'ci-token',
  );
  assert.equal(credentialValue({ id: '', noun: 'token' }), 'none');
});

test('the effective GitHub identity row appears only when the caller\'s personal token differs', () => {
  const personalToken = { id: 'p1', name: 'my-pat', scope: 'personal' };
  const fields = buildReviewFields({ form: baseForm, env, sshKey, ghToken, personalToken, knowledgeMeta: KNOWLEDGE_META });
  const keys = fields.map(f => f.key);
  assert.equal(keys[keys.indexOf('githubToken') + 1], 'githubIdentity');
  assert.match(byKey(fields).githubIdentity, /^your personal token my-pat \(used instead of the environment's token/);
  // No personal token, or the env already uses it, or no repository → no row.
  assert.equal(githubIdentityValue({ form: baseForm, personalToken: undefined }), null);
  assert.equal(githubIdentityValue({ form: { ...baseForm, githubTokenId: 'p1' }, personalToken }), null);
  assert.equal(githubIdentityValue({ form: { ...baseForm, repoUrl: '' }, personalToken }), null);
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
