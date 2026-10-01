import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// ─── #2665 hand-off dialog save-validation wiring guard ──────────────────────
//
// The rules are pure and unit-tested (`handoff-validation.test.js`,
// `channel-keying.test.js`); this pins that the Flow editor dialogs actually
// apply them before saving. The admin-console-src job cannot render JSX (#651),
// and each of these fails silently: the dialog keeps saving, it just stores an
// unusable label or a placeholder instruction again.
//
// Source-text guard, not a render test.

const here = dirname(fileURLToPath(import.meta.url));

// Comments are stripped first so the explanatory comments can't satisfy a matcher.
function sourceOf(rel) {
  return readFileSync(join(here, rel), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
}

const dialogs = sourceOf('./EdgeDialogs.jsx');
const canvas = sourceOf('../ProcessCanvas.jsx');

function at(src, needle, from = 0) {
  const i = src.indexOf(needle, from);
  assert.ok(i >= 0, `expected to find ${JSON.stringify(needle)} — this guard needs re-pointing`);
  return i;
}

// The body of one top-level function component: from its declaration to the next.
function component(name) {
  const start = at(dialogs, `function ${name}(`);
  const next = dialogs.slice(start + 1).search(/\n(?:export )?function [A-Z]/);
  assert.ok(next > 0, `${name} runs to the end of the file — this guard needs re-pointing`);
  return dialogs.slice(start, start + 1 + next);
}

// The body of the named async save handler, up to where it starts saving.
function saveHead(src, handler) {
  const start = at(src, `async function ${handler}() {`);
  return src.slice(start, at(src, 'setSaving(true)', start));
}

test('the stripped source is still the dialogs, not a hole', () => {
  assert.ok(dialogs.length > 50000, 'EdgeDialogs.jsx stripped to nothing');
  assert.match(dialogs, /from '\.\/handoff-validation'/);
  assert.match(dialogs, /import \{ hasChannel \} from '\.\/channel-ops'/);
});

for (const [name, handler] of [['CreateHandoffDialog', 'submit'], ['EditLabelHandoff', 'saveEdits']]) {
  test(`#2665: ${name} refuses an unusable label name or a placeholder prompt before saving`, () => {
    const src = component(name);
    assert.match(src, /const promptErr = promptPlaceholderError\(effectivePrompt\);/);
    const head = saveHead(src, handler);
    assert.match(head, /const invalid = labelNameError\((trimmed|newLabel)\) \|\| promptErr;/);
    assert.match(head, /if \(invalid\) \{ setError\(invalid\); return; \}/);
    // The live hints next to the fields.
    assert.match(src, /const labelErr = (label|labelName)\.trim\(\) \? labelNameError\(\1\) : null;/);
    assert.match(src, /\{labelErr && <small style=\{errStyle\}>\{labelErr\}<\/small>\}/);
    assert.match(src, /\{promptErr && <small style=\{errStyle\}>\{promptErr\}<\/small>\}/);
  });
}

test('#2665: the GitHub trigger form validates a set label filter and the prompt', () => {
  const src = component('GithubTriggerForm');
  assert.match(src, /const labelErr = labelActive \? labelNameError\(trimmedLabel\) : null;/);
  assert.match(src, /const promptErr = promptPlaceholderError\(effectivePrompt\);/);
  const head = saveHead(src, 'submit');
  assert.match(head, /const invalid = labelErr \|\| promptErr;\s*if \(invalid\) \{ setError\(invalid\); return; \}/);
  assert.match(src, /\{labelErr && <small style=\{errStyle\}>\{labelErr\}<\/small>\}/);
  assert.match(src, /\{promptErr && <small style=\{errStyle\}>\{promptErr\}<\/small>\}/);
});

test('#2665: the webhook form refuses a placeholder prompt', () => {
  const src = component('WebhookForm');
  assert.match(src, /const promptErr = promptPlaceholderError\(effectivePrompt\);/);
  assert.match(saveHead(src, 'submit'), /if \(promptErr\) \{ setError\(promptErr\); return; \}/);
  assert.match(src, /\{promptErr && <small style=\{errStyle\}>\{promptErr\}<\/small>\}/);
});

test('#2665: the channel dialog marks an existing channel and does not create it again', () => {
  const src = component('CreateChannelDialog');
  assert.match(src, /existingChannels \}\) \{/);
  assert.match(src, /const exists = hasChannel\(existingChannels, \{ artifact, from, label \}\);/);
  assert.match(saveHead(src, 'submit'), /if \(exists\) return;/);
  assert.match(src, /\{exists && \(/);
  assert.match(src, /disabled=\{saving \|\| exists\}/);
  assert.match(src, /exists \? 'Channel exists' : 'Create channel'/);
});

test('#2665: every CreateChannelDialog call site passes the consumer\'s channels', () => {
  assert.match(dialogs, /onBack=\{back\} existingChannels=\{toNode\?\.channels\} \/>/);
  assert.match(dialogs, /existingChannels=\{node\.channels\} \/>/);
  assert.match(canvas, /existingChannels=\{\(displayGraph\?\.nodes \|\| \[\]\)\.find\(n => n\.id === outcomeConnect\.to\)\?\.channels\}/);
  const sites = (dialogs.match(/<CreateChannelDialog\b/g) || []).length + (canvas.match(/<CreateChannelDialog\b/g) || []).length;
  assert.equal(sites, 3, 'a new CreateChannelDialog call site must pass existingChannels too');
});
