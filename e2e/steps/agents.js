// Agents-page step library (#667 / #705, docs/journey-spec-concept.md §2.2).
// Asserts the materialised team is real: team card + members on the Agents page
// (UI), plus members running and DM rooms created (API — the AC allows either).
// Each assert accepts { memberIds } (F1 spec) or { teamId, roleIds } (journey).
const { expect } = require('@playwright/test');
const { resolveMemberIds } = require('./member-ids');

// UI: the team card and every member row are present on the Agents page. Member
// ids follow `<teamId>-<roleId>` and are unique text, so we assert on them
// directly (the team card is expanded by default).
async function expectTeamCard(ctx, params) {
  const { page } = ctx;
  const { teamId } = params;
  const memberIds = resolveMemberIds(params);
  await page.goto('/agents');

  // Team card sub-line renders `<teamId> · env: <envId>` — assert the id shows.
  await expect(page.getByText(teamId, { exact: false }).first()).toBeVisible();

  for (const memberId of memberIds) {
    await expect(page.getByText(memberId, { exact: true })).toBeVisible();
  }
}

// API: every member exists and is enabled (the orchestrator spawns a container
// for each enabled member — the UI shows this as the "Active" state). Polled
// because container spawn + Matrix provisioning settle shortly after `complete`.
async function expectMembersRunning(ctx, params) {
  const memberIds = resolveMemberIds(params);
  await expect
    .poll(
      async () => {
        const res = await ctx.request.get('/api/agents');
        if (!res.ok()) return [];
        const agents = await res.json();
        return memberIds.filter((id) => {
          const a = agents.find((x) => x.id === id);
          return a && a.enabled !== false;
        });
      },
      { message: 'not all members became enabled/running', timeout: 60_000 },
    )
    .toEqual(memberIds);
}

// API: a DM room was created per member (the wizard's `dms` step). The room id
// round-trips through GET /api/matrix/agents.
async function expectDmRooms(ctx, params) {
  const memberIds = resolveMemberIds(params);
  await expect
    .poll(
      async () => {
        const res = await ctx.request.get('/api/matrix/agents');
        if (!res.ok()) return [];
        const list = await res.json();
        return memberIds.filter((id) => {
          const a = list.find((x) => x.id === id);
          return a && !!a.dmRoomId;
        });
      },
      { message: 'not all members got a DM room', timeout: 60_000 },
    )
    .toEqual(memberIds);
}

module.exports = { expectTeamCard, expectMembersRunning, expectDmRooms };
