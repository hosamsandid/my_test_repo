import React, { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import StatGrid from '../components/StatGrid';
import DataTable from '../components/DataTable';
import StatusBadge from '../components/StatusBadge';
import SetupWizard from './SetupWizard';
import { Settings, Bot, Clock, MessageCircle, Server } from 'lucide-react';

const ACTIVITY_STATUS = {
  busy:     { color: 'var(--eb-status-warning)', label: 'Busy' },
  idle:     { color: 'var(--eb-text-muted)',     label: 'Idle' },
  offline:  { color: 'var(--eb-status-error)',   label: 'Offline' },
  disabled: { color: 'var(--eb-text-muted)',     label: 'Disabled' },
};

function ActivityDot({ state }) {
  const s = ACTIVITY_STATUS[state] ?? ACTIVITY_STATUS.offline;
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{
        width: 8, height: 8, borderRadius: '50%',
        background: s.color, flexShrink: 0,
        ...(state === 'busy' ? { animation: 'eb-status-pulse 1.4s ease-in-out infinite' } : {}),
      }} />
      <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>{s.label}</span>
    </span>
  );
}

const STATUS_POLL_MS = 5000;

function Skeleton() {
  return (
    <div aria-busy="true" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 'var(--eb-space-4)' }}>
        {[1, 2, 3, 4].map(i => (
          <div key={i} style={{ height: 96, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
        ))}
      </div>
      <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
    </div>
  );
}

function SetupNudge() {
  const { data: status } = useApi('/api/setup/status');
  const [wizardOpen, setWizardOpen] = useState(false);

  if (!status || status.isComplete) return null;
  const pending = status.steps.filter(s => !s.done);
  if (pending.length === 0) return null;

  return (
    <>
      {wizardOpen && <SetupWizard onComplete={() => setWizardOpen(false)} />}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 'var(--eb-space-3)',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-accent-primary)',
        borderRadius: 'var(--eb-radius-md)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
          <Settings size={16} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>
              Setup not complete
            </div>
            <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 2 }}>
              {status.steps.filter(s => s.done).length} of {status.steps.length} steps done
              {' · '}
              {pending.map(s => s.label).join(', ')} still missing
            </div>
          </div>
        </div>
        <button
          onClick={() => setWizardOpen(true)}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-4)',
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
            border: 'none', borderRadius: 'var(--eb-radius-md)',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: 'pointer', fontFamily: 'inherit', flexShrink: 0,
          }}
        >
          Resume setup
        </button>
      </div>
    </>
  );
}

const LAST_VIEWED_KEY = 'agentChat.lastViewed';
function loadLastViewed() {
  try { return JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || '{}'); }
  catch { return {}; }
}

function iconForRole(role) {
  switch (role) {
    case 'autonomous': return Clock;
    case 'expert':     return Bot;
    default:           return MessageCircle;
  }
}

function AgentCardRow({ agent, agentMeta, linkTo }) {
  const [hovered, setHovered] = useState(false);
  const Icon = iconForRole(agentMeta?.role);

  const sharedStyle = {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--eb-space-3)',
    padding: '6px var(--eb-space-4)',
    background: hovered && linkTo ? 'var(--eb-bg-hover)' : 'transparent',
    transition: 'background var(--eb-transition-fast)',
    textDecoration: 'none',
    color: 'inherit',
    cursor: linkTo ? 'pointer' : 'default',
  };

  const content = (
    <>
      <Icon
        size={14}
        style={{
          flexShrink: 0,
          color: hovered && linkTo ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)',
          transition: 'color var(--eb-transition-fast)',
        }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
          color: linkTo ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {agent.displayName}
        </div>
        {agentMeta?.environmentName && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            marginTop: 1,
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            <Server size={10} style={{ flexShrink: 0 }} />
            {agentMeta.environmentName}
          </div>
        )}
      </div>
    </>
  );

  if (!linkTo) {
    return <div style={sharedStyle}>{content}</div>;
  }

  return (
    <Link
      to={linkTo}
      style={sharedStyle}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {content}
    </Link>
  );
}

