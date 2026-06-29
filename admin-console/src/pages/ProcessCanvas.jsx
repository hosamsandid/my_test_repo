import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { GitBranch, AlertTriangle, Download, Upload, Boxes, X, Plus, ShieldCheck } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { initProcessGraph } from './process/process-graph-render';
import ProcessNodeInspector from './process/ProcessNodeInspector';
import DraftNodeInspector from './process/DraftNodeInspector';
import { CreateHandoffDialog, EditHandoffDialog } from './process/EdgeDialogs';
import MaterializeDialog from './process/MaterializeDialog';
import AddApprovalDialog from './process/AddApprovalDialog';
import SidePanel from '../components/SidePanel';
import { liveOps, makeDraftOps } from './process/edit-adapters';

// Process Canvas (#330) — data-driven view of the agent orchestration: which
// agent reacts to which label, in what order. Read-only render here; the node
// inspector (#331) and edge modeling (#332) build on the same renderer.
export default function ProcessCanvas() {
  const { teamId } = useParams();
  const [searchParams] = useSearchParams();
  // Scope: 'all' (whole fleet, live), a team id (live, scoped), or 'templates'.
  const [scope, setScope] = useState(teamId || searchParams.get('scope') || 'all');

  useEffect(() => { if (teamId) setScope(teamId); }, [teamId]);

  const { data: agents } = useApi('/api/agents');
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter(a => a.role === 'team') : []),
    [agents],
  );

  // Drafts (#345): a process being authored from scratch. Scope `draft:<id>`.
  const { data: draftsList, refetch: refetchDrafts } = useApi('/api/process/drafts');
  const draftId = scope.startsWith('draft:') ? scope.slice(6) : null;
  const isDraft = !!draftId;

  const graphUrl = scope === 'templates'
    ? '/api/process/graph?templates=1'
    : scope === 'all'
      ? '/api/process/graph'
      : isDraft
        ? null
        : `/api/process/graph?team=${encodeURIComponent(scope)}`;
  const { data: graph, loading, error, refetch } = useApi(graphUrl || '/api/process/graph?templates=__none__');

  // An imported bundle (#334) overrides the fetched graph until closed — shown
  // as a read-only blueprint that can be materialised into a real team.
  const [imported, setImported] = useState(null); // { bundle, graph }
  const [importError, setImportError] = useState(null);
  const [materializeOpen, setMaterializeOpen] = useState(false);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [approvalOpen, setApprovalOpen] = useState(false);
  const fileInputRef = useRef(null);

  // Draft bundle + its derived graph. The bundle is the source of truth; the
  // graph is recomputed server-side from it on every change.
  const [draftBundle, setDraftBundle] = useState(null);
  const [draftGraph, setDraftGraph] = useState(null);
  const draftBundleRef = useRef(null);

  useEffect(() => {
    if (!draftId) { draftBundleRef.current = null; setDraftBundle(null); setDraftGraph(null); return; }
    let alive = true;
    apiCall('GET', `/api/process/drafts/${draftId}`)
      .then(b => { if (alive) { draftBundleRef.current = b; setDraftBundle(b); } })
      .catch(e => { if (alive) setImportError(e.message); });
    return () => { alive = false; };
  }, [draftId]);

  useEffect(() => {
    if (!draftBundle) return;
    let alive = true;
    apiCall('POST', '/api/process/graph', { processTemplate: draftBundle })
      .then(g => { if (alive) setDraftGraph(g); }).catch(() => {});
    return () => { alive = false; };
  }, [draftBundle]);

  const persistDraft = useCallback(async (next) => {
    const saved = await apiCall('PUT', `/api/process/drafts/${draftId}`, next);
    draftBundleRef.current = saved;
    setDraftBundle(saved);
    refetchDrafts();
  }, [draftId, refetchDrafts]);

  const draftOps = useMemo(
    () => makeDraftOps(() => draftBundleRef.current, persistDraft),
    [persistDraft],
  );
  const ops = isDraft ? draftOps : liveOps;

  const displayGraph = imported ? imported.graph : isDraft ? draftGraph : graph;

  const [selectedId, setSelectedId] = useState(null);
  const [connectPair, setConnectPair] = useState(null); // { from, to }
  const [selectedEdge, setSelectedEdge] = useState(null);
  const viewportRef = useRef(null);
  const graphRef = useRef(null);
  const editableRef = useRef(true);

  useEffect(() => {
    if (!viewportRef.current) return;
    const g = initProcessGraph(viewportRef.current, {
      onSelectNode: (id) => setSelectedId(id),
      onConnect: (from, to) => { if (editableRef.current) setConnectPair({ from, to }); },
      onSelectEdge: (edge) => { if (editableRef.current) setSelectedEdge(edge); },
    });
    graphRef.current = g;
    return () => { g.cleanup(); graphRef.current = null; };
  }, []);

  useEffect(() => {
    if (!graphRef.current || !displayGraph) return;
    // Drafts and live teams are editable; the template blueprint + imported
    // previews are read-only. (A draft's derived graph reports level 'template',
    // so drive editability off the mode, not the level.)
    const ed = isDraft ? true : (!imported && displayGraph.level !== 'template');
    editableRef.current = ed;
    graphRef.current.setEditable(ed);
    graphRef.current.setData(displayGraph);
  }, [displayGraph, imported, isDraft]);

  // Clear selection/dialogs when the scope (and thus the graph) changes.
  useEffect(() => { setSelectedId(null); setConnectPair(null); setSelectedEdge(null); }, [scope, imported]);

  const nodeName = (id) => (displayGraph?.nodes || []).find(n => n.id === id)?.displayName || id;
  const selectedNode = useMemo(
    () => (displayGraph?.nodes || []).find(n => n.id === selectedId) || null,
    [displayGraph, selectedId],
  );
  const selectedRole = isDraft && draftBundle
    ? (draftBundle.roles || []).find(r => r.id === selectedId) || null
    : null;

  async function handleScopeChange(v) {
    if (v === '__new__') {
      try {
        const d = await apiCall('POST', '/api/process/drafts', { name: 'Untitled process' });
        refetchDrafts();
        setScope(`draft:${d.id}`);
      } catch (e) { setImportError(e.message); }
      return;
    }
    setScope(v);
  }

  function afterEdit() { if (!isDraft) refetch(); /* draft re-derives via persist */ }

  async function exportBundle() {
    let bundle;
    if (isDraft) {
      bundle = draftBundle;
    } else {
      const url = scope === 'templates' ? '/api/process/template?templates=1'
        : scope === 'all' ? '/api/process/template'
          : `/api/process/template?team=${encodeURIComponent(scope)}`;
      const res = await fetch(url);
      if (!res.ok) { setImportError(`Export failed: HTTP ${res.status}`); return; }
      bundle = await res.json();
    }
    if (!bundle) return;
    const blob = new Blob([JSON.stringify(bundle, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${(bundle.name || 'process').replace(/[^a-z0-9._-]/gi, '-')}.process.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  async function onImportFile(e) {
    setImportError(null);
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-importing the same file
    if (!file) return;
    let bundle;
    try { bundle = JSON.parse(await file.text()); }
    catch { setImportError('Not valid JSON.'); return; }
    try {
      const res = await fetch('/api/process/graph', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ processTemplate: bundle }),
      });
      const g = await res.json();
      if (!res.ok) { setImportError(g.error || `HTTP ${res.status}`); return; }
      setImported({ bundle, graph: g });
      setSelectedId(null);
    } catch (err) {
      setImportError(err.message);
    }
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: 'calc(100vh - var(--eb-header-height) - 2 * var(--eb-space-6))', minHeight: 480 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 'var(--eb-space-4)', marginBottom: 'var(--eb-space-4)', flexShrink: 0 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <GitBranch size={20} style={{ color: 'var(--eb-accent-primary)' }} />
          <div>
            <h1 style={{ margin: 0, fontSize: 'var(--eb-text-lg)', fontWeight: 'var(--eb-font-semibold)', color: 'var(--eb-text-primary)' }}>
              Process Canvas
            </h1>
            <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
              {scope === 'templates'
                ? 'Blueprint view (read-only). Switch scope to a team or draft to model.'
                : isDraft
                  ? 'Draft — design from scratch: + Add role, drag the ● port to wire, click nodes/edges to edit. Nothing is created until you materialize.'
                  : 'Click a node to edit · drag the ● port to wire a hand-off · click an edge to edit it.'}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          {isDraft && (
            <>
              <ToolbarButton onClick={() => setAddRoleOpen('agent')} icon={Plus}>Add role</ToolbarButton>
              <ToolbarButton onClick={() => setAddRoleOpen('pr-review')} icon={Plus}>PR review</ToolbarButton>
              <ToolbarButton onClick={() => setApprovalOpen(true)} icon={ShieldCheck}>Human approval</ToolbarButton>
            </>
          )}
          <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onImportFile} style={{ display: 'none' }} />
          <ToolbarButton onClick={() => fileInputRef.current?.click()} icon={Upload}>Import</ToolbarButton>
          <ToolbarButton onClick={exportBundle} icon={Download} disabled={!!imported}>Export</ToolbarButton>
          <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Scope
            <select
              value={scope}
              onChange={e => handleScopeChange(e.target.value)}
              disabled={!!imported}
              style={{
                background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
                border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
                padding: 'var(--eb-space-1) var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
                opacity: imported ? 0.5 : 1,
              }}
            >
              <option value="all">All agents (live)</option>
              {teams.length > 0 && (
                <optgroup label="Teams (live)">
                  {teams.map(t => (
                    <option key={t.id} value={t.id}>{t.displayName || t.id}</option>
                  ))}
                </optgroup>
              )}
              <option value="templates">Role templates (blueprint)</option>
              {Array.isArray(draftsList) && draftsList.length > 0 && (
                <optgroup label="Drafts">
                  {draftsList.map(d => (
                    <option key={d.id} value={`draft:${d.id}`}>{d.name} ({d.roleCount})</option>
                  ))}
                </optgroup>
              )}
              <option value="__new__">＋ New process…</option>
            </select>
          </label>
        </div>
      </div>

      {/* Imported-bundle banner */}
      {imported && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--eb-space-3)', marginBottom: 'var(--eb-space-3)',
          padding: 'var(--eb-space-2) var(--eb-space-3)', flexShrink: 0,
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
        }}>
          <Boxes size={16} style={{ color: 'var(--eb-accent-primary)' }} />
          <span style={{ flex: 1, fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            Imported blueprint <strong>{imported.bundle?.name}</strong> ({imported.graph?.nodes?.length || 0} roles) — read-only preview.
          </span>
          <button onClick={() => setMaterializeOpen(true)} style={{
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>Materialize as team…</button>
          <button onClick={() => { setImported(null); setSelectedId(null); }} title="Close blueprint" style={{
            background: 'none', border: 'none', color: 'var(--eb-text-secondary)', cursor: 'pointer', display: 'flex',
          }}><X size={16} /></button>
        </div>
      )}
      {importError && (
        <div style={{ marginBottom: 'var(--eb-space-3)', color: 'var(--eb-status-error)', fontSize: 'var(--eb-text-sm)' }}>{importError}</div>
      )}

      {/* Graph viewport */}
      <div style={{ position: 'relative', flex: 1, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)', background: 'var(--eb-bg-app)', overflow: 'hidden' }}>
        <div ref={viewportRef} style={{ width: '100%', height: '100%' }} />
        {!displayGraph && !error && (
          <Overlay>Loading graph…</Overlay>
        )}
        {!isDraft && !imported && error && (
          <Overlay tone="error">Could not load graph: {error}</Overlay>
        )}

        <LintsPanel
          lints={displayGraph?.lints || []}
          onFocus={(nodeId) => { if (nodeId) { setSelectedId(nodeId); graphRef.current?.setSelected(nodeId); } }}
        />
      </div>

      {/* Inspector — draft roles use the lightweight draft inspector. */}
      {isDraft && selectedRole && (
        <DraftNodeInspector
          key={selectedRole.id}
          role={selectedRole}
          roles={draftBundle?.roles || []}
          ops={draftOps}
          onClose={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onDeleted={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onChanged={() => {}}
        />
      )}
      {!isDraft && selectedNode && (
        <ProcessNodeInspector
          key={selectedNode.id}
          node={selectedNode}
          level={imported ? 'template' : displayGraph?.level}
          onClose={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onChanged={() => refetch()}
        />
      )}

      {connectPair && (
        <CreateHandoffDialog
          from={connectPair.from}
          to={connectPair.to}
          fromName={nodeName(connectPair.from)}
          toName={nodeName(connectPair.to)}
          labels={displayGraph?.labels || []}
          ops={ops}
          onClose={() => setConnectPair(null)}
          onDone={() => { setConnectPair(null); afterEdit(); }}
        />
      )}

      {selectedEdge && (
        <EditHandoffDialog
          edge={selectedEdge}
          fromName={nodeName(selectedEdge.from)}
          toName={nodeName(selectedEdge.to)}
          ops={ops}
          onClose={() => setSelectedEdge(null)}
          onDone={() => { setSelectedEdge(null); afterEdit(); }}
        />
      )}

      {addRoleOpen && isDraft && (
        <AddRoleDialog
          kind={addRoleOpen}
          onClose={() => setAddRoleOpen(false)}
          onCreate={async ({ displayName, systemPrompt }) => {
            const id = await draftOps.addRole({ displayName, systemPrompt, kind: addRoleOpen === 'pr-review' ? 'pr-review' : undefined });
            setAddRoleOpen(false);
            setSelectedId(id);
          }}
        />
      )}

      {approvalOpen && isDraft && (
        <AddApprovalDialog
          roles={draftBundle?.roles || []}
          onClose={() => setApprovalOpen(false)}
          onCreate={async ({ label, description, downstream }) => {
            // The downstream step waits on the gate label; a human sets it.
            await draftOps.createTrigger(downstream, {
              type: 'github-event',
              events: ['issues.labeled', 'pull_request.labeled'],
              from: 'humans',
              labelFilter: label,
              enabled: true,
              description: description || `Human approval: ${label}`,
              prompt: `A human granted the approval \`${label}\` (the label was added). Proceed with your part of the process. Reply \`[PASS]\` if there is nothing to do yet.`,
            });
            setApprovalOpen(false);
          }}
        />
      )}

      {materializeOpen && imported && (
        <MaterializeDialog
          bundle={imported.bundle}
          onClose={() => setMaterializeOpen(false)}
          onDone={() => { setMaterializeOpen(false); setImported(null); }}
        />
      )}
    </div>
  );
}

function AddRoleDialog({ kind, onClose, onCreate }) {
  const isReview = kind === 'pr-review';
  const [displayName, setDisplayName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try { await onCreate({ displayName: displayName.trim(), systemPrompt }); }
    finally { setBusy(false); }
  };
  const field = {
    background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
    boxSizing: 'border-box', width: '100%', outline: 'none',
  };
  return (
    <SidePanel open onClose={onClose} title={isReview ? 'Add PR-review step' : 'Add role'} width="480px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>{isReview ? 'Reviewer name' : 'Role name'}</span>
          <input autoFocus value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder={isReview ? 'e.g. Code Reviewer' : 'e.g. Business Analyst'} style={field}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        </label>
        {isReview ? (
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
            A PR-review step submits a native Approve / Request-changes review. After adding it,
            point it at a producer and wire the outcomes in the inspector.
          </div>
        ) : (
          <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>System prompt (optional now)</span>
            <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
              placeholder="What this role does…" style={{ ...field, minHeight: 160, resize: 'vertical', fontFamily: 'var(--eb-font-mono)' }} />
          </label>
        )}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={busy} style={{
            background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={submit} disabled={busy || !displayName.trim()} style={{
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>{isReview ? 'Add PR review' : 'Add role'}</button>
        </div>
      </div>
    </SidePanel>
  );
}

function ToolbarButton({ onClick, icon: Icon, disabled, children }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{
      display: 'inline-flex', alignItems: 'center', gap: 6,
      background: 'var(--eb-bg-surface)', color: 'var(--eb-text-secondary)',
      border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
      padding: 'var(--eb-space-1) var(--eb-space-3)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
      cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
    }}>
      <Icon size={14} /> {children}
    </button>
  );
}

function LintsPanel({ lints, onFocus }) {
  const [open, setOpen] = useState(false);
  if (!lints || lints.length === 0) return null;
  const errors = lints.filter(l => l.severity === 'error').length;
  const accent = errors > 0 ? 'var(--eb-status-error)' : 'var(--eb-status-warning)';

  return (
    <div style={{ position: 'absolute', top: 12, right: 12, zIndex: 20, maxWidth: 360 }}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          display: 'flex', alignItems: 'center', gap: 6,
          background: 'var(--eb-bg-elevated)', border: `1px solid ${accent}`,
          color: accent, borderRadius: 'var(--eb-radius-md)', padding: '4px 10px',
          fontSize: 'var(--eb-text-sm)', fontFamily: 'inherit', cursor: 'pointer',
          marginLeft: 'auto',
        }}
      >
        <AlertTriangle size={14} />
        {lints.length} issue{lints.length === 1 ? '' : 's'}{errors > 0 ? ` · ${errors} error${errors === 1 ? '' : 's'}` : ''}
      </button>
      {open && (
        <div style={{
          marginTop: 6, background: 'var(--eb-bg-surface)', border: '1px solid var(--eb-border-default)',
          borderRadius: 'var(--eb-radius-md)', boxShadow: 'var(--eb-shadow-lg)', maxHeight: '50vh', overflowY: 'auto',
        }}>
          {lints.map((l, i) => (
            <button
              key={i}
              onClick={() => onFocus(l.nodeId)}
              title={l.nodeId ? 'Focus node' : undefined}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                background: 'none', border: 'none', borderTop: i ? '1px solid var(--eb-border-default)' : 'none',
                padding: 'var(--eb-space-2) var(--eb-space-3)', cursor: l.nodeId ? 'pointer' : 'default',
                fontFamily: 'inherit', color: 'var(--eb-text-secondary)', fontSize: 'var(--eb-text-sm)',
              }}
            >
              <span style={{
                color: l.severity === 'error' ? 'var(--eb-status-error)' : 'var(--eb-status-warning)',
                fontSize: 'var(--eb-text-xs)', fontWeight: 'var(--eb-font-medium)', textTransform: 'uppercase',
              }}>{l.code}</span>
              <div style={{ marginTop: 2, lineHeight: 1.4 }}>{stripTicks(l.message)}</div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stripTicks(s) { return typeof s === 'string' ? s.replace(/`/g, '') : s; }

function Overlay({ children, tone }) {
  return (
    <div style={{
      position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
      pointerEvents: 'none', color: tone === 'error' ? 'var(--eb-status-error)' : 'var(--eb-text-muted)',
      fontSize: 'var(--eb-text-sm)',
    }}>
      {children}
    </div>
  );
}
