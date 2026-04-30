'use strict';

/**
 * agent-runner.js — per-agent container entry point
 *
 * One instance of this process runs inside each agent container. It:
 *   - Connects to Matrix as this agent's user
 *   - Listens for routing directives from the orchestrator
 *   - Calls Claude CLI in the agent's workspace
 *   - Posts results back to the multi-agent room
 *   - Runs the trigger scheduler for autonomous agents
 *
 * Environment variables (set by orchestrator via Podman container create):
 *   AGENT_ID                   — agent identifier (e.g. "cobol-expert")
 *   MATRIX_ACCESS_TOKEN        — this agent's Matrix access token
 *   MATRIX_BOT_USER_ID         — this agent's Matrix user ID (e.g. "@cobol-expert:local")
 *   MATRIX_HOMESERVER          — homeserver URL
 *   MULTI_AGENT_ROOM           — the shared multi-agent room ID
 *   ORCHESTRATOR_USER_ID       — orchestrator's Matrix user ID (@orchestrator:local)
 *   CLAUDE_CODE_USE_FOUNDRY    — forwarded Azure Foundry config
 *   ANTHROPIC_FOUNDRY_RESOURCE
 *   ANTHROPIC_FOUNDRY_API_KEY
 *   ANTHROPIC_DEFAULT_SONNET_MODEL
 *   GIT_SSH_COMMAND
 */

const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");

// ============================================================
// Config
// ============================================================
const AGENT_ID = process.env.AGENT_ID;
const AGENT_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const AGENT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const MULTI_AGENT_ROOM = process.env.MULTI_AGENT_ROOM;
const ORCHESTRATOR_USER_ID = process.env.ORCHESTRATOR_USER_ID || "@orchestrator:local";
const ADMIN_USER_ID = process.env.ADMIN_USER_ID || "@thorsten:local";

const AGENTS_DIR = "/workspace/agents";
const CLAUDE_TIMEOUT = 600_000;

if (!AGENT_ID || !AGENT_TOKEN || !AGENT_USER_ID || !HOMESERVER) {
  console.error("[Runner] AGENT_ID, MATRIX_ACCESS_TOKEN, MATRIX_BOT_USER_ID, MATRIX_HOMESERVER required");
  process.exit(1);
}

const AGENT_WORKDIR = path.join(AGENTS_DIR, AGENT_ID);

// ============================================================
// Storage helpers
// ============================================================
function loadAgentConfig() {
  const p = path.join(AGENT_WORKDIR, "config.json");
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function loadTriggers() {
  const p = path.join(AGENT_WORKDIR, "triggers.json");
  try {
    if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (err) {
    console.error(`[Runner:${AGENT_ID}] Error loading triggers: ${err.message}`);
  }
  return [];
}

function saveTriggers(triggers) {
  fs.writeFileSync(
    path.join(AGENT_WORKDIR, "triggers.json"),
    JSON.stringify(triggers, null, 2)
  );
}

// ============================================================
// Claude CLI
// ============================================================
function callClaude(prompt, timeoutMs = CLAUDE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const memoryHint =
      "Read memory/context.md and memory/log.md first (if they exist) before responding. " +
      "If the user asks you to remember something: update the memory files. " +
      "IMPORTANT: Your workspace root is the current working directory. " +
      "Memory entries may reference absolute paths like /workspace/... from a different context. " +
      "Translate these to relative paths in your current directory (e.g. /workspace/314092_foo/ becomes ./314092_foo/).";

    const proc = spawn(
      "claude",
      [
        "-p", prompt,
        "--output-format", "json",
        "--permission-mode", "acceptEdits",
        "--append-system-prompt", memoryHint,
        "--allowedTools", "Bash(*)",
        "--allowedTools", "Read(*)",
        "--allowedTools", "Write(*)",
        "--allowedTools", "Edit(*)",
        "--allowedTools", "Glob(*)",
        "--allowedTools", "Grep(*)",
      ],
      {
        cwd: AGENT_WORKDIR,
        env: { ...process.env, HOME: "/root" },
        stdio: ["ignore", "pipe", "pipe"],
      }
    );

    let stdout = "", stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Timeout"));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(stderr.substring(0, 300) || `Exit ${code}`));
      try {
        const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
        resolve(JSON.parse(lines[lines.length - 1]).result || stdout.trim());
      } catch {
        resolve(stdout.trim());
      }
    });

    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });
}

