import React, { useState } from 'react';
import { Save, Trash2, X, Plus } from 'lucide-react';
import SidePanel from '../../components/SidePanel';

// Node inspector for a DRAFT role (Process Canvas v2, #345). Edits the role's
// displayName, system prompt, and triggers' emits directly on the draft bundle
// via the draft adapter (`ops`). Lighter than the live inspector — no Matrix,
// no inherit/override, no live status.
export default function DraftNodeInspector({ role, ops, onClose, onDeleted, onChanged }) {
  const [name, setName] = useState(role.displayName || role.id);
  const [prompt, setPrompt] = useState(role.systemPrompt || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const triggers = role.triggers || [];

  async function saveMeta() {
    setBusy(true); setSaved(false);
    try {
      if (name !== role.displayName) await ops.renameRole(role.id, name);
      if (prompt !== (role.systemPrompt || '')) await ops.setPrompt(role.id, prompt);
      setSaved(true); onChanged?.();
    } finally { setBusy(false); }
  }

  async function setEmits(tid, emits) { await ops.setEmits(role.id, tid, emits); onChanged?.(); }
  async function deleteTrigger(tid) { await ops.deleteTrigger(role.id, tid); onChanged?.(); }

  return (
    <SidePanel open onClose={onClose} title={role.displayName || role.id} width="520px">
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        <span style={badge}>draft role</span>
        <code style={{ color: 'var(--eb-text-muted)' }}>{role.id}</code>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Display name">
          <input value={name} onChange={e => { setName(e.target.value); setSaved(false); }} style={input} />
        </Field>
        <Field label="System prompt">
          <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setSaved(false); }}
            placeholder="What this role does, its responsibilities and tone…"
            style={{ ...input, minHeight: 220, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', lineHeight: 1.5 }} />
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <button onClick={saveMeta} disabled={busy} style={primary}>
            <Save size={14} /> Save
          </button>
          {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
        </div>

        {/* Triggers */}
        <div style={{ marginTop: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', marginBottom: 6 }}>
            Triggers <span style={{ color: 'var(--eb-text-muted)' }}>— wire hand-offs by dragging the ● port on the canvas</span>
          </div>
          {triggers.length === 0 && (
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
              No triggers yet. Draw an edge into another role to create one.
            </div>
          )}
          {triggers.map(t => (
            <TriggerCard key={t.id} trigger={t}
              onEmits={(emits) => setEmits(t.id, emits)}
              onDelete={() => deleteTrigger(t.id)} />
          ))}
        </div>

        <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)' }}>
          <button onClick={async () => { await ops.deleteRole(role.id); onDeleted?.(); }}
            style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
            <Trash2 size={14} /> Delete role
          </button>
        </div>
      </div>
    </SidePanel>
  );
}

function TriggerCard({ trigger, onEmits, onDelete }) {
  const [newLabel, setNewLabel] = useState('');
  const emits = Array.isArray(trigger.emits) ? trigger.emits : [];
  const listen = trigger.type === 'github-event'
    ? (trigger.labelFilter ? `🏷 ${trigger.labelFilter}` : (trigger.events || []).join(', '))
    : (trigger.cron || trigger.type);

  const add = () => {
    const l = newLabel.trim();
    if (l && !emits.includes(l)) onEmits([...emits, l]);
    setNewLabel('');
  };

  return (
    <div style={{ border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', marginBottom: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{trigger.type}</span>
        <code style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{listen}</code>
        <button onClick={onDelete} title="Delete trigger" style={{ ...ghost, padding: '1px 5px', borderColor: 'var(--eb-status-error)', color: 'var(--eb-status-error)' }}><Trash2 size={11} /></button>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center', marginTop: 6 }}>
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>emits</span>
        {emits.length === 0 && <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>none</span>}
        {emits.map(l => (
          <button key={l} onClick={() => onEmits(emits.filter(x => x !== l))} title="Remove"
            style={emitChip}>{l} <X size={10} /></button>
        ))}
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <input value={newLabel} onChange={e => setNewLabel(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); add(); } }}
            placeholder="add label…" style={{ ...input, width: 130, padding: '1px 6px', fontSize: 'var(--eb-text-xs)' }} />
          <button onClick={add} style={{ ...ghost, padding: '1px 5px' }}><Plus size={11} /></button>
        </span>
      </div>
    </div>
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
const badge = { fontSize: 'var(--eb-text-xs)', padding: '1px 7px', borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)' };
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const emitChip = {
  fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)', background: 'var(--eb-status-info-bg)', color: 'var(--eb-status-info)',
  border: '1px solid var(--eb-status-info)', borderRadius: 'var(--eb-radius-sm)', padding: '0 5px', cursor: 'pointer', display: 'inline-flex', alignItems: 'center', gap: 3,
};
const ghost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
