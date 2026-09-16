'use strict';

// Pure work-item attribution for token-usage records (#655, §3 + §5 view 2 of
// docs/cost-per-pr-concept.md). View 1 (usage-summary.js) answers "what does
// agent/team/model consume"; this answers "what did resolving issue↔PR chain X
// cost, split by role". No proration, no averaging: every run is counted exactly
// once and the unattributed remainder is always reported (§2 Rule 2).
//
// Inputs: the canonical usage records (§4.1, from usage-log reader) and the
// PR-link records (§4.2, from pr-events-log reader). Team scoping is applied by
// the caller (route) before this module runs, exactly like usage-summary.
//
// The unit is the WORK ITEM = a connected component of the artifact graph (§3.1):
// GitHub issues and PRs are nodes; `closes #N` links (PR body + head branch) are
// edges; a run attaches to one artifact via its strongest signal (§3.2 tiers).
// Follow-up PRs that close the same issue join the same component automatically,
// so BA→Dev→Reviewer→Reworker falls out with zero per-flow configuration.

const TOKEN_CLASSES = ['input', 'output', 'cacheCreationInput', 'cacheReadInput'];

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function zeroTokens() {
  return { input: 0, output: 0, cacheCreationInput: 0, cacheReadInput: 0 };
}

function addTokens(acc, tokens) {
  for (const k of TOKEN_CLASSES) acc[k] += num(tokens && tokens[k]);
}

function withTotal(tokens) {
  const total = TOKEN_CLASSES.reduce((s, k) => s + num(tokens[k]), 0);
  return { ...tokens, total };
}

// since inclusive, until exclusive (half-open) — clean day-boundary queries.
// Identical semantics to usage-summary.inRange so the two views agree on totals.
function inRange(ts, since, until) {
  if (typeof ts !== 'string' || !ts) return false;
  if (since && ts < since) return false;
  if (until && ts >= until) return false;
  return true;
}

// ── Artifact-graph node keys ────────────────────────────────────────────────
// A run/PR references an artifact by (type, repo, number); the flow-instance
// signal (§3.3, dormant until chain instantiation ships) is a node too.
const artifactNode = (type, repo, number) => `${type}:${repo}#${number}`;
const flowNode = (id) => `flow:${id}`;

function parseNode(key) {
  const m = /^(pr|issue):(.+)#(\d+)$/.exec(key);
  if (m) return { kind: m[1], repo: m[2], number: Number(m[3]) };
  if (key.startsWith('flow:')) return { kind: 'flow', id: key.slice('flow:'.length) };
  return { kind: 'unknown', key };
}

// ── Union-find over artifact nodes (connected components = work items) ────────
function makeUF() {
  const parent = new Map();
  const add = (x) => { if (!parent.has(x)) parent.set(x, x); };
  const find = (x) => {
    add(x);
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) { const n = parent.get(x); parent.set(x, r); x = n; }
    return r;
  };
  const union = (a, b) => { add(a); add(b); parent.set(find(a), find(b)); };
  return { add, find, union, nodes: () => [...parent.keys()] };
}

