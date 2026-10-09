// A pooled role's removed instances (#2944) — the rail's "Removed instances"
// group and the read-only archive view. Pure: the JSX renders these strings.
//
// An entry is one row of GET /api/agents/:roleId/pool-archive:
// { key, instanceId, item, repo, spawnedAt, archivedAt, reason, hasChat,
//   legacy, expiresAt }.

export function removedInstancesLabel(count) {
  return `Removed instances (${count})`;
}

// Hidden when there is nothing to show (AC3).
export function showRemovedInstances(roleAgent) {
  return Number.isInteger(roleAgent?.poolArchiveCount) && roleAgent.poolArchiveCount > 0;
}

const REASON_LABELS = {
  done: 'ticket released',
  'idle-timeout': 'idle timeout',
  'hard-timeout': 'hard timeout',
  'pr-closed': 'PR wait ended',
  deleted: 'deleted manually',
};

// Why the instance was reaped; an archive from before #2944 has no reason.
export function reapReasonLabel(reason) {
  return REASON_LABELS[reason] || 'reason not recorded';
}

// The item's GitHub link — `/issues/<n>` also redirects to a PR. Null when the
// repo is not a usable `owner/name` or the item is not a number (a recurring
// pool's item is a name, not a ticket).
export function itemUrl(repo, item) {
  if (typeof repo !== 'string' || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) return null;
  if (item == null || !/^\d+$/.test(String(item))) return null;
  return `https://github.com/${repo}/issues/${item}`;
}

// The item as shown: `#123` for a ticket, the bare key otherwise.
export function itemLabel(item) {
  if (item == null || item === '') return null;
  return /^\d+$/.test(String(item)) ? `#${item}` : String(item);
}

// The entry's display name, after its role like a live instance
// ("Developer · #2562"); an archive without a recorded item falls back to the
// item parsed from its instance id, then to the id itself.
export function removedInstanceName(entry, roleAgent) {
  const roleName = roleAgent?.displayName || roleAgent?.id || null;
  let item = entry?.item ?? null;
  if (item == null && roleAgent?.id && entry?.instanceId?.startsWith(`${roleAgent.id}-i`)) {
    item = entry.instanceId.slice(roleAgent.id.length + 2) || null;
  }
  const label = itemLabel(item);
  if (roleName && label) return `${roleName} · ${label}`;
  return entry?.instanceId || '';
}

// AC10: what the archive view says when there is no chat to show.
export function archivedChatNotice(entry) {
  if (!entry || entry.hasChat) return null;
  return entry.legacy
    ? 'No chat history was archived for this instance — it was removed before chat archiving existed. The session log is below.'
    : 'No chat history was archived for this instance — the chat room could not be read when it was removed. The session log is below.';
}

// The rail's collapse key for a role's removed-instances group: collapsed by
// default (AC3), persisted like the live "Instances" group.
export function removedInstancesCollapseEntity(roleId) {
  return { kind: 'archive', id: roleId };
}

// Session-log pager over the archive's paged transcript (page 0 = newest).
export function sessionPageLabel(page, pages) {
  if (!Number.isInteger(pages) || pages <= 1) return null;
  return `Part ${pages - page} of ${pages}`;
}

// A timestamp as the rail and archive header show it; null when unreadable.
export function formatArchiveDate(iso, { locale, timeZone } = {}) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleString(locale, { dateStyle: 'medium', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) });
}

// The entry's facts, label → value, in display order (AC3); a fact the
// archive did not record is left out rather than shown as blank.
export function removedInstanceFacts(entry, opts) {
  const facts = [['Instance', entry?.instanceId || null]];
  facts.push(['Spawned', formatArchiveDate(entry?.spawnedAt, opts)]);
  facts.push(['Removed', formatArchiveDate(entry?.archivedAt, opts)]);
  facts.push(['Reason', reapReasonLabel(entry?.reason)]);
  facts.push(['Readable until', formatArchiveDate(entry?.expiresAt, opts)]);
  return facts.filter(([, v]) => v);
}

// The removed instance's Matrix user, so its messages render as the agent's:
// an instance's user is `@<instanceId>:<server>`, the server its role's.
export function archivedAgentUserId(roleUserId, instanceId) {
  if (!instanceId) return null;
  const m = typeof roleUserId === 'string' ? /^@[^:]+:(.+)$/.exec(roleUserId) : null;
  return `@${instanceId}:${m ? m[1] : 'local'}`;
}

// The archive's session-log URL for one room and page.
export function archiveSessionUrl(roleId, key, roomId, page = 0) {
  return `/api/agents/${encodeURIComponent(roleId)}/pool-archive/${encodeURIComponent(key)}`
    + `/session/${encodeURIComponent(roomId)}?limit=500&page=${page}`;
}
