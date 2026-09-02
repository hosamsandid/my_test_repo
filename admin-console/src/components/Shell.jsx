import React, { useState, useEffect, useMemo } from 'react';
import { useNavigate, useLocation } from 'react-router';
import {
  Users, Zap, Sparkles, Server,
  ChevronLeft, ChevronRight, ChevronDown,
  Boxes, Key, KeyRound, MessageCircle, Github, Layers, GitBranch,
  Rocket, Users2, Wand2, Building2, Brain, History, Wrench, UserCog, BarChart3, Compass, Puzzle, Plus, HelpCircle,
} from 'lucide-react';
import { useAuth } from '../auth/AuthContext';
import { useAgentStatuses } from '../context/AgentStatusesContext.jsx';
import { computeChatCounts } from '../context/agent-statuses';
import { canAccessCredentialPages } from '../pages/credential-scope-view';
import {
  filterItems, filterSections, activeGroupKey, mergeCollapsed,
  mostSpecificActivePath,
} from './nav-model';
import {
  PLUGINS_CHANGED_EVENT, buildPluginNav, pluginsNeedingScopes,
} from './plugin-nav';
import BrandMark from './BrandMark';
import AccountMenu from './AccountMenu';
import SettingsModal from './SettingsModal';
import TranscriptionOverlay from './TranscriptionOverlay';
import HelperChatPanel from './HelperChatPanel';
import { useHelperChat } from '../context/HelperChatContext';
import { useModelSelection } from '../context/ModelSelectionContext';
import { breadcrumbFor } from './breadcrumbs';
import { PageActionsContext } from '../context/PageActionsContext';
import { formatVersionLabel } from './version-info';
import { formatCommitTimestamp } from './version-info';

const LAST_VIEWED_KEY = 'agentChat.lastViewed';
// Per-user accordion state for the sidebar groups (#1595). Namespaced under
// `nav.` (this is the Shell nav, not the Agent-Chat sidebar's `agentChat.`
// keys); suffixed with the username like assistModel.<username> / flows.lastSelected.<username>.
const NAV_GROUPS_KEY_BASE = 'nav.collapsedGroups';
// The group open on a first-ever load (the daily agent-building entry point).
const DEFAULT_EXPANDED_GROUP = 'agent-setup';

function navGroupsKey(username) {
  return `${NAV_GROUPS_KEY_BASE}.${username || 'default'}`;
}

function loadCollapsedGroups(username) {
  try { return JSON.parse(localStorage.getItem(navGroupsKey(username)) || '{}'); }
  catch { return {}; }
}
const COMMIT_TIME_LABEL = formatCommitTimestamp(import.meta.env.VITE_GIT_COMMIT_TIME, import.meta.env.VITE_GIT_DIRTY);

function loadLastViewed() {
  try { return JSON.parse(localStorage.getItem(LAST_VIEWED_KEY) || '{}'); }
  catch { return {}; }
}

function NavBadge({ count, color }) {
  if (!count) return null;
  return (
    <span style={{
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      minWidth: 16,
      height: 16,
      borderRadius: 'var(--eb-radius-full)',
      background: color,
      color: 'var(--eb-bg-app)',
      fontSize: 10,
      fontWeight: 'var(--eb-font-semibold)',
      lineHeight: 1,
      padding: '0 4px',
      flexShrink: 0,
    }}>
      {count > 99 ? '99+' : count}
    </span>
  );
}

// A clickable accordion header for a collapsible nav group (#1595). Renders the
// group's uppercase micro-label plus a chevron reflecting expanded state.
function GroupHeader({ label, expanded, onToggle }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={expanded}
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 'var(--eb-space-2)',
        width: '100%',
        padding: 'var(--eb-space-1) var(--eb-space-4)',
        background: 'none',
        border: 'none',
        cursor: 'pointer',
        fontFamily: 'inherit',
        fontSize: 'var(--eb-text-xs)',
        fontWeight: 'var(--eb-font-medium)',
        color: 'var(--eb-text-muted)',
        textTransform: 'uppercase',
        letterSpacing: '0.05em',
        textAlign: 'left',
      }}
      onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
      onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
    >
      <span>{label}</span>
      {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
    </button>
  );
}

