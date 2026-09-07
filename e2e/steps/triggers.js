// Trigger-panel step library (#733, docs/journey-spec-concept.md §2.2,
// docs/walkthrough/03-triggers.md).
//
// Drives the trigger configuration UI that lives as the "Triggers" tab in the
// chat page's right rail (admin-console/src/pages/agent-chat/TriggersPanel.jsx)
// — NOT the Agents edit form. All brittle work (selectors, the async repo load,
// waiting on the save round-trip) lives here so the `triggers` journey YAML only
// names semantic actions.
//
// House style (see wizard.js): no data-testids in admin-console/src, so selectors
// are id / ARIA role / visible text, verified against TriggersPanel.jsx. The Type
// control and the schedule/repo/event controls have NO label association, so they
// are reached as the dialog's <select>s, disambiguated by their option contents
// (e.g. the cadence select is the one carrying "Custom expression"; the event
// select the one carrying "Release published").
//
// Configuring is composite by design: each `configure<Type>` opens a fresh Add
// form and fills every field, so a journey step can capture the filled form
// (screenshot) and then a following `submit` step persists it — mirroring the
// wizard's act-then-advance split.
const { expect } = require('@playwright/test');

const ADD_TRIGGER_DIALOG = { name: 'Add Trigger' };

// The dialog the TriggerForm renders inside (SidePanel role=dialog aria-label).
function dialog(page) {
  return page.getByRole('dialog', ADD_TRIGGER_DIALOG);
}

/**
 * Open an agent's Triggers panel: navigate to its chat, reveal the right rail if
 * a prior localStorage state closed it, and select the Triggers tab. The panel's
 * Add button becoming enabled confirms it rendered for this agent.
 *
 * @param {string} params.agentId - Id of the agent whose trigger panel to open.
 * @example
 * - action:
 *     do: triggers.openPanel
 *     agentId: triggers-demo-business-analyst
 */
async function openPanel(ctx, { agentId }) {
  const { page } = ctx;
  await page.goto(`/chats/${agentId}`);

  // Scope to the chat area (Shell's <main>) so the "Triggers" match is the
  // right-rail TAB, not the identically-named agent-list entry in the sidebar.
  const rail = page.getByRole('main');
  // exact:true so we don't also match the agent-list entry "triggers-demo…".
  let tab = rail.getByRole('button', { name: 'Triggers', exact: true });

  // The rail is open by default; reopen it if a stored preference closed it.
  if (!(await tab.isVisible().catch(() => false))) {
    const showRail = page.getByRole('button', { name: 'Show log panel' });
    if (await showRail.isVisible().catch(() => false)) await showRail.click();
  }
  // On a narrow rail the tab can spill into an overflow menu.
  if (!(await tab.isVisible().catch(() => false))) {
    const more = rail.getByRole('button', { name: 'More tabs' });
    if (await more.isVisible().catch(() => false)) {
      await more.click();
      tab = page.getByRole('menuitem', { name: 'Triggers' });
    }
  }
  await tab.click();
  await expect(page.locator('[title="Add trigger"]')).toBeVisible();
}

/**
 * Assert the Triggers panel is showing for an agent (capture point for the
 * empty-panel chapter screenshot).
 *
 * @example
 * - assert:
 *     do: triggers.expectPanel
 */
async function expectPanel(ctx) {
  await expect(ctx.page.locator('[title="Add trigger"]')).toBeVisible();
}

// Open a fresh Add-trigger form and select the type. `type` is the wire value:
// cron | once | http | github-event | data-flow (TriggersPanel GITHUB/type select).
async function openAddForm(page, type) {
  await page.locator('[title="Add trigger"]').click();
  const d = dialog(page);
  await expect(d).toBeVisible();
  // Type is the first <select> in the dialog (no accessible label).
  await d.locator('select').first().selectOption(type);
  return d;
}

// Wait for the async repository load (GET /api/agents/:id → GET /api/environments
// /:envId) and select the repo by its full name, so github-event / data-flow
// triggers bind to a concrete repo. The repo <select> is the one carrying the
// "— Select a repository —" placeholder.
async function selectRepo(d, repo) {
  const repoSelect = d.locator('select').filter({ hasText: 'Select a repository' });
  await expect(repoSelect.locator('option', { hasText: repo })).toBeAttached({ timeout: 15_000 });
  await repoSelect.selectOption(repo);
}

/**
 * Configure a Cron (recurring) trigger: Daily at the given time + prompt. Opens a
 * fresh Add form; does NOT submit (see module header). The plain-language summary
 * and the underlying cron expression render in the form.
 *
 * @param {string} [params.time=07:00] - 24h HH:MM the daily schedule fires at.
 * @param {string} params.prompt - The instruction the agent receives when it fires.
 * @example
 * - action:
 *     do: triggers.configureCron
 *     time: "07:00"
 *     prompt: Generate a summary of the pull requests completed yesterday.
 */
