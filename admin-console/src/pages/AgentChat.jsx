import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams, Link } from 'react-router';
import { MessageCircle, Loader2 } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { useAgentStatuses } from '../context/AgentStatusesContext.jsx';
import { computeAgentStatusMap } from '../context/agent-statuses';
import AgentList, { buildGroups } from './agent-chat/AgentList';
import ChatPanel from './agent-chat/ChatPanel';
import RightRail from './agent-chat/RightRail';
import { SessionsActiveProvider } from './agent-chat/SessionsActiveContext';
import { resolveRailWidths } from './agent-chat/rail-layout';
import { emptyStateCta } from './agent-chat/empty-state';

const LEFT_WIDTH_KEY  = 'agentChat.leftWidth';
const RIGHT_WIDTH_KEY = 'agentChat.rightWidth';
const LEFT_MIN  = 160;
const LEFT_MAX  = 800;
const RIGHT_MIN = 200;
const RIGHT_MAX = 1600;
const CHAT_MIN  = 280;

function loadPanelWidth(key, fallback) {
  try {
    const v = parseInt(localStorage.getItem(key), 10);
    return Number.isFinite(v) ? v : fallback;
  } catch { return fallback; }
}

// `disabled` keeps the divider in the layout (so the flanking panes don't jump
// by 12 px) while making it inert — used for the right divider while the rail
// is collapsed to its icon strip, which has no width to drag.
function ResizeDivider({ onMouseDown, disabled = false }) {
  const [hovered, setHovered] = React.useState(false);
  const showGrab = hovered && !disabled;
  return (
    <div
      onMouseDown={disabled ? undefined : onMouseDown}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      title={disabled ? undefined : 'Drag to resize'}
      style={{
        width: 12,
        flexShrink: 0,
        cursor: disabled ? 'default' : 'col-resize',
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
        width: showGrab ? 3 : 1,
        transform: 'translateX(-50%)',
        background: showGrab ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)',
        transition: 'background 0.15s, width 0.15s',
        pointerEvents: 'none',
      }} />
    </div>
  );
}

