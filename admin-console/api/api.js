'use strict';

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const matrix = require('./matrix');
const auth = require('./auth');
const audit = require('./audit');
const githubEventLog = require('./github-event-log');
const { computeScope, visibleTeam, visibleAgent } = require('./scope');
const { deriveEmitsForTrigger } = require('./emits-derivation');
const { buildProcessGraph } = require('./process-graph');
const { buildProcessTemplate, validateProcessTemplate, templateToCustomRoles, expandGithubChannels, expandDataFlowSteps, normalizeLegacyReview, isChannelTrigger, stampDerivedActivation, emptyDraftBundle } = require('./process-template');
const { listProcessTemplates, loadProcessTemplate } = require('./process-template-registry');
const { normalizeTemplatePorts } = require('./catalog-ports');
const { weaveProcess } = require('./flow-weaver');
const { heuristicPortSuggestion, buildPortSuggestionRequest, parsePortSuggestion } = require('./port-suggestion');
const { buildUnifiedGraph, briefingsToUnified, processTemplateToUnified, unifiedToProcessTemplate } = require('./unified-graph');

const WORKSPACE = '/workspace';
const POOL_DIR = '/pool';
const AGENT_TEMPLATES_DIR = path.join(POOL_DIR, 'agent-templates');
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
// Control-plane volume (#185): agents push status + session-log to the
// orchestrator, which persists them here. Mounted read-write by both services.
const CONTROL_DIR = '/control/agents';
// Resolve a per-agent state file, preferring the pushed control-plane copy and
// falling back to the agent's own workspace when it hasn't pushed yet (or push
// is off). Keeps the read-repoint non-breaking on the shared volume and lets it
// transparently survive per-agent volume isolation.
function controlOrAgentPath(...segs) {
  const ctrl = path.join(CONTROL_DIR, ...segs);
  if (fs.existsSync(ctrl)) return ctrl;
  return path.join(AGENTS_DIR, ...segs);
}
const ENVIRONMENTS_DIR = path.join(WORKSPACE, 'environments');
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, '_keys');
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, 'index.json');
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');
const GH_TOKENS_INDEX = path.join(GH_TOKENS_DIR, 'index.json');
const LLM_ENDPOINTS_DIR = path.join(WORKSPACE, 'llm-endpoints');
const LLM_ENDPOINTS_INDEX = path.join(LLM_ENDPOINTS_DIR, 'index.json');
const LLM_KEYS_DIR = path.join(LLM_ENDPOINTS_DIR, '_keys');
const MCP_SERVERS_DIR = path.join(WORKSPACE, 'mcp-servers');
const MCP_CREDENTIALS_DIR = path.join(WORKSPACE, 'mcp-credentials');
const MCP_CREDENTIALS_KEYS_DIR = path.join(MCP_CREDENTIALS_DIR, '_keys');
const MCP_CREDENTIALS_INDEX = path.join(MCP_CREDENTIALS_KEYS_DIR, 'index.json');
// Teams data model (#299): resources are owned by exactly one human Team.
const TEAMS_INDEX = path.join(WORKSPACE, 'teams', 'index.json');
const USERS_INDEX = path.join(WORKSPACE, 'users', 'index.json');
const MEMBERSHIPS_INDEX = path.join(WORKSPACE, 'memberships', 'index.json');
const DEFAULT_TEAM_ID = 'default';
// The env single-admin login (#276); its session subject is this value and it
// is treated as the operator (full visibility) by the scope filter (#302).
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || 'admin';
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const BP_EXPLORER_URL = process.env.BP_EXPLORER_URL || 'http://bp-explorer:8765';

fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
fs.mkdirSync(GH_TOKENS_DIR, { recursive: true });
fs.mkdirSync(LLM_ENDPOINTS_DIR, { recursive: true });
fs.mkdirSync(LLM_KEYS_DIR, { recursive: true });
fs.mkdirSync(MCP_SERVERS_DIR, { recursive: true });
fs.mkdirSync(MCP_CREDENTIALS_KEYS_DIR, { recursive: true });

const app = express();
app.use(cors());
// Document-bundle endpoints (process drafts, the unified flow graph, imported
// BriefingPack flows) carry the full brief.md / prompt bodies inline, which
// easily exceeds body-parser's 100kb default. Raise the limit so importing /
// rendering / saving a multi-BP flow doesn't 413 (#377). Behind the auth gate.
app.use(express.json({ limit: '10mb' }));
app.use(express.static(STATIC_DIR));

// Allowlist for ids that turn into filesystem path segments. The dotted-
// segment pattern explicitly rejects "..", leading/trailing dots and
// consecutive dots — without this the previous /^[\w.-]+$/ regex would
// have accepted ".." and allowed traversal one level up out of AGENTS_DIR.
// Inline `AGENT_ID_RE.test(x)` checks at the start of every route reading
// an agent id from req.params/req.body/req.query are recognised by CodeQL
// as a path-injection sanitizer (js/path-injection); helper-indirected
// checks are not, which is why the regex is applied inline.
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const SSH_KEY_ID_RE = /^[a-z0-9-]+$/;
const GH_TOKEN_ID_RE = /^[a-z0-9-]+$/;
const SKILL_NAME_RE = /^[a-zA-Z0-9_-]+([.:][a-zA-Z0-9_-]+)*$/;
// Blueprint id / memory-file path params (proxied into the orchestrator URL).
// Allowlist guards (no separators, no '..') sanitize the values for the URL path.
const BP_PARAM_RE = /^[a-zA-Z0-9_-]+$/;
const BP_FILE_RE = /^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/;

// Rate limiter for the coordinator-workflow endpoints — uses express-rate-limit
// rather than a hand-rolled bucket so that CodeQL's js/missing-rate-limiting
// query recognises it (the query only flags routes without a known middleware).
const coordinatorWorkflowLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});
const handoverLimiter = rateLimit({
  windowMs: 60_000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Per-route limiter explicitly attached to mutating/heavy routes so CodeQL's
// js/missing-rate-limiting query recognises them. Generous max because this
// is an internal single-user admin console — the UI legitimately bursts
// dozens of requests during page navigations and polls several endpoints on
// 5s intervals.
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Tighter limit for routes that spawn processes, run git clone, or write
// large files. Still generous enough not to interfere with normal UI use.
const heavyLimiter = rateLimit({
  windowMs: 60_000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

// Global limiter — a SEPARATE rateLimit instance from apiLimiter so the two
// don't share a counter. (Using the same instance both globally and
// per-route would double-increment every request and halve the effective
// limit.) Catches GET routes that don't carry an explicit limiter.
const globalApiLimiter = rateLimit({
  windowMs: 60_000,
  max: 3000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests' },
});

app.use('/api/', globalApiLimiter);

// Audit trail (#305). Mounted before the auth wiring so it observes every
// mutating /api request — including denied/unauthenticated ones — and reads the
// acting human from req.user lazily at response-finish time. Best-effort: it can
// never block or break a request (see audit.js).
app.use('/api', audit.auditMutations);

// Authentication (#276). Mounted after the global limiter (so the gate itself
// is rate-limited) and before every protected route definition below. Public
// auth endpoints are registered first; the gate then requires a valid session
// cookie for all other /api/* routes. Static assets + the SPA fallback stay
// open so the console can load and render its login screen.
auth.registerAuthRoutes(app);
app.use('/api', auth.gate);

// Read recent audit entries (newest first). Protected by the gate above.
app.get('/api/audit', (req, res) => {
  res.json(audit.recentEntries(Number(req.query.limit) || 200));
});

// Read GitHub poller event-transparency entries (#469): every fresh event the
// poller saw, whether delivered, dropped (with reason), digested, or matching
// no subscriber at all. Protected by the gate above.
app.get('/api/github-events', (req, res) => {
  const entries = githubEventLog.queryEntries({
    since: req.query.since,
    until: req.query.until,
    limit: Number(req.query.limit) || undefined,
  });
  const nameCache = new Map();
  const agentName = (agentId) => {
    if (!nameCache.has(agentId)) {
      const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), null);
      nameCache.set(agentId, cfg?.name || agentId);
    }
    return nameCache.get(agentId);
  };
  res.json(entries.map((e) => ({
    ...e,
    outcomes: (e.outcomes || []).map((o) => ({ ...o, agentName: agentName(o.agentId) })),
  })));
});

const MCP_SERVER_ID_RE = /^[a-z0-9-]+$/;
const MCP_CREDENTIAL_ID_RE = /^[a-z0-9-]+$/;

/* ─── Helpers ───────────────────────────────────────────────────────── */

// writeJsonAtomic and readJsonFile only ever receive paths under WORKSPACE
// (or POOL_DIR for skill files). The inline checks below refuse anything
// else and reject '..' segments. Callers should have already validated
// their user-supplied id segments via AGENT_ID_RE etc., so this only fires
// on a programming bug. CodeQL recognises String.prototype.startsWith and
// String.prototype.includes('..') as path-injection sanitiser barriers
// when applied in the same function as the sink, so the checks are inlined
// (not pulled into a helper) to close the cross-function js/path-injection
// alerts that ~30 caller sites otherwise propagate into the helper body.

function writeJsonAtomic(filePath, data) {
  if (typeof filePath !== 'string' ||
      filePath.includes('..') ||
      !(filePath.startsWith(WORKSPACE + path.sep) || filePath.startsWith(POOL_DIR + path.sep))) {
    throw new Error(`writeJsonAtomic: refusing path outside allowed roots: ${filePath}`);
  }
  const tmp = filePath + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, filePath);
}

function podmanRequest(method, urlPath) {
  return new Promise((resolve, reject) => {
    const opts = { socketPath: PODMAN_SOCK, path: `/v4.0.0/libpod${urlPath}`, method };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function readJsonFile(filePath, fallback = null) {
  if (typeof filePath !== 'string') return fallback;
  // Confine reads: reject traversal and require the path to sit under an
  // allowed root. The reads in this stack are always built from trusted
  // constants joined with id segments that the route handlers validate.
  if (filePath.includes('..')) return fallback;
  if (!(filePath.startsWith(WORKSPACE + path.sep) ||
        filePath.startsWith(POOL_DIR + path.sep) ||
        filePath.startsWith(CONTROL_DIR + path.sep))) {
    return fallback;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

// Resolve the owning (human) Team for a newly created resource (#299). An
// explicit id must reference an existing team; absence falls back to the
// default team. Throws a 400-tagged error for an unknown team.
function resolveOwnerTeamId(teamId) {
  if (!teamId) return DEFAULT_TEAM_ID;
  const teams = readJsonFile(TEAMS_INDEX, []);
  if (!Array.isArray(teams) || !teams.some(t => t.id === teamId)) {
    const err = new Error(`Owning team '${teamId}' not found`);
    err.status = 400;
    throw err;
  }
  return teamId;
}

// Resolve what the logged-in caller may see (#302). Reads the users/memberships
// indexes fresh each call (cheap; small JSON). The env admin and System Admins
// get `all: true` — so the single-operator setup is entirely unaffected.
function getScope(req) {
  const username = req && req.user && req.user.username;
  return computeScope({
    username,
    adminUsername: ADMIN_USERNAME,
    users: readJsonFile(USERS_INDEX, []),
    memberships: readJsonFile(MEMBERSHIPS_INDEX, []),
  });
}

function listAgentDirs() {
  try {
    return fs.readdirSync(AGENTS_DIR).filter(name => {
      const p = path.join(AGENTS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'config.json'));
    });
  } catch {
    return [];
  }
}

function listEnvironmentIds() {
  try {
    return fs.readdirSync(ENVIRONMENTS_DIR).filter(name => {
      if (name.startsWith('_')) return false;
      const p = path.join(ENVIRONMENTS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'environment.json'));
    });
  } catch {
    return [];
  }
}

function loadEnvironment(envId) {
  const p = path.join(ENVIRONMENTS_DIR, envId, 'environment.json');
  const raw = readJsonFile(p, null);
  return normalizeEnvironmentRepositories(raw);
}

// Migrate legacy single-repo `repository` into `repositories: [...]` on read so
// every consumer can rely on the array shape. The legacy field is kept on the
// returned object only if it's still present on disk; saves drop it.
function normalizeEnvironmentRepositories(env) {
  if (!env) return env;
  if (Array.isArray(env.repositories)) return env;
  if (env.repository && env.repository.url) {
    return { ...env, repositories: [env.repository] };
  }
  return { ...env, repositories: [] };
}

function saveEnvironment(envId, data) {
  // path.basename strips any separator — the explicit call is what CodeQL
  // recognises as a path-injection sanitizer for the env-id path segment.
  const dir = path.join(ENVIRONMENTS_DIR, path.basename(String(envId)));
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'environment.json'), data);
}

function listSshKeys() {
  return readJsonFile(SSH_KEYS_INDEX, []);
}

function saveSshKeysIndex(keys) {
  writeJsonAtomic(SSH_KEYS_INDEX, keys);
}

// Extract the SSH "public key blob" (length-prefixed wire form) from an
// OpenSSH-format private-key PEM. Returns null for any other PEM format
// (PKCS1, PKCS8, ...). Algorithm-agnostic: the caller doesn't need to know
// whether the key is ed25519, rsa, ecdsa — the blob is the first key entry.
function extractOpensshPubBlob(pem) {
  // Linear indexOf/slice instead of a regex: a lazy `[\s\S]*?` between two
  // literals backtracks polynomially when the END marker is absent
  // (CodeQL js/polynomial-redos). indexOf scanning is O(n) and avoids it.
  const s = String(pem || '');
  const BEGIN = '-----BEGIN OPENSSH PRIVATE KEY-----';
  const END = '-----END OPENSSH PRIVATE KEY-----';
  const start = s.indexOf(BEGIN);
  if (start === -1) return null;
  const bodyStart = start + BEGIN.length;
  const end = s.indexOf(END, bodyStart);
  if (end === -1) return null;
  let buf;
  try { buf = Buffer.from(s.slice(bodyStart, end).replace(/\s+/g, ''), 'base64'); } catch { return null; }
  const magic = Buffer.from('openssh-key-v1\0', 'utf8');
  if (buf.length < magic.length || !buf.subarray(0, magic.length).equals(magic)) return null;
  let off = magic.length;
  const readSshString = () => {
    if (off + 4 > buf.length) throw new Error('truncated');
    const len = buf.readUInt32BE(off); off += 4;
    if (off + len > buf.length) throw new Error('truncated');
    const out = buf.subarray(off, off + len);
    off += len;
    return out;
  };
  try {
    readSshString(); readSshString(); readSshString();   // ciphername, kdfname, kdfoptions
    if (off + 4 > buf.length) return null;
    const numKeys = buf.readUInt32BE(off); off += 4;
    if (numKeys < 1) return null;
    return readSshString();   // first public key blob
  } catch { return null; }
}

function sshFingerprintFromPubBlob(pubBlob) {
  return 'SHA256:' + crypto.createHash('sha256').update(pubBlob).digest('base64').replace(/=+$/, '');
}

// Standard SSH fingerprint = SHA256 of the public-key wire blob, displayed
// in base64 without padding. Matches what `ssh-keygen -lf` and GitHub show.
// For non-OpenSSH PEMs (rare for SSH today) we fall back to a hash over the
// raw PEM so the listing still has a stable identifier.
function sshKeyFingerprint(privateKey) {
  const blob = extractOpensshPubBlob(privateKey);
  if (blob) return sshFingerprintFromPubBlob(blob);
  return 'SHA256:' + crypto.createHash('sha256').update(privateKey).digest('base64').replace(/=+$/, '');
}

// Generate an unencrypted ed25519 keypair in OpenSSH wire format. Returns
// the PEM-armored OPENSSH PRIVATE KEY together with the matching public key
// in `authorized_keys` form (`ssh-ed25519 <base64> <comment>`). No external
// `ssh-keygen` binary is required — Node's crypto produces the raw 32-byte
// seed/pubkey via PKCS8/SPKI DER, and we frame them per OpenSSH's PROTOCOL.key.
function generateOpensshEd25519Keypair(comment) {
  const c = String(comment || '').replace(/[\r\n]/g, ' ').trim() || 'aee-deploy-key';
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  // Last 32 bytes of the SPKI DER encoding are the raw ed25519 public key.
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  const pub = spki.subarray(spki.length - 32);
  // Last 32 bytes of the PKCS8 DER encoding are the raw ed25519 seed.
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const seed = pkcs8.subarray(pkcs8.length - 32);
  // OpenSSH stores the ed25519 secret as seed||publicKey (64 bytes total).
  const sk = Buffer.concat([seed, pub]);

  const sshString = (s) => {
    const b = Buffer.isBuffer(s) ? s : Buffer.from(s, 'utf8');
    const len = Buffer.alloc(4);
    len.writeUInt32BE(b.length, 0);
    return Buffer.concat([len, b]);
  };

  const pubBlob = Buffer.concat([sshString('ssh-ed25519'), sshString(pub)]);

  const checkint = crypto.randomBytes(4);
  let privSection = Buffer.concat([
    checkint, checkint,
    sshString('ssh-ed25519'),
    sshString(pub),
    sshString(sk),
    sshString(c),
  ]);
  // Pad to a multiple of 8 (cipher block size for ciphername "none"),
  // appending 1, 2, 3, ... so a parser can verify the trailer.
  const pad = [];
  for (let i = 1; (privSection.length + pad.length) % 8 !== 0; i++) pad.push(i);
  privSection = Buffer.concat([privSection, Buffer.from(pad)]);

  const numKeys = Buffer.alloc(4);
  numKeys.writeUInt32BE(1, 0);
  const outer = Buffer.concat([
    Buffer.from('openssh-key-v1\0', 'utf8'),
    sshString('none'),
    sshString('none'),
    sshString(''),
    numKeys,
    sshString(pubBlob),
    sshString(privSection),
  ]);

  const wrapped = outer.toString('base64').match(/.{1,70}/g).join('\n');
  const privatePem =
    '-----BEGIN OPENSSH PRIVATE KEY-----\n' +
    wrapped + '\n' +
    '-----END OPENSSH PRIVATE KEY-----\n';
  const publicSsh = `ssh-ed25519 ${pubBlob.toString('base64')} ${c}`;

  return { privateKey: privatePem, publicKey: publicSsh, pubBlob };
}

function environmentInUse(envId) {
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.environmentId === envId) return id;
  }
  return null;
}

// All agents referencing this environment, scoped to what the caller may see
// (same team/visibility rules as GET /api/agents — #302, #439).
function agentsUsingEnvironment(envId, scope) {
  const agents = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.environmentId === envId && visibleAgent(scope, cfg)) {
      agents.push({ id, displayName: cfg.displayName || id });
    }
  }
  return agents;
}

function sshKeyInUse(keyId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const repos = Array.isArray(env?.repositories) ? env.repositories : [];
    if (repos.some(r => r?.sshKeyId === keyId)) return envId;
  }
  return null;
}

/* ─── GitHub Tokens ─────────────────────────────────────────────────── */

function listGithubTokens() {
  return readJsonFile(GH_TOKENS_INDEX, []);
}

function saveGithubTokensIndex(tokens) {
  writeJsonAtomic(GH_TOKENS_INDEX, tokens);
}

function githubTokenFingerprint(token) {
  return 'SHA256:' + crypto.createHash('sha256').update(token).digest('base64').replace(/=+$/, '').slice(0, 16);
}

// Return only a non-sensitive preview (prefix + last 4 chars).
// E.g. "github_pat_…ABCD" or "ghp_…ABCD".
function githubTokenPreview(token) {
  const m = token.match(/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)?(.*)$/);
  const prefix = (m && m[1]) || '';
  const tail = token.slice(-4);
  return `${prefix}…${tail}`;
}

function githubTokenInUse(tokenId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    if (env?.githubTokenId === tokenId) return envId;
  }
  return null;
}

/* ─── MCP servers + credentials (helpers) ───────────────────────────── */

function listMcpServerIds() {
  try {
    return fs.readdirSync(MCP_SERVERS_DIR).filter(name => {
      if (name.startsWith('_') || name.startsWith('.')) return false;
      const p = path.join(MCP_SERVERS_DIR, name);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'server.json'));
    });
  } catch {
    return [];
  }
}

function loadMcpServer(serverId) {
  if (!MCP_SERVER_ID_RE.test(serverId)) return null;
  return readJsonFile(path.join(MCP_SERVERS_DIR, serverId, 'server.json'), null);
}

function saveMcpServer(serverId, data) {
  const dir = path.join(MCP_SERVERS_DIR, serverId);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'server.json'), data);
}

function mcpServerInUse(serverId) {
  // Returns the first environment id that references this server, or null.
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const refs = Array.isArray(env?.mcpServers) ? env.mcpServers : [];
    if (refs.some(r => r?.serverId === serverId)) return envId;
  }
  return null;
}

function listMcpCredentials() {
  return readJsonFile(MCP_CREDENTIALS_INDEX, []);
}

function saveMcpCredentialsIndex(list) {
  writeJsonAtomic(MCP_CREDENTIALS_INDEX, list);
}

function mcpCredentialFingerprint(secret) {
  return 'SHA256:' + crypto.createHash('sha256').update(String(secret)).digest('base64').replace(/=+$/, '').slice(0, 16);
}

function mcpCredentialInUse(credId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const refs = Array.isArray(env?.mcpServers) ? env.mcpServers : [];
    if (refs.some(r => r?.credentialId === credId)) return envId;
  }
  return null;
}

/* ─── LLM Endpoints (helpers) ───────────────────────────────────────── */

function listLlmEndpoints() {
  return readJsonFile(LLM_ENDPOINTS_INDEX, []);
}

function saveLlmEndpointsIndex(list) {
  writeJsonAtomic(LLM_ENDPOINTS_INDEX, list);
}

function llmTokenFingerprint(token) {
  return 'SHA256:' + crypto.createHash('sha256').update(token).digest('base64').replace(/=+$/, '').slice(0, 16);
}

function llmTokenPreview(token) {
  if (!token) return '';
  const tail = token.slice(-4);
  return `…${tail}`;
}

function readLlmEndpointToken(authTokenId) {
  if (!authTokenId) return '';
  try {
    return fs.readFileSync(path.join(LLM_KEYS_DIR, authTokenId), 'utf8').trim();
  } catch {
    return '';
  }
}

function writeLlmEndpointToken(authTokenId, token) {
  const p = path.join(LLM_KEYS_DIR, authTokenId);
  fs.writeFileSync(p, token, { mode: 0o600 });
  try { fs.chmodSync(p, 0o600); } catch { /* best effort */ }
}

function deleteLlmEndpointToken(authTokenId) {
  if (!authTokenId) return;
  try { fs.unlinkSync(path.join(LLM_KEYS_DIR, authTokenId)); } catch { /* ignore */ }
}

function llmEndpointInUse(endpointId) {
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    if (env?.llmEndpointId === endpointId) return envId;
  }
  return null;
}

function maskLlmEndpoint(ep) {
  if (!ep) return ep;
  const token = readLlmEndpointToken(ep.authTokenId);
  const { authTokenId, ...rest } = ep;
  return {
    ...rest,
    authType: ep.authType === 'oauth-token' ? 'oauth-token' : 'api-key',
    complianceAck: ep.complianceAck || null,
    hasToken: Boolean(token),
    tokenPreview: token ? llmTokenPreview(token) : '',
    tokenFingerprint: token ? llmTokenFingerprint(token) : '',
  };
}

/* ─── Subscription-OAuth support (authType: 'oauth-token') ──────────────
 * A Model Provider can authenticate the Claude CLI with a long-lived
 * subscription OAuth token (Claude Max / Enterprise seat, minted by
 * `claude setup-token`) instead of an API key against a proxy. The token is
 * stored in the same _keys/ store; the orchestrator injects it as
 * CLAUDE_CODE_OAUTH_TOKEN and strips the ANTHROPIC_* variables for agents
 * bound to such a provider.
 *
 * Compliance: Anthropic's Consumer Terms only permit consumer-subscription
 * OAuth tokens for the subscription owner's own, single-user use — not for
 * serving third parties. Creating/re-keying an oauth-token provider therefore
 * requires an explicit single-user acknowledgment, recorded on the entry as
 * complianceAck { singleUser, confirmedAt, confirmedBy }.
 */

const ANTHROPIC_DIRECT_BASE = 'https://api.anthropic.com';

function oauthProbeHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    'anthropic-beta': 'oauth-2025-04-20',
    'anthropic-version': '2023-06-01',
  };
}

function normalizeAuthType(v) {
  return v === 'oauth-token' ? 'oauth-token' : 'api-key';
}

function buildComplianceAck(req) {
  return {
    singleUser: true,
    confirmedAt: new Date().toISOString(),
    confirmedBy: req.user?.sub || 'admin',
  };
}

// Claim the token captured by a completed setup-token login flow from the
// orchestrator. One-shot: the orchestrator wipes its copy on success. Only
// ever called server-side — the raw token never travels to the browser.
async function claimOauthFlowToken(flowId) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  if (!/^[a-f0-9]+$/.test(String(flowId))) {
    return { error: 'invalid oauthFlowId' };
  }
  try {
    const r = await fetch(`${orchestratorUrl}/internal/llm-auth/flows/${flowId}/claim`, { method: 'POST' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) return { error: body.error || `claim failed (HTTP ${r.status})` };
    if (!body.token) return { error: 'login flow returned no token' };
    return { token: body.token };
  } catch (err) {
    return { error: `orchestrator unreachable: ${err.message}` };
  }
}

// Synthetic read-only provider record that mirrors the ANTHROPIC_* variables
// from `.env`. Surfaced through GET /api/llm-env-fallback so the Model
// Providers page can show the operator what the "inherit from .env" choice
// would actually resolve to. Returns null when ANTHROPIC_BASE_URL isn't set.
function buildEnvFallbackProvider() {
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl) return null;
  const token  = (process.env.ANTHROPIC_AUTH_TOKEN || '').trim();
  const sonnet = (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6').trim();
  const haiku  = (process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5').trim();
  const models = [];
  if (sonnet) models.push({ id: sonnet, displayName: sonnet, kind: 'sonnet' });
  if (haiku && haiku !== sonnet) models.push({ id: haiku, displayName: haiku, kind: 'haiku' });
  return {
    id: '__env__',
    name: 'Inherited from .env',
    baseUrl,
    hasToken: Boolean(token),
    tokenPreview: token ? llmTokenPreview(token) : '',
    tokenFingerprint: token ? llmTokenFingerprint(token) : '',
    models,
    defaultModelId: sonnet || (models[0]?.id ?? null),
    readOnly: true,
    source: '.env',
  };
}

// One-time auto-migration: if no endpoint is registered yet but the legacy
// `.env` configures a base URL, seed a "Default (from .env)" endpoint so
// existing setups keep working without manual UI steps.
function ensureDefaultLlmEndpoint() {
  const existing = listLlmEndpoints();
  if (existing.length > 0) return;
  const baseUrl = process.env.ANTHROPIC_BASE_URL || '';
  if (!baseUrl) return;
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const sonnet = process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6';
  const haiku  = process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5';
  const id = 'default';
  const authTokenId = token ? `${id}-${Date.now().toString(36)}` : '';
  if (token) writeLlmEndpointToken(authTokenId, token);
  const entry = {
    id,
    name: 'Default (from .env)',
    baseUrl,
    authTokenId,
    models: [
      { id: sonnet, displayName: sonnet, kind: 'sonnet' },
      { id: haiku,  displayName: haiku,  kind: 'haiku'  },
    ],
    createdAt: new Date().toISOString(),
    migratedFromEnv: true,
  };
  saveLlmEndpointsIndex([entry]);
  console.log(`[api] Seeded default LLM endpoint from .env (baseUrl=${baseUrl})`);
}

ensureDefaultLlmEndpoint();

// Plain HTTP/HTTPS GET for proxy probing (test-connection / discover-models).
// Returns { status, body, error }. Never throws.
function httpGetJson(targetUrl, headers = {}, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return resolve({ status: 0, body: null, error: `Invalid URL: ${err.message}` });
    }
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method: 'GET',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: { Accept: 'application/json', ...headers },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let body = data;
        try { body = data ? JSON.parse(data) : null; } catch { /* keep as string */ }
        resolve({ status: res.statusCode, body, error: null });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.end();
  });
}

// Build the URL the LiteLLM proxy exposes its model catalog at. Accepts both
// `https://host` and `https://host/v1` styles by appending `/v1/models` when
// the base URL doesn't already end in /v1 or /models.
function buildModelsUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/(v1\/)?models$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/models`;
  return `${trimmed}/v1/models`;
}

// Companion to buildModelsUrl for the Anthropic-compatible chat endpoint.
// Appends `/v1/messages` unless the base URL already targets a versioned or
// messages path.
function buildMessagesUrl(baseUrl) {
  const trimmed = baseUrl.replace(/\/+$/, '');
  if (/\/messages$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/messages`;
  return `${trimmed}/v1/messages`;
}

// Plain HTTP/HTTPS POST of a JSON body. Mirrors httpGetJson: returns
// { status, body, error } and never throws. Used for one-shot LLM calls.
function httpPostJson(targetUrl, headers = {}, bodyObj = {}, timeoutMs = 30000) {
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return resolve({ status: 0, body: null, error: `Invalid URL: ${err.message}` });
    }
    const payload = Buffer.from(JSON.stringify(bodyObj));
    const lib = parsed.protocol === 'https:' ? require('https') : require('http');
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...headers,
      },
      timeout: timeoutMs,
    }, (res) => {
      let data = '';
      res.on('data', (c) => data += c);
      res.on('end', () => {
        let body = data;
        try { body = data ? JSON.parse(data) : null; } catch { /* keep as string */ }
        resolve({ status: res.statusCode, body, error: null });
      });
    });
    req.on('error', (err) => resolve({ status: 0, body: null, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: null, error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

/* ─── Health ────────────────────────────────────────────────────────── */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

/* ─── Setup Status ──────────────────────────────────────────────────── */

app.get('/api/setup/status', (req, res) => {
  const llmEndpoints = readJsonFile(LLM_ENDPOINTS_INDEX, []);
  const sshKeys      = readJsonFile(SSH_KEYS_INDEX, []);
  const ghTokens     = readJsonFile(GH_TOKENS_INDEX, []);
  const envIds       = listEnvironmentIds();
  const agentIds     = listAgentDirs();

  const steps = [
    { id: 'llm',         label: 'LLM Endpoint',        done: llmEndpoints.length > 0, required: true },
    { id: 'ssh-key',     label: 'SSH Key',              done: sshKeys.length > 0,      required: false },
    { id: 'gh-token',    label: 'GitHub Token',         done: ghTokens.length > 0,     required: false },
    { id: 'environment', label: 'Working Environment',  done: envIds.length > 0,       required: false },
    { id: 'agent',       label: 'First Agent',          done: agentIds.length > 0,     required: false },
  ];

  const isComplete = steps.filter(s => s.required).every(s => s.done);
  const doneCount  = steps.filter(s => s.done).length;

  res.json({ isComplete, steps, completionPercent: Math.round((doneCount / steps.length) * 100) });
});

/* ─── Agents ────────────────────────────────────────────────────────── */

app.get('/api/agents', (req, res) => {
  const scope = getScope(req);
  const ids = listAgentDirs();
  const agents = ids
    .map(id => {
      const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
      return { id, ...cfg };
    })
    .filter(a => visibleAgent(scope, a)); // team + visibility scoping (#302)
  res.json(agents);
});

// NOTE: must be registered BEFORE `/api/agents/:id` — otherwise Express
// would match this static path against the parameterized route (with
// id="statuses") and return 404.
app.get('/api/agents/statuses', apiLimiter, async (req, res) => {
  const ids = listAgentDirs();

  let runningIds = new Set();
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/processes`);
    if (resp.ok) {
      const processes = await resp.json();
      for (const p of processes) {
        if (p.running) runningIds.add(p.id);
      }
    }
  } catch { /* orchestrator unreachable — all agents appear offline */ }

  const statuses = ids.map(id => {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const displayName = cfg.displayName ?? id;
    if (cfg.enabled === false) return { id, displayName, activityState: 'disabled', hasSession: false };
    if (!runningIds.has(id)) return { id, displayName, activityState: 'offline', hasSession: false };
    const status = readJsonFile(controlOrAgentPath(id, 'status.json'), null); // pushed copy preferred (#185)
    const dmRoom = readJsonFile(path.join(AGENTS_DIR, id, 'dm-room.json'), null);
    const hasSession = !!(dmRoom?.roomId &&
      fs.existsSync(controlOrAgentPath(id, 'sessions', dmRoom.roomId + '.current.json'))); // pushed copy preferred (#185)
    return {
      id,
      displayName,
      activityState: status?.state === 'busy' ? 'busy' : 'idle',
      lastResponseAt: status?.lastResponseAt ?? null,
      hasSession,
    };
  });

  res.json(statuses);
});

app.get('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []); // canonical copy (#185)
  res.json({ id, ...cfg, triggers });
});

// Best-effort: nudge a running agent (SIGUSR2 via the orchestrator) to re-pull
// its triggers + config + dm-room now instead of waiting for the next 60s sync.
// No-op if the agent isn't running. (#185 Phase 2)
function notifyAgentReload(agentId) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reload-triggers`, { method: 'POST' })
    .catch(() => {});
}

// A derived data-flow trigger is one the `expandDataFlowSteps` derivation owns:
// it carries the `dataFlow` marker and the canonical `<consumer>-on-push-<up>`
// id. Manually-authored data-flow triggers (arbitrary ids) don't match and are
// preserved untouched by reconciliation. Kept in sync with process-template.js.
function isDerivedDataFlowTrigger(t, memberId) {
  return t && t.dataFlow === true && typeof t.id === 'string'
    && t.id.startsWith(`${memberId}-on-push-`);
}

// Re-derive the functional data-flow push triggers for a whole team from its
// members' declarative ports (`dataFlow.{dependsOn,inputs,outputs}`), mirroring
// what `expandDataFlowSteps` does at materialise time. This is what makes a live
// team behave like a draft: the ports are the single source of truth for the
// edges, and the runtime wiring is derived on write — no separate trigger
// bookkeeping in the editor. Best-effort and idempotent; only members whose
// trigger set actually changes are written back. Regenerating from ports-stripped
// triggers handles both adds (new port) and removals (dropped port). Members'
// own ids are already full member ids, so no teamId mapping is applied.
async function reconcileTeamDataFlow(teamId) {
  if (!teamId) return;
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const df = cfg.dataFlow && typeof cfg.dataFlow === 'object' ? cfg.dataFlow : {};
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({ id, displayName: cfg.displayName || id, triggers: Array.isArray(triggers) ? triggers : [], df });
  }
  if (members.length === 0) return;

  // Strip the previously-derived triggers so expandDataFlowSteps regenerates the
  // full current set from the ports (a plain no-op leaves stale ones behind).
  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName,
    inputs: Array.isArray(m.df.inputs) ? m.df.inputs : [],
    outputs: Array.isArray(m.df.outputs) ? m.df.outputs : [],
    dependsOn: Array.isArray(m.df.dependsOn) ? m.df.dependsOn : [],
    triggers: m.triggers.filter(t => !isDerivedDataFlowTrigger(t, m.id)),
  }));
  const expanded = expandDataFlowSteps({ roles }).roles;
  const byId = new Map(expanded.map(r => [r.id, r]));
  const norm = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));

  for (const m of members) {
    // Preserve each regenerated derived trigger's history-horizon stamp so this
    // rewrite doesn't push the poller's horizon to "now" and drop pending events
    // (#446). Content-compare (order-insensitive on id) so we write when the
    // wiring OR its preserved activatedAt genuinely changed — but skip a pure
    // no-op, which would bump triggers.json mtime for nothing.
    const next = stampDerivedActivation(byId.get(m.id)?.triggers || [], m.triggers);
    if (norm(next) === norm(m.triggers)) continue;
    try { await putTriggers(m.id, next); notifyAgentReload(m.id); }
    catch { /* best-effort — never break the originating request */ }
  }
}

// Re-derive the functional GitHub-channel triggers for a whole team from its
// members' declarative `channels` ports (#380), mirroring what
// `expandGithubChannels` does at materialise time. Same pattern as
// reconcileTeamDataFlow: strip the previously-derived `channel:true` triggers,
// regenerate from the ports, and write back only members whose derived set
// actually changed (content-compared, so editing a channel's label/gate updates
// its trigger even though the trigger id is stable). Members already carry full
// ids, so no teamId mapping is applied (a channel `from` is already a member id).
async function reconcileTeamGithubChannels(teamId) {
  if (!teamId) return;
  const members = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.parentTeamId !== teamId) continue;
    const channels = Array.isArray(cfg.channels) ? cfg.channels : [];
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    members.push({ id, displayName: cfg.displayName || id, channels, triggers: Array.isArray(triggers) ? triggers : [] });
  }
  if (members.length === 0) return;

  const roles = members.map(m => ({
    id: m.id,
    displayName: m.displayName,
    channels: m.channels,
    triggers: m.triggers.filter(t => !isChannelTrigger(t)),
  }));
  const expanded = expandGithubChannels({ roles }).roles;
  const byId = new Map(expanded.map(r => [r.id, r]));
  const norm = (arr) => JSON.stringify([...arr].sort((a, b) => (a.id < b.id ? -1 : 1)));

  for (const m of members) {
    // Preserve each regenerated channel trigger's history-horizon stamp so this
    // rewrite can't push the poller's horizon to "now" and drop a pending PR/issue
    // event (#446 — the exact case that kept the code-reviewer from ever firing).
    const next = stampDerivedActivation(byId.get(m.id)?.triggers || [], m.triggers);
    if (norm(next) === norm(m.triggers)) continue;
    try { await putTriggers(m.id, next); notifyAgentReload(m.id); }
    catch { /* best-effort — never break the originating request */ }
  }
}

// Guard against a parent-child cycle among a team's members (#377). Walks the
// existing parentMemberId chain: setting `child`'s parent to `parent` is a cycle
// if `child` is already an ancestor of `parent` (or they're equal).
function parentWouldCycle(teamId, childId, parentId) {
  if (!parentId || parentId === childId) return parentId === childId;
  const parentOf = new Map();
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (cfg && cfg.parentTeamId === teamId && typeof cfg.parentMemberId === 'string') {
      parentOf.set(id, cfg.parentMemberId);
    }
  }
  let cur = parentId, seen = new Set();
  while (cur && !seen.has(cur)) {
    if (cur === childId) return true;
    seen.add(cur);
    cur = parentOf.get(cur);
  }
  return false;
}

