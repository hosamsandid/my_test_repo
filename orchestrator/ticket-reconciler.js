// Ticket reconciler — the ledger (#2115, concept `docs/flow-control-concept.md` §4.1).
//
// A pure, fs-free module in the spirit of `flow-anomaly-detector.js`: given the
// team's flow model, a GitHub snapshot and the run state, it derives per work
// item a canonical **lifecycle state** plus an orthogonal **blocker** carrying a
// stable reason code. The expensive I/O (GitHub REST, session logs) happens in
// `ticket-reconcile-sweep.js` + the orchestrator endpoint that feeds this module;
// the classification itself is deterministic and golden-fixture testable.
//
// The whole point of §4.1 is that **state comes from evidence, not from labels**.
// The 2026-09-08 stall (§1) was invisible precisely because the labels said
// "done" while GitHub said "open and conflicting". So wherever a label and a
// GitHub fact disagree here, the GitHub fact wins and the disagreement itself is
// reported as the `claimed-done-not-merged` blocker.
//
// Two things are deliberately NOT hardcoded:
//
//   * **Lane / stage names.** This module never matches on `ready-2` or
//     `ready-for-review`. Everything positional is derived from the flow graph
//     the team declares (entry labels = wake labels nobody emits; terminal
//     consumers = consumers that emit nothing and produce no PR). A team with a
//     completely different vocabulary gets the same lifecycle out.
//   * **Repair.** Observe-only (#2115 is explicit). Nothing here mutates, and
//     nothing here is allowed to have a side effect — the responder is a later
//     phase and will consume this ledger as its input.

'use strict';

const {
  CLAIM_SUFFIX,
  COMPLETED_SUFFIX,
  claimLabelFor,
  humanizeAge,
} = require('./flow-anomaly-detector');

// ---------------------------------------------------------------------------
// Vocabulary.
// ---------------------------------------------------------------------------

// The canonical lifecycle, in order (concept §4.1). Ordered so a consumer can
// compare progress numerically without re-deriving the chain.
const TICKET_STATES = Object.freeze([
  'backlog',
  'refining',
  'ready',
  'in-dev',
  'in-review',
  'rework',
  'doc',
  'mergeable',
  'done',
]);

// The blocker reason codes (concept §4.1 table). Orthogonal to `state`: a ticket
// in `in-review` can be blocked by `conflict`, and a ticket in `mergeable` by
// `approved-not-merged`.
const BLOCKER_CODES = Object.freeze([
  'superseded',
  'claimed-done-not-merged',
  'conflict',
  'stale-base',
  'ci-red',
  'approved-not-merged',
  'orphaned',
  'unclaimed',
  'stalled',
  'needs-human',
]);

// Precedence when several apply — most specific / most actionable first. The
// ordering is a claim about what an operator should read first, not about
// severity: `superseded` wins over everything because if the work is already in
// `main` then every other finding on that PR is noise.
const BLOCKER_RANK = Object.freeze({
  superseded: 100,
  'claimed-done-not-merged': 90,
  conflict: 80,
  'stale-base': 70,
  'ci-red': 60,
  'approved-not-merged': 50,
  orphaned: 40,
  unclaimed: 30,
  stalled: 20,
  'needs-human': 10,
});

// Can an automated responder (Phase 4) plausibly clear this on its own, or does
// it need a person? `needsHuman` is a routing decision for the central inbox
// (§4.4), so it errs toward the human: anything whose resolution is a judgement
// call about duplicated or lost work is a human's.
const BLOCKER_NEEDS_HUMAN = Object.freeze({
  superseded: true, // "is this a duplicate?" — closing work is never automatic
  'claimed-done-not-merged': false, // re-dispatch the lying stage
  conflict: true, // a merge resolution is a judgement call
  'stale-base': false, // rebase + re-run is mechanical
  'ci-red': false, // re-dispatch the author
  'approved-not-merged': false, // nudge the merger
  orphaned: true, // no listener exists — the flow itself is wrong
  unclaimed: false, // re-deliver the wake
  stalled: false, // re-dispatch
  'needs-human': true, // by definition
});

const BLOCKER_SEVERITY = Object.freeze({
  superseded: 'warning',
  'claimed-done-not-merged': 'warning',
  conflict: 'warning',
  'stale-base': 'warning',
  'ci-red': 'warning',
  'approved-not-merged': 'info',
  orphaned: 'warning',
  unclaimed: 'warning',
  stalled: 'warning',
  'needs-human': 'info',
});

// How the four shipped anomaly classes fold in as ONE input signal (§4.1: the
// new codes "subsume" them). `output-missing` has no named successor in the
// table — a run that completed and produced nothing is a stall of the flow, so
// it folds into `stalled` and keeps its original class in `reasonDetail`.
const ANOMALY_TO_BLOCKER = Object.freeze({
  'wake-not-claimed': 'unclaimed',
  'claim-stalled': 'stalled',
  'output-missing': 'stalled',
  'gate-idle': 'needs-human',
});

// Thresholds (ms). The anomaly detector owns T1/T2/T3; these are the ones only
// the ledger needs. Ratios matter more than absolutes.
const DEFAULT_TICKET_THRESHOLDS = Object.freeze({
  // Grace after a `<wake>:completed` appears before the absence of any forward
  // signal is called a lie. A normal hand-off sets the next label within
  // seconds; anything past this is the §1.1 blind spot.
  claimedDoneMs: 30 * 60 * 1000, // 30 min
  // Green + approved + still open past this is worth naming.
  approvedNotMergedMs: 2 * 60 * 60 * 1000, // 2 h
});

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