const LAST_AGENT_KEY = 'agentChat.lastAgentId';
const LAST_VIEWED_KEY = 'agentChat.lastViewed';
const FILTER_KEY = 'agentChat.listFilter';

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return { kind: 'all' };
    const parsed = JSON.parse(raw);
    if (parsed && ['all', 'team', 'orchestrator', 'agent'].includes(parsed.kind)) {
      return parsed;
    }
  } catch { /* ignore */ }
  return { kind: 'all' };
}
function saveFilter(filter) {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(filter)); } catch { /* ignore */ }
}

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
  const [searchParams, setSearchParams] = useSearchParams();
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
  // ('busy'|'unread'|'active'|'idle'|'disabled'|'offline'), derived from the
  // shared agent-status poll (#1677) rather than a page-owned interval.
  const statuses = useAgentStatuses();
  const [agentStatuses, setAgentStatuses] = useState({});
  useEffect(() => {
    // Always mark the currently open agent as "viewed" before deriving statuses
    // so it never flips to "unread" while the user is looking at it. Exception:
    // skip agents the user explicitly marked as unread.
    const currentId = agentIdRef.current;
    if (currentId && !manuallyUnreadRef.current.has(currentId)) {
      const viewed = loadLastViewed();
      viewed[currentId] = Date.now();
      saveLastViewed(viewed);
    }
    setAgentStatuses(computeAgentStatusMap(statuses, loadLastViewed()));
  }, [statuses]);

  // Sidebar filter: All | a specific team | a specific agent. Persisted in
  // localStorage so the user's narrowed view survives reloads.
  const [listFilter, setListFilter] = useState(loadFilter);
  useEffect(() => { saveFilter(listFilter); }, [listFilter]);

  // Drop the filter if its target disappeared (group deleted, agent removed).
  useEffect(() => {
    if (!agents) return;
    if (listFilter.kind === 'agent' && !agents.find(a => a.id === listFilter.id)) {
      setListFilter({ kind: 'all' });
    }
    if (listFilter.kind === 'team' || listFilter.kind === 'orchestrator') {
      const { groups } = buildGroups(agents);
      const stillThere = groups.some(
        g => g.kind === listFilter.kind && g.id === listFilter.id,
      );
      if (!stillThere) setListFilter({ kind: 'all' });
    }
  }, [agents, listFilter]);

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

  // Live container width (ResizeObserver) so the effective panel widths can
  // be re-clamped on window resize — not just at drag time. Without this, a
  // stored width that no longer fits (smaller window, sidebar expanded)
  // pushes the rails out of view.
  const [containerW, setContainerW] = useState(null);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width;
      if (w) setContainerW(w);
    });
    ro.observe(el);
    setContainerW(el.getBoundingClientRect().width || null);
    return () => ro.disconnect();
  }, []);

  // Effective (rendered) widths: the stored preference, clamped so that
  // left + rail + dividers + CHAT_MIN never exceeds the container. Both
  // dividers are always in the layout now that the rail collapses to an icon
  // strip rather than unmounting. See rail-layout.js for the give-way order.
  const dividersW = 24;
  const { left: effLeftWidth, right: effRightWidth } = resolveRailWidths({
    containerW,
    leftWidth,
    rightWidth,
    collapsed: !logOpen,
    chatMin: CHAT_MIN,
    leftMin: LEFT_MIN,
    rightMin: RIGHT_MIN,
    dividersW,
  });

  // True while a divider is being dragged. The rail carries a width transition
  // for the collapse/expand animation, which would otherwise make the drag lag
  // ~200 ms behind the pointer — so the transition is suspended mid-drag.
  const [resizing, setResizing] = useState(false);

  const startDrag = useCallback((panel) => (e) => {
    e.preventDefault();
    const startX     = e.clientX;
    const startWidth = panel === 'left' ? effLeftWidth : effRightWidth;
    const otherWidth = panel === 'left' ? effRightWidth : effLeftWidth;
    const containerNow = containerRef.current?.getBoundingClientRect().width || window.innerWidth;
    // Both dividers (12 px each) are always in the layout.
    const dividers   = 24;
    const railMin    = panel === 'left' ? LEFT_MIN : RIGHT_MIN;
    const railMax    = panel === 'left' ? LEFT_MAX : RIGHT_MAX;
    // Dynamic upper bound: the rail can grow until the chat panel hits CHAT_MIN.
    const dynamicMax = Math.max(railMin, containerNow - otherWidth - dividers - CHAT_MIN);
    const upperCap   = Math.min(railMax, dynamicMax);
    const lowerCap   = railMin;
    dragRef.current  = { panel, startX, startWidth, lowerCap, upperCap };

    setResizing(true);
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
      setResizing(false);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup',   onUp);
  }, [effLeftWidth, effRightWidth]);

  // Cross-panel hover correlation: ChatPanel sets this when the user hovers
  // a bubble; SessionLogPanel sets it on row hover. The other side dims rows
  // whose correlationId doesn't match.
  const [hoveredCorrelationId, setHoveredCorrelationId] = useState(null);

  // Bumped by ChatPanel after a chat attachment is uploaded into the agent's
  // workspace, so the Workspace tab in the right rail refreshes its tree
  // automatically instead of forcing a manual refresh.
  const [workspaceRefreshKey, setWorkspaceRefreshKey] = useState(0);
  const handleWorkspaceChanged = useCallback(() => {
    setWorkspaceRefreshKey(k => k + 1);
  }, []);

  // #1922: the Knowledge-tab refresh signal is gone with the Save & Learn
  // button — that manual prompt was its only feeder. The tab still reloads
  // whenever it becomes active, which is the path a user takes to look at it.

  // Aggregated cost for the current agent+room, fed by SessionLogPanel via onCostUpdate.
  const [sessionCost, setSessionCost] = useState(null); // null = no data yet
  // `breakdown` (#1718) carries the four raw token classes for the header info
  // popover; `tokIn`/`tokOut` stay the cache-summed totals used elsewhere.
  const handleCostUpdate = useCallback((usd, tokIn, tokOut, breakdown) => {
    setSessionCost({ usd, tokIn, tokOut, breakdown: breakdown || null });
  }, []);

  // Last completed request's input tokens + model, fed by SessionLogPanel via
  // onContextUpdate — drives the context-window fill indicator (#471). Unlike
  // sessionCost this is NOT cumulative.
  const [contextFill, setContextFill] = useState(null); // null = no data yet
  const handleContextUpdate = useCallback((ctx) => {
    setContextFill(ctx);
  }, []);

  // Bumped by ChatPanel whenever a session boundary occurs — a new message
  // sent, "Reset Session" clicked, or a trigger-started run's first message
  // arriving — so SessionLogPanel can dismiss a stale pinned To-Do window
  // from a previous session even before any new TodoWrite call lands (#273).
  const [todoCloseSignal, setTodoCloseSignal] = useState(0);
  const handleTodoBoundary = useCallback(() => setTodoCloseSignal(s => s + 1), []);

  // Clicking the "N learned" badge in the chat header opens the right rail on
  // its Knowledge tab. `ts` makes repeat clicks re-fire the effect in RightRail.
  const [railTabRequest, setRailTabRequest] = useState(null);
  const handleOpenKnowledge = useCallback(() => {
    setLogOpen(true);
    setRailTabRequest({ tab: 'knowledge', ts: Date.now() });
  }, []);

  // "Reference in chat" (#1699): the workspace browser (RightRail) asks to splice
  // a `@<workspace-relative-path>` token into the composer (ChatPanel). The two are
  // siblings, so lift the request here and hand it down — the same request-object
  // (`{ ref, ts }`, `ts` re-fires on repeat clicks) pattern as railTabRequest /
  // resumeRequest, just flowing the opposite way to `workspaceRefreshKey`.
  const [composerRefRequest, setComposerRefRequest] = useState(null);
  const handleReferenceInChat = useCallback((ref) => {
    if (!ref) return;
    setComposerRefRequest({ ref, ts: Date.now() });
  }, []);

  // Resuming a finished session (#574) lives in the Sessions tab (RightRail) but
  // must set the room pointer + send the predefined message from ChatPanel — so
  // route it through here, mirroring railTabRequest. `ts` re-fires the effect on
  // repeat activations. ChatPanel owns the pointer PUT + message send.
  const [resumeRequest, setResumeRequest] = useState(null);
  const handleResumeSession = useCallback((sessionId) => {
    if (!sessionId) return;
    setResumeRequest({ sessionId, ts: Date.now() });
  }, []);

  // Deep-link from the GitHub Event Log (#642): a `?session=<correlationId>`
  // query param means "open the Sessions tab and preselect the session this
  // delivered event triggered". Consumed once agents have loaded and the target
  // agent exists, then the param is cleared so a reload doesn't re-fire it.
  // Cold-nav safe (AC7): the effect waits for the async agent list. SessionsPanel
  // owns the active-vs-finished match + the graceful "not found" notice (AC6).
  const [sessionSelectRequest, setSessionSelectRequest] = useState(null);
  const consumedSessionRef = useRef(null);
  const requestedSession = searchParams.get('session');
  useEffect(() => {
    if (!requestedSession || loading || !agents) return;
    // Unknown agent → the redirect effect below handles it; don't consume here.
    if (!agents.find(a => a.id === agentId)) return;
    if (consumedSessionRef.current === requestedSession) return;
    consumedSessionRef.current = requestedSession;
    setLogOpen(true);
    setRailTabRequest({ tab: 'sessions', ts: Date.now() });
    setSessionSelectRequest({ correlationId: requestedSession, ts: Date.now() });
    // Strip the param (keep any others) so the deep-link doesn't persist.
    const next = new URLSearchParams(searchParams);
    next.delete('session');
    setSearchParams(next, { replace: true });
  }, [requestedSession, loading, agents, agentId, searchParams, setSearchParams]);

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
        width: effLeftWidth,
        minWidth: effLeftWidth,
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
          <h2 style={{
            fontSize: 'var(--eb-text-md)',
            fontWeight: 'var(--eb-font-semibold)',
            margin: 0,
            color: 'var(--eb-text-primary)',
          }}>
            {loading || !agents ? 'Agents' : `Agents (${agents.length})`}
          </h2>
          {agents && agents.length > 0 && (
            <FilterSelect
              agents={agents}
              filter={listFilter}
              onChange={setListFilter}
            />
          )}
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
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 'var(--eb-space-3)',
            }}>
              <span>No agents yet.</span>
              <Link
                to={emptyStateCta().to}
                style={{
                  display: 'block', width: '100%', boxSizing: 'border-box',
                  padding: '8px 12px', borderRadius: 'var(--eb-radius-md)',
                  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                  fontWeight: 600, textDecoration: 'none',
                }}
              >
                {emptyStateCta().label}
              </Link>
            </div>
          )}

          {agents && agents.length > 0 && (
            <AgentList
              agents={agents}
              selectedAgentId={agentId || null}
              onSelect={handleSelect}
              onMarkAsUnread={handleMarkAsUnread}
              statuses={agentStatuses}
              filter={listFilter}
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

      {/* One shared poll of /api/agents/:id/sessions/active (#1678, extended
          in #1852 to also cover ChatPanel). Originally scoped only to RightRail;
          now wraps the entire chat+rail block so ChatPanel can read active
          trigger sessions and show the "working…" indicator during trigger-
          initiated runs (AC1–3). The poll cadence and provider semantics are
          unchanged; useSessionsActive() returns a safe inert default when used
          outside the provider, so any consumer not inside this tree is unharmed. */}
      <SessionsActiveProvider agentId={selectedAgent?.id || null}>

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
            contextFill={contextFill}
            onWorkspaceChanged={handleWorkspaceChanged}
            onTodoBoundary={handleTodoBoundary}
            onOpenKnowledge={handleOpenKnowledge}
            resumeRequest={resumeRequest}
            insertRefRequest={composerRefRequest}
          />
        ) : (
          <EmptyState />
        )}
      </div>

      {/* Right rail: tabbed Session Log / Workspace browser.
          Always mounted — collapsing animates its width down to the same slim
          icon rail the left navigation sidebar uses (#905) instead of
          unmounting it behind a floating re-open button, so the chat panel
          reflows smoothly and the active tab survives the cycle. */}
      <ResizeDivider onMouseDown={startDrag('right')} disabled={!logOpen} />
      <div style={{
        width: logOpen ? effRightWidth : 'var(--eb-sidebar-collapsed)',
        minWidth: logOpen ? effRightWidth : 'var(--eb-sidebar-collapsed)',
        height: '100%',
        background: 'var(--eb-bg-app)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        flexShrink: 0,
        transition: resizing
          ? 'none'
          : 'width var(--eb-transition-normal), min-width var(--eb-transition-normal)',
      }}>
        <RightRail
          agentId={selectedAgent?.id || null}
          // Outcomes are team hand-offs, so that tab only applies to a team
          // member (#963 AC1). `/api/matrix/agents` already carries the
          // membership, so the rail needs no extra fetch to decide.
          agentTeamId={selectedAgent?.parentTeamId || null}
          roomId={effectiveRoomId}
          hoveredCorrelationId={hoveredCorrelationId}
          onHoverCorrelation={setHoveredCorrelationId}
          collapsed={!logOpen}
          onClose={() => setLogOpen(false)}
          onOpen={() => setLogOpen(true)}
          onCostUpdate={handleCostUpdate}
          onContextUpdate={handleContextUpdate}
          todoCloseSignal={todoCloseSignal}
          workspaceRefreshKey={workspaceRefreshKey}
          openTabRequest={railTabRequest}
          onResumeSession={handleResumeSession}
          sessionSelectRequest={sessionSelectRequest}
          onReferenceInChat={handleReferenceInChat}
        />
      </div>

      </SessionsActiveProvider>
    </div>
  );
}

