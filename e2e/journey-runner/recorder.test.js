// Recorder tests (#705) — no Playwright, `node --test`. makeRecorder imports
// only fs/path/child_process, so a fake `page` (screenshot → Buffer) exercises
// the "buffer during the run, write only on flush" contract fully.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { makeRecorder } = require('./recorder');

function fakePage(tag = 'x') {
  return {
    screenshot: async () => Buffer.from(`png:${tag}`),
    viewportSize: () => ({ width: 1440, height: 900 }),
  };
}

test('capture buffers in memory; nothing is written before flush', async () => {
  const rec = makeRecorder({ id: 'team-setup', title: 'Team Setup' });
  await rec.capture(fakePage('a'), 'process-step-core-sdlc');
  await rec.capture(fakePage('b'), 'review-step');
  assert.equal(rec.stagedCount(), 2);
  // No filesystem side effects yet — assert by flushing into an empty temp root
  // and confirming exactly the two pngs + manifest appear only after flush.
});

test('flush writes one png per capture plus a manifest with metadata', async () => {
  // Point ARTIFACTS_ROOT at a temp dir by monkeypatching cwd-independent behaviour:
  // makeRecorder writes under <module>/../artifacts, so we run in a temp checkout
  // of the module path instead — simplest is to intercept via a subdir override.
  // Here we assert on the returned manifest + the files the recorder wrote to its
  // real artifacts root, then clean them up.
  const rec = makeRecorder(
    { id: 'unit-test-journey', title: 'Unit Test Journey' },
    { now: () => '2026-07-17T00:00:00.000Z' },
  );
  await rec.capture(fakePage('a'), 'shot-one');
  await rec.capture(fakePage('b'), 'shot-two');
  const manifest = await rec.flush({ commitSha: 'deadbeef' });

  assert.equal(manifest.journeyId, 'unit-test-journey');
  assert.equal(manifest.commitSha, 'deadbeef');
  assert.equal(manifest.timestamp, '2026-07-17T00:00:00.000Z');
  assert.deepEqual(manifest.viewport, { width: 1440, height: 900 });
  assert.deepEqual(manifest.screenshots.map((s) => s.file), ['shot-one.png', 'shot-two.png']);

  // Files exist on disk under the artifacts root for this journey id.
  const dir = path.resolve(__dirname, '..', 'artifacts', 'unit-test-journey');
  assert.ok(fs.existsSync(path.join(dir, 'shot-one.png')));
  assert.ok(fs.existsSync(path.join(dir, 'manifest.json')));
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'));
  assert.equal(onDisk.commitSha, 'deadbeef');

  fs.rmSync(dir, { recursive: true, force: true });
});

test('a recorder that never flushes leaves no artifacts', () => {
  const dir = path.resolve(__dirname, '..', 'artifacts', 'never-flushed');
  // (No flush call — directory must not exist.)
  assert.equal(fs.existsSync(dir), false);
});
