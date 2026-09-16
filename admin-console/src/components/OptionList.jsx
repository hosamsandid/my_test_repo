import React from 'react';

// Shared scrollable list frame behind Skills and Plugins (#2269) — the same
// bordered, capped-height container Skills always had, now also wrapping
// Plugins so the two surfaces read as one pattern instead of two.
export default function OptionList({ children, maxHeight = 260 }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--eb-space-1)',
        maxHeight,
        overflowY: 'auto',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-2)',
        background: 'var(--eb-bg-elevated)',
      }}
    >
      {children}
    </div>
  );
}