// Best-effort: after the admin writes a control-plane file (prompt, skill) to the
// pool subpath, ask the orchestrator to mirror those named paths into a running
// isolated agent's dedicated volume (#185 item 5). The orchestrator is the only
// writer that can reach that volume; it's a no-op there when AEE_PER_AGENT_VOLUME
// is off or the agent isn't running. Harmless on the shared-volume path — the
// files we just wrote already live where the agent reads them.
function notifyAgentReseed(agentId, paths) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reseed`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ paths }),
  }).catch(() => {});
}

app.put('/api/agents/:id', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const { displayName, role, enabled, briefingsPath, systemPromptTemplate, systemPrompt, skillsOverride, mcpServersOverride, disableMode, teamId, emits, dataFlow, parentMemberId, stage, github, channels } = req.body;

  // Enable/disable goes through the orchestrator so stubs (no token yet)
  // get fully materialized — Matrix user, workspace seeding, agent-runner
  // process — on first activation. For already-materialized agents this
  // just (re)spawns or stops the runner.
  if (enabled !== undefined && enabled !== (cfg.enabled !== false)) {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    const action = enabled ? 'enable' : 'disable';
    try {
      // When disabling, forward an explicit mode ('drain' or 'abort') if the
      // caller supplied one. Without a mode the orchestrator may return 409
      // with a warning payload — relay that directly to the frontend so the
      // UI can present the drain-vs-abort choice to the user.
      const fetchOpts = { method: 'POST' };
      if (action === 'disable' && disableMode) {
        fetchOpts.headers = { 'Content-Type': 'application/json' };
        fetchOpts.body = JSON.stringify({ mode: disableMode });
      }
      const resp = await fetch(
        `${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/${action}`,
        fetchOpts,
      );
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
      // Re-read the updated config — orchestrator wrote the canonical version.
      // On enable, eagerly provision the DM room so the agent is ready before
      // the first message (#184). Best-effort — never blocks the enable result.
      if (action === 'enable') await preCreateAgentDmRoom(id, 'enable');
    } catch (err) {
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
  }

  // Team prompt edit: route through the orchestrator so the new template gets
  // pushed to all inheriting members in the same call (their AGENT-PROMPT.md
  // and CLAUDE.md are rewritten in place — see updateTeamPrompt).
  if (cfg.role === 'team' && typeof systemPromptTemplate === 'string') {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(id)}/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ systemPromptTemplate }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
    } catch (err) {
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
  }

  // Apply the rest of the field updates directly to the on-disk config.
  // (The orchestrator's enable/disable already wrote enabled itself; the
  // team-prompt branch above also wrote canonically.)
  const fresh = readJsonFile(cfgPath, cfg);
  if (displayName !== undefined) fresh.displayName = displayName;
  if (role !== undefined) fresh.role = role;
  if (briefingsPath !== undefined) fresh.briefingsPath = briefingsPath;
  // Agent-level emitted labels (label hand-offs wired from the process editor).
  // `null` / [] clears the set.
  if (emits !== undefined) {
    if (Array.isArray(emits) && emits.length) fresh.emits = emits.filter(e => typeof e === 'string' && e);
    else delete fresh.emits;
  }

  // ── Unified orchestration edges (Process Canvas) ──────────────────────────
  // The declarative data-flow ports are the single source of truth for the
  // dependency + data-flow edges in the Flows graph — the same shape a draft
  // bundle carries on its roles. Writing them here lets the process editor wire
  // a live team exactly like a draft; the functional push triggers are re-derived
  // from these ports below (reconcileTeamDataFlow), mirroring materialise time.
  let dataFlowChanged = false;
  if (dataFlow !== undefined) {
    // An artifact port is matched by its logical `name` when set, else by `path`
    // (#382). Keep whichever of name/path/hint the caller supplied, requiring at
    // least one of name or path so the port has a match key.
    const normArtifacts = (arr) => (Array.isArray(arr) ? arr : [])
      .map(a => (typeof a === 'string' ? { path: a } : a))
      .filter(a => a && typeof a === 'object')
      .map(a => {
        const name = typeof a.name === 'string' ? a.name.trim() : '';
        const hint = typeof a.hint === 'string' ? a.hint.trim() : '';
        const p = typeof a.path === 'string' ? a.path.trim() : '';
        return {
          ...(name ? { name } : {}),
          ...(hint ? { hint } : {}),
          ...(p ? { path: p } : {}),
          ...(a.description ? { description: a.description } : {}),
        };
      })
      .filter(a => a.name || a.path);
    const normDeps = (arr) => [...new Set((Array.isArray(arr) ? arr : [])
      .filter(d => typeof d === 'string' && d && d !== id))];
    const next = {};
    const inputs = normArtifacts(dataFlow && dataFlow.inputs);
    const outputs = normArtifacts(dataFlow && dataFlow.outputs);
    const dependsOn = normDeps(dataFlow && dataFlow.dependsOn);
    if (inputs.length) next.inputs = inputs;
    if (outputs.length) next.outputs = outputs;
    if (dependsOn.length) next.dependsOn = dependsOn;
    if (Object.keys(next).length) fresh.dataFlow = next; else delete fresh.dataFlow;
    dataFlowChanged = true;
  }

  // Parent-child hierarchy (#377). `null`/'' clears; a member id sets it, guarded
  // against self- and ancestor-cycles among the team's members.
  if (parentMemberId !== undefined) {
    if (typeof parentMemberId === 'string' && parentMemberId) {
      if (parentWouldCycle(fresh.parentTeamId, id, parentMemberId)) {
        return res.status(400).json({ error: 'that would create a parent cycle' });
      }
      fresh.parentMemberId = parentMemberId;
    } else {
      delete fresh.parentMemberId;
    }
  }

  // Process stage band (#362 E). Empty clears (inherits from parent).
  if (stage !== undefined) {
    if (typeof stage === 'string' && stage.trim()) fresh.stage = stage.trim();
    else delete fresh.stage;
  }

  // ── GitHub artifact ports (#380) ──────────────────────────────────────────
  // Produce flags (opens PRs/issues) drive the node badge/ports + the producer
  // instruction block; consumed channels drive the on:'github' edges and the
  // derived github-event triggers (re-derived below via reconcileTeamGithubChannels).
  let githubChanged = false;
  if (github !== undefined) {
    const g = github && typeof github === 'object' ? github : {};
    const next = {};
    if (g.producesPr) next.producesPr = true;
    if (g.producesIssue) next.producesIssue = true;
    if (Object.keys(next).length) fresh.github = next; else delete fresh.github;
    githubChanged = true;
  }
  let channelsChanged = false;
  if (channels !== undefined) {
    const norm = (Array.isArray(channels) ? channels : [])
      .filter(c => c && (c.artifact === 'pr' || c.artifact === 'issue')
        && typeof c.from === 'string' && c.from && c.from !== id)
      .map(c => ({
        artifact: c.artifact, from: c.from,
        ...(typeof c.label === 'string' && c.label.trim() ? { label: c.label.trim() } : {}),
        ...(c.gate === 'human' ? { gate: 'human' } : {}),
      }));
    if (norm.length) fresh.channels = norm; else delete fresh.channels;
    channelsChanged = true;
  }

  // Reassign the agent to a human Team (#308). Validates against existing
  // teams; metadata-only, so no respawn is needed.
  if (teamId !== undefined) {
    try { fresh.teamId = resolveOwnerTeamId(teamId); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  }

  // Team-member inheritance toggles. `null` means "switch to inherit"
  // (delete the field); a string / array means "set the override".
  if (fresh.role === 'team-member') {
    if (systemPrompt === null) {
      delete fresh.systemPrompt;
    } else if (typeof systemPrompt === 'string') {
      fresh.systemPrompt = systemPrompt;
    }
    if (skillsOverride === null) {
      delete fresh.skillsOverride;
    } else if (Array.isArray(skillsOverride)) {
      fresh.skillsOverride = skillsOverride;
    }
    if (mcpServersOverride === null) {
      delete fresh.mcpServersOverride;
    } else if (mcpServersOverride !== undefined) {
      try {
        fresh.mcpServersOverride = normalizeMcpServersInput(mcpServersOverride);
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }
    }
  }

  writeJsonAtomic(cfgPath, fresh);
  // A data-flow port change re-derives the team's functional push triggers so a
  // live edit takes effect at runtime without a re-materialise (best-effort).
  if (dataFlowChanged && fresh.parentTeamId) {
    await reconcileTeamDataFlow(fresh.parentTeamId);
  }
  // A channel-port change re-derives the team's functional github-event triggers
  // so a live edit takes effect at runtime without a re-materialise (#380). The
  // produce-flag change refreshes the producer block on the next member rebuild
  // (lazy, per the team-env convention) — the flag itself already drives the
  // graph badge + lints immediately.
  if (channelsChanged && fresh.parentTeamId) {
    await reconcileTeamGithubChannels(fresh.parentTeamId);
  }
  // Wake a running agent so it re-pulls config promptly under volume isolation
  // (#185 Phase 2). On the shared volume the agent re-reads config.json on its
  // next action anyway, so this is just a harmless idempotent re-sync there.
  notifyAgentReload(id);
  res.json({ id, ...fresh });
});

/* ─── Reset agent to stub state ─────────────────────────────────────── */

app.post('/api/agents/:id/deactivate', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const { mode } = req.body || {};
    const fetchOpts = { method: 'POST' };
    if (mode) {
      fetchOpts.headers = { 'Content-Type': 'application/json' };
      fetchOpts.body = JSON.stringify({ mode });
    }
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/deactivate`,
      fetchOpts,
    );
    const data = await resp.json();
    // Forward 409 warning payloads to the frontend so the UI can present the
    // drain-vs-hard-stop choice to the user.
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── BP-instance hand-off (FreeFlow) ───────────────────────────────────
 *
 * Replaces the legacy bp-transition.py / /internal/bp-events propagation.
 * Entry point: a button in the bp-instance chat.
 *
 * Routes:
 *   GET  /api/agents/:id/handover/candidates  → orchestrator computes
 *        suggested + sibling targets from .index.json. Proxy only.
 *   GET  /api/agents/:id/handover/git-status  → per-repo commit/push state
 *        of the source agent's workspace, used by the dialog's pre-flight.
 *        Proxy only.
 *   POST /api/agents/:id/handover/nudge       → posts a canned "commit"/
 *        "push" prompt into the source agent's own DM so the agent itself
 *        does the git work. Keeps the audit trail in chat.
 *   POST /api/agents/:id/handover             → fan-out. The orchestrator
 *        re-fetches git-status server-side and refuses unless every repo
 *        is `ready` *or* the caller passes `override: { reason }`. For
 *        each target we (1) materialize/enable via orchestrator,
 *        (2) ensure a DM room with the admin, (3) send a structured
 *        m.text DM containing source-of-work coordinates + the user's
 *        free-text note + onboarding steps. The receiving agent's DM
 *        handler picks it up like any other user message.
 *
 * Submit body shape:
 *   {
 *     targets: [agentId, ...],            // required, non-empty
 *     note: string,                        // optional shared free-text
 *     perTarget: { agentId: noteOverride } // optional, overrides note
 *     override: { reason: string } | null  // required if any source repo is not ready
 *   }
 */

const ORCH_URL = () => process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

async function fetchHandoverCandidates(sourceId) {
  const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(sourceId)}/handover-candidates`);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

async function fetchSourceGitStatus(sourceId) {
  const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(sourceId)}/workspace/git-status`);
  if (!resp.ok) return null;
  return resp.json().catch(() => null);
}

// Compare the source's workspace repos against a target environment's repo
// list. Returns warning strings the target should know about (missing repo,
// different branch, …). Pure data — never throws.
function repoConsistencyWarnings(sourceRepos, targetEnv) {
  const warnings = [];
  const targetRepos = Array.isArray(targetEnv?.repositories) ? targetEnv.repositories : [];
  for (const src of sourceRepos) {
    if (!src?.url) continue;
    const match = targetRepos.find((r) => r?.url === src.url);
    if (!match) {
      warnings.push(`Target environment does not include repo \`${src.url}\` — the receiving agent will not see this code without an env update.`);
      continue;
    }
    if (src.branch && match.branch && src.branch !== match.branch) {
      warnings.push(`Branch mismatch on \`${src.name || src.url}\`: source is on \`${src.branch}\`, target environment defaults to \`${match.branch}\`. The receiving agent will need to \`git checkout ${src.branch}\` first.`);
    }
  }
  return warnings;
}

// Build the structured Markdown body that goes into a target's DM. Plain
// text fallbacks are safe — the markdown renders in Element & the chat UI,
// and degrades gracefully for any client that ignores it.
function renderHandoverBody({ headerLine, repos, suggestedRow, noteText, override, consistencyWarnings }) {
  const lines = [headerLine, ''];

  const reportable = repos.filter((r) => r.exists);
  if (reportable.length > 0) {
    lines.push('**Source of work**');
    for (const r of reportable) {
      const branch = r.branchActual || r.branch || '(no branch)';
      const head = r.headShort ? ` @ \`${r.headShort}\`` : '';
      const subject = r.headSubject ? ` — _${r.headSubject}_` : '';
      lines.push(`- **${r.name}** — \`${branch}\`${head}${subject}`);
      if (r.remoteUrl) lines.push(`  - remote: \`${r.remoteUrl}\``);
      if (r.upstream) lines.push(`  - upstream: \`${r.upstream}\` (ahead ${r.ahead ?? '?'}, behind ${r.behind ?? '?'})`);
      if (!r.clean) {
        const parts = [];
        if (r.dirty.staged)    parts.push(`${r.dirty.staged} staged`);
        if (r.dirty.unstaged)  parts.push(`${r.dirty.unstaged} unstaged`);
        if (r.dirty.untracked) parts.push(`${r.dirty.untracked} untracked`);
        lines.push(`  - ⚠ uncommitted: ${parts.join(', ')}`);
      }
    }
    lines.push('');
  }

  if (suggestedRow?.reason === 'input-artifact' && Array.isArray(suggestedRow.paths) && suggestedRow.paths.length > 0) {
    lines.push('**Concrete inputs (from BP graph)**');
    for (const p of suggestedRow.paths) lines.push(`- \`${p}\``);
    lines.push('');
  }

  if (noteText) {
    lines.push('**Note from upstream**', noteText, '');
  }

  if (override?.reason) {
    lines.push(`**⚠ Hand-off override** — upstream had unfinished git state. Reason: ${override.reason}`, '');
  }

  if (consistencyWarnings.length > 0) {
    lines.push('**Heads-up**');
    for (const w of consistencyWarnings) lines.push(`- ${w}`);
    lines.push('');
  }

  if (reportable.length > 0) {
    lines.push('**Before you start**');
    let step = 1;
    for (const r of reportable) {
      const branch = r.branchActual || r.branch;
      if (!branch || branch === 'HEAD') continue;
      lines.push(`${step}. \`cd ${r.name} && git fetch && git checkout ${branch} && git pull --ff-only\``);
      step++;
    }
    if (step === 1) {
      lines.push('1. Sync your repo clones (`git fetch && git pull --ff-only`) before reading any files.');
    }
    lines.push(`${step}. Skim \`git log --oneline -5\` in each repo so you know exactly which commits are yours to build on.`);
    lines.push(`${step + 1}. Read your own brief and confirm with the user before making changes.`);
  } else {
    lines.push('Please begin your part of the work — your brief has the full context.');
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

app.get('/api/agents/:id/handover/candidates', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(id)}/handover-candidates`);
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/agents/:id/handover/git-status', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  try {
    const resp = await fetch(`${ORCH_URL()}/internal/agents/${encodeURIComponent(id)}/workspace/git-status`);
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

// Post a canned "please commit" / "please push" prompt into the source
// agent's own DM. We send it as the admin user (same path as a manually
// typed message) so the agent picks it up via its normal DM heuristic and
// the entire exchange — including the resulting commits — stays visible in
// the chat history. Used by the pre-flight buttons.
app.post('/api/agents/:id/handover/nudge', handoverLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });

  // Re-validate inline at the path.join site — CodeQL recognises inline
  // AGENT_ID_RE.test() as a path-injection sanitizer (js/path-injection)
  // but does not propagate the route-level check through subsequent code.
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const sourceCfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  if (!sourceCfg) return res.status(404).json({ error: 'Agent not found' });

  const { kind, repos } = req.body || {};
  if (kind !== 'commit' && kind !== 'push') {
    return res.status(400).json({ error: "kind must be 'commit' or 'push'" });
  }
  const repoNames = Array.isArray(repos)
    ? repos.filter((r) => typeof r === 'string' && /^[\w.-]+$/.test(r)).slice(0, 10)
    : [];
  const repoHint = repoNames.length > 0
    ? ` (repos: ${repoNames.map((r) => `\`${r}\``).join(', ')})`
    : '';

  const body = kind === 'commit'
    ? `Pre-handoff check: please commit and push every uncommitted change in your workspace${repoHint}.\n\n` +
      'Use clear, scoped commit messages that explain the result of your work — downstream agents will only see the git history. ' +
      'Once everything is on the remote branch, reply with the branch name and the head commit SHA per repo so I can hand off.'
    : `Pre-handoff check: please push your local commits to the remote branch${repoHint}.\n\n` +
      'Reply with the branch name and the resulting head commit SHA per repo so I can hand off.';

  let roomId;
  try {
    const dm = await ensureAgentDmRoom(id);
    roomId = dm.roomId;
  } catch (err) {
    return res.status(502).json({ error: `Could not open DM room: ${err.message}` });
  }

  const txnId = crypto.randomUUID();
  try {
    const sendResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { method: 'PUT', body: { msgtype: 'm.text', body } });
    if (sendResp.status >= 400) {
      return res.status(502).json({ error: sendResp.data?.error || `Matrix ${sendResp.status}` });
    }
    res.json({ ok: true, kind, roomId, eventId: sendResp.data?.event_id || null });
  } catch (err) {
    res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
  }
});

app.post('/api/agents/:id/handover', handoverLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });

  const sourceCfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
  if (!sourceCfg) return res.status(404).json({ error: 'Agent not found' });
  if (sourceCfg.role !== 'bp-instance') {
    return res.status(409).json({ error: `Agent '${id}' is not a bp-instance (role=${sourceCfg.role})` });
  }

  const { targets, note, perTarget, override } = req.body || {};
  if (!Array.isArray(targets) || targets.length === 0) {
    return res.status(400).json({ error: 'targets (non-empty array of agent ids) is required' });
  }
  for (const t of targets) {
    if (typeof t !== 'string' || !AGENT_ID_RE.test(t)) {
      return res.status(400).json({ error: `Invalid target agent id: ${String(t).slice(0, 80)}` });
    }
  }
  const sharedNote = typeof note === 'string' ? note.trim() : '';
  const perTargetMap = perTarget && typeof perTarget === 'object' && !Array.isArray(perTarget) ? perTarget : {};
  const overrideReason = override && typeof override === 'object' && typeof override.reason === 'string'
    ? override.reason.trim()
    : '';
  const overrideObj = overrideReason ? { reason: overrideReason } : null;

  if (!matrix.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  }

  // Re-fetch the source git status server-side so we cannot be tricked by a
  // stale browser snapshot. Block unless ready or override-with-reason.
  const gitStatus = await fetchSourceGitStatus(id);
  if (!gitStatus) {
    return res.status(502).json({ error: 'Could not fetch source git status from orchestrator' });
  }
  const sourceRepos = Array.isArray(gitStatus.repos) ? gitStatus.repos : [];
  const sourceReady = Boolean(gitStatus.summary?.ready);
  if (!sourceReady && !overrideObj) {
    const issues = [];
    for (const r of sourceRepos) {
      if (!r.exists) { issues.push(`${r.name}: not cloned`); continue; }
      if (!r.clean)  { issues.push(`${r.name}: uncommitted changes`); continue; }
      if (!r.upstream) { issues.push(`${r.name}: no upstream`); continue; }
      if ((r.ahead || 0) > 0) issues.push(`${r.name}: ${r.ahead} unpushed commit(s)`);
    }
    return res.status(409).json({
      error: 'Source workspace is not hand-off-ready',
      reason: 'git-not-ready',
      issues,
      gitStatus,
      hint: 'Resolve the issues, or pass `override: { reason: "..." }` to proceed anyway.',
    });
  }

  // Pull suggested-target metadata (input-artifact paths etc.) once so we
  // can enrich each per-target body without re-querying the orchestrator
  // inside the loop.
  const candidates = await fetchHandoverCandidates(id).catch(() => null);
  const suggestedById = new Map();
  for (const s of (candidates?.suggested || [])) suggestedById.set(s.agentId, s);

  const orchestratorUrl = ORCH_URL();
  const sourceLabel = sourceCfg.displayName || id;
  const sourceBpHash = sourceCfg.bpId ? String(sourceCfg.bpId).slice(0, 8) : null;
  const headerLine = sourceBpHash
    ? `Hand-off from **${sourceLabel}** (bp:${sourceBpHash}) — your upstream BP signalled it's done.`
    : `Hand-off from **${sourceLabel}** — your upstream agent signalled it's done.`;

  const results = [];
  for (const targetId of targets) {
    const targetCfgPath = path.join(AGENTS_DIR, targetId, 'config.json');
    const targetCfg = readJsonFile(targetCfgPath, null);
    if (!targetCfg) {
      results.push({ agentId: targetId, ok: false, stage: 'lookup', error: 'target not found' });
      continue;
    }

    // Per-target consistency check: does the target's environment know
    // about the source's repo URLs, and on the same default branch?
    const targetEnv = targetCfg.environmentId ? loadEnvironment(targetCfg.environmentId) : null;
    const consistencyWarnings = repoConsistencyWarnings(sourceRepos, targetEnv);

    // 1. Materialize / enable the target via orchestrator (idempotent).
    try {
      const enableResp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(targetId)}/enable`, {
        method: 'POST',
      });
      const enableData = await enableResp.json().catch(() => ({}));
      if (!enableResp.ok) {
        results.push({ agentId: targetId, ok: false, stage: 'enable', error: enableData.error || `HTTP ${enableResp.status}` });
        continue;
      }
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'enable', error: `Orchestrator unreachable: ${err.message}` });
      continue;
    }

    // 2. Ensure DM room. enableAgent rewrites config.json with the new
    // token, so re-read before checking matrix readiness.
    const refreshedCfg = readJsonFile(targetCfgPath, null);
    if (!refreshedCfg?.token) {
      results.push({ agentId: targetId, ok: false, stage: 'enable', error: 'agent has no Matrix token after enable' });
      continue;
    }
    let roomId;
    try {
      const dm = await ensureAgentDmRoom(targetId);
      roomId = dm.roomId;
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'dm', error: err.message });
      continue;
    }

    // 3. Build the structured DM body and send it. The receiving agent's
    // DM heuristic in the agent runtime picks it up like any other user
    // message and invokes Claude with the body as the prompt.
    const noteText = (typeof perTargetMap[targetId] === 'string' ? perTargetMap[targetId] : sharedNote).trim();
    const body = renderHandoverBody({
      headerLine,
      repos: sourceRepos,
      suggestedRow: suggestedById.get(targetId),
      noteText,
      override: overrideObj,
      consistencyWarnings,
    });

    // Enqueue the handover message in the target agent's pending queue rather
    // than sending a direct Matrix DM. This avoids the race where the DM arrives
    // before the agent's Matrix client has finished its first sync after being
    // enabled; the agent drains the queue within 5 s of startup, by which time
    // the client is always ready. The orchestrator owns the queue (#185 Phase 2)
    // — routing through it keeps the queue single-writer and reaches the agent
    // even when its volume is isolated.
    try {
      const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
      const r = await fetch(
        `${orchestratorUrl}/internal/agents/${encodeURIComponent(targetId)}/enqueue-pending`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kind: 'handover-dm', roomId, body, enqueuedAt: new Date().toISOString() }),
        },
      );
      if (!r.ok) throw new Error(`orchestrator HTTP ${r.status}`);
      results.push({
        agentId: targetId,
        ok: true,
        roomId,
        eventId: null,
        displayName: refreshedCfg.displayName || targetId,
        consistencyWarnings,
      });
    } catch (err) {
      results.push({ agentId: targetId, ok: false, stage: 'send', error: `Could not enqueue handover: ${err.message}` });
    }
  }

  const okCount = results.filter((r) => r.ok).length;
  // Always 200 — per-target outcomes are in `results`. The UI shows the
  // breakdown; treating "0 of N succeeded" as a transport-level failure
  // would hide that detail behind apiCall's generic error path.
  res.status(200).json({
    source: { agentId: id, displayName: sourceLabel, bpId: sourceCfg.bpId || null },
    sent: okCount,
    total: results.length,
    override: overrideObj,
    gitStatus,
    results,
  });
});

/* ─── BP stub sync ──────────────────────────────────────────────────── */

app.post('/api/agents/:id/sync-bps', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/orchestrators/${encodeURIComponent(id)}/sync-bps?force=1`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/agents/:teamId/members', heavyLimiter, async (req, res) => {
  const { teamId } = req.params;
  if (!AGENT_ID_RE.test(teamId)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE already excludes traversal segments,
  // but CodeQL doesn't always recognise the regex as a sanitiser when the
  // value travels through a destructure first. Re-check with path.relative.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const teamDir = path.resolve(agentsBaseDir, teamId);
  const rel = path.relative(agentsBaseDir, teamDir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  if (!fs.existsSync(teamDir)) {
    return res.status(404).json({ error: 'Team not found' });
  }
  // Body is optional. When present it carries the override / config fields
  // the orchestrator's addTeamMember now accepts: { id, displayName,
  // systemPromptOverride, skillsOverride, sessionPolicy, triggers }.
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamId)}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(req.body || {}),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/agents', heavyLimiter, async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, briefingsPath, teamId } = req.body;
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  // Teams may be created without a default prompt — members can carry their
  // own per-role prompts, and the orchestrator stores an empty template.
  if (!systemPrompt && role !== 'orchestrator' && role !== 'team') {
    return res.status(400).json({ error: 'systemPrompt is required for non-orchestrator agents' });
  }
  if (!loadEnvironment(environmentId)) {
    return res.status(400).json({ error: `Working Environment '${environmentId}' not found` });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, briefingsPath, teamId }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    // Eagerly provision the DM room for the freshly-created agent so it is
    // ready before the first message (#184). Best-effort — never fails create.
    if (data.enabled !== false) await preCreateAgentDmRoom(id, 'create');
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/agents/:id', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      return res.status(resp.status).json(data);
    }
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Agent Clone ───────────────────────────────────────────────────── */

// Optional body field:
//   - parentTeamId — graft the clone into an existing team as a member,
//     mirroring /api/agents/import's team-assignment field. Absent → the
//     clone is created as a standalone agent, even when the source itself
//     is a team member.
// On id conflict the response is 409 with `{ code: 'id-conflict', agentId }`,
// same shape as /api/agents/import, so the UI can prompt for a new id inline.
app.post('/api/agents/:id/clone', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const { newId, newDisplayName, parentTeamId } = req.body || {};
  if (!newId || !newDisplayName) {
    return res.status(400).json({ error: 'newId and newDisplayName required' });
  }
  if (!AGENT_ID_RE.test(newId)) {
    return res.status(400).json({ error: `Invalid agent id '${newId}' (allowed: letters, digits, _ - .)` });
  }
  if (!fs.existsSync(path.join(AGENTS_DIR, id))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  if (parentTeamId != null && !AGENT_ID_RE.test(parentTeamId)) {
    return res.status(400).json({ error: 'Invalid parentTeamId' });
  }
  // Containment check — path.resolve + path.relative is the in-flow
  // sanitiser pattern CodeQL recognises for js/path-injection.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const targetDir = path.resolve(agentsBaseDir, newId);
  const rel = path.relative(agentsBaseDir, targetDir);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
    return res.status(400).json({ error: 'Invalid agent id path' });
  }
  if (fs.existsSync(targetDir)) {
    return res.status(409).json({
      error: `Agent '${newId}' already exists — choose a different id.`,
      code: 'id-conflict',
      agentId: newId,
    });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId, newDisplayName, parentTeamId: parentTeamId || undefined }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── Agent Export / Import ─────────────────────────────────────────── */

// Inline path-containment check — CodeQL recognises includes('..') +
// startsWith(rootPrefix) as a path-injection sanitiser when applied in the
// same function as the sink. Allowed roots are WORKSPACE (agent files) and
// /tmp (scratch dirs from fs.mkdtempSync). Refuses anything else.
function copyDirRecursive(src, dst) {
  if (typeof src !== 'string' || src.includes('..') ||
      !(src.startsWith(WORKSPACE + path.sep) || src.startsWith('/tmp' + path.sep))) {
    throw new Error(`copyDirRecursive: refusing src outside allowed roots: ${src}`);
  }
  if (typeof dst !== 'string' || dst.includes('..') ||
      !(dst.startsWith(WORKSPACE + path.sep) || dst.startsWith('/tmp' + path.sep))) {
    throw new Error(`copyDirRecursive: refusing dst outside allowed roots: ${dst}`);
  }
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isSymbolicLink()) continue; // skip symlinks for safety
    if (entry.isDirectory()) {
      copyDirRecursive(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

// Streams a ZIP archive of the agent workspace + manifest.json.
// Excludes the sessions/ directory (conversation history and container logs).
app.get('/api/agents/:id/export', heavyLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  // Containment check: AGENT_ID_RE excludes traversal segments, but CodeQL's
  // path-injection query doesn't always follow the regex through a destructure.
  // The path.resolve + path.relative pattern is recognised in-flow.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDirPath = path.resolve(agentsBaseDir, id);
  const rel = path.relative(agentsBaseDir, agentDirPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  const cfg = readJsonFile(path.join(agentDirPath, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });

  // Best-effort: resolve orchestrator image info via Podman socket
  let imageInfo = { name: 'orchestrator', tag: 'latest', digest: null };
  try {
    const listResult = await podmanRequest('GET', '/containers/json?all=true');
    if (listResult.status === 200 && Array.isArray(listResult.body)) {
      const orch = listResult.body.find(c =>
        Array.isArray(c.Names) && c.Names.some(n => /orchestrator/.test(n))
      );
      if (orch) {
        const nameTag = orch.Image || '';
        const atIdx = nameTag.indexOf('@');
        const tagPart = atIdx >= 0 ? nameTag.slice(0, atIdx) : nameTag;
        const colonIdx = tagPart.lastIndexOf(':');
        imageInfo = {
          name: colonIdx >= 0 ? tagPart.slice(0, colonIdx) : tagPart,
          tag: colonIdx >= 0 ? tagPart.slice(colonIdx + 1) : 'latest',
          digest: atIdx >= 0 ? nameTag.slice(atIdx + 1) : (orch.ImageID || null),
        };
      }
    }
  } catch { /* Podman unavailable — proceed without image info */ }

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'aee-export-'));
  // zipDir is a sibling scratch dir (so `zip -r` doesn't try to archive its
  // own output). Neither tmpDir nor zipDir carries any user-controlled path
  // segment, which keeps the filesystem sinks below clear of req-derived data.
  const zipDir = fs.mkdtempSync(path.join('/tmp', 'aee-zip-'));
  const zipPath = path.join(zipDir, 'export.zip');
  try {
    // Copy workspace excluding sessions/ (conversation history, logs).
    // copyDirRecursive carries an inline path-containment check; using it
    // for both files and directories keeps every fs sink behind that gate.
    const workspaceDir = path.join(tmpDir, 'workspace');
    copyDirRecursive(agentDirPath, workspaceDir);
    try { fs.rmSync(path.join(workspaceDir, 'sessions'), { recursive: true, force: true }); } catch { /* noop */ }

    // Agent-specific env vars (sensitive Matrix creds are excluded)
    const envVars = { AGENT_ID: id };
    if (cfg.modelOverride) envVars.AGENT_DEFAULT_MODEL = cfg.modelOverride;

    fs.writeFileSync(path.join(tmpDir, 'manifest.json'), JSON.stringify({
      version: '1',
      exportedAt: new Date().toISOString(),
      agentId: id,
      image: imageInfo,
      envVars,
    }, null, 2));

    const zipResult = spawnSync('zip', ['-r', zipPath, '.'], { cwd: tmpDir });
    if (zipResult.status !== 0) {
      throw new Error(`zip exited ${zipResult.status}: ${(zipResult.stderr || '').toString().trim()}`);
    }

    const stat = fs.statSync(zipPath);
    res.setHeader('Content-Disposition', `attachment; filename="agent-${id}-export.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(zipPath);
    stream.on('close', () => {
      try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ }
      try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    });
    stream.pipe(res);
  } catch (err) {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
    try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ }
    console.error(`[API] Export failed for ${id}: ${err.message}`);
    res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

// Accepts a ZIP (field: "file") produced by GET /api/agents/:id/export.
// Creates a new agent workspace from the ZIP contents.
// Returns 409 if an agent with the same ID already exists.
const _importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 * 1024 },
});

// Optional form fields (multipart text parts, alongside `file`):
//   - newId        — assign a different id (e.g. when the exported id is taken).
//   - parentTeamId — graft the imported agent into an existing team as a member.
// On id conflict the response is 409 with `{ code: 'id-conflict', agentId }`
// so the UI can prompt for a new id and resubmit.
app.post('/api/agents/import', heavyLimiter, _importUpload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (field name: file)' });

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'aee-import-'));
  const zipPath = path.join(tmpDir, 'upload.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  let stagingDir = null;
  try {
    fs.writeFileSync(zipPath, req.file.buffer);
    fs.mkdirSync(extractDir);

    const unzipResult = spawnSync('unzip', ['-o', zipPath, '-d', extractDir]);
    if (unzipResult.status !== 0) {
      return res.status(400).json({ error: 'Could not extract ZIP — ensure the file is a valid agent export' });
    }

    // Zip-slip protection: verify all extracted paths stay within extractDir
    const realExtractDir = fs.realpathSync(extractDir);
    function checkExtractedPaths(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          if (!real.startsWith(realExtractDir + path.sep) && real !== realExtractDir) {
            throw new Error(`Unsafe path in ZIP: ${real}`);
          }
        } catch (e) {
          if (e.message && e.message.startsWith('Unsafe')) throw e;
          // realpathSync on a dangling symlink throws ENOENT — skip safely
        }
        if (entry.isDirectory()) checkExtractedPaths(full);
      }
    }
    checkExtractedPaths(extractDir);

    // Validate manifest
    const manifestPath = path.join(extractDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      return res.status(400).json({ error: 'Missing manifest.json — not a valid agent export' });
    }
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch {
      return res.status(400).json({ error: 'Corrupt manifest.json' });
    }
    const exportedId = typeof manifest.agentId === 'string' ? manifest.agentId : null;
    if (!exportedId || !AGENT_ID_RE.test(exportedId)) {
      return res.status(400).json({ error: 'Invalid or missing agentId in manifest' });
    }

    // Resolve the target id — operator-supplied `newId` wins over the export's.
    const newIdRaw = typeof req.body.newId === 'string' ? req.body.newId.trim() : '';
    if (newIdRaw && !AGENT_ID_RE.test(newIdRaw)) {
      return res.status(400).json({ error: `Invalid agent id '${newIdRaw}' (allowed: letters, digits, _ - .)` });
    }
    const agentId = newIdRaw || exportedId;
    const parentTeamId = typeof req.body.parentTeamId === 'string' && req.body.parentTeamId.trim()
      ? req.body.parentTeamId.trim() : null;

    // Containment check — path.resolve + path.relative is the in-flow
    // sanitiser pattern CodeQL recognises for js/path-injection.
    const agentsBaseDir = path.resolve(AGENTS_DIR);
    const targetDir = path.resolve(agentsBaseDir, agentId);
    const rel = path.relative(agentsBaseDir, targetDir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
      return res.status(400).json({ error: 'Invalid agent id path' });
    }

    // Conflict check — structured so the UI can offer a new id.
    if (fs.existsSync(targetDir)) {
      return res.status(409).json({
        error: `Agent '${agentId}' already exists — choose a different id to import it under.`,
        code: 'id-conflict',
        agentId,
      });
    }

    // Locate the exported workspace.
    const workspaceDir = path.join(extractDir, 'workspace');
    if (!fs.existsSync(workspaceDir)) {
      return res.status(400).json({ error: 'Missing workspace/ directory in ZIP' });
    }

    // Stage the workspace on the shared volume so the orchestrator can read it,
    // then hand off provisioning (fresh Matrix identity, role/team wiring,
    // process spawn) to the orchestrator. The orchestrator owns the agent map
    // and Matrix admin client; the admin-console only prepares the files.
    const stagingRoot = path.join(WORKSPACE, '.import-staging');
    fs.mkdirSync(stagingRoot, { recursive: true });
    stagingDir = path.join(stagingRoot, crypto.randomUUID());
    copyDirRecursive(workspaceDir, stagingDir);

    const orchResp = await fetch(`${ORCH_URL()}/internal/agents/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stagingDir, agentId, parentTeamId }),
    });
    const data = await orchResp.json().catch(() => ({}));
    if (!orchResp.ok) {
      // Orchestrator cleans staging on success only; remove it on failure here.
      try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* noop */ }
      return res.status(orchResp.status).json(data.error ? data : { error: `Import failed (orchestrator ${orchResp.status})` });
    }

    const img = manifest.image || {};
    console.log(`[API] Imported agent '${exportedId}' → '${agentId}'${parentTeamId ? ` (team=${parentTeamId})` : ''}: image=${img.name}:${img.tag} digest=${img.digest || 'n/a'} exportedAt=${manifest.exportedAt}`);

    res.status(201).json({
      ok: true,
      agentId: data.id || agentId,
      role: data.role || null,
      parentTeamId: data.parentTeamId || null,
      image: manifest.image || null,
    });
  } catch (err) {
    if (stagingDir) { try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch { /* noop */ } }
    console.error(`[API] Import failed: ${err.message}`);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

/* ─── Agent Prompt ──────────────────────────────────────────────────── */

app.get('/api/agents/:id/prompt', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const promptPath = path.join(AGENTS_DIR, id, 'AGENT-PROMPT.md');
  if (!fs.existsSync(path.join(AGENTS_DIR, id))) return res.status(404).json({ error: 'Agent not found' });
  let content = '';
  try { content = fs.readFileSync(promptPath, 'utf8'); } catch { /* file may not exist yet */ }
  res.json({ content });
});

app.put('/api/agents/:id/prompt', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  const promptPath = path.join(agentDir, 'AGENT-PROMPT.md');
  const tmp = promptPath + '.tmp';
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, promptPath);
  // Mirror exactly what we wrote into an isolated agent's volume (#185 item 5).
  // Only AGENT-PROMPT.md — this route does not rebuild CLAUDE.md, so copying the
  // pool's (stale) CLAUDE.md would be wrong.
  notifyAgentReseed(id, ['AGENT-PROMPT.md']);
  res.json({ ok: true });
});

/* ─── Agent Model Selection ─────────────────────────────────────────── */

// Resolve everything the chat UI needs to render the model picker for an
// agent: the endpoint+catalog reachable through its working environment, the
// environment-level default, and the agent-level override (if any).
app.get('/api/agents/:id/model-options', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
  const endpoint = env?.llmEndpointId
    ? listLlmEndpoints().find(e => e.id === env.llmEndpointId)
    : null;
  res.json({
    endpointId:    endpoint?.id || null,
    endpointName:  endpoint?.name || null,
    // env-level pin wins; otherwise show whatever the registry default is so
    // the picker label matches what the agent will actually use.
    defaultModelId: env?.defaultModelId || endpoint?.defaultModelId || null,
    override:      cfg.modelOverride || null,
    models:        endpoint?.models || [],
  });
});

