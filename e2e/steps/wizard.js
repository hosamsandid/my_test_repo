// Team-Setup wizard step library (#667 / #705, docs/journey-spec-concept.md §2.2).
//
// All brittle work — selectors, auto-waiting, NDJSON stream timing — lives here
// so the thin spec (F1) and the `team-setup` journey YAML only name semantic
// actions. Every function takes (ctx, params); ctx bundles { page, request }.
//
// There are no data-testids in admin-console/src, so selectors are id / ARIA
// role / visible text (verified against TeamSetup.jsx + StepProcess.jsx).
//
// Advancing is EXPLICIT (#705): the "act on a step" primitives no longer click
// Next themselves — the caller advances with `next()`. This lets the journey
// runner capture a screenshot of a step *after* acting on it but *before* moving
// on (the doc/deck need the state the narrative describes). The only exception
// is `selectEnvironment`, where the product UI auto-advances on card selection.
const { expect } = require('@playwright/test');
const { resolveMemberIds } = require('./member-ids');

const NEXT = { name: 'Next', exact: true };
const CREATE = { name: 'Create team', exact: true };

// "Use a template" is the first Process-step entry card (#671 wizard). It renders
// Process-step landmark (#1703): the step now lands DIRECTLY on the template /
// draft gallery — the former "Use a template" chooser button is gone (moved to the
// "+ Create" launcher, #1665). The gallery is headed by this label; a template is
// selected by clicking its card (a <button> carrying the template's visible name).
const GALLERY_HEADING = 'Pick a process template';

/**
 * Open the wizard and confirm the Process step (step 0) is showing.
 *
 * @example
 * - action:
 *     do: wizard.open
 */
async function open(ctx) {
  await ctx.page.goto('/team-setup');
  await expect(ctx.page.getByText(GALLERY_HEADING)).toBeVisible();
}

/**
 * Advance to the next wizard step. Explicit so the runner can screenshot the
 * current step before moving on.
 *
 * @example
 * - action:
 *     do: wizard.next
 */
async function next(ctx) {
  await ctx.page.getByRole('button', NEXT).click();
}

/**
 * Process step: pick a curated template (e.g. "Core SDLC"). Waits for the
 * authoritative lint pass (POST /api/flows/graph) so the bundle is loaded and
 * error-free before the caller advances. Does NOT click Next (see header note).
 *
 * @param {string} params.templateName - Visible name of the process template.
 * @example
 * - action:
 *     do: wizard.selectProcessTemplate
 *     templateName: Core SDLC
 */
async function selectProcessTemplate(ctx, { templateName }) {
  const { page } = ctx;
  // #1703: no "Use a template" chooser to click first — the gallery is the landing
  // view. Confirm it's up, then click the template card by its visible name.
  await expect(page.getByText(GALLERY_HEADING)).toBeVisible();

  const lint = page.waitForResponse(
    (r) => r.url().includes('/api/flows/graph') && r.request().method() === 'POST',
  );
  await page.getByRole('button').filter({ hasText: templateName }).first().click();
  await lint;
}

/**
 * Assert the Process step's live flow preview + wiring check rendered lint-clean
 * (StepProcess.jsx: "Flow preview — N agents" + "Wiring is clean"). Optionally
 * spot-check the SERVER-derived rendering (#1009): the preview draws the same
 * edge set as the Flows view, so a known edge label and its legend entry must
 * be visible in the preview SVG.
 *
 * @param {string} [params.edgeLabel] - An edge label expected inside the preview SVG (e.g. the gate label).
 * @param {string} [params.legendEntry] - A legend entry expected under the preview (e.g. "human approval").
 * @example
 * - assert:
 *     do: wizard.expectFlowPreview
 *     edgeLabel: ready-for-implementation
 *     legendEntry: human approval
 */
