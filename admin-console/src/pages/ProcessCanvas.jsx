import React, { useRef, useEffect, useState, useMemo, useCallback } from 'react';
import { AlertTriangle, Download, Upload, Boxes, X, Plus, Layers, Sparkles, Pencil } from 'lucide-react';
import { useApi, apiCall } from '../hooks/useApi';
import { initFlowGraph } from './process/flow-graph-render';
import ProcessNodeInspector from './process/ProcessNodeInspector';
import DraftNodeInspector from './process/DraftNodeInspector';
import StageManager from './process/StageManager';
import { EditHandoffDialog, CreateEdgeDialog } from './process/EdgeDialogs';
import MaterializeDialog from './process/MaterializeDialog';
import SidePanel from '../components/SidePanel';
import { liveOps, makeDraftOps } from './process/edit-adapters';
import { capabilitiesFor, processMode, createTypesFor, sourceKindOf } from './process/connection-capabilities';

// Display names for the actor pseudo-nodes (#411) — the graph carries them as
// nodes when they have edges, but a drag can also start from a placeholder.
// (@human/@timer are gone: human actions are GitHub label events, schedules
// render inside the agent card.)
const ACTOR_NAMES = { '@github': 'GitHub', '@external': 'External system', '@timer': 'Schedule' };

// Inline-editable process name for the draft toolbar. Click to edit; Enter or
// blur commits, Escape reverts. Renaming only touches the bundle's display
// `name` — the storage id is fixed at creation.
function EditableDraftTitle({ name, onRename }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(name || '');
  const inputRef = useRef(null);
  useEffect(() => { setValue(name || ''); }, [name]);
  useEffect(() => {
    if (editing && inputRef.current) { inputRef.current.focus(); inputRef.current.select(); }
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = value.trim();
    if (trimmed && trimmed !== name) onRename(trimmed);
    else setValue(name || '');
  };

  if (editing) {
    return (
      <input
        ref={inputRef}
        value={value}
        onChange={e => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); setValue(name || ''); setEditing(false); }
        }}
        maxLength={80}
        style={{
          fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)',
          color: 'var(--eb-text-primary)', background: 'var(--eb-bg-surface)',
          border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-sm)',
          padding: '2px 6px', fontFamily: 'inherit', maxWidth: 320, width: '100%',
        }}
      />
    );
  }

  return (
    <button
      onClick={() => setEditing(true)}
      title="Rename draft"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: 360,
        background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer',
        fontFamily: 'inherit', color: 'var(--eb-text-primary)',
        fontSize: 'var(--eb-text-md)', fontWeight: 'var(--eb-font-semibold)',
      }}
    >
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {name || 'Untitled process'}
      </span>
      <Pencil size={13} style={{ flexShrink: 0, color: 'var(--eb-text-muted)' }} />
    </button>
  );
}

