import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeSyncStream,
  repoStatusText,
  repoStatusSymbol,
  summaryText,
} from './sync-repos-view.js';

// Synthetic OK response whose body streams the given chunks.
function streamedRes(chunks) {
  const enc = new TextEncoder();
  return {
    body: new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(enc.encode(c));
        controller.close();
      },
    }),
  };
}

test('consumeSyncStream forwards every event and resolves with the complete payload', async () => {
  const events = [];
  const complete = await consumeSyncStream(streamedRes([
    '{"type":"plan","agentCount":1}\n',
    '{"type":"agent","agentId":"a1","displayName":"Agent 1"}\n',
    '{"type":"repo","agentId":"a1","name":"widgets","status":"cloned"}\n',
    '{"type":"agent-done","agentId":"a1","summary":{"total":1,"cloned":1,"skipped":0,"failed":0}}\n',
    '{"type":"complete","agentCount":1,"totals":{"total":1,"cloned":1,"skipped":0,"failed":0}}\n',
  ]), (ev) => events.push(ev.type));
  assert.deepEqual(events, ['plan', 'agent', 'repo', 'agent-done', 'complete']);
  assert.equal(complete.totals.cloned, 1);
});

test('consumeSyncStream reassembles a line split across chunks', async () => {
  const complete = await consumeSyncStream(streamedRes([
    '{"type":"comple', 'te","agentCount":1,"totals":{"cloned":2}}\n',
  ]), null);
  assert.equal(complete.totals.cloned, 2);
});

test('consumeSyncStream throws with status on a terminal error event', async () => {
  await assert.rejects(
    consumeSyncStream(streamedRes(['{"type":"error","status":404,"error":"Environment not found"}\n']), null),
    (err) => err.status === 404 && /not found/i.test(err.message));
});

test('consumeSyncStream resolves null when the stream carries no complete event', async () => {
  const complete = await consumeSyncStream(streamedRes([
    '{"type":"agent","agentId":"a1"}\n',
  ]), null);
  assert.equal(complete, null);
});

test('repoStatusText maps each outcome to a human label', () => {
  assert.equal(repoStatusText('cloned'), 'Cloned');
  assert.equal(repoStatusText('failed'), 'Failed');
  assert.equal(repoStatusText('skipped', 'already-present'), 'Already present');
  assert.match(repoStatusText('skipped', 'path-occupied'), /non-git folder/);
  assert.equal(repoStatusText('skipped'), 'Already present');
});

test('repoStatusSymbol distinguishes clone / fail / skip', () => {
  assert.equal(repoStatusSymbol('cloned'), '✓');
  assert.equal(repoStatusSymbol('failed'), '✗');
  assert.equal(repoStatusSymbol('skipped'), '·');
});

test('summaryText omits zero buckets and handles the nothing-to-do case', () => {
  assert.equal(summaryText({ cloned: 3, skipped: 2, failed: 1 }), '3 cloned, 2 already present, 1 failed.');
  assert.equal(summaryText({ cloned: 0, skipped: 2, failed: 0 }), '2 already present.');
  assert.equal(summaryText({ cloned: 1, skipped: 0, failed: 0 }), '1 cloned.');
  assert.match(summaryText({ cloned: 0, skipped: 0, failed: 0 }), /Nothing to sync/);
  assert.match(summaryText(null), /Nothing to sync/);
});
