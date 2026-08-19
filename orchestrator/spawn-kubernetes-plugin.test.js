'use strict';

// Unit tests for the Kubernetes plugin sidecar runtime (#1565): the pure object
// manifest builders (Deployment / Service / state PVC), the naming that lets
// brokerBaseUrl resolve the Service unchanged, and the reconcile decisions.
// Run: node --test orchestrator/spawn-kubernetes-plugin.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const { _internal } = require('./spawn-kubernetes-plugin');
const { PLUGIN_ID_LABEL } = require('./plugin-scope');
const { sidecarContainerName } = require('./plugin-sidecar');

const {
  pluginResourceName,
  statePvcName,
  selectorLabels,
  buildStatePvcManifest,
  buildServiceManifest,
  buildDeploymentManifest,
  deploymentPluginId,
  deploymentIsAvailable,
  manifestSupportsK8s,
  classifyPvcState,
  ensureStatePvc,
  healableStatePvcIds,
  selfHealStatePvcs,
  STATE_MOUNT,
  AUDIT_MOUNT,
} = _internal;

function manifest(extra = {}) {
  return {
    pluginVersion: 1,
    id: 'netzplan',
    name: 'Network Plan',
    description: 'd',
    sidecar: { image: 'localhost/aee-plugin-netzplan:latest', capabilities: [], internalPort: 4006 },
    cli: { name: 'aee-plan', entrypoint: 'bin/aee-plan', runtime: 'python3' },
    ui: { routes: [{ path: '/', minRole: 'team-member' }] },
    ...extra,
  };
}

test('Deployment + Service share the Podman sidecar name so brokerBaseUrl is runtime-agnostic', () => {
  assert.equal(pluginResourceName('netzplan'), 'aee-plugin-netzplan');
  assert.equal(pluginResourceName('netzplan'), sidecarContainerName('netzplan'),
    'the k8s Service name must equal the Podman container name');
  assert.equal(statePvcName('netzplan'), 'aee-plugin-netzplan-state');
});

test('state volume is a PVC, never an emptyDir (survives pod restart)', () => {
  const pvc = buildStatePvcManifest('netzplan');
  assert.equal(pvc.kind, 'PersistentVolumeClaim');
  assert.deepEqual(pvc.spec.accessModes, ['ReadWriteOnce']);
  assert.ok(pvc.spec.resources.requests.storage, 'requests a concrete size');
  assert.equal(pvc.metadata.labels[PLUGIN_ID_LABEL], 'netzplan');
});

test('Service selects the plugin+instance-scoped pods on the broker port', () => {
  const svc = buildServiceManifest(manifest());
  assert.equal(svc.kind, 'Service');
  assert.equal(svc.metadata.name, 'aee-plugin-netzplan');
  assert.deepEqual(svc.spec.selector, selectorLabels('netzplan'));
  assert.equal(svc.spec.ports[0].port, 4006);
  assert.equal(svc.spec.ports[0].targetPort, 4006);
});

test('Deployment mounts the state PVC + audit emptyDir and carries the platform env contract', () => {
  const dep = buildDeploymentManifest(manifest(), { signingSecret: 's3cret' });
  assert.equal(dep.apiVersion, 'apps/v1');
  assert.equal(dep.kind, 'Deployment');
  assert.equal(dep.spec.replicas, 1);
  assert.deepEqual(dep.spec.selector.matchLabels, selectorLabels('netzplan'));

  const pod = dep.spec.template.spec;
  // The broker gets no k8s API token — it has no business calling the API.
  assert.equal(pod.automountServiceAccountToken, false);

  const container = pod.containers[0];
  assert.equal(container.image, 'localhost/aee-plugin-netzplan:latest');
  assert.equal(container.ports[0].containerPort, 4006);

  // State is a PVC; audit is an emptyDir (deliberate, documented difference).
  const stateVol = pod.volumes.find((v) => v.name === 'state');
  const auditVol = pod.volumes.find((v) => v.name === 'audit');
  assert.ok(stateVol.persistentVolumeClaim, 'state must be a PVC');
  assert.equal(stateVol.persistentVolumeClaim.claimName, 'aee-plugin-netzplan-state');
  assert.ok(auditVol.emptyDir, 'audit is an emptyDir on k8s');

  const mountPaths = container.volumeMounts.map((m) => m.mountPath).sort();
  assert.deepEqual(mountPaths, [AUDIT_MOUNT, STATE_MOUNT].sort());

  const env = Object.fromEntries(container.env.map((e) => [e.name, e.value]));
  assert.equal(env.AEE_PLUGIN_ID, 'netzplan');
  assert.equal(env.AEE_PLUGIN_PORT, '4006');
  assert.equal(env.AEE_PLUGIN_SIGNING_SECRET, 's3cret');
  assert.equal(env.AEE_PLUGIN_STATE_DIR, STATE_MOUNT);
  assert.equal(env.AEE_PLUGIN_AUDIT_DIR, AUDIT_MOUNT);
});

