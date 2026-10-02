import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  AlertTriangle, RefreshCw, ExternalLink, Info, Pause, Play, Waves, Zap, Power, Columns, UserRound, EyeOff, RotateCcw, LockOpen, CheckCircle2,
} from 'lucide-react';
import { Link as RouterLink } from 'react-router';
import { useApi, apiCall } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import PageHelpButton from '../components/PageHelpButton';
import Modal from '../components/Modal';
import { usePageActions } from '../context/PageActionsContext';
import {
  boardView, updatedAgo, AUTO_REFRESH_MS, readAutoRefresh, writeAutoRefresh, configFormRows, configFromForm,
  withoutRows, REMOVE_CONFIRM_TEXT, removeDialogTitle, RELEASE_CONFIRM_TEXT, releaseDialogTitle, releaseNotice, CHAT_LINK_CLASS, CHAT_LINK_CSS,
} from './process/flow-control-view';
import { FLOW_CONTROL_HELP_SECTIONS } from './flow-control-help-sections';

// The Flow Control board (#2573, concept `docs/flow-control-concept.md`
// Amendment 3): who is working on what, where a person is needed, and how far
// each work item has come through the team's own flow.
//
// One read — `GET /api/teams/:teamId/flow-board` — carries everything; the
// stages, rows and human-block reasons are decided server-side by
// `orchestrator/flow-board.js` and turned into strings by the pure
// `flow-control-view.js`. The page itself decides nothing.
//
// The only writes are the pool controls (pause/drain/switch on, force
// dispatch), the optional per-team column configuration and "Remove from
// board" / Restore (#2637) — none of them touches a GitHub item.

const PAGE_DESCRIPTION = 'Who is working on what, where you are needed, and how far each item has come.';

const ACTION_ICONS = { pause: Pause, drain: Waves, resume: Play, switchOn: Power };

