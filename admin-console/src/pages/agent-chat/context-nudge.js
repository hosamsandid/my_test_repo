// context-nudge.js — pure view-model for the actionable context-fill nudge
// (#2382). Turns the shared fill `level` (from `computeContextFillLevel` in
// context-window.js — the single source of truth for the 50% / 75% boundaries)
// into the nudge the *interactive* Agent Chat shows:
//
//   level 'warning'  (>= 50% and < 75%) → a DISMISSIBLE hint ('hint')
//   level 'critical' (>= 75%)           → a PERMANENT, non-dismissible reset
//                                          warning ('warning'), regardless of any
//                                          earlier dismissal of the 50% hint
//   level 'normal' / null                → nothing ('none')
//
// Dependency-free so it runs under `node --test` in the admin-console-src CI job;
// the JSX shell (ChatPanel banners) stays a thin adapter over this.
//
// Design notes tied to the acceptance criteria:
//  - AC4/AC7: the critical warning ignores `dismissed` entirely — dismissing the
//    50% hint never suppresses the 75% warning when the session later crosses it.
//  - AC9: when the model context window is unknown, the caller passes a null
//    `level` (no percentage can be computed) → 'none', exactly as the passive
//    indicator hides itself today.
//  - AC10: `interactive` is false for an autonomous/triggered run in view → no
//    nudge; the nudge is only ever an interactive-chat affordance.
//  - Edge case: a very small session (< 1000 used tokens) never nudges, even if a
//    hypothetically tiny window would put it over 50% — mirrors the "0K" floor
//    the header indicator already uses.

const MIN_TOKENS_FOR_NUDGE = 1000;

export function computeContextNudge({
  level,
  usedTokens,
  interactive = true,
  dismissed = false,
} = {}) {
  if (!interactive) return { kind: 'none' };
  if (typeof usedTokens === 'number' && usedTokens < MIN_TOKENS_FOR_NUDGE) {
    return { kind: 'none' };
  }
  if (level === 'critical') return { kind: 'warning' };
  if (level === 'warning') return dismissed ? { kind: 'none' } : { kind: 'hint' };
  return { kind: 'none' };
}

// localStorage key for the per-room "the 50% hint was dismissed for session S"
// record (Q1: the dismissal persists for the session, including across page
// reloads). The stored value is the dismissed session id; the hint is suppressed
// only while the live session id still matches it, so a session reset (which
// mints a new id) automatically re-enables the hint (AC6) without a separate
// clear step.
export function nudgeDismissStorageKey(roomId) {
  return roomId ? `aee-ctx-nudge-dismissed:${roomId}` : null;
}

// Whether the 50% hint should be treated as dismissed: a non-null session id
// that equals the id recorded as dismissed. A null/absent session id is never
// "dismissed" (nothing to match), so a fresh session shows the hint again.
export function isNudgeDismissed(dismissedSessionId, currentSessionId) {
  return (
    currentSessionId != null &&
    dismissedSessionId != null &&
    dismissedSessionId === currentSessionId
  );
}
