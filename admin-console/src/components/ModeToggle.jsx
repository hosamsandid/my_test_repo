import React from 'react';

// ModeToggle — the shared "pick one of two modes" control for every
// generate-or-paste key form (My Credentials, the admin SSH Keys page). Two
// ordinary bordered buttons read as two independent actions ("do X" /
// "do Y"), which is misleading here: choosing
// either option only switches the form into that mode — nothing is generated
// or saved until the form's own primary submit button (further down, still
// the only solid/filled button) is pressed. Rendering the two options as one
// grouped, pill-shaped control with a raised active segment — plus the
// optional leading question — reads as "pick one of two modes" rather than
// "trigger an action" (#2165).

export default function ModeToggle({ value, onChange, options, question }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      {question && (
        <div style={{
          fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-secondary)',
        }}>
          {question}
        </div>
      )}
      <div
        role="radiogroup"
        aria-label={question || 'Mode'}
        style={{
          display: 'inline-flex',
          gap: 2,
          padding: 2,
          alignSelf: 'flex-start',
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 999,
        }}
      >
        {options.map(({ id, label, icon: Icon }) => {
          const active = value === id;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => onChange(id)}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: active ? 'var(--eb-bg-elevated)' : 'transparent',
                boxShadow: active ? 'var(--eb-shadow-sm)' : 'none',
                border: 'none',
                borderRadius: 999,
                color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
                cursor: 'pointer', fontFamily: 'inherit',
                transition: 'background 0.12s ease, box-shadow 0.12s ease, color 0.12s ease',
              }}
            >
              {Icon && <Icon size={13} />} {label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
