// ─── State ────────────────────────────────────────────────────────────

const state = {
  briefings: [],
  byId: {},
  roots: [],
  expanded: new Set(),
  contentVisible: new Set(),
  childrenVisible: new Set(),
  outputsVisible: new Set(),    // BP ids whose output artifacts are shown
  inputsVisible: new Set(),     // BP ids whose input artifacts are shown
  positions: {},                // BP positions
  artifactPositions: {},        // artifact node positions keyed by path
  numberLabels: {},
  artifactRegistry: {},         // path -> { path, filename, dir, producers, consumers, ac, description }
  pan: { x: 0, y: 0 },
  zoom: 1.0,
  userTransform: false,  // true once user pans/zooms manually; suppresses fitToView on reload
  dragging: false,
  dragStart: { x: 0, y: 0 },
  panStart: { x: 0, y: 0 },
  showArchived: localStorage.getItem('ace-show-archived') === 'true',
};

function recomputeRoots() {
  state.roots = state.briefings
    .filter(bp => !bp.parent && (state.showArchived || !bp.archived))
    .map(bp => bp.id);
}

async function toggleArchived() {
  state.showArchived = !state.showArchived;
  localStorage.setItem('ace-show-archived', state.showArchived);
  document.getElementById('btn-toggle-archived').classList.toggle('active', state.showArchived);
  recomputeRoots();
  buildArtifactRegistry();
  layout();
  render();
  // Refresh dashboard/overview with new filter
  if (dashState.loaded) {
    dashState.loaded = false;
    await fetchPhases();
  }
  if (document.body.classList.contains('view-overview')) {
    await buildDashboardData();
    renderOverview();
  }
}

const NODE_W = 320;
const ARTIFACT_W = 220;
const H_GAP = 50;
const V_GAP = 100;
const ARTIFACT_GAP = 30;
const ARTIFACT_H = 70;

// ─── Data Loading ─────────────────────────────────────────────────────

async function fetchBriefings() {
  try {
    const resp = await fetch('/api/briefings');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    state.briefings = await resp.json();

    state.byId = {};
    state.briefings.forEach(bp => { state.byId[bp.id] = bp; });

    recomputeRoots();

    buildArtifactRegistry();

    document.getElementById('loading').style.display = 'none';
    layout();
    render();
    if (!state.userTransform) fitToView();
  } catch (err) {
    document.getElementById('loading').textContent =
      `Error loading agents: ${err.message}`;
  }
}

function buildArtifactRegistry() {
  const reg = {};

  state.briefings.forEach(bp => {
    if (!bp.artifacts) return;
    bp.artifacts.forEach(art => {
      const path = art.path;
      if (!reg[path]) {
        const parts = path.replace(/\/$/, '').split('/');
        const filename = parts[parts.length - 1];
        const dir = parts.slice(0, -1).join('/');
        reg[path] = {
          path,
          filename,
          dir: dir || '',
          producers: [],  // BPs that output this
          consumers: [],  // BPs that input this
          acs: [],
          descriptions: [],
        };
      }

      if (art.direction === 'output') {
        if (!reg[path].producers.includes(bp.id)) reg[path].producers.push(bp.id);
        if (art.ac && !reg[path].acs.includes(art.ac)) reg[path].acs.push(art.ac);
      } else if (art.direction === 'input') {
        if (!reg[path].consumers.includes(bp.id)) reg[path].consumers.push(bp.id);
      }

      if (art.description && !reg[path].descriptions.includes(art.description)) {
        reg[path].descriptions.push(art.description);
      }
    });
  });

  state.artifactRegistry = reg;
}

async function reload() {
  document.getElementById('loading').style.display = '';
  document.getElementById('loading').textContent = 'Reloading...';
  dashState.loaded = false;
  await fetchBriefings();
  if (document.body.classList.contains('view-dashboard')) {
    await fetchPhases();
  } else if (document.body.classList.contains('view-overview')) {
    await buildDashboardData();
    renderOverview();
  }
}

// ─── Layout ───────────────────────────────────────────────────────────

// Topological sort: nodes without dependencies first (left), dependents after (right)
function topoSort(ids) {
  const idSet = new Set(ids);
  const result = [];
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    const bp = state.byId[id];
    if (!bp) return;
    // Visit dependencies first (only those in the same sibling group)
    (bp.depends_on || []).forEach(depId => {
      if (idSet.has(depId)) visit(depId);
    });
    result.push(id);
  }

  ids.forEach(id => visit(id));
  return result;
}

/**
 * Collect all descendant IDs of a BP (children, grandchildren, etc.)
 */
function collectDescendants(id, result) {
  const bp = state.byId[id];
  if (!bp || !bp.children) return;
  bp.children.forEach(cid => {
    result.add(cid);
    collectDescendants(cid, result);
  });
}

/**
 * Topological sort for root-level BPs that considers cross-level dependencies.
 *
 * If any descendant of root B depends_on any descendant (or the root itself)
 * of root A, then A must come before B. This handles the case where e.g.
 * "Forward Engineering" children depend on "Reverse Engineering" children
 * without a direct root-to-root dependency.
 */
function topoSortRoots(rootIds) {
  // Build a map: root -> set of all IDs in its tree (including itself)
  const treeMembers = {};
  rootIds.forEach(rootId => {
    const members = new Set([rootId]);
    collectDescendants(rootId, members);
    treeMembers[rootId] = members;
  });

  // Build a reverse lookup: any BP id -> which root tree does it belong to
  const idToRoot = {};
  rootIds.forEach(rootId => {
    treeMembers[rootId].forEach(memberId => {
      idToRoot[memberId] = rootId;
    });
  });

  // Build root-level dependency edges by scanning all descendants' depends_on
  const rootDeps = {};  // rootId -> Set of rootIds it depends on
  rootIds.forEach(rootId => { rootDeps[rootId] = new Set(); });

  rootIds.forEach(rootId => {
    treeMembers[rootId].forEach(memberId => {
      const bp = state.byId[memberId];
      if (!bp) return;
      (bp.depends_on || []).forEach(depId => {
        const depRoot = idToRoot[depId];
        if (depRoot && depRoot !== rootId) {
          rootDeps[rootId].add(depRoot);
        }
      });
    });
  });

  // Topological sort using the derived root-level edges
  const rootSet = new Set(rootIds);
  const result = [];
  const visited = new Set();

  function visit(id) {
    if (visited.has(id)) return;
    visited.add(id);
    (rootDeps[id] || new Set()).forEach(depId => {
      if (rootSet.has(depId)) visit(depId);
    });
    result.push(id);
  }

  rootIds.forEach(id => visit(id));
  return result;
}

function getVisibleNodes() {
  const visible = [];
  const visited = new Set();
  state.numberLabels = {};

  function walk(id, depth, prefix) {
    if (visited.has(id)) return;
    visited.add(id);
    const bp = state.byId[id];
    if (!bp) return;
    visible.push({ id, depth });
    state.numberLabels[id] = prefix;

    if (state.childrenVisible.has(id) && bp.children && bp.children.length > 0) {
      const sorted = topoSort(bp.children);
      sorted.forEach((childId, i) => walk(childId, depth + 1, prefix + '.' + (i + 1)));
    }
  }

  const sortedRoots = topoSortRoots(state.roots);
  sortedRoots.forEach((id, i) => walk(id, 0, String(i + 1)));
  return visible;
}

function getVisibleArtifactPaths() {
  const paths = new Set();
  state.outputsVisible.forEach(bpId => {
    const bp = state.byId[bpId];
    if (!bp || !bp.artifacts) return;
    bp.artifacts.filter(a => a.direction === 'output').forEach(a => paths.add(a.path));
  });
  state.inputsVisible.forEach(bpId => {
    const bp = state.byId[bpId];
    if (!bp || !bp.artifacts) return;
    bp.artifacts.filter(a => a.direction === 'input').forEach(a => paths.add(a.path));
  });
  return paths;
}

function getNodeHeight(id) {
  const el = document.querySelector(`.node[data-id="${id}"]`);
  if (el) return el.offsetHeight;
  let h = 90;
  if (state.expanded.has(id)) h += 150;
  if (state.contentVisible.has(id)) h += 300;
  return h;
}

function getArtifactNodeHeight(path) {
  const el = document.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
  if (el) return el.offsetHeight;
  return ARTIFACT_H;
}

function layout() {
  const visible = getVisibleNodes();
  if (visible.length === 0) return;

  const visibleIds = new Set(visible.map(n => n.id));
  const childrenOf = {};
  visible.forEach(n => {
    const bp = state.byId[n.id];
    const kids = (bp.children || []).filter(cid => visibleIds.has(cid));
    childrenOf[n.id] = topoSort(kids);
  });

  // Compute subtree widths (bottom-up) — artifacts no longer affect BP layout
  const subtreeW = {};
  const maxDepth = Math.max(...visible.map(n => n.depth));

  for (let d = maxDepth; d >= 0; d--) {
    visible.filter(n => n.depth === d).forEach(n => {
      const kids = childrenOf[n.id] || [];
      if (kids.length === 0) {
        subtreeW[n.id] = NODE_W;
      } else {
        const childrenW = kids.reduce((sum, cid) => sum + subtreeW[cid], 0)
          + H_GAP * (kids.length - 1);
        subtreeW[n.id] = Math.max(NODE_W, childrenW);
      }
    });
  }

  // Assign X positions (top-down)
  const pos = {};

  function assignX(id, xStart) {
    const kids = childrenOf[id] || [];
    if (kids.length === 0) {
      pos[id] = { x: xStart, y: 0 };
    } else {
      let cx = xStart;
      kids.forEach(cid => {
        assignX(cid, cx);
        cx += subtreeW[cid] + H_GAP;
      });
      const firstChild = pos[kids[0]];
      const lastChild = pos[kids[kids.length - 1]];
      pos[id] = {
        x: (firstChild.x + lastChild.x) / 2,
        y: 0,
      };
    }
  }

  let xCursor = 0;
  const sortedRoots = topoSortRoots(state.roots).filter(id => visibleIds.has(id));
  sortedRoots.forEach(id => {
    assignX(id, xCursor);
    xCursor += subtreeW[id] + H_GAP * 2;
  });

  // Assign Y positions
  const depthNodes = {};
  visible.forEach(n => {
    if (!depthNodes[n.depth]) depthNodes[n.depth] = [];
    depthNodes[n.depth].push(n.id);
  });

  let yOffset = 0;
  for (let d = 0; d <= maxDepth; d++) {
    const ids = depthNodes[d] || [];
    ids.forEach(id => { pos[id].y = yOffset; });
    const maxH = Math.max(...ids.map(id => getNodeHeight(id)), 90);
    yOffset += maxH + V_GAP;
  }

  state.positions = pos;

  // Position artifact nodes: horizontal row below all BPs
  layoutArtifacts(visible);
}

function layoutArtifacts(visibleBpNodes) {
  const artPos = {};
  const positioned = new Set();
  const visiblePaths = getVisibleArtifactPaths();
  if (visiblePaths.size === 0) { state.artifactPositions = {}; return; }

  // Find bottom edge of all BP nodes
  let maxY = 0;
  visibleBpNodes.forEach(n => {
    const pos = state.positions[n.id];
    if (!pos) return;
    const h = getNodeHeight(n.id);
    maxY = Math.max(maxY, pos.y + h);
  });

  const artifactRowY = maxY + V_GAP;

  // Collect artifacts in order: walk BPs left-to-right, outputs then inputs
  const sortedBps = [...visibleBpNodes].sort((a, b) => {
    const pa = state.positions[a.id];
    const pb = state.positions[b.id];
    return (pa ? pa.x : 0) - (pb ? pb.x : 0);
  });

  // Gather artifacts grouped by BP in left-to-right BP order
  const orderedPaths = [];
  sortedBps.forEach(n => {
    const hasOut = state.outputsVisible.has(n.id);
    const hasIn = state.inputsVisible.has(n.id);
    if (!hasOut && !hasIn) return;
    const bp = state.byId[n.id];
    if (!bp || !bp.artifacts) return;

    // Inputs first (they feed into this BP), then outputs (they come from this BP)
    if (hasIn) {
      bp.artifacts.filter(a => a.direction === 'input').forEach(a => {
        if (!positioned.has(a.path) && visiblePaths.has(a.path)) {
          positioned.add(a.path);
          orderedPaths.push(a.path);
        }
      });
    }
    if (hasOut) {
      bp.artifacts.filter(a => a.direction === 'output').forEach(a => {
        if (!positioned.has(a.path) && visiblePaths.has(a.path)) {
          positioned.add(a.path);
          orderedPaths.push(a.path);
        }
      });
    }
  });

  // Place artifacts in a horizontal row
  let xCursor = 0;
  // Center the row: find the x-range of BP nodes
  let minBpX = Infinity, maxBpX = -Infinity;
  visibleBpNodes.forEach(n => {
    const pos = state.positions[n.id];
    if (pos) {
      minBpX = Math.min(minBpX, pos.x);
      maxBpX = Math.max(maxBpX, pos.x + NODE_W);
    }
  });

  const totalArtWidth = orderedPaths.length * (ARTIFACT_W + 12) - 12;
  const bpCenterX = (minBpX + maxBpX) / 2;
  xCursor = bpCenterX - totalArtWidth / 2;

  orderedPaths.forEach(path => {
    artPos[path] = { x: xCursor, y: artifactRowY };
    xCursor += ARTIFACT_W + 12;
  });

  state.artifactPositions = artPos;
}

// ─── Rendering ────────────────────────────────────────────────────────

function render() {
  layout();

  const canvas = document.getElementById('canvas');
  const visible = getVisibleNodes();
  const visibleIds = new Set(visible.map(n => n.id));

  // Clear existing nodes
  canvas.querySelectorAll('.node, .artifact-node').forEach(el => el.remove());

  // Create BP nodes
  visible.forEach(n => {
    const bp = state.byId[n.id];
    const pos = state.positions[n.id];
    if (!bp || !pos) return;

    const node = document.createElement('div');
    node.className = 'node' + (bp.status ? ` node-status-${bp.status}` : '');
    node.dataset.id = n.id;
    node.style.left = pos.x + 'px';
    node.style.top = pos.y + 'px';

    node.addEventListener('mousedown', e => e.stopPropagation());

    // Header
    const header = document.createElement('div');
    header.className = 'node-header';
    const numLabel = state.numberLabels[n.id] || '';
    header.innerHTML = `
      <span class="node-title"><span class="node-number">${esc(numLabel)}</span> ${esc(bp.title)}</span>
      ${bpIdLabel(bp.id, bp.id, 'node-id')}
    `;
    node.appendChild(header);

    // Badges (rigor + revision — status is shown via node border color)
    const badgeParts = [];
    if (bp.rigor) badgeParts.push(`<span class="badge rigor-${esc(bp.rigor)}">${esc(bp.rigor)}</span>`);
    if (bp.revision && parseInt(bp.revision) > 1) badgeParts.push(`<span class="badge badge-revision" title="Revised">Rev\u00a0${esc(String(bp.revision))}</span>`);
    if (badgeParts.length > 0) {
      const badges = document.createElement('div');
      badges.className = 'badges';
      badges.innerHTML = badgeParts.join('');
      node.appendChild(badges);
    }

    // Dependency indicator
    if (bp.depends_on && bp.depends_on.length > 0) {
      const depDiv = document.createElement('div');
      depDiv.className = 'dep-indicator';
      const depNames = bp.depends_on.map(did => {
        const dep = state.byId[did];
        return dep ? dep.slug : did;
      });
      depDiv.textContent = `depends on: ${depNames.join(', ')}`;
      node.appendChild(depDiv);
    }

    // Action buttons
    const actions = document.createElement('div');
    actions.className = 'node-actions';

    const detailBtn = document.createElement('button');
    detailBtn.textContent = 'Details';
    if (state.expanded.has(n.id)) detailBtn.classList.add('active');
    detailBtn.addEventListener('click', () => toggleDetails(n.id));
    actions.appendChild(detailBtn);

    if (bp.children && bp.children.length > 0) {
      const childBtn = document.createElement('button');
      childBtn.textContent = `Children (${bp.children.length})`;
      if (state.childrenVisible.has(n.id)) childBtn.classList.add('active');
      childBtn.addEventListener('click', () => toggleChildren(n.id));
      actions.appendChild(childBtn);
    }

    if (bp.artifacts && bp.artifacts.length > 0) {
      const outCount = bp.artifacts.filter(a => a.direction === 'output').length;
      const inCount = bp.artifacts.filter(a => a.direction === 'input').length;

      if (inCount > 0) {
        const inBtn = document.createElement('button');
        inBtn.textContent = `In (${inCount})`;
        if (state.inputsVisible.has(n.id)) inBtn.classList.add('active');
        inBtn.addEventListener('click', () => toggleInputs(n.id));
        actions.appendChild(inBtn);
      }

      if (outCount > 0) {
        const outBtn = document.createElement('button');
        outBtn.textContent = `Out (${outCount})`;
        if (state.outputsVisible.has(n.id)) outBtn.classList.add('active');
        outBtn.addEventListener('click', () => toggleOutputs(n.id));
        actions.appendChild(outBtn);
      }
    }

    const contentBtn = document.createElement('button');
    contentBtn.textContent = 'Content';
    if (state.contentVisible.has(n.id)) contentBtn.classList.add('active');
    contentBtn.addEventListener('click', () => toggleContent(n.id));
    actions.appendChild(contentBtn);

    node.appendChild(actions);

    // Details panel
    if (state.expanded.has(n.id)) {
      const details = document.createElement('div');
      details.className = 'node-details';

      const rows = [];
      rows.push(detailRow('Created', bp.created));
      rows.push(detailRow('Slug', bp.slug));
      if (bp.loopscript) rows.push(detailRow('Loopscript', bp.loopscript));
      if (bp.parent) {
        const parentBp = state.byId[bp.parent];
        rows.push(detailRow('Parent', parentBp ? parentBp.slug : bp.parent));
      }

      if (bp.depends_on && bp.depends_on.length > 0) {
        rows.push(detailRow('Depends on', bp.depends_on.map(did => {
          const dep = state.byId[did];
          return dep ? dep.slug : did;
        }).join(', ')));
      }

      if (bp.execution_order && bp.execution_order.length > 0) {
        const list = bp.execution_order.map(item => {
          if (typeof item === 'string') {
            return `<li>${esc(item)}</li>`;
          } else {
            const note = item.note ? `<span class="exec-note">${esc(item.note)}</span>` : '';
            return `<li>${esc(item.slug || item.id || JSON.stringify(item))}${note}</li>`;
          }
        }).join('');
        rows.push(`<div class="detail-row"><span class="detail-label">Execution Order</span></div>
                    <ol class="detail-list" style="text-align:left;padding-left:16px;margin-top:4px;">${list}</ol>`);
      }

      if (bp.mentorscripts && bp.mentorscripts.length > 0) {
        rows.push(detailRow('Mentorscripts', bp.mentorscripts.join(', ')));
      }

      details.innerHTML = rows.join('');
      node.appendChild(details);
    }

    // Content panel
    if (state.contentVisible.has(n.id) && bp.body) {
      const body = document.createElement('div');
      body.className = 'node-body';
      body.innerHTML = renderMarkdown(bp.body);
      body.addEventListener('wheel', e => e.stopPropagation());
      node.appendChild(body);
    }

    canvas.appendChild(node);
  });

  // Create artifact nodes
  renderArtifactNodes(canvas);

  // Re-layout with actual DOM heights, then reposition
  requestAnimationFrame(() => {
    layout();
    canvas.querySelectorAll('.node').forEach(el => {
      const id = el.dataset.id;
      const pos = state.positions[id];
      if (pos) {
        el.style.left = pos.x + 'px';
        el.style.top = pos.y + 'px';
      }
    });
    canvas.querySelectorAll('.artifact-node').forEach(el => {
      const path = el.dataset.path;
      const pos = state.artifactPositions[path];
      if (pos) {
        el.style.left = pos.x + 'px';
        el.style.top = pos.y + 'px';
      }
    });
    drawEdges();
  });
}

function renderArtifactNodes(canvas) {
  const visiblePaths = getVisibleArtifactPaths();
  const rendered = new Set();

  visiblePaths.forEach(path => {
    if (rendered.has(path)) return;
    rendered.add(path);

    const reg = state.artifactRegistry[path];
    const pos = state.artifactPositions[path];
    if (!reg || !pos) return;

    const node = document.createElement('div');
    node.className = 'artifact-node';
    node.dataset.path = path;
    node.style.left = pos.x + 'px';
    node.style.top = pos.y + 'px';

    node.addEventListener('mousedown', e => e.stopPropagation());

    // Filename
    const fnEl = document.createElement('div');
    fnEl.className = 'artifact-filename';
    fnEl.textContent = reg.filename;
    node.appendChild(fnEl);

    // Directory
    if (reg.dir) {
      const dirEl = document.createElement('div');
      dirEl.className = 'artifact-dir';
      dirEl.textContent = reg.dir + '/';
      node.appendChild(dirEl);
    }

    // Meta badges — only show directions visible in current context
    const meta = document.createElement('div');
    meta.className = 'artifact-meta';

    const visibleProducers = reg.producers.filter(id => state.outputsVisible.has(id));
    const visibleConsumers = reg.consumers.filter(id => state.inputsVisible.has(id));
    const isOutput = visibleProducers.length > 0;
    const isInput = visibleConsumers.length > 0;
    let dirClass, dirLabel;
    if (isOutput && isInput) { dirClass = 'dir-both'; dirLabel = 'output + input'; }
    else if (isOutput) { dirClass = 'dir-output'; dirLabel = 'output'; }
    else { dirClass = 'dir-input'; dirLabel = 'input'; }
    meta.innerHTML = `<span class="artifact-badge ${dirClass}">${dirLabel}</span>`;

    reg.acs.forEach(ac => {
      meta.innerHTML += `<span class="artifact-badge ac-ref">${esc(ac)}</span>`;
    });

    node.appendChild(meta);

    // Description (first non-empty)
    const desc = reg.descriptions.find(d => d && !d.startsWith('From bp:')) || reg.descriptions[0];
    if (desc) {
      const descEl = document.createElement('div');
      descEl.className = 'artifact-desc';
      descEl.textContent = desc.replace(/^From bp:\w+ — /, '');
      node.appendChild(descEl);
    }

    canvas.appendChild(node);
  });
}

function detailRow(label, value) {
  return `<div class="detail-row">
    <span class="detail-label">${esc(label)}</span>
    <span class="detail-value">${esc(String(value || '—'))}</span>
  </div>`;
}

// ─── Edge Drawing ─────────────────────────────────────────────────────