test('quota from the manifest reaches the Deployment env', () => {
  const dep = buildDeploymentManifest(manifest({ quota: { maxObjects: 25 } }), { signingSecret: 's' });
  const env = Object.fromEntries(dep.spec.template.spec.containers[0].env.map((e) => [e.name, e.value]));
  assert.equal(env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, '25');
});

test('manifestSupportsK8s gates podman-only plugins out of the k8s runtime', () => {
  assert.equal(manifestSupportsK8s({ platforms: ['podman', 'kubernetes'] }), true);
  assert.equal(manifestSupportsK8s({ platforms: ['kubernetes'] }), true);
  assert.equal(manifestSupportsK8s({ platforms: ['any'] }), true);
  assert.equal(manifestSupportsK8s({}), true, 'default platforms is ["any"]');
  assert.equal(manifestSupportsK8s({ platforms: ['podman'] }), false, 'podman-sandbox stays off k8s');
});

test('deploymentPluginId reads the plugin label; availability needs a ready replica', () => {
  const dep = { metadata: { labels: { [PLUGIN_ID_LABEL]: 'netzplan' } }, status: { availableReplicas: 1 } };
  assert.equal(deploymentPluginId(dep), 'netzplan');
  assert.equal(deploymentIsAvailable(dep), true);
  assert.equal(deploymentIsAvailable({ status: { availableReplicas: 0 } }), false);
  assert.equal(deploymentIsAvailable({ status: {} }), false);
  assert.equal(deploymentPluginId({}), null);
});

// ── #1698: state-PVC reinstall race ──────────────────────────────────────────

test('classifyPvcState distinguishes absent / terminating / present / error', () => {
  assert.equal(classifyPvcState({ status: 404, body: { kind: 'Status' } }), 'absent');
  assert.equal(classifyPvcState(null), 'absent');
  assert.equal(
    classifyPvcState({ status: 200, body: { metadata: { deletionTimestamp: '2026-08-12T12:00:00Z' } } }),
    'terminating',
    'a PVC carrying a deletionTimestamp is still Terminating',
  );
  assert.equal(classifyPvcState({ status: 200, body: { metadata: { name: 'x' } } }), 'present');
  assert.equal(classifyPvcState({ status: 500, body: 'boom' }), 'error');
});

// A tiny recorder that answers GET with a scripted sequence of states and
// records every (method, path) so we can assert the create actually fired.
function fakeK8s(getResponses, { createStatus = 201 } = {}) {
  const calls = [];
  let getIdx = 0;
  const request = async (method, apiPath) => {
    calls.push({ method, apiPath });
    if (method === 'GET') {
      const r = getResponses[Math.min(getIdx, getResponses.length - 1)];
      getIdx += 1;
      return r;
    }
    if (method === 'POST') return { status: createStatus, body: {} };
    return { status: 200, body: {} };
  };
  return { request, calls };
}

const opts = (request) => ({
  request,
  sleepFn: async () => {}, // never actually wait in tests
  now: (() => { let t = 0; return () => (t += 1000); })(),
  deadlineMs: 30000,
  intervalMs: 1000,
});

test('ensureStatePvc creates when the PVC is absent', async () => {
  const { request, calls } = fakeK8s([{ status: 404, body: {} }]);
  const r = await ensureStatePvc(manifest(), opts(request));
  assert.deepEqual(r, { ok: true, existed: false });
  assert.ok(calls.some((c) => c.method === 'POST'), 'must POST-create the PVC');
});

