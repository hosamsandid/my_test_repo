// agent-git-ops.js — orchestrator-side git push / PR creation on behalf of an
// agent.
//
// Why this exists: when an agent authenticates against api.anthropic.com with
// an enterprise subscription OAuth token (authType: "oauth-token"), Claude Code
// fetches and enforces the organisation's *server-managed* settings. Those
// settings can carry an `ask` rule that forces interactive human approval for
// `git push` / `gh pr create`, and managed settings sit at the top of the
// precedence order — no CLI flag (`--permission-mode`, `--allowedTools`) can
// override them. In an unattended (triggered / scheduled) run there is no human
// at the terminal, so the tool call blocks and the agent reports it could not
// push or open the PR.
//
// The fix keeps the agent's *own* git work local (commits are not blocked) and
// moves the network-facing `git push` / `gh pr create` out of the policy-
// governed Claude CLI into the orchestrator process. The orchestrator shares
// the agent's workspace volume, so it sees the agent's commits and pushes them
// with the environment's own credentials (SSH deploy key or GitHub PAT). This
// is not a policy bypass of the Claude CLI — it is a separate, operator-owned
// system action.
//
// This module holds the pure/injectable pieces (repo resolution, credential
// env assembly, argument validation, output sanitising) so they can be unit
// tested without a live orchestrator or a real git remote.

"use strict";

const nodeFs = require("fs");
const nodePath = require("path");

// Match the orchestrator's HTTPS-GitHub detection so credential injection is
// consistent between clone (orchestrator.js) and push (here).
function isHttpsGithubUrl(url) {
  return /^https?:\/\/(www\.)?github\.com\//i.test(String(url || ""));
}

function isSshUrl(url) {
  const u = String(url || "");
  return u.startsWith("git@") || u.startsWith("ssh://");
}

// Branch names the agent must never push to directly. The agent workflow
// (agent-image/CLAUDE.md) mandates feature branches + PRs; a direct push to the
// integration branch is almost always a mistake and defeats review.
const PROTECTED_BRANCHES = new Set(["main", "master", "develop", "trunk"]);

