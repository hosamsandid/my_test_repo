/**
 * form-kit.jsx — the small styling/button primitives the agent lifecycle
 * dialogs are built from.
 *
 * These lived as module-level constants inside Agents.jsx. #1928 re-surfaces the
 * same dialogs in Agent Chat, so they moved here rather than being copied: both
 * the Agents page and the chat's lifecycle dialogs import them, and the two
 * surfaces cannot drift apart visually. Nothing about them changed in the move.
 */
import React from 'react';

export const labelStyle = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-0-5)',
};
export const inputStyle = {
  width: '100%', padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', outline: 'none', boxSizing: 'border-box',
};
export const helpTextStyle = {
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
  marginTop: 'var(--eb-space-1)', lineHeight: 1.5,
};

export function PrimaryBtn({ children, onClick, disabled, saving, style = {} }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || saving}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
        border: 'none', borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
        cursor: (disabled || saving) ? 'not-allowed' : 'pointer', fontFamily: 'inherit',
        opacity: (disabled || saving) ? 0.6 : 1, ...style,
      }}
    >{children}</button>
  );
}

export function SecondaryBtn({ children, onClick, style = {} }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: 'var(--eb-space-2) var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
        cursor: 'pointer', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', ...style,
      }}
    >{children}</button>
  );
}
