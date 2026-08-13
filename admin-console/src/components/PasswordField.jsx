import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { passwordInputType, revealToggleLabel } from './password-field-view.js';

// Masked password input with an inline show/hide reveal toggle — the eye icon
// every user recognises. Typing a login password or pasting a token blind is a
// well-known usability trap: one mistyped character and the only feedback is a
// failed submit. The toggle lets a user confirm what they entered while keeping
// the field masked by default. Drop-in for a bare <input type="password">: all
// input props pass through; `style` styles the input, `wrapperStyle` the
// positioning wrapper (so a caller can keep its own flex/width layout). Pure
// type/label logic lives in password-field-view.js (unit-tested per #651); this
// is the thin renderer.
export default function PasswordField({ style, wrapperStyle, buttonTitle, ...inputProps }) {
  const [reveal, setReveal] = useState(false);
  const label = revealToggleLabel(reveal);
  const Icon = reveal ? EyeOff : Eye;
  return (
    <div style={{ position: 'relative', width: '100%', ...wrapperStyle }}>
      <input
        {...inputProps}
        type={passwordInputType(reveal)}
        style={{ width: '100%', boxSizing: 'border-box', ...style, paddingRight: 36 }}
      />
      <button
        type="button"
        onClick={() => setReveal(r => !r)}
        aria-label={label}
        aria-pressed={reveal}
        title={buttonTitle || label}
        style={{
          position: 'absolute', right: 'var(--eb-space-2)', top: '50%', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          background: 'transparent', border: 'none', padding: 4, margin: 0, cursor: 'pointer',
          color: 'var(--eb-text-muted)', borderRadius: 'var(--eb-radius-sm)', lineHeight: 0,
        }}
      >
        <Icon size={16} />
      </button>
    </div>
  );
}
