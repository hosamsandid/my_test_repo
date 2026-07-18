// Pure pixel-comparison core for the PR before/after screenshot evidence
// (docs/journey-spec-concept.md §3.4 + §7, #709).
//
// This module is deliberately Playwright-free and fs-free so it runs under
// `node --test` against committed fixture PNGs with no stack. The only runtime
// deps are pixelmatch (per-pixel diff) and pngjs (PNG encode/decode) — both
// pure JS, no native build. The fs/glob loading of an artifacts tree lives in
// loader.js; the Markdown rendering lives in comment.js. Keeping the three
// concerns split mirrors the #705 recorder / #707 docgen pure-module pattern.

const { PNG } = require('pngjs');
const pixelmatch = require('pixelmatch');

// pixelmatch per-pixel colour-distance sensitivity (0..1). §7: "small but
// non-zero (~0.1) to absorb AA jitter" — the same value the concept pins.
const DEFAULT_PIXEL_THRESHOLD = 0.1;

// A capture is only classified "changed" when the differing pixels exceed this
// fraction of the frame. 0 = any post-sensitivity difference counts. A tiny
// floor (e.g. 0.0001) can absorb sub-pixel noise the AA detector misses.
const DEFAULT_CHANGED_RATIO_FLOOR = 0;

const STATUS = Object.freeze({
  ADDED: 'added',
  REMOVED: 'removed',
  CHANGED: 'changed',
  UNCHANGED: 'unchanged',
});

// Compare two PNG buffers. Returns a plain summary plus (when comparable) a
// PNG buffer of the pixelmatch diff. Dimension mismatches are reported, never
// thrown — a resized page is a legitimate "changed" outcome, not an error.
function comparePng(baselineBuf, currentBuf, { pixelThreshold = DEFAULT_PIXEL_THRESHOLD } = {}) {
  const a = PNG.sync.read(baselineBuf);
  const b = PNG.sync.read(currentBuf);

  if (a.width !== b.width || a.height !== b.height) {
    return {
      dimensionMismatch: true,
      baselineSize: { width: a.width, height: a.height },
      currentSize: { width: b.width, height: b.height },
      width: b.width,
      height: b.height,
      diffPixels: null,
      totalPixels: b.width * b.height,
      ratio: 1,
      diff: null,
    };
  }

  const { width, height } = a;
  const diff = new PNG({ width, height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, width, height, {
    threshold: pixelThreshold,
    includeAA: false,
  });
  const totalPixels = width * height;
  return {
    dimensionMismatch: false,
    width,
    height,
    diffPixels,
    totalPixels,
    ratio: totalPixels ? diffPixels / totalPixels : 0,
    diff: PNG.sync.write(diff),
  };
}

// Compare a baseline capture set against a current one. `baseline`/`current`
// are Maps keyed by a stable capture id ("<journeyId>/<stepId>") whose values
// are { buffer, journeyId, stepId, file, viewport }. Returns the classified
// per-capture results plus a roll-up summary. Pure: no fs, no network.
function compareSets(baseline, current, {
  pixelThreshold = DEFAULT_PIXEL_THRESHOLD,
  changedRatioFloor = DEFAULT_CHANGED_RATIO_FLOOR,
} = {}) {
  const keys = [...new Set([...baseline.keys(), ...current.keys()])].sort();
  const results = [];

  for (const key of keys) {
    const base = baseline.get(key);
    const cur = current.get(key);
    const meta = cur || base;
    const common = { id: key, journeyId: meta.journeyId, stepId: meta.stepId };

    if (base && !cur) {
      results.push({ ...common, status: STATUS.REMOVED, diffPixels: null, totalPixels: null, ratio: null, dimensionMismatch: false, diff: null });
      continue;
    }
    if (cur && !base) {
      results.push({ ...common, status: STATUS.ADDED, diffPixels: null, totalPixels: null, ratio: null, dimensionMismatch: false, diff: null });
      continue;
    }

    const cmp = comparePng(base.buffer, cur.buffer, { pixelThreshold });
    const changed = cmp.dimensionMismatch || cmp.ratio > changedRatioFloor;
    results.push({
      ...common,
      status: changed ? STATUS.CHANGED : STATUS.UNCHANGED,
      diffPixels: cmp.diffPixels,
      totalPixels: cmp.totalPixels,
      ratio: cmp.ratio,
      dimensionMismatch: cmp.dimensionMismatch,
      baselineSize: cmp.baselineSize || null,
      currentSize: cmp.currentSize || null,
      diff: cmp.diff,
    });
  }

  const summary = { total: results.length, changed: 0, added: 0, removed: 0, unchanged: 0 };
  for (const r of results) summary[r.status] += 1;

  return { pixelThreshold, changedRatioFloor, results, summary };
}

module.exports = {
  comparePng,
  compareSets,
  STATUS,
  DEFAULT_PIXEL_THRESHOLD,
  DEFAULT_CHANGED_RATIO_FLOOR,
};