async function expectFlowPreview(ctx, { edgeLabel, legendEntry } = {}) {
  const { page } = ctx;
  await expect(page.getByText(/Flow preview —/)).toBeVisible();
  await expect(page.getByText('Wiring is clean')).toBeVisible();
  if (edgeLabel) {
    await expect(page.locator('svg text', { hasText: edgeLabel }).first()).toBeVisible();
  }
  if (legendEntry) {
    await expect(page.getByText(legendEntry, { exact: true })).toBeVisible();
  }
}

/**
 * Assert the Working-Environment step: the named fixture env card (a role=radio)
 * is present and selectable (repo-bearing). Used as the capture point for the
 * env-step screenshot, since selection auto-advances (see selectEnvironment).
 *
 * @param {string} params.envName - Visible name of the environment card.
 * @example
 * - assert:
 *     do: wizard.expectEnvironmentStep
 *     envName: Agentic Demos
 */
async function expectEnvironmentStep(ctx, { envName }) {
  const card = ctx.page.getByRole('radio').filter({ hasText: envName });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-disabled', 'false');
}

/**
 * Working-Environment step: select the fixture env card (a role=radio). The
 * wizard auto-advances to the Team step on selection, so we wait for the
 * team-name input rather than clicking Next.
 *
 * @param {string} params.envName - Visible name of the environment card to select.
 * @example
 * - action:
 *     do: wizard.selectEnvironment
 *     envName: Agentic Demos
 */
async function selectEnvironment(ctx, { envName }) {
  const { page } = ctx;
  const card = page.getByRole('radio').filter({ hasText: envName });
  await expect(card).toBeVisible();
  await expect(card).toHaveAttribute('aria-disabled', 'false'); // repo-bearing ⇒ selectable
  await card.click();
  await expect(page.locator('#ts-team-name')).toBeVisible();
}

/**
 * Team step: name + slug id. Filling the id last makes it a manual edit, so the
 * name→slug auto-derivation won't clobber our id. Does NOT advance.
 *
 * @param {string} params.teamName - Team display name.
 * @param {string} params.teamId - Team slug id.
 * @example
 * - action:
 *     do: wizard.setTeamIdentity
 *     teamName: Agentic Demos
 *     teamId: agentic-demos
 */
async function setTeamIdentity(ctx, { teamName, teamId }) {
  const { page } = ctx;
  await page.locator('#ts-team-name').fill(teamName);
  const idInput = page.locator('#ts-team-id');
  await idInput.fill(teamId);
  await expect(idInput).toHaveValue(teamId);
}

/**
 * Assert the Team step shows the identity we set (capture point for the screenshot).
 *
 * @param {string} params.teamName - Team display name to expect.
 * @param {string} params.teamId - Team slug id to expect.
 * @example
 * - assert:
 *     do: wizard.expectTeamIdentity
 *     teamName: Agentic Demos
 *     teamId: agentic-demos
 */
async function expectTeamIdentity(ctx, { teamName, teamId }) {
  const { page } = ctx;
  await expect(page.locator('#ts-team-name')).toHaveValue(teamName);
  await expect(page.locator('#ts-team-id')).toHaveValue(teamId);
}

/**
 * Assert the (optional) Knowledge step rendered — the initial-team-skills picker
 * (capture point for the knowledge-step screenshot).
 *
 * @example
 * - assert:
 *     do: wizard.expectKnowledgeStep
 */
async function expectKnowledgeStep(ctx) {
  await expect(ctx.page.getByText(/Initial team skills/)).toBeVisible();
}

/**
 * Knowledge step is optional — accept defaults and advance to Review.
 *
 * @example
 * - action:
 *     do: wizard.skipKnowledge
 */
async function skipKnowledge(ctx) {
  await next(ctx);
}

/**
 * Assert the Review step's summary shows the team identity we are about to
 * create (capture point for the review-step screenshot).
 *
 * @param {string} params.teamName - Team display name to expect in the summary.
 * @param {string} params.teamId - Team slug id to expect in the summary.
 * @example
 * - assert:
 *     do: wizard.expectReviewStep
 *     teamName: Agentic Demos
 *     teamId: agentic-demos
 */
