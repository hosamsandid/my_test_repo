import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { GitBranch, AlertTriangle } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { initProcessGraph } from './process/process-graph-render';
import ProcessNodeInspector from './process/ProcessNodeInspector';
import { CreateHandoffDialog, EditHandoffDialog } from './process/EdgeDialogs';

// Process Canvas (#330) — data-driven view of the agent orchestration: which
// agent reacts to which label, in what order. Read-only render here; the node
// inspector (#331) and edge modeling (#332) build on the same renderer.
export default function ProcessCanvas() {
  const { teamId } = useParams();
  // Scope: 'all' (whole fleet, live), a team id (live, scoped), or 'templates'.
  const [scope, setScope] = useState(teamId || 'all');

  useEffect(() => { if (teamId) setScope(teamId); }, [teamId]);

  const { data: agents } = useApi('/api/agents');
  const teams = useMemo(
    () => (Array.isArray(agents) ? agents.filter(a => a.role === 'team') : []),
    [agents],
  );

  const graphUrl = scope === 'templates'
    ? '/api/process/graph?templates=1'
    : scope === 'all'
      ? '/api/process/graph'
      : `/api/process/graph?team=${encodeURIComponent(scope)}`;
  const { data: graph, loading, error, refetch } = useApi(graphUrl);

  const [selectedId, setSelectedId] = useState(null);
  const [connectPair, setConnectPair] = useState(null); // { from, to }
  const [selectedEdge, setSelectedEdge] = useState(null);
  const viewportRef = useRef(null);
  const graphRef = useRef(null);
  const editableRef = useRef(true); // template level is read-only

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
    if (!graphRef.current || !graph) return;
    editableRef.current = graph.level !== 'template';
    graphRef.current.setEditable(editableRef.current);
    graphRef.current.setData(graph);
  }, [graph]);

  // Clear selection/dialogs when the scope (and thus the graph) changes.
  useEffect(() => { setSelectedId(null); setConnectPair(null); setSelectedEdge(null); }, [graphUrl]);

  const nodeName = (id) => (graph?.nodes || []).find(n => n.id === id)?.displayName || id;
  const selectedNode = useMemo(
    () => (graph?.nodes || []).find(n => n.id === selectedId) || null,
    [graph, selectedId],
  );

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
                ? 'Blueprint view (read-only). Switch scope to a team to model.'
                : 'Click a node to edit · drag the ● port to wire a hand-off · click an edge to edit it.'}
            </div>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 'var(--eb-space-2)', fontSize: 'var(--eb-text-sm)', color: 'var(--eb-text-secondary)' }}>
          Scope
          <select
            value={scope}
            onChange={e => setScope(e.target.value)}
            style={{
              background: 'var(--eb-bg-surface)', color: 'var(--eb-text-primary)',
              border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-md)',
              padding: 'var(--eb-space-1) var(--eb-space-2)', fontFamily: 'inherit', fontSize: 'var(--eb-text-sm)',
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
          </select>
        </label>
      </div>

      {/* Graph viewport */}
      <div style={{ position: 'relative', flex: 1, border: '1px solid var(--eb-border-default)', borderRadius: 'var(--eb-radius-lg)', background: 'var(--eb-bg-app)', overflow: 'hidden' }}>
        <div ref={viewportRef} style={{ width: '100%', height: '100%' }} />
        {loading && !graph && (
          <Overlay>Loading graph…</Overlay>
        )}
        {error && (
          <Overlay tone="error">Could not load graph: {error}</Overlay>
        )}

        <LintsPanel
          lints={graph?.lints || []}
          onFocus={(nodeId) => { if (nodeId) { setSelectedId(nodeId); graphRef.current?.setSelected(nodeId); } }}
        />
      </div>

      {selectedNode && (
        <ProcessNodeInspector
          key={selectedNode.id}
          node={selectedNode}
          level={graph?.level}
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
          labels={graph?.labels || []}
          onClose={() => setConnectPair(null)}
          onDone={() => { setConnectPair(null); refetch(); }}
        />
      )}

      {selectedEdge && (
        <EditHandoffDialog
          edge={selectedEdge}
          fromName={nodeName(selectedEdge.from)}
          toName={nodeName(selectedEdge.to)}
          onClose={() => setSelectedEdge(null)}
          onDone={() => { setSelectedEdge(null); refetch(); }}
        />
      )}
    </div>
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
