import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Info, Copy, Check, Server, GitBranch } from 'lucide-react';
import {
  formatContextWindow, sessionPriceLabel, tokenBreakdownRows, repoBranchRows,
} from './session-info.js';

// The Agent-Chat header "info" popover (#1718). A small (i) icon opens a
// portaled, viewport-clamped card holding the detail that used to crowd the
// header line: the full (copyable) session id, the single total price, the
// four-class token breakdown, and the selected model's context window (+ its
// max-output tokens when discovery provided one). Every value is omitted when
// unknown — never a guess or a zero placeholder (AC8). Portaled into
// document.body with position:fixed so a narrow chat column never clips it
// (the #1280 layering fix, mirrored from ModelSelectorPopover).

const POPOVER_WIDTH = 280;

function Row({ label, children }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'baseline', gap: 'var(--eb-space-2)',
      padding: '2px var(--eb-space-2)', fontSize: 'var(--eb-text-xs)',
    }}>
      <span style={{ color: 'var(--eb-text-muted)', flexShrink: 0, minWidth: 78 }}>{label}</span>
      <span style={{
        flex: 1, textAlign: 'right', color: 'var(--eb-text-primary)',
        fontFamily: 'var(--eb-font-mono)', overflowWrap: 'anywhere',
      }}>
        {children}
      </span>
    </div>
  );
}

function SectionTitle({ children }) {
  return (
    <div style={{
      fontSize: 'var(--eb-text-xs)', fontWeight: 600, color: 'var(--eb-text-secondary)',
      padding: 'var(--eb-space-2) var(--eb-space-2) 2px',
    }}>
      {children}
    </div>
  );
}

export default function SessionInfoPopover({
  sessionId,
  sessionUpdatedAt,
  sessionCost,               // { usd, breakdown } | null
  contextWindowTokens,       // number | null — selected model's real window
  maxOutputTokens,           // number | null — only when discovery provided it
  environmentName,           // string | null — environment name (#1807)
  gitInfo,                   // array | null — repo/branch data (#1807)
}) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const rootRef = useRef(null);
  const triggerRef = useRef(null);
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);

  const place = useCallback(() => {
    const r = triggerRef.current?.getBoundingClientRect();
    if (!r) return;
    const half = POPOVER_WIDTH / 2;
    const left = Math.max(8, Math.min(r.left + r.width / 2 - half, window.innerWidth - POPOVER_WIDTH - 8));
    setPos({ top: r.bottom + 4, left });
  }, []);

  useEffect(() => {
    if (!open) { setPos(null); setCopied(false); return undefined; }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open, place]);

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => {
      const inRoot = rootRef.current && rootRef.current.contains(e.target);
      const inPop = popRef.current && popRef.current.contains(e.target);
      if (!inRoot && !inPop) setOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const copySessionId = useCallback(async () => {
    if (!sessionId) return;
    try {
      await navigator.clipboard.writeText(sessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable — no-op */
    }
  }, [sessionId]);

  const priceLabel = sessionPriceLabel(sessionCost?.usd);
  const breakdown = tokenBreakdownRows(sessionCost?.breakdown);
  const windowLabel = formatContextWindow(contextWindowTokens);
  const maxOut = formatContextWindow(maxOutputTokens);
  const repoRows = repoBranchRows(gitInfo);
  const hasBody = environmentName || repoRows.length > 0 || sessionId || priceLabel || breakdown.length > 0 || windowLabel || maxOut;

  return (
    <div ref={rootRef} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen(o => !o)}
        title="About this chat"
        aria-label="About this chat"
        aria-haspopup="dialog"
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          background: 'none', border: 'none', cursor: 'pointer', padding: 2,
          color: 'var(--eb-text-muted)', borderRadius: 'var(--eb-radius-sm)',
        }}
        onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
        onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
      >
        <Info size={13} />
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          role="dialog"
          aria-label="About this chat"
          style={{
            position: 'fixed', top: pos.top, left: pos.left, zIndex: 1000,
            width: POPOVER_WIDTH, boxSizing: 'border-box',
            maxHeight: '70vh', overflowY: 'auto',
            background: 'var(--eb-bg-elevated)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            boxShadow: 'var(--eb-shadow-lg)',
            padding: 'var(--eb-space-2)',
          }}
        >
          {!hasBody && (
            <div style={{
              fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              padding: 'var(--eb-space-2)',
            }}>
              No session details yet.
            </div>
          )}

          {(environmentName || repoRows.length > 0) && (
            <>
              <SectionTitle>About</SectionTitle>
              {environmentName && (
                <div style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px var(--eb-space-2)',
                  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)',
                }}>
                  <Server size={11} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
                  <span
                    title={environmentName}
                    style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                  >
                    {environmentName}
                  </span>
                </div>
              )}
              {repoRows.map(r => (
                <div key={r.repoPath} style={{
                  display: 'flex', alignItems: 'center', gap: 6,
                  padding: '2px var(--eb-space-2)',
                  fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-primary)',
                }}>
                  <GitBranch size={11} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
                  <span
                    title={repoRows.length > 1 ? `${r.repoPath}: ${r.branch}` : r.branch}
                    style={{
                      fontFamily: 'var(--eb-font-mono)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                    }}
                  >
                    {repoRows.length > 1 && `${r.repoPath}: `}{r.branch}
                    {r.isDirty && (
                      <span
                        title={`${r.changesCount} uncommitted change${r.changesCount !== 1 ? 's' : ''}`}
                        style={{
                          display: 'inline-block', width: 6, height: 6,
                          borderRadius: '50%', background: 'var(--eb-color-warning, #f59e0b)',
                          marginLeft: 4, verticalAlign: 'middle', flexShrink: 0,
                        }}
                      />
                    )}
                  </span>
                </div>
              ))}
            </>
          )}

          {sessionId && (
            <>
              <SectionTitle>Session</SectionTitle>
              <div style={{
                display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
                padding: '2px var(--eb-space-2)',
              }}>
                <span
                  title={sessionUpdatedAt ? `Updated ${sessionUpdatedAt}` : undefined}
                  style={{
                    flex: 1, fontFamily: 'var(--eb-font-mono)', fontSize: 'var(--eb-text-xs)',
                    color: 'var(--eb-text-primary)', overflowWrap: 'anywhere',
                  }}
                >
                  {sessionId}
                </span>
                <button
                  type="button"
                  onClick={copySessionId}
                  title="Copy session id"
                  aria-label="Copy session id"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 3, flexShrink: 0,
                    background: 'none', border: '1px solid var(--eb-border-default)',
                    borderRadius: 'var(--eb-radius-sm)', cursor: 'pointer',
                    color: copied ? 'var(--eb-status-success)' : 'var(--eb-text-muted)',
                    fontSize: 'var(--eb-text-xs)', padding: '1px 6px',
                  }}
                >
                  {copied ? <Check size={11} /> : <Copy size={11} />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          )}

          {(priceLabel || breakdown.length > 0) && (
            <>
              <SectionTitle>Usage</SectionTitle>
              {priceLabel && <Row label="Total">{priceLabel}</Row>}
              {breakdown.map(r => (
                <Row key={r.key} label={r.label}>{r.value}</Row>
              ))}
            </>
          )}

          {(windowLabel || maxOut) && (
            <>
              <SectionTitle>Model</SectionTitle>
              {windowLabel && <Row label="Context">{windowLabel}</Row>}
              {maxOut && <Row label="Max output">{maxOut}</Row>}
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
