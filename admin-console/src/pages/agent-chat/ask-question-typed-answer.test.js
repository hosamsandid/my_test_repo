import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  advanceAskProgress, consolidateAskAnswers, buildTypedAnswer, buildMultiAnswerContent,
  multiAnswerText, activeMultiQuestionCard, composerAnswersCard, askComposerPlaceholder,
  answerForQuestion, answerChoosesOption, indexAskAnswers, questionState,
  ASK_QUESTION_FIELD, ASK_ANSWER_FIELD, EMPTY_ASK_PROGRESS,
} from './ask-question-view.js';

// A free-text reply answers the open question of a multi-question card
// (#2821). The step logic is pure and covered here; the JSX wiring is pinned
// by source-level drift guards at the bottom (#651).

const QUESTIONS = [
  { questionId: 'q0', header: 'Branch', options: [{ optionId: '0:0', label: 'main' }, { optionId: '0:1', label: 'dev' }] },
  { questionId: 'q1', header: 'Tests', multiSelect: true, options: [{ optionId: '1:0', label: 'unit' }, { optionId: '1:1', label: 'e2e' }] },
  { questionId: 'q2', header: 'Notes', options: [{ optionId: '2:0', label: 'none' }] },
];

const typed = (qi, text) => buildTypedAnswer(QUESTIONS[qi], text);

test('buildTypedAnswer marks the text as a custom answer; blank text is no answer', () => {
  assert.deepEqual(typed(0, '  release/1.2 \n'), { questionId: 'q0', custom: true, text: 'release/1.2', label: 'release/1.2' });
  assert.equal(typed(0, '   '), null);
  assert.equal(typed(0, ''), null);
});

test('typed answer on the first question advances to the next without an answer to send (AC1/AC2)', () => {
  const r = advanceAskProgress(undefined, QUESTIONS, 0, typed(0, 'feature-x'));
  assert.equal(r.answers, null);
  assert.equal(r.progress.openIdx, 1);
  assert.equal(r.progress.answers.q0.text, 'feature-x');
});

test('typed answer on a middle question keeps the earlier clicked answer (AC2)', () => {
  let r = advanceAskProgress(EMPTY_ASK_PROGRESS, QUESTIONS, 0, QUESTIONS[0].options[1]);
  r = advanceAskProgress(r.progress, QUESTIONS, 1, typed(1, 'smoke only'));
  assert.equal(r.answers, null);
  assert.equal(r.progress.openIdx, 2);
  assert.equal(r.progress.answers.q0.optionId, '0:1');
  assert.equal(r.progress.answers.q1.custom, true);
});

test('typed answer on the last question completes the card with every answer (AC3)', () => {
  let r = advanceAskProgress(null, QUESTIONS, 0, typed(0, 'feature-x'));
  r = advanceAskProgress(r.progress, QUESTIONS, 1,
    { questionId: 'q1', optionIds: ['1:0', '1:1'], labels: ['unit', 'e2e'], label: 'unit, e2e' });
  r = advanceAskProgress(r.progress, QUESTIONS, 2, typed(2, 'ship it'));
  assert.deepEqual(r.answers, [
    { questionId: 'q0', custom: true, text: 'feature-x', label: 'feature-x', header: 'Branch' },
    { questionId: 'q1', optionIds: ['1:0', '1:1'], labels: ['unit', 'e2e'], label: 'unit, e2e', header: 'Tests' },
    { questionId: 'q2', custom: true, text: 'ship it', label: 'ship it', header: 'Notes' },
  ]);
  // The progress stays on the last step, so a failed send can be retried.
  assert.equal(r.progress.openIdx, 2);
});

test('a value for a step other than the open one is ignored', () => {
  const r = advanceAskProgress({ openIdx: 1, answers: {} }, QUESTIONS, 0, typed(0, 'late'));
  assert.deepEqual(r.progress, { openIdx: 1, answers: {} });
  assert.equal(r.answers, null);
});

