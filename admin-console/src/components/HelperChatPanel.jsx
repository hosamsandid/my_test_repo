import React, { useEffect, useRef, useState } from 'react';
import { X, Send, HelpCircle, MessageCircle, Compass, Mic, Square, Loader2, FileText, ArrowLeft, ArrowUpRight } from 'lucide-react';
import { useNavigate } from 'react-router';
import { useHelperChat } from '../context/HelperChatContext';
import { SafeMarkdown, ensureAgentChatMdCss, ThinkingDots } from '../pages/agent-chat/Message.jsx';
import useVoiceRecorder from '../hooks/useVoiceRecorder.js';
import { SUGGESTED_PROMPTS } from '../context/helper-chat-model.js';
import { pageHelpState, seeAlsoLinks, askPromptChips, topicActions, askHandoff, panelZIndex, contextLabel, findSectionIndex } from '../context/page-help-view.js';
import HelperChatTour from './HelperChatTour.jsx';

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
              {/* Animated "thinking" indicator matching Agent Chat (#1779):
                  the shared ThinkingDots (staggered pulsing dots) replaces the
                  former static ellipsis while a reply is streaming. */}
              {streaming ? <ThinkingDots /> : null}
            </div>
          )
          : <span style={{ whiteSpace: 'pre-wrap' }}>{content}</span>}
      </div>
    </div>
  );
}

function TourCta({ onTakeTour }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      gap: 'var(--eb-space-2)',
      background: 'var(--eb-bg-surface)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-3)',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-primary)' }}>
        <span aria-hidden style={{ fontSize: 'var(--eb-text-base)' }}>👋</span>
        <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600 }}>New to Agent Studio?</span>
      </div>
      <button
        onClick={onTakeTour}
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--eb-space-1)',
          background: 'var(--eb-accent-primary)',
          color: 'var(--eb-text-inverted)',
          border: 'none',
          borderRadius: 'var(--eb-radius-md)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 'var(--eb-text-sm)',
          fontWeight: 600,
          padding: 'var(--eb-space-2) var(--eb-space-3)',
        }}
      >
        <Compass size={15} /> Take the guided tour
      </button>
    </div>
  );
}

