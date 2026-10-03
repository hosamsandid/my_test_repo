'use strict';

// #2795: the hand-off readiness gate on channel ports (`readiness`) and on the
// derived / raw PR hand-off triggers (`readinessGate`).

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, buildMemberFromTemplate,
  expandGithubChannels, roleKeyOf, rawTriggerError,
  readinessError, cleanReadiness, mergeReadiness, triggerReadiness, readinessFailureLabel, normalizeReadinessGate,
} = require('./process-template');

const bundle = (ch) => ({
  id: 'b', name: 'B', processTemplateVersion: 1,
  roles: [
    { id: 'dev', displayName: 'Dev', role: 'developer' },
    { id: 'rev', displayName: 'Rev', role: 'code-reviewer', channels: [ch] },
  ],
});

test('cleanReadiness: canonical shape, defaults not stamped, both off = no gate', () => {
  assert.deepEqual(cleanReadiness({ ci: true, conflict: true }), { ci: true, conflict: true });
  assert.deepEqual(cleanReadiness({ ci: true, conflict: false, failureLabel: 'revisions-required', timeoutMinutes: 60 }),
    { ci: true, conflict: false });
  assert.deepEqual(cleanReadiness({ ci: false, conflict: true, failureLabel: ' fix-me ', timeoutMinutes: 30 }),
    { ci: false, conflict: true, failureLabel: 'fix-me', timeoutMinutes: 30 });
  assert.equal(cleanReadiness({ ci: false, conflict: false }), null);
  assert.equal(cleanReadiness(null), null);
  assert.equal(cleanReadiness({ ci: true, timeoutMinutes: 0 }), null, 'a malformed gate is not half-applied');
});

test('readinessError: types, label length, timeout range, failure label ≠ wake label', () => {
  assert.equal(readinessError(undefined), null);
  assert.equal(readinessError({ ci: true, conflict: true, failureLabel: 'x', timeoutMinutes: 10080 }), null);
  assert.match(readinessError([]), /must be an object/);
  assert.match(readinessError({ ci: 'yes' }), /ci must be true or false/);
  assert.match(readinessError({ ci: true, failureLabel: 'x'.repeat(51) }), /at most 50/);
  assert.match(readinessError({ ci: true, timeoutMinutes: 0 }), /1 to 10080/);
  assert.match(readinessError({ ci: true, timeoutMinutes: 10081 }), /1 to 10080/);
  assert.match(readinessError({ ci: true, timeoutMinutes: 1.5 }), /whole number/);
  assert.match(readinessError({ ci: true, failureLabel: 'ready' }, { wakeLabel: 'ready' }), /must differ/);
  assert.equal(readinessFailureLabel({ ci: true }), 'revisions-required');
  assert.equal(readinessFailureLabel({ ci: true, failureLabel: 'fix' }), 'fix');
  assert.equal(readinessFailureLabel(null), null);
});

test('mergeReadiness: any channel turns a gate on; first explicit label / timeout wins', () => {
  assert.deepEqual(mergeReadiness(null, { ci: true }), { ci: true, conflict: false });
  assert.deepEqual(
    mergeReadiness({ ci: true, failureLabel: 'a' }, { conflict: true, failureLabel: 'b', timeoutMinutes: 5 }),
    { ci: true, conflict: true, failureLabel: 'a', timeoutMinutes: 5 });
});

test('AC1: the derived PR listener carries the channel gate; an ungated channel stays ungated (AC12)', () => {
  const wired = expandGithubChannels({
    roles: [
      { id: 'dev', displayName: 'Dev', triggers: [] },
      {
        id: 'rev', displayName: 'Rev', triggers: [],
        channels: [
          { artifact: 'pr', from: 'dev', label: 'ready-for-review', readiness: { ci: true, conflict: true, timeoutMinutes: 90 } },
          { artifact: 'pr', from: 'dev', label: 'plain' },
          { artifact: 'issue', from: 'dev', label: 'spec', readiness: { ci: true } },
        ],
      },
    ],
  });
  const rev = wired.roles.find(r => r.id === 'rev');
  const gated = rev.triggers.find(t => t.labelFilter === 'ready-for-review');
  assert.deepEqual(gated.readinessGate, { ci: true, conflict: true, timeoutMinutes: 90 });
  assert.deepEqual(triggerReadiness(gated), gated.readinessGate);
  assert.ok(!('readinessGate' in rev.triggers.find(t => t.labelFilter === 'plain')));
  assert.ok(!('readinessGate' in rev.triggers.find(t => t.labelFilter === 'spec')), 'issue hand-offs are never gated');
});

test('fan-in: two producers on one label consolidate into ONE gated listener', () => {
  const wired = expandGithubChannels({
    roles: [
      { id: 'a', triggers: [] }, { id: 'b', triggers: [] },
      {
        id: 'rev', triggers: [],
        channels: [
          { artifact: 'pr', from: 'a', label: 'ready-for-review' },
          { artifact: 'pr', from: 'b', label: 'ready-for-review', readiness: { ci: true } },
        ],
      },
    ],
  });
  const listeners = wired.roles.find(r => r.id === 'rev').triggers.filter(t => t.labelFilter === 'ready-for-review');
  assert.equal(listeners.length, 1);
  assert.deepEqual(listeners[0].readinessGate, { ci: true, conflict: false });
});

