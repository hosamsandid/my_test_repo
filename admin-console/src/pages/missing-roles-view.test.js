import test from 'node:test';
import assert from 'node:assert/strict';

import { presentRoleIds, inferMissingRoles } from './missing-roles-view.js';

// Reference templates trimmed to the fields the inference reads.
const CORE = {
  id: 'core-sdlc',
  name: 'Core SDLC',
  roles: [
    { id: 'business-analyst', displayName: 'Business Analyst' },
    { id: 'developer', displayName: 'Developer' },
    { id: 'code-reviewer', displayName: 'Code Reviewer' },
    { id: 'reworker', displayName: 'Reworker' },
  ],
  labels: [
    { name: 'ready-for-implementation' }, { name: 'ready-for-review' },
    { name: 'revisions-required' }, { name: 'ready-to-merge' },
    { name: 'human-decision-required' },
  ],
};
const DISPATCHED = {
  id: 'dispatched-sdlc',
  name: 'Dispatched SDLC',
  roles: [
    { id: 'business-analyst', displayName: 'Business Analyst' },
    { id: 'dispatcher', displayName: 'Dispatcher' },
    { id: 'developer', displayName: 'Developer' },
    { id: 'code-reviewer', displayName: 'Code Reviewer' },
    { id: 'reworker', displayName: 'Reworker' },
    { id: 'merger', displayName: 'Merger' },
    { id: 'documentation-sync', displayName: 'Documentation Sync' },
  ],
  labels: [
    { name: 'ready-for-implementation-a' }, { name: 'ready-for-implementation-b' },
    { name: 'ready-for-review' }, { name: 'revisions-required' },
    { name: 'ready-to-merge' }, { name: 'approved-for-dispatch' },
  ],
};
const EXTENDED = {
  id: 'extended-sdlc',
  name: 'Extended SDLC',
  roles: [
    { id: 'issue-triage', displayName: 'Issue Triage' },
    { id: 'developer', displayName: 'Developer' },
    { id: 'code-reviewer', displayName: 'Code Reviewer' },
  ],
  labels: [
    { name: 'needs-refinement' }, { name: 'requirements-approved' },
    { name: 'design-author-go' },
  ],
};
const TEMPLATES = [CORE, DISPATCHED, EXTENDED];

test('presentRoleIds: strips the <teamId>- prefix from member ids', () => {
  const present = presentRoleIds('florian-03', [
    { id: 'florian-03-developer' },
    { id: 'florian-03-code-reviewer' },
  ]);
  assert.deepEqual([...present].sort(), ['code-reviewer', 'developer']);
});

test('presentRoleIds: trims a multi-instance -N suffix to the base role', () => {
  const present = presentRoleIds('t1', [{ id: 't1-developer' }, { id: 't1-developer-2' }]);
  assert.deepEqual([...present], ['developer']);
});

test('presentRoleIds: ignores members that do not carry the team prefix', () => {
  const present = presentRoleIds('t1', [{ id: 'other-agent' }, { id: 't1-developer' }]);
  assert.deepEqual([...present], ['developer']);
});

test('inferMissingRoles: label registry disambiguates the source template (dispatched)', () => {
  // florian-03: dev + reviewer + an extra non-template role, dispatched registry.
  const team = { id: 'florian-03', labels: DISPATCHED.labels };
  const members = [
    { id: 'florian-03-developer' },
    { id: 'florian-03-code-reviewer' },
    { id: 'florian-03-repo-expert' },
  ];
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res.templateId, 'dispatched-sdlc');
  const missingIds = res.missing.map(m => m.id);
  // The loop-closing roles the issue cares about must be surfaced.
  assert.ok(missingIds.includes('merger'));
  assert.ok(missingIds.includes('reworker'));
  // Present roles (and the extra non-template role) are never listed as missing.
  assert.ok(!missingIds.includes('developer'));
  assert.ok(!missingIds.includes('code-reviewer'));
  assert.ok(!missingIds.includes('repo-expert'));
  assert.equal(res.missing.find(m => m.id === 'merger').displayName, 'Merger');
});

test('inferMissingRoles: the same role set with the core registry picks core, not dispatched', () => {
  const team = { id: 't2', labels: CORE.labels };
  const members = [{ id: 't2-developer' }, { id: 't2-code-reviewer' }];
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res.templateId, 'core-sdlc');
  assert.deepEqual(res.missing.map(m => m.id).sort(), ['business-analyst', 'reworker']);
});

test('inferMissingRoles: suffix-stamped team labels still match the source template', () => {
  const suffixed = DISPATCHED.labels.map(l => ({ name: `${l.name}-k3f9` }));
  const team = { id: 't3', labels: suffixed, labelSuffix: 'k3f9' };
  const members = [{ id: 't3-developer' }, { id: 't3-code-reviewer' }];
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res.templateId, 'dispatched-sdlc');
});

test('inferMissingRoles: no label registry falls back to a clear role-id overlap', () => {
  const team = { id: 't4' }; // no labels
  const members = [
    { id: 't4-business-analyst' }, { id: 't4-developer' }, { id: 't4-code-reviewer' },
  ];
  const res = inferMissingRoles(team, members, TEMPLATES);
  // core-sdlc: overlap 3 (ba, dev, cr); dispatched overlap 3 too but core is a
  // tie — tie is NOT a clear winner, so with equal overlap we surface nothing.
  // Confirm the ambiguous-tie guard: both core & dispatched overlap 3.
  assert.equal(res, null);
});

test('inferMissingRoles: no label registry but a clear overlap winner is inferred', () => {
  const team = { id: 't4b' }; // no labels
  // issue-triage is unique to extended-sdlc, so overlap clearly favours it.
  const members = [{ id: 't4b-issue-triage' }, { id: 't4b-developer' }];
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res.templateId, 'extended-sdlc');
  assert.deepEqual(res.missing.map(m => m.id), ['code-reviewer']);
});

test('inferMissingRoles: fully-covered team surfaces nothing', () => {
  const team = { id: 't5', labels: CORE.labels };
  const members = CORE.roles.map(r => ({ id: `t5-${r.id}` }));
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res, null);
});

test('inferMissingRoles: empty team surfaces nothing', () => {
  assert.equal(inferMissingRoles({ id: 't6', labels: CORE.labels }, [], TEMPLATES), null);
});

test('inferMissingRoles: a team whose labels match no template surfaces nothing', () => {
  const team = { id: 't7', labels: [{ name: 'totally-custom-label' }] };
  const members = [{ id: 't7-developer' }, { id: 't7-code-reviewer' }, { id: 't7-thing' }];
  // Label containment fails for every template; role overlap (dev+cr=2) ties
  // across core/dispatched/extended → no clear winner → null.
  assert.equal(inferMissingRoles(team, members, TEMPLATES), null);
});

test('inferMissingRoles: guards missing/empty inputs', () => {
  assert.equal(inferMissingRoles(null, [], TEMPLATES), null);
  assert.equal(inferMissingRoles({ id: 't' }, [{ id: 't-developer' }], []), null);
  assert.equal(inferMissingRoles({ id: 't' }, [{ id: 't-developer' }], null), null);
});