// ============================================================
// Matrix helpers
// ============================================================
async function sendFormatted(client, roomId, text) {
  // Use plain text to keep things simple; the orchestrator parses body text.
  // Markdown rendering is left to clients.
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: text,
  });
}

// ============================================================
// Routing message parsing
// Orchestrator sends: ROUTE:<targetUserId>:<base64-prompt>
// ============================================================
function parseRoute(body) {
  if (!body.startsWith("ROUTE:")) return null;
  const parts = body.split(":");
  // Format: ROUTE:<userId-part1>:<userId-part2 (domain)>:<base64>
  // userId contains a colon (@foo:local), so we need to find the base64 part carefully.
  // We always split into at most 4 parts on the first 3 colons:
  //   ROUTE  :  @foo  :  local  :  <base64>
  // But userId can be @foo:local — that's 2 segments after ROUTE.
  // Strategy: find "ROUTE:", then find the userId by reading until the next colon
  // after the @ sign, then the rest is base64.
  const match = body.match(/^ROUTE:(@[^:]+:[^:]+):(.+)$/);
  if (!match) return null;
  return {
    targetUserId: match[1],
    prompt: Buffer.from(match[2], "base64").toString("utf8"),
  };
}

// ============================================================
// Trigger scheduler (autonomous agents only)
// ============================================================
class TriggerScheduler {
  constructor(agentClient) {
    this.agentClient = agentClient;
    this.triggerTasks = new Map(); // triggerId → { task, cronExpr }
    this.triggerRunning = new Set();
    this._interval = null;
  }

  start() {
    this.sync();
    this._interval = setInterval(() => this.sync(), 60_000);
    console.log(`[Runner:${AGENT_ID}] Trigger scheduler started`);
  }

  sync() {
    const triggers = loadTriggers();
    const activeIds = new Set();

    for (const trigger of triggers) {
      if (!trigger.enabled || !trigger.id) continue;

      if (trigger.type === "cron") {
        activeIds.add(trigger.id);
        const existing = this.triggerTasks.get(trigger.id);
        if (existing && existing.cronExpr === trigger.cron) continue;

        if (existing) {
          existing.task.stop();
          console.log(`[Runner:${AGENT_ID}] Trigger updated: ${trigger.id}`);
        }

        if (!cron.validate(trigger.cron)) {
          console.error(`[Runner:${AGENT_ID}] Invalid cron: ${trigger.cron} (${trigger.id})`);
          continue;
        }

        const task = cron.schedule(trigger.cron, () => {
          this.execute(trigger);
        }, { timezone: "Europe/Berlin" });

        this.triggerTasks.set(trigger.id, { task, cronExpr: trigger.cron });
        console.log(`[Runner:${AGENT_ID}] Trigger scheduled: ${trigger.id} (${trigger.cron})`);

      } else if (trigger.type === "once") {
        const at = new Date(trigger.at).getTime();
        if (Date.now() >= at) {
          this.execute(trigger);
          // Remove from file
          const updated = loadTriggers().filter((t) => t.id !== trigger.id);
          saveTriggers(updated);
          console.log(`[Runner:${AGENT_ID}] One-shot fired and removed: ${trigger.id}`);
        }
      }
    }

    // Stop removed triggers
    for (const [id, { task }] of this.triggerTasks) {
      if (!activeIds.has(id)) {
        task.stop();
        this.triggerTasks.delete(id);
        console.log(`[Runner:${AGENT_ID}] Trigger removed: ${id}`);
      }
    }
  }

  async execute(trigger) {
    if (this.triggerRunning.has(trigger.id)) {
      console.log(`[Runner:${AGENT_ID}] Trigger ${trigger.id} still running — skipping`);
      return;
    }
    this.triggerRunning.add(trigger.id);

    const roomId = trigger.roomId || MULTI_AGENT_ROOM;
    console.log(`[Runner:${AGENT_ID}] Executing trigger: ${trigger.id}...`);

    try {
      const prompt =
        "Du fuehrst eine geplante autonome Aufgabe aus. " +
        "Poste deine Ergebnisse. Falls es nichts zu berichten gibt, antworte mit [PASS].\n\n" +
        `Aufgabe: ${trigger.prompt}`;

      const timeoutMs = trigger.timeoutSeconds ? trigger.timeoutSeconds * 1000 : CLAUDE_TIMEOUT;
      const result = await callClaude(prompt, timeoutMs);

      if (result.trim().startsWith("[PASS]")) {
        console.log(`[Runner:${AGENT_ID}] Trigger ${trigger.id}: [PASS]`);
      } else {
        await sendFormatted(this.agentClient, roomId, result);
        console.log(`[Runner:${AGENT_ID}] Trigger ${trigger.id}: ${result.length} chars`);
      }
    } catch (err) {
      console.error(`[Runner:${AGENT_ID}] Trigger ${trigger.id} error: ${err.message}`);
    } finally {
      this.triggerRunning.delete(trigger.id);
    }
  }
}

