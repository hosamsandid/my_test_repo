const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const { spawn } = require("child_process");
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
const ADMIN_USER = process.env.ADMIN_USER_ID || "@thorsten:local";
const CONDUWUIT_ADMIN_TOKEN = process.env.CONDUWUIT_ADMIN_TOKEN;
const CONDUWUIT_ADMIN_ROOM = process.env.CONDUWUIT_ADMIN_ROOM;

const AGENTS_DIR = "/workspace/agents";
const WORKSPACE = "/workspace";
const CLAUDE_TIMEOUT = 600_000;
const QUIET_DELAY = 10_000;
const MAX_TIMEOUT = 240_000;
const WIZARD_TIMEOUT = 300_000; // 5 min

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

function saveAgentPrompt(id, prompt) {
  const dir = agentDir(id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "CLAUDE.md"), prompt);
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
// Claude CLI
// ============================================================
function callClaude(prompt, cwd, timeoutMs = CLAUDE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "claude",
      ["-p", prompt, "--output-format", "json", "--permission-mode", "acceptEdits"],
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
// Matrix helpers
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

async function createMatrixUser(adminClient, username, password) {
  await adminClient.sendMessage(CONDUWUIT_ADMIN_ROOM, {
    msgtype: "m.text",
    body: `!admin users create-user ${username} ${password}`,
  });
  await new Promise((r) => setTimeout(r, 3000));
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
  const tmp = new MatrixClient(HOMESERVER, token,
    new SimpleFsStorageProvider("/tmp/.tmp-" + Date.now() + ".json"));
  try {
    const userId = await tmp.getUserId();
    await poolClient.inviteUser(userId, roomId);
    await new Promise((r) => setTimeout(r, 1000));
    await tmp.joinRoom(roomId);
  } catch (err) {
    console.log(`[Pool] Invite/join warning: ${err.message}`);
  }
}

// ============================================================
// Wizard
// ============================================================
// Steps: add → id → name → role → prompt → done
//        update → pick → prompt → done
//        delete → pick → confirm → done

function wizardPrompt(step, ctx) {
  switch (step) {
    case "add:id":
      return "**Neuer Agent (1/4)**\nWie soll die ID sein? (Kleinbuchstaben, keine Leerzeichen, z.B. `cobol-expert`)";
    case "add:name":
      return `**Neuer Agent (2/4)**\nAnzeigename fuer \`${ctx.id}\`? (z.B. \`COBOL Expert\`)`;
    case "add:role":
      return "**Neuer Agent (3/4)**\nWelche Rolle?\n- `expert` — antwortet autonom auf Nutzerfragen\n- `synthesizer` — fasst Experten-Ergebnisse zusammen";
    case "add:prompt":
      return "**Neuer Agent (4/4)**\nSchicke jetzt den System-Prompt.\nDas ist die Anweisung, die dem Agent sagt, wie er sich verhalten soll.\n\n*Tipp: Starte mit `# Rollenname` und beschreibe Verhalten, Grenzen und Ausgabeformat.*";
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
// Agent Pool
// ============================================================
class AgentPool {
  constructor() {
    this.agents = new Map();
    this.poolClient = null;
    this.adminClient = null;
    this.activeTask = null;
    this.wizard = null; // { step, ctx, timer }
    this.startTime = 0;
  }

  async init() {
    this.poolClient = new MatrixClient(HOMESERVER, POOL_TOKEN,
      new SimpleFsStorageProvider(path.join(WORKSPACE, ".pool-state.json")));
    AutojoinRoomsMixin.setupOnClient(this.poolClient);

    if (CONDUWUIT_ADMIN_TOKEN && CONDUWUIT_ADMIN_ROOM) {
      this.adminClient = new MatrixClient(HOMESERVER, CONDUWUIT_ADMIN_TOKEN,
        new SimpleFsStorageProvider(path.join(WORKSPACE, ".admin-state.json")));
    }

    fs.mkdirSync(AGENTS_DIR, { recursive: true });
    for (const id of listAgentIds()) {
      const config = loadAgentConfig(id);
      if (config && config.enabled) this.startAgent(id, config);
    }

    this.startTime = Date.now();
    this.poolClient.on("room.message", (r, e) => this.onMessage(r, e));
    await this.poolClient.start();

    console.log(`[Pool] Started as ${POOL_USER_ID}`);
    console.log(`[Pool] Room: ${MULTI_AGENT_ROOM}`);
    console.log(`[Pool] Agents loaded: ${this.agents.size}`);
    for (const [id, a] of this.agents)
      console.log(`  ${id}: ${a.config.displayName} (${a.config.role})`);
  }

  startAgent(id, config) {
    const client = new MatrixClient(HOMESERVER, config.token,
      new SimpleFsStorageProvider(path.join(WORKSPACE, `.agent-state-${id}.json`)));
    this.agents.set(id, { config, client });
    console.log(`[Pool] Agent active: ${config.displayName} (@${id}:local)`);
  }

  stopAgent(id) {
    this.agents.delete(id);
    console.log(`[Pool] Agent stopped: ${id}`);
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
        if (role !== "expert" && role !== "synthesizer") {
          await sendPlain(this.poolClient, roomId, "Bitte `expert` oder `synthesizer` eingeben:");
          return;
        }
        w.ctx.role = role;
        w.step = "add:prompt";
        await sendFormatted(this.poolClient, roomId, wizardPrompt("add:prompt", w.ctx));
        return;
      }
      case "add:prompt": {
        w.ctx.systemPrompt = text;
        this.cancelWizard();
        await this.createAgent(w.ctx.id, w.ctx.displayName, w.ctx.role, w.ctx.systemPrompt, roomId);
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
        saveAgentPrompt(w.ctx.id, text);
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
          this.stopAgent(w.ctx.id);
          deleteAgentFiles(w.ctx.id);
          await sendFormatted(this.poolClient, roomId,
            `Agent **${w.ctx.displayName}** geloescht.`);
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
      let table = "| ID | Name | Rolle | Status |\n|---|---|---|---|\n";
      for (const id of ids) {
        const c = loadAgentConfig(id);
        table += `| ${id} | ${c.displayName} | ${c.role} | ${this.agents.has(id) ? "aktiv" : "gestoppt"} |\n`;
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
      if (config.enabled) this.startAgent(id, config);
      else this.stopAgent(id);
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
  async createAgent(id, displayName, role, systemPrompt, roomId) {
    try {
      await sendPlain(this.poolClient, roomId, `Erstelle Agent "${displayName}"...`);

      const password = `agent-${id}-${Date.now()}`;
      const userId = `@${id}:local`;

      if (this.adminClient) await createMatrixUser(this.adminClient, id, password);

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

      const config = { id, displayName, userId, token, role, enabled: true };
      saveAgentConfig(id, config);
      saveAgentPrompt(id, systemPrompt);
      this.startAgent(id, config);

      await sendFormatted(this.poolClient, roomId,
        `Agent **${displayName}** erstellt als \`${userId}\` (${role}) — sofort aktiv!`);
    } catch (err) {
      console.error(`[Pool] Create error: ${err.message}`);
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
        // New command cancels wizard
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

    // Only process agent messages in the multi-agent room
    if (MULTI_AGENT_ROOM && roomId !== MULTI_AGENT_ROOM) return;

    // Collect expert responses (watcher)
    const agentEntry = [...this.agents.values()].find(
      (a) => a.config.userId === event.sender
    );
    if (agentEntry && this.activeTask) {
      if (agentEntry.config.role === "expert" &&
          !this.activeTask.respondedIds.has(event.sender)) {
        this.activeTask.respondedIds.add(event.sender);
        this.activeTask.expertResponses.push({
          name: agentEntry.config.displayName,
          response: body,
        });
        console.log(`[Pool] Expert: ${agentEntry.config.displayName} (${body.length} chars)`);
        this.resetQuietTimer();
      }
      return;
    }

    // Ignore bot messages
    if (agentEntry) return;
    const allIds = new Set([...this.agents.values()].map((a) => a.config.userId));
    if (allIds.has(event.sender)) return;

    // Human message → experts
    if (body.startsWith("!")) return;

    console.log(`[Pool] Human: ${body.substring(0, 80)}`);
    await this.processHumanMessage(roomId, body);
  }

  async processHumanMessage(roomId, body) {
    if (this.activeTask) {
      if (this.activeTask.quietTimer) clearTimeout(this.activeTask.quietTimer);
      if (this.activeTask.maxTimer) clearTimeout(this.activeTask.maxTimer);
    }

    const allExperts = [...this.agents.values()].filter(
      (a) => a.config.role === "expert" && a.config.enabled
    );

    if (allExperts.length === 0) {
      await sendPlain(this.poolClient, roomId,
        "Keine Experten-Agenten aktiv. Erstelle welche mit `!agent add`.");
      return;
    }

    // Check if user @-mentioned specific agents (by displayName or id)
    const bodyLower = body.toLowerCase();
    const mentioned = allExperts.filter((a) => {
      const name = a.config.displayName.toLowerCase();
      const id = a.config.id.toLowerCase();
      const userId = a.config.userId.toLowerCase();
      return bodyLower.includes(name) || bodyLower.includes(id) || bodyLower.includes(userId);
    });

    // If specific agents mentioned → only those. Otherwise → all.
    const experts = mentioned.length > 0 ? mentioned : allExperts;
    if (mentioned.length > 0) {
      console.log(`[Pool] Mentioned: ${mentioned.map((a) => a.config.displayName).join(", ")}`);
    }

    this.activeTask = {
      originalTask: body,
      roomId,
      expertResponses: [],
      respondedIds: new Set(),
      doneIds: new Set(), // tracks all completed experts (posted + passed + error)
      quietTimer: null,
      maxTimer: null,
    };

    const totalExperts = experts.length;

    const isDirect = mentioned.length > 0;

    // Call Claude for each expert in parallel
    Promise.allSettled(
      experts.map(async ({ config, client }) => {
        try {
          // When directly addressed, override [PASS] behavior
          const prompt = isDirect
            ? `Der Nutzer hat dich direkt angesprochen. Antworte auf jeden Fall, auch wenn das Thema nicht dein Kerngebiet ist.\n\n${body}`
            : body;
          console.log(`[Pool] Claude call: ${config.displayName}${isDirect ? " (direct)" : ""}...`);
          const result = await callClaude(prompt, agentDir(config.id));
          if (!isDirect && result.trim().startsWith("[PASS]")) {
            console.log(`[Pool] ${config.displayName}: [PASS]`);
          } else {
            await sendFormatted(client, roomId, result);
            console.log(`[Pool] ${config.displayName}: ${result.length} chars`);
          }
        } catch (err) {
          console.error(`[Pool] ${config.displayName} error: ${err.message}`);
        }
        // Mark expert as done regardless of outcome
        if (this.activeTask) {
          this.activeTask.doneIds.add(config.userId);
          this.checkAllDone(roomId, totalExperts);
        }
      })
    );

    this.activeTask.maxTimer = setTimeout(() => this.triggerSynthesis(), MAX_TIMEOUT);
  }

  checkAllDone(roomId, totalExperts) {
    if (!this.activeTask) return;
    if (this.activeTask.doneIds.size < totalExperts) return;

    // All experts finished processing
    if (this.activeTask.expertResponses.length === 0) {
      // Nobody posted anything — all passed or errored
      console.log("[Pool] All experts passed — sending fallback");
      if (this.activeTask.quietTimer) clearTimeout(this.activeTask.quietTimer);
      if (this.activeTask.maxTimer) clearTimeout(this.activeTask.maxTimer);
      this.activeTask = null;
      sendPlain(this.poolClient, roomId,
        "Keiner der Experten konnte zu diesem Thema beitragen. Erstelle einen passenden Experten mit `!agent add`.");
    }
    // If some posted, the watcher (resetQuietTimer via onMessage) handles synthesis
  }

  resetQuietTimer() {
    if (!this.activeTask) return;
    if (this.activeTask.quietTimer) clearTimeout(this.activeTask.quietTimer);
    const experts = [...this.agents.values()].filter(
      (a) => a.config.role === "expert" && a.config.enabled
    );
    const allResponded = experts.every((a) => this.activeTask.respondedIds.has(a.config.userId));
    this.activeTask.quietTimer = setTimeout(
      () => this.triggerSynthesis(),
      allResponded ? 5_000 : QUIET_DELAY
    );
  }

  async triggerSynthesis() {
    if (!this.activeTask) return;
    const task = this.activeTask;
    this.activeTask = null;
    if (task.quietTimer) clearTimeout(task.quietTimer);
    if (task.maxTimer) clearTimeout(task.maxTimer);

    if (task.expertResponses.length <= 1) {
      console.log("[Pool] Synthesis not needed");
      return;
    }

    const synth = [...this.agents.values()].find(
      (a) => a.config.role === "synthesizer" && a.config.enabled
    );
    if (!synth) { console.log("[Pool] No synthesizer"); return; }

    console.log(`[Pool] Synthesizing ${task.expertResponses.length} responses...`);
    const context = task.expertResponses
      .map((r) => `### ${r.name}\n${r.response}`).join("\n\n");

    try {
      const result = await callClaude(
        `Experten haben auf folgende Frage geantwortet. Fasse zusammen.\n\nFrage: ${task.originalTask}\n\nAntworten:\n${context}\n\nRegeln: Einleitungssatz, Vergleichstabelle wenn sinnvoll, max 1500 Zeichen, Sprache der Frage. Falls kein Mehrwert: [PASS]`,
        agentDir(synth.config.id)
      );
      if (result.trim().startsWith("[PASS]")) { console.log("[Pool] Synthesis: PASS"); return; }
      await sendFormatted(synth.client, task.roomId, result);
      console.log(`[Pool] Synthesis: ${result.length} chars`);
    } catch (err) {
      console.error(`[Pool] Synthesis error: ${err.message}`);
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
  const pool = new AgentPool();
  await pool.init();
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
