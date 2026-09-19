'use strict';

// sidecarCreateBody is the one place where a declared capability becomes a real
// privilege on the host, so it is asserted directly even though the module it
// lives in is the impure adapter.

const test = require('node:test');
const assert = require('node:assert');

const {
  sidecarCreateBody, AUDIT_MOUNT, auditVolumeName, STATE_MOUNT, stateVolumeName,
} = require('./plugin-runtime');

function manifest(extra = {}) {
  return {
    pluginVersion: 1,
    id: 'demo-plugin',
    name: 'Demo',
    description: 'd',
    sidecar: { image: 'localhost/aee-plugin-demo:latest', capabilities: [], internalPort: 4004 },
    cli: { name: 'aee-demo', entrypoint: 'bin/aee-demo.py', runtime: 'python3' },
    ...extra,
  };
}

const OPTS = { signingSecret: 's3cret', hostSocket: '/run/user/1000/podman/podman.sock' };

test('a plugin with no capabilities gets NO host mounts', () => {
  const body = sidecarCreateBody(manifest(), OPTS);
  assert.deepEqual(body.mounts, [], 'no declared capability must mean no privilege');
  assert.equal(body.name, 'aee-plugin-demo-plugin');
  assert.equal(body.image, 'localhost/aee-plugin-demo:latest');
  assert.equal(body.no_new_privileges, true);
});

test('podman-socket binds the HOST socket path, not the in-container one', () => {
  const m = manifest({ sidecar: { image: 'i', capabilities: ['podman-socket'], internalPort: 4004 } });
  const body = sidecarCreateBody(m, OPTS);
  assert.equal(body.mounts.length, 1);
  assert.deepEqual(body.mounts[0], {
    Type: 'bind',
    Source: '/run/user/1000/podman/podman.sock',
    Destination: '/var/run/podman.sock',
    Options: ['rw'],
  });
});

test('a host-mount capability is mounted read-only', () => {
  const m = manifest({ sidecar: { image: 'i', capabilities: ['host-mount:/srv/data'], internalPort: 4004 } });
  const body = sidecarCreateBody(m, OPTS);
  assert.deepEqual(body.mounts[0], {
    Type: 'bind',
    Source: '/srv/data',
    Destination: '/srv/data',
    Options: ['ro'],
  });
});

test('the env contract is plugin-neutral and carries the signing secret', () => {
  const body = sidecarCreateBody(manifest(), OPTS);
  assert.equal(body.env.AEE_PLUGIN_ID, 'demo-plugin');
  assert.equal(body.env.AEE_PLUGIN_PORT, '4004');
  assert.equal(body.env.AEE_PLUGIN_SIGNING_SECRET, 's3cret');
  assert.equal(body.env.AEE_PLUGIN_AUDIT_DIR, AUDIT_MOUNT);
  assert.equal(body.env.AEE_PLUGIN_STATE_DIR, STATE_MOUNT);
  // No plugin-specific variable names may leak out of the generic orchestrator.
  assert.ok(!Object.keys(body.env).some((k) => k.startsWith('PODMAN_MCP_')));
});

test('a manifest cannot override the platform state dir via sidecar.env (§4.8)', () => {
  const m = manifest({
    sidecar: {
      image: 'i',
      capabilities: [],
      internalPort: 4004,
      env: { AEE_PLUGIN_STATE_DIR: '/audit' },
    },
  });
  // Letting a plugin repoint its state dir at the audit mount (or anywhere else)
  // is the same class of escape as raising its own quota — the platform sets it.
  const body = sidecarCreateBody(m, OPTS);
  assert.equal(body.env.AEE_PLUGIN_STATE_DIR, STATE_MOUNT);
});

test('a declared quota reaches the broker; an absent one sets no variable', () => {
  const withQuota = sidecarCreateBody(manifest({ quota: { maxObjects: 8, ttlSeconds: 86400 } }), OPTS);
  assert.equal(withQuota.env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, '8');
  assert.equal(withQuota.env.AEE_PLUGIN_QUOTA_TTL_SECONDS, '86400');

  const without = sidecarCreateBody(manifest(), OPTS);
  assert.equal(without.env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, undefined);
  assert.equal(without.env.AEE_PLUGIN_QUOTA_TTL_SECONDS, undefined);
});

test('a manifest cannot override the platform env contract via sidecar.env', () => {
  // sidecar.env is authored by the plugin. Letting it win would let a plugin
  // lift its own declared quota or take its broker off the platform's token
  // authority — the manifest declares intent, the platform sets truth.
  const m = manifest({
    quota: { maxObjects: 8 },
    sidecar: {
      image: 'i',
      capabilities: [],
      internalPort: 4004,
      env: {
        AEE_PLUGIN_SIGNING_SECRET: 'attacker',
        AEE_PLUGIN_QUOTA_MAX_OBJECTS: '9999',
        AEE_PLUGIN_ID: 'someone-else',
        CUSTOM_THING: 'ok',
      },
    },
  });
  const body = sidecarCreateBody(m, OPTS);
  assert.equal(body.env.CUSTOM_THING, 'ok', 'plugin-authored extras still pass through');
  assert.equal(body.env.AEE_PLUGIN_SIGNING_SECRET, 's3cret');
  assert.equal(body.env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, '8');
  assert.equal(body.env.AEE_PLUGIN_ID, 'demo-plugin');
});

