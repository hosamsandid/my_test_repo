// Unified "Create" launcher step library (#1665 / epic #1661, re-sorted by #2027).
//
// The launcher (`/create`, also reachable from the persistent "+ Create" control
// in the sidebar) is the single front door for starting anything new. It began
// as four equally-ranked tiles plus a set-apart direct form (#1956); #2027
// replaced that flat grid with an explicit ranking, simplest → most advanced,
// in three tiers:
//
//   hero      Chat with one assistant          (full width, first, primary)
//   flow      Start from a ready-made team ·
//             Describe what you need ·
//             Design it on the canvas          (one group, one heading)
//   advanced  Configure an agent manually      (behind a collapsed disclosure)
//
// It replaced the old scatter of separate Single-Agent / Team-Wizard / Flows
// entry points, so a journey that used to deep-link straight into `/team-setup`
// now enters through this launcher and picks the ready-made-team card.
//
// As with the other modules, every function takes (ctx, params); ctx bundles
// { page, request }. The launcher entries carry stable data-testids
// (`create-entry-<key>` in Create.jsx), which we prefer for the click targets;
// the visible headings are asserted as the human-readable capture reference.
const { expect } = require('@playwright/test');

// The launcher entries, keyed and ORDERED as in create-launcher-view.js (the
// order is the ranking, so it is part of what a journey captures). Heading text
// is the visible title; testid is the stable click/selection hook. `tier` is
// what decides whether an entry is on screen when the page loads — the advanced
// one is not, by design, so `open()` must not assert it visible. `preview` says
// whether the entry has a "what you get" reveal at all: since #2034 only the
// three flow cards do, so the other two carry no eye control to click.
const ENTRIES = {
  chat: {
    testid: 'create-entry-chat',
    title: 'Chat with one assistant',
    tier: 'hero',
    preview: false,
  },
  template: {
    testid: 'create-entry-template',
    title: 'Start from a ready-made team',
    tier: 'flow',
    preview: true,
  },
  describe: {
    testid: 'create-entry-describe',
    title: 'Describe what you need',
    tier: 'flow',
    preview: true,
  },
  build: {
    testid: 'create-entry-build',
    title: 'Design it on the canvas',
    tier: 'flow',
    preview: true,
  },
  'single-agent': {
    testid: 'create-entry-single-agent',
    title: 'Configure an agent manually',
    tier: 'advanced',
    preview: false,
  },
};

// The disclosure that holds the advanced tier. Collapsed on every load for
// every user (#2027 — the state is deliberately not persisted), so a journey
// that wants the entry behind it has to open it first.
const ADVANCED_TOGGLE = 'create-advanced-toggle';

const visibleOnLoad = () => Object.values(ENTRIES).filter(e => e.tier !== 'advanced');

/**
 * Open the unified "Create" launcher and confirm the ranked entries are showing:
 * the hero, the three grouped flow cards, and the collapsed "Advanced options"
 * disclosure (whose entry is deliberately NOT on screen yet). This is the single
 * front door for starting something — the capture point for the launcher
 * screenshot.
 *
 * @example
 * - action:
 *     do: create.open
 */
async function open(ctx) {
  const { page } = ctx;
  await page.goto('/create');
  for (const entry of visibleOnLoad()) {
    await expect(page.getByTestId(entry.testid)).toBeVisible();
  }
  // The disclosure is there and shut. Asserting both halves is what keeps this
  // honest: the toggle being present would pass just as well if the advanced
  // entry had been rendered next to it after all.
  await expect(page.getByTestId(ADVANCED_TOGGLE)).toBeVisible();
  await expect(page.getByTestId(ENTRIES['single-agent'].testid)).toBeHidden();
}

/**
 * Assert a specific launcher entry is present with its visible heading. Lets a
 * journey spot-check the plainly-labelled wording without clicking through.
 * Expands the "Advanced options" disclosure first when the entry lives behind
 * it, so a caller need not know which tier an entry is in.
 *
 * @param {string} params.entry - Which entry: chat | template | describe | build | single-agent.
 * @example
 * - assert:
 *     do: create.expectEntry
 *     entry: template
 */
async function expectEntry(ctx, { entry }) {
  const meta = ENTRIES[entry];
  if (!meta) throw new Error(`create.expectEntry: unknown entry "${entry}" (expected one of ${Object.keys(ENTRIES).join(', ')})`);
  if (meta.tier === 'advanced') await expandAdvanced(ctx);
  await expect(ctx.page.getByTestId(meta.testid)).toBeVisible();
  await expect(ctx.page.getByText(meta.title, { exact: true }).first()).toBeVisible();
}

/**
 * Expand the launcher's "Advanced options" disclosure, revealing the manual
 * agent form entry. Idempotent — a second call on an already-open disclosure
 * leaves it open rather than toggling it shut, so a journey can call it without
 * tracking state.
 *
 * @example
 * - action:
 *     do: create.expandAdvanced
 */
async function expandAdvanced(ctx) {
  const { page } = ctx;
  const toggle = page.getByTestId(ADVANCED_TOGGLE);
  await expect(toggle).toBeVisible();
  if ((await toggle.getAttribute('aria-expanded')) !== 'true') await toggle.click();
  await expect(page.getByTestId(ENTRIES['single-agent'].testid)).toBeVisible();
}

/**
 * Reveal an entry's "what you get" preview via its eye control (#2027) and
 * confirm the schematic and its caption are showing. The control is the touch
 * path — hover and keyboard focus reveal the same panel — and it is a sibling of
 * the card's link, so clicking it previews instead of navigating. This step
 * asserts exactly that: the preview appears AND we are still on the launcher.
 *
 * Only the three flow entries have a preview (#2034 dropped it from the hero and
 * the advanced entry), so `entry` must be one of `template` / `describe` /
 * `build` — the other two carry no eye control to click.
 *
 * @param {string} params.entry - Which entry's preview to reveal.
 * @example
 * - action:
 *     do: create.previewEntry
 *     entry: template
 */
async function previewEntry(ctx, { entry }) {
  const { page } = ctx;
  const meta = ENTRIES[entry];
  if (!meta) throw new Error(`create.previewEntry: unknown entry "${entry}" (expected one of ${Object.keys(ENTRIES).join(', ')})`);
  // Fail with the reason rather than on a locator timeout: the hero and the
  // advanced entry have no preview at all since #2034.
  if (!meta.preview) {
    const previewable = Object.keys(ENTRIES).filter(k => ENTRIES[k].preview).join(', ');
    throw new Error(`create.previewEntry: the "${entry}" entry has no "what you get" preview (#2034 — expected one of ${previewable})`);
  }
  if (meta.tier === 'advanced') await expandAdvanced(ctx);
  const eye = page.getByTestId(`create-preview-${entry}`);
  await expect(eye).toBeVisible();
  await eye.click();
  await expect(eye).toHaveAttribute('aria-expanded', 'true');
  // The tap must not have followed the card's link (AC5).
  await expect(page).toHaveURL(/\/create(\?|$)/);
}

/**
 * From the launcher, take the "Start from a ready-made team" path: click that
 * card and wait until the Team-Setup wizard's Process step (the template
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

module.exports = {
  open, expectEntry, expandAdvanced, previewEntry, startFromTemplate,
};
