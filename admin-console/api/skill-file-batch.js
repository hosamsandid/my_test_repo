'use strict';

// Atomic multi-file save for the full-screen skill editor (#2837).
//
// The editor keeps every change (content edits, new files/folders, renames,
// deletes, uploads) as pending state and sends them in ONE request. This module
// is the pure core behind `POST /api/skills/:name/files/batch`:
//
//   planBatch(input, listing)  validates the request against the skill's current
//                              listing and returns a normalized plan, or a
//                              refusal { ok:false, status, error, file? }.
//   applyBatch(dir, plan)      applies a validated plan to a directory (the
//                              route runs it on a STAGING copy, then swaps the
//                              staging dir in, so a failure writes nothing).
//
// Apply order (and therefore the meaning of each op):
//   1. moves   — every `from` (an original path, file or folder) is lifted into
//                a holding area first, so swaps and chains need no ordering;
//   2. deletes — original paths (file or folder, recursive);
//   3. moves   — held entries are placed at their `to` paths;
//   4. writes  — full-content writes (utf8 `content` or `contentBase64`);
//   5. mkdirs  — folders that must exist even when empty (persisted, AC22).
//
// Paths are POSIX-relative to the skill root. The platform sidecars
// (skill.json manifest, provenance.json) and `_archive/` are never addressable
// (AC21) — the same rule skill-manifest.js uses to exclude them from the hash.

const fs = require('fs');
const path = require('path');
const skillManifest = require('./skill-manifest');

const MAX_FILE_BYTES = 2 * 1024 * 1024;   // per written/uploaded file
const MAX_BATCH_BYTES = 7 * 1024 * 1024;  // all writes of one save (JSON body cap is 10 MB)
const MAX_OPS = 2000;
const MAX_PATH_LEN = 1024;
const MAX_SEGMENT_LEN = 255;
const ROOT_SKILL_MD = 'SKILL.md';
const HOLD_DIR = '.aee-batch-hold';

// Normalize a client-supplied relative path. Returns the POSIX path or null when
// it is empty, absolute, contains `.`/`..` segments, backslashes, control
// characters, or exceeds the length caps.
function normalizeRelPath(p) {
  if (typeof p !== 'string') return null;
  if (!p || p.length > MAX_PATH_LEN) return null;
  if (/[\u0000-\u001f\\]/.test(p)) return null;
  if (p.startsWith('/') || /^[a-zA-Z]:/.test(p)) return null;
  const segs = p.split('/');
  if (segs.some(s => s === '' || s === '.' || s === '..' || s.length > MAX_SEGMENT_LEN)) return null;
  return segs.join('/');
}

// Sidecars and archived snapshots are platform-managed — not shown, not editable.
function isProtectedPath(p) {
  return skillManifest.isExcludedPath(p) || p.split('/')[0] === HOLD_DIR;
}

function isUnder(p, dir) { return p === dir || p.startsWith(dir + '/'); }

function decodeWrite(w) {
  if (typeof w.content === 'string') return Buffer.from(w.content, 'utf8');
  if (typeof w.contentBase64 === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(w.contentBase64)) {
    return Buffer.from(w.contentBase64, 'base64');
  }
  return null;
}

/**
 * Validate a batch against the skill's current listing.
 *   input:   { deletes?: string[], moves?: {from,to}[], writes?: {path, content|contentBase64}[], mkdirs?: string[] }
 *   listing: { files: string[], dirs: string[] } — current relative paths
 * Returns { ok:true, plan:{deletes, moves, writes:[{path, bytes}], mkdirs} } or
 * { ok:false, status, error, file? }.
 */
