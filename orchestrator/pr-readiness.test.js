'use strict';

// PR readiness evaluation (#2794) — the pure core: verdict rules, the per-repo
// state machine, the GraphQL query builders/parsers.
// Run: node --test orchestrator/pr-readiness.test.js

const test = require('node:test');
const assert = require('node:assert/strict');

const r = require('./pr-readiness');

const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);
const T0 = Date.parse('2026-10-03T10:00:00Z');

const run = (name, status, conclusion = null) => ({ __typename: 'CheckRun', name, status, conclusion });
const status = (context, state) => ({ __typename: 'StatusContext', context, state });
const pr = (number, sha, mergeable = 'MERGEABLE', over = {}) => ({
  number, sha, mergeable, title: `PR ${number}`, url: `https://github.com/o/r/pull/${number}`,
  headRef: `feat/${number}`, baseRef: 'main', fromFork: false, ...over,
});
// A state that is not due for a baseline (evaluated just now).
const live = (prs = {}, now = T0) => ({ lastEvaluatedAt: new Date(now).toISOString(), prs });

// ── verdict rules ──────────────────────────────────────────────────────────

test('classifyCheck: success/neutral/skipped pass; failure family fails; unfinished is pending', () => {
  for (const c of ['SUCCESS', 'NEUTRAL', 'SKIPPED']) assert.equal(r.classifyCheck(run('x', 'COMPLETED', c)), 'pass', c);
  for (const c of ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE']) {
    assert.equal(r.classifyCheck(run('x', 'COMPLETED', c)), 'fail', c);
  }
  for (const s of ['QUEUED', 'IN_PROGRESS', 'WAITING', 'PENDING', 'REQUESTED']) assert.equal(r.classifyCheck(run('x', s)), 'pending', s);
  assert.equal(r.classifyCheck(run('x', 'COMPLETED', null)), 'pending', 'completed without conclusion is never guessed');
  assert.equal(r.classifyCheck(status('ci/x', 'SUCCESS')), 'pass');
  assert.equal(r.classifyCheck(status('ci/x', 'FAILURE')), 'fail');
  assert.equal(r.classifyCheck(status('ci/x', 'ERROR')), 'fail');
  assert.equal(r.classifyCheck(status('ci/x', 'PENDING')), 'pending');
  assert.equal(r.classifyCheck(status('ci/x', 'EXPECTED')), 'pending');
});

test('AC1: all checks completed successfully → passed', () => {
  const v = r.ciVerdict({ checks: [run('build', 'COMPLETED', 'SUCCESS'), run('lint', 'COMPLETED', 'SKIPPED'), status('ci/ext', 'SUCCESS')], headSeenAt: T0, now: T0 });
  assert.deepEqual(v, { verdict: 'passed', failingChecks: [] });
});

test('AC1: one check still running → pending', () => {
  const v = r.ciVerdict({ checks: [run('build', 'COMPLETED', 'SUCCESS'), run('e2e', 'IN_PROGRESS')], headSeenAt: T0, now: T0 });
  assert.equal(v.verdict, 'pending');
});

test('AC2: a failing check settles `failed` while others are still pending, naming the failures', () => {
  const v = r.ciVerdict({
    checks: [run('e2e', 'IN_PROGRESS'), run('unit', 'COMPLETED', 'FAILURE'), status('ci/legacy', 'ERROR'), run('build', 'QUEUED')],
    headSeenAt: T0, now: T0,
  });
  assert.deepEqual(v, { verdict: 'failed', failingChecks: ['ci/legacy', 'unit'] });
});

test('AC3: CodeQL and other non-required checks count — a failing CodeQL alone yields failed', () => {
  const v = r.ciVerdict({ checks: [run('build', 'COMPLETED', 'SUCCESS'), run('CodeQL', 'COMPLETED', 'FAILURE')], headSeenAt: T0, now: T0 });
  assert.deepEqual(v, { verdict: 'failed', failingChecks: ['CodeQL'] });
});

