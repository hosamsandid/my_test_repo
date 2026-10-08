import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronRight, ChevronLeft, FolderTree, CalendarClock, Activity, MoreHorizontal, Brain, Target, Settings, Github } from 'lucide-react';
import SessionsPanel from './SessionsPanel';
import WorkspaceBrowser from './WorkspaceBrowser';
import TriggersPanel from './TriggersPanel';
import EventsPanel from './EventsPanel';
import OutcomesPanel from './OutcomesPanel';
import AgentKnowledgePanel from './AgentKnowledgePanel';
import AgentSettingsPanel from './AgentSettingsPanel';
import { fitTabCount } from './rail-layout';
import { useSessionsActive } from './SessionsActiveContext';
import { activeSessionCount } from './sessions-active';
import { settingsSubject } from './agent-settings-view';
import { hasGithubEventTrigger } from './agent-events-view.js';
import { apiCall } from '../../hooks/useApi';
import { parseTabMap, tabForAgent, withAgentTab, DEFAULT_RAIL_TAB, displayTab, tabRequestAppliesToOwnAgent } from './rail-tab-memory';

// #2267: was a single global "last active tab overall" key. Replaced with a
// map keyed by agent id (below) so each agent restores its own last tab
// rather than sharing one global value with every other agent and team.
const TAB_MAP_KEY = 'agentChat.rightRailTabByAgent';

function loadTabMap() {
  try {
    return parseTabMap(localStorage.getItem(TAB_MAP_KEY));
  } catch {
    return {};
  }
}

// The whole rail toggles with Cmd+Shift+L on macOS / Ctrl+Shift+L elsewhere
// (handler in AgentChat.jsx). Detect the platform once so the visible hint and
// the chevron tooltips name the modifier the user's keyboard actually has.
const IS_MAC = typeof navigator !== 'undefined'
  && /Mac|iP(?:hone|ad|od)/i.test(navigator.platform || navigator.userAgent || '');
const TOGGLE_SHORTCUT = `${IS_MAC ? 'Cmd' : 'Ctrl'}+Shift+L`;

const TAB_KEYS = ['sessions', 'workspace', 'triggers', 'events', 'outcomes', 'knowledge', 'settings'];

/**
 * Tabbed right rail for the agent chat page.
 *
 * Tabs:
 *   - "Sessions"  — one sub-tab per active Claude session; the selected one
 *     shows that session's log + an in-tab Stop (merged Log+Sessions, #543)
 *   - "Workspace" — read-only file tree of /workspace/agents/<id>/
 *   - "Triggers"  — the agent's triggers.json
 *   - "Events"    — the GitHub events that reached this agent's triggers, with
 *     "Fire again" on a dropped wake (#2525). Only for an agent with at least
 *     one GitHub-event trigger, hence `showEvents` gating the tab.
 *   - "Outcomes"  — read-only view of the agent's outcome options (#963); the
 *     outputs counterpart of Triggers, so it sits next to it. Team members only
 *     (an outcome is a hand-off), hence `agentTeamId` gating the tab.
 *   - "Knowledge" — the agent's knowledge base
 *   - "Settings"  — the agent's configuration (#1929), rendering the Agents
 *     page's own edit form. Normally for the open chat's agent; the rail can
 *     point it at another one (a team, a disabled agent). Hidden for a caller
 *     who may not manage the agent, hence `agentCanManage` gating the tab.
 *
 * A `role: 'team'` subject never reaches this component (#2235): it hosts no
 * chat and therefore none of Sessions/Workspace/Triggers/Outcomes/Knowledge,
 * so its configuration is rendered on its own full-width surface by
 * `AgentChat.jsx` instead — see `TeamConfigSurface` there.
 *
 * The active tab is persisted per agent in localStorage (#2267) so it survives
 * reloads AND so switching agents restores each agent's own last tab rather
 * than sharing one global "last active tab" across all of them; an old
 * stored 'log' value silently falls back to the default 'sessions' tab (it is
 * no longer a member of TAB_KEYS), which is where Log used to live.
 *
 * The rail is independently resizable, so the tab strip measures itself: tabs
 * always render icon + label, and whichever ones no longer fit spill into an
 * overflow "⋯" menu. This adapts to any rail width and any number of tabs
 * (rather than a single hard-coded icons-only breakpoint).
 *
 * Collapsing follows the left navigation sidebar's pattern (#905): the owner
 * animates the rail's width down to `--eb-sidebar-collapsed` and passes
 * `collapsed`, at which point the rail renders a slim icon-only strip — an
 * inline expand chevron plus the tab icons, each of which re-expands straight
 * to its tab. The component stays mounted across a collapse, so the active tab
 * survives the cycle; the tab bodies do not render while collapsed, so a
 * hidden rail costs no polling. Because it stays mounted, the tab-strip
 * measurement has to be re-run per collapse/expand rather than relying on a
 * remount — see the `collapsed` dependency below (#924).
 */
