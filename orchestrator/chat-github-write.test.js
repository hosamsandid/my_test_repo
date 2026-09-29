"use strict";

// #2559 — chat-attributed `gh` writes run under the chat sender's personal
// token on the orchestrator (the secret never enters the container).

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const cgw = require("./chat-github-write");

const b64 = (s) => Buffer.from(s).toString("base64");

// A fake credential world: sender → token id (or refusal), token id → secret.
function world({ senders = {}, tokens = {} } = {}) {
  const calls = [];
  return {
    calls,
    resolveToken(sender) {
      const r = senders[sender];
      if (r === undefined || r === "baseline") return { baseline: true };
      if (r instanceof Error) throw r;
      return { githubTokenId: r };
    },
    readToken: (id) => tokens[id] || null,
    execGh: async (args, { cwd, env }) => {
      const files = {};
      for (const a of args) {
        const p = a.includes("=@") ? a.split("=@")[1] : a;
        if (p.startsWith(cwd) && fs.existsSync(p)) files[a] = fs.readFileSync(p, "utf8");
      }
      calls.push({ args, cwd, env, files });
      return { exitCode: 0, stdout: `https://github.com/o/r/issues/1 ${env.GH_TOKEN}\n`, stderr: "" };
    },
  };
}

function refusal(code, message) {
  const e = new Error(message);
  e.personalCredentialRequired = true;
  e.refusalCode = code;
  return e;
}

test("AC1/AC2: a trusted sender's write runs gh under THEIR personal token", async () => {
  const w = world({ senders: { "@b:local": "tok-b" }, tokens: { "tok-b": "ghp_B" } });
  for (const args of [
    ["issue", "create", "--title", "t", "--body", "x"],
    ["issue", "comment", "5", "--body", "x"],
    ["pr", "comment", "7", "--body", "x"],
    ["pr", "review", "7", "--comment", "--body", "x"],
    ["issue", "edit", "5", "--add-label", "ready-for-review"],
  ]) {
    const r = await cgw.runChatGithubWrite({ body: { args, actingSender: "@b:local", repo: "o/r" }, ...w });
    assert.equal(r.mode, "attributed");
    assert.equal(r.exitCode, 0);
  }
  assert.equal(w.calls.length, 5);
  for (const c of w.calls) {
    assert.equal(c.env.GH_TOKEN, "ghp_B");
    assert.equal(c.env.GITHUB_TOKEN, "ghp_B");
    assert.equal(c.env.GH_REPO, "o/r");
    assert.equal(c.env.GH_PROMPT_DISABLED, "1");
  }
});

test("the secret is redacted from anything relayed back to the container", async () => {
  const w = world({ senders: { "@b:local": "tok-b" }, tokens: { "tok-b": "ghp_B" } });
  const r = await cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@b:local" }, ...w });
  assert.ok(!r.stdout.includes("ghp_B"));
  assert.match(r.stdout, /\*\*\*/);
});

test("AC3/AC4: a refusal propagates — gh never runs, no fallback token is used", async () => {
  for (const code of ["personal-credential-required", "personal-credential-orphaned"]) {
    const w = world({ senders: { "@c:local": refusal(code, "add a personal GitHub token") } });
    await assert.rejects(
      cgw.runChatGithubWrite({ body: { args: ["issue", "comment", "1", "--body", "x"], actingSender: "@c:local" }, ...w }),
      (err) => err.personalCredentialRequired === true && err.refusalCode === code,
    );
    assert.equal(w.calls.length, 0);
  }
});

test("AC5: an untrusted/unresolvable sender is answered 'baseline' and nothing runs here", async () => {
  const w = world({ senders: { "@stranger:local": "baseline" } });
  const r = await cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@stranger:local" }, ...w });
  assert.deepEqual(r, { ok: true, mode: "baseline" });
  const none = await cgw.runChatGithubWrite({ body: { args: ["issue", "create"] }, ...w });
  assert.deepEqual(none, { ok: true, mode: "baseline" });
  assert.equal(w.calls.length, 0);
});

test("AC6: consecutive turns from different members each use their own token (resolved per call)", async () => {
  const tokens = { "tok-a": "ghp_A", "tok-b": "ghp_B" };
  const w = world({ senders: { "@a:local": "tok-a", "@b:local": "tok-b" }, tokens });
  await cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@a:local" }, ...w });
  await cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@b:local" }, ...w });
  // Rotation: the stored secret changes between turns — the next call reads the new one.
  tokens["tok-a"] = "ghp_A2";
  await cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@a:local" }, ...w });
  assert.deepEqual(w.calls.map((c) => c.env.GH_TOKEN), ["ghp_A", "ghp_B", "ghp_A2"]);
});

test("an unreadable resolved credential fails closed with noGithubToken", async () => {
  const w = world({ senders: { "@b:local": "tok-missing" } });
  await assert.rejects(
    cgw.runChatGithubWrite({ body: { args: ["issue", "create"], actingSender: "@b:local" }, ...w }),
    (err) => err.noGithubToken === true,
  );
  assert.equal(w.calls.length, 0);
});

