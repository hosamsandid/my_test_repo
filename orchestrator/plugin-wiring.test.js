'use strict';

// Cross-module wiring for the plugin live stack (#1547).
//
// Each plugin module is unit-tested in isolation, but the failures that
// actually shipped were in the SEAMS between them: the CLI posting to a URL the
// broker did not serve, a config written where the CLI does not look, the
// orchestrator's token module drifting from the broker's copy. These tests
// exercise the joins, using the real registry, the real planner and the real
// SDK — no container runtime required.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const { mint } = require('./plugin-scope-token');
const brokerSdk = require('../broker-sdk');
const { resolveScopeId } = require('./plugin-scope');
const { planWorkspaceSync, sidecarEndpoint, agentPluginPaths } = require('./plugin-sync');
const { effectivePlugins } = require('./plugin-grants');
const registry = require('./plugin-registry');

const SECRET = 'test-signing-secret';

function tmpRegistryWithSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-wiring-'));
  // The REAL shipped manifest + CLI, so a change to either is caught here.
  fs.mkdirSync(path.join(dir, 'podman-sandbox', 'bin'), { recursive: true });
  fs.copyFileSync(
    path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'plugin.json'),
    path.join(dir, 'podman-sandbox', 'plugin.json'),
  );
  fs.copyFileSync(
    path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'bin', 'aee-podman.py'),
    path.join(dir, 'podman-sandbox', 'bin', 'aee-podman.py'),
  );
  return dir;
}

test('a token the orchestrator mints is accepted by the broker SDK, with the same claims', () => {
  // The orchestrator mints with plugin-scope-token.js; a broker verifies with
  // broker-sdk/scope-token.js. They are separate files by necessity (disjoint
  // build contexts), so the contract between them is asserted, not assumed.
  const token = mint('podman-sandbox', 'team-alpha', SECRET);
  const viaSdk = brokerSdk.verify(token, SECRET);
  assert.deepEqual(viaSdk, { pluginId: 'podman-sandbox', scopeId: 'team-alpha' });

  // And through the header path a broker actually uses.
  const req = { headers: { authorization: `Bearer ${token}` } };
  assert.deepEqual(brokerSdk.verifyScopeToken(req, SECRET), {
    pluginId: 'podman-sandbox',
    scopeId: 'team-alpha',
  });
});

test('a token minted for one plugin cannot be replayed against another', () => {
  const token = mint('podman-sandbox', 'team-alpha', SECRET);
  // Same secret serves every plugin; the pluginId inside the payload is what
  // stops cross-plugin reuse. A broker enforcing on scopeId still sees the
  // pluginId it was minted for, never the one being called.
  assert.equal(brokerSdk.verify(token, SECRET).pluginId, 'podman-sandbox');
  assert.equal(brokerSdk.verify(token, 'other-secret'), null);
});

test('the seeded config is exactly what the shipped CLI reads', () => {
  const dir = tmpRegistryWithSandbox();
  const manifests = registry.installedManifests(dir);
  const agentCfg = { id: 'dev-1', role: 'team-member', parentTeamId: 'squad', token: 't' };

  const plan = planWorkspaceSync({
    agentCfg,
    prevGrant: [],
    nextGrant: [{ id: 'podman-sandbox', scopeGranularity: 'agent' }],
    manifests,
    resolveScopeId,
    mintToken: (pluginId, scopeId) => mint(pluginId, scopeId, SECRET),
    networkNameFor: (id) => `aee-agent-${id}`,
  });

  const config = plan.write.find((w) => w.path.endsWith('podman-sandbox.json'));
  assert.ok(config, 'a grant must write the per-agent config');
  assert.equal(config.mode, 0o600, 'the token must never be group/other readable');

  // These four keys are what plugins/podman-sandbox/bin/aee-podman.py load_config
  // reads. Renaming one here silently ungrants every agent.
  assert.deepEqual(Object.keys(config.content).sort(), ['cliName', 'endpoint', 'pluginId', 'scopeId', 'token']);
  assert.equal(config.content.cliName, 'aee-podman');
  // agent granularity → the member's own id, not the team's.
  assert.equal(config.content.scopeId, 'dev-1');
  assert.deepEqual(brokerSdk.verify(config.content.token, SECRET), {
    pluginId: 'podman-sandbox',
    scopeId: 'dev-1',
  });
});

test('the CLI is seeded executable at the path the PATH entry covers', () => {
  const dir = tmpRegistryWithSandbox();
  const manifests = registry.installedManifests(dir);
  const plan = planWorkspaceSync({
    agentCfg: { id: 'solo', token: 't' },
    prevGrant: [],
    nextGrant: [{ id: 'podman-sandbox', scopeGranularity: 'team' }],
    manifests,
    resolveScopeId,
    mintToken: (p, s) => mint(p, s, SECRET),
    networkNameFor: (id) => `aee-agent-${id}`,
  });

  const bin = plan.write.find((w) => w.copyFrom);
  assert.equal(bin.path, '.agent-studio/bin/aee-podman');
  assert.equal(bin.mode, 0o755);
  // The entrypoint prepends <workspace>/.agent-studio/bin to PATH, so the seeded name
  // must be the bare CLI name the prompt tells the agent to run.
  assert.equal(path.basename(bin.path), manifests['podman-sandbox'].cli.name);
  // And it must resolve to a real file inside the registry.
  assert.ok(fs.existsSync(registry.cliEntrypointPath(manifests['podman-sandbox'], dir)));
});

