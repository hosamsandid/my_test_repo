// Shared walkthrough scene builder — screenshots-per-step, held to the narration.
//
// This is the reusable core the per-chapter examples (example-team-setup.tsx,
// example-iban-story.tsx) wrap, and the shape T5 (#745) generates from journey
// artifacts: for each beat, show its screenshot for exactly as long as its voiceover
// lasts (audio-driven via `audioSec`), with a gentle Ken-Burns zoom, an eyebrow and
// a short caption, cross-fading between beats. A beat with `img: null` is a title/
// concept card.
//
// AUDIO is muxed on afterwards (scripts/mux-narration.mjs), not played by Revideo —
// Revideo mixes every <Audio> node toward the scene end, so the beats accumulate and
// clip. The scene renders SILENT; the beat dwell is still audio-driven.
//
// A `beat` is: { audioId, img, eyebrow, caption }. Assets are served from public/.

import { Img, Layout, Rect, Txt, makeScene2D } from '@revideo/2d';
import { createRef, waitFor, all, easeInOutCubic, easeOutCubic } from '@revideo/core';
import { makeProject } from '@revideo/core';
import { audioSec } from './utils/audio';

const BG = '#0B1021';
const FG = '#EDEFFA';
const ACCENT = '#93A6FF';
export const PAD = 0.4; // trailing silence per beat (mirrored in mux-narration.mjs)

export function makeWalkthroughScene(name, beats) {
  return makeScene2D(name, function* (view) {
    view.add(<Rect width={'100%'} height={'100%'} fill={BG} />);

    for (const beat of beats) {
      const dur = audioSec(beat.audioId);
      const group = createRef();
      const shot = createRef();

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
}

export function makeWalkthroughProject(name, beats) {
  return makeProject({
    scenes: [makeWalkthroughScene(name, beats)],
    settings: { shared: { size: { x: 1920, y: 1080 } } },
  });
}
