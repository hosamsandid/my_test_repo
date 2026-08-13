// Tour-manifest generator tests (#1736) — pure, `node --test`, no Playwright,
// no js-yaml (the builder is driven with in-memory journey objects).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  buildTourManifest,
  renderManifestJson,
  manifestsEqualIgnoringGenerated,
  makeArtifactChecker,
  MANIFEST_NOTE,
  OUTPUT_PATH,
} = require('./build-tour-manifest');

// A minimal narrated journey: one step with both voiceover + screenshot, one
// step with only a screenshot, one narrative-only step (voiceover, no shot).
const narrated = {
  id: 'team-setup',
  order: 10,
  title: 'Team Setup',
  steps: [
    { kind: 'narrative-only', id: 'intro', voiceover: '  Welcome to the team.\n' },
    { id: 'process-step', voiceover: 'Pick a process.', screenshot: 'process-step' },
    { id: 'plumbing', action: { do: 'wizard.next' } },
    { id: 'shot-only', screenshot: 'no-voiceover' },
  ],
};

// A second narrated journey with a lower `order` so we can prove sorting.
const earlier = {
  id: 'iban-story',
  order: 5,
  title: 'The IBAN Story',
  steps: [{ id: 'kickoff', voiceover: 'Label an issue.', screenshot: 'kickoff' }],
};

const routeMap = { 'team-setup': '/team-setup', 'iban-story': '/chats' };
const fixedNow = () => new Date('2026-01-01T00:00:00.000Z');

test('manifest keeps only steps with both voiceover and screenshot', () => {
  const { manifest } = buildTourManifest({
    journeys: [narrated],
    artifactExists: () => true,
    routeMap,
    now: fixedNow,
  });
  assert.equal(manifest.chapters.length, 1);
  const chapter = manifest.chapters[0];
  assert.deepEqual(chapter, {
    id: 'team-setup',
    order: 10,
    title: 'Team Setup',
    route: '/team-setup',
    steps: [
      { id: 'process-step', voiceover: 'Pick a process.', screenshotPath: 'team-setup/process-step.png' },
    ],
  });
  // The narrative-only, plumbing and shot-only steps are all excluded.
  assert.equal(chapter.steps.length, 1);
  // Standard manifest envelope.
  assert.equal(manifest.note, MANIFEST_NOTE);
  assert.equal(manifest.generated, '2026-01-01T00:00:00.000Z');
});

test('a step whose screenshot artifact is missing is omitted with a warning', () => {
  const { manifest, warnings } = buildTourManifest({
    journeys: [narrated],
    // The one qualifying step's PNG does not exist on disk.
    artifactExists: (journeyId, shot) => !(journeyId === 'team-setup' && shot === 'process-step'),
    routeMap,
    now: fixedNow,
  });
  // Its only narrated+captured step dropped → the chapter drops out entirely.
  assert.equal(manifest.chapters.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /team-setup\/process-step\.png/);
  assert.match(warnings[0], /omitted/);
});

test('chapters are sorted by order ascending', () => {
  const { manifest } = buildTourManifest({
    journeys: [narrated, earlier],
    artifactExists: () => true,
    routeMap,
    now: fixedNow,
  });
  assert.deepEqual(
    manifest.chapters.map((c) => c.id),
    ['iban-story', 'team-setup'],
  );
  assert.deepEqual(
    manifest.chapters.map((c) => c.order),
    [5, 10],
  );
});

test('a narrated journey with no route mapping is skipped with a warning', () => {
  const orphan = {
    id: 'outcomes-routing',
    order: 45,
    title: 'Routing & outcomes',
    steps: [{ id: 's1', voiceover: 'Route it.', screenshot: 's1' }],
  };
  const { manifest, warnings } = buildTourManifest({
    journeys: [orphan],
    artifactExists: () => true,
    routeMap,
    now: fixedNow,
  });
  assert.equal(manifest.chapters.length, 0);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /no route mapping/);
});

test('a journey without an order is not a chapter', () => {
  const { manifest } = buildTourManifest({
    journeys: [{ id: 'wiring', title: 'Wiring', steps: narrated.steps }],
    artifactExists: () => true,
    routeMap: { wiring: '/flows' },
    now: fixedNow,
  });
  assert.equal(manifest.chapters.length, 0);
});

test('rendering is deterministic and the check ignores the generated timestamp', () => {
  const a = renderManifestJson(
    buildTourManifest({ journeys: [narrated], routeMap, now: () => new Date('2026-01-01T00:00:00Z') }).manifest,
  );
  const b = renderManifestJson(
    buildTourManifest({ journeys: [narrated], routeMap, now: () => new Date('2027-09-09T09:09:09Z') }).manifest,
  );
  // Different timestamps → different bytes …
  assert.notEqual(a, b);
  // … but equal once the volatile `generated` field is ignored.
  assert.ok(manifestsEqualIgnoringGenerated(a, b));
  // Trailing newline for a diff-stable committed file.
  assert.ok(a.endsWith('\n'));
});

test('makeArtifactChecker treats a missing or empty artifacts dir as "keep all"', () => {
  // A directory that does not exist → keep every step.
  const absent = path.join(os.tmpdir(), 'aee-tour-absent-does-not-exist');
  assert.equal(makeArtifactChecker(absent)('team-setup', 'process-step'), true);

  // A directory that exists but holds no journey subdirectories (a prior
  // `make e2e` whose PNGs were cleared) → also keep every step, so the committed
  // manifest stays the full set and `--check` reproduces it. This is the case
  // that used to generate an empty manifest and red the freshness guard.
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-tour-empty-'));
  try {
    assert.equal(makeArtifactChecker(empty)('team-setup', 'process-step'), true);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }

  // A directory that actually holds a journey subdirectory → per-PNG verified:
  // the present PNG passes, an absent one fails.
  const populated = fs.mkdtempSync(path.join(os.tmpdir(), 'aee-tour-populated-'));
  try {
    fs.mkdirSync(path.join(populated, 'team-setup'));
    fs.writeFileSync(path.join(populated, 'team-setup', 'process-step.png'), 'png');
    const check = makeArtifactChecker(populated);
    assert.equal(check('team-setup', 'process-step'), true);
    assert.equal(check('team-setup', 'missing-shot'), false);
  } finally {
    fs.rmSync(populated, { recursive: true, force: true });
  }
});

test('the committed tour-manifest.json is up to date with the journey YAMLs', () => {
  // Requires js-yaml (loader) — runs in CI where the e2e deps are installed. The
  // build is deterministic apart from `generated`, so compare ignoring it.
  const { loadJourneysDir } = require('./loader');
  const { makeArtifactChecker } = require('./build-tour-manifest');
  const { manifest } = buildTourManifest({
    journeys: loadJourneysDir(),
    artifactExists: makeArtifactChecker(),
  });
  const current = fs.readFileSync(OUTPUT_PATH, 'utf8');
  assert.ok(
    manifestsEqualIgnoringGenerated(current, renderManifestJson(manifest)),
    'run `make tour-manifest` and commit the result',
  );
});
