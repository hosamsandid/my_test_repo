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

// A just-installed broker is given this long to come up before the card stops
// saying "Starting…" and says it did not start (#2649). Generous on purpose: an
// image pull on a fresh Kubernetes node takes well over the ~10 s it usually
// needs, and a false "did not start" is worse than a slow one.
export const BROKER_START_WINDOW_MS = 120_000;
// How often the page re-reads /api/plugins while any broker is starting.
export const BROKER_POLL_MS = 3_000;

function platformMismatch(manifest, stackRuntime) {
  const platforms = (manifest && manifest.platforms) || ['any'];
  return !platforms.includes('any') && !!stackRuntime && !platforms.includes(stackRuntime);
}

// An installed registry entry without a usable manifest — a directory in
// /workspace/plugins that is not a plugin (a backup copy, a bad id, a broken
// plugin.json). It must not look like an installed plugin (#2649).
export function isInvalidInstalled(entry) {
  return !!(entry && entry.installed && entry.ok === false);
}

// What the install button should do and say for one registry entry.
//   entry : { id, ok, errors, manifest, installed, sidecarRunning }
//   { canManage, stackRuntime }
export function installAction(entry, { canManage = false, stackRuntime = null } = {}) {
  if (!entry) return { action: 'none', disabled: true, label: '', hint: '' };
  // A broken INSTALLED entry can only be removed. It goes through the same
  // uninstall route, which accepts such a directory name (#2649).
  if (isInvalidInstalled(entry)) {
    return canManage
      ? { action: 'uninstall', disabled: false, label: 'Remove', hint: '' }
      : { action: 'uninstall', disabled: true, label: 'Remove', hint: 'Only a System Admin can install or remove plugins.' };
  }
  if (!entry.ok) {
    // The errors themselves are already listed on the card; repeating the first
    // one here printed it twice (#2649).
    return {
      action: 'none',
      disabled: true,
      label: 'Cannot install',
      hint: (entry.errors && entry.errors.length) ? 'Fix the errors above to make it installable.' : 'The manifest is invalid.',
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
  const mismatched = platformMismatch(entry.manifest, stackRuntime);
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
//   startingSince : ms timestamp of an install made from this page, or null
//   now           : current ms timestamp (injected so the window is testable)
// `reason` (possibly '') says WHY a broker is not running when we can tell.
export function sidecarStatus(entry, { startingSince = null, now = Date.now(), stackRuntime = null } = {}) {
  if (!entry || !entry.installed) return { state: 'not-installed', label: 'Not installed', tone: 'muted', reason: '' };
  // No manifest, no broker — and nothing to start. Say it is broken rather than
  // "Broker not running" (#2649).
  if (entry.ok === false) return { state: 'invalid', label: 'Invalid entry', tone: 'danger', reason: '' };
  // A command-only plugin (#1798) ships no broker sidecar — its manifest omits
  // the `sidecar` block. There is nothing to run, so a broker-status chip is
  // misleading: report a neutral state rather than "Broker not running" (#1861).
  if (entry.manifest && !entry.manifest.sidecar) {
    return { state: 'none', label: 'No broker (command-only)', tone: 'muted', reason: '' };
  }
  if (entry.sidecarRunning === true) return { state: 'running', label: 'Broker running', tone: 'ok', reason: '' };
  if (entry.sidecarRunning === null || entry.sidecarRunning === undefined) {
    // Distinct from "stopped": we could not ask the orchestrator, and claiming
    // the broker is down would be a guess.
    return { state: 'unknown', label: 'Broker status unknown', tone: 'muted', reason: '' };
  }
  const mismatch = platformMismatch(entry.manifest, stackRuntime)
    ? `This plugin declares ${entry.manifest.platforms.join(' / ')} but the stack runs ${stackRuntime}, so its broker cannot start here.`
    : '';
  // Just installed from this page: the broker is expected to take a few
  // seconds, so "not running" would be wrong until the window runs out (#2649).
  if (startingSince != null && !mismatch) {
    if (now - startingSince < BROKER_START_WINDOW_MS) {
      return { state: 'starting', label: 'Broker starting…', tone: 'muted', reason: '' };
    }
    return {
      state: 'failed',
      label: 'Broker did not start',
      tone: 'warn',
      reason: `The broker was not running ${Math.round(BROKER_START_WINDOW_MS / 1000)} s after install. `
        + 'Its image may be missing (`make plugin-images`) or the runtime refused to start it — check the orchestrator log.',
    };
  }
  return { state: 'stopped', label: 'Broker not running', tone: 'warn', reason: mismatch };
}

// The uninstall confirm's title/button/body. A broken entry is not a plugin, so
// "Uninstall" and "the broker stops" would both be wrong for it (#2649).
export function uninstallDialog(row) {
  if (!row) return { title: '', confirmLabel: 'Uninstall', body: '' };
  if (row.invalid) {
    return {
      title: `Remove ${row.id}?`,
      confirmLabel: 'Remove',
      body: `Deletes the directory "${row.id}" from the plugin registry. It is not a valid plugin, so no broker stops and no grant changes.`,
    };
  }
  return { title: `Uninstall ${row.name}?`, confirmLabel: 'Uninstall', body: '' };
}

// Should the page keep re-reading /api/plugins? Only while a broker is starting.
export function needsBrokerPoll(rows) {
  return (rows || []).some((r) => r && r.status && r.status.state === 'starting');
}

// Fold one registry entry into everything the row renders.
export function pluginRegistryRow(entry, { canManage = false, stackRuntime = null, startingSince = null, now = Date.now() } = {}) {
  const manifest = entry && entry.manifest;
  return {
    id: entry ? entry.id : '',
    name: (manifest && manifest.name) || (entry && entry.id) || '',
    description: (manifest && manifest.description) || '',
    version: (manifest && manifest.version) || null,
    cliName: (manifest && manifest.cli && manifest.cli.name) || null,
    // Without a manifest there is nothing to report: no scopes, no cap. The
    // defaults below only describe a real plugin (#2649).
    scopes: manifest ? (manifest.scopes || ['team']) : [],
    // The platforms the plugin declares (default ["any"]) and the manifest's
    // own grant default (#1691). Surfaced so the Plugins-page team-assignment
    // control can honour the platform-mismatch gate and reuse the same default
    // scope granularity the Agents-page grant would apply — without the raw
    // manifest leaking past this pure view.
    platforms: (manifest && Array.isArray(manifest.platforms) && manifest.platforms.length)
      ? manifest.platforms
      : ['any'],
    defaultScopeGranularity: (manifest && manifest.defaultScopeGranularity) || null,
    // The credential keys the plugin declares (Jira plan §5). Non-empty → the
    // card renders a per-team Credentials section. Raw manifest never leaks past
    // this pure view.
    credentialKeys: (manifest && Array.isArray(manifest.credentials))
      ? manifest.credentials.map((c) => c && c.key).filter(Boolean)
      : [],
    capabilities: describeCapabilities(manifest),
    quota: manifest ? quotaSummary(manifest) : '',
    ok: !!(entry && entry.ok),
    errors: (entry && entry.errors) || [],
    installed: !!(entry && entry.installed),
    invalid: isInvalidInstalled(entry),
    status: sidecarStatus(entry, { startingSince, now, stackRuntime }),
    action: installAction(entry, { canManage, stackRuntime }),
    // #1599: a UI-bearing plugin that opted into global visibility. Surfaced so
    // an operator understands why an installed plugin appears for all users
    // (its UI entry is visible to every authenticated user, independent of any
    // team activation). Only meaningful for a plugin that actually ships a UI.
    globalUi: !!(manifest && manifest.ui && Array.isArray(manifest.ui.routes) && manifest.ui.global === true),
  };
}
