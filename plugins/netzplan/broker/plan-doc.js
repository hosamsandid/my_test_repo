'use strict';

// ─── Network Plan document model (plugin #3, epic #1554, Phase 3, #1563) ──────
//
// The pure, dependency-free core of the board: normalize / validate / migrate /
// mutate one `PlanDoc`, in the `process-template.js` / `plan` discipline (no
// framework, no I/O — the broker's store and the served UI both build on this,
// and it is unit-tested in isolation).
//
// The load-bearing decision (concept §4): **statuses and requirement targets
// key on ids, never array indices.** A positional model makes insert and
// reorder destructive — the board this replaces has neither because its source
// carries manual index-arithmetic scar comments ("index shifted by +1"). With
// ids, inserting a milestone mid-lane changes nothing else; deleting one only
// drops the requirement targets that pointed at it; renaming an owner is one
// edit because lanes reference owners by id, not by a repeated string.
//
//   PlanDoc {
//     version, id, name, teamId, createdAt, updatedAt,
//     settings: { agentAutonomy: 0 | 1 | 2 },   // §8 autonomy ladder
//     owners:   [ { id, name, color } ],
//     panels:   [ Panel, ... ]                  // ordered; add/remove/reorder = a UI action
//   }
//   Swimlane panel (§5):
//     { id, kind: 'swimlane', title,
//       zones:  [ { id, name, hint, color, or, secondary } ],
//       lanes:  [ { id, zoneId, title, sub, ownerId, order,
//                   milestones: [ { id, label, order, done } ] } ],
//       stepColumns:  [ label, ... ],
//       requirements: [ { id, label, color, on, targets: { <laneId>: <milestoneId> } } ] }
//   Graph panel (§5, #1564 — replaces wave graph / detail net / package graph):
//     { id, kind: 'graph', title,
//       bands: [ { id, name, color, order } ],
//       nodes: [ { id, label, sub, ownerId, status, type, bandId, order } ],
//       edges: [ { id, from, to, type } ] }        // typed dependency edges (node→node)
//   Bipartite panel (§5, #1564 — replaces the stream→board-label map):
//     { id, kind: 'bipartite', title,
//       left:  [ { id, label, sub, order } ],
//       right: [ { id, label, sub, order } ],
//       edges: [ { id, from, to, type, muted } ] } // from ∈ left ids, to ∈ right ids
//   Blocks panel (§5, #1564 — replaces cover slide / KPI tiles / callout / cards):
//     { id, kind: 'blocks', title,
//       blocks: [ { id, type, order, heading, subtitle, body,
//                   chips: [ str ], tiles: [ { id, label, value, sub } ], meta } ] }
//
// The three primitives above join `swimlane` so a board is composed of ordered
// `panels[]` rather than six fixed renderers (§5) — `add-panel` / `delete-panel`
// / `reorder-panels` are the composition ops. Every primitive keys its editable
// pieces on ids, never array indices, so insert / reorder / delete stay
// non-destructive and a dangling reference is dropped on normalize (the same
// repair the swimlane relies on).
//
// Everything here is immutable: `applyMutation` deep-clones and returns a new
// document, never mutating its input, so a bounded undo/redo history is just a
// stack of the documents it returns.

const VERSION = 1;

// §8 autonomy ladder: 0 read-only (default), 1 tick, 2 structural edits.
const AUTONOMY_MIN = 0;
const AUTONOMY_MAX = 2;
const PANEL_KINDS = Object.freeze(['swimlane', 'graph', 'bipartite', 'blocks']); // §5: four primitives (swimlane #1563; graph/bipartite/blocks #1564).
const DEFAULT_COLOR = '#64748b'; // slate-500 — a neutral, theme-agnostic default

class PlanValidationError extends Error {}
class PlanMutationError extends Error {}

// ── small pure helpers ───────────────────────────────────────────────────────

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}
function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}
function str(v, fallback = '') {
  return typeof v === 'string' ? v : fallback;
}
function clampAutonomy(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < AUTONOMY_MIN) return AUTONOMY_MIN;
  if (n > AUTONOMY_MAX) return AUTONOMY_MAX;
  return n;
}
function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Deterministic id generation is the caller's job (broker/tests pass ids in the
// op), but a mutation that omits one gets a stable-per-doc fallback so an
// interactive add never collides with an existing id.
function ensureId(op, doc, prefix) {
  if (isNonEmptyString(op && op.id)) return op.id.trim();
  const taken = new Set();
  const add = (x) => { if (x && x.id) taken.add(x.id); };
  for (const o of doc.owners) add(o);
  // Defensive across every panel kind — a panel carries only the arrays its kind
  // defines, so read each optionally (a graph has no `lanes`, a swimlane no
  // `nodes`). Collecting every id keeps a generated id unique board-wide.
  for (const p of doc.panels) {
    add(p);
    for (const z of p.zones || []) add(z);
    for (const l of p.lanes || []) { add(l); for (const m of l.milestones || []) add(m); }
    for (const r of p.requirements || []) add(r);
    for (const b of p.bands || []) add(b);
    for (const nd of p.nodes || []) add(nd);
    for (const e of p.edges || []) add(e);
    for (const en of p.left || []) add(en);
    for (const en of p.right || []) add(en);
    for (const bl of p.blocks || []) { add(bl); for (const t of bl.tiles || []) add(t); }
  }
  let n = 1;
  let id = `${prefix}-${n}`;
  while (taken.has(id)) { n += 1; id = `${prefix}-${n}`; }
  return id;
}

// ── normalize (coerce a raw object into a canonical, referentially-sound doc) ─
//
// Normalization is also *repair*: a target pointing at a deleted lane or
// milestone, a lane pointing at a deleted owner or zone, are silently dropped so
// a stored document can never carry a dangling reference. This is what makes the
// delete operations below able to stay simple — normalize is the safety net.

