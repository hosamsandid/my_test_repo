'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  resolveJiraApiBase,
  isChangelogTruncated,
  extractStatusChangeEvents,
  resolveProjectCredential,
  matchesStatusFilter,
  subscribesToStatusChanged,
  isValidCredentialId,
  computeQueryWindowMinutes,
} = require('./jira-poller');

// ── resolveJiraApiBase ──────────────────────────────────────────────────

test('resolveJiraApiBase: bare subdomain builds a .atlassian.net origin', () => {
  assert.equal(resolveJiraApiBase('acme'), 'https://acme.atlassian.net');
});

test('resolveJiraApiBase: full https origin is used verbatim (custom domain / fixture)', () => {
  assert.equal(resolveJiraApiBase('https://jira.acme.internal'), 'https://jira.acme.internal');
});

test('resolveJiraApiBase: trailing slash is stripped', () => {
  assert.equal(resolveJiraApiBase('https://acme.atlassian.net/'), 'https://acme.atlassian.net');
});

test('resolveJiraApiBase: http fixture host is used verbatim', () => {
  assert.equal(resolveJiraApiBase('http://fake-jira:8080'), 'http://fake-jira:8080');
});

// ── isChangelogTruncated ─────────────────────────────────────────────────

test('isChangelogTruncated: total greater than histories length is truncated', () => {
  assert.equal(isChangelogTruncated({ total: 50, histories: [{}, {}] }), true);
});

test('isChangelogTruncated: total equal to histories length is not truncated', () => {
  assert.equal(isChangelogTruncated({ total: 2, histories: [{}, {}] }), false);
});

test('isChangelogTruncated: missing/malformed changelog is not truncated', () => {
  assert.equal(isChangelogTruncated(null), false);
  assert.equal(isChangelogTruncated({}), false);
  assert.equal(isChangelogTruncated({ total: 5 }), false);
  assert.equal(isChangelogTruncated({ histories: [] }), false);
});

// ── extractStatusChangeEvents ────────────────────────────────────────────

test('extractStatusChangeEvents: flattens one status-field history item into one event', () => {
  const issue = {
    key: 'ENG-42',
    fields: { summary: 'Fix login bug' },
    changelog: {
      histories: [
        {
          id: '10001',
          created: '2026-07-27T10:00:00.000Z',
          author: { displayName: 'Jane Doe' },
          items: [{ field: 'status', fromString: 'To Do', toString: 'In Progress' }],
        },
      ],
    },
  };
  const events = extractStatusChangeEvents(issue, { projectKey: 'ENG', siteBase: 'https://acme.atlassian.net' });
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], {
    id: 'ENG-42:10001',
    issueKey: 'ENG-42',
    projectKey: 'ENG',
    created: '2026-07-27T10:00:00.000Z',
    author: 'Jane Doe',
    fromStatus: 'To Do',
    toStatus: 'In Progress',
    summary: 'Fix login bug',
    issueUrl: 'https://acme.atlassian.net/browse/ENG-42',
  });
});

test('extractStatusChangeEvents: non-status items in the same history are ignored', () => {
  const issue = {
    key: 'ENG-1',
    changelog: {
      histories: [{
        id: '1',
        items: [
          { field: 'assignee', fromString: 'a', toString: 'b' },
          { field: 'status', fromString: 'Open', toString: 'Closed' },
        ],
      }],
    },
  };
  const events = extractStatusChangeEvents(issue, { projectKey: 'ENG', siteBase: null });
  assert.equal(events.length, 1);
  assert.equal(events[0].fromStatus, 'Open');
  assert.equal(events[0].toStatus, 'Closed');
});

test('extractStatusChangeEvents: multiple status changes in one issue each become an event with a distinct id', () => {
  const issue = {
    key: 'ENG-2',
    changelog: {
      histories: [
        { id: '1', items: [{ field: 'status', fromString: 'Open', toString: 'In Progress' }] },
        { id: '2', items: [{ field: 'status', fromString: 'In Progress', toString: 'Done' }] },
      ],
    },
  };
  const events = extractStatusChangeEvents(issue, { projectKey: 'ENG', siteBase: null });
  assert.deepEqual(events.map(e => e.id), ['ENG-2:1', 'ENG-2:2']);
});

