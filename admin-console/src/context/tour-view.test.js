import test from 'node:test';
import assert from 'node:assert/strict';

import {
  TOUR_PROGRESS_KEY,
  TOUR_MANIFEST_URL,
  TOUR_SCREENSHOT_BASE,
  sortChapters,
  findChapter,
  chapterSteps,
  screenshotUrl,
  emptyProgress,
  normalizeProgress,
  parseProgress,
  serializeProgress,
  isChapterComplete,
  setCurrent,
  markChapterComplete,
  clearCurrent,
  resumePoint,
  clampStep,
  isLastStep,
} from './tour-view.js';

const MANIFEST = {
  chapters: [
    { id: 'b', order: 30, title: 'B', route: '/b', steps: [{ id: 's1', voiceover: 'x', screenshotPath: 'b/s1.png' }] },
    { id: 'a', order: 10, title: 'A', route: '/a', steps: [
      { id: 's1', voiceover: 'a1', screenshotPath: 'a/s1.png' },
      { id: 's2', voiceover: 'a2', screenshotPath: 'a/s2.png' },
    ] },
    { id: 'c', order: 20, title: 'C', route: '/c', steps: [] },
  ],
};

test('constants', () => {
  assert.equal(TOUR_PROGRESS_KEY, 'helper-chat.tour-progress');
  assert.equal(TOUR_MANIFEST_URL, '/api/helper/tour-manifest');
  assert.equal(TOUR_SCREENSHOT_BASE, '/api/helper/tour-screenshot');
});

test('sortChapters orders by order then array position, non-mutating', () => {
  const sorted = sortChapters(MANIFEST);
  assert.deepEqual(sorted.map(c => c.id), ['a', 'c', 'b']);
  // input untouched
  assert.equal(MANIFEST.chapters[0].id, 'b');
});

test('sortChapters tolerates junk', () => {
  assert.deepEqual(sortChapters(null), []);
  assert.deepEqual(sortChapters({}), []);
  assert.deepEqual(sortChapters({ chapters: 'nope' }), []);
});

test('sortChapters puts order-less chapters last, stable among themselves', () => {
  const m = { chapters: [
    { id: 'x' }, { id: 'y', order: 5 }, { id: 'z' },
  ] };
  assert.deepEqual(sortChapters(m).map(c => c.id), ['y', 'x', 'z']);
});

test('findChapter / chapterSteps', () => {
  assert.equal(findChapter(MANIFEST, 'a').title, 'A');
  assert.equal(findChapter(MANIFEST, 'missing'), null);
  assert.equal(findChapter(null, 'a'), null);
  assert.equal(chapterSteps(findChapter(MANIFEST, 'a')).length, 2);
  assert.deepEqual(chapterSteps(null), []);
});

test('screenshotUrl builds the static route url', () => {
  assert.equal(screenshotUrl({ screenshotPath: 'a/s1.png' }), '/api/helper/tour-screenshot/a/s1.png');
  assert.equal(screenshotUrl({ screenshotPath: '/a/s1.png' }), '/api/helper/tour-screenshot/a/s1.png');
  assert.equal(screenshotUrl({}), '');
  assert.equal(screenshotUrl(null), '');
});

test('emptyProgress / normalizeProgress', () => {
  assert.deepEqual(emptyProgress(), { completedChapters: [], currentChapter: null, currentStep: 0 });
  assert.deepEqual(normalizeProgress(null), emptyProgress());
  assert.deepEqual(
    normalizeProgress({ completedChapters: ['a', 'a', 7], currentChapter: 'b', currentStep: 3 }),
    { completedChapters: ['a'], currentChapter: 'b', currentStep: 3 },
  );
  // step ignored when no current chapter
  assert.deepEqual(
    normalizeProgress({ currentChapter: null, currentStep: 9 }),
    { completedChapters: [], currentChapter: null, currentStep: 0 },
  );
});

test('parseProgress never throws on corrupt json', () => {
  assert.deepEqual(parseProgress('{not json'), emptyProgress());
  assert.deepEqual(parseProgress(''), emptyProgress());
  assert.deepEqual(parseProgress(undefined), emptyProgress());
  assert.deepEqual(
    parseProgress('{"completedChapters":["a"],"currentChapter":"b","currentStep":1}'),
    { completedChapters: ['a'], currentChapter: 'b', currentStep: 1 },
  );
});

test('serializeProgress round-trips through parseProgress', () => {
  const p = setCurrent(markChapterComplete(emptyProgress(), 'a'), 'b', 2);
  assert.deepEqual(parseProgress(serializeProgress(p)), p);
});

test('isChapterComplete', () => {
  const p = markChapterComplete(emptyProgress(), 'a');
  assert.equal(isChapterComplete(p, 'a'), true);
  assert.equal(isChapterComplete(p, 'b'), false);
});

test('setCurrent records chapter + step immutably', () => {
  const base = emptyProgress();
  const p = setCurrent(base, 'b', 1);
  assert.deepEqual(p, { completedChapters: [], currentChapter: 'b', currentStep: 1 });
  assert.equal(base.currentChapter, null); // untouched
  // negative/NaN step floored to 0
  assert.equal(setCurrent(base, 'b', -5).currentStep, 0);
});

test('markChapterComplete adds once and clears the pointer', () => {
  let p = setCurrent(emptyProgress(), 'a', 1);
  p = markChapterComplete(p, 'a');
  assert.deepEqual(p.completedChapters, ['a']);
  assert.equal(p.currentChapter, null);
  assert.equal(p.currentStep, 0);
  // idempotent
  assert.deepEqual(markChapterComplete(p, 'a').completedChapters, ['a']);
});

test('clearCurrent keeps completion but drops the pointer', () => {
  let p = markChapterComplete(emptyProgress(), 'a');
  p = setCurrent(p, 'b', 2);
  const cleared = clearCurrent(p);
  assert.deepEqual(cleared.completedChapters, ['a']);
  assert.equal(cleared.currentChapter, null);
});

test('resumePoint only when a valid saved chapter exists', () => {
  assert.equal(resumePoint(emptyProgress(), MANIFEST), null);
  // saved chapter no longer in manifest
  assert.equal(resumePoint(setCurrent(emptyProgress(), 'gone', 0), MANIFEST), null);
  // saved chapter with no steps
  assert.equal(resumePoint(setCurrent(emptyProgress(), 'c', 0), MANIFEST), null);
  // valid, and an out-of-range step is clamped
  assert.deepEqual(resumePoint(setCurrent(emptyProgress(), 'a', 9), MANIFEST), { chapterId: 'a', step: 1 });
});

test('clampStep bounds the index', () => {
  const a = findChapter(MANIFEST, 'a');
  assert.equal(clampStep(a, -1), 0);
  assert.equal(clampStep(a, 0), 0);
  assert.equal(clampStep(a, 5), 1);
  assert.equal(clampStep(findChapter(MANIFEST, 'c'), 3), 0); // no steps
});

test('isLastStep', () => {
  const a = findChapter(MANIFEST, 'a');
  assert.equal(isLastStep(a, 0), false);
  assert.equal(isLastStep(a, 1), true);
  assert.equal(isLastStep(findChapter(MANIFEST, 'c'), 0), false); // no steps
});