// Sidebar information architecture, re-cut by user task (#1595). Two tiers:
//   • NAV_TOP     — ungrouped, primary/daily (Agent Chat, with its badges).
//   • NAV_GROUPS  — collapsible accordions in workflow order (key = accordion +
//                   persistence id; `section` = header label). Help is the final
//                   group; the dynamic Plugins group is inserted just before it.
// Role gating (`adminOnly` / `credAdmin`) is unchanged from the old flat NAV.
// Dynamically-appended UI-plugin entries (incl. the Patterns Catalog, now a
// plugin) are added at runtime below — see `pluginSection`.
const NAV_TOP = [
  { path: '/chats',           label: 'Agent Chat',           Icon: MessageCircle },
];

const NAV_GROUPS = [
  { key: 'agent-setup', section: 'Agent Setup', items: [
    // The former separate Single Agent + Agent Team Wizard creation entries were
    // removed here (#1665, AC8/AC10): the persistent "+ Create" control above the
    // nav is now the single front door. Those pages stay reachable as launcher
    // targets and via their existing deep links (/quickstart, /team-setup).
    { path: '/agents',       label: 'Agents',              Icon: Layers },
    { path: '/flows',        label: 'Flows',               Icon: GitBranch },
    { path: '/role-templates', label: 'Agent Templates',   Icon: UserCog, adminOnly: true },
    { path: '/skills',       label: 'Skills',              Icon: Zap },
    { path: '/knowledge',    label: 'Knowledge',           Icon: Brain },
  ]},
  // Ordered by a typical setup flow: pick a Model Provider first, then the
  // credentials (SSH keys / GitHub tokens / personal), then MCP servers (an env
  // may reference them), then build a Working Environment — and finally the
  // GitHub Event Log, which only makes sense once an environment exists.
  { key: 'connections', section: 'Connections', items: [
    { path: '/models',        label: 'Model Providers',      Icon: Sparkles, credAdmin: true },
    { path: '/ssh-keys',      label: 'SSH Keys',             Icon: Key,      credAdmin: true },
    { path: '/github-tokens', label: 'GitHub Tokens',        Icon: Github,   credAdmin: true },
    // My Credentials (#1568) — personal credential self-service, visible to every
    // authenticated human (no credAdmin gate).
    { path: '/my-credentials', label: 'My Credentials',      Icon: KeyRound },
    { path: '/mcp',           label: 'MCP Servers',          Icon: Server,   adminOnly: true },
    { path: '/environments',  label: 'Working Environments', Icon: Boxes },
    { path: '/github-events', label: 'GitHub Event Log',     Icon: History },
  ]},
  { key: 'administration', section: 'Administration', items: [
    { path: '/users',            label: 'Users',            Icon: UserCog,   adminOnly: true, subtitle: 'Human user accounts' },
    { path: '/teams',            label: 'Access & Users',   Icon: Building2, subtitle: 'Human members & access' },
    { path: '/token-usage',      label: 'Token Usage',      Icon: BarChart3, adminOnly: true },
    { path: '/plugins',          label: 'Plugins',          Icon: Puzzle,    adminOnly: true },
    { path: '/maintenance-mode', label: 'Maintenance Mode', Icon: Wrench,    adminOnly: true },
  ]},
  // Help is a normal collapsible section at the tail of the nav — part of the
  // scrolling accordion, not a pinned bottom cluster. The dynamic Plugins group
  // is inserted just before it at runtime so Help stays the final section.
  { key: 'help', section: 'Help', items: [
    { path: '/getting-started', label: 'Getting Started', Icon: Compass },
  ]},
];

const NAV_GROUP_KEYS = NAV_GROUPS.map(g => g.key);