function drawEdges() {
  const svg = document.getElementById('edges');
  svg.innerHTML = '';

  const visible = getVisibleNodes();
  const visibleIds = new Set(visible.map(n => n.id));

  // 1. Hierarchy edges (gray solid)
  visible.forEach(n => {
    const bp = state.byId[n.id];
    if (!bp || !state.childrenVisible.has(n.id)) return;

    const parentPos = state.positions[n.id];
    const parentEl = document.querySelector(`.node[data-id="${n.id}"]`);
    if (!parentPos || !parentEl) return;

    const parentH = parentEl.offsetHeight;

    (bp.children || []).forEach(childId => {
      if (!visibleIds.has(childId)) return;
      const childPos = state.positions[childId];
      if (!childPos) return;

      const x1 = parentPos.x + NODE_W / 2;
      const y1 = parentPos.y + parentH;
      const x2 = childPos.x + NODE_W / 2;
      const y2 = childPos.y;

      drawBezierEdge(svg, x1, y1, x2, y2, 'var(--edge-color)', 2, '');
    });
  });

  // 2. Dependency edges (red dashed)
  visible.forEach(n => {
    const bp = state.byId[n.id];
    if (!bp || !bp.depends_on) return;

    bp.depends_on.forEach(depId => {
      if (!visibleIds.has(depId)) return;
      const fromPos = state.positions[depId];
      const toPos = state.positions[n.id];
      const fromEl = document.querySelector(`.node[data-id="${depId}"]`);
      if (!fromPos || !toPos || !fromEl) return;

      const fromH = fromEl.offsetHeight;
      const x1 = fromPos.x + NODE_W;
      const y1 = fromPos.y + fromH / 2;
      const x2 = toPos.x;
      const y2 = toPos.y + 45;
      const mx = (x1 + x2) / 2;

      const path = makeSvgPath(svg, `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
      path.setAttribute('stroke', 'var(--edge-dep)');
      path.setAttribute('stroke-width', '1.5');
      path.setAttribute('stroke-dasharray', '6 4');
      path.setAttribute('fill', 'none');
      path.setAttribute('opacity', '0.5');

      const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      arrow.setAttribute('points', `${x2},${y2} ${x2-8},${y2-4} ${x2-8},${y2+4}`);
      arrow.setAttribute('fill', 'var(--edge-dep)');
      arrow.setAttribute('opacity', '0.5');
      svg.appendChild(arrow);
    });
  });

  // 3. Artifact edges (green for output, blue for input)
  drawArtifactEdges(svg, visibleIds);
}

function drawArtifactEdges(svg, visibleBpIds) {
  const visiblePaths = getVisibleArtifactPaths();

  visiblePaths.forEach(path => {
    const reg = state.artifactRegistry[path];
    const artPos = state.artifactPositions[path];
    if (!reg || !artPos) return;

    const artEl = document.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    const artH = artEl ? artEl.offsetHeight : ARTIFACT_H;

    // Output edges: BP bottom → artifact top (green)
    reg.producers.forEach(bpId => {
      if (!visibleBpIds.has(bpId)) return;
      const bpPos = state.positions[bpId];
      const bpEl = document.querySelector(`.node[data-id="${bpId}"]`);
      if (!bpPos || !bpEl) return;

      const bpH = bpEl.offsetHeight;
      const x1 = bpPos.x + NODE_W / 2;
      const y1 = bpPos.y + bpH;
      const x2 = artPos.x + ARTIFACT_W / 2;
      const y2 = artPos.y;

      drawBezierEdge(svg, x1, y1, x2, y2, 'var(--edge-output)', 1.5, '', true);
    });

    // Input edges: artifact top → BP bottom (blue dashed)
    reg.consumers.forEach(bpId => {
      if (!visibleBpIds.has(bpId)) return;
      const bpPos = state.positions[bpId];
      const bpEl = document.querySelector(`.node[data-id="${bpId}"]`);
      if (!bpPos || !bpEl) return;

      const bpH = bpEl.offsetHeight;
      // Data flows from artifact UP to BP: start at artifact, arrow at BP
      const x1 = artPos.x + ARTIFACT_W / 2;
      const y1 = artPos.y;
      const x2 = bpPos.x + NODE_W / 2;
      const y2 = bpPos.y + bpH;

      drawBezierEdge(svg, x1, y1, x2, y2, 'var(--edge-input)', 1.5, '4 3', true);
    });
  });
}

function drawBezierEdge(svg, x1, y1, x2, y2, stroke, width, dash, arrow) {
  const cy1 = y1 + (y2 - y1) * 0.4;
  const cy2 = y2 - (y2 - y1) * 0.4;
  const p = makeSvgPath(svg, `M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`);
  p.setAttribute('stroke', stroke);
  p.setAttribute('stroke-width', String(width));
  if (dash) p.setAttribute('stroke-dasharray', dash);
  p.setAttribute('fill', 'none');

  if (arrow) {
    // Compute tangent direction at the endpoint from the last control point
    const dx = x2 - x2;  // last segment of bezier: control2 → end
    const dy = y2 - cy2;
    const angle = Math.atan2(dy, dx);
    const size = 7;
    const ax1 = x2 - size * Math.cos(angle - 0.4);
    const ay1 = y2 - size * Math.sin(angle - 0.4);
    const ax2 = x2 - size * Math.cos(angle + 0.4);
    const ay2 = y2 - size * Math.sin(angle + 0.4);
    const tri = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
    tri.setAttribute('points', `${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`);
    tri.setAttribute('fill', stroke);
    tri.setAttribute('opacity', '0.7');
    svg.appendChild(tri);
  }
}

function makeSvgPath(svg, d) {
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', d);
  svg.appendChild(p);
  return p;
}

// ─── Interactions ─────────────────────────────────────────────────────

function toggleDetails(id) {
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
}

function toggleContent(id) {
  if (state.contentVisible.has(id)) state.contentVisible.delete(id);
  else state.contentVisible.add(id);
  render();
}

function toggleChildren(id) {
  if (state.childrenVisible.has(id)) {
    collapseSubtree(id);
  } else {
    state.childrenVisible.add(id);
  }
  render();
  requestAnimationFrame(() => fitToView());
}

function toggleOutputs(id) {
  if (state.outputsVisible.has(id)) state.outputsVisible.delete(id);
  else state.outputsVisible.add(id);
  render();
  requestAnimationFrame(() => fitToView());
}

function toggleInputs(id) {
  if (state.inputsVisible.has(id)) state.inputsVisible.delete(id);
  else state.inputsVisible.add(id);
  render();
  requestAnimationFrame(() => fitToView());
}

function collapseSubtree(id) {
  state.childrenVisible.delete(id);
  const bp = state.byId[id];
  if (bp && bp.children) {
    bp.children.forEach(cid => collapseSubtree(cid));
  }
}

function expandAll() {
  state.briefings.forEach(bp => {
    if (bp.children && bp.children.length > 0) {
      state.childrenVisible.add(bp.id);
    }
  });
  render();
  requestAnimationFrame(() => fitToView());
}

function collapseAll() {
  state.childrenVisible.clear();
  state.expanded.clear();
  state.contentVisible.clear();
  state.outputsVisible.clear();
  state.inputsVisible.clear();
  render();
  requestAnimationFrame(() => fitToView());
}

function fitToView() {
  state.userTransform = false;
  const visible = getVisibleNodes();
  if (visible.length === 0) return;

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  // Include BP nodes
  visible.forEach(n => {
    const pos = state.positions[n.id];
    if (!pos) return;
    const el = document.querySelector(`.node[data-id="${n.id}"]`);
    const h = el ? el.offsetHeight : 90;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + NODE_W);
    maxY = Math.max(maxY, pos.y + h);
  });

  // Include artifact nodes
  for (const [path, pos] of Object.entries(state.artifactPositions)) {
    const el = document.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    const h = el ? el.offsetHeight : ARTIFACT_H;
    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + ARTIFACT_W);
    maxY = Math.max(maxY, pos.y + h);
  }

  const viewport = document.getElementById('canvas-viewport');
  const vw = viewport.clientWidth;
  const vh = viewport.clientHeight;
  const contentW = maxX - minX + 100;
  const contentH = maxY - minY + 100;

  const scaleX = vw / contentW;
  const scaleY = vh / contentH;
  state.zoom = Math.min(scaleX, scaleY, 1.5);
  state.zoom = Math.max(state.zoom, 0.1);

  state.pan.x = (vw - contentW * state.zoom) / 2 - minX * state.zoom + 50 * state.zoom;
  state.pan.y = (vh - contentH * state.zoom) / 2 - minY * state.zoom + 50 * state.zoom;

  applyTransform();
}

// ─── Pan & Zoom ───────────────────────────────────────────────────────

function setupPanZoom() {
  const viewport = document.getElementById('canvas-viewport');

  viewport.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    state.dragging = true;
    state.userTransform = true;
    state.dragStart = { x: e.clientX, y: e.clientY };
    state.panStart = { ...state.pan };
    viewport.classList.add('dragging');
  });

  window.addEventListener('mousemove', e => {
    if (!state.dragging) return;
    state.pan.x = state.panStart.x + (e.clientX - state.dragStart.x);
    state.pan.y = state.panStart.y + (e.clientY - state.dragStart.y);
    applyTransform();
  });

  window.addEventListener('mouseup', () => {
    state.dragging = false;
    document.getElementById('canvas-viewport').classList.remove('dragging');
  });

  viewport.addEventListener('wheel', e => {
    e.preventDefault();
    state.userTransform = true;
    const delta = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.zoom;
    state.zoom = Math.max(0.1, Math.min(3.0, state.zoom * delta));

    const rect = viewport.getBoundingClientRect();
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;

    state.pan.x = mx - (mx - state.pan.x) * (state.zoom / oldZoom);
    state.pan.y = my - (my - state.pan.y) * (state.zoom / oldZoom);

    applyTransform();
  }, { passive: false });
}

function applyTransform() {
  const canvas = document.getElementById('canvas');
  canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
  document.getElementById('zoom-display').textContent = Math.round(state.zoom * 100) + '%';
}

// ─── Markdown Renderer ────────────────────────────────────────────────

function renderMarkdown(text) {
  if (!text) return '';

  let html = esc(text);

  // Fenced code blocks — extract first to protect from other transforms
  const codeBlocks = [];
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    // Apply diff highlighting for lines starting with + or -
    let rendered = code.replace(/\n$/, '').split('\n').map(line => {
      if (line.startsWith('+') && !line.startsWith('+++')) return `<span class="diff-add">${line}</span>`;
      if (line.startsWith('-') && !line.startsWith('---')) return `<span class="diff-del">${line}</span>`;
      return line;
    }).join('\n');
    const placeholder = `\x00CB${codeBlocks.length}\x00`;
    codeBlocks.push(`<pre><code${lang ? ` data-lang="${lang}"` : ''}>${rendered}</code></pre>`);
    return placeholder;
  });

  // Inline code — protect from other transforms
  const inlineCodes = [];
  html = html.replace(/`([^`]+)`/g, (_, code) => {
    const placeholder = `\x00IC${inlineCodes.length}\x00`;
    inlineCodes.push(`<code>${code}</code>`);
    return placeholder;
  });

  // Join continuation lines with their list items.
  // e.g. "  - item text\n    continuation" → "  - item text continuation"
  {
    const lines = html.split('\n');
    const result = [];
    for (let i = 0; i < lines.length; i++) {
      const prev = result.length > 0 ? result[result.length - 1] : '';
      if (/^\s+\S/.test(lines[i]) && !/^\s*- /.test(lines[i]) && /^\s*- /.test(prev)) {
        result[result.length - 1] += ' ' + lines[i].trim();
      } else {
        result.push(lines[i]);
      }
    }
    html = result.join('\n');
  }

  // Tables — parse alignment from separator row
  html = html.replace(/^(\|.+\|)\n(\|[-: |]+\|)\n((?:\|.+\|\n?)*)/gm, (match, header, sep, body) => {
    const stripOuter = parts => { let a = parts; if (!a[0].trim()) a = a.slice(1); if (!a[a.length-1].trim()) a = a.slice(0,-1); return a; };
    const sepCells = stripOuter(sep.split('|'));
    const aligns = sepCells.map(c => {
      const t = c.trim();
      if (t.startsWith(':') && t.endsWith(':')) return 'center';
      if (t.endsWith(':')) return 'right';
      return 'left';
    });
    const ths = stripOuter(header.split('|')).map((c, i) =>
      `<th style="text-align:${aligns[i] || 'left'}">${c.trim()}</th>`
    ).join('');
    const rows = body.trim().split('\n').filter(r => r.trim()).map(row => {
      const tds = stripOuter(row.split('|')).map((c, i) =>
        `<td style="text-align:${aligns[i] || 'left'}">${c.trim()}</td>`
      ).join('');
      return `<tr>${tds}</tr>`;
    }).join('');
    return `<table><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
  });

  // Blockquotes (must be before headings/paragraphs)
  html = html.replace(/(^&gt; .+(\n&gt; .+)*)/gm, (match) => {
    const content = match.replace(/^&gt; ?/gm, '');
    return `<blockquote><p>${content}</p></blockquote>`;
  });

  // Headings
  html = html.replace(/^#### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/^---$/gm, '<hr>');

  // Inline formatting
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  // Task lists (before regular lists)
  html = html.replace(/^- \[ \] (.+)$/gm, '<li style="list-style:none"><span class="task-check"></span>$1</li>');
  html = html.replace(/^- \[x\] (.+)$/gm, '<li style="list-style:none"><span class="task-check checked"></span>$1</li>');

  // Unordered lists (including indented sub-items)
  html = html.replace(/^\s*- (.+)$/gm, '<li>$1</li>');

  // Ordered lists — track and wrap separately
  html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');

  // Wrap consecutive <li> in <ul>, consecutive <oli> in <ol>
  html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (m) => {
    return '<ol>' + m.replace(/<\/?oli>/g, (t) => t.replace('oli', 'li')) + '</ol>';
  });

  // Paragraphs — wrap non-block text
  html = html.replace(/\n\n+/g, '</p><p>');
  html = '<p>' + html + '</p>';

  // Clean up empty/nested block elements inside <p>
  const blocks = ['h[1234]', 'table', 'ul', 'ol', 'pre', 'hr', 'blockquote'];
  html = html.replace(/<p>\s*<\/p>/g, '');
  blocks.forEach(tag => {
    html = html.replace(new RegExp(`<p>\\s*(<${tag}[> ])`, 'g'), '$1');
    html = html.replace(new RegExp(`<p>\\s*(<${tag}>)`, 'g'), '$1');
    html = html.replace(new RegExp(`(</${tag}>)\\s*</p>`, 'g'), '$1');
  });

  // Restore code blocks and inline code
  codeBlocks.forEach((block, i) => {
    html = html.replace(`\x00CB${i}\x00`, block);
  });
  inlineCodes.forEach((code, i) => {
    html = html.replace(`\x00IC${i}\x00`, code);
  });

  return html;
}

// ─── Utilities ────────────────────────────────────────────────────────

function esc(str) {
  const el = document.createElement('span');
  el.textContent = str;
  return el.innerHTML;
}

// ─── Copyable BP-ID labels ────────────────────────────────────────────
// Render a BP/blueprint hash label that copies the full ID to the clipboard
// on click and selects the visible text so it can also be copied manually.
// `displayText` is what the user sees (e.g. "a3f7c2", "bp:a3f7c2", or the
// full ID). The full hash always lands on the clipboard regardless of the
// abbreviated display.
function bpIdLabel(fullId, displayText, extraClass) {
  if (!fullId) return esc(displayText || '');
  const text = (displayText !== undefined && displayText !== null) ? displayText : fullId;
  const cls = 'bp-id-copy' + (extraClass ? ' ' + extraClass : '');
  return `<span class="${cls}" data-bp-id="${esc(fullId)}" title="Click to copy ${esc(fullId)}" onclick="copyBpIdLabel(event)">${esc(text)}</span>`;
}

async function copyBpIdLabel(event) {
  if (event && event.stopPropagation) event.stopPropagation();
  const el = event && event.currentTarget;
  if (!el) return;
  const id = el.dataset.bpId || el.textContent.trim();

  // Select the visible text so the user can also copy manually.
  try {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  } catch (e) { /* ignore */ }

  // Copy the full ID to the clipboard.
  let copied = false;
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try { await navigator.clipboard.writeText(id); copied = true; } catch (e) { /* fall through */ }
  }
  if (!copied) {
    try { copied = document.execCommand('copy'); } catch (e) { /* ignore */ }
  }

  // Visual confirmation.
  el.classList.remove('bp-id-copied');
  // Force reflow so the animation restarts on rapid repeat clicks.
  void el.offsetWidth;
  el.classList.add('bp-id-copied');
  setTimeout(() => el.classList.remove('bp-id-copied'), 1100);
}

// ─── Dashboard ────────────────────────────────────────────────────────

const dashState = {
  phaseGroups: [],
  activeGroup: null,   // index into phaseGroups
  activePhase: null,    // index into phaseGroups[x].phases
  loaded: false,
};

async function switchView(view) {
  closePreview();
  document.body.className = `view-${view}`;
  ['overview', 'dashboard', 'graph', 'chat', 'blueprints', 'glossary'].forEach(v => {
    const btn = document.getElementById(`btn-view-${v}`);
    if (btn) btn.classList.toggle('active', v === view);
  });
  document.getElementById('graph-controls').style.display = view === 'graph' ? '' : 'none';

  if (view === 'overview') {
    if (state.briefings.length === 0) await fetchBriefings();
    await buildDashboardData();
    renderOverview();
    startDashboardRefresh();
  } else {
    stopDashboardRefresh();
  }
  if (view === 'dashboard') {
    if (state.briefings.length === 0) await fetchBriefings();
    if (!dashState.loaded) await fetchPhases();
  }
  if (view === 'graph' && !state.userTransform) {
    requestAnimationFrame(() => fitToView());
  }
  if (view === 'chat') {
    renderChatSidebar();
    updateChatBpContext();
    updateChatControls();
    renderChatMessages();
    const textarea = document.getElementById('chat-textarea');
    if (textarea) requestAnimationFrame(() => textarea.focus());
  }
  if (view === 'blueprints') {
    await fetchAndRenderBlueprints();
  }
}

async function fetchPhases() {
  try {
    // Ensure LoopScript phases are available for inline mission phase display
    await loadLoopscriptPhases();
    const resp = await fetch('/api/phases');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    let groups = await resp.json();
    // Filter out archived BP groups unless showArchived is enabled
    if (!state.showArchived) {
      groups = groups.filter(g => {
        const bp = state.byId[g.parent_id];
        return !bp || !bp.archived;
      });
    }
    dashState.phaseGroups = groups;
    dashState.loaded = true;

    if (dashState.phaseGroups.length > 0) {
      dashState.activeGroup = 0;
      dashState.activePhase = 0;
    }
    renderDashboard();
  } catch (err) {
    document.getElementById('dash-content').innerHTML =
      `<div class="dash-empty">Error loading phases: ${esc(err.message)}</div>`;
  }
}

function renderDashboard() {
  if (dashState.phaseGroups.length === 0) {
    document.getElementById('dash-sidebar').innerHTML = '';
    document.getElementById('dash-content').innerHTML =
      '<div class="dash-empty">No agents found.</div>';
    return;
  }

  renderDashSidebar();
  const group = dashState.phaseGroups[dashState.activeGroup];
  renderDashContent(group);
}

function renderDashSidebar() {
  const sidebar = document.getElementById('dash-sidebar');
  let html = '';

  html += `<div class="dash-project-label">Agents</div>`;

  dashState.phaseGroups.forEach((group, gIdx) => {
    const isActiveGroup = gIdx === dashState.activeGroup;

    // Section heading for each root BP
    html += `<div class="dash-section-title${isActiveGroup ? ' active' : ''}" onclick="selectGroup(${gIdx})">${esc(group.parent_title)}</div>`;

    // Phase items within this group
    group.phases.forEach((phase, pIdx) => {
      const isActive = gIdx === dashState.activeGroup && pIdx === dashState.activePhase;
      const isDone = phase.progress.completed === phase.progress.total && phase.progress.total > 0;
      const classes = ['dash-phase-item'];
      if (isActive) classes.push('active');
      if (isDone) classes.push('completed');
      classes.push('phase-status-' + phase.bp_status.replace('_', '-'));

      html += `<div class="${classes.join(' ')}" onclick="selectGroupPhase(${gIdx}, ${pIdx})">
        <span class="dash-phase-num">${isDone ? '\u2713' : phase.phase_number}</span>
        <span class="dash-phase-name">${esc(phase.phase_label)}</span>
      </div>`;
    });

    // If root BP has no children, show it as a dispatchable single item
    if (group.phases.length === 0) {
      const isActive = gIdx === dashState.activeGroup && dashState.activePhase === -1;
      const bpStatus = group.parent_status || '';
      html += `<div class="dash-phase-item${isActive ? ' active' : ''} phase-status-${bpStatus.replace('_', '-')}" onclick="selectGroupPhase(${gIdx}, -1)">
        <span class="dash-phase-num">&#x25CF;</span>
        <span class="dash-phase-name">${esc(group.parent_title)}</span>
      </div>`;
    }
  });

  sidebar.innerHTML = html;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0) + ' ' + units[i];
}

function computeRuntime(claimed, completed) {
  if (!claimed || !completed) return '';
  const start = new Date(claimed);
  const end = new Date(completed);
  const diffMs = end - start;
  if (isNaN(diffMs) || diffMs < 0) return '';
  const mins = Math.floor(diffMs / 60000);
  const secs = Math.floor((diffMs % 60000) / 1000);
  if (mins > 0) return `${mins}m ${secs}s`;
  return `${secs}s`;
}

function renderInlineMissionPhases(detail) {
  if (!sidebarState.loopscriptPhases) return '';
  const phases = sidebarState.loopscriptPhases[resolveLoopscriptKey(detail)];
  if (!phases || phases.length === 0) return '';

  const bpPhase = (detail.phase || '').toLowerCase();
  const isActive = ['dispatched', 'claimed', 'in-progress', 'in_progress'].includes(detail.status);
  const isDone = ['completed', 'reviewed'].includes(detail.status);
  let currentIdx = bpPhase ? phases.findIndex(p => p.id.toLowerCase() === bpPhase) : -1;
  if (currentIdx < 0 && isActive) currentIdx = 0;
  if (isDone) currentIdx = phases.length; // all phases done

  let html = '<div class="inline-phases">';
  phases.forEach((phase, idx) => {
    const cls = (currentIdx > idx || isDone) ? 'completed' : idx === currentIdx ? 'active' : 'pending';
    const icon = cls === 'completed' ? '&#x2713;' : cls === 'active' ? '&#x25B6;' : '';
    html += `<div class="inline-phase-item ${cls}" title="${esc(phase.name)}"><span class="inline-phase-icon ${cls}">${icon}</span><span class="inline-phase-label">${esc(phase.name)}</span></div>`;
  });
  html += '</div>';
  return html;
}

function renderSubtaskCard(detail) {
  const statusClass = `status-${detail.status}`;
  const runtime = computeRuntime(detail.claimed, detail.completed);
  const mrpArtifacts = detail.mrp_artifacts || [];
  const allArtifacts = detail.output_artifacts.concat(mrpArtifacts);
  const existingCount = allArtifacts.filter(a => a.exists || a.exists_on_branch).length;
  const totalCount = allArtifacts.length;
  const branchParam = detail.branch ? `, '${esc(detail.branch)}'` : '';

  let html = `<div class="dash-subtask ${statusClass}">`;

  // Header: status badge + title + MRP button
  html += `<div class="dash-subtask-header">
    <div class="dash-subtask-left">
      <span class="dash-status-badge ${detail.status}">${esc(detail.status)}</span>
      <span class="dash-subtask-title">${esc(detail.title)}</span>
    </div>
    <div class="dash-subtask-right">`;
  html += `<button class="dash-view-bp-btn" onclick="showFullBriefingPack('${esc(detail.id)}')">Agent Brief</button>`;
  if (detail.has_mrp) {
    html += `<button class="dash-mrp-btn" onclick="showMrp('${esc(detail.id)}')">Completion Report</button>`;
  }
  // AC-1: Dispatch button for ready BPs with all deps met
  const subtaskBp = state.byId[detail.id];
  if (subtaskBp && isDispatchable(subtaskBp)) {
    html += `<button class="agent-action-btn dispatch-btn" onclick="dispatchBP('${esc(detail.id)}', event)"${!agentState.available ? ' disabled' : ''}>Handover task to an agent</button>`;
  }
  // AC-2: Review MRP agent button for completed BPs with MRP
  if (detail.has_mrp && detail.status === 'completed') {
    html += `<button class="agent-action-btn review-mrp-btn" onclick="reviewMrpAgent('${esc(detail.id)}', event)"${!agentState.available ? ' disabled' : ''}>Review MRP</button>`;
  }
  // Transition buttons for all applicable states
  html += renderTransitionButtons(detail.id);
  html += `</div></div>`;
  // AC-3: CRP resolve row — rendered asynchronously via placeholder
  html += `<div id="crp-row-${esc(detail.id)}" class="crp-response-row" style="display:none;padding:0 24px 6px"></div>`;

  // Description (with markdown rendering)
  if (detail.description) {
    html += `<div class="dash-subtask-desc dash-body-content">${renderMarkdown(detail.description)}</div>`;
  }

  // Meta line: runtime, artifact count, agent, phase
  const metaItems = [];
  if (detail.agent_id) {
    metaItems.push(`<span class="dash-meta-item"><span class="dash-meta-label">Agent:</span> <span class="dash-meta-value"><code>agt:${esc(detail.agent_id)}</code></span></span>`);
  }
  if (detail.phase) {
    metaItems.push(`<span class="dash-meta-item"><span class="dash-meta-label">Phase:</span> <span class="dash-meta-value">${esc(detail.phase)}</span></span>`);
  }
  if (runtime) {
    metaItems.push(`<span class="dash-meta-item"><span class="dash-meta-label">Runtime:</span> <span class="dash-meta-value">${esc(runtime)}</span></span>`);
  }
  if (totalCount > 0) {
    metaItems.push(`<span class="dash-meta-item"><span class="dash-meta-label">Artifacts:</span> <span class="dash-meta-value">${existingCount} / ${totalCount} produced</span></span>`);
  }
  if (detail.last_heartbeat) {
    metaItems.push(`<span class="dash-meta-item"><span class="dash-meta-label">Heartbeat:</span> <span class="dash-meta-value">${esc(timeAgo(detail.last_heartbeat))}</span></span>`);
  }
  if (metaItems.length > 0) {
    html += `<div class="dash-subtask-meta">${metaItems.join('')}</div>`;
  }

  // Mission phases (LoopScript progression)
  html += renderInlineMissionPhases(detail);

  // Acceptance criteria with grouped artifacts
  const acList = detail.acceptance_criteria || [];
  const acDone = detail.status === 'completed' || detail.status === 'reviewed';
  if (acList.length > 0) {
    // Group artifacts by AC code
    const artByAc = {};
    detail.output_artifacts.forEach(a => {
      const code = a.ac || '_ungrouped';
      if (!artByAc[code]) artByAc[code] = [];
      artByAc[code].push(a);
    });

    html += `<div class="dash-ac-section">`;
    html += `<div class="dash-ac-section-title">Acceptance Criteria</div>`;
    html += `<div class="dash-ac-list">`;

    acList.forEach(ac => {
      html += `<div class="dash-ac-item${acDone ? ' ac-done' : ''}">`;
      html += `<div class="dash-ac-header">
        ${acDone ? '<span class="dash-ac-check">&#x2713;</span>' : ''}
        <span class="dash-ac-code">${esc(ac.code)}</span>
        <span class="dash-ac-title">${esc(ac.title)}</span>
      </div>`;
      html += `<div class="dash-ac-desc dash-body-content">${renderMarkdown(ac.description)}</div>`;

      // Artifacts for this AC
      const arts = artByAc[ac.code] || [];
      if (arts.length > 0) {
        html += `<div class="dash-ac-artifacts">`;
        arts.forEach(a => {
          const avail = a.exists || a.exists_on_branch;
          const onBranch = a.exists_on_branch && !a.exists;
          const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
          const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
          const filename = a.path.split('/').pop();
          const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${onBranch ? branchParam : ''})"` : '';
          html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${onBranch ? ' (on agent branch)' : ''}">
            <span class="dash-artifact-icon">${icon}</span>
            <span class="dash-artifact-name">${esc(filename)}</span>
            ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
            ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
          </div>`;
        });
        html += `</div>`;
      }

      html += `</div>`;
    });

    html += `</div></div>`;

    // Ungrouped artifacts (have no AC or AC not in parsed criteria)
    const groupedCodes = new Set(acList.map(ac => ac.code));
    const ungrouped = detail.output_artifacts.filter(a => !a.ac || !groupedCodes.has(a.ac));
    if (ungrouped.length > 0) {
      html += `<div class="dash-subtask-artifacts">`;
      html += `<div class="dash-subtask-artifacts-title">Other Artifacts</div>`;
      html += `<div class="dash-artifact-grid">`;
      ungrouped.forEach(a => {
        const avail = a.exists || a.exists_on_branch;
        const onBranch = a.exists_on_branch && !a.exists;
        const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
        const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
        const filename = a.path.split('/').pop();
        const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${onBranch ? branchParam : ''})"` : '';
        html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${onBranch ? ' (on agent branch)' : ''}">
          <span class="dash-artifact-icon">${icon}</span>
          <span class="dash-artifact-name">${esc(filename)}</span>
          ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
          ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
        </div>`;
      });
      html += `</div></div>`;
    }
  } else if (detail.output_artifacts.length > 0) {
    // No parsed AC — show artifacts flat
    html += `<div class="dash-subtask-artifacts">`;
    html += `<div class="dash-subtask-artifacts-title">Output Artifacts</div>`;
    html += `<div class="dash-artifact-grid">`;
    detail.output_artifacts.forEach(a => {
      const avail = a.exists || a.exists_on_branch;
      const onBranch = a.exists_on_branch && !a.exists;
      const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
      const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
      const filename = a.path.split('/').pop();
      const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${onBranch ? branchParam : ''})"` : '';
      html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${onBranch ? ' (on agent branch)' : ''}">
        <span class="dash-artifact-icon">${icon}</span>
        <span class="dash-artifact-name">${esc(filename)}</span>
        ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
        ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
      </div>`;
    });
    html += `</div></div>`;
  }

  // MRP artifacts (additional files from MRP not in ACs)
  const mrpArts = detail.mrp_artifacts || [];
  if (mrpArts.length > 0) {
    html += `<div class="dash-subtask-artifacts">`;
    html += `<div class="dash-subtask-artifacts-title">MRP Artifacts</div>`;
    html += `<div class="dash-artifact-grid">`;
    mrpArts.forEach(a => {
      const avail = a.exists || a.exists_on_branch;
      const onBranch = a.exists_on_branch && !a.exists;
      const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
      const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
      const filename = a.path.split('/').pop();
      const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${onBranch ? branchParam : ''})"` : '';
      const desc = a.description ? ` — ${esc(a.description)}` : '';
      html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${desc}${onBranch ? ' (on agent branch)' : ''}">
        <span class="dash-artifact-icon">${icon}</span>
        <span class="dash-artifact-name">${esc(filename)}</span>
        ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
        ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
      </div>`;
    });
    html += `</div></div>`;
  }

  html += `</div>`;
  return html;
}

function renderDepGraph(details) {
  // Build lookup and compute layout layers (topological)
  const idMap = {};
  details.forEach((d, i) => { idMap[d.id] = i; });

  // Determine layers via dependency depth
  const layers = new Array(details.length).fill(0);
  const visited = new Set();

  function computeLayer(idx) {
    if (visited.has(idx)) return layers[idx];
    visited.add(idx);
    const d = details[idx];
    const deps = (d.depends_on || []).filter(depId => depId in idMap);
    if (deps.length === 0) { layers[idx] = 0; return 0; }
    let maxDep = 0;
    deps.forEach(depId => {
      maxDep = Math.max(maxDep, computeLayer(idMap[depId]) + 1);
    });
    layers[idx] = maxDep;
    return maxDep;
  }
  details.forEach((_, i) => computeLayer(i));

  // Group nodes by layer
  const maxLayer = Math.max(...layers, 0);
  const layerGroups = [];
  for (let l = 0; l <= maxLayer; l++) {
    layerGroups.push(details.map((d, i) => i).filter(i => layers[i] === l));
  }

  // Layout constants
  const nodeW = 180, nodeH = 56;
  const gapX = 60, gapY = 48;
  const padX = 40, padY = 30;
  const arrowGap = 6; // space between arrowhead and node edge

  // Position nodes
  const positions = [];
  const maxNodesInLayer = Math.max(...layerGroups.map(g => g.length));
  const totalW = Math.max(maxNodesInLayer * (nodeW + gapX) - gapX + padX * 2, nodeW + padX * 2);

  layerGroups.forEach((group, layerIdx) => {
    const layerW = group.length * (nodeW + gapX) - gapX;
    const offsetX = (totalW - layerW) / 2;
    group.forEach((nodeIdx, posInLayer) => {
      positions[nodeIdx] = {
        x: offsetX + posInLayer * (nodeW + gapX),
        y: padY + layerIdx * (nodeH + gapY),
      };
    });
  });

  const svgW = totalW;
  const svgH = padY * 2 + (maxLayer + 1) * (nodeH + gapY) - gapY;

  // Build SVG
  let svg = `<svg class="dep-graph-svg" width="${svgW}" height="${svgH}" viewBox="0 0 ${svgW} ${svgH}" xmlns="http://www.w3.org/2000/svg">`;

  // Arrow marker defs — triangles matching edge colors
  svg += `<defs>
    <marker id="dep-arrow" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L10,4 L0,8 Z" fill="#4b5068" />
    </marker>
    <marker id="dep-arrow-done" markerWidth="10" markerHeight="8" refX="10" refY="4" orient="auto" markerUnits="userSpaceOnUse">
      <path d="M0,0 L10,4 L0,8 Z" fill="#22c55e" opacity="0.45" />
    </marker>
    <pattern id="dep-hatch-stale" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="#1f1424" />
      <line x1="0" y1="0" x2="0" y2="8" stroke="#a855f7" stroke-width="2" stroke-opacity="0.45" />
    </pattern>
  </defs>`;

  // Draw edges (dependency arrows: from dependency → dependent)
  details.forEach((d, i) => {
    const deps = (d.depends_on || []).filter(depId => depId in idMap);
    deps.forEach(depId => {
      const fromIdx = idMap[depId];
      const from = positions[fromIdx];
      const to = positions[i];
      const fromDone = ['completed', 'reviewed'].includes(details[fromIdx].status);
      const cls = fromDone ? 'dep-graph-edge completed' : 'dep-graph-edge';
      const marker = fromDone ? 'url(#dep-arrow-done)' : 'url(#dep-arrow)';

      // Curved path from bottom-center of source to top-center of target
      const x1 = from.x + nodeW / 2, y1 = from.y + nodeH;
      const x2 = to.x + nodeW / 2, y2 = to.y - arrowGap;
      const dy = y2 - y1;
      const cp = Math.max(dy * 0.45, 20);

      svg += `<path class="${cls}" d="M${x1},${y1} C${x1},${y1 + cp} ${x2},${y2 - cp} ${x2},${y2}" marker-end="${marker}" />`;
    });
  });

  // Draw nodes
  details.forEach((d, i) => {
    const pos = positions[i];
    const statusCls = `status-${d.status}`;
    const r = 8;

    svg += `<g class="dep-graph-node ${statusCls}" transform="translate(${pos.x}, ${pos.y})">`;
    svg += `<rect width="${nodeW}" height="${nodeH}" rx="${r}" ry="${r}" />`;

    // Spinner ring for active (dispatched / in-progress)
    if (d.status === 'in_progress' || d.status === 'in-progress' || d.status === 'dispatched') {
      svg += `<rect class="dep-graph-spinner" x="-3" y="-3" width="${nodeW + 6}" height="${nodeH + 6}" rx="${r + 3}" ry="${r + 3}" />`;
    }

    // Title via foreignObject for proper text wrapping
    svg += `<foreignObject x="0" y="0" width="${nodeW}" height="${nodeH}">
      <div xmlns="http://www.w3.org/1999/xhtml" class="dep-graph-node-label">${esc(d.title)}</div>
    </foreignObject>`;

    svg += `</g>`;
  });

  svg += `</svg>`;

  // Legend
  const legendItems = [
    { cls: 'swatch-draft',       label: 'Draft' },
    { cls: 'swatch-ready',       label: 'Ready' },
    { cls: 'swatch-in-progress', label: 'In Progress' },
    { cls: 'swatch-dispatched',  label: 'Dispatched' },
    { cls: 'swatch-completed',   label: 'Completed' },
    { cls: 'swatch-reviewed',    label: 'Reviewed' },
    { cls: 'swatch-stale',       label: 'Stale' },
  ];

  const legend = legendItems
    .map(item => `<span class="dep-graph-legend-item"><span class="dep-graph-legend-swatch ${item.cls}"></span>${item.label}</span>`)
    .join('');

  return `<div class="dep-graph-container">${svg}<div class="dep-graph-legend">${legend}</div></div>`;
}

function renderDashContent(group) {
  const content = document.getElementById('dash-content');

  // Root BP with no phases selected (standalone leaf BP)
  if (dashState.activePhase === -1 || !group.phases[dashState.activePhase]) {
    const bp = state.byId[group.parent_id];
    const bpStatus = group.parent_status || (bp && bp.status) || '';
    let html = `<div class="dash-phase-header">
      <div class="dash-phase-header-top">
        <h2>${esc(group.parent_title)}</h2>
        <div class="dash-phase-actions">
          ${bpStatus ? `<span class="dash-status-badge ${bpStatus}">${esc(bpStatus)}</span>` : ''}
          ${bp && bp.body ? `<button class="dash-view-bp-btn" onclick="showFullBriefingPack('${esc(group.parent_id)}')">Agent Brief</button>` : ''}
          ${bp && isDispatchable(bp) ? `<button class="agent-action-btn dispatch-btn" onclick="dispatchBP('${esc(group.parent_id)}', event)"${!agentState.available ? ' disabled' : ''}>Handover task to an agent</button>` : ''}
          ${bp ? renderTransitionButtons(group.parent_id) : ''}
        </div>
      </div>
    </div>`;
    if (group.self_detail) {
      // Rich card — same as any leaf subtask
      html += '<div class="dash-subtask-list">';
      html += renderSubtaskCard(group.self_detail);
      html += '</div>';
    } else if (bp && bp.body) {
      html += `<div class="dash-body-content" style="padding:0 24px 20px">${renderMarkdown(bp.body)}</div>`;
    }
    content.innerHTML = html;
    detectAndRenderCrp(group.parent_id);
    return;
  }

  const phase = group.phases[dashState.activePhase];
  const bp = state.byId[phase.bp_id];
  let html = '';

  // Phase header with status and actions
  html += `<div class="dash-phase-header">
    <div class="dash-phase-header-top">
      <h2>${esc(phase.phase_label)}</h2>
      <div class="dash-phase-actions">
        <span class="dash-status-badge ${phase.bp_status}">${esc(phase.bp_status)}</span>
        ${bp && bp.body ? `<button class="dash-view-bp-btn" onclick="showFullBriefingPack('${esc(phase.bp_id)}')">Agent Brief</button>` : ''}
        ${bp && isDispatchable(bp) ? `<button class="agent-action-btn dispatch-btn" onclick="dispatchBP('${esc(phase.bp_id)}', event)"${!agentState.available ? ' disabled' : ''}>Handover task to an agent</button>` : ''}
        ${bp ? renderTransitionButtons(phase.bp_id) : ''}
      </div>
    </div>
    <div class="dash-phase-desc">${renderMarkdown(phase.description)}</div>
  </div>`;

  // Dependencies
  if (phase.depends_on && phase.depends_on.length > 0) {
    const depHtml = phase.depends_on.map(depId => {
      let label = null;
      for (const g of dashState.phaseGroups) {
        const depPhase = g.phases.find(p => p.bp_id === depId);
        if (depPhase) { label = depPhase.phase_label; break; }
      }
      if (label === null) {
        const b = state.byId[depId];
        label = b ? b.slug : depId.substring(0, 12);
      }
      return bpIdLabel(depId, label, 'bp-id-code');
    }).join(', ');
    html += `<div class="dash-deps">Depends on: ${depHtml}</div>`;
  }

  // Dependency graph visualization
  const details = phase.child_details || [];
  if (details.length > 0) {
    html += renderDepGraph(details);
  }

  // Subtask cards (primary content)
  if (details.length > 0) {
    html += `<div class="dash-subtasks-title">Sub-Tasks (${details.length})</div>`;
    html += '<div class="dash-subtask-list">';
    details.forEach(d => { html += renderSubtaskCard(d); });
    html += '</div>';
  }

  content.innerHTML = html;

  // AC-3: Async CRP detection — check for CRPs on each subtask and render resolve button
  if (details.length > 0) {
    details.forEach(d => detectAndRenderCrp(d.id));
  }
}

/**
 * Async CRP detection: fetches CRP status for a BP and renders the resolve UI if found.
 */
async function detectAndRenderCrp(bpId) {
  const hasCrp = await fetchCrpStatus(bpId);
  const row = document.getElementById(`crp-row-${bpId}`);
  if (!row) return;
  if (hasCrp) {
    row.style.display = 'flex';
    row.innerHTML = `
      <input type="text" id="crp-input-${esc(bpId)}" class="crp-response-input" placeholder="CRP response..." onkeydown="if(event.key==='Enter')resolveCrpAgent('${esc(bpId)}',event)">
      <button class="agent-action-btn resolve-crp-btn" onclick="resolveCrpAgent('${esc(bpId)}', event)"${!agentState.available ? ' disabled' : ''}>Resolve CRP</button>
    `;
  }
}

function renderCollapsible(title, innerHtml) {
  const id = 'coll-' + title.replace(/\W+/g, '-').toLowerCase();
  return `<div class="dash-collapsible" id="${id}">
    <button class="dash-collapsible-toggle" onclick="toggleCollapsible('${id}')">
      <span class="dash-collapsible-arrow">\u25B6</span> ${esc(title)}
    </button>
    <div class="dash-collapsible-body">
      <div class="dash-body-content">${innerHtml}</div>
    </div>
  </div>`;
}

function toggleCollapsible(id) {
  document.getElementById(id).classList.toggle('open');
}

let _previewOpenKey = null;
let _previewCurrentData = null;

/**
 * Replace known artifact paths in rendered HTML with clickable preview links.
 * Targets paths inside <code> tags (backtick-quoted in markdown).
 */
function linkifyArtifacts(html, bp) {
  if (!bp || !bp.artifacts || bp.artifacts.length === 0) return html;
  const branch = bp.branch;
  const branchParam = branch ? `, '${esc(branch)}'` : '';
  // Collect all artifact paths, longest first to avoid partial matches
  const paths = bp.artifacts.map(a => a.path).sort((a, b) => b.length - a.length);
  paths.forEach(path => {
    const escaped = esc(path);
    // Replace <code>path</code> with a clickable version
    html = html.replaceAll(
      `<code>${escaped}</code>`,
      `<code class="artifact-link" onclick="previewArtifact('${esc(path)}'${branchParam})" title="Click to preview">${escaped}</code>`
    );
  });
  return html;
}

function openPreviewPanel(key, title, html) {
  // Close agent panel if not actively streaming
  if (!agentState.active) {
    document.getElementById('agent-panel').classList.remove('open');
  }
  const panel = document.getElementById('preview-panel');
  _previewOpenKey = key;
  document.getElementById('preview-panel-title').textContent = title;
  document.getElementById('preview-panel-body').innerHTML = html;
  panel.classList.add('open');
  document.getElementById('preview-panel-body').scrollTop = 0;
  document.getElementById('preview-fullscreen-btn').style.display = '';
}

function closePreview() {
  _previewOpenKey = null;
  _previewCurrentData = null;
  _dirRootPath = null;
  document.getElementById('preview-panel').classList.remove('open');
  document.getElementById('preview-panel-body').style.padding = '';
}

function openFullscreenPreview() {
  if (!_previewCurrentData && !_previewOpenKey) return;
  const overlay = document.getElementById('fullscreen-preview-overlay');
  const title = document.getElementById('preview-panel-title').textContent;
  document.getElementById('fullscreen-preview-title').textContent = title;
  const body = document.getElementById('fullscreen-preview-body');

  if (_previewCurrentData && _previewCurrentData.suffix === '.html') {
    body.innerHTML = `<iframe sandbox="allow-scripts allow-same-origin" srcdoc="${esc(_previewCurrentData.content).replace(/"/g, '&quot;')}"></iframe>`;
  } else if (_previewCurrentData && _previewCurrentData.suffix === '.md') {
    body.innerHTML = `<div class="fullscreen-text-content">${renderMarkdown(_previewCurrentData.content)}</div>`;
  } else if (_previewCurrentData) {
    body.innerHTML = `<div class="fullscreen-text-content"><pre>${esc(_previewCurrentData.content)}</pre></div>`;
  } else {
    // MRP or other rendered content — copy from panel
    const panelBody = document.getElementById('preview-panel-body');
    body.innerHTML = `<div class="fullscreen-text-content">${panelBody.innerHTML}</div>`;
  }

  overlay.classList.add('open');
}

function closeFullscreenPreview() {
  const overlay = document.getElementById('fullscreen-preview-overlay');
  overlay.classList.remove('open');
  document.getElementById('fullscreen-preview-body').innerHTML = '';
}

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (document.getElementById('fullscreen-preview-overlay').classList.contains('open')) {
      closeFullscreenPreview();
    } else if (document.getElementById('preview-panel').classList.contains('open')) {
      closePreview();
    }
  }
});

async function showMrp(bpId) {
  const key = 'mrp:' + bpId;
  if (_previewOpenKey === key) { closePreview(); return; }
  openPreviewPanel(key, 'Completion Report', '<p style="color:var(--text-muted)">Loading...</p>');
  const body = document.getElementById('preview-panel-body');
  // Try structured view first
  try {
    const resp = await fetch('/api/mrp-structured/' + bpId);
    if (resp.ok) {
      const data = await resp.json();
      dashboardState2.reviewMrpStructuredCache[bpId] = data;
      renderMrpStructuredView(data, body, bpId);
      return;
    }
  } catch (e) { /* fall through */ }
  // Legacy fallback
  try {
    const resp = await fetch('/api/mrp/' + bpId);
    if (!resp.ok) throw new Error('MRP not found');
    const data = await resp.json();
    body.innerHTML = renderMarkdown(data.body);
  } catch (err) {
    body.innerHTML =
      `<p style="color:var(--text-muted)">Failed to load MRP: ${esc(err.message)}</p>`;
  }
}

function renderRevisionHistory(bp) {
  const log = bp.revision_log;
  if (!log || !Array.isArray(log) || log.length === 0) {
    return '<p style="color:var(--text-muted)">No revision history available.</p>';
  }
  const scope = bp.re_execution_scope;
  let html = '<div class="revision-timeline">';
  log.forEach((entry, idx) => {
    const rev = entry.rev || (idx + 1);
    const date = entry.date || '';
    const agentId = entry['agent-id'] || entry.agent_id || '';
    const reason = entry['revision-reason'] || entry.revision_reason || '';
    const outcome = entry.outcome || '';
    const mrp = entry.mrp || '';
    const vcr = entry.vcr || '';
    html += `<div class="revision-entry">
      <div class="revision-entry-marker"><span class="revision-dot"></span>${idx < log.length - 1 ? '<span class="revision-line"></span>' : ''}</div>
      <div class="revision-entry-content">
        <div class="revision-entry-header">
          <span class="revision-entry-rev">Revision ${esc(String(rev))}</span>
          <span class="revision-entry-outcome ${esc(outcome)}">${esc(outcome)}</span>
          ${date ? `<span class="revision-entry-date">${esc(date)}</span>` : ''}
        </div>
        ${reason ? `<div class="revision-entry-reason">${esc(reason)}</div>` : ''}
        <div class="revision-entry-meta">
          ${agentId ? `<span>Agent: <code>agt:${esc(agentId)}</code></span>` : ''}
          ${mrp ? `<span>MRP: <code>${esc(mrp)}</code></span>` : ''}
          ${vcr ? `<span>VCR: <code>${esc(vcr)}</code></span>` : ''}
        </div>
      </div>
    </div>`;
  });
  html += '</div>';
  // Re-execution scope (if present and non-empty)
  if (scope && typeof scope === 'object' && Object.keys(scope).length > 0) {
    html += `<details class="revision-scope-details">
      <summary>Re-execution Scope</summary>
      <div class="revision-scope-content">`;
    if (scope.reason) html += `<div class="revision-scope-row"><span class="revision-scope-label">Reason</span><span>${esc(scope.reason)}</span></div>`;
    const affectedAcs = scope['affected-acs'] || scope.affected_acs || [];
    if (affectedAcs.length > 0) html += `<div class="revision-scope-row"><span class="revision-scope-label">Affected ACs</span><span>${affectedAcs.map(ac => `<code>${esc(ac)}</code>`).join(', ')}</span></div>`;
    const preserve = scope['preserve-artifacts'] || scope.preserve_artifacts || [];
    if (preserve.length > 0) {
      html += `<div class="revision-scope-row"><span class="revision-scope-label">Preserve</span><ul class="revision-scope-list">`;
      preserve.forEach(a => {
        const path = typeof a === 'string' ? a : (a.path || '');
        const note = typeof a === 'object' ? (a.note || '') : '';
        html += `<li><code>${esc(path)}</code>${note ? ` — ${esc(note)}` : ''}</li>`;
      });
      html += `</ul></div>`;
    }
    const reverify = scope['re-verify-artifacts'] || scope.re_verify_artifacts || [];
    if (reverify.length > 0) {
      html += `<div class="revision-scope-row"><span class="revision-scope-label">Re-verify</span><ul class="revision-scope-list">`;
      reverify.forEach(a => {
        const path = typeof a === 'string' ? a : (a.path || '');
        const cmd = typeof a === 'object' ? (a['verify-command'] || a.verify_command || '') : '';
        html += `<li><code>${esc(path)}</code>${cmd ? ` <span class="revision-verify-cmd">${esc(cmd)}</span>` : ''}</li>`;
      });
      html += `</ul></div>`;
    }
    html += `</div></details>`;
  }
  return html;
}

function showFullBriefingPack(bpId) {
  const bp = state.byId[bpId];
  if (!bp || !bp.body) return;
  const key = 'bp-full:' + bpId;
  if (_previewOpenKey === key) { closePreview(); return; }
  const title = bp.title || bp.slug || 'Agent Brief';
  // Build full BP view: frontmatter summary + body
  let html = '<div class="dash-body-content">';
  html += `<div class="bp-full-meta">`;
  html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">ID</span>${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</div>`;
  html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Status</span><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></div>`;
  if (bp.revision && parseInt(bp.revision) > 1) html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Revision</span><span class="queue-item-badge queue-badge-revision">Rev\u00a0${esc(String(bp.revision))}</span></div>`;
  if (bp.rigor) html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Rigor</span>${esc(bp.rigor)}</div>`;
  if (bp.parent) {
    const parent = state.byId[bp.parent];
    html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Parent</span>${esc(parent ? parent.title : bp.parent)}</div>`;
  }
  if (bp.children && bp.children.length > 0) {
    html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Children</span>${bp.children.length} sub-tasks</div>`;
  }
  if (bp.depends_on && bp.depends_on.length > 0) {
    const depHtml = bp.depends_on.map(did => {
      const d = state.byId[did];
      const label = d ? d.title : did.substring(0,12);
      return bpIdLabel(did, label, 'bp-id-code');
    }).join(', ');
    html += `<div class="bp-full-meta-row"><span class="bp-full-meta-label">Depends on</span>${depHtml}</div>`;
  }
  html += `</div><hr style="border-color:var(--border);margin:16px 0">`;
  html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  html += '</div>';
  openPreviewPanel(key, title, html);
}

// Track the root artifact path for directory navigation breadcrumbs
let _dirRootPath = null;

function _renderDirListing(data) {
  const body = document.getElementById('preview-panel-body');
  body.style.padding = '0';

  // Build breadcrumb from _dirRootPath to current data.path
  let breadcrumbHtml = '<div class="dir-breadcrumb">';
  const rootName = _dirRootPath.split('/').pop();
  const segments = data.path.replace(_dirRootPath, '').split('/').filter(Boolean);

  if (segments.length === 0) {
    // We are at the root directory
    breadcrumbHtml += `<span class="dir-breadcrumb-current">${esc(rootName)}</span>`;
  } else {
    // Root link
    breadcrumbHtml += `<span class="dir-breadcrumb-seg" onclick="previewArtifact('${esc(_dirRootPath)}')">${esc(rootName)}</span>`;
    // Intermediate segments
    let accumulated = _dirRootPath;
    segments.forEach((seg, i) => {
      breadcrumbHtml += `<span class="dir-breadcrumb-sep">/</span>`;
      accumulated += '/' + seg;
      if (i === segments.length - 1) {
        breadcrumbHtml += `<span class="dir-breadcrumb-current">${esc(seg)}</span>`;
      } else {
        const navPath = accumulated;
        breadcrumbHtml += `<span class="dir-breadcrumb-seg" onclick="previewArtifact('${esc(navPath)}')">${esc(seg)}</span>`;
      }
    });
  }
  breadcrumbHtml += '</div>';

  // Build file listing
  let listHtml = '';
  if (data.entries.length === 0) {
    listHtml = '<div class="dir-listing-empty">Empty directory</div>';
  } else {
    listHtml = '<ul class="dir-listing">';
    const binarySuffixes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war', '.ear', '.class', '.pyc', '.pyo', '.o', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.eot', '.pdf']);
    data.entries.forEach(entry => {
      const icon = entry.is_dir ? '\ud83d\udcc1' : '\ud83d\udcc4';
      const canPreview = entry.is_dir || !binarySuffixes.has(entry.suffix);
      const clickAttr = canPreview ? `onclick="previewArtifact('${esc(entry.path)}')"` : '';
      const cursorCls = canPreview ? '' : ' style="cursor:default;opacity:0.6"';
      listHtml += `<li class="dir-listing-item${entry.is_dir ? ' is-dir' : ''}" ${clickAttr}${cursorCls}>
        <span class="dir-listing-icon">${icon}</span>
        <span class="dir-listing-name">${esc(entry.name)}</span>
        ${entry.is_dir ? '' : `<span class="dir-listing-suffix">${esc(entry.suffix.replace('.', ''))}</span>`}
        ${entry.is_dir ? '' : `<span class="dir-listing-size">${formatBytes(entry.size)}</span>`}
      </li>`;
    });
    listHtml += '</ul>';
  }

  body.innerHTML = breadcrumbHtml + listHtml;
}

async function previewArtifact(path, branch) {
  if (_previewOpenKey === path) { closePreview(); return; }
  const filename = path.split('/').pop();
  openPreviewPanel(path, filename, '<p style="color:var(--text-muted)">Loading...</p>');
  try {
    let url = '/api/preview?path=' + encodeURIComponent(path);
    if (branch) url += '&branch=' + encodeURIComponent(branch);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Preview not available');
    const data = await resp.json();
    _previewCurrentData = data;

    // Directory response
    if (data.is_dir) {
      // Set root path if this is the first directory opened (not a sub-navigation)
      if (!_dirRootPath || !path.startsWith(_dirRootPath)) {
        _dirRootPath = path;
      }
      document.getElementById('preview-fullscreen-btn').style.display = 'none';
      _renderDirListing(data);
      return;
    }

    // File response — keep _dirRootPath if navigating inside a directory
    const insideDir = _dirRootPath && path.startsWith(_dirRootPath + '/');
    if (!insideDir) {
      _dirRootPath = null;
    }
    const body = document.getElementById('preview-panel-body');
    // Show branch indicator when content comes from an agent branch
    let branchBanner = '';
    if (data.from_branch) {
      branchBanner = `<div style="background:var(--status-in-progress);color:#fff;padding:4px 12px;font-size:11px;font-weight:600;border-radius:4px;margin-bottom:8px;display:inline-block;">Reading from branch: ${esc(data.from_branch)}</div>`;
    }
    let contentHtml = '';
    if (data.suffix === '.html') {
      body.style.padding = '0';
      contentHtml = `<iframe class="html-preview" sandbox="allow-scripts allow-same-origin" srcdoc="${esc(data.content).replace(/"/g, '&quot;')}"></iframe>`;
    } else if (data.suffix === '.md') {
      body.style.padding = '';
      contentHtml = renderMarkdown(data.content);
    } else if (data.suffix === '.json') {
      body.style.padding = '';
      contentHtml = `<pre><code>${esc(data.content)}</code></pre>`;
    } else {
      body.style.padding = '';
      contentHtml = `<pre>${esc(data.content)}</pre>`;
    }
    // Add back-to-directory navigation when viewing a file inside a directory artifact
    if (insideDir) {
      const parentDir = path.substring(0, path.lastIndexOf('/'));
      const backHtml = `<div class="dir-breadcrumb">
        <span class="dir-breadcrumb-seg" onclick="previewArtifact('${esc(parentDir)}')">\u2190 Back to directory</span>
        <span class="dir-breadcrumb-sep">\u00b7</span>
        <span class="dir-breadcrumb-current">${esc(data.filename)}</span>
      </div>`;
      body.innerHTML = branchBanner + backHtml + contentHtml;
    } else {
      body.innerHTML = branchBanner + contentHtml;
    }
  } catch (err) {
    _previewCurrentData = null;
    document.getElementById('preview-panel-body').innerHTML =
      `<p style="color:var(--text-muted)">Cannot preview: ${esc(err.message)}</p>`;
  }
}

