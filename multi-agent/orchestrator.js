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
const cron = require("node-cron");

// ============================================================
// Config
// ============================================================
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const POOL_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const POOL_USER_ID = process.env.MATRIX_BOT_USER_ID;
const MULTI_AGENT_ROOM = process.env.MULTI_AGENT_ROOM;
const ADMIN_USER = process.env.ADMIN_USER_ID || "@thorsten:local";
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;

const AGENTS_DIR = "/workspace/agents";
const WORKSPACE = "/workspace";
const TEMPLATE_WORKSPACE = "/template-workspace";

const { spawn } = require("child_process");
const agentProcesses = new Map(); // id → ChildProcess

const QUIET_DELAY = 10_000;
const MAX_TIMEOUT = 240_000;
const WIZARD_TIMEOUT = 300_000; // 5 min

// Files/dirs to skip when seeding agent workspace from template
const SEED_EXCLUDE = new Set([
  ".matrix-state.json",
  ".sessions.json",
  ".pool-state.json",
  "jobs.json",
  "agents",
]);

// ============================================================
// Process lifecycle (each agent runs as a child process)
// ============================================================
function startAgentProcess(config) {
  const { id, token, userId } = config;
  stopAgentProcess(id); // kill existing if any

  const child = spawn('node', ['/app/agent-runner.js'], {
    env: {
      ...process.env,
      AGENT_ID: id,
      MATRIX_ACCESS_TOKEN: token,
      MATRIX_BOT_USER_ID: userId,
    },
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

function saveAgentPrompt(id, prompt, role) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  // Store raw agent prompt separately for re-merging on updates
  fs.writeFileSync(path.join(dir, "AGENT-PROMPT.md"), prompt);
  // Build merged CLAUDE.md: base workspace instructions + agent role
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), buildAgentClaudeMd(prompt, role));
}

