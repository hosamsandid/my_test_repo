'use strict';

const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const http = require("http");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");

// ============================================================
// Config
// ============================================================
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const POOL_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const POOL_USER_ID = process.env.MATRIX_BOT_USER_ID;
const MULTI_AGENT_ROOM = process.env.MULTI_AGENT_ROOM;
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;

const AGENTS_DIR = "/workspace/agents";
const WORKSPACE = "/workspace";
const TEMPLATE_WORKSPACE = "/template-workspace";
const ENVIRONMENTS_DIR = "/workspace/environments";
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, "_keys");
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, "index.json");
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, "_tokens");

const { spawn, execFileSync } = require("child_process");
const agentProcesses = new Map(); // id → ChildProcess

const QUIET_DELAY = 10_000;
const MAX_TIMEOUT = 240_000;

// ============================================================
// Process lifecycle (each agent runs as a child process)
// ============================================================
function startAgentProcess(config) {
  const { id, token, userId, environmentId } = config;
  stopAgentProcess(id); // kill existing if any

  const childEnv = {
    ...process.env,
    AGENT_ID: id,
    MATRIX_ACCESS_TOKEN: token,
    MATRIX_BOT_USER_ID: userId,
  };

  // If the agent's environment has a GitHub token attached, expose it as
  // GH_TOKEN so the `gh` CLI authenticates without `gh auth login`.
  // (Also exported as GITHUB_TOKEN for git-over-HTTPS pushes.)
  const env = environmentId ? loadEnvironment(environmentId) : null;
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

  const child = spawn('node', ['/app/agent-runner.js'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

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
  console.log(`[Orchestrator] Started process for agent ${id} (pid ${child.pid})`);
}

function stopAgentProcess(id) {
  const proc = agentProcesses.get(id);
  if (!proc) return;
  proc.kill('SIGTERM');
  agentProcesses.delete(id);
  console.log(`[Orchestrator] Stopped process for agent ${id}`);
}

async function startAllEnabledAgents() {
  for (const id of listAgentIds()) {
    const config = loadAgentConfig(id);
    if (config && config.enabled !== false) {
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

function loadAgentConfig(id) {
  const p = path.join(agentDir(id), "config.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function saveAgentConfig(id, config) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify(config, null, 2));
}

function saveAgentPrompt(id, prompt, role, env) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  // Store raw agent prompt separately for re-merging on updates
  fs.writeFileSync(path.join(dir, "AGENT-PROMPT.md"), prompt);
  // Build merged CLAUDE.md: base workspace instructions + env context + agent role
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), buildAgentClaudeMd(prompt, role, env));
}

// ============================================================
// Environment storage
// ============================================================
function loadEnvironment(envId) {
  if (!envId) return null;
  const p = path.join(ENVIRONMENTS_DIR, envId, "environment.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[Orchestrator] Cannot parse environment ${envId}: ${err.message}`);
    return null;
  }
}

function buildAgentClaudeMd(agentPrompt, role, env) {
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

  let extra = "";
  if (role === "autonomous") {
    extra =
      "\n---\n\n## Trigger-Verwaltung (triggers.json)\n\n" +
      "Du bist ein autonomer Agent. Deine Ausfuehrungen werden durch Trigger gesteuert, " +
      "die in `triggers.json` in deinem Workspace-Root definiert sind. " +
      "Du kannst diese Datei selbst lesen und aendern, um deinen eigenen Zeitplan anzupassen.\n\n" +
      "### Trigger-Typen\n\n" +
      "**Recurring (cron):**\n" +
      "```json\n" +
      "{\n" +
      '  "id": "unique-id",\n' +
      '  "type": "cron",\n' +
      '  "enabled": true,\n' +
      '  "cron": "*/30 * * * *",\n' +
      '  "description": "Beschreibung",\n' +
      '  "prompt": "Was du bei jeder Ausfuehrung tun sollst"\n' +
      "}\n" +
      "```\n" +
      "Cron-Format: `Minute Stunde Tag Monat Wochentag`\n\n" +
      "**Einmalig (once):**\n" +
      "```json\n" +
      "{\n" +
      '  "id": "unique-id",\n' +
      '  "type": "once",\n' +
      '  "enabled": true,\n' +
      '  "at": "2026-04-25T09:00:00",\n' +
      '  "description": "Beschreibung",\n' +
      '  "prompt": "Was du tun sollst"\n' +
      "}\n" +
      "```\n\n" +
      "### Trigger verwalten\n\n" +
      "1. `triggers.json` lesen\n" +
      "2. Trigger hinzufuegen, aendern oder entfernen\n" +
      "3. Datei zurueckschreiben\n" +
      "4. Aenderungen werden automatisch innerhalb von 60 Sekunden uebernommen\n\n" +
      "### Optionale Felder\n\n" +
      "- `roomId` — Ziel-Room fuer die Ausgabe (Standard: Multi-Agent-Room)\n" +
      "- `timeoutSeconds` — Max. Ausfuehrungszeit (Standard: 600)\n\n" +
      "Wenn du bei einer geplanten Ausfuehrung nichts zu berichten hast, antworte mit `[PASS]`.\n";
  }

  let envSection = "";
  if (env) {
    const parts = [];
    if (env.name) parts.push(`**Working Environment:** ${env.name}`);
    if (env.description) parts.push(env.description);
    if (env.repository?.url) {
      const repoName = (env.repository.url.split("/").pop() || "repo").replace(/\.git$/, "");
      parts.push(`**Repository:** \`${env.repository.url}\` — geklont nach \`./${repoName}/\``);
    }
    if (Array.isArray(env.skills) && env.skills.length > 0) {
      parts.push(`**Skills:** ${env.skills.map((s) => `\`${s}\``).join(", ")}`);
    }
    if (env.additionalContext) parts.push(env.additionalContext);
    if (parts.length > 0) {
      envSection = `\n---\n\n## Working Environment\n\n${parts.join("\n\n")}\n`;
    }
  }

  return `${base}\n\n---\n\n${pathNote}${envSection}\n---\n\n## Agent Role\n\n${agentPrompt}${extra}`;
}

function seedAgentWorkspace(id, env) {
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

  // 2. Copy selected skills from the central pool
  const selectedSkills = (env && Array.isArray(env.skills)) ? env.skills : [];
  if (selectedSkills.length > 0) {
    const skillsSrc = path.join(TEMPLATE_WORKSPACE, "skills");
    const skillsDst = path.join(dest, "skills");
    fs.mkdirSync(skillsDst, { recursive: true });
    for (const skillName of selectedSkills) {
      const src = path.join(skillsSrc, skillName);
      const dst = path.join(skillsDst, skillName);
      if (!fs.existsSync(src)) {
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

  // 4. Optional git clone
  let cloneInfo = null;
  if (env && env.repository && env.repository.url) {
    try {
      cloneInfo = cloneRepository(dest, env.repository);
    } catch (err) {
      warnings.push(`git clone: ${err.message}`);
    }
  }

  console.log(`[Orchestrator] Seeded workspace for ${id} (env=${env?.id || "none"}, skills=${selectedSkills.length}${cloneInfo ? `, repo=${cloneInfo.repoName}` : ""})`);
  return { seeded: true, warnings, clone: cloneInfo };
}

function cloneRepository(targetDir, repository) {
  const { url, branch, sshKeyId } = repository;
  if (!url) return null;

  let keyPath = null;
  if (sshKeyId) {
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

  const args = ["clone"];
  if (branch) args.push("--branch", branch);
  args.push("--", url, repoName);

  const env = { ...process.env };
  if (keyPath) {
    env.GIT_SSH_COMMAND = `ssh -i ${keyPath} -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o IdentitiesOnly=yes`;
  }

  try {
    execFileSync("git", args, {
      cwd: targetDir,
      env,
      stdio: "pipe",
      timeout: 120_000,
    });
    console.log(`[Orchestrator] Cloned ${url} → ${repoDir}`);
    return { repoName, skipped: false };
  } catch (err) {
    const stderr = (err.stderr || "").toString();
    const msg = stderr.substring(0, 400) || err.message;
    throw new Error(`git clone failed: ${msg}`);
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

// ============================================================
// Trigger storage (per-agent triggers.json)
// ============================================================
function loadTriggers(id) {
  const p = path.join(agentDir(id), "triggers.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[Triggers] Error loading triggers for ${id}: ${err.message}`);
  }
  return [];
}

function saveTriggers(id, triggers) {
  fs.writeFileSync(
    path.join(agentDir(id), "triggers.json"),
    JSON.stringify(triggers, null, 2)
  );
}

function deleteAgentFiles(id) {
  const dir = agentDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true });
}

function listAgentIds() {
  if (!fs.existsSync(AGENTS_DIR)) return [];
  return fs.readdirSync(AGENTS_DIR).filter((f) =>
    fs.existsSync(path.join(AGENTS_DIR, f, "config.json"))
  );
}

// ============================================================
// Matrix helpers (orchestrator posts as @orchestrator:local)
// ============================================================
async function sendFormatted(client, roomId, text) {
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: marked.parse(text),
  });
}

async function sendPlain(client, roomId, text) {
  await client.sendMessage(roomId, { msgtype: "m.text", body: text });
}

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

async function inviteAndJoin(poolClient, token, roomId) {
  const tmp = new MatrixClient(
    HOMESERVER,
    token,
    new SimpleFsStorageProvider("/tmp/.tmp-" + Date.now() + ".json")
  );
  try {
    const userId = await tmp.getUserId();
    await poolClient.inviteUser(userId, roomId);
    await new Promise((r) => setTimeout(r, 1000));
    await tmp.joinRoom(roomId);
  } catch (err) {
    console.log(`[Orchestrator] Invite/join warning: ${err.message}`);
  }
}

// ============================================================
// Synthesis (orchestrator calls Claude CLI for merging responses)
// ============================================================
const CLAUDE_TIMEOUT = 600_000;

function callClaude(prompt, cwd, timeoutMs = CLAUDE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      [
        "-p", prompt,
        "--output-format", "json",
        "--permission-mode", "acceptEdits",
      ],
      { cwd, env: { ...process.env, HOME: "/root" }, stdio: ["ignore", "pipe", "pipe"] }
    );
    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => { proc.kill("SIGTERM"); reject(new Error("Timeout")); }, timeoutMs);
    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.substring(0, 300) || `Exit ${code}`));
      try {
        const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
        resolve(JSON.parse(lines[lines.length - 1]).result || stdout.trim());
      } catch { resolve(stdout.trim()); }
    });
    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// Orchestrator
