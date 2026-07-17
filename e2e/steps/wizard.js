// Team-Setup wizard step library (#667, docs/journey-spec-concept.md §2.2).
//
// All brittle work — selectors, auto-waiting, NDJSON stream timing — lives here
// so the thin spec (and, later, the `team-setup` journey YAML) only names
// semantic actions. Every function takes (ctx, params); ctx bundles { page }.
//
// There are no data-testids in admin-console/src, so selectors are id / ARIA
// role / visible text (verified against TeamSetup.jsx + StepProcess.jsx).
const { expect } = require('@playwright/test');

const NEXT = { name: 'Next', exact: true };
const CREATE = { name: 'Create team', exact: true };

// "Use a template" is the first Process-step entry card (#671 wizard). It renders
// as an <button> whose accessible name is the heading *plus* its body copy
// ("Use a template Start from a curated process…"), so an exact match never hits
// it — match the heading as a substring (Playwright's default, case-insensitive).
const TEMPLATE_ENTRY = { name: 'Use a template' };

// Open the wizard and confirm the Process step (step 0) is showing.
async function open(ctx) {
  await ctx.page.goto('/team-setup');
  await expect(ctx.page.getByRole('button', TEMPLATE_ENTRY)).toBeVisible();
}

// Process step: pick a curated template (e.g. "Core SDLC"). Waits for the
// authoritative lint pass (POST /api/flows/graph) so the bundle is loaded and
// error-free before advancing — the step gates on a lint-clean bundle.
async function selectProcessTemplate(ctx, { templateName }) {
  const { page } = ctx;
  await page.getByRole('button', TEMPLATE_ENTRY).click();

  const lint = page.waitForResponse(
    (r) => r.url().includes('/api/flows/graph') && r.request().method() === 'POST',
  );
  await page.getByRole('button').filter({ hasText: templateName }).first().click();
  await lint;

  await page.getByRole('button', NEXT).click();
}

// Working-Environment step: select the fixture env card (a role=radio). The
// wizard auto-advances to the Team step on selection, so we wait for the
// team-name input rather than clicking Next.
async function selectEnvironment(ctx, { envName }) {
  const { page } = ctx;
  const card = page.getByRole('radio').filter({ hasText: envName });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-disabled', 'false'); // repo-bearing ⇒ selectable
  await card.click();
  await expect(page.locator('#ts-team-name')).toBeVisible();
}

// Team step: name + slug id. Filling the id last makes it a manual edit, so the
// name→slug auto-derivation won't clobber our unique run id. Then advance.
async function setTeamIdentity(ctx, { teamName, teamId }) {
  const { page } = ctx;
  await page.locator('#ts-team-name').fill(teamName);
  const idInput = page.locator('#ts-team-id');
  await idInput.fill(teamId);
  await expect(idInput).toHaveValue(teamId);
  await page.getByRole('button', NEXT).click();
}

// Knowledge step is optional — accept defaults and advance to Review.
async function skipKnowledge(ctx) {
  await ctx.page.getByRole('button', NEXT).click();
}

// Review step: submit and capture the NDJSON progress stream the wizard renders.
// Returns the parsed event list (plan/step/complete) so the spec can assert the
// per-step progress, and waits for the wizard to consume `complete` (it redirects
// to the BA chat, or /agents). Reading response.text() resolves once the stream
// closes, giving the full NDJSON deterministically (no racing the DOM).
async function submitAndCaptureProgress(ctx) {
  const { page } = ctx;
  const streamResp = page.waitForResponse(
    (r) => r.url().includes('/api/teams/stream') && r.request().method() === 'POST',
  );
  await page.getByRole('button', CREATE).click();

  // The wizard renders the plan as a "Materializing team…" progress card.
  await expect(page.getByText('Materializing team…')).toBeVisible();

  const resp = await streamResp;
  const body = await resp.text();
  const events = body
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));

  // The wizard navigates away ~1.5s after `complete` — to the BA chat, else /agents.
  await page.waitForURL(/\/(chats\/.*business-analyst|agents)\b/, { timeout: 60_000 });

  return events;
}

module.exports = {
  open,
  selectProcessTemplate,
  selectEnvironment,
  setTeamIdentity,
  skipKnowledge,
  submitAndCaptureProgress,
};
