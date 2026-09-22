'use strict';

// ─── gke broker sidecar (GKE cluster access plugin, READ-ONLY pilot) ─────────
//
// Built on the Broker SDK (broker-sdk/). It holds the GCP credential and is the
// ONLY place it lives (concept §3): a team-admin signs the broker in to GCP
// through the plugin's own UI (gcp-auth.js), and the broker mints the ~1h
// Connect-Gateway bearer for kubectl itself. The agent never sees any of it.
//
// Two request surfaces:
//   1. `/mcp`  — the agent CLI (aee-gke) over Streamable-HTTP MCP. Two tools:
//        • kube_read   — run one READ-ONLY kubectl call (kubectl-client.js is the
//                        server-side verb allowlist + flag denylist).
//        • auth_status — is the broker signed in, and as whom.
//   2. `/ui/*` — the sign-in UI, proxied by the console behind the session gate.
//        Every request carries signed viewer headers; the broker verifies them
//        and re-enforces team-admin (the plugin's whole UI is admin-only — only
//        a team admin authenticates the shared cluster credential).
//
// Least privilege: this process gets ONLY the signing secret + whatever GCP
// login a team-admin performed. It mounts no workspace and reads no other
// credential. It creates no cluster resources, so teardown reaps nothing.

const http = require('http');

const {
  verifyScopeToken,
  auditWriter,
  maskSecretsOrDefault,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
} = require('../../../broker-sdk');
const kube = require('./kubectl-client');
const auth = require('./gcp-auth');
const { verifyViewerHeaders, roleAllows } = require('./viewer-headers');

const PLUGIN_ID = 'gke';

const cfg = brokerConfig({
  fallbacks: {
    port: ['GKE_BROKER_PORT'],
    signingSecret: ['GKE_BROKER_SIGNING_SECRET'],
    stateDir: ['GKE_STATE_DIR'],
    auditDir: ['GKE_AUDIT_DIR'],
  },
});
const PORT = cfg.port || 4007;
const SIGNING_SECRET = cfg.signingSecret;
const AUDIT_DIR = cfg.auditDir || '/workspace/plugin-audit/gke';
const CONNECT_SERVER = process.env.GKE_CONNECT_SERVER || '';

const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

// The whole UI is Team-Admin (manifest declares one route `/` at team-admin):
// only an admin authenticates the shared cluster credential.
const UI_MIN_ROLE = 'team-admin';

const scopeRegistry = new Map();
function agentFor(scopeId) {
  const ctx = scopeRegistry.get(scopeId);
  return (ctx && ctx.agentId) || scopeId;
}
function writeAudit(scopeId, subcommand, outcome) {
  try { audit.write({ pluginId: PLUGIN_ID, scopeId, agentId: agentFor(scopeId), subcommand, outcome }); }
  catch { /* best-effort */ }
}

// The MCP SDK is only needed for the live tool surface; lazy-required so the
// pure modules (kubectl-client / gcp-auth) unit-test with no deps.
let McpServer, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js'));
} catch { /* absent in unit-test host; the live sidecar image bundles it */ }

const TOOLS = [
  { name: 'kube_read', description: 'Run one READ-ONLY kubectl call. args: { argv: string[] } e.g. ["get","ns"].' },
  { name: 'auth_status', description: 'Whether the broker is signed in to GCP, and as whom.' },
];

function textResult(obj, isError) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
}

async function runTool(scopeId, name, args) {
  args = args || {};

  if (name === 'auth_status') {
    writeAudit(scopeId, 'status', 'ok');
    return textResult(auth.status());
  }

  if (name === 'kube_read') {
    if (!CONNECT_SERVER) {
      writeAudit(scopeId, 'kube_read', 'error');
      return textResult('broker misconfigured: GKE_CONNECT_SERVER is not set', true);
    }
    const token = auth.accessToken();
    if (!token) {
      writeAudit(scopeId, 'kube_read', 'denied');
      return textResult(
        'not signed in: a team admin must authenticate the GKE plugin in its UI first',
        true,
      );
    }
    const argv = Array.isArray(args.argv) ? args.argv : [];
    const verb = String(argv[0] || '');
    let result;
    try {
      result = kube.runKubectl(argv, { server: CONNECT_SERVER, token });
    } catch (err) {
      // buildReadArgs policy violation (non-read verb / denied flag)
      writeAudit(scopeId, verb || 'kube_read', 'denied');
      return textResult((err && err.message) || String(err), true);
    }
    // maskSecretsOrDefault(raw, fallback, secrets). Passing the token as the
    // second argument made it the FALLBACK: nothing was masked, and an empty
    // read handed the live cluster bearer straight back to the agent.
    const masked = maskSecretsOrDefault(result.output, '(no output)', [token]);
    writeAudit(scopeId, verb || 'kube_read', result.ok ? 'ok' : 'error');
    return textResult(masked, !result.ok);
  }

  return textResult({ error: `unknown tool: ${name}` }, true);
}

