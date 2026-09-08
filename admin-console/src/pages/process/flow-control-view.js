// Pure view helpers for the Flow Control board (#2116, concept
// `docs/flow-control-concept.md` §4.4). Dependency-free so it unit-tests under
// `node --test` in the `admin-console-src` job — the JSX page cannot be
// imported there (#651).
//
// The board's whole reason to exist is §4.1's promise: **state comes from
// evidence, not from labels**. The 2026-09-08 stall (§1) was invisible because
// the labels said "done" while GitHub said "open and conflicting". So this
// module reads the reconciler's derived `state` / `blocker` fields and NEVER
// looks at `ticket.labels` — `flow-control-view.test.js` proves that by
// deleting the labels array and asserting the card is unchanged.
//
// Input is one element of the ledger's `tickets[]`
// (`orchestrator/ticket-reconciler.js`, `buildTicketLedger`):
//   { ticketId, repo, kind, number, title, url, epicId, lane, state,
//     stateSince, ageInStateMs, ownerAgentId, blocker, blockers, reasonDetail,
//     needsHuman, severity, prNumber, prState, prLinkage, labels, anomalies,
//     recurrence, evidence }

// Reused rather than re-derived: the board's age column and severity stripe must
// read identically to the Anomalies panel's. The explicit `.js` matters —
// `node --test` resolves ESM strictly, where Vite would tolerate the bare path.
import { formatAge, severityColor } from './flow-anomalies-view.js';

// ---------------------------------------------------------------------------
// Vocabulary — mirrored from the reconciler.
// ---------------------------------------------------------------------------

// The lifecycle swimlanes, in flow order. The browser bundle cannot import from
// `orchestrator/`, so the state list is duplicated here; the drift guard in
// `flow-control-view.test.js` reads `TICKET_STATES` out of
// `orchestrator/ticket-reconciler.js` and fails if the two ever disagree. Order
// matters twice: it is the left-to-right column order, and `stageIndex()` uses
// it as a progress ordinal.
const LIFECYCLE_STAGES = Object.freeze([
  { state: 'backlog', label: 'Backlog', blurb: 'No flow label yet — nothing has picked this up.' },
  { state: 'refining', label: 'Refining', blurb: 'Parked on a human gate before dispatch.' },
  { state: 'ready', label: 'Ready', blurb: 'Dispatched on an entry label, not yet claimed.' },
  { state: 'in-dev', label: 'In dev', blurb: 'Claimed by the producing agent; no review yet.' },
  { state: 'in-review', label: 'In review', blurb: 'A PR exists and a reviewing stage is active.' },
  { state: 'rework', label: 'Rework', blurb: 'Changes were requested — back with the author.' },
  { state: 'doc', label: 'Doc', blurb: 'One hop before the terminal stage.' },
  { state: 'mergeable', label: 'Mergeable', blurb: 'The deepest active stage reaches a terminal consumer.' },
  { state: 'done', label: 'Done', blurb: 'Merged, or the issue is closed.' },
]);

const TICKET_STATES = Object.freeze(LIFECYCLE_STAGES.map((s) => s.state));

// Blocker presentation. Keyed by the reconciler's `BLOCKER_CODES`; the same test
// asserts this table covers every code the reconciler can emit, so a new code
// can never ship as a bare slug on a badge. Severity is NOT mirrored — each
// ticket carries its own `severity` / `needsHuman`, so there is no second home
// for that decision.
const BLOCKERS = Object.freeze({
  superseded: { label: 'Superseded', blurb: 'The changes are already in main — this looks like a duplicate.' },
  'claimed-done-not-merged': { label: 'Claimed done', blurb: 'A stage claimed completion but set none of its outgoing labels.' },
  conflict: { label: 'Conflict', blurb: 'The PR conflicts with its base branch.' },
  'stale-base': { label: 'Stale base', blurb: 'It text-merges but fails against the current main.' },
  'ci-red': { label: 'CI red', blurb: 'Required checks are failing.' },
  'approved-not-merged': { label: 'Approved, not merged', blurb: 'Approved and green, but still sitting open.' },
  orphaned: { label: 'Orphaned', blurb: 'The active label has no listener — the flow itself is wrong.' },
  unclaimed: { label: 'Unclaimed', blurb: 'The wake was never claimed — it may have been lost.' },
  stalled: { label: 'Stalled', blurb: 'No activity past the threshold; the run likely died.' },
  'needs-human': { label: 'Needs a human', blurb: 'Waiting on a human gate.' },
});

