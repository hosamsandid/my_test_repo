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
  'lifted', 'shared', 'moved', 'merged', 'extended', 'resynced', 'restored',
]);

// Version snapshots (#2839): every stamped content state is kept as a full
// snapshot under `<skill>/_versions/<contentHash>.json`. Snapshots are content-
// addressed, so a history entry that re-records unchanged content (forceHistory)
// shares the existing snapshot, and pruning keeps exactly the hashes still
// referenced by the bounded history (≤ HISTORY_LIMIT). The dir is excluded from
// the content hash like `_archive`, and never travels with a copy.
const SNAPSHOT_DIR = '_versions';
const SNAPSHOT_V = 1;

// Excluded from the content hash: the two sidecars (they describe the content,
// they are not content) and archived snapshots.
const EXCLUDED_BASENAMES = new Set([MANIFEST_FILENAME, 'provenance.json']);
const EXCLUDED_DIRS = new Set(['_archive', SNAPSHOT_DIR]);

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
//
// `opts.forceHistory` records a history entry (and refreshes updatedAt/updatedBy)
// even when the content hash is unchanged, WITHOUT bumping the version — for a
// provenance-only lifecycle event that re-homes existing content rather than
// editing it (e.g. an import round-trip of a byte-identical skill: the version
// chain continues, an `imported` entry is appended, nothing is reset). It has no
// effect when the hash already changed (that path always records + bumps).
//
// `opts.restoredFrom` (a version number) is recorded on the new entry of a
// `restored` stamp so the history shows which old version was brought back.
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
  const record = changed || o.forceHistory === true;

  const name = o.name != null ? o.name : (prev && prev.name != null ? prev.name : undefined);

  let origin;
  if (o.origin !== undefined) origin = o.origin;
  else if (prev && prev.origin !== undefined) origin = prev.origin;

  const history = (prev && Array.isArray(prev.history)) ? prev.history.slice() : [];
  if (record) {
    const entry = { version, hash: contentHash, at, by, action };
    if (o.note != null && o.note !== '') entry.note = o.note;
    if (Number.isInteger(o.restoredFrom)) entry.restoredFrom = o.restoredFrom;
    history.unshift(entry);
  }

  const manifest = { v: MANIFEST_V };
  if (name !== undefined) manifest.name = name;
  manifest.version = version;
  manifest.contentHash = contentHash;
  manifest.updatedAt = record ? at : (prev ? prev.updatedAt : at);
  manifest.updatedBy = record ? by : (prev ? prev.updatedBy : by);
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

// The closed set of drift states surfaced on a copy (#629). `unknown` is the
// pre-manifest copy — a team/seeded copy that has an origin tier but no recorded
// `sourceHash` to compare against (predates the skill.json manifest). It is
// surfaced so an operator can SEE it, but `isResyncable` refuses it: without a
// recorded source hash we can't prove the copy is unmodified, so overwriting it
// could silently destroy a local edit.
const DRIFT_STATES = Object.freeze([
  'in-sync', 'outdated', 'diverged', 'conflict', 'orphaned', 'unknown',
]);

// The surfacing wrapper the API/UI use for an actual COPY (the caller already
// knows it is a copy — team copy of a global skill, or a seeded replica of a
// pool skill). `classifyDrift` returns null only when no `sourceHash` was
// recorded; for a copy that means "predates the manifest" → `unknown`, never
// null. A genuinely hand-authored source is not a copy and never routed here.
function classifyCopyDrift(args) {
  return classifyDrift(args) || 'unknown';
}

// Only an `outdated` copy is safe to resync automatically (AC4): the source
// moved on while the copy was untouched, so re-copying loses nothing.
// `diverged`/`conflict` carry local edits (manual side-by-side review),
// `orphaned` has no source, `unknown` can't be proven unmodified, and `in-sync`
// needs no work. A resync endpoint MUST refuse every non-resyncable state.
function isResyncable(state) {
  return state === 'outdated';
}

/* ─── Version snapshots (pure) ────────────────────────────────────────────── */

const HASH_RE = new RegExp(`^[0-9a-f]{${HASH_LEN}}$`);

function isContentHash(h) {
  return typeof h === 'string' && HASH_RE.test(h);
}

// Serialize a file list into a snapshot document. The hash is recomputed from
// the files, so a snapshot always names exactly the content it holds.
function buildSnapshot(files) {
  const norm = normalizeFiles(files);
  return {
    v: SNAPSHOT_V,
    hash: computeContentHash(norm),
    files: norm.map(f => ({ path: f.path, b64: f.bytes.toString('base64') })),
  };
}

// Parse a snapshot document back into [{path, bytes}]. Returns null unless the
// document is well-formed AND its files hash to `expectedHash` (when given), so
// a corrupt or hand-edited snapshot is treated as "content not available".
function parseSnapshot(doc, expectedHash) {
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.files)) return null;
  const files = [];
  for (const f of doc.files) {
    if (!f || typeof f.path !== 'string' || typeof f.b64 !== 'string') return null;
    const rel = normalizeRelPath(f.path);
    if (!rel || rel.split('/').some(seg => seg === '..' || seg === '.') || isExcludedPath(rel)) return null;
    files.push({ path: rel, bytes: Buffer.from(f.b64, 'base64') });
  }
  const hash = computeContentHash(files);
  if (expectedHash != null && hash !== expectedHash) return null;
  return normalizeFiles(files);
}