function syntaxHighlightJson(json) {
  return json.replace(/("(?:\\.|[^"\\])*")\s*:/g, '<span class="json-key">$1</span>:')
    .replace(/:\s*("(?:\\.|[^"\\])*")/g, ': <span class="json-str">$1</span>')
    .replace(/:\s*(\d+\.?\d*)/g, ': <span class="json-num">$1</span>')
    .replace(/:\s*(true|false)/g, ': <span class="json-bool">$1</span>')
    .replace(/:\s*(null)/g, ': <span class="json-null">$1</span>');
}

async function showPreview(path) {
  const root = document.getElementById('mrp-modal-root');
  const filename = path.split('/').pop();
  root.innerHTML = `<div class="mrp-overlay" onclick="closeMrp(event)">
    <div class="mrp-modal" onclick="event.stopPropagation()">
      <div class="mrp-modal-header">
        <h3>${esc(filename)}</h3>
        <button class="mrp-modal-close" onclick="closeMrp()">\u2715</button>
      </div>
      <div class="mrp-modal-body">Loading...</div>
    </div>
  </div>`;

  try {
    const resp = await fetch('/api/preview?path=' + encodeURIComponent(path));
    if (!resp.ok) throw new Error('File not found');
    const data = await resp.json();
    const body = root.querySelector('.mrp-modal-body');

    // Directory listing in modal
    if (data.is_dir) {
      let html = `<div class="preview-meta">
        <span>Path: <span class="val">${esc(data.path)}</span></span>
        <span>Entries: <span class="val">${data.entries.length}</span></span>
      </div>`;
      const binarySuffixes = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svg', '.mp3', '.mp4', '.wav', '.avi', '.mov', '.zip', '.tar', '.gz', '.bz2', '.7z', '.rar', '.jar', '.war', '.ear', '.class', '.pyc', '.pyo', '.o', '.so', '.dylib', '.dll', '.exe', '.bin', '.dat', '.db', '.sqlite', '.woff', '.woff2', '.ttf', '.eot', '.pdf']);
      if (data.entries.length === 0) {
        html += '<div class="dir-listing-empty">Empty directory</div>';
      } else {
        html += '<ul class="dir-listing">';
        data.entries.forEach(entry => {
          const icon = entry.is_dir ? '\ud83d\udcc1' : '\ud83d\udcc4';
          const canPreview = entry.is_dir || !binarySuffixes.has(entry.suffix);
          const clickAttr = canPreview ? `onclick="showPreview('${esc(entry.path)}')"` : '';
          const cursorCls = canPreview ? '' : ' style="cursor:default;opacity:0.6"';
          html += `<li class="dir-listing-item${entry.is_dir ? ' is-dir' : ''}" ${clickAttr}${cursorCls}>
            <span class="dir-listing-icon">${icon}</span>
            <span class="dir-listing-name">${esc(entry.name)}</span>
            ${entry.is_dir ? '' : `<span class="dir-listing-suffix">${esc(entry.suffix.replace('.', ''))}</span>`}
            ${entry.is_dir ? '' : `<span class="dir-listing-size">${formatBytes(entry.size)}</span>`}
          </li>`;
        });
        html += '</ul>';
      }
      body.innerHTML = html;
      return;
    }

    let html = `<div class="preview-meta">
      <span>Path: <span class="val">${esc(data.path)}</span></span>
      <span>Size: <span class="val">${formatBytes(data.size)}</span></span>
    </div>`;

    if (data.suffix === '.json') {
      try {
        const parsed = JSON.parse(data.content);
        const formatted = JSON.stringify(parsed, null, 2);
        html += `<div class="preview-json">${syntaxHighlightJson(esc(formatted))}</div>`;
      } catch {
        html += `<div class="preview-json">${esc(data.content)}</div>`;
      }
    } else if (data.suffix === '.md') {
      html += `<div class="dash-body-content">${renderMarkdown(data.content)}</div>`;
    } else {
      html += `<div class="preview-json">${esc(data.content)}</div>`;
    }

    if (data.truncated) {
      html += `<div class="preview-truncated">File truncated — showing first 2 MB of ${formatBytes(data.size)}</div>`;
    }

    body.innerHTML = html;
  } catch (err) {
    root.querySelector('.mrp-modal-body').innerHTML =
      `<div class="dash-empty">Failed to load preview: ${esc(err.message)}</div>`;
  }
}

function selectPhase(idx) {
  selectGroupPhase(dashState.activeGroup, idx);
}

function selectGroup(gIdx) {
  dashState.activeGroup = gIdx;
  dashState.activePhase = dashState.phaseGroups[gIdx].phases.length > 0 ? 0 : -1;
  renderDashSidebar();
  renderDashContent(dashState.phaseGroups[gIdx]);
  document.getElementById('dash-content').scrollTop = 0;

  // AC-4: Track selected BP for chat context injection
  const group = dashState.phaseGroups[gIdx];
  if (group) setSelectedBp(group.parent_id);
}

function selectGroupPhase(gIdx, pIdx) {
  dashState.activeGroup = gIdx;
  dashState.activePhase = pIdx;
  closePreview();
  renderDashSidebar();
  renderDashContent(dashState.phaseGroups[gIdx]);
  document.getElementById('dash-content').scrollTop = 0;

  // AC-4: Track selected BP for chat context injection
  const group = dashState.phaseGroups[gIdx];
  if (group && group.phases[pIdx]) {
    setSelectedBp(group.phases[pIdx].bp_id);
  } else if (group) {
    setSelectedBp(group.parent_id);
  }
}

// ─── Overview ─────────────────────────────────────────────────────────

function collectDescendantBPs(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return [];
  const result = [];
  (bp.children || []).forEach(cid => {
    const child = state.byId[cid];
    if (child) {
      result.push(child);
      result.push(...collectDescendantBPs(cid));
    }
  });
  return result;
}

function countByStatus(bps) {
  const counts = { draft: 0, ready: 0, dispatched: 0, in_progress: 0, completed: 0, reviewed: 0 };
  bps.forEach(bp => {
    const s = (bp.status || 'draft').replace('-', '_');
    if (s in counts) counts[s]++;
    else counts.draft++;
  });
  return counts;
}

function isDependencyMet(depId) {
  const dep = state.byId[depId];
  if (!dep) return false;
  const s = (dep.status || '').replace('-', '_');
  // Parent status is already derived from children by the server
  return s === 'completed' || s === 'reviewed';
}

// topoSortRoots is defined earlier (near layout) with cross-level dependency support

// ─── Hierarchy Helpers (Breadcrumbs, Grouping, Sorting) ───────────────

function getAncestorChain(bpId) {
  const chain = [];
  let id = bpId;
  const seen = new Set();
  while (id && state.byId[id] && !seen.has(id)) {
    seen.add(id);
    const bp = state.byId[id];
    chain.unshift({ id: bp.id, title: bp.title || bp.slug });
    id = bp.parent;
  }
  return chain;
}

function getRootId(bpId) {
  const id = typeof bpId === 'object' ? bpId.id : bpId;
  const chain = getAncestorChain(id);
  return chain.length > 0 ? chain[0].id : id;
}

function renderBPBreadcrumb(bpOrId, small) {
  const bp = typeof bpOrId === 'string' ? state.byId[bpOrId] : bpOrId;
  if (!bp) return '';
  const chain = getAncestorChain(bp.id);
  const cls = small ? 'db-breadcrumb db-breadcrumb-sm' : 'db-breadcrumb';
  if (chain.length <= 1) {
    const sz = small ? ' style="font-size:12px"' : '';
    return `<div class="db-item-title"${sz}>${esc(bp.title || bp.slug)}</div>`;
  }
  const ancestors = chain.slice(0, -1);
  const current = chain[chain.length - 1];
  let h = `<div class="${cls}">`;
  ancestors.forEach((a, i) => {
    if (i > 0) h += '<span class="db-bc-sep">\u203A</span>';
    h += `<span class="db-bc-ancestor">${esc(a.title)}</span>`;
  });
  h += '<span class="db-bc-sep">\u203A</span>';
  h += `<span class="db-bc-current">${esc(current.title)}</span>`;
  h += '</div>';
  return h;
}

function sortByHierarchy(items, idFn) {
  if (!idFn) idFn = item => item.id;
  if (items.length <= 1) return items;
  const groups = new Map();
  items.forEach(item => {
    const bpId = idFn(item);
    const bp = state.byId[bpId];
    const rootId = bp ? getRootId(bp) : '_none';
    if (!groups.has(rootId)) groups.set(rootId, []);
    groups.get(rootId).push(item);
  });
  groups.forEach(grpItems => {
    const ids = grpItems.map(item => idFn(item));
    const sorted = topoSort(ids);
    const idxMap = {};
    sorted.forEach((id, i) => { idxMap[id] = i; });
    grpItems.sort((a, b) => (idxMap[idFn(a)] ?? 999) - (idxMap[idFn(b)] ?? 999));
  });
  const rootIds = [...groups.keys()].filter(k => k !== '_none');
  const sortedRootIds = topoSortRoots(rootIds);
  if (groups.has('_none')) sortedRootIds.push('_none');
  const result = [];
  sortedRootIds.forEach(id => {
    if (groups.has(id)) result.push(...groups.get(id));
  });
  return result;
}

function renderGroupDivider(bpId, prevBpId, totalCount) {
  if (totalCount <= 1) return '';
  const rootId = getRootId(bpId);
  if (prevBpId) {
    const prevRootId = getRootId(prevBpId);
    if (rootId === prevRootId) return '';
  }
  const chain = getAncestorChain(typeof bpId === 'object' ? bpId.id : bpId);
  const rootTitle = chain.length > 0 ? chain[0].title : 'Other';
  return `<div class="db-group-divider"><div class="db-group-label">${esc(rootTitle)}</div></div>`;
}

// ─── Dashboard State & Helpers ────────────────────────────────────────

const dashboardState2 = {
  openCrps: [],
  pendingReviews: [],
  pendingParentReviews: [],
  staleBPs: [],
  activeAgents: [],
  readyToDispatch: [],
  drafts: [],
  recentlyCompleted: [],
  lastRefresh: null,
  refreshTimer: null,
  // CRP UI state preserved across re-renders
  crpOpenCards: new Set(),   // card indices that are expanded
  crpActiveTabs: {},         // cardIndex -> active tab name
  crpInputValues: {},        // bp_id -> textarea content in progress
  // Review UI state preserved across re-renders
  reviewOpenCards: new Set(),
  reviewActiveTabs: {},
  reviewMrpCache: {},        // bp_id -> MRP body (loaded once)
  reviewMrpStructuredCache: {}, // bp_id -> structured MRP data
};

const sidebarState = {
  loopscriptPhases: null,
  selectedAgentBpId: null,
  telemetryCache: {},
  telemetryLoading: new Set(),
};

const queueState = {
  selectedType: null,   // 'crp', 'review', 'active', 'ready', 'recent'
  selectedId: null,     // id within that type (bp_id for crp, bp.id for others)
  selectedIdx: -1,      // index in the source array
  detailTab: null,      // active tab in detail panel
};

// ── SVG Ring Chart Helper ──

function svgRing(value, max, color) {
  const r = 18, cx = 24, cy = 24, circ = 2 * Math.PI * r;
  const pct = max > 0 ? Math.min(value / max, 1) : 0;
  const offset = circ * (1 - pct);
  return `<svg class="kpi-card-ring" viewBox="0 0 48 48">
    <circle class="kpi-ring-bg" cx="${cx}" cy="${cy}" r="${r}"/>
    <circle class="kpi-ring-fg" cx="${cx}" cy="${cy}" r="${r}" stroke="${color}"
      stroke-dasharray="${circ}" stroke-dashoffset="${offset}"
      transform="rotate(-90 ${cx} ${cy})"/>
    <text x="${cx}" y="${cy}" text-anchor="middle" dominant-baseline="central"
      fill="${color}" font-size="13" font-weight="700">${value}</text>
  </svg>`;
}

// ── KPI Strip ──

function renderKpiStrip() {
  const el = document.getElementById('kpi-strip');
  if (!el) return;

  const allBPs = state.showArchived
    ? state.briefings
    : state.briefings.filter(bp => !bp.archived);

  const leafBPs = allBPs.filter(bp => !bp.children || bp.children.length === 0);
  const statusCounts = { draft: 0, ready: 0, active: 0, completed: 0, reviewed: 0, stale: 0 };
  leafBPs.forEach(bp => {
    if (['dispatched','claimed','in-progress','in_progress'].includes(bp.status)) statusCounts.active++;
    else if (statusCounts[bp.status] !== undefined) statusCounts[bp.status]++;
  });

  const crpCount = dashboardState2.openCrps.length;
  const blockingCrps = dashboardState2.openCrps.filter(c => c.mode === 'blocking').length;
  const reviewCount = dashboardState2.pendingReviews.length + dashboardState2.pendingParentReviews.length;
  const agentCount = dashboardState2.activeAgents.length;
  const totalLeafs = leafBPs.length || 1;
  const doneCount = statusCounts.completed + statusCounts.reviewed;

  el.innerHTML = `
    <div class="kpi-card${crpCount > 0 ? ' kpi-alert' : ''}">
      ${svgRing(crpCount, Math.max(crpCount, 5), crpCount > 0 ? 'var(--status-ready)' : 'var(--text-muted)')}
      <div class="kpi-card-info">
        <div class="kpi-card-label">Open CRPs</div>
        <div class="kpi-card-value">${crpCount}</div>
        <div class="kpi-card-detail">${blockingCrps} blocking</div>
      </div>
    </div>
    <div class="kpi-card">
      ${svgRing(doneCount, totalLeafs, 'var(--status-completed)')}
      <div class="kpi-card-info">
        <div class="kpi-card-label">Pipeline</div>
        <div class="kpi-card-value">${doneCount}/${leafBPs.length}</div>
        <div class="kpi-card-detail">${statusCounts.draft}d &middot; ${statusCounts.ready}r &middot; ${statusCounts.active}a &middot; ${statusCounts.completed}c${statusCounts.stale > 0 ? ` &middot; <span style="color:var(--status-stale)">${statusCounts.stale}s</span>` : ''}</div>
      </div>
    </div>
    <div class="kpi-card${agentCount > 0 ? ' kpi-active' : ''}">
      ${svgRing(agentCount, Math.max(agentCount, 3), agentCount > 0 ? 'var(--status-dispatched)' : 'var(--text-muted)')}
      <div class="kpi-card-info">
        <div class="kpi-card-label">Active Agents</div>
        <div class="kpi-card-value">${agentCount}</div>
        <div class="kpi-card-detail">${dashboardState2.readyToDispatch.length} ready</div>
      </div>
    </div>
    <div class="kpi-card${reviewCount > 0 ? ' kpi-review' : ''}">
      ${svgRing(reviewCount, Math.max(reviewCount, 5), reviewCount > 0 ? 'var(--accent)' : 'var(--text-muted)')}
      <div class="kpi-card-info">
        <div class="kpi-card-label">Reviews</div>
        <div class="kpi-card-value">${reviewCount}</div>
        <div class="kpi-card-detail">${dashboardState2.pendingParentReviews.length} final</div>
      </div>
    </div>
  `;
}

// ── Operations Queue (Left Panel) ──

function buildQueueItems() {
  const items = [];
  // CRPs (highest priority)
  dashboardState2.openCrps.forEach((crp, idx) => {
    const bp = state.byId[crp.bp_id] || {};
    items.push({
      type: 'crp', id: crp.bp_id, idx, data: crp,
      title: bp.title || bp.slug || crp.bpTitle || crp.bp_id,
      badge: crp.mode === 'blocking' ? 'blocking' : 'deferred',
      badgeLabel: crp.mode || 'crp',
      meta: crp.category || '',
      time: crp.created ? timeAgo(crp.created) : '',
    });
  });
  // Pending reviews
  [...dashboardState2.pendingReviews, ...dashboardState2.pendingParentReviews].forEach((bp, idx) => {
    items.push({
      type: 'review', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: 'review',
      badgeLabel: 'review',
      meta: bp.agent_id ? `agt:${bp.agent_id}` : '',
      time: bp.completed ? timeAgo(bp.completed) : '',
    });
  });
  // Stale (needs revalidation)
  dashboardState2.staleBPs.forEach((bp, idx) => {
    items.push({
      type: 'stale', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: 'stale',
      badgeLabel: 'stale',
      meta: bp.prior_status ? `was: ${bp.prior_status}` : '',
      time: bp.staled ? timeAgo(bp.staled) : '',
    });
  });
  // Active agents
  dashboardState2.activeAgents.forEach((bp, idx) => {
    items.push({
      type: 'active', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: 'active',
      badgeLabel: bp.phase || bp.status,
      meta: bp.agent_id ? `agt:${bp.agent_id}` : '',
      time: runtimeSince(bp.claimed || bp.last_heartbeat),
    });
  });
  // Ready to dispatch
  dashboardState2.readyToDispatch.forEach((bp, idx) => {
    items.push({
      type: 'ready', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: 'ready',
      badgeLabel: 'ready',
      meta: '',
      time: '',
    });
  });
  // Drafts awaiting approval
  (dashboardState2.drafts || []).forEach((bp, idx) => {
    items.push({
      type: 'draft', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: 'draft',
      badgeLabel: 'draft',
      meta: '',
      time: bp.created ? timeAgo(bp.created) : '',
    });
  });
  // Recent
  dashboardState2.recentlyCompleted.forEach((bp, idx) => {
    items.push({
      type: 'recent', id: bp.id, idx, data: bp,
      title: bp.title || bp.slug || bp.id,
      badge: '',
      badgeLabel: bp.status,
      meta: '',
      time: bp.completed ? timeAgo(bp.completed) : '',
    });
  });
  return items;
}

function selectQueueItem(type, id, idx) {
  queueState.selectedType = type;
  queueState.selectedId = id;
  queueState.selectedIdx = idx;
  queueState.detailTab = null; // reset to default tab
  closePreview();
  renderQueue();
  renderDetailPanel();
}

function renderQueue() {
  const el = document.getElementById('overview-queue');
  if (!el) return;

  const items = buildQueueItems();
  const totalCount = items.length;

  // Auto-select first item if nothing selected
  if (!queueState.selectedType && items.length > 0) {
    queueState.selectedType = items[0].type;
    queueState.selectedId = items[0].id;
    queueState.selectedIdx = items[0].idx;
  }

  let html = `<div class="queue-header">
    <span class="queue-header-title">Operations Queue</span>
    <span class="queue-header-count">${totalCount}</span>
  </div>`;
  html += `<div class="queue-scroll">`;

  // Group items by type
  const groups = [
    { key: 'crp', label: 'Action Required', items: items.filter(i => i.type === 'crp') },
    { key: 'review', label: 'Pending Review', items: items.filter(i => i.type === 'review') },
    { key: 'stale', label: 'Needs Revalidation', items: items.filter(i => i.type === 'stale') },
    { key: 'active', label: 'Active Missions', items: items.filter(i => i.type === 'active') },
    { key: 'ready', label: 'Ready to Dispatch', items: items.filter(i => i.type === 'ready') },
    { key: 'draft', label: 'Drafts', items: items.filter(i => i.type === 'draft') },
    { key: 'recent', label: 'Recent Activity', items: items.filter(i => i.type === 'recent') },
  ];

  groups.forEach(group => {
    if (group.items.length === 0) return;
    html += `<div class="queue-group-label">${group.label} <span class="db-count">${group.items.length}</span></div>`;
    group.items.forEach(item => {
      const selected = queueState.selectedType === item.type && queueState.selectedId === item.id;
      html += `<div class="queue-item type-${item.type}${selected ? ' selected' : ''}"
        onclick="selectQueueItem('${item.type}','${esc(item.id)}',${item.idx})">`;

      if (item.type === 'active') {
        html += `<span class="queue-item-pulse"></span>`;
      }

      html += `<div class="queue-item-body">
        <div class="queue-item-title" title="${esc(item.title)}">${esc(item.title)}</div>
        <div class="queue-item-meta">`;

      if (item.badge) {
        html += `<span class="queue-item-badge queue-badge-${item.badge}">${esc(item.badgeLabel)}</span>`;
      }
      // Revision badge
      if (item.data && item.data.revision && parseInt(item.data.revision) > 1) {
        html += `<span class="queue-item-badge queue-badge-revision" title="This BP has been revised">Rev\u00a0${esc(String(item.data.revision))}</span>`;
      }
      // Chat session indicator
      const bpChatSessions = getBpChatSessions(item.id);
      if (bpChatSessions.length > 0) {
        const hasStreaming = bpChatSessions.some(s => s.isStreaming);
        const dotStyle = hasStreaming ? 'background:var(--accent);animation:pulse 1.5s infinite' : 'background:var(--status-completed)';
        html += `<span class="queue-item-badge" style="background:transparent;border:1px solid var(--border);padding:2px 6px;font-size:10px;display:inline-flex;align-items:center;gap:3px" title="${bpChatSessions.length} chat session${bpChatSessions.length>1?'s':''}">
          <span style="width:5px;height:5px;border-radius:50%;${dotStyle};display:inline-block"></span>Chat</span>`;
      }
      if (item.meta) html += `<span>${esc(item.meta)}</span>`;
      if (item.time) html += `<span>${esc(item.time)}</span>`;

      html += `</div></div>`;

      if (item.type === 'recent') {
        html += `<span class="queue-item-status" style="color:var(--status-${(item.data.status||'').replace('-','_')})">${esc(item.data.status || '')}</span>`;
      }

      html += `</div>`;
    });
  });

  html += `</div>`;

  // Footer
  const refreshAgo = dashboardState2.lastRefresh ? timeAgo(dashboardState2.lastRefresh.toISOString()) : 'just now';
  html += `<div class="queue-footer">
    <span>${esc(refreshAgo)}</span>
    <button onclick="(async()=>{await fetchBriefings();await buildDashboardData();if(queueState.selectedId){const t=queueState.detailTab;reselectAfterTransition(queueState.selectedId);queueState.detailTab=t;}renderOverview();})()" title="Refresh">&#x21bb; Refresh</button>
  </div>`;

  el.innerHTML = html;
}

