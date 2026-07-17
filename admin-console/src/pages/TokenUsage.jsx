import React, { useState, useMemo } from 'react';
import { RefreshCw, Download } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import { useApi } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import { TOKEN_CLASSES, GROUP_OPTIONS, formatInt, formatPct, buildDaySeries, stackSegments, buildExportUrl } from './token-usage-view.js';

// Trigger a browser download of an export URL. The endpoints are behind the
// auth-cookie gate, so a same-origin anchor navigation carries the session.
function downloadExport(url) {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// CSV / JSON export buttons for a view (#656 phase 3).
function ExportButtons({ kind, since }) {
  return (
    <span style={{ display: 'inline-flex', gap: 'var(--eb-space-1)' }}>
      {['csv', 'json'].map((format) => (
        <button
          key={format}
          onClick={() => downloadExport(buildExportUrl(kind, { since, format }))}
          title={`Download ${format.toUpperCase()} (tokens only — apply prices downstream)`}
          style={{ ...CONTROL_STYLE, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', cursor: 'pointer' }}
        >
          <Download size={14} /> {format.toUpperCase()}
        </button>
      ))}
    </span>
  );
}

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
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 'var(--eb-space-2)', paddingTop: 8 }}>
        {points.map((p) => {
          const segs = stackSegments(p.tokens, maxTotal);
          const colHeightPct = maxTotal > 0 ? ((p.tokens.total || 0) / maxTotal) * 100 : 0;
          return (
            <div key={p.day} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', alignItems: 'center', minWidth: 24 }}>
              {/* Definite-height plotting area: bars use `%` heights, which only
                  resolve against an ancestor with a fixed height (#696). */}
              <div style={{ width: '100%', height: 180, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center' }}>
                <div
                  title={`${p.day}: ${formatInt(p.tokens.total)} tokens, ${formatInt(p.invocations)} invocations`}
                  style={{ width: '100%', maxWidth: 48, height: `${colHeightPct}%`, minHeight: colHeightPct > 0 ? 2 : 0, display: 'flex', flexDirection: 'column-reverse', borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden' }}
                >
                  {segs.map((s) => (
                    <div key={s.key} style={{ height: `${(s.value / (p.tokens.total || 1)) * 100}%`, background: CLASS_COLOR[s.key] }} />
                  ))}
                </div>
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

// Derive the ISO `since` (and its `until`) query params for a range preset.
function useRangeWindow(rangeKey) {
  return useMemo(() => {
    const preset = RANGE_PRESETS.find((r) => r.key === rangeKey) || RANGE_PRESETS[0];
    if (preset.hours == null) return { since: null };
    return { since: new Date(Date.now() - preset.hours * 60 * 60 * 1000).toISOString() };
  }, [rangeKey]);
}

/* ── Statistics tab (view 1, #654) ─────────────────────────────────── */
function StatisticsTab() {
  const [rangeKey, setRangeKey] = useState('7d');
  const [groupBy, setGroupBy] = useState('agent');
  const { since } = useRangeWindow(rangeKey);

  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const summaryUrl = `/api/usage/summary?${sinceQ}groupBy=${encodeURIComponent(groupBy)}`;
  const dayUrl = `/api/usage/summary?${sinceQ}groupBy=day`;

  const { data: summary, loading, error, refetch } = useApi(summaryUrl);
  const { data: daySummary, refetch: refetchDays } = useApi(dayUrl);

  const totals = summary?.totals || { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0, total: 0, invocations: 0 };
  const groupLabel = (GROUP_OPTIONS.find((g) => g.key === groupBy) || { label: 'Group' }).label;

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
    <>
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
        <ExportButtons kind="summary" since={since} />
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
        <StatCard label="Total tokens" value={formatInt(totals.total)} />
        <StatCard label="Invocations" value={formatInt(totals.invocations)} />
        {TOKEN_CLASSES.map((c) => (
          <StatCard key={c.key} label={c.label} value={formatInt(totals[c.key])} accent={CLASS_COLOR[c.key]} />
        ))}
      </div>

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
    </>
  );
}

/* ── Work items tab (view 2, #655) ─────────────────────────────────── */
// One row per issue↔PR chain (a connected component of the artifact graph),
// with the always-visible unattributed remainder and coverage summary.
const TIER_LABEL = { '0': 'flow', A: 'created', B: 'event', C: 'branch' };

function Chip({ children, color }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 6px', marginRight: 4,
      fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)',
      borderRadius: 'var(--eb-radius-sm)',
      background: color || 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      color: 'var(--eb-text-secondary)',
    }}>{children}</span>
  );
}

function tierSummary(tiers = {}) {
  return Object.entries(tiers)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${TIER_LABEL[t] || t}:${n}`)
    .join(' ') || '—';
}

function WorkItemDetail({ item, since, navigate }) {
  const [owner, repoName] = (item.repo || '/').split('/');
  const addr = item.prs[0] != null ? item.prs[0] : item.issues[0];
  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const url = owner && repoName && addr != null
    ? `/api/usage/work-items/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/${addr}?${sinceQ}`
    : null;
  const { data, loading } = useApi(url);

  if (loading) return <div style={{ padding: 'var(--eb-space-3)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>Loading runs…</div>;
  if (!data) return null;

  return (
    <div style={{ padding: 'var(--eb-space-3)', background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-md)', marginTop: 'var(--eb-space-2)' }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-2)' }}>
        Per role
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-sm)', marginBottom: 'var(--eb-space-4)' }}>
        <thead><tr style={{ color: 'var(--eb-text-secondary)', textAlign: 'left' }}>
          <th style={{ padding: 4 }}>Agent</th><th style={{ padding: 4 }}>Role</th>
          <th style={{ padding: 4, textAlign: 'right' }}>Runs</th><th style={{ padding: 4, textAlign: 'right' }}>Tokens</th>
        </tr></thead>
        <tbody>
          {(data.perAgent || []).map((a) => (
            <tr key={a.agentId}>
              <td style={{ padding: 4, fontFamily: 'var(--eb-font-mono)' }}>{a.agentId}</td>
              <td style={{ padding: 4 }}>{a.roleId || '—'}</td>
              <td style={{ padding: 4, textAlign: 'right' }}>{formatInt(a.runs)}</td>
              <td style={{ padding: 4, textAlign: 'right', fontFamily: 'var(--eb-font-mono)' }}>{formatInt(a.tokens?.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', marginBottom: 'var(--eb-space-2)' }}>
        Runs
      </div>
      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-sm)' }}>
        <thead><tr style={{ color: 'var(--eb-text-secondary)', textAlign: 'left' }}>
          <th style={{ padding: 4 }}>When</th><th style={{ padding: 4 }}>Agent</th>
          <th style={{ padding: 4 }}>Tier</th><th style={{ padding: 4, textAlign: 'right' }}>Tokens</th><th style={{ padding: 4 }} />
        </tr></thead>
        <tbody>
          {(data.runs || []).map((r, i) => (
            <tr key={`${r.correlationId || 'r'}/${i}`}>
              <td style={{ padding: 4, whiteSpace: 'nowrap' }}>{r.ts ? r.ts.replace('T', ' ').slice(0, 16) : '—'}</td>
              <td style={{ padding: 4, fontFamily: 'var(--eb-font-mono)' }}>{r.agentId || '—'}{r.shared ? <Chip>shared</Chip> : null}</td>
              <td style={{ padding: 4 }}>{TIER_LABEL[r.tier] || '—'}</td>
              <td style={{ padding: 4, textAlign: 'right', fontFamily: 'var(--eb-font-mono)' }}>{formatInt(r.tokens?.total)}</td>
              <td style={{ padding: 4 }}>
                {r.agentId && r.correlationId ? (
                  <button
                    onClick={() => navigate(`/chats/${encodeURIComponent(r.agentId)}?session=${encodeURIComponent(r.correlationId)}`)}
                    style={{ ...CONTROL_STYLE, padding: '2px 8px', cursor: 'pointer', fontSize: 'var(--eb-text-xs)' }}
                  >Open session</button>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WorkItemsTab() {
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState('7d');
  const [selected, setSelected] = useState(null);
  const { since } = useRangeWindow(rangeKey);

  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const { data, loading, error, refetch } = useApi(`/api/usage/work-items?${sinceQ}`);

  const cov = data?.coverage || { runs: { attributed: 0, unattributed: 0, total: 0 }, tokens: { attributed: 0, unattributed: 0, total: 0 }, attributedPct: 0 };
  const unatt = data?.unattributed || { total: 0, runs: 0 };

  const rows = useMemo(() => (data?.workItems || []).map((w) => ({
    id: w.id,
    chain: [
      ...w.issues.map((n) => `#${n}`),
      ...w.prs.map((n) => `PR #${n}`),
    ].join(' · ') || w.id,
    repo: w.repo || '—',
    runs: w.runs || 0,
    total: w.tokens?.total || 0,
    input: w.tokens?.input || 0,
    output: w.tokens?.output || 0,
    tiers: tierSummary(w.tiers),
    roles: [...new Set((w.agents || []).map((a) => a.roleId).filter(Boolean))].join(', ') || '—',
    flags: [w.shared ? 'shared' : null, w.flowMismatch ? 'flow-mismatch' : null].filter(Boolean).join(' '),
    _raw: w,
  })), [data]);

  const COLS = [
    { key: 'chain', label: 'Work item', render: (v, r) => (
      <span>{v}{r.flags ? <span style={{ marginLeft: 6 }}>{r.flags.split(' ').map((f) => <Chip key={f} color="var(--eb-status-warning)">{f}</Chip>)}</span> : null}</span>
    ) },
    { key: 'repo', label: 'Repo' },
    { key: 'roles', label: 'Roles' },
    { key: 'runs', label: 'Runs', align: 'right', render: (v) => formatInt(v) },
    { key: 'input', label: 'Input', align: 'right', render: (v) => formatInt(v) },
    { key: 'output', label: 'Output', align: 'right', render: (v) => formatInt(v) },
    { key: 'total', label: 'Total', align: 'right', render: (v) => formatInt(v) },
    { key: 'tiers', label: 'Signals' },
  ];

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
        <select value={rangeKey} onChange={(e) => setRangeKey(e.target.value)} style={CONTROL_STYLE}>
          {RANGE_PRESETS.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button onClick={refetch} style={{ ...CONTROL_STYLE, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', cursor: 'pointer' }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <ExportButtons kind="work-items" since={since} />
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {/* Coverage — attribution is never total, so the remainder is always shown. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
        <StatCard label="Attributed" value={formatPct(cov.attributedPct)} accent="var(--eb-status-success)" />
        <StatCard label="Attributed tokens" value={formatInt(cov.tokens.attributed)} />
        <StatCard label="Unattributed tokens" value={formatInt(unatt.total)} accent="var(--eb-status-warning)" />
        <StatCard label="Unattributed runs" value={formatInt(unatt.runs)} />
        <StatCard label="Total runs" value={formatInt(cov.runs.total)} />
      </div>

      {loading ? (
        <div style={{ height: 160, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable
          columns={COLS}
          data={rows}
          pageSize={25}
          getRowKey={(r) => r.id}
          onRowClick={(r) => setSelected((cur) => (cur === r.id ? null : r.id))}
          emptyText="No attributed work items in this time range."
        />
      )}

      {selected && rows.find((r) => r.id === selected) && (
        <WorkItemDetail item={rows.find((r) => r.id === selected)._raw} since={since} navigate={navigate} />
      )}
    </>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */
const TABS = [
  { key: 'statistics', label: 'Statistics' },
  { key: 'work-items', label: 'Work items' },
];

export default function TokenUsage() {
  const [tab, setTab] = useState('statistics');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <h1 style={{ fontSize: 'var(--eb-text-xl)', fontWeight: 'var(--eb-font-semibold)', margin: 0 }}>
        Token Usage
      </h1>

      <div style={{ display: 'flex', gap: 'var(--eb-space-2)', borderBottom: '1px solid var(--eb-border-default)' }}>
        {TABS.map((t) => (
          <div
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              borderBottom: tab === t.key ? '2px solid var(--eb-text-primary)' : '2px solid transparent',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: 'var(--eb-font-medium)',
              color: tab === t.key ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
              cursor: 'pointer',
            }}
          >
            {t.label}
          </div>
        ))}
      </div>

      {tab === 'statistics' ? <StatisticsTab /> : <WorkItemsTab />}
    </div>
  );
}
