// Pure helpers for the "Resume a finished session" affordance (#574).
//
// A finished session in the Sessions tab can be reopened: we re-point the
// room's current-session pointer at its Claude session-ID and send a fixed,
// neutral predefined message so the agent runs with `--resume` and continues
// in context. The rules for *when* the control is offered and *whether* a
// confirmation is required are pure functions here, so they are unit-testable
// without the JSX; SessionsPanel/ChatPanel do the IO.

// The predefined resume message (Open Question C → fixed, short, neutral).
// Kept intentionally plain so it reads naturally in the chat history (AC5) and
// nudges the agent to re-orient itself in the resumed context.
export const RESUME_MESSAGE =
  'Resuming this session — please pick up where we left off and briefly summarize where we stand.';

// A finished session is resumable only when it is a DM session that observed a
// real Claude session-ID (Open Question A → DM only; per-invocation triggered
// runs deliberately don't persist a pointer, so they carry no resumable id; a
// pool instance's triggered runs continue its DM session instead, #2595).
// Fallback entries with no session-ID (early-error runs, correlationId-keyed —
// see session-history.js) can't be resumed.
export function canResumeSession(session) {
  return !!(
    session &&
    session.type === 'dm' &&
    typeof session.sessionId === 'string' &&
    session.sessionId
  );
}

// Whether activating Resume needs a confirmation first (Open Question B →
// overwrite the single per-room pointer WITH a confirmation when a healthy
// session is already active in the room). No active session ⇒ resume freely.
export function resumeNeedsConfirm(activeSessions) {
  return Array.isArray(activeSessions) && activeSessions.length > 0;
}
