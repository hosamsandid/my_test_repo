import React, { useState } from 'react';
import { ShieldCheck } from 'lucide-react';
import SidePanel from '../../components/SidePanel';

// Add a human approval gate (Process Canvas v2, #346). A gate is a `human:<name>`
// label only a human sets; the chosen downstream step is wired to *wait* on it.
// No agent is ever recorded as emitting it (so `gate-violation` can't fire).
export default function AddApprovalDialog({ roles = [], onClose, onCreate }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [downstream, setDownstream] = useState(roles[0]?.id || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const slug = name.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  const label = slug ? `human:${slug}` : '';

  async function submit() {
    if (!slug) { setError('Give the approval a name.'); return; }
    if (!downstream) { setError('Pick which step waits for this approval.'); return; }
    setBusy(true); setError(null);
    try {
      await onCreate({ label, description: description.trim(), downstream });
    } catch (e) { setError(e.message); setBusy(false); }
  }

  return (
    <SidePanel open onClose={onClose} title="Add human approval" width="480px">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8, marginBottom: 'var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        <ShieldCheck size={16} style={{ color: 'var(--eb-status-error)', flexShrink: 0, marginTop: 2 }} />
        <span>A gate only a human can set. The step you pick will wait until a human adds the
          <code> {label || 'human:…'}</code> label. No agent emits it.</span>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Approval name">
          <input autoFocus value={name} onChange={e => setName(e.target.value)}
            placeholder="e.g. FDD approved, Go-live approved" style={input}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
          {label && <small style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Label: <code>{label}</code></small>}
        </Field>
        <Field label="Waits / blocks (downstream step)">
          <select value={downstream} onChange={e => setDownstream(e.target.value)} style={input}>
            <option value="">— select —</option>
            {roles.map(r => <option key={r.id} value={r.id}>{r.displayName || r.id}</option>)}
          </select>
        </Field>
        <Field label="Description (optional)">
          <input value={description} onChange={e => setDescription(e.target.value)}
            placeholder="e.g. Client signs off the FDD" style={input} />
        </Field>

        {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={busy} style={ghost}>Cancel</button>
          <button onClick={submit} disabled={busy || !slug || !downstream} style={primary}>Add approval</button>
        </div>
      </div>
    </SidePanel>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{label}</span>
      {children}
    </label>
  );
}
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
  boxSizing: 'border-box', width: '100%', outline: 'none',
};
const ghost = {
  background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
