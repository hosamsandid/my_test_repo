import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStatePointer, CREATE_ROUTE, HEADER_CREATE_LABEL } from './empty-state.js';

test('the empty state is a text pointer, not a competing CTA (#1956 AC7)', async () => {
  const pointer = emptyStatePointer();
  assert.ok(pointer.lead && pointer.lead.trim().length > 0, 'has a lead sentence');
  assert.ok(pointer.hint && pointer.hint.trim().length > 0, 'has a pointer sentence');
  // A pointer describes; it never carries a navigation target of its own — that
  // is exactly what would make it a second interactive way to create an agent.
  assert.equal(pointer.to, undefined);
  assert.equal(pointer.label, undefined);
  // And #1893's CTA builder is gone, not merely unrendered.
  const mod = await import('./empty-state.js');
  assert.equal(mod.emptyStateCta, undefined);
});

test('the pointer names the header button it points at, verbatim', () => {
  // The sentence and the button must not drift into naming two controls, so the
  // label is data both sides read.
  assert.equal(HEADER_CREATE_LABEL, 'New Agent');
  assert.ok(
    emptyStatePointer().hint.includes(HEADER_CREATE_LABEL),
    'the hint quotes the header button label',
  );
});

test('the create route the header button navigates to is still the launcher (#1893)', () => {
  // The rail no longer links there itself, but `AgentChat`'s header button does
  // — and #1956 AC3 requires that target to be `/create`, not a retired deep
  // link to one of the pre-#1665 create flows.
  assert.equal(CREATE_ROUTE, '/create');
  for (const retired of ['/quickstart', '/team-setup', '/getting-started']) {
    assert.notEqual(CREATE_ROUTE, retired);
  }
});
