import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import {
  consumeSyncStream,
  syncEventRow,
  repoRowTone,
  summaryText,
} from '../pages/sync-repos-view.js';
import {
  repositoryChangeLines,
  repositoryChangeNotice,
  propagatableCount,
} from '../pages/working-env-repo-diff.js';
import PageHelpButton from './PageHelpButton';
import { useHelpSubject } from '../context/HelperChatContext';
import { OVERLAY_ENV_PROPAGATION } from '../context/page-help-view.js';
// #2170: the standalone Working Environments page (and its help topic) is
// retired — this dialog is now reached only from the team's Settings tab, so
// its chapter lives in the agent-chat topic alongside the rest of that tab.
import { AGENT_CHAT_HELP_SECTIONS } from '../pages/agent-chat/agent-chat-help-sections.js';

/**
 * The save-time propagation offer (#2066, D3/D5) — and the same dialog behind
 * the environment list's "not up to date" catch-up.
 *
 * It replaces the manual "Sync all agents" panel on the environment form, which
 * required an order nothing in the UI stated (Save → re-open Edit → Sync) and
 * silently reported success for the previous repository list when pressed
 * before the save. This opens the moment the save SUCCEEDS, which is the only
 * moment at which the persisted list is authoritative and the diff against it
 * is known.
 *
 * Deliberately NOT the shared ConfirmDialog: this one turns into a progress
 * report in place — the accept button becomes the run, the body fills with one
 * line per repository per agent, and the dialog stays open afterwards so the
 * result can be read. A ConfirmDialog closes on confirm.
 *
 * The save is already committed before this ever renders (AC7): accepting,
 * declining, a failure and closing the browser all leave the environment
 * persisted exactly as submitted. Nothing here can roll it back.
 *
 * Props:
 *   open        — render at all
 *   envId       — environment whose agents are propagated to
 *   envName     — display name for the copy
 *   diff        — classifyRepositoryChanges() result; null for a catch-up run,
 *                 which has no save-time diff (see `catchUp`)
 *   agents      — [{ id, displayName }] the propagation will reach
 *   catchUp     — true for the out-of-date indicator's run: derived from the
 *                 workspace state, so it states what it will do rather than
 *                 what changed
 *   onClose     — close; also the decline path (declining changes nothing, AC8)
 *   onFinished  — called once a run completes, so the caller can re-read the
 *                 out-of-date indicator
 */
