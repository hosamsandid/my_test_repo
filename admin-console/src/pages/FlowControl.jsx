import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { AlertTriangle, RefreshCw, ExternalLink, CheckCircle2, Info, UserRound, Pause, Play, Waves, Zap, Clock, PauseCircle } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import PageHelpButton from '../components/PageHelpButton';
import WhenCell from '../components/WhenCell';
import { usePageActions } from '../context/PageActionsContext';
import {
  groupIntoLanes, epicRollups, rollupSummary, boardSummary, poolControlRows, heldRows, poolLaneRoleRows,
} from './process/flow-control-view';
import { FLOW_CONTROL_HELP_SECTIONS } from './flow-control-help-sections';

// The Flow Control board (#2116, concept `docs/flow-control-concept.md` §4.4).
//
// Swimlane by lifecycle stage over the #2115 ticket ledger: which ticket is
// where, in what state, owned by whom. Every value on a card is a field the
// reconciler DERIVED from GitHub evidence — this page never looks at a raw
// label, which is what makes a false `Done` impossible (AC2, proven in
// `process/flow-control-view.test.js` rather than claimed here).
//
// The ledger itself stays read-only — no repair button touches it directly.
// #2250 Phase 5 adds one *adjacent* mutation surface, the pool-control panel
// below the board: pause/resume/drain a pooled role, and force-dispatch a
// held ticket past the WIP limit. Both act on the admission lane / pool
// runtime state, never on a ticket's derived state — the ledger's own honesty
// guarantee (§4.1) is untouched.

const PAGE_DESCRIPTION = 'Which ticket is where, in what state, and who owns it — derived from GitHub, never from labels.';

