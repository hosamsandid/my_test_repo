// Pure, React-free decision for the composer's primary action button (#1427).
//
// The Agent-Chat composer's primary action is normally **Send**. While the
// selected agent is busy on a chat-initiated turn (or a launched loop), that
// same button becomes a single unified **Stop** control — "stop whatever is
// running for this agent" — instead of a second, separate stop affordance.
//
// This module owns *only* the mode/enabled decision so it can be unit-tested
// without a DOM (the JSX in MessageInput.jsx stays a thin renderer, per the
// repo's #651 pure-core convention). MessageInput passes the live flags in and
// renders Send vs Stop from the returned `mode`.
//
// Inputs:
//   busy     — the agent is working on a chat turn or a running loop (either
//              of which the unified Stop control aborts).
//   canStop  — a stop handler is wired (composer is mounted somewhere that can
//              actually abort). When false we never show Stop, even if busy.
//   hasText  — the trimmed composer value is non-empty (gates Send only).
//   disabled — the composer is disabled (no room, sending, maintenance, …);
//              gates Send only. Stop deliberately ignores this so a turn can be
//              aborted even while the textarea itself is disabled.
//   stopBusy — a stop request is already in flight (gates Stop only), so a
//              double-press can't fire two aborts.
//   uploading — an attachment upload is still in flight (gates Send only,
//              #2567 AC11): the draft must not leave before its references
//              are in it.
//
// Returns { mode: 'send' | 'stop', enabled: boolean }.
export function decideComposerAction({ busy, canStop, hasText, disabled, stopBusy, uploading } = {}) {
  if (busy && canStop) {
    // Stop mode: enabled unless an abort is already running. Independent of the
    // composer's `disabled` state — the whole point is to abort mid-turn, when
    // the textarea is typically disabled.
    return { mode: 'stop', enabled: !stopBusy };
  }
  // Send mode (idle): the historic behaviour — enabled only with text and an
  // enabled composer, and never while an attachment is still uploading.
  return { mode: 'send', enabled: !disabled && !!hasText && !uploading };
}