// The dynamic UI-plugin section is a first-class collapsible group too (#1595
// follow-up): its key must live in the collapse map so it can be expanded/
// collapsed and persisted like the static groups, even though its items are
// resolved at runtime. It is appended after the static groups.
const PLUGINS_GROUP_KEY = 'plugins';
const ALL_GROUP_KEYS = [...NAV_GROUP_KEYS, PLUGINS_GROUP_KEY];

export default function Shell({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  // DOM node of the page-actions slot in the header; pages portal into it.
  const [pageActionsSlot, setPageActionsSlot] = useState(null);
  // User Settings modal (#1802) — opened from the header account menu.
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Optional deep-link section for the Settings modal: the assist-error nudge
  // (#1805) opens it straight on Model; a plain account-menu open passes null
  // and lands on the default first section.
  const [settingsSection, setSettingsSection] = useState(null);
  const { registerOpenSettings } = useModelSelection();
  const navigate = useNavigate();
  const location = useLocation();
  const { user, logout } = useAuth();
  // Helper Chat (#1735): the header Help button toggles the app-level panel.
  const { isOpen: helpOpen, toggle: toggleHelp } = useHelperChat();
  // Nav badge counts, derived from the shared agent-status poll (#1677) instead
  // of a Shell-owned interval — one /api/agents/statuses request now feeds every
  // subscribing surface.
  const statuses = useAgentStatuses();
  const chatCounts = useMemo(() => computeChatCounts(statuses, loadLastViewed()), [statuses]);

  // Register how the assist-error nudge surfaces the (now modal-hosted) model
  // picker: open Settings deep-linked to Model so setPickerOpen(true) has a
  // mounted component to act on (#1805 error-nudge fix).
  useEffect(() => registerOpenSettings(() => {
    setSettingsSection('model');
    setSettingsOpen(true);
  }), [registerOpenSettings]);

  const sidebarWidth = collapsed ? 'var(--eb-sidebar-collapsed)' : 'var(--eb-sidebar-width)';

  // Hide admin-only nav entries (Skills, MCP, Maintenance Mode, …) from
  // non-System-Admins (#584 AC8). The credential pages (SSH Keys, GitHub Tokens,
  // #798; Model Providers, #800) use a looser `credAdmin` gate: visible to
  // System Admins AND any Team Admin, so a team can self-serve its credentials
  // and model providers. Backend route guards (App.jsx) and the scoped API back
  // this up — defence-in-depth, not the only enforcement. Gating is unchanged by
  // the #1595 re-grouping; a group or bottom cluster left empty renders no header.
  const canSeeCreds = canAccessCredentialPages(user);
  const gate = { admin: !!user?.admin, canSeeCreds };
  const topItems = filterItems(NAV_TOP, gate);
  const groups = filterSections(NAV_GROUPS, gate);

  // Dynamic nav entries for UI-bearing plugins that are installed AND either
  // granted to a scope the caller can see (Network Plan epic #1554, Phase 2) or
  // declared globally visible (#1599 — `ui.global`, shown to every authenticated
  // user regardless of any grant). Unlike the admin-only Plugins registry entry,
  // these are visible to ordinary users; the console proxy + server re-enforce
  // access.
  //
  // Discovery is session-scoped (#1679): it ran once per mount, NOT on every
  // navigation. Keying this on `location.pathname` refetched GET /api/plugins
  // plus the N+1 GET /api/plugins/:id/scopes fan-out on every route change. The
  // set only changes on install/uninstall or a grant edit, so it re-discovers
  // once on mount and then only when a caller fires PLUGINS_CHANGED_EVENT (see
  // Plugins install/uninstall + the Agents plugin grant), so a revoked grant
  // still drops its entry without polling on navigation.
  const [uiPlugins, setUiPlugins] = useState([]);
  useEffect(() => {
    let mounted = true;
    // Guard against out-of-order resolutions: only the newest run may write.
    let latest = 0;
    const load = async () => {
      const runId = ++latest;
      try {
        const r = await fetch('/api/plugins');
        if (!r.ok) return;
        const body = await r.json();
        const installed = body.installed || [];
        // Fetch each non-global plugin's scopes once and cache the result, so
        // the nav is derived from a single pass rather than a per-navigation
        // fan-out.
        const scopesById = {};
        for (const id of pluginsNeedingScopes(installed)) {
          try {
            const sr = await fetch(`/api/plugins/${encodeURIComponent(id)}/scopes`);
            if (!sr.ok) continue;
            const sb = await sr.json();
            if (Array.isArray(sb.scopes)) scopesById[id] = sb.scopes;
          } catch { /* skip a plugin we cannot resolve scopes for */ }
        }
        if (mounted && runId === latest) setUiPlugins(buildPluginNav(installed, scopesById));
      } catch { /* orchestrator/plugins unavailable — no dynamic entries */ }
    };
    load();
    const onChanged = () => load();
    window.addEventListener(PLUGINS_CHANGED_EVENT, onChanged);
    return () => { mounted = false; window.removeEventListener(PLUGINS_CHANGED_EVENT, onChanged); };
  }, []);

  // UI-plugin entries are a collapsible accordion group like the static ones
  // (#1595 AC12 + follow-up): appended after the built-in groups, but with the
  // same GroupHeader / collapse / persistence behaviour so it can be folded away
  // and never blows up the sidebar when many plugins are installed. The Patterns
  // Catalog is one of these now that it ships as a plugin rather than a built-in.
  const pluginSection = uiPlugins.length
    ? {
        key: PLUGINS_GROUP_KEY,
        section: 'Plugins',
        items: uiPlugins.map(p => ({ path: `/plugins/${p.id}/view`, label: p.title, Icon: Puzzle })),
      }
    : null;

  // The full accordion list = static groups + the dynamic plugins group (when
  // any UI plugins resolve), inserted just before the trailing Help group so Help
  // stays the final nav section. Drives both active-group auto-expand and rendering.
  const allGroups = (() => {
    if (!pluginSection) return groups;
    const helpIdx = groups.findIndex(g => g.key === 'help');
    if (helpIdx === -1) return [...groups, pluginSection];
    return [...groups.slice(0, helpIdx), pluginSection, ...groups.slice(helpIdx)];
  })();

  // ── Collapsible group state (#1595) ──────────────────────────────────
  // Which group holds the active route (auto-expanded on load / deep-link /
  // refresh — AC8); null when the route lives in the top or a bottom cluster.
  const activeGroup = useMemo(
    () => activeGroupKey(allGroups, location.pathname),
    [allGroups, location.pathname],
  );

  // The single most specific active nav path across every tier (top row + all
  // accordion groups). Item highlighting keys off an exact match to this so an
  // overlapping prefix — e.g. the Connections /plugins registry item under a
  // /plugins/:id/view plugin route — never lights up alongside the real target
  // (#1595 follow-up). null when no nav item matches the current route.
  const activePath = useMemo(() => {
    const allPaths = [
      ...topItems.map(i => i.path),
      ...allGroups.flatMap(g => g.items.map(i => i.path)),
    ];
    return mostSpecificActivePath(allPaths, location.pathname);
  }, [topItems, allGroups, location.pathname]);

  // Per-user collapse map, reconciled against the current group keys so a future
  // group addition/removal degrades gracefully. `true` === collapsed.
  const [collapsedGroups, setCollapsedGroups] = useState(
    () => mergeCollapsed(loadCollapsedGroups(user?.username), ALL_GROUP_KEYS, DEFAULT_EXPANDED_GROUP),
  );
  useEffect(() => {
    try { localStorage.setItem(navGroupsKey(user?.username), JSON.stringify(collapsedGroups)); }
    catch { /* storage unavailable — non-fatal */ }
  }, [collapsedGroups, user?.username]);

  // Auto-expand the group containing the active route on mount / route change.
  // Keyed on activeGroup only (not the collapse map): navigating *into* a
  // collapsed group opens it, but the user may re-collapse it afterwards without
  // it snapping back until they navigate into it again.
  useEffect(() => {
    if (activeGroup) {
      setCollapsedGroups(prev => (prev[activeGroup] ? { ...prev, [activeGroup]: false } : prev));
    }
  }, [activeGroup]);

  const toggleGroup = (key) => setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }));

  // Render one nav item button (shared by the top row and every accordion group,
  // including the dynamic plugin section). Behaviour/styling unchanged from the flat NAV.
  const renderNavItem = ({ path, label, Icon, subtitle }) => {
    const isActive = path === activePath;
    const isChat = path === '/chats';
    const dotColor = chatCounts.unread > 0
      ? 'var(--eb-status-success)'
      : chatCounts.busy > 0
        ? 'var(--eb-status-warning)'
        : null;
    return (
      <button
        key={path}
        onClick={() => navigate(path)}
        title={collapsed ? label : undefined}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-3)',
          width: '100%',
          padding: collapsed
            ? 'var(--eb-space-2) 0'
            : 'var(--eb-space-2) var(--eb-space-4)',
          justifyContent: collapsed ? 'center' : 'flex-start',
          background: isActive ? 'var(--eb-bg-selected)' : 'transparent',
          border: 'none',
          borderLeft: isActive ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
          color: isActive ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
          fontSize: 'var(--eb-text-md)',
          cursor: 'pointer',
          fontFamily: 'inherit',
          textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
        onMouseEnter={e => {
          if (!isActive) e.currentTarget.style.background = 'var(--eb-bg-hover)';
        }}
        onMouseLeave={e => {
          if (!isActive) e.currentTarget.style.background = 'transparent';
        }}
      >
        {/* Icon — with dot overlay in collapsed mode */}
        <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
          <Icon size={20} />
          {isChat && collapsed && dotColor && (
            <span style={{
              position: 'absolute',
              top: -2,
              right: -2,
              width: 7,
              height: 7,
              borderRadius: '50%',
              background: dotColor,
              border: '1.5px solid var(--eb-bg-surface)',
            }} />
          )}
        </span>
        {!collapsed && (
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span>{label}</span>
            {subtitle && (
              <span style={{
                fontSize: 'var(--eb-text-xs)',
                color: 'var(--eb-text-muted)',
                fontWeight: 'normal',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}>{subtitle}</span>
            )}
          </span>
        )}
        {/* Status badges in expanded mode */}
        {isChat && !collapsed && (
          <span style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
            <NavBadge count={chatCounts.unread} color="var(--eb-status-success)" />
            <NavBadge count={chatCounts.busy}   color="var(--eb-status-warning)" />
          </span>
        )}
      </button>
    );
  };

  return (
    <PageActionsContext.Provider value={pageActionsSlot}>
    <div style={{ display: 'flex', width: '100%', minHeight: '100vh' }}>

      {/* ── Sidebar ──────────────────────────────────────────────────── */}
      <aside style={{
        width: sidebarWidth,
        minWidth: sidebarWidth,
        height: '100vh',
        position: 'fixed',
        top: 0,
        left: 0,
        background: 'var(--eb-bg-surface)',
        borderRight: '1px solid var(--eb-border-default)',
        display: 'flex',
        flexDirection: 'column',
        transition: 'width var(--eb-transition-normal)',
        overflow: 'hidden',
        zIndex: 50,
      }}>
        {/* Logo + collapse */}
        <div style={{
          height: 'var(--eb-header-height)',
          display: 'flex',
          alignItems: 'center',
          padding: collapsed ? '0 var(--eb-space-3)' : '0 var(--eb-space-4)',
          justifyContent: collapsed ? 'center' : 'space-between',
          borderBottom: '1px solid var(--eb-border-default)',
          flexShrink: 0,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
            <BrandMark size={28} style={{ flexShrink: 0 }} />
            {!collapsed && (
              <span style={{
                fontWeight: 'var(--eb-font-semibold)',
                fontSize: 'var(--eb-text-md)',
                whiteSpace: 'nowrap',
              }}>Agent Studio</span>
            )}
          </div>
          <button
            onClick={() => setCollapsed(c => !c)}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            style={{
              background: 'none', border: 'none', color: 'var(--eb-text-secondary)',
              cursor: 'pointer', padding: 'var(--eb-space-1)',
              display: collapsed ? 'none' : 'flex',
            }}
          >
            <ChevronLeft size={16} />
          </button>
        </div>

        {/* Expand button (collapsed) */}
        {collapsed && (
          <button
            onClick={() => setCollapsed(false)}
            aria-label="Expand sidebar"
            style={{
              background: 'none', border: 'none', color: 'var(--eb-text-secondary)',
              cursor: 'pointer', padding: 'var(--eb-space-3)',
              display: 'flex', justifyContent: 'center',
            }}
          >
            <ChevronRight size={16} />
          </button>
        )}

        {/* Persistent "+ Create" control (#1665, AC2 / D4). Always present on
            every page; navigates to the same launcher as the /create route.
            Open to every authenticated user, matching the creation pages'
            visibility (they are ungated). Icon-only in rail mode. */}
        <div style={{
          padding: collapsed
            ? 'var(--eb-space-2) var(--eb-space-2) 0'
            : 'var(--eb-space-2) var(--eb-space-3) 0',
          flexShrink: 0,
        }}>
          <button
            type="button"
            onClick={() => navigate('/create')}
            title={collapsed ? 'Create' : undefined}
            aria-label="Create"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 'var(--eb-space-2)',
              width: '100%',
              padding: collapsed ? 'var(--eb-space-2) 0' : 'var(--eb-space-2) var(--eb-space-3)',
              background: 'var(--eb-accent-primary)',
              color: 'var(--eb-text-inverted)',
              border: 'none',
              borderRadius: 'var(--eb-radius-md)',
              fontSize: 'var(--eb-text-md)',
              fontWeight: 'var(--eb-font-semibold)',
              fontFamily: 'inherit',
              cursor: 'pointer',
              transition: 'opacity var(--eb-transition-fast)',
            }}
            onMouseEnter={e => { e.currentTarget.style.opacity = '0.9'; }}
            onMouseLeave={e => { e.currentTarget.style.opacity = '1'; }}
          >
            <Plus size={18} style={{ flexShrink: 0 }} />
            {!collapsed && <span>Create</span>}
          </button>
        </div>

        {/* Nav sections */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-2) 0' }}>
          {/* Ungrouped top — primary/daily (Agent Chat, with its badges) */}
          {topItems.length > 0 && (
            <div style={{ marginBottom: 'var(--eb-space-2)' }}>
              {topItems.map(renderNavItem)}
            </div>
          )}

          {/* Collapsible groups (accordions), including the dynamic Plugins group
              appended last. In rail mode headers are hidden and every item stays
              reachable, exactly as today (AC10). */}
          {allGroups.map(group => {
            const expanded = collapsed || !collapsedGroups[group.key];
            return (
              <div key={group.key} style={{ marginBottom: 'var(--eb-space-2)' }}>
                {!collapsed && (
                  <GroupHeader
                    label={group.section}
                    expanded={expanded}
                    onToggle={() => toggleGroup(group.key)}
                  />
                )}
                {expanded && group.items.map(renderNavItem)}
              </div>
            );
          })}
        </nav>

        {/* Copyright footer — links to /about */}
        {!collapsed && (
          <button
            type="button"
            onClick={() => navigate('/about')}
            style={{
              all: 'unset',
              display: 'block',
              boxSizing: 'border-box',
              width: '100%',
              flexShrink: 0,
              padding: 'var(--eb-space-3) var(--eb-space-4)',
              paddingTop: 'var(--eb-space-4)',
              fontSize: 11,
              color: 'var(--eb-text-muted)',
              borderTop: '1px solid var(--eb-border-default)',
              whiteSpace: 'nowrap',
              cursor: 'pointer',
              borderRadius: 'var(--eb-radius-sm)',
              transition: 'background var(--eb-transition-fast)',
              textAlign: 'left',
            }}
            onMouseEnter={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
            onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
            onFocus={e => e.currentTarget.style.background = 'var(--eb-bg-hover)'}
            onBlur={e => e.currentTarget.style.background = 'transparent'}
          >
            <div style={{ fontWeight: 'bold' }}>About</div>
            <div>© 2026 Accenture. All rights reserved.</div>
            <div data-testid="app-version" style={{ color: 'var(--eb-text-muted)' }}>{COMMIT_TIME_LABEL}</div>
          </button>
        )}
      </aside>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div style={{
        marginLeft: sidebarWidth,
        flex: 1,
        // Flex items refuse to shrink below their content's min-content width
        // by default — wide page content (code blocks, fixed-width panels)
        // would push the whole viewport into horizontal scrolling.
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        minHeight: '100vh',
        transition: 'margin-left var(--eb-transition-normal)',
      }}>
        {/* Header */}
        <header style={{
          height: 'var(--eb-header-height)',
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--eb-space-3)',
          padding: '0 var(--eb-space-6)',
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-surface)',
          flexShrink: 0,
          minWidth: 0,
        }}>
          {/* Page title — bold, primary colour; acts as the accessible h1 for
              the current route. Truncates on narrow viewports so actions/controls
              on the right never get pushed off-screen. */}
          <h1 style={{
            margin: 0,
            flex: '1 1 0',
            minWidth: 0,
            fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-semibold)',
            color: 'var(--eb-text-primary)',
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}>
            {breadcrumbFor(location.pathname)}
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', flexShrink: 0 }}>
            {/* Page-actions slot: pages portal their primary action button(s)
                here via usePageActions(); the ref callback captures the DOM node
                once and stores it in pageActionsSlot so portals can mount. */}
            <div
              ref={el => { if (el && el !== pageActionsSlot) setPageActionsSlot(el); }}
              style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}
            />
            <button
              onClick={toggleHelp}
              title="Help — ask anything about Agent Studio"
              aria-label="Help"
              aria-pressed={helpOpen}
              style={{
                background: helpOpen ? 'var(--eb-bg-selected)' : 'none',
                border: '1px solid var(--eb-border-default)',
                borderRadius: 'var(--eb-radius-md)',
                color: helpOpen ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: 'var(--eb-space-2)',
                padding: 'var(--eb-space-1) var(--eb-space-2)',
                fontFamily: 'inherit',
                fontSize: 'var(--eb-text-sm)',
                transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
              }}
              onMouseEnter={e => {
                if (helpOpen) return;
                e.currentTarget.style.background = 'var(--eb-bg-hover)';
                e.currentTarget.style.color = 'var(--eb-text-primary)';
              }}
              onMouseLeave={e => {
                if (helpOpen) return;
                e.currentTarget.style.background = 'none';
                e.currentTarget.style.color = 'var(--eb-text-secondary)';
              }}
            >
              <HelpCircle size={16} />
              <span>Help</span>
            </button>
            <AccountMenu
              username={user?.username}
              onOpenSettings={() => { setSettingsSection(null); setSettingsOpen(true); }}
              onLogout={logout}
            />
          </div>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: 'var(--eb-space-6)', overflowY: 'auto' }}>
          {children}
        </main>
      </div>

      {/* Persistent Meeting Note-Taker overlay (#1296) — portaled to body, so
          it floats over every page while a meeting transcription runs. */}
      <TranscriptionOverlay />

      {/* Helper Chat panel (#1735) — a non-blocking slide-in help assistant,
          mounted once here so it is available on every route without a backdrop. */}
      <HelperChatPanel />

      {/* User Settings modal (#1802) — opened from the header account menu;
          mounted once here so it overlays every route. */}
      <SettingsModal
        open={settingsOpen}
        requestedSectionId={settingsSection}
        onClose={() => { setSettingsOpen(false); setSettingsSection(null); }}
      />
    </div>
    </PageActionsContext.Provider>
  );
}
