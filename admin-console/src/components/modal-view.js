// Pure decision helpers for the reusable Modal shell (#651 — logic lives in a
// React-free module so it is node:test-covered; Modal.jsx stays a thin renderer).
//
// Two concerns live here: cycling keyboard focus so Tab / Shift+Tab never escape
// an open modal (a focus trap), and deciding when a backdrop press dismisses.

// Natural Tab stops inside a dialog. A roving-tabindex widget (e.g.
// SettingsModal's section rail) gives its non-selected buttons tabIndex=-1;
// those match `button` but are NOT reachable by forward Tab, so counting them
// would put the "last focusable" past the real final tab stop and let Tab
// escape the dialog. Every arm therefore excludes [tabindex="-1"]. Shared by
// Modal and SidePanel (#2960).
export const FOCUSABLE_SELECTOR = 'a[href]:not([tabindex="-1"]), button:not([disabled]):not([tabindex="-1"]), textarea:not([disabled]):not([tabindex="-1"]), input:not([disabled]):not([tabindex="-1"]), select:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

// Given the index of the currently-focused element within the modal's ordered
// list of focusables (or -1 when focus is outside the list), decide where Tab /
// Shift+Tab should send focus so it stays trapped inside the modal:
//   - forward Tab off the LAST element (or from outside) wraps to the first;
//   - backward Shift+Tab off the FIRST element (or from outside) wraps to the last;
//   - any other move returns null → let the browser's default Tab handle it.
// Returns the target index to force focus to, or null to allow the default.
export function focusTrapTarget(activeIndex, count, backwards) {
  if (!Number.isInteger(count) || count <= 0) return null;
  if (backwards) {
    return activeIndex <= 0 ? count - 1 : null;
  }
  return (activeIndex === -1 || activeIndex >= count - 1) ? 0 : null;
}

// A backdrop click dismisses only when the press BOTH started and ended on the
// dimmed overlay itself — so a text-selection drag that begins inside the card
// and releases on the backdrop does not count as a dismiss (mirrors the
// ConfirmDialog gesture guard).
export function backdropDismisses(pressedOverlay, releasedOverlay) {
  return !!pressedOverlay && !!releasedOverlay;
}
