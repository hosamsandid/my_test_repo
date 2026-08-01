// Journey YAML loader (docs/journey-spec-concept.md §2.1, #705).
//
// Reads a journey YAML file, parses it with js-yaml (FAILSAFE + block scalars
// are all the schema needs), and runs it through the pure structural validator.
// No Playwright dependency, so `node --test` can validate the pilot journey
// without a browser or the step library (the podman-free check from the issue).
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');
const { validateJourney } = require('./schema');

const JOURNEYS_DIR = path.resolve(__dirname, '..', 'journeys');

// Parse + validate a single journey file. `source` in error messages is the
// file's basename so a failure points at the offending journey.
function loadJourney(filePath) {
  const source = path.basename(filePath);
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    throw new Error(`journey ${source}: cannot read file — ${err.message}`);
  }
  let doc;
  try {
    doc = yaml.load(raw, { filename: source });
  } catch (err) {
    throw new Error(`journey ${source}: invalid YAML — ${err.message}`);
  }
  validateJourney(doc, { source });
  return doc;
}

// Load every *.yaml / *.yml journey in a directory, sorted by `order` then id so
// the runner (and later the doc generator) processes them deterministically.
function loadJourneysDir(dir = JOURNEYS_DIR) {
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const files = entries
    .filter((f) => /\.ya?ml$/i.test(f))
    .map((f) => path.join(dir, f));
  const journeys = files.map(loadJourney);
  journeys.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
  return journeys;
}

module.exports = { loadJourney, loadJourneysDir, JOURNEYS_DIR };
