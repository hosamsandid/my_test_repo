import test from 'node:test';
import assert from 'node:assert/strict';

import { readFileSync } from 'node:fs';
import {
  hasOwnSkills, buildInitialForm, buildEditSubmit, displayNameError, isFormDirty, poolSectionError,
  skillPoolTeamId, skillsListUrl,
} from './agent-edit-form-model.js';
import { PROMPT_MODES } from '../prompt-mode-view.js';

/**
 * The agent edit form's shape logic (#1929).
 *
 * It matters twice over now: it is what the Agents page's side panel and the
 * Agent Chat Settings tab must agree on (AC2 — an identical edit produces an
 * identical PUT), and `isFormDirty` is what decides whether a draft has to
 * survive an agent switch (AC6).
 */

const member = {
  id: 'team1-dev', role: 'team-member', displayName: 'Dev',
  parentTeamId: 'team1', teamId: 'team1', environmentId: 'env1',
};

test('skills live on the agent itself only for the non-member roles', () => {
  for (const role of ['team', 'agent']) {
    assert.equal(hasOwnSkills(role), true, `${role} carries its own skills`);
  }
  for (const role of ['team-member', undefined]) {
    assert.equal(hasOwnSkills(role), false, `${role} does not`);
  }
});

test('#1964 — the retired BriefingPack roles carry no own skill grant', () => {
  // A leftover config on an upgraded installation must not open a skill picker
  // whose grant nothing resolves: `orchestrator` left the set with the role.
  for (const role of ['orchestrator', 'bp-instance']) {
    assert.equal(hasOwnSkills(role), false, `${role} is retired`);
  }
});

/* ── buildInitialForm ─────────────────────────────────────────────── */

test('a missing config field becomes an empty control, never undefined', () => {
  const form = buildInitialForm({ id: 'a1', role: 'agent' });
  assert.equal(form.displayName, '');
  assert.deepEqual(form.skills, []);
  assert.equal(form.systemPromptTemplate, '');
  assert.equal(form.promptOverride, '');
  assert.deepEqual(form.mcpRows, []);
});

test('a tolerant call on nothing at all still yields a usable form', () => {
  const form = buildInitialForm(undefined);
  assert.equal(form.displayName, '');
  assert.equal(form.promptMode, PROMPT_MODES.INHERIT);
});

test('inheritance is absence, not emptiness — an empty override is a real override', () => {
  const inheriting = buildInitialForm(member);
  assert.equal(inheriting.inheritSkills, true);
  assert.equal(inheriting.inheritMcp, true);

  const emptyOverride = buildInitialForm({ ...member, skillsOverride: [], mcpServersOverride: [] });
  assert.equal(emptyOverride.inheritSkills, false, 'an explicit [] means "override with nothing"');
  assert.equal(emptyOverride.inheritMcp, false);
});

test('only a team-member can be inheriting — a standalone agent never is', () => {
  const form = buildInitialForm({ id: 'a1', role: 'agent' });
  assert.equal(form.inheritSkills, false);
  assert.equal(form.inheritMcp, false);
  assert.equal(form.promptMode, PROMPT_MODES.INHERIT, 'the field exists but is unused off-role');
});

test('the MCP override becomes picker rows, a missing credential an empty choice (#2289)', () => {
  const form = buildInitialForm({
    ...member,
    mcpServersOverride: [
      { serverId: 'wiki', credentialId: 'wiki-team-a' },
      { serverId: 'graph', credentialId: null },
    ],
  });
  assert.deepEqual(form.mcpRows, [
    { serverId: 'wiki', credentialId: 'wiki-team-a' },
    { serverId: 'graph', credentialId: '' },
  ]);
  assert.ok(!('mcpOverrideText' in form), 'the free-text field is gone');
});

test('the legacy systemPrompt-presence inference still resolves a mode', () => {
  // No explicit promptMode — a member carrying a systemPrompt predates #1511.
  const legacy = buildInitialForm({ ...member, systemPrompt: 'be brief' });
  assert.equal(legacy.promptMode, PROMPT_MODES.EXCLUSIVE);
  assert.equal(legacy.promptOverride, 'be brief');
});

/* ── buildEditSubmit ──────────────────────────────────────────────── */

test('a role never sends a section it does not have', () => {
  const agent = { id: 'a1', role: 'agent', displayName: 'A' };
  const body = buildEditSubmit(agent, buildInitialForm(agent));
  assert.deepEqual(Object.keys(body).sort(), ['displayName', 'skills']);
  // Sending these as empty would CLEAR them server-side for a role that has
  // no such field — absence is the only safe encoding.
  assert.ok(!('systemPromptTemplate' in body));
  assert.ok(!('promptMode' in body));
  assert.ok(!('skillsOverride' in body));
});

