// Unified "Create" launcher step library (#1665 / epic #1661).
//
// The launcher (`/create`, also reachable from the persistent "+ Create" control
// in the sidebar) is the single front door for starting anything new: four
// equally-ranked, plainly-labelled tiles (Describe · Start from a ready-made
// setup · Build it yourself · Just one assistant to chat with), plus the direct
// "Create a single agent" form (#1956). It replaced the old scatter of separate
// Single-Agent / Team-Wizard / Flows entry points, so a journey that used to
// deep-link straight into `/team-setup` now enters through this launcher and
// picks the "ready-made setup" tile.
//
// As with the other modules, every function takes (ctx, params); ctx bundles
// { page, request }. The launcher tiles carry stable data-testids
// (`create-entry-<key>` in Create.jsx), which we prefer for the click targets;
// the visible headings are asserted as the human-readable capture reference.
const { expect } = require('@playwright/test');

// The launcher tiles, keyed as in create-launcher-view.js. Heading text is the
// visible title; testid is the stable click/selection hook.
const ENTRIES = {
  describe: { testid: 'create-entry-describe', title: 'Describe what you need' },
  template: { testid: 'create-entry-template', title: 'Start from a ready-made setup' },
  build: { testid: 'create-entry-build', title: 'Build it yourself' },
  chat: { testid: 'create-entry-chat', title: 'Just give me one assistant to chat with' },
  'single-agent': { testid: 'create-entry-single-agent', title: 'Create a single agent' },
};

/**
 * Open the unified "Create" launcher and confirm every entry tile is showing.
 * This is the single front door for starting something — the capture point for
 * the launcher screenshot.
 *
 * @example
 * - action:
 *     do: create.open
 */
async function open(ctx) {
  const { page } = ctx;
  await page.goto('/create');
  for (const entry of Object.values(ENTRIES)) {
    await expect(page.getByTestId(entry.testid)).toBeVisible();
  }
}

/**
 * Assert a specific launcher tile is present with its visible heading. Lets a
 * journey spot-check the plainly-labelled wording without clicking through.
 *
 * @param {string} params.entry - Which tile: describe | template | build | chat.
 * @example
 * - assert:
 *     do: create.expectEntry
 *     entry: template
 */
async function expectEntry(ctx, { entry }) {
  const meta = ENTRIES[entry];
  if (!meta) throw new Error(`create.expectEntry: unknown entry "${entry}" (expected one of ${Object.keys(ENTRIES).join(', ')})`);
  await expect(ctx.page.getByTestId(meta.testid)).toBeVisible();
  await expect(ctx.page.getByText(meta.title, { exact: true }).first()).toBeVisible();
}

/**
 * From the launcher, take the "Start from a ready-made setup" path: click that
 * tile and wait until the Team-Setup wizard's Process step (the template
 * gallery) has loaded. Replaces the old direct `/team-setup` deep link so the
 * journey exercises the real entry point users now take.
 *
 * @example
 * - action:
 *     do: create.startFromTemplate
 */
async function startFromTemplate(ctx) {
  const { page } = ctx;
  await page.getByTestId(ENTRIES.template.testid).click();
  // The wizard's Process step lands directly on the template gallery (#1703 — the
  // former "Use a template" chooser is gone), headed by this label.
  await expect(page.getByText('Pick a process template')).toBeVisible();
}

module.exports = { open, expectEntry, startFromTemplate };
