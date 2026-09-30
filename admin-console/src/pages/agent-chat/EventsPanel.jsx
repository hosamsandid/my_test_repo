import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { RefreshCw, AlertCircle, Loader2, RotateCcw, ExternalLink, Activity } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import ConfirmDialog from '../../components/ConfirmDialog';
import PageHelpButton from '../../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat-help-sections.js';
import {
  EVENT_RANGES,
  DEFAULT_EVENT_RANGE,
  rangeSince,
  dropReasonText,
  outcomeView,
  canRefire,
  sessionCorrelationId,
  workItemText,
  refireDialog,
  refiredText,
} from './agent-events-view.js';

/**
 * Right-rail **Events** tab (#2525) — what the agent's GitHub-event triggers
 * actually received. One row per (event, trigger), newest first, from the
 * agent-scoped GET /api/agents/:agentId/github-events: time, repo, work item,
 * event type, wake label and outcome (delivered / digested / dropped with a
 * plain-language reason). A delivered row opens its session, exactly like the
 * GitHub Event Log's chips.
 *
 * **Fire again** is offered on the three drops a protection layer can swallow a
 * real hand-off with (wake-already-armed, throttle, internal-dedup), and only to
 * a caller who may manage the agent; everyone else sees the same list
 * read-only. The orchestrator re-checks everything — the item is still open,
 * the wake label is still on it, nobody fired it again first — so the button
 * is an offer, not the gate.
 */

const POLL_MS = 30_000;

function formatTime(ts) {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : String(ts || '');
}

const TONE_MARKER = {
  success: 'var(--eb-status-success)',
  info: 'var(--eb-accent-primary)',
  warning: 'var(--eb-status-warning)',
  muted: 'var(--eb-text-muted)',
};

