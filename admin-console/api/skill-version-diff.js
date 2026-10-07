'use strict';

// Skill version diff (#2839) — the PURE comparison of two full skill contents
// (two version snapshots, or a snapshot and the working copy). The api.js route
// reads both sides ([{path, bytes}] — skill-manifest.readSnapshot /
// readSkillDirFiles) and hands them here; this module classifies every file and
// computes per-file line diffs, so it is unit-testable with `node --test`.
//
// Classification per file: added | removed | modified | renamed | unchanged.
// A rename is detected when a removed and an added file carry identical bytes,
// or (text files only) when their line content is at least RENAME_SIMILARITY
// alike; anything else stays a remove + add. Binary files (NUL in the first
// 8 KB) and files over MAX_DIFF_BYTES are compared by bytes only and never get
// a content diff ("binary/too large — changed/unchanged").
//
// A line diff is a list of ops { t: ' '|'+'|'-', a, b, s }: `t` the marker,
// `a`/`b` the 1-based line number on the old/new side (null on the side the
// line does not exist), `s` the line text. The common prefix/suffix is trimmed
// first and the middle is an LCS; when the middle is too big for the LCS table
// (MAX_LCS_CELLS) it degrades to one replace block so a large skill stays
// responsive instead of stalling the API.

const MAX_DIFF_BYTES = 512 * 1024; // mirrors SKILL_FILE_MAX_BYTES in api.js
const BINARY_PROBE_BYTES = 8192;
const RENAME_SIMILARITY = 0.5;
const MAX_LCS_CELLS = 4000000;

function toBuffer(bytes) {
  if (Buffer.isBuffer(bytes)) return bytes;
  return Buffer.from(String(bytes == null ? '' : bytes), 'utf8');
}

function isBinary(buf) {
  return buf.subarray(0, Math.min(buf.length, BINARY_PROBE_BYTES)).includes(0);
}