app.patch('/api/agents/:id/model', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const { modelId } = req.body || {};

  // null / "" / undefined → clear override (fall back to env default)
  if (modelId === null || modelId === undefined || modelId === '') {
    if ('modelOverride' in cfg) {
      delete cfg.modelOverride;
      writeJsonAtomic(cfgPath, cfg);
    }
    return res.json({ override: null });
  }

  if (typeof modelId !== 'string') {
    return res.status(400).json({ error: 'modelId must be a string or null' });
  }

  // Validate against the environment's endpoint catalog so an agent can't be
  // pinned to a model the proxy doesn't actually serve.
  const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
  if (!env?.llmEndpointId) {
    return res.status(400).json({ error: 'Environment has no LLM endpoint bound — set one before overriding the model' });
  }
  const endpoint = listLlmEndpoints().find(e => e.id === env.llmEndpointId);
  if (!endpoint) {
    return res.status(400).json({ error: `LLM endpoint '${env.llmEndpointId}' not found` });
  }
  if (!(endpoint.models || []).some(m => m.id === modelId)) {
    return res.status(400).json({ error: `Model '${modelId}' is not in endpoint '${endpoint.id}' catalog` });
  }

  cfg.modelOverride = modelId;
  writeJsonAtomic(cfgPath, cfg);
  res.json({ override: modelId });
});

/* ─── Agent Triggers ────────────────────────────────────────────────── */

app.get('/api/agents/:id/triggers', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []); // canonical copy (#185)
  res.json(Array.isArray(triggers) ? triggers : []);
});

// Read-only proxy to the orchestrator's allowlisted script content. Used by
// the trigger UI to render baked-in helper scripts (e.g. multi-agent-bid)
// inline so operators can see what the preCheckScript actually does.
const SCRIPT_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;
app.get('/api/scripts/:name', apiLimiter, async (req, res) => {
  const { name } = req.params;
  if (!SCRIPT_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'invalid script name' });
  }
  try {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    const upstream = await fetch(`${orchestratorUrl}/internal/scripts/${encodeURIComponent(name)}`);
    const body = await upstream.text();
    res.status(upstream.status).type(upstream.headers.get('content-type') || 'application/json').send(body);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
});

// #185 Phase 2: the orchestrator owns the canonical triggers.json (on the
// control plane when the agent's volume is isolated). Admin CRUD computes the
// new full array and PUTs it through the orchestrator, which persists it and
// signals the agent (SIGUSR2) to re-pull. We read the current array via
// controlOrAgentPath so it works on both the shared and isolated layouts.
async function putTriggers(agentId, triggers) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const r = await fetch(
    `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/triggers`,
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ triggers }),
    },
  );
  if (!r.ok) throw new Error(`orchestrator HTTP ${r.status}`);
}

app.post('/api/agents/:id/triggers', apiLimiter, async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const newTrigger = { id: `t${Date.now()}`, ...req.body };
  if (newTrigger.type === 'github-event') {
    const now = new Date().toISOString();
    if (!newTrigger.createdAt) newTrigger.createdAt = now;
    if (!newTrigger.activatedAt) newTrigger.activatedAt = now;
  }
  triggers.push(newTrigger);
  try {
    await putTriggers(id, triggers);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  res.status(201).json(newTrigger);
});

app.put('/api/agents/:id/triggers/:triggerId', apiLimiter, async (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const idx = triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) return res.status(404).json({ error: 'Trigger not found' });
  const prev = triggers[idx];
  const merged = { ...prev, ...req.body, id: triggerId };
  if (merged.type === 'github-event') {
    const now = new Date().toISOString();
    // Refresh the activation horizon on a disable→enable flip so a
    // re-enabled trigger drops the backlog that accrued while it was off.
    if (prev.enabled === false && merged.enabled !== false) merged.activatedAt = now;
    // Backfill the stamps on any edit of a legacy unstamped trigger. Its
    // horizon was already drifting with the triggers.json mtime; stamping it
    // now makes it stable for all subsequent edits (#320 review follow-up).
    if (!merged.createdAt) merged.createdAt = now;
    if (!merged.activatedAt) merged.activatedAt = now;
  }
  triggers[idx] = merged;
  try {
    await putTriggers(id, triggers);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  res.json(triggers[idx]);
});

app.delete('/api/agents/:id/triggers/:triggerId', apiLimiter, async (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const triggers = Array.isArray(cur) ? cur : [];
  const filtered = triggers.filter(t => t.id !== triggerId);
  try {
    await putTriggers(id, filtered);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  res.status(204).end();
});

/* ─── Trigger emits (Process Canvas #328) ───────────────────────────────
 * A trigger's `emits` array declares the labels its run is expected to set —
 * the outbound edges of the orchestration graph. We never author it silently:
 * the suggestions endpoint heuristically *derives* a draft from the prompt
 * prose (the trigger's own prompt folded with the agent's system prompt), the
 * operator confirms/corrects it, and the emits endpoint persists the confirmed
 * set through the same single-writer trigger path. */

function readAgentSystemPrompt(id) {
  try {
    const agentsRoot = path.resolve(AGENTS_DIR);
    const promptPath = path.resolve(agentsRoot, id, 'AGENT-PROMPT.md');
    if (promptPath !== agentsRoot && !promptPath.startsWith(agentsRoot + path.sep)) return '';
    return fs.readFileSync(promptPath, 'utf8');
  } catch { return ''; }
}

// Heuristic draft only — advisory, never persisted by this call.
app.get('/api/agents/:id/triggers/:triggerId/emit-suggestions', (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentsRoot = path.resolve(AGENTS_DIR) + path.sep;
  const agentDir = path.resolve(AGENTS_DIR, id);
  if (!(agentDir + path.sep).startsWith(agentsRoot)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const trigger = (Array.isArray(triggers) ? triggers : []).find(t => t.id === triggerId);
  if (!trigger) return res.status(404).json({ error: 'Trigger not found' });
  const suggestions = deriveEmitsForTrigger(trigger, readAgentSystemPrompt(id));
  res.json({ current: Array.isArray(trigger.emits) ? trigger.emits : [], suggestions });
});

// Persist the operator-confirmed emits set onto the trigger.
app.put('/api/agents/:id/triggers/:triggerId/emits', apiLimiter, async (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(path.join(AGENTS_DIR, id))) return res.status(404).json({ error: 'Agent not found' });
  const { emits } = req.body || {};
  if (!Array.isArray(emits) || emits.some(e => typeof e !== 'string' || !e.trim())) {
    return res.status(400).json({ error: 'emits must be an array of non-empty strings' });
  }
  // Normalise: trim, drop blanks, de-duplicate while preserving order.
  const clean = [...new Set(emits.map(e => e.trim()))];
  const cur = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
  const list = Array.isArray(cur) ? cur : [];
  const idx = list.findIndex(t => t.id === triggerId);
  if (idx === -1) return res.status(404).json({ error: 'Trigger not found' });
  list[idx] = { ...list[idx], emits: clean };
  try {
    await putTriggers(id, list);
  } catch (err) {
    return res.status(502).json({ error: `Could not save triggers: ${err.message}` });
  }
  res.json(list[idx]);
});

/* ─── Process graph (Process Canvas #329) ───────────────────────────────
 * Aggregates agents (or role templates) + their triggers into the
 * orchestration graph the canvas renders, in one call. Edge wiring is
 * deterministic from each trigger's effective `emits` set:
 *   - live level (default, or ?team=<id> to scope to one team): uses the
 *     persisted `emits` only — labels are already concrete in triggers.json.
 *   - template level (?templates=1 or ?templates=a,b): reads the role-template
 *     catalog, leaves `{{var}}` tokens raw, and (unless ?derive=0) falls back to
 *     the #328 heuristic so the blueprint shows wiring before emits are set. */

function effectiveTriggers(triggers, { derive, systemPrompt }) {
  return (Array.isArray(triggers) ? triggers : []).map(t => {
    if (Array.isArray(t.emits)) return t; // operator-confirmed — authoritative
    if (!derive) return { ...t, emits: [] };
    const sug = deriveEmitsForTrigger(t, systemPrompt);
    return { ...t, emits: sug.map(s => s.label), emitsDerived: sug.length > 0 };
  });
}

function truthyParam(v) { return v === '1' || v === 'true' || v === ''; }

app.get('/api/process/graph', (req, res) => {
  const templatesParam = req.query.templates;

  // Template-level blueprint graph.
  if (templatesParam !== undefined) {
    const derive = req.query.derive !== undefined
      ? truthyParam(String(req.query.derive)) : true;
    const ids = truthyParam(String(templatesParam))
      ? listAgentTemplateIds()
      : String(templatesParam).split(',').map(s => s.trim()).filter(Boolean);
    const agents = [];
    for (const id of ids) {
      const t = loadAgentTemplate(id);
      if (!t) continue;
      const triggers = effectiveTriggers(
        (t.triggers || []).map(tr => ({
          id: tr.id, type: tr.type, events: tr.events, labelFilter: tr.labelFilter,
          cron: tr.cron, at: tr.at, enabled: tr.enabled,
          emits: tr.emits, prompt: tr.promptTemplate,
        })),
        { derive, systemPrompt: t.promptTemplate || '' },
      );
      agents.push({
        id: t.id, role: 'template', displayName: t.displayName || t.id,
        sessionPolicy: t.sessionPolicy || 'persistent', environmentId: null, triggers,
        github: t.github || null, channels: Array.isArray(t.channels) ? t.channels : [],
      });
    }
    return res.json({ level: 'template', team: null, ...buildProcessGraph(agents) });
  }

  // Live graph — persisted emits only (the hybrid default: deterministic, no
  // silent derivation). Optionally scoped to one team.
  const team = typeof req.query.team === 'string' && req.query.team.trim()
    ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });
  const derive = req.query.derive !== undefined && truthyParam(String(req.query.derive));

  const agents = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue; // template holder — no triggers of its own
    if (team && cfg.parentTeamId !== team) continue;
    const raw = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    const triggers = effectiveTriggers(raw, {
      derive, systemPrompt: derive ? readAgentSystemPrompt(id) : '',
    });
    agents.push({
      id, role, displayName: cfg.displayName || id,
      sessionPolicy: cfg.sessionPolicy || 'persistent',
      environmentId: cfg.environmentId || null, triggers,
      github: cfg.github || null, channels: Array.isArray(cfg.channels) ? cfg.channels : [],
    });
  }
  res.json({ level: 'live', team, ...buildProcessGraph(agents) });
});

// Build a graph from an imported bundle (no persistence) so the canvas can
// render it as a blueprint (#334). Reuses the same pure builder.
app.post('/api/process/graph', (req, res) => {
  const raw = req.body && req.body.processTemplate;
  // Drafts (#345) may be empty works-in-progress.
  const v = validateProcessTemplate(raw, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
  // Map legacy pr-review roles (#347) onto the #380 channel ports so old drafts render.
  const bundle = normalizeLegacyReview(raw);
  const agents = bundle.roles.map(r => ({
    id: r.id, role: 'template', displayName: r.displayName || r.id,
    sessionPolicy: r.sessionPolicy || 'persistent',
    // Agent-level emitted labels (#414 canonicalises emits to agent level) —
    // without them a bundle's label hand-offs render as human-set edges.
    emits: Array.isArray(r.emits) ? r.emits : [],
    // GitHub artifact ports (#380) drive the badge/ports + channel edges.
    github: r.github || null, channels: Array.isArray(r.channels) ? r.channels : [],
    triggers: (r.triggers || []).map(t => ({ ...t, emits: Array.isArray(t.emits) ? t.emits : [] })),
  }));
  res.json({ level: 'template', team: null, imported: true, name: bundle.name, ...buildProcessGraph(agents) });
});

/* ─── Unified orchestration graph (Unified Orchestration #362 / #365) ───────
 * One graph over BOTH orchestration concepts, via the pure builder in
 * unified-graph.js. The `/flows` source switcher picks the source:
 *   - default (live):  live agents → process-style nodes (label/timer/review/
 *                      event edges). Optional ?team=<id> scope. Persisted emits
 *                      only (no silent derivation, unless ?derive=1).
 *   - ?workspace=<path>: BP source — fetch briefings from bp-explorer and map
 *                      via briefingsToUnified (dependency + artifact edges; BP
 *                      status dropped). Read-only projection over brief.md.
 * Both shapes are { unifiedFlowVersion, source, nodes, edges, gates, labels, lints }. */
app.get('/api/flows/graph', async (req, res) => {
  // Template-level blueprint (read-only) — the role-template catalog as a
  // unified graph, so the rich viewer can render it like any other flow.
  if (req.query.templates !== undefined) {
    const derive = req.query.derive !== undefined ? truthyParam(String(req.query.derive)) : true;
    const ids = truthyParam(String(req.query.templates))
      ? listAgentTemplateIds()
      : String(req.query.templates).split(',').map(s => s.trim()).filter(Boolean);
    const tnodes = [];
    for (const id of ids) {
      const t = loadAgentTemplate(id);
      if (!t) continue;
      const triggers = effectiveTriggers(
        (t.triggers || []).map(tr => ({
          id: tr.id, type: tr.type, events: tr.events, labelFilter: tr.labelFilter,
          cron: tr.cron, at: tr.at, enabled: tr.enabled,
          emits: tr.emits, prompt: tr.promptTemplate,
        })),
        { derive, systemPrompt: t.promptTemplate || '' },
      );
      tnodes.push({
        id: t.id, role: 'template', displayName: t.displayName || t.id,
        sessionPolicy: t.sessionPolicy || 'persistent', environmentId: null, triggers,
        inputs: [], outputs: [], dependsOn: [], content: t.promptTemplate || '',
        github: t.github || null, channels: Array.isArray(t.channels) ? t.channels : [],
      });
    }
    return res.json({ unifiedFlowVersion: 1, source: 'templates', level: 'template', ...buildUnifiedGraph(tnodes) });
  }

  // BP source — read-only projection of a briefings directory.
  if (typeof req.query.workspace === 'string' && req.query.workspace.trim()) {
    const workspace = req.query.workspace.trim();
    try {
      const url = `${BP_EXPLORER_URL}/api/briefings?workspace=${encodeURIComponent(workspace)}`;
      const upstream = await fetch(url);
      if (!upstream.ok) {
        return res.status(502).json({ error: `BP-Explorer returned ${upstream.status}` });
      }
      const bps = await upstream.json();
      const flow = briefingsToUnified(bps, { name: workspace });
      return res.json({
        unifiedFlowVersion: flow.unifiedFlowVersion, source: 'briefings', workspace,
        ...buildUnifiedGraph(flow.nodes, flow.edges),
      });
    } catch (err) {
      return res.status(502).json({ error: `BP-Explorer unreachable: ${err.message}` });
    }
  }

  // Live source — agents as unified nodes (data-flow ports empty for now).
  const team = typeof req.query.team === 'string' && req.query.team.trim()
    ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });
  const derive = req.query.derive !== undefined && truthyParam(String(req.query.derive));

  const nodes = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue; // template holder — no triggers of its own
    if (team && cfg.parentTeamId !== team) continue;
    const raw = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    const triggers = effectiveTriggers(raw, {
      derive, systemPrompt: derive ? readAgentSystemPrompt(id) : '',
    });
    // Data-flow ports persisted at materialise time (#379) so the live graph
    // of an imported team still renders its dependency/artifact edges.
    const df = cfg.dataFlow && typeof cfg.dataFlow === 'object' ? cfg.dataFlow : {};
    nodes.push({
      id, role, displayName: cfg.displayName || id,
      sessionPolicy: cfg.sessionPolicy || 'persistent',
      environmentId: cfg.environmentId || null, triggers,
      emits: Array.isArray(cfg.emits) ? cfg.emits : [], // agent-level label hand-offs
      inputs: Array.isArray(df.inputs) ? df.inputs : [],
      outputs: Array.isArray(df.outputs) ? df.outputs : [],
      dependsOn: Array.isArray(df.dependsOn) ? df.dependsOn : [],
      parent: typeof cfg.parentMemberId === 'string' ? cfg.parentMemberId : null,
      content: readAgentSystemPrompt(id), // expandable prompt in the unified viewer
      stage: typeof cfg.stage === 'string' ? cfg.stage : '',
      // GitHub artifact ports (#380): produce flags + consumed channels.
      github: cfg.github || null,
      channels: Array.isArray(cfg.channels) ? cfg.channels : [],
    });
  }
  // Ordered stage names persisted on the team agent (#stage-order) drive the
  // client's layered layout, so a materialised draft keeps its stage columns.
  let stages = [];
  if (team) {
    const teamCfg = readJsonFile(path.join(AGENTS_DIR, team, 'config.json'), {});
    if (Array.isArray(teamCfg.stages)) stages = teamCfg.stages.filter(s => typeof s === 'string');
  }
  res.json({ unifiedFlowVersion: 1, source: 'live', team, stages, ...buildUnifiedGraph(nodes) });
});

/* Derive a unified graph from a draft/imported bundle (#367) — the editable
 * counterpart of POST /api/process/graph. Maps the process-template bundle
 * (roles may carry inputs/outputs/dependsOn) through the unified model so the
 * draft editor renders label + dependency + artifact edges and unified lints. */
app.post('/api/flows/graph', (req, res) => {
  const raw = req.body && req.body.processTemplate;
  const v = validateProcessTemplate(raw, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
  // Map legacy pr-review roles (#347) onto the #380 channel ports so old drafts render.
  const bundle = normalizeLegacyReview(raw);
  const flow = processTemplateToUnified(bundle);
  res.json({
    unifiedFlowVersion: flow.unifiedFlowVersion, source: 'draft', imported: true, name: bundle.name,
    // Ordered stage names drive the layered layout on the client (#stage-order).
    stages: Array.isArray(bundle.stages) ? bundle.stages.filter(s => typeof s === 'string') : [],
    ...buildUnifiedGraph(flow.nodes, flow.edges),
  });
});

/* ─── Process template bundle (export, #334) ────────────────────────────
 * GET /api/process/template?team=<id> | ?templates=1
 * Returns a portable bundle (roles + prompts + triggers incl emits, gates,
 * labels) — the Process Canvas export / import format. */
app.get('/api/process/template', (req, res) => {
  const templatesParam = req.query.templates;
  const roleEntries = [];   // for the bundle (prompt + full triggers)
  const graphAgents = [];   // for gates/labels via buildProcessGraph

  if (templatesParam !== undefined) {
    const ids = truthyParam(String(templatesParam))
      ? listAgentTemplateIds()
      : String(templatesParam).split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      const t = loadAgentTemplate(id);
      if (!t) continue;
      const triggers = (t.triggers || []).map(tr => ({
        ...tr, prompt: tr.promptTemplate,
        emits: Array.isArray(tr.emits)
          ? tr.emits
          : deriveEmitsForTrigger({ promptTemplate: tr.promptTemplate }, t.promptTemplate || '').map(s => s.label),
      }));
      roleEntries.push({
        id: t.id, displayName: t.displayName || t.id, role: 'team-member',
        sessionPolicy: t.sessionPolicy || 'persistent', systemPrompt: t.promptTemplate || '', triggers,
      });
      graphAgents.push({ id: t.id, role: 'template', triggers });
    }
    const g = buildProcessGraph(graphAgents);
    return res.json(buildProcessTemplate({
      name: 'role-templates', level: 'template', roles: roleEntries, gates: g.gates, labels: g.labels,
    }));
  }

  const team = typeof req.query.team === 'string' && req.query.team.trim() ? req.query.team.trim() : null;
  if (team && !AGENT_ID_RE.test(team)) return res.status(400).json({ error: 'Invalid team id' });
  let teamName = team;
  let teamStages = [];
  if (team) {
    const teamCfg = readJsonFile(path.join(AGENTS_DIR, team, 'config.json'), null);
    if (teamCfg?.displayName) teamName = teamCfg.displayName;
    if (Array.isArray(teamCfg?.stages)) teamStages = teamCfg.stages.filter(s => typeof s === 'string');
  }
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    const role = cfg.role || 'agent';
    if (role === 'team') continue;
    if (team && cfg.parentTeamId !== team) continue;
    const triggers = readJsonFile(controlOrAgentPath(id, 'triggers.json'), []);
    const tlist = Array.isArray(triggers) ? triggers : [];
    // Effective prompt the agent actually runs (rendered AGENT-PROMPT.md),
    // falling back to the config override.
    const systemPrompt = readAgentSystemPrompt(id) || cfg.systemPrompt || '';
    roleEntries.push({
      id, displayName: cfg.displayName || id, role,
      sessionPolicy: cfg.sessionPolicy || 'persistent', systemPrompt, triggers: tlist,
      ...(Array.isArray(cfg.emits) && cfg.emits.length ? { emits: cfg.emits } : {}),
      ...(typeof cfg.stage === 'string' && cfg.stage ? { stage: cfg.stage } : {}),
    });
    graphAgents.push({ id, role, triggers: tlist, emits: cfg.emits });
  }
  const g = buildProcessGraph(graphAgents);
  res.json(buildProcessTemplate({
    name: teamName || 'process', level: 'live', teamId: team || undefined,
    roles: roleEntries, gates: g.gates, labels: g.labels, stages: teamStages,
  }));
});

/* ─── Flow-Weaver (#421) ────────────────────────────────────────────────
 * Deterministic wiring engine: ordered stages + selected roles → a complete,
 * gap-free process-template bundle (pure builder in flow-weaver.js). Roles are
 * referenced by catalog template id ({ templateId }) or supplied inline
 * ({ inline: true, ... } — #423). Returns { bundle, notes } where notes lists
 * every applied gap rule so the wizard can explain the compensation. */
app.post('/api/process/weave', (req, res) => {
  const body = req.body || {};
  const stagesIn = Array.isArray(body.stages) ? body.stages : null;
  if (!stagesIn) return res.status(400).json({ error: 'stages must be an array' });
  const stages = [];
  for (const s of stagesIn) {
    const roles = [];
    for (const r of (s && Array.isArray(s.roles) ? s.roles : [])) {
      if (r && typeof r.templateId === 'string') {
        const t = loadAgentTemplate(r.templateId);
        if (!t) return res.status(400).json({ error: `Unknown role template: ${r.templateId}` });
        roles.push(t);
      } else if (r && r.inline === true) {
        roles.push(r);
      } else {
        return res.status(400).json({ error: 'each role needs { templateId } or { inline: true, ... }' });
      }
    }
    stages.push({ name: s && s.name, prefix: s && s.prefix, roles });
  }
  try {
    const { bundle, notes } = weaveProcess({
      name: typeof body.name === 'string' && body.name.trim() ? body.name : 'Woven process',
      stages,
      options: body.options,
    });
    res.json({ bundle, notes });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ─── Process-template registry (#419) ──────────────────────────────────
 * Curated whole-process templates — the process-level analogue of the
 * agent-template catalog. Seeded from orchestrator/skill-pool/process-templates/
 * into the pool volume via `make seed-process-templates`; read-only here. */
const PROCESS_TEMPLATES_DIR = path.join(POOL_DIR, 'process-templates');

app.get('/api/process-templates', (_req, res) => {
  res.json({ templates: listProcessTemplates(PROCESS_TEMPLATES_DIR) });
});

app.get('/api/process-templates/:id', (req, res) => {
  const b = loadProcessTemplate(PROCESS_TEMPLATES_DIR, req.params.id);
  if (!b) return res.status(404).json({ error: 'Process template not found' });
  res.json(b);
});

/* ─── Process drafts (Process Canvas v2, #344) ──────────────────────────
 * A draft is an editable process-template bundle that exists before any team
 * is materialised. Pure document storage — no agent/Matrix side effects.
 * Persisted at /workspace/process-drafts/<id>.json. */
const PROCESS_DRAFTS_DIR = path.join(WORKSPACE, 'process-drafts');
const DRAFT_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// Resolve a draft path, hard-guarding against traversal (CodeQL-friendly:
// AGENT_ID_RE-style regex + path.resolve containment check).
function draftPath(id) {
  const root = path.resolve(PROCESS_DRAFTS_DIR);
  const p = path.resolve(root, `${id}.json`);
  if (p !== path.join(root, `${id}.json`)) return null;
  if (!p.startsWith(root + path.sep)) return null;
  return p;
}
function slugifyDraft(name) {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return base || 'process';
}
function readDraft(id) {
  const p = draftPath(id);
  if (!p || !fs.existsSync(p)) return null;
  return readJsonFile(p, null);
}

app.get('/api/process/drafts', (req, res) => {
  let ids = [];
  try {
    ids = fs.readdirSync(PROCESS_DRAFTS_DIR).filter(f => f.endsWith('.json')).map(f => f.slice(0, -5));
  } catch { /* dir not created yet */ }
  const drafts = ids.map(id => {
    const d = readDraft(id);
    if (!d) return null;
    return { id, name: d.name || id, roleCount: Array.isArray(d.roles) ? d.roles.length : 0, updatedAt: d.updatedAt || null };
  }).filter(Boolean).sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  res.json(drafts);
});

app.post('/api/process/drafts', apiLimiter, (req, res) => {
  const name = typeof req.body?.name === 'string' && req.body.name.trim() ? req.body.name.trim() : 'Untitled process';
  // Derive a unique slug id.
  let base = slugifyDraft(name);
  if (!DRAFT_ID_RE.test(base)) base = 'process';
  let id = base, n = 2;
  while (fs.existsSync(draftPath(id))) { id = `${base}-${n++}`; }
  const now = new Date().toISOString();
  // Seed from an imported bundle if provided, else an empty skeleton.
  let bundle = emptyDraftBundle(name);
  if (req.body?.processTemplate) {
    const v = validateProcessTemplate(req.body.processTemplate, { allowEmptyRoles: true });
    if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
    bundle = { ...req.body.processTemplate, name };
  }
  const draft = { ...bundle, id, createdAt: now, updatedAt: now };
  fs.mkdirSync(PROCESS_DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftPath(id), draft);
  res.status(201).json(draft);
});

app.get('/api/process/drafts/:id', (req, res) => {
  const { id } = req.params;
  if (!DRAFT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid draft id' });
  const d = readDraft(id);
  if (!d) return res.status(404).json({ error: 'Draft not found' });
  res.json(d);
});

app.put('/api/process/drafts/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!DRAFT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid draft id' });
  const existing = readDraft(id);
  if (!existing) return res.status(404).json({ error: 'Draft not found' });
  const body = req.body || {};
  // Drafts are works-in-progress — empty role sets are allowed here (only
  // materialisation requires a non-empty set).
  const v = validateProcessTemplate(body, { allowEmptyRoles: true });
  if (!v.ok) return res.status(400).json({ error: v.error });
  const draft = {
    ...body,
    id,
    name: typeof body.name === 'string' && body.name.trim() ? body.name.trim() : existing.name,
    createdAt: existing.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  writeJsonAtomic(draftPath(id), draft);
  res.json(draft);
});

app.delete('/api/process/drafts/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!DRAFT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid draft id' });
  const p = draftPath(id);
  if (!p || !fs.existsSync(p)) return res.status(404).json({ error: 'Draft not found' });
  fs.rmSync(p);
  res.status(204).end();
});

/* Import a BriefingPack hierarchy as a process draft (#377). Reads a briefings
 * directory from bp-explorer and maps it through briefingsToUnified →
 * unifiedToProcessTemplate, so the brief.md body becomes each role's prompt and
 * the parent-child hierarchy, depends_on, artifacts and stage are preserved.
 * The result is persisted as a new editable draft — BP-Flows and Process-Flows
 * now share one storage format. Read-only against the BP source (no brief.md
 * write-back). */
app.post('/api/process/drafts/import-briefings', apiLimiter, async (req, res) => {
  const workspace = typeof req.body?.workspace === 'string' && req.body.workspace.trim()
    ? req.body.workspace.trim() : null;
  if (!workspace) return res.status(400).json({ error: 'workspace (briefings path) is required' });

  let bps;
  try {
    const url = `${BP_EXPLORER_URL}/api/briefings?workspace=${encodeURIComponent(workspace)}`;
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(502).json({ error: `BP-Explorer returned ${upstream.status}` });
    bps = await upstream.json();
  } catch (err) {
    return res.status(502).json({ error: `BP-Explorer unreachable: ${err.message}` });
  }
  if (!Array.isArray(bps) || bps.length === 0) {
    return res.status(422).json({ error: 'No briefing packs found at that workspace' });
  }

  const name = typeof req.body?.name === 'string' && req.body.name.trim()
    ? req.body.name.trim() : `Imported: ${workspace}`;
  const bundle = { ...unifiedToProcessTemplate(briefingsToUnified(bps, { name })), name };

  // Persist as a new draft (same id derivation as POST /api/process/drafts).
  let base = slugifyDraft(name);
  if (!DRAFT_ID_RE.test(base)) base = 'process';
  let id = base, n = 2;
  while (fs.existsSync(draftPath(id))) { id = `${base}-${n++}`; }
  const now = new Date().toISOString();
  const draft = { ...bundle, id, sourceBriefings: workspace, createdAt: now, updatedAt: now };
  fs.mkdirSync(PROCESS_DRAFTS_DIR, { recursive: true });
  writeJsonAtomic(draftPath(id), draft);
  res.status(201).json(draft);
});

/* ─── Skills ────────────────────────────────────────────────────────── */

// ── Two-tier skill pool (#306) ──────────────────────────────────────────
// Global pool: /pool/skills (System-Admin managed, visible to all).
// Team pool:   /workspace/teams/<teamId>/skills (Team-Admin managed, scoped
// to the team). Agents receive global + their owning team's pool at seed time
// (the orchestrator resolves team-first then global). These helpers manage the
// team pool; the global pool keeps its existing /pool/skills paths untouched.
const POOL_TEAM_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

// True when a human Team with this id exists in the teams index.
function resolveTeamExists(teamId) {
  const teams = readJsonFile(TEAMS_INDEX, []);
  return Array.isArray(teams) && teams.some(t => t.id === teamId);
}

// Resolve a team skill directory with a containment check, or null if invalid.
function safeTeamSkillDir(teamId, name) {
  if (!POOL_TEAM_ID_RE.test(teamId || '') || !SKILL_NAME_RE.test(name || '')) return null;
  const base = path.resolve(WORKSPACE, 'teams', teamId, 'skills');
  const dir = path.resolve(base, name);
  const rel = path.relative(base, dir);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return dir;
}

// List team skills, optionally filtered to one team. Each is tagged with its
// owning teamId so the UI (and a future membership filter, #302) can scope it.
function listTeamSkills(filterTeamId) {
  const out = [];
  const teamsRoot = path.join(WORKSPACE, 'teams');
  let teamDirs;
  try { teamDirs = fs.readdirSync(teamsRoot); } catch { return out; }
  for (const teamId of teamDirs) {
    if (!POOL_TEAM_ID_RE.test(teamId)) continue;
    if (filterTeamId && teamId !== filterTeamId) continue;
    const dir = path.join(teamsRoot, teamId, 'skills');
    let names;
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) {
      const skillMd = path.join(dir, name, 'SKILL.md');
      if (fs.existsSync(skillMd)) out.push({ name, source: 'team', teamId, path: skillMd });
    }
  }
  return out;
}

app.get('/api/skills', (req, res) => {
  const scope = getScope(req);
  const skills = [];
  const seen = new Set();

  // Pool (shared / global) skills — always visible to everyone.
  const poolSkillsDir = path.join(POOL_DIR, 'skills');
  try {
    fs.readdirSync(poolSkillsDir).forEach(name => {
      const skillMd = path.join(poolSkillsDir, name, 'SKILL.md');
      if (fs.existsSync(skillMd) && !seen.has(name)) {
        seen.add(name);
        skills.push({ name, source: 'pool', path: skillMd });
      }
    });
  } catch { /* no pool skills dir */ }

  // Team-scoped skills (#306), narrowed to the caller's teams (#302). An
  // explicit `?teamId=<id>` narrows further; a team the caller can't see is
  // dropped by visibleTeam.
  const filterTeam = typeof req.query.teamId === 'string' ? req.query.teamId : null;
  skills.push(...listTeamSkills(filterTeam).filter(s => visibleTeam(scope, s.teamId)));

  // Agent skills — visible only when the owning agent is visible (#302), so an
  // agent's skills don't leak its existence across teams.
  for (const agentId of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, agentId, 'config.json'), {});
    if (!visibleAgent(scope, cfg)) continue;
    const agentSkillsDir = path.join(AGENTS_DIR, agentId, 'skills');
    try {
      fs.readdirSync(agentSkillsDir).forEach(name => {
        const skillMd = path.join(agentSkillsDir, name, 'SKILL.md');
        if (fs.existsSync(skillMd)) {
          const key = `${agentId}/${name}`;
          if (!seen.has(key)) {
            seen.add(key);
            skills.push({ name, source: 'agent', agentId, path: skillMd });
          }
        }
      });
    } catch { /* no agent skills dir */ }
  }

  res.json(skills);
});

app.get('/api/skills/:name/content', (req, res) => {
  const { name } = req.params;
  const { source, agentId } = req.query;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });

  let skillPath;
  if (source === 'agent' && typeof agentId === 'string' && AGENT_ID_RE.test(agentId)) {
    skillPath = path.join(AGENTS_DIR, path.basename(agentId), 'skills', path.basename(name), 'SKILL.md');
  } else if (source === 'agent') {
    return res.status(400).json({ error: 'Invalid agent id' });
  } else if (source === 'team') {
    const dir = safeTeamSkillDir(req.query.teamId, name);
    if (!dir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    skillPath = path.join(dir, 'SKILL.md');
  } else {
    skillPath = path.join(POOL_DIR, 'skills', path.basename(name), 'SKILL.md');
  }

  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
  const content = fs.readFileSync(skillPath, 'utf8');
  res.json({ content });
});

/* ─── Skill directory contents (multi-file browser/editor) ───────────── */

const SKILL_FILE_MAX_BYTES = 512 * 1024; // 512 KB read cap per file

// Resolve a skill's root directory for the given source. Returns the absolute
// path or null when the source/name/agentId are invalid. Does not check that
// the directory exists.
function skillRootDir(source, name, agentId, teamId) {
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) return null;
  if (source === 'agent') {
    if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) return null;
    return path.join(AGENTS_DIR, path.basename(agentId), 'skills', path.basename(name));
  }
  if (source === 'team') {
    return safeTeamSkillDir(teamId, name); // null when teamId/name invalid
  }
  return path.join(POOL_DIR, 'skills', path.basename(name));
}

// Resolve a relative file path inside a skill directory, refusing anything
// that escapes the root (traversal, absolute paths, outward symlinks). Mirrors
// safeAgentPath. Returns the absolute path on success, null otherwise. The
// target file must already exist (realpath fails on ENOENT).
function safeSkillFilePath(rootDir, relFile) {
  let realRoot;
  try { realRoot = fs.realpathSync(rootDir); } catch { return null; }
  const normalized = path.normalize(String(relFile || '').replace(/^\/+/, ''));
  if (!normalized || normalized === '.') return null;
  if (normalized.split(path.sep).some(seg => seg === '..')) return null;
  const target = path.resolve(realRoot, normalized);
  let realTarget;
  try { realTarget = fs.realpathSync(target); } catch { return null; }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}

// Recursively list regular files in a skill directory (relative POSIX paths).
// Symlinked directories are not descended (withFileTypes reports them as
// non-directories), which also prevents symlink loops.
function listSkillFiles(rootDir) {
  const out = [];
  const walk = (dir, rel) => {
    if (out.length > 2000) return; // defensive cap
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const relPath = rel ? `${rel}/${d.name}` : d.name;
      const full = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(full, relPath);
      } else if (d.isFile()) {
        let size = 0;
        try { size = fs.statSync(full).size; } catch { /* transient */ }
        out.push({ path: relPath, size });
      }
    }
  };
  walk(rootDir, '');
  out.sort((a, b) => a.path.localeCompare(b.path, undefined, { sensitivity: 'base' }));
  return out;
}

// List every file in a skill directory (not just SKILL.md) so the registry can
// show what a skill actually contains (scripts, data, sub-skills, …).
app.get('/api/skills/:name/files', (req, res) => {
  const { name } = req.params;
  const { source, agentId, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });
  res.json({ files: listSkillFiles(root) });
});

// Read a single file from a skill directory. Caps reads and flags binary files
// (NUL byte in the prefix) so the UI can show a placeholder instead of garbage.
app.get('/api/skills/:name/file', (req, res) => {
  const { name } = req.params;
  const { source, agentId, file, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  const target = safeSkillFilePath(root, file);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try { st = fs.statSync(target); } catch { return res.status(404).json({ error: 'not found' }); }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const truncated = st.size > SKILL_FILE_MAX_BYTES;
  const readSize = Math.min(st.size, SKILL_FILE_MAX_BYTES);
  let buf;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      buf = Buffer.alloc(readSize);
      if (readSize > 0) fs.readSync(fd, buf, 0, readSize, 0);
    } finally { fs.closeSync(fd); }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const probe = buf.slice(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);
  res.json({
    path: String(file),
    size: st.size,
    truncated,
    binary: isBinary,
    content: isBinary ? null : buf.toString('utf8'),
  });
});

// Overwrite a single file inside a POOL skill directory. Agent skills stay
// read-only (mirrors PUT /api/skills/:name). Only existing files are editable
// — safeSkillFilePath rejects paths that don't resolve to an existing file,
// so this cannot create new files or escape the skill directory.
app.put('/api/skills/:name/file', (req, res) => {
  const { name } = req.params;
  const { source, file, teamId } = req.query;
  if (source === 'agent') {
    return res.status(403).json({ error: 'Agent skills are read-only from the registry. Promote the skill to the pool to edit it.' });
  }
  const root = skillRootDir(source, name, undefined, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name or team id' });
  const target = safeSkillFilePath(root, file);
  if (!target) return res.status(400).json({ error: 'invalid path' });
  if (!fs.statSync(target).isFile()) return res.status(400).json({ error: 'not a file' });

  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  try {
    fs.writeFileSync(target, content, 'utf8');
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ path: String(file), source: 'pool' });
});

