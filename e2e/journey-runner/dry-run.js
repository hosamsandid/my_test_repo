// Journey dry-run (docs/journey-spec-concept.md §11.2, #706).
//
// The middle gear between lint (ms, pure) and a real run (minutes, full stack):
// it loads the LIVE step registry + fixture registry and resolves every step
// and fixture a journey references — proving the names actually bind to real
// functions and the catalog has not drifted from the library — then validates
// params against the catalog. It never launches a browser and never executes a
// step, so it needs @playwright/test present (the package) but no stack.
//
// Because it resolves against the runtime registry (not the static catalog), it
// is the check that catches a catalog that is stale in the OTHER direction: a
// journey naming a step the catalog lists but the library no longer exports.
const { buildRegistry } = require('./step-registry');
const { resolveFixture } = require('./fixtures');
const { loadJourneysDir, JOURNEYS_DIR } = require('./loader');
const { validateStepNames, referencedStepNames } = require('./schema');
const { loadCatalog, lintJourney } = require('./lint');

// Dry-run one journey: resolve fixtures + steps against the live registries and
// param-check against the catalog. Returns an array of error strings.
function dryRunJourney(doc, { registry, catalog }, { source = `${doc.id}.yaml` } = {}) {
  const errors = [];
  const push = (m) => errors.push(`${source}: ${m}`);

  // Step names bind to the live registry (clear listing error otherwise).
  try {
    validateStepNames(doc, registry.names(), { source });
  } catch (err) {
    push(err.message.replace(`${source}: `, ''));
  }

  // Resolve each referenced step to its function.
  for (const name of referencedStepNames(doc)) {
    try {
      registry.resolve(name);
    } catch (err) {
      push(err.message);
    }
  }

  // Resolve each fixture.
  (doc.fixtures || []).forEach((fx, i) => {
    try {
      resolveFixture(fx.fixture);
    } catch (err) {
      push(`fixtures[${i}]: ${err.message}`);
    }
  });

  // Param validation (same checks the linter runs, against the catalog).
  errors.push(...lintJourney(doc, catalog, { source }));
  return errors;
}

// Dry-run every journey in a directory. `deps` is injectable for tests.
function dryRunAll({
  dir = JOURNEYS_DIR,
  registry = buildRegistry(),
  catalog = loadCatalog(),
} = {}) {
  const journeys = loadJourneysDir(dir);
  const errors = [];
  for (const doc of journeys) {
    errors.push(...dryRunJourney(doc, { registry, catalog }));
  }
  return { errors, journeyCount: journeys.length };
}

module.exports = { dryRunJourney, dryRunAll };
