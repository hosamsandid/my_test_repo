import test from 'node:test';
import assert from 'node:assert';

import {
  PROMPT_MODES,
  PROMPT_MODE_LABELS,
  ADDITION_HEADING,
  resolvePromptMode,
  composeMemberPrompt,
} from './prompt-mode-view.js';

const TEAM = 'Team baseline prompt.\nStay in sync.';

test('resolvePromptMode: explicit mode wins, else legacy inference (AC7)', () => {
  assert.equal(resolvePromptMode({ promptMode: 'additional', systemPrompt: '' }), PROMPT_MODES.ADDITIONAL);
  assert.equal(resolvePromptMode({}), PROMPT_MODES.INHERIT);
  assert.equal(resolvePromptMode({ systemPrompt: '' }), PROMPT_MODES.INHERIT);
  assert.equal(resolvePromptMode({ systemPrompt: 'custom' }), PROMPT_MODES.EXCLUSIVE);
});

test('composeMemberPrompt matches the three-mode contract (AC2/AC3/AC6/AC8)', () => {
  assert.equal(composeMemberPrompt(PROMPT_MODES.INHERIT, TEAM, 'x'), TEAM);
  assert.equal(composeMemberPrompt(PROMPT_MODES.EXCLUSIVE, TEAM, 'own'), 'own');
  assert.equal(
    composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, 'extra'),
    `${TEAM}\n\n---\n\n${ADDITION_HEADING}\n\nextra`,
  );
  assert.equal(composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, '   '), TEAM);
});

test('preview (AC9): additional preview shows the combined prompt, not the addition alone', () => {
  const preview = composeMemberPrompt(PROMPT_MODES.ADDITIONAL, TEAM, 'just mine');
  assert.ok(preview.includes(TEAM));
  assert.ok(preview.includes('just mine'));
  assert.ok(preview.indexOf(TEAM) < preview.indexOf('just mine'));
});

test('labels', () => {
  assert.equal(PROMPT_MODE_LABELS[PROMPT_MODES.EXCLUSIVE], 'Exclusive overriding input');
});
