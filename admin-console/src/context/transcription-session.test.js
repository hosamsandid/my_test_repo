import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SEGMENT_MS,
  MAX_SEGMENT_RETRIES,
  GAP_MARKER,
  RECOVERY_KEY,
  STATES,
  nextState,
  isActiveState,
  isCapturingState,
  assembleTranscript,
  countGaps,
  countResolved,
  hasDeliverableContent,
  durationMinutes,
  formatElapsed,
  formatTranscriptMessage,
  buildRecoveryRecord,
  parseRecoveryRecord,
  shouldOfferRecovery,
} from './transcription-session.js';

test('constants have expected defaults', () => {
  assert.equal(SEGMENT_MS, 120_000);
  assert.equal(MAX_SEGMENT_RETRIES, 2);
  assert.equal(GAP_MARKER, '[transcription gap]');
  assert.equal(RECOVERY_KEY, 'transcription.recovery');
  assert.ok(STATES.includes('idle'));
  assert.ok(STATES.includes('delivery-failed'));
});

test('state machine: happy-path lifecycle', () => {
  assert.equal(nextState('idle', 'start'), 'recording');
  assert.equal(nextState('recording', 'pause'), 'paused');
  assert.equal(nextState('paused', 'resume'), 'recording');
  assert.equal(nextState('recording', 'stop'), 'stopping');
  assert.equal(nextState('paused', 'stop'), 'stopping');
  assert.equal(nextState('stopping', 'deliver'), 'delivering');
  assert.equal(nextState('delivering', 'delivered'), 'idle');
});

test('state machine: cancel, mic-end and delivery failure', () => {
  assert.equal(nextState('recording', 'cancel'), 'idle');
  assert.equal(nextState('paused', 'cancel'), 'idle');
  assert.equal(nextState('recording', 'end'), 'stopping');
  assert.equal(nextState('paused', 'end'), 'stopping');
  assert.equal(nextState('delivering', 'fail'), 'delivery-failed');
  assert.equal(nextState('delivery-failed', 'retry'), 'delivering');
  assert.equal(nextState('delivery-failed', 'discard'), 'idle');
  assert.equal(nextState('delivery-failed', 'delivered'), 'idle');
});

test('state machine: illegal transitions are no-ops', () => {
  assert.equal(nextState('idle', 'stop'), 'idle');
  assert.equal(nextState('recording', 'deliver'), 'recording');
  assert.equal(nextState('delivering', 'pause'), 'delivering');
  assert.equal(nextState('nonsense', 'start'), 'nonsense');
});

test('isActiveState / isCapturingState', () => {
  assert.equal(isActiveState('idle'), false);
  for (const s of ['recording', 'paused', 'stopping', 'delivering', 'delivery-failed']) {
    assert.equal(isActiveState(s), true, s);
  }
  assert.equal(isCapturingState('recording'), true);
  assert.equal(isCapturingState('paused'), false);
  assert.equal(isCapturingState('idle'), false);
});

test('assembleTranscript joins texts in order with a single space', () => {
  assert.equal(assembleTranscript(['hello there', 'general kenobi']), 'hello there general kenobi');
});

test('assembleTranscript trims segments and drops silent/empty ones', () => {
  assert.equal(assembleTranscript(['  a  ', '', '   ', 'b']), 'a b');
});

test('assembleTranscript renders null (lost) and gap markers positionally', () => {
  assert.equal(
    assembleTranscript(['intro', null, 'after gap']),
    `intro ${GAP_MARKER} after gap`
  );
  assert.equal(
    assembleTranscript(['intro', GAP_MARKER, 'after gap']),
    `intro ${GAP_MARKER} after gap`
  );
});

test('assembleTranscript of empty / all-silent input is empty', () => {
  assert.equal(assembleTranscript([]), '');
  assert.equal(assembleTranscript(['', '  ']), '');
  assert.equal(assembleTranscript(null), '');
});

test('countGaps / countResolved', () => {
  const segs = ['a', null, GAP_MARKER, '', 'b'];
  assert.equal(countGaps(segs), 2); // null + gap marker
  assert.equal(countResolved(segs), 4); // everything except the null slot
});

test('hasDeliverableContent', () => {
  assert.equal(hasDeliverableContent(['hi']), true);
  assert.equal(hasDeliverableContent([null, GAP_MARKER, '']), false);
  assert.equal(hasDeliverableContent([]), false);
  assert.equal(hasDeliverableContent(null), false);
});

test('durationMinutes rounds and has a floor of 1', () => {
  assert.equal(durationMinutes(0), 1);
  assert.equal(durationMinutes(20_000), 1);
  assert.equal(durationMinutes(90_000), 2); // 1.5 min → 2
  assert.equal(durationMinutes(5 * 60_000), 5);
});