test('AC4: no check within the grace period → pending, after it → none; grace configurable', () => {
  assert.equal(r.ciVerdict({ checks: [], headSeenAt: T0, now: T0 + r.DEFAULT_CI_GRACE_MS - 1 }).verdict, 'pending');
  assert.equal(r.ciVerdict({ checks: [], headSeenAt: T0, now: T0 + r.DEFAULT_CI_GRACE_MS }).verdict, 'none');
  assert.equal(r.ciVerdict({ checks: [], headSeenAt: T0, now: T0 + 10_000, graceMs: 10_000 }).verdict, 'none');
  assert.equal(r.DEFAULT_CI_GRACE_MS, 3 * 60_000);
  assert.equal(r.ciGraceMs({}), 3 * 60_000);
  assert.equal(r.ciGraceMs({ AEE_PR_READINESS_CI_GRACE_MS: '60000' }), 60_000);
  assert.equal(r.ciGraceMs({ AEE_PR_READINESS_CI_GRACE_MS: '0' }), 0);
  assert.equal(r.ciGraceMs({ AEE_PR_READINESS_CI_GRACE_MS: '' }), 3 * 60_000);
  assert.equal(r.ciGraceMs({ AEE_PR_READINESS_CI_GRACE_MS: 'soon' }), 3 * 60_000);
});

test('more checks than read and none failing → pending, never passed', () => {
  assert.equal(r.ciVerdict({ checks: [run('a', 'COMPLETED', 'SUCCESS')], truncated: true, headSeenAt: T0, now: T0 }).verdict, 'pending');
});

test('AC5: mergeable UNKNOWN stays pending; CONFLICTING → conflict; MERGEABLE → clean', () => {
  assert.equal(r.mergeVerdict('UNKNOWN'), 'pending');
  assert.equal(r.mergeVerdict(null), 'pending');
  assert.equal(r.mergeVerdict('CONFLICTING'), 'conflict');
  assert.equal(r.mergeVerdict('MERGEABLE'), 'clean');
});

// ── queries / parsers ──────────────────────────────────────────────────────

test('parseOpenPrs keeps well-formed nodes and reports truncation', () => {
  const out = r.parseOpenPrs({ repository: { pullRequests: {
    pageInfo: { hasNextPage: true },
    nodes: [
      { number: 7, title: 'T', url: 'https://github.com/o/r/pull/7', headRefName: 'f', headRefOid: SHA_A.toUpperCase(), baseRefName: 'main', mergeable: 'UNKNOWN', isCrossRepository: true },
      { number: 8, headRefOid: 'not-a-sha' },
      null,
    ],
  } } });
  assert.equal(out.truncated, true);
  assert.equal(out.prs.length, 1);
  assert.deepEqual(out.prs[0], { number: 7, sha: SHA_A, title: 'T', url: 'https://github.com/o/r/pull/7', body: null, headRef: 'f', baseRef: 'main', mergeable: 'UNKNOWN', fromFork: true });
  assert.deepEqual(r.parseOpenPrs(null), { prs: [], truncated: false });
});

test('buildChecksQuery addresses each commit by SHA; parseChecks maps the aliases back', () => {
  const q = r.buildChecksQuery('o', 'r', [SHA_A, 'bogus', SHA_B]);
  assert.deepEqual(q.shas, [SHA_A, SHA_B]);
  assert.deepEqual(q.variables, { owner: 'o', name: 'r', o0: SHA_A, o1: SHA_B });
  assert.match(q.query, /c0:object\(oid:\$o0\)/);
  assert.match(q.query, /c1:object\(oid:\$o1\)/);
  assert.match(q.query, /\$o1:GitObjectID!/);
  assert.match(q.query, /on CheckRun\{name status conclusion\}/);
  assert.match(q.query, /on StatusContext\{context state\}/);
  const parsed = r.parseChecks({ repository: {
    c0: { oid: SHA_A, statusCheckRollup: { contexts: { pageInfo: { hasNextPage: false }, nodes: [run('b', 'COMPLETED', 'SUCCESS')] } } },
    c1: null,
  } }, q.shas);
  assert.deepEqual([...parsed.keys()], [SHA_A]);
  assert.equal(parsed.get(SHA_A).checks.length, 1);
  // A commit with no rollup at all reads as "no checks".
  const none = r.parseChecks({ repository: { c0: { oid: SHA_A, statusCheckRollup: null } } }, [SHA_A]);
  assert.deepEqual(none.get(SHA_A), { checks: [], truncated: false });
});

