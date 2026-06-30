'use strict';

const {
  MatrixClient,
  SimpleFsStorageProvider,
} = require("matrix-bot-sdk");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bpEventRouter = require("./bp-event-router");
const { findEnclosingGitRepo } = require("./git-workspace");
const { bpsToBriefingsMap } = require("./briefings-graph");
const { createTeamsStore, DEFAULT_TEAM_ID } = require("./teams-store");
const { makeSkillSourceResolver } = require("./skill-source");

// ============================================================
// Config
// ============================================================
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;
const BP_EXPLORER_URL = process.env.BP_EXPLORER_URL || "http://bp-explorer:8765";

const AGENTS_DIR = "/workspace/agents";
// Control-plane state pushed by agents (#185). Lives on a dedicated volume
// mounted only by the orchestrator + admin-console, so monitoring (status,
// session-log) no longer depends on reading an agent's own workspace — the
// prerequisite for giving each agent its own isolated volume.
const CONTROL_DIR = "/control/agents";
// Phase 2 (#185): when per-agent volume isolation is on the orchestrator can no
// longer write control→agent state (triggers, pending-triggers, the pushed
// session-pointer mirror) into the agent's own volume, so the canonical copy
// lives on the control plane and the agent pulls it over HTTP. With the flag off
// (the default) these stay on the shared pool subpath the agent reads directly,
// so the resolver below is a no-op and behavior is byte-identical to today.
const PER_AGENT_VOLUME = process.env.AEE_PER_AGENT_VOLUME === '1';
const BLUEPRINTS_DIR = "/workspace/blueprints";
const WORKSPACE = "/workspace";
const TEMPLATE_WORKSPACE = "/template-workspace";
// Agent id grammar — mirrors AGENT_ID_RE in admin-console/api/api.js. Used to
// validate ids that arrive from outside (e.g. on import).
const AGENT_ID_RE = /^[a-zA-Z0-9_-]+(\.[a-zA-Z0-9_-]+)*$/;
const ENVIRONMENTS_DIR = "/workspace/environments";
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, "_keys");
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, "index.json");
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, "_tokens");
const LLM_ENDPOINTS_INDEX = "/workspace/llm-endpoints/index.json";
const LLM_KEYS_DIR = "/workspace/llm-endpoints/_keys";
const MCP_SERVERS_DIR = "/workspace/mcp-servers";
const MCP_CREDENTIALS_KEYS_DIR = "/workspace/mcp-credentials/_keys";

// Teams data model (#299): the human collaboration & visibility scope. Stored
// under /workspace alongside the other persistent collections; the orchestrator
// is the single writer for tenancy/identity data and owns the startup
// bootstrap + ownership backfill below.
const teamsStore = createTeamsStore({ root: WORKSPACE });
// Two-tier skill resolution (#306): owning team's pool wins over the global pool.
const { resolveSkillSourceDir } = makeSkillSourceResolver({
  workspace: WORKSPACE,
  templateWorkspace: TEMPLATE_WORKSPACE,
  defaultTeamId: DEFAULT_TEAM_ID,
});

// Resolve the LLM binding for an environment:
//  - reads /workspace/llm-endpoints/index.json
//  - looks up env.llmEndpointId
//  - reads the auth token from _keys/<authTokenId>
// Returns { baseUrl, token, defaultModelId } or null if the env has no
// binding or the endpoint is missing — in that case the caller falls back to
// the global ANTHROPIC_* env vars from `.env`.
//
// Model resolution order: env.defaultModelId (explicit pin) → endpoint
// registry default → null (lets the Claude CLI pick from .env). The endpoint
// fallback exists so legacy envs that never picked a model still inherit the
// operator-configured default once one is set in the Model Registry.
function loadLlmBindingForEnv(env) {
  if (!env?.llmEndpointId) return null;
  let list;
  try {
    list = JSON.parse(fs.readFileSync(LLM_ENDPOINTS_INDEX, "utf8"));
  } catch {
    return null;
  }
  const ep = Array.isArray(list) ? list.find(e => e.id === env.llmEndpointId) : null;
  if (!ep) {
    console.error(`[Orchestrator] LLM endpoint '${env.llmEndpointId}' (env=${env.id}) not found — falling back to .env`);
    return null;
  }
  let token = "";
  if (ep.authTokenId) {
    try {
      token = fs.readFileSync(path.join(LLM_KEYS_DIR, ep.authTokenId), "utf8").trim();
    } catch (err) {
      console.error(`[Orchestrator] Cannot read LLM token for endpoint ${ep.id}: ${err.message}`);
    }
  }
  return {
    baseUrl: ep.baseUrl || "",
    token,
    defaultModelId: env.defaultModelId || ep.defaultModelId || null,
  };
}

const { execFile, execFileSync } = require("child_process");
const { spawnContainer, libpodRequest, removePerAgentVolume, removePerAgentNetwork, reseedPerAgentVolume } = require("./spawn-container");
const { reconcileSessionAppend } = require("./session-cursor");
const crypto = require("crypto");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
const agentProcesses = new Map(); // id → ChildProcess

// ============================================================
// Process lifecycle (each agent runs as its own Podman container)
// ============================================================
// Containers start EAGERLY, not on first message: startAgentProcess is invoked
// when an agent is created (createAgent), enabled/activated (enableAgent, claim),
// and for every enabled agent at boot (startAllEnabledAgents). There is no
// spawn-on-first-DM path — the container is up and synced before any message
// arrives, so the first reply is timely. (DM-room readiness is handled on the
// admin-console side, which pre-creates the 1:1 room at create/enable time.)
function startAgentProcess(config) {
  const { id, token, userId, environmentId } = config;
  stopAgentProcess(id); // kill existing if any

  const childEnv = {
    ...process.env,
    AGENT_ID: id,
    MATRIX_ACCESS_TOKEN: token,
    MATRIX_BOT_USER_ID: userId,
    MATRIX_HOMESERVER: process.env.MATRIX_HOMESERVER,
    ORCHESTRATOR_INTERNAL_URL: process.env.ORCHESTRATOR_INTERNAL_URL || 'http://orchestrator:4002',
    AEE_ORCHESTRATOR_URL: process.env.AEE_ORCHESTRATOR_URL || 'http://orchestrator:4002',
  };

  // Bind the agent's process to the LLM endpoint configured on its working
  // environment. When an environment doesn't reference an endpoint we leave
  // the inherited ANTHROPIC_* values from `.env` in place — that keeps
  // pre-registry environments and the bp-explorer integration working.
  const env = environmentId ? loadEnvironment(environmentId) : null;
  const llm = loadLlmBindingForEnv(env);
  if (llm) {
    if (llm.baseUrl) childEnv.ANTHROPIC_BASE_URL = llm.baseUrl;
    if (llm.token)   childEnv.ANTHROPIC_AUTH_TOKEN = llm.token;
    if (llm.defaultModelId) childEnv.AGENT_DEFAULT_MODEL = llm.defaultModelId;
    console.log(`[Orchestrator] Agent ${id} → LLM endpoint=${env.llmEndpointId}, model=${llm.defaultModelId || '(endpoint default)'}`);
  } else if (env?.llmEndpointId) {
    console.log(`[Orchestrator] Agent ${id} → LLM endpoint binding missing for env=${env.id}, using .env fallback`);
  }

  // Per-agent override (set via the chat UI) wins over the environment's
  // default model. Fresh-read on each spawn so an admin can edit config.json
  // and restart to apply.
  if (config.modelOverride) childEnv.AGENT_DEFAULT_MODEL = config.modelOverride;

  // If the agent's environment has a GitHub token attached, expose it as
  // GH_TOKEN so the `gh` CLI authenticates without `gh auth login`.
  // (Also exported as GITHUB_TOKEN for git-over-HTTPS pushes.)
  if (env?.githubTokenId) {
    const tokenPath = path.join(GH_TOKENS_DIR, env.githubTokenId);
    try {
      const ghToken = fs.readFileSync(tokenPath, "utf8").trim();
      if (ghToken) {
        childEnv.GH_TOKEN = ghToken;
        childEnv.GITHUB_TOKEN = ghToken;
        console.log(`[Orchestrator] Agent ${id} → GH_TOKEN injected (env=${env.id}, token=${env.githubTokenId})`);
      }
    } catch (err) {
      console.error(`[Orchestrator] Cannot read GitHub token ${env.githubTokenId} for agent ${id}: ${err.message}`);
    }
  }

  // Per-agent SSH identity (see materializeAgentSshKey). Always runs — even for
  // envless agents — because it also strips the orchestrator's inherited
  // GIT_SSH_COMMAND, which would otherwise dangle in every agent.
  materializeAgentSshKey(id, env, childEnv);

  // Seam #3 fail-closed guard. With per-agent filesystem isolation the
  // container mounts only `agents/<id>` (SubPath) of the pool volume. If the
  // workspace wasn't seeded the SubPath target is missing — refuse to spawn
  // rather than let anything fall back to mounting the whole pool, which would
  // re-expose every agent + the secret stores. Also pre-create the persistent
  // per-agent Claude home SubPath target (`/root/.claude/homes/<id>`), which
  // the orchestrator can write because it mounts claude-home at /root/.claude.
  if (process.env.AEE_WORKSPACE_ISOLATION !== '0') {
    const workdir = path.join('/workspace/agents', id);
    if (!fs.existsSync(workdir)) {
      console.error(
        `[Orchestrator] Refusing to start agent ${id}: workspace ${workdir} ` +
        `not seeded (AEE_WORKSPACE_ISOLATION on)`,
      );
      return;
    }
    try {
      fs.mkdirSync(path.join('/root/.claude/homes', id), { recursive: true });
    } catch (err) {
      console.warn(`[Orchestrator] could not pre-create Claude home for ${id}: ${err.message}`);
    }
  }

  const child = spawnContainer({ id, env: childEnv });

  child.stdout.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach(line =>
      console.log(`[Agent:${id}] ${line}`)
    )
  );
  child.stderr.on('data', (d) =>
    d.toString().split('\n').filter(Boolean).forEach(line =>
      console.error(`[Agent:${id}] ${line}`)
    )
  );
  child.on('exit', (code) => {
    console.log(`[Orchestrator] Agent ${id} exited (code ${code})`);
    agentProcesses.delete(id);
  });

  agentProcesses.set(id, child);
  child.on('spawned', (pid) => {
    console.log(`[Orchestrator] Started container for agent ${id} (id ${pid})`);
  });
}

function stopAgentProcess(id) {
  const proc = agentProcesses.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  agentProcesses.delete(id);
  console.log(`[Orchestrator] Stopped process for agent ${id}`);
}

function stopAgentSession(id, sessionId) {
  const proc = agentProcesses.get(id);
  if (!proc) return false;
  // Stop-session is delivered via SIGUSR1; the container's Python listener
  // catches it and terminates the active claude subprocess (the container
  // itself keeps running and stays available for further DMs).
  try {
    proc.kill('SIGUSR1');
    console.log(
      `[Orchestrator] Sent SIGUSR1 stop-session to agent ${id}` +
      (sessionId ? ` (session ${sessionId})` : '')
    );
    return true;
  } catch (err) {
    console.error(`[Orchestrator] stopAgentSession ${id}: ${err.message}`);
    return false;
  }
}

async function evictStaleAgentContainers() {
  if (process.env.EVICT_STALE_AGENTS === '0') return;
  const image = process.env.AGENT_IMAGE || 'as-agent:latest';
  try {
    const filters = encodeURIComponent(JSON.stringify({ ancestor: [image] }));
    const list = await libpodRequest('GET', `/containers/json?all=true&filters=${filters}`);
    if (list.status >= 300 || !Array.isArray(list.body)) {
      console.warn(`[Orchestrator] evict: list returned status=${list.status}`);
      return;
    }
    let evicted = 0;
    for (const c of list.body) {
      const cid = c.Id || c.ID;
      if (!cid) continue;
      const del = await libpodRequest('DELETE', `/containers/${cid}?force=true&v=true`);
      if (del.status < 300) evicted += 1;
      else console.warn(`[Orchestrator] evict: delete ${cid.slice(0, 12)} status=${del.status}`);
    }
    if (evicted > 0) {
      console.log(`[Orchestrator] evicted ${evicted} stale ${image} container(s)`);
    }
  } catch (err) {
    console.warn(`[Orchestrator] evict skipped: ${err.message}`);
  }
}

async function startAllEnabledAgents() {
  await evictStaleAgentContainers();
  for (const id of listAgentIds()) {
    const config = loadAgentConfig(id);
    // Skip pure-config orchestrators (created via POST /internal/agents/create
    // without a Matrix user). Blueprint-instance orchestrators DO carry a token
    // and need to be respawned on container restart just like agents.
    if (config && config.enabled !== false && config.token) {
      startAgentProcess(config);
    }
  }
}

// ============================================================
// Agent storage
// ============================================================
function agentDir(id) {
  return path.join(AGENTS_DIR, id);
}

// Control-plane location for an agent's pushed state (#185).
function controlAgentDir(id) {
  return path.join(CONTROL_DIR, id);
}

// Resolve a per-agent state file, preferring the pushed control-plane copy and
// falling back to the agent's own workspace when it hasn't pushed yet (or push
// is disabled). This keeps the read-repoint non-breaking on the shared volume
// and lets it transparently work once agents move to isolated volumes (#185).
function agentStatePath(id, ...segs) {
  const ctrl = path.join(controlAgentDir(id), ...segs);
  if (fs.existsSync(ctrl)) return ctrl;
  return path.join(agentDir(id), ...segs);
}

// Canonical location for control→agent state (triggers.json,
// pending-triggers.json, the session-pointer mirror). With per-agent volume
// isolation the agent's own volume is unreachable from here, so the canonical
// copy lives on the control plane (the agent pulls it). Otherwise it stays on
// the shared pool subpath the agent reads directly. The orchestrator both reads
// and writes through this resolver, so reads always match where it wrote.
function controlOrPoolPath(id, ...segs) {
  return PER_AGENT_VOLUME
    ? path.join(controlAgentDir(id), ...segs)
    : path.join(agentDir(id), ...segs);
}

// Path-segment guard for values that become filesystem paths (agent id, room
// id) in the push endpoints. Rejects separators / traversal / NUL.
function isSafePathSeg(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 256 &&
    !s.includes('/') && !s.includes('\\') && !s.includes('..') && !s.includes('\0');
}

// Legacy role names used to be `expert` / `expert-group` / `expert-instance`.
// The user-facing language is now `agent` / `team` / `team-member` and the
// `parentGroupId` field has been renamed to `parentTeamId`. We keep a
// translation layer here so any config that wasn't rewritten by
// `migrateLegacyAgentConfigs()` still loads with the new shape.
const LEGACY_ROLE_MAP = {
  "expert": "agent",
  "expert-group": "team",
  "expert-instance": "team-member",
};

function normalizeRole(role) {
  return LEGACY_ROLE_MAP[role] || role;
}

function normalizeAgentConfig(cfg) {
  if (!cfg) return cfg;
  const out = { ...cfg };
  if (LEGACY_ROLE_MAP[out.role]) out.role = LEGACY_ROLE_MAP[out.role];
  if (out.parentGroupId !== undefined && out.parentTeamId === undefined) {
    out.parentTeamId = out.parentGroupId;
    delete out.parentGroupId;
  }
  return out;
}

function loadAgentConfig(id) {
  const p = path.join(agentDir(id), "config.json");
  if (!fs.existsSync(p)) return null;
  return normalizeAgentConfig(JSON.parse(fs.readFileSync(p, "utf8")));
}

function saveAgentConfig(id, config) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
}

// One-time migration: rewrite any legacy `role` / `parentGroupId` fields on
// disk so the new naming is the single source of truth. Idempotent — safe to
// run on every orchestrator start.
function migrateLegacyAgentConfigs() {
  if (!fs.existsSync(AGENTS_DIR)) return;
  let migrated = 0;
  for (const id of listAgentIds()) {
    const p = path.join(agentDir(id), "config.json");
    let raw;
    try {
      raw = JSON.parse(fs.readFileSync(p, "utf8"));
    } catch (err) {
      console.error(`[Orchestrator] migrate: cannot parse ${p}: ${err.message}`);
      continue;
    }
    const before = JSON.stringify(raw);
    const after = normalizeAgentConfig(raw);
    if (JSON.stringify(after) !== before) {
      fs.writeFileSync(p, JSON.stringify(after, null, 2));
      migrated++;
    }
  }
  if (migrated > 0) {
    console.log(`[Orchestrator] Migrated ${migrated} legacy agent config(s) to agent/team/team-member naming`);
  }
}

// ============================================================
// Teams: bootstrap + ownership backfill (#299)
// ============================================================
//
// Every agent construct, Working Environment and credential is owned by exactly
// one Team via a `teamId` field. On startup we guarantee the default team
// exists, optionally seed a System Admin from environment config, and stamp any
// pre-existing resource that predates this model with the default team. The
// pass is idempotent — once stamped, a resource is skipped on subsequent boots.
function bootstrapTeams() {
  teamsStore.ensureDefaultTeam();
  const subject = process.env.BOOTSTRAP_SYSTEM_ADMIN_SUBJECT;
  if (subject) {
    try {
      teamsStore.ensureSystemAdmin({
        subject,
        email: process.env.BOOTSTRAP_SYSTEM_ADMIN_EMAIL,
        displayName: process.env.BOOTSTRAP_SYSTEM_ADMIN_NAME,
      });
      console.log(`[Orchestrator] Ensured System Admin for subject '${subject}'`);
    } catch (err) {
      console.error(`[Orchestrator] System Admin bootstrap failed: ${err.message}`);
    }
  }
}

// Stamp `teamId: "default"` onto any resource that lacks an owner. Rewrites the
// JSON in place only when it actually changes (so it's cheap on a warm stack).
function backfillResourceOwnership() {
  let stamped = 0;

  // Agents
  if (fs.existsSync(AGENTS_DIR)) {
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg && cfg.teamId === undefined) {
        cfg.teamId = DEFAULT_TEAM_ID;
        saveAgentConfig(id, cfg);
        stamped++;
      }
    }
  }

  // Working Environments
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const name of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const p = path.join(ENVIRONMENTS_DIR, name, "environment.json");
      if (!fs.existsSync(p)) continue;
      try {
        const env = JSON.parse(fs.readFileSync(p, "utf8"));
        if (env.teamId === undefined) {
          env.teamId = DEFAULT_TEAM_ID;
          fs.writeFileSync(p, JSON.stringify(env, null, 2));
          stamped++;
        }
      } catch { /* skip unparsable env */ }
    }
  }

  // Credentials: each index is an array of metadata entries.
  const CREDENTIAL_INDEXES = [
    SSH_KEYS_INDEX,
    path.join(GH_TOKENS_DIR, "index.json"),
    path.join(MCP_CREDENTIALS_KEYS_DIR, "index.json"),
    LLM_ENDPOINTS_INDEX,
  ];
  for (const idx of CREDENTIAL_INDEXES) {
    if (!fs.existsSync(idx)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(idx, "utf8"));
      if (!Array.isArray(list)) continue;
      let changed = false;
      for (const entry of list) {
        if (entry && typeof entry === "object" && entry.teamId === undefined) {
          entry.teamId = DEFAULT_TEAM_ID;
          changed = true;
        }
      }
      if (changed) {
        fs.writeFileSync(idx, JSON.stringify(list, null, 2));
        stamped += list.length;
      }
    } catch { /* skip unparsable index */ }
  }

  if (stamped > 0) {
    console.log(`[Orchestrator] Backfilled team ownership onto ${stamped} pre-existing resource(s)`);
  }
}

// Resolve the owning (human) Team for a newly created resource. An explicit id
// must reference an existing team; absence falls back to the default team.
function resolveOwnerTeamId(teamId) {
  if (teamId === undefined || teamId === null || teamId === '') return DEFAULT_TEAM_ID;
  if (!teamsStore.getTeam(teamId)) {
    throw new Error(`Owning team '${teamId}' not found`);
  }
  return teamId;
}

function saveAgentPrompt(id, prompt, role, env, blueprintId = null) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "AGENT-PROMPT.md"), prompt);
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), buildAgentClaudeMd(prompt, role, env, blueprintId));
}

// ============================================================
// Environment storage
// ============================================================
function loadEnvironment(envId) {
  if (!envId) return null;
  const p = path.join(ENVIRONMENTS_DIR, envId, "environment.json");
  if (!fs.existsSync(p)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeEnvironmentRepositories(raw);
  } catch (err) {
    console.error(`[Orchestrator] Cannot parse environment ${envId}: ${err.message}`);
    return null;
  }
}

// Migrate legacy `repository` (single) into `repositories: [...]` so the rest
// of the orchestrator can iterate over a uniform list.
function normalizeEnvironmentRepositories(env) {
  if (!env) return env;
  if (Array.isArray(env.repositories)) return env;
  if (env.repository && env.repository.url) {
    return { ...env, repositories: [env.repository] };
  }
  return { ...env, repositories: [] };
}

// ============================================================
// Blueprint storage
// ============================================================
function blueprintDir(id) {
  return path.join(BLUEPRINTS_DIR, id);
}

function loadBlueprint(id) {
  const p = path.join(blueprintDir(id), "blueprint.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function saveBlueprint(id, data) {
  const dir = blueprintDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "blueprint.json"), JSON.stringify(data, null, 2));
}

function listBlueprintIds() {
  if (!fs.existsSync(BLUEPRINTS_DIR)) return [];
  return fs.readdirSync(BLUEPRINTS_DIR).filter(f =>
    fs.existsSync(path.join(BLUEPRINTS_DIR, f, "blueprint.json"))
  );
}

function listInstanceIds(blueprintId) {
  return listAgentIds().filter(id => {
    const cfg = loadAgentConfig(id);
    return cfg && cfg.blueprintId === blueprintId;
  });
}

// ============================================================
// Blueprint shared memory
// ============================================================
function blueprintMemoryDir(blueprintId) {
  return path.join(BLUEPRINTS_DIR, blueprintId, "memory");
}

