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
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const cron = require("node-cron");
const { marked } = require("marked");
const { appendEvent, mapStreamJsonLine } = require("./session-log");

// ============================================================
// Config
// ============================================================
const AGENT_ID = process.env.AGENT_ID;
const AGENT_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const AGENT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const MULTI_AGENT_ROOM = process.env.MULTI_AGENT_ROOM;
const ORCHESTRATOR_USER_ID = process.env.ORCHESTRATOR_USER_ID || "@orchestrator:local";

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

// ─── Per-room Claude session pointer ───────────────────────────────────
// We persist the most recent Claude `session_id` per (agent, room) so the
// next message in the same chat resumes that session. The pointer file lives
// next to the JSONL log: /workspace/agents/<id>/sessions/<roomId>.current.json
// Format: { sessionId: "...", updatedAt: "ISO-ts" }
function sessionPointerFile(roomId) {
  return path.join(AGENT_WORKDIR, "sessions", `${roomId}.current.json`);
}

function readSessionPointer(roomId) {
  try {
    const p = sessionPointerFile(roomId);
    if (!fs.existsSync(p)) return null;
    const j = JSON.parse(fs.readFileSync(p, "utf8"));
    return typeof j?.sessionId === "string" && j.sessionId ? j.sessionId : null;
  } catch (err) {
    console.error(`[Runner:${AGENT_ID}] readSessionPointer ${roomId}: ${err.message}`);
    return null;
  }
}

function writeSessionPointer(roomId, sessionId) {
  if (!sessionId || typeof sessionId !== "string") return;
  try {
    const p = sessionPointerFile(roomId);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(
      p,
      JSON.stringify({ sessionId, updatedAt: new Date().toISOString() }, null, 2)
    );
  } catch (err) {
    console.error(`[Runner:${AGENT_ID}] writeSessionPointer: ${err.message}`);
  }
}

function clearSessionPointer(roomId) {
  try {
    fs.rmSync(sessionPointerFile(roomId), { force: true });
  } catch { /* noop */ }
}

// ============================================================
// Activity status (written to status.json for the Admin Console)
// ============================================================
function writeStatus(state) {
  try {
    fs.writeFileSync(
      path.join(AGENT_WORKDIR, 'status.json'),
      JSON.stringify({ state, updatedAt: new Date().toISOString() })
    );
  } catch { /* best effort — never crash the runner */ }
}

let activeInvocations = 0;

// ============================================================
// Claude CLI
// ============================================================
/**
 * Invoke the Claude Code CLI with stream-json output and write each
 * NDJSON event to the per-room session log.
 *
 * Session resumption: when `roomId` is given, we read the session pointer
 * for that room (if any) and pass `--resume <sessionId>` so Claude continues
 * the prior conversation in-context. After each successful run we re-write
 * the pointer with the freshest `session_id` reported in the stream-json
 * `system_init` / `result` events. If `--resume` fails (CLI prints
 * "session not found" or similar), we transparently retry once without it.
 *
 * Options:
 *   - roomId         (required) — used as the JSONL filename and pointer key
 *   - correlationId  (required) — Matrix event id (or synthetic id) tying
 *                                 log entries to the originating user message
 *   - timeoutMs      (optional) — defaults to CLAUDE_TIMEOUT
 *   - resume         (optional, default true) — set false to force a fresh
 *                                 session even if a pointer exists
 *
 * Resolves with the final assistant text (the `result` field of the last
 * `result` event, or a concatenation of all `assistant_text` events as a
 * fallback). Rejects on timeout or non-zero exit.
 */
