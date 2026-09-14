// Admission control — a declarative per-flow WIP limit, enforced at dispatch
// (#2114, design of record `docs/flow-control-concept.md` §4.0).
//
// WHY THIS EXISTS. The stall the Flow Control epic was opened for did not begin
// at the merge; it began at *dispatch*. An unbounded dispatcher fed several
// tickets into one flow at once, their PRs raced a single shared `main`, and the
// resulting conflicts were manufactured **by construction** — no amount of
// downstream detection can un-make them. Phase 0 fixed this in the dispatcher
// AGENT'S PROMPT, which is fragile (advisory, per-team, re-derivable by an LLM
// on a bad day). This module makes it a platform invariant: the count is
// computed by code, and the hold happens in the queue the platform owns.
//
// THE SHAPE, mirroring `flow-anomaly-detector.js` / `flow-anomaly-sweep.js`:
// this file is the PURE core (no fs, no network, no clock of its own — `now` is
// always injected). `orchestrator.js` is the I/O adapter: it reads the lane off
// disk, gates `enqueuePending`, sweeps GitHub on a tick, and writes back.
//
// THE LANE. Per team, one persisted record:
//
//   { version: 1, updatedAt,
//     inFlight: [ { key, repo, number, admittedAt, objects: [key…],
//                   unverified? } ],
//     held:     [ { heldAt, agentId, entry, ticket } ] }
//
// `inFlight` is the set of TICKETS occupying the lane — not runs, and not
// GitHub objects. That distinction is the whole design: one ticket legitimately
// produces many dispatches (dispatcher wakes the developer, the developer's PR
// wakes the reviewer, the reviewer's label wakes the merger). Those are all the
// SAME unit of work moving through the flow and must never be held against each
// other, or `wipLimit: 1` would deadlock on its own first hand-off. `objects`
// is how a ticket's issue and its PR(s) are known to be one ticket.
//
// HOLDING, NOT DROPPING. A dispatch that cannot be admitted is moved into
// `held` — the same entry, verbatim, that would have gone into
// `pending-triggers.json`. The reconcile tick promotes it the moment capacity
// frees. Nothing is discarded, so a WIP limit can delay work but never lose it.

'use strict';

const { COMPLETED_SUFFIX } = require('./flow-anomaly-detector');

// The window during which a freshly admitted ticket holds the lane even when
// the GitHub snapshot does not yet show it as active.
//
// Normally there is no gap: the label that woke the dispatch is already on the
// object, so the very next sweep sees it. The gap exists for an INTERNAL-channel
// emit (#1173), whose GitHub label is mirrored asynchronously and best-effort —
// without a grace window the tick could sweep in between, see no active label,
// release the lane and admit a second ticket, which is precisely the failure
// this module exists to prevent. Short, because it is only bridging a mirror
// round-trip; it is a MINIMUM hold, never a maximum (a genuinely stuck ticket is
// held by its open PR, indefinitely and on purpose).
const DEFAULT_GRACE_MS = 5 * 60 * 1000;

const LANE_VERSION = 1;

// ---------------------------------------------------------------------------
// Lane shape
// ---------------------------------------------------------------------------

function objectKey(repo, number) {
  return `${repo}#${Number(number)}`;
}

// Coerce whatever is on disk (missing file, corrupt JSON, an older shape) into
// a usable lane. Never throws — a lane that cannot be read must degrade to
// "empty", not to a crash on the dispatch path.
function emptyLane() {
  return { version: LANE_VERSION, updatedAt: null, inFlight: [], held: [] };
}

function normalizeLane(raw) {
  const lane = emptyLane();
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return lane;
  lane.updatedAt = typeof raw.updatedAt === 'string' ? raw.updatedAt : null;
  for (const t of Array.isArray(raw.inFlight) ? raw.inFlight : []) {
    if (!t || typeof t !== 'object') continue;
    const repo = typeof t.repo === 'string' ? t.repo : '';
    const number = Number(t.number);
    if (!repo || !Number.isInteger(number)) continue;
    lane.inFlight.push({
      key: objectKey(repo, number),
      repo,
      number,
      admittedAt: typeof t.admittedAt === 'string' ? t.admittedAt : null,
      objects: [...new Set([
        objectKey(repo, number),
        ...(Array.isArray(t.objects) ? t.objects.filter(o => typeof o === 'string') : []),
      ])],
      ...(t.unverified ? { unverified: true } : {}),
    });
  }
  for (const h of Array.isArray(raw.held) ? raw.held : []) {
    if (!h || typeof h !== 'object') continue;
    if (typeof h.agentId !== 'string' || !h.agentId) continue;
    if (!h.entry || typeof h.entry !== 'object') continue;
    lane.held.push({
      heldAt: typeof h.heldAt === 'string' ? h.heldAt : null,
      agentId: h.agentId,
      entry: h.entry,
      ticket: typeof h.ticket === 'string' ? h.ticket : null,
    });
  }
  return lane;
}

