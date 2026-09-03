import test from 'node:test';
import assert from 'node:assert/strict';

import {
  hasOwnSkills, buildInitialForm, buildEditSubmit, isFormDirty,
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
  assert.equal(form.mcpOverrideText, '');
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

test('the MCP override serialises one entry per line, credential optional', () => {
  const form = buildInitialForm({
    ...member,
    mcpServersOverride: [
      { serverId: 'wiki', credentialId: 'wiki-team-a' },
      { serverId: 'graph', credentialId: null },
    ],
  });
  assert.equal(form.mcpOverrideText, 'wiki:wiki-team-a\ngraph');
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

test('a bare MCP line keeps a null credential so the API can name what is missing', () => {
  const form = {
    ...buildInitialForm(member),
    inheritMcp: false,
    mcpOverrideText: '  wiki:wiki-team-a \n\n graph \n',
  };
  assert.deepEqual(buildEditSubmit(member, form).mcpServersOverride, [
    { serverId: 'wiki', credentialId: 'wiki-team-a' },
    { serverId: 'graph', credentialId: null },
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
    mcpOverrideText: 'wiki',
  };
  for (const [key, value] of Object.entries(edits)) {
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

test('list fields compare by content, so re-selecting the same skills is clean', () => {
  const base = buildInitialForm({ ...member, skillsOverride: ['a', 'b'] });
  assert.equal(isFormDirty({ ...member, skillsOverride: ['a', 'b'] }, { ...base, skillsOverride: ['a', 'b'] }), false);
  assert.equal(isFormDirty({ ...member, skillsOverride: ['a', 'b'] }, { ...base, skillsOverride: ['b', 'a'] }), true);
});
