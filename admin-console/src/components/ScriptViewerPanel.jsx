import React, { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import SidePanel from './SidePanel';
import { apiCall } from '../hooks/useApi';

/**
 * ScriptViewerPanel — Slide-in viewer for an allowlisted helper script.
 *
 * Fetches `GET /api/scripts/:name` on open and renders the content read-only.
 * Reusable across the trigger UI and the team-setup review.
 *
 * Props:
 *   open       — boolean
 *   onClose    — () => void
 *   scriptName — string (e.g. "multi-agent-bid") — the allowlist key, NOT a path
 */
export default function ScriptViewerPanel({ open, onClose, scriptName }) {
  const [content, setContent] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!open || !scriptName) {
      setContent(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    setContent(null);
    apiCall('GET', `/api/scripts/${encodeURIComponent(scriptName)}`)
      .then((data) => { if (!cancelled) setContent(data); })
      .catch((e) => { if (!cancelled) setError(e.message || 'Failed to load script'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, scriptName]);

  const title = content?.path ? `Script: ${content.path}` : `Script: ${scriptName || ''}`;

  return (
    <SidePanel open={open} onClose={onClose} title={title} width="min(880px, 75vw)" loading={loading}>
      {loading && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-muted)' }}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          Loading script…
        </div>
      )}
      {error && (
        <div style={{
          padding: 'var(--eb-space-3)',
          background: 'var(--eb-bg-elevated)',
          border: '1px solid var(--eb-status-error)',
          borderRadius: 'var(--eb-radius-md)',
          color: 'var(--eb-status-error)',
          fontSize: 'var(--eb-text-sm)',
        }}>
          {error}
        </div>
      )}
      {content && (
        <>
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            marginBottom: 'var(--eb-space-2)',
          }}>
            Read-only. Bundled with the orchestrator image — edits require a code change and redeploy.
          </div>
          <pre style={{
            fontSize: 'var(--eb-text-xs)',
            fontFamily: 'var(--eb-font-mono)',
            lineHeight: 1.5,
            padding: 'var(--eb-space-3)',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            overflow: 'auto',
            margin: 0,
            whiteSpace: 'pre',
            color: 'var(--eb-text-primary)',
          }}>
            {content.content}
          </pre>
        </>
      )}
    </SidePanel>
  );
}
