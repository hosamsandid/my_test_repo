import React, { useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle, Copy, Check } from 'lucide-react';
import PromptHistory from './PromptHistory';

/**
 * Read-only preview of the fully-composed system prompt an agent actually
 * receives: the seeded CLAUDE.md plus the runtime `--append-system-prompt`
 * memory hint. Fetches `GET /api/agents/:id/prompt-preview` on mount / when
 * the agentId changes.
 *
 * Props:
 *   - agentId   Selected agent. When null, shows a "pick an agent" stub.
 *   - embedded  When true the panel omits its own header strip (the parent
 *               tabbed right rail renders its own tab strip + close button).
 */
export default function PromptPreviewPanel({ agentId, embedded = false }) {
  const [data, setData]       = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState(null);
  // Bumped after a rollback so the composed preview re-fetches the reverted prompt.
  const [reload, setReload]   = useState(0);

  // Bump generation counter on agent change so a slow response from the
  // previous agent can't clobber the current state.
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!agentId) {
      setData(null);
      setError(null);
      return;
    }
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setData(null);

    fetch(`/api/agents/${encodeURIComponent(agentId)}/prompt-preview`)
      .then(r => r.json().then(j => ({ ok: r.ok, j })))
      .then(({ ok, j }) => {
        if (reqId !== reqIdRef.current) return; // outdated agent
        if (!ok) throw new Error(j?.error || 'Failed');
        setData(j);
      })
      .catch(e => {
        if (reqId !== reqIdRef.current) return;
        setError(e.message || 'Failed to load prompt preview');
      })
      .finally(() => {
        if (reqId === reqIdRef.current) setLoading(false);
      });
  }, [agentId, reload]);

  const meta = data?.meta || {};
  const badges = data ? buildBadges(data.role, meta) : [];

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {/* Header strip — hidden when embedded inside the tabbed right rail. */}
      {!embedded && (
        <div style={{
          height: 'var(--eb-header-height)',
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-2)',
          padding: '0 var(--eb-space-3)',
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-surface)',
        }}>
          <div style={{
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-semibold)',
            color: 'var(--eb-text-secondary)',
          }}>
            System prompt preview
          </div>
        </div>
      )}

      {!agentId && (
        <div style={emptyStyle}>
          Select an agent to preview its system prompt.
        </div>
      )}

      {agentId && loading && (
        <div style={emptyStyle}>
          <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
          <span style={{ marginLeft: 8 }}>Loading prompt preview…</span>
        </div>
      )}

      {agentId && !loading && error && (
        <div style={{ ...emptyStyle, color: 'var(--eb-status-error)', padding: 'var(--eb-space-4)' }}>
          <AlertCircle size={14} />
          <span style={{ marginLeft: 8 }}>{error}</span>
        </div>
      )}

      {agentId && !loading && !error && data && (
        <div style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: 'var(--eb-space-3)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--eb-space-3)',
        }}>
          {/* One-line explanation */}
          <p style={{
            margin: 0,
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            lineHeight: 1.5,
          }}>
            This is exactly what the agent receives: the composed CLAUDE.md
            seeded into its workspace, plus a runtime hint appended at every
            Claude invocation.
          </p>

          {/* Meta badges */}
          {badges.length > 0 && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {badges.map(b => <Badge key={b} label={b} />)}
            </div>
          )}

          <PromptSection
            title="CLAUDE.md (seeded into workspace)"
            text={data.claudeMd}
          />
          <PromptSection
            title="Runtime append (--append-system-prompt)"
            text={data.appendSystemPrompt}
          />

          <PromptHistory agentId={agentId} onReverted={() => setReload(n => n + 1)} />
        </div>
      )}

      <style>{`
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>
    </div>
  );
}

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function buildBadges(role, meta) {
  const out = [];
  if (role) out.push(role);
  if (meta.sessionPolicy) out.push(meta.sessionPolicy);
  out.push(meta.autonomous ? 'autonomous' : 'interactive');
  if (meta.hasRepository) out.push('repo');
  if (meta.hasSkills) out.push('skills');
  if (meta.blueprintInstance) out.push('blueprint');
  return out;
}

function Badge({ label }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      padding: '2px 8px',
      fontSize: 'var(--eb-text-xs)',
      fontWeight: 'var(--eb-font-medium)',
      color: 'var(--eb-text-secondary)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-full)',
      whiteSpace: 'nowrap',
    }}>
      {label}
    </span>
  );
}

function PromptSection({ title, text }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef(null);
  useEffect(() => () => clearTimeout(timerRef.current), []);

  const value = text || '';
  const handleCopy = () => {
    if (!navigator?.clipboard?.writeText) return;
    navigator.clipboard.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => { /* ignore */ });
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
        <div style={{
          flex: 1,
          fontSize: 'var(--eb-text-xs)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-secondary)',
          textTransform: 'uppercase',
          letterSpacing: '0.03em',
        }}>
          {title}
        </div>
        <button
          type="button"
          onClick={handleCopy}
          title="Copy to clipboard"
          aria-label="Copy to clipboard"
          style={{
            background: 'none',
            border: 'none',
            color: copied ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
            cursor: 'pointer',
            padding: 4,
            display: 'inline-flex',
            alignItems: 'center',
          }}
          onMouseEnter={e => { if (!copied) e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { if (!copied) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          {copied ? <Check size={12} /> : <Copy size={12} />}
        </button>
      </div>
      <pre style={{
        margin: 0,
        padding: 'var(--eb-space-3)',
        maxHeight: 420,
        overflow: 'auto',
        fontSize: 'var(--eb-text-xs)',
        fontFamily: 'var(--eb-font-mono)',
        color: 'var(--eb-text-primary)',
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-md)',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        tabSize: 2,
      }}>
        {value || <span style={{ color: 'var(--eb-text-muted)', fontStyle: 'italic' }}>(empty)</span>}
      </pre>
    </div>
  );
}

const emptyStyle = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  height: '100%',
  color: 'var(--eb-text-muted)',
  fontSize: 'var(--eb-text-xs)',
  padding: 'var(--eb-space-4)',
  textAlign: 'center',
};
