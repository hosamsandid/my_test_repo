'use strict';

// GitHub poller event-transparency log (#469).
//
// Every event the poller confirms "fresh" (survived the seen-id dedup) is
// recorded here — whether it was delivered to an agent, dropped by one of
// the loop-protection layers, folded into a burst digest, or matched no
// subscriber at all. This is a SEPARATE, purely observational log: it never
// influences delivery decisions, only records them, so admins can tell "a
// bug dropped this" from "a protection layer correctly dropped this".
//
// Mirrors the day-bucketed JSONL pattern of admin-console/api/audit.js, but
// lives on the poller side (the writer) since only the orchestrator process
// has the per-event gate outcomes in scope. admin-console/api/github-event-log.js
// is the read-side counterpart on the same shared `/workspace` volume.
//
// Safety contract: logging is strictly best-effort. A failure here must
// never affect event delivery — every file operation is wrapped.

const fs = require('fs');
const path = require('path');

const EVENT_LOG_DIR = process.env.GITHUB_EVENT_LOG_DIR || '/workspace/github-event-log';
const RETENTION_DAYS = 7;

// Build the normalized log entry for one fresh event. `outcomes` is one
// entry per subscriber whose trigger's event-type filter matched this event
// (subscribers that don't listen to this event type at all are not
// represented — see issue #469 AC #4, which distinguishes "no one is
// listening" from "someone listened but a gate dropped it").
function buildEventEntry({ ghEvent, repoFullName, key, outcomes }) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  return {
    ts: new Date().toISOString(),
    eventId: String(ghEvent.id),
    repo: repoFullName,
    event: key || null,
    actor: ghEvent.actor?.login || null,
    createdAt: ghEvent.created_at || null,
    outcomes: list,
    noMatchingTrigger: list.length === 0,
  };
}

// Append one entry as a JSONL line to the current day's file. Never throws.
function record(entry) {
  try {
    fs.mkdirSync(EVENT_LOG_DIR, { recursive: true });
    const day = String(entry.ts).slice(0, 10); // YYYY-MM-DD
    fs.appendFileSync(path.join(EVENT_LOG_DIR, `github-events-${day}.jsonl`), JSON.stringify(entry) + '\n');
  } catch {
    // Swallow: this log must never break or block the poller's fan-out path.
  }
}

// Pure: given the day-bucketed filenames already in the directory and "now",
// return which ones are past the retention window. Exported so the rolling
// cleanup can be unit-tested without touching the filesystem.
function expiredDayFiles(files, now, retentionDays = RETENTION_DAYS) {
  const cutoff = now - retentionDays * 24 * 60 * 60 * 1000;
  return files.filter((f) => {
    const m = /^github-events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f);
    if (!m) return false;
    const dayEndMs = Date.parse(`${m[1]}T23:59:59.999Z`);
    return Number.isFinite(dayEndMs) && dayEndMs < cutoff;
  });
}

// Delete day files older than the retention window. Best-effort; a missing
// directory (nothing logged yet) is not an error.
function cleanupOldEntries(now = Date.now(), retentionDays = RETENTION_DAYS) {
  try {
    const files = fs.readdirSync(EVENT_LOG_DIR).filter((f) => /^github-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f));
    for (const f of expiredDayFiles(files, now, retentionDays)) {
      try { fs.unlinkSync(path.join(EVENT_LOG_DIR, f)); } catch { /* best-effort */ }
    }
  } catch {
    // Directory doesn't exist yet — nothing to clean up.
  }
}

module.exports = {
  EVENT_LOG_DIR,
  RETENTION_DAYS,
  buildEventEntry,
  record,
  expiredDayFiles,
  cleanupOldEntries,
};
