import React from 'react';

// Small reusable pill for a feature that is deliberately visible-but-disabled
// (#2302's agent-pools gate is the first user) — the surface stays in place
// so it isn't forgotten, this just labels why it doesn't respond right now.
export default function ComingSoonBadge({ title }) {
  return (
    <span
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center',
        padding: '2px var(--eb-space-2)', borderRadius: 'var(--eb-radius-full)',
        border: '1px solid var(--eb-border-default)', background: 'var(--eb-bg-surface)',
        color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-xs)',
        fontFamily: 'var(--eb-font-sans)', lineHeight: 1.4, whiteSpace: 'nowrap',
        userSelect: 'none',
      }}
    >
      Coming Soon
    </span>
  );
}