function stageInfo(state) {
  return LIFECYCLE_STAGES.find((s) => s.state === state)
    || { state: state || 'unknown', label: state || 'Unknown', blurb: '' };
}

function stageIndex(state) {
  return TICKET_STATES.indexOf(state);
}

function blockerInfo(code) {
  return BLOCKERS[code] || { label: code, blurb: '' };
}

// ---------------------------------------------------------------------------
// Deep links (AC3).
// ---------------------------------------------------------------------------

// Best-effort GitHub URL from an `owner/name` repo, for the one case the ledger
// cannot supply a link itself. Same shape and same reasoning as
// `GithubEventLog.jsx`'s `issueUrl`: returns null when the repo is not a usable
// `owner/name`, so the reference degrades to plain text rather than to a broken
// link.
function synthesizeUrl(repo, kind, number) {
  if (typeof repo !== 'string' || !/^[^/\s]+\/[^/\s]+$/.test(repo)) return null;
  if (!Number.isFinite(Number(number))) return null;
  return `https://github.com/${repo}/${kind === 'pr' ? 'pull' : 'issues'}/${Number(number)}`;
}

// The ledger records the item's own `url` and puts the *other* object's URL in
// `evidence` (the reconciler pushes `{type:'issue'|'pr', text, url}` there).
// Prefer whatever GitHub actually returned; only synthesize when neither is
// available, and never invent an issue that does not exist.
function deepLinks(t) {
  const evidence = Array.isArray(t.evidence) ? t.evidence : [];
  const fromEvidence = (type) => {
    const hit = evidence.find((e) => e && e.type === type && e.url);
    return hit ? hit.url : null;
  };

  const issueUrl = t.kind === 'issue'
    ? (t.url || fromEvidence('issue') || synthesizeUrl(t.repo, 'issue', t.number))
    : fromEvidence('issue');

  let prUrl = t.kind === 'pr'
    ? (t.url || fromEvidence('pr'))
    : fromEvidence('pr');
  if (!prUrl && t.prNumber != null) prUrl = synthesizeUrl(t.repo, 'pr', t.prNumber);

  return { issueUrl: issueUrl || null, prUrl: prUrl || null };
}

// ---------------------------------------------------------------------------
// Cards.
// ---------------------------------------------------------------------------

// One ledger row → one render-ready card. Every field here is derived from a
// reconciler-computed field; `t.labels` is deliberately never read.
function ticketCard(t) {
  const stage = stageInfo(t.state);
  const blocker = t.blocker ? blockerInfo(t.blocker) : null;
  const { issueUrl, prUrl } = deepLinks(t);
  const severity = t.severity || 'info';
  return {
    ticketId: t.ticketId || null,
    kind: t.kind || null,
    number: t.number ?? null,
    ref: t.number == null ? '' : `${t.kind === 'pr' ? 'PR ' : ''}#${t.number}`,
    title: t.title || '',
    repo: t.repo || null,
    state: t.state || null,
    stateLabel: stage.label,
    stateBlurb: stage.blurb,
    owner: t.ownerAgentId || null,
    lane: t.lane || null,
    age: formatAge(t.ageInStateMs),
    stateSince: t.stateSince || null,
    blocker: t.blocker || null,
    blockerLabel: blocker ? blocker.label : null,
    blockerBlurb: blocker ? blocker.blurb : null,
    reasonDetail: t.reasonDetail || null,
    severity,
    color: severityColor(severity),
    needsHuman: t.needsHuman === true,
    epicId: t.epicId ?? null,
    prNumber: t.prNumber ?? null,
    prState: t.prState || null,
    recurrence: t.recurrence ?? null,
    issueUrl,
    prUrl,
  };
}

// ---------------------------------------------------------------------------
// Swimlanes.
// ---------------------------------------------------------------------------