test("body files are materialised into a private temp dir that is removed afterwards", async () => {
  const w = world({ senders: { "@b:local": "tok-b" }, tokens: { "tok-b": "ghp_B" } });
  const body = {
    args: ["api", "repos/o/r/issues", "-F", "body=@x", "--input", "y"],
    files: [
      { index: 3, prefix: "body=@", content: b64("hello <!-- agent: dev -->") },
      { index: 5, content: b64("{\"a\":1}") },
    ],
    actingSender: "@b:local",
  };
  await cgw.runChatGithubWrite({ body, ...w });
  const [c] = w.calls;
  assert.ok(c.args[3].startsWith(`body=@${c.cwd}`));
  assert.ok(c.args[5].startsWith(c.cwd));
  assert.equal(c.files[c.args[3]], "hello <!-- agent: dev -->");
  assert.equal(c.files[c.args[5]], "{\"a\":1}");
  assert.equal(fs.existsSync(c.cwd), false, "temp dir cleaned up");
});

test("the gh env carries no ambient orchestrator secrets and a fresh config dir", () => {
  const env = cgw.buildGhEnv({
    baseEnv: { PATH: "/usr/bin", HTTPS_PROXY: "http://p", GH_ENTERPRISE_TOKEN: "x", INTERNAL_API_TOKEN: "y", GH_TOKEN: "ambient" },
    token: "ghp_B",
    repo: null,
    home: "/tmp/h",
  });
  assert.equal(env.GH_TOKEN, "ghp_B");
  assert.equal(env.HTTPS_PROXY, "http://p");
  assert.equal(env.GH_CONFIG_DIR, path.join("/tmp/h", "gh-config"));
  assert.equal(env.GH_ENTERPRISE_TOKEN, undefined);
  assert.equal(env.INTERNAL_API_TOKEN, undefined);
  assert.equal(env.GH_REPO, undefined);
});

test("parseGhWriteRequest refuses groups that would run or persist something on the orchestrator", () => {
  for (const g of ["extension", "alias", "config", "auth", "codespace", "--version", "ssh-key"]) {
    assert.throws(() => cgw.parseGhWriteRequest({ args: [g, "x"] }), (e) => e.badRequest === true, g);
  }
  for (const g of cgw.ALLOWED_GROUPS) {
    assert.doesNotThrow(() => cgw.parseGhWriteRequest({ args: [g, "create"] }));
  }
});

test("parseGhWriteRequest validates args, repo and file references", () => {
  const bad = [
    {},
    { args: [] },
    { args: ["issue", 5] },
    { args: ["issue", "a\0b"] },
    { args: ["issue", "create"], repo: "not a repo" },
    { args: ["issue", "create"], repo: "o/r;rm" },
    { args: ["issue", "create", "--body-file", "x"], files: [{ index: 0, content: "" }] },
    { args: ["issue", "create", "--body-file", "x"], files: [{ index: 9, content: "" }] },
    { args: ["issue", "create", "--body-file", "x"], files: [{ index: 3, prefix: "../../", content: "" }] },
    { args: ["issue", "create", "--body-file", "x"], files: [{ index: 3 }, { index: 3 }] },
  ];
  for (const body of bad) {
    assert.throws(() => cgw.parseGhWriteRequest(body), (e) => e.badRequest === true, JSON.stringify(body));
  }
  const ok = cgw.parseGhWriteRequest({
    args: ["api", "graphql", "-F", "query=@q"],
    repo: "github.example.com/o/r",
    files: [{ index: 3, prefix: "query=@", content: b64("mutation {}") }],
  });
  assert.equal(ok.repo, "github.example.com/o/r");
  assert.equal(ok.files[0].content.toString(), "mutation {}");
});

test("readGithubToken refuses ids that escape the token directory", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ghtok-"));
  try {
    fs.writeFileSync(path.join(dir, "t1"), "ghp_X\n");
    fs.writeFileSync(path.join(os.tmpdir(), "outside-token-2559"), "leak");
    assert.equal(cgw.readGithubToken(dir, "t1"), "ghp_X");
    assert.equal(cgw.readGithubToken(dir, "../outside-token-2559"), null);
    assert.equal(cgw.readGithubToken(dir, "missing"), null);
    assert.equal(cgw.readGithubToken(dir, null), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(path.join(os.tmpdir(), "outside-token-2559"), { force: true });
  }
});

test("execGh relays a non-zero exit as a result, not an exception", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fakegh-"));
  try {
    const bin = path.join(dir, "gh");
    fs.writeFileSync(bin, "#!/bin/sh\necho \"out $1\"\necho 'HTTP 403: Resource not accessible by personal access token' >&2\nexit 4\n", { mode: 0o755 });
    const r = await cgw.execGh(["issue"], { cwd: dir, env: { PATH: `${dir}:/usr/bin:/bin` } });
    assert.equal(r.exitCode, 4);
    assert.equal(r.stdout, "out issue\n");
    assert.match(r.stderr, /Resource not accessible/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
