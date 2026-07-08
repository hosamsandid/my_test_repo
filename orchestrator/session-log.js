'use strict';

/**
 * session-log.js — append-only structured event log per agent/room.
 *
 * Events are written one JSON object per line to:
 *   /workspace/agents/<agentId>/sessions/<roomId>.jsonl
 *
 * Two responsibilities:
 *   1. appendEvent()       — write a single event line
 *   2. mapStreamJsonLine() — translate one NDJSON line from
 *                            `claude --output-format stream-json --verbose`
 *                            into our normalized event schema (§4.1
 *                            of docs/agent-chat-plan.md).
 */

const fs = require('fs');
const path = require('path');

const SESSIONS_BASE = (agentId) => `/workspace/agents/${agentId}/sessions`;
const sessionFile = (agentId, roomId) =>
  path.join(SESSIONS_BASE(agentId), `${roomId}.jsonl`);

function ensureSessionDir(agentId) {
  fs.mkdirSync(SESSIONS_BASE(agentId), { recursive: true });
}

/**
 * Append a single event to the agent's per-room JSONL file.
 * The event must be a plain object. A `ts` field is added if missing.
 * Returns the (possibly enriched) event that was written.
 */
function appendEvent(agentId, roomId, event) {
  ensureSessionDir(agentId);
  const ev = { ts: event.ts || new Date().toISOString(), ...event };
  fs.appendFileSync(sessionFile(agentId, roomId), JSON.stringify(ev) + '\n');
  return ev;
}

/**
 * Translate a single NDJSON line emitted by
 * `claude --output-format stream-json --verbose` into our schema.
 *
 * Returns an array of normalized event objects (zero, one or many per line).
 * Never throws — JSON parse errors and unknown shapes are returned as
 * `error` / `unknown` events so we don't silently drop data.
 */
function mapStreamJsonLine(line, correlationId) {
  let parsed;
  try {
    parsed = JSON.parse(line);
  } catch (err) {
    return [{
      type: 'error',
      stage: 'stream-parse',
      message: err.message,
      correlationId,
      raw: typeof line === 'string' ? line.slice(0, 200) : String(line).slice(0, 200),
    }];
  }

  if (!parsed || typeof parsed !== 'object') {
    return [{ type: 'unknown', raw: parsed, correlationId }];
  }

  const events = [];

  switch (parsed.type) {
    case 'system': {
      if (parsed.subtype === 'init') {
        events.push({
          type: 'system_init',
          sessionId: parsed.session_id,
          model: parsed.model,
          correlationId,
        });
      } else if (parsed.subtype === 'task_progress') {
        // suppress — pure progress heartbeat, no display value
      } else {
        events.push({ type: 'system_event', subtype: parsed.subtype || 'unknown', raw: parsed, correlationId });
      }
      break;
    }

    case 'assistant': {
      const content = (parsed.message && Array.isArray(parsed.message.content))
        ? parsed.message.content
        : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'text') {
          events.push({
            type: 'assistant_text',
            text: block.text,
            correlationId,
          });
        } else if (block.type === 'tool_use') {
          events.push({
            type: 'tool_use',
            tool: block.name,
            toolId: block.id,
            input: block.input,
            correlationId,
          });
        } else if (block.type === 'thinking') {
          // Claude's extended thinking returns either plain text in
          // `thinking` (rare in practice) or — far more often — an empty
          // `thinking` field plus a `signature` blob. The signature carries
          // the thinking content in encrypted form; the API never exposes
          // it as readable text. We record `hasSignature` so the UI can
          // distinguish "no thinking happened" from "thinking happened but
          // was summarized server-side".
          events.push({
            type: 'thinking',
            text: typeof block.thinking === 'string' ? block.thinking : '',
            hasSignature: typeof block.signature === 'string' && block.signature.length > 0,
            correlationId,
          });
        } else {
          events.push({ type: 'unknown', raw: block, correlationId });
        }
      }
      break;
    }

    case 'user': {
      const content = (parsed.message && Array.isArray(parsed.message.content))
        ? parsed.message.content
        : [];
      for (const block of content) {
        if (!block || typeof block !== 'object') continue;
        if (block.type === 'tool_result') {
          let contentStr;
          if (typeof block.content === 'string') {
            contentStr = block.content;
          } else {
            try {
              contentStr = JSON.stringify(block.content);
            } catch {
              contentStr = String(block.content);
            }
          }
          events.push({
            type: 'tool_result',
            toolId: block.tool_use_id,
            ok: !block.is_error,
            content: contentStr,
            correlationId,
          });
        } else {
          events.push({ type: 'unknown', raw: block, correlationId });
        }
      }
      break;
    }

    case 'result': {
      const usage = parsed.usage || {};
      events.push({
        type: 'result',
        durationMs: parsed.duration_ms,
        tokens: {
          input: usage.input_tokens,
          output: usage.output_tokens,
        },
        costUsd: parsed.total_cost_usd,
        sessionId: parsed.session_id,
        result: parsed.result,
        correlationId,
      });
      break;
    }

    default:
      events.push({ type: 'unknown', raw: parsed, correlationId });
  }

  return events;
}

// Tool name Claude Code uses for its structured "ask the human a question" tool.
const ASK_USER_QUESTION_TOOL = 'AskUserQuestion';

/**
 * Render an `AskUserQuestion` tool input as human-readable Markdown for the
 * central chat (#447). Returns null when the input carries no usable question,
 * so the caller can fall back to the normal reply.
 *
 * The tool is intentionally not in the runner's --allowedTools whitelist: an
 * agent turn is a single non-interactive process (stdin closed), so it can
 * never be answered in-line. Instead the runner intercepts the tool_use, posts
 * the rendered question to the chat, and lets the user's next message continue
 * the resumed session.
 */
function formatAskUserQuestion(toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return null;
  const questions = toolInput.questions;
  if (!Array.isArray(questions) || questions.length === 0) return null;

  const blocks = [];
  for (const q of questions) {
    if (!q || typeof q !== 'object') continue;
    const lines = [];
    if (typeof q.header === 'string' && q.header.trim()) {
      lines.push(`**${q.header.trim()}**`);
    }
    if (typeof q.question === 'string' && q.question.trim()) {
      lines.push(q.question.trim());
    }
    if (Array.isArray(q.options)) {
      for (const opt of q.options) {
        if (!opt || typeof opt !== 'object') continue;
        if (typeof opt.label !== 'string' || !opt.label.trim()) continue;
        if (typeof opt.description === 'string' && opt.description.trim()) {
          lines.push(`- **${opt.label.trim()}** — ${opt.description.trim()}`);
        } else {
          lines.push(`- **${opt.label.trim()}**`);
        }
      }
    }
    if (q.multiSelect === true) {
      lines.push('_(You can pick more than one.)_');
    }
    if (lines.length) blocks.push(lines.join('\n'));
  }

  if (!blocks.length) return null;

  const body = blocks.join('\n\n');
  return (
    '❓ **The agent has a question before it can continue:**\n\n' +
    `${body}\n\n` +
    '_Reply here to answer — the agent will pick up where it left off._'
  );
}

module.exports = {
  appendEvent,
  mapStreamJsonLine,
  sessionFile,
  formatAskUserQuestion,
  ASK_USER_QUESTION_TOOL,
};