test('the open-PR query reads head commit and mergeable', () => {
  assert.match(r.OPEN_PRS_QUERY, /pullRequests\(states:OPEN/);
  assert.match(r.OPEN_PRS_QUERY, /headRefOid/);
  assert.match(r.OPEN_PRS_QUERY, /mergeable/);
});

test('the open-PR query reads each PR\'s labels; parseOpenPrs keeps their names only when returned (#2795)', () => {
  assert.match(r.OPEN_PRS_QUERY, /labels\(first:\d+\)\{nodes\{name\}\}/);
  // Balanced braces — the query parses.
  assert.equal((r.OPEN_PRS_QUERY.match(/\{/g) || []).length, (r.OPEN_PRS_QUERY.match(/\}/g) || []).length);
  const node = { number: 7, headRefOid: SHA_A, labels: { nodes: [{ name: 'ready-for-review' }, null, { name: 'docs' }] } };
  const out = r.parseOpenPrs({ repository: { pullRequests: { nodes: [node, { number: 8, headRefOid: SHA_B }] } } });
  assert.deepEqual(out.prs[0].labels, ['ready-for-review', 'docs']);
  assert.equal('labels' in out.prs[1], false);
});

test('the open-PR query reads each PR\'s body; parseOpenPrs keeps it as a string or null (#2799)', () => {
  assert.match(r.OPEN_PRS_QUERY, /nodes\{number title url body /);
  const out = r.parseOpenPrs({ repository: { pullRequests: { nodes: [
    { number: 7, headRefOid: SHA_A, body: 'Closes #12' },
    { number: 8, headRefOid: SHA_B, body: 42 },
  ] } } });
  assert.equal(out.prs[0].body, 'Closes #12');
  assert.equal(out.prs[1].body, null);
});

// ── state machine ──────────────────────────────────────────────────────────

const checksFor = (sha, nodes, truncated = false) => new Map([[sha, { checks: nodes, truncated }]]);

test('shasToRead: new heads and open CI verdicts are read; passed/none heads are not (AC9)', () => {
  const state = live({
    1: { sha: SHA_A, ci: 'passed' },
    2: { sha: SHA_A, ci: 'none' },
    3: { sha: SHA_A, ci: 'failed' },
    4: { sha: SHA_A, ci: 'pending' },
    5: { sha: SHA_A, ci: 'passed' },
  });
  const prs = [pr(1, SHA_A), pr(2, SHA_A), pr(3, SHA_B), pr(4, SHA_B), pr(5, SHA_B), pr(6, SHA_A)];
  // 3/4/5 changed head to SHA_B; 6 is new on SHA_A. 1/2 are settled.
  assert.deepEqual(r.shasToRead(state, prs).sort(), [SHA_A, SHA_B].sort());
  assert.deepEqual(r.shasToRead(state, [pr(1, SHA_A), pr(2, SHA_A)]), []);
});

test('baseline: the first evaluation records final verdicts without emitting', () => {
  const out = r.evaluateReadiness({
    state: null,
    prs: [pr(1, SHA_A, 'CONFLICTING')],
    checks: checksFor(SHA_A, [run('b', 'COMPLETED', 'SUCCESS')]),
    now: T0,
  });
  assert.equal(out.baseline, true);
  assert.deepEqual(out.emits, []);
  assert.deepEqual(out.state.prs[1].emitted.sort(), ['pull_request.checks_passed', 'pull_request.merge_conflict']);
  // Only a missing state baselines — never a time gap (see the B1 test below).
  assert.equal(r.needsBaseline(null), true);
  assert.equal(r.needsBaseline(live({}, T0)), false);
});

test('no re-baseline after a gap: a tracked pending head that turned green during a long outage emits exactly once', () => {
  const state = live({
    5: { sha: SHA_A, headSeenAt: T0, ci: 'pending', merge: 'clean', failingChecks: [], emitted: [] },
  }, T0);
  const later = T0 + 16 * 60_000;
  const out = r.evaluateReadiness({
    state, prs: [pr(5, SHA_A)], checks: checksFor(SHA_A, [run('b', 'COMPLETED', 'SUCCESS')]), now: later,
  });
  assert.equal(out.baseline, false);
  assert.equal(out.emits.length, 1);
  assert.equal(out.emits[0].key, 'pull_request.checks_passed');
  assert.equal(out.emits[0].sha, SHA_A);
  // Delivered once — the next pass (however late) stays silent.
  const again = r.evaluateReadiness({
    state: out.state, prs: [pr(5, SHA_A)], checks: checksFor(SHA_A, [run('b', 'COMPLETED', 'SUCCESS')]), now: later + 60 * 60_000,
  });
  assert.deepEqual(again.emits, []);
});

test('AC1/AC6: checks complete → one checks_passed for (PR, head), never again', () => {
  let state = live({}, T0);
  let out = r.evaluateReadiness({ state, prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, [run('b', 'IN_PROGRESS')]), now: T0 + 1000 });
  assert.deepEqual(out.emits, []);
  assert.equal(out.state.prs[1].ci, 'pending');
  state = out.state;
  out = r.evaluateReadiness({ state, prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, [run('b', 'COMPLETED', 'SUCCESS')]), now: T0 + 31_000 });
  assert.equal(out.emits.length, 1);
  assert.equal(out.emits[0].key, 'pull_request.checks_passed');
  assert.equal(out.emits[0].sha, SHA_A);
  assert.equal(out.emits[0].verdict, 'passed');
  state = out.state;
  // Settled: no more checks read, and nothing re-emitted.
  assert.deepEqual(r.shasToRead(state, [pr(1, SHA_A)]), []);
  out = r.evaluateReadiness({ state, prs: [pr(1, SHA_A)], checks: null, now: T0 + 61_000 });
  assert.deepEqual(out.emits, []);
});

