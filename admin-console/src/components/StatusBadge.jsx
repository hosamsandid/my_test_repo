import React from 'react';

/**
 * StatusBadge — inline status indicator with coloured dot.
 *
 * Props:
 *   enabled — boolean (true = enabled/green, false = disabled/muted)
 *   label   — optional override label (defaults to "Enabled" / "Disabled")
 */
export default function StatusBadge({ enabled, label }) {
  const color = enabled ? 'var(--eb-status-success)' : 'var(--eb-text-muted)';
  const text = label ?? (enabled ? 'Enabled' : 'Disabled');
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)' }}>
      <span
        aria-hidden="true"
        style={{ width: 8, height: 8, borderRadius: '50%', background: color, flexShrink: 0 }}
      />
      <span style={{ color: enabled ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)' }}>
        {text}
      </span>
    </span>
  );
}
