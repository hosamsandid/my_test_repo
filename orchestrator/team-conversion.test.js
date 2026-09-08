'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  deriveTeamId,
  deriveTeamDisplayName,
  assessConversionEligibility,
  canConvertToTeam,
  planTeamConversion,
} = require('./team-conversion');
// AC4 is a statement about the *platform's* prompt resolution, not about this
// module's own fields — so it is asserted through the real resolver rather than
// by re-describing what exclusive means.
const { resolvePromptMode, composeMemberPrompt } = require('./prompt-modes');

// The prompt the platform will resolve for a config, before and after.
function resolvedPromptFor(cfg, teamTemplate) {
  return composeMemberPrompt(resolvePromptMode(cfg), teamTemplate, cfg.systemPrompt || '');
}

// A materialized standalone agent — the only shape that converts (AC1).
function standalone(extra = {}) {
  return {
    id: 'research-assistant',
    displayName: 'Research Assistant',
    role: 'agent',
    environmentId: 'env-1',
    teamId: 'acme',
    token: 'syt_matrix_token',
    systemPrompt: 'You are a research assistant.',
    ...extra,
  };
}

// ── AC1: who may convert ────────────────────────────────────────────────────

test('a materialized standalone agent is eligible', () => {
  assert.deepEqual(assessConversionEligibility(standalone()), {
    eligible: true, code: 'eligible', reason: null,
  });
  assert.equal(canConvertToTeam(standalone()), true);
});

test('a team is refused — it is already one', () => {
  const v = assessConversionEligibility({ id: 't', role: 'team', token: 'x' });
  assert.equal(v.eligible, false);
  assert.equal(v.code, 'already-team');
});

test('a team-member is refused, by role and by parentTeamId alone', () => {
  assert.equal(assessConversionEligibility({ id: 'm', role: 'team-member', parentTeamId: 't', token: 'x' }).code,
    'already-member');
  // A hand-edited config carrying a parent but the standalone role must not
  // slip through and end up with two parents.
  assert.equal(assessConversionEligibility({ id: 'm', role: 'agent', parentTeamId: 't', token: 'x' }).code,
    'already-member');
});

test('a stub is refused — no chat identity to keep yet', () => {
  assert.equal(assessConversionEligibility({ id: 'a', role: 'agent' }).code, 'stub');
  assert.equal(assessConversionEligibility(standalone({ token: '' })).code, 'stub');
  assert.equal(assessConversionEligibility(standalone({ _provisioning: true })).code, 'stub');
});

test('an ephemeral agent and an unsupported role are refused', () => {
  assert.equal(assessConversionEligibility(standalone({ ephemeral: true })).code, 'ephemeral');
  assert.equal(assessConversionEligibility({ id: 'o', role: 'orchestrator', token: 'x' }).code,
    'unsupported-role');
});

test('a missing config is refused rather than crashing the menu predicate', () => {
  assert.equal(assessConversionEligibility(null).code, 'not-found');
  assert.equal(canConvertToTeam(undefined), false);
});

// ── the derived identity (open question 1) ──────────────────────────────────

test('the team id and name are derived from the agent, not asked for', () => {
  assert.equal(deriveTeamId('research-assistant'), 'research-assistant-team');
  assert.equal(deriveTeamDisplayName(standalone()), 'Research Assistant Team');
  // No display name on the config → fall back to the id, never to "undefined".
  assert.equal(deriveTeamDisplayName({ id: 'bot-7' }), 'bot-7 Team');
});

// ── AC9: refusals leave nothing behind ──────────────────────────────────────

test('a taken team id is refused with a message naming the collision', () => {
  assert.throws(
    () => planTeamConversion(standalone(), { teamIdTaken: (id) => id === 'research-assistant-team' }),
    /team id 'research-assistant-team' is already taken/,
  );
});

test('an ineligible agent is refused by the planner too, not only by the menu', () => {
  assert.throws(
    () => planTeamConversion(standalone({ role: 'team-member', parentTeamId: 'x' }), {}),
    /cannot be converted into a team: it is already a member of a team/,
  );
});