// Process graph panel (#330) — data-driven view of the agent orchestration:
// which agent reacts to which label, in what order. Embedded into the Flows
// view; the scope (a team id, 'templates', or 'draft:<id>') is supplied by the
// parent, which also owns the scope picker (the left Flows list). The node
// inspector (#331) and edge modeling (#332) build on the same renderer.
//
// Props:
//   scope           — '<teamId>' | 'templates' | 'draft:<id>'
//   onNavigate(s)   — switch scope (e.g. after creating/opening a draft)
//   onDraftsChanged — notify the parent that the drafts list changed (counts)
export function ProcessGraphPanel({ scope, onNavigate, onDraftsChanged }) {
  const navigate = useCallback((s) => { if (onNavigate) onNavigate(s); }, [onNavigate]);

  const { data: agents } = useApi('/api/agents');
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter(a => a.role === 'team') : []),
    [agents],
  );

  // Drafts (#345): a process being authored from scratch. Scope `draft:<id>`.
  const draftId = scope && scope.startsWith('draft:') ? scope.slice(6) : null;
  const isDraft = !!draftId;
  const isTeamScope = useMemo(
    () => Array.isArray(teams) && teams.some(t => t.id === scope),
    [teams, scope],
  );

  // Scope is always one of: a team id (live graph), 'templates' (blueprint),
  // or 'draft:<id>' (derived client-side from the bundle, so no fetch).
  // All scopes feed the unified rich renderer (#362 UI rework C3).
  const graphUrl = scope === 'templates'
    ? '/api/flows/graph?templates=1'
    : isDraft
      ? null
      : `/api/flows/graph?team=${encodeURIComponent(scope)}`;
  const { data: graph, loading, error, refetch } = useApi(graphUrl || '/api/flows/graph?templates=__none__');

  // An imported bundle (#334) overrides the fetched graph until closed — shown
  // as a read-only blueprint that can be materialised into a real team.
  const [imported, setImported] = useState(null); // { bundle, graph }
  const [importError, setImportError] = useState(null);
  const [materializeOpen, setMaterializeOpen] = useState(false);
  const [addRoleOpen, setAddRoleOpen] = useState(false);
  const [stagesOpen, setStagesOpen] = useState(false);
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
    // Derive the unified graph from the bundle — the rich renderer consumes it
    // directly (label + dependency + artifact edges + the content/prompt).
    apiCall('POST', '/api/flows/graph', { processTemplate: draftBundle })
      .then(g => { if (alive) setDraftGraph(g); }).catch(() => {});
    return () => { alive = false; };
  }, [draftBundle]);

  const persistDraft = useCallback(async (next) => {
    const saved = await apiCall('PUT', `/api/process/drafts/${draftId}`, next);
    draftBundleRef.current = saved;
    setDraftBundle(saved);
    if (onDraftsChanged) onDraftsChanged();
  }, [draftId, onDraftsChanged]);

  const draftOps = useMemo(
    () => makeDraftOps(() => draftBundleRef.current, persistDraft),
    [persistDraft],
  );
  const ops = isDraft ? draftOps : liveOps;

  const displayGraph = imported ? imported.graph : isDraft ? draftGraph : graph;

  const [selectedId, setSelectedId] = useState(null);
  const [connectPair, setConnectPair] = useState(null); // { from, to } — from may be an actor id (#411)
  const [selectedEdge, setSelectedEdge] = useState(null);
  const viewportRef = useRef(null);
  const graphRef = useRef(null);
  const editableRef = useRef(true);
  // Current inline-prompt save handler (draft only) — kept in a ref so the
  // renderer, created once, always calls the live one.

  useEffect(() => {
    if (!viewportRef.current) return;
    const g = initFlowGraph(viewportRef.current, {
      onSelectNode: (id) => setSelectedId(id),
      onConnect: (from, to) => { if (editableRef.current) setConnectPair({ from, to }); },
      onSelectEdge: (edge) => { if (editableRef.current) setSelectedEdge(edge); },
      actorSources: true, // offer @github/@external as drag sources (#411)
      expandChildrenByDefault: true, // process flows show the whole team; parents collapse on demand
    });
    graphRef.current = g;
    return () => { g.cleanup(); graphRef.current = null; };
  }, []);

  // What this view may do with connections — resolved once per scope from the
  // capability matrix (#409). A draft's derived graph reports level 'template',
  // so the mode is driven off the scope, not the level.
  const caps = useMemo(
    () => capabilitiesFor(processMode({ isDraft, imported, level: displayGraph?.level })),
    [isDraft, imported, displayGraph],
  );

  useEffect(() => {
    if (!graphRef.current || !displayGraph) return;
    editableRef.current = caps.editable;
    graphRef.current.setEditable(caps.editable);
    // Prompt/stage editing happens in the right inspector (DraftNodeInspector),
    // consistent with BP flows — there is no inline editing.
    graphRef.current.setData(displayGraph);
  }, [displayGraph, imported, isDraft, caps]);

  // Clear selection/dialogs when the scope (and thus the graph) changes. A
  // scope change from the parent also drops any imported blueprint preview.
  useEffect(() => { setSelectedId(null); setConnectPair(null); setSelectedEdge(null); }, [scope, imported]);
  useEffect(() => { setImported(null); setImportError(null); }, [scope]);

  const nodeName = (id) =>
    (displayGraph?.nodes || []).find(n => n.id === id)?.displayName || ACTOR_NAMES[id] || id;
  const selectedNode = useMemo(
    () => (displayGraph?.nodes || []).find(n => n.id === selectedId) || null,
    [displayGraph, selectedId],
  );
  const selectedRole = isDraft && draftBundle
    ? (draftBundle.roles || []).find(r => r.id === selectedId) || null
    : null;

  function afterEdit() { if (!isDraft) refetch(); /* draft re-derives via persist */ }

  // Round-trip (#348): open a live team as an editable draft copy.
  async function editAsDraft() {
    try {
      const res = await fetch(`/api/process/template?team=${encodeURIComponent(scope)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const tpl = await res.json();
      const d = await apiCall('POST', '/api/process/drafts', {
        name: `${tpl.name || scope} (draft)`,
        processTemplate: { ...tpl, sourceTeamId: scope },
      });
      if (onDraftsChanged) onDraftsChanged();
      navigate(`draft:${d.id}`);
    } catch (e) { setImportError(e.message); }
  }

  // Continue an imported blueprint as an editable draft instead of materializing
  // straight away — turns the read-only preview into a real draft you can keep
  // building on before creating a team.
  async function continueImportAsDraft() {
    if (!imported?.bundle) return;
    try {
      const tpl = imported.bundle;
      const d = await apiCall('POST', '/api/process/drafts', {
        name: tpl.name || 'Imported process',
        processTemplate: tpl,
      });
      if (onDraftsChanged) onDraftsChanged();
      setImported(null);
      setSelectedId(null);
      navigate(`draft:${d.id}`);
    } catch (e) { setImportError(e.message); }
  }

  // Source bundle for the Materialize dialog: an imported file or the open draft.
  const materializeBundle = imported ? imported.bundle : isDraft ? draftBundle : null;

  async function exportBundle() {
    let bundle;
    if (isDraft) {
      bundle = draftBundle;
    } else {
      const url = scope === 'templates' ? '/api/process/template?templates=1'
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
      const res = await fetch('/api/flows/graph', {
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
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {/* Toolbar — the scope picker lives in the Flows left list, not here. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', padding: 'var(--eb-space-3) var(--eb-space-4)', borderBottom: '1px solid var(--eb-border-default)', flexShrink: 0, flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 2 }}>
          {isDraft && draftBundle && (
            <EditableDraftTitle name={draftBundle.name} onRename={(n) => draftOps.renameDraft(n)} />
          )}
          <div style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
            {caps.readOnlyHint
              ? `${caps.readOnlyHint}${scope === 'templates' ? ' Select a team or draft on the left to model.' : ''}`
              : isDraft
                ? 'Draft — design from scratch: + Add role, drag the ● port (roles and sources) to wire, click nodes/edges to edit. Nothing is created until you materialize.'
                : 'Click a node to edit · drag the ● port (roles and sources) to wire a connection · click an edge to edit it.'}
          </div>
        </div>
        {isDraft && (
          <>
            <ToolbarButton onClick={() => setAddRoleOpen(true)} icon={Plus}>Add role</ToolbarButton>
            <ToolbarButton onClick={() => setStagesOpen(true)} icon={Layers}>Stages</ToolbarButton>
            <ToolbarButton onClick={() => setMaterializeOpen(true)} icon={Boxes}
              disabled={!draftBundle?.roles?.length}>Materialize…</ToolbarButton>
          </>
        )}
        {isTeamScope && !imported && (
          <ToolbarButton onClick={editAsDraft} icon={Boxes}>Edit as draft</ToolbarButton>
        )}
        <input ref={fileInputRef} type="file" accept="application/json,.json" onChange={onImportFile} style={{ display: 'none' }} />
        <ToolbarButton onClick={() => fileInputRef.current?.click()} icon={Upload}>Import</ToolbarButton>
        <ToolbarButton onClick={exportBundle} icon={Download} disabled={!!imported}>Export</ToolbarButton>
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
          <button onClick={continueImportAsDraft} style={{
            background: 'none', color: 'var(--eb-accent-primary)', border: '1px solid var(--eb-accent-primary)',
            borderRadius: 'var(--eb-radius-md)', padding: '4px 12px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
            fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>Continue as draft</button>
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
          stages={draftBundle?.stages || []}
          ops={draftOps}
          onClose={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onDeleted={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onRenamedId={(nid) => { setSelectedId(nid); graphRef.current?.setSelected(nid); }}
          onChanged={() => {}}
        />
      )}
      {!isDraft && selectedNode && (
        <ProcessNodeInspector
          key={selectedNode.id}
          node={selectedNode}
          nodes={displayGraph?.nodes || []}
          level={imported ? 'template' : displayGraph?.level}
          onClose={() => { setSelectedId(null); graphRef.current?.setSelected(null); }}
          onChanged={() => refetch()}
        />
      )}

      {/* The ONE connect dialog (#411) for both draft and live teams: the drag
          source (agent or actor) picks the type set via the capability matrix —
          only the ops adapter differs underneath. */}
      {connectPair && (
        <CreateEdgeDialog
          from={connectPair.from}
          to={connectPair.to}
          fromName={nodeName(connectPair.from)}
          toName={nodeName(connectPair.to)}
          labels={displayGraph?.labels || []}
          ops={ops}
          types={createTypesFor(caps, sourceKindOf(connectPair.from))}
          fromNode={(displayGraph?.nodes || []).find(n => n.id === connectPair.from) || null}
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
          producerChannelCount={selectedEdge.on === 'github'
            ? (displayGraph?.edges || []).filter(e =>
                e.on === 'github' && e.from === selectedEdge.from && e.artifact === selectedEdge.artifact).length
            : undefined}
          onClose={() => setSelectedEdge(null)}
          onDone={() => { setSelectedEdge(null); afterEdit(); }}
        />
      )}

      {addRoleOpen && isDraft && (
        <AddRoleDialog
          onClose={() => setAddRoleOpen(false)}
          onCreate={async ({ displayName, systemPrompt }) => {
            const id = await draftOps.addRole({ displayName, systemPrompt });
            setAddRoleOpen(false);
            setSelectedId(id);
          }}
        />
      )}

      {stagesOpen && isDraft && (
        <StageManager
          stages={draftBundle?.stages || []}
          counts={(draftBundle?.roles || []).reduce((m, r) => {
            if (r.stage) m[r.stage] = (m[r.stage] || 0) + 1;
            return m;
          }, {})}
          ops={draftOps}
          onClose={() => setStagesOpen(false)}
          onChanged={() => {}}
        />
      )}

      {materializeOpen && materializeBundle && (
        <MaterializeDialog
          bundle={materializeBundle}
          onClose={() => setMaterializeOpen(false)}
          onDone={() => { setMaterializeOpen(false); if (imported) setImported(null); }}
        />
      )}
    </div>
  );
}

function AddRoleDialog({ onClose, onCreate }) {
  const [displayName, setDisplayName] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  // LLM-assisted prompt authoring (see POST /api/agent-prompt/generate).
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState(null);
  const submit = async () => {
    if (!displayName.trim()) return;
    setBusy(true);
    try { await onCreate({ displayName: displayName.trim(), systemPrompt }); }
    finally { setBusy(false); }
  };
  const generate = async () => {
    if (!displayName.trim() || generating) return;
    setGenerating(true);
    setGenError(null);
    try {
      const { prompt } = await apiCall('POST', '/api/agent-prompt/generate', {
        roleName: displayName.trim(), notes: notes.trim(),
      });
      if (prompt) setSystemPrompt(prompt);
    } catch (e) {
      setGenError(e.message || 'Generation failed');
    } finally {
      setGenerating(false);
    }
  };
  const field = {
    background: 'var(--eb-bg-app)', color: 'var(--eb-text-primary)', border: '1px solid var(--eb-border-default)',
    borderRadius: 'var(--eb-radius-md)', padding: 'var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
    boxSizing: 'border-box', width: '100%', outline: 'none',
  };
  return (
    <SidePanel open onClose={onClose} title="Add role" width="480px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--eb-space-3)' }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Role name</span>
          <input autoFocus value={displayName} onChange={e => setDisplayName(e.target.value)}
            placeholder="e.g. Business Analyst" style={field}
            onKeyDown={e => { if (e.key === 'Enter') submit(); }} />
        </label>
        {/* Notes → LLM → agent prompt. The operator jots a few keywords and
            lets the model draft a full prompt; the role name alone is often
            enough context (e.g. "Business Analyst"). The draft lands in the
            editable Agent-prompt field below, so it can be tweaked or replaced. */}
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Notes for prompt generation (optional)</span>
          <textarea value={notes} onChange={e => setNotes(e.target.value)}
            placeholder="A few keywords — e.g. reviews COBOL, flags risky changes, hands off to the migration lead"
            style={{ ...field, minHeight: 64, resize: 'vertical' }} />
          <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-text-muted)', lineHeight: 1.4 }}>
            Generate uses the role name and these notes to draft an agent prompt via the configured LLM.
            You can edit the result below.
          </span>
        </label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)' }}>
          <button type="button" onClick={generate} disabled={!displayName.trim() || generating} style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            background: 'var(--eb-bg-surface)', color: 'var(--eb-accent-primary)',
            border: '1px solid var(--eb-accent-primary)', borderRadius: 'var(--eb-radius-md)',
            padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)',
            cursor: (!displayName.trim() || generating) ? 'not-allowed' : 'pointer',
            opacity: (!displayName.trim() || generating) ? 0.5 : 1,
          }}>
            <Sparkles size={14} />
            {generating ? 'Generating…' : 'Generate agent prompt'}
          </button>
          {genError && (
            <span style={{ fontSize: 'var(--eb-text-xs)', color: 'var(--eb-status-error, #d33)' }}>{genError}</span>
          )}
        </div>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
          <span style={{ fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>Agent prompt (optional now)</span>
          <textarea value={systemPrompt} onChange={e => setSystemPrompt(e.target.value)}
            placeholder="What this role does… — or use Generate above to draft it"
            style={{ ...field, minHeight: 160, resize: 'vertical', fontFamily: 'var(--eb-font-mono)' }} />
        </label>
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 'var(--eb-space-2)' }}>
          <button onClick={onClose} disabled={busy} style={{
            background: 'none', color: 'var(--eb-text-secondary)', border: '1px solid var(--eb-border-default)',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', cursor: 'pointer',
          }}>Cancel</button>
          <button onClick={submit} disabled={busy || !displayName.trim()} style={{
            background: 'var(--eb-accent-primary)', color: 'var(--eb-text-inverted)', border: 'none',
            borderRadius: 'var(--eb-radius-md)', padding: '6px 14px', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)', fontWeight: 'var(--eb-font-medium)', cursor: 'pointer',
          }}>Add role</button>
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