test('mix of clicked and typed answers: clicked options stay chosen, typed ones choose none (AC5)', () => {
  const answers = consolidateAskAnswers(QUESTIONS, {
    q0: QUESTIONS[0].options[0],
    q1: typed(1, 'just lint'),
  }, { skipRemaining: true });
  assert.equal(answerChoosesOption({ answers }, 'q0', '0:0'), true);
  assert.equal(answerChoosesOption({ answers }, 'q1', '1:0'), false);
  assert.equal(answerChoosesOption({ answers }, 'q1', '1:1'), false);
  assert.equal(answerForQuestion(answers, 'q1').text, 'just lint');
});

test('multi-line typed answer is indented under its numbered header (AC6)', () => {
  const answers = consolidateAskAnswers(QUESTIONS, {
    q0: QUESTIONS[0].options[0],
    q1: typed(1, 'first line\n2. Notes: looks like a header'),
    q2: QUESTIONS[2].options[0],
  });
  assert.equal(multiAnswerText(answers),
    '1. Branch: main\n' +
    '2. Tests:\n   first line\n   2. Notes: looks like a header\n' +
    '3. Notes: none');
  // Every answer starts a line at column 0; continuation lines never do.
  const starts = multiAnswerText(answers).split('\n').filter(l => !l.startsWith(' '));
  assert.equal(starts.length, 3);
});

test('skip remaining sends the answers so far and marks the rest skipped (AC8)', () => {
  const answers = consolidateAskAnswers(QUESTIONS, { q0: typed(0, 'hotfix') }, { skipRemaining: true });
  assert.deepEqual(answers.map(a => a.skipped === true), [false, true, true]);
  assert.equal(multiAnswerText(answers), '1. Branch: hotfix\n2. Tests: (skipped)\n3. Notes: (skipped)');
  assert.equal(answerForQuestion(answers, 'q2').skipped, true);
});

test('reload of an answered card with typed answers restores them from the answer record (AC7)', () => {
  const answers = consolidateAskAnswers(QUESTIONS, {
    q0: typed(0, 'feature-x'), q1: QUESTIONS[1].options[0], q2: typed(2, 'a\nb'),
  });
  const content = buildMultiAnswerContent('$card', answers);
  // The canonical event round-trips as plain JSON.
  const reloaded = JSON.parse(JSON.stringify({ event_id: '$reply', ...content }));
  const index = indexAskAnswers([{ event_id: '$card' }, reloaded]);
  const st = questionState({ index: 0, messageCount: 2, answer: index.get('$card') });
  assert.equal(st.answerable, false);
  assert.equal(st.superseded, false);
  assert.deepEqual(answerForQuestion(st.multiAnswers, 'q0'),
    { questionId: 'q0', custom: true, text: 'feature-x', label: 'feature-x', header: 'Branch' });
  assert.equal(answerForQuestion(st.multiAnswers, 'q2').text, 'a\nb');
  assert.equal(answerChoosesOption({ answers: st.multiAnswers }, 'q1', '1:0'), true);
  assert.equal(answerChoosesOption({ answers: st.multiAnswers }, 'q0', '0:0'), false);
});

test('a card superseded by an agent message is marked superseded, not answered (AC9)', () => {
  const st = questionState({ index: 0, messageCount: 2, answer: undefined });
  assert.equal(st.superseded, true);
  assert.equal(st.answerable, false);
  // A merely disabled newest card keeps its step view.
  const disabled = questionState({ index: 0, messageCount: 1, answer: undefined, disabled: true });
  assert.equal(disabled.superseded, false);
});

const card = (event_id, questions) => ({ event_id, [ASK_QUESTION_FIELD]: { questions } });

