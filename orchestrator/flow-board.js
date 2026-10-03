// Flow Control board (#2573, concept `docs/flow-control-concept.md` Amendment 3).
//
// A pure, fs-free module: it turns a team's flow graph plus one cheap GitHub
// snapshot and the platform's own logs into the lean "who is working on what"
// board. No I/O here — `orchestrator.js`'s `computeTeamFlowBoard` gathers the
// inputs (one list sweep per repo, no per-PR fan-out) and this module decides.
//
// Three decisions live here, each golden-testable:
//   1. `deriveFlowStages` — the board's columns come from the Flow Editor graph
//      (one stage per agent role in hand-off order, framed by Draft and Done),
//      never from fixed label names, so any vocabulary works.
//   2. Involvement — a work item appears only if a team agent took part (woken
//      by an event on it, created it, pushed to it, or it was released into the
//      flow), which is what keeps Dependabot PRs and the untouched backlog out.
//   3. Position — each row's current stage (the role working now, or the role
//      woken next) and, when nothing will move it without a person, why.
//
// Plus one operator override (#2637): a person may take a row off the board
// ("Remove from board"). The removal lasts until new flow activity on the row
// — `removalRevived` decides that — and never touches the GitHub item.

'use strict';

// Documented mirrors of `flow-anomaly-detector.js` (itself a mirror of
// process-template.js): claim and completed suffixes are states of a wake, not
// wakes, so they never form a hand-off edge.
const CLAIM_SUFFIX = ':wip';
const COMPLETED_SUFFIX = ':completed';

// Stage 0 holds what nobody released yet and no agent is on (#2637): a
// released item already sits at the role it wakes, as "up next".
const DRAFT = 'draft';
const DONE = 'done';

const DEFAULT_DONE_RETENTION_HOURS = 24;
// How long a row may sit with no agent working or woken before the board says
// "no agent is scheduled to continue" — long enough to cover the poller's
// cadence and a hand-off in flight, short enough to catch a dead end today.
const STALL_MS = 30 * 60 * 1000;
// How long a claimed row may read as "working" with no running session and no
// live pool instance behind it before the board says it needs help (#2734).
// A run almost never takes past ~30 min, so a claim label still on the item
// an hour later with nobody alive to finish it is orphaned (the claiming run
// died, was disabled or reaped) — not healthy in-progress work.
const NEEDS_HELP_MS = 60 * 60 * 1000;

const REASONS = Object.freeze({
  flagged: 'flagged for a human',
  conflict: 'conflict with base',
  approval: 'waiting for approval',
  approved: 'approved — waiting for merge',
  checks: 'checks failing',
  stalled: 'no agent is scheduled to continue',
  needsHelp: 'stuck — no progress, needs help',
  noConsumer: 'nobody picks it up — its agent is switched off',
});

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function toMs(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const t = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
}

function itemKey(repo, number) {
  return `${repo}#${Number(number)}`;
}

function labelNames(labels) {
  return (Array.isArray(labels) ? labels : [])
    .map((l) => (typeof l === 'string' ? l : l && l.name))
    .filter((n) => typeof n === 'string' && n);
}

// ---------------------------------------------------------------------------
// Roles — a pool instance counts as its role.
// ---------------------------------------------------------------------------

/**
 * Resolve any agent id (template, live instance, or an instance already reaped)
 * to its role's member id, or null when it is not a member of this team. A
 * reaped instance no longer has a config, so its `<template>-i<item>` id shape
 * is the only evidence left — the same shape `agentPool.poolInstanceId` mints.
 */
function makeRoleResolver(members) {
  const direct = new Map();
  const templates = new Set();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !str(m.id)) continue;
    if (m.poolInstance && str(m.poolOf)) direct.set(m.id, m.poolOf);
    else {
      direct.set(m.id, m.id);
      templates.add(m.id);
    }
  }
  return (agentId) => {
    const id = str(agentId);
    if (!id) return null;
    if (direct.has(id)) return direct.get(id);
    const m = /^(.*)-i(\d+)$/.exec(id);
    if (m && templates.has(m[1])) return m[1];
    return null;
  };
}

