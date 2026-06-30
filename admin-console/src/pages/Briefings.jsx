import React, { useState, useEffect, useCallback, lazy, Suspense } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { GitBranch, Server, ChevronLeft, ChevronRight, HelpCircle, X, Users, Boxes, FileText, Plus, Trash2 } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { BPGraph } from './briefings/BPGraph';

// The process graph/editor is a heavy module (custom SVG renderer + dialogs) —
// load it only when a process scope is actually selected.
const ProcessGraphPanel = lazy(() =>
  import('./ProcessCanvas').then(m => ({ default: m.ProcessGraphPanel })));

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
              What can I do here?
            </h3>
            <p style={{ margin: '0 0 var(--eb-space-2)' }}>
              Flows hosts two kinds of orchestration, selectable in the left list:
            </p>
            <ul style={{ paddingLeft: 'var(--eb-space-4)', margin: 0 }}>
              <li><strong>Process graphs</strong> — for each <strong>Team</strong> (and editable <strong>Drafts</strong>),
                a label-driven graph of which agent reacts to which event, in what order.</li>
              <li><strong>BriefingPack flows</strong> — an <strong>Orchestrator</strong> agent that monitors a
                directory of BriefingPacks and renders their dependency graph.</li>
            </ul>
          </section>

          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              Process graphs (Teams &amp; Drafts)
            </h3>
            <p style={{ margin: '0 0 var(--eb-space-2)' }}>
              Selecting a <strong>Team</strong> shows its live orchestration graph. Agents don't call each other
              directly — they communicate through labels: one trigger <em>emits</em> a label, another
              <em> listens</em> on it, and that wiring is the graph.
            </p>
            <p style={{ margin: 0 }}>
              Click <strong>New process</strong> to author a <strong>Draft</strong> from scratch (add roles, wire
              hand-offs, add PR-review steps and human-approval gates), then <strong>Materialize</strong> it into a
              real team. The read-only <strong>Role templates</strong> blueprint shows the catalog wiring before any
              team exists.
            </p>
          </section>

          <section style={{ marginBottom: 'var(--eb-space-5)' }}>
            <h3 style={{ color: 'var(--eb-text-primary)', fontWeight: 'var(--eb-font-semibold)', marginBottom: 'var(--eb-space-2)', fontSize: 'var(--eb-text-md)' }}>
              What is a BriefingPack flow?
            </h3>
            <p style={{ margin: 0 }}>
              A <strong>BriefingPack flow</strong> is an Orchestrator agent bound to a directory of BriefingPacks.
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
              How do you create one?
            </h3>
            <p style={{ margin: '0 0 var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>Process graph</p>
            <ol style={{ paddingLeft: 'var(--eb-space-4)', margin: '0 0 var(--eb-space-3)' }}>
              <li>Click <strong>New process</strong> to start a draft, or pick an existing <strong>Team</strong>.</li>
              <li>Add roles and wire hand-offs, then <strong>Materialize</strong> the draft into a team.</li>
            </ol>
            <p style={{ margin: '0 0 var(--eb-space-1)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)' }}>BriefingPack flow</p>
            <ol style={{ paddingLeft: 'var(--eb-space-4)', margin: 0 }}>
              <li>Go to the <strong>Agents</strong> page and create an agent with role <strong>Orchestrator</strong>.</li>
              <li>Set the <strong>Briefings Path</strong> to the directory containing your BriefingPacks.</li>
              <li>The new flow appears under <strong>BriefingPack flows</strong> once the agent is enabled.</li>
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
        Flows hosts two kinds of orchestration, selectable on the left:
      </p>
      <p style={{ margin: '0 0 var(--eb-space-2)' }}>
        <strong>Process graphs</strong> — pick a <strong>Team</strong> to see its label-driven orchestration graph
        (which agent reacts to which event, in what order), or click <strong>New process</strong> to author a
        <strong> Draft</strong> from scratch and materialize it into a team.
      </p>
      <p style={{ margin: '0 0 var(--eb-space-2)' }}>
        <strong>BriefingPack flows</strong> — an <strong>Orchestrator</strong> agent that monitors a directory of
        <strong> BriefingPacks</strong> (discrete units of work: draft → ready → dispatched → claimed → completed →
        reviewed) and renders their dependency graph. Create one from the <strong>Agents</strong> page.
      </p>
      <p style={{ margin: 0 }}>
        Open the <HelpCircle size={12} style={{ verticalAlign: 'middle' }} /> help for details.
      </p>
    </div>
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

// Section header inside the left list (Flows / Teams / Drafts …).
function SectionHeader({ children, action }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: 'var(--eb-space-3) var(--eb-space-4) var(--eb-space-1)',
      fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)',
      color: 'var(--eb-text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em',
    }}>
      <span>{children}</span>
      {action}
    </div>
  );
}

