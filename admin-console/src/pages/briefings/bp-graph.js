// bp-graph.js — ES Module
// Extracted canvas/graph rendering logic from ACE bp-explorer/app.js
// Wraps all state locally; call initBPGraph(viewportEl, { apiBase, workspace })

export function initBPGraph(viewport, { apiBase, workspace }) {

  // ─── Constants ──────────────────────────────────────────────────────
  const NODE_W      = 320;
  const ARTIFACT_W  = 220;
  const H_GAP       = 50;
  const V_GAP       = 100;
  const ARTIFACT_H  = 70;

  // ─── DOM structure ──────────────────────────────────────────────────
  // Build canvas-viewport → canvas → svg#edges structure inside the
  // supplied viewport element.
  viewport.style.position = 'relative';
  viewport.style.overflow = 'hidden';
  viewport.style.width    = '100%';
  viewport.style.height   = '100%';
  viewport.style.cursor   = 'grab';

  const canvas = document.createElement('div');
  canvas.style.position       = 'absolute';
  canvas.style.top            = '0';
  canvas.style.left           = '0';
  canvas.style.transformOrigin = '0 0';
  canvas.style.userSelect     = 'none';
  viewport.appendChild(canvas);

  const svgEdges = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svgEdges.style.position = 'absolute';
  svgEdges.style.top      = '0';
  svgEdges.style.left     = '0';
  svgEdges.style.width    = '100%';
  svgEdges.style.height   = '100%';
  svgEdges.style.overflow = 'visible';
  svgEdges.style.pointerEvents = 'none';
  canvas.appendChild(svgEdges);

  // Loading indicator
  const loadingEl = document.createElement('div');
  loadingEl.textContent = 'Loading briefings…';
  loadingEl.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);color:#888;font-size:14px;pointer-events:none;';
  viewport.appendChild(loadingEl);

  // Zoom display
  const zoomEl = document.createElement('div');
  zoomEl.textContent = '100%';
  zoomEl.style.cssText = 'position:absolute;bottom:8px;right:12px;font-size:11px;color:#888;pointer-events:none;z-index:10;';
  viewport.appendChild(zoomEl);

  // ─── State ──────────────────────────────────────────────────────────
  const state = {
    briefings:          [],
    byId:               {},
    roots:              [],
    expanded:           new Set(),
    contentVisible:     new Set(),
    childrenVisible:    new Set(),
    outputsVisible:     new Set(),
    inputsVisible:      new Set(),
    positions:          {},
    artifactPositions:  {},
    numberLabels:       {},
    artifactRegistry:   {},
    pan:                { x: 0, y: 0 },
    zoom:               1.0,
    userTransform:      false,
    dragging:           false,
    dragStart:          { x: 0, y: 0 },
    panStart:           { x: 0, y: 0 },
    showArchived:       localStorage.getItem('ace-graph-show-archived') === 'true',
  };

  // ─── Data Loading ────────────────────────────────────────────────────

  function recomputeRoots() {
    state.roots = state.briefings
      .filter(bp => !bp.parent && (state.showArchived || !bp.archived))
      .map(bp => bp.id);
  }

  async function fetchBriefings() {
    try {
      const resp = await fetch(`${apiBase}/briefings?workspace=${encodeURIComponent(workspace)}`);
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      state.briefings = await resp.json();

      state.byId = {};
      state.briefings.forEach(bp => { state.byId[bp.id] = bp; });

      recomputeRoots();
      buildArtifactRegistry();

      loadingEl.style.display = 'none';
      layout();
      render();
      if (!state.userTransform) fitToView();
    } catch (err) {
      loadingEl.textContent = `Error loading briefings: ${err.message}`;
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
            producers:    [],
            consumers:    [],
            acs:          [],
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

  // ─── Layout ──────────────────────────────────────────────────────────

  function topoSort(ids) {
    const idSet = new Set(ids);
    const result = [];
    const visited = new Set();

    function visit(id) {
      if (visited.has(id)) return;
      visited.add(id);
      const bp = state.byId[id];
      if (!bp) return;
      (bp.depends_on || []).forEach(depId => {
        if (idSet.has(depId)) visit(depId);
      });
      result.push(id);
    }

    ids.forEach(id => visit(id));
    return result;
  }

  function collectDescendants(id, result) {
    const bp = state.byId[id];
    if (!bp || !bp.children) return;
    bp.children.forEach(cid => {
      result.add(cid);
      collectDescendants(cid, result);
    });
  }

  function topoSortRoots(rootIds) {
    const treeMembers = {};
    rootIds.forEach(rootId => {
      const members = new Set([rootId]);
      collectDescendants(rootId, members);
      treeMembers[rootId] = members;
    });

    const idToRoot = {};
    rootIds.forEach(rootId => {
      treeMembers[rootId].forEach(memberId => {
        idToRoot[memberId] = rootId;
      });
    });

    const rootDeps = {};
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

    const rootSet = new Set(rootIds);
    const result  = [];
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
    const el = canvas.querySelector(`.node[data-id="${id}"]`);
    if (el) return el.offsetHeight;
    let h = 90;
    if (state.expanded.has(id))      h += 150;
    if (state.contentVisible.has(id)) h += 300;
    return h;
  }

  function getArtifactNodeHeight(path) {
    const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
    if (el) return el.offsetHeight;
    return ARTIFACT_H;
  }

  function layout() {
    const visible = getVisibleNodes();
    if (visible.length === 0) return;

    const visibleIds = new Set(visible.map(n => n.id));
    const childrenOf = {};
    visible.forEach(n => {
      const bp  = state.byId[n.id];
      const kids = (bp.children || []).filter(cid => visibleIds.has(cid));
      childrenOf[n.id] = topoSort(kids);
    });

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
        const lastChild  = pos[kids[kids.length - 1]];
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
    layoutArtifacts(visible);
  }

  function layoutArtifacts(visibleBpNodes) {
    const visiblePaths = getVisibleArtifactPaths();
    if (visiblePaths.size === 0) { state.artifactPositions = {}; return; }

    let maxY = 0;
    visibleBpNodes.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      const h = getNodeHeight(n.id);
      maxY = Math.max(maxY, pos.y + h);
    });
    const artifactRowY = maxY + V_GAP;

    const visibleBpIds = new Set(visibleBpNodes.map(n => n.id));

    const items = [];
    visiblePaths.forEach(path => {
      const reg = state.artifactRegistry[path];
      if (!reg) return;

      let sum  = 0;
      let count = 0;
      let bpMin = Infinity;
      let bpMax = -Infinity;
      const consider = (id, toggleSet) => {
        if (!visibleBpIds.has(id) || !toggleSet.has(id)) return;
        const pos = state.positions[id];
        if (!pos) return;
        const center = pos.x + NODE_W / 2;
        sum += center;
        count++;
        if (center < bpMin) bpMin = center;
        if (center > bpMax) bpMax = center;
      };
      reg.producers.forEach(id => consider(id, state.outputsVisible));
      reg.consumers.forEach(id => consider(id, state.inputsVisible));
      if (count === 0) return;

      items.push({
        path,
        idealX: sum / count - ARTIFACT_W / 2,
        bpMin:  bpMin - ARTIFACT_W / 2,
        bpMax:  bpMax - ARTIFACT_W / 2,
      });
    });

    items.sort((a, b) => a.idealX - b.idealX);
    const SPACING = ARTIFACT_W + 12;
    const blocks  = [];
    for (let i = 0; i < items.length; i++) {
      let start = i;
      let count = 1;
      let sum   = items[i].idealX - i * SPACING;
      let value = sum;
      while (blocks.length > 0 && blocks[blocks.length - 1].value > value) {
        const prev = blocks.pop();
        start  = prev.start;
        count += prev.count;
        sum   += prev.sum;
        value  = sum / count;
      }
      blocks.push({ start, end: i, count, sum, value });
    }

    blocks.forEach(b => {
      for (let i = b.start; i <= b.end; i++) {
        items[i].x = b.value + i * SPACING;
      }
    });

    let prevRight = -Infinity;
    blocks.forEach((b, bIdx) => {
      const minSpan = (b.count - 1) * SPACING;

      if (b.count < 2) {
        prevRight = items[b.start].x;
        return;
      }

      let unionMin = Infinity;
      let unionMax = -Infinity;
      for (let i = b.start; i <= b.end; i++) {
        if (items[i].bpMin < unionMin) unionMin = items[i].bpMin;
        if (items[i].bpMax > unionMax) unionMax = items[i].bpMax;
      }
      const desiredSpan = unionMax - unionMin;
      if (desiredSpan <= minSpan) {
        prevRight = items[b.end].x;
        return;
      }

      const leftLimit  = bIdx > 0 ? prevRight + SPACING : -Infinity;
      const rightLimit = bIdx < blocks.length - 1
        ? blocks[bIdx + 1].value + blocks[bIdx + 1].start * SPACING - SPACING
        : Infinity;

      const centroid = b.value + ((b.start + b.end) / 2) * SPACING;
      let blockStart = centroid - desiredSpan / 2;
      let blockEnd   = centroid + desiredSpan / 2;
      if (blockStart < leftLimit) {
        blockEnd  += leftLimit - blockStart;
        blockStart = leftLimit;
      }
      if (blockEnd > rightLimit) {
        blockStart -= blockEnd - rightLimit;
        blockEnd   = rightLimit;
        if (blockStart < leftLimit) blockStart = leftLimit;
      }
      let span = blockEnd - blockStart;
      if (span < minSpan) span = minSpan;

      const step = span / (b.count - 1);
      for (let i = b.start; i <= b.end; i++) {
        items[i].x = blockStart + step * (i - b.start);
      }
      prevRight = items[b.end].x;
    });

    const artPos = {};
    items.forEach(it => { artPos[it.path] = { x: it.x, y: artifactRowY }; });
    state.artifactPositions = artPos;
  }

  // ─── Rendering ───────────────────────────────────────────────────────

  function render() {
    layout();

    const visible    = getVisibleNodes();
    const visibleIds = new Set(visible.map(n => n.id));

    canvas.querySelectorAll('.node, .artifact-node').forEach(el => el.remove());

    visible.forEach(n => {
      const bp  = state.byId[n.id];
      const pos = state.positions[n.id];
      if (!bp || !pos) return;

      const node = document.createElement('div');
      node.className = 'bp-node' + (bp.status ? ` bp-node-status-${bp.status}` : '');
      node.dataset.id = n.id;
      node.style.cssText = `
        position:absolute;
        left:${pos.x}px;
        top:${pos.y}px;
        width:${NODE_W}px;
        background:var(--eb-bg-surface,#1e1e2e);
        border:1px solid var(--eb-border-default,#333);
        border-radius:8px;
        padding:10px 12px;
        box-sizing:border-box;
        font-size:12px;
        color:var(--eb-text-primary,#e0e0e0);
        box-shadow:0 2px 8px rgba(0,0,0,0.3);
      `;
      applyStatusBorderColor(node, bp.status);
      node.addEventListener('mousedown', e => e.stopPropagation());

      // Header
      const header = document.createElement('div');
      header.style.cssText = 'font-weight:600;font-size:13px;margin-bottom:4px;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;';
      const numLabel = state.numberLabels[n.id] || '';
      header.innerHTML = `
        <span style="flex:1;line-height:1.4;">${esc(numLabel ? numLabel + ' ' : '')}${esc(bp.title)}</span>
        ${bpIdLabel(bp.id, bp.id.slice(0, 6), 'bp-id-copy')}
      `;
      node.appendChild(header);

      // Badges
      const badgeParts = [];
      if (bp.rigor)    badgeParts.push(`<span class="bp-badge bp-badge-rigor-${esc(bp.rigor)}">${esc(bp.rigor)}</span>`);
      if (bp.revision && parseInt(bp.revision) > 1)
        badgeParts.push(`<span class="bp-badge bp-badge-revision" title="Revised">Rev ${esc(String(bp.revision))}</span>`);
      if (badgeParts.length > 0) {
        const badges = document.createElement('div');
        badges.style.cssText = 'display:flex;gap:4px;flex-wrap:wrap;margin-bottom:6px;';
        badges.innerHTML = badgeParts.join('');
        node.appendChild(badges);
      }

      // Action buttons
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;';

      const detailBtn = makeBtn('Details', state.expanded.has(n.id));
      detailBtn.addEventListener('click', () => toggleDetails(n.id));
      actions.appendChild(detailBtn);

      if (bp.children && bp.children.length > 0) {
        const childBtn = makeBtn(`Children (${bp.children.length})`, state.childrenVisible.has(n.id));
        childBtn.addEventListener('click', () => toggleChildren(n.id));
        actions.appendChild(childBtn);
      }

      if (bp.artifacts && bp.artifacts.length > 0) {
        const outCount = bp.artifacts.filter(a => a.direction === 'output').length;
        const inCount  = bp.artifacts.filter(a => a.direction === 'input').length;

        if (inCount > 0) {
          const inBtn = makeBtn(`In (${inCount})`, state.inputsVisible.has(n.id));
          inBtn.addEventListener('click', () => toggleInputs(n.id));
          actions.appendChild(inBtn);
        }
        if (outCount > 0) {
          const outBtn = makeBtn(`Out (${outCount})`, state.outputsVisible.has(n.id));
          outBtn.addEventListener('click', () => toggleOutputs(n.id));
          actions.appendChild(outBtn);
        }
      }

      const contentBtn = makeBtn('Content', state.contentVisible.has(n.id));
      contentBtn.addEventListener('click', () => toggleContent(n.id));
      actions.appendChild(contentBtn);

      node.appendChild(actions);

      // Details panel
      if (state.expanded.has(n.id)) {
        const details = document.createElement('div');
        details.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--eb-border-default,#333);font-size:11px;';

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
              const note = item.note ? `<span style="color:#888;margin-left:4px">${esc(item.note)}</span>` : '';
              return `<li>${esc(item.slug || item.id || JSON.stringify(item))}${note}</li>`;
            }
          }).join('');
          rows.push(`<div style="margin:4px 0 2px;color:#888">Execution Order</div>
            <ol style="text-align:left;padding-left:16px;margin:0 0 4px;">${list}</ol>`);
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
        body.style.cssText = 'margin-top:8px;padding-top:8px;border-top:1px solid var(--eb-border-default,#333);font-size:11px;max-height:300px;overflow-y:auto;line-height:1.5;';
        body.innerHTML = renderMarkdown(bp.body);
        body.addEventListener('wheel', e => e.stopPropagation());
        node.appendChild(body);
      }

      canvas.appendChild(node);
    });

    // Artifact nodes
    renderArtifactNodes();

    // Re-layout with actual DOM heights, then reposition
    requestAnimationFrame(() => {
      layout();
      canvas.querySelectorAll('.bp-node').forEach(el => {
        const id  = el.dataset.id;
        const pos = state.positions[id];
        if (pos) {
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
        }
      });
      canvas.querySelectorAll('.artifact-node').forEach(el => {
        const path = el.dataset.path;
        const pos  = state.artifactPositions[path];
        if (pos) {
          el.style.left = pos.x + 'px';
          el.style.top  = pos.y + 'px';
        }
      });
      drawEdges();
    });
  }

  function renderArtifactNodes() {
    const visiblePaths = getVisibleArtifactPaths();
    const rendered     = new Set();

    visiblePaths.forEach(path => {
      if (rendered.has(path)) return;
      rendered.add(path);

      const reg = state.artifactRegistry[path];
      const pos = state.artifactPositions[path];
      if (!reg || !pos) return;

      const node = document.createElement('div');
      node.className  = 'artifact-node';
      node.dataset.path = path;
      node.style.cssText = `
        position:absolute;
        left:${pos.x}px;
        top:${pos.y}px;
        width:${ARTIFACT_W}px;
        background:var(--eb-bg-surface,#1e1e2e);
        border:1px solid var(--eb-border-default,#444);
        border-radius:6px;
        padding:8px 10px;
        box-sizing:border-box;
        font-size:11px;
        color:var(--eb-text-primary,#e0e0e0);
        box-shadow:0 1px 4px rgba(0,0,0,0.2);
      `;
      node.addEventListener('mousedown', e => e.stopPropagation());

      const fnEl = document.createElement('div');
      fnEl.style.cssText = 'font-weight:600;font-size:12px;margin-bottom:2px;word-break:break-all;';
      fnEl.textContent = reg.filename;
      node.appendChild(fnEl);

      if (reg.dir) {
        const dirEl = document.createElement('div');
        dirEl.style.cssText = 'font-size:10px;color:#888;margin-bottom:4px;word-break:break-all;';
        dirEl.textContent = reg.dir + '/';
        node.appendChild(dirEl);
      }

      const meta = document.createElement('div');
      meta.style.cssText = 'display:flex;flex-wrap:wrap;gap:3px;';

      const visibleProducers = reg.producers.filter(id => state.outputsVisible.has(id));
      const visibleConsumers = reg.consumers.filter(id => state.inputsVisible.has(id));
      const isOutput = visibleProducers.length > 0;
      const isInput  = visibleConsumers.length > 0;
      let dirColor, dirLabel;
      if (isOutput && isInput) { dirColor = '#a78bfa'; dirLabel = 'output + input'; }
      else if (isOutput)       { dirColor = '#34d399'; dirLabel = 'output'; }
      else                     { dirColor = '#60a5fa'; dirLabel = 'input'; }
      meta.innerHTML = `<span style="background:${dirColor}22;color:${dirColor};border:1px solid ${dirColor}55;border-radius:3px;padding:1px 5px;font-size:10px;">${dirLabel}</span>`;

      reg.acs.forEach(ac => {
        meta.innerHTML += `<span style="background:#f59e0b22;color:#f59e0b;border:1px solid #f59e0b55;border-radius:3px;padding:1px 5px;font-size:10px;">${esc(ac)}</span>`;
      });

      node.appendChild(meta);

      const desc = reg.descriptions.find(d => d && !d.startsWith('From bp:')) || reg.descriptions[0];
      if (desc) {
        const descEl = document.createElement('div');
        descEl.style.cssText = 'font-size:10px;color:#aaa;margin-top:4px;line-height:1.4;';
        descEl.textContent = desc.replace(/^From bp:\w+ — /, '');
        node.appendChild(descEl);
      }

      canvas.appendChild(node);
    });
  }

  function applyStatusBorderColor(node, status) {
    const colors = {
      draft:      '#6b7280',
      ready:      '#3b82f6',
      dispatched: '#f59e0b',
      claimed:    '#8b5cf6',
      completed:  '#10b981',
      reviewed:   '#06b6d4',
      stale:      '#ef4444',
    };
    if (status && colors[status]) {
      node.style.borderColor = colors[status];
      node.style.borderWidth = '2px';
    }
  }

  function makeBtn(label, active) {
    const btn = document.createElement('button');
    btn.textContent = label;
    btn.style.cssText = `
      padding:2px 8px;
      font-size:11px;
      border-radius:4px;
      border:1px solid ${active ? '#3b82f6' : 'var(--eb-border-default,#555)'};
      background:${active ? 'rgba(59,130,246,0.2)' : 'transparent'};
      color:${active ? '#60a5fa' : 'var(--eb-text-secondary,#aaa)'};
      cursor:pointer;
    `;
    return btn;
  }

  function detailRow(label, value) {
    return `<div style="display:flex;justify-content:space-between;gap:8px;margin-bottom:3px;">
      <span style="color:#888;flex-shrink:0;">${esc(label)}</span>
      <span style="word-break:break-all;text-align:right;">${esc(String(value || '—'))}</span>
    </div>`;
  }

  // ─── Edge Drawing ────────────────────────────────────────────────────

  function drawEdges() {
    svgEdges.innerHTML = '';

    const visible    = getVisibleNodes();
    const visibleIds = new Set(visible.map(n => n.id));

    // 1. Hierarchy edges (gray solid)
    visible.forEach(n => {
      const bp = state.byId[n.id];
      if (!bp || !state.childrenVisible.has(n.id)) return;

      const parentPos = state.positions[n.id];
      const parentEl  = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
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

        drawBezierEdge(x1, y1, x2, y2, '#555', 2, '', false);
      });
    });

    // 2. Dependency edges (red dashed)
    visible.forEach(n => {
      const bp = state.byId[n.id];
      if (!bp || !bp.depends_on) return;

      bp.depends_on.forEach(depId => {
        if (!visibleIds.has(depId)) return;
        const fromPos = state.positions[depId];
        const toPos   = state.positions[n.id];
        const fromEl  = canvas.querySelector(`.bp-node[data-id="${depId}"]`);
        if (!fromPos || !toPos || !fromEl) return;

        const fromH = fromEl.offsetHeight;
        const x1 = fromPos.x + NODE_W;
        const y1 = fromPos.y + fromH / 2;
        const x2 = toPos.x;
        const y2 = toPos.y + 45;
        const mx = (x1 + x2) / 2;

        const path = makeSvgPath(`M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`);
        path.setAttribute('stroke', '#ef4444');
        path.setAttribute('stroke-width', '1.5');
        path.setAttribute('stroke-dasharray', '6 4');
        path.setAttribute('fill', 'none');
        path.setAttribute('opacity', '0.5');

        const arrow = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
        arrow.setAttribute('points', `${x2},${y2} ${x2-8},${y2-4} ${x2-8},${y2+4}`);
        arrow.setAttribute('fill', '#ef4444');
        arrow.setAttribute('opacity', '0.5');
        svgEdges.appendChild(arrow);
      });
    });

    // 3. Artifact edges
    drawArtifactEdges(visibleIds);
  }

  function drawArtifactEdges(visibleBpIds) {
    const visiblePaths = getVisibleArtifactPaths();

    visiblePaths.forEach(path => {
      const reg    = state.artifactRegistry[path];
      const artPos = state.artifactPositions[path];
      if (!reg || !artPos) return;

      const artEl = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
      const artH  = artEl ? artEl.offsetHeight : ARTIFACT_H;

      // Output edges: BP bottom → artifact top (green)
      reg.producers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH = bpEl.offsetHeight;
        drawBezierEdge(
          bpPos.x + NODE_W / 2, bpPos.y + bpH,
          artPos.x + ARTIFACT_W / 2, artPos.y,
          '#34d399', 1.5, '', true
        );
      });

      // Input edges: artifact → BP (blue dashed)
      reg.consumers.forEach(bpId => {
        if (!visibleBpIds.has(bpId)) return;
        const bpPos = state.positions[bpId];
        const bpEl  = canvas.querySelector(`.bp-node[data-id="${bpId}"]`);
        if (!bpPos || !bpEl) return;

        const bpH = bpEl.offsetHeight;
        drawBezierEdge(
          artPos.x + ARTIFACT_W / 2, artPos.y,
          bpPos.x + NODE_W / 2, bpPos.y + bpH,
          '#60a5fa', 1.5, '4 3', true
        );
      });
    });
  }

  function drawBezierEdge(x1, y1, x2, y2, stroke, width, dash, arrow) {
    const cy1 = y1 + (y2 - y1) * 0.4;
    const cy2 = y2 - (y2 - y1) * 0.4;
    const p   = makeSvgPath(`M ${x1} ${y1} C ${x1} ${cy1}, ${x2} ${cy2}, ${x2} ${y2}`);
    p.setAttribute('stroke', stroke);
    p.setAttribute('stroke-width', String(width));
    if (dash) p.setAttribute('stroke-dasharray', dash);
    p.setAttribute('fill', 'none');

    if (arrow) {
      const dx    = 0;          // last control → end: dx = x2 - x2 = 0
      const dy    = y2 - cy2;
      const angle = Math.atan2(dy, dx);
      const size  = 7;
      const ax1   = x2 - size * Math.cos(angle - 0.4);
      const ay1   = y2 - size * Math.sin(angle - 0.4);
      const ax2   = x2 - size * Math.cos(angle + 0.4);
      const ay2   = y2 - size * Math.sin(angle + 0.4);
      const tri   = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      tri.setAttribute('points', `${x2},${y2} ${ax1},${ay1} ${ax2},${ay2}`);
      tri.setAttribute('fill', stroke);
      tri.setAttribute('opacity', '0.7');
      svgEdges.appendChild(tri);
    }
  }

  function makeSvgPath(d) {
    const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
    p.setAttribute('d', d);
    svgEdges.appendChild(p);
    return p;
  }

  // ─── Interactions ────────────────────────────────────────────────────

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

    visible.forEach(n => {
      const pos = state.positions[n.id];
      if (!pos) return;
      const el = canvas.querySelector(`.bp-node[data-id="${n.id}"]`);
      const h  = el ? el.offsetHeight : 90;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + NODE_W);
      maxY = Math.max(maxY, pos.y + h);
    });

    for (const [path, pos] of Object.entries(state.artifactPositions)) {
      const el = canvas.querySelector(`.artifact-node[data-path="${CSS.escape(path)}"]`);
      const h  = el ? el.offsetHeight : ARTIFACT_H;
      minX = Math.min(minX, pos.x);
      minY = Math.min(minY, pos.y);
      maxX = Math.max(maxX, pos.x + ARTIFACT_W);
      maxY = Math.max(maxY, pos.y + h);
    }

    const vw       = viewport.clientWidth;
    const vh       = viewport.clientHeight;
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
    viewport.addEventListener('mousedown', onMousedown);
    window.addEventListener('mousemove', onMousemove);
    window.addEventListener('mouseup', onMouseup);
    viewport.addEventListener('wheel', onWheel, { passive: false });
  }

  function onMousedown(e) {
    if (e.button !== 0) return;
    state.dragging    = true;
    state.userTransform = true;
    state.dragStart   = { x: e.clientX, y: e.clientY };
    state.panStart    = { ...state.pan };
    viewport.style.cursor = 'grabbing';
  }

  function onMousemove(e) {
    if (!state.dragging) return;
    state.pan.x = state.panStart.x + (e.clientX - state.dragStart.x);
    state.pan.y = state.panStart.y + (e.clientY - state.dragStart.y);
    applyTransform();
  }

  function onMouseup() {
    state.dragging = false;
    viewport.style.cursor = 'grab';
  }

  function onWheel(e) {
    e.preventDefault();
    state.userTransform = true;
    const delta   = e.deltaY > 0 ? 0.9 : 1.1;
    const oldZoom = state.zoom;
    state.zoom    = Math.max(0.1, Math.min(3.0, state.zoom * delta));

    const rect = viewport.getBoundingClientRect();
    const mx   = e.clientX - rect.left;
    const my   = e.clientY - rect.top;

    state.pan.x = mx - (mx - state.pan.x) * (state.zoom / oldZoom);
    state.pan.y = my - (my - state.pan.y) * (state.zoom / oldZoom);

    applyTransform();
  }

  function applyTransform() {
    canvas.style.transform = `translate(${state.pan.x}px, ${state.pan.y}px) scale(${state.zoom})`;
    zoomEl.textContent     = Math.round(state.zoom * 100) + '%';
  }

  // ─── Markdown Renderer ────────────────────────────────────────────────

  function renderMarkdown(text) {
    if (!text) return '';

    let html = esc(text);

    const codeBlocks = [];
    html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      let rendered = code.replace(/\n$/, '').split('\n').map(line => {
        if (line.startsWith('+') && !line.startsWith('+++')) return `<span style="color:#34d399">${line}</span>`;
        if (line.startsWith('-') && !line.startsWith('---')) return `<span style="color:#f87171">${line}</span>`;
        return line;
      }).join('\n');
      const placeholder = `\x00CB${codeBlocks.length}\x00`;
      codeBlocks.push(`<pre style="background:#111;padding:8px;border-radius:4px;overflow-x:auto;"><code${lang ? ` data-lang="${lang}"` : ''}>${rendered}</code></pre>`);
      return placeholder;
    });

    const inlineCodes = [];
    html = html.replace(/`([^`]+)`/g, (_, code) => {
      const placeholder = `\x00IC${inlineCodes.length}\x00`;
      inlineCodes.push(`<code style="background:#111;padding:1px 4px;border-radius:3px;">${code}</code>`);
      return placeholder;
    });

    {
      const lines  = html.split('\n');
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
        `<th style="text-align:${aligns[i] || 'left'};padding:4px 8px;border:1px solid #333;">${c.trim()}</th>`
      ).join('');
      const rows = body.trim().split('\n').filter(r => r.trim()).map(row => {
        const tds = stripOuter(row.split('|')).map((c, i) =>
          `<td style="text-align:${aligns[i] || 'left'};padding:4px 8px;border:1px solid #333;">${c.trim()}</td>`
        ).join('');
        return `<tr>${tds}</tr>`;
      }).join('');
      return `<table style="border-collapse:collapse;width:100%;"><thead><tr>${ths}</tr></thead><tbody>${rows}</tbody></table>`;
    });

    html = html.replace(/(^&gt; .+(\n&gt; .+)*)/gm, (match) => {
      const content = match.replace(/^&gt; ?/gm, '');
      return `<blockquote style="border-left:3px solid #555;padding-left:8px;color:#aaa;margin:4px 0;">${content}</blockquote>`;
    });

    html = html.replace(/^#### (.+)$/gm, '<h4 style="margin:6px 0 2px;">$1</h4>');
    html = html.replace(/^### (.+)$/gm,  '<h3 style="margin:6px 0 2px;">$1</h3>');
    html = html.replace(/^## (.+)$/gm,   '<h2 style="margin:6px 0 2px;">$1</h2>');
    html = html.replace(/^# (.+)$/gm,    '<h1 style="margin:6px 0 2px;">$1</h1>');
    html = html.replace(/^---$/gm, '<hr style="border:none;border-top:1px solid #333;">');

    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\*(.+?)\*/g,     '<em>$1</em>');

    html = html.replace(/^- \[ \] (.+)$/gm, '<li style="list-style:none">&#9744; $1</li>');
    html = html.replace(/^- \[x\] (.+)$/gm, '<li style="list-style:none">&#9745; $1</li>');
    html = html.replace(/^\s*- (.+)$/gm, '<li>$1</li>');
    html = html.replace(/^\d+\. (.+)$/gm, '<oli>$1</oli>');

    html = html.replace(/((?:<li[^>]*>.*<\/li>\n?)+)/g, '<ul style="padding-left:16px;margin:4px 0;">$1</ul>');
    html = html.replace(/((?:<oli>.*<\/oli>\n?)+)/g, (m) => {
      return '<ol style="padding-left:16px;margin:4px 0;">' + m.replace(/<\/?oli>/g, t => t.replace('oli', 'li')) + '</ol>';
    });

    html = html.replace(/\n\n+/g, '</p><p>');
    html = '<p style="margin:0 0 4px;">' + html + '</p>';

    const blocks = ['h[1234]', 'table', 'ul', 'ol', 'pre', 'hr', 'blockquote'];
    html = html.replace(/<p[^>]*>\s*<\/p>/g, '');
    blocks.forEach(tag => {
      html = html.replace(new RegExp(`<p[^>]*>\\s*(<${tag}[> ])`, 'g'), '$1');
      html = html.replace(new RegExp(`<p[^>]*>\\s*(<${tag}>)`, 'g'), '$1');
      html = html.replace(new RegExp(`(</${tag}>)\\s*</p>`, 'g'), '$1');
    });

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

  function bpIdLabel(fullId, displayText, extraClass) {
    if (!fullId) return esc(displayText || '');
    const text = (displayText !== undefined && displayText !== null) ? displayText : fullId;
    const cls  = extraClass ? extraClass : '';
    return `<span class="${cls}" data-bp-id="${esc(fullId)}" title="Click to copy ${esc(fullId)}" style="font-size:10px;color:#888;cursor:pointer;font-family:monospace;flex-shrink:0;" onclick="(function(e){e.stopPropagation();var el=e.currentTarget;var id=el.dataset.bpId||el.textContent.trim();if(navigator.clipboard)navigator.clipboard.writeText(id).catch(()=>{});el.style.color='#60a5fa';setTimeout(()=>el.style.color='#888',1000);})(event)">${esc(text)}</span>`;
  }

  // ─── Resize observer ─────────────────────────────────────────────────

  function onResize() {
    layout();
    render();
  }

  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(viewport);

  // ─── Init ─────────────────────────────────────────────────────────────

  setupPanZoom();
  fetchBriefings();

  // ─── Cleanup ──────────────────────────────────────────────────────────

  return function cleanup() {
    viewport.removeEventListener('mousedown', onMousedown);
    window.removeEventListener('mousemove', onMousemove);
    window.removeEventListener('mouseup', onMouseup);
    viewport.removeEventListener('wheel', onWheel);
    resizeObserver.disconnect();
    // Remove injected DOM
    while (viewport.firstChild) viewport.removeChild(viewport.firstChild);
  };
}
