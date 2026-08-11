'use strict';

// ─── netzplan broker sidecar (plugin #3, epic #1554, Phase 3, #1563) ─────────
//
// Plugin #3's broker, built ON the Broker SDK (broker-sdk/). Unlike plugins #1
// and #2 it holds NO credential (manifest `capabilities: []`, `credentials:
// []`) — its whole job is to be the single server-side home of one document per
// team (the planning board) and to serve that board's UI into the console.
// Everything security-shaped comes from the SDK, so this file is wiring:
//
//   • verifyScopeToken   — bearer `{pluginId, scopeId}` on the agent CLI path.
//   • auditWriter        — one JSONL line per agent write, naming the calling
//                          agent (agentId) distinct from the board's scopeId.
//   • healthEndpoint / teardownScopeEndpoint — the two REST routes the
//                          orchestrator calls on every broker; teardown reaps
//                          the team's documents BEFORE the token is invalidated.
//   • verifyViewerHeaders (copied §4.8 scheme, viewer-headers.js) — the signed
//                          console-user identity + role on the UI path.
//
// Two request surfaces:
//   1. `/mcp` — the agent CLI (aee-plan) over Streamable-HTTP MCP. Reads are
//      always allowed; writes are gated by the board's autonomy level
//      (broker-sdk/authz.js is generic; here the level lives on the document, so
//      PlanStore.mutate enforces it — the "refusal holds when the broker is
//      called directly" acceptance).
//   2. `/ui/*` — the board UI + its data API, proxied by the console. Every
//      request carries signed viewer headers; the broker verifies them and
//      re-enforces the ui.routes minRole (team-member for the board, team-admin
//      for /admin) so a bypassed proxy cannot open /admin as a member. The board
//      renders all four §5 primitives and, in Edit mode, drives every mutation
//      through the human-write `/api/mutate` endpoint (role-gated, NOT autonomy-
//      gated — autonomy governs the agent path); `set-autonomy` stays the
//      Team-Admin-only `/api/settings` route.
//
// #1564 completes the board's edit surface: the three remaining primitives
// (graph / bipartite / blocks) plus panel add/remove/reorder over the existing
// swimlane editing, all on the pure plan-doc.js mutations. The direct-
// manipulation polish (drag reorder, colour pickers, requirement-target-by-click,
// undo/redo) is a refinement over these same ops — see README / the PR.

const http = require('http');
const fs = require('fs');
const path = require('path');

const {
  verifyScopeToken,
  auditWriter,
  healthEndpoint,
  teardownScopeEndpoint,
  brokerConfig,
  quotaExceeded,
} = require('../../../broker-sdk');
const { PlanStore } = require('./plan-store');
const { requiredAutonomy } = require('./plan-doc');
const { exportPlanDoc } = require('./plan-import');
const { verifyViewerHeaders, requiredRoleForPath, roleAllows } = require('./viewer-headers');

const PLUGIN_ID = 'netzplan';

// The orchestrator's env contract (§4.8 / broker-config.js). `fallbacks` lets an
// operator run the broker standalone with NETZPLAN_* names while developing.
const cfg = brokerConfig({
  fallbacks: {
    port: ['NETZPLAN_BROKER_PORT'],
    signingSecret: ['NETZPLAN_BROKER_SIGNING_SECRET'],
    stateDir: ['NETZPLAN_STATE_DIR'],
    auditDir: ['NETZPLAN_AUDIT_DIR'],
  },
});
const PORT = cfg.port || 4006;
const SIGNING_SECRET = cfg.signingSecret;
const STATE_DIR = cfg.stateDir || '/plugin-state/netzplan';
const AUDIT_DIR = cfg.auditDir || '/workspace/plugin-audit/netzplan';

const store = new PlanStore({ stateDir: STATE_DIR });
const audit = auditWriter(AUDIT_DIR, { retentionMs: 30 * 24 * 3600 * 1000 });

