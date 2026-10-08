// git-info-poll.js — when ChatPanel may start its git-info poll (#2923).
// Dependency-free so it runs under `node --test`; ChatPanel stays the thin shell.
//
// `GET /api/agents/:id/git-info` can take seconds on a cold cache (a real
// `git status` in a large workspace) and only feeds the About-this-chat repo
// rows, so it must never compete with the chat bootstrap: the poll arms only
// once the open room's history has been loaded (or failed), so the messages
// render first. An agent without a room that will not get one (disabled, so
// no DM is created) has no history to wait for and arms at once.

export const GIT_INFO_POLL_MS = 30_000;

export function gitInfoPollArmed({ agentId, agentEnabled, roomId, historyLoadedFor }) {
  if (!agentId) return false;
  if (roomId) return historyLoadedFor === roomId;
  return agentEnabled === false;
}
