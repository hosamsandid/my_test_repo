import React, { useState, useEffect } from 'react';
import { Link } from 'react-router';
import PageHelpButton from '../components/PageHelpButton';
import WhenCell from '../components/WhenCell';
import { GITHUB_EVENTS_HELP_SECTIONS } from './github-events-help-sections';
import {
  statusMeta,
  summarize,
  summaryParts,
  defaultExpanded,
  filterByGroup,
  sortRows,
  describeRow,
  tokenSourceText,
  subscriberSummary,
} from './github-repo-status-view';

/* ── Repository status (#2537) ──────────────────────────────────────────────
   "Which repositories is the poller listening to — and why not the others?"
   Sits directly above the Processed events table. Data comes from
   /api/github-events/repo-status (the poller's own plan + per-repo state,
   scoped to what the viewer may see); the parent owns the fetch so the tab's
   Refresh button reloads both. All wording lives in github-repo-status-view.js. */

const MARKER_COLOR = {
  success: 'var(--eb-status-success)',
  error: 'var(--eb-status-error)',
  warning: 'var(--eb-status-warning)',
  neutral: 'var(--eb-text-muted)',
};

function StatusMarker({ tone }) {
  return (
    <span aria-hidden="true" style={{
      display: 'inline-block', width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
      background: MARKER_COLOR[tone] || MARKER_COLOR.neutral,
    }} />
  );
}

function RepoStatusRow({ row, nowMs }) {
  const meta = statusMeta(row.status);
  const { text, links } = describeRow(row, nowMs);
  return (
    <tr style={{ borderTop: '1px solid var(--eb-border-default)', verticalAlign: 'top' }}>
      <td style={cellStyle}><span style={{ fontFamily: 'var(--eb-font-mono, monospace)', wordBreak: 'break-all' }}>{row.repo}</span></td>
      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--eb-text-primary)' }}>
          <StatusMarker tone={meta.tone} /> {meta.label}
        </span>
      </td>
      <td style={{ ...cellStyle, color: 'var(--eb-text-secondary)' }}>
        <div>{text}</div>
        {links.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-3)', marginTop: 2 }}>
            {links.map((l) => <Link key={l.to} to={l.to} style={{ color: 'var(--eb-accent-primary)' }}>{l.label}</Link>)}
          </div>
        )}
      </td>
      <td style={{ ...cellStyle, color: 'var(--eb-text-secondary)' }}>{tokenSourceText(row)}</td>
      <td style={{ ...cellStyle, color: 'var(--eb-text-secondary)' }}>
        <details>
          <summary style={{ cursor: 'pointer' }}>{subscriberSummary(row)}</summary>
          <ul style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {(row.triggers || []).map((t, i) => (
              <li key={`${t.agentId}/${t.triggerId}/${i}`}>
                <Link to={`/chats/${encodeURIComponent(t.agentId)}?rail=triggers`}>{t.agentName || t.agentId}</Link>
                {' — '}{t.triggerName || t.triggerId || 'trigger'}
                {!t.counted && t.ignoredReason ? ` (ignored: ${t.ignoredReason.replace(/-/g, ' ')})` : ''}
              </li>
            ))}
            {(row.agentRepositoryAgents || []).map((a) => (
              <li key={`ar/${a.id}`}>
                <Link to={`/chats/${encodeURIComponent(a.id)}`}>{a.name || a.id}</Link> — agent-scoped repository
              </li>
            ))}
            {!(row.triggers || []).length && !(row.agentRepositoryAgents || []).length && <li>No agents reference this repository.</li>}
          </ul>
        </details>
      </td>
      <td style={cellStyle}>{row.lastPolledAt ? <WhenCell iso={row.lastPolledAt} /> : '—'}</td>
      <td style={cellStyle}>{row.lastEventAt ? <WhenCell iso={row.lastEventAt} /> : '—'}</td>
    </tr>
  );
}

const cellStyle = { padding: '6px 8px', fontSize: 'var(--eb-text-sm)' };
const headStyle = { ...cellStyle, textAlign: 'left', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-secondary)' };

export default function GithubRepoStatus({ data, error }) {
  const rows = Array.isArray(data && data.repos) ? data.repos : null;
  const [expanded, setExpanded] = useState(null);
  const [group, setGroup] = useState(null);
  // AC6: collapsed when everything listens, expanded when something fails —
  // decided on first data; a user toggle wins after that.
  useEffect(() => {
    if (rows && expanded === null) setExpanded(defaultExpanded(rows));
  }, [rows, expanded]);

  if (!rows) {
    return error
      ? <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)' }}>Repository status unavailable: {error}</div>
      : null;
  }

  const counts = summarize(rows);
  const visible = sortRows(filterByGroup(rows, group));
  const nowMs = Date.now();
  const open = !!expanded;

  return (
    <section aria-label="Repository status" style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)',
      background: 'var(--eb-bg-surface)', padding: 'var(--eb-space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', flexWrap: 'wrap' }}>
        <button
          onClick={() => setExpanded(!open)}
          aria-expanded={open}
          style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)' }}
        >
          {open ? '▾' : '▸'} Repositories
        </button>
        {counts.total === 0 ? (
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>No repositories are configured.</span>
        ) : summaryParts(counts).map((p, i) => (
          <React.Fragment key={p.group}>
            {i > 0 && <span style={{ color: 'var(--eb-text-muted)' }}>·</span>}
            <button
              onClick={() => { setGroup(group === p.group ? null : p.group); setExpanded(true); }}
              aria-pressed={group === p.group}
              title={group === p.group ? 'Show all repositories' : `Show only ${p.text.replace(/^\d+ /, '')}`}
              style={{
                background: group === p.group ? 'var(--eb-bg-selected)' : 'none', border: 'none', borderRadius: 'var(--eb-radius-sm, 4px)',
                padding: '0 4px', cursor: 'pointer', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)',
                display: 'inline-flex', alignItems: 'center', gap: 4,
              }}
            >
              <StatusMarker tone={p.group === 'listening' ? 'success' : p.group === 'failing' ? 'error' : 'warning'} /> {p.text}
            </button>
          </React.Fragment>
        ))}
        <span style={{ flex: 1 }} />
        {data.lastTickAt && (
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            Last poll <WhenCell iso={data.lastTickAt} />
          </span>
        )}
        <PageHelpButton
          label="What the repository statuses mean"
          size={14}
          section={GITHUB_EVENTS_HELP_SECTIONS.repoStatus}
          style={{ flexShrink: 0 }}
        />
      </div>
      {open && counts.total > 0 && (
        <div style={{ overflowX: 'auto', marginTop: 'var(--eb-space-2)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headStyle}>Repository</th>
                <th style={headStyle}>Status</th>
                <th style={headStyle}>Why</th>
                <th style={headStyle}>Token from</th>
                <th style={headStyle}>Subscribers</th>
                <th style={headStyle}>Last poll</th>
                <th style={headStyle}>Last event</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => <RepoStatusRow key={r.repo} row={r} nowMs={nowMs} />)}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