function normalizeMilestone(input, index) {
  const m = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(m.id) ? m.id.trim() : `m-${index + 1}`,
    label: str(m.label),
    order: Number.isFinite(m.order) ? m.order : index,
    done: m.done === true,
  };
}

function normalizeZone(input, index) {
  const z = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(z.id) ? z.id.trim() : `z-${index + 1}`,
    name: str(z.name),
    hint: str(z.hint),
    color: isNonEmptyString(z.color) ? z.color.trim() : DEFAULT_COLOR,
    or: z.or === true,          // OR zone: any one lane reaching a milestone satisfies the zone (§5)
    secondary: z.secondary === true,
  };
}

function normalizeLane(input, index, zoneIds, ownerIds) {
  const l = isPlainObject(input) ? input : {};
  const zoneId = isNonEmptyString(l.zoneId) && zoneIds.has(l.zoneId.trim()) ? l.zoneId.trim() : null;
  const ownerId = isNonEmptyString(l.ownerId) && ownerIds.has(l.ownerId.trim()) ? l.ownerId.trim() : null;
  const rawMs = Array.isArray(l.milestones) ? l.milestones : [];
  const seen = new Set();
  const milestones = [];
  rawMs.forEach((m, i) => {
    const nm = normalizeMilestone(m, i);
    if (seen.has(nm.id)) return; // ids are unique within a lane
    seen.add(nm.id);
    milestones.push(nm);
  });
  return {
    id: isNonEmptyString(l.id) ? l.id.trim() : `l-${index + 1}`,
    zoneId,
    title: str(l.title),
    sub: str(l.sub),
    ownerId,
    order: Number.isFinite(l.order) ? l.order : index,
    milestones,
  };
}

function normalizeRequirement(input, index, laneById) {
  const r = isPlainObject(input) ? input : {};
  const rawTargets = isPlainObject(r.targets) ? r.targets : {};
  const targets = {};
  // A target is kept only when BOTH its lane and the milestone it points at
  // still exist — this is the "deleting a milestone drops only the targets that
  // pointed at it" guarantee, applied defensively on every load.
  for (const [laneId, milestoneId] of Object.entries(rawTargets)) {
    const lane = laneById.get(laneId);
    if (!lane) continue;
    if (!lane.milestones.some((m) => m.id === milestoneId)) continue;
    targets[laneId] = milestoneId;
  }
  return {
    id: isNonEmptyString(r.id) ? r.id.trim() : `r-${index + 1}`,
    label: str(r.label),
    color: isNonEmptyString(r.color) ? r.color.trim() : DEFAULT_COLOR,
    on: r.on !== false, // default visible
    targets,
  };
}

function normalizeSwimlane(input, index, ownerIds) {
  const p = isPlainObject(input) ? input : {};
  const rawZones = Array.isArray(p.zones) ? p.zones : [];
  const zones = [];
  const zoneSeen = new Set();
  rawZones.forEach((z, i) => {
    const nz = normalizeZone(z, i);
    if (zoneSeen.has(nz.id)) return;
    zoneSeen.add(nz.id);
    zones.push(nz);
  });
  const zoneIds = new Set(zones.map((z) => z.id));

  const rawLanes = Array.isArray(p.lanes) ? p.lanes : [];
  const lanes = [];
  const laneSeen = new Set();
  rawLanes.forEach((l, i) => {
    const nl = normalizeLane(l, i, zoneIds, ownerIds);
    if (laneSeen.has(nl.id)) return;
    laneSeen.add(nl.id);
    lanes.push(nl);
  });
  const laneById = new Map(lanes.map((l) => [l.id, l]));

  const stepColumns = Array.isArray(p.stepColumns) ? p.stepColumns.map((s) => str(s)) : [];

  const rawReqs = Array.isArray(p.requirements) ? p.requirements : [];
  const requirements = [];
  const reqSeen = new Set();
  rawReqs.forEach((r, i) => {
    const nr = normalizeRequirement(r, i, laneById);
    if (reqSeen.has(nr.id)) return;
    reqSeen.add(nr.id);
    requirements.push(nr);
  });

  return {
    id: isNonEmptyString(p.id) ? p.id.trim() : `p-${index + 1}`,
    kind: 'swimlane',
    title: str(p.title),
    zones,
    lanes,
    stepColumns,
    requirements,
  };
}

// ── graph primitive (§5): typed nodes in horizontal bands + dependency edges ──

function normalizeBand(input, index) {
  const b = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(b.id) ? b.id.trim() : `b-${index + 1}`,
    name: str(b.name),
    color: isNonEmptyString(b.color) ? b.color.trim() : DEFAULT_COLOR,
    order: Number.isFinite(b.order) ? b.order : index,
  };
}

function normalizeNode(input, index, bandIds, ownerIds) {
  const n = isPlainObject(input) ? input : {};
  const bandId = isNonEmptyString(n.bandId) && bandIds.has(n.bandId.trim()) ? n.bandId.trim() : null;
  const ownerId = isNonEmptyString(n.ownerId) && ownerIds.has(n.ownerId.trim()) ? n.ownerId.trim() : null;
  return {
    id: isNonEmptyString(n.id) ? n.id.trim() : `n-${index + 1}`,
    label: str(n.label),
    sub: str(n.sub),
    ownerId,
    status: str(n.status),
    type: str(n.type),
    bandId,
    order: Number.isFinite(n.order) ? n.order : index,
  };
}

