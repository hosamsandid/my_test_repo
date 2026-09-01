// Pure logic for the per-user Agent-Chat transcript font size (#1437).
//
// The transcript used to render at a fixed 14px; the new baseline is 12px and
// each user can nudge it with a +/- control in the chat toolbar. The chosen
// size is persisted on the user's own profile record server-side (so it follows
// them across browsers, devices and screen resolutions and never leaks into
// another user's view — see PUT /api/me/preferences + describeAuthz). A
// per-username localStorage mirror gives an instant optimistic apply and is the
// fallback store for principals with no server record (the env single-admin).
//
// Kept dependency-free and unit-tested (per the #651 convention) so it lands in
// the `admin-console-src` CI job; the JSX in ChatPanel stays uncovered.

export const MIN_FONT_SIZE = 10;
export const MAX_FONT_SIZE = 18;
export const DEFAULT_FONT_SIZE = 12;
export const FONT_SIZE_STEP = 1;

// localStorage keys are per-username (mirrors `assistModel.<username>` and
// `flows.lastSelected.<username>`), so two users on one shared browser never
// inherit each other's size.
const STORAGE_PREFIX = 'agentChat.fontSize.';

// Coerce an arbitrary value to a valid integer px size in [MIN,MAX]. Non-finite
// / non-integer / out-of-range input falls back to the 12px default (a stored
// value that predates a range change is clamped rather than rejected).
export function clampFontSize(value) {
  // Number(null) / Number('') coerce to 0, so treat empty input as "unset".
  if (value === null || value === undefined || value === '') return DEFAULT_FONT_SIZE;
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_FONT_SIZE;
  const rounded = Math.round(n);
  if (rounded < MIN_FONT_SIZE) return MIN_FONT_SIZE;
  if (rounded > MAX_FONT_SIZE) return MAX_FONT_SIZE;
  return rounded;
}

// Apply a +/- step (delta in px) and clamp to the allowed range.
export function stepFontSize(current, delta) {
  return clampFontSize(clampFontSize(current) + delta);
}

export function canIncrease(size) {
  return clampFontSize(size) < MAX_FONT_SIZE;
}

export function canDecrease(size) {
  return clampFontSize(size) > MIN_FONT_SIZE;
}

// Decide the size to start from. A user WITH a server record trusts the
// server-surfaced session value (authoritative across devices); a principal
// WITHOUT one (env single-admin — the session always reports the default) falls
// back to their local per-browser value first.
export function resolveInitialFontSize({ sessionValue, storedValue, hasServerRecord }) {
  if (hasServerRecord && Number.isFinite(Number(sessionValue))) {
    return clampFontSize(sessionValue);
  }
  if (Number.isFinite(Number(storedValue)) && storedValue !== null && storedValue !== '') {
    return clampFontSize(storedValue);
  }
  if (Number.isFinite(Number(sessionValue))) {
    return clampFontSize(sessionValue);
  }
  return DEFAULT_FONT_SIZE;
}

export function storageKey(username) {
  return STORAGE_PREFIX + (username || 'anon');
}

// Read the per-username stored size. Returns null when unset/unreadable so the
// caller can fall through to the session/default. `store` defaults to
// window.localStorage but is injectable for tests.
export function loadStoredFontSize(username, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return null;
  try {
    const raw = ls.getItem(storageKey(username));
    if (raw === null || raw === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? clampFontSize(n) : null;
  } catch {
    return null;
  }
}

// Persist the per-username stored size (best-effort — a private-mode / quota
// failure is swallowed, the server record remains the source of truth).
export function saveStoredFontSize(username, size, store) {
  const ls = store || (typeof window !== 'undefined' ? window.localStorage : null);
  if (!ls) return;
  try {
    ls.setItem(storageKey(username), String(clampFontSize(size)));
  } catch {
    /* ignore */
  }
}

// Cross-component notification: SettingsModal's Display section dispatches this
// when the user changes the font size so the active ChatPanel can update its
// own state and re-apply the CSS var without a remount or a shared context.
// Mirrors the SEND_KEYBINDING_CHANGED_EVENT pattern in message-send-keybinding.js.
export const FONT_SIZE_CHANGED_EVENT = 'aee:chatfontsize';

export function notifyFontSizeChanged(size) {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent(FONT_SIZE_CHANGED_EVENT, { detail: { size } }));
  }
}