// The pool item an instance id encodes (`<template>-i<item>`), or null.
function instanceItem(agentId) {
  const m = /-i(\d+)$/.exec(str(agentId));
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// 1. Stages from the graph.
// ---------------------------------------------------------------------------

function isStateSuffix(label) {
  return label.endsWith(CLAIM_SUFFIX) || label.endsWith(COMPLETED_SUFFIX);
}

/**
 * The hand-off graph between the team's ROLES (pool instances folded into their
 * template). Role B follows role A when B wakes on a label A emits (declared
 * `emits`, trigger emits, or an outcome's setLabel), or when B consumes a
 * channel naming A as its source.
 */
function buildRoleGraph(members, { labels = [], teamId = null } = {}) {
  const gateLabels = new Set(
    (Array.isArray(labels) ? labels : []).filter((l) => l && l.humanGate && str(l.name)).map((l) => str(l.name)),
  );
  const roles = new Map(); // id -> { id, displayName, enabled, consumes:Set, emits:Set, from:Set }
  // Wake label -> roles that listen for it only through a switched-off
  // trigger (#2754): no hand-off edge, but the label is not a person's either.
  const dormantConsumersOf = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !str(m.id) || m.poolInstance) continue;
    const r = {
      id: m.id, displayName: str(m.displayName) || m.id, enabled: m.enabled !== false,
      consumes: new Set(), emits: new Set(), from: new Set(),
    };
    for (const e of Array.isArray(m.emits) ? m.emits : []) if (str(e)) r.emits.add(str(e));
    const opts = m.outcomes && Array.isArray(m.outcomes.options) ? m.outcomes.options : [];
    for (const o of opts) {
      for (const a of (o && Array.isArray(o.actions) ? o.actions : [])) {
        if (a && a.type === 'setLabel' && str(a.label)) r.emits.add(str(a.label));
      }
    }
    for (const t of Array.isArray(m.triggers) ? m.triggers : []) {
      if (t && t.type === 'github-event' && t.enabled === false) {
        const l = str(t.labelFilter);
        if (l && !isStateSuffix(l)) {
          if (!dormantConsumersOf.has(l)) dormantConsumersOf.set(l, []);
          dormantConsumersOf.get(l).push(m.id);
        }
      }
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      for (const e of Array.isArray(t.emits) ? t.emits : []) if (str(e)) r.emits.add(str(e));
      const l = str(t.labelFilter);
      if (l && !isStateSuffix(l)) r.consumes.add(l);
    }
    for (const c of Array.isArray(m.channels) ? m.channels : []) {
      const from = c && str(c.from);
      if (!from) continue;
      r.from.add(from);
      if (teamId) r.from.add(`${teamId}-${from}`);
    }
    roles.set(m.id, r);
  }

  const emitted = new Set();
  for (const r of roles.values()) for (const e of r.emits) emitted.add(e);

  const next = new Map(); // id -> Set(id)
  const prev = new Map();
  for (const id of roles.keys()) {
    next.set(id, new Set());
    prev.set(id, new Set());
  }
  const link = (a, b) => {
    if (a === b) return;
    next.get(a).add(b);
    prev.get(b).add(a);
  };
  for (const b of roles.values()) {
    for (const l of b.consumes) {
      for (const a of roles.values()) if (a.emits.has(l)) link(a.id, b.id);
    }
    for (const f of b.from) if (roles.has(f)) link(f, b.id);
  }

  // Wake label -> consumer roles; used to place a row by the labels it carries.
  const consumersOf = new Map();
  for (const r of roles.values()) {
    for (const l of r.consumes) {
      if (!consumersOf.has(l)) consumersOf.set(l, []);
      consumersOf.get(l).push(r.id);
    }
  }
  // A label an agent sets that no team agent wakes on is a hand-off to a person
  // (e.g. "ready-for-human-review") — the item then waits for approval.
  const toHuman = new Set([...emitted].filter((l) => !consumersOf.has(l) && !isStateSuffix(l)));
  return { roles, next, prev, gateLabels, emitted, consumersOf, dormantConsumersOf, toHuman };
}

/**
 * Order the roles along the flow: breadth-first from the entry roles (those
 * released by a label no team agent sets — a human gate like `ready` — or,
 * failing that, those nothing hands to). A role on several paths is placed
 * once, at its first depth. Within one depth a side/loop-back role (one that
 * only hands back to earlier roles, e.g. a Reworker) comes first, then the
 * role heading the longer remaining path, then the name — so the main line
 * reads left to right towards Done.
 */
function orderRoles(graph) {
  const { roles, next, prev, emitted } = graph;
  const ids = [...roles.keys()];
  if (!ids.length) return [];

  let roots = ids.filter((id) => [...roles.get(id).consumes].some((l) => !emitted.has(l)));
  if (!roots.length) roots = ids.filter((id) => prev.get(id).size === 0 && next.get(id).size > 0);
  if (!roots.length) roots = ids.filter((id) => roles.get(id).consumes.size > 0 || next.get(id).size > 0).slice(0, 1);

  const reach = (from) => {
    const seen = new Set([from]);
    const q = [from];
    while (q.length) for (const n of next.get(q.shift())) if (!seen.has(n)) { seen.add(n); q.push(n); }
    return seen;
  };
  // A root reachable from another root is really mid-flow (e.g. a gate that
  // also re-opens a later stage) — only the true entries start the walk.
  roots = roots.filter((r) => !roots.some((o) => o !== r && reach(o).has(r) && !reach(r).has(o)));

  const depth = new Map();
  const q = [];
  for (const r of roots) { depth.set(r, 0); q.push(r); }
  while (q.length) {
    const a = q.shift();
    for (const b of next.get(a)) {
      if (!depth.has(b)) { depth.set(b, depth.get(a) + 1); q.push(b); }
    }
  }
  const reached = ids.filter((id) => depth.has(id));

  // Longest forward path (edges that go deeper only — acyclic by construction).
  const memo = new Map();
  const ahead = (id) => {
    if (memo.has(id)) return memo.get(id);
    memo.set(id, 0);
    let best = 0;
    for (const n of next.get(id)) if (depth.get(n) > depth.get(id)) best = Math.max(best, 1 + ahead(n));
    memo.set(id, best);
    return best;
  };
  const isSide = (id) => ![...next.get(id)].some((n) => depth.get(n) > depth.get(id)) && [...next.get(id)].some((n) => depth.get(n) < depth.get(id));
  const name = (id) => roles.get(id).displayName.toLowerCase();

  return reached.sort((a, b) =>
    depth.get(a) - depth.get(b) ||
    (isSide(b) ? 1 : 0) - (isSide(a) ? 1 : 0) ||
    ahead(b) - ahead(a) ||
    name(a).localeCompare(name(b)) ||
    a.localeCompare(b),
  );
}