function ensureBlueprintMemoryDir(blueprintId) {
  const dir = blueprintMemoryDir(blueprintId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readBlueprintMemory(blueprintId, filename) {
  const safeFilename = path.basename(filename);
  const p = path.join(blueprintMemoryDir(blueprintId), safeFilename);
  try {
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8");
  } catch {}
  return "";
}

function writeBlueprintMemory(blueprintId, filename, content) {
  const dir = ensureBlueprintMemoryDir(blueprintId);
  const safeFilename = path.basename(filename);
  const p = path.join(dir, safeFilename);
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, content, "utf8");
  fs.renameSync(tmp, p);
}

// Seed blueprint memory from template if files don't exist yet
function seedBlueprintMemory(blueprintId) {
  const dir = ensureBlueprintMemoryDir(blueprintId);
  const templateMemory = path.join(TEMPLATE_WORKSPACE, "memory");
  if (!fs.existsSync(templateMemory)) return;
  for (const file of fs.readdirSync(templateMemory)) {
    const dst = path.join(dir, file);
    if (!fs.existsSync(dst)) {
      try {
        let content = fs.readFileSync(path.join(templateMemory, file), "utf8");
        content = content.replace(/\/workspace\//g, "./");
        fs.writeFileSync(dst, content, "utf8");
      } catch {}
    }
  }
}

function buildAgentClaudeMd(agentPrompt, role, env, blueprintId = null) {
  const candidates = [
    path.join(TEMPLATE_WORKSPACE, "CLAUDE.md"),
    "/defaults/CLAUDE.md",
  ];
  let base = "";
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) {
        base = fs.readFileSync(candidate, "utf8");
        if (base) break;
      }
    } catch (err) {
      console.log(`[Orchestrator] Could not read ${candidate}: ${err.message}`);
    }
  }
  if (!base) return agentPrompt;

  const pathNote =
    "## Workspace\n\n" +
    "Your workspace root is the current working directory. All files (repos, skills, memory) are here.\n" +
    "Memory entries may contain absolute paths like `/workspace/...` from a shared template — " +
    "translate these to relative paths (e.g. `/workspace/314092_foo/` → `./314092_foo/`).\n";

  const extra =
    "\n---\n\n## Trigger management (triggers.json)\n\n" +
    "Your runs can be driven by triggers defined in `triggers.json` at your workspace root. " +
    "You can read and edit this file yourself to adjust your own schedule.\n\n" +
    "### Trigger types\n\n" +
    "**Recurring (cron):**\n" +
    "```json\n" +
    "{\n" +
    '  "id": "unique-id",\n' +
    '  "type": "cron",\n' +
    '  "enabled": true,\n' +
    '  "cron": "*/30 * * * *",\n' +
    '  "description": "Description",\n' +
    '  "prompt": "What you should do on each run"\n' +
    "}\n" +
    "```\n" +
    "Cron format: `Minute Hour Day Month Weekday`\n\n" +
    "**One-shot (once):**\n" +
    "```json\n" +
    "{\n" +
    '  "id": "unique-id",\n' +
    '  "type": "once",\n' +
    '  "enabled": true,\n' +
    '  "at": "2026-04-25T09:00:00",\n' +
    '  "description": "Description",\n' +
    '  "prompt": "What you should do"\n' +
    "}\n" +
    "```\n\n" +
    "### Managing triggers\n\n" +
    "1. Read `triggers.json`\n" +
    "2. Add, modify or remove triggers\n" +
    "3. Write the file back\n" +
    "4. Changes are picked up automatically within 60 seconds\n\n" +
    "### Optional fields\n\n" +
    "- `roomId` — target room for the output (default: direct-message room with the admin)\n" +
    "- `timeoutSeconds` — max execution time (default: 3600)\n\n" +
    "If a scheduled run has nothing to report, reply with `[PASS]`.\n";

  let envSection = "";
  if (env) {
    const parts = [];
    if (env.name) parts.push(`**Working Environment:** ${env.name}`);
    if (env.description) parts.push(env.description);
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    if (repos.length === 1) {
      const repoName = (repos[0].url.split("/").pop() || "repo").replace(/\.git$/, "");
      parts.push(`**Repository:** \`${repos[0].url}\` — cloned to \`./${repoName}/\``);
    } else if (repos.length > 1) {
      const lines = repos.map(r => {
        const repoName = (r.url.split("/").pop() || "repo").replace(/\.git$/, "");
        return `- \`${r.url}\` — cloned to \`./${repoName}/\``;
      });
      parts.push(`**Repositories:**\n${lines.join("\n")}`);
    }
    if (Array.isArray(env.skills) && env.skills.length > 0) {
      parts.push(`**Skills:** ${env.skills.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (env.additionalContext) parts.push(env.additionalContext);
    if (parts.length > 0) {
      envSection = `\n---\n\n## Working Environment\n\n${parts.join("\n\n")}\n`;
    }
  }

  let blueprintSection = "";
  if (blueprintId) {
    const bpBase = `http://localhost:4002/internal/blueprints/${blueprintId}/memory`;
    const memFiles = ["context.md", "log.md", "facts.md", "entities.md", "users.md"];
    const pullCmds = memFiles.map(f => `curl -sf ${bpBase}/${f} > memory/${f} || true`).join("\n");
    const pushCmds = memFiles.map(f => `curl -s -X PUT -H 'Content-Type: text/plain' --data-binary @memory/${f} ${bpBase}/${f}`).join("\n");
    blueprintSection =
      `\n---\n\n## Memory System (Shared — Blueprint Instance)\n\n` +
      `This agent is an **instance of blueprint \`${blueprintId}\`**. ` +
      `Memory is **shared** across all instances of this blueprint — whatever one instance learns, all instances know.\n\n` +
      `### Reading memory (do this at the start of each conversation)\n\n` +
      "```bash\n" +
      `${pullCmds}\n` +
      "```\n\n" +
      `Then read all five files.\n\n` +
      `### Writing memory (when wrapping up or asked to remember something)\n\n` +
      `Edit the local files as usual, then push all to the shared store:\n\n` +
      "```bash\n" +
      `${pushCmds}\n` +
      "```\n\n" +
      `**Always pull before reading** — another instance may have updated memory since your last session.\n`;
  }

  return `${base}\n\n---\n\n${pathNote}${envSection}\n---\n\n## Agent Role\n\n${agentPrompt}${extra}${blueprintSection}`;
}

function seedAgentWorkspace(id, env, opts = {}) {
  const dest = agentDir(id);
  fs.mkdirSync(dest, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WORKSPACE)) {
    console.log(`[Orchestrator] Template workspace not available — skipping seed for ${id}`);
    return { seeded: false, warnings: ["Template workspace not mounted"] };
  }

  const warnings = [];

  // 1. Always copy baseline directories (.claude settings, memory)
  for (const item of [".claude", "memory"]) {
    const src = path.join(TEMPLATE_WORKSPACE, item);
    const dst = path.join(dest, item);
    if (!fs.existsSync(src)) continue;
    try {
      fs.cpSync(src, dst, { recursive: true });
    } catch (err) {
      warnings.push(`copy ${item}: ${err.message}`);
    }
  }

  // 2. Copy selected skills, resolving each name team-first then global (#306).
  // Team-members may override the team-env's skill list — pass `opts.skillsOverride`
  // (an array) to use it instead of `env.skills`. The override is verbatim, no merge.
  // The owning team's pool (/workspace/teams/<teamId>/skills) takes precedence over
  // the global pool (/template-workspace/skills); when a team has no skill of that
  // name this falls back to global, so the global-only behaviour is unchanged.
  const selectedSkills = Array.isArray(opts.skillsOverride)
    ? opts.skillsOverride
    : ((env && Array.isArray(env.skills)) ? env.skills : []);
  if (selectedSkills.length > 0) {
    const ownerTeamId = opts.teamId || DEFAULT_TEAM_ID;
    const skillsDst = path.join(dest, "skills");
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skillName of selectedSkills) {
      const src = resolveSkillSourceDir(skillName, ownerTeamId);
      const dst = path.join(skillsDst, skillName);
      if (!src) {
        warnings.push(`skill not found in pool: ${skillName}`);
        continue;
      }
      try {
        fs.cpSync(src, dst, { recursive: true });
      } catch (err) {
        warnings.push(`skill ${skillName}: ${err.message}`);
      }
    }
  }

  // 3. Patch absolute /workspace/ paths in seeded memory
  patchSeededPaths(dest);

  // 4. Materialize MCP server config into the agent's own .claude/settings.json.
  //    Team-members may override the team-env's MCP list — pass `opts.mcpServersOverride`
  //    (an array of { serverId, credentialId }) to use it instead of `env.mcpServers`.
  //    The override is verbatim, no merge.
  const mcpRefs = Array.isArray(opts.mcpServersOverride)
    ? opts.mcpServersOverride
    : ((env && Array.isArray(env.mcpServers)) ? env.mcpServers : []);
  const mcpSeeded = seedAgentMcpServers(dest, mcpRefs, warnings);

  // 5. Optional git clone(s)
  const clones = cloneEnvironmentRepositories(dest, env, warnings);

  const cloneSummary = clones.length > 0 ? `, repos=${clones.map(c => c.repoName).join(",")}` : "";
  const mcpSummary = mcpSeeded.length > 0 ? `, mcp=${mcpSeeded.join(",")}` : "";
  console.log(`[Orchestrator] Seeded workspace for ${id} (env=${env?.id || "none"}, skills=${selectedSkills.length}${mcpSummary}${cloneSummary})`);
  // Warnings (failed clones, missing skills, etc.) used to be silently
  // dropped into the response object — invisible from the logs unless the
  // caller surfaced them. Log them prominently so a clone failure during
  // team-member seeding is immediately visible to the operator.
  for (const w of warnings) {
    console.warn(`[Orchestrator] Seed warning for ${id}: ${w}`);
  }
  return { seeded: true, warnings, clones };
}

// For each {serverId, credentialId} ref attached to the environment (or its
// team-member override), load the server.json template, substitute the
// `${credential}` placeholder with the secret read from the credentials store,
// and write the merged stanza into the agent's own `.claude/settings.json`
// under `mcpServers[<serverId>]`. Per-agent isolation: pool-level MCP config
// is no longer consulted at runtime.
function seedAgentMcpServers(dest, mcpRefs, warnings) {
  const seeded = [];
  if (!Array.isArray(mcpRefs) || mcpRefs.length === 0) return seeded;

  const settingsPath = path.join(dest, ".claude", "settings.json");
  let settings = {};
  try {
    if (fs.existsSync(settingsPath)) {
      settings = JSON.parse(fs.readFileSync(settingsPath, "utf8")) || {};
    }
  } catch (err) {
    warnings.push(`mcp: cannot parse existing .claude/settings.json — overwriting (${err.message})`);
    settings = {};
  }
  if (!settings.mcpServers || typeof settings.mcpServers !== "object") settings.mcpServers = {};

  for (const ref of mcpRefs) {
    const serverId = ref?.serverId;
    const credId = ref?.credentialId || null;
    if (!serverId || !/^[a-z0-9-]+$/.test(serverId)) {
      warnings.push(`mcp: invalid serverId in env ref: ${JSON.stringify(ref)}`);
      continue;
    }
    const serverPath = path.join(MCP_SERVERS_DIR, serverId, "server.json");
    let server;
    try {
      server = JSON.parse(fs.readFileSync(serverPath, "utf8"));
    } catch (err) {
      warnings.push(`mcp: server '${serverId}' not found in registry (${err.message})`);
      continue;
    }

    let secret = "";
    if (credId) {
      if (!/^[a-z0-9-]+$/.test(credId)) {
        warnings.push(`mcp: invalid credentialId for server '${serverId}': ${credId}`);
        continue;
      }
      try {
        secret = fs.readFileSync(path.join(MCP_CREDENTIALS_KEYS_DIR, credId), "utf8").trim();
      } catch (err) {
        warnings.push(`mcp: cannot read credential '${credId}' for server '${serverId}' (${err.message})`);
        continue;
      }
    }

    // Different transports carry the substitution template under different
    // keys: stdio servers get `env` (process environment), http/sse servers
    // get `headers` (HTTP request headers). The substitution mechanics are
    // identical — only the destination key changes.
    const transport = server.transport || "stdio";
    if (!["stdio", "http", "sse"].includes(transport)) {
      warnings.push(`mcp: server '${serverId}' has unsupported transport '${transport}'`);
      continue;
    }
    const tplKey = transport === "stdio" ? "env" : "headers";
    const template = (server[tplKey] && typeof server[tplKey] === "object") ? server[tplKey] : {};

    const resolved = {};
    let placeholderUsed = false;
    for (const [k, v] of Object.entries(template)) {
      if (typeof v !== "string") { resolved[k] = v; continue; }
      if (v.includes("${credential}")) {
        placeholderUsed = true;
        if (!secret) {
          warnings.push(`mcp: server '${serverId}' ${tplKey} key '${k}' uses \${credential} but no credential is bound`);
          // Drop the key rather than leak the literal placeholder into the agent.
          continue;
        }
        resolved[k] = v.split("${credential}").join(secret);
      } else {
        resolved[k] = v;
      }
    }
    if (!placeholderUsed && credId) {
      warnings.push(`mcp: server '${serverId}' has a credential bound but no \${credential} placeholder in ${tplKey} — credential ignored`);
    }

    // Stanza shape per Claude Code's MCP config schema:
    //   stdio   → { command, args, env }                  (no `type` field — stdio is the default)
    //   http    → { type: "http", url, headers }
    //   sse     → { type: "sse",  url, headers }
    let stanza;
    if (transport === "stdio") {
      stanza = {
        command: server.command,
        args: Array.isArray(server.args) ? server.args : [],
        env: resolved,
      };
    } else {
      stanza = {
        type: transport,
        url: server.url,
        headers: resolved,
      };
    }
    settings.mcpServers[serverId] = stanza;
    seeded.push(serverId);
  }

  try {
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  } catch (err) {
    warnings.push(`mcp: cannot write .claude/settings.json (${err.message})`);
  }
  return seeded;
}

// Clone every repository attached to an environment. Errors are pushed to the
// shared warnings list so one failed clone never aborts the rest of the seed.
function cloneEnvironmentRepositories(targetDir, env, warnings) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const results = [];
  for (const repo of repos) {
    if (!repo?.url) continue;
    try {
      const info = cloneRepository(targetDir, repo, env?.githubTokenId || null, env?.id || null);
      if (info) results.push(info);
    } catch (err) {
      warnings.push(`git clone (${repo.url}): ${err.message}`);
    }
  }
  return results;
}

// Per-env clone cache. The first agent in an env triggers a real `git clone`
// into <envDir>/_repo-cache/<repoName>; subsequent agents in the same env
// `cp -r` from that cache instead of paying the network round-trip again.
// Each agent still ends up with its own independent working copy — the cache
// is only used as the source of the copy, never shared at runtime.
function envRepoCachePath(envId, repoName) {
  if (!envId || !repoName) return null;
  return path.join(ENVIRONMENTS_DIR, envId, "_repo-cache", repoName);
}

function isUsableRepoCache(cacheDir) {
  if (!cacheDir || !fs.existsSync(cacheDir)) return false;
  // Validate the cache holds a complete clone — partial / interrupted clones
  // would silently propagate to every member otherwise.
  try {
    return fs.existsSync(path.join(cacheDir, ".git", "HEAD"));
  } catch {
    return false;
  }
}

function cloneRepository(targetDir, repository, envGithubTokenId = null, envId = null) {
  const { url, branch, sshKeyId } = repository;
  if (!url) return null;

  // The transport choice is driven by the URL, not by which credentials
  // the env carries. HTTPS URLs need PAT-based Basic auth; SSH URLs need
  // GIT_SSH_COMMAND with the deploy key. The wizard sets BOTH credentials
  // by default (defense-in-depth) and writes the env's `repositories[].url`
  // as HTTPS — so an SSH key being present alongside an HTTPS URL is
  // expected, and we must not let it pre-empt the token path. Pick the
  // right one for the URL and warn loudly when nothing fits.
  const isHttpsGithub = /^https?:\/\/(www\.)?github\.com\//i.test(url);
  const isSshUrl = /^(ssh:\/\/|git@)/.test(url);

  let keyPath = null;
  // Resolve the SSH key only when we actually intend to use it. For HTTPS
  // URLs the key is irrelevant — verifying its existence here would fail
  // the whole clone for envs whose key was rotated/removed long ago even
  // though the HTTPS+token path would have worked fine.
  if (isSshUrl && sshKeyId) {
    keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
    if (!fs.existsSync(keyPath)) {
      throw new Error(`SSH key not found: ${sshKeyId}`);
    }
    try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  }

  const repoName = (url.split("/").pop() || "repo").replace(/\.git$/, "");
  const repoDir = path.join(targetDir, repoName);

  if (fs.existsSync(repoDir)) {
    console.log(`[Orchestrator] Repo dir already exists: ${repoDir} — skipping clone`);
    return { repoName, skipped: true };
  }

  // Cache fast-path: if a sibling agent in this env already cloned the repo
  // we can copy that working tree instead of running `git clone` again.
  const cacheDir = envRepoCachePath(envId, repoName);
  if (isUsableRepoCache(cacheDir)) {
    try {
      fs.cpSync(cacheDir, repoDir, { recursive: true });
      console.log(`[Orchestrator] Copied ${repoName} from env cache → ${repoDir}`);
      return { repoName, skipped: false, fromCache: true };
    } catch (err) {
      // Fall through to a fresh clone if the copy fails — the cache may be
      // corrupted or hit a permission edge case. Don't let the optimisation
      // fail seeding outright.
      console.warn(`[Orchestrator] Cache copy for ${repoName} failed (${err.message}); falling back to git clone`);
    }
  }

  // For HTTPS GitHub URLs, authenticate via GIT_CONFIG_* env vars so the
  // token never appears in process arguments (/proc/<pid>/cmdline) and never
  // lands in `git remote -v` (no URL rewriting). Only active for this single
  // invocation. The presence of an SSH key does NOT block this path — SSH
  // keys are no help for HTTPS transport.
  let authBasic = null;
  if (isHttpsGithub && envGithubTokenId) {
    const tokenPath = path.join(GH_TOKENS_DIR, envGithubTokenId);
    try {
      const ghToken = fs.readFileSync(tokenPath, "utf8").trim();
      if (ghToken) {
        authBasic = Buffer.from(`x-access-token:${ghToken}`).toString("base64");
      }
    } catch (err) {
      console.warn(`[Orchestrator] Cannot read GitHub token ${envGithubTokenId} for clone: ${err.message}`);
    }
  }
  // Refuse the clone proactively when no auth can possibly work. Without
  // this, git would block on a username prompt (no TTY → fatal: could not
  // read Username) and the failure would surface as a cryptic stderr line.
  if (isHttpsGithub && !authBasic) {
    throw new Error(
      `HTTPS clone of ${url} needs a GitHub PAT, but the env has no usable githubTokenId ` +
      `(SSH keys do not authenticate HTTPS transports). Either add a PAT to the env or ` +
      `change the repository URL to its SSH form.`
    );
  }

  const args = ["clone"];
  if (branch) args.push("--branch", branch);
  args.push("--", url, repoName);

  const env = { ...process.env };
  if (keyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
  }
  if (authBasic) {
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = "http.https://github.com/.extraheader";
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${authBasic}`;
  }

  try {
    execFileSync("git", args, {
      cwd: targetDir,
      env,
      stdio: "pipe",
      timeout: 120_000,
    });
    console.log(`[Orchestrator] Cloned ${url} → ${repoDir}`);
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    const msg = stderr.substring(0, 400) || err.message;
    throw new Error(`git clone failed: ${msg}`);
  }

  // Seed the env-level cache so the next member in the same env can skip
  // the network round-trip. Failure here is non-fatal: subsequent members
  // simply re-clone instead of copying.
  if (cacheDir) {
    try {
      fs.mkdirSync(path.dirname(cacheDir), { recursive: true });
      if (!fs.existsSync(cacheDir)) {
        fs.cpSync(repoDir, cacheDir, { recursive: true });
      }
    } catch (err) {
      console.warn(`[Orchestrator] Cache seed for ${repoName} failed (${err.message}) — siblings will re-clone`);
    }
  }

  return { repoName, skipped: false, fromCache: false };
}

// Force-copy the ACE engineering skill into an agent's workspace, regardless
// of whether its Working Environment lists it. Required for bp-instance
// agents to actually execute Briefing Packs. No-op if the skill is already
// in the workspace; logs a warning if the pool is missing it (run `make
// seed-skills` to fix).
function ensureEngineeringSkill(agentId) {
  const dst = path.join(agentDir(agentId), "skills", "engineering");
  if (fs.existsSync(dst)) return { copied: false };
  const src = path.join(TEMPLATE_WORKSPACE, "skills", "engineering");
  if (!fs.existsSync(src)) {
    console.warn(
      `[Orchestrator] Engineering skill missing from skill pool — bp-instance ${agentId} ` +
      `cannot execute Briefing Packs. Run \`make seed-skills\` to install it.`
    );
    return { copied: false, missing: true };
  }
  try {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.cpSync(src, dst, { recursive: true });
    return { copied: true };
  } catch (err) {
    console.error(`[Orchestrator] Failed to copy engineering skill into ${agentId}: ${err.message}`);
    return { copied: false, error: err.message };
  }
}

function patchSeededPaths(dir) {
  const memoryDir = path.join(dir, "memory");
  if (!fs.existsSync(memoryDir)) return;
  for (const file of fs.readdirSync(memoryDir)) {
    if (!file.endsWith(".md")) continue;
    const filePath = path.join(memoryDir, file);
    try {
      let content = fs.readFileSync(filePath, "utf8");
      const patched = content.replace(/\/workspace\//g, "./");
      if (patched !== content) {
        fs.writeFileSync(filePath, patched);
        console.log(`[Orchestrator] Patched paths in memory/${file}`);
      }
    } catch (err) {
      console.log(`[Orchestrator] Patch warning (${file}): ${err.message}`);
    }
  }
}

// Workspace seeding for blueprint instances: no memory copy (shared via API)
function seedAgentWorkspaceForInstance(id, env, blueprintId) {
  const dest = agentDir(id);
  fs.mkdirSync(dest, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WORKSPACE)) {
    console.log(`[Orchestrator] Template workspace not available — skipping seed for instance ${id}`);
    return { seeded: false, warnings: ["Template workspace not mounted"] };
  }

  const warnings = [];

  // Copy .claude settings (not memory — shared via blueprint)
  const src = path.join(TEMPLATE_WORKSPACE, ".claude");
  const dst = path.join(dest, ".claude");
  if (fs.existsSync(src)) {
    try { fs.cpSync(src, dst, { recursive: true }); }
    catch (err) { warnings.push(`copy .claude: ${err.message}`); }
  }

  // Copy selected skills
  const selectedSkills = (env && Array.isArray(env.skills)) ? env.skills : [];
  if (selectedSkills.length > 0) {
    const skillsSrc = path.join(TEMPLATE_WORKSPACE, "skills");
    const skillsDst = path.join(dest, "skills");
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skillName of selectedSkills) {
      const skillSrc = path.join(skillsSrc, skillName);
      const skillDst = path.join(skillsDst, skillName);
      if (!fs.existsSync(skillSrc)) { warnings.push(`skill not found: ${skillName}`); continue; }
      try { fs.cpSync(skillSrc, skillDst, { recursive: true }); }
      catch (err) { warnings.push(`skill ${skillName}: ${err.message}`); }
    }
  }

  // Create local memory dir (used as staging area; content synced from blueprint API at session start)
  fs.mkdirSync(path.join(dest, "memory"), { recursive: true });

  // Ensure blueprint memory dir exists and seed from template if first instance
  seedBlueprintMemory(blueprintId);

  // Git clone(s)
  const clones = cloneEnvironmentRepositories(dest, env, warnings);

  const cloneSummary = clones.length > 0 ? `, repos=${clones.map(c => c.repoName).join(",")}` : "";
  console.log(`[Orchestrator] Seeded instance workspace for ${id} (blueprint=${blueprintId}, skills=${selectedSkills.length}${cloneSummary})`);
  return { seeded: true, warnings, clones };
}

// ============================================================
// Trigger storage (per-agent triggers.json)
// ============================================================
// Triggers are control→agent state: the orchestrator owns the canonical copy
// (on /control when the agent's volume is isolated, on the pool subpath
// otherwise — see controlOrPoolPath) and the agent pulls it over HTTP. Admin
// CRUD routes its writes through us (PUT /internal/agents/:id/triggers) so this
// stays the single writer.
function loadTriggers(id) {
  const p = controlOrPoolPath(id, "triggers.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[Triggers] Error loading triggers for ${id}: ${err.message}`);
  }
  return [];
}

function saveTriggers(id, triggers) {
  const p = controlOrPoolPath(id, "triggers.json");
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(triggers, null, 2));
}

function deleteAgentFiles(id) {
  const dir = agentDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
  // Control-plane state pushed by the agent (#185): /control/agents/<id>/
  // status.json + sessions/<roomId>.jsonl + the session-pointer mirror. This
  // is UNCONDITIONAL — push (AEE_PUSH_STATE) defaults ON, so the control dir
  // exists for every agent even on the shared volume, not just under the
  // per-agent-volume flag. Leaving it behind leaks state and, because
  // agentStatePath/controlOrAgentPath prefer the /control copy when present,
  // makes a reused agent id read stale status.json until its first push.
  try { fs.rmSync(controlAgentDir(id), { recursive: true, force: true }); }
  catch { /* best effort */ }
  // Per-agent Claude home (SubPath homes/<id> of the shared claude-home volume,
  // mounted at /root/.claude on the orchestrator). Can't be torn down via libpod
  // (it's a subpath, not a dedicated volume), but the orchestrator can rm the
  // subdir directly. Gated on PER_AGENT_VOLUME to keep the default shared-volume
  // path byte-for-byte (its pre-existing homes/<id> leak is out of scope). The
  // dedicated DATA volume is removed separately by removePerAgentVolume at the
  // async call sites (#185 item 6).
  if (PER_AGENT_VOLUME) {
    try { fs.rmSync(path.join('/root/.claude/homes', id), { recursive: true, force: true }); }
    catch { /* best effort */ }
  }
}