function normalizeGraph(input, index, ownerIds) {
  const p = isPlainObject(input) ? input : {};

  const bands = [];
  const bandSeen = new Set();
  (Array.isArray(p.bands) ? p.bands : []).forEach((b, i) => {
    const nb = normalizeBand(b, i);
    if (bandSeen.has(nb.id)) return;
    bandSeen.add(nb.id);
    bands.push(nb);
  });
  const bandIds = new Set(bands.map((b) => b.id));

  const nodes = [];
  const nodeSeen = new Set();
  (Array.isArray(p.nodes) ? p.nodes : []).forEach((n, i) => {
    const nn = normalizeNode(n, i, bandIds, ownerIds);
    if (nodeSeen.has(nn.id)) return;
    nodeSeen.add(nn.id);
    nodes.push(nn);
  });
  const nodeIds = new Set(nodes.map((n) => n.id));

  // A dependency edge is kept only when BOTH endpoints still exist (delete a node
  // → its edges vanish, the graph twin of the swimlane's target repair). No
  // self-loops (a node never depends on itself).
  const edges = [];
  const edgeSeen = new Set();
  (Array.isArray(p.edges) ? p.edges : []).forEach((e, i) => {
    const ne = {
      id: isNonEmptyString(e && e.id) ? e.id.trim() : `e-${i + 1}`,
      from: isNonEmptyString(e && e.from) ? e.from.trim() : '',
      to: isNonEmptyString(e && e.to) ? e.to.trim() : '',
      type: str(e && e.type),
    };
    if (!nodeIds.has(ne.from) || !nodeIds.has(ne.to) || ne.from === ne.to) return;
    if (edgeSeen.has(ne.id)) return;
    edgeSeen.add(ne.id);
    edges.push(ne);
  });

  return {
    id: isNonEmptyString(p.id) ? p.id.trim() : `p-${index + 1}`,
    kind: 'graph',
    title: str(p.title),
    bands,
    nodes,
    edges,
  };
}

// ── bipartite primitive (§5): left/right entries + typed, muteable edges ──────

function normalizeEntry(input, index, prefix) {
  const e = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(e.id) ? e.id.trim() : `${prefix}-${index + 1}`,
    label: str(e.label),
    sub: str(e.sub),
    order: Number.isFinite(e.order) ? e.order : index,
  };
}

function normalizeSide(raw, prefix) {
  const out = [];
  const seen = new Set();
  (Array.isArray(raw) ? raw : []).forEach((e, i) => {
    const ne = normalizeEntry(e, i, prefix);
    if (seen.has(ne.id)) return;
    seen.add(ne.id);
    out.push(ne);
  });
  return out;
}

function normalizeBipartite(input, index) {
  const p = isPlainObject(input) ? input : {};
  const left = normalizeSide(p.left, 'L');
  const right = normalizeSide(p.right, 'R');
  const leftIds = new Set(left.map((e) => e.id));
  const rightIds = new Set(right.map((e) => e.id));

  const edges = [];
  const edgeSeen = new Set();
  (Array.isArray(p.edges) ? p.edges : []).forEach((e, i) => {
    const ne = {
      id: isNonEmptyString(e && e.id) ? e.id.trim() : `be-${i + 1}`,
      from: isNonEmptyString(e && e.from) ? e.from.trim() : '',
      to: isNonEmptyString(e && e.to) ? e.to.trim() : '',
      type: str(e && e.type),
      muted: !!(e && e.muted === true),
    };
    if (!leftIds.has(ne.from) || !rightIds.has(ne.to)) return; // drop dangling
    if (edgeSeen.has(ne.id)) return;
    edgeSeen.add(ne.id);
    edges.push(ne);
  });

  return {
    id: isNonEmptyString(p.id) ? p.id.trim() : `p-${index + 1}`,
    kind: 'bipartite',
    title: str(p.title),
    left,
    right,
    edges,
  };
}

// ── blocks primitive (§5): a list of free-form presentation blocks ────────────

function normalizeTile(input, index) {
  const t = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(t.id) ? t.id.trim() : `t-${index + 1}`,
    label: str(t.label),
    value: str(t.value),
    sub: str(t.sub),
  };
}

function normalizeBlock(input, index) {
  const b = isPlainObject(input) ? input : {};
  const tiles = [];
  const tileSeen = new Set();
  (Array.isArray(b.tiles) ? b.tiles : []).forEach((t, i) => {
    const nt = normalizeTile(t, i);
    if (tileSeen.has(nt.id)) return;
    tileSeen.add(nt.id);
    tiles.push(nt);
  });
  return {
    id: isNonEmptyString(b.id) ? b.id.trim() : `bl-${index + 1}`,
    // `type` is a renderer hint (cover / kpi / callout / cards); free string, so
    // the block set can express all four originals with one flexible shape.
    type: isNonEmptyString(b.type) ? b.type.trim() : 'callout',
    order: Number.isFinite(b.order) ? b.order : index,
    heading: str(b.heading),
    subtitle: str(b.subtitle),
    body: str(b.body),
    chips: Array.isArray(b.chips) ? b.chips.map((c) => str(c)) : [],
    tiles,
    meta: str(b.meta),
  };
}

function normalizeBlocks(input, index) {
  const p = isPlainObject(input) ? input : {};
  const blocks = [];
  const seen = new Set();
  (Array.isArray(p.blocks) ? p.blocks : []).forEach((b, i) => {
    const nb = normalizeBlock(b, i);
    if (seen.has(nb.id)) return;
    seen.add(nb.id);
    blocks.push(nb);
  });
  return {
    id: isNonEmptyString(p.id) ? p.id.trim() : `p-${index + 1}`,
    kind: 'blocks',
    title: str(p.title),
    blocks,
  };
}

function normalizePanel(input, index, ownerIds) {
  const kind = isPlainObject(input) && PANEL_KINDS.includes(input.kind) ? input.kind : 'swimlane';
  if (kind === 'graph') return normalizeGraph(input, index, ownerIds);
  if (kind === 'bipartite') return normalizeBipartite(input, index);
  if (kind === 'blocks') return normalizeBlocks(input, index);
  return normalizeSwimlane(input, index, ownerIds);
}

function normalizeOwner(input, index) {
  const o = isPlainObject(input) ? input : {};
  return {
    id: isNonEmptyString(o.id) ? o.id.trim() : `o-${index + 1}`,
    name: str(o.name),
    color: isNonEmptyString(o.color) ? o.color.trim() : DEFAULT_COLOR,
  };
}

