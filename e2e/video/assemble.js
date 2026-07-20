// Journey → video assembly PLAN builder (docs/journey-spec-concept.md §3.3, #712).
//
// The video lane is the third target that reads the SAME journey source as the
// docs (#707) and deck (#708). It is split like those targets:
//
//   assemble.js (this file) — PURE. Journeys + a video index in, an ordered plan
//     of segments out. No filesystem, no child_process, no ffmpeg, no date/git
//     access — so the same inputs always describe the same video and the plan
//     (chapter ordering + title-card text) is unit-testable without ffmpeg, which
//     the issue explicitly asks for ("assembly-script logic … unit-testable
//     without ffmpeg where possible").
//   render.js — PURE ffmpeg command builders (arg arrays) for the three ffmpeg
//     invocations the plan needs (title card, clip normalise, concat). Also
//     testable without running ffmpeg.
//   video.js — the fs + child_process orchestrator (discovers the webms a green
//     `journey-video` run left in the artifacts tree, checks ffmpeg is present,
//     renders each segment, concats them, writes the walkthrough .webm). Mirrors
//     the deck.js ↔ pptx.js / index.js ↔ render.js split.
//
// What the plan encodes (concept §3.3 item 2, "concat chapters, title cards from
// title / narrative-only steps"):
//   - one CHAPTER title card per journey, from the journey `title`;
//   - one NARRATIVE title card per `narrative-only` step, captioned from the step
//     prose (the first sentence — the full narrative is TTS material, parked in
//     item 3);
//   - the journey's continuous screen recording (`<journeyId>/journey.webm`),
//     captured by the `journey-video` Playwright project in the same run that
//     produced the screenshots.
// Cards for a journey are grouped ahead of its clip: the single continuous webm
// can't be split at each narrative beat without re-cutting, so the framing prose
// leads into the walkthrough clip. This is deliberate and documented so the plan
// stays a pure function of the ordered journeys.
'use strict';

// Deck/doc use the same product name; the video carries it on the opening card.
const VIDEO_TITLE = 'Agent Studio — Walkthrough';

// Matches the `journey-video` Playwright project viewport (playwright.config.js)
// so title cards and clips share one canvas and concat without re-scaling loss.
const RESOLUTION = { width: 1440, height: 900 };

// Output name (a build artifact — CI-uploaded, human-watched, never committed;
// see .gitignore `/artifacts/*.webm`).
const OUTPUT_NAME = 'agent-studio-walkthrough.webm';

// Title-card duration bounds (seconds). A card dwells long enough to read but
// never stalls the video; the actual duration scales with the caption length.
const MIN_CARD_SECONDS = 2.5;
const MAX_CARD_SECONDS = 7;
const WORDS_PER_SECOND = 2.6; // comfortable silent-reading pace

// Collapse runs of whitespace (incl. newlines) to single spaces and trim.
function collapseWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

// Caption for a narrative title card: the first sentence of the prose, so the
// card is a short section marker rather than a wall of text (the full narrative
// is the TTS/notes source, parked per §3.3 item 3). Falls back to a hard
// character cap when no sentence break is found.
function cardCaption(narrative, { maxChars = 140 } = {}) {
  const flat = collapseWhitespace(narrative);
  if (!flat) return '';
  const m = flat.match(/^(.+?[.!?])(\s|$)/);
  let caption = m ? m[1] : flat;
  if (caption.length > maxChars) caption = `${caption.slice(0, maxChars - 1).trimEnd()}…`;
  return caption;
}

// Reading time for a card, clamped to the duration bounds. Pure function of the
// text so a card's length is deterministic.
function readingSeconds(text) {
  const words = collapseWhitespace(text).split(' ').filter(Boolean).length;
  const raw = words / WORDS_PER_SECOND;
  const clamped = Math.min(MAX_CARD_SECONDS, Math.max(MIN_CARD_SECONDS, raw));
  // One decimal place keeps the plan stable and the ffmpeg duration tidy.
  return Math.round(clamped * 10) / 10;
}

// Word-wrap into lines no longer than maxChars, for a centred multi-line card.
// A single word longer than the limit becomes its own (over-long) line rather
// than being split mid-word.
function wrapText(text, maxChars = 34) {
  const words = collapseWhitespace(text).split(' ').filter(Boolean);
  const lines = [];
  let line = '';
  for (const word of words) {
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= maxChars) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

// Build the ordered video plan. `videoIndex` maps journeyId → the clip's path
// relative to the artifacts dir (e.g. `team-setup/journey.webm`); a journey
// absent from it has no captured clip (its cards still render, so the plan
// degrades gracefully exactly as docgen/deck degrade to text). Journeys are
// assumed already sorted (the loader sorts by `order` then id).
function buildVideoPlan(journeys, videoIndex = {}) {
  const segments = [];
  const chapters = [];
  const missingVideo = [];

  for (const journey of journeys) {
    const src = videoIndex[journey.id] || null;
    const hasVideo = Boolean(src);
    if (!hasVideo) missingVideo.push(journey.id);
    chapters.push({ journeyId: journey.id, title: journey.title, hasVideo });

    // Chapter title card — from the journey title.
    const chapterText = journey.title;
    segments.push({
      type: 'title',
      role: 'chapter',
      journeyId: journey.id,
      text: chapterText,
      lines: wrapText(chapterText, 28),
      seconds: readingSeconds(chapterText),
    });

    // Narrative title cards — one per narrative-only step, captioned.
    for (const step of journey.steps || []) {
      if (step.kind !== 'narrative-only') continue;
      const caption = cardCaption(step.narrative);
      if (!caption) continue;
      segments.push({
        type: 'title',
        role: 'narrative',
        journeyId: journey.id,
        stepId: step.id || null,
        text: caption,
        lines: wrapText(caption, 40),
        seconds: readingSeconds(caption),
      });
    }

    // The continuous walkthrough clip for the journey, when a run captured it.
    if (hasVideo) {
      segments.push({ type: 'clip', journeyId: journey.id, src });
    }
  }

  return {
    title: VIDEO_TITLE,
    resolution: RESOLUTION,
    output: OUTPUT_NAME,
    journeyCount: journeys.length,
    chapters,
    segments,
    missingVideo,
  };
}

module.exports = {
  buildVideoPlan,
  cardCaption,
  readingSeconds,
  wrapText,
  collapseWhitespace,
  VIDEO_TITLE,
  RESOLUTION,
  OUTPUT_NAME,
  MIN_CARD_SECONDS,
  MAX_CARD_SECONDS,
};
