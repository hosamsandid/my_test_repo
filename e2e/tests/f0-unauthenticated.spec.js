// F0 — unauthenticated gate (docs/e2e-testing-concept.md §5).
//
// The console is always behind the #276 session gate; there is no
// auth-disabling backdoor. This spec opts OUT of the shared authenticated
// storageState and asserts that hitting a protected route with no session
// lands on the login screen instead of the app shell — the auth-gate half of
// the F0 canary.
const { test, expect } = require('@playwright/test');

// Empty storage state — no session cookie.
test.use({ storageState: { cookies: [], origins: [] } });

test('F0: unauthenticated visit shows the login screen, not the app', async ({ page }) => {
  await page.goto('/agents');

  // Login screen is rendered in place of the whole console.
  await expect(page.locator('#login-username')).toBeVisible();
  await expect(page.locator('#login-password')).toBeVisible();
  await expect(page.getByText('Sign in to continue', { exact: true })).toBeVisible();

  // The authenticated shell must NOT be present (#1802 — the account-menu
  // control only renders inside the authenticated shell header).
  await expect(page.getByRole('button', { name: 'Account menu' })).toHaveCount(0);
});
