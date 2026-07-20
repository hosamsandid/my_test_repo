// Unit tests for the video orchestrator's ffmpeg-free surface (#712): clip
// discovery from the artifacts tree and the full build description. The ffmpeg
// spawn itself (assembleVideo) is exercised by the dispatched CI run, not here —
// agent containers may have no ffmpeg.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { computeVideoBuild, scanVideoIndex, CLIP_NAME } = require('./video');
const { loadJourneysDir } = require('../journey-runner/loader');

function tmpArtifacts() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'video-test-'));
}

test('scanVideoIndex: finds only the journeys whose clip exists on disk', () => {
  const dir = tmpArtifacts();
  const journeys = loadJourneysDir();
  assert.ok(journeys.length > 0, 'fixture: the repo ships journeys');
  const seeded = journeys[0];
  fs.mkdirSync(path.join(dir, seeded.id), { recursive: true });
  fs.writeFileSync(path.join(dir, seeded.id, CLIP_NAME), 'fake');

  const index = scanVideoIndex(dir, journeys);
  assert.equal(index[seeded.id], path.join(seeded.id, CLIP_NAME));
  assert.equal(Object.keys(index).length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeVideoBuild: real journeys, seeded clip → clip step present, unique intermediates', () => {
  const dir = tmpArtifacts();
  const journeys = loadJourneysDir();
  const seeded = journeys[0];
  fs.mkdirSync(path.join(dir, seeded.id), { recursive: true });
  fs.writeFileSync(path.join(dir, seeded.id, CLIP_NAME), 'fake');

  const build = computeVideoBuild({ artifactsDir: dir, fontFile: null });
  assert.equal(build.plan.journeyCount, journeys.length);

  // Every segment maps to a build step with an ffmpeg arg array.
  assert.equal(build.steps.length, build.plan.segments.length);
  for (const step of build.steps) assert.ok(Array.isArray(step.args) && step.args.length > 0);

  // Intermediate filenames are unique (order-preserving zero-padded index).
  const inters = build.steps.map((s) => s.intermediate);
  assert.equal(new Set(inters).size, inters.length);

  // The seeded journey has a clip step; a non-seeded one does not.
  const clipJourneys = build.steps.filter((s) => s.kind === 'clip').map((s) => s.segment.journeyId);
  assert.ok(clipJourneys.includes(seeded.id));
  assert.deepEqual([...new Set(clipJourneys)], [seeded.id]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('computeVideoBuild: no clips captured → title cards only, all journeys missing', () => {
  const dir = tmpArtifacts();
  const build = computeVideoBuild({ artifactsDir: dir, fontFile: null });
  assert.equal(build.steps.filter((s) => s.kind === 'clip').length, 0);
  assert.ok(build.steps.every((s) => s.kind === 'title'));
  assert.equal(build.plan.missingVideo.length, build.plan.journeyCount);
  fs.rmSync(dir, { recursive: true, force: true });
});
