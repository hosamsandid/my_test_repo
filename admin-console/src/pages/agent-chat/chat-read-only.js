/**
 * Read-only agent chat for a System Admin outside the agent's team (#2713).
 *
 * The rule lives on the server (scope.js `canChatAgent`, enforced by the send
 * and chat-upload routes) and arrives as `canChat` on every
 * `GET /api/matrix/agents` row. This module only reads that flag — it never
 * re-derives the rule — and owns the hint wording and the Share link target,
 * so the JSX in ChatPanel/MessageInput stays a thin renderer (#651).
 */

/** The hint text, also the server's 403 message (chat-write-access.js). */
export const CHAT_READ_ONLY_HINT =
  "You're viewing this chat as a System Admin. To write here, add yourself to the team.";

/** The composer placeholder while read-only. */
export const CHAT_READ_ONLY_PLACEHOLDER = 'Read-only — you are not a member of this team';

/**
 * Is the composer read-only for this caller? Only an explicit `canChat: false`
 * counts: a row without the field (an older server) stays writable, which is
 * also the server's answer for everyone but a non-member System Admin.
 */
export function isChatReadOnly(agent) {
  return !!agent && agent.canChat === false;
}

/**
 * The Agent Team whose Sharing tab the hint links to: the team itself, or a
 * member's parent team — the same boundary the server resolves
 * (`resolveAgentTeam`). `null` for a standalone agent, which has no team to
 * join, so the hint is text only.
 */
export function chatShareTeamId(agent) {
  if (!agent) return null;
  if (agent.role === 'team') return agent.id || null;
  if (agent.role === 'team-member') return agent.parentTeamId || null;
  return null;
}

/** Where the hint's link goes: the team's own Sharing tab (the rail's "Share…"). */
export function chatShareHref(teamId) {
  return teamId ? `/chats/${encodeURIComponent(teamId)}?tab=sharing` : null;
}

/**
 * Everything the composer area needs, or `null` when the caller may write.
 * `{ text, shareHref }` — `shareHref` is `null` for an agent without a team.
 */
export function chatReadOnlyHint(agent) {
  if (!isChatReadOnly(agent)) return null;
  return { text: CHAT_READ_ONLY_HINT, shareHref: chatShareHref(chatShareTeamId(agent)) };
}
