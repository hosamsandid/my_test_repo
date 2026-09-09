'use strict';

// Cost & quota attribution for token-usage records (#2137, follow-up to #2136).
//
// Until #2136 a model provider was always anchored on a team, so `teamId` on a
// usage record was a sufficient accounting key — that is exactly why the
// decentralised-access concept (#2041 D7, docs/decentralised-access-concept.md
// §5) keeps providers system-wide "because cost and quota belong in one place".
// A GLOBAL provider has no team, so for its runs `teamId` is not the anchor and
// something has to replace it. This module owns that replacement, purely:
//
//   1. `resolveUsageAttribution` — WHO is this run's spend charged to?
//   2. `providerTierOf`          — WHICH provider tier paid for it (so global
//                                  usage is distinguishable from team-scoped)?
//
// Both are pure decisions over already-read data; the impure shell
// (`enrichUsageRecord` in orchestrator.js) reads the users index and the
// llm-endpoints index and calls in. Deliberately part of the ORCHESTRATOR
// ingest, not the agent emitter: the agent only observes its own turn, while
// the control plane owns identity — the same split `enrichUsageRecord` already
// applies to teamId / roleId / provider.
//
// Tokens-only, like every other module in this pipeline: nothing here reads or
// produces a dollar figure, and nothing here BLOCKS a run. Hard caps are the
// budget-enforcement concept (#1484); this is attribution & visibility only.

const { endpointScope } = require('./assist-binding');

// The attribution kinds, strongest signal first. `kind` travels with the record
// so a reader can tell a charge that a human actually asked for from one that
// was merely inherited from the agent's owner — a per-user total that silently
// mixed the two would over-report what that person did.
const ATTRIBUTION_KINDS = ['requesting-user', 'agent-owner', 'unattributed'];

// Provider tiers, as they appear on a record. `global` is #2136's new tier;
// `system` / `team` are the pre-existing ones (endpointScope). `null` (not a
// member of this list) means "not resolvable" — no provider on the record, or a
// provider id that names no registered endpoint any more (a deleted provider).
// Kept an honest null rather than folded into a tier: guessing would make a
// deleted team provider look like a global one.
const PROVIDER_TIERS = ['global', 'system', 'team'];

function nonEmptyString(v) {
  return typeof v === 'string' && v.trim() !== '' ? v.trim() : null;
}

// Which platform user does a raw Matrix user id belong to? Humans carry their
// `matrixUserId` on the user record (teams-store, stamped at provisioning);
// the agent only ever sees the Matrix id of the sender whose message drove the
// turn, so this is the one hop from "who typed" to a stable account id.
// Case-insensitive because Matrix ids are lower-cased localparts, and the store
// compares subjects the same way. Returns null when nothing matches — a
// deleted / never-provisioned human is NOT invented into an id.
function userIdForMatrixId(users, matrixUserId) {
  const want = nonEmptyString(matrixUserId);
  if (!want) return null;
  const list = Array.isArray(users) ? users : [];
  const lower = want.toLowerCase();
  const hit = list.find((u) => u && nonEmptyString(u.matrixUserId)
    && nonEmptyString(u.matrixUserId).toLowerCase() === lower);
  return hit && nonEmptyString(hit.id) ? nonEmptyString(hit.id) : null;
}

// Resolve the attribution key for one usage record (#2137 AC1/AC3).
//
// Strongest signal wins, mirroring how work-item attribution already picks a
// tier (#655):
//
//   'requesting-user' — an interactive run: a human's chat message started this
//                       turn and their Matrix id resolves to an account. This
//                       is the answer the ticket asks for ("at least the
//                       requesting user").
//   'agent-owner'     — an AUTONOMOUS run (cron / github-event / loop): there is
//                       no human in the loop, so the spend is charged to the
//                       agent's human OWNER — the same person
//                       `resolveAgentOwnerId` already holds responsible for the
//                       agent's attributed writes (#1569). Reusing that answer
//                       is deliberate: an autonomous run's cost and its commits
//                       must not point at two different people.
//   'unattributed'    — neither resolves (no owner set anywhere, and no/unknown
//                       requester). `userId` is null and the reader sees the
//                       gap instead of a plausible-looking wrong name.
//
// `agentId` stays on the record at top level throughout, so "per user + per
// agent" (the ticket's ideal granularity) is a two-key group over the same
// record — no second field needed.
//
// NOTE the deliberate asymmetry with credential resolution: a chat turn's
// CREDENTIAL is the agent owner's (`resolveAgentOwnerId` reads only persisted
// config, so a write is attributed identically however the run started), while
// a chat turn's COST is the requester's. They answer different questions —
// "under whose name was this written" vs "who asked for this spend".
function resolveUsageAttribution({ requestedBy, users, ownerId } = {}) {
  const matrixUserId = requestedBy && typeof requestedBy === 'object'
    ? requestedBy.matrixUserId
    : null;
  const requester = userIdForMatrixId(users, matrixUserId);
  if (requester) return { userId: requester, kind: 'requesting-user' };
  const owner = nonEmptyString(ownerId != null ? String(ownerId) : null);
  if (owner) return { userId: owner, kind: 'agent-owner' };
  return { userId: null, kind: 'unattributed' };
}

// Which tier of model provider backed this run (#2137 AC2)? Looked up by the
// record's `provider` (an llm-endpoint id) in the endpoints index.
//
// The GLOBAL rule is the same three conditions as
// `admin-console/api/llm-endpoint-global.js` `isGlobalProvider`, re-read here on
// every call rather than trusting the stored `global` flag alone (#2136
// finding 1): `global === true` AND `scope === 'system'` AND
// `authType !== 'oauth-token'`. It is INLINED rather than imported because this
// module lives in the orchestrator image, which does not carry `api/*.js` — the
// same call `assist-binding.js` makes; keep the three in step.
//
// This also settles the ticket's "both global and team-assigned" edge case
// without a double-counting rule: a provider that carries a team assignment is
// not `scope === 'system'`, so it is NOT global and lands in its own tier. Each
// record gets exactly ONE tier, so a token is never counted twice — and the
// answer is read off the record, never off a route invariant.
function providerTierOf(index, providerId) {
  const want = nonEmptyString(providerId);
  if (!want) return null;
  const list = Array.isArray(index) ? index : [];
  const ep = list.find((e) => e && e.id === want) || null;
  if (!ep) return null;
  if (ep.global === true && ep.scope === 'system' && ep.authType !== 'oauth-token') return 'global';
  return endpointScope(ep) === 'system' ? 'system' : 'team';
}

module.exports = {
  ATTRIBUTION_KINDS,
  PROVIDER_TIERS,
  userIdForMatrixId,
  resolveUsageAttribution,
  providerTierOf,
};
