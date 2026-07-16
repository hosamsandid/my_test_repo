import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import { buildTriggerCorrelationId, isSessionOutcome } from './github-event-session';

/* ── Time-range presets ────────────────────────────────────────────── */
const RANGE_PRESETS = [
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '1h', label: 'Last hour', hours: 1 },
];

/* ── Outcome chip ──────────────────────────────────────────────────── */
// Semantics: delivered = success (it worked as intended), dropped = muted
// (a protection layer did its job on purpose, not an error), digest =
// info (bundled, not lost), no matching trigger = warning (worth an
// admin's attention — "nobody's listening" per issue #469 AC #4).
function OutcomeChip({ outcome, eventId, onOpenSession }) {
  let bg, color, label;
  if (outcome.status === 'delivered') {
    bg = 'var(--eb-status-success-bg)';
    color = 'var(--eb-status-success)';
    label = `delivered → ${outcome.agentName || outcome.agentId}`;
  } else if (outcome.status === 'digest') {
    bg = 'var(--eb-status-info-bg)';
    color = 'var(--eb-status-info)';
    label = `digested → ${outcome.agentName || outcome.agentId}`;
  } else {
    bg = 'var(--eb-bg-elevated)';
    color = 'var(--eb-text-secondary)';
    label = `dropped (${outcome.reason || 'unknown'}) → ${outcome.agentName || outcome.agentId}`;
  }

  const baseStyle = {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 'var(--eb-radius-full)',
    fontSize: 'var(--eb-text-xs)',
    fontWeight: 'var(--eb-font-medium)',
    background: bg, color,
    border: `1px solid ${color}`,
    whiteSpace: 'nowrap',
  };

  // Only a `delivered` outcome that carries a triggerId maps to a real Claude
  // session, so only those become an activatable control (AC1/AC2). Everything
  // else stays a plain, non-interactive status chip.
  const correlationId = buildTriggerCorrelationId(outcome.triggerId, eventId);
  if (isSessionOutcome(outcome) && correlationId && onOpenSession) {
    return (
      <button
        type="button"
        onClick={() => onOpenSession(outcome.agentId, correlationId)}
        aria-label={`Open session for ${outcome.agentName || outcome.agentId}`}
        title={`Open the session this event triggered for ${outcome.agentName || outcome.agentId}`}
        style={{
          ...baseStyle,
          cursor: 'pointer',
          fontFamily: 'inherit',
          textDecoration: 'underline',
          textUnderlineOffset: 2,
        }}
      >
        {label}
      </button>
    );
  }

  return <span style={baseStyle}>{label}</span>;
}

function NoMatchBadge() {
  return (
    <span style={{
      display: 'inline-block',
      padding: '1px 6px',
      borderRadius: 'var(--eb-radius-full)',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      background: 'var(--eb-status-warning-bg)',
      color: 'var(--eb-status-warning)',
      border: '1px solid var(--eb-status-warning)',
      whiteSpace: 'nowrap',
    }}>
      nobody's listening
    </span>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */
export default function GithubEventLog() {
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState('24h');

  // Deep-link into the agent chat's Sessions tab, preselecting the session the
  // delivered event triggered (reconstructed correlationId passed via `?session`).
  // Cold-nav safe: AgentChat reads the query param once agents have loaded (#642).
  const openSession = useCallback((agentId, correlationId) => {
    if (!agentId || !correlationId) return;
    navigate(`/chats/${encodeURIComponent(agentId)}?session=${encodeURIComponent(correlationId)}`);
  }, [navigate]);

  const since = useMemo(() => {
    const preset = RANGE_PRESETS.find(r => r.key === rangeKey) || RANGE_PRESETS[0];
    return new Date(Date.now() - preset.hours * 60 * 60 * 1000).toISOString();
  }, [rangeKey]);

  const url = `/api/github-events?since=${encodeURIComponent(since)}&limit=2000`;
  const { data, loading, error, refetch } = useApi(url);

  const events = data || [];

  const COLS = [
    { key: 'ts', label: 'Time', render: v => v ? new Date(v).toLocaleString() : '—' },
    { key: 'repo', label: 'Repository' },
    { key: 'event', label: 'Event', render: (v, row) => (
      <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>
        {v || '—'}{row.label ? ` (${row.label})` : ''}
      </span>
    ) },
    { key: 'actor', label: 'Actor', render: v => v || '—' },
    { key: 'outcomes', label: 'Outcomes', sortable: false, render: (v, row) => {
      if (row.noMatchingTrigger) return <NoMatchBadge />;
      const list = Array.isArray(v) ? v : [];
      return (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {list.map((o, i) => (
            <OutcomeChip key={i} outcome={o} eventId={row.eventId} onOpenSession={openSession} />
          ))}
        </div>
      );
    } },
  ];

  const skeleton = loading;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        GitHub Event Log
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <select
          value={rangeKey}
          onChange={e => setRangeKey(e.target.value)}
          style={{
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)',
            fontFamily: 'inherit',
          }}
        >
          {RANGE_PRESETS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button
          onClick={refetch}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontSize: 'var(--eb-text-sm)',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          <RefreshCw size={14} /> Refresh
        </button>
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {skeleton ? (
        <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable
          columns={COLS}
          data={events}
          pageSize={25}
          getRowKey={(r, i) => `${r.eventId}/${i}`}
          emptyText="No GitHub events recorded in this time range."
        />
      )}
    </div>
  );
}
