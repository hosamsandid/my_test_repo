/**
 * Pure per-agent composer draft persistence for the Agent Chat composer (#1388).
 *
 * `AgentChat.jsx` renders `ChatPanel` (and its `MessageInput`) with
 * `key={selectedAgent.id}`, so switching agents fully remounts the composer and
 * the local `value` state is destroyed — the typed draft was silently lost.
 * This module persists the draft per agent so it survives an agent switch (and,
 * as a bonus, a page reload) under a `localStorage` key.
 *
 * Convention (AC6): the key is NOT per-username — it follows the same
 * per-browser `agentChat.*` shape as `agentChat.workspaceMode` /
 * `agentChat.sendKeybinding` / `agentChat.sidebarOrder`, unlike the per-user
 * `flows.lastSelected.<username>` / `assistModel.<username>` keys.
 *
 * All logic lives here (dependency-free) so it lands in the `admin-console-src`
 * CI job under `node --test`; the JSX composer stays uncovered per the #651
 * convention (mirrors message-send-keybinding.js / agent-list-dnd.js).
 */

export const DRAFT_KEY_PREFIX = 'agentChat.draft.';

/** The localStorage key for one agent's composer draft. */
export function draftKey(agentId) {
  return `${DRAFT_KEY_PREFIX}${agentId}`;
}

/**
 * Load the persisted draft for an agent. Returns '' when there is no agentId,
 * no stored draft, or the store is unavailable — so the composer falls back to
 * its normal empty placeholder (AC4).
 */
export function loadDraft(agentId, store = typeof localStorage !== 'undefined' ? localStorage : undefined) {
  if (!agentId) return '';
  try {
    return store?.getItem(draftKey(agentId)) ?? '';
  } catch {
    return '';
  }
}

/**
 * Persist (or clear) the draft for an agent. An empty / whitespace-only draft
 * is never stored — the key is removed instead, so an emptied composer leaves
 * no `agentChat.draft.<id>` entry behind (AC4) and the store doesn't grow with
 * blank drafts. Best-effort: storage failures (quota, private mode) are ignored.
 */
export function saveDraft(agentId, value, store = typeof localStorage !== 'undefined' ? localStorage : undefined) {
  if (!agentId) return;
  try {
    if (value && value.trim()) {
      store?.setItem(draftKey(agentId), value);
    } else {
      store?.removeItem(draftKey(agentId));
    }
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/** Remove an agent's persisted draft (used after a successful send — AC2). */
export function clearDraft(agentId, store = typeof localStorage !== 'undefined' ? localStorage : undefined) {
  if (!agentId) return;
  try {
    store?.removeItem(draftKey(agentId));
  } catch {
    /* ignore */
  }
}

/**
 * The composer value after a send was refused (#2721 AC5 — e.g. the user's chat
 * identity is not ready yet): the unsent text comes back, unless the user has
 * already started typing something new, which is never overwritten.
 */
export function restoreUnsentText(current, unsent) {
  return current && current.trim() ? current : (unsent || current || '');
}
