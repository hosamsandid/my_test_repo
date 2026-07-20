// Unit tests for the pure video assembly plan + ffmpeg command builders (#712).
// No ffmpeg, no filesystem, no browser — the podman/ffmpeg-free logic the issue
// asks to be unit-testable (chapter ordering, title-card generation inputs).
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  buildVideoPlan,
  cardCaption,
  readingSeconds,
  wrapText,
  MIN_CARD_SECONDS,
  MAX_CARD_SECONDS,
  RESOLUTION,
} = require('./assemble');
const {
  buildTitleCardArgs,
  buildNormalizeArgs,
  buildConcatArgs,
  concatListLine,
  drawtextFilter,
} = require('./render');

// Two journeys, already in loader order (order then id).
const JOURNEYS = [
  {
    id: 'team-setup',
    title: 'Team Setup',
    order: 10,
    steps: [
      { kind: 'narrative-only', narrative: 'Let us walk through the Team Setup wizard. It stands up a whole team.' },
      { id: 'process-step', narrative: 'The first step is the Process step.', screenshot: 'process-step' },
      { action: { do: 'wizard.open' } },
    ],
  },
  {
    id: 'agent-templates',
    title: 'Agent Templates',
    order: 20,
    steps: [
      { kind: 'narrative-only', narrative: 'Templates let you reuse a role.' },
    ],
  },
];

test('buildVideoPlan: chapters preserve journey order', () => {
  const plan = buildVideoPlan(JOURNEYS, { 'team-setup': 'team-setup/journey.webm' });
  assert.deepEqual(plan.chapters.map((c) => c.journeyId), ['team-setup', 'agent-templates']);
  assert.equal(plan.title, 'Agent Studio — Walkthrough');
  assert.deepEqual(plan.resolution, RESOLUTION);
});

test('buildVideoPlan: segment sequence — chapter card, narrative cards, then clip', () => {
  const plan = buildVideoPlan(JOURNEYS, { 'team-setup': 'team-setup/journey.webm' });
  const shape = plan.segments.map((s) => (s.type === 'clip' ? `clip:${s.journeyId}` : `${s.role}:${s.journeyId}`));
  assert.deepEqual(shape, [
    'chapter:team-setup',
    'narrative:team-setup',
    'clip:team-setup',
    'chapter:agent-templates',
    'narrative:agent-templates',
  ]);
});

test('buildVideoPlan: journey without a captured clip is reported and produces no clip segment', () => {
  const plan = buildVideoPlan(JOURNEYS, {}); // no videos captured
  assert.deepEqual(plan.missingVideo, ['team-setup', 'agent-templates']);
  assert.equal(plan.segments.filter((s) => s.type === 'clip').length, 0);
  // Cards still render for both journeys.
  assert.equal(plan.segments.filter((s) => s.type === 'title').length, 4);
});

test('buildVideoPlan: chapter card text is the journey title; narrative card is captioned', () => {
  const plan = buildVideoPlan(JOURNEYS, {});
  const chapter = plan.segments.find((s) => s.role === 'chapter' && s.journeyId === 'team-setup');
  assert.equal(chapter.text, 'Team Setup');
  const narrative = plan.segments.find((s) => s.role === 'narrative' && s.journeyId === 'team-setup');
  // First sentence only — the rest is TTS/notes material, parked (§3.3 item 3).
  assert.equal(narrative.text, 'Let us walk through the Team Setup wizard.');
  assert.ok(narrative.stepId === null);
});

test('cardCaption: first sentence, truncates over-long single sentences', () => {
  assert.equal(cardCaption('Short one. Second.'), 'Short one.');
  assert.equal(cardCaption('No terminator here'), 'No terminator here');
  assert.equal(cardCaption('  spaced\n\nout.  text'), 'spaced out.');
  const long = `${'x'.repeat(200)}.`;
  const cap = cardCaption(long, { maxChars: 50 });
  assert.equal(cap.length, 50);
  assert.ok(cap.endsWith('…'));
});

test('readingSeconds: clamped to the duration bounds', () => {
  assert.equal(readingSeconds('one'), MIN_CARD_SECONDS);
  assert.equal(readingSeconds(''), MIN_CARD_SECONDS);
  assert.equal(readingSeconds(`${'word '.repeat(200)}`), MAX_CARD_SECONDS);
  const mid = readingSeconds('word '.repeat(10));
  assert.ok(mid >= MIN_CARD_SECONDS && mid <= MAX_CARD_SECONDS);
});

test('wrapText: wraps on word boundaries within the limit', () => {
  const lines = wrapText('the quick brown fox jumps over', 12);
  for (const l of lines) assert.ok(l.length <= 12 || !l.includes(' '));
  assert.equal(lines.join(' '), 'the quick brown fox jumps over');
});

test('buildTitleCardArgs: lavfi color source with drawtext, common codec/size/fps', () => {
  const args = buildTitleCardArgs({
    outPath: 'card.webm',
    textFile: 'card.txt',
    seconds: 3.5,
    resolution: { width: 1440, height: 900 },
    fontFile: '/f/DejaVuSans.ttf',
  });
  const s = args.join(' ');
  assert.match(s, /color=c=0x0B1021:s=1440x900:d=3\.5:r=30/);
  assert.match(s, /drawtext=/);
  assert.match(s, /textfile=card\.txt/);
  assert.match(s, /fontfile=\/f\/DejaVuSans\.ttf/);
  assert.match(s, /libvpx-vp9/);
  assert.equal(args[args.length - 1], 'card.webm');
});

test('drawtextFilter: omits fontfile when none supplied (fontconfig default)', () => {
  const f = drawtextFilter({ textFile: 't.txt', fontFile: null });
  assert.ok(!f.includes('fontfile='));
  assert.match(f, /textfile=t\.txt/);
  assert.match(f, /x=\(w-text_w\)\/2/);
});

test('buildNormalizeArgs: scale+pad to canvas, drop audio, common codec', () => {
  const args = buildNormalizeArgs({
    inPath: 'in.webm',
    outPath: 'out.webm',
    resolution: { width: 1440, height: 900 },
  });
  const s = args.join(' ');
  assert.match(s, /scale=1440:900:force_original_aspect_ratio=decrease/);
  assert.match(s, /pad=1440:900/);
  assert.match(s, /fps=30/);
  assert.ok(args.includes('-an'));
  assert.match(s, /libvpx-vp9/);
});

test('buildConcatArgs: concat demuxer with stream copy', () => {
  const args = buildConcatArgs({ listPath: 'list.txt', outPath: 'final.webm' });
  const s = args.join(' ');
  assert.match(s, /-f concat/);
  assert.match(s, /-safe 0/);
  assert.match(s, /-c copy/);
  assert.equal(args[args.length - 1], 'final.webm');
});

test('concatListLine: single-quotes the path and escapes embedded quotes', () => {
  assert.equal(concatListLine('a/b.webm'), "file 'a/b.webm'");
  assert.equal(concatListLine("o'clock.webm"), "file 'o'\\''clock.webm'");
});
