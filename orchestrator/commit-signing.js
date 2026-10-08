"use strict";

// SSH commit signing (#2938) — the PURE decision core. No fs, no network, no
// orchestrator state; orchestrator.js wraps it (reading the SSH-key index,
// running `ssh-keygen -Y sign`, threading the git config into each git call).
//
// Background: GitHub Enterprise rejects every commit that is not signed and
// verified once an org enforces it (Accenture: from 2026-10-23). The signing key
// is OPTIONAL in Agent Studio — with none resolvable every commit is created
// unsigned exactly as before — and a rejection by GitHub is turned into one
// actionable message (`buildUnsignedRejectionMessage`).
//
// ── What a signing key IS here ──────────────────────────────────────────────
// A stored SSH key (the existing `/api/ssh-keys` store, scopes personal / team /
// system) that carries a `signing: { name, email }` commit identity. The same
// key may also be the push/auth key, or a separate key used only for signing —
// GitHub accepts one key registered both as Authentication and as Signing key.
// GitHub only marks a signature Verified when the COMMITTER email is a verified
// email of the account that registered the signing key, so the identity is part
// of the key, and signed commits are committed as that identity. The AUTHOR is
// left alone, so `<id>@agents.local` (loop protection, push attribution) stays.
//
// ── Which key signs (same precedence as the push credential) ────────────────
// personal → team → global, through `credential-resolution.js`
// `resolveCredential` with the never-refusing operation `sign`: the effective
// owner (the trusted acting chat sender, else the team's current Team Admin)
// signs with their first personal signing key; else the team's key
// (`selectTeamSigningKeyId`); else a global service signing key; else none.
// A missing key never refuses anything — signing is optional (AC3/AC14).

const credentialResolution = require("./credential-resolution");

const SIGN_OPERATION = "sign";
const SIGNING_NAMESPACE = "git";
const NAME_MAX = 100;
const EMAIL_MAX = 254;
// Same shape the admin-console validates on save; re-checked here because the
// identity ends up inside a `-c committer.email=…` git argument.
const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

// The `{ name, email }` signing identity of an index entry, or null when the key
// is not a (valid) signing key. Defensive: the index is a JSON file on disk.
function signingIdentityOf(entry) {
  const s = entry && typeof entry === "object" ? entry.signing : null;
  if (!s || typeof s !== "object") return null;
  const name = typeof s.name === "string" ? s.name.trim() : "";
  const email = typeof s.email === "string" ? s.email.trim() : "";
  if (!name || name.length > NAME_MAX || /[\r\n<>]/.test(name)) return null;
  if (!email || email.length > EMAIL_MAX || !EMAIL_RE.test(email)) return null;
  return { name, email };
}

function hasSigningIdentity(entry) {
  return signingIdentityOf(entry) !== null;
}

// Only the keys that can sign — the index the tier resolution runs over.
function signingKeyIndex(index) {
  return (Array.isArray(index) ? index : []).filter(hasSigningIdentity);
}

// The TEAM tier's signing key for an environment, or null. First match wins:
//   1. a key the environment's repositories already use for push, when it also
//      carries a signing identity (one key for both, the simplest setup);
//   2. a team-scoped signing key owned by the environment's team;
//   3. a system key assigned to that team (not a global one — that is tier 3).
// `index` must already be the signing-capable subset (`signingKeyIndex`).
function selectTeamSigningKeyId(index, env) {
  const keys = Array.isArray(index) ? index : [];
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  for (const r of repos) {
    if (!r || !r.sshKeyId) continue;
    const hit = keys.find((k) => k && k.id === r.sshKeyId && k.scope !== "personal");
    if (hit) return String(hit.id);
  }
  const teamId = env && env.teamId ? String(env.teamId) : null;
  if (!teamId) return null;
  const team = keys.find((k) => k && k.id && k.scope === "team" && String(k.teamId || "") === teamId);
  if (team) return String(team.id);
  const assigned = keys.find((k) => k && k.id && k.scope === "system" && k.global !== true
    && Array.isArray(k.assignedTeamIds) && k.assignedTeamIds.map(String).includes(teamId));
  return assigned ? String(assigned.id) : null;
}

// Resolve the signing key for one owner + environment.
// Returns { source: 'personal'|'team'|'global'|'none', keyId, ownerId, identity }.
// `ownerId` is the effective owner the caller already resolved (acting sender or
// baseline Team Admin; null for a team-only operation such as a KB convergence
// commit). Never refuses.
function resolveSigningKey({ index, ownerId = null, env = null, liveUsers } = {}) {
  const keys = signingKeyIndex(index);
  const teamKeyId = selectTeamSigningKeyId(keys, env);
  const globalKeyId = credentialResolution.selectGlobalServiceCredentialId(keys);
  const personal = ownerId
    ? credentialResolution.findPersonalCredentialState(keys, ownerId, undefined, liveUsers)
    : { entry: null, present: false, orphaned: false };
  const decision = credentialResolution.resolveCredential({
    operation: SIGN_OPERATION,
    ownerId,
    personalCredential: personal.entry,
    personalCredentialPresent: personal.present,
    personalCredentialOrphaned: personal.orphaned,
    sharedCredentialId: teamKeyId,
    kind: "SSH signing key",
    globalServiceCredentialId: globalKeyId,
  });
  const keyId = decision.credentialId || null;
  let source = "none";
  if (decision.tier === "personal") source = "personal";
  else if (keyId && keyId === teamKeyId) source = "team";
  else if (keyId) source = "global";
  const entry = keyId ? keys.find((k) => String(k.id) === keyId) : null;
  return { source, keyId, ownerId: ownerId || null, identity: entry ? signingIdentityOf(entry) : null };
}

