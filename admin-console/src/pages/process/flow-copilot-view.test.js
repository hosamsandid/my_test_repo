import test from 'node:test';
import assert from 'node:assert/strict';

import {
  STARTER_PROMPTS,
  toApiMessages,
  describeChange,
  lintColor,
  copilotErrorInfo,
  supersedePending,
  latestProposal,
} from './flow-copilot-view.js';

test('starter prompts: three chips, whole-flow example first', () => {
  assert.equal(STARTER_PROMPTS.length, 3);
  assert.match(STARTER_PROMPTS[0], /Business Analyst/);
  assert.match(STARTER_PROMPTS[1], /security reviewer/);
  assert.match(STARTER_PROMPTS[2], /human approval gate/);
});

test('toApiMessages maps user rows verbatim and assistant rows to their summary', () => {
  const msgs = toApiMessages([
    { role: 'user', content: 'a BA refines issues' },
    { role: 'assistant', summary: 'Created a two-role flow.', bundle: { big: 'object' }, status: 'applied' },
    { role: 'user', content: 'add a reviewer' },
  ]);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'a BA refines issues' },
    { role: 'assistant', content: 'Created a two-role flow.' },
    { role: 'user', content: 'add a reviewer' },
  ]);
});

test('toApiMessages drops error rows and placeholder-fills empty summaries', () => {
  const msgs = toApiMessages([
    { role: 'user', content: 'x' },
    { role: 'error', message: 'HTTP 502' },
    { role: 'assistant', summary: '   ' },
    null,
  ]);
  assert.deepEqual(msgs, [
    { role: 'user', content: 'x' },
    { role: 'assistant', content: '(proposal without summary)' },
  ]);
});

test('toApiMessages tolerates a non-array', () => {
  assert.deepEqual(toApiMessages(null), []);
});

test('describeChange renders every computeChanges kind', () => {
  assert.equal(describeChange({ kind: 'role-added', id: 'developer' }), 'Role added: developer');
  assert.equal(describeChange({ kind: 'label-added', id: 'ready' }), 'Label registered: ready');
  assert.equal(describeChange({ kind: 'gate-modified', id: 'ready' }), 'Gate modified: ready');
  assert.equal(describeChange({ kind: 'human-removed', id: 'po' }), 'Human role removed: po');
  assert.equal(describeChange({ kind: 'name-changed', id: 'SDLC flow' }), 'Flow renamed to: SDLC flow');
});

test('describeChange falls back to the raw kind and tolerates junk', () => {
  assert.equal(describeChange({ kind: 'exotic-op', id: 'x' }), 'exotic-op: x');
  assert.equal(describeChange({ kind: 'role-added' }), 'Role added');
  assert.equal(describeChange(null), '');
});

test('lintColor mirrors the LintsPanel palette', () => {
  assert.equal(lintColor('error'), 'var(--eb-status-error)');
  assert.equal(lintColor('warning'), 'var(--eb-status-warning)');
  assert.equal(lintColor('info'), 'var(--eb-text-muted)');
});

test('copilotErrorInfo: 400 is a non-retryable provider problem', () => {
  const e = copilotErrorInfo(400, 'No LLM endpoint configured. Add one on the Model Providers page or set ANTHROPIC_BASE_URL.');
  assert.equal(e.kind, 'provider');
  assert.equal(e.retryable, false);
  assert.match(e.message, /No LLM endpoint/);
});

test('copilotErrorInfo: 502 and network errors are retryable transport failures', () => {
  assert.deepEqual(copilotErrorInfo(502, 'LLM request failed: HTTP 500'),
    { kind: 'transport', retryable: true, message: 'LLM request failed: HTTP 500' });
  const net = copilotErrorInfo(undefined, '');
  assert.equal(net.kind, 'transport');
  assert.equal(net.retryable, true);
  assert.match(net.message, /Request failed/);
});

test('supersedePending retires only still-proposed assistant entries', () => {
  const entries = [
    { role: 'user', content: 'x' },
    { role: 'assistant', status: 'applied', summary: 'a' },
    { role: 'assistant', status: 'proposed', summary: 'b' },
    { role: 'error', message: 'boom' },
  ];
  const next = supersedePending(entries);
  assert.equal(next[1].status, 'applied');
  assert.equal(next[2].status, 'superseded');
  assert.equal(next[0], entries[0]); // untouched rows keep identity
  assert.equal(next[3], entries[3]);
});

test('latestProposal finds the newest actionable card, else null', () => {
  const entries = [
    { role: 'assistant', status: 'discarded', summary: 'a' },
    { role: 'assistant', status: 'proposed', summary: 'b' },
    { role: 'user', content: 'y' },
  ];
  assert.equal(latestProposal(entries).summary, 'b');
  assert.equal(latestProposal([{ role: 'assistant', status: 'applied' }]), null);
  assert.equal(latestProposal(undefined), null);
});
