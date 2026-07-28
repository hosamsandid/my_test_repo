'use strict';

// Unit tests for the Kubernetes container-runtime seam's pure helpers and the
// handle lifecycle (finalize/safeWrite) — the parts that broke in production:
// write-after-end crashes, immortal log-retry loops, orphaned pods on
// kill/create races, and image-pull failures idling forever.
// Run: node --test orchestrator/spawn-kubernetes-pod.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter, PassThrough } = require('stream');
const { _internal } = require('./spawn-kubernetes-pod');

const {
  safeName,
  parseMemoryQuantity,
  podPhaseToState,
  exitCodeFromPod,
  fatalWaitingReason,
  envToK8s,
  buildPodManifest,
  safeWrite,
  finalizeHandle,
} = _internal;

test('safeName sanitizes agent ids into DNS-safe pod name fragments', () => {
  assert.equal(safeName('My Agent_01'), 'my-agent-01');
  assert.equal(safeName('--weird--'), 'weird');
  assert.equal(safeName(''), 'agent');
  assert.equal(safeName('x'.repeat(60)).length, 45);
});

test('parseMemoryQuantity accepts k8s quantities and docker-style suffixes', () => {
  assert.equal(parseMemoryQuantity('2Gi'), '2Gi');
  assert.equal(parseMemoryQuantity('512Mi'), '512Mi');
  assert.equal(parseMemoryQuantity('2g'), '2Gi');
  assert.equal(parseMemoryQuantity('512m'), '512Mi');
  assert.equal(parseMemoryQuantity('2gb'), '2Gi');
  assert.equal(parseMemoryQuantity(''), undefined);
  assert.equal(parseMemoryQuantity('lots'), undefined);
});

test('podPhaseToState maps pod phases onto the libpod state vocabulary', () => {
  assert.equal(podPhaseToState({ status: { phase: 'Running' } }), 'running');
  assert.equal(podPhaseToState({ status: { phase: 'Succeeded' } }), 'exited');
  assert.equal(podPhaseToState({ status: { phase: 'Failed' } }), 'exited');
  assert.equal(podPhaseToState({ status: { phase: 'Pending' } }), 'created');
  assert.equal(podPhaseToState({}), 'unknown');
});

test('exitCodeFromPod prefers the as-agent terminated code, falls back to phase', () => {
  assert.equal(exitCodeFromPod({
    status: { containerStatuses: [{ name: 'as-agent', state: { terminated: { exitCode: 7 } } }] },
  }), 7);
  assert.equal(exitCodeFromPod({ status: { phase: 'Succeeded' } }), 0);
  assert.equal(exitCodeFromPod({ status: { phase: 'Failed' } }), 1);
  assert.equal(exitCodeFromPod({ status: { phase: 'Running', containerStatuses: [] } }), null);
});

test('fatalWaitingReason flags unrecoverable waiting states only', () => {
  const pod = (reason) => ({
    status: { containerStatuses: [{ name: 'as-agent', state: { waiting: { reason } } }] },
  });
  assert.equal(fatalWaitingReason(pod('ImagePullBackOff')), 'ImagePullBackOff');
  assert.equal(fatalWaitingReason(pod('ErrImageNeverPull')), 'ErrImageNeverPull');
  assert.equal(fatalWaitingReason(pod('CreateContainerConfigError')), 'CreateContainerConfigError');
  // Normal startup + transient pull attempts must NOT be treated as fatal.
  assert.equal(fatalWaitingReason(pod('ContainerCreating')), null);
  assert.equal(fatalWaitingReason(pod('ErrImagePull')), null);
  assert.equal(fatalWaitingReason({ status: {} }), null);
});

test('envToK8s drops null/undefined values and stringifies the rest', () => {
  assert.deepEqual(envToK8s({ A: '1', B: 2, C: null, D: undefined }), [
    { name: 'A', value: '1' },
    { name: 'B', value: '2' },
  ]);
});

test('buildPodManifest isolates the agent via subPath and carries both scoping labels', () => {
  const pod = buildPodManifest('cobol-agent', { X: '1' }, 'aee-agent-cobol-agent-abc');
  assert.equal(pod.metadata.labels['aee.agent.id'], 'cobol-agent');
  assert.ok(pod.metadata.labels['aee.instance'], 'instance label must be set (eviction scoping)');
  assert.equal(pod.spec.automountServiceAccountToken, false);
  assert.equal(pod.spec.restartPolicy, 'Never');
  const [ws, home] = pod.spec.containers[0].volumeMounts;
  assert.deepEqual(ws, { name: 'workspace', mountPath: '/workspace/agents/cobol-agent', subPath: 'agents/cobol-agent' });
  assert.equal(home.subPath, 'claude-home/homes/cobol-agent');
  const sec = pod.spec.containers[0].securityContext;
  assert.equal(sec.allowPrivilegeEscalation, false);
  assert.deepEqual(sec.capabilities.drop, ['ALL']);
});

function makeHandle() {
  const handle = new EventEmitter();
  handle.stdout = new PassThrough();
  handle.stderr = new PassThrough();
  handle.killed = false;
  handle.exitCode = null;
  handle._done = false;
  return handle;
}

test('safeWrite never throws on an ended stream (the orchestrator-crash bug)', () => {
  const s = new PassThrough();
  s.resume();
  s.end();
  assert.doesNotThrow(() => safeWrite(s, 'late diagnostic line\n'));
});

test('finalizeHandle emits exit exactly once and ends both streams', () => {
  const handle = makeHandle();
  const exits = [];
  handle.on('exit', (code) => exits.push(code));
  finalizeHandle(handle, 143);
  finalizeHandle(handle, 0); // duplicate finalize (poll + catch race) is a no-op
  assert.deepEqual(exits, [143]);
  assert.equal(handle.exitCode, 143);
  assert.equal(handle._done, true);
  assert.equal(handle.stdout.writableEnded, true);
  assert.equal(handle.stderr.writableEnded, true);
});

test('finalizeHandle stops a pending log-retry timer (the immortal-retry bug)', () => {
  const handle = makeHandle();
  let retried = false;
  handle._logRetryTimer = setTimeout(() => { retried = true; }, 5);
  finalizeHandle(handle, 0);
  return new Promise((resolve) => setTimeout(() => {
    assert.equal(retried, false, 'retry timer must be cancelled at finalize');
    resolve();
  }, 20));
});