function str(v) {
  return typeof v === 'string' ? v.trim() : '';
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

function iso(ms) {
  return ms == null ? null : new Date(ms).toISOString();
}

// The base label behind any claim/completed marker: `ready-2:wip` → `ready-2`.
function baseLabel(name) {
  const n = str(name);
  if (n.endsWith(CLAIM_SUFFIX)) return n.slice(0, -CLAIM_SUFFIX.length);
  if (n.endsWith(COMPLETED_SUFFIX)) return n.slice(0, -COMPLETED_SUFFIX.length);
  return n;
}

function completedLabelFor(wakeLabel) {
  return `${wakeLabel}${COMPLETED_SUFFIX}`;
}

// ---------------------------------------------------------------------------
// Graph position — derived, never name-matched.
// ---------------------------------------------------------------------------

/**
 * Wake edges for the labels `buildFlowModel` deliberately DISCARDS: a label
 * marked `humanGate` is skipped there ("a human gate is not an agent wake"),
 * which is right for anomaly detection and wrong for the ledger.
 *
 * In the observed flow the dispatch lanes `ready` / `ready-2` / `ready-3` are
 * human gates that a Developer trigger nevertheless listens on. The anomaly
 * detector does not care who consumes a gate; the ledger's `lane` and
 * `ownerAgentId` columns are precisely that question. So the ledger recovers the
 * gate→consumer edges from the raw member ports when they are supplied, and
 * degrades to "gate with no listener" when they are not.
 *
 * @param {Array} members  the same `[{id, triggers, ...}]` `buildFlowModel` took.
 * @param {Set<string>} gateLabels  the declared human gates.
 */
function gateWakeEdges(members, gateLabels) {
  const edges = new Map();
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !str(m.id)) continue;
    for (const t of Array.isArray(m.triggers) ? m.triggers : []) {
      if (!t || t.type !== 'github-event' || t.enabled === false) continue;
      const label = str(t.labelFilter);
      if (!label || !gateLabels.has(label)) continue;
      if (label.endsWith(CLAIM_SUFFIX) || label.endsWith(COMPLETED_SUFFIX)) continue;
      const claimAdd = t.claim && typeof t.claim === 'object' && str(t.claim.add)
        ? str(t.claim.add)
        : claimLabelFor(label);
      let e = edges.get(label);
      if (!e) e = { label, claimLabel: claimAdd, consumers: [], gate: true };
      if (!e.consumers.includes(m.id)) e.consumers.push(m.id);
      edges.set(label, e);
    }
  }
  return edges;
}

/**
 * The consumer map, widened with the members `buildFlowModel` never recorded.
 *
 * That builder calls `consumerOf(m)` only after a member survives the gate check,
 * so a member whose ONLY listener is a human gate — the Developer of the observed
 * flow, waiting on `ready-2` — is absent from `model.consumers` entirely, and its
 * `emits` are invisible. Every question the ledger asks ("did this stage produce
 * its forward label?", "is this label an entry?") would then be answered against
 * a map with a hole in exactly the shape of the flow's first stage.
 */
function mergedConsumers(model, members) {
  const out = { ...((model || {}).consumers || {}) };
  for (const m of Array.isArray(members) ? members : []) {
    if (!m || !str(m.id) || out[m.id]) continue;
    const gh = m.github && typeof m.github === 'object' ? m.github : {};
    out[m.id] = {
      id: m.id,
      displayName: str(m.displayName) || m.id,
      emits: (Array.isArray(m.emits) ? m.emits : []).map(str).filter(Boolean),
      producesPr: !!gh.producesPr,
      producesIssue: !!gh.producesIssue,
      openEnd: false,
      consumesLabels: [],
    };
  }
  return out;
}

/**
 * Labels that no consumer emits: the flow's ENTRY points. In the observed SDLC
 * flow these are exactly the `ready` / `ready-2` / `ready-3` dispatch lanes, but
 * that is a consequence of the graph, not of their names — a team whose entry
 * label is `triage` gets `lane: 'triage'`.
 */
function entryWakeLabels(model, members) {
  const m = model || {};
  const emitted = new Set();
  for (const c of Object.values(mergedConsumers(m, members))) {
    for (const e of (c && Array.isArray(c.emits) ? c.emits : [])) {
      const s = str(e);
      if (s) emitted.add(s);
    }
  }
  const gateLabels = new Set((Array.isArray(m.gateLabels) ? m.gateLabels : []).map(str).filter(Boolean));
  const out = new Set();
  for (const w of Array.isArray(m.wakeEdges) ? m.wakeEdges : []) {
    const label = str(w && w.label);
    if (label && !emitted.has(label)) out.add(label);
  }
  for (const label of gateWakeEdges(members, gateLabels).keys()) {
    if (!emitted.has(label)) out.add(label);
  }
  return out;
}

/**
 * Consumers that close the chain: they emit nothing and produce no PR, so their
 * only observable success is the GitHub object changing state (a merge). The
 * Merger of §1.1 is one; so is any "archive the ticket" role. Used to place the
 * `mergeable` and `doc` stages without knowing a single label name.
 */
function terminalConsumerIds(model, members) {
  const out = new Set();
  for (const [id, c] of Object.entries(mergedConsumers(model, members))) {
    if (!c) continue;
    const emits = Array.isArray(c.emits) ? c.emits.filter(Boolean) : [];
    if (emits.length === 0 && !c.producesPr && !c.producesIssue) out.add(id);
  }
  return out;
}

