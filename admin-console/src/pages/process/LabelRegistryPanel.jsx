import React, { useState } from 'react';
import { ShieldCheck, OctagonPause } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import PageHelpButton from '../../components/PageHelpButton';

// Label registry editor (#981) — per routing label, WHO sets it and who reacts.
// Gate/brake-ness is CONFIGURATION, not naming (#928), and the two flags encode
// the two DIRECTIONS of a human hand-off — so the editor is a single three-way
// choice, never two stackable checkboxes (both-set is meaningless; gate wins):
//
//   agent  — set and consumed by agents; the default, no registry entry.
//   gate   — 👤 → flow: only a PERSON applies it (approval / work injection).
//            An agent emitting it is a hard error (gate-violation).
//   brake  — flow → 👤: an AGENT applies it to pause and hand the decision to
//            a person. Agent-set by design, never an error.
//
// Mode-agnostic: all writes go through the injected
// `ops.setLabelFlags(name, { humanGate, brake })` — draft ops persist the
// bundle's `labels[]`, live ops persist the team agent's registry.
const KINDS = [
  { value: 'agent', title: 'Agent label', hint: 'set and consumed by agents (default)' },
  { value: 'gate', title: 'Human gate · 👤 → flow', hint: 'only a person applies it — it admits or approves work; an agent setting it is an error' },
  { value: 'brake', title: 'Brake · flow → 👤', hint: 'an agent applies it to pause and hand the decision to a person' },
];
const kindOf = (l) => (l.humanGate ? 'gate' : l.brake ? 'brake' : 'agent');

export default function LabelRegistryPanel({ labels = [], ops, onClose, onChanged }) {
  // graph.labels is the full known set with current flags — keep a local copy
  // so a change renders immediately while the write + refetch run.
  const [rows, setRows] = useState(() =>
    labels
      .filter(l => l && typeof l.name === 'string' && l.name.trim())
      .map(l => ({ name: l.name.trim(), kind: kindOf(l) }))
      .sort((a, b) => a.name.localeCompare(b.name)));
  const [busy, setBusy] = useState(null); // label name being written
  const [error, setError] = useState(null);

  const setKind = async (name, kind) => {
    if (busy) return;
    setBusy(name); setError(null);
    try {
      await ops.setLabelFlags(name, { humanGate: kind === 'gate', brake: kind === 'brake' });
      setRows(rs => rs.map(r => (r.name === name ? { ...r, kind } : r)));
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <SidePanel open onClose={onClose} title="Label registry" width="520px">
      {/* The gate-vs-brake explanation moved into the `flows` help topic
          (#1876) — the "?" is how you reach it from inside the panel. */}
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
        Per label: <strong>who sets it, and who reacts</strong>. A{' '}
        <ShieldCheck size={13} style={{ verticalAlign: '-2px' }} /> <strong>gate</strong> is set only by a
        person, a <OctagonPause size={13} style={{ verticalAlign: '-2px' }} /> <strong>brake</strong> only by
        an agent.
        <PageHelpButton label="How gates and brakes work" size={13} style={{ padding: 0, verticalAlign: '-2px' }} />
      </p>
      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>{error}</div>
      )}
      {rows.length === 0 ? (
        <p style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          No routing labels in this flow yet — wire a label hand-off first.
        </p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          {rows.map(row => (
            <div key={row.name} style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
              padding: '8px 4px', borderTop: '1px solid var(--eb-border-default)',
            }}>
              <code style={{ flex: 1, fontSize: 'var(--eb-text-xs)', overflowWrap: 'anywhere' }}>{row.name}</code>
              <select
                value={row.kind}
                disabled={busy === row.name}
                onChange={(e) => setKind(row.name, e.target.value)}
                title={KINDS.find(k => k.value === row.kind)?.hint}
                style={{
                  background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
                  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                  padding: '4px 6px', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
                  cursor: busy ? 'wait' : 'pointer',
                }}
              >
                {KINDS.map(k => (
                  <option key={k.value} value={k.value} title={k.hint}>{k.title}</option>
                ))}
              </select>
            </div>
          ))}
        </div>
      )}
    </SidePanel>
  );
}
