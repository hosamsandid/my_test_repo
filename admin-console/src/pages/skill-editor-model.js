// Pure model behind the full-screen skill editor (#2837). No React, no fetch —
// unit-tested in skill-editor-model.test.js; SkillEditorModal.jsx renders it.
//
// The editor keeps every change as PENDING state until Save (AC10). The state
// is a working copy of the skill's tree:
//
//   baseFiles  { path → size }   what the server listed when the editor loaded
//   baseDirs   [path]            folders the server listed (incl. empty ones)
//   files      { path → entry }  the working tree; entry =
//                {origin, size, content?, base64?}
//              origin  — the base path the entry came from (null = new file);
//                        a rename keeps the origin, so edits travel with it
//              content — edited text (undefined = unchanged from origin)
//              base64  — uploaded bytes (undefined = not uploaded)
//   dirs       { path → true }   folders that exist explicitly (base folders and
//                                 created ones); ancestors of files are implied
//
// compileChanges() turns the working copy into the server's batch shape
// ({deletes, moves, writes, mkdirs}, see admin-console/api/skill-file-batch.js);
// listChanges() is the same diff as a user-facing list (count + tree marks).
//
// Empty folders are persisted (AC22): a folder stays until it is deleted, and
// a folder that is still empty at Save time is created on disk.

import { canWriteGlobalSkills } from './skill-target-view.js';

export const SKILL_MD = 'SKILL.md';
export const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;   // mirrors MAX_FILE_BYTES in skill-file-batch.js
export const MAX_SAVE_BYTES = 7 * 1024 * 1024;     // mirrors MAX_BATCH_BYTES
export const READ_CAP_BYTES = 512 * 1024;          // mirrors SKILL_FILE_MAX_BYTES in api.js

const PROTECTED_BASENAMES = new Set(['skill.json', 'provenance.json']);
const PROTECTED_DIRS = new Set(['_archive', '_versions', '.aee-batch-hold']);

// Platform-managed files (manifest, provenance sidecar, archived snapshots) are
// neither shown nor editable (AC21) — same rule as skill-manifest.isExcludedPath.
export function isProtectedPath(p) {
  const parts = String(p || '').split('/').filter(Boolean);
  if (parts.length === 0) return true;
  if (parts.some(s => PROTECTED_DIRS.has(s))) return true;
  return PROTECTED_BASENAMES.has(parts[parts.length - 1]);
}

export function isMarkdownPath(p) { return /\.(md|markdown)$/i.test(p || ''); }
export function baseName(p) { const s = String(p || ''); return s.slice(s.lastIndexOf('/') + 1); }
export function parentDir(p) { const s = String(p || ''); const i = s.lastIndexOf('/'); return i < 0 ? '' : s.slice(0, i); }
export function joinPath(dir, name) { return dir ? `${dir}/${name}` : name; }
export function isUnder(p, dir) { return p === dir || p.startsWith(dir + '/'); }

// Validate a single name segment (new file / new folder / upload) — AC17.
export function validateName(name) {
  const n = typeof name === 'string' ? name : '';
  if (!n.trim()) return 'Name cannot be empty';
  if (n !== n.trim()) return 'Name cannot start or end with spaces';
  if (n === '.' || n === '..') return 'Name cannot be "." or ".."';
  if (/[/\\]/.test(n)) return 'Name cannot contain / or \\';
  if (/[\u0000-\u001f]/.test(n)) return 'Name cannot contain control characters';
  if (n.length > 255) return 'Name is too long (max 255 characters)';
  if (isProtectedPath(n)) return `"${n}" is managed by the platform`;
  return null;
}

// Validate a relative path (rename / move target): every segment must be a
// valid name; no absolute paths, no traversal — AC17/AC18.
export function validatePath(p) {
  const s = typeof p === 'string' ? p : '';
  if (!s.trim()) return 'Path cannot be empty';
  if (s.startsWith('/')) return 'Path must be relative to the skill folder';
  if (s.length > 1024) return 'Path is too long';
  for (const seg of s.split('/')) {
    const err = validateName(seg);
    if (err) return seg === '' ? 'Path cannot contain empty segments' : err;
  }
  return null;
}

