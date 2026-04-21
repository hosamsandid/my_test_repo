const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { marked } = require("marked");
const cron = require("node-cron");

// --- Render tables as <pre> ASCII art for Matrix compatibility ---
marked.use({
  renderer: {
    table({ header, rows }) {
      const allRows = [header, ...rows];
      const cols = header.length;
      const widths = Array.from({ length: cols }, (_, c) =>
        Math.max(...allRows.map((r) => (r[c]?.text || "").length))
      );
      const pad = (s, w) => s + " ".repeat(w - s.length);
      const sep = widths.map((w) => "─".repeat(w)).join("─┼─");

      let out = "";
      out += header.map((c, i) => pad(c.text, widths[i])).join(" │ ") + "\n";
      out += sep + "\n";
      for (const row of rows) {
        out += row.map((c, i) => pad(c.text, widths[i])).join(" │ ") + "\n";
      }
      return `<pre><code>${out}</code></pre>`;
    },
  },
});

// --- Config ---
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const ACCESS_TOKEN = process.env.MATRIX_ACCESS_TOKEN;
const BOT_USER_ID = process.env.MATRIX_BOT_USER_ID;
const DEFAULT_ROOM = process.env.MATRIX_DEFAULT_ROOM;
const WORKSPACE = "/workspace";
const SESSIONS_FILE = path.join(WORKSPACE, ".sessions.json");
const JOBS_FILE = path.join(WORKSPACE, "jobs.json");
const CLAUDE_TIMEOUT = 600_000; // 10 minutes

// --- Session persistence (roomId → sessionId) ---
let sessions = {};
try {
  if (fs.existsSync(SESSIONS_FILE)) {
    sessions = JSON.parse(fs.readFileSync(SESSIONS_FILE, "utf8"));
  }
} catch {}

function saveSessions() {
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2));
}

// --- Track rooms currently processing ---
const processing = new Set();

// --- Send formatted Matrix message ---
async function sendFormattedMessage(client, roomId, text) {
  const html = marked.parse(text);
  await client.sendMessage(roomId, {
    msgtype: "m.text",
    body: text,
    format: "org.matrix.custom.html",
    formatted_body: html,
  });
}

// --- Call Claude Code CLI ---
function callClaude(message, sessionId, timeoutMs = CLAUDE_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const args = [];
    if (sessionId) {
      args.push("-r", sessionId);
    }

    const memoryHint = !sessionId
      ? "IMPORTANT: This is a new conversation. Read memory/context.md and memory/log.md first (if they exist) before responding."
      : "If the user asks you to remember something or wraps up: update the memory files (memory/context.md, memory/log.md).";

    args.push(
      "-p", message,
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
      "--append-system-prompt", memoryHint,
      "--allowedTools", "Bash(*)",
      "--allowedTools", "Read(*)",
      "--allowedTools", "Write(*)",
      "--allowedTools", "Edit(*)",
      "--allowedTools", "Glob(*)",
      "--allowedTools", "Grep(*)",
      "--allowedTools", "WebSearch(*)",
      "--allowedTools", "WebFetch(*)"
    );

    const proc = spawn("claude", args, {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: "/root" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));

    const timeoutMin = Math.round(timeoutMs / 60_000);
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error(`Timeout (${timeoutMin} min)`));
    }, timeoutMs);

    proc.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        return reject(
          new Error(stderr.substring(0, 300) || `Exit code ${code}`)
        );
      }
      try {
        const lines = stdout.split("\n").filter((l) => l.trim().startsWith("{"));
        const result = JSON.parse(lines[lines.length - 1]);
        resolve(result);
      } catch {
        resolve({ result: stdout.trim(), session_id: null });
      }
    });

    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

// =============================================================
// Scheduler
// =============================================================

function loadJobs() {
  try {
    if (fs.existsSync(JOBS_FILE)) {
      return JSON.parse(fs.readFileSync(JOBS_FILE, "utf8"));
    }
  } catch (err) {
    console.error("[Scheduler] Error loading jobs.json:", err.message);
  }
  return [];
}

function saveJobs(jobs) {
  fs.writeFileSync(JOBS_FILE, JSON.stringify(jobs, null, 2));
}

// Active cron tasks: id → { task, cronExpr }
const cronTasks = new Map();

