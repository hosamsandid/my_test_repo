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
// #1569 reconciled them by gating the personal tier on the agent carrying an
// `ownerId`, which was a safe switch **only because nothing populated it** —
// the comment here used to say so in as many words ("every agent today, since
// nothing populates it yet").
//
// ── #2077 invalidated that premise, so the switch moved ────────────────────
// #2077 (epic #2076, D6) populates `ownerId` on every team and standalone agent,
// including a backfill over pre-existing ones. Under the old switch that would
// have flipped the entire installation into the owned branch at once, where
// every owner has no personal credential (they are self-service and opt-in,
// #1568) — so every `commit`/`pr`/`review`/`push-https` would refuse with a 424
// and no agent could open a PR again. That is the exact regression #2077's own
// AC7 ("no visible behaviour change") forbids.
//
// The switch is therefore no longer "does the agent have an owner" but "does
// that owner actually participate in the personal tier":
//
//   no owner                        → shared, never refuse   (unchanged)
//   owner, no personal credential   → shared, never refuse   (today's behaviour
//                                     for every agent, now reachable with an
//                                     ownerId set — this is the #2077 change)
//   owner, usable personal cred.    → personal               (unchanged, AC1)
//   owner, personal cred. PRESENT
//     but rejected by `isUsable`    → REFUSE                 (unchanged, AC2/AC5)
//
// Refuse-on-missing keeps its whole point: a human who HAS a personal
// credential never has an attributed write silently re-attributed to a shared
// identity. What it stops doing is refusing on behalf of someone who never had
// one — which is not a protection, just an outage. Note the consequence
// honestly: with no `isUsable` probe wired yet (see `findPersonalCredential`),
// the refusal branch is currently unreachable in this tree and becomes
// reachable again when the concept's §5/§6 scope probe lands.
//
// ── #2176 (epic #2166 B4) splits the "no personal credential" row by sender ──
// The table above governs equally whether the run is autonomous or a live
// chat turn — B3 (#2175) only re-keyed WHO the owner is, not whether the
// no-credential-at-all row still falls to shared. B4 says it should not, for
// an INTERACTIVE write: a human who never added a personal credential must be
// told to, not silently attributed to the team's shared identity. So the row
// splits in two, both driven by the new `interactive` flag on
// `resolveCredential` (see its own header comment):
//
//   owner, no personal cred., AUTONOMOUS   → shared, never refuse (unchanged)
//   owner, no personal cred., INTERACTIVE  → REFUSE (new, #2176 B4)
//
// The owner itself also changes for the autonomous row: it is no longer the
// static `resolveAgentOwnerId` but the team's CURRENT `team-admin`
// (`resolveBaselineOwnerId`) — the "baseline identity" the ticket names, which
// keeps working across a D4 succession without redeploying the agent.

const { resolveAgentTeam } = require("./agent-team");
const { resolveScopeOwner } = require("./ownership-migration");

const DEFAULT_TEAM_ID = "default";

// Attributed writes carry the human's name and MUST run under the owner's
// personal identity when an owner is set (concept §5 table). Everything else is
// a shared-eligible operation (read-only clone, the repo-check probe, event
// polling) where a shared team/system credential misattributes no one.
//
// `push-ssh` joined this set in #2175 (epic #2166 B3): the concept's §5 table
// always named "HTTPS/SSH push" together, but no SSH-key resolver existed
// until B3 built `resolveAttributedSshKey` — so it sat classified alongside
// the shared-eligible operations only for lack of a resolver to prefer.
const ATTRIBUTED_OPERATIONS = new Set(["commit", "pr", "review", "push-https", "push-ssh"]);

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

