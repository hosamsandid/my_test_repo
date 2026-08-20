// Minimal reverse proxy that lets the `claude` CLI talk to the real Anthropic
// API through a plain API key (`sk-ant-api03-...`).
//
// Why this exists: this platform's `authType: "api-key"` provider wiring
// always injects the credential as `ANTHROPIC_AUTH_TOKEN`, which the Claude
// CLI sends as `Authorization: Bearer <token>` — the transport LiteLLM/Azure/
// enterprise gateways expect. The real `api.anthropic.com` does NOT accept a
// standard API key that way (only `x-api-key`); it 401s with
// "Invalid bearer token". Rather than change the CLI's auth transport (which
// would break the proxy/gateway case this wiring is built for), this proxy
// sits between the two: it accepts the same Bearer-token request the CLI
// already sends, and re-issues it upstream as `x-api-key`, unmodified
// otherwise. Point ANTHROPIC_BASE_URL at this proxy instead of
// api.anthropic.com directly to bridge the gap.
//
// A request that already carries `x-api-key` (the admin-console's own direct
// one-shot /v1/messages calls set both headers today) is forwarded as-is —
// this proxy only ever *adds* x-api-key from a bearer token, never removes
// one that's already present correctly.

const https = require("https");
const http = require("http");

const DEFAULT_UPSTREAM = "https://api.anthropic.com";

// Headers that must never be forwarded verbatim — either they describe the
// hop to THIS proxy (host, connection) or they'd carry the untranslated
// bearer credential upstream.
const STRIP_REQUEST_HEADERS = new Set(["host", "authorization", "content-length"]);

function buildUpstreamHeaders(incomingHeaders) {
  const headers = {};
  for (const [key, value] of Object.entries(incomingHeaders || {})) {
    if (STRIP_REQUEST_HEADERS.has(key.toLowerCase())) continue;
    headers[key] = value;
  }
  const alreadyHasApiKey = Object.keys(headers).some((k) => k.toLowerCase() === "x-api-key");
  if (!alreadyHasApiKey) {
    const auth = incomingHeaders?.authorization || incomingHeaders?.Authorization;
    const m = typeof auth === "string" ? auth.match(/^Bearer\s+(.+)$/i) : null;
    if (m) headers["x-api-key"] = m[1];
  }
  return headers;
}

// Factory so the forwarding logic can be exercised without binding a real
// port (`node --test`-friendly); `requestFn` is injectable for tests.
function createAnthropicProxyServer({ upstreamBase = DEFAULT_UPSTREAM, requestFn = https.request } = {}) {
  const upstream = new URL(upstreamBase);

  return http.createServer((req, res) => {
    const headers = buildUpstreamHeaders(req.headers);
    const proxyReq = requestFn(
      {
        protocol: upstream.protocol,
        hostname: upstream.hostname,
        port: upstream.port || (upstream.protocol === "https:" ? 443 : 80),
        path: req.url,
        method: req.method,
        headers,
      },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      }
    );
    proxyReq.on("error", (err) => {
      if (res.headersSent) { res.end(); return; }
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        type: "error",
        error: { type: "api_error", message: `anthropic-proxy: upstream request failed: ${err.message}` },
      }));
    });
    req.pipe(proxyReq);
  });
}

module.exports = { createAnthropicProxyServer, buildUpstreamHeaders, DEFAULT_UPSTREAM };