async function executeJob(job, client) {
  const roomId = job.roomId || DEFAULT_ROOM;
  if (!roomId) {
    console.error(`[Scheduler] No room for job "${job.description}"`);
    return;
  }

  const jobTimeout = job.timeoutSeconds ? job.timeoutSeconds * 1000 : CLAUDE_TIMEOUT;
  console.log(`[Scheduler] Executing: ${job.description}`);
  try {
    const result = await callClaude(job.prompt, null, jobTimeout);
    const response = result.result || "Job executed.";
    await sendFormattedMessage(client, roomId, response);
    console.log(`[Scheduler] Done: ${job.description}`);
  } catch (err) {
    console.error(`[Scheduler] Error: ${job.description}:`, err.message);
    try {
      await client.sendText(roomId, `Job "${job.description}" failed: ${err.message}`);
    } catch {}
  }
}

function syncScheduler(client) {
  const jobs = loadJobs();

  // --- Recurring jobs: sync with node-cron ---
  const activeIds = new Set();
  for (const job of jobs) {
    if (job.type !== "recurring" || !job.enabled) continue;
    activeIds.add(job.id);

    const existing = cronTasks.get(job.id);
    if (existing && existing.cronExpr === job.cron) continue;

    if (existing) {
      existing.task.stop();
      console.log(`[Scheduler] Updated: ${job.description}`);
    }

    if (!cron.validate(job.cron)) {
      console.error(`[Scheduler] Invalid cron: ${job.cron} (${job.description})`);
      continue;
    }

    const task = cron.schedule(job.cron, () => executeJob(job, client), {
      timezone: "Europe/Berlin",
    });
    cronTasks.set(job.id, { task, cronExpr: job.cron });
    console.log(`[Scheduler] Scheduled: ${job.description} (${job.cron})`);
  }

  // Remove tasks no longer in jobs
  for (const [id, { task }] of cronTasks) {
    if (!activeIds.has(id)) {
      task.stop();
      cronTasks.delete(id);
      console.log(`[Scheduler] Removed: ${id}`);
    }
  }

  // --- One-shot jobs: check if due ---
  const now = Date.now();
  let changed = false;
  for (const job of jobs) {
    if (job.type !== "once" || !job.enabled) continue;
    const at = new Date(job.at).getTime();
    if (now >= at) {
      executeJob(job, client);
      job._done = true;
      changed = true;
    }
  }
  if (changed) {
    saveJobs(jobs.filter((j) => !j._done));
  }
}

function initScheduler(client) {
  syncScheduler(client);
  setInterval(() => syncScheduler(client), 60_000);
  console.log("[Scheduler] Started (sync every 60s)");
}

// =============================================================
// Main
// =============================================================

async function main() {
  if (!HOMESERVER || !ACCESS_TOKEN) {
    console.error("MATRIX_HOMESERVER and MATRIX_ACCESS_TOKEN required");
    process.exit(1);
  }

  const storage = new SimpleFsStorageProvider(
    path.join(WORKSPACE, ".matrix-state.json")
  );
  const client = new MatrixClient(HOMESERVER, ACCESS_TOKEN, storage);
  AutojoinRoomsMixin.setupOnClient(client);

  const botUserId = BOT_USER_ID || (await client.getUserId());

  // Ignore messages from before bridge start
  const startTime = Date.now();

  client.on("room.message", async (roomId, event) => {
    if (event.sender === botUserId) return;
    if (event.content?.msgtype !== "m.text") return;
    if (event.origin_server_ts < startTime) return;

    const body = event.content.body;
    if (!body) return;

    // In group rooms require mention
    try {
      const members = await client.getJoinedRoomMembers(roomId);
      if (members.length > 2) {
        const mentioned =
          body.includes(botUserId) || /claude/i.test(body);
        if (!mentioned) return;
      }
    } catch {}

    // Prevent concurrent processing per room
    if (processing.has(roomId)) {
      await client.sendText(
        roomId,
        "Still processing the previous message..."
      );
      return;
    }

    processing.add(roomId);
    console.log(`[${roomId}] ${event.sender}: ${body}`);

    try {
      const result = await callClaude(body, sessions[roomId]);

      if (result.session_id) {
        sessions[roomId] = result.session_id;
        saveSessions();
      }

      const response = result.result || "No response.";
      await sendFormattedMessage(client, roomId, response);
      console.log(`[${roomId}] Response (${response.length} chars)`);
    } catch (err) {
      console.error(`[${roomId}] Error:`, err.message);
      await client.sendText(roomId, `Error: ${err.message}`);
    } finally {
      processing.delete(roomId);
    }
  });

  await client.start();
  console.log(`Bridge started as ${botUserId}`);
  console.log(`Homeserver: ${HOMESERVER}`);
  console.log(`Default Room: ${DEFAULT_ROOM}`);
  console.log("Waiting for messages...");

  // Start scheduler after Matrix is connected
  initScheduler(client);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
