import { useState } from 'react';
import { RefreshCw, Loader2 } from 'lucide-react';
import {
  consumeSyncStream,
  repoStatusText,
  repoStatusSymbol,
  summaryText,
} from '../pages/sync-repos-view.js';

/**
 * "Sync repositories" control (#1342). Streams NDJSON progress from the given
 * endpoint (POST /api/agents/:id/sync-repositories for one agent, or
 * POST /api/environments/:id/sync-agents to fan out to every agent in an
 * environment) and renders one line per repo per agent.
 *
 * Idempotent on the server — already-cloned repos are reported "Already
 * present" and never re-cloned. Uses a raw fetch (not the apiCall helper, which
 * doesn't stream); the session cookie rides along on the same-origin request.
 *
 * Props:
 *   endpoint     — POST URL to stream from
 *   actionLabel  — button text (e.g. "Sync repositories" / "Sync all agents")
 *   description   — one-line explanation shown above the button
 *   showAgentHeaders — group lines under a per-agent header (per-environment)
 */
export default function SyncReposPanel({ endpoint, actionLabel, description, showAgentHeaders = false }) {
  const [running, setRunning] = useState(false);
  const [rows, setRows] = useState([]);
  const [summary, setSummary] = useState(null);
  const [err, setErr] = useState('');

  async function run() {
    setRunning(true);
    setRows([]);
    setSummary(null);
    setErr('');
    const collected = [];
    const push = (row) => { collected.push(row); setRows(collected.slice()); };
    try {
      const res = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      if (!res.ok && !res.body) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const complete = await consumeSyncStream(res, (ev) => {
        if (ev.type === 'agent') {
          if (showAgentHeaders) push({ kind: 'agent', text: ev.displayName || ev.agentId });
        } else if (ev.type === 'repo') {
          push({
            kind: 'repo',
            symbol: repoStatusSymbol(ev.status),
            status: ev.status,
            text: `${ev.name} — ${repoStatusText(ev.status, ev.reason)}${ev.error ? `: ${ev.error}` : ''}`,
          });
        } else if (ev.type === 'agent-skip') {
          push({ kind: 'note', text: 'Workspace not provisioned yet — start the agent, then sync.' });
        } else if (ev.type === 'agent-error') {
          push({ kind: 'repo', symbol: '✗', status: 'failed', text: `Could not reach this agent: ${ev.error}` });
        }
      });
      setSummary((complete && complete.totals) || { total: 0, cloned: 0, skipped: 0, failed: 0 });
    } catch (e) {
      setErr((e && e.message) || 'Sync failed');
    } finally {
      setRunning(false);
    }
  }

  const colorFor = (status) =>
    status === 'failed' ? 'var(--eb-status-error)'
      : status === 'cloned' ? 'var(--eb-status-success)'
        : 'var(--eb-text-secondary)';

  return (
    <div>
      {description && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', marginBottom: 'var(--eb-space-2)' }}>
          {description}
        </div>
      )}
      <button
        type="button"
        onClick={run}
        disabled={running}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', color: 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
          cursor: running ? 'wait' : 'pointer', opacity: running ? 0.7 : 1,
        }}
      >
        {running
          ? <Loader2 size={13} style={{ animation: 'spin 1s linear infinite' }} />
          : <RefreshCw size={13} />}
        {running ? 'Syncing…' : actionLabel}
      </button>
      <style>{`@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}</style>

      {(rows.length > 0 || summary || err) && (
        <div
          style={{
            marginTop: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-3)',
            background: 'var(--eb-bg-app)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', fontSize: 'var(--eb-text-xs)',
            fontFamily: 'var(--eb-font-mono)', maxHeight: 220, overflowY: 'auto',
          }}
        >
          {rows.map((row, i) => {
            if (row.kind === 'agent') {
              return (
                <div key={i} style={{ fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)', marginTop: i ? 'var(--eb-space-2)' : 0 }}>
                  {row.text}
                </div>
              );
            }
            if (row.kind === 'note') {
              return <div key={i} style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic', paddingLeft: showAgentHeaders ? 'var(--eb-space-3)' : 0 }}>{row.text}</div>;
            }
            return (
              <div key={i} style={{ color: colorFor(row.status), paddingLeft: showAgentHeaders ? 'var(--eb-space-3)' : 0 }}>
                <span style={{ display: 'inline-block', width: '1.2em' }}>{row.symbol}</span>{row.text}
              </div>
            );
          })}
          {summary && (
            <div style={{ marginTop: 'var(--eb-space-2)', color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-medium)' }}>
              {summaryText(summary)}
            </div>
          )}
          {err && (
            <div style={{ color: 'var(--eb-status-error)' }}>{err}</div>
          )}
        </div>
      )}
    </div>
  );
}
