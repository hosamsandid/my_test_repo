// Pure formatting for the #502 chat-lock warning banner, kept separate from
// ChatPanel.jsx so it can be unit-tested without a DOM/React harness.

export function formatRemaining(totalSec) {
  const sec = Math.max(0, Math.round(totalSec));
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return m > 0 ? `${m}m ${String(s).padStart(2, '0')}s` : `${s}s`;
}

// Returns the banner text, or null when nothing should be shown.
export function maintenanceBannerText({ active, remainingSec } = {}) {
  if (!active) return null;
  return remainingSec > 0
    ? `Maintenance mode is active — sending new messages is disabled. Remaining time: ${formatRemaining(remainingSec)}.`
    : 'Maintenance mode is active — sending new messages is disabled.';
}