test('validateProcessTemplate refuses a malformed or misplaced channel gate', () => {
  assert.equal(validateProcessTemplate(bundle({ artifact: 'pr', from: 'dev', label: 'r', readiness: { ci: true, conflict: true } })).ok, true);
  const same = validateProcessTemplate(bundle({ artifact: 'pr', from: 'dev', label: 'r', readiness: { ci: true, failureLabel: 'r' } }));
  assert.equal(same.ok, false);
  assert.match(same.error, /must differ/);
  const issue = validateProcessTemplate(bundle({ artifact: 'issue', from: 'dev', label: 'r', readiness: { ci: true } }));
  assert.equal(issue.ok, false);
  assert.match(issue.error, /only valid on a PR channel/);
  const timeout = validateProcessTemplate(bundle({ artifact: 'pr', from: 'dev', label: 'r', readiness: { ci: true, timeoutMinutes: -1 } }));
  assert.equal(timeout.ok, false);
});

test('rawTriggerError: a raw PR hand-off may carry a gate; other events may not', () => {
  const pr = { type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge', readinessGate: { ci: true, conflict: true } };
  assert.equal(rawTriggerError(pr), null);
  assert.match(rawTriggerError({ ...pr, readinessGate: { ci: true, failureLabel: 'ready-to-merge' } }), /must differ/);
  assert.match(rawTriggerError({ type: 'github-event', events: ['issues.labeled'], labelFilter: 'x', readinessGate: { ci: true } }),
    /only valid on a PR hand-off/);
  // Both toggles off = no gate, so it is harmless anywhere.
  assert.equal(rawTriggerError({ type: 'github-event', events: ['push'], readinessGate: { ci: false, conflict: false } }), null);
});

test('normalizeReadinessGate: canonical form in place; off/null clears the key', () => {
  const t = { readinessGate: { ci: true, conflict: false, timeoutMinutes: 60 } };
  normalizeReadinessGate(t);
  assert.deepEqual(t.readinessGate, { ci: true, conflict: false });
  const off = { readinessGate: { ci: false, conflict: false } };
  normalizeReadinessGate(off);
  assert.ok(!('readinessGate' in off));
  const cleared = { readinessGate: null };
  normalizeReadinessGate(cleared);
  assert.ok(!('readinessGate' in cleared));
});

test('round-trip: channel gate and raw trigger gate survive export → materialise', () => {
  const b = buildProcessTemplate({
    name: 'T', level: 'live', teamId: 'acme',
    roles: [
      { id: 'acme-developer', displayName: 'Dev', role: 'developer', triggers: [] },
      {
        id: 'acme-reviewer', displayName: 'Rev', role: 'code-reviewer',
        channels: [{ artifact: 'pr', from: 'acme-developer', label: 'ready-for-review', readiness: { ci: true, conflict: true } }],
        triggers: [{
          id: 'merge', type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-to-merge',
          readinessGate: { ci: true, conflict: true, failureLabel: 'fix-me' }, prompt: 'p',
        }],
      },
    ],
  });
  const rev = b.roles.find(r => r.id === roleKeyOf('acme-reviewer', 'acme'));
  assert.deepEqual(rev.channels[0].readiness, { ci: true, conflict: true });
  assert.deepEqual(rev.triggers.find(t => t.id === 'merge').readinessGate, { ci: true, conflict: true, failureLabel: 'fix-me' });
  const cr = templateToCustomRoles(b).find(r => r.id === rev.id);
  assert.deepEqual(cr.triggers.find(t => t.id === 'merge').readinessGate, { ci: true, conflict: true, failureLabel: 'fix-me' });
  const member = buildMemberFromTemplate(
    { ...cr, triggers: cr.triggers.map(t => ({ ...t, promptTemplate: t.prompt })) },
    { teamId: 'beta', memberId: 'beta-reviewer', vars: { repoFullName: 'o/r' } },
  );
  assert.deepEqual(member.triggers.find(t => t.id === 'merge').readinessGate, { ci: true, conflict: true, failureLabel: 'fix-me' });
});

test('live PUT /api/agents/:id keeps a channel readiness gate and refuses a malformed one (AC1, #2717)', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const src = fs.readFileSync(path.join(__dirname, 'api.js'), 'utf8');
  const start = src.indexOf('if (channels !== undefined) {');
  const block = src.slice(start, src.indexOf('channelsChanged = true;', start));
  assert.match(block, /readinessError\(c\.readiness, \{ wakeLabel: c\.label \}\)/);
  assert.match(block, /\{ readiness: cleanReadiness\(c\.readiness\) \}/);
  // Both trigger write routes persist the canonical gate.
  assert.equal(src.match(/normalizeReadinessGate\((newTrigger|merged)\);/g).length, 2);
});