test('extractStatusChangeEvents: missing changelog/histories/items yields no events, never throws', () => {
  assert.deepEqual(extractStatusChangeEvents({ key: 'X-1' }, { projectKey: 'X' }), []);
  assert.deepEqual(extractStatusChangeEvents({ key: 'X-1', changelog: {} }, { projectKey: 'X' }), []);
  assert.deepEqual(extractStatusChangeEvents({ key: 'X-1', changelog: { histories: [{ id: '1' }] } }, { projectKey: 'X' }), []);
  assert.deepEqual(extractStatusChangeEvents(null, { projectKey: 'X' }), []);
  assert.deepEqual(extractStatusChangeEvents({}, { projectKey: 'X' }), []);
});

test('extractStatusChangeEvents: history entries missing an id are skipped (no undefined-id events)', () => {
  const issue = {
    key: 'ENG-3',
    changelog: {
      histories: [{ items: [{ field: 'status', fromString: 'A', toString: 'B' }] }],
    },
  };
  assert.deepEqual(extractStatusChangeEvents(issue, { projectKey: 'ENG' }), []);
});

// ── matchesStatusFilter ──────────────────────────────────────────────────

test('matchesStatusFilter: no filter matches any status', () => {
  assert.equal(matchesStatusFilter('Done', null), true);
  assert.equal(matchesStatusFilter('Done', undefined), true);
  assert.equal(matchesStatusFilter('Done', ''), true);
});

test('matchesStatusFilter: exact match required', () => {
  assert.equal(matchesStatusFilter('Ready for Dev', 'Ready for Dev'), true);
  assert.equal(matchesStatusFilter('In Progress', 'Ready for Dev'), false);
  assert.equal(matchesStatusFilter(null, 'Ready for Dev'), false);
});

// ── resolveProjectCredential — the per-agent, per-environment scoping ───
// This is the core correctness property distinguishing the Jira poller from
// GitHub's global repoToToken map: the SAME project key bound on two
// different environments to two different Jira sites must never be
// conflated — resolution only ever looks at the envProjects array the
// caller passes in for THAT ONE agent's own environment.

test('resolveProjectCredential: resolves a bound project to its credential and builds projectRef', () => {
  const envProjects = [{ projectKey: 'ENG', credentialId: 'cred-1' }];
  const loadCred = (id) => (id === 'cred-1' ? { id: 'cred-1', siteUrl: 'https://acme.atlassian.net', email: 'bot@acme.com' } : null);
  const resolved = resolveProjectCredential(envProjects, 'ENG', loadCred);
  assert.deepEqual(resolved, {
    credentialId: 'cred-1',
    siteUrl: 'https://acme.atlassian.net',
    email: 'bot@acme.com',
    projectRef: 'https://acme.atlassian.net::ENG',
  });
});

test('resolveProjectCredential: same project key on two different envs resolves to two different sites, never conflated', () => {
  const envA = [{ projectKey: 'ENG', credentialId: 'cred-a' }];
  const envB = [{ projectKey: 'ENG', credentialId: 'cred-b' }];
  const creds = {
    'cred-a': { id: 'cred-a', siteUrl: 'https://site-a.atlassian.net', email: 'a@a.com' },
    'cred-b': { id: 'cred-b', siteUrl: 'https://site-b.atlassian.net', email: 'b@b.com' },
  };
  const loadCred = (id) => creds[id] || null;
  const resolvedA = resolveProjectCredential(envA, 'ENG', loadCred);
  const resolvedB = resolveProjectCredential(envB, 'ENG', loadCred);
  assert.notEqual(resolvedA.projectRef, resolvedB.projectRef);
  assert.equal(resolvedA.projectRef, 'https://site-a.atlassian.net::ENG');
  assert.equal(resolvedB.projectRef, 'https://site-b.atlassian.net::ENG');
});

test('resolveProjectCredential: unbound project key returns null', () => {
  const envProjects = [{ projectKey: 'OTHER', credentialId: 'cred-1' }];
  const resolved = resolveProjectCredential(envProjects, 'ENG', () => { throw new Error('should not be called'); });
  assert.equal(resolved, null);
});

test('resolveProjectCredential: binding with no credentialId returns null', () => {
  const envProjects = [{ projectKey: 'ENG' }];
  const resolved = resolveProjectCredential(envProjects, 'ENG', () => { throw new Error('should not be called'); });
  assert.equal(resolved, null);
});

