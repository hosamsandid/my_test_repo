import React, { useState, useRef, useCallback, useEffect } from 'react';
import { Link } from 'react-router';
import { Sparkles, X, Send, Loader2, Check, AlertTriangle, Boxes, RefreshCw } from 'lucide-react';
import { apiCall } from '../../hooks/useApi';
import { UNAUTHORIZED_EVENT } from '../../auth/AuthContext';
import { assistHeaders, notifyAssistError } from '../../context/assist-transport.js';
import PageHelpButton from '../../components/PageHelpButton';
import { FLOWS_HELP_SECTIONS } from './flows-help-sections';
import {
  STARTER_PROMPTS,
  toApiMessages,
  describeChange,
  lintColor,
  copilotErrorInfo,
  supersedePending,
  latestProposal,
  phaseLabel,
  consumeCopilotStream,
  toPersistedMessages,
  hydrateMessages,
  bundleSizeCharCount,
  bundleSizeLevel,
} from './flow-copilot-view';

// FlowCopilotPanel (#1069, spec #1047) — the docked chat rail of the Flow
// Editor. The user describes (or iterates on) a flow in free text; every turn
// of the stateless POST /api/process/copilot endpoint comes back as a reviewed
// PROPOSAL: rendered on the canvas via the parent's preview mechanism and as a
// card here (summary + change list + lint report + Apply/Discard). Nothing
// touches the draft until Apply runs the normal draft write.
//
// Deliberately a flex CHILD of the ProcessCanvas layout, not a SidePanel — the
// canvas is the live preview of what the chat produces, so it must stay
// visible and interactive while chatting (no modal backdrop).
//
// Chat history persists in the draft file (#1071): hydrated once from the
// draft's `copilot.messages` and written back as a compact projection after
// every turn / decision. Proposal bundles are NOT persisted — a reloaded
// proposal card shows as superseded and the user regenerates.
//
// Props:
//   mode            — 'draft' (chat) | 'team' (notice + Edit-as-draft bridge only)
//   bundle          — the current draft (draft mode; resent every turn — stateless
//                     server; also carries `copilot.messages` for hydration)
//   autoFocus       — focus the composer on mount (the "Describe flow…" entry)
//   onPreview(p)    — show { bundle, graph, ok } as the canvas proposal preview (null clears)
//   onApplyBundle   — async (bundle, persistedMessages) => void; the normal draft
//                     write (PUT …/drafts/:id) carrying the history along
//   onPersistHistory— (persistedMessages) => void; best-effort history-only write
//   onEditAsDraft   — team mode: run the existing editAsDraft() bridge
//   onClose         — close the panel (parent also clears the preview)
//   actionsRef      — ref the parent's proposal banner uses: { apply, discard, ok } | null
export default function FlowCopilotPanel({
  mode, bundle, autoFocus, onPreview, onApplyBundle, onPersistHistory, onEditAsDraft, onClose, actionsRef,
}) {
  const [messages, setMessages] = useState([]);
  const [composer, setComposer] = useState('');
  const [busy, setBusy] = useState(false);
  // Live phase of the running generation (#1070) — fed by the NDJSON stream.
  const [phase, setPhase] = useState(null);
  const [applying, setApplying] = useState(false);
  const [model, setModel] = useState(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const textareaRef = useRef(null);
  const scrollRef = useRef(null);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, busy]);

  useEffect(() => {
    if (autoFocus && textareaRef.current) textareaRef.current.focus();
  }, [autoFocus]);

  // Hydrate the chat once from the draft's persisted history (#1071). Guarded
  // by a ref: the bundle prop updates on every draft write (including our own
  // history persists) and must never re-hydrate over live state.
  const hydratedRef = useRef(false);
  useEffect(() => {
    if (mode !== 'draft' || hydratedRef.current || !bundle) return;
    hydratedRef.current = true;
    const initial = hydrateMessages(bundle.copilot, nextId);
    if (initial.length) {
      messagesRef.current = initial;
      setMessages(initial);
    }
  }, [mode, bundle]);

  const setEntry = useCallback((id, patch) => {
    setMessages(ms => ms.map(m => (m.id === id ? { ...m, ...patch } : m)));
  }, []);

  const send = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || busy || mode !== 'draft' || !bundle) return;
    const userEntry = { id: nextId(), role: 'user', content: trimmed };
    const history = [...messagesRef.current, userEntry];
    setMessages(history);
    setComposer('');
    setBusy(true);
    setPhase(null);
    try {
      // The endpoint streams NDJSON progress (#1070): request-shape/provider
      // errors come back as plain non-ok JSON before any streaming starts; an
      // OK response is a phase stream terminated by a result or error event.
      let res, body;
      try {
        res = await fetch('/api/process/copilot', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...assistHeaders() },
          body: JSON.stringify({ messages: toApiMessages(history), bundle }),
        });
        if (!res.ok) {
          if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
          const errBody = await res.json().catch(() => null);
          if (errBody && errBody.code) notifyAssistError(errBody.code);
          setMessages(ms => [...ms, {
            id: nextId(), role: 'error', retryText: trimmed,
            ...copilotErrorInfo(res.status, errBody && errBody.error),
          }]);
          return;
        }
        body = await consumeCopilotStream(res, setPhase);
      } catch (e) {
        // Network failure, a terminal error event, or a dropped connection
        // mid-stream — retryable error row, composer re-enabled.
        setMessages(ms => [...ms, {
          id: nextId(), role: 'error', retryText: trimmed,
          ...copilotErrorInfo(e.status, e.message),
        }]);
        return;
      }
      // Derive the canvas preview graph exactly like the import path does. A
      // strict-invalid best-effort bundle (ok:false, invalid-bundle) fails this
      // build — the card still shows the findings, just without a canvas render.
      let graph = null;
      if (body.bundle) {
        try { graph = await apiCall('POST', '/api/flows/graph', { processTemplate: body.bundle }); }
        catch { /* no preview for a strict-invalid bundle */ }
      }
      const entry = {
        id: nextId(), role: 'assistant', status: 'proposed',
        summary: body.summary || '', changes: Array.isArray(body.changes) ? body.changes : [],
        lints: Array.isArray(body.lints) ? body.lints : [], ok: !!body.ok,
        bundle: body.bundle, hasPreview: !!graph,
      };
      if (body.model) setModel(body.model);
      // A new proposal retires every older still-actionable card. Computed
      // synchronously off the send-time history (the composer is disabled
      // while busy, so nothing interleaves) and persisted to the draft (#1071).
      const next = [...supersedePending(history), entry];
      messagesRef.current = next;
      setMessages(next);
      if (onPersistHistory) onPersistHistory(toPersistedMessages(next));
      if (onPreview) onPreview(graph ? { bundle: body.bundle, graph, ok: !!body.ok } : null);
    } finally {
      setBusy(false);
      setPhase(null);
    }
  }, [busy, mode, bundle, onPreview, onPersistHistory]);

  const apply = useCallback(async (entry) => {
    if (!entry || !entry.ok || applying) return;
    setApplying(true);
    try {
      // The applied status rides along in the same draft write (#1071) — one
      // PUT persists bundle + history atomically.
      const next = messagesRef.current.map(m => (m.id === entry.id ? { ...m, status: 'applied', applyError: null } : m));
      await onApplyBundle(entry.bundle, toPersistedMessages(next));
      messagesRef.current = next;
      setMessages(next);
      if (onPreview) onPreview(null);
    } catch (e) {
      setEntry(entry.id, { applyError: e.message || 'Apply failed' });
    } finally {
      setApplying(false);
    }
  }, [applying, onApplyBundle, onPreview, setEntry]);

  const discard = useCallback((entry) => {
    if (!entry) return;
    const next = messagesRef.current.map(m => (m.id === entry.id ? { ...m, status: 'discarded' } : m));
    messagesRef.current = next;
    setMessages(next);
    if (onPersistHistory) onPersistHistory(toPersistedMessages(next));
    if (onPreview) onPreview(null);
    if (textareaRef.current) textareaRef.current.focus();
  }, [onPreview, onPersistHistory]);

  const retry = useCallback((entry) => {
    // Strip the error row AND the user turn that failed (send() re-appends it —
    // resending on top would duplicate the turn). Computed synchronously and
    // written through the ref so the immediate send() sees the cleaned history,
    // not the pre-setState snapshot.
    let base = messagesRef.current.filter(m => m.id !== entry.id);
    const last = base[base.length - 1];
    if (last && last.role === 'user' && last.content === entry.retryText) base = base.slice(0, -1);
    messagesRef.current = base;
    setMessages(base);
    send(entry.retryText);
  }, [send]);

  // Expose the latest actionable proposal to the parent's canvas banner, so
  // "Apply / Discard" there and in the card are the same handlers.
  const latest = latestProposal(messages);
  useEffect(() => {
    if (!actionsRef) return;
    actionsRef.current = latest
      ? { apply: () => apply(latest), discard: () => discard(latest), ok: latest.ok, busy: applying }
      : null;
    return () => { if (actionsRef) actionsRef.current = null; };
  }, [actionsRef, latest, apply, discard, applying]);

  const sendDisabled = busy || !composer.trim() || (mode === 'draft' && !bundle);

  return (
    <div style={{
      width: 420, minWidth: 320, maxWidth: '45%', flexShrink: 0, height: '100%', minHeight: 0,
      display: 'flex', flexDirection: 'column', marginLeft: 'var(--eb-space-3)',
      background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-lg)', overflow: 'hidden',
    }}>
      {/* Header: title + model badge + close */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: 'var(--eb-space-3)',
        borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0,
      }}>
        <Sparkles size={16} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
        <span style={{ flex: 1, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
          Flow Copilot
        </span>
        {/* #1984: the one Flows surface with a real header slot, so the "?" sits
            in the header rather than in a body lead. No help subject is
            published here — unlike every other panel on this page the Copilot
            is a flex CHILD of the canvas, not a SidePanel, so the help panel at
            z-index 50 already opens in front of it. */}
        <PageHelpButton
          label="How the Flow Copilot works"
          size={14}
          section={FLOWS_HELP_SECTIONS.copilot}
          style={{ padding: 0, flexShrink: 0 }}
        />
        {model && (
          <span title="Model used for generation" style={{
            fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
            border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-sm)',
            padding: '1px 6px', maxWidth: 140, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{model}</span>
        )}
        <button onClick={onClose} aria-label="Close Copilot" style={{
          background: 'none', border: 'none', color: 'var(--eb-text-secondary)', cursor: 'pointer',
          display: 'flex', padding: 2,
        }}><X size={16} /></button>
      </div>

      {mode === 'team' ? (
        /* Live team: chat editing always goes through a draft — no direct
           mutation path exists (live ops write ports only, by design). */
        <div style={{ padding: 'var(--eb-space-4)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
          <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
            Copilot edits a <strong>draft copy</strong> of this team — a live team is never changed
            directly from chat. Open the draft to start; your changes flow back to the team through
            the usual <em>Materialize… (extend)</em> step.
          </p>
          <button onClick={onEditAsDraft} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', padding: '8px 14px', fontFamily: 'inherit',
            fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}><Boxes size={14} /> Edit as draft</button>
        </div>
      ) : (
        <>
          {/* Message list */}
          <div ref={scrollRef} style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 'var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
            {messages.length === 0 && !busy && (
              <EmptyState onPick={(p) => { setComposer(p); if (textareaRef.current) textareaRef.current.focus(); }} />
            )}
            {messages.map(m => (
              m.role === 'user' ? <UserBubble key={m.id} entry={m} />
                : m.role === 'assistant' ? (
                  <ProposalCard
                    key={m.id} entry={m}
                    actionable={latest ? latest.id === m.id : false}
                    applying={applying}
                    onApply={() => apply(m)}
                    onDiscard={() => discard(m)}
                  />
                ) : <ErrorRow key={m.id} entry={m} busy={busy} onRetry={() => retry(m)} />
            ))}
            {busy && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                <Loader2 size={14} style={{ animation: 'eb-copilot-spin 1s linear infinite' }} />
                {/* Live phase from the NDJSON stream (#1070). */}
                {phaseLabel(phase)}
              </div>
            )}
          </div>

          {/* Composer — free text only, Cmd/Ctrl+Enter sends. */}
          <div style={{ borderTop: '1px solid var(--eb-border-default)', padding: 'var(--eb-space-3)', flexShrink: 0 }}>
            <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'flex-end' }}>
              <textarea
                ref={textareaRef}
                value={composer}
                disabled={busy}
                onChange={e => {
                  setComposer(e.target.value);
                  e.target.style.height = 'auto';
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 160)}px`;
                }}
                onKeyDown={e => {
                  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(composer); }
                }}
                rows={2}
                placeholder={messages.length === 0
                  ? 'Describe the flow — roles, hand-offs, human gates…'
                  : 'Refine the flow — e.g. “add a security reviewer”…'}
                style={{
                  flex: 1, resize: 'none', maxHeight: 160, background: 'var(--eb-bg-app)',
                  color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)',
                  fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', lineHeight: 1.4,
                  outline: 'none', opacity: busy ? 0.6 : 1, boxSizing: 'border-box',
                }}
              />
              <button
                onClick={() => send(composer)}
                disabled={sendDisabled}
                title="Send (⌘/Ctrl+Enter)"
                aria-label="Send"
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 34, height: 34, flexShrink: 0,
                  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                  border: 'none', borderRadius: 'var(--eb-radius-md)',
                  cursor: sendDisabled ? 'not-allowed' : 'pointer', opacity: sendDisabled ? 0.5 : 1,
                }}
              >
                {busy ? <Loader2 size={15} style={{ animation: 'eb-copilot-spin 1s linear infinite' }} /> : <Send size={15} />}
              </button>
            </div>
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eb-space-2)' }}>
              <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                Every answer is a proposal — nothing changes the draft until you apply it.
              </span>
              {bundle && <BundleSizeHint bundle={bundle} />}
            </div>
          </div>
        </>
      )}
      <style>{'@keyframes eb-copilot-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
    </div>
  );
}

function EmptyState({ onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
      <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.5 }}>
        Describe the flow you want in plain language — roles, hand-offs, human approval gates.
        The Copilot proposes a complete flow on the canvas; you review and apply it, then keep
        iterating with follow-up instructions.
      </p>
      {STARTER_PROMPTS.map((p, i) => (
        <button key={i} onClick={() => onPick(p)} style={{
          textAlign: 'left', background: 'var(--eb-bg-app)', color: 'var(--eb-text-secondary)',
          border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
          padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-xs)',
          lineHeight: 1.4, cursor: 'pointer',
        }}>{p}</button>
      ))}
    </div>
  );
}

function UserBubble({ entry }) {
  return (
    <div style={{ alignSelf: 'flex-end', maxWidth: '90%' }}>
      <div style={{
        background: 'color-mix(in srgb, var(--eb-accent-primary) 12%, var(--eb-bg-surface))',
        border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', fontSize: 'var(--eb-text-sm)',
        color: 'var(--eb-text-primary)', whiteSpace: 'pre-wrap', lineHeight: 1.45,
      }}>{entry.content}</div>
    </div>
  );
}

// The per-turn proposal card: summary + change list + lint report +
// Apply/Discard. Only the LATEST proposed card is actionable; applied /
// discarded / superseded cards collapse to a status line.
function ProposalCard({ entry, actionable, applying, onApply, onDiscard }) {
  const errors = entry.lints.filter(l => l.severity === 'error');
  const canApply = actionable && entry.ok && entry.status === 'proposed';
  return (
    <div style={{
      alignSelf: 'stretch', background: 'var(--eb-bg-app)',
      border: `1px solid ${entry.ok || entry.status !== 'proposed' ? 'var(--eb-border-default)' : 'var(--eb-status-error)'}`,
      borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-3)',
      display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)',
    }}>
      {entry.summary && (
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.5 }}>{entry.summary}</div>
      )}

      {entry.changes.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 'var(--eb-space-4)', display: 'flex', flexDirection: 'column', gap: 2 }}>
          {entry.changes.map((c, i) => (
            <li key={i} style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.4 }}>
              {describeChange(c)}
            </li>
          ))}
        </ul>
      )}

      {entry.lints.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {entry.lints.map((l, i) => (
            <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'baseline', fontSize: 'var(--eb-text-xs)', lineHeight: 1.4 }}>
              <span style={{
                color: lintColor(l.severity), fontWeight: 'var(--eb-font-medium)',
                textTransform: 'uppercase', flexShrink: 0,
              }}>{l.code}</span>
              <span style={{ color: 'var(--eb-text-secondary)' }}>{String(l.message || '').replace(/`/g, '')}</span>
            </div>
          ))}
        </div>
      )}

      {!entry.hasPreview && entry.status === 'proposed' && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          No canvas preview — the bundle did not pass strict validation.
        </div>
      )}

      {entry.applyError && (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>Apply failed: {entry.applyError}</div>
      )}

      {entry.status === 'proposed' ? (
        <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
          <button
            onClick={onApply}
            disabled={!canApply || applying}
            title={!entry.ok ? 'Cannot apply — the proposal still has error-level findings. Steer with another message.' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
              borderRadius: 'var(--eb-radius-md)', padding: '5px 12px', fontFamily: 'inherit',
              fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
              cursor: (!canApply || applying) ? 'not-allowed' : 'pointer', opacity: (!canApply || applying) ? 0.5 : 1,
            }}
          >
            {applying && actionable
              ? <Loader2 size={13} style={{ animation: 'eb-copilot-spin 1s linear infinite' }} />
              : <Check size={13} />}
            Apply to draft
          </button>
          <button
            onClick={onDiscard}
            disabled={!actionable || applying}
            style={{
              background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)', padding: '5px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
              cursor: (!actionable || applying) ? 'not-allowed' : 'pointer', opacity: (!actionable || applying) ? 0.5 : 1,
            }}
          >Discard</button>
          {!entry.ok && (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
              <AlertTriangle size={12} /> {errors.length} error{errors.length === 1 ? '' : 's'}
            </span>
          )}
        </div>
      ) : (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center', gap: 4 }}>
          {entry.status === 'applied' && <><Check size={12} style={{ color: 'var(--eb-status-success, #16a34a)' }} /> Applied ✓</>}
          {entry.status === 'discarded' && 'Discarded'}
          {entry.status === 'superseded' && 'Superseded by a newer proposal'}
        </div>
      )}
    </div>
  );
}

