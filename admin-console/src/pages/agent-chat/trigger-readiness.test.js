import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import serverPt from '../../../api/process-template.js';
import {
  showsReadinessGate, readinessFormFor, readinessWakeWhen, readinessGateBody, readinessHint,
} from './trigger-readiness.js';
import { readinessFormError } from '../process/readiness-gate.js';

// #2912 — the hand-off readiness gate in Agent Chat → Triggers.

const pr = (extra = {}) => ({ type: 'github-event', events: ['pull_request.labeled'], labelFilter: 'ready-for-review', ...extra });

test('AC1/AC3: the section shows on a PR hand-off only — the API\'s READINESS_EVENTS', () => {
  for (const e of serverPt.READINESS_EVENTS) assert.equal(showsReadinessGate('github-event', [e]), true, e);
  for (const e of ['issues.labeled', 'issues.opened', 'push', 'issue_comment.created', 'pull_request.unlabeled',
    'pull_request.merged', 'pull_request.checks_passed', 'pull_request_review.submitted']) {
    assert.equal(showsReadinessGate('github-event', [e]), false, e);
  }
  for (const type of ['cron', 'once', 'http', 'loop', 'plugin-event', 'data-flow']) {
    assert.equal(showsReadinessGate(type, ['pull_request.labeled']), false, type);
  }
  assert.equal(showsReadinessGate('github-event', []), false);
  assert.equal(showsReadinessGate('github-event', undefined), false);
});

test('edge case: several events, only some PR-eligible → the section is shown', () => {
  assert.equal(showsReadinessGate('github-event', ['issues.labeled', 'pull_request.labeled']), true);
});

test('AC4: creating with a toggle on persists the gate; off sends nothing; defaults are not written (AC2)', () => {
  const on = { ...readinessFormFor(null), ci: true };
  assert.deepEqual(readinessGateBody({ show: true, form: on, isEdit: false }), { ci: true, conflict: false });
  assert.deepEqual(readinessGateBody({ show: true, form: { ...on, conflict: true, failureLabel: 'fix-me', timeoutMinutes: '30' }, isEdit: false }),
    { ci: true, conflict: true, failureLabel: 'fix-me', timeoutMinutes: 30 });
  assert.equal(readinessGateBody({ show: true, form: readinessFormFor(null), isEdit: false }), undefined, 'a new trigger is never gated silently');
  assert.equal(readinessGateBody({ show: false, form: on, isEdit: false }), undefined, 'hidden section → no gate');
  // What the API stores is exactly what was sent.
  const t = pr({ readinessGate: readinessGateBody({ show: true, form: on, isEdit: false }) });
  assert.equal(serverPt.rawTriggerError(t), null);
  serverPt.normalizeReadinessGate(t);
  assert.deepEqual(t.readinessGate, { ci: true, conflict: false });
});

test('AC5: edit shows the stored gate; untouched → field omitted; both off → null', () => {
  const stored = { ci: true, conflict: true, failureLabel: 'fix-me', timeoutMinutes: 30 };
  const form = readinessFormFor(pr({ readinessGate: stored }));
  assert.deepEqual(form, { ci: true, conflict: true, failureLabel: 'fix-me', timeoutMinutes: '30' });
  assert.equal(readinessGateBody({ show: true, form, stored, isEdit: true }), undefined, 'other fields edited → gate untouched');
  assert.equal(readinessGateBody({ show: true, form: { ...form, ci: false, conflict: false }, stored, isEdit: true }), null);
  assert.deepEqual(readinessGateBody({ show: true, form: { ...form, conflict: false }, stored, isEdit: true }),
    { ci: true, conflict: false, failureLabel: 'fix-me', timeoutMinutes: 30 });
  // An ungated trigger opens — and saves — ungated.
  assert.deepEqual(readinessFormFor(pr()), readinessFormFor(null));
  assert.equal(readinessGateBody({ show: true, form: readinessFormFor(pr()), stored: undefined, isEdit: true }), undefined);
  assert.deepEqual(readinessGateBody({ show: true, form: { ...readinessFormFor(pr()), conflict: true }, stored: undefined, isEdit: true }),
    { ci: false, conflict: true });
});

test('AC5: an event no longer gateable clears a stored gate (the API would refuse it)', () => {
  const stored = { ci: true, conflict: true };
  assert.equal(readinessGateBody({ show: false, form: readinessFormFor(pr({ readinessGate: stored })), stored, isEdit: true }), null);
  assert.equal(readinessGateBody({ show: false, form: readinessFormFor(null), stored: undefined, isEdit: true }), undefined);
});

