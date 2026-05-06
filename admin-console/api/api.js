'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const matrix = require('./matrix');

const WORKSPACE = '/workspace';
const POOL_DIR = '/pool';
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const ENVIRONMENTS_DIR = path.join(WORKSPACE, 'environments');
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, '_keys');
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, 'index.json');
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, '_tokens');
const GH_TOKENS_INDEX = path.join(GH_TOKENS_DIR, 'index.json');
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';
const BP_EXPLORER_URL = process.env.BP_EXPLORER_URL || 'http://bp-explorer:8765';

fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });
fs.mkdirSync(GH_TOKENS_DIR, { recursive: true });

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(STATIC_DIR));

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

/* ─── Health ────────────────────────────────────────────────────────── */

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
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
    if (cfg.enabled === false) return { id, activityState: 'disabled' };
    if (!runningIds.has(id)) return { id, activityState: 'offline' };
    const status = readJsonFile(path.join(AGENTS_DIR, id, 'status.json'), null);
    return {
      id,
      activityState: status?.state === 'busy' ? 'busy' : 'idle',
      lastResponseAt: status?.lastResponseAt ?? null,
    };
  });

  res.json(statuses);
});

app.get('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(path.join(agentDir, 'triggers.json'), []);
  res.json({ id, ...cfg, triggers });
});

