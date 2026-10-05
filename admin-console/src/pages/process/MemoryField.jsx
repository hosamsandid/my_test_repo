import React from 'react';
import { effectiveMemoryText, memoryLimitError, MEMORY_NEXT_START_NOTE } from '../memory-limit-view.js';

// A role's memory requirement (#2813) — one controlled field shared by the
// Flow editor's NodeInspector (draft + live) and the agent's Settings tab
// (AgentEditForm), so the two never drift. Empty = platform default. `info`
// is what the server reported — GET /api/agents/:id/memory for a live agent,
// GET /api/memory-limits for a draft role — and drives the effective-limit
// read-out (value + source) and the ceiling check. The logic is in the pure
// `memory-limit-view.js`; this JSX only wires it (#651).
export default function MemoryField({ value, onChange, info, error, disabled = false, showNextStartNote = true }) {
  const inputError = memoryLimitError(value, { ceiling: info?.ceiling });
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Memory limit</span>
      <input
        type="text"
        value={value || ''}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder="platform default (e.g. 4g, 512m)"
        style={fieldInput}
      />
      {info && (
        <span style={hint}>{effectiveMemoryText(inputError ? '' : value, info)}</span>
      )}
      {showNextStartNote && <span style={hint}>{MEMORY_NEXT_START_NOTE}</span>}
      {(error || inputError) && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>{error || inputError}</span>
      )}
    </label>
  );
}

const hint = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' };
const fieldInput = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  boxSizing: 'border-box', width: '100%', outline: 'none',
};