export default function RightRail({
  agentId, agentTeamId = null, roomId, hoveredCorrelationId, onHoverCorrelation, onClose, onOpen, onCostUpdate, onContextUpdate,
  todoCloseSignal = 0, workspaceRefreshKey = 0, openTabRequest = null,
  onResumeSession, sessionSelectRequest = null, collapsed = false, onReferenceInChat = null,
  agentCanManage = true, settingsAgentId = null, chatAgentName = '',
  onClearSettingsAgent = null, onAgentConfigChanged = null,
}) {
  // Outcomes describe hand-offs to teammates, so the tab is meaningless for a
  // standalone agent (#963 AC1).
  const showOutcomes = !!agentTeamId;
  // Settings (#1929) is normally the open chat's agent, but the rail can point
  // it at another one — a team (whose settings have no chat, AC5) or a disabled
  // agent (which has no chat at all, AC10). Hidden outright for a caller the
  // server would refuse (AC8), rather than offered and then 403'd.
  const settings = settingsSubject({
    chatAgentId: agentId,
    chatCanManage: agentCanManage,
    overrideId: settingsAgentId,
  });
  const showSettings = settings.visible;
  // Events (#2525 AC1): only for an agent with a GitHub-event trigger. `null`
  // while the triggers load, so the fallback below never throws away a
  // persisted Events tab before we know. Keyed by agent id so a switch never
  // reads the PREVIOUS agent's answer (the rail is not remounted on a switch).
  const [eventTriggerCheck, setEventTriggerCheck] = useState({ agentId: null, has: null });
  const hasEventTrigger = eventTriggerCheck.agentId === agentId ? eventTriggerCheck.has : null;
  const showEvents = hasEventTrigger === true;
  const [tab, setTab] = useState(() => tabForAgent(loadTabMap(), agentId, TAB_KEYS) || DEFAULT_RAIL_TAB);

  // Restore-then-persist, in that order, for the same reason they're one
  // effect rather than two: the rail is NOT remounted for an ordinary
  // agent-to-agent switch (only its `agentId` prop changes), so on a subject
  // change this has to overwrite `tab` with the NEW agent's own remembered
  // value before anything persists — otherwise a separate "persist on any
  // [agentId, tab] change" effect would, on the very first render of the new
  // agent, write the OLD agent's still-current `tab` into the new agent's
  // slot (a same-commit race, not just a display flicker), permanently
  // seeding it with a tab that was never actually active for it. Falls back
  // like the initializer does when the new agent has no history yet (AC3).
  const prevAgentIdRef = useRef(agentId);
  useEffect(() => {
    if (agentId !== prevAgentIdRef.current) {
      prevAgentIdRef.current = agentId;
      setTab(tabForAgent(loadTabMap(), agentId, TAB_KEYS) || DEFAULT_RAIL_TAB);
      return;
    }
    if (!agentId) return;
    try { localStorage.setItem(TAB_MAP_KEY, JSON.stringify(withAgentTab(loadTabMap(), agentId, tab))); } catch { /* ignore */ }
  }, [agentId, tab]);

  // External tab request (e.g. clicking the "N learned" badge in the chat
  // header switches to the Knowledge tab). `ts` disambiguates repeat clicks.
  // A Settings request aimed at an override agent (the row-menu "Settings…" on
  // some other/disabled agent, or a team header click) is the one request that
  // must NOT touch the open agent's own tab (#2426 AC3): applying it here would
  // flip `tab` to 'settings' and persist that into the open agent's slot, the
  // cross-contamination this ticket removes. The override drives the *displayed*
  // tab through `effectiveTab` instead. `settings.override` is read from the
  // same render that consumed the request, so a later override-clear (which does
  // not re-fire this effect — deps are `[openTabRequest]`) can't retroactively
  // apply the stale request.
  useEffect(() => {
    if (!openTabRequest || !TAB_KEYS.includes(openTabRequest.tab)) return;
    if (!tabRequestAppliesToOwnAgent(openTabRequest.tab, settings.override)) return;
    setTab(openTabRequest.tab);
  }, [openTabRequest]); // eslint-disable-line react-hooks/exhaustive-deps

  // The persisted tab outlives the agent selection, so switching from a team
  // member to a standalone agent can leave 'outcomes' active with no such tab
  // rendered — fall back to the default rather than showing an empty body.
  // Gated on `agentId`: until a selection resolves, `agentTeamId` is null for
  // "not loaded yet" as much as for "not in a team", and reacting to that would
  // throw away a persisted Outcomes tab on every page load.
  useEffect(() => {
    if (!agentId) return;
    if (hasEventTrigger === false && tab === 'events') setTab(DEFAULT_RAIL_TAB);
    if (!showOutcomes && tab === 'outcomes') setTab(DEFAULT_RAIL_TAB);
    if (!showSettings && tab === 'settings') setTab(DEFAULT_RAIL_TAB);
  }, [agentId, hasEventTrigger, showOutcomes, showSettings, tab]);

  // Whether the Events tab applies. Re-checked on agent switch and whenever the
  // tab changes (so adding a GitHub-event trigger on the Triggers tab surfaces
  // the Events tab the moment the user leaves it). A failed read hides the tab.
  useEffect(() => {
    if (!agentId) return undefined;
    let cancelled = false;
    apiCall('GET', `/api/agents/${encodeURIComponent(agentId)}/triggers`)
      .then((triggers) => { if (!cancelled) setEventTriggerCheck({ agentId, has: hasGithubEventTrigger(triggers) }); })
      .catch(() => { if (!cancelled) setEventTriggerCheck({ agentId, has: false }); });
    return () => { cancelled = true; };
  }, [agentId, tab]);

  // Session COUNT for the "Sessions" tab badge — regardless of which tab is
  // visible, and even while the rail is collapsed (the icon dot). Derived from
  // the shared active-sessions poll (#1678) rather than a rail-local timer, so
  // the badge, the SessionsPanel list and the DiffView running-probe all read
  // the same data from a single poller.
  const { sessions } = useSessionsActive();
  const sessionCount = activeSessionCount(sessions);

  // `Icon` is the component (not a rendered element) because the tab strip and
  // the collapsed icon rail render it at different sizes — 13 inline next to a
  // label, 20 standalone to match the left nav's icon-only items.
  const tabs = useMemo(() => [
    { key: 'sessions', Icon: Activity, label: 'Sessions', hint: 'Live and past runs — each session\'s log, cost and context usage', badge: sessionCount > 0 ? sessionCount : null },
    { key: 'workspace', Icon: FolderTree, label: 'Workspace', hint: 'Read-only file tree of this agent\'s workspace' },
    { key: 'triggers', Icon: CalendarClock, label: 'Triggers', hint: 'Schedules, one-shot and loop triggers that start runs' },
    ...(showEvents ? [{ key: 'events', Icon: Github, label: 'Events', hint: 'GitHub events that reached this agent\'s triggers — delivered or dropped, and why' }] : []),
    ...(showOutcomes ? [{ key: 'outcomes', Icon: Target, label: 'Outcomes', hint: 'Hand-off outcomes and labels this team member can emit' }] : []),
    { key: 'knowledge', Icon: Brain, label: 'Knowledge', hint: 'The team knowledge this agent can read and add to' },
    ...(showSettings ? [{ key: 'settings', Icon: Settings, label: 'Settings', hint: 'This agent\'s configuration — prompt, skills, plugins, context folders, repositories' }] : []),
  ], [sessionCount, showEvents, showOutcomes, showSettings]);

  // The tab actually shown. Normally the open agent's own `tab`, but a Settings
  // override for a DIFFERENT agent (see the `openTabRequest` effect) is a
  // transient view that drives the display without ever becoming the open
  // agent's own — persisted — tab (#2426). Clearing the override reverts the
  // display straight to `tab`.
  const effectiveTab = displayTab(tab, settings.override);

  // Choosing a tab is also the gesture that ends an override view: once the
  // user picks any tab, they are acting on the open agent again, so drop the
  // override so `effectiveTab` follows `tab` from here on (including picking the
  // Settings tab itself, which then means the OPEN agent's own Settings, AC4).
  const selectTab = (key) => {
    if (settings.override && onClearSettingsAgent) onClearSettingsAgent();
    setTab(key);
  };

  // --- Overflow measurement ---------------------------------------------
  // We render a hidden, full-width copy of the tab row to learn each tab's
  // natural width, then fit as many as the strip allows (`fitTabCount`).
  // Whatever doesn't fit spills into the overflow menu. Re-measured on resize
  // and whenever a tab's width can change (e.g. the Sessions badge appears).
  const stripRef = useRef(null);
  const measureRef = useRef(null);
  const closeRef = useRef(null);
  const [visibleCount, setVisibleCount] = useState(tabs.length);

  // `collapsed` MUST stay in this dependency list. The rail no longer unmounts
  // when it is hidden (#905) — it early-returns the collapsed strip instead, so
  // the measured nodes come and go while the component (and therefore this
  // effect) lives on. Without `collapsed` here the effect would bail out once
  // on a rail that loads collapsed (`agentChat.logOpen` is persisted) and never
  // run again, leaving `visibleCount` stale: every tab renders, the strip clips
  // them, and no overflow toggle appears because nothing spilled (#924). It
  // also has to re-observe on expand — the strip is a *new* DOM node each time.
  useLayoutEffect(() => {
    const strip = stripRef.current;
    const measure = measureRef.current;
    if (collapsed || !strip || !measure || typeof ResizeObserver === 'undefined') return undefined;

    const recompute = () => {
      setVisibleCount(fitTabCount({
        stripWidth: strip.clientWidth,
        closeWidth: closeRef.current ? closeRef.current.offsetWidth : 0,
        tabWidths: Array.from(measure.children).map((el) => el.getBoundingClientRect().width),
      }));
    };

    recompute();
    // Also carries the expand animation: the strip is still at the collapsed
    // width when this runs, and the observer converges as the width transition
    // advances.
    const ro = new ResizeObserver(recompute);
    ro.observe(strip);
    return () => ro.disconnect();
  }, [tabs, collapsed]);

  const visibleTabs = tabs.slice(0, visibleCount);
  const overflowTabs = tabs.slice(visibleCount);
  const activeInOverflow = overflowTabs.some((t) => t.key === effectiveTab);

  // --- Overflow dropdown open/close --------------------------------------
  // The dropdown is rendered through a portal (see IconButton for the same
  // pattern) because the tab strip needs `overflow: hidden` for its own
  // measurement row, which would otherwise clip an in-flow absolutely
  // positioned dropdown regardless of the open-state toggling correctly.
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuCoords, setMenuCoords] = useState(null);
  const menuWrapRef = useRef(null);
  const menuToggleRef = useRef(null);
  const menuContentRef = useRef(null);

  const positionMenu = () => {
    const btn = menuToggleRef.current;
    if (!btn) return;
    const rect = btn.getBoundingClientRect();
    setMenuCoords({ top: rect.bottom + 2, right: window.innerWidth - rect.right });
  };

  useEffect(() => {
    if (!menuOpen) return undefined;
    positionMenu();
    const onDocClick = (e) => {
      const insideToggle = menuWrapRef.current && menuWrapRef.current.contains(e.target);
      const insideMenu = menuContentRef.current && menuContentRef.current.contains(e.target);
      if (!insideToggle && !insideMenu) setMenuOpen(false);
    };
    const onKey = (e) => { if (e.key === 'Escape') setMenuOpen(false); };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', positionMenu);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', positionMenu);
    };
  }, [menuOpen]);
  // Close the menu if everything fits again after a resize.
  useEffect(() => { if (overflowTabs.length === 0) setMenuOpen(false); }, [overflowTabs.length]);
  // An overflow dropdown must not outlive a collapse.
  useEffect(() => { if (collapsed) setMenuOpen(false); }, [collapsed]);

  if (collapsed) {
    return (
      <CollapsedRail
        tabs={tabs}
        activeTab={effectiveTab}
        onExpandTo={(key) => { selectTab(key); if (onOpen) onOpen(); }}
        onExpand={onOpen}
      />
    );
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      background: 'var(--eb-bg-app)',
    }}>
      {/* Tab strip */}
      <div ref={stripRef} style={{
        position: 'relative',
        height: 'var(--eb-header-height)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'stretch',
        borderBottom: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        overflow: 'hidden',
      }}>
        {visibleTabs.map((t) => (
          <TabButton
            key={t.key}
            Icon={t.Icon}
            label={t.label}
            hint={t.hint}
            badge={t.badge ?? null}
            active={effectiveTab === t.key}
            onClick={() => selectTab(t.key)}
          />
        ))}

        {overflowTabs.length > 0 && (
          <div ref={menuWrapRef} style={{ position: 'relative', display: 'flex', alignItems: 'stretch' }}>
            <button
              ref={menuToggleRef}
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              title="More tabs"
              aria-label="More tabs"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '0 var(--eb-space-3)',
                background: 'none',
                border: 'none',
                borderBottom: `2px solid ${activeInOverflow ? 'var(--eb-accent-primary)' : 'transparent'}`,
                color: (menuOpen || activeInOverflow) ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
                cursor: 'pointer',
                transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
              }}
              onMouseEnter={e => { if (!menuOpen && !activeInOverflow) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
              onMouseLeave={e => { if (!menuOpen && !activeInOverflow) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
            >
              <MoreHorizontal size={16} />
            </button>
            {menuOpen && menuCoords && createPortal(
              <div
                ref={menuContentRef}
                role="menu"
                style={{
                  position: 'fixed',
                  top: menuCoords.top,
                  right: menuCoords.right,
                  minWidth: 160,
                  background: 'var(--eb-bg-surface)',
                  border: '1px solid var(--eb-border-default)',
                  borderRadius: 'var(--eb-radius-md)',
                  boxShadow: 'var(--eb-shadow-md)',
                  padding: 'var(--eb-space-1)',
                  zIndex: 1000,
                }}
              >
                {overflowTabs.map((t) => (
                  <MenuItem
                    key={t.key}
                    Icon={t.Icon}
                    label={t.label}
                    hint={t.hint}
                    badge={t.badge ?? null}
                    active={effectiveTab === t.key}
                    onClick={() => { selectTab(t.key); setMenuOpen(false); }}
                  />
                ))}
              </div>,
              document.body,
            )}
          </div>
        )}

        <div style={{ flex: 1 }} />
        <button
          ref={closeRef}
          onClick={onClose}
          title={`Collapse panel (${TOGGLE_SHORTCUT})`}
          aria-label="Collapse panel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-muted)',
            cursor: 'pointer',
            padding: '0 var(--eb-space-3)',
            display: 'flex',
            alignItems: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          {/* Mirror of the left nav's collapse chevron: the rail sits on the
              right, so "toward the edge" points right. */}
          <ChevronRight size={16} />
        </button>

        {/* Hidden measurement row: full-width copy of all tabs so we can learn
            their natural widths without affecting layout. */}
        <div ref={measureRef} aria-hidden="true" style={{
          position: 'absolute',
          top: 0,
          left: 0,
          display: 'flex',
          visibility: 'hidden',
          pointerEvents: 'none',
          whiteSpace: 'nowrap',
        }}>
          {tabs.map((t) => (
            <TabButton key={t.key} Icon={t.Icon} label={t.label} badge={t.badge ?? null} active={false} onClick={() => {}} />
          ))}
        </div>
      </div>

      {/* Body — keep both subtrees mounted via display:none so the user
          doesn't lose log scroll position / expanded folders when toggling. */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <div style={{ display: effectiveTab === 'sessions' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <SessionsPanel
            agentId={agentId}
            roomId={roomId}
            active={effectiveTab === 'sessions'}
            hoveredCorrelationId={hoveredCorrelationId}
            onHoverCorrelation={onHoverCorrelation}
            onCostUpdate={onCostUpdate}
            onContextUpdate={onContextUpdate}
            todoCloseSignal={todoCloseSignal}
            onResumeSession={onResumeSession}
            selectRequest={sessionSelectRequest}
          />
        </div>
        <div style={{ display: effectiveTab === 'workspace' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <WorkspaceBrowser agentId={agentId} active={effectiveTab === 'workspace'} refreshKey={workspaceRefreshKey} onReference={onReferenceInChat} />
        </div>
        <div style={{ display: effectiveTab === 'triggers' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          <TriggersPanel agentId={agentId} active={effectiveTab === 'triggers'} focusRequest={openTabRequest && openTabRequest.tab === 'triggers' && openTabRequest.triggerId ? openTabRequest : null} />
        </div>
        {showEvents && (
          <div style={{ display: effectiveTab === 'events' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <EventsPanel agentId={agentId} active={effectiveTab === 'events'} canManage={agentCanManage} />
          </div>
        )}
        {showOutcomes && (
          <div style={{ display: effectiveTab === 'outcomes' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <OutcomesPanel agentId={agentId} active={effectiveTab === 'outcomes'} />
          </div>
        )}
        <div style={{ display: effectiveTab === 'knowledge' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
          {/* #1922: no external refresh signal any more (Save & Learn was its
              only feeder) — the panel reloads when the tab becomes active. */}
          <AgentKnowledgePanel agentId={agentId} active={effectiveTab === 'knowledge'} />
        </div>
        {showSettings && (
          <div style={{ display: effectiveTab === 'settings' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
            <AgentSettingsPanel
              agentId={settings.agentId}
              active={effectiveTab === 'settings'}
              chatAgentId={agentId}
              chatAgentName={chatAgentName}
              onBackToChatAgent={settings.override ? onClearSettingsAgent : null}
              onSaved={onAgentConfigChanged}
            />
          </div>
        )}
      </div>

    </div>
  );
}

/**
 * The collapsed rail — the right-hand mirror of the left navigation sidebar's
 * icon-only rail (`Shell.jsx`): an inline expand chevron at the top, then the
 * tab icons stacked vertically, each with a native tooltip and centred in the
 * strip. The active tab is marked with the accent bar on the *content* side
 * (borderRight here vs. borderLeft in the left nav), and clicking any icon
 * expands the rail straight to that tab.
 */
function CollapsedRail({ tabs, activeTab, onExpandTo, onExpand }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100%',
      minWidth: 0,
      overflow: 'hidden',
      background: 'var(--eb-bg-surface)',
      borderLeft: '1px solid var(--eb-border-default)',
    }}>
      {/* Expand chevron — same slot the tab strip's collapse button occupies. */}
      <div style={{
        height: 'var(--eb-header-height)',
        flexShrink: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        borderBottom: '1px solid var(--eb-border-default)',
      }}>
        <button
          type="button"
          onClick={onExpand}
          title={`Expand panel (${TOGGLE_SHORTCUT})`}
          aria-label="Expand panel"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--eb-text-secondary)',
            cursor: 'pointer',
            padding: 'var(--eb-space-1)',
            display: 'flex',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
        >
          {/* Mirror of the left nav's expand chevron: points toward the content. */}
          <ChevronLeft size={16} />
        </button>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', padding: 'var(--eb-space-2) 0' }}>
        {tabs.map(({ key, Icon, label, hint, badge }) => {
          const active = activeTab === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => onExpandTo(key)}
              title={hint ? `${label} — ${hint}` : label}
              aria-label={label}
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: '100%',
                padding: 'var(--eb-space-2) 0',
                background: active ? 'var(--eb-bg-selected)' : 'transparent',
                border: 'none',
                borderRight: active ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
                color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'background var(--eb-transition-fast)',
              }}
              onMouseEnter={e => { if (!active) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
              onMouseLeave={e => { if (!active) e.currentTarget.style.background = 'transparent'; }}
            >
              {/* Counts don't fit the icon rail, so a badge becomes a dot — the
                  same treatment the left nav gives its collapsed chat badge. */}
              <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
                <Icon size={20} />
                {badge !== null && badge !== undefined && (
                  <span style={{
                    position: 'absolute',
                    top: -2,
                    right: -2,
                    width: 7,
                    height: 7,
                    borderRadius: 'var(--eb-radius-full)',
                    background: 'var(--eb-accent-primary)',
                    border: '1.5px solid var(--eb-bg-surface)',
                  }} />
                )}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function TabButton({ Icon, label, hint, active, onClick, badge = null }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={hint || label}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '0 var(--eb-space-3)',
        background: 'none',
        border: 'none',
        borderBottom: `2px solid ${active ? 'var(--eb-accent-primary)' : 'transparent'}`,
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-muted)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
        transition: 'color var(--eb-transition-fast), border-color var(--eb-transition-fast)',
      }}
      onMouseEnter={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { if (!active) e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      <Icon size={13} />
      {label}
      {badge !== null && badge !== undefined && <Badge value={badge} />}
    </button>
  );
}

function MenuItem({ Icon, label, hint, active, onClick, badge = null }) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      title={hint || label}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-2)',
        width: '100%',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        background: active ? 'var(--eb-bg-hover)' : 'none',
        border: 'none',
        borderRadius: 'var(--eb-radius-sm)',
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        fontSize: 'var(--eb-text-sm)',
        fontWeight: active ? 'var(--eb-font-semibold)' : 'var(--eb-font-medium)',
        fontFamily: 'inherit',
        textAlign: 'left',
        whiteSpace: 'nowrap',
        cursor: 'pointer',
      }}
      onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
      onMouseLeave={e => { e.currentTarget.style.background = active ? 'var(--eb-bg-hover)' : 'none'; }}
    >
      <Icon size={13} />
      <span style={{ flex: 1 }}>{label}</span>
      {badge !== null && badge !== undefined && <Badge value={badge} />}
    </button>
  );
}

function Badge({ value }) {
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 16,
      height: 16,
      padding: '0 5px',
      borderRadius: 'var(--eb-radius-full)',
      background: 'var(--eb-accent-primary)',
      color: 'var(--eb-bg-app)',
      fontSize: 10,
      fontWeight: 'var(--eb-font-semibold)',
      lineHeight: 1,
    }}>
      {value}
    </span>
  );
}