/* ─── state ──────────────────────────────────────────────────────────── */

export function createModel({ files = [], dirs = [] } = {}) {
  const baseFiles = {};
  const working = {};
  for (const f of files) {
    if (!f || typeof f.path !== 'string' || isProtectedPath(f.path)) continue;
    baseFiles[f.path] = f.size || 0;
    working[f.path] = { origin: f.path, size: f.size || 0 };
  }
  const baseDirs = dirs.filter(d => typeof d === 'string' && !isProtectedPath(d));
  const explicit = {};
  for (const d of baseDirs) explicit[d] = true;
  return { baseFiles, baseDirs, files: working, dirs: explicit };
}

// Explicit folders plus every ancestor of a working file.
export function workingDirs(state) {
  const out = new Set(Object.keys(state.dirs));
  for (const p of Object.keys(state.files)) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) out.add(segs.slice(0, i).join('/'));
  }
  return out;
}

export function isDir(state, p) { return workingDirs(state).has(p); }
export function pathExists(state, p) { return !!state.files[p] || isDir(state, p); }
export function isEdited(entry) { return !!entry && (entry.content !== undefined || entry.base64 !== undefined); }

const ok = (state, extra = {}) => ({ state, error: null, ...extra });
const fail = (state, error) => ({ state, error });

// Set a file's text. `baseContent` is the origin's loaded content: typing a
// file back to it clears the edit, so it no longer counts as a change.
export function editFile(state, path, content, baseContent) {
  const entry = state.files[path];
  if (!entry) return fail(state, `${path} does not exist`);
  const next = { ...entry, content, size: utf8Length(content) };
  delete next.base64;
  if (entry.origin && baseContent !== undefined && content === baseContent) {
    delete next.content;
    next.size = state.baseFiles[entry.origin] ?? next.size;
  }
  return ok({ ...state, files: { ...state.files, [path]: next } });
}

export function createFile(state, dir, name) {
  const err = validateName(name);
  if (err) return fail(state, err);
  const path = joinPath(dir, name);
  if (pathExists(state, path)) return fail(state, `"${name}" already exists in this folder`);
  return ok({ ...state, files: { ...state.files, [path]: { origin: null, size: 0, content: '' } } }, { path });
}

export function createFolder(state, dir, name) {
  const err = validateName(name);
  if (err) return fail(state, err);
  const path = joinPath(dir, name);
  if (pathExists(state, path)) return fail(state, `"${name}" already exists in this folder`);
  return ok({ ...state, dirs: { ...state.dirs, [path]: true } }, { path });
}

// Rename or move a file or a folder (with its contents) — AC18. SKILL.md at
// the root is pinned (AC21).
export function renamePath(state, from, to) {
  if (from === SKILL_MD) return fail(state, 'SKILL.md at the skill root cannot be renamed or moved');
  const err = validatePath(to);
  if (err) return fail(state, err);
  if (from === to) return ok(state, { path: to });
  if (state.files[from]) {
    if (pathExists(state, to)) return fail(state, `${to} already exists`);
    const files = { ...state.files };
    files[to] = files[from];
    delete files[from];
    return ok({ ...state, files }, { path: to });
  }
  if (!isDir(state, from)) return fail(state, `${from} does not exist`);
  if (isUnder(to, from)) return fail(state, 'A folder cannot be moved into itself');
  if (pathExists(state, to)) return fail(state, `${to} already exists`);
  const relocate = (p) => to + p.slice(from.length);
  const files = {};
  for (const [p, e] of Object.entries(state.files)) files[isUnder(p, from) ? relocate(p) : p] = e;
  const dirs = {};
  for (const d of Object.keys(state.dirs)) dirs[isUnder(d, from) ? relocate(d) : d] = true;
  dirs[to] = true;
  return ok({ ...state, files, dirs }, { path: to });
}

