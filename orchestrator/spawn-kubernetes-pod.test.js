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
  buildContextHostPathVolumes,
  safeWrite,
  finalizeHandle,
} = _internal;

// The context-hostPath gate is read at call time, so tests toggle it around
// each call and always restore the ambient value.
function withContextGate(value, fn) {
  const prev = process.env.AEE_K8S_CONTEXT_HOSTPATH;
  if (value === undefined) delete process.env.AEE_K8S_CONTEXT_HOSTPATH;
  else process.env.AEE_K8S_CONTEXT_HOSTPATH = value;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.AEE_K8S_CONTEXT_HOSTPATH;
    else process.env.AEE_K8S_CONTEXT_HOSTPATH = prev;
  }
}

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

// #1940 AC2/AC8 — the pod is created from the image the CALLER resolved, and
// the two image knobs an operator already relies on keep applying to it.
test('buildPodManifest uses the resolved image, not a module-level default', () => {
  const pod = buildPodManifest('a1', {}, 'p', [], 'europe-west4-docker.pkg.dev/proj/aee/as-agent-jvm:v1');
  assert.equal(pod.spec.containers[0].image, 'europe-west4-docker.pkg.dev/proj/aee/as-agent-jvm:v1');
});

test('buildPodManifest keeps the pull policy alongside a toolchain image (AC8)', () => {
  const dflt = buildPodManifest('a1', {}, 'p', [], 'as-agent:latest');
  const variant = buildPodManifest('a1', {}, 'p', [], 'localhost/as-agent-jvm:latest');
  // A variant differs from the default in the image field and nothing else —
  // pull policy, pull secret and the whole isolation setup are image-agnostic.
  assert.equal(variant.spec.containers[0].imagePullPolicy, dflt.spec.containers[0].imagePullPolicy);
  assert.deepEqual(variant.spec.imagePullSecrets, dflt.spec.imagePullSecrets);
  assert.deepEqual(
    { ...variant.spec.containers[0], image: null },
    { ...dflt.spec.containers[0], image: null },
  );
});

test('buildContextHostPathVolumes renders hostPath volumes with per-folder read-only semantics', () => {
  withContextGate('1', () => {
    const { volumes, volumeMounts } = buildContextHostPathVolumes([
      { path: '/Users/dev/specs', target: '/context/specs', readWrite: false },
      { path: '/Users/dev/out', target: '/context/out', readWrite: true },
    ]);
    assert.deepEqual(volumes, [
      { name: 'ctx-0', hostPath: { path: '/Users/dev/specs', type: 'Directory' } },
      { name: 'ctx-1', hostPath: { path: '/Users/dev/out', type: 'Directory' } },
    ]);
    assert.deepEqual(volumeMounts, [
      { name: 'ctx-0', mountPath: '/context/specs', readOnly: true },
      { name: 'ctx-1', mountPath: '/context/out', readOnly: false },
    ]);
  });
});

test('buildContextHostPathVolumes defaults a target-less legacy entry to /context, read-only', () => {
  withContextGate('1', () => {
    const { volumeMounts } = buildContextHostPathVolumes([{ path: '/Users/dev/docs' }]);
    assert.deepEqual(volumeMounts, [{ name: 'ctx-0', mountPath: '/context', readOnly: true }]);
  });
});

test('buildContextHostPathVolumes drops invalid entries fail-closed, keeps the rest', () => {
  withContextGate('1', () => {
    const { volumes, volumeMounts } = buildContextHostPathVolumes([
      null,
      { path: 'relative/path', target: '/context/a' },        // not absolute
      { path: '/etc/passwd-dir', target: '/context/b' },      // deny-tree
      { path: '/Users/dev/../dev/x', target: '/context/c' },  // traversal
      { path: '/srv/good', target: '/context/good' },
    ]);
    assert.equal(volumes.length, 1);
    assert.deepEqual(volumeMounts, [{ name: 'ctx-0', mountPath: '/context/good', readOnly: true }]);
  });
});

test('context mounts render nothing without the AEE_K8S_CONTEXT_HOSTPATH opt-in', () => {
  withContextGate(undefined, () => {
    const gated = buildContextHostPathVolumes([{ path: '/srv/good', target: '/context/good' }]);
    assert.deepEqual(gated, { volumes: [], volumeMounts: [] });
    // The pod manifest stays byte-identical to a mount-less one (hosted GKE safety).
    const withMounts = buildPodManifest('a1', { X: '1' }, 'p', [{ path: '/srv/good', target: '/context/good' }]);
    const without = buildPodManifest('a1', { X: '1' }, 'p');
    assert.deepEqual(withMounts, without);
  });
});

test('buildPodManifest appends context hostPath volumes after the workspace PVC', () => {
  withContextGate('1', () => {
    const pod = buildPodManifest('a1', { X: '1' }, 'p', [
      { path: '/srv/specs', target: '/context/specs', readWrite: true },
    ]);
    const vols = pod.spec.volumes;
    assert.equal(vols[0].name, 'workspace');
    assert.deepEqual(vols[1], { name: 'ctx-0', hostPath: { path: '/srv/specs', type: 'Directory' } });
    const vm = pod.spec.containers[0].volumeMounts.find((m) => m.name === 'ctx-0');
    assert.deepEqual(vm, { name: 'ctx-0', mountPath: '/context/specs', readOnly: false });
  });
});

test('instance label default carries no legacy vgh token', () => {
  const pod = buildPodManifest('a1', {}, 'p');
  assert.notEqual(pod.metadata.labels['aee.instance'], 'vgh-claw-314092');
  if (!process.env.AEE_INSTANCE_ID && !process.env.COMPOSE_PROJECT_NAME) {
    // Matches the Podman path's default (spawn-container.js COMPOSE_PROJECT).
    assert.equal(pod.metadata.labels['aee.instance'], 'agent-studio-314092');
  }
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
