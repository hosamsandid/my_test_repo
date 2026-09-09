import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import { Link } from 'react-router';
import { Sparkles, X, Send, Loader2, Check, AlertTriangle, Boxes, RefreshCw, Square } from 'lucide-react';
import PageHelpButton from '../../components/PageHelpButton';
import { useFlowCopilot } from '../../context/FlowCopilotContext.jsx';
import { FLOWS_HELP_SECTIONS } from './flows-help-sections';
import {
  STARTER_PROMPTS,
  toApiMessages,
  describeChange,
  lintColor,
  phaseLabel,
  toPersistedMessages,
  hydrateMessages,
  bundleSizeCharCount,
  bundleSizeLevel,
} from './flow-copilot-view';
import { decideCopilotAction, applyFailureNotice } from './flow-copilot-turn';

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
// The RUNNING turn does not live here any more (#2087). It is owned by the
// app-level FlowCopilotProvider, above the router, so it survives this panel's
// unmount — closing the panel, navigating away from /flows, and the `key={proc}`
// remount a flow switch causes. What this component still owns is the DURABLE
// history (hydrated from the draft, per #1071) and the composer; the live turn,
// its phase and its finished-but-unapplied proposal come from the provider,
// scoped to this panel's `scope`.
//
// Props:
//   mode            — 'draft' (chat) | 'team' (notice + Edit-as-draft bridge only)
//   scope           — the flow this panel is bound to (`draft:<id>` or a team id).
//                     A turn and its proposal are bound to it, so a proposal is
//                     never offered against another bundle (AC5).
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
  mode, scope, bundle, autoFocus, onPreview, onApplyBundle, onPersistHistory, onEditAsDraft, onClose, actionsRef,
}) {
  const copilot = useFlowCopilot();
  const view = copilot ? copilot.viewFor(scope) : null;
  const running = !!(view && view.running);
  const pending = view ? view.pending : null;
  const failure = view ? view.failure : null;
  const phase = view ? view.phase : null;

  const [messages, setMessages] = useState([]);
  const [composer, setComposer] = useState('');
  const [applying, setApplying] = useState(false);
  const [applyError, setApplyError] = useState(null);
  const [model, setModel] = useState(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const idRef = useRef(0);
  const nextId = () => ++idRef.current;
  const textareaRef = useRef(null);
  const scrollRef = useRef(null);

  // Publish which flow this panel is showing, so the global indicator can hide
  // while the user is looking at the live phase here (AC13). Retracted on
  // unmount — the `useHelpSubject` shape.
  const registerPanel = copilot ? copilot.registerPanel : null;
  useEffect(() => {
    if (!registerPanel) return undefined;
    return registerPanel(scope);
  }, [registerPanel, scope]);

  // Keep the newest message in view.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, running, pending, failure]);

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

  // The transient rows of the CURRENT turn, rendered after the durable history.
  // They live in the provider, so they are rebuilt identically on every remount
  // — which is what makes AC1–AC3 hold without persisting anything extra.
  const turnRows = useCallback((p) => {
    const rows = [];
    if (p.userText) rows.push({ id: 'turn-user', role: 'user', content: p.userText });
    rows.push({
      id: `turn-proposal-${p.id}`, role: 'assistant', status: 'proposed',
      summary: p.summary, changes: p.changes, lints: p.lints, ok: p.ok,
      bundle: p.bundle, hasPreview: !!p.graph,
    });
    return rows;
  }, []);

  const rendered = useMemo(() => {
    const rows = [...messages];
    if (running) {
      if (view.userText) rows.push({ id: 'turn-user', role: 'user', content: view.userText });
    } else if (pending) {
      rows.push(...turnRows(pending).map(r => (
        r.role === 'assistant' ? { ...r, applyError } : r
      )));
    } else if (failure) {
      if (failure.retryText) rows.push({ id: 'turn-user', role: 'user', content: failure.retryText });
      rows.push({
        id: 'turn-error', role: 'error', retryText: failure.retryText,
        kind: failure.kind, message: failure.message,
      });
    }
    return rows;
  }, [messages, running, pending, failure, view, turnRows, applyError]);

  // Model badge in the header — carried by the finished turn (AC15).
  useEffect(() => { if (pending && pending.model) setModel(pending.model); }, [pending]);

  // Canvas preview (#1069) follows this scope's pending proposal, so reopening
  // the panel restores the read-only preview + banner rather than showing the
  // draft underneath (AC2/AC6). Clearing on unmount is the parent's job — it
  // owns the preview state and drops it in onClose.
  useEffect(() => {
    if (!onPreview) return;
    onPreview(pending && pending.graph ? { bundle: pending.bundle, graph: pending.graph, ok: !!pending.ok } : null);
  }, [pending, onPreview]);

  // Persist the finished turn's history exactly when it used to be persisted
  // (AC7): once, as soon as the turn produces a proposal. `toPersistedMessages`
  // maps a still-`proposed` card to `superseded`, which is #1071's rule for a
  // proposal whose bundle is deliberately not stored. Keyed on the turn id so a
  // remount does not re-write it, and the rows are NOT committed into
  // `messages` — the provider is still the one rendering them, and committing
  // would duplicate the card.
  const persistedTurnRef = useRef(null);
  useEffect(() => {
    if (!pending || !onPersistHistory || persistedTurnRef.current === pending.id) return;
    persistedTurnRef.current = pending.id;
    onPersistHistory(toPersistedMessages([...messagesRef.current, ...turnRows(pending)]));
  }, [pending, onPersistHistory, turnRows]);

  const send = useCallback((text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || mode !== 'draft' || !bundle || !copilot) return;
    // A running turn owns the tab (AC4) — the composer's own decision already
    // refuses this, and startTurn refuses it again server-of-last-resort.
    const history = [...messagesRef.current, { role: 'user', content: trimmed }];
    setComposer('');
    setApplyError(null);
    copilot.startTurn({
      scope,
      flowName: (bundle && bundle.name) || '',
      userText: trimmed,
      apiMessages: toApiMessages(history),
      bundle,
    });
  }, [mode, bundle, copilot, scope]);

  /** Stop the running turn (AC8) — inert once pressed, the `stopBusy` rule. */
  const stop = useCallback(() => { if (copilot) copilot.stopTurn(); }, [copilot]);

  const apply = useCallback(async () => {
    if (!pending || !pending.ok || applying) return;
    setApplying(true);
    setApplyError(null);
    try {
      // Commit the turn into the durable history with `applied`, then write it
      // with the bundle in ONE PUT (#1071) — the same path as before.
      const committed = turnRows(pending).map(r => (
        { ...r, id: nextId(), ...(r.role === 'assistant' ? { status: 'applied' } : {}) }
      ));
      const next = [...messagesRef.current, ...committed];
      await onApplyBundle(pending.bundle, toPersistedMessages(next));
      messagesRef.current = next;
      setMessages(next);
      copilot.resolvePending(pending.id);
      if (onPreview) onPreview(null);
    } catch (e) {
      // A draft deleted while its turn ran is named as such rather than read
      // like a transient write failure (edge case).
      setApplyError(applyFailureNotice(e));
    } finally {
      setApplying(false);
    }
  }, [pending, applying, onApplyBundle, onPreview, copilot, scope, turnRows]);

  const discard = useCallback(() => {
    if (!pending) return;
    const committed = turnRows(pending).map(r => (
      { ...r, id: nextId(), ...(r.role === 'assistant' ? { status: 'discarded', bundle: null } : {}) }
    ));
    const next = [...messagesRef.current, ...committed];
    messagesRef.current = next;
    setMessages(next);
    if (onPersistHistory) onPersistHistory(toPersistedMessages(next));
    copilot.resolvePending(pending.id);
    setApplyError(null);
    if (onPreview) onPreview(null);
    if (textareaRef.current) textareaRef.current.focus();
  }, [pending, onPreview, onPersistHistory, copilot, scope, turnRows]);

  const retry = useCallback((entry) => {
    // The failed user turn was never committed to the durable history (it lives
    // on the failure record), so retrying only clears the error and resends —
    // no stripping needed, unlike the pre-#2087 path.
    if (copilot) copilot.clearFailure(scope);
    send(entry.retryText);
  }, [copilot, scope, send]);

  // Expose the pending proposal to the parent's canvas banner, so
  // "Apply / Discard" there and in the card are the same handlers.
  useEffect(() => {
    if (!actionsRef) return undefined;
    actionsRef.current = pending
      ? { apply, discard, ok: pending.ok, busy: applying }
      : null;
    return () => { if (actionsRef) actionsRef.current = null; };
  }, [actionsRef, pending, apply, discard, applying]);

  // Send vs Stop, from the one pure decision (mirrors composer-action.js).
  const action = decideCopilotAction({
    scope,
    turnScope: view ? view.turnScope : null,
    flowName: view ? view.turnFlowName : '',
    stopping: view ? view.stopping : false,
    hasText: !!composer.trim(),
    canSend: mode === 'draft' && !!bundle,
  });
  const busy = running;

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
            the usual <em>Create team…</em> step, which extends the team it came from.
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
            {rendered.length === 0 && !busy && (
              <EmptyState onPick={(p) => { setComposer(p); if (textareaRef.current) textareaRef.current.focus(); }} />
            )}
            {rendered.map(m => (
              m.role === 'user' ? <UserBubble key={m.id} entry={m} />
                : m.role === 'assistant' ? (
                  <ProposalCard
                    key={m.id} entry={m}
                    // Only the provider-held pending proposal is actionable —
                    // every committed card is a status line (#1069's rule,
                    // now with one obvious owner).
                    actionable={m.status === 'proposed'}
                    applying={applying}
                    onApply={apply}
                    onDiscard={discard}
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
                placeholder={rendered.length === 0
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
              {/* One primary action, Send or Stop (#2087, D2) — the shape
                  Agent Chat's unified Stop (#1427) established. The send button
                  used to become a disabled spinner with no stop affordance at
                  all, so a turn could only be abandoned, never cancelled. */}
              <button
                onClick={() => (action.mode === 'stop' ? stop() : send(composer))}
                disabled={!action.enabled}
                title={action.mode === 'stop'
                  ? 'Stop this Copilot turn'
                  : (action.refusal || 'Send (⌘/Ctrl+Enter)')}
                aria-label={action.mode === 'stop' ? 'Stop' : 'Send'}
                style={{
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  width: 34, height: 34, flexShrink: 0,
                  background: action.mode === 'stop' ? 'var(--eb-status-error)' : 'var(--eb-accent-primary)',
                  color: 'var(--eb-text-inverted)',
                  border: 'none', borderRadius: 'var(--eb-radius-md)',
                  cursor: action.enabled ? 'pointer' : 'not-allowed', opacity: action.enabled ? 1 : 0.5,
                }}
              >
                {action.mode === 'stop' ? <Square size={14} /> : <Send size={15} />}
              </button>
            </div>
            <div style={{ marginTop: 4, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eb-space-2)' }}>
              <span style={{
                fontSize: 'var(--eb-text-xs)',
                color: action.refusal ? 'var(--eb-status-warning)' : 'var(--eb-text-muted)',
              }}>
                {/* AC4: a refused second turn states the reason rather than
                    silently queueing or running in parallel. */}
                {action.refusal || 'Every answer is a proposal — nothing changes the draft until you apply it.'}
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
  // AC3 (#1404) / AC1 (#2131): a timeout carries a plain-language headline plus
  // the two actionable hints, and keeps the raw transport string behind an
  // expander — available for debugging, never the thing the user reads first.
  const hints = Array.isArray(entry.hints) ? entry.hints : [];
  return (
    <div style={{
      border: '1px solid var(--eb-status-error)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-2) var(--eb-space-3)', display: 'flex', flexDirection: 'column', gap: 6,
    }}>
      <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-status-error)', lineHeight: 1.4 }}>{entry.message}</div>
      {hints.length > 0 && (
        <ul style={{
          margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 4,
          fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)', lineHeight: 1.5,
        }}>
          {hints.map((h) => <li key={h}>{h}</li>)}
        </ul>
      )}
      {entry.detail && (
        <details style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
          <summary style={{ cursor: 'pointer' }}>Technical detail</summary>
          <div style={{ paddingTop: 4, fontFamily: 'var(--eb-font-mono, monospace)', wordBreak: 'break-word' }}>
            {entry.detail}
          </div>
        </details>
      )}
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
