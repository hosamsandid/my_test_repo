import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useParams, useNavigate, useSearchParams } from 'react-router';
import { MessageCircle, Loader2, Plus, Upload, Eye, EyeOff, Users } from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { usePageActions } from '../context/PageActionsContext';
import { useAgentStatuses } from '../context/AgentStatusesContext.jsx';
import { computeAgentStatusMap } from '../context/agent-statuses';
import { AgentRosterProvider, useAgentRoster } from '../context/AgentRosterContext.jsx';
import AgentList, { buildGroups } from './agent-chat/AgentList';
import RailLifecycleHost from './agent-chat/RailLifecycleHost.jsx';
import { loadShowDisabled, saveShowDisabled, matrixAgentsUrl } from './agent-chat/rail-lifecycle.js';
import { isChatOpenable } from './agent-lifecycle/agent-lifecycle-menu.js';
import ChatPanel from './agent-chat/ChatPanel';
import RightRail from './agent-chat/RightRail';
import AgentSettingsPanel from './agent-chat/AgentSettingsPanel';
import { SessionsActiveProvider } from './agent-chat/SessionsActiveContext';
import { resolveRailWidths } from './agent-chat/rail-layout';
import { CREATE_ROUTE, emptyStatePointer } from './agent-chat/empty-state';
import { describeAgentCreateAccess } from './agent-lifecycle/agent-create-access.js';
import { resolveTeamConfigTab } from './agent-lifecycle/team-config-tabs-view.js';
import PageHelpButton from '../components/PageHelpButton';
import { AGENT_CHAT_HELP_SECTIONS } from './agent-chat/agent-chat-help-sections.js';

// Page-action header buttons (#1956). Copied from the convention the other
// #1847/#1912-migrated pages share (`Briefings.jsx`): accent for the page's
// primary create action, bordered/elevated for the secondary one, lucide icon
// left of the label, primary rightmost.
const HEADER_PRIMARY_BTN = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px',
  background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
  border: 'none', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
  cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap',
};

const HEADER_SECONDARY_BTN = {
  display: 'inline-flex', alignItems: 'center', gap: 6,
  padding: '6px 12px',
  background: 'var(--eb-bg-elevated)', color: 'var(--eb-text-secondary)',
  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
  fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit',
  cursor: 'pointer', whiteSpace: 'nowrap',
};

// A refused action is shown inert with its reason rather than hidden (AC6).
const headerBtnDisabled = (base) => ({
  ...base, cursor: 'not-allowed', opacity: 0.55,
});

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

/** Stable empty set, so the idle rail never hands its memoized rows a new one. */
const EMPTY_BUSY_IDS = new Set();