test('a team sends its prompt template and its own skills, not member fields', () => {
  const team = { id: 't1', role: 'team', displayName: 'T', systemPromptTemplate: 'be a team' };
  const body = buildEditSubmit(team, buildInitialForm(team));
  assert.equal(body.systemPromptTemplate, 'be a team');
  assert.deepEqual(body.skills, []);
  assert.ok(!('mcpServersOverride' in body));
});

test('inherit clears the override with null, not with an empty value', () => {
  const body = buildEditSubmit(member, buildInitialForm(member));
  assert.equal(body.promptMode, PROMPT_MODES.INHERIT);
  assert.equal(body.systemPrompt, null, 'null is what deletes the key server-side');
  assert.equal(body.skillsOverride, null);
  assert.equal(body.mcpServersOverride, null);
});

test('additional mode sends the addition alone, exclusive the whole text', () => {
  const form = { ...buildInitialForm(member), promptMode: PROMPT_MODES.ADDITIONAL, promptOverride: 'also this' };
  assert.equal(buildEditSubmit(member, form).systemPrompt, 'also this');
  const excl = { ...form, promptMode: PROMPT_MODES.EXCLUSIVE };
  assert.equal(buildEditSubmit(member, excl).systemPrompt, 'also this');
  assert.equal(buildEditSubmit(member, excl).promptMode, PROMPT_MODES.EXCLUSIVE);
});

test('Custom MCP rows are sent as {serverId, credentialId} refs, no credential as null (#2289)', () => {
  const form = {
    ...buildInitialForm(member),
    inheritMcp: false,
    mcpRows: [
      { serverId: 'wiki', credentialId: 'wiki-team-a' },
      { serverId: 'graph', credentialId: '' },
    ],
  };
  assert.deepEqual(buildEditSubmit(member, form).mcpServersOverride, [
    { serverId: 'wiki', credentialId: 'wiki-team-a' },
    { serverId: 'graph', credentialId: null },
  ]);
});

test('an empty Custom MCP set is sent as [] — "no servers", distinct from inherit (AC8)', () => {
  const custom = { ...buildInitialForm(member), inheritMcp: false, mcpRows: [] };
  assert.deepEqual(buildEditSubmit(member, custom).mcpServersOverride, []);
  const inherit = { ...custom, inheritMcp: true, mcpRows: [{ serverId: 'wiki', credentialId: '' }] };
  assert.equal(buildEditSubmit(member, inherit).mcpServersOverride, null, 'rows are not sent in Inherit');
});

test('a ref to a server the editor cannot see survives a round trip unchanged', () => {
  const hidden = { ...member, mcpServersOverride: [{ serverId: 'team-b-only', credentialId: 'cred-b' }] };
  assert.deepEqual(buildEditSubmit(hidden, buildInitialForm(hidden)).mcpServersOverride, [
    { serverId: 'team-b-only', credentialId: 'cred-b' },
  ]);
});

test('the plugin grant and the context mounts are never part of the PUT', () => {
  // Both apply immediately through their own endpoints (AC3); batching them
  // here would make one Save mean two different commit models.
  const agent = {
    id: 'a1', role: 'agent', displayName: 'A',
    plugins: [{ id: 'p1' }], contextMounts: [{ path: '/tmp', slug: 'tmp' }],
  };
  const body = buildEditSubmit(agent, buildInitialForm(agent));
  assert.ok(!('plugins' in body));
  assert.ok(!('contextMounts' in body));
  assert.ok(!('contextMount' in body));
});

test('#1964 — briefingsPath is neither derived nor sent, even when the config has one', () => {
  // The Mission Directory field is gone from the form and #1962 removed the key
  // from the config; a leftover value must not be round-tripped back by a save.
  const leftover = { id: 'a1', role: 'agent', displayName: 'A', briefingsPath: 'repo' };
  const form = buildInitialForm(leftover);
  assert.ok(!('briefingsPath' in form));
  assert.ok(!('briefingsPath' in buildEditSubmit(leftover, form)));
  // …and a form that never had the key is not therefore reported as unsaved.
  assert.equal(isFormDirty(leftover, form), false);
});

