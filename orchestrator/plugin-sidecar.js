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

// Deterministic container name for a plugin's sidecar. Podman names are
// alnum + _.- ; plugin ids are already a-z0-9- (validator), so this is a
// straight prefix but we sanitise defensively.
function sidecarContainerName(pluginId) {
  const safe = String(pluginId).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return `${SIDECAR_NAME_PREFIX}${safe}`;
}

function sidecarLabels(pluginId) {
  return { [PLUGIN_ID_LABEL]: String(pluginId) };
}

// Extract the plugin id a live sidecar belongs to, from its labels.
function sidecarPluginId(container) {
  return (container && container.Labels && container.Labels[PLUGIN_ID_LABEL]) || null;
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

module.exports = {
  SIDECAR_NAME_PREFIX,
  sidecarContainerName,
  sidecarLabels,
  sidecarPluginId,
  reconcileSidecars,
  reconcileAttachments,
  capabilityAttachments,
};
