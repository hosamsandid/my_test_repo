'use strict';

// Pure helpers for reading rotated session-log archives (#673).
//
// Rotation archives a room's live log to `sessions/<roomId>.<seq>.jsonl` (seq
// 1-based, ascending = chronological). The live file keeps the byte-cursor
// contract (SSE tail, `?since=<byte>`, the push `baseOffset`); archives are only
// ever read WHOLESALE — finished-session history and correlationId-scoped
// backfill span live + archives, so the event set survives rotation.
//
// The naming rules mirror orchestrator/session-rotation.js (the writer side).
// Kept here rather than cross-required so the admin-console package stays
// self-contained (same split as github-event-log.js).

function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Integer archive seq of `name` for `roomId`, else null. Strict: only
// `<roomId>.<n>.jsonl` with n a canonical positive integer.
function parseArchiveSeq(name, roomId) {
  const re = new RegExp(`^${escapeRegExp(roomId)}\\.(\\d+)\\.jsonl$`);
  const m = typeof name === 'string' ? name.match(re) : null;
  if (!m) return null;
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq < 1 || String(seq) !== m[1]) return null;
  return seq;
}

// Given a directory listing, the archive file names of `roomId` in seq order
// (oldest→newest). The live file and pointer are excluded.
function orderedArchiveNames(names, roomId) {
  const out = [];
  for (const name of names || []) {
    const seq = parseArchiveSeq(name, roomId);
    if (seq != null) out.push({ name, seq });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out.map(a => a.name);
}

// Resolve a session-log file name back to its base room id. Archive files
// (`<room>.<seq>.jsonl`) map to `<room>`; a live file (`<room>.jsonl`) maps to
// `<room>`. Because a numeric homeserver tail is ambiguous at the string level
// (`!r:1.2.3.jsonl` could be room `!r:1.2.3`'s live file OR room `!r:1.2`'s
// archive seq 3), we treat a candidate as an archive ONLY when its base live
// file (`<base>.jsonl`) is present in the same directory (`existingNames`).
function baseRoomOfSessionFile(name, existingNames) {
  if (typeof name !== 'string' || !name.endsWith('.jsonl')) return null;
  const stem = name.slice(0, -'.jsonl'.length); // strip trailing .jsonl
  const m = stem.match(/^(.*)\.(\d+)$/);
  if (m && String(Number(m[2])) === m[2] && Number(m[2]) >= 1) {
    const base = m[1];
    const set = existingNames instanceof Set ? existingNames : new Set(existingNames || []);
    if (set.has(`${base}.jsonl`)) return base; // it's an archive of `base`
  }
  return stem; // it's a live file
}

module.exports = {
  parseArchiveSeq,
  orderedArchiveNames,
  baseRoomOfSessionFile,
};