/**
 * Normalize the per-team board config (`flow-board.json`). Every field is
 * optional; an absent config is the automatic derivation.
 *   { doneRetentionHours: 24,
 *     stages: { "<role member id>": { label?: string, hidden?: bool, mergeInto?: "<role member id>" } } }
 */
function normalizeBoardConfig(raw) {
  const out = { doneRetentionHours: DEFAULT_DONE_RETENTION_HOURS, stages: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  const h = Number(raw.doneRetentionHours);
  if (Number.isFinite(h) && h >= 0 && h <= 24 * 30) out.doneRetentionHours = h;
  if (raw.stages && typeof raw.stages === 'object' && !Array.isArray(raw.stages)) {
    for (const [id, v] of Object.entries(raw.stages)) {
      if (!str(id) || !v || typeof v !== 'object') continue;
      const s = {};
      if (str(v.label)) s.label = str(v.label).slice(0, 60);
      if (v.hidden === true) s.hidden = true;
      if (str(v.mergeInto) && str(v.mergeInto) !== id) s.mergeInto = str(v.mergeInto);
      if (Object.keys(s).length) out.stages[id] = s;
    }
  }
  return out;
}

/**
 * The board's columns: Draft, one stage per role in flow order, Done — with the
 * team's optional renames/merges/hides applied. Returns `{ stages, stageOf }`
 * where `stageOf(roleId)` maps a role to the index of the column it shows in
 * (a hidden role shows in the nearest visible stage before it; a merged role
 * in its target's column).
 */
function deriveFlowStages(members, { labels = [], teamId = null, config = null } = {}) {
  const cfg = normalizeBoardConfig(config);
  const graph = buildRoleGraph(members, { labels, teamId });
  const ordered = orderRoles(graph);

  const stages = [{ id: DRAFT, label: 'Draft', roles: [] }];
  const roleStage = new Map();
  const resolveMerge = (id) => {
    const seen = new Set();
    let cur = id;
    while (cfg.stages[cur] && cfg.stages[cur].mergeInto && ordered.includes(cfg.stages[cur].mergeInto) && !seen.has(cur)) {
      seen.add(cur);
      cur = cfg.stages[cur].mergeInto;
    }
    return cur;
  };
  // Pass 1: the visible, unmerged roles become columns.
  for (const id of ordered) {
    const c = cfg.stages[id] || {};
    if (resolveMerge(id) !== id || c.hidden) continue;
    roleStage.set(id, stages.length);
    stages.push({ id, label: c.label || graph.roles.get(id).displayName, roles: [id] });
  }
  // Pass 2: merged roles join their target; hidden ones fall back to the
  // nearest visible stage before them (Draft when there is none).
  let lastVisible = 0;
  for (const id of ordered) {
    if (roleStage.has(id)) { lastVisible = roleStage.get(id); continue; }
    const target = resolveMerge(id);
    const idx = target !== id && roleStage.has(target) ? roleStage.get(target) : lastVisible;
    roleStage.set(id, idx);
    if (idx > 0) stages[idx].roles.push(id);
  }
  stages.push({ id: DONE, label: 'Done', roles: [] });

  return {
    stages,
    stageOf: (roleId) => (roleStage.has(roleId) ? roleStage.get(roleId) : null),
    // Every role in derived order, before rename/merge/hide — what the column
    // dialog edits, so a hidden or merged role can be brought back.
    roles: ordered.map((id) => ({ id, label: graph.roles.get(id).displayName })),
    graph,
    config: cfg,
  };
}

// ---------------------------------------------------------------------------
// 2 + 3. Rows.
// ---------------------------------------------------------------------------

const AGENT_MARKER_RE = /<!--\s*agent:\s*([^\s>]+)\s*-->/g;

function markerAgents(body) {
  const out = [];
  if (typeof body !== 'string') return out;
  AGENT_MARKER_RE.lastIndex = 0;
  let m;
  while ((m = AGENT_MARKER_RE.exec(body)) !== null) out.push(m[1]);
  return out;
}

function isDependabot(item) {
  const login = str(item && item.author).toLowerCase();
  return login.startsWith('dependabot');
}

// `trigger:<tid>:gh:<eventId>` → eventId (the runner's correlation id shape).
// Everything after `:gh:` — platform-minted ids contain a colon themselves
// (`int:<hex>` flow-emit, `intlbl:<hex>` label fast-path, `refire:<hex>`).
function eventIdFromCorrelation(correlationId) {
  const m = /:gh:(.+)$/.exec(str(correlationId));
  return m ? m[1] : null;
}

/**
 * Build the whole board.
 *
 * @param {object} args
 * @param {Array}  args.members   team agents incl. pool instances
 *                                ({id, displayName, emits, triggers, outcomes, channels, poolInstance, poolOf, poolItem, poolRepo})
 * @param {Array}  args.labels    team label registry ({name, humanGate})
 * @param {string} args.teamId
 * @param {object} args.config    per-team board config (see normalizeBoardConfig)
 * @param {object} args.github    { issues:[…], prs:[…] } — see computeTeamFlowBoard for the shape
 * @param {Array}  args.events    github-event-log entries
 * @param {Array}  args.prRecords pr-events-log records (pr-created / branch-pushed)
 * @param {Array}  args.sessions  [{ agentId, session }] running sessions of the team's agents
 * @param {Array}  args.pools     [{ agentId, roleId, displayName, maxInstances, state, changedAt, held, instances:[{instanceId, busy, waiting?, prs?}] }]
 * @param {object} args.removed   rows a person took off the board (see normalizeRemoved)
 * @param {number} args.now
 */
function buildFlowBoard(args = {}) {
  const now = Number.isFinite(args.now) ? args.now : Date.now();
  const members = Array.isArray(args.members) ? args.members : [];
  const { stages, stageOf, graph, config, roles } = deriveFlowStages(members, {
    labels: args.labels, teamId: args.teamId || null, config: args.config,
  });
  const roleOf = makeRoleResolver(members);
  const displayName = (roleId) => (graph.roles.get(roleId) || {}).displayName || roleId;
  const retentionMs = config.doneRetentionHours * 3600 * 1000;
  const removed = normalizeRemoved(args.removed);

  // --- the GitHub snapshot, keyed `<repo>#<n>` -----------------------------
  const items = new Map();
  const gh = args.github || {};
  for (const it of Array.isArray(gh.issues) ? gh.issues : []) {
    if (!it || !str(it.repo) || it.number == null) continue;
    items.set(itemKey(it.repo, it.number), { ...it, kind: 'issue', labels: labelNames(it.labels) });
  }
  for (const pr of Array.isArray(gh.prs) ? gh.prs : []) {
    if (!pr || !str(pr.repo) || pr.number == null) continue;
    items.set(itemKey(pr.repo, pr.number), { ...pr, kind: 'pr', labels: labelNames(pr.labels) });
  }
  const prByBranch = new Map();
  for (const it of items.values()) {
    if (it.kind === 'pr' && str(it.headRef)) prByBranch.set(`${it.repo}@${it.headRef}`, itemKey(it.repo, it.number));
  }

  // --- evidence per item ---------------------------------------------------
  const involved = new Set();
  const wakes = new Map(); // key -> [{ roleId, ts }]
  const firstSeen = new Map(); // key -> ms
  const links = new Map(); // pr key -> issue key
  const eventItem = new Map(); // eventId -> key
  const prCreated = new Map(); // pr key -> ms a team agent opened it
  const seen = (key, ms) => {
    if (ms == null) return;
    if (!firstSeen.has(key) || firstSeen.get(key) > ms) firstSeen.set(key, ms);
  };

  for (const e of Array.isArray(args.events) ? args.events : []) {
    const wi = e && e.workItem;
    if (!wi || wi.number == null || !str(e.repo)) continue;
    const key = itemKey(e.repo, wi.number);
    if (e.eventId != null) eventItem.set(String(e.eventId), key);
    const ts = toMs(e.ts);
    for (const o of Array.isArray(e.outcomes) ? e.outcomes : []) {
      if (!o || o.status !== 'delivered') continue;
      const roleId = roleOf(o.agentId);
      if (!roleId) continue;
      involved.add(key);
      seen(key, ts);
      if (!wakes.has(key)) wakes.set(key, []);
      wakes.get(key).push({ roleId, ts });
    }
  }

  for (const r of Array.isArray(args.prRecords) ? args.prRecords : []) {
    if (!r || !roleOf(r.agentId) || !str(r.repo)) continue;
    if (r.kind === 'pr-created' && r.prNumber != null) {
      const key = itemKey(r.repo, r.prNumber);
      involved.add(key);
      seen(key, toMs(r.ts));
      if (toMs(r.ts) != null) prCreated.set(key, Math.max(prCreated.get(key) || 0, toMs(r.ts)));
      // Which issue this PR belongs to, from the flow itself: the event that
      // woke the run that opened it, else the pool instance's own item, else
      // an explicit closing reference. `Closes #n` is never required.
      let issueKey = null;
      const evId = eventIdFromCorrelation(r.correlationId);
      const evKey = evId && eventItem.get(evId);
      if (evKey && evKey !== key) issueKey = evKey;
      if (!issueKey && instanceItem(r.agentId) != null && instanceItem(r.agentId) !== Number(r.prNumber)) {
        issueKey = itemKey(r.repo, instanceItem(r.agentId));
      }
      if (!issueKey && Array.isArray(r.closes) && r.closes.length) issueKey = itemKey(r.repo, r.closes[0]);
      if (issueKey) links.set(key, issueKey);
    } else if (r.kind === 'branch-pushed' && str(r.branch)) {
      const key = prByBranch.get(`${r.repo}@${str(r.branch)}`);
      if (key) involved.add(key);
    }
  }

  // Released into the flow: the item carries a label a team role wakes on.
  const wakeLabels = new Set(graph.consumersOf.keys());
  const claimToWake = new Map();
  for (const l of wakeLabels) claimToWake.set(`${l}${CLAIM_SUFFIX}`, l);
  for (const [key, it] of items) {
    if (markerAgents(it.body).some((a) => roleOf(a))) involved.add(key);
    if (it.labels.some((l) => wakeLabels.has(l) || claimToWake.has(l))) involved.add(key);
    if (it.kind === 'pr' && !links.has(key) && Array.isArray(it.closes) && it.closes.length) {
      links.set(key, itemKey(it.repo, it.closes[0]));
    }
  }

  // Running sessions (and the pool item they serve) — the "working now" truth.
  const working = new Map(); // key -> [{ roleId, agentId, since }]
  const sessionRows = [];
  for (const s of Array.isArray(args.sessions) ? args.sessions : []) {
    const roleId = s && roleOf(s.agentId);
    if (!roleId) continue;
    const sess = s.session || {};
    const member = members.find((m) => m && m.id === s.agentId) || {};
    let key = null;
    const wi = sess.workItem;
    if (wi && str(wi.repo) && wi.number != null) key = itemKey(wi.repo, wi.number);
    else if (member.poolInstance && str(member.poolRepo) && member.poolItem != null) key = itemKey(member.poolRepo, member.poolItem);
    else if (s.poolRepo && s.poolItem != null) key = itemKey(s.poolRepo, s.poolItem);
    if (key) {
      involved.add(key);
      if (!working.has(key)) working.set(key, []);
      working.get(key).push({ roleId, agentId: s.agentId, since: toMs(sess.startedAt) });
    }
    sessionRows.push({ roleId, agentId: s.agentId, key, session: sess });
  }
  // Items with live work behind them: a running session, or a pool instance
  // still alive for the item (booting, or between runs). A claim on any other
  // item is only a label — `humanBlock` flags it once it outlives NEEDS_HELP_MS.
  const live = new Set(working.keys());
  for (const p of Array.isArray(args.pools) ? args.pools : []) {
    for (const inst of Array.isArray(p && p.instances) ? p.instances : []) {
      const member = members.find((m) => m && inst && m.id === inst.instanceId);
      if (member && member.poolInstance && str(member.poolRepo) && member.poolItem != null) {
        live.add(itemKey(member.poolRepo, member.poolItem));
      }
    }
  }

  // --- rows: an issue plus every PR the flow opened for it -----------------
  const rowOf = new Map(); // item key -> row key
  const rows = new Map();
  const addToRow = (rowKey, key) => {
    if (!rows.has(rowKey)) rows.set(rowKey, { key: rowKey, issueKey: null, prKeys: [] });
    const row = rows.get(rowKey);
    const it = items.get(key);
    if (it && it.kind === 'issue') row.issueKey = key;
    else if (!row.prKeys.includes(key)) row.prKeys.push(key);
    rowOf.set(key, rowKey);
  };
  for (const [key, it] of items) {
    if (it.kind !== 'issue') continue;
    addToRow(key, key);
  }
  for (const [key, it] of items) {
    if (it.kind !== 'pr') continue;
    const issueKey = links.get(key);
    addToRow(issueKey && items.has(issueKey) && items.get(issueKey).kind === 'issue' ? issueKey : key, key);
  }

  const out = [];
  const removedRows = [];
  const matchedRemovals = new Set();
  const revived = [];
  for (const row of rows.values()) {
    const keys = [row.issueKey, ...row.prKeys].filter(Boolean);
    if (!keys.some((k) => involved.has(k))) continue;
    const issue = row.issueKey ? items.get(row.issueKey) : null;
    const prs = row.prKeys.map((k) => items.get(k));
    if (!issue && prs.every(isDependabot)) continue;

    // Done: the issue is closed, or a PR-only row's PR(s) are all closed, or
    // an issue's PRs are all closed with at least one merged.
    let doneAt = null;
    if (issue && issue.state === 'closed') doneAt = toMs(issue.closedAt);
    else if (!issue && prs.length && prs.every((p) => p.state === 'closed')) {
      doneAt = Math.max(...prs.map((p) => toMs(p.mergedAt || p.closedAt) || 0));
    } else if (issue && prs.length && prs.every((p) => p.state === 'closed') && prs.some((p) => p.merged)) {
      doneAt = Math.max(...prs.map((p) => toMs(p.mergedAt || p.closedAt) || 0));
    }
    const isDone = issue ? issue.state === 'closed' || doneAt != null : doneAt != null;
    if (isDone && (doneAt == null || now - doneAt > retentionMs)) continue;

    const position = isDone
      ? { stageIndex: stages.length - 1, status: 'done', roleId: null, agentId: null, since: doneAt }
      : placeRow({ keys, items, working, wakes, firstSeen, graph, stageOf, stages, now });

    const removal = findRemoval(removed, row.key, keys);
    if (removal) {
      matchedRemovals.add(removal.id);
      if (removalRevived({ removal: removal.entry, keys, position, wakes, prCreated })) {
        revived.push(removal.id);
      } else {
        const issueRef = issue ? { repo: issue.repo, number: issue.number } : null;
        removedRows.push({
          id: row.key,
          removalId: removal.id,
          title: (issue && issue.title) || (prs[0] && prs[0].title) || row.key,
          url: (issue && issue.url) || (prs[0] && prs[0].url) || null,
          issue: issueRef,
          prs: prs.map((p) => ({ repo: p.repo, number: p.number })),
          removedAt: removal.entry.removedAt,
        });
        continue;
      }
    }

    const needsHuman = isDone ? null : humanBlock({ keys, items, graph, position, live, now });
    out.push({
      id: row.key,
      title: (issue && issue.title) || (prs[0] && prs[0].title) || row.key,
      url: (issue && issue.url) || (prs[0] && prs[0].url) || null,
      issue: issue ? { repo: issue.repo, number: issue.number, title: issue.title || '', url: issue.url || null, state: issue.state } : null,
      prs: prs.map((p) => ({
        repo: p.repo, number: p.number, title: p.title || '', url: p.url || null,
        state: p.merged ? 'merged' : p.state, draft: !!p.draft,
      })),
      stageId: stages[position.stageIndex].id,
      stageIndex: position.stageIndex,
      status: position.status,
      roleId: position.roleId,
      roleLabel: position.roleId ? displayName(position.roleId) : null,
      agentId: position.agentId,
      since: position.since != null ? new Date(position.since).toISOString() : null,
      done: isDone,
      needsHuman,
      // An agent working on it or queued for it keeps it on the board (#2637 AC5).
      removable: position.status !== 'working' && position.status !== 'queued',
    });
  }
  // Work flows top to bottom: Draft first, then each stage in hand-off order;
  // within a stage the item that entered it most recently on top (a missing
  // `since` counts as oldest); done last, most recently done first. Id breaks
  // ties so a refresh on unchanged data keeps the order.
  const sinceKey = (r) => toMs(r.since) ?? -Infinity;
  out.sort((a, b) =>
    (a.done ? 1 : 0) - (b.done ? 1 : 0) ||
    a.stageIndex - b.stageIndex ||
    (sinceKey(b) > sinceKey(a) ? 1 : sinceKey(b) < sinceKey(a) ? -1 : 0) ||
    a.id.localeCompare(b.id),
  );

  const byId = new Map(out.map((r) => [r.id, r]));
  const needsHuman = out
    .filter((r) => r.needsHuman)
    .map((r) => ({
      id: r.id, title: r.title, url: r.url, issue: r.issue, prs: r.prs, reason: r.needsHuman.reason, since: r.needsHuman.since,
      ...(r.needsHuman.release ? { release: r.needsHuman.release } : {}),
    }))
    .sort((a, b) => (toMs(a.since) || now) - (toMs(b.since) || now));

  // --- area ①: every running session, and each pool's load ----------------
  const sessions = sessionRows.map(({ roleId, agentId, key, session }) => {
    const rowId = key ? rowOf.get(key) : null;
    const r = rowId ? byId.get(rowId) : null;
    // A session pointing at an item that is no longer on the board (closed,
    // or never involved) keeps its run but loses the stale link — it must
    // never resurrect a ghost row.
    const live = r && !r.done ? r : null;
    const member = members.find((m) => m && m.id === agentId) || {};
    return {
      id: `${agentId}:${session.id || ''}`,
      agentId,
      roleId,
      roleLabel: displayName(roleId),
      instance: member.poolInstance && member.poolItem != null
        ? Number(member.poolItem)
        : (roleId !== agentId ? instanceItem(agentId) : null),
      rowId: live ? live.id : null,
      title: live ? live.title : null,
      issue: live ? live.issue : null,
      prs: live ? live.prs : [],
      startedAt: session.startedAt || null,
    };
  }).sort((a, b) => (toMs(a.startedAt) || now) - (toMs(b.startedAt) || now));

  const busyAgents = new Set(sessionRows.map((s) => s.agentId));
  const pools = (Array.isArray(args.pools) ? args.pools : []).map((p) => {
    const instances = Array.isArray(p.instances) ? p.instances : [];
    const isBusy = (i) => i && (i.busy || busyAgents.has(i.instanceId));
    const busy = instances.filter(isBusy).length;
    // #2789: idle instances kept alive for an open PR — outside the cap.
    const waiting = instances.filter((i) => i && i.waiting && !isBusy(i)).length;
    return {
      agentId: p.agentId,
      roleId: p.roleId,
      label: displayName(p.agentId) || p.displayName || p.roleId,
      busy,
      capacity: Number.isFinite(p.maxInstances) ? p.maxInstances : null,
      live: instances.length,
      waiting,
      state: p.state || 'running',
      changedAt: p.changedAt || null,
      held: Number.isFinite(p.held) ? p.held : 0,
    };
  });

  return {
    stages: stages.map(({ id, label, roles: r }) => ({ id, label, roles: r })),
    roles,
    rows: out,
    needsHuman,
    sessions,
    pools,
    doneRetentionHours: config.doneRetentionHours,
    removed: removedRows.sort((a, b) => (toMs(b.removedAt) || 0) - (toMs(a.removedAt) || 0) || a.id.localeCompare(b.id)),
    // Stored removals that no longer hide anything: revived by flow activity,
    // or their row is gone from the snapshot (closed and aged out, deleted,
    // no longer swept). The orchestrator drops them from the store (AC11).
    removalsToPrune: [...revived, ...Object.keys(removed).filter((id) => !matchedRemovals.has(id) && !revived.includes(id))],
  };
}

// ---------------------------------------------------------------------------
// Remove from board (#2637).
// ---------------------------------------------------------------------------

/**
 * Normalize the per-team removal store (`flow-board-removed.json`):
 *   { "<row id>": { removedAt: ISO, keys: ["<repo>#<n>", …] } }
 * The row id is the row's own key (`<repo>#<n>` of its issue, or of its PR for
 * a PR-only row); `keys` are every item the row held when it was removed, so
 * a row that re-forms around another of its items is still recognised.
 */
function normalizeRemoved(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    if (!str(id) || !v || typeof v !== 'object' || toMs(v.removedAt) == null) continue;
    const keys = (Array.isArray(v.keys) ? v.keys : []).filter((k) => str(k));
    out[id] = { removedAt: new Date(toMs(v.removedAt)).toISOString(), keys: keys.includes(id) ? keys : [id, ...keys] };
  }
  return out;
}

