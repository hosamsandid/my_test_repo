import React, {
  createContext, useContext, useRef, useEffect, useState, useCallback,
} from 'react';
import { useNavigate } from 'react-router';
import { useAuth } from '../auth/AuthContext.jsx';
import { useAgentStatuses } from './AgentStatusesContext.jsx';
import {
  resolveInitialNotifyEnabled,
  loadStoredNotifyEnabled,
  NOTIFY_SETTING_CHANGED_EVENT,
  computeBackNotifications,
  addManuallyMessagedId,
  selectUnnotified,
  notificationTitleFor,
  notificationTagFor,
  notificationsSupported,
  getNotificationPermission,
  isConsoleInForeground,
} from '../pages/agent-chat/agent-back-notification.js';

// "An agent you messaged is back" browser notification (#2397).
//
// Mounted app-level (inside AgentStatusesProvider, under BrowserRouter) so it
// sees the shared /api/agents/statuses poll, survives navigation, and can route
// on a notification click. It owns three pieces of session-scoped state: the
// enabled flag (from the per-user setting, live-updated without reload), the set
// of agents the current user manually messaged this page/session, and a per-turn
// dedupe map. The deterministic logic all lives in agent-back-notification.js.

// Same key AgentChat.jsx / Shell.jsx use for the in-page "viewed" map, so
// clicking a notification clears the unread dot exactly like opening the chat.
const LAST_VIEWED_KEY = 'agentChat.lastViewed';

const AgentBackNotificationContext = createContext(null);

export function AgentBackNotificationProvider({ children }) {
  const { user } = useAuth();
  const statuses = useAgentStatuses();
  const navigate = useNavigate();

  const username = user?.username;

  // Enabled preference. Initialised from the session/local value, then updated
  // only on a user switch (login) or on the settings-changed broadcast (AC10) —
  // never re-resolved on an unrelated re-render, which could clobber a just-made
  // toggle with a stale session value.
  const [enabled, setEnabled] = useState(() => resolveInitialNotifyEnabled({
    sessionValue: user?.chatNotifyOnBack,
    storedValue: loadStoredNotifyEnabled(username),
    hasServerRecord: user != null && user.userId != null,
  }));
  useEffect(() => {
    setEnabled(resolveInitialNotifyEnabled({
      sessionValue: user?.chatNotifyOnBack,
      storedValue: loadStoredNotifyEnabled(username),
      hasServerRecord: user != null && user.userId != null,
    }));
    // Keyed on username only: username + chatNotifyOnBack arrive together from a
    // single session fetch, so this captures the fresh flag on login/switch
    // without re-running on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [username]);

  useEffect(() => {
    function onChanged(e) {
      const val = e?.detail?.enabled;
      if (typeof val === 'boolean') setEnabled(val);
    }
    window.addEventListener(NOTIFY_SETTING_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(NOTIFY_SETTING_CHANGED_EVENT, onChanged);
  }, []);

  // Agents the user manually messaged. The in-memory ref drives the "agent is
  // back" browser notification (#2397 — session-scoped, an auto-triggered run
  // never lands here because it never goes through the chat composer's send
  // handler). #2429 additionally mirrors each id to localStorage so the same
  // manual-vs-automatic signal survives a reload and can drive the status dot's
  // solid-vs-hollow green (AC5/AC6); the notification keeps using the ref, so its
  // behaviour is unchanged.
  const manuallyMessagedRef = useRef(new Set());
  const markManuallyMessaged = useCallback((id) => {
    if (!id) return;
    manuallyMessagedRef.current.add(id);
    addManuallyMessagedId(id);
  }, []);

  const prevStatusesRef = useRef(null);
  const notifiedRef = useRef({});
  const enabledRef = useRef(enabled);
  useEffect(() => { enabledRef.current = enabled; }, [enabled]);

  const fireNotification = useCallback((c) => {
    try {
      const n = new window.Notification(notificationTitleFor(c.displayName), {
        tag: notificationTagFor(c.id),
        // No body content (AC2) — title (agent name) only.
      });
      // #2409 AC5: an OS-level block (browser grant present, OS/Focus-Assist off)
      // lets construction succeed but shows nothing and throws nothing. Surface
      // that (and any async delivery error) in the console so a future "still
      // doesn't fire" report is diagnosable without another code-archaeology pass.
      n.onerror = (err) => {
        // eslint-disable-next-line no-console
        console.warn('[agent-back-notification] notification failed to display for', c.id, err);
      };
      n.onclick = () => {
        try { window.focus(); } catch { /* ignore */ }
        // Mark viewed so the in-page unread dot clears (AC3), matching handleSelect.
        try {
          const raw = window.localStorage.getItem(LAST_VIEWED_KEY);
          const map = raw ? JSON.parse(raw) : {};
          map[c.id] = Date.now();
          window.localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map));
        } catch { /* ignore quota / privacy mode */ }
        navigate(`/chats/${c.id}`);
        try { n.close(); } catch { /* ignore */ }
      };
    } catch (err) {
      // A construction failure must never crash the poll — but no longer swallow
      // it silently (#2409 AC5): a synchronous throw here is otherwise invisible.
      // eslint-disable-next-line no-console
      console.warn('[agent-back-notification] notification construction threw for', c.id, err);
    }
  }, [navigate]);

  // Runs on every status poll. Always advances the previous-snapshot baseline so
  // busy→done transitions are measured against the immediately-preceding poll,
  // regardless of gating.
  useEffect(() => {
    const prev = prevStatusesRef.current;
    prevStatusesRef.current = statuses;
    if (prev == null) return;                                   // baseline the first poll
    if (!enabledRef.current) return;                            // AC7: off → nothing fires
    // Never fire while the console is the surface the user is looking at. This
    // is BOTH visible AND OS-focused (#2409 AC2/candidate #1) — a browser window
    // that's visible but not focused (another app/monitor) counts as "away".
    if (isConsoleInForeground(typeof document !== 'undefined' ? document : null)) return;
    if (!notificationsSupported(window)) return;
    if (getNotificationPermission(window) !== 'granted') return; // AC8: blocked/denied → silent

    const candidates = computeBackNotifications(prev, statuses, {
      manuallyMessaged: manuallyMessagedRef.current,
    });
    if (candidates.length === 0) return;
    const { toFire, notified } = selectUnnotified(candidates, notifiedRef.current);
    notifiedRef.current = notified;
    for (const c of toFire) fireNotification(c);
  }, [statuses, fireNotification]);

  return (
    <AgentBackNotificationContext.Provider value={{ markManuallyMessaged, enabled }}>
      {children}
    </AgentBackNotificationContext.Provider>
  );
}

// Consumers (ChatPanel's send handler) get a no-op fallback when rendered
// outside the provider so a test/harness mount never throws.
export function useAgentBackNotification() {
  const ctx = useContext(AgentBackNotificationContext);
  return ctx || { markManuallyMessaged: () => {}, enabled: false };
}
