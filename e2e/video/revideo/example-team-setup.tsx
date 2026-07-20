// Team Setup chapter — screenshots-per-step, held to the narration.
// Thin wrapper over the shared builder (revideo/walkthrough.tsx); T5 (#745)
// generates the same beat list from journey artifacts + `voiceover:` fields.
//
// The Process step is two beats: the entry choice, then Core SDLC *selected* with
// its live flow preview — so the narration "we pick Core SDLC" matches the screen.
//
// Render: npm run render:team-setup   (renders silent, then muxes the voiceover).

import { makeWalkthroughProject } from './walkthrough';

const BEATS = [
  { audioId: 'ts-intro', img: null, eyebrow: 'Team Setup', caption: 'Stand up a whole team of agents — bound to one repository, in five guided steps.' },
  { audioId: 'ts-process', img: '/shots/02-process.png', eyebrow: 'Step 1 · Process', caption: 'Three ways to start — we use a ready-made process template.' },
  { audioId: 'ts-process-sdlc', img: '/shots/02b-core-sdlc.png', eyebrow: 'Step 1 · Core SDLC selected', caption: 'Core SDLC: four agents in a build-and-review loop — the live preview confirms the wiring.' },
  { audioId: 'ts-env', img: '/shots/03-working-env.png', eyebrow: 'Step 2 · Working Environment', caption: 'Where the team operates: repository, branch and credentials in one reusable template.' },
  { audioId: 'ts-team', img: '/shots/04-team.png', eyebrow: 'Step 3 · Team', caption: "The team's identity — a name and an ID that prefixes every agent it creates." },
  { audioId: 'ts-knowledge', img: '/shots/05-knowledge.png', eyebrow: 'Step 4 · Knowledge (optional)', caption: 'What the team knows and how it learns — skills, sources, and sharing.' },
  { audioId: 'ts-review', img: '/shots/06-review.png', eyebrow: 'Step 5 · Review', caption: 'One atomic transaction creates the whole team — each member a real chat agent.' },
];

export default makeWalkthroughProject('team-setup', BEATS);