// The git config (key/value pairs) that makes every commit-creating command —
// commit, amend, cherry-pick, rebase, merge, revert — sign with SSH as the
// key's identity. `signingKey` is either a private-key PATH (orchestrator side)
// or a literal `key::ssh-ed25519 …` public key (agent side, where the private
// key never enters the container and `program` forwards the signing request).
// committer.* (not user.*) so the author — and with it the `<id>@agents.local`
// loop-protection marker — is untouched; an explicit `-c user.email=…` (as
// gh-as-agent / knowledge set it) cannot override the committer either.
function buildSigningGitConfig({ identity, signingKey, program = null, label = null } = {}) {
  if (!identity || !identity.email || !identity.name || !signingKey) return [];
  const out = [
    ["gpg.format", "ssh"],
    ["user.signingkey", String(signingKey)],
    ["commit.gpgsign", "true"],
    ["committer.name", identity.name],
    ["committer.email", identity.email],
  ];
  if (program) out.push(["gpg.ssh.program", String(program)]);
  // Read back by the signing helper to name the credential in a failure.
  if (label) out.push(["aee.signingkeylabel", String(label)]);
  return out;
}

// Append config pairs to an env's GIT_CONFIG_COUNT/KEY_n/VALUE_n list without
// clobbering entries already there (buildRepoGitEnv sets the PAT extraheader as
// entry 0). Returns a NEW env object; the input is not mutated.
function withGitConfigEnv(baseEnv, pairs) {
  const env = { ...(baseEnv || {}) };
  if (!Array.isArray(pairs) || pairs.length === 0) return env;
  let n = Number.parseInt(env.GIT_CONFIG_COUNT || "0", 10);
  if (!Number.isFinite(n) || n < 0) n = 0;
  for (const [k, v] of pairs) {
    env[`GIT_CONFIG_KEY_${n}`] = k;
    env[`GIT_CONFIG_VALUE_${n}`] = v;
    n += 1;
  }
  env.GIT_CONFIG_COUNT = String(n);
  return env;
}

// ── Recognising a "signed commits required" rejection ────────────────────────
// Push (ruleset GH013 / branch protection GH006), PR merge and update-branch all
// phrase it slightly differently; any of these marks the cause.
const UNSIGNED_PATTERNS = [
  /commits? must have (?:verified|valid) signatures?/i,
  /must have a verified signature/i,
  /requires? signed commits/i,
  /required signatures?/i,
  /unverified commits?/i,
  /unsigned commits?/i,
];

function isUnsignedCommitRejection(text) {
  const s = String(text || "");
  return UNSIGNED_PATTERNS.some((re) => re.test(s));
}

// The rejected commit SHAs GitHub lists (full 40-hex ids), deduplicated, capped.
function extractRejectedCommits(text, max = 10) {
  const seen = [];
  for (const m of String(text || "").matchAll(/\b[0-9a-f]{40}\b/g)) {
    if (!seen.includes(m[0])) seen.push(m[0]);
    if (seen.length >= max) break;
  }
  return seen;
}

const SCOPE_LABELS = {
  personal: "personal",
  team: "team",
  global: "global",
};

// The actionable message for an unsigned/unverified rejection (AC8).
// `signing` is the resolveSigningKey result for the identity that pushed;
// `pushScope` the tier of the push credential ('personal'|'team'|'global'|null);
// `operation` names what failed ('push', 'PR', 'merge').
function buildUnsignedRejectionMessage({ operation = "push", signing = null, pushScope = null, commits = [], ownerLabel = null } = {}) {
  const lines = [];
  lines.push(
    `GitHub rejected this ${operation}: this GitHub instance requires signed commits ` +
    `(every commit must have a verified signature).`,
  );
  const scope = signing && signing.source && signing.source !== "none" ? signing.source : null;
  if (!scope) {
    const missing = SCOPE_LABELS[pushScope] || "team";
    const who = missing === "personal" && ownerLabel ? ` (${ownerLabel})` : "";
    lines.push(
      `Cause: no signing key is configured for the ${missing}${who} credential this agent pushes with, ` +
      `nor at the team or global level, so the commits were created unsigned.`,
    );
  } else {
    lines.push(
      `Cause: the commits are signed with the ${SCOPE_LABELS[scope]} signing key '${signing.keyId}'` +
      (signing.identity ? ` as ${signing.identity.email}` : "") +
      `, but GitHub could not verify them — or they were created before the key was configured.`,
    );
  }
  if (Array.isArray(commits) && commits.length) {
    lines.push(`Affected commits: ${commits.map((c) => String(c).slice(0, 12)).join(", ")}`);
  }
  lines.push("How to fix:");
  lines.push(
    "1. In Agent Studio, open Credentials → SSH Keys (/ssh-keys) and add or generate a signing key " +
    "(personal, team or global) with the commit name and email it signs as.",
  );
  lines.push(
    "2. On GitHub, upload its public key as type \"Signing Key\" to the account whose VERIFIED email " +
    "is that commit email.",
  );
  lines.push(
    "3. Re-sign the affected commits in a new run (signing is applied automatically once a key resolves), " +
    "e.g. `git rebase --force-rebase <base-branch>`, then push again. If the branch was already pushed, " +
    "push the re-signed commits to a new branch rather than force-pushing over review history.",
  );
  return lines.join("\n");
}

module.exports = {
  SIGN_OPERATION,
  SIGNING_NAMESPACE,
  EMAIL_RE,
  signingIdentityOf,
  hasSigningIdentity,
  signingKeyIndex,
  selectTeamSigningKeyId,
  resolveSigningKey,
  buildSigningGitConfig,
  withGitConfigEnv,
  isUnsignedCommitRejection,
  extractRejectedCommits,
  buildUnsignedRejectionMessage,
};