/**
 * Native <select> bound to the agent-list filter spec. Lists every visible
 * team (with member count), every orchestrator, then every agent that
 * belongs to neither ("Individual agents" — team/orchestrator members are
 * already reachable via their group entry), so the user can narrow down to
 * a whole team, an orchestrator, or a single standalone chat.
 */
function FilterSelect({ agents, filter, onChange }) {
  const { groups, singles } = buildGroups(agents);
  const teams         = groups.filter(g => g.kind === 'team');
  const orchestrators = groups.filter(g => g.kind === 'orchestrator');

  // "Individual agents" = agents with no team/orchestrator membership at
  // all — `singles` already excludes anyone captured by a `groups` entry
  // (see `buildGroups` in AgentList.jsx), so team/orchestrator members must
  // not be re-added here.
  const individualAgents = singles;

  const value =
    filter.kind === 'team'         ? `team:${filter.id}`         :
    filter.kind === 'orchestrator' ? `orchestrator:${filter.id}` :
    filter.kind === 'agent'        ? `agent:${filter.id}`        :
    'all';

  function handleChange(e) {
    const v = e.target.value;
    if (v === 'all') return onChange({ kind: 'all' });
    const [kind, ...rest] = v.split(':');
    const id = rest.join(':');
    if (kind === 'team' || kind === 'orchestrator' || kind === 'agent') {
      return onChange({ kind, id });
    }
  }

  return (
    <select
      value={value}
      onChange={handleChange}
      title="Filter agent list"
      style={{
        marginTop: 'var(--eb-space-2)',
        width: '100%',
        padding: '4px 6px',
        fontSize: 'var(--eb-text-xs)',
        background: 'var(--eb-bg-app)',
        color: 'var(--eb-text-primary)',
        border: '1px solid var(--eb-border-default)',
        borderRadius: 'var(--eb-radius-sm)',
        fontFamily: 'inherit',
        cursor: 'pointer',
      }}
    >
      <option value="all">All agents</option>

      {teams.length > 0 && (
        <optgroup label="Teams">
          {teams.map(t => (
            <option key={t.id} value={`team:${t.id}`}>
              {t.displayName} ({t.children.length + (t.header ? 1 : 0)})
            </option>
          ))}
        </optgroup>
      )}

      {orchestrators.length > 0 && (
        <optgroup label="Orchestrators">
          {orchestrators.map(o => (
            <option key={o.id} value={`orchestrator:${o.id}`}>
              {o.displayName} ({o.children.length + (o.header ? 1 : 0)})
            </option>
          ))}
        </optgroup>
      )}

      {individualAgents.length > 0 && (
        <optgroup label="Individual agents">
          {individualAgents.map(a => (
            <option key={a.id} value={`agent:${a.id}`}>
              {a.displayName || a.id}
            </option>
          ))}
        </optgroup>
      )}
    </select>
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