// Stream a ZIP archive of an entire skill directory (pool or agent source).
// The archive contains a single top-level folder named after the skill, so it
// round-trips cleanly through POST /api/skills/import.
app.get('/api/skills/:name/export', heavyLimiter, (req, res) => {
  const { name } = req.params;
  const { source, agentId, teamId } = req.query;
  const root = skillRootDir(source, name, agentId, teamId);
  if (!root) return res.status(400).json({ error: 'Invalid skill name, agent id or team id' });
  if (!fs.existsSync(path.join(root, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });

  const parentDir = path.dirname(root);
  const dirName = path.basename(root);
  // Scratch zip lives in /tmp so `zip -r` doesn't try to archive its own output.
  const zipDir = fs.mkdtempSync(path.join('/tmp', 'skill-zip-'));
  const zipPath = path.join(zipDir, 'skill.zip');
  try {
    const zipResult = spawnSync('zip', ['-r', zipPath, dirName], { cwd: parentDir });
    if (zipResult.status !== 0) {
      throw new Error(`zip exited ${zipResult.status}: ${(zipResult.stderr || '').toString().trim()}`);
    }
    const stat = fs.statSync(zipPath);
    res.setHeader('Content-Disposition', `attachment; filename="skill-${name}.zip"`);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Length', stat.size);
    const stream = fs.createReadStream(zipPath);
    stream.on('close', () => { try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ } });
    stream.pipe(res);
  } catch (err) {
    try { fs.rmSync(zipDir, { recursive: true, force: true }); } catch { /* noop */ }
    console.error(`[API] Skill export failed for ${name}: ${err.message}`);
    res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

// Accepts a ZIP (field: "file") of a skill directory and creates a new pool
// skill from it. The ZIP may carry the files at its root or nested under a
// single top-level folder (as produced by /export). An optional `name` form
// field overrides the skill name; otherwise the top-level folder name is used.
const _skillImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

app.post('/api/skills/import', heavyLimiter, _skillImportUpload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file provided (field name: file)' });

  const tmpDir = fs.mkdtempSync(path.join('/tmp', 'skill-import-'));
  const zipPath = path.join(tmpDir, 'upload.zip');
  const extractDir = path.join(tmpDir, 'extracted');
  try {
    fs.writeFileSync(zipPath, req.file.buffer);
    fs.mkdirSync(extractDir);

    // A .skill file is just a ZIP under the hood, so unzip handles both .zip and
    // .skill uploads — extraction is content-based and ignores the file extension.
    const unzipResult = spawnSync('unzip', ['-o', zipPath, '-d', extractDir]);
    if (unzipResult.status !== 0) {
      return res.status(400).json({ error: 'Could not extract archive — ensure the file is a valid .zip or .skill skill archive' });
    }

    // Zip-slip protection: verify every extracted path stays within extractDir.
    const realExtractDir = fs.realpathSync(extractDir);
    function checkExtractedPaths(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        try {
          const real = fs.realpathSync(full);
          if (!real.startsWith(realExtractDir + path.sep) && real !== realExtractDir) {
            throw new Error(`Unsafe path in ZIP: ${real}`);
          }
        } catch (e) {
          if (e.message && e.message.startsWith('Unsafe')) throw e;
          // realpathSync on a dangling symlink throws ENOENT — skip safely
        }
        if (entry.isDirectory()) checkExtractedPaths(full);
      }
    }
    checkExtractedPaths(extractDir);

    // Locate the skill root inside the archive: either SKILL.md at the top, or
    // a single top-level directory that contains SKILL.md.
    const topEntries = fs.readdirSync(extractDir, { withFileTypes: true })
      .filter(e => e.name !== '__MACOSX');
    let skillRoot = null;
    let inferredName = null;
    if (fs.existsSync(path.join(extractDir, 'SKILL.md'))) {
      skillRoot = extractDir;
    } else {
      const dirs = topEntries.filter(e => e.isDirectory());
      if (dirs.length === 1 && fs.existsSync(path.join(extractDir, dirs[0].name, 'SKILL.md'))) {
        skillRoot = path.join(extractDir, dirs[0].name);
        inferredName = dirs[0].name;
      }
    }
    if (!skillRoot) {
      return res.status(400).json({ error: 'Archive does not contain a SKILL.md (at the root or in a single top-level folder)' });
    }

    const rawName = (typeof req.body?.name === 'string' && req.body.name.trim()) || inferredName;
    if (!rawName || !SKILL_NAME_RE.test(rawName)) {
      return res.status(400).json({ error: 'Could not determine a valid skill name — provide a "name" field' });
    }

    // Containment check for the pool target.
    const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
    const targetDir = path.resolve(poolSkillsBaseDir, rawName);
    const rel = path.relative(poolSkillsBaseDir, targetDir);
    if (rel.startsWith('..') || path.isAbsolute(rel) || !rel) {
      return res.status(400).json({ error: 'Invalid skill name' });
    }
    if (fs.existsSync(targetDir)) {
      return res.status(409).json({ error: `Skill '${rawName}' already exists in the pool`, exists: true });
    }

    fs.cpSync(skillRoot, targetDir, { recursive: true });
    res.status(201).json({ name: rawName, source: 'pool' });
  } catch (err) {
    console.error(`[API] Skill import failed: ${err.message}`);
    res.status(500).json({ error: `Import failed: ${err.message}` });
  } finally {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* noop */ }
  }
});

app.post('/api/skills', (req, res) => {
  const { name, content = '', source, teamId } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  // Team-scoped skill (#306): write into /workspace/teams/<teamId>/skills.
  if (source === 'team') {
    const skillDir = safeTeamSkillDir(teamId, name);
    if (!skillDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    if (!resolveTeamExists(teamId)) return res.status(400).json({ error: `Team '${teamId}' not found` });
    const skillPath = path.join(skillDir, 'SKILL.md');
    if (fs.existsSync(skillPath)) {
      return res.status(409).json({ error: `Skill '${name}' already exists in team '${teamId}'` });
    }
    fs.mkdirSync(skillDir, { recursive: true });
    fs.writeFileSync(skillPath, typeof content === 'string' ? content : '', 'utf8');
    return res.status(201).json({ name, source: 'team', teamId });
  }
  const skillDir = path.join(POOL_DIR, 'skills', path.basename(name));
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    return res.status(409).json({ error: `Skill '${name}' already exists` });
  }
  fs.mkdirSync(skillDir, { recursive: true });
  fs.writeFileSync(skillPath, typeof content === 'string' ? content : '', 'utf8');
  res.status(201).json({ name, source: 'pool' });
});

// Promote a skill from an agent workspace into the shared pool, copying the
// ENTIRE skill directory (SKILL.md plus any scripts/assets) recursively so it
// can be reused by other agents. Refuses to clobber an existing pool skill
// unless `overwrite: true` is passed.
app.post('/api/skills/promote', (req, res) => {
  const { agentId, name, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  // Containment check: AGENT_ID_RE / SKILL_NAME_RE already exclude traversal
  // segments, but the path.resolve + path.relative pattern is what CodeQL's
  // path-injection query recognises in-flow.
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const srcDir = path.resolve(agentsBaseDir, agentId, 'skills', name);
  const srcRel = path.relative(agentsBaseDir, srcDir);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel)) {
    return res.status(400).json({ error: 'Invalid agent id or skill name' });
  }
  const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
  const dstDir = path.resolve(poolSkillsBaseDir, name);
  const dstRel = path.relative(poolSkillsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }

  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    return res.status(404).json({ error: `Skill '${name}' not found for agent '${agentId}'` });
  }
  if (fs.existsSync(dstDir) && !overwrite) {
    return res.status(409).json({ error: `Skill '${name}' already exists in the pool`, exists: true });
  }

  try {
    if (overwrite) fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to promote skill: ${err.message}` });
  }
  res.status(201).json({ name, source: 'pool', overwritten: !!overwrite });
});

// Install a pool skill into an EXISTING agent's workspace, copying the whole
// skill directory (SKILL.md plus any scripts/assets) recursively. This is the
// inverse of /promote and avoids a full deactivate+enable workspace reset:
// the running agent picks the skill up on its next invocation. Refuses to
// clobber an existing agent skill unless `overwrite: true` is passed.
app.post('/api/skills/install', (req, res) => {
  const { agentId, name, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (typeof agentId !== 'string' || !AGENT_ID_RE.test(agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }

  // Containment check: AGENT_ID_RE / SKILL_NAME_RE already exclude traversal
  // segments, but the path.resolve + path.relative pattern is what CodeQL's
  // path-injection query recognises in-flow.
  const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
  const srcDir = path.resolve(poolSkillsBaseDir, name);
  const srcRel = path.relative(poolSkillsBaseDir, srcDir);
  if (srcRel.startsWith('..') || path.isAbsolute(srcRel)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  const agentsBaseDir = path.resolve(AGENTS_DIR);
  const agentDirPath = path.resolve(agentsBaseDir, agentId);
  const dstDir = path.resolve(agentDirPath, 'skills', name);
  const dstRel = path.relative(agentsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid agent id or skill name' });
  }

  const cfg = readJsonFile(path.join(agentDirPath, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: `Agent '${agentId}' not found` });
  // A stub (not yet materialized) has no workspace to install into; enabling it
  // would re-seed from the environment anyway. Require a materialized agent.
  if (cfg.enabled === false || !cfg.token) {
    return res.status(409).json({ error: `Agent '${agentId}' is not active — enable it before installing skills` });
  }

  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    return res.status(404).json({ error: `Skill '${name}' not found in the pool` });
  }
  if (fs.existsSync(dstDir) && !overwrite) {
    return res.status(409).json({ error: `Agent '${agentId}' already has a skill named '${name}'`, exists: true });
  }

  try {
    fs.mkdirSync(path.dirname(dstDir), { recursive: true });
    if (overwrite) fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to install skill: ${err.message}` });
  }
  // Mirror the installed skill into an isolated agent's dedicated volume so the
  // running agent picks it up on its next message (#185 item 5).
  notifyAgentReseed(agentId, ['skills/' + name]);
  res.status(201).json({ name, agentId, installed: true, overwritten: !!overwrite });
});

app.put('/api/skills/:name', (req, res) => {
  const { name } = req.params;
  const { source } = req.query;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  if (source === 'agent') {
    return res.status(403).json({ error: 'Agent skills are read-only from the registry. Use the propagation flow to promote a skill to the pool.' });
  }
  const { content } = req.body || {};
  if (typeof content !== 'string') return res.status(400).json({ error: 'content must be a string' });
  if (source === 'team') {
    const dir = safeTeamSkillDir(req.query.teamId, name);
    if (!dir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    const teamSkillPath = path.join(dir, 'SKILL.md');
    if (!fs.existsSync(teamSkillPath)) return res.status(404).json({ error: 'Skill not found' });
    fs.writeFileSync(teamSkillPath, content, 'utf8');
    return res.json({ name, source: 'team', teamId: req.query.teamId });
  }
  const skillPath = path.join(POOL_DIR, 'skills', path.basename(name), 'SKILL.md');
  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
  fs.writeFileSync(skillPath, content, 'utf8');
  res.json({ name, source: 'pool' });
});

app.delete('/api/skills/:name', (req, res) => {
  const { name } = req.params;
  const { source } = req.query;
  if (!SKILL_NAME_RE.test(name)) return res.status(400).json({ error: 'Invalid skill name' });
  if (source === 'agent') {
    return res.status(403).json({ error: 'Agent skills cannot be deleted from the registry.' });
  }
  // Team-scoped skill (#306).
  if (source === 'team') {
    const dir = safeTeamSkillDir(req.query.teamId, name);
    if (!dir) return res.status(400).json({ error: 'Invalid team id or skill name' });
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) return res.status(404).json({ error: 'Skill not found' });
    fs.rmSync(dir, { recursive: true, force: true });
    return res.json({ deleted: name, source: 'team', teamId: req.query.teamId });
  }
  const skillDir = path.join(POOL_DIR, 'skills', path.basename(name));
  const skillPath = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });

  const blocking = listEnvironmentIds()
    .map(loadEnvironment)
    .filter(env => env && Array.isArray(env.skills) && env.skills.includes(name))
    .map(env => env.id);
  if (blocking.length > 0) {
    return res.status(409).json({ error: 'Skill is in use', environments: blocking });
  }

  fs.rmSync(skillDir, { recursive: true, force: true });
  res.json({ deleted: name });
});

// Two-stage promotion (#306, relates to #173): promote a TEAM skill up to the
// GLOBAL pool. The team-tier copy is the Team-Admin's curation; lifting it to
// the global pool is a System-Admin / governance action. Copies the whole skill
// directory recursively. Refuses to clobber an existing global skill unless
// `overwrite: true`.
app.post('/api/skills/promote-to-global', (req, res) => {
  const { name, teamId, overwrite = false } = req.body || {};
  if (typeof name !== 'string' || !SKILL_NAME_RE.test(name)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  const srcDir = safeTeamSkillDir(teamId, name);
  if (!srcDir) return res.status(400).json({ error: 'Invalid team id or skill name' });
  if (!fs.existsSync(path.join(srcDir, 'SKILL.md'))) {
    return res.status(404).json({ error: `Skill '${name}' not found in team '${teamId}'` });
  }
  // Containment for the global destination (matches the /promote pattern).
  const poolSkillsBaseDir = path.resolve(POOL_DIR, 'skills');
  const dstDir = path.resolve(poolSkillsBaseDir, name);
  const dstRel = path.relative(poolSkillsBaseDir, dstDir);
  if (dstRel.startsWith('..') || path.isAbsolute(dstRel)) {
    return res.status(400).json({ error: 'Invalid skill name' });
  }
  if (fs.existsSync(dstDir) && !overwrite) {
    return res.status(409).json({ error: `Skill '${name}' already exists in the global pool`, exists: true });
  }
  try {
    if (overwrite) fs.rmSync(dstDir, { recursive: true, force: true });
    fs.cpSync(srcDir, dstDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Failed to promote skill: ${err.message}` });
  }
  res.status(201).json({ name, source: 'pool', fromTeam: teamId, overwritten: !!overwrite });
});

/* ─── LLM Config ─────────────────────────────────────────────────────── */

app.get('/api/llm-config', (req, res) => {
  const token = process.env.ANTHROPIC_AUTH_TOKEN || '';
  const maskedToken = token.length > 4
    ? '•'.repeat(Math.min(token.length - 4, 12)) + token.slice(-4)
    : token ? '••••' : '';
  res.json({
    baseUrl:     process.env.ANTHROPIC_BASE_URL || '',
    authToken:   maskedToken,
    sonnetModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
    haikuModel:  process.env.ANTHROPIC_DEFAULT_HAIKU_MODEL  || 'claude-haiku-4-5',
  });
});

/* ─── LLM Endpoints ─────────────────────────────────────────────────── */

function slugifyId(name) {
  return String(name || '').toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function validateModels(models) {
  if (!Array.isArray(models)) return 'models must be an array';
  for (const m of models) {
    if (!m || typeof m.id !== 'string' || !m.id.trim()) return 'every model needs a non-empty id';
  }
  return null;
}

// Normalize an endpoint-level defaultModelId against a models list:
//   - undefined / null / '' → null (no default chosen)
//   - non-empty string      → must match an entry's id, otherwise error
function normalizeEndpointDefaultModel(defaultModelId, models) {
  if (defaultModelId === undefined || defaultModelId === null || defaultModelId === '') {
    return { defaultModelId: null };
  }
  if (typeof defaultModelId !== 'string') {
    return { error: 'defaultModelId must be a string or null' };
  }
  const trimmed = defaultModelId.trim();
  if (!Array.isArray(models) || !models.some(m => m.id === trimmed)) {
    return { error: `defaultModelId '${trimmed}' is not in the endpoint's models list` };
  }
  return { defaultModelId: trimmed };
}

// The endpoint's effective default — operator-chosen value, or first model as
// a backstop so callers that don't yet pick one explicitly still get something
// usable (mirrors the previous models[0] behaviour).
function pickEndpointDefaultModel(ep) {
  if (!ep) return null;
  if (ep.defaultModelId) return ep.defaultModelId;
  const first = (ep.models || [])[0];
  return first?.id || null;
}

app.get('/api/llm-endpoints', (req, res) => {
  res.json(listLlmEndpoints().map(maskLlmEndpoint));
});

// Read-only view of the ANTHROPIC_* variables from `.env`, surfaced as a
// provider-shaped record so the Model Providers page can show the operator
// what "inherit from .env" resolves to. Never selectable as an llmEndpointId.
app.get('/api/llm-env-fallback', (req, res) => {
  res.json(buildEnvFallbackProvider());
});

app.get('/api/llm-endpoints/:id', (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  res.json(maskLlmEndpoint(ep));
});

app.post('/api/llm-endpoints', apiLimiter, async (req, res) => {
  const { name, baseUrl, authToken, models, defaultModelId, id: rawId, teamId,
          authType: rawAuthType, complianceAck, oauthFlowId } = req.body || {};
  const authType = normalizeAuthType(rawAuthType);
  const isOauth = authType === 'oauth-token';
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!isOauth && (!baseUrl || typeof baseUrl !== 'string')) return res.status(400).json({ error: 'baseUrl is required' });
  if (isOauth && complianceAck !== true) {
    return res.status(400).json({ error: 'Subscription auth requires the explicit single-user compliance confirmation (complianceAck).' });
  }
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (!isOauth) {
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  }
  const modelList = Array.isArray(models) ? models : [];
  const modelErr = validateModels(modelList);
  if (modelErr) return res.status(400).json({ error: modelErr });
  const normalizedModels = modelList.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));
  const def = normalizeEndpointDefaultModel(defaultModelId, normalizedModels);
  if (def.error) return res.status(400).json({ error: def.error });

  const existing = listLlmEndpoints();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!/^[a-z0-9-]+$/.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(e => e.id === id)) return res.status(409).json({ error: `LLM endpoint id '${id}' already exists` });
  } else {
    id = slugifyId(name) || `ep-${Date.now()}`;
    if (existing.some(e => e.id === id)) id = `${id}-${Date.now().toString(36)}`;
  }

  // Resolve the token: manual paste (authToken) or a completed setup-token
  // login flow (oauthFlowId — claimed server-side from the orchestrator).
  let tokenValue = (authToken && typeof authToken === 'string') ? authToken.trim() : '';
  if (isOauth && !tokenValue && oauthFlowId) {
    const claim = await claimOauthFlowToken(oauthFlowId);
    if (claim.error) return res.status(502).json({ error: `Could not obtain token from login flow: ${claim.error}` });
    tokenValue = claim.token;
  }
  if (isOauth && !tokenValue) {
    return res.status(400).json({ error: 'Subscription auth needs a token — complete the login flow or paste a setup-token value.' });
  }

  let authTokenId = '';
  if (tokenValue) {
    authTokenId = `${id}-${Date.now().toString(36)}`;
    writeLlmEndpointToken(authTokenId, tokenValue);
  }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    baseUrl: isOauth ? '' : baseUrl,
    authType,
    ...(isOauth ? { complianceAck: buildComplianceAck(req) } : {}),
    authTokenId,
    models: normalizedModels,
    defaultModelId: def.defaultModelId,
    createdAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex([...existing, entry]);
  res.status(201).json(maskLlmEndpoint(entry));
});

app.put('/api/llm-endpoints/:id', apiLimiter, async (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  const current = list[idx];
  const { name, baseUrl, authToken, models, defaultModelId,
          authType: rawAuthType, complianceAck, oauthFlowId } = req.body || {};

  // The effective auth type after this update. Switching to subscription auth
  // demands a fresh explicit single-user confirmation.
  const nextAuthType = rawAuthType !== undefined
    ? normalizeAuthType(rawAuthType)
    : normalizeAuthType(current.authType);
  const isOauth = nextAuthType === 'oauth-token';
  if (isOauth && normalizeAuthType(current.authType) !== 'oauth-token' && complianceAck !== true) {
    return res.status(400).json({ error: 'Switching to subscription auth requires the explicit single-user compliance confirmation (complianceAck).' });
  }

  if (baseUrl !== undefined && !(isOauth && baseUrl === '')) {
    if (typeof baseUrl !== 'string' || !baseUrl) return res.status(400).json({ error: 'baseUrl must be a non-empty string' });
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  }
  if (!isOauth && normalizeAuthType(current.authType) === 'oauth-token' && !(baseUrl && typeof baseUrl === 'string')) {
    return res.status(400).json({ error: 'Switching to api-key auth requires a baseUrl.' });
  }
  if (models !== undefined) {
    const modelErr = validateModels(models);
    if (modelErr) return res.status(400).json({ error: modelErr });
  }

  const next = { ...current };
  next.authType = nextAuthType;
  if (isOauth) {
    if (normalizeAuthType(current.authType) !== 'oauth-token' || complianceAck === true) {
      next.complianceAck = buildComplianceAck(req);
    }
    if (baseUrl === undefined) next.baseUrl = '';
  } else {
    delete next.complianceAck;
  }
  if (name !== undefined)    next.name    = String(name);
  if (baseUrl !== undefined) next.baseUrl = isOauth ? '' : baseUrl;
  if (models !== undefined)  next.models  = models.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));

  // Validate the default against the *resulting* models list. If the request
  // sends a new defaultModelId, use it; otherwise re-check the existing one
  // against any new model list (so dropping a model that was the default
  // either errors or, if not sent, is silently cleared).
  if (defaultModelId !== undefined) {
    const def = normalizeEndpointDefaultModel(defaultModelId, next.models);
    if (def.error) return res.status(400).json({ error: def.error });
    next.defaultModelId = def.defaultModelId;
  } else if (models !== undefined && current.defaultModelId) {
    const stillThere = (next.models || []).some(m => m.id === current.defaultModelId);
    next.defaultModelId = stillThere ? current.defaultModelId : null;
  }

  // Token rotation: if `authToken` is a non-empty string, replace; if it's an
  // empty string, clear; if undefined, leave the existing token alone. For
  // subscription auth a completed login flow (oauthFlowId) is an alternative
  // source — claimed server-side, never round-tripped through the browser.
  let newTokenValue;
  if (isOauth && oauthFlowId) {
    const claim = await claimOauthFlowToken(oauthFlowId);
    if (claim.error) return res.status(502).json({ error: `Could not obtain token from login flow: ${claim.error}` });
    newTokenValue = claim.token;
  } else if (authToken !== undefined) {
    newTokenValue = (typeof authToken === 'string' && authToken.trim()) ? authToken.trim() : '';
  }
  if (newTokenValue !== undefined) {
    if (newTokenValue) {
      const newId = current.authTokenId || `${current.id}-${Date.now().toString(36)}`;
      writeLlmEndpointToken(newId, newTokenValue);
      if (newId !== current.authTokenId && current.authTokenId) {
        deleteLlmEndpointToken(current.authTokenId);
      }
      next.authTokenId = newId;
    } else {
      if (current.authTokenId) deleteLlmEndpointToken(current.authTokenId);
      next.authTokenId = '';
    }
  }
  // Switching to subscription auth must not leave the endpoint tokenless —
  // the CLI has nothing to authenticate with then.
  if (isOauth && !next.authTokenId) {
    return res.status(400).json({ error: 'Subscription auth needs a token — complete the login flow or paste a setup-token value.' });
  }

  next.updatedAt = new Date().toISOString();
  list[idx] = next;
  saveLlmEndpointsIndex(list);
  res.json(maskLlmEndpoint(next));
});

app.put('/api/llm-endpoints/:id/models', apiLimiter, (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  const models = req.body && Array.isArray(req.body.models) ? req.body.models : req.body;
  const modelErr = validateModels(models);
  if (modelErr) return res.status(400).json({ error: modelErr });
  const normalizedModels = models.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));
  // Drop a stale defaultModelId if the new model list no longer contains it.
  const prevDefault = list[idx].defaultModelId || null;
  const stillValid = prevDefault && normalizedModels.some(m => m.id === prevDefault);
  list[idx] = {
    ...list[idx],
    models: normalizedModels,
    defaultModelId: stillValid ? prevDefault : null,
    updatedAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex(list);
  res.json(maskLlmEndpoint(list[idx]));
});

app.delete('/api/llm-endpoints/:id', apiLimiter, (req, res) => {
  const list = listLlmEndpoints();
  const ep = list.find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  const usedBy = llmEndpointInUse(ep.id);
  if (usedBy) {
    return res.status(409).json({ error: `LLM endpoint is used by environment '${usedBy}'. Detach it first.` });
  }
  if (ep.authTokenId) deleteLlmEndpointToken(ep.authTokenId);
  saveLlmEndpointsIndex(list.filter(e => e.id !== ep.id));
  res.status(204).end();
});

// Shared between the stored-endpoint routes (use the persisted token) and the
// stateless probe routes (use the token from the request body, so the form can
// test a draft endpoint before saving). Subscription-OAuth endpoints always
// probe the real Anthropic API (there is no proxy base URL) with the Bearer +
// oauth beta header the CLI itself uses.
function llmProbeTarget(baseUrl, token, authType) {
  if (normalizeAuthType(authType) === 'oauth-token') {
    return {
      url: buildModelsUrl(ANTHROPIC_DIRECT_BASE),
      headers: token ? oauthProbeHeaders(token) : {},
    };
  }
  return {
    url: buildModelsUrl(baseUrl),
    headers: token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {},
  };
}

async function probeLlmEndpointTest(baseUrl, token, authType) {
  const { url, headers } = llmProbeTarget(baseUrl, token, authType);
  const result = await httpGetJson(url, headers);
  const ok = result.status >= 200 && result.status < 300;
  return {
    ok,
    url,
    status: result.status,
    error: result.error || (ok ? null : `HTTP ${result.status}`),
    sample: ok && result.body && typeof result.body === 'object'
      ? Array.isArray(result.body?.data) ? result.body.data.slice(0, 3) : result.body
      : null,
  };
}

async function probeLlmEndpointDiscover(baseUrl, token, authType) {
  const { url, headers } = llmProbeTarget(baseUrl, token, authType);
  const result = await httpGetJson(url, headers);
  if (result.error || result.status < 200 || result.status >= 300) {
    return { error: result.error || `HTTP ${result.status}`, url, status: result.status };
  }
  // OpenAI-compatible shape: { data: [{ id, ... }] }; LiteLLM also exposes
  // model_info on each entry. Normalize to our { id, displayName, kind?, … }.
  const raw = Array.isArray(result.body?.data) ? result.body.data
            : Array.isArray(result.body)       ? result.body
            : [];
  const models = raw
    .map(m => {
      const id = typeof m === 'string' ? m : m?.id;
      if (!id) return null;
      const lower = String(id).toLowerCase();
      let kind;
      if (lower.includes('opus'))   kind = 'opus';
      else if (lower.includes('sonnet')) kind = 'sonnet';
      else if (lower.includes('haiku'))  kind = 'haiku';
      return { id, displayName: id, ...(kind ? { kind } : {}) };
    })
    .filter(Boolean);
  return { url, count: models.length, models };
}

function validateProbeBody(body) {
  const authType = normalizeAuthType(body?.authType);
  const baseUrl = body?.baseUrl;
  if (authType !== 'oauth-token') {
    if (!baseUrl || typeof baseUrl !== 'string') return { error: 'baseUrl is required' };
    try { new URL(baseUrl); } catch { return { error: 'baseUrl must be a valid URL' }; }
  }
  const authToken = body?.authToken;
  if (authToken !== undefined && authToken !== null && typeof authToken !== 'string') {
    return { error: 'authToken must be a string' };
  }
  return {
    authType,
    baseUrl: authType === 'oauth-token' ? '' : baseUrl,
    token: (typeof authToken === 'string' && authToken.trim()) ? authToken.trim() : '',
  };
}

app.post('/api/llm-endpoints/:id/test', heavyLimiter, async (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  res.json(await probeLlmEndpointTest(ep.baseUrl, token, ep.authType));
});

app.post('/api/llm-endpoints/:id/discover-models', heavyLimiter, async (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  const result = await probeLlmEndpointDiscover(ep.baseUrl, token, ep.authType);
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

// Stateless probe routes — accept baseUrl + authToken directly so the create
// form (and edit-with-unsaved-token) can verify before persisting. The single
// path segment after /api/llm-endpoints/ keeps these from colliding with the
// /:id/{test,discover-models} routes above.
app.post('/api/llm-endpoints/probe-test', heavyLimiter, async (req, res) => {
  const parsed = validateProbeBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  res.json(await probeLlmEndpointTest(parsed.baseUrl, parsed.token, parsed.authType));
});

app.post('/api/llm-endpoints/probe-discover-models', heavyLimiter, async (req, res) => {
  const parsed = validateProbeBody(req.body);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const result = await probeLlmEndpointDiscover(parsed.baseUrl, parsed.token, parsed.authType);
  if (result.error) return res.status(502).json(result);
  res.json(result);
});

/* ─── Subscription-OAuth login flows (proxy to the orchestrator) ─────────
 * The orchestrator runs `claude setup-token` under a PTY and exposes the flow
 * state on its internal API. These proxies surface start/status/code/cancel
 * to the Model Providers page. The one-shot token claim is deliberately NOT
 * proxied — it happens server-side inside POST/PUT /api/llm-endpoints, so the
 * raw token never reaches the browser.
 */

const LLM_AUTH_FLOW_ID_RE = /^[a-f0-9]+$/;

async function proxyLlmAuthFlow(res, method, subPath, body) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const r = await fetch(`${orchestratorUrl}/internal/llm-auth/flows${subPath}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await r.json().catch(() => ({}));
    res.status(r.status).json(payload);
  } catch (err) {
    res.status(502).json({ error: `orchestrator unreachable: ${err.message}` });
  }
}

app.post('/api/llm-auth/flows', heavyLimiter, (req, res) => {
  proxyLlmAuthFlow(res, 'POST', '', null);
});

app.get('/api/llm-auth/flows/:id', (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  proxyLlmAuthFlow(res, 'GET', `/${req.params.id}`, null);
});

app.post('/api/llm-auth/flows/:id/code', apiLimiter, (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  const code = typeof req.body?.code === 'string' ? req.body.code : '';
  proxyLlmAuthFlow(res, 'POST', `/${req.params.id}/code`, { code });
});

app.delete('/api/llm-auth/flows/:id', apiLimiter, (req, res) => {
  if (!LLM_AUTH_FLOW_ID_RE.test(req.params.id)) return res.status(400).json({ error: 'invalid flow id' });
  proxyLlmAuthFlow(res, 'DELETE', `/${req.params.id}`, null);
});

/* ─── Agent-prompt generation (LLM-assisted authoring) ──────────────────
 * The Flow editor's "Add role" dialog lets the operator turn a role name plus
 * a few keyword notes into a polished system/agent prompt instead of writing
 * one by hand. We reuse the same LLM the stack already talks to: a registered
 * Model Provider endpoint when present, otherwise the ANTHROPIC_* fallback
 * from .env. This is a stateless, one-shot completion — nothing is persisted.
 */

// Resolve which endpoint + model + token to use for a one-shot generation call.
// Prefers a caller-named endpoint, else the first registered one, else the
// .env fallback. Within an endpoint, prefer a Sonnet-class model (good quality
// at low latency for this short task), then its configured default, then the
// first model. Returns { baseUrl, token, model } or { error }.
function resolveGenerationTarget(preferredEndpointId) {
  // Subscription-OAuth providers are excluded here: their token authenticates
  // the Claude *CLI* under the subscriber's seat, not arbitrary server-side
  // /v1/messages calls — routing one-shot generation through it would be both
  // unreliable and outside the subscription's permitted use.
  const endpoints = listLlmEndpoints().filter(e => normalizeAuthType(e.authType) !== 'oauth-token');
  const ep = (preferredEndpointId && endpoints.find(e => e.id === preferredEndpointId))
    || endpoints[0]
    || null;
  if (ep) {
    const models = Array.isArray(ep.models) ? ep.models : [];
    const sonnet = models.find(m => m.kind === 'sonnet');
    const model = sonnet?.id || pickEndpointDefaultModel(ep);
    if (!ep.baseUrl) return { error: `LLM endpoint '${ep.id}' has no base URL` };
    if (!model) return { error: `LLM endpoint '${ep.id}' has no models configured` };
    return { baseUrl: ep.baseUrl, token: readLlmEndpointToken(ep.authTokenId), model };
  }
  // No registered endpoint — fall back to the raw ANTHROPIC_* env vars.
  const baseUrl = (process.env.ANTHROPIC_BASE_URL || '').trim();
  if (!baseUrl) {
    return { error: 'No LLM endpoint configured. Add one on the Model Providers page or set ANTHROPIC_BASE_URL.' };
  }
  const model = (process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6').trim();
  return { baseUrl, token: (process.env.ANTHROPIC_AUTH_TOKEN || '').trim(), model };
}

// Meta-prompt: instruct the LLM to author a reusable agent/system prompt for a
// role in an autonomous software-delivery flow, from the role name + notes.
function buildAgentPromptGenerationRequest(roleName, notes) {
  const noteBlock = notes
    ? `Additional notes / keywords from the operator:\n${notes}`
    : 'The operator gave no extra notes — infer sensible responsibilities from the role name alone.';
  const instruction = [
    `You write system prompts for AI agents that participate in an autonomous software-delivery team.`,
    `Each agent works from its own workspace, talks to a human over chat, and may react to GitHub events.`,
    ``,
    `Write the system prompt for a role called "${roleName}".`,
    noteBlock,
    ``,
    `Requirements for the prompt you produce:`,
    `- Speak directly to the agent in the second person ("You are …").`,
    `- Open with a one-line identity, then cover the agent's responsibilities, how it should collaborate/hand off, and its quality bar.`,
    `- Keep it practical and concise (roughly 120–250 words). Use short paragraphs or bullet points.`,
    `- Do NOT invent specific tool names, repo names, file paths, or credentials.`,
    `- Output ONLY the prompt text itself — no preamble, no headings like "System prompt:", no surrounding quotes or code fences.`,
  ].join('\n');
  return {
    max_tokens: 1024,
    messages: [{ role: 'user', content: instruction }],
  };
}

// Pull the assistant text out of an Anthropic Messages API response.
function extractMessageText(body) {
  const blocks = body?.content;
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter(b => b?.type === 'text' && typeof b.text === 'string')
    .map(b => b.text)
    .join('')
    .trim();
}

app.post('/api/agent-prompt/generate', heavyLimiter, async (req, res) => {
  const roleName = typeof req.body?.roleName === 'string' ? req.body.roleName.trim() : '';
  const notes    = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  if (!roleName) return res.status(400).json({ error: 'roleName is required' });

  const target = resolveGenerationTarget(req.body?.llmEndpointId);
  if (target.error) return res.status(400).json({ error: target.error });

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...buildAgentPromptGenerationRequest(roleName, notes) };

  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) {
    const detail = result.error
      || (result.body && (result.body.error?.message || result.body.error || result.body.message))
      || `HTTP ${result.status}`;
    return res.status(502).json({ error: `LLM request failed: ${detail}` });
  }
  const prompt = extractMessageText(result.body);
  if (!prompt) return res.status(502).json({ error: 'LLM returned an empty prompt' });
  res.json({ prompt, model: target.model });
});

/* ─── Port suggestion for custom composer roles (#423) ──────────────────
 * Suggests the catalog-v2 wiring surface (patternRole / sessionPolicy /
 * produce flags) for a user-defined role: one stateless LLM call when a
 * generation target resolves, deterministic keyword heuristic otherwise.
 * The response is a SUGGESTION — the dialog shows it as editable fields the
 * user confirms; nothing is applied silently. */
app.post('/api/agent-ports/suggest', heavyLimiter, async (req, res) => {
  const roleName = typeof req.body?.roleName === 'string' ? req.body.roleName.trim() : '';
  const notes = typeof req.body?.notes === 'string' ? req.body.notes.trim() : '';
  const stageName = typeof req.body?.stageName === 'string' ? req.body.stageName.trim() : '';
  if (!roleName) return res.status(400).json({ error: 'roleName is required' });

  const fallback = () => res.json({
    suggestion: heuristicPortSuggestion({ roleName, notes }),
    source: 'heuristic',
  });

  const target = resolveGenerationTarget(req.body?.llmEndpointId);
  if (target.error) return fallback();

  const url = buildMessagesUrl(target.baseUrl);
  const headers = {
    'anthropic-version': '2023-06-01',
    ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
  };
  const payload = { model: target.model, ...buildPortSuggestionRequest(roleName, notes, stageName) };
  const result = await httpPostJson(url, headers, payload);
  if (result.error || result.status < 200 || result.status >= 300) return fallback();
  const suggestion = parsePortSuggestion(extractMessageText(result.body));
  if (!suggestion) return fallback();
  res.json({ suggestion, source: 'llm', model: target.model });
});

/* ─── MCP server registry ───────────────────────────────────────────── */

// The legacy pool-wide /api/mcp endpoints (which wrote /pool/.claude/settings.json
// directly) have been replaced by a per-environment registry. Each entry lives at
// /workspace/mcp-servers/<id>/server.json; environments reference servers by id
// and pair them with a credential, and the orchestrator materializes the merged
// MCP block into each agent's own .claude/settings.json at seed time.

app.get('/api/mcp-servers', (req, res) => {
  const scope = getScope(req);
  const out = listMcpServerIds()
    .map(id => loadMcpServer(id))
    .filter(Boolean)
    .filter(s => visibleTeam(scope, s.teamId)) // (#302); missing teamId → default team
    .map(s => {
      const transport = s.transport || 'stdio';
      const tplKey = transport === 'stdio' ? 'env' : 'headers';
      const template = (s[tplKey] && typeof s[tplKey] === 'object') ? s[tplKey] : {};
      return {
        id: s.id,
        name: s.name || s.id,
        description: s.description || '',
        transport,
        command: s.command || null,
        args: Array.isArray(s.args) ? s.args : [],
        url: s.url || null,
        templateKeys: Object.keys(template),
        templateField: tplKey,
        requiresCredential: serverNeedsCredential(s),
      };
    });
  res.json(out);
});

app.get('/api/mcp-servers/:id', (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  const s = loadMcpServer(id);
  if (!s) return res.status(404).json({ error: 'MCP server not found' });
  res.json(s);
});

// Validation lives in one place so POST and PUT agree on what's a legal stanza.
// Transport-specific:
//   stdio   → command (required), args (optional), env (template)
//   http    → url (required), headers (template)
//   sse     → url (required), headers (template)
// `env` and `headers` are mutually exclusive on the wire — supplying the wrong
// one for the chosen transport is a 400 so operators don't silently set keys
// that the seed step won't propagate.
function buildMcpServerStanza({ existing, body }) {
  const merged = { ...(existing || {}) };
  const transport = body.transport !== undefined ? body.transport : (existing?.transport || 'stdio');
  if (!['stdio', 'http', 'sse'].includes(transport)) {
    return { error: "transport must be 'stdio', 'http' or 'sse'" };
  }
  merged.transport = transport;

  if (body.name !== undefined) merged.name = body.name;
  if (body.description !== undefined) merged.description = body.description;

  if (transport === 'stdio') {
    if (body.command !== undefined) merged.command = body.command;
    if (body.args !== undefined) merged.args = Array.isArray(body.args) ? body.args : [];
    if (body.env !== undefined) merged.env = (body.env && typeof body.env === 'object') ? body.env : {};
    if (body.url !== undefined || body.headers !== undefined) {
      return { error: "stdio servers don't accept `url` or `headers` — use command/args/env" };
    }
    delete merged.url;
    delete merged.headers;
    if (!merged.command) return { error: 'command is required for stdio transport' };
  } else {
    if (body.url !== undefined) merged.url = body.url;
    if (body.headers !== undefined) merged.headers = (body.headers && typeof body.headers === 'object') ? body.headers : {};
    if (body.command !== undefined || body.args !== undefined || body.env !== undefined) {
      return { error: `${transport} servers don't accept \`command\`/\`args\`/\`env\` — use url/headers` };
    }
    delete merged.command;
    delete merged.args;
    delete merged.env;
    if (!merged.url) return { error: `url is required for ${transport} transport` };
  }

  return { stanza: merged };
}

