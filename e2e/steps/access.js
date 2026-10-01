// Decentralised-access step library (#2086, epic #2076 AC13).
//
// The journey vocabulary for the private-by-default → share → role-change →
// last-admin-successor loop. Identity plumbing (minting user records, signing
// them in, swapping the active one) lives in the helper module `identity.js`,
// which is deliberately NOT in STEP_MODULES — see its header.
//
// SELECTORS. No data-testids exist in admin-console/src, so everything below is
// ARIA role / accessible name / visible text, verified against:
//   - admin-console/src/pages/agent-chat/ShareTeamPanel.jsx
//   - admin-console/src/pages/agent-chat/team-share-view.js  (the literal copy)
//   - admin-console/src/pages/agent-lifecycle/agent-lifecycle-menu.js (menu labels)
//   - admin-console/src/pages/agent-lifecycle/team-config-tabs-view.js (the Sharing tab)
//   - admin-console/src/components/RowContextMenu.jsx
//
// TWO ASSERTIONS, NOT ONE. Every authorization beat is checked twice on purpose:
// once in the UI (the control is absent / read-only) and once against the API
// with that same human's session cookie (the server refuses). A UI-only check
// would pass against a client-side-only gate, which is exactly the class of bug
// this journey exists to catch.
const { expect } = require('@playwright/test');
const identity = require('./identity');
const { agentRail } = require('./agent-rail');

// Copy single-sourced from admin-console/src/pages/agent-chat/team-share-view.js.
// Duplicated as literals rather than imported: the console is ESM browser code
// and this runner is CJS, and asserting on the STRING is the point — a reworded
// notice should fail this journey loudly rather than be silently followed.
const READ_ONLY_NOTICE =
  'You can see who has access to this team. Only a Team Admin can add, change or remove people.';
const SUCCESSOR_NOTICE =
  'You are about to remove the last Team Admin. Choose who takes over as Team Admin in the same step.';
const ROLE_LABELS = { 'team-admin': 'Team Admin', 'team-member': 'Team Member' };
// `emptyStatePointer().lead` from admin-console/src/pages/agent-chat/empty-state.js —
// what the rail shows instead of the agent list when the caller can see no
// agents at all, which is precisely this journey's "private by default" state.
const EMPTY_RAIL_LEAD = 'No agents yet.';

// ── internal helpers (NOT exported — every export becomes a journey step) ────

function xpathLiteral(s) {
  // Names used by this journey's fixture contain no quotes; refuse rather than
  // silently build a broken expression if that ever changes.
  if (String(s).includes('"')) throw new Error(`access: unsupported quote in name "${s}"`);
  return `"${s}"`;
}

// The Share panel. It is no longer a SidePanel `role="dialog"` — it moved to the
// team's own "Sharing" configuration tab (team-config-tabs-view.js), reached by
// the rail's "Share…" entry routing to `/chats/<teamId>?tab=sharing`. Only one
// `ShareTeamPanel` is mounted at a time; anchor on its stable intro sentence and
// climb to the panel root (`<p>` → intro row → root), so the member-row and
// add-cluster locators below scope exactly as they did against the old dialog.
// `teamId` is kept in the signature for call-site readability; unused here.
function sharePanel(ctx, _teamId) {
  return ctx.page
    .locator('p', { hasText: 'Everyone listed here can open' })
    .locator('xpath=../..');
}

// A member row is `<div>(row) > <div>(names) > <div>(display name [+ ' (you)'])`,
// with the row's own children being that names block plus the role control.
//
// Anchor BOTTOM-UP, on the leaf div holding the name, and climb two levels. The
// obvious top-down form — "the div whose grandchild div starts with this name" —
// is ambiguous: the member-list wrapper and the panel root satisfy it too (their
// descendants are the same text), so Playwright's strict mode would reject the
// locator with three matches. `not(descendant::div)` picks the leaf, and the
// only other leaf div on a row is the email, which never starts with the name.
function memberRow(panel, label) {
  const nameCell = panel.locator(
    `xpath=.//div[not(descendant::div)][starts-with(normalize-space(.), ${xpathLiteral(label)})]`,
  );
  return nameCell.locator('xpath=../..');
}

