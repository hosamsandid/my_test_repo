import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyGithubToken, GITHUB_TOKEN_PREFIX_HINT } from './github-token-view.js';

test('empty / whitespace-only input says nothing (neutral)', () => {
  for (const v of ['', '   ', '\n\t', null, undefined]) {
    const r = classifyGithubToken(v);
    assert.equal(r.kind, 'empty');
    assert.equal(r.tone, 'muted');
    assert.equal(r.message, '');
  }
});

test('fine-grained token is recognised as OK', () => {
  const r = classifyGithubToken('github_pat_11ABCDEF0123456789_abcdefghij');
  assert.equal(r.kind, 'fine-grained');
  assert.equal(r.tone, 'ok');
  assert.match(r.message, /fine-grained/i);
});

test('classic token is recognised as OK', () => {
  const r = classifyGithubToken('ghp_0123456789abcdefghijABCDEFGHIJ012345');
  assert.equal(r.kind, 'classic');
  assert.equal(r.tone, 'ok');
  assert.match(r.message, /classic/i);
});

test('other GitHub prefixes are recognised, not warned', () => {
  for (const [v, needle] of [
    ['gho_abc123', /oauth/i],
    ['ghs_abc123', /app/i],
    ['ghu_abc123', /app/i],
    ['ghr_abc123', /refresh/i],
  ]) {
    const r = classifyGithubToken(v);
    assert.equal(r.tone, 'ok', `expected ok for ${v}`);
    assert.equal(r.kind, 'other-github');
    assert.match(r.message, needle);
  }
});

test('leading/trailing whitespace is tolerated (trimmed on save)', () => {
  const r = classifyGithubToken('  ghp_0123456789abcdefghij  ');
  assert.equal(r.kind, 'classic');
  assert.equal(r.tone, 'ok');
});

test('internal whitespace (wrapped paste / two values) is warned', () => {
  for (const v of ['ghp_0123 456789', 'github_pat_11AB\nCDEF', 'ghp_abc def']) {
    const r = classifyGithubToken(v);
    assert.equal(r.kind, 'whitespace');
    assert.equal(r.tone, 'warn');
    assert.match(r.message, /space or line break/i);
  }
});

test('unknown value warns with the prefix hint', () => {
  const r = classifyGithubToken('not-a-real-token');
  assert.equal(r.kind, 'unknown');
  assert.equal(r.tone, 'warn');
  assert.match(r.message, /doesn't look like a GitHub token/i);
  assert.ok(r.message.includes(GITHUB_TOKEN_PREFIX_HINT));
});

test('an unknown verdict never hard-blocks — callers gate on non-empty, not on kind', () => {
  // Documents the contract: the classifier only informs. A non-GitHub-looking
  // but non-empty value still returns a verdict object (never throws), so a
  // form that submits on "non-empty" is unaffected.
  assert.doesNotThrow(() => classifyGithubToken('anything'));
});
