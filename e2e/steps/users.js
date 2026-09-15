// Users page step library (#2059, docs/journey-spec-concept.md §2.2).
//
// Steps for the Users page (admin-console Users.jsx, route /users) and for the
// login route behind it. They exist for one journey: proving that the
// configured initial user is a SEED and not a login (#2059 / concept #2041 D13).
//
// The page has no data-testids, so selectors are the DataTable row containing
// the subject, the `aria-label`s the shared `IconButton` sets ("Edit user",
// "Delete user"), the "Login password" section's own field/buttons and the
// System-Admin checkbox's visible label — all verified against Users.jsx.
//
// No fixture: the record this drives is the one the ORCHESTRATOR seeded at
// first boot from `ADMIN_USERNAME`/`ADMIN_PASSWORD`, which is the whole point.
// Seeding it from a fixture would prove nothing about the mechanism under test.
const { expect } = require('@playwright/test');

// The DataTable row for a subject. Subject is rendered in a monospace span, so
// an exact-text row filter is stable even when a display name also matches.
function userRow(page, subject) {
  return page.locator('tr').filter({ hasText: subject });
}

/**
 * Open the Users page and confirm its chrome rendered: the top-bar title and
 * the one-line description that keeps the Access hand-off.
 *
 * @example
 * - action:
 *     do: users.openUsersPage
 */
async function openUsersPage(ctx) {
  const { page } = ctx;
  await page.goto('/users');
  // /users is the System-Admin "Administration" page since #2085 (the former
  // Access page was dissolved into it): one H1 with Users / All Teams /
  // Resources tabs, the standalone Users page folded into its default Users tab.
  await expect(page.getByRole('heading', { name: 'Administration', level: 1 })).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Users' })).toHaveAttribute('aria-selected', 'true');
}

/**
 * Assert the administrator the stack was seeded with is an ORDINARY, editable
 * user record in this list — #2059 AC5. Before #2059 the console's only
 * principal was the env credential, which had no record and appeared nowhere.
 *
 * @param {string} params.subject - The seeded subject (the stack's ADMIN_USERNAME).
 * @example
 * - assert:
 *     do: users.expectSeededAdminRow
 *     subject: admin
 */
async function expectSeededAdminRow(ctx, { subject }) {
  const row = userRow(ctx.page, subject);
  await expect(row).toBeVisible();
  // It is a System Admin, and it has a login password — the two things the
  // first-boot seed is responsible for.
  await expect(row.getByText('System Admin', { exact: true })).toBeVisible();
  await expect(row.getByText('Set', { exact: true })).toBeVisible();
  // And it is manageable here, unlike the recordless principal it replaced.
  await expect(row.getByRole('button', { name: 'Edit user' })).toBeEnabled();
}

/**
 * Assert the row's Delete is refused because this is the last System Admin
 * (#2059 AC7). The store owns the rule; the page mirrors it as a disabled
 * control, so the refusal is visible before the click rather than after it.
 *
 * @param {string} params.subject - The subject whose row must be undeletable.
 * @example
 * - assert:
 *     do: users.expectLastAdminUndeletable
 *     subject: admin
 */
async function expectLastAdminUndeletable(ctx, { subject }) {
  const row = userRow(ctx.page, subject);
  // The accessible name is deliberately unchanged by the guard — only the
  // disabled state and the tooltip differ — so this locator is the same one a
  // pre-#2059 spec would have used.
  await expect(row.getByRole('button', { name: 'Delete user' })).toBeDisabled();
}

/**
 * Open a user's edit panel and change the login password through the UI, then
 * confirm the page reported it (#2059 AC9). This is the surface that replaces
 * "edit .env and restart": after this, the value in .env no longer signs in.
 *
 * @param {string} params.subject - The record to edit.
 * @param {string} params.password - The new login password.
 * @example
 * - action:
 *     do: users.setLoginPassword
 *     subject: admin
 *     password: rotated-by-journey
 */
