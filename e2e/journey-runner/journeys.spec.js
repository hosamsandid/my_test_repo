// Journey runner as a Playwright project (docs/journey-spec-concept.md §3.1, #705).
//
// This is the `journeys` project (playwright.config.js) that sits beside the F0
// nav smoke and the F1 create-team spec. It discovers every journey under
// e2e/journeys/, and turns each into an ordinary Playwright test: fixtures set
// up → steps run as test.step() → screenshots flush on success → fixtures tear
// down in a finally (always), so the journey leaves no state behind and re-runs
// cleanly on the same stack. Because it is a normal spec, trace/retries/reporters
// all work unchanged (AC2).
const fs = require('fs');
const path = require('path');
const { test, expect } = require('@playwright/test');
const { loadJourneysDir } = require('./loader');
const { buildRegistry } = require('./step-registry');
const { resolveFixture } = require('./fixtures');
const { makeRecorder, ARTIFACTS_ROOT } = require('./recorder');
const { runJourneySteps } = require('./runner');
const { validateStepNames } = require('./schema');

// Built once at collection time. Loading the journeys validates their structure;
// validateStepNames then rejects any action/assert naming a step the library
// doesn't export — a clear, early failure rather than a mid-run surprise (AC3).
const registry = buildRegistry();
const journeys = loadJourneysDir();
for (const journey of journeys) {
  validateStepNames(journey, registry.names(), { source: `${journey.id}.yaml` });
}

// Video capture (#712, docs/journey-spec-concept.md §3.3 item 1). Only the
// `journey-video` project records video (E2E_VIDEO=1 — playwright.config.js), so
// `page.video()` is null for the screenshot `journeys` run and this is a no-op
// there. On a PASSING journey we save the recording next to that run's screenshots
// as artifacts/<journeyId>/journey.webm, mirroring the recorder's
// "captures only in a passing run" contract (§2.3): a failing journey leaves no
// clip. saveAs in afterEach is Playwright's supported pattern for a custom video
// path (it waits for the context to close and the file to finalise).
test.afterEach(async ({ page }, testInfo) => {
  const video = page.video();
  if (!video) return;
  if (testInfo.status !== testInfo.expectedStatus) return;
  const dest = path.join(ARTIFACTS_ROOT, testInfo.title, 'journey.webm');
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  await video.saveAs(dest);
});

for (const journey of journeys) {
  test.describe(`journey: ${journey.title}`, () => {
    test(journey.id, async ({ page, request }) => {
      // A long end-to-end journey can raise the per-test budget (schema-validated
      // positive ms); most inherit the project default.
      if (journey.timeoutMs) test.setTimeout(journey.timeoutMs);
      const ctx = { page, request };
      const recorder = makeRecorder(journey, { registry });

      // Resolve fixtures up front; register teardowns to run in reverse order.
      const teardowns = [];
      for (const fx of journey.fixtures || []) {
        const fixture = resolveFixture(fx.fixture);
        // eslint-disable-next-line no-await-in-loop
        await fixture.setup(ctx, fx.params || {});
        teardowns.unshift(() => fixture.teardown(ctx, fx.params || {}));
      }

      try {
        await runJourneySteps(journey, ctx, { test, expect, registry, recorder });
        // Only reached when every step passed → publish the capture set + manifest.
        if (recorder.stagedCount() > 0) {
          const manifest = await recorder.flush();
          console.log(
            `[journey:${journey.id}] captured ${manifest.screenshots.length} screenshot(s) + manifest`,
          );
        }
      } finally {
        for (const td of teardowns) {
          try {
            // eslint-disable-next-line no-await-in-loop
            await td();
          } catch (err) {
            console.error(`[journey:${journey.id}] teardown error (ignored): ${err.message}`);
          }
        }
      }
    });
  });
}
