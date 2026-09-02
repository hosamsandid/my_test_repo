import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyStateCta, CREATE_ROUTE } from './empty-state.js';

test('empty state exposes a single CTA to the unified /create launcher (#1893)', () => {
  const cta = emptyStateCta();
  assert.equal(cta.to, '/create');
  assert.equal(CREATE_ROUTE, '/create');
  assert.ok(cta.label && cta.label.trim().length > 0, 'has a non-empty label');
});

test('empty state no longer points at the retired per-flow deep links (#1893)', () => {
  const cta = emptyStateCta();
  // The old three-link block linked to /quickstart, /team-setup and
  // /getting-started; the single CTA must not resurrect any of them.
  assert.notEqual(cta.to, '/quickstart');
  assert.notEqual(cta.to, '/team-setup');
  assert.notEqual(cta.to, '/getting-started');
});