app.put('/api/agents/:id', async (req, res) => {
  const { id } = req.params;
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

/* ─── BP stub sync ──────────────────────────────────────────────────── */

app.post('/api/agents/:id/sync-bps', async (req, res) => {
  const { id } = req.params;
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/orchestrators/${encodeURIComponent(id)}/sync-bps`, {
      method: 'POST',
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json(data);
    res.json(data);
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
  const promptPath = path.join(AGENTS_DIR, id, 'AGENT-PROMPT.md');
  if (!fs.existsSync(path.join(AGENTS_DIR, id))) return res.status(404).json({ error: 'Agent not found' });
  let content = '';
  try { content = fs.readFileSync(promptPath, 'utf8'); } catch { /* file may not exist yet */ }
  res.json({ content });
});

app.put('/api/agents/:id/prompt', (req, res) => {
  const { id } = req.params;
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

/* ─── Agent Triggers ────────────────────────────────────────────────── */

app.get('/api/agents/:id/triggers', (req, res) => {
  const { id } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(path.join(agentDir, 'triggers.json'), []);
  res.json(Array.isArray(triggers) ? triggers : []);
});

app.post('/api/agents/:id/triggers', (req, res) => {
  const { id } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const newTrigger = { id: `t${Date.now()}`, ...req.body };
  triggers.push(newTrigger);
  writeJsonAtomic(triggersPath, triggers);
  res.status(201).json(newTrigger);
});

app.put('/api/agents/:id/triggers/:triggerId', (req, res) => {
  const { id, triggerId } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const idx = triggers.findIndex(t => t.id === triggerId);
  if (idx === -1) return res.status(404).json({ error: 'Trigger not found' });
  triggers[idx] = { ...triggers[idx], ...req.body, id: triggerId };
  writeJsonAtomic(triggersPath, triggers);
  res.json(triggers[idx]);
});

app.delete('/api/agents/:id/triggers/:triggerId', (req, res) => {
  const { id, triggerId } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  const triggersPath = path.join(agentDir, 'triggers.json');
  const triggers = readJsonFile(triggersPath, []);
  const filtered = triggers.filter(t => t.id !== triggerId);
  writeJsonAtomic(triggersPath, filtered);
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

  let skillPath;
  if (source === 'agent' && agentId) {
    skillPath = path.join(AGENTS_DIR, agentId, 'skills', name, 'SKILL.md');
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

/* ─── Models ────────────────────────────────────────────────────────── */

const MODELS_FILE = path.join(WORKSPACE, 'models.json');

app.get('/api/models', (req, res) => {
  const models = readJsonFile(MODELS_FILE, null);
  if (models) return res.json(models);
  // Seed from env
  res.json([{
    id: 'default',
    name: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
    baseUrl: process.env.ANTHROPIC_BASE_URL || '',
  }]);
});

app.post('/api/models', (req, res) => {
  const models = readJsonFile(MODELS_FILE, []);
  const newModel = { id: `m${Date.now()}`, ...req.body };
  models.push(newModel);
  writeJsonAtomic(MODELS_FILE, models);
  res.status(201).json(newModel);
});

app.put('/api/models/:id', (req, res) => {
  const models = readJsonFile(MODELS_FILE, []);
  const idx = models.findIndex(m => m.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Model not found' });
  models[idx] = { ...models[idx], ...req.body, id: req.params.id };
  writeJsonAtomic(MODELS_FILE, models);
  res.json(models[idx]);
});

app.delete('/api/models/:id', (req, res) => {
  const models = readJsonFile(MODELS_FILE, []);
  const filtered = models.filter(m => m.id !== req.params.id);
  writeJsonAtomic(MODELS_FILE, filtered);
  res.status(204).end();
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

app.post('/api/environments', (req, res) => {
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId } = req.body || {};
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

  const env = {
    id,
    name,
    description: description || '',
    skills: Array.isArray(skills) ? skills : [],
    repositories: normalizedRepos,
    githubTokenId: githubTokenId || null,
    additionalContext: additionalContext || '',
    createdAt: new Date().toISOString(),
  };
  saveEnvironment(id, env);
  res.status(201).json(env);
});

app.put('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const { name, description, skills, repositories, repository, additionalContext, githubTokenId } = req.body || {};

  if (githubTokenId) {
    const tokens = listGithubTokens();
    if (!tokens.some(t => t.id === githubTokenId)) {
      return res.status(400).json({ error: `GitHub token '${githubTokenId}' not found` });
    }
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
 *   GET  /api/matrix/agents                          List enabled agents with Matrix identities
 *   POST /api/matrix/agents/:agentId/dm              Idempotent create/get DM room
 *   GET  /api/matrix/rooms/:roomId/messages          Paginated history (proxy)
 *   POST /api/matrix/rooms/:roomId/messages          Send m.text as admin
 *   GET  /api/matrix/rooms/:roomId/stream            SSE long-poll on /sync filtered to room
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

// 2. Idempotent create-or-get DM room with an agent
app.post('/api/matrix/agents/:agentId/dm', async (req, res) => {
  const { agentId } = req.params;
  const cfgPath = path.join(AGENTS_DIR, agentId, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  if (cfg.enabled === false) return res.status(409).json({ error: 'Agent disabled' });
  if (!cfg.token) return res.status(409).json({ error: 'Agent has no Matrix token' });
  if (!matrix.ADMIN_TOKEN) return res.status(500).json({ error: 'MATRIX_ACCESS_TOKEN not configured' });

  // Reuse existing DM room if admin is still joined
  const existing = matrix.getAgentDmRoom(agentId);
  if (existing?.roomId) {
    try {
      const joined = await matrix.matrixFetch(matrix.ADMIN_TOKEN, '/_matrix/client/v3/joined_rooms');
      if (joined.status === 200 && Array.isArray(joined.data?.joined_rooms) &&
          joined.data.joined_rooms.includes(existing.roomId)) {
        return res.json({ roomId: existing.roomId, reused: true });
      }
    } catch (err) {
      return res.status(502).json({ error: `Matrix unreachable: ${err.message}` });
    }
    // Fall through and recreate if admin is no longer in the room
  }

  // Create the room as the agent, inviting the admin
  try {
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
      return res.status(502).json({ error: 'createRoom failed', upstream: createResp.data });
    }
    const roomId = createResp.data?.room_id;
    if (!roomId) {
      return res.status(502).json({ error: 'createRoom returned no room_id', upstream: createResp.data });
    }

    // Admin (human) accepts the invite. We use a token, not a syncing client,
    // so auto-join doesn't happen — we explicitly POST /join.
    const joinResp = await matrix.matrixFetch(matrix.ADMIN_TOKEN,
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { method: 'POST', body: {} });
    if (joinResp.status >= 400) {
      console.error('[Matrix] admin join failed:', joinResp.status, joinResp.data);
      return res.status(502).json({ error: 'admin join failed', upstream: joinResp.data });
    }

    matrix.setAgentDmRoom(agentId, {
      roomId,
      createdAt: new Date().toISOString(),
      createdBy: adminUserId,
    });
    res.status(201).json({ roomId, reused: false });
  } catch (err) {
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

// 5. SSE stream — long-poll /sync filtered to this room
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

const AGENT_ID_RE = /^[a-zA-Z0-9_.-]+$/;
const ROOM_ID_RE = /^![a-zA-Z0-9_-]+:[a-zA-Z0-9.-]+$/;

function sessionFile(agentId, roomId) {
  return path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.jsonl');
}

function sessionPointerFile(agentId, roomId) {
  return path.join(AGENTS_DIR, agentId, 'sessions', roomId + '.current.json');
}

function validSessionIds(req, res) {
  const { agentId, roomId } = req.params;
  if (!AGENT_ID_RE.test(agentId) || !ROOM_ID_RE.test(roomId)) {
    res.status(400).json({ error: 'invalid id' });
    return null;
  }
  return { agentId, roomId };
}

/* ─── Session pointer (Claude --resume id) ─────────────────────────── */

// Returns the active Claude session id for a given (agent, room), if any.
// The runner writes this file after every successful Claude invocation;
// an empty / missing file means the next message starts a fresh session.
app.get('/api/agents/:agentId/session/:roomId/current', (req, res) => {
  const ids = validSessionIds(req, res);
  if (!ids) return;
  const ptr = sessionPointerFile(ids.agentId, ids.roomId);
  if (!fs.existsSync(ptr)) return res.json({ sessionId: null, updatedAt: null });
  try {
    const j = JSON.parse(fs.readFileSync(ptr, 'utf8'));
    res.json({
      sessionId: typeof j?.sessionId === 'string' ? j.sessionId : null,
      updatedAt: typeof j?.updatedAt === 'string' ? j.updatedAt : null,
    });
  } catch {
    // Corrupt pointer → treat as no session
    res.json({ sessionId: null, updatedAt: null });
  }
});

// Drop the session pointer so the next message starts a fresh Claude
// session (memory files are still re-read; only the in-conversation
// context is discarded).
app.delete('/api/agents/:agentId/session/:roomId/current', (req, res) => {
  const ids = validSessionIds(req, res);
  if (!ids) return;
  try {
    fs.rmSync(sessionPointerFile(ids.agentId, ids.roomId), { force: true });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
  res.json({ ok: true });
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

// Directory-only listing — delegated to BP-Explorer for orchestrator directory picker.
app.get('/api/agents/:agentId/workspace/dirs', async (req, res) => {
  const { agentId } = req.params;
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

function parseJsonlLine(line) {
  try {
    return JSON.parse(line);
  } catch {
    return { type: 'parse_error', raw: line.slice(0, 200) };
  }
}

// Static backfill: read JSONL from `since` (default 0) up to current EOF.
app.get('/api/agents/:agentId/session/:roomId', (req, res) => {
  const ids = validSessionIds(req, res);
  if (!ids) return;
  const filepath = sessionFile(ids.agentId, ids.roomId);

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
  const ids = validSessionIds(req, res);
  if (!ids) return;
  const filepath = sessionFile(ids.agentId, ids.roomId);
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
