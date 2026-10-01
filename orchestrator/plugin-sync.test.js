'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  agentPluginPaths,
  sidecarEndpoint,
  pluginConfigFile,
  planWorkspaceSync,
  planCliRefresh,
  withStoredCliNames,
  withStoredCommandNamespaces,
  uninstalledCommandRevokes,
  pluginCommandNamespace,
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

// ── Command-only plugins (#1798): no bin, token or network ──────────────────
// Command-only plugins have no sidecar/cli: command file projection is done by
// _syncPluginIntoWorkspace (orchestrator.js) AFTER planWorkspaceSync runs. The
// planner only records the command namespace in the plugin's config file on a
// fresh grant and drops that record on revoke (#2657).

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

test('command-only plugin grant writes only a namespace record — no bin, no token, no network connect', () => {
  const out = commandPlan([], [{ id: 'spec-kit', scopeGranularity: 'team' }]);
  assert.deepEqual(out.write, [{
    path: '.agent-studio/plugins/spec-kit.json',
    mode: CONFIG_MODE,
    content: { pluginId: 'spec-kit', commandNamespace: 'speckit' },
    pluginId: 'spec-kit',
  }]);
  assert.deepEqual(out.remove, []);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.disconnect, []);
});

test('command-only plugin revoke removes only the namespace record, no network disconnect', () => {
  const out = commandPlan([{ id: 'spec-kit', scopeGranularity: 'team' }], []);
  assert.deepEqual(out.write, []);
  assert.deepEqual(out.remove, ['.agent-studio/plugins/spec-kit.json']);
  assert.deepEqual(out.connect, []);
  assert.deepEqual(out.disconnect, []);
});

test('command-only plugin granularity flip writes nothing (the namespace does not depend on scope)', () => {
  const out = commandPlan([{ id: 'spec-kit', scopeGranularity: 'team' }], [{ id: 'spec-kit', scopeGranularity: 'agent' }]);
  assert.deepEqual(out, { write: [], remove: [], connect: [], disconnect: [] });
});

test('a manifest with neither cli nor commands produces nothing on grant or revoke', () => {
  const manifests = { bare: { id: 'bare' } };
  const g = [{ id: 'bare', scopeGranularity: 'team' }];
  const empty = { write: [], remove: [], connect: [], disconnect: [] };
  assert.deepEqual(planWorkspaceSync({ agentCfg: MEMBER, prevGrant: [], nextGrant: g, manifests, resolveScopeId, mintToken, networkNameFor }), empty);
  assert.deepEqual(planWorkspaceSync({ agentCfg: MEMBER, prevGrant: g, nextGrant: [], manifests, resolveScopeId, mintToken, networkNameFor }), empty);
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
  // spec-kit gets only its namespace record — no bin, no token.
  assert.deepEqual(out.write.filter((w) => w.pluginId === 'spec-kit').map((w) => w.path), ['.agent-studio/plugins/spec-kit.json']);
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

// ── planCliRefresh ──────────────────────────────────────────────────────────

test('planCliRefresh: a missing or byte-different CLI copy is re-seeded; an identical one is untouched', () => {
  const grant = [{ id: 'dummy-echo', scopeGranularity: 'team' }];
  const registryDigest = () => 'sha-new';
  const missing = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => null, registryDigest });
  assert.deepEqual(missing, [{ path: '.agent-studio/bin/aee-echo', mode: BIN_MODE, copyFrom: 'bin/aee-echo.py', reason: 'missing' }]);

  const stale = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => 'sha-old', registryDigest });
  assert.equal(stale[0].reason, 'stale');

  const same = planCliRefresh({ grant, manifests: MANIFESTS, workspaceDigest: () => 'sha-new', registryDigest });
  assert.deepEqual(same, []);
});

