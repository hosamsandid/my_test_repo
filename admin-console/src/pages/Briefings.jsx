import React, { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { GitBranch, Server, ChevronLeft, ChevronRight, HelpCircle, X, Users, Boxes, FileText, Plus, Trash2, Pencil, Check, Upload } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { FlowGraph } from './process/FlowGraph';

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
              Click <strong>New process</strong> to author a <strong>Draft</strong> from scratch (add roles, then
              wire hand-offs — GitHub PR/Issue channels, labels, data flows, human-approval gates on the
              edges), then <strong>Materialize</strong> it into a real team. The read-only <strong>Role templates</strong> blueprint shows the catalog wiring before any
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
              Each node is a BriefingPack work-unit. Edges show how work hands off:
              red dashed edges are <em>dependencies</em> (a BP can only start once its
              upstream BPs are done) and green edges are <em>data flow</em> (one BP's
              output artifact is another's input). It is the same unified viewer used
              for process graphs.
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
// look. An optional `onDelete` renders a trash button that fades in on hover;
// an optional `onRename` renders a pencil button and turns the label into an
// inline text field (Enter/blur commits, Escape reverts).
function ListRow({ icon: Icon, label, sub, selected, onSelect, onDelete, deleteTitle, onRename, renameTitle }) {
  const [hover, setHover] = useState(false);
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(label);
  const inputRef = useRef(null);
  useEffect(() => { if (!editing) setValue(label); }, [label, editing]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  function commit() {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== label) onRename(trimmed);
    else setValue(label);
  }

  const actionCount = (onRename ? 1 : 0) + (onDelete ? 1 : 0);

  if (editing) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-2) var(--eb-space-3)' }}>
        <Icon size={18} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
        <input
          ref={inputRef}
          value={value}
          onChange={e => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={e => {
            if (e.key === 'Enter') { e.preventDefault(); commit(); }
            else if (e.key === 'Escape') { e.preventDefault(); setValue(label); setEditing(false); }
          }}
          maxLength={80}
          style={{
            flex: 1, minWidth: 0, fontSize: 'var(--eb-text-md)', fontFamily: 'inherit',
            color: 'var(--eb-text-primary)', background: 'var(--eb-bg-surface)',
            border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-sm)',
            padding: '2px 6px',
          }}
        />
        <button
          onMouseDown={e => e.preventDefault()}
          onClick={commit}
          title="Save name" aria-label="Save name"
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 4, color: 'var(--eb-accent-primary)', display: 'flex' }}
        >
          <Check size={15} />
        </button>
      </div>
    );
  }

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
          paddingRight: actionCount ? `calc(var(--eb-space-3) + ${actionCount * 24}px)` : 'var(--eb-space-3)',
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
      {(hover || selected) && (onRename || onDelete) && (
        <div style={{
          position: 'absolute', top: '50%', right: 'var(--eb-space-2)', transform: 'translateY(-50%)',
          display: 'flex', alignItems: 'center', gap: 2,
        }}>
          {onRename && (
            <button
              onClick={(e) => { e.stopPropagation(); setValue(label); setEditing(true); }}
              title={renameTitle || 'Rename'}
              aria-label={renameTitle || 'Rename'}
              style={{
                background: 'none', border: 'none', cursor: 'pointer', padding: 4,
                color: 'var(--eb-text-muted)', display: 'flex', alignItems: 'center',
              }}
              onMouseEnter={e => { e.currentTarget.style.color = 'var(--eb-accent-primary)'; }}
              onMouseLeave={e => { e.currentTarget.style.color = 'var(--eb-text-muted)'; }}
            >
              <Pencil size={14} />
            </button>
          )}
          {onDelete && (
            <button
              onClick={(e) => { e.stopPropagation(); onDelete(); }}
              title={deleteTitle || 'Delete'}
              aria-label={deleteTitle || 'Delete'}
              style={{
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

  // Import a previously-exported process-template JSON (#512) — the entry
  // point lives here, next to "New process", rather than inside an
  // already-open flow (importing always creates a brand-new flow, so the
  // previously-open one was irrelevant context). Validation/preview logic is
  // unchanged from the former in-editor flow, just moved up a level: on
  // success, `ProcessGraphPanel` is mounted with scope 'import' to render the
  // read-only preview from `pendingImport`.
  const importInputRef = useRef(null);
  const [pendingImport, setPendingImport] = useState(null); // { bundle, graph }
  const [importError, setImportError] = useState(null);
  const [importBusy, setImportBusy] = useState(false);

  const clearPendingImport = useCallback(() => setPendingImport(null), []);
  const closeImportPreview = useCallback(() => setSearchParams({}), [setSearchParams]);

  async function onImportFile(e) {
    setImportError(null);
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { setImportError('Not valid JSON.'); return; }
    setImportBusy(true);
    try {
      const res = await fetch('/api/flows/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processTemplate: bundle }),
      });
      const g = await res.json();
      if (!res.ok) { setImportError(g.error || `HTTP ${res.status}`); return; }
      setPendingImport({ bundle, graph: g });
      setSearchParams({ proc: 'import' });
    } catch (err) {
      setImportError(err.message);
    } finally {
      setImportBusy(false);
    }
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

  async function renameDraft(d, name) {
    const trimmed = (name || '').trim();
    if (!trimmed || trimmed === d.name) return;
    try {
      // PUT validates the whole bundle, so round-trip the current document and
      // only swap the display name.
      const bundle = await apiCall('GET', `/api/process/drafts/${d.id}`);
      await apiCall('PUT', `/api/process/drafts/${d.id}`, { ...bundle, name: trimmed });
      refetchDrafts();
    } catch { /* leave the list as-is */ }
  }

  // Import the selected BriefingPack flow as an editable process draft (#377) —
  // one storage format for both concepts. Opens the new draft on success.
  const [importing, setImporting] = useState(false);
  async function importBriefings() {
    if (!selectedAgent || importing) return;
    const workspace = selectedAgent.briefingsPath
      ? `/workspace/agents/${selectedAgent.id}/${selectedAgent.briefingsPath}`
      : `/workspace/agents/${selectedAgent.id}`;
    setImporting(true);
    try {
      const d = await apiCall('POST', '/api/process/drafts/import-briefings', {
        workspace,
        name: `${selectedAgent.displayName || selectedAgent.id} (imported)`,
      });
      refetchDrafts();
      setSearchParams({ proc: `draft:${d.id}` });
    } catch (e) {
      window.alert(`Import failed: ${e?.message || e}`);
    } finally {
      setImporting(false);
    }
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
              {/* Start a new process (a draft) from scratch, or import a
                  previously-exported one (#512) — both create flows, so both
                  live here, side by side, rather than Import being reachable
                  only from inside an already-open flow. */}
              <div style={{ padding: 'var(--eb-space-3) var(--eb-space-3) var(--eb-space-1)', display: 'flex', gap: 'var(--eb-space-2)' }}>
                <button
                  onClick={newProcess}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: 'var(--eb-space-2) var(--eb-space-1)', background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)',
                    border: 'none', borderRadius: 'var(--eb-radius-md)', cursor: 'pointer',
                    fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Plus size={15} /> New process
                </button>
                <input
                  ref={importInputRef} type="file" accept="application/json,.json"
                  onChange={onImportFile} style={{ display: 'none' }}
                />
                <button
                  onClick={() => importInputRef.current?.click()}
                  disabled={importBusy}
                  style={{
                    flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    padding: 'var(--eb-space-2) var(--eb-space-1)', background: 'var(--eb-bg-surface)', color: 'var(--eb-text-secondary)',
                    border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                    cursor: importBusy ? 'not-allowed' : 'pointer', opacity: importBusy ? 0.6 : 1,
                    fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                    whiteSpace: 'nowrap',
                  }}
                >
                  <Upload size={15} /> {importBusy ? 'Importing…' : 'Import'}
                </button>
              </div>
              {importError && (
                <div style={{ padding: '0 var(--eb-space-3) var(--eb-space-2)', fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error)' }}>
                  {importError}
                </div>
              )}

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
                    onRename={(name) => renameDraft(d, name)}
                    renameTitle="Rename draft"
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
                pendingImport={pendingImport}
                onImportConsumed={clearPendingImport}
                onImportClosed={closeImportPreview}
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
            // BriefingPack flows render through the unified viewer (#362) — same
            // renderer + model as process graphs, replacing the legacy bp-graph.js.
            <div style={{ height: '100%', position: 'relative' }}>
              <button
                onClick={importBriefings}
                disabled={importing}
                title="Import this BriefingPack hierarchy as an editable process draft"
                style={{
                  position: 'absolute', top: 'var(--eb-space-3)', right: 'var(--eb-space-3)', zIndex: 5,
                  display: 'inline-flex', alignItems: 'center', gap: 6,
                  background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
                  border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                  padding: '6px 12px', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
                  cursor: importing ? 'default' : 'pointer', opacity: importing ? 0.6 : 1,
                  boxShadow: 'var(--eb-shadow-sm)',
                }}
              >
                <Plus size={14} /> {importing ? 'Importing…' : 'Import as draft'}
              </button>
              <FlowGraph
                key={selectedAgent.id}
                workspace={selectedAgent.briefingsPath
                    ? `/workspace/agents/${selectedAgent.id}/${selectedAgent.briefingsPath}`
                    : `/workspace/agents/${selectedAgent.id}`}
              />
            </div>
          )}
        </div>

        {/* AC 2: help panel slide-in overlay */}
        {helpOpen && <HelpPanel onClose={closeHelp} />}
      </div>
    </div>
  );
}
