const {
  MatrixClient,
  SimpleFsStorageProvider,
  AutojoinRoomsMixin,
} = require("matrix-bot-sdk");
const { spawn } = require("child_process");
const path = require("path");
const { marked } = require("marked");

// --- Config ---
const HOMESERVER = process.env.MATRIX_HOMESERVER;
const WATCHER_TOKEN = process.env.MATRIX_ACCESS_TOKEN; // @orchestrator:local — watches only
const GENERAL_TOKEN = process.env.SYNTH_ACCESS_TOKEN; // @general:local — posts synthesis
const WATCHER_USER_ID = process.env.MATRIX_BOT_USER_ID;
const MULTI_AGENT_ROOM = process.env.MULTI_AGENT_ROOM;
const WORKSPACE = "/workspace";

// Timing
const QUIET_DELAY = 10_000; // 10s after last expert response
const MAX_TIMEOUT = 240_000; // 4 min max wait

// --- Build expert registry ---
const EXPERTS = [];
for (const [key, val] of Object.entries(process.env)) {
  const match = key.match(/^EXPERT_(\w+)_USER_ID$/);
  if (match) {
    EXPERTS.push({
      userId: val,
      name: process.env[`EXPERT_${match[1]}_NAME`] || `Expert ${match[1]}`,
    });
  }
}

const SYNTH_USER_ID = process.env.SYNTH_USER_ID || "@general:local";

const ALL_BOT_IDS = new Set([
  WATCHER_USER_ID,
  SYNTH_USER_ID,
  ...EXPERTS.map((e) => e.userId),
]);
const EXPERT_IDS = new Set(EXPERTS.map((e) => e.userId));

// --- Active task state ---
let activeTask = null;

