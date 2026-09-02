import test from 'node:test';
import assert from 'node:assert/strict';

import { presentRoleIds, fulfilledRoleIds, inferMissingRoles } from './missing-roles-view.js';

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

// #1934 — a label suffix may now carry inner hyphens (`team-1`). The strip is
// length-based, so template inference must be unaffected by the extra dash.
test('inferMissingRoles: a hyphen-bearing suffix is stripped just as cleanly', () => {
  const suffixed = DISPATCHED.labels.map(l => ({ name: `${l.name}-team-1` }));
  const team = { id: 't3h', labels: suffixed, labelSuffix: 'team-1' };
  const members = [{ id: 't3h-developer' }, { id: 't3h-code-reviewer' }];
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

/* ── #1556: false-positive "Add role" suggestions ─────────────────────── */

// The real dispatched-sdlc template defines `developer-2` / `business-analyst-2`
// as GENUINELY DISTINCT roles (not multi-instance suffixes of the base role).
const DISPATCHED_DIGITS = {
  id: 'dispatched-sdlc',
  name: 'Dispatched SDLC',
  roles: [
    { id: 'business-analyst', displayName: 'Business Analyst' },
    { id: 'business-analyst-2', displayName: 'Business Analyst 2' },
    { id: 'dispatcher', displayName: 'Dispatcher' },
    { id: 'developer', displayName: 'Developer' },
    { id: 'developer-2', displayName: 'Developer 2' },
    { id: 'code-reviewer', displayName: 'Code Reviewer' },
    { id: 'reworker', displayName: 'Reworker' },
    { id: 'merger', displayName: 'Merger' },
    { id: 'documentation-sync', displayName: 'Documentation Sync' },
  ],
  labels: DISPATCHED.labels,
};

test('fulfilledRoleIds: a distinct digit-suffixed role id counts itself, not the base (case 1)', () => {
  const f = fulfilledRoleIds('t', [{ id: 't-developer-2' }], DISPATCHED_DIGITS.roles);
  assert.ok(f.has('developer-2'));      // the exact distinct role is fulfilled
  assert.ok(!f.has('developer'));       // and is NOT collapsed onto the base role
});

test('fulfilledRoleIds: a multi-instance -N of a base role still counts the base (case 3 / no regression)', () => {
  // `code-reviewer-2` is NOT a template role → the -2 is a genuine second
  // instance and must count the base `code-reviewer` as present.
  const f = fulfilledRoleIds('t', [{ id: 't-code-reviewer-2' }], DISPATCHED_DIGITS.roles);
  assert.deepEqual([...f], ['code-reviewer']);
});

test('fulfilledRoleIds: a clone id maps to its role by display name (case 2)', () => {
  const f = fulfilledRoleIds(
    'agent-studio-2-0',
    [{ id: 'agent-studio-2-0-business-analyst-copy', displayName: 'Business Analyst 2' }],
    DISPATCHED_DIGITS.roles,
  );
  assert.ok(f.has('business-analyst-2'));
});

test('fulfilledRoleIds: a non-<teamId>- id is matched by display name (case 3)', () => {
  const f = fulfilledRoleIds(
    'agent-studio-2-0',
    [{ id: 'agent-agent-studio-2-0-documentation-sync', displayName: 'Documentation Sync' }],
    DISPATCHED_DIGITS.roles,
  );
  assert.ok(f.has('documentation-sync'));
});

test('fulfilledRoleIds: display-name match is case-insensitive and trims whitespace', () => {
  const f = fulfilledRoleIds('t', [{ id: 'x', displayName: '  dispatcher  ' }], DISPATCHED_DIGITS.roles);
  assert.ok(f.has('dispatcher'));
});

test('inferMissingRoles: the reported agent-studio-2-0 state offers ONLY Dispatcher', () => {
  // Team already has Developer 2 (digit role), Business Analyst 2 (clone),
  // Documentation Sync (doubled-prefix id) — plus the base loop roles. The only
  // genuinely missing role is Dispatcher.
  const team = { id: 'agent-studio-2-0', labels: DISPATCHED_DIGITS.labels };
  const members = [
    { id: 'agent-studio-2-0-business-analyst', displayName: 'Business Analyst' },
    { id: 'agent-studio-2-0-business-analyst-copy', displayName: 'Business Analyst 2' },
    { id: 'agent-studio-2-0-developer', displayName: 'Developer' },
    { id: 'agent-studio-2-0-developer-2', displayName: 'Developer 2' },
    { id: 'agent-studio-2-0-code-reviewer', displayName: 'Code Reviewer' },
    { id: 'agent-studio-2-0-reworker', displayName: 'Reworker' },
    { id: 'agent-studio-2-0-merger', displayName: 'Merger' },
    { id: 'agent-agent-studio-2-0-documentation-sync', displayName: 'Documentation Sync' },
  ];
  const res = inferMissingRoles(team, members, [CORE, DISPATCHED_DIGITS, EXTENDED]);
  assert.equal(res.templateId, 'dispatched-sdlc');
  assert.deepEqual(res.missing.map(m => m.id), ['dispatcher']);
  assert.equal(res.missing[0].displayName, 'Dispatcher');
});

test('inferMissingRoles: both developer and developer-2 filled → neither is missing (edge)', () => {
  const team = { id: 't', labels: DISPATCHED_DIGITS.labels };
  const members = [
    { id: 't-developer', displayName: 'Developer' },
    { id: 't-developer-2', displayName: 'Developer 2' },
    { id: 't-code-reviewer', displayName: 'Code Reviewer' },
  ];
  const res = inferMissingRoles(team, members, [CORE, DISPATCHED_DIGITS, EXTENDED]);
  const missingIds = res.missing.map(m => m.id);
  assert.ok(!missingIds.includes('developer'));
  assert.ok(!missingIds.includes('developer-2'));
});

test('inferMissingRoles: a template with no digit-suffixed role is unaffected (edge)', () => {
  // core-sdlc has no `-N` roles; a `t-developer-2` member is a real 2nd
  // Developer and must still count `developer` present (base-role behaviour).
  const team = { id: 't', labels: CORE.labels };
  const members = [
    { id: 't-business-analyst', displayName: 'Business Analyst' },
    { id: 't-developer', displayName: 'Developer' },
    { id: 't-developer-2', displayName: 'Developer' },
    { id: 't-code-reviewer', displayName: 'Code Reviewer' },
  ];
  const res = inferMissingRoles(team, members, TEMPLATES);
  assert.equal(res.templateId, 'core-sdlc');
  assert.deepEqual(res.missing.map(m => m.id), ['reworker']);
});
