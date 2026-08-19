// Step-library registry (docs/journey-spec-concept.md §2.2, #705).
//
// Assembles the plain-Playwright step modules in e2e/steps/ into one flat,
// dot-namespaced map: the file `wizard.js` exporting `selectProcessTemplate`
// becomes the resolvable step name `wizard.selectProcessTemplate`. The journey
// YAML names steps; the runner resolves them here. This module `require`s the
// step modules (which pull in @playwright/test), so it is NOT loaded by the pure
// schema/loader unit tests — only by the runner and the registry unit test.
//
// Two reserved exports are NOT registered as steps:
//   - `volatileLocators` — a `(page) => Locator[]` a module contributes so the
//     recorder masks its dynamic regions (§7). Collected separately.
const path = require('path');

// The modules that make up the step library. Explicit list (not a dir scan) so
// adding a UI area is a deliberate one-line edit and the set is reviewable.
const STEP_MODULES = ['env', 'create', 'wizard', 'agents', 'teardown', 'gh', 'chat', 'templates', 'shell', 'triggers', 'flows', 'context', 'usage'];

const RESERVED = new Set(['volatileLocators']);

function buildRegistry() {
  const steps = new Map();
  const volatileLocatorFns = [];

  for (const mod of STEP_MODULES) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exported = require(path.resolve(__dirname, '..', 'steps', `${mod}.js`));
    if (typeof exported.volatileLocators === 'function') {
      volatileLocatorFns.push(exported.volatileLocators);
    }
    for (const [name, fn] of Object.entries(exported)) {
      if (RESERVED.has(name)) continue;
      if (typeof fn !== 'function') continue;
      steps.set(`${mod}.${name}`, fn);
    }
  }

  return {
    // Resolve a `do` name to its function, or throw a clear, listing error.
    resolve(name) {
      const fn = steps.get(name);
      if (!fn) {
        const known = [...steps.keys()].sort().join(', ');
        throw new Error(
          `journey-runner: unknown step "${name}" — not found in the step library. Known steps: ${known}`,
        );
      }
      return fn;
    },
    has: (name) => steps.has(name),
    names: () => new Set(steps.keys()),
    // Aggregate volatile-region locators across all step modules for masking.
    volatileLocators(page) {
      return volatileLocatorFns.flatMap((fn) => {
        try {
          const locs = fn(page);
          return Array.isArray(locs) ? locs : [];
        } catch {
          return [];
        }
      });
    },
  };
}

module.exports = { buildRegistry, STEP_MODULES };