// ── AC3 / AC8: what the plan writes ─────────────────────────────────────────

test('the plan creates a team beside the agent and re-points the agent at it', () => {
  const plan = planTeamConversion(standalone(), {});

  assert.equal(plan.teamId, 'research-assistant-team');
  assert.equal(plan.teamConfig.role, 'team');
  assert.equal(plan.teamConfig.displayName, 'Research Assistant Team');
  assert.equal(plan.teamConfig.environmentId, 'env-1');
  assert.equal(plan.teamConfig.enabled, true);
  assert.equal(plan.teamConfig.convertedFromAgentId, 'research-assistant');

  // The agent keeps its own id — the plan never renames it (AC3).
  assert.equal(plan.agentId, 'research-assistant');
  assert.equal(plan.memberPatch.role, 'team-member');
  assert.equal(plan.memberPatch.parentTeamId, 'research-assistant-team');
  // Nothing in the patch touches identity, environment, triggers or history.
  for (const key of ['id', 'userId', 'token', 'environmentId', 'triggers', 'displayName']) {
    assert.equal(Object.prototype.hasOwnProperty.call(plan.memberPatch, key), false,
      `memberPatch must not rewrite '${key}'`);
  }
});

test('AC8 — the new team belongs to the agent\'s own human tenant', () => {
  assert.equal(planTeamConversion(standalone(), {}).teamConfig.teamId, 'acme');
  // An untenanted legacy config lands on the default tenant, not on undefined.
  assert.equal(planTeamConversion(standalone({ teamId: undefined }), {}).teamConfig.teamId, 'default');
});

// ── AC4: the effective prompt is byte-identical ─────────────────────────────

test('AC4 — the platform resolves a byte-identical prompt after the conversion', () => {
  const cfg = standalone();
  const plan = planTeamConversion(cfg, {});
  const after = { ...cfg, ...plan.memberPatch };
  for (const k of plan.memberUnset) delete after[k];

  // The team's template is deliberately empty, so nothing can leak in.
  assert.equal(plan.teamConfig.systemPromptTemplate, '');
  assert.equal(resolvePromptMode(after), 'exclusive');
  assert.equal(
    resolvedPromptFor(after, plan.teamConfig.systemPromptTemplate),
    'You are a research assistant.',
  );
  assert.equal(plan.effectivePrompt, 'You are a research assistant.');
});

test('AC4 — a config with no own prompt adopts the on-disk AGENT-PROMPT.md', () => {
  // A standalone agent's prompt can live only in the file (that is what
  // `importAgent` compensates for too); left behind, the member would resolve
  // against the team's empty template and lose its instructions.
  const plan = planTeamConversion(standalone({ systemPrompt: '' }), {
    promptFallback: '# On-disk prompt\n\nDo the thing.',
  });
  assert.equal(plan.memberPatch.systemPrompt, '# On-disk prompt\n\nDo the thing.');
  assert.equal(resolvePromptMode(plan.memberPatch), 'exclusive');
  assert.equal(plan.effectivePrompt, '# On-disk prompt\n\nDo the thing.');
});

test('AC4 — a genuinely promptless agent stays promptless, not half-exclusive', () => {
  const plan = planTeamConversion(standalone({ systemPrompt: '' }), { promptFallback: '' });
  assert.equal('systemPrompt' in plan.memberPatch, false);
  // inherit over an empty template === the empty prompt it had before.
  assert.equal(resolvedPromptFor(plan.memberPatch, plan.teamConfig.systemPromptTemplate), '');
});

test('a stale promptMode is removed, so the prompt cannot be re-composed', () => {
  // `additional` would fold the agent's prompt onto the team's empty template
  // under an "Agent-specific instructions" heading it never had.
  const plan = planTeamConversion(standalone({ promptMode: 'additional' }), {});
  assert.ok(plan.memberUnset.includes('promptMode'));
  const after = { ...standalone({ promptMode: 'additional' }), ...plan.memberPatch };
  for (const k of plan.memberUnset) delete after[k];
  assert.equal(resolvePromptMode(after), 'exclusive');
  assert.equal(resolvedPromptFor(after, ''), 'You are a research assistant.');
});

