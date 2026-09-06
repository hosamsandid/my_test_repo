// Team-assertion step library (#667 / #705, docs/journey-spec-concept.md §2.2).
// Asserts the materialised team is real: its group + member rows in the Agent
// Chat left rail (UI), plus members running and DM rooms created (API — the AC
// allows either). Each assert accepts { memberIds } (F1 spec) or
// { teamId, roleIds } (journey).
//
// #1930 removed the /agents page outright (the route now redirects to /chats).
// Everyday agent management moved into the Agent Chat left rail, so the UI
// assertion moved with it — see expectTeamInRail below.
const { expect } = require('@playwright/test');
const { resolveMemberIds } = require('./member-ids');

/**
 * Resolve each member's rail LABEL from the very payload the rail is built from
 * (`GET /api/matrix/agents`).
 *
 * A rail row renders `displayName || id` (AgentList.jsx → `AgentRow`), and a
 * wizard-created member's displayName is its ROLE name ("Business Analyst"),
 * never the `<teamId>-<roleId>` id — the id is simply not on screen, so
 * asserting on it would assert something that does not render.
 *
 * Polled, because it doubles as the "every member reached the chat list"
 * assertion: a member only enters this payload once it has a Matrix identity,
 * which settles shortly after the wizard's `complete` event.
 *
 * Deliberately NOT exported: every export of a step module is registered as a
 * journey step (journey-runner/step-registry.js), and this is plumbing.
 */
async function memberRowLabels(ctx, memberIds) {
  let listed = [];
  await expect
    .poll(
      async () => {
        // includeStubs=1 mirrors what the chat page itself requests, so a team
        // materialised with `materializeMembers: false` resolves here too.
        const res = await ctx.request.get('/api/matrix/agents?includeStubs=1');
        listed = res.ok() ? await res.json() : [];
        return memberIds.filter((id) => listed.some((a) => a.id === id));
      },
      { message: 'not all members appeared in the chat agent list', timeout: 60_000 },
    )
    .toEqual(memberIds);

  return memberIds.map((id) => {
    const agent = listed.find((a) => a.id === id);
    return (agent && agent.displayName) || id;
  });
}

/**
 * UI: the team's group header and every member row are present in the Agent
 * Chat left rail (`/chats`) — the surface that replaced the Agents page's team
 * card in #1930.
 *
 * @param {string} params.teamId - Team slug id rendered as the rail's group header.
 * @param {string[]} [params.roleIds] - Role ids to derive member ids (`<teamId>-<roleId>`).
 * @param {string[]} [params.memberIds] - Explicit member ids (alternative to roleIds).
 * @example
 * - assert:
 *     do: agents.expectTeamInRail
 *     teamId: agentic-demos
 *     roleIds: [business-analyst, developer]
 */
// What the rail actually renders (admin-console/src/pages/agent-chat/
// AgentList.jsx + agent-list-model.js) — kept out of the JSDoc summary, which
// is what steps-catalog.json prints as the step's one-line description:
//  - A `team` agent has no Matrix identity (orchestrator `createAgent` mints no
//    Matrix user for role `team`), so it never appears in
//    `GET /api/matrix/agents`. `buildGroups` still opens a group for the id its
//    members carry in `parentTeamId`, and with no header row present the
//    group's `displayName` falls back to that raw id — so the TEAM ID is on
//    screen, as the group header's own text. That is what we assert.
//  - Member rows are `role="option"` buttons inside the rail's `role="listbox"`,
//    labelled `displayName || id`. Wizard-created members carry the role
//    template's display name, so we resolve each id's label from the list
//    payload instead of asserting on the id (see memberRowLabels above).
//
// `.first()` on both assertions: the rail is ONE flat listbox (a group is a
// React fragment, not a DOM container), so a member row cannot be scoped to its
// group, and a role display name is only unique within a team. Presence is what
// this step verifies; per-member identity is covered by the two API asserts.
async function expectTeamInRail(ctx, params) {
  const { page } = ctx;
  const { teamId } = params;
  const memberIds = resolveMemberIds(params);
  const labels = await memberRowLabels(ctx, memberIds);

  await page.goto('/chats');

  // Scope every lookup to the rail's own `role="listbox"` (AgentList.jsx). The
  // filter <select> sitting above it renders one <option> per team/agent, and a
  // native <option> carries the implicit ARIA role "option" as well — it is
  // never visible, so an unscoped match could resolve to it and then fail on
  // visibility. `.first()`: the only other listbox in the page is the
  // composer's slash-command palette, which is mounted only while open.
  const rail = page.locator('[role="listbox"]').first();

  // The group header. Its label is the raw team id (no team row to name it);
  // the uppercasing is CSS `text-transform`, which never touches the DOM text.
  await expect(rail.getByText(teamId, { exact: true }).first()).toBeVisible();

  // Teams default to expanded (DEFAULT_COLLAPSED.team === false), so the member
  // rows are mounted without a click.
  for (const label of labels) {
    await expect(rail.getByRole('option', { name: label }).first()).toBeVisible();
  }
}

/**
 * API: every member exists and is enabled (the orchestrator spawns a container
 * for each enabled member — the UI shows this as the "Active" state). Polled
 * because container spawn + Matrix provisioning settle shortly after `complete`.
 *
 * @param {string} params.teamId - Team slug id (with roleIds) to derive member ids.
 * @param {string[]} [params.roleIds] - Role ids to derive member ids.
 * @param {string[]} [params.memberIds] - Explicit member ids (alternative to roleIds).
 * @example
 * - assert:
 *     do: agents.expectMembersRunning
 *     teamId: agentic-demos
 *     roleIds: [business-analyst, developer]
 */
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

/**
 * API: a DM room was created per member (the wizard's `dms` step). The room id
 * round-trips through GET /api/matrix/agents.
 *
 * @param {string} params.teamId - Team slug id (with roleIds) to derive member ids.
 * @param {string[]} [params.roleIds] - Role ids to derive member ids.
 * @param {string[]} [params.memberIds] - Explicit member ids (alternative to roleIds).
 * @example
 * - assert:
 *     do: agents.expectDmRooms
 *     teamId: agentic-demos
 *     roleIds: [business-analyst, developer]
 */
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

module.exports = { expectTeamInRail, expectMembersRunning, expectDmRooms };