test('AC2/AC6: failing check → checks_failed once with the failing names', () => {
  const state = live({}, T0);
  const out = r.evaluateReadiness({
    state, prs: [pr(1, SHA_A)],
    checks: checksFor(SHA_A, [run('e2e', 'IN_PROGRESS'), run('CodeQL', 'COMPLETED', 'FAILURE')]), now: T0 + 1000,
  });
  assert.equal(out.emits.length, 1);
  assert.equal(out.emits[0].key, 'pull_request.checks_failed');
  assert.deepEqual(out.emits[0].failingChecks, ['CodeQL']);
  const again = r.evaluateReadiness({
    state: out.state, prs: [pr(1, SHA_A)],
    checks: checksFor(SHA_A, [run('e2e', 'COMPLETED', 'FAILURE'), run('CodeQL', 'COMPLETED', 'FAILURE')]), now: T0 + 2000,
  });
  assert.deepEqual(again.emits, [], 'still failed on the same head → no second checks_failed');
});

test('re-run on the same commit: checks_passed fires after the earlier checks_failed', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, [run('unit', 'COMPLETED', 'FAILURE')]), now: T0 + 1000 });
  assert.equal(out.emits[0].key, 'pull_request.checks_failed');
  assert.deepEqual(r.shasToRead(out.state, [pr(1, SHA_A)]), [SHA_A], 'a failed head is still read for re-runs');
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, [run('unit', 'IN_PROGRESS')]), now: T0 + 2000 });
  assert.deepEqual(out.emits, []);
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, [run('unit', 'COMPLETED', 'SUCCESS')]), now: T0 + 3000 });
  assert.deepEqual(out.emits.map((e) => e.key), ['pull_request.checks_passed']);
});

test('AC4: no check after the grace period → none, which emits nothing and stops reading', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, []), now: T0 + 1000, graceMs: 60_000 });
  assert.equal(out.state.prs[1].ci, 'pending');
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A)], checks: checksFor(SHA_A, []), now: T0 + 61_001, graceMs: 60_000 });
  assert.equal(out.state.prs[1].ci, 'none');
  assert.deepEqual(out.emits, []);
  assert.deepEqual(r.shasToRead(out.state, [pr(1, SHA_A)]), []);
});