test('edge case: the dialog refuses what the API refuses — failure label equal to the wake label', () => {
  const on = { ...readinessFormFor(null), ci: true };
  assert.match(readinessFormError(on, { wakeLabel: 'revisions-required' }), /must differ/);
  assert.match(serverPt.rawTriggerError(pr({ labelFilter: 'revisions-required', readinessGate: { ci: true } })), /must differ/);
  // No wake label (PR opened, or a labelled listener without a filter): the API accepts the gate, so does the dialog.
  assert.equal(readinessFormError(on, { wakeLabel: '' }), null);
  assert.equal(serverPt.rawTriggerError({ type: 'github-event', events: ['pull_request.opened'], readinessGate: { ci: true } }), null);
  assert.equal(serverPt.rawTriggerError({ type: 'github-event', events: ['pull_request.labeled'], readinessGate: { ci: true } }), null);
});

test('the "Off: …" text names what wakes the agent', () => {
  assert.equal(readinessWakeWhen(['pull_request.labeled']), 'the label is set');
  assert.equal(readinessWakeWhen(['pull_request.opened']), 'the PR is opened');
  assert.equal(readinessWakeWhen(['pull_request.reopened']), 'the PR is reopened');
});

test('AC7: the list hint for a gated PR hand-off, like the Flow editor\'s "· waits for …"', () => {
  assert.deepEqual(readinessHint(pr({ readinessGate: { ci: true, conflict: true } })).text, 'waits for CI + conflict-free');
  assert.equal(readinessHint(pr({ readinessGate: { ci: true, conflict: false } })).text, 'waits for CI');
  assert.equal(readinessHint(pr({ readinessGate: { ci: false, conflict: true } })).text, 'waits for conflict-free');
  assert.match(readinessHint(pr({ readinessGate: { ci: true, conflict: true } })).title, /^Waits for CI and a conflict-free PR \(60 min/);
  assert.equal(readinessHint(pr()), null);
  assert.equal(readinessHint(pr({ readinessGate: { ci: false, conflict: false } })), null);
  assert.equal(readinessHint({ type: 'github-event', events: ['issues.labeled'], readinessGate: { ci: true } }), null);
  assert.equal(readinessHint({ type: 'cron', readinessGate: { ci: true } }), null);
  assert.equal(readinessHint(null), null);
});

test('AC8: a flow-derived listener shows the combined gate the reconcile derived', () => {
  const roles = serverPt.expandGithubChannels({
    roles: [
      { id: 'dev', displayName: 'Dev' },
      { id: 'ops', displayName: 'Ops' },
      { id: 'rev', displayName: 'Rev', channels: [
        { artifact: 'pr', from: 'dev', label: 'ready', readiness: { ci: true, conflict: false } },
        { artifact: 'pr', from: 'ops', label: 'ready', readiness: { ci: false, conflict: true } },
      ] },
    ],
  }).roles;
  const t = roles.find(r => r.id === 'rev').triggers[0];
  assert.deepEqual(readinessFormFor(t), { ci: true, conflict: true, failureLabel: 'revisions-required', timeoutMinutes: '60' });
  assert.equal(readinessHint(t).text, 'waits for CI + conflict-free');
});

test('source: TriggerForm renders the shared gate section and sends only a change (#651 guard)', () => {
  const src = readFileSync(new URL('./TriggersPanel.jsx', import.meta.url), 'utf8');
  assert.match(src, /import ReadinessGateFields from '\.\.\/process\/ReadinessGateFields';/);
  assert.match(src, /const showGate = showReadinessGate && showsReadinessGate\(form\.type, form\.events\);/);
  assert.match(src, /readiness: {3}readinessFormFor\(initialValues\),/);
  assert.match(src, /if \(readinessErr\) \{ setFormError\(readinessErr\); return; \}/);
  assert.match(src, /show: showGate, form: form\.readiness, stored: initialValues\?\.readinessGate, isEdit,/);
  assert.match(src, /if \(gate !== undefined\) body\.readinessGate = gate;/);
  assert.match(src, /\{showGate && \(\s*<ReadinessGateFields/);
  assert.match(src, /error=\{readinessErr\}/);
  // Both Agent Chat dialogs (add + edit) opt in; the Flow editor's embedded forms do not.
  assert.equal(src.match(/\n\s+showReadinessGate\n/g).length, 2);
  // The row hint.
  assert.match(src, /const gateHint = ghSummary \? readinessHint\(trigger\) : null;/);
  assert.match(src, /\{gateHint && <span title=\{gateHint\.title\}>\{` · \$\{gateHint\.text\}`\}<\/span>\}/);
});