const AGENT_NAME_COLS = {
  unread:  { dotColor: 'var(--eb-status-success)', label: 'Unread',  sublabel: 'Waiting for your reply', highlight: 'success', maxHeight: null },
  busy:    { dotColor: 'var(--eb-status-warning)', label: 'Active',  sublabel: null,                     highlight: 'warning', maxHeight: null },
  idle:    { dotColor: 'var(--eb-text-muted)',     label: 'Idle',    sublabel: null,                     highlight: false,     maxHeight: 180 },
  offline: { dotColor: 'var(--eb-status-error)',   label: 'Offline', sublabel: null,                     highlight: false,     maxHeight: 180 },
};

const HIGHLIGHT_BORDER = {
  success: 'var(--eb-status-success)',
  warning: 'var(--eb-status-warning)',
};
const HIGHLIGHT_BG = {
  success: 'color-mix(in srgb, var(--eb-status-success) 6%, transparent)',
  warning: 'color-mix(in srgb, var(--eb-status-warning) 6%, transparent)',
};

function AgentNameList({ statuses, agents = [] }) {
  const viewed = loadLastViewed();
  const agentMap = Object.fromEntries(agents.map(a => [a.id, a]));

  const unread = statuses
    .filter(s => s.lastResponseAt && new Date(s.lastResponseAt).getTime() > (viewed[s.id] || 0))
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

  const busy = statuses
    .filter(s => s.activityState === 'busy')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

  const idle = statuses
    .filter(s => s.activityState === 'idle')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

  const offline = statuses
    .filter(s => s.activityState === 'offline' || s.activityState === 'disabled')
    .sort((a, b) => (a.displayName ?? '').localeCompare(b.displayName ?? ''));

  const sections = [
    { key: 'unread',  agents: unread },
    { key: 'busy',    agents: busy },
    { key: 'idle',    agents: idle },
    { key: 'offline', agents: offline },
  ];

  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(4, 1fr)',
      gap: 'var(--eb-space-4)',
      marginTop: 'var(--eb-space-4)',
    }}>
      {sections.map(({ key, agents }) => {
        const { dotColor, label, sublabel, highlight, maxHeight } = AGENT_NAME_COLS[key];
        const borderColor = highlight ? HIGHLIGHT_BORDER[highlight] : 'var(--eb-border-default)';
        const bgColor     = highlight && agents.length > 0 ? HIGHLIGHT_BG[highlight] : 'transparent';
        return (
          <div key={key} style={{
            background: 'var(--eb-bg-surface)',
            border: `1px solid ${borderColor}`,
            borderRadius: 'var(--eb-radius-lg)',
            overflow: 'hidden',
          }}>
            {/* Card header */}
            <div style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              background: bgColor,
            }}>
              <div>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 'var(--eb-space-2)',
                  fontSize: 'var(--eb-text-sm)',
                  fontWeight: 'var(--eb-font-semibold)',
                  color: highlight && agents.length > 0 ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                }}>
                  <span style={{
                    width: 8, height: 8, borderRadius: '50%', background: dotColor, flexShrink: 0,
                    ...(highlight && agents.length > 0 ? { animation: 'eb-status-pulse 1.4s ease-in-out infinite' } : {}),
                  }} />
                  {label}
                </div>
                {sublabel && agents.length > 0 && (
                  <div style={{
                    marginTop: 2,
                    marginLeft: 16,
                    fontSize: 'var(--eb-text-xs)',
                    color: 'var(--eb-status-success)',
                    fontWeight: 'var(--eb-font-medium)',
                  }}>
                    {sublabel}
                  </div>
                )}
              </div>
              <span style={{
                fontSize: 'var(--eb-text-xs)',
                color: agents.length > 0 && highlight ? HIGHLIGHT_BORDER[highlight] : 'var(--eb-text-muted)',
                background: 'var(--eb-bg-elevated)',
                borderRadius: 'var(--eb-radius-sm)',
                padding: '1px 6px',
                minWidth: 20,
                textAlign: 'center',
                fontWeight: agents.length > 0 && highlight ? 'var(--eb-font-semibold)' : undefined,
              }}>
                {agents.length}
              </span>
            </div>

            {/* Agent list */}
            {agents.length === 0 ? (
              <div style={{
                padding: 'var(--eb-space-3) var(--eb-space-4)',
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-muted)',
              }}>
                {key === 'unread' ? 'All caught up' : '—'}
              </div>
            ) : (
              <div style={{
                maxHeight: maxHeight ?? undefined,
                overflowY: maxHeight ? 'auto' : undefined,
                display: 'flex',
                flexDirection: 'column',
                padding: 'var(--eb-space-1) 0',
              }}>
                {agents.map(agent => (
                  <AgentCardRow
                    key={agent.id}
                    agent={agent}
                    agentMeta={agentMap[agent.id]}
                    linkTo={key !== 'offline' ? `/chats/${agent.id}` : null}
                  />
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

export default function Dashboard() {
  const { data: dash, loading: dashLoading, error: dashError } = useApi('/api/dashboard');
  const { data: agents, loading: agentsLoading, error: agentsError } = useApi('/api/agents');
  const [statuses, setStatuses] = useState([]);
  const intervalRef = useRef(null);

  useEffect(() => {
    async function fetchStatuses() {
      try {
        const res = await fetch('/api/agents/statuses');
        if (res.ok) setStatuses(await res.json());
      } catch { /* orchestrator unreachable */ }
    }
    fetchStatuses();
    intervalRef.current = setInterval(fetchStatuses, STATUS_POLL_MS);
    return () => clearInterval(intervalRef.current);
  }, []);

  if (dashLoading || agentsLoading) return <Skeleton />;

  if (dashError) {
    return (
      <div role="alert" style={{ padding: 'var(--eb-space-6)', color: 'var(--eb-status-error)' }}>
        Failed to load dashboard: {dashError}
      </div>
    );
  }

  const stats = dash ? [
    { label: 'Total Agents',    value: dash.agents?.total    ?? 0 },
    { label: 'Active',          value: dash.agents?.active   ?? 0, status: 'success' },
    { label: 'Disabled',        value: dash.agents?.disabled ?? 0, status: dash.agents?.disabled > 0 ? 'warning' : undefined },
    { label: 'Triggers',        value: dash.jobs?.total      ?? 0 },
    { label: 'Skills',          value: dash.skills?.total    ?? 0 },
  ] : [];

  const busyCount    = statuses.filter(s => s.activityState === 'busy').length;
  const idleCount    = statuses.filter(s => s.activityState === 'idle').length;
  const offlineCount = statuses.filter(s => s.activityState === 'offline' || s.activityState === 'disabled').length;

  const activityStats = [
    { label: 'Busy',    value: busyCount,    status: busyCount > 0 ? 'warning' : undefined },
    { label: 'Idle',    value: idleCount,    dotColor: 'var(--eb-text-muted)' },
    { label: 'Offline', value: offlineCount, status: offlineCount > 0 ? 'error' : undefined },
  ];

  const statusMap = Object.fromEntries(statuses.map(s => [s.id, s.activityState]));

  const agentCols = [
    { key: 'id',             label: 'ID' },
    { key: 'displayName',    label: 'Name' },
    { key: 'role',           label: 'Role' },
    { key: 'enabled',        label: 'Config',   sortable: false, render: v => <StatusBadge enabled={v !== false} /> },
    { key: 'activityState',  label: 'Activity', sortable: false, render: v => <ActivityDot state={v} /> },
  ];

  const agentsWithStatus = (agents ?? []).map(a => ({
    ...a,
    activityState: statusMap[a.id] ?? 'offline',
  }));

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-6)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Dashboard
      </h1>

      <SetupNudge />

      <StatGrid stats={stats} />

      <section>
        <h2 style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-3)' }}>
          Live Status
        </h2>
        <StatGrid stats={activityStats} />
        <AgentNameList statuses={statuses} agents={agents ?? []} />
      </section>

      <section>
        <h2 style={{ fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-3)' }}>
          Agents
        </h2>
        {agentsError ? (
          <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
            Failed to load agents: {agentsError}
          </div>
        ) : (
          <DataTable
            columns={agentCols}
            data={agentsWithStatus}
            emptyText="No agents found. Add agents via Agent Manager."
          />
        )}
      </section>
    </div>
  );
}
