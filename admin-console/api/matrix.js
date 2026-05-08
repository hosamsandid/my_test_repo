'use strict';

/**
 * Matrix proxy helpers — used by the /api/matrix/* routes in api.js.
 *
 * The admin-console runs on Node 22 (see admin-console/Dockerfile), so we use
 * the global `fetch` API directly. All HTTP calls go to the Conduwuit
 * homeserver (default `http://conduwuit:6167` from inside the compose
 * network).
 */

const fs = require('fs');
const path = require('path');

const HOMESERVER = process.env.MATRIX_HOMESERVER || 'http://conduwuit:6167';
const ADMIN_TOKEN = process.env.MATRIX_ACCESS_TOKEN || '';
const ADMIN_USER_ID_FALLBACK = process.env.ADMIN_USER_ID || '@admin:local';

// Cached admin user id, resolved lazily via /account/whoami so we always
// invite the user who actually owns ADMIN_TOKEN — even if .env's
// ADMIN_USER drifts from the token. Falls back to the env var if whoami
// is unreachable.
let _adminUserIdCache = null;

const AGENTS_DIR = '/workspace/agents';
const SYNC_TOKEN_FILE = '/workspace/admin-console/sync.json';

// Defense-in-depth path-injection guard for any agentId that lands in
// `path.join(AGENTS_DIR, agentId, ...)` below. Mirrors api.js's `AGENT_ID_RE`.
// Inline test sites are recognised by CodeQL as path-injection sanitizers
// (js/path-injection); helper-indirected checks from caller routes are not,
// so we re-validate inline at every path.join site.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;

/**
 * Issue a request against the Matrix Client-Server API.
 *
 * @param {string} token - Matrix access token (Bearer auth).
 * @param {string} apiPath - Path beginning with '/' (e.g. '/_matrix/client/v3/sync').
 * @param {object} [opts]
 * @param {string} [opts.method='GET']
 * @param {object} [opts.body] - Will be JSON-stringified if present.
 * @param {object} [opts.query] - Query parameters appended to the URL.
 * @param {AbortSignal} [opts.signal] - Optional abort signal for long polls.
 * @returns {Promise<{ status: number, data: any }>}
 *
 * Throws on network errors so callers can map them to a 502 response.
 */
async function matrixFetch(token, apiPath, opts = {}) {
  const { method = 'GET', body, query, signal } = opts;
  let url = `${HOMESERVER}${apiPath}`;
  if (query && Object.keys(query).length > 0) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v === undefined || v === null) continue;
      qs.append(k, String(v));
    }
    const qstr = qs.toString();
    if (qstr) url += (url.includes('?') ? '&' : '?') + qstr;
  }

  const headers = { 'Authorization': `Bearer ${token}` };
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const resp = await fetch(url, { method, headers, body: payload, signal });
  const text = await resp.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); }
    catch { data = text; }
  }
  return { status: resp.status, data };
}

/**
 * Resolve the admin user id by calling /account/whoami with ADMIN_TOKEN.
 * Cached after first success. Falls back to ADMIN_USER_ID_FALLBACK.
 *
 * Conduwuit currently serves whoami at the legacy r0 path; v3 returns 405.
 */
async function resolveAdminUserId() {
  if (_adminUserIdCache) return _adminUserIdCache;
  if (!ADMIN_TOKEN) return ADMIN_USER_ID_FALLBACK;
  for (const apiPath of [
    '/_matrix/client/v3/account/whoami',
    '/_matrix/client/r0/account/whoami',
  ]) {
    try {
      const r = await matrixFetch(ADMIN_TOKEN, apiPath);
      if (r.status === 200 && r.data?.user_id) {
        _adminUserIdCache = r.data.user_id;
        console.log(`[Matrix] Admin user resolved as ${_adminUserIdCache}`);
        return _adminUserIdCache;
      }
    } catch { /* try next */ }
  }
  console.warn(`[Matrix] whoami failed; falling back to ${ADMIN_USER_ID_FALLBACK}`);
  return ADMIN_USER_ID_FALLBACK;
}

/**
 * Read an agent's Matrix access token from its config.json.
 * Throws if the agent has no config or no token field.
 */
function getAgentToken(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agent id: ${String(agentId).slice(0, 80)}`);
  }
  const cfgPath = path.join(AGENTS_DIR, agentId, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  if (!cfg.token) throw new Error(`agent ${agentId} has no Matrix token`);
  return cfg.token;
}

/**
 * Read the persisted DM-room mapping for an agent, or null if none exists.
 * @returns {{ roomId: string, createdAt: string, createdBy: string } | null}
 */
function getAgentDmRoom(agentId) {
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
  const p = path.join(AGENTS_DIR, agentId, 'dm-room.json');
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Atomically persist the DM-room mapping for an agent.
 */
function setAgentDmRoom(agentId, data) {
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    throw new Error(`Invalid agent id: ${String(agentId).slice(0, 80)}`);
  }
  const p = path.join(AGENTS_DIR, agentId, 'dm-room.json');
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, p);
}

/**
 * Load the persisted /sync `next_batch` token if any.
 * Returns null if the file is missing or unparseable.
 */
function loadSyncToken() {
  try {
    return JSON.parse(fs.readFileSync(SYNC_TOKEN_FILE, 'utf8')).since || null;
  } catch {
    return null;
  }
}

/**
 * Persist the /sync `next_batch` token atomically.
 */
function saveSyncToken(since) {
  fs.mkdirSync(path.dirname(SYNC_TOKEN_FILE), { recursive: true });
  const tmp = SYNC_TOKEN_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ since }, null, 2));
  fs.renameSync(tmp, SYNC_TOKEN_FILE);
}

module.exports = {
  matrixFetch,
  getAgentToken,
  getAgentDmRoom,
  setAgentDmRoom,
  loadSyncToken,
  saveSyncToken,
  resolveAdminUserId,
  ADMIN_TOKEN,
  HOMESERVER,
  AGENTS_DIR,
};
