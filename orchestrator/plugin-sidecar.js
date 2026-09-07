'use strict';

// ─── plugin sidecar lifecycle planning (Phase 1, #1517) ──────────────────────
//
// Pure decision logic for the orchestrator's ownership of plugin broker
// sidecars (docs/plugin-system-concept.md §4.3). The impure libpod calls
// (container run/stop, network connect/disconnect) live in the orchestrator
// runtime; everything decidable is factored here so it is unit-testable
// without a container runtime — the same discipline as spawn-container's
// per-agent-network seam.
//
// Two reconciliations:
//   • reconcileSidecars   — which sidecars to start/stop so the live set
//     matches the installed set (orphans of uninstalled plugins are stopped).
//   • reconcileAttachments — which per-agent networks a sidecar must be
//     connected to / disconnected from so network truth matches grant truth.
//     Reachability is per agent either way — granularity changes the token
//     identity, not the network wiring (§4.3).

const { PLUGIN_ID_LABEL } = require('./plugin-scope');

const SIDECAR_NAME_PREFIX = 'aee-plugin-';

// Instance-ownership label (shared-store isolation). Parallel stacks share one
// rootful Podman store, so a plugin sidecar must be stamped with the instance
// that owns it — otherwise another stack's reconcile lists it (by the plugin-id
// label alone) and reaps it as an orphan of an uninstalled plugin. This is the
// same `aee.instance` scoping the agent-container eviction already uses
// (spawn-container.js). The container NAME is left unscoped on purpose: it is
// the endpoint agents already carry in .agent-studio/plugins/<id>.json, so
// changing it would strand live grants — ownership is expressed by the label,
// which reconcile filters on.
const INSTANCE_LABEL_KEY = 'aee.instance';