// ── Detail Panel (Center) ──

function switchDetailTab(tabName) {
  queueState.detailTab = tabName;
  const container = document.getElementById('overview-main');
  if (!container) return;
  container.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  container.querySelectorAll('.detail-tab-content').forEach(c => c.classList.toggle('active', c.dataset.tab === tabName));
  // Lazy-load log tab
  if (tabName === 'log') {
    const logEl = container.querySelector('.detail-tab-content[data-tab="log"]');
    if (logEl && logEl.dataset.loaded !== 'true') {
      const bpId = logEl.dataset.bpid;
      if (bpId) loadAgentLog(bpId, logEl);
    }
  }
  // Lazy-load MRP tab
  if (tabName === 'mrp') {
    const mrpEl = container.querySelector('.detail-tab-content[data-tab="mrp"]');
    if (mrpEl && mrpEl.dataset.loaded !== 'true') {
      const bpId = mrpEl.dataset.bpid;
      if (bpId) loadMrpContent(bpId, mrpEl);
    }
  }
  // Lazy-load Artifacts tab
  if (tabName === 'artifacts') {
    const artEl = container.querySelector('.detail-tab-content[data-tab="artifacts"]');
    if (artEl && artEl.dataset.loaded !== 'true') {
      const bpId = artEl.dataset.bpid;
      if (bpId) loadArtifactsTab(bpId, artEl);
    }
  }
  // Lazy-init embedded Chat tab
  const overviewDetail = container.closest('.overview-detail') || container;
  if (tabName === 'chat') {
    const chatEl = container.querySelector('.detail-tab-content[data-tab="chat"]');
    if (chatEl && chatEl.dataset.loaded !== 'true') {
      const bpId = chatEl.dataset.bpid;
      if (bpId) {
        chatEl.innerHTML = renderEmbeddedChatTab(bpId);
        chatEl.dataset.loaded = 'true';
        initEmbeddedChat(bpId);
      }
    }
    overviewDetail.classList.add('chat-tab-active');
  } else {
    overviewDetail.classList.remove('chat-tab-active');
  }
}

function renderDetailPanel() {
  const container = document.getElementById('overview-main');
  if (!container) return;

  if (!queueState.selectedType || !queueState.selectedId) {
    container.innerHTML = `<div class="detail-empty">
      <div class="detail-empty-icon">&#x2B21;</div>
      <h3>Agent Command Environment</h3>
      <p>Select an item from the operations queue to view details, resolve CRPs, review MRPs, or dispatch missions.</p>
    </div>`;
    return;
  }

  const { selectedType, selectedId, selectedIdx } = queueState;
  let html = '';

  if (selectedType === 'crp') {
    html = renderCrpDetail(selectedId, selectedIdx);
  } else if (selectedType === 'review') {
    html = renderReviewDetail(selectedId);
  } else if (selectedType === 'active') {
    html = renderActiveDetail(selectedId);
  } else if (selectedType === 'ready') {
    html = renderReadyDetail(selectedId);
  } else if (selectedType === 'draft') {
    html = renderDraftDetail(selectedId);
  } else if (selectedType === 'recent') {
    html = renderRecentDetail(selectedId);
  }

  container.innerHTML = html;

  // Post-render: load default tab content
  const defaultTab = queueState.detailTab;
  if (defaultTab) switchDetailTab(defaultTab);

  // Auto-load MRP for review and recent types
  if (selectedType === 'review' || selectedType === 'recent') {
    const mrpEl = container.querySelector('.detail-tab-content[data-tab="mrp"]');
    if (mrpEl && mrpEl.dataset.loaded !== 'true') {
      loadMrpContent(mrpEl.dataset.bpid, mrpEl);
    }
  }
}

function renderCrpDetail(bpId, idx) {
  const crp = dashboardState2.openCrps.find(c => c.bp_id === bpId);
  if (!crp) return '<div class="detail-empty"><p>CRP not found</p></div>';
  const bp = state.byId[crp.bp_id] || {};
  const savedInput = dashboardState2.crpInputValues[bpId] || '';
  const hasArtifacts = bp.artifacts && bp.artifacts.some(a => a.direction === 'output');

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug || crp.bpTitle)}</h2>
    </div>
    <div class="detail-header-badges">
      <span class="detail-type-badge detail-type-crp">Consultation Request</span>`;

  const modeColor = crp.mode === 'blocking' ? '#ef4444' : '#3b82f6';
  if (crp.mode) html += `<span class="queue-item-badge" style="background:${modeColor}22;color:${modeColor}">${esc(crp.mode)}</span>`;
  if (crp.trigger) html += `<span class="queue-item-badge" style="background:var(--bg);color:var(--text-muted);border:1px solid var(--border)">${esc(crp.trigger)}</span>`;
  if (crp.category) html += `<span class="queue-item-badge queue-badge-deferred">${esc(crp.category)}</span>`;
  if (crp.raised_by) html += `<span class="db-agent-badge">agt:${esc(crp.raised_by)}</span>`;

  html += `</div></div>`;

  // Mission phases for the BP associated with this CRP
  const crpPhasesHtml = renderInlineMissionPhases(bp);
  if (crpPhasesHtml) {
    html += `<div class="detail-mission-phases"><div class="detail-mission-phases-header">Mission Phases</div>${crpPhasesHtml}</div>`;
  }

  // Tabs
  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || 'details';
  html += `<div class="detail-tabs">
    <div class="detail-tab${activeTab==='details'?' active':''}" data-tab="details" onclick="switchDetailTab('details')">Details</div>
    <div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>`;
  if (hasArtifacts) html += `<div class="detail-tab${activeTab==='artifacts'?' active':''}" data-tab="artifacts" onclick="switchDetailTab('artifacts')">Artifacts</div>`;
  html += `<div class="detail-tab${activeTab==='log'?' active':''}" data-tab="log" onclick="switchDetailTab('log')">Agent Log</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>
  </div>`;

  // Tab: Details
  html += `<div class="detail-tab-content${activeTab==='details'?' active':''}" data-tab="details">`;
  html += `<div class="crp-meta-grid">`;
  html += `<span class="crp-meta-label">CRP ID</span><span class="crp-meta-value"><code>${esc(crp.crp_id)}</code></span>`;
  html += `<span class="crp-meta-label">BP</span><span class="crp-meta-value"><code>${esc(crp.bp_id)}</code></span>`;
  if (crp.mode) html += `<span class="crp-meta-label">Mode</span><span class="crp-meta-value">${esc(crp.mode)}</span>`;
  if (crp.trigger) html += `<span class="crp-meta-label">Trigger</span><span class="crp-meta-value">${esc(crp.trigger)}</span>`;
  if (crp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(crp.phase)}</span>`;
  if (crp.routed_to) html += `<span class="crp-meta-label">Routed to</span><span class="crp-meta-value">${esc(crp.routed_to)}</span>`;
  if (crp.raised_by) html += `<span class="crp-meta-label">Raised by</span><span class="crp-meta-value"><code>agt:${esc(crp.raised_by)}</code></span>`;
  if (crp.created) html += `<span class="crp-meta-label">Created</span><span class="crp-meta-value">${esc(crp.created)}</span>`;
  html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
  html += crp.body ? renderMarkdown(crp.body) : '<p style="color:var(--text-muted)">No body content.</p>';
  html += `</div>`;

  // Tab: Briefing Pack
  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp && bp.body) {
    html += `<div class="crp-meta-grid">`;
    html += `<span class="crp-meta-label">Title</span><span class="crp-meta-value">${esc(bp.title || bp.slug)}</span>`;
    html += `<span class="crp-meta-label">Status</span><span class="crp-meta-value"><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></span>`;
    if (bp.agent_id) html += `<span class="crp-meta-label">Agent</span><span class="crp-meta-value"><code>agt:${esc(bp.agent_id)}</code></span>`;
    if (bp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(bp.phase)}</span>`;
    html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
  }
  html += `</div>`;

  // Tab: Artifacts
  if (hasArtifacts) {
    html += `<div class="detail-tab-content${activeTab==='artifacts'?' active':''}" data-tab="artifacts" data-bpid="${esc(bpId)}">`;
    html += `<div class="agent-log-empty">Loading artifacts...</div>`;
    html += `</div>`;
  }

  // Tab: Agent Log
  html += `<div class="detail-tab-content${activeTab==='log'?' active':''}" data-tab="log" data-bpid="${esc(bpId)}">`;
  html += `<div class="agent-log-empty">Loading agent activity...</div>`;
  html += `</div>`;

  // Tab: Chat
  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;

  // Resolve bar
  html += `<div class="detail-actions">
    <textarea id="crp-input-${esc(bpId)}" placeholder="Enter your resolution response..." rows="2"
      style="flex:1;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:12px;color:var(--text);font-family:inherit;resize:none;outline:none"
      onkeydown="if(event.key==='Enter'&&event.metaKey)resolveCrpAgent('${esc(bpId)}',event)">${esc(savedInput)}</textarea>
    <button class="agent-action-btn resolve-crp-btn" onclick="resolveCrpAgent('${esc(bpId)}', event)"${!agentState.available ? ' disabled' : ''}>Resolve CRP</button>
  </div>`;

  return html;
}

function renderReviewDetail(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '<div class="detail-empty"><p>BP not found</p></div>';
  const parent = bp.parent ? state.byId[bp.parent] : null;
  const isParent = bp.children && bp.children.length > 0;
  const hasArtifacts = bp.artifacts && bp.artifacts.some(a => a.direction === 'output');

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug)}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')"
          title="Edit the agent definition and commit the changes to git.">Edit BP</button>
        <button class="agent-action-btn review-mrp-btn" onclick="reviewMrpAgent('${esc(bpId)}', event)"${!agentState.available ? ' disabled' : ''}
          title="Starts an AI-assisted review of the Mission Review Protocol. The agent reads the MRP, checks the acceptance criteria, and helps you assess whether the work meets the required quality standard.">Review MRP</button>
        ${renderTransitionButtons(bpId)}
      </div>
    </div>
    <div class="detail-header-badges">
      <span class="detail-type-badge detail-type-review">${isParent ? 'Final Review' : 'MRP Review'}</span>`;
  if (bp.agent_id) html += `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>`;
  if (bp.revision && parseInt(bp.revision) > 1) html += `<span class="queue-item-badge queue-badge-revision" title="Revised BP">Rev\u00a0${esc(String(bp.revision))}</span>`;
  if (bp.completed) html += `<span style="font-size:11px;color:var(--text-muted)">Completed ${esc(timeAgo(bp.completed))}</span>`;
  html += `</div></div>`;
  html += renderBpEditorBlock(bpId);

  // Mission phases (completed state)
  const reviewPhasesHtml = renderInlineMissionPhases(bp);
  if (reviewPhasesHtml) {
    html += `<div class="detail-mission-phases"><div class="detail-mission-phases-header">Mission Phases</div>${reviewPhasesHtml}</div>`;
  }

  const hasRevisions = bp.revision_log && Array.isArray(bp.revision_log) && bp.revision_log.length > 0;
  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || 'mrp';
  html += `<div class="detail-tabs">
    <div class="detail-tab${activeTab==='mrp'?' active':''}" data-tab="mrp" onclick="switchDetailTab('mrp')">MRP Report</div>
    <div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>`;
  if (hasArtifacts) html += `<div class="detail-tab${activeTab==='artifacts'?' active':''}" data-tab="artifacts" onclick="switchDetailTab('artifacts')">Artifacts</div>`;
  html += `<div class="detail-tab${activeTab==='log'?' active':''}" data-tab="log" onclick="switchDetailTab('log')">Agent Log</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>`;
  if (hasRevisions) html += `<div class="detail-tab${activeTab==='history'?' active':''}" data-tab="history" onclick="switchDetailTab('history')">History</div>`;
  html += `</div>`;

  // MRP
  html += `<div class="detail-tab-content${activeTab==='mrp'?' active':''}" data-tab="mrp" data-bpid="${esc(bpId)}">`;
  html += `<div class="agent-log-empty">Loading MRP...</div>`;
  html += `</div>`;

  // Briefing
  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp.body) {
    html += `<div class="crp-meta-grid">`;
    html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
    html += `<span class="crp-meta-label">Status</span><span class="crp-meta-value"><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></span>`;
    if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
    if (bp.agent_id) html += `<span class="crp-meta-label">Agent</span><span class="crp-meta-value"><code>agt:${esc(bp.agent_id)}</code></span>`;
    if (bp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(bp.phase)}</span>`;
    if (parent) html += `<span class="crp-meta-label">Parent</span><span class="crp-meta-value">${esc(parent.title || parent.slug)}</span>`;
    html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
  }
  html += `</div>`;

  // Artifacts
  if (hasArtifacts) {
    html += `<div class="detail-tab-content${activeTab==='artifacts'?' active':''}" data-tab="artifacts" data-bpid="${esc(bpId)}">`;
    html += `<div class="agent-log-empty">Loading artifacts...</div>`;
    html += `</div>`;
  }

  // Log
  html += `<div class="detail-tab-content${activeTab==='log'?' active':''}" data-tab="log" data-bpid="${esc(bpId)}">`;
  html += `<div class="agent-log-empty">Loading agent activity...</div>`;
  html += `</div>`;

  // Chat
  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;

  // History (revision log)
  if (hasRevisions) {
    html += `<div class="detail-tab-content${activeTab==='history'?' active':''}" data-tab="history">`;
    html += renderRevisionHistory(bp);
    html += `</div>`;
  }

  return html;
}

function renderActiveDetail(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '<div class="detail-empty"><p>BP not found</p></div>';
  const runtime = runtimeSince(bp.claimed || bp.last_heartbeat);

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug)}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')"
          title="Edit the agent definition and commit the changes to git.">Edit BP</button>
        <button class="btn btn-outline btn-sm" onclick="overviewNavigateToBP('${esc(bpId)}')"
          title="Switch to the Process view to see this agent in context of its full mission tree.">View in Process</button>
        ${renderTransitionButtons(bpId)}
      </div>
    </div>
    <div class="detail-header-badges">
      <span class="detail-type-badge detail-type-active">Active Mission</span>
      <span class="dash-status-badge ${(bp.status||'').replace('-','_')}">${esc(bp.status)}</span>`;
  if (bp.agent_id) html += `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>`;
  if (bp.phase) html += `<span class="queue-item-badge queue-badge-active">${esc(bp.phase)}</span>`;
  if (bp.revision && parseInt(bp.revision) > 1) html += `<span class="queue-item-badge queue-badge-revision" title="Revised BP">Rev\u00a0${esc(String(bp.revision))}</span>`;
  if (runtime) html += `<span style="font-size:11px;color:var(--text-muted)">${esc(runtime)}</span>`;
  html += `</div></div>`;
  html += renderBpEditorBlock(bpId);

  // Mission phases
  const missionPhasesHtml = renderInlineMissionPhases(bp);
  if (missionPhasesHtml) {
    html += `<div class="detail-mission-phases"><div class="detail-mission-phases-header">Mission Phases</div>${missionPhasesHtml}</div>`;
  }

  const hasArtifacts = bp.artifacts && bp.artifacts.some(a => a.direction === 'output');
  const hasRevisions = bp.revision_log && Array.isArray(bp.revision_log) && bp.revision_log.length > 0;
  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || 'briefing';
  html += `<div class="detail-tabs">
    <div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>`;
  if (hasArtifacts) html += `<div class="detail-tab${activeTab==='artifacts'?' active':''}" data-tab="artifacts" onclick="switchDetailTab('artifacts')">Artifacts</div>`;
  html += `<div class="detail-tab${activeTab==='log'?' active':''}" data-tab="log" onclick="switchDetailTab('log')">Agent Log</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>`;
  if (hasRevisions) html += `<div class="detail-tab${activeTab==='history'?' active':''}" data-tab="history" onclick="switchDetailTab('history')">History</div>`;
  html += `</div>`;

  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp.body) {
    html += `<div class="crp-meta-grid">`;
    html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
    html += `<span class="crp-meta-label">Claimed</span><span class="crp-meta-value">${esc(timeAgo(bp.claimed))}</span>`;
    if (bp.last_heartbeat) html += `<span class="crp-meta-label">Heartbeat</span><span class="crp-meta-value">${esc(timeAgo(bp.last_heartbeat))}</span>`;
    if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
    html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
  }
  html += `</div>`;

  if (hasArtifacts) {
    html += `<div class="detail-tab-content${activeTab==='artifacts'?' active':''}" data-tab="artifacts" data-bpid="${esc(bpId)}">`;
    html += `<div class="agent-log-empty">Loading artifacts...</div>`;
    html += `</div>`;
  }

  html += `<div class="detail-tab-content${activeTab==='log'?' active':''}" data-tab="log" data-bpid="${esc(bpId)}">`;
  html += `<div class="agent-log-empty">Loading agent activity...</div>`;
  html += `</div>`;

  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;

  if (hasRevisions) {
    html += `<div class="detail-tab-content${activeTab==='history'?' active':''}" data-tab="history">`;
    html += renderRevisionHistory(bp);
    html += `</div>`;
  }

  return html;
}

function renderReadyDetail(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '<div class="detail-empty"><p>BP not found</p></div>';

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug)}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')"
          title="Edit the agent definition and commit the changes to git.">Edit BP</button>
        <button class="agent-action-btn dispatch-btn" onclick="dispatchBP('${esc(bpId)}', event)"${!agentState.available ? ' disabled' : ''}
          title="Starts an AI agent to execute this agent autonomously. The agent creates an isolated git branch, claims the task, and works through all LoopScript phases step by step. You can track progress in the Active Missions section.">Handover task to an agent</button>
        ${renderTransitionButtons(bpId)}
      </div>
    </div>
    <div class="detail-header-badges">
      <span class="detail-type-badge detail-type-ready">Ready to Dispatch</span>`;
  if (bp.rigor) html += `<span class="queue-item-badge queue-badge-ready">${esc(bp.rigor)}</span>`;
  if (bp.revision && parseInt(bp.revision) > 1) html += `<span class="queue-item-badge queue-badge-revision" title="Revised BP">Rev\u00a0${esc(String(bp.revision))}</span>`;
  html += `</div></div>`;
  html += renderBpEditorBlock(bpId);

  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || 'briefing';
  html += `<div class="detail-tabs">
    <div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>
  </div>`;

  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp.body) {
    html += `<div class="crp-meta-grid">`;
    html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
    if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
    if (bp.loopscript) html += `<span class="crp-meta-label">LoopScript</span><span class="crp-meta-value">${esc(bp.loopscript)}</span>`;
    html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
  }
  html += `</div>`;

  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;

  return html;
}

function renderDraftDetail(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '<div class="detail-empty"><p>BP not found</p></div>';

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug)}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')"
          title="Edit the agent definition and commit the changes to git.">Edit BP</button>
        ${renderTransitionButtons(bpId)}
      </div>
    </div>
    <div class="detail-header-badges">
      <span class="detail-type-badge" style="background:rgba(148,163,184,0.15);color:var(--text-muted)">Draft</span>`;
  if (bp.rigor) html += `<span class="queue-item-badge">${esc(bp.rigor)}</span>`;
  if (bp.revision && parseInt(bp.revision) > 1) html += `<span class="queue-item-badge queue-badge-revision" title="Revised BP">Rev\u00a0${esc(String(bp.revision))}</span>`;
  if (bp.created) html += `<span style="font-size:11px;color:var(--text-muted)">Created ${esc(timeAgo(bp.created))}</span>`;
  html += `</div></div>`;
  html += renderBpEditorBlock(bpId);

  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || 'briefing';
  html += `<div class="detail-tabs">
    <div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>
  </div>`;

  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp.body) {
    html += `<div class="crp-meta-grid">`;
    html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
    if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
    if (bp.loopscript) html += `<span class="crp-meta-label">LoopScript</span><span class="crp-meta-value">${esc(bp.loopscript)}</span>`;
    html += `</div><hr style="border-color:var(--border);margin:12px 0">`;
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
  }
  html += `</div>`;

  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;

  return html;
}

function renderRecentDetail(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '<div class="detail-empty"><p>BP not found</p></div>';
  const hasArtifacts = bp.artifacts && bp.artifacts.some(a => a.direction === 'output');

  let html = `<div class="detail-header">
    <div class="detail-header-top">
      <h2>${esc(bp.title || bp.slug)}</h2>
      <div style="display:flex;gap:6px;align-items:center;flex-shrink:0">
        <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')"
          title="Edit the agent definition and commit the changes to git.">Edit BP</button>
        <button class="btn btn-outline btn-sm" onclick="overviewNavigateToBP('${esc(bpId)}')"
          title="Switch to the Process view to see this agent in context of its full mission tree.">View in Process</button>
        ${renderTransitionButtons(bpId)}
      </div>
    </div>
    <div class="detail-header-badges">
      <span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span>`;
  if (bp.agent_id) html += `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>`;
  if (bp.completed) html += `<span style="font-size:11px;color:var(--text-muted)">${esc(timeAgo(bp.completed))}</span>`;
  html += `</div></div>`;
  html += renderBpEditorBlock(bpId);

  // Mission phases
  const recentPhasesHtml = renderInlineMissionPhases(bp);
  if (recentPhasesHtml) {
    html += `<div class="detail-mission-phases"><div class="detail-mission-phases-header">Mission Phases</div>${recentPhasesHtml}</div>`;
  }

  const hasMrp = bp.status === 'completed' || bp.status === 'reviewed';
  const bpChatCount = getBpChatSessions(bpId).length;
  const activeTab = queueState.detailTab || (hasMrp ? 'mrp' : 'briefing');
  html += `<div class="detail-tabs">`;
  if (hasMrp) html += `<div class="detail-tab${activeTab==='mrp'?' active':''}" data-tab="mrp" onclick="switchDetailTab('mrp')">MRP Report</div>`;
  html += `<div class="detail-tab${activeTab==='briefing'?' active':''}" data-tab="briefing" onclick="switchDetailTab('briefing')">Agent Brief</div>`;
  if (hasArtifacts) html += `<div class="detail-tab${activeTab==='artifacts'?' active':''}" data-tab="artifacts" onclick="switchDetailTab('artifacts')">Artifacts</div>`;
  html += `<div class="detail-tab${activeTab==='log'?' active':''}" data-tab="log" onclick="switchDetailTab('log')">Agent Log</div>
    <div class="detail-tab${activeTab==='chat'?' active':''}" data-tab="chat" onclick="switchDetailTab('chat')">Chat${bpChatCount ? ' (' + bpChatCount + ')' : ''}</div>
  </div>`;

  // MRP tab for completed/reviewed BPs
  if (hasMrp) {
    html += `<div class="detail-tab-content${activeTab==='mrp'?' active':''}" data-tab="mrp" data-bpid="${esc(bpId)}">`;
    html += `<div class="agent-log-empty">Loading MRP...</div>`;
    html += `</div>`;
  }

  html += `<div class="detail-tab-content${activeTab==='briefing'?' active':''}" data-tab="briefing">`;
  if (bp.body) {
    html += linkifyArtifacts(renderMarkdown(bp.body), bp);
  } else {
    html += `<p style="color:var(--text-muted)">No content.</p>`;
  }
  html += `</div>`;

  if (hasArtifacts) {
    html += `<div class="detail-tab-content${activeTab==='artifacts'?' active':''}" data-tab="artifacts" data-bpid="${esc(bpId)}">`;
    html += `<div class="agent-log-empty">Loading artifacts...</div>`;
    html += `</div>`;
  }

  html += `<div class="detail-tab-content${activeTab==='log'?' active':''}" data-tab="log" data-bpid="${esc(bpId)}">`;
  html += `<div class="agent-log-empty">Loading agent activity...</div>`;
  html += `</div>`;

  html += `<div class="detail-tab-content${activeTab==='chat'?' active':''}" data-tab="chat" data-bpid="${esc(bpId)}">`;
  html += `<div class="embedded-chat-empty"><div style="font-size:28px;opacity:0.3">&#x2B21;</div><p>Loading chat...</p></div>`;
  html += `</div>`;


  return html;
}

// ── Agent Sidebar (Right Panel) — existing functions ──

async function loadLoopscriptPhases() {
  if (sidebarState.loopscriptPhases) return;
  try {
    const resp = await fetch('/api/loopscript-phases');
    if (resp.ok) sidebarState.loopscriptPhases = await resp.json();
  } catch {}
}

async function loadTelemetryForActiveAgents() {
  const promises = dashboardState2.activeAgents.map(async (bp) => {
    if (sidebarState.telemetryLoading.has(bp.id)) return;
    sidebarState.telemetryLoading.add(bp.id);
    try {
      const resp = await fetch('/api/agent-telemetry/' + bp.id);
      if (resp.ok) sidebarState.telemetryCache[bp.id] = await resp.json();
    } catch {} finally {
      sidebarState.telemetryLoading.delete(bp.id);
    }
  });
  await Promise.all(promises);
}

function selectSidebarAgent(bpId) {
  sidebarState.selectedAgentBpId = bpId;
  renderSidebar();
}

function renderSidebar() {
  const el = document.getElementById('overview-sidebar');
  if (!el) return;

  const agents = dashboardState2.activeAgents;
  if (agents.length === 0) { el.innerHTML = ''; return; }

  if (!sidebarState.selectedAgentBpId || !agents.find(a => a.id === sidebarState.selectedAgentBpId)) {
    sidebarState.selectedAgentBpId = agents[0].id;
  }

  let html = '';

  html += `<div class="sidebar-section">`;
  html += `<div class="sidebar-section-header">Agent Pool <span class="db-count">${agents.length}</span></div>`;
  agents.forEach(bp => {
    const runtime = runtimeSince(bp.claimed || bp.last_heartbeat);
    const selected = bp.id === sidebarState.selectedAgentBpId;
    const phaseProgress = getPhaseProgress(bp);
    html += `<div class="sidebar-agent-card${selected ? ' selected' : ''}" onclick="selectSidebarAgent('${esc(bp.id)}')">
      <div class="sidebar-agent-name">agt:${esc(bp.agent_id || '\u2014')}</div>
      <div class="sidebar-agent-bp">${esc(bp.title || bp.slug || bp.id)}</div>
      <div class="sidebar-agent-meta">
        <span class="dash-status-badge ${(bp.status || '').replace('-','_')}" style="font-size:9px;padding:1px 6px">${esc(bp.status)}</span>
        ${bp.phase ? `<span>${esc(bp.phase)}</span>` : ''}
        ${runtime ? `<span>${esc(runtime)}</span>` : ''}
      </div>
      <div class="sidebar-agent-progress"><div class="sidebar-agent-progress-fill" style="width:${phaseProgress}%"></div></div>
    </div>`;
  });
  html += `</div>`;

  const selectedBp = agents.find(a => a.id === sidebarState.selectedAgentBpId);
  if (selectedBp) html += renderMissionPhases(selectedBp);
  html += renderTelemetryFeed(agents);

  el.innerHTML = html;
}

function getPhaseProgress(bp) {
  if (!sidebarState.loopscriptPhases) return 0;
  const phases = sidebarState.loopscriptPhases[resolveLoopscriptKey(bp)];
  if (!phases) return 0;
  const bpPhase = (bp.phase || '').toLowerCase();
  let idx = bpPhase ? phases.findIndex(p => p.id.toLowerCase() === bpPhase) : -1;
  // Default to first phase for active BPs with no phase reported yet
  if (idx < 0 && ['dispatched', 'claimed', 'in-progress', 'in_progress'].includes(bp.status)) {
    idx = 0;
  }
  return idx === -1 ? 0 : Math.round(((idx + 0.5) / phases.length) * 100);
}

function resolveLoopscriptKey(bp) {
  const ls = bp.loopscript || '';
  if (sidebarState.loopscriptPhases && sidebarState.loopscriptPhases[ls]) return ls;
  const rigor = (bp.rigor || '').toLowerCase();
  if (rigor === 'high' || rigor === 'high-rigor') return 'high-rigor';
  return 'standard';
}

function renderMissionPhases(bp) {
  if (!sidebarState.loopscriptPhases) {
    return `<div class="sidebar-section"><div class="sidebar-section-header">Mission Phases</div><div class="sidebar-empty">Loading...</div></div>`;
  }
  const phases = sidebarState.loopscriptPhases[resolveLoopscriptKey(bp)];
  if (!phases || phases.length === 0) {
    return `<div class="sidebar-section"><div class="sidebar-section-header">Mission Phases</div><div class="sidebar-empty">No phase data</div></div>`;
  }
  // Match phase id (case-insensitive for robustness)
  const bpPhase = (bp.phase || '').toLowerCase();
  let currentIdx = phases.findIndex(p => p.id.toLowerCase() === bpPhase);
  // Default to first phase for active BPs that haven't reported a phase yet
  if (currentIdx < 0 && ['dispatched', 'claimed', 'in-progress', 'in_progress'].includes(bp.status)) {
    currentIdx = 0;
  }
  const pct = currentIdx >= 0 ? Math.round(((currentIdx + 0.5) / phases.length) * 100) : 0;

  let html = `<div class="sidebar-section">`;
  html += `<div class="sidebar-section-header">Mission Phases <span style="margin-left:auto;color:var(--status-dispatched);font-size:11px;font-weight:700">${pct}%</span></div>`;
  html += `<div class="sidebar-phase-progress"><div class="sidebar-phase-progress-fill" style="width:${pct}%"></div></div>`;
  html += `<div class="sidebar-phase-list">`;
  phases.forEach((phase, idx) => {
    const cls = (currentIdx >= 0 && idx < currentIdx) ? 'completed' : idx === currentIdx ? 'active' : 'pending';
    const iconCls = cls === 'completed' ? 'phase-completed' : cls === 'active' ? 'phase-active' : 'phase-pending';
    const icon = cls === 'completed' ? '&#x2713;' : cls === 'active' ? '&#x25B6;' : '';
    html += `<div class="sidebar-phase-item ${cls}"><span class="sidebar-phase-icon ${iconCls}">${icon}</span><span class="sidebar-phase-label">${esc(phase.name)}</span></div>`;
  });
  html += `</div>`;
  if (bp.last_heartbeat) {
    html += `<div class="sidebar-heartbeat"><span class="db-pulse" style="width:6px;height:6px"></span> Last heartbeat: ${esc(timeAgo(bp.last_heartbeat))}</div>`;
  }
  html += `</div>`;
  return html;
}

function telemetryActionIcon(action) {
  const icons = {
    claim: '\u25B6', heartbeat: '\u2764', complete: '\u2713',
    draft: '\u270E', refine: '\u270E', approve: '\u2713',
    dispatch: '\u21D2', merge: '\u2B8C', release: '\u2B8C',
  };
  return icons[action] || '\u2022';
}

function telemetryActionClass(action) {
  if (action === 'claim') return 'telem-action-claim';
  if (action === 'heartbeat') return 'telem-action-heartbeat';
  if (action === 'complete') return 'telem-action-complete';
  return 'telem-action-work';
}

function computeHealthStatus(bp) {
  if (!bp.last_heartbeat) return { status: 'unknown', label: 'No heartbeat' };
  const diffMs = Date.now() - new Date(bp.last_heartbeat).getTime();
  const diffH = diffMs / 3600000;
  if (diffH > 3) return { status: 'stale', label: 'Stale (' + Math.floor(diffH) + 'h)' };
  if (diffH > 1) return { status: 'warning', label: 'Warning (' + Math.floor(diffH * 60) + 'm)' };
  return { status: 'healthy', label: 'Healthy' };
}

function computeCommitRate(commits) {
  if (commits.length < 2) return null;
  const dates = commits.map(c => new Date(c.date).getTime()).filter(t => !isNaN(t));
  if (dates.length < 2) return null;
  const span = Math.max(...dates) - Math.min(...dates);
  const hours = span / 3600000;
  if (hours < 0.01) return null;
  return (dates.length / hours).toFixed(1);
}