test('a round trip through the form changes nothing (AC2)', () => {
  const rich = {
    ...member,
    displayName: 'Dev',
    promptMode: PROMPT_MODES.ADDITIONAL, systemPrompt: 'extra',
    skillsOverride: ['cobol'],
    mcpServersOverride: [{ serverId: 'wiki', credentialId: 'c1' }],
  };
  const body = buildEditSubmit(rich, buildInitialForm(rich));
  assert.equal(body.displayName, 'Dev');
  assert.equal(body.systemPrompt, 'extra');
  assert.deepEqual(body.skillsOverride, ['cobol']);
  assert.deepEqual(body.mcpServersOverride, [{ serverId: 'wiki', credentialId: 'c1' }]);
});

/* ── Scaling (#2271, folded in by #2295 AC11/AC12) ───────────────────── */

test('poolDraft is derived from the member\'s pool, blank/disabled off-role', () => {
  const pooled = { ...member, pool: { enabled: true, maxInstances: 4 } };
  assert.equal(buildInitialForm(pooled).poolDraft.enabled, true);
  assert.equal(buildInitialForm(pooled).poolDraft.maxInstancesText, '4');

  const standalone = { id: 'a1', role: 'agent', displayName: 'A', pool: { enabled: true } };
  assert.equal(buildInitialForm(standalone).poolDraft.enabled, false, 'a non-member never reads its pool');
});

test('a role never sends a Scaling section it does not have', () => {
  const agent = { id: 'a1', role: 'agent', displayName: 'A' };
  const body = buildEditSubmit(agent, buildInitialForm(agent));
  assert.ok(!('pool' in body));
});

test('an untouched member round-trips its existing pool, workspace forced to git-clean-base (#2294)', () => {
  // The member's persisted workspace ('none') has no UI to set it and needs a
  // `workSource` that also has none — #2294 forces every save to git-clean-base
  // rather than re-persist it. Everything else (maxInstances, teardown) is
  // round-tripped unchanged when the pool folds into the one Save (#2295).
  const pooled = { ...member, pool: { enabled: true, maxInstances: 4, workspace: 'none' } };
  const body = buildEditSubmit(pooled, buildInitialForm(pooled), { parentWipLimit: 3 });
  assert.deepEqual(body.pool, { enabled: true, maxInstances: 4, workspace: 'git-clean-base' });
});

test('a member with no pool sends pool: null, not an absent key (clears it if stale)', () => {
  const body = buildEditSubmit(member, buildInitialForm(member));
  assert.equal(body.pool, null);
});

test('poolSectionError is null off-role, and mirrors scalingSaveDecision on a member', () => {
  const agent = { id: 'a1', role: 'agent', displayName: 'A' };
  assert.equal(poolSectionError(agent, buildInitialForm(agent)), null);

  const form = { ...buildInitialForm(member), poolDraft: { ...buildInitialForm(member).poolDraft, enabled: true } };
  assert.match(poolSectionError(member, form, { parentWipLimit: null }), /ticket limit/);
  assert.equal(poolSectionError(member, form, { parentWipLimit: 3 }), null);
});

test('buildEditSubmit omits pool (rather than sending garbage) when the draft is invalid', () => {
  const form = { ...buildInitialForm(member), poolDraft: { ...buildInitialForm(member).poolDraft, enabled: true } };
  const body = buildEditSubmit(member, form, { parentWipLimit: null });
  assert.ok(!('pool' in body), 'the real gate is poolSectionError, checked before this is ever called');
});

/* ── isFormDirty ──────────────────────────────────────────────────── */

test('a freshly derived form is not dirty, and no draft is not dirty', () => {
  assert.equal(isFormDirty(member, buildInitialForm(member)), false);
  assert.equal(isFormDirty(member, null), false);
  assert.equal(isFormDirty(member, undefined), false);
});

test('every batched field is watched — none can be edited unnoticed', () => {
  const base = buildInitialForm(member);
  const edits = {
    displayName: 'Renamed',
    skills: ['jcl'],
    systemPromptTemplate: 'x',
    promptMode: PROMPT_MODES.EXCLUSIVE,
    promptOverride: 'x',
    inheritSkills: false,
    skillsOverride: ['jcl'],
    inheritMcp: false,
    mcpRows: [{ serverId: 'wiki', credentialId: '' }],
    poolDraft: { ...base.poolDraft, enabled: true },
  };
  for (const [key, value] of Object.entries(edits)) {
    // Rows are only sent (and so only unsaved) in Custom mode.
    if (key === 'mcpRows') {
      const custom = { ...member, mcpServersOverride: [] };
      assert.equal(isFormDirty(custom, { ...buildInitialForm(custom), mcpRows: value }), true, 'editing mcpRows must read as unsaved');
      continue;
    }
    assert.equal(
      isFormDirty(member, { ...base, [key]: value }), true,
      `editing ${key} must read as unsaved`,
    );
  }
  // …and the watch list covers the whole form, so a field added to
  // buildInitialForm without one here shows up as a gap rather than as a
  // silently discarded draft.
  assert.deepEqual(Object.keys(base).sort(), Object.keys(edits).sort());
});

