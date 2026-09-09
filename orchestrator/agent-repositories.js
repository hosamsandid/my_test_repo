"use strict";

// agent-repositories.js — pure decision core for AGENT-SCOPED repositories (#2067).
//
// A Working Environment's `repositories` apply to EVERY agent in that
// environment: `cloneEnvironmentRepositories` clones them at agent creation and
// `prompt-assembly.js` lists them in every member's system prompt. That is too
// blunt when only one agent needs one more repository — a reference codebase to
// read, a second service it has to touch, a documentation repo — so this module
// adds the per-agent escape hatch: `agentRepositories` on the agent's own
// config.json, edited from the agent's own UI, cloned into that agent's
// workspace and named in that agent's prompt. The precedent is per-agent host
// context folders (#1289/#1290), which are stored and edited exactly this way.
//
// The environment record is never touched (D3), no credential is stored on the
// entry (D5) and no allowlist governs which repository may be attached (D8) —
// the manage right on the agent is the only boundary (D4).
//
// Pure by construction: every decision below is a function of the two
// repository lists plus already-read credential METADATA (ids, never a secret)
// and already-read directory names. The fs / clone / delete half lives in
// orchestrator.js, so the rules stay unit-testable.

// The on-disk directory name a repo URL clones into. Deliberately re-exported
// from repo-sync.js rather than re-derived: that module already declares itself
// the canonical mirror of cloneRepository() / inspectAgentRepoStatuses(), and
// AC4 requires an agent-scoped repository to use the SAME convention. A third
// copy is exactly how the "shared by several code sites" constraint breaks.
const { repoDirName } = require("./repo-sync");

const ENVIRONMENT_SCOPE = "environment";
const AGENT_SCOPE = "agent";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

// The stored entry is field-for-field the environment repository card's shape
// (D2): url, branch, sshKeyId, readOnly — no reduced and no invented form.
// Anything else a client sends is dropped, so the config can never grow a
// per-repository credential (D5) through this door.
function normalizeAgentRepository(raw) {
  if (!raw || typeof raw !== "object") return null;
  const url = typeof raw.url === "string" ? raw.url.trim() : "";
  if (!url) return null;
  const branch = typeof raw.branch === "string" && raw.branch.trim() ? raw.branch.trim() : null;
  const sshKeyId = typeof raw.sshKeyId === "string" && raw.sshKeyId.trim() ? raw.sshKeyId.trim() : null;
  const entry = { url, branch, sshKeyId };
  // Written only when set, so an agent with no read-only repo is byte-identical
  // on disk to a pre-#2067 one (the `toolchainId` discipline).
  if (raw.readOnly === true) entry.readOnly = true;
  return entry;
}

function normalizeAgentRepositories(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const entry = normalizeAgentRepository(raw);
    if (!entry) continue;
    // Same URL twice in one stored list is a corrupt record, not a state a
    // caller can reach through planAgentRepoAttach — collapse it on read so
    // every consumer (prompt, clone, list) sees one entry per repository.
    if (seen.has(entry.url)) continue;
    seen.add(entry.url);
    out.push(entry);
  }
  return out;
}

function envRepositories(env) {
  if (!env || !Array.isArray(env.repositories)) return [];
  return env.repositories.filter((r) => r && typeof r.url === "string" && r.url.trim());
}

// ---------------------------------------------------------------------------
// The merged view every human- and agent-facing surface reads
// ---------------------------------------------------------------------------

// One list, environment repositories first, each entry carrying its derived
// directory name and its `scope`. The scope is what makes an agent-scoped
// repository visually distinguishable (AC7) and what makes an inherited one
// non-editable (AC8) — a surface must never infer either from the URL.
//
// An agent entry whose directory name is already claimed by an environment
// repository is marked `shadowed`: the environment owns that directory, so the
// agent entry is listed (a human has to be able to see and remove it) but is
// never presented as the thing on disk. planAgentRepoAttach refuses to create
// that state; it can still arise when the ENVIRONMENT later adds the same
// repository, which is the edge case AC-side that must not end in a deleted
// environment repository.
function resolveAgentRepositories(env, agentRepositories) {
  const resolved = [];
  const byDir = new Map();
  for (const repo of envRepositories(env)) {
    const dirName = repoDirName(repo.url);
    const entry = {
      url: repo.url,
      branch: repo.branch || null,
      sshKeyId: repo.sshKeyId || null,
      readOnly: repo.readOnly === true,
      dirName,
      scope: ENVIRONMENT_SCOPE,
      removable: false,
      shadowed: false,
    };
    if (!byDir.has(dirName)) byDir.set(dirName, entry);
    resolved.push(entry);
  }
  for (const repo of normalizeAgentRepositories(agentRepositories)) {
    const dirName = repoDirName(repo.url);
    const owner = byDir.get(dirName);
    resolved.push({
      url: repo.url,
      branch: repo.branch || null,
      sshKeyId: repo.sshKeyId || null,
      readOnly: repo.readOnly === true,
      dirName,
      scope: AGENT_SCOPE,
      removable: true,
      shadowed: Boolean(owner && owner.url !== repo.url),
    });
    if (!byDir.has(dirName)) byDir.set(dirName, resolved[resolved.length - 1]);
  }
  return resolved;
}