// ── Attribution: one run -> its strongest signal (§3.2) ───────────────────────
// Returns { tier, artifacts: [nodeKey…], flow: nodeKey|null }. `artifacts` is the
// set of GitHub artifacts the run attaches to (usually one; >1 => `shared`). The
// tiers, strongest first: 0 (flow instance) > A (created the PR) > B (ran on an
// issue/PR event) > C (worked on a PR's head branch) > ∅ (none).
function attributeRun(rec, ctx) {
  const artifacts = [];
  let tier = null;

  // Tier A — this invocation opened the PR (exact). correlationId travels via
  // AEE_CORRELATION_ID -> gh-as-agent -> pr-created record.
  const cid = rec.correlationId;
  if (cid != null && ctx.prByCorrelation.has(cid)) {
    for (const node of ctx.prByCorrelation.get(cid)) artifacts.push(node);
    tier = 'A';
  }

  // Tier B — ran on an issue/PR event (exact); the number is stamped on the
  // record's `github` block at run start (already persisted since phase 1).
  if (tier === null && rec.github && rec.github.repo) {
    const g = rec.github;
    if (Number.isInteger(g.prNumber) && g.prNumber > 0) artifacts.push(artifactNode('pr', g.repo, g.prNumber));
    if (Number.isInteger(g.issueNumber) && g.issueNumber > 0) artifacts.push(artifactNode('issue', g.repo, g.issueNumber));
    if (artifacts.length) tier = 'B';
  }

  // Tier C — committed on a branch that is some PR's head (strong heuristic).
  // "Agent authorship" (§3.2) is enforced at read time by the proxy that the run
  // (a) is emitted by an agent and (b) actually moved HEAD (committed) — agents
  // commit via gh-as-agent, which stamps @agents.local authorship by construction.
  //
  // The usage record's git context only knows the SHORT clone-dir repo name, while
  // the pr-created record keys artifacts on the full owner/name. So match on the
  // branch (unique per PR head) and confirm the short name is the tail of the
  // pr-created repo's owner/name before minting the (full-name) artifact node.
  if (tier === null && rec.git && rec.git.repo && rec.git.branch &&
      rec.git.headAfter && rec.git.headAfter !== rec.git.headBefore) {
    const hit = ctx.prByHeadBranch.get(rec.git.branch);
    if (hit && hit.repoFull.split('/').pop() === rec.git.repo) {
      artifacts.push(artifactNode('pr', hit.repoFull, hit.prNumber));
      tier = 'C';
    }
  }

  // Tier 0 — flow instance (§3.3, reserved). Stronger than the artifact graph and
  // covers hand-offs that never pass an issue/PR event. Groups the run (and any
  // artifact it also matched) under the instance; dormant while flowInstanceId is
  // null on every record.
  let flow = null;
  if (rec.flowInstanceId != null && rec.flowInstanceId !== '') {
    flow = flowNode(rec.flowInstanceId);
    tier = '0';
  }

  return { tier, artifacts, flow };
}

// Fan a record's per-model usage into an accumulator map { model -> tokens }.
function addModelUsage(byModel, modelUsage) {
  if (!modelUsage || typeof modelUsage !== 'object') return;
  for (const model of Object.keys(modelUsage)) {
    if (!byModel.has(model)) byModel.set(model, zeroTokens());
    addTokens(byModel.get(model), modelUsage[model]);
  }
}

