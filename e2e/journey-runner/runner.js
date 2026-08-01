// Journey runner core (docs/journey-spec-concept.md §2.1 + §3.1, #705).
//
// The thin loop the whole concept turns on: parse YAML → resolve step-library
// functions → run each step as a `test.step(...)` (so trace viewer, retries and
// reporters keep working unchanged, §2.1) → capture screenshots at named points.
// It adds NO capability of its own beyond sequencing; every real action lives in
// the step library. narrative-only steps are skipped (the doc generator renders
// them; the runner does not).
//
// Kept free of any direct Playwright import — `test`/`expect` are injected — so
// the sequencing logic is testable in isolation.

// Human-readable label for a step in the Playwright report / trace.
function stepLabel(step, i) {
  if (step.kind === 'narrative-only') return `narrative-only [${i}]`;
  const parts = [];
  if (step.id) parts.push(step.id);
  if (step.action) parts.push(step.action.do);
  else if (step.assert) parts.push(step.assert.do);
  else if (step.screenshot) parts.push(`screenshot:${step.screenshot}`);
  return parts.join(' · ') || `step [${i}]`;
}

// Split a call block into (name, params): everything except `do` is opaque
// pass-through params handed verbatim to the step-library function.
function splitCall(call) {
  const { do: name, ...params } = call;
  return { name, params };
}

// Run one journey's steps. `ctx` bundles { page, request, ... } (Playwright
// fixtures); `deps` bundles { test, expect, registry, recorder }. Screenshots
// are staged by the recorder and only flushed by the caller after this resolves
// (a throw here means the journey failed → nothing is published).
async function runJourneySteps(journey, ctx, { test, registry, recorder }) {
  for (let i = 0; i < journey.steps.length; i += 1) {
    const step = journey.steps[i];
    if (step.kind === 'narrative-only') continue; // rendered by docgen, not run

    // eslint-disable-next-line no-await-in-loop
    await test.step(stepLabel(step, i), async () => {
      if (step.action) {
        const { name, params } = splitCall(step.action);
        await registry.resolve(name)(ctx, params);
      }
      if (step.assert) {
        const { name, params } = splitCall(step.assert);
        await registry.resolve(name)(ctx, params);
      }
      if (step.screenshot) {
        await recorder.capture(ctx.page, step.screenshot);
      }
    });
  }
}

module.exports = { runJourneySteps, stepLabel, splitCall };