function planBatch(input, listing) {
  const refuse = (error, file, status = 400) => ({ ok: false, status, error, ...(file ? { file } : {}) });
  const body = input && typeof input === 'object' ? input : {};
  const arr = (k) => (body[k] == null ? [] : body[k]);
  for (const k of ['deletes', 'moves', 'writes', 'mkdirs']) {
    if (!Array.isArray(arr(k))) return refuse(`${k} must be an array`);
  }
  const total = arr('deletes').length + arr('moves').length + arr('writes').length + arr('mkdirs').length;
  if (total === 0) return refuse('nothing to save');
  if (total > MAX_OPS) return refuse(`too many changes in one save (max ${MAX_OPS})`);

  const files = new Set(listing.files);
  const dirs = new Set(listing.dirs);
  const exists = (p) => files.has(p) || dirs.has(p);
  const checkPath = (raw, what) => {
    const p = normalizeRelPath(raw);
    if (!p) return { err: refuse(`invalid ${what} path: ${JSON.stringify(String(raw)).slice(0, 120)}`) };
    if (isProtectedPath(p)) return { err: refuse(`${p} is managed by the platform and cannot be changed`, p) };
    return { p };
  };

  // deletes
  const deletes = [];
  for (const raw of arr('deletes')) {
    const { p, err } = checkPath(raw, 'delete');
    if (err) return err;
    if (p === ROOT_SKILL_MD) return refuse('SKILL.md cannot be deleted', p);
    if (!exists(p)) return refuse(`cannot delete ${p}: it does not exist`, p, 409);
    deletes.push(p);
  }

  // moves
  const moves = [];
  const fromSeen = new Set();
  for (const m of arr('moves')) {
    if (!m || typeof m !== 'object') return refuse('each move needs from and to');
    const a = checkPath(m.from, 'move source'); if (a.err) return a.err;
    const b = checkPath(m.to, 'move target'); if (b.err) return b.err;
    if (a.p === ROOT_SKILL_MD) return refuse('SKILL.md cannot be renamed or moved', a.p);
    if (!exists(a.p)) return refuse(`cannot move ${a.p}: it does not exist`, a.p, 409);
    if (a.p === b.p) return refuse(`cannot move ${a.p} onto itself`, a.p);
    if (isUnder(b.p, a.p)) return refuse(`cannot move ${a.p} into itself`, a.p);
    if (fromSeen.has(a.p)) return refuse(`${a.p} is moved twice`, a.p);
    // Sources are lifted before deletes run, so moving a file out of a folder
    // that is then deleted is fine — but deleting the source itself (or part of
    // a moved folder) would silently not happen.
    if (deletes.some(d => isUnder(d, a.p))) return refuse(`${a.p} is both moved and deleted`, a.p);
    fromSeen.add(a.p);
    moves.push({ from: a.p, to: b.p, isDir: dirs.has(a.p) });
  }
  // A moved folder must not also have members moved on their own — the client
  // compiles folder moves to per-file moves, so this never happens legitimately.
  for (const m of moves) {
    if (moves.some(o => o !== m && isUnder(o.from, m.from))) return refuse(`${m.from} overlaps another move`, m.from);
  }

  // writes
  const writes = [];
  let batchBytes = 0;
  for (const w of arr('writes')) {
    if (!w || typeof w !== 'object') return refuse('each write needs a path and content');
    const { p, err } = checkPath(w.path, 'write');
    if (err) return err;
    const bytes = decodeWrite(w);
    if (!bytes) return refuse(`${p}: content must be a string or valid base64`, p);
    if (bytes.length > MAX_FILE_BYTES) return refuse(`${p} is larger than the ${MAX_FILE_BYTES / (1024 * 1024)} MB per-file limit`, p, 413);
    batchBytes += bytes.length;
    if (batchBytes > MAX_BATCH_BYTES) return refuse(`this save exceeds the ${MAX_BATCH_BYTES / (1024 * 1024)} MB limit — save in smaller steps`, p, 413);
    writes.push({ path: p, bytes });
  }

  const mkdirs = [];
  for (const raw of arr('mkdirs')) {
    const { p, err } = checkPath(raw, 'folder');
    if (err) return err;
    mkdirs.push(p);
  }

  // Simulate the final state so collisions are refused up front (AC18) and the
  // final tree is well-formed (no file/folder clash, SKILL.md still present).
  const finalFiles = new Map(); // path → origin marker
  const finalDirs = new Set();
  const removed = (p) => moves.some(m => isUnder(p, m.from)) || deletes.some(d => isUnder(p, d));
  for (const f of files) if (!removed(f)) finalFiles.set(f, 'kept');
  for (const d of dirs) if (!removed(d)) finalDirs.add(d);
  for (const m of moves) {
    const relocate = (p) => m.to + p.slice(m.from.length);
    const placed = m.isDir
      ? [...files].filter(f => isUnder(f, m.from)).map(relocate)
      : [m.to];
    if (m.isDir) {
      finalDirs.add(m.to);
      for (const d of dirs) if (isUnder(d, m.from)) finalDirs.add(relocate(d));
    }
    for (const t of placed) {
      if (finalFiles.has(t)) return refuse(`cannot move ${m.from} to ${m.to}: ${t} already exists`, m.from, 409);
      finalFiles.set(t, 'moved');
    }
  }
  const writePaths = new Set();
  for (const w of writes) {
    if (writePaths.has(w.path)) return refuse(`${w.path} is written twice`, w.path);
    writePaths.add(w.path);
    finalFiles.set(w.path, 'written');
  }
  for (const d of mkdirs) finalDirs.add(d);
  for (const f of finalFiles.keys()) {
    const segs = f.split('/');
    for (let i = 1; i < segs.length; i++) finalDirs.add(segs.slice(0, i).join('/'));
  }
  for (const f of finalFiles.keys()) {
    if (finalDirs.has(f)) return refuse(`${f} cannot be both a file and a folder`, f, 409);
  }
  if (!finalFiles.has(ROOT_SKILL_MD)) return refuse('SKILL.md must stay at the skill root', ROOT_SKILL_MD);

  return { ok: true, plan: { deletes, moves, writes, mkdirs } };
}