function normalizePlanDoc(input, { now = Date.now() } = {}) {
  const d = isPlainObject(input) ? input : {};

  const rawOwners = Array.isArray(d.owners) ? d.owners : [];
  const owners = [];
  const ownerSeen = new Set();
  rawOwners.forEach((o, i) => {
    const no = normalizeOwner(o, i);
    if (ownerSeen.has(no.id)) return;
    ownerSeen.add(no.id);
    owners.push(no);
  });
  const ownerIds = new Set(owners.map((o) => o.id));

  const rawPanels = Array.isArray(d.panels) ? d.panels : [];
  const panels = [];
  const panelSeen = new Set();
  rawPanels.forEach((p, i) => {
    const np = normalizePanel(p, i, ownerIds);
    if (panelSeen.has(np.id)) return;
    panelSeen.add(np.id);
    panels.push(np);
  });

  const settings = isPlainObject(d.settings) ? d.settings : {};
  const createdAt = Number.isFinite(d.createdAt) ? d.createdAt : now;

  return {
    version: VERSION,
    id: isNonEmptyString(d.id) ? d.id.trim() : '',
    name: str(d.name),
    teamId: isNonEmptyString(d.teamId) ? d.teamId.trim() : '',
    createdAt,
    updatedAt: Number.isFinite(d.updatedAt) ? d.updatedAt : createdAt,
    settings: { agentAutonomy: clampAutonomy(settings.agentAutonomy) },
    owners,
    panels,
  };
}

// ── validate (structural — normalize already guarantees referential soundness) ─

function validatePlanDoc(input) {
  const errors = [];
  if (!isPlainObject(input)) return { ok: false, errors: ['document must be an object'] };
  if (input.version !== VERSION) errors.push(`version must be ${VERSION}`);
  if (!isNonEmptyString(input.teamId)) errors.push('teamId is required');
  if (!isPlainObject(input.settings)) errors.push('settings is required');
  else if (
    !Number.isInteger(input.settings.agentAutonomy) ||
    input.settings.agentAutonomy < AUTONOMY_MIN ||
    input.settings.agentAutonomy > AUTONOMY_MAX
  ) {
    errors.push(`settings.agentAutonomy must be an integer in [${AUTONOMY_MIN}, ${AUTONOMY_MAX}]`);
  }
  if (!Array.isArray(input.owners)) errors.push('owners must be an array');
  if (!Array.isArray(input.panels)) errors.push('panels must be an array');
  return { ok: errors.length === 0, errors };
}

// ── migrate (bump older stored documents; the empty board is version 1) ───────
//
// Content migration of the existing hand-edited board is #1566; this is the
// forward-compat hook so a stored doc from a future older-version write is
// re-normalized rather than rejected.

function migratePlanDoc(input, opts = {}) {
  return normalizePlanDoc(input, opts);
}

// ── a fresh, empty board ──────────────────────────────────────────────────────

function newPlanDoc({ id = '', name = '', teamId = '', now = Date.now() } = {}) {
  return normalizePlanDoc(
    {
      id,
      name,
      teamId,
      createdAt: now,
      updatedAt: now,
      settings: { agentAutonomy: AUTONOMY_MIN },
      owners: [],
      // ships with one empty swimlane so there is something to edit; content is
      // added by the user (or imported — #1566), never committed to the repo.
      panels: [{ id: 'p-1', kind: 'swimlane', title: '', zones: [], lanes: [], stepColumns: [], requirements: [] }],
    },
    { now },
  );
}

// ── swimlane meaning-carrying helpers (§5) ────────────────────────────────────
//
// OR zones and requirement lines carry meaning a generic grid would lose, so the
// computation lives here (both the UI and any consumer agree on it), not in a
// renderer.

// Has a specific lane reached (marked done) the milestone with `milestoneId`?
function laneReachedMilestone(lane, milestoneId) {
  if (!lane) return false;
  const m = lane.milestones.find((x) => x.id === milestoneId);
  return !!(m && m.done);
}

// Is `milestoneId` satisfied for the zone containing `lane`? For an OR zone, any
// sibling lane in the same zone reaching it satisfies the zone (the pale
// "covered by a sibling" fill); for a normal zone, only this lane counts.
function zoneSatisfiedAt(panel, lane, milestoneId) {
  if (!lane) return false;
  if (laneReachedMilestone(lane, milestoneId)) return true;
  const zone = panel.zones.find((z) => z.id === lane.zoneId);
  if (!zone || !zone.or) return false;
  return panel.lanes.some(
    (l) => l.zoneId === lane.zoneId && l.id !== lane.id && laneReachedMilestone(l, milestoneId),
  );
}

// ── graph meaning-carrying helper (§5) ────────────────────────────────────────
//
// Hover highlight: which node ids are adjacent to `nodeId` (either edge
// direction), plus the node itself. The UI dims every node NOT in this set —
// computed here so the renderer stays a renderer and any consumer agrees on the
// neighbourhood. Returns a Set (empty if the node isn't in the panel).
function graphNeighbors(panel, nodeId) {
  const set = new Set();
  if (!panel || !Array.isArray(panel.nodes) || !panel.nodes.some((n) => n.id === nodeId)) return set;
  set.add(nodeId);
  for (const e of panel.edges || []) {
    if (e.from === nodeId) set.add(e.to);
    if (e.to === nodeId) set.add(e.from);
  }
  return set;
}

// ── mutations (immutable: return a new document; never touch the input) ───────
//
// Every op is `{ type, ...fields }`. The three that make the acceptance:
//   - insert-milestone shifts no other milestone's status or requirement target
//   - delete-milestone drops only the requirement targets pointing at it
//   - rename-owner touches one owner record; every lane sees it (owners by id)
// are structural consequences of the id-keyed model, not special-cased here.

