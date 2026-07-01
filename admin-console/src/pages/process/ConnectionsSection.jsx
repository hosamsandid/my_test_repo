import React, { useState } from 'react';
import { X } from 'lucide-react';

// Shared "connections" editor for a node/role, used by BOTH the draft and the
// live inspector (#unified). It edits only the declarative edge shape — parent,
// stage, and the dependency / data-flow ports — through the `ops` adapter, so a
// live team and a draft are wired and un-wired identically. Creating edges still
// happens by dragging the ● port on the canvas; this panel lists them and lets
// you set the parent/stage and remove ports.
//
// Props:
//   node        — { id, parent, stage, dependsOn[], inputs[], outputs[] }
//   siblings    — [{ id, displayName }] other nodes (parent options + names)
//   inheritedStage — string shown as the placeholder when stage is empty
//   showStage   — render the stage field here (false when the host owns stage)
//   ops         — edit adapter (liveOps | draftOps)
//   onChanged   — called after any successful mutation
export default function ConnectionsSection({ node, siblings = [], inheritedStage = '', showStage = true, ops, onChanged }) {
  const [stage, setStage] = useState(node.stage || '');
  const nameOf = (id) => siblings.find(s => s.id === id)?.displayName || id;
  // An artifact is keyed by its logical name when set, else its path (#382).
  const keyOf = (a) => (typeof a === 'string' ? a : (a && (a.name || a.path))) || '';
  const labelOf = (a) => {
    const k = keyOf(a);
    const h = a && typeof a === 'object' && a.name && a.hint ? a.hint : '';
    return h ? `${k} · ${h}` : k;
  };
  const rmArtifact = (dir, a) => ({ direction: dir, name: a && a.name, path: a && a.path });

  const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];

  const run = async (fn) => {
    try { await fn(); onChanged?.(); }
    catch (e) { window.alert(e?.message || String(e)); }
  };
  const setParent = (v) => run(() => ops.setParent(node.id, v || null));
  const saveStage = () => {
    if ((stage || '') === (node.stage || '') || !ops.setStage) return;
    run(() => ops.setStage(node.id, stage));
  };

  return (
    <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Connections</div>

      <Field label="Parent (optional)">
        <select value={node.parent || ''} onChange={e => setParent(e.target.value)} style={input}>
          <option value="">— none —</option>
          {siblings.map(s => <option key={s.id} value={s.id}>{s.displayName || s.id}</option>)}
        </select>
      </Field>

      {showStage && ops.setStage && (
        <Field label="Stage (optional)">
          <input value={stage} onChange={e => setStage(e.target.value)} onBlur={saveStage}
            placeholder={!stage && inheritedStage ? `inherits: ${inheritedStage}` : 'e.g. Build'}
            style={input}
            onKeyDown={e => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          {!stage && inheritedStage && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Inherited from parent — leave empty to keep, or type to override.
            </span>
          )}
        </Field>
      )}

      {(deps.length || inputs.length || outputs.length) ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>Dependencies &amp; data flow</div>
          {deps.length > 0 && (
            <ChipRow label="depends on" color="#ef4444"
              items={deps.map(d => ({ key: d, text: nameOf(d), onRemove: () => run(() => ops.removeDependency(node.id, d)) }))} />
          )}
          {inputs.length > 0 && (
            <ChipRow label="inputs" color="#10b981"
              items={inputs.map(a => ({ key: keyOf(a), text: labelOf(a), onRemove: () => run(() => ops.removeArtifact(node.id, rmArtifact('input', a))) }))} />
          )}
          {outputs.length > 0 && (
            <ChipRow label="outputs" color="#10b981"
              items={outputs.map(a => ({ key: keyOf(a), text: labelOf(a), onRemove: () => run(() => ops.removeArtifact(node.id, rmArtifact('output', a))) }))} />
          )}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          No dependencies or data flow yet — drag a role's ● port on the canvas to add one.
        </div>
      )}
    </div>
  );
}

function ChipRow({ label, color, items }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', minWidth: 64 }}>{label}</span>
      {items.map(it => (
        <button key={it.key} onClick={it.onRemove} title="Remove" style={{
          fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
          background: `${color}1a`, color, border: `1px solid ${color}`,
          borderRadius: 'var(--eb-radius-sm)', padding: '0 5px', cursor: 'pointer',
          display: 'inline-flex', alignItems: 'center', gap: 3,
        }}>{it.text} <X size={10} /></button>
      ))}
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

const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
