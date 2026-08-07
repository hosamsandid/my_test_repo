'use strict';

// Pure validator for caller-supplied compose files. Called by toolComposeUp
// before any compose file is written to disk or handed to podman-compose.
//
// The threat model: an agent holds a valid scope token and can call compose_up
// with an arbitrary compose file.  The owner-label injection (injectOwnerLabels)
// and project-name scoping (projectFor) protect post-creation operations, but
// they do NOT validate creation-time primitives.  A hostile caller could supply
// privileged: true, network_mode: host, a Podman-socket bind-mount, etc. and
// gain full host access via the real Podman socket podman-mcp has mounted.
//
// This module rejects those primitives before any disk I/O or subprocess call.
// It operates on the already-parsed YAML doc so the caller can reuse the object
// it already parsed for the service-count check.
//
// projectFor()'s per-project namespacing (server.js) only governs volume
// names Compose derives implicitly. Compose's top-level `volumes:` section
// has a separate `external: true` mechanism that attaches to a volume by its
// exact GLOBAL name instead, which sidesteps that namespacing entirely — this
// module also rejects that (see isExternalVolume below).

// Capabilities that grant near-root or host-escape potential.
const BLOCKED_CAPS = new Set([
  'ALL',
  'SYS_ADMIN',       // full container escape
  'NET_ADMIN',       // modify network interfaces / iptables
  'SYS_PTRACE',      // ptrace any process
  'SYS_MODULE',      // load kernel modules
  'SYS_RAW_IO',      // raw I/O port access
  'SYS_BOOT',        // reboot
  'SYS_TIME',        // set system clock
  'MKNOD',           // create device files
  'MAC_ADMIN',       // MAC policy bypass
  'MAC_OVERRIDE',    // MAC policy bypass
  'LINUX_IMMUTABLE', // immutable bit manipulation
  'SYS_CHROOT',      // chroot escape
]);

// security_opt values that weaken the container's syscall/MAC filtering.
// Matched case-insensitively after stripping whitespace.
const BLOCKED_SECURITY_OPTS = [
  'seccomp=unconfined',   // disables all syscall filtering
  'apparmor=unconfined',  // disables AppArmor profile
];

// Allowlist approach for volume sources: a valid compose named-volume name
// consists only of [a-zA-Z0-9_.-] and must start with an alphanumeric character.
// Anything that doesn't match (/, ./, ../, ~/, $HOME, %7e, etc.) is treated as
// a host bind-mount and rejected.
//
// Prior denylist rounds caught /, ./, ../ but missed ~/. Inverting to an
// allowlist closes all current and future prefix variants in one rule: if it
// isn't a legal named-volume name, it's a host path.
const NAMED_VOLUME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.\-]*$/;

function isHostBindSource(src) {
  if (typeof src !== 'string' || src === '') return false;
  // Empty string = anonymous volume mount (:target) — fine.
  // Only a string that matches the named-volume allowlist is permitted.
  return !NAMED_VOLUME_RE.test(src);
}

// Returns true when a namespace-mode string shares the host's namespace or
// joins another existing container's namespace (container:<name>).
// Both are disallowed: "host" escapes to the real host; "container:<x>"
// shares network/pid/ipc with an arbitrary running container (e.g. orchestrator).
function isUnsafeNamespaceMode(val) {
  if (!val) return false;
  const v = String(val).toLowerCase().trim();
  return v === 'host' || v.startsWith('container:');
}

// Returns true when a top-level volume entry declares `external`, meaning it
// attaches to a pre-existing named volume by its *global* name (Compose's
// `external: true` / `external: { name: ... }` form) instead of letting
// Compose create/namespace a fresh volume scoped to this project. That
// global-name lookup bypasses projectFor()'s per-scope namespacing entirely —
// the volume name is resolved against every volume podman knows about, not
// just this scope's own, so it can attach read-only to any other scope's (or
// the control plane's own) volume.
function isExternalVolume(spec) {
  return !!(spec && typeof spec === 'object' && spec.external);
}

