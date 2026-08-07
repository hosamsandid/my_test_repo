'use strict';

// context-mount.js — pure validation + libpod-specgen helpers for the per-agent
// host-folder mount (#1283).
//
// An admin may point one agent at host directories that are bind-mounted into
// that agent's container — READ-ONLY by default, or READ-WRITE when the
// per-folder opt-in is set (#1289). Originally exactly one folder at the fixed
// target `/context` (#1283); #1290 generalises this to **multiple** folders,
// each at its own distinct, stable target `/context/<slug>` (the legacy single
// folder keeps the bare `/context` target for backward compatibility).
// This module is dependency-free and unit-tested (`node --test
// orchestrator/context-mount.test.js`) — same discipline as process-template.js.
// It owns ONLY the string-level policy (validate a host path, derive a stable
// slug, shape the libpod mount, resolve a config to the list of folders to
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

// Cap on the number of folders one agent may mount (#1290). Keeps the admin UI
// usable and bounds the container's mount list; well above any realistic need.
const MAX_CONTEXT_MOUNTS = 20;

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
// Access mode is `ro` by default and `rw` when `readWrite` is set (#1289) —
// read-only stays the default so an agent without the opt-in behaves exactly as
// before. `target` is the in-container destination — defaults to the fixed
// `/context` (single-folder / legacy), or `/context/<slug>` for a folder in a
// multi-folder set (#1290). Either way the SELinux relabel `z` is applied so the
// mount works on Fedora-family (SELinux-enforcing) hosts without breaking
// container startup; `z` relabels the source for both read and write, so it is
// correct for the read-write case too. Returns null when the path is invalid
// (caller should have validated first — this is a fail-closed second gate).
function buildContextMountSpec(hostPath, { readWrite = false, target = CONTEXT_MOUNT_TARGET } = {}) {
  const v = validateHostMountPath(hostPath);
  if (!v.ok) return null;
  return {
    type: 'bind',
    source: v.path,
    destination: target,
    options: [readWrite ? 'rw' : 'ro', 'z'],
  };
}

// The last path segment of an absolute host path (used as a folder's default
// label). Pure string work — the orchestrator runs in a container and never
// stats the host.
function basenameOf(p) {
  const parts = String(p == null ? '' : p).split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

// Derive a filesystem-safe, STABLE slug for a folder label — used as the last
// segment of the in-container target `/context/<slug>` (#1290). Lowercased;
// every run of characters outside [a-z0-9._-] collapses to a single '-';
// leading/trailing '-'/'.' trimmed; capped in length; empty → 'folder'.
// Deterministic, so the same label always yields the same slug — which is what
// makes a folder's target stable across edits. Written as a linear char scan
// (no anchored trim regex) to stay clear of CodeQL's polynomial-redos rule.
function slugifyMountName(name) {
  const raw = (name == null ? '' : String(name)).trim().toLowerCase();
  const chars = [];
  let lastDash = false;
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    const code = raw.charCodeAt(i);
    const ok = (code >= 97 && code <= 122) || (code >= 48 && code <= 57) || c === '.' || c === '_';
    if (ok) { chars.push(c); lastDash = false; }
    else if (!lastDash) { chars.push('-'); lastDash = true; }
  }
  let start = 0;
  let end = chars.length;
  while (start < end && (chars[start] === '-' || chars[start] === '.')) start++;
  while (end > start && (chars[end - 1] === '-' || chars[end - 1] === '.')) end--;
  let slug = chars.slice(start, end).join('');
  if (slug.length > 48) slug = slug.slice(0, 48);
  while (slug.length && (slug[slug.length - 1] === '-' || slug[slug.length - 1] === '.')) {
    slug = slug.slice(0, -1);
  }
  return slug || 'folder';
}