test('MCP rows in Inherit mode are not a change; in Custom they compare exactly (#2289)', () => {
  const base = buildInitialForm(member);
  const prefilled = [{ serverId: 'wiki', credentialId: '' }];
  // Custom → pre-filled → back to Inherit: nothing would be sent, nothing is unsaved.
  assert.equal(isFormDirty(member, { ...base, inheritMcp: true, mcpRows: prefilled }), false);
  const custom = { ...member, mcpServersOverride: [{ serverId: 'wiki', credentialId: null }] };
  const cform = buildInitialForm(custom);
  assert.equal(isFormDirty(custom, { ...cform, mcpRows: [{ serverId: 'wiki', credentialId: '' }] }), false);
  assert.equal(isFormDirty(custom, { ...cform, mcpRows: [{ serverId: 'wiki', credentialId: 'c1' }] }), true);
  assert.equal(isFormDirty(custom, { ...cform, mcpRows: [] }), true);
});

test('list fields compare by content, so re-selecting the same skills is clean', () => {
  const base = buildInitialForm({ ...member, skillsOverride: ['a', 'b'] });
  assert.equal(isFormDirty({ ...member, skillsOverride: ['a', 'b'] }, { ...base, skillsOverride: ['a', 'b'] }), false);
  assert.equal(isFormDirty({ ...member, skillsOverride: ['a', 'b'] }, { ...base, skillsOverride: ['b', 'a'] }), true);
});

/* ─── #2689: the grant picker lists the team pool the agent seeds from ────── */

test('skillPoolTeamId: Agent Team id for a team and its members, not the legacy "default" teamId', () => {
  const team = { id: 'uitest-chat-agent-team', role: 'team', teamId: 'default' };
  assert.equal(skillPoolTeamId(team), 'uitest-chat-agent-team');
  assert.equal(skillPoolTeamId({ id: 'm', role: 'team-member', parentTeamId: team.id, teamId: 'default' }), team.id);
  assert.equal(skillPoolTeamId({ id: 'solo', role: 'agent', teamId: 'acme' }), 'acme');
  assert.equal(skillPoolTeamId({ id: 'solo', role: 'agent' }), null);
  assert.equal(skillPoolTeamId(null), null);
});

test('skillsListUrl: queries the Agent Team pool', () => {
  assert.equal(skillsListUrl({ id: 'my-team', role: 'team', teamId: 'default' }), '/api/skills?teamId=my-team');
  assert.equal(skillsListUrl({ id: 'solo', role: 'agent' }), '/api/skills');
});

// #651 guard: the JSX is uncovered, so pin that the Skills tab's list URL comes
// from the tested helper and never from the legacy `agent.teamId` again.
test('AgentEditForm.jsx loads the skills list via skillsListUrl(agent)', () => {
  const src = readFileSync(new URL('./AgentEditForm.jsx', import.meta.url), 'utf8');
  assert.match(src, /const skillsUrl = skillsListUrl\(agent\);/);
  assert.doesNotMatch(src, /\/api\/skills\?teamId=\$\{encodeURIComponent\(agent\.teamId\)\}/);
});

test('#2679: a blank or whitespace-only display name blocks the Save', () => {
  for (const displayName of ['', '   ', '\t', undefined, null]) {
    assert.ok(displayNameError({ displayName }), JSON.stringify(displayName));
  }
  assert.equal(displayNameError({ displayName: 'Dev' }), null);
  assert.equal(displayNameError({ displayName: '  Dev ' }), null);
});

test('#2679: the submitted display name is trimmed', () => {
  const form = { ...buildInitialForm(member), displayName: '  Dev Agent  ' };
  assert.equal(buildEditSubmit(member, form).displayName, 'Dev Agent');
});

test('#2679: AgentEditForm gates Save on displayNameError and shows it inline', () => {
  const src = readFileSync(new URL('./AgentEditForm.jsx', import.meta.url), 'utf8');
  assert.match(src, /const nameError = displayNameError\(form\);/);
  assert.match(src, /const canSubmit = !nameError && /);
  assert.match(src, /label="Display Name \*"[^\n]*error=\{nameError\}/);
});
