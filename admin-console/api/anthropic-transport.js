'use strict';

// ─── Streaming Anthropic Messages transport (impure) ─────────────────────────
//
// Streaming sibling of api.js's httpPostJson for the one caller that generates
// very large replies: the Flow Copilot. It forces `stream: true` and reads the
// Anthropic Messages SSE body (parsed by the pure ./anthropic-stream), so the
// whole-flow generation is NOT one long non-streaming request — bytes flow
// continuously, which keeps the internal Anthropic proxy from stalling and lets
// the route forward live progress to the browser.
//
// Two timers bound a run: an INACTIVITY timeout (Node's socket `timeout`) fires
// only on genuine silence — steady token deltas keep it open — and a total
// DEADLINE closes a legitimately long-but-alive stream cleanly with
// `{error:'deadline'}` just under the edge LB ceiling, so the user gets a real
// error card instead of a raw 504. `onProgress(chars)` is called (best-effort,
// never throwing into the socket) on every SSE frame so the caller can throttle
// a heartbeat. Resolves { status, body, text, error } like httpPostJson; a
// non-2xx response is buffered and JSON-parsed for the error message.
//
// Impure (network I/O) but self-contained, so it is exercised against a local
// SSE server in anthropic-transport.test.js rather than only inside api.js
// (which has no isolated harness).

const { createAnthropicStreamParser } = require('./anthropic-stream');

// Default just under a typical edge/proxy response ceiling; the copilot route
// passes an explicit deadline pinned to the GKE LB `timeoutSec`.
const DEFAULT_DEADLINE_MS = 280000;
const DEFAULT_INACTIVITY_MS = 60000;

function httpPostStreamText(targetUrl, headers = {}, bodyObj = {}, opts = {}) {
  const {
    inactivityMs = DEFAULT_INACTIVITY_MS,
    deadlineMs = DEFAULT_DEADLINE_MS,
    onProgress,
    // Injectable for tests; defaults to Node's http/https by URL scheme.
    httpLib,
  } = opts;
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (err) {
      return resolve({ status: 0, body: null, text: '', error: `Invalid URL: ${err.message}` });
    }
    const payload = Buffer.from(JSON.stringify({ ...bodyObj, stream: true }));
    const lib = httpLib || (parsed.protocol === 'https:' ? require('https') : require('http'));
    const parser = createAnthropicStreamParser();
    let settled = false;
    let deadlineTimer = null;
    const finish = (r) => {
      if (settled) return;
      settled = true;
      if (deadlineTimer) clearTimeout(deadlineTimer);
      resolve(r);
    };
    const req = lib.request({
      method: 'POST',
      hostname: parsed.hostname,
      port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
      path: parsed.pathname + parsed.search,
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        'Content-Length': payload.length,
        ...headers,
      },
      timeout: inactivityMs,
    }, (res) => {
      const ok2xx = res.statusCode >= 200 && res.statusCode < 300;
      let raw = ''; // non-2xx body (Anthropic returns JSON, not SSE, on an error)
      res.setEncoding('utf8');
      res.on('data', (c) => {
        if (ok2xx) {
          const chars = parser.push(c);
          if (typeof onProgress === 'function') {
            try { onProgress(chars); } catch { /* a progress hook must never kill the stream */ }
          }
        } else {
          raw += c;
        }
      });
      res.on('end', () => {
        if (!ok2xx) {
          let body = raw;
          try { body = raw ? JSON.parse(raw) : null; } catch { /* keep as string */ }
          return finish({ status: res.statusCode, body, text: '', error: null });
        }
        parser.end();
        finish({ status: res.statusCode, body: null, text: parser.getText(), error: parser.getError() });
      });
    });
    deadlineTimer = setTimeout(() => { req.destroy(); finish({ status: 0, body: null, text: parser.getText(), error: 'deadline' }); }, deadlineMs);
    req.on('error', (err) => finish({ status: 0, body: null, text: '', error: err.message }));
    req.on('timeout', () => { req.destroy(); finish({ status: 0, body: null, text: parser.getText(), error: 'timeout' }); });
    req.write(payload);
    req.end();
  });
}

module.exports = { httpPostStreamText, DEFAULT_DEADLINE_MS, DEFAULT_INACTIVITY_MS };
