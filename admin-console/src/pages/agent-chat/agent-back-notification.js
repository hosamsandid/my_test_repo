// Pure logic for the opt-in "an agent you messaged is back" browser
// notification (#2397).
//
// When the per-user setting is on and the console tab is not the focused/visible
// tab, an agent the current user *manually messaged* completing its turn pops a
// browser notification that pulls the user back. The feature is off by default
// and, once on, only fires when the browser has granted permission.
//
// This module owns the deterministic parts — the per-user preference store, the
// permission-API wrappers (injected so they unit-test), the busy→done turn
// detection over the shared /api/agents/statuses payload, and the per-turn
// dedupe — so the provider JSX stays thin. Kept dependency-free and unit-tested
// (admin-console-src CI job) per the #651 convention.

// ── Per-user preference (localStorage mirror) ────────────────────────────────
//
// The authoritative store is the user's server profile record
// (`chatNotifyOnBack`, surfaced on the session by describeAuthz); a per-username
// localStorage mirror gives an instant optimistic apply and is the fallback for
// principals with no server record (the env single-admin). Mirrors
// chat-font-size.js exactly. The feature is OFF by default.
const STORAGE_PREFIX = 'agentChat.notifyOnBack.';

export function notifyStorageKey(username) {
  return STORAGE_PREFIX + (username || 'anon');
}

// Read the per-username stored flag. Returns true/false, or null when unset /
// unreadable so the caller can fall through to the session value / default.
// `store` defaults to window.localStorage but is injectable for tests.
export function loadStoredNotifyEnabled(username, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return null;
  try {
    const raw = ls.getItem(notifyStorageKey(username));
    if (raw === null || raw === '') return null;
    return raw === 'true';
  } catch {
    return null;
  }
}

// Persist the per-username stored flag (best-effort — a private-mode / quota
// failure is swallowed, the server record remains the source of truth).
export function saveStoredNotifyEnabled(username, enabled, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return;
  try {
    ls.setItem(notifyStorageKey(username), enabled ? 'true' : 'false');
  } catch {
    /* ignore */
  }
}

// Decide the initial enabled state. A user WITH a server record trusts the
// server-surfaced session value (authoritative across devices); a principal
// WITHOUT one (env single-admin — the session always reports the off default)
// falls back to their local per-browser value first. Default OFF.
export function resolveInitialNotifyEnabled({ sessionValue, storedValue, hasServerRecord } = {}) {
  if (hasServerRecord && typeof sessionValue === 'boolean') {
    return sessionValue;
  }
  if (typeof storedValue === 'boolean') {
    return storedValue;
  }
  if (typeof sessionValue === 'boolean') {
    return sessionValue;
  }
  return false;
}

// ── Manually-messaged agents (persisted signal) ──────────────────────────────
//
// The set of agents the current user *manually messaged* (populated only from
// the chat composer's send path, never by an auto-triggered run). #2397 keeps it
// in-memory for the "agent is back" notification; #2429 reuses the same signal to
// drive the status dot's solid-vs-hollow green (a solid dot = a reply awaiting
// you, hollow = auto-triggered activity you can glance at). For the dots the
// signal must survive a reload — otherwise a genuine "awaiting you" reply would
// silently downgrade to hollow after refresh (#2429 open question 1) — so it is
// mirrored to localStorage here, alongside the in-memory ref the notification
// still uses. Global (browser-scoped) key, like `agentChat.lastViewed`: the
// console treats a browser as one operator, and both dots and the viewed map
// already read that way.
export const MANUALLY_MESSAGED_KEY = 'agentChat.manuallyMessaged';

// Read the persisted manually-messaged ids as a plain array (deduped, string
// ids). Returns [] on any read/parse failure. `store` is injectable for tests.
export function loadManuallyMessagedIds(store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return [];
  try {
    const raw = ls.getItem(MANUALLY_MESSAGED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(id => typeof id === 'string' && id);
  } catch {
    return [];
  }
}

// Add one id to the persisted manually-messaged set (best-effort — a private
// mode / quota failure is swallowed). Idempotent; preserves insertion order.
export function addManuallyMessagedId(id, store) {
  if (!id) return;
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return;
  try {
    const current = loadManuallyMessagedIds(ls);
    if (current.includes(id)) return;
    current.push(id);
    ls.setItem(MANUALLY_MESSAGED_KEY, JSON.stringify(current));
  } catch {
    /* ignore */
  }
}

// Cross-component notification: SettingsModal dispatches this when the user
// flips the setting so the app-level provider updates its own state and starts
// / stops firing without a reload (AC10). Mirrors FONT_SIZE_CHANGED_EVENT.
export const NOTIFY_SETTING_CHANGED_EVENT = 'aee:notifyonback';

export function notifyNotifySettingChanged(enabled) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent(NOTIFY_SETTING_CHANGED_EVENT, { detail: { enabled: !!enabled } }),
    );
  }
}

// ── Browser Notifications API wrappers ───────────────────────────────────────
//
// Thin, injectable wrappers so callers never touch `window.Notification`
// directly (and tests can pass a stub). `win` defaults to the global window.

function resolveWin(win) {
  if (win) return win;
  return typeof window !== 'undefined' ? window : null;
}

export function notificationsSupported(win) {
  const w = resolveWin(win);
  return !!(w && typeof w.Notification !== 'undefined');
}

// 'granted' | 'denied' | 'default' | 'unsupported'.
export function getNotificationPermission(win) {
  const w = resolveWin(win);
  if (!notificationsSupported(w)) return 'unsupported';
  return w.Notification.permission;
}