// Resolve `rel` inside `root` for writing: the path must stay inside the root
// even after following any symlinked parent that already exists.
function resolveInside(root, rel, fsImpl = fs) {
  const realRoot = fsImpl.realpathSync(root);
  const target = path.resolve(realRoot, ...rel.split('/'));
  let probe = target;
  while (!fsImpl.existsSync(probe) && probe !== realRoot) probe = path.dirname(probe);
  const realProbe = fsImpl.realpathSync(probe);
  const relProbe = path.relative(realRoot, realProbe);
  if (relProbe.startsWith('..') || path.isAbsolute(relProbe)) throw new Error(`path escapes the skill directory: ${rel}`);
  const relTarget = path.relative(realRoot, target);
  if (relTarget.startsWith('..') || path.isAbsolute(relTarget)) throw new Error(`path escapes the skill directory: ${rel}`);
  return target;
}

// Apply a validated plan to `dir` (the staging copy). Throws on any failure —
// the caller discards the staging dir, so nothing reaches the live skill.
function applyBatch(dir, plan, fsImpl = fs) {
  const hold = path.join(dir, HOLD_DIR);
  fsImpl.mkdirSync(hold, { recursive: true });
  plan.moves.forEach((m, i) => {
    fsImpl.renameSync(resolveInside(dir, m.from, fsImpl), path.join(hold, String(i)));
  });
  for (const d of plan.deletes) {
    const abs = resolveInside(dir, d, fsImpl);
    fsImpl.rmSync(abs, { recursive: true, force: true });
  }
  plan.moves.forEach((m, i) => {
    const abs = resolveInside(dir, m.to, fsImpl);
    fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
    if (fsImpl.existsSync(abs)) throw new Error(`move target already exists: ${m.to}`);
    fsImpl.renameSync(path.join(hold, String(i)), abs);
  });
  for (const w of plan.writes) {
    const abs = resolveInside(dir, w.path, fsImpl);
    fsImpl.mkdirSync(path.dirname(abs), { recursive: true });
    if (fsImpl.existsSync(abs) && fsImpl.lstatSync(abs).isSymbolicLink()) fsImpl.unlinkSync(abs);
    fsImpl.writeFileSync(abs, w.bytes);
  }
  for (const d of plan.mkdirs) fsImpl.mkdirSync(resolveInside(dir, d, fsImpl), { recursive: true });
  fsImpl.rmSync(hold, { recursive: true, force: true });
}

// Every directory below a skill root (relative POSIX paths), protected ones
// excluded — the editor shows persisted empty folders from this list (AC22).
function listSkillDirs(rootDir, fsImpl = fs) {
  const out = [];
  const walk = (abs, rel) => {
    if (out.length > 2000) return;
    let entries;
    try { entries = fsImpl.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (isProtectedPath(r)) continue;
      out.push(r);
      walk(path.join(abs, e.name), r);
    }
  };
  walk(rootDir, '');
  return out.sort();
}

module.exports = {
  MAX_FILE_BYTES, MAX_BATCH_BYTES, MAX_OPS, HOLD_DIR,
  normalizeRelPath, isProtectedPath, planBatch, applyBatch, listSkillDirs,
};
