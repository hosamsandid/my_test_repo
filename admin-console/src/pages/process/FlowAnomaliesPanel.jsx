import React, { useState, useEffect, useCallback } from 'react';
import { AlertTriangle, RefreshCw, ExternalLink, CheckCircle2, Info } from 'lucide-react';
import SidePanel from '../../components/SidePanel';
import WhenCell from '../../components/WhenCell';
import { apiCall } from '../../hooks/useApi';
import { anomalyView, summarize, classInfo } from './flow-anomalies-view';

// Observe-only flow-anomaly panel (#959, concept §4.1/§4.3). Renders the
// orchestrator's deterministic stall classification for a LIVE team: the sweep
// compares the flow's intended label state machine against actual GitHub +
// run state and lists anomalies with age + evidence links. No repair here —
// that is a later phase (the reaction ladder).
export default function FlowAnomaliesPanel({ teamId, onClose, onData }) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiCall('GET', `/api/teams/${encodeURIComponent(teamId)}/flow-anomalies`);
      setState({ loading: false, error: null, data });
      onData?.(data);
    } catch (err) {
      setState({ loading: false, error: err.message || 'Failed to load', data: null });
    }
  }, [teamId, onData]);

  useEffect(() => { load(); }, [load]);

  const data = state.data;
  const anomalies = (data && Array.isArray(data.anomalies) ? data.anomalies : []).map(anomalyView);
  const summary = summarize(data && data.anomalies);

  return (
    <SidePanel open onClose={onClose} title="Flow anomalies" width="560px">
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 'var(--eb-space-3)' }}>
        <p style={{ flex: 1, margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
          Deterministic stall detection — the flow's intended label state machine compared against
          GitHub + run state. Observe-only; nothing is repaired here.
        </p>
        <button
          onClick={load}
          disabled={state.loading}
          title="Re-run the sweep"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, background: 'none',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
            padding: '4px 10px', fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
            color: 'var(--eb-text-primary)', cursor: state.loading ? 'default' : 'pointer',
          }}
        >
          <RefreshCw size={13} style={state.loading ? { animation: 'spin 1s linear infinite' } : undefined} />
          Refresh
        </button>
      </div>

      {data && data.maintenance && (
        <Banner icon={Info}>Maintenance mode is active — the sweep is paused.</Banner>
      )}
      {data && !data.maintenance && Array.isArray(data.repos) && data.repos.length === 0 && (
        <Banner icon={Info}>No GitHub repository is bound to this team's environment, so there is nothing to sweep.</Banner>
      )}
      {data && Array.isArray(data.errors) && data.errors.length > 0 && (
        <Banner icon={AlertTriangle}>Partial sweep — {data.errors.length} repo error(s): {data.errors.join('; ')}</Banner>
      )}

      {state.loading && (
        <p style={{ color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)' }}>Sweeping…</p>
      )}
      {state.error && (
        <Banner icon={AlertTriangle} tone="error">{state.error}</Banner>
      )}

      {!state.loading && !state.error && anomalies.length === 0 && !(data && data.maintenance) && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          color: 'var(--eb-status-success, #16a34a)', fontSize: 'var(--eb-text-sm)',
          padding: 'var(--eb-space-4)', justifyContent: 'center',
        }}>
          <CheckCircle2 size={16} /> No anomalies — the flow is healthy.
        </div>
      )}

      {anomalies.length > 0 && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 'var(--eb-space-3)' }}>
            {Object.entries(summary.byClass).map(([cls, n]) => {
              const info = classInfo(cls);
              return (
                <span key={cls} title={info.blurb || undefined} style={{
                  fontSize: 11, padding: '2px 8px', borderRadius: 999,
                  background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
                  color: 'var(--eb-text-secondary)', cursor: info.blurb ? 'help' : undefined,
                }}>{info.title} · {n}</span>
              );
            })}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {anomalies.map((v, i) => <AnomalyRow key={i} v={v} />)}
          </div>
        </>
      )}

      {data && data.generatedAt && (
        <p style={{ marginTop: 'var(--eb-space-4)', fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }}>
          Swept {data.swept ?? 0} open item(s) · <WhenCell iso={data.generatedAt} />
        </p>
      )}
    </SidePanel>
  );
}

function AnomalyRow({ v }) {
  return (
    <div style={{
      border: '1px solid var(--eb-border-default)', borderLeft: `3px solid ${v.color}`,
      borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)', background: 'var(--eb-bg-surface)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', marginBottom: 4 }}>
        <span style={{ width: 8, height: 8, borderRadius: 999, background: v.color, flexShrink: 0 }} />
        <strong
          title={v.blurb || undefined}
          style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', cursor: v.blurb ? 'help' : undefined }}
        >{v.title}</strong>
        {v.age && <span style={{ fontSize: 11, color: 'var(--eb-text-secondary)' }}>· {v.age}</span>}
        <span style={{ flex: 1 }} />
        {v.objectRef && (
          v.objectUrl
            ? <a href={v.objectUrl} target="_blank" rel="noreferrer" style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11,
                color: 'var(--eb-accent-primary)', textDecoration: 'none',
              }}>{v.objectRef} <ExternalLink size={11} /></a>
            : <span style={{ fontSize: 11, color: 'var(--eb-text-secondary)' }}>{v.objectRef}</span>
        )}
      </div>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        {v.message}
      </div>
      {v.blurb && v.blurb !== v.message && (
        <div style={{
          marginTop: 4, display: 'flex', alignItems: 'flex-start', gap: 6,
          fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))', lineHeight: 1.5,
        }}>
          <Info size={12} style={{ flexShrink: 0, marginTop: 2 }} />
          <span>{v.blurb}</span>
        </div>
      )}
      {(v.agentId || v.label) && (
        <div style={{ marginTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap', fontSize: 11, color: 'var(--eb-text-tertiary, var(--eb-text-secondary))' }}>
          {v.agentId && <span>agent: <code>{v.agentId}</code></span>}
          {v.label && <span>label: <code>{v.label}</code></span>}
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
