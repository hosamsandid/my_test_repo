"use strict";

// Chat-attributed GitHub writes (#2559, epic #2166 follow-up to B3/B4/B5).
//
// `gh-as-agent push` / `pr` already run a live chat turn's write under the
// chat sender's personal credential (orchestrator-side
// `resolveAttributedGithubToken`). Every OTHER GitHub write an agent makes —
// `gh issue create/comment/edit/close`, `gh pr comment/review`, label changes,
// `gh api` writes — used to authenticate with the container's spawn-time
// baked `GH_TOKEN` (the baseline: Team Admin's personal token → env token →
// global service token), so a chat turn from member B was posted under the
// Team Admin's identity.
//
// The fix keeps the personal secret OUT of the container: the agent image
// ships a `gh` shim (`agent-image/scripts/aee-gh`) that, during a live chat
// turn (`AEE_ACTING_SENDER` set), forwards a WRITE invocation's argv (and the
// body files it references) here, and this module runs the real `gh` on the
// orchestrator with the resolved credential. Handing the token itself to the
// container would make any team member able to read any other member's token
// — `AEE_ACTING_SENDER` is a container-side claim the agent can rewrite, and
// the ticket forbids a personal secret being readable by other members.
//
// The decision is the same one push/PR use, resolved per call (a rotated token
// is picked up on the next call, and two turns from different members never
// share a credential):
//   untrusted / unresolvable sender → { mode: "baseline" } — the shim runs the
//                                     real `gh` locally, exactly as before
//   trusted, usable personal token  → run here under that token
//   trusted, none / orphaned        → the refusal from `resolveCredential`
//                                     (424 in the route), nothing is written
//
// Pure except for the default `execGh` / `readToken` implementations; the
// orchestrator injects `resolveToken` (it needs the live team store).

const nodeFs = require("node:fs");
const nodePath = require("node:path");
const nodeOs = require("node:os");
const { spawn } = require("node:child_process");

// The `gh` command groups this route will run. Everything else is refused —
// the argv comes from the agent, and groups like `extension`, `alias`,
// `config` or `auth` would execute or persist something on the ORCHESTRATOR
// rather than call the GitHub API. Kept in step with FORWARD_GROUPS in
// agent-image/scripts/aee-gh (the shim only forwards these).
const ALLOWED_GROUPS = new Set([
  "issue", "pr", "label", "api", "release", "repo", "workflow", "run",
  "project", "gist", "variable", "secret", "cache", "ruleset",
]);

const MAX_ARGS = 200;
const MAX_ARG_CHARS = 64 * 1024;
const MAX_FILES = 16;
const MAX_FILE_BYTES_TOTAL = 4 * 1024 * 1024;
const MAX_OUTPUT_CHARS = 1024 * 1024;
const GH_TIMEOUT_MS = 60_000;

// `[HOST/]OWNER/REPO` — the format `GH_REPO` accepts.
const REPO_RE = /^(?:[A-Za-z0-9.-]+\/)?[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
// A file reference is either the whole argument (`--body-file <path>`) or a
// `gh api -F key=@<path>` field, whose `key=@` part is kept as the prefix.
const PREFIX_RE = /^(?:[^=\s]{1,200}=@)?$/;

// Environment variables the orchestrator process passes on to `gh`: only what
// it needs to reach GitHub (proxy, CA bundle). Everything else — including the
// orchestrator's own secrets and any ambient GH_TOKEN — stays out.
const PASSTHROUGH_ENV = [
  "PATH", "LANG", "LC_ALL", "TZ",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "SSL_CERT_FILE", "SSL_CERT_DIR",
];

function badRequest(message) {
  const e = new Error(message);
  e.badRequest = true;
  return e;
}

// Validate the shim's request body. Returns `{ args, files, repo, stdin }`
// (files carry decoded Buffers) or throws a `badRequest` Error.
function parseGhWriteRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const args = b.args;
  if (!Array.isArray(args) || args.length === 0 || args.length > MAX_ARGS) {
    throw badRequest("args must be a non-empty array of gh arguments");
  }
  for (const a of args) {
    if (typeof a !== "string" || a.length > MAX_ARG_CHARS || a.includes("\0")) {
      throw badRequest("every gh argument must be a string");
    }
  }
  if (!ALLOWED_GROUPS.has(args[0])) {
    throw badRequest(`gh '${args[0]}' is not a GitHub write this route runs`);
  }

  let repo = null;
  if (b.repo != null && b.repo !== "") {
    if (typeof b.repo !== "string" || !REPO_RE.test(b.repo)) {
      throw badRequest("repo must be [HOST/]OWNER/REPO");
    }
    repo = b.repo;
  }

  const rawFiles = b.files == null ? [] : b.files;
  if (!Array.isArray(rawFiles) || rawFiles.length > MAX_FILES) {
    throw badRequest(`files must be an array of at most ${MAX_FILES} entries`);
  }
  let total = 0;
  const seen = new Set();
  const files = rawFiles.map((f) => {
    if (!f || typeof f !== "object") throw badRequest("invalid file entry");
    const { index, prefix = "", content = "" } = f;
    // index 0 is the command group — never a file.
    if (!Number.isInteger(index) || index < 1 || index >= args.length || seen.has(index)) {
      throw badRequest("file index must point at a distinct gh argument");
    }
    if (typeof prefix !== "string" || !PREFIX_RE.test(prefix)) {
      throw badRequest("invalid file prefix");
    }
    if (typeof content !== "string") throw badRequest("file content must be base64");
    const buf = Buffer.from(content, "base64");
    total += buf.length;
    if (total > MAX_FILE_BYTES_TOTAL) throw badRequest("attached files are too large");
    seen.add(index);
    return { index, prefix, content: buf };
  });

  return { args: args.slice(), files, repo };
}