test('planCliRefresh: skips uninstalled, command-only and registry-unreadable plugins; never removes anything', () => {
  const manifests = {
    ...MANIFESTS,
    'cmd-only': { id: 'cmd-only', commands: { namespace: 'x' } },
  };
  const grant = [
    { id: 'dummy-echo', scopeGranularity: 'team' },
    { id: 'cmd-only', scopeGranularity: 'team' },
    { id: 'gone', scopeGranularity: 'team' },
  ];
  const plan = planCliRefresh({ grant, manifests, workspaceDigest: () => 'old', registryDigest: (m) => (m.id === 'dummy-echo' ? null : 'x') });
  // dummy-echo's registry file is unreadable (null) → not planned; the other two have no CLI at all.
  assert.deepEqual(plan, []);
  assert.deepEqual(planCliRefresh({ grant: [], manifests, workspaceDigest: () => null, registryDigest: () => 'x' }), []);
});

// ---- withStoredCliNames (#2651): revoking a grant whose plugin is uninstalled

test('an uninstalled prev grant gets the cliName its seeded config recorded', () => {
  const reads = [];
  const out = withStoredCliNames(
    [{ id: 'patterns-catalog', scopeGranularity: 'team' }, { id: 'dummy-echo', scopeGranularity: 'team' }],
    MANIFESTS,
    (id) => { reads.push(id); return { pluginId: id, cliName: 'aee-patterns' }; },
  );
  assert.deepEqual(out, [
    { id: 'patterns-catalog', scopeGranularity: 'team', cliName: 'aee-patterns' },
    { id: 'dummy-echo', scopeGranularity: 'team' }, // installed: the manifest names the CLI
  ]);
  assert.deepEqual(reads, ['patterns-catalog']);
});

test('the enriched grant makes the revoke remove the seeded CLI, not a bin named after the plugin id', () => {
  const prevGrant = withStoredCliNames([{ id: 'patterns-catalog', scopeGranularity: 'team' }], {}, () => ({ cliName: 'aee-patterns' }));
  const out = planWorkspaceSync({ agentCfg: MEMBER, prevGrant, nextGrant: [], manifests: {}, resolveScopeId, mintToken, networkNameFor });
  assert.deepEqual(out.remove.sort(), ['.agent-studio/bin/aee-patterns', '.agent-studio/plugins/patterns-catalog.json']);
});

test('a missing, unreadable or non-slug stored cliName is ignored (the file is agent-writable)', () => {
  const g = [{ id: 'gone', scopeGranularity: 'team' }];
  assert.deepEqual(withStoredCliNames(g, {}, () => null), g);
  assert.deepEqual(withStoredCliNames(g, {}, () => { throw new Error('ENOENT'); }), g);
  assert.deepEqual(withStoredCliNames(g, {}, () => ({ cliName: '../../../etc/passwd' })), g);
  assert.deepEqual(withStoredCliNames(g, {}, () => ({ cliName: 42 })), g);
});

test('a revoke never turns a non-slug grant.cliName into a path to delete', () => {
  const out = planWorkspaceSync({
    agentCfg: MEMBER,
    prevGrant: [{ id: 'gone', scopeGranularity: 'team', cliName: '../../secrets' }],
    nextGrant: [],
    manifests: {},
    resolveScopeId, mintToken, networkNameFor,
  });
  assert.deepEqual(out.remove.sort(), ['.agent-studio/bin/gone', '.agent-studio/plugins/gone.json']);
});

// ---- command namespace record (#2657): revoking an uninstalled plugin's commands

test('pluginCommandNamespace: the manifest namespace, else the plugin id, else null', () => {
  assert.equal(pluginCommandNamespace(COMMAND_MANIFEST), 'speckit');
  assert.equal(pluginCommandNamespace({ id: 'cmds', commands: {} }), 'cmds');
  assert.equal(pluginCommandNamespace(MANIFEST), null);
  assert.equal(pluginCommandNamespace(null), null);
});

