import React, { useState, useEffect, useCallback } from 'react';
import { GitBranch, Plus, Trash2, Loader2, Lock } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';
import IconButton from '../../components/IconButton';
import RepositoryCard from '../../components/RepositoryCard';
import { blankRepositoryRow, repositoryRowPayload } from '../../components/repository-fields-view.js';
import {
  repositoryRows,
  availability,
  submitState,
  addDialogLead,
  removeConfirmation,
  attachedNotice,
  detachedNotice,
  emptyStateText,
  shadowNote,
  ADD_DIALOG_TITLE,
  INHERITED_ROW_NOTE,
} from './agent-repos-view.js';

// AgentRepositoriesPanel — the repositories an agent has, and the one place a
// repository is attached to or removed from a single agent (#2067).
//
// Rendered on BOTH surfaces the feature is offered on: the Agent Chat Workspace
// view (D1) and the agent's Settings tab next to Sync repositories (D7). AC20
// requires both to read and write the same data and enforce the same
// authorization, and that neither can reach a state the other cannot — so this
// is one component with two hosts, the #1928/#1929 discipline, rather than two
// panels over one endpoint.
//
// Every decision it renders is the pure `agent-repos-view.js`; the form fields
// are the console's one shared `RepositoryCard` (D2). What is left here is the
// fetch, the two mutations, and the refetch after each.

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--eb-space-2)',
};

const noteStyle = {
  fontSize: 'var(--eb-text-xs)',
  color: 'var(--eb-text-muted)',
  lineHeight: '1.4',
};

const rowStyle = {
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-surface)',
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--eb-space-2)',
};

const badgeBase = {
  fontSize: 'var(--eb-text-xs)',
  padding: '1px var(--eb-space-1-5)',
  borderRadius: 'var(--eb-radius-sm)',
  whiteSpace: 'nowrap',
  fontWeight: 'var(--eb-font-medium)',
};

// AC7: the two scopes must not read the same. The agent-scoped badge is the
// accent one because it is the exception — the inherited badge is muted, since
// "everyone has this" is the default a reader assumes.
function ScopeBadge({ row }) {
  const style = row.scope === 'agent'
    ? { ...badgeBase, background: 'var(--eb-accent-muted)', color: 'var(--eb-accent-primary)' }
    : { ...badgeBase, background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-muted)' };
  return <span style={style}>{row.scopeLabel}</span>;
}

