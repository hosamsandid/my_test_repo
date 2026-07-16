'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const { deriveEmits, deriveEmitsForTrigger } = require('./emits-derivation');

const TEMPLATES_DIR = path.join(
  __dirname, '..', '..', 'orchestrator', 'skill-pool', 'agent-templates',
);

function loadTemplate(id) {
  return JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, `${id}.json`), 'utf8'));
}

function labels(suggestions) {
  return suggestions.map(s => s.label);
}

function confidenceOf(suggestions, label) {
  const hit = suggestions.find(s => s.label === label);
  return hit && hit.confidence;
}

test('returns [] for non-string / empty input', () => {
  assert.deepEqual(deriveEmits(undefined), []);
  assert.deepEqual(deriveEmits(null), []);
  assert.deepEqual(deriveEmits(''), []);
  assert.deepEqual(deriveEmits(42), []);
  assert.deepEqual(deriveEmits('prose with no labels at all, nothing here.'), []);
});

test('shape of a suggestion entry', () => {
  const out = deriveEmits('Then add the `dispatch` label.');
  assert.equal(out.length, 1);
  const [s] = out;
  assert.equal(s.label, 'dispatch');
  assert.equal(s.confidence, 'high');
  assert.equal(typeof s.sourceSnippet, 'string');
  assert.ok(s.sourceSnippet.includes('dispatch'));
});

test('emit verbs yield high confidence; bare label-shaped tokens stay low', () => {
  const out = deriveEmits('Add the `dispatch` label and set `stage:td`. See also `ready`.');
  assert.equal(confidenceOf(out, 'dispatch'), 'high');
  assert.equal(confidenceOf(out, 'stage:td'), 'high');
  assert.equal(confidenceOf(out, 'ready'), 'low');
  // high-confidence entries sort ahead of low-confidence ones
  assert.equal(out[out.length - 1].label, 'ready');
});

test('removal is not an emission (soft negative, nearest cue wins)', () => {
  const out = deriveEmits('Remove the `ready` label, then add `started:bot`.');
  assert.deepEqual(labels(out), ['started:bot']);
});

test('prohibitions fail closed anywhere in the window', () => {
  assert.deepEqual(deriveEmits('You must NEVER apply the `human:fdd-approved` label.'), []);
  assert.deepEqual(deriveEmits('Do not set `hold` yourself.'), []);
});

test('template placeholders are preserved verbatim', () => {
  const out = deriveEmits('Apply the label `{{dispatchLabel}}` and add `started:{{agentId}}`.');
  assert.equal(confidenceOf(out, '{{dispatchLabel}}'), 'high');
  assert.equal(confidenceOf(out, '{{agentId}}'), undefined); // bare {{agentId}} is namespaced here
  assert.equal(confidenceOf(out, 'started:{{agentId}}'), 'high');
});

test('non-label backtick blocks (commands, paths) are ignored', () => {
  const out = deriveEmits(
    'Run `gh issue edit <n> --add-label dispatch` and read `memory/log.md`.',
  );
  assert.deepEqual(out, []);
});

test('shipped dispatcher template: emits `dispatch` (high)', () => {
  const tpl = loadTemplate('dispatcher');
  const out = deriveEmits(tpl.promptTemplate);
  assert.equal(confidenceOf(out, 'dispatch'), 'high',
    'dispatcher applies the `dispatch` label — must be a high-confidence emission');
  // The dispatcher consumes `ready` (and is prohibited from setting it) — must
  // NOT be emitted.
  assert.equal(confidenceOf(out, 'ready'), undefined);
});

test('templated tokens in trigger prompts are preserved verbatim (high)', () => {
  // Templates with {{var}} placeholders are still supported by the mechanism
  // even though the shipped catalog no longer uses them.
  const trigger = {
    promptTemplate: 'Add `started:{{agentId}}` to the issue. Remove the `{{readyLabel}}` label from the issue.',
  };
  const out = deriveEmitsForTrigger(trigger, '');
  assert.equal(confidenceOf(out, 'started:{{agentId}}'), 'high');
  // The trigger consumes {{readyLabel}} (it removes it) — must NOT be emitted.
  assert.equal(confidenceOf(out, '{{readyLabel}}'), undefined);
});

test('deriveEmitsForTrigger folds trigger + system prompt and dedupes', () => {
  const trigger = { promptTemplate: 'Add `started:bot`.' };
  const sys = 'You generally set `started:bot` and also `stage:td`.';
  const out = deriveEmitsForTrigger(trigger, sys);
  assert.deepEqual(new Set(labels(out)), new Set(['started:bot', 'stage:td']));
  // de-duplicated to a single entry per label
  assert.equal(labels(out).filter(l => l === 'started:bot').length, 1);
});

test('every shipped template derives without throwing', () => {
  for (const file of fs.readdirSync(TEMPLATES_DIR).filter(f => f.endsWith('.json'))) {
    const tpl = JSON.parse(fs.readFileSync(path.join(TEMPLATES_DIR, file), 'utf8'));
    assert.doesNotThrow(() => deriveEmits(tpl.promptTemplate || ''));
    for (const tr of tpl.triggers || []) {
      assert.doesNotThrow(() => deriveEmitsForTrigger(tr, tpl.promptTemplate));
    }
  }
});