// Does this agent have a repository at all, from either scope? AC14: the Git /
// `gh-as-agent` prompt block is gated on the ENVIRONMENT having one today
// (`envHasRepository`), so on a repo-less environment (#1623) an attached
// repository would arrive with that whole guidance switched off.
function hasAnyRepository(env, agentRepositories) {
  return envRepositories(env).length > 0 || normalizeAgentRepositories(agentRepositories).length > 0;
}

// ---------------------------------------------------------------------------
// Credentials (D5 / AC19)
// ---------------------------------------------------------------------------

// Which transport a URL implies. Mirrors cloneRepository() exactly — the
// transport is chosen by the URL, never by which credentials happen to exist.
function repoTransport(url) {
  const value = String(url || "");
  if (/^(ssh:\/\/|git@)/.test(value)) return "ssh";
  if (/^https?:\/\/(www\.)?github\.com\//i.test(value)) return "https-github";
  if (/^https?:\/\//i.test(value)) return "https";
  return "other";
}

// AC19: refuse BEFORE any clone is attempted, and name which credential was
// tried and why it is not sufficient. `sshKeyIds` is the existing key
// registry's id list and `hasGithubToken` says whether the agent's environment
// carries a usable GitHub PAT — metadata only; no secret reaches this module.
// Returns null when the existing credentials can plausibly reach the URL.
function credentialRefusal(repo, credentials = {}) {
  const url = repo && typeof repo.url === "string" ? repo.url.trim() : "";
  if (!url) return null;
  const sshKeyIds = Array.isArray(credentials.sshKeyIds) ? credentials.sshKeyIds : [];
  const hasGithubToken = credentials.hasGithubToken === true;
  const sshKeyId = repo && typeof repo.sshKeyId === "string" && repo.sshKeyId.trim() ? repo.sshKeyId.trim() : null;
  const transport = repoTransport(url);

  if (transport === "ssh") {
    if (!sshKeyId) {
      return {
        code: "ssh-key-required",
        message:
          `\`${url}\` is an SSH URL, so the clone runs over SSH and needs an SSH key from the ` +
          `key registry. No key is selected, and a GitHub token does not authenticate an SSH ` +
          `transport — pick a key, or use the repository's HTTPS URL instead.`,
      };
    }
    if (!sshKeyIds.includes(sshKeyId)) {
      return {
        code: "ssh-key-missing",
        message:
          `The selected SSH key (\`${sshKeyId}\`) is no longer in the key registry, so the ` +
          `clone of \`${url}\` would fail on authentication. Pick a key that still exists.`,
      };
    }
    return null;
  }

  if (transport === "https-github" && !hasGithubToken) {
    return {
      code: "github-token-required",
      message:
        `\`${url}\` is an HTTPS GitHub URL, but this environment has no GitHub token, so there ` +
        `is nothing to authenticate the clone with. SSH keys do not authenticate HTTPS ` +
        `transports. Add a token to the Working Environment, or attach the repository by its ` +
        `SSH URL (\`git@github.com:…\`) and select an SSH key.`,
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Attach
// ---------------------------------------------------------------------------

// Plan one attachment. Every refusal carries a code (for the API) and a
// human-readable message (for both surfaces), and no refusal leaves anything
// behind because nothing is written until this returns ok (AC13).
//
//   env               — the agent's Working Environment record (may be null)
//   agentRepositories — the agent's currently attached list
//   repo              — the requested { url, branch?, sshKeyId?, readOnly? }
//   occupiedNames     — directory entries that already exist in the agent's
//                       workspace root (plain folders included, AC13)
//   credentials       — { sshKeyIds: [], hasGithubToken: bool }
function planAgentRepoAttach({ env, agentRepositories, repo, occupiedNames = [], credentials = {} } = {}) {
  const requested = normalizeAgentRepository(repo);
  if (!requested) {
    return { ok: false, code: "url-required", message: "A repository URL is required." };
  }

  const attached = normalizeAgentRepositories(agentRepositories);
  const envRepos = envRepositories(env);
  const dirName = repoDirName(requested.url);

  if (attached.some((r) => r.url === requested.url)) {
    return {
      ok: false,
      code: "already-attached",
      message: `\`${requested.url}\` is already attached to this agent.`,
      dirName,
    };
  }
  if (envRepos.some((r) => r.url.trim() === requested.url)) {
    return {
      ok: false,
      code: "environment-declares-repo",
      message:
        `\`${requested.url}\` already comes from the Working Environment, so this agent ` +
        `has it. Attaching it again would put a second entry on the same directory.`,
      dirName,
    };
  }

  // Directory-name collision. `org-a/tools` and `org-b/tools` both want
  // `./tools/`, and the same clash can be against an environment repository or
  // against an ordinary folder the agent created. The refusal names WHICH of
  // the three it is, because the fix differs; no renaming scheme is invented.
  const envClash = envRepos.find((r) => repoDirName(r.url) === dirName);
  if (envClash) {
    return {
      ok: false,
      code: "dir-name-taken-by-environment",
      message:
        `The clone directory \`./${dirName}/\` is already taken by the Working Environment's ` +
        `\`${envClash.url.trim()}\`. Two repositories cannot share one directory — the ` +
        `environment's repository stays.`,
      dirName,
    };
  }
  const agentClash = attached.find((r) => repoDirName(r.url) === dirName);
  if (agentClash) {
    return {
      ok: false,
      code: "dir-name-taken-by-agent-repo",
      message:
        `The clone directory \`./${dirName}/\` is already taken by \`${agentClash.url}\`, ` +
        `which is attached to this agent. Remove that one first if you meant to replace it.`,
      dirName,
    };
  }
  const occupied = (Array.isArray(occupiedNames) ? occupiedNames : []).map((n) => String(n));
  if (occupied.includes(dirName)) {
    return {
      ok: false,
      code: "dir-name-occupied",
      message:
        `\`./${dirName}/\` already exists in this agent's workspace and is not a repository ` +
        `this console manages. Nothing was cloned — rename or remove that folder first.`,
      dirName,
    };
  }

  const refusal = credentialRefusal(requested, credentials);
  if (refusal) {
    return { ok: false, code: refusal.code, message: refusal.message, dirName };
  }

  return { ok: true, repo: requested, dirName, agentRepositories: [...attached, requested] };
}

// ---------------------------------------------------------------------------
// Detach
// ---------------------------------------------------------------------------

// Plan one removal. Two refusals and one deliberate half-measure:
//
//   • an ENVIRONMENT repository is never removable here (AC8) — the
//     environment stays the only place to change those;
//   • an unknown URL is a 404 rather than a silent success;
//   • when the environment has SINCE added the same repository, the agent-scoped
//     entry is dropped but the working copy is KEPT — deleting it would delete a
//     repository the environment now declares, which is the one outcome the
//     edge case forbids.
function planAgentRepoDetach({ env, agentRepositories, url } = {}) {
  const target = typeof url === "string" ? url.trim() : "";
  if (!target) {
    return { ok: false, code: "url-required", message: "A repository URL is required." };
  }
  const attached = normalizeAgentRepositories(agentRepositories);
  const entry = attached.find((r) => r.url === target);
  if (!entry) {
    const envRepos = envRepositories(env);
    if (envRepos.some((r) => r.url.trim() === target)) {
      return {
        ok: false,
        code: "environment-repository",
        message:
          `\`${target}\` comes from the Working Environment, not from this agent. Change it ` +
          `on the Working Environment — every agent in that environment shares it.`,
      };
    }
    return {
      ok: false,
      code: "not-attached",
      message: `\`${target}\` is not attached to this agent.`,
    };
  }

  const dirName = repoDirName(entry.url);
  const envRepos = envRepositories(env);
  const envOwnsDir = envRepos.some((r) => repoDirName(r.url) === dirName);

  return {
    ok: true,
    repo: entry,
    dirName,
    // AC9: removal deletes the working copy — except when the environment now
    // declares the same directory, where the files are no longer this entry's
    // to delete.
    deleteWorkingCopy: !envOwnsDir,
    keptReason: envOwnsDir
      ? `\`./${dirName}/\` is now also declared by the Working Environment, so the working ` +
        `copy was kept — only the agent-scoped attachment was removed.`
      : null,
    agentRepositories: attached.filter((r) => r.url !== entry.url),
  };
}

// ---------------------------------------------------------------------------
// Removal confirmation copy (AC9)
// ---------------------------------------------------------------------------

// Turn an inspectAgentRepoStatuses-shaped record into the confirmation's facts.
// A generic "you may lose work" warning is what makes people click through, so
// the dirty state is NAMED — how many files, how many unpushed commits — and a
// clean working copy is said to be clean rather than left to inference.
//
// `status` may be null/absent (the directory was never cloned or the git
// plumbing failed); the shape stays the same so a caller never branches on it.
function removalFacts(status) {
  const s = status && typeof status === "object" ? status : null;
  if (!s || s.exists !== true) {
    return { state: "absent", clean: true, uncommittedFiles: 0, unpushedCommits: 0, lines: [] };
  }
  if (s.error) {
    return {
      state: "unknown",
      clean: false,
      uncommittedFiles: 0,
      unpushedCommits: 0,
      lines: [`Its state could not be read (${String(s.error)}), so it may contain unsaved work.`],
    };
  }
  const dirty = s.dirty && typeof s.dirty === "object" ? s.dirty : {};
  const uncommittedFiles = Array.isArray(dirty.files)
    ? dirty.files.length
    : (Number(dirty.staged) || 0) + (Number(dirty.unstaged) || 0) + (Number(dirty.untracked) || 0);
  const unpushedCommits = Number.isFinite(Number(s.ahead)) ? Math.max(0, Number(s.ahead)) : 0;
  const lines = [];
  if (uncommittedFiles > 0) {
    lines.push(
      `${uncommittedFiles} uncommitted ${uncommittedFiles === 1 ? "change" : "changes"} ` +
        `(${plural(dirty.staged, "staged")}, ${plural(dirty.unstaged, "unstaged")}, ` +
        `${plural(dirty.untracked, "untracked")}) would be lost.`,
    );
  }
  if (unpushedCommits > 0) {
    lines.push(
      `${unpushedCommits} ${unpushedCommits === 1 ? "commit has" : "commits have"} not been ` +
        `pushed and would be lost.`,
    );
  }
  if (!lines.length) {
    lines.push("The working copy is clean and fully pushed — nothing unsaved would be lost.");
  }
  return {
    state: lines.length && (uncommittedFiles > 0 || unpushedCommits > 0) ? "dirty" : "clean",
    clean: uncommittedFiles === 0 && unpushedCommits === 0,
    uncommittedFiles,
    unpushedCommits,
    lines,
  };
}

function plural(n, label) {
  const value = Number(n) || 0;
  return `${value} ${label}`;
}

// ---------------------------------------------------------------------------
// When the action is offered at all (AC16 / AC17)
// ---------------------------------------------------------------------------

// AC16: a `team` record has no container and no workspace, and a stub member
// has no seeded workspace — there is nothing to clone into, so the action is
// disabled WITH the reason rather than silently absent (a missing button
// answers "where is it?" with silence).
//
// AC17: attaching is safe by construction while a session runs — it only adds a
// new directory, exactly like #1342's Sync repositories, which deliberately
// clones into a live workspace with no respawn. REMOVING deletes files under
// the running agent's own working directory, so that is refused with a reason.
// Either way the behaviour is deterministic and stated, never silently applied.
function attachAvailability(agent = {}) {
  const role = agent && agent.role ? String(agent.role) : "agent";
  if (role === "team") {
    return {
      canAttach: false,
      canRemove: false,
      reason:
        "A team record has no container and no workspace of its own — attach the repository to " +
        "one of its members instead.",
    };
  }
  if (agent && agent.materialized === false) {
    return {
      canAttach: false,
      canRemove: false,
      reason:
        "This agent has not been materialized yet, so it has no workspace to clone into. " +
        "Materialize it first.",
    };
  }
  if (agent && agent.canManage === false) {
    return {
      canAttach: false,
      canRemove: false,
      reason: "You do not have permission to manage this agent.",
    };
  }
  if (agent && agent.busy === true) {
    return {
      canAttach: true,
      canRemove: false,
      reason:
        "This agent is running a session. Attaching is safe — it only adds a new directory — " +
        "but removing a repository deletes files it may be using, so wait until the run ends.",
    };
  }
  return { canAttach: true, canRemove: true, reason: null };
}

module.exports = {
  ENVIRONMENT_SCOPE,
  AGENT_SCOPE,
  repoDirName,
  normalizeAgentRepository,
  normalizeAgentRepositories,
  envRepositories,
  resolveAgentRepositories,
  hasAnyRepository,
  repoTransport,
  credentialRefusal,
  planAgentRepoAttach,
  planAgentRepoDetach,
  removalFacts,
  attachAvailability,
};
