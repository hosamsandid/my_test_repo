'use strict';

// Skill identity — the per-skill content manifest (`skill.json`).
//
// Concept: docs/skill-lifecycle-concept.md §2 (epic #624, phase 1 = #625).
//
// Every skill directory gains a sidecar `skill.json` next to the existing
// `provenance.json`. `provenance.json` carries *knowledge* lineage (entryIds,
// origin agents); `skill.json` carries *content* lineage: a monotonic version
// counter, a content hash, who/when/why of every change (bounded history), and
// where THIS copy came from (`origin`).
//
// This module is the ONE pure core (hashing, stamping, history append, drift
// classification). It lives here in the admin-console API (the pool writer) and
// is mirrored BYTE-IDENTICAL in orchestrator/skill-manifest.js (curator writes,
// seed reads) — the same two-sided golden-fixture discipline as
// knowledge-digest.js. Both sides assert the shared fixture
// orchestrator/skill-manifest.fixture.json, and a guard test asserts the two
// files are identical, so they can never drift.
//
// Only Node builtins (crypto/fs/path) are used, so the module is unit-testable
// without any install step. The pure functions accept plain data; the thin IO
// wrappers at the bottom take an injectable fs/path for testing.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const MANIFEST_FILENAME = 'skill.json';
const MANIFEST_V = 1;
const HISTORY_LIMIT = 20;
const HASH_LEN = 12; // 12-hex prefix of the SHA-256

// The closed set of history actions (concept §2.2).
const ACTIONS = Object.freeze([
  'created', 'edited', 'imported', 'adopted', 'promoted',
  'lifted', 'shared', 'moved', 'merged', 'extended', 'resynced',
]);

// Excluded from the content hash: the two sidecars (they describe the content,
// they are not content) and archived snapshots.
const EXCLUDED_BASENAMES = new Set([MANIFEST_FILENAME, 'provenance.json']);
const EXCLUDED_DIRS = new Set(['_archive']);

// Normalize a relative path to forward slashes with no leading slash so the
// hash is stable across platforms.
function normalizeRelPath(p) {
  return String(p == null ? '' : p).split(/[\\/]+/).filter(Boolean).join('/');
}

// A path is excluded from the hash when any segment is an excluded dir or its
// basename is an excluded sidecar.
function isExcludedPath(relPath) {
  const parts = normalizeRelPath(relPath).split('/');
  if (parts.length === 0) return true;
  if (parts.some(seg => EXCLUDED_DIRS.has(seg))) return true;
  return EXCLUDED_BASENAMES.has(parts[parts.length - 1]);
}