// Mirror named control-plane files (CLAUDE.md, AGENT-PROMPT.md, skills/<name>,
// ...) from the pool subpath into an isolated agent's dedicated volume after an
// edit (#185 item 5). No-op unless the per-agent-volume flag is on AND the agent
// is currently running — a stopped/never-spawned agent re-seeds fresh on its
// next spawn, and a missing volume is skipped inside reseedPerAgentVolume.
// Best-effort: a re-seed failure must never break the edit that triggered it.
async function reseedAgent(id, paths) {
  if (!PER_AGENT_VOLUME) return { skipped: 'flag-off' };
  if (!agentProcesses.has(id)) return { skipped: 'not-running' };
  try {
    return await reseedPerAgentVolume(id, paths);
  } catch (err) {
    console.warn(`[Orchestrator] reseed ${id} (${(paths || []).join(',')}): ${err.message}`);
    return { error: err.message };
  }
}

function listAgentIds() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) =>
    fs.existsSync(path.join(AGENTS_DIR, f, "config.json"))
  );
}

// ============================================================
// Matrix helpers (admin operations only — no routing identity)
// ============================================================
async function ensureMatrixUser(adminClient, username, password) {
  await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
    msgtype: "m.text",
    body: `!admin users create-user ${username} ${password}`,
  });
  await new Promise((r) => setTimeout(r, 3000));

  await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
    msgtype: "m.text",
    body: `!admin users reset-password @${username}:local ${password}`,
  });
  await new Promise((r) => setTimeout(r, 1000));
  await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
    msgtype: "m.text",
    body: `!admin users enable-login @${username}:local`,
  });
  await new Promise((r) => setTimeout(r, 1000));
}

async function loginMatrixUser(username, password) {
  const res = await fetch(`${HOMESERVER}/_matrix/client/v3/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "m.login.password",
      identifier: { type: "m.id.user", user: username },
      password,
    }),
  });
  const data = await res.json();
  if (!data.access_token) throw new Error(`Login failed: ${JSON.stringify(data)}`);
  return data.access_token;
}

async function setDisplayName(token, userId, displayName) {
  await fetch(
    `${HOMESERVER}/_matrix/client/v3/profile/${encodeURIComponent(userId)}/displayname`,
    {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ displayname: displayName }),
    }
  );
}

// ============================================================
// Git helpers (pull + commit + push from the orchestrator workspace)
// ============================================================

// Throttle the per-orchestrator workspace pull to at most once per
// _PULL_THROTTLE_MS, so the 30s claim-tick can call it cheaply on every
// iteration without hammering the remote. The forced variant (`{ force: true }`)
// is for callers that need a fresh local index *now* (e.g. BP-event routing
// against .index.json) but still coalesces same-orchestrator bursts within
// _PULL_FORCE_THROTTLE_MS so a flurry of signals can't multiply pulls.
const _pullThrottles = new Map(); // orchestratorId -> last pull timestamp ms
const _PULL_THROTTLE_MS = 60_000;
const _PULL_FORCE_THROTTLE_MS = 5_000;

// Throttle the "workspace not a git repo" warning so a broken orchestrator
// in the 30s claim-loop emits the diagnostic once every few minutes rather
// than 120 times an hour. Resets when the workspace is fixed (entry deleted).
const _missingWorkspaceWarns = new Map(); // orchestratorId -> last warn ms
const _MISSING_WORKSPACE_WARN_MS = 5 * 60_000;
function shouldWarnMissingWorkspace(orchestratorId) {
  const last = _missingWorkspaceWarns.get(orchestratorId) || 0;
  if (Date.now() - last < _MISSING_WORKSPACE_WARN_MS) return false;
  _missingWorkspaceWarns.set(orchestratorId, Date.now());
  return true;
}

// Where the agent's persistent Claude home is mounted *inside the orchestrator*
// (the whole claude-home volume) vs. *inside the agent* (only its homes/<id>
// SubPath). Files the orchestrator writes under <ORCH>/homes/<id>/X surface to
// the agent at <AGENT>/X — the bridge we use to hand a per-env SSH key to an
// agent container that does not mount the _keys store.
const CLAUDE_HOME_ORCH_DIR = "/root/.claude";
const CLAUDE_HOME_AGENT_DIR = "/root/.claude";

// Install the environment's SSH deploy key into a running agent.
//
// The agent container mounts neither the _keys store nor the host deploy key,
// yet startAgentProcess copies the orchestrator's whole process.env into the
// agent — including the GIT_SSH_COMMAND that docker-compose sets for the
// orchestrator itself (pointing at /root/.ssh/id_accenturecodefoundry, a file
// that only exists in the orchestrator). Inherited blindly, that var made every
// agent's `git push` reference a key it does not have ("SSH key missing").
//
// So we ALWAYS strip the inherited value first, then — only when the env has an
// SSH key — copy that key into the agent's claude-home SubPath (orchestrator
// path <ORCH>/homes/<id>/.ssh, agent path <AGENT>/.ssh) and write a self-
// contained ssh config beside it. GIT_SSH_COMMAND is set to `ssh -F <config>`
// so it applies regardless of the agent's HOME (agent git runs with
// HOME=/workspace/agents/<id>, so the image-baked /root/.ssh/config is never
// read). The config carries the github.com -> ssh.github.com:443 routing that
// corporate networks blocking outbound TCP 22 require.
function materializeAgentSshKey(id, env, childEnv) {
  delete childEnv.GIT_SSH_COMMAND;

  const orchSshDir = path.join(CLAUDE_HOME_ORCH_DIR, "homes", id, ".ssh");
  const orchKeyPath = path.join(orchSshDir, "id_env");
  const orchCfgPath = path.join(orchSshDir, "config");
  const agentSshDir = path.join(CLAUDE_HOME_AGENT_DIR, ".ssh");
  const agentKeyPath = path.join(agentSshDir, "id_env");
  const agentCfgPath = path.join(agentSshDir, "config");
  const agentKnownHosts = path.join(agentSshDir, "known_hosts");

  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const sshKeyId = repos.find((r) => r && r.sshKeyId)?.sshKeyId;
  if (!sshKeyId) {
    // No key for this env — make sure no stale identity lingers from a prior
    // spawn under a different (key-bearing) environment.
    try { fs.rmSync(orchKeyPath, { force: true }); } catch { /* best effort */ }
    try { fs.rmSync(orchCfgPath, { force: true }); } catch { /* best effort */ }
    return;
  }

  const srcKeyPath = path.join(SSH_KEYS_DIR, sshKeyId);
  if (!fs.existsSync(srcKeyPath)) {
    console.error(`[Orchestrator] Agent ${id} → SSH key ${sshKeyId} not found at ${srcKeyPath}; SSH git ops will fail`);
    return;
  }

  try {
    fs.mkdirSync(orchSshDir, { recursive: true });
    fs.writeFileSync(orchKeyPath, fs.readFileSync(srcKeyPath), { mode: 0o600 });
    fs.chmodSync(orchKeyPath, 0o600);
    const sshConfig = [
      "Host github.com",
      "  HostName ssh.github.com",
      "  Port 443",
      "  User git",
      `  IdentityFile ${agentKeyPath}`,
      "  IdentitiesOnly yes",
      `  UserKnownHostsFile ${agentKnownHosts}`,
      "  StrictHostKeyChecking accept-new",
      "  BatchMode yes",
      "",
    ].join("\n");
    fs.writeFileSync(orchCfgPath, sshConfig, { mode: 0o600 });
    childEnv.GIT_SSH_COMMAND = `ssh -F ${agentCfgPath}`;
    console.log(`[Orchestrator] Agent ${id} → SSH identity installed (env=${env.id}, key=${sshKeyId})`);
  } catch (err) {
    console.error(`[Orchestrator] Agent ${id} → failed to install SSH key ${sshKeyId}: ${err.message}`);
  }
}

// Build the GIT_SSH_COMMAND value for an env with an attached SSH key. Falls
// back to null so the caller can leave process.env's default in place (the
// orchestrator container ships with a baseline SSH identity mounted via
// docker-compose).
function buildGitSshCommand(env) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const sshKeyId = repos.find((r) => r && r.sshKeyId)?.sshKeyId;
  if (!sshKeyId) return null;
  const keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
  if (!fs.existsSync(keyPath)) return null;
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
  return `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
}

// Best-effort `git fetch && git pull --ff-only` in the orchestrator's
// briefings workspace clone. Throttled per orchestrator. Failures are
// logged but never throw — a stale local main is preferable to a broken
// claim tick.
function pullOrchestratorWorkspace(orchestratorId, briefingsPath, env, { force = false } = {}) {
  const rel = (briefingsPath || "").replace(/^\/+|\/+$/g, "");
  const agentRoot = path.join(AGENTS_DIR, orchestratorId);
  const workspace = path.join(agentRoot, rel);
  // The briefings dir may sit at the repo root (classic case) or in a
  // sub-directory of a cloned repo (multiple BP collections per repo). Walk
  // upward until we find an enclosing `.git`, capped at the agent root so a
  // bad config can never escape the agent's own workspace.
  const repoRoot = findEnclosingGitRepo(workspace, agentRoot);
  if (!repoRoot) {
    // Log the skip so a misconfigured briefings clone isn't invisible — but
    // throttle so the 30s claim-loop doesn't carpet the orchestrator log
    // with the same line. `force: true` (operator-triggered sync) always
    // logs so the user sees feedback from their explicit action.
    if (force || shouldWarnMissingWorkspace(orchestratorId)) {
      console.warn(
        `[Orchestrator] Pull skipped for ${orchestratorId}: no enclosing git checkout found below ${agentRoot} for briefings workspace ${workspace}`
      );
    }
    return { skipped: "not-a-git-repo", path: workspace };
  }
  const last = _pullThrottles.get(orchestratorId) || 0;
  const throttleMs = force ? _PULL_FORCE_THROTTLE_MS : _PULL_THROTTLE_MS;
  if (Date.now() - last < throttleMs) return { skipped: "throttled" };
  _pullThrottles.set(orchestratorId, Date.now());

  const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  const sshCmd = buildGitSshCommand(env);
  if (sshCmd) gitEnv.GIT_SSH_COMMAND = sshCmd;

  try {
    execFileSync("git", ["fetch", "origin"], {
      cwd: repoRoot, env: gitEnv, stdio: "pipe", timeout: 30_000,
    });
    execFileSync("git", ["pull", "--ff-only"], {
      cwd: repoRoot, env: gitEnv, stdio: "pipe", timeout: 30_000,
    });
    return { pulled: true, repoRoot };
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim().slice(0, 200);
    console.warn(`[Orchestrator] Pull failed for ${orchestratorId}: ${detail}`);
    return { failed: true, detail, repoRoot };
  }
}

// Inspect every repo of an agent's environment in its workspace and report
// commit/push state. Used by the hand-off pre-flight: an agent must not push
// uncommitted work onto downstream agents that only see the repo via git.
//
// For each repo entry in `env.repositories` we resolve the workspace clone,
// run a small set of plumbing commands, and return a record with:
//
//   {
//     name, url, branch, sshKeyId,
//     path,                              // absolute path inside the orchestrator container
//     exists,                            // false → never cloned, all other fields are null
//     branchActual, head, headShort,
//     headSubject, headAuthor, headDate, // last commit metadata
//     remoteUrl,                         // `git remote get-url origin`
//     upstream,                          // tracking branch (e.g. origin/feature/x) or null
//     ahead, behind,                     // commits vs. upstream; null if no upstream
//     dirty: { staged, unstaged, untracked, files: [{path, status}] },
//     pushed,                            // true ↔ ahead === 0 && upstream !== null
//     clean,                             // true ↔ no dirty changes anywhere
//     ready,                             // clean && pushed — green light for hand-off
//     warnings: [...],                   // non-fatal notes (e.g. detached HEAD, missing upstream)
//     error,                             // present if git plumbing failed for this repo
//   }
//
// Per-repo failures are caught and surfaced via the `error` field — one bad
// repo never aborts the rest of the report.
function inspectAgentRepoStatuses(agentId, env) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const workspace = agentDir(agentId);
  const results = [];

  for (const repo of repos) {
    if (!repo?.url) continue;
    const name = (repo.url.split("/").pop() || "repo").replace(/\.git$/, "");
    const repoPath = path.join(workspace, name);
    const base = {
      name,
      url: repo.url,
      branch: repo.branch || null,
      sshKeyId: repo.sshKeyId || null,
      path: repoPath,
      exists: false,
      branchActual: null,
      head: null,
      headShort: null,
      headSubject: null,
      headAuthor: null,
      headDate: null,
      remoteUrl: null,
      upstream: null,
      ahead: null,
      behind: null,
      dirty: { staged: 0, unstaged: 0, untracked: 0, files: [] },
      pushed: false,
      clean: false,
      ready: false,
      warnings: [],
      error: null,
    };

    if (!fs.existsSync(path.join(repoPath, ".git"))) {
      results.push(base);
      continue;
    }
    base.exists = true;

    const run = (args, opts = {}) => {
      try {
        return execFileSync("git", args, {
          cwd: repoPath,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: opts.timeout || 5_000,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        }).toString();
      } catch (err) {
        const detail = (err.stderr || err.stdout || err.message || "").toString().trim();
        const e = new Error(detail.slice(0, 300) || `git ${args[0]} failed`);
        e.code = err.status || 1;
        throw e;
      }
    };

    try {
      base.branchActual = run(["rev-parse", "--abbrev-ref", "HEAD"]).trim();
      if (base.branchActual === "HEAD") {
        base.warnings.push("detached HEAD — no branch checked out");
      }
      base.head = run(["rev-parse", "HEAD"]).trim();
      base.headShort = base.head.slice(0, 8);

      // %x1f = unit separator, safe across commit subjects.
      const fmt = run(["log", "-1", "--pretty=format:%s%x1f%an%x1f%aI"]).split("\x1f");
      base.headSubject = (fmt[0] || "").trim() || null;
      base.headAuthor  = (fmt[1] || "").trim() || null;
      base.headDate    = (fmt[2] || "").trim() || null;

      try { base.remoteUrl = run(["remote", "get-url", "origin"]).trim() || null; } catch { /* no origin */ }

      try {
        base.upstream = run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"]).trim();
      } catch {
        base.upstream = null;
        base.warnings.push("no upstream tracking branch");
      }

      if (base.upstream) {
        try {
          const counts = run(["rev-list", "--left-right", "--count", `${base.upstream}...HEAD`]).trim().split(/\s+/);
          base.behind = Number(counts[0] || 0);
          base.ahead  = Number(counts[1] || 0);
        } catch {
          base.warnings.push("could not compare against upstream — fetch may be needed");
        }
      }

      const porcelain = run(["status", "--porcelain=v1", "--untracked-files=all"]);
      const lines = porcelain.split("\n").filter((l) => l.length > 0);
      const files = [];
      for (const line of lines) {
        // Format: XY <path>  (X = staged, Y = unstaged; "??" = untracked)
        const code = line.slice(0, 2);
        const file = line.slice(3);
        let status;
        if (code === "??") {
          base.dirty.untracked++;
          status = "untracked";
        } else {
          if (code[0] && code[0] !== " ") base.dirty.staged++;
          if (code[1] && code[1] !== " ") base.dirty.unstaged++;
          status = code.trim();
        }
        if (files.length < 25) files.push({ path: file, status });
      }
      base.dirty.files = files;

      base.clean  = base.dirty.staged === 0 && base.dirty.unstaged === 0 && base.dirty.untracked === 0;
      base.pushed = base.upstream !== null && base.ahead === 0;
      base.ready  = base.clean && base.pushed;
    } catch (err) {
      base.error = err.message || String(err);
    }

    results.push(base);
  }

  return results;
}

// Update or insert a top-level YAML key in a frontmatter block. Quotes the
// value if it contains characters that would break unquoted YAML.
function upsertYamlField(yaml, key, value) {
  const v = /[:\s#"]/.test(value) ? `"${String(value).replace(/"/g, '\\"')}"` : value;
  const re = new RegExp(`^${key}\\s*:.*$`, "m");
  if (re.test(yaml)) return yaml.replace(re, `${key}: ${v}`);
  return yaml.replace(/\s*$/, `\n${key}: ${v}\n`);
}

// Patch a brief.md frontmatter to record the claim. Throws if no frontmatter
// is present (we don't auto-create one — that's a brief we don't understand).
function patchBriefForClaim(content, stubId) {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) throw new Error("brief.md has no YAML frontmatter");
  let fm = fmMatch[1];
  fm = upsertYamlField(fm, "status", "claimed");
  fm = upsertYamlField(fm, "agent-id", stubId);
  fm = upsertYamlField(fm, "claimed", new Date().toISOString());
  return content.replace(fmMatch[0], `---\n${fm.replace(/\n+$/, "")}\n---`);
}

// Pending-triggers queue (#185 Phase 2). The orchestrator owns this queue: all
// writers (hook server, bp-event router, github-poller, admin handover) funnel
// through enqueuePending, and the agent drains it (locally when on the shared
// volume; over HTTP via /pending-drain when isolated). Because every writer and
// the drain run in this single Node event loop, the read-modify-write needs no
// lock. controlOrPoolPath puts the file on /control when isolated, on the pool
// subpath otherwise (the agent's own drain location) — so it's non-breaking.
function pendingPath(id) {
  return controlOrPoolPath(id, "pending-triggers.json");
}

function enqueuePending(agentId, entry) {
  const p = pendingPath(agentId);
  let pending = [];
  try {
    if (fs.existsSync(p)) pending = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(pending)) pending = [];
  } catch { /* corrupt file — start over */ }
  pending.push({ receivedAt: new Date().toISOString(), ...entry });
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error(`[Orchestrator] Cannot enqueue pending for ${agentId}: ${err.message}`);
  }
}

// Atomic read-and-clear for the agent's HTTP drain. Single-event-loop atomic.
function drainPending(agentId) {
  const p = pendingPath(agentId);
  let entries = [];
  try {
    if (fs.existsSync(p)) entries = JSON.parse(fs.readFileSync(p, "utf8"));
    if (!Array.isArray(entries)) entries = [];
  } catch { entries = []; }
  if (entries.length) {
    try { fs.writeFileSync(p, "[]"); }
    catch (err) { console.error(`[Orchestrator] drainPending clear ${agentId}: ${err.message}`); }
  }
  return entries;
}

// Append a bp-event-batch entry to an agent's pending queue. The agent drain
// loop picks it up by `kind` (no triggers.json entry required — the routing
// decision was already made centrally).
function enqueueBpEventBatch(agentId, payload) {
  enqueuePending(agentId, { kind: "bp-event-batch", ...payload });
}

// Persistent notified-set per orchestrator. Tracks bpIds we've already
// surfaced to the user so the claim loop doesn't re-suggest every tick.
function claimStateFile(orchestratorId) {
  return path.join(agentDir(orchestratorId), ".claim-state.json");
}
function loadClaimState(orchestratorId) {
  try {
    return JSON.parse(fs.readFileSync(claimStateFile(orchestratorId), "utf8"));
  } catch {
    return { notified: [] };
  }
}
function saveClaimState(orchestratorId, state) {
  try {
    fs.writeFileSync(claimStateFile(orchestratorId), JSON.stringify(state, null, 2));
  } catch (err) {
    console.error(`[Orchestrator] Could not save claim-state for ${orchestratorId}: ${err.message}`);
  }
}

// ============================================================
// BriefingPack helpers
// ============================================================

