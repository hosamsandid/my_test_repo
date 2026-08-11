"use strict";

// Personal-credential runtime resolution (personal → team → system) with the
// refuse-on-missing rule (#1569, epic #1558 Phase 3; concept
// docs/personal-credentials-concept.md §5/§6).
//
// This is the PURE decision core — no fs, no network, no orchestrator state. It
// answers two questions for a git/GitHub operation:
//
//   1. WHO is the agent's human owner? (`resolveAgentOwnerId`)
//   2. WHICH credential tier does this operation use, and — if the owner has no
//      usable personal credential for an attributed write — does the run refuse?
//      (`resolveCredential`)
//
// The impure half (reading the credential index, threading the resolved id into
// `buildRepoGitEnv`, surfacing the refusal as an HTTP error) wraps this in
// orchestrator.js, exactly like `plugin-scope.js` / `agent-tenant.js`. Mirrors
// the "pure core now, live wiring next" discipline every phase in this repo
// follows.
//
// ── The AC5/AC8 reconciliation (the issue's Open Question 1) ─────────────────
// AC5 wants refuse-on-missing (no team/system fallback for an attributed write
// when the owner lacks a usable personal credential); AC8 wants existing
// single-tier environments to behave EXACTLY as today, with no refusal. Those
// only conflict if you let "an attributed write is happening" trigger the
// personal requirement — every environment does attributed writes today.
//
// The reconciliation is forced by AC8 itself: the personal tier is gated on the
// agent carrying an `ownerId`. An agent with NO `ownerId` (every agent today,
// since nothing populates it yet — the blocking prerequisite named in the
// issue) takes the shared team/system credential exactly as today and NEVER
// refuses (AC8). Only an agent that actually carries an `ownerId` is expected to
// act under that person and is therefore subject to refuse-on-missing (AC2/AC5).
// So `ownerId` presence — not "is this a write" — is the switch.

const DEFAULT_TEAM_ID = "default";

// Attributed writes carry the human's name and MUST run under the owner's
// personal identity when an owner is set (concept §5 table). Everything else is
// a shared-eligible operation (read-only clone, the repo-check probe, event
// polling) where a shared team/system credential misattributes no one.
const ATTRIBUTED_OPERATIONS = new Set(["commit", "pr", "review", "push-https"]);

function operationPrefersPersonal(operation) {
  return ATTRIBUTED_OPERATIONS.has(operation);
}

// Resolve the human OWNER of an agent for personal-credential resolution.
//
// - A `team-member` resolves to its parent Agent Team's `ownerId` (one hop),
//   mirroring `resolveAgentTenant` — a team operated by several humans still has
//   exactly one deterministic owner, so its autonomous writes are attributed to
//   that one person regardless of who triggered the run (AC3/AC4, concept §6).
// - Everyone else resolves to their own `config.ownerId`.
// - Returns `null` when no owner is set anywhere (→ shared tier, AC8).
//
// Deliberately reads ONLY persisted config, never a trigger initiator, so a
// cron/github-event run resolves the same owner as a chat turn (AC3).
function resolveAgentOwnerId(cfg, loadAgentConfig) {
  if (!cfg || typeof cfg !== "object") return null;
  if (cfg.role === "team-member" && cfg.parentTeamId && typeof loadAgentConfig === "function") {
    const parent = loadAgentConfig(cfg.parentTeamId);
    if (parent && parent.ownerId) return String(parent.ownerId);
  }
  return cfg.ownerId ? String(cfg.ownerId) : null;
}

// Find the owner's usable personal credential of one kind (SSH key or GitHub
// token) in a credential-index array of `{ id, scope, userId, ... }` entries.
//
// `isUsable(entry)` is an optional hook for the "present-but-underscoped" check
// (a PAT missing `repo`/`workflow`). We have no stored scope metadata and cannot
// probe GitHub from this pure module, so the DEFAULT treats presence as usable;
// the live scope probe is the completion-step's job (concept §5/§6, D5). When a
// caller supplies `isUsable`, an entry it rejects is treated as "no usable
// personal credential" — i.e. it refuses on the same path as absent (D5).
function findPersonalCredential(index, ownerId, isUsable) {
  if (!Array.isArray(index) || !ownerId) return null;
  const check = typeof isUsable === "function" ? isUsable : () => true;
  for (const entry of index) {
    if (
      entry &&
      entry.scope === "personal" &&
      entry.userId &&
      String(entry.userId) === String(ownerId) &&
      check(entry)
    ) {
      return entry;
    }
  }
  return null;
}

