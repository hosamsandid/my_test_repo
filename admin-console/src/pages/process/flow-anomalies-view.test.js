import test from 'node:test';
import assert from 'node:assert/strict';

import {
  anomalyView,
  formatAge,
  anomalyCountByNode,
  summarize,
  classInfo,
} from './flow-anomalies-view.js';

test('anomalyView maps a detector anomaly into render data', () => {
  const a = {
    class: 'wake-not-claimed', severity: 'warning', label: 'ready',
    object: { kind: 'issue', number: 902, url: 'https://gh/issues/902', title: 'X', state: 'open' },
    agentId: 'team-developer', ageMs: 20 * 60000, message: 'msg', evidence: [{ type: 'issue', text: '#902', url: 'u' }],
  };
  const v = anomalyView(a);
  assert.equal(v.title, 'Wake not claimed');
  assert.equal(v.severity, 'warning');
  assert.equal(v.objectRef, 'issue #902');
  assert.equal(v.objectUrl, 'https://gh/issues/902');
  assert.equal(v.agentId, 'team-developer');
  assert.equal(v.age, '20m');
  assert.equal(v.evidence.length, 1);
});

test('anomalyView labels a PR object as PR', () => {
  const v = anomalyView({ class: 'output-missing', object: { kind: 'pr', number: 949 } });
  assert.equal(v.objectRef, 'PR #949');
  assert.equal(v.title, 'Output missing');
});

test('anomalyView always exposes the class blurb, even alongside an instance message', () => {
  // Detector supplied its own message → message keeps it, blurb stays the class explanation.
  const withMsg = anomalyView({ class: 'claim-stalled', message: 'issue #7 stalled 3h' });
  assert.equal(withMsg.message, 'issue #7 stalled 3h');
  assert.equal(withMsg.blurb, classInfo('claim-stalled').blurb);
  assert.notEqual(withMsg.blurb, '');
  // No detector message → message falls back to the blurb (row de-dupes the subtitle).
  const noMsg = anomalyView({ class: 'gate-idle' });
  assert.equal(noMsg.message, classInfo('gate-idle').blurb);
  assert.equal(noMsg.blurb, noMsg.message);
});

test('formatAge renders minutes, hours, days', () => {
  assert.equal(formatAge(30 * 1000), 'just now');
  assert.equal(formatAge(5 * 60000), '5m');
  assert.equal(formatAge(3 * 3600000), '3h');
  assert.equal(formatAge(3 * 24 * 3600000), '3d');
  assert.equal(formatAge(null), '');
});

test('anomalyCountByNode counts per agent and ignores agent-less gate-idle', () => {
  const counts = anomalyCountByNode([
    { class: 'wake-not-claimed', agentId: 'a' },
    { class: 'claim-stalled', agentId: 'a' },
    { class: 'output-missing', agentId: 'b' },
    { class: 'gate-idle', agentId: null },
  ]);
  assert.deepEqual(counts, { a: 2, b: 1 });
});

test('summarize aggregates by class + total', () => {
  const s = summarize([
    { class: 'wake-not-claimed' }, { class: 'wake-not-claimed' }, { class: 'gate-idle' },
  ]);
  assert.equal(s.total, 3);
  assert.deepEqual(s.byClass, { 'wake-not-claimed': 2, 'gate-idle': 1 });
});

test('classInfo falls back gracefully on an unknown class', () => {
  const info = classInfo('mystery');
  assert.equal(info.title, 'mystery');
  assert.equal(info.severity, 'info');
});

test('#2814 anomalyCountByNode folds a pool instance\'s anomalies onto its role node', () => {
  const counts = anomalyCountByNode(
    [{ agentId: 'acme-spec-i71' }, { agentId: 'acme-spec' }, { agentId: 'acme-dev' }],
    { 'acme-spec-i71': 'acme-spec' },
  );
  assert.deepEqual(counts, { 'acme-spec': 2, 'acme-dev': 1 });
});