test('resolveProjectCredential: unknown credential id returns null', () => {
  const envProjects = [{ projectKey: 'ENG', credentialId: 'missing' }];
  const resolved = resolveProjectCredential(envProjects, 'ENG', () => null);
  assert.equal(resolved, null);
});

test('resolveProjectCredential: credential missing siteUrl or email returns null', () => {
  const envProjects = [{ projectKey: 'ENG', credentialId: 'cred-1' }];
  assert.equal(resolveProjectCredential(envProjects, 'ENG', () => ({ id: 'cred-1', email: 'a@a.com' })), null);
  assert.equal(resolveProjectCredential(envProjects, 'ENG', () => ({ id: 'cred-1', siteUrl: 'https://a.atlassian.net' })), null);
});

test('resolveProjectCredential: credential with an invalid id (path-traversal guard) returns null', () => {
  const envProjects = [{ projectKey: 'ENG', credentialId: '../../etc/passwd' }];
  const resolved = resolveProjectCredential(
    envProjects, 'ENG',
    () => ({ id: '../../etc/passwd', siteUrl: 'https://acme.atlassian.net', email: 'a@a.com' }),
  );
  assert.equal(resolved, null);
});

test('resolveProjectCredential: non-array envProjects is treated as empty', () => {
  assert.equal(resolveProjectCredential(null, 'ENG', () => { throw new Error('should not be called'); }), null);
  assert.equal(resolveProjectCredential(undefined, 'ENG', () => { throw new Error('should not be called'); }), null);
});

// ── isValidCredentialId ──────────────────────────────────────────────────

test('isValidCredentialId: accepts the same charset as SSH-key/GitHub-token ids', () => {
  assert.equal(isValidCredentialId('acme-jira'), true);
  assert.equal(isValidCredentialId('acme_jira.1'), true);
});

test('isValidCredentialId: rejects path traversal and empty/oversized ids', () => {
  assert.equal(isValidCredentialId('../../etc/passwd'), false);
  // Bare '..' passes the charset regex on its own (it's a valid filename
  // character run) — the traversal guard needs an explicit check for it.
  assert.equal(isValidCredentialId('..'), false);
  assert.equal(isValidCredentialId(''), false);
  assert.equal(isValidCredentialId('a'.repeat(64)), false);
  assert.equal(isValidCredentialId(null), false);
  assert.equal(isValidCredentialId(42), false);
});

// ── subscribesToStatusChanged ────────────────────────────────────────────

test('subscribesToStatusChanged: absent/empty events subscribes to everything', () => {
  assert.equal(subscribesToStatusChanged(undefined), true);
  assert.equal(subscribesToStatusChanged([]), true);
});

test('subscribesToStatusChanged: a non-empty list must name status_changed', () => {
  assert.equal(subscribesToStatusChanged(['status_changed']), true);
  assert.equal(subscribesToStatusChanged(['something_else']), false);
});

// ── computeQueryWindowMinutes ────────────────────────────────────────────

test('computeQueryWindowMinutes: no lastPolledAt uses the base window', () => {
  assert.equal(computeQueryWindowMinutes(null, 5, 1440), 5);
  assert.equal(computeQueryWindowMinutes(undefined, 5, 1440), 5);
});

test('computeQueryWindowMinutes: an unparsable lastPolledAt uses the base window', () => {
  assert.equal(computeQueryWindowMinutes('not-a-date', 5, 1440), 5);
});

test('computeQueryWindowMinutes: a gap shorter than the base window is a no-op', () => {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  assert.equal(computeQueryWindowMinutes(oneMinuteAgo, 5, 1440), 5);
});

test('computeQueryWindowMinutes: a gap longer than the base window widens to cover it', () => {
  const twentyMinutesAgo = new Date(Date.now() - 20 * 60_000).toISOString();
  const widened = computeQueryWindowMinutes(twentyMinutesAgo, 5, 1440);
  assert.ok(widened >= 20, `expected >= 20, got ${widened}`);
});

test('computeQueryWindowMinutes: a very long outage is capped at maxCatchupMinutes', () => {
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString();
  assert.equal(computeQueryWindowMinutes(twoDaysAgo, 5, 1440), 1440);
});
