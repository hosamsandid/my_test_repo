import React from 'react';
import { readinessSummary, readinessWaitsFor } from './readiness-gate';

// The readiness gate of ONE PR hand-off, inline in the Flow editor's Inputs
// list (#2913): the two toggles of the hand-off dialog ("Wait for CI", "Block
// on merge conflict") as compact checkboxes with their stored state, and a
// muted "no wait" hint when neither is on. `value` is the stored gate
// (`readiness` / `readinessGate`); `onToggle(key, on)` switches one of them —
// omitted, the row is read-only and only states the gate. The failure label
// and timeout stay in the dialog.
export default function ReadinessToggles({ value, onToggle, busy }) {
  const ci = !!(value && value.ci === true);
  const conflict = !!(value && value.conflict === true);
  const summary = readinessSummary(value);
  const noWait = <span style={muted} title="Woken as soon as the hand-off happens, whatever the PR's checks say.">no wait</span>;
  if (!onToggle) {
    return summary
      ? <span style={wrap} title={summary}>waits for {readinessWaitsFor(value)}</span>
      : <span style={wrap}>{noWait}</span>;
  }
  return (
    <span style={wrap} title={summary || undefined}>
      <label style={chip(ci)}>
        <input type="checkbox" checked={ci} disabled={busy} style={box}
          onChange={e => onToggle('ci', e.target.checked)} />
        Wait for CI
      </label>
      <label style={chip(conflict)}>
        <input type="checkbox" checked={conflict} disabled={busy} style={box}
          onChange={e => onToggle('conflict', e.target.checked)} />
        Block on merge conflict
      </label>
      {!summary && noWait}
    </span>
  );
}

const wrap = { display: 'inline-flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' };
const muted = { color: 'var(--eb-text-muted)', fontStyle: 'italic' };
const box = { margin: 0, width: 12, height: 12 };
const chip = (on) => ({
  display: 'inline-flex', alignItems: 'center', gap: 4, cursor: 'pointer',
  padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
  border: `1px solid ${on ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
  color: on ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
});
