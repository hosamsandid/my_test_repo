'use strict';

// Pure hardening mutators applied to a caller-supplied compose doc after
// compose-validate.js has already rejected it or let it through. Sibling of
// compose-validate.js's reject-only gate: this module never rejects, it only
// tightens defaults the caller didn't set. Operates on the already-parsed
// YAML doc (same object-in/object-out convention as validateComposeFile) so
// server.js can mutate once and stringify once.

// Force every network this compose file creates to be `internal` — i.e. no
// default gateway route out of the bridge. Compose's implicit default
// network (and any caller-declared named network — external ones are
// already rejected in compose-validate.js) otherwise gets a normal gateway
// route like any other bridge on the host, so a spawned container can reach
// the *host's* other bridges by IP — including the real control-plane
// services (orchestrator, admin-console, podman-mcp itself), whose
// "internal-only, no-auth" model assumes a container can only be reached
// from its own network (AST round 8: a compose_up'd container completed a
// full authenticated MCP round-trip against podman-mcp's own `/mcp`, and a
// plain GET against orchestrator's `/internal/maintenance-mode`, purely by
// routing to their real IPs). `internal: true` removes the gateway/default
// route entirely: containers on this project's own network can still reach
// each other (multi-service stacks like the self-hosting test keep
// working), but nothing outside it. Applied unconditionally, overriding
// whatever the caller's own compose YAML says — the caller's compose file is
// untrusted, so it may not opt back out of isolation, mirroring how
// compose-validate.js rejects `external: true` rather than trusting the
// caller's own value.
function enforceNetworkIsolation(doc) {
  const networks = (doc.networks && typeof doc.networks === 'object') ? doc.networks : {};
  const names = Object.keys(networks).length ? Object.keys(networks) : ['default'];
  for (const name of names) {
    networks[name] = { ...(networks[name] || {}), internal: true };
  }
  doc.networks = networks;
  return doc;
}

// Default resource ceiling for every spawned service — AST round 9 found
// compose_up-spawned containers get zero limit (Memory=0, CpuQuota=0,
// PidsLimit=0, all "unlimited" in podman convention): a single scope could
// exhaust host memory/CPU/PIDs and degrade every other agent/team sharing
// this host. container-cap.js only bounds *how many* containers exist
// platform-wide, not what any one of them can consume. Applied per service
// only when the caller hasn't already set a value for that resource (either
// the legacy v2 key or its v3 `deploy.resources.limits` equivalent — both
// are honored by podman-compose, and setting our v2 key on top of a caller
// v3 value that podman-compose considers authoritative would just be
// confusing, not protective) — this only tightens an unset default, it never
// loosens a caller-supplied tighter limit.
const DEFAULT_MEM_LIMIT = process.env.PODMAN_MCP_DEFAULT_MEM_LIMIT || '512m';
const DEFAULT_CPUS = Number(process.env.PODMAN_MCP_DEFAULT_CPUS) || 1;
const DEFAULT_PIDS_LIMIT = Number(process.env.PODMAN_MCP_DEFAULT_PIDS_LIMIT) || 256;

function hasResourceLimit(svc, v2Key, v3Key) {
  if (svc[v2Key] != null) return true;
  const limits = svc.deploy && svc.deploy.resources && svc.deploy.resources.limits;
  return !!(limits && limits[v3Key] != null);
}

function injectResourceDefaults(doc) {
  const services = doc.services || {};
  for (const name of Object.keys(services)) {
    const svc = services[name] || {};
    if (!hasResourceLimit(svc, 'mem_limit', 'memory')) svc.mem_limit = DEFAULT_MEM_LIMIT;
    if (!hasResourceLimit(svc, 'cpus', 'cpus')) svc.cpus = DEFAULT_CPUS;
    // Inject PID limit via the v3 deploy.resources.limits.pids key — podman-compose
    // 4.3.1 silently ignores the legacy v2 `pids_limit` key (B4 fix).
    if (!hasResourceLimit(svc, 'pids_limit', 'pids')) {
      svc.deploy = svc.deploy || {};
      svc.deploy.resources = svc.deploy.resources || {};
      svc.deploy.resources.limits = svc.deploy.resources.limits || {};
      svc.deploy.resources.limits.pids = DEFAULT_PIDS_LIMIT;
    }
    services[name] = svc;
  }
  doc.services = services;
  return doc;
}

module.exports = {
  enforceNetworkIsolation,
  injectResourceDefaults,
  DEFAULT_MEM_LIMIT,
  DEFAULT_CPUS,
  DEFAULT_PIDS_LIMIT,
};