// Split text into lines without the terminators; a trailing newline does not
// produce an extra empty line.
function splitLines(text) {
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines.map(l => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

// Line diff of two line arrays → ops (see header).
function diffLines(oldLines, newLines) {
  const a = Array.isArray(oldLines) ? oldLines : [];
  const b = Array.isArray(newLines) ? newLines : [];
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;

  const ops = [];
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', a: i + 1, b: i + 1, s: a[i] });

  const am = a.slice(pre, a.length - suf);
  const bm = b.slice(pre, b.length - suf);
  const n = am.length;
  const m = bm.length;
  if (n > 0 && m > 0 && (n + 1) * (m + 1) <= MAX_LCS_CELLS) {
    // LCS table, filled from the end so the walk below reads front-to-back.
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        t[i * w + j] = am[i] === bm[j] ? t[(i + 1) * w + j + 1] + 1 : Math.max(t[(i + 1) * w + j], t[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        ops.push({ t: ' ', a: pre + i + 1, b: pre + j + 1, s: am[i] });
        i++; j++;
      } else if (t[(i + 1) * w + j] >= t[i * w + j + 1]) {
        ops.push({ t: '-', a: pre + i + 1, b: null, s: am[i] });
        i++;
      } else {
        ops.push({ t: '+', a: null, b: pre + j + 1, s: bm[j] });
        j++;
      }
    }
    for (; i < n; i++) ops.push({ t: '-', a: pre + i + 1, b: null, s: am[i] });
    for (; j < m; j++) ops.push({ t: '+', a: null, b: pre + j + 1, s: bm[j] });
  } else {
    for (let i = 0; i < n; i++) ops.push({ t: '-', a: pre + i + 1, b: null, s: am[i] });
    for (let j = 0; j < m; j++) ops.push({ t: '+', a: null, b: pre + j + 1, s: bm[j] });
  }

  for (let k = 0; k < suf; k++) {
    const ai = a.length - suf + k;
    const bi = b.length - suf + k;
    ops.push({ t: ' ', a: ai + 1, b: bi + 1, s: a[ai] });
  }
  return ops;
}

function countOps(ops) {
  let added = 0;
  let removed = 0;
  for (const o of ops) {
    if (o.t === '+') added++;
    else if (o.t === '-') removed++;
  }
  return { added, removed };
}

// Line-content similarity in [0,1]: 2·|common lines (multiset)| / (n + m).
function similarity(oldLines, newLines) {
  const total = oldLines.length + newLines.length;
  if (total === 0) return 1;
  const counts = new Map();
  for (const l of oldLines) counts.set(l, (counts.get(l) || 0) + 1);
  let common = 0;
  for (const l of newLines) {
    const c = counts.get(l);
    if (c) { common++; counts.set(l, c - 1); }
  }
  return (2 * common) / total;
}

// Describe one side of a file for classification.
function describe(file) {
  const buf = toBuffer(file.bytes);
  const binary = isBinary(buf);
  const tooLarge = buf.length > MAX_DIFF_BYTES;
  const text = binary || tooLarge ? null : buf.toString('utf8');
  return { path: file.path, buf, size: buf.length, binary, tooLarge, lines: text == null ? null : splitLines(text) };
}

// One changed/unchanged pair → the file entry the UI renders.
function compareEntry(status, from, to) {
  const entry = { path: (to || from).path, status };
  if (status === 'renamed') entry.fromPath = from.path;
  entry.fromSize = from ? from.size : null;
  entry.toSize = to ? to.size : null;
  const binary = !!((from && from.binary) || (to && to.binary));
  const tooLarge = !!((from && from.tooLarge) || (to && to.tooLarge));
  entry.binary = binary;
  entry.tooLarge = tooLarge;
  const contentEqual = !!(from && to && from.buf.equals(to.buf));
  entry.contentChanged = !contentEqual;
  if (binary || tooLarge) {
    entry.added = null;
    entry.removed = null;
    return entry;
  }
  if (status === 'unchanged') {
    entry.added = 0;
    entry.removed = 0;
    return entry;
  }
  const ops = diffLines(from ? from.lines : [], to ? to.lines : []);
  const c = countOps(ops);
  entry.added = c.added;
  entry.removed = c.removed;
  entry.ops = ops;
  return entry;
}

const STATUS_ORDER = { modified: 0, renamed: 1, added: 2, removed: 3, unchanged: 4 };

// Compare two full skill contents. `fromFiles` is the OLDER side.
function diffSkillVersions(fromFiles, toFiles) {
  const fromMap = new Map();
  for (const f of Array.isArray(fromFiles) ? fromFiles : []) if (f && f.path) fromMap.set(f.path, describe(f));
  const toMap = new Map();
  for (const f of Array.isArray(toFiles) ? toFiles : []) if (f && f.path) toMap.set(f.path, describe(f));

  const entries = [];
  const removed = [];
  const added = [];
  for (const [p, from] of fromMap) {
    const to = toMap.get(p);
    if (!to) { removed.push(from); continue; }
    entries.push(compareEntry(from.buf.equals(to.buf) ? 'unchanged' : 'modified', from, to));
  }
  for (const [p, to] of toMap) if (!fromMap.has(p)) added.push(to);

  // Renames: exact byte matches first, then the most similar text pair ≥ threshold.
  const usedAdded = new Set();
  const renamedFrom = new Set();
  for (const r of removed) {
    const hit = added.find(a => !usedAdded.has(a.path) && a.buf.equals(r.buf));
    if (hit) {
      usedAdded.add(hit.path);
      renamedFrom.add(r.path);
      entries.push(compareEntry('renamed', r, hit));
    }
  }
  for (const r of removed) {
    if (renamedFrom.has(r.path) || r.lines == null) continue;
    let best = null;
    let bestScore = RENAME_SIMILARITY;
    for (const a of added) {
      if (usedAdded.has(a.path) || a.lines == null) continue;
      const score = similarity(r.lines, a.lines);
      if (score >= bestScore && (!best || score > bestScore)) { best = a; bestScore = score; }
    }
    if (best) {
      usedAdded.add(best.path);
      renamedFrom.add(r.path);
      entries.push(compareEntry('renamed', r, best));
    }
  }
  for (const r of removed) if (!renamedFrom.has(r.path)) entries.push(compareEntry('removed', r, null));
  for (const a of added) if (!usedAdded.has(a.path)) entries.push(compareEntry('added', null, a));

  entries.sort((x, y) => (STATUS_ORDER[x.status] - STATUS_ORDER[y.status]) || (x.path < y.path ? -1 : x.path > y.path ? 1 : 0));

  const summary = { added: 0, removed: 0, modified: 0, renamed: 0, unchanged: 0, linesAdded: 0, linesRemoved: 0 };
  for (const e of entries) {
    summary[e.status] += 1;
    summary.linesAdded += e.added || 0;
    summary.linesRemoved += e.removed || 0;
  }
  const identical = entries.every(e => e.status === 'unchanged');
  return { identical, files: entries, summary };
}

module.exports = {
  MAX_DIFF_BYTES, RENAME_SIMILARITY, MAX_LCS_CELLS,
  splitLines, diffLines, similarity, diffSkillVersions,
};
