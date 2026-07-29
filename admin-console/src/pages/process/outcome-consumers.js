// Derived, read-only consumers of an outcome — the "who listens for this?"
// column shared by the Flow-Editor Routing tab (RoutingSection.jsx, where this
// logic originated in #828) and the Agent-Chat right rail's read-only Outcomes
// tab (#963). Extracted so the two surfaces cannot drift: the rail is meant to
// show exactly what the editor shows, minus the editing.
//
// `peers` are the sibling nodes of the same flow graph — anything with
// `{ id, displayName?, triggers?, channels? }`. Both call sites feed it the
// graph nodes from `GET /api/process/graph` (or the draft-derived equivalent),
// so `labelFilter` / `channels` are already projected.
//
// Pure + framework-free so it is unit-testable under `node --test`.

// Peers that consume an outcome's signal: they either listen on one of the
// labels the outcome sets, or (openPr / openIssue) consume a PR/issue channel
// from this node.
export function consumersFor(option, node, peers) {
  const names = new Set();
  const actions = Array.isArray(option?.actions) ? option.actions : [];
  const labels = actions.filter(a => a.type === 'setLabel' && a.label).map(a => a.label);
  const opensPr = actions.some(a => a.type === 'openPr');
  const opensIssue = actions.some(a => a.type === 'openIssue');
  for (const p of (Array.isArray(peers) ? peers : [])) {
    if (!p || p.id === node?.id) continue;
    const listensLabel = (p.triggers || []).some(t => typeof t.labelFilter === 'string' && labels.includes(t.labelFilter));
    const chans = Array.isArray(p.channels) ? p.channels : [];
    const consumesPr = opensPr && chans.some(c => c.artifact === 'pr' && c.from === node?.id);
    const consumesIssue = opensIssue && chans.some(c => c.artifact === 'issue' && c.from === node?.id);
    if (listensLabel || consumesPr || consumesIssue) names.add(p.displayName || p.id);
  }
  return [...names];
}

// Peers that listen on a bare label token. The legacy flat-`emits` counterpart
// of consumersFor: an unstructured emit carries no actions, only a label.
export function labelConsumers(label, node, peers) {
  if (typeof label !== 'string' || !label) return [];
  return consumersFor({ actions: [{ type: 'setLabel', label }] }, node, peers);
}