export default function RepoPropagationDialog({
  open,
  envId,
  envName,
  diff = null,
  agents = [],
  catchUp = false,
  onClose,
  onFinished,
}) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState('');
  const acceptRef = useRef(null);

  // This is a full-screen dialog at z-index 9999, so without publishing an
  // overlay subject the panelZIndex lift never happens and the "?" would open
  // the help panel BEHIND the decision it exists to inform — the
  // `modal:user-delete` story (#1996) on a decision that writes into other
  // agents' workspaces. Gated on `open` because the component keeps its hooks
  // above the early return.
  useHelpSubject({ overlay: OVERLAY_ENV_PROPAGATION, active: open });

  // D5: accept is the preselected, primary action — focused on open, so Enter
  // confirms it. The propagation still needs the explicit press; a save never
  // propagates on its own.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => acceptRef.current?.focus(), 0);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [open]);

  // Escape is the decline path, matching ConfirmDialog — and inert while a run
  // is in flight for the same reason the backdrop is: the run has already
  // written into other workspaces and the report of what it did is the only
  // copy.
  useEffect(() => {
    if (!open || running) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, running, onClose]);

  useEffect(() => {
    if (!open) {
      setRunning(false);
      setRows([]);
      setSummary(null);
      setErr('');
    }
  }, [open]);

  if (!open) return null;

  const agentCount = agents.length;
  const lines = catchUp ? [] : repositoryChangeLines(diff);
  const toDo = catchUp ? 1 : propagatableCount(diff);
  const done = summary !== null || !!err;

  async function accept() {
    setRunning(true);
    setRows([]);
    setSummary(null);
    setErr('');
    const collected = [];
    const push = (row) => { collected.push(row); setRows(collected.slice()); };
    try {
      const res = await fetch(`/api/environments/${encodeURIComponent(envId)}/sync-agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok && !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const complete = await consumeSyncStream(res, (ev) => {
        const row = syncEventRow(ev, { showAgentHeaders: true });
        if (row) push(row);
      });
      setSummary((complete && complete.totals) || {});
    } catch (e) {
      setErr((e && e.message) || 'Bringing the agents up to date failed');
    } finally {
      setRunning(false);
      // Even a failed or partial run changes the workspace state, so the
      // indicator must be re-read either way — that is what makes the run
      // resumable without a repair step.
      onFinished?.();
    }
  }

  const title = catchUp
    ? `Bring agents up to date — ${envName || envId}`
    : `Repositories changed — ${envName || envId}`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        position: 'fixed', inset: 0, zIndex: 9999,
        background: 'rgba(0,0,0,0.5)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--eb-space-4)',
      }}
      // Closing by backdrop is the decline path; while a run is in flight it is
      // inert, because the run writes into other people's workspaces and a
      // stray click should not lose the report of what it did.
      onClick={() => { if (!running) onClose?.(); }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          padding: 'var(--eb-space-4)',
          maxWidth: 620, width: '100%', maxHeight: '80vh',
          display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <h3 style={{ margin: 0, fontSize: 'var(--eb-text-md)', color: 'var(--eb-text-primary)', flex: 1 }}>
            {title}
          </h3>
          {/* Lands on the propagation's own sub-section inside the Repositories
              chapter — the D1 safety rule, the removal warning and the badge
              are all one scroll from there. */}
          <PageHelpButton
            label="What bringing agents up to date does"
            size={14}
            style={{ padding: 0 }}
            section={AGENT_CHAT_HELP_SECTIONS.bringingAgentsUpToDate}
          />
        </div>

        <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {catchUp
              ? `${agentCount} agent${agentCount === 1 ? '' : 's'} using this environment ${agentCount === 1 ? 'is' : 'are'} `
                + 'not up to date with its repository list. Bring them up to date now? '
                + 'Missing repositories are cloned and diverging ones adjusted — but only where the '
                + 'existing clone is clean and fully pushed. Nothing is ever deleted.'
              : repositoryChangeNotice({ diff, agentCount })}
          </div>

          {lines.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
              {lines.map((line) => (
                <li
                  key={line.kind}
                  style={{
                    fontSize: 'var(--eb-text-sm)',
                    color: line.tone === 'warning' ? 'var(--eb-status-warning)' : 'var(--eb-text-secondary)',
                  }}
                >
                  {line.tone === 'warning' && (
                    <AlertTriangle
                      size={13}
                      style={{ verticalAlign: -2, marginRight: 4, flexShrink: 0 }}
                    />
                  )}
                  {line.text}
                </li>
              ))}
            </ul>
          )}

          {(rows.length > 0 || summary || err) && (
            <div
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-app)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
                maxHeight: 240, overflowY: 'auto',
              }}
            >
              {rows.map((row, i) => (
                row.kind === 'agent'
                  ? (
                    <div key={i} style={{ marginTop: i ? 'var(--eb-space-2)' : 0, color: 'var(--eb-text-primary)', fontWeight: 600 }}>
                      {row.text}
                    </div>
                  )
                  : (
                    <div
                      key={i}
                      style={{ color: row.kind === 'note' ? 'var(--eb-text-muted)' : repoRowTone(row.status, row.blocked), paddingLeft: 'var(--eb-space-3)' }}
                    >
                      {row.symbol ? `${row.symbol} ` : ''}{row.text}
                    </div>
                  )
              ))}
              {summary && (
                <div style={{ marginTop: 'var(--eb-space-2)', color: 'var(--eb-text-secondary)' }}>
                  {summaryText(summary)}
                </div>
              )}
              {err && <div style={{ color: 'var(--eb-status-error)' }}>{err}</div>}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          {!done && toDo > 0 && (
            <button
              type="button"
              onClick={() => onClose?.()}
              disabled={running}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'transparent', border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
                fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
                cursor: running ? 'not-allowed' : 'pointer', opacity: running ? 0.6 : 1,
              }}
            >
              Not now
            </button>
          )}
          {(done || toDo === 0) ? (
            // A removal-only diff has nothing to propagate — nothing is ever
            // deleted from an agent — so the dialog acknowledges rather than
            // offering a disabled primary action for a pass that would do
            // nothing (the repo-less case of #1623 lands here too).
            <button
              type="button"
              ref={acceptRef}
              onClick={() => onClose?.()}
              style={primaryStyle(false)}
            >
              {done ? 'Close' : 'Got it'}
            </button>
          ) : (
            <button
              type="button"
              ref={acceptRef}
              onClick={accept}
              disabled={running}
              style={primaryStyle(running)}
            >
              {running && <Loader2 size={13} style={{ animation: 'repo-prop-spin 1s linear infinite', marginRight: 6, verticalAlign: -2 }} />}
              {running ? 'Bringing up to date…' : 'Bring agents up to date'}
            </button>
          )}
        </div>
        <style>{'@keyframes repo-prop-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
      </div>
    </div>
  );
}

function primaryStyle(disabled) {
  return {
    padding: 'var(--eb-space-2) var(--eb-space-3)',
    background: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
    borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-inverted)',
    fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.6 : 1,
  };
}
