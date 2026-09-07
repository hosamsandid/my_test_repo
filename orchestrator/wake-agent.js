'use strict';

// Direct agent-to-agent hand-off — the pure core of POST /internal/wake-agent
// (#2030, docs/direct-agent-handoff-concept.md §5/§5.2).
//
// A `wakeAgent` outcome action wakes a wired SAME-TEAM role inside the
// platform: no label to invent, no issue or PR to hang it on, no GitHub trace.
// The producer runs `aee-wake --to <roleId> [--note "…"]`, the orchestrator
// resolves + authorizes the target and enqueues a `kind: 'wake-agent'` entry in
// its `pending-triggers.json`; auditability comes from a `source: 'internal'`
// event-log row rather than from a repo the human can read.
//
// This is a NEW endpoint, not an extension of `/internal/flow-emit`
// (concept §5.2): `validateEmitRequest`'s required `label` + `target` are
// load-bearing for every one of its callers, and the two paths differ both in
// their authorization model (§6 — same-team only, which the #1172 path has no
// equivalent of) and in what they write to GitHub (nothing vs a mirrored
// label). Widening `flow-emit` would put two mutually-exclusive request shapes
// behind one validator, which is the exact ambiguity `TARGET_KINDS` exists to
// avoid.
//
// Like `flow-emit.js` this module is fs-free so the delivery contract is
// unit-testable (`node --test`): request validation, target resolution and the
// queue-entry shape. All I/O (queue write, event log) stays in orchestrator.js.

// The note cap (§4.1) — kept byte-identical to `WAKE_NOTE_MAX` in
// admin-console/api/outcomes.js, which caps it at AUTHOR time. Re-applied here
// because delivery must not trust the author path: `aee-wake` can be run by
// hand with any `--note`, and the cap is half the §5.3 defence (the other half
// is the untrusted envelope the consumer wraps the note in). Truncation is
// explicit — a silently shortened note would read as a complete thought.
const WAKE_NOTE_MAX = 1024;
const WAKE_NOTE_TRUNCATION_MARK = ' […truncated]';

// Refusal reasons, one per distinct HTTP status the route answers, so `aee-wake`
// can map a rejection (404/403 → exit 1) apart from a transport failure
// (exit 3). `self-target` is a 403 like `cross-team`: both are integrity
// constraints on the flow graph, not "this does not exist".
const WAKE_REFUSALS = {
  'unknown-target': 404,
  'cross-team': 403,
  'self-target': 403,
  'no-team': 403,
};

// Counted and cut in CODE POINTS, not UTF-16 code units — and by the same rule
// as the author-side `clampWakeNote` in admin-console/api/outcomes.js, so the
// two never disagree on what fits. `String#slice` can land between a surrogate
// pair, and the resulting lone surrogate is not encodable as UTF-8: it would
// throw on the consumer side when the prompt is written to the Claude CLI's
// stdin, where the write error is swallowed and the pipe is never closed —
// hanging the run while it holds the workspace gate. `Array.from` iterates code
// points, so a cut can never split a character.
function clampNote(note) {
  const s = String(note);
  const chars = Array.from(s);
  if (chars.length <= WAKE_NOTE_MAX) return s;
  const markChars = Array.from(WAKE_NOTE_TRUNCATION_MARK).length;
  return chars.slice(0, WAKE_NOTE_MAX - markChars).join('') + WAKE_NOTE_TRUNCATION_MARK;
}

/**
 * Validate the request body into `{ok: true, value}` or `{ok: false, error}`.
 * Shape: `{ fromAgentId, toAgentId, note? }` — target-LESS by design: there is
 * no repo, no issue/PR number and no label anywhere in it.
 *
 * `fromAgentId` is SELF-ASSERTED (§6.1): the whole `:4002` internal API is
 * unauthenticated, so this is an identity claim, not a credential. Validating
 * its shape is hygiene, not authentication — do not read it as one.
 */
function validateWakeRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { ok: false, error: 'body must be an object' };
  }
  const fromAgentId = body.fromAgentId;
  if (typeof fromAgentId !== 'string' || !fromAgentId.trim()) {
    return { ok: false, error: 'fromAgentId must be a non-empty string' };
  }
  const toAgentId = body.toAgentId;
  if (typeof toAgentId !== 'string' || !toAgentId.trim()) {
    return { ok: false, error: 'toAgentId must be a non-empty string' };
  }
  if (body.note !== undefined && typeof body.note !== 'string') {
    return { ok: false, error: 'note must be a string when present' };
  }
  const note = body.note !== undefined ? clampNote(body.note) : undefined;
  return {
    ok: true,
    value: {
      fromAgentId: fromAgentId.trim(),
      toAgentId: toAgentId.trim(),
      // A whitespace-only note carries nothing; drop it so the entry, the
      // event-log row and the consumer's prompt all agree there is no note
      // rather than each rendering an empty envelope differently.
      ...(note !== undefined && note.trim() ? { note } : {}),
    },
  };
}

// The team an agent config belongs to, using the one idiom the rest of the
// platform uses (`orchestrator.js`: `cfg.parentTeamId || cfg.teamId || null`;
// `parentTeamId` is the migrated name of the legacy `parentGroupId`).
function teamOf(cfg) {
  if (!cfg || typeof cfg !== 'object') return null;
  return cfg.parentTeamId || cfg.teamId || null;
}