test('activeMultiQuestionCard: only the newest unanswered card of 2+ questions', () => {
  const multi = card('$c', QUESTIONS);
  assert.equal(activeMultiQuestionCard([multi], new Map()).eventId, '$c');
  assert.equal(activeMultiQuestionCard([multi], new Map()).question.questions.length, 3);
  // superseded by a later message
  assert.equal(activeMultiQuestionCard([multi, { event_id: '$x', body: 'hi' }], new Map()), null);
  // already answered
  assert.equal(activeMultiQuestionCard([multi], new Map([['$c', {}]])), null);
  // single question: out of scope, a typed reply stays a normal message
  assert.equal(activeMultiQuestionCard([card('$s', [QUESTIONS[0]])], new Map()), null);
  assert.equal(activeMultiQuestionCard([], new Map()), null);
});

test('composerAnswersCard: plain text only; attachments and dictation supersede', () => {
  assert.equal(composerAnswersCard({ text: 'main' }), true);
  assert.equal(composerAnswersCard({ text: '   ' }), false);
  assert.equal(composerAnswersCard({ text: 'see @chat-uploads/log.txt' }), false);
  assert.equal(composerAnswersCard({ text: 'pic', hasAttachments: true }), false);
  assert.equal(composerAnswersCard({ text: 'spoken', dictated: true }), false);
});

test('askComposerPlaceholder names the open question (AC4)', () => {
  assert.equal(askComposerPlaceholder(1, 5), 'Answer question 2 of 5…');
});

// ── Wiring drift guards (#651: JSX is not executed under node:test) ──────

const HERE = dirname(fileURLToPath(import.meta.url));
const src = (f) => readFileSync(join(HERE, f), 'utf8');

test('the composer routes plain text to the card and shows the card placeholder', () => {
  const input = src('MessageInput.jsx');
  assert.match(input, /composerAnswersCard\(\{\s*text, hasAttachments: attachments\.length > 0, dictated: dictatedRef\.current,/);
  assert.match(input, /toCard \? onAnswerCard\(text\) : onSend\(text\)/);
  assert.match(input, /askPlaceholder\s*\?\s*`\$\{askPlaceholder\}/);
  assert.match(input, /dictatedRef\.current = true;/);
});

test('ChatPanel answers the open question of the active card with the typed text', () => {
  const panel = src('ChatPanel.jsx');
  assert.match(panel, /activeMultiQuestionCard\(messages, askAnswersByQuestion\)/);
  assert.match(panel, /onAnswerCard=\{activeAsk \? handleTypedAnswer : null\}/);
  assert.match(panel, /buildTypedAnswer\(q, text\)/);
  assert.match(panel, /\{ isStep: true, questionIndex: activeAskOpenIdx, value \}/);
  // Steps and skip go through the pure helpers; one consolidated send.
  assert.match(panel, /advanceAskProgress\(\s*askProgress\[questionEventId\]/);
  assert.match(panel, /consolidateAskAnswers\(questions, progress\.answers, \{ skipRemaining: true \}\)/);
  assert.match(panel, /handleSend\(multiAnswerText\(answers\), buildMultiAnswerContent\(questionEventId, answers\)\)/);
  assert.match(panel, /questionProgress=\{isQuestion \? askProgress\[msg\.event_id\] : undefined\}/);
});

test('the card reports steps upward and renders typed / skipped / superseded state', () => {
  const c = src('AskQuestionCard.jsx');
  assert.match(c, /onAnswer\?\.\(\{ isStep: true, questionIndex: qi, value \}\)/);
  assert.match(c, /onAnswer\?\.\(\{ isSkipRemaining: true \}\)/);
  assert.match(c, /Skip remaining questions/);
  assert.match(c, /allQuestions\.slice\(0, openIdx \+ 1\)/);
  assert.match(c, /ownAnswer\?\.custom &&/);
  assert.match(c, /ownAnswer\?\.skipped &&/);
  assert.match(src('Message.jsx'), /superseded=\{!!questionAnswer\?\.superseded\}/);
});
