// REFERENCE SCENE — the "Variant C" beat, vendored as the pattern T5 (#745) builds on.
//
// This is intentionally a hand-written example over ONE fixture clip
// (../fixtures/sample-journey.webm), not the generated walkthrough. It exists so
// the Revideo lane has a runnable, self-contained proof of the mechanic before the
// journey-driven generator lands:
//
//   Variant C, per step:
//     1. play the real interaction segment from the Playwright recording, then
//     2. FREEZE on the last frame and hold — for exactly as long as the voiceover
//        lasts. The audio, not slowMo, decides how long the view is shown.
//
// The audio-driven timing is the vendored `playAndWait` primitive (utils/audio.tsx):
// it plays the <Audio> and waits `manifest.durationSec + pad`. A <Video> node plays
// the clip; pausing playback (`.play(false)`) holds the frame.
//
// NOTE (container feasibility): rendering this needs headless Chromium + ffmpeg and
// (for real audio) a prior Edge-TTS run — none of which the agent container has.
// Render in CI or on a workstation:  npm run render:example
// Agent work (T5) is the pure segment/timing/subtitle logic + unit tests; the MP4
// is produced by the manual CI job (T1/#749), never inside the agent container.

import { Audio, Rect, Txt, Video, makeScene2D } from '@revideo/2d';
import { createRef, waitFor, makeProject } from '@revideo/core';
import { audioSec, audioUrl } from './utils/audio';
import { fadeIn, fadeOut } from './utils/transitions';

// Video/audio assets are served from public/ during render (the ffmpeg bridge and
// the audio resolver both map URLs back to files under `<outDir>/../public`). The
// render:example script copies fixtures/*.mp4 into public/ first; the T5 generator
// does the same per-journey clip.
//
// IMPORTANT (spike finding): the embedded clip must be H.264 mp4. Revideo's frame
// extractor fails on VP9 .webm (which is what Playwright records) with a "No input
// specified" ffprobe error — so T5/T3 must transcode each journey.webm → mp4 before
// embedding (ffmpeg -c:v libx264 -pix_fmt yuv420p).
const BEAT = {
  // One demo beat. In the real generator (T5) these come from a journey step:
  //   clip    = the per-journey journey.webm + [start,end] cut-marks (T3/#743)
  //   audioId = the voiceover MP3 id for that step (T4/#744)
  //   subtitle= the step's `voiceover:` text (T4/#744)
  clip: '/sample-journey.mp4',
  segment: { start: 0, end: 3.5 }, // seconds into the clip: the "motion" part
  audioId: 'example-step', // resolved from data/audio-manifest.json; 1s fallback if absent
  subtitle: 'The Team Setup wizard opens on the Process step — the central decision comes first.',
};

const scene = makeScene2D('variant-c-example', function* (view) {
  const video = createRef<Video>();
  const caption = createRef<Txt>();
  const captionBg = createRef<Rect>();

  view.add(<Rect ref={captionBg} width={1280} height={130} y={300} fill={'#0B1021'} opacity={0} />);
  view.add(
    <Video ref={video} src={BEAT.clip} size={[1280, 720]} play={false} time={BEAT.segment.start} />,
  );
  view.add(
    <Txt
      ref={caption}
      text={BEAT.subtitle}
      fontFamily={'DejaVu Sans, Arial, sans-serif'}
      fontSize={30}
      fill={'#EDEFFA'}
      width={1160}
      textAlign={'center'}
      textWrap
      y={300}
      opacity={0}
    />,
  );

  // Subtitle in, then the beat: motion segment plays, then the frame holds for the
  // remainder of the voiceover — total on-screen time == audio length.
  yield* fadeIn([captionBg(), caption()], 0.3);

  const audioDur = audioSec(BEAT.audioId); // real MP3 length (or 1.0s fallback pre-TTS)
  const motion = BEAT.segment.end - BEAT.segment.start;

  view.add(<Audio src={audioUrl(BEAT.audioId)} play={true} time={0} />);

  // 1) motion: play the real interaction from the recording
  video().play(true);
  yield* waitFor(motion);
  // 2) freeze: stop playback and hold the last frame until the voiceover finishes
  video().play(false);
  const hold = Math.max(0.5, audioDur + 0.35 - motion); // conflict rule (motion>audio) lives in T5
  yield* waitFor(hold);

  yield* fadeOut([video(), caption(), captionBg()], 0.35);
});

// `npm run render:example` renders this project via revideo/render.ts.
export default makeProject({
  scenes: [scene],
  settings: { shared: { size: { x: 1280, y: 720 } } },
});