export default function FlowControl() {
  const { data: agents } = useApi('/api/agents');
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter((a) => a.role === 'team') : []),
    [agents],
  );

  const [teamId, setTeamId] = useState('');
  const [state, setState] = useState({ loading: false, error: null, data: null });
  const [poolState, setPoolState] = useState({ loading: false, error: null, data: null });
  const [poolActionError, setPoolActionError] = useState(null);
  const [laneState, setLaneState] = useState({ loading: false, error: null, data: null });

  // Default to the first team once the list arrives; never override a choice.
  useEffect(() => {
    if (!teamId && teams.length > 0) setTeamId(teams[0].id);
  }, [teams, teamId]);

  const load = useCallback(async () => {
    if (!teamId) return;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/tickets`);
      setState({ loading: false, error: null, data });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Failed to load', data: null });
    }
  }, [teamId]);

  const loadPoolControl = useCallback(async () => {
    if (!teamId) return;
    setPoolState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/pool-control`);
      setPoolState({ loading: false, error: null, data });
    } catch (err) {
      setPoolState({ loading: false, error: err.message || 'Failed to load', data: null });
    }
  }, [teamId]);

  const loadLanes = useCallback(async () => {
    if (!teamId) return;
    setLaneState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/pool-lanes`);
      setLaneState({ loading: false, error: null, data });
    } catch (err) {
      setLaneState({ loading: false, error: err.message || 'Failed to load', data: null });
    }
  }, [teamId]);

  useEffect(() => { load(); loadPoolControl(); loadLanes(); }, [load, loadPoolControl, loadLanes]);

  // Pause/resume/drain: fire the write, then refresh both panels — a role's
  // state change can immediately change which held entries are meaningful,
  // and the ticket ledger is cheap enough to just re-sweep rather than patch
  // the previous snapshot in place.
  const setRoleState = useCallback(async (roleId, nextState) => {
    setPoolActionError(null);
    try {
      await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/pool-control/${encodeURIComponent(roleId)}`, { state: nextState });
      await Promise.all([loadPoolControl(), load(), loadLanes()]);
    } catch (err) {
      setPoolActionError(err.message || 'Failed to update');
    }
  }, [teamId, loadPoolControl, load, loadLanes]);

  const forceDispatch = useCallback(async (id) => {
    setPoolActionError(null);
    try {
      await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/force-dispatch`, { id });
      await Promise.all([loadPoolControl(), load(), loadLanes()]);
    } catch (err) {
      setPoolActionError(err.message || 'Failed to force-dispatch');
    }
  }, [teamId, loadPoolControl, load, loadLanes]);

  // Hooks must run before any early return, so the portal is built here and
  // simply not mounted while the page renders its empty state.
  const refreshAll = useCallback(() => { load(); loadPoolControl(); loadLanes(); }, [load, loadPoolControl, loadLanes]);

  const headerAction = usePageActions(
    <button
      onClick={refreshAll}
      disabled={state.loading || !teamId}
      title="Re-run the reconciler sweep"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        padding: '4px 10px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
        color: 'var(--eb-text-primary)', cursor: state.loading || !teamId ? 'default' : 'pointer',
      }}
    >
      <RefreshCw size={13} style={state.loading ? { animation: 'spin 1s linear infinite' } : undefined} />
      Refresh
    </button>,
  );

  const data = state.data;
  const summary = boardSummary(data);
  const lanes = useMemo(() => groupIntoLanes(data && data.tickets), [data]);
  const rollups = useMemo(() => epicRollups(data && data.tickets), [data]);
  const poolRoles = useMemo(() => poolControlRows(poolState.data), [poolState.data]);
  const held = useMemo(() => heldRows(poolState.data), [poolState.data]);
  const laneRoles = useMemo(() => poolLaneRoleRows(laneState.data), [laneState.data]);

  return (
    <>
      {headerAction}
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
            No Agent Team exists yet. The board reads one team&apos;s ticket ledger, so create a team
            first — the Flows page is where a team&apos;s process is authored.
          </Banner>
        ) : (
          <>
            <TeamPicker teams={teams} value={teamId} onChange={setTeamId} />

            {data && data.maintenance && (
              <Banner icon={Info}>Maintenance mode is active — the reconciler sweep is paused.</Banner>
            )}
            {summary.noRepos && (
              <Banner icon={Info}>
                No GitHub repository is bound to this team&apos;s environment, so there is nothing to reconcile.
              </Banner>
            )}
            {summary.errors.length > 0 && (
              <Banner icon={AlertTriangle}>
                Partial sweep — {summary.errors.length} error(s): {summary.errors.join('; ')}
              </Banner>
            )}
            {state.error && <Banner icon={AlertTriangle} tone="error">{state.error}</Banner>}

            {state.loading && !data && (
              <p style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Reconciling…</p>
            )}

            {data && !state.error && (
              <>
                <SummaryRow summary={summary} />
                {poolActionError && <Banner icon={AlertTriangle} tone="error">{poolActionError}</Banner>}
                {poolRoles.length > 0 && (
                  <PoolControlPanel roles={poolRoles} onSetState={setRoleState} busy={poolState.loading} />
                )}
                {held.length > 0 && (
                  <HeldPanel held={held} onForceDispatch={forceDispatch} busy={poolState.loading} />
                )}
                {laneRoles.some((r) => r.lanes.length > 0) && (
                  <PoolLanesPanel roles={laneRoles} />
                )}
                {rollups.length > 0 && <EpicRollups rollups={rollups} />}
                {summary.total === 0 && !data.maintenance && !summary.noRepos ? (
                  <Banner icon={CheckCircle2} tone="ok">
                    No open work items — nothing is in flight for this team.
                  </Banner>
                ) : (
                  <Board lanes={lanes} />
                )}
                <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }}>
                  Swept {summary.swept ?? 0} open item(s) · <WhenCell iso={summary.generatedAt} />
                </p>
              </>
            )}
          </>
        )}
      </div>
    </>
  );
}

/* ── team picker ───────────────────────────────────────────────────── */

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

/* ── header counts ─────────────────────────────────────────────────── */

function SummaryRow({ summary }) {
  const chips = [
    { label: 'in flight', value: summary.total },
    { label: 'blocked', value: summary.blocked, warn: summary.blocked > 0 },
    { label: 'need a human', value: summary.needsHuman },
    { label: 'done', value: summary.done },
  ];
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
      {chips.map((c) => (
        <span
          key={c.label}
          style={{
            fontSize: 'var(--eb-text-xs)', padding: '3px 8px', borderRadius: 'var(--eb-radius-sm)',
            background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
            color: c.warn ? 'var(--eb-status-warning, #d97706)' : 'var(--eb-text-secondary)',
          }}
        >
          <strong style={{ color: 'var(--eb-text-primary)' }}>{c.value}</strong> {c.label}
        </span>
      ))}
    </div>
  );
}

/* ── cross-lane epic roll-up ───────────────────────────────────────── */

function EpicRollups({ rollups }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 600 }}>
          Epics
        </h2>
        <PageHelpButton
          label="How the roll-up counts"
          size={13}
          section={FLOW_CONTROL_HELP_SECTIONS.epics}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </div>
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        {rollups.map((r) => (
          <span
            key={r.epicId}
            style={{
              fontSize: 'var(--eb-text-xs)', padding: '4px 10px', borderRadius: 'var(--eb-radius-md)',
              background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
              color: 'var(--eb-text-secondary)',
            }}
          >
            <strong style={{ color: 'var(--eb-text-primary)' }}>Epic #{r.epicId}</strong>: {rollupSummary(r)}
          </span>
        ))}
      </div>
    </div>
  );
}

/* ── pool controls (#2250 Phase 5) ────────────────────────────────────── */

// One row per pooled role: current pause/drain state + its live instance
// count vs. `maxInstances`, and the button that changes it. A role already
// `running` gets Pause + Drain; a paused/draining one gets Resume only —
// there is deliberately no direct paused↔draining swap (resume, then pick
// the other one, keeps the state machine to three states and two edges per
// state instead of a matrix).
function PoolControlPanel({ roles, onSetState, busy }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 600 }}>
          Pooled roles
        </h2>
        <PageHelpButton
          label="What pause / drain / force dispatch do"
          size={13}
          section={FLOW_CONTROL_HELP_SECTIONS.poolControls}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        {roles.map((r) => (
          <div
            key={r.roleId}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
              padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-surface)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
            }}
          >
            <span style={{ color: 'var(--eb-text-primary)', fontWeight: 500 }}>{r.displayName}</span>
            <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>
              {r.liveInstanceCount} running{r.maxInstances != null ? ` / up to ${r.maxInstances}` : ''}
            </span>
            <PoolStateBadge state={r.state} />
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', marginLeft: 'auto' }}>
              {r.state === 'running' ? (
                <>
                  <PoolButton icon={Pause} label="Pause" onClick={() => onSetState(r.roleId, 'paused')} disabled={busy} />
                  <PoolButton icon={Waves} label="Drain" onClick={() => onSetState(r.roleId, 'draining')} disabled={busy} />
                </>
              ) : (
                <PoolButton icon={Play} label="Resume" onClick={() => onSetState(r.roleId, 'running')} disabled={busy} />
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PoolStateBadge({ state }) {
  if (state === 'running') return null;
  return (
    <span style={{
      fontSize: 'var(--eb-text-xs)', padding: '2px 8px', borderRadius: 'var(--eb-radius-sm)',
      border: '1px solid var(--eb-status-warning, #d97706)', color: 'var(--eb-status-warning, #d97706)',
    }}>
      {state === 'paused' ? 'Paused' : 'Draining'}
    </span>
  );
}

function PoolButton({ icon: Icon, label, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={label}
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

// A held ticket is waiting on the team's `wipLimit`, not on anything wrong
// with it — "Force dispatch" is the one place this board mutates a DISPATCH
// (never the ledger's own derived state). Oldest-held first (`heldRows`).
function HeldPanel({ held, onForceDispatch, busy }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <h2 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 600 }}>
        Held on the WIP limit
      </h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
        {held.map((h) => (
          <div
            key={h.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
              padding: 'var(--eb-space-2) var(--eb-space-3)', background: 'var(--eb-bg-surface)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-sm)',
            }}
          >
            <span style={{ fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-primary)' }}>
              {h.ticket || 'unknown ticket'}
            </span>
            {h.agentId && (
              <code style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
                {h.agentId}
              </code>
            )}
            <span style={{ marginLeft: 'auto' }}>
              <PoolButton icon={Zap} label="Force dispatch" onClick={() => onForceDispatch(h.id)} disabled={busy} />
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ── pool instance lanes (#2273) ──────────────────────────────────────── */

// The read-only "Live surface" (concept Amendment 2 A2.2): per pooled role,
// its live instances as lanes. Read-only by design — pause/drain/force-
// dispatch already live in `PoolControlPanel`/`HeldPanel` above; this panel
// never issues a mutation, only renders what those two (plus the ticket
// ledger) already imply.
function PoolLanesPanel({ roles }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', fontWeight: 600 }}>
          Pool instance lanes
        </h2>
        <PageHelpButton
          label="What running / held / timed-out mean"
          size={13}
          section={FLOW_CONTROL_HELP_SECTIONS.poolLanes}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {roles.filter((r) => r.lanes.length > 0).map((r) => (
          <div key={r.roleId} style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
              {r.displayName}{r.maxInstances != null ? ` · up to ${r.maxInstances}` : ''}
            </span>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
              {r.lanes.map((l) => <PoolLaneRow key={l.ticketId} lane={l} />)}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

const LANE_STATUS_PRESENTATION = {
  running: { icon: Play, label: 'Running', color: 'var(--eb-status-success, #16a34a)' },
  'held-same-epic': { icon: PauseCircle, label: 'Held', color: 'var(--eb-status-warning, #d97706)' },
  'timed-out': { icon: Clock, label: 'Timed out', color: 'var(--eb-status-error, #dc2626)' },
};

function PoolLaneRow({ lane }) {
  const presentation = LANE_STATUS_PRESENTATION[lane.status] || LANE_STATUS_PRESENTATION.running;
  const Icon = presentation.icon;
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-1) var(--eb-space-3)', background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
      }}
    >
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: presentation.color }}>
        <Icon size={12} />
        {presentation.label}
      </span>
      <code style={{ fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-primary)' }}>{lane.ticketId}</code>
      {lane.status === 'held-same-epic' && lane.sameEpicAs && (
        <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          same epic as <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{lane.sameEpicAs}</code>
        </span>
      )}
      {lane.instanceId && (
        <code style={{ marginLeft: 'auto', fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          {lane.instanceId}
        </code>
      )}
    </div>
  );
}

/* ── the board ─────────────────────────────────────────────────────── */

// One column per lifecycle stage, horizontally scrollable. Empty columns are
// kept on purpose: where work is NOT is as informative as where it is, and it
// is what makes the board a board rather than a filtered list.
function Board({ lanes }) {
  return (
    <div style={{ display: 'flex', gap: 'var(--eb-space-3)', overflowX: 'auto', paddingBottom: 'var(--eb-space-2)' }}>
      {lanes.map((lane) => (
        <section
          key={lane.state}
          style={{
            flex: '0 0 260px', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
            background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)',
          }}
        >
          <header style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)' }}>
            <h3 style={{ margin: 0, fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-primary)' }}>
              {lane.label}
            </h3>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
              {lane.count}
              {lane.blocked > 0 && <> · <span style={{ color: 'var(--eb-status-warning, #d97706)' }}>{lane.blocked} blocked</span></>}
            </span>
            {lane.state === 'backlog' && (
              <PageHelpButton
                label="What the stages mean"
                size={12}
                section={FLOW_CONTROL_HELP_SECTIONS.states}
                style={{ padding: 0, flexShrink: 0, marginLeft: 'auto' }}
              />
            )}
          </header>
          {lane.count === 0
            ? <p style={{ margin: 0, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>—</p>
            : lane.tickets.map((c) => <TicketCard key={c.ticketId} card={c} />)}
        </section>
      ))}
    </div>
  );
}

function TicketCard({ card }) {
  return (
    <article
      style={{
        background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
        borderLeft: `3px solid ${card.blocker ? card.color : 'var(--eb-border-default)'}`,
        borderRadius: 'var(--eb-radius-sm)', padding: 'var(--eb-space-2)',
        display: 'flex', flexDirection: 'column', gap: 4,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 'var(--eb-text-xs)' }}>
        <span style={{ fontFamily: 'var(--eb-font-mono)', color: 'var(--eb-text-secondary)' }}>{card.ref}</span>
        {card.age && <span style={{ marginLeft: 'auto', color: 'var(--eb-text-secondary)' }} title="Age in this state">{card.age}</span>}
      </div>

      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.35 }}>
        {card.title}
      </div>

      {card.blocker && (
        <div title={card.reasonDetail || card.blockerBlurb || ''} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{
            fontSize: 'var(--eb-text-xs)', padding: '1px 6px', borderRadius: 'var(--eb-radius-sm)',
            border: `1px solid ${card.color}`, color: card.color,
          }}>
            {card.blockerLabel}
          </span>
          {card.needsHuman && (
            <span title="Waiting on a person" style={{ display: 'inline-flex', color: 'var(--eb-text-secondary)' }}>
              <UserRound size={12} />
            </span>
          )}
        </div>
      )}

      {card.owner && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }} title="Owning agent">
          <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{card.owner}</code>
        </div>
      )}

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)' }}>
        {card.issueUrl && <DeepLink href={card.issueUrl}>issue</DeepLink>}
        {card.prUrl && <DeepLink href={card.prUrl}>{card.prNumber != null ? `PR #${card.prNumber}` : 'PR'}</DeepLink>}
      </div>
    </article>
  );
}

function DeepLink({ href, children }) {
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

/* ── banner ────────────────────────────────────────────────────────── */

function Banner({ icon: Icon, tone, children }) {
  const color = tone === 'error'
    ? 'var(--eb-status-error, #dc2626)'
    : tone === 'ok'
      ? 'var(--eb-status-success, #16a34a)'
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
