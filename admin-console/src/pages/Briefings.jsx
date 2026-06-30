import React, { useState, useEffect, useCallback } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { GitBranch, Server, ChevronLeft, ChevronRight, HelpCircle, X } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { FlowGraph } from './process/FlowGraph';

const BANNER_KEY = 'aee.flows.infoBanner.dismissed';

const BP_LIFECYCLE_ROWS = [
  { state: 'draft',      desc: 'Work item created but not yet scoped.' },
  { state: 'ready',      desc: 'Scoped and waiting to be picked up.' },
  { state: 'dispatched', desc: 'Suggested to an agent; awaiting confirmation.' },
  { state: 'claimed',    desc: 'Agent actively working on it.' },
  { state: 'completed',  desc: 'Work finished; awaiting review.' },
  { state: 'reviewed',   desc: 'Accepted and closed.' },
  { state: 'stale',      desc: 'A dependency changed — may need revisiting.' },
  { state: 'archived',   desc: 'No longer active.' },
];

function HelpPanel({ onClose }) {
  useEffect(() => {
    function onKey(e) { if (e.key === 'Escape') onClose(); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: 'fixed', inset: 0, zIndex: 200,
        display: 'flex', alignItems: 'flex-start', justifyContent: 'flex-end',
        background: 'rgba(0,0,0,0.35)',
      }}
    >
      <div style={{
        width: 480, maxWidth: '90vw', height: '100%',
        background: 'var(--eb-bg-surface)', borderLeft: '1px solid var(--eb-border-default)',
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
      }}>
        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          padding: 'var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0,
        }}>
          <span style={{ fontWeight: 'var(--eb-font-semibold)', fontSize: 'var(--eb-text-md)', color: 'var(--eb-text-primary)' }}>
            Flows — Help
          </span>
          <button
            onClick={onClose}
            aria-label="Close help panel"
            style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--eb-text-secondary)', display: 'flex', alignItems: 'center' }}
          >
            <X size={18} />
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--eb-space-4)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)', lineHeight: 1.6 }}>
          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              What is a Flow?
            </h3>
            <p style={{ margin: 0 }}>
              A <strong>Flow</strong> is an Orchestrator agent bound to a directory of BriefingPacks.
              It continuously monitors that directory, renders the dependency graph of all BriefingPacks,
              and manages their lifecycle — dispatching, claiming, and tracking work state across your team.
            </p>
          </section>

          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              What is a BriefingPack?
            </h3>
            <p style={{ margin: 0 }}>
              A <strong>BriefingPack (BP)</strong> is a discrete unit of work. Each BP moves through a defined
              lifecycle from creation to completion, and can declare dependencies on other BPs.
            </p>
          </section>

          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              What does the dependency graph show?
            </h3>
            <p style={{ margin: 0 }}>
              Each node is a BriefingPack. Edges indicate dependencies — a BP can only move to <em>ready</em> once
              all its declared dependencies are <em>completed</em> or <em>reviewed</em>. Node colour reflects the
              current lifecycle state, giving you an at-a-glance view of team progress.
            </p>
          </section>

          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              How do you create a Flow?
            </h3>
            <ol style={{ paddingLeft: 'var(--eb-space-4)', margin: 0 }}>
              <li>Go to the <strong>Agents</strong> page.</li>
              <li>Create a new agent and set its role to <strong>Orchestrator</strong>.</li>
              <li>Set the <strong>Briefings Path</strong> to the directory containing your BriefingPacks.</li>
              <li>The new Flow will appear in this sidebar once the agent is enabled.</li>
            </ol>
          </section>

          <section>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              BP lifecycle states
            </h3>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 'var(--eb-text-xs)' }}>
              <thead>
                <tr>
                  <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)', color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)' }}>State</th>
                  <th style={{ textAlign: 'left', padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)', color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)' }}>Meaning</th>
                </tr>
              </thead>
              <tbody>
                {BP_LIFECYCLE_ROWS.map(({ state, desc }) => (
                  <tr key={state}>
                    <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)', fontFamily: 'monospace', color: 'var(--eb-accent-primary)' }}>{state}</td>
                    <td style={{ padding: '4px 8px', borderBottom: '1px solid var(--eb-border-default)' }}>{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  );
}

function InfoBanner({ onDismiss }) {
  return (
    <div style={{
      margin: 'var(--eb-space-4)',
      padding: 'var(--eb-space-4)',
      background: 'color-mix(in srgb, var(--eb-accent-primary) 8%, var(--eb-bg-surface))',
      border: '1px solid var(--eb-accent-primary)',
      borderRadius: 6,
      fontSize: 'var(--eb-text-sm)',
      color: 'var(--eb-text-secondary)',
      lineHeight: 1.6,
      position: 'relative',
    }}>
      <button
        onClick={onDismiss}
        aria-label="Dismiss banner"
        style={{
          position: 'absolute', top: 'var(--eb-space-3)', right: 'var(--eb-space-3)',
          background: 'none', border: 'none', cursor: 'pointer',
          color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center', padding: 2,
        }}
      >
        <X size={16} />
      </button>

      <p style={{ margin: '0 0 var(--eb-space-2)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
        Welcome to Flows
      </p>
      <p style={{ margin: '0 0 var(--eb-space-2)' }}>
        A <strong>Flow</strong> is an Orchestrator agent that monitors a directory of <strong>BriefingPacks</strong>,
        renders their dependency graph, and manages their lifecycle.
      </p>
      <p style={{ margin: '0 0 var(--eb-space-2)' }}>
        A <strong>BriefingPack (BP)</strong> is a discrete unit of work with a lifecycle:
        draft → ready → dispatched → claimed → completed → reviewed.
      </p>
      <p style={{ margin: '0 0 var(--eb-space-2)' }}>
        On this page you can: select a Flow to visualise its BP dependency graph; activate or deactivate
        individual BPs; and track work state across your team.
      </p>
      <p style={{ margin: 0 }}>
        To create a Flow: go to the <strong>Agents</strong> page, create an agent, and set its role to <strong>Orchestrator</strong>.
      </p>
    </div>
  );
}

function SourceTab({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: '4px 12px',
        fontSize: 'var(--eb-text-sm)',
        borderRadius: 6,
        border: `1px solid ${active ? 'var(--eb-accent-primary)' : 'var(--eb-border-default)'}`,
        background: active ? 'var(--eb-bg-selected)' : 'var(--eb-bg-surface)',
        color: active ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
      }}
    >
      {label}
    </button>
  );
}

function FlowRow({ agent, environmentName, selected, onSelect }) {
  return (
    <button
      onClick={onSelect}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 'var(--eb-space-3)',
        width: '100%',
        padding: 'var(--eb-space-2) var(--eb-space-3)',
        background: selected ? 'var(--eb-bg-selected)' : 'transparent',
        borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
        borderTop: 'none',
        borderRight: 'none',
        borderBottom: '1px solid transparent',
        color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
        cursor: 'pointer',
        fontFamily: 'inherit',
        textAlign: 'left',
        transition: 'background var(--eb-transition-fast)',
      }}
      onMouseEnter={e => {
        if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)';
      }}
      onMouseLeave={e => {
        if (!selected) e.currentTarget.style.background = 'transparent';
      }}
    >
      <GitBranch size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{
          fontSize: 'var(--eb-text-md)',
          fontWeight: 'var(--eb-font-medium)',
          color: 'var(--eb-text-primary)',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}>
          {agent.displayName || agent.id}
        </div>
        {environmentName && (
          <div style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 3,
            marginTop: 2,
            fontSize: 'var(--eb-text-xs)',
            color: 'var(--eb-text-muted)',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}>
            <Server size={10} style={{ flexShrink: 0 }} />
            {environmentName}
          </div>
        )}
      </div>
    </button>
  );
}