async function setLoginPassword(ctx, { subject, password }) {
  const { page } = ctx;
  await userRow(page, subject).getByRole('button', { name: 'Edit user' }).click();

  // The panel's own heading, so we are certainly inside it before typing.
  await expect(page.getByRole('heading', { name: 'Login password' })).toBeVisible();
  await page.getByPlaceholder(/login password/i).fill(password);
  await page.getByRole('button', { name: 'Set', exact: true }).click();
  await expect(page.getByText('Login password set.')).toBeVisible();

  // Close the panel so the next step sees the list again.
  await page.keyboard.press('Escape');
}

/**
 * Assert the System-Admin checkbox is locked for the last System Admin, with
 * the store's own reason shown as visible text (#2059 AC7). Requires the edit
 * panel for that record to be open.
 *
 * @param {string} params.subject - The record whose panel to open.
 * @example
 * - assert:
 *     do: users.expectSystemAdminFlagLocked
 *     subject: admin
 */
async function expectSystemAdminFlagLocked(ctx, { subject }) {
  const { page } = ctx;
  await userRow(page, subject).getByRole('button', { name: 'Edit user' }).click();
  const box = page.getByLabel('System Admin (global access)');
  await expect(box).toBeChecked();
  await expect(box).toBeDisabled();
  await expect(page.getByText(/last System Admin cannot be demoted/)).toBeVisible();
  await page.keyboard.press('Escape');
}

/**
 * Assert `POST /api/auth/login` REJECTS these credentials with 401 — used with
 * the stack's configured `ADMIN_PASSWORD` after the record's password has been
 * changed, which is the end-to-end proof that the configured credential is a
 * one-time seed and not a standing login (#2059 AC4/AC9).
 *
 * A 401 is asserted specifically, not merely "not 200": a 503 would mean the
 * user store did not answer, which is a different failure and must not pass
 * for a rejection.
 *
 * @param {string} params.username - Subject to try.
 * @param {string} params.password - Password to try.
 * @example
 * - assert:
 *     do: users.expectLoginRejected
 *     username: admin
 *     password: e2e-admin-pass
 */
async function expectLoginRejected(ctx, { username, password }) {
  const res = await ctx.request.post('/api/auth/login', { data: { username, password } });
  expect(res.status(), `login with "${password}" must be rejected`).toBe(401);
}

/**
 * Assert `POST /api/auth/login` ACCEPTS these credentials and that the session
 * resolves to a real user record — the `userId` is non-null (#2059 AC6). That
 * id is what makes a team's creator recordable, preferences persistable and the
 * audit actor resolvable; before #2059 this principal had none.
 *
 * @param {string} params.username - Subject to sign in as.
 * @param {string} params.password - Password to sign in with.
 * @example
 * - assert:
 *     do: users.expectLoginResolvesToRecord
 *     username: admin
 *     password: rotated-by-journey
 */
async function expectLoginResolvesToRecord(ctx, { username, password }) {
  const res = await ctx.request.post('/api/auth/login', { data: { username, password } });
  expect(res.status(), `login with "${password}" must succeed`).toBe(200);

  const body = await res.json();
  expect(body.authenticated).toBe(true);
  expect(body.user.username).toBe(username);
  // The assertion this journey exists for: a real id, not the old `null`.
  expect(body.user.userId, 'the session must resolve to a real user record').toBeTruthy();
  expect(body.user.admin).toBe(true);

  // And it is durable: the session endpoint reports the same identity.
  const session = await ctx.request.get('/api/auth/session');
  expect(session.status()).toBe(200);
  const sessionBody = await session.json();
  expect(sessionBody.user.userId).toBe(body.user.userId);
}

module.exports = {
  openUsersPage,
  expectSeededAdminRow,
  expectLastAdminUndeletable,
  setLoginPassword,
  expectSystemAdminFlagLocked,
  expectLoginRejected,
  expectLoginResolvesToRecord,
};