function ErrorRow({ entry, busy, onRetry }) {
  // AC2 (#1404): bundle-too-large — non-dismissable warning notice, no retry.
  if (entry.kind === 'bundle-too-large') {
    return (
      <div style={{
        border: '1px solid var(--eb-status-warning)', borderRadius: 'var(--eb-radius-md)',
        padding: 'var(--eb-space-2) var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 6,
      }}>
        <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-primary)', lineHeight: 1.5 }}>
          Your current bundle is too large for the Copilot to process in one go. Make small, targeted
          requests — describe one role at a time rather than pasting the full bundle JSON.
        </div>
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          Use the <strong>Edit&nbsp;as&nbsp;draft</strong> workflow and describe incremental changes, one step at a time.
        </div>
      </div>
    );
  }
  // AC3 (#1404): timeout — show specific guidance; retry is still available.
  const messageText = entry.kind === 'timeout'
    ? 'The LLM call timed out. If your bundle is large, try breaking your request into smaller steps.'
    : entry.message;
  return (
    <div style={{
      border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)', lineHeight: 1.4 }}>{messageText}</div>
      {entry.kind === 'provider' ? (
        <div style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          The Copilot needs a configured LLM —{' '}
          <Link to="/models" style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none' }}>
            add a Model Provider
          </Link>{' '}and try again.
        </div>
      ) : (
        <button onClick={onRetry} disabled={busy} style={{
          alignSelf: 'flex-start', display: 'inline-flex', alignItems: 'center', gap: 6,
          background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', padding: '4px 10px', fontFamily: 'inherit',
          fontSize: 'var(--eb-text-xs)', cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1,
        }}><RefreshCw size={12} /> Retry</button>
      )}
    </div>
  );
}

// AC4 (#1404): reactive bundle size counter in the composer footer.
// Amber at BUNDLE_AMBER_THRESHOLD (160k chars = 80% of server guard 200k).
function BundleSizeHint({ bundle }) {
  const charCount = bundleSizeCharCount(bundle);
  const level = bundleSizeLevel(charCount);
  const color = level === 'red' ? 'var(--eb-status-error)'
    : level === 'amber' ? 'var(--eb-status-warning)'
    : 'var(--eb-text-muted)';
  const hint = level === 'red' ? ' — too large' : level === 'amber' ? ' — may time out' : null;
  return (
    <span
      title={`Bundle JSON is ${charCount.toLocaleString()} characters (server limit: 200 000)`}
      style={{ fontSize: 'var(--eb-text-xs)', color, whiteSpace: 'nowrap', flexShrink: 0 }}
    >
      {(charCount / 1000).toFixed(1)}k chars{hint}
    </span>
  );
}