export default function EventsPanel({ agentId, active, canManage = false }) {
  const navigate = useNavigate();
  const [range, setRange] = useState(DEFAULT_EVENT_RANGE);
  const [rows, setRows] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [target, setTarget] = useState(null); // row the confirm dialog is open for
  const [busy, setBusy] = useState(false);
  const [refireError, setRefireError] = useState('');
  const [notice, setNotice] = useState(null); // { text, correlationId }
  // Synchronous guard against a double-click submitting twice before `busy`
  // re-renders (AC9 — the server lock is the real guarantee).
  const inFlightRef = useRef(false);

  const fetchRows = useCallback(async (id, rangeKey) => {
    if (!id) { setRows(null); return; }
    setLoading(true);
    setError(null);
    try {
      const since = encodeURIComponent(rangeSince(rangeKey));
      const data = await apiCall('GET', `/api/agents/${encodeURIComponent(id)}/github-events?since=${since}`);
      setRows(Array.isArray(data) ? data : []);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { setRows(null); setNotice(null); }, [agentId]);

  useEffect(() => {
    if (!active) return undefined;
    fetchRows(agentId, range);
    const timer = setInterval(() => fetchRows(agentId, range), POLL_MS);
    return () => clearInterval(timer);
  }, [agentId, active, range, fetchRows]);

  const openSession = (correlationId) => {
    if (!correlationId) return;
    navigate(`/chats/${encodeURIComponent(agentId)}?session=${encodeURIComponent(correlationId)}`);
  };

  const confirmRefire = async () => {
    if (!target || inFlightRef.current) return;
    inFlightRef.current = true;
    setBusy(true);
    setRefireError('');
    try {
      const res = await apiCall('POST', `/api/agents/${encodeURIComponent(agentId)}/github-events/refire`, {
        eventId: target.eventId,
        triggerId: target.triggerId,
      });
      setTarget(null);
      setNotice({ text: 'Fired again — a new session is starting.', correlationId: res?.correlationId || null });
      fetchRows(agentId, range);
    } catch (e) {
      setRefireError(e.message || 'Fire again failed.');
      // Someone else fired it first, or the state moved on — refresh the row.
      fetchRows(agentId, range);
    } finally {
      inFlightRef.current = false;
      setBusy(false);
    }
  };

  const dialog = target ? refireDialog(target) : null;

  const toolbar = (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
      padding: 'var(--eb-space-2) var(--eb-space-4)',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0, background: 'var(--eb-bg-surface)', minHeight: 36,
    }}>
      <select
        value={range}
        onChange={(e) => setRange(e.target.value)}
        aria-label="Time range"
        style={{
          fontSize: 'var(--eb-text-xs)', background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)', padding: '2px 4px',
        }}
      >
        {EVENT_RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
      </select>
      <span style={{ flex: 1, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        {rows ? `${rows.length} event${rows.length === 1 ? '' : 's'}` : ''}
      </span>
      <button
        onClick={() => fetchRows(agentId, range)}
        disabled={loading || !agentId}
        title="Refresh"
        style={{
          background: 'none', border: 'none', color: 'var(--eb-text-muted)',
          cursor: agentId ? 'pointer' : 'default', padding: 2,
          display: 'flex', alignItems: 'center', opacity: (!agentId || loading) ? 0.4 : 1,
        }}
      >
        <RefreshCw size={12} style={loading ? { animation: 'spin 1s linear infinite' } : {}} />
      </button>
      <PageHelpButton
        label="What the Events tab shows"
        size={13}
        section={AGENT_CHAT_HELP_SECTIONS.events}
        style={{ padding: 2 }}
      />
    </div>
  );

  return (
    <div style={panelBox}>
      {toolbar}
      {notice && (
        <div style={{ ...bannerBox, borderColor: 'var(--eb-border-default)' }}>
          <span style={{ flex: 1 }}>{notice.text}</span>
          {notice.correlationId && (
            <button type="button" style={linkButton} onClick={() => openSession(notice.correlationId)}>Open session</button>
          )}
          <button type="button" style={linkButton} onClick={() => setNotice(null)} aria-label="Dismiss">×</button>
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-2)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {loading && !rows && (
          <div style={{ ...centered, gap: 'var(--eb-space-2)', flexDirection: 'row' }}>
            <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} /> Loading events…
          </div>
        )}
        {error && (
          <div style={{ ...centered, gap: 'var(--eb-space-2)', flexDirection: 'row', color: 'var(--eb-status-error)' }}>
            <AlertCircle size={14} /> {error}
          </div>
        )}
        {rows && rows.length === 0 && !error && (
          <div style={centered}>No GitHub events reached this agent in this time range.</div>
        )}
        {rows && rows.map((row) => (
          <EventRow
            key={row.key}
            row={row}
            canManage={canManage}
            onOpenSession={openSession}
            onRefire={(r) => { setRefireError(''); setTarget(r); }}
          />
        ))}
      </div>

      <ConfirmDialog
        open={!!target}
        variant="warning"
        title={dialog ? dialog.title : ''}
        confirmLabel={busy ? 'Firing…' : 'Fire again'}
        busy={busy}
        onConfirm={confirmRefire}
        onCancel={() => { if (!busy) { setTarget(null); setRefireError(''); } }}
        message={dialog && (
          <div>
            <p style={{ margin: 0 }}>{dialog.why}</p>
            {dialog.twin && dialog.twin.correlationId && (
              <p style={{ margin: 'var(--eb-space-2) 0 0' }}>
                <button type="button" style={linkButton} onClick={() => { setTarget(null); openSession(dialog.twin.correlationId); }}>
                  Open the earlier session
                </button>
                {dialog.twin.ts ? <span style={{ color: 'var(--eb-text-muted)' }}> ({formatTime(dialog.twin.ts)})</span> : null}
              </p>
            )}
            <p style={{ margin: 'var(--eb-space-2) 0 0', color: 'var(--eb-text-muted)' }}>{dialog.what}</p>
            {refireError && (
              <p style={{ margin: 'var(--eb-space-2) 0 0', color: 'var(--eb-status-error)' }}>{refireError}</p>
            )}
          </div>
        )}
      />
    </div>
  );
}

const EventRow = React.memo(function EventRow({ row, canManage, onOpenSession, onRefire }) {
  const outcome = outcomeView(row);
  const correlationId = sessionCorrelationId(row);
  const wi = row.workItem;
  const item = workItemText(row);
  return (
    <div style={cardBox}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
        <span>{formatTime(row.ts)}</span>
        <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{row.repo}</span>
        <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{row.event}</code>
      </div>
      {item && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', minWidth: 0 }}>
          {wi && wi.url ? (
            <a href={wi.url} target="_blank" rel="noopener noreferrer" style={{ color: 'inherit', display: 'inline-flex', alignItems: 'center', gap: 4, maxWidth: '100%' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item}</span>
              <ExternalLink size={11} style={{ flexShrink: 0 }} />
            </a>
          ) : item}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', flexWrap: 'wrap' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, color: 'var(--eb-text-primary)' }}>
          <span aria-hidden="true" style={{ width: 7, height: 7, borderRadius: '50%', background: TONE_MARKER[outcome.tone] || TONE_MARKER.muted }} />
          {outcome.text}
        </span>
        {(row.wakeLabel || row.label) && (
          <span style={{ color: 'var(--eb-text-secondary)' }}>label <code style={{ fontFamily: 'var(--eb-font-mono)' }}>{row.wakeLabel || row.label}</code></span>
        )}
        <span style={{ flex: 1 }} />
        {correlationId && (
          <button type="button" style={linkButton} onClick={() => onOpenSession(correlationId)} title="Open the session this event started">
            <Activity size={11} /> Session
          </button>
        )}
        {canRefire(row, { canManage }) && (
          <button type="button" style={actionButton} onClick={() => onRefire(row)} title="Wake the agent now with the same trigger prompt">
            <RotateCcw size={11} /> Fire again
          </button>
        )}
      </div>
      {row.status === 'dropped' && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{dropReasonText(row)}</div>
      )}
      {row.refired && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>{refiredText(row, formatTime)}</div>
      )}
      {row.source === 'manual-refire' && row.refiredBy && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>Fired again by {row.refiredBy}</div>
      )}
    </div>
  );
});

const panelBox = { display: 'flex', flexDirection: 'column', height: '100%' };
const centered = {
  flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center',
  color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)', padding: 'var(--eb-space-4)', textAlign: 'center',
};
const cardBox = {
  display: 'flex', flexDirection: 'column', gap: 4,
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  padding: 'var(--eb-space-2)', background: 'var(--eb-bg-surface)',
};
const bannerBox = {
  display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
  margin: 'var(--eb-space-2) var(--eb-space-2) 0', padding: 'var(--eb-space-2)',
  border: '1px solid', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)', background: 'var(--eb-bg-surface)',
};
const linkButton = {
  display: 'inline-flex', alignItems: 'center', gap: 3,
  background: 'none', border: 'none', padding: 0, cursor: 'pointer',
  color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
};
const actionButton = {
  display: 'inline-flex', alignItems: 'center', gap: 4,
  background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-sm)', padding: '1px 6px', cursor: 'pointer',
  color: 'var(--eb-text-primary)', fontSize: 'var(--eb-text-xs)', fontFamily: 'inherit',
};