function findPanel(doc, panelId, expectKind) {
  const p = panelId ? doc.panels.find((x) => x.id === panelId) : doc.panels[0];
  if (!p) throw new PlanMutationError(`unknown panel: ${panelId || '(first)'}`);
  // A kind-scoped op (add-lane on a swimlane, add-node on a graph) must not run
  // against the wrong primitive — it would read arrays that kind doesn't carry.
  if (expectKind && p.kind !== expectKind) {
    throw new PlanMutationError(`panel ${p.id} is a ${p.kind}, not a ${expectKind}`);
  }
  return p;
}
function findLane(panel, laneId) {
  const l = panel.lanes.find((x) => x.id === laneId);
  if (!l) throw new PlanMutationError(`unknown lane: ${laneId}`);
  return l;
}
function reorderById(list, orderedIds) {
  const byId = new Map(list.map((x) => [x.id, x]));
  const out = [];
  for (const id of orderedIds) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  for (const leftover of byId.values()) out.push(leftover); // unlisted keep tail order
  out.forEach((x, i) => { x.order = i; });
  return out;
}
// Insert an item at `index` (append when index is absent/out of range) and
// re-stamp `order` so it reflects position — the add twin of `reorderById`, for
// any list whose items carry an `order` display field (bands, nodes, entries,
// blocks; milestones use their own inline splice).
function insertOrdered(list, item, index) {
  const at = Number.isInteger(index) ? Math.max(0, Math.min(index, list.length)) : list.length;
  list.splice(at, 0, item);
  list.forEach((x, i) => { x.order = i; });
}
// Reorder panels by id WITHOUT stamping an `order` field — a panel's position is
// its array index (normalize emits no `order` for panels), so preserve objects.
function reorderPanels(panels, orderedIds) {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const out = [];
  for (const id of orderedIds) if (byId.has(id)) { out.push(byId.get(id)); byId.delete(id); }
  for (const leftover of byId.values()) out.push(leftover);
  return out;
}

