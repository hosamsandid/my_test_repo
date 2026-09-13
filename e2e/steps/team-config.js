// Team full-width configuration surface step library (#2235/#2240, docs/
// journey-spec-concept.md §2.2). Drives and asserts the three entry points that
// converge on a routed `role: 'team'` agent's `TeamConfigSurface`
// (AgentChat.jsx) and the member<->team switch that must leave the right
// rail's persisted open/collapsed state and width untouched.
//
// No data-testids exist — selectors are ARIA role / accessible name / visible
// text, verified against AgentList.jsx (CollapsibleHeader, KebabButton),
// RowContextMenu.jsx and AgentChat.jsx's TeamConfigSurface/RightRail branch.
const { expect } = require('@playwright/test');

// The rail is one flat `role="listbox"` (AgentList.jsx) — scope every lookup
// to it, mirroring agents.js's expectTeamInRail (`.first()`: the only other
// listbox in the page is the composer's slash-command palette, mounted only
// while open).
function rail(page) {
  return page.locator('[role="listbox"]').first();
}

// The team group header (CollapsibleHeader) is a real `<button aria-selected>`
// with NO explicit `role` (default implicit role "button") — a member row
// (AgentRow) ALSO sets `aria-selected` on its own `<button>`, but stamps
// `role="option"`, so `:not([role="option"])` is what actually disambiguates
// the two (a bare `hasText` filter alone is not enough once a journey's team
// and member labels could ever coincide).
function teamHeaderButton(page, label) {
  return rail(page).locator('button[aria-selected]:not([role="option"])').filter({ hasText: label });
}

// CSS attribute selector matching the literal `aria-label` DOM attribute —
// deliberately NOT `getByRole('button', {name})`, whose match is against the
// COMPUTED accessible name: the kebab (`KebabButton`, a `role="button"` span
// with its own `aria-label="Team actions for <label>"`) sits INSIDE the
// header `<button>`, so "name from contents" folds the kebab's aria-label
// into the header's own accessible name too — `getByRole` then resolves BOTH
// elements and throws a strict-mode violation (found live in CI on this exact
// journey). An attribute selector matches the DOM attribute directly, so it
// can only ever hit the one element that actually carries it.
function cssAttrValue(value) {
  return value.replace(/["\\]/g, '\\$&');
}
function teamKebabButton(page, label) {
  return rail(page).locator(`[aria-label="Team actions for ${cssAttrValue(label)}"]`);
}

/**
 * Entry point 1: click the team's row in the Agent Chat left rail. Clicking it
 * anywhere but its chevron selects the team and opens Settings (AgentList.jsx
 * `handleActivate`), landing on `/chats/<teamId>`.
 *
 * @param {string} params.teamId - The team's own agent id.
 * @param {string} params.label - The team row's rendered label (its display name).
 * @example
 * - action:
 *     do: team-config.openTeamFromRow
 *     teamId: team-config-demo
 *     label: Team Config Demo
 */
async function openTeamFromRow(ctx, { teamId, label }) {
  const { page } = ctx;
  await page.goto('/chats');
  const header = teamHeaderButton(page, label);
  await expect(header).toBeVisible();
  await header.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${teamId}$`));
}

/**
 * Entry point 2: the team row's context menu's "Team settings…" entry
 * (`agent-lifecycle-menu.js` `buildTeamMenu`, key `edit-team`) — opened via the
 * always-present (dimmed until hover) kebab, which `RailLifecycleHost.jsx`
 * routes to the same `/chats/<teamId>` navigation as the row click.
 *
 * @param {string} params.teamId - The team's own agent id.
 * @param {string} params.label - The team row's rendered label (its display name).
 * @example
 * - action:
 *     do: team-config.openTeamFromMenu
 *     teamId: team-config-demo
 *     label: Team Config Demo
 */
async function openTeamFromMenu(ctx, { teamId, label }) {
  const { page } = ctx;
  await page.goto('/chats');
  const kebab = teamKebabButton(page, label);
  await expect(kebab).toBeVisible();
  await kebab.click();
  const menuItem = page.getByRole('menuitem', { name: 'Team settings…' });
  await expect(menuItem).toBeVisible();
  await menuItem.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${teamId}$`));
}

/**
 * Entry point 3: a direct `/chats/<teamId>` URL (a bookmark, or a link from
 * elsewhere in the console) — the route-driven `subjectIsTeam` derivation
 * means no prior rail interaction is needed for this to resolve to the same
 * surface as the other two entry points.
 *
 * @param {string} params.teamId - The team's own agent id.
 * @example
 * - action:
 *     do: team-config.openTeamByUrl
 *     teamId: team-config-demo
 */
async function openTeamByUrl(ctx, { teamId }) {
  await ctx.page.goto(`/chats/${teamId}`);
}

