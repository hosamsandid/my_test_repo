// Journey linter (docs/journey-spec-concept.md §11.2, #706).
//
// Feedback in seconds, no browser: given the generated step catalog
// (steps-catalog.json), it validates every journey's structure (via the schema
// validator), rejects unknown step names, unknown fixtures, unknown/missing
// step & fixture params, and duplicate screenshot ids across the journey set.
//
// Pure (js-yaml only, no @playwright/test) so it runs in the light PR unit-test
// lane. It checks names against the CATALOG, not the live registry — the catalog
// is the authoritative vocabulary an authoring agent is handed (§11.1), so a
// name absent from it is rejected before a journey can ship. A separate freshness
// check (bin/gen-catalog.js --check) guarantees the catalog still matches the
// library.
const fs = require('fs');
const { loadJourneysDir, JOURNEYS_DIR } = require('./loader');
const { validateJourney, referencedStepNames } = require('./schema');
const { CATALOG_PATH } = require('./catalog');

// Read + parse the generated catalog into fast lookup structures.
function loadCatalog(catalogPath = CATALOG_PATH) {
  const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  const steps = new Map(catalog.steps.map((s) => [s.name, s]));
  const fixtures = new Map(catalog.fixtures.map((f) => [f.name, f]));
  return { catalog, steps, fixtures };
}

// Validate the params of one call block against a catalog param spec. Unknown
// params and missing required params are both errors — a typo or a hallucinated
// param is caught here instead of surfacing as an undefined mid-run.
function lintCallParams(where, call, spec, push) {
  const { do: _name, ...params } = call;
  const declared = new Set(spec.params.map((p) => p.name));
  for (const key of Object.keys(params)) {
    if (!declared.has(key)) {
      const known = spec.params.map((p) => p.name).join(', ') || '(none)';
      push(`${where}: unknown param "${key}" for step "${spec.name}". Declared params: ${known}`);
    }
  }
  for (const p of spec.params) {
    if (p.required && !(p.name in params)) {
      push(`${where}: missing required param "${p.name}" for step "${spec.name}"`);
    }
  }
}

// Lint a single journey document against the catalog. Returns an array of
// human-readable error strings (empty = clean). Assumes the doc already passed
// the structural schema (loadJourneysDir validates on load); it re-validates
// defensively when called in isolation.
function lintJourney(doc, { steps, fixtures }, { source = `${doc.id}.yaml` } = {}) {
  const errors = [];
  const push = (m) => errors.push(`${source}: ${m}`);

  // Unknown step names (vs the catalog vocabulary).
  for (const name of referencedStepNames(doc)) {
    if (!steps.has(name)) {
      const known = [...steps.keys()].sort().join(', ') || '(none)';
      push(`unknown step "${name}" — not in the catalog. Known steps: ${known}`);
    }
  }

  // Step params.
  doc.steps.forEach((step, i) => {
    for (const kind of ['action', 'assert']) {
      const call = step[kind];
      if (!call || typeof call.do !== 'string') continue;
      const spec = steps.get(call.do);
      if (spec) lintCallParams(`steps[${i}].${kind}`, call, spec, push);
    }
  });

  // Fixtures: name known + params valid.
  (doc.fixtures || []).forEach((fx, i) => {
    const spec = fixtures.get(fx.fixture);
    if (!spec) {
      const known = [...fixtures.keys()].sort().join(', ') || '(none)';
      push(`fixtures[${i}]: unknown fixture "${fx.fixture}". Known fixtures: ${known}`);
      return;
    }
    const params = fx.params || {};
    const declared = new Set(spec.params.map((p) => p.name));
    for (const key of Object.keys(params)) {
      if (!declared.has(key)) {
        const known = spec.params.map((p) => p.name).join(', ') || '(none)';
        push(`fixtures[${i}]: unknown param "${key}" for fixture "${fx.fixture}". Declared params: ${known}`);
      }
    }
    for (const p of spec.params) {
      if (p.required && !(p.name in params)) {
        push(`fixtures[${i}]: missing required param "${p.name}" for fixture "${fx.fixture}"`);
      }
    }
  });

  return errors;
}

// Lint every journey in a directory. Returns { errors, journeyCount }. Loading
// throws on a structurally-invalid journey (the schema stage), which the CLI
// surfaces as a lint failure. Screenshot slugs must be unique GLOBALLY across
// the set (they key a combined artifact/doc index) — a duplicate is the
// "orphaned screenshot reference" the concept warns about.
function lintAll({ dir = JOURNEYS_DIR, catalog = loadCatalog() } = {}) {
  const errors = [];
  let journeys;
  try {
    journeys = loadJourneysDir(dir);
  } catch (err) {
    return { errors: [`schema: ${err.message}`], journeyCount: 0 };
  }

  const seenShots = new Map(); // slug -> journeyId
  for (const doc of journeys) {
    // Defensive re-validate (loadJourneysDir already did, but keep it explicit).
    try {
      validateJourney(doc, { source: `${doc.id}.yaml` });
    } catch (err) {
      errors.push(err.message);
      continue;
    }
    errors.push(...lintJourney(doc, catalog));
    for (const step of doc.steps) {
      if (!step.screenshot) continue;
      if (seenShots.has(step.screenshot)) {
        errors.push(
          `${doc.id}.yaml: screenshot id "${step.screenshot}" also used by ` +
            `"${seenShots.get(step.screenshot)}.yaml" — ids must be unique across all journeys`,
        );
      } else {
        seenShots.set(step.screenshot, doc.id);
      }
    }
  }

  return { errors, journeyCount: journeys.length };
}

module.exports = { loadCatalog, lintJourney, lintAll, lintCallParams };
