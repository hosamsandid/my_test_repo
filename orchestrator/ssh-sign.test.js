"use strict";

// #2938: the orchestrator-side signer, against a real ssh-keygen.
// Run: node --test orchestrator/ssh-sign.test.js
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");
const { keyPathFor, publicKeyOf, signPayload, cleanSshKeygenError } = require("./ssh-sign");

function haveSshKeygen() {
  try { execFileSync("ssh-keygen", ["-?"], { stdio: "ignore" }); return true; } catch (err) { return err.status !== undefined && err.status !== 127 && err.code !== "ENOENT"; }
}

function makeKey(dir, name = "k") {
  const p = path.join(dir, name);
  execFileSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "test", "-f", p]);
  const pub = fs.readFileSync(`${p}.pub`, "utf8").trim().split(/\s+/).slice(0, 2).join(" ");
  fs.rmSync(`${p}.pub`);
  return { path: p, pub };
}

test("keyPathFor stays inside the key store", () => {
  assert.equal(keyPathFor("/keys", "abc"), path.resolve("/keys/abc"));
  assert.equal(keyPathFor("/keys", "../etc/passwd"), path.resolve("/keys/passwd"));
  assert.equal(keyPathFor("/keys", ""), null);
  assert.equal(keyPathFor("", "abc"), null);
});

test("publicKeyOf + signPayload produce a signature ssh-keygen verifies", { skip: !haveSshKeygen() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sign-test-"));
  try {
    const key = makeKey(dir);
    assert.equal(await publicKeyOf(key.path), key.pub);
    const payload = Buffer.from("tree 0000\nauthor a <a@b> 0 +0000\n\nmsg\n");
    const sig = await signPayload({ keyPath: key.path, payload });
    assert.match(sig, /BEGIN SSH SIGNATURE/);
    // Verify like git does: allowed_signers + -Y verify.
    const allowed = path.join(dir, "allowed");
    fs.writeFileSync(allowed, `bot@example.com ${key.pub}\n`);
    const sigFile = path.join(dir, "p.sig");
    fs.writeFileSync(sigFile, sig);
    execFileSync("ssh-keygen", ["-Y", "verify", "-f", allowed, "-I", "bot@example.com", "-n", "git", "-s", sigFile], { input: payload });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("signPayload fails loudly — missing key, unreadable key, bad input", { skip: !haveSshKeygen() }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ssh-sign-test-"));
  try {
    await assert.rejects(signPayload({ keyPath: path.join(dir, "nope"), payload: Buffer.from("x") }), /missing/);
    const bad = path.join(dir, "bad");
    fs.writeFileSync(bad, "-----BEGIN OPENSSH PRIVATE KEY-----\ngarbage\n-----END OPENSSH PRIVATE KEY-----\n", { mode: 0o600 });
    await assert.rejects(signPayload({ keyPath: bad, payload: Buffer.from("x") }));
    await assert.rejects(publicKeyOf(bad));
    await assert.rejects(signPayload({ keyPath: bad, payload: "not a buffer" }), /Buffer/);
    await assert.rejects(signPayload({ keyPath: bad, payload: Buffer.from("x"), namespace: "a b" }), /namespace/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("cleanSshKeygenError drops paths", () => {
  assert.equal(
    cleanSshKeygenError({ stderr: "Load key \"/workspace/environments/_keys/x\": invalid format\n" }),
    "Load key \"<key>\": invalid format",
  );
});
