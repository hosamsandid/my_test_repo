// F1 — Create a team through the Team-Setup wizard (docs/e2e-testing-concept.md
// §2 v1.1, #667). Drives the real wizard UI end-to-end with ZERO external
// dependencies: the fixture Working Environment points at the in-stack
// `git-remote` service (http://git-remote/e2e/fixture.git), cloned credential-
// less and no GitHub is involved. Because the env is token-less, #2323 blocks
// the wizard's team materialisation until the reference-only opt-out is
// confirmed — this spec exercises that opt-out (submitAndCaptureProgress with
// referenceOnly), the wizard-side twin of F3's env-panel coverage.
//
// Thin spec over the step library (e2e/steps/*, docs/journey-spec-concept.md
// §2.2): all selectors / waits / NDJSON timing live in the modules; the journey
// layer will reuse them 1:1 and may later supersede only this spec file.
//
// Isolation: unique per-run ids + full API teardown in afterEach, so the spec
// leaves no state behind and can run twice consecutively on the same stack.
const { test, expect } = require('@playwright/test');
const env = require('../steps/env');
const wizard = require('../steps/wizard');
const agents = require('../steps/agents');
const teardown = require('../steps/teardown');

const FIXTURE_REPO_URL = process.env.E2E_FIXTURE_REPO_URL || 'http://git-remote/e2e/fixture.git';
const ROLE_IDS = ['business-analyst', 'developer', 'code-reviewer', 'reworker'];

// A short, slug-valid, unique id per run (teamId regex: ^[a-z0-9](-|alnum){..}$,
// ≤40 chars). Date/pid keep parallel or repeated runs from colliding.
function makeRunId() {
  const stamp = `${Date.now().toString(36)}${(process.pid % 1000).toString(36)}`;
  return `e2e-${stamp}`.slice(0, 24);
}

test.describe('F1: create a team through the wizard', () => {
  let teamId;
  let envId;

  test.afterEach(async ({ page, request }) => {
    // Best-effort teardown even if the test failed mid-way.
    if (teamId && envId) {
      await teardown.teardownTeam({ page, request }, { teamId, envId });
    }
  });

  test('materialises a Core SDLC team against the in-stack git remote', async ({ page, request }) => {
    const ctx = { page, request };
    teamId = makeRunId();
    envId = `${teamId}-fixture`;
    const memberIds = ROLE_IDS.map((r) => `${teamId}-${r}`);

    await test.step('seed a credential-less fixture environment (API)', async () => {
      // Token-less on purpose: the wizard submit below then exercises #2323's
      // reference-only opt-out (createFixtureEnv acknowledges it at the API for
      // its own POST; the wizard's /api/teams/stream re-checks and the opt-out
      // click confirms it).
      await env.createFixtureEnv(ctx, {
        id: envId,
        name: `${teamId} fixture env`,
        repoUrl: FIXTURE_REPO_URL,
        branch: 'main',
      });
    });

    await test.step('drive the wizard: process → env → team → knowledge → review', async () => {
      await wizard.open(ctx);
      // Advancing is explicit since #705: the act-on-step primitives no longer
      // click Next themselves (so the journey runner can screenshot between).
      await wizard.selectProcessTemplate(ctx, { templateName: 'Core SDLC' });
      await wizard.next(ctx);
      await wizard.selectEnvironment(ctx, { envName: `${teamId} fixture env` }); // auto-advances
      await wizard.setTeamIdentity(ctx, { teamName: teamId, teamId });
      await wizard.next(ctx);
      await wizard.skipKnowledge(ctx);
    });

    await test.step('submit and assert the per-step NDJSON progress', async () => {
      const events = await wizard.submitAndCaptureProgress(ctx, { referenceOnly: true });
      const byType = (t) => events.filter((e) => e.type === t);

      // plan: one planning event listing the steps the wizard will run.
      const plan = byType('plan');
      expect(plan, 'exactly one plan event').toHaveLength(1);
      const planIds = plan[0].steps.map((s) => s.id);
      expect(planIds).toContain('team');
      for (const memberId of memberIds) expect(planIds).toContain(`member:${memberId}`);
      expect(planIds).toContain('dms');

      // step: every planned step runs and reaches `done` (no `error`).
      const steps = byType('step');
      expect(steps.some((s) => s.status === 'error'), 'no step errored').toBeFalsy();
      for (const id of planIds) {
        expect(
          steps.some((s) => s.id === id && s.status === 'done'),
          `step ${id} reached done`,
        ).toBeTruthy();
      }

      // complete: the team + all members were created, nothing skipped.
      const complete = byType('complete');
      expect(complete, 'exactly one complete event').toHaveLength(1);
      expect(complete[0].result.teamId).toBe(teamId);
      expect(complete[0].result.created).toEqual(expect.arrayContaining(memberIds));
    });

    await test.step('assert the team + members in the Agent Chat rail and running (UI + API)', async () => {
      await agents.expectTeamInRail(ctx, { teamId, memberIds });
      await agents.expectMembersRunning(ctx, { memberIds });
      await agents.expectDmRooms(ctx, { memberIds });
    });
  });
});