// Fetch the list of Briefing Packs from bp-explorer for a given orchestrator
// agent. The workspace path passed to bp-explorer is the absolute path inside
// the shared agent-pool-workspace volume; bp-explorer expects exactly that
// shape and looks for `<path>/artifacts/briefings/`.
async function fetchBriefingPacks(orchestratorId, briefingsPath) {
  const rel = briefingsPath ? briefingsPath.replace(/^\/+|\/+$/g, "") : "";
  const workspace = path.join("/workspace/agents", orchestratorId, rel);
  const url = `${BP_EXPLORER_URL}/api/briefings?workspace=${encodeURIComponent(workspace)}`;
  const res = await fetch(url);
  if (!res.ok) {
    if (res.status === 404) {
      // artifacts/briefings/ not yet present in the cloned workspace — the
      // repo may need a pull to pick up the latest commit. Return empty so
      // the sync tick can complete cleanly; the next pull will surface BPs.
      console.warn(
        `[Orchestrator] No briefings directory found for ${orchestratorId} at ${workspace}` +
        ` — will retry after next git pull`
      );
      return [];
    }
    const detail = await res.text().catch(() => "");
    throw new Error(`bp-explorer ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Build the briefings dependency graph from bp-explorer's parsed frontmatter,
// returning the same map shape `bpEventRouter.findAffectedBps()` expects.
// This replaces the previous `.index.json` file read — bp-explorer already
// parses every brief.md and exposes the data via /api/briefings, so the
// orchestrator can derive the graph at request time without depending on an
// ACE-plugin script (scripts/build-index.py) being present in the repo.
//
// Transformation is in ./briefings-graph (pure, unit-tested separately).
async function loadBriefingsGraphFromExplorer(orchestratorId, briefingsPath) {
  const bps = await fetchBriefingPacks(orchestratorId, briefingsPath);
  return bpsToBriefingsMap(bps);
}

// Build the agent id for a BP-instance stub. Schema: `<slug>-<8-hex>` if a
// slug is available, else `bp-<8-hex>`. The hash prefix disambiguates BPs
// that share a slug.
function bpInstanceAgentId(bp) {
  const hash = (bp.id || "").replace(/[^0-9a-f]/gi, "").slice(0, 8) || "unknown0";
  const slug = (bp.slug || "").trim().toLowerCase();
  return slug ? `${slug}-${hash}` : `bp-${hash}`;
}

// Pick the best displayName for a stub: BP title, falling back to a humanized
// slug, then to the agent id. Matters because the user sees this in the UI.
function bpInstanceDisplayName(bp, agentId) {
  const title = (bp.title || "").trim();
  if (title) return title;
  const slug = (bp.slug || "").trim();
  if (slug) {
    return slug
      .split(/[-_]+/)
      .filter(Boolean)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(" ");
  }
  return agentId;
}

// Compute the path to a bp-instance's brief.md, relative to the orchestrator's
// briefingsPath root (i.e. the project root that bp-explorer scans). Prefers
// the authoritative `bpRelPath` recorded by bp-explorer — which preserves
// parent/child hierarchy — and falls back to the flat
// `artifacts/briefings/<id>-<slug>/brief.md` shape for legacy stubs that
// pre-date hierarchical support.
function bpInstanceBriefRelPath(cfg) {
  if (cfg.bpRelPath) return cfg.bpRelPath.replace(/^\/+/, "");
  const bpDirName = cfg.bpSlug ? `${cfg.bpId}-${cfg.bpSlug}` : cfg.bpId;
  return path.join("artifacts", "briefings", bpDirName, "brief.md");
}

// Build the system prompt for a bp-instance agent. Pins down the exact
// filesystem path of the brief.md (we know it because the orchestrator records
// the bp-explorer-reported relative path on the stub) and points at the
// engineering skill that defines how to actually execute a Briefing Pack.
function bpInstanceSystemPrompt(cfg) {
  const briefingsRoot = (cfg.briefingsPath || "").replace(/^\/+|\/+$/g, "");
  const briefRel = bpInstanceBriefRelPath(cfg);
  const briefPath = briefingsRoot
    ? `./${briefingsRoot}/${briefRel}`
    : `./${briefRel}`;
  const slugDisplay = cfg.bpSlug ? ` (\`${cfg.bpSlug}\`)` : "";

  return [
    `You are the agent instance for Briefing Pack \`${cfg.bpId}\`${slugDisplay}.`,
    ``,
    `**Your brief:** \`${briefPath}\``,
    `**Execution skill:** \`./skills/engineering/SKILL.md\` (ACE engineering — required reading)`,
    ``,
    `Your brief tells you which artifacts you owe and which upstream BPs feed them. The engineering skill defines the LoopScript phases, artifact conventions, and the CRP / MRP / VCR escalation flow. Read both before doing serious work.`,
    ``,
    `## How to behave`,
    ``,
    `You operate in one of two modes — pick the one that fits the situation.`,
    ``,
    `### Structured execution`,
    ``,
    `Use this mode when running autonomously (cron / trigger), or when the human explicitly asks you to "execute the brief" / "run your LoopScript". Then:`,
    ``,
    `1. Read the engineering skill and your \`brief.md\`.`,
    `2. Execute the LoopScript phase by phase. Write artifacts into the BP's own directory.`,
    `3. Submit an MRP when complete; wait for a VCR.`,
    `4. Escalate via a CRP only for genuine ambiguity in the brief itself.`,
    ``,
    `### Dynamic collaboration (default for human DMs)`,
    ``,
    `When a human chats with you for ad-hoc help — brainstorming, partial work, drafts, "help me prepare X" — **do not block on missing inputs and do not reflexively suggest a CRP**. Your job is to be useful right now.`,
    ``,
    `1. Briefly mention what your brief expects (artifacts you owe, upstream inputs) so the human sees what an "ideal" run would look like.`,
    `2. Ask what they actually want and what context they can share informally — treat the human as the upstream BP.`,
    `3. Produce the requested output (or a usable draft of one of your artifacts) from what's available. Label assumptions inline. Mark sections that would normally come from a missing upstream BP.`,
    `4. Save artifacts into the BP directory as usual, but stamp them with \`status: dynamic-draft\` at the top so a later structured run knows to refine them.`,
    `5. Reserve CRP escalation for ambiguity inside the brief itself. "Upstream BP X hasn't run yet" is **not** an escalation trigger — collaborate with the human to fill that gap instead.`,
    ``,
    `The brief is your map, not your cage. For coordination across multiple BPs, point the human at the orchestrator agent.`,
    ``,
    `## Closing the loop — explicit hand-off`,
    ``,
    `When your work on this BP is done (or far enough along that downstream BPs should pick up), tell the user explicitly and ask them to use the **Hand-off** button in this chat. The button lets the user pick which downstream agents should be activated and attaches a free-text note that arrives as a normal chat message in each downstream agent's room.`,
    ``,
    `Do **not** edit \`brief.md\` frontmatter (\`status\`, \`revision\`, \`agent-id\`, \`completed\`) yourself, and do **not** try to run lifecycle scripts — the hand-off flow is deliberately manual and decoupled from any ACE Python tooling in this environment.`,
  ].join("\n");
}

// Default system prompt used when creating an agent without an explicit
// systemPrompt — currently only meaningful for the orchestrator role.
function defaultSystemPromptFor(role, extra = {}) {
  if (role === "orchestrator") {
    const briefingsPath = extra.briefingsPath || "(unset)";
    return [
      `You are an orchestrator agent.`,
      ``,
      `You manage the Briefing Packs in the directory \`${briefingsPath}\`. ` +
        `Each Briefing Pack in this directory may become a standalone agent instance ` +
        `under your supervision.`,
      ``,
      `When a human asks you questions, help them understand the state of the Briefing Packs, ` +
        `explain status transitions, and reason about individual instances.`,
      ``,
      `## Claiming Briefing Packs`,
      ``,
      `A background loop watches the briefings directory. Whenever a BP transitions to ` +
        `\`status: dispatched\` (typically by a human or a teammate flipping the YAML ` +
        `frontmatter and pushing), you'll receive a SYSTEM NOTICE message in this chat ` +
        `listing the newly-dispatched BP(s) along with a \`curl\` command per BP.`,
      ``,
      `Your job when a SYSTEM NOTICE arrives is to **ask the user whether to claim**. ` +
        `Don't claim on your own. Wait for the user's reply.`,
      ``,
      `- If the user agrees, run the \`curl\` command for the relevant BP(s). ` +
        `Each call writes \`status: claimed\` plus your stub agent's id into the BP's ` +
        `\`brief.md\`, commits, and pushes — making the claim visible to teammates ` +
        `immediately. The corresponding BP-instance agent is then materialised and ` +
        `starts work.`,
      `- If the user declines, just acknowledge. The notice won't repeat unless the ` +
        `BP gets re-dispatched.`,
      `- The user may also ask you to claim a specific BP at any time (e.g. *"claim the ` +
        `customer-migration one"*). You can run the same \`curl\` directly — the ` +
        `endpoint is \`http://localhost:4002/internal/agents/<stub-agent-id>/claim\`.`,
      ``,
      `If a \`curl\` returns an HTTP 409 / "Push failed", a teammate claimed first. ` +
        `Tell the user, then move on.`,
    ].join("\n");
  }
  return "";
}

// ============================================================
// Orchestrator (backend service — no Matrix routing identity)
//
// The orchestrator runs as a pure backend service: it manages the per-agent
// child processes (agent-runner.js) and exposes an internal HTTP API for the
// admin console. It holds an admin Matrix client to create/deactivate user
// accounts via the Conduwuit admin room, but does not have a chat presence.
// All human↔agent communication happens via direct messages to each agent.
// ============================================================
class Orchestrator {
  constructor() {
    this.adminClient = null;
    // Map of agentId → { config } (no per-agent Matrix clients — they run in containers)
    this.agentConfigs = new Map();
  }

  async init() {
    if (CONDUWUIT_ADMIN_TOKEN && CONDUWUIT_ADMIN_ROOM) {
      this.adminClient = new MatrixClient(
        HOMESERVER,
        CONDUWUIT_ADMIN_TOKEN,
        new SimpleFsStorageProvider(path.join(WORKSPACE, ".admin-state.json"))
      );
    }

    fs.mkdirSync(AGENTS_DIR, { recursive: true });

    // Load all agent configs into memory
    for (const id of listAgentIds()) {
      const config = loadAgentConfig(id);
      if (config) this.agentConfigs.set(id, { config });
    }

    // Migrate orchestrator agents created before the role gained a Matrix
    // identity. Errors are logged and swallowed so a Matrix outage doesn't
    // prevent the rest of the orchestrator from starting — failed migrations
    // retry on the next container restart.
    for (const [id, { config }] of this.agentConfigs) {
      if (config.role !== "orchestrator") continue;
      if (config.token) continue;
      try {
        await this.materializeOrchestrator(id);
      } catch (err) {
        console.error(`[Orchestrator] Migration failed for ${id}: ${err.message}`);
      }
    }

    // Start all enabled agent containers
    await startAllEnabledAgents();

    console.log(`[Orchestrator] Backend service ready`);
    console.log(`[Orchestrator] Agents loaded: ${this.agentConfigs.size}`);
    for (const [id, { config }] of this.agentConfigs) {
      const schedInfo = config.schedule ? ` [${config.schedule}]` : "";
      console.log(`  ${id}: ${config.displayName} (${config.role})${schedInfo}`);
    }
  }

  async deactivateMatrixUser(id) {
    if (!this.adminClient) return;
    try {
      await this.adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
        msgtype: "m.text",
        body: `!admin users deactivate @${id}:local`,
      });
      console.log(`[Orchestrator] Matrix user @${id}:local deactivated`);
    } catch (err) {
      console.error(`[Orchestrator] Deactivate warning for @${id}:local: ${err.message}`);
    }
  }

  // ===========================================================
  // Agent creation
  // ===========================================================
  async createAgent(id, displayName, role, systemPrompt, environmentId, extra = {}) {
    const env = loadEnvironment(environmentId);
    if (!env) {
      throw new Error(`Working Environment not found: ${environmentId}`);
    }

    // team: save a template config (no Matrix user, no process) and
    // immediately materialize the first member — unless `extra.skipFirstMember`
    // is set (used by the Team-Setup wizard, which then adds members itself
    // with role-specific overrides).
    // Owning (human) Team — the tenant this construct belongs to (#299).
    // Defaults to the default team; an explicit `extra.teamId` must reference
    // an existing team.
    const ownerTeamId = resolveOwnerTeamId(extra.teamId);

    if (role === "team") {
      const teamConfig = {
        id,
        displayName,
        role: "team",
        environmentId: env.id,
        teamId: ownerTeamId,
        systemPromptTemplate: systemPrompt || "",
        enabled: true,
      };
      saveAgentConfig(id, teamConfig);
      this.agentConfigs.set(id, { config: teamConfig });
      console.log(`[Orchestrator] Created team ${id}`);

      if (extra.skipFirstMember) {
        return { id, team: true, firstMember: null };
      }
      const member = await this.addTeamMember(id);
      return { id, team: true, firstMember: member.id };
    }

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);

    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, displayName);

    // Seed agent workspace using the chosen environment
    const seedResult = seedAgentWorkspace(id, env, { teamId: ownerTeamId });

    // For orchestrators the briefings repo is load-bearing: without the clone
    // the BP discovery pipeline silently returns zero stubs and the user sees
    // an orchestrator that "works" but never finds anything. Treat the clone
    // failure as fatal (mirrors the team-setup wizard's gate), roll back the
    // half-built Matrix user, and surface the cause to the API caller.
    if (role === "orchestrator" && extra.briefingsPath) {
      const cloneWarning = (seedResult.warnings || []).find(w => /^git clone /.test(w));
      if (cloneWarning) {
        deleteAgentFiles(id);
        if (PER_AGENT_VOLUME) await removePerAgentVolume(id).catch(e =>
          console.warn(`[Orchestrator] volume teardown ${id}: ${e.message}`));
        await this.deactivateMatrixUser(id).catch(() => { /* best effort */ });
        throw new Error(
          `Cannot create orchestrator '${id}': briefings clone failed — ${cloneWarning}`
        );
      }
    }

    const effectivePrompt =
      systemPrompt && systemPrompt.trim()
        ? systemPrompt
        : defaultSystemPromptFor(role, extra);

    const config = {
      id,
      displayName,
      userId,
      token,
      role,
      environmentId: env.id,
      teamId: ownerTeamId,
      ...(role === "orchestrator" && extra.briefingsPath && { briefingsPath: extra.briefingsPath }),
      // Optional fields written by the Team-Setup wizard. `team` ties the
      // agent to its sibling team-mates (used by the Layer-2 `from: team`
      // filter and by the Admin Console's team grouping). `sessionPolicy:
      // per-invocation` makes triggered runs ephemeral — see the agent-runner
      // for the runtime behavior.
      ...(extra.team ? { team: String(extra.team) } : {}),
      ...(extra.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
      enabled: true,
    };
    saveAgentConfig(id, config);
    saveAgentPrompt(id, effectivePrompt, role, env);

    // Two ways to provide an initial trigger set, mutually exclusive:
    // - extra.triggers — full array, written verbatim. Used by the Team-Setup
    //   wizard which renders templates into multiple triggers per agent.
    // - extra.schedule + extra.taskPrompt — legacy single-cron path used by
    //   ad-hoc agent creation flows. Kept for backward compatibility.
    if (Array.isArray(extra.triggers) && extra.triggers.length > 0) {
      saveTriggers(id, extra.triggers);
    } else if (extra.schedule && extra.taskPrompt) {
      saveTriggers(id, [{
        id: "initial",
        type: "cron",
        enabled: true,
        cron: extra.schedule,
        description: displayName,
        prompt: extra.taskPrompt,
      }]);
    }

    this.agentConfigs.set(id, { config });
    startAgentProcess(config);

    // For orchestrator agents: scan the briefings directory and create a
    // disabled stub for each BP. Errors are non-fatal — the orchestrator
    // itself is already up; the user can retry the sync from the UI.
    let bpStubs = [];
    if (role === "orchestrator" && extra.briefingsPath) {
      try {
        bpStubs = await this.syncBpStubs(id);
      } catch (err) {
        console.error(`[Orchestrator] Stub sync failed for ${id}: ${err.message}`);
      }
    }

    return {
      id,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
      ...(role === "orchestrator" && { bpStubs: bpStubs.length }),
    };
  }

  // Add a new team-member to an existing team. The member is immediately
  // materialized (Matrix user + workspace + agent process).
  //
  // Without opts: member id auto-numbered (`{teamId}-1`, `{teamId}-2`, …),
  // prompt + skills inherited from the team / its env.
  //
  // With opts (used by the Team-Setup wizard):
  //   - id                  — pin the member id (`<teamId>-developer`, etc.)
  //   - displayName         — override the auto-generated `Team #n`
  //   - systemPromptOverride — role-specific prompt; member config records
  //                            it in `systemPrompt`. Absent = inherit team's
  //                            `systemPromptTemplate`.
  //   - skillsOverride      — replace env.skills for this member's workspace.
  //                            Absent = inherit env.skills.
  //   - mcpServersOverride  — replace env.mcpServers for this member. Same
  //                            shape as env.mcpServers ([{serverId, credentialId}]).
  //                            Absent = inherit env.mcpServers.
  //   - sessionPolicy       — `per-invocation` | `persistent` (default).
  //                            Persisted on the member config.
  //   - triggers            — full triggers.json array, written verbatim.
  async addTeamMember(teamId, opts = {}) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") {
      throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    }

    const env = loadEnvironment(teamCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${teamCfg.environmentId}' not found`);

    let memberId, memberDisplayName;
    if (opts.id) {
      if (loadAgentConfig(opts.id)) {
        throw new Error(`Agent '${opts.id}' already exists`);
      }
      memberId = opts.id;
      memberDisplayName = opts.displayName || opts.id;
    } else {
      // Determine next available member number and immediately reserve the
      // slot by writing a placeholder config. This prevents a TOCTOU race where
      // two concurrent POST /members requests both compute the same n before
      // either saveAgentConfig call runs.
      let n = 1;
      while (loadAgentConfig(`${teamId}-${n}`)) n++;
      memberId = `${teamId}-${n}`;
      // Auto-numbered fallback name. The parent team name is intentionally NOT
      // prepended — UIs group members under their team already, so a team
      // prefix would only duplicate the team name and bloat every label.
      memberDisplayName = opts.displayName || `Member #${n}`;
    }

    // A team-member inherits its parent team agent's owning (human) Team.
    const ownerTeamId = teamCfg.teamId || DEFAULT_TEAM_ID;

    // Deferred materialization: create the member as a STUB — config + triggers
    // only, no Matrix user, no workspace seed/clone, no process. Mirrors how an
    // orchestrator writes bp-instance stubs; enableAgent() does the full
    // provisioning (Matrix + clone + spawn) on first activation. Lets a large
    // process (dozens of members) be laid out without dozens of clones up front.
    if (opts.materialize === false) {
      const stubConfig = {
        id: memberId,
        displayName: memberDisplayName,
        role: "team-member",
        parentTeamId: teamId,
        environmentId: teamCfg.environmentId,
        teamId: ownerTeamId,
        ...(typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0
          ? { systemPrompt: opts.systemPromptOverride } : {}),
        ...(Array.isArray(opts.skillsOverride) ? { skillsOverride: opts.skillsOverride } : {}),
        ...(Array.isArray(opts.mcpServersOverride) ? { mcpServersOverride: opts.mcpServersOverride } : {}),
        ...(opts.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
        ...(opts.dataFlow && typeof opts.dataFlow === 'object' ? { dataFlow: opts.dataFlow } : {}),
        enabled: false, // no token → isStub; UI shows it, enableAgent materializes it
      };
      saveAgentConfig(memberId, stubConfig);
      // Pre-write triggers so the materialized agent has them immediately;
      // seedAgentWorkspace never touches triggers.json, so they survive.
      if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
        saveTriggers(memberId, opts.triggers);
      }
      this.agentConfigs.set(memberId, { config: stubConfig });
      console.log(`[Orchestrator] Created team-member STUB ${memberId} (team=${teamId}, deferred — not materialized)`);
      return { id: memberId, userId: null, stub: true, materialized: false, seeded: false, warnings: [] };
    }

    saveAgentConfig(memberId, {
      id: memberId,
      displayName: memberDisplayName,
      role: "team-member",
      parentTeamId: teamId,
      environmentId: teamCfg.environmentId,
      teamId: ownerTeamId,
      enabled: false,
      _provisioning: true,
    });

    const password = `agent-${memberId}-${Date.now()}`;
    const userId = `@${memberId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, memberId, password);
    const token = await loginMatrixUser(memberId, password);
    await setDisplayName(token, userId, memberDisplayName);

    const seedResult = seedAgentWorkspace(memberId, env, {
      teamId: ownerTeamId,
      skillsOverride: Array.isArray(opts.skillsOverride) ? opts.skillsOverride : undefined,
      mcpServersOverride: Array.isArray(opts.mcpServersOverride) ? opts.mcpServersOverride : undefined,
    });

    // Resolve effective values once, here. The member's config records ONLY
    // the override fields (when present); absence is the inherit signal that
    // team-edit propagation reads later.
    const effectivePrompt = (typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0)
      ? opts.systemPromptOverride
      : (teamCfg.systemPromptTemplate || "");

    const memberConfig = {
      id: memberId,
      displayName: memberDisplayName,
      userId,
      token,
      role: "team-member",
      parentTeamId: teamId,
      environmentId: teamCfg.environmentId,
      teamId: ownerTeamId,
      ...(typeof opts.systemPromptOverride === 'string' && opts.systemPromptOverride.length > 0
        ? { systemPrompt: opts.systemPromptOverride } : {}),
      ...(Array.isArray(opts.skillsOverride) ? { skillsOverride: opts.skillsOverride } : {}),
      ...(Array.isArray(opts.mcpServersOverride) ? { mcpServersOverride: opts.mcpServersOverride } : {}),
      ...(opts.sessionPolicy === 'per-invocation' ? { sessionPolicy: 'per-invocation' } : {}),
      // BP data-flow ports (#379) — recorded verbatim so the live process graph
      // renders this member's dependency/artifact edges. Runtime hand-offs are
      // driven by the push triggers, not this block.
      ...(opts.dataFlow && typeof opts.dataFlow === 'object' ? { dataFlow: opts.dataFlow } : {}),
      enabled: true,
    };
    saveAgentConfig(memberId, memberConfig);
    saveAgentPrompt(memberId, effectivePrompt, "team-member", env);

    if (Array.isArray(opts.triggers) && opts.triggers.length > 0) {
      saveTriggers(memberId, opts.triggers);
    }

    this.agentConfigs.set(memberId, { config: memberConfig });
    startAgentProcess(memberConfig);

    console.log(
      `[Orchestrator] Created team-member ${memberId} (team=${teamId}` +
      `${memberConfig.systemPrompt ? ', prompt=override' : ', prompt=inherit'}` +
      `${memberConfig.skillsOverride ? ', skills=override' : ', skills=inherit'}` +
      `${memberConfig.sessionPolicy ? `, session=${memberConfig.sessionPolicy}` : ''})`
    );
    return {
      id: memberId,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // Update a team's `systemPromptTemplate` and eagerly push the new value
  // to all members that inherit it (i.e. don't carry their own
  // `systemPrompt` override). Skill changes on the team's env are NOT
  // pushed — those wait for the next member rebuild (sync-on-restart).
  async updateTeamPrompt(teamId, newTemplate) {
    const teamCfg = loadAgentConfig(teamId);
    if (!teamCfg) throw new Error(`Team '${teamId}' not found`);
    if (teamCfg.role !== "team") {
      throw new Error(`Agent '${teamId}' is not a team (role=${teamCfg.role})`);
    }
    const env = loadEnvironment(teamCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${teamCfg.environmentId}' not found`);

    teamCfg.systemPromptTemplate = typeof newTemplate === 'string' ? newTemplate : '';
    saveAgentConfig(teamId, teamCfg);
    this.agentConfigs.set(teamId, { config: teamCfg });

    let propagated = 0;
    const reseeded = [];
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (!cfg || cfg.role !== "team-member" || cfg.parentTeamId !== teamId) continue;
      // Skip members with their own prompt override.
      if (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0) continue;
      saveAgentPrompt(id, teamCfg.systemPromptTemplate, "team-member", env);
      reseeded.push(id);
      propagated++;
    }
    // Under volume isolation each member reads CLAUDE.md / AGENT-PROMPT.md from
    // its own dedicated volume, not the pool subpath just rewritten above —
    // mirror both files into each running member's volume (#185 item 5). This
    // is the one orchestrator writer that edits ALREADY-RUNNING agents without a
    // respawn; every other saveAgentPrompt is followed by startAgentProcess, so
    // the one-time seed covers it. One helper per member (distinct volumes), run
    // concurrently to bound latency on large teams. No-op when the flag is off.
    if (PER_AGENT_VOLUME && reseeded.length > 0) {
      await Promise.all(reseeded.map(id =>
        reseedAgent(id, ['AGENT-PROMPT.md', 'CLAUDE.md'])));
    }
    console.log(
      `[Orchestrator] Team ${teamId} prompt updated; pushed to ${propagated} inheriting member(s)`
    );
    return { teamId, propagated };
  }

  // Scan an orchestrator agent's briefings directory and ensure a disabled
  // stub config exists for each BP. Returns the list of stub agent IDs that
  // are now present (both newly created and already existing).
  //
  // Stubs carry no Matrix identity, no token, and no seeded workspace —
  // those are materialized on first activation via enableAgent().
  //
  // Pulls the orchestrator's workspace clone first so the BP listing
  // reflects current `origin/main`. Without this, a stale local working
  // copy makes the user-initiated "Sync" button a no-op even when remote
  // has new BPs. Pass `{ force: true }` to bypass the per-orchestrator
  // pull throttle (used for explicit user actions).
  async syncBpStubs(orchestratorId, { force = false } = {}) {
    const orchCfg = loadAgentConfig(orchestratorId);
    if (!orchCfg) throw new Error(`Orchestrator '${orchestratorId}' not found`);
    if (orchCfg.role !== "orchestrator") {
      throw new Error(`Agent '${orchestratorId}' is not an orchestrator`);
    }
    if (!orchCfg.briefingsPath) {
      throw new Error(`Orchestrator '${orchestratorId}' has no briefingsPath configured`);
    }

    const env = loadEnvironment(orchCfg.environmentId);
    if (env) {
      pullOrchestratorWorkspace(orchestratorId, orchCfg.briefingsPath, env, { force });
    }

    // Pre-flight: the rest of the chain (pull + bp-explorer) silently
    // returns empty when the workspace clone is missing, which produces an
    // orchestrator with zero BP-instance stubs and no surfaced error. Fail
    // loudly here instead so the caller — create-agent, sync button, claim
    // tick — gets a clear message naming the missing path. The briefings
    // dir may be the repo root or a sub-directory of a cloned repo; we
    // accept either as long as some ancestor (up to the agent root) is a
    // git checkout.
    const rel = orchCfg.briefingsPath.replace(/^\/+|\/+$/g, "");
    const agentRoot = path.join(AGENTS_DIR, orchestratorId);
    const workspace = path.join(agentRoot, rel);
    if (!fs.existsSync(workspace) || !findEnclosingGitRepo(workspace, agentRoot)) {
      const err = new Error(
        `No enclosing git checkout found below ${agentRoot} for briefings workspace ${workspace} ` +
        `(briefingsPath='${orchCfg.briefingsPath}'). Likely cause: the env's ` +
        `repository clone failed during agent seeding — check the orchestrator ` +
        `log for 'Seed warning' entries.`
      );
      err.code = "WORKSPACE_NO_GIT";
      throw err;
    }

    const bps = await fetchBriefingPacks(orchestratorId, orchCfg.briefingsPath);
    const present = [];
    let created = 0;

    for (const bp of bps) {
      if (!bp || !bp.id) continue;
      const stubId = bpInstanceAgentId(bp);
      present.push(stubId);
      const existing = loadAgentConfig(stubId);
      if (existing) {
        // Backfill bpRelPath onto legacy stubs that pre-date hierarchical
        // support so the prompt and claim flow find the brief.md correctly.
        if (bp._rel_path && existing.bpRelPath !== bp._rel_path) {
          const updated = { ...existing, bpRelPath: bp._rel_path };
          saveAgentConfig(stubId, updated);
          this.agentConfigs.set(stubId, { config: updated });
        }
        continue;
      }

      const stubConfig = {
        id: stubId,
        displayName: bpInstanceDisplayName(bp, stubId),
        role: "bp-instance",
        parentOrchestratorId: orchestratorId,
        bpId: bp.id,
        ...(bp.slug && { bpSlug: bp.slug }),
        ...(bp._rel_path && { bpRelPath: bp._rel_path }),
        // Inherited from the orchestrator so the bp-instance prompt can
        // construct an exact filesystem path to its brief.md.
        briefingsPath: orchCfg.briefingsPath,
        environmentId: orchCfg.environmentId,
        teamId: orchCfg.teamId || DEFAULT_TEAM_ID,
        enabled: false,
      };
      saveAgentConfig(stubId, stubConfig);
      this.agentConfigs.set(stubId, { config: stubConfig });
      created += 1;
    }

    if (created > 0) {
      console.log(
        `[Orchestrator] BP stubs synced for ${orchestratorId}: ${created} new, ${present.length} total`
      );
    }
    return present;
  }

  // One iteration of the claim loop. Pulls main (60s throttled), re-syncs
  // BP stubs for any new BPs, and detects which dispatched BPs are
  // newly-actionable since the last tick. Returns the deltas — actually
  // posting the suggestion DM and performing the claim happen elsewhere
  // (the agent-runner reads the response and drives a Claude invocation
  // per newly-dispatched BP).
  //
  // Called periodically by the orchestrator's own agent-runner process via
  // POST /internal/orchestrators/:id/claim-tick. Manual UI activations
  // (Activate / Deactivate) and direct user-driven claims via the chat
  // bypass this loop.
  async runClaimTick(orchestratorId) {
    const orchCfg = loadAgentConfig(orchestratorId);
    if (!orchCfg) throw new Error(`Orchestrator '${orchestratorId}' not found`);
    if (orchCfg.role !== "orchestrator") {
      throw new Error(`Agent '${orchestratorId}' is not an orchestrator`);
    }
    if (!orchCfg.token) return { skipped: "orchestrator-not-materialized" };
    if (!orchCfg.briefingsPath) return { skipped: "no-briefings-path" };

    // Pull main from origin (throttled). Failures are logged but never throw.
    const env = loadEnvironment(orchCfg.environmentId);
    if (env) pullOrchestratorWorkspace(orchestratorId, orchCfg.briefingsPath, env);

    // Mirrors the pre-flight in syncBpStubs: without a workspace clone there
    // is nothing for bp-explorer to scan. The 30s claim loop hits this path
    // repeatedly, so log once and return a structured skip rather than
    // pretending the orchestrator is healthy (zero BPs, no error). Any
    // ancestor up to the agent root is acceptable — the briefings dir may
    // sit beneath the repo root.
    const rel = orchCfg.briefingsPath.replace(/^\/+|\/+$/g, "");
    const agentRoot = path.join(AGENTS_DIR, orchestratorId);
    const workspace = path.join(agentRoot, rel);
    if (!fs.existsSync(workspace) || !findEnclosingGitRepo(workspace, agentRoot)) {
      // `pullOrchestratorWorkspace` already logged this above (throttled).
      // Just return the structured skip so callers can see the cause.
      return { skipped: "workspace-not-cloned", path: workspace };
    }

    const bps = await fetchBriefingPacks(orchestratorId, orchCfg.briefingsPath);

    // Lazy-create stubs for any BPs we haven't seen before, and backfill
    // bpRelPath onto legacy stubs that pre-date hierarchical support.
    let newStubs = 0;
    for (const bp of bps) {
      if (!bp || !bp.id) continue;
      const stubId = bpInstanceAgentId(bp);
      const existing = loadAgentConfig(stubId);
      if (existing) {
        if (bp._rel_path && existing.bpRelPath !== bp._rel_path) {
          const updated = { ...existing, bpRelPath: bp._rel_path };
          saveAgentConfig(stubId, updated);
          this.agentConfigs.set(stubId, { config: updated });
        }
        continue;
      }
      const stubConfig = {
        id: stubId,
        displayName: bpInstanceDisplayName(bp, stubId),
        role: "bp-instance",
        parentOrchestratorId: orchestratorId,
        bpId: bp.id,
        ...(bp.slug && { bpSlug: bp.slug }),
        ...(bp._rel_path && { bpRelPath: bp._rel_path }),
        briefingsPath: orchCfg.briefingsPath,
        environmentId: orchCfg.environmentId,
        teamId: orchCfg.teamId || DEFAULT_TEAM_ID,
        enabled: false,
      };
      saveAgentConfig(stubId, stubConfig);
      this.agentConfigs.set(stubId, { config: stubConfig });
      newStubs += 1;
    }

    // Detect newly-dispatched BPs by diffing against the persistent
    // notified-set. A BP only enters the suggestion stream once per
    // dispatch; if its status flips away from 'dispatched' it gets
    // removed from the set and a future re-dispatch will re-trigger.
    const state = loadClaimState(orchestratorId);
    const previouslyNotified = new Set(state.notified || []);
    const dispatchedNow = new Set();
    const newlyDispatched = [];

    for (const bp of bps) {
      if (!bp || !bp.id) continue;
      if (bp.status !== "dispatched") continue;
      dispatchedNow.add(bp.id);

      const stubId = bpInstanceAgentId(bp);
      const stubCfg = loadAgentConfig(stubId);
      // If the stub is already materialised (token present), it has already
      // been claimed (manually or otherwise) — don't re-suggest.
      if (stubCfg && stubCfg.token) continue;
      if (previouslyNotified.has(bp.id)) continue;

      newlyDispatched.push({
        bpId: bp.id,
        bpSlug: bp.slug || "",
        bpTitle: bp.title || bp.slug || bp.id,
        stubId,
      });
    }

    // Notified-set update: keep only currently-dispatched BPs (auto-cleanup
    // when status flips back), plus the new ones we just surfaced.
    const updatedNotified = new Set(
      [...previouslyNotified].filter((id) => dispatchedNow.has(id))
    );
    for (const item of newlyDispatched) updatedNotified.add(item.bpId);
    if (
      updatedNotified.size !== previouslyNotified.size ||
      [...updatedNotified].some((id) => !previouslyNotified.has(id))
    ) {
      saveClaimState(orchestratorId, { notified: [...updatedNotified] });
    }

    if (newStubs || newlyDispatched.length) {
      console.log(
        `[Orchestrator] Claim tick for ${orchestratorId}: ` +
        `${newStubs} new stub${newStubs === 1 ? "" : "s"}, ` +
        `${newlyDispatched.length} newly dispatched`
      );
    }
    return { newStubs, newlyDispatched };
  }

  // Route a batch of BP events to the affected bp-instance stubs and the
  // hosting orchestrator. The signaling agent does NOT do reverse-dep
  // lookups itself — it just announces "I changed BP X". This method:
  //
  //   1. Finds which orchestrator hosts each event's BP (via the
  //      bp-instance stub's parentOrchestratorId).
  //   2. Reads that orchestrator's .index.json for graph + artifact data.
  //   3. Computes affected BPs (depends-on dependents + input-artifact
  //      dependents).
  //   4. For each affected BP, locates the bp-instance stub.
  //   5. Applies the agent's bp-trigger-policy:
  //        - off                 → skip
  //        - notify-only         → enqueue only if process is running
  //        - notify-on-activate  → enable (materialize stub) + enqueue
  //   6. Notifies the hosting orchestrator separately for awareness.
  //
  // Inputs:  { source: "<id>", events: [{ type, bp, details? }, ...] }
  // Returns: { ok, routed: [...], skipped: [...] }
  async routeBpEvents(payload) {
    const { source: rawSource, events } = payload || {};
    if (!Array.isArray(events) || events.length === 0) {
      return { ok: true, routed: [], skipped: [], message: "no events" };
    }

    // The source field flows verbatim into a Claude prompt downstream.
    // /internal/bp-events is container-internal but we still strip to a
    // narrow charset + length so a malformed/hostile signaler can't inject
    // newlines or control characters into the agent's prompt context.
    const source = typeof rawSource === "string"
      ? rawSource.slice(0, 200).replace(/[^\w@./:+-]/g, "")
      : "";

    // Sanitize and deduplicate events on (type, bp)
    const seen = new Set();
    const cleanEvents = [];
    for (const e of events) {
      if (!e || typeof e.type !== "string" || typeof e.bp !== "string") continue;
      if (!/^[0-9a-f]{12}$/.test(e.bp)) continue;
      const key = `${e.type}|${e.bp}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cleanEvents.push({ type: e.type, bp: e.bp, details: e.details || {} });
    }
    if (cleanEvents.length === 0) {
      return { ok: true, routed: [], skipped: [], message: "no valid events" };
    }

    // Build a one-shot reverse index: bpId → owning orchestrator + stub id.
    // listAgentIds() can be in the hundreds; doing this once per call beats
    // doing it once per event.
    const bpHashToStub = new Map();
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg?.role === "bp-instance" && typeof cfg.bpId === "string") {
        bpHashToStub.set(cfg.bpId, { stubId: id, parentOrchestratorId: cfg.parentOrchestratorId });
      }
    }

    // Group events by hosting orchestrator. Skip events whose BP we don't know.
    const byOrchestrator = new Map(); // orchId → { events, orchCfg }
    const skipped = [];

    for (const ev of cleanEvents) {
      const stubInfo = bpHashToStub.get(ev.bp);
      if (!stubInfo) {
        skipped.push({ event: ev, reason: "unknown-bp" });
        continue;
      }
      const orchId = stubInfo.parentOrchestratorId;
      if (!orchId) {
        skipped.push({ event: ev, reason: "stub-has-no-parent-orchestrator" });
        continue;
      }
      let bucket = byOrchestrator.get(orchId);
      if (!bucket) {
        const orchCfg = loadAgentConfig(orchId);
        bucket = { events: [], orchCfg };
        byOrchestrator.set(orchId, bucket);
      }
      bucket.events.push(ev);
    }

    const routed = [];

    for (const [orchId, { events: orchEvents, orchCfg }] of byOrchestrator) {
      if (!orchCfg) {
        for (const ev of orchEvents) skipped.push({ event: ev, reason: "orchestrator-not-found" });
        continue;
      }

      // Force-pull the orchestrator's briefings clone first so a signal from
      // a just-pushed agent isn't routed against a stale local copy. Pull
      // failures are non-fatal — we fall back to whatever is currently on
      // disk. Forced pulls still coalesce within _PULL_FORCE_THROTTLE_MS so a
      // burst of bp-events from several agents in quick succession doesn't
      // multiply git operations. bp-explorer reads from the same clone, so
      // the freshly-pulled brief.md files are what feed the graph below.
      const briefingsPath = (orchCfg.briefingsPath || "").replace(/^\/+|\/+$/g, "");
      const env = loadEnvironment(orchCfg.environmentId);
      if (env) {
        pullOrchestratorWorkspace(orchId, briefingsPath, env, { force: true });
      }

      let briefings;
      try {
        briefings = await loadBriefingsGraphFromExplorer(orchId, briefingsPath);
      } catch (err) {
        console.warn(`[Orchestrator] BP-events: cannot load briefings graph for ${orchId}: ${err.message}`);
        for (const ev of orchEvents) {
          skipped.push({ event: ev, reason: "index-unavailable", detail: err.message });
        }
        continue;
      }

      const { perAffectedBp, unknownSources } = bpEventRouter.batchEventsByAffected(
        orchEvents,
        (bpHash) => bpEventRouter.findAffectedBps(briefings, bpHash),
      );
      for (const src of unknownSources) {
        skipped.push({ event: { bp: src }, reason: "source-not-in-index" });
      }

      // Build fan-out targets: every affected bp-instance, plus the
      // orchestrator itself for awareness (only when we routed something).
      // For each affected leaf, classify the situation so the receiving
      // agent can pick the right prompt:
      //   - "kickoff"       — affected BP is `ready` and all its depends-on
      //                       are now `completed`/`reviewed` (first run)
      //   - "cascade-stale" — affected BP was already `completed`/`reviewed`/
      //                       `stale` and is now potentially invalidated
      //   - "other"         — fallback (e.g. `dispatched`/`claimed` already)
      const classifySituation = (bpHash) => {
        const entry = briefings[bpHash] || {};
        const status = entry.status || "unknown";
        const deps = Array.isArray(entry["depends-on"]) ? entry["depends-on"] : [];
        const allDepsMet = deps.every((d) => {
          const e = briefings[d];
          return e && (e.status === "completed" || e.status === "reviewed");
        });
        if (status === "ready" && allDepsMet) return { situation: "kickoff", status };
        if (["completed", "reviewed", "stale"].includes(status)) {
          return { situation: "cascade-stale", status };
        }
        return { situation: "other", status };
      };
      const targets = [];
      for (const [affectedBp, reasons] of perAffectedBp) {
        const dst = bpHashToStub.get(affectedBp);
        if (!dst) {
          skipped.push({ bp: affectedBp, reason: "no-stub-for-affected-bp" });
          continue;
        }
        const { situation, status: affectedBpStatus } = classifySituation(affectedBp);
        targets.push({
          agentId: dst.stubId,
          role: "bp-instance",
          affectedBp,
          affectedBpStatus,
          situation,
          reasons,
        });
      }
      if (perAffectedBp.size > 0) {
        targets.push({
          agentId: orchId,
          role: "orchestrator",
          affectedBp: null,
          reasons: [...perAffectedBp.entries()].map(([bp, rs]) => {
            const { situation } = classifySituation(bp);
            return { kind: "downstream-affected", bp, situation, reasons: rs };
          }),
        });
      }

      // Apply policy + execute in parallel. Promise.allSettled so one bad
      // target doesn't sink the rest.
      const results = await Promise.allSettled(
        targets.map((t) => this._applyBpTriggerPolicy(t, source))
      );
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") routed.push(r.value);
        else routed.push({
          agentId: targets[i].agentId,
          action: "error",
          error: r.reason?.message || String(r.reason),
        });
      }
    }

    return { ok: true, source: source || null, routed, skipped };
  }

  // Apply a single agent's bp-trigger-policy to a fan-out target. Decides
  // whether to enable+enqueue, enqueue-only, or skip. Always idempotent —
  // multiple events for the same agent just append to pending-triggers.
  async _applyBpTriggerPolicy(target, source) {
    const cfg = loadAgentConfig(target.agentId);
    if (!cfg) {
      return { agentId: target.agentId, action: "skipped", reason: "agent-not-found" };
    }
    const policy = cfg["bp-trigger-policy"] || {};
    const mode = policy.mode || "notify-on-activate";
    // Default true: a manually-disabled agent should not be auto-respawned by
    // BP events. Operators who want the old "always respawn" behaviour can set
    // "respect-manual-disable": false explicitly in the agent's config.json.
    const respectManualDisable = policy["respect-manual-disable"] !== false;

    if (mode === "off") {
      return { agentId: target.agentId, action: "skipped", reason: "policy-off" };
    }

    const isStub = !cfg.token;
    const wasManuallyDisabled = !isStub && cfg.enabled === false;

    if (mode === "notify-only") {
      const proc = agentProcesses.get(target.agentId);
      if (!proc || proc.exitCode != null || proc.killed) {
        return { agentId: target.agentId, action: "skipped", reason: "notify-only-and-not-running" };
      }
    } else {
      // notify-on-activate (default): materialize stubs + respawn disabled
      if (wasManuallyDisabled && respectManualDisable) {
        return { agentId: target.agentId, action: "skipped", reason: "manually-disabled" };
      }
      try {
        await this.enableAgent(target.agentId);
      } catch (err) {
        return { agentId: target.agentId, action: "enable-failed", error: err.message };
      }
    }

    enqueueBpEventBatch(target.agentId, {
      source: source || "unknown",
      role: target.role,
      affectedBp: target.affectedBp,
      affectedBpStatus: target.affectedBpStatus,
      situation: target.situation,
      reasons: target.reasons,
    });

    return {
      agentId: target.agentId,
      action: "enqueued",
      role: target.role,
      affectedBp: target.affectedBp,
      situation: target.situation,
      materialized: isStub && mode !== "notify-only",
    };
  }

  // Compute hand-off candidates for a bp-instance source agent.
  // Returns:
  //   {
  //     source: { agentId, bpId, displayName, parentOrchestratorId, briefingsPath },
  //     suggested: [{ agentId, displayName, role, materialized, reason, paths? }, ...],
  //     siblings:  [{ agentId, displayName, role, materialized }, ...]   // all bp-instance siblings under the same parent orchestrator (excluding source)
  //   }
  // `suggested` derives from the briefings graph that bp-explorer parses out
  // of each brief.md frontmatter — same depends-on / input-artifact edges the
  // legacy bp-event router used. `siblings` lets the user pick targets the
  // graph doesn't know about. The two lists may overlap (every suggested
  // entry also appears in siblings).
  async handoverCandidates(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.role !== "bp-instance") {
      throw new Error(`Agent '${id}' is not a bp-instance (role=${cfg.role})`);
    }
    const parentId = cfg.parentOrchestratorId;
    if (!parentId) throw new Error(`bp-instance '${id}' has no parentOrchestratorId`);
    const orchCfg = loadAgentConfig(parentId);
    if (!orchCfg) throw new Error(`Parent orchestrator '${parentId}' not found`);

    const source = {
      agentId: id,
      bpId: cfg.bpId || null,
      displayName: cfg.displayName || id,
      parentOrchestratorId: parentId,
      briefingsPath: orchCfg.briefingsPath || null,
    };

    // Reverse index: bpId → stubInfo, restricted to stubs sharing the same parent.
    const bpHashToStub = new Map();
    const siblings = [];
    for (const otherId of listAgentIds()) {
      if (otherId === id) continue;
      const otherCfg = loadAgentConfig(otherId);
      if (!otherCfg) continue;
      if (otherCfg.role !== "bp-instance") continue;
      if (otherCfg.parentOrchestratorId !== parentId) continue;
      siblings.push({
        agentId: otherId,
        displayName: otherCfg.displayName || otherId,
        role: "bp-instance",
        materialized: Boolean(otherCfg.token),
        bpId: otherCfg.bpId || null,
      });
      if (otherCfg.bpId) bpHashToStub.set(otherCfg.bpId, otherId);
    }

    let suggested = [];
    if (cfg.bpId) {
      try {
        const briefings = await loadBriefingsGraphFromExplorer(parentId, orchCfg.briefingsPath);
        const affected = bpEventRouter.findAffectedBps(briefings, cfg.bpId);
        for (const depBp of affected.dependsOn) {
          const targetId = bpHashToStub.get(depBp);
          if (!targetId) continue;
          const sibling = siblings.find((s) => s.agentId === targetId);
          suggested.push({
            agentId: targetId,
            displayName: sibling?.displayName || targetId,
            role: "bp-instance",
            materialized: Boolean(sibling?.materialized),
            reason: "depends-on",
          });
        }
        for (const ia of affected.inputArtifact) {
          const targetId = bpHashToStub.get(ia.bp);
          if (!targetId) continue;
          // If already covered by depends-on, skip — depends-on is a stronger signal.
          if (suggested.some((s) => s.agentId === targetId)) continue;
          const sibling = siblings.find((s) => s.agentId === targetId);
          suggested.push({
            agentId: targetId,
            displayName: sibling?.displayName || targetId,
            role: "bp-instance",
            materialized: Boolean(sibling?.materialized),
            reason: "input-artifact",
            paths: ia.paths,
          });
        }
      } catch (err) {
        // bp-explorer unavailable or briefings unreadable — degrade to
        // "siblings only" so the user can still pick a target manually.
        console.warn(`[Orchestrator] handoverCandidates: cannot load briefings graph for ${parentId}: ${err.message}`);
      }
    }

    return { source, suggested, siblings };
  }

  // Materialize a stub bp-instance agent (or re-enable a previously-active
  // one). Idempotent: a stub gets full provisioning on the first call;
  // subsequent calls just (re)spawn the agent-runner process.
  async enableAgent(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

    // Already-materialized agents: just flip enabled and respawn.
    if (cfg.token) {
      const updated = { ...cfg, enabled: true };
      saveAgentConfig(id, updated);
      this.agentConfigs.set(id, { config: updated });
      // Under volume isolation a previously-disabled agent keeps its dedicated
      // volume, and seedPerAgentVolume only copies into an EMPTY /dst — so a
      // prompt/skill edit made WHILE the agent was disabled (which reseedAgent
      // skipped as 'not-running') would otherwise be lost on this fast-path
      // respawn. Mirror the control-plane file set from the pool subpath now,
      // before the container starts; copying only these named paths preserves
      // agent-written memory/, .claude/projects, the git tree, and sessions/.
      // No-op when the dedicated volume is absent (#185 item 5).
      if (PER_AGENT_VOLUME) {
        await reseedPerAgentVolume(
          id, ['CLAUDE.md', 'AGENT-PROMPT.md', '.claude/settings.json', 'skills'],
        ).catch(err => console.warn(`[Orchestrator] re-enable reseed ${id}: ${err.message}`));
      }
      startAgentProcess(updated);
      return { id, materialized: false, enabled: true };
    }

    // Stub: full materialization.
    if (cfg.role !== "bp-instance" && cfg.role !== "team-member") {
      throw new Error(`Agent '${id}' is a stub but has unexpected role '${cfg.role}'`);
    }
    const env = loadEnvironment(cfg.environmentId);
    if (!env) throw new Error(`Working Environment '${cfg.environmentId}' not found`);

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);
    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, cfg.displayName);

    const seedResult = seedAgentWorkspace(id, env, {
      teamId: cfg.teamId || DEFAULT_TEAM_ID,
      skillsOverride: Array.isArray(cfg.skillsOverride) ? cfg.skillsOverride : undefined,
      mcpServersOverride: Array.isArray(cfg.mcpServersOverride) ? cfg.mcpServersOverride : undefined,
    });

    // bp-instance agents always need the ACE engineering skill — the env's
    // skills array is overridden here so the agent can actually execute the
    // BP regardless of how the user configured the Working Environment.
    if (cfg.role === "bp-instance") ensureEngineeringSkill(id);

    const updated = {
      ...cfg,
      userId,
      token,
      enabled: true,
    };
    saveAgentConfig(id, updated);

    if (cfg.role === "bp-instance") {
      // Always (re)write the BP-instance prompt — the path / skill reference
      // depends on cfg fields (bpId, bpSlug, briefingsPath) that are stable
      // for this stub, and we want a consistent prompt across reactivations.
      saveAgentPrompt(id, bpInstanceSystemPrompt(updated), "bp-instance", env);
      console.log(`[Orchestrator] Materialized bp-instance ${id} (parent=${cfg.parentOrchestratorId}, bp=${cfg.bpId})`);
    } else {
      // team-member: prefer the member's own systemPrompt override (recorded on
      // a deferred-materialization stub, or any inherit/override member). Only
      // fall back to the parent team template when the member has no override —
      // this is the inherit signal.
      let prompt = (typeof cfg.systemPrompt === 'string' && cfg.systemPrompt.length > 0) ? cfg.systemPrompt : '';
      if (!prompt) {
        const teamCfg = cfg.parentTeamId ? loadAgentConfig(cfg.parentTeamId) : null;
        if (!teamCfg) {
          console.warn(`[Orchestrator] team-member ${id}: parent team '${cfg.parentTeamId}' not found — reactivating with empty system prompt`);
        }
        prompt = teamCfg?.systemPromptTemplate || "";
      }
      saveAgentPrompt(id, prompt, "team-member", env);
      console.log(`[Orchestrator] Materialized team-member ${id} (team=${cfg.parentTeamId}, prompt=${cfg.systemPrompt ? 'override' : 'inherit'})`);
    }

    this.agentConfigs.set(id, { config: updated });
    startAgentProcess(updated);
    return {
      id,
      materialized: true,
      enabled: true,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // Disable an agent: mark enabled=false and (depending on mode) stop its
  // process. Keeps token and workspace intact so it can be re-enabled.
  //
  // mode === undefined → if the agent is running and has active triggers or a
  //   busy session, return a warning object instead of disabling. The caller
  //   (admin-console UI) must re-call with an explicit mode.
  // mode === 'drain'  → write enabled=false immediately so no new trigger
  //   executions start, but leave the process running to let the current
  //   invocation finish naturally.
  // mode === 'abort'  → write enabled=false and kill the process right away.
  async disableAgent(id, { mode } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

    const isRunning = agentProcesses.has(id);

    if (!mode && isRunning) {
      // Check for active state before disabling without an explicit mode.
      let isBusy = false;
      try {
        const status = JSON.parse(
          fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
        );
        isBusy = status?.state === 'busy';
      } catch { /* no status file = idle */ }

      let activeTriggers = [];
      try {
        const triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
        if (Array.isArray(triggers)) {
          activeTriggers = triggers
            .filter(t => t.enabled !== false && t.id)
            .map(t => ({ id: t.id, type: t.type, description: t.description || null }));
        }
      } catch { /* no triggers file */ }

      if (isBusy || activeTriggers.length > 0) {
        return {
          id,
          warning: true,
          busy: isBusy,
          activeTriggers,
        };
      }
    }

    // Write enabled=false first so drain mode takes effect immediately:
    // TriggerScheduler.execute() re-reads config.json on every trigger tick
    // and will skip new executions as soon as this write lands.
    const updated = { ...cfg, enabled: false };
    saveAgentConfig(id, updated);
    this.agentConfigs.set(id, { config: updated });

    if (mode !== 'drain') {
      // abort mode (or no active state needing drain) — kill process now.
      stopAgentProcess(id);
    }

    return { id, enabled: false };
  }

  // Reset an agent back to its stub state: stop the process, deactivate the
  // Matrix user (best-effort), wipe the workspace, and strip the config of
  // any runtime identity (token, userId). The stub config keeps just the
  // metadata needed to re-activate later.
  //
  // Destructive — caller is expected to have confirmed with the user.
  //
  // mode === undefined → if the agent is running and has active triggers or a
  //   busy session, return a warning object (HTTP 409) so the caller can ask
  //   the user to choose drain or abort before proceeding.
  // mode === 'drain' → disable triggers and set enabled=false immediately
  //   (no new executions start), but leave the process running and defer the
  //   workspace wipe. The agent appears as "disabled" until the operator
  //   deactivates again once idle.
  // mode === 'hard-stop' → stop the process right away and wipe (original
  //   behaviour).
  async deactivateAgent(id, { mode } = {}) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

    const isRunning = agentProcesses.has(id);

    // Pre-flight: when no mode is given and the process is running, check for
    // active state and surface it as a warning so the UI can ask the user.
    if (!mode && isRunning) {
      let isBusy = false;
      try {
        const status = JSON.parse(
          fs.readFileSync(agentStatePath(id, 'status.json'), 'utf8'), // control-plane copy preferred (#185)
        );
        isBusy = status?.state === 'busy';
      } catch { /* no status file = idle */ }

      let activeTriggers = [];
      try {
        const triggers = loadTriggers(id); // canonical copy (#185 Phase 2)
        if (Array.isArray(triggers)) {
          activeTriggers = triggers
            .filter(t => t.enabled !== false && t.id)
            .map(t => ({ id: t.id, type: t.type, description: t.description || null }));
        }
      } catch { /* no triggers file */ }

      if (isBusy || activeTriggers.length > 0) {
        return { id, warning: true, busy: isBusy, activeTriggers };
      }
    }

    // Drain mode: disable the agent in place (no wipe). The caller should
    // re-invoke with hard-stop once the agent goes idle.
    if (mode === 'drain') {
      return this.disableAgent(id, { mode: 'drain' });
    }

    stopAgentProcess(id);

    if (cfg.userId || cfg.token) {
      // Best-effort — we don't want to fail the reset if the admin client
      // or Conduwuit is unavailable; the local config wipe is what matters.
      await this.deactivateMatrixUser(id);
    }

    // Wipe the workspace except for config.json so the next activation seeds
    // a fresh repo + skills + memory copy.
    const dir = agentDir(id);
    if (fs.existsSync(dir)) {
      for (const entry of fs.readdirSync(dir)) {
        if (entry === "config.json") continue;
        try {
          fs.rmSync(path.join(dir, entry), { recursive: true, force: true });
        } catch (err) {
          console.error(`[Orchestrator] Could not remove ${entry} from ${id}: ${err.message}`);
        }
      }
    }

    // Remove the dedicated volume too (#185 item 6). Required, not just tidy:
    // seedPerAgentVolume only copies into an EMPTY /dst, so leaving the volume
    // in place would make a later reactivation run against stale state instead
    // of re-seeding the freshly-wiped pool subpath above.
    if (PER_AGENT_VOLUME) {
      await removePerAgentVolume(id).catch(err =>
        console.warn(`[Orchestrator] volume teardown ${id}: ${err.message}`));
    }

    // Strip runtime identity. Keep id, displayName, role, environmentId, and
    // role-specific metadata (briefingsPath / parentOrchestratorId / bpId /
    // bpSlug). Drop token, userId. Mark disabled.
    const stripped = {
      id: cfg.id,
      displayName: cfg.displayName,
      role: cfg.role,
      environmentId: cfg.environmentId,
      ...(cfg.briefingsPath && { briefingsPath: cfg.briefingsPath }),
      ...(cfg.parentOrchestratorId && { parentOrchestratorId: cfg.parentOrchestratorId }),
      ...(cfg.parentTeamId && { parentTeamId: cfg.parentTeamId }),
      ...(cfg.bpId && { bpId: cfg.bpId }),
      ...(cfg.bpSlug && { bpSlug: cfg.bpSlug }),
      ...(cfg.bpRelPath && { bpRelPath: cfg.bpRelPath }),
      ...(cfg.blueprintId && { blueprintId: cfg.blueprintId }),
      enabled: false,
    };
    saveAgentConfig(id, stripped);
    this.agentConfigs.set(id, { config: stripped });

    console.log(`[Orchestrator] Reset ${id} to stub state`);
    return { id, reset: true };
  }

  // Claim a bp-instance: write status='claimed' + agent-id + timestamp to
  // the BP's brief.md (in the parent orchestrator's workspace clone),
  // commit, push to origin, then materialise the stub via enableAgent.
  //
  // On push failure (typically non-fast-forward — a teammate claimed first)
  // the local commit is rolled back and the call throws. The stub stays
  // unmaterialised so the user sees the failure, can pull, and retry.
  async claimAgent(stubId) {
    const cfg = loadAgentConfig(stubId);
    if (!cfg) throw new Error(`Agent '${stubId}' not found`);
    if (cfg.role !== "bp-instance") {
      throw new Error(`Agent '${stubId}' is not a bp-instance (role=${cfg.role})`);
    }
    if (cfg.token) {
      // Already claimed and materialised. Idempotent — return current state
      // rather than re-running the git operations.
      return { id: stubId, alreadyClaimed: true };
    }

    const orchId = cfg.parentOrchestratorId;
    if (!orchId) throw new Error(`Agent '${stubId}' has no parent orchestrator`);
    const orchCfg = loadAgentConfig(orchId);
    if (!orchCfg) throw new Error(`Parent orchestrator '${orchId}' not found`);
    const env = loadEnvironment(orchCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${orchCfg.environmentId}' not found`);
    if (!orchCfg.briefingsPath) {
      throw new Error(`Parent orchestrator '${orchId}' has no briefingsPath`);
    }

    const orchWorkspace = path.join(
      "/workspace/agents",
      orchId,
      orchCfg.briefingsPath.replace(/^\/+|\/+$/g, "")
    );
    const briefRel = bpInstanceBriefRelPath(cfg);
    const briefAbs = path.join(orchWorkspace, briefRel);

    if (!fs.existsSync(briefAbs)) {
      throw new Error(`brief.md not found at ${briefAbs}`);
    }

    const original = fs.readFileSync(briefAbs, "utf8");
    const patched = patchBriefForClaim(original, stubId);
    if (patched !== original) {
      fs.writeFileSync(briefAbs, patched);
    }

    // git add + commit + push, with rollback on push failure
    const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
    const sshCmd = buildGitSshCommand(env);
    if (sshCmd) gitEnv.GIT_SSH_COMMAND = sshCmd;

    const runGit = (args, timeoutMs = 15_000) =>
      execFileSync("git", args, {
        cwd: orchWorkspace, env: gitEnv, stdio: "pipe", timeout: timeoutMs,
      });

    let didCommit = false;
    try {
      runGit(["add", briefRel]);
      // Skip commit if nothing actually changed (e.g. brief was already in claim shape)
      let hasChanges = true;
      try {
        runGit(["diff", "--cached", "--quiet"]);
        hasChanges = false;
      } catch { hasChanges = true; }

      if (hasChanges) {
        runGit([
          "-c", "user.name=Orchestrator",
          "-c", "user.email=orchestrator@e-vgh-claw.local",
          "commit",
          "-m", `[claim] BP ${cfg.bpSlug || cfg.bpId} by ${stubId}`,
        ]);
        didCommit = true;
        try {
          runGit(["push", "origin", "HEAD"], 30_000);
        } catch (pushErr) {
          // Push failed — most likely non-fast-forward. Roll back our local
          // commit so the workspace is clean for the next pull/retry, and
          // surface a friendly error.
          try { runGit(["reset", "--hard", "HEAD~1"]); } catch { /* best effort */ }
          const detail = (pushErr.stderr || pushErr.stdout || pushErr.message || "")
            .toString().trim().slice(0, 200);
          throw new Error(
            `Push failed (a teammate may have claimed this BP first): ${detail}`
          );
        }
      }
    } catch (err) {
      if (didCommit && /Push failed/.test(err.message)) throw err;
      // Pre-commit failures: restore brief.md so we don't leave it dirty
      try { fs.writeFileSync(briefAbs, original); } catch { /* best effort */ }
      const detail = (err.stderr || err.message || "").toString().trim().slice(0, 200);
      throw new Error(`Git operation failed: ${detail}`);
    }

    // Brief is now committed + pushed. Materialise the stub.
    const enableResult = await this.enableAgent(stubId);

    // Drop this BP from the notified-set so a future re-dispatch (if it ever
    // happens) gets surfaced again.
    const state = loadClaimState(orchId);
    const notified = new Set(state.notified || []);
    if (notified.delete(cfg.bpId)) {
      saveClaimState(orchId, { notified: [...notified] });
    }

    console.log(`[Orchestrator] Claimed ${stubId} (bp=${cfg.bpId})`);
    return { id: stubId, claimed: true, ...enableResult };
  }

  // Materialize an existing config-only orchestrator agent (created before
  // the orchestrator role gained Matrix identity). Idempotent — if the
  // config already has a token, this is a no-op. Errors are thrown so the
  // caller can decide whether to abort or continue.
  async materializeOrchestrator(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    if (cfg.role !== "orchestrator") throw new Error(`Agent '${id}' is not an orchestrator`);
    if (cfg.token) return cfg; // already materialized

    const env = loadEnvironment(cfg.environmentId);
    if (!env) throw new Error(`Working Environment '${cfg.environmentId}' not found`);

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);
    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, cfg.displayName);

    // Workspace was already seeded at config-create time; no second seed.
    const updated = { ...cfg, userId, token, enabled: true };
    saveAgentConfig(id, updated);

    // If AGENT-PROMPT.md is missing (config-only created without it), write a default.
    const promptPath = path.join(agentDir(id), "AGENT-PROMPT.md");
    if (!fs.existsSync(promptPath)) {
      saveAgentPrompt(id, defaultSystemPromptFor("orchestrator", { briefingsPath: cfg.briefingsPath }), "orchestrator", env);
    }

    this.agentConfigs.set(id, { config: updated });
    startAgentProcess(updated);

    console.log(`[Orchestrator] Materialized orchestrator agent ${id}`);
    return updated;
  }

  // ===========================================================
  // Blueprint instance creation
  // ===========================================================
  async createInstance(blueprintId, instanceId, instanceDisplayName) {
    const blueprint = loadBlueprint(blueprintId);
    if (!blueprint) throw new Error(`Blueprint '${blueprintId}' not found`);
    if (loadAgentConfig(instanceId)) throw new Error(`Agent '${instanceId}' already exists`);

    const env = loadEnvironment(blueprint.environmentId);
    if (!env) throw new Error(`Working Environment '${blueprint.environmentId}' not found`);

    const password = `agent-${instanceId}-${Date.now()}`;
    const userId = `@${instanceId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, instanceId, password);
    const token = await loginMatrixUser(instanceId, password);
    await setDisplayName(token, userId, instanceDisplayName);

    const seedResult = seedAgentWorkspaceForInstance(instanceId, env, blueprintId);

    const config = {
      id: instanceId,
      displayName: instanceDisplayName,
      userId,
      token,
      role: blueprint.role,
      environmentId: env.id,
      blueprintId,
      // Preserve the owning Team of the stub being activated (#299); fall back
      // to the default team for a fresh instance.
      teamId: (loadAgentConfig(instanceId)?.teamId) || DEFAULT_TEAM_ID,
      ...(blueprint.briefingsPath && { briefingsPath: blueprint.briefingsPath }),
      enabled: true,
    };
    saveAgentConfig(instanceId, config);
    saveAgentPrompt(instanceId, blueprint.systemPrompt, blueprint.role, env, blueprintId);

    this.agentConfigs.set(instanceId, { config });
    startAgentProcess(config);

    console.log(`[Orchestrator] Created instance ${instanceId} from blueprint ${blueprintId}`);
    return {
      id: instanceId,
      userId,
      blueprintId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
  }

  // ===========================================================
  // Agent cloning
  // ===========================================================
  async cloneAgent(sourceId, newId, newDisplayName) {
    const sourceCfg = loadAgentConfig(sourceId);
    if (!sourceCfg) throw new Error(`Source agent '${sourceId}' not found`);
    if (loadAgentConfig(newId)) throw new Error(`Agent '${newId}' already exists`);

    const password = `agent-${newId}-${Date.now()}`;
    const userId = `@${newId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, newId, password);
    const token = await loginMatrixUser(newId, password);
    await setDisplayName(token, userId, newDisplayName);

    // Copy workspace — skip runtime-only files
    const srcDir = agentDir(sourceId);
    const dstDir = agentDir(newId);
    fs.mkdirSync(dstDir, { recursive: true });
    const SKIP = new Set(['config.json', 'status.json', 'dm-room.json', 'sessions']);
    for (const entry of fs.readdirSync(srcDir)) {
      if (SKIP.has(entry)) continue;
      fs.cpSync(path.join(srcDir, entry), path.join(dstDir, entry), { recursive: true });
    }

    const newConfig = {
      ...sourceCfg,
      id: newId,
      displayName: newDisplayName,
      userId,
      token,
      enabled: true,
    };
    saveAgentConfig(newId, newConfig);

    this.agentConfigs.set(newId, { config: newConfig });
    startAgentProcess(newConfig);

    console.log(`[Orchestrator] Cloned agent ${sourceId} → ${newId}`);
    return { id: newId, userId, clonedFrom: sourceId };
  }

  // ===========================================================
  // Agent import
  // ===========================================================
  // Materialize an agent from an extracted export workspace staged on the
  // shared volume (written by the admin-console import endpoint). Mirrors
  // cloneAgent: a FRESH Matrix identity is provisioned for `agentId` — the
  // export's old `userId`/`token` are dropped, because they belong to the
  // source homeserver/user and are invalid here (the source user may even
  // have been deactivated on delete). The imported workspace (memory/,
  // skills/, repo clone, prompt files) is preserved 1:1; we never re-seed,
  // so nothing the agent learned is lost.
  //
  // opts:
  //   - displayName   — override; defaults to the imported config's name.
  //   - parentTeamId  — when set, the agent is grafted into an existing team
  //                     as a `team-member`. Its imported system prompt is kept
  //                     as a per-member override (so a later team-prompt edit
  //                     won't wipe it), and it inherits the team's environment.
  //                     Absent → imported as a standalone `agent`.
  async importAgent(stagingDir, agentId, opts = {}) {
    if (!agentId || !AGENT_ID_RE.test(agentId)) throw new Error(`Invalid agent id '${agentId}'`);
    if (loadAgentConfig(agentId)) throw new Error(`Agent '${agentId}' already exists`);

    // Containment: staging dirs live under WORKSPACE/.import-staging only.
    const stagingRoot = path.resolve(path.join(WORKSPACE, ".import-staging"));
    const resolvedStaging = path.resolve(stagingDir);
    if (resolvedStaging !== stagingRoot &&
        !resolvedStaging.startsWith(stagingRoot + path.sep)) {
      throw new Error("Invalid staging path");
    }
    const stagedConfigPath = path.join(resolvedStaging, "config.json");
    if (!fs.existsSync(stagedConfigPath)) {
      throw new Error("Staged workspace is missing config.json — not a valid agent export");
    }
    let sourceCfg;
    try {
      sourceCfg = JSON.parse(fs.readFileSync(stagedConfigPath, "utf8"));
    } catch (err) {
      throw new Error(`Corrupt config.json in export: ${err.message}`);
    }

    // Resolve role + environment binding.
    let role, parentTeamId = null, environmentId;
    if (opts.parentTeamId) {
      const teamCfg = loadAgentConfig(opts.parentTeamId);
      if (!teamCfg) throw new Error(`Team '${opts.parentTeamId}' not found`);
      if (teamCfg.role !== "team") {
        throw new Error(`Agent '${opts.parentTeamId}' is not a team (role=${teamCfg.role})`);
      }
      role = "team-member";
      parentTeamId = opts.parentTeamId;
      environmentId = teamCfg.environmentId;
    } else {
      // Standalone import — never resurrect a dangling team-member/bp-instance
      // shape (it would render as an orphan with a missing parent).
      role = "agent";
      environmentId = sourceCfg.environmentId;
    }

    const displayName = opts.displayName || sourceCfg.displayName || agentId;
    const password = `agent-${agentId}-${Date.now()}`;
    const userId = `@${agentId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, agentId, password);
    const token = await loginMatrixUser(agentId, password);
    await setDisplayName(token, userId, displayName);

    // Copy the staged workspace into place, skipping runtime-only files we
    // regenerate (config rewritten below; session/DM/status are host-specific).
    const dstDir = agentDir(agentId);
    fs.mkdirSync(dstDir, { recursive: true });
    const SKIP = new Set(["config.json", "status.json", "dm-room.json", "sessions"]);
    for (const entry of fs.readdirSync(resolvedStaging)) {
      if (SKIP.has(entry)) continue;
      fs.cpSync(path.join(resolvedStaging, entry), path.join(dstDir, entry), { recursive: true });
    }

    // Rebuild the config: keep imported fields, swap in fresh identity + role.
    const newConfig = {
      ...sourceCfg,
      id: agentId,
      displayName,
      userId,
      token,
      role,
      enabled: true,
    };
    delete newConfig._provisioning;
    // Drop linkage that doesn't apply to the import target.
    delete newConfig.parentOrchestratorId;
    delete newConfig.bpId;
    delete newConfig.bpSlug;
    delete newConfig.briefingsPath;

    if (role === "team-member") {
      newConfig.parentTeamId = parentTeamId;
      newConfig.environmentId = environmentId;
      // Keep the imported prompt as a member override so team-prompt
      // propagation (updateTeamPrompt) won't overwrite it. Fall back to the
      // exported AGENT-PROMPT.md when the config carried no explicit prompt.
      if (typeof sourceCfg.systemPrompt === "string" && sourceCfg.systemPrompt.length > 0) {
        newConfig.systemPrompt = sourceCfg.systemPrompt;
      } else {
        const promptPath = path.join(dstDir, "AGENT-PROMPT.md");
        try {
          const p = fs.existsSync(promptPath) ? fs.readFileSync(promptPath, "utf8").trim() : "";
          if (p) newConfig.systemPrompt = p;
        } catch { /* leave prompt unset → inherits team template */ }
      }
    } else {
      delete newConfig.parentTeamId;
      delete newConfig.systemPromptTemplate;
    }

    saveAgentConfig(agentId, newConfig);
    this.agentConfigs.set(agentId, { config: newConfig });
    startAgentProcess(newConfig);

    try { fs.rmSync(resolvedStaging, { recursive: true, force: true }); } catch { /* best-effort cleanup */ }

    console.log(
      `[Orchestrator] Imported agent → ${agentId} (role=${role}` +
      `${parentTeamId ? `, team=${parentTeamId}` : ""})`
    );
    return { id: agentId, userId, role, parentTeamId };
  }
}

// ============================================================
// Teams admin API (#299) — CRUD for the human Team data model.
// ============================================================
//
// Mounted under /internal/admin/{teams,users,memberships}. Deliberately
// separate from the /internal/teams/* routes, which operate on the *Agent
// Team* construct (members, prompt template). Auth lives in a later issue; this
// is the data-model surface the admin console proxies to.
function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      if (!body) return resolve({});
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

// Does any agent / environment / credential still name this team as its owner?
// Used to refuse deletion of a non-empty team so resources aren't orphaned.
function teamHasOwnedResources(teamId) {
  if (fs.existsSync(AGENTS_DIR)) {
    for (const id of listAgentIds()) {
      const cfg = loadAgentConfig(id);
      if (cfg && cfg.teamId === teamId) return true;
    }
  }
  if (fs.existsSync(ENVIRONMENTS_DIR)) {
    for (const name of fs.readdirSync(ENVIRONMENTS_DIR)) {
      const p = path.join(ENVIRONMENTS_DIR, name, 'environment.json');
      if (!fs.existsSync(p)) continue;
      try {
        if (JSON.parse(fs.readFileSync(p, 'utf8')).teamId === teamId) return true;
      } catch { /* ignore */ }
    }
  }
  const indexes = [
    SSH_KEYS_INDEX,
    path.join(GH_TOKENS_DIR, 'index.json'),
    path.join(MCP_CREDENTIALS_KEYS_DIR, 'index.json'),
    LLM_ENDPOINTS_INDEX,
  ];
  for (const idx of indexes) {
    if (!fs.existsSync(idx)) continue;
    try {
      const list = JSON.parse(fs.readFileSync(idx, 'utf8'));
      if (Array.isArray(list) && list.some(e => e && e.teamId === teamId)) return true;
    } catch { /* ignore */ }
  }
  return false;
}

// Returns true if the request was a /internal/admin/* route (handled here),
// false otherwise so the caller can fall through to other routes.
async function handleTeamsAdminApi(req, res) {
  const parsed = new URL(req.url, 'http://internal');
  const segs = parsed.pathname.split('/').filter(Boolean); // ['internal','admin',...]
  if (segs[0] !== 'internal' || segs[1] !== 'admin') return false;

  const collection = segs[2];
  const resourceId = segs[3] ? decodeURIComponent(segs[3]) : null;

  try {
    if (collection === 'teams') {
      if (req.method === 'GET' && !resourceId) return sendJson(res, 200, teamsStore.listTeams()), true;
      if (req.method === 'POST' && !resourceId) {
        const body = await readBody(req);
        return sendJson(res, 201, teamsStore.createTeam(body)), true;
      }
      if (req.method === 'GET' && resourceId) {
        const team = teamsStore.getTeam(resourceId);
        if (!team) return sendJson(res, 404, { error: `Team '${resourceId}' not found` }), true;
        return sendJson(res, 200, team), true;
      }
      if (req.method === 'PUT' && resourceId) {
        const body = await readBody(req);
        return sendJson(res, 200, teamsStore.updateTeam(resourceId, body)), true;
      }
      if (req.method === 'DELETE' && resourceId) {
        if (teamHasOwnedResources(resourceId)) {
          return sendJson(res, 409, {
            error: `Team '${resourceId}' still owns agents, environments or credentials — reassign them first`,
          }), true;
        }
        return sendJson(res, 200, teamsStore.deleteTeam(resourceId)), true;
      }
    }

    if (collection === 'users') {
      const subAction = segs[4] || null; // e.g. /internal/admin/users/<id>/password
      const clean = teamsStore.sanitizeUser; // strip passwordHash from every response

      // Verify a login (#374). Internal-only; called by the admin-console's
      // public login route. Returns the sanitized user on success, else 401.
      if (req.method === 'POST' && resourceId === 'verify' && !subAction) {
        const body = await readBody(req);
        const user = teamsStore.verifyUserCredentials(body.username, body.password);
        if (!user) return sendJson(res, 401, { error: 'invalid credentials' }), true;
        return sendJson(res, 200, user), true;
      }

      // Set / clear a user's local password (System-Admin action).
      if (resourceId && subAction === 'password') {
        if (req.method === 'POST') {
          const body = await readBody(req);
          return sendJson(res, 200, teamsStore.setUserPassword(resourceId, body.password)), true;
        }
        if (req.method === 'DELETE') {
          return sendJson(res, 200, teamsStore.clearUserPassword(resourceId)), true;
        }
      }

      if (req.method === 'GET' && !resourceId) {
        const subject = parsed.searchParams.get('subject');
        if (subject) {
          const u = teamsStore.getUserBySubject(subject);
          return sendJson(res, 200, u ? [clean(u)] : []), true;
        }
        return sendJson(res, 200, teamsStore.listUsers().map(clean)), true;
      }
      if (req.method === 'POST' && !resourceId) {
        const body = await readBody(req);
        return sendJson(res, 201, clean(teamsStore.createUser(body))), true;
      }
      if (req.method === 'GET' && resourceId) {
        const u = teamsStore.getUser(resourceId);
        if (!u) return sendJson(res, 404, { error: `User '${resourceId}' not found` }), true;
        return sendJson(res, 200, clean(u)), true;
      }
      if (req.method === 'PUT' && resourceId) {
        const body = await readBody(req);
        return sendJson(res, 200, clean(teamsStore.updateUser(resourceId, body))), true;
      }
      if (req.method === 'DELETE' && resourceId) {
        return sendJson(res, 200, teamsStore.deleteUser(resourceId)), true;
      }
    }

    if (collection === 'memberships' && !resourceId) {
      if (req.method === 'GET') {
        return sendJson(res, 200, teamsStore.listMemberships({
          userId: parsed.searchParams.get('userId') || undefined,
          teamId: parsed.searchParams.get('teamId') || undefined,
        })), true;
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        return sendJson(res, 200, teamsStore.setMembership(body)), true;
      }
      if (req.method === 'DELETE') {
        return sendJson(res, 200, teamsStore.removeMembership({
          userId: parsed.searchParams.get('userId'),
          teamId: parsed.searchParams.get('teamId'),
        })), true;
      }
    }

    sendJson(res, 404, { error: 'unknown admin route' });
    return true;
  } catch (err) {
    sendJson(res, err.statusHint || 500, { error: err.message });
    return true;
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!HOMESERVER) {
    console.error("MATRIX_HOMESERVER required");
    process.exit(1);
  }
  migrateLegacyAgentConfigs();
  bootstrapTeams();
  backfillResourceOwnership();

  const orchestrator = new Orchestrator();
  await orchestrator.init();

  // Internal API — used by admin-console to manage agents
  const internalApi = http.createServer((req, res) => {
    // Teams data model (#299) — CRUD for the human Team / users / memberships.
    if (req.url.startsWith('/internal/admin/')) {
      handleTeamsAdminApi(req, res).catch(err => {
        console.error(`[Orchestrator] admin API error: ${err.message}`);
        if (!res.headersSent) sendJson(res, 500, { error: err.message });
      });
      return;
    }

    // Read-only access to baked-in helper scripts referenced by agent
    // templates' preCheckScript. The allowlist is the only way to obtain a
    // path — no user-supplied path ever reaches the filesystem.
    const SCRIPT_ALLOWLIST = {
      'multi-agent-bid': '/usr/local/bin/multi-agent-bid',
    };
    const scriptMatch = req.method === 'GET' && req.url.match(/^\/internal\/scripts\/([^/?]+)$/);
    if (scriptMatch) {
      const name = scriptMatch[1];
      const filePath = SCRIPT_ALLOWLIST[name];
      if (!filePath) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'script not in allowlist' }));
        return;
      }
      fs.readFile(filePath, 'utf8', (err, content) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `read failed: ${err.code || err.message}` }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ name, path: filePath, content }));
      });
      return;
    }

    if (req.method === 'GET' && req.url === '/internal/agents/processes') {
      // Source of truth = Podman. The in-memory map is the fast path and the
      // authority for pid + this-process ownership, but it drifts (e.g. an
      // orchestrator restart race, or a container that died without the exit
      // handler firing). Merge the labelled live containers so the UI reflects
      // real container state instead of a stale map.
      (async () => {
        const byId = new Map();
        for (const [id, proc] of agentProcesses) {
          byId.set(id, { id, pid: proc.pid, running: !proc.exitCode && !proc.killed });
        }
        try {
          const filters = encodeURIComponent(JSON.stringify({ label: ['aee.agent.id'] }));
          const list = await libpodRequest('GET', `/containers/json?filters=${filters}`);
          if (list.status < 300 && Array.isArray(list.body)) {
            for (const c of list.body) {
              const labels = c.Labels || c.labels || {};
              const aid = labels['aee.agent.id'];
              if (!aid) continue;
              const running = String(c.State || c.state || '').toLowerCase() === 'running';
              const cid = String(c.Id || c.ID || '').slice(0, 12) || null;
              const existing = byId.get(aid);
              if (existing) {
                existing.running = existing.running || running;
                if (!existing.pid && cid) existing.pid = cid;
              } else {
                byId.set(aid, { id: aid, pid: cid, running });
              }
            }
          }
        } catch (err) {
          console.warn(`[Orchestrator] /processes podman reconcile skipped: ${err.message}`);
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify([...byId.values()]));
      })();
      return;
    }

    // Quick "does this repo URL work with this SSH key" probe used by the
    // admin console to validate a Working Environment repo entry before save.
    if (req.method === 'POST' && req.url === '/internal/repository-check') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { parsed = {}; }
        const url = typeof parsed.url === 'string' ? parsed.url.trim() : '';
        const sshKeyId = parsed.sshKeyId || null;
        const githubTokenId = parsed.githubTokenId || null;
        if (!url || url.startsWith('-')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'url is required' }));
          return;
        }
        const isHttpsGithub = /^https?:\/\/(www\.)?github\.com\//i.test(url);
        const cmdEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (sshKeyId) {
          const keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
          const resolvedKey = path.resolve(keyPath);
          if (!resolvedKey.startsWith(path.resolve(SSH_KEYS_DIR) + path.sep)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'Invalid SSH key id' }));
            return;
          }
          if (!fs.existsSync(keyPath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: `SSH key not found: ${sshKeyId}` }));
            return;
          }
          try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
          cmdEnv.GIT_SSH_COMMAND =
            `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
            ` -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
        }
        // For HTTPS GitHub URLs inject PAT auth via GIT_CONFIG_* env vars so
        // the token never appears in process arguments (/proc/<pid>/cmdline).
        if (isHttpsGithub && githubTokenId) {
          const tokenPath = path.join(GH_TOKENS_DIR, githubTokenId);
          const resolvedToken = path.resolve(tokenPath);
          if (resolvedToken.startsWith(path.resolve(GH_TOKENS_DIR) + path.sep)) {
            try {
              const ghToken = fs.readFileSync(tokenPath, 'utf8').trim();
              if (ghToken) {
                const basic = Buffer.from(`x-access-token:${ghToken}`).toString('base64');
                cmdEnv.GIT_CONFIG_COUNT = '1';
                cmdEnv.GIT_CONFIG_KEY_0 = 'http.https://github.com/.extraheader';
                cmdEnv.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${basic}`;
              }
            } catch (err) {
              console.warn(`[Orchestrator] repository-check: cannot read GitHub token ${githubTokenId}: ${err.message}`);
            }
          }
        }
        const gitArgs = ['ls-remote', '--exit-code', '--symref', '--', url, 'HEAD'];
        execFile(
          'git',
          gitArgs,
          { env: cmdEnv, timeout: 12_000, maxBuffer: 1024 * 1024 },
          (err, stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (!err) {
              // First line is the symref pointing HEAD at the default branch:
              //   "ref: refs/heads/<branch>\tHEAD". Resolve so the caller can
              //   record the actual default rather than guessing "main".
              const firstLine = (stdout || '').toString().split('\n')[0] || '';
              const m = firstLine.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD/);
              const branch = m ? m[1] : null;
              res.end(JSON.stringify({ ok: true, branch }));
              return;
            }
            const detail = (stderr || err.message || '').toString().trim();
            // Strip any Authorization header line that may have leaked into the
            // error output before returning it to the caller. Match to end-of-line
            // so the full "Basic <base64>" value is covered, not just the first word.
            const sanitized = detail.replace(/Authorization:[^\r\n]*/gi, 'Authorization: [redacted]');
            const firstLine = sanitized.split('\n').find(l => l.trim()) || 'git ls-remote failed';
            res.end(JSON.stringify({ ok: false, error: firstLine.slice(0, 300) }));
          },
        );
      });
      return;
    }

    // ── Blueprint routes ───────────────────────────────────────────────────
    if (req.method === 'GET' && req.url === '/internal/blueprints') {
      const blueprints = listBlueprintIds().map(id => {
        const bp = loadBlueprint(id);
        const instances = listInstanceIds(id).map(iid => {
          const cfg = loadAgentConfig(iid);
          return { id: iid, displayName: cfg?.displayName || iid, enabled: cfg?.enabled !== false };
        });
        return { ...bp, instances };
      });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(blueprints));
      return;
    }

    const blueprintInstanceMatch = req.method === 'POST' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/instances$/);
    if (blueprintInstanceMatch) {
      const blueprintId = decodeURIComponent(blueprintInstanceMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { instanceId, displayName } = JSON.parse(body);
          if (!instanceId || !displayName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'instanceId and displayName required' }));
            return;
          }
          const result = await orchestrator.createInstance(blueprintId, instanceId, displayName);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] createInstance error: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : /already exists/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintMemoryGetMatch = req.method === 'GET' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/memory\/([^/]+)$/);
    if (blueprintMemoryGetMatch) {
      const blueprintId = decodeURIComponent(blueprintMemoryGetMatch[1]);
      const filename = decodeURIComponent(blueprintMemoryGetMatch[2]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      const content = readBlueprintMemory(blueprintId, filename);
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end(content);
      return;
    }

    const blueprintMemoryPutMatch = req.method === 'PUT' && req.url.match(/^\/internal\/blueprints\/([^/]+)\/memory\/([^/]+)$/);
    if (blueprintMemoryPutMatch) {
      const blueprintId = decodeURIComponent(blueprintMemoryPutMatch[1]);
      const filename = decodeURIComponent(blueprintMemoryPutMatch[2]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          writeBlueprintMemory(blueprintId, filename, body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintDeleteMatch = req.method === 'DELETE' && req.url.match(/^\/internal\/blueprints\/([^/]+)$/);
    if (blueprintDeleteMatch) {
      const blueprintId = decodeURIComponent(blueprintDeleteMatch[1]);
      if (!loadBlueprint(blueprintId)) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Blueprint not found' }));
        return;
      }
      const instances = listInstanceIds(blueprintId);
      if (instances.length > 0) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Blueprint has ${instances.length} instance(s). Delete them first.` }));
        return;
      }
      try {
        fs.rmSync(blueprintDir(blueprintId), { recursive: true });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const blueprintUpdateMatch = req.method === 'PUT' && req.url.match(/^\/internal\/blueprints\/([^/]+)$/);
    if (blueprintUpdateMatch) {
      const blueprintId = decodeURIComponent(blueprintUpdateMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const existing = loadBlueprint(blueprintId);
          if (!existing) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Blueprint not found' }));
            return;
          }
          const { displayName, role, systemPrompt } = JSON.parse(body || '{}');
          const updated = {
            ...existing,
            ...(displayName !== undefined && { displayName }),
            ...(role !== undefined && { role }),
            ...(systemPrompt !== undefined && { systemPrompt }),
          };
          saveBlueprint(blueprintId, updated);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(updated));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const blueprintCreateMatch = req.method === 'POST' && req.url === '/internal/blueprints';
    if (blueprintCreateMatch) {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        try {
          const { id, displayName, role, systemPrompt, environmentId, briefingsPath } = JSON.parse(body);
          if (!id || !displayName || !role || !environmentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'id, displayName, role, environmentId required' }));
            return;
          }
          // Teams may be created without a default prompt — members can carry
          // their own per-role prompts, and the team stores an empty template.
          if (!systemPrompt && role !== 'orchestrator' && role !== 'team') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'systemPrompt is required for non-orchestrator agents' }));
            return;
          }
          if (loadBlueprint(id)) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Blueprint '${id}' already exists` }));
            return;
          }
          if (!loadEnvironment(environmentId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Working Environment '${environmentId}' not found` }));
            return;
          }
          const blueprint = { id, displayName, role, systemPrompt, environmentId, ...(briefingsPath && { briefingsPath }), createdAt: new Date().toISOString() };
          saveBlueprint(id, blueprint);
          seedBlueprintMemory(id);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(blueprint));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── End blueprint routes ───────────────────────────────────────────────

    const cloneMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/clone$/);
    if (cloneMatch) {
      const sourceId = decodeURIComponent(cloneMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { newId, newDisplayName } = JSON.parse(body);
          if (!newId || !newDisplayName) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'newId and newDisplayName required' }));
            return;
          }
          const result = await orchestrator.cloneAgent(sourceId, newId, newDisplayName);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] Clone error: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : /already exists/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method === 'POST' && req.url === '/internal/agents/import') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { stagingDir, agentId, displayName, parentTeamId } = JSON.parse(body || '{}');
          if (!stagingDir || !agentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'stagingDir and agentId required' }));
            return;
          }
          const result = await orchestrator.importAgent(stagingDir, agentId, {
            displayName: displayName || undefined,
            parentTeamId: parentTeamId || undefined,
          });
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] Import error: ${err.message}`);
          const status = /already exists/i.test(err.message) ? 409
                       : /not found/i.test(err.message) ? 404
                       : /invalid|missing|corrupt|not a valid/i.test(err.message) ? 400
                       : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    const deleteMatch = req.method === 'DELETE' && req.url.match(/^\/internal\/agents\/([^/]+)$/);
    if (deleteMatch) {
      const id = decodeURIComponent(deleteMatch[1]);
      (async () => {
        try {
          if (!fs.existsSync(agentDir(id))) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Agent not found' }));
            return;
          }

          // Cascade to children before deleting the parent. Without this,
          // deleting an orchestrator (or team) leaves its bp-instance
          // (or team-member) stubs orphaned: they keep the now-dangling
          // parentOrchestratorId / parentTeamId, the UI can't render them
          // under any parent, and a future orchestrator that scans the same
          // BP slug can't claim the deterministic agentId because the orphan
          // already occupies it.
          const parentCfg = loadAgentConfig(id);
          const cascaded = [];
          if (parentCfg) {
            const childField = parentCfg.role === 'orchestrator' ? 'parentOrchestratorId'
                            :  parentCfg.role === 'team' ? 'parentTeamId'
                            :  null;
            if (childField) {
              for (const childId of listAgentIds()) {
                if (childId === id) continue;
                const childCfg = loadAgentConfig(childId);
                if (!childCfg) continue;
                if (childCfg[childField] !== id) continue;
                try {
                  stopAgentProcess(childId);
                  if (childCfg.token) {
                    // Materialized child — best-effort Matrix cleanup.
                    await orchestrator.deactivateMatrixUser(childId);
                  }
                  deleteAgentFiles(childId);
                  if (PER_AGENT_VOLUME) await removePerAgentVolume(childId).catch(e =>
                    console.warn(`[Orchestrator] volume teardown ${childId}: ${e.message}`));
                  await removePerAgentNetwork(childId).catch(e =>
                    console.warn(`[Orchestrator] network teardown ${childId}: ${e.message}`));
                  orchestrator.agentConfigs.delete(childId);
                  cascaded.push(childId);
                } catch (err) {
                  console.error(`[Orchestrator] cascade-delete child '${childId}' failed: ${err.message}`);
                }
              }
              if (cascaded.length > 0) {
                console.log(
                  `[Orchestrator] Cascade-deleted ${cascaded.length} ${parentCfg.role === 'orchestrator' ? 'bp-instance' : 'team-member'} children of '${id}': ${cascaded.join(', ')}`
                );
              }
            }
          }

          stopAgentProcess(id);
          deleteAgentFiles(id);
          if (PER_AGENT_VOLUME) await removePerAgentVolume(id).catch(e =>
            console.warn(`[Orchestrator] volume teardown ${id}: ${e.message}`));
          await removePerAgentNetwork(id).catch(e =>
            console.warn(`[Orchestrator] network teardown ${id}: ${e.message}`));
          orchestrator.agentConfigs.delete(id);
          await orchestrator.deactivateMatrixUser(id);

          // Reap the env if no agent references it anymore. The Team-Setup
          // wizard creates one env per team (env id = team id) and there is
          // no other way to clean it up from the UI, so without this every
          // wizard-created team leaves behind an orphan env that blocks the
          // next create-team-with-the-same-id attempt with "Some resources
          // for team … already exist". Manually managed envs survive because
          // they're either shared between agents or reused after a delete —
          // we only delete envs whose last referencing agent just went away.
          let reapedEnv = null;
          if (parentCfg?.environmentId) {
            const envId = parentCfg.environmentId;
            const stillReferenced = listAgentIds().some(otherId => {
              const cfg = loadAgentConfig(otherId);
              return cfg && cfg.environmentId === envId;
            });
            if (!stillReferenced) {
              const envDir = path.join(ENVIRONMENTS_DIR, envId);
              try {
                if (fs.existsSync(envDir)) {
                  fs.rmSync(envDir, { recursive: true, force: true });
                  reapedEnv = envId;
                  console.log(`[Orchestrator] Reaped now-unused environment '${envId}' after deleting '${id}'`);
                }
              } catch (err) {
                console.error(`[Orchestrator] Failed to reap env '${envId}': ${err.message}`);
              }
            }
          }

          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, cascaded, reapedEnv }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // ── Ephemeral agent ───────────────────────────────────────────────────
    if (req.method === 'POST' && req.url === '/internal/agents/ephemeral') {
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        try {
          const { blueprintId, displayName, missionPrompt, environmentId, timeoutSeconds } = JSON.parse(body);
          if (!displayName || !missionPrompt || !environmentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'displayName, missionPrompt, environmentId required' }));
            return;
          }

          const agentId = 'bp-' + randomHex(4);
          const env = loadEnvironment(environmentId);
          if (!env) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Working Environment not found: ${environmentId}` }));
            return;
          }

          const password = `agent-${agentId}-${Date.now()}`;
          const userId = `@${agentId}:local`;

          if (orchestrator.adminClient) await ensureMatrixUser(orchestrator.adminClient, agentId, password);
          const token = await loginMatrixUser(agentId, password);
          await setDisplayName(token, userId, displayName);

          const seedResult = blueprintId
            ? seedAgentWorkspaceForInstance(agentId, env, blueprintId)
            : seedAgentWorkspace(agentId, env);

          const systemPrompt = blueprintId
            ? (loadBlueprint(blueprintId)?.systemPrompt || displayName)
            : displayName;

          const config = {
            id: agentId,
            displayName,
            userId,
            token,
            role: 'agent',
            environmentId: env.id,
            teamId: DEFAULT_TEAM_ID,
            ephemeral: true,
            enabled: true,
            ...(blueprintId && { blueprintId }),
          };
          saveAgentConfig(agentId, config);
          saveAgentPrompt(agentId, systemPrompt, 'agent', env, blueprintId || null);

          const triggerId = 'trigger-' + randomHex(4);
          const fireAt = new Date(Date.now() + 5000).toISOString();
          saveTriggers(agentId, [{
            id: triggerId,
            type: 'once',
            enabled: true,
            at: fireAt,
            prompt: missionPrompt,
            ...(timeoutSeconds && { timeoutSeconds }),
          }]);

          orchestrator.agentConfigs.set(agentId, { config });
          startAgentProcess(config);

          const workspacePath = agentDir(agentId);
          console.log(`[Orchestrator] Created ephemeral agent ${agentId} (displayName=${displayName})`);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ agentId, workspacePath }));
        } catch (err) {
          console.error(`[Orchestrator] Ephemeral agent create error: ${err.message}`);
          const statusCode = /not found/i.test(err.message) ? 400 : 500;
          res.writeHead(statusCode, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent status (#185) ─────────────────────────────────────────
    // Agents POST their {state, updatedAt, lastResponseAt} here; we persist it
    // on the control-plane volume so status reads no longer touch the agent's
    // workspace. Last-writer-wins — no ordering contract.
    const pushStatusMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/status$/);
    if (pushStatusMatch) {
      const id = decodeURIComponent(pushStatusMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const data = JSON.parse(body || '{}');
          const dir = controlAgentDir(id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'status.json'), JSON.stringify(data));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent running-sessions registry (#185) ──────────────────────
    // Agents POST their running-sessions array; we persist it to the control
    // plane so the admin's "Sessions" tab works under per-agent volume
    // isolation (where the agent's own running-sessions.json is unreachable).
    const pushRunningMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/running-sessions$/);
    if (pushRunningMatch) {
      const id = decodeURIComponent(pushRunningMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const data = JSON.parse(body || '[]');
          const dir = controlAgentDir(id);
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, 'running-sessions.json'),
            JSON.stringify(Array.isArray(data) ? data : []));
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Push: agent session-log lines (#185) ──────────────────────────────
    // Agents POST { roomId, baseOffset, dataB64 } where dataB64 is the raw
    // bytes appended to their local sessions/<roomId>.jsonl since baseOffset.
    // We append byte-for-byte to the control-plane copy so the admin SSE
    // viewer's byte-cursor contract (?since=<byte>) stays valid. Reconciled on
    // baseOffset so a lost-ACK retry can't duplicate and a gap is self-healed:
    //   base == cur          → append all
    //   base <  cur (retry)  → append only the part beyond cur
    //   base >  cur (gap)    → reply {expected: cur}; the agent rewinds + resends
    const sessionEventsMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-events$/);
    if (sessionEventsMatch) {
      const id = decodeURIComponent(sessionEventsMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 16_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId, baseOffset, dataB64 } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          const buf = Buffer.from(dataB64 || '', 'base64');
          const dir = path.join(controlAgentDir(id), 'sessions');
          fs.mkdirSync(dir, { recursive: true });
          const fp = path.join(dir, `${roomId}.jsonl`);
          let cur = 0;
          try { cur = fs.statSync(fp).size; } catch { cur = 0; }
          // Reconcile against baseOffset (pure helper, unit-tested in
          // session-cursor.test.js — the byte-cursor "sharp edge").
          const recon = reconcileSessionAppend(baseOffset, cur, buf.length);
          if (recon.gap) {
            // Gap: control file is behind the agent — ask it to resend from cur.
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, expected: recon.expected }));
            return;
          }
          if (recon.appendLen > 0) {
            fs.appendFileSync(fp, buf.subarray(recon.sliceFrom));
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, offset: recon.offset }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Push: per-room session pointer mirror (#185 Phase 2) ──────────────
    // Agents POST { roomId, sessionId, updatedAt }. The pointer (<roomId>.
    // current.json) is agent-authored (it drives --resume) but admin-read (the
    // "Session aktiv" badge / session-reset). With per-agent volumes the admin
    // can't read the agent's copy, so the agent mirrors it here. Whole-file,
    // last-writer-wins like status.json. An empty/absent sessionId clears it
    // (used by the session-reset path so the badge drops).
    const sessionPointerMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-pointer$/);
    if (sessionPointerMatch) {
      const id = decodeURIComponent(sessionPointerMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId, sessionId, updatedAt } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          const dir = path.join(controlAgentDir(id), 'sessions');
          fs.mkdirSync(dir, { recursive: true });
          const fp = path.join(dir, `${roomId}.current.json`);
          if (typeof sessionId === 'string' && sessionId) {
            fs.writeFileSync(fp, JSON.stringify({ sessionId, updatedAt: updatedAt || new Date().toISOString() }));
          } else {
            try { fs.unlinkSync(fp); } catch { /* already gone */ }
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Pending-triggers drain (#185 Phase 2) ────────────────────────────
    // The isolated agent pulls its queue here every ~5s; read-and-clear is
    // atomic in this single event loop, so no entry is lost between the read
    // and the clear even with concurrent enqueues.
    const pendingDrainMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/pending-drain$/);
    if (pendingDrainMatch) {
      const id = decodeURIComponent(pendingDrainMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, entries: drainPending(id) }));
      return;
    }

    // ── Enqueue a pending entry (#185 Phase 2) ────────────────────────────
    // The admin-console is a separate process, so to keep this queue
    // single-writer (and the drain race-free) it hands entries in through us
    // rather than writing the file itself.
    const enqueuePendingMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/enqueue-pending$/);
    if (enqueuePendingMatch) {
      const id = decodeURIComponent(enqueuePendingMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const entry = JSON.parse(body || '{}');
          if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'entry must be an object' }));
            return;
          }
          enqueuePending(id, entry);
          res.writeHead(202, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Targeted re-seed of an isolated agent's dedicated volume (#185 item 5) ─
    // After the admin (or orchestrator) rewrites a running agent's control-plane
    // files on the pool subpath, it asks us to mirror the named paths into the
    // agent's dedicated volume — the orchestrator is the only writer that can
    // reach it. No-op with the flag off or when the agent isn't running (see
    // reseedAgent); reseedPerAgentVolume re-validates each path (allowlist).
    const reseedMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reseed$/);
    if (reseedMatch) {
      const id = decodeURIComponent(reseedMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', async () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const { paths } = JSON.parse(body || '{}');
          if (!Array.isArray(paths)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'paths must be an array' }));
            return;
          }
          const result = await reseedAgent(id, paths);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true, ...result }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Session reset (#185 Phase 2) ──────────────────────────────────────
    // The admin can't delete an isolated agent's session pointer, so it asks
    // us. We drop the pushed mirror (badge clears now) and, when isolated,
    // enqueue a command so the agent drops its own --resume pointer. With the
    // flag off the admin still deletes the pool pointer directly, so we skip
    // the command to keep that path unchanged.
    const sessionResetMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-reset$/);
    if (sessionResetMatch) {
      const id = decodeURIComponent(sessionResetMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 1_000_000) req.destroy(); });
      req.on('end', () => {
        try {
          const { roomId } = JSON.parse(body || '{}');
          if (!isSafePathSeg(id) || !isSafePathSeg(roomId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'bad id/roomId' }));
            return;
          }
          try { fs.unlinkSync(path.join(controlAgentDir(id), 'sessions', `${roomId}.current.json`)); } catch { /* already gone */ }
          if (PER_AGENT_VOLUME) enqueuePending(id, { kind: 'session-reset', roomId });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Triggers: agent pull (#185 Phase 2) ───────────────────────────────
    // The isolated agent fetches its canonical triggers on each sync tick and
    // whenever SIGUSR2 wakes it. Read-only.
    const getTriggersMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers$/);
    if (getTriggersMatch) {
      const id = decodeURIComponent(getTriggersMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, triggers: loadTriggers(id) }));
      return;
    }

    // ── Triggers: one-shot consumed (#185 Phase 2) ────────────────────────
    // After firing a `once` trigger the agent reports it consumed so we drop it
    // from the canonical copy and it won't re-fire on the next pull/restart.
    const consumeTriggerMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers\/([^/]+)\/consumed$/);
    if (consumeTriggerMatch) {
      const id = decodeURIComponent(consumeTriggerMatch[1]);
      const tid = decodeURIComponent(consumeTriggerMatch[2]);
      if (!isSafePathSeg(id) || !isSafePathSeg(tid)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad id/triggerId' }));
        return;
      }
      const before = loadTriggers(id);
      const after = Array.isArray(before) ? before.filter(t => t && t.id !== tid) : [];
      const removed = after.length !== (Array.isArray(before) ? before.length : 0);
      if (removed) {
        try {
          saveTriggers(id, after);
        } catch (err) {
          // Don't claim success — the canonical copy still has the trigger, so
          // the agent should know its consume report didn't persist.
          console.error(`[Triggers] consume ${id}/${tid}: ${err.message}`);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
          return;
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, removed }));
      return;
    }

    // ── Triggers: admin write-through (#185 Phase 2) ──────────────────────
    // Admin CRUD computes the new full array and PUTs it here, so the
    // orchestrator stays the single writer of the canonical copy. We persist
    // and signal SIGUSR2 so the agent re-pulls immediately.
    const putTriggersMatch = req.method === 'PUT' && req.url.match(/^\/internal\/agents\/([^/]+)\/triggers$/);
    if (putTriggersMatch) {
      const id = decodeURIComponent(putTriggersMatch[1]);
      let body = '';
      req.on('data', (d) => { body += d; if (body.length > 4_000_000) req.destroy(); });
      req.on('end', () => {
        if (!isSafePathSeg(id)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
          return;
        }
        try {
          const { triggers } = JSON.parse(body || '{}');
          if (!Array.isArray(triggers)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'triggers must be an array' }));
            return;
          }
          saveTriggers(id, triggers);
          const proc = agentProcesses.get(id);
          if (proc) proc.kill('SIGUSR2');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: err.message }));
        }
      });
      return;
    }

    // ── Config + dm-room: agent pull (#185 Phase 2 item 3) ────────────────
    // config.json / dm-room.json are control-plane authored and stay canonical
    // on the pool subpath (orchestrator + admin own them there). An isolated
    // agent can't read the pool subpath, so it pulls them from us into its
    // local cache (refreshed each sync tick / on SIGUSR2). Read-only.
    const getConfigMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/config$/);
    if (getConfigMatch) {
      const id = decodeURIComponent(getConfigMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      const cfg = loadAgentConfig(id);
      if (!cfg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'Agent not found' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, config: cfg }));
      return;
    }

    const getDmRoomMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/dm-room$/);
    if (getDmRoomMatch) {
      const id = decodeURIComponent(getDmRoomMatch[1]);
      if (!isSafePathSeg(id)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'bad agent id' }));
        return;
      }
      let dmRoom = null;
      try {
        const p = path.join(agentDir(id), 'dm-room.json');
        if (fs.existsSync(p)) dmRoom = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch { /* missing/corrupt → null (chat not opened yet) */ }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, dmRoom }));
      return;
    }

    // ── Poll agent status ─────────────────────────────────────────────────
    const pollMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/poll$/);
    if (pollMatch) {
      const id = decodeURIComponent(pollMatch[1]);
      if (!fs.existsSync(agentDir(id))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      const statusPath = agentStatePath(id, 'status.json'); // control-plane copy preferred (#185)
      let status = {};
      try {
        if (fs.existsSync(statusPath)) {
          status = JSON.parse(fs.readFileSync(statusPath, 'utf8'));
        }
      } catch (err) {
        console.error(`[Orchestrator] Poll read error for ${id}: ${err.message}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        agentId: id,
        busy: status.busy ?? null,
        triggerFired: status.triggerFired ?? null,
        lastActivity: status.lastActivity ?? null,
        exitedAt: status.exitedAt ?? null,
      }));
      return;
    }

    // ── Session tail ──────────────────────────────────────────────────────
    const sessionTailMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/session-tail(\?.*)?$/);
    if (sessionTailMatch) {
      const id = decodeURIComponent(sessionTailMatch[1]);
      const urlObj = new URL(req.url, 'http://localhost');
      const lines = parseInt(urlObj.searchParams.get('lines') || '100', 10);
      const since = parseInt(urlObj.searchParams.get('since') || '0', 10);

      if (!fs.existsSync(agentDir(id))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }

      try {
        const sessionsDir = agentStatePath(id, 'sessions'); // control-plane copy preferred (#185)
        let newestFile = null;
        let newestMtime = 0;
        if (fs.existsSync(sessionsDir)) {
          for (const f of fs.readdirSync(sessionsDir)) {
            if (!f.endsWith('.jsonl')) continue;
            const fp = path.join(sessionsDir, f);
            const st = fs.statSync(fp);
            if (st.mtimeMs > newestMtime) {
              newestMtime = st.mtimeMs;
              newestFile = fp;
            }
          }
        }

        if (!newestFile) {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ lines: [], nextOffset: 0 }));
          return;
        }

        const fileSize = fs.statSync(newestFile).size;
        const startOffset = Math.min(since, fileSize);
        const toRead = fileSize - startOffset;
        let chunk = '';
        if (toRead > 0) {
          const buf = Buffer.alloc(toRead);
          const fd = fs.openSync(newestFile, 'r');
          fs.readSync(fd, buf, 0, toRead, startOffset);
          fs.closeSync(fd);
          chunk = buf.toString('utf8');
        }

        const allLines = chunk.split('\n').filter(l => l.trim());
        const tail = allLines.slice(-lines);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ lines: tail, nextOffset: fileSize }));
      } catch (err) {
        console.error(`[Orchestrator] session-tail error for ${id}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    // ── BP-event router (disabled) ───────────────────────────────────────
    // The automatic Python-driven fan-out path (bp-transition.py → POST
    // /internal/bp-events → routeBpEvents) is intentionally retired in this
    // environment: Python isn't installed in the orchestrator/agent images,
    // so the script-based closing-loop is unreliable. Hand-off is now an
    // explicit user action via the bp-instance chat's Hand-off button
    // (see /internal/agents/:id/handover below). We still answer this URL
    // so a stray ACE script gets a clean 410 instead of a confusing 404 or
    // a half-routed event.
    if (req.method === 'POST' && req.url === '/internal/bp-events') {
      // Drain the body so the client doesn't see a connection reset.
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(410, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: false,
          error: 'bp-events ingestion is disabled — use the Hand-off button in the bp-instance chat',
        }));
      });
      return;
    }

    // ── Enable / Disable an agent (with stub materialization) ────────────
    const enableMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/enable$/);
    if (enableMatch) {
      const id = decodeURIComponent(enableMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.enableAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] enableAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    const disableMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/disable$/);
    if (disableMatch) {
      const id = decodeURIComponent(disableMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const mode = parsed.mode || undefined;
        (async () => {
          try {
            const result = await orchestrator.disableAgent(id, { mode });
            // warning=true means the agent is busy/has active triggers and the
            // caller must choose drain or abort before we proceed.
            const httpStatus = result.warning ? 409 : 200;
            res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] disableAgent error for ${id}: ${err.message}`);
            const status = /not found/i.test(err.message) ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Hand-off candidates for a bp-instance ────────────────────────────
    // Returns the bp-instance stubs that should be considered as hand-off
    // targets when the named source agent finishes its work. Suggested via
    // the briefings graph (depends-on + input-artifact, sourced from
    // bp-explorer); unknown source or unreachable graph yield empty
    // `suggested`. The full list of sibling bp-instance agents under the
    // same parent orchestrator is also returned so the user can hand off to
    // siblings the graph doesn't know about (e.g. ad-hoc dynamic-mode
    // coordination).
    const handoverCandMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/?]+)\/handover-candidates(?:\?.*)?$/);
    if (handoverCandMatch) {
      const id = decodeURIComponent(handoverCandMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.handoverCandidates(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] handoverCandidates error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 :
                         /not a bp-instance/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // ── Workspace git status (hand-off pre-flight) ───────────────────────
    // Reports per-repo commit/push state for an agent's workspace so the
    // hand-off dialog can block on uncommitted or unpushed work. Read-only,
    // no remote calls — relies on whatever the workspace has fetched. The
    // `summary.ready` flag is the convenience shortcut the UI uses to decide
    // whether to enable the submit button.
    const gitStatusMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/?]+)\/workspace\/git-status(?:\?.*)?$/);
    if (gitStatusMatch) {
      const id = decodeURIComponent(gitStatusMatch[1]);
      try {
        const cfg = loadAgentConfig(id);
        if (!cfg) {
          res.writeHead(404, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Agent '${id}' not found` }));
          return;
        }
        const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
        const repos = inspectAgentRepoStatuses(id, env);
        const summary = {
          totalRepos: repos.length,
          missing: repos.filter((r) => !r.exists).length,
          dirty: repos.filter((r) => r.exists && !r.clean).length,
          ahead: repos.filter((r) => r.exists && r.upstream && (r.ahead || 0) > 0).length,
          ready: repos.length > 0 && repos.every((r) => r.exists && r.ready),
        };
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ agentId: id, environmentId: cfg.environmentId || null, repos, summary }));
      } catch (err) {
        console.error(`[Orchestrator] git-status error for ${id}: ${err.message}`);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
      return;
    }

    const claimMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/claim$/);
    if (claimMatch) {
      const id = decodeURIComponent(claimMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.claimAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] claimAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 :
                         /push failed/i.test(err.message) ? 409 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    const deactivateMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/deactivate$/);
    if (deactivateMatch) {
      const id = decodeURIComponent(deactivateMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', () => {
        let parsed = {};
        try { parsed = JSON.parse(body || '{}'); } catch { /* ignore */ }
        const mode = parsed.mode || undefined;
        (async () => {
          try {
            const result = await orchestrator.deactivateAgent(id, { mode });
            const httpStatus = result.warning ? 409 : 200;
            res.writeHead(httpStatus, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] deactivateAgent error for ${id}: ${err.message}`);
            const status = /not found/i.test(err.message) ? 404 : 500;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
      });
      return;
    }

    // ── Re-scan briefings directory for an orchestrator ──────────────────
    // Accepts `?force=1` to bypass the per-orchestrator pull throttle —
    // user-initiated Sync clicks should always reach origin.
    const syncBpsMatch = req.method === 'POST' && req.url.match(/^\/internal\/orchestrators\/([^/]+)\/sync-bps(?:\?.*)?$/);
    if (syncBpsMatch) {
      const orchId = decodeURIComponent(syncBpsMatch[1]);
      const force = /[?&]force=1\b/.test(req.url);
      (async () => {
        try {
          const stubs = await orchestrator.syncBpStubs(orchId, { force });
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ orchestratorId: orchId, stubs, total: stubs.length }));
        } catch (err) {
          console.error(`[Orchestrator] sync-bps error for ${orchId}: ${err.message}`);
          // 400 for caller-fixable misconfigurations (no briefingsPath, no
          // workspace clone). The workspace-missing case is by far the most
          // common diagnostic the user can act on, so it must not look like
          // a 500 server bug.
          let status = 500;
          if (/not found/i.test(err.message)) status = 404;
          else if (
            err.code === "WORKSPACE_NO_GIT" ||
            /no enclosing git checkout/i.test(err.message) ||
            /not a git checkout/i.test(err.message) ||
            /briefingsPath/i.test(err.message)
          ) status = 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    // ── One iteration of the auto-claim loop ─────────────────────────────
    const claimTickMatch = req.method === 'POST' && req.url.match(/^\/internal\/orchestrators\/([^/]+)\/claim-tick$/);
    if (claimTickMatch) {
      const orchId = decodeURIComponent(claimTickMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.runClaimTick(orchId);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ orchestratorId: orchId, ...result }));
        } catch (err) {
          console.error(`[Orchestrator] claim-tick error for ${orchId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    const stopSessionMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/stop-session$/);
    if (stopSessionMatch) {
      const id = decodeURIComponent(stopSessionMatch[1]);
      const ok = stopAgentSession(id);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Agent not running' }));
      return;
    }

    const stopOneSessionMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/sessions\/([^/]+)\/stop$/);
    if (stopOneSessionMatch) {
      const id = decodeURIComponent(stopOneSessionMatch[1]);
      const sessionId = decodeURIComponent(stopOneSessionMatch[2]);
      const ok = stopAgentSession(id, sessionId);
      res.writeHead(ok ? 200 : 404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(ok ? { ok: true } : { error: 'Agent not running' }));
      return;
    }

    const reloadTriggersMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reload-triggers$/);
    if (reloadTriggersMatch) {
      const id = decodeURIComponent(reloadTriggersMatch[1]);
      const proc = agentProcesses.get(id);
      if (proc) {
        proc.kill('SIGUSR2');
        console.log(`[Orchestrator] Sent SIGUSR2 (reload-triggers) to agent ${id}`);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    const resetReposMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reset-repos$/);
    if (resetReposMatch) {
      const agentId = decodeURIComponent(resetReposMatch[1]);
      const cfg = loadAgentConfig(agentId);
      if (!cfg) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      const env = cfg.environmentId ? loadEnvironment(cfg.environmentId) : null;
      const repos = Array.isArray(env?.repositories) ? env.repositories : [];
      const workspace = agentDir(agentId);
      const results = [];
      for (const repo of repos) {
        if (!repo?.url) continue;
        const repoName = (repo.url.split('/').pop() || 'repo').replace(/\.git$/, '');
        const repoPath = path.join(workspace, repoName);
        let branch = repo.branch || null;
        if (!fs.existsSync(path.join(repoPath, '.git'))) {
          results.push({ repo: repoName, skipped: 'not-a-git-repo' });
          continue;
        }
        const gitEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (repo.sshKeyId) {
          const keyPath = path.join(SSH_KEYS_DIR, repo.sshKeyId);
          if (fs.existsSync(keyPath)) {
            try { fs.chmodSync(keyPath, 0o600); } catch { /* best effort */ }
            gitEnv.GIT_SSH_COMMAND =
              `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null` +
              ` -o IdentitiesOnly=yes -o BatchMode=yes -o ConnectTimeout=8`;
          }
        }
        try {
          execFileSync('git', ['fetch', 'origin'], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 30_000 });
          if (!branch) {
            // No branch configured — resolve the remote's HEAD so we don't
            // assume 'main'. Falls back to the locally checked-out branch if
            // the remote HEAD ref isn't available (e.g. older git servers).
            try {
              execFileSync('git', ['remote', 'set-head', 'origin', '--auto'], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 10_000 });
              branch = execFileSync('git', ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 5_000 })
                .toString().trim().replace(/^origin\//, '');
            } catch {
              branch = execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 5_000 }).toString().trim();
            }
          }
          execFileSync('git', ['checkout', branch], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 10_000 });
          execFileSync('git', ['reset', '--hard', `origin/${branch}`], { cwd: repoPath, env: gitEnv, stdio: 'pipe', timeout: 10_000 });
          results.push({ repo: repoName, branch, reset: true });
        } catch (err) {
          const detail = (err.stderr || err.stdout || err.message || '').toString().trim().slice(0, 200);
          console.warn(`[Orchestrator] reset-repos ${agentId}/${repoName}: ${detail}`);
          results.push({ repo: repoName, branch, failed: true, detail });
        }
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, results }));
      return;
    }

    // POST /internal/teams/:teamId/members — add member to team
    // Body (all optional): { id, displayName, systemPromptOverride,
    //   skillsOverride, sessionPolicy, triggers }
    const addMemberMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/members$/);
    if (addMemberMatch) {
      const teamId = decodeURIComponent(addMemberMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let opts = {};
        if (body) {
          try { opts = JSON.parse(body) || {}; }
          catch (err) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
            return;
          }
        }
        try {
          const result = await orchestrator.addTeamMember(teamId, opts);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] addTeamMember error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team/i.test(err.message) ? 400
            : /already exists/i.test(err.message) ? 409
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    // POST /internal/teams/:teamId/prompt — update team's systemPromptTemplate
    // and push it to all inheriting members.
    const teamPromptMatch = req.method === 'POST' && req.url.match(/^\/internal\/teams\/([^/]+)\/prompt$/);
    if (teamPromptMatch) {
      const teamId = decodeURIComponent(teamPromptMatch[1]);
      let body = '';
      req.on('data', d => body += d);
      req.on('end', async () => {
        let payload;
        try { payload = JSON.parse(body || '{}'); }
        catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid JSON body: ${err.message}` }));
          return;
        }
        if (typeof payload?.systemPromptTemplate !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'systemPromptTemplate (string) required' }));
          return;
        }
        try {
          const result = await orchestrator.updateTeamPrompt(teamId, payload.systemPromptTemplate);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] updateTeamPrompt error for ${teamId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404
            : /not a team/i.test(err.message) ? 400
            : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      });
      return;
    }

    if (req.method !== 'POST' || req.url !== '/internal/agents') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const {
          id, displayName, role, systemPrompt, environmentId,
          schedule, taskPrompt, briefingsPath,
          // Team-Setup wizard fields (all optional, additive):
          team, sessionPolicy, triggers,
          // Owning (human) Team — the tenant this construct belongs to (#299).
          teamId,
          // For role: 'team' — suppress the auto-numbered first member
          // (the wizard adds members itself with role overrides instead).
          skipFirstMember,
        } = JSON.parse(body);
        if (!id || !displayName || !role || !environmentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, displayName, role, environmentId required' }));
          return;
        }
        if (!['agent', 'orchestrator', 'team'].includes(role)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid role: ${role}. Must be one of: agent, orchestrator, team` }));
          return;
        }
        // Teams may be created without a default prompt — members can carry
        // their own per-role prompts, and the team stores an empty template.
        if (role !== 'orchestrator' && role !== 'team' && !systemPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'systemPrompt required for non-orchestrator roles' }));
          return;
        }
        if (loadAgentConfig(id)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Agent '${id}' already exists` }));
          return;
        }

        const extra =
          role === 'orchestrator' ? { briefingsPath: briefingsPath || null } :
          { schedule, taskPrompt };
        // Wizard-side extras layered on top of the legacy fields.
        if (team) extra.team = team;
        if (sessionPolicy) extra.sessionPolicy = sessionPolicy;
        if (Array.isArray(triggers)) extra.triggers = triggers;
        if (skipFirstMember) extra.skipFirstMember = true;
        if (teamId) extra.teamId = teamId;
        const result = await orchestrator.createAgent(id, displayName, role, systemPrompt, environmentId, extra);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[Orchestrator] Internal API create error: ${err.message}`);
        // 400 for caller-fixable misconfigurations (missing env / token, clone
        // rejected by the remote) so the UI surfaces them as a validation
        // error rather than a generic 500 server error.
        const isUserError = /not found/i.test(err.message) || /clone failed/i.test(err.message);
        const statusCode = isUserError ? 400 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  internalApi.listen(4002, '0.0.0.0', () =>
    console.log('[Orchestrator] Internal API listening on :4002')
  );

  // ============================================================
  // Webhook server — receives HTTP triggers from external systems
  // (GitHub, CI, etc.) and enqueues them for the target agent.
  //
  // POST /hooks/:agentId/:hookId
  //   → looks up a trigger with type="http" and matching id in
  //     /workspace/agents/:agentId/triggers.json
  //   → validates X-Hook-Secret against the trigger's `secret` field
  //   → appends to /workspace/agents/:agentId/pending-triggers.json
  //   → agent-runner picks it up within seconds and fires the prompt
  //
  // Each HTTP trigger MUST carry its own `secret` (auto-generated when
  // created via the Admin Console). Triggers without a secret are
  // rejected with 401, since an external endpoint without auth is a
  // footgun even on a private network.
  // ============================================================
  const HOOK_PORT = parseInt(process.env.HOOK_PORT || '4003', 10);

  function constantTimeEqual(a, b) {
    try {
      const ba = Buffer.from(a);
      const bb = Buffer.from(b);
      if (ba.length !== bb.length) return false;
      return crypto.timingSafeEqual(ba, bb);
    } catch {
      return false;
    }
  }

  const hookServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.writeHead(405, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Method not allowed' }));
      return;
    }

    const match = req.url.match(/^\/hooks\/([^/]+)\/([^/]+)$/);
    if (!match) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found — expected /hooks/:agentId/:hookId' }));
      return;
    }

    const agentId = match[1];
    const hookId  = match[2];
    const agentDir = path.join(AGENTS_DIR, agentId);

    if (!fs.existsSync(agentDir)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `Agent '${agentId}' not found` }));
      return;
    }

    // Reject webhooks for disabled agents — the agent process is stopped and
    // no new executions should start. Callers can retry after re-enabling.
    try {
      const agentCfg = JSON.parse(fs.readFileSync(path.join(agentDir, 'config.json'), 'utf8'));
      if (agentCfg?.enabled === false) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Agent '${agentId}' is disabled` }));
        return;
      }
    } catch { /* no config.json → new agent, allow through */ }

    const triggers = loadTriggers(agentId); // canonical copy (#185 Phase 2)

    const trigger = Array.isArray(triggers)
      ? triggers.find(t => t.id === hookId && t.type === 'http' && t.enabled !== false)
      : null;
    if (!trigger) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: `HTTP trigger '${hookId}' not found for agent '${agentId}'` }));
      return;
    }

    // Per-trigger secret check — every HTTP trigger must carry its own
    // secret. Triggers without one are misconfigured and rejected.
    if (!trigger.secret) {
      console.log(`[HookServer] Rejected '${hookId}' for '${agentId}': trigger has no secret configured`);
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Trigger has no secret configured' }));
      return;
    }
    const provided = req.headers['x-hook-secret'] || '';
    if (!constantTimeEqual(provided, trigger.secret)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unauthorized' }));
      return;
    }

    enqueuePending(agentId, { triggerId: hookId });

    console.log(`[HookServer] Queued trigger '${hookId}' for agent '${agentId}'`);
    res.writeHead(202, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ queued: true, triggerId: hookId, agentId }));
  });

  hookServer.listen(HOOK_PORT, '0.0.0.0', () =>
    console.log(`[Orchestrator] Hook server listening on :${HOOK_PORT}`)
  );

  // ============================================================
  // GitHub event poller — translates GitHub Events API activity into
  // pending-triggers entries for agents that subscribed via a
  // type=github-event trigger. See orchestrator/github-poller.js.
  // ============================================================
  const { GitHubPoller } = require('./github-poller');
  const ghPoller = new GitHubPoller({
    loadEnvironment,
    listEnvironmentIds: () => {
      try {
        return fs.readdirSync(ENVIRONMENTS_DIR).filter(n => !n.startsWith('_'));
      } catch {
        return [];
      }
    },
    enqueuePending, // #185 Phase 2: orchestrator owns the queue (control plane when isolated)
    triggersPath: (agentId) => controlOrPoolPath(agentId, 'triggers.json'),
  });
  ghPoller.start();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
