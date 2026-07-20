// Pure ffmpeg command builders for the video lane (docs/journey-spec-concept.md
// §3.3, #712).
//
// Each function returns an ffmpeg argument array (string[]) from plain inputs —
// no filesystem, no child_process. That keeps the "title-card generation inputs"
// and the normalise/concat flags unit-testable without ffmpeg installed (the
// issue's constraint: agent containers may have no ffmpeg). video.js resolves the
// real on-disk paths and actually spawns ffmpeg with these args.
//
// Everything is normalised to ONE codec/size/fps (VP9, RESOLUTION, FPS, yuv420p)
// so the final assembly is a stream-copy concat (`-c copy`) with no re-encode —
// the demuxer requires uniform inputs, which is exactly what the normalise pass
// guarantees.
'use strict';

const FPS = 30;
const VCODEC = 'libvpx-vp9';
const PIX_FMT = 'yuv420p';
// Background + text colours for title cards (the deck/console dark canvas).
const CARD_BG = '0x0B1021';
const CARD_FG = 'white';
const CARD_FONT_SIZE = 46;
const CARD_LINE_SPACING = 16;

// Build the drawtext filter for a title card. Text is passed via a `textfile`
// (written by the orchestrator) rather than inline, so colons/commas/quotes in
// the prose never need escaping — the single most fragile part of drawtext.
// `fontFile` is optional; when absent ffmpeg falls back to the fontconfig default.
function drawtextFilter({ textFile, fontFile = null, fontSize = CARD_FONT_SIZE }) {
  const parts = [
    fontFile ? `fontfile=${fontFile}` : null,
    `textfile=${textFile}`,
    `fontcolor=${CARD_FG}`,
    `fontsize=${fontSize}`,
    `line_spacing=${CARD_LINE_SPACING}`,
    'x=(w-text_w)/2',
    'y=(h-text_h)/2',
  ].filter(Boolean);
  return `drawtext=${parts.join(':')}`;
}

// ffmpeg command that renders a solid-colour title card of `seconds` duration
// with centred text, encoded to the common codec/size/fps so it concats with the
// normalised clips.
function buildTitleCardArgs({
  outPath,
  textFile,
  seconds,
  resolution,
  fontFile = null,
  fontSize = CARD_FONT_SIZE,
  fps = FPS,
}) {
  const size = `${resolution.width}x${resolution.height}`;
  return [
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=${CARD_BG}:s=${size}:d=${seconds}:r=${fps}`,
    '-vf', drawtextFilter({ textFile, fontFile, fontSize }),
    '-c:v', VCODEC,
    '-b:v', '1M',
    '-pix_fmt', PIX_FMT,
    '-an',
    outPath,
  ];
}

// ffmpeg command that normalises a captured journey clip to the common
// codec/size/fps: scale to fit, pad to the exact canvas (letterbox), drop audio.
// After this pass every intermediate is byte-compatible for `-c copy` concat.
function buildNormalizeArgs({ inPath, outPath, resolution, fps = FPS }) {
  const { width: w, height: h } = resolution;
  const vf = [
    `scale=${w}:${h}:force_original_aspect_ratio=decrease`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2`,
    `fps=${fps}`,
  ].join(',');
  return [
    '-y',
    '-i', inPath,
    '-vf', vf,
    '-c:v', VCODEC,
    '-b:v', '2M',
    '-pix_fmt', PIX_FMT,
    '-an',
    outPath,
  ];
}

// ffmpeg concat-demuxer command: stitch the normalised intermediates listed in
// `listPath` into the final walkthrough video with no re-encode.
function buildConcatArgs({ listPath, outPath }) {
  return [
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', listPath,
    '-c', 'copy',
    outPath,
  ];
}

// A single line of the concat-demuxer list file. Paths are single-quoted and any
// embedded quote escaped per the demuxer's own quoting rules.
function concatListLine(filePath) {
  return `file '${String(filePath).replace(/'/g, "'\\''")}'`;
}

module.exports = {
  drawtextFilter,
  buildTitleCardArgs,
  buildNormalizeArgs,
  buildConcatArgs,
  concatListLine,
  FPS,
  VCODEC,
  PIX_FMT,
  CARD_FONT_SIZE,
};
