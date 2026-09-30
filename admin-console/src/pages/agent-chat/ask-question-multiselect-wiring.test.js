import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drift guard for the multi-select quick-reply wiring (#2523). The JSX is not
// executed under node:test (#651), so pin that the renderers stay thin over the
// pure helpers in ask-question-view.js that ask-question-view.test.js covers.

const HERE = dirname(fileURLToPath(import.meta.url));
const card = readFileSync(join(HERE, 'AskQuestionCard.jsx'), 'utf8');
const panel = readFileSync(join(HERE, 'ChatPanel.jsx'), 'utf8');
const message = readFileSync(join(HERE, 'Message.jsx'), 'utf8');

function between(src, start, end) {
  const a = src.indexOf(start);
  assert.ok(a >= 0, `marker not found: ${start}`);
  const b = src.indexOf(end, a + start.length);
  assert.ok(b >= 0, `marker not found: ${end}`);
  return src.slice(a, b);
}

test('a multi-select click only toggles the draft, never sends', () => {
  const click = between(card, 'const handleOptionClick', 'const handleSubmit');
  assert.match(click, /if \(q\.multiSelect\) \{[^}]*toggleSelection\(prev\[q\.questionId\], opt\.optionId\)[^}]*\}\)\);\s*return;/s);
});

test('Submit builds the answer from the draft and hands it back', () => {
  const submit = between(card, 'const handleSubmit', '// In active multi-question mode');
  assert.match(submit, /buildSelectionAnswer\(q, drafts\[q\.questionId\]\)/);
  assert.match(submit, /if \(!answer\) return;/);
  assert.match(submit, /commitStep\(q, qi, answer\)/);
  assert.match(submit, /onAnswer\?\.\(\{ isMultiSelect: true, answer \}\)/);
});

test('Submit is rendered only for an answerable multi-select question and gated on a selection', () => {
  const block = between(card, 'function QuestionBlock', '\n}\n');
  assert.match(block, /\{q\.multiSelect && answerable && \(\s*<div>\s*<button[\s\S]*?disabled=\{!canSubmit\}[\s\S]*?Submit/);
  assert.match(card, /canSubmit=\{\(drafts\[q\.questionId\] \|\| \[\]\)\.length > 0\}/);
});

test('ChatPanel sends a multi-select answer with the structured selection content', () => {
  const handler = between(panel, 'function handleAnswerQuestion', '/* ─── 5b.');
  assert.match(handler, /optOrConsolidated\?\.isMultiSelect/);
  assert.match(handler, /handleSend\(answer\.label, buildSelectionAnswerContent\(questionEventId, answer\)\)/);
});

test('Message passes the answered multi-select ids to the card', () => {
  assert.match(message, /answeredOptionIds=\{questionAnswer\?\.answeredOptionIds \?\? null\}/);
});