function findRemoval(removed, rowKey, keys) {
  if (removed[rowKey]) return { id: rowKey, entry: removed[rowKey] };
  for (const [id, entry] of Object.entries(removed)) {
    if (entry.keys.some((k) => keys.includes(k))) return { id, entry };
  }
  return null;
}

/**
 * Whether a removed row has had new flow activity since it was removed (AC8):
 * an agent working on it or woken for it (session, claim or wake label), an
 * event delivered to a team agent on any of its items, or a team agent opening
 * a PR for it. Edits, comments and cross-references only bump `updatedAt`,
 * which is deliberately not consulted.
 */
function removalRevived({ removal, keys, position, wakes, prCreated }) {
  if (position.status === 'working' || position.status === 'queued') return true;
  const at = toMs(removal.removedAt);
  for (const key of keys) {
    if ((wakes.get(key) || []).some((w) => w.ts != null && w.ts > at)) return true;
    if (prCreated.has(key) && prCreated.get(key) > at) return true;
  }
  return false;
}

// Where a row stands: the most advanced of its items' positions. Evidence in
// order of strength — a running session (working), a claim label (working),
// a wake label (woken next), the last delivered wake (idle at that role),
// else Draft — nobody released it and no agent is on it.
function placeRow({ keys, items, working, wakes, firstSeen, graph, stageOf, stages, now }) {
  const cands = [];
  const push = (roleId, status, since, agentId = null) => {
    const idx = stageOf(roleId);
    if (idx == null) return;
    cands.push({ stageIndex: idx, status, roleId, agentId, since });
  };
  for (const key of keys) {
    const it = items.get(key);
    if (!it || it.state === 'closed') continue;
    for (const w of working.get(key) || []) push(w.roleId, 'working', w.since, w.agentId);
    const updated = toMs(it.updatedAt);
    for (const l of it.labels) {
      if (l.endsWith(CLAIM_SUFFIX)) {
        const wake = l.slice(0, -CLAIM_SUFFIX.length);
        for (const r of graph.consumersOf.get(wake) || []) push(r, 'working', lastWakeTs(wakes, key, r) || updated);
      } else if (graph.consumersOf.has(l)) {
        for (const r of graph.consumersOf.get(l)) push(r, 'queued', lastWakeTs(wakes, key, r) || updated);
      }
    }
    const ws = wakes.get(key) || [];
    if (ws.length) {
      const last = ws.reduce((a, b) => ((b.ts || 0) >= (a.ts || 0) ? b : a));
      push(last.roleId, 'idle', last.ts);
    }
  }
  const rank = { working: 3, queued: 2, idle: 1 };
  if (cands.length) {
    cands.sort((a, b) => b.stageIndex - a.stageIndex || rank[b.status] - rank[a.status]);
    // Most advanced stage wins; among the candidates at that stage, the
    // strongest evidence — but an idle "last woke here" never outranks an
    // agent actually working or queued on another of the row's items.
    const live = cands.filter((c) => c.status !== 'idle');
    return live.length ? live[0] : cands[0];
  }
  const since = Math.min(...keys.map((k) => firstSeen.get(k) || toMs((items.get(k) || {}).updatedAt) || now));
  return { stageIndex: 0, status: DRAFT, roleId: null, agentId: null, since: Number.isFinite(since) ? since : null };
}

