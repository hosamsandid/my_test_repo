import React, { useState } from 'react';
import { User, Trash2, X } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { useLabelSuffix, LabelSuffixChip } from '../../components/SuffixedLabelInput';
import { labelListToText, labelListFromText } from './label-suffix-view.js';
import { wireHumanGate } from './wiring-engine';

// Inspector variant for a first-class human role node (#987). A human role is
// purely declarative — no prompt, no triggers, no session — so this is a focused
// editor for name / description / stage / the labels the person applies
// (`emits`, implicitly gates). `consumes` (artifacts and brakes wired to the
// person) is normally created by wiring, but each entry carries a per-chip
// unwire (#2063) so a dead producer's dangling ref — whose only other remove
// control lived on the now-deleted producer — is removable here. Mode-agnostic:
// writes go through `ops.upsertHuman` / `ops.removeHuman` / `ops.unwireHumanConsume`.
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

// "On approval, wake…" for one gate label (#1005, A9): shows who already wakes
// on it; the picker wires a new consumer through the engine (claimed listener).
function GateWakePicker({ label, human, peers, ops, humanOps, busy, onChanged }) {
  const [wiring, setWiring] = useState(false);
  const [error, setError] = useState(null);
  const agents = peers.filter(p => p && p.kind !== 'human');
  const listeners = agents.filter(p => (p.triggers || []).some(t =>
    t && t.type === 'github-event' && t.labelFilter === label));
  const listenerIds = new Set(listeners.map(p => p.id));
  const candidates = agents.filter(p => !listenerIds.has(p.id));
  const wake = async (targetId) => {
    if (!targetId) return;
    setWiring(true); setError(null);
    try {
      await wireHumanGate({ ops, humanOps }, { human: human.id, to: targetId, label });
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setWiring(false); }
  };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flexWrap: 'wrap' }}>
      <code>{label}</code> — on approval, wake
      {listeners.map(p => <strong key={p.id} style={{ color: 'var(--eb-text-secondary)' }}>{p.displayName || p.id}</strong>)}
      {candidates.length > 0 && (
        <select value="" disabled={busy || wiring} onChange={e => wake(e.target.value)}
          style={{ ...inputStyle, width: 'auto', padding: '2px 4px', fontSize: 'var(--eb-text-xs)' }}>
          <option value="">{listeners.length ? '＋ also…' : '— pick an agent —'}</option>
          {candidates.map(p => <option key={p.id} value={p.id}>{p.displayName || p.id}</option>)}
        </select>
      )}
      {error && <span style={{ color: 'var(--eb-status-error)' }}>{error}</span>}
    </div>
  );
}

export default function HumanNodeInspector({ human, stages = [], ops, triggerOps, peers = [], onClose, onDeleted, onChanged }) {
  const suffixCtx = useLabelSuffix();
  const [name, setName] = useState(human.name || human.id);
  const [description, setDescription] = useState(human.description || '');
  const [stage, setStage] = useState(human.stage || '');
  const [emitsText, setEmitsText] = useState(labelListToText(human.emits, suffixCtx));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const dirty = name !== (human.name || human.id)
    || description !== (human.description || '')
    || stage !== (human.stage || '')
    || emitsText !== labelListToText(human.emits, suffixCtx);

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const emits = labelListFromText(emitsText, suffixCtx, human.emits);
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

  // Unwire one consume entry (#2063). `unwireHumanConsume` matches by consumeKey
  // regardless of whether the producer still exists, so a dead pr/issue ref left
  // by a deleted producer is removable here.
  const unwireConsume = async (c) => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await ops.unwireHumanConsume(human.id, c);
      onChanged?.();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
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
          {suffixCtx && (
            <span style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 3 }}>
              Team labels get <LabelSuffixChip suffix={suffixCtx.suffix} /> appended; labels without it are kept as they are.
            </span>
          )}
          <p style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginTop: 4, lineHeight: 1.5 }}>
            A label a human applies is a gate — an agent emitting it is a hard error.
          </p>
          {/* "On approval, wake…" (#1005, concept A9): the same picker the gate
              dialog offers, so a gate label authored here is routable in place —
              picking an agent wires the claimed listener via the engine. */}
          {triggerOps && (human.emits || []).map(l => (
            <GateWakePicker key={l} label={l} human={human} peers={peers}
              ops={triggerOps} humanOps={ops} busy={busy} onChanged={onChanged} />
          ))}
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
                <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 10, color: '#6d28d9', background: 'rgba(124,58,237,0.10)', border: '1px solid rgba(124,58,237,0.35)', borderRadius: 3, padding: '1px 3px 1px 5px' }}>
                  {consumeLabel(c)}
                  <button type="button" title="Unwire this delivery" disabled={busy} onClick={() => unwireConsume(c)}
                    style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, margin: 0, lineHeight: 0, color: '#6d28d9', opacity: 0.65, cursor: busy ? 'wait' : 'pointer' }}>
                    <X size={11} />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 'var(--eb-space-2)' }}>
          <button disabled={busy || !dirty} onClick={save}
            style={{ background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontSize: 'var(--eb-text-sm)', cursor: busy ? 'wait' : (dirty ? 'pointer' : 'default'), opacity: dirty ? 1 : 0.5 }}>
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
