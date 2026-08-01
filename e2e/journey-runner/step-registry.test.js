// Step-registry tests (#705). The registry `require`s the step modules, which
// pull in @playwright/test — present after `npm ci` (CI) but not for the pure
// `node --test` loop before Playwright is installed. So the whole suite SKIPS
// when @playwright/test is unavailable, and runs fully in CI. This is what
// cross-checks that the pilot journey's step names actually resolve.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

let playwrightAvailable = true;
try {
  require.resolve('@playwright/test');
} catch {
  playwrightAvailable = false;
}

const opts = { skip: playwrightAvailable ? false : 'requires @playwright/test (npm ci)' };

test('registry resolves a known step and rejects an unknown one with a listing error', opts, () => {
  const { buildRegistry } = require('./step-registry');
  const registry = buildRegistry();
  assert.equal(typeof registry.resolve('wizard.open'), 'function');
  assert.throws(() => registry.resolve('wizard.doesNotExist'), /unknown step "wizard\.doesNotExist"/);
  assert.throws(() => registry.resolve('wizard.doesNotExist'), /Known steps:/);
});

test('the pilot journey only references steps the registry actually exports', opts, () => {
  const { buildRegistry } = require('./step-registry');
  const { loadJourney, JOURNEYS_DIR } = require('./loader');
  const { validateStepNames } = require('./schema');
  const registry = buildRegistry();
  const pilot = loadJourney(path.join(JOURNEYS_DIR, 'team-setup.yaml'));
  assert.doesNotThrow(() => validateStepNames(pilot, registry.names(), { source: 'team-setup.yaml' }));
});

test('reserved exports (volatileLocators) are not registered as steps', opts, () => {
  const { buildRegistry } = require('./step-registry');
  const registry = buildRegistry();
  assert.equal(registry.has('wizard.volatileLocators'), false);
  // But the aggregation hook works and returns an array for a null page.
  assert.ok(Array.isArray(registry.volatileLocators(null)));
});
