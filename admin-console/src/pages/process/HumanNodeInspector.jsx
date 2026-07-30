import React, { useState } from 'react';
import { User, Trash2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';

// Inspector variant for a first-class human role node (#987). A human role is
// purely declarative — no prompt, no triggers, no session — so this is a focused
// editor for name / description / stage / the labels the person applies
// (`emits`, implicitly gates). `consumes` (artifacts and brakes wired to the
// person) is shown read-only; those entries are created by wiring. Mode-agnostic:
// writes go through `ops.upsertHuman(human)` / `ops.removeHuman(id)`.
const inputStyle = {
  background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: '6px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', width: '100%', boxSizing: 'border-box',
};
const labelStyle = { fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', fontWeight: 600, marginBottom: 3, display: 'block' };

function consumeLabel(c) {
  if (c && c.label) return `⏸ brake · ${c.label}`;
  if (c && (c.artifact === 'pr' || c.artifact === 'issue')) return `⇤ ${c.artifact} · from ${c.from}`;
  if (c && c.artifact === 'file') return `⇤ file · ${c.name}`;
  return '';
}

export default function HumanNodeInspector({ human, stages = [], ops, onClose, onDeleted, onChanged }) {
  const [name, setName] = useState(human.name || human.id);
  const [description, setDescription] = useState(human.description || '');
  const [stage, setStage] = useState(human.stage || '');
  const [emitsText, setEmitsText] = useState((human.emits || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const dirty = name !== (human.name || human.id)
    || description !== (human.description || '')
    || stage !== (human.stage || '')
    || emitsText !== (human.emits || []).join(', ');

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const emits = emitsText.split(',').map(s => s.trim()).filter(Boolean);
      await ops.upsertHuman({ ...human, id: human.id, name: name.trim() || human.id, description, stage, emits });
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await ops.removeHuman(human.id);
      onDeleted?.();
    } catch (e) { setError(e.message); setBusy(false); }
  };

  return (
    <SidePanel open onClose={onClose} title="Human role" width="440px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 'var(--eb-space-3)' }}>
        <User size={18} style={{ color: '#7c3aed' }} />
        <code style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{human.id}</code>
      </div>
      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>{error}</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <div>
          <label style={labelStyle}>Display name</label>
          <input style={inputStyle} value={name} disabled={busy} onChange={e => setName(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Description</label>
          <textarea style={{ ...inputStyle, minHeight: 56, resize: 'vertical' }} value={description} disabled={busy}
            placeholder="What this person does in the flow (optional)" onChange={e => setDescription(e.target.value)} />
        </div>
        <div>
          <label style={labelStyle}>Stage</label>
          <select style={inputStyle} value={stage} disabled={busy} onChange={e => setStage(e.target.value)}>
            <option value="">— no stage —</option>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <label style={labelStyle}>Labels this person applies (gates), comma-separated</label>
          <input style={inputStyle} value={emitsText} disabled={busy}
            placeholder="e.g. dispatch, approved" onChange={e => setEmitsText(e.target.value)} />
          <p style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            A label a human applies is a gate — an agent emitting it is a hard error.
          </p>
        </div>
        <div>
          <label style={labelStyle}>Consumes (wired)</label>
          {(human.consumes || []).length === 0 ? (
            <p style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Nothing wired yet — a brake, an issue/PR review, or a file this person reads.
            </p>
          ) : (
            <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
              {(human.consumes || []).map((c, i) => (
                <span key={i} style={{ fontSize: 10, color: '#6d28d9', background: 'rgba(124,58,237,0.10)', border: '1px solid rgba(124,58,237,0.35)', borderRadius: 3, padding: '1px 5px' }}>{consumeLabel(c)}</span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--eb-space-2)' }}>
          <button disabled={busy || !dirty} onClick={save}
            style={{ background: 'var(--eb-accent-primary)', color: '#fff', border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontSize: 'var(--eb-text-sm)', cursor: busy ? 'wait' : (dirty ? 'pointer' : 'default'), opacity: dirty ? 1 : 0.5 }}>
            Save
          </button>
          <button disabled={busy} onClick={remove}
            style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none', color: 'var(--eb-status-error)', border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)', padding: '6px 12px', fontSize: 'var(--eb-text-sm)', cursor: busy ? 'wait' : 'pointer' }}>
            <Trash2 size={14} /> Remove
          </button>
        </div>
      </div>
    </SidePanel>
  );
}
