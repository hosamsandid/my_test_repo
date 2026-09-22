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
// A candidate must, between the two polls: (a) have been `busy`, (b) now be a
// live non-busy state (NOT busy/disabled/offline — a run that ends offline/errored
// with no user-facing response never qualifies), (c) carry a lastResponseAt that
// advanced (a genuine new response, not a session reset), and (d) be an agent
// the user manually messaged. The busy→done edge already suppresses most
// flapping; exact-turn dedupe (selectUnnotified) covers the rest.
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
    if (!set.has(next.id)) continue;               // (d) manually messaged only
    const prev = prevById.get(next.id);
    if (!prev) continue;                            // no baseline — never fire on first sight
    if (prev.activityState !== 'busy') continue;    // (a) must have been busy
    const st = next.activityState;
    if (st === 'busy' || st === 'disabled' || st === 'offline') continue; // (b) live completion
    const prevAt = toMillis(prev.lastResponseAt);
    const nextAt = toMillis(next.lastResponseAt);
    if (!nextAt || nextAt <= prevAt) continue;      // (c) genuine new response
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
