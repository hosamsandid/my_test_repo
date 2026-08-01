// Agent Templates step library (#706, docs/journey-spec-concept.md §2.2).
//
// Steps for the Agent Templates management page (admin-console RoleTemplates.jsx,
// route /role-templates) — the catalog of every predefined agent template the
// platform ships. It is a standalone System-Admin page: no team, no environment,
// no fixtures needed (the e2e storageState is a System Admin), which is what
// makes `agent-templates` the "simple, no mocks" validation journey.
//
// No data-testids in admin-console/src, so selectors are heading / table ARIA
// roles / visible text (verified against RoleTemplates.jsx: <h1>Agent Templates</h1>,
// a <table> with Agent/ID/Category/Session/Source/Actions columns, and a
// "New template" button).
const { expect } = require('@playwright/test');

/**
 * Open the Agent Templates management page and confirm it rendered (its h1).
 *
 * @example
 * - action:
 *     do: templates.openTemplatesPage
 */
async function openTemplatesPage(ctx) {
  await ctx.page.goto('/role-templates');
  await expect(ctx.page.getByRole('heading', { name: 'Agent Templates', level: 1 })).toBeVisible();
}

/**
 * Assert the template catalog: the New-template action, the ID/Category/Session/
 * Source columns, and a row for each expected built-in template. Capture point
 * for the template-library screenshot (slide 35 of the walkthrough).
 *
 * @param {string[]} params.templateNames - Built-in template display names each expected as a table row.
 * @example
 * - assert:
 *     do: templates.expectTemplateCatalog
 *     templateNames: [Business Analyst, Developer, Code Reviewer]
 */
async function expectTemplateCatalog(ctx, { templateNames = [] }) {
  const { page } = ctx;
  await expect(page.getByRole('button', { name: 'New template' })).toBeVisible();
  for (const col of ['Category', 'Session', 'Source']) {
    await expect(page.getByRole('columnheader', { name: col })).toBeVisible();
  }
  for (const name of templateNames) {
    await expect(page.getByRole('row').filter({ hasText: name }).first()).toBeVisible();
  }
}

// Volatile regions to mask in screenshots (§7). The catalog rows show only
// stable, seeded template metadata (ids, categories, session policies) — no
// timestamps or generated ids — so there is nothing to mask. The export
// documents the seam: add locators here if a captured row gains volatile content.
function volatileLocators() {
  return [];
}

module.exports = { openTemplatesPage, expectTemplateCatalog, volatileLocators };
