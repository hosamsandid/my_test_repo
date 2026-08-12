import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_QUESTION_FIELD,
  ASK_ANSWER_FIELD,
  normalizeAskQuestion,
  buildAnswerContent,
  indexAskAnswers,
  questionState,
} from './ask-question-view.js';

test('field names match the runtime contract', () => {
  assert.equal(ASK_QUESTION_FIELD, 'io.aee.ask-question');
  assert.equal(ASK_ANSWER_FIELD, 'io.aee.ask-answer');
});

test('normalizeAskQuestion keeps a well-formed single-choice payload', () => {
  const out = normalizeAskQuestion({
    version: 1,
    questions: [{
      questionId: 'q0',
      header: 'Auth method',
      question: 'Which auth method?',
      options: [
        { optionId: '0:0', label: 'OAuth', description: 'Delegated login' },
        { optionId: '0:1', label: 'API key' },
      ],
    }],
  });
  assert.equal(out.questions.length, 1);
  const q = out.questions[0];
  assert.equal(q.questionId, 'q0');
  assert.equal(q.header, 'Auth method');
  assert.deepEqual(q.options[0], { optionId: '0:0', label: 'OAuth', description: 'Delegated login' });
  assert.deepEqual(q.options[1], { optionId: '0:1', label: 'API key' });
});

test('normalizeAskQuestion synthesises ids and drops malformed options', () => {
  const out = normalizeAskQuestion({
    questions: [{
      question: 'Pick',
      options: [null, 'bad', { description: 'no label' }, { label: '  Good  ' }],
    }],
  });
  assert.equal(out.questions[0].questionId, 'q0');
  assert.equal(out.questions[0].options.length, 1);
  // optionId keeps the raw option index (3) — matches the runtime's enumerate,
  // so ids are stable regardless of how many malformed entries precede it.
  assert.deepEqual(out.questions[0].options[0], { optionId: '0:3', label: 'Good' });
});

test('normalizeAskQuestion returns null for unusable payloads', () => {
  for (const bad of [null, undefined, 42, 'x', {}, { questions: [] }, { questions: 'x' },
    { questions: [{}] }, { questions: [{ options: [] }] },
    { questions: [{ options: [{ description: 'x' }] }] }]) {
    assert.equal(normalizeAskQuestion(bad), null);
  }
});

test('buildAnswerContent carries label + structured id referencing the question', () => {
  const content = buildAnswerContent('$evt:local', { questionId: 'q0', optionId: '0:1', label: 'API key' });
  assert.deepEqual(content, {
    'io.aee.ask-answer': {
      questionEventId: '$evt:local',
      questionId: 'q0',
      optionId: '0:1',
      label: 'API key',
    },
  });
});

test('buildAnswerContent omits questionId when absent', () => {
  const content = buildAnswerContent('$e', { optionId: '0:0', label: 'A' });
  assert.deepEqual(content[ASK_ANSWER_FIELD], { questionEventId: '$e', optionId: '0:0', label: 'A' });
});

test('indexAskAnswers maps question event ids to their first answer', () => {
  const messages = [
    { event_id: '$q', [ASK_QUESTION_FIELD]: { questions: [] } },
    { event_id: '$a1', [ASK_ANSWER_FIELD]: { questionEventId: '$q', optionId: '0:0', label: 'A' } },
    { event_id: '$a2', [ASK_ANSWER_FIELD]: { questionEventId: '$q', optionId: '0:1', label: 'B' } },
    { event_id: '$plain', body: 'hi' },
  ];
  const map = indexAskAnswers(messages);
  assert.equal(map.size, 1);
  assert.equal(map.get('$q').label, 'A'); // first writer wins
});

test('questionState: last unanswered question is answerable', () => {
  const s = questionState({ index: 2, messageCount: 3, answer: undefined });
  assert.deepEqual(s, { answerable: true, answeredOptionId: null, answeredLabel: null });
});

test('questionState: a later message makes buttons inert (superseded/answered)', () => {
  const s = questionState({ index: 1, messageCount: 3, answer: undefined });
  assert.equal(s.answerable, false);
});

test('questionState: an answered question is inert and exposes the choice', () => {
  const s = questionState({
    index: 4, messageCount: 5,
    answer: { optionId: '0:1', label: 'API key', questionEventId: '$q' },
  });
  assert.equal(s.answerable, false);
  assert.equal(s.answeredOptionId, '0:1');
  assert.equal(s.answeredLabel, 'API key');
});

test('questionState: disabled composer blocks an otherwise-answerable question', () => {
  const s = questionState({ index: 0, messageCount: 1, answer: undefined, disabled: true });
  assert.equal(s.answerable, false);
});
