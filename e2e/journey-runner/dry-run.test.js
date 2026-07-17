// Journey dry-run tests (#706). Resolving steps loads the step modules, which
// pull in @playwright/test — present after `npm ci` (CI) but not in the pure
// pre-Playwright loop. So this suite SKIPS when @playwright/test is unavailable
// and runs fully in CI, exactly like step-registry.test.js.
const { test } = require('node:test');
const assert = require('node:assert/strict');

let playwrightAvailable = true;
try {
  require.resolve('@playwright/test');
} catch {
  playwrightAvailable = false;
}
const opts = { skip: playwrightAvailable ? false : 'requires @playwright/test (npm ci)' };

test('every real journey resolves + param-checks clean in dry-run', opts, () => {
  const { dryRunAll } = require('./dry-run');
  const { errors, journeyCount } = dryRunAll();
  assert.deepEqual(errors, [], errors.join('\n'));
  assert.ok(journeyCount >= 1);
});

test('the catalog vocabulary matches the live registry exactly (no drift)', opts, () => {
  const { buildRegistry } = require('./step-registry');
  const { loadCatalog } = require('./lint');
  const registryNames = [...buildRegistry().names()].sort();
  const catalogNames = [...loadCatalog().steps.keys()].sort();
  assert.deepEqual(catalogNames, registryNames, 'run `npm run journeys:catalog` after changing the step library');
});

test('dry-run resolves the teamEnv fixture and reports an unknown one', opts, () => {
  const { dryRunJourney } = require('./dry-run');
  const { buildRegistry } = require('./step-registry');
  const { loadCatalog } = require('./lint');
  const deps = { registry: buildRegistry(), catalog: loadCatalog() };

  const ok = dryRunJourney(
    { journeyVersion: 1, id: 'x', title: 'X', fixtures: [{ fixture: 'teamEnv', params: { teamId: 't', envId: 'e', envName: 'E', repoUrl: 'http://x' } }], steps: [{ action: { do: 'wizard.open' } }] },
    deps,
  );
  assert.deepEqual(ok, []);

  const bad = dryRunJourney(
    { journeyVersion: 1, id: 'x', title: 'X', fixtures: [{ fixture: 'ghost' }], steps: [{ action: { do: 'wizard.open' } }] },
    deps,
  );
  assert.ok(bad.some((e) => /unknown fixture "ghost"/.test(e)), bad.join('\n'));
});