// Generic selectable row (teams, drafts, role-templates). Mirrors FlowRow's
// look. An optional `onDelete` renders a trash button that fades in on hover.
function ListRow({ icon: Icon, label, sub, selected, onSelect, onDelete, deleteTitle }) {
  const [hover, setHover] = useState(false);
  return (
    <div
      style={{ position: 'relative' }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        onClick={onSelect}
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', width: '100%',
          padding: 'var(--eb-space-2) var(--eb-space-3)',
          paddingRight: onDelete ? 'var(--eb-space-6)' : 'var(--eb-space-3)',
          background: selected ? 'var(--eb-bg-selected)' : 'transparent',
          borderLeft: selected ? '3px solid var(--eb-accent-primary)' : '3px solid transparent',
          borderTop: 'none', borderRight: 'none', borderBottom: '1px solid transparent',
          color: selected ? 'var(--eb-text-primary)' : 'var(--eb-text-secondary)',
          cursor: 'pointer', fontFamily: 'inherit', textAlign: 'left',
          transition: 'background var(--eb-transition-fast)',
        }}
        onMouseEnter={e => { if (!selected) e.currentTarget.style.background = 'var(--eb-bg-hover)'; }}
        onMouseLeave={e => { if (!selected) e.currentTarget.style.background = 'transparent'; }}
      >
        <Icon size={18} style={{ flexShrink: 0, color: selected ? 'var(--eb-accent-primary)' : 'var(--eb-text-muted)' }} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{
            fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-medium)', color: 'var(--eb-text-primary)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
          }}>{label}</div>
          {sub && (
            <div style={{
              marginTop: 2, fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>{sub}</div>
          )}
        </div>
      </button>
      {onDelete && (hover || selected) && (
        <button
          onClick={(e) => { e.stopPropagation(); onDelete(); }}
          title={deleteTitle || 'Delete'}
          aria-label={deleteTitle || 'Delete'}
          style={{
            position: 'absolute', top: '50%', right: 'var(--eb-space-2)', transform: 'translateY(-50%)',
            background: 'none', border: 'none', cursor: 'pointer', padding: 4,
            color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center',
          }}
          onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-status-error)'; }}
          onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
        >
          <Trash2 size={15} />
        </button>
      )}
    </div>
  );
}

