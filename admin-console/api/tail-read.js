'use strict';

// Bounded "read the last N lines" primitive for day-bucketed JSONL logs (#1684).
//
// Several read endpoints (GET /api/audit, GET /api/github-events) only ever want
// the newest handful of rows, but historically parsed EVERY day-file fully on
// every request — so their cost grew with total history, not the requested page
// size. This module reads a file BACKWARDS in bounded chunks, stopping as soon
// as enough trailing lines are gathered, so cost is O(bytes in the tail) rather
// than O(file size). Across a chronological set of files it reads newest-first
// and never touches an older file once the page is satisfied.
//
// Byte-safe: newlines (0x0A) never occur inside a UTF-8 multibyte sequence, so a
// line is only decoded to a string once its complete byte range is assembled —
// a multibyte character split across a chunk boundary is never mis-decoded.

const fs = require('fs');

const NEWLINE = 0x0a;
const DEFAULT_CHUNK = 64 * 1024;

// Read up to `maxLines` trailing non-empty lines from one file, returned in file
// order (oldest→newest within the file). Best-effort: an unreadable/missing file
// yields []. Only the tail of the file is read — at most
// `ceil(bytesScanned / chunkSize)` reads, where bytesScanned is bounded by where
// the maxLines-th-from-last line begins.
function readLastLines(filePath, maxLines, { chunkSize = DEFAULT_CHUNK } = {}) {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return [];
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
  } catch {
    return [];
  }
  try {
    let pos = fs.fstatSync(fd).size;
    if (pos <= 0) return [];
    const lines = []; // collected newest-first, reversed before return
    // Bytes read but not yet resolved into complete lines: the leading partial
    // line of the region scanned so far (it may continue into an earlier chunk).
    let pending = Buffer.alloc(0);
    const chunk = Buffer.allocUnsafe(Math.max(1, chunkSize | 0));
    while (pos > 0 && lines.length < maxLines) {
      const readSize = Math.min(chunk.length, pos);
      pos -= readSize;
      const bytes = fs.readSync(fd, chunk, 0, readSize, pos);
      // Freshly-read (earlier) bytes go BEFORE the previously-held partial.
      pending = Buffer.concat([chunk.subarray(0, bytes), pending]);
      // Peel complete lines off the END of `pending`, leaving the bytes before
      // the first newline in this accumulated region as the still-partial head.
      let nl;
      while (lines.length < maxLines && (nl = pending.lastIndexOf(NEWLINE)) !== -1) {
        const line = pending.subarray(nl + 1).toString('utf8');
        pending = pending.subarray(0, nl);
        if (line.trim()) lines.push(line);
      }
    }
    // Start-of-file reached with room left: the remaining head is the first line.
    if (lines.length < maxLines && pending.length) {
      const first = pending.toString('utf8');
      if (first.trim()) lines.push(first);
    }
    return lines.reverse();
  } catch {
    return [];
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Read up to `maxLines` trailing non-empty lines across a chronological
// (oldest→newest) list of absolute file paths. Reads newest-file-first and
// stops the moment enough lines are gathered — older files are never opened once
// the page is full. Returns lines in global chronological order (oldest→newest),
// at most `maxLines` in length.
function readLastLinesAcross(filePaths, maxLines, opts) {
  if (!Number.isFinite(maxLines) || maxLines <= 0) return [];
  const files = Array.isArray(filePaths) ? filePaths : [];
  const perFile = []; // newest-file-first
  let total = 0;
  for (let i = files.length - 1; i >= 0 && total < maxLines; i--) {
    const lines = readLastLines(files[i], maxLines - total, opts);
    if (lines.length) {
      perFile.push(lines);
      total += lines.length;
    }
  }
  const out = [];
  for (let i = perFile.length - 1; i >= 0; i--) out.push(...perFile[i]);
  return out;
}

module.exports = { readLastLines, readLastLinesAcross };
