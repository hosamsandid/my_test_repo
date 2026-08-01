import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeActivation, syncFailureReason, isSourceMissing } from './knowledge-activation-view.js';

// ── syncFailureReason ────────────────────────────────────────────────────────

test('syncFailureReason maps the source-missing code to plain language (no "pool" jargon, #750 AC4)', () => {
  assert.equal(syncFailureReason({ status: 'error', reason: 'source-missing', error: 'skill not found in pool: x' }), 'this skill’s files are no longer available');
});

test('syncFailureReason infers source-missing from the error text when no code', () => {
  assert.equal(syncFailureReason({ status: 'error', error: 'skill not found in pool: x' }), 'this skill’s files are no longer available');
});

test('syncFailureReason surfaces a copy failure with its message in plain language', () => {
  assert.equal(syncFailureReason({ status: 'error', reason: 'copy-failed', error: 'EACCES' }), 'couldn’t install it (EACCES)');
});

test('syncFailureReason falls back to the raw error, then a generic default', () => {
  assert.equal(syncFailureReason({ status: 'error', error: 'disk full' }), 'disk full');
  assert.equal(syncFailureReason({ status: 'error' }), 'couldn’t install it');
});

test('syncFailureReason never leaks internal terms like "pool"/"manifest"/"pending" (#750 AC4)', () => {
  const cases = [
    { status: 'error', reason: 'source-missing' },
    { status: 'error', error: 'skill not found in pool: x' },
    { status: 'error', reason: 'copy-failed', error: 'EACCES' },
    { status: 'error' },
  ];
  for (const m of cases) {
    assert.doesNotMatch(syncFailureReason(m), /\b(pool|manifest|pending)\b/i);
  }
});

// ── summarizeActivation: honest team-wide feedback (AC1/AC2) ──────────────────

test('all members synced → green success with the count', () => {
  const r = summarizeActivation([{ status: 'seeded' }, { status: 'seeded' }]);
  assert.equal(r.kind, 'ok');
  assert.equal(r.text, 'active for 2/2 members');
});

test('AC2: zero members synced (all errored) is an ERROR, never green', () => {
  const members = Array.from({ length: 10 }, () => ({ status: 'error', reason: 'source-missing', error: 'skill not found in pool: x' }));
  const r = summarizeActivation(members);
  assert.equal(r.kind, 'error');
  assert.equal(r.synced, 0);
  assert.match(r.text, /^0\/10 synced/);
  assert.match(r.text, /no longer available/);
});

test('AC1: a partial failure is a WARNING carrying count + reason', () => {
  const r = summarizeActivation([
    { status: 'seeded' },
    { status: 'seeded' },
    { status: 'error', reason: 'copy-failed', error: 'EACCES' },
  ]);
  assert.equal(r.kind, 'warn');
  assert.equal(r.synced, 2);
  assert.equal(r.text, '2/3 synced — couldn’t install it (EACCES)');
});

test('distinct failure reasons are de-duplicated in the message', () => {
  const r = summarizeActivation([
    { status: 'error', reason: 'source-missing' },
    { status: 'error', reason: 'source-missing' },
  ]);
  assert.equal(r.kind, 'error');
  assert.equal(r.text, '0/2 synced — this skill’s files are no longer available');
});

test('neutral members (stub / skipped-override) do not count as failures or syncable', () => {
  const r = summarizeActivation([
    { status: 'seeded' },
    { status: 'stub' },
    { status: 'skipped-override' },
  ]);
  assert.equal(r.kind, 'ok');
  assert.equal(r.syncable, 1);
  assert.equal(r.text, 'active for 1/1 member');
});

test('all-neutral run reads as a plain "activated" (nothing to sync, not a failure)', () => {
  const r = summarizeActivation([{ status: 'stub' }, { status: 'skipped-override' }]);
  assert.equal(r.kind, 'ok');
  assert.equal(r.text, 'activated');
});

test('empty member list → "activated"', () => {
  const r = summarizeActivation([]);
  assert.equal(r.kind, 'ok');
  assert.equal(r.text, 'activated');
});

// ── summarizeActivation: member-scoped "Sync now" (AC3) ───────────────────────

test('AC3: scoped success reports "synced" for that member', () => {
  const r = summarizeActivation([{ agentId: 'a', status: 'seeded' }], { scoped: true });
  assert.equal(r.kind, 'ok');
  assert.equal(r.text, 'synced');
});

test('AC3: scoped failure reports the concrete reason, not a silent no-op', () => {
  const r = summarizeActivation([{ agentId: 'a', status: 'error', reason: 'source-missing' }], { scoped: true });
  assert.equal(r.kind, 'error');
  assert.equal(r.text, 'still failing — this skill’s files are no longer available');
});

test('scoped neutral outcomes explain themselves', () => {
  assert.equal(summarizeActivation([{ status: 'stub' }], { scoped: true }).text, 'not materialized yet');
  assert.equal(summarizeActivation([{ status: 'skipped-override' }], { scoped: true }).text, 'member manages its own skill list');
});

// ── isSourceMissing ───────────────────────────────────────────────────────────

test('isSourceMissing is true only when every failure is the pool-file-gone case', () => {
  assert.equal(isSourceMissing([{ status: 'error', reason: 'source-missing' }]), true);
  assert.equal(isSourceMissing([{ status: 'error', error: 'skill not found in pool: x' }]), true);
  assert.equal(isSourceMissing([{ status: 'error', reason: 'source-missing' }, { status: 'error', reason: 'copy-failed' }]), false);
  assert.equal(isSourceMissing([{ status: 'seeded' }]), false);
  assert.equal(isSourceMissing([]), false);
});
