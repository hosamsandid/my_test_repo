'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  sidecarContainerName,
  sidecarLabels,
  sidecarPluginId,
  reconcileSidecars,
  reconcileAttachments,
  capabilityAttachments,
} = require('./plugin-sidecar');
const { PLUGIN_ID_LABEL } = require('./plugin-scope');

test('sidecar name + labels are deterministic', () => {
  assert.equal(sidecarContainerName('podman-sandbox'), 'aee-plugin-podman-sandbox');
  assert.deepEqual(sidecarLabels('podman-sandbox'), { [PLUGIN_ID_LABEL]: 'podman-sandbox' });
});

function sidecar(pluginId, name) {
  return { Id: name, Names: [name], Labels: { [PLUGIN_ID_LABEL]: pluginId } };
}

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
