'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { missingWakeLabels, wakeLabelRepos, missingWakeLabelLints, missingWakeLabelWarnings } = require('./missing-wake-labels');

const REPO = 'AccentureCodeFoundry/314092_agent-execution-environment';
const trig = (id, labelFilter, extra = {}) => ({ id, type: 'github-event', repo: REPO, events: ['pull_request.labeled'], labelFilter, ...extra });
// Team agent-studio-3-0 on 2026-10-06: every wake label exists except the
// Developer -> Code Reviewer edge's `ready-for-code-review-prod`.
const MEMBERS = [
  { id: 'agent-studio-3-0-developer', triggers: [trig('t-dev', 'ready-prod')] },
  { id: 'agent-studio-3-0-code-reviewer', triggers: [trig('t1791210903422', 'ready-for-code-review-prod'), trig('t-rr', 'ready-for-review-prod')] },
  { id: 'agent-studio-3-0-reworker', triggers: [trig('t-rw', 'revisions-required-prod')] },
  { id: 'agent-studio-3-0-cron', triggers: [{ id: 'c', type: 'cron', cron: '* * * * *' }] },
];
const REPO_LABELS = { [REPO]: ['ready-prod', 'Ready-For-Review-Prod', 'revisions-required-prod', 'bug'] };

test('missingWakeLabels: reports exactly the missing ready-for-code-review-prod (#2878 AC1)', () => {
  assert.deepEqual(missingWakeLabels(MEMBERS, REPO_LABELS), [
    { repo: REPO, label: 'ready-for-code-review-prod', agentId: 'agent-studio-3-0-code-reviewer', triggerId: 't1791210903422' },
  ]);
});

test('missingWakeLabels: case-insensitive, unreadable repos and disabled triggers are never reported', () => {
  assert.deepEqual(missingWakeLabels(MEMBERS, {}), []); // no labels read → unknown, not missing
  const off = [{ id: 'a', triggers: [trig('t', 'nope', { enabled: false })] }];
  assert.deepEqual(missingWakeLabels(off, REPO_LABELS), []);
  const anyLabel = [{ id: 'a', triggers: [trig('t', '')] }];
  assert.deepEqual(missingWakeLabels(anyLabel, REPO_LABELS), []);
  // Once the label exists, the lint clears (AC2).
  assert.deepEqual(missingWakeLabels(MEMBERS, { [REPO]: [...REPO_LABELS[REPO], 'ready-for-code-review-prod'] }), []);
});

test('wakeLabelRepos: the repositories of enabled label triggers, once each', () => {
  assert.deepEqual(wakeLabelRepos(MEMBERS), [REPO]);
  assert.deepEqual(wakeLabelRepos([{ id: 'a', triggers: [trig('t', 'x', { enabled: false })] }]), []);
});

test('missingWakeLabelLints / Warnings: one per (repo, label), naming every listener', () => {
  const missing = [
    { repo: REPO, label: 'x', agentId: 'a', triggerId: 't1' },
    { repo: REPO, label: 'x', agentId: 'b', triggerId: 't2' },
    { repo: REPO, label: 'x', agentId: 'a', triggerId: 't3' },
  ];
  const lints = missingWakeLabelLints(missing);
  assert.equal(lints.length, 1);
  assert.deepEqual({ ...lints[0], message: undefined }, { code: 'wake-label-missing', severity: 'warning', label: 'x', repo: REPO, nodeId: 'a', message: undefined });
  assert.match(lints[0].message, /`x` does not exist on .*`a`, `b` can never be woken by it/);
  assert.deepEqual(missingWakeLabelWarnings(missing), [`Wake label 'x' does not exist on ${REPO} — its hand-off can never fire. Create it on GitHub or from the Flow editor.`]);
});

test('api.js wiring: both live graph endpoints add the lint for one team; materialise checks; Create label is gated (source guard)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const route = (marker) => src.slice(src.indexOf(marker), src.indexOf('\napp.', src.indexOf(marker) + 1));
  for (const marker of ["app.get('/api/process/graph'", "app.get('/api/flows/graph'"]) {
    assert.match(route(marker), /if \(team\) \{\s*const labels = await fetchRepoLabels\(wakeLabelRepos\(/, marker);
  }
  const create = route("app.post('/api/teams/:teamId/repo-labels'");
  assert.match(create, /if \(!canManageTeam\(scope, teamId\)\) return denyAdmin\(res, 'You may not manage this team'\)/);
  assert.match(create, /t\.labelFilter\.trim\(\) === label/); // only a label the team listens on
  assert.doesNotMatch(create, /req\.body\.actor/);
  assert.match(route("app.get('/api/teams/:teamId/missing-labels'"), /if \(!visibleTeam\(scope, teamId\)\)/);
  assert.match(src, /provWarn\.push\(\.\.\.await missingLabelWarningsFor\(teamId\)\);/);
  assert.match(src, /\[\.\.\.provWarn, \.\.\.await missingLabelWarningsFor\(teamId\)\]/);
});
