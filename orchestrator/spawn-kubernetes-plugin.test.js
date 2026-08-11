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
