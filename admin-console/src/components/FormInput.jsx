import React, { useState } from 'react';

/**
 * FormInput — Shared form input component using OKLCH design tokens.
 *
 * Props:
 *   label       — string
 *   value       — string
 *   onChange    — function(value: string)
 *   placeholder — Optional string
 *   type        — 'text' | 'email' | 'password' | 'number' | 'url' (default: 'text')
 *   required    — Optional boolean
 *   error       — Optional string (shows error below input)
 *   disabled    — boolean
 *   multiline   — boolean (renders textarea instead of input)
 *   rows        — number for textarea (default: 3)
 *   id          — Optional string (auto-generated from label if not provided)
 */

export default function FormInput({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  required = false,
  error,
  disabled = false,
  multiline = false,
  rows = 3,
  id,
}) {
  const [focused, setFocused] = useState(false);

  const inputId = id || (label ? label.toLowerCase().replace(/\s+/g, '-') : undefined);

  const wrapperStyle = {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--eb-space-1)',
  };

  const labelStyle = {
    fontSize: 'var(--eb-text-sm)',
    fontWeight: 'var(--eb-font-medium)',
    color: 'var(--eb-text-secondary)',
  };

  const inputStyle = {
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-bg-elevated)',
    border: `1px solid ${
      error
        ? 'var(--eb-status-error)'
        : focused
          ? 'var(--eb-accent-primary)'
          : 'var(--eb-border-default)'
    }`,
    borderRadius: 'var(--eb-radius-md)',
    color: 'var(--eb-text-primary)',
    fontSize: 'var(--eb-text-sm)',
    fontFamily: 'inherit',
    outline: 'none',
    width: '100%',
    transition: 'border-color var(--eb-transition-fast)',
    ...(multiline ? { resize: 'vertical' } : {}),
  };

  const errorStyle = {
    fontSize: 'var(--eb-text-xs)',
    color: 'var(--eb-status-error)',
  };

  const handleChange = (e) => {
    if (onChange) onChange(e.target.value);
  };

  const sharedProps = {
    id: inputId,
    value: value ?? '',
    onChange: handleChange,
    placeholder,
    disabled,
    required,
    style: inputStyle,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
  };

  return (
    <div style={wrapperStyle}>
      {label && (
        <label htmlFor={inputId} style={labelStyle}>
          {label}
          {required && <span style={{ color: 'var(--eb-status-error)', marginLeft: 2 }}>*</span>}
        </label>
      )}
      {multiline ? (
        <textarea rows={rows} {...sharedProps} />
      ) : (
        <input type={type} {...sharedProps} />
      )}
      {error && <span style={errorStyle}>{error}</span>}
    </div>
  );
}
