// Pure view helpers for the plugin REGISTRY page (#1547).
//
// Sibling of plugin-grant-view.js, which covers the per-agent grant row. This
// module covers the operator-facing install surface: what a plugin would be
// allowed to do if installed, whether it can be installed at all, and what
// state an installed one is in.
//
// The capability list is the important part. `sidecar.capabilities` is a closed
// enum the orchestrator turns directly into real privileges (a host bind mount,
// a socket), so an admin has to see it in plain language BEFORE confirming an
// install — an unreviewed "podman-socket" is the whole security model quietly
// handing out the host container runtime.
//
// No imports: unit-tested with node --test, bundled by Vite (#651 convention).

export const HOST_MOUNT_PREFIX = 'host-mount:';

// Plain-language, honestly-worded description of one declared capability.
// `risk` drives the visual weight; it is NOT a safety verdict, just how much
// the capability widens the blast radius beyond the sidecar.
export function describeCapability(cap) {
  if (typeof cap !== 'string' || !cap) return null;
  if (cap === 'podman-socket') {
    return {
      id: cap,
      title: 'Host container runtime',
      detail: 'Can create, inspect and remove containers on the host runtime. Containers it creates are labelled with the calling scope, so scopes cannot see each other — but the broker itself holds full socket access.',
      risk: 'high',
    };
  }
  if (cap === 'egress') {
    return {
      id: cap,
      title: 'Outbound network access',
      detail: 'The broker may reach systems outside this stack.',
      risk: 'medium',
    };
  }
  if (cap.startsWith(HOST_MOUNT_PREFIX)) {
    const p = cap.slice(HOST_MOUNT_PREFIX.length);
    return {
      id: cap,
      title: `Host folder ${p}`,
      detail: `Reads ${p} from the host, mounted read-only into the broker.`,
      risk: 'medium',
    };
  }
  // Unknown capability: the validator rejects these, so reaching here means a
  // manifest bypassed validation. Say so rather than rendering nothing.
  return {
    id: cap,
    title: `Unrecognised capability "${cap}"`,
    detail: 'This is not a capability the platform knows how to grant. The plugin will not install.',
    risk: 'unknown',
  };
}

export function describeCapabilities(manifest) {
  const caps = manifest && manifest.sidecar && Array.isArray(manifest.sidecar.capabilities)
    ? manifest.sidecar.capabilities
    : [];
  return caps.map(describeCapability).filter(Boolean);
}

// One-line summary of the per-scope resource cap, or the honest absence of one.
export function quotaSummary(manifest) {
  const q = manifest && manifest.quota;
  if (!q || !q.maxObjects) return 'No resource cap declared — this plugin is uncapped per scope.';
  const ttl = q.ttlSeconds ? `, reaped after ${formatDuration(q.ttlSeconds)}` : '';
  return `Up to ${q.maxObjects} object${q.maxObjects === 1 ? '' : 's'} per scope${ttl}.`;
}

export function formatDuration(seconds) {
  const s = Number(seconds);
  if (!Number.isFinite(s) || s < 1) return `${seconds}s`;
  if (s % 86400 === 0) return `${s / 86400}d`;
  if (s % 3600 === 0) return `${s / 3600}h`;
  if (s % 60 === 0) return `${s / 60}m`;
  return `${s}s`;
}

// What the install button should do and say for one registry entry.
//   entry : { id, ok, errors, manifest, installed, sidecarRunning }
//   { canManage, stackRuntime }
export function installAction(entry, { canManage = false, stackRuntime = null } = {}) {
  if (!entry) return { action: 'none', disabled: true, label: '', hint: '' };
  if (!entry.ok) {
    return {
      action: 'none',
      disabled: true,
      label: 'Cannot install',
      hint: (entry.errors && entry.errors[0]) || 'The manifest is invalid.',
    };
  }
  if (!canManage) {
    return {
      action: entry.installed ? 'uninstall' : 'install',
      disabled: true,
      label: entry.installed ? 'Uninstall' : 'Install',
      hint: 'Only a System Admin can install or remove plugins.',
    };
  }
  if (entry.installed) {
    return { action: 'uninstall', disabled: false, label: 'Uninstall', hint: '' };
  }
  const platforms = (entry.manifest && entry.manifest.platforms) || ['any'];
  const mismatched = !platforms.includes('any') && stackRuntime && !platforms.includes(stackRuntime);
  return {
    action: 'install',
    disabled: false,
    label: 'Install',
    // A platform mismatch WARNS rather than blocks: workspace seeding is
    // runtime-agnostic, so the grant half still works and the operator may have
    // a reason. It must not be silent, though.
    hint: mismatched
      ? `This plugin declares ${platforms.join(' / ')} but the stack runs ${stackRuntime}. Its broker will not start here.`
      : '',
  };
}

// The status chip for an installed plugin's broker.
export function sidecarStatus(entry) {
  if (!entry || !entry.installed) return { state: 'not-installed', label: 'Not installed', tone: 'muted' };
  // A command-only plugin (#1798) ships no broker sidecar — its manifest omits
  // the `sidecar` block. There is nothing to run, so a broker-status chip is
  // misleading: report a neutral state rather than "Broker not running" (#1861).
  // Only decide this when the manifest is readable; an invalid one (no manifest)
  // falls through to the running/unknown logic below.
  if (entry.manifest && !entry.manifest.sidecar) {
    return { state: 'none', label: 'No broker (command-only)', tone: 'muted' };
  }
  if (entry.sidecarRunning === true) return { state: 'running', label: 'Broker running', tone: 'ok' };
  if (entry.sidecarRunning === null || entry.sidecarRunning === undefined) {
    // Distinct from "stopped": we could not ask the orchestrator, and claiming
    // the broker is down would be a guess.
    return { state: 'unknown', label: 'Broker status unknown', tone: 'muted' };
  }
  return { state: 'stopped', label: 'Broker not running', tone: 'warn' };
}

// Fold one registry entry into everything the row renders.
export function pluginRegistryRow(entry, { canManage = false, stackRuntime = null } = {}) {
  const manifest = entry && entry.manifest;
  return {
    id: entry ? entry.id : '',
    name: (manifest && manifest.name) || (entry && entry.id) || '',
    description: (manifest && manifest.description) || '',
    version: (manifest && manifest.version) || null,
    cliName: (manifest && manifest.cli && manifest.cli.name) || null,
    scopes: (manifest && manifest.scopes) || ['team'],
    // The platforms the plugin declares (default ["any"]) and the manifest's
    // own grant default (#1691). Surfaced so the Plugins-page team-assignment
    // control can honour the platform-mismatch gate and reuse the same default
    // scope granularity the Agents-page grant would apply — without the raw
    // manifest leaking past this pure view.
    platforms: (manifest && Array.isArray(manifest.platforms) && manifest.platforms.length)
      ? manifest.platforms
      : ['any'],
    defaultScopeGranularity: (manifest && manifest.defaultScopeGranularity) || null,
    capabilities: describeCapabilities(manifest),
    quota: quotaSummary(manifest),
    ok: !!(entry && entry.ok),
    errors: (entry && entry.errors) || [],
    installed: !!(entry && entry.installed),
    status: sidecarStatus(entry),
    action: installAction(entry, { canManage, stackRuntime }),
    // #1599: a UI-bearing plugin that opted into global visibility. Surfaced so
    // an operator understands why an installed plugin appears for all users
    // (its UI entry is visible to every authenticated user, independent of any
    // team activation). Only meaningful for a plugin that actually ships a UI.
    globalUi: !!(manifest && manifest.ui && Array.isArray(manifest.ui.routes) && manifest.ui.global === true),
  };
}
