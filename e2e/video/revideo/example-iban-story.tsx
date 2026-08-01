// IBAN Story chapter ("Working with Agents") — screenshots-per-step, held to the
// narration. Thin wrapper over the shared builder (revideo/walkthrough.tsx).
//
// The end-to-end story: a vague chat request → the Business Analyst's clarifying
// questions → a filed issue → a human "ready" approval → the Developer's PR → the
// Code Reviewer's verdict → a merge-ready PR. Each hand-off is a GitHub label event.
//
// Render: npm run render:iban-story   (renders silent, then muxes the voiceover).

import { makeWalkthroughProject } from './walkthrough';

const BEATS = [
  { audioId: 'ib-intro', img: null, eyebrow: 'Working with Agents', caption: 'From a one-line idea in chat to a merge-ready pull request — watch the four agents hand work off.' },
  { audioId: 'ib-chat', img: '/shots/iban-08-agent-chat.png', eyebrow: 'The workspace', caption: 'Agent Chat — talk directly to any of the team’s four agents; their workspace is one click away.' },
  { audioId: 'ib-questions', img: '/shots/iban-09-ba-questions.png', eyebrow: 'Clarifying questions', caption: "The Business Analyst doesn't just write a spec — it asks the questions that need a human decision." },
  { audioId: 'ib-answers', img: '/shots/iban-10-user-answers.png', eyebrow: 'Six quick answers', caption: 'I answer point by point — fast, unambiguous input, no requirements document to write.' },
  { audioId: 'ib-issue', img: '/shots/iban-11-issue-created.png', eyebrow: 'Issue #65 filed', caption: 'A two-layer issue: a plain-language summary plus nine testable acceptance criteria.' },
  { audioId: 'ib-ready', img: '/shots/iban-12-ready-label.png', eyebrow: 'Human approval', caption: "Applying the 'ready' label is the human gate — no agent can set it. This approves what gets built." },
  { audioId: 'ib-dev', img: '/shots/iban-13-developer-pr.png', eyebrow: 'Developer wakes', caption: 'The label fired a trigger — the Developer implemented the change, added tests, and opened PR #69.' },
  { audioId: 'ib-review', img: '/shots/iban-14-reviewer.png', eyebrow: 'Code review', caption: 'The PR woke the Code Reviewer — all nine criteria met, tests green, labelled ready-to-merge.' },
  { audioId: 'ib-merge', img: '/shots/iban-15-ready-to-merge.png', eyebrow: 'Merge-ready', caption: 'PR #69 ready to merge, closing issue #65 — hand-off to hand-off, the human in control at the two points that matter.' },
];

export default makeWalkthroughProject('iban-story', BEATS);
