// Agent-chat step library (#668, docs/journey-spec-concept.md §2.2).
//
// Drives the embedded Matrix chat client at /chats/:agentId and asserts the DM
// round-trip through BOTH SSE surfaces the concept names (docs/e2e-testing-
// concept.md §2 F2, §7):
//   - the reply BUBBLE, delivered over the room SSE stream
//     (/api/matrix/rooms/:roomId/stream) and rendered in the chat panel;
//   - the session-log `result` EVENT, delivered over the session SSE stream
//     (/api/agents/:id/session/:roomId/stream) and appended to the JSONL log.
//
// No sleeps (§7): every wait is an auto-waiting assertion or an event-driven
// EventSource resolve with a bounded 30 s ceiling — the fake `claude` shim
// answers in milliseconds, so a timeout flags a real delivery bug (the exact
// #253 stream-miss surface F2 exists to catch), not slowness.
//
// No data-testids exist — selectors are placeholder / ARIA / visible text,
// verified against MessageInput.jsx, Message.jsx and the session-log path.
const { expect } = require('@playwright/test');

// The fake `claude` shim (agent-image/e2e/claude) echoes any `[[E2E:<token>]]`
// found in the prompt back as an `E2E-ACK:<token>` prefix on its reply, so a
// message carrying a unique token yields a deterministic, uniquely-attributable
// answer. Callers make the token unique per send.
function marker(token) {
  return `[[E2E:${token}]]`;
}
function ackPattern(token) {
  return new RegExp(`E2E-ACK:${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
}

// Ensure the agent's 1:1 DM room exists and return its id. The chat page also
// creates it lazily on mount, but resolving it up front (idempotent — the API
// reuses an existing room) gives the session-log assertion a stable room id.
async function ensureDmRoom(ctx, { agentId }) {
  const res = await ctx.request.post(`/api/matrix/agents/${encodeURIComponent(agentId)}/dm`);
  expect(
    res.ok(),
    `ensureDmRoom(${agentId}) expected 2xx, got HTTP ${res.status()}: ${await res.text()}`,
  ).toBeTruthy();
  const body = await res.json();
  return body.roomId;
}

/**
 * Wait until the agent's RUNTIME is demonstrably up before sending the first
 * message. The runtime drops any m.room.message whose origin_server_ts predates
 * its own process start (agent-entrypoint.py, `ts < start_time_ms`) — so a send
 * that races the container boot is silently ignored BY DESIGN, and F2 would
 * time out without any product bug. `/api/agents/statuses` flips the agent from
 * `offline` to `idle` exactly when the runtime has booted and pushed its
 * status.json (#185) — after that point, a fresh message is inside the
 * processing contract. Bounded poll, no sleeps beyond the interval tick.
 *
 * @param {string} params.agentId - Id of the agent whose runtime to wait for.
 * @param {number} [params.timeoutMs=90000] - Max time to wait for readiness.
 */
async function waitForAgentReady(ctx, { agentId, timeoutMs = 90_000 }) {
  const deadline = Date.now() + timeoutMs;
  let last = 'unknown';
  while (Date.now() < deadline) {
    const res = await ctx.request.get('/api/agents/statuses');
    if (res.ok()) {
      const list = await res.json();
      const entry = Array.isArray(list) ? list.find((a) => a.id === agentId) : null;
      last = entry?.activityState || 'missing';
      if (last === 'idle' || last === 'busy') return;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  expect(false, `agent ${agentId} runtime not ready after ${timeoutMs}ms (last state: ${last})`).toBeTruthy();
}

/**
 * Open an agent's DM chat and wait for the composer to be ready.
 * @param {string} params.agentId - Id of the agent whose DM chat to open.
 */
async function open(ctx, { agentId }) {
  const { page } = ctx;
  await page.goto(`/chats/${agentId}`);
  await expect(page.getByPlaceholder(/Message .*to send/)).toBeVisible();
}

/**
 * Type a message and send it via the Send control (the same path a human uses;
 * plain Enter is a newline, the button is disabled until the text is non-empty).
 * @param {string} params.text - Message body to type and send.
 */
async function send(ctx, { text }) {
  const { page } = ctx;
  const input = page.getByPlaceholder(/Message .*to send/);
  await input.fill(text);
  // The primary action's accessible name encodes the send keybinding hint
  // (#1427/#1704 — "Send — ⌘+↵" / "Send — Ctrl+↵" / "Send — ↵"), and flips to a
  // "Stop the running turn/loop" label while busy. Match the Send state by
  // prefix so the locator survives the OS/keybinding variants.
  const sendBtn = page.getByRole('button', { name: /^Send\b/ });
  await expect(sendBtn).toBeEnabled();
  await sendBtn.click();
  await expect(input).toHaveValue('');
}

// Room SSE surface: the agent's reply bubble arrives over
// /api/matrix/rooms/:roomId/stream and renders as a markdown bubble. Assert the
// deterministic marker echo shows up. This is the #253 surface — a miss here is
// a genuine delivery bug, so the wait is bounded (30 s) rather than open-ended.
async function expectReplyBubble(ctx, { token }) {
  await expect(ctx.page.getByText(ackPattern(token)).first()).toBeVisible({ timeout: 30_000 });
}

// Session SSE surface: subscribe to the real session-log SSE endpoint from the
// browser (same-origin, authenticated by the session cookie) and resolve on the
// `result` event carrying the same marker echo. This asserts the second stream
// directly at its source rather than scraping the Sessions panel, whose log is
// tied to session SELECTION (a sub-second fake-claude run finishes before a
// poll can catch it "active") — the stream replays from byte 0 (`since=0`), so
// the assertion is deterministic and free of sleeps.
async function expectSessionLogResult(ctx, { agentId, roomId, token }) {
  const { page } = ctx;
  const found = await page.evaluate(
    ({ agentId, roomId, token }) =>
      new Promise((resolve) => {
        const url =
          `/api/agents/${encodeURIComponent(agentId)}/session/` +
          `${encodeURIComponent(roomId)}/stream?since=0`;
        const es = new EventSource(url);
        const timer = setTimeout(() => {
          es.close();
          resolve({ ok: false, reason: 'timeout waiting for result event' });
        }, 30_000);
        es.onmessage = (e) => {
          let ev;
          try {
            ev = JSON.parse(e.data);
          } catch {
            return; // control frames / heartbeats
          }
          if (ev && ev.type === 'result') {
            clearTimeout(timer);
            es.close();
            resolve({ ok: true, result: ev.result, correlationId: ev.correlationId });
          }
        };
      }),
    { agentId, roomId, token },
  );
  expect(found.ok, found.reason || 'session-log result event not delivered').toBeTruthy();
  // The `result` event's payload is the fake shim's reply text — assert it is
  // the run we triggered, tying the session-log surface to this exact send.
  expect(found.result, 'session-log result event carries the marker echo').toMatch(ackPattern(token));
}

/**
 * Assert that a github-event TRIGGER woke this agent, observed on the session
 * SSE stream (#711 — "trigger fired = the agent's chat shows the trigger event
 * via SSE"). The runtime appends a `trigger.fired` event to the session log at
 * the head of every triggered run (agent-entrypoint.py `_execute_inner`); we
 * subscribe to that agent's session stream from byte 0 and resolve on it. Self-
 * contained: resolves the agent's DM room id itself (the trigger posts there),
 * so the journey YAML only names the agentId. The stream endpoint holds the
 * connection open even before the log file exists, so subscribing right after
 * applying the label is safe (no lost event, no sleep).
 *
 * @param {string} params.agentId - Id of the agent expected to be woken by the trigger.
 * @param {number} [params.timeoutMs=60000] - Max time to wait for the trigger.fired event.
 */
async function expectTriggerFired(ctx, { agentId, timeoutMs = 60_000 }) {
  const roomId = await ensureDmRoom(ctx, { agentId });
  const { page } = ctx;
  const found = await page.evaluate(
    ({ agentId, roomId, timeoutMs }) =>
      new Promise((resolve) => {
        const url =
          `/api/agents/${encodeURIComponent(agentId)}/session/` +
          `${encodeURIComponent(roomId)}/stream?since=0`;
        const es = new EventSource(url);
        const timer = setTimeout(() => {
          es.close();
          resolve({ ok: false, reason: `no trigger.fired within ${timeoutMs}ms` });
        }, timeoutMs);
        es.onmessage = (e) => {
          let ev;
          try {
            ev = JSON.parse(e.data);
          } catch {
            return; // heartbeats / control frames
          }
          if (ev && ev.type === 'trigger.fired') {
            clearTimeout(timer);
            es.close();
            resolve({ ok: true, triggerId: ev.triggerId, triggerType: ev.triggerType });
          }
        };
      }),
    { agentId, roomId, timeoutMs },
  );
  expect(found.ok, found.reason || 'trigger.fired not delivered on session SSE').toBeTruthy();
  // It must be the github-event channel trigger (not a stray cron), tying the
  // wake to the label hand-off this journey drove.
  expect(found.triggerType, `trigger.fired triggerType for ${agentId}`).toBe('github-event');
  return found;
}

module.exports = {
  marker,
  ensureDmRoom,
  waitForAgentReady,
  open,
  send,
  expectReplyBubble,
  expectSessionLogResult,
  expectTriggerFired,
};