function callClaude(prompt, { roomId, correlationId, timeoutMs = CLAUDE_TIMEOUT, resume = true } = {}) {
  const memoryHint =
    "Read memory/context.md and memory/log.md first (if they exist) before responding. " +
    "If the user asks you to remember something: update the memory files. " +
    "IMPORTANT: Your workspace root is the current working directory. " +
    "Memory entries may reference absolute paths like /workspace/... from a different context. " +
    "Translate these to relative paths in your current directory (e.g. /workspace/314092_foo/ becomes ./314092_foo/).";

  const baseArgs = [
    "-p", prompt,
    "--output-format", "stream-json",
    "--verbose",
    // bypassPermissions is refused by Claude when running as root (the
    // orchestrator container's default user). acceptEdits + the
    // allowedTools whitelist below covers the same practical surface
    // without prompts for the tools agents actually use.
    "--permission-mode", "acceptEdits",
    "--append-system-prompt", memoryHint,
    "--allowedTools", "Bash(*)",
    "--allowedTools", "Read(*)",
    "--allowedTools", "Write(*)",
    "--allowedTools", "Edit(*)",
    "--allowedTools", "Glob(*)",
    "--allowedTools", "Grep(*)",
    "--allowedTools", "Task(*)",
    "--allowedTools", "WebFetch(*)",
    "--allowedTools", "WebSearch(*)",
  ];

  const resumeId = resume && roomId ? readSessionPointer(roomId) : null;

  const runOnce = (withResumeId) => new Promise((resolve, reject) => {
    const args = withResumeId ? ["--resume", withResumeId, ...baseArgs] : baseArgs;
    const proc = spawn("claude", args, {
      cwd: AGENT_WORKDIR,
      env: { ...process.env, HOME: "/root" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stderr = "";
    let lineBuf = "";
    let finalResult = null;          // text from the last `result` event
    let observedSessionId = null;    // freshest session id seen in this run
    const assistantTextChunks = [];  // fallback if no `result` event

    const logEvent = (ev) => {
      try {
        if (roomId) appendEvent(AGENT_ID, roomId, ev);
      } catch (err) {
        // never let logging errors crash the runner
        console.error(`[Runner:${AGENT_ID}] session-log append failed: ${err.message}`);
      }
    };

    const handleLine = (line) => {
      const events = mapStreamJsonLine(line, correlationId);
      for (const ev of events) {
        logEvent(ev);
        if (ev.type === "system_init" && typeof ev.sessionId === "string") {
          observedSessionId = ev.sessionId;
        } else if (ev.type === "result") {
          if (typeof ev.sessionId === "string") observedSessionId = ev.sessionId;
          if (typeof ev.result === "string") finalResult = ev.result;
        } else if (ev.type === "assistant_text" && typeof ev.text === "string") {
          assistantTextChunks.push(ev.text);
        }
      }
    };

    proc.stdout.on("data", (chunk) => {
      lineBuf += chunk.toString("utf8");
      let idx;
      while ((idx = lineBuf.indexOf("\n")) >= 0) {
        const line = lineBuf.slice(0, idx);
        lineBuf = lineBuf.slice(idx + 1);
        if (line.trim()) handleLine(line);
      }
    });

    proc.stderr.on("data", (d) => (stderr += d));

    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(Object.assign(new Error("Timeout"), { stderr }));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      // Flush any remaining partial line
      if (lineBuf.trim()) {
        handleLine(lineBuf);
        lineBuf = "";
      }
      if (code !== 0) {
        const err = new Error(stderr.substring(0, 300) || `Exit ${code}`);
        err.stderr = stderr;
        err.exitCode = code;
        return reject(err);
      }
      // Persist the freshest session id we observed. With `--resume`, this is
      // typically the same id (Claude keeps it stable); without it, this is
      // the brand-new id that future messages should resume into.
      if (roomId && observedSessionId) {
        writeSessionPointer(roomId, observedSessionId);
      }
      if (finalResult !== null) return resolve(finalResult);
      if (assistantTextChunks.length) return resolve(assistantTextChunks.join(""));
      // Last-resort: empty output
      resolve("");
    });

    proc.on("error", (err) => { clearTimeout(timer); reject(err); });
  });

  return (async () => {
    if (resumeId) {
      try {
        return await runOnce(resumeId);
      } catch (err) {
        // Stale or missing session — fall back to a fresh run. Detection is
        // best-effort; we treat any "session"/"resume" reference in stderr
        // as a hint to retry. The pointer is cleared so we don't loop on
        // the same broken id.
        const blob = String(err.stderr || err.message || "").toLowerCase();
        const sessionRelated =
          blob.includes("session") || blob.includes("resume") || blob.includes("not found");
        if (sessionRelated) {
          console.warn(
            `[Runner:${AGENT_ID}] --resume ${resumeId} failed (${err.message?.slice(0, 120)}); retrying without resume`
          );
          clearSessionPointer(roomId);
          return await runOnce(null);
        }
        throw err;
      }
    }
    return runOnce(null);
  })();
}

// ============================================================
// Matrix helpers
// ============================================================
async function sendFormatted(client, roomId, text) {
  // body stays plain markdown so the orchestrator can parse expert responses;
  // formatted_body is rendered HTML so Matrix clients display it nicely.
  // matrix-bot-sdk's sendMessage returns the Matrix event id (string).
  return await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: marked.parse(text),
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
    const correlationId = `trigger:${trigger.id}:${Date.now()}`;
    console.log(`[Runner:${AGENT_ID}] Executing trigger: ${trigger.id}...`);

    try {
      const prompt =
        "Du fuehrst eine geplante autonome Aufgabe aus. " +
        "Poste deine Ergebnisse. Falls es nichts zu berichten gibt, antworte mit [PASS].\n\n" +
        `Aufgabe: ${trigger.prompt}`;

      const timeoutMs = trigger.timeoutSeconds ? trigger.timeoutSeconds * 1000 : CLAUDE_TIMEOUT;

      try {
        appendEvent(AGENT_ID, roomId, {
          type: "trigger.fired",
          correlationId,
          triggerId: trigger.id,
          triggerType: trigger.type,
        });
        appendEvent(AGENT_ID, roomId, {
          type: "claude.invoke",
          correlationId,
          promptChars: prompt.length,
        });
      } catch (err) {
        console.error(`[Runner:${AGENT_ID}] session-log warning: ${err.message}`);
      }

      if (++activeInvocations === 1) writeStatus('busy');
      let result;
      try {
        result = await callClaude(prompt, { roomId, correlationId, timeoutMs });
      } catch (err) {
        try {
          appendEvent(AGENT_ID, roomId, {
            type: "error",
            correlationId,
            stage: "claude",
            message: err.message,
          });
        } catch {}
        throw err;
      } finally {
        if (--activeInvocations === 0) writeStatus('idle');
      }

      if (result.trim().startsWith("[PASS]")) {
        console.log(`[Runner:${AGENT_ID}] Trigger ${trigger.id}: [PASS]`);
      } else {
        let eventId;
        try {
          eventId = await sendFormatted(this.agentClient, roomId, result);
        } catch (err) {
          try {
            appendEvent(AGENT_ID, roomId, {
              type: "error",
              correlationId,
              stage: "matrix",
              message: err.message,
            });
          } catch {}
          throw err;
        }
        try {
          appendEvent(AGENT_ID, roomId, {
            type: "message.posted",
            correlationId,
            eventId,
          });
        } catch {}
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
  writeStatus('idle');

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

  // Cache of joined-member counts per room. Keys: roomId.
  // Value: { members: string[], expiresAt: number }
  const memberCache = new Map();
  const MEMBER_CACHE_TTL_MS = 30_000;

  async function getJoinedMembersCached(roomId) {
    const cached = memberCache.get(roomId);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.members;
    const members = await client.getJoinedRoomMembers(roomId);
    memberCache.set(roomId, { members, expiresAt: now + MEMBER_CACHE_TTL_MS });
    return members;
  }

  // Decide whether this room counts as a 1:1 DM with a real user (not an
  // agent / not the orchestrator). True when the room is not the multi-agent
  // room, has exactly two joined members (this agent + one other), and the
  // sender is neither this agent nor the orchestrator.
  async function isDmFromHuman(roomId, event) {
    if (MULTI_AGENT_ROOM && roomId === MULTI_AGENT_ROOM) return false;
    if (event.sender === AGENT_USER_ID) return false;
    if (event.sender === ORCHESTRATOR_USER_ID) return false;
    let members;
    try {
      members = await getJoinedMembersCached(roomId);
    } catch (err) {
      console.error(`[Runner:${AGENT_ID}] getJoinedRoomMembers(${roomId}) failed: ${err.message}`);
      return false;
    }
    if (!Array.isArray(members) || members.length !== 2) return false;
    return members.includes(AGENT_USER_ID) && members.includes(event.sender);
  }

  client.on("room.message", async (roomId, event) => {
    if (event.sender === AGENT_USER_ID) return;
    if (event.content?.msgtype !== "m.text") return;
    if (event.origin_server_ts < startTime) return;

    const body = event.content?.body;
    if (!body) return;

    // Direct 1:1 conversation: any room outside the multi-agent room with
    // exactly two members where the other member is a real user (heuristic:
    // not orchestrator, not self). The agent responds unconditionally —
    // no routing protocol, no [PASS] filter.
    const isOrchestratedRoom = MULTI_AGENT_ROOM && roomId === MULTI_AGENT_ROOM;
    if (!isOrchestratedRoom && await isDmFromHuman(roomId, event)) {
      if (processing) {
        console.log(`[Runner:${AGENT_ID}] Busy — dropping direct message`);
        return;
      }
      processing = true;
      const correlationId = event.event_id || crypto.randomUUID();
      console.log(`[Runner:${AGENT_ID}] Direct message (${body.length} chars)...`);

      try {
        appendEvent(AGENT_ID, roomId, {
          type: "message.received",
          correlationId,
          from: event.sender,
          body: body.slice(0, 4000),
        });
        appendEvent(AGENT_ID, roomId, {
          type: "claude.invoke",
          correlationId,
          promptChars: body.length,
        });
      } catch (err) {
        console.error(`[Runner:${AGENT_ID}] session-log warning: ${err.message}`);
      }

      try {
        if (++activeInvocations === 1) writeStatus('busy');
        let result;
        try {
          result = await callClaude(body, { roomId, correlationId });
        } finally {
          if (--activeInvocations === 0) writeStatus('idle');
        }
        let eventId;
        try {
          eventId = await sendFormatted(client, roomId, result);
        } catch (err) {
          try {
            appendEvent(AGENT_ID, roomId, {
              type: "error",
              correlationId,
              stage: "matrix",
              message: err.message,
            });
          } catch {}
          throw err;
        }
        try {
          appendEvent(AGENT_ID, roomId, {
            type: "message.posted",
            correlationId,
            eventId,
          });
        } catch {}
        console.log(`[Runner:${AGENT_ID}] Posted direct response (${result.length} chars)`);
      } catch (err) {
        try {
          appendEvent(AGENT_ID, roomId, {
            type: "error",
            correlationId,
            stage: "claude",
            message: err.message,
          });
        } catch {}
        console.error(`[Runner:${AGENT_ID}] Error: ${err.message}`);
        // Surface the failure to the user so the chat doesn't hang on a typing indicator.
        try {
          await sendFormatted(client, roomId,
            `⚠️ **Agent error**\n\n\`\`\`\n${String(err.message).slice(0, 800)}\n\`\`\``);
        } catch (postErr) {
          console.error(`[Runner:${AGENT_ID}] Could not post error to chat: ${postErr.message}`);
        }
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
    const correlationId = event.event_id || crypto.randomUUID();

    console.log(`[Runner:${AGENT_ID}] Processing prompt (${prompt.length} chars)...`);

    try {
      appendEvent(AGENT_ID, roomId, {
        type: "message.received",
        correlationId,
        from: event.sender,
        body: prompt.slice(0, 4000),
      });
      appendEvent(AGENT_ID, roomId, {
        type: "claude.invoke",
        correlationId,
        promptChars: prompt.length,
      });
    } catch (err) {
      console.error(`[Runner:${AGENT_ID}] session-log warning: ${err.message}`);
    }

    try {
      if (++activeInvocations === 1) writeStatus('busy');
      let result;
      try {
        result = await callClaude(prompt, { roomId, correlationId });
      } finally {
        if (--activeInvocations === 0) writeStatus('idle');
      }

      // [PASS] filtering: suppress output if agent has nothing to say
      if (!isDirect && result.trim().startsWith("[PASS]")) {
        console.log(`[Runner:${AGENT_ID}] [PASS] — not posting`);
      } else {
        let eventId;
        try {
          eventId = await sendFormatted(client, roomId, result);
        } catch (err) {
          try {
            appendEvent(AGENT_ID, roomId, {
              type: "error",
              correlationId,
              stage: "matrix",
              message: err.message,
            });
          } catch {}
          throw err;
        }
        try {
          appendEvent(AGENT_ID, roomId, {
            type: "message.posted",
            correlationId,
            eventId,
          });
        } catch {}
        console.log(`[Runner:${AGENT_ID}] Posted response (${result.length} chars)`);
      }
    } catch (err) {
      try {
        appendEvent(AGENT_ID, roomId, {
          type: "error",
          correlationId,
          stage: "claude",
          message: err.message,
        });
      } catch {}
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
