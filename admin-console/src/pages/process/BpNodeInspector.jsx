import React, { useState } from 'react';
import { Save, X } from 'lucide-react';
import SidePanel from '../../components/SidePanel';

// Right-side inspector for a BriefingPack node (#362 UI rework) — the same
// editing pattern as the shared process NodeInspector, so editing is consistent
// across BP and process flows. Edits write back to brief.md via bpOps
// (prompt body, stage, and removal of dependency / artifact links).
export default function BpNodeInspector({ node, nodes = [], ops, onClose, onChanged }) {
  const [prompt, setPrompt] = useState(node.content || '');
  const [stage, setStage] = useState(node.stage || '');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const nameOf = (id) => (nodes.find(n => n.id === id)?.displayName) || id;
  const deps = Array.isArray(node.dependsOn) ? node.dependsOn : [];
  const inputs = Array.isArray(node.inputs) ? node.inputs : [];
  const outputs = Array.isArray(node.outputs) ? node.outputs : [];
  const pathOf = (a) => (a && a.path) || a;

  const run = async (fn) => {
    setBusy(true); setSaved(false);
    try { await fn(); setSaved(true); onChanged && onChanged(); }
    finally { setBusy(false); }
  };

  return (
    <SidePanel open onClose={onClose} title={node.displayName || node.id} width="520px">
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        <span style={badge}>BriefingPack</span>
        <code style={{ color: 'var(--eb-text-muted)' }}>{node.id}</code>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <Field label="Prompt / brief">
          <textarea
            value={prompt}
            onChange={e => { setPrompt(e.target.value); setSaved(false); }}
            placeholder="The briefing / prompt for this work-unit…"
            style={{ ...input, minHeight: 240, resize: 'vertical', fontFamily: 'var(--eb-font-mono)', lineHeight: 1.5 }}
          />
        </Field>
        <Field label="Stage (optional)">
          <input value={stage} onChange={e => { setStage(e.target.value); setSaved(false); }}
            placeholder={!stage && node.effectiveStage ? `inherits: ${node.effectiveStage}` : 'e.g. Build'}
            style={input} />
          {!stage && node.effectiveStage && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Inherited from parent — leave empty to keep, or type to override.
            </span>
          )}
        </Field>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <button
            disabled={busy}
            onClick={() => run(async () => {
              if (prompt !== (node.content || '')) await ops.setPrompt(node.id, prompt);
              if (stage !== (node.stage || '')) await ops.setStage(node.id, stage);
            })}
            style={primary}
          >
            <Save size={14} /> Save
          </button>
          {saved && <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-success)' }}>Saved.</span>}
        </div>

        {(deps.length > 0 || inputs.length > 0 || outputs.length > 0) && (
          <div style={{ borderTop: '1px solid var(--eb-border-default)', paddingTop: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Dependencies &amp; data flow</div>
            {deps.length > 0 && (
              <ChipRow label="depends on" color="#ef4444"
                items={deps.map(d => ({ key: d, text: nameOf(d), onRemove: () => run(() => ops.removeDependency(node.id, d)) }))} />
            )}
            {inputs.length > 0 && (
              <ChipRow label="inputs" color="#10b981"
                items={inputs.map(a => ({ key: pathOf(a), text: pathOf(a), onRemove: () => run(() => ops.removeArtifact(node.id, { direction: 'input', path: pathOf(a) })) }))} />
            )}
            {outputs.length > 0 && (
              <ChipRow label="outputs" color="#10b981"
                items={outputs.map(a => ({ key: pathOf(a), text: pathOf(a), onRemove: () => run(() => ops.removeArtifact(node.id, { direction: 'output', path: pathOf(a) })) }))} />
            )}
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
              Add links by dragging the ● port on the canvas.
            </div>
          </div>
        )}
      </div>
    </SidePanel>
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

const badge = { fontSize: 'var(--eb-text-xs)', padding: '1px 7px', borderRadius: 'var(--eb-radius-full)', border: '1px solid var(--eb-border-default)', color: 'var(--eb-text-secondary)' };
const input = {
  background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', boxSizing: 'border-box', width: '100%', outline: 'none',
};
const primary = {
  display: 'inline-flex', alignItems: 'center', gap: 6, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
  borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
};
