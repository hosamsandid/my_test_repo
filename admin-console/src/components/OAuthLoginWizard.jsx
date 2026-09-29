import React, { useState, useEffect, useRef } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { apiCall } from '../hooks/useApi';

/* ────────────── shared styles (self-contained) ────────────── */

const buttonPrimary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-accent-primary)',
  color: 'var(--eb-text-inverted)',
  border: 'none',
  borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)',
  fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer',
  fontFamily: 'inherit',
};

const buttonSecondary = {
  padding: 'var(--eb-space-2) var(--eb-space-4)',
  background: 'var(--eb-bg-elevated)',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-sm)',
  fontFamily: 'inherit',
};

const buttonGhost = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 'var(--eb-space-1)',
  padding: 'var(--eb-space-1) var(--eb-space-2)',
  background: 'transparent',
  border: '1px solid var(--eb-border-default)',
  borderRadius: 'var(--eb-radius-md)',
  color: 'var(--eb-text-secondary)',
  cursor: 'pointer',
  fontSize: 'var(--eb-text-xs)',
  fontFamily: 'inherit',
};

/* ────────────── subscription OAuth login wizard ──────────────
 *
 * Single source of truth for the `claude setup-token` login flow, used by the
 * Model Providers page (ModelRegistry). Kept as its own component so any
 * further surface that offers the login reuses it rather than drifting.
 *
 * Walks the operator through `claude setup-token`, executed by the
 * orchestrator: start → open the authorize URL in the browser → paste the
 * confirmation code → the orchestrator captures the long-lived token. The
 * token itself never reaches the browser — on success we only hand the
 * flowId back to the form, and the server claims the token while saving.
 */
export default function OAuthLoginWizard({ onToken, onClose }) {
  const [flow, setFlow] = useState(null);   // { flowId, status, authUrl, error }
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [copied, setCopied] = useState(false);
  const doneNotified = useRef(false);

  function absorb(view) {
    setFlow(view);
    // Mirror the server's error verbatim (and clear it once the server does —
    // e.g. after a successful code re-submission).
    setErr(view?.error || null);
    if (view?.status === 'done' && !doneNotified.current) {
      doneNotified.current = true;
      onToken(view.flowId);
    }
  }

  // Kick off the flow on mount.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setBusy(true);
      try {
        const r = await apiCall('POST', '/api/llm-auth/flows');
        if (!cancelled) absorb(r);
      } catch (e) {
        if (!cancelled) setErr(e.message);
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Poll while the orchestrator is working (waiting for the URL, or
  // exchanging the pasted code for the token).
  useEffect(() => {
    if (!flow?.flowId) return;
    const polling = flow.status === 'starting' || flow.status === 'exchanging';
    if (!polling) return;
    const t = setInterval(async () => {
      try {
        const r = await apiCall('GET', `/api/llm-auth/flows/${flow.flowId}`);
        absorb(r);
      } catch (e) {
        setErr(e.message);
      }
    }, 1500);
    return () => clearInterval(t);
  }, [flow?.flowId, flow?.status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function sendCode() {
    if (!code.trim()) return;
    setBusy(true); setErr(null);
    try {
      const r = await apiCall('POST', `/api/llm-auth/flows/${flow.flowId}/code`, { code: code.trim() });
      absorb(r);
    } catch (e) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  }

  async function cancel() {
    if (flow?.flowId && flow.status !== 'done') {
      try { await apiCall('DELETE', `/api/llm-auth/flows/${flow.flowId}`); } catch { /* best effort */ }
    }
    onClose();
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(flow.authUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable — the link is still clickable */ }
  }

  const status = flow?.status;
  // An error while the flow still awaits a code (e.g. "OAuth error: Invalid
  // code") is recoverable — keep the paste form visible instead of failing.
  const failed = ['error', 'expired', 'cancelled'].includes(status)
    || (!!err && !['done', 'awaiting-code'].includes(status));

  return (
    <div style={{
      padding: 'var(--eb-space-3)',
      background: 'var(--eb-bg-elevated)',
      border: '1px solid var(--eb-accent-primary)',
      borderRadius: 'var(--eb-radius-md)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)',
      fontSize: 'var(--eb-text-sm)',
    }}>
      {(!flow || status === 'starting') && !failed && (
        <div>Starting the login flow (<code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code>)…</div>
      )}

      {status === 'awaiting-code' && flow.authUrl && (
        <>
          {err && (
            <div role="alert" style={{ color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>
              {err}
            </div>
          )}
          <div style={{ fontWeight: 'var(--eb-font-medium)' }}>1. Open this link, sign in with your Claude subscription and approve:</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
            <a
              href={flow.authUrl}
              target="_blank"
              rel="noreferrer"
              style={{
                fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
                wordBreak: 'break-all', color: 'var(--eb-accent-primary)',
                display: 'inline-flex', alignItems: 'flex-start', gap: 4,
              }}
            >
              <ExternalLink size={12} style={{ flexShrink: 0, marginTop: 2 }} />
              {flow.authUrl}
            </a>
            <button type="button" onClick={copyUrl} style={{ ...buttonGhost, flexShrink: 0 }}>
              <Copy size={12} /> {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <div style={{ fontWeight: 'var(--eb-font-medium)' }}>2. Paste the confirmation code shown after approval (copy it completely, including any <code style={{ fontFamily: 'var(--eb-font-mono)' }}>#…</code> suffix):</div>
          <div style={{ display: 'flex', gap: 'var(--eb-space-2)' }}>
            <input
              value={code}
              onChange={e => setCode(e.target.value)}
              placeholder="Paste code…"
              style={{
                flex: 1,
                padding: 'var(--eb-space-2) var(--eb-space-3)',
                background: 'var(--eb-bg-surface)',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: 'var(--eb-text-primary)',
                fontFamily: 'var(--eb-font-mono)',
                fontSize: 'var(--eb-text-xs)',
                outline: 'none',
              }}
            />
            <button
              type="button"
              onClick={sendCode}
              disabled={busy || !code.trim()}
              style={{ ...buttonPrimary, opacity: busy || !code.trim() ? 0.6 : 1 }}
            >
              {busy ? 'Submitting…' : 'Submit code'}
            </button>
          </div>
        </>
      )}

      {status === 'exchanging' && (
        <div>Exchanging the code for a token…</div>
      )}

      {status === 'done' && (
        <div style={{ color: 'var(--eb-status-success)', display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <Check size={14} /> Login successful — the token will be stored when you save this provider.
        </div>
      )}

      {failed && (
        <div role="alert" style={{ color: 'var(--eb-status-error)' }}>
          {err || flow?.error || 'The login flow failed.'} You can retry, or paste a token generated with <code style={{ fontFamily: 'var(--eb-font-mono)' }}>claude setup-token</code> manually.
        </div>
      )}

      {status !== 'done' && (
        <button type="button" onClick={cancel} style={{ ...buttonSecondary, alignSelf: 'flex-start' }}>
          Cancel login
        </button>
      )}
    </div>
  );
}
