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
// Single source for the PR/issue extraction (#2101 AC2): the pending-queue
// projection needs the identical function and must stay fs-free, so it lives in
// its own pure module rather than here, in the writer that owns the disk I/O.
const { extractWorkItem } = require('./github-work-item');

const EVENT_LOG_DIR = process.env.GITHUB_EVENT_LOG_DIR || '/workspace/github-event-log';
const RETENTION_DAYS = 7;

// Build the normalized log entry for one fresh event. `outcomes` is one
// entry per subscriber whose trigger's event-type filter matched this event
// (subscribers that don't listen to this event type at all are not
// represented — see issue #469 AC #4, which distinguishes "no one is
// listening" from "someone listened but a gate dropped it").
//
// `label` (#487) captures `payload.label.name` for *.labeled / *.unlabeled
// events (issues and, where GitHub delivers them, PRs) — the same field the
// poller's labelFilter gate already reads. null for event types that don't
// carry a label.
//
// `workItem` (#1827) captures the PR/issue an event happened on — its kind
// (`pr`|`issue`), number, title and GitHub URL — so the log can surface "which
// PR/issue" instead of only the raw event type. null for events with no work
// item (e.g. `push`). See extractWorkItem for the null-safe extraction.
//
// `ref` (#1833 AC1.3) captures the git ref a `push`/`create`/`delete` event
// carries (`payload.ref`, e.g. `refs/heads/main` for a push or the bare branch/
// tag name for create/delete) so those work-item-less rows can name the branch
// they touched. null for events that carry no ref.
function buildEventEntry({ ghEvent, repoFullName, key, outcomes }) {
  const list = Array.isArray(outcomes) ? outcomes : [];
  return {
    ts: new Date().toISOString(),
    eventId: String(ghEvent.id),
    repo: repoFullName,
    event: key || null,
    actor: ghEvent.actor?.login || null,
    createdAt: ghEvent.created_at || null,
    label: ghEvent.payload?.label?.name || null,
    ref: typeof ghEvent.payload?.ref === 'string' ? ghEvent.payload.ref : null,
    workItem: extractWorkItem(ghEvent.payload),
    outcomes: list,
    noMatchingTrigger: list.length === 0,
  };
}

// #2596: fold a pooled role's routing verdict (the `decision` out-parameter
// `enqueuePending` fills) into a delivered outcome, for the producers that
// record `delivered` up front (label fast-path, manual re-fire):
// - routed to a pool instance → stamp its `instanceId`, so the Event Log links
//   the instance that ran it rather than the role template;
// - held (the flow's WIP lane, or a pooled role's pause/drain/off control) →
//   `held` with that reason (`'wip'` by default, plus `wipLimit`), mirroring the
//   poller's fan-out, so no link points at a session that never ran.
// A dispatch that ran with no `instanceId` (non-pooled) is returned unchanged.
function applyPoolDecision(outcome, decision) {
  if (!outcome || outcome.status !== 'delivered' || !decision) return outcome;
  if (decision.held) {
    const held = { ...outcome, status: 'held', reason: decision.reason || 'wip' };
    if (decision.wipLimit != null) held.wipLimit = decision.wipLimit;
    return held;
  }
  if (typeof decision.instanceId !== 'string' || !decision.instanceId) return outcome;
  return { ...outcome, instanceId: decision.instanceId };
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

// Read every entry still inside the retention window, oldest file first.
// Needed by the manual re-fire (#2525), which must look up the dropped entry,
// any earlier re-fire of it and — for `internal-dedup` — the twin delivery.
// Retention bounds this to RETENTION_DAYS files. Best-effort: [] on any error.
function readEntries() {
  const out = [];
  try {
    const files = fs.readdirSync(EVENT_LOG_DIR)
      .filter((f) => /^github-events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f))
      .sort();
    for (const f of files) {
      let content = '';
      try { content = fs.readFileSync(path.join(EVENT_LOG_DIR, f), 'utf8'); } catch { continue; }
      for (const ln of content.split('\n')) {
        if (!ln.trim()) continue;
        try { out.push(JSON.parse(ln)); } catch { /* skip corrupt line */ }
      }
    }
  } catch {
    // Directory doesn't exist yet — nothing logged.
  }
  return out;
}

module.exports = {
  EVENT_LOG_DIR,
  RETENTION_DAYS,
  buildEventEntry,
  applyPoolDecision,
  extractWorkItem,
  record,
  readEntries,
  expiredDayFiles,
  cleanupOldEntries,
};
