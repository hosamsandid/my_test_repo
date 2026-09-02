import React, { useState, useMemo, useEffect } from 'react';
import { RefreshCw, Download } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useApi } from '../hooks/useApi';
import { useAuth } from '../auth/AuthContext';
import DataTable from '../components/DataTable';
import InfoTip from '../components/InfoTip';
import { TOKEN_CLASSES, GROUP_OPTIONS, formatInt, formatPct, formatCompact, formatTileCount, niceScale, buildDaySeries, stackSegments, buildExportUrl, workItemAverages, WORK_ITEM_TILE_HELP, STAT_TILE_HELP, TIER_SIGNAL_HELP, COST_NOTE, PAGE_INTRO, isClassVisible, toggleHiddenClass, visibleClassList, visibleTotalTokens, visibleMaxTotal, loadHiddenClasses, saveHiddenClasses } from './token-usage-view.js';

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

// CSV / JSON export buttons for a view (#656 phase 3). `team` narrows the
// export to the page's selected team (#801) — undefined/'' means all teams.
function ExportButtons({ kind, since, team }) {
  return (
    <span style={{ display: 'inline-flex', gap: 'var(--eb-space-1)' }}>
      {['csv', 'json'].map((format) => (
        <button
          key={format}
          onClick={() => downloadExport(buildExportUrl(kind, { since, format, team }))}
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
// `help`, when set, adds an InfoTip "?" affordance next to the label (#832):
// a visible indicator that reveals a plain-language explanation on hover,
// keyboard focus and tap. Purely additive — cards without `help` render
// exactly as before (value, order and layout unchanged).
function StatCard({ label, value, accent, help, title }) {
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginBottom: 4 }}>
        <span>{label}</span>
        {help ? <InfoTip title={label} text={help} size={12} /> : null}
      </div>
      {/* Value is abbreviated (#1656); `title` keeps the exact figure one hover away. */}
      <div title={title} style={{ fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', fontFamily: 'var(--eb-font-mono)' }}>
        {value}
      </div>
    </div>
  );
}

/* ── Stacked time-series (by day) ──────────────────────────────────── */
// Chart geometry (#699). The y-axis gutter and x-axis label row are fixed so
// the plot area has a definite height (bar `%` heights need it, #696) and the
// date labels sit in their own row beneath the plot, never over the bars.
const PLOT_HEIGHT = 180;
const Y_AXIS_WIDTH = 48;
const X_LABEL_HEIGHT = 44;

function TimeSeries({ summary, hidden, onToggle }) {
  const { points } = useMemo(() => buildDaySeries(summary), [summary]);
  // The axis + bar heights are driven by the currently-VISIBLE classes (#1707),
  // so hiding the dominant cache series rescales the whole plot (AC4/AC5).
  const maxTotal = useMemo(() => visibleMaxTotal(points, hidden), [points, hidden]);
  const { top, ticks } = useMemo(() => niceScale(maxTotal), [maxTotal]);
  // With every series toggled off the chart has nothing to draw — show a short
  // empty-state rather than a broken axis (Open Q3 / AC edge). The legend below
  // stays interactive so the user can switch a series back on.
  const allHidden = visibleClassList(hidden).length === 0;
  if (points.length === 0) {
    return (
      <div>
        <div style={{ color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>No usage in this range.</div>
        <Legend hidden={hidden} onToggle={onToggle} />
      </div>
    );
  }
  // Thin the x labels so a wide range (e.g. 30 days) never crowds — show at
  // most ~12, always including the first, each still centered under its bar.
  const labelStride = Math.max(1, Math.ceil(points.length / 12));
  return (
    <div>
      <div style={{ display: 'flex', paddingTop: 8, position: 'relative' }}>
        {allHidden ? (
          <div style={{
            position: 'absolute', left: Y_AXIS_WIDTH, right: 0, top: 8, height: PLOT_HEIGHT,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', pointerEvents: 'none',
          }}>
            No series selected — click a legend item below to show it.
          </div>
        ) : null}
        {/* Y-axis: dynamically-scaled tick labels aligned to the gridlines. */}
        <div style={{ position: 'relative', width: Y_AXIS_WIDTH, height: PLOT_HEIGHT, flex: '0 0 auto' }}>
          {ticks.map((t) => (
            <div
              key={t}
              style={{
                position: 'absolute', right: 6, bottom: `${top > 0 ? (t / top) * 100 : 0}%`,
                transform: 'translateY(50%)', fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-muted)', fontFamily: 'var(--eb-font-mono)', whiteSpace: 'nowrap',
              }}
            >
              {formatCompact(t)}
            </div>
          ))}
        </div>
        {/* Plot area: gridlines behind, bars in front. */}
        <div style={{ position: 'relative', flex: '1 1 0', height: PLOT_HEIGHT, borderLeft: '1px solid var(--eb-border-default)', borderBottom: '1px solid var(--eb-border-default)' }}>
          {ticks.map((t) => (
            <div
              key={t}
              aria-hidden="true"
              style={{
                position: 'absolute', left: 0, right: 0, bottom: `${top > 0 ? (t / top) * 100 : 0}%`,
                borderTop: '1px solid var(--eb-border-default)', opacity: t === 0 ? 0 : 0.5,
              }}
            />
          ))}
          <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'flex-end', gap: 'var(--eb-space-2)', padding: '0 var(--eb-space-1)' }}>
            {points.map((p) => {
              const segs = stackSegments(p.tokens, top, hidden);
              // Column height + segment shares are relative to the VISIBLE-class
              // total for this day, not `tokens.total`, so a hidden class is
              // removed from every stacked column (AC4).
              const vTotal = visibleTotalTokens(p.tokens, hidden);
              const colHeightPct = top > 0 ? (vTotal / top) * 100 : 0;
              return (
                <div key={p.day} style={{ flex: '1 1 0', display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', alignItems: 'center', minWidth: 8, height: '100%' }}>
                  <div
                    title={`${p.day}: ${formatInt(vTotal)} tokens, ${formatInt(p.invocations)} invocations`}
                    style={{ width: '100%', maxWidth: 48, height: `${colHeightPct}%`, minHeight: colHeightPct > 0 ? 2 : 0, display: 'flex', flexDirection: 'column-reverse', borderRadius: 'var(--eb-radius-sm)', overflow: 'hidden' }}
                  >
                    {segs.map((s) => (
                      <div key={s.key} style={{ height: `${(s.value / (vTotal || 1)) * 100}%`, background: CLASS_COLOR[s.key] }} />
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
      {/* X-axis: date labels in a dedicated row beneath the plot, each cell
          matching a bar cell (same left gutter + gap) so labels stay centered. */}
      <div style={{ display: 'flex', height: X_LABEL_HEIGHT }}>
        <div style={{ width: Y_AXIS_WIDTH, flex: '0 0 auto' }} />
        <div style={{ display: 'flex', flex: '1 1 0', gap: 'var(--eb-space-2)', padding: '0 var(--eb-space-1)' }}>
          {points.map((p, i) => (
            <div key={p.day} style={{ flex: '1 1 0', minWidth: 8, display: 'flex', justifyContent: 'center' }}>
              {i % labelStride === 0 ? (
                <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', marginTop: 6, whiteSpace: 'nowrap', transform: 'rotate(-45deg)', transformOrigin: 'top right' }}>
                  {p.day.slice(5)}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <Legend hidden={hidden} onToggle={onToggle} />
    </div>
  );
}

// Interactive legend (#1707): each entry is a real toggle button — click or
// Enter/Space shows/hides its series, and `aria-pressed` exposes the on/off
// state to assistive tech. A hidden series is dimmed with a hollow swatch and
// struck-through label so the state is obvious at a glance (AC3/AC7).
function Legend({ hidden, onToggle }) {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', marginTop: 'var(--eb-space-2)' }}>
      {TOKEN_CLASSES.map((c) => {
        const visible = isClassVisible(hidden, c.key);
        return (
          <button
            key={c.key}
            type="button"
            onClick={() => onToggle(c.key)}
            aria-pressed={visible}
            title={visible ? `Hide ${c.label}` : `Show ${c.label}`}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              padding: '2px 4px', border: 'none', background: 'transparent',
              fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
              color: 'var(--eb-text-secondary)', cursor: 'pointer',
              opacity: visible ? 1 : 0.5,
              textDecoration: visible ? 'none' : 'line-through',
            }}
          >
            <span style={{
              width: 10, height: 10, borderRadius: 2, display: 'inline-block',
              // Hollow (outlined) swatch when hidden, filled when shown.
              background: visible ? CLASS_COLOR[c.key] : 'transparent',
              border: visible ? undefined : `1px solid ${CLASS_COLOR[c.key]}`,
              boxSizing: 'border-box',
            }} />
            {c.label}
          </button>
        );
      })}
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

// Page-level team filter (#801). System-Admin-only page, so the operator sees
// every team; the default "All teams" restores the full, unfiltered picture.
// The chosen team id drives the `?team=` parameter on every usage request.
function TeamFilter({ teams, value, onChange }) {
  return (
    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
      Team
      <select value={value} onChange={(e) => onChange(e.target.value)} style={CONTROL_STYLE}>
        <option value="">All teams</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>{t.name || t.id}</option>
        ))}
      </select>
    </label>
  );
}

// A `team=<id>&` query fragment for concatenating into a usage URL, or '' for
// "all teams" so the request stays unfiltered.
function teamQuery(team) {
  return team ? `team=${encodeURIComponent(team)}&` : '';
}

// Derive the ISO `since` (and its `until`) query params for a range preset.
function useRangeWindow(rangeKey) {
  return useMemo(() => {
    const preset = RANGE_PRESETS.find((r) => r.key === rangeKey) || RANGE_PRESETS[0];
    if (preset.hours == null) return { since: null };
    return { since: new Date(Date.now() - preset.hours * 60 * 60 * 1000).toISOString() };
  }, [rangeKey]);
}

/* ── Statistics tab (view 1, #654) ─────────────────────────────────── */
function StatisticsTab({ team }) {
  const [rangeKey, setRangeKey] = useState('7d');
  const [groupBy, setGroupBy] = useState('agent');
  const { since } = useRangeWindow(rangeKey);

  // Per-series chart visibility (#1707). Held as component state so it survives
  // Refresh + range / Group-by changes within the visit (AC10), and mirrored to
  // per-user localStorage for cross-reload persistence (Open Q2). `hidden` is
  // the set of hidden class keys; empty = all four visible (AC9).
  const { user } = useAuth();
  const username = user?.username;
  const [hidden, setHidden] = useState(() => loadHiddenClasses(username));
  // Adopt the stored set once the username resolves (auth loads after mount).
  useEffect(() => { setHidden(loadHiddenClasses(username)); }, [username]);
  const toggleSeries = (key) => setHidden((cur) => {
    const next = toggleHiddenClass(cur, key);
    saveHiddenClasses(username, next);
    return next;
  });

  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const teamQ = teamQuery(team);
  const summaryUrl = `/api/usage/summary?${sinceQ}${teamQ}groupBy=${encodeURIComponent(groupBy)}`;
  const dayUrl = `/api/usage/summary?${sinceQ}${teamQ}groupBy=day`;

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
        <ExportButtons kind="summary" since={since} team={team} />
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
        <StatCard label="Total tokens" value={formatTileCount(totals.total)} title={formatInt(totals.total)} help={STAT_TILE_HELP.total} />
        <StatCard label="Invocations" value={formatTileCount(totals.invocations)} title={formatInt(totals.invocations)} help={STAT_TILE_HELP.invocations} />
        {TOKEN_CLASSES.map((c) => (
          <StatCard key={c.key} label={c.label} value={formatTileCount(totals[c.key])} title={formatInt(totals[c.key])} accent={CLASS_COLOR[c.key]} help={STAT_TILE_HELP[c.key]} />
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
        <TimeSeries summary={daySummary} hidden={hidden} onToggle={toggleSeries} />
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

function WorkItemDetail({ item, since, team, navigate }) {
  const [owner, repoName] = (item.repo || '/').split('/');
  const addr = item.prs[0] != null ? item.prs[0] : item.issues[0];
  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const teamQ = teamQuery(team);
  const url = owner && repoName && addr != null
    ? `/api/usage/work-items/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/${addr}?${sinceQ}${teamQ}`
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
          <th style={{ padding: 4 }}>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
              Tier
              <InfoTip title="Tier" text={TIER_SIGNAL_HELP} size={12} />
            </span>
          </th><th style={{ padding: 4, textAlign: 'right' }}>Tokens</th><th style={{ padding: 4 }} />
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

function WorkItemsTab({ team }) {
  const navigate = useNavigate();
  const [rangeKey, setRangeKey] = useState('7d');
  const [selected, setSelected] = useState(null);
  const { since } = useRangeWindow(rangeKey);

  const sinceQ = since ? `since=${encodeURIComponent(since)}&` : '';
  const teamQ = teamQuery(team);
  const { data, loading, error, refetch } = useApi(`/api/usage/work-items?${sinceQ}${teamQ}`);

  const cov = data?.coverage || { runs: { attributed: 0, unattributed: 0, total: 0 }, tokens: { attributed: 0, unattributed: 0, total: 0 }, attributedPct: 0 };
  const unatt = data?.unattributed || { total: 0, runs: 0 };

  // Mean cost of one attributed work item (#795) — pure derivation of `data`,
  // so it re-computes on every range change / Refresh with the cards below.
  // `null` averages (zero work items) render as a placeholder, never NaN.
  const avg = useMemo(() => workItemAverages(data), [data]);
  // Tiles show abbreviated notation (#1656); the exact grouped integer stays a
  // hover away via `title`. A null average (zero work items) has no exact figure.
  const fmtAvg = (v) => (v === null ? '—' : formatTileCount(v));
  const fmtAvgTitle = (v) => (v === null ? undefined : formatInt(v));

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
    { key: 'tiers', label: (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        Signals
        <span onClick={(e) => e.stopPropagation()} style={{ display: 'inline-flex' }}>
          <InfoTip title="Signals" text={TIER_SIGNAL_HELP} size={12} />
        </span>
      </span>
    ) },
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
        <ExportButtons kind="work-items" since={since} team={team} />
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {/* Coverage — attribution is never total, so the remainder is always shown. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)' }}>
        <StatCard label="Attributed" value={formatPct(cov.attributedPct)} accent="var(--eb-status-success)" help={WORK_ITEM_TILE_HELP.attributed} />
        <StatCard label="Attributed tokens" value={formatTileCount(cov.tokens.attributed)} title={formatInt(cov.tokens.attributed)} help={WORK_ITEM_TILE_HELP.attributedTokens} />
        <StatCard label="Unattributed tokens" value={formatTileCount(unatt.total)} title={formatInt(unatt.total)} accent="var(--eb-status-warning)" help={WORK_ITEM_TILE_HELP.unattributedTokens} />
        <StatCard label="Unattributed runs" value={formatTileCount(unatt.runs)} title={formatInt(unatt.runs)} help={WORK_ITEM_TILE_HELP.unattributedRuns} />
        <StatCard label="Total runs" value={formatTileCount(cov.runs.total)} title={formatInt(cov.runs.total)} help={WORK_ITEM_TILE_HELP.totalRuns} />
        <StatCard label="Ø total / work item" value={fmtAvg(avg.total)} title={fmtAvgTitle(avg.total)} help={WORK_ITEM_TILE_HELP.avgTotal} />
        <StatCard label="Ø input / work item" value={fmtAvg(avg.input)} title={fmtAvgTitle(avg.input)} help={WORK_ITEM_TILE_HELP.avgInput} />
        <StatCard label="Ø output / work item" value={fmtAvg(avg.output)} title={fmtAvgTitle(avg.output)} help={WORK_ITEM_TILE_HELP.avgOutput} />
        <StatCard label="Ø cache write / work item" value={fmtAvg(avg.cacheCreationInput)} title={fmtAvgTitle(avg.cacheCreationInput)} accent={CLASS_COLOR.cacheCreationInput} help={WORK_ITEM_TILE_HELP.avgCacheCreationInput} />
        <StatCard label="Ø cache read / work item" value={fmtAvg(avg.cacheReadInput)} title={fmtAvgTitle(avg.cacheReadInput)} accent={CLASS_COLOR.cacheReadInput} help={WORK_ITEM_TILE_HELP.avgCacheReadInput} />
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
        <WorkItemDetail item={rows.find((r) => r.id === selected)._raw} since={since} team={team} navigate={navigate} />
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
  // Page-level team filter (#801): shared across both tabs so switching tabs
  // keeps the selected team. '' = all teams (the default, unfiltered view).
  const [team, setTeam] = useState('');
  const { data: teamsData } = useApi('/api/admin/teams');
  const teams = Array.isArray(teamsData) ? teamsData : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 'var(--eb-space-3)', flexWrap: 'wrap' }}>
        <TeamFilter teams={teams} value={team} onChange={setTeam} />
      </div>

      {/* Plain-language intro banner — mirrors the "what this page is" banner
          every peer admin page opens with; copy single-sourced in
          token-usage-view.js (PAGE_INTRO). */}
      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-secondary)',
        lineHeight: 1.6,
      }}>
        <p style={{ margin: 0 }}>{PAGE_INTRO.lead}</p>
        <ul style={{ margin: 'var(--eb-space-2) 0 0', paddingLeft: 'var(--eb-space-5)' }}>
          <li>{PAGE_INTRO.statistics}</li>
          <li style={{ marginTop: 'var(--eb-space-1)' }}>{PAGE_INTRO.workItems}</li>
        </ul>
      </div>

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

      <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {COST_NOTE}
      </div>

      {tab === 'statistics' ? <StatisticsTab team={team} /> : <WorkItemsTab team={team} />}
    </div>
  );
}
