import React, { useState } from 'react';
import { ShieldCheck, OctagonPause } from 'lucide-react';
import SidePanel from '../../components/SidePanel';

// Label registry editor (#981) — the gate/brake flags of every routing label
// the graph knows. Gate/brake-ness is CONFIGURATION, not naming (#928): a
// "Human gate" label may only be applied by a person (draws the @human → agent
// gate edge, no orphan lint); a "Brake" label is agent-applied and pauses the
// flow pending a human decision (draws the agent → @human hand-off edge, no
// dead-end lint). Mode-agnostic: all writes go through the injected
// `ops.setLabelFlags(name, { humanGate, brake })` — draft ops persist the
// bundle's `labels[]`, live ops persist the team agent's registry.
export default function LabelRegistryPanel({ labels = [], ops, onClose, onChanged }) {
  // graph.labels is the full known set with current flags — keep a local copy
  // so a toggle renders immediately while the write + refetch run.
  const [rows, setRows] = useState(() =>
    labels
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({ name: l.name.trim(), humanGate: !!l.humanGate, brake: !!l.brake }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  const [busy, setBusy] = useState(null); // label name being written
  const [error, setError] = useState(null);

  const toggle = async (name, flag) => {
    const row = rows.find(r => r.name === name);
    if (!row || busy) return;
    const next = { humanGate: row.humanGate, brake: row.brake, [flag]: !row[flag] };
    setBusy(name); setError(null);
    try {
      await ops.setLabelFlags(name, next);
      setRows(rs => rs.map(r => (r.name === name ? { ...r, ...next } : r)));
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  const cellCheckbox = (row, flag) => (
    <input
      type="checkbox"
      checked={row[flag]}
      disabled={busy === row.name}
      onChange={() => toggle(row.name, flag)}
      style={{ cursor: busy ? 'wait' : 'pointer' }}
    />
  );

  return (
    <SidePanel open onClose={onClose} title="Label registry" width="480px">
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        <ShieldCheck size={13} style={{ verticalAlign: '-2px' }} /> <strong>Human gate</strong> — only
        a person applies this label (work injection / approval; agents emitting it is an error).
        <br />
        <OctagonPause size={13} style={{ verticalAlign: '-2px' }} /> <strong>Brake</strong> — an agent
        applies it to pause the flow until a person decides.
      </p>
      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>{error}</div>
      )}
      {rows.length === 0 ? (
        <p style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          No routing labels in this flow yet — wire a label hand-off first.
        </p>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-sm)' }}>
          <thead>
            <tr style={{ color: 'var(--eb-text-muted)', textAlign: 'left' }}>
              <th style={{ padding: '4px 8px', fontWeight: 'var(--eb-font-medium)' }}>Label</th>
              <th style={{ padding: '4px 8px', fontWeight: 'var(--eb-font-medium)' }}>Human gate</th>
              <th style={{ padding: '4px 8px', fontWeight: 'var(--eb-font-medium)' }}>Brake</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(row => (
              <tr key={row.name} style={{ borderTop: '1px solid var(--eb-border-default)' }}>
                <td style={{ padding: '6px 8px' }}>
                  <code style={{ fontSize: 'var(--eb-text-xs)' }}>{row.name}</code>
                </td>
                <td style={{ padding: '6px 8px' }}>{cellCheckbox(row, 'humanGate')}</td>
                <td style={{ padding: '6px 8px' }}>{cellCheckbox(row, 'brake')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </SidePanel>
  );
}
