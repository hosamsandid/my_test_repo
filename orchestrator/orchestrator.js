'use strict';

const {
  MatrixClient,
  SimpleFsStorageProvider,
} = require("matrix-bot-sdk");
const http = require("http");
const fs = require("fs");
const path = require("path");
const bpEventRouter = require("./bp-event-router");

// ============================================================
// Config
// ============================================================
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;
const BP_EXPLORER_URL = process.env.BP_EXPLORER_URL || "http://bp-explorer:8765";

const AGENTS_DIR = "/workspace/agents";
const BLUEPRINTS_DIR = "/workspace/blueprints";
const WORKSPACE = "/workspace";
const TEMPLATE_WORKSPACE = "/template-workspace";
const ENVIRONMENTS_DIR = "/workspace/environments";
const SSH_KEYS_DIR = path.join(ENVIRONMENTS_DIR, "_keys");
const SSH_KEYS_INDEX = path.join(SSH_KEYS_DIR, "index.json");
const GH_TOKENS_DIR = path.join(ENVIRONMENTS_DIR, "_tokens");
const LLM_ENDPOINTS_INDEX = "/workspace/llm-endpoints/index.json";
const LLM_KEYS_DIR = "/workspace/llm-endpoints/_keys";

// Resolve the LLM binding for an environment:
//  - reads /workspace/llm-endpoints/index.json
//  - looks up env.llmEndpointId
//  - reads the auth token from _keys/<authTokenId>
// Returns { baseUrl, token, defaultModelId } or null if the env has no
// binding or the endpoint is missing — in that case the caller falls back to
// the global ANTHROPIC_* env vars from `.env`.
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
    defaultModelId: env.defaultModelId || null,
  };
}

const { spawn, execFile, execFileSync } = require("child_process");
const crypto = require("crypto");