// Write each attached file into `dir` and point its argument at the copy.
function materializeArgs(args, files, dir, { fs = nodeFs, path = nodePath } = {}) {
  const out = args.slice();
  for (const f of files) {
    const p = path.join(dir, `file-${f.index}`);
    fs.writeFileSync(p, f.content, { mode: 0o600 });
    out[f.index] = `${f.prefix}${p}`;
  }
  return out;
}

function buildGhEnv({ baseEnv = process.env, token, repo, home }) {
  const env = {};
  for (const k of PASSTHROUGH_ENV) {
    if (baseEnv[k] != null) env[k] = baseEnv[k];
  }
  Object.assign(env, {
    HOME: home,
    // A fresh config dir per call: no aliases, extensions or stored hosts.yml
    // credentials from anywhere else can take part.
    GH_CONFIG_DIR: nodePath.join(home, "gh-config"),
    GH_TOKEN: token,
    GITHUB_TOKEN: token,
    GH_PROMPT_DISABLED: "1",
    GH_NO_UPDATE_NOTIFIER: "1",
    NO_COLOR: "1",
  });
  if (repo) env.GH_REPO = repo;
  return env;
}

// Read a stored GitHub token by id, with the same containment guard
// `buildRepoGitEnv` uses. Returns null when absent/unreadable.
function readGithubToken(ghTokensDir, tokenId, { fs = nodeFs, path = nodePath } = {}) {
  if (!ghTokensDir || !tokenId) return null;
  const p = path.join(ghTokensDir, String(tokenId));
  if (!path.resolve(p).startsWith(path.resolve(ghTokensDir) + path.sep)) return null;
  try {
    return fs.readFileSync(p, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function clip(s) {
  const str = String(s || "");
  return str.length > MAX_OUTPUT_CHARS ? `${str.slice(0, MAX_OUTPUT_CHARS)}\n[output truncated]\n` : str;
}

// Run `gh` and resolve with its exit code and output — a non-zero exit is a
// normal result the shim relays to the agent, not an exception.
function execGh(args, { cwd, env, timeout = GH_TIMEOUT_MS }) {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const done = (r) => { if (!settled) { settled = true; resolve(r); } };
    let child;
    try {
      child = spawn("gh", args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (err) {
      done({ exitCode: 1, stdout: "", stderr: `could not run gh: ${err.message}\n` });
      return;
    }
    const timer = setTimeout(() => {
      stderr += `\ngh timed out after ${Math.round(timeout / 1000)}s\n`;
      child.kill("SIGKILL");
    }, timeout);
    child.stdout.on("data", (d) => { if (stdout.length <= MAX_OUTPUT_CHARS) stdout += d; });
    child.stderr.on("data", (d) => { if (stderr.length <= MAX_OUTPUT_CHARS) stderr += d; });
    child.on("error", (err) => {
      clearTimeout(timer);
      done({ exitCode: 1, stdout, stderr: `${stderr}could not run gh: ${err.message}\n` });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exitCode: code == null ? 1 : code, stdout, stderr });
    });
  });
}

// The whole request. `resolveToken(actingSender)` returns `{ baseline: true }`
// for an untrusted/unresolvable sender, `{ githubTokenId }` otherwise, or
// throws the `personalCredentialRequired` refusal.
async function runChatGithubWrite({
  body,
  resolveToken,
  readToken,
  execGh: exec = execGh,
  fs = nodeFs,
  path = nodePath,
  os = nodeOs,
  baseEnv = process.env,
}) {
  const req = parseGhWriteRequest(body);
  const actingSender = typeof body.actingSender === "string" ? body.actingSender.trim() : "";
  // No sender at all is an autonomous run — the shim never forwards those,
  // but answer the same way the untrusted case does rather than guess.
  if (!actingSender) return { ok: true, mode: "baseline" };

  const resolved = resolveToken(actingSender);
  if (!resolved || resolved.baseline) return { ok: true, mode: "baseline" };

  const token = readToken(resolved.githubTokenId);
  if (!token) {
    const e = new Error(
      `the GitHub credential resolved for this chat turn ('${resolved.githubTokenId || "none"}') ` +
      "could not be read — nothing was written. Ask an admin to check the stored credential.",
    );
    e.noGithubToken = true;
    throw e;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aee-gh-"));
  try {
    const args = materializeArgs(req.args, req.files, dir, { fs, path });
    const env = buildGhEnv({ baseEnv, token, repo: req.repo, home: dir });
    const r = await exec(args, { cwd: dir, env });
    // Defence in depth: the secret never goes back to the container, even if
    // some gh output were to echo it.
    const redact = (s) => clip(s).split(token).join("***");
    return {
      ok: true,
      mode: "attributed",
      exitCode: r.exitCode,
      stdout: redact(r.stdout),
      stderr: redact(r.stderr),
    };
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

module.exports = {
  ALLOWED_GROUPS,
  parseGhWriteRequest,
  materializeArgs,
  buildGhEnv,
  readGithubToken,
  execGh,
  runChatGithubWrite,
};
