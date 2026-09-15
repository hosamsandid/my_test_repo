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

// Every nav entry the System-Admin session sees, keyed to the
// breadcrumb the Shell renders for its route (admin-console/src/components/Shell.jsx).
// The storageState identity is the System Admin the orchestrator seeded at
// first boot (#2059), so adminOnly entries are visible too.
const NAV_PAGES = [
  { label: 'Agent Chat',           breadcrumb: 'Agent Chat' },
  // The unified "Create" launcher (#1665) — the persistent "+ Create" control
  // above the nav, replacing the former separate Single Agent + Agent Team
  // Wizard sidebar entries (AC8/AC10). Those pages stay reachable via /quickstart
  // and /team-setup deep links and as launcher targets.
  { label: 'Create',               breadcrumb: 'Create' },
  // No 'Agents' entry: #1930 removed the page and its sidebar entry entirely
  // (/agents now redirects to /chats). Agent management lives in the Agent Chat
  // left rail.
  { label: 'Flows',                breadcrumb: 'Flows' },
  { label: 'Knowledge',            breadcrumb: 'Knowledge' },
  { label: 'SSH Keys',             breadcrumb: 'SSH Keys' },
  { label: 'GitHub Tokens',        breadcrumb: 'GitHub Tokens' },
  // No 'Working Environments' entry: #2170 (epic #2166 A4) removed the page
  // and its sidebar entry entirely (/environments now redirects to /chats). A
  // team edits its own environment from the Agent Chat Settings tab; the
  // System-Admin catalog that replaced its other half is 'Environment
  // Templates' below.
  { label: 'Environment Templates', breadcrumb: 'Environment Templates' },
  // One Administration entry since #2085 (epic #2076 P6, D10): the separate
  // "Access" entry is dissolved, not renamed — its System-Admin halves are the
  // All Teams and Resources tabs of this page, and /teams now redirects here.
  { label: 'Administration',       breadcrumb: 'Administration' },
  { label: 'Skills',               breadcrumb: 'Skills Registry' },
  { label: 'Agent Templates',      breadcrumb: 'Agent Templates' },
  { label: 'My Credentials',       breadcrumb: 'My Credentials' },
  { label: 'GitHub Event Log',     breadcrumb: 'GitHub Event Log' },
  { label: 'Token Usage',          breadcrumb: 'Token Usage' },
  { label: 'Model Providers',      breadcrumb: 'Model Providers' },
  { label: 'MCP Servers',          breadcrumb: 'MCP Servers' },
  { label: 'Plugins',              breadcrumb: 'Plugins' },
  { label: 'Maintenance Mode',     breadcrumb: 'Maintenance Mode' },
];

test('F0: authenticated shell renders and every nav page mounts', async ({ page }) => {
  await page.goto('/');

  // The shell chrome must be present (proves the session is valid and the SPA
  // built): the sidebar brand and the account-menu control (#1802 — the former
  // bare "Sign out" control is now the account menu; Logout lives inside it).
  await expect(page.getByText('Agent Studio', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Account menu' })).toBeVisible();

  // #1595: the sidebar nav is now a set of collapsible accordion groups; only
  // the group holding the active route starts expanded, and a collapsed group
  // unmounts its item buttons (so a click below would time out). Expand every
  // group up front. The group headers are the only buttons carrying
  // aria-expanded — the header-cluster "Help" button uses aria-pressed — so we
  // toggle a header only when it reports aria-expanded="false" (already-open and
  // non-header "Help" are skipped).
  for (const section of ['Agent Setup', 'Connections', 'Administration', 'Help']) {
    const headers = page.getByRole('button', { name: section, exact: true });
    for (let i = 0; i < (await headers.count()); i++) {
      const header = headers.nth(i);
      if ((await header.getAttribute('aria-expanded')) === 'false') {
        await header.click();
      }
    }
  }

  const main = page.locator('main');
  const loadingFallback = page.getByText('Loading...', { exact: true });

  for (const { label, breadcrumb } of NAV_PAGES) {
    await test.step(`navigate to ${label}`, async () => {
      // A nav entry's optional subtitle joins the button's accessible name
      // ("Agent Team Wizard Build a squad of agents"), so exact equality fails
      // on subtitled entries — match the label as a NAME PREFIX instead. Exclude
      // the accordion GROUP headers: since #2085 a group ("Administration") and
      // a leaf item under it ("Administration", subtitle "Users, teams…") share
      // a base name, and only the group header carries aria-expanded — so the
      // nav item is the one WITHOUT it.
      const esc = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      await page
        .getByRole('button', { name: new RegExp(`^${esc}( |$)`) })
        .and(page.locator('button:not([aria-expanded])'))
        .first()
        .click();

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