function buildAgentClaudeMd(agentPrompt, role) {
  const templatePath = path.join(TEMPLATE_WORKSPACE, "CLAUDE.md");
  let base = "";
  try {
    if (fs.existsSync(templatePath)) {
      base = fs.readFileSync(templatePath, "utf8");
    }
  } catch (err) {
    console.log(`[Orchestrator] Could not read template CLAUDE.md: ${err.message}`);
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

  return `${base}\n\n---\n\n${pathNote}\n---\n\n## Agent Role\n\n${agentPrompt}${extra}`;
}

function seedAgentWorkspace(id) {
  const dest = agentDir(id);
  fs.mkdirSync(dest, { recursive: true });

  if (!fs.existsSync(TEMPLATE_WORKSPACE)) {
    console.log(`[Orchestrator] Template workspace not available — skipping seed for ${id}`);
    return false;
  }

  let entries;
  try {
    entries = fs.readdirSync(TEMPLATE_WORKSPACE);
  } catch (err) {
    console.log(`[Orchestrator] Cannot read template workspace: ${err.message}`);
    return false;
  }

  let copied = 0;
  for (const entry of entries) {
    if (SEED_EXCLUDE.has(entry)) continue;
    if (entry.startsWith(".agent-state-")) continue;
    const src = path.join(TEMPLATE_WORKSPACE, entry);
    const dst = path.join(dest, entry);
    try {
      fs.cpSync(src, dst, { recursive: true });
      copied++;
    } catch (err) {
      console.log(`[Orchestrator] Seed copy warning (${entry}): ${err.message}`);
    }
  }
  // Rewrite absolute /workspace/ paths in seeded memory files
  patchSeededPaths(dest);

  console.log(`[Orchestrator] Seeded workspace for ${id} from template (${copied} entries)`);
  return true;
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
// Wizard
// ============================================================
function wizardPrompt(step, ctx) {
  switch (step) {
    case "add:id":
      return "**Neuer Agent (1/4)**\nWie soll die ID sein? (Kleinbuchstaben, keine Leerzeichen, z.B. `cobol-expert`)";
    case "add:name":
      return `**Neuer Agent (2/4)**\nAnzeigename fuer \`${ctx.id}\`? (z.B. \`COBOL Expert\`)`;
    case "add:role":
      return "**Neuer Agent (3/?)**\nWelche Rolle?\n- `expert` — antwortet autonom auf Nutzerfragen\n- `synthesizer` — fasst Experten-Ergebnisse zusammen\n- `autonomous` — arbeitet selbstaendig im Hintergrund nach Zeitplan";
    case "add:schedule":
      return `**Neuer Agent (4/6)**\nZeitplan fuer \`${ctx.id}\`?\n\nBeispiele:\n- \`*/30 * * * *\` — alle 30 Minuten\n- \`0 * * * *\` — jede Stunde\n- \`0 9 * * *\` — taeglich um 9:00\n- \`0 */4 * * *\` — alle 4 Stunden`;
    case "add:taskPrompt":
      return "**Neuer Agent (5/6)**\nWas soll der Agent bei jedem Durchlauf tun?\n\nDas ist der Prompt, der bei jeder geplanten Ausfuehrung an Claude geschickt wird.\n\n*Tipp: Beschreibe die konkrete Aufgabe, z.B. \"Pruefe alle offenen Tickets auf Qualitaetskriterien...\"*";
    case "add:prompt":
      return `**Neuer Agent (${ctx.role === "autonomous" ? "6/6" : "4/4"})**\nSchicke jetzt den System-Prompt.\nDas ist die Anweisung, die dem Agent sagt, wie er sich verhalten soll.\n\n*Tipp: Starte mit \`# Rollenname\` und beschreibe Verhalten, Grenzen und Ausgabeformat.*`;
    case "update:pick":
      return `**Agent aktualisieren**\nWelchen Agent? Schreibe die ID.\n\n${ctx.list}`;
    case "update:prompt":
      return `**Neuer Prompt fuer \`${ctx.id}\`**\nSchicke den neuen System-Prompt:`;
    case "delete:pick":
      return `**Agent loeschen**\nWelchen Agent? Schreibe die ID.\n\n${ctx.list}`;
    case "delete:confirm":
      return `Agent **${ctx.displayName}** (\`${ctx.id}\`) wirklich loeschen? Schreibe \`ja\` oder \`nein\`.`;
    default:
      return "?";
  }
}

function agentListMarkdown() {
  const ids = listAgentIds();
  if (ids.length === 0) return "_Keine Agenten vorhanden._";
  return ids
    .map((id) => {
      const c = loadAgentConfig(id);
      return `- \`${id}\` — ${c.displayName} (${c.role})`;
    })
    .join("\n");
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
    this.wizard = null; // { step, ctx, timer }
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
  // Wizard flow
  // ===========================================================
  startWizard(roomId, step, ctx = {}) {
    if (this.wizard?.timer) clearTimeout(this.wizard.timer);
    this.wizard = {
      step,
      ctx: { ...ctx, roomId },
      timer: setTimeout(() => {
        this.wizard = null;
        sendPlain(this.poolClient, roomId, "Wizard abgebrochen (Timeout).");
      }, WIZARD_TIMEOUT),
    };
  }

  cancelWizard() {
    if (this.wizard?.timer) clearTimeout(this.wizard.timer);
    this.wizard = null;
  }

  async handleWizardStep(roomId, body) {
    const w = this.wizard;
    const text = body.trim();

    switch (w.step) {
      // --- ADD ---
      case "add:id": {
        const id = text.toLowerCase().replace(/[^a-z0-9-]/g, "");
        if (!id) {
          await sendPlain(this.poolClient, roomId, "Ungueltige ID. Nur a-z, 0-9, Bindestrich. Nochmal:");
          return;
        }
        if (loadAgentConfig(id)) {
          await sendPlain(this.poolClient, roomId, `\`${id}\` existiert bereits. Andere ID waehlen:`);
          return;
        }
        w.ctx.id = id;
        w.step = "add:name";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("add:name", w.ctx));
        return;
      }
      case "add:name": {
        w.ctx.displayName = text;
        w.step = "add:role";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("add:role", w.ctx));
        return;
      }
      case "add:role": {
        const role = text.toLowerCase();
        if (role !== "expert" && role !== "synthesizer" && role !== "autonomous") {
          await sendPlain(this.poolClient, roomId, "Bitte `expert`, `synthesizer` oder `autonomous` eingeben:");
          return;
        }
        w.ctx.role = role;
        if (role === "autonomous") {
          w.step = "add:schedule";
          await sendFormatted(this.poolClient, roomId, wizardPrompt("add:schedule", w.ctx));
        } else {
          w.step = "add:prompt";
          await sendFormatted(this.poolClient, roomId, wizardPrompt("add:prompt", w.ctx));
        }
        return;
      }
      case "add:schedule": {
        if (!cron.validate(text.trim())) {
          await sendPlain(this.poolClient, roomId,
            "Ungueltiger Cron-Ausdruck. Format: `MIN STD TAG MON WOT` (5 Felder). Nochmal:");
          return;
        }
        w.ctx.schedule = text.trim();
        w.step = "add:taskPrompt";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("add:taskPrompt", w.ctx));
        return;
      }
      case "add:taskPrompt": {
        w.ctx.taskPrompt = text;
        w.step = "add:prompt";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("add:prompt", w.ctx));
        return;
      }
      case "add:prompt": {
        w.ctx.systemPrompt = text;
        this.cancelWizard();
        await this.createAgent(
          w.ctx.id,
          w.ctx.displayName,
          w.ctx.role,
          w.ctx.systemPrompt,
          roomId,
          { schedule: w.ctx.schedule, taskPrompt: w.ctx.taskPrompt }
        );
        return;
      }

      // --- UPDATE ---
      case "update:pick": {
        const id = text.toLowerCase();
        const config = loadAgentConfig(id);
        if (!config) {
          await sendPlain(this.poolClient, roomId, `Agent \`${id}\` nicht gefunden. Nochmal:`);
          return;
        }
        w.ctx.id = id;
        w.step = "update:prompt";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("update:prompt", w.ctx));
        return;
      }
      case "update:prompt": {
        const cfg = loadAgentConfig(w.ctx.id);
        saveAgentPrompt(w.ctx.id, text, cfg?.role);
        this.cancelWizard();
        await sendFormatted(this.poolClient, roomId,
          `Prompt fuer **${w.ctx.id}** aktualisiert.`);
        return;
      }

      // --- DELETE ---
      case "delete:pick": {
        const id = text.toLowerCase();
        const config = loadAgentConfig(id);
        if (!config) {
          await sendPlain(this.poolClient, roomId, `Agent \`${id}\` nicht gefunden. Nochmal:`);
          return;
        }
        w.ctx.id = id;
        w.ctx.displayName = config.displayName;
        w.step = "delete:confirm";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("delete:confirm", w.ctx));
        return;
      }
      case "delete:confirm": {
        this.cancelWizard();
        if (text.toLowerCase() === "ja") {
          this.agentConfigs.delete(w.ctx.id);
          stopAgentProcess(w.ctx.id);
          deleteAgentFiles(w.ctx.id);
          await this.deactivateMatrixUser(w.ctx.id);
          await sendFormatted(this.poolClient, roomId,
            `Agent **${w.ctx.displayName}** geloescht (inkl. Matrix-User deaktiviert).`);
        } else {
          await sendPlain(this.poolClient, roomId, "Abgebrochen.");
        }
        return;
      }
    }
  }

  // ===========================================================
  // Admin commands
  // ===========================================================
  async handleAdmin(roomId, body) {
    const cmd = body.trim().toLowerCase();

    if (cmd === "!agent" || cmd === "!agent help") {
      await sendFormatted(this.poolClient, roomId,
        "**Agent-Verwaltung**\n" +
        "- `!agent add` — Neuen Agent anlegen\n" +
        "- `!agent update` — Prompt aendern\n" +
        "- `!agent delete` — Agent loeschen\n" +
        "- `!agent list` — Alle Agenten anzeigen\n" +
        "- `!agent enable <id>` / `!agent disable <id>`\n" +
        "- `!cancel` — Aktuellen Wizard abbrechen");
      return;
    }

    if (cmd === "!cancel") {
      this.cancelWizard();
      await sendPlain(this.poolClient, roomId, "Abgebrochen.");
      return;
    }

    if (cmd === "!agent list") {
      const ids = listAgentIds();
      if (ids.length === 0) {
        await sendPlain(this.poolClient, roomId, "Keine Agenten konfiguriert.");
        return;
      }
      let table = "| ID | Name | Rolle | Status | Trigger |\n|---|---|---|---|---|\n";
      for (const id of ids) {
        const c = loadAgentConfig(id);
        const triggers = loadTriggers(id);
        const cronTriggers = triggers.filter((t) => t.type === "cron" && t.enabled);
        const triggerInfo = cronTriggers.length > 0
          ? cronTriggers.map((t) => `\`${t.cron}\``).join(", ")
          : "—";
        const isActive = this.agentConfigs.has(id) && c.enabled !== false;
        table += `| ${id} | ${c.displayName} | ${c.role} | ${isActive ? "aktiv" : "gestoppt"} | ${triggerInfo} |\n`;
      }
      await sendFormatted(this.poolClient, roomId, table);
      return;
    }

    if (cmd === "!agent add") {
      this.startWizard(roomId, "add:id");
      await sendFormatted(this.poolClient, roomId, wizardPrompt("add:id", {}));
      return;
    }

    if (cmd === "!agent update") {
      const list = agentListMarkdown();
      this.startWizard(roomId, "update:pick", { list });
      await sendFormatted(this.poolClient, roomId, wizardPrompt("update:pick", { list }));
      return;
    }

    if (cmd === "!agent delete") {
      const list = agentListMarkdown();
      this.startWizard(roomId, "delete:pick", { list });
      await sendFormatted(this.poolClient, roomId, wizardPrompt("delete:pick", { list }));
      return;
    }

    // Quick enable/disable
    const toggleMatch = body.match(/^!agent\s+(enable|disable)\s+(\S+)$/i);
    if (toggleMatch) {
      const [, action, id] = toggleMatch;
      const config = loadAgentConfig(id);
      if (!config) {
        await sendPlain(this.poolClient, roomId, `Agent \`${id}\` nicht gefunden.`);
        return;
      }
      config.enabled = action.toLowerCase() === "enable";
      saveAgentConfig(id, config);
      if (config.enabled) {
        this.agentConfigs.set(id, { config });
        startAgentProcess(config);
      } else {
        this.agentConfigs.delete(id);
        stopAgentProcess(id);
      }
      await sendFormatted(this.poolClient, roomId,
        `Agent **${config.displayName}** ${config.enabled ? "aktiviert" : "deaktiviert"}.`);
      return;
    }

    await sendPlain(this.poolClient, roomId,
      "Unbekannter Befehl. Schreibe `!agent` fuer Hilfe.");
  }

  // ===========================================================
  // Agent creation
  // ===========================================================
  async createAgent(id, displayName, role, systemPrompt, roomId, extra = {}) {
    try {
      await sendPlain(this.poolClient, roomId, `Erstelle Agent "${displayName}"...`);

      const password = `agent-${id}-${Date.now()}`;
      const userId = `@${id}:local`;

      if (this.adminClient) await ensureMatrixUser(this.adminClient, id, password);

      let token;
      try {
        token = await loginMatrixUser(id, password);
      } catch {
        await sendPlain(this.poolClient, roomId,
          `Login als ${userId} fehlgeschlagen. User existiert evtl. schon mit anderem Passwort.`);
        return;
      }

      await setDisplayName(token, userId, displayName);
      await inviteAndJoin(this.poolClient, token, MULTI_AGENT_ROOM);

      // Seed agent workspace from base bridge template
      const seeded = seedAgentWorkspace(id);

      const config = { id, displayName, userId, token, role, enabled: true };
      saveAgentConfig(id, config);
      saveAgentPrompt(id, systemPrompt, role);

      // Seed initial triggers.json for autonomous agents
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

      // Register config and start agent process
      this.agentConfigs.set(id, { config });
      startAgentProcess(config);

      const seedNote = seeded
        ? " Workspace aus Template uebernommen (Skills, Memory, Repo)."
        : " Kein Template verfuegbar — leerer Workspace.";
      const scheduleNote = role === "autonomous" && extra.schedule
        ? `\nInitialer Trigger: \`${extra.schedule}\``
        : "";
      await sendFormatted(this.poolClient, roomId,
        `Agent **${displayName}** erstellt als \`${userId}\` (${role}) — sofort aktiv!${seedNote}${scheduleNote}`);
    } catch (err) {
      console.error(`[Orchestrator] Create error: ${err.message}`);
      await sendPlain(this.poolClient, roomId, `Fehler: ${err.message}`);
    }
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

    // Active wizard — intercept admin responses
    if (event.sender === ADMIN_USER && this.wizard && roomId === this.wizard.ctx.roomId) {
      if (body.startsWith("!")) {
        this.cancelWizard();
      } else {
        await this.handleWizardStep(roomId, body);
        return;
      }
    }

    // Admin commands
    if (event.sender === ADMIN_USER && (body.startsWith("!agent") || body === "!cancel")) {
      await this.handleAdmin(roomId, body);
      return;
    }

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
        "Keine Experten-Agenten aktiv. Erstelle welche mit `!agent add`.");
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
        "Keiner der Experten konnte zu diesem Thema beitragen. Erstelle einen passenden Experten mit `!agent add`.");
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

  // Internal API — used by admin-console to create agents without the chat wizard
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
    if (req.method !== 'POST' || req.url !== '/internal/agents') {
      res.writeHead(404); res.end(); return;
    }
    let body = '';
    req.on('data', d => body += d);
    req.on('end', async () => {
      try {
        const { id, displayName, role, systemPrompt, schedule, taskPrompt } = JSON.parse(body);
        if (!id || !displayName || !role || !systemPrompt) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'id, displayName, role, systemPrompt required' }));
          return;
        }
        const extra = role === 'autonomous' ? { schedule, taskPrompt } : {};
        await orchestrator.createAgent(id, displayName, role, systemPrompt, MULTI_AGENT_ROOM, extra);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
  });
  internalApi.listen(4002, '0.0.0.0', () =>
    console.log('[Orchestrator] Internal API listening on :4002')
  );
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