export default function Briefings() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [navCollapsed, setNavCollapsed] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [bannerDismissed, setBannerDismissed] = useState(
    () => localStorage.getItem(BANNER_KEY) === 'true'
  );
  // Selection: a process scope (`proc`) takes precedence over a BriefingPack
  // flow (`flow`). `proc` is a team id, 'templates', or 'draft:<id>'.
  const proc = searchParams.get('proc');
  const selectedFlow = proc ? null : searchParams.get('flow');
  const { data: agents } = useApi('/api/agents');
  const { data: environments } = useApi('/api/environments');
  const { data: draftsList, refetch: refetchDrafts } = useApi('/api/process/drafts');

  const orchestrators = (agents || []).filter(a => a.role === 'orchestrator');
  const teams = (agents || []).filter(a => a.role === 'team');
  const drafts = Array.isArray(draftsList) ? draftsList : [];
  const envNameById = new Map((environments || []).map(e => [e.id, e.name]));

  function selectFlow(id) {
    setSearchParams({ flow: id });
  }
  function selectProc(scope) {
    setSearchParams({ proc: scope });
  }

  async function newProcess() {
    try {
      const d = await apiCall('POST', '/api/process/drafts', { name: 'Untitled process' });
      refetchDrafts();
      setSearchParams({ proc: `draft:${d.id}` });
    } catch { /* surfaced elsewhere; keep the list usable */ }
  }

  async function deleteDraft(d) {
    if (!window.confirm(`Delete draft “${d.name}”? This cannot be undone.`)) return;
    try {
      await apiCall('DELETE', `/api/process/drafts/${d.id}`);
      // If the deleted draft was open, drop the selection.
      if (proc === `draft:${d.id}`) setSearchParams({});
      refetchDrafts();
    } catch { /* leave the list as-is; the draft may already be gone */ }
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
              {/* Start a new process (a draft) from scratch */}
              <div style={{ padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-1)' }}>
                <button
                  onClick={newProcess}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6, width: '100%',
                    padding: 'var(--eb-space-2)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                    border: 'none', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                  }}
                >
                  <Plus size={15} /> New process
                </button>
              </div>

              {/* Teams — each team is a process (live orchestration graph) */}
              <SectionHeader>Teams</SectionHeader>
              {teams.length === 0 ? (
                <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  No teams yet.
                </div>
              ) : (
                teams.map(t => (
                  <ListRow
                    key={t.id}
                    icon={Users}
                    label={t.displayName || t.id}
                    sub={envNameById.get(t.environmentId) || t.environmentId || null}
                    selected={proc === t.id}
                    onSelect={() => selectProc(t.id)}
                  />
                ))
              )}

              {/* Drafts — processes being authored, not yet materialised */}
              <SectionHeader>Drafts</SectionHeader>
              {drafts.length === 0 ? (
                <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)' }}>
                  No drafts. Use “New process”.
                </div>
              ) : (
                drafts.map(d => (
                  <ListRow
                    key={d.id}
                    icon={FileText}
                    label={d.name}
                    sub={`${d.roleCount} role${d.roleCount === 1 ? '' : 's'}`}
                    selected={proc === `draft:${d.id}`}
                    onSelect={() => selectProc(`draft:${d.id}`)}
                    onDelete={() => deleteDraft(d)}
                    deleteTitle="Delete draft"
                  />
                ))
              )}

              {/* Role templates — read-only blueprint of the catalog */}
              <SectionHeader>Blueprint</SectionHeader>
              <ListRow
                icon={Boxes}
                label="Role templates"
                sub="Read-only catalog"
                selected={proc === 'templates'}
                onSelect={() => selectProc('templates')}
              />

              {/* BriefingPack flows (Orchestrator agents) */}
              <SectionHeader>BriefingPack flows</SectionHeader>
              {orchestrators.length === 0 ? (
                <div style={{ padding: '0 var(--eb-space-4) var(--eb-space-3)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.6 }}>
                  None. Create an agent with role{' '}
                  <Link
                    to="/agents"
                    style={{ color: 'var(--eb-accent-primary)', textDecoration: 'none' }}
                  >Orchestrator</Link>.
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
        {/* AC 1: dismissible info banner — only in the BriefingPack-flow context */}
        {!bannerDismissed && !proc && <InfoBanner onDismiss={dismissBanner} />}

        <div style={{ flex: 1, overflow: 'hidden', position: 'relative' }}>
          {proc ? (
            <Suspense fallback={
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)' }}>
                Loading…
              </div>
            }>
              <ProcessGraphPanel
                key={proc}
                scope={proc}
                onNavigate={selectProc}
                onDraftsChanged={refetchDrafts}
              />
            </Suspense>
          ) : !selectedAgent ? (
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              height: '100%', color: 'var(--eb-text-muted)', fontSize: 'var(--eb-text-sm)',
            }}>
              Select a team, draft or flow on the left
            </div>
          ) : (
            <BPGraph
              orchestratorId={selectedAgent.id}
              workspacePath={selectedAgent.briefingsPath
                  ? `/workspace/agents/${selectedAgent.id}/${selectedAgent.briefingsPath}`
                  : `/workspace/agents/${selectedAgent.id}`}
            />
          )}
        </div>

        {/* AC 2: help panel slide-in overlay */}
        {helpOpen && <HelpPanel onClose={closeHelp} />}
      </div>
    </div>
  );
}
