import React, { useState } from 'react';
import { ShieldCheck, OctagonPause, Trash2 } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import ConfirmDialog from '../../components/ConfirmDialog';
import PageHelpButton from '../../components/PageHelpButton';
import { useHelpSubject } from '../../context/HelperChatContext';
import { OVERLAY_FLOW_LABELS } from '../../context/page-help-view.js';
import { FLOWS_HELP_SECTIONS } from './flows-help-sections';
import { registryRows } from './label-registry-ops';
import { SuffixedLabelText } from '../../components/SuffixedLabelInput';

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
//
// Unused labels (#2716): a registry entry no flow element references (the
// server reports them as `graph.unusedLabels`) is marked and deletable, one by
// one or all at once, via `ops.removeLabels(names)` — which re-checks usage
// server-side right before the write. Labels in use offer no delete.
const KINDS = [
  { value: 'agent', title: 'Agent label', hint: 'set and consumed by agents (default)' },
  { value: 'gate', title: 'Human gate · 👤 → flow', hint: 'only a person applies it — it admits or approves work; an agent setting it is an error' },
  { value: 'brake', title: 'Brake · flow → 👤', hint: 'an agent applies it to pause and hand the decision to a person' },
];

export default function LabelRegistryPanel({ labels = [], unusedLabels = [], ops, onClose, onChanged }) {
  // The "?" below lives inside a SidePanel (backdrop 60 / panel 61). Without a
  // published subject the help panel opens at z-index 50 — i.e. BEHIND the very
  // panel it is explaining, which reads as "the button does nothing" (#1984,
  // the bug #1990 flagged on this page and left for this ticket).
  useHelpSubject({ overlay: OVERLAY_FLOW_LABELS });
  // graph.labels is the full known set with current flags — keep a local copy
  // so a change renders immediately while the write + refetch run.
  const [rows, setRows] = useState(() => registryRows(labels, unusedLabels));
  const [busy, setBusy] = useState(null); // label name being written
  const [error, setError] = useState(null);
  const [pendingDelete, setPendingDelete] = useState(null); // label names awaiting confirmation
  const unusedNames = rows.filter(r => r.unused).map(r => r.name);

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

  const confirmDelete = async () => {
    const names = pendingDelete;
    if (!names || busy) return;
    setBusy(names.length === 1 ? names[0] : '*'); setError(null);
    try {
      await ops.removeLabels(names);
      setRows(rs => rs.filter(r => !names.includes(r.name)));
      onChanged?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(null);
      setPendingDelete(null);
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
        <PageHelpButton
          label="How gates and brakes work"
          size={13}
          section={FLOWS_HELP_SECTIONS.humans}
          style={{ padding: 0, verticalAlign: '-2px' }}
        />
      </p>
      {error && (
        <div style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-2)' }}>{error}</div>
      )}
      {unusedNames.length > 0 && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 'var(--eb-space-2)' }}>
          <button
            type="button"
            disabled={!!busy}
            onClick={() => setPendingDelete(unusedNames)}
            title="Delete every label that no part of this flow uses"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'none', color: 'var(--eb-status-error-text)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              padding: '4px 8px', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
              cursor: busy ? 'wait' : 'pointer',
            }}
          ><Trash2 size={13} /> Delete all unused ({unusedNames.length})</button>
        </div>
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
              <span style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
                <SuffixedLabelText label={row.name} codeStyle={{ fontSize: 'var(--eb-text-xs)', overflowWrap: 'anywhere' }} />
                {row.unused && (
                  <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>
                    not used in this flow
                  </span>
                )}
              </span>
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
              {row.unused && (
                <button
                  type="button"
                  aria-label={`Delete label ${row.name}`}
                  title="Delete this unused label from the registry"
                  disabled={!!busy}
                  onClick={() => setPendingDelete([row.name])}
                  style={{ background: 'none', border: 'none', cursor: busy ? 'wait' : 'pointer', color: 'var(--eb-status-error)', padding: 2 }}
                ><Trash2 size={14} /></button>
              )}
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={!!pendingDelete}
        title={pendingDelete && pendingDelete.length > 1 ? 'Delete all unused labels?' : 'Delete label?'}
        message={pendingDelete ? deleteMessage(pendingDelete) : ''}
        variant="danger"
        confirmLabel="Delete"
        busy={!!busy}
        onConfirm={confirmDelete}
        onCancel={() => setPendingDelete(null)}
      />
    </SidePanel>
  );
}

// Confirmation copy (#2716): names the label(s) and states what is NOT touched.
function deleteMessage(names) {
  const tail = ' from the registry? Nothing in the flow uses it, and the label on GitHub is not touched.';
  if (names.length === 1) return <p style={{ margin: 0 }}>Delete <code>{names[0]}</code>{tail}</p>;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <p style={{ margin: 0 }}>Delete these {names.length} unused labels from the registry? Labels in use and their gate/brake setting stay unchanged; labels on GitHub are not touched.</p>
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>{names.map((n, i) => <span key={n}>{i ? ', ' : ''}<code>{n}</code></span>)}</p>
    </div>
  );
}