app.post('/api/mcp-servers', apiLimiter, (req, res) => {
  const body = req.body || {};
  const { id, name } = body;
  if (!id || !MCP_SERVER_ID_RE.test(id)) {
    return res.status(400).json({ error: 'id required, lowercase letters/digits/dashes only' });
  }
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (loadMcpServer(id)) return res.status(409).json({ error: `MCP server '${id}' already exists` });

  const built = buildMcpServerStanza({ existing: null, body });
  if (built.error) return res.status(400).json({ error: built.error });

  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(body.teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  const data = {
    id,
    name,
    teamId: ownerTeamId,
    description: built.stanza.description || '',
    transport: built.stanza.transport,
    ...(built.stanza.transport === 'stdio'
      ? { command: built.stanza.command, args: built.stanza.args || [], env: built.stanza.env || {} }
      : { url: built.stanza.url, headers: built.stanza.headers || {} }),
    createdAt: new Date().toISOString(),
  };
  saveMcpServer(id, data);
  res.status(201).json(data);
});

app.put('/api/mcp-servers/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  const existing = loadMcpServer(id);
  if (!existing) return res.status(404).json({ error: 'MCP server not found' });

  const built = buildMcpServerStanza({ existing, body: req.body || {} });
  if (built.error) return res.status(400).json({ error: built.error });

  const merged = { ...built.stanza, updatedAt: new Date().toISOString() };
  // Preserve (or update) the owning team (#302) — buildMcpServerStanza only
  // covers transport fields, so carry teamId across explicitly.
  if (req.body && req.body.teamId !== undefined) {
    try { merged.teamId = resolveOwnerTeamId(req.body.teamId); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  } else if (existing.teamId !== undefined) {
    merged.teamId = existing.teamId;
  }
  saveMcpServer(id, merged);
  res.json(merged);
});

app.delete('/api/mcp-servers/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_SERVER_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid server id' });
  if (!loadMcpServer(id)) return res.status(404).json({ error: 'MCP server not found' });
  const usedBy = mcpServerInUse(id);
  if (usedBy) return res.status(409).json({ error: `MCP server is used by environment '${usedBy}'. Detach it first.` });
  try { fs.rmSync(path.join(MCP_SERVERS_DIR, id), { recursive: true, force: true }); } catch { /* ignore */ }
  res.status(204).end();
});

/* ─── MCP credentials ───────────────────────────────────────────────── */

app.get('/api/mcp-credentials', (req, res) => {
  // Metadata only — never the raw secret.
  const scope = getScope(req);
  res.json(listMcpCredentials().filter(c => visibleTeam(scope, c.teamId))); // (#302)
});

app.post('/api/mcp-credentials', apiLimiter, (req, res) => {
  const { name, serverId, secret, id: rawId, teamId } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!secret || typeof secret !== 'string') return res.status(400).json({ error: 'secret (string) is required' });
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  if (serverId !== undefined && serverId !== null && !MCP_SERVER_ID_RE.test(serverId)) {
    return res.status(400).json({ error: 'Invalid serverId' });
  }
  if (serverId && !loadMcpServer(serverId)) {
    return res.status(400).json({ error: `MCP server '${serverId}' does not exist` });
  }

  const existing = listMcpCredentials();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(c => c.id === id)) return res.status(409).json({ error: `MCP credential id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `cred-${Date.now()}`;
    if (existing.some(c => c.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid credential id' });

  const mcpCredsRoot = path.resolve(MCP_CREDENTIALS_KEYS_DIR);
  const credPath = path.resolve(mcpCredsRoot, path.basename(id));
  if (credPath !== mcpCredsRoot && !credPath.startsWith(mcpCredsRoot + path.sep)) {
    return res.status(400).json({ error: 'Invalid credential id' });
  }
  fs.writeFileSync(credPath, secret, { mode: 0o600 });
  try { fs.chmodSync(credPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    serverId: serverId || null,
    fingerprint: mcpCredentialFingerprint(secret),
    createdAt: new Date().toISOString(),
  };
  saveMcpCredentialsIndex([...existing, entry]);
  res.status(201).json(entry);
});

app.delete('/api/mcp-credentials/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!MCP_CREDENTIAL_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid credential id' });
  const creds = listMcpCredentials();
  if (!creds.some(c => c.id === id)) return res.status(404).json({ error: 'MCP credential not found' });
  const usedBy = mcpCredentialInUse(id);
  if (usedBy) return res.status(409).json({ error: `MCP credential is used by environment '${usedBy}'. Detach it first.` });
  try { fs.unlinkSync(path.join(MCP_CREDENTIALS_KEYS_DIR, id)); } catch { /* ignore */ }
  saveMcpCredentialsIndex(creds.filter(c => c.id !== id));
  res.status(204).end();
});

// True iff at least one entry in the server's substitution template references
// the `${credential}` placeholder. The template lives under `env` for stdio
// servers and `headers` for http/sse — check whichever is present so the
// answer doesn't depend on whether the operator picked the right field name.
function serverNeedsCredential(server) {
  if (!server) return false;
  const transport = server.transport || 'stdio';
  const tpl = transport === 'stdio' ? server.env : server.headers;
  if (!tpl || typeof tpl !== 'object') return false;
  return Object.values(tpl).some(v => typeof v === 'string' && v.includes('${credential}'));
}

/* ─── Containers ────────────────────────────────────────────────────── */

app.get('/api/containers', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/processes`);
    if (!resp.ok) return res.json([]);
    const processes = await resp.json();
    // Normalize to the shape the Logs page expects: { name, state }
    res.json(processes.map(p => ({
      name: `agent-${p.id}`,
      state: p.running ? 'running' : 'exited',
      pid: p.pid,
    })));
  } catch {
    res.json([]);
  }
});

/* ─── Log streaming (SSE) ───────────────────────────────────────────── */

app.get('/api/logs/stream', (req, res) => {
  const container = req.query.container || 'orchestrator';
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const opts = {
    socketPath: PODMAN_SOCK,
    path: `/v4.0.0/libpod/containers/${container}/logs?follow=true&stdout=true&stderr=true&tail=200`,
    method: 'GET',
  };
  const req2 = http.request(opts, (logRes) => {
    logRes.on('data', (chunk) => {
      // Podman multiplexes stdout/stderr with 8-byte header — strip it
      // Header: [stream_type(1), 0,0,0, size(4)] then payload
      let offset = 0;
      while (offset < chunk.length) {
        if (chunk.length - offset < 8) break;
        const size = chunk.readUInt32BE(offset + 4);
        const line = chunk.slice(offset + 8, offset + 8 + size).toString('utf8').trimEnd();
        if (line) res.write(`data: ${JSON.stringify(line)}\n\n`);
        offset += 8 + size;
      }
    });
    logRes.on('end', () => res.write('event: close\ndata: {}\n\n'));
  });
  req2.on('error', (err) => res.write(`data: ${JSON.stringify('[log error: ' + err.message + ']')}\n\n`));
  req2.end();
  req.on('close', () => req2.destroy());
});

/* ─── Working Environments ──────────────────────────────────────────── */

function normalizeEnvId(raw) {
  return String(raw || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
}

// Accept the new `repositories: [...]` array or the legacy single `repository`
// payload, validate referenced SSH keys exist, and return the normalized array.
// Throws on validation failure so the caller can surface a 400.
function normalizeRepositoriesInput(repositories, legacyRepository) {
  let raw;
  if (Array.isArray(repositories)) {
    raw = repositories;
  } else if (legacyRepository && typeof legacyRepository === 'object') {
    raw = legacyRepository.url ? [legacyRepository] : [];
  } else {
    raw = [];
  }

  const cleaned = [];
  const knownKeys = listSshKeys();
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') continue;
    const url = typeof entry.url === 'string' ? entry.url.trim() : '';
    if (!url) continue;
    const sshKeyId = entry.sshKeyId || null;
    if (sshKeyId && !knownKeys.some(k => k.id === sshKeyId)) {
      throw new Error(`SSH key '${sshKeyId}' not found`);
    }
    cleaned.push({
      url,
      branch: entry.branch ? String(entry.branch).trim() || null : null,
      sshKeyId: sshKeyId || null,
    });
  }
  return cleaned;
}

// Validate the MCP server refs an environment carries: each entry must point at
// a known server id; credentialId is optional but, when present, must exist.
// Throws on validation failure so the caller can surface a 400.
function normalizeMcpServersInput(input) {
  if (input === undefined || input === null) return [];
  if (!Array.isArray(input)) throw new Error('mcpServers must be an array');
  const knownCreds = listMcpCredentials();
  const cleaned = [];
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue;
    const serverId = typeof entry.serverId === 'string' ? entry.serverId.trim() : '';
    if (!serverId) continue;
    if (!MCP_SERVER_ID_RE.test(serverId)) throw new Error(`Invalid mcpServers.serverId: ${serverId}`);
    if (!loadMcpServer(serverId)) throw new Error(`MCP server '${serverId}' not found`);
    let credentialId = null;
    if (entry.credentialId) {
      credentialId = String(entry.credentialId).trim();
      if (!MCP_CREDENTIAL_ID_RE.test(credentialId)) throw new Error(`Invalid mcpServers.credentialId: ${credentialId}`);
      if (!knownCreds.some(c => c.id === credentialId)) throw new Error(`MCP credential '${credentialId}' not found`);
    }
    cleaned.push({ serverId, credentialId });
  }
  return cleaned;
}

/* ─── Teams data model (#299) ───────────────────────────────────────────
 * Thin proxy onto the orchestrator's /internal/admin/* surface, which owns the
 * Team / user / membership store. These are the *human* Team endpoints — the
 * tenant/visibility scope — distinct from the Agent-Team wizard at POST
 * /api/teams. Auth & list-filtering are deliberately out of scope here.
 */
function proxyAdmin(req, res, subPath) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  const init = { method: req.method, headers: { 'Content-Type': 'application/json' } };
  if (req.method === 'POST' || req.method === 'PUT') {
    init.body = JSON.stringify(req.body || {});
  }
  return fetch(`${orchestratorUrl}/internal/admin/${subPath}`, init)
    .then(async (resp) => {
      const text = await resp.text();
      const data = text ? JSON.parse(text) : {};
      res.status(resp.status).json(data);
    })
    .catch((err) => res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` }));
}

function adminQuery(req) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(req.query || {})) {
    if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : '';
}

app.get('/api/admin/teams', (req, res) => proxyAdmin(req, res, 'teams'));
app.post('/api/admin/teams', apiLimiter, (req, res) => proxyAdmin(req, res, 'teams'));
app.get('/api/admin/teams/:id', (req, res) => proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`));
app.put('/api/admin/teams/:id', apiLimiter, (req, res) => proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`));
app.delete('/api/admin/teams/:id', apiLimiter, (req, res) => proxyAdmin(req, res, `teams/${encodeURIComponent(req.params.id)}`));

app.get('/api/admin/users', (req, res) => proxyAdmin(req, res, `users${adminQuery(req)}`));
app.post('/api/admin/users', apiLimiter, (req, res) => proxyAdmin(req, res, 'users'));
app.get('/api/admin/users/:id', (req, res) => proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}`));
app.put('/api/admin/users/:id', apiLimiter, (req, res) => proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}`));
app.delete('/api/admin/users/:id', apiLimiter, (req, res) => proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}`));
// Local password set/clear (#374). The verify path is NOT proxied here — it is
// called directly by the public login route (see auth.js), pre-session.
app.post('/api/admin/users/:id/password', apiLimiter, (req, res) => proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}/password`));
app.delete('/api/admin/users/:id/password', apiLimiter, (req, res) => proxyAdmin(req, res, `users/${encodeURIComponent(req.params.id)}/password`));

app.get('/api/admin/memberships', (req, res) => proxyAdmin(req, res, `memberships${adminQuery(req)}`));
app.post('/api/admin/memberships', apiLimiter, (req, res) => proxyAdmin(req, res, 'memberships'));
app.delete('/api/admin/memberships', apiLimiter, (req, res) => proxyAdmin(req, res, `memberships${adminQuery(req)}`));

app.get('/api/environments', (req, res) => {
  const scope = getScope(req);
  const envs = listEnvironmentIds().map(loadEnvironment).filter(Boolean)
    .filter(e => visibleTeam(scope, e.teamId)) // (#302)
    .map(e => {
      const agents = agentsUsingEnvironment(e.id, scope); // (#439)
      return { ...e, agents, agentCount: agents.length };
    });
  res.json(envs);
});

app.get('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const scope = getScope(req);
  const agents = agentsUsingEnvironment(env.id, scope); // (#439)
  res.json({ ...env, agents, agentCount: agents.length });
});

// Resolve and validate { llmEndpointId, defaultModelId } against the registry.
// Returns { error } on failure, { llmEndpointId, defaultModelId } on success.
//
// When the caller binds an endpoint but doesn't explicitly pick a model,
// inherit the endpoint's registry-level default. That makes "set the default
// once in the Model Registry → every new env starts on it" the default flow,
// without forcing every form to know about the endpoint catalogue.
function resolveLlmBinding(llmEndpointId, defaultModelId) {
  if (!llmEndpointId) {
    if (defaultModelId) return { error: 'defaultModelId requires llmEndpointId' };
    return { llmEndpointId: null, defaultModelId: null };
  }
  const ep = listLlmEndpoints().find(e => e.id === llmEndpointId);
  if (!ep) return { error: `LLM endpoint '${llmEndpointId}' not found` };
  if (defaultModelId) {
    const known = (ep.models || []).some(m => m.id === defaultModelId);
    if (!known) return { error: `Model '${defaultModelId}' is not in endpoint '${ep.id}' catalog` };
    return { llmEndpointId: ep.id, defaultModelId };
  }
  return { llmEndpointId: ep.id, defaultModelId: pickEndpointDefaultModel(ep) };
}

app.post('/api/environments', heavyLimiter, (req, res) => {
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId, mcpServers, teamId } = req.body || {};
  const id = normalizeEnvId(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id is required (a-z, 0-9, -)' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (loadEnvironment(id)) return res.status(409).json({ error: `Environment '${id}' already exists` });

  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }

  let normalizedRepos;
  try {
    normalizedRepos = normalizeRepositoriesInput(repositories, repository);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // Validate githubTokenId if set
  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  }

  let normalizedMcp;
  try {
    normalizedMcp = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  const llm = resolveLlmBinding(llmEndpointId, defaultModelId);
  if (llm.error) return res.status(400).json({ error: llm.error });

  const env = {
    id,
    name,
    description: description || '',
    teamId: ownerTeamId,
    skills: Array.isArray(skills) ? skills : [],
    repositories: normalizedRepos,
    githubTokenId: githubTokenId || null,
    mcpServers: normalizedMcp,
    llmEndpointId: llm.llmEndpointId,
    defaultModelId: llm.defaultModelId,
    additionalContext: additionalContext || '',
    createdAt: new Date().toISOString(),
  };
  saveEnvironment(id, env);
  res.status(201).json(env);
});

app.put('/api/environments/:id', apiLimiter, (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId, mcpServers, teamId } = req.body || {};

  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  }

  if (teamId !== undefined) {
    try { env.teamId = resolveOwnerTeamId(teamId); }
    catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  }

  // Only re-validate the LLM binding if either field was explicitly sent.
  if (llmEndpointId !== undefined || defaultModelId !== undefined) {
    const nextEndpoint = llmEndpointId !== undefined ? llmEndpointId : env.llmEndpointId;
    const nextModel    = defaultModelId !== undefined ? defaultModelId : env.defaultModelId;
    const llm = resolveLlmBinding(nextEndpoint, nextModel);
    if (llm.error) return res.status(400).json({ error: llm.error });
    env.llmEndpointId  = llm.llmEndpointId;
    env.defaultModelId = llm.defaultModelId;
  }

  if (name !== undefined) env.name = name;
  if (description !== undefined) env.description = description;
  if (skills !== undefined) env.skills = Array.isArray(skills) ? skills : [];
  if (repositories !== undefined || repository !== undefined) {
    try {
      env.repositories = normalizeRepositoriesInput(repositories, repository);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    delete env.repository;
  }
  if (githubTokenId !== undefined) env.githubTokenId = githubTokenId || null;
  if (mcpServers !== undefined) {
    try {
      env.mcpServers = normalizeMcpServersInput(mcpServers);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
  }
  if (additionalContext !== undefined) env.additionalContext = additionalContext;
  env.updatedAt = new Date().toISOString();
  saveEnvironment(env.id, env);
  res.json(env);
});

app.delete('/api/environments/:id', apiLimiter, (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const usedBy = environmentInUse(env.id);
  if (usedBy) {
    return res.status(409).json({ error: `Environment is used by agent '${usedBy}'. Delete the agent first.` });
  }
  fs.rmSync(path.join(ENVIRONMENTS_DIR, env.id), { recursive: true, force: true });
  res.status(204).end();
});

// Probe a repo URL (optionally with one of our SSH keys) to verify the agent
// will actually be able to clone it. Delegates to the orchestrator since only
// that container has git/openssh and the SSH key files mounted.
app.post('/api/repositories/check', heavyLimiter, async (req, res) => {
  const { url, sshKeyId, githubTokenId } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  if (sshKeyId) {
    if (!SSH_KEY_ID_RE.test(sshKeyId)) {
      return res.status(400).json({ ok: false, error: 'Invalid SSH key id' });
    }
    const keys = listSshKeys();
    if (!keys.some(k => k.id === sshKeyId)) {
      return res.status(400).json({ ok: false, error: `SSH key '${sshKeyId}' not found` });
    }
  }
  if (githubTokenId) {
    if (!GH_TOKEN_ID_RE.test(githubTokenId)) {
      return res.status(400).json({ ok: false, error: 'Invalid GitHub token id' });
    }
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ ok: false, error: `GitHub token '${githubTokenId}' not found` });
    }
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/repository-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sshKeyId: sshKeyId || null, githubTokenId: githubTokenId || null }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: `Probe failed: ${err.message}` });
  }
});

/* ─── Quick-Start Wizard ────────────────────────────────────────────── */

// Parse a GitHub URL in any of the common forms and normalize to both an SSH
// and an HTTPS clone URL. Returns { sshUrl, httpsUrl, org, repo } or throws.
function parseGitHubUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('GitHub URL is required');

  // git@github.com:org/repo(.git)
  let m = raw.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (!m) {
    // ssh://git@github.com/org/repo(.git)
    m = raw.match(/^ssh:\/\/git@github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // https://github.com/org/repo(.git) or http(s) with optional trailing path
    m = raw.match(/^https?:\/\/(?:www\.)?github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) {
    // Bare github.com/org/repo
    m = raw.match(/^github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  }
  if (!m) throw new Error('Could not parse a GitHub repository URL (expected github.com/<org>/<repo>)');

  const org = m[1];
  const repo = m[2];
  if (!/^[A-Za-z0-9._-]+$/.test(org) || !/^[A-Za-z0-9._-]+$/.test(repo)) {
    throw new Error('GitHub URL contains unexpected characters');
  }
  return {
    org,
    repo,
    sshUrl: `git@github.com:${org}/${repo}.git`,
    httpsUrl: `https://github.com/${org}/${repo}.git`,
  };
}

// Reduce any GitHub URL form to a canonical "<org>/<repo>" string for
// equality checks across SSH/HTTPS variants. Returns null for unparseable
// input so callers can fall back to literal comparison.
function githubRepoKey(url) {
  try {
    const { org, repo } = parseGitHubUrl(url);
    return `${org.toLowerCase()}/${repo.toLowerCase()}`;
  } catch {
    return null;
  }
}

function slugifyRepoSegment(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function findEnvByRepoUrl(targetUrl) {
  const targetKey = githubRepoKey(targetUrl);
  for (const envId of listEnvironmentIds()) {
    const env = loadEnvironment(envId);
    const repos = Array.isArray(env?.repositories) ? env.repositories : [];
    const match = repos.some(r => {
      const u = typeof r?.url === 'string' ? r.url.trim() : '';
      if (!u) return false;
      if (u === targetUrl) return true;
      const k = githubRepoKey(u);
      return targetKey && k && k === targetKey;
    });
    if (match) return env;
  }
  return null;
}

function findStandaloneAgentForEnv(envId) {
  const matches = [];
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg || cfg.environmentId !== envId) continue;
    // Accept legacy 'expert' configs that haven't been migrated yet.
    if (cfg.role !== 'agent' && cfg.role !== 'expert') continue;
    matches.push(cfg);
  }
  matches.sort((a, b) => a.id.localeCompare(b.id));
  return matches[0] || null;
}

function quickstartSystemPrompt(org, repo) {
  return [
    `You are an assistant for the GitHub repository **${org}/${repo}**.`,
    ``,
    `The repository is cloned into your workspace at \`./${repo}/\`. Use Read, Grep, Glob, and the Bash tool (git, build tools) to explore and modify the code.`,
    ``,
    `When the user asks a question, ground your answer in the actual repo state, not guesses. When making changes, follow the project's existing conventions and commit with a clear message.`,
  ].join('\n');
}

