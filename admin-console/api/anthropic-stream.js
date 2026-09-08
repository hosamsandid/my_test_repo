'use strict';

// ─── Anthropic Messages SSE parser (pure) ────────────────────────────────────
//
// The Flow Copilot's upstream LLM call streams (`stream: true`) so a large
// whole-flow generation does not sit as one long non-streaming request: bytes
// flow continuously, which keeps the internal Anthropic proxy from stalling and
// lets the route forward live progress to the browser. The impure transport
// (admin-console/api/api.js `httpPostStreamText`) owns the socket; everything
// that turns raw SSE bytes into accumulated text + a first error lives here so
// it is unit-testable in isolation (the api.js "no isolated harness" split, #651).
//
// Wire format (Anthropic Messages streaming): newline-delimited SSE frames of
// `event: <type>` + `data: <json>` lines. We read only `data:` lines and switch
// on the decoded object's own `type` (the `event:` line is redundant). Text is
// the concatenation of every `content_block_delta` whose `delta.text` is a
// string (a `text_delta`); a mid-stream `{"type":"error", …}` frame captures the
// first error message so the caller can surface it instead of a truncated reply.
// A trailing partial line is buffered across chunks — an SSE frame can split
// across TCP reads.

/**
 * A stateful, chunk-fed accumulator. Feed it decoded UTF-8 string chunks with
 * `push(chunk)`; read the running result with `getText()` / `getError()`.
 *
 * `push` returns the total accumulated text length so the caller can throttle a
 * progress heartbeat without re-measuring — an SSE `ping` frame (no delta) adds
 * no characters and returns the unchanged length, which is still a useful
 * liveness signal.
 */
function createAnthropicStreamParser() {
  let buf = '';
  let text = '';
  let error = null;

  function consumeLine(line) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return; // event:/id:/blank lines and comments
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return; // some proxies append an OpenAI-style sentinel
    let ev;
    try { ev = JSON.parse(data); } catch { return; } // skip a corrupt frame, keep streaming
    if (!ev || typeof ev !== 'object') return;
    if (ev.type === 'content_block_delta' && ev.delta && typeof ev.delta.text === 'string') {
      text += ev.delta.text;
    } else if (ev.type === 'error' && error === null) {
      error = (ev.error && (ev.error.message || ev.error.type)) || 'stream error';
    }
  }

  return {
    push(chunk) {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        consumeLine(line);
      }
      return text.length;
    },
    // Flush a trailing line with no terminating newline (a stream cut mid-frame).
    // Idempotent: it clears the buffer, so a second call is a no-op.
    end() {
      if (buf) {
        const line = buf;
        buf = '';
        consumeLine(line);
      }
      return text.length;
    },
    getText() { return text; },
    getError() { return error; },
  };
}

module.exports = { createAnthropicStreamParser };
