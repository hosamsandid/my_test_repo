'use strict';

// ─── gke-broker GCP auth + token lifecycle ───────────────────────────────────
//
// The broker is the ONLY place the GCP credential lives (concept §3). A
// team-admin signs in through the plugin's own UI; the resulting credential is
// stored on the broker's state volume (AEE_PLUGIN_STATE_DIR) and the broker
// mints the ~1h Connect-Gateway bearer for kubectl itself. The agent never sees
// any of it.
//
// Two sign-in paths (the pilot ships both; the device flow is the durable,
// self-refreshing one, the paste-token path is the always-works fallback):
//
//   1. gcloud DEVICE FLOW — `gcloud auth login --no-launch-browser` under the
//      broker's CLOUDSDK_CONFIG. It prints a Google URL; the admin approves it
//      in a browser, pastes the verification code back into the UI; gcloud
//      stores a refresh token on the state volume, so the broker refreshes
//      access tokens forever with no further interaction.
//   2. PASTE ACCESS TOKEN — the admin runs `gcloud auth print-access-token` on
//      their own machine and pastes the ~1h bearer. No refresh; re-paste on
//      expiry. Lets the read path be proven end-to-end without fighting
//      gcloud's interactive flow in a container.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STATE_DIR = process.env.AEE_PLUGIN_STATE_DIR || '/state';
const GCLOUD_CONFIG = path.join(STATE_DIR, 'gcloud');
const PASTED_TOKEN_FILE = path.join(STATE_DIR, 'pasted-token.json');

// Access tokens live ~1h; refresh a little early and assume a conservative
// validity for a pasted one.
const TOKEN_TTL_MS = 45 * 60 * 1000;
const PASTED_TTL_MS = 55 * 60 * 1000;

let tokenCache = { value: null, expiresAt: 0 };
const logins = new Map(); // loginId -> session

function gcloudEnv() {
  return {
    ...process.env,
    CLOUDSDK_CONFIG: GCLOUD_CONFIG,
    CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
  };
}

function ensureDirs() {
  try { fs.mkdirSync(GCLOUD_CONFIG, { recursive: true }); } catch { /* best effort */ }
}

function activeAccount() {
  try {
    const r = spawnSync(
      'gcloud',
      ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
      { encoding: 'utf8', env: gcloudEnv(), timeout: 15000 },
    );
    if (r.status === 0) return (r.stdout || '').trim() || null;
  } catch { /* gcloud absent (unit host) */ }
  return null;
}

function readPastedToken() {
  try {
    const j = JSON.parse(fs.readFileSync(PASTED_TOKEN_FILE, 'utf8'));
    if (j && j.token && Number(j.expiresAt) > Date.now() + 30000) return j;
  } catch { /* none / expired / unreadable */ }
  return null;
}

// The live bearer for kubectl, or null if not signed in. Prefers a real gcloud
// credential (self-refreshing) over a pasted token.
function accessToken() {
  const now = Date.now();
  if (tokenCache.value && tokenCache.expiresAt > now + 60000) return tokenCache.value;

  if (activeAccount()) {
    try {
      const r = spawnSync('gcloud', ['auth', 'print-access-token'],
        { encoding: 'utf8', env: gcloudEnv(), timeout: 20000 });
      if (r.status === 0) {
        const t = (r.stdout || '').trim();
        if (t) { tokenCache = { value: t, expiresAt: now + TOKEN_TTL_MS }; return t; }
      }
    } catch { /* fall through to pasted */ }
  }

  const p = readPastedToken();
  if (p) { tokenCache = { value: p.token, expiresAt: Number(p.expiresAt) }; return p.token; }
  return null;
}

function status() {
  const acct = activeAccount();
  const pasted = readPastedToken();
  return {
    signedIn: !!acct || !!pasted,
    account: acct || (pasted ? (pasted.account || 'pasted-token') : null),
    method: acct ? 'gcloud' : (pasted ? 'pasted-token' : null),
    pastedExpiresAt: pasted ? Number(pasted.expiresAt) : null,
    server: process.env.GKE_CONNECT_SERVER || null,
  };
}

// Start the gcloud device flow. Returns { id, url? }; the URL may arrive a
// beat later, so the caller polls loginUrl(id) briefly.
function beginLogin() {
  ensureDirs();
  const id = crypto.randomBytes(6).toString('hex');
  let child;
  try {
    child = spawn('gcloud', ['auth', 'login', '--no-launch-browser', '--quiet'],
      { env: gcloudEnv() });
  } catch (e) {
    return { id, error: `gcloud not available: ${e.message}` };
  }
  const session = { id, child, url: null, buf: '', done: false, exitCode: null, error: null };
  logins.set(id, session);
  const onData = (d) => {
    session.buf += d.toString();
    const m = session.buf.match(/https:\/\/accounts\.google\.com\/\S+|https:\/\/\S+oauth\S+/);
    if (m && !session.url) session.url = m[0].replace(/[)>."']+$/, '');
  };
  if (child.stdout) child.stdout.on('data', onData);
  if (child.stderr) child.stderr.on('data', onData);
  child.on('exit', (code) => { session.done = true; session.exitCode = code; });
  child.on('error', (e) => { session.error = e.message; session.done = true; });
  return { id };
}

function loginUrl(id) {
  const s = logins.get(id);
  if (!s) return { error: 'unknown login session' };
  return { url: s.url, done: s.done, error: s.error };
}

// Feed the verification code back to the waiting gcloud process.
function submitCode(id, code) {
  const s = logins.get(id);
  if (!s) return { ok: false, error: 'unknown login session' };
  try {
    s.child.stdin.write(String(code).trim() + '\n');
    s.child.stdin.end();
  } catch (e) {
    return { ok: false, error: e.message };
  }
  return { ok: true };
}

// Poll the outcome of a submitted code.
function loginResult(id) {
  const s = logins.get(id);
  if (!s) return { error: 'unknown login session' };
  if (!s.done) return { pending: true };
  const acct = activeAccount();
  logins.delete(id);
  tokenCache = { value: null, expiresAt: 0 };
  return { done: true, ok: s.exitCode === 0 && !!acct, account: acct, detail: s.buf.slice(-400) };
}

// Store a pasted ~1h access token as the fallback credential.
function pasteToken(token, account) {
  ensureDirs();
  const clean = String(token || '').trim();
  if (!clean) return { ok: false, error: 'empty token' };
  const rec = { token: clean, account: account || 'pasted-token', expiresAt: Date.now() + PASTED_TTL_MS };
  try {
    fs.writeFileSync(PASTED_TOKEN_FILE, JSON.stringify(rec), { mode: 0o600 });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  tokenCache = { value: clean, expiresAt: rec.expiresAt };
  return { ok: true, expiresAt: rec.expiresAt };
}

function logout() {
  try { fs.rmSync(PASTED_TOKEN_FILE, { force: true }); } catch { /* ignore */ }
  try { spawnSync('gcloud', ['auth', 'revoke', '--all', '--quiet'], { env: gcloudEnv(), timeout: 15000 }); } catch { /* ignore */ }
  tokenCache = { value: null, expiresAt: 0 };
  return { ok: true };
}

module.exports = {
  STATE_DIR, GCLOUD_CONFIG,
  accessToken, status,
  beginLogin, loginUrl, submitCode, loginResult,
  pasteToken, logout,
};
