import React from 'react';
import { AlertTriangle, Loader2, RefreshCw } from 'lucide-react';
import Modal from '../../components/Modal';
import { describeLiveItem } from './flow-copilot-live';
import { ADD_ROLE_MATERIALIZE_HINT, ADD_ROLE_MATERIALIZE_LABEL } from './add-role-materialize';

// LiveApplyDialog (#2556) — the confirmation a live-team Copilot proposal must
// pass before anything reaches the running agents (AC4). Presentational only:
// the panel owns the state (`confirm`) and every decision comes from the pure
// `liveConfirmModel` in flow-copilot-live.js.
//
// Props:
//   confirm   — { phase: 'checking'|'stale'|'ready'|'applying'|'error', model?,
//                 selected: Set<itemKey>, newAgentsNow, error? } | null
//   onToggleRemoval(key), onToggleNewAgentsNow()
//   onConfirm, onCancel (keeps the proposal), onRegenerate (stale base, AC15)
export default function LiveApplyDialog({ confirm, onToggleRemoval, onToggleNewAgentsNow, onConfirm, onCancel, onRegenerate }) {
  if (!confirm) return null;
  const { phase, model, selected, newAgentsNow, error } = confirm;
  const applying = phase === 'applying';
  const hasNewAgents = !!(model && model.groups.added.some(it => it.entity === 'role'));
  const footer = (
    <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
      <button onClick={onCancel} disabled={applying} style={secondaryBtn(applying)}>Cancel</button>
      {phase === 'stale' ? (
        <button onClick={onRegenerate} style={primaryBtn(false)}>
          <RefreshCw size={13} /> Regenerate
        </button>
      ) : (
        <button
          onClick={onConfirm}
          disabled={phase !== 'ready' || !model || model.empty}
          style={primaryBtn(phase !== 'ready' || !model || model.empty)}
        >
          {applying && <Loader2 size={13} style={{ animation: 'eb-copilot-spin 1s linear infinite' }} />}
          Apply to live team
        </button>
      )}
    </div>
  );

  return (
    <Modal open onClose={applying ? undefined : onCancel} title="Apply to the live team?" maxWidth={600} footer={footer}>
      <div style={{ padding: 'var(--eb-space-4) var(--eb-space-5)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.5 }}>
        {phase === 'checking' && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--eb-text-muted)' }}>
            <Loader2 size={14} style={{ animation: 'eb-copilot-spin 1s linear infinite' }} />
            Checking the team's current state…
          </div>
        )}

        {phase === 'stale' && (
          <Notice tone="warning">
            The team has changed since this proposal was generated — applying it would overwrite
            those changes. Nothing was applied. Regenerate the proposal from the team's current state.
          </Notice>
        )}

        {phase === 'error' && <Notice tone="error">{error}</Notice>}

        {model && phase !== 'stale' && (
          <>
            <Notice tone="warning">
              These changes take effect on the <strong>running agents immediately</strong> — prompts,
              hand-offs and derived triggers are rewritten as soon as you confirm.
            </Notice>

            {model.empty && (
              <div style={{ color: 'var(--eb-text-secondary)' }}>
                Nothing in this proposal can be applied to a live team.
              </div>
            )}

            {['added', 'changed', 'removed'].map(g => (model.groups[g].length > 0 && (
              <Section key={g} title={g === 'added' ? 'Added' : g === 'changed' ? 'Changed' : 'Removed'}>
                {model.groups[g].map(it => <li key={it.key}>{describeLiveItem(it)}</li>)}
              </Section>
            )))}

            {model.notes.length > 0 && (
              <Section title="Notes">{model.notes.map(n => <li key={n}>{n}</li>)}</Section>
            )}

            {model.removals.length > 0 && (
              <div>
                <div style={sectionTitle}>Removals — tick each one you want (none are applied by default)</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  {model.removals.map(r => (
                    <label key={r.key} style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: applying ? 'default' : 'pointer' }}>
                      <input type="checkbox" checked={selected.has(r.key)} disabled={applying}
                        onChange={() => onToggleRemoval(r.key)} style={{ marginTop: 3 }} />
                      <span>
                        {r.label}
                        <InProgress work={r.inProgress} />
                      </span>
                    </label>
                  ))}
                </div>
              </div>
            )}

            {hasNewAgents && (
              <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', cursor: applying ? 'default' : 'pointer' }}>
                <input type="checkbox" checked={newAgentsNow} disabled={applying}
                  onChange={onToggleNewAgentsNow} style={{ marginTop: 3 }} />
                <span>
                  {ADD_ROLE_MATERIALIZE_LABEL}
                  <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>{ADD_ROLE_MATERIALIZE_HINT}</div>
                </span>
              </label>
            )}

            {model.gates.length > 0 && (
              <Notice tone="warning">
                This touches human approval gates — labels a person applies and agents never set.
                Check that the people who approve still have a gate to apply:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>{model.gates.map(g => <li key={g}>{g}</li>)}</ul>
              </Notice>
            )}

            {model.notApplied.length > 0 && (
              <Section title="Not applied — not supported on a live team">
                {model.notApplied.map(n => <li key={n}>{n}</li>)}
              </Section>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function InProgress({ work }) {
  if (work === null) {
    return <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>In-progress work: unknown (the ticket ledger could not be read).</div>;
  }
  if (!work || work.length === 0) return null;
  return (
    <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-warning)' }}>
      In progress:{' '}
      {work.map((w, i) => (
        <React.Fragment key={w.label}>
          {i > 0 && ', '}
          {w.url ? <a href={w.url} target="_blank" rel="noreferrer" style={{ color: 'inherit' }}>{w.label}</a> : w.label}
          {w.openPr ? ' (open PR)' : ''}
        </React.Fragment>
      ))}
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div style={sectionTitle}>{title}</div>
      <ul style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 2, color: 'var(--eb-text-secondary)' }}>{children}</ul>
    </div>
  );
}

function Notice({ tone, children }) {
  const color = tone === 'error' ? 'var(--eb-status-error)' : 'var(--eb-status-warning)';
  return (
    <div style={{ display: 'flex', gap: 8, border: `1px solid ${color}`, borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2) var(--eb-space-3)' }}>
      <AlertTriangle size={14} style={{ color, flexShrink: 0, marginTop: 3 }} />
      <div>{children}</div>
    </div>
  );
}

const sectionTitle = {
  fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-muted)',
  textTransform: 'uppercase', letterSpacing: 0.3, marginBottom: 4,
};

function primaryBtn(disabled) {
  return {
    display: 'inline-flex', alignItems: 'center', gap: 6,
    background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
    borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit',
    fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}

function secondaryBtn(disabled) {
  return {
    background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
  };
}
