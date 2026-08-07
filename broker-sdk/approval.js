'use strict';

// ─── Broker SDK: approval holding pen (plugin system Phase 4, #1520) ─────────
//
// The `requiresApproval` holding pen (§4.9). A plugin manifest may declare that
// certain subcommands need human sign-off before the broker executes them
// (manifest `requiresApproval: [...]`). v1 is DM confirm: the broker PARKS such
// an op instead of running it, the orchestrator asks a human over DM, and the
// op runs only once approved.
//
// The SDK owns the decision + the pen (pure, in-memory); the DM round-trip is
// the orchestrator's transport. Kept deliberately small — v1 is a gate, not a
// workflow engine.

// Decide whether a subcommand needs approval given the manifest's list. An
// empty/absent list means nothing is gated (the podman-sandbox default).
function needsApproval(subcommand, requiresApproval) {
  if (!Array.isArray(requiresApproval) || requiresApproval.length === 0) return false;
  return requiresApproval.includes(subcommand);
}

// A holding pen bound to one plugin's approval list. `park(op)` records an op
// awaiting confirmation and returns a pending ticket; `resolve(id, approved)`
// records the human's decision and returns the parked op (or null if unknown/
// already resolved). `pending()` lists still-open tickets. `id` is caller-
// supplied (the orchestrator's DM/message id) so this stays clock- and
// randomness-free (pure/testable); a broker with no id source can pass its own.
function approvalHoldingPen({ requiresApproval = [] } = {}) {
  const pen = new Map();

  return {
    needsApproval: (subcommand) => needsApproval(subcommand, requiresApproval),

    // Park an op. `op` carries at least { id, subcommand }; anything else
    // (args, scopeId, agentId) is retained verbatim for the confirm prompt.
    park(op) {
      if (!op || typeof op.id !== 'string' || !op.id) {
        throw new Error('park requires an op with a string id');
      }
      const ticket = { id: op.id, subcommand: op.subcommand, op, status: 'pending' };
      pen.set(op.id, ticket);
      return ticket;
    },

    // Resolve a parked op. Returns the op to run (approved) or null (denied or
    // unknown/already-resolved). A resolved ticket is removed from the pen.
    resolve(id, approved) {
      const ticket = pen.get(id);
      if (!ticket || ticket.status !== 'pending') return null;
      pen.delete(id);
      return approved ? ticket.op : null;
    },

    pending() {
      return [...pen.values()].filter((t) => t.status === 'pending');
    },
  };
}

// Convenience matching the §4.9 name: park a single op into a fresh pen and
// return the ticket. A broker that reuses one pen across calls should hold an
// `approvalHoldingPen(...)` instead.
function parkForApproval(op) {
  return approvalHoldingPen({ requiresApproval: [op && op.subcommand].filter(Boolean) }).park(op);
}

module.exports = { needsApproval, approvalHoldingPen, parkForApproval };
