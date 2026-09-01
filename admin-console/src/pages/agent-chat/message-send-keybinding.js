/**
 * Pure send-keybinding logic for the Agent Chat composer (#1354).
 *
 * The composer's Enter behaviour is user-configurable via a per-user setting
 * `agentChat.sendKeybinding` with two presets:
 *
 *   - 'ide'  (default): Cmd/Ctrl + Enter sends; plain Enter inserts a newline.
 *                       Safer for multi-line prompts (the historic behaviour).
 *   - 'chat'          : plain Enter sends; Shift + Enter inserts a newline.
 *                       Matches Slack / Teams / WhatsApp muscle memory.
 *
 * All decision logic lives here (dependency-free) so it lands in the
 * `admin-console-src` CI job under `node --test`; the JSX composer stays
 * uncovered per the #651 convention (mirrors agent-list-dnd.js).
 */

export const SEND_KEYBINDINGS = ['ide', 'chat'];
export const DEFAULT_SEND_KEYBINDING = 'ide';
export const SEND_KEYBINDING_KEY = 'agentChat.sendKeybinding';

/** Coerce any stored/legacy value to a known preset (default 'ide'). */
export function normalizeSendKeybinding(value) {
  return SEND_KEYBINDINGS.includes(value) ? value : DEFAULT_SEND_KEYBINDING;
}

/**
 * True when the current platform is macOS-like. Reused OS idiom from
 * RightRail.jsx — Cmd on Mac, Ctrl everywhere else. Accepts an injected
 * `nav` for testing; defaults to the ambient `navigator`.
 */
export function isMacPlatform(nav = typeof navigator !== 'undefined' ? navigator : undefined) {
  if (!nav) return false;
  return /Mac|iP(?:hone|ad|od)/i.test(nav.platform || nav.userAgent || '');
}

/** Load the persisted preset from localStorage; falls back to the default. */
export function loadSendKeybinding(store = typeof localStorage !== 'undefined' ? localStorage : undefined) {
  try {
    return normalizeSendKeybinding(store?.getItem(SEND_KEYBINDING_KEY));
  } catch {
    return DEFAULT_SEND_KEYBINDING;
  }
}

/** Persist the preset to localStorage (best-effort). */
export function saveSendKeybinding(value, store = typeof localStorage !== 'undefined' ? localStorage : undefined) {
  try {
    store?.setItem(SEND_KEYBINDING_KEY, normalizeSendKeybinding(value));
  } catch {
    /* ignore — persistence is best-effort */
  }
}

/**
 * Decide what an Enter keypress should do, given the active preset.
 *
 * Returns one of:
 *   - 'send'    : the caller should preventDefault() and submit
 *   - 'newline' : let the textarea insert a newline (the browser default)
 *   - 'ignore'  : not an Enter accelerator — do nothing special
 *
 * IME composition is never treated as a send: an Enter that commits a
 * Japanese/Chinese/Korean candidate must reach the textarea untouched. The
 * caller passes the same guards it already tracks (`composing`, `isComposing`,
 * `keyCode === 229`).
 *
 * @param {{key?:string, metaKey?:boolean, ctrlKey?:boolean, shiftKey?:boolean,
 *          isComposing?:boolean, keyCode?:number}} e
 * @param {string} keybinding  'ide' | 'chat'
 * @param {boolean} [composing] external IME-composition flag (composingRef)
 */
export function decideSendKey(e, keybinding, composing = false) {
  if (!e || e.key !== 'Enter') return 'ignore';
  if (composing || e.isComposing || e.keyCode === 229) return 'ignore';

  const mod = !!(e.metaKey || e.ctrlKey);

  if (normalizeSendKeybinding(keybinding) === 'chat') {
    // Chat style: plain Enter sends, Shift+Enter is a newline. Cmd/Ctrl+Enter
    // also sends (harmless superset — the modifier never inserts a newline).
    if (e.shiftKey) return 'newline';
    return 'send';
  }

  // IDE style (default): only Cmd/Ctrl+Enter sends; everything else is a newline.
  return mod ? 'send' : 'ignore';
}

/**
 * The modifier-key glyph/word for the send shortcut on this platform.
 * Mac → '⌘', otherwise → 'Ctrl'.
 */
export function sendModifierLabel(isMac) {
  return isMac ? '⌘' : 'Ctrl';
}

/**
 * Compact hint shown inside the placeholder, e.g. '⌘↩ to send' (Mac, IDE),
 * 'Ctrl+↩ to send' (Windows, IDE) or '↩ to send' (chat style).
 */
export function placeholderSendHint(keybinding, isMac) {
  if (normalizeSendKeybinding(keybinding) === 'chat') return '↩ to send';
  return isMac ? '⌘↩ to send' : 'Ctrl+↩ to send';
}
