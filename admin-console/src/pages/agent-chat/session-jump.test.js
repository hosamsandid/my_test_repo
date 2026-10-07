import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SHOW_IN_SESSION_LABEL,
  JUMP_HIGHLIGHT_MS,
  sessionJumpRef,
  buildSessionJumpRequest,
  firstRowKeyForCorrelation,
  revealStatus,
  jumpHighlightCss,
  sessionNotFoundText,
} from './session-jump.js';
import { hoverDimCss } from './hover-highlight.js';

const AGENT = '@agent:local';
const keyOf = (row, i) => row._key ?? `e${i}`;

test('label is the one the issue names (tooltip + aria-label)', () => {
  assert.equal(SHOW_IN_SESSION_LABEL, 'Show in session log');
});

test('sessionJumpRef: a user message names its own run', () => {
  const msg = { event_id: '$u1', sender: '@alice:local', body: 'hi', msgtype: 'm.text' };
  assert.deepEqual(sessionJumpRef(msg, AGENT), { correlationId: '$u1' });
});

test('sessionJumpRef: an agent reply is resolved by its event id', () => {
  const msg = { event_id: '$r1', sender: AGENT, body: 'done', msgtype: 'm.text' };
  assert.deepEqual(sessionJumpRef(msg, AGENT), { eventId: '$r1' });
});

test('sessionJumpRef: a trigger notice carrying its correlationId names that run', () => {
  const msg = {
    event_id: '$n1', sender: AGENT, msgtype: 'm.notice',
    'io.aee.trigger': { triggerId: 't1', triggerType: 'github-event', correlationId: 'trigger:t1:gh:e1' },
  };
  assert.deepEqual(sessionJumpRef(msg, AGENT), { correlationId: 'trigger:t1:gh:e1' });
  const cron = { ...msg, 'io.aee.trigger': { triggerId: 't2', correlationId: 'trigger:t2:1700000000' } };
  assert.deepEqual(sessionJumpRef(cron, AGENT), { correlationId: 'trigger:t2:1700000000' });
});

test('sessionJumpRef: no button without a correlationId or log rows (AC2)', () => {
  // A trigger notice posted before the notice carried its correlationId.
  const legacyNotice = {
    event_id: '$n0', sender: AGENT, msgtype: 'm.notice',
    'io.aee.trigger': { triggerId: 't1', triggerType: 'cron', event: null },
  };
  assert.equal(sessionJumpRef(legacyNotice, AGENT), null);
  // Loop-record cards and transcript separators.
  assert.equal(sessionJumpRef({ event_id: '$l', sender: AGENT, 'io.aee.loop-record': {} }, AGENT), null);
  assert.equal(sessionJumpRef({ type: 'context-reset', event_id: 'sep-1', ts: 1 }, AGENT), null);
  assert.equal(sessionJumpRef({ type: 'user-stop', event_id: 'sep-2', ts: 1 }, AGENT), null);
  // Not yet confirmed: no stable event id.
  assert.equal(sessionJumpRef({ event_id: '~local', sender: '@a:local', isOptimistic: true }, AGENT), null);
  assert.equal(sessionJumpRef({ sender: '@a:local' }, AGENT), null);
  assert.equal(sessionJumpRef(null, AGENT), null);
});

test('sessionJumpRef: an agent m.notice without a correlationId gets no button (no message.posted row)', () => {
  const backstop = {
    event_id: '$b1', sender: AGENT, msgtype: 'm.notice', body: '⚠️ **Trigger backstop active** — …',
    'io.aee.backstop': { reason: 'rate', active: 3, windowCount: 12, maxConcurrent: 3, maxPerWindow: 10 },
  };
  assert.equal(sessionJumpRef(backstop, AGENT), null);
  const legacyFailure = {
    event_id: '$f0', sender: AGENT, msgtype: 'm.notice', body: '⚠️ **Triggered run failed** — …',
    'io.aee.triggerFailure': { triggerId: 't1', triggerType: 'github-event' },
  };
  assert.equal(sessionJumpRef(legacyFailure, AGENT), null);
  // A plain notice, even without any io.aee key, is never resolved by event id.
  assert.equal(sessionJumpRef({ event_id: '$p', sender: AGENT, msgtype: 'm.notice', body: 'x' }, AGENT), null);
});