function lastWakeTs(wakes, key, roleId) {
  let ts = null;
  for (const w of wakes.get(key) || []) if (w.roleId === roleId && (ts == null || (w.ts || 0) > ts)) ts = w.ts;
  return ts;
}

// Why nothing will move this row without a person, or null. Only when no
// agent is working on it or woken for it — a Conflict Solver already queued
// on a conflict is not a human's problem — except a claim nobody alive holds:
// past NEEDS_HELP_MS it is an orphaned `:wip` label, not work (#2734). The
// flag never touches a run itself; it carries the `release` list (each
// orphaned claim and the wake it swaps back to) that the board's explicit
// "Release claim" action acts on (#2754).
//
// A wake (or its claim) whose every consumer is switched off is reported as
// `noConsumer` instead (#2754): releasing it would wake nobody, so it is not
// "stuck" but dead-ended until someone switches the agent back on.
function humanBlock({ keys, items, graph, position, live = new Set(), now }) {
  const open = keys.map((k) => items.get(k)).filter((it) => it && it.state !== 'closed');
  const since = (it) => toMs(it.updatedAt) || position.since || now;
  const flagged = open.find((it) => it.labels.includes('needs-human'));
  if (flagged) return { reason: REASONS.flagged, since: new Date(since(flagged)).toISOString() };
  const isLive = keys.some((k) => live.has(k));
  if (!isLive) {
    // Only when NO wake on the row can run: one live consumer still moves it.
    const wakeItems = open.filter((it) => it.labels.some((l) => isWake(graph, wakeOf(l))));
    const allDead = wakeItems.length && wakeItems.every((it) =>
      it.labels.filter((l) => isWake(graph, wakeOf(l))).every((l) => wakeHasNoLiveConsumer(graph, wakeOf(l))));
    if (allDead) return { reason: REASONS.noConsumer, since: new Date(since(wakeItems[0])).toISOString() };
  }
  if (
    position.status === 'working' && position.since != null && now - position.since > NEEDS_HELP_MS && !isLive
  ) {
    const release = [];
    for (const it of open) {
      for (const l of it.labels) {
        if (!l.endsWith(CLAIM_SUFFIX)) continue;
        const wake = wakeOf(l);
        if (!graph.consumersOf.has(wake) || wakeHasNoLiveConsumer(graph, wake)) continue;
        // The #2713 shape: the wake was re-applied on top of the claim. Re-adding
        // a label already present creates no `labeled` event, so the swap must
        // take the wake off and put it back (#2754 review).
        release.push({
          repo: it.repo, number: it.number, kind: it.kind, claim: l, wake,
          ...(it.labels.includes(wake) ? { wakePresent: true } : {}),
        });
      }
    }
    return {
      reason: REASONS.needsHelp,
      since: new Date(position.since).toISOString(),
      ...(release.length ? { release } : {}),
    };
  }
  if (position.status === 'working' || position.status === 'queued') return null;
  const prs = open.filter((it) => it.kind === 'pr');
  const conflict = prs.find((p) => p.mergeable === 'CONFLICTING');
  if (conflict) return { reason: REASONS.conflict, since: new Date(since(conflict)).toISOString() };
  const handed = open.find((it) => it.labels.some((l) => graph.toHuman.has(l)));
  if (handed) return { reason: REASONS.approval, since: new Date(since(handed)).toISOString() };
  const approved = prs.find((p) => p.reviewDecision === 'APPROVED' && p.checks !== 'failing' && p.checks !== 'pending');
  if (approved) return { reason: REASONS.approved, since: new Date(since(approved)).toISOString() };
  const failing = prs.find((p) => p.checks === 'failing');
  if (failing) return { reason: REASONS.checks, since: new Date(since(failing)).toISOString() };
  if (position.status === 'idle' && position.since != null && now - position.since > STALL_MS) {
    return { reason: REASONS.stalled, since: new Date(position.since).toISOString() };
  }
  return null;
}