// Group the ledger into one lane per lifecycle stage. Empty lanes are kept by
// default: an empty column is information (it shows the shape of the flow and
// where work is NOT), which is the point of a board over a list.
//
// Order within a lane is the ledger's own — `compareTickets` already sorts
// most-actionable-first (blocked before healthy, then by blocker rank, then by
// how long it has been stuck), so re-sorting here would only throw that away.
// Any ticket whose state is not a known stage lands in a trailing `other` lane
// rather than being dropped.
function groupIntoLanes(tickets, { includeEmpty = true } = {}) {
  const rows = Array.isArray(tickets) ? tickets : [];
  const byState = new Map(TICKET_STATES.map((s) => [s, []]));
  const other = [];
  for (const t of rows) {
    if (!t) continue;
    const card = ticketCard(t);
    if (byState.has(card.state)) byState.get(card.state).push(card);
    else other.push(card);
  }
  const lanes = LIFECYCLE_STAGES.map((s) => ({
    state: s.state,
    label: s.label,
    blurb: s.blurb,
    tickets: byState.get(s.state),
    count: byState.get(s.state).length,
    blocked: byState.get(s.state).filter((c) => c.blocker).length,
  }));
  if (other.length) {
    lanes.push({ state: 'other', label: 'Other', blurb: 'A state this console does not know yet.', tickets: other, count: other.length, blocked: other.filter((c) => c.blocker).length });
  }
  return includeEmpty ? lanes : lanes.filter((l) => l.count > 0);
}

// ---------------------------------------------------------------------------
// Epic roll-up.
// ---------------------------------------------------------------------------

// The four buckets of the cross-lane roll-up ("Epic #2041: 3 done · 1 blocked ·
// 2 in progress · 4 waiting"). Mutually exclusive and exhaustive by
// construction — `bucketFor` returns exactly one, and the test asserts the four
// counts sum to `total` for every state × blocker combination.
//
// Precedence is deliberate: `done` beats `blocked`, because a blocker recorded
// against merged work is history, not a call to action.
function bucketFor(card) {
  if (card.state === 'done') return 'done';
  if (card.blocker) return 'blocked';
  if (['in-dev', 'in-review', 'rework', 'doc', 'mergeable'].includes(card.state)) return 'inProgress';
  return 'waiting';
}

function epicRollups(tickets) {
  const cards = (Array.isArray(tickets) ? tickets : []).filter(Boolean).map(ticketCard);
  const byEpic = new Map();
  for (const card of cards) {
    if (card.epicId == null) continue;
    if (!byEpic.has(card.epicId)) {
      byEpic.set(card.epicId, { epicId: card.epicId, total: 0, done: 0, blocked: 0, inProgress: 0, waiting: 0, needsHuman: 0, tickets: [] });
    }
    const roll = byEpic.get(card.epicId);
    roll.total += 1;
    roll[bucketFor(card)] += 1;
    if (card.needsHuman) roll.needsHuman += 1;
    roll.tickets.push(card);
  }
  // Most-blocked first, then largest, then by epic number so two renders of the
  // same ledger are identical.
  return [...byEpic.values()].sort((a, b) => (b.blocked - a.blocked) || (b.total - a.total) || (a.epicId - b.epicId));
}

// A one-line summary of a roll-up, in the concept's own wording. Zero buckets
// are dropped so a healthy epic reads "4 done" rather than "4 done · 0 blocked
// · 0 in progress · 0 waiting".
function rollupSummary(roll) {
  return [
    [roll.done, 'done'],
    [roll.blocked, 'blocked'],
    [roll.inProgress, 'in progress'],
    [roll.waiting, 'waiting'],
  ].filter(([n]) => n > 0).map(([n, word]) => `${n} ${word}`).join(' · ');
}

// ---------------------------------------------------------------------------
// Header.
// ---------------------------------------------------------------------------

// Counts for the board header, plus the two banner conditions the panel shares
// with FlowAnomaliesPanel (maintenance pauses the sweep; a repo-less team has
// nothing to sweep).
function boardSummary(data) {
  const tickets = data && Array.isArray(data.tickets) ? data.tickets.filter(Boolean) : [];
  const cards = tickets.map(ticketCard);
  return {
    total: cards.length,
    blocked: cards.filter((c) => c.blocker).length,
    needsHuman: cards.filter((c) => c.needsHuman).length,
    done: cards.filter((c) => c.state === 'done').length,
    epics: epicRollups(tickets).length,
    swept: data && Number.isFinite(data.swept) ? data.swept : null,
    generatedAt: (data && data.generatedAt) || null,
    maintenance: !!(data && data.maintenance),
    noRepos: !!(data && !data.maintenance && Array.isArray(data.repos) && data.repos.length === 0),
    errors: data && Array.isArray(data.errors) ? data.errors : [],
  };
}

export {
  LIFECYCLE_STAGES,
  TICKET_STATES,
  BLOCKERS,
  stageInfo,
  stageIndex,
  blockerInfo,
  synthesizeUrl,
  deepLinks,
  ticketCard,
  groupIntoLanes,
  bucketFor,
  epicRollups,
  rollupSummary,
  boardSummary,
};