function scopeFromAuth(req) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  return v && v.pluginId === PLUGIN_ID ? v.scopeId : null;
}

// ── the served sign-in UI (team-admin only) ──────────────────────────────────

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(s));
  });
}
function parseJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

async function handleUi(req, res, uiPath) {
  const viewer = verifyViewerHeaders(req, SIGNING_SECRET);
  if (!viewer) return sendJson(res, 401, { error: 'unsigned viewer' });
  if (!roleAllows(viewer.role, UI_MIN_ROLE)) {
    return sendJson(res, 403, { error: `the GKE plugin UI requires ${UI_MIN_ROLE}; viewer is ${viewer.role}` });
  }

  if (uiPath === '/api/status' && req.method === 'GET') {
    return sendJson(res, 200, auth.status());
  }
  if (uiPath === '/api/login/begin' && req.method === 'POST') {
    const r = auth.beginLogin();
    // give gcloud a beat to print the URL
    await new Promise((r2) => setTimeout(r2, 1500));
    const u = auth.loginUrl(r.id);
    return sendJson(res, 200, { id: r.id, url: u.url || null, error: r.error || u.error || null });
  }
  if (uiPath === '/api/login/url' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    return sendJson(res, 200, auth.loginUrl(id));
  }
  if (uiPath === '/api/login/code' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    return sendJson(res, 200, auth.submitCode(body.id, body.code));
  }
  if (uiPath === '/api/login/result' && req.method === 'GET') {
    const id = new URL(req.url, 'http://x').searchParams.get('id');
    return sendJson(res, 200, auth.loginResult(id));
  }
  if (uiPath === '/api/paste-token' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    return sendJson(res, 200, auth.pasteToken(body.token, body.account));
  }
  if (uiPath === '/api/logout' && req.method === 'POST') {
    return sendJson(res, 200, auth.logout());
  }

  // static: only index.html (single-page UI)
  if (uiPath === '/' || uiPath === '' || uiPath === '/index.html') {
    const fs = require('fs');
    const path = require('path');
    return fs.readFile(path.join(__dirname, 'ui', 'index.html'), (err, data) => {
      if (err) return sendJson(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(data);
    });
  }
  return sendJson(res, 404, { error: 'not found' });
}

const handleHealth = healthEndpoint(async () => ({ signedIn: auth.status().signedIn, server: !!CONNECT_SERVER }));
const handleTeardown = teardownScopeEndpoint(() => ({ reaped: 0 }), { secret: SIGNING_SECRET });

function buildMcpServer(scopeId) {
  const server = new McpServer({ name: PLUGIN_ID, version: '1.0.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map(({ name, description }) => ({
      name, description, inputSchema: { type: 'object', additionalProperties: true },
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params || {};
    return runTool(scopeId, name, args || {});
  });
  return server;
}

async function handleRequest(req, res) {
  const urlPath = (req.url || '').split('?')[0];

  if (req.method === 'GET' && urlPath === '/healthz') return void (await handleHealth(req, res));
  if (req.method === 'POST' && urlPath === '/internal/teardown-scope') return void (await handleTeardown(req, res));

  if (req.method === 'PUT' && urlPath === '/internal/scope-registry') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v) return void sendJson(res, 401, { error: 'unauthorized' });
    const parsed = parseJson(await readBody(req));
    scopeRegistry.clear();
    for (const [scopeId, ctx] of Object.entries(parsed.scopes || {})) scopeRegistry.set(scopeId, ctx);
    return void sendJson(res, 200, { ok: true, scopes: scopeRegistry.size });
  }

  if (urlPath === '/ui' || urlPath.startsWith('/ui/')) {
    const uiPath = urlPath === '/ui' ? '/' : urlPath.slice('/ui'.length) || '/';
    return void (await handleUi(req, res, uiPath));
  }

  if (urlPath !== '/mcp') return void sendJson(res, 404, { error: 'not found' });
  if (!McpServer) return void sendJson(res, 501, { error: 'mcp sdk not installed' });

  const scopeId = scopeFromAuth(req);
  if (!scopeId) return void sendJson(res, 401, { error: 'unauthorized' });

  const mcpServer = buildMcpServer(scopeId);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on('close', () => { transport.close(); mcpServer.close(); });
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res);
}

const httpServer = http.createServer((req, res) => {
  handleRequest(req, res).catch((err) => {
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
    try { res.end(JSON.stringify({ error: (err && err.message) || String(err) })); } catch { /* ignore */ }
  });
});

if (require.main === module) {
  httpServer.listen(PORT, () => process.stdout.write(`[gke-broker] listening on :${PORT}\n`));
}

module.exports = { runTool, scopeFromAuth, scopeRegistry, TOOLS };