// ── AC5 / AC7: the grant changes shape but not content ──────────────────────

test('AC7 — the grant is written to the team AND as the member\'s override', () => {
  const plan = planTeamConversion(standalone(), {
    skills: ['flow-designer', 'cobol-analysis'],
    plugins: [{ id: 'github-issues', scopeGranularity: 'team' }],
  });
  assert.deepEqual(plan.teamConfig.skills, ['flow-designer', 'cobol-analysis']);
  assert.deepEqual(plan.memberPatch.skillsOverride, ['flow-designer', 'cobol-analysis']);
  assert.deepEqual(plan.teamConfig.plugins, [{ id: 'github-issues', scopeGranularity: 'team' }]);
  assert.deepEqual(plan.memberPatch.pluginsOverride, [{ id: 'github-issues', scopeGranularity: 'team' }]);
  // The standalone-shaped fields must not survive next to the override.
  assert.deepEqual(plan.memberUnset, ['skills', 'plugins', 'promptMode', 'systemPromptTemplate']);
});

test('an ungranted agent gets no empty override fields', () => {
  const plan = planTeamConversion(standalone(), {});
  assert.deepEqual(plan.teamConfig.skills, []);
  assert.equal('skillsOverride' in plan.memberPatch, false);
  assert.equal('pluginsOverride' in plan.memberPatch, false);
  assert.equal('plugins' in plan.teamConfig, false);
});

test('AC5 — only tenant-pool skills need copying, and only granted ones', () => {
  const plan = planTeamConversion(standalone(), {
    skills: ['tenant-skill', 'global-skill'],
    // The caller resolved the tiers: one grant name comes from the tenant pool,
    // and one name in the pool is not granted at all.
    tenantSkills: ['tenant-skill', 'tenant-skill', 'not-granted'],
  });
  assert.deepEqual(plan.skillPoolCopies, ['tenant-skill']);
});

test('AC5 — nothing to copy when every skill resolves globally', () => {
  const plan = planTeamConversion(standalone(), { skills: ['global-skill'], tenantSkills: [] });
  assert.deepEqual(plan.skillPoolCopies, []);
});

// ── AC6: the knowledge scope move is named ──────────────────────────────────

test('AC6 — the plan states which knowledge scope the agent moves between', () => {
  const plan = planTeamConversion(standalone(), {});
  assert.deepEqual(plan.knowledgeScope, { from: 'acme', to: 'research-assistant-team' });
});

// ── AC7: plugin scope ids that flip ─────────────────────────────────────────

test('AC7 — team-granularity grants flip scope id; agent-granularity ones do not', () => {
  const plan = planTeamConversion(standalone(), {
    plugins: [
      { id: 'github-issues', scopeGranularity: 'team' },
      { id: 'podman-mcp', scopeGranularity: 'agent' },
      { id: 'legacy-no-granularity' },
    ],
  });
  assert.deepEqual(plan.pluginScopeChanges, [
    { pluginId: 'github-issues', from: 'research-assistant', to: 'research-assistant-team' },
    // A grant with no explicit granularity defaults to 'team' (plugin-scope.js).
    { pluginId: 'legacy-no-granularity', from: 'research-assistant', to: 'research-assistant-team' },
  ]);
});

// ── token-usage attribution (edge case) ─────────────────────────────────────

test('roleId is written explicitly so usage rows keep a meaningful role', () => {
  // Without it, `enrichUsageRecord`'s `<teamId>-` prefix strip fails on an id
  // that was never prefixed and every row would read 'team-member'.
  assert.equal(planTeamConversion(standalone(), {}).memberPatch.roleId, 'research-assistant');
  // An agent that already carries one keeps it.
  assert.equal(planTeamConversion(standalone({ roleId: 'developer' }), {}).memberPatch.roleId, 'developer');
});

// ── purity ──────────────────────────────────────────────────────────────────