// Ask the browser for permission. Resolves to the resulting permission string
// ('unsupported' when the API is absent). Tolerates both the modern
// promise-returning form and the legacy callback form.
export function requestNotificationPermission(win) {
  const w = resolveWin(win);
  if (!notificationsSupported(w)) return Promise.resolve('unsupported');
  try {
    const ret = w.Notification.requestPermission((result) => result);
    if (ret && typeof ret.then === 'function') return ret;
    return Promise.resolve(w.Notification.permission);
  } catch {
    return Promise.resolve(w.Notification.permission || 'default');
  }
}

// ── "Is the user looking at us?" gate ────────────────────────────────────────
//
// The notification must only fire while the console is NOT the surface the user
// is actively looking at. #2397 gated on `visibilityState === 'visible'` alone,
// but visibilityState only flips to `hidden` when the tab is switched away from,
// minimized, or fully occluded — NOT when the browser window merely loses OS
// focus while staying on-screen (a second monitor, or alt-tabbing to another app
// with the browser still visible). That's the most common real "I'm not looking
// at this" case (#2409 candidate #1), so we also require the document to hold OS
// focus. The console counts as foreground only when it is BOTH the visible tab
// AND the focused window; anything else means the user is away and may be
// notified. `doc` is injectable for tests.
export function isConsoleInForeground(doc) {
  const d = doc || (typeof document !== 'undefined' ? document : null);
  if (!d) return false;
  // Treat a missing visibilityState/hasFocus as "true" so an environment that
  // lacks one signal falls back to the other rather than never suppressing.
  const visible = d.visibilityState ? d.visibilityState === 'visible' : true;
  if (!visible) return false;
  const focused = typeof d.hasFocus === 'function' ? d.hasFocus() : true;
  return visible && focused;
}

// ── Turn-completion detection ────────────────────────────────────────────────

function toMillis(v) {
  if (v == null) return 0;
  const n = typeof v === 'number' ? v : new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
}

// Given the previous and next /api/agents/statuses lists and the set of agent
// ids the current user manually messaged this page/session, return the agents
// whose turn just completed and should be notified about.
//
// A candidate must, between the two polls: (a) now be a live non-busy state (NOT
// busy/disabled/offline — a run that ends offline/errored with no user-facing
// response never qualifies), (b) carry a lastResponseAt that advanced (a genuine
// new response since we last saw the agent, not a session reset), and (c) be an
// agent the user manually messaged. Exact-turn dedupe (selectUnnotified) covers
// any flapping.
//
// #2409 candidate #2: we deliberately do NOT require the *immediately preceding*
// poll to have caught `activityState === 'busy'`. Background tabs throttle the
// status poll (Chrome ~1/min after a few minutes hidden), so a whole busy→done
// turn can complete between two coarse polls and the transient busy sample is
// never observed. Anchoring on "lastResponseAt advanced while the agent is now
// idle" instead of on the fragile busy edge still catches that completion on the
// next poll, however coarse — which is exactly the case the feature exists for.
export function computeBackNotifications(prevList, nextList, { manuallyMessaged } = {}) {
  const out = [];
  if (!Array.isArray(prevList) || !Array.isArray(nextList)) return out;
  const set = manuallyMessaged instanceof Set
    ? manuallyMessaged
    : new Set(Array.isArray(manuallyMessaged) ? manuallyMessaged : []);
  if (set.size === 0) return out;

  const prevById = new Map();
  for (const a of prevList) {
    if (a && a.id != null) prevById.set(a.id, a);
  }

  for (const next of nextList) {
    if (!next || next.id == null) continue;
    if (!set.has(next.id)) continue;               // (c) manually messaged only
    const prev = prevById.get(next.id);
    if (!prev) continue;                            // no baseline — never fire on first sight
    const st = next.activityState;
    if (st === 'busy' || st === 'disabled' || st === 'offline') continue; // (a) live completion
    const prevAt = toMillis(prev.lastResponseAt);
    const nextAt = toMillis(next.lastResponseAt);
    if (!nextAt || nextAt <= prevAt) continue;      // (b) genuine new response since last seen
    out.push({
      id: next.id,
      displayName: next.displayName || next.id,
      lastResponseAt: next.lastResponseAt,
    });
  }
  return out;
}

// Dedupe candidates against the turns already notified (id -> turn key). One
// notification per completed turn per agent (AC9), robust to rapid busy↔done
// flapping that re-surfaces the same lastResponseAt. Returns the subset to fire
// plus the updated notified map (pure — the caller owns the ref).
export function selectUnnotified(candidates, notified) {
  const seen = notified && typeof notified === 'object' ? notified : {};
  const nextMap = { ...seen };
  const toFire = [];
  for (const c of candidates || []) {
    if (!c || c.id == null) continue;
    const key = String(c.lastResponseAt);
    if (seen[c.id] === key) continue;
    nextMap[c.id] = key;
    toFire.push(c);
  }
  return { toFire, notified: nextMap };
}

// Notification title — agent display name only, no message body (AC2).
export function notificationTitleFor(displayName) {
  const name = (typeof displayName === 'string' && displayName.trim()) ? displayName.trim() : 'Agent';
  return `${name} is back`;
}

// Stable tag so a newer turn for the same agent replaces an older popup rather
// than stacking (helps the one-per-agent feel of AC9).
export function notificationTagFor(id) {
  return `aee-agent-back-${id}`;
}
