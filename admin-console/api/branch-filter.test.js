'use strict';

// #2570: push-trigger branch filter — write-side parse / validate / normalize.

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseBranchFilter, branchFilterError, normalizeBranchFilter } = require('./branch-filter');
const { rawTriggerError, buildProcessTemplate, templateToCustomRoles, buildMemberFromTemplate } = require('./process-template');
const extract = require('./extract-template');

test('parseBranchFilter: comma split, trim, drop empties and duplicates (AC3)', () => {
  assert.deepEqual(parseBranchFilter(' main , feature/* ,,main'), ['main', 'feature/*']);
  assert.deepEqual(parseBranchFilter(['main', 'dev, release-*']), ['main', 'dev', 'release-*']);
  assert.deepEqual(parseBranchFilter(' , , '), []);
});

test('branchFilterError: blank, absent and usable patterns are valid', () => {
  for (const ok of [undefined, null, '', ' , ', [], 'main', 'feature/*, feature/**', ['release-*', 'fix?'], '**']) {
    assert.equal(branchFilterError(ok), null, JSON.stringify(ok));
  }
});

test('branchFilterError: entries that can never name a branch are rejected with a clear message', () => {
  assert.match(branchFilterError('/'), /"\/" must not start or end with "\/"/);
  assert.match(branchFilterError('main, feature/'), /"feature\/"/);
  assert.match(branchFilterError('a//b'), /"\/\/"/);
  assert.match(branchFilterError(['my branch']), /whitespace/);
  assert.match(branchFilterError('***'), /wildcards/);
  assert.match(branchFilterError(42), /comma-separated string or an array/);
  assert.match(branchFilterError(['main', 7]), /comma-separated string or an array/);
});

test('normalizeBranchFilter: stores the parsed array, removes a blank filter (AC7)', () => {
  assert.deepEqual(normalizeBranchFilter({ branchFilter: ' main ,feature/* ' }).branchFilter, ['main', 'feature/*']);
  const cleared = normalizeBranchFilter({ id: 't', branchFilter: null });
  assert.equal('branchFilter' in cleared, false);
  assert.equal('branchFilter' in normalizeBranchFilter({ branchFilter: ' , ' }), false);
  assert.deepEqual(normalizeBranchFilter({ id: 't' }), { id: 't' });
});

test('rawTriggerError: the trigger write guard rejects an invalid branch filter', () => {
  const t = (branchFilter) => ({ id: 't', type: 'github-event', events: ['push'], repo: 'a/b', branchFilter });
  assert.equal(rawTriggerError(t(['main', 'feature/*'])), null);
  assert.equal(rawTriggerError(t(undefined)), null);
  assert.match(rawTriggerError(t('/')), /branchFilter entry "\/"/);
});

test('the branch filter survives template export → materialise and template extraction', () => {
  const roles = [{
    id: 'acme-builder', displayName: 'Builder', role: 'team-member', systemPrompt: 'Build.',
    triggers: [{ id: 'on-push', type: 'github-event', enabled: true, events: ['push'], repo: 'acme/app',
      branchFilter: ['main', 'release/**'], prompt: 'Build it.' }],
  }];
  const bundle = buildProcessTemplate({ name: 'x', level: 'live', teamId: 'acme', roles });
  assert.deepEqual(bundle.roles[0].triggers[0].branchFilter, ['main', 'release/**']);
  const cr = templateToCustomRoles(bundle);
  assert.deepEqual(cr[0].triggers[0].branchFilter, ['main', 'release/**']);
  const tpl = extract.buildExtractedTemplate({
    id: 'builder', displayName: 'Builder', prompt: 'p', skills: [], triggers: roles[0].triggers, includeTriggers: true,
  });
  assert.deepEqual(tpl.triggers[0].branchFilter, ['main', 'release/**']);
  // …and a member created from that extracted template keeps it (review B1).
  const member = buildMemberFromTemplate(tpl, {
    teamId: 'beta', memberId: 'beta-builder', memberDisplayName: 'Builder',
    vars: { repoFullName: 'beta/app', teamName: 'Beta', agentId: 'beta-builder' },
  });
  const push = member.triggers.find(x => x.id === 'on-push');
  assert.equal(push.repo, 'beta/app');
  assert.deepEqual(push.branchFilter, ['main', 'release/**']);
});

test('buildMemberFromTemplate: no branch filter on the template → none on the member', () => {
  const member = buildMemberFromTemplate({
    displayName: 'Builder',
    triggers: [{ id: 'on-push', type: 'github-event', events: ['push'], branchFilter: ' , ' }],
  }, { teamId: 'beta', memberId: 'beta-builder', vars: { repoFullName: 'beta/app' } });
  assert.equal('branchFilter' in member.triggers[0], false);
});
