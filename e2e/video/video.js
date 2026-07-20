// Video assembly — filesystem + ffmpeg orchestration (#712, docs/journey-spec-
// concept.md §3.3 item 2).
//
// The fs/child_process-facing sibling of the pure assemble.js/render.js, mirroring
// how deck.js wires pptx.js: build the plan from the journeys + the clips a green
// `journey-video` run left under the artifacts tree, then (when ffmpeg is present)
// render every title card and normalise every clip into a temp workdir and concat
// them into `artifacts/agent-studio-walkthrough.webm`.
//
// ffmpeg is NOT assumed locally — agent containers usually lack it, and the issue
// says so explicitly. `computeVideoBuild()` produces the whole plan (chapter
// ordering, per-card text, ffmpeg arg arrays) with pure Node and no ffmpeg, so the
// logic is inspectable/testable everywhere; `assembleVideo()` is the step that
// actually needs the binary and fails with a clear, actionable message when it is
// missing. The real .webm therefore comes from the CI job (ffmpeg via apt-get) or
// a human with ffmpeg installed (`make video-journeys`).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, spawnSync } = require('child_process');

const { loadJourneysDir, JOURNEYS_DIR } = require('../journey-runner/loader');
const { buildVideoPlan } = require('./assemble');
const { buildTitleCardArgs, buildNormalizeArgs, buildConcatArgs, concatListLine } = require('./render');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_ARTIFACTS = path.resolve(__dirname, '..', 'artifacts');
const DEFAULT_OUT = path.resolve(REPO_ROOT, 'artifacts', 'agent-studio-walkthrough.webm');
// The per-journey clip name the `journey-video` project saves (journeys.spec.js).
const CLIP_NAME = 'journey.webm';

// Font candidates for drawtext, in preference order. The CI job installs
// fonts-dejavu-core; when none is found we return null and drawtext falls back to
// the fontconfig default rather than failing.
const FONT_CANDIDATES = [
  '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/dejavu/DejaVuSans.ttf',
  '/usr/share/fonts/TTF/DejaVuSans.ttf',
];

function findFont() {
  return FONT_CANDIDATES.find((f) => fs.existsSync(f)) || null;
}

// True when an `ffmpeg` binary is on PATH and runnable.
function ffmpegAvailable() {
  try {
    execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

// Scan the artifacts tree for each journey's captured clip, returning a
// { journeyId → '<journeyId>/journey.webm' } index of the clips that exist.
function scanVideoIndex(artifactsDir, journeys) {
  const index = {};
  for (const journey of journeys) {
    const rel = path.join(journey.id, CLIP_NAME);
    if (fs.existsSync(path.join(artifactsDir, rel))) index[journey.id] = rel;
  }
  return index;
}

// Build the full, ffmpeg-free build description: the ordered plan plus the exact
// ffmpeg arg arrays and intermediate filenames each segment will use. This is the
// unit-testable core and what `--plan` prints; assembleVideo() just executes it.
function computeVideoBuild(opts = {}) {
  const journeysDir = opts.journeysDir || JOURNEYS_DIR;
  const artifactsDir = opts.artifactsDir || process.env.E2E_ARTIFACTS_DIR || DEFAULT_ARTIFACTS;
  const fontFile = opts.fontFile !== undefined ? opts.fontFile : findFont();

  const journeys = loadJourneysDir(journeysDir);
  const videoIndex = scanVideoIndex(artifactsDir, journeys);
  const plan = buildVideoPlan(journeys, videoIndex);

  // Assign a deterministic intermediate filename per segment (zero-padded index
  // preserves order in the concat list) and precompute its ffmpeg command.
  const steps = plan.segments.map((seg, i) => {
    const idx = String(i).padStart(3, '0');
    if (seg.type === 'title') {
      const inter = `seg-${idx}-${seg.role}.webm`;
      const textFile = `seg-${idx}.txt`;
      return {
        kind: 'title',
        segment: seg,
        intermediate: inter,
        textFile,
        text: seg.lines.join('\n'),
        args: buildTitleCardArgs({
          outPath: inter,
          textFile,
          seconds: seg.seconds,
          resolution: plan.resolution,
          fontFile,
        }),
      };
    }
    const inter = `seg-${idx}-clip.webm`;
    return {
      kind: 'clip',
      segment: seg,
      intermediate: inter,
      source: seg.src,
      args: buildNormalizeArgs({
        inPath: seg.src,
        outPath: inter,
        resolution: plan.resolution,
      }),
    };
  });

  return { plan, artifactsDir, fontFile, steps };
}

// Run ffmpeg with the given args in `cwd`, throwing a readable error on failure.
function runFfmpeg(args, cwd) {
  const res = spawnSync('ffmpeg', args, { cwd, encoding: 'utf8' });
  if (res.status !== 0) {
    const tail = (res.stderr || '').split('\n').slice(-12).join('\n');
    throw new Error(`ffmpeg failed (exit ${res.status})\n  args: ${args.join(' ')}\n${tail}`);
  }
}

// Assemble the walkthrough video. Requires ffmpeg. Renders each title card and
// normalises each clip into `workDir`, writes the concat list, concats to
// `outFile`. Returns a summary the CLI logs.
function assembleVideo(opts = {}) {
  const build = computeVideoBuild(opts);
  const { plan, artifactsDir, steps } = build;
  const outFile = opts.outFile || DEFAULT_OUT;
  const workDir = opts.workDir || path.join(artifactsDir, '.video-work');

  if (!ffmpegAvailable()) {
    throw new Error(
      'ffmpeg not found on PATH — the video assembly needs it.\n' +
        '  • CI installs it (apt-get) in the e2e job.\n' +
        '  • Locally: install ffmpeg, or run `node video/bin/video.js --plan` to inspect the build without it.',
    );
  }
  if (steps.length === 0) {
    throw new Error('no journeys found — nothing to assemble.');
  }

  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });

  const listLines = [];
  for (const step of steps) {
    if (step.kind === 'title') {
      fs.writeFileSync(path.join(workDir, step.textFile), `${step.text}\n`);
      runFfmpeg(step.args, workDir);
    } else {
      // Clip args reference the source relative to the artifacts dir; run from
      // there so the relative path resolves, writing the intermediate into workDir.
      const absOut = path.join(workDir, step.intermediate);
      const args = buildNormalizeArgs({
        inPath: path.join(artifactsDir, step.source),
        outPath: absOut,
        resolution: plan.resolution,
      });
      runFfmpeg(args, workDir);
    }
    listLines.push(concatListLine(path.join(workDir, step.intermediate)));
  }

  const listPath = path.join(workDir, 'concat.txt');
  fs.writeFileSync(listPath, `${listLines.join('\n')}\n`);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  runFfmpeg(buildConcatArgs({ listPath, outPath: outFile }), workDir);

  const bytes = fs.statSync(outFile).size;
  fs.rmSync(workDir, { recursive: true, force: true });

  return {
    outFile,
    bytes,
    title: plan.title,
    journeyCount: plan.journeyCount,
    segmentCount: plan.segments.length,
    cardCount: plan.segments.filter((s) => s.type === 'title').length,
    clipCount: plan.segments.filter((s) => s.type === 'clip').length,
    missingVideo: plan.missingVideo,
  };
}

module.exports = {
  computeVideoBuild,
  assembleVideo,
  ffmpegAvailable,
  scanVideoIndex,
  findFont,
  REPO_ROOT,
  DEFAULT_ARTIFACTS,
  DEFAULT_OUT,
  CLIP_NAME,
};
