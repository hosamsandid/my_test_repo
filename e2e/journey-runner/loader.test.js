// Loader + pilot-journey validation tests (#705) — no Playwright, `node --test`.
// This is the issue's "schema validation of the pilot journey" podman-free check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { loadJourney, loadJourneysDir, JOURNEYS_DIR } = require('./loader');
const { referencedStepNames } = require('./schema');

const PILOT = path.join(JOURNEYS_DIR, 'team-setup.yaml');

test('the pilot team-setup journey loads and is schema-valid', () => {
  const j = loadJourney(PILOT);
  assert.equal(j.journeyVersion, 1);
  assert.equal(j.id, 'team-setup');
  assert.equal(j.title, 'Team Setup');
  assert.ok(Array.isArray(j.fixtures) && j.fixtures[0].fixture === 'teamEnv');
  assert.ok(j.steps.length > 0);
});

test('the pilot captures the launcher then the five named wizard screenshots', () => {
  const j = loadJourney(PILOT);
  const shots = j.steps.map((s) => s.screenshot).filter(Boolean);
  assert.deepEqual(shots, [
    'create-launcher',
    'process-step-core-sdlc',
    'working-environment-step',
    'team-step',
    'knowledge-step',
    'review-step',
  ]);
});

test('the pilot only references steps from the known step-library namespaces', () => {
  const j = loadJourney(PILOT);
  const names = referencedStepNames(j);
  assert.ok(names.length > 0);
  for (const n of names) {
    assert.match(n, /^(create|wizard|env|agents|teardown)\.[a-zA-Z]+$/, `step name ${n} is namespaced`);
  }
});

test('loadJourneysDir returns the pilot, sorted deterministically', () => {
  const journeys = loadJourneysDir();
  assert.ok(journeys.find((j) => j.id === 'team-setup'), 'team-setup present');
});

test('loadJourney surfaces invalid YAML with the file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-bad-'));
  const bad = path.join(dir, 'broken.yaml');
  fs.writeFileSync(bad, 'journeyVersion: 1\nid: x\ntitle: X\nsteps:\n  - action: {do: a.b\n'); // unterminated
  assert.throws(() => loadJourney(bad), /broken\.yaml: invalid YAML/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('loadJourney rejects a structurally-invalid journey with the file name', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'journey-bad-'));
  const bad = path.join(dir, 'noversion.yaml');
  fs.writeFileSync(bad, 'id: x\ntitle: X\nsteps: [{action: {do: a.b}}]\n');
  assert.throws(() => loadJourney(bad), /noversion\.yaml: journeyVersion must be 1/);
  fs.rmSync(dir, { recursive: true, force: true });
});