function renderTelemetryFeed(agents) {
  const selectedBp = agents.find(a => a.id === sidebarState.selectedAgentBpId);
  if (!selectedBp) {
    return `<div class="sidebar-section" style="flex:1"><div class="sidebar-section-header">Agent Telemetry</div><div class="sidebar-empty">No agent selected</div></div>`;
  }

  const telemetry = sidebarState.telemetryCache[selectedBp.id];
  if (!telemetry) {
    return `<div class="sidebar-section" style="flex:1"><div class="sidebar-section-header">Agent Telemetry</div><div class="sidebar-empty">Loading telemetry...</div></div>`;
  }

  const agentId = selectedBp.agent_id || '';
  const allCommits = telemetry.commits || [];
  // Filter to selected agent's commits (if agent_id known), else show all
  const commits = agentId
    ? allCommits.filter(c => c.agent_id === agentId || c.agent_id === '')
    : allCommits;
  const diffStats = telemetry.diff_stats || {};
  const crps = telemetry.crps || [];

  let html = `<div class="sidebar-section" style="flex:1">`;
  html += `<div class="sidebar-section-header">Agent Telemetry</div>`;

  // --- Health indicators ---
  const health = computeHealthStatus(selectedBp);
  const runtime = runtimeSince(selectedBp.claimed || selectedBp.last_heartbeat);
  const rate = computeCommitRate(commits);

  html += `<div class="telem-health">`;
  html += `<div class="telem-health-row">`;
  html += `<span class="telem-health-dot telem-health-${esc(health.status)}"></span>`;
  html += `<span class="telem-health-label">${esc(health.label)}</span>`;
  if (runtime) html += `<span class="telem-health-runtime">${esc(runtime)}</span>`;
  html += `</div>`;

  // Stats row
  html += `<div class="telem-stats">`;
  if (diffStats.files > 0) {
    html += `<span class="telem-stat"><span class="telem-stat-val">${diffStats.files}</span> files</span>`;
    html += `<span class="telem-stat telem-stat-ins">+${diffStats.insertions}</span>`;
    html += `<span class="telem-stat telem-stat-del">-${diffStats.deletions}</span>`;
  }
  if (rate) html += `<span class="telem-stat">${esc(rate)} c/h</span>`;
  html += `<span class="telem-stat">${commits.length} commits</span>`;
  html += `</div>`;
  html += `</div>`;

  // --- CRP indicators ---
  if (crps.length > 0) {
    const blocking = crps.filter(c => c.mode === 'blocking' && c.status === 'open');
    const deferred = crps.filter(c => c.mode === 'deferred' && c.status === 'open');
    if (blocking.length > 0 || deferred.length > 0) {
      html += `<div class="telem-crps">`;
      blocking.forEach(c => {
        html += `<div class="telem-crp telem-crp-blocking">`;
        html += `<span class="telem-crp-icon">\u26A0</span>`;
        html += `<span class="telem-crp-label">Blocking: ${esc(c.category || c.trigger || 'CRP')}</span>`;
        html += `<span class="telem-crp-id">${esc((c.crp_id || '').slice(0, 6))}</span>`;
        html += `</div>`;
      });
      deferred.forEach(c => {
        html += `<div class="telem-crp telem-crp-deferred">`;
        html += `<span class="telem-crp-icon">\u25CB</span>`;
        html += `<span class="telem-crp-label">Deferred: ${esc(c.category || c.trigger || 'CRP')}</span>`;
        html += `<span class="telem-crp-id">${esc((c.crp_id || '').slice(0, 6))}</span>`;
        html += `</div>`;
      });
      html += `</div>`;
    }
  }

  // --- Activity timeline (filtered, heartbeats collapsed) ---
  const displayCommits = commits.slice(0, 20);
  // Group consecutive heartbeats
  const timelineItems = [];
  let heartbeatRun = 0;
  displayCommits.forEach((c, i) => {
    if (c.action === 'heartbeat') {
      heartbeatRun++;
      // If next is also heartbeat, skip rendering for now
      const next = displayCommits[i + 1];
      if (next && next.action === 'heartbeat') return;
      // Render collapsed heartbeat group
      if (heartbeatRun > 1) {
        timelineItems.push({ type: 'heartbeat-group', count: heartbeatRun, date: c.date });
      } else {
        timelineItems.push({ type: 'commit', ...c });
      }
      heartbeatRun = 0;
    } else {
      timelineItems.push({ type: 'commit', ...c });
    }
  });

  html += `<div class="telem-timeline-header">Activity <span class="db-count">${commits.length}</span></div>`;
  if (timelineItems.length === 0) {
    html += `<div class="sidebar-empty">No activity yet</div>`;
  } else {
    html += `<div class="telem-timeline">`;
    timelineItems.forEach(item => {
      if (item.type === 'heartbeat-group') {
        html += `<div class="telem-entry telem-action-heartbeat telem-heartbeat-group">`;
        html += `<span class="telem-entry-icon">\u2764</span>`;
        html += `<span class="telem-entry-msg">${item.count} heartbeats</span>`;
        html += `<span class="telem-entry-time">${esc(item.date ? formatTelemetryTime(item.date) : '')}</span>`;
        html += `</div>`;
      } else {
        const actionCls = telemetryActionClass(item.action);
        const icon = telemetryActionIcon(item.action);
        // Strip conventional prefix and agent suffix for cleaner display
        let msg = item.message || '';
        const prefixMatch = msg.match(/^\w+\(bp:[^)]+\):\s*/);
        let cleanMsg = prefixMatch ? msg.slice(prefixMatch[0].length) : msg;
        cleanMsg = cleanMsg.replace(/\s*\[agent:[0-9a-f]+\]\s*$/, '');
        html += `<div class="telem-entry ${esc(actionCls)}">`;
        html += `<span class="telem-entry-icon">${icon}</span>`;
        html += `<span class="telem-entry-msg" title="${esc(msg)}">${esc(cleanMsg.slice(0, 55))}</span>`;
        html += `<span class="telem-entry-time">${esc(item.date ? formatTelemetryTime(item.date) : '')}</span>`;
        html += `</div>`;
      }
    });
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function formatTelemetryTime(isoString) {
  if (!isoString) return '';
  try {
    const d = new Date(isoString);
    return isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch { return ''; }
}

function updateSidebarVisibility() {
  const sidebar = document.getElementById('overview-sidebar');
  if (!sidebar) return;
  sidebar.classList.toggle('collapsed', dashboardState2.activeAgents.length === 0);
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  if (isNaN(diff) || diff < 0) return '';
  const sec = Math.floor(diff / 1000);
  if (sec < 60) return 'just now';
  const min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  const hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  const days = Math.floor(hr / 24);
  return days + 'd ago';
}

function crpSnippet(body, maxLines = 2) {
  if (!body) return '';
  const lines = body.split('\n').filter(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'));
  return lines.slice(0, maxLines).join(' ').slice(0, 200);
}

function toggleCrpCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const idx = parseInt(cardId.replace('crp-card-', ''), 10);
  const wasOpen = card.classList.contains('open');
  card.classList.toggle('open');
  // Persist open/closed state
  if (wasOpen) {
    dashboardState2.crpOpenCards.delete(idx);
  } else {
    dashboardState2.crpOpenCards.add(idx);
  }
  // Show/hide resolve section
  const resolve = document.getElementById('crp-resolve-' + cardId);
  if (resolve) resolve.style.display = wasOpen ? 'none' : 'block';
  // Auto-load agent log on first open
  if (!wasOpen) {
    const logTab = card.querySelector('[data-tab="log"]');
    if (logTab && logTab.dataset.loaded !== 'true') {
      const bpId = logTab.id.replace('crp-log-', '');
      loadAgentLog(bpId, logTab);
    }
  }
}

function switchCrpTab(cardId, tabName) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const idx = parseInt(cardId.replace('crp-card-', ''), 10);
  // Persist active tab
  dashboardState2.crpActiveTabs[idx] = tabName;
  // Deactivate all tabs and content
  card.querySelectorAll('.crp-tab').forEach(t => t.classList.remove('active'));
  card.querySelectorAll('.crp-tab-content').forEach(c => c.classList.remove('active'));
  // Activate selected
  const activeTab = card.querySelector(`.crp-tab[data-crp-tab="${tabName}"]`);
  if (activeTab) activeTab.classList.add('active');
  const content = card.querySelector(`[data-tab="${tabName}"]`);
  if (content) {
    content.classList.add('active');
    // Auto-load agent log when tab selected
    if (tabName === 'log' && content.dataset.loaded !== 'true') {
      const bpId = content.id.replace('crp-log-', '');
      loadAgentLog(bpId, content);
    }
  }
}

async function loadAgentLog(bpId, container) {
  container.innerHTML = '<div class="agent-log-empty">Loading...</div>';
  try {
    const resp = await fetch('/api/agent-log/' + bpId);
    if (!resp.ok) throw new Error('Failed to load');
    const entries = await resp.json();
    if (entries.length === 0) {
      container.innerHTML = '<div class="agent-log-empty">No commits found for this BP.</div>';
    } else {
      let html = '';
      entries.forEach(e => {
        html += `<div class="agent-log-entry">
          <span class="agent-log-hash">${esc(e.short_hash)}</span>
          <span class="agent-log-msg" title="${esc(e.message)}">${esc(e.message)}</span>
          <span class="agent-log-date">${esc(timeAgo(e.date))}</span>
        </div>`;
      });
      container.innerHTML = html;
    }
    container.dataset.loaded = 'true';
  } catch (err) {
    container.innerHTML = `<div class="agent-log-empty">Error: ${esc(err.message)}</div>`;
  }
}

function toggleReviewCard(cardId) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const idx = parseInt(cardId.replace('review-card-', ''), 10);
  const wasOpen = card.classList.contains('open');
  card.classList.toggle('open');
  // Show/hide action bar
  const actions = document.getElementById('review-actions-' + cardId);
  if (actions) actions.style.display = wasOpen ? 'none' : 'flex';
  if (wasOpen) {
    dashboardState2.reviewOpenCards.delete(idx);
  } else {
    dashboardState2.reviewOpenCards.add(idx);
    // Auto-load MRP on first expand
    const mrpTab = card.querySelector('[data-tab="mrp"]');
    if (mrpTab && mrpTab.dataset.loaded !== 'true') {
      const bpId = mrpTab.id.replace('review-mrp-', '');
      loadMrpContent(bpId, mrpTab);
    }
    // Auto-load agent log
    const logTab = card.querySelector('[data-tab="log"]');
    if (logTab && logTab.dataset.loaded !== 'true') {
      const bpId = logTab.id.replace('review-log-', '');
      loadAgentLog(bpId, logTab);
    }
  }
}

function switchReviewTab(cardId, tabName) {
  const card = document.getElementById(cardId);
  if (!card) return;
  const idx = parseInt(cardId.replace('review-card-', ''), 10);
  dashboardState2.reviewActiveTabs[idx] = tabName;
  card.querySelectorAll('.crp-tab').forEach(t => t.classList.remove('active'));
  card.querySelectorAll('.crp-tab-content').forEach(c => c.classList.remove('active'));
  const activeTab = card.querySelector(`.crp-tab[data-crp-tab="${tabName}"]`);
  if (activeTab) activeTab.classList.add('active');
  const content = card.querySelector(`[data-tab="${tabName}"]`);
  if (content) {
    content.classList.add('active');
    if (tabName === 'mrp' && content.dataset.loaded !== 'true') {
      const bpId = content.id.replace('review-mrp-', '');
      loadMrpContent(bpId, content);
    }
    if (tabName === 'log' && content.dataset.loaded !== 'true') {
      const bpId = content.id.replace('review-log-', '');
      loadAgentLog(bpId, content);
    }
  }
}

async function loadMrpContent(bpId, container) {
  const bp = state.byId[bpId];
  // Check structured cache first
  if (dashboardState2.reviewMrpStructuredCache[bpId]) {
    renderMrpStructuredView(dashboardState2.reviewMrpStructuredCache[bpId], container, bpId);
    container.dataset.loaded = 'true';
    return;
  }
  // Check legacy cache
  if (dashboardState2.reviewMrpCache[bpId]) {
    container.innerHTML = linkifyArtifacts(renderMarkdown(dashboardState2.reviewMrpCache[bpId]), bp);
    container.dataset.loaded = 'true';
    return;
  }
  container.innerHTML = '<div class="agent-log-empty">Loading MRP...</div>';
  // Try structured API first
  try {
    const resp = await fetch('/api/mrp-structured/' + bpId);
    if (resp.ok) {
      const data = await resp.json();
      dashboardState2.reviewMrpStructuredCache[bpId] = data;
      renderMrpStructuredView(data, container, bpId);
      container.dataset.loaded = 'true';
      return;
    }
  } catch (e) { /* fall through to legacy */ }
  // Legacy fallback: raw markdown
  try {
    const resp = await fetch('/api/mrp/' + bpId);
    if (!resp.ok) throw new Error('MRP not found');
    const data = await resp.json();
    dashboardState2.reviewMrpCache[bpId] = data.body;
    container.innerHTML = linkifyArtifacts(renderMarkdown(data.body), bp);
    container.dataset.loaded = 'true';
  } catch (err) {
    container.innerHTML = `<div class="agent-log-empty">No MRP available: ${esc(err.message)}</div>`;
  }
}

// ── Structured MRP Rendering ──

function renderMrpStructuredView(data, container, bpId) {
  const bp = state.byId[bpId];
  const func = data.sections.functional || {};
  const verif = data.sections.verification || {};
  const hygiene = data.sections.hygiene || {};
  const rationale = data.sections.rationale || {};
  const audit = data.sections.auditability || {};

  // If all sections are raw fallback, just render markdown
  if (func.raw !== undefined && verif.raw !== undefined) {
    container.innerHTML = linkifyArtifacts(renderMarkdown(data.raw_body), bp);
    return;
  }

  let html = '';

  // ── Executive Summary Strip ──
  html += renderMrpSummaryStrip(data);

  // ── AC Checklist ──
  if (func.ac_items && func.ac_items.length > 0) {
    html += '<div class="mrp-section-title">Acceptance Criteria</div>';
    html += renderMrpAcChecklist(func.ac_items);
  }

  // ── Files Changed ──
  const files = data.files_changed || audit.files_changed || [];
  if (files.length > 0) {
    html += renderMrpFilesChanged(files, data.branch);
  }

  // ── Collapsible Detail Sections ──
  const acMeta = func.ac_items ? `${func.passed}/${func.total} passed` : '';
  const verifMeta = verif.test_count ? `${verif.test_count} tests` : (verif.has_tests === false ? 'no test suite' : '');
  const hygMeta = hygiene.items ? `${hygiene.items.length} items checked` : '';
  const ratMeta = `${rationale.decisions_count || 0} decisions` + (rationale.has_crps ? `, ${rationale.crps.length} CRPs` : ', 0 CRPs');
  const auditMeta = `${audit.commits_count || 0} commits, ${audit.files_count || 0} files`;

  const secIndicator = (sec) => {
    if (sec === 'functional') return func.all_passed ? 'mrp-ind-pass' : 'mrp-ind-fail';
    if (sec === 'verification') return verif.has_tests ? 'mrp-ind-pass' : 'mrp-ind-warn';
    if (sec === 'hygiene') return 'mrp-ind-pass';
    if (sec === 'rationale') return rationale.has_crps ? 'mrp-ind-warn' : 'mrp-ind-pass';
    return 'mrp-ind-info';
  };

  const sectionDefs = [
    { num: 1, title: 'Functional Completeness', key: 'functional', meta: acMeta },
    { num: 2, title: 'Sound Verification', key: 'verification', meta: verifMeta },
    { num: 3, title: 'SE Hygiene', key: 'hygiene', meta: hygMeta },
    { num: 4, title: 'Clear Rationale', key: 'rationale', meta: ratMeta },
    { num: 5, title: 'Full Auditability', key: 'auditability', meta: auditMeta },
  ];

  for (const sec of sectionDefs) {
    const secData = data.sections[sec.key] || {};
    const bodyText = secData.raw !== undefined ? secData.raw : (data.raw_body || '');
    // Extract section body from raw_body for rendered detail
    let sectionBody = '';
    if (secData.raw !== undefined) {
      sectionBody = secData.raw;
    } else {
      // Extract from raw_body using section heading
      const re = new RegExp('## ' + sec.num + '\\.\\s+[^\\n]+\\n([\\s\\S]*?)(?=## \\d+\\.|$)');
      const m = data.raw_body.match(re);
      sectionBody = m ? m[1].trim() : '';
    }
    const rendered = linkifyArtifacts(renderMarkdown(sectionBody), bp);
    html += renderMrpCollapsibleSection(sec.title, sec.num, rendered, secIndicator(sec.key), sec.meta);
  }

  container.innerHTML = html;
}

function renderMrpSummaryStrip(data) {
  const func = data.sections.functional || {};
  const verif = data.sections.verification || {};
  const hygiene = data.sections.hygiene || {};
  const rationale = data.sections.rationale || {};

  const acPassed = func.passed || 0;
  const acTotal = func.total || 0;
  const allAcOk = func.all_passed === true;
  const hasTests = verif.has_tests !== false;
  const testCount = verif.test_count || 0;

  // Overall verdict
  const overallPass = allAcOk && hasTests;
  const overallFail = !allAcOk;
  const overallClass = overallFail ? 'mrp-overall-fail' : (overallPass ? 'mrp-overall-pass' : 'mrp-overall-warn');
  const overallLabel = overallFail ? 'Issues' : (overallPass ? 'Pass' : 'Review');

  const acColor = allAcOk ? 'var(--status-completed)' : '#ef4444';
  const testColor = hasTests ? 'var(--status-completed)' : 'var(--status-ready)';

  let html = '<div class="mrp-summary-strip">';

  // AC card
  html += `<div class="mrp-summary-card ${allAcOk ? 'mrp-card-pass' : 'mrp-card-fail'}">
    ${svgRing(acPassed, acTotal, acColor)}
    <div class="kpi-card-info">
      <div class="kpi-card-label">Acceptance</div>
      <div class="kpi-card-value">${acPassed}/${acTotal}</div>
      <div class="kpi-card-detail">${allAcOk ? 'all criteria met' : (acTotal - acPassed) + ' open'}</div>
    </div>
  </div>`;

  // Tests card
  html += `<div class="mrp-summary-card ${hasTests ? 'mrp-card-pass' : 'mrp-card-warn'}">
    ${svgRing(hasTests ? testCount : 0, Math.max(testCount, 1), testColor)}
    <div class="kpi-card-info">
      <div class="kpi-card-label">Verification</div>
      <div class="kpi-card-value">${hasTests ? testCount : '--'}</div>
      <div class="kpi-card-detail">${hasTests ? 'tests' + (verif.coverage ? ', ' + esc(verif.coverage) + ' coverage' : '') : 'no test suite'}</div>
    </div>
  </div>`;

  // Rationale card
  const decCount = rationale.decisions_count || 0;
  const crpCount = rationale.crps ? rationale.crps.length : 0;
  html += `<div class="mrp-summary-card mrp-card-pass">
    <div class="kpi-card-info" style="padding-left:4px">
      <div class="kpi-card-label">Rationale</div>
      <div class="kpi-card-value">${decCount}</div>
      <div class="kpi-card-detail">decisions, ${crpCount} CRPs</div>
    </div>
  </div>`;

  // Overall verdict
  html += `<div class="mrp-summary-card ${overallClass}">
    <div class="kpi-card-info" style="text-align:center">
      <div class="kpi-card-label">Verdict</div>
      <div class="kpi-card-value">${esc(overallLabel)}</div>
    </div>
  </div>`;

  html += '</div>';
  return html;
}

function renderMrpAcChecklist(acItems) {
  let html = '<div class="mrp-ac-list">';
  acItems.forEach((ac, idx) => {
    const statusClass = ac.status === 'pass' ? 'mrp-ac-pass' : (ac.status === 'fail' ? 'mrp-ac-fail' : 'mrp-ac-partial');
    const statusLabel = ac.status === 'pass' ? 'PASS' : (ac.status === 'fail' ? 'FAIL' : 'PARTIAL');
    const evidence = ac.evidence || '';
    const hasLongEvidence = evidence.length > 120;

    html += `<div class="mrp-ac-item">
      <span class="mrp-ac-status ${statusClass}">${statusLabel}</span>
      <div class="mrp-ac-info">
        <div class="mrp-ac-header">
          <span class="mrp-ac-code">${esc(ac.code)}</span>
          <span class="mrp-ac-title">${esc(ac.title)}</span>
        </div>`;
    if (evidence) {
      html += `<div class="mrp-ac-evidence" id="mrp-ev-${idx}">${esc(evidence)}</div>`;
      if (hasLongEvidence) {
        html += `<span class="mrp-ac-toggle" onclick="toggleMrpEvidence(${idx})">show more</span>`;
      }
    }
    html += `</div></div>`;
  });
  html += '</div>';
  return html;
}

function toggleMrpEvidence(idx) {
  const el = document.getElementById('mrp-ev-' + idx);
  if (!el) return;
  const toggle = el.nextElementSibling;
  if (el.classList.contains('expanded')) {
    el.classList.remove('expanded');
    if (toggle) toggle.textContent = 'show more';
  } else {
    el.classList.add('expanded');
    if (toggle) toggle.textContent = 'show less';
  }
}