/**
 * BFS depth of every wake label from the entry labels, walking
 * label → consumers → their emits → label. Depth is what makes "further along
 * the flow" a computable statement; unreachable labels get depth 0 so they
 * never outrank a genuinely reached stage.
 */
function labelDepths(model, members) {
  const m = model || {};
  const consumers = mergedConsumers(m, members);
  const consumersOfLabel = new Map();
  for (const w of Array.isArray(m.wakeEdges) ? m.wakeEdges : []) {
    const label = str(w && w.label);
    if (!label) continue;
    consumersOfLabel.set(label, Array.isArray(w.consumers) ? w.consumers : []);
  }
  const gateSet = new Set((Array.isArray(m.gateLabels) ? m.gateLabels : []).map(str).filter(Boolean));
  for (const [label, e] of gateWakeEdges(members, gateSet)) {
    if (!consumersOfLabel.has(label)) consumersOfLabel.set(label, e.consumers);
  }
  const depths = new Map();
  const queue = [];
  for (const l of entryWakeLabels(m, members)) {
    depths.set(l, 0);
    queue.push(l);
  }
  // A flow with no entry label at all (every wake is emitted by somebody — a
  // cycle) still needs depths, so seed from every wake label at depth 0.
  if (queue.length === 0) {
    for (const l of consumersOfLabel.keys()) {
      depths.set(l, 0);
      queue.push(l);
    }
  }
  while (queue.length) {
    const label = queue.shift();
    const d = depths.get(label) || 0;
    for (const agentId of consumersOfLabel.get(label) || []) {
      const c = consumers[agentId];
      for (const next of (c && Array.isArray(c.emits) ? c.emits : [])) {
        const n = str(next);
        if (!n || !consumersOfLabel.has(n)) continue;
        if (depths.has(n)) continue; // first (shortest) path wins — no cycles
        depths.set(n, d + 1);
        queue.push(n);
      }
    }
  }
  return depths;
}

/**
 * Everything positional the ledger needs, computed once per sweep.
 */
function buildTicketModel(model, members) {
  const m = model || { wakeEdges: [], claimEdges: [], gateLabels: [], consumers: {} };
  const wakeByLabel = new Map();
  for (const w of Array.isArray(m.wakeEdges) ? m.wakeEdges : []) {
    const label = str(w && w.label);
    if (label) wakeByLabel.set(label, w);
  }
  const gateLabels = new Set((Array.isArray(m.gateLabels) ? m.gateLabels : []).map(str).filter(Boolean));
  // Human gates that an agent actually listens on are dispatch edges for the
  // ledger's purposes (see `gateWakeEdges`). Kept apart in `dispatchGates` so
  // the `needs-human` rule can still tell "a person must act" (a gate nobody
  // listens on) from "a person already acted and an agent was woken".
  const dispatchGates = new Set();
  for (const [label, edge] of gateWakeEdges(members, gateLabels)) {
    dispatchGates.add(label);
    if (!wakeByLabel.has(label)) wakeByLabel.set(label, edge);
  }
  const claimByLabel = new Map();
  for (const c of Array.isArray(m.claimEdges) ? m.claimEdges : []) {
    const label = str(c && c.claimLabel);
    if (label) claimByLabel.set(label, c);
  }
  const consumers = mergedConsumers(m, members);
  const terminals = terminalConsumerIds(m, members);
  const depths = labelDepths(m, members);

  // A label is "one hop before the end" when some consumer of it emits a label
  // whose consumers include a terminal consumer — the documentation stage in
  // the observed flow, derived rather than named.
  const preTerminal = new Set();
  const reachesTerminal = new Set();
  for (const [label, w] of wakeByLabel) {
    const cons = Array.isArray(w.consumers) ? w.consumers : [];
    if (cons.some((id) => terminals.has(id))) reachesTerminal.add(label);
  }
  for (const [label, w] of wakeByLabel) {
    for (const agentId of Array.isArray(w.consumers) ? w.consumers : []) {
      const c = consumers[agentId];
      for (const next of (c && Array.isArray(c.emits) ? c.emits : [])) {
        if (reachesTerminal.has(str(next))) preTerminal.add(label);
      }
    }
  }

  return {
    wakeByLabel,
    claimByLabel,
    gateLabels,
    dispatchGates,
    consumers,
    entryLabels: entryWakeLabels(m, members),
    terminals,
    depths,
    reachesTerminal,
    preTerminal,
  };
}

// ---------------------------------------------------------------------------
// Epic linkage.
// ---------------------------------------------------------------------------

