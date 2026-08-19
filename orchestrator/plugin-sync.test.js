'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  agentPluginPaths,
  sidecarEndpoint,
  pluginConfigFile,
  planWorkspaceSync,
  CONFIG_MODE,
  BIN_MODE,
} = require('./plugin-sync');

const MANIFEST = {
  id: 'dummy-echo',
  cli: { name: 'aee-echo', entrypoint: 'bin/aee-echo.py', runtime: 'python3' },
  sidecar: { internalPort: 8080 },
};
const MANIFESTS = { 'dummy-echo': MANIFEST };

// Deterministic stand-ins for the impure Phase-1 seams.
const resolveScopeId = (cfg, granularity) => (granularity === 'agent' ? cfg.id : (cfg.parentTeamId || cfg.id));
const mintToken = (pluginId, scopeId) => `${pluginId}.${scopeId}.SIG`;
const networkNameFor = (agentId) => `aee-net-${agentId}`;

const MEMBER = { id: 't1-dev', parentTeamId: 't1' };

function plan(prevGrant, nextGrant, agentCfg = MEMBER) {
  return planWorkspaceSync({ agentCfg, prevGrant, nextGrant, manifests: MANIFESTS, resolveScopeId, mintToken, networkNameFor });
}

// ---- layout helpers ---------------------------------------------------------

test('agentPluginPaths puts the CLI on PATH and config under .agent-studio/plugins', () => {
  assert.deepEqual(agentPluginPaths('dummy-echo', 'aee-echo'), {
    binPath: '.agent-studio/bin/aee-echo',
    configPath: '.agent-studio/plugins/dummy-echo.json',
  });
});

test('sidecarEndpoint is the deterministic sidecar name + internal port', () => {
  assert.equal(sidecarEndpoint(MANIFEST), 'http://aee-plugin-dummy-echo:8080');
});

test('pluginConfigFile carries the token, scope and endpoint the CLI reads', () => {
  assert.deepEqual(
    pluginConfigFile({ pluginId: 'p', scopeId: 's', endpoint: 'http://e', token: 'tok', cliName: 'c' }),
    { pluginId: 'p', scopeId: 's', endpoint: 'http://e', token: 'tok', cliName: 'c' },
  );
});

// ---- grant → CLI + token + network appear -----------------------------------

test('a fresh grant seeds the CLI (0755), the 0600 config with a minted token, and connects the network', () => {
  const out = plan([], [{ id: 'dummy-echo', scopeGranularity: 'team' }]);
  assert.deepEqual(out.remove, []);
  assert.deepEqual(out.disconnect, []);
  assert.deepEqual(out.connect, [{ pluginId: 'dummy-echo', network: 'aee-net-t1-dev' }]);

  const bin = out.write.find((w) => w.path === '.agent-studio/bin/aee-echo');
  assert.equal(bin.mode, BIN_MODE);
  assert.equal(bin.copyFrom, 'bin/aee-echo.py');

  const cfg = out.write.find((w) => w.path === '.agent-studio/plugins/dummy-echo.json');
  assert.equal(cfg.mode, CONFIG_MODE);
  assert.deepEqual(cfg.content, {
    pluginId: 'dummy-echo',
    scopeId: 't1',                         // team granularity → the team id
    endpoint: 'http://aee-plugin-dummy-echo:8080',
    token: 'dummy-echo.t1.SIG',
    cliName: 'aee-echo',
  });
});

test('agent granularity resolves the member id as the scopeId (and into the token)', () => {
  const out = plan([], [{ id: 'dummy-echo', scopeGranularity: 'agent' }]);
  const cfg = out.write.find((w) => w.path === '.agent-studio/plugins/dummy-echo.json');
  assert.equal(cfg.content.scopeId, 't1-dev');
  assert.equal(cfg.content.token, 'dummy-echo.t1-dev.SIG');
});

// ---- revoke → CLI + token + network vanish ----------------------------------

test('a revoke removes the CLI + config and disconnects the network', () => {
  const out = plan([{ id: 'dummy-echo', scopeGranularity: 'team' }], []);
  assert.deepEqual(out.write, []);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.remove.sort(), ['.agent-studio/bin/aee-echo', '.agent-studio/plugins/dummy-echo.json']);
  assert.deepEqual(out.disconnect, [{ pluginId: 'dummy-echo', network: 'aee-net-t1-dev' }]);
});

test('a revoke of an uninstalled plugin still cleans up via a stored cliName', () => {
  const out = planWorkspaceSync({
    agentCfg: MEMBER,
    prevGrant: [{ id: 'gone', scopeGranularity: 'team', cliName: 'aee-gone' }],
    nextGrant: [],
    manifests: {}, // uninstalled
    resolveScopeId, mintToken, networkNameFor,
  });
  assert.deepEqual(out.remove.sort(), ['.agent-studio/bin/aee-gone', '.agent-studio/plugins/gone.json']);
});

// ---- idempotence + the granularity flip -------------------------------------

test('same id at the same granularity is a no-op (already synced)', () => {
  const g = [{ id: 'dummy-echo', scopeGranularity: 'team' }];
  const out = plan(g, g);
  assert.deepEqual(out, { write: [], remove: [], connect: [], disconnect: [] });
});

test('granularity flip re-mints the token + rewrites ONLY the config — additive, no orphan-removal, network kept', () => {
  const out = plan(
    [{ id: 'dummy-echo', scopeGranularity: 'team' }],
    [{ id: 'dummy-echo', scopeGranularity: 'agent' }],
  );
  // No removals (nothing is stranded/deleted) and no network churn.
  assert.deepEqual(out.remove, []);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.disconnect, []);
  // Exactly the config rewritten — the CLI bin is untouched.
  assert.equal(out.write.length, 1);
  const cfg = out.write[0];
  assert.equal(cfg.path, '.agent-studio/plugins/dummy-echo.json');
  assert.equal(cfg.content.scopeId, 't1-dev');           // now the agent id
  assert.equal(cfg.content.token, 'dummy-echo.t1-dev.SIG'); // re-minted for the new scope
});
