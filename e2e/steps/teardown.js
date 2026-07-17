// Teardown step library (#667). Deletes a materialised team and its fixture
// environment via the real API so the spec leaves no state behind — even before
// the global-teardown volume wipe, satisfying the "within-run isolation" AC
// (F1 runs twice consecutively on the same stack).
const { expect } = require('@playwright/test');
const { deleteEnv } = require('./env');

// A team is a `role: team` agent; deleting it cascades to every member
// (containers stopped, Matrix users deactivated, volumes/networks torn down)
// in the orchestrator. Then the now-unreferenced fixture env can be removed.
async function teardownTeam(ctx, { teamId, envId }) {
  // 1. Delete the team agent — cascades to members. 204 / 404 both fine.
  const del = await ctx.request.delete(`/api/agents/${encodeURIComponent(teamId)}`);
  expect(
    [204, 404, 200].includes(del.status()),
    `delete team ${teamId} expected 200/204/404, got HTTP ${del.status()}: ${await del.text()}`,
  ).toBeTruthy();

  // 2. Delete the fixture env. The env refuses deletion (409) while any agent
  //    still references it, so retry briefly to absorb async cascade cleanup.
  //    204 (deleted) and 404 (already gone) are terminal successes; 409 retries.
  await expect
    .poll(
      async () => {
        const res = await ctx.request.delete(`/api/environments/${encodeURIComponent(envId)}`);
        return res.status() === 204 || res.status() === 404;
      },
      { message: `env ${envId} never became deletable (still referenced?)`, timeout: 30_000 },
    )
    .toBe(true);
}

module.exports = { teardownTeam, deleteEnv };
