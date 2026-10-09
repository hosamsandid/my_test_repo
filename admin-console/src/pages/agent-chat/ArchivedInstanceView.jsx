import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowLeft, ExternalLink, Loader2 } from 'lucide-react';
import { useApi } from '../../hooks/useApi';
import { useAuth } from '../../auth/AuthContext';
import Message from './Message';
import SessionLogPanel from './SessionLogPanel';
import { buildAuthorDirectory } from './message-author.js';
import { chatMessagesFromEvents } from './chat-event-message.js';
import {
  removedInstanceName, removedInstanceFacts, itemUrl, archivedChatNotice, archivedAgentUserId,
  archiveSessionUrl, sessionPageLabel,
} from './removed-instance-view.js';

const CHAT_PAGE = 50;

/**
 * A removed pool instance's archive, read-only (#2944 AC4): its chat history
 * rendered through the same `Message` bubbles as a live room, beside its
 * session log rendered by the same `SessionLogPanel` (one-shot, no live tail).
 * There is no composer, no settings and no resume — the instance is gone.
 *
 * Opened from the rail's "Removed instances" group or the GitHub Event Log as
 * `/chats/<roleId>?archive=<key>`; the API checks the caller may read the
 * role's chat and logs, and 404s once the archive has expired.
 */
export default function ArchivedInstanceView({ roleId, roleAgent, archiveKey, onBack }) {
  const base = `/api/agents/${encodeURIComponent(roleId)}/pool-archive/${encodeURIComponent(archiveKey)}`;
  const { data, error, loading } = useApi(base);
  const entry = data?.entry || null;
  const rooms = useMemo(() => (Array.isArray(data?.rooms) ? data.rooms : []), [data]);

  const { user } = useAuth();
  const viewer = useMemo(
    () => ({ userId: user?.userId ?? null, username: user?.username ?? null }),
    [user?.userId, user?.username],
  );
  const { data: directoryUsers } = useApi('/api/admin/users');
  const authorDirectory = useMemo(() => buildAuthorDirectory(directoryUsers), [directoryUsers]);
  const agentUserId = archivedAgentUserId(roleAgent?.userId, entry?.instanceId);

  // ── Chat: Matrix-shaped pages, newest first; "Load earlier" walks back. ──
  const [messages, setMessages] = useState([]);
  const [nextFrom, setNextFrom] = useState(null);
  const [chatState, setChatState] = useState({ loading: true, error: null, noChat: false, truncated: false });
  const loadChat = useCallback((from) => {
    setChatState(s => ({ ...s, loading: true, error: null }));
    const q = new URLSearchParams({ limit: String(CHAT_PAGE) });
    if (from) q.set('from', from);
    fetch(`${base}/messages?${q}`)
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then(page => {
        const older = chatMessagesFromEvents(page?.chunk);
        setMessages(prev => (from ? [...older, ...prev] : older));
        setNextFrom(page?.end || null);
        setChatState({ loading: false, error: null, noChat: !!page?.noChat, truncated: !!page?.truncated });
      })
      .catch(e => setChatState(s => ({ ...s, loading: false, error: e.message })));
  }, [base]);
  useEffect(() => {
    setMessages([]);
    setNextFrom(null);
    loadChat(null);
  }, [loadChat]);

  // ── Session log: one room at a time, paged from the end. ──
  const [roomId, setRoomId] = useState(null);
  const [page, setPage] = useState(0);
  const [pages, setPages] = useState(1);
  useEffect(() => { setRoomId(rooms[0] || null); setPage(0); }, [rooms]);
  useEffect(() => { setPage(0); }, [roomId]);
  const sessionUrl = roomId ? archiveSessionUrl(roleId, archiveKey, roomId, page) : null;
  useEffect(() => {
    if (!sessionUrl) return undefined;
    let live = true;
    // The panel fetches the events; the page count comes from the same answer.
    fetch(sessionUrl)
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (live && d && Number.isInteger(d.pages)) setPages(d.pages); })
      .catch(() => {});
    return () => { live = false; };
  }, [sessionUrl]);

  if (loading && !data) {
    return <Centered><Loader2 size={16} style={{ animation: 'spin 1s linear infinite' }} /> Loading archive…</Centered>;
  }
  if (error || !entry) {
    return (
      <Centered>
        <div>This removed instance&apos;s archive is not available — it may have expired.</div>
        <BackButton onBack={onBack} />
      </Centered>
    );
  }

  const name = removedInstanceName(entry, roleAgent);
  const url = itemUrl(entry.repo, entry.item);
  const notice = archivedChatNotice(entry);
  const pageLabel = sessionPageLabel(page, pages);

  return (
    <div style={{ flex: 1, minWidth: 0, height: '100%', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <div style={{
        padding: 'var(--eb-space-3) var(--eb-space-4)',
        borderBottom: '1px solid var(--eb-border-default)',
        display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-1)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
          <BackButton onBack={onBack} />
          <h2 style={{ margin: 0, fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {name}
          </h2>
          <span style={BADGE_STYLE}>Removed</span>
          <span style={BADGE_STYLE}>Read-only</span>
          {url && (
            <a href={url} target="_blank" rel="noopener noreferrer"
              style={{ display: 'inline-flex', alignItems: 'center', gap: 4, color: 'var(--eb-accent-primary)', fontSize: 'var(--eb-text-sm)' }}>
              {entry.repo}#{entry.item} <ExternalLink size={12} />
            </a>
          )}
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--eb-space-1) var(--eb-space-4)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
          {removedInstanceFacts(entry).map(([k, v]) => <span key={k}>{k}: {v}</span>)}
        </div>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: 'flex' }}>
        <section aria-label="Archived chat history" style={{ flex: 1, minWidth: 0, overflowY: 'auto', padding: 'var(--eb-space-3) var(--eb-space-4)' }}>
          {notice && <Notice>{notice}</Notice>}
          {!notice && nextFrom && (
            <button type="button" onClick={() => loadChat(nextFrom)} disabled={chatState.loading} style={LINK_BUTTON_STYLE}>
              Load earlier messages
            </button>
          )}
          {!notice && !nextFrom && chatState.truncated && (
            <Notice>Only the most recent messages were archived.</Notice>
          )}
          {chatState.error && <Notice>Could not load the archived chat ({chatState.error}).</Notice>}
          {messages.map(msg => (
            <Message
              key={msg.event_id}
              message={msg}
              agentUserId={agentUserId}
              viewer={viewer}
              authorDirectory={authorDirectory}
            />
          ))}
          {!notice && !chatState.loading && !chatState.error && messages.length === 0 && (
            <Notice>The archived chat has no messages.</Notice>
          )}
        </section>

        <section aria-label="Archived session log" style={{
          width: '45%', minWidth: 320, borderLeft: '1px solid var(--eb-border-default)',
          display: 'flex', flexDirection: 'column', minHeight: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-secondary)' }}>
            <span style={{ fontWeight: 'var(--eb-font-medium)' }}>Session log</span>
            {rooms.length > 1 && (
              <select value={roomId || ''} onChange={e => setRoomId(e.target.value)} aria-label="Room">
                {rooms.map((r, i) => <option key={r} value={r}>{i === 0 && r === entry.roomId ? `${r} (chat)` : r}</option>)}
              </select>
            )}
            {pageLabel && (
              <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
                <button type="button" style={LINK_BUTTON_STYLE} disabled={page >= pages - 1} onClick={() => setPage(p => p + 1)}>Earlier</button>
                <span>{pageLabel}</span>
                <button type="button" style={LINK_BUTTON_STYLE} disabled={page === 0} onClick={() => setPage(p => Math.max(0, p - 1))}>Later</button>
              </span>
            )}
          </div>
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            {roomId ? (
              <SessionLogPanel
                agentId={roleId}
                roomId={roomId}
                backfillUrl={sessionUrl}
                staticOnly
                embedded
              />
            ) : (
              <Notice>No session log was archived for this instance.</Notice>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

const BADGE_STYLE = {
  flexShrink: 0,
  padding: '0 4px',
  borderRadius: 'var(--eb-radius-sm)',
  border: '1px solid var(--eb-border-default)',
  fontSize: 'var(--eb-text-xs)',
  lineHeight: 1.5,
  color: 'var(--eb-text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const LINK_BUTTON_STYLE = {
  padding: 0,
  border: 'none',
  background: 'none',
  color: 'var(--eb-accent-primary)',
  font: 'inherit',
  fontSize: 'var(--eb-text-xs)',
  cursor: 'pointer',
};

function BackButton({ onBack }) {
  return (
    <button type="button" onClick={onBack} title="Back to the role's chat" aria-label="Back to the role's chat"
      style={{ ...LINK_BUTTON_STYLE, display: 'inline-flex', alignItems: 'center' }}>
      <ArrowLeft size={14} />
    </button>
  );
}

function Notice({ children }) {
  return (
    <div style={{
      margin: 'var(--eb-space-2) 0',
      padding: 'var(--eb-space-2) var(--eb-space-3)',
      border: '1px solid var(--eb-border-default)',
      borderRadius: 'var(--eb-radius-md)',
      fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-secondary)',
    }}>
      {children}
    </div>
  );
}

function Centered({ children }) {
  return (
    <div style={{
      flex: 1, height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      gap: 'var(--eb-space-2)', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
    }}>
      {children}
    </div>
  );
}