test('the seeded endpoint plus the CLI wire path equals the route the broker serves', () => {
  const dir = tmpRegistryWithSandbox();
  const manifest = registry.installedManifests(dir)['podman-sandbox'];
  const base = sidecarEndpoint(manifest);

  assert.equal(base, 'http://aee-plugin-podman-sandbox:4004', 'no path: the platform does not know the wire protocol');

  // aee-podman.py appends MCP_PATH to the base. Read it out of the shipped CLI
  // so this test fails if the CLI stops appending it — the exact defect that
  // made every call 404 before #1547.
  const cliSource = fs.readFileSync(
    path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'bin', 'aee-podman.py'), 'utf8',
  );
  const m = cliSource.match(/^MCP_PATH\s*=\s*"([^"]+)"/m);
  assert.ok(m, 'aee-podman must declare MCP_PATH');
  assert.equal(base.replace(/\/$/, '') + m[1], 'http://aee-plugin-podman-sandbox:4004/mcp');

  // And that is the only non-/healthz, non-teardown route the broker answers.
  const brokerSource = fs.readFileSync(path.join(__dirname, '..', 'plugins', 'podman-sandbox', 'broker', 'server.js'), 'utf8');
  assert.ok(brokerSource.includes("req.url !== '/mcp'"), 'the broker still gates on /mcp');
});

test('a team-granularity grant gives every member of a squad the same scopeId', () => {
  const team = { id: 'squad', role: 'team', plugins: [{ id: 'podman-sandbox', scopeGranularity: 'team' }] };
  const load = (id) => (id === 'squad' ? team : null);
  const a = { id: 'dev-1', role: 'team-member', parentTeamId: 'squad' };
  const b = { id: 'dev-2', role: 'team-member', parentTeamId: 'squad' };

  const ga = effectivePlugins(a, load)[0];
  const gb = effectivePlugins(b, load)[0];
  assert.equal(resolveScopeId(a, ga.scopeGranularity), 'squad');
  assert.equal(resolveScopeId(b, gb.scopeGranularity), 'squad');

  // Flip to agent granularity and they diverge — same code path, different id.
  assert.equal(resolveScopeId(a, 'agent'), 'dev-1');
  assert.equal(resolveScopeId(b, 'agent'), 'dev-2');
});

test('a granularity flip re-mints the token and rewrites ONLY the config', () => {
  const dir = tmpRegistryWithSandbox();
  const manifests = registry.installedManifests(dir);
  const agentCfg = { id: 'dev-1', role: 'team-member', parentTeamId: 'squad', token: 't' };

  const plan = planWorkspaceSync({
    agentCfg,
    prevGrant: [{ id: 'podman-sandbox', scopeGranularity: 'team' }],
    nextGrant: [{ id: 'podman-sandbox', scopeGranularity: 'agent' }],
    manifests,
    resolveScopeId,
    mintToken: (p, s) => mint(p, s, SECRET),
    networkNameFor: (id) => `aee-agent-${id}`,
  });

  assert.equal(plan.write.length, 1, 'only the config is rewritten — the CLI is unchanged');
  assert.deepEqual(plan.remove, [], 'a flip is additive: nothing is orphan-removed');
  assert.deepEqual(plan.disconnect, [], 'reachability is unchanged, so the network stays');
  assert.equal(plan.write[0].path, agentPluginPaths('podman-sandbox', 'aee-podman').configPath);
  assert.equal(brokerSdk.verify(plan.write[0].content.token, SECRET).scopeId, 'dev-1');
});

test('revoking removes both files and disconnects the network', () => {
  const dir = tmpRegistryWithSandbox();
  const manifests = registry.installedManifests(dir);
  const plan = planWorkspaceSync({
    agentCfg: { id: 'solo', token: 't' },
    prevGrant: [{ id: 'podman-sandbox', scopeGranularity: 'team' }],
    nextGrant: [],
    manifests,
    resolveScopeId,
    mintToken: (p, s) => mint(p, s, SECRET),
    networkNameFor: (id) => `aee-agent-${id}`,
  });

  assert.deepEqual(plan.remove.sort(), ['.agent-studio/bin/aee-podman', '.agent-studio/plugins/podman-sandbox.json']);
  assert.deepEqual(plan.disconnect, [{ pluginId: 'podman-sandbox', network: 'aee-agent-solo' }]);
});

test('an uninstalled-but-granted plugin seeds nothing rather than half a grant', () => {
  const plan = planWorkspaceSync({
    agentCfg: { id: 'solo', token: 't' },
    prevGrant: [],
    nextGrant: [{ id: 'podman-sandbox', scopeGranularity: 'team' }],
    manifests: {}, // uninstalled out from under the grant
    resolveScopeId,
    mintToken: (p, s) => mint(p, s, SECRET),
    networkNameFor: (id) => `aee-agent-${id}`,
  });
  assert.deepEqual(plan.write, []);
  assert.deepEqual(plan.connect, []);
});
