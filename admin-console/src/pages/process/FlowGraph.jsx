import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { initFlowGraph } from './flow-graph-render';
import { makeBpOps } from './edit-adapters';
import { CreateEdgeDialog, EditHandoffDialog } from './EdgeDialogs';
import BpNodeInspector from './BpNodeInspector';
import { capabilitiesFor, bpMode, createTypesFor } from './connection-capabilities';

// Unified flow viewer (#362, UI rework). Renders any source of the unified
// orchestration graph — live agents, a draft bundle, or a BriefingPack
// directory — through the rich BP-Explorer-style renderer.
//
// For a BriefingPack source the graph is editable, consistent with the process
// flows: selecting a node opens a right-side inspector (prompt, stage, link
// removal) and dragging the node port wires a dependency / data-flow link —
// all committed to brief.md via bp-explorer (Phase D).
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
  const [selectedId, setSelectedId] = useState(null);    // node inspector (BP only)
  const [selectedEdge, setSelectedEdge] = useState(null); // edge click (#412)

  const bpOps = useMemo(() => (workspace ? makeBpOps(workspace) : null), [workspace]);
  // BP workspaces are editable (dependency + data-flow only); everything else
  // renders as a read-only viewer — see the capability matrix (#409).
  const caps = useMemo(() => capabilitiesFor(bpMode({ workspace })), [workspace]);

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

  // Mount the renderer once per source. BP sources are editable, but prompt /
  // stage editing happens in the right inspector (not inline) — consistent with
  // the process flows. The node port still wires links (connect-to-wire).
  useEffect(() => {
    if (!viewportRef.current) return undefined;
    const g = initFlowGraph(viewportRef.current, {
      onSelectNode: (id) => setSelectedId(id),
      onConnect: caps.connectPort ? (from, to) => setConnectPair({ from, to }) : undefined,
      // Edge clicks open the same "Connection" shell as the process views
      // (#412) — dependency/artifact removable, everything else read-only.
      onSelectEdge: caps.edgeClick ? (edge) => setSelectedEdge(edge) : undefined,
    });
    apiRef.current = g;
    g.setEditable(caps.editable); // connect-to-wire port (BP); editing is in the inspector
    return () => { g.cleanup(); apiRef.current = null; };
  }, [bpOps, caps]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { load(); }, [load]);

  const nodeName = (id) => (nodesRef.current.find(n => n.id === id)?.displayName) || id;
  const selectedNode = bpOps ? nodesRef.current.find(n => n.id === selectedId) : null;

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
      {selectedNode && (
        <BpNodeInspector
          key={selectedNode.id}
          node={selectedNode}
          nodes={nodesRef.current}
          ops={bpOps}
          onClose={() => { setSelectedId(null); apiRef.current?.setSelected(null); }}
          onChanged={load}
        />
      )}
      {selectedEdge && bpOps && (
        <EditHandoffDialog
          edge={selectedEdge}
          fromName={nodeName(selectedEdge.from)}
          toName={nodeName(selectedEdge.to)}
          ops={bpOps}
          onClose={() => setSelectedEdge(null)}
          onDone={() => { setSelectedEdge(null); load(); }}
        />
      )}
      {connectPair && bpOps && (
        <CreateEdgeDialog
          from={connectPair.from}
          to={connectPair.to}
          fromName={nodeName(connectPair.from)}
          toName={nodeName(connectPair.to)}
          ops={bpOps}
          types={createTypesFor(caps, 'agent')}
          onClose={() => setConnectPair(null)}
          onDone={() => { setConnectPair(null); load(); }}
        />
      )}
    </div>
  );
}
