'use strict';

// ─── plugin workspace seed/sync planning (plugin system Phase 2, #1518) ──────
//
// Pure decision logic for what a granted agent's workspace must contain, and
// what network wiring the sidecar needs, so that granting/revoking a plugin is
// a LIVE ADDITIVE FILE SYNC — no respawn — exactly like a skill (de)activation
// (docs/plugin-system-concept.md §4.5/§4.7, the skill-sync pattern). The impure
// fs writes / network connect-disconnect live in the orchestrator runtime; the
// decidable plan is here so it is unit-testable without a container runtime,
// the same discipline as plugin-sidecar.js.
//
// The acceptance for Phase 2 is stated as three things that must appear on
// grant and vanish on revoke: the CLI, the token (config), and the CLAUDE.md
// one-liner — plus the network path. This module owns two of the three (CLI +
// token config) and the network; the CLAUDE.md one-liner is prompt-assembly.js
// (plugin-prompt.js). A revoke's plan REMOVES the bin + config and DISCONNECTS
// the network — the same reconciliation that makes a grant additive.
//
// Per-agent workspace layout (§4.5):
//   .agent-studio/bin/<cli.name>              — the dependency-free CLI facade, on PATH
//   .agent-studio/plugins/<pluginId>.json     — endpoint + per-scope token, mode 0600
//
// The config the CLI reads (see plugins/dummy-echo/bin/aee-echo.py load_config):
//   { pluginId, scopeId, endpoint, token, cliName }
// `scopeId` is resolved per agent under the grant's granularity (plugin-scope
// .js); `token` is minted for {pluginId, scopeId} (plugin-scope-token.js).

const path = require('path');

// The per-agent state directory, renamed from the legacy `.aee` (#1549).
const STATE_DIR = '.agent-studio';
const BIN_DIR = path.posix.join(STATE_DIR, 'bin');
const PLUGINS_DIR = path.posix.join(STATE_DIR, 'plugins');
const CONFIG_MODE = 0o600; // token lives here — never group/other readable
const BIN_MODE = 0o755;

// Where a plugin's CLI and per-agent config live in a granted workspace.
function agentPluginPaths(pluginId, cliName) {
  return {
    binPath: path.posix.join(BIN_DIR, String(cliName)),
    configPath: path.posix.join(PLUGINS_DIR, `${pluginId}.json`),
  };
}

// The endpoint a granted agent reaches the sidecar on. Reachability is per
// agent (§4.3) — the broker authorises by the token's scopeId, not by host — so
// the endpoint is the deterministic sidecar name + internal port, identical for
// every granted agent regardless of granularity.
function sidecarEndpoint(manifest) {
  const port = manifest && manifest.sidecar && manifest.sidecar.internalPort;
  return `http://aee-plugin-${manifest.id}:${port}`;
}

// The per-agent config object written to `.agent-studio/plugins/<id>.json`.
function pluginConfigFile({ pluginId, scopeId, endpoint, token, cliName }) {
  return { pluginId, scopeId, endpoint, token, cliName };
}