// One-shot: from a GitHub URL, ensure a Working Environment exists for the
// repo, and return (or create) a default agent bound to it. Reuses
// existing artefacts when possible so repeat clicks are safe.
app.post('/api/quickstart', heavyLimiter, async (req, res) => {
  const { url, githubTokenId, sshKeyId } = req.body || {};

  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
  const { org, repo, sshUrl } = parsed;

  const tokens = listGithubTokens();
  if (tokens.length === 0) {
    return res.status(400).json({
      error: 'No GitHub token configured. Add one under "GitHub Tokens" first.',
      code: 'no_token',
    });
  }
  let chosenTokenId;
  if (githubTokenId) {
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
    chosenTokenId = githubTokenId;
  } else {
    chosenTokenId = tokens[0].id;
  }

  // SSH key is required because we clone via SSH (git@github.com:...). The
  // GitHub PAT above stays the credential for API actions (gh-as-agent,
  // event polling); the two are deliberately split — see CLAUDE.md.
  const sshKeys = listSshKeys();
  if (sshKeys.length === 0) {
    return res.status(400).json({
      error: 'No SSH key configured. Add one under "SSH Keys" first.',
      code: 'no_ssh_key',
    });
  }
  let chosenSshKeyId;
  if (sshKeyId) {
    if (!sshKeys.some(k => k.id === sshKeyId)) {
      return res.status(400).json({ error: `SSH key '${sshKeyId}' not found` });
    }
    chosenSshKeyId = sshKeyId;
  } else {
    chosenSshKeyId = sshKeys[0].id;
  }

  // 1. Probe the remote: validates SSH auth + reachability, and resolves the
  // default branch so we don't assume "main" (a previous version did, which
  // silently failed on repos defaulting to master/release/etc.).
  // null means "let git use whatever HEAD the remote advertises at clone time".
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  let resolvedBranch = null;
  try {
    const probeResp = await fetch(`${orchestratorUrl}/internal/repository-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: sshUrl, sshKeyId: chosenSshKeyId }),
    });
    const probe = await probeResp.json().catch(() => ({}));
    if (!probe.ok) {
      return res.status(400).json({
        error: probe.error
          ? `Cannot reach repository over SSH: ${probe.error}`
          : 'Cannot reach repository over SSH (check the SSH key has access).',
        code: 'repo_unreachable',
      });
    }
    if (probe.branch) resolvedBranch = probe.branch;
  } catch (err) {
    return res.status(502).json({ error: `Repository probe failed: ${err.message}` });
  }

  // 2. Reuse env if any references this repo URL, else create a new one.
  let env = findEnvByRepoUrl(sshUrl);
  let envReused = !!env;

  if (!env) {
    const baseEnvId = `repo-${slugifyRepoSegment(org)}-${slugifyRepoSegment(repo)}` || 'repo';
    let envId = baseEnvId;
    let suffix = 2;
    while (loadEnvironment(envId)) {
      envId = `${baseEnvId}-${suffix++}`;
    }
    const llmBinding = pickDefaultLlmBinding();
    env = {
      id: envId,
      name: `${org}/${repo}`,
      description: `Quick-start environment for ${org}/${repo}`,
      skills: [],
      repositories: [{ url: sshUrl, branch: resolvedBranch, sshKeyId: chosenSshKeyId }],
      githubTokenId: chosenTokenId,
      ...llmBinding,
      additionalContext: '',
      createdAt: new Date().toISOString(),
    };
    saveEnvironment(envId, env);
  } else if (!env.githubTokenId) {
    // Existing env without a token — attach the chosen one so the clone works.
    env.githubTokenId = chosenTokenId;
    env.updatedAt = new Date().toISOString();
    saveEnvironment(env.id, env);
  }

  const llmWarning = env.llmEndpointId
    ? null
    : 'No LLM endpoint is registered. Register one under "LLM Endpoints" and bind it to the Working Environment before chatting — otherwise the agent will fail on its first message.';

  // 2. Reuse an existing standalone agent on this env, else create one.
  const existingAgent = findStandaloneAgentForEnv(env.id);
  if (existingAgent) {
    return res.status(200).json({
      reused: true,
      environment: { id: env.id, name: env.name, reused: envReused },
      agent: { id: existingAgent.id, displayName: existingAgent.displayName },
      ...(llmWarning ? { llmWarning } : {}),
    });
  }

  const baseAgentId = `${slugifyRepoSegment(repo)}-agent` || 'repo-agent';
  let agentId = baseAgentId;
  let agentSuffix = 2;
  while (fs.existsSync(path.join(AGENTS_DIR, agentId))) {
    agentId = `${baseAgentId}-${agentSuffix++}`;
  }
  const displayName = `${repo} Agent`;
  const systemPrompt = quickstartSystemPrompt(org, repo);

  let agentResp;
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: agentId,
        displayName,
        role: 'agent',
        systemPrompt,
        environmentId: env.id,
      }),
    });
    agentResp = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(agentResp);
  } catch (err) {
    return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }

  res.status(201).json({
    reused: false,
    environment: { id: env.id, name: env.name, reused: envReused },
    agent: { id: agentId, displayName },
    seed: agentResp,
    ...(llmWarning ? { llmWarning } : {}),
  });
});

/* ─── Team-Setup wizard ────────────────────────────────────────────────
 *
 * One-shot endpoint that materialises an entire team of role-specialised
 * agents from a small wizard payload. Reads role templates from the pool
 * (/pool/agent-templates/*.json), then in-order:
 *
 *   1. Validates input + checks credentials exist.
 *   2. Computes per-role envId/agentId from the team slug.
 *   3. Pre-flight collision check. mode="create" (default) refuses any
 *      pre-existing resource; mode="extend" skips them and adds the rest.
 *   4. Creates N envs (one per role) — saveEnvironment writes to disk.
 *   5. For each role, POSTs to orchestrator /internal/agents (extended
 *      protocol — accepts `team`, `sessionPolicy`, `triggers`).
 *   6. Pre-creates DM rooms with the admin user so trigger-driven runs
 *      have a destination from minute one.
 *   7. On any failure: rollback created envs + agents in reverse order.
 *
 * The orchestrator-side createAgent already handles the heavy lifting:
 * Matrix user provisioning, repo clone, workspace seeding, runner spawn.
 * This endpoint just orchestrates the *team-shaped* sequence around it.
 */

const TEAM_ID_RE = /^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/;

function listAgentTemplateIds() {
  try {
    return fs.readdirSync(AGENT_TEMPLATES_DIR)
      .filter(f => f.endsWith('.json') && /^[a-z0-9][a-z0-9-]*\.json$/.test(f))
      .map(f => f.slice(0, -5))
      .sort();
  } catch {
    return [];
  }
}

function loadAgentTemplate(id) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) return null;
  const p = path.join(AGENT_TEMPLATES_DIR, id + '.json');
  try {
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (err) {
    console.error(`[Team] Cannot load template ${id}: ${err.message}`);
    return null;
  }
}

// Substitute `{{varname}}` placeholders. Unknown vars stay literal so a
// rogue template field doesn't silently disappear into "undefined".
function applyTemplateVars(s, vars) {
  if (typeof s !== 'string') return s;
  return s.replace(/\{\{(\w+)\}\}/g, (_m, k) =>
    vars[k] !== undefined ? String(vars[k]) : `{{${k}}}`,
  );
}

// Read-only template summary for the wizard's role-cards step. Strips the
// long prompt text to keep the response small — wizard doesn't need it,
// the backend reads the canonical version at create time.
app.get('/api/agent-templates', (_req, res) => {
  const out = [];
  for (const id of listAgentTemplateIds()) {
    const t = loadAgentTemplate(id);
    if (!t) continue;
    out.push({
      id: t.id,
      displayName: t.displayName,
      description: t.description,
      icon: t.icon,
      category: t.category,
      sessionPolicy: t.sessionPolicy,
      envSuffix: t.envSuffix,
      defaultEnabled: t.defaultEnabled !== false,
      // Catalog v2 (#420): the normalised composition surface for the wizard's
      // stage picker + the Flow-Weaver (patternRole / stageAffinity / ports).
      ...normalizeTemplatePorts(t),
      triggerSummary: (t.triggers || []).map(tr => ({
        id: tr.id,
        type: tr.type,
        events: tr.events || null,
        cron: tr.cron || null,
        description: tr.description || null,
        intrinsic: tr.intrinsic === true,
        preCheckScript: tr.preCheckScript || null,
        preCheckEnvKeys: tr.preCheckEnv && typeof tr.preCheckEnv === 'object'
          ? Object.keys(tr.preCheckEnv)
          : [],
      })),
    });
  }
  res.json({ templates: out });
});

// Generic, role-agnostic team prompt. Each member can override this with
// its role-specific prompt; members that don't override inherit this text
// and pick up edits via /api/agents/:id PUT (systemPromptTemplate).
function defaultTeamPrompt(vars) {
  return [
    `You are a member of the team **${vars.teamName}**, which collaborates on the repository \`${vars.repoFullName}\`.`,
    ``,
    `Other team members may have different responsibilities (requirements gathering, implementation, reviews, documentation). Stay in your own role and do not overlap with the others.`,
    `When you create PRs, issues or comments on GitHub, use \`gh-as-agent\` so your identity is stamped cleanly.`,
  ].join('\n');
}

// GitHub label names accept basically anything except they must be 1–50
// chars, no leading/trailing whitespace, and our prompt embedding wants a
// plain identifier (no quotes / backticks / template syntax).
const READY_LABEL_RE = /^[^\s`"'{}<>][^\s`"'{}<>]{0,49}$/;
// Same shape for the dispatcher's output label — the Dispatcher applies
// this to issues it releases to the Developer team.
const DISPATCH_LABEL_RE = READY_LABEL_RE;
// WIP cap the Dispatcher enforces. Allow 1–50 — beyond that the load on
// the LLM / git side becomes a real concern and we'd want an explicit
// product decision rather than a slider.
const MAX_PARALLEL_MIN = 1;
const MAX_PARALLEL_MAX = 50;

// The wizard doesn't surface an LLM endpoint chooser yet. Without binding
// one on the env, the in-chat model picker shows "(no endpoint)" disabled
// for every team-member — which is how teams looked broken compared to
// hand-created agents (where the user picks an endpoint via the env editor).
// Pick the first registered endpoint as a silent default; its operator-set
// default model (or, as a backstop, the first entry in its catalogue) becomes
// the env-level default. The user can change either later.
function pickDefaultLlmBinding() {
  const endpoints = listLlmEndpoints();
  if (endpoints.length === 0) return { llmEndpointId: null, defaultModelId: null };
  const ep = endpoints[0];
  return {
    llmEndpointId: ep.id,
    defaultModelId: pickEndpointDefaultModel(ep),
  };
}

// Keep old name so existing call sites in Team-Setup still compile.
const defaultLlmEndpointForTeam = pickDefaultLlmBinding;

// Normalize the `roles` payload: accepts string[] (legacy/backward-compat)
// or Array<{id, count}> (new multi-instance shape). Returns an array of
// {id, count} objects with count clamped to [1, 10].
function normalizeRolesInput(raw) {
  if (!Array.isArray(raw)) return null;
  return raw.map(r => {
    if (typeof r === 'string') return { id: r, count: 1 };
    const id = typeof r.id === 'string' ? r.id : null;
    const count = Number.isInteger(r.count) && r.count >= 1 && r.count <= 10 ? r.count : 1;
    return { id, count };
  });
}

// Expand normalized roles into planned member entries. count=1 keeps the
// legacy `<teamId>-<roleId>` id; count>1 produces numbered suffixes.
function planMembers(teamId, normalizedRoles, loadTemplate) {
  const planned = [];
  for (const { id: roleId, count } of normalizedRoles) {
    const t = loadTemplate(roleId);
    if (count === 1) {
      planned.push({ roleId, template: t, memberId: `${teamId}-${roleId}`, instanceIndex: null });
    } else {
      for (let i = 1; i <= count; i++) {
        planned.push({ roleId, template: t, memberId: `${teamId}-${roleId}-${i}`, instanceIndex: i });
      }
    }
  }
  return planned;
}

// Build the `dataFlow` config block for a materialised member from its custom
// role's ports (#379). dependsOn role ids → member ids so the live graph
// connects members; artifact paths are global and pass through unchanged.
// Returns null when the role carries no ports (keeps ordinary teams clean).
function dataFlowForMember(template, teamId) {
  const inputs = Array.isArray(template?.inputs) ? template.inputs : [];
  const outputs = Array.isArray(template?.outputs) ? template.outputs : [];
  const dependsOn = Array.isArray(template?.dependsOn) ? template.dependsOn : [];
  if (!inputs.length && !outputs.length && !dependsOn.length) return null;
  return {
    dataFlow: {
      ...(inputs.length ? { inputs } : {}),
      ...(outputs.length ? { outputs } : {}),
      ...(dependsOn.length ? { dependsOn: dependsOn.map(d => `${teamId}-${d}`) } : {}),
    },
  };
}

app.post('/api/teams', heavyLimiter, async (req, res) => {
  const body = req.body || {};
  const { teamId, teamName, mcpServers } = body;
  // repository + githubTokenId may be supplied directly (legacy Team-Setup
  // wizard, which auto-creates an env) OR derived from a reused Working
  // Environment (environmentId, below) — so they are mutable here.
  let { repository, githubTokenId } = body;
  // A team can be materialised onto an existing Working Environment instead of
  // having one auto-created from a repo URL + credentials. When environmentId
  // is supplied we pull the repo/branch/credentials from that env and skip the
  // env-creation phase entirely.
  const environmentId = (typeof body.environmentId === 'string' && body.environmentId.trim())
    ? normalizeEnvId(body.environmentId)
    : null;
  const mode = body.mode === 'extend' ? 'extend' : 'create';
  // Deferred materialization: when false, members are created as stubs (config
  // + triggers only, no Matrix user / clone / process), shown in the UI and
  // materialized on demand via enable — same model as an orchestrator's
  // bp-instance stubs. Avoids dozens of clones up front for a large process.
  // Default true preserves the existing immediate-materialization behaviour.
  const materializeMembers = body.materializeMembers !== false;
  const readyLabel = (typeof body.readyLabel === 'string' && body.readyLabel.trim())
    ? body.readyLabel.trim()
    : 'ready';
  if (!READY_LABEL_RE.test(readyLabel)) {
    return res.status(400).json({
      error: 'readyLabel must be 1–50 chars and contain no whitespace or quote/brace characters',
    });
  }
  const dispatchLabel = (typeof body.dispatchLabel === 'string' && body.dispatchLabel.trim())
    ? body.dispatchLabel.trim()
    : 'dispatch';
  if (!DISPATCH_LABEL_RE.test(dispatchLabel)) {
    return res.status(400).json({
      error: 'dispatchLabel must be 1–50 chars and contain no whitespace or quote/brace characters',
    });
  }
  // GitHub label names are case-insensitive — `Dispatch` and `dispatch`
  // would collide despite passing a strict `===` check.
  if (dispatchLabel.toLowerCase() === readyLabel.toLowerCase()) {
    return res.status(400).json({
      error: 'dispatchLabel and readyLabel must differ — the Dispatcher needs a distinct label to release issues to the Developer',
    });
  }
  // Reject non-integer / out-of-range explicitly rather than silently
  // coercing — a stray `"3"` or `1.5` from the caller would otherwise be
  // swallowed and turned into the default, with no feedback.
  if (body.maxParallel !== undefined && !Number.isInteger(body.maxParallel)) {
    return res.status(400).json({
      error: `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`,
    });
  }
  const maxParallel = body.maxParallel ?? 1;
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    return res.status(400).json({
      error: `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`,
    });
  }

  // ── 1. Validate input ─────────────────────────────────────────────
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    return res.status(400).json({ error: 'teamId must be a lowercase slug, 1–40 chars, [a-z0-9-]' });
  }
  if (typeof teamName !== 'string' || !teamName.trim()) {
    return res.status(400).json({ error: 'teamName required' });
  }

  // Resolve a reused Working Environment (if any) into the repository +
  // credential inputs the rest of the pipeline expects. The env was validated
  // when it was created, so we trust its stored repo/token here.
  if (environmentId) {
    const reusedEnv = loadEnvironment(environmentId);
    if (!reusedEnv) {
      return res.status(400).json({ error: `Working environment '${environmentId}' not found` });
    }
    const repos = Array.isArray(reusedEnv.repositories)
      ? reusedEnv.repositories
      : (reusedEnv.repository ? [reusedEnv.repository] : []);
    const primary = repos[0];
    if (!primary?.url) {
      return res.status(400).json({ error: `Working environment '${environmentId}' has no repository configured` });
    }
    repository = { url: primary.url, branch: primary.branch || 'main', sshKeyId: primary.sshKeyId || null };
    githubTokenId = reusedEnv.githubTokenId || null;
  }

  if (!repository?.url) {
    return res.status(400).json({ error: 'repository.url required' });
  }
  // The legacy path (no environmentId) auto-creates an env from an SSH deploy
  // key, so sshKeyId stays mandatory there. A reused env may clone over HTTPS
  // with just a PAT, so sshKeyId is optional in that path.
  if (!environmentId && !repository.sshKeyId) {
    return res.status(400).json({ error: 'repository.url and repository.sshKeyId required' });
  }
  let parsed;
  try {
    parsed = parseGitHubUrl(repository.url);
  } catch (err) {
    return res.status(400).json({ error: `Invalid repository URL: ${err.message}` });
  }
  const branch = typeof repository.branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(repository.branch)
    ? repository.branch
    : 'main';

  // ── 2. Credentials must already exist (Pre-Flight) ────────────────
  if (repository.sshKeyId && !listSshKeys().some(k => k.id === repository.sshKeyId)) {
    return res.status(400).json({ error: `SSH key '${repository.sshKeyId}' not found` });
  }
  // The auto-created env path requires a GitHub PAT. A reused env may legitimately
  // carry none (e.g. SSH-only clone), so only validate a token when one is set.
  if (!environmentId) {
    if (typeof githubTokenId !== 'string' || !listGithubTokens().some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
  } else if (githubTokenId && !listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }

  // MCP refs are validated up-front so a bad serverId/credentialId aborts the
  // request before any agent/env/Matrix-user has been created.
  let normalizedMcpServers;
  try {
    normalizedMcpServers = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }

  // ── 3. Roles must map to known catalog templates OR inline custom roles ──
  // Inline roles come from an imported Process Canvas bundle (#334): either as
  // `customRoles` (pseudo-template shape) or a whole `processTemplate` bundle.
  // They are resolved exactly like catalog templates by the materialisation
  // loop below (var substitution over prompt + triggers).
  let customRolesRaw = Array.isArray(body.customRoles) ? body.customRoles : [];
  if (body.processTemplate) {
    const v = validateProcessTemplate(body.processTemplate);
    if (!v.ok) return res.status(400).json({ error: `Invalid processTemplate: ${v.error}` });
    // Expand GitHub channels (#380) into consumer github-event triggers + the
    // producer instruction block, then data-flow edges (#379) into `push`
    // triggers scoped to each upstream agent, before flattening to custom roles.
    // normalizeLegacyReview maps any legacy pr-review roles (#347) onto channels.
    customRolesRaw = templateToCustomRoles(
      expandDataFlowSteps(
        expandGithubChannels(normalizeLegacyReview(body.processTemplate), { teamId }),
        { teamId },
      )
    );
  }
  // Ordered stage names from the bundle — stored on the team agent so the live
  // graph reproduces the draft's stage layout (per-node stage rides on each
  // member's config; this is the column *order*).
  const bundleStages = Array.isArray(body.processTemplate?.stages)
    ? body.processTemplate.stages.filter(s => typeof s === 'string')
    : [];
  const customMap = new Map(customRolesRaw.map(r => [r.id, r]));
  const resolveTemplate = (id) => customMap.get(id) || loadAgentTemplate(id);

  // `roles` may be omitted when inline roles are supplied — synthesise it.
  let rolesInput = body.roles;
  if ((!Array.isArray(rolesInput) || rolesInput.length === 0) && customMap.size > 0) {
    rolesInput = [...customMap.keys()].map(id => ({ id, count: 1 }));
  }
  const normalizedRoles = normalizeRolesInput(rolesInput);
  if (!normalizedRoles || normalizedRoles.length === 0) {
    return res.status(400).json({ error: 'roles must be a non-empty array of template ids (or supply customRoles / processTemplate)' });
  }
  const knownIds = new Set(listAgentTemplateIds());
  const unknown = normalizedRoles.map(r => r.id).filter(id => !knownIds.has(id) && !customMap.has(id));
  if (unknown.length) {
    return res.status(400).json({
      error: `Unknown roles: ${unknown.join(', ')}`,
      knownRoles: [...knownIds],
    });
  }
  const seenRoleIds = new Set();
  for (const r of normalizedRoles) {
    if (seenRoleIds.has(r.id)) return res.status(400).json({ error: `Duplicate role id: ${r.id}` });
    seenRoleIds.add(r.id);
  }

  // ── 4. Plan resource ids ──────────────────────────────────────────
  // v2 shape: 1 env + 1 team agent + N team-members. Naming:
  //   env id        = teamId
  //   team agent id = teamId
  //   member id     = `<teamId>-<roleId>` (count=1) or `<teamId>-<roleId>-N` (count>1)
  // A reused Working Environment keeps its own id (env id != teamId); otherwise
  // the env is auto-created under the teamId.
  const envId = environmentId || teamId;
  const teamAgentId = teamId;
  const planned = planMembers(teamId, normalizedRoles, resolveTemplate);
  for (const p of planned) {
    if (!AGENT_ID_RE.test(p.memberId)) {
      return res.status(400).json({ error: `Computed memberId '${p.memberId}' is invalid` });
    }
  }

  const envExists = !!loadEnvironment(envId);
  // Inspect the existing agent (if any) so we can distinguish "an actual
  // team blocks this id" from "some unrelated agent (orchestrator,
  // bp-instance, plain agent) blocks this id". The first case is a real
  // collision the user can resolve via extend; the second is an id
  // conflict and `mode: extend` would be a lie.
  const existingTeamCfg = fs.existsSync(path.join(AGENTS_DIR, teamAgentId))
    ? readJsonFile(path.join(AGENTS_DIR, teamAgentId, 'config.json'), null)
    : null;
  const teamExists = !!existingTeamCfg && existingTeamCfg.role === 'team';
  const teamIdTakenByOther = !!existingTeamCfg && existingTeamCfg.role !== 'team';
  const existingMembers = planned
    .filter(p => fs.existsSync(path.join(AGENTS_DIR, p.memberId)))
    .map(p => p.memberId);

  if (teamIdTakenByOther) {
    return res.status(409).json({
      error: `Cannot use teamId '${teamId}': an agent with this id already exists ` +
        `with role '${existingTeamCfg.role}'. Pick a different teamId or delete ` +
        `the existing agent first.`,
    });
  }

  let toCreate;
  if (mode === 'extend') {
    if (!teamExists) {
      return res.status(409).json({
        error: `Cannot extend: team '${teamId}' does not exist yet. Use mode: "create" first.`,
      });
    }
    toCreate = planned.filter(p => !existingMembers.includes(p.memberId));
    if (toCreate.length === 0) {
      return res.status(200).json({
        teamId,
        teamName,
        created: [],
        skipped: planned.map(p => p.memberId),
        message: 'All requested roles already exist on this team; nothing to do.',
      });
    }
  } else {
    // Real collision = team or members exist. An env-only orphan is a
    // recoverable left-over from a prior aborted run (or an out-of-band
    // delete that didn't reap the env); silently reuse/overwrite it
    // instead of stranding the caller — same recovery the streaming
    // endpoint applies, kept in parity here.
    if (teamExists || existingMembers.length) {
      return res.status(409).json({
        error: 'Resources for this team already exist',
        existing: {
          env: envExists ? envId : null,
          team: teamExists ? teamAgentId : null,
          members: existingMembers,
        },
        suggestion: 'Pass `mode: "extend"` to add only the missing roles.',
      });
    }
    toCreate = planned;
  }
  // Never overwrite a deliberately reused environment — only adopt an orphan
  // env that was auto-created under this teamId by a prior aborted run.
  const adoptOrphanEnv = mode === 'create' && envExists && !environmentId;

  // ── 5. Substitution variables for templates ───────────────────────
  // When the team includes a Dispatcher, the Developer is wired to react
  // to the dispatch label. Without a Dispatcher, `{{dispatchLabel}}` falls
  // back to the ready label so the Developer still works on bare `ready`-
  // labeled issues (legacy single-stage flow).
  const hasDispatcher = normalizedRoles.some(r => r.id === 'dispatcher');
  const effectiveDispatchLabel = hasDispatcher ? dispatchLabel : readyLabel;
  const vars = {
    teamName,
    teamId,
    repoFullName: `${parsed.org}/${parsed.repo}`,
    repoOwner: parsed.org,
    repoName: parsed.repo,
    repoUrl: repository.url,
    branch,
    readyLabel,
    dispatchLabel: effectiveDispatchLabel,
    maxParallel,
  };

  // ── 6. Atomic create with rollback ────────────────────────────────
  // Track everything we created so we can undo cleanly. `extend` mode
  // tracks NOTHING from before our call — pre-existing env/team are
  // preserved on rollback even if the new members fail.
  const created = { env: null, team: null, members: [], dms: [] };
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  const rollback = async (reason) => {
    console.warn(`[Team] Rolling back ${teamId}: ${reason}`);
    for (const memberId of [...created.members].reverse()) {
      try {
        await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      } catch (err) {
        console.error(`[Team] Rollback: failed to delete member ${memberId}: ${err.message}`);
      }
    }
    if (created.team) {
      try {
        await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(created.team)}`, { method: 'DELETE' });
      } catch (err) {
        console.error(`[Team] Rollback: failed to delete team ${created.team}: ${err.message}`);
      }
    }
    if (created.env) {
      try {
        const environmentsRoot = path.resolve(ENVIRONMENTS_DIR);
        const envPath = path.resolve(environmentsRoot, String(created.env));
        if (envPath === environmentsRoot || envPath.startsWith(environmentsRoot + path.sep)) {
          fs.rmSync(envPath, { recursive: true, force: true });
        } else {
          console.error(`[Team] Rollback: refused to delete env outside root: ${created.env}`);
        }
      } catch (err) {
        console.error(`[Team] Rollback: failed to delete env ${created.env}: ${err.message}`);
      }
    }
  };

  try {
    // Phase A — single shared environment. Carries the repo, SSH key, PAT,
    // and the team-default skill set (empty in v1; the wizard's first
    // shipped Skill packs go here later).
    if (!envExists || adoptOrphanEnv) {
      const env = {
        id: envId,
        name: teamName,
        description: `Working environment for team '${teamName}'.`,
        skills: [],
        repositories: [{ url: parsed.httpsUrl, branch, sshKeyId: repository.sshKeyId }],
        githubTokenId,
        mcpServers: normalizedMcpServers,
        ...defaultLlmEndpointForTeam(),
        additionalContext: '',
        createdAt: new Date().toISOString(),
      };
      saveEnvironment(envId, env);
      created.env = envId;
    }

    // Phase B — the team agent itself. Generic shared prompt; suppress the
    // first-member auto-create (the wizard adds members itself with role
    // overrides in Phase C).
    if (!teamExists) {
      const teamPrompt = defaultTeamPrompt(vars);
      const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: teamAgentId,
          displayName: teamName,
          role: 'team',
          systemPrompt: teamPrompt,
          environmentId: envId,
          skipFirstMember: true,
          // Ordered stage names for the process graph's layered layout (#stage-order).
          ...(bundleStages.length ? { stages: bundleStages } : {}),
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(`Team agent ${teamAgentId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      created.team = teamAgentId;
    }

    // Phase C — team-members, one per selected role. Each one carries a
    // role-specific prompt override (so the team's generic prompt stays
    // useful as a fallback) and the role's full triggers.json.
    for (const p of toCreate) {
      const memberVars = { ...vars, agentId: p.memberId };
      const promptText = applyTemplateVars(p.template.promptTemplate, memberVars);
      const triggersOut = (p.template.triggers || []).map(tr => {
        const out = {
          id: tr.id,
          type: tr.type,
          enabled: tr.enabled !== false,
          description: tr.description || `${p.template.displayName} — ${tr.id}`,
          prompt: applyTemplateVars(tr.promptTemplate || '', memberVars),
        };
        if (tr.type === 'github-event') {
          out.events = tr.events || [];
          out.repo = vars.repoFullName;
          // Carry the optional label-name filter through if the template
          // defines one (e.g. developer.json pins it to the wizard's
          // {{readyLabel}} so the trigger fires only on that label).
          if (typeof tr.labelFilter === 'string' && tr.labelFilter.trim()) {
            out.labelFilter = applyTemplateVars(tr.labelFilter, memberVars);
          }
          // Data-flow (agent dependency) marker so the trigger UI renders it as
          // an editable "push from <upstream>" hand-off rather than a raw push.
          if (tr.dataFlow) out.dataFlow = true;
          // GitHub-channel marker (#380) so reconciliation can regenerate it and
          // the graph builders skip it (the on:'github' edge comes from the port).
          if (tr.channel) out.channel = true;
          // Stamp the history horizon (#320/#446) on EVERY github-event trigger,
          // authored and derived, so the poller starts fresh members from "now"
          // instead of the volatile triggers.json mtime. Reconciliation preserves
          // this activatedAt when it regenerates channel/dataFlow triggers
          // (stampDerivedActivation), so a later triggers.json rewrite can't push
          // the horizon forward and drop pending events.
          {
            const now = new Date().toISOString();
            out.createdAt = now;
            out.activatedAt = now;
          }
        } else if (tr.type === 'cron') {
          out.cron = tr.cron;
        }
        // Carry pre-check script fields (used by the bid-loop cron trigger).
        if (tr.preCheckScript) {
          out.preCheckScript = tr.preCheckScript;
        }
        if (tr.preCheckEnv && typeof tr.preCheckEnv === 'object') {
          out.preCheckEnv = Object.fromEntries(
            Object.entries(tr.preCheckEnv).map(([k, v]) => [k, applyTemplateVars(v, memberVars)])
          );
        }
        // Carry the optional declarative `emits` set through (Process Canvas
        // #328) — the labels this trigger's run is expected to set. Template
        // tokens (e.g. `started:{{agentId}}`) are resolved per-member.
        if (Array.isArray(tr.emits)) {
          out.emits = tr.emits.map(e => applyTemplateVars(String(e), memberVars));
        }
        return out;
      });

      // Member display name is the role name only (optionally numbered for
      // multi-instance roles). The parent team name is intentionally NOT
      // prepended — UIs already group members under their team, so prefixing
      // would just duplicate the team name and make every label long.
      const memberDisplayName = p.instanceIndex !== null
        ? `${p.template.displayName} ${p.instanceIndex}`
        : p.template.displayName;
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamAgentId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: p.memberId,
          displayName: memberDisplayName,
          systemPromptOverride: promptText,
          // skillsOverride deliberately omitted in v1 — members inherit the
          // team-env's empty skill list. Once we ship role-specific Skill
          // packs they'll plug in here.
          sessionPolicy: p.template.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
          triggers: triggersOut,
          // BP data-flow ports (#379), recorded on the member config so the live
          // graph renders dependency/artifact edges. dependsOn role ids are
          // mapped to member ids (`<teamId>-<roleId>`) so the graph connects
          // members; artifact paths match across nodes unchanged.
          ...(dataFlowForMember(p.template, teamId) || {}),
          // Parent-child hierarchy: map the role's parent id → member id so the
          // agent overview + live graph render the tree like an orchestrator.
          ...(typeof p.template.parent === 'string' && p.template.parent
            ? { parentMemberId: `${teamId}-${p.template.parent}` } : {}),
          // Agent-level emitted labels (label hand-offs) — recorded on config.
          ...(Array.isArray(p.template.emits) && p.template.emits.length
            ? { emits: p.template.emits } : {}),
          // Process stage band — recorded on config so the live graph reproduces
          // the draft's stage layout (the top-level order lives on the team).
          ...(typeof p.template.stage === 'string' && p.template.stage
            ? { stage: p.template.stage } : {}),
          // GitHub artifact ports (#380): produce flags verbatim; channel `from`
          // role ids mapped to member ids (`<teamId>-<roleId>`) so the live graph
          // connects members. The derived consumer triggers are already in
          // triggersOut (from expandGithubChannels).
          ...(p.template.github && (p.template.github.producesPr || p.template.github.producesIssue)
            ? { github: p.template.github } : {}),
          ...(Array.isArray(p.template.channels) && p.template.channels.length
            ? { channels: p.template.channels.map(c => ({ ...c, from: `${teamId}-${c.from}` })) } : {}),
          // Deferred materialization — create as a stub when requested.
          materialize: materializeMembers,
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        throw new Error(`Member ${p.memberId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      // Same clone-warning-as-fatal treatment as the streaming endpoint —
      // a wizard-created team without its repo is a broken setup, not a
      // graceful degradation.
      const cloneWarning = (data.warnings || []).find(w => /^git clone /.test(w));
      if (cloneWarning) {
        created.members.push(p.memberId);
        throw new Error(`Member ${p.memberId}: ${cloneWarning}`);
      }
      created.members.push(p.memberId);
    }

    // Phase D — DM rooms (best-effort). Members without DMs miss trigger
    // output until a chat is opened; we keep going on failure. Skipped for
    // deferred (stub) members — they have no Matrix user yet; the DM room is
    // created when the stub is materialized + a chat is opened.
    if (materializeMembers) {
      for (const p of toCreate) {
        try {
          const r = await ensureAgentDmRoom(p.memberId);
          created.dms.push({ agentId: p.memberId, roomId: r.roomId });
        } catch (err) {
          console.warn(`[Team] DM pre-create skipped for ${p.memberId}: ${err.message}`);
        }
      }
    }

    res.status(201).json({
      teamId,
      teamName,
      env: envId,
      team: teamAgentId,
      created: created.members,
      materialized: materializeMembers,
      skipped: planned
        .filter(p => !toCreate.some(c => c.memberId === p.memberId))
        .map(p => p.memberId),
      dms: created.dms,
    });
  } catch (err) {
    await rollback(err.message);
    res.status(500).json({ error: `Team creation failed: ${err.message}` });
  }
});

/* ─── Team setup — streaming variant ────────────────────────────────────
   Same input/output as POST /api/teams, but emits NDJSON progress events
   as the materialization proceeds. The frontend uses this for the live
   progress UI in the Team-Setup wizard. */

app.post('/api/teams/stream', heavyLimiter, async (req, res) => {
  // Plain NDJSON over chunked transfer; no SSE wrapping. The wizard reads
  // chunks via the fetch streams API and parses one JSON object per line.
  res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store, no-transform');
  res.setHeader('X-Accel-Buffering', 'no');
  // Send headers + open the chunked body NOW. Without this, Node holds the
  // response open until enough body bytes accumulate, so the wizard sees no
  // events for the entire ~10s the team-agent clone takes — and then every
  // queued event arrives in one burst when the request ends.
  res.flushHeaders();
  // Keep the underlying socket free of Nagle batching so each per-step
  // write hits the wire immediately instead of waiting up to 200ms for a
  // companion packet that never comes (every event is its own short line).
  if (typeof res.socket?.setNoDelay === 'function') {
    res.socket.setNoDelay(true);
  }

  // Track whether the *socket* is gone, not whether the request body has
  // been fully consumed. `req.on('close')` fires as soon as Node finishes
  // reading the body — which happens right after `express.json()` runs,
  // i.e. before our handler even reaches the first await. Listening on it
  // would short-circuit every write past that point. `res.on('close')`
  // fires only on actual client disconnect (or after we've called res.end
  // ourselves), which is what we actually want.
  let aborted = false;
  res.on('close', () => {
    if (!res.writableEnded) aborted = true;
  });

  function emit(ev) {
    if (aborted) return;
    try {
      res.write(JSON.stringify(ev) + '\n');
    } catch { /* socket gone */ }
  }
  function fail(status, errorMsg) {
    emit({ type: 'error', status, error: errorMsg });
    if (!aborted) res.end();
  }

  const body = req.body || {};
  const { teamId, teamName, mcpServers } = body;
  // See POST /api/teams: repository/githubTokenId are mutable so they can be
  // derived from a reused Working Environment (environmentId).
  let { repository, githubTokenId } = body;
  const environmentId = (typeof body.environmentId === 'string' && body.environmentId.trim())
    ? normalizeEnvId(body.environmentId)
    : null;
  const mode = body.mode === 'extend' ? 'extend' : 'create';
  const readyLabel = (typeof body.readyLabel === 'string' && body.readyLabel.trim())
    ? body.readyLabel.trim()
    : 'ready';
  const dispatchLabel = (typeof body.dispatchLabel === 'string' && body.dispatchLabel.trim())
    ? body.dispatchLabel.trim()
    : 'dispatch';

  // ── 1. Validate input ─────────────────────────────────────────────
  if (!READY_LABEL_RE.test(readyLabel)) {
    return fail(400, 'readyLabel must be 1–50 chars and contain no whitespace or quote/brace characters');
  }
  if (!DISPATCH_LABEL_RE.test(dispatchLabel)) {
    return fail(400, 'dispatchLabel must be 1–50 chars and contain no whitespace or quote/brace characters');
  }
  // GitHub label names are case-insensitive — `Dispatch` and `dispatch`
  // would collide despite passing a strict `===` check.
  if (dispatchLabel.toLowerCase() === readyLabel.toLowerCase()) {
    return fail(400, 'dispatchLabel and readyLabel must differ — the Dispatcher needs a distinct label to release issues to the Developer');
  }
  // Reject non-integer / out-of-range explicitly rather than silently
  // coercing — a stray `"3"` or `1.5` from the caller would otherwise be
  // swallowed and turned into the default, with no feedback.
  if (body.maxParallel !== undefined && !Number.isInteger(body.maxParallel)) {
    return fail(400, `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`);
  }
  const maxParallel = body.maxParallel ?? 1;
  if (maxParallel < MAX_PARALLEL_MIN || maxParallel > MAX_PARALLEL_MAX) {
    return fail(400, `maxParallel must be an integer in [${MAX_PARALLEL_MIN}, ${MAX_PARALLEL_MAX}]`);
  }
  if (typeof teamId !== 'string' || !TEAM_ID_RE.test(teamId)) {
    return fail(400, 'teamId must be a lowercase slug, 1–40 chars, [a-z0-9-]');
  }
  if (typeof teamName !== 'string' || !teamName.trim()) {
    return fail(400, 'teamName required');
  }

  // Reuse an existing Working Environment when environmentId is supplied.
  if (environmentId) {
    const reusedEnv = loadEnvironment(environmentId);
    if (!reusedEnv) {
      return fail(400, `Working environment '${environmentId}' not found`);
    }
    const repos = Array.isArray(reusedEnv.repositories)
      ? reusedEnv.repositories
      : (reusedEnv.repository ? [reusedEnv.repository] : []);
    const primary = repos[0];
    if (!primary?.url) {
      return fail(400, `Working environment '${environmentId}' has no repository configured`);
    }
    repository = { url: primary.url, branch: primary.branch || 'main', sshKeyId: primary.sshKeyId || null };
    githubTokenId = reusedEnv.githubTokenId || null;
  }

  if (!repository?.url) {
    return fail(400, 'repository.url required');
  }
  if (!environmentId && !repository.sshKeyId) {
    return fail(400, 'repository.url and repository.sshKeyId required');
  }
  let parsed;
  try {
    parsed = parseGitHubUrl(repository.url);
  } catch (err) {
    return fail(400, `Invalid repository URL: ${err.message}`);
  }
  const branch = typeof repository.branch === 'string' && /^[A-Za-z0-9._/-]+$/.test(repository.branch)
    ? repository.branch
    : 'main';

  if (repository.sshKeyId && !listSshKeys().some(k => k.id === repository.sshKeyId)) {
    return fail(400, `SSH key '${repository.sshKeyId}' not found`);
  }
  if (!environmentId) {
    if (typeof githubTokenId !== 'string' || !listGithubTokens().some(t => t.id === githubTokenId)) {
      return fail(400, `GitHub token '${githubTokenId}' not found`);
    }
  } else if (githubTokenId && !listGithubTokens().some(t => t.id === githubTokenId)) {
    return fail(400, `GitHub token '${githubTokenId}' not found`);
  }
  let normalizedMcpServers;
  try {
    normalizedMcpServers = normalizeMcpServersInput(mcpServers);
  } catch (err) {
    return fail(400, err.message);
  }
  // Inline roles (parity with POST /api/teams): either `customRoles` or a whole
  // `processTemplate` bundle (Process Canvas import / wizard Process step, #422).
  let customRolesRaw = Array.isArray(body.customRoles) ? body.customRoles : [];
  if (body.processTemplate) {
    const v = validateProcessTemplate(body.processTemplate);
    if (!v.ok) return fail(400, `Invalid processTemplate: ${v.error}`);
    customRolesRaw = templateToCustomRoles(
      expandDataFlowSteps(
        expandGithubChannels(normalizeLegacyReview(body.processTemplate), { teamId }),
        { teamId },
      )
    );
  }
  const bundleStages = Array.isArray(body.processTemplate?.stages)
    ? body.processTemplate.stages.filter(s => typeof s === 'string')
    : [];
  const customMap = new Map(customRolesRaw.map(r => [r.id, r]));
  const resolveTemplate = (id) => customMap.get(id) || loadAgentTemplate(id);

  let rolesInput = body.roles;
  if ((!Array.isArray(rolesInput) || rolesInput.length === 0) && customMap.size > 0) {
    rolesInput = [...customMap.keys()].map(id => ({ id, count: 1 }));
  }
  const normalizedRoles = normalizeRolesInput(rolesInput);
  if (!normalizedRoles || normalizedRoles.length === 0) {
    return fail(400, 'roles must be a non-empty array of template ids (or supply customRoles / processTemplate)');
  }
  const knownIds = new Set(listAgentTemplateIds());
  const unknown = normalizedRoles.map(r => r.id).filter(id => !knownIds.has(id) && !customMap.has(id));
  if (unknown.length) {
    return fail(400, `Unknown roles: ${unknown.join(', ')}`);
  }
  const seenRoleIds = new Set();
  for (const r of normalizedRoles) {
    if (seenRoleIds.has(r.id)) return fail(400, `Duplicate role id: ${r.id}`);
    seenRoleIds.add(r.id);
  }

  // ── 2. Plan ───────────────────────────────────────────────────────
  // A reused Working Environment keeps its own id; otherwise auto-create under teamId.
  const envId = environmentId || teamId;
  const teamAgentId = teamId;
  const planned = planMembers(teamId, normalizedRoles, resolveTemplate);
  for (const p of planned) {
    if (!AGENT_ID_RE.test(p.memberId)) {
      return fail(400, `Computed memberId '${p.memberId}' is invalid`);
    }
  }

  const envExists = !!loadEnvironment(envId);
  // Distinguish "the id is taken by an actual team" (extend can recover)
  // from "the id is taken by some unrelated agent role" (extend is a lie,
  // surface the real conflict).
  const agentsRoot = path.resolve(AGENTS_DIR);
  const teamAgentPath = path.resolve(agentsRoot, teamAgentId);
  if (!(teamAgentPath === agentsRoot || teamAgentPath.startsWith(agentsRoot + path.sep))) {
    return fail(400, 'Invalid teamId path');
  }
  const existingTeamCfg = fs.existsSync(teamAgentPath)
    ? readJsonFile(path.join(teamAgentPath, 'config.json'), null)
    : null;
  const teamExists = !!existingTeamCfg && existingTeamCfg.role === 'team';
  const teamIdTakenByOther = !!existingTeamCfg && existingTeamCfg.role !== 'team';
  const existingMembers = planned
    .filter((p) => {
      const memberPath = path.resolve(agentsRoot, p.memberId);
      const inAgentsDir =
        memberPath === agentsRoot || memberPath.startsWith(agentsRoot + path.sep);
      if (!inAgentsDir) {
        fail(400, `Computed memberId '${p.memberId}' resolves outside AGENTS_DIR`);
        return false;
      }
      return fs.existsSync(memberPath);
    })
    .map(p => p.memberId);

  if (teamIdTakenByOther) {
    return fail(409,
      `Cannot use teamId '${teamId}': an agent with this id already exists ` +
      `with role '${existingTeamCfg.role}'. Pick a different teamId or delete ` +
      `the existing agent first.`);
  }

  let toCreate;
  if (mode === 'extend') {
    if (!teamExists) {
      return fail(409, `Cannot extend: team '${teamId}' does not exist yet. Use mode: "create" first.`);
    }
    toCreate = planned.filter(p => !existingMembers.includes(p.memberId));
    if (toCreate.length === 0) {
      emit({
        type: 'complete',
        result: {
          teamId, teamName,
          created: [],
          skipped: planned.map(p => p.memberId),
          message: 'All requested roles already exist on this team; nothing to do.',
        },
      });
      return res.end();
    }
  } else {
    // Real collision = team or members already exist (the user actually
    // has a working team to deal with). An ENV-ONLY orphan is a different
    // beast: it's left over from a prior aborted create / out-of-band
    // delete and there's no UI path to clean it up. Blocking mode:create
    // on it strands the user (the original wizard freeze report). Recover
    // by reusing/overwriting it instead — the user's freshly submitted
    // settings win, and we adopt the env so rollback removes it cleanly
    // if the rest of the create fails.
    if (teamExists || existingMembers.length) {
      emit({
        type: 'collision',
        existing: {
          env: envExists ? envId : null,
          team: teamExists ? teamAgentId : null,
          members: existingMembers,
        },
        suggestion: 'Pass `mode: "extend"` to add only the missing roles.',
      });
      return res.end();
    }
    toCreate = planned;
  }

  // ── 3. Substitution variables for templates ───────────────────────
  // When the team includes a Dispatcher, the Developer is wired to react
  // to the dispatch label. Without a Dispatcher, `{{dispatchLabel}}` falls
  // back to the ready label so the Developer still works on bare `ready`-
  // labeled issues (legacy single-stage flow).
  const hasDispatcher = normalizedRoles.some(r => r.id === 'dispatcher');
  const effectiveDispatchLabel = hasDispatcher ? dispatchLabel : readyLabel;
  const vars = {
    teamName, teamId,
    repoFullName: `${parsed.org}/${parsed.repo}`,
    repoOwner: parsed.org, repoName: parsed.repo,
    repoUrl: repository.url,
    branch, readyLabel,
    dispatchLabel: effectiveDispatchLabel,
    maxParallel,
  };

  // Adopt-orphan: in mode:create the env may already exist as a leftover
  // (no team, no members). Treat it as a step we own — overwrite with the
  // user's submitted settings and include it in the rollback set. A
  // deliberately reused env (environmentId) is never overwritten.
  const adoptOrphanEnv = mode === 'create' && envExists && !environmentId;

  // ── 4. Announce the plan up front so the wizard can render every
  // step as `pending` — gives the user the full progress shape, not a
  // tickertape that only reveals work as it happens.
  const plan = [];
  if (!envExists || adoptOrphanEnv) {
    plan.push({
      id: 'env',
      label: adoptOrphanEnv
        ? `Reuse working environment (${envId})`
        : `Create working environment (${envId})`,
    });
  }
  if (!teamExists) plan.push({ id: 'team', label: `Create team agent (${teamAgentId})` });
  for (const p of toCreate) {
    plan.push({ id: `member:${p.memberId}`, label: `Create member: ${p.template.displayName}` });
  }
  if (toCreate.length > 0) plan.push({ id: 'dms', label: 'Pre-create DM rooms' });
  emit({ type: 'plan', steps: plan });

  // ── 5. Atomic create with rollback ────────────────────────────────
  const created = { env: null, team: null, members: [], dms: [] };
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  const rollback = async (reason) => {
    console.warn(`[Team:stream] Rolling back ${teamId}: ${reason}`);
    for (const memberId of [...created.members].reverse()) {
      try {
        await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(memberId)}`, { method: 'DELETE' });
      } catch (err) {
        console.error(`[Team:stream] Rollback: failed to delete member ${memberId}: ${err.message}`);
      }
    }
    if (created.team) {
      try {
        await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(created.team)}`, { method: 'DELETE' });
      } catch (err) {
        console.error(`[Team:stream] Rollback: failed to delete team ${created.team}: ${err.message}`);
      }
    }
    if (created.env) {
      try {
        fs.rmSync(path.join(ENVIRONMENTS_DIR, created.env), { recursive: true, force: true });
      } catch (err) {
        console.error(`[Team:stream] Rollback: failed to delete env ${created.env}: ${err.message}`);
      }
    }
  };

  try {
    if (!envExists || adoptOrphanEnv) {
      emit({ type: 'step', id: 'env', status: 'running' });
      const env = {
        id: envId,
        name: teamName,
        description: `Working environment for team '${teamName}'.`,
        skills: [],
        repositories: [{ url: parsed.httpsUrl, branch, sshKeyId: repository.sshKeyId }],
        githubTokenId,
        mcpServers: normalizedMcpServers,
        ...defaultLlmEndpointForTeam(),
        additionalContext: '',
        createdAt: new Date().toISOString(),
      };
      saveEnvironment(envId, env);
      created.env = envId;
      emit({ type: 'step', id: 'env', status: 'done' });
    }

    if (!teamExists) {
      emit({ type: 'step', id: 'team', status: 'running' });
      const teamPrompt = defaultTeamPrompt(vars);
      const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: teamAgentId,
          displayName: teamName,
          role: 'team',
          systemPrompt: teamPrompt,
          environmentId: envId,
          skipFirstMember: true,
          // Ordered stage names for the process graph's layered layout.
          ...(bundleStages.length ? { stages: bundleStages } : {}),
        }),
      });
      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        throw new Error(`Team agent ${teamAgentId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      created.team = teamAgentId;
      emit({ type: 'step', id: 'team', status: 'done' });
    }

    for (const p of toCreate) {
      const stepId = `member:${p.memberId}`;
      emit({ type: 'step', id: stepId, status: 'running' });
      const memberVars = { ...vars, agentId: p.memberId };
      const promptText = applyTemplateVars(p.template.promptTemplate, memberVars);
      const triggersOut = (p.template.triggers || []).map(tr => {
        const out = {
          id: tr.id,
          type: tr.type,
          enabled: tr.enabled !== false,
          description: tr.description || `${p.template.displayName} — ${tr.id}`,
          prompt: applyTemplateVars(tr.promptTemplate || '', memberVars),
        };
        if (tr.type === 'github-event') {
          out.events = tr.events || [];
          out.repo = vars.repoFullName;
          // Carry the optional label-name filter through if the template
          // defines one (e.g. developer.json pins it to the wizard's
          // {{readyLabel}} so the trigger fires only on that label).
          if (typeof tr.labelFilter === 'string' && tr.labelFilter.trim()) {
            out.labelFilter = applyTemplateVars(tr.labelFilter, memberVars);
          }
          // Data-flow (agent dependency) marker so the trigger UI renders it as
          // an editable "push from <upstream>" hand-off rather than a raw push.
          if (tr.dataFlow) out.dataFlow = true;
          // GitHub-channel marker (#380) so reconciliation can regenerate it and
          // the graph builders skip it (the on:'github' edge comes from the port).
          if (tr.channel) out.channel = true;
          // Stamp the history horizon (#320/#446) on EVERY github-event trigger,
          // authored and derived, so the poller starts fresh members from "now"
          // instead of the volatile triggers.json mtime. Reconciliation preserves
          // this activatedAt when it regenerates channel/dataFlow triggers
          // (stampDerivedActivation), so a later triggers.json rewrite can't push
          // the horizon forward and drop pending events.
          {
            const now = new Date().toISOString();
            out.createdAt = now;
            out.activatedAt = now;
          }
        } else if (tr.type === 'cron') {
          out.cron = tr.cron;
        }
        // Carry pre-check script fields (used by the bid-loop cron trigger).
        if (tr.preCheckScript) {
          out.preCheckScript = tr.preCheckScript;
        }
        if (tr.preCheckEnv && typeof tr.preCheckEnv === 'object') {
          out.preCheckEnv = Object.fromEntries(
            Object.entries(tr.preCheckEnv).map(([k, v]) => [k, applyTemplateVars(v, memberVars)])
          );
        }
        // Carry the optional declarative `emits` set through (Process Canvas
        // #328) — the labels this trigger's run is expected to set. Template
        // tokens (e.g. `started:{{agentId}}`) are resolved per-member.
        if (Array.isArray(tr.emits)) {
          out.emits = tr.emits.map(e => applyTemplateVars(String(e), memberVars));
        }
        return out;
      });

      // Member display name is the role name only (optionally numbered for
      // multi-instance roles). The parent team name is intentionally NOT
      // prepended — UIs already group members under their team, so prefixing
      // would just duplicate the team name and make every label long.
      const memberDisplayName = p.instanceIndex !== null
        ? `${p.template.displayName} ${p.instanceIndex}`
        : p.template.displayName;
      const resp = await fetch(`${orchestratorUrl}/internal/teams/${encodeURIComponent(teamAgentId)}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: p.memberId,
          displayName: memberDisplayName,
          systemPromptOverride: promptText,
          sessionPolicy: p.template.sessionPolicy === 'per-invocation' ? 'per-invocation' : undefined,
          triggers: triggersOut,
          // Declarative ports (parity with POST /api/teams): data-flow (#379),
          // hierarchy (#377), agent-level emits, stage band, GitHub ports (#380).
          ...(dataFlowForMember(p.template, teamId) || {}),
          ...(typeof p.template.parent === 'string' && p.template.parent
            ? { parentMemberId: `${teamId}-${p.template.parent}` } : {}),
          ...(Array.isArray(p.template.emits) && p.template.emits.length
            ? { emits: p.template.emits } : {}),
          ...(typeof p.template.stage === 'string' && p.template.stage
            ? { stage: p.template.stage } : {}),
          ...(p.template.github && (p.template.github.producesPr || p.template.github.producesIssue)
            ? { github: p.template.github } : {}),
          ...(Array.isArray(p.template.channels) && p.template.channels.length
            ? { channels: p.template.channels.map(c => ({ ...c, from: `${teamId}-${c.from}` })) } : {}),
        }),
      });
      const data = await resp.json().catch(() => ({}));
      if (!resp.ok) {
        emit({ type: 'step', id: stepId, status: 'error', error: data.error || `HTTP ${resp.status}` });
        throw new Error(`Member ${p.memberId}: ${data.error || `HTTP ${resp.status}`}`);
      }
      // The orchestrator's seedAgentWorkspace catches clone failures into a
      // `warnings` array rather than throwing, because some seed steps are
      // genuinely optional (skill copies, missing template files). For a
      // wizard-created team though, the repo IS load-bearing — an agent
      // without its repo is a mute box. Treat any clone warning as fatal
      // so the user gets a real error in the progress card and the
      // half-baked team gets rolled back, instead of a green "ready" with
      // empty workspaces.
      const cloneWarning = (data.warnings || []).find(w => /^git clone /.test(w));
      if (cloneWarning) {
        emit({ type: 'step', id: stepId, status: 'error', error: cloneWarning });
        // Track the member so rollback removes its half-built state.
        created.members.push(p.memberId);
        throw new Error(`Member ${p.memberId}: ${cloneWarning}`);
      }
      created.members.push(p.memberId);
      emit({ type: 'step', id: stepId, status: 'done' });
    }

    if (toCreate.length > 0) {
      emit({ type: 'step', id: 'dms', status: 'running' });
      for (const p of toCreate) {
        try {
          const r = await ensureAgentDmRoom(p.memberId);
          created.dms.push({ agentId: p.memberId, roomId: r.roomId });
        } catch (err) {
          console.warn(`[Team:stream] DM pre-create skipped for ${p.memberId}: ${err.message}`);
        }
      }
      emit({ type: 'step', id: 'dms', status: 'done' });
    }

    emit({
      type: 'complete',
      result: {
        teamId, teamName,
        env: envId,
        team: teamAgentId,
        created: created.members,
        skipped: planned
          .filter(p => !toCreate.some(c => c.memberId === p.memberId))
          .map(p => p.memberId),
        dms: created.dms,
      },
    });
    res.end();
  } catch (err) {
    await rollback(err.message);
    emit({ type: 'error', status: 500, error: `Team creation failed: ${err.message}` });
    if (!aborted) res.end();
  }
});

/* ─── Blueprints ────────────────────────────────────────────────────── */

app.get('/api/blueprints', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/blueprints', heavyLimiter, async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, briefingsPath } = req.body || {};
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  // Teams may be created without a default prompt — members can carry their
  // own per-role prompts, and the orchestrator stores an empty template.
  if (!systemPrompt && role !== 'orchestrator' && role !== 'team') {
    return res.status(400).json({ error: 'systemPrompt is required for non-orchestrator agents' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, displayName, role, systemPrompt, environmentId, briefingsPath }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/blueprints/:id', apiLimiter, async (req, res) => {
  const { displayName, role, systemPrompt } = req.body || {};
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ displayName, role, systemPrompt }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/blueprints/:id', apiLimiter, async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}`, {
      method: 'DELETE',
    });
    if (resp.status === 200 || resp.status === 204) return res.status(204).end();
    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/blueprints/:id/instances', heavyLimiter, async (req, res) => {
  const { instanceId, displayName } = req.body || {};
  if (!instanceId || !displayName) {
    return res.status(400).json({ error: 'instanceId and displayName required' });
  }
  const bpId = req.params.id;
  if (!BP_PARAM_RE.test(bpId)) return res.status(400).json({ error: 'invalid blueprint id' });
  const normalizedId = instanceId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalizedId) {
    return res.status(400).json({ error: 'instanceId must contain at least one valid character (a-z, 0-9, -)' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/instances`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ instanceId: normalizedId, displayName }),
      }
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.get('/api/blueprints/:id/memory/:file', apiLimiter, async (req, res) => {
  const bpId = req.params.id;
  const bpFile = req.params.file;
  if (!BP_PARAM_RE.test(bpId) || !BP_FILE_RE.test(bpFile)) {
    return res.status(400).json({ error: 'invalid blueprint id or file' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/memory/${encodeURIComponent(bpFile)}`
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Not found' });
    const content = await resp.text();
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/blueprints/:id/memory/:file', apiLimiter, express.text({ type: '*/*' }), async (req, res) => {
  const bpId = req.params.id;
  const bpFile = req.params.file;
  if (!BP_PARAM_RE.test(bpId) || !BP_FILE_RE.test(bpFile)) {
    return res.status(400).json({ error: 'invalid blueprint id or file' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(bpId)}/memory/${encodeURIComponent(bpFile)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'text/plain' },
        body: typeof req.body === 'string' ? req.body : JSON.stringify(req.body),
      }
    );
    const data = await resp.json().catch(() => ({}));
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── SSH Keys ──────────────────────────────────────────────────────── */

app.get('/api/ssh-keys', (req, res) => {
  // Return only metadata — never the private key
  const scope = getScope(req);
  res.json(listSshKeys().filter(k => visibleTeam(scope, k.teamId))); // (#302)
});

app.post('/api/ssh-keys', apiLimiter, (req, res) => {
  const { name, privateKey, id: rawId, teamId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!privateKey || typeof privateKey !== 'string') {
    return res.status(400).json({ error: 'privateKey (string) is required' });
  }
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const trimmed = privateKey.trim();
  if (!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(trimmed)) {
    return res.status(400).json({ error: 'privateKey does not look like an SSH private key' });
  }

  const existing = listSshKeys();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(k => k.id === id)) return res.status(409).json({ error: `SSH key id '${id}' already exists` });
  } else {
    // Generate a stable, filesystem-safe id from the name
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `key-${Date.now()}`;
    if (existing.some(k => k.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  // Re-check the derived id against the strict allowlist — the .replace
  // chain above is correct, but the explicit regex test is what CodeQL
  // recognises as a path-injection sanitizer.
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });

  const keyPath = path.join(SSH_KEYS_DIR, path.basename(id));
  fs.writeFileSync(keyPath, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    fingerprint: sshKeyFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveSshKeysIndex([...existing, entry]);
  res.status(201).json(entry);
});

// Server-side keypair generation. Returns the public key once so the user
// can paste it into GitHub; the private key never leaves the workspace.
app.post('/api/ssh-keys/generate', heavyLimiter, (req, res) => {
  const { name, comment, id: rawId, teamId } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name is required' });
  }
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const existing = listSshKeys();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(k => k.id === id)) return res.status(409).json({ error: `SSH key id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `key-${Date.now()}`;
    if (existing.some(k => k.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }

  const safeComment = (typeof comment === 'string' && comment.trim()) || `aee-${id}`;
  const { privateKey: privText, publicKey: pubText, pubBlob } = generateOpensshEd25519Keypair(safeComment);

  // Inline regex test directly before path.join so CodeQL recognises the
  // path-injection sanitizer (same pattern as POST /api/ssh-keys above).
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const keyPath = path.join(SSH_KEYS_DIR, path.basename(id));
  fs.writeFileSync(keyPath, privText, { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    fingerprint: sshFingerprintFromPubBlob(pubBlob),
    createdAt: new Date().toISOString(),
  };
  saveSshKeysIndex([...existing, entry]);
  res.status(201).json({ ...entry, publicKey: pubText });
});

app.delete('/api/ssh-keys/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const keys = listSshKeys();
  if (!keys.some(k => k.id === id)) return res.status(404).json({ error: 'SSH key not found' });
  const usedBy = sshKeyInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `SSH key is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(SSH_KEYS_DIR, path.basename(id))); } catch { /* ignore */ }
  saveSshKeysIndex(keys.filter(k => k.id !== id));
  res.status(204).end();
});

/* ─── GitHub Tokens ─────────────────────────────────────────────────── */

app.get('/api/github-tokens', (req, res) => {
  // Metadata only — never the raw token
  const scope = getScope(req);
  res.json(listGithubTokens().filter(t => visibleTeam(scope, t.teamId))); // (#302)
});

app.post('/api/github-tokens', apiLimiter, (req, res) => {
  const { name, token, id: rawId, teamId } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token (string) is required' });
  }
  let ownerTeamId;
  try { ownerTeamId = resolveOwnerTeamId(teamId); }
  catch (err) { return res.status(err.status || 400).json({ error: err.message }); }
  const trimmed = token.trim();
  if (!/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]{20,}$/.test(trimmed)) {
    return res.status(400).json({
      error: "token does not look like a GitHub token (expected prefix github_pat_, ghp_, gho_, ghs_, ghu_ or ghr_)",
    });
  }

  const existing = listGithubTokens();
  let id;
  if (rawId !== undefined && rawId !== null && String(rawId).trim() !== '') {
    id = String(rawId).trim();
    if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'id must contain lowercase letters, digits and hyphens only' });
    if (existing.some(t => t.id === id)) return res.status(409).json({ error: `GitHub token id '${id}' already exists` });
  } else {
    const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
    id = baseId || `token-${Date.now()}`;
    if (existing.some(t => t.id === id)) {
      id = `${id}-${Date.now().toString(36)}`;
    }
  }
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });

  const tokenPath = path.join(GH_TOKENS_DIR, path.basename(id));
  fs.writeFileSync(tokenPath, trimmed, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    teamId: ownerTeamId,
    preview: githubTokenPreview(trimmed),
    fingerprint: githubTokenFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveGithubTokensIndex([...existing, entry]);
  res.status(201).json(entry);
});

app.delete('/api/github-tokens/:id', apiLimiter, (req, res) => {
  const { id } = req.params;
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const tokens = listGithubTokens();
  if (!tokens.some(t => t.id === id)) return res.status(404).json({ error: 'GitHub token not found' });
  const usedBy = githubTokenInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `GitHub token is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(GH_TOKENS_DIR, path.basename(id))); } catch { /* ignore */ }
  saveGithubTokensIndex(tokens.filter(t => t.id !== id));
  res.status(204).end();
});

/* ─── GitHub repo probe — wizard helper ───────────────────────────────
   POST /api/github/probe { url, githubTokenId } → { ok, repo, defaultBranch,
                                                     branches: [name, …] }
   Used by the Team-Setup wizard to (a) verify the URL is reachable with
   the picked token before the user commits to it, and (b) populate the
   branch dropdown with the repo's actual branches instead of a free-text
   field. Falls back to { ok: false, error } on parse / auth / 404 — the
   wizard surfaces that to the user. */

app.post('/api/github/probe', heavyLimiter, async (req, res) => {
  const { url, githubTokenId } = req.body || {};
  let parsed;
  try {
    parsed = parseGitHubUrl(url);
  } catch (err) {
    return res.json({ ok: false, error: err.message });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.json({ ok: false, error: 'githubTokenId required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.json({ ok: false, error: `GitHub token '${githubTokenId}' not found` });
  }
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, githubTokenId), 'utf8').trim();
  } catch (err) {
    return res.json({ ok: false, error: `Cannot read token: ${err.message}` });
  }
  if (!token) return res.json({ ok: false, error: 'Token file is empty' });

  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'e-vgh-claw-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const apiBase = `https://api.github.com/repos/${encodeURIComponent(parsed.org)}/${encodeURIComponent(parsed.repo)}`;
  try {
    const repoResp = await fetch(apiBase, { headers });
    if (repoResp.status === 404) {
      return res.json({ ok: false, error: 'Repository not found (or token has no access).' });
    }
    if (repoResp.status === 401 || repoResp.status === 403) {
      return res.json({ ok: false, error: `GitHub auth failed (HTTP ${repoResp.status}). Check the token's scopes — needs at least repo:read.` });
    }
    if (!repoResp.ok) {
      return res.json({ ok: false, error: `GitHub API HTTP ${repoResp.status}` });
    }
    const repoMeta = await repoResp.json();

    // Pull up to 200 branches (2 pages of 100). Repos with more branches
    // than that don't fit a dropdown well anyway — surface a hint and let
    // the user type a name manually if they need a deeper one.
    const branches = [];
    let truncated = false;
    for (let page = 1; page <= 2; page++) {
      const r = await fetch(`${apiBase}/branches?per_page=100&page=${page}`, { headers });
      if (!r.ok) break;
      const list = await r.json();
      branches.push(...list.map(b => b.name));
      if (list.length < 100) break;
      if (page === 2 && list.length === 100) truncated = true;
    }
    return res.json({
      ok: true,
      repo: `${repoMeta.full_name}`,
      defaultBranch: repoMeta.default_branch,
      branches,
      truncated,
    });
  } catch (err) {
    return res.json({ ok: false, error: `Network: ${err.message}` });
  }
});

/* ─── Coordinator Workflow ──────────────────────────────────────────── */

/*
 * AC 1: Check whether .github/workflows/coordinator.yml exists in the target repo.
 * GET /api/repos/coordinator-workflow?repo=<owner>/<name>&githubTokenId=<id>
 * Returns { exists: true|false, sha: <sha if exists> }
 */
app.get('/api/repos/coordinator-workflow', coordinatorWorkflowLimiter, async (req, res) => {
  const { repo, githubTokenId } = req.query;
  if (typeof repo !== 'string' || !repo.includes('/')) {
    return res.status(400).json({ error: 'repo query param required (owner/name)' });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.status(400).json({ error: 'githubTokenId query param required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }
  const safeTokenId = path.basename(githubTokenId);
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, safeTokenId), 'utf8').trim();
  } catch (err) {
    return res.status(500).json({ error: `Cannot read token: ${err.message}` });
  }
  const [owner, repoName] = repo.split('/');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'e-vgh-claw-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.github/workflows/coordinator.yml`;
  try {
    const r = await fetch(url, { headers });
    if (r.status === 404) return res.json({ exists: false });
    if (!r.ok) return res.status(r.status).json({ error: `GitHub API HTTP ${r.status}` });
    const data = await r.json();
    return res.json({ exists: true, sha: data.sha });
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }
});

/*
 * AC 3 / AC 5 / AC 6: Install (or update) the coordinator workflow in the target repo.
 * POST /api/repos/coordinator-workflow
 * Body: { repo: "owner/name", githubTokenId: "<id>" }
 * Commits .github/workflows/coordinator.yml via GitHub Contents API.
 */
app.post('/api/repos/coordinator-workflow', coordinatorWorkflowLimiter, async (req, res) => {
  const { repo, githubTokenId } = req.body || {};
  if (typeof repo !== 'string' || !repo.includes('/')) {
    return res.status(400).json({ error: 'repo required (owner/name)' });
  }
  if (typeof githubTokenId !== 'string' || !GH_TOKEN_ID_RE.test(githubTokenId)) {
    return res.status(400).json({ error: 'githubTokenId required' });
  }
  if (!listGithubTokens().some(t => t.id === githubTokenId)) {
    return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
  }
  const safeTokenId = path.basename(githubTokenId);
  let token;
  try {
    token = fs.readFileSync(path.join(GH_TOKENS_DIR, safeTokenId), 'utf8').trim();
  } catch (err) {
    return res.status(500).json({ error: `Cannot read token: ${err.message}` });
  }
  const [owner, repoName] = repo.split('/');
  const headers = {
    'Authorization': `Bearer ${token}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'e-vgh-claw-wizard',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  const contentsUrl = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.github/workflows/coordinator.yml`;

  // AC 5: Workflow content — functionally equivalent to #147 AC 2.
  const workflowYaml = `name: Multi-agent Coordinator

on:
  schedule:
    - cron: '*/5 * * * *'
  workflow_dispatch:

concurrency:
  group: coordinator
  cancel-in-progress: false

permissions:
  issues: write

env:
  ASSIGN_TIMEOUT_MINUTES: '10'

jobs:
  coordinate:
    runs-on: ubuntu-latest
    steps:
      - name: Assign bidders and recover timed-out assignments
        env:
          GH_TOKEN: \${{ secrets.GITHUB_TOKEN }}
          REPO: \${{ github.repository }}
        run: |
          set -euo pipefail

          # ── Phase 1: Assign bidders ──────────────────────────────────────────
          bid_issues=$(gh issue list \\
            --repo "$REPO" \\
            --state open \\
            --json number,labels \\
            --limit 200 \\
            | jq -r '
                .[]
                | .number as $n
                | .labels[].name
                | select(test("^bid:"))
                | "\\($n)"
              ' | sort -u)

          for issue_num in $bid_issues; do
            current_labels=$(gh issue view "$issue_num" \\
              --repo "$REPO" \\
              --json labels \\
              | jq -r '.labels[].name')

            bid_labels=$(echo "$current_labels" | grep -E '^bid:' || true)
            if [[ -z "$bid_labels" ]]; then
              continue
            fi

            if echo "$current_labels" | grep -qE '^assigned:'; then
              continue
            fi

            chosen=$(echo "$bid_labels" | shuf -n 1)
            agent_id="\${chosen#bid:}"
            assigned_label="assigned:\${agent_id}"

            if ! gh label list \\
                --repo "$REPO" \\
                --json name \\
                --limit 500 \\
                | jq -r '.[].name' | grep -qxF "$assigned_label"; then
              gh label create "$assigned_label" \\
                --repo "$REPO" \\
                --color "0075ca" \\
                --description "Assigned to agent \${agent_id}" \\
                2>/dev/null || true
            fi

            gh issue edit "$issue_num" \\
              --repo "$REPO" \\
              --add-label "$assigned_label"

            while IFS= read -r bid; do
              gh issue edit "$issue_num" \\
                --repo "$REPO" \\
                --remove-label "$bid" \\
                2>/dev/null || true
            done <<< "$bid_labels"

            echo "Assigned issue #\${issue_num} to \${agent_id}"
          done

          # ── Phase 2: Timeout recovery ────────────────────────────────────────
          cutoff_ts=$(date -d "\${ASSIGN_TIMEOUT_MINUTES} minutes ago" --iso-8601=seconds)

          gh issue list \\
            --repo "$REPO" \\
            --state open \\
            --json number,labels,updatedAt \\
            --limit 200 \\
            | jq -r --arg cutoff "$cutoff_ts" '
                .[]
                | select(
                    (.labels | map(.name) | any(test("^assigned:")))
                    and (.labels | map(.name) | any(test("^started:")) | not)
                    and (.updatedAt <= $cutoff)
                  )
                | .number
              ' \\
            | while read -r issue_num; do
              assigned_label=$(gh issue view "$issue_num" \\
                --repo "$REPO" \\
                --json labels \\
                | jq -r '.labels[].name | select(test("^assigned:"))' \\
                | head -1)

              if [[ -z "$assigned_label" ]]; then
                continue
              fi

              agent_id="\${assigned_label#assigned:}"

              gh issue edit "$issue_num" \\
                --repo "$REPO" \\
                --remove-label "$assigned_label" \\
                2>/dev/null || true

              has_ready=$(gh issue view "$issue_num" \\
                --repo "$REPO" \\
                --json labels \\
                | jq -r '[.labels[].name] | any(. == "ready")' )
              if [[ "$has_ready" != "true" ]]; then
                gh issue edit "$issue_num" \\
                  --repo "$REPO" \\
                  --add-label "ready"
              fi

              gh issue comment "$issue_num" \\
                --repo "$REPO" \\
                --body "Assignment to \${agent_id} timed out — returned to ready pool."

              echo "Timeout recovery: issue #\${issue_num} (was assigned to \${agent_id})"
            done
`;

  const contentBase64 = Buffer.from(workflowYaml).toString('base64');

  // AC 6: Check for existing file sha (required for updates).
  let existingSha;
  try {
    const checkResp = await fetch(contentsUrl, { headers });
    if (checkResp.ok) {
      const existing = await checkResp.json();
      existingSha = existing.sha;
    } else if (checkResp.status !== 404) {
      return res.status(checkResp.status).json({ error: `GitHub API HTTP ${checkResp.status}` });
    }
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }

  const commitMessage = existingSha ? 'Update agent coordinator workflow' : 'Add agent coordinator workflow';
  const putBody = {
    message: commitMessage,
    content: contentBase64,
    ...(existingSha ? { sha: existingSha } : {}),
  };

  try {
    const putResp = await fetch(contentsUrl, {
      method: 'PUT',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(putBody),
    });
    if (putResp.status === 403) {
      const shaFlag = existingSha ? ` -f sha=${existingSha}` : '';
      return res.status(403).json({
        error: 'The GitHub PAT does not have the `workflow` scope. Add this scope in GitHub → Settings → Developer settings → Personal access tokens, then retry.',
        manualCommand: `gh api --method PUT /repos/${repo}/contents/.github/workflows/coordinator.yml -f message="${commitMessage}" -f content="${contentBase64}"${shaFlag}`,
      });
    }
    if (putResp.status === 409) {
      return res.status(409).json({ error: 'File was updated concurrently — refresh and retry.' });
    }
    if (!putResp.ok) {
      const data = await putResp.json().catch(() => ({}));
      return res.status(putResp.status).json({ error: data.message || `GitHub API HTTP ${putResp.status}` });
    }
    return res.json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: `Network: ${err.message}` });
  }
});

/* ─── Matrix Proxy ──────────────────────────────────────────────────── */

/*
 * REST + SSE proxy for the Conduwuit Matrix homeserver.
 *
 * Browser clients never see Matrix tokens. The admin user's token is read
 * from MATRIX_ACCESS_TOKEN; per-agent tokens come from /workspace/agents/<id>/config.json.
 *
 * Routes:
 *   GET    /api/matrix/agents                          List enabled agents with Matrix identities
 *   POST   /api/matrix/agents/:agentId/dm              Idempotent create/get DM room
 *   GET    /api/matrix/rooms/:roomId/messages          Paginated history (proxy)
 *   POST   /api/matrix/rooms/:roomId/messages          Send m.text as admin
 *   DELETE /api/matrix/rooms/:roomId/messages          Redact all m.room.message events
 *   GET    /api/matrix/rooms/:roomId/stream            SSE long-poll on /sync filtered to room
 */

// 1. List enabled agents that have Matrix identities
app.get('/api/matrix/agents', (req, res) => {
  const scope = getScope(req);
  const ids = listAgentDirs();
  const out = [];
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    if (cfg.enabled === false) continue;
    if (!cfg.token) continue;
    if (!visibleAgent(scope, cfg)) continue; // team + visibility scoping (#302)
    const dm = matrix.getAgentDmRoom(id);
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    out.push({
      id,
      displayName: cfg.displayName || id,
      role: cfg.role || 'agent',
      userId: cfg.userId || `@${id}:local`,
      enabled: cfg.enabled !== false,
      dmRoomId: dm?.roomId || null,
      environmentId: cfg.environmentId || null,
      environmentName: env?.name || cfg.environmentId || null,
      parentTeamId: cfg.parentTeamId || null,
      parentOrchestratorId: cfg.parentOrchestratorId || null,
    });
  }
  res.json(out);
});