async function configureCron(ctx, { time = '07:00', prompt }) {
  const d = await openAddForm(ctx.page, 'cron');
  // Cadence select — the one carrying the "Custom expression" option.
  await d.locator('select').filter({ hasText: 'Custom expression' }).selectOption('daily');
  await d.locator('input[type="time"]').fill(time);
  await d.getByLabel(/Wake instruction/).fill(prompt);
}

/**
 * Assert the Cron form shows its plain-language summary and cron expression
 * (capture point). e.g. summary "Every day at 07:00", expression "0 7 * * *".
 *
 * @param {string} params.summary - Plain-language schedule text to expect.
 * @param {string} params.cron - The 5-field cron expression to expect.
 * @example
 * - assert:
 *     do: triggers.expectCronForm
 *     summary: Every day at 07:00
 *     cron: "0 7 * * *"
 */
async function expectCronForm(ctx, { summary, cron }) {
  const d = dialog(ctx.page);
  await expect(d.getByText(summary)).toBeVisible();
  await expect(d.locator('code', { hasText: cron })).toBeVisible();
}

/**
 * Configure a Once (one-shot) trigger at a fixed future Date & Time + prompt.
 * Opens a fresh Add form; does NOT submit. Use a fixed future timestamp for
 * screenshot determinism (§7) — a one-shot in the future never fires mid-run.
 *
 * @param {string} params.at - datetime-local value, "YYYY-MM-DDTHH:MM".
 * @param {string} params.prompt - The instruction delivered when it fires.
 * @example
 * - action:
 *     do: triggers.configureOnce
 *     at: "2027-07-20T08:00"
 *     prompt: Remind me once that I am responsible for the time reporting this week.
 */
async function configureOnce(ctx, { at, prompt }) {
  const d = await openAddForm(ctx.page, 'once');
  await d.locator('input[type="datetime-local"]').fill(at);
  await d.getByLabel(/Wake instruction/).fill(prompt);
}

/**
 * Assert the Once form's Date & Time control carries a value (capture point).
 *
 * @example
 * - assert:
 *     do: triggers.expectOnceForm
 */
async function expectOnceForm(ctx) {
  // Assert the field carries a value rather than an exact string: the picker
  // round-trips through UTC, so the displayed local value depends on the runner
  // timezone — non-empty is the deterministic, TZ-independent check.
  await expect(dialog(ctx.page).locator('input[type="datetime-local"]')).not.toHaveValue('');
}

/**
 * Configure an HTTP webhook trigger + prompt. Opens a fresh Add form; a shared
 * secret is auto-generated when the type is selected. Does NOT submit.
 *
 * @param {string} params.prompt - The instruction delivered when the hook is called.
 * @example
 * - action:
 *     do: triggers.configureHttp
 *     prompt: The CI/CD pipeline has just deployed a new version to production.
 */
async function configureHttp(ctx, { prompt }) {
  const d = await openAddForm(ctx.page, 'http');
  await d.getByLabel(/Wake instruction/).fill(prompt);
}

/**
 * Assert the HTTP form shows the generated endpoint (POST /hooks/<agentId>/…) and
 * the required X-Hook-Secret section (capture point).
 *
 * @param {string} params.agentId - Agent id the endpoint path must contain.
 * @example
 * - assert:
 *     do: triggers.expectHttpForm
 *     agentId: triggers-demo-business-analyst
 */
async function expectHttpForm(ctx, { agentId }) {
  const d = dialog(ctx.page);
  await expect(d.getByText('X-Hook-Secret (required)')).toBeVisible();
  await expect(d.locator('code', { hasText: `POST /hooks/${agentId}/` })).toBeVisible();
}

/**
 * Configure a GitHub event trigger: optionally pick the repo, then the event, an
 * optional label filter, and the prompt. Opens a fresh Add form; does NOT submit.
 * Selecting the type loads the repo list from the agent's working environment —
 * in the E2E stack the repo is served over the in-stack git remote (not a
 * github.com URL), so the panel's github.com-only parser lists no repo; the
 * journey therefore tours this form (event catalog + label filter) without a
 * repo and does not save it. (github-event firing end-to-end is covered by
 * iban-story.)
 *
 * @param {string} [params.repo] - "owner/name" repo to watch (omit if the env has none parseable).
 * @param {string} params.event - Event key, e.g. "issues.labeled".
 * @param {string} [params.labelFilter] - Exact label to fire on (labelable events only).
 * @param {string} params.prompt - The instruction delivered when the event fires.
 * @example
 * - action:
 *     do: triggers.configureGithubEvent
 *     event: issues.labeled
 *     labelFilter: ready
 *     prompt: A ready issue was labelled — pick it up and begin implementation.
 */
