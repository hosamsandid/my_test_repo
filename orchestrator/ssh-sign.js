"use strict";

// The impure half of SSH commit signing (#2938): derive a stored key's public
// key and produce an SSH signature with `ssh-keygen -Y sign`, exactly what git
// runs for `gpg.format=ssh`. The private key is read from the orchestrator's key
// store in place — it is never copied into an agent container; the agent's
// signing helper (agent-image/scripts/aee-ssh-sign) sends the payload here.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const execFileP = promisify(execFile);
const MAX_PAYLOAD_BYTES = 1024 * 1024; // a commit object; generous on purpose

// Resolve `keyId` to a file inside `keysDir`, refusing anything that escapes it.
// Returns the path or null.
function keyPathFor(keysDir, keyId) {
  if (!keysDir || !keyId || typeof keyId !== "string") return null;
  const p = path.resolve(keysDir, path.basename(keyId));
  if (!p.startsWith(path.resolve(keysDir) + path.sep)) return null;
  return p;
}

// `ssh-ed25519 AAAA…` (type + base64, comment dropped) for a private key file.
// Throws a plain Error with ssh-keygen's reason when the key cannot be read
// (missing, passphrase-protected, wrong format).
async function publicKeyOf(keyPath, { exec = execFileP } = {}) {
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort — ssh-keygen refuses group/world-readable keys */ }
  let out;
  try {
    out = await exec("ssh-keygen", ["-y", "-P", "", "-f", keyPath], { timeout: 10_000 });
  } catch (err) {
    throw new Error(cleanSshKeygenError(err));
  }
  const parts = String(out.stdout || out).trim().split(/\s+/);
  if (parts.length < 2) throw new Error("ssh-keygen returned no public key");
  return `${parts[0]} ${parts[1]}`;
}

// Sign `payload` (Buffer) for `namespace` with the private key at `keyPath`.
// Returns the armoured signature text. Throws on any failure — the caller turns
// that into a clear message; a commit is never created unsigned by accident.
async function signPayload({ keyPath, payload, namespace = "git", exec = execFileP } = {}) {
  if (!Buffer.isBuffer(payload)) throw new Error("payload must be a Buffer");
  if (payload.length > MAX_PAYLOAD_BYTES) throw new Error("payload too large to sign");
  if (!/^[a-z0-9@._-]+$/i.test(namespace)) throw new Error("invalid signing namespace");
  if (!keyPath || !fs.existsSync(keyPath)) throw new Error("the signing key file is missing from the key store");
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aee-sign-"));
  const file = path.join(dir, "payload");
  try {
    fs.writeFileSync(file, payload, { mode: 0o600 });
    try {
      await exec("ssh-keygen", ["-Y", "sign", "-n", namespace, "-f", keyPath, file], { timeout: 15_000 });
    } catch (err) {
      throw new Error(cleanSshKeygenError(err));
    }
    return fs.readFileSync(`${file}.sig`, "utf8");
  } finally {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

// ssh-keygen's stderr minus paths and noise, one line.
function cleanSshKeygenError(err) {
  const raw = String((err && (err.stderr || err.message)) || "ssh-keygen failed");
  const line = raw.split("\n").map((l) => l.trim()).filter((l) => l && !/^Signing file|^Write signature/.test(l)).join(" ");
  return line.replace(/\/[^\s'"]+/g, "<key>").slice(0, 300) || "ssh-keygen failed";
}

module.exports = { keyPathFor, publicKeyOf, signPayload, cleanSshKeygenError, MAX_PAYLOAD_BYTES };