// --- Call Claude Code CLI for synthesis ---
function callClaude(prompt, timeoutMs = 180_000) {
  return new Promise((resolve, reject) => {
    const args = [
      "-p", prompt,
      "--output-format", "json",
      "--permission-mode", "acceptEdits",
    ];
    const proc = spawn("claude", args, {
      cwd: WORKSPACE,
      env: { ...process.env, HOME: "/root" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d) => (stdout += d));
    proc.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      proc.kill("SIGTERM");
      reject(new Error("Claude timeout"));
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

// --- Synthesize and post as General Agent ---
async function triggerSynthesis(generalClient, roomId) {
  if (!activeTask) return;

  const task = activeTask;
  activeTask = null;
  if (task.quietTimer) clearTimeout(task.quietTimer);
  if (task.maxTimer) clearTimeout(task.maxTimer);

  // Skip if 0 or 1 expert responded — no synthesis needed
  if (task.expertResponses.length <= 1) {
    console.log(
      `[Watcher] ${task.expertResponses.length} expert(s) — synthesis not needed`
    );
    return;
  }

  console.log(
    `[Watcher] Synthesizing ${task.expertResponses.length} expert responses`
  );

  const context = task.expertResponses
    .map((r) => `### ${r.name}\n${r.response}`)
    .join("\n\n");

  try {
    const result = await callClaude(
      `Du bist ein Moderator in einem Multi-Agenten-Chat. Mehrere Experten haben auf eine Nutzerfrage geantwortet. Fasse die Ergebnisse zusammen.

Nutzerfrage: ${task.originalTask}

Experten-Antworten:
${context}

Regeln:
- Beginne mit einem kurzen Einleitungssatz (z.B. "Ich fasse zusammen:")
- Nutze eine Vergleichstabelle wenn sinnvoll
- Max 1500 Zeichen
- Antworte in der Sprache der Frage
- Falls die Experten das Thema bereits gut abgedeckt haben und eine Zusammenfassung keinen Mehrwert bringt, antworte mit genau: [PASS]`
    );

    if (result.trim().startsWith("[PASS]")) {
      console.log("[Watcher] Synthesis not needed (PASS)");
      return;
    }

    // Post as @general:local with formatted HTML
    const html = marked.parse(result);
    await generalClient.sendMessage(roomId, {
      msgtype: "m.text",
      body: result,
      format: "org.matrix.custom.html",
      formatted_body: html,
    });
    console.log(`[Watcher] Synthesis posted (${result.length} chars)`);
  } catch (err) {
    console.error(`[Watcher] Synthesis error: ${err.message}`);
  }
}

function resetQuietTimer(generalClient, roomId) {
  if (!activeTask) return;
  if (activeTask.quietTimer) clearTimeout(activeTask.quietTimer);

  const allResponded = EXPERTS.every((e) =>
    activeTask.respondedIds.has(e.userId)
  );
  const delay = allResponded ? 5_000 : QUIET_DELAY;

  activeTask.quietTimer = setTimeout(
    () => triggerSynthesis(generalClient, roomId),
    delay
  );
}

// --- Main ---
async function main() {
  if (!HOMESERVER || !WATCHER_TOKEN || !GENERAL_TOKEN) {
    console.error("MATRIX_HOMESERVER, MATRIX_ACCESS_TOKEN, and SYNTH_ACCESS_TOKEN required");
    process.exit(1);
  }

  // Watcher client — listens to messages (as @orchestrator:local)
  const watcherStorage = new SimpleFsStorageProvider(
    path.join(WORKSPACE, ".watcher-state.json")
  );
  const watcherClient = new MatrixClient(HOMESERVER, WATCHER_TOKEN, watcherStorage);
  AutojoinRoomsMixin.setupOnClient(watcherClient);

  // General Agent client — posts synthesis (as @general:local)
  const generalStorage = new SimpleFsStorageProvider(
    path.join(WORKSPACE, ".general-state.json")
  );
  const generalClient = new MatrixClient(HOMESERVER, GENERAL_TOKEN, generalStorage);

  const startTime = Date.now();

  console.log("[Watcher] Experts:");
  for (const e of EXPERTS) console.log(`  ${e.name} (${e.userId})`);
  console.log(`[Watcher] Posts synthesis as: ${SYNTH_USER_ID}`);

  watcherClient.on("room.message", async (roomId, event) => {
    if (event.sender === WATCHER_USER_ID) return;
    if (event.sender === SYNTH_USER_ID) return;
    if (event.content?.msgtype !== "m.text") return;
    if (event.origin_server_ts < startTime) return;
    if (MULTI_AGENT_ROOM && roomId !== MULTI_AGENT_ROOM) return;

    const body = event.content.body;
    if (!body) return;

    // --- Expert response: collect ---
    if (activeTask && EXPERT_IDS.has(event.sender)) {
      const expert = EXPERTS.find((e) => e.userId === event.sender);
      if (!expert || activeTask.respondedIds.has(event.sender)) return;

      console.log(`[Watcher] Expert: ${expert.name} (${body.length} chars)`);
      activeTask.respondedIds.add(event.sender);
      activeTask.expertResponses.push({ name: expert.name, response: body });

      resetQuietTimer(generalClient, roomId);
      return;
    }

    // --- Ignore other bots ---
    if (ALL_BOT_IDS.has(event.sender)) return;

    // --- Human message: start watching ---
    if (activeTask) {
      if (activeTask.quietTimer) clearTimeout(activeTask.quietTimer);
      if (activeTask.maxTimer) clearTimeout(activeTask.maxTimer);
    }

    console.log(`[Watcher] New task: ${body.substring(0, 80)}`);

    activeTask = {
      originalTask: body,
      expertResponses: [],
      respondedIds: new Set(),
      quietTimer: null,
      maxTimer: null,
    };

    activeTask.maxTimer = setTimeout(
      () => triggerSynthesis(generalClient, roomId),
      MAX_TIMEOUT
    );
  });

  await watcherClient.start();
  console.log(`[Watcher] Listening as ${WATCHER_USER_ID}`);
  console.log(`[Watcher] Room: ${MULTI_AGENT_ROOM || "(all rooms)"}`);
  console.log("[Watcher] Watching...");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
