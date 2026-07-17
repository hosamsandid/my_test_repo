// render.js unit tests (#707) — pure, `node --test`, no browser/podman.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  renderNarrative,
  renderHeader,
  renderJourneyPage,
  pageFileName,
  screenshotIndex,
} = require('./render');

test('renderNarrative preserves paragraph breaks and trims blanks', () => {
  const out = renderNarrative('\n\nfirst para\n\n\n\nsecond para\n\n');
  assert.equal(out, 'first para\n\nsecond para');
});

test('renderHeader carries source, commit and generated date as HTML comments', () => {
  const h = renderHeader({ sourcePath: 'e2e/journeys/x.yaml', commitSha: 'abc', timestamp: 'T' });
  assert.match(h, /@generated/);
  assert.match(h, /source: e2e\/journeys\/x\.yaml/);
  assert.match(h, /commit: abc/);
  assert.match(h, /generated: T/);
});

test('pageFileName is <order>-<id>.md, order zero-padded to two digits', () => {
  assert.equal(pageFileName({ order: 10, id: 'team-setup' }), '10-team-setup.md');
  assert.equal(pageFileName({ order: 5, id: 'x' }), '05-x.md');
  assert.equal(pageFileName({ id: 'y' }), '00-y.md');
});

test('screenshotIndex maps capture stepId -> file', () => {
  const idx = screenshotIndex({ screenshots: [{ stepId: 'a', file: 'a.png' }] });
  assert.equal(idx.get('a'), 'a.png');
  assert.equal(idx.has('b'), false);
});

const JOURNEY = {
  id: 'demo',
  title: 'Demo',
  steps: [
    { kind: 'narrative-only', narrative: 'intro prose' },
    { id: 'one', narrative: 'step one prose', action: { do: 'x.y' }, screenshot: 'shot-one' },
    { id: 'two', narrative: 'step two prose', action: { do: 'x.z' } },
  ],
};

test('renderJourneyPage interleaves narrative and captured screenshots in order', () => {
  const manifest = { commitSha: 'sha', timestamp: 'ts', screenshots: [{ stepId: 'shot-one', file: 'shot-one.png' }] };
  const md = renderJourneyPage(JOURNEY, manifest, { sourcePath: 'e2e/journeys/demo.yaml' });
  assert.match(md, /# Demo/);
  // narrative -> image -> narrative order preserved
  const iIntro = md.indexOf('intro prose');
  const iOne = md.indexOf('step one prose');
  const iImg = md.indexOf('![one](assets/demo/shot-one.png)');
  const iTwo = md.indexOf('step two prose');
  assert.ok(iIntro < iOne && iOne < iImg && iImg < iTwo, 'ordering broken');
});

test('renderJourneyPage without a manifest renders narrative, omits images', () => {
  const md = renderJourneyPage(JOURNEY, null, { sourcePath: 'e2e/journeys/demo.yaml' });
  assert.match(md, /step one prose/);
  assert.doesNotMatch(md, /!\[one\]/, 'no image link without a captured screenshot');
  assert.match(md, /commit: unknown/);
});
