'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const WORKSPACE = '/workspace';
const POOL_DIR = '/pool';
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const ENVIRONMENTS_DIR = path.join(WORKSPACE, 'environments');
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, '_keys');
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, 'index.json');
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';

fs.mkdirSync(ENVIRONMENTS_DIR, { recursive: true });
fs.mkdirSync(SSH_KEYS_DIR, { recursive: true });

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
  return readJsonFile(p, null);
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
    if (env?.repository?.sshKeyId === keyId) return envId;
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

app.get('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  const cfg = readJsonFile(path.join(agentDir, 'config.json'), null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const triggers = readJsonFile(path.join(agentDir, 'triggers.json'), []);
  res.json({ id, ...cfg, triggers });
});

app.put('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  const cfgPath = path.join(AGENTS_DIR, id, 'config.json');
  const cfg = readJsonFile(cfgPath, null);
  if (!cfg) return res.status(404).json({ error: 'Agent not found' });
  const { displayName, role, enabled } = req.body;
  if (displayName !== undefined) cfg.displayName = displayName;
  if (role !== undefined) cfg.role = role;
  if (enabled !== undefined) cfg.enabled = enabled;
  writeJsonAtomic(cfgPath, cfg);
  res.json({ id, ...cfg });
});

app.post('/api/agents', async (req, res) => {
  const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt } = req.body;
  if (!id || !displayName || !role || !systemPrompt || !environmentId) {
    return res.status(400).json({ error: 'id, displayName, role, systemPrompt, environmentId required' });
  }
  if (!loadEnvironment(environmentId)) {
    return res.status(400).json({ error: `Working Environment '${environmentId}' not found` });
  }
  const orchestratorUrl = process.env.ORCHESTRATOR_URL || 'http://orchestrator:4002';
  try {
    const resp = await fetch(`${orchestratorUrl}/internal/agents`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt }),
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

/* ─── Models ────────────────────────────────────────────────────────── */

const MODELS_FILE = path.join(WORKSPACE, 'models.json');

app.get('/api/models', (req, res) => {
  const models = readJsonFile(MODELS_FILE, null);
  if (models) return res.json(models);
  // Seed from env
  res.json([{
    id: 'default',
    name: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL || 'claude-sonnet-4-6',
    resource: process.env.ANTHROPIC_FOUNDRY_RESOURCE || '',
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
  const { name, description, skills, repository, additionalContext } = req.body || {};
  const id = normalizeEnvId(req.body?.id);
  if (!id) return res.status(400).json({ error: 'id is required (a-z, 0-9, -)' });
  if (!name) return res.status(400).json({ error: 'name is required' });
  if (loadEnvironment(id)) return res.status(409).json({ error: `Environment '${id}' already exists` });

  // Validate repository.sshKeyId if set
  if (repository?.sshKeyId) {
    const keys = listSshKeys();
    if (!keys.some(k => k.id === repository.sshKeyId)) {
      return res.status(400).json({ error: `SSH key '${repository.sshKeyId}' not found` });
    }
  }

  const env = {
    id,
    name,
    description: description || '',
    skills: Array.isArray(skills) ? skills : [],
    repository: repository?.url ? {
      url: repository.url,
      branch: repository.branch || null,
      sshKeyId: repository.sshKeyId || null,
    } : null,
    additionalContext: additionalContext || '',
    createdAt: new Date().toISOString(),
  };
  saveEnvironment(id, env);
  res.status(201).json(env);
});

app.put('/api/environments/:id', (req, res) => {
  const env = loadEnvironment(req.params.id);
  if (!env) return res.status(404).json({ error: 'Environment not found' });
  const { name, description, skills, repository, additionalContext } = req.body || {};

  if (repository?.sshKeyId) {
    const keys = listSshKeys();
    if (!keys.some(k => k.id === repository.sshKeyId)) {
      return res.status(400).json({ error: `SSH key '${repository.sshKeyId}' not found` });
    }
  }

  if (name !== undefined) env.name = name;
  if (description !== undefined) env.description = description;
  if (skills !== undefined) env.skills = Array.isArray(skills) ? skills : [];
  if (repository !== undefined) {
    env.repository = repository?.url ? {
      url: repository.url,
      branch: repository.branch || null,
      sshKeyId: repository.sshKeyId || null,
    } : null;
  }
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

/* ─── SPA fallback ──────────────────────────────────────────────────── */

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(4000, '0.0.0.0', () => console.log('[Admin] Listening on :4000'));
