// Tour-manifest generator (Helper Chat Phase 2.1, #1736; docs/helper-chat-concept.md §4).
//
// Distils the narrated e2e journeys into a compact tour manifest the Helper
// Chat "tour" UI (#1737) consumes: one chapter per narrated journey, each with
// the second-person `voiceover` copy + the captured screenshot path for every
// step that carries BOTH a voiceover and a screenshot. It reads the SAME
// validated journey YAMLs the runner uses (via `loader.js`), so the tour copy
// can never drift from the journeys — and, like `catalog.js`, it is pure and
// Playwright-free so it runs on the fast podman-free CI lane.
//
// The narration lives in `voiceover:`; a step only reaches the tour when it also
// names a `screenshot:` (there is nothing to show otherwise). The physical PNGs
// are written by a green journey run under `e2e/artifacts/<journeyId>/`; on a
// fresh checkout (or the podman-free CI lane) that directory is absent, in which
// case the artifact filter is skipped entirely so the committed manifest still
// carries every narrated step. When the directory IS present, a step whose PNG
// is missing is dropped with a stderr warning rather than crashing the build.
//
//   node journey-runner/build-tour-manifest.js          # write the manifest
//   node journey-runner/build-tour-manifest.js --check   # exit 1 if it is stale
//
// The `--check` form is what CI runs on every PR (`npm run journeys:tour:check`):
// it fails when the committed manifest no longer matches the journey YAMLs, so a
// voiceover edit that forgets to regenerate the manifest can't merge. The
// volatile `generated` timestamp is ignored by the comparison.
const fs = require('fs');
const path = require('path');
// `loader.js` (and its js-yaml dependency) is required lazily inside the CLI
// block below so the pure exports of this module stay dependency-free — the unit
// tests drive `buildTourManifest` directly with in-memory journey objects.

// Where the generated manifest is committed. It lives next to the Helper Chat
// runtime module (admin-console/api/helper-chat/) because the admin-console
// image build context is admin-console/ and cannot reach repo-root e2e/ — the
// same vendoring rationale as the corpus docs shipped in #1733.
const OUTPUT_PATH = path.resolve(
  __dirname,
  '..',
  '..',
  'admin-console',
  'api',
  'helper-chat',
  'tour-manifest.json',
);

// Screenshot artifacts written by a passing journey run.
const ARTIFACTS_DIR = path.resolve(__dirname, '..', 'artifacts');

// Journey id → the console route the tour navigates to for that chapter.
// Hardcoded on purpose — these routes rarely change, and a chapter with no route
// cannot be a tour chapter (the UI navigates there). A narrated journey missing
// from this map is skipped with a warning so the gap is visible, not silent.
const ROUTE_MAP = {
  'team-setup': '/team-setup',
  'iban-story': '/chats',
  triggers: '/jobs',
  'flows-draft': '/flows',
  'agent-templates': '/role-templates',
  'token-usage': '/token-usage',
};

const MANIFEST_NOTE = 'GENERATED — do not edit. Rebuild with: make tour-manifest';

// Build an artifact-existence predicate over a real artifacts directory. When
// the directory is absent (fresh checkout / podman-free CI lane) OR present but
// empty (a prior `make e2e` whose PNGs were since cleared, leaving a bare
// directory) every step is kept — the committed manifest is the full narrated
// set, and the check lane regenerates it identically. Per-PNG verification is
// activated only when the directory actually holds journey subdirectories.
function makeArtifactChecker(artifactsDir = ARTIFACTS_DIR) {
  let hasArtifacts = false;
  try {
    hasArtifacts =
      fs.statSync(artifactsDir).isDirectory() &&
      fs.readdirSync(artifactsDir, { withFileTypes: true }).some((e) => e.isDirectory());
  } catch {
    hasArtifacts = false;
  }
  return (journeyId, screenshot) => {
    if (!hasArtifacts) return true;
    try {
      return fs.statSync(path.join(artifactsDir, journeyId, `${screenshot}.png`)).isFile();
    } catch {
      return false;
    }
  };
}

