import React, { useState } from 'react';
import { Plus, Trash2, User, X } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import PageHelpButton from '../../components/PageHelpButton';
import { useHelpSubject } from '../../context/HelperChatContext';
import { OVERLAY_FLOW_HUMANS } from '../../context/page-help-view.js';
import { FLOWS_HELP_SECTIONS } from './flows-help-sections';
import { slugifyHumanId } from './humans-registry-ops';

// Human-role registry editor (#987) — named, purely-declarative human flow
// nodes ("Issue Reviewer", type Human). Each row edits name / description /
// stage / the labels this person applies (`emits`, implicitly gates). The
// `consumes` list (artifacts/brakes that land with the person) is usually
// created by wiring or the node inspector, but each entry carries a per-chip
// unwire (#2063) so a dead producer's dangling ref is removable here too.
// Mode-agnostic: every write goes through the injected `ops.upsertHuman(human)`
// / `ops.removeHuman(id)` / `ops.unwireHumanConsume(id, entry)` — draft ops
// persist the bundle's `humans[]`, live ops persist the team agent's registry.
const inputStyle = {
  background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: '5px 7px', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)', width: '100%', boxSizing: 'border-box',
};

function consumeLabel(c) {
  if (c && c.label) return `⏸ brake · ${c.label}`;
  if (c && (c.artifact === 'pr' || c.artifact === 'issue')) return `⇤ ${c.artifact} · ${c.from}`;
  if (c && c.artifact === 'file') return `⇤ file · ${c.name}`;
  return '';
}

function HumanRow({ human, stages, onSave, onRemove, onUnwireConsume, busy }) {
  const [name, setName] = useState(human.name || human.id);
  const [description, setDescription] = useState(human.description || '');
  const [stage, setStage] = useState(human.stage || '');
  const [emitsText, setEmitsText] = useState((human.emits || []).join(', '));

  const dirty = name !== (human.name || human.id)
    || description !== (human.description || '')
    || stage !== (human.stage || '')
    || emitsText !== (human.emits || []).join(', ');

  const save = () => {
    const emits = emitsText.split(',').map(s => s.trim()).filter(Boolean);
    onSave({ ...human, id: human.id, name: name.trim() || human.id, description, stage, emits });
  };

  return (
    <div style={{ borderTop: '1px solid var(--eb-border-default)', padding: '10px 4px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <User size={14} style={{ color: '#7c3aed', flexShrink: 0 }} />
        <code style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', flex: 1, overflowWrap: 'anywhere' }}>{human.id}</code>
        <button
          title="Remove this human role"
          disabled={busy}
          onClick={() => onRemove(human.id)}
          style={{ background: 'none', border: 'none', cursor: busy ? 'wait' : 'pointer', color: 'var(--eb-status-error)', padding: 2 }}
        ><Trash2 size={14} /></button>
      </div>
      <input style={inputStyle} value={name} placeholder="Display name" disabled={busy}
        onChange={e => setName(e.target.value)} />
      <input style={inputStyle} value={description} placeholder="Description (optional)" disabled={busy}
        onChange={e => setDescription(e.target.value)} />
      <select style={inputStyle} value={stage} disabled={busy} onChange={e => setStage(e.target.value)}>
        <option value="">— no stage —</option>
        {stages.map(s => <option key={s} value={s}>{s}</option>)}
      </select>
      <label style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
        Labels this person applies (gates), comma-separated
        <input style={{ ...inputStyle, marginTop: 3 }} value={emitsText} placeholder="e.g. dispatch, approved" disabled={busy}
          onChange={e => setEmitsText(e.target.value)} />
      </label>
      {(human.consumes || []).length > 0 && (
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
          {(human.consumes || []).map((c, i) => (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 9, color: '#6d28d9', background: 'rgba(124,58,237,0.10)', border: '1px solid rgba(124,58,237,0.35)', borderRadius: 3, padding: '0 2px 0 4px' }}>
              {consumeLabel(c)}
              <button type="button" title="Unwire this delivery" disabled={busy} onClick={() => onUnwireConsume(c)}
                style={{ display: 'inline-flex', alignItems: 'center', background: 'none', border: 'none', padding: 0, margin: 0, lineHeight: 0, color: '#6d28d9', opacity: 0.65, cursor: busy ? 'wait' : 'pointer' }}>
                <X size={10} />
              </button>
            </span>
          ))}
        </div>
      )}
      {dirty && (
        <button disabled={busy} onClick={save}
          style={{ alignSelf: 'flex-start', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontSize: 'var(--eb-text-xs)', cursor: busy ? 'wait' : 'pointer' }}
        >Save</button>
      )}
    </div>
  );
}

export default function HumanRegistryPanel({ humans = [], stages = [], ops, onClose, onChanged }) {
  // Lifts the help panel above this SidePanel (60/61) — see LabelRegistryPanel.
  useHelpSubject({ overlay: OVERLAY_FLOW_HUMANS });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [newName, setNewName] = useState('');

  const run = async (p) => {
    if (busy) return;
    setBusy(true); setError(null);
    try { await p; onChanged?.(); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };

  const add = () => {
    const name = newName.trim();
    if (!name) return;
    const id = slugifyHumanId(name) || `human-${humans.length + 1}`;
    // De-dup the id against existing roles.
    let uid = id, n = 2;
    const taken = new Set(humans.map(h => h.id));
    while (taken.has(uid)) uid = `${id}-${n++}`;
    setNewName('');
    run(ops.upsertHuman({ id: uid, name }));
  };

  return (
    <SidePanel open onClose={onClose} title="Human roles" width="520px">
      {/* The "how human roles act in a flow" prose moved into the `flows` help
          topic (#1876) — the "?" is how you reach it from inside the panel. */}
      <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
        Named people who act in the flow — an <strong>Issue Reviewer</strong>, a <strong>Tech Lead</strong>.
        A human role never runs anything; people act through GitHub labels.
        <PageHelpButton
          label="How human roles act in a flow"
          size={13}
          section={FLOWS_HELP_SECTIONS.humans}
          style={{ padding: 0, verticalAlign: '-2px' }}
        />
      </p>
      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>{error}</div>
      )}
      <div style={{ display: 'flex', gap: 6, marginBottom: 'var(--eb-space-2)' }}>
        <input
          style={inputStyle}
          value={newName}
          placeholder="Add a human role (e.g. Issue Reviewer)"
          disabled={busy}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') add(); }}
        />
        <button onClick={add} disabled={busy || !newName.trim()}
          style={{ display: 'inline-flex', alignItems: 'center', gap: 4, background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none', borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontSize: 'var(--eb-text-xs)', cursor: busy ? 'wait' : 'pointer', whiteSpace: 'nowrap' }}>
          <Plus size={13} /> Add
        </button>
      </div>
      {humans.length === 0 ? (
        <p style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
          No human roles yet — add one above, then wire an issue/PR or a gate label to it.
        </p>
      ) : (
        humans.map(h => (
          <HumanRow
            key={h.id}
            human={h}
            stages={stages}
            busy={busy}
            onSave={(next) => run(ops.upsertHuman(next))}
            onRemove={(id) => run(ops.removeHuman(id))}
            onUnwireConsume={(c) => run(ops.unwireHumanConsume(h.id, c))}
          />
        ))
      )}
    </SidePanel>
  );
}
