import React, { useState, useMemo, useCallback } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import DataTable from '../components/DataTable';
import PageHelpButton from '../components/PageHelpButton';
import WhenCell from '../components/WhenCell';
import { buildTriggerCorrelationId, isSessionOutcome } from './github-event-session';
import { kindLabel, kindTooltip, entryDetail, totalPending } from './pending-queue-view';
import { OUTCOME_LEGEND, outcomeTooltip, noMatchTooltip } from './event-outcome-view';
import { eventLabel } from './agent-chat/trigger-summary';
import { workItemTypeLabel } from './github-event-log-type';
import { GITHUB_EVENTS_HELP_SECTIONS } from './github-events-help-sections';

/* ── Time-range presets ────────────────────────────────────────────── */
const RANGE_PRESETS = [
  { key: '24h', label: 'Last 24 hours', hours: 24 },
  { key: '7d', label: 'Last 7 days', hours: 24 * 7 },
  { key: '1h', label: 'Last hour', hours: 1 },
];

/* ── shared control styling ────────────────────────────────────────── */
const controlStyle = {
  padding: 'var(--eb-space-2) var(--eb-space-3)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-primary)',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

/* ── Outcome chip ──────────────────────────────────────────────────── */
// Semantics: delivered = success (it worked as intended), dropped = muted
// (a protection layer did its job on purpose, not an error), digest =
// info (bundled, not lost), no matching trigger = warning (worth an
// admin's attention — "nobody's listening" per issue #469 AC #4).
function OutcomeChip({ outcome, eventId, onOpenSession }) {
  let bg, color, label;
  // wakeLabel is set when the subscriber's labelFilter matched (#1846). null
  // means any-label listener; undefined means a legacy row or a drop before
  // the label gate (history-horizon). Show it only when it's a real string.
  const wakeSuffix = typeof outcome.wakeLabel === 'string' ? ` (${outcome.wakeLabel})` : '';
  if (outcome.status === 'delivered') {
    bg = 'var(--eb-status-success-bg)';
    color = 'var(--eb-status-success)';
    label = `delivered${wakeSuffix} → ${outcome.agentName || outcome.agentId}`;
  } else if (outcome.status === 'digest') {
    bg = 'var(--eb-status-info-bg)';
    color = 'var(--eb-status-info)';
    label = `digested${wakeSuffix} → ${outcome.agentName || outcome.agentId}`;
  } else {
    bg = 'var(--eb-bg-elevated)';
    color = 'var(--eb-text-secondary)';
    label = `dropped (${outcome.reason || 'unknown'})${wakeSuffix} → ${outcome.agentName || outcome.agentId}`;
  }

  const baseStyle = {
    display: 'inline-block',
    padding: '1px 6px',
    borderRadius: 'var(--eb-radius-full)',
    fontSize: 'var(--eb-text-xs)',
    fontWeight: 'var(--eb-font-medium)',
    background: bg, color,
    border: `1px solid ${color}`,
    // Wrap within the bounded Outcomes column (#1898): the label wraps at its
    // spaces, and a long unbroken token (e.g. a long agent id) breaks rather
    // than overflowing and forcing a horizontal scrollbar (AC5/AC6). Capped at
    // the cell width so no single chip can widen the table.
    whiteSpace: 'normal',
    overflowWrap: 'anywhere',
    wordBreak: 'break-word',
    maxWidth: '100%',
  };

  // Only a `delivered` outcome that carries a triggerId maps to a real Claude
  // session, so only those become an activatable control (AC1/AC2). Everything
  // else stays a plain, non-interactive status chip.
  const explain = outcomeTooltip(outcome);
  const correlationId = buildTriggerCorrelationId(outcome.triggerId, eventId);
  if (isSessionOutcome(outcome) && correlationId && onOpenSession) {
    return (
      <button
        type="button"
        onClick={() => onOpenSession(outcome.agentId, correlationId)}
        aria-label={`Open session for ${outcome.agentName || outcome.agentId}`}
        title={`${explain}\n\nClick to open the session this event triggered.`}
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

  return <span style={baseStyle} title={explain || undefined}>{label}</span>;
}

/* ── Work-item cell (#1827) ────────────────────────────────────────────
   The PR/issue an event happened on, as `#<n>` linking to GitHub in a new
   tab when a URL is present; `—` for events with no work item (push, etc.).
   For a PR that resolves issue(s) (#1833 item 3) a small linked
   `→ closes #<issue>` trails the number, giving issue → PR → merge traceability
   without leaving the page. */
const workItemMono = { fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-sm)' };

// Best-effort GitHub issue URL from the row's `owner/name` repo — the closes
// numbers are parsed data, not links, so we synthesize the target here. Returns
// null when the repo isn't a usable `owner/name`, so the reference degrades to
// plain (unlinked) text rather than a broken link.
function issueUrl(repo, number) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  return `https://github.com/${repo}/issues/${number}`;
}

function ClosesRefs({ closesIssues, repo }) {
  if (!Array.isArray(closesIssues) || closesIssues.length === 0) return null;
  return (
    <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)' }}>
      {' → closes '}
      {closesIssues.map((n, i) => {
        const url = issueUrl(repo, n);
        const text = `#${n}`;
        return (
          <React.Fragment key={n}>
            {i > 0 && ', '}
            {url ? (
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                title={`Open issue ${text} on GitHub`}
                style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none' }}
              >
                {text}
              </a>
            ) : (
              <span>{text}</span>
            )}
          </React.Fragment>
        );
      })}
    </span>
  );
}

function WorkItemCell({ workItem, repo }) {
  if (!workItem || workItem.number == null) {
    return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
  }
  const text = `#${workItem.number}`;
  const kindLabel = workItem.kind === 'pr' ? 'PR' : 'issue';
  const closes = <ClosesRefs closesIssues={workItem.closesIssues} repo={repo} />;
  // No forced nowrap here (#1898): the column wraps, so the `#<n>` and its
  // trailing `→ closes #<issue>` reference may flow onto a second line rather
  // than widening the table.
  return (
    <span>
      {workItem.url ? (
        <a
          href={workItem.url}
          target="_blank"
          rel="noopener noreferrer"
          title={`Open ${kindLabel} ${text} on GitHub`}
          style={{ ...workItemMono, color: 'var(--eb-accent-primary)', textDecoration: 'none' }}
        >
          {text}
        </a>
      ) : (
        <span style={workItemMono}>{text}</span>
      )}
      {closes}
    </span>
  );
}

/* ── Type cell (#1848) — the work-item type (PR / Issue) at a glance, driven
   purely by the persisted `workItem.kind` so it is correct even when the Event
   column shows a raw fallback key. A row with no work item (push / create /
   delete / release) or a legacy row with no kind shows a neutral `—`. */
function TypeCell({ workItem }) {
  const label = workItemTypeLabel(workItem);
  if (!label) return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
  return <span>{label}</span>;
}

/* ── Title cell (#1827; wraps as of #1898) — the work-item title. Its column
   opts into DataTable `wrap`, so instead of truncating to a fixed width the
   title now wraps onto multiple lines within the column (AC4), keeping the
   table at 100% width with no horizontal scrollbar. The full text is still
   offered on hover. */
function TitleCell({ title }) {
  if (!title) return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
  return <span title={title}>{title}</span>;
}

/* ── Repository cell (#1827, restored to prominence in #1833) — the short repo
   name, full `owner/name` on hover. #1829 pushed this to a trailing muted-xs
   column where push/create/delete rows (no work item, no title) read as empty;
   #1833 AC1.1/AC1.2 moves it back to an early column and drops the muted-only
   styling so every row is identifiable. Still short-name for scannability. */
function RepoCell({ repo }) {
  if (!repo) return <span style={{ color: 'var(--eb-text-muted)' }}>—</span>;
  const short = String(repo).split('/').pop();
  return (
    <span
      title={repo}
      style={{ color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-sm)' }}
    >
      {short}
    </span>
  );
}

/* ── Git ref → short branch/tag name (#1833 AC1.3) — `refs/heads/main` → `main`,
   `refs/tags/v1` → `v1`; a bare create/delete ref name passes through. */
function shortRef(ref) {
  if (typeof ref !== 'string' || !ref) return '';
  return ref.replace(/^refs\/heads\//, '').replace(/^refs\/tags\//, '');
}

function NoMatchBadge() {
  return (
    <span
      title={noMatchTooltip()}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 'var(--eb-radius-full)',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-medium)',
        background: 'var(--eb-status-warning-bg)',
        color: 'var(--eb-status-warning)',
        border: '1px solid var(--eb-status-warning)',
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      nobody's listening
    </span>
  );
}

/* ── Collapsible legend for the outcome chips (AC #1) ──────────────────
   Native <details> so no extra deps; each row pairs the chip wording with a
   plain meaning + a "what to do" line sourced from event-outcome-view.js. */
function OutcomeLegend() {
  return (
    <details style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
    }}>
      <summary style={{
        cursor: 'pointer',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: 'var(--eb-font-medium)',
        color: 'var(--eb-text-secondary)',
      }}>
        What do these outcomes mean?
      </summary>
      <div style={{
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
        marginTop: 'var(--eb-space-3)',
      }}>
        {OUTCOME_LEGEND.map(e => (
          <div key={e.key} style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
            <span style={{
              fontFamily: 'var(--eb-font-mono)',
              fontSize: 'var(--eb-text-xs)',
              color: 'var(--eb-text-primary)',
              fontWeight: 'var(--eb-font-medium)',
            }}>
              {e.term}
            </span>
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
              {e.meaning} <span style={{ color: 'var(--eb-text-muted, var(--eb-text-secondary))' }}>{e.whatToDo}</span>
            </span>
          </div>
        ))}
      </div>
    </details>
  );
}

