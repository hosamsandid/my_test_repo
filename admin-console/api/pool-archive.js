'use strict';

// Read side of a removed pool instance's archive (#2944).
//
// When the orchestrator reaps a pool instance (`gracefulPoolTeardown` →
// `archivePoolInstance`) it keeps the instance's session log and DM chat
// history under `/workspace/teams/<team>/pool-archive/<key>/`:
//
//   sessions/<roomId>[.<seq>].jsonl   the transcript, rotations included
//   chat.json                         { roomId, truncated, events } — the DM
//                                     room's m.room.message events, oldest first
//   archived-at.json                  { archivedAt, instanceId, roleId, item,
//                                     repo, spawnedAt, reason, roomId, chat }
//
// `<key>` is `<instanceId>~<epochMs>` (an instance reaped twice keeps both);
// an archive written before #2944 is named by the bare instance id and its
// stamp holds only `archivedAt` (no chat). An in-progress archive is a
// `.tmp-<key>` directory and is never listed. The prune pass (orchestrator
// `_pruneArchivedPoolLogs`) deletes an archive once its role's `retainLogsMs`
// (default 30 days) has passed; this module hides an expired archive the
// moment it expires, so the list never offers one the prune is about to take.
//
// Self-contained (no orchestrator require) like session-archives.js; the
// default retention is pinned equal to orchestrator/agent-pool.js by test.

const fs = require('fs');
const path = require('path');
const { orderedArchiveNames, baseRoomOfSessionFile } = require('./session-archives');

const POOL_ARCHIVE_DEFAULT_RETAIN_MS = 30 * 24 * 60 * 60 * 1000;
const TMP_PREFIX = '.tmp-';
const REAP_REASONS = Object.freeze(['done', 'idle-timeout', 'hard-timeout', 'pr-closed', 'deleted']);

// Same rule as orchestrator/knowledge-feed.js `safeTeamSegment`.
function safeTeamSegment(teamId) {
  if (typeof teamId !== 'string') return null;
  const s = teamId.trim();
  if (s === '' || s === '.' || s === '..') return null;
  if (s.includes('/') || s.includes('\\')) return null;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(s)) return null;
  return s;
}

// An archive key as it may appear in a URL: an agent id, optionally followed by
// `~<epochMs>`. Never a dotfile (`.tmp-…`), never a path.
function isValidArchiveKey(key) {
  return typeof key === 'string'
    && /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*(~\d+)?$/.test(key);
}

function poolArchiveRoot(teamsDir, teamId) {
  const seg = safeTeamSegment(teamId);
  return seg ? path.join(teamsDir, seg, 'pool-archive') : null;
}

// The role an archive belongs to: its stamped `roleId`, else (an archive from
// before #2944) the `<roleId>-i` prefix of its instance id.
function belongsToRole(key, meta, roleId) {
  if (meta && typeof meta.roleId === 'string' && meta.roleId) return meta.roleId === roleId;
  const instanceId = key.split('~')[0];
  return instanceId.startsWith(`${roleId}-i`) && instanceId.length > roleId.length + 2;
}

function retentionMs(roleRetainLogsMs) {
  return Number.isFinite(roleRetainLogsMs) && roleRetainLogsMs > 0
    ? roleRetainLogsMs
    : POOL_ARCHIVE_DEFAULT_RETAIN_MS;
}

/**
 * One list row for a stamped archive, or null when it can't be listed (no
 * readable `archivedAt`) or has expired.
 */
function projectArchiveEntry(key, meta, { retainLogsMs, now = Date.now() } = {}) {
  if (!meta || typeof meta !== 'object') return null;
  const archivedMs = Date.parse(meta.archivedAt);
  if (!Number.isFinite(archivedMs)) return null;
  const expiresMs = archivedMs + retentionMs(retainLogsMs);
  if (now >= expiresMs) return null;
  const legacy = !Object.prototype.hasOwnProperty.call(meta, 'chat');
  const instanceId = typeof meta.instanceId === 'string' && meta.instanceId ? meta.instanceId : key.split('~')[0];
  return {
    key,
    instanceId,
    item: meta.item != null ? String(meta.item) : null,
    repo: typeof meta.repo === 'string' && meta.repo ? meta.repo : null,
    spawnedAt: typeof meta.spawnedAt === 'string' ? meta.spawnedAt : null,
    archivedAt: new Date(archivedMs).toISOString(),
    reason: REAP_REASONS.includes(meta.reason) ? meta.reason : null,
    hasChat: meta.chat === true,
    legacy,
    expiresAt: new Date(expiresMs).toISOString(),
  };
}

/**
 * A team's archive reader. The directory scan (one stamp read per archive) is
 * memoized on the pool-archive directory's mtime — an archive appearing or
 * being pruned is a rename/remove in that directory — so the roster can ask
 * for a count on every rebuild without re-reading every stamp. `maxAgeMs`
 * bounds how long a scan is trusted regardless (a stamp unreadable on one
 * pass is retried).
 */