// Delete a file or a folder with its contents — AC19 (confirmation is the UI's).
export function deletePath(state, p) {
  if (p === SKILL_MD) return fail(state, 'SKILL.md at the skill root cannot be deleted');
  if (state.files[p]) {
    const files = { ...state.files };
    delete files[p];
    return ok({ ...state, files });
  }
  if (!isDir(state, p)) return fail(state, `${p} does not exist`);
  const files = {};
  for (const [k, e] of Object.entries(state.files)) if (!isUnder(k, p)) files[k] = e;
  const dirs = {};
  for (const d of Object.keys(state.dirs)) if (!isUnder(d, p)) dirs[d] = true;
  return ok({ ...state, files, dirs });
}

// Add (or replace) a file from an upload — AC20. The caller asks before
// overwriting (uploadConflicts); a replaced file keeps its origin.
export function uploadFile(state, dir, name, { base64, size }) {
  const err = validateName(name);
  if (err) return fail(state, `${name}: ${err}`);
  if (size > MAX_UPLOAD_BYTES) return fail(state, `${name} is larger than the ${MAX_UPLOAD_BYTES / (1024 * 1024)} MB upload limit`);
  const path = joinPath(dir, name);
  if (isDir(state, path)) return fail(state, `${name}: a folder with this name exists`);
  const prev = state.files[path];
  const entry = { origin: prev ? prev.origin : null, size, base64 };
  return ok({ ...state, files: { ...state.files, [path]: entry } }, { path });
}

export function uploadConflicts(state, dir, names) {
  return names.filter(n => !!state.files[joinPath(dir, n)]);
}

/* ─── diff ───────────────────────────────────────────────────────────── */

// The server batch: {deletes, moves, writes, mkdirs}.
export function compileChanges(state) {
  const entries = Object.entries(state.files);
  const usedOrigins = new Set(entries.map(([, e]) => e.origin).filter(Boolean));
  const wdirs = workingDirs(state);

  const goneDirs = state.baseDirs.filter(d => !wdirs.has(d));
  const topGoneDirs = goneDirs.filter(d => !goneDirs.some(o => o !== d && isUnder(d, o)));
  const deletes = [...topGoneDirs];
  for (const p of Object.keys(state.baseFiles)) {
    if (usedOrigins.has(p)) continue;
    if (topGoneDirs.some(d => isUnder(p, d))) continue;
    deletes.push(p);
  }

  const moves = [];
  const writes = [];
  for (const [p, e] of entries) {
    if (e.origin && e.origin !== p) moves.push({ from: e.origin, to: p });
    if (e.content !== undefined) writes.push({ path: p, content: e.content });
    else if (e.base64 !== undefined) writes.push({ path: p, contentBase64: e.base64 });
  }

  const baseDirSet = new Set(state.baseDirs);
  const filePaths = Object.keys(state.files);
  const mkdirs = Object.keys(state.dirs)
    .filter(d => !baseDirSet.has(d))
    .filter(d => !filePaths.some(f => isUnder(f, d)))
    .filter(d => !Object.keys(state.dirs).some(o => o !== d && isUnder(o, d) && !baseDirSet.has(o)));

  const sort = (a, b) => (a.path || a.to || a).localeCompare(b.path || b.to || b);
  return { deletes: deletes.sort(), moves: moves.sort(sort), writes: writes.sort(sort), mkdirs: mkdirs.sort() };
}

// User-facing list of pending changes: [{path, kind, from?}], kind one of
// added | modified | renamed | deleted | folder-added | folder-deleted.
export function listChanges(state) {
  const { deletes, moves, writes, mkdirs } = compileChanges(state);
  const out = [];
  const baseDirSet = new Set(state.baseDirs);
  for (const d of deletes) out.push({ path: d, kind: baseDirSet.has(d) ? 'folder-deleted' : 'deleted' });
  const moved = new Set(moves.map(m => m.to));
  for (const m of moves) out.push({ path: m.to, from: m.from, kind: 'renamed' });
  for (const w of writes) {
    if (moved.has(w.path)) continue;
    out.push({ path: w.path, kind: state.files[w.path].origin ? 'modified' : 'added' });
  }
  for (const d of mkdirs) out.push({ path: d, kind: 'folder-added' });
  return out;
}

