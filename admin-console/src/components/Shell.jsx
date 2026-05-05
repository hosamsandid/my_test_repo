import React, { useState } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import {
  LayoutDashboard, Users, Zap, Clock, Sparkles, Server,
  Database, ScrollText, ChevronLeft, ChevronRight, Bot,
  Boxes, Key, MessageCircle, Github, Layers, GitBranch,
} from 'lucide-react';

const NAV = [
  { section: 'OVERVIEW', items: [
    { path: '/',             label: 'Dashboard',           Icon: LayoutDashboard },
    { path: '/agents',       label: 'Agents',              Icon: Layers },
    { path: '/flows',         label: 'Flows',               Icon: GitBranch },
    { path: '/chats',        label: 'Agent Chat',          Icon: MessageCircle },
  ]},
  { section: 'WORKSPACES', items: [
    { path: '/environments', label: 'Working Environments', Icon: Boxes },
    { path: '/ssh-keys',     label: 'SSH Keys',             Icon: Key },
    { path: '/github-tokens', label: 'GitHub Tokens',       Icon: Github },
  ]},
  { section: 'CONFIGURATION', items: [
    { path: '/skills',       label: 'Skills Registry',     Icon: Zap },
    { path: '/jobs',         label: 'Scheduled Triggers',      Icon: Clock },
    { path: '/models',       label: 'Model Registry',      Icon: Sparkles },
    { path: '/mcp',          label: 'MCP Servers',         Icon: Server },
  ]},
  { section: 'KNOWLEDGE', items: [
    { path: '/knowledge',    label: 'Knowledge Base',      Icon: Database },
  ]},
  { section: 'OBSERVABILITY', items: [
    { path: '/logs',         label: 'Logs',                Icon: ScrollText },
  ]},
];

const BREADCRUMBS = {
  '/':             'Dashboard',
  '/agents':       'Agents',
  '/flows':        'Flows',
  '/chats':        'Agent Chat',
  '/environments': 'Working Environments',
  '/ssh-keys':     'SSH Keys',
  '/github-tokens': 'GitHub Tokens',
  '/skills':       'Skills Registry',
  '/jobs':         'Scheduled Triggers',
  '/models':       'Model Registry',
  '/mcp':          'MCP Servers',
  '/knowledge':    'Knowledge Base',
  '/logs':         'Logs',
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
              }}>e-vgh-claw Admin</span>
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
              {section.items.map(({ path, label, Icon }) => {
                const isActive = path === '/'
                  ? location.pathname === '/'
                  : location.pathname === path || location.pathname.startsWith(path + '/');
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
                      transition: 'background var(--eb-transition-fast)',
                    }}
                    onMouseEnter={e => {
                      if (!isActive) e.currentTarget.style.background = 'var(--eb-bg-hover)';
                    }}
                    onMouseLeave={e => {
                      if (!isActive) e.currentTarget.style.background = 'transparent';
                    }}
                  >
                    <Icon size={20} style={{ flexShrink: 0 }} />
                    {!collapsed && <span>{label}</span>}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
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
        </header>

        {/* Page content */}
        <main style={{ flex: 1, padding: 'var(--eb-space-6)', overflowY: 'auto' }}>
          {children}
        </main>
      </div>
    </div>
  );
}