test('ensureStatePvc reuses an existing (non-terminating) PVC without creating', async () => {
  const { request, calls } = fakeK8s([{ status: 200, body: { metadata: { name: 'x' } } }]);
  const r = await ensureStatePvc(manifest(), opts(request));
  assert.deepEqual(r, { ok: true, existed: true });
  assert.ok(!calls.some((c) => c.method === 'POST'), 'must not create when one is present');
});

test('ensureStatePvc waits out a Terminating PVC, then creates a fresh one (#1698)', async () => {
  // Two polls see it Terminating, the third sees it gone → then create succeeds.
  const term = { status: 200, body: { metadata: { deletionTimestamp: 'now' } } };
  const { request, calls } = fakeK8s([term, term, { status: 404, body: {} }]);
  const r = await ensureStatePvc(manifest(), opts(request));
  assert.deepEqual(r, { ok: true, existed: false });
  const gets = calls.filter((c) => c.method === 'GET').length;
  assert.equal(gets, 3, 'polled until the terminating PVC disappeared');
  assert.ok(calls.some((c) => c.method === 'POST'), 'created only after it was gone');
});

test('ensureStatePvc gives up (not ok) if the PVC stays Terminating past the deadline', async () => {
  const term = { status: 200, body: { metadata: { deletionTimestamp: 'now' } } };
  const { request } = fakeK8s([term]); // always terminating
  const r = await ensureStatePvc(manifest(), { ...opts(request), deadlineMs: 2000, intervalMs: 1000 });
  assert.equal(r.ok, false);
  assert.equal(r.status, 409);
});

test('ensureStatePvc loops on an absent→409 create race instead of skipping', async () => {
  // GET says absent, but the POST 409s (a lingering PVC re-materialised); next
  // GET shows it gone and the retry create succeeds.
  const calls = [];
  let getIdx = 0;
  let posts = 0;
  const getSeq = [{ status: 404, body: {} }, { status: 404, body: {} }];
  const request = async (method, apiPath) => {
    calls.push({ method, apiPath });
    if (method === 'GET') { const r = getSeq[Math.min(getIdx, getSeq.length - 1)]; getIdx += 1; return r; }
    posts += 1;
    return posts === 1 ? { status: 409, body: {} } : { status: 201, body: {} };
  };
  const r = await ensureStatePvc(manifest(), opts(request));
  assert.deepEqual(r, { ok: true, existed: false });
  assert.equal(posts, 2, 'retried the create after the 409 rather than treating it as success');
});

test('healableStatePvcIds is the eligible plugins that already have a live Deployment', () => {
  const existing = [
    { metadata: { labels: { [PLUGIN_ID_LABEL]: 'netzplan' } } },
    { metadata: { labels: { [PLUGIN_ID_LABEL]: 'ghost' } } }, // not eligible
  ];
  assert.deepEqual(healableStatePvcIds(['netzplan', 'patterns'], existing), ['netzplan']);
  assert.deepEqual(healableStatePvcIds([], existing), []);
});

test('selfHealStatePvcs recreates a missing PVC but leaves present/terminating alone', async () => {
  const manifests = {
    a: manifest({ id: 'a' }),
    b: manifest({ id: 'b' }),
    c: manifest({ id: 'c' }),
  };
  const getByPath = {
    [statePvcName('a')]: { status: 404, body: {} }, // missing → recreate
    [statePvcName('b')]: { status: 200, body: { metadata: {} } }, // present → skip
    [statePvcName('c')]: { status: 200, body: { metadata: { deletionTimestamp: 'x' } } }, // terminating → skip
  };
  const posts = [];
  const request = async (method, apiPath) => {
    if (method === 'GET') {
      const name = Object.keys(getByPath).find((n) => apiPath.endsWith(n));
      return getByPath[name] || { status: 404, body: {} };
    }
    if (method === 'POST') { posts.push(apiPath); return { status: 201, body: {} }; }
    return { status: 200, body: {} };
  };
  const r = await selfHealStatePvcs(['a', 'b', 'c'], manifests, { request });
  assert.deepEqual(r.healed, ['a']);
  assert.deepEqual(r.errors, []);
  assert.equal(posts.length, 1, 'only the missing PVC was recreated');
});