// The core decision. Given the operation, the resolved owner, the owner's usable
// personal credential (or null), and the environment's shared credential id,
// return exactly one of:
//
//   { tier: 'personal', credentialId }        — AC1: owner's personal credential
//   { tier: 'shared', credentialId | null }    — AC8 (no owner) / AC2 (read/poll)
//   { refuse: { code, message } }              — AC2/AC5: owned attributed write,
//                                                no usable personal credential
//
// `kind` labels the credential in the refusal message ("GitHub token" / "SSH
// key"). `personalCredential` is what `findPersonalCredential` returned.
function resolveCredential({
  operation,
  ownerId,
  personalCredential = null,
  sharedCredentialId = null,
  kind = "GitHub token",
}) {
  const attributed = operationPrefersPersonal(operation);

  // No owner → the personal tier never applies. Use the shared team/system
  // credential exactly as today, and NEVER refuse (AC8). This is the branch
  // every agent takes until `ownerId` population lands, which is what makes the
  // whole change a provable no-op for existing environments.
  if (!ownerId) {
    return { tier: "shared", credentialId: sharedCredentialId || null };
  }

  // Owner known + a usable personal credential exists → prefer it (AC1).
  if (personalCredential && personalCredential.id) {
    return { tier: "personal", credentialId: personalCredential.id };
  }

  // Owner known but NO usable personal credential (absent or underscoped).
  if (attributed) {
    // Refuse — an attributed write must NEVER silently drop to a shared
    // team/system credential and act under someone else's name (AC2/AC5, D5).
    return { refuse: buildRefusal(ownerId, kind) };
  }

  // A shared-eligible operation (read-only clone, the repo probe, polling) may
  // still use the shared credential — the fallback chain applies only where a
  // shared credential is legitimately acceptable (AC2 second half / AC7).
  return { tier: "shared", credentialId: sharedCredentialId || null };
}

// Owner-scoped respawn selection (#1570, Phase 4). Given already-loaded agent
// configs, return the ids of agents whose resolved human OWNER
// (`resolveAgentOwnerId`) is `ownerId` — i.e. the agents that would resolve a
// personal credential to that human's. Because a personal credential is unique
// per (owner, kind), "agents whose resolved credential is this personal
// credential" reduces to "agents owned by this human"; every such agent must be
// respawned when the owner SETS or ROTATES a personal SSH key / GitHub token so
// the new secret takes effect — INCLUDING an agent that only uses the personal
// credential for attributed writes and never for the clone (issue edge case).
//
// Pure — no I/O. `agents` is an array of `{ id, cfg }` (a null/absent `cfg` is
// skipped, e.g. a corrupt config). The runtime skip rules (disabled /
// not-running / tokenless) are applied by the caller, mirroring
// `respawnAgentsForEnvironment`, so this stays a pure owner-match.
function selectAgentIdsForOwner(agents, ownerId, loadAgentConfig) {
  const target = ownerId != null && String(ownerId) !== "" ? String(ownerId) : null;
  if (!target || !Array.isArray(agents)) return [];
  const ids = [];
  for (const a of agents) {
    if (!a || !a.cfg) continue;
    const owner = resolveAgentOwnerId(a.cfg, loadAgentConfig);
    if (owner && String(owner) === target) ids.push(a.id);
  }
  return ids;
}

// Offboarding selection (#1571, Phase 5). Given a credential-index array
// (`_keys/index.json` or `_tokens/index.json`) and the departing human's id,
// return the ids of that human's PERSONAL credentials — the only ones
// offboarding auto-deletes. A `team`/`system` credential (any non-`personal`
// scope) is NEVER selected even when its `userId` happens to match, so a
// person's shared infrastructure is untouched (AC3). Pure — no I/O; the caller
// unlinks the secret file and rewrites the index.
function selectPersonalCredentialIds(index, ownerId) {
  const target = ownerId != null && String(ownerId) !== "" ? String(ownerId) : null;
  if (!target || !Array.isArray(index)) return [];
  const ids = [];
  for (const entry of index) {
    if (
      entry &&
      entry.scope === "personal" &&
      entry.userId &&
      String(entry.userId) === target &&
      entry.id
    ) {
      ids.push(String(entry.id));
    }
  }
  return ids;
}

// The actionable refusal message (AC5): names the owner and what to do, and is
// explicit that there is deliberately no team/system fallback.
function buildRefusal(ownerId, kind) {
  return {
    code: "personal-credential-required",
    message:
      `Refusing to run an attributed GitHub write under a shared identity: this agent's owner ` +
      `(${ownerId}) has no usable personal ${kind}. Add one on the My Credentials page ` +
      `(a GitHub token needs the repo/workflow scope) and re-run — the run will NOT fall back ` +
      `to a team or system credential (personal credentials, refuse-on-missing).`,
  };
}

module.exports = {
  DEFAULT_TEAM_ID,
  ATTRIBUTED_OPERATIONS,
  operationPrefersPersonal,
  resolveAgentOwnerId,
  findPersonalCredential,
  resolveCredential,
  selectAgentIdsForOwner,
  selectPersonalCredentialIds,
  buildRefusal,
};