// Resolve the owner id an ATTRIBUTED WRITE should run under (#2175, epic #2166
// block B3). `resolveAgentOwnerId` alone answers "who does this agent's config
// say it belongs to" — the static team-creator identity B1's Matrix-identity
// work now lets us do better than for an INTERACTIVE run: the human actually
// chatting right now (the caller resolves their Matrix sender id to a platform
// user id and passes it in here) is who the write must be attributed to, not
// whoever happened to create the team.
//
// `actingSenderUserId` is null for every run this cannot apply to — an
// autonomous trigger (cron/github-event/loop) carries no chat sender at all,
// and an unresolvable/unprovisioned sender resolves to null upstream — and the
// resolution falls through to the existing static `resolveAgentOwnerId`
// unchanged, which is what keeps autonomous runs byte-identical to before B3
// (the ticket's own AC).
function resolveEffectiveOwnerId(cfg, loadAgentConfig, actingSenderUserId, baselineDeps) {
  const acting = actingSenderUserId != null && String(actingSenderUserId) !== ""
    ? String(actingSenderUserId)
    : null;
  if (acting) return acting;
  return resolveBaselineOwnerId(cfg, { loadAgentConfig, ...(baselineDeps || {}) });
}

// The BASELINE owner for non-interactive work (#2176, epic #2166 B4): the
// identity an autonomous run (cron/github-event/loop, no acting sender)
// resolves credentials under. For a team-bounded agent (`resolveAgentTeam`
// resolves a team id) this is the team's CURRENT `team-admin` — not the
// static, immutable `ownerId` the team was created with — so a D4 succession
// (`team-admin-succession.js`) is honoured without redeploying the agent:
// `resolveScopeOwner` reads whoever presently holds `team-admin` in the
// membership array, preferring the earliest-promoted admin when several
// exist (a team that never changed hands resolves to its creator, same as
// before). A standalone `role: 'agent'` has no team to defer to
// (`resolveAgentTeam` → `null`) and keeps resolving to its own static owner,
// unchanged.
//
// `users`/`memberships` are the caller's already-loaded snapshots — this
// module takes no fs dependency of its own. Omitting them (or handing over
// an empty/unreadable snapshot) degrades to the static owner rather than to
// `null`, the same fail-open direction `buildLiveUserGate` takes: an
// unreadable membership index must not disable every autonomous run's
// credential resolution at once.
function resolveBaselineOwnerId(cfg, { loadAgentConfig, users, memberships } = {}) {
  const teamId = resolveAgentTeam(cfg);
  if (teamId) {
    const scopeOwner = resolveScopeOwner({ scopeId: teamId, users, memberships });
    if (scopeOwner) return scopeOwner;
  }
  return resolveAgentOwnerId(cfg, loadAgentConfig);
}

