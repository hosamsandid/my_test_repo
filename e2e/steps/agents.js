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
const { agentRail, railRowButton } = require('./agent-rail');

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
 * @param {string} params.teamId - Team slug id; the group's fallback header text.
 * @param {string} [params.teamName] - Team display name shown as the group header
 *   when the team has an agent row to name it (a materialised team always does).
 * @param {string[]} [params.roleIds] - Role ids to derive member ids (`<teamId>-<roleId>`).
 * @param {string[]} [params.memberIds] - Explicit member ids (alternative to roleIds).
 * @example
 * - assert:
 *     do: agents.expectTeamInRail
 *     teamId: agentic-demos
 *     teamName: Agentic Demos
 *     roleIds: [business-analyst, developer]
 */
// What the rail actually renders (admin-console/src/pages/agent-chat/
// AgentList.jsx + agent-list-model.js) — kept out of the JSDoc summary, which
// is what steps-catalog.json prints as the step's one-line description:
//  - `buildGroups` opens a group for the team and titles it with the team
//    agent's `displayName` (its team NAME), falling back to the raw id only when
//    no team agent row is present to name it. A wizard-materialised team has
//    that row, so the team NAME is the group header's own text — assert on the
//    display name (`teamName`) when the caller gives one, else the id.
//  - Member rows are `listitem`s inside the rail's "Agents" `list` (#2704),
//    whose main button is labelled `displayName || id` (agent-rail.js).
//    Wizard-created members carry the role template's display name, so we
//    resolve each id's label from the list payload instead of asserting on the
//    id (see memberRowLabels above).
//
// `.first()` on both assertions: a role display name is only unique within a
// team. Presence is what this step verifies; per-member identity is covered by
// the two API asserts.
async function expectTeamInRail(ctx, params) {
  const { page } = ctx;
  const { teamId, teamName } = params;
  const memberIds = resolveMemberIds(params);
  const labels = await memberRowLabels(ctx, memberIds);

  await page.goto('/chats');

  // Scope every lookup to the rail's own "Agents" list (AgentList.jsx), so
  // nothing outside it — a header, the open chat's title — can match a label.
  const rail = agentRail(page);

  // The group header shows the team's display NAME — the team agent's
  // displayName (agent-list-model.js buildGroups), which a materialised team
  // always has; it only falls back to the raw id when the team has no agent row
  // to name it. The uppercasing is CSS `text-transform`, which never touches the
  // DOM text. Assert the display name when the caller gives one.
  await expect(rail.getByText(teamName || teamId, { exact: true }).first()).toBeVisible();

  // Teams default to expanded (DEFAULT_COLLAPSED.team === false), so the member
  // rows are mounted without a click.
  for (const label of labels) {
    await expect(railRowButton(rail, label).first()).toBeVisible();
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