/* ── Processed-events history (the original view, fed by /api/github-events) ─ */
function ProcessedEventsView() {
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

  // Flatten the work-item fields onto each row (#1827) so the DataTable's
  // text filter and sort — both key-based (row[col.key]) — reach the number
  // and title, while the cell renderers read the whole `workItem` object.
  // Best-effort: entries logged before this change simply have no workItem.
  const rows = useMemo(() => (data || []).map(e => ({
    ...e,
    workItemNumber: e.workItem && e.workItem.number != null ? e.workItem.number : null,
    workItemTitle: e.workItem ? e.workItem.title : null,
    // Flat 'PR'/'Issue'/null so the Type column sorts + filters by its own key
    // (#1848), consistent with the Work item / Title columns.
    workItemType: workItemTypeLabel(e.workItem),
  })), [data]);

  const COLS = [
    // Show a scannable relative phrase ("2 minutes ago") with the exact local
    // time on hover, via the shared WhenCell — so this log reads the same
    // friendly way as the credential/connection "Added" columns instead of a
    // raw machine timestamp a new user has to decode.
    { key: 'ts', label: 'Time', render: v => <WhenCell iso={v} /> },
    // Repository restored to an early, prominent position (#1833 AC1.1): #1829's
    // trailing muted column left push/create/delete rows (no work item, no
    // title) reading as empty. Sortable + filterable via the full 'repo' value.
    { key: 'repo', label: 'Repository', render: v => <RepoCell repo={v} /> },
    // Work item + Title (#1827): the PR/issue the event happened on, so the log
    // reads as a work log rather than a machine feed. Both filter/sort by their
    // flat key; the cells render the whole workItem object. The Work-item cell
    // also trails a linked `→ closes #<issue>` for PRs (#1833 item 3), using the
    // row's repo to build the issue URL.
    // Type (#1848): the work-item type (PR / Issue) as an always-visible,
    // scannable column so it needn't be read off the Work-item hover title or
    // inferred from the Event wording. Driven by workItem.kind (its own flat
    // 'workItemType' key so it sorts/filters); work-item-less rows show `—`.
    { key: 'workItemType', label: 'Type', render: (_v, row) => <TypeCell workItem={row.workItem} /> },
    // Work item / Title / Outcomes opt into per-column wrap (#1898, same
    // DataTable flag as Triggers #1643) so their long content wraps within the
    // column instead of widening the table past 100% and spawning a horizontal
    // scrollbar. Enabling wrap here changes only this page — the other ~11
    // DataTable pages stay single-line + ellipsis (AC9).
    { key: 'workItemNumber', label: 'Work item', wrap: true, render: (_v, row) => <WorkItemCell workItem={row.workItem} repo={row.repo} /> },
    { key: 'workItemTitle', label: 'Title', wrap: true, render: v => <TitleCell title={v} /> },
    { key: 'event', label: 'Event', render: (v, row) => {
      // Plain-language event name (single source of truth: the shared eventLabel
      // map used by the trigger editor) so this log reads for someone who
      // doesn't know the GitHub Events API vocabulary. The raw technical event
      // key is no longer shown (#1827) — the friendly name + set label suffice.
      // For a work-item-less push/create/delete the git ref/branch is appended
      // (#1833 AC1.3) so those rows say which branch they touched.
      const friendly = eventLabel(v);
      let suffix = '';
      // Show the raw event-level label only for no-subscriber rows (#1846): when
      // someone was listening, attribution moves to per-outcome wakeLabel chips.
      // For historical rows (no wakeLabel on outcomes) we also omit the suffix
      // rather than show a potentially-wrong collapsed label.
      if (row.noMatchingTrigger && row.label) suffix = ` (${row.label})`;
      else if (row.ref) suffix = ` · ${shortRef(row.ref)}`;
      return <span>{friendly || '—'}{suffix}</span>;
    } },
    { key: 'actor', label: 'Actor', render: v => v || '—' },
    { key: 'outcomes', label: 'Outcomes', sortable: false, wrap: true, render: (v, row) => {
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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* One-line tab lead (#1886): the outcome enumeration it used to spell out
          is the help topic's table, and each chip still explains itself via
          `outcomeTooltip` plus the legend below. */}
      <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
        Events already handled, one outcome per subscriber. Read-only.
      </p>
      {/* The legend decodes the chips at the point of decision (#1886) and stays;
          the "?" beside it opens the longer Outcomes chapter, which additionally
          carries the "my agent never woke up" path and the polled-vs-never-polled
          rule the legend has no room for (#1995). It sits outside <details> — a
          button inside <summary> would be a second control in a toggle. */}
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-1)' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <OutcomeLegend />
        </div>
        <PageHelpButton
          label="What the outcomes mean, and why an agent did not wake up"
          size={14}
          section={GITHUB_EVENTS_HELP_SECTIONS.outcomes}
          style={{ marginTop: 'var(--eb-space-2)', flexShrink: 0 }}
        />
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <select value={rangeKey} onChange={e => setRangeKey(e.target.value)} style={controlStyle}>
          {RANGE_PRESETS.map(r => <option key={r.key} value={r.key}>{r.label}</option>)}
        </select>
        <button onClick={refetch} style={{ ...controlStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', cursor: 'pointer' }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <PageHelpButton
          label="What this table shows"
          size={14}
          section={GITHUB_EVENTS_HELP_SECTIONS.processed}
          style={{ flexShrink: 0 }}
        />
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {loading ? (
        <div style={{ height: 200, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : (
        <DataTable
          columns={COLS}
          data={rows}
          pageSize={25}
          getRowKey={(r, i) => `${r.eventId}/${i}`}
          emptyText="No GitHub events recorded in this time range."
        />
      )}
    </div>
  );
}

/* ── Kind badge for a pending entry ────────────────────────────────── */
function KindBadge({ kind }) {
  return (
    <span
      title={kindTooltip(kind)}
      style={{
        display: 'inline-block',
        padding: '1px 6px',
        borderRadius: 'var(--eb-radius-full)',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-medium)',
        background: 'var(--eb-bg-elevated)',
        color: 'var(--eb-text-secondary)',
        border: '1px solid var(--eb-border-default)',
        whiteSpace: 'nowrap',
        cursor: 'help',
      }}
    >
      {kindLabel(kind)}
    </span>
  );
}

/* ── One agent's pending group ─────────────────────────────────────── */
function AgentPendingGroup({ group, onCancel, busyId }) {
  const COLS = [
    { key: 'kind', label: 'Kind', sortable: false, render: v => <KindBadge kind={v} /> },
    { key: 'detail', label: 'Details', sortable: false, render: (_v, row) => {
      const d = entryDetail(row);
      return d
        ? <span style={{ fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)' }}>{d}</span>
        : <span style={{ color: 'var(--eb-text-secondary)' }}>—</span>;
    } },
    { key: 'receivedAt', label: 'Received', render: v => <WhenCell iso={v} /> },
    { key: '_cancel', label: '', sortable: false, render: (_v, row) => (
      <button
        type="button"
        onClick={() => onCancel(group.agentId, row.id)}
        disabled={busyId === row.id}
        aria-label="Cancel this queued entry"
        title="Remove this entry from the queue before it is delivered"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          padding: '2px 8px',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-status-error)',
          fontSize: 'var(--eb-text-xs)',
          fontFamily: 'inherit',
          cursor: busyId === row.id ? 'default' : 'pointer',
          opacity: busyId === row.id ? 0.5 : 1,
        }}
      >
        <Trash2 size={12} /> {busyId === row.id ? 'Cancelling…' : 'Cancel'}
      </button>
    ) },
  ];

  return (
    <div style={{
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)',
      padding: 'var(--eb-space-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
    }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)' }}>
        <span style={{ fontWeight: 'var(--eb-font-semibold)' }}>{group.agentName || group.agentId}</span>
        {group.agentName && group.agentName !== group.agentId && (
          <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-xs)', fontFamily: 'var(--eb-font-mono)' }}>{group.agentId}</span>
        )}
        <span style={{ marginLeft: 'auto', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>
          {group.count} pending
        </span>
      </div>
      <DataTable
        columns={COLS}
        data={group.entries || []}
        pageSize={10}
        getRowKey={(r) => r.id}
        emptyText="No entries."
      />
    </div>
  );
}

/* ── Live pending-queue view (fed by /api/pending-queue) ───────────── */
function PendingQueueView() {
  const { data, loading, error, refetch } = useApi('/api/pending-queue');
  const [busyId, setBusyId] = useState(null);
  const [notice, setNotice] = useState(null);

  const groups = (data && Array.isArray(data.agents)) ? data.agents : [];
  const total = totalPending(data);

  const onCancel = useCallback(async (agentId, entryId) => {
    if (!agentId || !entryId) return;
    setBusyId(entryId);
    setNotice(null);
    try {
      const res = await apiCall('DELETE', `/api/agents/${encodeURIComponent(agentId)}/pending/${encodeURIComponent(entryId)}`);
      // AC7: the entry may have been drained between view and cancel — report
      // the no-op plainly rather than as an error.
      setNotice(res && res.removed
        ? { kind: 'ok', text: 'Entry cancelled.' }
        : { kind: 'info', text: 'That entry was already gone (drained or cancelled) — nothing to do.' });
    } catch (e) {
      setNotice({ kind: 'error', text: `Cancel failed: ${e.message}` });
    } finally {
      setBusyId(null);
      refetch();
    }
  }, [refetch]);

  const noticeColor = notice?.kind === 'error'
    ? 'var(--eb-status-error)'
    : notice?.kind === 'ok' ? 'var(--eb-status-success)' : 'var(--eb-text-secondary)';

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* One-line tab lead (#1886): why a backlog builds up (Maintenance Mode, a
          busy agent) is the help topic's job; the Cancel button keeps its own
          point-of-action tooltip. */}
      <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
        Events accepted but not yet delivered to their agent — cancellable until they fire.
      </p>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)' }}>
        <button onClick={refetch} style={{ ...controlStyle, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-1)', cursor: 'pointer' }}>
          <RefreshCw size={14} /> Refresh
        </button>
        <PageHelpButton
          label="Why entries wait here, and what Cancel does"
          size={14}
          section={GITHUB_EVENTS_HELP_SECTIONS.pending}
          style={{ flexShrink: 0 }}
        />
        {!loading && <span style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>{total} entr{total === 1 ? 'y' : 'ies'} waiting</span>}
        {notice && <span style={{ color: noticeColor, fontSize: 'var(--eb-text-sm)' }}>{notice.text}</span>}
        {error && <span style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>Failed to load: {error}</span>}
      </div>

      {loading ? (
        <div style={{ height: 160, background: 'var(--eb-bg-elevated)', borderRadius: 'var(--eb-radius-lg)' }} />
      ) : groups.length === 0 ? (
        <div style={{
          padding: 'var(--eb-space-6)',
          textAlign: 'center',
          color: 'var(--eb-text-secondary)',
          border: '1px dashed var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
        }}>
          Nothing is waiting in the dispatch queue. Enqueued events appear here until the target agent drains them.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          {groups.map(g => (
            <AgentPendingGroup key={g.agentId} group={g} onCancel={onCancel} busyId={busyId} />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Main page ─────────────────────────────────────────────────────── */
const PAGE_DESCRIPTION = 'A read-only record of every GitHub event and what happened to it.';

const TABS = [
  { key: 'processed', label: 'Processed events' },
  { key: 'pending', label: 'Pending queue' },
];

export default function GithubEventLog() {
  const [tab, setTab] = useState('processed');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-4)' }}>
      {/* Title comes from the Shell header, so the one-line description plus the
          shared help affordance is this page body's first child (#1886, epic
          #1870 Phase 3 — the multi-clause intro now lives in the
          `github-events` help topic). */}
      <p style={{
        margin: 0, display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
        fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)',
      }}>
        {PAGE_DESCRIPTION}
        {/* The page-level "?" keeps the shared button and now names the first
            chapter explicitly (#1995) — the topic opens at the top either way,
            but the constant records the intent and is guarded like the rest. */}
        <PageHelpButton
          label="How events reach an agent"
          size={14}
          section={GITHUB_EVENTS_HELP_SECTIONS.page}
          style={{ padding: 0, flexShrink: 0 }}
        />
      </p>

      <div style={{ display: 'flex', gap: 'var(--eb-space-1)', borderBottom: '1px solid var(--eb-border-default)' }}>
        {TABS.map(t => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            style={{
              padding: 'var(--eb-space-2) var(--eb-space-3)',
              background: 'transparent',
              border: 'none',
              borderBottom: `2px solid ${tab === t.key ? 'var(--eb-accent, var(--eb-text-primary))' : 'transparent'}`,
              color: tab === t.key ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
              fontSize: 'var(--eb-text-sm)',
              fontWeight: tab === t.key ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
              fontFamily: 'inherit',
              cursor: 'pointer',
              marginBottom: -1,
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'processed'
        ? <ProcessedEventsView />
        : <PendingQueueView />}
    </div>
  );
}
