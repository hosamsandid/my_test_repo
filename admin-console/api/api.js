'use strict';

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const matrix = require('./matrix');

const WORKSPACE = '/workspace';
const POOL_DIR = '/pool';
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const ENVIRONMENTS_DIR = path.join(WORKSPACE, 'environments');
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, '_keys');
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, 'index.json');
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');
const GH_TOKENS_INDEX = path.join(GH_TOKENS_DIR, 'index.json');
const LLM_ENDPOINTS_DIR = path.join(WORKSPACE, 'llm-endpoints');
const LLM_ENDPOINTS_INDEX = path.join(LLM_ENDPOINTS_DIR, 'index.json');
const LLM_KEYS_DIR = path.join(LLM_ENDPOINTS_DIR, '_keys');
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const BP_EXPLORER_URL = process.env.BP_EXPLORER_URL || 'http://bp-explorer:8765';

fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
fs.mkdirSync(GH_TOKENS_DIR, { recursive: true });
fs.mkdirSync(LLM_ENDPOINTS_DIR, { recursive: true });
fs.mkdirSync(LLM_KEYS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
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

/* ─── Helpers ───────────────────────────────────────────────────────── */

function writeJsonAtomic(filePath, data) {
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
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
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
  const dir = path.join(ENVIRONMENTS_DIR, envId);
  fs.mkdirSync(dir, { recursive: true });
  writeJsonAtomic(path.join(dir, 'environment.json'), data);
}

function listSshKeys() {
  return readJsonFile(SSH_KEYS_INDEX, []);
}

function saveSshKeysIndex(keys) {
  writeJsonAtomic(SSH_KEYS_INDEX, keys);
}

function sshKeyFingerprint(privateKey) {
  return 'SHA256:' + crypto.createHash('sha256').update(privateKey).digest('base64').replace(/=+$/, '');
}

function environmentInUse(envId) {
  for (const id of listAgentDirs()) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.environmentId === envId) return id;
  }
  return null;
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
    hasToken: Boolean(token),
    tokenPreview: token ? llmTokenPreview(token) : '',
    tokenFingerprint: token ? llmTokenFingerprint(token) : '',
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

/* ─── Dashboard ─────────────────────────────────────────────────────── */

app.get('/api/dashboard', (req, res) => {
  const agentDirs = listAgentDirs();
  let active = 0;
  let disabled = 0;
  let agentSkills = 0;
  let triggerCount = 0;

  for (const id of agentDirs) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.enabled === false) disabled++;
    else active++;

    const skillsDir = path.join(AGENTS_DIR, id, 'skills');
    try {
      const skills = fs.readdirSync(skillsDir).filter(n => {
        return fs.existsSync(path.join(skillsDir, n, 'SKILL.md'));
      });
      agentSkills += skills.length;
    } catch { /* no skills dir */ }

    const triggers = readJsonFile(path.join(AGENTS_DIR, id, 'triggers.json'), []);
    if (Array.isArray(triggers)) triggerCount += triggers.length;
  }

  let poolSkills = 0;
  const poolSkillsDir = path.join(POOL_DIR, 'skills');
  try {
    poolSkills = fs.readdirSync(poolSkillsDir).filter(n =>
      fs.existsSync(path.join(poolSkillsDir, n, 'SKILL.md'))
    ).length;
  } catch { /* no dir */ }

  res.json({
    agents: { total: agentDirs.length, active, disabled },
    jobs: { total: triggerCount },
    skills: { total: poolSkills + agentSkills },
  });
});

/* ─── Agents ────────────────────────────────────────────────────────── */

app.get('/api/agents', (req, res) => {
  const ids = listAgentDirs();
  const agents = ids.map(id => {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    return { id, ...cfg };
  });
  res.json(agents);
});

