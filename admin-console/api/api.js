'use strict';

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const http = require('http');

const WORKSPACE = '/workspace';
const BRIDGE_WORKSPACE = '/bridge-workspace';
const AGENTS_DIR = path.join(WORKSPACE, 'agents');
const BRIDGE_JOBS_FILE = path.join(BRIDGE_WORKSPACE, 'jobs.json');
const STATIC_DIR = path.join(__dirname, '..', 'dist');
const PODMAN_SOCK = process.env.PODMAN_SOCK_PATH || '/var/run/podman.sock';

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

  for (const id of agentDirs) {
    const cfg = readJsonFile(path.join(AGENTS_DIR, id, 'config.json'), {});
    if (cfg.enabled === false) disabled++;
    else active++;
    // count agent skills
    const skillsDir = path.join(AGENTS_DIR, id, 'skills');
    try {
      const skills = fs.readdirSync(skillsDir).filter(n => {
        return fs.existsSync(path.join(skillsDir, n, 'SKILL.md'));
      });
      agentSkills += skills.length;
    } catch { /* no skills dir */ }
  }

  const bridgeJobs = readJsonFile(BRIDGE_JOBS_FILE, []);

  // bridge skills
  let bridgeSkills = 0;
  const bridgeSkillsDir = path.join(BRIDGE_WORKSPACE, 'skills');
  try {
    bridgeSkills = fs.readdirSync(bridgeSkillsDir).filter(n =>
      fs.existsSync(path.join(bridgeSkillsDir, n, 'SKILL.md'))
    ).length;
  } catch { /* no dir */ }

  res.json({
    agents: { total: agentDirs.length, active, disabled },
    jobs: { total: Array.isArray(bridgeJobs) ? bridgeJobs.length : 0 },
    skills: { total: bridgeSkills + agentSkills },
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

app.delete('/api/agents/:id', (req, res) => {
  const { id } = req.params;
  const agentDir = path.join(AGENTS_DIR, id);
  if (!fs.existsSync(agentDir)) return res.status(404).json({ error: 'Agent not found' });
  fs.rmSync(agentDir, { recursive: true, force: true });
  res.status(204).end();
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

/* ─── Bridge Jobs ───────────────────────────────────────────────────── */

app.get('/api/jobs', (req, res) => {
  res.json(readJsonFile(BRIDGE_JOBS_FILE, []));
});

app.post('/api/jobs', (req, res) => {
  const jobs = readJsonFile(BRIDGE_JOBS_FILE, []);
  const newJob = { id: `j${Date.now()}`, ...req.body };
  jobs.push(newJob);
  writeJsonAtomic(BRIDGE_JOBS_FILE, jobs);
  res.status(201).json(newJob);
});

app.put('/api/jobs/:id', (req, res) => {
  const jobs = readJsonFile(BRIDGE_JOBS_FILE, []);
  const idx = jobs.findIndex(j => j.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Job not found' });
  jobs[idx] = { ...jobs[idx], ...req.body, id: req.params.id };
  writeJsonAtomic(BRIDGE_JOBS_FILE, jobs);
  res.json(jobs[idx]);
});

app.delete('/api/jobs/:id', (req, res) => {
  const jobs = readJsonFile(BRIDGE_JOBS_FILE, []);
  const filtered = jobs.filter(j => j.id !== req.params.id);
  writeJsonAtomic(BRIDGE_JOBS_FILE, filtered);
  res.status(204).end();
});

/* ─── Skills ────────────────────────────────────────────────────────── */

app.get('/api/skills', (req, res) => {
  const skills = [];
  const seen = new Set();

  // Bridge skills
  const bridgeSkillsDir = path.join(BRIDGE_WORKSPACE, 'skills');
  try {
    fs.readdirSync(bridgeSkillsDir).forEach(name => {
      const skillMd = path.join(bridgeSkillsDir, name, 'SKILL.md');
      if (fs.existsSync(skillMd) && !seen.has(name)) {
        seen.add(name);
        skills.push({ name, source: 'bridge', path: skillMd });
      }
    });
  } catch { /* no bridge skills dir */ }

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
    skillPath = path.join(BRIDGE_WORKSPACE, 'skills', name, 'SKILL.md');
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

const MCP_SETTINGS_FILE = path.join(BRIDGE_WORKSPACE, '.claude', 'settings.json');

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
  try {
    const result = await podmanRequest('GET', '/containers/json?all=true');
    const containers = Array.isArray(result.body) ? result.body : [];
    const agentContainers = containers
      .filter(c => {
        const name = Array.isArray(c.Names) ? c.Names[0] : (c.Name || '');
        return name.replace(/^\//, '').startsWith('agent-');
      })
      .map(c => {
        const name = (Array.isArray(c.Names) ? c.Names[0] : (c.Name || '')).replace(/^\//, '');
        return { name, state: c.State || c.Status || 'unknown', id: c.Id || c.ID || '' };
      });
    res.json(agentContainers);
  } catch (err) {
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

/* ─── SPA fallback ──────────────────────────────────────────────────── */

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) return res.status(404).json({ error: 'Not found' });
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.listen(4000, '0.0.0.0', () => console.log('[Admin] Listening on :4000'));