// A conservative git ref validator. Rejects the option-injection and traversal
// shapes that matter when the value is spliced into an argv or a remote ref.
// Not a full git check-ref-format, deliberately — we only need "is this a
// plausible, safe branch name we can hand to `git push`".
function isValidBranchName(branch) {
  if (typeof branch !== "string") return false;
  if (branch.length === 0 || branch.length > 255) return false;
  if (branch.startsWith("-")) return false; // no option injection
  if (branch.startsWith("/") || branch.endsWith("/")) return false;
  if (branch.includes("..") || branch.includes("//")) return false;
  if (branch.endsWith(".lock")) return false;
  // Disallow whitespace, control chars, and the git-special metacharacters.
  if (/[\s~^:?*\[\\\0]/.test(branch)) return false;
  return true;
}

// Resolve which repo of the agent's environment a push/PR targets, and where it
// lives in the orchestrator's view of the shared workspace volume.
//
//   repositories    – env.repositories array ([{ url, branch, sshKeyId }, ...])
//   requestedRepo   – optional basename the agent asked for (git toplevel dir).
//                     Omit when the env has exactly one repo.
//   agentWorkspace  – absolute path to the agent's workspace (agentDir(id)).
//
// Returns { name, url, repoPath, sshKeyId, branch }. Throws a caller-facing
// Error (message safe to return over the API) on any ambiguity or mismatch.
function resolveAgentRepo({
  repositories,
  requestedRepo,
  agentWorkspace,
  fs = nodeFs,
  path = nodePath,
}) {
  const repos = Array.isArray(repositories) ? repositories.filter((r) => r && r.url) : [];
  if (repos.length === 0) {
    throw new Error("this agent's environment has no repository configured");
  }

  const named = repos.map((r) => ({
    ...r,
    name: (r.url.split("/").pop() || "repo").replace(/\.git$/, ""),
  }));

  let chosen;
  if (requestedRepo) {
    if (!isSafePathSeg(requestedRepo)) {
      throw new Error(`invalid repo name: ${requestedRepo}`);
    }
    chosen = named.find((r) => r.name === requestedRepo);
    if (!chosen) {
      const avail = named.map((r) => r.name).join(", ");
      throw new Error(`repo '${requestedRepo}' is not in this environment (have: ${avail})`);
    }
  } else if (named.length === 1) {
    chosen = named[0];
  } else {
    const avail = named.map((r) => r.name).join(", ");
    throw new Error(`environment has multiple repos — specify one of: ${avail}`);
  }

  const repoPath = path.join(agentWorkspace, chosen.name);
  if (!fs.existsSync(path.join(repoPath, ".git"))) {
    throw new Error(`repo '${chosen.name}' has not been cloned into the workspace yet`);
  }

  return {
    name: chosen.name,
    url: chosen.url,
    repoPath,
    sshKeyId: chosen.sshKeyId || null,
    branch: chosen.branch || null,
  };
}

// Duplicated from orchestrator.js so this module stays self-contained and
// testable. Kept in sync intentionally.
function isSafePathSeg(s) {
  return (
    typeof s === "string" &&
    s.length > 0 &&
    s.length <= 256 &&
    !s.includes("/") &&
    !s.includes("\\") &&
    !s.includes("..") &&
    !s.includes("\0")
  );
}

// Assemble the git environment for a push against `repoUrl`, mirroring the
// credential injection the orchestrator uses at clone time:
//   - SSH URL  → GIT_SSH_COMMAND with the env's deploy key
//   - HTTPS github.com URL → GIT_CONFIG_* http.extraheader with the PAT
//     (kept out of argv / process env value that could leak in error text)
// Never throws on a missing credential — returns the base env so the caller can
// still attempt the push (and surface git's own auth error).
function buildRepoGitEnv({
  env,
  repoUrl,
  sshKeyId,
  githubTokenId,
  baseEnv = process.env,
  sshKeysDir,
  ghTokensDir,
  fs = nodeFs,
  path = nodePath,
}) {
  const gitEnv = { ...baseEnv, GIT_TERMINAL_PROMPT: "0" };
  const effectiveSshKeyId = sshKeyId || null;
  const effectiveTokenId = githubTokenId || (env && env.githubTokenId) || null;

  if (isSshUrl(repoUrl) && effectiveSshKeyId && sshKeysDir) {
    const keyPath = path.join(sshKeysDir, effectiveSshKeyId);
    const resolved = path.resolve(keyPath);
    if (resolved.startsWith(path.resolve(sshKeysDir) + path.sep) && fs.existsSync(keyPath)) {
      try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
      gitEnv.GIT_SSH_COMMAND =
        `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
        ` -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
    }
  }

  // Read the PAT once, with the same containment guard the SSH branch uses. The
  // two consumers below want it for different reasons and under different
  // conditions, so resolution is deliberately separated from application.
  let token = null;
  if (effectiveTokenId && ghTokensDir) {
    const tokenPath = path.join(ghTokensDir, effectiveTokenId);
    const resolved = path.resolve(tokenPath);
    if (resolved.startsWith(path.resolve(ghTokensDir) + path.sep) && fs.existsSync(tokenPath)) {
      try {
        token = fs.readFileSync(tokenPath, "utf8").trim() || null;
      } catch { token = null; /* fall through to unauthenticated attempt */ }
    }
  }

  // (1) git-level credential — an http.<url>.extraheader only authenticates git
  // I/O against an https://github.com/ remote, so it stays scheme-gated. On an
  // SSH remote the GIT_SSH_COMMAND above is what carries the identity.
  if (token && isHttpsGithubUrl(repoUrl)) {
    const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
    gitEnv.GIT_CONFIG_COUNT = "1";
    gitEnv.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    gitEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
  }

  // (2) `gh` credential — deliberately NOT scheme-gated. `gh pr create` talks to
  // the REST API, never to the git remote, so it needs the PAT regardless of how
  // the repo is cloned. Gating this on isHttpsGithubUrl broke PR creation on
  // exactly the configuration the docs recommend (SSH URL + deploy key): the
  // push succeeded over SSH, then `gh` failed with an opaque "run gh auth login"
  // — the very error the PR route's token pre-check exists to prevent, which it
  // could not catch because it does not look at the URL scheme.
  if (token) {
    if (!gitEnv.GH_TOKEN) gitEnv.GH_TOKEN = token;
    if (!gitEnv.GITHUB_TOKEN) gitEnv.GITHUB_TOKEN = token;
  }

  return gitEnv;
}

// Report whether a usable GitHub token is resolvable for a `gh`-based action
// (i.e. `gh pr create`). Pure and injectable so the PR route can pre-check the
// credential and fail with a distinct, actionable error instead of letting `gh`
// emit an opaque auth failure that looks identical to a non-fast-forward reject.
//
// Returns { resolvable, tokenId, reason }. `reason` is a stable machine code
// (null when resolvable) so callers can branch without string-matching:
//   no-token-configured  – neither the request nor the env names a token
//   no-token-store        – token id present but no token store path given
//   token-path-invalid    – id would escape the token store dir
//   token-file-missing     – token file does not exist on disk
//   token-file-empty       – token file exists but is blank
//   token-file-unreadable  – token file could not be read
function githubTokenStatus({
  env,
  githubTokenId,
  ghTokensDir,
  fs = nodeFs,
  path = nodePath,
} = {}) {
  const tokenId = githubTokenId || (env && env.githubTokenId) || null;
  if (!tokenId) return { resolvable: false, tokenId: null, reason: "no-token-configured" };
  if (!ghTokensDir) return { resolvable: false, tokenId, reason: "no-token-store" };

  const tokenPath = path.join(ghTokensDir, tokenId);
  const resolved = path.resolve(tokenPath);
  if (!resolved.startsWith(path.resolve(ghTokensDir) + path.sep)) {
    return { resolvable: false, tokenId, reason: "token-path-invalid" };
  }
  if (!fs.existsSync(tokenPath)) {
    return { resolvable: false, tokenId, reason: "token-file-missing" };
  }
  try {
    const token = fs.readFileSync(tokenPath, "utf8").trim();
    if (!token) return { resolvable: false, tokenId, reason: "token-file-empty" };
  } catch {
    return { resolvable: false, tokenId, reason: "token-file-unreadable" };
  }
  return { resolvable: true, tokenId, reason: null };
}

// Strip any Authorization header value that git/gh may echo into an error
// stream before it is returned to the caller or logged.
function sanitizeGitOutput(text) {
  return String(text || "").replace(/Authorization:[^\r\n]*/gi, "Authorization: [redacted]");
}

// Validate a push request body. Returns a normalised { branch, setUpstream,
// remote } or throws a caller-facing Error. `--force` is never honoured — the
// agent workflow forbids force-pushes.
function normalizePushRequest(body = {}) {
  if (body.force || body.forceWithLease) {
    throw new Error("force-push is not allowed");
  }
  const branch = body.branch != null ? String(body.branch) : null;
  if (branch !== null && !isValidBranchName(branch)) {
    throw new Error(`invalid branch name: ${branch}`);
  }
  if (branch !== null && PROTECTED_BRANCHES.has(branch)) {
    throw new Error(
      `refusing to push directly to protected branch '${branch}' — work on a feature branch and open a PR`,
    );
  }
  const remote = body.remote != null ? String(body.remote) : "origin";
  if (!/^[A-Za-z0-9._-]+$/.test(remote)) {
    throw new Error(`invalid remote name: ${remote}`);
  }
  return {
    branch,
    remote,
    setUpstream: body.setUpstream !== false, // default true
  };
}

// Serialize async work per key (one key ≙ one repo checkout): each call chains
// onto the previous call's settled promise for the same key, so two overlapping
// pushes to the same checkout never interleave — the ordering guarantee the old
// blocking execFileSync calls provided implicitly by parking the event loop.
// A rejection propagates to its own caller only and never breaks the chain;
// the map entry is dropped once the last queued call settles.
function makeKeyedQueue() {
  const tails = new Map();
  return function enqueue(key, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.then(fn);
    const tail = next.catch(() => {});
    tails.set(key, tail);
    tail.then(() => {
      if (tails.get(key) === tail) tails.delete(key);
    });
    return next;
  };
}

module.exports = {
  isHttpsGithubUrl,
  isSshUrl,
  isValidBranchName,
  isSafePathSeg,
  PROTECTED_BRANCHES,
  resolveAgentRepo,
  buildRepoGitEnv,
  githubTokenStatus,
  sanitizeGitOutput,
  normalizePushRequest,
  makeKeyedQueue,
};