// NOTE: must be registered BEFORE `/api/agents/:id` — otherwise Express
// would match this static path against the parameterized route (with
// id="statuses") and return 404.
app.get('/api/agents/statuses', async (req, res) => {
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
    if (cfg.enabled === false) return { id, displayName, activityState: 'disabled' };
    if (!runningIds.has(id)) return { id, displayName, activityState: 'offline' };
    const status = readJsonFile(path.join(AGENTS_DIR, id, 'status.json'), null);
    return {
      id,
      displayName,
      activityState: status?.state === 'busy' ? 'busy' : 'idle',
      lastResponseAt: status?.lastResponseAt ?? null,
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
  const triggers = readJsonFile(path.join(agentDir, 'triggers.json'), []);
  res.json({ id, ...cfg, triggers });
});

app.put('/api/agents/:id', async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const { displayName, role, enabled, briefingsPath } = req.body;

  // Enable/disable goes through the orchestrator so stubs (no token yet)
  // get fully materialized — Matrix user, workspace seeding, agent-runner
  // process — on first activation. For already-materialized agents this
  // just (re)spawns or stops the runner.
  if (enabled !== undefined && enabled !== (cfg.enabled !== false)) {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
    const action = enabled ? 'enable' : 'disable';
    try {
      const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/${action}`, {
        method: 'POST',
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(resp.status).json(data);
      // Re-read the updated config — orchestrator wrote the canonical version.
    } catch (err) {
      return res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
    }
  }

  // Apply the rest of the field updates directly to the on-disk config.
  // (The orchestrator's enable/disable already wrote enabled itself.)
  const fresh = readJsonFile(cfgPath, cfg);
  if (displayName !== undefined) fresh.displayName = displayName;
  if (role !== undefined) fresh.role = role;
  if (briefingsPath !== undefined) fresh.briefingsPath = briefingsPath;
  writeJsonAtomic(cfgPath, fresh);
  res.json({ id, ...fresh });
});

/* ─── Reset agent to stub state ─────────────────────────────────────── */

app.post('/api/agents/:id/deactivate', async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/deactivate`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

/* ─── BP stub sync ──────────────────────────────────────────────────── */

app.post('/api/agents/:id/sync-bps', async (req, res) => {
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

app.post('/api/agents/:groupId/instances', async (req, res) => {
  const { groupId } = req.params;
  if (!AGENT_ID_RE.test(groupId)) return res.status(400).json({ error: 'Invalid agent id' });
  if (!fs.existsSync(path.join(AGENTS_DIR, groupId))) {
    return res.status(404).json({ error: 'Agent group not found' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agent-groups/${encodeURIComponent(groupId)}/instances`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/agents', async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, briefingsPath } = req.body;
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  if (!systemPrompt && role !== 'orchestrator') {
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
      body: JSON.stringify({ id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, briefingsPath }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.delete('/api/agents/:id', async (req, res) => {
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

app.post('/api/agents/:id/clone', async (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const { newId, newDisplayName } = req.body || {};
  if (!newId || !newDisplayName) {
    return res.status(400).json({ error: 'newId and newDisplayName required' });
  }
  const normalizedNewId = newId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalizedNewId) {
    return res.status(400).json({ error: 'newId must contain at least one valid character (a-z, 0-9, -)' });
  }
  if (!fs.existsSync(path.join(AGENTS_DIR, id))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(id)}/clone`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newId: normalizedNewId, newDisplayName }),
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.status(201).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
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

app.put('/api/agents/:id/prompt', (req, res) => {
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
    defaultModelId: env?.defaultModelId || null,
    override:      cfg.modelOverride || null,
    models:        endpoint?.models || [],
  });
});

app.patch('/api/agents/:id/model', (req, res) => {
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
  const triggers = readJsonFile(path.join(agentDir, 'triggers.json'), []);
  res.json(Array.isArray(triggers) ? triggers : []);
});

function notifyTriggerReload(agentId) {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  fetch(`${orchestratorUrl}/internal/agents/${encodeURIComponent(agentId)}/reload-triggers`, { method: 'POST' })
    .catch(() => {});
}

app.post('/api/agents/:id/triggers', (req, res) => {
  const { id } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const newTrigger = { id: `t${Date.now()}`, ...req.body };
  triggers.push(newTrigger);
  writeJsonAtomic(triggersPath, triggers);
  notifyTriggerReload(id);
  res.status(201).json(newTrigger);
});

app.put('/api/agents/:id/triggers/:triggerId', (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const idx = triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) return res.status(404).json({ error: 'Trigger not found' });
  triggers[idx] = { ...triggers[idx], ...req.body, id: triggerId };
  writeJsonAtomic(triggersPath, triggers);
  notifyTriggerReload(id);
  res.json(triggers[idx]);
});

app.delete('/api/agents/:id/triggers/:triggerId', (req, res) => {
  const { id, triggerId } = req.params;
  if (!AGENT_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid agent id' });
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const filtered = triggers.filter(t => t.id !== triggerId);
  writeJsonAtomic(triggersPath, filtered);
  notifyTriggerReload(id);
  res.status(204).end();
});

/* ─── Skills ────────────────────────────────────────────────────────── */

app.get('/api/skills', (req, res) => {
  const skills = [];
  const seen = new Set();

  // Pool (shared) skills
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

  // Agent skills
  for (const agentId of listAgentDirs()) {
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
    skillPath = path.join(AGENTS_DIR, agentId, 'skills', name, 'SKILL.md');
  } else if (source === 'agent') {
    return res.status(400).json({ error: 'Invalid agent id' });
  } else {
    skillPath = path.join(POOL_DIR, 'skills', name, 'SKILL.md');
  }

  if (!fs.existsSync(skillPath)) return res.status(404).json({ error: 'Skill not found' });
  const content = fs.readFileSync(skillPath, 'utf8');
  res.json({ content });
});

/* ─── System Config ─────────────────────────────────────────────────── */

const SYSTEM_CONFIG_FILE = path.join(WORKSPACE, 'config.json');

function readSystemConfig() {
  const stored = readJsonFile(SYSTEM_CONFIG_FILE, {});
  return {
    aceRepoPath: stored.aceRepoPath ?? (process.env.ACE_REPO_PATH || ''),
  };
}

app.get('/api/config', (req, res) => {
  res.json(readSystemConfig());
});

app.put('/api/config', (req, res) => {
  const { aceRepoPath } = req.body || {};
  if (aceRepoPath !== undefined && typeof aceRepoPath !== 'string') {
    return res.status(400).json({ error: 'aceRepoPath must be a string' });
  }
  if (aceRepoPath && !path.isAbsolute(aceRepoPath)) {
    return res.status(400).json({ error: 'aceRepoPath must be an absolute path' });
  }
  const current = readSystemConfig();
  const updated = { ...current };
  if (aceRepoPath !== undefined) updated.aceRepoPath = aceRepoPath;
  writeJsonAtomic(SYSTEM_CONFIG_FILE, updated);
  res.json(updated);
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

app.get('/api/llm-endpoints', (req, res) => {
  res.json(listLlmEndpoints().map(maskLlmEndpoint));
});

app.get('/api/llm-endpoints/:id', (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  res.json(maskLlmEndpoint(ep));
});

app.post('/api/llm-endpoints', (req, res) => {
  const { name, baseUrl, authToken, models } = req.body || {};
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
  if (!baseUrl || typeof baseUrl !== 'string') return res.status(400).json({ error: 'baseUrl is required' });
  try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  const modelList = Array.isArray(models) ? models : [];
  const modelErr = validateModels(modelList);
  if (modelErr) return res.status(400).json({ error: modelErr });

  const existing = listLlmEndpoints();
  let id = slugifyId(name) || `ep-${Date.now()}`;
  if (existing.some(e => e.id === id)) id = `${id}-${Date.now().toString(36)}`;

  let authTokenId = '';
  if (authToken && typeof authToken === 'string' && authToken.trim()) {
    authTokenId = `${id}-${Date.now().toString(36)}`;
    writeLlmEndpointToken(authTokenId, authToken.trim());
  }

  const entry = {
    id,
    name,
    baseUrl,
    authTokenId,
    models: modelList.map(m => ({
      id: m.id,
      displayName: m.displayName || m.id,
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.notes ? { notes: m.notes } : {}),
    })),
    createdAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex([...existing, entry]);
  res.status(201).json(maskLlmEndpoint(entry));
});

app.put('/api/llm-endpoints/:id', (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  const current = list[idx];
  const { name, baseUrl, authToken, models } = req.body || {};

  if (baseUrl !== undefined) {
    if (typeof baseUrl !== 'string' || !baseUrl) return res.status(400).json({ error: 'baseUrl must be a non-empty string' });
    try { new URL(baseUrl); } catch { return res.status(400).json({ error: 'baseUrl must be a valid URL' }); }
  }
  if (models !== undefined) {
    const modelErr = validateModels(models);
    if (modelErr) return res.status(400).json({ error: modelErr });
  }

  const next = { ...current };
  if (name !== undefined)    next.name    = String(name);
  if (baseUrl !== undefined) next.baseUrl = baseUrl;
  if (models !== undefined)  next.models  = models.map(m => ({
    id: m.id,
    displayName: m.displayName || m.id,
    ...(m.kind ? { kind: m.kind } : {}),
    ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
    ...(m.notes ? { notes: m.notes } : {}),
  }));

  // Token rotation: if `authToken` is a non-empty string, replace; if it's an
  // empty string, clear; if undefined, leave the existing token alone.
  if (authToken !== undefined) {
    if (typeof authToken === 'string' && authToken.trim()) {
      const newId = current.authTokenId || `${current.id}-${Date.now().toString(36)}`;
      writeLlmEndpointToken(newId, authToken.trim());
      if (newId !== current.authTokenId && current.authTokenId) {
        deleteLlmEndpointToken(current.authTokenId);
      }
      next.authTokenId = newId;
    } else {
      if (current.authTokenId) deleteLlmEndpointToken(current.authTokenId);
      next.authTokenId = '';
    }
  }

  next.updatedAt = new Date().toISOString();
  list[idx] = next;
  saveLlmEndpointsIndex(list);
  res.json(maskLlmEndpoint(next));
});

app.put('/api/llm-endpoints/:id/models', (req, res) => {
  const list = listLlmEndpoints();
  const idx = list.findIndex(e => e.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'LLM endpoint not found' });
  const models = req.body && Array.isArray(req.body.models) ? req.body.models : req.body;
  const modelErr = validateModels(models);
  if (modelErr) return res.status(400).json({ error: modelErr });
  list[idx] = {
    ...list[idx],
    models: models.map(m => ({
      id: m.id,
      displayName: m.displayName || m.id,
      ...(m.kind ? { kind: m.kind } : {}),
      ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      ...(m.notes ? { notes: m.notes } : {}),
    })),
    updatedAt: new Date().toISOString(),
  };
  saveLlmEndpointsIndex(list);
  res.json(maskLlmEndpoint(list[idx]));
});

app.delete('/api/llm-endpoints/:id', (req, res) => {
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

app.post('/api/llm-endpoints/:id/test', async (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  const url = buildModelsUrl(ep.baseUrl);
  const headers = token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {};
  const result = await httpGetJson(url, headers);
  const ok = result.status >= 200 && result.status < 300;
  res.json({
    ok,
    url,
    status: result.status,
    error: result.error || (ok ? null : `HTTP ${result.status}`),
    sample: ok && result.body && typeof result.body === 'object'
      ? Array.isArray(result.body?.data) ? result.body.data.slice(0, 3) : result.body
      : null,
  });
});

app.post('/api/llm-endpoints/:id/discover-models', async (req, res) => {
  const ep = listLlmEndpoints().find(e => e.id === req.params.id);
  if (!ep) return res.status(404).json({ error: 'LLM endpoint not found' });
  const token = readLlmEndpointToken(ep.authTokenId);
  const url = buildModelsUrl(ep.baseUrl);
  const headers = token ? { Authorization: `Bearer ${token}`, 'x-api-key': token } : {};
  const result = await httpGetJson(url, headers);
  if (result.error || result.status < 200 || result.status >= 300) {
    return res.status(502).json({ error: result.error || `HTTP ${result.status}`, url, status: result.status });
  }
  // OpenAI-compatible shape: { data: [{ id, ... }] }; LiteLLM also exposes
  // model_info on each entry. Normalize to our { id, displayName, kind?, … }.
  const raw = Array.isArray(result.body?.data) ? result.body.data
            : Array.isArray(result.body)       ? result.body
            : [];
  const suggested = raw
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
  res.json({ url, count: suggested.length, models: suggested });
});

/* ─── MCP Config ────────────────────────────────────────────────────── */

const MCP_SETTINGS_FILE = path.join(POOL_DIR, '.claude', 'settings.json');

app.get('/api/mcp', (req, res) => {
  const settings = readJsonFile(MCP_SETTINGS_FILE, {});
  res.json(settings.mcpServers || {});
});

app.put('/api/mcp/:name', (req, res) => {
  const settings = readJsonFile(MCP_SETTINGS_FILE, {});
  if (!settings.mcpServers) settings.mcpServers = {};
  settings.mcpServers[req.params.name] = { ...settings.mcpServers[req.params.name], ...req.body };
  writeJsonAtomic(MCP_SETTINGS_FILE, settings);
  res.json(settings.mcpServers[req.params.name]);
});

/* ─── Containers ────────────────────────────────────────────────────── */

app.get('/api/containers', async (req, res) => {
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

app.get('/api/environments', (req, res) => {
  const envs = listEnvironmentIds().map(loadEnvironment).filter(Boolean);
  res.json(envs);
});

app.get('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  res.json(env);
});

// Resolve and validate { llmEndpointId, defaultModelId } against the registry.
// Returns { error } on failure, { llmEndpointId, defaultModelId } on success.
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
  }
  return { llmEndpointId: ep.id, defaultModelId: defaultModelId || null };
}

app.post('/api/environments', (req, res) => {
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId } = req.body || {};
  const id = normalizeEnvId(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id is required (a-z, 0-9, -)' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (loadEnvironment(id)) return res.status(409).json({ error: `Environment '${id}' already exists` });

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

  const llm = resolveLlmBinding(llmEndpointId, defaultModelId);
  if (llm.error) return res.status(400).json({ error: llm.error });

  const env = {
    id,
    name,
    description: description || '',
    skills: Array.isArray(skills) ? skills : [],
    repositories: normalizedRepos,
    githubTokenId: githubTokenId || null,
    llmEndpointId: llm.llmEndpointId,
    defaultModelId: llm.defaultModelId,
    additionalContext: additionalContext || '',
    createdAt: new Date().toISOString(),
  };
  saveEnvironment(id, env);
  res.status(201).json(env);
});

app.put('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId, llmEndpointId, defaultModelId } = req.body || {};

  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
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
  if (additionalContext !== undefined) env.additionalContext = additionalContext;
  env.updatedAt = new Date().toISOString();
  saveEnvironment(env.id, env);
  res.json(env);
});

app.delete('/api/environments/:id', (req, res) => {
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
app.post('/api/repositories/check', async (req, res) => {
  const { url, sshKeyId } = req.body || {};
  if (!url || typeof url !== 'string') {
    return res.status(400).json({ ok: false, error: 'url is required' });
  }
  if (sshKeyId) {
    const keys = listSshKeys();
    if (!keys.some(k => k.id === sshKeyId)) {
      return res.status(400).json({ ok: false, error: `SSH key '${sshKeyId}' not found` });
    }
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/repository-check`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, sshKeyId: sshKeyId || null }),
    });
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ ok: false, error: `Probe failed: ${err.message}` });
  }
});

/* ─── Blueprints ────────────────────────────────────────────────────── */

app.get('/api/blueprints', async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/blueprints`);
    const data = await resp.json();
    res.status(resp.status).json(data);
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.post('/api/blueprints', async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, briefingsPath } = req.body || {};
  if (!id || !displayName || !role || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, environmentId required' });
  }
  if (!systemPrompt && role !== 'orchestrator') {
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

app.put('/api/blueprints/:id', async (req, res) => {
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

app.delete('/api/blueprints/:id', async (req, res) => {
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

app.post('/api/blueprints/:id/instances', async (req, res) => {
  const { instanceId, displayName } = req.body || {};
  if (!instanceId || !displayName) {
    return res.status(400).json({ error: 'instanceId and displayName required' });
  }
  const normalizedId = instanceId.toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!normalizedId) {
    return res.status(400).json({ error: 'instanceId must contain at least one valid character (a-z, 0-9, -)' });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}/instances`,
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

app.get('/api/blueprints/:id/memory/:file', async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}/memory/${encodeURIComponent(req.params.file)}`
    );
    if (!resp.ok) return res.status(resp.status).json({ error: 'Not found' });
    const content = await resp.text();
    res.json({ content });
  } catch (err) {
    res.status(502).json({ error: `Orchestrator unreachable: ${err.message}` });
  }
});

app.put('/api/blueprints/:id/memory/:file', express.text({ type: '*/*' }), async (req, res) => {
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(
      `${orchestratorUrl}/internal/blueprints/${encodeURIComponent(req.params.id)}/memory/${encodeURIComponent(req.params.file)}`,
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
  res.json(listSshKeys());
});

app.post('/api/ssh-keys', (req, res) => {
  const { name, privateKey } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!privateKey || typeof privateKey !== 'string') {
    return res.status(400).json({ error: 'privateKey (string) is required' });
  }
  const trimmed = privateKey.trim();
  if (!/-----BEGIN [A-Z ]+PRIVATE KEY-----/.test(trimmed)) {
    return res.status(400).json({ error: 'privateKey does not look like an SSH private key' });
  }

  // Generate a stable, filesystem-safe id from the name
  const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  let id = baseId || `key-${Date.now()}`;
  const existing = listSshKeys();
  if (existing.some(k => k.id === id)) {
    id = `${id}-${Date.now().toString(36)}`;
  }
  // Re-check the derived id against the strict allowlist — the .replace
  // chain above is correct, but the explicit regex test is what CodeQL
  // recognises as a path-injection sanitizer.
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });

  const keyPath = path.join(SSH_KEYS_DIR, id);
  fs.writeFileSync(keyPath, trimmed.endsWith('\n') ? trimmed : trimmed + '\n', { mode: 0o600 });
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    fingerprint: sshKeyFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveSshKeysIndex([...existing, entry]);
  res.status(201).json(entry);
});

app.delete('/api/ssh-keys/:id', (req, res) => {
  const { id } = req.params;
  if (!SSH_KEY_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid ssh key id' });
  const keys = listSshKeys();
  if (!keys.some(k => k.id === id)) return res.status(404).json({ error: 'SSH key not found' });
  const usedBy = sshKeyInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `SSH key is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(SSH_KEYS_DIR, id)); } catch { /* ignore */ }
  saveSshKeysIndex(keys.filter(k => k.id !== id));
  res.status(204).end();
});

/* ─── GitHub Tokens ─────────────────────────────────────────────────── */

app.get('/api/github-tokens', (req, res) => {
  // Metadata only — never the raw token
  res.json(listGithubTokens());
});

app.post('/api/github-tokens', (req, res) => {
  const { name, token } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'token (string) is required' });
  }
  const trimmed = token.trim();
  if (!/^(github_pat_|ghp_|gho_|ghs_|ghu_|ghr_)[A-Za-z0-9_]{20,}$/.test(trimmed)) {
    return res.status(400).json({
      error: "token does not look like a GitHub token (expected prefix github_pat_, ghp_, gho_, ghs_, ghu_ or ghr_)",
    });
  }

  const baseId = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
  let id = baseId || `token-${Date.now()}`;
  const existing = listGithubTokens();
  if (existing.some(t => t.id === id)) {
    id = `${id}-${Date.now().toString(36)}`;
  }
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });

  const tokenPath = path.join(GH_TOKENS_DIR, id);
  fs.writeFileSync(tokenPath, trimmed, { mode: 0o600 });
  try { fs.chmodSync(tokenPath, 0o600); } catch { /* best effort */ }

  const entry = {
    id,
    name,
    preview: githubTokenPreview(trimmed),
    fingerprint: githubTokenFingerprint(trimmed),
    createdAt: new Date().toISOString(),
  };
  saveGithubTokensIndex([...existing, entry]);
  res.status(201).json(entry);
});

app.delete('/api/github-tokens/:id', (req, res) => {
  const { id } = req.params;
  if (!GH_TOKEN_ID_RE.test(id)) return res.status(400).json({ error: 'Invalid token id' });
  const tokens = listGithubTokens();
  if (!tokens.some(t => t.id === id)) return res.status(404).json({ error: 'GitHub token not found' });
  const usedBy = githubTokenInUse(id);
  if (usedBy) {
    return res.status(409).json({ error: `GitHub token is used by environment '${usedBy}'. Detach it first.` });
  }
  try { fs.unlinkSync(path.join(GH_TOKENS_DIR, id)); } catch { /* ignore */ }
  saveGithubTokensIndex(tokens.filter(t => t.id !== id));
  res.status(204).end();
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
  const ids = listAgentDirs();
  const out = [];
  for (const id of ids) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), null);
    if (!cfg) continue;
    if (cfg.enabled === false) continue;
    if (!cfg.token) continue;
    const dm = matrix.getAgentDmRoom(id);
    const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
    out.push({
      id,
      displayName: cfg.displayName || id,
      role: cfg.role || 'expert',
      userId: cfg.userId || `@${id}:local`,
      enabled: cfg.enabled !== false,
      dmRoomId: dm?.roomId || null,
      environmentId: cfg.environmentId || null,
      environmentName: env?.name || cfg.environmentId || null,
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
  return { roomId, reused: false, created: true };
}

app.post('/api/matrix/agents/:agentId/dm', async (req, res) => {
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
app.get('/api/matrix/rooms/:roomId/messages', async (req, res) => {
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
app.post('/api/matrix/rooms/:roomId/messages', async (req, res) => {
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
app.delete('/api/matrix/rooms/:roomId/messages', async (req, res) => {
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

const ROOM_ID_RE = /^![a-zA-Z0-9_-]+:[a-zA-Z0-9.-]+$/;

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
  const ptr = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.current.json');
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
app.delete('/api/agents/:agentId/session/:roomId/current', async (req, res) => {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    return res.status(400).json({ error: 'invalid id' });
  }
  try {
    fs.rmSync(path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.current.json'), { force: true });
    const flagPath = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.reset.json');
    fs.mkdirSync(path.dirname(flagPath), { recursive: true });
    writeJsonAtomic(flagPath, { resetAt: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }

  // Best-effort repository reset — failures are logged but never block the response.
  let repoResults = [];
  try {
    const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
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
app.post('/api/agents/:agentId/session/:roomId/stop', async (req, res) => {
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
app.get('/api/agents/:agentId/workspace/tree', (req, res) => {
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

function getAgentGitRepos(agentId) {
  const agentRoot = path.join(AGENTS_DIR, agentId);
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
  if (!fs.existsSync(path.join(AGENTS_DIR, agentId))) {
    return res.status(404).json({ error: 'Agent not found' });
  }
  res.json({ repos: getAgentGitRepos(agentId) });
});

// Directory-only listing — delegated to BP-Explorer for orchestrator directory picker.
app.get('/api/agents/:agentId/workspace/dirs', async (req, res) => {
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
app.get('/api/agents/:agentId/workspace/file', (req, res) => {
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

app.post('/api/agents/:agentId/workspace/upload', requireAgentIdParam, uploadFiles, (req, res) => {
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
  const filepath = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.jsonl');

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
  const filepath = path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.jsonl');
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
