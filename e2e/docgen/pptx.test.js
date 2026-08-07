// Deck-generation tests (#708) — the podman-free proof that docgen turns journeys
// + a run's artifacts into a structurally valid .pptx with the narrative in the
// speaker notes. Runs against the committed fixture (fake manifest + a tiny PNG)
// and reads the produced deck back as an OOXML zip, so no PowerPoint, browser or
// stack is needed (§3.2: "validation must be scriptable").
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { loadJourney } = require('../journey-runner/loader');
const { buildDeckModel, buildDeckBuffer, validateDeck } = require('./pptx');
const { generateDeck, resolveImagePath } = require('./deck');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const JOURNEYS = path.join(FIXTURES, 'journeys');
const ARTIFACTS = path.join(FIXTURES, 'artifacts');

const sample = loadJourney(path.join(JOURNEYS, 'sample.yaml'));
const sampleManifest = JSON.parse(fs.readFileSync(path.join(ARTIFACTS, 'sample', 'manifest.json'), 'utf8'));

// --- pure model ---------------------------------------------------------------

test('model: only visual steps make slides; all narrative folds into their notes', () => {
  const { slides, journeyCount } = buildDeckModel([sample], { sample: sampleManifest });
  assert.equal(journeyCount, 1);
  // sample.yaml: intro (prose-only) + landing (screenshot) + no-shot (prose) +
  // outro (prose). Only `landing` carries a visual, so the deck is: section + the
  // landing slide — no prose-only content slides.
  assert.deepEqual(slides.map((s) => s.type), ['section', 'step']);
  assert.equal(slides[0].title, 'Sample Journey');
  // The `landing` step has a captured screenshot in the manifest → image ref.
  const landing = slides.find((s) => s.stepId === 'landing');
  assert.deepEqual(landing.image, { kind: 'screenshot', journeyId: 'sample', file: 'landing.png' });
  // Its notes carry the buffered lead-in intro, its own narrative, and the
  // trailing no-shot + outro narrative — all four, verbatim.
  assert.match(landing.notes, /This is the chapter introduction/);
  assert.match(landing.notes, /Here is the landing page/);
  assert.match(landing.notes, /only prose renders here/);
  assert.match(landing.notes, /And that wraps up the sample journey/);
  // Order preserved: the intro lead-in precedes the landing step's own prose.
  assert.ok(
    landing.notes.indexOf('chapter introduction') < landing.notes.indexOf('Here is the landing page'),
  );
});

test('model: a journey with no visual parks its narrative on the section notes, no prose slide', () => {
  const journey = {
    id: 'plumb', title: 'Plumbing', order: 1,
    steps: [
      { id: 'login', action: { do: 'auth.login' } }, // no narrative, no screenshot → nothing
      { id: 'shown', narrative: 'Visible prose.' }, // narrative, no visual → onto section notes
    ],
  };
  const { slides } = buildDeckModel([journey], {});
  assert.deepEqual(slides.map((s) => s.type), ['section']);
  assert.match(slides[0].notes, /Visible prose\./);
});

test('model: narrative-only step with a static visual becomes a concept slide with a visual ref', () => {
  const journey = {
    id: 'concept', title: 'Concept', order: 1,
    steps: [{ kind: 'narrative-only', narrative: 'What is a team?', visual: 'diagrams/team.png' }],
  };
  const { slides } = buildDeckModel([journey], {});
  assert.equal(slides[1].type, 'concept');
  assert.deepEqual(slides[1].image, { kind: 'visual', src: 'diagrams/team.png' });
});

test('model: journeys keep the loader order (by `order`)', () => {
  const a = { id: 'a', title: 'A', order: 20, steps: [{ narrative: 'a' }] };
  const b = { id: 'b', title: 'B', order: 10, steps: [{ narrative: 'b' }] };
  // buildDeckModel does not re-sort; it trusts the loader. Feed pre-sorted input.
  const { slides } = buildDeckModel([b, a], {});
  assert.deepEqual(slides.filter((s) => s.type === 'section').map((s) => s.title), ['B', 'A']);
});

// --- render + structural validation ------------------------------------------

async function buildFixtureDeck() {
  const model = buildDeckModel([sample], { sample: sampleManifest });
  const buffer = await buildDeckBuffer(model, {
    resolveImage: (ref) => resolveImagePath(ref, { artifactsDir: ARTIFACTS, journeysDir: JOURNEYS }),
  });
  return { model, buffer };
}

test('deck builds from the fixture and passes structural validation', async () => {
  const { model, buffer } = await buildFixtureDeck();
  const expectedNotes = model.slides.filter((s) => s.notes).map((s) => s.notes);
  const result = await validateDeck(buffer, { expectedSlides: model.slides.length, expectedNotes });
  assert.equal(result.ok, true, `validation errors: ${result.errors.join('; ')}`);
  assert.equal(result.slideCount, 2);
  assert.equal(result.errors.length, 0);
});

test('speaker notes carry each step narrative verbatim', async () => {
  const { buffer } = await buildFixtureDeck();
  const { notesText } = await validateDeck(buffer);
  assert.ok(notesText.includes('Here is the landing page. The screenshot below was captured on the green run.'));
  assert.ok(notesText.includes('This step has narrative but no screenshot, so only prose renders here.'));
  assert.ok(notesText.includes('And that wraps up the sample journey.'));
});

test('validation flags a slide-count mismatch', async () => {
  const { buffer } = await buildFixtureDeck();
  const result = await validateDeck(buffer, { expectedSlides: 99 });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /slide count 2 does not match expected 99/.test(e)));
});

test('validation flags a missing narrative in the notes', async () => {
  const { buffer } = await buildFixtureDeck();
  const result = await validateDeck(buffer, { expectedNotes: ['this narrative was never in any journey'] });
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /speaker notes missing narrative verbatim/.test(e)));
});

test('validation rejects a non-OOXML buffer', async () => {
  const result = await validateDeck(Buffer.from('not a zip'));
  assert.equal(result.ok, false);
  assert.ok(result.errors.some((e) => /not a valid OOXML\/zip container/.test(e)));
});

// --- fs orchestration (generateDeck writes + validates the real file) ---------

test('generateDeck writes a valid .pptx to the target path', async () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'deck-'));
  const outFile = path.join(out, 'walkthrough.pptx');
  const res = await generateDeck({ journeysDir: JOURNEYS, artifactsDir: ARTIFACTS, outFile });
  try {
    assert.equal(res.outFile, outFile);
    assert.equal(res.validation.ok, true, `validation errors: ${res.validation.errors.join('; ')}`);
    assert.ok(fs.existsSync(outFile));
    // Re-validate the bytes actually on disk (not just the in-memory buffer).
    const onDisk = await validateDeck(fs.readFileSync(outFile), { expectedSlides: res.slideCount });
    assert.equal(onDisk.ok, true, `on-disk validation errors: ${onDisk.errors.join('; ')}`);
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
});