// Assemble the manifest from validated journey objects. Pure: `artifactExists`
// and `routeMap` are injectable so the unit tests drive it without touching the
// filesystem. Returns { manifest, warnings } — warnings are emitted to stderr by
// the CLI but never fail the build.
function buildTourManifest({
  journeys,
  artifactExists = () => true,
  routeMap = ROUTE_MAP,
  now = () => new Date(),
} = {}) {
  const warnings = [];
  const chapters = [];

  for (const journey of journeys) {
    // Only journeys with an `order` are narrated deck chapters.
    if (journey.order === undefined || journey.order === null) continue;

    const steps = [];
    for (const step of journey.steps || []) {
      // A tour step needs BOTH the narration and something to show.
      if (!step.voiceover || !step.screenshot) continue;
      if (!artifactExists(journey.id, step.screenshot)) {
        warnings.push(
          `journey ${journey.id}: screenshot artifact missing for step ` +
            `"${step.id || step.screenshot}" (${journey.id}/${step.screenshot}.png) — step omitted`,
        );
        continue;
      }
      steps.push({
        id: step.id || step.screenshot,
        voiceover: String(step.voiceover).trim(),
        screenshotPath: `${journey.id}/${step.screenshot}.png`,
      });
    }

    // A chapter with no narrated+captured step is not a tour chapter.
    if (steps.length === 0) continue;

    const route = routeMap[journey.id];
    if (!route) {
      warnings.push(
        `journey ${journey.id}: narrated (${steps.length} step(s)) but has no route ` +
          `mapping — chapter skipped; add it to ROUTE_MAP`,
      );
      continue;
    }

    chapters.push({ id: journey.id, order: journey.order, title: journey.title, route, steps });
  }

  chapters.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));

  const manifest = {
    generated: now().toISOString(),
    note: MANIFEST_NOTE,
    chapters,
  };
  return { manifest, warnings };
}

// Deterministic serialization — 2-space indent + trailing newline, so the
// committed manifest is diff-stable.
function renderManifestJson(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Compare two rendered manifests ignoring the volatile `generated` timestamp, so
// `--check` doesn't flag a manifest as stale purely because the clock advanced.
function manifestsEqualIgnoringGenerated(a, b) {
  const strip = (raw) => {
    try {
      const doc = JSON.parse(raw);
      delete doc.generated;
      return JSON.stringify(doc);
    } catch {
      return null;
    }
  };
  const sa = strip(a);
  const sb = strip(b);
  return sa !== null && sa === sb;
}

module.exports = {
  OUTPUT_PATH,
  ARTIFACTS_DIR,
  ROUTE_MAP,
  MANIFEST_NOTE,
  makeArtifactChecker,
  buildTourManifest,
  renderManifestJson,
  manifestsEqualIgnoringGenerated,
};

// ── CLI ──────────────────────────────────────────────────────────────────────
if (require.main === module) {
  const check = process.argv.includes('--check');
  const { loadJourneysDir } = require('./loader');
  const journeys = loadJourneysDir();
  const artifactExists = makeArtifactChecker(ARTIFACTS_DIR);
  const { manifest, warnings } = buildTourManifest({ journeys, artifactExists });
  for (const w of warnings) process.stderr.write(`${w}\n`);

  const rendered = renderManifestJson(manifest);

  if (check) {
    let current = null;
    try {
      current = fs.readFileSync(OUTPUT_PATH, 'utf8');
    } catch {
      current = null;
    }
    if (current === null || !manifestsEqualIgnoringGenerated(current, rendered)) {
      process.stderr.write(
        'tour-manifest.json is stale — run `make tour-manifest` and commit the result.\n',
      );
      process.exit(1);
    }
    process.stdout.write('tour-manifest.json is up to date.\n');
    process.exit(0);
  }

  fs.mkdirSync(path.dirname(OUTPUT_PATH), { recursive: true });
  fs.writeFileSync(OUTPUT_PATH, rendered);
  process.stdout.write(`Wrote ${OUTPUT_PATH} (${manifest.chapters.length} chapters)\n`);
}
