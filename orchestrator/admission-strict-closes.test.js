'use strict';

// Regression test for the admission-lane keep-alive linkage (Fix C).
// Run: node --test orchestrator/admission-strict-closes.test.js
//
// The bug: `admissionSweepTeam` decided whether an open PR keeps an in-flight
// ticket alive using the LOOSE `flowAnomalySweep.prsForIssue` linkage — any
// `#N` mention anywhere in the PR body. A Dependabot PR inlines upstream
// changelogs full of FOREIGN `owner/repo#N` references (e.g.
// `actions/checkout#2521`), so it matched local tickets #2521/#2531 and pinned
// them in the lane forever. With `wipLimit` reached the whole flow froze and
// every new GitHub-event dispatch was held invisibly.
//
// The fix: use the STRICT `prEventsLog.parseCloses` (closes/fixes/resolves #N
// in the body + `issue-N` in the head branch) — the same parse the poller
// stamps onto an event and that `entryTicketRef` keys a slot on at admit time.
// These tests lock both the behaviour and the wiring so the loose linker can
// never creep back into this path.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCloses } = require('./pr-events-log');
const flowAnomalySweep = require('./flow-anomaly-sweep');

// A faithful reduction of the real Dependabot PR #2516 body: an inlined
// upstream changelog that mentions the bumped action's OWN issue/PR numbers,
// which happen to collide with local ticket numbers. No local closing keyword
// is present, because Dependabot never closes app tickets.
const DEPENDABOT_BODY = [
  'Bumps the github-actions group with 8 updates in the / directory:',
  '',
  '| Package | From | To |',
  '| --- | --- | --- |',
  '| [actions/checkout](https://github.com/actions/checkout) | `4.4.0` | `7.0.1` |',
  '',
  'Release notes:',
  '- See <a href="https://github.com/actions/checkout/pull/2521">actions/checkout#2521</a>',
  '- Fixes upstream (<a href="https://github.com/actions/checkout/issues/2531">#2531</a>)',
].join('\n');
const DEPENDABOT_BRANCH = 'dependabot/github_actions/github-actions-c46f977aae';

test('Fix C: a Dependabot changelog body does NOT link to any local ticket', () => {
  // The loose linker is what MADE the bug — assert it still would (so the test
  // proves the fix matters), then assert the strict parse does not.
  assert.deepEqual(flowAnomalySweep.prsForIssue([{ number: 2516, title: 'bump', body: DEPENDABOT_BODY, head: { ref: DEPENDABOT_BRANCH } }], 2521), [2516]);
  assert.deepEqual(parseCloses(DEPENDABOT_BODY, DEPENDABOT_BRANCH), []);
});

test('Fix C: a real "Closes #N" PR still links to its ticket', () => {
  const body = 'Closes #2524\n\n## What & why\nRender outcomes as plain text.';
  const branch = 'feat/2524-outcomes-plain-text';
  assert.deepEqual(parseCloses(body, branch), [2524]);
});

test('Fix C: issue-numbered branch alone still links (no closing keyword needed)', () => {
  assert.deepEqual(parseCloses('some description without a keyword', 'issue-2600'), [2600]);
});

test('Fix C wiring: admissionSweepTeam computes `closes` via parseCloses, not the loose linker', () => {
  const src = fs.readFileSync(path.join(__dirname, 'orchestrator.js'), 'utf8');
  const start = src.indexOf('async function admissionSweepTeam(teamId, ');
  const end = src.indexOf('const reconciled = admissionControl.reconcileInFlight');
  assert.ok(start !== -1 && end !== -1 && start < end, 'admissionSweepTeam body not found');
  const body = src.slice(start, end);
  assert.ok(
    /const closesFor = \(pr\) => \{[\s\S]*prEventsLog\.parseCloses\(/.test(body),
    'closesFor must use prEventsLog.parseCloses',
  );
  assert.ok(
    !/closesFor = \(pr\) => ticketNumbers\.filter\(\(n\) => flowAnomalySweep\.prsForIssue/.test(body),
    'the loose prsForIssue linker must not be used for admission keep-alive',
  );
});
