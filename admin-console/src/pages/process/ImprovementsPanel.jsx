import React, { useState, useEffect, useCallback } from 'react';
import { TrendingUp, Play, AlertTriangle, Info, Clock } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import { apiCall } from '../../hooks/useApi';
import { hasSnapshot, isMaintenance, snapshotMeta, metricTiles } from './hill-climb-view';

// Improvements panel (hill-climbing loop Phase 1, #1223) — sibling of the
// Anomalies panel (`FlowAnomaliesPanel.jsx`). Renders the deterministic §4
// run-metric catalog for a LIVE team from the latest persisted snapshot
// (`GET /api/teams/:id/hill-climb/metrics`, #1222) and offers a manual pass
// (`POST .../hill-climb/run`). Measure-only: no improvement cards here — those
// land with #1224.
export default function ImprovementsPanel({ teamId, onClose }) {
  const [state, setState] = useState({ loading: true, error: null, resp: null });
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState(null); // { tone, text }

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const resp = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/metrics`);
      setState({ loading: false, error: null, resp });
    } catch (err) {
      setState({ loading: false, error: err.message || 'Failed to load', resp: null });
    }
  }, [teamId]);

  useEffect(() => { load(); }, [load]);

  // Run now → a manual metrics pass. The panel reflects the fresh snapshot from
  // the response without a reload (AC). A pass already in flight answers
  // 409 pass-running; maintenance mode answers `{ maintenance:true }`.
  const runNow = useCallback(async () => {
    setRunning(true);
    setNotice(null);
    try {
      const resp = await apiCall('POST', `/api/teams/${encodeURIComponent(teamId)}/hill-climb/run`);
      if (isMaintenance(resp)) {
        setNotice({ tone: 'info', text: 'Maintenance mode is active — the metrics pass is paused. Try again once maintenance ends.' });
      } else {
        setState({ loading: false, error: null, resp });
      }
    } catch (err) {
      if (err.status === 409) {
        setNotice({ tone: 'info', text: 'A metrics pass is already running for this team — give it a moment, then Refresh.' });
      } else {
        setNotice({ tone: 'error', text: err.message || 'Run failed' });
      }
    } finally {
      setRunning(false);
    }
  }, [teamId]);

  const resp = state.resp;
  const snapshot = hasSnapshot(resp) ? resp.snapshot : null;
  const meta = snapshot ? snapshotMeta(snapshot) : null;
  const tiles = snapshot ? metricTiles(snapshot) : [];

  return (
    <SidePanel open onClose={onClose} title="Improvements" width="560px">
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)' }}>
        <p style={{ flex: 1, margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          Deterministic run metrics for this team — folded from session logs, anomaly sweeps and the event
          log over the measurement window. Observe-only; no changes are proposed or applied here.
        </p>
        <button
          onClick={runNow}
          disabled={running}
          title="Run a metrics pass now"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: '4px 10px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', flexShrink: 0,
            color: 'var(--eb-text-primary)', cursor: running ? 'default' : 'pointer',
          }}
        >
          <Play size={13} style={running ? { animation: 'spin 1s linear infinite' } : undefined} />
          {running ? 'Running…' : 'Run now'}
        </button>
      </div>

      {notice && (
        <Banner icon={notice.tone === 'error' ? AlertTriangle : Info} tone={notice.tone}>{notice.text}</Banner>
      )}

      {state.loading && (
        <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>Loading metrics…</p>
      )}
      {state.error && !state.loading && (
        <Banner icon={AlertTriangle} tone="error">{state.error}</Banner>
      )}

      {/* Empty state — team has never run a pass. */}
      {!state.loading && !state.error && !snapshot && (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 'var(--eb-space-3)',
          padding: 'var(--eb-space-6) var(--eb-space-4)', textAlign: 'center',
          color: 'var(--eb-text-secondary)',
        }}>
          <TrendingUp size={28} style={{ color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }} />
          <div style={{ fontSize: 'var(--eb-text-sm)', lineHeight: 1.5 }}>
            No metrics pass has run for this team yet.<br />
            Run one now to fold the last window of run activity into the metric catalog.
          </div>
        </div>
      )}

      {/* Metric tiles. */}
      {!state.loading && !state.error && snapshot && (
        <>
          {meta.insufficientData && (
            <Banner icon={Info}>
              Only {meta.totalRuns} run(s) in the window — below the {meta.minRuns}-run floor. Ratio metrics
              are withheld rather than reported off a thin sample; counting metrics are still shown.
            </Banner>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--eb-space-2)' }}>
            {tiles.map((t) => <MetricTile key={t.key} tile={t} />)}
          </div>

          <div style={{
            marginTop: 'var(--eb-space-4)', display: 'flex', alignItems: 'center', gap: 6,
            fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))',
          }}>
            <Clock size={12} />
            {meta.windowDays ? `${meta.windowDays}-day window · ` : ''}
            {meta.totalRuns} run(s)
            {meta.generatedAt ? ` · last pass ${new Date(meta.generatedAt).toLocaleString()}` : ''}
          </div>
        </>
      )}
    </SidePanel>
  );
}

// One metric tile. Big value for 'ok'; an explicit muted state label for
// 'insufficient' / 'none' — never a misleading zero.
function MetricTile({ tile }) {
  const isValue = tile.state === 'ok';
  const stateLabel = tile.state === 'insufficient' ? 'Insufficient data' : '—';
  return (
    <div style={{
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
      display: 'flex', flexDirection: 'column', gap: 4,
    }}>
      <div
        title={tile.help || undefined}
        style={{
          fontSize: 11, color: 'var(--eb-text-secondary)', textTransform: 'uppercase',
          letterSpacing: '0.03em', cursor: tile.help ? 'help' : undefined,
        }}
      >{tile.label}</div>
      <div style={{
        fontSize: isValue ? 'var(--eb-text-xl, 1.35rem)' : 'var(--eb-text-sm)',
        fontWeight: isValue ? 600 : 400,
        color: isValue ? 'var(--eb-text-primary)' : 'var(--eb-text-tertiary, var(--eb-text-secondary))',
        fontStyle: isValue ? 'normal' : 'italic',
      }}>
        {isValue ? tile.value : stateLabel}
      </div>
      {tile.sub && (
        <div style={{ fontSize: 11, color: 'var(--eb-text-secondary)' }}>{tile.sub}</div>
      )}
      {tile.note && (
        <div style={{ fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))', lineHeight: 1.4 }}>
          {tile.note}
        </div>
      )}
    </div>
  );
}

function Banner({ icon: Icon, tone, children }) {
  const color = tone === 'error' ? 'var(--eb-status-error, #dc2626)' : 'var(--eb-text-secondary)';
  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', borderRadius: 'var(--eb-radius-md)',
      background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
      fontSize: 'var(--eb-text-sm)', color,
    }}>
      <Icon size={15} style={{ flexShrink: 0, marginTop: 1 }} /> <span>{children}</span>
    </div>
  );
}