async function expectReviewStep(ctx, { teamName, teamId }) {
  const { page } = ctx;
  await expect(page.getByText(`${teamName} (${teamId})`)).toBeVisible();
  await expect(page.getByRole('button', CREATE)).toBeVisible();
}

/**
 * Review step: submit and capture the NDJSON progress stream the wizard renders.
 * Returns the parsed event list (plan/step/complete) so the spec can assert the
 * per-step progress, and waits for the wizard to consume `complete` (it redirects
 * to the BA chat, or /agents).
 *
 * @example
 * - action:
 *     do: wizard.submitAndCaptureProgress
 */
// We must NOT call resp.text()/resp.body() on this response: the wizard consumes
// it as a live stream via res.body.getReader() (TeamSetup.jsx), so by the time
// the response settles the browser has already drained the ReadableStream and CDP
// has nothing left to hand back — Playwright then throws "No data found for
// resource with given identifier" (#720). Instead we intercept the stream at the
// network layer, buffer the full NDJSON body exactly once, forward the identical
// bytes to the wizard, and keep our own copy to parse. This is pure test-harness
// plumbing — no product code changes.
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
    // the BA chat (else /agents). The NDJSON assertions verify every per-step
    // transition the card would have shown.
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

/**
 * Journey-friendly wrapper: submit the wizard and assert the per-step NDJSON
 * progress (plan lists team+members+dms, every step reaches `done`, complete
 * carries the teamId + all members). Encapsulates the F1 inline assertions so a
 * journey can express "create and verify" as a single step-library call. Accepts
 * { teamId, memberIds } or { teamId, roleIds }.
 *
 * @param {string} params.teamId - Team slug id the complete event must carry.
 * @param {string[]} [params.roleIds] - Role ids to derive member ids (`<teamId>-<roleId>`).
 * @param {string[]} [params.memberIds] - Explicit member ids (alternative to roleIds).
 * @example
 * - action:
 *     do: wizard.createTeamAndExpectProgress
 *     teamId: agentic-demos
 *     roleIds: [business-analyst, developer, code-reviewer, reworker]
 */
async function createTeamAndExpectProgress(ctx, params) {
  const { teamId } = params;
  const memberIds = resolveMemberIds(params);
  const events = await submitAndCaptureProgress(ctx);
  const byType = (t) => events.filter((e) => e.type === t);

  const plan = byType('plan');
  expect(plan, 'exactly one plan event').toHaveLength(1);
  const planIds = plan[0].steps.map((s) => s.id);
  expect(planIds).toContain('team');
  for (const memberId of memberIds) expect(planIds).toContain(`member:${memberId}`);
  expect(planIds).toContain('dms');

  const steps = byType('step');
  expect(steps.some((s) => s.status === 'error'), 'no step errored').toBeFalsy();
  for (const id of planIds) {
    expect(
      steps.some((s) => s.id === id && s.status === 'done'),
      `step ${id} reached done`,
    ).toBeTruthy();
  }

  const complete = byType('complete');
  expect(complete, 'exactly one complete event').toHaveLength(1);
  expect(complete[0].result.teamId).toBe(teamId);
  expect(complete[0].result.created).toEqual(expect.arrayContaining(memberIds));
  return events;
}

// Volatile regions to mask in screenshots (§7). The wizard steps we capture show
// only stable, fixture-seeded content (fixed env/team names, deterministic repo
// url) — no timestamps or generated ids — so there is nothing to mask yet. The
// export documents the seam: add locators here when a captured step gains one.
function volatileLocators() {
  return [];
}

module.exports = {
  open,
  next,
  selectProcessTemplate,
  expectFlowPreview,
  expectEnvironmentStep,
  selectEnvironment,
  setTeamIdentity,
  expectTeamIdentity,
  expectKnowledgeStep,
  skipKnowledge,
  expectReviewStep,
  submitAndCaptureProgress,
  createTeamAndExpectProgress,
  volatileLocators,
};
