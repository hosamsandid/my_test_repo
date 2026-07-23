// F4 — Team skill activation (docs/e2e-testing-concept.md §2 F4; #668).
//
// Activate a global-pool skill on a materialised team from the Knowledge page,
// then assert per-member activation state — the AC is "member-level activation
// state, not just the toggle". Fully local (UI → API → orchestrator file sync),
// zero external dependencies.
//
// Thin spec over the step library: the team is a fast API-level fixture with
// two members (steps/team.js) — enough to prove member-level resolution — and
// the global skill is seeded via the API because the e2e pool is empty by
// default. All Knowledge-page selectors live in steps/knowledge.js.
const { test, expect } = require('@playwright/test');
const env = require('../steps/env');
const team = require('../steps/team');
const knowledge = require('../steps/knowledge');
const teardown = require('../steps/teardown');

const FIXTURE_REPO_URL = process.env.E2E_FIXTURE_REPO_URL || 'http://git-remote/e2e/fixture.git';
const ROLES = ['business-analyst', 'developer'];

function makeRunId() {
  const stamp = `${Date.now().toString(36)}${(process.pid % 1000).toString(36)}`;
  return `e2e-${stamp}`.slice(0, 24);
}

test.describe('F4: team skill activation', () => {
  let teamId;
  let envId;
  let skillName;

  test.afterEach(async ({ page, request }) => {
    const ctx = { page, request };
    // Team first (removes the grant + member copies), then the now-unreferenced
    // pool skill.
    if (teamId && envId) {
      await teardown.teardownTeam(ctx, { teamId, envId });
    }
    if (skillName) {
      await knowledge.deleteGlobalSkill(ctx, { name: skillName });
    }
  });

  test('activating a global skill syncs it to every member (per-member badges)', async ({ page, request }) => {
    const ctx = { page, request };
    const runId = makeRunId();
    teamId = runId;
    envId = `${runId}-fixture`;
    skillName = `${runId}-skill`;
    const memberIds = ROLES.map((r) => `${runId}-${r}`);

    await test.step('seed a global skill + a two-member team (API fixtures)', async () => {
      await knowledge.createGlobalSkill(ctx, { name: skillName });
      await env.createFixtureEnv(ctx, {
        id: envId,
        name: `${runId} fixture env`,
        repoUrl: FIXTURE_REPO_URL,
        branch: 'main',
      });
      await team.materializeTeam(ctx, { teamId, envId, roles: ROLES });
    });

    await test.step('activate the skill on the team from the Knowledge page', async () => {
      await knowledge.openTeam(ctx, { teamId });
      await knowledge.activateGlobalSkill(ctx, { skillName });
    });

    await test.step('UI shows every member active (member-level, not just the toggle)', async () => {
      await knowledge.expectAllMembersActive(ctx, { memberCount: memberIds.length, skillName });
    });

    await test.step('API graph overlay confirms per-member active state', async () => {
      const activation = await knowledge.getActivation(ctx, { teamId, skillName });
      expect(activation.active, 'skill is in the team active set').toBeTruthy();
      const states = new Map((activation.members || []).map((m) => [m.agentId, m.state]));
      for (const id of memberIds) {
        expect(states.get(id), `member ${id} activation state`).toBe('active');
      }
    });
  });
});
