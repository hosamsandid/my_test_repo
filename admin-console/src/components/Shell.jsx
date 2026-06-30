import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Zap, Clock, Sparkles, Server,
  ChevronLeft, ChevronRight, Bot,
  Boxes, Key, MessageCircle, Github, Layers, GitBranch,
  Sun, Moon, Rocket, Users2, Wand2,
} from 'lucide-react';
import useTheme from '../hooks/useTheme';

const STATUS_POLL_MS = 5_000;
const LAST_VIEWED_KEY = 'agentChat.lastViewed';

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

const NAV = [
  { section: 'OVERVIEW', items: [
    { path: '/',             label: 'Dashboard',           Icon: LayoutDashboard },
    { path: '/quickstart',   label: 'Single Agent',        Icon: Rocket,   subtitle: 'One agent, one repo' },
    { path: '/team-setup',   label: 'Team Wizard',         Icon: Users2,   subtitle: 'Multi-role GitHub team' },
    { path: '/agents',       label: 'Agents',              Icon: Layers },
    { path: '/flows',         label: 'Flows',               Icon: GitBranch, subtitle: 'BriefingPacks & process graphs' },
    { path: '/chats',        label: 'Agent Chat',          Icon: MessageCircle },
    { path: '/orchestrator-wizard', label: 'Orchestrator Wizard', Icon: Wand2 },
  ]},
  { section: 'WORKSPACES', items: [
    { path: '/ssh-keys',      label: 'SSH Keys',             Icon: Key },
    { path: '/github-tokens', label: 'GitHub Tokens',        Icon: Github },
    { path: '/environments',  label: 'Working Environments', Icon: Boxes },
  ]},
  { section: 'CONFIGURATION', items: [
    { path: '/skills',       label: 'Skills Registry',     Icon: Zap },
    { path: '/jobs',         label: 'Triggers',            Icon: Clock },
    { path: '/models',       label: 'Model Providers',     Icon: Sparkles },
    { path: '/mcp',          label: 'MCP Servers',         Icon: Server },
  ]},
];

const BREADCRUMBS = {
  '/':             'Dashboard',
  '/quickstart':   'Single Agent',
  '/team-setup':   'Team Wizard',
  '/agents':       'Agents',
  '/flows':        'Flows',
  '/chats':        'Agent Chat',
  '/environments': 'Working Environments',
  '/ssh-keys':     'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/skills':       'Skills Registry',
  '/jobs':         'Triggers',
  '/models':       'Model Providers',
  '/mcp':          'MCP Servers',
  '/orchestrator-wizard': 'Orchestrator Wizard',
};

function breadcrumbFor(pathname) {
  if (BREADCRUMBS[pathname]) return BREADCRUMBS[pathname];
  if (pathname.startsWith('/chats/')) {
    const id = pathname.slice('/chats/'.length);
    return `Agent Chat / ${id}`;
  }
  return pathname;
}

export default function Shell({ children }) {
  const [collapsed, setCollapsed] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleLightDark } = useTheme();
  const [chatCounts, setChatCounts] = useState({ busy: 0, unread: 0 });

  useEffect(() => {
    const poll = () => {
      fetch('/api/agents/statuses')
        .then(r => r.ok ? r.json() : [])
        .then(list => {
          const viewed = loadLastViewed();
          let busy = 0, unread = 0;
          for (const { id, activityState, lastResponseAt } of list) {
            if (activityState === 'busy') {
              busy++;
            } else if (activityState !== 'disabled' && activityState !== 'offline') {
              if (lastResponseAt && new Date(lastResponseAt).getTime() > (viewed[id] || 0)) {
                unread++;
              }
            }
          }
          setChatCounts({ busy, unread });
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, STATUS_POLL_MS);
    return () => clearInterval(timer);
  }, []);

  const sidebarWidth = collapsed ? 'var(--eb-sidebar-collapsed)' : 'var(--eb-sidebar-width)';

  return (
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
            <Bot size={24} style={{ color: 'var(--eb-accent-primary)', flexShrink: 0 }} />
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

        {/* Nav sections */}
        <nav style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-2) 0' }}>
          {NAV.map(section => (
            <div key={section.section} style={{ marginBottom: 'var(--eb-space-2)' }}>
              {!collapsed && (
                <div style={{
                  padding: 'var(--eb-space-1) var(--eb-space-4)',
                  fontSize: 'var(--eb-text-xs)',
                  fontWeight: 'var(--eb-font-medium)',
                  color: 'var(--eb-text-muted)',
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}>
                  {section.section}
                </div>
              )}
              {section.items.map(({ path, label, Icon, subtitle }) => {
                const isActive = path === '/'
                  ? location.pathname === '/'
                  : location.pathname === path || location.pathname.startsWith(path + '/');
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
              })}
            </div>
          ))}
        </nav>

        {/* Copyright footer */}
        {!collapsed && (
          <div style={{
            flexShrink: 0,
            padding: 'var(--eb-space-3) var(--eb-space-4)',
            paddingTop: 'var(--eb-space-4)',
            fontSize: 11,
            color: 'var(--eb-text-muted)',
            borderTop: '1px solid var(--eb-border-default)',
            whiteSpace: 'nowrap',
          }}>
            © 2026 Accenture. All rights reserved.
          </div>
        )}
      </aside>

      {/* ── Main area ────────────────────────────────────────────────── */}
      <div style={{
        marginLeft: sidebarWidth,
        flex: 1,
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
          justifyContent: 'space-between',
          padding: '0 var(--eb-space-6)',
          borderBottom: '1px solid var(--eb-border-default)',
          background: 'var(--eb-bg-surface)',
          flexShrink: 0,
        }}>
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {breadcrumbFor(location.pathname)}
          </div>
          <button
            onClick={toggleLightDark}
            title={theme === 'admin-light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
            aria-label={theme === 'admin-light' ? 'Switch to Dark Mode' : 'Switch to Light Mode'}
            style={{
              background: 'none',
              border: '1px solid var(--eb-border-default)',
              borderRadius: 'var(--eb-radius-md)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              padding: 'var(--eb-space-1) var(--eb-space-2)',
              transition: 'background var(--eb-transition-fast), color var(--eb-transition-fast)',
            }}
            onMouseEnter={e => {
              e.currentTarget.style.background = 'var(--eb-bg-hover)';
              e.currentTarget.style.color = 'var(--eb-text-primary)';
            }}
            onMouseLeave={e => {
              e.currentTarget.style.background = 'none';
              e.currentTarget.style.color = 'var(--eb-text-secondary)';
            }}
          >
            {theme === 'admin-light' ? <Moon size={16} /> : <Sun size={16} />}
          </button>
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: 'var(--eb-space-6)', overflowY: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
