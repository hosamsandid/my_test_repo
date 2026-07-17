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
// to the BA chat, or /agents).
//
// We must NOT call resp.text()/resp.body() on this response: the wizard consumes
// it as a live stream via res.body.getReader() (TeamSetup.jsx), so by the time
// the response settles the browser has already drained the ReadableStream and CDP
// has nothing left to hand back — Playwright then throws "No data found for
// resource with given identifier" (#720). Instead we intercept the stream at the
// network layer, buffer the full NDJSON body exactly once, forward the identical
// bytes to the wizard, and keep our own copy to parse. This is pure test-harness
// plumbing — no product code changes, and every downstream assertion (plan/step/
// complete, team card, members, DM rooms) is preserved.
async function submitAndCaptureProgress(ctx) {
  const { page } = ctx;

  let streamBody = null;
  const STREAM_GLOB = '**/api/teams/stream';
  await page.route(STREAM_GLOB, async (route) => {
    if (route.request().method() !== 'POST') {
      return route.fallback();
    }
    // timeout:0 → no per-fetch cap; the per-test timeout (playwright.config.js)
    // is the real ceiling for how long materialisation may take.
    const response = await route.fetch({ timeout: 0 });
    streamBody = await response.text();
    await route.fulfill({ response, body: streamBody });
  });

  try {
    await page.getByRole('button', CREATE).click();

    // Because the interception buffers the whole stream, the wizard receives
    // `plan` and `complete` in one React batch, so the transient "Materializing
    // team…" progress card may never paint — we assert on the durable outcome
    // instead: the wizard consumes `complete` and navigates away ~1.5s later, to
    // the BA chat (else /agents). The NDJSON assertions below still verify every
    // per-step transition the card would have shown.
    await page.waitForURL(/\/(chats\/.*business-analyst|agents)\b/, { timeout: 60_000 });
  } finally {
    await page.unroute(STREAM_GLOB);
  }

  if (streamBody === null) {
    throw new Error('team-setup: /api/teams/stream response body was not captured');
  }

  return streamBody
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

module.exports = {
  open,
  selectProcessTemplate,
  selectEnvironment,
  setTeamIdentity,
  skipKnowledge,
  submitAndCaptureProgress,
};