function modelMapToObject(byModel) {
  const out = {};
  for (const [model, tok] of [...byModel.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    out[model] = withTotal(tok);
  }
  return out;
}

// Build the artifact graph + attribute every in-range run. Returns the internal
// working state shared by buildWorkItems and workItemDetail so the two never drift.
function attribute(usageRecords, prEvents, { since = null, until = null } = {}) {
  const uf = makeUF();
  const prByCorrelation = new Map(); // correlationId -> [prNode…]
  const prByHeadBranch = new Map();  // branch -> { prNumber, repoFull } (tier C)

  // Pass 1: graph nodes + edges from pr-created records (all days, not windowed —
  // a PR opened before the window can still own runs inside it).
  for (const ev of Array.isArray(prEvents) ? prEvents : []) {
    if (!ev || ev.kind !== 'pr-created' || !ev.repo) continue;
    if (!(Number.isInteger(ev.prNumber) && ev.prNumber > 0)) continue;
    const prKey = artifactNode('pr', ev.repo, ev.prNumber);
    uf.add(prKey);
    if (ev.correlationId != null) {
      if (!prByCorrelation.has(ev.correlationId)) prByCorrelation.set(ev.correlationId, []);
      if (!prByCorrelation.get(ev.correlationId).includes(prKey)) prByCorrelation.get(ev.correlationId).push(prKey);
    }
    if (typeof ev.branch === 'string' && ev.branch) prByHeadBranch.set(ev.branch, { prNumber: ev.prNumber, repoFull: ev.repo });
    for (const c of Array.isArray(ev.closes) ? ev.closes : []) {
      if (Number.isInteger(c) && c > 0) uf.union(prKey, artifactNode('issue', ev.repo, c));
    }
  }

  // Pass 2: attribute each in-range run; add its artifacts/flow to the graph.
  const runs = []; // { rec, tier, artifacts, flow, primary }
  for (const rec of Array.isArray(usageRecords) ? usageRecords : []) {
    if (!rec || !inRange(rec.ts, since, until)) continue;
    const { tier, artifacts, flow } = attributeRun(rec, { prByCorrelation, prByHeadBranch });
    for (const a of artifacts) uf.add(a);
    if (flow) {
      uf.add(flow);
      for (const a of artifacts) uf.union(flow, a); // flow instance unifies its artifacts
    }
    // Primary node: the run's tokens are counted in exactly one component.
    let primary = null;
    if (flow) primary = flow;
    else if (artifacts.length) {
      // Prefer a PR node over an issue node; break ties by lowest number (stable).
      const sorted = [...artifacts].sort((x, y) => {
        const px = parseNode(x); const py = parseNode(y);
        if (px.kind !== py.kind) return px.kind === 'pr' ? -1 : 1;
        return (px.number || 0) - (py.number || 0);
      });
      primary = sorted[0];
    }
    runs.push({ rec, tier, artifacts, flow, primary });
  }

  return { uf, runs };
}

// Assemble per-component (work-item) accumulators from attributed runs.
function assembleComponents({ uf, runs }) {
  const comps = new Map(); // root -> component accumulator

  const compOf = (root) => {
    if (!comps.has(root)) {
      comps.set(root, {
        nodes: new Set(),
        tokens: zeroTokens(),
        byModel: new Map(),
        runs: 0,
        agents: new Map(), // agentId -> { roleId, runs }
        tiers: { '0': 0, A: 0, B: 0, C: 0 },
        shared: false,
        runRows: [], // for drill-down
        flowIds: new Set(),
      });
    }
    return comps.get(root);
  };

  // Seed component node membership from the union-find (so an issue with no runs
  // yet, or a PR's linked issue, still appears in its work item's artifact list).
  for (const node of uf.nodes()) compOf(uf.find(node)).nodes.add(node);

  for (const r of runs) {
    if (!r.primary) continue; // tier ∅ — handled as the unattributed remainder
    const root = uf.find(r.primary);
    const comp = compOf(root);
    const rec = r.rec;

    addTokens(comp.tokens, rec.tokens);
    addModelUsage(comp.byModel, rec.modelUsage);
    comp.runs += 1;
    if (r.tier && comp.tiers[r.tier] != null) comp.tiers[r.tier] += 1;

    const ag = comp.agents.get(rec.agentId) || { roleId: rec.roleId || null, runs: 0 };
    ag.runs += 1;
    if (!ag.roleId && rec.roleId) ag.roleId = rec.roleId;
    comp.agents.set(rec.agentId, ag);

    if (r.flow) comp.flowIds.add(r.flow);

    // A run whose artifacts span >1 component is shared: tokens count once (here,
    // in the primary component); the other components list it without adding tokens.
    const otherRoots = new Set();
    for (const a of r.artifacts) { const rr = uf.find(a); if (rr !== root) otherRoots.add(rr); }
    if (r.flow) { const fr = uf.find(r.flow); if (fr !== root) otherRoots.add(fr); }
    if (otherRoots.size) {
      comp.shared = true;
      for (const rr of otherRoots) compOf(rr).shared = true;
    }

    comp.runRows.push({
      ts: rec.ts || null,
      agentId: rec.agentId || null,
      roleId: rec.roleId || null,
      correlationId: rec.correlationId || null,
      sessionId: rec.sessionId || null,
      tier: r.tier,
      artifact: r.primary,
      shared: otherRoots.size > 0,
      tokens: withTotal({ ...zeroTokens(), ...pickTokens(rec.tokens) }),
    });
  }

  // Data-quality flag (§3.3): a component carrying >1 distinct flow instance means
  // two instances collided on one artifact chain — surfaced, never silently merged.
  for (const comp of comps.values()) comp.flowMismatch = comp.flowIds.size > 1;

  return comps;
}

function pickTokens(tokens) {
  const out = {};
  for (const k of TOKEN_CLASSES) out[k] = num(tokens && tokens[k]);
  return out;
}

// Render a component accumulator into the public work-item shape.
function renderWorkItem(root, comp) {
  const issues = [];
  const prs = [];
  const repos = new Set();
  for (const key of comp.nodes) {
    const n = parseNode(key);
    if (n.kind === 'issue') { issues.push(n.number); repos.add(n.repo); }
    else if (n.kind === 'pr') { prs.push(n.number); repos.add(n.repo); }
  }
  issues.sort((a, b) => a - b);
  prs.sort((a, b) => a - b);
  const repoList = [...repos].sort();
  const repo = repoList.length === 1 ? repoList[0] : (repoList[0] || null);

  const agents = [...comp.agents.entries()]
    .map(([agentId, a]) => ({ agentId, roleId: a.roleId || null, runs: a.runs }))
    .sort((x, y) => y.runs - x.runs || (x.agentId < y.agentId ? -1 : 1));

  // Started = earliest run.ts in the component (#2261) — deliberately simple,
  // no completion/merge tracking.
  let startedAt = null;
  for (const row of comp.runRows) {
    if (row.ts && (startedAt === null || row.ts < startedAt)) startedAt = row.ts;
  }

  return {
    id: root,
    repo,
    repos: repoList,
    issues,
    prs,
    tokens: { ...withTotal(comp.tokens), byModel: modelMapToObject(comp.byModel) },
    runs: comp.runs,
    agents,
    tiers: comp.tiers,
    shared: comp.shared,
    flowMismatch: comp.flowMismatch,
    startedAt,
  };
}

// ── Public: list view (GET /api/usage/work-items) ─────────────────────────────
function buildWorkItems(usageRecords, prEvents, query = {}) {
  const since = query.since || null;
  const until = query.until || null;
  const state = attribute(usageRecords, prEvents, { since, until });
  const comps = assembleComponents(state);

  const totals = zeroTokens();
  let totalRuns = 0;
  const unattributed = zeroTokens();
  let unattributedRuns = 0;

  for (const r of state.runs) {
    addTokens(totals, r.rec.tokens);
    totalRuns += 1;
    if (!r.primary) { addTokens(unattributed, r.rec.tokens); unattributedRuns += 1; }
  }

  const workItems = [...comps.entries()]
    // A component with zero runs (e.g. an issue linked to a PR whose only runs
    // fell outside the window) is not a work item in this window — drop it.
    .filter(([, comp]) => comp.runs > 0)
    .map(([root, comp]) => renderWorkItem(root, comp))
    .sort((a, b) => b.tokens.total - a.tokens.total || (a.id < b.id ? -1 : 1));

  const attributedTokens = withTotal(totals).total - withTotal(unattributed).total;
  const totalTok = withTotal(totals).total;

  return {
    since,
    until,
    totals: { ...withTotal(totals), runs: totalRuns },
    coverage: {
      runs: { attributed: totalRuns - unattributedRuns, unattributed: unattributedRuns, total: totalRuns },
      tokens: { attributed: attributedTokens, unattributed: withTotal(unattributed).total, total: totalTok },
      attributedPct: totalTok > 0 ? attributedTokens / totalTok : 0,
    },
    unattributed: { ...withTotal(unattributed), runs: unattributedRuns },
    workItems,
  };
}

// ── Public: drill-down (GET /api/usage/work-items/:repo/:number) ──────────────
// Addressed by ANY artifact in the chain (issue or PR). Returns the work item
// plus every attributed run (with tier, tokens, correlationId for the session-log
// deep link) and a per-agent split.
function workItemDetail(usageRecords, prEvents, repo, number, query = {}) {
  const since = query.since || null;
  const until = query.until || null;
  const state = attribute(usageRecords, prEvents, { since, until });
  const comps = assembleComponents(state);

  const n = Number(number);
  const prKey = artifactNode('pr', repo, n);
  const issueKey = artifactNode('issue', repo, n);
  let targetRoot = null;
  for (const [root, comp] of comps.entries()) {
    if (comp.nodes.has(prKey) || comp.nodes.has(issueKey)) { targetRoot = root; break; }
  }
  if (targetRoot == null) return null;

  const comp = comps.get(targetRoot);
  const item = renderWorkItem(targetRoot, comp);

  const perAgent = [...comp.agents.entries()].map(([agentId, a]) => {
    const tok = zeroTokens();
    for (const row of comp.runRows) if (row.agentId === agentId) addTokens(tok, row.tokens);
    return { agentId, roleId: a.roleId || null, runs: a.runs, tokens: withTotal(tok) };
  }).sort((x, y) => y.tokens.total - x.tokens.total || (x.agentId < y.agentId ? -1 : 1));

  const runs = [...comp.runRows].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));

  return { ...item, since, until, perAgent, runs };
}

module.exports = {
  buildWorkItems,
  workItemDetail,
  attributeRun, // exported for unit tests
  TOKEN_CLASSES,
};
