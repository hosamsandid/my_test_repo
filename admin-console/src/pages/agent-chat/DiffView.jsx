import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Loader2, AlertCircle, RefreshCw, GitBranch, X, FileWarning, ChevronDown,
  DownloadCloud, Trash2, Check,
} from 'lucide-react';
import ConfirmDialog from '../../components/ConfirmDialog';
import { deriveGitControls, discardConfirmMessage } from './git-panel-logic';
import { useSessionsActive } from './SessionsActiveContext';
import { isAgentRunning } from './sessions-active';

/**
 * Workspace Git panel for an agent (issue #648).
 *
 * Top: deterministic git actions — switch local branch, fast-forward update,
 * discard local changes (all executed server-side by the orchestrator, no LLM).
 * Middle: flat list of changed files (status badge, path, +/- counter).
 * Bottom: unified diff for the selected file.
 *
 * Always compares working tree against HEAD. Multi-repo workspaces get a small
 * selector at the top; single-repo workspaces hide it.
 *
 * Props:
 *   - agentId  Selected agent id.
 *   - active   Whether this mode is currently visible. We skip the initial
 *              fetch while the panel is hidden behind another tab/mode.
 */
export default function DiffView({ agentId, active }) {
  const [data, setData]               = useState(null);   // { repos: [...] }
  const [loading, setLoading]         = useState(false);
  const [error, setError]             = useState(null);
  const [selectedRepo, setRepo]       = useState(null);   // repoPath
  const [selected, setSelected]       = useState(null);   // { repoPath, path, status }

  // Whether the agent has a live session (AC7) — derived from the shared
  // active-sessions poll (#1678) rather than a panel-local timer, so this panel
  // no longer runs its own `/sessions/active` interval.
  const { sessions, refresh: refreshSessions } = useSessionsActive();
  const running = isAgentRunning(sessions);

  const [actionBusy, setActionBusy]   = useState(false);  // a git action is in flight
  const [actionMsg, setActionMsg]     = useState(null);   // { kind: 'success'|'error', text }
  const [confirmDiscard, setConfirmDiscard] = useState(false);

  const reqIdRef = useRef(0);

  /* Reset state when the agent changes. */
  useEffect(() => {
    reqIdRef.current += 1;
    setData(null);
    setError(null);
    setRepo(null);
    setSelected(null);
    setActionMsg(null);
    setConfirmDiscard(false);
  }, [agentId]);

  const fetchStatus = useCallback(() => {
    if (!agentId) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace/git-status`)
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (reqId !== reqIdRef.current) return;
        if (!ok) throw new Error(j?.error || 'Failed');
        setData(j);
        // Auto-pick the first dirty repo, or the only repo if none are dirty.
        setRepo(prev => {
          if (prev && (j.repos || []).some(r => r.repoPath === prev)) return prev;
          const dirty = (j.repos || []).find(r => r.changesCount > 0);
          if (dirty) return dirty.repoPath;
          return (j.repos || [])[0]?.repoPath ?? null;
        });
      })
      .catch(e => {
        if (reqId !== reqIdRef.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [agentId]);

  /* Initial fetch when this view becomes active. */
  useEffect(() => {
    if (!active || !agentId) return;
    if (data || loading) return;
    fetchStatus();
  }, [active, agentId, data, loading, fetchStatus]);

  /* Execute a deterministic git action (switch / update / discard) against the
     selected repo (AC8), then auto-refresh status + running state (AC10). */
  const runAction = useCallback((action, repoPath, extra = {}) => {
    if (!agentId || !repoPath || actionBusy) return;
    setActionBusy(true);
    setActionMsg(null);
    fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace/git-action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, repoPath, ...extra }),
    })
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (!ok) throw new Error(j?.error || 'Action failed');
        setActionMsg({ kind: 'success', text: j?.message || 'Done.' });
      })
      .catch(e => setActionMsg({ kind: 'error', text: e.message }))
      .finally(() => {
        setActionBusy(false);
        setConfirmDiscard(false);
        fetchStatus();       // AC10 — refresh status after any successful action
        refreshSessions();   // pull the running-state from the shared poll now
      });
  }, [agentId, actionBusy, fetchStatus, refreshSessions]);

  /* Drop the selected diff if it disappears from the file list (e.g. after
     a refresh). */
  useEffect(() => {
    if (!selected || !data) return;
    const repo = (data.repos || []).find(r => r.repoPath === selected.repoPath);
    if (!repo || !(repo.files || []).some(f => f.path === selected.path)) {
      setSelected(null);
    }
  }, [data, selected]);

  if (!agentId) {
    return <div style={emptyStyle}>Select an agent to inspect its workspace git state.</div>;
  }

  const repos      = data?.repos || [];
  const repoEntry  = repos.find(r => r.repoPath === selectedRepo) || repos[0] || null;
  const files      = repoEntry?.files || [];
  const hasMulti   = repos.length > 1;
  const controls   = deriveGitControls({ repoEntry, running });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar — repo selector + refresh. */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        flexShrink: 0,
      }}>
        {hasMulti ? (
          <RepoSelector
            repos={repos}
            value={selectedRepo}
            onChange={(p) => { setRepo(p); setSelected(null); }}
          />
        ) : (
          <RepoLabel repo={repoEntry} />
        )}
        <div style={{ flex: 1 }} />
        {repoEntry && (
          <span style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            fontFamily: 'var(--eb-font-mono)',
          }}>
            {repoEntry.changesCount === 0
              ? 'clean'
              : `${repoEntry.changesCount} change${repoEntry.changesCount === 1 ? '' : 's'}`}
          </span>
        )}
        <button
          onClick={fetchStatus}
          title="Reload status"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <RefreshCw size={12} />
        </button>
      </div>

      {/* Git actions bar — switch / update / discard for the selected repo. */}
      {repoEntry && (
        <GitActions
          controls={controls}
          repoPath={repoEntry.repoPath}
          busy={actionBusy}
          message={actionMsg}
          onSwitch={(branch) => runAction('switch', repoEntry.repoPath, { branch })}
          onUpdate={() => runAction('update', repoEntry.repoPath)}
          onDiscardRequest={() => setConfirmDiscard(true)}
        />
      )}

      {/* File list (top) — shrinks when a diff is open below, mirroring the
          tree/file-viewer split in the Tree mode. */}
      <div style={{
        flex: selected ? '0 0 40%' : '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        background: 'var(--eb-bg-app)',
      }}>
        <FileList
          loading={loading && !data}
          error={error}
          repos={repos}
          repoEntry={repoEntry}
          files={files}
          selected={selected}
          onSelect={(f) => setSelected({ repoPath: repoEntry.repoPath, path: f.path, status: f.status })}
        />
      </div>

      {/* Diff pane (bottom) — only when a file is selected. */}
      {selected && repoEntry && (
        <DiffPane
          agentId={agentId}
          repoPath={repoEntry.repoPath}
          file={files.find(f => f.path === selected.path) || { path: selected.path, status: selected.status }}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Discard confirmation (AC6) — the only path that destroys uncommitted
          work, so it names the repo and states the change is unrecoverable. */}
      <ConfirmDialog
        open={confirmDiscard && !!repoEntry}
        variant="danger"
        title="Discard local changes?"
        message={discardConfirmMessage(repoEntry?.repoPath)}
        confirmLabel="Discard changes"
        cancelLabel="Cancel"
        busy={actionBusy}
        onConfirm={() => repoEntry && runAction('discard', repoEntry.repoPath)}
        onCancel={() => setConfirmDiscard(false)}
      />
    </div>
  );
}

/* ─── Git actions bar ──────────────────────────────────────────────── */

// Deterministic switch / update / discard controls (#648). All decisions about
// what's enabled come from deriveGitControls(); this component is presentation.
function GitActions({ controls, repoPath, busy, message, onSwitch, onUpdate, onDiscardRequest }) {
  const {
    currentBranch, otherBranches, detached,
    canSwitch, canUpdate, canDiscard,
    switchReason, updateReason, discardReason, dirty, running,
  } = controls;

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 6,
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      borderBottom: '1px solid var(--eb-border-default)',
      background: 'var(--eb-bg-surface)',
      flexShrink: 0,
    }}>
      {running && (
        <div style={bannerStyle('warning')}>
          <AlertCircle size={12} />
          <span>The agent has a running session — git actions are paused until it finishes.</span>
        </div>
      )}

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        {/* Branch switcher (local branches only). */}
        <BranchSwitcher
          currentBranch={detached ? null : currentBranch}
          detached={detached}
          branches={otherBranches}
          disabled={busy || !canSwitch}
          disabledReason={switchReason}
          onSwitch={onSwitch}
        />

        <div style={{ flex: 1 }} />

        <ActionButton
          icon={<DownloadCloud size={12} />}
          label="Update"
          title={canUpdate ? 'Fetch and fast-forward the current branch' : updateReason}
          disabled={busy || !canUpdate}
          onClick={onUpdate}
        />
        <ActionButton
          icon={<Trash2 size={12} />}
          label="Discard…"
          title={canDiscard ? 'Discard all uncommitted changes' : discardReason}
          disabled={busy || !canDiscard}
          danger
          onClick={onDiscardRequest}
        />
      </div>

      {/* AC5: when the tree is dirty, spell out the exactly-two paths — discard
          (above) or ask the agent (the console never commits). */}
      {dirty && !running && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.5 }}>
          Uncommitted changes block branch switch and update. Either <strong>Discard…</strong> them,
          or ask the agent in chat to commit — the console never commits for you.
        </div>
      )}

      {busy && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite' }} />
          <span>Working…</span>
        </div>
      )}
      {!busy && message && (
        <div style={bannerStyle(message.kind === 'error' ? 'error' : 'success')}>
          {message.kind === 'error' ? <AlertCircle size={12} /> : <Check size={12} />}
          <span>{message.text}</span>
        </div>
      )}
    </div>
  );
}

function BranchSwitcher({ currentBranch, detached, branches, disabled, disabledReason, onSwitch }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const label = detached ? 'detached HEAD' : (currentBranch || '—');

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        disabled={disabled}
        title={disabled ? (disabledReason || '') : 'Switch to another local branch'}
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          color: disabled ? 'var(--eb-text-muted)' : 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          opacity: disabled ? 0.7 : 1,
        }}
      >
        <GitBranch size={11} />
        <span style={{ maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {label}
        </span>
        <ChevronDown size={11} />
      </button>
      {open && branches.length > 0 && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 2px)',
          left: 0,
          minWidth: 200,
          maxHeight: 260,
          overflowY: 'auto',
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          boxShadow: 'var(--eb-shadow-md, 0 4px 12px rgba(0,0,0,0.2))',
          zIndex: 10,
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}>
          {branches.map(b => (
            <button
              key={b}
              type="button"
              onClick={() => { setOpen(false); onSwitch(b); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                textAlign: 'left',
                padding: '4px 6px',
                background: 'none',
                border: 'none',
                borderRadius: 'var(--eb-radius-sm)',
                color: 'var(--eb-text-primary)',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-xs)',
                cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
            >
              <GitBranch size={10} style={{ color: 'var(--eb-text-muted)' }} />
              {b}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function ActionButton({ icon, label, title, disabled, danger, onClick }) {
  return (
    <button
      type="button"
      disabled={disabled}
      title={title || ''}
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '3px 10px',
        background: 'var(--eb-bg-elevated)',
        border: `1px solid ${danger ? 'var(--eb-status-error-bg)' : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-sm)',
        color: disabled
          ? 'var(--eb-text-muted)'
          : (danger ? 'var(--eb-status-error)' : 'var(--eb-text-secondary)'),
        fontSize: 'var(--eb-text-xs)',
        cursor: disabled ? 'not-allowed' : 'pointer',
        opacity: disabled ? 0.6 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function bannerStyle(kind) {
  const map = {
    error:   { fg: 'var(--eb-status-error)',   bg: 'var(--eb-status-error-bg)' },
    success: { fg: 'var(--eb-status-success)', bg: 'var(--eb-status-success-bg)' },
    warning: { fg: 'var(--eb-status-warning)', bg: 'var(--eb-status-warning-bg)' },
  };
  const m = map[kind] || map.warning;
  return {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '4px 8px',
    borderRadius: 'var(--eb-radius-sm)',
    background: m.bg,
    color: m.fg,
    fontSize: 'var(--eb-text-xs)',
    lineHeight: 1.4,
  };
}

/* ─── Repo selector / label ────────────────────────────────────────── */

function RepoLabel({ repo }) {
  if (!repo) return <span style={pathLabelStyle}>—</span>;
  return (
    <span style={pathLabelStyle}>
      <span style={{ color: 'var(--eb-text-secondary)' }}>{displayRepoPath(repo.repoPath)}</span>
      {repo.branch && (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--eb-text-muted)', marginLeft: 8 }}>
          <GitBranch size={10} />
          {repo.branch}
        </span>
      )}
    </span>
  );
}

function RepoSelector({ repos, value, onChange }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onClick = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  const current = repos.find(r => r.repoPath === value) || repos[0];
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          padding: '3px 8px',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          color: 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'var(--eb-font-mono)',
          cursor: 'pointer',
        }}
      >
        <RepoLabel repo={current} />
        <ChevronDown size={11} />
      </button>
      {open && (
        <div style={{
          position: 'absolute',
          top: 'calc(100% + 2px)',
          left: 0,
          minWidth: 220,
          background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-sm)',
          boxShadow: 'var(--eb-shadow-md, 0 4px 12px rgba(0,0,0,0.2))',
          zIndex: 10,
          padding: 4,
          display: 'flex',
          flexDirection: 'column',
          gap: 1,
        }}>
          {repos.map(r => (
            <button
              key={r.repoPath}
              type="button"
              onClick={() => { onChange(r.repoPath); setOpen(false); }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                width: '100%',
                textAlign: 'left',
                padding: '4px 6px',
                background: r.repoPath === value ? 'var(--eb-bg-hover)' : 'none',
                border: 'none',
                borderRadius: 'var(--eb-radius-sm)',
                color: 'var(--eb-text-primary)',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-xs)',
                cursor: 'pointer',
              }}
              onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
              onMouseLeave={e => { e.currentTarget.style.background = r.repoPath === value ? 'var(--eb-bg-hover)' : 'none'; }}
            >
              <RepoLabel repo={r} />
              {r.changesCount > 0 && (
                <span style={{ marginLeft: 'auto', color: 'var(--eb-status-warning)', fontSize: '10px' }}>
                  {r.changesCount}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function displayRepoPath(p) {
  return p === '.' ? '/' : p;
}

/* ─── File list ────────────────────────────────────────────────────── */

function FileList({ loading, error, repos, repoEntry, files, selected, onSelect }) {
  if (loading) {
    return (
      <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)' }}>
        <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
        <span style={{ marginLeft: 8 }}>Loading…</span>
      </div>
    );
  }
  if (error) {
    return (
      <div style={{ ...emptyStyle, color: 'var(--eb-status-error)', padding: 'var(--eb-space-4)' }}>
        <AlertCircle size={14} />
        <span style={{ marginLeft: 8 }}>{error}</span>
      </div>
    );
  }
  if (!repos.length) {
    return (
      <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column' }}>
        <span>This workspace contains no git repository.</span>
      </div>
    );
  }
  if (!repoEntry) {
    return <div style={emptyStyle}>Select a repository.</div>;
  }
  if (!files.length) {
    return (
      <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column' }}>
        <span>No changes — working tree matches HEAD.</span>
      </div>
    );
  }

  return (
    <div style={{ padding: '4px 0' }}>
      {files.map(f => (
        <FileRow
          key={f.path}
          file={f}
          active={selected?.repoPath === repoEntry.repoPath && selected?.path === f.path}
          onClick={() => onSelect(f)}
        />
      ))}
    </div>
  );
}

function FileRow({ file, active, onClick }) {
  const idx  = file.path.lastIndexOf('/');
  const dir  = idx >= 0 ? file.path.slice(0, idx + 1) : '';
  const name = idx >= 0 ? file.path.slice(idx + 1) : file.path;
  const totals = file.binary
    ? <span style={{ color: 'var(--eb-text-muted)' }}>BIN</span>
    : (
      <>
        {file.additions > 0 && <span style={{ color: 'var(--eb-status-success)' }}>+{file.additions}</span>}
        {file.additions > 0 && file.deletions > 0 && ' '}
        {file.deletions > 0 && <span style={{ color: 'var(--eb-status-error)' }}>-{file.deletions}</span>}
      </>
    );

  return (
    <button
      type="button"
      onClick={onClick}
      title={file.path}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        width: '100%',
        textAlign: 'left',
        padding: '3px 12px',
        background: active ? 'var(--eb-accent-muted)' : 'none',
        border: 'none',
        cursor: 'pointer',
        fontSize: 'var(--eb-text-xs)',
        fontFamily: 'inherit',
        color: active ? 'var(--eb-accent-primary)' : 'var(--eb-text-secondary)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'none'; }}
    >
      <StatusBadge status={file.status} />
      <span style={{
        flex: 1,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        fontFamily: 'var(--eb-font-mono)',
      }}>
        <span style={{ color: 'var(--eb-text-muted)' }}>{dir}</span>
        <span style={{ fontWeight: 'var(--eb-font-medium)' }}>{name}</span>
        {file.renameFrom && (
          <span style={{ color: 'var(--eb-text-muted)', marginLeft: 6 }}>
            ← {file.renameFrom}
          </span>
        )}
      </span>
      <span style={{
        flexShrink: 0,
        fontFamily: 'var(--eb-font-mono)',
        fontSize: '10px',
      }}>
        {totals}
      </span>
    </button>
  );
}

function StatusBadge({ status }) {
  const meta = STATUS_META[status] || STATUS_META.default;
  return (
    <span
      title={meta.label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: 18,
        height: 14,
        borderRadius: 'var(--eb-radius-sm)',
        background: meta.bg,
        color: meta.fg,
        fontFamily: 'var(--eb-font-mono)',
        fontSize: '9px',
        fontWeight: 'var(--eb-font-bold, 600)',
        letterSpacing: 0,
      }}
    >
      {status === '??' ? '?' : status}
    </span>
  );
}

const STATUS_META = {
  M:  { label: 'Modified',  fg: 'var(--eb-status-warning)', bg: 'var(--eb-status-warning-bg)' },
  A:  { label: 'Added',     fg: 'var(--eb-status-success)', bg: 'var(--eb-status-success-bg)' },
  D:  { label: 'Deleted',   fg: 'var(--eb-status-error)',   bg: 'var(--eb-status-error-bg)' },
  R:  { label: 'Renamed',   fg: 'var(--eb-status-info)',    bg: 'var(--eb-status-info-bg)' },
  C:  { label: 'Copied',    fg: 'var(--eb-status-info)',    bg: 'var(--eb-status-info-bg)' },
  U:  { label: 'Unmerged',  fg: 'var(--eb-status-error)',   bg: 'var(--eb-status-error-bg)' },
  '??': { label: 'Untracked', fg: 'var(--eb-text-muted)',   bg: 'var(--eb-bg-elevated)' },
  default: { label: '',     fg: 'var(--eb-text-muted)',     bg: 'var(--eb-bg-elevated)' },
};

/* ─── Diff pane ────────────────────────────────────────────────────── */

function DiffPane({ agentId, repoPath, file, onClose }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState(null);
  const [confirmedBig, setConfirmedBig] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!agentId || !file?.path) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);
    setConfirmedBig(false);

    const params = new URLSearchParams({ repo: repoPath, path: file.path });
    fetch(`/api/agents/${encodeURIComponent(agentId)}/workspace/git-diff?${params}`)
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (reqId !== reqIdRef.current) return;
        if (!ok) throw new Error(j?.error || 'Failed');
        setData(j);
      })
      .catch(e => {
        if (reqId !== reqIdRef.current) return;
        setError(e.message);
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [agentId, repoPath, file?.path]);

  const lineCount = useMemo(() => {
    if (!data?.diff) return 0;
    let n = 0;
    for (let i = 0; i < data.diff.length; i++) if (data.diff.charCodeAt(i) === 10) n++;
    return n;
  }, [data]);

  const isHuge = lineCount > 2000;

  return (
    <div style={{
      flex: '1 1 60%',
      minHeight: 0,
      display: 'flex',
      flexDirection: 'column',
      borderTop: '1px solid var(--eb-border-default)',
      background: 'var(--eb-bg-surface)',
    }}>
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        padding: '6px var(--eb-space-3)',
        borderBottom: '1px solid var(--eb-border-default)',
        flexShrink: 0,
      }}>
        <StatusBadge status={file.status} />
        <span title={file.path} style={{
          flex: 1,
          minWidth: 0,
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          fontFamily: 'var(--eb-font-mono)',
          fontSize: 'var(--eb-text-xs)',
          color: 'var(--eb-text-primary)',
        }}>
          {file.path}
        </span>
        {data?.truncated && (
          <span title="Diff truncated at 2 MB"
            style={{ display: 'inline-flex', color: 'var(--eb-status-warning)' }}>
            <FileWarning size={12} />
          </span>
        )}
        <button
          onClick={onClose}
          title="Close diff"
          aria-label="Close diff"
          style={iconBtnStyle}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <X size={13} />
        </button>
      </div>

      {/* Body */}
      <div style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        background: 'var(--eb-bg-app)',
      }}>
        {loading && (
          <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
            <span style={{ marginLeft: 8 }}>Loading diff…</span>
          </div>
        )}
        {!loading && error && (
          <div style={{ ...emptyStyle, color: 'var(--eb-status-error)', padding: 'var(--eb-space-4)' }}>
            <AlertCircle size={14} />
            <span style={{ marginLeft: 8 }}>{error}</span>
          </div>
        )}
        {!loading && !error && data?.binary && (
          <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', textAlign: 'center' }}>
            <FileWarning size={20} />
            <div style={{ marginTop: 8 }}>Binary file — diff not rendered</div>
          </div>
        )}
        {!loading && !error && data && !data.binary && !data.diff && (
          <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)' }}>
            <span>No textual changes.</span>
          </div>
        )}
        {!loading && !error && data && !data.binary && data.diff && isHuge && !confirmedBig && (
          <div style={{ ...emptyStyle, padding: 'var(--eb-space-4)', flexDirection: 'column', gap: 8 }}>
            <span>Large diff ({lineCount.toLocaleString()} lines).</span>
            <button
              onClick={() => setConfirmedBig(true)}
              style={{
                fontSize: 'var(--eb-text-xs)',
                padding: '4px 12px',
                background: 'var(--eb-accent-primary)',
                color: 'var(--eb-text-inverted)',
                border: 'none',
                borderRadius: 'var(--eb-radius-sm)',
                cursor: 'pointer',
              }}
            >
              Render anyway
            </button>
          </div>
        )}
        {!loading && !error && data && !data.binary && data.diff && (!isHuge || confirmedBig) && (
          <UnifiedDiff diff={data.diff} />
        )}
      </div>
    </div>
  );
}