test('AC5: UNKNOWN is re-read and never reported; CONFLICTING emits merge_conflict once', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A, 'UNKNOWN')], checks: null, now: T0 + 1000 });
  assert.equal(out.state.prs[1].merge, 'pending');
  assert.deepEqual(out.emits, []);
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A, 'CONFLICTING')], checks: null, now: T0 + 2000 });
  assert.deepEqual(out.emits.map((e) => [e.key, e.verdict]), [['pull_request.merge_conflict', 'conflict']]);
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A, 'UNKNOWN')], checks: null, now: T0 + 3000 });
  assert.equal(out.state.prs[1].merge, 'pending');
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A, 'CONFLICTING')], checks: null, now: T0 + 4000 });
  assert.deepEqual(out.emits, [], 'once per (PR, head, verdict)');
});

test('a base-branch move that conflicts an already-clean head is still reported', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A, 'MERGEABLE')], checks: null, now: T0 + 1000 });
  assert.equal(out.state.prs[1].merge, 'clean');
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_A, 'CONFLICTING')], checks: null, now: T0 + 2000 });
  assert.deepEqual(out.emits.map((e) => e.key), ['pull_request.merge_conflict']);
});

test('AC7: a new push resets both verdicts; the new head can fire again, the old never does', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A, 'CONFLICTING')], checks: checksFor(SHA_A, [run('u', 'COMPLETED', 'FAILURE')]), now: T0 + 1000 });
  assert.deepEqual(out.emits.map((e) => e.key).sort(), ['pull_request.checks_failed', 'pull_request.merge_conflict']);
  // New push: head is SHA_B. Even a late read that still carries SHA_A's
  // (now successful) checks must not deliver anything for SHA_A.
  const late = new Map([[SHA_A, { checks: [run('u', 'COMPLETED', 'SUCCESS')], truncated: false }]]);
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_B, 'UNKNOWN')], checks: late, now: T0 + 2000 });
  assert.deepEqual(out.emits, []);
  assert.equal(out.state.prs[1].sha, SHA_B);
  assert.equal(out.state.prs[1].ci, 'pending');
  assert.equal(out.state.prs[1].merge, 'pending');
  assert.deepEqual(out.state.prs[1].emitted, []);
  out = r.evaluateReadiness({ state: out.state, prs: [pr(1, SHA_B, 'CONFLICTING')], checks: checksFor(SHA_B, [run('u', 'COMPLETED', 'FAILURE')]), now: T0 + 3000 });
  assert.deepEqual(out.emits.map((e) => [e.key, e.sha]).sort(), [
    ['pull_request.checks_failed', SHA_B], ['pull_request.merge_conflict', SHA_B],
  ]);
});

test('a PR closed or merged while pending is dropped and fires nothing', () => {
  let out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A, 'UNKNOWN')], checks: checksFor(SHA_A, [run('u', 'IN_PROGRESS')]), now: T0 + 1000 });
  out = r.evaluateReadiness({ state: out.state, prs: [], checks: null, now: T0 + 2000 });
  assert.deepEqual(out.emits, []);
  assert.deepEqual(out.state.prs, {});
});

test('a truncated open-PR list keeps PRs it did not show instead of treating them as closed', () => {
  const state = live({ 9: { sha: SHA_A, headSeenAt: T0, ci: 'passed', merge: 'clean', failingChecks: [], emitted: ['pull_request.checks_passed'] } });
  const out = r.evaluateReadiness({ state, prs: [], truncated: true, checks: null, now: T0 + 1000 });
  assert.ok(out.state.prs[9]);
});

test('GitHub unreachable (checks unreadable): CI stays pending, nothing is guessed', () => {
  const out = r.evaluateReadiness({ state: live(), prs: [pr(1, SHA_A)], checks: null, now: T0 + 10 * 60_000 });
  assert.equal(out.state.prs[1].ci, 'pending', 'no `none` without an actual read showing zero checks');
  assert.deepEqual(out.emits, []);
});