export default function AgentRepositoriesPanel({
  agentId,
  agentName = null,
  active = true,
  onChanged = null,
}) {
  const [view, setView] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState(blankRepositoryRow);
  const [saving, setSaving] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [removing, setRemoving] = useState(false);
  const [notice, setNotice] = useState(null);
  const [sshKeys, setSshKeys] = useState([]);

  const load = useCallback(async (id) => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(id)}/repositories`);
      setView({ ...data, agentName });
    } catch (err) {
      setError(err.message || 'Could not read this agent\'s repositories');
      setView(null);
    } finally {
      setLoading(false);
    }
  }, [agentName]);

  useEffect(() => {
    // Reset per agent so a notice or a half-typed draft never carries across.
    setAdding(false);
    setDraft(blankRepositoryRow());
    setRemoveTarget(null);
    setNotice(null);
    if (active && agentId) load(agentId);
  }, [agentId, active, load]);

  // The key registry, for the card's SSH-key select. Loaded lazily with the
  // add form rather than on mount: a reader who only looks at the list never
  // needs it.
  useEffect(() => {
    if (!adding || sshKeys.length) return;
    apiCall('GET', '/api/ssh-keys').then((keys) => {
      setSshKeys(Array.isArray(keys) ? keys : []);
    }).catch(() => setSshKeys([]));
  }, [adding, sshKeys.length]);

  const rows = repositoryRows(view);
  const own = rows.filter((r) => r.scope === 'agent');
  const gate = availability(view);
  const submit = submitState(draft, { saving });

  async function handleAdd() {
    setSaving(true);
    setError(null);
    try {
      const result = await apiCall('POST', `/api/agents/${encodeURIComponent(agentId)}/repositories`, repositoryRowPayload(draft));
      setAdding(false);
      setDraft(blankRepositoryRow());
      setNotice(attachedNotice(result));
      setView({ ...result, agentName });
      // AC4: the new directory appears in the Workspace file tree without the
      // reader having to press Refresh.
      if (onChanged) onChanged(result);
    } catch (err) {
      // Every refusal (collision, credential, busy) arrives as the server's own
      // sentence — the client re-words none of them.
      setError(err.message || 'Could not attach the repository');
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setError(null);
    try {
      const result = await apiCall('DELETE', `/api/agents/${encodeURIComponent(agentId)}/repositories`, { url: removeTarget.url });
      setRemoveTarget(null);
      setNotice(detachedNotice(result));
      setView({ ...result, agentName });
      if (onChanged) onChanged(result);
    } catch (err) {
      setError(err.message || 'Could not remove the repository');
    } finally {
      setRemoving(false);
    }
  }

  const confirm = removeConfirmation(removeTarget);

  return (
    <div style={sectionStyle}>
      {loading && !view && (
        <div style={noteStyle}>
          <Loader2 size={12} style={{ animation: 'spin 1s linear infinite', verticalAlign: 'middle', marginRight: 4 }} />
          Reading repositories…
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1-5)' }}>
          {rows.map((row) => (
            <div key={`${row.scope}:${row.url}`} style={rowStyle}>
              <GitBranch size={14} style={{ flexShrink: 0, marginTop: 3, color: 'var(--eb-text-muted)' }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
                  <code style={{ fontSize: 'var(--eb-text-xs)', wordBreak: 'break-all' }}>{row.url}</code>
                  <ScopeBadge row={row} />
                  {row.readOnly && (
                    <span style={{ ...badgeBase, background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-muted)' }}>
                      read-only
                    </span>
                  )}
                </div>
                <div style={noteStyle}>
                  {row.clonePath}{row.branch ? ` · branch ${row.branch}` : ''}
                </div>
                {row.scope === 'environment' && <div style={noteStyle}>{INHERITED_ROW_NOTE}</div>}
                {shadowNote(row) && <div style={noteStyle}>{shadowNote(row)}</div>}
              </div>
              {/* AC8: an inherited repository offers no remove action at all —
                  the environment is the only place to change it. An
                  agent-scoped one offers it, disabled with the reason when the
                  agent is running or the caller cannot manage it (AC12/AC17). */}
              {row.removable ? (
                <IconButton
                  icon={Trash2}
                  label={gate.canRemove ? 'Remove repository from this agent' : gate.reason}
                  danger
                  size={13}
                  disabled={!gate.canRemove}
                  onClick={() => setRemoveTarget(row)}
                />
              ) : (
                <span title={INHERITED_ROW_NOTE} style={{ display: 'inline-flex', color: 'var(--eb-text-muted)', marginTop: 2 }}>
                  <Lock size={13} />
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      {view && own.length === 0 && <div style={noteStyle}>{emptyStateText(view)}</div>}

      {notice && <div style={{ ...noteStyle, color: 'var(--eb-text-secondary)' }}>{notice}</div>}
      {error && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)', lineHeight: '1.4' }}>
          {error}
        </div>
      )}

      {!adding && (
        <div>
          <button
            type="button"
            onClick={() => { setAdding(true); setNotice(null); setError(null); }}
            disabled={!gate.canAttach}
            title={gate.canAttach ? undefined : gate.reason}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1-5)',
              padding: 'var(--eb-space-2) var(--eb-space-4)',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: gate.canAttach ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
              fontSize: 'var(--eb-text-sm)',
              fontFamily: 'inherit',
              cursor: gate.canAttach ? 'pointer' : 'not-allowed',
            }}
          >
            <Plus size={13} /> Add repository
          </button>
          {/* AC16/AC17: the action is disabled WITH the reason rather than
              silently absent — an empty toolbar answers "where is it?" with
              silence. */}
          {!gate.canAttach && gate.reason && <div style={noteStyle}>{gate.reason}</div>}
        </div>
      )}

      {adding && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)' }}>{ADD_DIALOG_TITLE}</div>
          <div style={noteStyle}>{addDialogLead(view || { agentName })}</div>
          <RepositoryCard
            repo={draft}
            sshKeys={sshKeys}
            // D5: no credential of its own — the probe (and the clone) use the
            // environment's GitHub token, resolved server-side. `githubTokenId`
            // is a real token id the card sends to the reachability probe, so
            // it must never carry a client-guessed placeholder (#2161) — the
            // HTTPS-without-token hint's COPY is driven by `tokenTarget` alone.
            // Its VISIBILITY, separately, is suppressed when the environment
            // already has a real token bound — `hasEnvironmentToken` carries
            // that signal on its own channel, never touching the probe/API
            // (#2161 follow-up), so a probe failure never tells the reader to
            // add a token their environment already has.
            githubTokenId=""
            tokenTarget="environment"
            hasEnvironmentToken={view && view.hasGithubToken === true}
            onChange={(field, value) => setDraft((d) => ({ ...d, [field]: value }))}
          />
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
            <button
              type="button"
              onClick={handleAdd}
              disabled={!submit.enabled}
              title={submit.reason || undefined}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-4)',
                background: submit.enabled ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
                border: submit.enabled ? 'none' : '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: submit.enabled ? 'var(--eb-text-inverted)' : 'var(--eb-text-muted)',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'inherit',
                cursor: submit.enabled ? 'pointer' : 'not-allowed',
                display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-1-5)',
              }}
            >
              {saving && <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />}
              {saving ? 'Cloning…' : 'Attach and clone'}
            </button>
            <button
              type="button"
              onClick={() => { setAdding(false); setDraft(blankRepositoryRow()); setError(null); }}
              disabled={saving}
              style={{
                padding: 'var(--eb-space-2) var(--eb-space-4)',
                background: 'transparent',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: 'var(--eb-text-secondary)',
                fontSize: 'var(--eb-text-sm)',
                fontFamily: 'inherit',
                cursor: saving ? 'not-allowed' : 'pointer',
              }}
            >
              Cancel
            </button>
            {submit.reason && !saving && <span style={noteStyle}>{submit.reason}</span>}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={Boolean(removeTarget)}
        title={confirm.title}
        variant={confirm.destructive ? 'danger' : 'warning'}
        confirmLabel={confirm.confirmLabel}
        busy={removing}
        message={(
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {confirm.lines.map((line, i) => <p key={i} style={{ margin: 0 }}>{line}</p>)}
          </div>
        )}
        onConfirm={handleRemove}
        onCancel={() => setRemoveTarget(null)}
      />
    </div>
  );
}
