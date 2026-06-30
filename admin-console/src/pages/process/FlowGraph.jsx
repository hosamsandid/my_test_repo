import React, { useRef, useEffect, useState } from 'react';
import { initProcessGraph } from './process-graph-render';
import { unifiedToRenderGraph } from './unified-render-adapter';

// Unified, read-only flow viewer (#366). Renders any source of the unified
// orchestration graph — live agents (process choreography) or a BriefingPack
// directory (dependency + data-flow) — through the one Process Canvas renderer.
//
//   <FlowGraph workspace="/workspace/agents/<id>/<briefingsPath>" />  // BP source
//   <FlowGraph team="acme" />                                        // live, scoped
//   <FlowGraph />                                                    // all live agents
export function FlowGraph({ workspace, team }) {
  const viewportRef = useRef(null);
  const apiRef = useRef(null);
  const [error, setError] = useState(null);

  // Mount the renderer once; read-only (no onConnect / onSelectEdge).
  useEffect(() => {
    if (!viewportRef.current) return undefined;
    const g = initProcessGraph(viewportRef.current, {});
    g.setEditable(false);
    apiRef.current = g;
    return () => { g.cleanup(); apiRef.current = null; };
  }, []);

  // (Re)load whenever the source changes.
  useEffect(() => {
    const g = apiRef.current;
    if (!g) return undefined;
    const params = new URLSearchParams();
    if (workspace) params.set('workspace', workspace);
    else if (team) params.set('team', team);

    let cancelled = false;
    setError(null);
    fetch(`/api/flows/graph?${params.toString()}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((graph) => { if (!cancelled) g.setData(unifiedToRenderGraph(graph)); })
      .catch((err) => { if (!cancelled) setError(err.message || 'Failed to load graph'); });
    return () => { cancelled = true; };
  }, [workspace, team]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div ref={viewportRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {error && (
        <div style={{
          position: 'absolute', top: 12, left: '50%', transform: 'translateX(-50%)',
          background: 'var(--eb-bg-elevated)', border: '1px solid var(--eb-status-error)',
          color: 'var(--eb-status-error)', borderRadius: 6, padding: '6px 12px',
          fontSize: 'var(--eb-text-xs)', zIndex: 30,
        }}>
          Could not load flow: {error}
        </div>
      )}
    </div>
  );
}
