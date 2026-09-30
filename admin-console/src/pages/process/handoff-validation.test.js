import test from 'node:test';
import assert from 'node:assert/strict';

import { HANDOFF_LABEL_RE, labelNameError, promptPlaceholderError } from './handoff-validation.js';
import { defaultListenerPrompt } from './handoff-prompt.js';

// #2665 — the label hand-off dialog saved `uitest rework, ärger` as-is and
// stored the default wake instruction with its literal placeholders.

test('labelNameError accepts the label shapes flows use', () => {
  for (const ok of ['ready', 'ready-for-review', 'stage:td', 'req:refine', 'priorisiert', 'ärger', 'a'.repeat(50)]) {
    assert.equal(labelNameError(ok), null, ok);
  }
  // Surrounding whitespace is trimmed, as the dialogs save the trimmed name.
  assert.equal(labelNameError('  ready  '), null);
});

test('labelNameError rejects an empty name with the existing message', () => {
  assert.equal(labelNameError(''), 'Enter the label name.');
  assert.equal(labelNameError('   '), 'Enter the label name.');
  assert.equal(labelNameError(undefined), 'Enter the label name.');
});

test('labelNameError names the comma — GitHub tools split it into two labels', () => {
  assert.match(labelNameError('uitest rework, ärger'), /commas/);
  assert.match(labelNameError('a,b'), /commas/);
});

test('labelNameError applies the Flow Control rule: no whitespace, quotes, braces, angle brackets, ≤ 50 chars', () => {
  for (const bad of ['uitest rework', 'tab\there', 'a"b', "a'b", 'a`b', 'a{b}', '<label>', 'a'.repeat(51)]) {
    assert.match(labelNameError(bad) || '', /spaces, quotes, backticks, braces or angle brackets/, bad);
  }
  assert.equal(HANDOFF_LABEL_RE.test('a'.repeat(50)), true);
  assert.equal(HANDOFF_LABEL_RE.test('a'.repeat(51)), false);
});

test('promptPlaceholderError flags the unfilled default instruction', () => {
  const p = defaultListenerPrompt({
    label: 'ready', verb: 'added to', targetNoun: 'an issue',
    repo: '', fromLabel: 'Code Reviewer', toLabel: 'Developer',
  });
  assert.equal(
    promptPlaceholderError(p),
    'Replace <Describe what Developer should do.> in the wake instruction — the agent would be woken with the placeholder as its instruction.',
  );
});

test('promptPlaceholderError flags the <repo>/<label>/<event> stand-ins', () => {
  for (const ph of ['<repo>', '<label>', '<event>']) {
    assert.match(promptPlaceholderError(`Handle it in ${ph}.`) || '', new RegExp(`Replace ${ph} `));
  }
});

test('promptPlaceholderError accepts a filled-in instruction', () => {
  assert.equal(promptPlaceholderError('`ready` was added to an issue by Dispatcher.\n\nImplement the issue. Reply `[PASS]` if there\'s nothing to do.'), null);
  assert.equal(promptPlaceholderError(''), null);
  assert.equal(promptPlaceholderError(undefined), null);
  // Other angle-bracket text is the operator's own and stays allowed.
  assert.equal(promptPlaceholderError('Compare a <b> tag and <Describe> alone.'), null);
});