async function configureGithubEvent(ctx, { repo, event, labelFilter, prompt }) {
  const d = await openAddForm(ctx.page, 'github-event');
  if (repo) await selectRepo(d, repo);
  // Event select — the one carrying the "Release published" catalog entry.
  await d.locator('select').filter({ hasText: 'Release published' }).selectOption(event);
  if (labelFilter) {
    await d.locator('input[placeholder*="leave empty to fire"]').fill(labelFilter);
  }
  await d.getByLabel(/Wake instruction/).fill(prompt);
}

/**
 * Assert the GitHub-event form shows the full event catalog and the one-event
 * -per-trigger hint (capture point for the event-catalog screenshot).
 *
 * @example
 * - assert:
 *     do: triggers.expectGithubEventForm
 */
async function expectGithubEventForm(ctx) {
  const d = dialog(ctx.page);
  await expect(d.locator('select').filter({ hasText: 'Release published' })).toBeVisible();
  await expect(d.getByText(/One event per trigger/)).toBeVisible();
}

/**
 * Configure a Data flow — agent dependency trigger: the "wake on any push" hand-off
 * + prompt. Opens a fresh Add form; does NOT submit. `repo` is optional for the
 * same reason as configureGithubEvent (the in-stack repo isn't a parseable
 * github.com URL), so the journey tours the dependency note without a repo.
 *
 * @param {string} [params.repo] - "owner/name" repo the dependency is on (omit if none parseable).
 * @param {string} params.prompt - The instruction delivered when an upstream push lands.
 * @example
 * - action:
 *     do: triggers.configureDataFlow
 *     prompt: An upstream teammate pushed work — pull, check relevance, continue or reply [PASS].
 */
async function configureDataFlow(ctx, { repo, prompt }) {
  const d = await openAddForm(ctx.page, 'data-flow');
  if (repo) await selectRepo(d, repo);
  await d.getByLabel(/Wake instruction/).fill(prompt);
}

/**
 * Cancel the open Add-trigger form without saving (used for the github-event /
 * data-flow form tour, which can't persist without a parseable repo in the E2E
 * stack).
 *
 * @example
 * - action:
 *     do: triggers.cancelForm
 */
async function cancelForm(ctx) {
  const { page } = ctx;
  await dialog(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
}

/**
 * Assert the Data-flow form shows its "Woken by any push" dependency note
 * (capture point).
 *
 * @example
 * - assert:
 *     do: triggers.expectDataFlowForm
 */
async function expectDataFlowForm(ctx) {
  await expect(dialog(ctx.page).getByText(/woken by any push/i)).toBeVisible();
}

/**
 * Submit the open Add-trigger form and wait for the create round-trip
 * (POST /api/agents/:id/triggers) so the trigger is persisted before the journey
 * moves on. The dialog closes on success.
 *
 * @example
 * - action:
 *     do: triggers.submit
 */
async function submit(ctx) {
  const { page } = ctx;
  const saved = page.waitForResponse(
    (r) => /\/api\/agents\/[^/]+\/triggers$/.test(r.url())
      && r.request().method() === 'POST'
      && r.ok(),
  );
  await dialog(page).getByRole('button', { name: 'Add Trigger', exact: true }).click();
  await saved;
  await expect(dialog(page)).toBeHidden();
}

/**
 * Assert the panel now lists at least `count` triggers for the agent (API-level
 * persistence proof, number-agnostic against the panel's own polling).
 *
 * @param {string} params.agentId - Agent whose triggers are counted.
 * @param {number} params.count - Minimum number of triggers expected.
 * @example
 * - assert:
 *     do: triggers.expectTriggerCount
 *     agentId: triggers-demo-business-analyst
 *     count: 5
 */
async function expectTriggerCount(ctx, { agentId, count }) {
  await expect(async () => {
    const res = await ctx.request.get(`/api/agents/${agentId}/triggers`);
    expect(res.ok(), `GET triggers HTTP ${res.status()}`).toBeTruthy();
    const body = await res.json();
    const list = Array.isArray(body) ? body : (body.triggers || []);
    expect(list.length).toBeGreaterThanOrEqual(count);
  }).toPass({ timeout: 15_000 });
}

// The trigger list rows carry generated secrets (http) and ids; the panel content
// we capture is the deterministic schedule/type text, so nothing needs masking.
function volatileLocators() {
  return [];
}

module.exports = {
  openPanel,
  expectPanel,
  configureCron,
  expectCronForm,
  configureOnce,
  expectOnceForm,
  configureHttp,
  expectHttpForm,
  configureGithubEvent,
  expectGithubEventForm,
  configureDataFlow,
  expectDataFlowForm,
  cancelForm,
  submit,
  expectTriggerCount,
  volatileLocators,
};
