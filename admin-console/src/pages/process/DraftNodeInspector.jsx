import React, { useState } from 'react';
import { Save, Trash2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { resolveInheritedStage } from './hierarchy-utils';
import ConnectionsSection from './ConnectionsSection';
import TriggersPanel from '../agent-chat/TriggersPanel';

// Node inspector for a DRAFT role (Process Canvas v2, #345). Tabs mirror the
// live inspector — Details (name/id/prompt/stage), Triggers (the full
// agent-chat trigger editor, writing to the bundle via the draft adapter) and
// Connections. Lighter than the live inspector — no Matrix, no
// inherit/override, no live status.
export default function DraftNodeInspector({ role, roles = [], stages = [], ops, onClose, onDeleted, onChanged, onRenamedId }) {
  const [tab, setTab] = useState('details');
  const [name, setName] = useState(role.displayName || role.id);
  const [id, setId] = useState(role.id);
  const [prompt, setPrompt] = useState(role.systemPrompt || '');
  const [stage, setStage] = useState(role.stage || '');
  const [newStage, setNewStage] = useState('');   // inline "create a new stage"
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState(null);

  const others = roles.filter(r => r.id !== role.id);
  const inheritedStage = resolveInheritedStage(roles, role);

  async function saveMeta() {
    setBusy(true); setSaved(false); setError(null);
    try {
      if (name !== role.displayName) await ops.renameRole(role.id, name);
      if (prompt !== (role.systemPrompt || '')) await ops.setPrompt(role.id, prompt);
      // A brand-new stage typed in the "＋ new" box is registered on the ordered
      // stage list first, then assigned — so it appears in the layout order.
      let target = stage;
      const fresh = newStage.trim();
      if (fresh) { if (ops.addStage) await ops.addStage(fresh); target = fresh; setStage(fresh); setNewStage(''); }
      if (target !== (role.stage || '') && ops.setStage) await ops.setStage(role.id, target);
      // Rename the id last (it rewires references + changes the selected key), so
      // the ops above still resolve the role by its old id.
      if (id !== role.id && ops.renameRoleId) {
        const newId = await ops.renameRoleId(role.id, id);
        setId(newId);
        onChanged?.();
        onRenamedId?.(newId);
        setSaved(true);
        return;
      }
      setSaved(true); onChanged?.();
    } catch (e) {
      setError(e.message || String(e));
    } finally { setBusy(false); }
  }

  const siblingList = others.map(r => ({ id: r.id, displayName: r.displayName || r.id }));

  return (
    <SidePanel open onClose={onClose} title={role.displayName || role.id} width="560px">
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        <span style={badge}>draft agent</span>
      </div>

      <div style={{ display: 'flex', borderBottom: '1px solid var(--eb-border-default)', marginBottom: 'var(--eb-space-4)' }}>
        <TabButton active={tab === 'details'} onClick={() => setTab('details')}>Details</TabButton>
        <TabButton active={tab === 'triggers'} onClick={() => setTab('triggers')}>Triggers</TabButton>
        <TabButton active={tab === 'connections'} onClick={() => setTab('connections')}>Connections</TabButton>
      </div>

      {tab === 'details' && (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Display name">
          <input value={name} onChange={e => { setName(e.target.value); setSaved(false); }} style={input} />
        </Field>
        <Field label="Agent ID">
          <input value={id}
            onChange={e => { setId(e.target.value); setSaved(false); setError(null); }}
            style={{ ...input, fontFamily: 'var(--eb-font-mono)' }} />
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Lowercase letters, digits and hyphens. Renaming rewires all connections to this agent.
          </span>
        </Field>
        <Field label="Agent prompt">
          <textarea value={prompt} onChange={e => { setPrompt(e.target.value); setSaved(false); }}
            placeholder="What this agent does, its responsibilities and tone…"
            style={{ ...input, minHeight: 220, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', lineHeight: 1.5 }} />
        </Field>
        <Field label="Stage (layout column)">
          <select value={stages.includes(stage) ? stage : ''}
            onChange={e => { setStage(e.target.value); setNewStage(''); setSaved(false); }} style={input}>
            <option value="">{inheritedStage ? `— inherit (${inheritedStage}) —` : '— none —'}</option>
            {stages.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input value={newStage} onChange={e => { setNewStage(e.target.value); setSaved(false); }}
            placeholder="＋ or type a new stage name…" style={{ ...input, marginTop: 4 }} />
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
            Stages are the ordered columns of the flow — manage the order under <strong>Stages</strong> in the toolbar.
          </span>
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <button onClick={saveMeta} disabled={busy} style={primary}>
            <Save size={14} /> Save
          </button>
          {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
          {error && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>{error}</span>}
        </div>

        <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)' }}>
          <button onClick={async () => { await ops.deleteRole(role.id); onDeleted?.(); }}
            style={{ ...ghost, color: 'var(--eb-status-error)', borderColor: 'var(--eb-status-error)' }}>
            <Trash2 size={14} /> Delete agent
          </button>
        </div>
      </div>
      )}

      {/* The full agent-chat trigger editor, writing to the draft bundle via
          the ops adapter — create, edit, toggle and delete triggers here; the
          canvas edges re-derive from the bundle on every save. */}
      {tab === 'triggers' && (
        <div style={{ height: 'min(60vh, 540px)', display: 'flex', flexDirection: 'column', border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)', overflow: 'hidden' }}>
          <TriggersPanel agentId={role.id} active ops={ops} onChanged={onChanged} />
        </div>
      )}

      {tab === 'connections' && (
        <ConnectionsSection
          node={role}
          siblings={siblingList}
          showStage={false}
          ops={ops}
          onChanged={onChanged}
        />
      )}
    </SidePanel>
  );
}

function TabButton({ active, onClick, children }) {
  return (
    <button onClick={onClick} style={{
      background: 'none', border: 'none', borderBottom: active ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
      color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: 'pointer',
      fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: active ? 'var(--eb-font-medium)' : 'normal',
    }}>{children}</button>
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
const ghost = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
};
const primary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