function renderMrpFilesChanged(files, branch) {
  let html = '<div class="mrp-files-section">';
  html += '<div class="mrp-section-title">Files Changed</div>';
  html += '<div class="dash-artifact-grid" style="padding-left:0">';
  files.forEach(f => {
    const avail = f.exists || f.exists_on_branch;
    const onBranch = f.exists_on_branch && !f.exists;
    const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
    const icon = avail ? '\u2713' : '\u2022';
    const filename = f.path.split('/').pop();
    const branchParam = onBranch && branch ? `, '${esc(branch)}'` : '';
    const clickAttr = avail ? `onclick="previewArtifact('${esc(f.path)}'${branchParam})"` : '';
    const desc = f.description ? ` \u2014 ${esc(f.description)}` : '';
    html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(f.path)}${desc}${onBranch ? ' (on agent branch)' : ''}">
      <span class="dash-artifact-icon">${icon}</span>
      <span class="dash-artifact-name">${esc(filename)}</span>
      ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
    </div>`;
  });
  html += '</div></div>';
  return html;
}

function renderMrpCollapsibleSection(title, num, bodyHtml, indicatorClass, meta) {
  return `<details class="mrp-detail-section">
    <summary class="mrp-detail-summary">
      <span class="mrp-section-indicator ${indicatorClass}"></span>
      ${num}. ${esc(title)}
      <span class="mrp-section-meta">${esc(meta)}</span>
    </summary>
    <div class="mrp-detail-body">${bodyHtml}</div>
  </details>`;
}

async function loadArtifactsTab(bpId, container) {
  container.innerHTML = '<div class="agent-log-empty">Loading artifacts...</div>';
  try {
    const resp = await fetch('/api/bp-artifacts/' + bpId);
    if (!resp.ok) throw new Error('Failed to load artifacts');
    const data = await resp.json();
    const branch = data.branch;
    const all = (data.artifacts || []).concat(data.mrp_artifacts || []);
    if (all.length === 0) {
      container.innerHTML = '<div class="agent-log-empty">No output artifacts declared.</div>';
      container.dataset.loaded = 'true';
      return;
    }
    let html = '<div class="detail-artifacts-list">';
    // Group: declared output artifacts
    if (data.artifacts.length > 0) {
      html += '<div class="detail-artifacts-group-title">Output Artifacts</div>';
      html += '<div class="dash-artifact-grid">';
      data.artifacts.forEach(a => {
        const avail = a.exists || a.exists_on_branch;
        const onBranch = a.exists_on_branch && !a.exists;
        const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
        const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
        const filename = a.path.split('/').pop();
        const branchParam = onBranch && branch ? `, '${esc(branch)}'` : '';
        const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${branchParam})"` : '';
        const desc = a.description ? ` \u2014 ${esc(a.description)}` : '';
        html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${desc}${onBranch ? ' (on agent branch)' : ''}">
          <span class="dash-artifact-icon">${icon}</span>
          <span class="dash-artifact-name">${esc(filename)}</span>
          ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
          ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
        </div>`;
      });
      html += '</div>';
    }
    // Group: MRP artifacts
    if (data.mrp_artifacts && data.mrp_artifacts.length > 0) {
      html += '<div class="detail-artifacts-group-title">MRP Artifacts</div>';
      html += '<div class="dash-artifact-grid">';
      data.mrp_artifacts.forEach(a => {
        const avail = a.exists || a.exists_on_branch;
        const onBranch = a.exists_on_branch && !a.exists;
        const cls = avail ? (onBranch ? 'exists-on-branch' : 'exists') : 'missing';
        const icon = a.is_dir ? '\ud83d\udcc1' : (avail ? '\u2713' : '\u2022');
        const filename = a.path.split('/').pop();
        const branchParam = onBranch && branch ? `, '${esc(branch)}'` : '';
        const clickAttr = avail ? `onclick="previewArtifact('${esc(a.path)}'${branchParam})"` : '';
        const desc = a.description ? ` \u2014 ${esc(a.description)}` : '';
        html += `<div class="dash-artifact-item ${cls}" ${clickAttr} title="${esc(a.path)}${desc}${onBranch ? ' (on agent branch)' : ''}">
          <span class="dash-artifact-icon">${icon}</span>
          <span class="dash-artifact-name">${esc(filename)}</span>
          ${avail && !a.is_dir ? `<span class="dash-artifact-size">${formatBytes(a.size)}</span>` : ''}
          ${onBranch ? '<span class="dash-artifact-branch-badge">branch</span>' : ''}
        </div>`;
      });
      html += '</div>';
    }
    html += '</div>';
    container.innerHTML = html;
    container.dataset.loaded = 'true';
  } catch (err) {
    container.innerHTML = `<div class="agent-log-empty">Error: ${esc(err.message)}</div>`;
  }
}

function runtimeSince(isoString) {
  if (!isoString) return '';
  const diff = Date.now() - new Date(isoString).getTime();
  if (isNaN(diff) || diff < 0) return '';
  const min = Math.floor(diff / 60000);
  const hr = Math.floor(min / 60);
  if (hr > 0) return hr + 'h ' + (min % 60) + 'm';
  return min + 'm';
}

async function buildDashboardData() {
  // LoopScript phases (loaded once, cached)
  await loadLoopscriptPhases();

  // CRPs
  try {
    const resp = await fetch('/api/crps');
    if (resp.ok) {
      const crps = await resp.json();
      dashboardState2.openCrps = sortByHierarchy(crps.map(crp => ({
        ...crp,
        bpTitle: (state.byId[crp.bp_id] || {}).title || crp.bp_id,
      })), crp => crp.bp_id);
    }
  } catch {}

  // Agent sessions
  let sessions = [];
  try {
    const resp = await fetch('/api/agent/sessions');
    if (resp.ok) sessions = await resp.json();
  } catch {}

  const allBPs = state.showArchived
    ? state.briefings
    : state.briefings.filter(bp => !bp.archived);

  // Pending reviews: split into child reviews (leaf nodes) and parent reviews
  // Parents only appear once ALL their children are reviewed — clean bottom-up workflow
  const completedBPs = allBPs.filter(bp => bp.status === 'completed');
  const childReviews = [];
  const parentReviews = [];
  completedBPs.forEach(bp => {
    const children = bp.children || [];
    if (children.length > 0) {
      const allChildrenReviewed = children.every(cid => {
        const c = state.byId[cid];
        return c && c.status === 'reviewed';
      });
      if (allChildrenReviewed) parentReviews.push(bp);
      // else: parent hidden until all children reviewed
    } else {
      childReviews.push(bp);
    }
  });
  dashboardState2.pendingReviews = sortByHierarchy(childReviews);
  dashboardState2.pendingParentReviews = parentReviews;

  // Stale BPs — upstream was revised, work needs revalidation
  dashboardState2.staleBPs = sortByHierarchy(allBPs.filter(bp =>
    bp.status === 'stale' && (!bp.children || bp.children.length === 0)
  ));

  // Active agents (sorted by hierarchy)
  dashboardState2.activeAgents = sortByHierarchy(allBPs.filter(bp =>
    ['dispatched', 'claimed', 'in-progress', 'in_progress'].includes(bp.status) &&
    !bp.is_parent
  ));

  // Ready to dispatch (sorted by hierarchy)
  dashboardState2.readyToDispatch = sortByHierarchy(allBPs.filter(bp => isDispatchable(bp)));

  // Draft BPs awaiting approval (leaf BPs only)
  dashboardState2.drafts = sortByHierarchy(allBPs.filter(bp =>
    bp.status === 'draft' && (!bp.children || bp.children.length === 0)
  ));

  // Recently completed (last 10)
  dashboardState2.recentlyCompleted = allBPs
    .filter(bp => bp.status === 'completed' || bp.status === 'reviewed')
    .sort((a, b) => (b.completed || '').localeCompare(a.completed || ''))
    .slice(0, 10);

  dashboardState2.lastRefresh = new Date();
}

function startDashboardRefresh() {
  stopDashboardRefresh();
  dashboardState2.refreshTimer = setInterval(async () => {
    await fetchBriefings();
    await buildDashboardData();
    if (queueState.selectedId) {
      const savedTab = queueState.detailTab;
      reselectAfterTransition(queueState.selectedId);
      queueState.detailTab = savedTab;
    }
    renderOverview();
  }, 30000);
}

function stopDashboardRefresh() {
  if (dashboardState2.refreshTimer) {
    clearInterval(dashboardState2.refreshTimer);
    dashboardState2.refreshTimer = null;
  }
}

function renderOverview() {
  // ── Save CRP textarea values before re-render ──
  dashboardState2.openCrps.forEach(crp => {
    const input = document.getElementById('crp-input-' + crp.bp_id);
    if (input && input.value.trim()) {
      dashboardState2.crpInputValues[crp.bp_id] = input.value;
    }
  });

  // ── Render all 3 panels + KPI strip ──
  renderKpiStrip();
  renderQueue();
  renderDetailPanel();
  updateSidebarVisibility();
  renderSidebar();
  loadTelemetryForActiveAgents().then(() => renderSidebar());
}

// Legacy renderOverview sections — kept for reference but no longer used
function _legacyRenderOverview() {
  const container = document.getElementById('overview-main');

  let html = '';
  let d = 0;
  const s = 40; // stagger ms

  // ── Section 1: Action Required — Open CRPs ──
  html += `<div class="db-section db-animate" style="animation-delay:${d}ms">`;
  html += `<div class="db-section-header">Action Required <span class="db-count">${dashboardState2.openCrps.length}</span></div>`;
  html += `<div class="db-section-body" style="padding:8px 12px">`;
  if (dashboardState2.openCrps.length === 0) {
    html += `<div class="db-empty" style="padding:12px 4px">No open consultation requests</div>`;
  } else {
    dashboardState2.openCrps.forEach((crp, idx) => {
      html += renderGroupDivider(crp.bp_id, idx > 0 ? dashboardState2.openCrps[idx - 1].bp_id : null, dashboardState2.openCrps.length);
      const cardId = `crp-card-${idx}`;
      const bp = state.byId[crp.bp_id];
      const snippet = crpSnippet(crp.body);
      const modeStyle = crp.mode === 'blocking'
        ? 'background:rgba(239,68,68,0.15);color:#ef4444;border-color:rgba(239,68,68,0.3)'
        : 'background:rgba(59,130,246,0.15);color:#3b82f6;border-color:rgba(59,130,246,0.3)';

      html += `<div class="crp-card" id="${cardId}">`;

      // ── Header (always visible, clickable to expand) ──
      html += `<div class="crp-card-header" onclick="toggleCrpCard('${cardId}')">
        <span class="crp-card-arrow">\u25B6</span>
        <div class="crp-card-summary">
          ${renderBPBreadcrumb(state.byId[crp.bp_id] || {id: crp.bp_id, title: crp.bpTitle, slug: crp.bpTitle})}
          <div class="crp-card-badges">
            <span class="db-badge" style="background:rgba(245,158,11,0.15);color:var(--status-ready);border-color:rgba(245,158,11,0.3)">${esc(crp.category || 'crp')}</span>
            ${crp.urgency ? `<span class="db-badge" style="${modeStyle}">${esc(crp.urgency)}</span>` : ''}
            ${crp.mode ? `<span class="db-badge" style="${modeStyle}">${esc(crp.mode)}</span>` : ''}
            ${crp.trigger ? `<span class="db-badge">${esc(crp.trigger)}</span>` : ''}
            ${crp.raised_by ? `<span class="db-agent-badge">agt:${esc(crp.raised_by)}</span>` : ''}
            ${crp.created ? `<span>${esc(crp.created)}</span>` : ''}
          </div>
          ${snippet ? `<div class="db-crp-snippet" style="margin-top:4px">${esc(snippet)}</div>` : ''}
        </div>
      </div>`;

      // ── Expandable body ──
      html += `<div class="crp-card-body">`;

      // Tabs
      html += `<div class="crp-card-tabs">
        <div class="crp-tab active" data-crp-tab="details" onclick="switchCrpTab('${cardId}','details')">Details</div>
        <div class="crp-tab" data-crp-tab="briefing" onclick="switchCrpTab('${cardId}','briefing')">Agent Brief</div>
        <div class="crp-tab" data-crp-tab="log" onclick="switchCrpTab('${cardId}','log')">Agent Log</div>
      </div>`;

      // Tab: Details (full CRP body)
      html += `<div class="crp-tab-content active" data-tab="details">`;
      html += `<div class="crp-meta-grid">`;
      html += `<span class="crp-meta-label">CRP ID</span><span class="crp-meta-value"><code>${esc(crp.crp_id)}</code></span>`;
      html += `<span class="crp-meta-label">BP</span><span class="crp-meta-value"><code>${esc(crp.bp_id)}</code> — ${esc(crp.bpTitle)}</span>`;
      if (crp.mode) html += `<span class="crp-meta-label">Mode</span><span class="crp-meta-value">${esc(crp.mode)}</span>`;
      if (crp.trigger) html += `<span class="crp-meta-label">Trigger</span><span class="crp-meta-value">${esc(crp.trigger)}</span>`;
      if (crp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(crp.phase)}</span>`;
      if (crp.routed_to) html += `<span class="crp-meta-label">Routed to</span><span class="crp-meta-value">${esc(crp.routed_to)}</span>`;
      if (crp.raised_by) html += `<span class="crp-meta-label">Raised by</span><span class="crp-meta-value"><code>agt:${esc(crp.raised_by)}</code></span>`;
      if (crp.created) html += `<span class="crp-meta-label">Created</span><span class="crp-meta-value">${esc(crp.created)}</span>`;
      html += `</div>`;
      html += `<hr>`;
      html += crp.body ? renderMarkdown(crp.body) : '<p style="color:var(--text-muted)">No body content.</p>';
      html += `</div>`;

      // Tab: Briefing Pack (lazy loaded)
      html += `<div class="crp-tab-content" data-tab="briefing">`;
      if (bp && bp.body) {
        html += `<div class="crp-meta-grid">`;
        html += `<span class="crp-meta-label">Title</span><span class="crp-meta-value">${esc(bp.title || bp.slug)}</span>`;
        html += `<span class="crp-meta-label">Status</span><span class="crp-meta-value"><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></span>`;
        if (bp.agent_id) html += `<span class="crp-meta-label">Agent</span><span class="crp-meta-value"><code>agt:${esc(bp.agent_id)}</code></span>`;
        if (bp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(bp.phase)}</span>`;
        if (bp.last_heartbeat) html += `<span class="crp-meta-label">Heartbeat</span><span class="crp-meta-value">${esc(timeAgo(bp.last_heartbeat))}</span>`;
        html += `</div>`;
        html += `<hr>`;
        html += renderMarkdown(bp.body);
      } else {
        html += `<p style="color:var(--text-muted)">Agent definition not available or has no content.</p>`;
      }
      html += `</div>`;

      // Tab: Agent Log (lazy loaded via fetch)
      html += `<div class="crp-tab-content" data-tab="log" id="crp-log-${esc(crp.bp_id)}">`;
      html += `<div class="agent-log-empty">Click to load agent activity...</div>`;
      html += `</div>`;

      html += `</div>`; // end card-body

      // ── Resolve section (always at bottom of expanded card) ──
      html += `<div class="crp-resolve-section" style="display:none" id="crp-resolve-${cardId}">
        <textarea id="crp-input-${esc(crp.bp_id)}" placeholder="Enter your resolution response..." rows="3"
          onkeydown="if(event.key==='Enter'&&event.metaKey)resolveCrpAgent('${esc(crp.bp_id)}',event)"></textarea>
        <div class="crp-resolve-actions">
          <button class="agent-action-btn resolve-crp-btn" onclick="resolveCrpAgent('${esc(crp.bp_id)}', event)"${!agentState.available ? ' disabled' : ''}>Resolve CRP</button>
        </div>
      </div>`;

      html += `</div>`; // end crp-card
    });
  }
  html += `</div></div>`;
  d += s;

  // ── Section 2: Pending Reviews ──
  html += `<div class="db-section db-animate" style="animation-delay:${d}ms">`;
  const totalPendingReviews = dashboardState2.pendingReviews.length + dashboardState2.pendingParentReviews.length;
  html += `<div class="db-section-header">Pending Reviews <span class="db-count">${totalPendingReviews}</span></div>`;
  html += `<div class="db-section-body" style="padding:8px 12px">`;
  if (totalPendingReviews === 0) {
    html += `<div class="db-empty" style="padding:12px 4px">All reviews complete</div>`;
  } else {
    dashboardState2.pendingReviews.forEach((bp, idx) => {
      html += renderGroupDivider(bp.id, idx > 0 ? dashboardState2.pendingReviews[idx - 1].id : null, dashboardState2.pendingReviews.length);
      const cardId = `review-card-${idx}`;
      const firstLine = bp.body ? bp.body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '' : '';
      const parent = bp.parent ? state.byId[bp.parent] : null;

      html += `<div class="review-card" id="${cardId}">`;

      // ── Header (always visible) ──
      html += `<div class="crp-card-header" onclick="toggleReviewCard('${cardId}')">
        <span class="crp-card-arrow">\u25B6</span>
        <div class="crp-card-summary">
          ${renderBPBreadcrumb(bp)}
          <div class="crp-card-badges">
            ${bp.agent_id ? `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>` : ''}
            ${bp.completed ? `<span>${esc(timeAgo(bp.completed))}</span>` : ''}
          </div>
          ${firstLine ? `<div class="db-crp-snippet" style="margin-top:4px">${esc(firstLine.trim().slice(0, 200))}</div>` : ''}
        </div>
      </div>`;

      // ── Expandable body ──
      html += `<div class="crp-card-body">`;

      // Tabs
      html += `<div class="crp-card-tabs">
        <div class="crp-tab active" data-crp-tab="mrp" onclick="switchReviewTab('${cardId}','mrp')">MRP Report</div>
        <div class="crp-tab" data-crp-tab="briefing" onclick="switchReviewTab('${cardId}','briefing')">Agent Brief</div>
        <div class="crp-tab" data-crp-tab="log" onclick="switchReviewTab('${cardId}','log')">Agent Log</div>
      </div>`;

      // Tab: MRP (lazy loaded via fetch)
      html += `<div class="crp-tab-content active" data-tab="mrp" id="review-mrp-${esc(bp.id)}">`;
      html += `<div class="agent-log-empty">Loading MRP...</div>`;
      html += `</div>`;

      // Tab: Briefing Pack
      html += `<div class="crp-tab-content" data-tab="briefing">`;
      if (bp.body) {
        html += `<div class="crp-meta-grid">`;
        html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
        html += `<span class="crp-meta-label">Status</span><span class="crp-meta-value"><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></span>`;
        if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
        if (bp.agent_id) html += `<span class="crp-meta-label">Agent</span><span class="crp-meta-value"><code>agt:${esc(bp.agent_id)}</code></span>`;
        if (bp.phase) html += `<span class="crp-meta-label">Phase</span><span class="crp-meta-value">${esc(bp.phase)}</span>`;
        if (bp.last_heartbeat) html += `<span class="crp-meta-label">Heartbeat</span><span class="crp-meta-value">${esc(timeAgo(bp.last_heartbeat))}</span>`;
        if (bp.claimed) html += `<span class="crp-meta-label">Claimed</span><span class="crp-meta-value">${esc(timeAgo(bp.claimed))}</span>`;
        if (bp.completed) html += `<span class="crp-meta-label">Completed</span><span class="crp-meta-value">${esc(timeAgo(bp.completed))}</span>`;
        if (parent) html += `<span class="crp-meta-label">Parent</span><span class="crp-meta-value">${esc(parent.title || parent.slug)}</span>`;
        html += `</div><hr>`;
        html += renderMarkdown(bp.body);
      } else {
        html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
      }
      html += `</div>`;

      // Tab: Agent Log (lazy loaded)
      html += `<div class="crp-tab-content" data-tab="log" id="review-log-${esc(bp.id)}">`;
      html += `<div class="agent-log-empty">Click to load agent activity...</div>`;
      html += `</div>`;

      html += `</div>`; // end card-body

      // ── Action bar ──
      html += `<div class="review-action-bar" style="display:none" id="review-actions-${cardId}">
        <button class="agent-action-btn review-mrp-btn" onclick="reviewMrpAgent('${esc(bp.id)}', event)"${!agentState.available ? ' disabled' : ''}>Review MRP</button>
      </div>`;

      html += `</div>`; // end review-card
    });

    // ── Parent Reviews: shown only when all children are reviewed ──
    dashboardState2.pendingParentReviews.forEach((bp, idx) => {
      if (idx === 0 && dashboardState2.pendingReviews.length > 0) {
        html += `<div class="db-group-divider"><div class="db-group-label">Final Review</div></div>`;
      }
      const cardId = `review-card-parent-${idx}`;
      const firstLine = bp.body ? bp.body.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---')) || '' : '';

      html += `<div class="review-card" id="${cardId}">`;
      html += `<div class="crp-card-header" onclick="toggleReviewCard('${cardId}')">
        <span class="crp-card-arrow">\u25B6</span>
        <div class="crp-card-summary">
          <div class="db-item-title">${esc(bp.title || bp.slug)}</div>
          <div class="crp-card-badges">
            ${bp.agent_id ? `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>` : ''}
            ${bp.completed ? `<span>${esc(timeAgo(bp.completed))}</span>` : ''}
          </div>
          ${firstLine ? `<div class="db-crp-snippet" style="margin-top:4px">${esc(firstLine.trim().slice(0, 200))}</div>` : ''}
        </div>
      </div>`;

      html += `<div class="crp-card-body">`;
      html += `<div class="crp-card-tabs">
        <div class="crp-tab active" data-crp-tab="mrp" onclick="switchReviewTab('${cardId}','mrp')">MRP Report</div>
        <div class="crp-tab" data-crp-tab="briefing" onclick="switchReviewTab('${cardId}','briefing')">Agent Brief</div>
        <div class="crp-tab" data-crp-tab="log" onclick="switchReviewTab('${cardId}','log')">Agent Log</div>
      </div>`;
      html += `<div class="crp-tab-content active" data-tab="mrp" id="review-mrp-${esc(bp.id)}">`;
      html += `<div class="agent-log-empty">Loading MRP...</div>`;
      html += `</div>`;
      html += `<div class="crp-tab-content" data-tab="briefing">`;
      if (bp.body) {
        html += `<div class="crp-meta-grid">`;
        html += `<span class="crp-meta-label">ID</span><span class="crp-meta-value">${bpIdLabel(bp.id, bp.id, 'bp-id-code')}</span>`;
        html += `<span class="crp-meta-label">Status</span><span class="crp-meta-value"><span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span></span>`;
        if (bp.rigor) html += `<span class="crp-meta-label">Rigor</span><span class="crp-meta-value">${esc(bp.rigor)}</span>`;
        if (bp.agent_id) html += `<span class="crp-meta-label">Agent</span><span class="crp-meta-value"><code>agt:${esc(bp.agent_id)}</code></span>`;
        html += `</div><hr>`;
        html += renderMarkdown(bp.body);
      } else {
        html += `<p style="color:var(--text-muted)">Agent definition not available.</p>`;
      }
      html += `</div>`;
      html += `<div class="crp-tab-content" data-tab="log" id="review-log-${esc(bp.id)}">`;
      html += `<div class="agent-log-empty">Click to load agent activity...</div>`;
      html += `</div>`;
      html += `</div>`;
      html += `<div class="review-action-bar" style="display:none" id="review-actions-${cardId}">
        <button class="agent-action-btn review-mrp-btn" onclick="reviewMrpAgent('${esc(bp.id)}', event)"${!agentState.available ? ' disabled' : ''}>Review MRP</button>
      </div>`;
      html += `</div>`;
    });
  }
  html += `</div></div>`;
  d += s;

  // ── Section 3: Active Agents ──
  html += `<div class="db-section db-animate" style="animation-delay:${d}ms">`;
  html += `<div class="db-section-header">Active Agents <span class="db-count">${dashboardState2.activeAgents.length}</span></div>`;
  html += `<div class="db-section-body">`;
  if (dashboardState2.activeAgents.length === 0) {
    html += `<div class="db-empty">No agents running</div>`;
  } else {
    dashboardState2.activeAgents.forEach((bp, idx) => {
      html += renderGroupDivider(bp.id, idx > 0 ? dashboardState2.activeAgents[idx - 1].id : null, dashboardState2.activeAgents.length);
      const runtime = runtimeSince(bp.claimed || bp.last_heartbeat);
      html += `<div class="db-item priority-active">
        <span class="db-pulse"></span>
        <div class="db-item-main">
          ${renderBPBreadcrumb(bp)}
          <div class="db-item-meta">
            ${bp.agent_id ? `<span class="db-agent-badge">agt:${esc(bp.agent_id)}</span>` : ''}
            <span class="dash-status-badge ${(bp.status || '').replace('-','_')}">${esc(bp.status)}</span>
            ${bp.phase ? `<span class="db-badge">${esc(bp.phase)}</span>` : ''}
            ${runtime ? `<span>${esc(runtime)}</span>` : ''}
          </div>
        </div>
        <div class="db-item-actions">
          <button class="btn btn-outline btn-sm" onclick="overviewNavigateToBP('${esc(bp.id)}')">View</button>
        </div>
      </div>`;
    });
  }
  html += `</div></div>`;
  d += s;

  // ── Section 4: Ready to Dispatch ──
  html += `<div class="db-section db-animate" style="animation-delay:${d}ms">`;
  html += `<div class="db-section-header">Ready to Dispatch <span class="db-count">${dashboardState2.readyToDispatch.length}</span></div>`;
  html += `<div class="db-section-body">`;
  if (dashboardState2.readyToDispatch.length === 0) {
    html += `<div class="db-empty">No agents ready to launch</div>`;
  } else {
    dashboardState2.readyToDispatch.forEach((bp, idx) => {
      html += renderGroupDivider(bp.id, idx > 0 ? dashboardState2.readyToDispatch[idx - 1].id : null, dashboardState2.readyToDispatch.length);
      html += `<div class="db-item priority-dispatch">
        <div class="db-item-main">
          ${renderBPBreadcrumb(bp)}
        </div>
        <div class="db-item-actions">
          <button class="agent-action-btn dispatch-btn" onclick="dispatchBP('${esc(bp.id)}', event)"${!agentState.available ? ' disabled' : ''}>Handover task to an agent</button>
        </div>
      </div>`;
    });
  }
  html += `</div></div>`;
  d += s;

  // ── Section 5: Recent Activity ──
  if (dashboardState2.recentlyCompleted.length > 0) {
    html += `<div class="db-section db-animate" style="animation-delay:${d}ms">`;
    html += `<div class="db-section-header">Recent Activity <span class="db-count">${dashboardState2.recentlyCompleted.length}</span></div>`;
    html += `<div class="db-section-body">`;
    dashboardState2.recentlyCompleted.forEach(bp => {
      html += `<div class="db-item" style="cursor:pointer" onclick="overviewNavigateToBP('${esc(bp.id)}')">
        <div class="db-item-main">
          ${renderBPBreadcrumb(bp, true)}
        </div>
        <div class="db-item-meta" style="flex-shrink:0">
          <span class="dash-status-badge ${bp.status}">${esc(bp.status)}</span>
          ${bp.completed ? `<span style="font-size:10px">${esc(timeAgo(bp.completed))}</span>` : ''}
        </div>
      </div>`;
    });
    html += `</div></div>`;
    d += s;
  }

  // ── Footer ──
  const refreshAgo = dashboardState2.lastRefresh ? timeAgo(dashboardState2.lastRefresh.toISOString()) : '';
  html += `<div class="db-footer db-animate" style="animation-delay:${d}ms">
    <span>Last refreshed: ${esc(refreshAgo || 'just now')}</span>
    <button onclick="(async()=>{await fetchBriefings();await buildDashboardData();renderOverview();})()" title="Refresh">&#x21bb;</button>
  </div>`;

  container.innerHTML = html;

  // ── Render KPI Strip + Agent Sidebar ──
  renderKpiStrip();
  updateSidebarVisibility();
  renderSidebar();
  loadTelemetryForActiveAgents().then(() => renderSidebar());

  // ── Restore CRP UI state after re-render ──
  dashboardState2.crpOpenCards.forEach(idx => {
    const cardId = 'crp-card-' + idx;
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('open');
    const resolve = document.getElementById('crp-resolve-' + cardId);
    if (resolve) resolve.style.display = 'block';
    // Restore active tab
    const activeTab = dashboardState2.crpActiveTabs[idx] || 'details';
    if (activeTab !== 'details') {
      switchCrpTab(cardId, activeTab);
    }
    // Reload agent log if log tab was loaded
    const logTab = card.querySelector('[data-tab="log"]');
    if (logTab) {
      const bpId = logTab.id.replace('crp-log-', '');
      loadAgentLog(bpId, logTab);
    }
  });
  // Restore textarea values
  for (const [bpId, val] of Object.entries(dashboardState2.crpInputValues)) {
    const input = document.getElementById('crp-input-' + bpId);
    if (input) input.value = val;
  }

  // ── Restore Review UI state after re-render ──
  dashboardState2.reviewOpenCards.forEach(idx => {
    const cardId = 'review-card-' + idx;
    const card = document.getElementById(cardId);
    if (!card) return;
    card.classList.add('open');
    const actions = document.getElementById('review-actions-' + cardId);
    if (actions) actions.style.display = 'flex';
    // Restore active tab
    const activeTab = dashboardState2.reviewActiveTabs[idx] || 'mrp';
    if (activeTab !== 'mrp') {
      switchReviewTab(cardId, activeTab);
    }
    // Load MRP content
    const mrpTab = card.querySelector('[data-tab="mrp"]');
    if (mrpTab) {
      const bpId = mrpTab.id.replace('review-mrp-', '');
      loadMrpContent(bpId, mrpTab);
    }
    // Load agent log
    const logTab = card.querySelector('[data-tab="log"]');
    if (logTab) {
      const bpId = logTab.id.replace('review-log-', '');
      loadAgentLog(bpId, logTab);
    }
  });
}

async function overviewNavigateToBP(bpId) {
  // AC-4: Track selected BP for chat context injection
  setSelectedBp(bpId);
  if (state.briefings.length === 0) await fetchBriefings();
  if (!dashState.loaded) await fetchPhases();

  for (let gIdx = 0; gIdx < dashState.phaseGroups.length; gIdx++) {
    const group = dashState.phaseGroups[gIdx];
    if (group.parent_id === bpId) {
      dashState.activeGroup = gIdx;
      dashState.activePhase = group.phases.length > 0 ? 0 : -1;
      await switchView('dashboard');
      renderDashboard();
      return;
    }
    for (let pIdx = 0; pIdx < group.phases.length; pIdx++) {
      const phase = group.phases[pIdx];
      if (phase.bp_id === bpId) {
        dashState.activeGroup = gIdx;
        dashState.activePhase = pIdx;
        await switchView('dashboard');
        renderDashboard();
        return;
      }
      if (phase.child_details) {
        const match = phase.child_details.find(d => d.id === bpId);
        if (match) {
          dashState.activeGroup = gIdx;
          dashState.activePhase = pIdx;
          await switchView('dashboard');
          renderDashboard();
          return;
        }
      }
    }
  }
  await switchView('dashboard');
}

// ─── SSE Client Utility ───────────────────────────────────────────────

/**
 * SSE client for POST requests using fetch() + ReadableStream.
 * Returns an object with cancel() method.
 *
 * @param {string} url - Endpoint URL
 * @param {object|null} body - JSON body to POST, or null for GET
 * @param {object} callbacks - { onMessage, onToolUse, onComplete, onError }
 * @returns {{ cancel: Function, getSessionId: Function, eventIndex: number }}
 */
function sseClient(url, body, callbacks) {
  const controller = new AbortController();
  let sessionId = null;
  let cancelled = false;
  let eventIndex = 0;

  const run = async () => {
    try {
      const fetchOpts = { signal: controller.signal };
      if (body !== null) {
        fetchOpts.method = 'POST';
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify(body);
      }
      const resp = await fetch(url, fetchOpts);

      if (!resp.ok) {
        const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(errText || `HTTP ${resp.status}`);
      }

      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let eventType = null;
      let dataLines = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE events from the buffer
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';  // keep incomplete last line in buffer

        for (const line of lines) {
          if (line.startsWith('event:')) {
            eventType = line.slice(6).trim();
          } else if (line.startsWith('data:')) {
            dataLines.push(line.slice(5));
          } else if (line.trim() === '' && dataLines.length > 0) {
            // End of event
            const rawData = dataLines.join('\n');
            dataLines = [];
            try {
              const parsed = JSON.parse(rawData);
              eventIndex++;

              // Extract session ID from first message if present
              if (parsed.session_id && !sessionId) {
                sessionId = parsed.session_id;
              }

              if (eventType === 'tool_use' || parsed.type === 'tool_use') {
                if (callbacks.onToolUse) callbacks.onToolUse({
                  name: parsed.tool_name || parsed.tool || parsed.name || 'tool',
                  toolId: parsed.tool_id || '',
                  input: parsed.input || null,
                });
              } else if (eventType === 'tool_result' || parsed.type === 'tool_result') {
                if (callbacks.onToolResult) callbacks.onToolResult({
                  toolId: parsed.tool_id || '',
                  content: parsed.content || null,
                });
              } else if (eventType === 'system' || parsed.type === 'system') {
                if (callbacks.onSystem) callbacks.onSystem(parsed);
                // Don't fall through to onMessage for system events
              } else if (eventType === 'result' || parsed.type === 'result') {
                if (callbacks.onResult) callbacks.onResult(parsed);
                else if (callbacks.onMessage) callbacks.onMessage(parsed.text || parsed.content || '');
              } else if (eventType === 'error' || parsed.type === 'error') {
                if (callbacks.onError) callbacks.onError(new Error(parsed.error || parsed.message || 'Agent error'));
              } else if (parsed.text || parsed.content) {
                if (callbacks.onMessage) callbacks.onMessage(parsed.text || parsed.content || '');
              }
            } catch {
              // Not JSON — treat as plain text
              if (callbacks.onMessage) callbacks.onMessage(rawData);
            }
            eventType = null;
          }
        }
      }

      if (!cancelled && callbacks.onComplete) callbacks.onComplete();
    } catch (err) {
      if (err.name === 'AbortError') {
        if (callbacks.onComplete) callbacks.onComplete();
        return;
      }
      if (callbacks.onError) callbacks.onError(err);
    }
  };

  run();

  return {
    cancel: async () => {
      cancelled = true;
      controller.abort();
      if (sessionId) {
        try {
          await fetch(`/api/agent/sessions/${sessionId}`, { method: 'DELETE' });
        } catch {
          // Ignore cancel errors
        }
      }
    },
    getSessionId: () => sessionId,
    getEventIndex: () => eventIndex,
  };
}

// ─── Agent State & Panel ──────────────────────────────────────────────

const agentState = {
  active: false,
  available: true,      // set to false if Agent SDK not configured
  unavailableReason: null,
  sessionHandle: null,  // { cancel, getSessionId }
  outputLines: [],      // accumulated output lines
  maxVisibleLines: 200, // show last N lines by default
  showFullLog: false,
  toolCount: 0,
};

function openAgentPanel(title) {
  // Close preview panel if open
  closePreview();

  const panel = document.getElementById('agent-panel');
  document.getElementById('agent-panel-title').textContent = title || 'Agent Output';
  document.getElementById('agent-panel-body').innerHTML = '';
  panel.classList.add('open');

  agentState.outputLines = [];
  agentState.showFullLog = false;
  agentState.toolCount = 0;

  updateAgentStatus('streaming', 'Streaming...');
  document.getElementById('agent-cancel-btn').style.display = '';
}

function closeAgentPanel() {
  if (agentState.active) {
    cancelAgent();
  }
  document.getElementById('agent-panel').classList.remove('open');
}

function updateAgentStatus(statusClass, text) {
  const dot = document.getElementById('agent-status-dot');
  const txt = document.getElementById('agent-status-text');
  dot.className = 'agent-status-dot ' + statusClass;
  txt.textContent = text;
}

function appendAgentOutput(text) {
  const body = document.getElementById('agent-panel-body');
  agentState.outputLines.push(text);

  // Render with line limit
  renderAgentBody();

  // Auto-scroll to bottom
  body.scrollTop = body.scrollHeight;
}

function appendAgentToolIndicator(toolName) {
  agentState.toolCount++;
  const body = document.getElementById('agent-panel-body');
  agentState.outputLines.push(`__TOOL__:${toolName}`);
  renderAgentBody();
  body.scrollTop = body.scrollHeight;
}

function renderAgentBody() {
  const body = document.getElementById('agent-panel-body');
  const lines = agentState.outputLines;
  const max = agentState.maxVisibleLines;

  let html = '';

  if (!agentState.showFullLog && lines.length > max) {
    const hidden = lines.length - max;
    html += `<button class="agent-show-full-toggle" onclick="toggleAgentFullLog()">Show full log (${hidden} earlier lines hidden)</button>`;
  }

  const visibleLines = agentState.showFullLog ? lines : lines.slice(-max);
  visibleLines.forEach(line => {
    if (line.startsWith('__TOOL__:')) {
      const name = line.slice(9);
      html += `<span class="agent-tool-indicator">Tool: ${esc(name)}</span>\n`;
    } else {
      html += esc(line) + '\n';
    }
  });

  body.innerHTML = html;
}

function toggleAgentFullLog() {
  agentState.showFullLog = !agentState.showFullLog;
  renderAgentBody();
}

async function invokeAgent(prompt, title, bpId = null) {
  if (!agentState.available) {
    // Show error in a new chat session
    const id = createChatSession(title || 'Agent');
    chatSessions[id].messages.push({
      role: 'system',
      content: 'Agent SDK is not available. ' + (agentState.unavailableReason || 'SDK not configured.') + ' Click the "Agent SDK offline" badge in the toolbar to configure.',
    });
    chatSessions[id].status = 'error';
    chatSessions[id].bpId = bpId;
    if (bpId) {
      embeddedChatState.activeBpId = bpId;
      embeddedChatState.activeSessionId = id;
      switchDetailTab('chat');
    } else {
      switchView('chat');
      switchChatSession(id);
    }
    return;
  }

  // Create a new chat session for this agent action
  const id = createChatSession(title || 'Agent Task');
  const session = chatSessions[id];
  session.bpId = bpId;

  // Add a system message showing the prompt being executed
  session.messages.push({
    role: 'user',
    content: prompt,
  });

  if (bpId) {
    // Embedded: stay on dashboard, open chat tab
    embeddedChatState.activeBpId = bpId;
    embeddedChatState.activeSessionId = id;
    switchDetailTab('chat');
  } else {
    // Standalone: switch to chat view
    switchView('chat');
    switchChatSession(id);
  }

  // Start streaming into this session
  chatStartStreaming(prompt, id);
}

async function cancelAgent() {
  if (!agentState.sessionHandle) return;
  await agentState.sessionHandle.cancel();
  agentState.active = false;
  agentState.sessionHandle = null;
  document.getElementById('agent-cancel-btn').style.display = 'none';
  updateAgentStatus('cancelled', 'Cancelled');
  appendAgentOutput('\n--- Cancelled by user ---');
  updateAllActionButtons();
}

async function refreshAfterAgent() {
  // Re-fetch briefings after agent completion (or periodically during agent work).
  // Always updates the data model regardless of current view. The view-specific
  // rendering happens when the user switches to that view (via switchView).
  invalidateCrpCache();
  try {
    const resp = await fetch('/api/briefings');
    if (resp.ok) {
      state.briefings = await resp.json();
      state.byId = {};
      state.briefings.forEach(bp => { state.byId[bp.id] = bp; });
      state.roots = state.briefings.filter(bp => !bp.parent).map(bp => bp.id);
      buildArtifactRegistry();

      // Refresh whichever view is currently active
      if (document.body.classList.contains('view-overview')) {
        await buildDashboardData();
        // Update queue selection if the selected BP moved to a different category
        if (queueState.selectedId) {
          const savedTab = queueState.detailTab;
          reselectAfterTransition(queueState.selectedId);
          queueState.detailTab = savedTab; // preserve active tab (e.g. chat during agent work)
        }
        renderOverview();
      } else if (document.body.classList.contains('view-dashboard')) {
        dashState.loaded = false;
        await fetchPhases();
      }
      // For chat/graph views: data is updated in state, will be used when
      // the user switches to overview/dashboard (switchView triggers render).
    }
  } catch {
    // Silently ignore refresh errors — data will be stale but the user can manually reload
  }
}

// ─── Inline BP Editor ────────────────────────────────────────────────

async function openBpEditor(bpId) {
  const editorEl = document.getElementById(`bp-editor-${bpId}`);
  if (!editorEl) return;
  editorEl.style.display = 'block';
  const ta = editorEl.querySelector('textarea');
  const saveBtn = editorEl.querySelector('.bp-editor-save');
  ta.value = 'Loading…';
  ta.disabled = true;
  saveBtn.disabled = true;

  try {
    const resp = await fetch(`/api/bp/${bpId}/raw`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    ta.value = data.content;
    ta.disabled = false;
    saveBtn.disabled = false;
    ta.focus();
  } catch (err) {
    ta.value = `Error loading content: ${err.message}`;
  }
}

async function saveBpEdit(bpId) {
  const editorEl = document.getElementById(`bp-editor-${bpId}`);
  if (!editorEl) return;
  const ta = editorEl.querySelector('textarea');
  const saveBtn = editorEl.querySelector('.bp-editor-save');
  const statusEl = editorEl.querySelector('.bp-editor-status');

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving\u2026';
  if (statusEl) statusEl.textContent = '';

  try {
    const resp = await fetch(`/api/bp/${bpId}/raw`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: ta.value }),
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({ detail: resp.statusText }));
      throw new Error(err.detail || resp.statusText);
    }
    saveBtn.textContent = 'Saved \u2713';
    if (statusEl) statusEl.textContent = 'Committed.';
    await fetchBriefings();
    await buildDashboardData();
    renderOverview();
  } catch (err) {
    saveBtn.textContent = 'Save & Commit';
    saveBtn.disabled = false;
    if (statusEl) statusEl.textContent = `Error: ${err.message}`;
  }
}

function toggleBpEditor(bpId) {
  const editorEl = document.getElementById(`bp-editor-${bpId}`);
  if (!editorEl) return;
  const isVisible = editorEl.style.display !== 'none' && editorEl.style.display !== '';
  if (isVisible) {
    editorEl.style.display = 'none';
  } else {
    openBpEditor(bpId);
  }
}

function renderBpEditorBlock(bpId) {
  return `<div id="bp-editor-${esc(bpId)}" style="display:none;padding:0 0 12px">
    <textarea style="width:100%;min-height:320px;background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:10px 12px;font-size:12px;font-family:monospace;color:var(--text);resize:vertical;outline:none;box-sizing:border-box"
      spellcheck="false"></textarea>
    <div style="display:flex;gap:8px;align-items:center;margin-top:6px">
      <button class="agent-action-btn bp-editor-save" onclick="saveBpEdit('${esc(bpId)}')"
        title="Write the file and create a git commit with your changes.">Save &amp; Commit</button>
      <button class="btn btn-outline btn-sm" onclick="toggleBpEditor('${esc(bpId)}')">Cancel</button>
      <span class="bp-editor-status" style="font-size:11px;color:var(--text-muted)"></span>
    </div>
  </div>`;
}

// ─── Action Button Helpers ────────────────────────────────────────────

/**
 * Check if a BP is dispatchable: status=ready and all dependencies met.
 */
function isDispatchable(bp) {
  if (!bp || bp.status !== 'ready') return false;
  // Only leaf BPs (no children) can be dispatched
  if (bp.children && bp.children.length > 0) return false;
  return (bp.depends_on || []).every(depId => isDependencyMet(depId));
}

/**
 * Check if a BP has a reviewable MRP: status=completed and has_mrp flag.
 * For Overview, we rely on status check; for Dashboard, child_details has has_mrp.
 */
function isReviewable(bp) {
  return bp && bp.status === 'completed';
}

/**
 * Status-transition helpers: determine which transitions are valid for a BP.
 */
function isApprovable(bp) {
  return bp && bp.status === 'draft' && (!bp.children || bp.children.length === 0);
}
function isCancellable(bp) {
  return bp && ['dispatched', 'claimed', 'in-progress', 'in_progress'].includes(bp.status);
}
function isCompletable(bp) {
  return bp && ['claimed', 'in-progress', 'in_progress'].includes(bp.status);
}
function isMarkReviewable(bp) {
  return bp && bp.status === 'completed';
}
function isArchivable(bp) {
  return bp && bp.status === 'reviewed';
}
function isUnapprovable(bp) {
  return bp && bp.status === 'ready' && (!bp.children || bp.children.length === 0);
}
function isResettable(bp) {
  return bp && bp.status === 'completed';
}
function isConfirmValidable(bp) {
  // Parent BPs derive a 'stale' status from children but have no own work to confirm.
  return bp && bp.status === 'stale' && (!bp.children || bp.children.length === 0);
}
function isStaleRevisable(bp) {
  return bp && bp.status === 'stale' && (!bp.children || bp.children.length === 0);
}

/**
 * Execute a deterministic BP state transition via the server API.
 * Shows a confirmation dialog, calls POST /api/bp/{id}/transition,
 * and refreshes data on success.
 */
async function transitionBP(bpId, action, event) {
  if (event) event.stopPropagation();
  const bp = state.byId[bpId];
  const title = bp ? (bp.title || bp.slug) : bpId;

  const labels = {
    approve: 'Approve', cancel: 'Cancel', release: 'Release',
    complete: 'Complete', review: 'Mark Reviewed', archive: 'Archive', restore: 'Restore',
    unapprove: 'Revert to Draft', reset: 'Reset to Ready',
    'confirm-valid': 'Confirm Valid', revise: 'Revise',
  };
  const label = labels[action] || action;

  // Confirmation
  let reason = null;
  if (action === 'release') {
    reason = prompt(`Release "${title}" back to ready.\n\nEnter a reason for releasing this BP:`);
    if (reason === null) return; // user cancelled
    if (!reason.trim()) { alert('A reason is required for the release action.'); return; }
    reason = reason.trim();
  } else if (action === 'revise') {
    reason = prompt(`Revise "${title}".\n\nThis bumps the revision and resets the BP to ready for re-execution.\nDirect dependents will be flagged as stale.\n\nEnter a reason for the revision:`);
    if (reason === null) return;
    if (!reason.trim()) { alert('A reason is required for the revise action.'); return; }
    reason = reason.trim();
  } else if (action === 'confirm-valid') {
    if (!confirm(`Confirm "${title}" is still valid?\n\nThis restores the prior status (completed/reviewed) and stops the stale cascade.`)) return;
  } else if (action === 'cancel') {
    if (!confirm(`Cancel "${title}"?\n\nThis will reset the BP to ready status and remove agent assignment.`)) return;
  } else if (action === 'archive') {
    if (!confirm(`Archive "${title}"?\n\nThis will move the BP tree to the archive directory.`)) return;
  } else if (action === 'complete') {
    if (!confirm(`Manually mark "${title}" as completed?\n\nThis is a manual override — normally the agent completes the BP.`)) return;
  } else if (action === 'review') {
    if (!confirm(`Mark "${title}" as reviewed?\n\nThis approves the BP without running the AI review agent.`)) return;
  } else if (action === 'unapprove') {
    if (!confirm(`Revert "${title}" to draft?\n\nThis will undo the approval.`)) return;
  } else if (action === 'reset') {
    if (!confirm(`Reset "${title}" to ready and discard all agent work?\n\nThis will delete the agent branch and worktree. This cannot be undone.`)) return;
  }

  // Find the button and show loading state
  const btn = event ? event.target.closest('button') : null;
  const origText = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = `${label}...`; }

  try {
    const body = { action };
    if (reason) body.reason = reason;
    const resp = await fetch(`/api/bp/${bpId}/transition`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      throw new Error(errText);
    }
    // Refresh data and re-select the BP in its new queue position
    await fetchBriefings();
    await buildDashboardData();
    reselectAfterTransition(bpId);
    renderOverview();
    // Also refresh Process view if visible
    if (document.body.classList.contains('view-dashboard')) {
      renderDashboard();
    }
    showToast(`${label}: ${title}`);
  } catch (err) {
    let msg = err.message;
    try { const parsed = JSON.parse(msg); msg = parsed.detail || msg; } catch {}
    alert(`${label} failed: ${msg}`);
    if (btn) { btn.disabled = false; btn.textContent = origText; }
  }
}

/**
 * After a BP status transition, find the BP's new position in the queue
 * and update queueState so the detail panel renders the correct view.
 */
function reselectAfterTransition(bpId) {
  const items = buildQueueItems();
  const match = items.find(item => item.id === bpId);
  if (match) {
    queueState.selectedType = match.type;
    queueState.selectedId = match.id;
    queueState.selectedIdx = match.idx;
    queueState.detailTab = null;
  } else {
    // BP no longer in any queue (archived, etc.) — select first item or clear
    if (items.length > 0) {
      queueState.selectedType = items[0].type;
      queueState.selectedId = items[0].id;
      queueState.selectedIdx = items[0].idx;
    } else {
      queueState.selectedType = null;
      queueState.selectedId = null;
      queueState.selectedIdx = null;
    }
    queueState.detailTab = null;
  }
}

/**
 * Show a brief toast notification at the bottom of the screen.
 */
function showToast(message, type) {
  const existing = document.getElementById('ace-toast');
  if (existing) existing.remove();
  const toast = document.createElement('div');
  toast.id = 'ace-toast';
  toast.textContent = message;
  const bg = type === 'error' ? '#ef4444' : 'var(--accent, #3b82f6)';
  Object.assign(toast.style, {
    position: 'fixed', bottom: '24px', left: '50%', transform: 'translateX(-50%)',
    background: bg, color: '#fff', padding: '8px 20px', borderRadius: '8px',
    fontSize: '13px', fontWeight: '500', zIndex: '10000', opacity: '0',
    transition: 'opacity 0.2s', pointerEvents: 'none',
  });
  document.body.appendChild(toast);
  requestAnimationFrame(() => { toast.style.opacity = '1'; });
  setTimeout(() => {
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 300);
  }, 2500);
}

/**
 * Render transition buttons appropriate for a BP's current status.
 * Returns an HTML string of buttons.
 */
function renderTransitionButtons(bpId) {
  const bp = state.byId[bpId];
  if (!bp) return '';
  let html = '';
  if (isApprovable(bp)) {
    html += `<button class="transition-btn approve-btn" onclick="transitionBP('${esc(bpId)}','approve',event)" title="Approve this BP: transitions from draft to ready.">Approve</button>`;
  }
  if (isUnapprovable(bp)) {
    html += `<button class="transition-btn unapprove-btn" onclick="transitionBP('${esc(bpId)}','unapprove',event)" title="Revert approval: move BP back to draft.">Revert to Draft</button>`;
  }
  if (isCancellable(bp)) {
    html += `<button class="transition-btn cancel-btn" onclick="transitionBP('${esc(bpId)}','cancel',event)" title="Cancel: reset BP to ready, remove agent assignment.">Cancel</button>`;
    html += `<button class="transition-btn release-btn" onclick="transitionBP('${esc(bpId)}','release',event)" title="Release: reset BP to ready with a reason (for stale locks).">Release</button>`;
  }
  if (isCompletable(bp)) {
    html += `<button class="transition-btn complete-btn" onclick="transitionBP('${esc(bpId)}','complete',event)" title="Manually mark BP as completed (override).">Complete</button>`;
  }
  if (isMarkReviewable(bp)) {
    html += `<button class="transition-btn mark-reviewed-btn" onclick="transitionBP('${esc(bpId)}','review',event)" title="Mark as reviewed without running the AI review agent.">Mark Reviewed</button>`;
  }
  if (isResettable(bp)) {
    html += `<button class="transition-btn reset-btn" onclick="transitionBP('${esc(bpId)}','reset',event)" title="Reset to ready: discard agent work and revert to ready status.">Reset to Ready</button>`;
  }
  if (isConfirmValidable(bp)) {
    html += `<button class="transition-btn confirm-valid-btn" onclick="transitionBP('${esc(bpId)}','confirm-valid',event)" title="Confirm prior work is still valid: restore the prior status (completed/reviewed) and stop the cascade.">Confirm Valid</button>`;
  }
  if (isStaleRevisable(bp)) {
    html += `<button class="transition-btn revise-btn" onclick="transitionBP('${esc(bpId)}','revise',event)" title="Revise: bump revision and reset to ready for re-execution.">Revise</button>`;
  }
  if (isArchivable(bp)) {
    html += `<button class="transition-btn archive-btn" onclick="transitionBP('${esc(bpId)}','archive',event)" title="Archive this reviewed BP tree.">Archive</button>`;
  }
  return html;
}

/**
 * CRP cache: stores CRP presence for BPs to avoid excessive fetching.
 */
const crpCache = {};

async function fetchCrpStatus(bpId) {
  if (crpCache[bpId] !== undefined) return crpCache[bpId];
  try {
    const resp = await fetch(`/api/crp/${bpId}`);
    crpCache[bpId] = resp.ok;
    return resp.ok;
  } catch {
    crpCache[bpId] = false;
    return false;
  }
}

function invalidateCrpCache() {
  Object.keys(crpCache).forEach(k => delete crpCache[k]);
}

/**
 * Update disabled state on all action buttons.
 * With multi-session support, buttons are only disabled if SDK is unavailable.
 */
function updateAllActionButtons() {
  const disabled = !agentState.available;
  document.querySelectorAll('.agent-action-btn').forEach(btn => {
    btn.disabled = disabled;
    if (!agentState.available) {
      btn.title = 'Agent SDK not available: ' + (agentState.unavailableReason || 'not configured');
      btn.style.opacity = '0.5';
    } else {
      btn.title = '';
      btn.style.opacity = '';
    }
  });
}

// ─── Agent SDK Configuration Dialog ──────────────────────────────────

function openAgentConfigDialog() {
  const overlay = document.getElementById('agent-config-overlay');
  overlay.style.display = 'flex';
  document.getElementById('agent-config-error').style.display = 'none';
  document.getElementById('agent-config-success').style.display = 'none';

  // Load current config from server
  fetch('/api/agent-config').then(r => r.json()).then(cfg => {
    const res = document.getElementById('cfg-foundry-resource');
    const key = document.getElementById('cfg-foundry-key');
    const model = document.getElementById('cfg-default-model');
    const useFoundry = document.getElementById('cfg-use-foundry');

    if (cfg.ANTHROPIC_FOUNDRY_RESOURCE) res.value = cfg.ANTHROPIC_FOUNDRY_RESOURCE;
    // Don't populate masked key values — leave empty so user can enter a new one
    key.value = '';
    key.placeholder = cfg.ANTHROPIC_FOUNDRY_API_KEY ? '(key is set — leave empty to keep)' : 'API key';
    if (cfg.ANTHROPIC_DEFAULT_SONNET_MODEL) model.value = cfg.ANTHROPIC_DEFAULT_SONNET_MODEL;
    useFoundry.checked = cfg.CLAUDE_CODE_USE_FOUNDRY === '1';
  }).catch(() => { /* ignore — fields keep defaults */ });
}

function closeAgentConfigDialog() {
  document.getElementById('agent-config-overlay').style.display = 'none';
}

async function saveAgentConfig() {
  const resource = document.getElementById('cfg-foundry-resource').value.trim();
  const key = document.getElementById('cfg-foundry-key').value.trim();
  const model = document.getElementById('cfg-default-model').value.trim();
  const useFoundry = document.getElementById('cfg-use-foundry').checked;

  const errEl = document.getElementById('agent-config-error');
  const okEl = document.getElementById('agent-config-success');
  errEl.style.display = 'none';
  okEl.style.display = 'none';

  // Build payload — only include non-empty values
  const payload = {};
  if (useFoundry) payload.CLAUDE_CODE_USE_FOUNDRY = '1';
  if (resource) payload.ANTHROPIC_FOUNDRY_RESOURCE = resource;
  if (key) payload.ANTHROPIC_FOUNDRY_API_KEY = key;
  if (model) payload.ANTHROPIC_DEFAULT_SONNET_MODEL = model;

  if (!Object.keys(payload).length) {
    errEl.textContent = 'Please fill in at least the Resource Name and API Key.';
    errEl.style.display = 'block';
    return;
  }

  const btn = document.getElementById('cfg-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const resp = await fetch('/api/agent-config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();
    if (result.agent_available) {
      agentState.available = true;
      agentState.unavailableReason = null;
      updateAllActionButtons();
      const badge = document.getElementById('agent-availability-badge');
      badge.style.display = 'none';
      okEl.textContent = 'Agent SDK connected successfully.';
      okEl.style.display = 'block';
      setTimeout(() => closeAgentConfigDialog(), 1200);
    } else {
      errEl.textContent = result.agent_unavailable_reason || 'Configuration saved but agent is still unavailable.';
      errEl.style.display = 'block';
    }
  } catch (e) {
    errEl.textContent = 'Failed to save configuration: ' + e.message;
    errEl.style.display = 'block';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save & Connect';
  }
}

/**
 * Build the agent execution prompt from dispatch data.
 * Mirrors what /dispatch Step 5 assembles in the CLI.
 */
function buildAgentExecPrompt(d) {
  let prompt = `# Agent Execution — bp:${d.bp_hash.slice(0, 6)} (${d.slug})\n\n`;
  prompt += `You are agent **${d.agent_id}** executing a BriefingPack.\n\n`;
  prompt += `## Your Worktree\n\n`;
  prompt += `Work exclusively in the agent worktree: \`${d.worktree_path}/\`\n`;
  prompt += `Branch: \`${d.branch}\`\n`;
  prompt += `All commits and file changes MUST happen inside this worktree. `;
  prompt += `Do NOT modify files on main.\n\n`;

  prompt += `## BriefingPack\n\n`;
  prompt += `\`\`\`\n${d.bp_content}\n\`\`\`\n\n`;

  prompt += `## LoopScript (${d.resolved_loopscript})\n\n`;
  prompt += `Follow these phases **sequentially**. Pass each gate before proceeding.\n\n`;
  prompt += `\`\`\`yaml\n${d.loopscript_content}\n\`\`\`\n\n`;

  if (d.mentorscript_refs && d.mentorscript_refs.length > 0) {
    prompt += `## MentorScripts\n\n`;
    prompt += `Respect all rules from these MentorScripts:\n\n`;
    for (const ref of d.mentorscript_refs) {
      const content = d.mentorscript_contents[ref];
      if (content) {
        prompt += `### ${ref}\n\n\`\`\`\n${content}\n\`\`\`\n\n`;
      }
    }
  }

  prompt += `## Execution Rules\n\n`;
  prompt += `- Follow the LoopScript phases sequentially\n`;
  prompt += `- Create CRPs when escalation triggers fire (see CLAUDE.md CRP Rules)\n`;
  prompt += `- Commit and push progress from the worktree after each phase\n`;
  prompt += `- Use \`python3 scripts/bp-transition.py complete ${d.bp_hash}\` to set status when done\n`;
  prompt += `- Produce an MRP (Mission Review Protocol) upon completion\n`;

  return prompt;
}

async function dispatchBP(bpId, event) {
  if (event) event.stopPropagation();
  const bp = state.byId[bpId];
  const title = bp ? (bp.title || bp.slug) : bpId;

  // Step 1: Full server-side dispatch orchestration
  // (validate → transition → worktree → bp-info)
  let dispatchData;
  try {
    const resp = await fetch(`/api/bp/${bpId}/dispatch`, { method: 'POST' });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      let msg = errText;
      try { msg = JSON.parse(errText).detail || msg; } catch {}
      throw new Error(msg);
    }
    dispatchData = await resp.json();
  } catch (err) {
    alert(`Dispatch failed: ${err.message}`);
    return;
  }

  // Step 2: Build execution prompt (same context as /dispatch Step 5)
  const execPrompt = buildAgentExecPrompt(dispatchData);

  // Step 3: Start agent as detached background task
  try {
    const resp = await fetch('/api/agent/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: execPrompt }),
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => `HTTP ${resp.status}`);
      throw new Error(errText);
    }
    const result = await resp.json();
    const sessionId = result.session_id;

    // Create chat session linked to this BP
    const chatId = createChatSession(`Dispatch: ${title}`);
    const session = chatSessions[chatId];
    session.bpId = bpId;
    // Show a concise summary in chat, not the full prompt
    session.messages.push({ role: 'user', content:
      `Dispatch bp:${dispatchData.bp_hash.slice(0, 6)} (${dispatchData.slug})\n`
      + `Agent: ${dispatchData.agent_id} | Branch: ${dispatchData.branch}\n`
      + `LoopScript: ${dispatchData.resolved_loopscript} | Mode: ${dispatchData.execution_mode}` });
    session.detachedSessionId = sessionId;

    // Stay on dashboard — open embedded chat tab
    embeddedChatState.activeBpId = bpId;
    embeddedChatState.activeSessionId = chatId;
    switchDetailTab('chat');

    // Attach to the event stream (reconnect-capable)
    attachToDetachedSession(sessionId, chatId, 0);

    // Refresh dashboard to show new status
    await fetchBriefings();
    await buildDashboardData();
    reselectAfterTransition(bpId);
    queueState.detailTab = 'chat'; // preserve chat tab opened during dispatch
    renderOverview();
    showToast(`Dispatched: ${title} → agent ${dispatchData.agent_id}`);
  } catch (err) {
    console.error('Agent start failed:', err);
    // Status was already transitioned — refresh to show it
    await fetchBriefings();
    await buildDashboardData();
    reselectAfterTransition(bpId);
    renderOverview();
  }
}

