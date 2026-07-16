import React, { useState, useMemo } from 'react';
import { RefreshCw } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import { TOKEN_CLASSES, GROUP_OPTIONS, formatInt, buildDaySeries, stackSegments } from './token-usage-view.js';

/* ── Time-range presets ────────────────────────────────────────────── */
const RANGE_PRESETS = [
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '30d', label: 'Last 30 days', hours: 24 * 30 },
  { key: 'all', label: 'All time', hours: null },
];

// One stable colour per token class (shared by cards, chart, legend). Uses the
// design-token status palette so it tracks the light/dark theme.
const CLASS_COLOR = {
  input: 'var(--eb-status-info)',
  output: 'var(--eb-status-success)',
  cacheCreationInput: 'var(--eb-status-warning)',
  cacheReadInput: 'var(--eb-accent, var(--eb-status-info))',
};

/* ── Summary card ──────────────────────────────────────────────────── */
function StatCard({ label, value, accent }) {
  return (
    <div style={{
      flex: '1 1 120px',
      minWidth: 120,
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      borderTop: accent ? `3px solid ${accent}` : undefined,
    }}>
      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', fontFamily: 'var(--eb-font-mono)' }}>
        {value}
      </div>
    </div>
  );
}

/* ── Stacked time-series (by day) ──────────────────────────────────── */
function TimeSeries({ summary }) {
  const { points, maxTotal } = useMemo(() => buildDaySeries(summary), [summary]);
  if (points.length === 0) {
    return <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>No usage in this range.</div>;
  }
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--eb-space-2)', height: 180, paddingTop: 8 }}>
        {points.map((p) => {
          const segs = stackSegments(p.tokens, maxTotal);
          const colHeightPct = maxTotal > 0 ? ((p.tokens.total || 0) / maxTotal) * 100 : 0;
          return (
            <div key={p.day} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 24 }}>
              <div
                title={`${p.day}: ${formatInt(p.tokens.total)} tokens, ${formatInt(p.invocations)} invocations`}
                style={{ width: '100%', maxWidth: 48, height: `${colHeightPct}%`, minHeight: colHeightPct > 0 ? 2 : 0, display: 'flex', flexDirection: 'column-reverse', borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden' }}
              >
                {segs.map((s) => (
                  <div key={s.key} style={{ height: `${(s.value / (p.tokens.total || 1)) * 100}%`, background: CLASS_COLOR[s.key] }} />
                ))}
              </div>
              <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 4, whiteSpace: 'nowrap', transform: 'rotate(-45deg)', transformOrigin: 'top left', height: 40 }}>
                {p.day.slice(5)}
              </div>
            </div>
          );
        })}
      </div>
      <Legend />
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', marginTop: 'var(--eb-space-2)' }}>
      {TOKEN_CLASSES.map((c) => (
        <span key={c.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          <span style={{ width: 10, height: 10, borderRadius: 2, background: CLASS_COLOR[c.key], display: 'inline-block' }} />
          {c.label}
        </span>
      ))}
    </div>
  );
}

const CONTROL_STYLE = {
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

/* ── Main page ─────────────────────────────────────────────────────── */
export default function TokenUsage() {
  const [rangeKey, setRangeKey] = useState('7d');
  const [groupBy, setGroupBy] = useState('agent');

  const since = useMemo(() => {
    const preset = RANGE_PRESETS.find((r) => r.key === rangeKey) || RANGE_PRESETS[0];
    if (preset.hours == null) return null;
    return new Date(Date.now() - preset.hours * 60 * 60 * 1000).toISOString();
  }, [rangeKey]);

  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const summaryUrl = `/api/usage/summary?${sinceQ}groupBy=${encodeURIComponent(groupBy)}`;
  const dayUrl = `/api/usage/summary?${sinceQ}groupBy=day`;

  const { data: summary, loading, error, refetch } = useApi(summaryUrl);
  const { data: daySummary, refetch: refetchDays } = useApi(dayUrl);

  const totals = summary?.totals || { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0, total: 0, invocations: 0 };

  const groupLabel = (GROUP_OPTIONS.find((g) => g.key === groupBy) || { label: 'Group' }).label;

  // Flatten each group into a single-level row so DataTable's built-in sort
  // and filter operate on the numeric token values directly (it reads
  // row[col.key]).
  const rows = useMemo(() => (summary?.groups || []).map((g) => ({
    key: g.key,
    input: g.tokens?.input || 0,
    output: g.tokens?.output || 0,
    cacheCreationInput: g.tokens?.cacheCreationInput || 0,
    cacheReadInput: g.tokens?.cacheReadInput || 0,
    total: g.tokens?.total || 0,
    invocations: g.invocations || 0,
  })), [summary]);

  const COLS = [
    { key: 'key', label: groupLabel, render: (v) => v || '—' },
    ...TOKEN_CLASSES.map((c) => ({ key: c.key, label: c.label, align: 'right', render: (v) => formatInt(v) })),
    { key: 'total', label: 'Total', align: 'right', render: (v) => formatInt(v) },
    { key: 'invocations', label: 'Invocations', align: 'right', render: (v) => formatInt(v) },
  ];

  const refresh = () => { refetch(); refetchDays(); };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Token Usage
      </h1>

      {/* Tabs — only Statistics for phase 1 (cost-per-PR is a later view). */}
      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', borderBottom: '1px solid var(--eb-border-default)' }}>
        <div style={{
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          borderBottom: '2px solid var(--eb-text-primary)',
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 'var(--eb-font-medium)',
        }}>
          Statistics
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
        <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} style={CONTROL_STYLE}>
          {RANGE_PRESETS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <label style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Group by</label>
        <select value={groupBy} onChange={(e) => setGroupBy(e.target.value)} style={CONTROL_STYLE}>
          {GROUP_OPTIONS.map((g) => <option key={g.key} value={g.key}>{g.label}</option>)}
        </select>
        <button onClick={refresh} style={{ ...CONTROL_STYLE, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', cursor: 'pointer' }}>
          <RefreshCw size={14} /> Refresh
        </button>
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {/* Summary cards — total + invocations, then the four-class split (always visible). */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
        <StatCard label="Total tokens" value={formatInt(totals.total)} />
        <StatCard label="Invocations" value={formatInt(totals.invocations)} />
        {TOKEN_CLASSES.map((c) => (
          <StatCard key={c.key} label={c.label} value={formatInt(totals[c.key])} accent={CLASS_COLOR[c.key]} />
        ))}
      </div>

      {/* Time series (by day). */}
      <div style={{
        padding: 'var(--eb-space-4)',
        background: 'var(--eb-bg-elevated)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
      }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-3)' }}>
          Tokens per day
        </div>
        <TimeSeries summary={daySummary} />
      </div>

      {/* Grouped breakdown. */}
      {loading ? (
        <div style={{ height: 160, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable
          columns={COLS}
          data={rows}
          pageSize={25}
          getRowKey={(r, i) => `${r.key}/${i}`}
          emptyText="No token usage recorded in this time range."
        />
      )}
    </div>
  );
}
