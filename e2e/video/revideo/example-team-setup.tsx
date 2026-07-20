// DEMONSTRATOR — screenshots-per-step, held to the narration length.
//
// Corrects the pacing problem of the continuous-clip spike: one screenshot per
// journey step, shown for exactly as long as its voiceover lasts (audio-driven), a
// gentle Ken-Burns zoom so it isn't dead-static, an eyebrow and a short caption,
// with cross-fades. Team Setup = 7 beats ≈ 90s (60-90s target), self-explanatory.
//
// This is the shape T5 (#745) generates from journey artifacts: the step screenshot
// (already captured by the screenshot run — no clip, no transcode, no cut-marks) +
// the step's `voiceover:` MP3. Assets are served from public/ (shots/ + audio/).
//
// AUDIO is NOT played by Revideo here — the scene renders SILENT and the voiceover
// is muxed on afterwards by scripts/mux-narration.mjs. Revideo mixes every <Audio>
// node toward the scene end, so multiple beats' voiceovers accumulate and clip (the
// loudness grew monotonically to 0 dBFS by the review beat). Instead each beat's
// on-screen dwell is still driven by the audio DURATION (`audioSec`), and the mux
// step lays each MP3 at its exact beat offset with a limiter — deterministic, no
// summing. The offset model in the mux script mirrors the beat timing below
// (FADE_IN 0.5 + hold dur+PAD + FADE_OUT 0.45 ⇒ +1.35s per beat).
//
// Render: npm run render:team-setup   (needs Chromium + ffmpeg; see README)

import { Img, Layout, Rect, Txt, makeScene2D } from '@revideo/2d';
import { createRef, waitFor, all, easeInOutCubic, easeOutCubic } from '@revideo/core';
import { makeProject } from '@revideo/core';
import { audioSec } from './utils/audio';

const BG = '#0B1021';
const FG = '#EDEFFA';
const ACCENT = '#93A6FF';

// One beat per journey step. `img` null = a title/concept card. The Process step is
// two beats: the entry choice, then Core SDLC *selected* with its flow preview — so
// the narration "we pick Core SDLC" matches what's on screen (#754 follow-up).
const BEATS = [
  { audioId: 'ts-intro', img: null, eyebrow: 'Team Setup', caption: 'Stand up a whole team of agents — bound to one repository, in five guided steps.' },
  { audioId: 'ts-process', img: '/shots/02-process.png', eyebrow: 'Step 1 · Process', caption: 'Three ways to start — we use a ready-made process template.' },
  { audioId: 'ts-process-sdlc', img: '/shots/02b-core-sdlc.png', eyebrow: 'Step 1 · Core SDLC selected', caption: 'Core SDLC: four agents in a build-and-review loop — the live preview confirms the wiring.' },
  { audioId: 'ts-env', img: '/shots/03-working-env.png', eyebrow: 'Step 2 · Working Environment', caption: 'Where the team operates: repository, branch and credentials in one reusable template.' },
  { audioId: 'ts-team', img: '/shots/04-team.png', eyebrow: 'Step 3 · Team', caption: "The team's identity — a name and an ID that prefixes every agent it creates." },
  { audioId: 'ts-knowledge', img: '/shots/05-knowledge.png', eyebrow: 'Step 4 · Knowledge (optional)', caption: 'What the team knows and how it learns — skills, sources, and sharing.' },
  { audioId: 'ts-review', img: '/shots/06-review.png', eyebrow: 'Step 5 · Review', caption: 'One atomic transaction creates the whole team — each member a real chat agent.' },
];

const PAD = 0.4; // trailing silence per beat so the voiceover tail isn't clipped

const scene = makeScene2D('team-setup', function* (view) {
  view.add(<Rect width={'100%'} height={'100%'} fill={BG} />);

  for (const beat of BEATS) {
    const dur = audioSec(beat.audioId);
    const group = createRef<Layout>();
    const shot = createRef<Img>();

    view.add(
      <Layout ref={group} opacity={0}>
        {/* Silent render — the voiceover is muxed on afterwards (see header). */}
        {beat.img && (
          <Img ref={shot} src={beat.img} y={-70} width={1360} radius={10} stroke={'#26304f'} lineWidth={2} />
        )}
        <Txt
          text={beat.eyebrow}
          fontFamily={'DejaVu Sans, Arial, sans-serif'}
          fontSize={beat.img ? 30 : 84}
          fontWeight={700}
          fill={beat.img ? ACCENT : FG}
          y={beat.img ? -520 : -60}
        />
        <Txt
          text={beat.caption}
          fontFamily={'DejaVu Sans, Arial, sans-serif'}
          fontSize={beat.img ? 34 : 40}
          fill={FG}
          width={1500}
          textAlign={'center'}
          textWrap
          y={beat.img ? 445 : 70}
        />
      </Layout>,
    );

    // Fade the beat in, then hold for the full narration with a slow Ken-Burns zoom.
    yield* group().opacity(1, 0.5, easeOutCubic);
    if (beat.img) {
      yield* all(shot().scale(1.045, dur + PAD, easeInOutCubic), waitFor(dur + PAD));
    } else {
      yield* waitFor(dur + PAD);
    }
    yield* group().opacity(0, 0.45, easeInOutCubic);
    group().remove(); // removes the beat's <Audio> too — no cross-beat audio summing
  }
});

export default makeProject({
  scenes: [scene],
  settings: { shared: { size: { x: 1920, y: 1080 } } },
});