export default function Briefings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem(BANNER_KEY) === 'true'
  );
  // Unified viewer source (#366): 'bp' = selected orchestrator's BriefingPack
  // graph; 'live' = the live agent choreography across all agents.
  const [viewMode, setViewMode] = useState('bp');
  const selectedFlow = searchParams.get('flow');
  const { data: agents } = useApi('/api/agents');
  const { data: environments } = useApi('/api/environments');

  const orchestrators = (agents || []).filter(a => a.role === 'orchestrator');
  const envNameById = new Map((environments || []).map(e => [e.id, e.name]));

  function selectFlow(id) {
    setSearchParams({ flow: id });
  }

  const dismissBanner = useCallback(() => {
    localStorage.setItem(BANNER_KEY, 'true');
    setBannerDismissed(true);
  }, []);

  const closeHelp = useCallback(() => setHelpOpen(false), []);


  const selectedAgent = orchestrators.find(a => a.id === selectedFlow);

  return (
    <div style={{
      display: 'flex',
      height: 'calc(100vh - var(--eb-header-height))',
      margin: 'calc(-1 * var(--eb-space-6))',
      background: 'var(--eb-bg-app)',
      overflow: 'hidden',
    }}>
      {/* Left column: Flow list */}
      <div style={{
        width: navCollapsed ? 40 : 260,
        minWidth: navCollapsed ? 40 : 260,
        height: '100%',
        borderRight: '1px solid var(--eb-border-default)',
        background: 'var(--eb-bg-surface)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        transition: 'width var(--eb-transition-normal), min-width var(--eb-transition-normal)',
        flexShrink: 0,
      }}>
        {navCollapsed ? (
          /* Collapsed: expand button only */
          <button
            onClick={() => setNavCollapsed(false)}
            title="Show Flows"
            aria-label="Show Flows"
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              width: '100%',
              padding: 'var(--eb-space-3) 0',
              background: 'none',
              border: 'none',
              borderBottom: '1px solid var(--eb-border-default)',
              color: 'var(--eb-text-secondary)',
              cursor: 'pointer',
              flexShrink: 0,
            }}
            onMouseEnter={e => { e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
            onMouseLeave={e => { e.currentTarget.style.background = 'none'; }}
          >
            <ChevronRight size={16} />
          </button>
        ) : (
          <>
            {/* Header: title + help icon + collapse button */}
            <div style={{
              padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-3) var(--eb-space-4)',
              borderBottom: '1px solid var(--eb-border-default)',
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', minWidth: 0 }}>
                <div>
                  <div style={{
                    fontSize: 'var(--eb-text-md)',
                    fontWeight: 'var(--eb-font-semibold)',
                    color: 'var(--eb-text-primary)',
                  }}>
                    Flows
                  </div>
                  <div style={{
                    fontSize: 'var(--eb-text-xs)',
                    color: 'var(--eb-text-muted)',
                    marginTop: 'var(--eb-space-1)',
                  }}>
                    {orchestrators.length > 0
                      ? `${orchestrators.length} flow${orchestrators.length !== 1 ? 's' : ''}`
                      : ''}
                  </div>
                </div>
                {/* AC 2: persistent help icon, always visible */}
                <button
                  onClick={() => setHelpOpen(true)}
                  title="Help"
                  aria-label="Open Flows help"
                  style={{
                    background: 'none', border: 'none', cursor: 'pointer',
                    color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center',
                    padding: 2, flexShrink: 0,
                  }}
                  onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-accent-primary)'; }}
                  onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
                >
                  <HelpCircle size={15} />
                </button>
              </div>
              <button
                onClick={() => setNavCollapsed(true)}
                title="Hide Flows"
                aria-label="Hide Flows"
                style={{
                  background: 'none', border: 'none',
                  color: 'var(--eb-text-secondary)', cursor: 'pointer',
                  padding: 'var(--eb-space-1)', display: 'flex', alignItems: 'center', flexShrink: 0,
                }}
                onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-text-primary)'; }}
                onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-secondary)'; }}
              >
                <ChevronLeft size={16} />
              </button>
            </div>

            <div style={{ flex: 1, overflowY: 'auto' }}>
              {orchestrators.length === 0 ? (
                /* AC 3: improved empty state with React Router link */
                <div style={{
                  padding: 'var(--eb-space-4)',
                  fontSize: 'var(--eb-text-sm)',
                  color: 'var(--eb-text-muted)',
                  lineHeight: 1.6,
                }}>
                  <p style={{ margin: '0 0 var(--eb-space-2)' }}>
                    No Flows yet. A Flow is created when you add an agent with the
                    role <strong>Orchestrator</strong>.
                  </p>
                  <p style={{ margin: 0 }}>
                    Go to the{' '}
                    <Link
                      to="/agents"
                      style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none', borderBottom: '1px solid transparent', transition: 'border-color var(--eb-transition-fast)' }}
                      onMouseEnter={e => { e.currentTarget.style.borderBottomColor = 'var(--eb-accent-primary)'; }}
                      onMouseLeave={e => { e.currentTarget.style.borderBottomColor = 'transparent'; }}
                    >
                      Agents page
                    </Link>
                    {' '}to create one.
                  </p>
                </div>
              ) : (
                orchestrators.map(a => (
                  <FlowRow
                    key={a.id}
                    agent={a}
                    environmentName={envNameById.get(a.environmentId) || a.environmentId || null}
                    selected={selectedFlow === a.id}
                    onSelect={() => selectFlow(a.id)}
                  />
                ))
              )}
            </div>
          </>
        )}
      </div>

      {/* Right pane: banner + graph */}
      <div style={{ flex: 1, overflow: 'hidden', position: 'relative', display: 'flex', flexDirection: 'column' }}>
        {/* AC 1: dismissible info banner, shown on first visit */}
        {!bannerDismissed && <InfoBanner onDismiss={dismissBanner} />}

        {/* Source switcher (#366): BriefingPack graph ↔ live agent choreography */}
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)',
          padding: 'var(--eb-space-2) var(--eb-space-4)',
          borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0,
        }}>
          <SourceTab label="BriefingPacks" active={viewMode === 'bp'} onClick={() => setViewMode('bp')} />
          <SourceTab label="Live agents" active={viewMode === 'live'} onClick={() => setViewMode('live')} />
        </div>

        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {viewMode === 'bp' ? (
            !selectedAgent ? (
              <div style={{
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
              }}>
                Select a Flow to view its dependency graph
              </div>
            ) : (
              <FlowGraph
                key={selectedAgent.id}
                workspace={selectedAgent.briefingsPath
                    ? `/workspace/agents/${selectedAgent.id}/${selectedAgent.briefingsPath}`
                    : `/workspace/agents/${selectedAgent.id}`}
              />
            )
          ) : (
            <FlowGraph key="live" />
          )}
        </div>

        {/* AC 2: help panel slide-in overlay */}
        {helpOpen && <HelpPanel onClose={closeHelp} />}
      </div>
    </div>
  );
}