// Whether the lane has anything the reconcile tick could change. A team with no
// ticket in flight and nothing held has nothing to release and nothing to
// promote, so the (GitHub-calling) sweep can be skipped entirely — an idle flow
// costs zero API requests.
function laneNeedsRefresh(lane) {
  const l = lane || {};
  return (Array.isArray(l.inFlight) && l.inFlight.length > 0)
    || (Array.isArray(l.held) && l.held.length > 0);
}

// ---------------------------------------------------------------------------
// Which ticket does a pending entry belong to?
// ---------------------------------------------------------------------------

/**
 * Resolve the ticket a pending-queue entry is a dispatch for.
 *
 * Only GitHub-event entries are flow dispatches. Everything else the queue
 * carries — a session reset, a handover DM, a loop-verify, a throttle warning, a
 * digest, a direct `wake-agent` hand-off — is either control traffic or carries
 * no GitHub object to attribute, and is therefore never subject to the WIP
 * limit. Returning null means "not admission-controlled": the caller admits.
 *
 * `refs` are every object number this dispatch could belong to; `ticket` is the
 * one the lane is keyed on. For a PR event those differ on purpose: the ticket
 * is the ISSUE the PR closes (`closesIssues`, already parsed onto the payload by
 * the poller's PR enrichment, #1833) so that a PR and its issue occupy ONE lane
 * slot instead of two. Without that, `wipLimit: 1` would hold the code reviewer
 * behind the developer's own PR — the flow would deadlock on its first hand-off.
 *
 * @returns {{repo: string, ticket: number, refs: number[]}|null}
 */