test('readinessEvent: PullRequestEvent shape with number, head SHA, verdict and failing checks (AC6)', () => {
  const ev = r.readinessEvent('o/r', {
    key: 'pull_request.checks_failed', pr: pr(12, SHA_A, 'MERGEABLE', { fromFork: true }), sha: SHA_A,
    verdict: 'failed', ci: 'failed', merge: 'clean', failingChecks: ['CodeQL'],
  }, T0);
  assert.equal(ev.id, `readiness:12:${SHA_A}:checks_failed`);
  assert.equal(ev.type, 'PullRequestEvent');
  assert.equal(ev.repo.name, 'o/r');
  assert.equal(ev.created_at, new Date(T0).toISOString());
  assert.equal(ev.payload.action, 'checks_failed');
  assert.equal(ev.payload.pull_request.number, 12);
  assert.equal(ev.payload.pull_request.head.sha, SHA_A);
  assert.equal(ev.payload.pull_request.title, 'PR 12');
  assert.equal(ev.payload.pull_request.html_url, 'https://github.com/o/r/pull/12');
  assert.deepEqual(ev.payload.readiness, {
    headSha: SHA_A, verdict: 'failed', ci: 'failed', merge: 'clean', failingChecks: ['CodeQL'], fromFork: true,
  });
});

// ---- shared rules with aee-wait-ci (#2796) ----------------------------------

test('#2796: the verdict rules are one data file, vendored byte-identical into the agent image', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const canonical = fs.readFileSync(path.join(__dirname, 'pr-readiness-rules.json'));
  const vendored = fs.readFileSync(path.join(__dirname, '..', 'agent-image', 'scripts', 'pr-readiness-rules.json'));
  assert.ok(canonical.equals(vendored), 'cp orchestrator/pr-readiness-rules.json agent-image/scripts/');
  const rules = JSON.parse(canonical);
  assert.equal(r.DEFAULT_CI_GRACE_MS, rules.ciGraceMs);
  assert.equal(r.MAX_CHECKS, rules.maxChecks);
});

test('#2796: shared verdict cases (also run by aee-wait-ci tests) hold for ciVerdict/mergeVerdict', () => {
  const cases = require('./pr-readiness-cases.json');
  assert.ok(cases.ci.length >= 10 && cases.merge.length >= 4);
  for (const c of cases.ci) {
    const got = r.ciVerdict({
      checks: c.checks, truncated: !!c.truncated, headSeenAt: T0 - c.elapsedMs, now: T0,
      graceMs: c.graceMs ?? r.DEFAULT_CI_GRACE_MS,
    });
    assert.deepEqual(got, c.expect, c.name);
  }
  for (const c of cases.merge) assert.equal(r.mergeVerdict(c.mergeable), c.expect, String(c.mergeable));
});

test('readinessEvent: closesIssues from the PR body and an issue-N branch, ascending; the body is not carried (#2799)', () => {
  const ev = r.readinessEvent('o/r', {
    key: 'pull_request.checks_passed', pr: pr(12, SHA_A, 'MERGEABLE', { body: 'Fixes #40. Closes #7', headRef: 'issue-40-x' }), sha: SHA_A,
    verdict: 'passed', ci: 'passed', merge: 'clean', failingChecks: [],
  }, T0);
  assert.deepEqual(ev.payload.pull_request.closesIssues, [7, 40]);
  assert.equal('body' in ev.payload.pull_request, false);
});

test('readinessEvent: no closesIssues key when the PR links no issue (#2799)', () => {
  for (const body of [null, '', 'refactor only']) {
    const ev = r.readinessEvent('o/r', {
      key: 'pull_request.merge_conflict', pr: pr(12, SHA_A, 'CONFLICTING', { body }), sha: SHA_A,
      verdict: 'conflict', ci: 'pending', merge: 'conflict', failingChecks: [],
    }, T0);
    assert.equal('closesIssues' in ev.payload.pull_request, false);
  }
});
