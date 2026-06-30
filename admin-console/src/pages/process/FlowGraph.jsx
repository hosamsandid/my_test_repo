import React, { useRef, useEffect, useCallback, useState } from 'react';
import { initFlowGraph } from './flow-graph-render';
import { makeBpOps } from './edit-adapters';

// Unified flow viewer (#362, UI rework). Renders any source of the unified
// orchestration graph — live agents, a draft bundle, or a BriefingPack
// directory — through the rich BP-Explorer-style renderer: expandable node
// cards with the prompt/Content panel, parent-child hierarchy, data flow, and
// the process-linking edges.
//
// For a BriefingPack source the prompt/Content panel is inline-editable and
// writes back to brief.md (via bp-explorer raw endpoints + git commit, Phase D).
//
//   <FlowGraph workspace="/workspace/agents/<id>/<briefingsPath>" />  // BP source
//   <FlowGraph team="acme" />                                        // live, scoped
//   <FlowGraph />                                                    // all live agents
export function FlowGraph({ workspace, team }) {
  const viewportRef = useRef(null);
  const apiRef = useRef(null);
  const selectedRef = useRef(null);
  const [error, setError] = useState(null);

  // Load the unified graph for the current source.
  const load = useCallback(() => {
    const g = apiRef.current;
    if (!g) return;
    const params = new URLSearchParams();
    if (workspace) params.set('workspace', workspace);
    else if (team) params.set('team', team);
    setError(null);
    fetch(`/api/flows/graph?${params.toString()}`)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((graph) => g.setData(graph))
      .catch((err) => setError(err.message || 'Failed to load graph'));
  }, [workspace, team]);

  // Mount the renderer once. BP sources allow inline prompt editing → brief.md.
  useEffect(() => {
    if (!viewportRef.current) return undefined;
    const bpOps = workspace ? makeBpOps(workspace) : null;
    const g = initFlowGraph(viewportRef.current, {
      onSelectNode: (id) => { selectedRef.current = id; },
      onSaveContent: bpOps
        ? async (id, text) => { await bpOps.setPrompt(id, text); load(); }
        : undefined,
    });
    apiRef.current = g;
    g.setContentEditable(!!bpOps);  // BP prompt editing; live/draft handled elsewhere
    return () => { g.cleanup(); apiRef.current = null; };
    // Re-mount when the BP workspace changes so bpOps targets the right repo.
  }, [workspace]); // eslint-disable-line react-hooks/exhaustive-deps

  // (Re)load whenever the source changes.
  useEffect(() => { load(); }, [load]);

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
