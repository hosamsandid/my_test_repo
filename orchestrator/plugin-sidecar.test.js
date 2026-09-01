'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  sidecarContainerName,
  sidecarLabels,
  sidecarPluginId,
  manifestHasSidecar,
  sidecarPluginIds,
  reconcileSidecars,
  reconcileAttachments,
  capabilityAttachments,
  brokerEnvContract,
} = require('./plugin-sidecar');
const { PLUGIN_ID_LABEL } = require('./plugin-scope');

test('sidecar name + labels are deterministic', () => {
  assert.equal(sidecarContainerName('podman-sandbox'), 'aee-plugin-podman-sandbox');
  assert.deepEqual(sidecarLabels('podman-sandbox'), { [PLUGIN_ID_LABEL]: 'podman-sandbox' });
});

function sidecar(pluginId, name) {
  return { Id: name, Names: [name], Labels: { [PLUGIN_ID_LABEL]: pluginId } };
}

test('manifestHasSidecar distinguishes broker plugins from command-only ones (#1861)', () => {
  assert.equal(manifestHasSidecar({ id: 'p', sidecar: { image: 'i', internalPort: 4004 } }), true);
  // A command-only plugin (#1798): no `sidecar`, declares `commands`.
  assert.equal(manifestHasSidecar({ id: 'spec-kit', commands: { namespace: 'speckit' } }), false);
  assert.equal(manifestHasSidecar({ id: 'p' }), false);
  assert.equal(manifestHasSidecar(null), false);
});

test('sidecarPluginIds filters command-only plugins out of the reconcile set (#1861)', () => {
  const manifests = {
    'podman-sandbox': { id: 'podman-sandbox', sidecar: { image: 'i', internalPort: 4004 } },
    'spec-kit': { id: 'spec-kit', commands: { namespace: 'speckit' } },
    netzplan: { id: 'netzplan', sidecar: { image: 'j', internalPort: 4006 } },
  };
  assert.deepEqual(sidecarPluginIds(manifests).sort(), ['netzplan', 'podman-sandbox']);
  // The filtered set is what reconcileSidecars keys on — a command-only plugin
  // with no live sidecar is therefore never a start target...
  const { toStart } = reconcileSidecars(sidecarPluginIds(manifests), []);
  assert.ok(!toStart.includes('spec-kit'));
  assert.deepEqual(toStart.sort(), ['netzplan', 'podman-sandbox']);
  // ...and never mistaken for an orphan to stop either.
  assert.deepEqual(sidecarPluginIds({}), []);
  assert.deepEqual(sidecarPluginIds(null), []);
});

test('reconcileSidecars starts installed-but-absent plugins', () => {
  const { toStart, toStop } = reconcileSidecars(['a', 'b'], [sidecar('a', 'aee-plugin-a')]);
  assert.deepEqual(toStart, ['b']);
  assert.deepEqual(toStop, []);
});

// ── ACCEPTANCE: sidecar disappears on uninstall (reconciled) ─────────────────
test('reconcileSidecars stops orphaned sidecars of uninstalled plugins', () => {
  const live = [sidecar('a', 'aee-plugin-a'), sidecar('gone', 'aee-plugin-gone')];
  const { toStart, toStop } = reconcileSidecars(['a'], live);
  assert.deepEqual(toStart, []);
  assert.equal(toStop.length, 1);
  assert.equal(toStop[0].pluginId, 'gone');
});

test('reconcileSidecars ignores non-plugin containers (no label)', () => {
  const { toStop } = reconcileSidecars([], [{ Names: ['random'], Labels: {} }]);
  assert.deepEqual(toStop, []);
  assert.equal(sidecarPluginId({ Labels: {} }), null);
});

const netFor = (id) => `aee-agent-net-${id}`;

