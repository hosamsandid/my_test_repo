// F2 — Agent DM chat round-trip (docs/e2e-testing-concept.md §2 F2, §7; #668).
//
// Drives the real chat UI end-to-end against the stubbed LLM lane: open a
// materialised agent's DM, send a message carrying a unique `[[E2E:<token>]]`
// marker, and assert the deterministic reply comes back through BOTH SSE
// surfaces — the session-log `result` event (session SSE) and the chat reply
// bubble (room SSE). Zero external dependencies: the agent runs the fake
// `claude` shim (AEE_FAKE_CLAUDE=1) and clones the in-stack git-remote fixture.
//
// Thin spec over the step library (e2e/steps/*): the team is a fast API-level
// fixture (steps/team.js) — F1 already covers the wizard UI — and all chat
// selectors / SSE plumbing live in steps/chat.js.
//
// #253 (the SSE stream miss this spec was written to catch) is now FIXED, so
// BOTH surfaces are expected green: the session-log `result` event AND the
// room-SSE reply bubble. A red reply-bubble step is therefore a real #253-class
// regression, not an accepted red — do NOT quiet it. (Whether to promote F2
// into the F0+F1 PR gate is a separate call; it is no longer blocked by #253.)
const { test, expect } = require('@playwright/test');
const env = require('../steps/env');
const team = require('../steps/team');
const chat = require('../steps/chat');
const teardown = require('../steps/teardown');

const FIXTURE_REPO_URL = process.env.E2E_FIXTURE_REPO_URL || 'http://git-remote/e2e/fixture.git';

function makeRunId() {
  const stamp = `${Date.now().toString(36)}${(process.pid % 1000).toString(36)}`;
  return `e2e-${stamp}`.slice(0, 24);
}

test.describe('F2: agent DM chat round-trip', () => {
  let teamId;
  let envId;

  test.afterEach(async ({ page, request }) => {
    if (teamId && envId) {
      await teardown.teardownTeam({ page, request }, { teamId, envId });
    }
  });

  test('reply arrives through both SSE surfaces (chat bubble + session log)', async ({ page, request }) => {
    const ctx = { page, request };
    teamId = makeRunId();
    envId = `${teamId}-fixture`;
    // One agent is enough to chat with; keep the fixture to a single member so
    // the full suite stays within the runtime budget.
    const agentId = `${teamId}-business-analyst`;
    const token = `${teamId}-${Date.now().toString(36)}`;

    await test.step('materialise a one-member team on a fixture env (API)', async () => {
      await env.createFixtureEnv(ctx, {
        id: envId,
        name: `${teamId} fixture env`,
        repoUrl: FIXTURE_REPO_URL,
        branch: 'main',
      });
      await team.materializeTeam(ctx, {
        teamId,
        envId,
        roles: ['business-analyst'],
      });
    });

    const roomId = await chat.ensureDmRoom(ctx, { agentId });

    await test.step('wait for the agent runtime to be ready (first-sync guard)', async () => {
      await chat.waitForAgentReady(ctx, { agentId });
    });

    await test.step('open the chat and send a marker message', async () => {
      await chat.open(ctx, { agentId });
      await chat.send(ctx, { text: `Ping from F2 ${chat.marker(token)}` });
    });

    await test.step('session-log surface: the `result` event is delivered (session SSE)', async () => {
      await chat.expectSessionLogResult(ctx, { agentId, roomId, token });
    });

    await test.step('room surface: the reply bubble is delivered (room SSE)', async () => {
      await chat.expectReplyBubble(ctx, { token });
    });
  });
});
