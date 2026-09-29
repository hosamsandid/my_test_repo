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

// The `gh` commands this route runs, with every option each one may carry.
// The argv comes from the agent and runs on the ORCHESTRATOR, so it is treated
// as data, never as paths: anything not listed here is refused — whole groups
// that do local I/O or take positional file arguments (`gist`, `release`,
// `repo`, `run download`, `secret`, `extension`, `config`, …), options that
// read a file (`--body-file`, `--attach`, `gh api --input`/`-F k=@…`) unless
// that argument is one of the request's declared `files`, and options that
// open an editor/browser or send the token elsewhere (`--editor`, `--web`,
// `gh api --hostname`). Kept in step with FORWARD_COMMANDS in
// agent-image/scripts/aee-gh (the shim only forwards these).
//
// Spec syntax: `-s/--long` boolean · `…=` takes a value · `…=@` takes a
// local file (must be declared) · `…=f` is `gh api`'s `-F` field (a file only
// when its value is `@…`).
const REPO_FLAG = ["-R/--repo="];
const BODY = ["-b/--body=", "-F/--body-file=@", "--attach=@"];
const COMMENT_FLAGS = [...BODY, "--create-if-none", "--delete-last", "--edit-last", "--yes"];
const COMMAND_SPECS = {
  "issue create": [...BODY, "-a/--assignee=", "--blocked-by=", "--blocking=", "-l/--label=",
    "-m/--milestone=", "--parent=", "-p/--project=", "--recover=@", "-T/--template=", "-t/--title=", "--type="],
  "issue edit": [...BODY, "--add-assignee=", "--add-blocked-by=", "--add-blocking=", "--add-label=",
    "--add-project=", "--add-sub-issue=", "-m/--milestone=", "--parent=", "--remove-assignee=",
    "--remove-blocked-by=", "--remove-blocking=", "--remove-label=", "--remove-project=",
    "--remove-sub-issue=", "-t/--title=", "--type=", "--remove-milestone", "--remove-parent", "--remove-type"],
  "issue comment": COMMENT_FLAGS,
  "issue close": ["-c/--comment=", "--duplicate-of=", "-r/--reason="],
  "issue reopen": ["-c/--comment="],
  "issue delete": ["--yes"],
  "issue lock": ["-r/--reason="],
  "issue unlock": [],
  "issue transfer": [],
  "issue pin": [],
  "issue unpin": [],
  "pr create": [...BODY, "-a/--assignee=", "-B/--base=", "-d/--draft", "--dry-run", "-f/--fill",
    "--fill-first", "--fill-verbose", "-H/--head=", "-l/--label=", "-m/--milestone=",
    "--no-maintainer-edit", "-p/--project=", "--recover=@", "-r/--reviewer=", "-t/--title="],
  "pr comment": COMMENT_FLAGS,
  "pr review": ["-b/--body=", "-F/--body-file=@", "-a/--approve", "-c/--comment", "-r/--request-changes"],
  "pr edit": [...BODY, "--add-assignee=", "--add-label=", "--add-project=", "--add-reviewer=",
    "-B/--base=", "-m/--milestone=", "--remove-assignee=", "--remove-label=", "--remove-project=",
    "--remove-reviewer=", "-t/--title=", "--remove-milestone"],
  "pr close": ["-c/--comment=", "-d/--delete-branch"],
  "pr reopen": ["-c/--comment="],
  "pr merge": ["-b/--body=", "-F/--body-file=@", "--admin", "-A/--author-email=", "--auto",
    "-d/--delete-branch", "--disable-auto", "--match-head-commit=", "-m/--merge", "-r/--rebase",
    "-s/--squash", "-t/--subject="],
  "pr ready": ["--undo"],
  "pr update-branch": ["--rebase"],
  "pr revert": ["-b/--body=", "-F/--body-file=@", "-d/--draft", "-t/--title="],
  "pr lock": ["-r/--reason="],
  "pr unlock": [],
  "label create": ["-c/--color=", "-d/--description=", "-f/--force"],
  "label edit": ["-c/--color=", "-d/--description=", "-n/--name="],
  "label delete": ["--yes"],
  "label clone": ["-f/--force"],
  api: ["--allow-escape-sequences", "--cache=", "-F/--field=f", "-H/--header=", "-i/--include",
    "--input=@", "-q/--jq=", "-X/--method=", "--paginate", "-p/--preview=", "-f/--raw-field=",
    "--silent", "--slurp", "-t/--template="],
};