// 2. Idempotent create-or-get DM room with an agent.
//
// Per-agent in-flight cache: concurrent POSTs for the same agent share one
// upstream `createRoom` call. Without this, two near-simultaneous requests
// (e.g. component re-mount, double-click, second tab) each see no
// dm-room.json, both create rooms, and one room ends up orphaned with the
// session log but no dm-room.json pointer.
const dmCreateInFlight = new Map();

async function ensureAgentDmRoom(agentId) {
  const cfgPath = path.join(AGENTS_DIR, agentId, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) { const e = new Error('Agent not found'); e.status = 404; throw e; }
  if (cfg.enabled === false) { const e = new Error('Agent disabled'); e.status = 409; throw e; }
  if (!cfg.token) { const e = new Error('Agent has no Matrix token'); e.status = 409; throw e; }
  if (!matrix.ADMIN_TOKEN) { const e = new Error('MATRIX_ACCESS_TOKEN not configured'); e.status = 500; throw e; }

  // Reuse existing DM room if admin is still joined
  const existing = matrix.getAgentDmRoom(agentId);
  if (existing?.roomId) {
    const joined = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/joined_rooms');
    if (joined.status === 200 && Array.isArray(joined.data?.joined_rooms) &&
        joined.data.joined_rooms.includes(existing.roomId)) {
      return { roomId: existing.roomId, reused: true, created: false };
    }
    // Admin no longer joined — fall through and create a fresh room.
  }

  const adminUserId = await matrix.resolveAdminUserId();
  const createResp = await matrix.matrixFetch(cfg.token, '/_matrix/client/v3/createRoom', {
    method: 'POST',
    body: {
      preset: 'trusted_private_chat',
      invite: [adminUserId],
      is_direct: true,
      name: `DM with ${cfg.displayName || agentId}`,
    },
  });
  if (createResp.status >= 400) {
    console.error('[Matrix] createRoom failed:', createResp.status, createResp.data);
    const e = new Error('createRoom failed'); e.status = 502; e.upstream = createResp.data;
    throw e;
  }
  const roomId = createResp.data?.room_id;
  if (!roomId) {
    const e = new Error('createRoom returned no room_id'); e.status = 502; e.upstream = createResp.data;
    throw e;
  }

  // Admin (human) accepts the invite. We use a token, not a syncing client,
  // so auto-join doesn't happen — we explicitly POST /join.
  const joinResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
    `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
    { method: 'POST', body: {} });
  if (joinResp.status >= 400) {
    console.error('[Matrix] admin join failed:', joinResp.status, joinResp.data);
    const e = new Error('admin join failed'); e.status = 502; e.upstream = joinResp.data;
    throw e;
  }

  matrix.setAgentDmRoom(agentId, {
    roomId,
    createdAt: new Date().toISOString(),
    createdBy: adminUserId,
  });
  // Nudge a running agent to re-pull dm-room.json now, so an isolated agent
  // learns its DM room for trigger/claim posts without waiting for the next
  // 60s sync (#185 Phase 2). No-op if the agent isn't running yet.
  notifyAgentReload(agentId);
  return { roomId, reused: false, created: true };
}

// Best-effort DM-room pre-creation. Called right after an agent is created or
// enabled so the 1:1 room — and the agent's own membership in it (the room is
// created with the agent's token, so the agent is its creator/member) — exists
// BEFORE the first user message. The agent's Matrix sync loop then already has
// the room in context and won't drop a message that races chat-open. Never
// fatal: a Matrix hiccup here must not fail the create/enable, and the lazy
// POST /api/matrix/agents/:id/dm path still creates the room on demand as a
// fallback when the user first opens the chat.
async function preCreateAgentDmRoom(agentId, context) {
  try {
    const r = await ensureAgentDmRoom(agentId);
    console.log(
      `[Matrix] Pre-created DM room for ${agentId} (${context}): ${r.roomId}` +
      `${r.reused ? ' (reused)' : ''}`,
    );
  } catch (err) {
    console.warn(`[Matrix] DM-room pre-create skipped for ${agentId} (${context}): ${err.message}`);
  }
}

app.post('/api/matrix/agents/:agentId/dm', heavyLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  let promise = dmCreateInFlight.get(agentId);
  let leader = false;
  if (!promise) {
    leader = true;
    promise = ensureAgentDmRoom(agentId).finally(() => {
      dmCreateInFlight.delete(agentId);
    });
    dmCreateInFlight.set(agentId, promise);
  }

  try {
    const r = await promise;
    // Followers always report `reused: true` — they didn't drive the creation,
    // they just observed the leader's result.
    const status = leader && r.created ? 201 : 200;
    res.status(status).json({
      roomId: r.roomId,
      reused: leader ? r.reused : true,
    });
  } catch (err) {
    if (err.status) {
      const body = err.upstream ? { error: err.message, upstream: err.upstream } : { error: err.message };
      return res.status(err.status).json(body);
    }
    res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
  }
});

// 3. Paginated message history (proxy)
app.get('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;
  const dir = req.query.dir === 'f' ? 'f' : 'b';
  const limit = Math.min(parseInt(req.query.limit, 10) || 50, 200);
  const query = { dir, limit };
  if (req.query.from) query.from = req.query.from;
  if (req.query.to) query.to = req.query.to;
  if (req.query.filter) query.filter = req.query.filter;

  try {
    const resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
      { query });
    res.status(resp.status).json(resp.data);
  } catch (err) {
    res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
  }
});

// 4. Send a text message to a room as the admin user
app.post('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;
  const { body } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'body (non-empty string) is required' });
  }

  const txnId = crypto.randomUUID();
  try {
    const resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      {
        method: 'PUT',
        body: { msgtype: 'm.text', body },
      });
    if (resp.status >= 400) {
      return res.status(resp.status).json(resp.data);
    }
    res.json({ event_id: resp.data?.event_id });
  } catch (err) {
    res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
  }
});

// 5. Redact (delete) all m.room.message events in a room
//
// Paginates backward through the full timeline, collecting every m.room.message
// event_id, then issues a Matrix redaction (PUT .../redact/...) for each one.
// The admin token is used throughout. Events the homeserver rejects (e.g.
// already redacted) are silently skipped so the call is idempotent.
app.delete('/api/matrix/rooms/:roomId/messages', apiLimiter, async (req, res) => {
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  const { roomId } = req.params;

  // Collect all m.room.message event_ids by paginating dir=b until exhausted.
  const eventIds = [];
  let from = undefined;
  try {
    while (true) {
      const query = { dir: 'b', limit: 100 };
      if (from) query.from = from;
      const resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages`,
        { query });
      if (resp.status >= 400) {
        return res.status(resp.status).json(resp.data ?? { error: `Matrix returned ${resp.status}` });
      }
      const chunk = Array.isArray(resp.data?.chunk) ? resp.data.chunk : [];
      for (const ev of chunk) {
        if (ev.type === 'm.room.message' && ev.event_id) eventIds.push(ev.event_id);
      }
      const next = resp.data?.end;
      if (!next || chunk.length === 0) break;
      from = next;
    }
  } catch (err) {
    return res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
  }

  // Redact each event. Failures per event are non-fatal (may already be redacted).
  let redacted = 0;
  let skipped  = 0;
  for (const eventId of eventIds) {
    const txnId = crypto.randomUUID();
    try {
      const r = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/${encodeURIComponent(txnId)}`,
        { method: 'PUT', body: { reason: 'Chat history cleared by admin' } });
      if (r.status < 400) redacted++;
      else skipped++;
    } catch {
      skipped++;
    }
  }

  res.json({ redacted, skipped, total: eventIds.length });
});

// 6. SSE stream — long-poll /sync filtered to this room
app.get('/api/matrix/rooms/:roomId/stream', async (req, res) => {
  if (!matrix.ADMIN_TOKEN) {
    return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });
  }
  const { roomId } = req.params;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const filter = JSON.stringify({
    room: {
      rooms: [roomId],
      timeline: { limit: 50, types: ['m.room.message'] },
      state: { types: [], lazy_load_members: true },
    },
    presence: { types: [] },
    account_data: { types: [] },
  });

  let closed = false;
  let abort = null;

  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, 15000);

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (abort) {
      try { abort.abort(); } catch { /* noop */ }
    }
  });

  // Bootstrap: pick up where we left off, or do a quick initial sync to get next_batch
  let since = matrix.loadSyncToken();
  try {
    if (!since) {
      const initResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/sync', {
        query: { timeout: 0, full_state: false, filter },
      });
      if (initResp.status >= 400) {
        res.write(`event: error\ndata: ${JSON.stringify({ status: initResp.status, body: initResp.data })}\n\n`);
        return res.end();
      }
      since = initResp.data?.next_batch || null;
      if (since) matrix.saveSyncToken(since);
    }
  } catch (err) {
    res.write(`event: error\ndata: ${JSON.stringify({ message: `initial sync failed: ${err.message}` })}\n\n`);
    return res.end();
  }

  // Long-poll loop
  while (!closed) {
    abort = new AbortController();
    let resp;
    try {
      resp = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/sync', {
        query: { since, timeout: 25000, filter },
        signal: abort.signal,
      });
    } catch (err) {
      if (closed) break;
      // Network blip — wait a moment and retry
      res.write(`event: warn\ndata: ${JSON.stringify({ message: `sync failed: ${err.message}` })}\n\n`);
      await new Promise(r => setTimeout(r, 1500));
      continue;
    }
    if (closed) break;

    if (resp.status >= 400) {
      res.write(`event: error\ndata: ${JSON.stringify({ status: resp.status, body: resp.data })}\n\n`);
      // Reset since token if invalid, then back off
      if (resp.status === 400 || resp.status === 401) {
        since = null;
      }
      await new Promise(r => setTimeout(r, 2000));
      continue;
    }

    const data = resp.data || {};
    const next = data.next_batch || since;
    const room = data.rooms?.join?.[roomId];
    const events = room?.timeline?.events || [];
    for (const ev of events) {
      if (ev.type !== 'm.room.message') continue;
      const payload = {
        event_id: ev.event_id,
        sender: ev.sender,
        origin_server_ts: ev.origin_server_ts,
        content: ev.content,
        room_id: roomId,
      };
      res.write(`data: ${JSON.stringify(payload)}\n\n`);
    }

    if (next && next !== since) {
      since = next;
      try { matrix.saveSyncToken(since); } catch (err) {
        console.error('[Matrix] saveSyncToken failed:', err.message);
      }
    }
  }

  clearInterval(heartbeat);
  try { res.end(); } catch { /* noop */ }
});

/* ─── Session Log ───────────────────────────────────────────────────── */

// Matrix room IDs come in two forms: the legacy `!opaque:server_name` shape
// used through room version 11, and the v12+ shape (per MSC4291) which is a
// hash with no `:server_name` suffix. Continuwuity:latest creates new rooms
// at v12 by default, so the suffix must be optional here.
const ROOM_ID_RE = /^![a-zA-Z0-9_-]+(?::[a-zA-Z0-9.-]+)?$/;

// Session-file paths are built inline at every call site (rather than via a
// helper) so the sanitisation gate (AGENT_ID_RE / ROOM_ID_RE tests at the
// route entry) and the path.join sit in the same function — that's the
// shape CodeQL's js/path-injection rule recognises as a barrier.

/* ─── Session pointer (Claude --resume id) ─────────────────────────── */

// Returns the active Claude session id for a given (agent, room), if any.
// The runner writes this file after every successful Claude invocation;
// an empty / missing file means the next message starts a fresh session.
// Also returns `resetAt` (ISO string) when the session was manually reset and
// no new session has started yet; the UI uses this to show a persistent notice.
app.get('/api/agents/:agentId/session/:roomId/current', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const ptr = controlOrAgentPath(agentId, 'sessions', roomId + '.current.json'); // pushed copy preferred (#185)
  const flagPath = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.reset.json');

  let sessionId = null, updatedAt = null;
  if (fs.existsSync(ptr)) {
    try {
      const j = JSON.parse(fs.readFileSync(ptr, 'utf8'));
      sessionId = typeof j?.sessionId === 'string' ? j.sessionId : null;
      updatedAt = typeof j?.updatedAt === 'string' ? j.updatedAt : null;
    } catch { /* corrupt pointer → treat as no session */ }
  }

  let resetAt = null;
  if (fs.existsSync(flagPath)) {
    try {
      const f = JSON.parse(fs.readFileSync(flagPath, 'utf8'));
      const ra = typeof f?.resetAt === 'string' ? f.resetAt : null;
      if (ra) {
        // Auto-clear flag once a new session has started after the reset.
        if (updatedAt && new Date(updatedAt) > new Date(ra)) {
          fs.rmSync(flagPath, { force: true });
        } else {
          resetAt = ra;
        }
      }
    } catch { /* corrupt flag → ignore */ }
  }

  res.json({ sessionId, updatedAt, resetAt });
});

// Drop the session pointer so the next message starts a fresh Claude
// session (memory files are still re-read; only the in-conversation
// context is discarded). Also writes a reset flag (persists across navigation)
// and triggers a best-effort git reset of all repositories in the agent's
// working environment back to their configured default branch.
app.delete('/api/agents/:agentId/session/:roomId/current', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    // Local pool copy (works on the shared volume; a no-op on an isolated one).
    fs.rmSync(path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.current.json'), { force: true });
    const flagPath = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.reset.json');
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    writeJsonAtomic(flagPath, { resetAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';

  // Drop the pushed pointer mirror (clears the badge) and, when the agent's
  // volume is isolated, ask the agent to drop its own --resume pointer (#185).
  try {
    await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/session-reset`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomId }),
      },
    );
  } catch (err) {
    console.warn(`[API] session-reset call failed for ${agentId}: ${err.message}`);
  }

  // Best-effort repository reset — failures are logged but never block the response.
  let repoResults = [];
  try {
    const r = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reset-repos`,
      { method: 'POST' },
    );
    const data = await r.json();
    repoResults = data?.results ?? [];
  } catch (err) {
    console.warn(`[API] reset-repos call failed for ${agentId}: ${err.message}`);
  }

  res.json({ ok: true, repoResults });
});

// Send a stop-session signal to the orchestrator, which forwards it via IPC
// to the agent-runner. The runner kills any in-flight Claude invocation.
app.post('/api/agents/:agentId/session/:roomId/stop', apiLimiter, async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/stop-session`,
      { method: 'POST' },
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// List running Claude sessions for an agent. Reads the per-agent
// running-sessions.json the runner maintains. Returns `{ sessions: [] }`
// when no file exists (agent never started or never ran a session).
const SESSION_ID_RE = /^[a-zA-Z0-9_-]+$/;
app.get('/api/agents/:agentId/sessions/active', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid agent id' });
  // Pushed control-plane copy preferred (#185): under per-agent volume
  // isolation the agent's own running-sessions.json lives on a volume the
  // admin-console can't see, so it must be read from the control plane.
  const filePath = controlOrAgentPath(agentId, 'running-sessions.json');
  if (!fs.existsSync(filePath)) return res.json({ sessions: [] });
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    res.json({ sessions: Array.isArray(parsed) ? parsed : [] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Stop one specific running session.
app.post('/api/agents/:agentId/sessions/:sessionId/stop', apiLimiter, async (req, res) => {
  const { agentId, sessionId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'invalid agent id' });
  if (!SESSION_ID_RE.test(sessionId)) return res.status(400).json({ error: 'invalid session id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/sessions/${encodeURIComponent(sessionId)}/stop`,
      { method: 'POST' },
    );
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ─── Workspace browser (read-only) ────────────────────────────────── */

const WORKSPACE_FILE_MAX_BYTES = 512 * 1024; // 512 KB read cap per file

// Resolve a user-supplied relative path against the agent root, refusing
// anything that escapes the root (path traversal, symlinks aimed outside,
// absolute paths). Returns the absolute path on success, null otherwise.
function safeAgentPath(agentId, relPath) {
  if (!AGENT_ID_RE.test(agentId)) return null;
  const agentRoot = path.join(AGENTS_DIR, agentId);
  // realpath the root first so symlinks at /workspace level still resolve
  // consistently. If the agent dir doesn't exist yet, bail out.
  let realRoot;
  try {
    realRoot = fs.realpathSync(agentRoot);
  } catch {
    return null;
  }
  const normalized = path.normalize(String(relPath || '').replace(/^\/+/, ''));
  if (normalized.split(path.sep).some(seg => seg === '..')) return null;
  const target = path.resolve(realRoot, normalized);
  // Final containment check (covers symlinks pointing outward).
  let realTarget;
  try {
    realTarget = fs.realpathSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    return null;
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + path.sep)) return null;
  return realTarget;
}

// Directory listing. Hidden dotfiles are returned but flagged with `hidden`
// so the UI can collapse them by default. Symlinks are reported with their
// link target (best-effort) so the user understands what they're looking at.
app.get('/api/agents/:agentId/workspace/tree', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let entries;
  try {
    entries = fs.readdirSync(target, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'not a directory' });
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: err.message });
  }

  const items = entries.map(d => {
    const full = path.join(target, d.name);
    let size = 0;
    let mtime = 0;
    let kind = 'file';
    if (d.isDirectory()) kind = 'dir';
    else if (d.isSymbolicLink()) kind = 'link';
    else if (!d.isFile()) kind = 'other';
    let gitBranch = null;
    try {
      const st = fs.statSync(full);
      size = st.size;
      mtime = st.mtimeMs;
      // For symlinks, prefer the target's type so the UI can navigate into
      // resolved directories. We've already constrained safeAgentPath to
      // refuse outward-pointing links, but defense-in-depth: catch ENOENT.
      if (kind === 'link') {
        if (st.isDirectory()) kind = 'dir';
        else if (st.isFile()) kind = 'file';
      }
    } catch { /* dangling link or transient — surface minimal info */ }
    if (kind === 'dir') {
      try {
        const headContent = fs.readFileSync(path.join(full, '.git', 'HEAD'), 'utf8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          gitBranch = headContent.slice('ref: refs/heads/'.length);
        } else if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
          gitBranch = headContent.slice(0, 7); // detached HEAD — show short hash
        }
      } catch { /* not a git repo or unreadable */ }
    }
    return {
      name: d.name,
      type: kind,
      size,
      mtime,
      hidden: d.name.startsWith('.'),
      ...(gitBranch !== null && { gitBranch }),
    };
  });

  // Stable ordering: dirs first, then alphabetical (case-insensitive).
  items.sort((a, b) => {
    if (a.type === 'dir' && b.type !== 'dir') return -1;
    if (a.type !== 'dir' && b.type === 'dir') return 1;
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });

  // Normalize the path we echo back — trailing slashes etc. shouldn't leak.
  const echoPath = path.relative(path.join(AGENTS_DIR, agentId), target);
  res.json({ path: echoPath, items });
});