// Parent epic of a ticket, from GitHub's sub-issue parent when the sweep could
// read it, else from the body's own prose. The prose forms are the ones this
// team actually writes ("Part of the **Flow Control** epic #2112", "Epic: #2112",
// "Part of #2112"); anything else yields null rather than a guess, because a
// wrong epic silently mis-groups a whole board column.
const EPIC_PATTERNS = [
  /\bepic\b[^#\n]{0,40}#(\d+)/i,
  /\bpart of\b[^#\n]{0,40}#(\d+)/i,
  /\bparent\b[^#\n]{0,40}#(\d+)/i,
];

function parseEpicId(body) {
  const text = str(body);
  if (!text) return null;
  for (const re of EPIC_PATTERNS) {
    const m = text.match(re);
    if (m) return Number(m[1]);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Blocker rules. Each takes the assembled ticket and returns a blocker or null.
// They are written one-per-code and combined by rank so a new code is a local
// addition, and so a golden fixture can exercise exactly one of them.
// ---------------------------------------------------------------------------

function mkBlocker(code, reasonDetail, evidence = []) {
  return {
    code,
    severity: BLOCKER_SEVERITY[code] || 'info',
    needsHuman: !!BLOCKER_NEEDS_HUMAN[code],
    reasonDetail,
    evidence,
  };
}

/**
 * `superseded` — every file this PR ADDS already exists on the base branch, so
 * the work it carries has landed some other way (the #2098 case: a duplicate of
 * an already-merged twin). Deliberately strict:
 *
 *   * only ADDED files count. A PR that modifies existing files says nothing —
 *     every file it touches trivially "already exists in main".
 *   * ALL of them must already be present. One genuinely new file means the PR
 *     still carries work nobody else landed.
 *   * the base file index must be COMPLETE. GitHub truncates a large recursive
 *     tree, and a truncated index would report "absent" for files it simply
 *     never listed — which would accuse a healthy PR of being a duplicate.
 */
function checkSuperseded(pr) {
  if (!pr || pr.state !== 'open' || pr.merged) return null;
  if (!pr.baseFileIndexComplete) return null;
  const added = Array.isArray(pr.addedFiles) ? pr.addedFiles.filter(Boolean) : [];
  if (added.length === 0) return null;
  const inBase = new Set(Array.isArray(pr.addedFilesInBase) ? pr.addedFilesInBase : []);
  if (!added.every((f) => inBase.has(f))) return null;
  const shown = added.slice(0, 5);
  return mkBlocker(
    'superseded',
    `every file this PR adds (${added.length}) already exists on \`${pr.baseRef || 'the base branch'}\` — ` +
      `the work has landed some other way; this looks like a duplicate of an already-merged twin.`,
    shown.map((f) => ({ type: 'file', text: f })),
  );
}

/**
 * `stale-base` — the PR still text-merges, but it fails against CURRENT `main`
 * because the model it was written against has since changed (the #2094/#2105
 * case: its own tests reference a field a later merge retired).
 *
 * The discrimination against plain `ci-red` is the whole value of the code, and
 * it needs both halves: red checks AND a base that has moved on since the PR
 * branched. Red checks on an unmoved base is the author's own bug (`ci-red`);
 * red checks after `main` advanced under it is a rebase, not a fix — a different
 * action, hence a different code. GitHub's own `BEHIND` merge state is accepted
 * as the second half too, since that is the same statement made by the server.
 */
function checkStaleBase(pr) {
  if (!pr || pr.state !== 'open' || pr.merged) return null;
  if (pr.mergeable !== 'MERGEABLE') return null; // a conflict is `conflict`, not this
  const baseMoved = (typeof pr.baseAheadBy === 'number' && pr.baseAheadBy > 0) ||
    pr.mergeStateStatus === 'BEHIND';
  if (!baseMoved) return null;
  if (pr.checks !== 'failure' && pr.mergeStateStatus !== 'BEHIND') return null;
  const behind = typeof pr.baseAheadBy === 'number' && pr.baseAheadBy > 0
    ? `${pr.baseAheadBy} commit${pr.baseAheadBy === 1 ? '' : 's'}`
    : 'commits';
  const detail = pr.checks === 'failure'
    ? `the PR text-merges, but \`${pr.baseRef || 'main'}\` has moved ${behind} ahead of its base and the checks are red — ` +
      `a rebase against current \`${pr.baseRef || 'main'}\`, not a code fix.`
    : `the PR text-merges but is ${behind} behind \`${pr.baseRef || 'main'}\` — it has not been validated against the current base.`;
  return mkBlocker('stale-base', detail, [{ type: 'check', text: `mergeStateStatus=${pr.mergeStateStatus || 'UNKNOWN'}` }]);
}

function checkConflict(pr) {
  if (!pr || pr.state !== 'open' || pr.merged) return null;
  if (pr.mergeable !== 'CONFLICTING' && pr.mergeStateStatus !== 'DIRTY') return null;
  return mkBlocker(
    'conflict',
    `the PR conflicts with \`${pr.baseRef || 'the base branch'}\` and cannot merge until the conflict is resolved.`,
    [{ type: 'check', text: `mergeable=${pr.mergeable || 'UNKNOWN'}` }],
  );
}

function checkCiRed(pr) {
  if (!pr || pr.state !== 'open' || pr.merged) return null;
  if (pr.checks !== 'failure') return null;
  const failed = Array.isArray(pr.failedChecks) ? pr.failedChecks.filter(Boolean) : [];
  const names = failed.length ? `: \`${failed.slice(0, 4).join('`, `')}\`` : '';
  return mkBlocker('ci-red', `required checks are failing${names}.`,
    failed.slice(0, 4).map((n) => ({ type: 'check', text: n })));
}

function checkApprovedNotMerged(pr, now, thresholds) {
  if (!pr || pr.state !== 'open' || pr.merged || pr.draft) return null;
  if (pr.reviewDecision !== 'APPROVED') return null;
  if (pr.checks === 'failure' || pr.mergeable === 'CONFLICTING') return null;
  const since = toMs(pr.approvedAt) ?? toMs(pr.updatedAt);
  const ageMs = since == null ? null : now - since;
  if (ageMs == null || ageMs <= thresholds.approvedNotMergedMs) return null;
  return mkBlocker(
    'approved-not-merged',
    `approved and green for ${humanizeAge(ageMs)} but still open — nothing is picking the merge up.`,
    [{ type: 'review', text: 'APPROVED' }],
  );
}

/**
 * `claimed-done-not-merged` — the §1.1 blind spot, and the one class that
 * compares a label's CLAIM against GitHub's reality.
 *
 * The naive reading ("a `:completed` label with an open PR") flags every healthy
 * ticket in a multi-stage flow: the Developer's `ready-2:completed` is supposed
 * to coexist with an open PR that the Code Reviewer is working on. What makes a
 * completion a LIE is that the flow did not move: the completing consumer set
 * NONE of its declared outgoing labels, and the PR it was working on is still
 * open and unmerged. For a terminal consumer (the Merger — no emits at all) that
 * condition is vacuously true the moment the PR fails to merge, which is exactly
 * the case that hid for hours on 2026-09-08.
 */
function checkClaimedDoneNotMerged(ticket, tm, now, thresholds) {
  const pr = ticket.pr;
  if (!pr || pr.state !== 'open' || pr.merged) return null;
  const present = ticket.labelNames;
  let best = null;
  for (const { name, appliedAt } of ticket.labelEntries) {
    if (!name.endsWith(COMPLETED_SUFFIX)) continue;
    const wake = baseLabel(name);
    const edge = tm.wakeByLabel.get(wake);
    if (!edge) continue; // a `:completed` for a label this flow does not wake on
    const since = toMs(appliedAt) ?? toMs(pr.updatedAt) ?? toMs(ticket.updatedAt);
    const ageMs = since == null ? null : now - since;
    if (ageMs == null || ageMs <= thresholds.claimedDoneMs) continue;
    // Did the completing stage produce ANY of its declared forward signals?
    const consumers = Array.isArray(edge.consumers) ? edge.consumers : [];
    const emitted = [];
    for (const id of consumers) {
      for (const e of ((tm.consumers[id] || {}).emits || [])) emitted.push(str(e));
    }
    if (emitted.some((e) => e && present.has(e))) continue; // the flow moved on — honest
    const who = consumers.map((id) => (tm.consumers[id] || {}).displayName || id);
    const expected = emitted.filter(Boolean);
    const detail = expected.length
      ? `\`${name}\` has claimed done for ${humanizeAge(ageMs)}, but none of ${who.join(', ') || 'its consumer'}'s ` +
        `declared outcomes (\`${[...new Set(expected)].join('`, `')}\`) ever appeared and PR #${pr.number} is still open — the label is lying.`
      : `\`${name}\` has claimed done for ${humanizeAge(ageMs)}, but PR #${pr.number} is still open and unmerged — ` +
        `${who.join(', ') || 'the consumer'} has no forward label to set, so a merge is the only evidence of success and it never happened.`;
    const cand = { ageMs, blocker: mkBlocker('claimed-done-not-merged', detail, [{ type: 'label', text: name }]) };
    if (!best || cand.ageMs > best.ageMs) best = cand;
  }
  return best ? best.blocker : null;
}

/**
 * `orphaned` — dispatched, but no listener/owner is resolvable. Two shapes, both
 * "nobody will ever wake for this": a flow label whose wake edge has no
 * consumer, and a PR that neither closes an issue nor carries any flow label.
 */
function checkOrphaned(ticket, tm) {
  for (const { name } of ticket.labelEntries) {
    if (name.endsWith(COMPLETED_SUFFIX)) continue;
    const wake = baseLabel(name);
    const edge = tm.wakeByLabel.get(wake);
    if (!edge) continue;
    const consumers = Array.isArray(edge.consumers) ? edge.consumers : [];
    if (consumers.length === 0) {
      return mkBlocker('orphaned', `\`${name}\` is a flow label no agent listens for — nothing will ever wake for this ticket.`,
        [{ type: 'label', text: name }]);
    }
  }
  if (ticket.kind === 'pr' && !ticket.issueNumber && ticket.activeFlowLabels.length === 0) {
    return mkBlocker('orphaned', 'the PR closes no issue and carries no flow label — it belongs to no lane and no agent owns it.', []);
  }
  return null;
}

// ---------------------------------------------------------------------------
// Lifecycle state.
// ---------------------------------------------------------------------------

/**
 * The deepest ACTIVE flow label on the ticket — "how far along the graph the
 * ticket has actually got". Claim labels count (a claimed stage is that stage);
 * `:completed` markers do not (they are history, and trusting them is what §1.1
 * warns against).
 */
function deepestActiveLabel(ticket, tm) {
  let best = null;
  for (const { name, appliedAt } of ticket.labelEntries) {
    if (name.endsWith(COMPLETED_SUFFIX)) continue;
    const wake = baseLabel(name);
    if (!tm.wakeByLabel.has(wake) && !tm.gateLabels.has(wake)) continue;
    const depth = tm.depths.get(wake) ?? 0;
    const claimed = name.endsWith(CLAIM_SUFFIX);
    // Same depth: a claim beats the bare wake (work has started on it).
    if (!best || depth > best.depth || (depth === best.depth && claimed && !best.claimed)) {
      best = { name, wake, depth, claimed, appliedAt };
    }
  }
  return best;
}

function deriveState(ticket, tm) {
  const pr = ticket.pr;
  const deep = ticket.deepest;

  if (ticket.state === 'closed' || (pr && pr.merged)) return 'done';

  if (pr && pr.state === 'open') {
    if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'rework';
    if (deep && tm.reachesTerminal.has(deep.wake)) return 'mergeable';
    if (pr.reviewDecision === 'APPROVED' && pr.checks !== 'failure' && pr.mergeable !== 'CONFLICTING') {
      return 'mergeable';
    }
    if (deep && tm.preTerminal.has(deep.wake)) return 'doc';
    if (pr.draft) return 'in-dev';
    // A stage past the PR author is active, or a review already exists → review.
    const ownerProducesPr = deep && (Array.isArray(tm.wakeByLabel.get(deep.wake)?.consumers) ? tm.wakeByLabel.get(deep.wake).consumers : [])
      .some((id) => (tm.consumers[id] || {}).producesPr);
    if (pr.reviewCount > 0 || (deep && !ownerProducesPr)) return 'in-review';
    return 'in-dev';
  }

  // No PR yet — position on the graph is all we have.
  if (deep) {
    if (tm.gateLabels.has(deep.wake) && !tm.entryLabels.has(deep.wake)) return 'refining';
    if (deep.claimed) return 'in-dev';
    if (tm.entryLabels.has(deep.wake)) return 'ready';
    return 'in-dev';
  }
  return 'backlog';
}

// The evidence that put the ticket in its current state, so `ageInStateMs` means
// "how long it has been stuck HERE" rather than "how old the ticket is".
function stateSinceMs(ticket) {
  const pr = ticket.pr;
  return (
    toMs(ticket.deepest && ticket.deepest.appliedAt) ??
    toMs(pr && pr.updatedAt) ??
    toMs(ticket.updatedAt) ??
    toMs(ticket.createdAt) ??
    null
  );
}

// ---------------------------------------------------------------------------
// Recurrence — reuse of the `anomaly-history` substrate (§4.1).
// ---------------------------------------------------------------------------

/**
 * How many past sweeps already flagged this object, and when it was first seen.
 * `history` is the parsed `anomaly-history.jsonl` entries (newest or oldest
 * first — order is not assumed). A ticket sighted repeatedly is what the Phase-4
 * "third sighting" ladder escalates on, so the count is carried on every row,
 * not only on blocked ones.
 */
function recurrenceFor(history, kind, number) {
  let sightings = 0;
  let firstSeenAt = null;
  for (const entry of Array.isArray(history) ? history : []) {
    if (!entry || !Array.isArray(entry.anomalies)) continue;
    const hit = entry.anomalies.some(
      (a) => a && a.object && a.object.kind === kind && Number(a.object.number) === Number(number),
    );
    if (!hit) continue;
    sightings += 1;
    const ts = toMs(entry.ts);
    if (ts != null && (firstSeenAt == null || ts < firstSeenAt)) firstSeenAt = ts;
  }
  return { sightings, firstSeenAt: iso(firstSeenAt) };
}

// ---------------------------------------------------------------------------
// Ledger assembly.
// ---------------------------------------------------------------------------

function pickPrimaryPr(issue, prsByNumber) {
  // Attribution wants the STRICT link (a `Closes #n` in the PR): a false
  // positive here merges two separate tickets into one row. The loose link
  // (`prsForIssue`) is only a fallback, and only when nothing strict exists.
  const strict = [];
  const loose = [];
  for (const pr of prsByNumber.values()) {
    if (Array.isArray(pr.closesIssues) && pr.closesIssues.includes(Number(issue.number))) strict.push(pr);
  }
  for (const n of Array.isArray(issue.linkedPrNumbers) ? issue.linkedPrNumbers : []) {
    const pr = prsByNumber.get(Number(n));
    if (pr && !strict.includes(pr)) loose.push(pr);
  }
  const pool = strict.length ? strict : loose;
  if (!pool.length) return { pr: null, linkage: 'none', all: [] };
  // Newest open PR wins — a reopened/second attempt supersedes the first.
  const open = pool.filter((p) => p.state === 'open' && !p.merged);
  const chosen = (open.length ? open : pool).slice().sort((a, b) => Number(b.number) - Number(a.number))[0];
  return { pr: chosen, linkage: strict.length ? 'closes' : 'reference', all: pool.map((p) => Number(p.number)) };
}

function labelEntriesOf(obj) {
  return (Array.isArray(obj.labels) ? obj.labels : [])
    .map((l) => ({ name: str(typeof l === 'string' ? l : l && l.name), appliedAt: (l && l.appliedAt) || null }))
    .filter((l) => l.name);
}

/**
 * A ticket's labels live on BOTH of its objects. In the observed flow the
 * dispatch gate (`ready-2`) sits on the issue while every downstream hand-off
 * (`ready-for-review`, `ready-to-merge`, and their `:wip`/`:completed` markers)
 * sits on the pull request — the poller wakes each listener on whichever object
 * carries its label. Reading only one of the two would lose the lane on half the
 * tickets and the merge stage on the other half, so the ledger reads the union.
 *
 * On a name collision the NEWER application wins: the same label re-applied to
 * the PR after the issue is the more recent statement about where the work is.
 */
function mergedLabelEntries(issueObj, prObj) {
  const byName = new Map();
  for (const src of [issueObj, prObj]) {
    if (!src) continue;
    for (const l of labelEntriesOf(src)) {
      const prev = byName.get(l.name);
      if (!prev) { byName.set(l.name, l); continue; }
      const a = toMs(prev.appliedAt);
      const b = toMs(l.appliedAt);
      if (a == null || (b != null && b > a)) byName.set(l.name, l);
    }
  }
  return [...byName.values()];
}

function ownerFor(ticket, tm) {
  const deep = ticket.deepest;
  if (!deep) return null;
  const edge = tm.wakeByLabel.get(deep.wake);
  const consumers = edge && Array.isArray(edge.consumers) ? edge.consumers : [];
  return consumers[0] || null;
}

function laneFor(ticket, tm) {
  // The lane is the ENTRY label the ticket was dispatched on — present in any of
  // its forms, because a lane does not stop being the ticket's lane once its
  // dispatch label has swapped to `:wip` or `:completed`.
  for (const entry of tm.entryLabels) {
    if (
      ticket.labelNames.has(entry) ||
      ticket.labelNames.has(claimLabelFor(entry)) ||
      ticket.labelNames.has(completedLabelFor(entry))
    ) {
      return entry;
    }
  }
  return null;
}

/**
 * Build the per-team ticket ledger. Pure and deterministic: same inputs (including
 * `now`) → same output.
 *
 * @param {object} args
 * @param {object} args.model        from `buildFlowModel` (flow-anomaly-detector).
 * @param {Array}  [args.members]    the raw member ports the model was built
 *                                   from. Optional, but without them a human
 *                                   gate that dispatches an agent cannot be told
 *                                   from one that waits for a person, so the
 *                                   lane and owner columns go blank on every
 *                                   gate-dispatched ticket (see `gateWakeEdges`).
 * @param {object} args.github       `{ issues: [...], prs: [...] }` in the shape
 *                                   `ticket-reconcile-sweep.js` produces.
 * @param {Array}  [args.anomalies]  the shipped detector's output, folded in as
 *                                   ONE input signal.
 * @param {Array}  [args.history]    parsed `anomaly-history.jsonl` entries.
 * @param {object} [args.thresholds] overrides `DEFAULT_TICKET_THRESHOLDS`.
 * @param {number} args.now          epoch ms — injected so tests are deterministic.
 * @returns {{now, thresholds, tickets: Array}}
 */
function buildTicketLedger(args = {}) {
  const tm = buildTicketModel(args.model, args.members);
  const github = args.github || {};
  const issues = Array.isArray(github.issues) ? github.issues : [];
  const prs = Array.isArray(github.prs) ? github.prs : [];
  const now = typeof args.now === 'number' ? args.now : toMs(args.now) || 0;
  const T = { ...DEFAULT_TICKET_THRESHOLDS, ...(args.thresholds || {}) };
  const history = Array.isArray(args.history) ? args.history : [];

  const prsByNumber = new Map();
  for (const pr of prs) {
    if (pr && pr.number != null) prsByNumber.set(Number(pr.number), pr);
  }

  // Anomalies indexed by the object they were raised against, so the fold-in is
  // a lookup rather than a second classification pass.
  const anomaliesByObject = new Map();
  for (const a of Array.isArray(args.anomalies) ? args.anomalies : []) {
    if (!a || !a.object) continue;
    const key = `${a.object.kind}:${a.object.number}`;
    if (!anomaliesByObject.has(key)) anomaliesByObject.set(key, []);
    anomaliesByObject.get(key).push(a);
  }

  const tickets = [];
  const claimedPrNumbers = new Set();

  for (const issue of issues) {
    if (!issue || issue.number == null) continue;
    const { pr, linkage, all } = pickPrimaryPr(issue, prsByNumber);
    for (const n of all) claimedPrNumbers.add(Number(n));
    tickets.push(assembleTicket({ obj: issue, kind: 'issue', pr, linkage, prNumbers: all, tm, T, now, anomaliesByObject, history }));
  }

  // PRs no issue claimed are tickets in their own right — that is the shape the
  // `orphaned` code exists for, and dropping them would hide exactly the work
  // nobody owns.
  for (const pr of prs) {
    if (!pr || pr.number == null) continue;
    if (claimedPrNumbers.has(Number(pr.number))) continue;
    tickets.push(assembleTicket({ obj: pr, kind: 'pr', pr, linkage: 'self', prNumbers: [Number(pr.number)], tm, T, now, anomaliesByObject, history }));
  }

  tickets.sort(compareTickets);
  return { now, generatedAt: iso(now), thresholds: T, tickets };
}

function assembleTicket({ obj, kind, pr, linkage, prNumbers, tm, T, now, anomaliesByObject, history }) {
  const labelEntries = kind === 'pr' ? labelEntriesOf(obj) : mergedLabelEntries(obj, pr);
  const labelNames = new Set(labelEntries.map((l) => l.name));

  const ticket = {
    kind,
    repo: str(obj.repo) || null,
    number: Number(obj.number),
    issueNumber: kind === 'issue' ? Number(obj.number) : (Array.isArray(pr && pr.closesIssues) && pr.closesIssues.length ? Number(pr.closesIssues[0]) : null),
    title: str(obj.title) || null,
    url: str(obj.url) || null,
    state: obj.state === 'closed' ? 'closed' : 'open',
    createdAt: obj.createdAt || null,
    updatedAt: obj.updatedAt || null,
    labelEntries,
    labelNames,
    pr: pr || null,
  };
  ticket.activeFlowLabels = labelEntries
    .filter((l) => !l.name.endsWith(COMPLETED_SUFFIX) && (tm.wakeByLabel.has(baseLabel(l.name)) || tm.gateLabels.has(baseLabel(l.name))))
    .map((l) => l.name);
  ticket.deepest = deepestActiveLabel(ticket, tm);

  const state = deriveState(ticket, tm);
  const since = stateSinceMs(ticket);

  // --- blockers ------------------------------------------------------------
  const found = [];
  const push = (b) => { if (b) found.push(b); };
  push(checkSuperseded(pr));
  push(checkClaimedDoneNotMerged(ticket, tm, now, T));
  push(checkConflict(pr));
  push(checkStaleBase(pr));
  push(checkCiRed(pr));
  push(checkApprovedNotMerged(pr, now, T));
  push(checkOrphaned(ticket, tm));

  // The four shipped anomaly classes, folded in as ONE input signal. They are
  // added AFTER the GitHub-derived codes on purpose: an anomaly is a statement
  // about the flow's plumbing, and a hard GitHub fact (a conflict, a duplicate)
  // is the more actionable finding whenever both are present.
  const foldedAnomalies = [];
  for (const k of [`issue:${ticket.number}`, ...prNumbers.map((n) => `pr:${n}`)]) {
    for (const a of anomaliesByObject.get(k) || []) {
      foldedAnomalies.push({ class: a.class, label: a.label || null, ageMs: a.ageMs ?? null, message: a.message || '' });
      const code = ANOMALY_TO_BLOCKER[a.class];
      if (!code) continue;
      push(mkBlocker(code, `${a.message || a.class} (from the \`${a.class}\` anomaly).`,
        [{ type: 'anomaly', text: a.class }]));
    }
  }

  // A human gate the flow is legitimately parked on is a blocker of last resort:
  // reported so the inbox can show it, never escalated over a real defect.
  //
  // `dispatchGates` are excluded: a gate an agent listens on (the `ready-N`
  // lanes) means a person has ALREADY acted and an agent was woken. Calling that
  // "waiting for a human" would put every freshly dispatched ticket in the human
  // inbox — the opposite of what §4.4 is for.
  if (!found.some((b) => b.code === 'needs-human')) {
    for (const l of labelEntries) {
      if (l.name.endsWith(COMPLETED_SUFFIX) || l.name.endsWith(CLAIM_SUFFIX)) continue;
      if (!tm.gateLabels.has(l.name) || tm.dispatchGates.has(l.name)) continue;
      const gateSince = toMs(l.appliedAt) ?? toMs(ticket.updatedAt);
      const ageMs = gateSince == null ? null : now - gateSince;
      push(mkBlocker('needs-human', `waiting on the human gate \`${l.name}\`${ageMs != null ? ` for ${humanizeAge(ageMs)}` : ''}.`,
        [{ type: 'label', text: l.name }]));
      break;
    }
  }

  found.sort((a, b) => (BLOCKER_RANK[b.code] || 0) - (BLOCKER_RANK[a.code] || 0));
  const blocker = found[0] || null;

  const evidence = [];
  if (ticket.url) evidence.push({ type: kind === 'pr' ? 'pr' : 'issue', text: `#${ticket.number}`, url: ticket.url });
  if (pr && kind !== 'pr') evidence.push({ type: 'pr', text: `#${pr.number}`, url: pr.url || null });
  if (ticket.deepest) evidence.push({ type: 'label', text: ticket.deepest.name });
  if (blocker) evidence.push(...blocker.evidence);

  return {
    ticketId: `${ticket.repo ? `${ticket.repo}#` : '#'}${ticket.number}`,
    repo: ticket.repo,
    kind,
    number: ticket.number,
    title: ticket.title,
    url: ticket.url,
    epicId: parseEpicId(obj.body) ?? (obj.parentIssueNumber != null ? Number(obj.parentIssueNumber) : null),
    lane: laneFor(ticket, tm),
    state,
    stateSince: iso(since),
    ageInStateMs: since == null ? null : now - since,
    ownerAgentId: ownerFor(ticket, tm),
    blocker: blocker ? blocker.code : null,
    blockers: found.map((b) => b.code),
    reasonDetail: blocker ? blocker.reasonDetail : null,
    needsHuman: blocker ? blocker.needsHuman : false,
    severity: blocker ? blocker.severity : 'info',
    prNumber: pr ? Number(pr.number) : null,
    prState: pr ? (pr.merged ? 'merged' : pr.state) : null,
    prLinkage: pr ? linkage : null,
    labels: labelEntries.map((l) => l.name),
    anomalies: foldedAnomalies,
    recurrence: recurrenceFor(history, kind, ticket.number),
    evidence,
  };
}

// Most-actionable first: blocked before healthy, then by blocker rank, then by
// how long it has been stuck. Fully deterministic — ties break on ticketId so
// two sweeps of the same snapshot are byte-identical.
function compareTickets(a, b) {
  const ra = BLOCKER_RANK[a.blocker] || 0;
  const rb = BLOCKER_RANK[b.blocker] || 0;
  if (ra !== rb) return rb - ra;
  const aa = a.ageInStateMs || 0;
  const ab = b.ageInStateMs || 0;
  if (aa !== ab) return ab - aa;
  return String(a.ticketId).localeCompare(String(b.ticketId));
}

module.exports = {
  TICKET_STATES,
  BLOCKER_CODES,
  BLOCKER_RANK,
  BLOCKER_NEEDS_HUMAN,
  BLOCKER_SEVERITY,
  ANOMALY_TO_BLOCKER,
  DEFAULT_TICKET_THRESHOLDS,
  entryWakeLabels,
  gateWakeEdges,
  mergedConsumers,
  terminalConsumerIds,
  labelDepths,
  buildTicketModel,
  parseEpicId,
  buildTicketLedger,
  // exported for focused unit tests of the individual rules
  checkSuperseded,
  checkStaleBase,
  checkConflict,
  checkCiRed,
  checkApprovedNotMerged,
  checkClaimedDoneNotMerged,
  checkOrphaned,
  deriveState,
  recurrenceFor,
};