/**
 * Resolve + authorize a wake target. `agents` is `[{agentId, config}]` —
 * metadata only; the caller never needs to load a prompt or a token for this.
 * Returns `{ok: true, agentId, teamId}` or `{ok: false, reason}` where `reason`
 * is a key of `WAKE_REFUSALS`.
 *
 * Same-team only (§6), and deliberately STRICTER than the #1172 label path,
 * which has no team gate at all: a label hand-off is at least visible on a
 * shared repo, whereas a cross-team direct wake would be an invisible
 * cross-tenant side effect. Both null teams also refuse — "unknown team" must
 * never read as "same team".
 *
 * This is an INTEGRITY CONSTRAINT ON THE FLOW GRAPH, not an authentication
 * boundary (§6.1). It stops a mis-authored or confused agent from reaching
 * outside its team and makes a cross-team hand-off a visible 403 instead of a
 * silent side effect. It does not defend against a caller that can already
 * reach `:4002` and lie about `fromAgentId` — nothing on that surface does.
 */
function resolveWakeTarget({ fromAgentId, toRoleId }, agents) {
  const list = Array.isArray(agents) ? agents : [];
  const index = new Map();
  for (const a of list) {
    if (!a || typeof a.agentId !== 'string' || !a.agentId) continue;
    if (!index.has(a.agentId)) index.set(a.agentId, a.config || null);
  }
  if (!index.has(toRoleId)) return { ok: false, reason: 'unknown-target' };
  // Checked before the team comparison: a self-wake would otherwise pass the
  // same-team gate trivially, and "you cannot hand off to yourself" is a more
  // useful message than nothing at all.
  if (toRoleId === fromAgentId) return { ok: false, reason: 'self-target' };
  const fromTeam = teamOf(index.get(fromAgentId));
  const toTeam = teamOf(index.get(toRoleId));
  if (!fromTeam || !toTeam) return { ok: false, reason: 'no-team' };
  if (fromTeam !== toTeam) return { ok: false, reason: 'cross-team' };
  return { ok: true, agentId: toRoleId, teamId: toTeam };
}

// The pending-queue entry for one hand-off. `kind: 'wake-agent'` is what routes
// it to the `_handle_pending_entry` branch that runs the target through the
// ordinary `_execute` chokepoint (so it inherits the `WorkspaceGate` AND the
// #611 backstop — §5.3/§8). `source: 'internal'` matches the flow-emit entry so
// log readers and operators can tell the delivery path apart.
//
// `receivedAt` + `id` are stamped by `enqueuePending`, not here — the same
// division `buildPendingEntry` keeps in flow-emit.js.
function buildWakeEntry({ from, note, teamId }) {
  return {
    kind: 'wake-agent',
    source: 'internal',
    from,
    ...(typeof note === 'string' && note.trim() ? { note } : {}),
    ...(teamId ? { teamId } : {}),
  };
}

// Synthesize the event the transparency log records. `buildEventEntry` is
// GitHub-event-shaped, so a hand-off has no repo, no label and no work item and
// those columns honestly render `—`; the distinguishing `source: 'internal'` is
// stamped by the caller. A dedicated event key `handoff.wake` is what lets the
// Event column read as a direct hand-off rather than as a blank. #2032 renders
// that key in plain language and surfaces the producer→target pair and the note
// in the row — the note through `buildWakeLogFields` below, since nothing in
// the GitHub-shaped entry has a slot for it.
function buildWakeLogEvent({ producerId, targetId, note, eventId, now }) {
  return {
    id: eventId,
    actor: { login: `agent:${producerId}` },
    // No repo: a direct hand-off is not anchored to one, and inventing a
    // plausible-looking value here would make the row lie.
    repo: { name: null },
    created_at: now,
    payload: {
      action: 'wake',
      to: targetId,
      ...(typeof note === 'string' && note.trim() ? { note } : {}),
    },
  };
}

const WAKE_EVENT_KEY = 'handoff.wake';

// The hand-off fields that ride ALONGSIDE the GitHub-shaped entry (#2032) — the
// same slot the caller stamps `source`/`emittedBy` into, because
// `buildEventEntry` extracts only GitHub's own vocabulary (`label`, `ref`,
// `workItem`) and would drop the note on the floor.
//
// `from`/`to` are carried even though the row's Actor cell shows `agent:<from>`
// and its single outcome names `to`: those two are a consequence of how this
// module synthesizes a GitHub-shaped event, not a contract a reader should
// parse a prefix out of. A reader that means "the producer and the target"
// reads them from the field that means that.
function buildWakeLogFields({ producerId, targetId, note }) {
  return {
    handoff: {
      from: producerId,
      to: targetId,
      ...(typeof note === 'string' && note.trim() ? { note } : {}),
    },
  };
}

module.exports = {
  WAKE_NOTE_MAX,
  WAKE_NOTE_TRUNCATION_MARK,
  WAKE_REFUSALS,
  WAKE_EVENT_KEY,
  clampNote,
  validateWakeRequest,
  resolveWakeTarget,
  buildWakeEntry,
  buildWakeLogEvent,
  buildWakeLogFields,
};
