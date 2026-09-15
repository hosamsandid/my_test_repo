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

// #2308 AC12: every write item is tagged with the plugin it belongs to, so an
// impure caller can group a fresh grant's bin+config pair and treat a partial
// failure (one write throws, the other already landed) as ONE unit — rolling
// both back rather than stranding a CLI with no config or vice versa.
test('every write item (bin, config, and a granularity-flip config-only rewrite) carries pluginId', () => {
  const fresh = plan([], [{ id: 'dummy-echo', scopeGranularity: 'team' }]);
  assert.equal(fresh.write.length, 2);
  assert.ok(fresh.write.every((w) => w.pluginId === 'dummy-echo'));

  const flip = plan(
    [{ id: 'dummy-echo', scopeGranularity: 'team' }],
    [{ id: 'dummy-echo', scopeGranularity: 'agent' }],
  );
  assert.equal(flip.write.length, 1);
  assert.equal(flip.write[0].pluginId, 'dummy-echo');
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

// ── Command-only plugins (#1798): planWorkspaceSync skips them ────────────────
// Command-only plugins have no sidecar/cli: command file projection is done by
// _syncPluginIntoWorkspace (orchestrator.js) AFTER planWorkspaceSync runs; the
// planner itself must produce empty writes/removes/connect/disconnect for them.

const COMMAND_MANIFEST = {
  id: 'spec-kit',
  commands: { namespace: 'speckit' },
  fetch: { source: 'github', repo: 'github/spec-kit', ref: 'main' },
  // intentionally no cli / no sidecar
};
const COMMAND_MANIFESTS = { 'spec-kit': COMMAND_MANIFEST };

function commandPlan(prevGrant, nextGrant, agentCfg = MEMBER) {
  return planWorkspaceSync({ agentCfg, prevGrant, nextGrant, manifests: COMMAND_MANIFESTS, resolveScopeId, mintToken, networkNameFor });
}

test('command-only plugin grant produces no writes, no removes, no network connect', () => {
  const out = commandPlan([], [{ id: 'spec-kit', scopeGranularity: 'team' }]);
  assert.deepEqual(out.write, []);
  assert.deepEqual(out.remove, []);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.disconnect, []);
});

test('command-only plugin revoke produces no removes, no network disconnect', () => {
  const out = commandPlan([{ id: 'spec-kit', scopeGranularity: 'team' }], []);
  assert.deepEqual(out.write, []);
  assert.deepEqual(out.remove, []);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.disconnect, []);
});

test('command-only plugin same-granularity is a no-op', () => {
  const g = [{ id: 'spec-kit', scopeGranularity: 'team' }];
  const out = commandPlan(g, g);
  assert.deepEqual(out, { write: [], remove: [], connect: [], disconnect: [] });
});

test('mixed manifest set: cli plugin handled normally alongside a command-only plugin', () => {
  const mixed = { 'dummy-echo': MANIFEST, 'spec-kit': COMMAND_MANIFEST };
  const out = planWorkspaceSync({
    agentCfg: MEMBER,
    prevGrant: [],
    nextGrant: [
      { id: 'dummy-echo', scopeGranularity: 'team' },
      { id: 'spec-kit', scopeGranularity: 'team' },
    ],
    manifests: mixed,
    resolveScopeId, mintToken, networkNameFor,
  });
  // Only the cli plugin produces writes + network.
  const writePaths = out.write.map((w) => w.path);
  assert.ok(writePaths.includes('.agent-studio/bin/aee-echo'));
  assert.ok(writePaths.includes('.agent-studio/plugins/dummy-echo.json'));
  // No spec-kit bin or config.
  assert.ok(!writePaths.some((p) => p.includes('spec-kit')));
  assert.deepEqual(out.connect, [{ pluginId: 'dummy-echo', network: 'aee-net-t1-dev' }]);
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
