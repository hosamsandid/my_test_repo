'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  repoWebBase,
  buildSourceRefUrl,
  buildSessionDeepLink,
  matchesScope,
  shouldRefresh,
} = require('./knowledge-links');

const HTTPS = 'https://github.com/acme/repo.git';
const SSH = 'git@github.com:acme/repo.git';

// ── repoWebBase ───────────────────────────────────────────────────────────────

test('repoWebBase normalises https/ssh/scp forms, strips .git', () => {
  assert.equal(repoWebBase(HTTPS), 'https://github.com/acme/repo');
  assert.equal(repoWebBase(SSH), 'https://github.com/acme/repo');
  assert.equal(repoWebBase('https://github.com/acme/repo'), 'https://github.com/acme/repo');
  assert.equal(repoWebBase('ssh://git@github.com:22/acme/repo.git'), 'https://github.com/acme/repo');
  assert.equal(repoWebBase(''), null);
  assert.equal(repoWebBase(null), null);
});

// ── buildSourceRefUrl ─────────────────────────────────────────────────────────

test('buildSourceRefUrl for pr/issue/commit/branch from https + ssh repo', () => {
  for (const repo of [HTTPS, SSH]) {
    assert.equal(buildSourceRefUrl({ kind: 'pr', ref: '459' }, repo), 'https://github.com/acme/repo/pull/459');
    assert.equal(buildSourceRefUrl({ kind: 'issue', ref: '99' }, repo), 'https://github.com/acme/repo/issues/99');
    assert.equal(buildSourceRefUrl({ kind: 'commit', ref: 'abc123' }, repo), 'https://github.com/acme/repo/commit/abc123');
    assert.equal(buildSourceRefUrl({ kind: 'branch', ref: 'feature/x' }, repo), 'https://github.com/acme/repo/tree/feature%2Fx');
  }
});

test('buildSourceRefUrl url kind returns absolute link, ignores repo', () => {
  assert.equal(buildSourceRefUrl({ kind: 'url', ref: 'https://wiki.local/page' }), 'https://wiki.local/page');
  assert.equal(buildSourceRefUrl({ kind: 'url', ref: 'not-a-url' }), null);
});

test('buildSourceRefUrl returns null for unknown kind / no repo / bad input', () => {
  assert.equal(buildSourceRefUrl({ kind: 'wat', ref: '1' }, HTTPS), null);
  assert.equal(buildSourceRefUrl({ kind: 'pr', ref: '459' }, ''), null); // no repo base
  assert.equal(buildSourceRefUrl({ kind: 'pr', ref: '' }, HTTPS), null);
  assert.equal(buildSourceRefUrl(null, HTTPS), null);
});

// ── buildSessionDeepLink ──────────────────────────────────────────────────────

test('buildSessionDeepLink builds chat href with room + highlight', () => {
  const l = buildSessionDeepLink({ agentId: 'acme-dev-1', roomId: '!abc:local', correlationId: '$evt1' });
  assert.equal(l.agentId, 'acme-dev-1');
  assert.equal(l.roomId, '!abc:local');
  assert.equal(l.href, '/chats/acme-dev-1?room=!abc%3Alocal&highlight=%24evt1');
});

test('buildSessionDeepLink without room just opens the agent chat', () => {
  const l = buildSessionDeepLink({ agentId: 'acme-dev-1' });
  assert.equal(l.href, '/chats/acme-dev-1');
  assert.equal(l.roomId, null);
});

test('buildSessionDeepLink returns null without an agent', () => {
  assert.equal(buildSessionDeepLink({}), null);
  assert.equal(buildSessionDeepLink({ agentId: '' }), null);
});

// ── matchesScope ──────────────────────────────────────────────────────────────

test('matchesScope: global sees all, team/agent filter', () => {
  const ev = { type: 'harvest', teamId: 'acme', agentId: 'acme-dev-1' };
  assert.equal(matchesScope(ev, 'global'), true);
  assert.equal(matchesScope(ev, ''), true);
  assert.equal(matchesScope(ev, 'team:acme'), true);
  assert.equal(matchesScope(ev, 'team:other'), false);
  assert.equal(matchesScope(ev, 'agent:acme-dev-1'), true);
  assert.equal(matchesScope(ev, 'agent:acme-dev-2'), false);
});

test('matchesScope: control frames always pass', () => {
  assert.equal(matchesScope({ type: '_cursor', cursor: 10 }, 'team:acme'), true);
  assert.equal(matchesScope({ type: '_truncated' }, 'agent:x'), true);
});

test('matchesScope: bad input fails closed', () => {
  assert.equal(matchesScope(null, 'global'), false);
});

// ── shouldRefresh ─────────────────────────────────────────────────────────────

test('shouldRefresh honours the throttle window', () => {
  const now = 1_000_000;
  assert.equal(shouldRefresh(now - 40_000, now, 30_000), true);
  assert.equal(shouldRefresh(now - 10_000, now, 30_000), false);
  assert.equal(shouldRefresh(now, now, 30_000), false);
});

test('shouldRefresh refreshes when never refreshed / garbage lastAt', () => {
  assert.equal(shouldRefresh(null, 1000, 30_000), true);
  assert.equal(shouldRefresh(undefined, 1000, 30_000), true);
  assert.equal(shouldRefresh('not-a-date', 1000, 30_000), true);
});

test('shouldRefresh accepts ISO string timestamps', () => {
  const now = Date.parse('2026-07-08T12:00:30Z');
  assert.equal(shouldRefresh('2026-07-08T12:00:00Z', now, 30_000), true);
  assert.equal(shouldRefresh('2026-07-08T12:00:15Z', now, 30_000), false);
});
