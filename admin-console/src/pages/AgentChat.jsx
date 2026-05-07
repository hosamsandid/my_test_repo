import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { PanelRightOpen, MessageCircle, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import AgentList from './agent-chat/AgentList';
import ChatPanel from './agent-chat/ChatPanel';
import RightRail from './agent-chat/RightRail';

const LEFT_WIDTH_KEY  = 'agentChat.leftWidth';
const RIGHT_WIDTH_KEY = 'agentChat.rightWidth';
const LEFT_MIN  = 160;
const LEFT_MAX  = 800;
const RIGHT_MIN = 200;
const RIGHT_MAX = 1600;
const CHAT_MIN  = 320;

function loadPanelWidth(key, fallback) {
  try {
    const v = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(v) ? v : fallback;
  } catch { return fallback; }
}

function ResizeDivider({ onMouseDown }) {
  const [hovered, setHovered] = React.useState(false);
  return (
    <div
      onMouseDown={onMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title="Ziehen zum Anpassen der Breite"
      style={{
        width: 12,
        flexShrink: 0,
        cursor: 'col-resize',
        position: 'relative',
        zIndex: 5,
        userSelect: 'none',
      }}
    >
      <div style={{
        position: 'absolute',
        left: '50%',
        top: 0,
        bottom: 0,
        width: hovered ? 3 : 1,
        transform: 'translateX(-50%)',
        background: hovered ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        transition: 'background 0.15s, width 0.15s',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

const LAST_AGENT_KEY = 'agentChat.lastAgentId';
const LAST_VIEWED_KEY = 'agentChat.lastViewed';
const STATUS_POLL_MS = 5000;

function loadLastViewed() {
  try { return JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || '{}'); }
  catch { return {}; }
}
function saveLastViewed(map) {
  try { localStorage.setItem(LAST_VIEWED_KEY, JSON.stringify(map)); } catch {}
}

/**
 * Top-level page for the integrated agent chat (PR #3).
 *
 * Layout: [agent list 260 px] [chat panel: header / messages / input].
 * Owns:
 *   - the list of Matrix-enabled agents (fetched once)
 *   - which agent is selected (from `:agentId` route param)
 *   - the live `dmRoomId` for the selected agent (created lazily on first open)
 *
 * The page itself is non-scrolling — only the messages area inside ChatPanel
 * scrolls. Height is derived from `100vh - header - extra` so it fills the
 * Shell's <main> without overflowing.
 */
export default function AgentChat() {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const { data: agents, loading, error, refetch } = useApi('/api/matrix/agents');

  // Local map agentId -> roomId, for rooms we created during this session
  // (overrides the persisted `dmRoomId` returned by /api/matrix/agents).
  const [createdRooms, setCreatedRooms] = useState({});

  // Keep a ref to the current agentId so the polling closure can read it
  // without becoming stale (the effect has [] deps and runs once).
  const agentIdRef = useRef(agentId);
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);

  // Tracks agents the user explicitly marked as unread. Prevents the poll
  // from auto-stamping them as viewed while they are still in the URL.
  const manuallyUnreadRef = useRef(new Set());

  // Map agentId -> effective display state
  // ('busy'|'unread'|'idle'|'problem')
  const [agentStatuses, setAgentStatuses] = useState({});
  const statusTimerRef = useRef(null);
  useEffect(() => {
    const poll = () => {
      // Always mark the currently open agent as "viewed" before computing
      // statuses so it never flips to "unread" while the user is looking at it.
      // Exception: skip agents the user explicitly marked as unread.
      const currentId = agentIdRef.current;
      if (currentId && !manuallyUnreadRef.current.has(currentId)) {
        const viewed = loadLastViewed();
        viewed[currentId] = Date.now();
        saveLastViewed(viewed);
      }

      fetch('/api/agents/statuses')
        .then(r => r.ok ? r.json() : [])
        .then(list => {
          const viewed = loadLastViewed();
          const map = {};
          for (const { id, activityState, lastResponseAt } of list) {
            let effective;
            if (activityState === 'disabled' || activityState === 'offline') {
              effective = 'problem';
            } else if (activityState === 'busy') {
              effective = 'busy';
            } else if (lastResponseAt && new Date(lastResponseAt).getTime() > (viewed[id] || 0)) {
              effective = 'unread';
            } else {
              effective = 'idle';
            }
            map[id] = effective;
          }
          setAgentStatuses(map);
        })
        .catch(() => {});
    };
    poll();
    statusTimerRef.current = setInterval(poll, STATUS_POLL_MS);
    return () => clearInterval(statusTimerRef.current);
  }, []);

  // Right-rail (session log panel) toggle, persisted in localStorage so the
  // user's preference survives reload. Declared early so the drag handler
  // below can read it when computing the divider footprint.
  const [logOpen, setLogOpen] = useState(() => {
    try { return localStorage.getItem('agentChat.logOpen') !== 'false'; }
    catch { return true; }
  });
  useEffect(() => {
    try { localStorage.setItem('agentChat.logOpen', logOpen ? 'true' : 'false'); }
    catch { /* ignore quota / privacy mode */ }
  }, [logOpen]);

  // Panel widths, persisted in localStorage.
  const [leftWidth,  setLeftWidth]  = useState(() => loadPanelWidth(LEFT_WIDTH_KEY,  260));
  const [rightWidth, setRightWidth] = useState(() => loadPanelWidth(RIGHT_WIDTH_KEY, 380));
  useEffect(() => { try { localStorage.setItem(LEFT_WIDTH_KEY,  String(leftWidth));  } catch {} }, [leftWidth]);
  useEffect(() => { try { localStorage.setItem(RIGHT_WIDTH_KEY, String(rightWidth)); } catch {} }, [rightWidth]);

  // Container ref so the drag handler can measure available width and cap the
  // rail growth to leave at least CHAT_MIN px for the chat panel.
  const containerRef = useRef(null);
  const dragRef = useRef(null);

  const startDrag = useCallback((panel) => (e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = panel === 'left' ? leftWidth : rightWidth;
    const otherWidth = panel === 'left' ? rightWidth : leftWidth;
    const containerW = containerRef.current?.getBoundingClientRect().width || window.innerWidth;
    // Both dividers (12 px each) when right rail is open; only one otherwise.
    const dividers   = logOpen ? 24 : 12;
    const railMin    = panel === 'left' ? LEFT_MIN : RIGHT_MIN;
    const railMax    = panel === 'left' ? LEFT_MAX : RIGHT_MAX;
    // Dynamic upper bound: the rail can grow until the chat panel hits CHAT_MIN.
    const dynamicMax = Math.max(railMin, containerW - otherWidth - dividers - CHAT_MIN);
    const upperCap   = Math.min(railMax, dynamicMax);
    const lowerCap   = railMin;
    dragRef.current  = { panel, startX, startWidth, lowerCap, upperCap };

    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';

    const onMove = (ev) => {
      if (!dragRef.current) return;
      const { panel: p, startX: sx, startWidth: sw, lowerCap: lo, upperCap: hi } = dragRef.current;
      const delta = ev.clientX - sx;
      if (p === 'left') {
        setLeftWidth(Math.max(lo, Math.min(hi, sw + delta)));
      } else {
        // Right panel grows leftward → inverse delta.
        setRightWidth(Math.max(lo, Math.min(hi, sw - delta)));
      }
    };
    const onUp = () => {
      dragRef.current = null;
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [leftWidth, rightWidth, logOpen]);

  // Cross-panel hover correlation: ChatPanel sets this when the user hovers
  // a bubble; SessionLogPanel sets it on row hover. The other side dims rows
  // whose correlationId doesn't match.
  const [hoveredCorrelationId, setHoveredCorrelationId] = useState(null);

  // Aggregated cost for the current agent+room, fed by SessionLogPanel via onCostUpdate.
  const [sessionCost, setSessionCost] = useState(null); // null = no data yet
  const handleCostUpdate = useCallback((usd, tokIn, tokOut) => {
    setSessionCost({ usd, tokIn, tokOut });
  }, []);

  const selectedAgent = (agents ?? []).find(a => a.id === agentId) || null;
  const effectiveRoomId =
    (selectedAgent && createdRooms[selectedAgent.id]) ||
    selectedAgent?.dmRoomId ||
    null;

  // Reset cost totals whenever the conversation context changes.
  useEffect(() => { setSessionCost(null); }, [agentId, effectiveRoomId]);

  const handleSelect = useCallback((id) => {
    try { localStorage.setItem(LAST_AGENT_KEY, id); } catch { /* ignore */ }
    manuallyUnreadRef.current.delete(id);
    const viewed = loadLastViewed();
    viewed[id] = Date.now();
    saveLastViewed(viewed);
    navigate(`/chats/${id}`);
  }, [navigate]);

  const handleMarkAsUnread = useCallback((id) => {
    manuallyUnreadRef.current.add(id);
    const viewed = loadLastViewed();
    delete viewed[id];
    saveLastViewed(viewed);
    setAgentStatuses(prev => ({ ...prev, [id]: 'unread' }));
  }, []);

  const handleRoomCreated = useCallback((id, roomId) => {
    setCreatedRooms(prev => prev[id] === roomId ? prev : { ...prev, [id]: roomId });
  }, []);

  // If the URL points at a no-longer-existing agent, reset to /chats.
  useEffect(() => {
    if (!loading && agentId && agents && !agents.find(a => a.id === agentId)) {
      navigate('/chats', { replace: true });
    }
  }, [agentId, agents, loading, navigate]);

  // Restore last-opened agent on mount when no `:agentId` is in the URL and
  // a stored value still exists in the loaded agent list. We use `replace`
  // so the user's back button doesn't first hop to the bare `/chats`.
  useEffect(() => {
    if (loading || agentId) return;
    if (!agents || agents.length === 0) return;
    let stored = null;
    try { stored = localStorage.getItem(LAST_AGENT_KEY); } catch { /* ignore */ }
    if (stored && agents.find(a => a.id === stored)) {
      navigate(`/chats/${stored}`, { replace: true });
    }
  }, [loading, agentId, agents, navigate]);

  // Track the active agent so we can update localStorage even when the user
  // arrived via a deep link (e.g. /chats/<id> bookmarked).
  useEffect(() => {
    if (agentId) {
      try { localStorage.setItem(LAST_AGENT_KEY, agentId); } catch { /* ignore */ }
    }
  }, [agentId]);

  // Keyboard shortcut: Cmd+Shift+L (Mac) / Ctrl+Shift+L (others) toggles
  // the session log panel. Skip if focus is in a text input/textarea so we
  // don't steal the platform-level "select line" shortcut.
  useEffect(() => {
    function onKey(e) {
      if (!e.shiftKey) return;
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.key !== 'L' && e.key !== 'l') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      e.preventDefault();
      setLogOpen(o => !o);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The Shell renders <main> with 24 px padding and a 48 px header. We negate
  // the padding via negative margins so the chat occupies the full pane.
  const PAGE_HEIGHT = 'calc(100vh - var(--eb-header-height))';

  return (
    <div
      ref={containerRef}
      style={{
        display: 'flex',
        height: PAGE_HEIGHT,
        margin: 'calc(-1 * var(--eb-space-6))',
        background: 'var(--eb-bg-app)',
        overflow: 'hidden',
      }}
    >
      {/* Left rail */}
      <div style={{
        width: leftWidth,
        minWidth: leftWidth,
        height: '100%',
        background: 'var(--eb-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
      }}>
        <div style={{
          padding: 'var(--eb-space-4)',
          borderBottom: '1px solid var(--eb-border-default)',
          flexShrink: 0,
        }}>
          <h1 style={{
            fontSize: 'var(--eb-text-md)',
            fontWeight: 'var(--eb-font-semibold)',
            margin: 0,
            color: 'var(--eb-text-primary)',
          }}>
            Agents
          </h1>
          <div style={{
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            marginTop: 'var(--eb-space-1)',
          }}>
            {loading
              ? 'Loading…'
              : agents
                ? `${agents.length} agent${agents.length === 1 ? '' : 's'}`
                : ''}
          </div>
        </div>

        <div style={{ flex: 1, overflowY: 'auto' }}>
          {loading && !agents && (
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--eb-space-2)',
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              color: 'var(--eb-text-muted)',
              fontSize: 'var(--eb-text-sm)',
            }}>
              <Loader2 size={14} style={{ animation: 'spin 1s linear infinite' }} />
              Loading agents…
            </div>
          )}

          {error && (
            <div style={{
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              color: 'var(--eb-status-error)',
              fontSize: 'var(--eb-text-sm)',
            }}>
              Failed to load agents: {error}
              <button
                onClick={refetch}
                style={{
                  marginLeft: 'var(--eb-space-2)',
                  background: 'none',
                  border: 'none',
                  color: 'var(--eb-accent-primary)',
                  cursor: 'pointer',
                  fontSize: 'var(--eb-text-xs)',
                  textDecoration: 'underline',
                }}
              >
                Retry
              </button>
            </div>
          )}

          {!loading && agents && agents.length === 0 && (
            <div style={{
              padding: 'var(--eb-space-4)',
              fontSize: 'var(--eb-text-sm)',
              color: 'var(--eb-text-muted)',
              textAlign: 'center',
              lineHeight: 1.5,
            }}>
              No agents available.
              <br />
              Create one in <strong>Agent Manager</strong>.
            </div>
          )}

          {agents && agents.length > 0 && (
            <AgentList
              agents={agents}
              selectedAgentId={agentId || null}
              onSelect={handleSelect}
              onMarkAsUnread={handleMarkAsUnread}
              statuses={agentStatuses}
            />
          )}
        </div>

        {/* Local @keyframes for the loader (the chat panel ships its own copy
            but the left rail renders independently when no agent is picked). */}
        <style>{`
          @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
        `}</style>
      </div>

      <ResizeDivider onMouseDown={startDrag('left')} />

      {/* Chat panel */}
      <div style={{ flex: 1, height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        {selectedAgent ? (
          <ChatPanel
            key={selectedAgent.id}
            agent={selectedAgent}
            roomId={effectiveRoomId}
            onRoomCreated={(roomId) => handleRoomCreated(selectedAgent.id, roomId)}
            hoveredCorrelationId={hoveredCorrelationId}
            onHoverCorrelation={setHoveredCorrelationId}
            sessionCost={sessionCost}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Right rail: tabbed Session Log / Workspace browser */}
      {logOpen && (
        <>
          <ResizeDivider onMouseDown={startDrag('right')} />
          <div style={{
            width: rightWidth,
            minWidth: rightWidth,
            height: '100%',
            background: 'var(--eb-bg-app)',
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            flexShrink: 0,
          }}>
          <RightRail
            agentId={selectedAgent?.id || null}
            roomId={effectiveRoomId}
            hoveredCorrelationId={hoveredCorrelationId}
            onHoverCorrelation={setHoveredCorrelationId}
            onClose={() => setLogOpen(false)}
            onCostUpdate={handleCostUpdate}
          />
        </div>
        </>
      )}

      {/* Floating "Show log" button when the panel is hidden */}
      {!logOpen && (
        <button
          onClick={() => setLogOpen(true)}
          title="Show log panel (Cmd+Shift+L)"
          aria-label="Show log panel"
          style={{
            position: 'fixed',
            right: 'var(--eb-space-4)',
            bottom: 'var(--eb-space-4)',
            width: 36,
            height: 36,
            borderRadius: 'var(--eb-radius-full)',
            background: 'var(--eb-bg-surface)',
            color: 'var(--eb-text-secondary)',
            border: '1px solid var(--eb-border-default)',
            boxShadow: 'var(--eb-shadow-md)',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 20,
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
        >
          <PanelRightOpen size={18} />
        </button>
      )}
    </div>
  );
}

/**
 * Centered "pick an agent" card shown when no `:agentId` is in the route.
 * Mirrors the empty-state design of other admin-console pages: lucide icon,
 * primary line, secondary help text, all on a soft surface with a subtle
 * border so it doesn't feel like a 404 page.
 */
function EmptyState() {
  return (
    <div style={{
      flex: 1,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 'var(--eb-space-6)',
    }}>
      <div style={{
        background: 'var(--eb-bg-surface)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-lg)',
        padding: 'var(--eb-space-6) var(--eb-space-8)',
        maxWidth: 420,
        textAlign: 'center',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        boxShadow: 'var(--eb-shadow-sm)',
      }}>
        <div style={{
          width: 48,
          height: 48,
          borderRadius: 'var(--eb-radius-full)',
          background: 'var(--eb-accent-muted)',
          color: 'var(--eb-accent-primary)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <MessageCircle size={22} />
        </div>
        <div style={{
          fontSize: 'var(--eb-text-md)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)',
        }}>
          Pick an agent on the left to start chatting
        </div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          lineHeight: 1.5,
        }}>
          Replies stream in real time as the agent thinks.
        </div>
      </div>
    </div>
  );
}