function createPoolArchiveReader({ teamsDir, fsImpl = fs, maxAgeMs = 60_000, clock = Date.now } = {}) {
  const scans = new Map(); // root → { mtimeMs, at, entries: [{ key, meta }] }

  function scan(teamId) {
    const root = poolArchiveRoot(teamsDir, teamId);
    if (!root) return [];
    let mtimeMs;
    try { mtimeMs = fsImpl.statSync(root).mtimeMs; } catch { scans.delete(root); return []; }
    const hit = scans.get(root);
    if (hit && hit.mtimeMs === mtimeMs && clock() - hit.at < maxAgeMs) return hit.entries;
    let names = [];
    try { names = fsImpl.readdirSync(root); } catch { return []; }
    const entries = [];
    for (const key of names) {
      if (key.startsWith(TMP_PREFIX) || !isValidArchiveKey(key)) continue;
      let meta = null;
      try { meta = JSON.parse(fsImpl.readFileSync(path.join(root, key, 'archived-at.json'), 'utf8')); } catch { /* unstamped: not listed */ }
      if (meta && typeof meta === 'object') entries.push({ key, meta });
    }
    scans.set(root, { mtimeMs, at: clock(), entries });
    return entries;
  }

  // A role's listable archives, newest first.
  function listForRole(teamId, roleId, { retainLogsMs, now = Date.now() } = {}) {
    const out = [];
    for (const { key, meta } of scan(teamId)) {
      if (!belongsToRole(key, meta, roleId)) continue;
      const entry = projectArchiveEntry(key, meta, { retainLogsMs, now });
      if (entry) out.push(entry);
    }
    out.sort((a, b) => (a.archivedAt < b.archivedAt ? 1 : a.archivedAt > b.archivedAt ? -1 : 0));
    return out;
  }

  // One listable archive of the role, with its directory — null when it does
  // not exist, belongs to another role or has expired.
  function resolve(teamId, roleId, key, opts = {}) {
    if (!isValidArchiveKey(key)) return null;
    const entry = listForRole(teamId, roleId, opts).find(e => e.key === key);
    if (!entry) return null;
    const meta = scan(teamId).find(e => e.key === key).meta;
    return { entry, meta, dir: path.join(poolArchiveRoot(teamsDir, teamId), key) };
  }

  // The rooms the archived transcript covers, the DM room first.
  function rooms(archive) {
    let names = [];
    try { names = fsImpl.readdirSync(path.join(archive.dir, 'sessions')); } catch { /* no transcript */ }
    const set = new Set(names);
    const out = [];
    for (const name of names) {
      const room = baseRoomOfSessionFile(name, set);
      if (room && !out.includes(room)) out.push(room);
    }
    out.sort();
    const dm = archive.meta.roomId;
    return out.includes(dm) ? [dm, ...out.filter(r => r !== dm)] : out;
  }

  // One room's archived transcript (rotations oldest→newest, then the live
  // file), one page of `limit` events counted from the END: page 0 is the
  // newest window, so a large transcript opens at its end and pages back.
  function sessionPage(archive, roomId, { limit = 500, page = 0, parse = JSON.parse } = {}) {
    const dir = path.join(archive.dir, 'sessions');
    let names = [];
    try { names = fsImpl.readdirSync(dir); } catch { /* none */ }
    const files = [...orderedArchiveNames(names, roomId)];
    if (names.includes(`${roomId}.jsonl`)) files.push(`${roomId}.jsonl`);
    const events = [];
    for (const name of files) {
      let raw = '';
      try { raw = fsImpl.readFileSync(path.join(dir, name), 'utf8'); } catch { continue; }
      for (const line of raw.split('\n')) if (line.trim()) events.push(parse(line));
    }
    return slicePage(events, { limit, page });
  }

  // The archived chat as Matrix `/messages?dir=b` pages (newest first, `end`
  // the token of the next older page), so the transcript renders through the
  // same mapping as a live room. `noChat` when nothing was archived.
  function chatPage(archive, { from = null, limit = 50 } = {}) {
    let chat = null;
    try { chat = JSON.parse(fsImpl.readFileSync(path.join(archive.dir, 'chat.json'), 'utf8')); } catch { /* none */ }
    if (!chat || !Array.isArray(chat.events)) return { chunk: [], noChat: true };
    const newestFirst = chat.events.slice().reverse();
    const start = from != null && /^\d+$/.test(String(from)) ? Number(from) : 0;
    const n = clampLimit(limit, 200);
    const chunk = newestFirst.slice(start, start + n);
    const out = { chunk, truncated: chat.truncated === true };
    if (start + n < newestFirst.length) out.end = String(start + n);
    return out;
  }

  return { scan, listForRole, resolve, rooms, sessionPage, chatPage };
}

// The archive of `instanceId`'s lifetime that an event at `ts` ran in: the
// earliest one archived at or after the event (an item reaped twice keeps an
// archive per lifetime). Null when none is listable — the instance's archive
// has expired, failed or predates the event's lifetime.
function archiveKeyForEvent(entries, instanceId, ts) {
  const at = Date.parse(ts);
  let best = null;
  for (const e of entries || []) {
    if (e.instanceId !== instanceId) continue;
    if (Number.isFinite(at) && Date.parse(e.archivedAt) < at) continue;
    if (!best || e.archivedAt < best.archivedAt) best = e;
  }
  return best ? best.key : null;
}

function clampLimit(limit, max) {
  const n = Number(limit);
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : max;
}

function slicePage(events, { limit, page }) {
  const n = clampLimit(limit, 2000);
  const pages = Math.max(1, Math.ceil(events.length / n));
  const p = Number.isInteger(Number(page)) && Number(page) >= 0 ? Math.min(Number(page), pages - 1) : 0;
  const end = events.length - p * n;
  const start = Math.max(0, end - n);
  return { events: events.slice(start, end), page: p, pages, total: events.length, truncated: start > 0 };
}

module.exports = {
  POOL_ARCHIVE_DEFAULT_RETAIN_MS,
  REAP_REASONS,
  isValidArchiveKey,
  poolArchiveRoot,
  belongsToRole,
  projectArchiveEntry,
  createPoolArchiveReader,
  archiveKeyForEvent,
  slicePage,
};