// ============================================================
class Orchestrator {
  constructor() {
    this.poolClient = null;
    this.adminClient = null;
    // Map of agentId → { config } (no per-agent Matrix clients — they run in containers)
    this.agentConfigs = new Map();
    this.activeTasks = new Map(); // roomId → activeTask
    this.roomQueues = new Map();  // roomId → [body, ...]
    this.roomBusy = new Set();
    this.startTime = 0;
  }

  async init() {
    this.poolClient = new MatrixClient(
      HOMESERVER,
      POOL_TOKEN,
      new SimpleFsStorageProvider(path.join(WORKSPACE, ".pool-state.json"))
    );
    AutojoinRoomsMixin.setupOnClient(this.poolClient);

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

    // Start all enabled agent containers
    await startAllEnabledAgents();

    this.startTime = Date.now();
    this.poolClient.on("room.message", (r, e) => this.onMessage(r, e));
    await this.poolClient.start();

    console.log(`[Orchestrator] Started as ${POOL_USER_ID}`);
    console.log(`[Orchestrator] Room: ${MULTI_AGENT_ROOM}`);
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

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);

    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, displayName);
    await inviteAndJoin(this.poolClient, token, MULTI_AGENT_ROOM);

    // Seed agent workspace using the chosen environment
    const seedResult = seedAgentWorkspace(id, env);

    const config = {
      id,
      displayName,
      userId,
      token,
      role,
      environmentId: env.id,
      enabled: true,
    };
    saveAgentConfig(id, config);
    saveAgentPrompt(id, systemPrompt, role, env);

    if (role === "autonomous" && extra.schedule && extra.taskPrompt) {
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

    return {
      id,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clone: seedResult.clone || null,
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
    await inviteAndJoin(this.poolClient, token, MULTI_AGENT_ROOM);

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
  // Message routing
  // ===========================================================
  async onMessage(roomId, event) {
    if (event.sender === POOL_USER_ID) return;
    if (event.content?.msgtype !== "m.text") return;
    if (event.origin_server_ts < this.startTime) return;

    const body = event.content.body;
    if (!body) return;

    // Only process messages in the multi-agent room
    if (MULTI_AGENT_ROOM && roomId !== MULTI_AGENT_ROOM) return;

    // Collect expert responses from agent containers (watcher)
    // Agent containers post responses as their Matrix users — we detect them by userId.
    const agentEntry = [...this.agentConfigs.values()].find(
      (a) => a.config.userId === event.sender
    );
    if (agentEntry && this.activeTasks.has(roomId)) {
      const activeTask = this.activeTasks.get(roomId);
      if (
        agentEntry.config.role === "expert" &&
        !activeTask.respondedIds.has(event.sender)
      ) {
        activeTask.respondedIds.add(event.sender);
        activeTask.expertResponses.push({
          name: agentEntry.config.displayName,
          response: body,
        });
        console.log(`[Orchestrator] Expert: ${agentEntry.config.displayName} (${body.length} chars)`);
        this.resetQuietTimer(roomId);
      }
      return;
    }

    // Ignore all bot messages
    if (agentEntry) return;
    const allBotIds = new Set([...this.agentConfigs.values()].map((a) => a.config.userId));
    if (allBotIds.has(event.sender)) return;

    // Human message
    if (body.startsWith("!")) return;

    console.log(`[Orchestrator] Human: ${body.substring(0, 80)}`);
    if (this.roomBusy.has(roomId)) {
      if (!this.roomQueues.has(roomId)) this.roomQueues.set(roomId, []);
      const queue = this.roomQueues.get(roomId);
      if (queue.length >= 5) {
        await sendPlain(this.poolClient, roomId, "Warteschlange voll — bitte warte kurz.");
        return;
      }
      queue.push(body);
      await sendPlain(this.poolClient, roomId, `In Warteschlange (${queue.length}).`);
      return;
    }
    this.roomBusy.add(roomId);
    this.processHumanMessage(roomId, body);
  }

  async processHumanMessage(roomId, body) {
    const allExperts = [...this.agentConfigs.values()].filter(
      (a) => a.config.role === "expert" && a.config.enabled !== false
    );

    // @-mention detection
    const bodyLower = body.toLowerCase();
    const isMentioned = (a) => {
      const name = a.config.displayName.toLowerCase();
      const id = a.config.id.toLowerCase();
      const userId = a.config.userId.toLowerCase();
      return bodyLower.includes(name) || bodyLower.includes(id) || bodyLower.includes(userId);
    };

    // Mentioned autonomous agents respond outside the expert pipeline
    const mentionedAutonomous = [...this.agentConfigs.values()].filter(
      (a) => a.config.role === "autonomous" && a.config.enabled !== false && isMentioned(a)
    );
    if (mentionedAutonomous.length > 0) {
      console.log(`[Orchestrator] Autonomous mentioned: ${mentionedAutonomous.map((a) => a.config.displayName).join(", ")}`);
      // Send a direct Matrix message to each autonomous agent.
      // Their containers will pick it up and respond to the room.
      for (const { config } of mentionedAutonomous) {
        const prompt =
          "Der Nutzer hat dich direkt angesprochen. Antworte auf jeden Fall.\n\n" + body;
        this.sendToAgent(config, roomId, prompt).catch((err) =>
          console.error(`[Orchestrator] Autonomous mention send error (${config.id}): ${err.message}`)
        );
      }
    }

    const mentionedExperts = allExperts.filter(isMentioned);

    // If only autonomous agents mentioned — no expert pipeline needed
    if (mentionedAutonomous.length > 0 && mentionedExperts.length === 0) {
      this.drainQueue(roomId);
      return;
    }

    if (allExperts.length === 0) {
      await sendPlain(this.poolClient, roomId,
        "Keine Experten-Agenten aktiv. Lege welche in der Admin Console an.");
      this.drainQueue(roomId);
      return;
    }

    // Directly mentioned experts or all experts
    const experts = mentionedExperts.length > 0 ? mentionedExperts : allExperts;
    if (mentionedExperts.length > 0) {
      console.log(`[Orchestrator] Mentioned: ${mentionedExperts.map((a) => a.config.displayName).join(", ")}`);
    }

    const isDirect = mentionedExperts.length > 0;

    const task = {
      originalTask: body,
      roomId,
      expertResponses: [],
      respondedIds: new Set(),
      // Track how many agents we sent to — for all-passed detection
      sentToIds: new Set(experts.map((a) => a.config.userId)),
      quietTimer: null,
      maxTimer: null,
    };
    this.activeTasks.set(roomId, task);

    // Send the message to each targeted expert agent via Matrix.
    // The agent-runner.js in each container receives this and calls Claude,
    // then posts the response back to the room — which we collect in onMessage.
    for (const { config } of experts) {
      const prompt = isDirect
        ? `Der Nutzer hat dich direkt angesprochen. Antworte auf jeden Fall, auch wenn das Thema nicht dein Kerngebiet ist.\n\n${body}`
        : body;
      console.log(`[Orchestrator] Routing to: ${config.displayName}${isDirect ? " (direct)" : ""}`);
      this.sendToAgent(config, roomId, prompt).catch((err) =>
        console.error(`[Orchestrator] Route error (${config.id}): ${err.message}`)
      );
    }

    task.maxTimer = setTimeout(() => this.triggerSynthesis(roomId), MAX_TIMEOUT);
  }

  // Send a routing message to an agent via Matrix (plain text, not formatted,
  // so agent-runner can extract the prompt cleanly).
  async sendToAgent(config, roomId, prompt) {
    // We send as the orchestrator to the multi-agent room.
    // The agent-runner recognizes the message is directed at it via @-mention or
    // broadcast (no agent mentioned). Here we send a system-formatted dispatch
    // that the runner will recognize as a routing directive.
    //
    // Format: ROUTE:<agentUserId>:<base64-encoded-prompt>
    // This ensures the runner can distinguish orchestrator routing from human chat
    // without ambiguity.
    const encoded = Buffer.from(prompt).toString("base64");
    await this.poolClient.sendMessage(roomId, {
      msgtype: "m.text",
      body: `ROUTE:${config.userId}:${encoded}`,
    });
  }

  checkAllDone(roomId) {
    const activeTask = this.activeTasks.get(roomId);
    if (!activeTask) return;

    // If all experts we sent to have responded (or passed via [PASS] suppression),
    // we won't get further messages. The quietTimer handles the window.
    // This method is kept for symmetry but the quietTimer/maxTimer drive synthesis.
  }

  drainQueue(roomId) {
    const queue = this.roomQueues.get(roomId);
    if (!queue || queue.length === 0) {
      this.roomQueues.delete(roomId);
      this.roomBusy.delete(roomId);
      console.log(`[Orchestrator] Pipeline done for ${roomId}`);
      return;
    }
    const next = queue.shift();
    console.log(`[Orchestrator] Draining queue for ${roomId} (${queue.length} remaining)`);
    this.processHumanMessage(roomId, next);
  }

  resetQuietTimer(roomId) {
    const activeTask = this.activeTasks.get(roomId);
    if (!activeTask) return;
    if (activeTask.quietTimer) clearTimeout(activeTask.quietTimer);

    const enabledExperts = [...this.agentConfigs.values()].filter(
      (a) => a.config.role === "expert" && a.config.enabled !== false
    );
    const allResponded = enabledExperts.every((a) =>
      activeTask.respondedIds.has(a.config.userId)
    );
    activeTask.quietTimer = setTimeout(
      () => this.triggerSynthesis(roomId),
      allResponded ? 5_000 : QUIET_DELAY
    );
  }

  async triggerSynthesis(roomId) {
    const task = this.activeTasks.get(roomId);
    if (!task) return;
    this.activeTasks.delete(roomId);
    if (task.quietTimer) clearTimeout(task.quietTimer);
    if (task.maxTimer) clearTimeout(task.maxTimer);

    if (task.expertResponses.length === 0) {
      console.log("[Orchestrator] All experts passed — sending fallback");
      sendPlain(this.poolClient, roomId,
        "Keiner der Experten konnte zu diesem Thema beitragen. Lege einen passenden Experten in der Admin Console an.");
      this.drainQueue(roomId);
      return;
    }

    if (task.expertResponses.length <= 1) {
      console.log("[Orchestrator] Synthesis not needed (single expert)");
      this.drainQueue(roomId);
      return;
    }

    const synth = [...this.agentConfigs.values()].find(
      (a) => a.config.role === "synthesizer" && a.config.enabled !== false
    );
    if (!synth) {
      console.log("[Orchestrator] No synthesizer configured");
      this.drainQueue(roomId);
      return;
    }

    console.log(`[Orchestrator] Synthesizing ${task.expertResponses.length} responses...`);
    const context = task.expertResponses
      .map((r) => `### ${r.name}\n${r.response}`)
      .join("\n\n");

    try {
      const result = await callClaude(
        `Experten haben auf folgende Frage geantwortet. Fasse zusammen.\n\nFrage: ${task.originalTask}\n\nAntworten:\n${context}\n\nRegeln: Einleitungssatz, Vergleichstabelle wenn sinnvoll, max 1500 Zeichen, Sprache der Frage. Falls kein Mehrwert: [PASS]`,
        agentDir(synth.config.id)
      );
      if (result.trim().startsWith("[PASS]")) {
        console.log("[Orchestrator] Synthesis: PASS");
      } else {
        // Post synthesis as the orchestrator (could also be posted as synth agent user
        // by sending a ROUTE message — keeping it simple: orchestrator posts directly)
        await sendFormatted(this.poolClient, roomId, result);
        console.log(`[Orchestrator] Synthesis: ${result.length} chars`);
      }
    } catch (err) {
      console.error(`[Orchestrator] Synthesis error: ${err.message}`);
    } finally {
      this.drainQueue(roomId);
    }
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!HOMESERVER || !POOL_TOKEN) {
    console.error("MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN required");
    process.exit(1);
  }
  const orchestrator = new Orchestrator();
  await orchestrator.init();

  // Internal API — used by admin-console to manage agents
  const internalApi = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/internal/agents/processes') {
      const processes = [];
      for (const [id, proc] of agentProcesses) {
        processes.push({ id, pid: proc.pid, running: !proc.exitCode && !proc.killed });
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(processes));
      return;
    }

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
          stopAgentProcess(id);
          deleteAgentFiles(id);
          await orchestrator.deactivateMatrixUser(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
      return;
    }

    if (req.method !== 'POST' || req.url !== '/internal/agents') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt } = JSON.parse(body);
        if (!id || !displayName || !role || !systemPrompt || !environmentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, displayName, role, systemPrompt, environmentId required' }));
          return;
        }
        if (loadAgentConfig(id)) {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Agent '${id}' already exists` }));
          return;
        }
        const extra = role === 'autonomous' ? { schedule, taskPrompt } : {};
        const result = await orchestrator.createAgent(id, displayName, role, systemPrompt, environmentId, extra);
        res.writeHead(201, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error(`[Orchestrator] Internal API create error: ${err.message}`);
        const statusCode = /not found/i.test(err.message) ? 400 : 500;
        res.writeHead(statusCode, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  internalApi.listen(4002, '0.0.0.0', () =>
    console.log('[Orchestrator] Internal API listening on :4002')
  );
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