test('sessionJumpRef: a trigger-failure notice carrying its correlationId names that run', () => {
  const msg = {
    event_id: '$f1', sender: AGENT, msgtype: 'm.notice', 'io.aee.trigger': null,
    'io.aee.triggerFailure': { triggerId: 't1', triggerType: 'cron', correlationId: 'trigger:t1:1700000000' },
  };
  assert.deepEqual(sessionJumpRef(msg, AGENT), { correlationId: 'trigger:t1:1700000000' });
});

test('sessionJumpRef: agent error / abort replies are m.text and resolve by event id', () => {
  const err = { event_id: '$e1', sender: AGENT, msgtype: 'm.text', body: '⚠️ **Agent error**\n\n```\nboom\n```' };
  assert.deepEqual(sessionJumpRef(err, AGENT), { eventId: '$e1' });
});

test('buildSessionJumpRequest: the #642 selectRequest shape plus reveal/source', () => {
  assert.deepEqual(buildSessionJumpRequest({ correlationId: '$u1' }, 42), {
    correlationId: '$u1', eventId: null, reveal: true, source: 'message', ts: 42,
  });
  assert.deepEqual(buildSessionJumpRequest({ eventId: '$r1' }, 43), {
    correlationId: null, eventId: '$r1', reveal: true, source: 'message', ts: 43,
  });
  assert.equal(buildSessionJumpRequest(null, 1), null);
  assert.equal(buildSessionJumpRequest({}, 1), null);
});

test('buildSessionJumpRequest: a repeat click is a new request', () => {
  const a = buildSessionJumpRequest({ correlationId: '$u1' }, 1);
  const b = buildSessionJumpRequest({ correlationId: '$u1' }, 2);
  assert.notDeepEqual(a, b);
});

test('firstRowKeyForCorrelation: first row of the run inside a combined log', () => {
  const rows = [
    { _key: 'a', correlationId: '$u1', type: 'message.received' },
    { _key: 'b', correlationId: '$u1', type: 'message.posted' },
    { _key: 'c', correlationId: '$u2', type: 'message.received' },
    { _key: 'd', correlationId: '$u2', type: 'result' },
  ];
  assert.equal(firstRowKeyForCorrelation(rows, '$u2', keyOf), 'c');
  assert.equal(firstRowKeyForCorrelation(rows, '$u1', keyOf), 'a');
  assert.equal(firstRowKeyForCorrelation(rows, '$none', keyOf), null);
  assert.equal(firstRowKeyForCorrelation(rows, null, keyOf), null);
  assert.equal(firstRowKeyForCorrelation(null, '$u1', keyOf), null);
});

test('firstRowKeyForCorrelation: falls back to the index key', () => {
  const rows = [{ correlationId: 'x' }, { correlationId: 'trigger:t:1' }];
  assert.equal(firstRowKeyForCorrelation(rows, 'trigger:t:1', keyOf), 'e1');
});

test('revealStatus: pending while loading, then found or missing (AC6)', () => {
  const rows = [{ _key: 'a', correlationId: '$u1' }];
  assert.equal(revealStatus({ loading: true, rows: [], correlationId: '$u1', keyOf }), 'pending');
  assert.equal(revealStatus({ loading: false, rows, correlationId: '$u1', keyOf }), 'found');
  assert.equal(revealStatus({ loading: false, rows, correlationId: '$u9', keyOf }), 'missing');
});

test('jumpHighlightCss: flashes every row of the run, scoped and escaped', () => {
  const css = jumpHighlightCss('log', 'trigger:a"b');
  assert.match(css, /@keyframes sessionJumpFlash/);
  assert.ok(css.includes('[data-hover-scope="log"] [data-cid="trigger:a\\"b"]'));
  assert.ok(css.includes(`${JUMP_HIGHLIGHT_MS}ms`));
  assert.equal(jumpHighlightCss('log', null), '');
});

test('jumpHighlightCss: lifts the run out of a hover dim (visible without hovering)', () => {
  // Same selector specificity as the dim rule; emitted after it, so it wins.
  const dim = hoverDimCss('log', '$other');
  assert.match(dim, /opacity:0\.35/);
  assert.match(jumpHighlightCss('log', '$u1'), /\[data-cid="\$u1"\]\{[^}]*opacity:1;/);
});

test('sessionNotFoundText: message jumps get their own wording', () => {
  assert.match(sessionNotFoundText('message'), /this message/);
  // Run-less status posts (e.g. "Trigger possibly lost") keep the button and
  // land here, so the text must not claim the log was pruned as the only cause.
  assert.match(sessionNotFoundText('message'), /status post that doesn't belong to a run/);
  assert.match(sessionNotFoundText(undefined), /this event triggered/);
});
