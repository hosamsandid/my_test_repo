// End-to-end (still stack-free) test of the compare-and-comment CLI (#709):
// runs the real binary against the fixture capture sets into a temp dir and
// asserts the emitted images + comment.md + summary.json.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const BIN = path.join(__dirname, 'bin', 'compare-and-comment.js');
const FIX = path.join(__dirname, 'fixtures');

function run(extra = []) {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vdiff-'));
  execFileSync('node', [
    BIN,
    '--baseline', path.join(FIX, 'baseline'),
    '--current', path.join(FIX, 'current'),
    '--out', out,
    ...extra,
  ], { stdio: 'pipe' });
  return out;
}

test('emits before/after/diff images only for visible captures', () => {
  const out = run();
  const files = fs.readdirSync(out).sort();
  // changed form → baseline+current+diff; resized → baseline+current (no diff, size changed)
  assert.ok(files.includes('demo__form.baseline.png'));
  assert.ok(files.includes('demo__form.current.png'));
  assert.ok(files.includes('demo__form.diff.png'));
  assert.ok(files.includes('demo__resized.baseline.png'));
  assert.ok(files.includes('demo__resized.current.png'));
  assert.ok(!files.includes('demo__resized.diff.png'), 'no diff for a dimension mismatch');
  // added → current only; removed → baseline only
  assert.ok(files.includes('demo__new-step.current.png'));
  assert.ok(!files.includes('demo__new-step.baseline.png'));
  assert.ok(files.includes('demo__old-step.baseline.png'));
  assert.ok(!files.includes('demo__old-step.current.png'));
  // unchanged landing emits nothing
  assert.ok(!files.some((f) => f.startsWith('demo__landing')));
});

test('writes a sticky comment.md and machine-readable summary.json', () => {
  const out = run(['--base-url', 'https://raw.example.test/pr/1']);
  const body = fs.readFileSync(path.join(out, 'comment.md'), 'utf8');
  assert.match(body, /Journey UI screenshots/);
  assert.match(body, /!\[current\]\(https:\/\/raw\.example\.test\/pr\/1\/demo__form\.current\.png\)/);

  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.total, 5);
  assert.equal(summary.changed, 2);
  assert.equal(summary.added, 1);
  assert.equal(summary.removed, 1);
  assert.equal(summary.unchanged, 1);
  // raw diff buffers are stripped from the JSON roll-up
  assert.ok(summary.results.every((r) => !('diff' in r)));
});

test('exits 0 and reports even when there is no baseline', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'vdiff-'));
  execFileSync('node', [BIN, '--current', path.join(FIX, 'current'), '--out', out], { stdio: 'pipe' });
  const summary = JSON.parse(fs.readFileSync(path.join(out, 'summary.json'), 'utf8'));
  assert.equal(summary.added, 4);
  assert.equal(summary.changed, 0);
});