/* ─── Unified diff renderer ────────────────────────────────────────── */

// Tiny renderer — splits the unified diff into rows and styles them per type.
// Keeping it inline avoids a new dependency for MVP-1; a side-by-side mode
// (planned for MVP-2) can reuse the same parsed rows.
function UnifiedDiff({ diff }) {
  const rows = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return (
    <pre style={{
      margin: 0,
      padding: 0,
      fontSize: 'var(--eb-text-xs)',
      fontFamily: 'var(--eb-font-mono)',
      tabSize: 2,
      minWidth: 0,
    }}>
      {rows.map((row, i) => (
        <div key={i} style={rowStyle(row.kind)}>
          {row.text || ' '}
        </div>
      ))}
    </pre>
  );
}

function parseUnifiedDiff(diff) {
  const out = [];
  if (!diff) return out;
  const lines = diff.split('\n');
  for (const ln of lines) {
    if (ln.startsWith('diff --git') || ln.startsWith('index ') ||
        ln.startsWith('new file mode') || ln.startsWith('deleted file mode') ||
        ln.startsWith('similarity index') || ln.startsWith('rename from') ||
        ln.startsWith('rename to')) {
      out.push({ kind: 'meta', text: ln });
    } else if (ln.startsWith('--- ') || ln.startsWith('+++ ')) {
      out.push({ kind: 'fileheader', text: ln });
    } else if (ln.startsWith('@@')) {
      out.push({ kind: 'hunk', text: ln });
    } else if (ln.startsWith('+')) {
      out.push({ kind: 'add', text: ln });
    } else if (ln.startsWith('-')) {
      out.push({ kind: 'del', text: ln });
    } else if (ln.startsWith('\\')) {
      // "\ No newline at end of file" markers.
      out.push({ kind: 'meta', text: ln });
    } else {
      out.push({ kind: 'context', text: ln });
    }
  }
  // Trailing empty line from split('\n') — drop it so we don't render a blank row.
  if (out.length && out[out.length - 1].text === '' && out[out.length - 1].kind === 'context') {
    out.pop();
  }
  return out;
}