test('a plugin cannot manufacture "no quota declared" by clearing the variable', () => {
  const m = manifest({
    sidecar: {
      image: 'i',
      capabilities: [],
      internalPort: 4004,
      env: { AEE_PLUGIN_QUOTA_MAX_OBJECTS: '9999' },
    },
  });
  // No quota in the manifest → the variable must be absent, not the author's.
  const body = sidecarCreateBody(m, OPTS);
  assert.equal(body.env.AEE_PLUGIN_QUOTA_MAX_OBJECTS, undefined);
});

test('the audit volume is per plugin and mounted WHOLE, never via SubPath', () => {
  // A SubPath is resolved against content that must already exist, and a fresh
  // volume is empty — that combination failed the container start outright with
  // "no such file or directory" on the first end-to-end run. One volume per
  // plugin needs no pre-created directory and isolates the trails anyway.
  const body = sidecarCreateBody(manifest(), OPTS);
  const audit = body.volumes.find((v) => v.Dest === AUDIT_MOUNT);
  assert.ok(audit, 'the audit volume is mounted');
  assert.equal(audit.SubPath, undefined);
  assert.equal(audit.Name, auditVolumeName('demo-plugin'));
  assert.match(audit.Name, /plugin-audit-demo-plugin$/);
});

test('a second per-plugin STATE volume is mounted at /state (§4.8)', () => {
  const body = sidecarCreateBody(manifest(), OPTS);
  assert.equal(body.volumes.length, 2, 'audit + state, both whole volumes');
  const state = body.volumes.find((v) => v.Dest === STATE_MOUNT);
  assert.ok(state, 'the state volume is mounted at /state');
  assert.equal(state.SubPath, undefined);
  assert.equal(state.Name, stateVolumeName('demo-plugin'));
  assert.match(state.Name, /plugin-state-demo-plugin$/);
  // Distinct volumes so document state never lands in the audit trail's mount.
  assert.notEqual(state.Name, auditVolumeName('demo-plugin'));
});

// ── liveness (#1547, found on the first end-to-end run) ─────────────────────

const { splitByRunning } = require('./plugin-runtime');

test('only a RUNNING container counts as a live sidecar', () => {
  const { running, stale } = splitByRunning([
    { Names: ['aee-plugin-a'], State: 'running' },
    { Names: ['aee-plugin-b'], State: 'created' },
    { Names: ['aee-plugin-c'], State: 'exited' },
    { Names: ['aee-plugin-d'], State: 'dead' },
  ]);
  assert.deepEqual(running.map((c) => c.Names[0]), ['aee-plugin-a']);
  assert.deepEqual(stale.map((c) => c.Names[0]), ['aee-plugin-b', 'aee-plugin-c', 'aee-plugin-d']);
});

test('a "created" corpse must not be mistaken for a live sidecar', () => {
  // The exact live-stack failure: a create whose start never ran (orchestrator
  // restarted between the two calls) left the container in `created`. Counting
  // it as live made reconcile report nothing to start AND no errors, so the
  // plugin stayed down while the reconcile looked successful.
  const { running } = splitByRunning([{ Names: ['aee-plugin-podman-sandbox'], State: 'created' }]);
  assert.deepEqual(running, [], 'a created-but-never-started container is not live');
});

test('splitByRunning is case-insensitive and tolerates a missing State', () => {
  const { running, stale } = splitByRunning([
    { Names: ['a'], State: 'Running' },
    { Names: ['b'] },
    null,
  ]);
  assert.deepEqual(running.map((c) => c.Names[0]), ['a']);
  assert.deepEqual(stale.map((c) => c.Names[0]), ['b'], 'a null entry is dropped, not counted as a corpse');
});

test('the sidecar disables SELinux relabelling via the libpod field, not the docker-compat one', () => {
  // libpod's create API spells this `selinux_opts`. Passing the docker-compat
  // `security_opt` is silently ignored, which left the mounted host socket
  // labelled and every broker call failing "permission denied" as root.
  const body = sidecarCreateBody(manifest(), OPTS);
  assert.deepEqual(body.selinux_opts, ['disable']);
  assert.equal(body.security_opt, undefined, 'the ignored docker-compat field must not be relied on');
  assert.equal(body.no_new_privileges, true, 'still no privilege escalation');
});

// ── `_internal` is the push credential, never a grant token ─────────────────

const runtime = require("./plugin-runtime");

test('mintScopeToken refuses the reserved `_internal` scope; mintInternalToken is the only minter', () => {
  const tmp = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'plugin-rt-'));
  const { verify } = require('./plugin-scope-token');
  assert.equal(runtime.mintScopeToken('jira', '_internal', tmp), null);
  const tok = runtime.mintInternalToken('jira', tmp);
  assert.ok(tok);
  assert.deepEqual(verify(tok, runtime.signingSecret(tmp)), { pluginId: 'jira', scopeId: '_internal' });
  // an ordinary scope still mints
  assert.ok(runtime.mintScopeToken('jira', 'team-1', tmp));
});
