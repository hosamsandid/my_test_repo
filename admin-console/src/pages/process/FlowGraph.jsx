import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { initFlowGraph } from './flow-graph-render';
import { makeBpOps } from './edit-adapters';
import { CreateEdgeDialog } from './EdgeDialogs';

// Unified flow viewer (#362, UI rework). Renders any source of the unified
// orchestration graph — live agents, a draft bundle, or a BriefingPack
// directory — through the rich BP-Explorer-style renderer: expandable node
// cards with the prompt/Content panel, parent-child hierarchy, data flow, and
// the process-linking edges.
//
// For a BriefingPack source the graph is editable: the Content/prompt panel
// writes back to brief.md (body), and dragging the node port wires a dependency
// or data-flow link — both committed to brief.md via bp-explorer (Phase D).
//
//   <FlowGraph workspace="/workspace/agents/<id>/<briefingsPath>" />  // BP source
//   <FlowGraph team="acme" />                                        // live, scoped
//   <FlowGraph />                                                    // all live agents
export function FlowGraph({ workspace, team }) {
  const viewportRef = useRef(null);
  const apiRef = useRef(null);
  const nodesRef = useRef([]);
  const [error, setError] = useState(null);
  const [connectPair, setConnectPair] = useState(null); // { from, to } (BP only)

  const bpOps = useMemo(() => (workspace ? makeBpOps(workspace) : null), [workspace]);

  const load = useCallback(() => {
    const g = apiRef.current;
    if (!g) return;
    const params = new URLSearchParams();
    if (workspace) params.set('workspace', workspace);
    else if (team) params.set('team', team);
    setError(null);
    fetch(`/api/flows/graph?${params.toString()}`)
      .then(async (r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((graph) => { nodesRef.current = graph.nodes || []; g.setData(graph); })
      .catch((err) => setError(err.message || 'Failed to load graph'));
  }, [workspace, team]);

  // Mount the renderer once per source. BP sources are editable.
  useEffect(() => {
    if (!viewportRef.current) return undefined;
    const editable = !!bpOps;
    const g = initFlowGraph(viewportRef.current, {
      onSelectNode: () => {},
      onConnect: editable ? (from, to) => setConnectPair({ from, to }) : undefined,
      onSaveContent: bpOps
        ? async (id, text) => { await bpOps.setPrompt(id, text); load(); }
        : undefined,
      onSetStage: bpOps
        ? async (id, stage) => { await bpOps.setStage(id, stage); load(); }
        : undefined,
    });
    apiRef.current = g;
    g.setEditable(editable);        // connect-to-wire port (BP)
    g.setContentEditable(editable); // inline prompt panel (BP)
    return () => { g.cleanup(); apiRef.current = null; };
  }, [bpOps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const nodeName = (id) => (nodesRef.current.find(n => n.id === id)?.displayName) || id;

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
      {connectPair && bpOps && (
        <CreateEdgeDialog
          from={connectPair.from}
          to={connectPair.to}
          fromName={nodeName(connectPair.from)}
          toName={nodeName(connectPair.to)}
          ops={bpOps}
          types={['dependency', 'artifact']}
          onClose={() => setConnectPair(null)}
          onDone={() => { setConnectPair(null); load(); }}
        />
      )}
    </div>
  );
}
