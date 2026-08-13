import React, { useEffect, useRef, useState } from 'react';
import { X, Send, HelpCircle } from 'lucide-react';
import { useHelperChat } from '../context/HelperChatContext';
import { SafeMarkdown, ensureAgentChatMdCss } from '../pages/agent-chat/Message.jsx';
import { SUGGESTED_PROMPTS } from '../context/helper-chat-model.js';

// Helper Chat panel (#1735, Phase 1.3). A non-blocking slide-in help assistant,
// mounted once in Shell.jsx. Unlike SidePanel.jsx it has NO backdrop — the user
// keeps interacting with the rest of the app while it is open — and it sits
// below SidePanel's z-index (50 vs 60/61). It stays mounted while closed and
// slides off-screen (translateX(100%)) so the open/close transition animates;
// pointer-events are disabled off-screen so a closed panel never intercepts
// clicks or affects the main layout.

function Bubble({ role, content, streaming }) {
  const isAssistant = role === 'assistant';
  return (
    <div style={{ display: 'flex', justifyContent: isAssistant ? 'flex-start' : 'flex-end' }}>
      <div
        style={{
          maxWidth: '88%',
          background: isAssistant ? 'var(--eb-bg-surface)' : 'var(--eb-bg-selected)',
          color: 'var(--eb-text-primary)',
          border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-lg)',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          fontSize: 'var(--eb-text-base)',
          lineHeight: 1.5,
          wordBreak: 'break-word',
        }}
      >
        {isAssistant
          ? (
            <div className="agent-chat-md">
              {content ? <SafeMarkdown body={content} /> : null}
              {streaming ? <span aria-label="thinking">{content ? ' …' : '…'}</span> : null}
            </div>
          )
          : <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>}
      </div>
    </div>
  );
}

function SuggestedPrompts({ onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-secondary)' }}>
        <HelpCircle size={18} />
        <span style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600 }}>How can I help?</span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        Ask anything about Agent Studio, or start with one of these:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {SUGGESTED_PROMPTS.map(p => (
          <button
            key={p}
            onClick={() => onPick(p)}
            style={{
              textAlign: 'left',
              background: 'var(--eb-bg-elevated)',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-primary)',
              cursor: 'pointer',
              fontFamily: 'inherit',
              fontSize: 'var(--eb-text-sm)',
              padding: 'var(--eb-space-2) var(--eb-space-3)',
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'var(--eb-bg-elevated)'; }}
          >
            {p}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function HelperChatPanel() {
  const { isOpen, toggle, messages, sendMessage, isStreaming } = useHelperChat();
  const [composer, setComposer] = useState('');
  const scrollRef = useRef(null);

  useEffect(() => { ensureAgentChatMdCss(); }, []);

  // Keep the transcript pinned to the newest message as it streams in.
  useEffect(() => {
    if (isOpen && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isOpen]);

  const submit = () => {
    const text = composer.trim();
    if (!text || isStreaming) return;
    sendMessage(text);
    setComposer('');
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      aria-hidden={!isOpen}
      style={{
        position: 'fixed',
        top: 0,
        right: 0,
        bottom: 0,
        width: 'var(--eb-side-panel-width)',
        maxWidth: '100vw',
        zIndex: 50,
        display: 'flex',
        flexDirection: 'column',
        background: 'var(--eb-bg-elevated)',
        borderLeft: '1px solid var(--eb-border-default)',
        boxShadow: isOpen ? 'var(--eb-shadow-lg, -8px 0 24px rgba(0,0,0,0.25))' : 'none',
        transform: isOpen ? 'translateX(0)' : 'translateX(100%)',
        transition: 'transform var(--eb-transition-normal, 200ms ease)',
        pointerEvents: isOpen ? 'auto' : 'none',
      }}
    >
      {/* Header */}
      <div style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderBottom: '1px solid var(--eb-border-default)',
        flexShrink: 0,
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <HelpCircle size={16} />
          <span style={{ fontWeight: 600, fontSize: 'var(--eb-text-base)' }}>Help</span>
        </div>
        <button
          onClick={toggle}
          title="Close"
          aria-label="Close help"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            padding: 'var(--eb-space-1)',
          }}
        >
          <X size={16} />
        </button>
      </div>

      {/* Message list */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {messages.length === 0
          ? <SuggestedPrompts onPick={(p) => { if (!isStreaming) sendMessage(p); }} />
          : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)' }}>
              {messages.map(m => (
                <Bubble key={m.id} role={m.role} content={m.content} streaming={m.streaming} />
              ))}
            </div>
          )}
      </div>

      {/* Input bar */}
      <div style={{
        display: 'flex',
        gap: 'var(--eb-space-2)',
        alignItems: 'flex-end',
        padding: 'var(--eb-space-3)',
        borderTop: '1px solid var(--eb-border-default)',
        flexShrink: 0,
      }}>
        <textarea
          value={composer}
          onChange={e => setComposer(e.target.value)}
          onKeyDown={onKeyDown}
          disabled={isStreaming}
          rows={2}
          placeholder="Ask anything about Agent Studio…"
          style={{
            flex: 1,
            resize: 'none',
            background: 'var(--eb-bg-surface)',
            border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)',
            color: 'var(--eb-text-primary)',
            fontFamily: 'inherit',
            fontSize: 'var(--eb-text-base)',
            padding: 'var(--eb-space-2)',
            lineHeight: 1.4,
          }}
        />
        <button
          onClick={submit}
          disabled={isStreaming || !composer.trim()}
          title="Send"
          aria-label="Send"
          style={{
            background: (isStreaming || !composer.trim()) ? 'var(--eb-bg-hover)' : 'var(--eb-accent-primary)',
            color: (isStreaming || !composer.trim()) ? 'var(--eb-text-muted)' : 'var(--eb-text-inverted)',
            border: 'none',
            borderRadius: 'var(--eb-radius-md)',
            cursor: (isStreaming || !composer.trim()) ? 'default' : 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 'var(--eb-space-2) var(--eb-space-3)',
            height: 'fit-content',
          }}
        >
          <Send size={16} />
        </button>
      </div>
    </div>
  );
}
