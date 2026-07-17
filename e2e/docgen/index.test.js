// Golden doc-generation test (#707) — the podman-free proof that docgen turns
// journeys + a run's artifacts into the expected user-guide page, screenshots
// interleaved. Runs against the committed fixture (fake manifest + a tiny PNG),
// so no stack is needed; regenerating and diffing against the committed expected
// page is exactly the "no diff from committed inputs" guard (§3.2, item 2).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { generate } = require('./index');

const FIXTURES = path.resolve(__dirname, 'fixtures');
const JOURNEYS = path.join(FIXTURES, 'journeys');
const ARTIFACTS = path.join(FIXTURES, 'artifacts');
const EXPECTED = path.join(FIXTURES, 'expected');

// Coverage inputs are stubbed here so the golden page test doesn't depend on the
// real NAV_PAGES / walkthrough README (those are exercised in coverage.test.js).
function generateToTemp() {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-golden-'));
  const res = generate({
    journeysDir: JOURNEYS,
    artifactsDir: ARTIFACTS,
    outDir: out,
    navPages: ['Team Wizard'],
    chapters: [{ title: 'Sample Journey', maturity: 'mature', todo: false }],
  });
  return { out, res };
}

test('generated page matches the committed golden byte-for-byte', () => {
  const { out } = generateToTemp();
  const actual = fs.readFileSync(path.join(out, '10-sample.md'), 'utf8');
  const expected = fs.readFileSync(path.join(EXPECTED, '10-sample.md'), 'utf8');
  assert.equal(actual, expected, 'regenerated page differs from committed golden — run docgen and recommit, or the golden was hand-edited');
  fs.rmSync(out, { recursive: true, force: true });
});

test('referenced screenshot is copied next to its page and is byte-identical', () => {
  const { out } = generateToTemp();
  const copied = path.join(out, 'assets', 'sample', 'landing.png');
  assert.ok(fs.existsSync(copied), 'screenshot not copied into the guide bundle');
  const src = fs.readFileSync(path.join(ARTIFACTS, 'sample', 'landing.png'));
  assert.ok(fs.readFileSync(copied).equals(src), 'copied screenshot bytes differ');
  fs.rmSync(out, { recursive: true, force: true });
});

test('a journey without a manifest still renders (narrative-only page)', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'docgen-nomani-'));
  const res = generate({
    journeysDir: JOURNEYS,
    artifactsDir: path.join(os.tmpdir(), 'does-not-exist-artifacts'),
    outDir: out,
    navPages: [],
    chapters: [],
  });
  const md = fs.readFileSync(path.join(out, '10-sample.md'), 'utf8');
  assert.match(md, /This is the chapter introduction/);
  assert.doesNotMatch(md, /!\[/, 'no images without a manifest');
  assert.equal(res.pages[0].hasManifest, false);
  fs.rmSync(out, { recursive: true, force: true });
});