// The MCP SDK is only needed for the agent-CLI tool surface; lazy-required so
// the pure modules (plan-doc / plan-store / viewer-headers) unit-test with no
// deps, exactly like test-mgmt-broker.
let McpServer, StreamableHTTPServerTransport, ListToolsRequestSchema, CallToolRequestSchema;
try {
  ({ Server: McpServer } = require('@modelcontextprotocol/sdk/server/index.js'));
  ({ StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js'));
  ({ ListToolsRequestSchema, CallToolRequestSchema } = require('@modelcontextprotocol/sdk/types.js'));
} catch { /* absent in unit-test host; the live sidecar image bundles it */ }

// The scope registry the orchestrator pushes (§4.8): for each scopeId, the
// calling agent's id so an audit line can name the agent even though the board
// is team-scoped (§6). Fail-open on agentId (defaults to scopeId) — it only
// enriches the audit line, it is never an authorization input here.
const scopeRegistry = new Map();

function agentFor(scopeId) {
  const ctx = scopeRegistry.get(scopeId);
  return (ctx && ctx.agentId) || scopeId;
}

function writeAudit(scopeId, subcommand, outcome) {
  try {
    audit.write({ pluginId: PLUGIN_ID, scopeId, agentId: agentFor(scopeId), subcommand, outcome });
  } catch { /* audit is best-effort, never gates a call */ }
}

// ── the agent tool surface (vendor-neutral domain verbs) ─────────────────────
const TOOLS = [
  { name: 'plan_show', description: 'Read the team\'s planning board (always allowed).' },
  { name: 'plan_tick', description: 'Mark a milestone done / not-done (autonomy >= 1).' },
  { name: 'plan_mutate', description: 'Apply one structural mutation op (autonomy >= 2).' },
];

function textResult(obj, isError) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  const r = { content: [{ type: 'text', text }] };
  if (isError) r.isError = true;
  return r;
}

// Run one tool call for a scope. Autonomy is enforced against the board's own
// current level (PlanStore), which is the point of the ladder: the same refusal
// applies whether the call came through the CLI or straight at /mcp.
async function runTool(scopeId, name, args) {
  args = args || {};
  if (name === 'plan_show') {
    writeAudit(scopeId, 'show', 'ok');
    return textResult(store.load(scopeId));
  }

  let op;
  if (name === 'plan_tick') {
    op = { type: 'tick-milestone', id: args.milestoneId, laneId: args.laneId, done: args.done };
    // find the panel if not supplied (one swimlane today)
    op.panelId = args.panelId;
  } else if (name === 'plan_mutate') {
    op = args.op;
    if (!op || typeof op !== 'object') return textResult({ error: 'op required' }, true);
    // The autonomy level itself is a Team-Admin /admin setting, never something
    // an agent may raise for itself — refuse it on the agent path regardless of
    // the current level (a level-2 agent has structural edit rights, not the
    // right to grant itself more).
    if (op.type === 'set-autonomy') {
      writeAudit(scopeId, 'set-autonomy', 'denied');
      return textResult({ error: 'set-autonomy is a Team-Admin action, not available to agents', code: 'admin-only' }, true);
    }
  } else {
    return textResult({ error: `unknown tool: ${name}` }, true);
  }

  // Resolve a default panel for a tick that omitted panelId.
  if (name === 'plan_tick' && !op.panelId) {
    const doc = store.load(scopeId);
    op.panelId = doc.panels[0] && doc.panels[0].id;
  }

  const subcommand = name === 'plan_tick' ? 'tick' : (op.type || 'mutate');
  let res;
  try {
    res = store.mutate(scopeId, op, { enforceAutonomy: true });
  } catch (err) {
    writeAudit(scopeId, subcommand, 'error');
    return textResult({ error: (err && err.message) || String(err) }, true);
  }
  if (!res.ok) {
    writeAudit(scopeId, subcommand, 'denied');
    return textResult({ error: res.reason, code: res.code }, true);
  }
  writeAudit(scopeId, subcommand, 'ok');
  return textResult(res.doc);
}

function scopeFromAuth(req) {
  const v = verifyScopeToken(req, SIGNING_SECRET);
  return v && v.pluginId === PLUGIN_ID ? v.scopeId : null;
}

// ── the served board UI (minimal; see README for the deferred editor) ─────────

function readBody(req) {
  return new Promise((resolve) => {
    let s = '';
    req.on('data', (c) => { s += c; });
    req.on('end', () => resolve(s));
    req.on('error', () => resolve(s));
  });
}

// The viewer's team is the single scope this board belongs to. The proxy sends
// the in-scope team ids; for a per-team board there is exactly one relevant id
// (the plugin is granted per team). We use the first as the scopeId.
function scopeForViewer(viewer) {
  return (viewer.teamIds && viewer.teamIds[0]) || null;
}

async function handleUi(req, res, uiPath) {
  const viewer = verifyViewerHeaders(req, SIGNING_SECRET);
  if (!viewer) return sendJson(res, 401, { error: 'unsigned viewer' });
  const need = requiredRoleForPath(uiPath);
  if (!roleAllows(viewer.role, need)) {
    return sendJson(res, 403, { error: `route ${uiPath} requires ${need}; viewer is ${viewer.role}` });
  }
  const scopeId = scopeForViewer(viewer);
  if (!scopeId) return sendJson(res, 400, { error: 'no team in scope for this viewer' });

  // data API
  if (uiPath === '/api/board' && req.method === 'GET') {
    return sendJson(res, 200, store.load(scopeId));
  }
  // Content migration (#1566). Export downloads the board as a portable PlanDoc
  // (any team member); import replaces the board from an uploaded one (Team-Admin
  // only — see requiredRoleForPath). Together they make migration a repeatable
  // operation rather than a script anyone keeps, and `export → import → export` is
  // byte-identical (PlanStore.import preserves timestamps; normalize is idempotent).
  if (uiPath === '/api/export' && req.method === 'GET') {
    const doc = exportPlanDoc(store.load(scopeId));
    const fname = `network-plan-${String(scopeId).replace(/[^A-Za-z0-9._-]/g, '_')}.json`;
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${fname}"`,
    });
    return res.end(JSON.stringify(doc, null, 2));
  }
  if (uiPath === '/api/import' && req.method === 'POST') {
    // Team-Admin only (requiredRoleForPath('/api/import') === 'team-admin' above).
    const body = parseJson(await readBody(req));
    const incoming = body && (body.doc || body.document || body);
    if (!incoming || typeof incoming !== 'object') return sendJson(res, 400, { error: 'a PlanDoc is required' });
    let doc;
    try {
      doc = store.import(scopeId, incoming);
    } catch (err) {
      return sendJson(res, 400, { error: (err && err.message) || 'could not import document' });
    }
    return sendJson(res, 200, doc);
  }
  if (uiPath === '/api/tick' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    const doc = store.load(scopeId);
    const op = { type: 'tick-milestone', id: body.milestoneId, laneId: body.laneId, done: body.done, panelId: body.panelId || (doc.panels[0] && doc.panels[0].id) };
    // human console writes are role-gated by the proxy, not autonomy-gated
    const r = store.mutate(scopeId, op, { enforceAutonomy: false });
    return sendJson(res, r.ok ? 200 : 400, r.ok ? r.doc : { error: r.reason });
  }
  if (uiPath === '/api/settings' && req.method === 'POST') {
    // /admin only (requiredRoleForPath('/api/settings') === team-admin above)
    const body = parseJson(await readBody(req));
    const r = store.mutate(scopeId, { type: 'set-autonomy', level: Number(body.agentAutonomy) }, { enforceAutonomy: false });
    return sendJson(res, r.ok ? 200 : 400, r.ok ? r.doc : { error: r.reason });
  }
  // The board editor's write path (#1564): apply one plan-doc mutation op. A human
  // console write is role-gated by the proxy + the viewer-header role check above,
  // NOT autonomy-gated (autonomy governs the AGENT path, not the person editing
  // their own board). `set-autonomy` stays the Team-Admin-only /api/settings route,
  // so a Team Member editing the board can never raise the ladder here.
  if (uiPath === '/api/mutate' && req.method === 'POST') {
    const body = parseJson(await readBody(req));
    const op = body && body.op;
    if (!op || typeof op !== 'object') return sendJson(res, 400, { error: 'op required' });
    if (op.type === 'set-autonomy') {
      return sendJson(res, 403, { error: 'autonomy is set on the /admin page, not the board' });
    }
    const r = store.mutate(scopeId, op, { enforceAutonomy: false });
    return sendJson(res, r.ok ? 200 : 400, r.ok ? r.doc : { error: r.reason });
  }

  // static assets: /  → index.html, /admin → admin.html, else a file under ui/
  const file = uiPath === '/' || uiPath === '' ? 'index.html'
    : uiPath === '/admin' ? 'admin.html'
    : uiPath.replace(/^\/+/, '');
  const abs = path.join(__dirname, 'ui', file);
  // containment: never serve outside ui/
  if (!abs.startsWith(path.join(__dirname, 'ui') + path.sep)) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(abs, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': contentType(abs) });
    res.end(data);
  });
}

