// Pure decision helpers for the shared SidePanel slide-in dialog (#2960, #651 —
// logic lives in a React-free module so it is node:test-covered; SidePanel.jsx
// stays a thin renderer).
//
// SidePanel dims the page behind it, so it must behave as a modal for keyboard
// users: focus moves in on open, Tab / Shift+Tab cycle inside it, and focus
// returns to the opener on close. The Tab cycling itself reuses the Modal
// focus-trap rule (focusTrapTarget in modal-view.js); this module decides WHEN
// a panel may act on a key press and WHERE initial focus goes.

// ── Open-panel stack ──────────────────────────────────────────────────────
// Panels can stack (a panel opened from another panel). Only the most recently
// opened one owns the keyboard, so two traps never fight over one Tab press.
const openPanels = [];

export function pushOpenPanel(token) {
  openPanels.push(token);
}

export function removeOpenPanel(token) {
  const i = openPanels.lastIndexOf(token);
  if (i !== -1) openPanels.splice(i, 1);
}

export function isTopPanel(token) {
  return openPanels.length > 0 && openPanels[openPanels.length - 1] === token;
}

// ── Tab handling ──────────────────────────────────────────────────────────
// Decide what an open panel does with a Tab press, given where focus is:
//   'trap'   — focus is inside the panel: cycle it with focusTrapTarget;
//   'pull'   — focus escaped to the dimmed page behind the panel (or to
//              <body>): bring it back inside;
//   'ignore' — not ours to handle: a panel stacked above owns the keyboard,
//              focus is in another dialog layered over the panel (e.g. a
//              ConfirmDialog), or in a portaled popover outside the app root.
export function panelTabAction({ isTop, inPanel, inOtherDialog, inAppRoot, onBody }) {
  if (!isTop) return 'ignore';
  if (inOtherDialog) return 'ignore';
  if (inPanel) return 'trap';
  if (onBody || inAppRoot) return 'pull';
  return 'ignore';
}

// ── Initial focus ─────────────────────────────────────────────────────────
// Where focus goes when the panel opens (AC1):
//   'keep'  — a consumer already focused something inside (e.g. autoFocus);
//   'body'  — the first focusable field of the panel body;
//   'close' — the close button, when the body has nothing focusable.
export function initialFocusTarget({ activeInPanel, bodyFocusableCount }) {
  if (activeInPanel) return 'keep';
  return bodyFocusableCount > 0 ? 'body' : 'close';
}

// Restore focus to the opener on close only if it is still in the document and
// focusable (AC3 — "if it still exists").
export function canRestoreFocus(el) {
  return !!el && el.isConnected === true && typeof el.focus === 'function';
}
