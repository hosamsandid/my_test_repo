'use strict';
// #2813 — the portable per-role fields addTeamMember records on a member
// config (prompt mode + own text, model pin, memory), checked by behaviour.

const test = require('node:test');
const assert = require('node:assert/strict');
const { memberPortableFields } = require('./member-portable-fields');

test('an inherit member drops its own prompt text but keeps the mode', () => {
  assert.deepEqual(
    memberPortableFields({ promptMode: 'inherit', systemPromptOverride: 'Own text' }),
    { promptMode: 'inherit' },
  );
});

test('an additional or exclusive member keeps its own text next to the mode', () => {
  assert.deepEqual(
    memberPortableFields({ promptMode: 'additional', systemPromptOverride: 'Also lint.' }),
    { systemPrompt: 'Also lint.', promptMode: 'additional' },
  );
  assert.deepEqual(
    memberPortableFields({ promptMode: 'exclusive', systemPromptOverride: 'Only this.' }),
    { systemPrompt: 'Only this.', promptMode: 'exclusive' },
  );
});

test('without a valid mode the legacy shape is kept: own text only, no promptMode', () => {
  assert.deepEqual(memberPortableFields({ systemPromptOverride: 'Legacy' }), { systemPrompt: 'Legacy' });
  assert.deepEqual(memberPortableFields({ promptMode: 'sometimes', systemPromptOverride: 'Legacy' }), { systemPrompt: 'Legacy' });
  assert.deepEqual(memberPortableFields({}), {});
});

test('the model pin is trimmed and the memory value normalised; empty or invalid values are left out', () => {
  assert.deepEqual(
    memberPortableFields({ modelOverride: '  claude-sonnet-5 ', memoryLimit: '4Gi' }),
    { modelOverride: 'claude-sonnet-5', memoryLimit: '4g' },
  );
  assert.deepEqual(memberPortableFields({ modelOverride: '   ', memoryLimit: 'lots' }), {});
});