function SuggestedPrompts({ onPick, onTakeTour, prompts }) {
  // Page-scoped askPrompts replace the generic Overview chips when a topic is
  // active (#1873); otherwise the static SUGGESTED_PROMPTS are the fallback.
  const chips = (prompts && prompts.length) ? prompts : SUGGESTED_PROMPTS;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)' }}>
      <TourCta onTakeTour={onTakeTour} />
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', color: 'var(--eb-text-secondary)' }}>
        <HelpCircle size={18} />
        <span style={{ fontSize: 'var(--eb-text-base)', fontWeight: 600 }}>Or ask a question</span>
      </div>
      <p style={{ margin: 0, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
        Ask anything about Agent Studio, or start with one of these:
      </p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
        {chips.map(p => (
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

function TabBar({ mode, setMode }) {
  const tab = (id, label, Icon) => {
    const activeTab = mode === id;
    return (
      <button
        onClick={() => setMode(id)}
        aria-pressed={activeTab}
        style={{
          flex: 1,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 'var(--eb-space-1)',
          background: 'none',
          border: 'none',
          borderBottom: activeTab ? '2px solid var(--eb-accent-primary)' : '2px solid transparent',
          color: activeTab ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          fontSize: 'var(--eb-text-sm)',
          fontWeight: activeTab ? 600 : 500,
          padding: 'var(--eb-space-2)',
        }}
      >
        <Icon size={14} /> {label}
      </button>
    );
  };
  return (
    <div style={{
      display: 'flex',
      borderBottom: '1px solid var(--eb-border-default)',
      flexShrink: 0,
    }}>
      {tab('page', 'This page', FileText)}
      {tab('chat', 'Ask', MessageCircle)}
      {tab('tour', 'Tour', Compass)}
    </div>
  );
}

// The "This page" face (#1873): curated per-route help — the topic's title +
// sanitised-markdown body, its "related" links, and page-scoped question chips
// that hand off to Ask. When the route has no dedicated topic (or the user
// clicks the Home affordance) it renders the Overview topic instead, and the
// "← Overview" link is hidden (it would be a no-op there).
function PageFace({ pageHelp, context, atOverview, section, onHome, onNavigate, onAskPrompt, onTour }) {
  const resolved = pageHelpState(pageHelp, context);
  const bodyRef = useRef(null);
  // atOverview forces the Overview home regardless of the current route.
  const showingOverview = atOverview || resolved.isOverview;
  const topic = atOverview ? (resolved.overview || resolved.topic) : resolved.topic;
  // When help resolved through a non-route context (an open dialog, a wizard
  // step — E17 #1892), name it: the topic title alone would look like help for
  // the page behind the dialog.
  const forContext = atOverview ? '' : contextLabel(resolved.contextKey);

  // Chapter deep-link (#1972): a "?" next to one surface asks for the chapter
  // that explains it. The headings carry no ids (the markdown pipeline is shared
  // with Agent Chat and its sanitiser would strip them), so the target is found
  // by slugging the rendered heading text — the same rule the drift guard uses.
  // Re-runs on the nonce, so pressing the same "?" again re-scrolls. Every other
  // outcome lands at the top: no section asked for (the page-level "?" or the
  // header Help button), or a slug that matches nothing — better than leaving
  // the reader wherever the previously-opened chapter left them.
  const sectionSlugWanted = (section && section.slug) || '';
  const sectionNonce = (section && section.nonce) || 0;
  useEffect(() => {
    const root = bodyRef.current;
    if (!root) return;
    // Scroll the panel's own scroller, not via scrollIntoView — the panel is
    // position:fixed, and scrollIntoView would also scroll every scrollable
    // ancestor, i.e. the page behind it.
    const scroller = root.closest('[data-help-scroll]');
    if (!scroller) return;
    const headings = Array.from(root.querySelectorAll('h2, h3'));
    const idx = findSectionIndex(headings.map((h) => h.textContent || ''), sectionSlugWanted);
    if (idx < 0) { scroller.scrollTop = 0; return; }
    scroller.scrollTop += headings[idx].getBoundingClientRect().top - scroller.getBoundingClientRect().top;
  }, [sectionSlugWanted, sectionNonce, topic]);

  if (!topic) {
    return (
      <div style={{ padding: 'var(--eb-space-4)', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
        No help is available for this page yet. Try the <strong>Ask</strong> tab.
      </div>
    );
  }

  const links = seeAlsoLinks(topic);
  const chips = askPromptChips(topic);
  // "Where to go next" CTAs (#1874) — a topic may carry action buttons; the
  // Overview's are the ones the retired Getting Started page used to render.
  const ctas = topicActions(topic);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)', padding: 'var(--eb-space-4)' }}>
      {!showingOverview && (
        <button
          onClick={onHome}
          style={{
            alignSelf: 'flex-start',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 'var(--eb-space-1)',
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            fontFamily: 'inherit',
            fontSize: 'var(--eb-text-sm)',
            padding: 0,
          }}
        >
          <ArrowLeft size={14} /> Overview
        </button>
      )}

      <div>
        {forContext ? (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            fontWeight: 600,
            textTransform: 'uppercase',
            letterSpacing: '0.04em',
            color: 'var(--eb-text-muted)',
            marginBottom: 'var(--eb-space-1)',
          }}>
            {forContext}
          </div>
        ) : null}
        <h2 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', fontWeight: 700, color: 'var(--eb-text-primary)' }}>
          {topic.title}
        </h2>
        {topic.summary ? (
          <p style={{ margin: 'var(--eb-space-1) 0 0', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)' }}>
            {topic.summary}
          </p>
        ) : null}
      </div>

      {topic.body ? (
        <div className="agent-chat-md" ref={bodyRef}>
          <SafeMarkdown body={topic.body} />
        </div>
      ) : null}

      {ctas.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
          {ctas.map(c => (
            <button
              key={c.label}
              onClick={() => (c.to ? onNavigate(c.to) : onTour())}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 'var(--eb-space-2)',
                background: c.primary ? 'var(--eb-accent-primary)' : 'var(--eb-bg-elevated)',
                border: c.primary ? 'none' : '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: c.primary ? 'var(--eb-text-inverted)' : 'var(--eb-text-primary)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                fontSize: 'var(--eb-text-sm)',
                fontWeight: 'var(--eb-font-semibold)',
                padding: 'var(--eb-space-2) var(--eb-space-3)',
              }}
            >
              {c.to ? <ArrowUpRight size={14} /> : <Compass size={14} />} {c.label}
            </button>
          ))}
        </div>
      )}

      {links.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-secondary)' }}>Related</span>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-2)' }}>
            {links.map(l => (
              <button
                key={l.to}
                onClick={() => onNavigate(l.to)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                  background: 'var(--eb-bg-elevated)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  color: 'var(--eb-accent-primary)',
                  cursor: 'pointer',
                  fontFamily: 'inherit',
                  fontSize: 'var(--eb-text-sm)',
                  padding: 'var(--eb-space-1) var(--eb-space-2)',
                }}
              >
                {l.label} <ArrowUpRight size={13} />
              </button>
            ))}
          </div>
        </div>
      )}

      {chips.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', fontWeight: 600, color: 'var(--eb-text-secondary)' }}>Ask about this page</span>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-2)' }}>
            {chips.map(q => (
              <button
                key={q}
                onClick={() => onAskPrompt(q)}
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
                {q}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export default function HelperChatPanel() {
  const { isOpen, toggle, messages, sendMessage, isStreaming, mode, setMode, openTour, pageHelp, currentRoute, helpContext, helpSection, registerHelpPanel } = useHelperChat();
  const [composer, setComposer] = useState('');
  const scrollRef = useRef(null);
  const navigate = useNavigate();
  const isTour = mode === 'tour';
  const isPage = mode === 'page';

  // The "This page" face can be pinned to the Overview home via its "← Overview"
  // link; navigating to a different route clears that pin so the face tracks the
  // page again.
  const [atOverview, setAtOverview] = useState(false);
  useEffect(() => { setAtOverview(false); }, [currentRoute]);

  useEffect(() => { ensureAgentChatMdCss(); }, []);

  // Tell the provider a panel is on screen, so the first-run auto-open nudge is
  // never spent on a screen that has no panel (E17 #1892 — the setup wizard).
  useEffect(() => registerHelpPanel(), [registerHelpPanel]);

  // Page-scoped Ask chips: when the current route has a topic, its askPrompts
  // seed the Ask empty state instead of the generic SUGGESTED_PROMPTS (#1873).
  const pageTopic = pageHelpState(pageHelp, helpContext).topic;
  const askPrompts = askPromptChips(pageTopic);

  // A "This page" chip hands off to Ask pre-seeded (concept §4): switch to the
  // Ask face and drop the question into the composer for the user to send/edit.
  const seedAsk = (prompt) => {
    const { question } = askHandoff(prompt);
    if (!question) return;
    setComposer(question);
    setMode('chat');
  };

  // Quick voice dictation (#1779), reusing Agent Chat's shared useVoiceRecorder
  // hook (mic → record → POST /api/transcribe → text). The transcription is
  // appended to whatever is already in the composer via a functional update, so
  // text the user types while a transcription is in flight is never clobbered.
  const handleTranscription = React.useCallback((text) => {
    setComposer(prev => (prev.trim() ? prev + ' ' + text : text));
  }, []);
  const { state: voiceState, elapsedSeconds, error: voiceError, toggleRecording, clearError } = useVoiceRecorder({
    onTranscription: handleTranscription,
  });
  // Auto-clear a surfaced voice/transcription error after 3s (matches MessageInput).
  useEffect(() => {
    if (!voiceError) return undefined;
    const t = setTimeout(clearError, 3000);
    return () => clearTimeout(t);
  }, [voiceError, clearError]);

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
        // Normally below modals/side panels; lifted above the Modal layer while an
        // overlay help context is active, so help *for* an open dialog is visible
        // next to it (E17 #1892).
        zIndex: panelZIndex(helpContext),
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

      {/* Tab bar: This page / Ask / Tour */}
      <TabBar mode={mode} setMode={setMode} />

      {isTour ? (
        /* Tour mode */
        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <HelperChatTour />
        </div>
      ) : isPage ? (
        /* "This page" face (#1873) */
        <div data-help-scroll style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          <PageFace
            pageHelp={pageHelp}
            context={helpContext}
            atOverview={atOverview}
            section={helpSection}
            onHome={() => setAtOverview(true)}
            onNavigate={(to) => navigate(to)}
            onAskPrompt={seedAsk}
            onTour={openTour}
          />
        </div>
      ) : (
      <>
      {/* Message list */}
      <div
        ref={scrollRef}
        style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}
      >
        {messages.length === 0
          ? (
            <SuggestedPrompts
              onPick={(p) => { if (!isStreaming) sendMessage(p); }}
              onTakeTour={() => setMode('tour')}
              prompts={askPrompts}
            />
          )
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
        borderTop: '1px solid var(--eb-border-default)',
        padding: 'var(--eb-space-3)',
        flexShrink: 0,
      }}>
        {/* Keyframes for the mic's recording pulse + the transcribing spinner.
            HelperChatPanel is standalone (not a descendant of ChatPanel), so it
            injects its own — mirrors MessageInput's local <style>. */}
        <style>{'@keyframes stt-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } } @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }'}</style>
        <div style={{
          display: 'flex',
          gap: 'var(--eb-space-2)',
          alignItems: 'flex-end',
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
          {/* Recording timer + microphone (quick dictation, #1779). */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 4, height: 'fit-content' }}>
            {voiceState === 'recording' && (
              <span style={{
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-status-error-text, #dc2626)',
                whiteSpace: 'nowrap',
                fontVariantNumeric: 'tabular-nums',
              }}>
                {Math.floor(elapsedSeconds / 60)}:{String(elapsedSeconds % 60).padStart(2, '0')}
              </span>
            )}
            <button
              onClick={toggleRecording}
              disabled={voiceState === 'transcribing'}
              aria-label={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Record voice message'}
              title={voiceState === 'recording' ? 'Stop recording' : voiceState === 'transcribing' ? 'Transcribing…' : 'Voice input (tap to dictate)'}
              style={{
                width: 34, height: 34,
                background: voiceState === 'recording' ? 'var(--eb-status-error-bg, #fef2f2)' : 'transparent',
                color: voiceState === 'recording'
                  ? 'var(--eb-status-error-text, #dc2626)'
                  : voiceState === 'transcribing'
                    ? 'var(--eb-text-muted)'
                    : 'var(--eb-text-secondary)',
                border: 'none',
                borderRadius: 'var(--eb-radius-md)',
                cursor: voiceState === 'transcribing' ? 'not-allowed' : 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                animation: voiceState === 'recording' ? 'stt-pulse 1.5s ease-in-out infinite' : 'none',
              }}
            >
              {voiceState === 'recording'
                ? <Square size={15} />
                : voiceState === 'transcribing'
                  ? <Loader2 size={15} style={{ animation: 'spin 0.8s linear infinite' }} />
                  : <Mic size={15} />}
            </button>
          </div>
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
        {/* Transcription status / error surface (AC6): errors never break the
            composer and clear themselves after 3s so the user can retry. */}
        {(voiceError || voiceState === 'transcribing') && (
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: voiceError ? 'var(--eb-status-error-text, #dc2626)' : 'var(--eb-text-muted)',
            marginTop: 'var(--eb-space-1)',
            paddingLeft: 'var(--eb-space-1)',
          }}>
            {voiceError || 'Transcribing…'}
          </div>
        )}
      </div>
      </>
      )}
    </div>
  );
}