function rowStyle(kind) {
  const base = {
    padding: '0 var(--eb-space-3)',
    whiteSpace: 'pre',
    color: 'var(--eb-text-primary)',
    lineHeight: 1.45,
  };
  switch (kind) {
    case 'meta':
      return { ...base, color: 'var(--eb-text-muted)' };
    case 'fileheader':
      return { ...base, color: 'var(--eb-text-secondary)', fontWeight: 'var(--eb-font-semibold)' };
    case 'hunk':
      return { ...base, color: 'var(--eb-accent-primary)', background: 'var(--eb-bg-elevated)' };
    case 'add':
      return { ...base, background: 'var(--eb-status-success-bg)', color: 'var(--eb-status-success)' };
    case 'del':
      return { ...base, background: 'var(--eb-status-error-bg)', color: 'var(--eb-status-error)' };
    default:
      return base;
  }
}

/* ─── Shared styles ────────────────────────────────────────────────── */

const iconBtnStyle = {
  background: 'none',
  border: 'none',
  color: 'var(--eb-text-muted)',
  cursor: 'pointer',
  padding: 4,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
};

const emptyStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: 'var(--eb-text-muted)',
  fontSize: 'var(--eb-text-xs)',
};

const pathLabelStyle = {
  display: 'inline-flex',
  alignItems: 'center',
  fontFamily: 'var(--eb-font-mono)',
  fontSize: 'var(--eb-text-xs)',
};
