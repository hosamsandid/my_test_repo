'use strict';

// Unit tests for the PR-link record writer + pure parse helpers (#655).
// Run: node --test orchestrator/pr-events-log.test.js
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Point the log at a throwaway dir before requiring the module.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pr-events-log-test-'));
process.env.PR_EVENTS_LOG_DIR = TMP;

const test = require('node:test');
const assert = require('node:assert/strict');
const prEvents = require('./pr-events-log');

test('repoFullName normalizes SSH / HTTPS / PR URLs to owner/name', () => {
  assert.equal(prEvents.repoFullName('git@github.com:org/repo.git'), 'org/repo');
  assert.equal(prEvents.repoFullName('https://github.com/org/repo.git'), 'org/repo');
  assert.equal(prEvents.repoFullName('https://github.com/org/repo'), 'org/repo');
  assert.equal(prEvents.repoFullName('https://github.com/org/repo/pull/731'), 'org/repo');
  assert.equal(prEvents.repoFullName('git@github.com:AccentureCodeFoundry/314092_agent-execution-environment.git'), 'AccentureCodeFoundry/314092_agent-execution-environment');
});

test('repoFullName returns null for malformed / empty input', () => {
  assert.equal(prEvents.repoFullName(''), null);
  assert.equal(prEvents.repoFullName(null), null);
  assert.equal(prEvents.repoFullName('not-a-url'), null);
});

test('parsePrNumber extracts the number from a PR URL', () => {
  assert.equal(prEvents.parsePrNumber('https://github.com/org/repo/pull/731'), 731);
  assert.equal(prEvents.parsePrNumber('https://github.com/org/repo/pull/42#issuecomment'), 42);
});

test('parsePrNumber returns null for non-PR / malformed input', () => {
  assert.equal(prEvents.parsePrNumber('https://github.com/org/repo/issues/9'), null);
  assert.equal(prEvents.parsePrNumber(''), null);
  assert.equal(prEvents.parsePrNumber(null), null);
  assert.equal(prEvents.parsePrNumber('https://github.com/org/repo/pull/0'), null);
});

test('parseCloses reads GitHub closing keywords from the body (all tenses)', () => {
  assert.deepEqual(prEvents.parseCloses('Closes #99', null), [99]);
  assert.deepEqual(prEvents.parseCloses('fixes #12 and resolves #7', null), [7, 12]);
  assert.deepEqual(prEvents.parseCloses('This closed: #3', null), [3]);
});

test('parseCloses reads the issue number from the head branch name', () => {
  assert.deepEqual(prEvents.parseCloses('', 'agent/dev/issue-99'), [99]);
  assert.deepEqual(prEvents.parseCloses('', 'feature/issue_42'), [42]);
  assert.deepEqual(prEvents.parseCloses('', 'bugfix/issue/7'), [7]);
});

test('parseCloses merges body + branch, dedupes and sorts', () => {
  assert.deepEqual(prEvents.parseCloses('closes #99', 'agent/dev/issue-99'), [99]);
  assert.deepEqual(prEvents.parseCloses('fixes #5', 'x/issue-99'), [5, 99]);
});

test('parseCloses does not invent edges from stray numbers', () => {
  // A number that is neither a closing-keyword ref nor an `issue-N` token is ignored.
  assert.deepEqual(prEvents.parseCloses('see PR 500 and commit abc123', 'agent/dev-2/branch-3'), []);
  assert.deepEqual(prEvents.parseCloses('', 'agent/team-a-developer/some-feature'), []);
});

test('dayOf buckets by the record ts, not wall clock', () => {
  assert.equal(prEvents.dayOf({ ts: '2026-07-16T10:00:00.000Z' }), '2026-07-16');
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(prEvents.dayOf({}), today);
});

test('record round-trip: one pr-created JSONL line, bucketed by ts', () => {
  const rec = {
    ts: '2026-07-16T10:00:00.000Z', kind: 'pr-created', agentId: 'team-a-developer',
    teamId: 'team-a', repo: 'org/repo', prNumber: 731, url: 'https://github.com/org/repo/pull/731',
    branch: 'agent/x/issue-99', base: 'main', closes: [99], correlationId: 'trigger:dev:gh:1',
  };
  assert.equal(prEvents.record(rec), true);
  const fp = path.join(TMP, 'pr-events-2026-07-16.jsonl');
  assert.ok(fs.existsSync(fp));
  const last = JSON.parse(fs.readFileSync(fp, 'utf8').trim().split('\n').pop());
  assert.equal(last.prNumber, 731);
  assert.deepEqual(last.closes, [99]);
});

test('record never throws on a malformed entry', () => {
  assert.doesNotThrow(() => prEvents.record(undefined));
});