function entryTicketRef(entry) {
  const gh = entry && typeof entry === 'object' ? entry.github : null;
  if (!gh || typeof gh !== 'object') return null;
  const repo = typeof gh.repo === 'string' ? gh.repo.trim() : '';
  if (!repo) return null;
  const p = gh.payload && typeof gh.payload === 'object' ? gh.payload : {};
  const pr = p.pull_request && typeof p.pull_request === 'object' ? p.pull_request : null;
  const issue = p.issue && typeof p.issue === 'object' ? p.issue : null;

  const refs = [];
  const push = (n) => {
    const v = Number(n);
    if (Number.isInteger(v) && v > 0 && !refs.includes(v)) refs.push(v);
  };

  // A PR event: the closed issue(s) first (they key the lane), then the PR.
  // `issue.pull_request` is how an issue_comment on a PR presents itself.
  const prLike = pr || (issue && issue.pull_request ? issue : null);
  if (prLike) {
    const closes = Array.isArray(prLike.closesIssues) ? prLike.closesIssues : [];
    for (const n of closes) push(n);
    push(prLike.number);
  } else if (issue) {
    push(issue.number);
  }

  if (!refs.length) return null;
  return { repo, ticket: refs[0], refs };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

// A limit is in force only when it is a positive integer. Anything else —
// absent, null, 0, a string — means "no admission control", i.e. exactly the
// behaviour every flow had before this module existed. The console and the
// orchestrator both refuse to persist an out-of-range value (see
// `normalizeWipLimit`), so this is the third and last gate.
function limitInForce(wipLimit) {
  return Number.isInteger(wipLimit) && wipLimit >= 1 ? wipLimit : null;
}

/**
 * The core judgement, pure and side-effect free: may this dispatch fire now?
 *
 * Order matters and each rung is a separate reason so the log (and the tests)
 * can name WHY a dispatch went through:
 *   no-limit        — the flow declares no wipLimit (back-compat, the default)
 *   not-a-flow-dispatch — control traffic, never gated
 *   same-ticket     — this dispatch belongs to a ticket already in the lane;
 *                     admitted regardless of capacity, because it is the SAME
 *                     unit of work advancing, not a second front
 *   capacity        — the lane has a free slot
 *   at-limit        — hold
 *
 * @returns {{admit: boolean, reason: string, ref: object|null, ticketKey: string|null}}
 */
function evaluate({ lane, wipLimit, entry, ref = undefined }) {
  const limit = limitInForce(wipLimit);
  if (limit === null) return { admit: true, reason: 'no-limit', ref: null, ticketKey: null };

  const r = ref === undefined ? entryTicketRef(entry) : ref;
  if (!r) return { admit: true, reason: 'not-a-flow-dispatch', ref: null, ticketKey: null };

  const inFlight = Array.isArray(lane && lane.inFlight) ? lane.inFlight : [];
  const candidates = new Set(r.refs.map(n => objectKey(r.repo, n)));
  for (const t of inFlight) {
    if (t.objects.some(o => candidates.has(o))) {
      return { admit: true, reason: 'same-ticket', ref: r, ticketKey: t.key };
    }
  }
  if (inFlight.length < limit) {
    return { admit: true, reason: 'capacity', ref: r, ticketKey: objectKey(r.repo, r.ticket) };
  }
  return { admit: false, reason: 'at-limit', ref: r, ticketKey: objectKey(r.repo, r.ticket) };
}

// Two held entries are the same dispatch when the same agent's same trigger is
// woken by the same GitHub event. Re-delivery of an event (the poller's seen-set
// is per-process; a restart can re-emit) must not stack duplicates in a queue
// that may sit for hours. Deliberately NOT a cap: the pending queue this one
// defers into has no cap either (#1528 — bound execution, not the queue), and a
// cap on a hold queue can only be implemented by dropping work, which is the one
// thing admission control must never do.
function heldIdentity(agentId, entry) {
  const gh = (entry && entry.github) || {};
  return [agentId, entry && entry.triggerId, gh.eventId, gh.event].join(' ');
}

/**
 * Apply the decision, returning the next lane. Never mutates its input.
 *
 * On admit the lane records the dispatch: a new ticket takes a slot, a
 * same-ticket dispatch adds its object (the developer's PR) to the ticket it
 * belongs to, so the NEXT dispatch about that PR is recognised without another
 * GitHub round-trip. On hold the entry is appended to `held` verbatim.
 *
 * @returns {{admit: boolean, reason: string, lane: object, ticketKey: string|null}}
 */
function admit({ lane, wipLimit, agentId, entry, now = Date.now() }) {
  const cur = normalizeLane(lane);
  const d = evaluate({ lane: cur, wipLimit, entry });
  const iso = new Date(now).toISOString();

  if (d.reason === 'no-limit' || d.reason === 'not-a-flow-dispatch') {
    // Byte-identical back-compat: an ungated flow never grows a lane record.
    return { admit: true, reason: d.reason, lane, ticketKey: null };
  }

  const next = { ...cur, updatedAt: iso, inFlight: cur.inFlight.map(t => ({ ...t })), held: [...cur.held] };

  if (d.admit && d.reason === 'same-ticket') {
    const t = next.inFlight.find(x => x.key === d.ticketKey);
    if (t) {
      t.objects = [...new Set([...t.objects, ...d.ref.refs.map(n => objectKey(d.ref.repo, n))])];
    }
    return { admit: true, reason: d.reason, lane: next, ticketKey: d.ticketKey };
  }

  if (d.admit) {
    next.inFlight.push({
      key: d.ticketKey,
      repo: d.ref.repo,
      number: d.ref.ticket,
      admittedAt: iso,
      objects: [...new Set(d.ref.refs.map(n => objectKey(d.ref.repo, n)))],
    });
    return { admit: true, reason: d.reason, lane: next, ticketKey: d.ticketKey };
  }

  const identity = heldIdentity(agentId, entry);
  if (!next.held.some(h => heldIdentity(h.agentId, h.entry) === identity)) {
    next.held.push({ heldAt: iso, agentId, entry, ticket: d.ticketKey });
  }
  return { admit: false, reason: d.reason, lane: next, ticketKey: d.ticketKey };
}

// ---------------------------------------------------------------------------
// Reconcile from GitHub truth
// ---------------------------------------------------------------------------

/**
 * The labels that mean "this ticket is still being worked". Derived from the
 * team's own flow model (`buildFlowModel`) — every wake label, its `:wip` claim
 * label, and every human-gate label. A gate label counts on purpose: a ticket
 * parked on `needs-human` is stuck, and §4.0 is explicit that a stuck ticket
 * HOLDS the lane rather than letting a second one route around it.
 *
 * `<wake>:completed` is excluded — it is the terminal marker a finished claim
 * leaves behind (#1163), so treating it as active would hold the lane forever
 * on a ticket that is done.
 */
function activeFlowLabels(model) {
  const m = model || {};
  const out = new Set();
  const add = (name) => {
    if (typeof name === 'string' && name && !name.endsWith(COMPLETED_SUFFIX)) out.add(name);
  };
  for (const w of Array.isArray(m.wakeEdges) ? m.wakeEdges : []) {
    add(w && w.label);
    add(w && w.claimLabel);
  }
  for (const c of Array.isArray(m.claimEdges) ? m.claimEdges : []) add(c && c.claimLabel);
  for (const g of m.gateLabels instanceof Set ? m.gateLabels : (Array.isArray(m.gateLabels) ? m.gateLabels : [])) {
    add(g);
  }
  return out;
}

/**
 * Recompute the in-flight set from a GitHub snapshot and release the tickets
 * that are done. This is the half of AC2 that makes the count verifiable
 * independently of any agent prompt: nothing an agent says is consulted, only
 * what GitHub shows.
 *
 * `snapshot` is `{ repos: [fullName…], objects: [{repo, number, kind, labels,
 * closes}] }` and lists ONLY OPEN issues and PRs — the adapter fetches
 * `state=open`, so "absent from the snapshot" means closed or merged.
 *
 * FAIL CLOSED. `repos` lists the repositories the sweep actually READ. A repo
 * whose fetch failed is absent, and every ticket in it keeps its slot (marked
 * `unverified`) instead of being released. A GitHub outage must not silently
 * open the lane — the same discipline verify-before-claim (#2113) applies to the
 * claim swap: when the truth cannot be read, do not act as if it said "done".
 *
 * A ticket stays in flight when EITHER its issue is open and carries an active
 * flow label, OR any open PR references it. Note what that means for an issue
 * left open carrying nothing but `:completed` labels and no PR: it is RELEASED.
 * That state is a flow that dropped the ticket — no listener will ever wake for
 * it again — and holding the lane on it would rebuild the exact freeze §4.0
 * warns about ("encoding seriality in the wake event … is what froze the epic").
 * Releasing it is what makes the lane self-healing; #2115's reconciler is what
 * will name the dropped ticket.
 *
 * @returns {{lane: object, released: Array<{key, reason}>}}
 */
function reconcileInFlight({ lane, snapshot, activeLabels, now = Date.now(), graceMs = DEFAULT_GRACE_MS }) {
  const cur = normalizeLane(lane);
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const sweptRepos = new Set(Array.isArray(snap.repos) ? snap.repos : []);
  const objects = Array.isArray(snap.objects) ? snap.objects : [];
  const active = activeLabels instanceof Set ? activeLabels : new Set(activeLabels || []);

  const inFlight = [];
  const released = [];

  for (const t of cur.inFlight) {
    if (!sweptRepos.has(t.repo)) {
      inFlight.push({ ...t, unverified: true });
      continue;
    }
    const inRepo = objects.filter(o => o && o.repo === t.repo);
    const self = inRepo.find(o => Number(o.number) === t.number) || null;
    const linkedPrs = inRepo.filter(o =>
      o.kind === 'pr'
      && (Number(o.number) === t.number
        || (Array.isArray(o.closes) && o.closes.map(Number).includes(t.number))));

    const labelled = !!self
      && (Array.isArray(self.labels) ? self.labels : []).some(n => active.has(n));
    const isActive = labelled || linkedPrs.length > 0;

    const admittedAtMs = t.admittedAt ? Date.parse(t.admittedAt) : NaN;
    const withinGrace = Number.isFinite(admittedAtMs) && (now - admittedAtMs) < graceMs;

    if (isActive || withinGrace) {
      const next = { ...t, objects: [...new Set([...t.objects, ...linkedPrs.map(p => objectKey(t.repo, p.number))])] };
      delete next.unverified;
      inFlight.push(next);
    } else {
      released.push({ key: t.key, reason: labelled ? 'done' : (self ? 'no-active-label' : 'closed') });
    }
  }

  return { lane: { ...cur, updatedAt: new Date(now).toISOString(), inFlight, held: [...cur.held] }, released };
}

/**
 * Release every held dispatch the (already reconciled) lane can now admit.
 *
 * One FIFO pass that CONTINUES past an entry it cannot admit rather than
 * stopping at it. That is deliberate: a same-ticket hand-off admits regardless
 * of capacity, so scanning on lets the developer's own PR wake the reviewer even
 * while a different new ticket waits behind a full lane. Between two NEW
 * tickets, FIFO order still decides — the earlier one is reached first and takes
 * the free slot.
 *
 * @returns {{lane: object, release: Array<{agentId, entry, reason}>}}
 */
function promoteHeld({ lane, wipLimit, now = Date.now() }) {
  let cur = normalizeLane(lane);
  const release = [];
  const stillHeld = [];

  for (const h of cur.held) {
    const d = evaluate({ lane: cur, wipLimit, entry: h.entry });
    if (!d.admit) {
      stillHeld.push(h);
      continue;
    }
    // Re-apply through `admit` against a lane whose held list is this entry
    // only, so the ticket bookkeeping (new slot / added object) is done by the
    // one code path that owns it.
    const applied = admit({ lane: { ...cur, held: [] }, wipLimit, agentId: h.agentId, entry: h.entry, now });
    cur = { ...normalizeLane(applied.lane), held: cur.held };
    release.push({ agentId: h.agentId, entry: h.entry, reason: d.reason });
  }

  return { lane: { ...cur, updatedAt: new Date(now).toISOString(), held: stillHeld }, release };
}

/**
 * Force-dispatch (#2250 Phase 5, concept §11's open board-control item): an
 * operator explicitly overrides the WIP hold on ONE named held entry, right
 * now, at their own risk — the Flow Control board's "Force dispatch" button.
 * Unlike `promoteHeld` (which only ever promotes an entry the LIMIT already
 * has room for), this always admits the match regardless of capacity — but it
 * still RECORDS the ticket in `inFlight` exactly like a normal admit would
 * (merging into an existing same-ticket entry when one exists), so D4 release
 * tracking and the next `wipLimit` check both see it; only the refusal itself
 * is skipped, not the bookkeeping the refusal exists to protect.
 *
 * `id` is `heldIdentity(agentId, entry)` — the same identity a caller reads
 * off a held entry to know which one to force. Returns `found: false` when no
 * held entry matches (already promoted, already released, or a stale id from
 * a client showing an old snapshot) — the caller's cue to treat it as a no-op,
 * not an error.
 *
 * @returns {{found:boolean, lane:object, agentId:string|null, entry:object|null, ticketKey:string|null}}
 */
function forcePromoteHeld({ lane, id, now = Date.now() }) {
  const cur = normalizeLane(lane);
  const idx = cur.held.findIndex((h) => heldIdentity(h.agentId, h.entry) === id);
  if (idx === -1) return { found: false, lane: cur, agentId: null, entry: null, ticketKey: null };

  const target = cur.held[idx];
  const stillHeld = cur.held.filter((_, i) => i !== idx);
  const iso = new Date(now).toISOString();
  const ref = entryTicketRef(target.entry);
  if (!ref) {
    // A held entry is only ever created for a resolved ticket ref (`admit`'s
    // hold branch), so this is defensive, not an expected path: drop it from
    // `held` (there is nothing left to force it INTO) rather than leave a
    // dead entry a client can never successfully force again.
    return {
      found: true, lane: { ...cur, held: stillHeld, updatedAt: iso },
      agentId: target.agentId, entry: target.entry, ticketKey: null,
    };
  }

  const ticketKey = objectKey(ref.repo, ref.ticket);
  const objects = [...new Set(ref.refs.map((n) => objectKey(ref.repo, n)))];
  const existing = cur.inFlight.find((t) => t.objects.some((o) => objects.includes(o)));
  const inFlight = existing
    ? cur.inFlight.map((t) => (t.key === existing.key
      ? { ...t, objects: [...new Set([...t.objects, ...objects])] }
      : t))
    : [...cur.inFlight, { key: ticketKey, repo: ref.repo, number: ref.ticket, admittedAt: iso, objects }];

  return {
    found: true,
    lane: { ...cur, inFlight, held: stillHeld, updatedAt: iso },
    agentId: target.agentId, entry: target.entry, ticketKey: existing ? existing.key : ticketKey,
  };
}

module.exports = {
  DEFAULT_GRACE_MS, LANE_VERSION,
  emptyLane, normalizeLane, laneNeedsRefresh, objectKey,
  entryTicketRef, limitInForce, evaluate, admit, heldIdentity,
  activeFlowLabels, reconcileInFlight, promoteHeld, forcePromoteHeld,
};
