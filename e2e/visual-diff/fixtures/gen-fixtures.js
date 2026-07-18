#!/usr/bin/env node
// Deterministic generator for the visual-diff test fixtures (#709). Run with
// `node fixtures/gen-fixtures.js` from e2e/visual-diff/ to (re)create the two
// committed capture sets. Deterministic (no Date/Math.random) so the fixtures
// are stable and the unit tests are reproducible. The PNGs it writes are the
// committed test surface — this script exists only to regenerate them.

const fs = require('fs');
const path = require('path');
const { PNG } = require('pngjs');

const HERE = __dirname;

// Solid-ish frame with an optional rectangle painted in, so we can produce a
// pair that differs in a bounded, predictable region.
function frame(width, height, { bg = [240, 240, 245], rect = null } = {}) {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (width * y + x) << 2;
      let [r, g, b] = bg;
      if (rect && x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
        [r, g, b] = rect.color;
      }
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function writeSet(setName, files) {
  const dir = path.join(HERE, setName, 'demo');
  fs.mkdirSync(dir, { recursive: true });
  const screenshots = [];
  for (const { stepId, buffer, viewport } of files) {
    fs.writeFileSync(path.join(dir, `${stepId}.png`), buffer);
    screenshots.push({ stepId, file: `${stepId}.png`, viewport });
  }
  const manifest = {
    journeyId: 'demo',
    title: 'Demo Journey',
    commitSha: '0000000000000000000000000000000000000000',
    timestamp: '2026-07-17T00:00:00.000Z',
    viewport: { width: 200, height: 120 },
    screenshots,
  };
  fs.writeFileSync(path.join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
}

const vp = { width: 200, height: 120 };

// landing: identical in both sets → unchanged.
const landing = frame(200, 120, { rect: { x: 10, y: 10, w: 60, h: 20, color: [30, 90, 200] } });
// form: a button block moves/recolours → changed, bounded diff region.
const formBaseline = frame(200, 120, { rect: { x: 20, y: 40, w: 80, h: 24, color: [40, 160, 90] } });
const formCurrent = frame(200, 120, { rect: { x: 20, y: 40, w: 80, h: 24, color: [200, 60, 60] } });
// resized: same content, different height → dimension mismatch.
const resizedBaseline = frame(200, 120, { rect: { x: 10, y: 10, w: 40, h: 40, color: [120, 120, 120] } });
const resizedCurrent = frame(200, 160, { rect: { x: 10, y: 10, w: 40, h: 40, color: [120, 120, 120] } });
// old-step: baseline only → removed. new-step: current only → added.
const oldStep = frame(200, 120, { rect: { x: 5, y: 5, w: 30, h: 30, color: [10, 10, 10] } });
const newStep = frame(200, 120, { rect: { x: 5, y: 5, w: 30, h: 30, color: [250, 250, 250] } });

writeSet('baseline', [
  { stepId: 'landing', buffer: landing, viewport: vp },
  { stepId: 'form', buffer: formBaseline, viewport: vp },
  { stepId: 'resized', buffer: resizedBaseline, viewport: vp },
  { stepId: 'old-step', buffer: oldStep, viewport: vp },
]);
writeSet('current', [
  { stepId: 'landing', buffer: landing, viewport: vp },
  { stepId: 'form', buffer: formCurrent, viewport: vp },
  { stepId: 'resized', buffer: resizedCurrent, viewport: { width: 200, height: 160 } },
  { stepId: 'new-step', buffer: newStep, viewport: vp },
]);

console.log('wrote baseline/ and current/ fixture capture sets');
