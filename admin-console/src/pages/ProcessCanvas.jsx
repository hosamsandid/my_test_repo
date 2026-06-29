import React, { useRef, useEffect, useState, useMemo } from 'react';
import { useParams } from 'react-router-dom';
import { GitBranch } from 'lucide-react';
import { useApi } from '../hooks/useApi';
import { initProcessGraph } from './process/process-graph-render';
import ProcessNodeInspector from './process/ProcessNodeInspector';

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
  const viewportRef = useRef(null);
  const graphRef = useRef(null);

  useEffect(() => {
    if (!viewportRef.current) return;
    const g = initProcessGraph(viewportRef.current, {
      onSelectNode: (id) => setSelectedId(id),
    });
    graphRef.current = g;
    return () => { g.cleanup(); graphRef.current = null; };
  }, []);

  useEffect(() => {
    if (graphRef.current && graph) graphRef.current.setData(graph);
  }, [graph]);

  // Clear selection when the scope (and thus the graph) changes.
  useEffect(() => { setSelectedId(null); }, [graphUrl]);

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
              Agents wired by the labels they emit and react to.
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
    </div>
  );
}

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
