import React, { useEffect, useState } from 'react';
import { Loader2, Send, X, ArrowRight } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';

/**
 * HandoffDialog -- Modal for the FreeFlow hand-off action on a bp-instance.
 *
 * On mount, fetches GET /api/agents/:id/handover/candidates which returns
 * `{ source, suggested, siblings }`. Suggested entries (depends-on /
 * input-artifact dependents from the orchestrator's .index.json) are
 * preselected; siblings without a graph edge are deselected by default but
 * available so the user can pick targets the graph doesn't know about.
 *
 * On submit, POSTs to /api/agents/:id/handover with the chosen targets and
 * the shared free-text note. The orchestrator+admin-console fan-out
 * materializes each target stub, ensures a DM room, and posts the note as
 * a normal m.text DM — the receiving agent's existing DM handler picks it
 * up like any user message and starts working.
 *
 * Props:
 *   open       boolean, whether the dialog is visible
 *   agent      object, the source bp-instance agent (with id + displayName)
 *   onClose    fn(), called on cancel or after successful close
 *   onSent     fn(result), called after a fan-out completes (for toasts/refresh)
 */
export default function HandoffDialog({ open, agent, onClose, onSent }) {
  const [phase, setPhase]            = useState('loading'); // loading | ready | sending | done | error
  const [error, setError]            = useState(null);
  const [candidates, setCandidates]  = useState(null);     // { source, suggested, siblings }
  const [selected, setSelected]      = useState(new Set()); // agentId set
  const [note, setNote]              = useState('');
  const [results, setResults]        = useState(null);

  /* Load candidates whenever the dialog opens for a fresh agent. */
  useEffect(() => {
    if (!open || !agent?.id) return;
    let cancelled = false;
    setPhase('loading');
    setError(null);
    setCandidates(null);
    setSelected(new Set());
    setNote('');
    setResults(null);

    apiCall('GET', `/api/agents/${agent.id}/handover/candidates`)
      .then((data) => {
        if (cancelled) return;
        setCandidates(data);
        const preselect = new Set((data?.suggested || []).map((s) => s.agentId));
        setSelected(preselect);
        setPhase('ready');
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err.message || String(err));
        setPhase('error');
      });

    return () => { cancelled = true; };
  }, [open, agent?.id]);

  /* Esc to close (only when not actively sending). */
  useEffect(() => {
    if (!open) return;
    function handleKey(e) {
      if (e.key === 'Escape' && phase !== 'sending') onClose?.();
    }
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [open, phase, onClose]);

  if (!open) return null;

  /* Merge suggested + siblings so each agent appears once, with the
   * stronger "suggested" reason winning. Suggested first, then untracked
   * siblings — preserves an obvious visual hierarchy. */
  const rows = (() => {
    if (!candidates) return [];
    const seen = new Set();
    const out = [];
    for (const s of (candidates.suggested || [])) {
      seen.add(s.agentId);
      out.push({ ...s, suggested: true });
    }
    for (const s of (candidates.siblings || [])) {
      if (seen.has(s.agentId)) continue;
      seen.add(s.agentId);
      out.push({ ...s, suggested: false, reason: null });
    }
    return out;
  })();

  function toggle(id) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleSubmit() {
    const targets = [...selected];
    if (targets.length === 0) {
      setError('Pick at least one target.');
      return;
    }
    setPhase('sending');
    setError(null);
    setResults(null);
    try {
      const result = await apiCall('POST', `/api/agents/${agent.id}/handover`, {
        targets,
        note: note.trim(),
      });
      setResults(result);
      setPhase('done');
      onSent?.(result);
    } catch (err) {
      setError(err.message || String(err));
      setPhase('error');
    }
  }

  const sourceLabel = candidates?.source?.displayName || agent?.displayName || agent?.id;

  return (
    <div role="dialog" aria-modal="true" aria-label="Hand-off" style={overlayStyle}>
      <div style={dialogStyle}>
        <div style={headerStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
            <ArrowRight size={18} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
            <div style={{ minWidth: 0 }}>
              <h3 style={titleStyle}>Hand-off from {sourceLabel}</h3>
              <p style={subtitleStyle}>
                Pick the downstream agents to activate. Each gets your note as a chat message and will start working when they receive it.
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => phase !== 'sending' && onClose?.()}
            disabled={phase === 'sending'}
            aria-label="Close"
            style={closeBtnStyle(phase === 'sending')}
          >
            <X size={16} />
          </button>
        </div>

        <div style={bodyStyle}>
          {phase === 'loading' && (
            <div style={statusStyle}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading candidates…
            </div>
          )}
          {phase === 'error' && error && (
            <div style={errorStyle}>{error}</div>
          )}
          {phase !== 'loading' && rows.length === 0 && phase !== 'error' && (
            <div style={statusStyle}>
              No sibling bp-instance agents under the same orchestrator — nothing to hand off to.
            </div>
          )}

          {rows.length > 0 && (
            <>
              <div style={listStyle}>
                {rows.map((row) => {
                  const checked = selected.has(row.agentId);
                  return (
                    <label key={row.agentId} style={rowStyle(checked)}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={() => toggle(row.agentId)}
                        disabled={phase === 'sending' || phase === 'done'}
                        style={{ marginTop: 3 }}
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                          <span style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
                            {row.displayName}
                          </span>
                          <code style={idStyle}>{row.agentId}</code>
                          {!row.materialized && <span style={badgeStyle('var(--eb-status-warning)')}>stub</span>}
                          {row.suggested && row.reason === 'depends-on' && (
                            <span style={badgeStyle('var(--eb-accent-primary)')}>depends-on</span>
                          )}
                          {row.suggested && row.reason === 'input-artifact' && (
                            <span style={badgeStyle('var(--eb-accent-primary)')}>input-artifact</span>
                          )}
                          {!row.suggested && (
                            <span style={badgeStyle('var(--eb-text-muted)')}>sibling</span>
                          )}
                        </div>
                        {row.suggested && row.reason === 'input-artifact' && Array.isArray(row.paths) && row.paths.length > 0 && (
                          <div style={pathsStyle}>
                            {row.paths.map((p) => <code key={p} style={pathChipStyle}>{p}</code>)}
                          </div>
                        )}
                      </div>
                    </label>
                  );
                })}
              </div>

              <label style={{ display: 'block', marginTop: 'var(--eb-space-3)' }}>
                <span style={labelStyle}>Hand-off note</span>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  disabled={phase === 'sending' || phase === 'done'}
                  placeholder="What did you finish, what should the downstream agents do? This goes into each target's chat as a normal user message."
                  rows={5}
                  style={textareaStyle}
                />
                <span style={hintStyle}>
                  Plain text is fine — it lands as `m.text` in each target's DM and triggers a normal Claude response.
                </span>
              </label>
            </>
          )}

          {results && (
            <div style={resultsStyle}>
              <div style={resultsTitleStyle}>
                Sent to {results.sent}/{results.total} target{results.total === 1 ? '' : 's'}
              </div>
              <ul style={resultsListStyle}>
                {(results.results || []).map((r) => (
                  <li key={r.agentId} style={resultItemStyle(r.ok)}>
                    <code style={idStyle}>{r.agentId}</code>
                    {r.ok ? ' ✓ delivered' : ` ✗ failed (${r.stage}: ${r.error})`}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>

        <div style={footerStyle}>
          <button
            type="button"
            onClick={() => onClose?.()}
            disabled={phase === 'sending'}
            style={cancelBtnStyle(phase === 'sending')}
          >
            {phase === 'done' ? 'Close' : 'Cancel'}
          </button>
          {phase !== 'done' && (
            <button
              type="button"
              onClick={handleSubmit}
              disabled={phase !== 'ready' || selected.size === 0}
              style={confirmBtnStyle(phase !== 'ready' || selected.size === 0)}
            >
              {phase === 'sending'
                ? <><Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} /> Sending…</>
                : <><Send size={13} /> Hand off to {selected.size || 0}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/* ─── Styles ─────────────────────────────────────────────────────────── */

const overlayStyle = {
  position: 'fixed',
  inset: 0,
  background: 'oklch(0 0 0 / 0.5)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 9999,
  padding: 'var(--eb-space-4)',
};

const dialogStyle = {
  background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-lg)',
  width: '100%',
  maxWidth: 640,
  maxHeight: '90vh',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: 'var(--eb-shadow-xl)',
};

const headerStyle = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--eb-space-3)',
  padding: 'var(--eb-space-4)',
  borderBottom: '1px solid var(--eb-border-default)',
};

const titleStyle = {
  margin: 0,
  fontSize: 'var(--eb-text-md)',
  fontWeight: 'var(--eb-font-semibold)',
  color: 'var(--eb-text-primary)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
};

const subtitleStyle = {
  margin: '4px 0 0',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  lineHeight: 1.5,
};

const closeBtnStyle = (disabled) => ({
  background: 'none',
  border: 'none',
  cursor: disabled ? 'not-allowed' : 'pointer',
  color: 'var(--eb-text-muted)',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
});

const bodyStyle = {
  flex: 1,
  overflowY: 'auto',
  padding: 'var(--eb-space-4)',
};

const statusStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-muted)',
};

const errorStyle = {
  padding: 'var(--eb-space-3)',
  background: 'var(--eb-status-error-bg)',
  border: '1px solid var(--eb-status-error)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  color: 'var(--eb-text-primary)',
};

const listStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-1, 4px)',
};

const rowStyle = (checked) => ({
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  border: `1px solid ${checked ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
  borderRadius: 'var(--eb-radius-md)',
  background: checked ? 'var(--eb-bg-hover, var(--eb-bg-elevated))' : 'var(--eb-bg-surface)',
  cursor: 'pointer',
});

const idStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  background: 'var(--eb-bg-elevated)',
  padding: '1px 6px',
  borderRadius: 4,
};

const badgeStyle = (color) => ({
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 4,
  border: `1px solid ${color}`,
  color,
  fontWeight: 'var(--eb-font-medium)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
});

const pathsStyle = {
  marginTop: 4,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
};

const pathChipStyle = {
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 11,
  background: 'var(--eb-bg-elevated)',
  padding: '1px 5px',
  borderRadius: 3,
  color: 'var(--eb-text-secondary)',
};

const labelStyle = {
  display: 'block',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 4,
};

const textareaStyle = {
  width: '100%',
  fontFamily: 'inherit',
  fontSize: 'var(--eb-text-sm)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  resize: 'vertical',
  minHeight: 90,
  boxSizing: 'border-box',
};

const hintStyle = {
  display: 'block',
  marginTop: 4,
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
};

const resultsStyle = {
  marginTop: 'var(--eb-space-3)',
  padding: 'var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
};

const resultsTitleStyle = {
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  color: 'var(--eb-text-primary)',
  marginBottom: 6,
};

const resultsListStyle = {
  margin: 0,
  paddingLeft: 18,
  fontSize: 'var(--eb-text-xs)',
};

const resultItemStyle = (ok) => ({
  color: ok ? 'var(--eb-status-success)' : 'var(--eb-status-error)',
  marginBottom: 2,
});

const footerStyle = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 'var(--eb-space-2)',
  padding: 'var(--eb-space-3) var(--eb-space-4)',
  borderTop: '1px solid var(--eb-border-default)',
};

const cancelBtnStyle = (disabled) => ({
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.6 : 1,
  fontFamily: 'inherit',
});

const confirmBtnStyle = (disabled) => ({
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: disabled ? 'not-allowed' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  display: 'inline-flex',
  alignItems: 'center',
  gap: 6,
  fontFamily: 'inherit',
});