function randomHex(bytes) {
  return crypto.randomBytes(bytes).toString("hex");
}
const agentProcesses = new Map(); // id → ChildProcess

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

  const child = spawn('node', ['/app/agent-runner.js'], {
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
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

function stopAgentSession(id) {
  const proc = agentProcesses.get(id);
  if (!proc) return false;
  try {
    proc.send({ type: 'stop-session' });
    console.log(`[Orchestrator] Sent stop-session to agent ${id}`);
    return true;
  } catch (err) {
    console.error(`[Orchestrator] stopAgentSession ${id}: ${err.message}`);
    return false;
  }
}

async function startAllEnabledAgents() {
  for (const id of listAgentIds()) {
    const config = loadAgentConfig(id);
    // Skip pure-config orchestrators (created via POST /internal/agents/create
    // without a Matrix user). Blueprint-instance orchestrators DO carry a token
    // and need to be respawned on container restart just like experts.
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
    "\n---\n\n## Trigger-Verwaltung (triggers.json)\n\n" +
    "Deine Ausfuehrungen koennen durch Trigger gesteuert werden, " +
    "die in `triggers.json` in deinem Workspace-Root definiert sind. " +
    "Du kannst diese Datei selbst lesen und aendern, um deinen Zeitplan anzupassen.\n\n" +
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
    "- `roomId` — Ziel-Room fuer die Ausgabe (Standard: Direct-Message-Room mit dem Admin)\n" +
    "- `timeoutSeconds` — Max. Ausfuehrungszeit (Standard: 3600)\n\n" +
    "Wenn du bei einer geplanten Ausfuehrung nichts zu berichten hast, antworte mit `[PASS]`.\n";

  let envSection = "";
  if (env) {
    const parts = [];
    if (env.name) parts.push(`**Working Environment:** ${env.name}`);
    if (env.description) parts.push(env.description);
    const repos = Array.isArray(env.repositories) ? env.repositories : [];
    if (repos.length === 1) {
      const repoName = (repos[0].url.split("/").pop() || "repo").replace(/\.git$/, "");
      parts.push(`**Repository:** \`${repos[0].url}\` — geklont nach \`./${repoName}/\``);
    } else if (repos.length > 1) {
      const lines = repos.map(r => {
        const repoName = (r.url.split("/").pop() || "repo").replace(/\.git$/, "");
        return `- \`${r.url}\` — geklont nach \`./${repoName}/\``;
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

  // 4. Optional git clone(s)
  const clones = cloneEnvironmentRepositories(dest, env, warnings);

  const cloneSummary = clones.length > 0 ? `, repos=${clones.map(c => c.repoName).join(",")}` : "";
  console.log(`[Orchestrator] Seeded workspace for ${id} (env=${env?.id || "none"}, skills=${selectedSkills.length}${cloneSummary})`);
  return { seeded: true, warnings, clones };
}

// Clone every repository attached to an environment. Errors are pushed to the
// shared warnings list so one failed clone never aborts the rest of the seed.
function cloneEnvironmentRepositories(targetDir, env, warnings) {
  const repos = Array.isArray(env?.repositories) ? env.repositories : [];
  const results = [];
  for (const repo of repos) {
    if (!repo?.url) continue;
    try {
      const info = cloneRepository(targetDir, repo);
      if (info) results.push(info);
    } catch (err) {
      warnings.push(`git clone (${repo.url}): ${err.message}`);
    }
  }
  return results;
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
  const workspace = path.join("/workspace/agents", orchestratorId, rel);
  if (!fs.existsSync(path.join(workspace, ".git"))) {
    return { skipped: "not-a-git-repo" };
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
      cwd: workspace, env: gitEnv, stdio: "pipe", timeout: 30_000,
    });
    execFileSync("git", ["pull", "--ff-only"], {
      cwd: workspace, env: gitEnv, stdio: "pipe", timeout: 30_000,
    });
    return { pulled: true };
  } catch (err) {
    const detail = (err.stderr || err.stdout || err.message || "").toString().trim().slice(0, 200);
    console.warn(`[Orchestrator] Pull failed for ${orchestratorId}: ${detail}`);
    return { failed: true, detail };
  }
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

// Append a bp-event-batch entry to an agent's pending-triggers.json. The
// agent-runner drain loop picks it up by `kind` (no triggers.json entry
// required — the routing decision was already made centrally). Creates
// the agent dir if it doesn't exist yet (a stub being materialised at
// the same time may not have written its dir yet).
function enqueueBpEventBatch(agentId, payload) {
  const pendingPath = path.join(AGENTS_DIR, agentId, "pending-triggers.json");
  let pending = [];
  try {
    if (fs.existsSync(pendingPath)) pending = JSON.parse(fs.readFileSync(pendingPath, "utf8"));
    if (!Array.isArray(pending)) pending = [];
  } catch { /* corrupt file — start over */ }
  pending.push({
    kind: "bp-event-batch",
    receivedAt: new Date().toISOString(),
    ...payload,
  });
  try {
    fs.mkdirSync(path.dirname(pendingPath), { recursive: true });
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));
  } catch (err) {
    console.error(`[Orchestrator] Cannot enqueue bp-event for ${agentId}: ${err.message}`);
  }
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
    const detail = await res.text().catch(() => "");
    throw new Error(`bp-explorer ${res.status}: ${detail.slice(0, 200)}`);
  }
  const data = await res.json();
  return Array.isArray(data) ? data : [];
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
    `## Closing the loop — always use bp-transition.py`,
    ``,
    `Whenever your work effectively changes the BP's lifecycle state (you finished it, or you reworked already-completed output), close the loop with the canonical ACE transition script — never edit \`brief.md\` frontmatter (\`status\`, \`revision\`, \`agent-id\`, \`completed\`, \`stale-because\`) by hand. The script regenerates \`.index.json\`, commits with the right message format, and — critically — signals the AEE orchestrator so downstream BPs (depends-on dependents and input-artifact dependents) get woken up and notified automatically.`,
    ``,
    `- **Finished a structured run or finished meaningful dynamic-mode work that fulfils the brief:**`,
    `  \`python3 scripts/bp-transition.py complete ${cfg.bpId.slice(0, 6)} --push\``,
    `- **Reworked output of an already completed/reviewed BP** (substantive change a downstream BP would care about):`,
    `  \`python3 scripts/bp-transition.py revise ${cfg.bpId.slice(0, 6)} --reason "..." --push\``,
    ``,
    `If you're unsure whether your dynamic-mode change is "substantive enough" to warrant a revise: ask the user. Skipping the transition silently means downstream agents stay unaware. The signal is best-effort and never blocks — running it costs nothing, omitting it costs propagation.`,
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

    // expert-group: save a template config (no Matrix user, no process) and
    // immediately materialize the first instance.
    if (role === "expert-group") {
      const groupConfig = {
        id,
        displayName,
        role: "expert-group",
        environmentId: env.id,
        systemPromptTemplate: systemPrompt || "",
        enabled: true,
      };
      saveAgentConfig(id, groupConfig);
      this.agentConfigs.set(id, { config: groupConfig });
      console.log(`[Orchestrator] Created expert-group ${id}`);

      const instance = await this.addGroupInstance(id);
      return { id, group: true, firstInstance: instance.id };
    }

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);

    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, displayName);

    // Seed agent workspace using the chosen environment
    const seedResult = seedAgentWorkspace(id, env);

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
      ...(role === "orchestrator" && extra.briefingsPath && { briefingsPath: extra.briefingsPath }),
      enabled: true,
    };
    saveAgentConfig(id, config);
    saveAgentPrompt(id, effectivePrompt, role, env);

    if (extra.schedule && extra.taskPrompt) {
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

  // Add a new expert-instance to an existing expert-group. The instance is
  // immediately materialized (Matrix user + workspace + agent process).
  // Instance IDs are auto-numbered: {groupId}-1, {groupId}-2, …
  async addGroupInstance(groupId) {
    const groupCfg = loadAgentConfig(groupId);
    if (!groupCfg) throw new Error(`Expert group '${groupId}' not found`);
    if (groupCfg.role !== "expert-group") {
      throw new Error(`Agent '${groupId}' is not an expert-group (role=${groupCfg.role})`);
    }

    const env = loadEnvironment(groupCfg.environmentId);
    if (!env) throw new Error(`Working Environment '${groupCfg.environmentId}' not found`);

    // Determine next available instance number and immediately reserve the
    // slot by writing a placeholder config. This prevents a TOCTOU race where
    // two concurrent POST /instances requests both compute the same n before
    // either saveAgentConfig call runs.
    let n = 1;
    while (loadAgentConfig(`${groupId}-${n}`)) n++;
    const instanceId = `${groupId}-${n}`;
    const instanceDisplayName = `${groupCfg.displayName} #${n}`;

    saveAgentConfig(instanceId, {
      id: instanceId,
      displayName: instanceDisplayName,
      role: "expert-instance",
      parentGroupId: groupId,
      environmentId: groupCfg.environmentId,
      enabled: false,
      _provisioning: true,
    });

    const password = `agent-${instanceId}-${Date.now()}`;
    const userId = `@${instanceId}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, instanceId, password);
    const token = await loginMatrixUser(instanceId, password);
    await setDisplayName(token, userId, instanceDisplayName);

    const seedResult = seedAgentWorkspace(instanceId, env);

    const instanceConfig = {
      id: instanceId,
      displayName: instanceDisplayName,
      userId,
      token,
      role: "expert-instance",
      parentGroupId: groupId,
      environmentId: groupCfg.environmentId,
      enabled: true,
    };
    saveAgentConfig(instanceId, instanceConfig);
    saveAgentPrompt(instanceId, groupCfg.systemPromptTemplate || "", "expert-instance", env);

    this.agentConfigs.set(instanceId, { config: instanceConfig });
    startAgentProcess(instanceConfig);

    console.log(`[Orchestrator] Created expert-instance ${instanceId} (group=${groupId})`);
    return {
      id: instanceId,
      userId,
      seeded: seedResult.seeded,
      warnings: seedResult.warnings || [],
      clones: seedResult.clones || [],
    };
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

      // .index.json lives inside the orchestrator's clone of the briefings repo.
      // Force-pull first so a signal from a just-pushed agent isn't misrouted
      // against a stale local index. Pull failures are non-fatal — we fall
      // back to whatever .index.json is currently on disk. Forced pulls still
      // coalesce within _PULL_FORCE_THROTTLE_MS so a burst of bp-events from
      // several agents in quick succession doesn't multiply git operations.
      const briefingsPath = (orchCfg.briefingsPath || "").replace(/^\/+|\/+$/g, "");
      const env = loadEnvironment(orchCfg.environmentId);
      if (env) {
        pullOrchestratorWorkspace(orchId, briefingsPath, env, { force: true });
      }

      const indexPath = path.join(
        AGENTS_DIR, orchId, briefingsPath, "artifacts/briefings/.index.json"
      );

      let briefings;
      try {
        briefings = bpEventRouter.loadIndex(indexPath);
      } catch (err) {
        console.warn(`[Orchestrator] BP-events: cannot load index for ${orchId}: ${err.message}`);
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
      const targets = [];
      for (const [affectedBp, reasons] of perAffectedBp) {
        const dst = bpHashToStub.get(affectedBp);
        if (!dst) {
          skipped.push({ bp: affectedBp, reason: "no-stub-for-affected-bp" });
          continue;
        }
        targets.push({
          agentId: dst.stubId,
          role: "bp-instance",
          affectedBp,
          reasons,
        });
      }
      if (perAffectedBp.size > 0) {
        targets.push({
          agentId: orchId,
          role: "orchestrator",
          affectedBp: null,
          reasons: [...perAffectedBp.entries()].map(([bp, rs]) => ({
            kind: "downstream-affected", bp, reasons: rs,
          })),
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
    const respectManualDisable = policy["respect-manual-disable"] === true;

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
      reasons: target.reasons,
    });

    return {
      agentId: target.agentId,
      action: "enqueued",
      role: target.role,
      affectedBp: target.affectedBp,
      materialized: isStub && mode !== "notify-only",
    };
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
      startAgentProcess(updated);
      return { id, materialized: false, enabled: true };
    }

    // Stub: full materialization.
    if (cfg.role !== "bp-instance" && cfg.role !== "expert-instance") {
      throw new Error(`Agent '${id}' is a stub but has unexpected role '${cfg.role}'`);
    }
    const env = loadEnvironment(cfg.environmentId);
    if (!env) throw new Error(`Working Environment '${cfg.environmentId}' not found`);

    const password = `agent-${id}-${Date.now()}`;
    const userId = `@${id}:local`;

    if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);
    const token = await loginMatrixUser(id, password);
    await setDisplayName(token, userId, cfg.displayName);

    const seedResult = seedAgentWorkspace(id, env);

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
      // expert-instance: restore the system prompt from the parent group template.
      const groupCfg = cfg.parentGroupId ? loadAgentConfig(cfg.parentGroupId) : null;
      if (!groupCfg) {
        console.warn(`[Orchestrator] expert-instance ${id}: parent group '${cfg.parentGroupId}' not found — reactivating with empty system prompt`);
      }
      const template = groupCfg?.systemPromptTemplate || "";
      saveAgentPrompt(id, template, "expert-instance", env);
      console.log(`[Orchestrator] Materialized expert-instance ${id} (group=${cfg.parentGroupId})`);
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

  // Disable an agent: stop its process, mark enabled=false. Keeps token and
  // workspace intact so it can be re-enabled with a single click.
  async disableAgent(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);
    stopAgentProcess(id);
    const updated = { ...cfg, enabled: false };
    saveAgentConfig(id, updated);
    this.agentConfigs.set(id, { config: updated });
    return { id, enabled: false };
  }

  // Reset an agent back to its stub state: stop the process, deactivate the
  // Matrix user (best-effort), wipe the workspace, and strip the config of
  // any runtime identity (token, userId). The stub config keeps just the
  // metadata needed to re-activate later.
  //
  // Destructive — caller is expected to have confirmed with the user.
  async deactivateAgent(id) {
    const cfg = loadAgentConfig(id);
    if (!cfg) throw new Error(`Agent '${id}' not found`);

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
      ...(cfg.parentGroupId && { parentGroupId: cfg.parentGroupId }),
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
}

// ============================================================
// Main
// ============================================================
async function main() {
  if (!HOMESERVER) {
    console.error("MATRIX_HOMESERVER required");
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
        if (!url || url.startsWith('-')) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: 'url is required' }));
          return;
        }
        const cmdEnv = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
        if (sshKeyId) {
          const keyPath = path.join(SSH_KEYS_DIR, sshKeyId);
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
        execFile(
          'git',
          ['ls-remote', '--exit-code', '--heads', '--', url],
          { env: cmdEnv, timeout: 12_000, maxBuffer: 1024 * 1024 },
          (err, _stdout, stderr) => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            if (!err) {
              res.end(JSON.stringify({ ok: true }));
              return;
            }
            const detail = (stderr || err.message || '').toString().trim();
            const firstLine = detail.split('\n').find(l => l.trim()) || 'git ls-remote failed';
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
          if (!systemPrompt && role !== 'orchestrator') {
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
            role: 'expert',
            environmentId: env.id,
            ephemeral: true,
            enabled: true,
            ...(blueprintId && { blueprintId }),
          };
          saveAgentConfig(agentId, config);
          saveAgentPrompt(agentId, systemPrompt, 'expert', env, blueprintId || null);

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

    // ── Poll agent status ─────────────────────────────────────────────────
    const pollMatch = req.method === 'GET' && req.url.match(/^\/internal\/agents\/([^/]+)\/poll$/);
    if (pollMatch) {
      const id = decodeURIComponent(pollMatch[1]);
      if (!fs.existsSync(agentDir(id))) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Agent not found' }));
        return;
      }
      const statusPath = path.join(agentDir(id), 'status.json');
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
        const sessionsDir = path.join(agentDir(id), 'sessions');
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

    // ── BP-event router ──────────────────────────────────────────────────
    // Single ingestion point for BP signals from any source (bp-transition.py
    // hooks, future GitHub-poller diff, etc.). The signaling agent does not
    // do reverse-dep lookups itself — it just announces what changed. The
    // orchestrator process decides routing, materialization, activation.
    if (req.method === 'POST' && req.url === '/internal/bp-events') {
      let body = '';
      let tooLarge = false;
      req.on('data', (d) => {
        if (tooLarge) return;
        body += d;
        // Soft limit. Stop appending so memory stays bounded, but let the
        // request finish so we can still send a proper 413. (req.destroy()
        // would prevent the 'end' callback from firing — the client would
        // see a connection reset instead of a structured error.)
        if (body.length > 1_000_000) {
          tooLarge = true;
          body = '';
        }
      });
      req.on('end', () => {
        if (tooLarge) {
          res.writeHead(413, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'payload too large (max 1 MB)' }));
          return;
        }
        let parsed;
        try { parsed = JSON.parse(body || '{}'); }
        catch { parsed = null; }
        if (!parsed || typeof parsed !== 'object') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'invalid JSON body' }));
          return;
        }
        (async () => {
          try {
            const result = await orchestrator.routeBpEvents(parsed);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch (err) {
            console.error(`[Orchestrator] routeBpEvents error: ${err.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: err.message }));
          }
        })();
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
      (async () => {
        try {
          const result = await orchestrator.disableAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] disableAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
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
      (async () => {
        try {
          const result = await orchestrator.deactivateAgent(id);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] deactivateAgent error for ${id}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err.message }));
        }
      })();
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
          const status = /not found/i.test(err.message) ? 404 : 500;
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

    const reloadTriggersMatch = req.method === 'POST' && req.url.match(/^\/internal\/agents\/([^/]+)\/reload-triggers$/);
    if (reloadTriggersMatch) {
      const id = decodeURIComponent(reloadTriggersMatch[1]);
      const proc = agentProcesses.get(id);
      if (proc) {
        proc.send({ type: 'reload-triggers' });
        console.log(`[Orchestrator] Sent reload-triggers to agent ${id}`);
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
        const branch = repo.branch || 'main';
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

    // POST /internal/agent-groups/:groupId/instances — add instance to group
    const addInstanceMatch = req.method === 'POST' && req.url.match(/^\/internal\/agent-groups\/([^/]+)\/instances$/);
    if (addInstanceMatch) {
      const groupId = decodeURIComponent(addInstanceMatch[1]);
      (async () => {
        try {
          const result = await orchestrator.addGroupInstance(groupId);
          res.writeHead(201, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        } catch (err) {
          console.error(`[Orchestrator] addGroupInstance error for ${groupId}: ${err.message}`);
          const status = /not found/i.test(err.message) ? 404 : /not an expert-group/i.test(err.message) ? 400 : 500;
          res.writeHead(status, { 'Content-Type': 'application/json' });
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
        const { id, displayName, role, systemPrompt, environmentId, schedule, taskPrompt, briefingsPath } = JSON.parse(body);
        if (!id || !displayName || !role || !environmentId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, displayName, role, environmentId required' }));
          return;
        }
        if (!['expert', 'orchestrator', 'expert-group'].includes(role)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: `Invalid role: ${role}. Must be one of: expert, orchestrator, expert-group` }));
          return;
        }
        if (role !== 'orchestrator' && !systemPrompt) {
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

    let triggers = [];
    try {
      const tp = path.join(agentDir, 'triggers.json');
      if (fs.existsSync(tp)) triggers = JSON.parse(fs.readFileSync(tp, 'utf8'));
    } catch {}

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

    const pendingPath = path.join(agentDir, 'pending-triggers.json');
    let pending = [];
    try {
      if (fs.existsSync(pendingPath)) pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
      if (!Array.isArray(pending)) pending = [];
    } catch {}
    pending.push({ triggerId: hookId, receivedAt: new Date().toISOString() });
    fs.writeFileSync(pendingPath, JSON.stringify(pending, null, 2));

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
  });
  ghPoller.start();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