test('a CLI plugin that also ships commands records the namespace in its config, on grant and on a flip', () => {
  const manifests = { both: { ...MANIFEST, id: 'both', commands: { namespace: 'both-cmds' } } };
  const fresh = planWorkspaceSync({ agentCfg: MEMBER, prevGrant: [], nextGrant: [{ id: 'both', scopeGranularity: 'team' }], manifests, resolveScopeId, mintToken, networkNameFor });
  assert.equal(fresh.write.find((w) => w.path === '.agent-studio/plugins/both.json').content.commandNamespace, 'both-cmds');
  const flip = planWorkspaceSync({ agentCfg: MEMBER, prevGrant: [{ id: 'both', scopeGranularity: 'team' }], nextGrant: [{ id: 'both', scopeGranularity: 'agent' }], manifests, resolveScopeId, mintToken, networkNameFor });
  assert.equal(flip.write[0].content.commandNamespace, 'both-cmds');
  // A CLI-only plugin's config keeps its old shape.
  assert.ok(!('commandNamespace' in plan([], [{ id: 'dummy-echo', scopeGranularity: 'team' }]).write.find((w) => w.path.endsWith('.json')).content));
});

test('an uninstalled prev grant gets the command namespace its seeded config recorded', () => {
  const reads = [];
  const out = withStoredCommandNamespaces(
    [{ id: 'spec-kit', scopeGranularity: 'team' }, { id: 'dummy-echo', scopeGranularity: 'team' }],
    MANIFESTS,
    (id) => { reads.push(id); return { pluginId: id, commandNamespace: 'speckit' }; },
  );
  assert.deepEqual(out, [
    { id: 'spec-kit', scopeGranularity: 'team', commandNamespace: 'speckit' },
    { id: 'dummy-echo', scopeGranularity: 'team' }, // installed: the manifest drives its commands
  ]);
  assert.deepEqual(reads, ['spec-kit']);
});

test('a missing, unreadable or non-slug stored commandNamespace is ignored (the file is agent-writable)', () => {
  const g = [{ id: 'gone', scopeGranularity: 'team' }];
  assert.deepEqual(withStoredCommandNamespaces(g, {}, () => null), g);
  assert.deepEqual(withStoredCommandNamespaces(g, {}, () => { throw new Error('ENOENT'); }), g);
  assert.deepEqual(withStoredCommandNamespaces(g, {}, () => ({ commandNamespace: '../../.claude' })), g);
  assert.deepEqual(withStoredCommandNamespaces(g, {}, () => ({ commandNamespace: 42 })), g);
  assert.deepEqual(withStoredCommandNamespaces(g, {}, () => ({ commandNamespace: '' })), g);
});

test('the stored cliName and command namespace compose onto the same grant entry', () => {
  const stored = { cliName: 'aee-both', commandNamespace: 'both-cmds' };
  const out = withStoredCommandNamespaces(withStoredCliNames([{ id: 'both', scopeGranularity: 'team' }], {}, () => stored), {}, () => stored);
  assert.deepEqual(out, [{ id: 'both', scopeGranularity: 'team', cliName: 'aee-both', commandNamespace: 'both-cmds' }]);
});

test('uninstalledCommandRevokes lists only revoked, uninstalled grants with a valid stored namespace', () => {
  const prev = [
    { id: 'gone', scopeGranularity: 'team', commandNamespace: 'gone-cmds' },
    { id: 'kept', scopeGranularity: 'team', commandNamespace: 'kept-cmds' },     // still granted
    { id: 'spec-kit', scopeGranularity: 'team', commandNamespace: 'speckit' },   // installed: manifest loop handles it
    { id: 'legacy', scopeGranularity: 'team' },                                  // granted before the record existed
    { id: 'tampered', scopeGranularity: 'team', commandNamespace: '../x' },
  ];
  const next = [{ id: 'kept', scopeGranularity: 'team' }];
  assert.deepEqual(uninstalledCommandRevokes(prev, next, COMMAND_MANIFESTS), [{ pluginId: 'gone', namespace: 'gone-cmds' }]);
  assert.deepEqual(uninstalledCommandRevokes(undefined, undefined, undefined), []);
});