function contentType(p) {
  if (p.endsWith('.html')) return 'text/html; charset=utf-8';
  if (p.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (p.endsWith('.css')) return 'text/css; charset=utf-8';
  return 'application/octet-stream';
}
function parseJson(s) { try { return JSON.parse(s || '{}'); } catch { return {}; } }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

const handleHealth = healthEndpoint(async () => ({ stateDir: !!STATE_DIR }));
const handleTeardown = teardownScopeEndpoint((scopeId) => ({ reaped: store.teardown(scopeId) }), { secret: SIGNING_SECRET });

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

  // Scope registry push (§4.8), bearer-authed with the signing secret.
  if (req.method === 'PUT' && urlPath === '/internal/scope-registry') {
    const v = verifyScopeToken(req, SIGNING_SECRET);
    if (!v) return void sendJson(res, 401, { error: 'unauthorized' });
    const parsed = parseJson(await readBody(req));
    scopeRegistry.clear();
    for (const [scopeId, ctx] of Object.entries(parsed.scopes || {})) scopeRegistry.set(scopeId, ctx);
    return void sendJson(res, 200, { ok: true, scopes: scopeRegistry.size });
  }

  // The board UI + its data API (viewer-header authed).
  if (urlPath === '/ui' || urlPath.startsWith('/ui/')) {
    const uiPath = urlPath === '/ui' ? '/' : urlPath.slice('/ui'.length) || '/';
    return void (await handleUi(req, res, uiPath));
  }

  if (urlPath !== '/mcp') return void sendJson(res, 404, { error: 'not found' });
  if (!McpServer) return void sendJson(res, 501, { error: 'mcp sdk not installed' });

  const scopeId = scopeFromAuth(req);
  if (!scopeId) return void sendJson(res, 401, { error: 'unauthorized' });

  const quotaErr = quotaExceeded(cfg.quota, store.count(scopeId), { adding: 0 });
  if (quotaErr) return void sendJson(res, 429, { error: quotaErr });

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
  httpServer.listen(PORT, () => process.stdout.write(`[netzplan-broker] listening on :${PORT}\n`));
}

module.exports = { runTool, scopeFromAuth, scopeRegistry, store, TOOLS };