// ============================================================
// Main
// ============================================================
async function main() {
  const config = loadAgentConfig();
  if (!config) {
    console.error(`[Runner:${AGENT_ID}] No config.json found at ${AGENT_WORKDIR}/config.json`);
    process.exit(1);
  }

  const displayName = config.displayName || AGENT_ID;
  const role = config.role || "expert";

  // Ensure workspace directory exists
  fs.mkdirSync(AGENT_WORKDIR, { recursive: true });

  const stateFile = path.join(AGENT_WORKDIR, ".agent-state.json");
  const client = new MatrixClient(
    HOMESERVER,
    AGENT_TOKEN,
    new SimpleFsStorageProvider(stateFile)
  );
  AutojoinRoomsMixin.setupOnClient(client);

  const startTime = Date.now();

  // Prevent concurrent Claude invocations
  let processing = false;

  client.on("room.message", async (roomId, event) => {
    if (event.sender === AGENT_USER_ID) return;
    if (event.content?.msgtype !== "m.text") return;
    if (event.origin_server_ts < startTime) return;

    const body = event.content?.body;
    if (!body) return;

    // Direct conversation: admin writes in any room outside the orchestrated multi-agent room.
    // The agent responds unconditionally — no routing protocol, no [PASS] filter.
    const isOrchestratedRoom = MULTI_AGENT_ROOM && roomId === MULTI_AGENT_ROOM;
    if (!isOrchestratedRoom && event.sender === ADMIN_USER_ID) {
      if (processing) {
        console.log(`[Runner:${AGENT_ID}] Busy — dropping direct message`);
        return;
      }
      processing = true;
      console.log(`[Runner:${AGENT_ID}] Direct message (${body.length} chars)...`);
      try {
        const result = await callClaude(body);
        await sendFormatted(client, roomId, result);
        console.log(`[Runner:${AGENT_ID}] Posted direct response (${result.length} chars)`);
      } catch (err) {
        console.error(`[Runner:${AGENT_ID}] Error: ${err.message}`);
      } finally {
        processing = false;
      }
      return;
    }

    // Only process messages in the orchestrated room from here on
    if (MULTI_AGENT_ROOM && roomId !== MULTI_AGENT_ROOM) return;
    // Only accept routing messages from the orchestrator
    if (event.sender !== ORCHESTRATOR_USER_ID) return;

    // Parse the routing directive
    const route = parseRoute(body);
    if (!route) return;

    // Check if this message is directed at us
    if (route.targetUserId !== AGENT_USER_ID) return;

    if (processing) {
      console.log(`[Runner:${AGENT_ID}] Busy — dropping message`);
      return;
    }
    processing = true;

    const prompt = route.prompt;
    const isDirect = prompt.startsWith("Der Nutzer hat dich direkt angesprochen.");

    console.log(`[Runner:${AGENT_ID}] Processing prompt (${prompt.length} chars)...`);

    try {
      const result = await callClaude(prompt);

      // [PASS] filtering: suppress output if agent has nothing to say
      if (!isDirect && result.trim().startsWith("[PASS]")) {
        console.log(`[Runner:${AGENT_ID}] [PASS] — not posting`);
      } else {
        await sendFormatted(client, roomId, result);
        console.log(`[Runner:${AGENT_ID}] Posted response (${result.length} chars)`);
      }
    } catch (err) {
      console.error(`[Runner:${AGENT_ID}] Error: ${err.message}`);
    } finally {
      processing = false;
    }
  });

  await client.start();

  // Start trigger scheduler for autonomous agents
  if (role === "autonomous") {
    const scheduler = new TriggerScheduler(client);
    scheduler.start();
  }

  console.log(`[Runner:${AGENT_ID}] Started as ${AGENT_USER_ID} (${displayName}, ${role})`);
  console.log(`[Runner:${AGENT_ID}] Room: ${MULTI_AGENT_ROOM}`);
  console.log(`[Runner:${AGENT_ID}] Listening for routing messages from: ${ORCHESTRATOR_USER_ID}`);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