// "-s/--long=@" → Map { "-s" → "file", "--long" → "file" }
function compileSpec(entries) {
  const kinds = { "": "bool", "=": "value", "=@": "file", "=f": "field" };
  const m = new Map();
  for (const e of [...entries, ...REPO_FLAG]) {
    const [, names, suffix] = e.match(/^([^=]+)(=[@f]?)?$/);
    for (const n of names.split("/")) m.set(n, kinds[suffix || ""]);
  }
  return m;
}

const COMMANDS = new Map(Object.entries(COMMAND_SPECS).map(([k, v]) => [k, compileSpec(v)]));

// `issue comment` → "issue comment"; every `gh api …` → "api".
function commandKey(args) {
  return args[0] === "api" ? "api" : `${args[0]} ${args[1] || ""}`;
}

// Walk argv against the command's spec. Returns Map<argIndex, prefix> of the
// arguments that name a local file (each must be a declared file), or throws.
function checkArgs(args) {
  const key = commandKey(args);
  const spec = COMMANDS.get(key);
  if (!spec) throw badRequest(`gh ${key.slice(0, 80)} is not a GitHub write this route runs`);
  const fileSlots = new Map();
  for (let i = key === "api" ? 1 : 2; i < args.length; i++) {
    const a = args[i];
    if (a === "--") throw badRequest(`gh ${key}: '--' is not accepted`);
    if (!(a.startsWith("-") && a.length > 1)) {
      // Positionals are issue/PR numbers, URLs, branch or label names — data
      // to gh. `gh api`'s endpoint must be a path on the token's own host.
      if (key === "api" && a.includes("://")) throw badRequest("gh api: the endpoint must be a path, not a URL");
      continue;
    }
    let flag = a;
    let attached = null;
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq > 0) { flag = a.slice(0, eq); attached = a.slice(eq + 1); }
    } else if (a.length !== 2) {
      throw badRequest(`gh ${key}: pass '${a.slice(0, 2)}' and its value as separate arguments`);
    }
    const kind = spec.get(flag);
    if (!kind) throw badRequest(`gh ${key}: option '${flag.slice(0, 40)}' is not accepted on this route`);
    if (attached !== null) {
      if (kind !== "value") throw badRequest(`gh ${key}: pass '${flag}' and its value as separate arguments`);
      continue;
    }
    if (kind === "bool") continue;
    if (++i >= args.length) throw badRequest(`gh ${key}: '${flag}' needs a value`);
    const v = args[i];
    if (kind === "file") fileSlots.set(i, "");
    if (kind === "field") {
      const eq = v.indexOf("=");
      if (eq >= 0 && v[eq + 1] === "@") fileSlots.set(i, `${v.slice(0, eq)}=@`);
    }
  }
  return fileSlots;
}

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
  const fileSlots = checkArgs(args);

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
    if (!fileSlots.has(index) || fileSlots.get(index) !== prefix) {
      throw badRequest("file index must point at an argument that names a file");
    }
    seen.add(index);
    return { index, prefix, content: buf };
  });
  // Every file-naming argument must be one of the files sent along — an
  // undeclared one would make gh read that path on the orchestrator.
  for (const index of fileSlots.keys()) {
    if (!seen.has(index)) {
      throw badRequest(`gh ${commandKey(args)}: argument ${index} names a local file that was not sent along`);
    }
  }

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
  COMMANDS,
  commandKey,
  parseGhWriteRequest,
  materializeArgs,
  buildGhEnv,
  readGithubToken,
  execGh,
  runChatGithubWrite,
};