test('planning mutates neither the config nor the passed-in grants', () => {
  const cfg = standalone();
  const frozenCfg = JSON.stringify(cfg);
  const skills = ['a'];
  const plugins = [{ id: 'p', scopeGranularity: 'team' }];
  const plan = planTeamConversion(cfg, { skills, plugins });

  assert.equal(JSON.stringify(cfg), frozenCfg);
  plan.teamConfig.skills.push('mutated');
  plan.teamConfig.plugins[0].id = 'mutated';
  assert.deepEqual(skills, ['a']);
  assert.deepEqual(plugins, [{ id: 'p', scopeGranularity: 'team' }]);
});

// ── the plan asserted through the platform's OWN resolvers ─────────────────
// The tests above check the plan's fields; these apply the plan and then ask
// the real modules the questions the acceptance criteria are actually about.

const { effectiveSkills } = require('./skill-grants');
const { effectivePlugins } = require('./plugin-grants');
const { resolveScopeId } = require('./plugin-scope');

/** Apply a plan the way `convertAgentToTeam` does, and return both configs. */
function applyPlan(cfg, plan) {
  const member = { ...cfg, ...plan.memberPatch };
  for (const k of plan.memberUnset) delete member[k];
  return { member, team: plan.teamConfig, load: (id) => (id === plan.teamId ? plan.teamConfig : null) };
}

test('AC5 — the effective SKILL grant is unchanged, per skill-grants.js', () => {
  const cfg = standalone({ skills: ['flow-designer', 'cobol-analysis'] });
  const before = effectiveSkills(cfg, () => null);
  const plan = planTeamConversion(cfg, { skills: before });
  const { member, load } = applyPlan(cfg, plan);

  assert.deepEqual(effectiveSkills(member, load), before);
  // And a second member added later inherits the same list from the team,
  // which is why the grant is written to the team as well.
  const sibling = { id: 'x', role: 'team-member', parentTeamId: plan.teamId };
  assert.deepEqual(effectiveSkills(sibling, load), before);
});

test('AC7 — the effective PLUGIN grant is unchanged, per plugin-grants.js', () => {
  const cfg = standalone({
    plugins: [{ id: 'github-issues', scopeGranularity: 'team' }, { id: 'podman-mcp', scopeGranularity: 'agent' }],
  });
  const before = effectivePlugins(cfg, () => null);
  const plan = planTeamConversion(cfg, { plugins: before });
  const { member, load } = applyPlan(cfg, plan);

  assert.deepEqual(effectivePlugins(member, load), before);
});

test('AC7 — plugin-scope.js confirms exactly the flips the plan predicted', () => {
  const cfg = standalone({
    plugins: [{ id: 'github-issues', scopeGranularity: 'team' }, { id: 'podman-mcp', scopeGranularity: 'agent' }],
  });
  const plan = planTeamConversion(cfg, { plugins: effectivePlugins(cfg, () => null) });
  const { member } = applyPlan(cfg, plan);

  // The team-granularity id moves — which is what has to be torn down first.
  assert.equal(resolveScopeId(cfg, 'team'), 'research-assistant');
  assert.equal(resolveScopeId(member, 'team'), 'research-assistant-team');
  assert.deepEqual(
    plan.pluginScopeChanges.map(c => c.pluginId),
    ['github-issues'],
  );
  // The agent-granularity id does not, so nothing is orphaned for it.
  assert.equal(resolveScopeId(member, 'agent'), resolveScopeId(cfg, 'agent'));
});

test('AC3 — applying the plan leaves a member the platform recognises', () => {
  const cfg = standalone();
  const plan = planTeamConversion(cfg, {});
  const { member, team } = applyPlan(cfg, plan);

  assert.equal(member.id, cfg.id);
  assert.equal(member.userId, cfg.userId);
  assert.equal(member.token, cfg.token);
  assert.equal(member.environmentId, team.environmentId);
  assert.equal(member.enabled, cfg.enabled);
  // AC8 — one tenant across both records, so the tenant-drift scan is quiet.
  assert.equal(member.teamId, team.teamId);
  // No `systemPromptTemplate` on the member, no `skills`/`plugins` beside the
  // override fields.
  assert.equal('systemPromptTemplate' in member, false);
  assert.equal('skills' in member, false);
  assert.equal('plugins' in member, false);
});
