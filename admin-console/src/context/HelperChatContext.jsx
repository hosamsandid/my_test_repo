import React, { createContext, useContext, useState, useRef, useCallback, useMemo } from 'react';
import { assistHeaders, notifyAssistError } from './assist-transport.js';
import { UNAUTHORIZED_EVENT } from '../auth/AuthContext';
import { BREADCRUMBS } from '../components/breadcrumbs';
import {
  appendUserMessage,
  appendAssistantPlaceholder,
  applyDelta,
  finishStreaming,
  failStreaming,
  buildRequestBody,
  splitNdjson,
} from './helper-chat-model.js';

// Helper Chat context (#1735, Phase 1.3). Mounted app-level (in index.jsx,
// alongside TranscriptionSessionProvider) so the chat panel + its history
// survive all client-side navigation — you can open Help on one page, navigate
// elsewhere, and keep the same conversation. The deterministic core (message
// transitions, request shape, NDJSON framing) lives in the pure, node:test
// covered helper-chat-model.js; this provider is the thin browser adapter that
// owns the fetch + streaming read and the open/closed + streaming render state.

const HelperChatContext = createContext(null);

export function useHelperChat() {
  // A defensive default keeps a stray consumer mounted outside the provider
  // (e.g. an isolated component test) from crashing.
  return useContext(HelperChatContext) || {
    isOpen: false, toggle: () => {}, messages: [],
    sendMessage: () => {}, isStreaming: false, clearHistory: () => {},
    mode: 'chat', setMode: () => {}, openTour: () => {},
  };
}

// The friendly label for the route the user is on, so the assistant can ground
// its answer on the current page. Falls back to undefined (the endpoint treats
// route context as optional).
function currentRouteLabel(pathname) {
  return BREADCRUMBS[pathname];
}

export function HelperChatProvider({ children }) {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState([]);
  const [isStreaming, setIsStreaming] = useState(false);
  // Which face of the panel is showing: 'chat' (default, #1735) or 'tour'
  // (#1737). Lifted to the provider so an external entry point (the Getting
  // Started page's "Take the Tour" button) can open the panel straight into
  // tour mode.
  const [mode, setMode] = useState('chat');

  // A synchronous mirror of the list so sendMessage builds the request from the
  // just-appended user turn without waiting for a state flush.
  const messagesRef = useRef(messages);
  const setBoth = useCallback((next) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  const toggle = useCallback(() => setIsOpen(o => !o), []);
  const clearHistory = useCallback(() => setBoth([]), [setBoth]);

  // Open the panel directly on the guided tour (used by the Getting Started
  // page). Idempotent — safe to call whether the panel is open or closed.
  const openTour = useCallback(() => {
    setMode('tour');
    setIsOpen(true);
  }, []);

  const sendMessage = useCallback(async (text) => {
    const trimmed = (text || '').trim();
    if (!trimmed || isStreaming) return;

    // 1) user turn, 2) streaming assistant placeholder.
    const withUser = appendUserMessage(messagesRef.current, trimmed);
    const { id: placeholderId, messages: withPlaceholder } = appendAssistantPlaceholder(withUser);
    setBoth(withPlaceholder);
    setIsStreaming(true);

    const route = typeof window !== 'undefined' ? window.location.pathname : undefined;
    const body = buildRequestBody({
      messages: withUser, // history sent excludes the empty placeholder
      currentRoute: route,
      currentRouteLabel: currentRouteLabel(route),
    });

    try {
      const res = await fetch('/api/helper/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...assistHeaders() },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        // Request-shape/provider errors arrive as plain JSON before any stream.
        if (res.status === 401) window.dispatchEvent(new Event(UNAUTHORIZED_EVENT));
        const errBody = await res.json().catch(() => null);
        if (errBody && errBody.code) notifyAssistError(errBody.code);
        setBoth(failStreaming(messagesRef.current, placeholderId));
        return;
      }

      // Stream the NDJSON delta/done body, accumulating each delta onto the
      // placeholder message's content.
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let sawError = false;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const { events, rest } = splitNdjson(buf);
        buf = rest;
        for (const ev of events) {
          if (ev.type === 'delta' && ev.text) {
            setBoth(applyDelta(messagesRef.current, placeholderId, ev.text));
          } else if (ev.type === 'error') {
            sawError = true;
          }
          // `assist` (metadata) and `done` need no client action beyond ending.
        }
      }
      // Flush any trailing partial line.
      const tail = buf.trim();
      if (tail) {
        const { events } = splitNdjson(tail + '\n');
        for (const ev of events) {
          if (ev.type === 'delta' && ev.text) {
            setBoth(applyDelta(messagesRef.current, placeholderId, ev.text));
          } else if (ev.type === 'error') {
            sawError = true;
          }
        }
      }

      if (sawError) {
        setBoth(failStreaming(messagesRef.current, placeholderId));
      } else {
        setBoth(finishStreaming(messagesRef.current, placeholderId));
      }
    } catch {
      // Network failure or a dropped connection mid-stream.
      setBoth(failStreaming(messagesRef.current, placeholderId));
    } finally {
      setIsStreaming(false);
    }
  }, [isStreaming, setBoth]);

  const value = useMemo(() => ({
    isOpen, toggle, messages, sendMessage, isStreaming, clearHistory,
    mode, setMode, openTour,
  }), [isOpen, toggle, messages, sendMessage, isStreaming, clearHistory, mode, openTour]);

  return (
    <HelperChatContext.Provider value={value}>
      {children}
    </HelperChatContext.Provider>
  );
}

export default HelperChatProvider;
