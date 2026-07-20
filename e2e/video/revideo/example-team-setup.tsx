// DEMONSTRATOR — screenshots-per-step, held to the narration length.
//
// Corrects the pacing problem of the continuous-clip spike: one screenshot per
// journey step, shown for exactly as long as its voiceover lasts (audio-driven via
// `playAndWait`), with a gentle Ken-Burns zoom so it isn't dead-static, a caption,
// and cross-fades. Team Setup = 6 beats ≈ 75-85s (60-90s target), self-explanatory.
//
// This is the shape T5 (#745) generates from journey artifacts: the step screenshot
// (already captured by the screenshot run — no clip, no transcode, no cut-marks) +
// the step's `voiceover:` MP3. Assets are served from public/ (shots/ + audio/).
//
// Render: npm run render:team-setup   (needs Chromium + ffmpeg; see README)

import { Audio, Img, Layout, Rect, Txt, makeScene2D } from '@revideo/2d';
import { createRef, waitFor, all, easeInOutCubic, easeOutCubic } from '@revideo/core';
import { makeProject } from '@revideo/core';
import { audioSec, audioUrl } from './utils/audio';

const BG = '#0B1021';
const FG = '#EDEFFA';
const ACCENT = '#93A6FF';

// One beat per journey step. `img` null = a title/concept card.
const BEATS = [
  { audioId: 'ts-intro', img: null, eyebrow: 'Team Setup', caption: 'Stand up a whole team of agents — bound to one repository, in five guided steps.' },
  { audioId: 'ts-process', img: '/shots/02-process.png', eyebrow: 'Step 1 · Process', caption: 'Pick the Core SDLC template — four agents covering a full build-and-review loop.' },
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

    // Voiceover for the beat.
    view.add(<Audio src={audioUrl(beat.audioId)} play={true} time={0} />);

    // Fade the beat in, then hold for the full narration with a slow Ken-Burns zoom.
    yield* group().opacity(1, 0.5, easeOutCubic);
    if (beat.img) {
      yield* all(shot().scale(1.045, dur + PAD, easeInOutCubic), waitFor(dur + PAD));
    } else {
      yield* waitFor(dur + PAD);
    }
    yield* group().opacity(0, 0.45, easeInOutCubic);
    group().remove();
  }
});

export default makeProject({
  scenes: [scene],
  settings: { shared: { size: { x: 1920, y: 1080 } } },
});
