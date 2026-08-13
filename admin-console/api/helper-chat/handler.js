'use strict';

// ─── Helper Chat endpoint (#1734, spec docs/helper-chat-concept.md) ──────────
//
// POST /api/helper/chat — the server-side streaming API that powers the
// in-console Helper Chat assistant. It grounds the model on the vendored
// documentation corpus (#1733, ./corpus.js) and streams the reply back as an
// NDJSON `delta`/`done` stream, exactly like POST /api/process/copilot.
//
// The LLM transport (resolveAssistTarget → buildMessagesUrl → httpPostJson →
// extractMessageText) lives in api.js; this module is handed those functions so
// the request-shape validation, message assembly and NDJSON plumbing stay
// unit-testable without a running server (api.js calls app.listen at import, so
// it has no isolated harness — same split as flow-copilot.js's pure core vs the
// copilot route). `api.js` wires the real functions in; the test injects mocks.
//
// The transport helper httpPostJson is a single non-streaming call (the repo has
// no token-streaming client), so the assistant text arrives whole and is emitted
// as one `delta` line followed by `done` — the NDJSON contract the client reads.

const corpus = require('./corpus');

// Keep the conversation bounded so the prompt can't grow without limit — the
// system prompt (corpus) is preserved untouched; only the oldest turns are
// dropped (concept / ticket #1734: max 20 turns).
const MAX_TURNS = 20;

// Chat answers are short prose, not a 16k-token bundle — a modest output budget.
// No `temperature` (newer models reject the deprecated param; any provider may
// serve this call), matching every other assist call site.
const MAX_TOKENS = 4000;

/**
 * Validate the request body. Returns `{ error }` for a malformed request (the
 * route maps it to HTTP 400) or the normalised `{ messages, currentRoute,
 * currentRouteLabel }` on success. `currentRoute`/`currentRouteLabel` are
 * optional strings — ignored when absent or not a string.
 */
function validateHelperChatRequest(body) {
  const messages = body && Array.isArray(body.messages) ? body.messages : null;
  if (!messages || messages.length === 0) {
    return { error: 'messages must be a non-empty array' };
  }
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant') || typeof m.content !== 'string') {
      return { error: "each message needs role 'user'|'assistant' and string content" };
    }
  }
  if (messages[messages.length - 1].role !== 'user') {
    return { error: 'the last message must have role "user"' };
  }
  const currentRoute = typeof body.currentRoute === 'string' ? body.currentRoute : undefined;
  const currentRouteLabel = typeof body.currentRouteLabel === 'string' ? body.currentRouteLabel : undefined;
  return { messages, currentRoute, currentRouteLabel };
}

/**
 * Trim the conversation to the newest `max` turns, keeping order. The system
 * prompt is not part of `messages`, so it is never affected.
 */
function trimMessages(messages, max = MAX_TURNS) {
  return messages.length > max ? messages.slice(-max) : messages;
}

/**
 * The Anthropic Messages payload (minus `model`, added by the route). The
 * grounding corpus + optional route context goes in the system prompt; the
 * client-held conversation passes through as the message turns.
 */
function buildHelperChatPayload({ messages, currentRouteLabel, buildSystemPrompt = corpus.buildSystemPrompt }) {
  return {
    max_tokens: MAX_TOKENS,
    system: buildSystemPrompt(currentRouteLabel),
    messages: trimMessages(messages).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content ?? ''),
    })),
  };
}

/**
 * Build the Express handler. The LLM transport + assist-selection helpers are
 * injected (their home is api.js); `buildSystemPrompt` defaults to the vendored
 * corpus loader but is overridable so a test can assert what it was called with.
 */
function createHelperChatHandler({
  resolveAssistTarget,
  buildMessagesUrl,
  httpPostJson,
  extractMessageText,
  assistMeta,
  sendAssistSelectionError,
  buildSystemPrompt = corpus.buildSystemPrompt,
}) {
  return async function helperChatHandler(req, res) {
    const parsed = validateHelperChatRequest(req.body || {});
    if (parsed.error) return res.status(400).json({ error: parsed.error });

    // Provider resolution happens BEFORE the NDJSON stream opens so a selection
    // error is a plain 400/403 JSON body (headers not sent yet) — same order as
    // POST /api/process/copilot.
    const target = resolveAssistTarget(req);
    if (target.selectionError) return sendAssistSelectionError(res, target);
    if (target.error) return res.status(400).json({ error: target.error });

    const url = buildMessagesUrl(target.baseUrl);
    const headers = {
      'anthropic-version': '2023-06-01',
      ...(target.token ? { Authorization: `Bearer ${target.token}`, 'x-api-key': target.token } : {}),
    };
    const payload = {
      model: target.model,
      ...buildHelperChatPayload({
        messages: parsed.messages,
        currentRouteLabel: parsed.currentRouteLabel,
        buildSystemPrompt,
      }),
    };

    // NDJSON stream plumbing — mirrors POST /api/process/copilot (flushHeaders /
    // setNoDelay; watch `res` for disconnect, not `req`).
    res.setHeader('Content-Type', 'application/x-ndjson; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    if (typeof res.socket?.setNoDelay === 'function') res.socket.setNoDelay(true);
    let aborted = false;
    res.on('close', () => { if (!res.writableEnded) aborted = true; });
    const emit = (ev) => {
      if (aborted) return;
      try { res.write(JSON.stringify(ev) + '\n'); } catch { /* socket gone */ }
    };

    // Provenance first (§4.5): announce which provider + model pays for this turn.
    emit({ type: 'assist', ...assistMeta(target).assist });

    try {
      const result = await httpPostJson(url, headers, payload, 180000);
      if (result.error || result.status < 200 || result.status >= 300) {
        const detail = result.error
          || (result.body && (result.body.error?.message || result.body.error || result.body.message))
          || `HTTP ${result.status}`;
        throw new Error(`LLM request failed: ${detail}`);
      }
      const text = extractMessageText(result.body);
      if (text) emit({ type: 'delta', text });
      emit({ type: 'done' });
    } catch (err) {
      emit({ type: 'error', message: err.message });
    }
    if (!aborted) res.end();
  };
}

module.exports = createHelperChatHandler;
module.exports.createHelperChatHandler = createHelperChatHandler;
module.exports.validateHelperChatRequest = validateHelperChatRequest;
module.exports.trimMessages = trimMessages;
module.exports.buildHelperChatPayload = buildHelperChatPayload;
module.exports.MAX_TURNS = MAX_TURNS;
module.exports.MAX_TOKENS = MAX_TOKENS;