// Plan the workspace + network reconciliation for ONE agent moving from a
// previous resolved grant to a next resolved grant. Pure: the caller supplies
// the resolved bits so this module stays fs-/crypto-free.
//
//   agentCfg        : the agent config (its id / parentTeamId — for scopeId)
//   prevGrant       : normalised [{ id, scopeGranularity }] currently synced
//   nextGrant       : normalised [{ id, scopeGranularity }] desired
//   manifests       : { <pluginId>: normalised manifest }
//   resolveScopeId  : (agentCfg, granularity) => scopeId   (plugin-scope.js)
//   mintToken       : (pluginId, scopeId) => token         (plugin-scope-token.js)
//   networkNameFor  : (agentId) => sidecar-attach network name
//
// Returns { write: [{ path, mode, content|copyFrom }], remove: [path],
//           connect: [{ pluginId, network }], disconnect: [{ pluginId, network }] }.
//
// A plugin present in both grants at the SAME granularity is left untouched
// (idempotent — already synced). A plugin whose granularity CHANGED is
// re-written with a freshly-minted token for the new scopeId (§4.6): this is
// the one state transition that could strand resources, and it is handled as
// ADDITIVE — the config is rewritten, the network stays connected (reachability
// is unchanged), and NOTHING is removed. Resources the broker created under the
// old scopeId keep their `aee.plugin.owner` label and are reaped by TTL /
// teardown; there is no ownership migration and no orphan-deleting action here.
function planWorkspaceSync({
  agentCfg,
  prevGrant = [],
  nextGrant = [],
  manifests = {},
  resolveScopeId,
  mintToken,
  networkNameFor,
} = {}) {
  const prevById = new Map((prevGrant || []).map((g) => [g.id, g]));
  const nextById = new Map((nextGrant || []).map((g) => [g.id, g]));
  const network = typeof networkNameFor === 'function' && agentCfg ? networkNameFor(agentCfg.id) : null;

  const write = [];
  const remove = [];
  const connect = [];
  const disconnect = [];

  // Additions and granularity flips → (re)write bin + config; connect network.
  for (const [id, grant] of nextById) {
    const manifest = manifests[id];
    if (!manifest) continue; // uninstalled out from under the grant — skip, nothing to seed
    if (!manifest.cli) continue; // command-only plugin — command files projected separately in orchestrator
    const prev = prevById.get(id);
    const { binPath, configPath } = agentPluginPaths(id, manifest.cli.name);
    const scopeId = resolveScopeId(agentCfg, grant.scopeGranularity);
    const token = scopeId ? mintToken(id, scopeId) : null;

    if (!prev) {
      // Fresh grant: seed the CLI facade + config, connect the network path.
      write.push({ path: binPath, mode: BIN_MODE, copyFrom: manifest.cli.entrypoint });
      write.push({
        path: configPath,
        mode: CONFIG_MODE,
        content: pluginConfigFile({ pluginId: id, scopeId, endpoint: sidecarEndpoint(manifest), token, cliName: manifest.cli.name }),
      });
      if (network) connect.push({ pluginId: id, network });
    } else if (prev.scopeGranularity !== grant.scopeGranularity) {
      // Granularity flip: re-mint the token for the new scopeId and rewrite the
      // config ONLY. Additive — the bin is unchanged, the network stays, and no
      // old resource is removed (reaped by TTL/teardown under its owner label).
      write.push({
        path: configPath,
        mode: CONFIG_MODE,
        content: pluginConfigFile({ pluginId: id, scopeId, endpoint: sidecarEndpoint(manifest), token, cliName: manifest.cli.name }),
      });
    }
    // else: same id + same granularity → already synced, no action.
  }

  // Revocations → remove bin + config, disconnect the network path.
  for (const [id, grant] of prevById) {
    if (nextById.has(id)) continue;
    // Prefer the live manifest for the CLI name; fall back to a stored one on
    // the grant so an uninstalled plugin can still be cleaned up.
    const manifest = manifests[id];
    if (manifest && !manifest.cli) continue; // command-only plugin — no bin/config/network to remove
    const cliName = (manifest && manifest.cli && manifest.cli.name) || grant.cliName || id;
    const { binPath, configPath } = agentPluginPaths(id, cliName);
    remove.push(binPath, configPath);
    if (network) disconnect.push({ pluginId: id, network });
  }

  return { write, remove, connect, disconnect };
}

// Which of ONE agent's granted CLI copies differ from the registry. The grant
// sync above seeds the CLI only when the grant CHANGES, so a plugin re-installed
// with a newer CLI leaves every existing workspace on the old file — the agent
// then reports verbs "missing" that the broker has served for weeks. This plan
// is applied on every plugin reconcile: a copy that is absent or byte-different
// (by digest) is re-written, an identical one is left alone, and nothing is
// ever removed (a revoke is planWorkspaceSync's job).
//
//   grant           : normalised [{ id, scopeGranularity }] (effectivePlugins)
//   manifests       : { <pluginId>: normalised manifest }
//   workspaceDigest : (binPath) => digest string | null when the copy is absent
//   registryDigest  : (manifest) => digest string | null when unreadable
//
// Returns write items in planWorkspaceSync's `write` shape, plus a `reason`.
function planCliRefresh({ grant = [], manifests = {}, workspaceDigest, registryDigest } = {}) {
  const write = [];
  for (const g of grant || []) {
    const manifest = manifests[g.id];
    if (!manifest || !manifest.cli) continue; // uninstalled / command-only — nothing to refresh
    const wanted = registryDigest(manifest);
    if (!wanted) continue; // registry copy unreadable — leave the workspace as it is
    const { binPath } = agentPluginPaths(g.id, manifest.cli.name);
    const have = workspaceDigest(binPath);
    if (have === wanted) continue;
    write.push({ path: binPath, mode: BIN_MODE, copyFrom: manifest.cli.entrypoint, reason: have ? 'stale' : 'missing' });
  }
  return write;
}

module.exports = {
  STATE_DIR,
  BIN_DIR,
  PLUGINS_DIR,
  CONFIG_MODE,
  BIN_MODE,
  agentPluginPaths,
  sidecarEndpoint,
  pluginConfigFile,
  planWorkspaceSync,
  planCliRefresh,
};