/**
 * Assert the routed team landed on the #2235 full-width `TeamConfigSurface`,
 * not the ordinary chat-column + tabbed-right-rail split every other entry
 * point used to fall back to:
 *   - the team's own edit form is showing directly ("Team Default Prompt" is a
 *     field label rendered only for `agent.role === 'team'`, AgentEditForm.jsx)
 *     rather than behind a Settings tab click;
 *   - no chat composer (a team hosts no conversation of its own, AC1);
 *   - no RightRail tab bar at all (Sessions/Workspace/Triggers/Outcomes/
 *     Knowledge/Settings — AgentChat.jsx's `subjectIsTeam` branch never mounts
 *     `RightRail`, so this is a structural absence, not merely an unselected tab).
 *
 * @param {string} params.teamId - The team's own agent id (asserts the URL landed here).
 * @example
 * - assert:
 *     do: team-config.expectFullWidthSurface
 *     teamId: team-config-demo
 */
async function expectFullWidthSurface(ctx, { teamId }) {
  const { page } = ctx;
  await expect(page).toHaveURL(new RegExp(`/chats/${teamId}$`));
  await expect(page.getByText('Team Default Prompt')).toBeVisible({ timeout: 15_000 });
  await expect(page.getByPlaceholder(/Message .*to send/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Sessions', exact: true })).toHaveCount(0);
}

/**
 * Toggle the right rail's open/collapsed state via the Cmd/Ctrl+Shift+L
 * shortcut (AgentChat.jsx) — only meaningful while a MEMBER chat is open; the
 * shortcut is a deliberate no-op while a team subject is routed (AC13/AC14),
 * which is exercised separately by `expectShortcutNoOpOnTeam`.
 *
 * @example
 * - action:
 *     do: team-config.toggleRailPanel
 */
async function toggleRailPanel(ctx) {
  await ctx.page.keyboard.press('Control+Shift+L');
}

/**
 * Assert the shortcut has NO effect while a team is the routed subject
 * (AC13/AC14): press it, then assert the persisted `agentChat.logOpen`
 * preference is byte-identical to what it was immediately before — proving
 * the team view neither reacts to the key nor touches the stored preference.
 *
 * @example
 * - assert:
 *     do: team-config.expectShortcutNoOpOnTeam
 */
async function expectShortcutNoOpOnTeam(ctx) {
  const { page } = ctx;
  const before = await page.evaluate(() => localStorage.getItem('agentChat.logOpen'));
  await page.keyboard.press('Control+Shift+L');
  const after = await page.evaluate(() => localStorage.getItem('agentChat.logOpen'));
  expect(after, 'Cmd/Ctrl+Shift+L must not change the persisted rail preference while a team is open').toBe(before);
}

/**
 * Snapshot the right rail's persisted open/collapsed state and width
 * (`agentChat.logOpen` / `agentChat.rightWidth`, AgentChat.jsx) under a name,
 * so a later step can assert it survived a member<->team round trip. Stashed
 * on `ctx` for the run's lifetime — the same pattern as flows.js's
 * `captureDraftWiring`/`expectDraftWiringEqual`.
 *
 * @param {string} params.as - Name to store the snapshot under.
 * @example
 * - action:
 *     do: team-config.captureRailState
 *     as: beforeTeamSwitch
 */
async function captureRailState(ctx, { as }) {
  const { page } = ctx;
  const state = await page.evaluate(() => ({
    logOpen: localStorage.getItem('agentChat.logOpen'),
    rightWidth: localStorage.getItem('agentChat.rightWidth'),
  }));
  ctx.railStateSnapshots = ctx.railStateSnapshots || {};
  ctx.railStateSnapshots[as] = state;
}

/**
 * Assert two captured rail-state snapshots are identical — the member<->team
 * round-trip guarantee (AC: switching to a member and back restores the right
 * rail's prior open/collapsed state and width).
 *
 * @param {string} params.a - First snapshot name (team-config.captureRailState).
 * @param {string} params.b - Second snapshot name.
 * @example
 * - assert:
 *     do: team-config.expectRailStateEqual
 *     a: beforeTeamSwitch
 *     b: afterTeamSwitch
 */
async function expectRailStateEqual(ctx, { a, b }) {
  const snaps = ctx.railStateSnapshots || {};
  if (!snaps[a] || !snaps[b]) throw new Error(`missing rail-state snapshot ${!snaps[a] ? a : b}`);
  expect(snaps[b], `right rail state must be unchanged between ${a} and ${b}`).toEqual(snaps[a]);
}

/**
 * Click a member's row in the rail (the ordinary chat-openable path back out
 * of a team surface) and wait for its composer, so the member<->team switch
 * can be driven entirely through the rail rather than a raw URL.
 *
 * @param {string} params.agentId - The member's agent id.
 * @param {string} params.label - The member row's rendered label (its display name).
 * @example
 * - action:
 *     do: team-config.openMemberFromRow
 *     agentId: team-config-demo-business-analyst
 *     label: Business Analyst
 */
async function openMemberFromRow(ctx, { agentId, label }) {
  const { page } = ctx;
  const row = rail(page).getByRole('option', { name: label });
  await expect(row).toBeVisible();
  await row.click();
  await expect(page).toHaveURL(new RegExp(`/chats/${agentId}$`));
  await expect(page.getByPlaceholder(/Message .*to send/)).toBeVisible();
}

module.exports = {
  openTeamFromRow,
  openTeamFromMenu,
  openTeamByUrl,
  expectFullWidthSurface,
  toggleRailPanel,
  expectShortcutNoOpOnTeam,
  captureRailState,
  expectRailStateEqual,
  openMemberFromRow,
};