/**
 * Attach to a detached agent session's event stream.
 * Supports reconnect via offset parameter.
 */
function attachToDetachedSession(sessionId, chatId, offset) {
  const session = chatSessions[chatId];
  if (!session) return;

  session.isStreaming = true;
  session.status = 'streaming';

  // Helper: render to whichever view this session is visible in
  const renderVisible = () => {
    const vis = isSessionVisible(chatId);
    if (vis === 'standalone') renderChatMessages();
    else if (vis === 'embedded') renderEmbeddedChatMessages();
  };
  const updateVisibleControls = () => {
    const vis = isSessionVisible(chatId);
    if (vis === 'standalone') updateChatControls();
    else if (vis === 'embedded') updateEmbeddedChatControls();
  };

  updateVisibleControls();
  renderChatSidebar();
  updateEmbeddedSessionBarStatus();

  // Create assistant message placeholder if needed (interleaved format)
  if (session.currentAssistantIdx === null || session.currentAssistantIdx === undefined) {
    const assistantMsg = { role: 'assistant', contentBlocks: [{ type: 'text', text: '' }], systemEvents: [] };
    session.messages.push(assistantMsg);
    session.currentAssistantIdx = session.messages.length - 1;
  }
  renderVisible();

  let hasReceivedText = false;

  // Helper to get current text length across all text blocks
  const getTotalTextLength = (msg) => {
    if (!msg.contentBlocks) return (msg.content || '').length;
    return msg.contentBlocks.filter(b => b.type === 'text').reduce((sum, b) => sum + b.text.length, 0);
  };

  const bgRefreshInterval = setInterval(() => {
    if (!session.isStreaming) {
      clearInterval(bgRefreshInterval);
      return;
    }
    refreshAfterAgent();
  }, 10000);

  const handle = sseClient(`/api/agent/sessions/${sessionId}/events?offset=${offset}`, null, {
    onMessage: (text) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (!msg) return;
      const totalLen = getTotalTextLength(msg);
      if (hasReceivedText && text.length >= totalLen && totalLen > 0) return;
      hasReceivedText = true;
      if (msg.contentBlocks) {
        const lastText = msg.contentBlocks.filter(b => b.type === 'text').pop();
        if (lastText) lastText.text += text;
      } else {
        msg.content = (msg.content || '') + text;
      }
      renderVisible();
    },
    onToolUse: (toolInfo) => {
      hasReceivedText = false;
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        if (msg.contentBlocks) {
          msg.contentBlocks.push({ type: 'tool', name: toolInfo.name, toolId: toolInfo.toolId || '', input: toolInfo.input || null, result: null });
          msg.contentBlocks.push({ type: 'text', text: '' });
        } else {
          if (!msg.toolBlocks) msg.toolBlocks = [];
          msg.toolBlocks.push({ name: toolInfo.name, toolId: toolInfo.toolId || '', input: toolInfo.input || null, result: null });
        }
        renderVisible();
      }
    },
    onToolResult: (resultInfo) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        const toolBlocks = msg.contentBlocks
          ? msg.contentBlocks.filter(b => b.type === 'tool')
          : (msg.toolBlocks || []);
        const tb = toolBlocks.slice().reverse().find(b => b.toolId && b.toolId === resultInfo.toolId);
        if (tb) { tb.result = resultInfo.content; }
        else if (toolBlocks.length > 0) {
          const fallback = toolBlocks.slice().reverse().find(b => !b.result);
          if (fallback) fallback.result = resultInfo.content;
        }
        renderVisible();
      }
    },
    onResult: () => {
      // Result is a recap — don't append text. Session ID captured by sseClient.
    },
    onSystem: (data) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        msg.systemEvents.push(data);
        renderVisible();
      }
    },
    onComplete: () => {
      clearInterval(bgRefreshInterval);
      session.isStreaming = false;
      session.streamHandle = null;
      session.currentAssistantIdx = null;
      session.status = 'done';
      updateVisibleControls();
      renderVisible();
      renderChatSidebar();
      updateEmbeddedSessionBarStatus();
      updateAllActionButtons();
      refreshAfterAgent();
    },
    onError: (err) => {
      clearInterval(bgRefreshInterval);
      const currentOffset = handle.getEventIndex ? handle.getEventIndex() + offset : offset;

      // Auto-reconnect after 3 seconds (agent is still running server-side)
      console.warn(`SSE disconnected for session ${sessionId}, reconnecting in 3s (offset=${currentOffset})...`);
      session.status = 'reconnecting';
      renderChatSidebar();
      updateEmbeddedSessionBarStatus();

      setTimeout(async () => {
        // Check if session is still active before reconnecting
        try {
          const resp = await fetch(`/api/agent/sessions/${sessionId}`);
          if (resp.ok) {
            const info = await resp.json();
            if (info.status === 'active') {
              attachToDetachedSession(sessionId, chatId, currentOffset);
              return;
            }
            // Session finished while disconnected
            session.status = info.status === 'completed' ? 'done' : 'error';
          } else {
            session.status = 'error';
          }
        } catch {
          session.status = 'error';
        }
        session.isStreaming = false;
        session.streamHandle = null;
        updateVisibleControls();
        renderVisible();
        renderChatSidebar();
        updateEmbeddedSessionBarStatus();
        updateAllActionButtons();
        refreshAfterAgent();
      }, 3000);
    },
  });

  session.streamHandle = handle;
}

function reviewMrpAgent(bpId, event) {
  if (event) event.stopPropagation();
  const bp = state.byId[bpId];
  const title = bp ? (bp.title || bp.slug) : bpId;
  invokeAgent(`/ace:review-mrp ${bpId}`, `Review: ${title}`, bpId);
}

function resolveCrpAgent(bpId, event) {
  if (event) event.stopPropagation();
  const input = document.getElementById(`crp-input-${bpId}`);
  const response = input ? input.value.trim() : '';
  if (!response) {
    input && input.focus();
    return;
  }
  const bp = state.byId[bpId];
  const title = bp ? (bp.title || bp.slug) : bpId;
  invokeAgent(`/ace:resolve-crp ${bpId} --response "${response}"`, `Resolve CRP: ${title}`, bpId);
}

// ─── Shared App State (cross-view) ────────────────────────────────────

const appState = {
  selectedBpId: null,  // Currently selected BP across views (for context injection)
};

/**
 * Set the selected BP for cross-view context (AC-4).
 * Called from dashboard and overview click handlers.
 */
function setSelectedBp(bpId) {
  appState.selectedBpId = bpId || null;
  updateChatBpContext();
}

// ─── Multi-Session Chat State & Logic ─────────────────────────────────

/**
 * Multi-session management: each session is an independent chat/agent conversation.
 * Sessions are stored in chatSessions map, keyed by a local ID.
 * activeChatId points to the currently displayed session.
 */
const chatSessions = {};      // { [localId]: { id, title, messages, sessionId, isStreaming, streamHandle, currentAssistantIdx, createdAt, status } }
let activeChatId = null;      // localId of the currently displayed session
let chatSessionCounter = 0;   // auto-increment for generating local IDs
const MAX_VISIBLE_MESSAGES = 100;

function createChatSession(title) {
  chatSessionCounter++;
  const localId = 'chat-' + chatSessionCounter;
  chatSessions[localId] = {
    id: localId,
    title: title || 'New conversation',
    messages: [],
    sessionId: null,       // SDK session ID for multi-turn
    isStreaming: false,
    streamHandle: null,
    currentAssistantIdx: null,
    createdAt: Date.now(),
    status: 'idle',        // idle | streaming | done | error
    bpId: null,            // BP ID for embedded chat association (null = general)
  };
  return localId;
}

function getActiveSession() {
  return activeChatId ? chatSessions[activeChatId] : null;
}

/**
 * Switch to a chat session by localId. Re-renders sidebar and messages.
 */
function switchChatSession(localId) {
  if (!chatSessions[localId]) return;
  activeChatId = localId;
  renderChatSidebar();
  renderChatMessages();
  updateChatControls();
  updateChatBpContext();
  const textarea = document.getElementById('chat-textarea');
  if (textarea) requestAnimationFrame(() => textarea.focus());
}

// Legacy compat shim: expose chatState-like object for renderChatMessages / updateChatControls
function _chatState() {
  const s = getActiveSession();
  if (!s) return { messages: [], sessionId: null, isStreaming: false, streamHandle: null, currentAssistantIdx: null, maxVisibleMessages: MAX_VISIBLE_MESSAGES };
  return { messages: s.messages, sessionId: s.sessionId, isStreaming: s.isStreaming, streamHandle: s.streamHandle, currentAssistantIdx: s.currentAssistantIdx, maxVisibleMessages: MAX_VISIBLE_MESSAGES };
}
// Keep chatState as a getter-proxy so existing render code works
const chatState = new Proxy({}, {
  get(_, prop) { return _chatState()[prop]; },
  set(_, prop, val) {
    const s = getActiveSession();
    if (s) s[prop] = val;
    return true;
  }
});

// ─── Embedded Chat State & Functions ──────────────────────────────────

const embeddedChatState = {
  activeBpId: null,       // which BP's chat tab is visible
  activeSessionId: null,  // which session is active within embedded chat
};

/**
 * Get all chat sessions associated with a specific BP, sorted newest first.
 */
function getBpChatSessions(bpId) {
  return Object.values(chatSessions)
    .filter(s => s.bpId === bpId)
    .sort((a, b) => b.createdAt - a.createdAt);
}

/**
 * Determine where a session is currently visible.
 * Returns 'standalone', 'embedded', or null.
 */
function isSessionVisible(chatId) {
  if (chatId === activeChatId && document.body.classList.contains('view-chat')) return 'standalone';
  const session = chatSessions[chatId];
  if (session && session.bpId === embeddedChatState.activeBpId
      && chatId === embeddedChatState.activeSessionId
      && document.body.classList.contains('view-overview')) return 'embedded';
  return null;
}

/**
 * Generate HTML for the embedded chat tab content.
 */
function renderEmbeddedChatTab(bpId) {
  const sessions = getBpChatSessions(bpId);

  let html = `<div class="embedded-chat-container" data-bpid="${esc(bpId)}">`;

  if (sessions.length === 0) {
    html += `<div class="embedded-chat-empty">
      <div style="font-size: 28px; opacity: 0.3;">&#x2B21;</div>
      <p>No chat sessions for this BP yet.</p>
      <button class="embedded-chat-start-btn" onclick="embeddedChatNewSession('${esc(bpId)}')">Start Conversation</button>
    </div>`;
    html += `</div>`;
    return html;
  }

  // Session bar
  html += renderEmbeddedSessionBar(bpId);

  // Messages area
  html += `<div class="embedded-chat-messages" id="embedded-chat-messages"></div>`;

  // Input area
  html += `<div class="embedded-chat-input">
    <textarea id="embedded-chat-textarea" placeholder="Message the agent..." rows="1"
      onkeydown="embeddedChatKeydown(event)"
      oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"></textarea>
    <button class="embedded-chat-send-btn" id="embedded-chat-send-btn" onclick="embeddedChatSendMessage()">Send</button>
    <button class="embedded-chat-stop-btn" id="embedded-chat-stop-btn" style="display:none" onclick="embeddedChatStopStreaming()">Stop</button>
  </div>`;

  html += `</div>`;
  return html;
}

/**
 * Render the horizontal session bar for embedded chat.
 */
function renderEmbeddedSessionBar(bpId) {
  const sessions = getBpChatSessions(bpId);
  let html = `<div class="embedded-chat-session-bar">`;

  for (const s of sessions) {
    const isActive = s.id === embeddedChatState.activeSessionId;
    const dotClass = s.status === 'streaming' ? 'streaming' : s.status === 'done' ? 'done' : s.status === 'error' ? 'error' : '';
    const label = s.title.length > 28 ? s.title.substring(0, 25) + '...' : s.title;
    html += `<button class="embedded-session-chip${isActive ? ' active' : ''}" onclick="switchEmbeddedSession('${esc(s.id)}')">
      <span class="embedded-session-dot ${dotClass}"></span>
      ${esc(label)}
    </button>`;
  }

  html += `<button class="embedded-chat-new-btn" onclick="embeddedChatNewSession('${esc(bpId)}')" title="New conversation">+</button>`;

  // Pop-out button
  if (embeddedChatState.activeSessionId) {
    html += `<button class="embedded-chat-popout" onclick="popOutEmbeddedChat('${esc(embeddedChatState.activeSessionId)}')" title="Open in full Chat view">&#x2197; Pop out</button>`;
  }

  html += `</div>`;
  return html;
}

/**
 * Render messages into the embedded chat container.
 */
function renderEmbeddedChatMessages() {
  const container = document.getElementById('embedded-chat-messages');
  if (!container) return;

  const sessionId = embeddedChatState.activeSessionId;
  const session = sessionId ? chatSessions[sessionId] : null;
  if (!session) {
    container.innerHTML = '';
    return;
  }

  const msgs = session.messages;
  const startIdx = Math.max(0, msgs.length - MAX_VISIBLE_MESSAGES);

  let html = '';
  if (startIdx > 0) {
    html += `<div style="text-align:center;font-size:11px;color:var(--text-muted);padding:8px 0;">${startIdx} earlier message${startIdx > 1 ? 's' : ''} hidden</div>`;
  }
  for (let i = startIdx; i < msgs.length; i++) {
    html += renderSingleMessage(msgs[i], i);
  }
  const wasNearBottom = isScrolledNearBottom(container);
  container.innerHTML = html;

  // Smart auto-scroll: only if user was near bottom
  if (wasNearBottom) {
    requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
  }
}

/**
 * Update send/stop button visibility in embedded chat.
 */
function updateEmbeddedChatControls() {
  const sessionId = embeddedChatState.activeSessionId;
  const session = sessionId ? chatSessions[sessionId] : null;
  const isStreaming = session?.isStreaming || false;

  const sendBtn = document.getElementById('embedded-chat-send-btn');
  const stopBtn = document.getElementById('embedded-chat-stop-btn');
  const textarea = document.getElementById('embedded-chat-textarea');
  if (sendBtn) sendBtn.style.display = isStreaming ? 'none' : '';
  if (stopBtn) stopBtn.style.display = isStreaming ? '' : 'none';
  if (textarea) {
    textarea.disabled = isStreaming;
    textarea.placeholder = isStreaming ? 'Waiting for response...' : 'Message the agent...';
  }
}

/**
 * Initialize the embedded chat for a BP — select best session and render.
 */
function initEmbeddedChat(bpId) {
  embeddedChatState.activeBpId = bpId;

  const sessions = getBpChatSessions(bpId);
  if (sessions.length > 0) {
    // Prefer streaming session, then most recent
    const streaming = sessions.find(s => s.isStreaming);
    embeddedChatState.activeSessionId = streaming ? streaming.id : sessions[0].id;
  } else {
    embeddedChatState.activeSessionId = null;
  }

  renderEmbeddedChatMessages();
  updateEmbeddedChatControls();
}

/**
 * Switch which session is displayed in the embedded chat.
 */
function switchEmbeddedSession(sessionId) {
  embeddedChatState.activeSessionId = sessionId;

  // Re-render session bar to update active state
  const bpId = embeddedChatState.activeBpId;
  if (bpId) {
    const barContainer = document.querySelector('.embedded-chat-session-bar');
    if (barContainer) {
      barContainer.outerHTML = renderEmbeddedSessionBar(bpId);
    }
  }

  renderEmbeddedChatMessages();
  updateEmbeddedChatControls();
  const textarea = document.getElementById('embedded-chat-textarea');
  if (textarea) requestAnimationFrame(() => textarea.focus());
}

/**
 * Create a new chat session scoped to a BP and switch to it.
 */
function embeddedChatNewSession(bpId) {
  const bp = state.byId[bpId];
  const title = bp ? `Chat: ${bp.title || bp.slug}` : `Chat: ${bpId}`;
  const chatId = createChatSession(title);
  chatSessions[chatId].bpId = bpId;

  embeddedChatState.activeBpId = bpId;
  embeddedChatState.activeSessionId = chatId;

  // Re-render the full tab content to show session bar + input (was empty state before)
  const tabContent = document.querySelector('.detail-tab-content[data-tab="chat"]');
  if (tabContent) {
    tabContent.innerHTML = renderEmbeddedChatTab(bpId);
    // Re-init after replacing content
    renderEmbeddedChatMessages();
    updateEmbeddedChatControls();
    const textarea = document.getElementById('embedded-chat-textarea');
    if (textarea) requestAnimationFrame(() => textarea.focus());
  }
}

/**
 * Send a message from the embedded chat input.
 */
async function embeddedChatSendMessage() {
  const textarea = document.getElementById('embedded-chat-textarea');
  if (!textarea) return;
  const prompt = textarea.value.trim();
  if (!prompt) return;

  let sessionId = embeddedChatState.activeSessionId;
  const bpId = embeddedChatState.activeBpId;

  // Create session if none exists
  if (!sessionId) {
    embeddedChatNewSession(bpId);
    sessionId = embeddedChatState.activeSessionId;
  }

  const session = chatSessions[sessionId];
  if (!session) return;

  // Add user message
  session.messages.push({ role: 'user', content: prompt });
  textarea.value = '';
  textarea.style.height = 'auto';
  renderEmbeddedChatMessages();

  // Add assistant placeholder (interleaved format)
  const assistantMsg = { role: 'assistant', contentBlocks: [{ type: 'text', text: '' }], systemEvents: [] };
  session.messages.push(assistantMsg);
  session.currentAssistantIdx = session.messages.length - 1;
  session.isStreaming = true;
  session.status = 'streaming';
  updateEmbeddedChatControls();
  updateEmbeddedSessionBarStatus();

  // Inject BP context
  let fullPrompt = prompt;
  if (bpId && state.byId[bpId]) {
    const bp = state.byId[bpId];
    fullPrompt = `[Context: Currently working on BP "${bp.title}" (${bp.id}), status: ${bp.status}]\n\n${prompt}`;
  }

  // Build request
  const body = { prompt: fullPrompt };
  if (session.sessionId) body.session_id = session.sessionId;

  const handle = sseClient('/api/agent/invoke', body, {
    onMessage: (text) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg && msg.contentBlocks) {
        const lastText = msg.contentBlocks.filter(b => b.type === 'text').pop();
        if (lastText) lastText.text += text;
      }
      if (isSessionVisible(sessionId) === 'embedded') renderEmbeddedChatMessages();
    },
    onToolUse: (info) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg && msg.contentBlocks) {
        msg.contentBlocks.push({ type: 'tool', name: info.name, toolId: info.id || '', input: info.input, result: null });
        msg.contentBlocks.push({ type: 'text', text: '' });
      }
      if (isSessionVisible(sessionId) === 'embedded') renderEmbeddedChatMessages();
    },
    onToolResult: (result) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg && msg.contentBlocks) {
        const toolBlocks = msg.contentBlocks.filter(b => b.type === 'tool');
        const tb = toolBlocks.slice().reverse().find(b => !b.result);
        if (tb) tb.result = result.content;
      }
      if (isSessionVisible(sessionId) === 'embedded') renderEmbeddedChatMessages();
    },
    onResult: () => { /* recap — no action needed */ },
    onSystem: (data) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        if (!msg.systemEvents) msg.systemEvents = [];
        msg.systemEvents.push(data);
      }
    },
    onComplete: () => {
      session.isStreaming = false;
      session.status = 'done';
      session.currentAssistantIdx = null;
      const sid = handle.getSessionId();
      if (sid) session.sessionId = sid;
      if (isSessionVisible(sessionId) === 'embedded') {
        updateEmbeddedChatControls();
        renderEmbeddedChatMessages();
      }
      updateEmbeddedSessionBarStatus();
    },
    onError: (err) => {
      session.isStreaming = false;
      session.status = 'error';
      session.currentAssistantIdx = null;
      session.messages.push({ role: 'system', content: `Error: ${err}` });
      if (isSessionVisible(sessionId) === 'embedded') {
        updateEmbeddedChatControls();
        renderEmbeddedChatMessages();
      }
      updateEmbeddedSessionBarStatus();
    },
  });

  session.streamHandle = handle;
}