const HANDLERS = {
  'set-autonomy'(doc, op) {
    if (!Number.isInteger(op.level) || op.level < AUTONOMY_MIN || op.level > AUTONOMY_MAX) {
      throw new PlanMutationError(`autonomy level must be an integer in [${AUTONOMY_MIN}, ${AUTONOMY_MAX}]`);
    }
    doc.settings.agentAutonomy = op.level;
  },

  'add-owner'(doc, op) {
    const id = ensureId(op, doc, 'o');
    if (doc.owners.some((o) => o.id === id)) throw new PlanMutationError(`owner id exists: ${id}`);
    doc.owners.push(normalizeOwner({ id, name: op.name, color: op.color }, doc.owners.length));
  },
  'rename-owner'(doc, op) {
    const o = doc.owners.find((x) => x.id === op.id);
    if (!o) throw new PlanMutationError(`unknown owner: ${op.id}`);
    if (op.name !== undefined) o.name = str(op.name);
    if (op.color !== undefined) o.color = isNonEmptyString(op.color) ? op.color.trim() : o.color;
  },
  'delete-owner'(doc, op) {
    const before = doc.owners.length;
    doc.owners = doc.owners.filter((o) => o.id !== op.id);
    if (doc.owners.length === before) throw new PlanMutationError(`unknown owner: ${op.id}`);
    // drop the reference from anything that named this owner — swimlane lanes and
    // graph nodes both carry an ownerId (panel-kind-safe iteration).
    for (const p of doc.panels) {
      for (const l of p.lanes || []) if (l.ownerId === op.id) l.ownerId = null;
      for (const n of p.nodes || []) if (n.ownerId === op.id) n.ownerId = null;
    }
  },

  'add-zone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const id = ensureId(op, doc, 'z');
    if (panel.zones.some((z) => z.id === id)) throw new PlanMutationError(`zone id exists: ${id}`);
    panel.zones.push(normalizeZone({ ...op, id }, panel.zones.length));
  },
  'update-zone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const z = panel.zones.find((x) => x.id === op.id);
    if (!z) throw new PlanMutationError(`unknown zone: ${op.id}`);
    for (const k of ['name', 'hint']) if (op[k] !== undefined) z[k] = str(op[k]);
    if (op.color !== undefined && isNonEmptyString(op.color)) z.color = op.color.trim();
    if (op.or !== undefined) z.or = op.or === true;
    if (op.secondary !== undefined) z.secondary = op.secondary === true;
  },
  'delete-zone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const before = panel.zones.length;
    panel.zones = panel.zones.filter((z) => z.id !== op.id);
    if (panel.zones.length === before) throw new PlanMutationError(`unknown zone: ${op.id}`);
    for (const l of panel.lanes) if (l.zoneId === op.id) l.zoneId = null;
  },
  'reorder-zones'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    panel.zones = reorderById(panel.zones, Array.isArray(op.order) ? op.order : []);
  },

  'add-lane'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const id = ensureId(op, doc, 'l');
    if (panel.lanes.some((l) => l.id === id)) throw new PlanMutationError(`lane id exists: ${id}`);
    const zoneIds = new Set(panel.zones.map((z) => z.id));
    const ownerIds = new Set(doc.owners.map((o) => o.id));
    if (op.zoneId != null && !zoneIds.has(op.zoneId)) throw new PlanMutationError(`unknown zone: ${op.zoneId}`);
    if (op.ownerId != null && !ownerIds.has(op.ownerId)) throw new PlanMutationError(`unknown owner: ${op.ownerId}`);
    panel.lanes.push(normalizeLane({ ...op, id, milestones: [] }, panel.lanes.length, zoneIds, ownerIds));
  },
  'update-lane'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const l = findLane(panel, op.id);
    if (op.title !== undefined) l.title = str(op.title);
    if (op.sub !== undefined) l.sub = str(op.sub);
    if (op.zoneId !== undefined) {
      if (op.zoneId != null && !panel.zones.some((z) => z.id === op.zoneId)) {
        throw new PlanMutationError(`unknown zone: ${op.zoneId}`);
      }
      l.zoneId = op.zoneId == null ? null : op.zoneId;
    }
    if (op.ownerId !== undefined) {
      if (op.ownerId != null && !doc.owners.some((o) => o.id === op.ownerId)) {
        throw new PlanMutationError(`unknown owner: ${op.ownerId}`);
      }
      l.ownerId = op.ownerId == null ? null : op.ownerId;
    }
  },
  'delete-lane'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const before = panel.lanes.length;
    panel.lanes = panel.lanes.filter((l) => l.id !== op.id);
    if (panel.lanes.length === before) throw new PlanMutationError(`unknown lane: ${op.id}`);
    // a requirement target is keyed by lane id → drop this lane's entry
    for (const r of panel.requirements) if (op.id in r.targets) delete r.targets[op.id];
  },
  'reorder-lanes'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    panel.lanes = reorderById(panel.lanes, Array.isArray(op.order) ? op.order : []);
  },

  'add-milestone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const lane = findLane(panel, op.laneId);
    const id = ensureId(op, doc, 'm');
    if (lane.milestones.some((m) => m.id === id)) throw new PlanMutationError(`milestone id exists: ${id}`);
    const m = normalizeMilestone({ id, label: op.label, done: op.done }, lane.milestones.length);
    // Insert at a position WITHOUT renumbering others' ids — order is a display
    // field; ids are the keys, so no status or target moves.
    const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, lane.milestones.length)) : lane.milestones.length;
    lane.milestones.splice(at, 0, m);
    lane.milestones.forEach((x, i) => { x.order = i; });
  },
  'update-milestone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const lane = findLane(panel, op.laneId);
    const m = lane.milestones.find((x) => x.id === op.id);
    if (!m) throw new PlanMutationError(`unknown milestone: ${op.id}`);
    if (op.label !== undefined) m.label = str(op.label);
    if (op.done !== undefined) m.done = op.done === true;
  },
  // `tick` is the level-1 verb: toggle or set a milestone's done flag by id.
  'tick-milestone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    // A milestone id is unique per lane but a tick names only the milestone; find
    // the lane holding it (laneId optional but disambiguates a shared label).
    let lane = op.laneId ? findLane(panel, op.laneId) : null;
    if (!lane) lane = panel.lanes.find((l) => l.milestones.some((m) => m.id === op.id));
    if (!lane) throw new PlanMutationError(`unknown milestone: ${op.id}`);
    const m = lane.milestones.find((x) => x.id === op.id);
    if (!m) throw new PlanMutationError(`unknown milestone: ${op.id}`);
    m.done = op.done === undefined ? !m.done : op.done === true;
  },
  'delete-milestone'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const lane = findLane(panel, op.laneId);
    const before = lane.milestones.length;
    lane.milestones = lane.milestones.filter((m) => m.id !== op.id);
    if (lane.milestones.length === before) throw new PlanMutationError(`unknown milestone: ${op.id}`);
    lane.milestones.forEach((x, i) => { x.order = i; });
    // drop ONLY the requirement targets that pointed at this exact milestone
    for (const r of panel.requirements) {
      if (r.targets[lane.id] === op.id) delete r.targets[lane.id];
    }
  },
  'reorder-milestones'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const lane = findLane(panel, op.laneId);
    lane.milestones = reorderById(lane.milestones, Array.isArray(op.order) ? op.order : []);
  },

  'set-step-columns'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    panel.stepColumns = Array.isArray(op.stepColumns) ? op.stepColumns.map((s) => str(s)) : [];
  },

  'add-requirement'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const id = ensureId(op, doc, 'r');
    if (panel.requirements.some((r) => r.id === id)) throw new PlanMutationError(`requirement id exists: ${id}`);
    panel.requirements.push(normalizeRequirement({ id, label: op.label, color: op.color, on: op.on }, panel.requirements.length, new Map(panel.lanes.map((l) => [l.id, l]))));
  },
  'update-requirement'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const r = panel.requirements.find((x) => x.id === op.id);
    if (!r) throw new PlanMutationError(`unknown requirement: ${op.id}`);
    if (op.label !== undefined) r.label = str(op.label);
    if (op.color !== undefined && isNonEmptyString(op.color)) r.color = op.color.trim();
    if (op.on !== undefined) r.on = op.on === true;
  },
  'delete-requirement'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const before = panel.requirements.length;
    panel.requirements = panel.requirements.filter((r) => r.id !== op.id);
    if (panel.requirements.length === before) throw new PlanMutationError(`unknown requirement: ${op.id}`);
  },
  // Set a per-lane target by naming the milestone — click-the-milestone in the UI.
  'set-requirement-target'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'swimlane');
    const r = panel.requirements.find((x) => x.id === op.id);
    if (!r) throw new PlanMutationError(`unknown requirement: ${op.id}`);
    const lane = findLane(panel, op.laneId);
    if (op.milestoneId == null) { delete r.targets[lane.id]; return; }
    if (!lane.milestones.some((m) => m.id === op.milestoneId)) {
      throw new PlanMutationError(`unknown milestone: ${op.milestoneId}`);
    }
    r.targets[lane.id] = op.milestoneId;
  },

  // ── graph primitive ops (§5) ────────────────────────────────────────────────
  // The node's own `type` / an edge's `type` travel as `nodeType` / `edgeType`
  // in the op, because the op's `type` field is the mutation discriminator.

  'add-band'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const id = ensureId(op, doc, 'b');
    if (panel.bands.some((b) => b.id === id)) throw new PlanMutationError(`band id exists: ${id}`);
    insertOrdered(panel.bands, normalizeBand({ id, name: op.name, color: op.color }, panel.bands.length), op.index);
  },
  'update-band'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const b = panel.bands.find((x) => x.id === op.id);
    if (!b) throw new PlanMutationError(`unknown band: ${op.id}`);
    if (op.name !== undefined) b.name = str(op.name);
    if (op.color !== undefined && isNonEmptyString(op.color)) b.color = op.color.trim();
  },
  'delete-band'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const before = panel.bands.length;
    panel.bands = panel.bands.filter((b) => b.id !== op.id);
    if (panel.bands.length === before) throw new PlanMutationError(`unknown band: ${op.id}`);
    for (const n of panel.nodes) if (n.bandId === op.id) n.bandId = null; // unband, don't delete nodes
  },
  'reorder-bands'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    panel.bands = reorderById(panel.bands, Array.isArray(op.order) ? op.order : []);
  },

  'add-node'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const id = ensureId(op, doc, 'n');
    if (panel.nodes.some((n) => n.id === id)) throw new PlanMutationError(`node id exists: ${id}`);
    const bandIds = new Set(panel.bands.map((b) => b.id));
    const ownerIds = new Set(doc.owners.map((o) => o.id));
    if (op.bandId != null && !bandIds.has(op.bandId)) throw new PlanMutationError(`unknown band: ${op.bandId}`);
    if (op.ownerId != null && !ownerIds.has(op.ownerId)) throw new PlanMutationError(`unknown owner: ${op.ownerId}`);
    const node = normalizeNode(
      { id, label: op.label, sub: op.sub, ownerId: op.ownerId, status: op.status, type: op.nodeType, bandId: op.bandId },
      panel.nodes.length, bandIds, ownerIds,
    );
    insertOrdered(panel.nodes, node, op.index);
  },
  'update-node'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const n = panel.nodes.find((x) => x.id === op.id);
    if (!n) throw new PlanMutationError(`unknown node: ${op.id}`);
    if (op.label !== undefined) n.label = str(op.label);
    if (op.sub !== undefined) n.sub = str(op.sub);
    if (op.status !== undefined) n.status = str(op.status);
    if (op.nodeType !== undefined) n.type = str(op.nodeType);
    if (op.bandId !== undefined) {
      if (op.bandId != null && !panel.bands.some((b) => b.id === op.bandId)) throw new PlanMutationError(`unknown band: ${op.bandId}`);
      n.bandId = op.bandId == null ? null : op.bandId;
    }
    if (op.ownerId !== undefined) {
      if (op.ownerId != null && !doc.owners.some((o) => o.id === op.ownerId)) throw new PlanMutationError(`unknown owner: ${op.ownerId}`);
      n.ownerId = op.ownerId == null ? null : op.ownerId;
    }
  },
  'delete-node'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const before = panel.nodes.length;
    panel.nodes = panel.nodes.filter((n) => n.id !== op.id);
    if (panel.nodes.length === before) throw new PlanMutationError(`unknown node: ${op.id}`);
    // a dependency edge is keyed by node id → drop every edge touching this node
    panel.edges = panel.edges.filter((e) => e.from !== op.id && e.to !== op.id);
  },
  'reorder-nodes'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    panel.nodes = reorderById(panel.nodes, Array.isArray(op.order) ? op.order : []);
  },

  'add-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const id = ensureId(op, doc, 'e');
    if (panel.edges.some((e) => e.id === id)) throw new PlanMutationError(`edge id exists: ${id}`);
    const nodeIds = new Set(panel.nodes.map((n) => n.id));
    if (!nodeIds.has(op.from) || !nodeIds.has(op.to)) throw new PlanMutationError('edge endpoints must be existing nodes');
    if (op.from === op.to) throw new PlanMutationError('an edge cannot connect a node to itself');
    panel.edges.push({ id, from: op.from, to: op.to, type: str(op.edgeType) });
  },
  'update-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const e = panel.edges.find((x) => x.id === op.id);
    if (!e) throw new PlanMutationError(`unknown edge: ${op.id}`);
    if (op.edgeType !== undefined) e.type = str(op.edgeType);
  },
  'delete-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'graph');
    const before = panel.edges.length;
    panel.edges = panel.edges.filter((e) => e.id !== op.id);
    if (panel.edges.length === before) throw new PlanMutationError(`unknown edge: ${op.id}`);
  },

  // ── bipartite primitive ops (§5) ─────────────────────────────────────────────
  // Entry ops name the `side` ("left" | "right"); an edge goes from a left id to
  // a right id, carries an edge `type` (as `edgeType`) and a `muted` flag.

  'add-bip-entry'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const side = op.side === 'right' ? 'right' : op.side === 'left' ? 'left' : null;
    if (!side) throw new PlanMutationError('add-bip-entry requires side "left" or "right"');
    const id = ensureId(op, doc, side === 'left' ? 'L' : 'R');
    if (panel.left.concat(panel.right).some((e) => e.id === id)) throw new PlanMutationError(`entry id exists: ${id}`);
    insertOrdered(panel[side], normalizeEntry({ id, label: op.label, sub: op.sub }, panel[side].length, side === 'left' ? 'L' : 'R'), op.index);
  },
  'update-bip-entry'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const side = op.side === 'right' ? 'right' : 'left';
    const e = panel[side].find((x) => x.id === op.id);
    if (!e) throw new PlanMutationError(`unknown ${side} entry: ${op.id}`);
    if (op.label !== undefined) e.label = str(op.label);
    if (op.sub !== undefined) e.sub = str(op.sub);
  },
  'delete-bip-entry'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const side = op.side === 'right' ? 'right' : 'left';
    const before = panel[side].length;
    panel[side] = panel[side].filter((e) => e.id !== op.id);
    if (panel[side].length === before) throw new PlanMutationError(`unknown ${side} entry: ${op.id}`);
    // drop edges that referenced the removed entry (left→from, right→to)
    panel.edges = panel.edges.filter((e) => (side === 'left' ? e.from !== op.id : e.to !== op.id));
  },
  'reorder-bip-entries'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const side = op.side === 'right' ? 'right' : 'left';
    panel[side] = reorderById(panel[side], Array.isArray(op.order) ? op.order : []);
  },
  'add-bip-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const id = ensureId(op, doc, 'be');
    if (panel.edges.some((e) => e.id === id)) throw new PlanMutationError(`edge id exists: ${id}`);
    if (!panel.left.some((e) => e.id === op.from)) throw new PlanMutationError(`unknown left entry: ${op.from}`);
    if (!panel.right.some((e) => e.id === op.to)) throw new PlanMutationError(`unknown right entry: ${op.to}`);
    panel.edges.push({ id, from: op.from, to: op.to, type: str(op.edgeType), muted: op.muted === true });
  },
  'update-bip-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const e = panel.edges.find((x) => x.id === op.id);
    if (!e) throw new PlanMutationError(`unknown edge: ${op.id}`);
    if (op.edgeType !== undefined) e.type = str(op.edgeType);
    if (op.muted !== undefined) e.muted = op.muted === true; // muted style survives edits
  },
  'delete-bip-edge'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'bipartite');
    const before = panel.edges.length;
    panel.edges = panel.edges.filter((e) => e.id !== op.id);
    if (panel.edges.length === before) throw new PlanMutationError(`unknown edge: ${op.id}`);
  },

  // ── blocks primitive ops (§5) ────────────────────────────────────────────────
  // A block's `type` (cover / kpi / callout / cards) travels as `blockType`.
  // Tiles have no external references, so they are edited wholesale.

  'add-block'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'blocks');
    const id = ensureId(op, doc, 'bl');
    if (panel.blocks.some((b) => b.id === id)) throw new PlanMutationError(`block id exists: ${id}`);
    const block = normalizeBlock(
      { id, type: op.blockType, heading: op.heading, subtitle: op.subtitle, body: op.body, chips: op.chips, tiles: op.tiles, meta: op.meta },
      panel.blocks.length,
    );
    insertOrdered(panel.blocks, block, op.index);
  },
  'update-block'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'blocks');
    const b = panel.blocks.find((x) => x.id === op.id);
    if (!b) throw new PlanMutationError(`unknown block: ${op.id}`);
    if (op.blockType !== undefined && isNonEmptyString(op.blockType)) b.type = op.blockType.trim();
    if (op.heading !== undefined) b.heading = str(op.heading);
    if (op.subtitle !== undefined) b.subtitle = str(op.subtitle);
    if (op.body !== undefined) b.body = str(op.body);
    if (op.meta !== undefined) b.meta = str(op.meta);
    if (op.chips !== undefined) b.chips = Array.isArray(op.chips) ? op.chips.map((c) => str(c)) : [];
    if (op.tiles !== undefined) b.tiles = (Array.isArray(op.tiles) ? op.tiles : []).map((t, i) => normalizeTile(t, i));
  },
  'delete-block'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'blocks');
    const before = panel.blocks.length;
    panel.blocks = panel.blocks.filter((b) => b.id !== op.id);
    if (panel.blocks.length === before) throw new PlanMutationError(`unknown block: ${op.id}`);
  },
  'reorder-blocks'(doc, op) {
    const panel = findPanel(doc, op.panelId, 'blocks');
    panel.blocks = reorderById(panel.blocks, Array.isArray(op.order) ? op.order : []);
  },

  // ── panel composition (§5): a board is an ordered panels[], not six fixed slots ─

  'add-panel'(doc, op) {
    const kind = PANEL_KINDS.includes(op.kind) ? op.kind : 'swimlane';
    const id = ensureId(op, doc, 'p');
    if (doc.panels.some((p) => p.id === id)) throw new PlanMutationError(`panel id exists: ${id}`);
    const ownerIds = new Set(doc.owners.map((o) => o.id));
    const panel = normalizePanel({ id, kind, title: op.title }, doc.panels.length, ownerIds);
    const at = Number.isInteger(op.index) ? Math.max(0, Math.min(op.index, doc.panels.length)) : doc.panels.length;
    doc.panels.splice(at, 0, panel);
  },
  'delete-panel'(doc, op) {
    const before = doc.panels.length;
    doc.panels = doc.panels.filter((p) => p.id !== op.id);
    if (doc.panels.length === before) throw new PlanMutationError(`unknown panel: ${op.id}`);
  },
  'reorder-panels'(doc, op) {
    doc.panels = reorderPanels(doc.panels, Array.isArray(op.order) ? op.order : []);
  },
  // Every panel kind carries a `title`; editing it is one op regardless of kind.
  'set-panel-title'(doc, op) {
    const panel = findPanel(doc, op.id || op.panelId);
    panel.title = str(op.title);
  },
};