export default function FlowControl() {
  const { data: agents } = useApi('/api/agents');
  const { user } = useAuth();
  const username = user?.username;
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter((a) => a.role === 'team') : []),
    [agents],
  );

  const [teamId, setTeamId] = useState('');
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [actionError, setActionError] = useState(null);
  const [actionNotice, setActionNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(() => readAutoRefresh(username));
  const [now, setNow] = useState(() => Date.now());
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [removeTarget, setRemoveTarget] = useState(null);
  const [releaseTarget, setReleaseTarget] = useState(null);
  const [removedOpen, setRemovedOpen] = useState(false);
  const loadSeq = useRef(0);

  // Default to the first team once the list arrives; never override a choice.
  useEffect(() => {
    if (!teamId && teams.length > 0) setTeamId(teams[0].id);
  }, [teams, teamId]);

  // The preference is per user, and the user record can arrive after mount.
  useEffect(() => { setAutoRefresh(readAutoRefresh(username)); }, [username]);

  // `refresh` forces a new GitHub sweep; the timer reads the shared snapshot.
  // A stale response (team switched meanwhile) is dropped by sequence number.
  const load = useCallback(async (refresh = false) => {
    if (!teamId) return;
    const seq = ++loadSeq.current;
    setState((s) => ({ ...s, loading: true }));
    try {
      const data = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/flow-board${refresh ? '?refresh=1' : ''}`);
      if (seq === loadSeq.current) setState({ loading: false, error: null, data });
    } catch (err) {
      // Keep the last snapshot on screen; the error banner says it is old.
      if (seq === loadSeq.current) setState((s) => ({ loading: false, error: err.message || 'Failed to load', data: s.data }));
    }
  }, [teamId]);

  useEffect(() => {
    setState({ loading: false, error: null, data: null });
    load();
  }, [load]);

  useEffect(() => {
    if (!autoRefresh || !teamId) return undefined;
    const t = setInterval(() => {
      if (typeof document === 'undefined' || !document.hidden) load();
    }, AUTO_REFRESH_MS);
    return () => clearInterval(t);
  }, [autoRefresh, teamId, load]);

  // Ticks the "updated … ago" and the durations between refreshes.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  const toggleAutoRefresh = useCallback(() => {
    setAutoRefresh((on) => {
      writeAutoRefresh(username, !on);
      return !on;
    });
  }, [username]);

  const mutate = useCallback(async (fn, failText) => {
    setActionError(null);
    setActionNotice(null);
    setBusy(true);
    try {
      await fn();
      await load(true);
    } catch (err) {
      setActionError(err.message || failText);
    } finally {
      setBusy(false);
    }
  }, [load]);

  const setRoleState = useCallback((roleId, nextState) => mutate(
    () => apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/pool-control/${encodeURIComponent(roleId)}`, { state: nextState }),
    'Failed to update',
  ), [teamId, mutate]);

  const forceDispatch = useCallback((id) => mutate(
    () => apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/force-dispatch`, { id }),
    'Failed to force-dispatch',
  ), [teamId, mutate]);

  // "Release claim" (#2754): the server re-checks the row on a fresh board,
  // swaps the stale claim back to its wake label on GitHub and logs it; a
  // partial failure comes back as warnings, shown like any action error.
  const releaseClaim = useCallback((target) => mutate(
    async () => {
      const res = await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/flow-board-release`, { rowId: target.id });
      setReleaseTarget(null);
      setActionNotice(releaseNotice(res, target.ref));
      if (res && Array.isArray(res.warnings) && res.warnings.length) setActionError(res.warnings.join(' · '));
    },
    'Failed to release the claim',
  ), [teamId, mutate]);

  const saveColumns = useCallback((config) => mutate(
    async () => {
      await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/flow-board-config`, { config });
      setColumnsOpen(false);
    },
    'Failed to save the columns',
  ), [teamId, mutate]);

  // The row leaves the board at once; the reload that follows confirms it (or
  // brings it back when the orchestrator refused).
  const removeRow = useCallback((row) => {
    setRemoveTarget(null);
    setState((s) => ({ ...s, data: withoutRows(s.data, [row.id]) }));
    return mutate(
      async () => {
        try {
          await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/flow-board-removed`, { action: 'remove', rowId: row.id });
        } catch (err) {
          load(true);
          throw err;
        }
      },
      'Failed to remove the item from the board',
    );
  }, [teamId, mutate, load]);

  const restoreRow = useCallback((entry) => mutate(
    () => apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/flow-board-removed`, { action: 'restore', rowId: entry.removalId }),
    'Failed to restore the item',
  ), [teamId, mutate]);

  const view = useMemo(() => boardView(state.data, now), [state.data, now]);

  // Hooks must run before any early return, so the portal is built here and
  // simply not mounted while the page renders its empty state.
  const headerAction = usePageActions(
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
      {state.data && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          {updatedAgo(state.data.generatedAt, now)}
        </span>
      )}
      <label
        title="Refresh the board every 30 seconds"
        style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', cursor: 'pointer' }}
      >
        <input type="checkbox" checked={autoRefresh} onChange={toggleAutoRefresh} />
        Auto-refresh
      </label>
      <HeaderButton
        icon={RefreshCw}
        label="Refresh"
        title="Fetch a new snapshot from GitHub now"
        spin={state.loading}
        disabled={state.loading || !teamId}
        onClick={() => load(true)}
      />
    </div>,
  );

  return (
    <>
      {headerAction}
      <style>{CHAT_LINK_CSS}</style>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
        {/* Title comes from the Shell header (#1847), so the page leads with the
            one-line description plus its "?". */}
        <p style={{
          margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
        }}>
          {PAGE_DESCRIPTION}
          <PageHelpButton
            label="What the board shows"
            size={14}
            section={FLOW_CONTROL_HELP_SECTIONS.page}
            style={{ padding: 0, flexShrink: 0 }}
          />
        </p>

        {teams.length === 0 ? (
          <Banner icon={Info}>
            No Agent Team exists yet. The board shows one team&apos;s work, so create a team
            first — the Flows page is where a team&apos;s process is authored.
          </Banner>
        ) : (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
              <TeamPicker teams={teams} value={teamId} onChange={setTeamId} />
              {view.canManage && (
                <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--eb-space-2)' }}>
                  {view.removed.length > 0 && (
                    <HeaderButton icon={EyeOff} label={view.removedLabel} title="Items taken off the board — restore them here" onClick={() => setRemovedOpen(true)} />
                  )}
                  <HeaderButton icon={Columns} label="Columns" title="Rename, merge or hide stages" onClick={() => setColumnsOpen(true)} />
                </span>
              )}
            </div>

            {view.maintenance && (
              <Banner icon={Info}>Maintenance mode is active — the board is paused.</Banner>
            )}
            {view.noRepos && (
              <Banner icon={Info}>
                No GitHub repository is bound to this team&apos;s environment, so there is no work to show.
              </Banner>
            )}
            {view.warning && <Banner icon={AlertTriangle} tone="warn">{view.warning}</Banner>}
            {view.partial.length > 0 && (
              <Banner icon={AlertTriangle} tone="warn">Partly loaded — {view.partial.join('; ')}</Banner>
            )}
            {state.error && (
              <Banner icon={AlertTriangle} tone="error">
                {state.error}{state.data ? ` — showing the state from ${updatedAgo(state.data.generatedAt, now).replace('Updated ', '')}.` : ''}
              </Banner>
            )}
            {actionError && <Banner icon={AlertTriangle} tone="error">{actionError}</Banner>}
            {actionNotice && <Banner icon={CheckCircle2}>{actionNotice}</Banner>}

            {state.loading && !state.data && (
              <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Loading…</p>
            )}

            {state.data && !view.maintenance && (
              <>
                <WorkingNow view={view} busy={busy} onSetState={setRoleState} onForceDispatch={forceDispatch} />
                {view.needsYou && <NeedsYou items={view.needsYou} canManage={view.canManage} busy={busy} onRelease={setReleaseTarget} />}
                <InProgress view={view} busy={busy} onRemove={setRemoveTarget} />
                {view.doneRows.length > 0 && (
                  <RecentlyCompleted rows={view.doneRows} hint={view.retentionHint} canManage={view.canManage} busy={busy} onRemove={setRemoveTarget} />
                )}
              </>
            )}
          </>
        )}
      </div>
      {columnsOpen && (
        <ColumnsDialog
          roles={view.roles}
          config={state.data && state.data.config}
          busy={busy}
          onClose={() => setColumnsOpen(false)}
          onSave={saveColumns}
        />
      )}
      {removeTarget && (
        <Modal
          open
          onClose={() => setRemoveTarget(null)}
          title={removeDialogTitle(removeTarget.ref)}
          maxWidth={480}
          footer={(
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
              <HeaderButton icon={EyeOff} label="Remove from board" title="Take this item off the board" disabled={busy} onClick={() => removeRow(removeTarget)} />
            </div>
          )}
        >
          <p style={{ marginTop: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{removeTarget.title}</p>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
            {REMOVE_CONFIRM_TEXT}
          </p>
        </Modal>
      )}
      {releaseTarget && (
        <Modal
          open
          onClose={() => setReleaseTarget(null)}
          title={releaseDialogTitle(releaseTarget.ref)}
          maxWidth={480}
          footer={(
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
              <HeaderButton icon={LockOpen} label="Release claim" title="Put the wake label back so the flow picks the item up again" disabled={busy} onClick={() => releaseClaim(releaseTarget)} />
            </div>
          )}
        >
          <p style={{ marginTop: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)' }}>{releaseTarget.title}</p>
          <ul style={{ marginTop: 0, fontSize: 'var(--eb-text-sm)', fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-primary)' }}>
            {releaseTarget.release.map((c) => <li key={`${c.ref}:${c.claim}`}>{c.ref}: {c.text}</li>)}
          </ul>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
            {RELEASE_CONFIRM_TEXT}
          </p>
        </Modal>
      )}
      {removedOpen && (
        <RemovedDialog
          items={view.removed}
          busy={busy}
          onClose={() => setRemovedOpen(false)}
          onRestore={restoreRow}
        />
      )}
    </>
  );
}

/* ── shared bits ───────────────────────────────────────────────────── */

function TeamPicker({ teams, value, onChange }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)' }}>
      <span style={{ color: 'var(--eb-text-secondary)' }}>Agent Team</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        }}
      >
        {teams.map((t) => <option key={t.id} value={t.id}>{t.name || t.id}</option>)}
      </select>
    </label>
  );
}

function HeaderButton({ icon: Icon, label, title, onClick, disabled, spin }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        padding: '4px 10px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        color: 'var(--eb-text-primary)', cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon size={13} style={spin ? { animation: 'spin 1s linear infinite' } : undefined} />
      {label}
    </button>
  );
}

function SmallButton({ icon: Icon, label, title, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4, background: 'none',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
        padding: '3px 8px', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
        color: 'var(--eb-text-primary)', cursor: disabled ? 'default' : 'pointer',
      }}
    >
      <Icon size={12} />
      {label}
    </button>
  );
}

function AreaHeading({ children, section, helpLabel }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 600 }}>
        {children}
      </h2>
      <PageHelpButton label={helpLabel} size={13} section={section} style={{ padding: 0, flexShrink: 0 }} />
    </div>
  );
}

const lineStyle = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
  padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-surface)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
};

const mutedStyle = { color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' };

// In-console link to the chat of the agent working right now (#2723): a real
// anchor, so Ctrl/Cmd- and middle-click open a new tab. `chat` is the view's
// `chatLink` result; without one the content renders exactly as before.
function ChatLink({ chat, children }) {
  if (!chat) return children;
  return (
    <RouterLink to={chat.to} title={chat.label} aria-label={chat.label} className={CHAT_LINK_CLASS} style={{ display: 'block' }}>
      {children}
    </RouterLink>
  );
}

function Link({ href, children }) {
  if (!href) return <span>{children}</span>;
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer"
      style={{ display: 'inline-flex', alignItems: 'center', gap: 3, color: 'var(--eb-accent-primary)', textDecoration: 'none' }}
    >
      {children}<ExternalLink size={10} />
    </a>
  );
}

/* ── area ①: working now ───────────────────────────────────────────── */

function WorkingNow({ view, busy, onSetState, onForceDispatch }) {
  const nothing = view.sessions.length === 0 && view.pools.length === 0 && view.held.length === 0;
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <AreaHeading section={FLOW_CONTROL_HELP_SECTIONS.working} helpLabel="What Working now shows">Working now</AreaHeading>
      {nothing && <p style={{ margin: 0, ...mutedStyle }}>No agent is running.</p>}
      {view.sessions.map((s) => (
        <div key={s.id} style={lineStyle}>
          <span style={{ color: 'var(--eb-text-primary)', fontWeight: 500 }}>
            <ChatLink chat={s.chat}>
              {s.role}{s.instance && <span style={mutedStyle}> {s.instance}</span>}
            </ChatLink>
          </span>
          <span style={{ fontFamily: 'var(--eb-font-mono)', ...mutedStyle }}>{s.item}</span>
          {s.title && <span style={{ color: 'var(--eb-text-primary)', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.title}</span>}
          <span style={{ marginLeft: 'auto', ...mutedStyle }} title="Running for">{s.running}</span>
        </div>
      ))}
      {view.pools.map((p) => (
        <div key={p.key} style={lineStyle}>
          <span style={{ color: 'var(--eb-text-primary)', fontWeight: 500 }}>{p.label}</span>
          <span style={mutedStyle}>{p.occupancy}</span>
          {p.stateText && (
            <span style={{
              fontSize: 'var(--eb-text-xs)', padding: '2px 8px', borderRadius: 'var(--eb-radius-sm)',
              border: '1px solid var(--eb-status-warning, #d97706)', color: 'var(--eb-status-warning, #d97706)',
            }}>
              {p.stateText}
            </span>
          )}
          <span style={{ display: 'flex', gap: 'var(--eb-space-2)', marginLeft: 'auto', alignItems: 'center' }}>
            {p.actions.map((a) => (
              <SmallButton
                key={a.id}
                icon={ACTION_ICONS[a.id]}
                label={a.label}
                title={a.tooltip}
                disabled={busy}
                onClick={() => onSetState(p.roleId, a.nextState)}
              />
            ))}
            <PageHelpButton label="Pause, Drain and Switch on" size={12} section={FLOW_CONTROL_HELP_SECTIONS.poolControls} style={{ padding: 0 }} />
          </span>
        </div>
      ))}
      {view.held.map((h) => (
        <div key={h.id} style={lineStyle}>
          <span style={mutedStyle}>Held — work-in-progress limit full</span>
          <span style={{ fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-primary)' }}>{h.ticket || 'unknown item'}</span>
          <span style={{ marginLeft: 'auto' }}>
            <SmallButton
              icon={Zap}
              label="Force dispatch"
              title="Start this one now, past the team's limit on work in progress. The limit itself stays as it is."
              disabled={busy}
              onClick={() => onForceDispatch(h.id)}
            />
          </span>
        </div>
      ))}
    </section>
  );
}

/* ── area ②: needs you ─────────────────────────────────────────────── */

function NeedsYou({ items, canManage, busy, onRelease }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <AreaHeading section={FLOW_CONTROL_HELP_SECTIONS.needsYou} helpLabel="What to do about each reason">
        Needs you ({items.length})
      </AreaHeading>
      {items.map((n) => (
        <div key={n.id} style={{ ...lineStyle, borderLeft: '3px solid var(--eb-status-warning, #d97706)' }}>
          <UserRound size={13} style={{ flexShrink: 0, color: 'var(--eb-text-secondary)' }} />
          <span style={{ fontFamily: 'var(--eb-font-mono)', ...mutedStyle }}>{n.ref}</span>
          <Link href={n.url}>{n.title}</Link>
          <span style={{ color: 'var(--eb-status-warning, #d97706)' }}>{n.reason}</span>
          <span style={{ marginLeft: 'auto', ...mutedStyle }} title="Waiting for">{n.waiting}</span>
          {canManage && n.release.length > 0 && (
            <SmallButton icon={LockOpen} label="Release claim" title={`Release the stale claim (${n.release.map((c) => c.text).join(', ')})`} disabled={busy} onClick={() => onRelease(n)} />
          )}
        </div>
      ))}
    </section>
  );
}

/* ── area ③: in progress ───────────────────────────────────────────── */

function InProgress({ view, busy, onRemove }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <AreaHeading section={FLOW_CONTROL_HELP_SECTIONS.states} helpLabel="Where the stages come from">
        In progress
      </AreaHeading>
      {view.empty ? (
        <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{view.emptyText}</p>
      ) : (
        <BoardTable rows={view.activeRows} canManage={view.canManage} busy={busy} onRemove={onRemove} />
      )}
    </section>
  );
}

/* ── recently completed (#2607) ────────────────────────────────────── */

// Closed issues and merged PRs, kept for the team's retention window. Only
// mounted when there is something to show.
function RecentlyCompleted({ rows, hint, canManage, busy, onRemove }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <AreaHeading section={FLOW_CONTROL_HELP_SECTIONS.states} helpLabel="Where the stages come from">
        Recently completed ({rows.length})
      </AreaHeading>
      <p style={{ margin: 0, ...mutedStyle }}>{hint}</p>
      <BoardTable rows={rows} canManage={canManage} busy={busy} onRemove={onRemove} />
    </section>
  );
}

function BoardTable({ rows, canManage, busy, onRemove }) {
  return (
    <div style={{ overflowX: 'auto' }}>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-sm)' }}>
        <thead>
          <tr style={{ textAlign: 'left', ...mutedStyle }}>
            <th style={cellStyle}>Work item</th>
            <th style={cellStyle}>Progress</th>
            <th style={cellStyle}>Stage</th>
            <th style={cellStyle}>In stage</th>
            {canManage && <th style={cellStyle} aria-label="Actions" />}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => <BoardRow key={r.id} row={r} canManage={canManage} busy={busy} onRemove={onRemove} />)}
        </tbody>
      </table>
    </div>
  );
}

const cellStyle = { padding: 'var(--eb-space-2) var(--eb-space-3)', borderBottom: '1px solid var(--eb-border-default)', verticalAlign: 'top' };

function BoardRow({ row, canManage, busy, onRemove }) {
  return (
    <tr style={{ opacity: row.done ? 0.65 : 1 }}>
      <td style={cellStyle}>
        <div style={{ color: 'var(--eb-text-primary)', lineHeight: 1.35 }}>
          <Link href={row.url}>{row.title}</Link>
        </div>
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap', ...mutedStyle }}>
          {row.ref && <Link href={row.issueUrl}>{row.ref}</Link>}
          {row.prs.map((p) => (
            <span key={p.key} style={p.state !== 'open' ? { textDecoration: p.state === 'closed' ? 'line-through' : 'none' } : undefined}>
              <Link href={p.url}>{p.label}{p.state === 'merged' ? ' (merged)' : ''}</Link>
            </span>
          ))}
        </div>
      </td>
      <td style={cellStyle}><StageProgress steps={row.steps} blocked={row.blocked} /></td>
      <td style={cellStyle}>
        <ChatLink chat={row.chat}>
          <div style={{ color: 'var(--eb-text-primary)' }}>{row.stageLabel}</div>
          <div style={mutedStyle}>{row.statusText}</div>
        </ChatLink>
      </td>
      <td style={{ ...cellStyle, whiteSpace: 'nowrap', ...mutedStyle }}>
        {row.inStageTitle ? <span title={row.inStageTitle}>{row.inStage}</span> : row.inStage}
      </td>
      {canManage && (
        <td style={{ ...cellStyle, whiteSpace: 'nowrap', textAlign: 'right' }}>
          {row.removable && (
            <SmallButton
              icon={EyeOff}
              label="Remove from board"
              title="Remove from board — the GitHub ticket stays unchanged"
              disabled={busy}
              onClick={() => onRemove(row)}
            />
          )}
        </td>
      )}
    </tr>
  );
}

// One dot per stage; the current one is labelled on hover and highlighted.
function StageProgress({ steps, blocked }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
      {steps.map((s) => {
        const color = s.state === 'current'
          ? (blocked ? 'var(--eb-status-warning, #d97706)' : 'var(--eb-accent-primary)')
          : s.state === 'past' ? 'var(--eb-status-success, #16a34a)' : 'var(--eb-border-default)';
        return (
          <span
            key={s.id}
            title={s.label}
            style={{
              width: s.state === 'current' ? 12 : 8, height: s.state === 'current' ? 12 : 8,
              borderRadius: '50%', background: color, flexShrink: 0,
            }}
          />
        );
      })}
    </div>
  );
}

/* ── column configuration ──────────────────────────────────────────── */

function ColumnsDialog({ roles, config, busy, onClose, onSave }) {
  const [rows, setRows] = useState(() => configFormRows(roles, config));
  const [retention, setRetention] = useState(() => String((config && config.doneRetentionHours) ?? 24));
  const patch = (id, change) => setRows((rs) => rs.map((r) => (r.id === id ? { ...r, ...change } : r)));
  const inputStyle = {
    padding: '3px 6px', background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-sm)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Board columns"
      maxWidth={640}
      footer={(
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', justifyContent: 'flex-end' }}>
          <HeaderButton icon={RefreshCw} label="Reset to automatic" title="Forget every change and derive the stages again" disabled={busy} onClick={() => onSave(configFromForm([], 24))} />
          <HeaderButton icon={Columns} label="Save" title="Save the columns for this team" disabled={busy} onClick={() => onSave(configFromForm(rows, retention))} />
        </div>
      )}
    >
      <p style={{ marginTop: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
        The stages come from the team&apos;s flow. Rename, merge or hide them here; Draft and Done are always shown.
        <PageHelpButton label="Changing the columns" size={12} section={FLOW_CONTROL_HELP_SECTIONS.columns} style={{ padding: 0, marginLeft: 4 }} />
      </p>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-sm)' }}>
        <thead>
          <tr style={{ textAlign: 'left', ...mutedStyle }}>
            <th style={cellStyle}>Role</th>
            <th style={cellStyle}>Show as</th>
            <th style={cellStyle}>Merge into</th>
            <th style={cellStyle}>Hide</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id}>
              <td style={cellStyle}>{r.derivedLabel}</td>
              <td style={cellStyle}>
                <input style={inputStyle} value={r.label} placeholder={r.derivedLabel} onChange={(e) => patch(r.id, { label: e.target.value })} />
              </td>
              <td style={cellStyle}>
                <select style={inputStyle} value={r.mergeInto} onChange={(e) => patch(r.id, { mergeInto: e.target.value })}>
                  <option value="">—</option>
                  {rows.filter((o) => o.id !== r.id).map((o) => <option key={o.id} value={o.id}>{o.derivedLabel}</option>)}
                </select>
              </td>
              <td style={cellStyle}>
                <input type="checkbox" checked={r.hidden} onChange={(e) => patch(r.id, { hidden: e.target.checked })} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginTop: 'var(--eb-space-3)', fontSize: 'var(--eb-text-sm)' }}>
        Keep finished items in Done for
        <input style={{ ...inputStyle, width: 70 }} type="number" min="0" value={retention} onChange={(e) => setRetention(e.target.value)} />
        hours
      </label>
    </Modal>
  );
}

/* ── removed items (#2637) ──────────────────────────────────────────── */

function RemovedDialog({ items, busy, onClose, onRestore }) {
  return (
    <Modal open onClose={onClose} title={`Removed from the board (${items.length})`} maxWidth={640}>
      <p style={{ marginTop: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
        These items are hidden from the board; their GitHub tickets are unchanged. Each one comes back on its own
        as soon as the flow picks it up again, or when you restore it.
        <PageHelpButton label="Removing items from the board" size={12} section={FLOW_CONTROL_HELP_SECTIONS.remove} style={{ padding: 0, marginLeft: 4 }} />
      </p>
      {items.length === 0 ? (
        <p style={{ margin: 0, ...mutedStyle }}>Nothing is removed.</p>
      ) : items.map((r) => (
        <div key={r.removalId} style={{ ...lineStyle, marginBottom: 'var(--eb-space-2)' }}>
          <span style={{ fontFamily: 'var(--eb-font-mono)', ...mutedStyle }}>{r.ref}</span>
          <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            <Link href={r.url}>{r.title}</Link>
          </span>
          <span style={{ marginLeft: 'auto', whiteSpace: 'nowrap', ...mutedStyle }} title="Removed">{r.removedAgo} ago</span>
          <SmallButton icon={RotateCcw} label="Restore" title="Put this item back on the board" disabled={busy} onClick={() => onRestore(r)} />
        </div>
      ))}
    </Modal>
  );
}

/* ── banner ────────────────────────────────────────────────────────── */

function Banner({ icon: Icon, tone, children }) {
  const color = tone === 'error'
    ? 'var(--eb-status-error, #dc2626)'
    : tone === 'warn'
      ? 'var(--eb-status-warning, #d97706)'
      : 'var(--eb-text-secondary)';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-sm)', color,
    }}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 2 }} />
      <div style={{ color: 'var(--eb-text-primary)' }}>{children}</div>
    </div>
  );
}