// The wake a label stands for: itself, or the wake its `:wip` claim holds.
function wakeOf(label) {
  return label.endsWith(CLAIM_SUFFIX) ? label.slice(0, -CLAIM_SUFFIX.length) : label;
}

// Whether some team agent listens for `wake`, switched on or off.
function isWake(graph, wake) {
  return graph.consumersOf.has(wake) || !!(graph.dormantConsumersOf && graph.dormantConsumersOf.has(wake));
}

// Whether `wake` is a label some team agent listens for, yet every listener is
// off — the agent disabled, or its only trigger on that label disabled.
function wakeHasNoLiveConsumer(graph, wake) {
  if (!isWake(graph, wake)) return false;
  const active = graph.consumersOf.get(wake) || [];
  return active.every((id) => graph.roles.get(id) && graph.roles.get(id).enabled === false);
}

// Map a GraphQL PR node's statusCheckRollup state onto the board's three
// check states. Pending wins over failing so "checks failing" is only said
// once nothing is still running.
function checksState(rollupState) {
  switch (str(rollupState).toUpperCase()) {
    case 'SUCCESS': return 'passing';
    case 'PENDING':
    case 'EXPECTED': return 'pending';
    case 'FAILURE':
    case 'ERROR': return 'failing';
    default: return null;
  }
}

module.exports = {
  DEFAULT_DONE_RETENTION_HOURS,
  STALL_MS,
  NEEDS_HELP_MS,
  REASONS,
  buildRoleGraph,
  orderRoles,
  normalizeBoardConfig,
  normalizeRemoved,
  deriveFlowStages,
  makeRoleResolver,
  eventIdFromCorrelation,
  markerAgents,
  checksState,
  buildFlowBoard,
};
