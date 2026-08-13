// Pure decision helpers for ConfirmDialog's dismissal affordances (#651 — logic
// lives in a React-free module so it is node:test-covered; ConfirmDialog.jsx
// stays a thin renderer).
//
// Two ways to dismiss a modal that new users reach for instinctively — pressing
// Escape and clicking the dimmed backdrop outside the card — resolve to the same
// "safe dismiss" action here, so both entry points behave identically.

// The safe-dismiss handler for a dialog:
//   - a confirmation dismisses as a CANCEL (the non-destructive default), so
//     clicking away from a "Delete?" prompt never performs the deletion;
//   - an alert (alertOnly, OK-only) dismisses as an ACKNOWLEDGE (its OK button
//     is wired to onConfirm), so an alert can finally be closed with Escape /
//     backdrop too — previously it could only be closed via the OK button.
// Falls back gracefully (and returns null) when the relevant handler is absent,
// so a caller that wires only one of the two is never called with undefined.
export function resolveDismissHandler({ alertOnly = false, onConfirm, onCancel } = {}) {
  if (alertOnly) return onConfirm || onCancel || null;
  return onCancel || null;
}

// Whether a backdrop pointer interaction should dismiss the dialog. It dismisses
// only when the press STARTED and ENDED on the overlay itself (never bubbling up
// from the card — so a text selection that begins inside the message and ends
// out on the backdrop does not close it), and only while no async action is in
// flight (`busy` disables the buttons, so the backdrop must not bypass that).
export function backdropDismisses({ pressedOverlay = false, releasedOverlay = false, busy = false } = {}) {
  return !!pressedOverlay && !!releasedOverlay && !busy;
}

// Whether an Escape keypress should dismiss. Mirrors the backdrop's `busy`
// guard so neither pointer nor keyboard can dismiss a dialog mid-action.
export function escapeDismisses({ busy = false } = {}) {
  return !busy;
}
