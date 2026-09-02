// F0 — Login + navigation smoke (docs/e2e-testing-concept.md §2).
//
// The cheapest possible canary: with an authenticated session (storageState
// from global-setup, logged in via the real #276 gate) click through every
// nav entry and assert each page actually mounts. Catches build breakage,
// lazy-chunk failures, routing regressions, and render crashes.
//
// Discipline (§7): no sleeps. Every wait is an auto-waiting assertion on
// user-visible state (the header breadcrumb, the Suspense fallback clearing,
// non-empty page content) — the same signals a human uses.
const { test, expect } = require('@playwright/test');

// Every nav entry the System-Admin (env-credential) session sees, keyed to the
// breadcrumb the Shell renders for its route (admin-console/src/components/Shell.jsx).
// The env admin is a System Admin, so adminOnly entries are visible too.
const NAV_PAGES = [
  { label: 'Agent Chat',           breadcrumb: 'Agent Chat' },
  // The unified "Create" launcher (#1665) — the persistent "+ Create" control
  // above the nav, replacing the former separate Single Agent + Agent Team
  // Wizard sidebar entries (AC8/AC10). Those pages stay reachable via /quickstart
  // and /team-setup deep links and as launcher targets.
  { label: 'Create',               breadcrumb: 'Create' },
  { label: 'Agents',               breadcrumb: 'Agents' },
  { label: 'Flows',                breadcrumb: 'Flows' },
  { label: 'Knowledge',            breadcrumb: 'Knowledge' },
  { label: 'SSH Keys',             breadcrumb: 'SSH Keys' },
  { label: 'GitHub Tokens',        breadcrumb: 'GitHub Tokens' },
  { label: 'Working Environments', breadcrumb: 'Working Environments' },
  { label: 'Users',                breadcrumb: 'Users' },
  { label: 'Access & Users',       breadcrumb: 'Access & Users' },
  { label: 'Skills',               breadcrumb: 'Skills Registry' },
  { label: 'Agent Templates',      breadcrumb: 'Agent Templates' },
  { label: 'Triggers',             breadcrumb: 'Triggers' },
  { label: 'GitHub Event Log',     breadcrumb: 'GitHub Event Log' },
  { label: 'Token Usage',          breadcrumb: 'Token Usage' },
  { label: 'Model Providers',      breadcrumb: 'Model Providers' },
  { label: 'MCP Servers',          breadcrumb: 'MCP Servers' },
  { label: 'Patterns Catalog',     breadcrumb: 'Patterns Catalog' },
  { label: 'Maintenance Mode',     breadcrumb: 'Maintenance Mode' },
];

test('F0: authenticated shell renders and every nav page mounts', async ({ page }) => {
  await page.goto('/');

  // The shell chrome must be present (proves the session is valid and the SPA
  // built): the sidebar brand and the account-menu control (#1802 — the former
  // bare "Sign out" control is now the account menu; Logout lives inside it).
  await expect(page.getByText('Agent Studio', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

  const main = page.locator('main');
  const loadingFallback = page.getByText('Loading...', { exact: true });

  for (const { label, breadcrumb } of NAV_PAGES) {
    await test.step(`navigate to ${label}`, async () => {
      // A nav entry's optional subtitle joins the button's accessible name
      // ("Agent Team Wizard Build a squad of agents"), so exact equality fails
      // on subtitled entries — match the label as a NAME PREFIX instead.
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page.getByRole('button', { name: new RegExp(`^${esc}( |$)`) }).click();

      // Breadcrumb reflects the resolved route.
      await expect(
        page.locator('header').getByText(breadcrumb, { exact: true }),
      ).toBeVisible();

      // Lazy chunk finished loading (the Suspense fallback cleared) and the
      // page mounted with real content — a render crash would leave main empty
      // (no error boundary) or strand the fallback.
      await expect(loadingFallback).toBeHidden();
      await expect(main).not.toBeEmpty();
    });
  }
});
