'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  ADDITION_HEADING,
  resolvePromptMode,
  composeMemberPrompt,
} = require('./prompt-modes');

const TEAM = 'You are a helpful teammate.\nFollow the team conventions.';

test('resolvePromptMode: explicit promptMode always wins', () => {
  assert.equal(resolvePromptMode({ promptMode: 'inherit' }), PROMPT_MODES.INHERIT);
  assert.equal(resolvePromptMode({ promptMode: 'additional', systemPrompt: 'x' }), PROMPT_MODES.ADDITIONAL);
  assert.equal(resolvePromptMode({ promptMode: 'additional', systemPrompt: '' }), PROMPT_MODES.ADDITIONAL);
  assert.equal(resolvePromptMode({ promptMode: 'exclusive', systemPrompt: 'x' }), PROMPT_MODES.EXCLUSIVE);
});

test('resolvePromptMode: legacy inference matches the pre-#1511 editor (AC7)', () => {
  // absent override → inherit; non-empty override → exclusive (the old "Custom").
  assert.equal(resolvePromptMode({}), PROMPT_MODES.INHERIT);
  assert.equal(resolvePromptMode({ systemPrompt: '' }), PROMPT_MODES.INHERIT); // empty custom was inherit before
  assert.equal(resolvePromptMode({ systemPrompt: 'my own prompt' }), PROMPT_MODES.EXCLUSIVE);
  assert.equal(resolvePromptMode(null), PROMPT_MODES.INHERIT);
  assert.equal(resolvePromptMode({ promptMode: 'bogus', systemPrompt: 'x' }), PROMPT_MODES.EXCLUSIVE); // invalid → infer
});

test('composeMemberPrompt inherit → team template only (AC2)', () => {
  assert.equal(composeMemberPrompt(PROMPT_MODES.INHERIT, TEAM, 'ignored'), TEAM);
});

test('composeMemberPrompt exclusive → own text verbatim, byte-identical to old Custom (AC6)', () => {
  const own = 'Completely different prompt.\n';
  assert.equal(composeMemberPrompt(PROMPT_MODES.EXCLUSIVE, TEAM, own), own);
  assert.equal(composeMemberPrompt(PROMPT_MODES.EXCLUSIVE, '', own), own);
});

test('composeMemberPrompt additional → team first, delimited addition last (AC3/AC4)', () => {
  const out = composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, 'Also always write tests.');
  // team appears first, addition strictly after it
  assert.ok(out.startsWith(TEAM), 'team prompt leads');
  assert.ok(out.indexOf('Also always write tests.') > out.indexOf('team conventions'), 'addition is last');
  // delimited, labelled section
  assert.ok(out.includes(ADDITION_HEADING), 'labelled heading present');
  assert.ok(out.includes('\n---\n'), 'horizontal-rule delimiter present');
  assert.equal(out, `${TEAM}\n\n---\n\n${ADDITION_HEADING}\n\nAlso always write tests.`);
});

test('composeMemberPrompt additional trims surrounding whitespace cleanly', () => {
  const out = composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM + '\n\n\n', '   spaced addition   ');
  assert.equal(out, `${TEAM}\n\n---\n\n${ADDITION_HEADING}\n\nspaced addition`);
});

test('composeMemberPrompt additional with empty/whitespace addition ≡ inherit, no stray heading (AC8)', () => {
  assert.equal(composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, ''), TEAM);
  assert.equal(composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, '   \n  '), TEAM);
  assert.ok(!composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, '').includes(ADDITION_HEADING));
});

test('composeMemberPrompt additional with empty team → addition alone (no leading rule on empty base)', () => {
  const out = composeMemberPrompt(PROMPT_MODES.ADDITIONAL, '', 'just the addition');
  assert.equal(out, `---\n\n${ADDITION_HEADING}\n\njust the addition`);
});

test('labels cover all three modes', () => {
  assert.equal(PROMPT_MODE_LABELS[PROMPT_MODES.INHERIT], 'Inherit from team');
  assert.equal(PROMPT_MODE_LABELS[PROMPT_MODES.ADDITIONAL], 'Additional input');
  assert.equal(PROMPT_MODE_LABELS[PROMPT_MODES.EXCLUSIVE], 'Exclusive overriding input');
});

test('the orchestrator twin is byte-identical to the admin-console copy', () => {
  const here = fs.readFileSync(path.join(__dirname, 'prompt-modes.js'), 'utf8');
  const twin = fs.readFileSync(path.join(__dirname, '..', '..', 'orchestrator', 'prompt-modes.js'), 'utf8');
  assert.equal(twin, here, 'orchestrator/prompt-modes.js must be byte-identical to admin-console/api/prompt-modes.js');
});
