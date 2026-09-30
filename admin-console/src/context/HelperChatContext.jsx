import React, { createContext, useContext, useState, useRef, useCallback, useMemo, useEffect } from 'react';
import { useLocation } from 'react-router';
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
import {
  upsertSubject,
  removeSubject,
  topSubject,
} from './page-help-view.js';

// The empty topic set the provider starts with (and falls back to if the
// GET /api/helper/page-help fetch fails) — the panel then always renders the
// Overview fallback rather than crashing on an absent payload.
const EMPTY_PAGE_HELP = { topics: [], overviewId: 'overview' };

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
    mode: 'chat', setMode: () => {}, openTour: () => {}, openHelpFor: () => {},
    pageHelp: EMPTY_PAGE_HELP, currentRoute: '/',
    helpSection: { slug: '', nonce: 0 },
    helpContext: { route: '/', overlay: '', step: '' },
    publishHelpSubject: () => {}, retractHelpSubject: () => {},
  };
}

// ─── useHelpSubject (E17 #1892, docs/helper-chat-concept.md §3.2) ────────────
//
// The hook a non-route help surface uses to say what the panel should answer for
// while it is on screen: an overlay (e.g. the Settings dialog) and/or
// a sub-state (the current wizard step). Publishes on mount and whenever
// the values change, retracts on unmount — so a dialog that closes automatically
// hands help back to the page (or the step) underneath it, with no co-ordination
// between the two components. Pass `active: false` to publish nothing (e.g. a
// modal that stays mounted while closed).
let _subjectSeq = 0;

export function useHelpSubject({ overlay = '', step = '', active = true } = {}) {
  const { publishHelpSubject, retractHelpSubject } = useHelperChat();
  const idRef = useRef(null);
  if (idRef.current === null) idRef.current = `help-subject-${++_subjectSeq}`;
  const id = idRef.current;
  useEffect(() => {
    if (!active) {
      retractHelpSubject(id);
      return undefined;
    }
    publishHelpSubject(id, { overlay, step });
    return () => retractHelpSubject(id);
  }, [id, active, overlay, step, publishHelpSubject, retractHelpSubject]);
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
  // Which face of the panel is showing: 'page' (the page-aware "This page" face,
  // #1873 — the default the header Help button now opens on), 'chat' (the "Ask"
  // face, #1735) or 'tour' (#1737). Lifted to the provider so an external entry
  // point (a page's PageHelpButton, the Getting Started "Take the Tour" button)
  // can open the panel straight into a given face.
  const [mode, setMode] = useState('chat');

  // The curated per-page help topic set, fetched once (concept §4: the client
  // resolves route→topic locally so face-switching is instant/offline). Starts
  // empty and stays empty on a fetch failure — the panel then just renders the
  // Overview fallback. The provider sits inside BrowserRouter (index.jsx), so
  // useLocation is safe here.
  const [pageHelp, setPageHelp] = useState(EMPTY_PAGE_HELP);
  const location = useLocation();
  const currentRoute = location.pathname;

  // The non-route part of the help context (E17 #1892): the stack of subjects
  // published by whatever overlay/wizard step is on screen. The topmost one wins;
  // every decision about the stack is pure in page-help-view.js.
  const [subjects, setSubjects] = useState([]);
  const publishHelpSubject = useCallback((id, subject) => {
    setSubjects((prev) => upsertSubject(prev, id, subject));
  }, []);
  const retractHelpSubject = useCallback((id) => {
    setSubjects((prev) => removeSubject(prev, id));
  }, []);
  // The full context the "This page" face resolves against: the live route plus
  // the winning subject. Closing a dialog drops its subject, so the face falls
  // straight back to the route's own topic (AC1).
  const helpContext = useMemo(
    () => ({ route: currentRoute, ...topSubject(subjects) }),
    [currentRoute, subjects],
  );

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch('/api/helper/page-help', { headers: { ...assistHeaders() } });
        if (!res.ok) return;
        const data = await res.json();
        if (alive && data) setPageHelp(data);
      } catch {
        // Keep the empty set — Overview fallback still renders.
      }
    })();
    return () => { alive = false; };
  }, []);

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

  // Which chapter of the topic the face should scroll to (#1972). The nonce is
  // bumped on every request so pressing the same "?" twice re-scrolls even
  // though the slug did not change — without it a second press on an already
  // open panel would do nothing visible.
  const [helpSection, setHelpSection] = useState({ slug: '', nonce: 0 });

  // Open the panel on the page-aware "This page" face (#1873) — used by the
  // header Help button and every page's PageHelpButton. The face resolves the
  // topic from the live route, so the optional `route` argument is accepted for
  // call-site clarity but the panel always shows help for wherever the user is.
  // An optional `{ section }` (#1972) names the chapter to land on; a surface
  // whose chapter is missing or misspelled just gets the topic from the top.
  const openHelpFor = useCallback((_route, options) => {
    const slug = (options && typeof options.section === 'string') ? options.section.trim() : '';
    setHelpSection((prev) => ({ slug, nonce: prev.nonce + 1 }));
    setMode('page');
    setIsOpen(true);
  }, []);

  // There is deliberately NO route-keyed effect here. The panel opens only on an
  // explicit user action — the header Help button, a PageHelpButton "?", the
  // Agent Chat row menu's Help entry or openTour(). The C2 first-run auto-open
  // nudge (#1873) was removed in #2069: once nearly every route had its own
  // topic, "once per route" had become an unrequested panel on almost every page.

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
    mode, setMode, openTour, openHelpFor, pageHelp, currentRoute, helpSection,
    helpContext, publishHelpSubject, retractHelpSubject,
  }), [isOpen, toggle, messages, sendMessage, isStreaming, clearHistory, mode, openTour, openHelpFor, pageHelp, currentRoute, helpSection, helpContext, publishHelpSubject, retractHelpSubject]);

  return (
    <HelperChatContext.Provider value={value}>
      {children}
    </HelperChatContext.Provider>
  );
}

export default HelperChatProvider;