// Same bypass class as isExternalVolume, applied to networks instead of
// volumes: a top-level network declaring `external: true` (or `external:
// {name: ...}`) attaches to a pre-existing network by its *global* name
// instead of letting Compose create a fresh one scoped to this project. That
// would let a caller join the main stack's own network directly (or a
// sibling scope's), bypassing per-project network isolation entirely.
function isExternalNetwork(spec) {
  return !!(spec && typeof spec === 'object' && spec.external);
}

// B2 fix: optional platform-level ceilings on caller-supplied resource limits.
// Set PODMAN_MCP_MAX_MEM_LIMIT (e.g. "2g") and/or PODMAN_MCP_MAX_CPUS (e.g. "4")
// to reject compose files that explicitly request more than the ceiling. Both
// default to unset (no ceiling enforced), so this is a zero-impact change unless
// the operator configures the env vars.
const MAX_MEM_LIMIT = process.env.PODMAN_MCP_MAX_MEM_LIMIT || null;
const MAX_CPUS = process.env.PODMAN_MCP_MAX_CPUS != null ? Number(process.env.PODMAN_MCP_MAX_CPUS) : null;

// Parse a memory string like "512m", "2g", "1.5g" to bytes. Returns null on
// unparseable input (treated as "no ceiling / no request").
function parseMemBytes(s) {
  if (s == null) return null;
  const m = String(s).trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([kmgt]?)b?$/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  const mult = { '': 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2]];
  return mult != null ? n * mult : null;
}