/**
 * Handle keydown in embedded chat textarea.
 */
function embeddedChatKeydown(event) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    embeddedChatSendMessage();
  }
  if (event.key === 'Escape') {
    const session = embeddedChatState.activeSessionId ? chatSessions[embeddedChatState.activeSessionId] : null;
    if (session?.isStreaming) {
      embeddedChatStopStreaming();
    }
  }
}

/**
 * Stop streaming in embedded chat.
 */
function embeddedChatStopStreaming() {
  const sessionId = embeddedChatState.activeSessionId;
  const session = sessionId ? chatSessions[sessionId] : null;
  if (session?.streamHandle) {
    session.streamHandle.cancel();
    session.isStreaming = false;
    session.status = 'done';
    session.currentAssistantIdx = null;
    session.streamHandle = null;
    updateEmbeddedChatControls();
    updateEmbeddedSessionBarStatus();
  }
}

/**
 * Update session bar dot statuses without full re-render.
 */
function updateEmbeddedSessionBarStatus() {
  const bar = document.querySelector('.embedded-chat-session-bar');
  if (!bar) return;
  const bpId = embeddedChatState.activeBpId;
  if (bpId) bar.outerHTML = renderEmbeddedSessionBar(bpId);
}

/**
 * Pop out the embedded chat session to the standalone Chat view.
 */
function popOutEmbeddedChat(sessionId) {
  activeChatId = sessionId;
  switchView('chat');
  renderChatSidebar();
  renderChatMessages();
  updateChatControls();
}

/**
 * Format a tool call summary in Claude Code CLI style.
 * Returns { icon, summary } for the collapsed one-liner.
 */
function formatToolSummary(name, input) {
  const i = input || {};
  switch (name) {
    case 'Read': {
      const p = i.file_path || '';
      const short = p.split('/').slice(-2).join('/');
      return { icon: '\u{1F4C4}', summary: `Read ${short}` };
    }
    case 'Edit': {
      const p = i.file_path || '';
      const short = p.split('/').slice(-2).join('/');
      return { icon: '\u270F\uFE0F', summary: `Edit ${short}` };
    }
    case 'Write': {
      const p = i.file_path || '';
      const short = p.split('/').slice(-2).join('/');
      return { icon: '\u{1F4DD}', summary: `Write ${short}` };
    }
    case 'Bash': {
      const cmd = (i.command || '').slice(0, 100);
      return { icon: '\u{1F4BB}', summary: `$ ${cmd}${(i.command || '').length > 100 ? '…' : ''}` };
    }
    case 'Grep': {
      const pat = i.pattern || '';
      const p = i.path ? ' in ' + i.path.split('/').slice(-2).join('/') : '';
      return { icon: '\u{1F50D}', summary: `Search: ${pat}${p}` };
    }
    case 'Glob': {
      const pat = i.pattern || '';
      return { icon: '\u{1F4C1}', summary: `Find files: ${pat}` };
    }
    case 'Agent': {
      const desc = i.description || (i.prompt || '').slice(0, 60);
      return { icon: '\u{1F916}', summary: `Agent: ${desc}` };
    }
    case 'WebSearch': {
      const q = i.query || '';
      return { icon: '\u{1F310}', summary: `Web search: ${q}` };
    }
    case 'WebFetch': {
      const u = i.url || '';
      return { icon: '\u{1F310}', summary: `Fetch: ${u.slice(0, 80)}` };
    }
    case 'TodoWrite': return { icon: '\u2705', summary: 'Update todos' };
    case 'TodoRead': return { icon: '\u{1F4CB}', summary: 'Read todos' };
    case 'Skill': return { icon: '\u26A1', summary: `Skill: ${i.skill || i.name || ''}` };
    default: return { icon: '\u{1F527}', summary: name };
  }
}

/**
 * Render a single tool block as a collapsible details element (Claude Code style).
 */
function renderToolBlock(tb) {
  const hasContent = tb.input || tb.result;
  const isPending = !tb.result;
  const { icon, summary } = formatToolSummary(tb.name, tb.input);
  const pendingClass = isPending ? ' chat-tool-pending' : ' chat-tool-done';

  let html = `<details class="chat-tool-block${pendingClass}">`;
  html += `<summary><span class="chat-tool-icon">${icon}</span> <span class="chat-tool-summary">${esc(summary)}</span>`;
  if (isPending && hasContent) {
    html += ` <span class="chat-tool-spinner"></span>`;
  } else if (!hasContent) {
    html += ` <span class="chat-tool-spinner"></span>`;
  } else {
    html += ` <span class="chat-tool-check">\u2713</span>`;
  }
  html += `</summary>`;
  html += `<div class="chat-tool-block-body">`;
  if (tb.input) {
    html += `<div style="margin-bottom:4px;color:var(--accent);font-weight:600;font-size:11px">Input</div>`;
    html += `<pre style="margin:0 0 8px 0;white-space:pre-wrap;word-break:break-word;font-size:11px">${esc(typeof tb.input === 'string' ? tb.input : JSON.stringify(tb.input, null, 2))}</pre>`;
  }
  if (tb.result) {
    html += `<div style="margin-bottom:4px;color:var(--accent);font-weight:600;font-size:11px">Result</div>`;
    const resultText = typeof tb.result === 'string' ? tb.result : JSON.stringify(tb.result, null, 2);
    const maxLen = 2000;
    html += `<pre style="margin:0;white-space:pre-wrap;word-break:break-word;font-size:11px">${resultText.length > maxLen ? esc(resultText.slice(0, maxLen)) + '\n… (truncated)' : esc(resultText)}</pre>`;
  }
  if (!hasContent) {
    html += `<div style="color:var(--text-muted);font-style:italic;font-size:11px">Waiting for tool response…</div>`;
  }
  html += `</div></details>`;
  return html;
}

/**
 * Get the plain text content from a message, regardless of whether it uses
 * the new contentBlocks format or the legacy content string format.
 */
function getMsgText(msg) {
  if (msg.contentBlocks) {
    return msg.contentBlocks.filter(b => b.type === 'text').map(b => b.text).join('');
  }
  return msg.content || '';
}

function renderSingleMessage(msg, actualIdx) {
  let html = `<div class="chat-msg ${esc(msg.role)}">`;
  html += `<div class="chat-msg-inner">`;

  if (msg.role === 'user') {
    html += `<div class="chat-bubble">${esc(msg.content || getMsgText(msg))}</div>`;
  } else if (msg.role === 'assistant') {
    let bubbleContent = '';

    // Use contentBlocks if available (new interleaved format)
    if (msg.contentBlocks && msg.contentBlocks.length > 0) {
      msg.contentBlocks.forEach(block => {
        if (block.type === 'text' && block.text) {
          bubbleContent += renderMarkdown(block.text);
        } else if (block.type === 'tool') {
          bubbleContent += renderToolBlock(block);
        }
      });
    } else {
      // Legacy fallback: content string + toolBlocks array
      bubbleContent = renderMarkdown(msg.content || '');
      if (msg.toolBlocks && msg.toolBlocks.length > 0) {
        msg.toolBlocks.forEach(tb => bubbleContent += renderToolBlock(tb));
      }
    }

    // System events (collapsed)
    if (msg.systemEvents && msg.systemEvents.length > 0) {
      bubbleContent += `<details class="chat-tool-block" style="border-color:var(--border)">`;
      bubbleContent += `<summary style="color:var(--text-muted)">\u2699\uFE0F System Events (${msg.systemEvents.length})</summary>`;
      bubbleContent += `<div class="chat-tool-block-body">`;
      msg.systemEvents.forEach(evt => {
        const subtype = evt.subtype || evt.type || 'system';
        const text = evt.text || evt.data?.hook_name || JSON.stringify(evt);
        bubbleContent += `<div style="margin-bottom:4px"><span style="color:var(--accent);font-weight:600">${esc(subtype)}</span>: ${esc(typeof text === 'string' ? text : JSON.stringify(text))}</div>`;
      });
      bubbleContent += `</div></details>`;
    }

    // Streaming cursor — only on the last text block
    if (chatState.isStreaming && actualIdx === chatState.currentAssistantIdx) {
      bubbleContent += '<span class="chat-streaming-indicator"></span>';
    }

    html += `<div class="chat-bubble">${bubbleContent}</div>`;
  } else if (msg.role === 'system') {
    html += `<div class="chat-bubble">${esc(msg.content || getMsgText(msg))}</div>`;
  }

  html += `</div></div>`;
  return html;
}

/**
 * Check if a scrollable container is near the bottom (within threshold).
 */
function isScrolledNearBottom(container, threshold) {
  if (!container) return true;
  const t = threshold || 80;
  return container.scrollHeight - container.scrollTop - container.clientHeight < t;
}

/**
 * Render all chat messages into the #chat-messages container.
 * During streaming, only updates the active message bubble for performance.
 * Smart auto-scroll: only scrolls to bottom if user was already near bottom.
 */
function renderChatMessages() {
  const container = document.getElementById('chat-messages');
  const emptyState = document.getElementById('chat-empty-state');

  if (chatState.messages.length === 0) {
    container.innerHTML = '';
    container.appendChild(emptyState);
    emptyState.style.display = '';
    return;
  }

  emptyState.style.display = 'none';

  // Check scroll position BEFORE updating DOM
  const wasNearBottom = isScrolledNearBottom(container);

  // During streaming, try to update only the active bubble instead of full re-render
  if (chatState.isStreaming && chatState.currentAssistantIdx !== null) {
    const existingBubbles = container.querySelectorAll('.chat-msg');
    const msgCount = chatState.messages.length;
    const offset = msgCount > chatState.maxVisibleMessages
      ? msgCount - chatState.maxVisibleMessages : 0;
    const displayIdx = chatState.currentAssistantIdx - offset;
    const hiddenHeader = msgCount > chatState.maxVisibleMessages ? 1 : 0;

    if (displayIdx >= 0 && existingBubbles.length === (msgCount - offset + hiddenHeader)) {
      // DOM matches message count — update in place
      const targetEl = existingBubbles[displayIdx + hiddenHeader];
      if (targetEl) {
        const msg = chatState.messages[chatState.currentAssistantIdx];
        const inner = targetEl.querySelector('.chat-msg-inner');
        if (inner && msg) {
          inner.innerHTML = renderSingleMessage(msg, chatState.currentAssistantIdx)
            .replace(/^<div class="chat-msg [^"]*"><div class="chat-msg-inner">/, '')
            .replace(/<\/div><\/div>$/, '');
          if (wasNearBottom) container.scrollTop = container.scrollHeight;
          return;
        }
      }
    }
  }

  // Full re-render
  const msgs = chatState.messages.length > chatState.maxVisibleMessages
    ? chatState.messages.slice(-chatState.maxVisibleMessages)
    : chatState.messages;

  let html = '';
  if (chatState.messages.length > chatState.maxVisibleMessages) {
    const hidden = chatState.messages.length - chatState.maxVisibleMessages;
    html += `<div class="chat-msg system"><div class="chat-msg-inner"><div class="chat-bubble">${hidden} earlier messages hidden</div></div></div>`;
  }

  msgs.forEach((msg, idx) => {
    const actualIdx = chatState.messages.length > chatState.maxVisibleMessages
      ? idx + (chatState.messages.length - chatState.maxVisibleMessages)
      : idx;
    html += renderSingleMessage(msg, actualIdx);
  });

  container.innerHTML = html;
  container.appendChild(emptyState);
  if (wasNearBottom) container.scrollTop = container.scrollHeight;
}

/**
 * Send the current message from the textarea (AC-2, AC-3, AC-5).
 */
function chatSendMessage() {
  const textarea = document.getElementById('chat-textarea');
  const text = textarea.value.trim();

  // AC-5: No empty message submissions
  if (!text) return;

  // Ensure we have an active session
  if (!activeChatId || !chatSessions[activeChatId]) {
    const id = createChatSession('Chat');
    switchChatSession(id);
  }

  const session = getActiveSession();
  if (!session || session.isStreaming) return;

  // Add user message
  session.messages.push({ role: 'user', content: text });
  textarea.value = '';
  autoResizeTextarea();
  renderChatMessages();

  // Start streaming response
  chatStartStreaming(text);
}

/**
 * Start SSE streaming for a chat message (AC-2, AC-3).
 * Works on the active session, or a specific session if targetSessionId is provided.
 */
function chatStartStreaming(prompt, targetSessionId) {
  const sessionId = targetSessionId || activeChatId;
  const session = chatSessions[sessionId];
  if (!session) return;

  session.isStreaming = true;
  session.status = 'streaming';

  // Helper: render to whichever view this session is visible in
  const renderVisible = () => {
    const vis = isSessionVisible(sessionId);
    if (vis === 'standalone') renderChatMessages();
    else if (vis === 'embedded') renderEmbeddedChatMessages();
  };
  const updateVisibleControls = () => {
    const vis = isSessionVisible(sessionId);
    if (vis === 'standalone') updateChatControls();
    else if (vis === 'embedded') updateEmbeddedChatControls();
  };

  updateVisibleControls();
  renderChatSidebar();
  updateEmbeddedSessionBarStatus();

  // Create assistant message placeholder with interleaved contentBlocks
  const assistantMsg = { role: 'assistant', contentBlocks: [{ type: 'text', text: '' }], systemEvents: [] };
  session.messages.push(assistantMsg);
  session.currentAssistantIdx = session.messages.length - 1;
  renderVisible();

  // Build request body (AC-3: session continuity, AC-4: context-aware)
  const body = { prompt: prompt };

  // Pass session_id for follow-up messages
  if (session.sessionId) {
    body.session_id = session.sessionId;
  }

  // AC-4: Inject selected BP context (from embedded bpId or appState)
  const contextBpId = session.bpId || appState.selectedBpId;
  if (contextBpId && state.byId[contextBpId]) {
    const bp = state.byId[contextBpId];
    body.prompt = `[Context: Currently viewing BP "${bp.title}" (${bp.id}), status: ${bp.status}]\n\n${prompt}`;
  }

  // Track whether we have received incremental text (to skip duplicate result text)
  let hasReceivedText = false;

  // Helper to get current text length across all text blocks
  const getTotalTextLength = (msg) => {
    return msg.contentBlocks.filter(b => b.type === 'text').reduce((sum, b) => sum + b.text.length, 0);
  };

  // Periodic background refresh while agent is working (picks up status changes
  // from git commits made by the agent). Runs every 10s during streaming.
  const bgRefreshInterval = setInterval(() => {
    if (!session.isStreaming) {
      clearInterval(bgRefreshInterval);
      return;
    }
    refreshAfterAgent();
  }, 10000);

  const handle = sseClient('/api/agent/invoke', body, {
    onMessage: (text) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (!msg) return;

      const totalLen = getTotalTextLength(msg);
      if (hasReceivedText && text.length >= totalLen && totalLen > 0) {
        return;
      }

      hasReceivedText = true;
      // Append to the last text block
      const lastText = msg.contentBlocks.filter(b => b.type === 'text').pop();
      if (lastText) lastText.text += text;
      renderVisible();
    },
    onToolUse: (toolInfo) => {
      // Reset dedup flag — the next text is from a new turn, not a duplicate
      hasReceivedText = false;
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        // Push tool block into the content stream
        msg.contentBlocks.push({
          type: 'tool',
          name: toolInfo.name,
          toolId: toolInfo.toolId || '',
          input: toolInfo.input || null,
          result: null,
        });
        // Push a new text block for subsequent text
        msg.contentBlocks.push({ type: 'text', text: '' });
        renderVisible();
      }
    },
    onToolResult: (resultInfo) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        // Find matching tool block by toolId (reverse search)
        const toolBlocks = msg.contentBlocks.filter(b => b.type === 'tool');
        const tb = toolBlocks.slice().reverse().find(b => b.toolId && b.toolId === resultInfo.toolId);
        if (tb) {
          tb.result = resultInfo.content;
        } else if (toolBlocks.length > 0) {
          // Fallback: assign to last tool block without a result
          const fallback = toolBlocks.slice().reverse().find(b => !b.result);
          if (fallback) fallback.result = resultInfo.content;
        }
        renderVisible();
      }
    },
    onResult: () => {
      // Result is a recap of already-sent content — don't append text.
      // Session ID is captured internally by sseClient and read via
      // handle.getSessionId() in onComplete.
    },
    onSystem: (data) => {
      const msg = session.messages[session.currentAssistantIdx];
      if (msg) {
        msg.systemEvents.push(data);
        renderVisible();
      }
    },
    onComplete: () => {
      clearInterval(bgRefreshInterval);
      session.isStreaming = false;
      session.streamHandle = null;
      session.currentAssistantIdx = null;
      session.status = 'done';

      if (handle.getSessionId && handle.getSessionId()) {
        session.sessionId = handle.getSessionId();
      }

      updateVisibleControls();
      renderVisible();
      renderChatSidebar();
      updateEmbeddedSessionBarStatus();
      updateAllActionButtons();
      // Final status refresh after agent completion
      refreshAfterAgent();
    },
    onError: (err) => {
      clearInterval(bgRefreshInterval);
      session.isStreaming = false;
      session.streamHandle = null;
      session.status = 'error';

      const msgIdx = session.currentAssistantIdx;
      session.currentAssistantIdx = null;

      const msg = msgIdx !== null ? session.messages[msgIdx] : null;
      if (msg && !getMsgText(msg)) {
        session.messages.splice(msgIdx, 1);
      }
      session.messages.push({
        role: 'system',
        content: `Error: ${err.message || 'Unknown error'}`,
      });

      updateVisibleControls();
      renderVisible();
      renderChatSidebar();
      updateEmbeddedSessionBarStatus();
      updateAllActionButtons();
    },
  });

  session.streamHandle = handle;
}

/**
 * Stop the current streaming response (AC-5).
 */
async function chatStopStreaming() {
  const session = getActiveSession();
  if (!session || !session.streamHandle) return;
  await session.streamHandle.cancel();
  session.isStreaming = false;
  session.streamHandle = null;
  session.currentAssistantIdx = null;
  session.status = 'done';

  session.messages.push({
    role: 'system',
    content: 'Response stopped by user',
  });

  updateChatControls();
  renderChatMessages();
  renderChatSidebar();
}

/**
 * Start a new conversation — creates a new session and switches to it (AC-5).
 */
function chatNewConversation() {
  const id = createChatSession('New conversation');
  switchChatSession(id);
  // Switch to chat view if not already there
  if (!document.body.classList.contains('view-chat')) {
    switchView('chat');
  }
}

/**
 * Update chat control visibility based on streaming state (AC-5).
 */
function updateChatControls() {
  const sendBtn = document.getElementById('chat-send-btn');
  const stopBtn = document.getElementById('chat-stop-btn');
  const textarea = document.getElementById('chat-textarea');

  if (chatState.isStreaming) {
    sendBtn.style.display = 'none';
    stopBtn.style.display = '';
    textarea.disabled = true;
    textarea.placeholder = 'Waiting for response...';
  } else {
    sendBtn.style.display = '';
    stopBtn.style.display = 'none';
    textarea.disabled = false;
    textarea.placeholder = 'Ask Claude anything... (Enter to send, Shift+Enter for newline)';
  }
}

/**
 * Update the BP context indicator in the chat input area (AC-4).
 */
function updateChatBpContext() {
  const el = document.getElementById('chat-bp-context');
  if (!el) return;

  if (appState.selectedBpId && state.byId[appState.selectedBpId]) {
    const bp = state.byId[appState.selectedBpId];
    el.textContent = `Context: ${bp.slug || bp.id.slice(0, 6)}`;
    el.style.display = '';
    el.title = `BP: ${bp.title} (${bp.id})`;
  } else {
    el.style.display = 'none';
  }
}

/**
 * Render the chat sidebar with all sessions.
 */
function renderChatSidebar() {
  const list = document.getElementById('chat-sidebar-list');
  if (!list) return;

  // Sort sessions: streaming first, then by creation time descending
  const sorted = Object.values(chatSessions).sort((a, b) => {
    if (a.isStreaming && !b.isStreaming) return -1;
    if (!a.isStreaming && b.isStreaming) return 1;
    return b.createdAt - a.createdAt;
  });

  if (sorted.length === 0) {
    list.innerHTML = '<div style="padding:16px 12px;color:var(--text-muted);font-size:11px;text-align:center">No sessions yet.<br>Start a conversation or trigger an action.</div>';
    return;
  }

  let html = '';
  sorted.forEach(s => {
    const isActive = s.id === activeChatId;
    const timeStr = new Date(s.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const statusClass = s.status === 'reconnecting' ? 'streaming' : s.isStreaming ? 'streaming' : (s.status || 'idle');
    const statusLabel = s.status === 'reconnecting' ? 'Reconnecting...' : s.isStreaming ? 'Streaming...' : (s.status === 'done' ? 'Done' : s.status === 'error' ? 'Error' : 'Idle');
    const msgCount = s.messages.filter(m => m.role !== 'system').length;

    html += `<div class="chat-session-item ${isActive ? 'active' : ''}" onclick="switchChatSession('${s.id}')">`;
    html += `  <div class="chat-session-item-title">${esc(s.title)}</div>`;
    html += `  <div class="chat-session-item-meta">`;
    html += `    <span class="chat-session-status-dot ${esc(statusClass)}"></span>`;
    html += `    <span>${esc(statusLabel)}</span>`;
    html += `    <span style="margin-left:auto">${msgCount > 0 ? msgCount + ' msg' : ''} ${timeStr}</span>`;
    html += `  </div>`;
    html += `</div>`;
  });

  list.innerHTML = html;
}

/**
 * Auto-resize textarea to fit content (AC-5).
 */
function autoResizeTextarea() {
  const textarea = document.getElementById('chat-textarea');
  if (!textarea) return;
  textarea.style.height = 'auto';
  textarea.style.height = Math.min(textarea.scrollHeight, 160) + 'px';
}

/**
 * Set up keyboard shortcuts for the chat textarea (AC-5).
 */
function setupChatInput() {
  const textarea = document.getElementById('chat-textarea');
  if (!textarea) return;

  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      // Enter to send (AC-5)
      e.preventDefault();
      chatSendMessage();
    }
    // Shift+Enter falls through naturally (inserts newline)

    if (e.key === 'Escape') {
      // Escape to cancel streaming or blur
      if (chatState.isStreaming) {
        chatStopStreaming();
      } else {
        textarea.blur();
      }
    }
  });

  textarea.addEventListener('input', autoResizeTextarea);
}

// ─── Create BP Dialog ──────────────────────────────────────────────────

function showCreateBpDialog() {
  // Build parent options from existing root BPs
  let parentOptions = '<option value="">(None — create as root BP)</option>';
  state.briefings.filter(b => !b.parent).forEach(b => {
    parentOptions += `<option value="${esc(b.id)}">${esc(b.title)} (${esc(b.id.slice(0,6))})</option>`;
  });

  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'create-bp-modal';
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };
  overlay.innerHTML = `
    <div class="modal-dialog">
      <h2>Create New Agent</h2>
      <label>Title *</label>
      <input id="bp-create-title" placeholder="e.g. Implement auth middleware" autofocus />
      <label>Rigor</label>
      <select id="bp-create-rigor">
        <option value="standard" selected>Standard</option>
        <option value="high">High</option>
        <option value="critical">Critical</option>
      </select>
      <label>Parent BP</label>
      <select id="bp-create-parent">${parentOptions}</select>
      <label>Goal</label>
      <textarea id="bp-create-goal" placeholder="What should this BP achieve and why?"></textarea>
      <div class="modal-actions">
        <button class="btn-cancel" onclick="document.getElementById('create-bp-modal').remove()">Cancel</button>
        <button class="btn-primary" onclick="submitCreateBp()">Create BP</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  document.getElementById('bp-create-title').focus();
}

async function submitCreateBp() {
  const title = document.getElementById('bp-create-title').value.trim();
  if (!title) {
    document.getElementById('bp-create-title').style.borderColor = '#e05d6f';
    return;
  }
  const rigor = document.getElementById('bp-create-rigor').value;
  const parent = document.getElementById('bp-create-parent').value;
  const goal = document.getElementById('bp-create-goal').value.trim();

  // Close dialog
  document.getElementById('create-bp-modal').remove();

  // Build prompt for the agent to create a BP via /ace:brief
  let prompt = `Create a new Agent with the following details:\n`;
  prompt += `- Title: "${title}"\n`;
  prompt += `- Rigor: ${rigor}\n`;
  if (parent) prompt += `- Parent BP: ${parent}\n`;
  if (goal) prompt += `- Goal: ${goal}\n`;
  prompt += `\nUse /ace:brief to create this BP. Generate a proper 12-char hex ID, derive a slug from the title, set status to draft, and write the brief.md file to the correct location under artifacts/briefings/.`;

  // Reuse invokeAgent() which handles panel, streaming, refresh
  invokeAgent(prompt, 'Creating BP: ' + title);
}

// ─── Init ─────────────────────────────────────────────────────────────

setupPanZoom();
setupChatInput();

// Restore archived filter state from localStorage
if (state.showArchived) {
  document.getElementById('btn-toggle-archived').classList.add('active');
}

// Check agent availability on startup (non-blocking)
fetch('/api/server-status').then(r => {
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}).then(status => {
  agentState.available = status.agent_available;
  agentState.unavailableReason = status.agent_unavailable_reason;
  updateAllActionButtons();
  const badge = document.getElementById('agent-availability-badge');
  if (!status.agent_available) {
    badge.style.display = 'inline';
    badge.title = (status.agent_unavailable_reason || 'Agent SDK not configured') + ' — click to configure';
  } else {
    badge.style.display = 'none';
  }
}).catch(() => { /* server-status not available — assume agent works */ });

switchView('overview');

// ─── Blueprints View ──────────────────────────────────────────────────

let blueprintCache = null;

async function fetchAndRenderBlueprints() {
  const listEl = document.getElementById('blueprints-list');
  const detailEl = document.getElementById('blueprint-detail');
  const loadingEl = document.getElementById('blueprints-loading');

  detailEl.style.display = 'none';
  listEl.style.display = '';
  loadingEl.style.display = '';

  try {
    const resp = await fetch('/api/blueprints');
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    blueprintCache = await resp.json();
    loadingEl.style.display = 'none';
    renderBlueprintList(blueprintCache);
  } catch (err) {
    loadingEl.style.display = 'none';
    listEl.innerHTML = `<div class="bp-tmpl-empty">Failed to load blueprints: ${esc(err.message)}</div>`;
  }
}

function renderBlueprintList(blueprints) {
  const listEl = document.getElementById('blueprints-list');

  if (!blueprints || blueprints.length === 0) {
    listEl.innerHTML = `<div class="bp-tmpl-empty">
      <p>No blueprints found.</p>
      <p style="margin-top:8px;font-size:12px;">Use <code>/blueprint extract {bp-hash}</code> in Claude Code to create one from an existing BP tree.</p>
    </div>`;
    return;
  }

  let html = `<div style="margin-bottom:1rem;color:#8b949e;font-size:12px;">${blueprints.length} blueprint(s)</div>`;

  for (const bp of blueprints) {
    const tags = (bp.tags || []).map(t => `<span class="bp-tmpl-tag">${esc(t)}</span>`).join('');
    html += `<div class="bp-tmpl-card" onclick="showBlueprintDetail('${esc(bp.hash)}')">
      <h3>${bpIdLabel(bp.hash, 'bp-tmpl:' + bp.hash.substring(0, 6))} (${esc(bp.slug)})</h3>
      <div style="font-size:13px;color:var(--text);margin-bottom:6px;">${esc(bp.title || '')}</div>
      <div class="bp-tmpl-meta">
        <span>Level: ${esc(bp['abstraction-level'] || '?')}</span>
        <span>Version: ${esc(bp.version || '1.0.0')}</span>
        <span>Used: ${bp['instantiation-count'] || 0}x</span>
      </div>
      ${tags ? `<div class="bp-tmpl-tags">${tags}</div>` : ''}
    </div>`;
  }

  listEl.innerHTML = html;
}

async function showBlueprintDetail(hashPrefix) {
  const listEl = document.getElementById('blueprints-list');
  const detailEl = document.getElementById('blueprint-detail');

  listEl.style.display = 'none';
  detailEl.style.display = '';
  detailEl.innerHTML = '<div style="color:#8b949e;padding:1rem;">Loading...</div>';

  try {
    const resp = await fetch(`/api/blueprint/${encodeURIComponent(hashPrefix)}`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const bp = await resp.json();
    renderBlueprintDetail(bp);
  } catch (err) {
    detailEl.innerHTML = `<div class="bp-tmpl-empty">Error: ${esc(err.message)}</div>`;
  }
}

function renderBlueprintDetail(bp) {
  const detailEl = document.getElementById('blueprint-detail');

  const params = bp.parameters || [];
  let paramsHtml = '';
  if (params.length > 0) {
    paramsHtml = `<h4 style="margin:1rem 0 0.5rem 0;font-size:13px;color:#8b949e;">Parameters (${params.length})</h4>
      <table class="bp-tmpl-params-table">
        <thead><tr><th>Name</th><th>Type</th><th>Required</th><th>Description</th></tr></thead>
        <tbody>${params.map(p => `<tr>
          <td><code>${esc(p.name || '')}</code></td>
          <td>${esc(p.type || 'string')}</td>
          <td>${p.required === false || p.required === 'false' ? 'no' : 'yes'}</td>
          <td>${esc(p.description || '')}</td>
        </tr>`).join('')}</tbody>
      </table>`;
  }

  const prov = bp.provenance || {};
  let provHtml = '';
  if (prov['source-bp']) {
    provHtml = `<h4 style="margin:1rem 0 0.5rem 0;font-size:13px;color:#8b949e;">Provenance</h4>
      <div style="font-size:12px;">
        Source: ${bpIdLabel(prov['source-bp'] || '', 'bp:' + (prov['source-bp'] || '').substring(0,6))} (${esc(prov['source-slug'] || '')})
        &mdash; extracted ${esc(prov['extracted-date'] || '?')} by ${esc(prov['extracted-by'] || '?')}
      </div>`;
  }

  const tree = bp.tree || [];
  let treeHtml = '';
  if (tree.length > 1) {
    treeHtml = `<h4 style="margin:1rem 0 0.5rem 0;font-size:13px;color:#8b949e;">Structure (${tree.length})</h4>
      <div style="font-size:12px;font-family:monospace;">
        ${tree.map(n => {
          const indent = '\u00a0\u00a0'.repeat(n.depth || 0);
          return `<div>${indent}${bpIdLabel(n.hash, 'bp-tmpl:' + n.hash.substring(0,6))} (${esc(n.slug)}) &mdash; ${esc(n.title || '')}</div>`;
        }).join('')}
      </div>`;
  }

  const bodyHtml = bp.body ? `<h4 style="margin:1rem 0 0.5rem 0;font-size:13px;color:#8b949e;">Body</h4>
    <div class="bp-tmpl-body">${esc(bp.body)}</div>` : '';

  const tags = (bp.tags || []).map(t => `<span class="bp-tmpl-tag">${esc(t)}</span>`).join('');

  detailEl.innerHTML = `
    <button class="bp-tmpl-detail-back" onclick="backToBlueprintList()">&larr; Back to list</button>
    <div class="bp-tmpl-detail-header">
      <h2>${bpIdLabel(bp.hash || '', 'bp-tmpl:' + (bp.hash || '').substring(0,6))} (${esc(bp.slug || '')})</h2>
      <div style="font-size:14px;margin-bottom:8px;">${esc(bp.title || '')}</div>
      <div class="bp-tmpl-meta">
        <span>Level: ${esc(bp['abstraction-level'] || '?')}</span>
        <span>Version: ${esc(bp.version || '')}</span>
        <span>Used: ${bp['instantiation-count'] || 0}x</span>
      </div>
      ${tags ? `<div class="bp-tmpl-tags" style="margin-top:6px;">${tags}</div>` : ''}
    </div>
    ${paramsHtml}
    ${provHtml}
    ${treeHtml}
    ${bodyHtml}
  `;
}

function backToBlueprintList() {
  const listEl = document.getElementById('blueprints-list');
  const detailEl = document.getElementById('blueprint-detail');
  detailEl.style.display = 'none';
  listEl.style.display = '';
}

// ─── Glossary View ────────────────────────────────────────────────────

function filterGlossary(query) {
  const q = query.toLowerCase().trim();
  document.querySelectorAll('#glossary-entries .glossary-row:not(.glossary-row-header)').forEach(row => {
    if (!q) { row.style.display = ''; return; }
    const terms = (row.getAttribute('data-terms') || '') + ' ' + row.textContent.toLowerCase();
    row.style.display = terms.includes(q) ? '' : 'none';
  });
  // Hide section headers if all rows in that section are hidden
  document.querySelectorAll('#glossary-entries .glossary-section').forEach(section => {
    const rows = section.querySelectorAll('.glossary-row:not(.glossary-row-header)');
    const anyVisible = Array.from(rows).some(r => r.style.display !== 'none');
    section.style.display = anyVisible ? '' : 'none';
  });
}
