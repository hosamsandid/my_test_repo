'use strict';

// context-mount.js — pure validation + libpod-specgen helpers for the per-agent
// read-only host-folder mount (#1283).
//
// An admin may point one agent at a single host directory that is bind-mounted
// READ-ONLY into that agent's container at a fixed, documented path (`/context`).
// This module is dependency-free and unit-tested (`node --test
// orchestrator/context-mount.test.js`) — same discipline as process-template.js.
// It owns ONLY the string-level policy (validate a host path, shape the libpod
// mount). The local-environment trust boundary + admin gate live at the API
// layer; the actual mount is applied in spawn-container.js.
//
// DUPLICATED, byte-identical, at admin-console/api/context-mount.js — the two
// container images copy disjoint file sets, so this pure module lives in both
// (like usage-log.js / github-event-log.js / skill-manifest.js). Change both in
// one commit.

const path = require('path');

// Fixed, documented mount target inside every agent container. Agents and their
// prompts can rely on this stable location (#1283 design decision).
const CONTEXT_MOUNT_TARGET = '/context';

// Defensive upper bound on a host path length.
const MAX_PATH_LEN = 4096;

// Denied directory trees: mounting the directory itself OR anything beneath it
// is rejected. These are the obviously-unsafe system locations — exposing them
// (even read-only) would leak host credentials, kernel/state interfaces, or the
// container store. Not an exhaustive allowlist (v1 is a denylist per the issue),
// just a basic guard against the footguns.
const DENY_TREES = [
  '/etc', '/root', '/boot',
  '/proc', '/sys', '/dev', '/run',
  '/usr', '/bin', '/sbin', '/lib', '/lib32', '/lib64',
  '/var/lib', '/var/run',
];

function isUnderTree(p, tree) {
  return p === tree || p.startsWith(tree + '/');
}

// True if the string contains a NUL or other ASCII control character. Built by
// char-code scan (no control-char regex literal) so the source stays clean text.
function hasControlChar(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x20 || c === 0x7f) return true;
  }
  return false;
}

// Validate an admin-supplied host directory path.
// Returns { ok: true, path: <normalized absolute path> } or { ok: false, error }.
// `path` on success is the normalized value that should be persisted + mounted.
function validateHostMountPath(input) {
  if (typeof input !== 'string') {
    return { ok: false, error: 'Host path must be a string' };
  }
  const raw = input.trim();
  if (!raw) {
    return { ok: false, error: 'Host path must not be empty' };
  }
  if (raw.length > MAX_PATH_LEN) {
    return { ok: false, error: `Host path is too long (max ${MAX_PATH_LEN} characters)` };
  }
  // Reject NUL and other control characters outright (path smuggling / broken
  // specgen). Spaces and non-ASCII are allowed (valid folder names).
  if (hasControlChar(raw)) {
    return { ok: false, error: 'Host path contains control characters' };
  }
  if (!raw.startsWith('/')) {
    return { ok: false, error: 'Host path must be absolute (start with "/")' };
  }
  // Reject any traversal segment explicitly (AC7) — before normalization, so an
  // attempt like /home/a/../../etc is refused as traversal rather than silently
  // collapsing onto the denylist.
  const segments = raw.split('/');
  if (segments.includes('..')) {
    return { ok: false, error: 'Host path must not contain ".." traversal segments' };
  }
  // Normalize (collapse "." and duplicate slashes, drop a trailing slash).
  let normalized = path.posix.normalize(raw);
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  if (!path.posix.isAbsolute(normalized)) {
    return { ok: false, error: 'Host path must be absolute (start with "/")' };
  }
  if (normalized === '/') {
    return { ok: false, error: 'Refusing to mount the host filesystem root' };
  }
  for (const tree of DENY_TREES) {
    if (isUnderTree(normalized, tree)) {
      return { ok: false, error: `Refusing to mount an unsafe system directory (${tree})` };
    }
  }
  return { ok: true, path: normalized };
}

// Build the libpod /containers/create `mounts[]` entry for a validated host
// path. NOTE the lowercase keys: libpod's `mounts` array is typed as the OCI
// runtime-spec Mount (`{ destination, type, source, options }`), which
// serializes lowercase — distinct from the capitalized NamedVolume shape
// (`{ Name, Dest, SubPath }`) used by the `volumes` array in the same createBody.
// Read-only (AC4) + SELinux relabel `z` so the mount works on Fedora-family
// (SELinux-enforcing) hosts without breaking container startup (AC9). Returns
// null when the path is invalid (caller should have validated first — this is a
// fail-closed second gate).
function buildContextMountSpec(hostPath) {
  const v = validateHostMountPath(hostPath);
  if (!v.ok) return null;
  return {
    type: 'bind',
    source: v.path,
    destination: CONTEXT_MOUNT_TARGET,
    options: ['ro', 'z'],
  };
}

module.exports = {
  CONTEXT_MOUNT_TARGET,
  DENY_TREES,
  validateHostMountPath,
  buildContextMountSpec,
};