// The add-a-colleague control cluster: the flex row immediately after the
// search input, holding [candidate select][role select][Add].
function addCluster(panel) {
  return panel.getByPlaceholder('Search by name or email…')
    .locator('xpath=following-sibling::div[1]');
}

async function directoryIdFor(ctx, subject) {
  const res = await ctx.request.get('/api/users/directory');
  expect(res.ok(), `GET /api/users/directory failed: HTTP ${res.status()}`).toBeTruthy();
  const list = await res.json();
  const wanted = String(subject).toLowerCase();
  const hit = (Array.isArray(list) ? list : []).find(u => {
    const email = String(u.email || '').toLowerCase();
    const name = String(u.displayName || '').toLowerCase();
    return email === wanted || name === wanted;
  });
  if (!hit) throw new Error(`no directory entry for "${subject}" — known: ${JSON.stringify(list)}`);
  return hit.id;
}

async function chatAgents(ctx) {
  const res = await ctx.request.get('/api/matrix/agents?includeStubs=1&includeDisabled=1');
  expect(res.ok(), `GET /api/matrix/agents failed: HTTP ${res.status()}`).toBeTruthy();
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

// Does this caller reach the team at all? A team agent is tokenless and so is
// never itself listed; its reachability is expressed by its members.
function reachesTeam(rows, teamId) {
  return rows.some(r => r && (r.id === teamId || r.parentTeamId === teamId));
}

// ── steps ───────────────────────────────────────────────────────────────────

/**
 * Point the journey at one signed-in human. Every later step — and every
 * screenshot — runs as that identity until the next call.
 *
 * @param {string} params.as - Identity name: `owner`, `colleague` or `admin`.
 * @param {string} [params.goto] - Optional path to navigate to after switching.
 * @example
 * - action:
 *     do: access.actAs
 *     as: colleague
 *     goto: /chats
 */
async function actAs(ctx, { as, goto }) {
  const id = identity.activate(ctx, as);
  if (goto) {
    await id.page.goto(goto);
    await id.page.waitForLoadState('domcontentloaded');
  }
  return { as };
}

/**
 * Create an Agent Team as the ACTIVE identity, through the real self-service
 * route (#2081) — which is what records the creator as its Team Admin.
 *
 * `materializeMembers: false` keeps this cheap: the single role lands as a stub
 * (config + triggers.json, no Matrix user, no clone, no container). A stub is
 * still a member, which matters — `buildGroups` derives the rail's team groups
 * from member rows, so a memberless team would render no group header and the
 * Share… menu would be unreachable.
 *
 * @param {string} params.teamId - Slug id for the new Agent Team.
 * @param {string} params.teamName - Display name for the team.
 * @param {string} [params.roleTemplate=generic] - Role template for the one stub member.
 * @example
 * - action:
 *     do: access.createTeam
 *     teamId: share-demo
 *     teamName: Share Demo
 */
async function createTeam(ctx, { teamId, teamName, roleTemplate = 'generic' }) {
  const res = await ctx.request.post('/api/teams', {
    data: { teamId, teamName, roles: [roleTemplate], materializeMembers: false },
    timeout: 120_000,
  });
  expect(
    res.ok(),
    `createTeam(${teamId}) as ${identity.activeName(ctx)} expected 2xx, `
    + `got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  return res.json();
}

/**
 * Assert the active identity CAN reach the team — in the API list and in the
 * Agent Chat rail.
 *
 * @param {string} params.teamId - Team slug id that must be reachable.
 * @param {string} [params.teamName] - Team display name shown as the rail's
 *   group header (the team agent's displayName); defaults to the id.
 * @example
 * - assert:
 *     do: access.expectTeamVisible
 *     teamId: share-demo
 *     teamName: Share Demo
 */
async function expectTeamVisible(ctx, { teamId, teamName }) {
  const who = identity.activeName(ctx);
  await expect
    .poll(async () => reachesTeam(await chatAgents(ctx), teamId), {
      message: `${who} should reach team ${teamId} via GET /api/matrix/agents`,
      timeout: 30_000,
    })
    .toBe(true);
  await ctx.page.reload();
  const rail = agentRail(ctx.page);
  // The rail group header shows the team's display NAME (the team agent's
  // displayName), not the raw slug — assert on it when the caller gives one.
  await expect(rail.getByText(teamName || teamId, { exact: true }).first()).toBeVisible({ timeout: 30_000 });
}

/**
 * Assert the active identity CANNOT reach the team — private by default (D1).
 * Checked both server-side (the list simply does not contain it) and in the
 * rail, so a filtered API with a leaky UI, or the reverse, both fail.
 *
 * @param {string} params.teamId - Team slug id that must NOT be reachable.
 * @param {string} [params.teamName] - Team display name that must not appear in
 *   the rail (the header text when present); defaults to the id.
 * @example
 * - assert:
 *     do: access.expectTeamHidden
 *     teamId: share-demo
 *     teamName: Share Demo
 */
async function expectTeamHidden(ctx, { teamId, teamName }) {
  const who = identity.activeName(ctx);
  const rows = await chatAgents(ctx);
  expect(
    reachesTeam(rows, teamId),
    `${who} must NOT see team ${teamId}; GET /api/matrix/agents returned ${JSON.stringify(rows.map(r => r.id))}`,
  ).toBe(false);

  // Wait for the rail to have actually rendered before asserting an ABSENCE,
  // or this passes against a page that has simply not finished loading.
  //
  // It renders one of TWO things, which is the trap here: `AgentChat.jsx` mounts
  // `AgentList` — and therefore the "Agents" list — only when `agents.length > 0`,
  // and hands someone with no agents at all the `emptyStatePointer()` text
  // instead. Both of this journey's "sees nothing" beats are exactly that case,
  // so waiting for the list alone would fail on the very state being proven.
  await ctx.page.reload();
  const rail = agentRail(ctx.page);
  const noAgents = ctx.page.getByText(EMPTY_RAIL_LEAD, { exact: true });
  await expect(rail.or(noAgents).first()).toBeVisible({ timeout: 30_000 });
  // Page-wide rather than rail-scoped, so it holds in both renderings. The rail
  // header would show the display NAME if the team were present, so assert that
  // (falling back to the id) is absent.
  await expect(ctx.page.getByText(teamName || teamId, { exact: true })).toHaveCount(0);
}

/**
 * Open the team's Share panel from the rail's group context menu.
 *
 * The kebab is a `<button>` labelled `Team actions for <label>`,
 * where <label> is the team's DISPLAY NAME (rail-lifecycle.js: `displayName ||
 * id`), and the portaled menu carries the same accessible name. The acting
 * identity sees only the one shared team in its rail here, so match the stable
 * `Team actions for ` prefix rather than the display name. The menu closes on
 * any scroll, so nothing scrolls in between.
 *
 * "Share…" now ROUTES to the team's Sharing configuration tab rather than
 * opening a SidePanel, so this waits for that tab's list heading to appear
 * (which only happens after the navigation and the panel's own fetch).
 *
 * @param {string} params.teamId - Team whose group header carries the menu.
 * @example
 * - action:
 *     do: access.openShare
 *     teamId: share-demo
 */
async function openShare(ctx, { teamId }) {
  const menuName = /^Team actions for /;
  await ctx.page.getByRole('button', { name: menuName }).first().click();
  const menu = ctx.page.getByRole('menu', { name: menuName });
  await expect(menu).toBeVisible({ timeout: 15_000 });
  await menu.getByRole('menuitem', { name: 'Share…' }).click();
  // The Sharing tab loads memberships + directory on mount; wait for the list
  // heading — its presence proves the route change and mount both landed, so a
  // later row assertion is not racing either.
  await expect(
    sharePanel(ctx, teamId).getByRole('heading', { level: 3, name: /^Has access/ }),
  ).toBeVisible({ timeout: 15_000 });
}

/**
 * Leave the Share panel. There is no SidePanel to dismiss anymore — the panel is
 * a configuration tab — so this returns to the chat root and confirms the panel
 * is gone, which is the same observable end state the old Close button produced.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @example
 * - action:
 *     do: access.closeShare
 *     teamId: share-demo
 */
async function closeShare(ctx, { teamId }) {
  await ctx.page.goto('/chats');
  await ctx.page.waitForLoadState('domcontentloaded');
  await expect(sharePanel(ctx, teamId)).toHaveCount(0);
}

/**
 * Assert the open Share panel is READ-ONLY for the active identity (AC9): the
 * member list is legible, but there is no role control, no remove control and
 * no add section — and the panel says so in as many words.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @example
 * - assert:
 *     do: access.expectShareReadOnly
 *     teamId: share-demo
 */
async function expectShareReadOnly(ctx, { teamId }) {
  const panel = sharePanel(ctx, teamId);
  await expect(panel.getByText(READ_ONLY_NOTICE)).toBeVisible();
  await expect(panel.getByRole('heading', { level: 3, name: 'Add a colleague' })).toHaveCount(0);
  await expect(panel.getByRole('combobox')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Remove' })).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Leave' })).toHaveCount(0);
}

/**
 * Assert the open Share panel is MANAGEABLE for the active identity: the add
 * section is present and the read-only notice is not.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @example
 * - assert:
 *     do: access.expectShareManageable
 *     teamId: share-demo
 */
async function expectShareManageable(ctx, { teamId }) {
  const panel = sharePanel(ctx, teamId);
  await expect(panel.getByRole('heading', { level: 3, name: 'Add a colleague' })).toBeVisible();
  await expect(panel.getByText(READ_ONLY_NOTICE)).toHaveCount(0);
  await expect(addCluster(panel).getByRole('button', { name: 'Add' })).toBeVisible();
}

// Assert one person's row shows the expected role, whichever rendering applies
// (a `<select>` when the viewer may manage, plain text when they may not).
//
// NOT exported: `addColleague` and `setMemberRole` call it to confirm their own
// effect, but no journey names it, and the registry turns every export into
// vocabulary — a step in the catalog that nothing calls reads as coverage that
// does not exist.
async function expectMemberRole(ctx, { teamId, person, role }) {
  const label = ROLE_LABELS[role];
  expect(label, `unknown role "${role}"`).toBeTruthy();
  const row = memberRow(sharePanel(ctx, teamId), person);
  await expect(row).toBeVisible({ timeout: 15_000 });
  const select = row.getByRole('combobox');
  if (await select.count()) {
    await expect(select).toHaveValue(role);
  } else {
    await expect(row.getByText(label, { exact: true })).toBeVisible();
  }
}

/**
 * Add a colleague through the Share panel's picker, at a chosen role.
 *
 * The candidate option's VALUE is the user id, so the selection is made by
 * value rather than by label — a display-name match would be ambiguous the
 * moment two people share a name.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @param {string} params.subject - Login subject of the person to add.
 * @param {string} params.person - Their display name, for the row assertion.
 * @param {string} [params.role=team-member] - Role to grant.
 * @example
 * - action:
 *     do: access.addColleague
 *     teamId: share-demo
 *     subject: bea@e2e.local
 *     person: Bea Colleague
 */
async function addColleague(ctx, { teamId, subject, person, role = 'team-member' }) {
  const panel = sharePanel(ctx, teamId);
  const userId = await directoryIdFor(ctx, subject);
  const cluster = addCluster(panel);
  await cluster.locator('select').first().selectOption({ value: userId });
  await cluster.locator('select').nth(1).selectOption({ value: role });
  await cluster.getByRole('button', { name: 'Add' }).click();
  await expect(memberRow(panel, person)).toBeVisible({ timeout: 15_000 });
  await expectMemberRole(ctx, { teamId, person, role });
}

/**
 * Change a member's role from their row's select.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @param {string} params.person - Display name shown on the row.
 * @param {string} params.role - `team-admin` or `team-member`.
 * @example
 * - action:
 *     do: access.setMemberRole
 *     teamId: share-demo
 *     person: Bea Colleague
 *     role: team-admin
 */
async function setMemberRole(ctx, { teamId, person, role }) {
  const panel = sharePanel(ctx, teamId);
  await memberRow(panel, person).getByRole('combobox').selectOption({ value: role });
  await expectMemberRole(ctx, { teamId, person, role });
}

/**
 * Assert the SERVER refuses a membership write by the active identity (403) —
 * the half of "B cannot change members" that a hidden button does not prove.
 *
 * @param {string} params.teamId - Team to attempt the write against.
 * @param {string} params.subject - Login subject of the person to grant a role to.
 * @param {string} [params.role=team-admin] - Role the refused write would grant.
 * @example
 * - assert:
 *     do: access.expectMembershipWriteRefused
 *     teamId: share-demo
 *     subject: bea@e2e.local
 */
async function expectMembershipWriteRefused(ctx, { teamId, subject, role = 'team-admin' }) {
  const who = identity.activeName(ctx);
  const userId = await directoryIdFor(ctx, subject);
  const res = await ctx.request.post('/api/admin/memberships', {
    data: { teamId, userId, role },
  });
  expect(
    res.status(),
    `${who} must be refused POST /api/admin/memberships on ${teamId}; body: ${await res.text()}`,
  ).toBe(403);
}

/**
 * Assert the SERVER accepts a membership write by the active identity — the
 * positive counterpart, so "B can now manage" is proven at the gate and not
 * only by a button appearing.
 *
 * @param {string} params.teamId - Team to write against.
 * @param {string} params.subject - Login subject whose role is set.
 * @param {string} params.role - Role to set.
 * @example
 * - assert:
 *     do: access.expectMembershipWriteAllowed
 *     teamId: share-demo
 *     subject: bea@e2e.local
 *     role: team-admin
 */
async function expectMembershipWriteAllowed(ctx, { teamId, subject, role }) {
  const who = identity.activeName(ctx);
  const userId = await directoryIdFor(ctx, subject);
  const res = await ctx.request.post('/api/admin/memberships', {
    data: { teamId, userId, role },
  });
  expect(
    res.ok(),
    `${who} should be allowed POST /api/admin/memberships on ${teamId}, `
    + `got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
}

/**
 * Assert D4: removing the LAST Team Admin is refused when no successor is named
 * — at the server (409), with the refusal message naming the requirement.
 *
 * @param {string} params.teamId - Team to attempt the removal against.
 * @param {string} params.subject - Login subject of the last admin being removed.
 * @example
 * - assert:
 *     do: access.expectLastAdminRemovalRefused
 *     teamId: share-demo
 *     subject: ada@e2e.local
 */
async function expectLastAdminRemovalRefused(ctx, { teamId, subject }) {
  const userId = await directoryIdFor(ctx, subject);
  const res = await ctx.request.delete(
    `/api/admin/memberships?userId=${encodeURIComponent(userId)}&teamId=${encodeURIComponent(teamId)}`,
  );
  const body = await res.text();
  expect(
    res.status(),
    `removing the last admin of ${teamId} without a successor must be refused; body: ${body}`,
  ).toBe(409);
  // Assert the STABLE code, not the prose. orchestrator/team-admin-succession.js
  // says so in as many words: callers key on `code`, "rather than matching on
  // message text" — so a reworded refusal must not fail this journey, while a
  // refusal for a different reason must.
  let parsed = {};
  try { parsed = JSON.parse(body); } catch { /* non-JSON body → assertion below reports it */ }
  expect(parsed.code, `expected code 'successor-required' in the 409 body: ${body}`)
    .toBe('successor-required');
}

/**
 * Assert the Share panel's D4 hand-over prompt is showing — the UI half of the
 * same rule: the last admin is asked who takes over, in the same step.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @example
 * - assert:
 *     do: access.expectHandoverPrompt
 *     teamId: share-demo
 */
async function expectHandoverPrompt(ctx, { teamId }) {
  const panel = sharePanel(ctx, teamId);
  await expect(panel.getByText(SUCCESSOR_NOTICE)).toBeVisible({ timeout: 15_000 });
  await expect(panel.getByRole('button', { name: 'Hand over and remove' })).toBeVisible();
}

/**
 * Click the row's Leave/Remove control, which raises the D4 hand-over prompt
 * when the target is the team's last admin.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @param {string} params.person - Display name shown on the row.
 * @example
 * - action:
 *     do: access.requestRemoval
 *     teamId: share-demo
 *     person: Ada Owner
 */
async function requestRemoval(ctx, { teamId, person }) {
  const row = memberRow(sharePanel(ctx, teamId), person);
  const leave = row.getByRole('button', { name: 'Leave' });
  const remove = row.getByRole('button', { name: 'Remove' });
  if (await leave.count()) await leave.click();
  else await remove.click();
}

/**
 * Dismiss the D4 hand-over prompt without acting, leaving the membership set
 * exactly as it was — so the journey can prove the refusal without spending the
 * sole-admin state it needs for the beats that follow.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @example
 * - action:
 *     do: access.cancelHandover
 *     teamId: share-demo
 */
async function cancelHandover(ctx, { teamId }) {
  const panel = sharePanel(ctx, teamId);
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByText(SUCCESSOR_NOTICE)).toHaveCount(0);
}

/**
 * Complete the D4 hand-over: name a successor and confirm, so the promotion and
 * the removal land in ONE write and the team is never un-administrable.
 *
 * @param {string} params.teamId - Team whose Share panel is open.
 * @param {string} params.successorSubject - Login subject of the incoming Team Admin.
 * @param {string} params.leaving - Display name of the row being removed.
 * @example
 * - action:
 *     do: access.completeHandover
 *     teamId: share-demo
 *     successorSubject: bea@e2e.local
 *     leaving: Ada Owner
 */
async function completeHandover(ctx, { teamId, successorSubject, leaving }) {
  const panel = sharePanel(ctx, teamId);
  const successorId = await directoryIdFor(ctx, successorSubject);
  const box = panel.getByRole('button', { name: 'Hand over and remove' }).locator('xpath=../..');
  await box.locator('select').selectOption({ value: successorId });
  await panel.getByRole('button', { name: 'Hand over and remove' }).click();
  await expect(memberRow(panel, leaving)).toHaveCount(0, { timeout: 15_000 });
}

/**
 * Assert the team's membership set is exactly the expected (subject → role) map,
 * read from the API as the active identity. The invariant D4 protects — that a
 * team always has at least one admin — is checked here too.
 *
 * @param {string} params.teamId - Team to read memberships for.
 * @param {object} params.expected - Map of login subject → role.
 * @example
 * - assert:
 *     do: access.expectMemberships
 *     teamId: share-demo
 *     expected:
 *       bea@e2e.local: team-admin
 */
async function expectMemberships(ctx, { teamId, expected }) {
  const res = await ctx.request.get(
    `/api/admin/memberships?teamId=${encodeURIComponent(teamId)}`,
  );
  expect(res.ok(), `GET memberships failed: HTTP ${res.status()}`).toBeTruthy();
  const rows = (await res.json()).filter(m => m && m.teamId === teamId);

  const bySubject = {};
  for (const subject of Object.keys(expected)) {
    // eslint-disable-next-line no-await-in-loop
    bySubject[await directoryIdFor(ctx, subject)] = subject;
  }
  const actual = {};
  for (const m of rows) {
    actual[bySubject[m.userId] || m.userId] = m.role;
  }
  expect(actual).toEqual(expected);
  expect(
    rows.some(m => m.role === 'team-admin'),
    `team ${teamId} must always retain at least one Team Admin (D4)`,
  ).toBe(true);
}

module.exports = {
  actAs,
  createTeam,
  expectTeamVisible,
  expectTeamHidden,
  openShare,
  closeShare,
  expectShareReadOnly,
  expectShareManageable,
  addColleague,
  setMemberRole,
  expectMembershipWriteRefused,
  expectMembershipWriteAllowed,
  expectLastAdminRemovalRefused,
  expectHandoverPrompt,
  requestRemoval,
  cancelHandover,
  completeHandover,
  expectMemberships,
};