// Which stored snapshot hashes to delete: everything not referenced by the
// manifest's (bounded) history and not the manifest's current content.
function planSnapshotPrune(existingHashes, manifest) {
  const keep = new Set();
  if (manifest && isContentHash(manifest.contentHash)) keep.add(manifest.contentHash);
  for (const h of (manifest && Array.isArray(manifest.history) ? manifest.history : [])) {
    if (h && isContentHash(h.hash)) keep.add(h.hash);
  }
  return (Array.isArray(existingHashes) ? existingHashes : []).filter(h => !keep.has(h)).sort();
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

// Hashes of the snapshots stored in a skill directory (sorted).
function listSnapshotHashes(dir, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  let names;
  try { names = fsImpl.readdirSync(pathImpl.join(dir, SNAPSHOT_DIR)); } catch { return []; }
  return names
    .filter(n => n.endsWith('.json') && isContentHash(n.slice(0, -5)))
    .map(n => n.slice(0, -5))
    .sort();
}

// Write the snapshot of `files` unless one for its hash already exists
// (content-addressed → dedup). Returns the snapshot hash.
function writeSnapshot(dir, files, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  const snap = buildSnapshot(files);
  const sdir = pathImpl.join(dir, SNAPSHOT_DIR);
  const file = pathImpl.join(sdir, `${snap.hash}.json`);
  if (fsImpl.existsSync(file)) return snap.hash;
  fsImpl.mkdirSync(sdir, { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fsImpl.writeFileSync(tmp, JSON.stringify(snap));
  fsImpl.renameSync(tmp, file);
  return snap.hash;
}

// Read a stored snapshot as [{path, bytes}], or null when absent/corrupt.
function readSnapshot(dir, hash, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  if (!isContentHash(hash)) return null;
  try {
    const raw = fsImpl.readFileSync(pathImpl.join(dir, SNAPSHOT_DIR, `${hash}.json`), 'utf8');
    return parseSnapshot(JSON.parse(raw), hash);
  } catch { return null; }
}

// Delete the snapshots no longer referenced by `manifest`. Returns the removed hashes.
function pruneSnapshots(dir, manifest, io = {}) {
  const fsImpl = io.fs || fs;
  const pathImpl = io.path || path;
  const drop = planSnapshotPrune(listSnapshotHashes(dir, io), manifest);
  for (const h of drop) {
    try { fsImpl.unlinkSync(pathImpl.join(dir, SNAPSHOT_DIR, `${h}.json`)); } catch { /* best-effort */ }
  }
  return drop;
}

// Ensure the snapshot of the directory's current content exists and prune the
// unreferenced ones — for copy paths that carry a manifest over without
// re-stamping (seed/sync of an agent copy). Best-effort: never throws.
function snapshotSkillDir(dir, opts = {}) {
  const io = { fs: opts.fs || fs, path: opts.path || path };
  try {
    writeSnapshot(dir, readSkillDirFiles(dir, io), io);
    const manifest = readManifest(dir, io);
    if (manifest) pruneSnapshots(dir, manifest, io);
  } catch { /* snapshots are best-effort; the copy itself already succeeded */ }
}

// cpSync filter that keeps a skill's version snapshots from travelling with a
// copy (transfer/adopt/move/install/seed/archive) — snapshots belong to ONE copy.
function snapshotCopyFilter(src) {
  return path.basename(String(src)) !== SNAPSHOT_DIR;
}

// The convenience used by every write path: hash the dir's current content,
// read the existing manifest, stamp the next one, write it back, return it.
// `name` defaults to the directory basename. Best-effort at the call site: the
// caller wraps this in try/catch so stamping never breaks the primary write.
// It also keeps the version snapshot of the stamped content (#2839) and prunes
// snapshots that fell out of the bounded history; a snapshot failure never
// fails the stamp (the entry just shows "content not available").
function stampSkillDir(dir, opts = {}) {
  const io = { fs: opts.fs || fs, path: opts.path || path };
  const files = readSkillDirFiles(dir, io);
  const contentHash = computeContentHash(files);
  const existing = readManifest(dir, io);
  const name = opts.name != null ? opts.name : io.path.basename(dir);
  const manifest = stampManifest(existing, {
    contentHash, name,
    now: opts.now, by: opts.by, action: opts.action, origin: opts.origin, note: opts.note,
    forceHistory: opts.forceHistory, restoredFrom: opts.restoredFrom,
  });
  try { writeSnapshot(dir, files, io); } catch { /* best-effort */ }
  writeManifest(dir, manifest, io);
  try { pruneSnapshots(dir, manifest, io); } catch { /* best-effort */ }
  return manifest;
}

module.exports = {
  MANIFEST_FILENAME, MANIFEST_V, HISTORY_LIMIT, HASH_LEN, ACTIONS, DRIFT_STATES,
  SNAPSHOT_DIR, SNAPSHOT_V,
  normalizeRelPath, isExcludedPath, normalizeFiles, computeContentHash,
  stampManifest, classifyDrift, classifyCopyDrift, isResyncable,
  isContentHash, buildSnapshot, parseSnapshot, planSnapshotPrune,
  readSkillDirFiles, hashSkillDir, readManifest, writeManifest, stampSkillDir,
  listSnapshotHashes, writeSnapshot, readSnapshot, pruneSnapshots, snapshotSkillDir,
  snapshotCopyFilter,
};