// ── ACCEPTANCE: reachable only from granted agents' networks ─────────────────
test('reconcileAttachments connects granted, disconnects revoked', () => {
  const granted = ['a1', 'a2'];
  const attached = ['aee-agent-net-a1', 'aee-agent-net-old'];
  const { connect, disconnect } = reconcileAttachments(granted, attached, netFor);
  assert.deepEqual(connect, ['aee-agent-net-a2']);   // a2 newly granted
  assert.deepEqual(disconnect, ['aee-agent-net-old']); // old revoked
});

test('reconcileAttachments no-op when grant truth already matches network truth', () => {
  const { connect, disconnect } = reconcileAttachments(['a1'], ['aee-agent-net-a1'], netFor);
  assert.deepEqual(connect, []);
  assert.deepEqual(disconnect, []);
});

test('reconcileAttachments empty grant disconnects everything', () => {
  const { connect, disconnect } = reconcileAttachments([], ['aee-agent-net-a1', 'aee-agent-net-a2'], netFor);
  assert.deepEqual(connect, []);
  assert.deepEqual(disconnect.sort(), ['aee-agent-net-a1', 'aee-agent-net-a2']);
});

test('capabilityAttachments maps the closed enum + surfaces host mounts', () => {
  assert.deepEqual(capabilityAttachments(['podman-socket']), { socket: true, egress: false, hostMounts: [] });
  assert.deepEqual(capabilityAttachments(['egress', 'host-mount:/srv/data']), { socket: false, egress: true, hostMounts: ['/srv/data'] });
  assert.deepEqual(capabilityAttachments([]), { socket: false, egress: false, hostMounts: [] });
  assert.deepEqual(capabilityAttachments(undefined), { socket: false, egress: false, hostMounts: [] });
});

// brokerEnvContract is the ONE source of the AEE_PLUGIN_* variables both
// container runtimes set, so its invariants are asserted here directly (the
// Podman create body is additionally asserted in plugin-runtime.test.js).
function envManifest(extra = {}) {
  return {
    id: 'demo-plugin',
    sidecar: { image: 'x', internalPort: 4004, capabilities: [] },
    ...extra,
  };
}
const ENV_OPTS = { signingSecret: 's3cret', auditDir: '/audit', stateDir: '/state' };

test('brokerEnvContract sets the platform env contract', () => {
  const env = brokerEnvContract(envManifest(), ENV_OPTS);
  assert.equal(env.AEE_PLUGIN_ID, 'demo-plugin');
  assert.equal(env.AEE_PLUGIN_PORT, '4004');
  assert.equal(env.AEE_PLUGIN_SIGNING_SECRET, 's3cret');
  assert.equal(env.AEE_PLUGIN_AUDIT_DIR, '/audit');
  assert.equal(env.AEE_PLUGIN_STATE_DIR, '/state');
  assert.equal(env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, undefined, 'no quota declared → no cap variable');
  assert.equal(env.AEE_PLUGIN_QUOTA_TTL_SECONDS, undefined);
});

test('brokerEnvContract lets plugin extras through but the platform always wins', () => {
  const m = envManifest({
    sidecar: {
      image: 'x', internalPort: 4004, capabilities: [],
      env: {
        CUSTOM_THING: 'ok',
        AEE_PLUGIN_SIGNING_SECRET: 'attacker',
        AEE_PLUGIN_STATE_DIR: '/audit',
        AEE_PLUGIN_QUOTA_MAX_OBJECTS: '9999',
        AEE_PLUGIN_ID: 'someone-else',
      },
    },
    quota: { maxObjects: 8, ttlSeconds: 86400 },
  });
  const env = brokerEnvContract(m, ENV_OPTS);
  assert.equal(env.CUSTOM_THING, 'ok');
  assert.equal(env.AEE_PLUGIN_SIGNING_SECRET, 's3cret');
  assert.equal(env.AEE_PLUGIN_STATE_DIR, '/state', 'a manifest cannot repoint the state dir');
  assert.equal(env.AEE_PLUGIN_ID, 'demo-plugin');
  assert.equal(env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, '8', 'declared quota, not the pre-seeded 9999');
  assert.equal(env.AEE_PLUGIN_QUOTA_TTL_SECONDS, '86400');
});
