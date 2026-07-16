'use strict';

// Pure size-based rotation policy for per-room session logs (#673).
//
// Room logs (`sessions/<roomId>.jsonl`) are append-only and, before this, never
// rotated — one grew to 18.9 MB and wedged the control-plane mirror. Rotation
// archives the live file to `sessions/<roomId>.<seq>.jsonl` (seq monotonically
// increasing, 1-based) once it crosses a size threshold, on BOTH the agent
// workspace and the pushed control-plane copy, with bounded retention.
//
// The byte-cursor push (session-cursor.js) reconciles the LIVE file only; the
// SSE viewer resumes the LIVE file by byte offset. Archives are read wholesale
// (finished-session history, correlationId scoping), never by byte offset — so
// only the live file's offsets must stay reconcilable across the two sides. The
// writer owns the rotation decision; the control plane rotates on command at the
// fully-synced boundary so its archive is byte-identical to the agent's.
//
// This module is the pure arithmetic (naming, seq, threshold, retention) so it
// can be unit-tested in isolation and mirrored byte-for-byte by the Python
// runtime (agent-image/scripts/agent-entrypoint.py: _archive_name /
// _parse_archive_seq / _next_archive_seq / _should_rotate / _plan_prune).

const ROTATION_DEFAULTS = Object.freeze({
  maxBytes: 8_000_000, // rotate once the live file reaches ~8 MB
  maxCount: 5,         // keep at most this many archives per room
  maxAgeDays: 30,      // …and drop archives older than this
});

// Read the rotation config from the environment, falling back to the defaults.
// Values are clamped so a bad env var can never disable the size cap or produce
// a negative retention. maxBytes<=0 would mean "never rotate" — we forbid that
// (a typo must not reintroduce the unbounded-growth bug), clamping to the
// default; maxCount/maxAgeDays of 0 legitimately mean "unbounded on that axis".
function rotationConfig(env = {}) {
  const num = (v, dflt) => {
    const n = Number(v);
    return Number.isFinite(n) ? n : dflt;
  };
  let maxBytes = num(env.AEE_SESSION_ROTATE_BYTES, ROTATION_DEFAULTS.maxBytes);
  if (!(maxBytes > 0)) maxBytes = ROTATION_DEFAULTS.maxBytes;
  let maxCount = num(env.AEE_SESSION_ROTATE_KEEP, ROTATION_DEFAULTS.maxCount);
  if (!(maxCount >= 0)) maxCount = ROTATION_DEFAULTS.maxCount;
  let maxAgeDays = num(env.AEE_SESSION_ROTATE_MAX_AGE_DAYS, ROTATION_DEFAULTS.maxAgeDays);
  if (!(maxAgeDays >= 0)) maxAgeDays = ROTATION_DEFAULTS.maxAgeDays;
  return { maxBytes, maxCount, maxAgeDays };
}

// Escape a room id for safe embedding in a RegExp (room ids may carry `:` / `.`
// in the homeserver part, e.g. `!abc:host.name`).
function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function archiveName(roomId, seq) {
  return `${roomId}.${seq}.jsonl`;
}

// Return the integer archive sequence for `name` if it is an archive of
// `roomId`, else null. Strict: matches `<roomId>.<n>.jsonl` with n a positive
// integer — never the live file (`<roomId>.jsonl`) or the pointer
// (`<roomId>.current.json`). A homeserver part ending in a number (e.g.
// `!r:1.2.3`) is disambiguated because the *whole* roomId must prefix-match.
function parseArchiveSeq(name, roomId) {
  const re = new RegExp(`^${escapeRegExp(roomId)}\\.(\\d+)\\.jsonl$`);
  const m = typeof name === 'string' ? name.match(re) : null;
  if (!m) return null;
  const seq = Number(m[1]);
  if (!Number.isInteger(seq) || seq < 1) return null;
  // Reject leading-zero forms ("01") so naming stays canonical.
  if (String(seq) !== m[1]) return null;
  return seq;
}

// From a directory listing, the archives of `roomId`, ascending by seq (i.e.
// oldest→newest, which is also chronological event order).
function listArchives(names, roomId) {
  const out = [];
  for (const name of names || []) {
    const seq = parseArchiveSeq(name, roomId);
    if (seq != null) out.push({ name, seq });
  }
  out.sort((a, b) => a.seq - b.seq);
  return out;
}

// The next sequence number to assign when rotating `roomId`'s live file:
// one past the highest existing archive, or 1 when there are none.
function nextArchiveSeq(names, roomId) {
  const archives = listArchives(names, roomId);
  return archives.length ? archives[archives.length - 1].seq + 1 : 1;
}

function shouldRotate(size, maxBytes) {
  return maxBytes > 0 && Number.isFinite(size) && size >= maxBytes;
}

// Decide which archives to delete under the retention policy. Input is one
// entry per archive `{ name, seq, mtimeMs }`; returns the names to remove.
// An archive is pruned when it is older than maxAgeDays OR it falls outside the
// newest `maxCount` (by seq). maxCount/maxAgeDays of 0 disables that axis.
function planPrune(archives, { maxCount, maxAgeMs, now } = {}) {
  const list = (archives || []).slice().sort((a, b) => a.seq - b.seq); // oldest first
  const doomed = new Set();
  if (maxAgeMs > 0 && Number.isFinite(now)) {
    for (const a of list) {
      if (Number.isFinite(a.mtimeMs) && now - a.mtimeMs > maxAgeMs) doomed.add(a.name);
    }
  }
  if (maxCount > 0 && list.length > maxCount) {
    const overflow = list.length - maxCount;
    for (let i = 0; i < overflow; i++) doomed.add(list[i].name); // drop oldest
  }
  return list.filter(a => doomed.has(a.name)).map(a => a.name);
}

module.exports = {
  ROTATION_DEFAULTS,
  rotationConfig,
  archiveName,
  parseArchiveSeq,
  listArchives,
  nextArchiveSeq,
  shouldRotate,
  planPrune,
};