// Normalize a file list ([{path, bytes}]) for hashing: drop excluded paths,
// coerce bytes to Buffers, sort by relative path (byte order).
function normalizeFiles(files) {
  return (Array.isArray(files) ? files : [])
    .map(f => ({
      path: normalizeRelPath(f && f.path),
      bytes: Buffer.isBuffer(f && f.bytes) ? f.bytes : Buffer.from(String(f && f.bytes != null ? f.bytes : ''), 'utf8'),
    }))
    .filter(f => f.path && !isExcludedPath(f.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

// Content hash: SHA-256 (12-hex prefix) over the normalized directory content —
// sorted relative paths + raw bytes of every file, framed so neither a path nor
// a byte run can be confused with another (path \0 bytelen \0 bytes \0).
function computeContentHash(files) {
  const norm = normalizeFiles(files);
  const h = crypto.createHash('sha256');
  for (const f of norm) {
    h.update(f.path, 'utf8');
    h.update('\0');
    h.update(String(f.bytes.length), 'utf8');
    h.update('\0');
    h.update(f.bytes);
    h.update('\0');
  }
  return h.digest('hex').slice(0, HASH_LEN);
}

// Stamp a manifest: given the existing manifest (or null) and the freshly
// computed contentHash, return the next manifest. The version increments ONLY
// when the hash changed; an unchanged stamp is a no-op on version/history/
// updatedAt/updatedBy (so re-running a write path or the backfill is idempotent).
// History is newest-first and bounded to HISTORY_LIMIT. `origin` is preserved
// from the previous manifest unless a new one is explicitly supplied.
function stampManifest(existing, opts) {
  const o = opts || {};
  const contentHash = o.contentHash;
  const at = o.now || new Date().toISOString();
  const by = o.by || 'unknown';
  const action = o.action || 'edited';
  const prev = (existing && typeof existing === 'object') ? existing : null;

  const prevVersion = prev && Number.isInteger(prev.version) ? prev.version : 0;
  const changed = !prev || prev.contentHash !== contentHash;
  const version = changed ? prevVersion + 1 : prevVersion;

  const name = o.name != null ? o.name : (prev && prev.name != null ? prev.name : undefined);

  let origin;
  if (o.origin !== undefined) origin = o.origin;
  else if (prev && prev.origin !== undefined) origin = prev.origin;

  const history = (prev && Array.isArray(prev.history)) ? prev.history.slice() : [];
  if (changed) {
    const entry = { version, hash: contentHash, at, by, action };
    if (o.note != null && o.note !== '') entry.note = o.note;
    history.unshift(entry);
  }

  const manifest = { v: MANIFEST_V };
  if (name !== undefined) manifest.name = name;
  manifest.version = version;
  manifest.contentHash = contentHash;
  manifest.updatedAt = changed ? at : (prev ? prev.updatedAt : at);
  manifest.updatedBy = changed ? by : (prev ? prev.updatedBy : by);
  if (origin !== undefined) manifest.origin = origin;
  manifest.history = history.slice(0, HISTORY_LIMIT);
  return manifest;
}

// Drift classification (concept §2.4) — a pure function of three hashes:
//   copyHash          the copy's current content hash
//   sourceHash        the hash recorded in the copy's origin at copy time
//   sourceCurrentHash the source skill's current content hash (null = deleted)
// Returns one of in-sync|outdated|diverged|conflict|orphaned, or null when the
// copy records no source hash (hand-authored — nothing to compare against).
function classifyDrift({ copyHash, sourceHash, sourceCurrentHash } = {}) {
  if (!sourceHash) return null;
  if (sourceCurrentHash == null) return 'orphaned';
  const copyChanged = copyHash !== sourceHash;
  const sourceChanged = sourceCurrentHash !== sourceHash;
  if (!copyChanged && !sourceChanged) return 'in-sync';
  if (!copyChanged && sourceChanged) return 'outdated';
  if (copyChanged && !sourceChanged) return 'diverged';
  return 'conflict';
}

/* ─── Thin IO wrappers (fs/path injectable for tests) ────────────────────── */

// Read every hashable file of a skill directory as {path (posix-relative), bytes}.
// Excluded sidecars/dirs are skipped; symlinked dirs are not descended.
function readSkillDirFiles(dir, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  const out = [];
  const walk = (cur) => {
    let entries;
    try { entries = fsImpl.readdirSync(cur, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = pathImpl.join(cur, e.name);
      if (e.isDirectory()) {
        if (EXCLUDED_DIRS.has(e.name)) continue;
        walk(full);
        continue;
      }
      if (!e.isFile()) continue; // skip symlinks, sockets, etc.
      const rel = pathImpl.relative(dir, full);
      if (isExcludedPath(rel)) continue;
      let bytes;
      try { bytes = fsImpl.readFileSync(full); } catch { continue; }
      out.push({ path: rel, bytes });
    }
  };
  walk(dir);
  return out;
}

// Content hash of a skill directory on disk.
function hashSkillDir(dir, io = {}) {
  return computeContentHash(readSkillDirFiles(dir, io));
}

// Read a skill directory's manifest, or null when absent/unparseable.
function readManifest(dir, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  try {
    const raw = fsImpl.readFileSync(pathImpl.join(dir, MANIFEST_FILENAME), 'utf8');
    const obj = JSON.parse(raw);
    return (obj && typeof obj === 'object') ? obj : null;
  } catch { return null; }
}

// Write a manifest to a skill directory (pretty JSON, trailing newline).
function writeManifest(dir, manifest, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  fsImpl.mkdirSync(dir, { recursive: true });
  fsImpl.writeFileSync(pathImpl.join(dir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2) + '\n');
  return manifest;
}

// The convenience used by every write path: hash the dir's current content,
// read the existing manifest, stamp the next one, write it back, return it.
// `name` defaults to the directory basename. Best-effort at the call site: the
// caller wraps this in try/catch so stamping never breaks the primary write.
function stampSkillDir(dir, opts = {}) {
  const io = { fs: opts.fs || fs, path: opts.path || path };
  const contentHash = hashSkillDir(dir, io);
  const existing = readManifest(dir, io);
  const name = opts.name != null ? opts.name : io.path.basename(dir);
  const manifest = stampManifest(existing, {
    contentHash, name,
    now: opts.now, by: opts.by, action: opts.action, origin: opts.origin, note: opts.note,
  });
  writeManifest(dir, manifest, io);
  return manifest;
}

module.exports = {
  MANIFEST_FILENAME, MANIFEST_V, HISTORY_LIMIT, HASH_LEN, ACTIONS,
  normalizeRelPath, isExcludedPath, normalizeFiles, computeContentHash,
  stampManifest, classifyDrift,
  readSkillDirFiles, hashSkillDir, readManifest, writeManifest, stampSkillDir,
};