function applyMutation(doc, op, { now = Date.now() } = {}) {
  if (!isPlainObject(op) || !isNonEmptyString(op.type)) {
    throw new PlanMutationError('mutation must be an object with a type');
  }
  const handler = HANDLERS[op.type];
  if (!handler) throw new PlanMutationError(`unknown mutation type: ${op.type}`);
  const next = clone(doc);
  handler(next, op);
  next.updatedAt = now;
  // Re-normalize so the returned document is always canonical + referentially
  // sound regardless of how a handler left it.
  return normalizePlanDoc(next, { now: next.createdAt });
}

// Which autonomy level does a given agent write require? Reads are always
// allowed (level 0); ticks need level 1; anything structural needs level 2.
// The broker calls this to enforce the ladder server-side (the CLI mirrors it
// for a clear early error — two defense lines, §8).
const LEVEL_1_OPS = Object.freeze(['tick-milestone', 'update-milestone']);
function requiredAutonomy(opType) {
  if (LEVEL_1_OPS.includes(opType)) return 1;
  return 2; // every other mutation is structural
}

module.exports = {
  VERSION,
  AUTONOMY_MIN,
  AUTONOMY_MAX,
  PANEL_KINDS,
  DEFAULT_COLOR,
  PlanValidationError,
  PlanMutationError,
  normalizePlanDoc,
  validatePlanDoc,
  migratePlanDoc,
  newPlanDoc,
  applyMutation,
  requiredAutonomy,
  laneReachedMilestone,
  zoneSatisfiedAt,
  graphNeighbors,
};