// Validate + normalise the admin-supplied list of context folders (#1290).
// Each input entry: { path, name?, slug?, readWrite? }. Returns
// { ok:true, mounts:[{ path, name, slug, readWrite? }] } — slugs unique &
// stable, `readWrite` present only when true — or { ok:false, error }. An empty
// array is valid and means "no folders" (clears the mounts). A prior `slug` is
// honoured (so a folder's target survives an edit); otherwise it is derived from
// the label (or the path's basename). Collisions are resolved by appending
// -2/-3/… so two folders never share a target — this covers the same-basename
// and same-path-twice edge cases.
function normalizeContextMountsInput(entries) {
  if (!Array.isArray(entries)) return { ok: false, error: 'mounts must be an array' };
  if (entries.length > MAX_CONTEXT_MOUNTS) {
    return { ok: false, error: `Too many context folders (max ${MAX_CONTEXT_MOUNTS})` };
  }
  const out = [];
  const usedSlugs = new Set();
  for (const e of entries) {
    if (!e || typeof e !== 'object') return { ok: false, error: 'Each context folder must be an object' };
    const v = validateHostMountPath(e.path);
    if (!v.ok) return { ok: false, error: v.error };
    const name = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : basenameOf(v.path);
    const base = slugifyMountName((typeof e.slug === 'string' && e.slug) ? e.slug : name);
    let slug = base;
    let n = 2;
    while (usedSlugs.has(slug)) { slug = `${base}-${n}`; n++; }
    usedSlugs.add(slug);
    const m = { path: v.path, name, slug };
    if (e.readWrite === true) m.readWrite = true;
    out.push(m);
  }
  return { ok: true, mounts: out };
}

// Resolve an agent config to the ordered list of context folders to mount, each
// with its in-container target (#1290). Handles BOTH the multi-folder field
// (`contextMounts`) and the legacy single-folder fields (`contextMount` +
// `contextMountRw`) for backward compatibility (AC7) — a legacy folder keeps the
// bare `/context` target it had before #1290, so an existing single-folder agent
// is unchanged. Returns [{ path, name, slug|null, target, readWrite }]; empty
// when the agent has no mount at all (so the zero-folder container spec + prompt
// stay byte-identical to today, AC9).
function resolveContextMounts(cfg) {
  if (!cfg || typeof cfg !== 'object') return [];
  if (Array.isArray(cfg.contextMounts) && cfg.contextMounts.length) {
    const out = [];
    const usedSlugs = new Set();
    for (const e of cfg.contextMounts) {
      if (!e || typeof e.path !== 'string') continue;
      const p = e.path.trim();
      if (!p) continue;
      const name = (typeof e.name === 'string' && e.name.trim()) ? e.name.trim() : basenameOf(p);
      const base = slugifyMountName((typeof e.slug === 'string' && e.slug) ? e.slug : name);
      // Defensive de-dup for a hand-edited config that lost unique slugs — the
      // PATCH path already guarantees uniqueness, this just keeps targets
      // distinct no matter what is on disk.
      let slug = base;
      let n = 2;
      while (usedSlugs.has(slug)) { slug = `${base}-${n}`; n++; }
      usedSlugs.add(slug);
      out.push({
        path: p,
        name,
        slug,
        target: `${CONTEXT_MOUNT_TARGET}/${slug}`,
        readWrite: e.readWrite === true,
      });
    }
    return out;
  }
  // Legacy single folder → bare /context (unchanged pre-#1290 behaviour).
  const legacy = typeof cfg.contextMount === 'string' ? cfg.contextMount.trim() : '';
  if (legacy) {
    return [{
      path: legacy,
      name: basenameOf(legacy),
      slug: null,
      target: CONTEXT_MOUNT_TARGET,
      readWrite: cfg.contextMountRw === true,
    }];
  }
  return [];
}

// Build the libpod `mounts[]` array for a resolved list of folders. An invalid
// path is SKIPPED (fail-closed) rather than aborting the whole set, so one bad
// folder never blocks the others (#1290). For a single legacy folder this
// returns exactly `[buildContextMountSpec(path, { readWrite })]` at `/context`,
// byte-identical to the pre-#1290 container spec.
function buildContextMountSpecs(mounts) {
  const specs = [];
  if (!Array.isArray(mounts)) return specs;
  for (const m of mounts) {
    if (!m) continue;
    const spec = buildContextMountSpec(m.path, {
      readWrite: m.readWrite === true,
      target: m.target || CONTEXT_MOUNT_TARGET,
    });
    if (spec) specs.push(spec);
  }
  return specs;
}

module.exports = {
  CONTEXT_MOUNT_TARGET,
  MAX_CONTEXT_MOUNTS,
  DENY_TREES,
  validateHostMountPath,
  buildContextMountSpec,
  buildContextMountSpecs,
  basenameOf,
  slugifyMountName,
  normalizeContextMountsInput,
  resolveContextMounts,
};