// Deterministic container name for a plugin's sidecar. Podman names are
// alnum + _.- ; plugin ids are already a-z0-9- (validator), so this is a
// straight prefix but we sanitise defensively.
function sidecarContainerName(pluginId) {
  const safe = String(pluginId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${SIDECAR_NAME_PREFIX}${safe}`;
}

// `instanceId` (optional) stamps `aee.instance` so a stack owns its sidecars.
// Default '' keeps the pre-isolation shape (plugin-id label only) so existing
// callers/tests are byte-identical.
function sidecarLabels(pluginId, instanceId = '') {
  const labels = { [PLUGIN_ID_LABEL]: String(pluginId) };
  if (instanceId) labels[INSTANCE_LABEL_KEY] = String(instanceId);
  return labels;
}

// Extract the plugin id a live sidecar belongs to, from its labels.
function sidecarPluginId(container) {
  return (container && container.Labels && container.Labels[PLUGIN_ID_LABEL]) || null;
}

// Does this plugin run a broker sidecar at all? A command-only plugin (#1798)
// declares `commands` and no `sidecar` — the manifest validator makes `sidecar`
// optional in that case (plugin-manifest.js) and the normalizer omits the block
// entirely. Both reconcile paths filter on this so a command-only plugin is
// never handed to startSidecar (which would dereference `sidecar.capabilities`
// on undefined and log a spurious "sidecar start failed" — #1861).
function manifestHasSidecar(manifest) {
  return !!(manifest && manifest.sidecar);
}

// The subset of installed plugin ids that actually run a broker sidecar — the
// input reconcileSidecars must key on so command-only plugins are neither
// started nor reported as orphaned stop targets. Pure so both runtimes share
// one filter (Podman plugin-runtime.js + the k8s sibling).
function sidecarPluginIds(manifests) {
  return Object.keys(manifests || {}).filter((id) => manifestHasSidecar((manifests || {})[id]));
}

// Given the ids of currently-installed plugins and the set of live sidecar
// containers, decide what to start and what to stop.
//   installedPluginIds : string[]
//   liveSidecars       : [{ Id?, Names?, Labels: { 'aee.plugin.id': <id> } }]
// Returns { toStart: string[], toStop: [{ pluginId, container }] }.
// An installed plugin with no live sidecar is started; a live sidecar whose
// plugin is not installed (uninstalled out from under it) is stopped — this is
// the "disappears on uninstall (reconciled)" acceptance.
function reconcileSidecars(installedPluginIds, liveSidecars) {
  const installed = new Set(installedPluginIds || []);
  const live = Array.isArray(liveSidecars) ? liveSidecars : [];
  const liveIds = new Set();
  const toStop = [];
  for (const c of live) {
    const pid = sidecarPluginId(c);
    if (!pid) continue;
    liveIds.add(pid);
    if (!installed.has(pid)) toStop.push({ pluginId: pid, container: c });
  }
  const toStart = [...installed].filter((id) => !liveIds.has(id));
  return { toStart, toStop };
}

// Grant-driven network attachment (§4.3). A sidecar must be connected into the
// per-agent networks of exactly the agents whose resolved grant includes the
// plugin, and disconnected from any others it is currently on.
//   grantedAgentIds  : string[]  (agents whose resolved grant includes plugin)
//   attachedNetworks : string[]  (per-agent networks the sidecar is on now)
//   networkNameFor   : (agentId) => networkName
// Returns { connect: string[], disconnect: string[] } (network names).
function reconcileAttachments(grantedAgentIds, attachedNetworks, networkNameFor) {
  const desired = new Set((grantedAgentIds || []).map((id) => networkNameFor(id)));
  const current = new Set(attachedNetworks || []);
  const connect = [...desired].filter((n) => !current.has(n));
  const disconnect = [...current].filter((n) => !desired.has(n));
  return { connect, disconnect };
}

// Translate a manifest's closed-enum capabilities (§4.1) into the concrete
// privileged attachments the orchestrator provides when it runs the sidecar.
// Unknown/host-mount entries are surfaced structurally so the caller (and
// install review) sees exactly what a plugin is granted — a plugin cannot
// request an arbitrary mount by hiding it in a string.
//   capabilities : string[]  (already validated by plugin-manifest)
// Returns { socket: boolean, egress: boolean, hostMounts: string[] }.
function capabilityAttachments(capabilities) {
  const caps = Array.isArray(capabilities) ? capabilities : [];
  const hostMounts = [];
  let socket = false;
  let egress = false;
  for (const c of caps) {
    if (c === 'podman-socket') socket = true;
    else if (c === 'egress') egress = true;
    else if (typeof c === 'string' && c.startsWith('host-mount:')) {
      hostMounts.push(c.slice('host-mount:'.length));
    }
  }
  return { socket, egress, hostMounts };
}

// The plugin-neutral env contract a broker reads through broker-config.js
// (§4.6/§4.8), built from its manifest. Pure so BOTH container runtimes derive
// an identical set of AEE_PLUGIN_* variables from the same manifest — the k8s
// Deployment (spawn-kubernetes-plugin.js) and the Podman create body
// (plugin-runtime.js sidecarCreateBody) must not drift on which variables the
// platform sets or how it defends them.
//
// Three invariants baked in here (all asserted in plugin-runtime.test.js):
//   1. Plugin-authored `sidecar.env` goes in FIRST so the platform contract
//      below always wins — a manifest cannot take its broker off the platform's
//      token authority or lift its own quota by pre-declaring these names.
//   2. Quota is deleted then re-set from the manifest, so an author cannot
//      manufacture the "no cap declared" state by supplying the variable.
//   3. `auditDir`/`stateDir` are the platform-chosen mount paths, not the
//      manifest's to override.
function brokerEnvContract(manifest, { signingSecret, auditDir, stateDir }) {
  const sidecar = (manifest && manifest.sidecar) || {};
  const quota = (manifest && manifest.quota) || {};
  const env = {
    ...(sidecar.env || {}),
    AEE_PLUGIN_ID: manifest.id,
    AEE_PLUGIN_PORT: String(sidecar.internalPort),
    AEE_PLUGIN_SIGNING_SECRET: signingSecret,
    AEE_PLUGIN_AUDIT_DIR: auditDir,
    AEE_PLUGIN_STATE_DIR: stateDir,
  };
  delete env.AEE_PLUGIN_QUOTA_MAX_OBJECTS;
  delete env.AEE_PLUGIN_QUOTA_TTL_SECONDS;
  if (Number.isInteger(quota.maxObjects)) env.AEE_PLUGIN_QUOTA_MAX_OBJECTS = String(quota.maxObjects);
  if (Number.isInteger(quota.ttlSeconds)) env.AEE_PLUGIN_QUOTA_TTL_SECONDS = String(quota.ttlSeconds);
  return env;
}

module.exports = {
  SIDECAR_NAME_PREFIX,
  INSTANCE_LABEL_KEY,
  sidecarContainerName,
  sidecarLabels,
  sidecarPluginId,
  manifestHasSidecar,
  sidecarPluginIds,
  reconcileSidecars,
  reconcileAttachments,
  capabilityAttachments,
  brokerEnvContract,
};
