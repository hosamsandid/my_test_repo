import test from 'node:test';
import assert from 'node:assert/strict';

import { describeAgentSubmitState } from './agent-create-submit-state.js';

// A fully-satisfied single agent: name, id, environment and a system prompt.
const readyAgent = {
  displayName: 'COBOL Agent',
  id: 'cobol-agent',
  environmentId: 'env-1',
  role: 'agent',
  systemPrompt: 'You are an experienced COBOL developer.',
};

const fieldsOf = result => result.reasons.map(r => r.field);

/* ── happy paths ─────────────────────────────────────────────────────── */

test('a complete single-agent form can submit', () => {
  const s = describeAgentSubmitState(readyAgent);
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

test('#1964 — `orchestrator` is no longer a prompt-optional role', () => {
  // The role card is gone from the create form, so this can only be reached by
  // a hand-crafted body. The gate must treat it like any other agent rather
  // than keep a hole that waves through a promptless create for a role the
  // server (#1962) already refuses.
  const s = describeAgentSubmitState({ ...readyAgent, role: 'orchestrator', systemPrompt: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['systemPrompt']);
});

test('team role needs no system prompt (member prompts come later)', () => {
  const s = describeAgentSubmitState({ ...readyAgent, role: 'team', systemPrompt: '' });
  assert.equal(s.canSubmit, true);
  assert.deepEqual(s.reasons, []);
});

/* ── individual unmet requirements ───────────────────────────────────── */

test('missing display name blocks submit', () => {
  const s = describeAgentSubmitState({ ...readyAgent, displayName: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['displayName']);
});

test('missing id blocks submit', () => {
  const s = describeAgentSubmitState({ ...readyAgent, id: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['id']);
});

test('missing working environment blocks submit', () => {
  const s = describeAgentSubmitState({ ...readyAgent, environmentId: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['environmentId']);
});

test('agent role with empty system prompt blocks submit', () => {
  const s = describeAgentSubmitState({ ...readyAgent, systemPrompt: '' });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['systemPrompt']);
});

test('whitespace-only values do not count as filled', () => {
  const s = describeAgentSubmitState({
    displayName: '  ', id: '\t', environmentId: ' ', role: 'agent', systemPrompt: '  ',
  });
  assert.equal(s.canSubmit, false);
  assert.deepEqual(fieldsOf(s), ['displayName', 'id', 'environmentId', 'systemPrompt']);
});

/* ── ordering + shape ────────────────────────────────────────────────── */

test('reasons follow the form top-to-bottom order', () => {
  const s = describeAgentSubmitState({
    displayName: '', id: '', environmentId: '', role: 'agent', systemPrompt: '',
  });
  assert.deepEqual(fieldsOf(s), ['displayName', 'id', 'environmentId', 'systemPrompt']);
  for (const r of s.reasons) {
    assert.equal(typeof r.message, 'string');
    assert.ok(r.message.length > 0);
  }
});

test('empty / missing form object is fully blocked, never throws', () => {
  assert.deepEqual(fieldsOf(describeAgentSubmitState()), ['displayName', 'id', 'environmentId', 'systemPrompt']);
  assert.equal(describeAgentSubmitState({}).canSubmit, false);
});