// path → kind for the tree's "unsaved" marks, incl. a 'contains' mark on every
// ancestor folder of a change so a collapsed folder still shows it.
export function changeMarks(state) {
  const marks = new Map();
  const { writes } = compileChanges(state);
  for (const c of listChanges(state)) {
    if (c.kind === 'deleted' || c.kind === 'folder-deleted') continue;
    marks.set(c.path, c.kind);
  }
  for (const w of writes) if (!marks.has(w.path)) marks.set(w.path, 'modified');
  for (const p of [...marks.keys()]) {
    const segs = p.split('/');
    for (let i = 1; i < segs.length; i++) {
      const anc = segs.slice(0, i).join('/');
      if (!marks.has(anc)) marks.set(anc, 'contains');
    }
  }
  return marks;
}

export function pendingCount(state) { return listChanges(state).length; }

export function saveBytes(state) {
  let n = 0;
  for (const e of Object.values(state.files)) {
    if (e.content !== undefined) n += utf8Length(e.content);
    else if (e.base64 !== undefined) n += e.size || 0;
  }
  return n;
}

function utf8Length(s) {
  return new TextEncoder().encode(String(s)).length;
}

/* ─── tree ───────────────────────────────────────────────────────────── */

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.name.localeCompare(b.name);

// Nested tree from the working state — folders first, then files, each
// alphabetical (AC3).
export function buildFileTree(state) {
  const root = { type: 'dir', name: '', path: '', children: [] };
  const dirNodes = new Map([['', root]]);
  const ensureDir = (p) => {
    if (dirNodes.has(p)) return dirNodes.get(p);
    const parent = ensureDir(parentDir(p));
    const node = { type: 'dir', name: baseName(p), path: p, children: [] };
    parent.children.push(node);
    dirNodes.set(p, node);
    return node;
  };
  for (const d of workingDirs(state)) ensureDir(d);
  for (const [p, e] of Object.entries(state.files)) {
    ensureDir(parentDir(p)).children.push({ type: 'file', name: baseName(p), path: p, size: e.size || 0 });
  }
  const sortRec = (node) => {
    node.children.sort((a, b) => (a.type === b.type ? byName(a, b) : a.type === 'dir' ? -1 : 1));
    for (const c of node.children) if (c.type === 'dir') sortRec(c);
  };
  sortRec(root);
  return root.children;
}

// Depth-first list of the rows currently visible (collapsed folders hide
// their children) — drives keyboard navigation of the tree (AC26).
export function visibleRows(tree, expanded, depth = 0, out = []) {
  for (const n of tree) {
    out.push({ ...n, depth });
    if (n.type === 'dir' && expanded.has(n.path)) visibleRows(n.children, expanded, depth + 1, out);
  }
  return out;
}

// Folder that new files/uploads go into for the current selection.
export function targetFolder(state, selected) {
  if (!selected) return '';
  return isDir(state, selected) ? selected : parentDir(selected);
}

/* ─── content helpers ────────────────────────────────────────────────── */

// Split YAML frontmatter off a markdown text so it can be shown as a distinct
// metadata block instead of a run-on paragraph (AC6).
export function splitFrontmatter(text) {
  const s = String(text == null ? '' : text);
  const m = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(s);
  if (!m) return { frontmatter: null, body: s };
  return { frontmatter: m[1], body: s.slice(m[0].length) };
}

// Probe decoded bytes for a NUL in the first 8 KB — the server's binary rule.
export function looksBinary(bytes) {
  const n = Math.min(bytes.length, 8192);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

// Who may edit this skill (UX only — every write is re-checked server-side).
export function skillEditPermission(skill, caller) {
  if (!skill) return { editable: false, reason: 'No skill selected' };
  if (skill.source === 'agent') {
    return { editable: false, reason: 'Agent-tier copies are read-only here — publish or promote the skill to edit it in a pool.' };
  }
  if (skill.source === 'team') {
    const c = caller || {};
    const ok = !!c.isSysAdmin || (c.adminTeamIds || []).includes(skill.teamId);
    return ok ? { editable: true, reason: null } : { editable: false, reason: 'Only a Team Admin of this team can edit its skills.' };
  }
  return canWriteGlobalSkills(caller || {})
    ? { editable: true, reason: null }
    : { editable: false, reason: 'Editing a global skill needs System Admin or Team Admin rights.' };
}
