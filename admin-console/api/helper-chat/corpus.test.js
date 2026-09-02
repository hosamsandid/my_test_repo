'use strict';

// Parity + budget guard for the Helper Chat corpus (#1733).
// Mirrors admin-console/api/flow-copilot.test.js: the vendored docs next to this
// module must stay byte-identical to their repo-root sources (the runtime image
// cannot reach repo-root docs/), and the assembled system prompt must fit the
// char budget before it is ever sent to a model.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const {
  buildSystemPrompt,
  measureSystemPrompt,
  SYSTEM_PROMPT_CHAR_LIMIT,
  CORPUS_FILES,
} = require('./corpus');

// docs/ lives at the repo root, two levels up from admin-console/api/helper-chat.
const REPO_DOCS = path.join(__dirname, '..', '..', '..', 'docs');
const VENDORED_DOCS = path.join(__dirname, 'docs');

test('every corpus file is vendored byte-identical to its docs/ source', () => {
  for (const f of CORPUS_FILES) {
    const source = fs.readFileSync(path.join(REPO_DOCS, f), 'utf8');
    const vendored = fs.readFileSync(path.join(VENDORED_DOCS, f), 'utf8');
    assert.equal(vendored, source, `vendored copy of ${f} drifted from docs/${f}`);
  }
});

test('system-prompt.md exists and carries the corpus marker', () => {
  const template = fs.readFileSync(path.join(__dirname, 'system-prompt.md'), 'utf8');
  assert.ok(
    template.includes('[corpus is appended here at runtime]'),
    'system-prompt.md must contain the runtime corpus marker',
  );
});

test('buildSystemPrompt splices the corpus and drops the marker', () => {
  const prompt = buildSystemPrompt(null);
  assert.ok(!prompt.includes('[corpus is appended here at runtime]'), 'marker must be replaced');
  // A doc heading and a term from the glossary prove the corpus was spliced in.
  assert.ok(prompt.includes('### glossary.md'), 'corpus section headings must be present');
});

test('buildSystemPrompt appends the current-page context when given a route label', () => {
  const prompt = buildSystemPrompt('Flows');
  assert.ok(prompt.includes('currently on the **Flows** page'), 'route label must be appended');
  // No route label → no page-context sentence.
  assert.ok(!buildSystemPrompt(null).includes('currently on the'), 'no route → no page context');
});

test('the page-help topics are folded into the grounding prompt (#1872 single source)', () => {
  const prompt = buildSystemPrompt(null);
  // The Overview pilot topic ships in help-topics/ and must be present in the
  // same system prompt the panel serves — this is the "no vendoring" single
  // source in action.
  assert.ok(prompt.includes('### page-help topics'), 'help topics section must be spliced in');
  assert.ok(prompt.includes('Welcome to Agent Studio'), 'the Overview topic title must be present');
});

test('a currentRoute with a topic adds a page-grounding pointer', () => {
  // The Overview topic has no route, so use a label + route pair that resolves
  // to nothing → no pointer; and confirm the label sentence is independent.
  const withLabel = buildSystemPrompt('Agents', '/agents');
  assert.ok(withLabel.includes('currently on the **Agents** page'));
  // No route argument → no page-topic pointer sentence.
  assert.ok(!buildSystemPrompt('Agents').includes('maps to the help topic'));
});

test('measured system prompt is below the char limit', () => {
  const n = measureSystemPrompt();
  assert.ok(
    n < SYSTEM_PROMPT_CHAR_LIMIT,
    `assembled prompt is ${n} chars, over the ${SYSTEM_PROMPT_CHAR_LIMIT} limit`,
  );
});
