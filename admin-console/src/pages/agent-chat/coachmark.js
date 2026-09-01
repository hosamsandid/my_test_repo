// Pure logic for one-time, per-user "coachmark" hints (#1808).
//
// A coachmark is an onboarding tip shown to a user exactly ONCE and then never
// again — the first time it is helpful, every time after it is noise. The
// dismissal is remembered per user across sessions in localStorage under a
// per-username key (mirrors `agentChat.fontSize.<username>` /
// `assistModel.<username>` / `flows.lastSelected.<username>`), so two users on
// one shared browser never inherit each other's "seen" state and one user's
// dismissal follows them across reloads.
//
// This is a lightweight, purely client-side "seen" flag (not a server-side
// preference) — losing it on a cache clear just re-shows a one-line tip, which
// is harmless. Kept dependency-free and unit-tested (per the #651 convention)
// so it lands in the `admin-console-src` CI job; the JSX that renders the
// coachmark stays uncovered.

const STORAGE_PREFIX = 'agentChat.coachmark.';

// Stored id for the Sessions-panel cross-panel hover-correlation tip that used
// to be a permanent caption in the log panel body (#1808, pairs with UX-7).
export const HOVER_CORRELATION_COACHMARK = 'sessions-hover-correlation';

// The per-user localStorage key. A missing username (the env single-admin has
// no user record) falls back to a shared `anon` bucket, matching chat-font-size.
export function coachmarkKey(id, username) {
  return `${STORAGE_PREFIX}${id}.${username || 'anon'}`;
}

function resolveStore(store) {
  if (store) return store;
  return typeof window !== 'undefined' ? window.localStorage : null;
}

// Has this user already dismissed the coachmark? Any unreadable/absent value is
// treated as "not seen" so a fresh user (or a private-mode browser) sees the
// tip once. `store` defaults to window.localStorage but is injectable for tests.
export function hasSeenCoachmark(id, username, store) {
  const ls = resolveStore(store);
  if (!ls) return false;
  try {
    return ls.getItem(coachmarkKey(id, username)) === 'seen';
  } catch {
    return false;
  }
}

// Persist the dismissal (best-effort — a private-mode / quota failure is
// swallowed; the worst case is the tip re-shows next session).
export function markCoachmarkSeen(id, username, store) {
  const ls = resolveStore(store);
  if (!ls) return;
  try {
    ls.setItem(coachmarkKey(id, username), 'seen');
  } catch {
    /* ignore */
  }
}