test('formatElapsed renders M:SS', () => {
  assert.equal(formatElapsed(0), '0:00');
  assert.equal(formatElapsed(9), '0:09');
  assert.equal(formatElapsed(75), '1:15');
  assert.equal(formatElapsed(605), '10:05');
});

test('formatTranscriptMessage: clean transcript', () => {
  const msg = formatTranscriptMessage({
    startedAtLabel: 'Jan 1, 2026, 9:00 AM',
    durationMin: 4,
    transcript: 'hello world',
  });
  assert.equal(
    msg,
    '🎙️ Transcript — started Jan 1, 2026, 9:00 AM, duration 4 min\n\nhello world'
  );
});

test('formatTranscriptMessage: gaps and interruption notes', () => {
  const msg = formatTranscriptMessage({
    startedAtLabel: 'T',
    durationMin: 6,
    transcript: 'partial text',
    gapCount: 2,
    interrupted: true,
  });
  const lines = msg.split('\n');
  assert.equal(lines[0], '🎙️ Transcript — started T, duration 6 min');
  assert.equal(lines[1], '');
  assert.equal(lines[2], 'partial text');
  assert.equal(lines[3], '');
  assert.equal(lines[4], '(recording was interrupted — this is a partial transcript)');
  assert.equal(lines[5], '(2 segments could not be transcribed)');
});

test('formatTranscriptMessage: singular gap wording', () => {
  const msg = formatTranscriptMessage({ startedAtLabel: 'T', durationMin: 3, transcript: 'x', gapCount: 1 });
  assert.match(msg, /\(1 segment could not be transcribed\)/);
});

test('formatTranscriptMessage: empty transcript placeholder', () => {
  const msg = formatTranscriptMessage({ startedAtLabel: 'T', durationMin: 1, transcript: '' });
  assert.match(msg, /\(no speech was transcribed\)/);
});

test('recovery record: build + parse round-trip', () => {
  const rec = buildRecoveryRecord({
    tabId: 'tab-1',
    agentId: 'note-taker',
    agentName: 'Note Taker',
    startedAt: 1000,
    segments: ['a', null, GAP_MARKER],
    updatedAt: 2000,
  });
  const round = parseRecoveryRecord(JSON.stringify(rec));
  assert.equal(round.agentId, 'note-taker');
  assert.equal(round.agentName, 'Note Taker');
  assert.equal(round.tabId, 'tab-1');
  assert.equal(round.startedAt, 1000);
  assert.equal(round.updatedAt, 2000);
  assert.deepEqual(round.segments, ['a', null, GAP_MARKER]);
});

test('buildRecoveryRecord defaults agentName to agentId and coerces slots', () => {
  const rec = buildRecoveryRecord({ agentId: 'a', segments: ['x', undefined, 5] });
  assert.equal(rec.agentName, 'a');
  assert.deepEqual(rec.segments, ['x', null, null]);
});

test('parseRecoveryRecord rejects malformed input', () => {
  assert.equal(parseRecoveryRecord(null), null);
  assert.equal(parseRecoveryRecord('not json'), null);
  assert.equal(parseRecoveryRecord('{}'), null); // no agentId/segments
  assert.equal(parseRecoveryRecord(JSON.stringify({ agentId: 'a' })), null); // no segments
  assert.equal(parseRecoveryRecord(JSON.stringify({ segments: [] })), null); // no agentId
});

test('shouldOfferRecovery: offers a foreign record with content', () => {
  const rec = parseRecoveryRecord(JSON.stringify(
    buildRecoveryRecord({ tabId: 'other-tab', agentId: 'a', segments: ['some text'] })
  ));
  assert.equal(shouldOfferRecovery(rec, 'my-tab'), true);
});

test('shouldOfferRecovery: skips a same-live-tab record', () => {
  const rec = parseRecoveryRecord(JSON.stringify(
    buildRecoveryRecord({ tabId: 'my-tab', agentId: 'a', segments: ['some text'] })
  ));
  assert.equal(shouldOfferRecovery(rec, 'my-tab'), false);
});

test('shouldOfferRecovery: skips a record with no deliverable content', () => {
  const rec = parseRecoveryRecord(JSON.stringify(
    buildRecoveryRecord({ tabId: 'other', agentId: 'a', segments: [null, GAP_MARKER] })
  ));
  assert.equal(shouldOfferRecovery(rec, 'my-tab'), false);
  assert.equal(shouldOfferRecovery(null, 'my-tab'), false);
});