// Git info — branch + dirty status for all git repos in the agent workspace.
function readGitRepoInfo(repoPath) {
  let branch = null;
  try {
    const headContent = fs.readFileSync(path.join(repoPath, '.git', 'HEAD'), 'utf8').trim();
    if (headContent.startsWith('ref: refs/heads/')) {
      branch = headContent.slice('ref: refs/heads/'.length);
    } else if (/^[0-9a-f]{7,40}$/i.test(headContent)) {
      branch = headContent.slice(0, 7); // detached HEAD
    }
  } catch { return null; }

  let isDirty = false;
  let changesCount = 0;
  try {
    const result = spawnSync('git', ['status', '--porcelain'], {
      cwd: repoPath, timeout: 5000, encoding: 'utf8',
    });
    if (result.status === 0 && result.stdout) {
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      changesCount = lines.length;
      isDirty = changesCount > 0;
    }
  } catch { /* ignore */ }

  return { branch, isDirty, changesCount };
}

function getAgentGitRepos(agentRoot) {
  const repos = [];
  // Check the workspace root itself
  if (fs.existsSync(path.join(agentRoot, '.git', 'HEAD'))) {
    const info = readGitRepoInfo(agentRoot);
    if (info) repos.push({ repoPath: '.', ...info });
  }
  // Scan first-level subdirectories
  let entries = [];
  try { entries = fs.readdirSync(agentRoot, { withFileTypes: true }); } catch { return repos; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(agentRoot, entry.name);
    if (fs.existsSync(path.join(fullPath, '.git', 'HEAD'))) {
      const info = readGitRepoInfo(fullPath);
      if (info) repos.push({ repoPath: entry.name, ...info });
    }
  }
  return repos;
}

app.get('/api/agents/:agentId/git-info', (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  // getAgentGitRepos expects an absolute, sanitised path (post-#116). Use
  // safeAgentPath so a bare agentId can't escape the agents tree.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json({ repos: getAgentGitRepos(agentRoot) });
});

// Directory-only listing — delegated to BP-Explorer for orchestrator directory picker.
app.get('/api/agents/:agentId/workspace/dirs', apiLimiter, async (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const root = path.join(AGENTS_DIR, agentId);
  // Verify agent exists
  if (!fs.existsSync(root)) return res.status(404).json({ error: 'Agent not found' });
  try {
    const qs = new URLSearchParams({ root, path: relPath }).toString();
    const upstream = await fetch(`${BP_EXPLORER_URL}/api/workspace/tree?${qs}`);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `BP-Explorer unreachable: ${err.message}` });
  }
});

// File content. Caps reads at WORKSPACE_FILE_MAX_BYTES; flags binary files
// (NUL byte detection in the prefix) so the UI can show a "binary file"
// stub instead of garbled UTF-8.
app.get('/api/agents/:agentId/workspace/file', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const truncated = st.size > WORKSPACE_FILE_MAX_BYTES;
  const readSize  = Math.min(st.size, WORKSPACE_FILE_MAX_BYTES);

  let buf;
  try {
    const fd = fs.openSync(target, 'r');
    try {
      buf = Buffer.alloc(readSize);
      if (readSize > 0) fs.readSync(fd, buf, 0, readSize, 0);
    } finally {
      fs.closeSync(fd);
    }
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Cheap binary heuristic: NUL byte in the first 8 KB. Good enough for
  // distinguishing source files from images / native binaries.
  const probe = buf.slice(0, Math.min(buf.length, 8192));
  const isBinary = probe.includes(0);

  const echoPath = path.relative(path.join(AGENTS_DIR, agentId), target);
  res.json({
    path: echoPath,
    size: st.size,
    truncated,
    binary: isBinary,
    content: isBinary ? null : buf.toString('utf8'),
    mtime: st.mtimeMs,
  });
});

// Raw file download — streams the full file with Content-Disposition: attachment
// so the browser saves it with its original filename. No size cap (unlike /file).
app.get('/api/agents/:agentId/workspace/download', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const target = safeAgentPath(agentId, relPath);
  if (!target) return res.status(400).json({ error: 'invalid path' });

  let st;
  try {
    st = fs.statSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isFile()) return res.status(400).json({ error: 'not a file' });

  const filename = path.basename(target);
  const encoded = encodeURIComponent(filename).replace(/'/g, '%27');
  res.setHeader('Content-Disposition', `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Content-Type', 'application/octet-stream');

  const stream = fs.createReadStream(target);
  stream.on('error', () => res.end());
  stream.pipe(res);
});

// Delete a file or directory in the agent workspace. Directories are removed
// recursively. Refuses to delete the workspace root itself.
//
// Containment is enforced the same way as the upload handler: the *parent*
// directory is resolved through safeAgentPath (the canonical traversal /
// outward-symlink sanitizer), then the basename is appended. Operating on the
// entry via its parent means a symlink is unlinked rather than followed, and a
// final startsWith check against the realpath'd agent root rules out any escape.
app.delete('/api/agents/:agentId/workspace/file', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relPath = typeof req.query.path === 'string' ? req.query.path : '';
  const normalized = path.normalize(relPath.replace(/^\/+/, ''));
  if (!normalized || normalized === '.' || normalized === path.sep) {
    return res.status(400).json({ error: 'Refusing to delete workspace root' });
  }
  if (normalized.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid path' });
  }

  const parentRel = path.dirname(normalized);
  const baseName  = path.basename(normalized);
  const parentDir = safeAgentPath(agentId, parentRel === '.' ? '' : parentRel);
  if (!parentDir) return res.status(400).json({ error: 'invalid path' });
  const target = path.join(parentDir, baseName);

  // Defence-in-depth: the resolved target must stay strictly inside the root.
  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }
  if (!target.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid path' });
  }

  let st;
  try {
    st = fs.lstatSync(target);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'not found' });
    return res.status(500).json({ error: err.message });
  }
  const type = st.isDirectory() ? 'dir' : (st.isSymbolicLink() ? 'link' : 'file');

  try {
    // target = safeAgentPath(parent) + sanitised basename, verified inside the
    // agent root above; recursive removal is intended for directories.
    fs.rmSync(target, { recursive: true, force: false }); // codeql[js/path-injection]
  } catch (err) {
    if (err.code === 'EACCES') return res.status(403).json({ error: 'permission denied' });
    return res.status(500).json({ error: err.message });
  }

  res.json({ deleted: path.relative(agentRoot, target), type });
});

// Move (rename) a file or directory within the agent workspace. Body:
//   { from: "<rel path of source>", toDir: "<rel path of destination dir>" }
// The entry keeps its basename; it is relocated under toDir. Both the source's
// parent and the destination dir are resolved through safeAgentPath (parent +
// basename, like the delete handler) so traversal / outward symlinks are
// rejected, and both endpoints are re-checked against the realpath'd agent root.
// Refuses to move a directory into itself or one of its own descendants, and
// refuses to clobber an existing entry at the destination.
app.post('/api/agents/:agentId/workspace/move', apiLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  const fromRaw = typeof req.body?.from === 'string' ? req.body.from : '';
  const toDirRaw = typeof req.body?.toDir === 'string' ? req.body.toDir : '';

  const fromNorm = path.normalize(fromRaw.replace(/^\/+/, ''));
  if (!fromNorm || fromNorm === '.' || fromNorm === path.sep) {
    return res.status(400).json({ error: 'Refusing to move workspace root' });
  }
  if (fromNorm.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid source path' });
  }
  const toDirNorm = path.normalize(toDirRaw.replace(/^\/+/, ''));
  if (toDirNorm.split(path.sep).some(seg => seg === '..')) {
    return res.status(400).json({ error: 'invalid target path' });
  }

  // Resolve the source via its parent + basename (so a symlink entry is moved,
  // not its target) and the destination directory directly.
  const srcParentRel = path.dirname(fromNorm);
  const srcBase = path.basename(fromNorm);
  const srcParent = safeAgentPath(agentId, srcParentRel === '.' ? '' : srcParentRel);
  const destDir   = safeAgentPath(agentId, toDirNorm === '.' ? '' : toDirNorm);
  if (!srcParent) return res.status(400).json({ error: 'invalid source path' });
  if (!destDir)   return res.status(404).json({ error: 'Target directory not found' });

  const src = path.join(srcParent, srcBase);
  const dest = path.join(destDir, srcBase);

  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }
  // Containment barriers in the plain `value.startsWith(root + sep)` form that
  // CodeQL's path-injection analysis recognises as a sanitizer — applied to the
  // exact values passed to fs calls below. Both src and dest carry a non-empty
  // basename, so they are always *strictly* inside the root (no root-equality
  // edge case to special-case, which would force a compound guard CodeQL can't
  // read). destDir is only used in string comparisons below, never as an fs sink.
  if (!src.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid source path' });
  }
  if (!dest.startsWith(agentRoot + path.sep)) {
    return res.status(400).json({ error: 'invalid target path' });
  }

  // Source must exist (and tells us whether it is a directory).
  let srcStat;
  try {
    srcStat = fs.lstatSync(src);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Source not found' });
    return res.status(500).json({ error: err.message });
  }

  // No-op: already in the destination directory. (String comparison only.)
  if (path.dirname(src) === destDir) {
    return res.status(400).json({ error: 'Item is already in that directory' });
  }
  // A directory cannot be moved into itself or one of its descendants.
  if (srcStat.isDirectory() && (destDir === src || destDir.startsWith(src + path.sep))) {
    return res.status(400).json({ error: 'Cannot move a directory into itself' });
  }
  // Refuse to clobber an existing entry — renameSync would otherwise silently
  // overwrite a destination file.
  if (fs.existsSync(dest)) {
    return res.status(409).json({ error: `"${srcBase}" already exists in the target directory` });
  }

  try {
    fs.renameSync(src, dest);
  } catch (err) {
    // The destination directory's existence / type is validated here via
    // renameSync's own errors rather than a separate stat on destDir.
    if (err.code === 'ENOENT')  return res.status(404).json({ error: 'Target directory not found' });
    if (err.code === 'ENOTDIR') return res.status(400).json({ error: 'Target is not a directory' });
    if (err.code === 'EACCES')  return res.status(403).json({ error: 'permission denied' });
    if (err.code === 'EXDEV')   return res.status(500).json({ error: 'cross-device move not supported' });
    return res.status(500).json({ error: err.message });
  }

  res.json({
    from: path.relative(agentRoot, src),
    to: path.relative(agentRoot, dest),
    type: srcStat.isDirectory() ? 'dir' : (srcStat.isSymbolicLink() ? 'link' : 'file'),
  });
});

/* ─── Workspace git-diff (read-only) ───────────────────────────────────
 *
 * Two endpoints for the Diff tab in the Workspace browser:
 *   GET .../workspace/git-status   — list of changed files per repo
 *   GET .../workspace/git-diff     — unified diff for one file
 *
 * Comparison base for MVP-1 is fixed to working-tree-vs-HEAD; the optional
 * `mode` query parameter is wired through but only the default is honoured.
 */

const GIT_SPAWN_TIMEOUT_MS = 5000;
const GIT_DIFF_MAX_BUFFER  = 2 * 1024 * 1024; // 2 MB cap per `git diff` invocation
const GIT_UNTRACKED_PROBE  = 1024 * 1024;     // bytes scanned for line/binary count

// Resolve repoPath (relative to agent root) to an absolute path that contains
// a .git/HEAD. Returns null on any failure — this lets callers reply 400/404
// without distinguishing between traversal, missing, and non-repo cases.
//
// The user-supplied repoPath is never passed to a path operation directly:
// it must match one of the repos discovered by getAgentGitRepos(), which
// scans the agent root with stat-only filesystem reads. Once allowlisted,
// the path is reconstructed through safeAgentPath, the canonical path
// sanitizer in this module.
function resolveAgentRepo(agentId, repoPath) {
  const wanted = typeof repoPath === 'string' && repoPath ? repoPath : '.';
  // getAgentGitRepos expects the sanitised absolute agent root, not the bare
  // id. Without this, the discovery scan operates on a relative path and
  // silently returns []  → every repo lookup misses → diff view is empty.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) return null;
  const repos = getAgentGitRepos(agentRoot);
  const found = repos.find(r => r.repoPath === wanted);
  if (!found) return null;
  return safeAgentPath(agentId, found.repoPath === '.' ? '' : found.repoPath);
}

// Validate that a repo-relative path is safe to pass to git as a literal
// pathspec. Rejects traversal (`..`), absolute paths, NUL bytes, leading
// `-` (would be interpreted as a CLI option even after the `--` separator
// in some git versions) and leading `:` (pathspec magic like `:(top)`,
// `:!`, `:(literal)`).
function isSafeRepoRelPath(rel) {
  if (typeof rel !== 'string' || rel === '') return false;
  if (rel.includes('\0')) return false;
  if (rel.startsWith('-') || rel.startsWith(':')) return false;
  if (path.isAbsolute(rel)) return false;
  const norm = path.normalize(rel.replace(/^\/+/, ''));
  if (norm === '..' || norm.startsWith('..' + path.sep)) return false;
  if (norm.split(path.sep).some(seg => seg === '..')) return false;
  return true;
}

function assertSafeGitCwd(cwd) {
  if (typeof cwd !== 'string' || !cwd) throw new Error('Invalid git cwd');

  let realCwd;
  try {
    realCwd = fs.realpathSync(cwd);
  } catch {
    throw new Error('Invalid git cwd');
  }

  const allowedRoots = [WORKSPACE, POOL_DIR]
    .map(root => {
      try {
        return fs.realpathSync(root);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

  const inAllowedRoot = allowedRoots.some(root => realCwd === root || realCwd.startsWith(root + path.sep));
  if (!inAllowedRoot) throw new Error('Invalid git cwd');

  let st;
  try {
    st = fs.statSync(realCwd);
  } catch {
    throw new Error('Invalid git cwd');
  }
  if (!st.isDirectory()) throw new Error('Invalid git cwd');

  return realCwd;
}

function runGit(args, cwd, { maxBuffer = GIT_DIFF_MAX_BUFFER } = {}) {
  const safeCwd = assertSafeGitCwd(cwd);
  return spawnSync('git', args, {
    cwd: safeCwd,
    timeout: GIT_SPAWN_TIMEOUT_MS,
    maxBuffer,
    encoding: 'buffer',
    // LC_ALL=C keeps porcelain output stable across host locales.
    env: { ...process.env, LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
  });
}

// Parse `git status --porcelain=v1 -z` output. With -z the entries are
// NUL-separated and rename/copy entries carry an extra NUL-separated origin
// path right after the new path. Returns one entry per file with split
// X/Y status bytes.
function parsePorcelainZ(buf) {
  const out = buf.toString('utf8');
  if (!out) return [];
  const parts = out.split('\0');
  if (parts[parts.length - 1] === '') parts.pop();
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 3) continue;
    const X = entry[0];
    const Y = entry[1];
    // entry[2] is the space delimiter.
    const filePath = entry.slice(3);
    let renameFrom = null;
    if (X === 'R' || X === 'C' || Y === 'R' || Y === 'C') {
      // Origin path is the next NUL-separated field.
      renameFrom = parts[i + 1] || null;
      i++;
    }
    files.push({ X, Y, path: filePath, renameFrom });
  }
  return files;
}

// Parse `git diff --numstat -z` output: <add>\t<del>\t<path>\0 records.
// Binary files report '-' instead of numbers; we surface that via `binary`.
function parseNumstatZ(buf) {
  const out = buf.toString('utf8');
  if (!out) return new Map();
  const records = out.split('\0').filter(Boolean);
  const result = new Map();
  for (const rec of records) {
    const tab1 = rec.indexOf('\t');
    if (tab1 < 0) continue;
    const tab2 = rec.indexOf('\t', tab1 + 1);
    if (tab2 < 0) continue;
    const addStr = rec.slice(0, tab1);
    const delStr = rec.slice(tab1 + 1, tab2);
    const filePath = rec.slice(tab2 + 1);
    if (addStr === '-' || delStr === '-') {
      result.set(filePath, { additions: 0, deletions: 0, binary: true });
    } else {
      result.set(filePath, {
        additions: Number.parseInt(addStr, 10) || 0,
        deletions: Number.parseInt(delStr, 10) || 0,
        binary: false,
      });
    }
  }
  return result;
}

// Cheap line + binary probe for an untracked file. Reads at most
// GIT_UNTRACKED_PROBE bytes — far cheaper than diffing megabytes against
// /dev/null just to populate the +/- counter in the file list.
//
// Path safety: the file path comes from `git status -z` and is therefore
// repo-relative, but we still funnel it through safeAgentPath so the
// realpath/containment guarantees in this module apply uniformly. Any
// path that doesn't normalise inside the agent root yields zeros.
function probeUntracked(agentId, fullRel) {
  if (!isSafeRepoRelPath(fullRel)) return { additions: 0, deletions: 0, binary: false };
  const absPath = safeAgentPath(agentId, fullRel);
  if (!absPath) return { additions: 0, deletions: 0, binary: false };
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return { additions: 0, deletions: 0, binary: false };
    const fd = fs.openSync(absPath, 'r');
    try {
      const len = Math.min(st.size, GIT_UNTRACKED_PROBE);
      const buf = Buffer.alloc(len);
      if (len > 0) fs.readSync(fd, buf, 0, len, 0);
      const head = buf.slice(0, Math.min(buf.length, 8192));
      if (head.includes(0)) return { additions: 0, deletions: 0, binary: true };
      let nl = 0;
      for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) nl++;
      // Treat last partial line as a line too — matches `wc -l` only for files
      // that end in \n, but we just want a rough indicator for the UI.
      const additions = nl > 0 ? nl : (st.size > 0 ? 1 : 0);
      return { additions, deletions: 0, binary: false };
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return { additions: 0, deletions: 0, binary: false };
  }
}

// Map raw X/Y status bytes to a single display status. Worktree status wins
// over index status when both are set, since that's the most recent change
// the user would care about. Untracked / ignored stay distinct.
function summarizeStatus(X, Y) {
  if (X === '?' && Y === '?') return '??';
  if (X === '!' && Y === '!') return '!!';
  if (Y !== ' ' && Y !== '') return Y;
  return X;
}

// GET /api/agents/:agentId/workspace/git-status
// Lists changed files for every git repo in the agent workspace. Multi-repo
// support comes for free via getAgentGitRepos().
app.get('/api/agents/:agentId/workspace/git-status', heavyLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  // safeAgentPath returns null for an invalid id or a missing agent dir, and
  // produces the realpath-validated agent root in the success case. Using it
  // here avoids a direct path.join on user input.
  const agentRoot = safeAgentPath(agentId, '');
  if (!agentRoot) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  const repoFilter = typeof req.query.repo === 'string' && req.query.repo
    ? req.query.repo
    : null;

  const repos = getAgentGitRepos(agentRoot);
  const repoEntries = repoFilter
    ? repos.filter(r => r.repoPath === repoFilter)
    : repos;

  const result = [];
  for (const repoMeta of repoEntries) {
    const abs = resolveAgentRepo(agentId, repoMeta.repoPath);
    if (!abs) continue;

    // 1. Status — file list with X/Y status bytes.
    const status = runGit(['status', '--porcelain=v1', '-z'], abs);
    if (status.error || status.status !== 0) {
      result.push({ ...repoMeta, error: 'git-status-failed', files: [] });
      continue;
    }
    const entries = parsePorcelainZ(status.stdout);

    // 2. numstat HEAD..worktree — additions/deletions for tracked changes.
    // Combines staged + unstaged because `HEAD` (no --cached) compares the
    // working tree against HEAD directly.
    let numstat = new Map();
    const numstatRun = runGit(['diff', '--numstat', '-z', 'HEAD', '--'], abs);
    if (numstatRun.status === 0) {
      numstat = parseNumstatZ(numstatRun.stdout);
    }

    // 3. Build per-file response. Untracked entries get a cheap line probe.
    const files = [];
    for (const e of entries) {
      const display = summarizeStatus(e.X, e.Y);
      if (display === '!!') continue; // ignored — never list these
      let stats = numstat.get(e.path);
      if (!stats && display === '??') {
        // probeUntracked re-validates fullRel through safeAgentPath; we only
        // need to give it a repo-relative join key here.
        const fullRel = repoMeta.repoPath === '.' ? e.path : `${repoMeta.repoPath}/${e.path}`;
        stats = probeUntracked(agentId, fullRel);
      }
      if (!stats) stats = { additions: 0, deletions: 0, binary: false };
      files.push({
        path: e.path,
        status: display,
        indexStatus: e.X,
        worktreeStatus: e.Y,
        renameFrom: e.renameFrom,
        additions: stats.additions,
        deletions: stats.deletions,
        binary: stats.binary,
      });
    }

    // Sort: modified → added → deleted → untracked → other; alphabetic within.
    const order = { 'M': 0, 'A': 1, 'D': 2, 'R': 3, 'C': 4, 'U': 5, '??': 6 };
    files.sort((a, b) => {
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.path.localeCompare(b.path, undefined, { sensitivity: 'base' });
    });

    result.push({
      repoPath: repoMeta.repoPath,
      branch: repoMeta.branch,
      changesCount: files.length,
      files,
    });
  }

  res.json({ repos: result });
});

// GET /api/agents/:agentId/workspace/git-diff?repo=...&path=...&context=3
// Returns the unified diff for a single file. Untracked files are diffed
// against /dev/null so the UI sees a uniform `diff --git` envelope.
app.get('/api/agents/:agentId/workspace/git-diff', heavyLimiter, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  const repoQ = typeof req.query.repo === 'string' ? req.query.repo : '.';
  const pathQ = typeof req.query.path === 'string' ? req.query.path : '';
  if (!pathQ) return res.status(400).json({ error: 'path query required' });
  // Reject traversal, NUL, leading dash (CLI option), and leading colon
  // (git pathspec magic — `:!`, `:(top)`, `:(literal)` etc.). Even with `--`
  // before pathQ, some git versions interpret pathspec magic, so we filter.
  if (!isSafeRepoRelPath(pathQ)) return res.status(400).json({ error: 'invalid path' });

  const repoAbs = resolveAgentRepo(agentId, repoQ);
  if (!repoAbs) return res.status(400).json({ error: 'invalid repo' });

  let context = Number.parseInt(req.query.context, 10);
  if (!Number.isFinite(context) || context < 0) context = 3;
  if (context > 20) context = 20;

  // Decide which form of `git diff` to invoke. For MVP-1 we always compare
  // working tree against HEAD; staged/branch modes are out of scope.
  const isUntracked = (() => {
    const lsFiles = runGit(
      ['ls-files', '--error-unmatch', '--', pathQ],
      repoAbs,
      { maxBuffer: 64 * 1024 },
    );
    return lsFiles.status !== 0;
  })();

  let diffRun;
  if (isUntracked) {
    // --no-index between /dev/null and the file produces a uniform envelope.
    // Exit code 1 is the success-with-differences case; status 0 (identical
    // file vs /dev/null can't really happen for an untracked file) is also
    // accepted. Anything else is an error.
    diffRun = runGit(
      ['diff', '--no-color', `-U${context}`, '--no-index', '--', '/dev/null', pathQ],
      repoAbs,
    );
    if (diffRun.error || (diffRun.status !== 0 && diffRun.status !== 1)) {
      return res.status(500).json({ error: 'git-diff-failed' });
    }
  } else {
    diffRun = runGit(
      ['diff', '--no-color', `-U${context}`, 'HEAD', '--', pathQ],
      repoAbs,
    );
    if (diffRun.error || diffRun.status !== 0) {
      return res.status(500).json({ error: 'git-diff-failed' });
    }
  }

  // Detect truncation by spawnSync's ENOBUFS surrogate (signal === null,
  // status === null, error.code === 'ENOBUFS'). We already returned above,
  // so if we got here the buffer was large enough — but we still cap the
  // payload size we send back to the client.
  const raw = (diffRun.stdout || Buffer.alloc(0)).toString('utf8');
  const truncated = raw.length >= GIT_DIFF_MAX_BUFFER - 1024; // close to the cap
  const diff = truncated ? raw.slice(0, GIT_DIFF_MAX_BUFFER) : raw;

  // Binary files → git emits "Binary files a/foo and b/foo differ" with no
  // hunks. Surface that to the client so it can show a placeholder instead
  // of trying to render it.
  const binary = /^Binary files .* differ$/m.test(diff) && !/^@@ /m.test(diff);

  res.json({
    repo: repoQ,
    path: pathQ,
    context,
    truncated,
    binary,
    diff,
  });
});

// File upload. Accepts multipart/form-data with:
//   files[]         — one or more files (max 500, 50 MB each)
//   path            — target directory relative to agent workspace root (optional, defaults to root)
//   relativePaths[] — optional parallel array; when provided for a file the value is the
//                     path relative to the target dir (e.g. "mydir/sub/file.txt") used to
//                     recreate the directory tree from a folder upload. Empty string means
//                     place the file directly in the target dir (plain file upload).
// The base target directory must already exist within the agent workspace.
// Filenames are sanitised; leading dots are preserved so agents can receive
// dotfiles (.env, .claude/settings.json, etc.) — overwriting those is an
// intentional capability for admins and not considered a vulnerability.
const _upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

// Wraps multer so its own errors (file too large, too many files, etc.) turn
// into clean JSON responses instead of falling through to Express's default
// HTML error page.
const uploadFiles = (req, res, next) => {
  _upload.array('files', 500)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({ error: 'File too large', message: 'Each file must be under 50 MB', code: err.code });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(400).json({ error: 'Too many files', code: err.code });
      }
      return res.status(400).json({ error: err.message, code: err.code });
    }
    return res.status(500).json({ error: err.message });
  });
};

// Reject malformed agent ids before multer buffers the multipart body —
// otherwise a bad agentId still costs us up to 500×50 MB of memory before
// the handler responds 400. Has to run before `uploadFiles`.
const requireAgentIdParam = (req, res, next) => {
  if (!AGENT_ID_RE.test(req.params.agentId)) {
    return res.status(400).json({ error: 'Invalid agent id' });
  }
  next();
};

app.post('/api/agents/:agentId/workspace/upload', heavyLimiter, requireAgentIdParam, uploadFiles, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });
  const relDir = typeof req.body.path === 'string' ? req.body.path : '';

  // relativePaths may arrive as a single string (one file) or an array (multiple files).
  const rawRelPaths = req.body.relativePaths;
  const relPaths = Array.isArray(rawRelPaths) ? rawRelPaths : (rawRelPaths != null ? [rawRelPaths] : []);

  // safeAgentPath validates agentId format, resolves realpath, and checks
  // path-traversal / outward-symlink containment — user-controlled input is
  // never passed raw to fs calls.
  const targetDir = safeAgentPath(agentId, relDir);
  if (!targetDir) return res.status(400).json({ error: 'Invalid target path' });

  let st;
  try {
    st = fs.statSync(targetDir);
  } catch (err) {
    if (err.code === 'ENOENT') return res.status(404).json({ error: 'Target directory not found' });
    return res.status(500).json({ error: err.message });
  }
  if (!st.isDirectory()) return res.status(400).json({ error: 'Target path is not a directory' });

  // Array.isArray narrows the type for the loop below: multer's
  // upload.array() always returns an Array, but the explicit guard rules out
  // tampering scenarios where a non-array value could reach this code path
  // (CodeQL js/type-confusion-through-parameter-tampering).
  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  // Resolve agent root for the final containment check. Wrap in try/catch to
  // handle the TOCTOU edge case where the workspace is removed between the
  // safeAgentPath call above and here.
  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch (err) {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }

  const uploaded = [];
  const errors = [];

  for (let i = 0; i < req.files.length; i++) {
    const file = req.files[i];
    const relFilePath = typeof relPaths[i] === 'string' ? relPaths[i] : '';

    // destName  — sanitised filename only (no directory component)
    // destParentDir — the directory in which the file will be placed, built
    //                 exclusively from safeAgentPath-resolved targetDir plus
    //                 individually sanitised path segments (no path.dirname on
    //                 tainted input, which would trigger CodeQL js/path-injection).
    let destName;
    let destParentDir;

    if (relFilePath) {
      // Folder upload: sanitise each segment individually, then split into
      // file name (last) and parent directory chain (all but last).
      const segments = relFilePath.split('/').map(seg =>
        path.basename(seg).replace(/[^\w\-. ()[\]]/g, '_').trim()
      ).filter(Boolean);
      if (segments.length === 0) {
        errors.push({ name: file.originalname, error: 'Invalid relative path' });
        continue;
      }
      destName = segments[segments.length - 1];
      destParentDir = segments.length > 1
        ? path.join(targetDir, ...segments.slice(0, -1))
        : targetDir;
    } else {
      // Plain file upload: just sanitise the filename.
      const safeName = path.basename(file.originalname).replace(/[^\w\-. ()[\]]/g, '_').trim();
      if (!safeName) {
        errors.push({ name: file.originalname, error: 'Invalid filename' });
        continue;
      }
      destName = safeName;
      destParentDir = targetDir;
    }

    const destPath = path.join(destParentDir, destName);

    // Defence-in-depth: the dest must still be strictly inside the agent root.
    if (destPath !== agentRoot && !destPath.startsWith(agentRoot + path.sep)) {
      errors.push({ name: file.originalname, error: 'Path escapes workspace' });
      continue;
    }

    try {
      // destParentDir is safeAgentPath(targetDir) + sanitised segments only —
      // it cannot contain '..' or path separators. Containment is verified above.
      fs.mkdirSync(destParentDir, { recursive: true }); // codeql[js/path-injection]
      fs.writeFileSync(destPath, file.buffer);
      uploaded.push({
        name: relFilePath || destName,
        path: path.relative(agentRoot, destPath),
        size: file.size,
      });
    } catch (err) {
      errors.push({ name: file.originalname, error: err.message });
    }
  }

  if (uploaded.length === 0 && errors.length > 0) {
    return res.status(500).json({ error: 'All uploads failed', details: errors });
  }
  res.json({ uploaded, ...(errors.length ? { errors } : {}) });
});

// Return a filename that doesn't yet exist in `dir`, appending " (n)" before
// the extension on collision so a second upload of `report.pdf` becomes
// `report (2).pdf` rather than clobbering the first. The " ()" chars are within
// the upload filename allowlist, so the result is still a legal workspace name.
function uniqueFileName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  for (let n = 2; n < 10000; n++) {
    const candidate = `${base} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  return `${base} (${Date.now()})${ext}`;
}

// Chat attachments: files dropped or picked directly in the chat composer land
// in a dedicated, server-controlled `chat-uploads/` directory (the client can't
// choose the path) and are referenced in the message body as
// `@chat-uploads/<name>`. The agent's cwd is its workspace root, so that token
// resolves to a file it can open. Mirrors the workspace/upload handler's multer
// config + filename sanitisation, but auto-creates the target dir and de-dupes
// colliding names.
const CHAT_UPLOADS_DIR = 'chat-uploads';
app.post('/api/agents/:agentId/chat-upload', heavyLimiter, requireAgentIdParam, uploadFiles, (req, res) => {
  const { agentId } = req.params;
  if (!AGENT_ID_RE.test(agentId)) return res.status(400).json({ error: 'Invalid agent id' });

  let agentRoot;
  try {
    agentRoot = fs.realpathSync(path.join(AGENTS_DIR, agentId));
  } catch {
    return res.status(404).json({ error: 'Agent workspace not found' });
  }

  if (!Array.isArray(req.files) || req.files.length === 0) {
    return res.status(400).json({ error: 'No files provided' });
  }

  const targetDir = path.join(agentRoot, CHAT_UPLOADS_DIR);
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: `Could not create upload directory: ${err.message}` });
  }

  const uploaded = [];
  const errors = [];
  for (const file of req.files) {
    const safeName = path.basename(file.originalname).replace(/[^\w\-. ()[\]]/g, '_').trim();
    if (!safeName) {
      errors.push({ name: file.originalname, error: 'Invalid filename' });
      continue;
    }
    const finalName = uniqueFileName(targetDir, safeName);
    const destPath = path.join(targetDir, finalName);
    // Defence-in-depth: the dest must stay strictly inside the agent root.
    if (!destPath.startsWith(agentRoot + path.sep)) {
      errors.push({ name: file.originalname, error: 'Path escapes workspace' });
      continue;
    }
    try {
      fs.writeFileSync(destPath, file.buffer);
      uploaded.push({
        name: finalName,
        ref: `${CHAT_UPLOADS_DIR}/${finalName}`,
        path: path.relative(agentRoot, destPath),
        size: file.size,
      });
    } catch (err) {
      errors.push({ name: file.originalname, error: err.message });
    }
  }

  if (uploaded.length === 0 && errors.length > 0) {
    return res.status(500).json({ error: 'All uploads failed', details: errors });
  }
  res.json({ uploaded, ...(errors.length ? { errors } : {}) });
});

function parseJsonlLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'parse_error', raw: line.slice(0, 200) };
  }
}

// Static backfill: read JSONL from `since` (default 0) up to current EOF.
app.get('/api/agents/:agentId/session/:roomId', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl'); // pushed copy preferred (#185)

  if (!fs.existsSync(filepath)) {
    return res.json({ events: [], cursor: 0 });
  }

  const since = Math.max(0, parseInt(req.query.since, 10) || 0);
  const limit = Math.max(1, parseInt(req.query.limit, 10) || 1000);

  let size;
  try {
    size = fs.statSync(filepath).size;
  } catch (err) {
    return res.status(500).json({ error: 'stat failed: ' + err.message });
  }

  // If `since` is past EOF (e.g. file was truncated), read from start.
  const start = since > size ? 0 : since;
  if (start >= size) {
    return res.json({ events: [], cursor: size });
  }

  const stream = fs.createReadStream(filepath, { start, end: size - 1, encoding: 'utf8' });
  let buf = '';
  let events = [];

  stream.on('data', (chunk) => {
    buf += chunk;
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) events.push(parseJsonlLine(line));
    }
  });

  stream.on('error', (err) => {
    res.status(500).json({ error: 'read failed: ' + err.message });
  });

  stream.on('end', () => {
    if (buf.trim()) events.push(parseJsonlLine(buf));
    let truncated = false;
    if (events.length > limit) {
      events = events.slice(events.length - limit);
      truncated = true;
    }
    const body = { events, cursor: size };
    if (truncated) body.truncated = true;
    res.json(body);
  });
});

// Live tail via SSE.
app.get('/api/agents/:agentId/session/:roomId/stream', (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  const filepath = controlOrAgentPath(agentId, 'sessions', roomId + '.jsonl'); // pushed copy preferred (#185)
  const dirpath = path.dirname(filepath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();

  // Initial cursor: explicit `since`, else end-of-file.
  let cursor;
  if (req.query.since !== undefined) {
    cursor = Math.max(0, parseInt(req.query.since, 10) || 0);
  } else {
    try {
      cursor = fs.existsSync(filepath) ? fs.statSync(filepath).size : 0;
    } catch {
      cursor = 0;
    }
  }

  let lineBuf = '';
  let fileWatcher = null;
  let dirWatcher = null;
  let draining = false;
  let pending = false;
  let closed = false;

  const writeEvent = (obj) => {
    try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* noop */ }
  };
  const writeCursor = () => {
    writeEvent({ type: '_cursor', cursor });
  };

  // Initial ready signal + cursor so the client knows where it's positioned.
  try { res.write(': ready\n\n'); } catch { /* noop */ }
  writeCursor();

  // Heartbeat — keep proxies / load balancers from closing the connection.
  const heartbeat = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { /* noop */ }
  }, 15000);

  const drain = () => {
    if (closed) return;
    if (draining) { pending = true; return; }
    draining = true;

    let size;
    try {
      if (!fs.existsSync(filepath)) {
        draining = false;
        if (pending) { pending = false; setImmediate(drain); }
        return;
      }
      size = fs.statSync(filepath).size;
    } catch (err) {
      draining = false;
      return;
    }

    // File truncated / rotated externally — start over from the top.
    if (size < cursor) {
      cursor = 0;
      lineBuf = '';
      writeEvent({ type: '_truncated' });
    }
    if (size === cursor) {
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
      return;
    }

    const stream = fs.createReadStream(filepath, { start: cursor, end: size - 1, encoding: 'utf8' });

    stream.on('data', (chunk) => {
      lineBuf += chunk;
      let idx;
      while ((idx = lineBuf.indexOf('\n')) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim()) writeEvent(parseJsonlLine(line));
      }
    });

    stream.on('error', () => {
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
    });

    stream.on('end', () => {
      cursor = size;
      writeCursor();
      draining = false;
      if (pending) { pending = false; setImmediate(drain); }
    });
  };

  const startFileWatcher = () => {
    if (fileWatcher || closed) return;
    try {
      fileWatcher = fs.watch(filepath, { persistent: false }, () => drain());
      fileWatcher.on('error', () => {
        try { fileWatcher.close(); } catch { /* noop */ }
        fileWatcher = null;
        // Fall back to dir-watch so we re-pick the file up if it reappears.
        startDirWatcher();
      });
    } catch {
      fileWatcher = null;
      startDirWatcher();
    }
  };

  const startDirWatcher = () => {
    if (dirWatcher || closed) return;
    try {
      fs.mkdirSync(dirpath, { recursive: true });
    } catch { /* noop */ }
    try {
      dirWatcher = fs.watch(dirpath, { persistent: false }, (_evt, fname) => {
        if (closed) return;
        if (fname && fname !== path.basename(filepath)) return;
        if (fs.existsSync(filepath)) {
          try { dirWatcher.close(); } catch { /* noop */ }
          dirWatcher = null;
          startFileWatcher();
          drain();
        }
      });
      dirWatcher.on('error', () => {
        try { dirWatcher.close(); } catch { /* noop */ }
        dirWatcher = null;
      });
    } catch {
      dirWatcher = null;
    }
  };

  if (fs.existsSync(filepath)) {
    startFileWatcher();
    // Read anything that's already past cursor (matters when `since` < EOF).
    drain();
  } else {
    startDirWatcher();
  }

  req.on('close', () => {
    closed = true;
    clearInterval(heartbeat);
    if (fileWatcher) { try { fileWatcher.close(); } catch { /* noop */ } fileWatcher = null; }
    if (dirWatcher) { try { dirWatcher.close(); } catch { /* noop */ } dirWatcher = null; }
    try { res.end(); } catch { /* noop */ }
  });
});

/* ─── BP-Explorer Proxy ────────────────────────────────────────────── */
// Forwards /api/bp-explorer/* → http://bp-explorer:8765/api/*
app.all('/api/bp-explorer/*', async (req, res) => {
  const upstreamPath = req.path.replace(/^\/api\/bp-explorer/, '/api');
  const qs = new URLSearchParams(req.query).toString();
  const url = `${BP_EXPLORER_URL}${upstreamPath}${qs ? '?' + qs : ''}`;
  const opts = { method: req.method };
  if (req.method !== 'GET' && req.method !== 'HEAD' && req.body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(req.body);
  }
  try {
    const upstream = await fetch(url, opts);
    const data = await upstream.json();
    res.status(upstream.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `BP-Explorer unreachable: ${err.message}` });
  }
});

/* ─── SPA fallback ──────────────────────────────────────────────────── */

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(4000, '0.0.0.0', () => console.log('[Admin] Listening on :4000'));