// Is `userId` someone this agent could legitimately be acting for right now
// (#2187 review finding, hardening #2175/B3)?
//
// `AEE_ACTING_SENDER` is set once into the Claude subprocess's environment for
// a live chat turn, but for the rest of that run it is just an ordinary env
// var: any Bash tool call the agent makes — potentially steered by content it
// read, e.g. a prompt injection in an issue or file — can overwrite it before
// calling `gh-as-agent`, which forwards whatever value is CURRENTLY present
// with no signature or binding to the real triggering Matrix event.
// `resolveEffectiveOwnerId` above trusts its `actingSenderUserId` argument
// unconditionally, so the caller MUST filter it through this predicate first —
// a self-asserted identity in a request body is never authentication on its
// own (the same discipline `wake-agent.js`'s producer-id cross-check applies
// against the caller's real team, #2030).
//
// The boundary: a team-bound agent (a `team` or one of its `team-member`s)
// trusts only its own team's members; a standalone agent (D8, no team
// boundary — `resolveAgentTeam` returns null) trusts only its own owner, the
// one relationship it has. This closes cross-team (and, for a standalone
// agent, cross-owner) impersonation — it does not make the claim unforgeable
// within that boundary, which would need a signed, per-run claim the
// container cannot re-mint; that is a larger, separate hardening step.
//
// `hasMembership(teamId, userId)` is the injected, impure membership lookup
// (mirrors `loadAgentConfig` above) — this module stays fs-free.
function isActingSenderTrusted(cfg, userId, hasMembership) {
  if (!userId) return false;
  const teamId = resolveAgentTeam(cfg);
  if (teamId) {
    return typeof hasMembership === "function" ? !!hasMembership(teamId, userId) : false;
  }
  return !!(cfg && cfg.ownerId && String(cfg.ownerId) === String(userId));
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
function findPersonalCredential(index, ownerId, isUsable, liveUsers) {
  return findPersonalCredentialState(index, ownerId, isUsable, liveUsers).entry;
}

// The same lookup, but reporting whether the owner has a personal credential of
// this kind AT ALL — separately from whether it is usable.
//
// `resolveCredential` needs the two apart (see the #2077 note in the header):
// "the owner has none" is the state every human is in until they opt into the
// personal tier and must keep behaving exactly as today, while "the owner has
// one but it is underscoped" is the case refuse-on-missing exists for. Folding
// both into a bare `null` is what made the old `ownerId`-presence switch the
// only available one.
//
// Returns `{ entry, present, orphaned }`:
//   entry    — the owner's usable personal credential, or null
//   present  — the owner has a personal credential of this kind, usable or not
//   orphaned — that credential exists but its `userId` is not a live user
//
// ── The orphan gate (#2138 AC6) ─────────────────────────────────────────────
// Until #2138 this lookup matched on `scope` and `userId` alone and never asked
// whether the user still exists. Because #2135 had killed offboarding outright,
// a deleted human's personal PAT stayed on disk, kept matching here, and their
// agents kept pushing under it — with no refusal, because the refusal branch
// needs a credential that is present but UNUSABLE and this one worked fine.
//
// `liveUsers` closes that independently of the offboarding path: an entry whose
// owner is gone is reported present-but-not-usable, which routes an attributed
// write into `resolveCredential`'s refusal instead of a silent success. Cleanup
// fixes today's orphans; this makes the next one inert on the day it is created.
//
// `liveUsers` is a `{ known, isLive }` gate (see `buildLiveUserGate`) and is
// OPTIONAL: when it is absent, or reports `known: false` because the caller
// could not read the user index, the check does not run and behaviour is exactly
// as before. That direction is deliberate — an unreadable user index must not
// turn every personal credential on the installation into a refusal.
function findPersonalCredentialState(index, ownerId, isUsable, liveUsers) {
  if (!Array.isArray(index) || !ownerId) return { entry: null, present: false, orphaned: false };
  const check = typeof isUsable === "function" ? isUsable : () => true;
  const ownerLive = isLiveUnderGate(liveUsers, ownerId);
  let present = false;
  for (const candidate of index) {
    if (
      !candidate ||
      candidate.scope !== "personal" ||
      !candidate.userId ||
      String(candidate.userId) !== String(ownerId)
    ) {
      continue;
    }
    present = true;
    // An orphan is never returned as usable, whatever `isUsable` says — the
    // owner's absence is the disqualifier, not the credential's scopes.
    if (ownerLive && check(candidate)) return { entry: candidate, present: true, orphaned: false };
  }
  return { entry: null, present, orphaned: present && !ownerLive };
}

// Build the live-user gate `findPersonalCredentialState` and the offboarding
// sweep consume, from whatever the caller managed to read of the user index.
//
// Returns `{ known, isLive }`. `known: false` means "we do not know who is
// live" and every consumer of the gate must then behave as it did before the
// gate existed — no refusal, no sweep. This is the whole fail-open story, in one
// place, so the two consumers cannot disagree about it.
//
// An EMPTY array counts as unknown, not as "nobody is live". `teams-store`'s
// `readArray` returns `[]` for an unreadable or malformed index just as it does
// for a genuinely empty one, and a booted installation always has at least the
// seeded System Admin (whose deletion the store refuses) — so an empty list is
// in practice a read failure, and treating it as authoritative would refuse
// every attributed write on the installation at once.
function buildLiveUserGate(users) {
  if (!Array.isArray(users) || users.length === 0) {
    return { known: false, isLive: () => true };
  }
  const live = new Set();
  for (const u of users) {
    if (u && u.id != null && String(u.id) !== "") live.add(String(u.id));
  }
  if (live.size === 0) return { known: false, isLive: () => true };
  return { known: true, isLive: (id) => live.has(String(id)) };
}

// Apply a `buildLiveUserGate` result. A missing/unknown gate answers "live" so
// every caller degrades to pre-#2138 behaviour.
function isLiveUnderGate(gate, userId) {
  if (!gate || gate.known !== true || typeof gate.isLive !== "function") return true;
  return gate.isLive(userId) === true;
}

// The core decision. Given the operation, the resolved owner, the owner's usable
// personal credential (or null), and the environment's shared credential id,
// return exactly one of:
//
//   { tier: 'personal', credentialId }        — AC1: owner's personal credential
//   { tier: 'shared', credentialId | null }    — AC8 (no owner, or an owner with
//                                                no personal credential) / AC2
//                                                (read/poll)
//   { refuse: { code, message } }              — AC2/AC5: owned attributed write
//                                                whose owner HAS a personal
//                                                credential that is unusable
//
// `kind` labels the credential in the refusal message ("GitHub token" / "SSH
// key"). `personalCredential` is what `findPersonalCredential` returned, and
// `personalCredentialPresent` is the `present` half of
// `findPersonalCredentialState` — the owner has one of this kind, usable or not.
//
// It defaults to `false`, i.e. "the owner does not participate in the personal
// tier", which is the branch that behaves exactly as the platform does today.
// A caller that wants refuse-on-missing must therefore say so by reporting a
// credential it actually found — the refusal can no longer be reached by
// omission, which is what made populating `ownerId` an outage before #2077.
//
// `interactive` (#2176, epic #2166 B4) widens the refusal for an INTERACTIVE
// attributed write only: today's rule (`personalCredentialPresent`) refuses
// only when the owner's personal credential is present-but-unusable, and
// falls to shared when the owner has none at all — the #2077 AC7 branch every
// agent needs until it opts into the personal tier. That branch is still
// correct for an AUTONOMOUS run (B4's baseline point: it must always have a
// working path, never block on a human who never set one up), but a human
// actually chatting right now must never have their write silently
// re-attributed to a shared identity just because they have not added a
// credential yet — that is exactly the "silent failure" B4's own AC refuses.
// So an interactive write refuses on ABSENT-OR-UNUSABLE; an autonomous one
// keeps refusing only on present-but-unusable, exactly as before.
function resolveCredential({
  operation,
  ownerId,
  personalCredential = null,
  personalCredentialPresent = false,
  personalCredentialOrphaned = false,
  sharedCredentialId = null,
  kind = "GitHub token",
  interactive = false,
}) {
  const attributed = operationPrefersPersonal(operation);

  // No owner → the personal tier never applies. Use the shared team/system
  // credential exactly as today, and NEVER refuse (AC8). Until #2077 this was
  // the branch every agent took; it now covers a `team-member` whose parent
  // team is somehow unowned, and any role D8 leaves unowned.
  if (!ownerId) {
    return { tier: "shared", credentialId: sharedCredentialId || null };
  }

  // Owner known + a usable personal credential exists → prefer it (AC1).
  if (personalCredential && personalCredential.id) {
    return { tier: "personal", credentialId: personalCredential.id };
  }

  // Owner known, and EITHER the owner HAS a personal credential of this kind
  // that the caller's usability check rejected (present but underscoped) OR
  // this is an INTERACTIVE write and the owner has no usable credential at
  // all (#2176 B4 — see the header comment above).
  if (attributed && (personalCredentialPresent || interactive)) {
    // Refuse — an attributed write must NEVER silently drop to a shared
    // team/system credential and act under someone else's name (AC2/AC5, D5).
    //
    // #2138 adds a second way to land here: the credential is fine, but its
    // owner is no longer a live user. The remedy is the opposite one (an
    // operator finishes the offboarding; nobody can "add a personal token" for
    // a deleted person), so it gets its own message and code.
    return {
      refuse: personalCredentialOrphaned
        ? buildOrphanRefusal(ownerId, kind)
        : buildRefusal(ownerId, kind),
    };
  }

  // Owner known but the owner has NO personal credential of this kind at all —
  // they have not opted into the personal tier. Take the shared credential
  // exactly as the platform does today; refusing here would take a human who
  // never asked for personal credentials offline (#2077 AC7).

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

// Offboarding RECONCILIATION selection (#2138 AC1/AC2). Every deletion between
// 2026-08-11 and the #2135 fix left the person's personal credentials on disk
// and their agents running, because the one call to `offboardOwner` threw a
// ReferenceError into a `catch` that only logged. This selects the humans that
// happened to — the owners whose offboarding still has to be replayed.
//
// An owner qualifies when it is NOT a live user and it still owns something:
// a `personal` entry in either credential index, or an agent whose resolved
// owner it is. Both halves matter — the credential is the security exposure,
// the running agent is the one still using it — and `offboardOwner` handles
// each idempotently, so replaying it over this list is safe.
//
// Pure — the caller supplies the two index arrays, the already-loaded agent
// configs and the live-user gate. Returns the owner ids in first-seen order.
// An UNKNOWN gate (`buildLiveUserGate` could not read the user index) returns
// `[]`: with nobody known to be live, "not a live user" is true of everyone,
// and a sweep run on that belief would drain the whole installation.
function selectOrphanedOwnerIds({ credentialIndexes = [], agents = [], loadAgentConfig, liveUsers } = {}) {
  if (!liveUsers || liveUsers.known !== true) return [];
  const seen = new Set();
  const ids = [];
  const consider = (raw) => {
    const id = raw != null && String(raw) !== "" ? String(raw) : null;
    if (!id || seen.has(id)) return;
    seen.add(id);
    if (!isLiveUnderGate(liveUsers, id)) ids.push(id);
  };
  for (const index of credentialIndexes) {
    if (!Array.isArray(index)) continue;
    for (const entry of index) {
      if (entry && entry.scope === "personal" && entry.userId) consider(entry.userId);
    }
  }
  for (const a of Array.isArray(agents) ? agents : []) {
    if (!a || !a.cfg) continue;
    consider(resolveAgentOwnerId(a.cfg, loadAgentConfig));
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

// The orphan refusal (#2138 AC6). Deliberately NOT the message above: it would
// tell the reader to add a personal credential for a user record that no longer
// exists. What actually has to happen is an offboarding that never completed,
// plus revoking the credential at GitHub — it was usable the whole time.
function buildOrphanRefusal(ownerId, kind) {
  return {
    code: "owner-not-a-live-user",
    message:
      `Refusing to run an attributed GitHub write: this agent's owner (${ownerId}) is no longer ` +
      `a user on this platform, and their personal ${kind} must not keep acting on their behalf. ` +
      `Finish the offboarding — delete the orphaned credential and revoke it at GitHub — then ` +
      `re-own or delete this agent. The run will NOT fall back to a team or system credential.`,
  };
}

module.exports = {
  DEFAULT_TEAM_ID,
  ATTRIBUTED_OPERATIONS,
  operationPrefersPersonal,
  resolveAgentOwnerId,
  resolveEffectiveOwnerId,
  resolveBaselineOwnerId,
  isActingSenderTrusted,
  findPersonalCredential,
  findPersonalCredentialState,
  buildLiveUserGate,
  resolveCredential,
  selectAgentIdsForOwner,
  selectPersonalCredentialIds,
  selectOrphanedOwnerIds,
  buildRefusal,
  buildOrphanRefusal,
};
