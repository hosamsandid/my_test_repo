import test from 'node:test';
import assert from 'node:assert/strict';

import {
  consumeSyncStream,
  repoStatusText,
  repoStatusSymbol,
  summaryText,
  syncEventRow,
  repoRowTone,
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
  assert.equal(repoStatusText('adjusted'), 'Brought up to date');
  assert.equal(repoStatusText('failed'), 'Failed');
  assert.equal(repoStatusText('skipped', 'already-present'), 'Already up to date');
  assert.equal(repoStatusText('skipped'), 'Already up to date');
  assert.match(repoStatusText('retained'), /nothing deleted/);
});

// A D1 safety skip (#2066) must tell the reader what blocks THIS clone — the
// stable reason code supplies the lead, the orchestrator's detail the specifics.
test('a D1 safety skip reads as left-alone plus the blocking detail', () => {
  assert.equal(
    repoStatusText('skipped', 'uncommitted-changes', '2 modified files — commit or discard them, then catch up'),
    'Left alone — uncommitted work: 2 modified files — commit or discard them, then catch up',
  );
  assert.equal(repoStatusText('skipped', 'unpushed-commits'), 'Left alone — unpushed work');
  assert.match(repoStatusText('skipped', 'foreign-remote'), /changed by hand/);
  assert.match(repoStatusText('skipped', 'path-occupied', 'a folder that is not a git checkout'), /Left alone: a folder/);
});

test('repoStatusSymbol keeps a blocked skip apart from a failure and a no-op', () => {
  assert.equal(repoStatusSymbol('cloned'), '✓');
  assert.equal(repoStatusSymbol('adjusted'), '✓');
  assert.equal(repoStatusSymbol('failed'), '✗');
  assert.equal(repoStatusSymbol('skipped'), '·');
  assert.equal(repoStatusSymbol('skipped', true), '!', 'a safety skip is neither a success nor a failure');
  assert.equal(repoStatusSymbol('retained'), '·');
});

test('summaryText omits zero buckets and handles the nothing-to-do case', () => {
  assert.equal(summaryText({ cloned: 3, skipped: 2, failed: 1 }), '3 cloned, 2 already up to date, 1 failed.');
  assert.equal(summaryText({ cloned: 0, skipped: 2, failed: 0 }), '2 already up to date.');
  assert.equal(summaryText({ cloned: 1, skipped: 0, failed: 0 }), '1 cloned.');
  assert.match(summaryText({ cloned: 0, skipped: 0, failed: 0 }), /Nothing to do/);
  assert.match(summaryText(null), /Nothing to do/);
});

test('blocked skips are reported as their own bucket, not folded into skipped', () => {
  // Otherwise "3 already up to date" would quietly include one that needs a push.
  assert.equal(
    summaryText({ cloned: 0, adjusted: 1, skipped: 3, blocked: 1, failed: 0 }),
    '1 brought up to date, 2 already up to date, 1 left alone.',
  );
  assert.equal(summaryText({ skipped: 1, blocked: 1 }), '1 left alone.');
  assert.equal(summaryText({ retained: 2 }), '2 kept.');
});

// ── syncEventRow / repoRowTone ─────────────────────────────────────────────

test('syncEventRow renders a repo line with its applied operations', () => {
  const row = syncEventRow({
    type: 'repo', name: 'widgets', status: 'adjusted', applied: ['fetched', 'branch → dev'],
  });
  assert.equal(row.kind, 'repo');
  assert.equal(row.symbol, '✓');
  assert.equal(row.text, 'widgets — Brought up to date (fetched; branch → dev)');
});

test('syncEventRow marks a blocked skip so the surface can tone it apart', () => {
  const row = syncEventRow({
    type: 'repo', name: 'widgets', status: 'skipped', reason: 'unpushed-commits',
    detail: '2 commits not pushed', blocked: true,
  });
  assert.equal(row.symbol, '!');
  assert.equal(row.blocked, true);
  assert.match(row.text, /2 commits not pushed/);
  assert.equal(repoRowTone('skipped', true), 'var(--eb-status-warning)');
  assert.equal(repoRowTone('failed'), 'var(--eb-status-error)');
  assert.equal(repoRowTone('adjusted'), 'var(--eb-status-success)');
  assert.equal(repoRowTone('skipped'), 'var(--eb-text-secondary)');
});

test('syncEventRow drops the agent header unless the surface groups by agent', () => {
  assert.equal(syncEventRow({ type: 'agent', agentId: 'a1' }), null);
  assert.deepEqual(
    syncEventRow({ type: 'agent', agentId: 'a1', displayName: 'Dev' }, { showAgentHeaders: true }),
    { kind: 'agent', text: 'Dev' },
  );
});

test('syncEventRow surfaces the stub and unreachable-agent cases', () => {
  assert.match(syncEventRow({ type: 'agent-skip' }).text, /start the agent/);
  const unreachable = syncEventRow({ type: 'agent-error', error: 'boom' });
  assert.equal(unreachable.status, 'failed');
  assert.match(unreachable.text, /Could not reach this agent: boom/);
});

test('syncEventRow has no row for the bookkeeping events', () => {
  assert.equal(syncEventRow({ type: 'plan' }), null);
  assert.equal(syncEventRow({ type: 'agent-done' }), null);
  assert.equal(syncEventRow({ type: 'complete' }), null);
  assert.equal(syncEventRow(null), null);
});