function loadFilter() {
  try {
    const raw = localStorage.getItem(FILTER_KEY);
    if (!raw) return { kind: 'all' };
    const parsed = JSON.parse(raw);
    // A stored `orchestrator` filter from before #1964 falls through to the
    // `{ kind: 'all' }` default rather than narrowing to a kind nothing builds.
    if (parsed && ['all', 'team', 'agent'].includes(parsed.kind)) {
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
 *   - the list of Matrix-enabled agents (live — polled in the background every
 *     ~5s via `AgentRosterContext`, #2311; the initial fetch still gates the
 *     loading/error UI exactly like the one-shot fetch it replaced)
 *   - which agent is selected (from `:agentId` route param)
 *   - the live `dmRoomId` for the selected agent (created lazily on first open)
 *
 * The page itself is non-scrolling — only the messages area inside ChatPanel
 * scrolls. Height is derived from `100vh - header - extra` so it fills the
 * Shell's <main> without overflowing.
 */
export default function AgentChat() {
  // Per-user opt-in to also listing disabled agents (#1928 AC6/AC7). It widens
  // the list URL, so it is read before the fetch — with the opt-in off no paused
  // agent is asked for and the chat shows exactly what it always showed. (Since
  // #1957 the URL also carries an unconditional `includeStubs=1`, which is not a
  // preference — see `matrixAgentsUrl`.)
  //
  // Lifted above `AgentRosterProvider` (#2311): the provider needs to know
  // which URL to poll, and a component cannot consume a context it renders
  // itself — see `AgentChatInner` below for the rest of the page.
  const [showDisabled, setShowDisabled] = useState(loadShowDisabled);
  useEffect(() => { saveShowDisabled(showDisabled); }, [showDisabled]);

  return (
    <AgentRosterProvider showDisabled={showDisabled} buildUrl={matrixAgentsUrl}>
      <AgentChatInner showDisabled={showDisabled} setShowDisabled={setShowDisabled} />
    </AgentRosterProvider>
  );
}

/**
 * The actual page body, split out from `AgentChat` so it can sit *inside*
 * `AgentRosterProvider` and read the shared, polled roster via
 * `useAgentRoster()` (#2311) instead of the one-shot `useApi` fetch it used
 * before. Everything below is otherwise unchanged from the original
 * component.
 */
function AgentChatInner({ showDisabled, setShowDisabled }) {
  const { agentId } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { agents, loading, error, refetch } = useAgentRoster();

  // The open lifecycle context menu: `{ target, anchor }` or null. The rail only
  // reports *that* a menu was asked for and for which row (#1928); which items
  // it holds, and every dialog and API call behind them, live in
  // `RailLifecycleHost` so the memoized rows stay free of lifecycle state.
  const [menuRequest, setMenuRequest] = useState(null);
  const handleRequestMenu = useCallback(
    (target, anchor) => setMenuRequest({ target, anchor }),
    [],
  );
  const closeMenu = useCallback(() => setMenuRequest(null), []);

  // Which rows have a lifecycle mutation in flight (#1957 AC5). The requests all
  // live in `RailLifecycleHost`, so it reports the set up here and the rail
  // renders it — a materialize clones the role's repositories and can take a
  // while, and the row it was started from must not sit there looking untouched.
  const [railBusyIds, setRailBusyIds] = useState(EMPTY_BUSY_IDS);
  // Empty→empty keeps the previous Set, so the host's initial report (and any
  // later one that changes nothing) does not hand the memoized rows a new
  // identity and re-render the whole list for no reason.
  const handleBusyIdsChange = useCallback((ids) => {
    setRailBusyIds(prev => (prev.size === 0 && ids.size === 0 ? prev : ids));
  }, []);

  // The list-level create/import actions live in the Shell's page-action header
  // like every other page's (#1956) — Agent Chat used to be the one route with
  // an empty slot, which is why they had to be invented as a rail "+" menu.
  // `Import Agent` reaches the round-trip that still lives in the lifecycle
  // host (the file input + the shared `ImportAgentForm`) through its imperative
  // handle, so there is exactly one import implementation in the chat.
  const railHostRef = useRef(null);
  const { user } = useAuth();
  const createAccess = describeAgentCreateAccess(user);

  // Local map agentId -> roomId, for rooms we created during this session
  // (overrides the persisted `dmRoomId` returned by /api/matrix/agents).
  const [createdRooms, setCreatedRooms] = useState({});

  // Keep a ref to the current agentId so the polling closure can read it
  // without becoming stale (the effect has [] deps and runs once).
  const agentIdRef = useRef(agentId);
  useEffect(() => { agentIdRef.current = agentId; }, [agentId]);

  // Same reason, for `handleOpenSettings` below (#2235): it needs to tell a
  // team target apart from an ordinary agent one, but its own `[]`-deps
  // signature (asserted by agent-settings-wiring.test.js) rules out closing
  // over the `agents` array directly.
  const agentsRef = useRef(agents);
  useEffect(() => { agentsRef.current = agents; }, [agents]);

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
    if (listFilter.kind === 'team') {
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

  // Which agent the rail's Settings tab (#1929) is for, when it is NOT the open
  // chat's. A rail menu sets it — "Team settings…" on a group header (AC5), or
  // "Settings…" on a row whose agent has no chat to open, e.g. a disabled one
  // (AC10). Cleared whenever the chat moves on, so the tab silently follows the
  // conversation again rather than stranding the user on a stale subject.
  const [settingsAgentId, setSettingsAgentId] = useState(null);
  // The team-header row click (#2213) fires `onSelect` (routes to the team,
  // changing `agentId`) and `onOpenTeamSettings` (sets this override) for the
  // SAME target in one event handler. Without this ref the `[agentId]` reset
  // effect below — written for the pre-#2213 menu-only override, where opening
  // settings never changes the route — fires right after the render that set
  // the override and unconditionally nulls it back out, so the Settings tab
  // never actually shows (#2214 code-review finding). The ref records the
  // target `handleOpenSettings` was JUST called for; the effect consumes it
  // exactly once (cleared unconditionally on every fire, matched or not, so a
  // stale value from an earlier menu-only override — set while the route was
  // unmoving — can never suppress an unrelated later reset).
  const explicitSettingsTargetRef = useRef(null);
  const handleOpenSettings = useCallback((id) => {
    if (!id) return;
    // A team's settings live on their own full-width surface now (#2235),
    // reached by being routed there — never by forcing the (retired, for a
    // team) narrow rail open. Only an ordinary agent (the disabled-agent
    // case, AC10) still uses the override + rail-open mechanism below.
    const target = (agentsRef.current ?? []).find(a => a.id === id);
    if (target?.role !== 'team') setLogOpen(true);
    setSettingsAgentId(id);
    explicitSettingsTargetRef.current = id;
    setRailTabRequest({ tab: 'settings', ts: Date.now() });
  }, []);
  const clearSettingsAgent = useCallback(() => setSettingsAgentId(null), []);
  useEffect(() => {
    const openedFor = explicitSettingsTargetRef.current;
    explicitSettingsTargetRef.current = null;
    if (openedFor === agentId) return;
    setSettingsAgentId(null);
  }, [agentId]);

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

  // Deep-link to one chat message (#2310): a `?msg=<event_id>` query param
  // means "scroll the transcript to this message and briefly highlight it".
  // Mirrors `?session=` above exactly — same cold-nav-safe wait, same
  // read-once-then-strip via `replace` (AC3), same "unknown agent → the
  // redirect effect handles it, don't consume" guard (AC6) — but the actual
  // locate/backfill/scroll/highlight work needs `messages` and the scroller,
  // which only ChatPanel has, so this effect just hands off a request object
  // (the same pattern as `resumeRequest`/`composerRefRequest`) rather than
  // doing anything itself. Independent of the session/tab handling above, so
  // a URL carrying `?msg=` together with `?session=`/`?tab=` honors all of
  // them (AC8, Q4).
  const [msgTargetRequest, setMsgTargetRequest] = useState(null);
  const consumedMsgRef = useRef(null);
  const requestedMsg = searchParams.get('msg');
  useEffect(() => {
    if (!requestedMsg || loading || !agents) return;
    if (!agents.find(a => a.id === agentId)) return;
    if (consumedMsgRef.current === requestedMsg) return;
    consumedMsgRef.current = requestedMsg;
    setMsgTargetRequest({ eventId: requestedMsg, ts: Date.now() });
    const next = new URLSearchParams(searchParams);
    next.delete('msg');
    setSearchParams(next, { replace: true });
  }, [requestedMsg, loading, agents, agentId, searchParams, setSearchParams]);

  // A disabled agent is only ever in this list because the opt-in is on (#1928
  // AC6), and it has no chat to open — the DM route rejects it with a 409. A
  // `role: 'team'` agent (#2213) never has a chat to open either — it hosts no
  // room at all. Both cases treat the route as no *chat* selection so the panel
  // never attempts `ChatPanel` against a null room.
  const routedAgent = (agents ?? []).find(a => a.id === agentId) || null;

  // #2311 D2: the roster now refreshes in the background, so the currently
  // open chat's agent can vanish (pool reap, deletion elsewhere) while the
  // user is looking at it. `seenAgentIdRef`/`lastSeenAgentRef` remember the
  // last agent object confirmed present for the CURRENT `:agentId` route, so
  // a later disappearance can be told apart from a route that never named a
  // real agent (a bad deep link, which the redirect effect below still bounces
  // to /chats exactly as before #2311).
  const seenAgentIdRef = useRef(null);
  const lastSeenAgentRef = useRef(null);
  useEffect(() => {
    if (!agents) return;
    const found = agents.find(a => a.id === agentId);
    if (found) {
      seenAgentIdRef.current = agentId;
      lastSeenAgentRef.current = found;
    }
  }, [agents, agentId]);
  const agentRemoved = !!agentId && !!agents && !routedAgent && seenAgentIdRef.current === agentId;
  // D2: keep the last known snapshot on screen instead of falling back to the
  // unrelated "pick an agent" empty state — an inline notice (rendered by
  // `ChatPanel` via `removedFromRoster`) replaces the live data instead, and
  // the transcript/room/scroll position are all untouched since `ChatPanel`
  // never remounts (same `key={selectedAgent.id}` below).
  const effectiveRoutedAgent = routedAgent || (agentRemoved ? lastSeenAgentRef.current : null);
  const selectedAgent = effectiveRoutedAgent && isChatOpenable(effectiveRoutedAgent) ? effectiveRoutedAgent : null;
  // #2235: a routed `role: 'team'` subject gets the whole area right of the
  // agent list as one full-width configuration surface — see
  // `TeamConfigSurface` below — rather than the ordinary chat + right-rail
  // split. Derived purely from the route, so every entry point (the row
  // click, the row menu's "Team settings…", a direct /chats/<teamId> URL)
  // converges on it.
  const subjectIsTeam = routedAgent?.role === 'team';
  // #2267: a team's Settings request (handleOpenSettings below) has nowhere to
  // be consumed — RightRail doesn't render for a team subject at all (#2235,
  // TeamConfigSurface takes over instead) — so it sits pending in state. Left
  // alone, selecting an unrelated individual Agent afterwards remounts
  // RightRail fresh, and its openTabRequest effect fires on that FIRST mount
  // with the still-pending `{tab:'settings'}` value, forcing that unrelated
  // agent onto Settings. Clearing it the moment the subject becomes a team
  // means there is nothing left to leak by the time any later agent mounts.
  useEffect(() => {
    if (subjectIsTeam) setRailTabRequest(null);
  }, [subjectIsTeam]);
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

  // A stable wrapper for `ChatPanel`'s `onRoomCreated` (#2311 AC8): an inline
  // arrow built fresh in JSX would give `ChatPanel`'s DM-room-creation effect
  // (`[agent, roomId, onRoomCreated]`) a new callback identity on every render
  // of this page — including a render caused only by an unrelated background
  // roster poll tick — which defeats the point of keeping `selectedAgent`'s own
  // reference stable across those ticks. Depends on `selectedAgent` itself
  // (stable across a poll tick that doesn't touch this agent, thanks to
  // `mergeRoster`'s per-row reference reuse) and the already-stable
  // `handleRoomCreated`, so it only changes identity when the selected agent
  // actually does.
  const handleChatRoomCreated = useCallback((roomId) => {
    if (selectedAgent) handleRoomCreated(selectedAgent.id, roomId);
  }, [selectedAgent, handleRoomCreated]);

  // If the URL points at a no-longer-existing agent, reset to /chats — UNLESS
  // that agent was confirmed present earlier under this same route (#2311 D2):
  // that case means the roster's background poll just removed the chat the
  // user has open, and D2 wants the chat to stay put with an inline notice,
  // not an auto-navigate away. A route that never named a real agent (bad
  // deep link, or the initial load for one) still bounces to /chats exactly
  // as before.
  useEffect(() => {
    if (!loading && agentId && agents && !agents.find(a => a.id === agentId)) {
      if (seenAgentIdRef.current === agentId) return;
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
  //
  // A team subject has no rail of its own to toggle (#2235 AC13/AC14) — the
  // shortcut must have no effect while one is open and must not touch the
  // persisted preference, which is why this reads a ref rather than gating
  // on `subjectIsTeam` in the effect's own deps (that would tear the
  // listener down and rebuild it on every team ⇄ member switch).
  const subjectIsTeamRef = useRef(subjectIsTeam);
  useEffect(() => { subjectIsTeamRef.current = subjectIsTeam; }, [subjectIsTeam]);
  useEffect(() => {
    function onKey(e) {
      if (!e.shiftKey) return;
      const isAccel = e.metaKey || e.ctrlKey;
      if (!isAccel) return;
      if (e.key !== 'L' && e.key !== 'l') return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target?.isContentEditable) return;
      if (subjectIsTeamRef.current) return;
      e.preventDefault();
      setLogOpen(o => !o);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // The Shell renders <main> with 24 px padding and a 48 px header. We negate
  // the padding via negative margins so the chat occupies the full pane.
  const PAGE_HEIGHT = 'calc(100vh - var(--eb-header-height))';

  const headerActions = usePageActions(
    <div style={{ display: 'flex', gap: 'var(--eb-space-2)', alignItems: 'center' }}>
      <button
        onClick={() => railHostRef.current?.openImportPicker()}
        disabled={!createAccess.allowed}
        title={createAccess.hint || undefined}
        style={createAccess.allowed ? HEADER_SECONDARY_BTN : headerBtnDisabled(HEADER_SECONDARY_BTN)}
      >
        <Upload size={14} /> Import Agent
      </button>
      <button
        onClick={() => navigate(CREATE_ROUTE)}
        disabled={!createAccess.allowed}
        title={createAccess.hint || undefined}
        style={createAccess.allowed ? HEADER_PRIMARY_BTN : headerBtnDisabled(HEADER_PRIMARY_BTN)}
      >
        <Plus size={15} /> New Agent
      </button>
    </div>
  );

  return (
    <>
    {headerActions}
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
        {/*
          Rail header. The former "Agents (N)" heading was dropped (#1921): the
          context is obvious and the count added nothing. The row still never
          renders while the list is loading, but it survives an *empty* list: it
          carries the disabled-agents opt-in — which is how someone whose only
          agents are paused finds them — and the rail's "?". The filter alone
          stays conditional on there being something to filter. (The create "+"
          it carried since #1928 moved to the page header in #1956.)
        */}
        {agents && (
          <div style={{
            padding: 'var(--eb-space-3) var(--eb-space-4)',
            borderBottom: '1px solid var(--eb-border-default)',
            flexShrink: 0,
            display: 'flex',
            alignItems: 'center',
            gap: 'var(--eb-space-2)',
          }}>
            {agents.length > 0 && (
              <div style={{ flex: 1, minWidth: 0 }}>
                <FilterSelect
                  agents={agents}
                  filter={listFilter}
                  onChange={setListFilter}
                />
              </div>
            )}
            <RailHeaderToggle
              on={showDisabled}
              onToggle={() => setShowDisabled(v => !v)}
            />
            {/* #1972: the left rail's own "?" — grouping, reordering, the
                disabled opt-in and the row menu are a surface of their own, so
                it lands on the agent-list chapter rather than the top of the
                topic. The row sits above an empty list too, so the "?" is
                reachable before there is any agent to explain. (The create "+"
                that used to sit here moved to the page header in #1956.) */}
            <PageHelpButton
              label="What the agent list can do"
              size={14}
              section={AGENT_CHAT_HELP_SECTIONS.agentList}
              style={{ padding: 2, flexShrink: 0 }}
            />
          </div>
        )}

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
              {/* A text pointer, not a second button (#1956 AC7): the create
                  action now lives in the page header, and the house pattern is
                  that an empty state names it rather than competing with it. */}
              <span>{emptyStatePointer().lead}</span>
              <span>{emptyStatePointer().hint}</span>
            </div>
          )}

          {agents && agents.length > 0 && (
            <AgentList
              agents={agents}
              selectedAgentId={agentId || null}
              onSelect={handleSelect}
              statuses={agentStatuses}
              filter={listFilter}
              showDisabled={showDisabled}
              busyIds={railBusyIds}
              onRequestMenu={handleRequestMenu}
              onOpenTeamSettings={handleOpenSettings}
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

      {subjectIsTeam ? (
        /* #2235: a routed team gets the WHOLE area right of the agent list —
           there is no separate chat column and no separate right rail, no
           divider and no collapse/width control of its own (AC1/AC13). The
           left list, its own divider and the SessionsActiveProvider above are
           unaffected either way. */
        <TeamConfigSurface team={routedAgent} onAgentConfigChanged={refetch} />
      ) : (
        <>
          {/* Chat panel */}
          <div style={{ flex: 1, height: '100%', minWidth: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
            {selectedAgent ? (
              <ChatPanel
                key={selectedAgent.id}
                agent={selectedAgent}
                roomId={effectiveRoomId}
                onRoomCreated={handleChatRoomCreated}
                hoveredCorrelationId={hoveredCorrelationId}
                onHoverCorrelation={setHoveredCorrelationId}
                sessionCost={sessionCost}
                contextFill={contextFill}
                onWorkspaceChanged={handleWorkspaceChanged}
                onTodoBoundary={handleTodoBoundary}
                onOpenKnowledge={handleOpenKnowledge}
                resumeRequest={resumeRequest}
                msgTargetRequest={msgTargetRequest}
                insertRefRequest={composerRefRequest}
                removedFromRoster={agentRemoved}
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
              // Settings (#1929). `canManage` rides on the list payload (#1928) —
              // the same boundary the PUT enforces — so the tab is hidden rather
              // than offered and refused.
              agentCanManage={selectedAgent ? selectedAgent.canManage !== false : true}
              settingsAgentId={settingsAgentId}
              chatAgentName={selectedAgent?.displayName || ''}
              onClearSettingsAgent={clearSettingsAgent}
              onAgentConfigChanged={refetch}
            />
          </div>
        </>
      )}

      </SessionsActiveProvider>

      {/* Lifecycle quick actions (#1928): the menu the rail asked for, plus
          every dialog and request behind it. Mounted outside the rail column so
          its portaled menu and side panels are never clipped by the column's
          overflow, and so a mutation can refresh the list the rail renders. */}
      <RailLifecycleHost
        ref={railHostRef}
        request={menuRequest}
        onClose={closeMenu}
        chatAgents={agents || []}
        onChanged={refetch}
        onOpenSettings={handleOpenSettings}
        onMarkAsUnread={handleMarkAsUnread}
        statuses={agentStatuses}
        listFilter={listFilter}
        onBusyIdsChange={handleBusyIdsChange}
      />
    </div>
    </>
  );
}

/**
 * The rail header's disabled-agents opt-in (#1928 AC6/AC7).
 *
 * A two-state icon toggle rather than a checkbox: the header is a single tight
 * row next to the filter, and the state is legible at a glance from the icon
 * alone. `aria-pressed` carries the state for assistive tech, since the eye is
 * decorative.
 */
function RailHeaderToggle({ on, onToggle }) {
  const label = on ? 'Hide disabled agents' : 'Show disabled agents';
  return (
    <button
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-pressed={on}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: 26,
        height: 26,
        flexShrink: 0,
        background: on ? 'var(--eb-bg-elevated)' : 'none',
        border: `1px solid ${on ? 'var(--eb-border-default)' : 'transparent'}`,
        borderRadius: 'var(--eb-radius-sm)',
        color: on ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), background var(--eb-transition-fast)',
      }}
    >
      {on ? <Eye size={14} /> : <EyeOff size={14} />}
    </button>
  );
}

/**
 * Native <select> bound to the agent-list filter spec. Lists every visible
 * team (with member count), then every agent that belongs to none
 * ("Individual agents" — team members are already reachable via their group
 * entry), so the user can narrow down to a whole team or a single standalone
 * chat.
 */
function FilterSelect({ agents, filter, onChange }) {
  const { groups, singles } = buildGroups(agents);
  const teams = groups.filter(g => g.kind === 'team');

  // "Individual agents" = agents with no team membership at all — `singles`
  // already excludes anyone captured by a `groups` entry (see `buildGroups` in
  // agent-list-model.js), so team members must not be re-added here.
  const individualAgents = singles;

  const value =
    filter.kind === 'team'  ? `team:${filter.id}`  :
    filter.kind === 'agent' ? `agent:${filter.id}` :
    'all';

  function handleChange(e) {
    const v = e.target.value;
    if (v === 'all') return onChange({ kind: 'all' });
    const [kind, ...rest] = v.split(':');
    const id = rest.join(':');
    if (kind === 'team' || kind === 'agent') {
      return onChange({ kind, id });
    }
  }

  return (
    <select
      value={value}
      onChange={handleChange}
      title="Filter agent list"
      style={{
        // No top margin: since #1921 removed the "Agents (N)" heading above it,
        // the select is the row's only child and its own padding does the work.
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

/**
 * The full-width surface for a routed `role: 'team'` agent (#2235, supersedes
 * #2213's `TeamSelectedState` placeholder). A team hosts no conversation of
 * its own, so — unlike an ordinary agent — its whole configuration gets the
 * entire area right of the agent list rather than sharing it with a chat
 * column and a collapsible rail: there is nothing here for a chat pane to
 * show, and #2216 had already reduced the rail to Settings alone for a team,
 * so retiring the split is a layout consequence, not a new capability.
 *
 * Reuses `AgentSettingsPanel` unchanged (AC6 — no capability reachable
 * before this is lost) inside a centered, width-capped column so the same
 * form that used to live in a ~380px rail doesn't stretch into unreadably
 * long lines on a wide monitor (AC10), and no collapse or width control is
 * offered — the left agent list's own divider is the only way to resize this
 * area (AC13/AC14).
 */
function TeamConfigSurface({ team, onAgentConfigChanged }) {
  const canManage = team?.canManage !== false;
  // #2236 AC7: the selected tab of the flat configuration row is addressable
  // by `?tab=<name>` — owned here (above `AgentSettingsPanel`'s own
  // post-save/draft remounts) so it survives a save and round-trips through a
  // bookmark or a shared link.
  const [searchParams, setSearchParams] = useSearchParams();
  const teamConfigTab = resolveTeamConfigTab(searchParams.get('tab'));
  const setTeamConfigTab = useCallback((id) => {
    const next = new URLSearchParams(searchParams);
    next.set('tab', id);
    setSearchParams(next, { replace: true });
  }, [searchParams, setSearchParams]);
  return (
    <div style={{
      flex: 1,
      minWidth: 0,
      height: '100%',
      display: 'flex',
      overflow: 'hidden',
      background: 'var(--eb-bg-app)',
    }}>
      <div style={{ width: '100%', height: '100%', minWidth: 0 }}>
        {canManage ? (
          <AgentSettingsPanel
            agentId={team.id}
            active
            onSaved={onAgentConfigChanged}
            teamConfigTab={teamConfigTab}
            onTeamConfigTabChange={setTeamConfigTab}
          />
        ) : (
          <TeamReadOnlyNotice team={team} />
        )}
      </div>
    </div>
  );
}

/**
 * Shown in place of the edit form for a team the caller may see (it is in
 * their agent list) but not manage (AC9) — the pre-#2235 rail hid the
 * Settings tab entirely in this case, offering nothing at all; this keeps
 * that same "nothing editable" guarantee while still landing on the team's
 * own surface, the way every other entry point now does.
 */
function TeamReadOnlyNotice({ team }) {
  return (
    <div style={{
      height: '100%',
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
          <Users size={22} />
        </div>
        <div style={{
          fontSize: 'var(--eb-text-md)',
          fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)',
        }}>
          {team?.displayName || team?.id}
        </div>
        <div style={{
          fontSize: 'var(--eb-text-sm)',
          color: 'var(--eb-text-muted)',
          lineHeight: 1.5,
        }}>
          You can see this team but do not have rights to manage its configuration.
        </div>
      </div>
    </div>
  );
}
