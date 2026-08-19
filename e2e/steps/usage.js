// Token Usage step library (#1505, docs/journey-spec-concept.md §2.2).
//
// Steps for the Token Usage page (admin-console TokenUsage.jsx, route
// /token-usage) — the System-Admin consumption dashboard backed by the real
// GET /api/usage/summary aggregation. The page has no data-testids, so
// selectors are the <h1>, tab labels, the three <select> controls (each
// identified by an option only it carries), StatCard values and DataTable rows
// — all verified against TokenUsage.jsx.
//
// The deterministic figures come from the `usageData` fixture (fixtures.js),
// which seeds fixed usage records under a dedicated human Team and creates that
// Team so the page's Team filter can narrow to it — isolating the journey's
// numbers from any other usage the live stack may have logged. The journey
// therefore drives two real controls (Team filter + time-range preset, and a
// grouping change) rather than mocking the API.
const { expect } = require('@playwright/test');

// The three page <select>s are distinguished by an option only that select
// carries: the Team filter always offers "All teams", the range preset always
// offers "All time", the grouping select always offers "Provider".
function teamSelect(page) {
  return page.locator('select').filter({ has: page.getByRole('option', { name: 'All teams' }) });
}
function rangeSelect(page) {
  return page.locator('select').filter({ has: page.getByRole('option', { name: 'All time' }) });
}
function groupSelect(page) {
  return page.locator('select').filter({ has: page.getByRole('option', { name: 'Provider' }) });
}

/**
 * Open the Token Usage page and confirm its chrome rendered: the <h1>, both
 * tabs (Statistics / Work items) and the tokens-only cost caveat.
 *
 * @example
 * - action:
 *     do: usage.openTokenUsagePage
 */
async function openTokenUsagePage(ctx) {
  const { page } = ctx;
  await page.goto('/token-usage');
  await expect(page.getByRole('heading', { name: 'Token Usage', level: 1 })).toBeVisible();
  await expect(page.getByText('Statistics', { exact: true })).toBeVisible();
  await expect(page.getByText('Work items', { exact: true })).toBeVisible();
}

/**
 * Narrow the page-level Team filter to a seeded team so the figures are
 * deterministic (the fixture logged usage only under this team). Selecting by
 * the option's visible label waits for /api/admin/teams to populate the dropdown.
 *
 * @param {string} params.teamName - The team's display name as shown in the filter.
 * @example
 * - action:
 *     do: usage.selectTeamFilter
 *     teamName: Token Usage Demo
 */
async function selectTeamFilter(ctx, { teamName }) {
  await teamSelect(ctx.page).selectOption({ label: teamName });
}

/**
 * Change the Statistics time-range preset (e.g. to "All time" so the seeded
 * historical records fall in range). One of the page's primary interactive
 * controls (AC3).
 *
 * @param {string} params.label - Preset label: "Last 7 days" | "Last 24 hours" | "Last 30 days" | "All time".
 * @example
 * - action:
 *     do: usage.selectTimeRange
 *     label: All time
 */
async function selectTimeRange(ctx, { label }) {
  await rangeSelect(ctx.page).selectOption({ label });
}

/**
 * Change the Statistics "Group by" dimension (Agent | Team | Model | Provider |
 * Day) and re-key the breakdown table. A second primary interaction (AC3).
 *
 * @param {string} params.label - Grouping label to select.
 * @example
 * - action:
 *     do: usage.selectGrouping
 *     label: Team
 */
async function selectGrouping(ctx, { label }) {
  await groupSelect(ctx.page).selectOption({ label });
}

/**
 * Assert the Statistics tab rendered real usage data (not an empty/error state,
 * AC2): the summary totals, the class split, the per-day chart (not its empty
 * placeholder), and a breakdown row for each expected group key.
 *
 * @param {string} params.totalTokens - Formatted "Total tokens" value (e.g. "7,000").
 * @param {string} params.inputTokens - Formatted "Input" class value (e.g. "3,900").
 * @param {string} params.primaryKey - A breakdown row key that must be present (e.g. an agent id).
 * @param {string} [params.secondaryKey] - A second breakdown row key that must be present.
 * @example
 * - assert:
 *     do: usage.expectStatistics
 *     totalTokens: "7,000"
 *     inputTokens: "3,900"
 *     primaryKey: token-usage-alpha
 *     secondaryKey: token-usage-beta
 */
async function expectStatistics(ctx, { totalTokens, inputTokens, primaryKey, secondaryKey }) {
  const { page } = ctx;
  // The per-day chart is present and populated — never its empty placeholder.
  await expect(page.getByText('Tokens per day', { exact: true })).toBeVisible();
  await expect(page.getByText('No usage in this range.')).toHaveCount(0);
  await expect(page.getByText('Failed to load:')).toHaveCount(0);
  // Summary cards: grand total + the input class split prove the real
  // aggregation ran over the seeded records.
  await expect(page.getByText(totalTokens, { exact: true }).first()).toBeVisible();
  await expect(page.getByText(inputTokens, { exact: true }).first()).toBeVisible();
  // Breakdown table rows.
  await expect(page.getByRole('row').filter({ hasText: primaryKey }).first()).toBeVisible();
  if (secondaryKey) {
    await expect(page.getByRole('row').filter({ hasText: secondaryKey }).first()).toBeVisible();
  }
}

/**
 * Assert the breakdown table carries a specific group row after a grouping
 * change — the row's key and its formatted Total both visible.
 *
 * @param {string} params.key - The group key expected in the first column (e.g. a team id).
 * @param {string} params.total - The formatted Total for that row (e.g. "7,000").
 * @example
 * - assert:
 *     do: usage.expectGroupRow
 *     key: token-usage-demo
 *     total: "7,000"
 */
async function expectGroupRow(ctx, { key, total }) {
  const row = ctx.page.getByRole('row').filter({ hasText: key }).first();
  await expect(row).toBeVisible();
  await expect(row.getByText(total, { exact: true }).first()).toBeVisible();
}

// Volatile regions to mask in screenshots (§7). Every captured value on the
// Statistics tab is deterministic — the seeded token counts and their fixed
// record dates (the "MM-DD" chart labels) — so there is nothing to mask. The
// export documents the seam if a captured region later gains volatile content.
function volatileLocators() {
  return [];
}

module.exports = {
  openTokenUsagePage,
  selectTeamFilter,
  selectTimeRange,
  selectGrouping,
  expectStatistics,
  expectGroupRow,
  volatileLocators,
};