// Returns { ok: true } or { ok: false, error: string }.
// `doc` is the already-parsed YAML object (YAML.parse(composeFile)).
function validateComposeFile(doc) {
  // --- top-level volumes: reject `external` before any service is inspected ---
  const topVolumes = doc && doc.volumes;
  if (topVolumes && typeof topVolumes === 'object') {
    for (const [volName, volSpec] of Object.entries(topVolumes)) {
      if (isExternalVolume(volSpec)) {
        return {
          ok: false,
          error: `volume "${volName}": external volumes are not allowed (bypasses per-scope namespacing); omit "external" to get a fresh volume scoped to this project`,
        };
      }
    }
  }

  // --- top-level networks: reject `external` before any service is inspected ---
  const topNetworks = doc && doc.networks;
  if (topNetworks && typeof topNetworks === 'object') {
    for (const [netName, netSpec] of Object.entries(topNetworks)) {
      if (isExternalNetwork(netSpec)) {
        return {
          ok: false,
          error: `network "${netName}": external networks are not allowed (bypasses per-project network isolation); omit "external" to get a fresh network scoped to this project`,
        };
      }
    }
  }

  const services = doc && doc.services;
  if (!services || typeof services !== 'object') return { ok: true }; // nothing left to validate

  for (const [name, svc] of Object.entries(services)) {
    if (!svc || typeof svc !== 'object') continue;
    const ctx = `service "${name}"`;

    // --- privileged ---
    if (svc.privileged === true) {
      return { ok: false, error: `${ctx}: privileged containers are not allowed in the sandbox` };
    }

    // --- network_mode: host or container:<name> ---
    if (isUnsafeNamespaceMode(svc.network_mode)) {
      return { ok: false, error: `${ctx}: network_mode: ${svc.network_mode} is not allowed (use the default bridge network)` };
    }

    // --- pid namespace ---
    if (isUnsafeNamespaceMode(svc.pid)) {
      return { ok: false, error: `${ctx}: pid: ${svc.pid} is not allowed` };
    }

    // --- ipc namespace ---
    if (isUnsafeNamespaceMode(svc.ipc)) {
      return { ok: false, error: `${ctx}: ipc: ${svc.ipc} is not allowed` };
    }

    // --- userns_mode ---
    if (isUnsafeNamespaceMode(svc.userns_mode)) {
      return { ok: false, error: `${ctx}: userns_mode: ${svc.userns_mode} is not allowed` };
    }

    // --- cgroup_parent pointing at host root ---
    if (svc.cgroup_parent != null && String(svc.cgroup_parent).toLowerCase().trim() === 'host') {
      return { ok: false, error: `${ctx}: cgroup_parent: host is not allowed` };
    }

    // --- cap_add ---
    const caps = svc.cap_add;
    if (caps != null) {
      const list = Array.isArray(caps) ? caps : [caps];
      for (const cap of list) {
        if (BLOCKED_CAPS.has(String(cap).toUpperCase())) {
          return { ok: false, error: `${ctx}: cap_add: ${cap} is not allowed in the sandbox` };
        }
      }
    }

    // --- security_opt: block seccomp/apparmor=unconfined ---
    const secOpts = svc.security_opt;
    if (Array.isArray(secOpts)) {
      for (const opt of secOpts) {
        const normalized = String(opt).toLowerCase().replace(/\s/g, '');
        for (const blocked of BLOCKED_SECURITY_OPTS) {
          if (normalized === blocked) {
            return { ok: false, error: `${ctx}: security_opt: ${opt} is not allowed in the sandbox` };
          }
        }
      }
    }

    // --- volumes: allowlist-based host bind-mount detection ---
    // Any source that isn't a valid named-volume name is treated as a host path.
    // This covers /, ./, ../, ~/, $HOME, %7e-encoded paths, and any future variant.
    const vols = svc.volumes;
    if (Array.isArray(vols)) {
      for (const vol of vols) {
        let hostSrc = null;
        if (typeof vol === 'string') {
          // Short form "source:target[:opts]" — extract the source segment.
          const src = vol.split(':')[0];
          if (isHostBindSource(src)) hostSrc = src;
        } else if (vol && typeof vol === 'object') {
          // Long-form: { type: 'bind', source: '...', target: '...' }
          if (vol.type === 'bind' && isHostBindSource(vol.source)) {
            hostSrc = vol.source;
          }
        }
        if (hostSrc !== null) {
          return { ok: false, error: `${ctx}: host path bind mounts are not allowed (${hostSrc}); use named volumes instead` };
        }
      }
    }

    // --- devices ---
    if (Array.isArray(svc.devices) && svc.devices.length > 0) {
      return { ok: false, error: `${ctx}: device passthrough is not allowed` };
    }

    // --- B2: ceiling on caller-supplied resource limits ---
    // Only checked when the operator has configured a ceiling (env vars unset =
    // no ceiling). The default injection in compose-harden.js only fills in
    // *unset* values, so a caller that sets an explicit limit bypasses it —
    // this gate is the only enforcement for explicit over-ceiling requests.
    // Must check BOTH the legacy v2 keys (`mem_limit`/`cpus`) and their v3
    // `deploy.resources.limits` equivalents — podman-compose 4.3.1 honors
    // either form for memory/CPU (only PIDs needs the v3 key), and
    // compose-harden.js's own defaults are written via the v2 keys, so a
    // caller using the same v2 form would otherwise bypass the ceiling
    // entirely (AST round 10, finding 2). Check both independently (not
    // "v3 wins") so a caller can't dodge the ceiling by setting a
    // within-ceiling v3 value alongside an over-ceiling v2 one.
    const deployLimits = svc.deploy && svc.deploy.resources && svc.deploy.resources.limits;

    if (MAX_MEM_LIMIT != null) {
      const ceil = parseMemBytes(MAX_MEM_LIMIT);
      for (const memRequested of [svc.mem_limit, deployLimits && deployLimits.memory]) {
        if (memRequested == null) continue;
        const req = parseMemBytes(memRequested);
        if (req !== null && ceil !== null && req > ceil) {
          return { ok: false, error: `${ctx}: memory limit ${memRequested} exceeds platform maximum (PODMAN_MCP_MAX_MEM_LIMIT=${MAX_MEM_LIMIT})` };
        }
      }
    }
    if (MAX_CPUS !== null && !isNaN(MAX_CPUS)) {
      for (const cpusRequested of [svc.cpus, deployLimits && deployLimits.cpus]) {
        if (cpusRequested == null) continue;
        const req = Number(cpusRequested);
        if (!isNaN(req) && req > MAX_CPUS) {
          return { ok: false, error: `${ctx}: cpu limit ${cpusRequested} exceeds platform maximum (PODMAN_MCP_MAX_CPUS=${MAX_CPUS})` };
        }
      }
    }
  }

  return { ok: true };
}

module.exports = { validateComposeFile, BLOCKED_CAPS, parseMemBytes };
